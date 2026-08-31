import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker, { pbkdf2Hash } from '../src/index';

const ITERATIONS = 100000;
const BASE = 'http://example.com';

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** 生成相对当前时间（UTC）的 ISO 字符串，避免超出“默认最近30天”的查询窗口 */
function isoOffset(days, hour = 8, minute = 30) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

/** 用与生产一致的算法生成密码哈希，直接写入 users 表（模拟管理员预置用户） */
async function seedUser(username, password, displayName) {
  const salt = randomHex(16);
  const hash = await pbkdf2Hash(password, salt, ITERATIONS);
  const stored = `pbkdf2$${ITERATIONS}$${salt}$${hash}`;
  await env.DB.prepare('INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)')
    .bind(username, stored, displayName || null)
    .run();
}

async function fetchWorker(request, testEnv = env) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function getCookie(response, name) {
  const setCookie = response.headers.get('set-cookie') || '';
  const match = new RegExp(`${name}=([^;]+)`).exec(setCookie);
  return match ? match[1] : null;
}

async function login(username, password) {
  const response = await fetchWorker(
    new Request(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
  );
  const token = getCookie(response, 'session');
  return { response, token };
}

function authedRequest(path, { method = 'GET', body, token } = {}) {
  return new Request(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Cookie: `session=${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe('Blood Pressure Worker', () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL
      )`
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS bloodpressure (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        systolic INTEGER NOT NULL,
        diastolic INTEGER NOT NULL,
        heart_rate INTEGER,
        note TEXT,
        measured_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ).run();

    await seedUser('alice', 'secret123', '爱丽丝');
    await seedUser('bob', 'bobpass', '鲍勃');
  });

  describe('认证', () => {
    it('未登录访问 /api/records 返回 401', async () => {
      const response = await fetchWorker(new Request(`${BASE}/api/records`));
      expect(response.status).toBe(401);
    });

    it('密码错误登录返回 401', async () => {
      const { response } = await login('alice', 'wrong-password');
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('用户名或密码错误');
    });

    it('登录成功返回 200 并设置会话 Cookie', async () => {
      const { response, token } = await login('alice', 'secret123');
      expect(response.status).toBe(200);
      expect(token).toBeTruthy();
      const body = await response.json();
      expect(body.data.username).toBe('alice');
      expect(body.data.display_name).toBe('爱丽丝');
    });

    it('用户名大小写不敏感', async () => {
      const { response } = await login('ALICE', 'secret123');
      expect(response.status).toBe(200);
    });
  });

  describe('记录 CRUD', () => {
    let aliceToken;
    let bobToken;

    beforeAll(async () => {
      aliceToken = (await login('alice', 'secret123')).token;
      bobToken = (await login('bob', 'bobpass')).token;
    });

    it('登录后可添加记录', async () => {
      const response = await fetchWorker(
        authedRequest('/api/records', {
          method: 'POST',
          token: aliceToken,
          body: {
            systolic: 125,
            diastolic: 82,
            heart_rate: 72,
            measured_at: isoOffset(2),
            note: '晨起',
          },
        })
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.id).toBeTruthy();
    });

    it('参数校验：收缩压越界返回 400', async () => {
      const response = await fetchWorker(
        authedRequest('/api/records', {
          method: 'POST',
          token: aliceToken,
          body: { systolic: 999, diastolic: 80 },
        })
      );
      expect(response.status).toBe(400);
    });

    it('参数校验：缺少必填字段返回 400', async () => {
      const response = await fetchWorker(
        authedRequest('/api/records', {
          method: 'POST',
          token: aliceToken,
          body: { systolic: 120 },
        })
      );
      expect(response.status).toBe(400);
    });

    it('按时间范围查询自己的记录', async () => {
      const start = isoOffset(3, 0, 0);
      const end = isoOffset(1, 0, 0);
      const response = await fetchWorker(
        authedRequest(`/api/records?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`, {
          token: aliceToken,
        })
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.length).toBe(1);
      expect(body.data[0].systolic).toBe(125);
      expect(body.data[0].heart_rate).toBe(72);
    });

    it('多用户隔离：bob 看不到 alice 的记录', async () => {
      const start = isoOffset(3, 0, 0);
      const end = isoOffset(1, 0, 0);
      const response = await fetchWorker(
        authedRequest(`/api/records?start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`, {
          token: bobToken,
        })
      );
      const body = await response.json();
      expect(body.data.length).toBe(0);
    });

    it('编辑自己的记录', async () => {
      const list = await (
        await fetchWorker(authedRequest('/api/records', { token: aliceToken }))
      ).json();
      const id = list.data[0].id;

      const response = await fetchWorker(
        authedRequest(`/api/records/${id}`, {
          method: 'PUT',
          token: aliceToken,
          body: { systolic: 130, diastolic: 85, heart_rate: 70, measured_at: isoOffset(2) },
        })
      );
      expect(response.status).toBe(200);

      const after = await (await fetchWorker(authedRequest('/api/records', { token: aliceToken }))).json();
      expect(after.data[0].systolic).toBe(130);
    });

    it('不能编辑他人的记录（返回 404）', async () => {
      const list = await (
        await fetchWorker(authedRequest('/api/records', { token: aliceToken }))
      ).json();
      const id = list.data[0].id;

      const response = await fetchWorker(
        authedRequest(`/api/records/${id}`, {
          method: 'PUT',
          token: bobToken,
          body: { systolic: 100, diastolic: 70, heart_rate: 60, measured_at: isoOffset(2) },
        })
      );
      expect(response.status).toBe(404);
    });

    it('删除自己的记录', async () => {
      const list = await (
        await fetchWorker(authedRequest('/api/records', { token: aliceToken }))
      ).json();
      const id = list.data[0].id;

      const response = await fetchWorker(
        authedRequest(`/api/records/${id}`, { method: 'DELETE', token: aliceToken })
      );
      expect(response.status).toBe(200);

      const after = await (
        await fetchWorker(authedRequest('/api/records', { token: aliceToken }))
      ).json();
      expect(after.data.length).toBe(0);
    });
  });

  describe('登出', () => {
    it('登出后会话失效', async () => {
      const { token } = await login('bob', 'bobpass');
      const response = await fetchWorker(
        authedRequest('/api/logout', { method: 'POST', token })
      );
      expect(response.status).toBe(200);

      const check = await fetchWorker(authedRequest('/api/records', { token }));
      expect(check.status).toBe(401);
    });
  });

  describe('子路径部署形态（route: example.com/bloodpressure*）', () => {
    it('/bloodpressure 返回首页 HTML', async () => {
      const response = await fetchWorker(new Request(`${BASE}/bloodpressure`));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') || '').toContain('text/html');
      expect(await response.text()).toContain('血压记录');
    });

    it('/bloodpressure/api/login 可正常登录', async () => {
      const response = await fetchWorker(
        new Request(`${BASE}/bloodpressure/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'alice', password: 'secret123' }),
        })
      );
      expect(response.status).toBe(200);
      expect(getCookie(response, 'session')).toBeTruthy();
    });

    it('/bloodpressure/api/records 未登录返回 401', async () => {
      const response = await fetchWorker(new Request(`${BASE}/bloodpressure/api/records`));
      expect(response.status).toBe(401);
    });

    it('/bloodpressure/api/records 登录后可增删改查', async () => {
      const { token } = await login('alice', 'secret123');
      const response = await fetchWorker(
        authedRequest('/bloodpressure/api/records', {
          method: 'POST',
          token,
          body: { systolic: 118, diastolic: 76, heart_rate: 65, measured_at: isoOffset(1) },
        })
      );
      expect(response.status).toBe(200);
    });
  });
});

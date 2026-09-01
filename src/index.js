/**
 * 血压 / 心率记录 Worker
 *
 * 设计参考 ../birdroom/，区别:
 *   - 需要登录（会话 Cookie，HttpOnly）
 *   - 用户由管理员手动写入数据库（无注册页、无用户管理），见 scripts/hash-password.mjs
 *   - 多用户：每个用户只能看到/修改自己的记录
 *
 * 依赖表结构见 bloodpressure.sql
 */
const PBKDF2_ITERATIONS = 100000; // 必须与 scripts/hash-password.mjs 一致
const SESSION_TTL_SECONDS = 30 * 24 * 3600; // 30 天

const encoder = new TextEncoder();

// 子路径部署前缀（route: example.com/bloodpressure*）。
// 同时兼容 custom domain（bloodpressure.example.com）的根路径形态。
const BASE_PATH = '/bloodpressure';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 子路径形态：example.com/bloodpressure/api/... 剥掉前缀后与根路径等价
    let pathname = url.pathname;
    if (pathname === BASE_PATH) {
      pathname = '/';
    } else if (pathname.startsWith(BASE_PATH + '/')) {
      pathname = pathname.slice(BASE_PATH.length);
    }
    url.pathname = pathname;

    // 子路径形态下首页不匹配任何静态资源，由 Worker 从 assets 取根路径 index.html
    if (pathname === '/') {
      return env.ASSETS.fetch(new URL('/', request.url));
    }

    // 所有 API 都在 /api/* 下；其余路径 404
    if (pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }

    return new Response('Not Found', { status: 404 });
  },
};

/* ------------------------------------------------------------------ */
/* 路由                                                               */
/* ------------------------------------------------------------------ */

async function handleApi(request, env, url) {
  // 登录 / 登出不需要会话
  if (url.pathname === '/api/login' && request.method === 'POST') {
    return login(request, env);
  }
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    return logout(request, env);
  }

  // 其余 API 都需要有效会话
  const user = await getSessionUser(request, env);
  if (!user) {
    return json({ success: false, error: '未登录或会话已过期' }, 401);
  }

  switch (true) {
    case url.pathname === '/api/me' && request.method === 'GET':
      return json({ success: true, data: user });

    case url.pathname === '/api/records' && request.method === 'GET':
      return listRecords(request, env, url, user);

    case url.pathname === '/api/records' && request.method === 'POST':
      return addRecord(request, env, user);

    case /^\/api\/records\/\d+$/.test(url.pathname) && request.method === 'PUT':
      return updateRecord(request, env, url, user);

    case /^\/api\/records\/\d+$/.test(url.pathname) && request.method === 'DELETE':
      return deleteRecord(request, env, url, user);

    case url.pathname === '/api/change-password' && request.method === 'POST':
      return changePassword(request, env, user);

    default:
      return json({ success: false, error: 'Not Found' }, 404);
  }
}

/* ------------------------------------------------------------------ */
/* 认证                                                               */
/* ------------------------------------------------------------------ */

async function login(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ success: false, error: '无效的 JSON' }, 400);

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) {
    return json({ success: false, error: '请输入用户名和密码' }, 400);
  }

  const user = await env.DB.prepare(
    'SELECT id, username, display_name, password_hash FROM users WHERE LOWER(username) = LOWER(?)'
  )
    .bind(username)
    .first();

  // 用户不存在或密码错误，统一返回同样的提示
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return json({ success: false, error: '用户名或密码错误' }, 401);
  }

  // 顺手清理过期会话
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();

  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, user.id, toDbTime(expiresAt))
    .run();

  return json(
    { success: true, data: { username: user.username, display_name: user.display_name } },
    200,
    {
      'Set-Cookie': makeSessionCookie(token, SESSION_TTL_SECONDS, request.url.startsWith('https:')),
    }
  );
}

async function logout(request, env) {
  const cookie = parseCookies(request.headers.get('Cookie') || '');
  if (cookie.session) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(cookie.session).run();
  }
  return json({ success: true }, 200, {
    'Set-Cookie': makeSessionCookie('', 0, request.url.startsWith('https:')),
  });
}

/** 根据请求 Cookie 中的会话 token 查找当前用户；无效则返回 null */
async function getSessionUser(request, env) {
  const cookie = parseCookies(request.headers.get('Cookie') || '');
  const token = cookie.session;
  if (!token) return null;

  return await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  )
    .bind(token)
    .first();
}

/* ------------------------------------------------------------------ */
/* 修改密码                                                           */
/* ------------------------------------------------------------------ */

/** 修改自己的密码：需验证当前密码；成功后吊销该用户除当前会话外的所有会话 */
async function changePassword(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ success: false, error: '无效的 JSON' }, 400);

  const oldPassword = typeof body.old_password === 'string' ? body.old_password : '';
  const newPassword = typeof body.new_password === 'string' ? body.new_password : '';

  if (!oldPassword) {
    return json({ success: false, error: '请输入当前密码' }, 400);
  }
  if (!newPassword) {
    return json({ success: false, error: '请输入新密码' }, 400);
  }
  if (newPassword.length < 8) {
    return json({ success: false, error: '新密码至少 8 个字符' }, 400);
  }
  if (newPassword === oldPassword) {
    return json({ success: false, error: '新密码不能与当前密码相同' }, 400);
  }

  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.id)
    .first();
  if (!row || !(await verifyPassword(oldPassword, row.password_hash))) {
    return json({ success: false, error: '当前密码错误' }, 401);
  }

  const newHash = await hashPassword(newPassword);
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(newHash, user.id)
    .run();

  // 吊销该用户除当前会话外的所有会话
  const cookie = parseCookies(request.headers.get('Cookie') || '');
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?')
    .bind(user.id, cookie.session || '')
    .run();

  return json({ success: true });
}

/* ------------------------------------------------------------------ */
/* 记录 CRUD                                                          */
/* ------------------------------------------------------------------ */

async function addRecord(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ success: false, error: '无效的 JSON' }, 400);

  const v = validateRecord(body);
  if (!v.ok) return json({ success: false, error: v.error }, 400);

  const res = await env.DB.prepare(
    `INSERT INTO bloodpressure (user_id, systolic, diastolic, heart_rate, note, measured_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(user.id, v.systolic, v.diastolic, v.heart_rate, v.note, toDbTime(v.measured_at))
    .run();

  return json({ success: true, data: { id: res.meta.last_row_id } });
}

async function updateRecord(request, env, url, user) {
  const id = parseInt(url.pathname.split('/').pop(), 10);
  const body = await request.json().catch(() => null);
  if (!body) return json({ success: false, error: '无效的 JSON' }, 400);

  const v = validateRecord(body);
  if (!v.ok) return json({ success: false, error: v.error }, 400);

  const res = await env.DB.prepare(
    `UPDATE bloodpressure
     SET systolic = ?, diastolic = ?, heart_rate = ?, note = ?, measured_at = ?
     WHERE id = ? AND user_id = ?`
  )
    .bind(v.systolic, v.diastolic, v.heart_rate, v.note, toDbTime(v.measured_at), id, user.id)
    .run();

  if (res.meta.changes === 0) {
    return json({ success: false, error: '记录不存在' }, 404);
  }
  return json({ success: true });
}

async function deleteRecord(request, env, url, user) {
  const id = parseInt(url.pathname.split('/').pop(), 10);
  const res = await env.DB.prepare('DELETE FROM bloodpressure WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .run();

  if (res.meta.changes === 0) {
    return json({ success: false, error: '记录不存在' }, 404);
  }
  return json({ success: true });
}

async function listRecords(request, env, url, user) {
  const startTime = url.searchParams.get('start_time');
  const endTime = url.searchParams.get('end_time');

  let where = 'user_id = ?';
  const params = [user.id];

  if (startTime && endTime) {
    const s = new Date(startTime);
    const e = new Date(endTime);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
      return json({ success: false, error: '时间格式无效' }, 400);
    }
    where += ' AND measured_at >= ? AND measured_at < ?';
    params.push(toDbTime(s), toDbTime(e));
  } else {
    // 未指定范围时默认最近 30 天
    where += " AND measured_at >= datetime('now', '-30 day')";
  }

  const { results } = await env.DB.prepare(
    `SELECT id, systolic, diastolic, heart_rate, note, measured_at
     FROM bloodpressure
     WHERE ${where}
     ORDER BY measured_at DESC`
  )
    .bind(...params)
    .all();

  return json({ success: true, data: results });
}

/* ------------------------------------------------------------------ */
/* 校验与工具函数                                                     */
/* ------------------------------------------------------------------ */

function validateRecord(body) {
  const systolic = Number.parseInt(body.systolic, 10);
  const diastolic = Number.parseInt(body.diastolic, 10);
  const hrRaw = body.heart_rate;
  const heartRate =
    hrRaw === undefined || hrRaw === null || hrRaw === '' ? null : Number.parseInt(hrRaw, 10);

  if (!Number.isInteger(systolic) || systolic < 40 || systolic > 300) {
    return { ok: false, error: '收缩压需为 40–300 的整数' };
  }
  if (!Number.isInteger(diastolic) || diastolic < 20 || diastolic > 200) {
    return { ok: false, error: '舒张压需为 20–200 的整数' };
  }
  if (heartRate !== null && (!Number.isInteger(heartRate) || heartRate < 20 || heartRate > 250)) {
    return { ok: false, error: '心率需为 20–250 的整数' };
  }

  let measuredAt = new Date();
  if (body.measured_at) {
    const d = new Date(body.measured_at);
    if (Number.isNaN(d.getTime())) {
      return { ok: false, error: '测量时间格式无效' };
    }
    measuredAt = d;
  }

  const note =
    body.note === undefined || body.note === null ? '' : String(body.note).trim().slice(0, 200);

  return { ok: true, systolic, diastolic, heart_rate: heartRate, measured_at: measuredAt, note };
}

/* ---------- 密码哈希 (PBKDF2-SHA256) ---------- */

/** 生成带随机盐的新密码哈希（格式与 scripts/ 下 CLI 一致） */
async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2Hash(password, bytesToHex(salt), PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToHex(salt)}$${hash}`;
}

export async function pbkdf2Hash(password, saltHex, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

async function verifyPassword(password, storedHash) {
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isInteger(iterations) || iterations < 1) return false;

  const candidate = await pbkdf2Hash(password, parts[2], iterations);
  return timingSafeEqual(candidate, parts[3]);
}

/* ---------- 通用工具 ---------- */

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

/** Date -> 'YYYY-MM-DD HH:MM:SS'（UTC，供 SQLite 比较/存储） */
function toDbTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function makeSessionCookie(token, maxAgeSeconds, secure) {
  const parts = [`session=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

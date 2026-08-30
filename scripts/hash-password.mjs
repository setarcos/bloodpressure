#!/usr/bin/env node
/**
 * 手动预置用户：为指定用户名/密码生成 PBKDF2 密码哈希，并输出可执行的 INSERT SQL。
 *
 * 用法:
 *   node scripts/hash-password.mjs <用户名> <密码> [显示名]
 *
 * 示例:
 *   node scripts/hash-password.mjs alice 's3cret' 爱丽丝
 *
 * 生成后把 SQL 写入数据库（本地 / 远程任选其一）:
 *   npx wrangler d1 execute bloodpressure --local --file=seed-users.sql
 *   npx wrangler d1 execute bloodpressure --remote --file=seed-users.sql
 *   # 或者直接追加执行:
 *   npx wrangler d1 execute bloodpressure --local --command "INSERT INTO users ..."
 */
import { randomBytes } from 'node:crypto';

// 必须与 src/index.js 中的 PBKDF2_ITERATIONS 一致
const PBKDF2_ITERATIONS = 100000;
const crypto = globalThis.crypto ?? (await import('node:crypto')).webcrypto;

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function quoteSql(value) {
  if (value === undefined || value === null) return 'NULL';
  return "'" + String(value).replace(/'/g, "''") + "'";
}

async function main() {
  const [username, password, displayName] = process.argv.slice(2);
  if (!username || !password) {
    console.error('用法: node scripts/hash-password.mjs <用户名> <密码> [显示名]');
    process.exit(1);
  }

  const salt = randomBytes(16);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const hash = bytesToHex(new Uint8Array(bits));
  const passwordHash = `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToHex(salt)}$${hash}`;

  const sql = `INSERT INTO users (username, password_hash, display_name) VALUES (${quoteSql(
    username
  )}, '${passwordHash}', ${quoteSql(displayName || null)});`;

  console.log(`-- 用户: ${username}${displayName ? ' (' + displayName + ')' : ''}`);
  console.log(sql);
  console.log();
  console.log('-- 本地库执行:  npx wrangler d1 execute bloodpressure --local  --file=seed-users.sql');
  console.log('-- 远程库执行:  npx wrangler d1 execute bloodpressure --remote --file=seed-users.sql');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

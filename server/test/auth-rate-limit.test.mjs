import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-auth-limit-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.JWT_SECRET = 'auth-rate-limit-test-secret';
process.env.LOGIN_ACCOUNT_MAX_FAILURES = '8';
process.env.LOGIN_IP_MAX_FAILURES = '3';
process.env.REGISTER_IP_MAX_ATTEMPTS = '2';

const { initSchema, migrateV2, q } = await import('../src/db.js');
const authRoutes = (await import('../src/routes/auth.js')).default;
initSchema();
migrateV2();

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  const server = app.listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('登录限流按 IP 聚合，轮换用户名也无法绕过', async () => {
  await withServer(async base => {
    for (const username of ['unknown-a', 'unknown-b', 'unknown-c']) {
      const response = await fetch(`${base}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'wrong-password' }),
      });
      assert.equal(response.status, 401);
    }
    const blocked = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'unknown-d', password: 'wrong-password' }),
    });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });
});

test('企业注册原子落库并按 IP 限制批量滥用', async () => {
  await withServer(async base => {
    const payload = { company: '限流测试企业', contactName: '测试人', phone: '13900000000', username: 'register_test', password: 'StrongPass123' };
    const first = await fetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(first.status, 200);
    const duplicate = await fetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(duplicate.status, 400);
    const blocked = await fetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, company: '第二家企业', username: 'register_test_2' }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(q.get(`SELECT COUNT(*) n FROM tenants WHERE name='限流测试企业'`).n, 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM users WHERE username='register_test'`).n, 1);
  });
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

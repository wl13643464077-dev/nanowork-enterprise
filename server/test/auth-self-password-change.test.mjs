// 企业账号自助改密：校验当前密码、递增认证版本、吊销全部会话，新旧密码登录结果正确。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-self-password-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) { try { fs.rmSync(file, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;
process.env.JWT_SECRET = 'self-password-change-test-secret';
process.env.PASSWORD_CHANGE_MAX_FAILURES = '3';

const { initSchema, migrateV2, q } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
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

const postJson = (url, body, token) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const login = (base, username, password) => postJson(`${base}/auth/login`, { username, password });

q.run(`INSERT INTO users(username,password_hash,name,role,dept,status,tenant_id) VALUES(?,?,?,?,?,?,?)`,
  'self_pwd_boss', hashPassword('OldPassword123'), '自助改密老板', 'boss', '管理层', '启用', 1);

test('企业老板自助改密：旧密码校验、所有会话吊销、旧密码不可再登录、新密码可登录', async () => {
  await withServer(async base => {
    const first = await login(base, 'self_pwd_boss', 'OldPassword123');
    assert.equal(first.status, 200);
    const { token } = await first.json();
    const second = await login(base, 'self_pwd_boss', 'OldPassword123');
    const { token: otherDevice } = await second.json();

    const badLength = await postJson(`${base}/auth/password`, { currentPassword: 'OldPassword123', password: 'short' }, token);
    assert.equal(badLength.status, 400);
    const same = await postJson(`${base}/auth/password`, { currentPassword: 'OldPassword123', password: 'OldPassword123' }, token);
    assert.equal(same.status, 400);
    const wrong = await postJson(`${base}/auth/password`, { currentPassword: 'NotTheRealOne', password: 'NewPassword456' }, token);
    assert.equal(wrong.status, 403);
    assert.equal(q.get("SELECT auth_version FROM users WHERE username='self_pwd_boss'").auth_version || 0, 0, '失败不得改动认证版本');

    const changed = await postJson(`${base}/auth/password`, { currentPassword: 'OldPassword123', password: 'NewPassword456' }, token);
    assert.equal(changed.status, 200);
    const body = await changed.json();
    assert.equal(body.ok, true);
    assert.equal(body.revokedSessions, 2, '本人全部活跃会话都应被吊销');
    assert.match(changed.headers.get('set-cookie') || '', /Max-Age=0/);

    for (const stale of [token, otherDevice]) {
      const me = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${stale}` } });
      assert.equal(me.status, 401, '改密前签发的令牌必须立即失效');
    }
    assert.equal((await login(base, 'self_pwd_boss', 'OldPassword123')).status, 401);
    const fresh = await login(base, 'self_pwd_boss', 'NewPassword456');
    assert.equal(fresh.status, 200);
    const { token: freshToken } = await fresh.json();
    const me = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${freshToken}` } });
    assert.equal(me.status, 200);
    const log = q.get("SELECT * FROM op_logs WHERE action='修改密码' ORDER BY id DESC LIMIT 1");
    assert.ok(log, '自助改密应留下操作日志');
    assert.doesNotMatch(JSON.stringify(log), /OldPassword123|NewPassword456/, '日志不得记录明文密码');
  });
});

test('未登录不能改密；连续输错当前密码会被限流', async () => {
  await withServer(async base => {
    const anonymous = await postJson(`${base}/auth/password`, { currentPassword: 'x', password: 'NewPassword456' });
    assert.equal(anonymous.status, 401);
    const { token } = await (await login(base, 'self_pwd_boss', 'NewPassword456')).json();
    for (let i = 0; i < 3; i++) {
      const attempt = await postJson(`${base}/auth/password`, { currentPassword: `wrong-${i}`, password: 'AnotherPassword789' }, token);
      assert.equal(attempt.status, 403);
    }
    const blocked = await postJson(`${base}/auth/password`, { currentPassword: 'NewPassword456', password: 'AnotherPassword789' }, token);
    assert.equal(blocked.status, 429, '超过失败次数后即使密码正确也先限流');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await login(base, 'self_pwd_boss', 'NewPassword456')).status, 200, '限流不影响原密码继续登录');
  });
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) { try { fs.rmSync(file, { force: true }); } catch {} }
});

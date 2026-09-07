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
process.env.INVITATION_REGISTER_IP_MAX_ATTEMPTS = '9';
process.env.INVITATION_PREVIEW_IP_MAX_ATTEMPTS = '2';

const { initSchema, migrateV2, q } = await import('../src/db.js');
const authRoutes = (await import('../src/routes/auth.js')).default;
initSchema();
migrateV2();
const { createInvitation } = await import('../src/engines/invitations.js');

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

test('同IP六名受邀员工可独立于普通申请限额注册，所有带码请求共享邀请码限额', async () => {
  const issuerId = Number(q.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES('invite_rate_super','unused','超管','platform_super','启用',1)").lastInsertRowid);
  const tenantId = Number(q.run("INSERT INTO tenants(name,status,seat_limit,credits) VALUES('办公室受邀企业','已开通',10,0)").lastInsertRowid);
  const invitations = Array.from({ length: 7 }, () => createInvitation({ id: issuerId },
    { type: 'existing_tenant', tenantId, role: 'sales' }, 'platform'));
  await withServer(async base => {
    const submit = body => fetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    // Invalid, empty, and malformed-account requests each consume one attempt.
    for (const inviteCode of ['unknown-code', '']) {
      const invalid = await submit({ inviteCode, username: 'invalid_invite_rate', password: 'StrongPass123' });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).code, 'INVITATION_INVALID');
    }
    assert.equal((await submit({ inviteCode: invitations[0].code, password: 'StrongPass123' })).status, 400);
    assert.equal(q.get('SELECT used_count FROM invitations WHERE id=?', invitations[0].invitation.id).used_count, 0);
    for (let index = 0; index < 6; index++) {
      const accepted = await submit({ inviteCode: invitations[index].code, contactName: `同事${index + 1}`,
        username: `invite_rate_member_${index}`, password: 'StrongPass123' });
      const body = await accepted.json();
      assert.equal(accepted.status, 200, JSON.stringify(body));
      assert.equal(body.canLogin, true); assert.equal(body.tenantId, tenantId);
    }
    assert.equal(q.get('SELECT COUNT(*) n FROM users WHERE tenant_id=?', tenantId).n, 6);
    assert.equal(q.get("SELECT COUNT(*) n FROM users WHERE username='invalid_invite_rate'").n, 0);
    const blockedInvite = await submit({ inviteCode: invitations[6].code, username: 'invite_rate_member_6', password: 'StrongPass123' });
    assert.equal(blockedInvite.status, 429);
    assert.ok(Number(blockedInvite.headers.get('retry-after')) > 0);
    assert.equal(q.get('SELECT used_count FROM invitations WHERE id=?', invitations[6].invitation.id).used_count, 0);
    const blockedApplication = await submit({ company: '申请额度保持原样', username: 'ordinary_after_invites', password: 'StrongPass123' });
    assert.equal(blockedApplication.status, 429);
    assert.ok(Number(blockedApplication.headers.get('retry-after')) > 0);
  });
});

test('公共邀请码预览按IP限流，轮换无效邀请码也不能绕过', async () => {
  await withServer(async base => {
    for (const code of ['invalid-first', 'invalid-second']) {
      const response = await fetch(`${base}/auth/invitations/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
      });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json()).code, 'INVITATION_INVALID');
    }
    const blocked = await fetch(`${base}/auth/invitations/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'invalid-third' }),
    });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

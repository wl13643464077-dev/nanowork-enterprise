import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const databasePath = path.join(os.tmpdir(), `invitations-atomicity-${process.pid}.db`);
process.env.NANOWORK_DB = databasePath;
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.ENABLE_SCHEDULER = 'false';
process.env.NODE_ENV = 'test';
const { db, q, initSchema, migrateV2 } = await import('../src/db.js');
initSchema(); migrateV2();
const { createInvitation, listInvitations, revokeInvitation, previewInvitation, registerWithInvitation } = await import('../src/engines/invitations.js');
q.run("UPDATE tenants SET status='已开通',credits=0 WHERE id=1");
const superId = Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES('invite_atomic_super','unused','超管','platform_super',1,'启用')").lastInsertRowid);
const superUser = { id: superId };
const registration = (code, username, extra = {}) => registerWithInvitation({ inviteCode: code, company: '原子开通企业', contactName: '测试人', phone: null, username, password: 'Test-Password-123', ...extra });

test('迁移幂等且不生成邀请码；原码只创建时回显，数据库与列表只有哈希及掩码', () => {
  assert.equal(q.get('SELECT COUNT(*) n FROM invitations').n, 0);
  migrateV2();
  assert.equal(q.get('SELECT COUNT(*) n FROM invitations').n, 0);
  const created = createInvitation(superUser, { type: 'new_tenant' }, 'platform');
  assert.match(created.code, /^NW-[A-Za-z0-9_-]{32}$/u);
  const row = q.get('SELECT * FROM invitations WHERE id=?', created.invitation.id);
  assert.equal(row.code_hash, createHash('sha256').update(created.code).digest('hex'));
  assert.equal(row.used_count, 0); assert.equal(row.max_uses, 1);
  assert.ok(!JSON.stringify(row).includes(created.code));
  const list = JSON.stringify(listInvitations(superUser, 'platform'));
  assert.ok(!list.includes(created.code)); assert.ok(!list.includes(row.code_hash));
  assert.equal(previewInvitation(created.code).type, 'new_tenant');
});

test('邀请消费与开通、账号、审计原子提交；审计写失败全部回滚且同码能重试', () => {
  const invitation = createInvitation(superUser, { type: 'new_tenant' }, 'platform');
  const before = q.get('SELECT COUNT(*) n FROM tenants').n;
  db.exec(`CREATE TRIGGER invitation_audit_failure BEFORE INSERT ON invitation_events
    WHEN NEW.event='redeemed' BEGIN SELECT RAISE(ABORT,'injected invite audit failure'); END;`);
  assert.throws(() => registration(invitation.code, 'invite_atomic_retry'), /injected invite audit failure/u);
  assert.equal(q.get('SELECT COUNT(*) n FROM tenants').n, before);
  assert.equal(q.get("SELECT COUNT(*) n FROM users WHERE username='invite_atomic_retry'").n, 0);
  assert.equal(q.get('SELECT used_count FROM invitations WHERE id=?', invitation.invitation.id).used_count, 0);
  db.exec('DROP TRIGGER invitation_audit_failure');
  const completed = registration(invitation.code, 'invite_atomic_retry');
  assert.equal(completed.canLogin, true);
  const tenant = q.get('SELECT * FROM tenants WHERE id=?', completed.tenantId);
  assert.equal(tenant.status, '已开通'); assert.equal(tenant.plan, '标准版'); assert.equal(tenant.seat_limit, 5);
  assert.equal(tenant.credits, 0); assert.equal(tenant.total_recharged, 0);
  assert.equal(tenant.plan_code, null); assert.equal(tenant.plan_started_at, null); assert.equal(tenant.plan_expires_at, null);
  assert.equal(q.get('SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=?', tenant.id).n, 0);
  assert.equal(q.get('SELECT COUNT(*) n FROM invitation_events WHERE invitation_id=? AND event=?', invitation.invitation.id, 'redeemed').n, 1);
  assert.throws(() => registration(invitation.code, 'invite_atomic_second'), /邀请码无效/u);
  assert.equal(q.get('SELECT used_count FROM invitations WHERE id=?', invitation.invitation.id).used_count, 1);
});

test('重复账号与席位不足不消耗成员邀请；放出席位后可以使用同码', () => {
  const tenantId = Number(q.run("INSERT INTO tenants(name,status,seat_limit,credits) VALUES('两席存量企业','已开通',2,17)").lastInsertRowid);
  const ownerId = Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES('invite_seat_owner','unused','老板','boss',?,'启用')", tenantId).lastInsertRowid);
  q.run('UPDATE tenants SET primary_user_id=? WHERE id=?', ownerId, tenantId);
  const oldMemberId = Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES('invite_old_member','unused','旧员工','sales',?,'启用')", tenantId).lastInsertRowid);
  const invitation = createInvitation(superUser, { type: 'existing_tenant', tenantId, role: 'manager' }, 'platform');
  assert.throws(() => registration(invitation.code, 'invite_seat_owner'), failure => failure.code === 'USERNAME_TAKEN');
  assert.throws(() => registration(invitation.code, 'invite_seat_member'), failure => failure.code === 'SEAT_LIMIT_REACHED');
  assert.equal(q.get('SELECT used_count FROM invitations WHERE id=?', invitation.invitation.id).used_count, 0);
  q.run("UPDATE users SET status='停用' WHERE id=?", ownerId);
  assert.throws(() => registration(invitation.code, 'invite_seat_member'), failure => failure.code === 'SEAT_LIMIT_REACHED');
  assert.equal(q.get('SELECT used_count FROM invitations WHERE id=?', invitation.invitation.id).used_count, 0);
  q.run("UPDATE users SET status='停用' WHERE id=?", oldMemberId);
  const completed = registration(invitation.code, 'invite_seat_member');
  assert.equal(completed.tenantId, tenantId);
  const member = q.get("SELECT role,modules,credits,store_id FROM users WHERE username='invite_seat_member'");
  assert.equal(member.role, 'manager'); assert.equal(member.modules, null); assert.equal(member.credits, 0); assert.equal(member.store_id, null);
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, 17);
});

test('使用上限与撤销幂等：没有隐式续期，撤销仅产生一次审计', () => {
  const invitation = createInvitation(superUser, { type: 'new_tenant', maxUses: 2 }, 'platform');
  registration(invitation.code, 'invite_limit_first');
  registration(invitation.code, 'invite_limit_second');
  assert.throws(() => registration(invitation.code, 'invite_limit_third'), /邀请码无效/u);
  const first = revokeInvitation(superUser, invitation.invitation.id, 'platform');
  const again = revokeInvitation(superUser, invitation.invitation.id, 'platform');
  assert.equal(first.invitation.revokedAt, again.invitation.revokedAt);
  assert.equal(again.invitation.status, 'revoked');
  assert.equal(q.get("SELECT COUNT(*) n FROM invitation_events WHERE invitation_id=? AND event='revoked'", invitation.invitation.id).n, 1);
  assert.equal(q.get('SELECT used_count FROM invitations WHERE id=?', invitation.invitation.id).used_count, 2);
});

test('发码者降权或停用即失效，伪造请求中的超管角色也不能创建新企业码', () => {
  const invitation = createInvitation(superUser, { type: 'new_tenant' }, 'platform');
  q.run("UPDATE users SET role='boss' WHERE id=?", superId);
  assert.throws(() => previewInvitation(invitation.code), /邀请码无效/u);
  assert.throws(() => createInvitation({ id: superId, role: 'platform_super' }, { type: 'new_tenant' }, 'platform'), failure => failure.status === 403);
  q.run("UPDATE users SET role='platform_super',status='停用' WHERE id=?", superId);
  assert.throws(() => registration(invitation.code, 'inactive_inviter_member'), /邀请码无效/u);
  assert.equal(q.get('SELECT used_count FROM invitations WHERE id=?', invitation.invitation.id).used_count, 0);
  q.run("UPDATE users SET status='启用' WHERE id=?", superId);
});

after(() => { db.close(); removeTempDbSafely(databasePath); });

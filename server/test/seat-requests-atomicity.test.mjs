import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const databasePath = path.join(os.tmpdir(), `seat-request-atomicity-${process.pid}.db`);
process.env.NANOWORK_DB = databasePath;
process.env.NODE_ENV = 'test';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.ENABLE_SCHEDULER = 'false';
const { db, q, initSchema, migrateV2 } = await import('../src/db.js');
initSchema(); migrateV2();
const seats = await import('../src/engines/seat-requests.js');
const plan = await import('../src/engines/plan.js');
const invitations = await import('../src/engines/invitations.js');
const { settlePaidOrder } = await import('../src/routes/recharge.js');
let serial = 0;
const newUser = (tenantId, role = 'boss', status = '启用') => ({ id: Number(q.run(`INSERT INTO users(username,password_hash,name,role,tenant_id,status)
  VALUES(?,?,?,?,?,?)`, `seat_user_${++serial}`, 'unused', `席位测试${serial}`, role, tenantId, status).lastInsertRowid) });
const superUser = newUser(1, 'platform_super');
const newTenant = (limit = 5) => {
  const id = Number(q.run("INSERT INTO tenants(name,status,seat_limit,credits) VALUES(?,'已开通',?,123)", `企业${++serial}`, limit).lastInsertRowid);
  const owner = newUser(id); q.run('UPDATE tenants SET primary_user_id=? WHERE id=?', owner.id, id);
  return { id, owner };
};

test('迁移一次性收回企业1未使用的自动999席，保留存量账号、其他企业额度和后续付费席位', () => {
  q.run("DELETE FROM sys_config WHERE key='migration.primary_seats_v1'");
  q.run('UPDATE tenants SET seat_limit=999,primary_user_id=NULL WHERE id=1');
  const owner = newUser(1);
  for (let i = 0; i < 5; i++) newUser(1, 'sales');
  const legacy = newTenant(20);
  migrateV2();
  assert.equal(q.get('SELECT seat_limit,primary_user_id FROM tenants WHERE id=1').seat_limit, 6);
  assert.equal(plan.primaryUserIdFor(1), owner.id);
  assert.equal(plan.seatSummary(1).legacyExtraSeats, 1);
  assert.equal(plan.seatSummary(1).subSeatsUsed, 5);
  assert.equal(q.get('SELECT seat_limit FROM tenants WHERE id=?', legacy.id).seat_limit, 20);
  q.run('UPDATE tenants SET seat_limit=9 WHERE id=1');
  migrateV2();
  assert.equal(plan.seatUsage(1).limit, 9);
  assert.equal(q.get("SELECT COUNT(*) n FROM users WHERE tenant_id=1 AND role!='platform_super' AND status='启用'").n, 6);
});

test('未明确主账号时只读识别唯一启用老板；多个老板不猜，停用主账号不能释放第5个副位', () => {
  const t = newTenant();
  q.run('UPDATE tenants SET primary_user_id=NULL WHERE id=?', t.id);
  assert.equal(plan.primaryUserIdFor(t.id), t.owner.id);
  assert.equal(q.get('SELECT primary_user_id FROM tenants WHERE id=?', t.id).primary_user_id, null);
  newUser(t.id);
  assert.equal(plan.primaryAccountFor(t.id), null);
  assert.equal(plan.seatSummary(t.id).primaryAssignmentRequired, true);
  seats.assignPrimaryAccount(superUser, t.id, { userId: t.owner.id });
  for (let i = 0; i < 3; i++) newUser(t.id, 'sales');
  assert.throws(() => plan.assertSeatAvailable(t.id), error => error.code === 'SEAT_LIMIT_REACHED');
  q.run("UPDATE users SET status='停用' WHERE id=?", t.owner.id);
  assert.throws(() => plan.assertSeatAvailable(t.id), error => error.code === 'SEAT_LIMIT_REACHED');
  assert.doesNotThrow(() => plan.assertSeatAvailable(t.id, { userId: t.owner.id }));
});

test('申请/报价不发席位；审计失败使订单、席位和申请全部回滚，重试及重复确认仅生效一次', () => {
  const t = newTenant(6);
  const created = seats.createSeatRequest(t.owner, { additionalSeats: 3, reason: '增加门店员工' });
  assert.equal(created.request.status, 'requested'); assert.equal(created.request.amountFen, null);
  assert.equal(created.summary.seatLimit, 6);
  db.exec(`CREATE TRIGGER reject_seat_quote_audit BEFORE INSERT ON op_logs
    WHEN NEW.module='账号席位' AND NEW.action='席位增额报价' BEGIN SELECT RAISE(ABORT,'quote audit failed'); END;`);
  const ordersBefore = q.get('SELECT COUNT(*) n FROM recharge_orders').n;
  assert.throws(() => seats.quoteSeatRequest(superUser, created.request.id, { amountFen: 18001 }), /quote audit failed/u);
  assert.equal(q.get('SELECT COUNT(*) n FROM recharge_orders').n, ordersBefore);
  assert.equal(q.get('SELECT status FROM seat_requests WHERE id=?', created.request.id).status, 'requested');
  db.exec('DROP TRIGGER reject_seat_quote_audit');
  const quoted = seats.quoteSeatRequest(superUser, created.request.id, { amountFen: 18001 });
  const order = q.get('SELECT * FROM recharge_orders WHERE id=?', quoted.request.orderId);
  assert.equal(order.credits, 0); assert.equal(order.package_id, null); assert.equal(order.price_yuan, 180.01);
  assert.equal(quoted.summary.seatLimit, 6);
  assert.throws(() => seats.quoteSeatRequest(superUser, created.request.id, { amountFen: 1 }), error => error.status === 409);
  assert.throws(() => seats.confirmSeatRequestPayment(superUser, order.id, {}), error => error.code === 'PAYMENT_REFERENCE_REQUIRED');
  db.exec(`CREATE TRIGGER reject_seat_payment_audit BEFORE INSERT ON op_logs
    WHEN NEW.module='账号席位' AND NEW.action='确认席位增额到账' BEGIN SELECT RAISE(ABORT,'payment audit failed'); END;`);
  assert.throws(() => seats.confirmSeatRequestPayment(superUser, order.id, { paymentReference: '银行流水 TEST-001' }), /payment audit failed/u);
  assert.equal(plan.seatUsage(t.id).limit, 6);
  assert.equal(q.get('SELECT status FROM recharge_orders WHERE id=?', order.id).status, '待支付');
  assert.equal(q.get('SELECT status FROM seat_requests WHERE id=?', created.request.id).status, 'quoted');
  db.exec('DROP TRIGGER reject_seat_payment_audit');
  const applied = seats.confirmSeatRequestPayment(superUser, order.id, { paymentReference: '银行流水 TEST-001' });
  assert.equal(applied.duplicated, false); assert.equal(applied.seatSummary.seatLimit, 9);
  assert.equal(applied.seatSummary.purchasedExtraSeats, 3); assert.equal(applied.seatSummary.legacyExtraSeats, 1);
  const repeated = seats.confirmSeatRequestPayment(superUser, order.id, { paymentReference: '银行流水 TEST-001' });
  assert.equal(repeated.duplicated, true); assert.equal(repeated.seatSummary.seatLimit, 9);
  assert.equal(q.get('SELECT credits,total_recharged FROM tenants WHERE id=?', t.id).credits, 123);
  assert.equal(q.get('SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=?', t.id).n, 0);
  assert.equal(q.get("SELECT COUNT(*) n FROM op_logs WHERE tenant_id=? AND action='确认席位增额到账'", t.id).n, 1);
  const pkg = q.get("SELECT * FROM recharge_packages WHERE kind='plan' LIMIT 1");
  const renewed = plan.activatePlanForTenant({ tenantId: t.id, pkg: { ...pkg, seat_limit: 999, bonus_credits: 0 }, operatorUserId: t.owner.id });
  assert.equal(renewed.seatLimit, 9); assert.equal(plan.seatUsage(t.id).limit, 9);
});

test('旧取消和在线支付回调不能形成已支付却未发席位，取消后不得到账', () => {
  const t = newTenant();
  const created = seats.createSeatRequest(t.owner, { additionalSeats: 2 });
  const quoted = seats.quoteSeatRequest(superUser, created.request.id, { amountFen: 4321 });
  assert.throws(() => settlePaidOrder({ orderNo: quoted.request.orderNo, channelName: '微信支付', paidFen: 4321 }), error => error.code === 'SEAT_ORDER_OFFLINE_ONLY');
  assert.equal(plan.seatUsage(t.id).limit, 5);
  const cancelled = seats.cancelSeatRequestForOrder(t.owner, quoted.request.orderId);
  assert.equal(cancelled.request.status, 'cancelled'); assert.equal(cancelled.request.orderStatus, '已取消');
  assert.equal(seats.cancelSeatRequestForOrder(t.owner, quoted.request.orderId).request.status, 'cancelled');
  assert.throws(() => seats.confirmSeatRequestPayment(superUser, quoted.request.orderId, { paymentReference: '已取消订单测试' }), error => error.status === 409);
  assert.equal(plan.seatUsage(t.id).limit, 5);
});

test('邀请码新企业显式绑定主账号，成员邀请角色为boss也不会取得主身份', () => {
  const code = invitations.createInvitation(superUser, { type: 'new_tenant' }, 'platform').code;
  const created = invitations.registerWithInvitation({ inviteCode: code, company: '邀请码主副账号', username: `seat_register_${++serial}`, password: 'Password-1234' });
  const tenant = q.get('SELECT * FROM tenants WHERE id=?', created.tenantId);
  assert.ok(tenant.primary_user_id); assert.equal(tenant.seat_limit, 5);
  const primary = tenant.primary_user_id;
  const memberCode = invitations.createInvitation(superUser, { type: 'existing_tenant', tenantId: tenant.id, role: 'boss' }, 'platform').code;
  invitations.registerWithInvitation({ inviteCode: memberCode, company: '', username: `seat_member_${++serial}`, password: 'Password-1234' });
  assert.equal(plan.primaryUserIdFor(tenant.id), primary);
  assert.equal(plan.seatSummary(tenant.id).subSeatsUsed, 1);
});

after(() => { db.close(); removeTempDbSafely(databasePath); });

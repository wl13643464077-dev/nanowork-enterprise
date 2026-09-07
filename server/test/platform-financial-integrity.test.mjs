import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-platform-finance-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;

const { initSchema, migrateV2, q, db, runWithTenant } = await import('../src/db.js');
const platformRoutes = (await import('../src/routes/platform.js')).default;

initSchema();
migrateV2();

const superId = q.run(`INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('platform_finance_admin','x','平台财务','platform_super',1)`).lastInsertRowid;
const tenantId = q.run(`INSERT INTO tenants(name,status,plan,credits,total_recharged,seat_limit) VALUES('财务测试企业','待审核','试用版',0,0,5)`).lastInsertRowid;
const bossId = q.run(`INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('finance_tenant_boss','x','客户老板','boss',?)`, tenantId).lastInsertRowid;
const orderId = q.run(`INSERT INTO recharge_orders(order_no,tenant_id,package_name,price_yuan,credits,status,created_by)
  VALUES('FINANCE-ORDER-001',?,'标准包',5,500,'待支付',?)`, tenantId, bossId).lastInsertRowid;
const platformUser = { id: Number(superId), name: '平台财务', role: 'platform_super', tenant_id: 1 };

function appForPlatform(user = platformUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(1, () => { req.user = user; next(); }));
  app.use('/platform', platformRoutes);
  return app;
}

async function withServer(fn, user) {
  const server = appForPlatform(user).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function call(base, route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

test('平台财务一致性：开通赠送和充值确认幂等，通知落到客户租户', async () => {
  await withServer(async base => {
    const invalidModules = await call(base, `/platform/tenants/${tenantId}/approve`, {
      modules: ['dashboard', 'root-shell'], plan: '标准版', grantCredits: 100, seatLimit: 5,
    });
    assert.equal(invalidModules.status, 400);
    assert.equal(q.get('SELECT status FROM tenants WHERE id=?', tenantId).status, '待审核');

    const bypass = await call(base, `/platform/tenants/${tenantId}/approve`, {
      modules: ['dashboard', 'advisor'], plan: '标准版', grantCredits: 100, seatLimit: 8,
    });
    assert.equal(bypass.status, 409, '直接增加席位必须被拒绝且赠分也不能先发生');
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, 0);
    const approved = await call(base, `/platform/tenants/${tenantId}/approve`, {
      modules: ['dashboard', 'advisor'], plan: '标准版', grantCredits: 100, seatLimit: 5,
    });
    assert.equal(approved.status, 200);
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, 100);

    const approvedAgain = await call(base, `/platform/tenants/${tenantId}/approve`, {
      modules: ['dashboard', 'advisor'], plan: '标准版', grantCredits: 100, seatLimit: 5,
    });
    assert.equal(approvedAgain.status, 200);
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, 100);

    const confirmed = await call(base, `/platform/recharge-orders/${orderId}/confirm`, {});
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.json.balance, 600);
    assert.equal(q.get('SELECT status FROM recharge_orders WHERE id=?', orderId).status, '已支付');
    assert.equal(q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=? AND note='FINANCE-ORDER-001'`, tenantId).n, 0);
    assert.equal(q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=? AND note='\u8ba2\u5355 FINANCE-ORDER-001'`, tenantId).n, 1);

    const confirmedAgain = await call(base, `/platform/recharge-orders/${orderId}/confirm`, {});
    assert.equal(confirmedAgain.status, 400);
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, 600);
    assert.equal(q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=? AND note='\u8ba2\u5355 FINANCE-ORDER-001'`, tenantId).n, 1);

    const invalidAmount = await call(base, `/platform/tenants/${tenantId}/credits`, { delta: '1e999' });
    assert.equal(invalidAmount.status, 400);
    const overdraw = await call(base, `/platform/tenants/${tenantId}/credits`, { delta: -1000, note: '不应透支', requestKey: 'finance-overdraw' });
    assert.equal(overdraw.status, 409);
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, 600);

    const notifications = q.all('SELECT tenant_id,user_id,type FROM notifications WHERE user_id=?', bossId);
    assert.ok(notifications.some(row => row.type === '账号开通'));
    assert.ok(notifications.some(row => row.type === '充值到账'));
    assert.ok(notifications.every(row => Number(row.tenant_id) === Number(tenantId)));
  });
});

test.after(() => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

test('直充与扣减同操作重试仅记一次，换金额拒绝复用编号，缺少编号不改余额', async () => {
  await withServer(async base => {
    const route = `/platform/tenants/${tenantId}/credits`;
    const before = q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits;
    const missing = await call(base, route, { delta: 200 });
    assert.equal(missing.status, 400);
    const body = { delta: 200, note: '隔离测试', requestKey: 'finance-once-credit' };
    const responses = await Promise.all(Array.from({ length: 8 }, () => call(base, route, body)));
    assert.ok(responses.every(response => response.status === 200));
    assert.equal(responses.filter(response => !response.json.duplicated).length, 1);
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, before + 200);
    assert.equal((await call(base, route, { ...body, delta: 201 })).status, 409);
    const deduction = { delta: -100, requestKey: 'finance-once-deduction' };
    assert.equal((await call(base, route, deduction)).status, 200);
    assert.equal((await call(base, route, deduction)).json.duplicated, true);
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, before + 100);
  });
});

test('手工开通同编号不重复顺延或赠分，新购买编号才形成另一笔', async () => {
  const packageId = Number(q.run(`INSERT INTO recharge_packages(name,kind,price_yuan,base_credits,bonus_credits,total_credits,seat_limit,valid_days,enabled)
    VALUES('人工幂等套餐','plan',30,0,40,0,5,30,1)`).lastInsertRowid);
  await withServer(async base => {
    const route = `/platform/tenants/${tenantId}/plan/activate`;
    const before = q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits;
    const body = { packageId, requestKey: 'manual-plan-first' };
    const first = await call(base, route, body);
    assert.equal(first.status, 200);
    const retry = await call(base, route, body);
    assert.equal(retry.status, 200);
    assert.equal(retry.json.duplicated, true);
    assert.equal(retry.json.expiresAt, first.json.expiresAt);
    q.run('UPDATE recharge_packages SET enabled=0 WHERE id=?', packageId);
    assert.equal((await call(base, route, body)).json.duplicated, true);
    q.run('UPDATE recharge_packages SET enabled=1 WHERE id=?', packageId);
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, before + 40);
    const second = await call(base, route, { ...body, requestKey: 'manual-plan-second' });
    assert.equal(second.status, 200);
    assert.notEqual(second.json.expiresAt, first.json.expiresAt);
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, before + 80);
  });
});

test('财务审计写入失败同事务回滚，之后同编号重试成功；通知失败不误报入账失败', async () => {
  await withServer(async base => {
    const before = q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits;
    db.exec(`CREATE TRIGGER reject_financial_audit BEFORE INSERT ON op_logs
      WHEN NEW.action IN ('直充积分','确认充值到账') BEGIN SELECT RAISE(ABORT,'fixture audit unavailable'); END`);
    const body = { delta: 200, requestKey: 'financial-audit-retry' };
    const id = Number(q.run(`INSERT INTO recharge_orders(order_no,tenant_id,package_name,price_yuan,credits,status,created_by)
      VALUES('FINANCE-AUDIT-ORDER',?,'待确认',1,100,'待支付',?)`, tenantId, bossId).lastInsertRowid);
    try {
      assert.equal((await call(base, `/platform/tenants/${tenantId}/credits`, body)).status, 500);
      assert.equal((await call(base, `/platform/recharge-orders/${id}/confirm`, {})).status, 500);
      assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, before);
      assert.equal(q.get('SELECT status FROM recharge_orders WHERE id=?', id).status, '待支付');
      assert.equal(q.get('SELECT COUNT(*) n FROM platform_financial_requests WHERE request_key=?', body.requestKey).n, 0);
    } finally { db.exec('DROP TRIGGER reject_financial_audit'); }
    assert.equal((await call(base, `/platform/tenants/${tenantId}/credits`, body)).status, 200);
    db.exec(`CREATE TRIGGER reject_financial_notice BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'fixture notification unavailable'); END`);
    try {
      assert.equal((await call(base, `/platform/recharge-orders/${id}/confirm`, {})).status, 200);
      assert.equal(q.get('SELECT status FROM recharge_orders WHERE id=?', id).status, '已支付');
      assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, before + 300);
    } finally { db.exec('DROP TRIGGER reject_financial_notice'); }
  });
});

test('平台套餐价格必须到分，购买积分面值与声明赠送分开', async () => {
  await withServer(async base => {
    for (const price_yuan of [0.000001, 1.001, true]) {
      assert.equal((await call(base, '/platform/packages', { name: '不得落库', price_yuan })).status, 400);
    }
    const valid = await call(base, '/platform/packages', { name: '明示赠送积分包', price_yuan: 19.99, bonus_credits: 300 });
    assert.equal(valid.status, 200);
    const row = q.get('SELECT * FROM recharge_packages WHERE id=?', valid.json.id);
    assert.equal(row.base_credits, 1999);
    assert.equal(row.bonus_credits, 300);
    assert.equal(row.total_credits, 2299);
  });
});

test('企业角色不能用平台直充或开通接口给自己加钱、延长套餐', async () => {
  const before = q.get('SELECT credits,plan_expires_at FROM tenants WHERE id=?', tenantId);
  for (const role of ['boss', 'admin', 'manager', 'sales']) {
    await withServer(async base => {
      assert.equal((await call(base, `/platform/tenants/${tenantId}/credits`, { delta: 999, requestKey: `role-forbidden-${role}` })).status, 403);
      assert.equal((await call(base, `/platform/tenants/${tenantId}/plan/activate`, { packageId: 1, requestKey: `role-forbidden-${role}` })).status, 403);
    }, { id: bossId, tenant_id: tenantId, role });
  }
  assert.deepEqual(q.get('SELECT credits,plan_expires_at FROM tenants WHERE id=?', tenantId), before);
});

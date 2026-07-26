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

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const platformRoutes = (await import('../src/routes/platform.js')).default;

initSchema();
migrateV2();

const superId = q.run(`INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('platform_finance_admin','x','平台财务','platform_super',1)`).lastInsertRowid;
const tenantId = q.run(`INSERT INTO tenants(name,status,plan,credits,total_recharged,seat_limit) VALUES('财务测试企业','待审核','试用版',0,0,5)`).lastInsertRowid;
const bossId = q.run(`INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('finance_tenant_boss','x','客户老板','boss',?)`, tenantId).lastInsertRowid;
const orderId = q.run(`INSERT INTO recharge_orders(order_no,tenant_id,package_name,price_yuan,credits,status,created_by)
  VALUES('FINANCE-ORDER-001',?,'标准包',5,500,'待支付',?)`, tenantId, bossId).lastInsertRowid;
const platformUser = { id: Number(superId), name: '平台财务', role: 'platform_super', tenant_id: 1 };

function appForPlatform() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(1, () => { req.user = platformUser; next(); }));
  app.use('/platform', platformRoutes);
  return app;
}

async function withServer(fn) {
  const server = appForPlatform().listen(0);
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

    const approved = await call(base, `/platform/tenants/${tenantId}/approve`, {
      modules: ['dashboard', 'advisor'], plan: '标准版', grantCredits: 100, seatLimit: 8,
    });
    assert.equal(approved.status, 200);
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, 100);

    const approvedAgain = await call(base, `/platform/tenants/${tenantId}/approve`, {
      modules: ['dashboard', 'advisor'], plan: '标准版', grantCredits: 100, seatLimit: 8,
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
    const overdraw = await call(base, `/platform/tenants/${tenantId}/credits`, { delta: -1000, note: '不应透支' });
    assert.equal(overdraw.status, 409);
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, 600);

    const notifications = q.all('SELECT tenant_id,user_id,type FROM notifications WHERE user_id=?', bossId);
    assert.ok(notifications.some(row => row.type === '账号开通'));
    assert.ok(notifications.some(row => row.type === '充值到账'));
    assert.ok(notifications.every(row => Number(row.tenant_id) === Number(tenantId)));
  });
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

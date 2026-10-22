import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-tester-product-billing-'));
Object.assign(process.env, { NANOWORK_DB: path.join(dir, 'test.db'), NODE_ENV: 'test',
  NANOWORK_TEST_TEMPLATE_AI: '1', SEED_DEMO: 'false', ENABLE_SCHEDULER: 'false',
  JWT_SECRET: 'tester-product-billing-isolated-secret-'.repeat(2), AI360_API_KEY: 'platform-key-must-not-pay' });
const { db, q, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
initSchema(); migrateV2();
const api = await import('../src/engines/tester-trials.js');
const c = await import('../src/engines/credits.js');
const { read360Cost } = await import('../src/engines/provider-360-cost.js');
const { platformFinancialLedger, summarizePlatformFinance } = await import('../src/engines/platform-finance.js');
const { runWithProviderContext } = await import('../src/engines/tester-provider-context.js');
const { testerExecutionCredentials } = await import('../src/engines/tester-access.js');
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const admin = { id: Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES('billing_super','x','测试超管','platform_super',1,'启用')").lastInsertRowid) };
let seq = 0;
function owner({ key = true } = {}) {
  const n = ++seq;
  api.applyTester({ username: `byok_owner_${n}`, password: 'Fake-Test-Password!', name: '演示测试员', phone: `1385678${String(n).padStart(4, '0')}`, consent: true });
  const user = q.get('SELECT id,tenant_id FROM users WHERE username=?', `byok_owner_${n}`);
  api.updateTesterStatus(admin, user.id, 'approved');
  if (key) api.setTesterKey(user, `fake-360-personal-key-${n}`, '360');
  return user;
}
const model = 'deepseek/deepseek-v4-flash';
const balance = u => q.get('SELECT credits FROM tenants WHERE id=?', u.tenant_id).credits;
const usage = { inputTokens: 200, outputTokens: 100 };
const receipt = (amount = 0.12) => read360Cost({ model, response: { id: `byok-bill-${++seq}`, model, usage: { amount: String(amount) } } });
const hold = (u, kind = 'text') => c.holdCredits({ userId: u.id, tenantId: u.tenant_id, feature: '完整产品个人Key测试', kind, model, credits: 123 });

test('zero-balance personal account gets a real zero-credit hold and settles once, retaining upstream cost', () => {
  const u = owner();
  assert.equal(c.precheckDetailed(u.id, 'text', model).billingMode, 'personal');
  assert.equal(balance(u), 0);
  const h = hold(u), source = receipt();
  assert.ok(h.holdId > 0 && h.logId > 0);
  assert.equal(h.credits, 0);
  const stored = q.get('SELECT * FROM credit_holds WHERE id=?', h.holdId);
  assert.equal(stored.status, 'held');
  assert.equal(JSON.parse(stored.pricing_snapshot_json).ownerUserId, u.id);
  const frozen = JSON.parse(stored.pricing_snapshot_json);
  for (const kind of ['text', 'image', 'video', 'tts']) assert.deepEqual(frozen[kind], c.billing()[kind]);
  const settled = c.settleHold(h, { usage: { ...usage, supplierCosts: [source] }, authorizationCapCredits: 123 });
  assert.equal(settled.credits, 0); assert.equal(settled.costYuan, 0.12);
  assert.equal(settled.billingMode, 'personal'); assert.equal(balance(u), 0);
  assert.equal(q.get('SELECT ai_mode FROM credit_logs WHERE id=?', h.logId).ai_mode, 'api');
  const expense = c.getSupplierExpense(h.holdId, u.tenant_id);
  assert.equal(expense.costSource.costPayer, 'personal'); assert.equal(expense.status, 'known');
  assert.equal(c.settleHold(h, { usage }), null);
  assert.equal(q.get('SELECT COUNT(*) n FROM credit_supplier_receipts WHERE hold_id=?', h.holdId).n, 1);
});

test('missing personal Key blocks precheck and hold even when a platform Key exists', () => {
  const u = owner({ key: false });
  assert.throws(() => c.precheck(u.id, 'text', model), { code: 'PERSONAL_KEY_REQUIRED' });
  assert.throws(() => hold(u), { code: 'PERSONAL_KEY_REQUIRED' });
  assert.equal(q.get('SELECT COUNT(*) n FROM credit_holds WHERE user_id=?', u.id).n, 0);
});

test('unknown image/video upstream cost remains pending, never a fake zero supplier cost', () => {
  const u = owner();
  for (const kind of ['image', 'video']) {
    const h = hold(u, kind);
    const result = c.settleHold(h, { usage: { supplierCosts: [{ status: 'pending' }] }, credits: 123 });
    assert.equal(result.credits, 0); assert.equal(result.costYuan, null);
    assert.equal(result.supplierCostStatus, 'pending'); assert.equal(balance(u), 0);
    const late = receipt(0.5);
    c.reconcileSupplierExpense(h, { supplierCostYuan: late.costYuanOverride, costSource: late.costSource });
    assert.equal(c.getSupplierExpense(h.holdId, u.tenant_id).costSource.costPayer, 'personal');
    assert.equal(balance(u), 0);
  }
});

test('failure/refund and paused in-flight settlement retain costs without wallet debit or refund credits', () => {
  const u = owner(), h = hold(u), source = receipt(0.3);
  api.updateTesterStatus(admin, u.id, 'paused');
  assert.throws(() => hold(u), { code: 'TESTER_INACTIVE' });
  const failed = c.refundHold(h, { supplierCostYuan: source.costYuanOverride, costSource: source.costSource });
  assert.equal(failed.refundedCredits, 0); assert.equal(failed.costYuan, 0.3);
  assert.equal(c.refundHold(h).duplicate, true); assert.equal(balance(u), 0);
  assert.equal(c.getSupplierExpense(h.holdId, u.tenant_id).costSource.costPayer, 'personal');
});

test('settlement cannot forge owner, amount or supplier; receipts cannot be reused for another tester', () => {
  const a = owner(), b = owner(), h = hold(a), source = receipt();
  assert.throws(() => c.settleHold({ ...h, userId: b.id }, { usage }), { code: 'CREDIT_HOLD_INTEGRITY_MISMATCH' });
  assert.throws(() => c.settleHold({ ...h, credits: 123 }, { usage }), { code: 'CREDIT_HOLD_INTEGRITY_MISMATCH' });
  c.settleHold(h, { usage: { ...usage, supplierCosts: [source] } });
  const other = hold(b);
  assert.throws(() => c.settleHold(other, { usage: { ...usage, supplierCosts: [source] } }), { code: 'BILLING_SUPPLIER_RECEIPT_REUSED' });
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', other.holdId).status, 'held');
  assert.throws(() => c.holdCredits({ userId: a.id, tenantId: b.tenant_id, feature: '伪造', credits: 2 }), { status: 403 });
});

test('frozen personal billing survives changing active supplier, while direct charges also stay personal', () => {
  const u = owner();
  const h = runWithTenant(u.tenant_id, () => runWithProviderContext(testerExecutionCredentials({ userId: u.id }), () => hold(u)));
  api.setTesterKey(u, 'fake-openlux-personal-key', 'openlux'); api.setTesterProvider(u, 'openlux');
  const original = c.settleHold(h, { usage: { ...usage, supplierCosts: [receipt()] } });
  assert.equal(original.provider, '360');
  api.setTesterProvider(u, '360');
  const source = receipt();
  const direct = c.charge({ userId: u.id, feature: '直接调用', kind: 'text', model, usage: { ...usage, supplierCosts: [source] } });
  assert.equal(direct.credits, 0); assert.equal(direct.costYuan, 0.12); assert.equal(balance(u), 0);
  const duplicate = c.charge({ userId: u.id, feature: '直接调用', kind: 'text', model, usage: { ...usage, supplierCosts: [source] } });
  assert.equal(duplicate.duplicate, true); assert.equal(balance(u), 0);
});

test('personal expenses are visible as tester-paid audit entries and excluded from platform cost/margin', () => {
  const u = owner(), h = hold(u);
  c.settleHold(h, { usage: { ...usage, supplierCosts: [receipt(1.2)] } });
  const rows = platformFinancialLedger({ where: 'WHERE l.tenant_id=?', params: [u.tenant_id] });
  assert.equal(rows.length, 1); assert.equal(rows[0].billing_mode, 'personal');
  assert.equal(rows[0].supplier_cost_yuan, 1.2);
  const summary = summarizePlatformFinance(rows);
  assert.equal(summary.knownCostYuan, 0); assert.equal(summary.spent, 0); assert.equal(summary.margin, 0);
});

test('normal enterprise still requires and spends its own platform credits', () => {
  const tid = Number(q.run("INSERT INTO tenants(name,status,credits) VALUES('普通企业','已开通',0)").lastInsertRowid);
  const uid = Number(q.run("INSERT INTO users(tenant_id,username,password_hash,name,role,status) VALUES(?,'ordinary_billing_owner','x','企业老板','boss','启用')", tid).lastInsertRowid);
  assert.throws(() => c.precheck(uid, 'text', model), { status: 402 });
  assert.throws(() => c.holdCredits({ userId: uid, feature: '普通', credits: 123 }), { status: 402 });
});

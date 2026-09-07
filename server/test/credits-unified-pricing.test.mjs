// 统一售价（360 基准 × 2）：用户价与供应商实扣分离。
// 同一业务在 OpenLux 与 360 收费相同；实际成本高低只改平台成本记录；缺回执不阻断交付；
// 旧快照按原规则；重复结算/退款不重复动账；余额与账本恒等。
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-unified-pricing-'));
Object.assign(process.env, { NANOWORK_DB: path.join(dir, 'test.db'), NODE_ENV: 'test', NANOWORK_TEST_TEMPLATE_AI: '1',
  SEED_DEMO: 'false', ENABLE_SCHEDULER: 'false', NANOWORK_AI_PROVIDER: '', YUNWU_BASE_URL: 'https://api.openlux.ai/v1',
  YUNWU_API_KEY: '', OPENLUX_API_KEY: 'unified-openlux-test', AI360_API_KEY: 'unified-360-test', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' });
const { db, q, initSchema, migrateV2, setConfig } = await import('../src/db.js');
const c = await import('../src/engines/credits.js');
const { withPlatformProvider } = await import('../src/engines/ai-provider-selection.js');
initSchema(); migrateV2();
setConfig('ai_provider_default', 'openlux');
setConfig('supplier_cost_openlux', { enabled: true, basis: 'upstream_debit' });
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let seq = 0;
function actor(balance = 100000) {
  const tid = Number(q.run("INSERT INTO tenants(name,status,credits) VALUES('统一定价专项','已开通',0)").lastInsertRowid);
  const uid = Number(q.run("INSERT INTO users(tenant_id,username,password_hash,name,role,status) VALUES(?,?,'x','测试','boss','启用')", tid, `unified-${++seq}`).lastInsertRowid);
  c.creditTenant({ tenantId: tid, userId: uid, delta: balance, feature: '测试充值' });
  return { tid, uid };
}
const balance = a => q.get('SELECT credits FROM tenants WHERE id=?', a.tid).credits;
const invariant = a => assert.equal(balance(a), -q.get('SELECT SUM(credits) amount FROM credit_logs WHERE tenant_id=?', a.tid).amount);
const openluxReceipt = (amountUsd, rate = 7) => ({ status: 'known', costYuanOverride: amountUsd * rate,
  costSource: { type: 'provider_receipt', provider: 'openlux', basis: 'upstream_debit', requestId: `openlux-${++seq}`, currency: 'USD',
    amount: amountUsd, exchangeRate: rate, quota: amountUsd * 500000, quotaPerUnit: 500000,
    exchangeRateSource: 'https://api.openlux.ai/api/status', statusRetrievedAt: '2026-09-07T00:00:00.000Z', statusDisplayCurrency: 'USD' } });
const { read360Cost } = await import('../src/engines/provider-360-cost.js');
const receipt360 = amountCny => read360Cost({ model: 'deepseek/deepseek-v4-flash',
  response: { id: `r360-${++seq}`, model: 'deepseek/deepseek-v4-flash', usage: { amount: String(amountCny) } } });
const enable = () => setConfig('unified_360_pricing', { enabled: true, imageBenchmarkCny: 0.5, imagePriceBasis: '测试用：以核实后的 360 账单为准' });
const disable = () => setConfig('unified_360_pricing', { enabled: false });
// 1 万输入 + 1 万输出 token，按 360 flash 基准 3/9 元每百万：0.12 元 × 2 ÷ 0.01 = 24 积分。
const usage = { inputTokens: 10000, outputTokens: 10000 };

test('未确认图片基准价时不能启用统一价；旧预授权保持原快照规则', () => {
  const a = actor();
  setConfig('unified_360_pricing', { enabled: true });
  assert.throws(() => c.billing(), { code: 'BILLING_IMAGE_PRICE_UNCONFIRMED' });
  disable();
  const legacyHold = c.holdCredits({ userId: a.uid, kind: 'text', model: 'deepseek-v4-flash', feature: '旧规则', credits: 500 });
  enable();
  assert.equal(c.billing().salePolicy.basis, 'reference_360');
  // 旧快照没有 salePolicy：仍按当时的钱包实扣规则，缺回执阻断，不套新价。
  assert.throws(() => c.settleHold(legacyHold, { model: 'deepseek-v4-flash', aiMode: 'api', usage }), { code: 'BILLING_SUPPLIER_COST_PENDING' });
  const settled = c.settleHold(legacyHold, { model: 'deepseek-v4-flash', aiMode: 'api', usage: { ...usage, supplierCosts: [openluxReceipt(0.1)] } });
  assert.equal(settled.credits, 140, '旧规则：实扣 0.7 元 × 2 ÷ 0.01');
  invariant(a);
});

test('同一文本任务在 OpenLux 与 360 售价相同；实际成本只改平台成本记录，缺回执不阻断且可后补', () => {
  enable();
  const a = actor();
  const before = balance(a);
  const openluxHold = c.holdCredits({ userId: a.uid, kind: 'text', model: 'deepseek-v4-flash', feature: '统一价·OpenLux', credits: 500 });
  const snapshot = JSON.parse(q.get('SELECT pricing_snapshot_json FROM credit_holds WHERE id=?', openluxHold.holdId).pricing_snapshot_json);
  assert.equal(snapshot.salePolicy.basis, 'reference_360'); assert.equal(snapshot.supplierCostPolicy.basis, 'reference_360');

  // OpenLux 实扣 0.7 元（高于参考价 0.12），用户仍付 24 积分。
  const expensive = c.settleHold(openluxHold, { model: 'deepseek-v4-flash', aiMode: 'api', usage: { ...usage, supplierCosts: [openluxReceipt(0.1)] } });
  assert.equal(expensive.credits, 24); assert.equal(expensive.supplierCostStatus, 'known'); assert.equal(expensive.costYuan, 0.7);
  assert.equal(c.getSupplierExpense(openluxHold.holdId, a.tid).costSource.provider, 'openlux');

  // 360 实扣 0.03 元（低于参考价），用户仍付 24 积分。
  const hold360 = withPlatformProvider('360', () => c.holdCredits({ userId: a.uid, kind: 'text', model: 'deepseek/deepseek-v4-flash', feature: '统一价·360', credits: 500 }));
  const cheap = c.settleHold(hold360, { model: 'deepseek/deepseek-v4-flash', aiMode: 'api', usage: { ...usage, supplierCosts: [receipt360(0.03)] } });
  assert.equal(cheap.credits, 24); assert.equal(cheap.costYuan, 0.03); assert.equal(cheap.supplierCostStatus, 'known');

  // 回执缺失：照常按参考价结算交付，平台成本待核。
  const missing = c.holdCredits({ userId: a.uid, kind: 'text', model: 'deepseek-v4-flash', feature: '统一价·缺回执', credits: 500 });
  const pending = c.settleHold(missing, { model: 'deepseek-v4-flash', aiMode: 'api', usage });
  assert.equal(pending.credits, 24); assert.equal(pending.supplierCostStatus, 'pending'); assert.equal(pending.costYuan, null);
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', missing.holdId).status, 'settled');
  assert.equal(c.getSupplierExpense(missing.holdId, a.tid).costSource.type, 'supplier_cost_pending');
  assert.equal(balance(a), before - 24 * 3, '三笔任务各付 24 积分，预占差额已退回');

  // 回执迟到只补平台成本，不再动用户余额；重复结算返回 null。
  assert.equal(c.settleHold(missing, { model: 'deepseek-v4-flash', aiMode: 'api', usage: { ...usage, supplierCosts: [openluxReceipt(0.05)] } }), null);
  assert.equal(balance(a), before - 72);
  invariant(a);

  // 文本仍必须有真实 token，参考价不能替代用量证据。
  const noUsage = c.holdCredits({ userId: a.uid, kind: 'text', model: 'deepseek-v4-flash', feature: '统一价·缺token', credits: 50 });
  assert.throws(() => c.settleHold(noUsage, { model: 'deepseek-v4-flash', aiMode: 'api', usage: { supplierCosts: [openluxReceipt(0.01)] } }), { code: 'BILLING_USAGE_MISSING' });
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', noUsage.holdId).status, 'held');
  // 调用方自报的文本积分与参考价不一致时拒绝。
  assert.throws(() => c.settleHold(noUsage, { model: 'deepseek-v4-flash', aiMode: 'api', usage, credits: 5 }), { code: 'BILLING_FIXED_PRICE_MISMATCH' });
  c.releaseHold(noUsage, '测试释放'); invariant(a);
  disable();
});

test('图片按核实后的统一基准价收费；无成果全退、供应商成本独立保留；预占差额退回', () => {
  enable();
  const a = actor();
  const before = balance(a);
  const price = c.billing();
  assert.equal(price.image['gpt-image-2'], 0.5); assert.equal(price.image['openai/gpt-image-2'], 0.5);
  const imageCredits = Math.ceil(0.5 * 2 / 0.01);
  assert.equal(imageCredits, 100);
  const hold = c.holdCredits({ userId: a.uid, kind: 'image', model: 'gpt-image-2', feature: '统一价·图片', credits: 300 });
  const settled = c.settleHold(hold, { model: 'gpt-image-2', aiMode: 'api', credits: imageCredits, usage: { supplierCosts: [openluxReceipt(0.04)] } });
  assert.equal(settled.credits, 100); assert.equal(settled.costYuan, 0.28); assert.equal(settled.supplierCostStatus, 'known');
  assert.equal(balance(a), before - 100, '预占 300 只实扣 100');

  const failed = c.holdCredits({ userId: a.uid, kind: 'image', model: 'gpt-image-2', feature: '统一价·失败', credits: 100 });
  const refunded = c.refundHold(failed, { supplierCostYuan: 0.28, costSource: openluxReceipt(0.04).costSource });
  assert.equal(refunded.refundedCredits, 100);
  assert.equal(balance(a), before - 100, '无成果全退，用户不承担供应商费用');
  const expense = c.getSupplierExpense(failed.holdId, a.tid);
  assert.equal(expense.status, 'known'); assert.equal(expense.costYuan, 0.28); assert.ok(expense.refundedAt);
  assert.equal(c.refundHold(failed).duplicate, true);
  invariant(a);
  disable();
});

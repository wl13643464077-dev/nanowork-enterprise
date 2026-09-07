import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-terminal-refund-'));
process.env.NANOWORK_DB = path.join(directory, 'test.db');
process.env.SEED_DEMO = 'false';
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
const { db, q, qRaw, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
const { holdCredits, settleHold, releaseHold, refundHold, balanceOfTenant, getSupplierExpense } = await import('../src/engines/credits.js');
const { executeHeldDelivery, withImmediateTransaction } = await import('../src/engines/two-phase-delivery.js');
const { hasStoredAiDelivery } = await import('../src/engines/stored-ai-delivery.js');
initSchema();
migrateV2();
const tenantId = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('最终失败退款验收','已开通',10000)").lastInsertRowid);
const otherTenantId = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('独立企业','已开通',10000)").lastInsertRowid);
const userId = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('terminal-refund-actor','x','验收老板','boss',?)", tenantId).lastInsertRowid);
const otherUserId = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('terminal-refund-other','x','其他老板','boss',?)", otherTenantId).lastInsertRowid);

function hold() {
  return holdCredits({ userId, tenantId, kind: 'text', model: 'deepseek-v4-flash', feature: '最终失败退款验收', credits: 120 });
}
function storedContent(activeHold, body = '已经完整生成且可以阅读的正文') {
  return Number(q.run(`INSERT INTO contents(type,title,body,creator_id,snapshot_json)
    VALUES('员工产出','退款边界验收',?,?,?)`, body, userId, JSON.stringify({ billing: { holdId: activeHold.holdId } })).lastInsertRowid);
}
function execute(activeHold, overrides) {
  return executeHeldDelivery({ hold: activeHold, generate: async () => ({ text: '本地桩模型完整回答' }),
    persist: value => value, settle: settleHold, release: releaseHold, refund: refundHold,
    hasDeliverable: () => hasStoredAiDelivery(activeHold),
    settlement: { usage: { inputTokens: 100, outputTokens: 50 }, aiMode: 'api', model: 'deepseek-v4-flash' }, ...overrides });
}

test('最终文本异常无结果：用户全退、供应商费用pending、重复退款幂等且不串租户', async () => runWithTenant(tenantId, async () => {
  const before = balanceOfTenant(tenantId);
  const otherBefore = balanceOfTenant(otherTenantId);
  const activeHold = hold();
  // An old result and a different tenant's matching JSON are not this output.
  storedContent({ holdId: activeHold.holdId + 100000 });
  qRaw.run(`INSERT INTO contents(tenant_id,type,title,body,creator_id,snapshot_json)
    VALUES(?,'员工产出','他企成果','不能串线',?,?)`, otherTenantId, otherUserId, JSON.stringify({ billing: { holdId: activeHold.holdId } }));
  await assert.rejects(execute(activeHold, { generate: async () => { throw Object.assign(new Error('本地模拟供应商返回后连接中断'), { code: 'UPSTREAM_TERMINAL_FAILURE' }); } }), error => {
    assert.equal(error.billing.state, 'released');
    assert.equal(error.billing.chargedCredits, 0);
    return true;
  });
  assert.equal(balanceOfTenant(tenantId), before);
  assert.equal(balanceOfTenant(otherTenantId), otherBefore);
  const expense = getSupplierExpense(activeHold.holdId, tenantId);
  assert.equal(expense.status, 'pending', '不能把供应商未知费用伪造为0');
  assert.equal(Number(expense.refundedCredits), 120);
  assert.equal(refundHold(activeHold).duplicate, true);
  assert.equal(balanceOfTenant(tenantId), before);
}));

test('正文事务后置失败：正文回滚后全退，不能因进入persist而保留占扣', async () => runWithTenant(tenantId, async () => {
  const before = balanceOfTenant(tenantId);
  const activeHold = hold();
  let insertedId;
  await assert.rejects(execute(activeHold, { persist: () => withImmediateTransaction(db, () => {
    insertedId = storedContent(activeHold);
    throw new Error('注入审批/引用事务失败');
  }) }), error => { assert.equal(error.billing.state, 'released'); return true; });
  assert.equal(q.get('SELECT id FROM contents WHERE tenant_id=? AND id=?', tenantId, insertedId), undefined);
  assert.equal(balanceOfTenant(tenantId), before);
  assert.equal(getSupplierExpense(activeHold.holdId, tenantId).status, 'pending');
}));

test('已经落库正文后回执异常：保留正文和待结算占扣，不因最终异常误退', async () => runWithTenant(tenantId, async () => {
  const before = balanceOfTenant(tenantId);
  const activeHold = hold();
  let contentId;
  await assert.rejects(execute(activeHold, { persist: () => {
    contentId = storedContent(activeHold);
    throw new Error('注入已提交后的回执异常');
  } }), error => { assert.equal(error.billing.state, 'pending_reconciliation'); return true; });
  assert.equal(hasStoredAiDelivery(activeHold), true);
  assert.match(q.get('SELECT body FROM contents WHERE tenant_id=? AND id=?', tenantId, contentId).body, /完整生成/);
  assert.equal(q.get('SELECT status FROM credit_holds WHERE tenant_id=? AND id=?', tenantId, activeHold.holdId).status, 'held');
  assert.equal(balanceOfTenant(tenantId), before - 120);
  assert.equal(getSupplierExpense(activeHold.holdId, tenantId), null);
}));

test('仅进入执行中并不退款，正常结果完成后仍只按本次费用结算', async () => runWithTenant(tenantId, async () => {
  const before = balanceOfTenant(tenantId);
  const activeHold = hold();
  let finish;
  const pending = execute(activeHold, { generate: () => new Promise(resolve => { finish = resolve; }),
    persist: output => ({ id: storedContent(activeHold, output.text) }) });
  assert.equal(balanceOfTenant(tenantId), before - 120);
  assert.equal(getSupplierExpense(activeHold.holdId, tenantId), null);
  finish({ text: '等待完成后真正交付的正文' });
  const result = await pending;
  assert.equal(result.billing.state, 'settled', JSON.stringify(result.billing));
  assert.ok(result.billing.chargedCredits > 0 && result.billing.chargedCredits <= 120);
  assert.equal(balanceOfTenant(tenantId), before - result.billing.chargedCredits);
}));

after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

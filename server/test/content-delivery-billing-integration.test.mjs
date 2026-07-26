import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DBP = path.join(os.tmpdir(), `nanowork-content-delivery-billing-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';

const { db, qRaw, initSchema, migrateV2 } = await import('../src/db.js');
const {
  balanceOfTenant,
  creditTenant,
  holdCredits,
  releaseHold,
  settleHold,
} = await import('../src/engines/credits.js');
const {
  executeHeldDelivery,
  withImmediateTransaction,
} = await import('../src/engines/two-phase-delivery.js');

initSchema();
migrateV2();
db.exec(`CREATE TABLE delivery_probe(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  value TEXT NOT NULL
)`);

const tenantId = Number(qRaw.run(
  "INSERT INTO tenants(name,status,credits) VALUES('内容计费验收企业','已开通',0)",
).lastInsertRowid);
const userId = Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,tenant_id)
   VALUES('content-billing-u','x','内容计费用户','boss',?)`,
  tenantId,
).lastInsertRowid);

const balance = () => balanceOfTenant(tenantId);
const held = () => Number(db.prepare(
  `SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=? AND status='held'`,
).get(tenantId)?.n || 0);
const setBalance = target => {
  const delta = target - balance();
  if (delta) creditTenant({
    tenantId,
    delta,
    userId,
    feature: '专项测试调账',
    note: '仅用于两阶段计费专项测试',
  });
};

test('内容入口并发占扣共享余额且绝不超卖', async () => {
  setBalance(100);
  const results = await Promise.allSettled(Array.from({ length: 5 }, async (_, index) => {
    await new Promise(resolve => setImmediate(resolve));
    return holdCredits({
      userId,
      feature: `内容入口并发#${index}`,
      kind: 'text',
      model: 'deepseek-v4-flash',
      credits: 30,
    });
  }));
  const successes = results.filter(item => item.status === 'fulfilled');
  const failures = results.filter(item => item.status === 'rejected');
  assert.equal(successes.length, 3);
  assert.equal(failures.length, 2);
  assert.ok(failures.every(item => item.reason.status === 402));
  assert.equal(balance(), 10);
  assert.equal(held(), 3);
  for (const item of successes) releaseHold(item.value, '并发占扣专项测试释放');
  assert.equal(balance(), 100);
  assert.equal(held(), 0);
});

test('供应商失败与业务落库失败都完整退款，落库事务不留半成品', async () => {
  setBalance(100);

  const upstreamHold = holdCredits({
    userId,
    feature: '内容生成失败专项',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 25,
  });
  await assert.rejects(executeHeldDelivery({
    hold: upstreamHold,
    generate: async () => { throw new Error('injected provider failure'); },
    persist: () => assert.fail('供应商失败不得落库'),
    settle: settleHold,
    release: releaseHold,
  }), error => error.billing?.state === 'released');
  assert.equal(balance(), 100);
  assert.equal(held(), 0);

  const persistHold = holdCredits({
    userId,
    feature: '内容落库失败专项',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 25,
  });
  await assert.rejects(executeHeldDelivery({
    hold: persistHold,
    generate: async () => ({
      text: '供应商已返回但尚未交付',
      usage: { inputTokens: 10, outputTokens: 10 },
      model: 'deepseek-v4-flash',
      mode: 'api',
    }),
    persist: () => withImmediateTransaction(db, () => {
      db.prepare('INSERT INTO delivery_probe(value) VALUES(?)').run('必须回滚');
      throw new Error('injected persistence failure');
    }),
    settle: settleHold,
    release: releaseHold,
  }), error => error.billing?.state === 'released');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_probe').get().n, 0);
  assert.equal(balance(), 100);
  assert.equal(held(), 0);
});

test('业务已交付但结算异常时保留预授权待对账，不虚构实扣', async () => {
  setBalance(100);
  const itemHold = holdCredits({
    userId,
    feature: '内容结算异常专项',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 25,
  });
  const result = await executeHeldDelivery({
    hold: itemHold,
    generate: async () => ({
      text: '已交付内容',
      usage: { inputTokens: 10, outputTokens: 10 },
      model: 'deepseek-v4-flash',
      mode: 'api',
    }),
    persist: output => withImmediateTransaction(db, () => {
      const inserted = db.prepare('INSERT INTO delivery_probe(value) VALUES(?)').run(output.text);
      return { id: Number(inserted.lastInsertRowid) };
    }),
    settle: () => { throw new Error('injected settlement failure'); },
    release: releaseHold,
    settlement: output => ({
      usage: output.usage,
      model: output.model,
      aiMode: output.mode,
    }),
  });
  assert.equal(result.billing.state, 'pending_reconciliation');
  assert.equal(result.billing.chargedCredits, null);
  assert.equal(result.billing.credits, null);
  assert.equal(result.billing.heldCredits, 25);
  assert.equal(db.prepare('SELECT value FROM delivery_probe WHERE id=?').get(result.delivery.id).value, '已交付内容');
  assert.equal(balance(), 75);
  assert.equal(held(), 1);

  // 专项测试收尾：真实系统会由对账任务处理这笔 held。
  releaseHold(itemHold, '专项测试清理待对账占扣');
  assert.equal(balance(), 100);
  assert.equal(held(), 0);
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
  }
});

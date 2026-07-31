import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DBP = path.join(os.tmpdir(), `nanowork-credits-authority-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* fresh database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';

const { db, initSchema, migrateV2, qRaw } = await import('../src/db.js');
const {
  balanceOfTenant,
  creditTenant,
  holdCredits,
  releaseHold,
  settleHold,
} = await import('../src/engines/credits.js');

initSchema();
migrateV2();

function createTenant(name, username) {
  const tenantId = Number(qRaw.run(
    `INSERT INTO tenants(name,status,credits,total_recharged)
     VALUES(?,'已开通',0,0)`,
    name,
  ).lastInsertRowid);
  const userId = Number(qRaw.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
     VALUES(?,'x',?,'boss','启用',?)`,
    username,
    `${name}老板`,
    tenantId,
  ).lastInsertRowid);
  creditTenant({
    tenantId,
    delta: 1000,
    userId,
    feature: '专项测试充值',
  });
  return { tenantId, userId };
}

const tenantA = createTenant('权威结算企业A', 'credits-authority-a');
const tenantB = createTenant('权威结算企业B', 'credits-authority-b');

function ledgerSnapshot(tenantId) {
  return {
    balance: balanceOfTenant(tenantId),
    sum: Number(db.prepare(
      'SELECT COALESCE(SUM(credits),0) total FROM credit_logs WHERE tenant_id=?',
    ).get(tenantId).total),
    holds: db.prepare(
      `SELECT id,tenant_id,log_id,held_credits,settled_credits,status
       FROM credit_holds WHERE tenant_id=? ORDER BY id`,
    ).all(tenantId),
    logs: db.prepare(
      `SELECT id,tenant_id,credits,balance_after,ai_mode
       FROM credit_logs WHERE tenant_id=? ORDER BY id`,
    ).all(tenantId),
  };
}

function assertLedgerInvariant(tenantId) {
  const snapshot = ledgerSnapshot(tenantId);
  assert.equal(snapshot.balance, -snapshot.sum, `租户${tenantId}余额必须等于流水合计的相反数`);
}

test('结算只使用数据库权威行，伪造租户、流水或占扣金额均安全失败', () => {
  const holdA = holdCredits({
    userId: tenantA.userId,
    feature: '权威结算A',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 100,
    refType: 'authority_probe',
    refId: 1,
  });
  const holdB = holdCredits({
    userId: tenantB.userId,
    feature: '权威结算B',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 80,
    refType: 'authority_probe',
    refId: 1,
  });
  const beforeA = ledgerSnapshot(tenantA.tenantId);
  const beforeB = ledgerSnapshot(tenantB.tenantId);

  const forged = [
    { ...holdA, tenantId: tenantB.tenantId },
    { ...holdA, logId: holdB.logId },
    { ...holdA, credits: holdA.credits + 999 },
    { ...holdA, userId: tenantB.userId },
    { ...holdA, kind: 'video' },
  ];
  for (const fake of forged) {
    assert.throws(
      () => settleHold(fake, { credits: 30, note: '伪造结算必须失败' }),
      error => error?.status === 409 && error?.code === 'CREDIT_HOLD_INTEGRITY_MISMATCH',
    );
    assert.deepEqual(ledgerSnapshot(tenantA.tenantId), beforeA);
    assert.deepEqual(ledgerSnapshot(tenantB.tenantId), beforeB);
  }
  assert.throws(
    () => releaseHold({ ...holdA, tenantId: tenantB.tenantId }, '伪造退款必须失败'),
    error => error?.status === 409 && error?.code === 'CREDIT_HOLD_INTEGRITY_MISMATCH',
  );
  assert.deepEqual(ledgerSnapshot(tenantA.tenantId), beforeA);
  assert.deepEqual(ledgerSnapshot(tenantB.tenantId), beforeB);

  const settled = settleHold(holdA, { credits: 30, note: '权威行正常结算' });
  assert.equal(settled.credits, 30);
  assert.equal(balanceOfTenant(tenantA.tenantId), beforeA.balance + 70);
  assert.equal(balanceOfTenant(tenantB.tenantId), beforeB.balance);
  assertLedgerInvariant(tenantA.tenantId);
  assertLedgerInvariant(tenantB.tenantId);

  const terminalA = ledgerSnapshot(tenantA.tenantId);
  const terminalB = ledgerSnapshot(tenantB.tenantId);
  assert.equal(settleHold(holdA, { credits: 999 }), null);
  assert.equal(releaseHold(holdA, '重复终态释放必须幂等'), null);
  assert.deepEqual(ledgerSnapshot(tenantA.tenantId), terminalA);
  assert.deepEqual(ledgerSnapshot(tenantB.tenantId), terminalB);

  releaseHold(holdB, '专项测试清理');
  assertLedgerInvariant(tenantA.tenantId);
  assertLedgerInvariant(tenantB.tenantId);
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
});

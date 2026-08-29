import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// This is a database-authority test only.  It seeds settled/held ledger rows
// directly and never invokes an image/material provider.
const dbPath = path.join(
  os.tmpdir(),
  `nanowork-content-employee-delivery-authority-${process.pid}.db`,
);
for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* fresh test database */ }
}
process.env.NANOWORK_DB = dbPath;
process.env.SEED_DEMO = 'false';
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { db, initSchema, migrateV2, qRaw } = await import('../src/db.js');
const { holdCredits, settleHold } = await import('../src/engines/credits.js');
const { loadContentEmployeeRunAuthority } = await import('../src/engines/delivery-state.js');

initSchema();
migrateV2();

const tenantId = Number(qRaw.run(
  `INSERT INTO tenants(name,status,credits) VALUES('内容员工账务权威验收企业','已开通',1000)`,
).lastInsertRowid);
const userId = Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,dept,status,tenant_id)
   VALUES('content-authority-owner','x','内容验收老板','boss','老板办','启用',?)`,
  tenantId,
).lastInsertRowid);

function createRun() {
  const result = qRaw.run(`INSERT INTO content_employee_runs(
    tenant_id,employee_idx,employee_key,employee_name,employee_group,title,type,
    requirement,status,result_md,ai_mode,model,profile_version,prompt_hash,
    snapshot_json,created_by
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  tenantId, 5, 'content-cover', '测试员工', '内容生产', '账务权威测试', '测试',
  '', '待审阅', '已生成的真实业务正文', 'api', 'test-model', 'profile-v1',
  'a'.repeat(64), '{}', userId);
  return Number(result.lastInsertRowid);
}

function settleTextHold(runId) {
  const hold = holdCredits({
    tenantId,
    userId,
    feature: '内容员工单派·测试员工',
    kind: 'text',
    model: 'test-model',
    credits: 20,
    refType: 'content_employee_run',
    refId: runId,
  });
  const settled = settleHold(hold, {
    credits: 20,
    model: 'test-model',
    aiMode: 'api',
    usage: { inputTokens: 10, outputTokens: 20 },
  });
  assert.equal(settled.credits, 20);
  return hold;
}

function prepareSnapshot(runId, providerState = 'settled') {
  const textHold = settleTextHold(runId);
  const providerRefId = 900000 + runId;
  const providerHold = holdCredits({
    tenantId,
    userId,
    feature: '内容员工真实图片Provider',
    kind: 'image',
    model: 'gpt-image-2',
    credits: 7,
    refType: 'content_special_provider',
    refId: providerRefId,
  });
  let providerCharged = null;
  if (providerState === 'settled') {
    providerCharged = settleHold(providerHold, {
      credits: 7,
      model: 'gpt-image-2',
      aiMode: 'api',
    }).credits;
  }
  const primaryBilling = {
    state: 'settled',
    holdId: Number(textHold.holdId),
    estimatedCredits: 20,
    heldCredits: 0,
    chargedCredits: 20,
    credits: 20,
  };
  const providerBilling = providerState === 'settled'
    ? {
        state: 'settled',
        holdId: Number(providerHold.holdId),
        estimatedCredits: 7,
        heldCredits: 0,
        chargedCredits: providerCharged,
        credits: providerCharged,
      }
    : {
        state: 'pending_reconciliation',
        holdId: Number(providerHold.holdId),
        estimatedCredits: 7,
        heldCredits: 7,
        chargedCredits: null,
        credits: null,
        pendingReconciliation: true,
      };
  const billing = {
    state: providerState === 'settled' ? 'settled' : 'pending_reconciliation',
    estimatedCredits: 27,
    heldCredits: providerState === 'settled' ? 0 : 7,
    chargedCredits: providerState === 'settled' ? 27 : null,
    credits: providerState === 'settled' ? 27 : null,
    pendingReconciliation: providerState !== 'settled',
    components: {
      text: primaryBilling,
      specialProviders: [{
        attemptId: `content-special-provider:pipeline:${runId}`,
        kind: 'image',
        status: providerState,
        refType: 'content_special_provider',
        refId: providerRefId,
        holdId: Number(providerHold.holdId),
        billing: providerBilling,
      }],
    },
  };
  qRaw.run(`UPDATE content_employee_runs SET snapshot_json=? WHERE tenant_id=? AND id=?`,
    JSON.stringify({
      contract: { valid: true },
      internalProfileLeakage: { detected: false },
      providerAttempt: {
        mode: 'api',
        model: 'test-model',
        usage: { inputTokens: 10, outputTokens: 20 },
      },
      billing,
    }), tenantId, runId);
}

after(() => {
  try { db.close(); } catch { /* test process may already be closed */ }
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
});

test('内容员工文本主hold与专项provider账务逐笔核对：settled可验证，pending阻断', () => {
  const settledRunId = createRun();
  prepareSnapshot(settledRunId, 'settled');
  const settled = loadContentEmployeeRunAuthority(settledRunId, { tenantId });
  assert.equal(settled.verified, true);
  assert.equal(settled.billingState, 'settled');
  assert.equal(settled.chargedCredits, 27);
  assert.equal(settled.pendingReconciliation, false);

  const pendingRunId = createRun();
  prepareSnapshot(pendingRunId, 'pending_reconciliation');
  const pending = loadContentEmployeeRunAuthority(pendingRunId, { tenantId });
  assert.equal(pending.verified, false);
  assert.equal(pending.billingState, 'pending_reconciliation');
  assert.equal(pending.chargedCredits, 0);
  assert.equal(pending.pendingReconciliation, true);
});

test('专项provider已逐笔结算但总账被篡改时，不会拿合计去冒充文本主hold', () => {
  const runId = createRun();
  prepareSnapshot(runId, 'settled');
  const row = db.prepare('SELECT snapshot_json FROM content_employee_runs WHERE tenant_id=? AND id=?').get(tenantId, runId);
  const snapshot = JSON.parse(row.snapshot_json);
  snapshot.billing.chargedCredits = 999;
  qRaw.run('UPDATE content_employee_runs SET snapshot_json=? WHERE tenant_id=? AND id=?',
    JSON.stringify(snapshot), tenantId, runId);
  const authority = loadContentEmployeeRunAuthority(runId, { tenantId });
  assert.equal(authority.verified, false);
  assert.equal(authority.billingState, 'pending_reconciliation');
  assert.equal(authority.chargedCredits, 0);
});

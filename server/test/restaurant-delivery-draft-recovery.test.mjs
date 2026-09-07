import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { inspectDraftRecovery, recoverDraftCopy } from '../../scripts/recover-restaurant-delivery-drafts.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-draft-recovery-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourceDirectory = path.join(directory, 'source');
  fs.mkdirSync(sourceDirectory);
  const source = path.join(sourceDirectory, 'nanowork-isolated.db');
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE agent_tasks(id INTEGER PRIMARY KEY, marshal_id INTEGER, output_id INTEGER, created_by INTEGER, tenant_id INTEGER, status TEXT, fail_reason TEXT, employee_web_snapshot TEXT);
    CREATE TABLE contents(id INTEGER PRIMARY KEY, creator_id INTEGER, tenant_id INTEGER, status TEXT, ai_mode TEXT, body TEXT);
    CREATE TABLE marshals(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE credit_holds(id INTEGER PRIMARY KEY, tenant_id INTEGER, user_id INTEGER, log_id INTEGER, feature TEXT, kind TEXT, model TEXT, held_credits INTEGER, settled_credits INTEGER, status TEXT, ref_type TEXT, ref_id INTEGER);
    CREATE TABLE credit_logs(id INTEGER PRIMARY KEY, tenant_id INTEGER, user_id INTEGER, feature TEXT, kind TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_yuan REAL, credits INTEGER, ai_mode TEXT);
    CREATE TABLE approvals(id INTEGER PRIMARY KEY, status TEXT);
    INSERT INTO marshals VALUES(1, '测试餐饮部');
    INSERT INTO credit_holds VALUES(21,1,7,31,'员工任务·测试餐饮部','text','original-model',100,20,'settled','agent_task',11);
    INSERT INTO credit_logs VALUES(31,1,7,'员工任务·测试餐饮部','text','executed-model',150,80,0.1,20,'api');
    INSERT INTO contents VALUES(41,7,1,'草稿','api','真实保留原文，等待老板阅读与核对。');`);
  const body = db.prepare('SELECT body FROM contents').get().body;
  const usage = { inputTokens: 150, outputTokens: 80 };
  const override = { requested: 'original-model', effective: 'executed-model', reason: 'acceptance_stability_override' };
  const execution = {
    providerAttempt: { mode: 'api', model: 'executed-model', requestedModel: 'executed-model', effectiveModel: 'executed-model', usage, acceptanceModelOverride: override },
    outputContract: { valid: true, requestedModel: 'executed-model', effectiveModel: 'executed-model', renderedBodySha256: hash(body),
      hardDelivery: { valid: true, provider: { mode: 'api', model: 'executed-model', usage } },
      providerAttempts: [{ mode: 'api', model: 'executed-model', succeeded: true, usage }], warnings: ['事实仍待人工核对'] },
    internalProfileLeakage: { detected: false, outputHash: hash(body) },
    failure: { code: 'EMPLOYEE_GENERATION_FAILED', category: 'execution_exception', message: '自动采用数字员工产出被阻止：内容已完成技术生成，但积分仍待账务对账，当前业务暂不可采用，也不能进入发布' },
  };
  db.prepare("INSERT INTO agent_tasks VALUES(11,1,41,7,1,'失败',NULL,?)").run(JSON.stringify(execution));
  const matrix = { jobs: { 'restaurant:101': { latest: {
    domain: 'restaurant', terminalStatus: '失败', businessId: 11, outputId: 41, tenantId: 1, userId: 7,
    billingId: 21, creditLogId: 31, billingHoldLogId: 31, billingHoldModel: 'original-model', creditLogModel: 'executed-model',
    heldCredits: 100, settledCredits: 20, chargedCredits: 20, chargedCostYuan: 0.1, inputTokens: 150, outputTokens: 80,
    billingState: 'settled', serverRenderedBodyHash: hash(body), acceptanceModelOverride: override,
  } } } };
  fs.writeFileSync(path.join(sourceDirectory, 'real-employee-matrix.json'), JSON.stringify(matrix));
  const root = path.join(directory, 'recovery');
  return { db, source, sourceDirectory, root, matrix, execution, body };
}

test('default dry-run creates only private evidence, leaves source byte-for-byte unchanged', t => {
  const f = fixture(t);
  f.db.close();
  const before = hash(fs.readFileSync(f.source));
  const r = recoverDraftCopy({ sourceDirectory: f.sourceDirectory, root: f.root });
  assert.equal(r.mode, 'dry_run');
  assert.equal(r.eligibleCount, 1);
  assert.equal(r.recoveredCount, 0);
  assert.equal(r.copyPath, null);
  assert.equal(hash(fs.readFileSync(f.source)), before);
  const artifacts = fs.readdirSync(r.outputDirectory);
  assert.deepEqual(artifacts.sort(), ['original-task-snapshots.jsonl', 'recovery-report.json', 'review-index.md']);
  if (process.platform !== 'win32') for (const name of artifacts) assert.equal(fs.statSync(path.join(r.outputDirectory, name)).mode & 0o777, 0o600);
});

test('apply restores a reviewable draft only in a new copy, preserves payment, original text, warnings and prior failure', t => {
  const f = fixture(t);
  const originalTask = f.db.prepare('SELECT * FROM agent_tasks').get();
  const originalHold = f.db.prepare('SELECT * FROM credit_holds').get();
  const originalLedger = f.db.prepare('SELECT * FROM credit_logs').get();
  f.db.close();
  const before = hash(fs.readFileSync(f.source));
  const outputDirectory = path.join(f.root, 'applied');
  const r = recoverDraftCopy({ sourceDirectory: f.sourceDirectory, root: f.root, outputDirectory, apply: true });
  assert.equal(r.recoveredCount, 1);
  assert.equal(r.billingBindingPassedCount, 0);
  assert.equal(r.pendingModelReconciliationCount, 1);
  assert.equal(hash(fs.readFileSync(f.source)), before);
  const copy = new DatabaseSync(r.copyPath, { readOnly: true });
  try {
    const task = copy.prepare('SELECT * FROM agent_tasks').get();
    const execution = JSON.parse(task.employee_web_snapshot);
    assert.equal(task.status, '待审阅');
    assert.equal(execution.failure, undefined);
    assert.deepEqual(execution.deliveryRecovery.originalFailure, f.execution.failure);
    assert.equal(execution.deliveryRecovery.billingBindingValid, false);
    assert.equal(execution.deliveryRecovery.billingState, 'pending_reconciliation');
    assert.equal(execution.deliveryRecovery.autoAdopted, false);
    assert.deepEqual(execution.outputContract, f.execution.outputContract);
    assert.deepEqual(execution.providerAttempt, f.execution.providerAttempt);
    assert.deepEqual(copy.prepare('SELECT * FROM credit_holds').get(), originalHold);
    assert.deepEqual(copy.prepare('SELECT * FROM credit_logs').get(), originalLedger);
    assert.equal(copy.prepare('SELECT count(*) n FROM approvals').get().n, 0);
    const content = copy.prepare('SELECT * FROM contents').get();
    assert.equal(content.status, '草稿');
    assert.equal(content.body, f.body);
    assert.match(fs.readFileSync(path.join(outputDirectory, 'drafts/11.md'), 'utf8'), /历史模型绑定仍待对账/);
    const snapshot = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'original-task-snapshots.jsonl'), 'utf8'));
    assert.deepEqual(snapshot.task, { ...originalTask });
  } finally { copy.close(); }
  assert.throws(() => recoverDraftCopy({ sourceDirectory: f.sourceDirectory, root: f.root, outputDirectory, apply: true }), /overwrite/);
});

test('a recorded zero-token transport error is retained and is not counted as a paid successful API result', t => {
  const f = fixture(t);
  f.execution.outputContract.providerAttempts.unshift({ mode: 'error', model: 'executed-model', budgetClass: 'transport',
    apiObtained: false, succeeded: false, failure: { code: 'provider_timeout' }, usage: { inputTokens: 0, outputTokens: 0 } });
  f.db.prepare('UPDATE agent_tasks SET employee_web_snapshot=?').run(JSON.stringify(f.execution));
  const [row] = inspectDraftRecovery(f.db, f.matrix);
  assert.equal(row.report.eligibleForDraftReview, true);
  assert.equal(row.report.recordedZeroUsageTransportFailures, 1);
  f.db.close();
});

for (const [name, corrupt, reason] of [
  ['token', f => f.db.exec('UPDATE credit_logs SET output_tokens=81'), 'execution_usage_mismatch'],
  ['amount', f => f.db.exec('UPDATE credit_logs SET credits=21'), 'settlement_amount_mismatch'],
  ['owner', f => f.db.exec('UPDATE credit_logs SET user_id=8'), 'owner_mismatch'],
  ['tenant', f => f.db.exec('UPDATE credit_holds SET tenant_id=2'), 'tenant_mismatch'],
  ['body', f => f.db.exec("UPDATE contents SET body='被更改的内容'"), 'output_integrity_or_contract_mismatch'],
  ['missing override', f => { delete f.execution.providerAttempt.acceptanceModelOverride; f.db.prepare('UPDATE agent_tasks SET employee_web_snapshot=?').run(JSON.stringify(f.execution)); }, 'acceptance_override_mismatch'],
  ['matrix', f => { f.matrix.jobs['restaurant:101'].latest.chargedCostYuan = 0.2; fs.writeFileSync(path.join(f.sourceDirectory, 'real-employee-matrix.json'), JSON.stringify(f.matrix)); }, 'matrix_and_database_evidence_mismatch'],
  ['duplicate hold', f => f.db.exec("INSERT INTO credit_holds SELECT 22,tenant_id,user_id,log_id,feature,kind,model,held_credits,settled_credits,status,ref_type,ref_id FROM credit_holds WHERE id=21"), 'missing_or_ambiguous_source_evidence'],
]) {
  test(`${name} mismatch remains failed and unmodified even when --apply is requested`, t => {
    const f = fixture(t);
    corrupt(f);
    const before = f.db.prepare('SELECT * FROM agent_tasks').get();
    const [row] = inspectDraftRecovery(f.db, f.matrix);
    assert.equal(row.report.eligibleForDraftReview, false);
    assert.ok(row.report.reasons.includes(reason), row.report.reasons.join(', '));
    f.db.close();
    const r = recoverDraftCopy({ sourceDirectory: f.sourceDirectory, root: f.root, apply: true });
    assert.equal(r.recoveredCount, 0);
    const copy = new DatabaseSync(r.copyPath, { readOnly: true });
    try { assert.deepEqual(copy.prepare('SELECT * FROM agent_tasks').get(), before); }
    finally { copy.close(); }
  });
}

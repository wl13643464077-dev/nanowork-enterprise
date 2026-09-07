import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPrivateArtifact, writePrivateArtifact, assertPrivateArtifact } from '../server/src/engines/private-artifact.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const recoveryRoot = path.join(projectRoot, 'artifacts/acceptance-2026-09-05/recovered-copy');
export const defaultSourceDirectory = path.join(projectRoot, 'artifacts/real-matrix-runtime/NanoWork-全功能真实验收-20260905T010000Z');
const historicalFailure = '自动采用数字员工产出被阻止：内容已完成技术生成，但积分仍待账务对账，当前业务暂不可采用，也不能进入发布';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const sameUsage = (usage, ledger) => usage?.inputTokens === ledger.input_tokens && usage?.outputTokens === ledger.output_tokens;

function fingerprints(db) {
  return Object.fromEntries(['credit_holds', 'credit_logs', 'approvals'].map(table => [table,
    sha256(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())),
  ]));
}

function fileFingerprints(directory) {
  return Object.fromEntries(['nanowork-isolated.db', 'nanowork-isolated.db-wal', 'real-employee-matrix.json']
    .filter(name => fs.existsSync(path.join(directory, name)))
    .map(name => [name, sha256(fs.readFileSync(path.join(directory, name)))]));
}

function checkPath(target, root) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Recovery artifacts must be inside the isolated recovery directory');
  let current = target;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Recovery paths must not contain symlinks');
    current = path.dirname(current);
  }
}

// This is deliberately a historical-evidence check, not a replacement for the
// application's stricter employeeModelSettlementBindingValid admission gate.
export function inspectDraftRecovery(db, matrix) {
  const candidates = Object.entries(matrix.jobs || {}).filter(([key, job]) =>
    key.startsWith('restaurant:') && job.latest?.domain === 'restaurant' && job.latest?.terminalStatus === '失败');
  const seen = new Set();
  return candidates.map(([employeeId, { latest: recorded }]) => {
    const reasons = [];
    const check = (pass, reason) => { if (!pass) reasons.push(reason); };
    const task = db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(recorded.businessId);
    const output = task && db.prepare('SELECT * FROM contents WHERE id=?').get(task.output_id);
    const holds = task ? db.prepare("SELECT * FROM credit_holds WHERE ref_type='agent_task' AND ref_id=? ORDER BY id").all(task.id) : [];
    const hold = holds.length === 1 ? holds[0] : null;
    const ledger = hold && db.prepare('SELECT * FROM credit_logs WHERE id=?').get(hold.log_id);
    let execution;
    try { execution = JSON.parse(task?.employee_web_snapshot || 'null'); } catch { /* Report invalid evidence, never synthesize it. */ }
    const report = { employeeId, taskId: recorded.businessId, outputId: output?.id || null, holdId: hold?.id || null,
      logId: ledger?.id || null, eligibleForDraftReview: false, reasons, billingBindingValid: false,
      unresolved: ['acceptance_model_override_binding_requires_reconciliation'], autoAdopted: false };
    check(!seen.has(recorded.businessId), 'duplicate_matrix_task');
    seen.add(recorded.businessId);
    check(Boolean(task && output && hold && ledger && execution), 'missing_or_ambiguous_source_evidence');
    if (!task || !output || !hold || !ledger || !execution) return { report, original: null };
    const contract = execution.outputContract || {}, provider = execution.providerAttempt || {};
    const override = provider.acceptanceModelOverride || {};
    const marshal = db.prepare('SELECT name FROM marshals WHERE id=?').get(task.marshal_id);
    const bodyHash = sha256(output.body || '');
    check(task.status === '失败' && output.status === '草稿', 'unexpected_delivery_status');
    check(output.id === recorded.outputId && task.fail_reason == null && !execution.deliveryRecovery, 'changed_or_previously_recovered_task');
    check(execution.failure?.code === 'EMPLOYEE_GENERATION_FAILED' && execution.failure?.category === 'execution_exception'
      && execution.failure?.message === historicalFailure, 'failure_is_not_known_post_delivery_billing_exception');
    check(task.tenant_id === output.tenant_id && task.tenant_id === hold.tenant_id && task.tenant_id === ledger.tenant_id
      && task.tenant_id === recorded.tenantId, 'tenant_mismatch');
    check(task.created_by === output.creator_id && task.created_by === hold.user_id && task.created_by === ledger.user_id
      && task.created_by === recorded.userId, 'owner_mismatch');
    check(Boolean(marshal?.name) && hold.feature === `员工任务·${marshal?.name}` && ledger.feature === hold.feature
      && hold.kind === 'text' && ledger.kind === hold.kind, 'feature_or_kind_mismatch');
    check(hold.status === 'settled' && positiveInteger(hold.held_credits) && positiveInteger(hold.settled_credits)
      && hold.settled_credits === ledger.credits && Number.isFinite(ledger.cost_yuan) && ledger.cost_yuan > 0,
    'settlement_amount_mismatch');
    check(positiveInteger(ledger.input_tokens) && positiveInteger(ledger.output_tokens) && ledger.ai_mode === 'api'
      && provider.mode === 'api' && output.ai_mode === 'api', 'missing_real_api_usage');
    check(Boolean(hold.model) && hold.model !== ledger.model && override.requested === hold.model && override.effective === ledger.model
      && override.reason === 'acceptance_stability_override', 'acceptance_override_mismatch');
    check(provider.model === ledger.model && provider.requestedModel === ledger.model && provider.effectiveModel === ledger.model
      && contract.requestedModel === ledger.model && contract.effectiveModel === ledger.model && !provider.modelFailover
      && !contract.modelFailover, 'execution_model_mismatch');
    check(sameUsage(provider.usage, ledger) && contract.hardDelivery?.provider?.mode === 'api'
      && contract.hardDelivery?.provider?.model === ledger.model && sameUsage(contract.hardDelivery?.provider?.usage, ledger),
    'execution_usage_mismatch');
    const attempts = contract.providerAttempts || [];
    const aggregate = attempts.reduce((sum, attempt) => ({
      inputTokens: sum.inputTokens + Number(attempt.usage?.inputTokens || 0),
      outputTokens: sum.outputTokens + Number(attempt.usage?.outputTokens || 0),
    }), { inputTokens: 0, outputTokens: 0 });
    const recordedTransportFailure = attempt => attempt.budgetClass === 'transport' && attempt.apiObtained === false
      && attempt.succeeded === false && ['error', 'template'].includes(attempt.mode)
      && ['provider_timeout', 'provider_rate_limited'].includes(attempt.failure?.code)
      && attempt.usage?.inputTokens === 0 && attempt.usage?.outputTokens === 0;
    check(attempts.length > 0 && attempts.some(attempt => attempt.mode === 'api' && attempt.succeeded === true)
      && attempts.every(attempt => attempt.model === ledger.model && (attempt.mode === 'api' || recordedTransportFailure(attempt)))
      && sameUsage(aggregate, ledger), 'attempt_ledger_usage_mismatch');
    report.recordedZeroUsageTransportFailures = attempts.filter(recordedTransportFailure).length;
    check(contract.valid === true && contract.hardDelivery?.valid === true && contract.blocked !== true
      && Boolean(output.body?.trim()) && contract.renderedBodySha256 === bodyHash
      && execution.internalProfileLeakage?.detected === false && execution.internalProfileLeakage?.outputHash === bodyHash,
    'output_integrity_or_contract_mismatch');
    const bindings = {
      billingId: hold.id, creditLogId: ledger.id, billingHoldLogId: ledger.id,
      billingHoldModel: hold.model, creditLogModel: ledger.model,
      heldCredits: hold.held_credits, settledCredits: hold.settled_credits, chargedCredits: ledger.credits,
      chargedCostYuan: ledger.cost_yuan, inputTokens: ledger.input_tokens, outputTokens: ledger.output_tokens,
      billingState: 'settled', serverRenderedBodyHash: bodyHash,
    };
    check(Object.entries(bindings).every(([key, value]) => recorded[key] === value)
      && JSON.stringify(recorded.acceptanceModelOverride) === JSON.stringify(provider.acceptanceModelOverride),
    'matrix_and_database_evidence_mismatch');
    report.eligibleForDraftReview = reasons.length === 0;
    Object.assign(report, { bodySha256: bodyHash, originalTaskStatus: task.status, outputStatus: output.status,
      holdModel: hold.model, executionModel: ledger.model, inputTokens: ledger.input_tokens, outputTokens: ledger.output_tokens,
      settledCredits: ledger.credits, costYuan: ledger.cost_yuan, currentWarnings: contract.warnings || [] });
    return { report, original: { task, output, hold, ledger }, execution };
  });
}

export function recoverDraftCopy({ sourceDirectory = defaultSourceDirectory, outputDirectory, apply = false, root = recoveryRoot } = {}) {
  sourceDirectory = path.resolve(sourceDirectory);
  const source = path.join(sourceDirectory, 'nanowork-isolated.db');
  const matrixPath = path.join(sourceDirectory, 'real-employee-matrix.json');
  const sourceRoot = path.join(projectRoot, 'artifacts/real-matrix-runtime');
  // The CLI can never point at server/data or a production DB. Tests use isolated
  // fixture directories through this explicit exported runner only.
  if (root === recoveryRoot) checkPath(sourceDirectory, sourceRoot);
  const runAt = new Date().toISOString();
  outputDirectory ||= path.join(root, `${apply ? 'applied' : 'dry-run'}-${runAt.replace(/[:.]/gu, '-')}`);
  outputDirectory = path.resolve(outputDirectory);
  checkPath(outputDirectory, root);
  if (fs.existsSync(outputDirectory)) throw new Error('Refusing to overwrite an existing recovery run');
  const beforeSource = fileFingerprints(sourceDirectory);
  const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
  const db = new DatabaseSync(source, { readOnly: true });
  let rows, protectedBefore, copyPath = null;
  try {
    rows = inspectDraftRecovery(db, matrix);
    protectedBefore = fingerprints(db);
    fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    writePrivateArtifact(path.join(outputDirectory, 'original-task-snapshots.jsonl'), rows.filter(row => row.original)
      .map(row => JSON.stringify({ taskId: row.report.taskId, ...row.original })).join('\n') + '\n');
    if (apply) {
      copyPath = path.join(outputDirectory, 'nanowork-recovered-drafts.db');
      createPrivateArtifact(copyPath);
      db.prepare('VACUUM INTO ?').run(copyPath);
      assertPrivateArtifact(copyPath);
    }
  } finally { db.close(); }
  let protectedAfter = protectedBefore;
  if (apply) {
    const copy = new DatabaseSync(copyPath);
    try {
      if (copy.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Copied database integrity check failed');
      const copiedRows = inspectDraftRecovery(copy, matrix);
      if (JSON.stringify(copiedRows) !== JSON.stringify(rows) || JSON.stringify(fingerprints(copy)) !== JSON.stringify(protectedBefore)) {
        throw new Error('Source changed while copying; recovery was not applied');
      }
      copy.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows.filter(row => row.report.eligibleForDraftReview)) {
          const execution = { ...row.execution, deliveryRecovery: {
            schemaVersion: 'nanowork.historical-draft-recovery.v1', recoveredAt: runAt,
            state: 'draft_for_manual_review', billingState: 'pending_reconciliation', billingBindingValid: false,
            reason: 'historical_acceptance_model_override', originalFailure: row.execution.failure,
            originalTaskStatus: row.original.task.status, sourceBodySha256: row.report.bodySha256,
            originalSnapshotFile: 'original-task-snapshots.jsonl', autoAdopted: false, accountingChanged: false,
            note: '原文已恢复供阅读和人工核对；历史模型绑定仍待对账，未采纳、未审批、未发布。',
          } };
          delete execution.failure;
          const result = copy.prepare("UPDATE agent_tasks SET status='待审阅', employee_web_snapshot=? WHERE id=? AND status='失败' AND employee_web_snapshot=?")
            .run(JSON.stringify(execution), row.report.taskId, row.original.task.employee_web_snapshot);
          if (result.changes !== 1) throw new Error(`Task ${row.report.taskId} changed before recovery`);
        }
        protectedAfter = fingerprints(copy);
        if (JSON.stringify(protectedAfter) !== JSON.stringify(protectedBefore)) throw new Error('Accounting or approvals changed unexpectedly');
        for (const row of rows) {
          const currentTask = copy.prepare('SELECT * FROM agent_tasks WHERE id=?').get(row.report.taskId);
          const currentOutput = row.original && copy.prepare('SELECT * FROM contents WHERE id=?').get(row.report.outputId);
          if (row.original && JSON.stringify(currentOutput) !== JSON.stringify(row.original.output)) throw new Error('Original output changed');
          if (row.report.eligibleForDraftReview && currentTask.status !== '待审阅') throw new Error('Review state was not restored');
          if (!row.report.eligibleForDraftReview && row.original && JSON.stringify(currentTask) !== JSON.stringify(row.original.task)) throw new Error('Ineligible task changed');
        }
        copy.exec('COMMIT');
      } catch (error) { copy.exec('ROLLBACK'); throw error; }
    } finally { copy.close(); }
  }
  const afterSource = fileFingerprints(sourceDirectory);
  if (JSON.stringify(beforeSource) !== JSON.stringify(afterSource)) throw new Error('Historical source files changed during the run; inspect before using artifacts');
  const eligible = rows.filter(row => row.report.eligibleForDraftReview);
  const report = {
    schemaVersion: 'nanowork.historical-draft-recovery-report.v1', mode: apply ? 'apply_to_new_copy' : 'dry_run', createdAt: runAt,
    source, matrixPath, copyPath, outputDirectory, candidateCount: rows.length, eligibleCount: eligible.length,
    recoveredCount: apply ? eligible.length : 0, untouchedCount: rows.length - (apply ? eligible.length : 0),
    pendingModelReconciliationCount: rows.length, billingBindingPassedCount: 0, externalApiCalls: 0,
    sourceUnchanged: true, sourceFingerprints: beforeSource, protectedTablesUnchanged: true,
    protectedTableFingerprints: { before: protectedBefore, after: protectedAfter },
    changes: apply ? ['eligible agent_tasks.status: 失败 → 待审阅', 'move active failure into deliveryRecovery.originalFailure; append explicit unresolved recovery metadata'] : [],
    nonChanges: ['contents (including every original body)', 'credit_holds', 'credit_logs', 'approvals', 'historical matrix and source DB'],
    tasks: rows.map(row => ({ ...row.report, recovered: apply && row.report.eligibleForDraftReview })),
  };
  writePrivateArtifact(path.join(outputDirectory, 'recovery-report.json'), json(report));
  const lines = ['# 历史付费结果恢复核对', '', `模式：${apply ? '仅新隔离副本已执行' : 'dry-run，未创建或修改数据库副本'}。`, '',
    `候选 ${rows.length} 条；证据完整可恢复 ${eligible.length} 条；已恢复 ${report.recoveredCount} 条；证据异常保留原状 ${rows.length - eligible.length} 条。`, '',
    '全部候选仍需核对历史 acceptance model override 的模型绑定。恢复阅读不代表账务绑定通过、内容事实已复核、已采纳或已发布。原有质量提示保留。', '',
    '原始数据库、历史矩阵、扣费记录、预授权记录、原文、审批记录均未修改；没有调用云 API。', '',
    '| 员工 | 任务 | 结果 | 扣费积分 | 当前待核对事项 |', '| --- | --- | --- | --- | --- |'];
  if (apply) fs.mkdirSync(path.join(outputDirectory, 'drafts'), { mode: 0o700 });
  for (const row of rows) {
    const r = row.report;
    if (apply && r.eligibleForDraftReview) {
      writePrivateArtifact(path.join(outputDirectory, 'drafts', `${r.taskId}.md`),
        `> 待人工核对草稿。原任务 ${r.taskId}，原结果 ${r.outputId}。历史模型绑定仍待对账；未采纳、未发布。\n\n${row.original.output.body}\n`);
    }
    lines.push(`| ${r.employeeId} | ${r.taskId} | ${apply && r.eligibleForDraftReview ? `[待审阅原文](drafts/${r.taskId}.md)` : r.eligibleForDraftReview ? '可恢复（尚未执行）' : '保留原状'} | ${r.settledCredits ?? '未知'} | ${r.reasons.length ? r.reasons.join(', ') : `${r.holdModel} → ${r.executionModel} 模型绑定未决`} |`);
  }
  writePrivateArtifact(path.join(outputDirectory, 'review-index.md'), lines.join('\n') + '\n');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || args.length > 1) throw new Error('Usage: node scripts/recover-restaurant-delivery-drafts.mjs [--dry-run | --apply]');
    const report = recoverDraftCopy({ apply: args.includes('--apply') });
    console.log(json({ mode: report.mode, candidateCount: report.candidateCount, eligibleCount: report.eligibleCount,
      recoveredCount: report.recoveredCount, billingBindingPassedCount: report.billingBindingPassedCount,
      sourceUnchanged: report.sourceUnchanged, protectedTablesUnchanged: report.protectedTablesUnchanged,
      report: path.join(report.outputDirectory, 'recovery-report.json'), review: path.join(report.outputDirectory, 'review-index.md') }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

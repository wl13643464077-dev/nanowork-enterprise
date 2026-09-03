import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Most fixtures in this file intentionally exercise the independent Shanghai
// business schedule. Runtime stale-recovery has a dedicated non-Shanghai case
// below and must follow SQLite's localtime clock instead.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'Asia/Shanghai';

const DBP = path.join(os.tmpdir(), `nanowork-scheduler-recovery-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* fresh database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const {
  recoverStaleAiWorkAcrossTenants,
  recoverStaleAgentTasks,
  recoverStaleContentAutomationRuns,
  recoverStaleContentEmployeeRuns,
  recoverStaleMediaJobs,
  runScheduledJobs,
} = await import('../src/engines/scheduler.js');
const { creditTenant, holdCredits, releaseHold } = await import('../src/engines/credits.js');
const { createSkillLearningRun } = await import('../src/engines/employee-skill-learning.js');
const { ensureContentAutomationSpecialProviderAttemptSchema } = await import(
  '../src/routes/content.js'
);

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'调度恢复企业','已开通',10000)
  ON CONFLICT(id) DO UPDATE SET status=excluded.status,credits=excluded.credits`);
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(2,'无任务企业','已开通',10000)
  ON CONFLICT(id) DO UPDATE SET status=excluded.status,credits=excluded.credits`);

const creatorId = Number(q.run(`INSERT INTO users(
  username,password_hash,name,role,status,tenant_id
) VALUES('scheduler-owner','x','调度负责人','boss','启用',1)`).lastInsertRowid);

function insertRule({
  name,
  frequency = 'daily',
  runTime = '10:00',
  weekday = null,
  nextRunAt,
}) {
  return runWithTenant(1, () => Number(q.run(`INSERT INTO content_automation_rules(
    name,enabled,employee_idx,topic,requirement,content_type,content_count,
    frequency,run_time,weekday,approval_mode,next_run_at,last_status,last_run_at,created_by
  ) VALUES(?,1,0,'调度容错主题','仅使用已核验事实','趋势简报',1,?,?,?,'always',?,'运行中',?,?)`,
  name, frequency, runTime, weekday, nextRunAt, nextRunAt, creatorId).lastInsertRowid));
}

function insertRunning({
  ruleId,
  trigger,
  claimKey,
  scheduledFor = null,
  startedAt,
}) {
  return runWithTenant(1, () => Number(q.run(`INSERT INTO content_automation_runs(
    rule_id,trigger,claim_key,scheduled_for,status,initiated_by,started_at
  ) VALUES(?,?,?,?,'运行中',?,?)`,
  ruleId, trigger, claimKey, scheduledFor, creatorId, startedAt).lastInsertRowid));
}

function finishClaim({ runId, ruleId }) {
  return runWithTenant(1, () => {
    q.run(`UPDATE content_automation_runs SET status='成功',finished_at='2026-07-23 10:01:00'
      WHERE tenant_id=? AND id=? AND status='运行中'`, 1, runId);
    q.run(`UPDATE content_automation_rules SET last_status='成功',last_error=NULL
      WHERE tenant_id=? AND id=?`, 1, ruleId);
  });
}

function insertContentEmployeeRun({
  title,
  resultMd = null,
  aiMode = 'api',
  snapshot = resultMd ? { contract: { valid: true } } : {},
  createdAt = '2026-07-23 08:00:00',
  updatedAt = createdAt,
}) {
  return runWithTenant(1, () => Number(q.run(`INSERT INTO content_employee_runs(
    employee_idx,employee_key,employee_name,employee_group,title,type,requirement,
    status,result_md,ai_mode,profile_version,prompt_hash,snapshot_json,created_by,created_at,updated_at
  ) VALUES(0,'trend','趋势官','热点雷达部',?,'趋势简报','恢复测试',
    '生成中',?,?,'2026-07-30','scheduler-recovery-hash',?,?,?,?)`,
  title, resultMd, aiMode, JSON.stringify(snapshot), creatorId, createdAt, updatedAt).lastInsertRowid));
}

test('服务恢复会原子终止超时运行，保留下次计划且同一周期不重跑', async () => {
  const ruleId = insertRule({
    name: '重启恢复规则',
    nextRunAt: '2026-07-24 10:00:00',
  });
  const runId = insertRunning({
    ruleId,
    trigger: 'scheduled',
    claimKey: '2026-07-23 10:00:00',
    scheduledFor: '2026-07-23 10:00:00',
    startedAt: '2026-07-23 09:20:00',
  });
  let executions = 0;
  const first = runScheduledJobs(new Date('2026-07-23T02:00:00.000Z'), {
    contentAutomationRunner: async () => { executions += 1; },
  });
  await first.pending;

  assert.equal(first.clock.local, '2026-07-23 10:00:00');
  assert.equal(first.results.find(row => row.tenantId === 1).contentAutomationRecovered, 1);
  assert.equal(first.results.find(row => row.tenantId === 1).contentAutomationClaimed, 0);
  assert.equal(executions, 0);
  const run = q.get(`SELECT status,error,finished_at FROM content_automation_runs
    WHERE tenant_id=1 AND id=?`, runId);
  assert.equal(run.status, '失败');
  assert.match(run.error, /服务恢复.*未执行自动发布/u);
  assert.equal(run.finished_at, '2026-07-23 10:00:00');
  const rule = q.get(`SELECT next_run_at,last_status,last_error FROM content_automation_rules
    WHERE tenant_id=1 AND id=?`, ruleId);
  assert.equal(rule.next_run_at, '2026-07-24 10:00:00');
  assert.equal(rule.last_status, '失败');
  assert.match(rule.last_error, /安全终止/u);

  const second = runScheduledJobs(new Date('2026-07-23T02:00:10.000Z'), {
    contentAutomationRunner: async () => { executions += 1; },
  });
  await second.pending;
  assert.equal(second.results.find(row => row.tenantId === 1).contentAutomationRecovered, 0);
  assert.equal(executions, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM content_automation_runs
    WHERE tenant_id=1 AND rule_id=? AND scheduled_for='2026-07-23 10:00:00'`, ruleId).n, 1);
});

test('恢复旧任务不会覆盖同规则较新运行的最终状态', () => {
  const ruleId = insertRule({
    name: '新旧运行摘要规则',
    nextRunAt: '2026-07-24 11:00:00',
  });
  const staleRunId = insertRunning({
    ruleId,
    trigger: 'immediate',
    claimKey: 'old-immediate',
    startedAt: '2026-07-23 08:00:00',
  });
  runWithTenant(1, () => {
    q.run(`INSERT INTO content_automation_runs(
      rule_id,trigger,claim_key,status,initiated_by,started_at,finished_at
    ) VALUES(?,'immediate','new-success','成功',?,'2026-07-23 09:30:00','2026-07-23 09:31:00')`,
    ruleId, creatorId);
    q.run(`UPDATE content_automation_rules SET last_status='成功',last_error=NULL
      WHERE tenant_id=? AND id=?`, 1, ruleId);
  });

  const recovered = runWithTenant(1, () => (
    recoverStaleContentAutomationRuns(new Date('2026-07-23T02:00:00.000Z'))
  ));
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].runId, staleRunId);
  assert.equal(q.get(`SELECT status FROM content_automation_runs
    WHERE tenant_id=1 AND id=?`, staleRunId).status, '失败');
  const rule = q.get(`SELECT last_status,last_error FROM content_automation_rules
    WHERE tenant_id=1 AND id=?`, ruleId);
  assert.equal(rule.last_status, '成功');
  assert.equal(rule.last_error, null);
});

test('恢复无产出的超时内容自动化会原子释放关联预授权，并记录已退款口径', () => {
  const ruleId = insertRule({
    name: '占扣恢复规则',
    nextRunAt: '2026-07-24 12:00:00',
  });
  const runId = insertRunning({
    ruleId,
    trigger: 'immediate',
    claimKey: 'stale-held-no-output',
    startedAt: '2026-07-23 08:00:00',
  });
  const before = q.get('SELECT credits FROM tenants WHERE id=1').credits;
  const hold = holdCredits({
    userId: creatorId,
    feature: '内容自动化恢复测试',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 17,
    refType: 'content_automation_run',
    refId: runId,
  });
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, before - 17);

  const recovered = runWithTenant(1, () => (
    recoverStaleContentAutomationRuns(new Date('2026-07-23T02:00:00.000Z'))
  ));
  assert.equal(recovered.find(item => item.runId === runId)?.billingState, 'released');
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, before);
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', hold.holdId).status, 'settled');
  assert.equal(q.get('SELECT credits FROM credit_logs WHERE id=?', hold.logId).credits, 0);
  const run = q.get('SELECT status,snapshot_json FROM content_automation_runs WHERE id=?', runId);
  assert.equal(run.status, '失败');
  assert.equal(JSON.parse(run.snapshot_json).billing.state, 'released');
});

test('恢复超时内容自动化同时收口专项provider：无产物退款，已持久化产物保留待对账', () => {
  ensureContentAutomationSpecialProviderAttemptSchema();

  const releasedRuleId = insertRule({
    name: '专项provider无产物恢复规则',
    nextRunAt: '2026-07-24 12:10:00',
  });
  const releasedRunId = insertRunning({
    ruleId: releasedRuleId,
    trigger: 'immediate',
    claimKey: 'stale-special-held-no-output',
    startedAt: '2026-07-23 08:00:00',
  });
  const beforeReleased = q.get('SELECT credits FROM tenants WHERE id=1').credits;
  const mainReleasedHold = holdCredits({
    userId: creatorId,
    feature: '专项provider恢复主产物',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 11,
    refType: 'content_automation_run',
    refId: releasedRunId,
  });
  const specialReleasedHold = holdCredits({
    userId: creatorId,
    feature: '专项provider恢复图片',
    kind: 'image',
    model: 'gpt-image-2',
    credits: 13,
    refType: 'content_special_provider',
    refId: 7_771_001,
  });
  q.run(`INSERT INTO content_automation_special_provider_attempts(
    tenant_id,run_id,employee_idx,provider_kind,attempt_id,request_fingerprint,
    billing_ref_type,billing_ref_id,hold_id,status,created_by
  ) VALUES(1,?,5,'image',?,'sha256:${'1'.repeat(64)}',
    'content_special_provider',?,?, 'claimed',?)`,
  releasedRunId,
  `content-automation:pipeline:${releasedRunId}:station:5:provider:image:attempt:1`,
  7_771_001,
  specialReleasedHold.holdId,
  creatorId);

  const released = runWithTenant(1, () => (
    recoverStaleContentAutomationRuns(new Date('2026-07-23T02:00:00.000Z'))
  ));
  assert.equal(released.find(item => item.runId === releasedRunId)?.billingState, 'released');
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, beforeReleased);
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', mainReleasedHold.holdId).status, 'settled');
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', specialReleasedHold.holdId).status, 'settled');
  assert.equal(q.get(`SELECT status FROM content_automation_special_provider_attempts
    WHERE run_id=?`, releasedRunId).status, 'released');
  const releasedSnapshot = JSON.parse(q.get(`SELECT snapshot_json
    FROM content_automation_runs WHERE id=?`, releasedRunId).snapshot_json);
  assert.deepEqual(releasedSnapshot.specialProviderRecovery.releasedAttemptIds.length, 1);
  assert.equal(releasedSnapshot.billing.state, 'released');

  const pendingRuleId = insertRule({
    name: '专项provider已持久化恢复规则',
    nextRunAt: '2026-07-24 12:20:00',
  });
  const pendingRunId = insertRunning({
    ruleId: pendingRuleId,
    trigger: 'immediate',
    claimKey: 'stale-special-held-with-output',
    startedAt: '2026-07-23 08:00:00',
  });
  const beforePending = q.get('SELECT credits FROM tenants WHERE id=1').credits;
  holdCredits({
    userId: creatorId,
    feature: '专项provider已持久化主产物',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 17,
    refType: 'content_automation_run',
    refId: pendingRunId,
  });
  const specialPendingHold = holdCredits({
    userId: creatorId,
    feature: '专项provider已持久化图片',
    kind: 'image',
    model: 'gpt-image-2',
    credits: 19,
    refType: 'content_special_provider',
    refId: 7_771_002,
  });
  q.run(`INSERT INTO content_automation_special_provider_attempts(
    tenant_id,run_id,employee_idx,provider_kind,attempt_id,request_fingerprint,
    billing_ref_type,billing_ref_id,hold_id,status,output_json,delivery_json,created_by
  ) VALUES(1,?,5,'image',?,'sha256:${'2'.repeat(64)}',
    'content_special_provider',?,?,'persisted','{"images":[{"url":"https://example.test/a.png"}]}',
    '{"persisted":true,"artifactIds":["material:9001"]}',?)`,
  pendingRunId,
  `content-automation:pipeline:${pendingRunId}:station:5:provider:image:attempt:1`,
  7_771_002,
  specialPendingHold.holdId,
  creatorId);

  const pending = runWithTenant(1, () => (
    recoverStaleContentAutomationRuns(new Date('2026-07-23T02:00:00.000Z'))
  ));
  assert.equal(pending.find(item => item.runId === pendingRunId)?.billingState, 'pending_reconciliation');
  assert.equal(
    q.get('SELECT credits FROM tenants WHERE id=1').credits,
    beforePending - 19,
  );
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', specialPendingHold.holdId).status, 'held');
  assert.equal(q.get(`SELECT status FROM content_automation_special_provider_attempts
    WHERE run_id=?`, pendingRunId).status, 'pending_reconciliation');
  const pendingSnapshot = JSON.parse(q.get(`SELECT snapshot_json
    FROM content_automation_runs WHERE id=?`, pendingRunId).snapshot_json);
  assert.equal(pendingSnapshot.billing.state, 'pending_reconciliation');
  assert.equal(pendingSnapshot.billing.components.specialProviders.length, 1);
  assert.deepEqual(pendingSnapshot.specialProviderRecovery.pendingAttemptIds.length, 1);

  runWithTenant(1, () => releaseHold(specialPendingHold, '测试收尾释放待对账图片预授权'));
});

test('恢复已有产物的超时内容自动化保留预授权待对账，不自动退款', () => {
  const ruleId = insertRule({
    name: '已有产物待对账规则',
    nextRunAt: '2026-07-24 13:00:00',
  });
  const contentId = runWithTenant(1, () => Number(q.run(
    `INSERT INTO contents(type,title,body,status,creator_id)
     VALUES('趋势简报','恢复测试产物','已形成的业务产物','待审核',?)`,
    creatorId,
  ).lastInsertRowid));
  const runId = insertRunning({
    ruleId,
    trigger: 'immediate',
    claimKey: 'stale-held-with-output',
    startedAt: '2026-07-23 08:00:00',
  });
  q.run('UPDATE content_automation_runs SET content_id=? WHERE id=?', contentId, runId);
  const before = q.get('SELECT credits FROM tenants WHERE id=1').credits;
  const hold = holdCredits({
    userId: creatorId,
    feature: '内容自动化已有产物恢复测试',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 19,
    refType: 'content_automation_run',
    refId: runId,
  });

  const recovered = runWithTenant(1, () => (
    recoverStaleContentAutomationRuns(new Date('2026-07-23T02:00:00.000Z'))
  ));
  assert.equal(recovered.find(item => item.runId === runId)?.billingState, 'pending_reconciliation');
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, before - 19);
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', hold.holdId).status, 'held');
  const snapshot = JSON.parse(q.get(
    'SELECT snapshot_json FROM content_automation_runs WHERE id=?',
    runId,
  ).snapshot_json);
  assert.equal(snapshot.billing.state, 'pending_reconciliation');
  releaseHold(hold, '测试结束清理待对账占扣');
});

test('恢复超时数字员工任务：无产出原子退款，只有审阅链完整的真实产出恢复到待审阅', () => {
  const staleAt = '2026-07-23 08:00:00';
  const noOutputTaskId = runWithTenant(1, () => Number(q.run(
    `INSERT INTO agent_tasks(
      marshal_id,title,type,requirement,status,created_by,created_at,
      employee_profile_version,employee_web_snapshot
    ) VALUES(1,'无产出恢复','经营诊断','恢复测试','生成中',?,?,'restaurant-progress-test',?)`,
    creatorId,
    staleAt,
    JSON.stringify({
      kind: 'restaurant_employee_generation_progress',
      progress: {
        receivedChars: 680,
        lastActivityAt: '2026-07-23T00:00:00.000Z',
        attemptNumber: 2,
        phase: 'repair',
      },
    }),
  ).lastInsertRowid));
  const activeHeartbeatTaskId = runWithTenant(1, () => Number(q.run(
    `INSERT INTO agent_tasks(
      marshal_id,title,type,requirement,status,created_by,created_at,
      employee_profile_version,employee_web_snapshot
    ) VALUES(1,'仍有心跳的长任务','经营诊断','恢复测试','生成中',?,?,'restaurant-progress-test',?)`,
    creatorId,
    staleAt,
    JSON.stringify({
      kind: 'restaurant_employee_generation_progress',
      progress: {
        receivedChars: 9_600,
        lastActivityAt: '2026-07-23T01:59:30.000Z',
        attemptNumber: 3,
        phase: 'repair',
      },
    }),
  ).lastInsertRowid));
  const before = q.get('SELECT credits FROM tenants WHERE id=1').credits;
  const noOutputHold = holdCredits({
    userId: creatorId,
    feature: '数字员工无产出恢复测试',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 23,
    refType: 'agent_task',
    refId: noOutputTaskId,
  });

  const contentId = runWithTenant(1, () => Number(q.run(
    `INSERT INTO contents(type,title,body,status,creator_id,ai_mode)
     VALUES('员工产出','已有产出恢复','可审阅产物','待审核',?,'api')`,
    creatorId,
  ).lastInsertRowid));
  runWithTenant(1, () => q.run(`INSERT INTO approvals(
    target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id
  ) VALUES('content',?,'已有产出恢复','可审阅产物','none','[]','待审核',?)`, contentId, creatorId));
  const outputTaskId = runWithTenant(1, () => Number(q.run(
    `INSERT INTO agent_tasks(marshal_id,title,type,requirement,status,output_id,created_by,created_at)
     VALUES(1,'已有产出恢复','经营诊断','恢复测试','生成中',?,?,?)`,
    contentId,
    creatorId,
    staleAt,
  ).lastInsertRowid));
  const outputHold = holdCredits({
    userId: creatorId,
    feature: '数字员工已有产出恢复测试',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 29,
    refType: 'agent_task',
    refId: outputTaskId,
  });

  const invalidContentId = runWithTenant(1, () => Number(q.run(
    `INSERT INTO contents(type,title,body,status,creator_id,ai_mode)
     VALUES('员工产出','无效产出恢复','只是模板底稿','待审核',?,'template')`,
    creatorId,
  ).lastInsertRowid));
  const invalidTaskId = runWithTenant(1, () => Number(q.run(
    `INSERT INTO agent_tasks(marshal_id,title,type,requirement,status,output_id,created_by,created_at)
     VALUES(1,'无效产出恢复','经营诊断','恢复测试','生成中',?,?,?)`,
    invalidContentId,
    creatorId,
    staleAt,
  ).lastInsertRowid));
  const invalidHold = holdCredits({
    userId: creatorId,
    feature: '数字员工无效产出恢复测试',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 31,
    refType: 'agent_task',
    refId: invalidTaskId,
  });

  const recovered = runWithTenant(1, () => (
    recoverStaleAgentTasks(new Date('2026-07-23T02:00:00.000Z'))
  ));
  assert.equal(recovered.find(item => item.taskId === noOutputTaskId)?.billingState, 'released');
  assert.equal(recovered.find(item => item.taskId === outputTaskId)?.billingState, 'pending_reconciliation');
  assert.equal(recovered.find(item => item.taskId === invalidTaskId)?.billingState, 'pending_reconciliation');
  assert.equal(q.get('SELECT status FROM agent_tasks WHERE id=?', noOutputTaskId).status, '失败');
  const recoveredEvidence = JSON.parse(q.get(
    'SELECT employee_web_snapshot FROM agent_tasks WHERE id=?',
    noOutputTaskId,
  ).employee_web_snapshot);
  assert.equal(recoveredEvidence.kind, 'restaurant_employee_execution_evidence');
  assert.equal(recoveredEvidence.failure.code, 'EMPLOYEE_GENERATION_INTERRUPTED');
  assert.equal(recoveredEvidence.progress, undefined);
  const activeHeartbeatTask = q.get(
    'SELECT status,employee_web_snapshot FROM agent_tasks WHERE id=?',
    activeHeartbeatTaskId,
  );
  assert.equal(activeHeartbeatTask.status, '生成中');
  assert.equal(JSON.parse(activeHeartbeatTask.employee_web_snapshot).progress.receivedChars, 9_600);
  assert.equal(q.get('SELECT status FROM agent_tasks WHERE id=?', outputTaskId).status, '待审阅');
  assert.equal(q.get('SELECT status FROM agent_tasks WHERE id=?', invalidTaskId).status, '失败');
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', noOutputHold.holdId).status, 'settled');
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', outputHold.holdId).status, 'held');
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', invalidHold.holdId).status, 'held');
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, before - 29 - 31);
  releaseHold(outputHold, '测试结束清理待对账占扣');
  releaseHold(invalidHold, '测试结束清理无效产出占扣');
  q.run('DELETE FROM agent_tasks WHERE tenant_id=1 AND id=?', activeHeartbeatTaskId);
});

test('恢复超时媒体任务：无交付且无调用证据退款；已有产物待对账；供应商任务保留恢复', () => {
  const staleAt = '2026-07-23 08:00:00';
  const emptyJobId = runWithTenant(1, () => Number(q.run(
    `INSERT INTO media_jobs(user_id,kind,model,prompt,status,created_at)
     VALUES(?,'image','gpt-image-2','无交付恢复','处理中',?)`,
    creatorId,
    staleAt,
  ).lastInsertRowid));
  const before = q.get('SELECT credits FROM tenants WHERE id=1').credits;
  const emptyHold = holdCredits({
    userId: creatorId,
    feature: '媒体无交付恢复测试',
    kind: 'image',
    model: 'gpt-image-2',
    credits: 31,
    refType: 'media_job',
    refId: emptyJobId,
  });

  const deliveredJobId = runWithTenant(1, () => Number(q.run(
    `INSERT INTO media_jobs(user_id,kind,model,prompt,status,url,created_at)
     VALUES(?,'image','gpt-image-2','已有交付恢复','处理中','https://example.invalid/result.png',?)`,
    creatorId,
    staleAt,
  ).lastInsertRowid));
  const deliveredHold = holdCredits({
    userId: creatorId,
    feature: '媒体已有交付恢复测试',
    kind: 'image',
    model: 'gpt-image-2',
    credits: 37,
    refType: 'media_job',
    refId: deliveredJobId,
  });

  const videoJobId = runWithTenant(1, () => Number(q.run(
    `INSERT INTO media_jobs(user_id,kind,model,prompt,status,task_id,created_at)
     VALUES(?,'video','kling-video','继续轮询恢复','处理中','provider-task-123',?)`,
    creatorId,
    staleAt,
  ).lastInsertRowid));
  const videoHold = holdCredits({
    userId: creatorId,
    feature: '媒体视频轮询恢复测试',
    kind: 'video',
    model: 'kling-video',
    credits: 41,
    refType: 'media_job',
    refId: videoJobId,
  });

  const recovered = runWithTenant(1, () => (
    recoverStaleMediaJobs(new Date('2026-07-23T02:00:00.000Z'))
  ));
  assert.equal(recovered.find(item => item.jobId === emptyJobId)?.billingState, 'released');
  assert.equal(recovered.find(item => item.jobId === deliveredJobId)?.billingState, 'pending_reconciliation');
  assert.equal(recovered.find(item => item.jobId === videoJobId)?.billingState, 'pending_reconciliation');
  assert.equal(recovered.find(item => item.jobId === videoJobId)?.action, 'continue_existing_provider_work');
  assert.equal(q.get('SELECT status FROM media_jobs WHERE id=?', emptyJobId).status, '失败');
  assert.equal(q.get('SELECT status FROM media_jobs WHERE id=?', deliveredJobId).status, '成功');
  assert.equal(q.get('SELECT status FROM media_jobs WHERE id=?', videoJobId).status, '失败');
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', emptyHold.holdId).status, 'settled');
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', deliveredHold.holdId).status, 'held');
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', videoHold.holdId).status, 'held');
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, before - 37 - 41);
  releaseHold(deliveredHold, '测试结束清理已有产物待对账占扣');
  releaseHold(videoHold, '测试结束清理视频供应商任务占扣');
  q.run(`UPDATE media_jobs SET status='失败' WHERE tenant_id=1 AND id=?`, videoJobId);
});

test('媒体恢复读取providerExecution：snapshot任务号或invocationStarted均禁止退款', () => {
  const staleAt = '2026-07-23 08:00:00';
  const insertJob = (prompt, providerExecution) => runWithTenant(1, () => Number(q.run(
    `INSERT INTO media_jobs(user_id,kind,model,prompt,status,snapshot_json,created_at)
     VALUES(?,'video','MiniMax-Hailuo-2.3',?,'处理中',?,?)`,
    creatorId,
    prompt,
    JSON.stringify({ providerExecution }),
    staleAt,
  ).lastInsertRowid));
  const snapshotTaskJobId = insertJob('snapshot任务号', {
    invocationStarted: false,
    segments: [{ index: 1, taskId: 'snapshot-only-provider-task' }],
  });
  const invocationOnlyJobId = insertJob('已外调但未取得任务号', {
    invocationStarted: true,
    segments: [{ index: 1, taskId: null }],
  });
  const noInvocationJobId = insertJob('真正未外调', {
    invocationStarted: false,
    segments: [{ index: 1, taskId: null }],
  });
  const snapshotTaskHold = holdCredits({
    userId: creatorId,
    feature: 'snapshot任务号恢复测试',
    kind: 'video',
    model: 'MiniMax-Hailuo-2.3',
    credits: 43,
    refType: 'media_job',
    refId: snapshotTaskJobId,
  });
  const invocationOnlyHold = holdCredits({
    userId: creatorId,
    feature: '已外调无任务号恢复测试',
    kind: 'video',
    model: 'MiniMax-Hailuo-2.3',
    credits: 47,
    refType: 'media_job',
    refId: invocationOnlyJobId,
  });
  const noInvocationHold = holdCredits({
    userId: creatorId,
    feature: '真正未外调恢复测试',
    kind: 'video',
    model: 'MiniMax-Hailuo-2.3',
    credits: 53,
    refType: 'media_job',
    refId: noInvocationJobId,
  });

  const recovered = runWithTenant(1, () => (
    recoverStaleMediaJobs(new Date('2026-07-23T02:00:00.000Z'))
  ));
  for (const jobId of [snapshotTaskJobId, invocationOnlyJobId]) {
    const item = recovered.find(candidate => candidate.jobId === jobId);
    assert.equal(item?.billingState, 'pending_reconciliation');
    assert.equal(item?.action, 'continue_existing_provider_work');
    const row = q.get('SELECT status,snapshot_json FROM media_jobs WHERE id=?', jobId);
    assert.equal(row.status, '失败');
    assert.equal(JSON.parse(row.snapshot_json).providerRecovery.action, 'continue_existing_provider_work');
  }
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', snapshotTaskHold.holdId).status, 'held');
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', invocationOnlyHold.holdId).status, 'held');
  assert.equal(
    recovered.find(item => item.jobId === noInvocationJobId)?.billingState,
    'released',
  );
  assert.equal(q.get('SELECT status FROM media_jobs WHERE id=?', noInvocationJobId).status, '失败');
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', noInvocationHold.holdId).status, 'settled');

  releaseHold(snapshotTaskHold, '清理snapshot任务号恢复测试占扣');
  releaseHold(invocationOnlyHold, '清理已外调无任务号恢复测试占扣');
  q.run(`UPDATE media_jobs SET status='失败' WHERE tenant_id=1 AND id IN (?,?)`,
    snapshotTaskJobId, invocationOnlyJobId);
});

test('媒体恢复优先使用providerExecution ISO心跳，长视频仍活跃时不误杀', () => {
  const jobId = runWithTenant(1, () => Number(q.run(
    `INSERT INTO media_jobs(user_id,kind,model,prompt,status,snapshot_json,created_at)
     VALUES(?,'video','MiniMax-Hailuo-2.3','新鲜provider心跳','处理中',?,'2026-07-23 08:00:00')`,
    creatorId,
    JSON.stringify({
      providerExecution: {
        invocationStarted: true,
        updatedAt: '2026-07-23T01:55:00.000Z',
        segments: [{ index: 1, taskId: 'active-provider-task' }],
      },
    }),
  ).lastInsertRowid));
  const hold = holdCredits({
    userId: creatorId,
    feature: '媒体provider心跳恢复测试',
    kind: 'video',
    model: 'MiniMax-Hailuo-2.3',
    credits: 59,
    refType: 'media_job',
    refId: jobId,
  });

  const recovered = runWithTenant(1, () => (
    recoverStaleMediaJobs(new Date('2026-07-23T02:00:00.000Z'))
  ));
  assert.equal(recovered.some(item => item.jobId === jobId), false);
  assert.equal(q.get('SELECT status FROM media_jobs WHERE id=?', jobId).status, '处理中');
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', hold.holdId).status, 'held');
  releaseHold(hold, '清理媒体provider心跳恢复测试占扣');
  q.run(`UPDATE media_jobs SET status='失败' WHERE tenant_id=1 AND id=?`, jobId);
});

test('SQLite localtime恢复与上海经营时钟解耦，非上海主机不误杀新任务', () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    // 02:00Z == 19:00 PDT on the previous day. The former Shanghai cutoff
    // was 09:30 on July 23 and incorrectly classified both rows as stale.
    const freshJobId = runWithTenant(1, () => Number(q.run(
      `INSERT INTO media_jobs(user_id,kind,model,prompt,status,created_at)
       VALUES(?,'image','gpt-image-2','PDT新鲜任务','处理中','2026-07-22 18:50:00')`,
      creatorId,
    ).lastInsertRowid));
    const staleJobId = runWithTenant(1, () => Number(q.run(
      `INSERT INTO media_jobs(user_id,kind,model,prompt,status,created_at)
       VALUES(?,'image','gpt-image-2','PDT超时任务','处理中','2026-07-22 18:00:00')`,
      creatorId,
    ).lastInsertRowid));

    const recovered = runWithTenant(1, () => (
      recoverStaleMediaJobs(new Date('2026-07-23T02:00:00.000Z'))
    ));
    assert.equal(recovered.some(item => item.jobId === freshJobId), false);
    assert.equal(recovered.some(item => item.jobId === staleJobId), true);
    assert.equal(q.get('SELECT status FROM media_jobs WHERE id=?', freshJobId).status, '处理中');
    assert.equal(q.get('SELECT status FROM media_jobs WHERE id=?', staleJobId).status, '失败');
    q.run(`UPDATE media_jobs SET status='失败' WHERE tenant_id=1 AND id=?`, freshJobId);
  } finally {
    process.env.TZ = previousTz;
  }
});

test('恢复超时内容员工运行：无产物原子退款，有产物保留占扣待对账，活跃运行不受影响', () => {
  const emptyRunId = insertContentEmployeeRun({ title: '无产物内容员工恢复' });
  const before = q.get('SELECT credits FROM tenants WHERE id=1').credits;
  const emptyHold = holdCredits({
    userId: creatorId,
    feature: '内容员工无产物恢复测试',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 43,
    refType: 'content_employee_run',
    refId: emptyRunId,
  });

  const deliveredRunId = insertContentEmployeeRun({
    title: '已有产物内容员工恢复',
    resultMd: '# 已落库的趋势简报\n\n这是可供人工审阅的业务产物。',
  });
  const deliveredHold = holdCredits({
    userId: creatorId,
    feature: '内容员工已有产物恢复测试',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 47,
    refType: 'content_employee_run',
    refId: deliveredRunId,
  });
  const activeRunId = insertContentEmployeeRun({
    title: '仍在安全窗口的内容员工运行',
    createdAt: '2026-07-23 08:00:00',
    updatedAt: '2026-07-23 09:50:00',
  });

  const recovered = runWithTenant(1, () => (
    recoverStaleContentEmployeeRuns(new Date('2026-07-23T02:00:00.000Z'))
  ));
  assert.equal(recovered.find(item => item.runId === emptyRunId)?.billingState, 'released');
  assert.equal(
    recovered.find(item => item.runId === deliveredRunId)?.billingState,
    'pending_reconciliation',
  );
  assert.equal(recovered.some(item => item.runId === activeRunId), false);

  const emptyRun = q.get(
    'SELECT status,snapshot_json,updated_at FROM content_employee_runs WHERE id=?',
    emptyRunId,
  );
  assert.equal(emptyRun.status, '失败');
  assert.equal(emptyRun.updated_at, '2026-07-23 10:00:00');
  assert.equal(JSON.parse(emptyRun.snapshot_json).billing.state, 'released');
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', emptyHold.holdId).status, 'settled');
  assert.equal(q.get('SELECT credits FROM credit_logs WHERE id=?', emptyHold.logId).credits, 0);

  const deliveredRun = q.get(
    'SELECT status,snapshot_json FROM content_employee_runs WHERE id=?',
    deliveredRunId,
  );
  assert.equal(deliveredRun.status, '待审阅');
  assert.equal(
    JSON.parse(deliveredRun.snapshot_json).billing.state,
    'pending_reconciliation',
  );
  assert.equal(
    q.get('SELECT status FROM credit_holds WHERE id=?', deliveredHold.holdId).status,
    'held',
  );
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, before - 47);
  assert.equal(
    q.get('SELECT status FROM content_employee_runs WHERE id=?', activeRunId).status,
    '生成中',
  );
  releaseHold(deliveredHold, '测试结束清理内容员工已有产物待对账占扣');
});

test('恢复超时内容员工运行：有正文但契约无效仍是失败，不得伪装待审阅', () => {
  const runId = insertContentEmployeeRun({
    title: '契约无效恢复',
    resultMd: '# 格式不完整的正文',
    snapshot: { contract: { valid: false, errors: ['缺少必备交付字段'] } },
  });
  const hold = holdCredits({
    userId: creatorId,
    feature: '内容员工无效产出恢复测试',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 13,
    refType: 'content_employee_run',
    refId: runId,
  });

  const recovered = runWithTenant(1, () => (
    recoverStaleContentEmployeeRuns(new Date('2026-07-23T02:00:00.000Z'))
  ));
  assert.equal(recovered.find(item => item.runId === runId)?.status, '失败');
  assert.equal(recovered.find(item => item.runId === runId)?.billingState, 'pending_reconciliation');
  assert.equal(q.get('SELECT status FROM content_employee_runs WHERE id=?', runId).status, '失败');
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', hold.holdId).status, 'held');
  releaseHold(hold, '测试结束清理无效产出待对账占扣');
});

test('内容员工运行恢复接入关闭调度器时的启动恢复与每轮统计', async () => {
  const startupRunId = insertContentEmployeeRun({ title: '关闭调度器启动恢复' });
  const startupHold = holdCredits({
    userId: creatorId,
    feature: '内容员工启动恢复测试',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 11,
    refType: 'content_employee_run',
    refId: startupRunId,
  });
  process.env.ENABLE_SCHEDULER = 'false';
  const startupRecovered = recoverStaleAiWorkAcrossTenants(
    new Date('2026-07-23T02:00:00.000Z'),
  );
  const tenantStartup = startupRecovered.find(item => item.tenantId === 1);
  assert.equal(tenantStartup.contentEmployeeRuns.length, 1);
  assert.equal(tenantStartup.contentEmployeeRuns[0].runId, startupRunId);
  assert.equal(
    q.get('SELECT status FROM credit_holds WHERE id=?', startupHold.holdId).status,
    'settled',
  );

  const tickRunId = insertContentEmployeeRun({ title: '定时轮次恢复统计' });
  const tickHold = holdCredits({
    userId: creatorId,
    feature: '内容员工轮次恢复测试',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 13,
    refType: 'content_employee_run',
    refId: tickRunId,
  });
  const tick = runScheduledJobs(new Date('2026-07-23T02:00:00.000Z'), {
    contentAutomationRunner: async () => assert.fail('本用例不应触发内容自动化供应商调用'),
  });
  await tick.pending;
  assert.equal(
    tick.results.find(item => item.tenantId === 1).contentEmployeeRunsRecovered,
    1,
  );
  assert.equal(q.get('SELECT status FROM content_employee_runs WHERE id=?', tickRunId).status, '失败');
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', tickHold.holdId).status, 'settled');
});

test('员工全网进修同时接入关闭调度器时的启动恢复与每轮tick', async () => {
  const createStaleLearningRun = ({ idx, name }) => {
    const run = createSkillLearningRun({
      tenantId: 1,
      domain: 'content',
      employeeIdx: idx,
      employeeName: name,
      skillsBefore: 0,
      createdBy: creatorId,
    });
    q.run(`UPDATE employee_skill_learning_runs
      SET status='running',started_at='2000-01-01 00:00:00',updated_at='2000-01-01 00:00:00'
      WHERE tenant_id=1 AND id=?`, run.id);
    return run;
  };

  const startupRun = createStaleLearningRun({ idx: 910, name: '启动恢复进修岗位' });
  const startupHold = holdCredits({
    userId: creatorId,
    tenantId: 1,
    feature: '全网进修启动恢复测试',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 17,
    refType: 'employee_skill_learning_run',
    refId: startupRun.id,
  });
  process.env.ENABLE_SCHEDULER = 'false';
  const startupRecovered = recoverStaleAiWorkAcrossTenants(new Date());
  const tenantStartup = startupRecovered.find(item => item.tenantId === 1);
  assert.equal(tenantStartup.skillLearningRuns.length, 1);
  assert.equal(tenantStartup.skillLearningRuns[0].runId, startupRun.id);
  assert.equal(
    q.get('SELECT status FROM credit_holds WHERE id=?', startupHold.holdId).status,
    'settled',
  );
  assert.equal(
    q.get('SELECT status FROM employee_skill_learning_runs WHERE id=?', startupRun.id).status,
    'failed',
  );

  const tickRun = createStaleLearningRun({ idx: 911, name: '调度轮次进修岗位' });
  const tickHold = holdCredits({
    userId: creatorId,
    tenantId: 1,
    feature: '全网进修轮次恢复测试',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 19,
    refType: 'employee_skill_learning_run',
    refId: tickRun.id,
  });
  const tick = runScheduledJobs(new Date(), {
    contentAutomationRunner: async () => assert.fail('本用例不应触发内容自动化供应商调用'),
  });
  await tick.pending;
  assert.equal(
    tick.results.find(item => item.tenantId === 1).skillLearningRunsRecovered,
    1,
  );
  assert.equal(
    q.get('SELECT status FROM employee_skill_learning_runs WHERE id=?', tickRun.id).status,
    'failed',
  );
  assert.equal(
    q.get('SELECT status FROM credit_holds WHERE id=?', tickHold.holdId).status,
    'settled',
  );
});

test('启动恢复覆盖停用租户，单条损坏不阻断同租户其余记录和其他租户', () => {
  const createRecoveryTenant = ({ name, status, username }) => {
    const tenantId = Number(q.run(
      `INSERT INTO tenants(name,status,credits,total_recharged) VALUES(?,?,0,0)`,
      name,
      status,
    ).lastInsertRowid);
    const userId = Number(q.run(
      `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
       VALUES(?,'x',?,'boss','启用',?)`,
      username,
      `${name}老板`,
      tenantId,
    ).lastInsertRowid);
    creditTenant({ tenantId, delta: 1000, userId, feature: '恢复完整性专项充值' });
    return { tenantId, userId };
  };

  const disabled = createRecoveryTenant({
    name: '停用恢复企业',
    status: '已停用',
    username: 'scheduler-disabled-owner',
  });
  const active = createRecoveryTenant({
    name: '并行恢复企业',
    status: '已开通',
    username: 'scheduler-active-owner',
  });
  const insertTenantRun = ({ tenantId, userId, title }) => runWithTenant(
    tenantId,
    () => Number(q.run(`INSERT INTO content_employee_runs(
      employee_idx,employee_key,employee_name,employee_group,title,type,requirement,
      status,result_md,profile_version,prompt_hash,snapshot_json,created_by,created_at,updated_at
    ) VALUES(0,'trend','趋势官','热点雷达部',?,'趋势简报','恢复完整性测试',
      '生成中',NULL,'2026-07-30','recovery-integrity-hash','{}',?,
      '2026-07-23 08:00:00','2026-07-23 08:00:00')`,
    title, userId).lastInsertRowid),
  );
  const badRunId = insertTenantRun({ ...disabled, title: '损坏记录' });
  const goodDisabledRunId = insertTenantRun({ ...disabled, title: '停用租户正常记录' });
  const goodActiveRunId = insertTenantRun({ ...active, title: '其他租户正常记录' });
  const badHold = holdCredits({
    userId: disabled.userId,
    feature: '损坏恢复记录',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 31,
    refType: 'content_employee_run',
    refId: badRunId,
  });
  const goodDisabledHold = holdCredits({
    userId: disabled.userId,
    feature: '停用租户恢复记录',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 37,
    refType: 'content_employee_run',
    refId: goodDisabledRunId,
  });
  const goodActiveHold = holdCredits({
    userId: active.userId,
    feature: '其他租户恢复记录',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 41,
    refType: 'content_employee_run',
    refId: goodActiveRunId,
  });
  db.exec(`CREATE TRIGGER injected_recovery_record_failure
    BEFORE UPDATE ON credit_logs
    WHEN OLD.id=${Number(badHold.logId)}
    BEGIN
      SELECT RAISE(ABORT,'injected single-record recovery failure');
    END`);
  try {
    const recovered = recoverStaleAiWorkAcrossTenants(
      new Date('2026-07-23T02:00:00.000Z'),
    );
    const disabledResult = recovered.find(item => item.tenantId === disabled.tenantId);
    const activeResult = recovered.find(item => item.tenantId === active.tenantId);
    assert.ok(disabledResult, '停用租户也必须进入启动恢复');
    assert.ok(activeResult, '其他租户不能被损坏记录阻断');
    assert.match(
      disabledResult.contentEmployeeRuns.find(item => item.runId === badRunId)?.error || '',
      /injected single-record recovery failure/,
    );
    assert.equal(
      disabledResult.contentEmployeeRuns.find(item => item.runId === goodDisabledRunId)?.billingState,
      'released',
    );
    assert.equal(
      activeResult.contentEmployeeRuns.find(item => item.runId === goodActiveRunId)?.billingState,
      'released',
    );
    assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', badHold.holdId).status, 'held');
    assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', goodDisabledHold.holdId).status, 'settled');
    assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', goodActiveHold.holdId).status, 'settled');
    assert.equal(q.get('SELECT status FROM content_employee_runs WHERE id=?', badRunId).status, '生成中');
    assert.equal(q.get('SELECT status FROM content_employee_runs WHERE id=?', goodDisabledRunId).status, '失败');
    assert.equal(q.get('SELECT status FROM content_employee_runs WHERE id=?', goodActiveRunId).status, '失败');
    for (const tenantId of [disabled.tenantId, active.tenantId]) {
      const balance = q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits;
      const sum = q.get(
        'SELECT COALESCE(SUM(credits),0) total FROM credit_logs WHERE tenant_id=?',
        tenantId,
      ).total;
      assert.equal(balance, -sum, `租户${tenantId}恢复后账本必须恒等`);
    }
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_recovery_record_failure');
    releaseHold(badHold, '专项测试清理损坏记录');
  }
});

test('活跃立即任务阻止并发定时领取，结束后同一计划周期只领取一次', async () => {
  const ruleId = insertRule({
    name: '并发互斥规则',
    nextRunAt: '2026-07-23 10:00:00',
  });
  const immediateRunId = insertRunning({
    ruleId,
    trigger: 'immediate',
    claimKey: 'fresh-immediate',
    startedAt: '2026-07-23 09:50:00',
  });
  const now = new Date('2026-07-23T02:00:00.000Z');
  const blocked = runScheduledJobs(now, {
    contentAutomationRunner: async () => assert.fail('活跃立即任务期间不应领取定时任务'),
  });
  await blocked.pending;
  assert.equal(blocked.results.find(row => row.tenantId === 1).contentAutomationRecovered, 0);
  assert.equal(blocked.results.find(row => row.tenantId === 1).contentAutomationClaimed, 0);

  finishClaim({ runId: immediateRunId, ruleId });
  const calls = [];
  const runner = async payload => {
    calls.push(payload);
    assert.deepEqual(Object.keys(payload).sort(), ['initiatedBy', 'ruleId', 'runId', 'trigger']);
    assert.equal(payload.trigger, 'scheduled');
    finishClaim(payload);
  };
  const first = runScheduledJobs(now, { contentAutomationRunner: runner });
  const competing = runScheduledJobs(now, { contentAutomationRunner: runner });
  await Promise.all([first.pending, competing.pending]);

  assert.equal(first.results.find(row => row.tenantId === 1).contentAutomationClaimed, 1);
  assert.equal(competing.results.find(row => row.tenantId === 1).contentAutomationClaimed, 0);
  assert.equal(calls.length, 1);
  assert.equal(q.get(`SELECT COUNT(*) n FROM content_automation_runs
    WHERE tenant_id=1 AND rule_id=? AND trigger='scheduled'
      AND scheduled_for='2026-07-23 10:00:00'`, ruleId).n, 1);
  const rule = q.get(`SELECT next_run_at,last_status,last_error FROM content_automation_rules
    WHERE tenant_id=1 AND id=?`, ruleId);
  assert.equal(rule.next_run_at, '2026-07-24 10:00:00');
  assert.equal(rule.last_status, '成功');
  assert.equal(rule.last_error, null);
});

test('撤销租户、创建者或content模块权限会在claim前停用规则且不执行AI不扣费', async () => {
  runWithTenant(1, () => q.run(`UPDATE content_automation_rules
    SET enabled=0,next_run_at=NULL WHERE tenant_id=?`, 1));
  let executions = 0;
  const runner = async () => { executions += 1; };
  const verifyRevocation = async ({ name, revoke, restore, reason }) => {
    const nextRunAt = '2026-07-23 10:00:00';
    const ruleId = insertRule({ name, nextRunAt });
    const creditsBefore = q.get('SELECT credits FROM tenants WHERE id=1').credits;
    revoke();
    try {
      const tick = runScheduledJobs(new Date('2026-07-23T02:00:00.000Z'), {
        contentAutomationRunner: runner,
      });
      await tick.pending;
      assert.ok(tick.contentAutomationDenied.some(item => item.ruleId === ruleId));
      const rule = q.get(`SELECT enabled,next_run_at,last_status,last_error
        FROM content_automation_rules WHERE tenant_id=1 AND id=?`, ruleId);
      assert.equal(rule.enabled, 0);
      assert.equal(rule.next_run_at, null);
      assert.equal(rule.last_status, '已停用');
      assert.match(rule.last_error, reason);
      const run = q.get(`SELECT status,error,snapshot_json
        FROM content_automation_runs
        WHERE tenant_id=1 AND rule_id=? AND trigger='scheduled' AND claim_key=?`,
      ruleId, nextRunAt);
      assert.equal(run.status, '失败');
      assert.match(run.error, reason);
      assert.equal(JSON.parse(run.snapshot_json).entitlement.allowed, false);
      assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, creditsBefore);
      assert.equal(q.get(`SELECT COUNT(*) n FROM credit_holds
        WHERE tenant_id=1 AND ref_type='content_automation_run'
          AND ref_id IN (SELECT id FROM content_automation_runs WHERE rule_id=?)`, ruleId).n, 0);
    } finally {
      restore();
    }
  };

  await verifyRevocation({
    name: '租户撤权规则',
    revoke: () => q.run("UPDATE tenants SET status='已停用' WHERE id=1"),
    restore: () => q.run("UPDATE tenants SET status='已开通' WHERE id=1"),
    reason: /企业账号未开通或已停用/u,
  });
  await verifyRevocation({
    name: '创建者停用规则',
    revoke: () => q.run("UPDATE users SET status='停用' WHERE id=?", creatorId),
    restore: () => q.run("UPDATE users SET status='启用' WHERE id=?", creatorId),
    reason: /规则创建者账号不存在或已停用/u,
  });
  await verifyRevocation({
    name: '内容模块撤权规则',
    revoke: () => q.run(`UPDATE users SET modules='["dashboard"]' WHERE id=?`, creatorId),
    restore: () => q.run('UPDATE users SET modules=NULL WHERE id=?', creatorId),
    reason: /失去内容生产仓模块权限/u,
  });
  assert.equal(executions, 0);
});

test('上海周一零点边界按本地时间稳定领取，不携带任何发布动作', async () => {
  runWithTenant(1, () => q.run(`UPDATE content_automation_rules
    SET enabled=0,next_run_at=NULL WHERE tenant_id=?`, 1));
  const ruleId = insertRule({
    name: '上海周界规则',
    frequency: 'weekly',
    runTime: '00:05',
    weekday: 1,
    nextRunAt: '2026-07-27 00:05:00',
  });
  const calls = [];
  const runner = async payload => {
    calls.push(payload);
    finishClaim(payload);
  };
  const before = runScheduledJobs(new Date('2026-07-26T16:04:59.000Z'), {
    contentAutomationRunner: runner,
  });
  await before.pending;
  assert.equal(before.clock.local, '2026-07-27 00:04:00');
  assert.equal(before.results.find(row => row.tenantId === 1).contentAutomationClaimed, 0);

  const exact = runScheduledJobs(new Date('2026-07-26T16:05:00.000Z'), {
    contentAutomationRunner: runner,
  });
  await exact.pending;
  assert.equal(exact.clock.local, '2026-07-27 00:05:00');
  assert.equal(exact.clock.weekday, 'Mon');
  assert.equal(exact.results.find(row => row.tenantId === 1).contentAutomationClaimed, 1);
  assert.equal(calls.length, 1);
  assert.equal(q.get(`SELECT next_run_at FROM content_automation_rules
    WHERE tenant_id=1 AND id=?`, ruleId).next_run_at, '2026-08-03 00:05:00');
  assert.equal(q.get(`SELECT COUNT(*) n FROM contents
    WHERE tenant_id=1 AND content_run_mode='automation_scheduled'`).n, 0);
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* cleanup */ }
  }
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

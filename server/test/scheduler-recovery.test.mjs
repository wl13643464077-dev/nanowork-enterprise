import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  recoverStaleContentAutomationRuns,
  runScheduledJobs,
} = await import('../src/engines/scheduler.js');

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
});

import { db, q, curTenant, runWithTenant } from '../db.js';
import { generateBattlePlan, generateWeeklyReview } from './plans.js';
import { sendDailyDigest } from './daily-digest.js';
import { notify, safeJsonParse } from '../util.js';
import { twoPhaseBillingSummary } from './two-phase-delivery.js';
import {
  contentAutomationEntitlement,
  executeContentAutomationRun,
  nextContentAutomationRun,
} from '../routes/content.js';

const SHANGHAI_CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});
const CONTENT_AUTOMATION_STALE_MINUTES = 30;
// 内容员工工作台单次生成最多允许 10 分钟；额外留 5 分钟用于业务落库与计费结算。
const CONTENT_EMPLOYEE_RUN_STALE_MINUTES = 15;
// 餐饮员工单次配置允许最长 30 分钟，恢复阈值额外留 5 分钟落库/结算余量。
const AGENT_TASK_STALE_MINUTES = 35;
const MEDIA_JOB_STALE_MINUTES = 30;
const SCHEDULER_INTERVAL_MS = 30_000;
const DEFAULT_SCHEDULER_MAX_CONCURRENT = 2;
const HARD_SCHEDULER_MAX_CONCURRENT = 16;

export function schedulerEnabled(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env?.ENABLE_SCHEDULER || '').trim());
}

export function schedulerMaxConcurrent(env = process.env) {
  const parsed = Number.parseInt(String(env?.SCHEDULER_MAX_CONCURRENT || ''), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_SCHEDULER_MAX_CONCURRENT;
  return Math.min(HARD_SCHEDULER_MAX_CONCURRENT, parsed);
}

export async function settleScheduledTasks(taskFactories, maxConcurrent = schedulerMaxConcurrent()) {
  if (!Array.isArray(taskFactories) || taskFactories.length === 0) return [];
  const limit = Math.max(1, Math.min(
    HARD_SCHEDULER_MAX_CONCURRENT,
    Number.parseInt(String(maxConcurrent), 10) || DEFAULT_SCHEDULER_MAX_CONCURRENT,
  ));
  const outcomes = new Array(taskFactories.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= taskFactories.length) return;
      try {
        outcomes[index] = { status: 'fulfilled', value: await taskFactories[index]() };
      } catch (reason) {
        outcomes[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(limit, taskFactories.length) },
    () => worker(),
  ));
  return outcomes;
}

export function startSchedulerIfEnabled({
  env = process.env,
  runTick,
  setIntervalFn = setInterval,
  logger = console,
  intervalMs = SCHEDULER_INTERVAL_MS,
} = {}) {
  if (!schedulerEnabled(env)) {
    logger?.info?.('[scheduler] 已关闭；设置 ENABLE_SCHEDULER=true 后才会执行自动任务');
    return { enabled: false, interval: null };
  }
  if (typeof runTick !== 'function') throw new TypeError('runTick must be a function');
  let tickRunning = false;
  const guardedTick = () => {
    if (tickRunning) {
      logger?.warn?.('[scheduler] 上一轮仍在执行，跳过本轮，避免跨 tick 叠加并发');
      return false;
    }
    tickRunning = true;
    try {
      const result = runTick();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result)
          .catch(error => {
            logger?.error?.('[scheduler] 本轮执行失败:', error?.message || error);
            return false;
          })
          .finally(() => { tickRunning = false; });
      }
      tickRunning = false;
      return result;
    } catch (error) {
      tickRunning = false;
      throw error;
    }
  };
  guardedTick();
  const interval = setIntervalFn(guardedTick, intervalMs);
  interval?.unref?.();
  logger?.info?.(`[scheduler] 已启用；每 ${Math.round(intervalMs / 1000)} 秒检查一次自动任务`);
  return { enabled: true, interval, tick: guardedTick };
}

function clockParts(now = new Date()) {
  const parts = Object.fromEntries(SHANGHAI_CLOCK.formatToParts(now).map(part => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parts.hour,
    minute: parts.minute,
    weekday: parts.weekday,
    local: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:00`,
  };
}

function runOnce(jobKey, fn) {
  const claimed = q.run('INSERT OR IGNORE INTO scheduled_runs(job_key) VALUES(?)', jobKey);
  if (!claimed.changes) return false;
  try {
    fn();
    return true;
  } catch (error) {
    q.run('DELETE FROM scheduled_runs WHERE tenant_id=? AND job_key=?', curTenant(), jobKey);
    throw error;
  }
}

function sendOverdueFollowUpReminders() {
  const rows = q.all(`SELECT owner_id,COUNT(*) n FROM leads
    WHERE tenant_id=? AND owner_id IS NOT NULL
      AND stage NOT IN ('已成交','复购','已流失')
      AND next_follow_at < datetime('now','localtime')
    GROUP BY owner_id`, curTenant());
  for (const row of rows) {
    notify(row.owner_id, 'follow', `您有 ${row.n} 位客户跟进已超期`, '请尽快处理，超期48小时将升级至总监');
  }
  return rows.length;
}

function tableExists(name) {
  return Boolean(q.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
}

function holdForRef(refType, refId) {
  if (!tableExists('credit_holds')) return null;
  const row = q.get(`SELECT * FROM credit_holds
    WHERE tenant_id=? AND ref_type=? AND ref_id=? AND status='held'
    ORDER BY id DESC LIMIT 1`,
  curTenant(), refType, Number(refId));
  if (!row) return null;
  return {
    holdId: Number(row.id),
    logId: Number(row.log_id),
    tenantId: Number(row.tenant_id),
    userId: Number(row.user_id),
    feature: row.feature,
    kind: row.kind,
    model: row.model,
    credits: Number(row.held_credits),
  };
}

// 恢复逻辑已经持有 BEGIN IMMEDIATE，不能调用会自行开启事务的 releaseHold。
// 这里在同一事务内认领 hold、退回积分并改写原流水，确保“任务终止”和“占扣释放”
// 要么一起提交，要么一起回滚；服务再次崩溃也不会留下永久冻结的积分。
function releaseHeldCreditInCurrentTransaction(hold, note) {
  if (!hold?.holdId) return null;
  const authoritative = q.get(`SELECT id,tenant_id,log_id,held_credits,status
    FROM credit_holds WHERE tenant_id=? AND id=?`,
  hold.tenantId, hold.holdId);
  if (
    !authoritative
    || authoritative.status !== 'held'
    || Number(authoritative.log_id) !== Number(hold.logId)
    || Number(authoritative.held_credits) !== Number(hold.credits)
  ) {
    throw new Error(`预授权#${hold.holdId}恢复完整性校验失败`);
  }
  if (!q.get(
    'SELECT id FROM credit_logs WHERE tenant_id=? AND id=?',
    authoritative.tenant_id,
    authoritative.log_id,
  )) {
    throw new Error(`预授权#${hold.holdId}缺少同租户积分流水`);
  }
  const claimed = q.run(`UPDATE credit_holds
    SET status='settled',settled_credits=0,settled_at=datetime('now','localtime')
    WHERE tenant_id=? AND id=? AND status='held'`,
  authoritative.tenant_id, authoritative.id);
  if (!claimed.changes) return null;
  const tenantUpdated = q.run(
    'UPDATE tenants SET credits=credits+? WHERE id=?',
    authoritative.held_credits,
    authoritative.tenant_id,
  );
  if (tenantUpdated.changes !== 1) {
    throw new Error(`预授权#${hold.holdId}对应租户不存在`);
  }
  const balance = Number(q.get(
    'SELECT credits FROM tenants WHERE id=?',
    authoritative.tenant_id,
  )?.credits || 0);
  const logUpdated = q.run(`UPDATE credit_logs
    SET credits=0,input_tokens=0,output_tokens=0,cost_yuan=0,balance_after=?,
      ai_mode='api',note=?
    WHERE tenant_id=? AND id=?`,
  balance, `${note}；预授权${authoritative.held_credits}分→实扣0分`,
  authoritative.tenant_id, authoritative.log_id);
  if (logUpdated.changes !== 1) {
    throw new Error(`预授权#${hold.holdId}对应积分流水更新失败`);
  }
  return { credits: 0, balance, costYuan: 0 };
}

function recoveryRecordError(error, details) {
  return {
    tenantId: curTenant(),
    ...details,
    error: String(error?.message || error).slice(0, 500),
  };
}

export function recoverStaleContentAutomationRuns(
  now = new Date(),
  staleMinutes = CONTENT_AUTOMATION_STALE_MINUTES,
) {
  if (!tableExists('content_automation_rules') || !tableExists('content_automation_runs')) return [];
  const minutes = Number(staleMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new TypeError('staleMinutes must be a positive number');
  }
  const clock = clockParts(now);
  const cutoff = clockParts(new Date(now.getTime() - minutes * 60_000)).local;
  const candidates = q.all(`SELECT id,rule_id,trigger,scheduled_for,started_at,content_id
    FROM content_automation_runs
    WHERE tenant_id=? AND status='运行中' AND started_at<=?
    ORDER BY id`, curTenant(), cutoff);
  const recovered = [];
  for (const candidate of candidates) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const run = q.get(`SELECT id,rule_id,trigger,scheduled_for,started_at,content_id
        FROM content_automation_runs
        WHERE tenant_id=? AND id=? AND status='运行中' AND started_at<=?`,
      curTenant(), candidate.id, cutoff);
      if (!run) {
        db.exec('COMMIT');
        continue;
      }
      const message = `运行超过${minutes}分钟，服务恢复时已安全终止；未执行自动发布`;
      const hold = holdForRef('content_automation_run', run.id);
      const snapshot = safeJsonParse(
        q.get(`SELECT snapshot_json FROM content_automation_runs
          WHERE tenant_id=? AND id=?`, curTenant(), run.id)?.snapshot_json,
        {},
      ) || {};
      let billing = snapshot.billing || null;
      if (hold && run.content_id == null) {
        const released = releaseHeldCreditInCurrentTransaction(
          hold,
          `内容自动化运行#${run.id}超时且无业务产物，恢复时全额退回`,
        );
        if (!released) throw new Error(`内容自动化运行#${run.id}的预授权无法原子释放`);
        billing = twoPhaseBillingSummary({
          state: 'released',
          hold,
          settled: released,
          note: '服务恢复确认本次没有业务产物，预授权已全额退回。',
        });
      } else if (hold && run.content_id != null) {
        // 已有内容意味着业务产物可能已经形成，不能自动退分；保留 hold 供人工核对真实用量。
        billing = twoPhaseBillingSummary({
          state: 'pending_reconciliation',
          hold,
          note: '服务恢复发现业务产物已存在，预授权保留待人工核对，未自动退款。',
        });
      }
      const updated = q.run(`UPDATE content_automation_runs
        SET status='失败',error=?,snapshot_json=?,finished_at=?
        WHERE tenant_id=? AND id=? AND status='运行中'`,
      message, JSON.stringify({ ...snapshot, ...(billing ? { billing } : {}) }),
      clock.local, curTenant(), run.id);
      if (!updated.changes) {
        throw new Error(`内容自动化运行#${run.id}恢复状态发生并发冲突`);
      }
      // Only the newest run owns the rule summary. Recovering an older stale run
      // must not overwrite a newer successful/failed run's observable state.
      q.run(`UPDATE content_automation_rules
        SET last_status='失败',last_error=?,updated_at=?
        WHERE tenant_id=? AND id=?
          AND NOT EXISTS (
            SELECT 1 FROM content_automation_runs newer
            WHERE newer.tenant_id=? AND newer.rule_id=? AND newer.id>?
          )`,
      message, clock.local, curTenant(), run.rule_id,
      curTenant(), run.rule_id, run.id);
      db.exec('COMMIT');
      recovered.push({
        tenantId: curTenant(),
        ruleId: Number(run.rule_id),
        runId: Number(run.id),
        trigger: run.trigger,
        scheduledFor: run.scheduled_for || null,
        startedAt: run.started_at,
        error: message,
        billingState: billing?.state || null,
      });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      recovered.push(recoveryRecordError(error, {
        ruleId: Number(candidate.rule_id),
        runId: Number(candidate.id),
        status: '运行中',
        billingState: null,
      }));
    }
  }
  return recovered;
}

export function recoverStaleAgentTasks(
  now = new Date(),
  staleMinutes = AGENT_TASK_STALE_MINUTES,
) {
  if (!tableExists('agent_tasks')) return [];
  const minutes = Number(staleMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new TypeError('staleMinutes must be a positive number');
  }
  const clock = clockParts(now);
  const cutoff = clockParts(new Date(now.getTime() - minutes * 60_000)).local;
  const candidates = q.all(`SELECT id,output_id,created_at FROM agent_tasks
    WHERE tenant_id=? AND status='生成中' AND created_at<=?
    ORDER BY id`, curTenant(), cutoff);
  const recovered = [];
  for (const candidate of candidates) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const task = q.get(`SELECT id,output_id,created_at FROM agent_tasks
        WHERE tenant_id=? AND id=? AND status='生成中' AND created_at<=?`,
      curTenant(), candidate.id, cutoff);
      if (!task) {
        db.exec('COMMIT');
        continue;
      }
      const hold = holdForRef('agent_task', task.id);
      let billingState = null;
      if (hold && task.output_id == null) {
        const released = releaseHeldCreditInCurrentTransaction(
          hold,
          `数字员工任务#${task.id}超时且无业务产物，恢复时全额退回`,
        );
        if (!released) throw new Error(`数字员工任务#${task.id}的预授权无法原子释放`);
        billingState = 'released';
      } else if (hold && task.output_id != null) {
        // 已有产出时不自动退分；恢复到可审阅，并保留 hold 待核对真实用量。
        billingState = 'pending_reconciliation';
      }
      const nextStatus = task.output_id == null ? '失败' : '待审阅';
      const updated = q.run(`UPDATE agent_tasks SET status=?
        WHERE tenant_id=? AND id=? AND status='生成中'`,
      nextStatus, curTenant(), task.id);
      if (!updated.changes) {
        throw new Error(`数字员工任务#${task.id}恢复状态发生并发冲突`);
      }
      db.exec('COMMIT');
      recovered.push({
        tenantId: curTenant(),
        taskId: Number(task.id),
        status: nextStatus,
        billingState,
      });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      recovered.push(recoveryRecordError(error, {
        taskId: Number(candidate.id),
        status: '生成中',
        billingState: null,
      }));
    }
  }
  return recovered;
}

export function recoverStaleContentEmployeeRuns(
  now = new Date(),
  staleMinutes = CONTENT_EMPLOYEE_RUN_STALE_MINUTES,
) {
  if (!tableExists('content_employee_runs')) return [];
  const minutes = Number(staleMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new TypeError('staleMinutes must be a positive number');
  }
  const clock = clockParts(now);
  const cutoff = clockParts(new Date(now.getTime() - minutes * 60_000)).local;
  const candidates = q.all(`SELECT id,result_md,snapshot_json,created_at,updated_at
    FROM content_employee_runs
    WHERE tenant_id=? AND status='生成中'
      AND COALESCE(updated_at,created_at)<=?
    ORDER BY id`, curTenant(), cutoff);
  const recovered = [];
  for (const candidate of candidates) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const run = q.get(`SELECT id,result_md,snapshot_json,created_at,updated_at
        FROM content_employee_runs
        WHERE tenant_id=? AND id=? AND status='生成中'
          AND COALESCE(updated_at,created_at)<=?`,
      curTenant(), candidate.id, cutoff);
      if (!run) {
        db.exec('COMMIT');
        continue;
      }
      const hasResult = Boolean(String(run.result_md || '').trim());
      const hold = holdForRef('content_employee_run', run.id);
      const snapshot = safeJsonParse(run.snapshot_json, {}) || {};
      let billing = snapshot.billing || null;
      if (hold && !hasResult) {
        const released = releaseHeldCreditInCurrentTransaction(
          hold,
          `内容员工运行#${run.id}超时且无业务产物，恢复时全额退回`,
        );
        if (!released) throw new Error(`内容员工运行#${run.id}的预授权无法原子释放`);
        billing = twoPhaseBillingSummary({
          state: 'released',
          hold,
          settled: released,
          note: '服务恢复确认本次没有业务产物，预授权已全额退回。',
        });
      } else if (hold && hasResult) {
        billing = twoPhaseBillingSummary({
          state: 'pending_reconciliation',
          hold,
          note: '服务恢复发现内容产物已存在，预授权保留待人工核对，未自动退款。',
        });
      }
      const nextStatus = hasResult ? '待审阅' : '失败';
      const updated = q.run(`UPDATE content_employee_runs
        SET status=?,snapshot_json=?,updated_at=?
        WHERE tenant_id=? AND id=? AND status='生成中'`,
      nextStatus,
      JSON.stringify({ ...snapshot, ...(billing ? { billing } : {}) }),
      clock.local,
      curTenant(),
      run.id);
      if (!updated.changes) {
        throw new Error(`内容员工运行#${run.id}恢复状态发生并发冲突`);
      }
      db.exec('COMMIT');
      recovered.push({
        tenantId: curTenant(),
        runId: Number(run.id),
        status: nextStatus,
        billingState: billing?.state || null,
      });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      recovered.push(recoveryRecordError(error, {
        runId: Number(candidate.id),
        status: '生成中',
        billingState: null,
      }));
    }
  }
  return recovered;
}

export function recoverStaleMediaJobs(
  now = new Date(),
  staleMinutes = MEDIA_JOB_STALE_MINUTES,
) {
  if (!tableExists('media_jobs')) return [];
  const minutes = Number(staleMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new TypeError('staleMinutes must be a positive number');
  }
  const cutoff = clockParts(new Date(now.getTime() - minutes * 60_000)).local;
  const candidates = q.all(`SELECT id,kind,url,task_id,result_id,snapshot_json,created_at
    FROM media_jobs
    WHERE tenant_id=? AND status='处理中' AND created_at<=?
    ORDER BY id`, curTenant(), cutoff);
  const recovered = [];
  for (const candidate of candidates) {
    // 已取得视频供应商 task_id 时，继续由既有轮询路径追踪终态，不能因本地耗时长而退款。
    if (candidate.kind === 'video' && String(candidate.task_id || '').trim()) {
      recovered.push({
        tenantId: curTenant(),
        jobId: Number(candidate.id),
        status: '处理中',
        billingState: 'held',
        action: 'continue_provider_polling',
      });
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const job = q.get(`SELECT id,kind,url,task_id,result_id,snapshot_json,created_at
        FROM media_jobs
        WHERE tenant_id=? AND id=? AND status='处理中' AND created_at<=?`,
      curTenant(), candidate.id, cutoff);
      if (!job) {
        db.exec('COMMIT');
        continue;
      }
      if (job.kind === 'video' && String(job.task_id || '').trim()) {
        db.exec('COMMIT');
        continue;
      }
      const hold = holdForRef('media_job', job.id);
      const snapshot = safeJsonParse(job.snapshot_json, {}) || {};
      const hasDelivery = job.result_id != null || Boolean(String(job.url || '').trim());
      let billing = snapshot.billing || null;
      if (hold && !hasDelivery) {
        const released = releaseHeldCreditInCurrentTransaction(
          hold,
          `媒体任务#${job.id}超时且无业务产物/供应商任务号，恢复时全额退回`,
        );
        if (!released) throw new Error(`媒体任务#${job.id}的预授权无法原子释放`);
        billing = twoPhaseBillingSummary({
          state: 'released',
          hold,
          settled: released,
          note: '服务恢复确认没有业务产物或可继续轮询的供应商任务，预授权已全额退回。',
        });
      } else if (hold && hasDelivery) {
        billing = twoPhaseBillingSummary({
          state: 'pending_reconciliation',
          hold,
          note: '服务恢复发现媒体产物已存在，预授权保留待人工核对，未自动退款。',
        });
      }
      const nextStatus = hasDelivery ? '成功' : '失败';
      const error = hasDelivery
        ? null
        : `任务超过${minutes}分钟且未形成产物或供应商任务号，服务恢复时已安全终止`;
      const updated = q.run(`UPDATE media_jobs
        SET status=?,credits=?,error=?,snapshot_json=?
        WHERE tenant_id=? AND id=? AND status='处理中'`,
      nextStatus,
      billing?.state === 'released' ? 0 : null,
      error,
      JSON.stringify({ ...snapshot, ...(billing ? { billing } : {}) }),
      curTenant(),
      job.id);
      if (!updated.changes) throw new Error(`媒体任务#${job.id}恢复状态发生并发冲突`);
      db.exec('COMMIT');
      recovered.push({
        tenantId: curTenant(),
        jobId: Number(job.id),
        status: nextStatus,
        billingState: billing?.state || null,
        action: hasDelivery ? 'preserve_delivery' : 'released_without_delivery',
      });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      recovered.push(recoveryRecordError(error, {
        jobId: Number(candidate.id),
        status: '处理中',
        billingState: null,
        action: 'recovery_failed',
      }));
    }
  }
  return recovered;
}

// 自动任务总开关关闭时也必须做一次无外部调用的崩溃恢复，否则旧 hold 会永久冻结。
// 该函数只处理超过安全阈值的本地状态，不领取规则、不调用供应商。
export function recoverStaleAiWorkAcrossTenants(now = new Date()) {
  // 恢复的目标是关闭历史开放状态与冻结占扣，不能受当前经营权限影响。
  // 停用租户也可能在停用前留下运行中任务，因此启动时必须一并扫描。
  const tenants = q.all('SELECT id FROM tenants ORDER BY id');
  return tenants.map(tenant => {
    try {
      return runWithTenant(tenant.id, () => {
        const subsystemErrors = [];
        const recover = (subsystem, fn) => {
          try {
            return fn();
          } catch (error) {
            subsystemErrors.push({
              subsystem,
              error: String(error?.message || error).slice(0, 500),
            });
            return [];
          }
        };
        return {
          tenantId: Number(tenant.id),
          contentAutomation: recover(
            'contentAutomation',
            () => recoverStaleContentAutomationRuns(now),
          ),
          contentEmployeeRuns: recover(
            'contentEmployeeRuns',
            () => recoverStaleContentEmployeeRuns(now),
          ),
          agentTasks: recover('agentTasks', () => recoverStaleAgentTasks(now)),
          mediaJobs: recover('mediaJobs', () => recoverStaleMediaJobs(now)),
          recoveryErrors: subsystemErrors,
        };
      });
    } catch (error) {
      return { tenantId: Number(tenant.id), error: error.message };
    }
  });
}

function entitlementFailureMessage(entitlement) {
  return `内容自动化权限复核未通过，规则已自动停用：${entitlement.reason}`;
}

function disableDueContentAutomationRule(rule, clock, entitlement) {
  const message = entitlementFailureMessage(entitlement);
  const snapshot = JSON.stringify({
    entitlement: {
      allowed: false,
      code: entitlement.code,
      reason: entitlement.reason,
    },
  });
  q.run(`INSERT OR IGNORE INTO content_automation_runs(
    rule_id,trigger,claim_key,scheduled_for,status,initiated_by,snapshot_json,error,finished_at
  ) VALUES(?,'scheduled',?,?,'失败',?,?,?,?)`,
  rule.id, rule.next_run_at, rule.next_run_at, rule.created_by,
  snapshot, message, clock.local);
  q.run(`UPDATE content_automation_rules
    SET enabled=0,next_run_at=NULL,last_run_at=?,last_status='已停用',last_error=?,
      updated_at=datetime('now','localtime')
    WHERE tenant_id=? AND id=?`,
  clock.local, message, curTenant(), rule.id);
  const run = q.get(`SELECT id FROM content_automation_runs
    WHERE tenant_id=? AND rule_id=? AND trigger='scheduled' AND claim_key=?`,
  curTenant(), rule.id, rule.next_run_at);
  return {
    tenantId: curTenant(),
    ruleId: Number(rule.id),
    runId: run?.id == null ? null : Number(run.id),
    scheduledFor: rule.next_run_at,
    reason: message,
  };
}

function disableClaimedContentAutomationRun(claim, clock, entitlement) {
  const message = entitlementFailureMessage(entitlement);
  const run = q.get(`SELECT id,snapshot_json FROM content_automation_runs
    WHERE tenant_id=? AND id=? AND rule_id=? AND status='运行中'`,
  curTenant(), claim.runId, claim.ruleId);
  if (!run) return null;
  const snapshot = safeJsonParse(run.snapshot_json, {}) || {};
  snapshot.entitlement = {
    allowed: false,
    code: entitlement.code,
    reason: entitlement.reason,
  };
  q.run(`UPDATE content_automation_runs
    SET status='失败',snapshot_json=?,error=?,finished_at=?
    WHERE tenant_id=? AND id=? AND status='运行中'`,
  JSON.stringify(snapshot), message, clock.local, curTenant(), claim.runId);
  q.run(`UPDATE content_automation_rules
    SET enabled=0,next_run_at=NULL,last_status='已停用',last_error=?,
      last_run_at=?,updated_at=datetime('now','localtime')
    WHERE tenant_id=? AND id=?`,
  message, clock.local, curTenant(), claim.ruleId);
  return {
    tenantId: curTenant(),
    ruleId: Number(claim.ruleId),
    runId: Number(claim.runId),
    scheduledFor: claim.scheduledFor || null,
    reason: message,
  };
}

export function reconcileIneligibleContentAutomationRules(
  now = new Date(),
  clock = clockParts(now),
) {
  if (!tableExists('content_automation_rules') || !tableExists('content_automation_runs')) return [];
  const tenantIds = db.prepare(`SELECT DISTINCT tenant_id id FROM content_automation_rules
    WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?
    ORDER BY tenant_id`).all(clock.local);
  const disabled = [];
  for (const item of tenantIds) {
    const tenantDisabled = runWithTenant(Number(item.id), () => {
      const rows = q.all(`SELECT * FROM content_automation_rules
        WHERE tenant_id=? AND enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?
        ORDER BY next_run_at,id`, curTenant(), clock.local);
      const results = [];
      for (const candidate of rows) {
        db.exec('BEGIN IMMEDIATE');
        try {
          const rule = q.get(`SELECT * FROM content_automation_rules
            WHERE tenant_id=? AND id=? AND enabled=1
              AND next_run_at IS NOT NULL AND next_run_at<=?`,
          curTenant(), candidate.id, clock.local);
          if (!rule) {
            db.exec('COMMIT');
            continue;
          }
          const entitlement = contentAutomationEntitlement({
            tenantId: curTenant(),
            creatorId: rule.created_by,
          });
          if (!entitlement.allowed) {
            results.push(disableDueContentAutomationRule(rule, clock, entitlement));
          }
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
          throw error;
        }
      }
      return results;
    });
    disabled.push(...tenantDisabled);
  }
  return disabled;
}

export function claimDueContentAutomationRules(now, clock = clockParts(now)) {
  if (!tableExists('content_automation_rules') || !tableExists('content_automation_runs')) return [];
  const due = q.all(`SELECT * FROM content_automation_rules
    WHERE tenant_id=? AND enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?
      AND NOT EXISTS (
        SELECT 1 FROM content_automation_runs active
        WHERE active.tenant_id=content_automation_rules.tenant_id
          AND active.rule_id=content_automation_rules.id
          AND active.status='运行中'
      )
    ORDER BY next_run_at,id LIMIT 50`, curTenant(), clock.local);
  const claims = [];
  for (const candidate of due) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const rule = q.get(`SELECT * FROM content_automation_rules
        WHERE tenant_id=? AND id=? AND enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?
          AND NOT EXISTS (
            SELECT 1 FROM content_automation_runs active
            WHERE active.tenant_id=content_automation_rules.tenant_id
              AND active.rule_id=content_automation_rules.id
              AND active.status='运行中'
          )`,
      curTenant(), candidate.id, clock.local);
      if (!rule) {
        db.exec('COMMIT');
        continue;
      }
      const entitlement = contentAutomationEntitlement({
        tenantId: curTenant(),
        creatorId: rule.created_by,
      });
      if (!entitlement.allowed) {
        disableDueContentAutomationRule(rule, clock, entitlement);
        db.exec('COMMIT');
        continue;
      }
      const scheduledFor = rule.next_run_at;
      const inserted = q.run(`INSERT OR IGNORE INTO content_automation_runs(
        rule_id,trigger,claim_key,scheduled_for,status,initiated_by
      ) VALUES(?,'scheduled',?,?,'运行中',?)`,
      rule.id, scheduledFor, scheduledFor, rule.created_by);
      if (!inserted.changes) {
        db.exec('COMMIT');
        continue;
      }
      const nextRunAt = nextContentAutomationRun({
        enabled: true,
        frequency: rule.frequency,
        run_time: rule.run_time,
        weekday: rule.weekday,
      }, now);
      q.run(`UPDATE content_automation_rules SET next_run_at=?,last_run_at=?,
        last_status='运行中',last_error=NULL,updated_at=datetime('now','localtime')
        WHERE tenant_id=? AND id=? AND enabled=1 AND next_run_at=?`,
      nextRunAt, clock.local, curTenant(), rule.id, scheduledFor);
      db.exec('COMMIT');
      claims.push({
        tenantId: curTenant(),
        ruleId: Number(rule.id),
        runId: Number(inserted.lastInsertRowid),
        initiatedBy: Number(rule.created_by),
        scheduledFor,
      });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw error;
    }
  }
  return claims;
}

function runTenantJobs(clock, now, contentAutomationRunner) {
  const result = {
    tenantId: curTenant(),
    battlePlan: false,
    weeklyReview: false,
    reminderOwners: 0,
    contentAutomationRecovered: 0,
    contentAutomationClaimed: 0,
    contentEmployeeRunsRecovered: 0,
    agentTasksRecovered: 0,
    mediaJobsRecovered: 0,
  };
  if (clock.hour === '06' && clock.minute === '30') {
    result.battlePlan = runOnce(`battle-plan:${clock.date}`, () => generateBattlePlan(clock.date));
  }
  // 每日经营日报（08:00 上海时间）：总结昨日，涨跌→归因→建议，推送老板与运营负责人
  if (clock.hour === '08' && clock.minute === '00') {
    const yesterday = new Date(`${clock.date}T00:00:00`);
    yesterday.setDate(yesterday.getDate() - 1);
    const target = yesterday.toLocaleDateString('sv-SE');
    result.dailyDigest = runOnce(`daily-digest:${clock.date}`, () => sendDailyDigest(target));
  }
  if (clock.weekday === 'Mon' && clock.hour === '08' && clock.minute === '30') {
    result.weeklyReview = runOnce(`weekly-review:${clock.date}`, () => generateWeeklyReview(clock.date));
  }
  if (clock.minute === '00') {
    const key = `overdue-follow-up:${clock.date}T${clock.hour}`;
    let owners = 0;
    const ran = runOnce(key, () => { owners = sendOverdueFollowUpReminders(); });
    result.reminderOwners = ran ? owners : 0;
  }
  const recovered = recoverStaleContentAutomationRuns(now);
  result.contentAutomationRecovered = recovered.length;
  result.contentEmployeeRunsRecovered = recoverStaleContentEmployeeRuns(now).length;
  result.agentTasksRecovered = recoverStaleAgentTasks(now).length;
  result.mediaJobsRecovered = recoverStaleMediaJobs(now).filter(
    item => item.action !== 'continue_provider_polling',
  ).length;
  const claims = claimDueContentAutomationRules(now, clock);
  result.contentAutomationClaimed = claims.length;
  const pending = claims.map(claim => () => Promise.resolve().then(() => runWithTenant(claim.tenantId, () => (
    (() => {
      const entitlement = contentAutomationEntitlement({
        tenantId: claim.tenantId,
        creatorId: claim.initiatedBy,
      });
      if (!entitlement.allowed) {
        return disableClaimedContentAutomationRun(claim, clock, entitlement);
      }
      return contentAutomationRunner({
        ruleId: claim.ruleId,
        runId: claim.runId,
        trigger: 'scheduled',
        initiatedBy: claim.initiatedBy,
      });
    })()
  ))));
  return { result, pending };
}

export function runScheduledJobs(now = new Date(), {
  contentAutomationRunner = executeContentAutomationRun,
  maxConcurrent = schedulerMaxConcurrent(),
} = {}) {
  const clock = clockParts(now);
  const contentAutomationDenied = reconcileIneligibleContentAutomationRules(now, clock);
  const tenants = q.all(`SELECT id FROM tenants WHERE status='已开通' ORDER BY id`);
  const results = [];
  const pending = [];
  for (const tenant of tenants) {
    try {
      const tenantJobs = runWithTenant(tenant.id, () => (
        runTenantJobs(clock, now, contentAutomationRunner)
      ));
      results.push(tenantJobs.result);
      pending.push(...tenantJobs.pending);
    } catch (error) {
      results.push({ tenantId: tenant.id, error: error.message });
    }
  }
  return {
    clock,
    results,
    contentAutomationDenied,
    pending: settleScheduledTasks(pending, maxConcurrent),
  };
}

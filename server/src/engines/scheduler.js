import { db, q, curTenant, runWithTenant } from '../db.js';
import { generateBattlePlan, generateWeeklyReview } from './plans.js';
import { notify } from '../util.js';
import {
  executeContentAutomationRun,
  nextContentAutomationRun,
} from '../routes/content.js';

const SHANGHAI_CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});
const CONTENT_AUTOMATION_STALE_MINUTES = 30;

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
  const candidates = q.all(`SELECT id,rule_id,trigger,scheduled_for,started_at
    FROM content_automation_runs
    WHERE tenant_id=? AND status='运行中' AND started_at<=?
    ORDER BY id`, curTenant(), cutoff);
  const recovered = [];
  for (const candidate of candidates) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const run = q.get(`SELECT id,rule_id,trigger,scheduled_for,started_at
        FROM content_automation_runs
        WHERE tenant_id=? AND id=? AND status='运行中' AND started_at<=?`,
      curTenant(), candidate.id, cutoff);
      if (!run) {
        db.exec('COMMIT');
        continue;
      }
      const message = `运行超过${minutes}分钟，服务恢复时已安全终止；未执行自动发布`;
      const updated = q.run(`UPDATE content_automation_runs
        SET status='失败',error=?,finished_at=?
        WHERE tenant_id=? AND id=? AND status='运行中'`,
      message, clock.local, curTenant(), run.id);
      if (!updated.changes) {
        db.exec('COMMIT');
        continue;
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
      });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw error;
    }
  }
  return recovered;
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
  };
  if (clock.hour === '06' && clock.minute === '30') {
    result.battlePlan = runOnce(`battle-plan:${clock.date}`, () => generateBattlePlan(clock.date));
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
  const claims = claimDueContentAutomationRules(now, clock);
  result.contentAutomationClaimed = claims.length;
  const pending = claims.map(claim => Promise.resolve().then(() => runWithTenant(claim.tenantId, () => (
    contentAutomationRunner({
      ruleId: claim.ruleId,
      runId: claim.runId,
      trigger: 'scheduled',
      initiatedBy: claim.initiatedBy,
    })
  ))));
  return { result, pending };
}

export function runScheduledJobs(now = new Date(), {
  contentAutomationRunner = executeContentAutomationRun,
} = {}) {
  const clock = clockParts(now);
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
  return { clock, results, pending: Promise.allSettled(pending) };
}

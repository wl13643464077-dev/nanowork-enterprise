import { randomUUID } from "node:crypto";

import { validatePaihuoContentBrief } from "./content-production-pipeline.js";

export const CONTENT_PIPELINE_SCHEDULE_SCHEMA =
  "nanowork.content-pipeline-schedule/1";
export const CONTENT_PIPELINE_SCHEDULE_RUN_SCHEMA =
  "nanowork.content-pipeline-schedule-run/1";
export const CONTENT_PIPELINE_SCHEDULE_TIME_ZONE = "Asia/Shanghai";
export const CONTENT_PIPELINE_SCHEDULE_CLAIM_LEASE_MS = 15 * 60 * 1_000;
export const CONTENT_PIPELINE_SCHEDULE_RETRY_DELAY_MS = 10 * 60 * 1_000;
export const CONTENT_PIPELINE_SCHEDULE_ACTIVE_LIMIT = 3;

export function contentPipelineScheduleLaunchBlocker({
  running = 0,
  active = 0,
  limit = CONTENT_PIPELINE_SCHEDULE_ACTIVE_LIMIT,
} = {}) {
  if (Number(running) > 0) {
    return {
      code: "CONTENT_PIPELINE_SCHEDULE_PROVIDER_BUSY",
      message: "已有流水线正在占用模型，定时计划已顺延10分钟",
      status: 429,
    };
  }
  if (Number(active) >= Number(limit)) {
    return {
      code: "CONTENT_PIPELINE_SCHEDULE_CAPACITY_FULL",
      message: `并行流水线已满(${limit})`,
      status: 429,
    };
  }
  return null;
}

const KINDS = new Set(["daily", "weekly", "interval"]);
const MODES = new Set(["fullauto", "autopilot", "copilot", "manual"]);
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const WEEKDAY_INDEX = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};
const SHANGHAI_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: CONTENT_PIPELINE_SCHEDULE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

export class ContentPipelineScheduleError extends Error {
  constructor(
    message,
    code = "CONTENT_PIPELINE_SCHEDULE_INVALID",
    status = 400,
  ) {
    super(message);
    this.name = "ContentPipelineScheduleError";
    this.code = code;
    this.status = status;
  }
}

function fail(message, code, status) {
  throw new ContentPipelineScheduleError(message, code, status);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
}

function cleanText(value, max = 500) {
  return String(value ?? "")
    .replace(/\u0000/gu, "")
    .trim()
    .slice(0, max);
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail(`${field}必须是正整数`, undefined, 400);
  }
  return number;
}

function instant(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail("调度时间无效", undefined, 400);
  return date.toISOString();
}

function parseAtTime(value) {
  const text = cleanText(value || "09:00", 5);
  const match = /^(\d{2}):(\d{2})$/u.exec(text);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour > 23 || minute > 59) {
    fail("执行时间必须是北京时间 HH:MM", undefined, 400);
  }
  return { text, hour, minute };
}

function shanghaiParts(value) {
  const parts = Object.fromEntries(
    SHANGHAI_CLOCK.formatToParts(value).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday],
  };
}

function wallEpoch(parts) {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0,
  );
}

export function normalizeContentPipelineScheduleTiming(raw = {}) {
  if (!isRecord(raw)) fail("调度配置必须是对象", undefined, 400);
  const kind = cleanText(raw.kind || "daily", 20);
  if (!KINDS.has(kind))
    fail("kind必须是daily、weekly或interval", undefined, 400);
  if (kind === "interval") {
    const everyHours = Number(raw.everyHours ?? raw.every_hours ?? 24);
    if (
      !Number.isSafeInteger(everyHours) ||
      everyHours < 1 ||
      everyHours > 720
    ) {
      fail("间隔小时必须是1到720之间的整数", undefined, 400);
    }
    return { kind, atTime: null, weekday: null, everyHours };
  }
  const atTime = parseAtTime(raw.atTime ?? raw.at_time).text;
  if (kind === "weekly") {
    const weekday = Number(raw.weekday ?? 0);
    if (!Number.isSafeInteger(weekday) || weekday < 0 || weekday > 6) {
      fail("星期必须是0到6（0=周一）", undefined, 400);
    }
    return { kind, atTime, weekday, everyHours: null };
  }
  return { kind, atTime, weekday: null, everyHours: null };
}

export function computeNextContentPipelineSchedule(raw, now = new Date()) {
  const timing = normalizeContentPipelineScheduleTiming(raw);
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) fail("调度时间无效", undefined, 400);
  if (timing.kind === "interval") {
    return new Date(
      current.getTime() + timing.everyHours * 3_600_000,
    ).toISOString();
  }
  const parts = shanghaiParts(current);
  const { hour, minute } = parseAtTime(timing.atTime);
  const nowWall = wallEpoch(parts);
  let nextWall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hour,
    minute,
    0,
  );
  if (timing.kind === "weekly") {
    let days = (timing.weekday - parts.weekday + 7) % 7;
    if (days === 0 && nextWall <= nowWall) days = 7;
    nextWall += days * 86_400_000;
  } else if (nextWall <= nowWall) {
    nextWall += 86_400_000;
  }
  // Asia/Shanghai 自1991年起固定 UTC+08:00；产品调度不接受远古日期。
  return new Date(nextWall - 8 * 3_600_000).toISOString();
}

export function describeContentPipelineSchedule(raw) {
  const timing = normalizeContentPipelineScheduleTiming(raw);
  if (timing.kind === "interval") return `每 ${timing.everyHours} 小时`;
  if (timing.kind === "weekly")
    return `每${WEEKDAYS[timing.weekday]} ${timing.atTime}`;
  return `每天 ${timing.atTime}`;
}

function executionPackage(raw = {}) {
  if (!isRecord(raw)) fail("计划执行包必须是对象", undefined, 400);
  const task = validatePaihuoContentBrief(raw.task || raw.brief || {});
  if (!isRecord(raw.persona || {})) fail("persona必须是对象", undefined, 400);
  if (!isRecord(raw.settings || {})) fail("settings必须是对象", undefined, 400);
  if (!isRecord(raw.workflow || {})) fail("workflow必须是对象", undefined, 400);
  const workflow = clone(raw.workflow || {});
  workflow.mode = cleanText(workflow.mode || "copilot", 40);
  if (!MODES.has(workflow.mode)) fail("workflow.mode无效", undefined, 400);
  if (
    workflow.approvalPolicy !== undefined &&
    !isRecord(workflow.approvalPolicy)
  ) {
    fail("workflow.approvalPolicy必须是对象", undefined, 400);
  }
  if (
    workflow.paidMediaAuthorized !== undefined &&
    typeof workflow.paidMediaAuthorized !== "boolean"
  ) {
    fail("workflow.paidMediaAuthorized必须是布尔值", undefined, 400);
  }
  if (workflow.paidMediaAuthorization !== undefined) {
    fail(
      "计划不能保存可过期的付费媒体签名",
      "CONTENT_PIPELINE_SCHEDULE_MEDIA_AUTHORIZATION_FORGED",
      400,
    );
  }
  return {
    task: clone(task),
    persona: clone(raw.persona || {}),
    settings: clone(raw.settings || {}),
    workflow,
  };
}

function scheduleRow(row) {
  if (!row) return null;
  const timing = {
    kind: row.kind,
    atTime: row.at_time,
    weekday: row.weekday === null ? null : Number(row.weekday),
    everyHours: row.every_hours === null ? null : Number(row.every_hours),
  };
  const lastPipelineId =
    row.last_pipeline_id == null ? null : Number(row.last_pipeline_id);
  return {
    schemaVersion: CONTENT_PIPELINE_SCHEDULE_SCHEMA,
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    name: row.name,
    enabled: Number(row.enabled) === 1,
    ...timing,
    human: describeContentPipelineSchedule(timing),
    task: parseJson(row.task_json, {}),
    persona: parseJson(row.persona_json, {}),
    settings: parseJson(row.settings_json, {}),
    workflow: parseJson(row.workflow_json, {}),
    createdBy: Number(row.created_by),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastNote: row.last_note,
    lastPipelineId,
    deepLink: lastPipelineId ? `/content?pipelineId=${lastPipelineId}` : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runRow(row) {
  if (!row) return null;
  const pipelineId = row.pipeline_id == null ? null : Number(row.pipeline_id);
  return {
    schemaVersion: CONTENT_PIPELINE_SCHEDULE_RUN_SCHEMA,
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    scheduleId: Number(row.schedule_id),
    trigger: row.trigger,
    occurrenceKey: row.occurrence_key,
    scheduledFor: row.scheduled_for,
    status: row.status,
    pipelineId,
    initiatedBy: Number(row.initiated_by),
    attempt: Number(row.attempt || 0),
    pipelineStatus: row.pipeline_status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    deepLink: pipelineId ? `/content?pipelineId=${pipelineId}` : null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

function errorEvidence(error) {
  return {
    code: cleanText(
      error?.code || error?.name || "CONTENT_PIPELINE_SCHEDULE_FAILED",
      160,
    ),
    message: cleanText(error?.message || "定时流水线开工失败", 500),
    status: Number(error?.status) || 500,
  };
}

function occurrenceKey(scheduleId, scheduledFor) {
  return `scheduled:${positiveInteger(scheduleId, "scheduleId")}:${instant(scheduledFor)}`;
}

export function createSqliteContentPipelineScheduleRepository({
  db,
  now = () => new Date(),
} = {}) {
  if (
    !db ||
    typeof db.prepare !== "function" ||
    typeof db.exec !== "function"
  ) {
    fail("计划仓库必须注入SQLite数据库", undefined, 500);
  }
  const timestamp = () => instant(now());
  const transaction = (operation) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 保留原错误 */
      }
      throw error;
    }
  };
  const getSchedule = (tenantId, scheduleId, { includeDeleted = false } = {}) =>
    scheduleRow(
      db
        .prepare(
          `SELECT * FROM content_pipeline_schedules
          WHERE tenant_id=? AND id=?${includeDeleted ? "" : " AND deleted_at IS NULL"}`,
        )
        .get(tenantId, scheduleId),
    );
  const getRun = (tenantId, runId) =>
    runRow(
      db
        .prepare(
          `SELECT * FROM content_pipeline_schedule_runs
          WHERE tenant_id=? AND id=?`,
        )
        .get(tenantId, runId),
    );

  return Object.freeze({
    ensureSchema() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS content_pipeline_schedules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
          kind TEXT NOT NULL CHECK(kind IN ('daily','weekly','interval')),
          at_time TEXT,
          weekday INTEGER CHECK(weekday BETWEEN 0 AND 6),
          every_hours INTEGER CHECK(every_hours BETWEEN 1 AND 720),
          task_json TEXT NOT NULL,
          persona_json TEXT NOT NULL DEFAULT '{}',
          settings_json TEXT NOT NULL DEFAULT '{}',
          workflow_json TEXT NOT NULL DEFAULT '{}',
          created_by INTEGER NOT NULL,
          next_run_at TEXT,
          last_run_at TEXT,
          last_status TEXT,
          last_note TEXT,
          last_pipeline_id INTEGER,
          deleted_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_content_pipeline_schedules_due
          ON content_pipeline_schedules(tenant_id,enabled,next_run_at,id)
          WHERE deleted_at IS NULL;
        CREATE TABLE IF NOT EXISTS content_pipeline_schedule_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          schedule_id INTEGER NOT NULL,
          trigger TEXT NOT NULL CHECK(trigger IN ('scheduled','immediate')),
          occurrence_key TEXT NOT NULL,
          scheduled_for TEXT,
          status TEXT NOT NULL CHECK(status IN ('claimed','launching','pipeline_created','failed')),
          pipeline_id INTEGER,
          initiated_by INTEGER NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 0,
          claim_token TEXT,
          claim_until TEXT,
          pipeline_status TEXT,
          error_code TEXT,
          error_message TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE(tenant_id,schedule_id,occurrence_key)
        );
        CREATE INDEX IF NOT EXISTS idx_content_pipeline_schedule_runs_schedule
          ON content_pipeline_schedule_runs(tenant_id,schedule_id,id DESC);
        CREATE INDEX IF NOT EXISTS idx_content_pipeline_schedule_runs_pipeline
          ON content_pipeline_schedule_runs(tenant_id,pipeline_id)
          WHERE pipeline_id IS NOT NULL;
      `);
    },

    getSchedule,
    getRun,

    list(tenantId, { createdBy = null, limit = 100 } = {}) {
      const tid = positiveInteger(tenantId, "tenantId");
      const size = Math.min(200, Math.max(1, Number(limit) || 100));
      const sql = `SELECT * FROM content_pipeline_schedules
        WHERE tenant_id=? AND deleted_at IS NULL${createdBy ? " AND created_by=?" : ""}
        ORDER BY id DESC LIMIT ?`;
      return db
        .prepare(sql)
        .all(
          tid,
          ...(createdBy ? [positiveInteger(createdBy, "createdBy")] : []),
          size,
        )
        .map(scheduleRow);
    },

    listRuns(tenantId, scheduleId, { limit = 20 } = {}) {
      return db
        .prepare(
          `SELECT * FROM content_pipeline_schedule_runs
          WHERE tenant_id=? AND schedule_id=? ORDER BY id DESC LIMIT ?`,
        )
        .all(
          positiveInteger(tenantId, "tenantId"),
          positiveInteger(scheduleId, "scheduleId"),
          Math.min(100, Math.max(1, Number(limit) || 20)),
        )
        .map(runRow);
    },

    create(input = {}) {
      const tenantId = positiveInteger(input.tenantId, "tenantId");
      const createdBy = positiveInteger(input.createdBy, "createdBy");
      const name = cleanText(input.name, 80);
      if (!name) fail("定时任务名称不能为空", undefined, 400);
      const timing = normalizeContentPipelineScheduleTiming(input);
      const pkg = executionPackage(input);
      const createdAt = timestamp();
      const nextRunAt =
        input.enabled === false
          ? null
          : computeNextContentPipelineSchedule(timing, now());
      const info = db
        .prepare(
          `INSERT INTO content_pipeline_schedules(
          tenant_id,name,enabled,kind,at_time,weekday,every_hours,
          task_json,persona_json,settings_json,workflow_json,created_by,
          next_run_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          tenantId,
          name,
          input.enabled === false ? 0 : 1,
          timing.kind,
          timing.atTime,
          timing.weekday,
          timing.everyHours,
          JSON.stringify(pkg.task),
          JSON.stringify(pkg.persona),
          JSON.stringify(pkg.settings),
          JSON.stringify(pkg.workflow),
          createdBy,
          nextRunAt,
          createdAt,
          createdAt,
        );
      return getSchedule(tenantId, Number(info.lastInsertRowid));
    },

    update(tenantId, scheduleId, patch = {}) {
      const tid = positiveInteger(tenantId, "tenantId");
      const sid = positiveInteger(scheduleId, "scheduleId");
      const current = getSchedule(tid, sid);
      if (!current) {
        fail(
          "内容流水线计划不存在",
          "CONTENT_PIPELINE_SCHEDULE_NOT_FOUND",
          404,
        );
      }
      const name =
        patch.name === undefined ? current.name : cleanText(patch.name, 80);
      if (!name) fail("定时任务名称不能为空", undefined, 400);
      const timing = normalizeContentPipelineScheduleTiming({
        kind: patch.kind ?? current.kind,
        atTime: patch.atTime ?? current.atTime,
        weekday: patch.weekday ?? current.weekday,
        everyHours: patch.everyHours ?? current.everyHours,
      });
      const pkg = executionPackage({
        task: patch.task ?? current.task,
        persona: patch.persona ?? current.persona,
        settings: patch.settings ?? current.settings,
        workflow: patch.workflow ?? current.workflow,
      });
      const enabled =
        patch.enabled === undefined ? current.enabled : patch.enabled === true;
      const timingChanged = [
        "kind",
        "atTime",
        "weekday",
        "everyHours",
        "enabled",
      ].some((key) => patch[key] !== undefined);
      const nextRunAt = !enabled
        ? null
        : timingChanged || !current.nextRunAt
          ? computeNextContentPipelineSchedule(timing, now())
          : current.nextRunAt;
      db.prepare(
        `UPDATE content_pipeline_schedules SET name=?,enabled=?,kind=?,at_time=?,
        weekday=?,every_hours=?,task_json=?,persona_json=?,settings_json=?,
        workflow_json=?,next_run_at=?,updated_at=?
        WHERE tenant_id=? AND id=? AND deleted_at IS NULL`,
      ).run(
        name,
        enabled ? 1 : 0,
        timing.kind,
        timing.atTime,
        timing.weekday,
        timing.everyHours,
        JSON.stringify(pkg.task),
        JSON.stringify(pkg.persona),
        JSON.stringify(pkg.settings),
        JSON.stringify(pkg.workflow),
        nextRunAt,
        timestamp(),
        tid,
        sid,
      );
      return getSchedule(tid, sid);
    },

    remove(tenantId, scheduleId) {
      const tid = positiveInteger(tenantId, "tenantId");
      const sid = positiveInteger(scheduleId, "scheduleId");
      const deletedAt = timestamp();
      const changed = db
        .prepare(
          `UPDATE content_pipeline_schedules
          SET enabled=0,next_run_at=NULL,deleted_at=?,updated_at=?
          WHERE tenant_id=? AND id=? AND deleted_at IS NULL`,
        )
        .run(deletedAt, deletedAt, tid, sid);
      if (!changed.changes) {
        fail(
          "内容流水线计划不存在",
          "CONTENT_PIPELINE_SCHEDULE_NOT_FOUND",
          404,
        );
      }
      return true;
    },

    claimDue(tenantId, dueNow = now(), { limit = 10 } = {}) {
      const tid = positiveInteger(tenantId, "tenantId");
      const nowDate = dueNow instanceof Date ? dueNow : new Date(dueNow);
      const nowIso = instant(nowDate);
      const candidates = db
        .prepare(
          `SELECT id FROM content_pipeline_schedules
          WHERE tenant_id=? AND enabled=1 AND deleted_at IS NULL
            AND next_run_at IS NOT NULL AND next_run_at<=?
          ORDER BY next_run_at,id LIMIT ?`,
        )
        .all(tid, nowIso, Math.min(50, Math.max(1, Number(limit) || 10)));
      const claims = [];
      for (const candidate of candidates) {
        const claim = transaction(() => {
          const schedule = db
            .prepare(
              `SELECT * FROM content_pipeline_schedules
              WHERE tenant_id=? AND id=? AND enabled=1 AND deleted_at IS NULL
                AND next_run_at IS NOT NULL AND next_run_at<=?`,
            )
            .get(tid, candidate.id, nowIso);
          if (!schedule) return null;
          const scheduledFor = schedule.next_run_at;
          const key = occurrenceKey(schedule.id, scheduledFor);
          db.prepare(
            `INSERT OR IGNORE INTO content_pipeline_schedule_runs(
            tenant_id,schedule_id,trigger,occurrence_key,scheduled_for,status,
            initiated_by,attempt,started_at,updated_at
          ) VALUES(?,?,'scheduled',?,?,'claimed',?,0,?,?)`,
          ).run(
            tid,
            schedule.id,
            key,
            scheduledFor,
            schedule.created_by,
            nowIso,
            nowIso,
          );
          const run = db
            .prepare(
              `SELECT * FROM content_pipeline_schedule_runs
              WHERE tenant_id=? AND schedule_id=? AND occurrence_key=?`,
            )
            .get(tid, schedule.id, key);
          if (run.pipeline_id) {
            db.prepare(
              `UPDATE content_pipeline_schedules
              SET last_run_at=COALESCE(last_run_at,?),last_status='pipeline_created',
                last_note=COALESCE(last_note,?),last_pipeline_id=?,next_run_at=?,updated_at=?
              WHERE tenant_id=? AND id=? AND next_run_at=?`,
            ).run(
              nowIso,
              `已恢复计划映射 → 流水线 #${run.pipeline_id}`,
              run.pipeline_id,
              computeNextContentPipelineSchedule(schedule, nowDate),
              nowIso,
              tid,
              schedule.id,
              scheduledFor,
            );
            return null;
          }
          if (
            run.claim_until &&
            Date.parse(run.claim_until) > nowDate.getTime()
          )
            return null;
          const token = randomUUID();
          const leaseUntil = new Date(
            nowDate.getTime() + CONTENT_PIPELINE_SCHEDULE_CLAIM_LEASE_MS,
          ).toISOString();
          const changed = db
            .prepare(
              `UPDATE content_pipeline_schedule_runs
              SET status='claimed',claim_token=?,claim_until=?,attempt=attempt+1,
                error_code=NULL,error_message=NULL,finished_at=NULL,updated_at=?
              WHERE tenant_id=? AND id=? AND pipeline_id IS NULL
                AND (claim_until IS NULL OR claim_until<=?)`,
            )
            .run(token, leaseUntil, nowIso, tid, run.id, nowIso);
          return changed.changes
            ? Object.freeze({
                tenantId: tid,
                scheduleId: Number(schedule.id),
                runId: Number(run.id),
                trigger: "scheduled",
                occurrenceKey: key,
                scheduledFor,
                initiatedBy: Number(schedule.created_by),
                claimToken: token,
              })
            : null;
        });
        if (claim) claims.push(claim);
      }
      return claims;
    },

    claimImmediate(tenantId, scheduleId, initiatedBy) {
      const tid = positiveInteger(tenantId, "tenantId");
      const sid = positiveInteger(scheduleId, "scheduleId");
      const actorId = positiveInteger(initiatedBy, "initiatedBy");
      return transaction(() => {
        if (!getSchedule(tid, sid)) {
          fail(
            "内容流水线计划不存在",
            "CONTENT_PIPELINE_SCHEDULE_NOT_FOUND",
            404,
          );
        }
        const startedAt = timestamp();
        const token = randomUUID();
        const key = `immediate:${sid}:${randomUUID()}`;
        const info = db
          .prepare(
            `INSERT INTO content_pipeline_schedule_runs(
            tenant_id,schedule_id,trigger,occurrence_key,status,initiated_by,
            attempt,claim_token,claim_until,started_at,updated_at
          ) VALUES(?,?,'immediate',?,'claimed',?,1,?,?,?,?)`,
          )
          .run(
            tid,
            sid,
            key,
            actorId,
            token,
            new Date(
              Date.parse(startedAt) + CONTENT_PIPELINE_SCHEDULE_CLAIM_LEASE_MS,
            ).toISOString(),
            startedAt,
            startedAt,
          );
        return Object.freeze({
          tenantId: tid,
          scheduleId: sid,
          runId: Number(info.lastInsertRowid),
          trigger: "immediate",
          occurrenceKey: key,
          scheduledFor: null,
          initiatedBy: actorId,
          claimToken: token,
        });
      });
    },

    markLaunching(claim) {
      const changed = db
        .prepare(
          `UPDATE content_pipeline_schedule_runs SET status='launching',updated_at=?
          WHERE tenant_id=? AND id=? AND claim_token=? AND pipeline_id IS NULL`,
        )
        .run(timestamp(), claim.tenantId, claim.runId, claim.claimToken);
      if (!changed.changes) {
        fail("计划触发租约已失效", "CONTENT_PIPELINE_SCHEDULE_CLAIM_LOST", 409);
      }
      return true;
    },

    markLaunched(claim, pipeline, launchedAt = now()) {
      const pipelineId = positiveInteger(
        pipeline?.id ?? pipeline?.pipelineId,
        "pipelineId",
      );
      const pipelineStatus = cleanText(pipeline?.status || "running", 80);
      const launchedIso = instant(launchedAt);
      return transaction(() => {
        const changed = db
          .prepare(
            `UPDATE content_pipeline_schedule_runs
            SET status='pipeline_created',pipeline_id=?,pipeline_status=?,
              claim_token=NULL,claim_until=NULL,error_code=NULL,error_message=NULL,
              finished_at=?,updated_at=?
            WHERE tenant_id=? AND id=? AND claim_token=? AND pipeline_id IS NULL`,
          )
          .run(
            pipelineId,
            pipelineStatus,
            launchedIso,
            launchedIso,
            claim.tenantId,
            claim.runId,
            claim.claimToken,
          );
        if (!changed.changes) {
          const existing = getRun(claim.tenantId, claim.runId);
          if (existing?.pipelineId !== pipelineId) {
            fail(
              "计划触发租约已失效",
              "CONTENT_PIPELINE_SCHEDULE_CLAIM_LOST",
              409,
            );
          }
        }
        const schedule = db
          .prepare(
            `SELECT * FROM content_pipeline_schedules
            WHERE tenant_id=? AND id=? AND deleted_at IS NULL`,
          )
          .get(claim.tenantId, claim.scheduleId);
        const nextRunAt =
          claim.trigger === "scheduled" && schedule?.enabled === 1
            ? computeNextContentPipelineSchedule(schedule, launchedAt)
            : schedule?.next_run_at || null;
        db.prepare(
          `UPDATE content_pipeline_schedules
          SET last_run_at=?,last_status='pipeline_created',last_note=?,
            last_pipeline_id=?,next_run_at=?,updated_at=?
          WHERE tenant_id=? AND id=? AND deleted_at IS NULL`,
        ).run(
          launchedIso,
          `${claim.trigger === "immediate" ? "手动触发" : "按时开工"} → 流水线 #${pipelineId}`,
          pipelineId,
          nextRunAt,
          launchedIso,
          claim.tenantId,
          claim.scheduleId,
        );
        return getRun(claim.tenantId, claim.runId);
      });
    },

    markFailed(claim, error, failedAt = now()) {
      const evidence = errorEvidence(error);
      const failedIso = instant(failedAt);
      const insufficient =
        evidence.status === 402 ||
        /(?:INSUFFICIENT|CREDIT|BALANCE)/iu.test(evidence.code);
      return transaction(() => {
        const changed = db
          .prepare(
            `UPDATE content_pipeline_schedule_runs
            SET status='failed',claim_token=NULL,claim_until=NULL,error_code=?,
              error_message=?,finished_at=?,updated_at=?
            WHERE tenant_id=? AND id=? AND claim_token=? AND pipeline_id IS NULL`,
          )
          .run(
            evidence.code,
            evidence.message,
            failedIso,
            failedIso,
            claim.tenantId,
            claim.runId,
            claim.claimToken,
          );
        if (!changed.changes) return getRun(claim.tenantId, claim.runId);
        const retryAt = new Date(
          Date.parse(failedIso) + CONTENT_PIPELINE_SCHEDULE_RETRY_DELAY_MS,
        ).toISOString();
        const deferred =
          evidence.code === "CONTENT_PIPELINE_SCHEDULE_PROVIDER_BUSY" ||
          evidence.code === "CONTENT_PIPELINE_SCHEDULE_CAPACITY_FULL";
        const lastStatus = insufficient ? "failed" : deferred ? "deferred" : "failed";
        const lastNote = insufficient
          ? `积分不足已暂停：${evidence.message}`
          : evidence.code === "CONTENT_PIPELINE_SCHEDULE_PROVIDER_BUSY"
            ? claim.trigger === "scheduled"
              ? "已有流水线正在占用模型，10分钟后重试"
              : "已有流水线正在占用模型，本次未另外开工"
            : evidence.code === "CONTENT_PIPELINE_SCHEDULE_CAPACITY_FULL"
              ? claim.trigger === "scheduled"
                ? "并行流水线已满，10分钟后重试"
                : "并行流水线已满，本次未另外开工"
              : `开工失败，10分钟后重试：${evidence.message}`;
        db.prepare(
          `UPDATE content_pipeline_schedules SET
          enabled=CASE WHEN ? THEN 0 ELSE enabled END,
          next_run_at=CASE WHEN ? THEN NULL WHEN ?='scheduled' THEN ? ELSE next_run_at END,
          last_run_at=?,last_status=?,last_note=?,updated_at=?
          WHERE tenant_id=? AND id=? AND deleted_at IS NULL`,
        ).run(
          insufficient ? 1 : 0,
          insufficient ? 1 : 0,
          claim.trigger,
          retryAt,
          failedIso,
          lastStatus,
          lastNote,
          failedIso,
          claim.tenantId,
          claim.scheduleId,
        );
        return getRun(claim.tenantId, claim.runId);
      });
    },

    markPipelineState(tenantId, runId, pipeline) {
      const tid = positiveInteger(tenantId, "tenantId");
      const rid = positiveInteger(runId, "runId");
      const pipelineId = positiveInteger(
        pipeline?.id ?? pipeline?.pipelineId,
        "pipelineId",
      );
      const status = cleanText(pipeline?.status || "running", 80);
      const updatedAt = timestamp();
      db.prepare(
        `UPDATE content_pipeline_schedule_runs SET pipeline_status=?,updated_at=?
        WHERE tenant_id=? AND id=? AND pipeline_id=?`,
      ).run(status, updatedAt, tid, rid, pipelineId);
      db.prepare(
        `UPDATE content_pipeline_schedules SET last_status=?,updated_at=?
        WHERE tenant_id=? AND id=(
          SELECT schedule_id FROM content_pipeline_schedule_runs
          WHERE tenant_id=? AND id=? AND pipeline_id=?
        )`,
      ).run(status, updatedAt, tid, tid, rid, pipelineId);
      return getRun(tid, rid);
    },
  });
}

export function createContentPipelineScheduleService({
  repository,
  preflight,
  findExistingPipeline = () => null,
  createPipeline,
  resumePipeline,
  notify = () => {},
  now = () => new Date(),
} = {}) {
  if (
    !repository ||
    typeof repository.claimDue !== "function" ||
    typeof repository.claimImmediate !== "function"
  ) {
    fail("计划服务缺少持久化仓库", undefined, 500);
  }
  if (
    typeof preflight !== "function" ||
    typeof findExistingPipeline !== "function" ||
    typeof createPipeline !== "function" ||
    typeof resumePipeline !== "function"
  ) {
    fail("计划服务缺少流水线执行依赖", undefined, 500);
  }

  const launch = async (claim) => {
    const schedule = repository.getSchedule(claim.tenantId, claim.scheduleId);
    if (!schedule) {
      const error = new ContentPipelineScheduleError(
        "内容流水线计划不存在",
        "CONTENT_PIPELINE_SCHEDULE_NOT_FOUND",
        404,
      );
      repository.markFailed(claim, error, now());
      throw error;
    }
    const idempotency = {
      namespace: "content_pipeline_schedule",
      key: `${claim.scheduleId}:${claim.occurrenceKey}`,
    };
    const finishLaunch = (pipeline) => {
      const run = repository.markLaunched(claim, pipeline, now());
      try {
        notify({ claim, schedule, pipeline, run });
      } catch {
        /* 通知失败不改变业务终态 */
      }
      return { claim, schedule, pipeline, run };
    };
    try {
      let pipeline = await findExistingPipeline({
        tenantId: claim.tenantId,
        idempotency,
      });
      let workflow = clone(schedule.workflow);
      if (!pipeline) {
        const checked =
          (await preflight({ claim, schedule, idempotency })) || {};
        if (checked.workflow) workflow = clone(checked.workflow);
        repository.markLaunching(claim);
        pipeline = await createPipeline({
          tenantId: claim.tenantId,
          createdBy: schedule.createdBy,
          title: schedule.task.direction || schedule.name,
          task: clone(schedule.task),
          persona: clone(schedule.persona),
          settings: {
            ...clone(schedule.settings),
            scheduleOrigin: {
              schemaVersion: CONTENT_PIPELINE_SCHEDULE_RUN_SCHEMA,
              scheduleId: schedule.id,
              scheduleName: schedule.name,
              runId: claim.runId,
              trigger: claim.trigger,
              occurrenceKey: claim.occurrenceKey,
              scheduledFor: claim.scheduledFor,
            },
          },
          workflow,
          idempotency,
        });
      }
      return finishLaunch(pipeline);
    } catch (error) {
      // pipeline.create 与计划映射分属两个事务。若调用方在流水线已提交后抛错，
      // 先按幂等键找回原流水线，避免把 next_run_at 推到新 occurrence 后重复创建。
      try {
        const recovered = await findExistingPipeline({
          tenantId: claim.tenantId,
          idempotency,
        });
        if (recovered) return finishLaunch(recovered);
      } catch {
        /* 找回失败时保留原始开工错误作为运行证据 */
      }
      repository.markFailed(claim, error, now());
      throw error;
    }
  };

  const resumeLaunched = async (launched) => {
    const { claim } = launched;
    const pipeline = await resumePipeline({
      tenantId: claim.tenantId,
      pipelineId: launched.pipeline.id,
    });
    repository.markPipelineState(claim.tenantId, claim.runId, pipeline);
    return { ...launched, pipeline };
  };

  const execute = async (claim) => resumeLaunched(await launch(claim));

  return Object.freeze({
    repository,
    list: (...args) => repository.list(...args),
    listRuns: (...args) => repository.listRuns(...args),
    getSchedule: (...args) => repository.getSchedule(...args),
    getRun: (...args) => repository.getRun(...args),
    create: (...args) => repository.create(...args),
    update: (...args) => repository.update(...args),
    remove: (...args) => repository.remove(...args),
    claimImmediate: (...args) => repository.claimImmediate(...args),
    launch,
    resumeLaunched,
    execute,
    async tick({ tenantId, now: tickNow = now(), limit = 10 } = {}) {
      const outcomes = [];
      for (const claim of repository.claimDue(tenantId, tickNow, { limit })) {
        try {
          const result = await execute(claim);
          outcomes.push({
            tenantId: claim.tenantId,
            scheduleId: claim.scheduleId,
            runId: claim.runId,
            pipelineId: Number(result.pipeline.id),
            status: result.pipeline.status,
          });
        } catch (error) {
          outcomes.push({
            tenantId: claim.tenantId,
            scheduleId: claim.scheduleId,
            runId: claim.runId,
            pipelineId:
              repository.getRun(claim.tenantId, claim.runId)?.pipelineId ||
              null,
            status: "failed",
            error: errorEvidence(error),
          });
        }
      }
      return outcomes;
    },
  });
}

import { createHash, randomUUID } from "node:crypto";
import { curTenant, db, q } from "../db.js";

export const TOOLBOX_AUTOMATION_KEYS = Object.freeze([
  "hot_daily",
  "bench_weekly",
]);

export const TOOLBOX_HOT_CHANNELS = Object.freeze([
  "微博热搜",
  "抖音热点",
  "小红书热门",
  "百度热搜",
  "知乎热榜",
  "B站热门",
  "今日头条",
  "36氪/虎嗅",
  "行业垂直媒体",
  "X(Twitter)",
]);

const AUTOMATION_META = Object.freeze({
  hot_daily: Object.freeze({
    toolKey: "hot",
    employeeIdx: 141,
    label: "每日必发",
    retryMinutes: 30,
  }),
  bench_weekly: Object.freeze({
    toolKey: "bench",
    employeeIdx: 102,
    label: "竞品盯梢周报",
    retryMinutes: 30,
  }),
});

const SHANGHAI_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

const ACTIVE_STATUSES = Object.freeze([
  "claimed",
  "enqueuing",
  "running",
  "completing",
]);
const AUTOMATION_STALE_MS = 15 * 60 * 1_000;
const BENCH_GUARD_MS = 3 * 24 * 60 * 60 * 1_000;
const SAFE_IDEMPOTENCY = /^[a-z0-9][a-z0-9._:-]{7,127}$/iu;

export class ToolboxAutomationError extends Error {
  constructor(
    message,
    { status = 400, code = "TOOLBOX_AUTOMATION_INVALID" } = {},
  ) {
    super(message);
    this.name = "ToolboxAutomationError";
    this.status = status;
    this.code = code;
  }
}

function automationMeta(key) {
  const normalized = String(key || "").trim();
  const meta = AUTOMATION_META[normalized];
  if (!meta) {
    throw new ToolboxAutomationError(
      `automationKey仅支持：${TOOLBOX_AUTOMATION_KEYS.join("、")}`,
    );
  }
  return { key: normalized, ...meta };
}

function parseObject(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

function clean(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function unixMs(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isoAt(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

export function toolboxAutomationClock(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) {
    throw new ToolboxAutomationError("调度时间不正确");
  }
  const parts = Object.fromEntries(
    SHANGHAI_CLOCK.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday,
    local: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:00`,
    nowMs: date.getTime(),
    nowIso: date.toISOString(),
  };
}

function mondayFor(clock) {
  const index =
    { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[clock.weekday] ??
    0;
  const date = new Date(`${clock.date}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - index);
  return date.toISOString().slice(0, 10);
}

export function toolboxAutomationPeriodKey(key, now = new Date()) {
  const meta = automationMeta(key);
  const clock = toolboxAutomationClock(now);
  return meta.key === "hot_daily"
    ? `${meta.key}:${clock.date}`
    : `${meta.key}:${mondayFor(clock)}`;
}

function normalizeHotConfig(body) {
  const industry = clean(body?.industry || "通用", 20) || "通用";
  const requested = Array.isArray(body?.channels) ? body.channels : [];
  const channels = Array.from(
    new Set(
      requested
        .map((item) => clean(item, 30))
        .filter((item) => TOOLBOX_HOT_CHANNELS.includes(item)),
    ),
  ).slice(0, 10);
  return {
    enabled: body?.enabled === true,
    industry,
    channels: channels.length ? channels : TOOLBOX_HOT_CHANNELS.slice(0, 4),
  };
}

function normalizeBenchConfig(body) {
  const rows = Array.isArray(body?.targets) ? body.targets : [];
  const targets = rows
    .map((row) => ({
      name: clean(row?.name, 30),
      platform: clean(row?.platform, 12),
      note: clean(row?.note, 60),
    }))
    .filter((row) => row.name)
    .slice(0, 8);
  return {
    enabled: body?.enabled === true && targets.length > 0,
    targets,
  };
}

export function normalizeToolboxAutomationConfig(key, body = {}) {
  const meta = automationMeta(key);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ToolboxAutomationError("自动化配置必须是对象");
  }
  const allowed = new Set(
    meta.key === "hot_daily"
      ? ["enabled", "industry", "channels"]
      : ["enabled", "targets"],
  );
  const unknown = Object.keys(body).find((field) => !allowed.has(field));
  if (unknown) {
    throw new ToolboxAutomationError(`自动化配置不支持字段：${unknown}`);
  }
  return meta.key === "hot_daily"
    ? normalizeHotConfig(body)
    : normalizeBenchConfig(body);
}

function publicConfig(row, key = row?.automation_key) {
  const meta = automationMeta(key);
  const config = parseObject(row?.config_json, {});
  return {
    key: meta.key,
    label: meta.label,
    ...config,
    enabled: row ? row.enabled === 1 : config.enabled === true,
    createdBy: row?.created_by == null ? null : Number(row.created_by),
    lastSuccessKey: row?.last_success_key || null,
    lastSuccessAt: row?.last_success_at || null,
    lastToolRunId:
      row?.last_tool_run_id == null ? null : Number(row.last_tool_run_id),
    note: row?.note || "",
    updatedAt: row?.updated_at || null,
    schedule:
      meta.key === "hot_daily"
        ? "Asia/Shanghai 每日07:00–09:59，每日成功一次"
        : "Asia/Shanghai 周一09:00–11:59，三日内不重复",
  };
}

export function getToolboxAutomationConfig(key) {
  const meta = automationMeta(key);
  const row = q.get(
    `SELECT * FROM toolbox_automation_configs
    WHERE tenant_id=? AND automation_key=?`,
    curTenant(),
    meta.key,
  );
  if (row) return publicConfig(row, meta.key);
  const defaults =
    meta.key === "hot_daily"
      ? normalizeHotConfig({ enabled: false })
      : normalizeBenchConfig({ enabled: false });
  return publicConfig(
    {
      automation_key: meta.key,
      enabled: 0,
      config_json: JSON.stringify(defaults),
    },
    meta.key,
  );
}

export function listToolboxAutomationConfigs() {
  return TOOLBOX_AUTOMATION_KEYS.map((key) => getToolboxAutomationConfig(key));
}

export function saveToolboxAutomationConfig(key, body, user) {
  const meta = automationMeta(key);
  const tenantId = Number(user?.tenant_id || curTenant());
  const userId = Number(user?.id);
  if (
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    tenantId !== curTenant()
  ) {
    throw new ToolboxAutomationError("自动化配置缺少有效的租户操作人", {
      status: 403,
      code: "TOOLBOX_AUTOMATION_OWNER_INVALID",
    });
  }
  const config = normalizeToolboxAutomationConfig(meta.key, body);
  q.run(
    `INSERT INTO toolbox_automation_configs(
      tenant_id,automation_key,enabled,created_by,config_json,note,created_at,updated_at
    ) VALUES(?,?,?,?,?,'',datetime('now','localtime'),datetime('now','localtime'))
    ON CONFLICT(tenant_id,automation_key) DO UPDATE SET
      enabled=excluded.enabled,created_by=excluded.created_by,
      config_json=excluded.config_json,note='',updated_at=excluded.updated_at`,
    tenantId,
    meta.key,
    config.enabled ? 1 : 0,
    userId,
    JSON.stringify(config),
  );
  return getToolboxAutomationConfig(meta.key);
}

export function toolboxAutomationDue(key, config, now = new Date()) {
  const meta = automationMeta(key);
  const clock = toolboxAutomationClock(now);
  if (config?.enabled !== true) return false;
  if (meta.key === "hot_daily") {
    return clock.hour >= 7 && clock.hour <= 9;
  }
  if (
    clock.weekday !== "Mon" ||
    clock.hour < 9 ||
    clock.hour > 11 ||
    !Array.isArray(config?.targets) ||
    config.targets.length === 0
  ) {
    return false;
  }
  const last = unixMs(config.lastSuccessAt);
  return last == null || clock.nowMs - last >= BENCH_GUARD_MS;
}

export function buildToolboxAutomationRequest(key, config, now = new Date()) {
  const meta = automationMeta(key);
  const clock = toolboxAutomationClock(now);
  if (meta.key === "hot_daily") {
    const normalized = normalizeHotConfig(config);
    return {
      toolKey: meta.toolKey,
      employeeIdx: meta.employeeIdx,
      title: `每日自动·今日必发·${clock.date}`,
      inputs: {
        store: normalized.industry,
        channels: normalized.channels,
        focus: `今天是${clock.date}，只扫描已勾选渠道，找出3个今天发正合适的${normalized.industry}选题：升温热点、行业新动态或未来7天节点。每条必须写明热度证据、来源渠道、切入角度和可直接开工的brief。`,
      },
    };
  }
  const normalized = normalizeBenchConfig({
    ...config,
    enabled: config?.enabled === true,
  });
  if (!normalized.targets.length) {
    throw new ToolboxAutomationError("先添加要盯的对标账号或品牌", {
      code: "TOOLBOX_BENCH_TARGETS_REQUIRED",
    });
  }
  const targets = normalized.targets
    .map(
      (target) =>
        `${target.name}${target.platform ? `(${target.platform})` : ""}${target.note ? `：${target.note}` : ""}`,
    )
    .join("\n");
  return {
    toolKey: meta.toolKey,
    employeeIdx: meta.employeeIdx,
    title: `每周自动·竞品盯梢·${clock.date}`,
    inputs: {
      targets,
      period: "近7天",
      focus:
        "逐个调研新内容、新活动、新玩法和舆情；只报本次受控正文取证到的真实信息，未查到必须明写“本周未见公开动态”，并给出3个我方可验收跟进动作。",
    },
  };
}

function publicRun(row) {
  if (!row) return null;
  const result = parseObject(row.result_snapshot_json, {});
  return {
    id: Number(row.id),
    key: row.automation_key,
    trigger: row.trigger,
    claimKey: row.claim_key,
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    toolRunId: row.tool_run_id == null ? null : Number(row.tool_run_id),
    deepLink:
      result.deepLink ||
      (row.tool_run_id
        ? `/tasks?kind=tool&id=${encodeURIComponent(String(row.tool_run_id))}`
        : null),
    knowledgeId: row.knowledge_id == null ? null : Number(row.knowledge_id),
    notificationId:
      row.notification_id == null ? null : Number(row.notification_id),
    retryAt: row.next_retry_at || null,
    failure: parseObject(row.failure_json, null),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function getToolboxAutomationRun(id) {
  const parsed = Number(id);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ToolboxAutomationError("自动化运行ID不正确");
  }
  return publicRun(
    q.get(
      `SELECT * FROM toolbox_automation_runs WHERE tenant_id=? AND id=?`,
      curTenant(),
      parsed,
    ),
  );
}

function activeRun(key) {
  return q.get(
    `SELECT * FROM toolbox_automation_runs
    WHERE tenant_id=? AND automation_key=?
      AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})
    ORDER BY id DESC LIMIT 1`,
    curTenant(),
    key,
    ...ACTIVE_STATUSES,
  );
}

function safeFailure(error) {
  return {
    code: clean(error?.code || "TOOLBOX_AUTOMATION_FAILED", 120),
    message: clean(error?.message || "自动化运行失败", 500),
    status: Number(error?.status) || 500,
  };
}

function scheduledClaimKey(key, now) {
  return toolboxAutomationPeriodKey(key, now);
}

function manualClaimKey(key, idempotencyKey) {
  const raw = clean(idempotencyKey || randomUUID(), 128);
  if (!SAFE_IDEMPOTENCY.test(raw)) {
    throw new ToolboxAutomationError(
      "Idempotency-Key必须为8-128位字母、数字或 ._:-",
      { code: "TOOLBOX_AUTOMATION_IDEMPOTENCY_INVALID" },
    );
  }
  const digest = createHash("sha256").update(raw).digest("hex");
  return `manual:${key}:${digest}`;
}

function claimRow({ key, claimKey, trigger, config, userId, request, now }) {
  const tenantId = curTenant();
  const inserted = q.run(
    `INSERT OR IGNORE INTO toolbox_automation_runs(
      tenant_id,automation_key,trigger,claim_key,status,attempt_count,created_by,
      config_snapshot_json,request_json,created_at,started_at,updated_at
    ) VALUES(?,?,?,?, 'claimed',1,?,?,?, ?,?,?)`,
    tenantId,
    key,
    trigger,
    claimKey,
    Number(userId),
    JSON.stringify(config),
    JSON.stringify(request),
    isoAt(now),
    isoAt(now),
    isoAt(now),
  );
  const existing = q.get(
    `SELECT * FROM toolbox_automation_runs
    WHERE tenant_id=? AND claim_key=?`,
    tenantId,
    claimKey,
  );
  return { row: existing, claimed: Number(inserted.changes) === 1 };
}

function retryFailedScheduledClaim(row, config, request, now) {
  if (row.trigger !== "scheduled" || row.status !== "failed") return false;
  const retryAt = unixMs(row.next_retry_at);
  if (retryAt != null && retryAt > now.getTime()) return false;
  const prior = Array.isArray(
    parseObject(row.result_snapshot_json, {}).attemptToolRunIds,
  )
    ? parseObject(row.result_snapshot_json, {}).attemptToolRunIds
    : [];
  if (row.tool_run_id) prior.push(Number(row.tool_run_id));
  const changed = q.run(
    `UPDATE toolbox_automation_runs SET status='claimed',attempt_count=attempt_count+1,
      tool_run_id=NULL,config_snapshot_json=?,request_json=?,failure_json=NULL,
      result_snapshot_json=?,next_retry_at=NULL,started_at=?,finished_at=NULL,updated_at=?
    WHERE tenant_id=? AND id=? AND status='failed'`,
    JSON.stringify(config),
    JSON.stringify(request),
    JSON.stringify({ attemptToolRunIds: Array.from(new Set(prior)) }),
    isoAt(now),
    isoAt(now),
    curTenant(),
    row.id,
  );
  return Number(changed.changes) === 1;
}

function configRow(key) {
  return q.get(
    `SELECT * FROM toolbox_automation_configs
    WHERE tenant_id=? AND automation_key=?`,
    curTenant(),
    key,
  );
}

export function claimDueToolboxAutomations(now = new Date()) {
  const clock = toolboxAutomationClock(now);
  const date = new Date(clock.nowMs);
  const claims = [];
  for (const key of TOOLBOX_AUTOMATION_KEYS) {
    const row = configRow(key);
    if (!row) continue;
    const config = publicConfig(row, key);
    if (!toolboxAutomationDue(key, config, date)) continue;
    if (activeRun(key)) continue;
    const request = buildToolboxAutomationRequest(key, config, date);
    const claimKey = scheduledClaimKey(key, date);
    let claim = claimRow({
      key,
      claimKey,
      trigger: "scheduled",
      config,
      userId: row.created_by,
      request,
      now: date,
    });
    if (
      !claim.claimed &&
      retryFailedScheduledClaim(claim.row, config, request, date)
    ) {
      claim = {
        claimed: true,
        row: q.get(
          `SELECT * FROM toolbox_automation_runs WHERE tenant_id=? AND id=?`,
          curTenant(),
          claim.row.id,
        ),
      };
    }
    if (claim.claimed) claims.push(publicRun(claim.row));
  }
  return claims;
}

export function claimManualToolboxAutomation(
  key,
  { user, idempotencyKey, now = new Date() } = {},
) {
  const meta = automationMeta(key);
  const config = getToolboxAutomationConfig(meta.key);
  if (meta.key === "bench_weekly" && !config.targets?.length) {
    throw new ToolboxAutomationError("先在自动盯梢里添加对标账号并保存", {
      code: "TOOLBOX_BENCH_TARGETS_REQUIRED",
    });
  }
  const userId = Number(user?.id);
  if (
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    Number(user?.tenant_id) !== curTenant()
  ) {
    throw new ToolboxAutomationError("手动运行缺少有效操作人", {
      status: 403,
      code: "TOOLBOX_AUTOMATION_OWNER_INVALID",
    });
  }
  const claimKey = manualClaimKey(meta.key, idempotencyKey);
  const existing = q.get(
    `SELECT * FROM toolbox_automation_runs
    WHERE tenant_id=? AND claim_key=?`,
    curTenant(),
    claimKey,
  );
  if (existing)
    return { claimed: false, idempotent: true, run: publicRun(existing) };
  const active = activeRun(meta.key);
  if (active) {
    throw new ToolboxAutomationError("该自动化已在运行，请到任务中心查看进度", {
      status: 409,
      code: "TOOLBOX_AUTOMATION_BUSY",
    });
  }
  const request = buildToolboxAutomationRequest(meta.key, config, now);
  const claim = claimRow({
    key: meta.key,
    claimKey,
    trigger: "manual",
    config,
    userId,
    request,
    now,
  });
  return {
    claimed: claim.claimed,
    idempotent: !claim.claimed,
    run: publicRun(claim.row),
  };
}

function executionClaim(id) {
  return q.get(
    `SELECT r.*,u.name user_name,u.role user_role,u.status user_status
    FROM toolbox_automation_runs r
    LEFT JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.created_by
    WHERE r.tenant_id=? AND r.id=?`,
    curTenant(),
    Number(id),
  );
}

function markExecutionFailure(row, error, now) {
  const failure = safeFailure(error);
  const insufficient = failure.status === 402;
  const nextRetryAt =
    row.trigger === "scheduled" && !insufficient
      ? new Date(
          now.getTime() +
            AUTOMATION_META[row.automation_key].retryMinutes * 60_000,
        ).toISOString()
      : null;
  q.run(
    `UPDATE toolbox_automation_runs SET status='failed',failure_json=?,next_retry_at=?,
      finished_at=?,updated_at=? WHERE tenant_id=? AND id=? AND status<>'done'`,
    JSON.stringify(failure),
    nextRetryAt,
    isoAt(now),
    isoAt(now),
    curTenant(),
    row.id,
  );
  if (insufficient) {
    q.run(
      `UPDATE toolbox_automation_configs SET enabled=0,note=?,updated_at=?
      WHERE tenant_id=? AND automation_key=?`,
      "积分不足已暂停",
      isoAt(now),
      curTenant(),
      row.automation_key,
    );
  }
  return getToolboxAutomationRun(row.id);
}

export async function executeToolboxAutomationClaim(
  claim,
  { createToolboxRunFn, appLocals = {}, now = new Date() } = {},
) {
  if (typeof createToolboxRunFn !== "function") {
    throw new TypeError("createToolboxRunFn must be a function");
  }
  const id = Number(claim?.id ?? claim);
  let row = executionClaim(id);
  if (!row) {
    throw new ToolboxAutomationError("自动化运行不存在", {
      status: 404,
      code: "TOOLBOX_AUTOMATION_NOT_FOUND",
    });
  }
  if (row.status === "done" || row.status === "running") {
    return getToolboxAutomationRun(id);
  }
  if (row.status !== "claimed") {
    return getToolboxAutomationRun(id);
  }
  if (row.user_status !== "启用" || !row.user_role) {
    return markExecutionFailure(
      row,
      Object.assign(new Error("自动化归属人已停用或不存在"), {
        status: 409,
        code: "TOOLBOX_AUTOMATION_OWNER_DISABLED",
      }),
      now,
    );
  }
  const claimed = q.run(
    `UPDATE toolbox_automation_runs SET status='enqueuing',updated_at=?
    WHERE tenant_id=? AND id=? AND status='claimed'`,
    isoAt(now),
    curTenant(),
    id,
  );
  if (Number(claimed.changes) !== 1) return getToolboxAutomationRun(id);
  row = executionClaim(id);
  try {
    const response = await createToolboxRunFn({
      body: parseObject(row.request_json, {}),
      user: {
        id: Number(row.created_by),
        tenant_id: Number(row.tenant_id),
        name: row.user_name || "自动化操作人",
        role: row.user_role,
      },
      appLocals,
      automation: {
        id: Number(row.id),
        key: row.automation_key,
        trigger: row.trigger,
        claimKey: row.claim_key,
        attemptCount: Number(row.attempt_count || 1),
      },
    });
    const toolRunId = Number(
      response?.runId ?? response?.run?.id ?? response?.id,
    );
    if (!Number.isSafeInteger(toolRunId) || toolRunId <= 0) {
      throw Object.assign(new Error("工具后台任务未返回有效runId"), {
        status: 500,
        code: "TOOLBOX_AUTOMATION_ENQUEUE_NO_RUN",
      });
    }
    q.run(
      `UPDATE toolbox_automation_runs SET status='running',tool_run_id=?,updated_at=?
      WHERE tenant_id=? AND id=? AND status='enqueuing'`,
      toolRunId,
      isoAt(now),
      curTenant(),
      id,
    );
    return getToolboxAutomationRun(id);
  } catch (error) {
    const current = executionClaim(id);
    if (current?.tool_run_id) {
      q.run(
        `UPDATE toolbox_automation_runs SET status='running',updated_at=?
        WHERE tenant_id=? AND id=? AND status='enqueuing'`,
        isoAt(now),
        curTenant(),
        id,
      );
      return getToolboxAutomationRun(id);
    }
    return markExecutionFailure(current || row, error, now);
  }
}

function toolBilling(row) {
  return parseObject(row?.provenance_json, {}).billing || {};
}

function toolContract(row) {
  return parseObject(row?.provenance_json, {}).contract || {};
}

function toolIsUsable(row) {
  const provenance = parseObject(row?.provenance_json, {});
  return (
    row?.status === "done" &&
    provenance.mode === "api" &&
    provenance.persisted === true &&
    provenance.contract?.valid === true &&
    provenance.billing?.state === "settled" &&
    Boolean(clean(row.result_md, 1))
  );
}

function resultSummary(markdown, max = 220) {
  return clean(
    String(markdown || "")
      .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
      .replace(/\[[^\]]+\]\([^)]*\)/gu, "")
      .replace(/[#>*_`|~-]+/gu, " "),
    max,
  );
}

function completeAutomation(row, tool, now) {
  const tenantId = Number(row.tenant_id);
  const deepLink = `/tasks?kind=tool&id=${encodeURIComponent(String(tool.id))}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    const claimed = db
      .prepare(
        `UPDATE toolbox_automation_runs SET status='completing',updated_at=?
        WHERE tenant_id=? AND id=? AND status='running' AND tool_run_id=?`,
      )
      .run(isoAt(now), tenantId, row.id, tool.id);
    if (Number(claimed.changes) !== 1) {
      db.exec("ROLLBACK");
      return null;
    }
    let knowledgeId = null;
    if (row.automation_key === "bench_weekly") {
      db.prepare(
        `INSERT OR IGNORE INTO kb_docs(
          tenant_id,category,title,body,source_type,source_id,enabled,ref_count,updated_at
        ) VALUES(?,?,?,?,?,?,1,0,?)`,
      ).run(
        tenantId,
        "竞品盯梢",
        `竞品盯梢周报 ${toolboxAutomationClock(now).date}`,
        tool.result_md,
        "toolbox_automation",
        row.id,
        isoAt(now),
      );
      knowledgeId = db
        .prepare(
          `SELECT id FROM kb_docs
          WHERE tenant_id=? AND source_type='toolbox_automation' AND source_id=?`,
        )
        .get(tenantId, row.id)?.id;
    }
    const title =
      row.automation_key === "hot_daily"
        ? `今日必发(${parseObject(row.config_snapshot_json, {}).industry || "通用"})`
        : "竞品盯梢周报";
    const notification = db
      .prepare(
        `INSERT INTO notifications(tenant_id,user_id,type,title,body,link)
        VALUES(?,?,'report',?,?,?)`,
      )
      .run(
        tenantId,
        row.created_by,
        title,
        resultSummary(tool.result_md) || "自动任务已完成，请到任务中心查看。",
        deepLink,
      );
    const result = {
      toolRunId: Number(tool.id),
      deepLink,
      knowledgeId: knowledgeId == null ? null : Number(knowledgeId),
      notificationId: Number(notification.lastInsertRowid),
      billing: toolBilling(tool),
      usage: parseObject(tool.provenance_json, {}).usage || null,
    };
    db.prepare(
      `UPDATE toolbox_automation_runs SET status='done',result_snapshot_json=?,
        failure_json=NULL,knowledge_id=?,notification_id=?,next_retry_at=NULL,
        finished_at=?,updated_at=?
      WHERE tenant_id=? AND id=? AND status='completing'`,
    ).run(
      JSON.stringify(result),
      knowledgeId,
      notification.lastInsertRowid,
      isoAt(now),
      isoAt(now),
      tenantId,
      row.id,
    );
    db.prepare(
      `UPDATE toolbox_automation_configs SET last_success_key=?,last_success_at=?,
        last_tool_run_id=?,note='',updated_at=?
      WHERE tenant_id=? AND automation_key=?`,
    ).run(
      row.claim_key,
      isoAt(now),
      tool.id,
      isoAt(now),
      tenantId,
      row.automation_key,
    );
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw error;
  }
}

function markToolFailure(row, tool, now) {
  const billing = toolBilling(tool);
  const error = parseObject(tool.error_json, {});
  const reconciliation = [
    "held",
    "pending_reconciliation",
    "unsettled",
  ].includes(String(billing.state || ""));
  // 账务尚未进入权威终态时保留原 claim，既不写沉淀也不重试新任务。
  // 否则可能在旧 hold 未释放时又创建一笔新预授权。
  if (reconciliation) return null;
  return markExecutionFailure(
    row,
    Object.assign(new Error(error.message || "工具任务未形成可交付结果"), {
      status: 502,
      code: error.code || "TOOLBOX_AUTOMATION_TOOL_FAILED",
    }),
    now,
  );
}

export function reconcileToolboxAutomationRuns(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const rows = q.all(
    `SELECT * FROM toolbox_automation_runs
    WHERE tenant_id=? AND status IN ('claimed','enqueuing','running','completing')
    ORDER BY id`,
    curTenant(),
  );
  const outcomes = [];
  for (const row of rows) {
    if (row.status === "completing") {
      // 正常完成会与业务沉淀同事务提交；独立出现 completing 只可能是历史异常状态。
      outcomes.push(
        markExecutionFailure(
          row,
          Object.assign(new Error("自动化完成事务未收敛"), {
            status: 500,
            code: "TOOLBOX_AUTOMATION_COMMIT_INTERRUPTED",
          }),
          date,
        ),
      );
      continue;
    }
    if (!row.tool_run_id) {
      const started = unixMs(
        row.updated_at || row.started_at || row.created_at,
      );
      if (started != null && date.getTime() - started > AUTOMATION_STALE_MS) {
        outcomes.push(
          markExecutionFailure(
            row,
            Object.assign(new Error("自动化入队中断，未创建工具任务"), {
              status: 504,
              code: "TOOLBOX_AUTOMATION_ENQUEUE_STALE",
            }),
            date,
          ),
        );
      }
      continue;
    }
    const tool = q.get(
      `SELECT * FROM tool_runs WHERE tenant_id=? AND id=?`,
      curTenant(),
      row.tool_run_id,
    );
    if (!tool) {
      outcomes.push(
        markExecutionFailure(
          row,
          Object.assign(new Error("自动化关联的工具任务不存在"), {
            status: 500,
            code: "TOOLBOX_AUTOMATION_TOOL_MISSING",
          }),
          date,
        ),
      );
      continue;
    }
    if (toolIsUsable(tool)) {
      completeAutomation(row, tool, date);
      outcomes.push(getToolboxAutomationRun(row.id));
      continue;
    }
    if (tool.status === "failed") {
      const failure = markToolFailure(row, tool, date);
      if (failure) outcomes.push(failure);
      continue;
    }
    if (tool.status === "done") {
      const billing = toolBilling(tool);
      if (
        ["held", "pending_reconciliation", "unsettled"].includes(billing.state)
      ) {
        continue;
      }
      const contract = toolContract(tool);
      outcomes.push(
        markExecutionFailure(
          row,
          Object.assign(new Error("工具结果未通过真实调用、质检与结算门槛"), {
            status: 502,
            code:
              contract.valid === false
                ? "TOOLBOX_AUTOMATION_CONTRACT_FAILED"
                : "TOOLBOX_AUTOMATION_DELIVERY_INVALID",
          }),
          date,
        ),
      );
    }
  }
  return outcomes;
}

export function listToolboxAutomationRuns({ limit = 20 } = {}) {
  const parsed = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 20));
  return q
    .all(
      `SELECT * FROM toolbox_automation_runs
      WHERE tenant_id=? ORDER BY id DESC LIMIT ?`,
      curTenant(),
      parsed,
    )
    .map(publicRun);
}

#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import {
  TOOLBOX_CASES,
  advisorFlowReadbackValid,
  artifactReadbackEvidence,
  automationRunReady,
  backgroundContentReady,
  billingEvidenceFromRows,
  buildDeterministicVisionFixturePng,
  buildFeatureJobs,
  classifyFeatureAttempt,
  checkpointPassReusable,
  compareTenantSnapshots,
  createFeatureState,
  exactBillingLedgerEvidence,
  evaluateFeatureSemantics,
  featureExecutionFingerprint,
  isAdvisorModulePermissionDenial,
  isLocalServiceBaseUrl,
  isModulePermissionDenial,
  isYunwuCloudBaseUrl,
  normalizeFeatureState,
  parseSseEvents,
  parseOnlyFilter,
  parsePositiveInteger,
  requestWithRetryPolicy,
  restaurantTaskFlowReadback,
  roleMatchesMatrixLane,
  sanitizeEvidence,
  summarizeFeatureState,
} from "./lib/real-feature-matrix.mjs";

function usage() {
  return `独立于72名员工全量验收的真实云API功能矩阵

用法：
  MATRIX_PASSWORD=... npm run test:features:real -- [选项]

凭证环境变量（不会写入报告）：
  MATRIX_BOSS_USERNAME / MATRIX_BOSS_PASSWORD       默认账号 guan
  MATRIX_MANAGER_USERNAME / MATRIX_MANAGER_PASSWORD 默认账号 yunying
  MATRIX_EMPLOYEE_USERNAME / MATRIX_EMPLOYEE_PASSWORD 默认账号 sales1
  MATRIX_USERNAME / MATRIX_PASSWORD                 可作为老板账号与三类密码的统一后备

选项：
  --base-url URL       已启动项目地址（默认 http://127.0.0.1:3107）
  --db FILE            服务绑定的专用隔离测试库（必填，也可用 MATRIX_DB）
  --out FILE           断点与证据JSON（默认 artifacts/real-feature-matrix.json）
  --only LIST          精确功能key列表，如 toolbox:hot,growth:objection
  --concurrency N      并发数1-3（默认1）
  --timeout-ms N       单功能超时（默认600000）
  --poll-ms N          后台任务轮询间隔（默认2000）
  --no-retry-failures  续跑时跳过已有失败功能
  --help               显示帮助

边界：
  不读取或保存云API Key；服务端必须已经通过进程环境配置云雾API。
  31条AI交付用例中，template/mock/fallback、零token、未结算、未持久化、非终态一律失败。
  每条显式输出L1链路结果与L2确定性业务语义结果；只有两层均通过才是最终PASS。
  5条权限边界覆盖老板参谋与餐饮数字员工员工入口：仅精确403模块无权限且零计费、零hold、零业务产物才通过。
  报告仅声称36条安全功能矩阵，不声称已测“所有功能”。
  未测外部副作用：支付/充值/回调、飞书绑定/发送/活动提交、对外发布登记、外部图片/视频生成、媒体任务素材导入。
`;
}

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`未知参数：${item}`);
    if (["--help", "--no-retry-failures"].includes(item)) {
      flags.add(item);
      continue;
    }
    const [key, inline] = item.split("=", 2);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${key}缺少参数值`);
    values[key] = value;
  }
  const allowed = new Set([
    "--base-url",
    "--db",
    "--out",
    "--only",
    "--concurrency",
    "--timeout-ms",
    "--poll-ms",
  ]);
  for (const key of Object.keys(values))
    if (!allowed.has(key)) throw new Error(`未知参数：${key}`);
  return {
    help: flags.has("--help"),
    retryFailures: !flags.has("--no-retry-failures"),
    baseUrl: String(
      values["--base-url"] ||
        process.env.MATRIX_BASE_URL ||
        "http://127.0.0.1:3107",
    ).replace(/\/+$/u, ""),
    dbPath: path.resolve(values["--db"] || process.env.MATRIX_DB || ""),
    outputPath: path.resolve(
      values["--out"] ||
        process.env.FEATURE_REAL_MATRIX_FILE ||
        "artifacts/real-feature-matrix.json",
    ),
    only: parseOnlyFilter(
      values["--only"] || process.env.FEATURE_MATRIX_ONLY || "",
    ),
    concurrency: parsePositiveInteger(
      values["--concurrency"] || process.env.FEATURE_MATRIX_CONCURRENCY,
      1,
      { min: 1, max: 3 },
    ),
    timeoutMs: parsePositiveInteger(
      values["--timeout-ms"] || process.env.FEATURE_MATRIX_TIMEOUT_MS,
      600_000,
      { min: 30_000, max: 1_800_000 },
    ),
    pollMs: parsePositiveInteger(
      values["--poll-ms"] || process.env.FEATURE_MATRIX_POLL_MS,
      2_000,
      { min: 250, max: 30_000 },
    ),
  };
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(usage());
  process.exit(0);
}
if (!isLocalServiceBaseUrl(options.baseUrl)) {
  throw new Error("真实功能矩阵只允许连接 loopback 本地服务");
}
if (
  !process.env.MATRIX_DB &&
  !process.argv.some((item) => item === "--db" || item.startsWith("--db="))
) {
  throw new Error(
    "必须通过 --db 或 MATRIX_DB 显式指定服务使用的专用隔离测试库",
  );
}
if (!fs.existsSync(options.dbPath) || !fs.statSync(options.dbPath).isFile()) {
  throw new Error(`专用隔离测试库不存在：${options.dbPath}`);
}

const databasePath = fs.realpathSync(options.dbPath);
const productionDatabasePath = path.resolve("server/data/nanowork-industry.db");
if (databasePath === productionDatabasePath) {
  throw new Error("真实功能矩阵拒绝运行在默认业务库，必须先克隆专用隔离库");
}
const featureDb = new DatabaseSync(databasePath);
featureDb.exec("PRAGMA busy_timeout=5000");
let matrixTenantId = null;
let executionFingerprint = null;

function scalar(sql, ...params) {
  return featureDb.prepare(sql).get(...params);
}

function hashJson(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function assertDedicatedTenantMarker(tenantId) {
  const markerKey = `real_feature_matrix_isolated:${tenantId}`;
  const row = scalar("SELECT value FROM sys_config WHERE key=?", markerKey);
  let marker = row?.value;
  try {
    marker = JSON.parse(marker);
  } catch {
    // 兼容手工预置的纯文本标记。
  }
  const valid =
    marker === "REAL_FEATURE_MATRIX_ISOLATED_V1" ||
    marker?.marker === "REAL_FEATURE_MATRIX_ISOLATED_V1";
  if (!valid) {
    throw new Error(
      `租户#${tenantId}缺少专用隔离标记 ${markerKey}=REAL_FEATURE_MATRIX_ISOLATED_V1，拒绝变更数据`,
    );
  }
  return markerKey;
}

function clearAndVerifyFeishuIsolation(tenantId) {
  const keys = ["feishu", "feishu_ics_token", "feishu_event_map"].map(
    (key) => `${key}:${tenantId}`,
  );
  featureDb.exec("BEGIN IMMEDIATE");
  try {
    const remove = featureDb.prepare("DELETE FROM sys_config WHERE key=?");
    for (const key of keys) remove.run(key);
    featureDb
      .prepare("INSERT INTO sys_config(key,value) VALUES(?,?)")
      .run(keys[0], JSON.stringify({ enabled: false }));
    featureDb.exec("COMMIT");
  } catch (error) {
    featureDb.exec("ROLLBACK");
    throw error;
  }
  const stored = featureDb
    .prepare(
      `SELECT key,value FROM sys_config WHERE key IN (${keys.map(() => "?").join(",")}) ORDER BY key`,
    )
    .all(...keys);
  if (
    stored.length !== 1 ||
    stored[0].key !== keys[0] ||
    JSON.parse(stored[0].value)?.enabled !== false
  ) {
    throw new Error("隔离租户飞书配置未强制关闭，拒绝继续");
  }
  return keys;
}

function captureTenantSnapshot(tenantId) {
  const tables = {};
  const names = featureDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name));
  for (const name of names) {
    const columns = featureDb
      .prepare(`PRAGMA table_info(${quoteIdentifier(name)})`)
      .all();
    if (!columns.some((column) => column.name === "tenant_id")) continue;
    const rows = featureDb
      .prepare(`SELECT * FROM ${quoteIdentifier(name)} WHERE tenant_id=?`)
      .all(tenantId)
      .map((row) => JSON.stringify(row))
      .sort();
    tables[name] = { count: rows.length, digest: hashJson(rows) };
  }
  const tenant = scalar(
    "SELECT id,name,status,data_mode,credits,total_recharged,note FROM tenants WHERE id=?",
    tenantId,
  );
  const tenantConfigRows = featureDb
    .prepare("SELECT key,value FROM sys_config WHERE key LIKE ? ORDER BY key")
    .all(`%:${tenantId}`)
    .map((row) => ({ key: row.key, valueHash: hashJson(row.value) }));
  const snapshot = { tenant, tenantConfigRows, tables };
  return { ...snapshot, digest: hashJson(snapshot) };
}

function ledgerWatermark(tenantId) {
  return {
    logId: Number(
      scalar(
        "SELECT COALESCE(MAX(id),0) id FROM credit_logs WHERE tenant_id=?",
        tenantId,
      )?.id || 0,
    ),
    holdId: Number(
      scalar(
        "SELECT COALESCE(MAX(id),0) id FROM credit_holds WHERE tenant_id=?",
        tenantId,
      )?.id || 0,
    ),
    balance: Number(
      scalar("SELECT credits FROM tenants WHERE id=?", tenantId)?.credits,
    ),
  };
}

function reviewWatermark(tenantId) {
  try {
    const approvalRows = scalar(
      `SELECT
         COUNT(*) n,
         SUM(CASE WHEN status='待审核' THEN 1 ELSE 0 END) pending,
         SUM(CASE WHEN status='已通过' THEN 1 ELSE 0 END) approved,
         SUM(CASE WHEN status='已驳回' THEN 1 ELSE 0 END) rejected
       FROM approvals WHERE tenant_id=?`,
      tenantId,
    );
    const taskPending = Number(
      scalar("SELECT COUNT(*) n FROM agent_tasks WHERE tenant_id=? AND status='待审阅'", tenantId)?.n || 0,
    );
    const contentPending = Number(
      scalar("SELECT COUNT(*) n FROM content_employee_runs WHERE tenant_id=? AND status='待审阅'", tenantId)?.n || 0,
    );
    return {
      approvals: Number(approvalRows?.n || 0),
      approvalsPending: Number(approvalRows?.pending || 0),
      approvalsApproved: Number(approvalRows?.approved || 0),
      approvalsRejected: Number(approvalRows?.rejected || 0),
      reviewPending: taskPending + contentPending,
      taskReviewPending: taskPending,
      contentReviewPending: contentPending,
    };
  } catch {
    return null;
  }
}

function attachReviewPolicyEvidence(executed, before, after) {
  const beforeValid = before && typeof before === "object";
  const afterValid = after && typeof after === "object";
  return {
    ...executed,
    reviewPolicy: "boss_test_zero_approvals",
    approvalCountsBefore: beforeValid ? before : null,
    approvalCountsAfter: afterValid ? after : null,
    approvalDelta:
      beforeValid && afterValid
        ? Number(after.approvals) - Number(before.approvals)
        : null,
    reviewPendingDelta:
      beforeValid && afterValid
        ? Number(after.reviewPending) - Number(before.reviewPending)
        : null,
  };
}

function directBillingEvidence({ afterId, userId, features }) {
  const accepted = new Set(features.map(String));
  const rawRows = featureDb
    .prepare(
      `SELECT l.*,h.id hold_id,h.log_id hold_log_id,h.status hold_status,
        h.held_credits,h.settled_credits
      FROM credit_logs l LEFT JOIN credit_holds h
        ON h.tenant_id=l.tenant_id AND h.log_id=l.id
      WHERE l.tenant_id=? AND l.id>? AND l.user_id=? ORDER BY l.id`,
    )
    .all(matrixTenantId, afterId, userId)
    .filter((row) => accepted.has(String(row.feature || "")));
  const evidence = billingEvidenceFromRows(rawRows, {
    afterId,
    userId,
    features,
  });
  const byId = new Map(rawRows.map((row) => [Number(row.id), row]));
  evidence.rows = evidence.rows.map((row) => {
    const raw = byId.get(Number(row.id)) || {};
    return {
      ...row,
      holdId: Number(raw.hold_id) || null,
      holdLogId: Number(raw.hold_log_id) || null,
      holdStatus: raw.hold_status || null,
      heldCredits: Number(raw.held_credits) || 0,
      settledCredits: Number(raw.settled_credits) || 0,
    };
  });
  return {
    evidence,
    balanceAfter: Number(
      scalar("SELECT credits FROM tenants WHERE id=?", matrixTenantId)?.credits,
    ),
    allNewLedgerCredits: Number(
      scalar(
        "SELECT COALESCE(SUM(credits),0) credits FROM credit_logs WHERE tenant_id=? AND id>?",
        matrixTenantId,
        afterId,
      )?.credits || 0,
    ),
  };
}

function sourceTreeHash() {
  const roots = [
    "server/src",
    "server/catalog",
    "scripts/lib/real-feature-matrix.mjs",
    "scripts/run-real-feature-matrix.mjs",
  ];
  const files = [];
  const visit = (target) => {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(target).sort())
        visit(path.join(target, child));
    } else if (/\.(?:js|mjs|json)$/u.test(target)) files.push(target);
  };
  for (const root of roots) visit(root);
  const hash = crypto.createHash("sha256");
  for (const file of files)
    hash.update(file).update("\0").update(fs.readFileSync(file)).update("\0");
  return hash.digest("hex");
}

function tableExists(name) {
  return Boolean(
    scalar("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?", name)
      ?.ok,
  );
}

function auditOpenMatrixWork(tenantId, { taskAfterId = 0 } = {}) {
  const activeSpecs = [
    ["agent_tasks", ["执行中", "生成中", "运行中", "处理中", "running"]],
    ["content_employee_runs", ["生成中", "运行中", "处理中", "running"]],
    ["content_automation_runs", ["运行中", "running"]],
    ["media_jobs", ["处理中", "运行中", "running"]],
    ["tool_runs", ["running"]],
  ];
  const active = [];
  for (const [table, statuses] of activeSpecs) {
    if (!tableExists(table)) continue;
    const columns = featureDb
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all();
    if (!columns.some((column) => column.name === "tenant_id")) continue;
    const rows = featureDb
      .prepare(
        `SELECT id,status FROM ${quoteIdentifier(table)} WHERE tenant_id=? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY id`,
      )
      .all(tenantId, ...statuses);
    if (rows.length) active.push({ table, rows });
  }
  const held = tableExists("credit_holds")
    ? featureDb
        .prepare(
          "SELECT id,log_id,ref_type,ref_id,held_credits FROM credit_holds WHERE tenant_id=? AND status='held' ORDER BY id",
        )
        .all(tenantId)
    : [];
  const feishuNotified = tableExists("tasks")
    ? Number(
        scalar(
          "SELECT COUNT(*) n FROM tasks WHERE tenant_id=? AND id>? AND COALESCE(feishu_notified,0)<>0",
          tenantId,
          taskAfterId,
        )?.n || 0,
      )
    : 0;
  return {
    pass: active.length === 0 && held.length === 0 && feishuNotified === 0,
    active,
    held,
    feishuNotified,
    checkedAt: new Date().toISOString(),
  };
}

async function recoverMatrixWork(reason) {
  process.env.NANOWORK_DB = databasePath;
  const { runWithTenant } = await import("../server/src/db.js");
  const {
    recoverStaleAgentTasks,
    recoverStaleContentAutomationRuns,
    recoverStaleContentEmployeeRuns,
    recoverStaleMediaJobs,
  } = await import("../server/src/engines/scheduler.js");
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const recovered = runWithTenant(matrixTenantId, () => ({
    tenantId: matrixTenantId,
    contentAutomation: recoverStaleContentAutomationRuns(future),
    contentEmployeeRuns: recoverStaleContentEmployeeRuns(future),
    agentTasks: recoverStaleAgentTasks(future),
    mediaJobs: recoverStaleMediaJobs(future),
  }));
  return sanitizeEvidence({
    reason,
    recoveredAt: new Date().toISOString(),
    recovered: [recovered],
  });
}

const sharedUsername = String(process.env.MATRIX_USERNAME || "").trim();
const sharedPassword = String(process.env.MATRIX_PASSWORD || "");
const credentials = {
  boss: {
    username: String(
      process.env.MATRIX_BOSS_USERNAME || sharedUsername || "guan",
    ).trim(),
    password: String(process.env.MATRIX_BOSS_PASSWORD || sharedPassword),
  },
  manager: {
    username: String(process.env.MATRIX_MANAGER_USERNAME || "yunying").trim(),
    password: String(process.env.MATRIX_MANAGER_PASSWORD || sharedPassword),
  },
  employee: {
    username: String(process.env.MATRIX_EMPLOYEE_USERNAME || "sales1").trim(),
    password: String(process.env.MATRIX_EMPLOYEE_PASSWORD || sharedPassword),
  },
};

const selectedJobs = buildFeatureJobs(options.only);
if (!selectedJobs.length) throw new Error("没有选中任何功能");
const requiredRoles = new Set(["boss", ...selectedJobs.map((job) => job.role)]);
for (const role of requiredRoles) {
  if (!credentials[role]?.username || !credentials[role]?.password) {
    process.stderr.write(
      `缺少${role}账号密码；请设置对应MATRIX_*凭证环境变量。\n`,
    );
    process.exit(2);
  }
}

fs.mkdirSync(path.dirname(options.outputPath), {
  recursive: true,
  mode: 0o700,
});

function readState() {
  if (!fs.existsSync(options.outputPath)) {
    return {
      state: createFeatureState({
        baseUrl: options.baseUrl,
        selectedJobs: selectedJobs.map((job) => job.key),
        concurrency: options.concurrency,
      }),
      changed: false,
    };
  }
  const parsed = JSON.parse(fs.readFileSync(options.outputPath, "utf8"));
  return normalizeFeatureState(parsed);
}

const loadedState = readState();
const state = loadedState.state;
let stopped = false;

function persistState() {
  state.updatedAt = new Date().toISOString();
  state.summary = summarizeFeatureState(state);
  const safeState = sanitizeEvidence(state);
  const temp = `${options.outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(safeState, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temp, options.outputPath);
}

if (loadedState.changed) persistState();

function setInProgress(key, attempt) {
  const previous = state.jobs[key] || { attempts: [] };
  state.jobs[key] = { ...previous, latest: sanitizeEvidence(attempt) };
  persistState();
}

function finalize(key, attempt) {
  const completed = sanitizeEvidence({
    ...attempt,
    ...classifyFeatureAttempt(attempt),
    finishedAt: new Date().toISOString(),
  });
  const previous = state.jobs[key] || { attempts: [] };
  state.jobs[key] = {
    attempts: [
      ...(Array.isArray(previous.attempts) ? previous.attempts : []),
      completed,
    ],
    latest: sanitizeEvidence(completed),
  };
  persistState();
  return completed;
}

process.once("SIGINT", () => {
  stopped = true;
  persistState();
});
process.once("SIGTERM", () => {
  stopped = true;
  persistState();
});

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const sessions = new Map();

async function request(
  pathname,
  {
    session = null,
    method = "GET",
    body,
    timeoutMs = 60_000,
    retry429 = true,
    mutationReplayProof = "",
  } = {},
) {
  return requestWithRetryPolicy(`${options.baseUrl}${pathname}`, {
    method,
    headers: {
      ...(session?.token ? { authorization: `Bearer ${session.token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
    retry429,
    mutationReplayProof,
    requestLabel: pathname,
    sleepFn: sleep,
  });
}

async function captureHttp(pathname, options = {}) {
  try {
    const result = await request(pathname, options);
    return {
      status: result.response.status,
      payload: result.payload,
      requestId: result.response.headers.get("x-request-id"),
    };
  } catch (error) {
    if (!Number.isInteger(Number(error?.status))) throw error;
    return {
      status: Number(error.status),
      payload: error.payload,
      requestId: error.requestId || null,
    };
  }
}

async function requestBytes(pathname, session) {
  const response = await fetch(`${options.baseUrl}${pathname}`, {
    method: "GET",
    headers: session?.token ? { authorization: `Bearer ${session.token}` } : {},
    signal: AbortSignal.timeout(60_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`GET ${pathname}返回${response.status}，文件读取失败`);
  }
  return {
    status: response.status,
    bytes: bytes.length,
    contentType: response.headers.get("content-type"),
  };
}

async function login(role) {
  const credential = credentials[role];
  const result = await request("/api/auth/login", {
    method: "POST",
    body: { username: credential.username, password: credential.password },
    retry429: false,
  });
  if (!result.payload?.token || !result.payload?.user?.id)
    throw new Error(`${role}登录响应缺少会话证据`);
  const session = {
    token: result.payload.token,
    userId: Number(result.payload.user.id),
    username: result.payload.user.username,
    name: result.payload.user.name,
    actualRole: result.payload.user.role,
    modules: Array.isArray(result.payload.user.modules)
      ? result.payload.user.modules
      : [],
    tenantId: Number(result.payload.user.tenant?.id),
  };
  if (!roleMatchesMatrixLane(role, session.actualRole)) {
    throw new Error(
      `${role}验收账号角色不匹配：实际为${session.actualRole || "missing"}，拒绝用同一高权限账号冒充三层角色`,
    );
  }
  sessions.set(role, session);
  return session;
}

async function initializeRuntime() {
  for (const role of requiredRoles) await login(role);
  const tenantIds = new Set(
    [...sessions.values()].map((session) => session.tenantId),
  );
  if (
    tenantIds.size !== 1 ||
    [...tenantIds].some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new Error(
      "三层验收账号不属于同一有效企业，拒绝混合租户形成伪业务闭环",
    );
  }
  const boss = sessions.get("boss");
  matrixTenantId = boss.tenantId;
  const markerKey = assertDedicatedTenantMarker(matrixTenantId);
  const tenant = scalar(
    "SELECT id,name,credits FROM tenants WHERE id=?",
    matrixTenantId,
  );
  if (!tenant) throw new Error(`专用隔离库不存在登录租户#${matrixTenantId}`);
  for (const session of sessions.values()) {
    const dbUser = scalar(
      "SELECT id,tenant_id,username,role FROM users WHERE id=?",
      session.userId,
    );
    if (
      Number(dbUser?.tenant_id) !== matrixTenantId ||
      dbUser?.username !== session.username ||
      dbUser?.role !== session.actualRole
    ) {
      throw new Error(
        "本地服务与 --db 账号身份不一致，拒绝在未绑定数据库上执行",
      );
    }
  }
  const removedFeishuKeys = clearAndVerifyFeishuIsolation(matrixTenantId);
  const overview = await request("/api/admin/overview", { session: boss });
  if (Number(overview.payload?.totalCredits) !== Number(tenant.credits)) {
    throw new Error("本地服务与 --db 企业积分余额不一致，数据库绑定验证失败");
  }
  const feishu = await request("/api/sys/feishu", { session: boss });
  if (
    feishu.payload?.enabled ||
    feishu.payload?.appReady ||
    feishu.payload?.appBotReady
  ) {
    throw new Error("隔离租户飞书外发通道仍可用，拒绝继续");
  }
  const config = await request("/api/admin/api-config", { session: boss });
  if (config.payload?.channel?.available !== true) {
    throw new Error(
      `真实云API不可用：${config.payload?.channel?.readiness?.reason || "服务端未检测到环境变量凭证"}`,
    );
  }
  const provider = String(config.payload?.channel?.provider || "");
  if (!/云雾|yunwu/iu.test(provider))
    throw new Error(`当前提供商不是云雾API：${provider || "missing"}`);
  if (
    config.payload?.channel?.keySource !== "environment" ||
    config.payload?.channel?.keyPersistence !== "environment_only"
  ) {
    throw new Error(
      "真实矩阵只允许使用服务进程环境中的云雾凭证，拒绝数据库遗留Key或持久化Key",
    );
  }
  if (!isYunwuCloudBaseUrl(config.payload?.channel?.baseUrl)) {
    throw new Error(
      `真实矩阵拒绝非云雾公网HTTPS地址：${config.payload?.channel?.baseUrl || "missing"}`,
    );
  }
  const databaseIdentity = hashJson({
    path: databasePath,
    markerKey,
    tenantId: matrixTenantId,
    tenantName: tenant.name,
  });
  const coreCodeHash = sourceTreeHash();
  const scenarioHash = hashJson(
    selectedJobs.map((job) => ({
      key: job.key,
      title: job.title,
      role: job.role,
      kind: job.kind,
      expectation: job.expectation,
      providerPolicy: job.providerPolicy,
    })),
  );
  const providerHash = hashJson({
    provider,
    baseUrl: config.payload.channel.baseUrl,
    keySource: config.payload.channel.keySource,
    keyPersistence: config.payload.channel.keyPersistence,
  });
  executionFingerprint = featureExecutionFingerprint({
    baseUrl: options.baseUrl,
    tenantId: matrixTenantId,
    databaseIdentity,
    coreCodeHash,
    scenarioHash,
    providerHash,
  });
  state.runtimeEvidence = {
    checkedAt: new Date().toISOString(),
    provider,
    baseUrl: config.payload.channel.baseUrl,
    keySource: config.payload.channel.keySource,
    keyPersistence: config.payload.channel.keyPersistence,
    available: true,
    loopbackService: true,
    dedicatedDatabase: true,
    databaseIdentity,
    tenantMarkerKey: markerKey,
    feishuIsolation: {
      clearedKeys: removedFeishuKeys,
      enabled: false,
      appReady: false,
      appBotReady: false,
    },
    fingerprints: {
      executionFingerprint,
      coreCodeHash,
      scenarioHash,
      providerHash,
    },
    roles: Object.fromEntries(
      [...sessions.entries()].map(([role, session]) => [
        role,
        {
          userId: session.userId,
          username: session.username,
          actualRole: session.actualRole,
          tenantId: session.tenantId,
          modules: session.modules,
        },
      ]),
    ),
  };
  persistState();
}

async function adminCreditRows() {
  const result = await request("/api/admin/credits/logs?export=1", {
    session: sessions.get("boss"),
  });
  return Array.isArray(result.payload?.rows) ? result.payload.rows : [];
}

async function latestCreditLogId() {
  const result = await request("/api/admin/credits/logs?page=1&size=1", {
    session: sessions.get("boss"),
  });
  return Number(result.payload?.rows?.[0]?.id) || 0;
}

async function waitBillingEvidence({
  afterId,
  userId,
  features,
  expectedCount,
}) {
  const deadline = Date.now() + Math.min(options.timeoutMs, 90_000);
  let evidence = billingEvidenceFromRows([], { afterId, userId, features });
  while (Date.now() < deadline) {
    evidence = billingEvidenceFromRows(await adminCreditRows(), {
      afterId,
      userId,
      features,
    });
    if (
      evidence.count >= expectedCount &&
      evidence.aiMode === "api" &&
      evidence.inputTokens > 0 &&
      evidence.outputTokens > 0 &&
      evidence.missingFeatures.length === 0
    )
      return evidence;
    await sleep(Math.min(options.pollMs, 2_000));
  }
  return evidence;
}

async function poll(pathname, session, ready, label) {
  const deadline = Date.now() + options.timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    if (stopped) throw new Error(`${label}被安全中断`);
    latest = (await request(pathname, { session, timeoutMs: 30_000 })).payload;
    if (ready(latest)) return latest;
    await sleep(options.pollMs);
  }
  throw new Error(`${label}等待超时：${JSON.stringify(latest)?.slice(0, 400)}`);
}

function digest(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function futureDate(days = 14) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function responseBillingState(value) {
  if (Array.isArray(value)) {
    if (value.length && value.every((item) => item?.state === "settled"))
      return "settled";
    return value.find((item) => item?.state)?.state || null;
  }
  return value?.state || null;
}

function billingEntries(value) {
  if (Array.isArray(value)) return value.flatMap(billingEntries);
  if (Array.isArray(value?.items)) return value.items.flatMap(billingEntries);
  return value && typeof value === "object" ? [value] : [];
}

function directResult({
  expectedFeatures,
  expectedBillingCount = 1,
  billing,
  aiMode = null,
  models = [],
  businessIds,
  persistent,
  terminalStatus,
  terminalValid,
  contractValid,
  contractErrors = [],
  templateFingerprintDetected = false,
  resultText = "",
  metadata = {},
  semanticPayload = null,
  modeEvidenceSource = "endpoint_response_or_authenticated_readback",
  billingStateEvidenceSource = "endpoint_response_or_persisted_snapshot",
  persistenceEvidenceSource = "authenticated_readback",
  terminalEvidenceSource = "authenticated_readback",
}) {
  return {
    expectedFeatures,
    expectedBillingCount,
    billingState: responseBillingState(billing),
    billingHoldIds: [
      ...new Set(
        billingEntries(billing)
          .map((item) => Number(item?.holdId))
          .filter((id) => Number.isSafeInteger(id) && id > 0),
      ),
    ],
    aiMode,
    models: models.filter(Boolean),
    businessIds: businessIds.map(Number).filter(Number.isSafeInteger),
    persistent,
    terminalStatus,
    terminalValid,
    contractValid,
    contractErrors,
    templateFingerprintDetected,
    resultHash: resultText ? digest(resultText) : null,
    resultChars: String(resultText || "").length,
    rawResultText: String(resultText || ""),
    semanticPayload,
    evidenceSources: {
      mode: modeEvidenceSource,
      billingState: billingStateEvidenceSource,
      persistence: persistenceEvidenceSource,
      terminal: terminalEvidenceSource,
    },
    metadata,
  };
}

const marshalFixtureCache = new Map();
async function marshalFixture({ employeeIdx = null } = {}) {
  const cacheKey =
    employeeIdx == null ? "department" : `employee:${employeeIdx}`;
  if (marshalFixtureCache.has(cacheKey))
    return marshalFixtureCache.get(cacheKey);
  const boss = sessions.get("boss");
  const listed = await request("/api/marshals", { session: boss });
  const departments = Array.isArray(listed.payload) ? listed.payload : [];
  if (!departments.length) throw new Error("餐饮数字员工目录没有可用分部");
  if (employeeIdx == null) {
    const detail = await request(`/api/marshals/${departments[0].id}`, {
      session: boss,
    });
    const fixture = { department: detail.payload, specialist: null };
    marshalFixtureCache.set(cacheKey, fixture);
    return fixture;
  }
  for (const department of departments) {
    const detail = await request(`/api/marshals/${department.id}`, {
      session: boss,
    });
    const specialist = (
      Array.isArray(detail.payload?.specialists)
        ? detail.payload.specialists
        : []
    ).find((item) => Number(item?.employee_idx) === Number(employeeIdx));
    if (specialist) {
      const fixture = { department: detail.payload, specialist };
      marshalFixtureCache.set(cacheKey, fixture);
      return fixture;
    }
  }
  throw new Error(`餐饮数字员工目录中没有employee_idx=${employeeIdx}`);
}

async function executeAdvisorPermissionBoundary(job, session) {
  const nonce = crypto.randomUUID();
  const question = [
    `权限边界验收-${nonce}`,
    "这是本地真实服务权限拦截验收；管理层和员工不应进入老板参谋路由处理器。",
  ].join("\n");
  const chat = await captureHttp("/api/advisor/chat", {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: {
      question,
      diagType: "权限边界真实验收",
      web: false,
      deep: false,
      stream: false,
    },
  });
  // 再读一次会话入口：同一模块必须继续在路由处理器之前拦截。
  const readback = await captureHttp("/api/advisor/conversations", {
    session,
    timeoutMs: 30_000,
    retry429: false,
  });
  const payload =
    chat.payload && typeof chat.payload === "object" ? chat.payload : {};
  const readbackRows = Array.isArray(readback.payload) ? readback.payload : [];
  const noncePrefix = `权限边界验收-${nonce}`.slice(0, 24);
  const businessIds = [payload.conversationId, payload.assistantMessageId]
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  const artifactReadbackFound = readbackRows.some((item) =>
    String(item?.title || "").includes(noncePrefix),
  );
  const replyText = String(payload.reply || "").trim();
  return {
    expectation: job.expectation,
    expectedFeatures: ["老板参谋诊断"],
    expectedBillingCount: 0,
    requestReachedLocalService:
      isLocalServiceBaseUrl(options.baseUrl) && Number.isInteger(chat.status),
    endpoint: "/api/advisor/chat",
    endpointTemplate: "/api/advisor/chat",
    method: "POST",
    httpStatus: chat.status,
    boundaryError: String(payload.error || payload.message || ""),
    modulePermissionAbsent: !session.modules.includes("advisor"),
    readbackHttpStatus: readback.status,
    readbackError: String(
      readback.payload?.error || readback.payload?.message || "",
    ),
    artifactProbeComplete: Number.isInteger(readback.status),
    artifactReadbackFound,
    businessArtifactCreated: businessIds.length > 0 || artifactReadbackFound,
    businessIds,
    persistent: businessIds.length > 0 || artifactReadbackFound,
    terminalStatus: isAdvisorModulePermissionDenial(chat.status, payload)
      ? "authorization_denied"
      : `unexpected_http_${chat.status || "missing"}`,
    terminalValid: isAdvisorModulePermissionDenial(chat.status, payload),
    contractValid:
      isAdvisorModulePermissionDenial(chat.status, payload) &&
      isAdvisorModulePermissionDenial(readback.status, readback.payload),
    contractErrors: [
      ...(!isAdvisorModulePermissionDenial(chat.status, payload)
        ? ["POST未返回精确403模块无权限"]
        : []),
      ...(!isAdvisorModulePermissionDenial(readback.status, readback.payload)
        ? ["GET读取入口未返回精确403模块无权限"]
        : []),
      ...(businessIds.length || artifactReadbackFound
        ? ["无权请求产生了业务产物"]
        : []),
    ],
    billingState: responseBillingState(payload.billing),
    billingHoldIds: [
      ...new Set(
        billingEntries(payload.billing)
          .map((item) => Number(item?.holdId))
          .filter((id) => Number.isSafeInteger(id) && id > 0),
      ),
    ],
    aiMode: payload.mode || null,
    models: [payload.model].filter(Boolean),
    resultHash: replyText ? digest(replyText) : null,
    resultChars: replyText.length,
    rawResultText: replyText,
    metadata: {
      nonceHash: digest(nonce),
      chatRequestId: chat.requestId,
      readbackRequestId: readback.requestId,
      permissionGuardBeforeRouteHandler:
        !session.modules.includes("advisor") &&
        isAdvisorModulePermissionDenial(chat.status, payload),
      holdAuditMechanism: "credit_log_is_created_atomically_with_hold",
    },
  };
}

async function executeMarshalPermissionBoundary(job, session) {
  const nonce = `权限边界验收-${crypto.randomUUID()}`;
  const { department } = await marshalFixture();
  const route = `/api/marshals/${department.id}`;
  const cases = {
    marshal_chat: {
      endpoint: `${route}/chat`,
      endpointTemplate: "/api/marshals/:id/chat",
      body: {
        message: `${nonce}\n员工账号不得进入餐饮数字员工对话处理器。`,
        stream: false,
      },
      expectedFeature: `员工对话·${department.name}`,
    },
    marshal_skill_file: {
      endpoint: `${route}/skill-file`,
      endpointTemplate: "/api/marshals/:id/skill-file",
      body: {
        message: `${nonce}\n员工账号不得生成岗位Word制品。`,
        format: "docx",
      },
      expectedFeature: `生成Word·${department.name}`,
    },
    marshal_task: {
      endpoint: `${route}/tasks`,
      endpointTemplate: "/api/marshals/:id/tasks",
      body: {
        title: nonce.slice(0, 100),
        type: "常规",
        requirement:
          "员工账号未获餐饮数字员工模块权限时，不得创建任务、占扣积分或生成产物。",
      },
      expectedFeature: `员工任务·${department.name}`,
    },
  };
  const item = cases[job.kind];
  if (!item) throw new Error(`未实现权限边界执行器：${job.kind}`);
  const denied = await captureHttp(item.endpoint, {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: item.body,
  });
  const guardReadback = await captureHttp("/api/marshals", {
    session,
    timeoutMs: 30_000,
    retry429: false,
  });

  const boss = sessions.get("boss");
  let artifactReadbackFound = false;
  let artifactProbeMethod = "pre_handler_module_guard";
  if (job.kind === "marshal_skill_file") {
    const artifacts = await request(
      `/api/files/artifacts?q=${encodeURIComponent(nonce)}`,
      { session: boss },
    );
    artifactReadbackFound = (
      Array.isArray(artifacts.payload) ? artifacts.payload : []
    ).some(
      (item0) =>
        String(item0?.title || "").includes(nonce) ||
        String(item0?.content || "").includes(nonce),
    );
    artifactProbeMethod = "boss_artifact_query_by_nonce";
  } else if (job.kind === "marshal_task") {
    const detail = await request(`/api/marshals/${department.id}`, {
      session: boss,
    });
    artifactReadbackFound = (
      Array.isArray(detail.payload?.tasks) ? detail.payload.tasks : []
    ).some((task) => String(task?.title || "").includes(nonce));
    artifactProbeMethod = "boss_department_task_query_by_nonce";
  }

  const payload =
    denied.payload && typeof denied.payload === "object" ? denied.payload : {};
  const businessIds = [
    payload.taskId,
    payload.sessionId,
    payload.assistantMessageId,
    payload.artifactId,
  ]
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  const replyText = String(payload.reply || "").trim();
  const exactDenial = isModulePermissionDenial(denied.status, payload);
  const exactReadbackDenial = isModulePermissionDenial(
    guardReadback.status,
    guardReadback.payload,
  );
  return {
    expectation: job.expectation,
    expectedFeatures: [item.expectedFeature],
    expectedBillingCount: 0,
    requestReachedLocalService:
      isLocalServiceBaseUrl(options.baseUrl) && Number.isInteger(denied.status),
    endpoint: item.endpoint,
    endpointTemplate: item.endpointTemplate,
    method: "POST",
    httpStatus: denied.status,
    boundaryError: String(payload.error || payload.message || ""),
    modulePermissionAbsent: !session.modules.includes("marshals"),
    readbackHttpStatus: guardReadback.status,
    readbackError: String(
      guardReadback.payload?.error || guardReadback.payload?.message || "",
    ),
    artifactProbeComplete: Number.isInteger(guardReadback.status),
    artifactReadbackFound,
    businessArtifactCreated: businessIds.length > 0 || artifactReadbackFound,
    businessIds,
    persistent: businessIds.length > 0 || artifactReadbackFound,
    terminalStatus: exactDenial
      ? "authorization_denied"
      : `unexpected_http_${denied.status || "missing"}`,
    terminalValid: exactDenial,
    contractValid:
      exactDenial &&
      exactReadbackDenial &&
      !artifactReadbackFound &&
      businessIds.length === 0,
    contractErrors: [
      ...(!exactDenial ? ["POST未返回精确403模块无权限"] : []),
      ...(!exactReadbackDenial ? ["GET读取入口未返回精确403模块无权限"] : []),
      ...(businessIds.length || artifactReadbackFound
        ? ["无权请求产生了业务产物"]
        : []),
    ],
    billingState: responseBillingState(payload.billing),
    billingHoldIds: [
      ...new Set(
        billingEntries(payload.billing)
          .map((entry) => Number(entry?.holdId))
          .filter((id) => Number.isSafeInteger(id) && id > 0),
      ),
    ],
    aiMode: payload.mode || null,
    models: [payload.model].filter(Boolean),
    resultHash: replyText ? digest(replyText) : null,
    resultChars: replyText.length,
    rawResultText: replyText,
    metadata: {
      nonceHash: digest(nonce),
      departmentId: Number(department.id),
      departmentCode: department.code,
      deniedRequestId: denied.requestId,
      readbackRequestId: guardReadback.requestId,
      artifactProbeMethod,
      permissionGuardBeforeRouteHandler:
        !session.modules.includes("marshals") &&
        exactDenial &&
        exactReadbackDenial,
      holdAuditMechanism: "credit_log_is_created_atomically_with_hold",
    },
  };
}

async function executeAdvisor(job, session) {
  const useWebDeep = job.key.endsWith("web-deep");
  const nonce = crypto.randomUUID();
  const question = [
    `真实API验收标识：${nonce}`,
    "请基于系统中当前可见的真实经营数据，判断门店本周最值得先解决的一个经营问题。",
    "输出：事实依据、未知项、三个执行动作（执行人/截止/检查标准）和风险边界。",
    "不得编造价格、库存、客户证言、经营结果或已经完成的外部动作。",
  ].join("\n");
  const response = await request("/api/advisor/chat", {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: {
      question,
      diagType: "真实经营诊断验收",
      web: useWebDeep,
      deep: useWebDeep,
      stream: false,
    },
  });
  const payload = response.payload;
  const conversationId = Number(payload.conversationId);
  const messageId = Number(payload.assistantMessageId);
  const messages = await request(
    `/api/advisor/conversations/${conversationId}/messages`,
    { session },
  );
  const persisted = messages.payload.find(
    (item) => Number(item.id) === messageId && item.role === "assistant",
  );
  const replyText = String(payload.reply || "").trim();
  const persistedText = String(persisted?.content || "").trim();
  const replyPersisted =
    replyText.length > 0 && persistedText.includes(replyText);
  const flowIds = [];
  if (job.key === "advisor:boss:standard") {
    const handoff = await request(
      `/api/advisor/messages/${messageId}/to-tasks`,
      {
        session,
        method: "POST",
        body: {},
      },
    );
    for (const task of [
      ...(handoff.payload?.created || []),
      ...(handoff.payload?.existing || []),
    ]) {
      if (task?.id) flowIds.push(Number(task.id));
    }
  }
  if (useWebDeep) {
    const handoff = await request("/api/advisor/dispatch", {
      session,
      method: "POST",
      body: {
        marshalCodes: ["M-07"],
        title: `真实会诊流向验收-${nonce.slice(0, 8)}`,
        sourceMessageId: messageId,
        owner: "运营总监",
      },
    });
    for (const task of [
      ...(handoff.payload?.created || []),
      ...(handoff.payload?.existing || []),
    ]) {
      if (task?.id) flowIds.push(Number(task.id));
    }
  }
  let flowReadbackValid = !job.key.startsWith("advisor:boss");
  if (job.key.startsWith("advisor:boss") && messageId > 0) {
    const flow = await request(
      `/api/business-flow/advisor_message/${messageId}`,
      { session },
    );
    flowReadbackValid = advisorFlowReadbackValid(flow.payload, flowIds);
  }
  const sourceOk =
    !useWebDeep ||
    (Array.isArray(payload.sources) &&
      payload.sources.length > 0 &&
      payload.sources.every((item) =>
        /^https?:\/\//iu.test(String(item?.url || "")),
      ));
  return directResult({
    expectedFeatures: [
      useWebDeep ? "老板参谋诊断·联网·深度思考" : "老板参谋诊断",
    ],
    billing: payload.billing,
    aiMode: payload.mode,
    models: [payload.model],
    businessIds: [conversationId, messageId, ...flowIds],
    persistent: Boolean(persisted) && replyPersisted && flowReadbackValid,
    terminalStatus: "completed",
    terminalValid: Boolean(persisted) && replyPersisted && flowReadbackValid,
    contractValid: replyText.length >= 120 && sourceOk && flowReadbackValid,
    contractErrors: [
      ...(replyText.length < 120 ? ["会诊正文过短"] : []),
      ...(!replyPersisted ? ["会诊正文未按本轮响应落库"] : []),
      ...(!sourceOk ? ["联网深度会诊缺少可引用URL证据"] : []),
      ...(!flowReadbackValid
        ? ["会诊未通过业务流读取接口证明已落到内部任务"]
        : []),
    ],
    resultText: persistedText,
    metadata: {
      conversationId,
      assistantMessageId: messageId,
      flowTaskIds: flowIds,
      sourceCount: Array.isArray(payload.sources) ? payload.sources.length : 0,
      requestId: response.response.headers.get("x-request-id"),
    },
  });
}

async function executeCustomAgent(job, session) {
  const nonce = crypto.randomUUID();
  const roleTier =
    job.role === "boss"
      ? "expert"
      : job.role === "manager"
        ? "normal"
        : "simple";
  const name = `真实验收智能体-${job.role}-${nonce.slice(0, 8)}`;
  const created = await request("/api/agents", {
    session,
    method: "POST",
    body: {
      name,
      emoji: "🧪",
      tier: roleTier,
      prompt:
        "你是餐饮门店周经营复盘助手。只依据用户提供的数据，输出事实、差距、动作与待确认项；不得编造外部动作或经营结果。",
      skills: [],
      ...(roleTier === "expert"
        ? {
            persona: "语气克制、清楚、老板可直接审阅；所有建议必须有检查标准。",
          }
        : {}),
    },
  });
  const agentId = Number(created.payload?.id);
  const chat = await request(`/api/agents/${agentId}/chat`, {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: {
      message: `验收标识${nonce}。已知本周营业额100000元、采购入库35000元；期初/期末库存、报损、调拨均未提供。请明确区分“采购入库占营业额35%”和“食材成本率”，不得直接认定成本率为35%；给出包含凭证/台账与检查标准的核验清单。`,
    },
  });
  const sessionId = Number(chat.payload.sessionId);
  const messageId = Number(chat.payload.assistantMessageId);
  const messages = await request(`/api/agents/chats/${sessionId}/messages`, {
    session,
  });
  const persisted = messages.payload.find(
    (item) => Number(item.id) === messageId && item.role === "assistant",
  );
  const replyText = String(chat.payload.reply || "").trim();
  const persistedText = String(persisted?.content || "").trim();
  const replyPersisted = replyText.length > 0 && persistedText === replyText;
  return directResult({
    expectedFeatures: [`智能体·${name}`],
    billing: chat.payload.billing,
    aiMode: chat.payload.mode,
    models: [chat.payload.model],
    businessIds: [agentId, sessionId, messageId],
    persistent: Boolean(persisted) && replyPersisted,
    terminalStatus: "completed",
    terminalValid: Boolean(persisted) && replyPersisted,
    contractValid: persistedText.length >= 80 && replyPersisted,
    contractErrors: [
      ...(persistedText.length >= 80 ? [] : ["智能体回复过短"]),
      ...(replyPersisted ? [] : ["智能体响应与落库正文不一致"]),
    ],
    resultText: persistedText,
    metadata: {
      agentId,
      sessionId,
      assistantMessageId: messageId,
      tier: roleTier,
    },
  });
}

const MARSHAL_COST_PROMPT = [
  "验收门店本周营业额100000元、采购入库35000元、订单2000单。",
  "可复算派生指标仅包括：采购入库占营业额35%，客单收入50元/单。",
  "期初库存、期末库存、报损和调拨均未提供，因此不得把采购占比35%认定为食材成本率。",
  "请区分已知事实、可复算指标和待补数据，给出负责人、截止时间与检查标准；只形成内部待审核建议，不执行发布、付款或调价。",
].join("\n");

async function executeMarshalChat(job, session) {
  const nonce = crypto.randomUUID();
  const { department } = await marshalFixture();
  const useSse = job.key.endsWith(":sse");
  const response = await request(`/api/marshals/${department.id}/chat`, {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: {
      message: `真实功能验收标识：${nonce}\n${MARSHAL_COST_PROMPT}`,
      stream: useSse,
    },
  });
  const contentType = response.response.headers.get("content-type") || "";
  const sse = useSse ? parseSseEvents(response.payload) : null;
  const payload = useSse ? sse?.doneEvent || {} : response.payload || {};
  const sessionId = Number(payload.sessionId);
  const assistantMessageId = Number(payload.assistantMessageId);
  const reply = String(
    payload.reply || (useSse ? sse?.deltaText : "") || "",
  ).trim();
  const messages = await request(`/api/marshals/chats/${sessionId}/messages`, {
    session,
  });
  const persisted = (
    Array.isArray(messages.payload) ? messages.payload : []
  ).find(
    (item) =>
      Number(item?.id) === assistantMessageId && item?.role === "assistant",
  );
  const persistedText = String(persisted?.content || "").trim();
  const replyPersisted = reply.length > 0 && persistedText === reply;
  const transportValid = useSse
    ? /^text\/event-stream\b/iu.test(contentType) &&
      sse?.valid === true &&
      sse.deltaText === reply
    : /^application\/json\b/iu.test(contentType) &&
      response.payload &&
      typeof response.payload === "object";
  return directResult({
    expectedFeatures: [`员工对话·${department.name}`],
    billing: payload.billing,
    aiMode: payload.mode,
    models: [payload.model],
    businessIds: [sessionId, assistantMessageId],
    persistent: Boolean(persisted) && replyPersisted,
    terminalStatus: useSse ? "sse_done" : "completed",
    terminalValid: transportValid && replyPersisted,
    contractValid: reply.length >= 120 && transportValid && replyPersisted,
    contractErrors: [
      ...(reply.length >= 120 ? [] : ["餐饮数字员工对话正文过短"]),
      ...(transportValid
        ? []
        : [
            useSse
              ? "SSE缺少reset/delta/done完整事件链"
              : "同步响应不是JSON终态",
          ]),
      ...(replyPersisted ? [] : ["对话响应与会话读取正文不一致"]),
    ],
    resultText: persistedText,
    metadata: {
      departmentId: Number(department.id),
      departmentCode: department.code,
      sessionId,
      assistantMessageId,
      transport: useSse ? "sse" : "json",
      contentType,
      replyPersisted,
      sseDone: sse?.done === true,
      sseEventCount: sse?.events?.length || 0,
      requestId: response.response.headers.get("x-request-id"),
    },
  });
}

function skillSourceContract(format, content) {
  const source = String(content || "").trim();
  if (source.length < 100) return false;
  if (format === "docx")
    return /^\s*#\s+/mu.test(source) && /(?:摘要|结论)/u.test(source);
  if (format === "xlsx")
    return (
      /\|[^\n]+\|/u.test(source) && /(?:公式|=SUM|=IF|=ROUND|=)/iu.test(source)
    );
  if (format === "pptx")
    return (source.match(/^\s*---\s*$/gmu) || []).length >= 4;
  if (format === "pdf")
    return /^\s*#\s+/mu.test(source) && /(?:摘要|风险边界|结论)/u.test(source);
  return false;
}

async function executeMarshalSkillFiles(_job, session) {
  const nonce = crypto.randomUUID();
  const { department } = await marshalFixture();
  const formats = ["docx", "xlsx", "pptx", "pdf"];
  const requests = {
    docx: "生成一份含摘要、数据口径表、核验行动清单和结论的正式Word文档。",
    xlsx: "生成一张可录入期初库存、期末库存、报损、调拨并带计算公式的Excel核验表。",
    pptx: "生成严格5页PPT：口径、已知数据、未知数据、核验动作、风险与结论。",
    pdf: "生成一份含摘要、事实依据、执行建议、风险边界和结论的正式PDF报告。",
  };
  const generated = [];
  for (const format of formats) {
    const result = await request(`/api/marshals/${department.id}/skill-file`, {
      session,
      method: "POST",
      timeoutMs: options.timeoutMs,
      body: {
        message: `真实四格式验收-${nonce}-${format}\n${MARSHAL_COST_PROMPT}\n${requests[format]}`,
        format,
      },
    });
    generated.push({ format, ...result.payload });
  }
  const artifacts = await request("/api/files/artifacts?mine=1", { session });
  const artifactIds = generated.map((item) => Number(item.artifactId));
  const artifactEvidence = artifactReadbackEvidence(artifacts.payload, {
    ids: artifactIds,
    formats,
    sourceType: "marshal_skill",
    sourceId: Number(department.id),
    fileUrlPrefix: "/uploads/skills/",
  });
  const downloads = [];
  for (const item of generated) {
    downloads.push(await requestBytes(item.fileUrl, session));
  }
  const sourceContracts = generated.map((item) => ({
    format: item.format,
    valid: skillSourceContract(item.format, item.reply),
  }));
  const resultText = generated
    .map((item) => `## ${item.format}\n${String(item.reply || "").trim()}`)
    .join("\n\n");
  const allSettled = generated.every(
    (item) => item.billing?.state === "settled",
  );
  const downloadValid =
    downloads.length === 4 &&
    downloads.every((item) => item.status === 200 && item.bytes > 0);
  return directResult({
    expectedFeatures: [
      "生成Word·" + department.name,
      "生成Excel·" + department.name,
      "生成PPT·" + department.name,
      "生成PDF·" + department.name,
    ],
    expectedBillingCount: 4,
    billing: generated.map((item) => item.billing),
    aiMode: allSettled ? "api" : null,
    businessIds: artifactIds,
    persistent: artifactEvidence.persisted && artifactEvidence.lineageValid,
    terminalStatus: "four_skill_files_generated",
    terminalValid: artifactEvidence.terminalValid && downloadValid,
    contractValid:
      artifactEvidence.contractValid &&
      artifactEvidence.lineageValid &&
      sourceContracts.every((item) => item.valid),
    contractErrors: [
      ...(!artifactEvidence.persisted || !artifactEvidence.lineageValid
        ? ["四格式技能文件未通过制品列表证明同一分部来源"]
        : []),
      ...(!artifactEvidence.terminalValid || !downloadValid
        ? ["四格式技能文件未全部达到可用、非空且可鉴权下载终态"]
        : []),
      ...sourceContracts
        .filter((item) => !item.valid)
        .map((item) => `${item.format}源稿结构不符合对应文件技能契约`),
    ],
    resultText,
    metadata: {
      departmentId: Number(department.id),
      departmentCode: department.code,
      formats,
      artifactIds,
      artifactCount: artifactEvidence.matched.length,
      downloadedCount: downloads.filter(
        (item) => item.status === 200 && item.bytes > 0,
      ).length,
      downloadBytes: downloads.map((item) => item.bytes),
      sourceContracts,
    },
  });
}

async function executeSystemKbVision(_job, session) {
  const nonce = crypto.randomUUID();
  const fixture = buildDeterministicVisionFixturePng();
  const title = `真实知识库识图验收-${nonce.slice(0, 8)}`;
  const result = await request("/api/sys/kb/upload", {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: {
      name: `${title}.png`,
      category: "品牌资料",
      b64: fixture.toString("base64"),
    },
  });
  const docId = Number(result.payload?.id);
  const docs = await request(
    "/api/sys/kb?category=" + encodeURIComponent("品牌资料"),
    { session },
  );
  const doc = (Array.isArray(docs.payload) ? docs.payload : []).find(
    (item) => Number(item?.id) === docId,
  );
  const assets = await request(
    `/api/assets?kw=${encodeURIComponent(title)}&size=20&page=1`,
    { session },
  );
  const asset = (
    Array.isArray(assets.payload?.rows) ? assets.payload.rows : []
  ).find(
    (item) => item?.source_type === "kb" && Number(item?.source_id) === docId,
  );
  const body = String(doc?.body || "").trim();
  return directResult({
    expectedFeatures: ["知识库·图片识别入库"],
    billing: result.payload?.billing,
    aiMode: result.payload?.billing?.state === "settled" ? "api" : null,
    businessIds: [docId, Number(asset?.id)],
    persistent: Number(doc?.id) === docId && Number(asset?.source_id) === docId,
    terminalStatus: result.payload?.extractMode,
    terminalValid:
      Number(doc?.enabled) === 1 &&
      /AI识图/u.test(String(result.payload?.extractMode || "")),
    contractValid:
      body.length >= 40 &&
      String(doc?.file_path || "") === String(result.payload?.fileUrl || ""),
    contractErrors: [
      ...(body.length >= 40 ? [] : ["知识库识图正文未落库或过短"]),
      ...(Number(doc?.enabled) === 1
        ? []
        : ["管理层上传的可读图片知识未进入启用终态"]),
      ...(asset ? [] : ["知识库图片未同步形成知识资产"]),
    ],
    resultText: body,
    metadata: {
      kbDocId: docId,
      knowledgeAssetId: Number(asset?.id) || null,
      kbDocumentPersisted: Number(doc?.id) === docId,
      knowledgeAssetPersisted: Boolean(asset),
      extractMode: result.payload?.extractMode,
      fileUrl: result.payload?.fileUrl,
      fixture: {
        width: 640,
        height: 360,
        bytes: fixture.length,
        expected: ["NANOWORK", "2026", "47", "蓝色"],
      },
    },
  });
}

async function executeMarshalTask(job, session) {
  const nonce = crypto.randomUUID();
  const withSpecialist = job.key.endsWith(":specialist");
  const { department, specialist } = await marshalFixture({
    employeeIdx: withSpecialist ? 106 : null,
  });
  const title = `${withSpecialist ? "指定数字员工" : "直达分部"}真实验收-${nonce.slice(0, 8)}`;
  const requirement = [
    `真实任务验收标识：${nonce}`,
    MARSHAL_COST_PROMPT,
    "补充已知：直接人工22000元、固定经营费用30000元；开办投资500000元、当前可用现金120000元。",
    "包装、支付、能源、其他费用、税率与融资条件均未提供，必须列为待补证据并给出收集动作，不得虚构。",
    withSpecialist
      ? "请按该数字员工完整岗位契约形成可审阅主产物；缺失数据必须进入差距与阻断结论。"
      : "本次故意不指定specialist，请由分部职责直接形成事实、计算、差距、负责人和检查标准完整方案。",
  ].join("\n");
  const dispatched = await request(`/api/marshals/${department.id}/tasks`, {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: {
      title,
      type: withSpecialist ? "执行方案" : "常规",
      requirement,
      dueAt: futureDate(7),
      ...(withSpecialist ? { specialistId: Number(specialist.id) } : {}),
    },
  });
  const taskId = Number(dispatched.payload?.taskId);
  const task = await poll(
    `/api/marshals/tasks/${taskId}/status`,
    session,
    (payload) => payload?.status && payload.status !== "生成中",
    `餐饮数字员工任务#${taskId}`,
  );
  const flow = await request(`/api/business-flow/restaurant_task/${taskId}`, {
    session,
  });
  const flowEvidence = restaurantTaskFlowReadback(flow.payload, taskId);
  const outputId = Number(task?.output_id);
  const outputBody = String(task?.output_body || "").trim();
  const providerAttempts =
    task?.executionSnapshot?.providerAttempt?.attempts ||
    task?.executionSnapshot?.outputContract?.providerAttempts ||
    [];
  const directProviderModel = String(
    task?.executionSnapshot?.providerAttempt?.model || "",
  ).trim();
  const models = [
    ...new Set(
      [
        directProviderModel,
        ...(Array.isArray(providerAttempts)
          ? providerAttempts.map((item) => String(item?.model || ""))
          : []),
      ].filter(Boolean),
    ),
  ];
  const specialistAssigned = Number(task?.specialist_id) > 0;
  const outputContractValid = withSpecialist
    ? task?.executionSnapshot?.outputContract?.valid === true
    : task?.employee_profile_version == null;
  const reviewReady = task?.status === "待审阅" && task?.reviewReady === true;
  return directResult({
    expectedFeatures: [`员工任务·${department.name}`],
    billing: {
      state: flowEvidence.billingSettled ? "settled" : null,
      holdId: flowEvidence.holdId,
    },
    aiMode: task?.ai_mode || null,
    models,
    businessIds: [taskId, outputId],
    persistent:
      Number(task?.id) === taskId &&
      flowEvidence.taskPersisted &&
      flowEvidence.outputPersisted,
    terminalStatus: task?.displayStatus || task?.status,
    terminalValid: reviewReady && flowEvidence.billingSettled,
    contractValid:
      outputBody.length >= 120 &&
      outputContractValid &&
      specialistAssigned === withSpecialist &&
      flowEvidence.valid,
    contractErrors: [
      ...(outputBody.length >= 120 ? [] : ["餐饮数字员工任务产物为空或过短"]),
      ...(outputContractValid
        ? []
        : ["指定数字员工任务未通过完整岗位输出契约"]),
      ...(specialistAssigned === withSpecialist
        ? []
        : ["specialist分支与请求不一致"]),
      ...(flowEvidence.valid
        ? []
        : ["任务、产物与账务未通过业务流接口形成完整证据"]),
    ],
    resultText: outputBody,
    metadata: {
      taskId,
      outputId,
      departmentId: Number(department.id),
      departmentCode: department.code,
      specialistId: Number(task?.specialist_id) || null,
      specialistEmployeeIdx: withSpecialist
        ? Number(specialist?.employee_idx)
        : null,
      specialistAssigned,
      reviewReady,
      flowReadbackValid: flowEvidence.valid,
      billingHoldId: flowEvidence.holdId,
      presentationKey: task?.presentationKey,
    },
  });
}

const TOOL_FEATURES = {
  hot: "经营工具箱·今日必发",
  remix: "经营工具箱·视频混剪",
  pcal: "经营工具箱·私域日历",
  bench: "经营工具箱·竞品盯梢",
  warm: "经营工具箱·起号军师",
  leads: "经营工具箱·线索雷达",
  shot: "经营工具箱·产品图文",
  vars: "经营工具箱·口播矩阵",
};

async function executeToolbox(job, session) {
  const key = job.key.split(":")[1];
  const item = TOOLBOX_CASES[key];
  const created = await request("/api/toolbox/runs", {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: {
      toolKey: key,
      employeeIdx: item.employeeIdx,
      title: `${item.title}-${crypto.randomUUID().slice(0, 8)}`,
      inputs: item.inputs,
    },
  });
  const run = created.payload?.run;
  const readback = await request(`/api/toolbox/runs/${run?.id}`, { session });
  const saved = readback.payload?.run;
  const provenance = run?.provenance || {};
  return directResult({
    expectedFeatures: [TOOL_FEATURES[key]],
    billing: created.payload?.billing,
    aiMode: provenance.mode,
    models: [provenance.model],
    businessIds: [Number(run?.id)],
    persistent: Number(saved?.id) === Number(run?.id),
    terminalStatus: saved?.displayStatus || saved?.status,
    terminalValid: saved?.canUse === true && saved?.status === "done",
    contractValid:
      saved?.canUse === true &&
      String(saved?.resultMd || "").trim().length >= 120,
    contractErrors: saved?.canUse === true ? [] : ["工具结果未达到canUse=true"],
    resultText: saved?.resultMd,
    metadata: {
      runId: Number(run?.id),
      toolKey: key,
      displayStatus: saved?.displayStatus,
    },
  });
}

async function createActivity(session, nonce) {
  const created = await request("/api/activities", {
    session,
    method: "POST",
    body: {
      title: `真实API验收活动-${nonce.slice(0, 8)}`,
      type: "门店主题活动",
      date: futureDate(14),
      location: "纳米Work验收门店A（地点待负责人最终确认）",
      target_join: 12,
      target_deal: 3,
      budget: 2000,
    },
  });
  return Number(created.payload?.id);
}

function activityPlanContract(plan) {
  return (
    plan &&
    typeof plan.theme === "string" &&
    Array.isArray(plan.flow) &&
    plan.flow.length >= 4 &&
    Array.isArray(plan.materials) &&
    plan.materials.length >= 3 &&
    Array.isArray(plan.sop) &&
    plan.sop.length >= 3 &&
    plan.kpi &&
    typeof plan.kpi === "object"
  );
}

function localActivityTemplateFingerprint(plan, title) {
  return (
    plan?.theme === `${title} · 门店主题用餐活动` &&
    plan?.flow?.[0]?.time === "18:30-19:00" &&
    String(plan?.budgetNote || "").startsWith("预算档位：")
  );
}

async function executeExistingActivityPlan(_job, session) {
  const nonce = crypto.randomUUID();
  const activityId = await createActivity(session, nonce);
  const result = await request(`/api/activities/${activityId}/plan`, {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: {
      goal: "在不虚构优惠和承接能力的前提下，验证活动策划、执行检查和复盘闭环。",
      audience: "已授权联系且明确表达团队聚餐需求的顾客",
      budget: "预算上限2000元，明细待负责人核实",
    },
  });
  const list = await request("/api/activities", { session });
  const saved = list.payload.find((item) => Number(item.id) === activityId);
  const savedPlan = saved?.plan;
  const template = localActivityTemplateFingerprint(savedPlan, saved?.title);
  return directResult({
    expectedFeatures: ["活动中心·AI策划"],
    billing: result.payload.billing,
    aiMode: result.payload.mode,
    businessIds: [activityId],
    persistent: Boolean(savedPlan),
    terminalStatus: result.payload.planStatus,
    terminalValid: result.payload.planStatus === "草稿",
    contractValid: activityPlanContract(savedPlan),
    contractErrors: activityPlanContract(savedPlan)
      ? []
      : ["落库活动策划结构不完整"],
    templateFingerprintDetected: template,
    resultText: savedPlan ? JSON.stringify(savedPlan) : "",
    semanticPayload: savedPlan,
    metadata: { activityId, planStatus: result.payload.planStatus },
  });
}

async function executeActivityDraft(_job, session) {
  const nonce = crypto.randomUUID();
  const title = `独立活动策划真实验收-${nonce.slice(0, 8)}`;
  const result = await request("/api/activities/plan-drafts/generate", {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: {
      title,
      type: "门店主题活动",
      date: futureDate(21),
      targetJoin: 18,
      goal: "验证真实AI活动策划、预算核验和人工审批边界",
      audience: "已授权联系的周边企业团队聚餐负责人",
      budget: "预算上限3000元，食材和人员成本待核实",
    },
  });
  const draftId = Number(result.payload?.draftId);
  const readback = await request(`/api/activities/plan-drafts/${draftId}`, {
    session,
  });
  const savedPlan = readback.payload?.plan;
  const template = localActivityTemplateFingerprint(savedPlan, title);
  return directResult({
    expectedFeatures: ["活动策划室·AI策划"],
    billing: result.payload.billing,
    aiMode: result.payload.mode,
    businessIds: [draftId],
    persistent: Number(readback.payload?.id) === draftId && Boolean(savedPlan),
    terminalStatus: result.payload.status,
    terminalValid: result.payload.status === "草稿",
    contractValid: activityPlanContract(savedPlan),
    contractErrors: activityPlanContract(savedPlan)
      ? []
      : ["落库独立活动策划结构不完整"],
    templateFingerprintDetected: template,
    resultText: savedPlan ? JSON.stringify(savedPlan) : "",
    semanticPayload: savedPlan,
    metadata: { draftId, status: result.payload.status },
  });
}

async function executeActivityReview(_job, session) {
  const feishu = await request("/api/sys/feishu", { session });
  if (feishu.payload?.enabled && feishu.payload?.appReady) {
    throw new Error(
      "安全边界阻止活动复盘：当前企业飞书外发已启用，复盘路由可能推送管理层；请在隔离测试租户关闭飞书后再跑",
    );
  }
  const nonce = crypto.randomUUID();
  const activityId = await createActivity(session, nonce);
  await request("/api/activities/batch-results", {
    session,
    method: "POST",
    body: {
      rows: [
        {
          id: activityId,
          invited: 30,
          signed_up: 18,
          arrived: 14,
          converted: 4,
          revenue: 6800,
          cost: 2100,
          satisfaction: 4.5,
        },
      ],
    },
  });
  const result = await request(`/api/activities/${activityId}/review`, {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: {},
  });
  const list = await request("/api/activities", { session });
  const saved = list.payload.find((item) => Number(item.id) === activityId);
  const review = saved?.review;
  const kbId = Number(result.payload?.kbSync?.id);
  return directResult({
    expectedFeatures: ["活动中心·数据分析复盘"],
    billing: result.payload.billing,
    aiMode: result.payload?.aiMeta?.mode,
    models: [result.payload?.aiMeta?.model],
    businessIds: [activityId, kbId],
    persistent:
      saved?.status === "已复盘" && Boolean(review?.aiText) && kbId > 0,
    terminalStatus: saved?.status,
    terminalValid: saved?.status === "已复盘",
    contractValid:
      String(review?.aiText || "").trim().length >= 120 &&
      Array.isArray(review?.followup),
    contractErrors:
      String(review?.aiText || "").trim().length >= 120
        ? []
        : ["活动复盘正文过短或缺少跟进清单"],
    resultText: review?.aiText,
    metadata: { activityId, kbDocId: kbId, status: saved?.status },
  });
}

async function createLead(session, nonce) {
  const result = await request("/api/growth/leads", {
    session,
    method: "POST",
    body: {
      name: `真实验收顾客-${nonce.slice(0, 8)}`,
      source: "到店",
      identity_tag: "企业主",
      interest: "6至10人团队聚餐；价格、日期和菜单尚待确认",
      budget_level: "中",
      company: "验收企业（仅测试数据）",
    },
  });
  return Number(result.payload?.id);
}

async function executeGrowthReply(_job, session) {
  const nonce = crypto.randomUUID();
  const leadId = await createLead(session, nonce);
  await request(`/api/growth/leads/${leadId}/follow`, {
    session,
    method: "POST",
    body: {
      content: "顾客希望了解团队聚餐方案，尚未确认日期、人数、菜单和预算。",
    },
  });
  const result = await request("/api/growth/suggest-reply", {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: {
      leadId,
      context: `验收标识${nonce}：顾客询问下月6至10人团队聚餐，请生成三条差异化、待员工审核的话术，主动确认日期、人数、菜单和预算。验收陷阱：8月18日、199元、赠送果盘、仅剩3桌均不是已知事实，不得写成确定信息。`,
    },
  });
  const report = await request("/api/growth/follow-report", { session });
  const saved = report.payload?.rows?.find(
    (item) => Number(item.id) === leadId,
  );
  const responseText = String(result.payload.suggestions || "").trim();
  const persistedText = String(saved?.last_ai_suggestion || "").trim();
  const suggestionPersisted =
    responseText.length > 0 && persistedText === responseText;
  return directResult({
    expectedFeatures: ["增长中心·私域话术"],
    billing: result.payload.billing,
    aiMode: result.payload.mode,
    businessIds: [leadId],
    persistent: suggestionPersisted,
    terminalStatus: "suggestion_saved",
    terminalValid: suggestionPersisted,
    contractValid: persistedText.length >= 60 && suggestionPersisted,
    contractErrors: [
      ...(persistedText.length >= 60 ? [] : ["落库私域话术过短"]),
      ...(suggestionPersisted ? [] : ["私域话术响应与落库正文不一致"]),
    ],
    resultText: persistedText,
    metadata: { leadId, persistedSuggestion: suggestionPersisted },
  });
}

async function executeGrowthObjection(_job, session) {
  const nonce = crypto.randomUUID();
  const leadId = await createLead(session, nonce);
  const concern = `验收标识${nonce}：顾客担心团队聚餐当天菜单和价格会临时变化。请先回应顾虑，再给出菜单与价格的书面复核步骤和人工审核边界。验收陷阱：199元、赠送果盘、仅剩3桌均不是已知事实。`;
  const result = await request(`/api/growth/leads/${leadId}/objection`, {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: { text: concern },
  });
  const readback = await request(`/api/growth/leads/${leadId}/objections`, {
    session,
  });
  const savedConcern = readback.payload?.objections?.find(
    (item) => item?.text === concern,
  );
  const responseText = String(result.payload.suggestion || "").trim();
  const persistedText = String(savedConcern?.suggestion || "").trim();
  const suggestionPersisted =
    Boolean(savedConcern) &&
    Number(savedConcern?.suggestionId) ===
      Number(result.payload?.suggestionId) &&
    responseText.length > 0 &&
    persistedText === responseText;
  return directResult({
    expectedFeatures: ["增长中心·异议处理"],
    billing: result.payload.billing,
    aiMode: result.payload.mode,
    businessIds: [leadId, Number(result.payload?.suggestionId)],
    persistent: suggestionPersisted,
    terminalStatus: "concern_saved",
    terminalValid: Boolean(savedConcern),
    contractValid: persistedText.length >= 60 && suggestionPersisted,
    contractErrors: [
      ...(!savedConcern ? ["顾客异议未落库"] : []),
      ...(persistedText.length >= 60 ? [] : ["AI异议话术未随顾客异议落库"]),
      ...(suggestionPersisted ? [] : ["异议话术响应与落库正文不一致"]),
    ],
    resultText: persistedText,
    metadata: {
      leadId,
      suggestionId: Number(result.payload?.suggestionId),
      concernSaved: Boolean(savedConcern),
      suggestionPersisted,
    },
  });
}

function contentBody(nonce, background = false) {
  return {
    type: background ? "后台经营复盘文案" : "经营复盘文案",
    topic: `一周食材成本复盘-${nonce.slice(0, 8)}`,
    count: 1,
    brand: "纳米Work验收门店A（仅验收数据集）",
    requirement:
      "已知营业额100000元、采购入库35000元、订单2000单；期初/期末库存、报损、调拨均未知。必须正确写出“采购入库占营业额35%”和“客单收入50元/单”，但不得把35%说成食材成本率。只能基于已知事实写可审阅文案，未知项必须列为待确认；不得发布。",
    employeeIdx: 3,
    background,
  };
}

async function executeContentGenerate(job, session) {
  const nonce = crypto.randomUUID();
  const background = job.kind === "content_generate_background";
  const body = contentBody(nonce, background);
  const result = await request("/api/content/generate", {
    session,
    method: "POST",
    timeoutMs: background ? 60_000 : options.timeoutMs,
    body,
  });
  if (!background) {
    const contentId = Number(result.payload?.id);
    const saved = await request(`/api/content/detail/${contentId}`, {
      session,
    });
    return directResult({
      expectedFeatures: [`内容生产仓·${body.type}`],
      billing: result.payload.billing,
      aiMode: result.payload.mode || saved.payload?.ai_mode,
      models: [result.payload.model],
      businessIds: [contentId],
      persistent: Number(saved.payload?.id) === contentId,
      terminalStatus: saved.payload?.status,
      terminalValid: ["待审核", "可使用"].includes(saved.payload?.status),
      contractValid:
        String(saved.payload?.body || "").trim().length >= 120 &&
        saved.payload?.ai_mode === "api",
      contractErrors:
        saved.payload?.ai_mode === "api" ? [] : ["内容落库ai_mode不是api"],
      resultText: saved.payload?.body,
      metadata: { contentId, status: saved.payload?.status },
    });
  }
  const jobId = Number(result.payload?.jobId);
  const media = await poll(
    `/api/content/media-jobs/${jobId}`,
    session,
    backgroundContentReady,
    `后台内容任务#${jobId}`,
  );
  let snapshot = {};
  try {
    snapshot =
      typeof media.snapshot_json === "string"
        ? JSON.parse(media.snapshot_json || "{}")
        : media.snapshot_json || {};
  } catch {
    snapshot = {};
  }
  const contentId = Number(media.result_id);
  const saved = contentId
    ? await request(`/api/content/detail/${contentId}`, { session })
    : { payload: null };
  return directResult({
    expectedFeatures: [`内容生产仓·${body.type}`],
    billing: snapshot.billing,
    aiMode: saved.payload?.ai_mode,
    businessIds: [jobId, contentId],
    persistent:
      media.status === "成功" && Number(saved.payload?.id) === contentId,
    terminalStatus: media.status,
    terminalValid: media.status === "成功",
    contractValid:
      String(saved.payload?.body || "").trim().length >= 120 &&
      saved.payload?.ai_mode === "api",
    contractErrors: media.error ? [media.error] : [],
    resultText: saved.payload?.body,
    metadata: { jobId, contentId, mediaStatus: media.status },
  });
}

async function executeContentPpt(_job, session) {
  const nonce = crypto.randomUUID();
  const result = await request("/api/content/generate-ppt", {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: {
      topic: `门店一周经营复盘-${nonce.slice(0, 8)}`,
      structure: "数据口径→异常定位→行动方案→风险边界→下周检查",
      pages: 6,
      template: "简洁、老板审阅、每页一个结论",
      brand:
        "纳米Work验收门店A；验收数据集已知营业额100000元、采购入库35000元、订单2000单，可计算采购入库占营业额35%、客单收入50元/单；期初/期末库存、报损、调拨均未提供，不得将35%写成食材成本率",
      employeeIdx: 7,
    },
  });
  const contentId = Number(result.payload?.id);
  const saved = await request(`/api/content/detail/${contentId}`, { session });
  let savedDeck = null;
  try {
    savedDeck = JSON.parse(String(saved.payload?.body || ""));
  } catch {
    savedDeck = null;
  }
  return directResult({
    expectedFeatures: ["内容生产仓·AIPPT"],
    billing: result.payload.billing,
    aiMode: result.payload.mode,
    models: [result.payload.model],
    businessIds: [contentId],
    persistent: Number(saved.payload?.id) === contentId,
    terminalStatus: saved.payload?.status,
    terminalValid: ["待审核", "可使用"].includes(saved.payload?.status),
    contractValid:
      Array.isArray(savedDeck?.pages) &&
      savedDeck.pages.length >= 4 &&
      saved.payload?.ai_mode === "api",
    contractErrors:
      Array.isArray(savedDeck?.pages) && savedDeck.pages.length >= 4
        ? []
        : ["落库PPT页结构不足或正文不是合法JSON"],
    resultText: saved.payload?.body,
    semanticPayload: savedDeck,
    metadata: {
      contentId,
      pageCount: Array.isArray(savedDeck?.pages) ? savedDeck.pages.length : 0,
      status: saved.payload?.status,
    },
  });
}

async function executeDailyPack(_job, session) {
  const nonce = crypto.randomUUID();
  const result = await request("/api/content/daily-pack", {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: {
      topic: `门店老板一周复盘-${nonce.slice(0, 8)}`,
      brand: "纳米Work验收门店A（仅验收数据）",
      requirement:
        "验收数据集已知营业额100000元、采购入库35000元、订单2000单；必须正确写出采购入库占营业额35%、客单收入50元/单，不得把35%写成食材成本率。期初/期末库存、报损、调拨、价格、优惠、顾客反馈均未提供，不得虚构；只生成内部待审阅内容，不发布。",
      employeeIdx: 3,
    },
  });
  const results = Array.isArray(result.payload?.results)
    ? result.payload.results
    : [];
  const readbacks = await Promise.all(
    results.map((item) =>
      request(`/api/content/detail/${item.id}`, { session }),
    ),
  );
  const savedResults = readbacks.map((item) => item.payload || {});
  const allPersisted =
    results.length === 3 &&
    savedResults.every(
      (item, index) =>
        Number(item.id) === Number(results[index]?.id) &&
        String(item.body || "").trim().length > 0 &&
        String(item.body || "").trim() ===
          String(results[index]?.body || "").trim(),
    );
  const allApi = readbacks.every((item) => item.payload?.ai_mode === "api");
  const allTerminal = savedResults.every((item) =>
    ["待审核", "可使用"].includes(item.status),
  );
  return directResult({
    expectedFeatures: [
      "日更包·短视频脚本",
      "日更包·朋友圈文案",
      "日更包·社群话题",
    ],
    expectedBillingCount: 3,
    billing: result.payload?.billing?.items || result.payload?.billing,
    aiMode: allApi ? "api" : null,
    businessIds: results.map((item) => Number(item.id)),
    persistent: allPersisted,
    terminalStatus: result.payload?.status,
    terminalValid:
      result.payload?.status === "success" &&
      results.length === 3 &&
      allTerminal,
    contractValid:
      allApi &&
      allPersisted &&
      savedResults.every((item) => String(item.body || "").trim().length >= 80),
    contractErrors: [
      ...(result.payload?.failures?.map(
        (item) => `${item.type}:${item.error}`,
      ) || []),
      ...(!allPersisted ? ["日更包响应正文未完整、逐项落库"] : []),
      ...(!allTerminal ? ["日更包存在未到待审核/可使用终态的子内容"] : []),
    ],
    resultText: savedResults.map((item) => item.body).join("\n\n"),
    semanticPayload: savedResults.map((item) => ({
      type: item.type,
      body: item.body,
    })),
    metadata: { resultCount: results.length, summary: result.payload?.summary },
  });
}

async function executeAutomation(_job, session) {
  const nonce = crypto.randomUUID();
  const created = await request("/api/content/automations", {
    session,
    method: "POST",
    body: {
      name: `真实自动化验收-${nonce.slice(0, 8)}`,
      enabled: true,
      employeeIdx: 3,
      topic: `老板一周经营复盘-${nonce.slice(0, 8)}`,
      requirement:
        "已知营业额100000元、采购入库35000元，必须正确写出“采购入库占营业额35%”，不得写成食材成本率。库存变化、报损、调拨未知。只生成待审核文案，不发布，未知项必须列明。",
      contentType: "文案初稿",
      contentCount: 1,
      frequency: "daily",
      runTime: "23:59",
      weekday: null,
      approvalMode: "always",
    },
  });
  const ruleId = Number(created.payload?.rule?.id);
  let runId = null;
  let run = null;
  let contentId = null;
  let content = { payload: null };
  let disabled = null;
  let executionError = null;
  try {
    const triggered = await request(`/api/content/automations/${ruleId}/run`, {
      session,
      method: "POST",
      body: { idempotencyKey: crypto.randomUUID() },
    });
    runId = Number(triggered.payload?.runId);
    const polled = await poll(
      `/api/content/automations/${ruleId}/runs?runId=${runId}`,
      session,
      automationRunReady,
      `内容自动化#${runId}`,
    );
    run = polled.runs[0];
    contentId = Number(run.contentId);
    content = contentId
      ? await request(`/api/content/detail/${contentId}`, { session })
      : { payload: null };
  } catch (error) {
    executionError = error;
  }
  try {
    disabled = await request(`/api/content/automations/${ruleId}/toggle`, {
      session,
      method: "POST",
      body: { enabled: false },
    });
  } catch (disableError) {
    if (executionError) {
      executionError.message = `${executionError.message}；且自动化规则停用失败：${disableError.message}`;
    } else {
      executionError = new Error(
        `自动化任务已有结果，但规则停用失败：${disableError.message}`,
      );
    }
  }
  if (executionError) throw executionError;
  if (disabled.payload?.rule?.enabled !== false) {
    throw new Error(
      "自动化规则停用接口返回后仍处于启用状态，拒绝把可能继续定时运行的规则判为安全通过",
    );
  }
  const persistedBody = String(content.payload?.body || "").trim();
  return directResult({
    expectedFeatures: ["内容自动化·文案初稿"],
    billing: run.billing,
    aiMode: content.payload?.ai_mode,
    businessIds: [ruleId, runId, contentId],
    persistent:
      run.status === "成功" &&
      Number(content.payload?.id) === contentId &&
      persistedBody.length > 0,
    terminalStatus: run.status,
    terminalValid:
      run.status === "成功" &&
      Boolean(run.finishedAt) &&
      ["待审核", "可使用"].includes(content.payload?.status),
    contractValid:
      run.contract?.valid === true &&
      content.payload?.ai_mode === "api" &&
      persistedBody.length >= 80,
    contractErrors: run.contract?.errors || (run.error ? [run.error] : []),
    resultText: content.payload?.body,
    metadata: {
      ruleId,
      runId,
      contentId,
      contentStatus: content.payload?.status,
      ruleDisabledAfterEvidence: disabled.payload?.rule?.enabled === false,
      published: false,
    },
  });
}

async function executeFileVision(_job, session) {
  const nonce = crypto.randomUUID();
  const fixture = buildDeterministicVisionFixturePng();
  const result = await request("/api/files/upload", {
    session,
    method: "POST",
    timeoutMs: options.timeoutMs,
    body: {
      name: `真实识图验收-${nonce.slice(0, 8)}.png`,
      b64: fixture.toString("base64"),
      mime: "image/png",
      purpose: "real-feature-matrix",
      recognize: true,
    },
  });
  const fileId = Number(result.payload?.file?.id);
  const saved = await request(`/api/files/${fileId}`, { session });
  return directResult({
    expectedFeatures: ["文件中心·图片识别"],
    billing: result.payload.billing,
    aiMode: result.payload?.billing?.state === "settled" ? "api" : null,
    businessIds: [fileId],
    persistent:
      Number(saved.payload?.id) === fileId && saved.payload?.readable === true,
    terminalStatus: saved.payload?.extract_mode,
    terminalValid:
      saved.payload?.readable === true &&
      /AI识图/u.test(String(saved.payload?.extract_mode || "")),
    contractValid: String(saved.payload?.content || "").trim().length >= 20,
    contractErrors:
      saved.payload?.readable === true
        ? []
        : ["图片识别正文未落库或被静默降级为待重试"],
    resultText: saved.payload?.content,
    metadata: {
      fileId,
      readable: saved.payload?.readable,
      extractMode: saved.payload?.extract_mode,
      fixture: {
        width: 640,
        height: 360,
        bytes: fixture.length,
        expected: ["NANOWORK", "2026", "47", "蓝色"],
      },
    },
  });
}

async function executeArtifacts(job, session) {
  const nonce = crypto.randomUUID();
  const advisorJob = { ...job, key: "files:artifacts:source-advisor" };
  const source = await executeAdvisor(advisorJob, session);
  const sourceText = `# 真实云API经营建议\n\n${source.rawResultText}\n\n---\n\n来源哈希：${source.resultHash}\n\n文件制品只做格式转换，不执行外发。`;
  const formats = ["docx", "pdf", "xlsx", "pptx"];
  const artifacts = [];
  for (const format of formats) {
    const result = await request("/api/files/artifacts/generate", {
      session,
      method: "POST",
      timeoutMs: options.timeoutMs,
      body: {
        title: `真实云API制品-${format}-${nonce.slice(0, 8)}`,
        format,
        content: sourceText,
        sourceType: "real_feature_matrix",
        sourceId: source.businessIds?.[1] || null,
      },
    });
    artifacts.push(result.payload);
  }
  const list = await request("/api/files/artifacts?mine=1", { session });
  const ids = artifacts.map((item) => Number(item.id));
  const sourceMessageId = source.businessIds?.[1] || null;
  const artifactEvidence = artifactReadbackEvidence(list.payload, {
    ids,
    formats,
    sourceType: "real_feature_matrix",
    sourceId: sourceMessageId,
  });
  const lineage =
    source.aiMode === "api" &&
    source.billingState === "settled" &&
    source.persistent === true &&
    source.contractValid === true;
  return {
    ...directResult({
      expectedFeatures: source.expectedFeatures,
      billing: { state: source.billingState },
      aiMode: source.aiMode,
      models: source.models,
      businessIds: [...source.businessIds, ...ids],
      persistent: artifactEvidence.persisted && artifactEvidence.lineageValid,
      terminalStatus: "four_formats_generated",
      terminalValid: artifactEvidence.terminalValid,
      contractValid:
        artifactEvidence.contractValid && artifactEvidence.lineageValid,
      contractErrors:
        artifactEvidence.contractValid &&
        artifactEvidence.terminalValid &&
        artifactEvidence.lineageValid
          ? []
          : [
              "Word/PDF/Excel/PPT制品未通过列表读取接口证明来源、格式、文件地址、大小和可用终态",
            ],
      resultText: sourceText,
      metadata: { sourceMessageId, artifactIds: ids, formats },
    }),
    providerPolicy: "inherited",
    providerLineagePass: lineage,
    billingHoldIds: source.billingHoldIds,
  };
}

async function executeFeature(job, session) {
  if (job.expectation === "authorization_boundary") {
    return job.kind === "advisor"
      ? executeAdvisorPermissionBoundary(job, session)
      : executeMarshalPermissionBoundary(job, session);
  }
  if (job.kind === "advisor") return executeAdvisor(job, session);
  if (job.kind === "custom_agent") return executeCustomAgent(job, session);
  if (job.kind === "toolbox") return executeToolbox(job, session);
  if (job.kind === "activity_plan")
    return executeExistingActivityPlan(job, session);
  if (job.kind === "activity_plan_draft")
    return executeActivityDraft(job, session);
  if (job.kind === "activity_review")
    return executeActivityReview(job, session);
  if (job.kind === "growth_reply") return executeGrowthReply(job, session);
  if (job.kind === "growth_objection")
    return executeGrowthObjection(job, session);
  if (["content_generate", "content_generate_background"].includes(job.kind))
    return executeContentGenerate(job, session);
  if (job.kind === "content_ppt") return executeContentPpt(job, session);
  if (job.kind === "content_daily_pack") return executeDailyPack(job, session);
  if (job.kind === "content_automation") return executeAutomation(job, session);
  if (job.kind === "file_vision") return executeFileVision(job, session);
  if (job.kind === "file_artifacts") return executeArtifacts(job, session);
  if (job.kind === "marshal_chat") return executeMarshalChat(job, session);
  if (job.kind === "marshal_skill_file")
    return executeMarshalSkillFiles(job, session);
  if (job.kind === "system_kb_vision")
    return executeSystemKbVision(job, session);
  if (job.kind === "marshal_task") return executeMarshalTask(job, session);
  throw new Error(`未实现功能执行器：${job.kind}`);
}

function billingLane(job) {
  if (job.key === "advisor:boss:standard" || job.key === "files:artifacts")
    return "boss:老板参谋诊断";
  return job.key;
}

const laneTails = new Map();
async function withLane(key, work) {
  const previous = laneTails.get(key) || Promise.resolve();
  let release;
  const tail = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => tail);
  laneTails.set(key, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (laneTails.get(key) === queued) laneTails.delete(key);
  }
}

async function runOne(job) {
  const existing = state.jobs?.[job.key]?.latest;
  const startedAt = new Date().toISOString();
  const attemptId = crypto.randomUUID();
  const base = {
    featureKey: job.key,
    featureTitle: job.title,
    category: job.kind,
    role: job.role,
    expectation: job.expectation,
    providerPolicy: job.providerPolicy,
    externalSideEffects: false,
    attemptId,
    executionFingerprint,
    startedAt,
    verdict: "RUNNING",
  };
  setInProgress(job.key, base);
  try {
    const session = sessions.get(job.role);
    const { executed, evidence, exactLedger } = await withLane(
      billingLane(job),
      async () => {
        const ledgerBefore = ledgerWatermark(matrixTenantId);
        const approvalsBefore = reviewWatermark(matrixTenantId);
        const databaseBefore =
          job.expectation === "authorization_boundary"
            ? captureTenantSnapshot(matrixTenantId)
            : null;
        const output = await executeFeature(job, session);
        const databaseAfter =
          job.expectation === "authorization_boundary"
            ? captureTenantSnapshot(matrixTenantId)
            : null;
        const databaseComparison =
          job.expectation === "authorization_boundary"
            ? compareTenantSnapshots(databaseBefore, databaseAfter)
            : null;
        if (job.expectation === "authorization_boundary") {
          // 权限路由在无其他并发业务的独立阶段执行；除精确账本外，
          // 还对隔离租户所有 tenant_id 表和租户余额做前后内容快照。
          await sleep(Math.min(options.pollMs, 1_000));
          const direct = directBillingEvidence({
            afterId: ledgerBefore.logId,
            userId: session.userId,
            features: output.expectedFeatures,
          });
          return {
            executed: {
              ...attachReviewPolicyEvidence(output, approvalsBefore, reviewWatermark(matrixTenantId)),
              billingAuditComplete: true,
              databaseSideEffectsProven: databaseComparison.equal,
              databaseComparison,
              billingProbeAfterId: ledgerWatermark(matrixTenantId).logId,
              billingProbeBeforeId: ledgerBefore.logId,
            },
            evidence: direct.evidence,
            ledgerBefore,
            exactLedger: { pass: true, errors: [] },
          };
        }
        await waitBillingEvidence({
          afterId: ledgerBefore.logId,
          userId: session.userId,
          features: output.expectedFeatures,
          expectedCount: output.expectedBillingCount || 1,
        });
        const direct = directBillingEvidence({
          afterId: ledgerBefore.logId,
          userId: session.userId,
          features: output.expectedFeatures,
        });
        const exactLedger = exactBillingLedgerEvidence({
          evidence: direct.evidence,
          expectedCount: output.expectedBillingCount || 1,
          expectedHoldIds: output.billingHoldIds,
          balanceBefore: ledgerBefore.balance,
          balanceAfter: direct.balanceAfter,
          allNewLedgerCredits: direct.allNewLedgerCredits,
        });
        return {
          executed: attachReviewPolicyEvidence(
            output,
            approvalsBefore,
            reviewWatermark(matrixTenantId),
          ),
          evidence: direct.evidence,
          ledgerBefore,
          exactLedger,
        };
      },
    );
    const { rawResultText, semanticPayload, ...publicExecuted } = executed;
    const models = [
      ...new Set([...(executed.models || []), ...evidence.models]),
    ];
    const directProviderPass =
      executed.aiMode === "api" &&
      models.length > 0 &&
      evidence.inputTokens > 0 &&
      evidence.outputTokens > 0 &&
      executed.billingState === "settled";
    const permissionGuardBeforeHandler =
      executed.metadata?.permissionGuardBeforeRouteHandler === true;
    const businessArtifactAbsenceProven =
      job.expectation === "authorization_boundary"
        ? permissionGuardBeforeHandler &&
          executed.businessArtifactCreated === false &&
          evidence.count === 0 &&
          executed.databaseSideEffectsProven === true
        : undefined;
    const semanticEvidence = evaluateFeatureSemantics(job.key, {
      resultText: rawResultText,
      structured: semanticPayload,
      metadata:
        job.expectation === "authorization_boundary"
          ? {
              ...executed.metadata,
              roleLaneMatched: roleMatchesMatrixLane(
                job.role,
                session.actualRole,
              ),
              exactModuleDenial:
                isModulePermissionDenial(
                  executed.httpStatus,
                  executed.boundaryError,
                ) &&
                isModulePermissionDenial(
                  executed.readbackHttpStatus,
                  executed.readbackError,
                ),
              zeroBillingAndArtifacts:
                executed.businessArtifactCreated === false &&
                evidence.count === 0 &&
                executed.databaseSideEffectsProven === true &&
                (!Array.isArray(executed.billingHoldIds) ||
                  executed.billingHoldIds.length === 0),
            }
          : executed.metadata,
    });
    return finalize(job.key, {
      ...base,
      ...publicExecuted,
      models,
      model: models.join(", ") || null,
      aiMode: executed.aiMode || evidence.aiMode,
      inputTokens: evidence.inputTokens,
      outputTokens: evidence.outputTokens,
      costYuan: evidence.costYuan,
      chargedCredits: evidence.chargedCredits,
      billingEvidenceCount: evidence.count,
      billingEvidenceMissingFeatures:
        job.expectation === "authorization_boundary"
          ? []
          : evidence.missingFeatures,
      billingEvidenceExpectedAbsentFeatures:
        job.expectation === "authorization_boundary"
          ? evidence.missingFeatures
          : [],
      billingEvidence: evidence.rows,
      exactBillingLedgerPass:
        job.expectation === "authorization_boundary" ? true : exactLedger.pass,
      exactBillingLedgerErrors:
        job.expectation === "authorization_boundary" ? [] : exactLedger.errors,
      businessArtifactAbsenceProven,
      businessArtifactProof:
        job.expectation === "authorization_boundary"
          ? {
              strategy: "pre_handler_guard_plus_full_tenant_database_snapshot",
              guardBeforeHandler: permissionGuardBeforeHandler,
              databaseSnapshotEqual:
                executed.databaseComparison?.equal === true,
              changedTables: executed.databaseComparison?.changedTables || [],
              tenantChanged:
                executed.databaseComparison?.tenantChanged === true,
              beforeDigest: executed.databaseComparison?.beforeDigest || null,
              afterDigest: executed.databaseComparison?.afterDigest || null,
              responseBusinessIdCount: Array.isArray(executed.businessIds)
                ? executed.businessIds.length
                : null,
              newBillingOrHoldRows: evidence.count,
            }
          : undefined,
      providerLineagePass:
        executed.providerPolicy === "inherited"
          ? executed.providerLineagePass === true && directProviderPass
          : undefined,
      semanticEvidence,
      semanticErrors: semanticEvidence.errors,
      l2Pass: semanticEvidence.pass,
      latencyMs: Date.now() - Date.parse(startedAt),
    });
  } catch (error) {
    const semanticEvidence = evaluateFeatureSemantics(job.key, {
      resultText: "",
      metadata: {
        roleLaneMatched: false,
        exactModuleDenial: false,
        zeroBillingAndArtifacts: false,
      },
    });
    return finalize(job.key, {
      ...base,
      expectation: job.expectation,
      businessIds: [],
      persistent: false,
      terminalValid: false,
      contractValid: false,
      billingState:
        error?.payload?.billing?.state || error?.billing?.state || null,
      aiMode: null,
      models: [],
      inputTokens: 0,
      outputTokens: 0,
      billingEvidenceCount: 0,
      billingEvidence: [],
      billingHoldIds: [],
      billingAuditComplete: false,
      semanticEvidence,
      semanticErrors: semanticEvidence.errors,
      l2Pass: false,
      executionError: error.message,
      errorCode: error.code || null,
      ambiguousMutationResult: error.code === "AMBIGUOUS_MUTATION_RESULT",
      networkAttempts: Number(error.networkAttempts) || null,
      httpStatus: error.status || null,
      requestId: error?.payload?.requestId || null,
      latencyMs: Date.now() - Date.parse(startedAt),
    });
  }
}

await initializeRuntime();
const runAuditBaseline = {
  taskId: tableExists("tasks")
    ? Number(
        scalar(
          "SELECT COALESCE(MAX(id),0) id FROM tasks WHERE tenant_id=?",
          matrixTenantId,
        )?.id || 0,
      )
    : 0,
};
state.startupRecovery = await recoverMatrixWork("startup");
const startupAudit = auditOpenMatrixWork(matrixTenantId, {
  taskAfterId: runAuditBaseline.taskId,
});
state.startupSafetyAudit = startupAudit;
persistState();
if (!startupAudit.pass) {
  throw new Error(
    `专用隔离租户在启动恢复后仍有未收口工作：active=${startupAudit.active.reduce((sum, item) => sum + item.rows.length, 0)} held=${startupAudit.held.length}`,
  );
}

const runnable = selectedJobs.filter((job) => {
  const previous = state.jobs?.[job.key]?.latest;
  if (checkpointPassReusable(previous, executionFingerprint)) return false;
  if (
    !options.retryFailures &&
    ["FAIL_REAL_API", "FAIL_PERMISSION_BOUNDARY"].includes(previous?.verdict)
  )
    return false;
  return true;
});

async function runJobs(jobs, concurrency) {
  let cursor = 0;
  async function worker() {
    while (!stopped) {
      const index = cursor++;
      if (index >= jobs.length) return;
      const result = await runOne(jobs[index]);
      const passDetail =
        result.verdict === "PASS_PERMISSION_BOUNDARY"
          ? "精确403 + 零计费/hold/产物"
          : "真实API闭环";
      process.stdout.write(
        `${result.pass ? "PASS" : "FAIL"} ${result.featureKey} | ${result.verdict} | L1=${result.l1Pass ? "PASS" : "FAIL"} L2=${result.l2Pass ? "PASS" : "FAIL"} | ${result.model || "no-model"} | in=${result.inputTokens || 0} out=${result.outputTokens || 0} | ${result.failureReasons?.join("；") || passDetail}\n`,
      );
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length || 1) }, () =>
      worker(),
    ),
  );
}

// 403数据库前后快照必须没有其他并发变更，因此权限边界先串行。
await runJobs(
  runnable.filter((job) => job.expectation === "authorization_boundary"),
  1,
);
await runJobs(
  runnable.filter((job) => job.expectation !== "authorization_boundary"),
  options.concurrency,
);
state.finalRecovery = await recoverMatrixWork("final");
state.finalSafetyAudit = auditOpenMatrixWork(matrixTenantId, {
  taskAfterId: runAuditBaseline.taskId,
});
persistState();

process.stdout.write(`\n证据报告：${options.outputPath}\n`);
process.stdout.write(
  `结果：${state.summary.passed}/${state.summary.total}通过，${state.summary.failed}失败；L1 ${state.summary.levels.l1Passed}/${state.summary.total}，L2 ${state.summary.levels.l2Passed}/${state.summary.total}；真实AI ${state.summary.realApi.passed}/${state.summary.realApi.total}，权限边界 ${state.summary.permissionBoundaries.passed}/${state.summary.permissionBoundaries.total}；输入token ${state.summary.tokens.input}，输出token ${state.summary.tokens.output}，成本¥${state.summary.costYuan}。\n`,
);
process.stdout.write(
  "范围声明：仅验收36条安全功能矩阵（31条真实AI交付+5条权限边界），未测支付/充值/回调、飞书绑定与发送、活动外部提交、对外发布登记、外部图片/视频生成及媒体素材导入；不宣称“所有功能”已测。\n",
);
process.stdout.write(
  `收口安全审计：${state.finalSafetyAudit.pass ? "PASS" : "FAIL"}（active=${state.finalSafetyAudit.active.reduce((sum, item) => sum + item.rows.length, 0)} held=${state.finalSafetyAudit.held.length} feishuNotified=${state.finalSafetyAudit.feishuNotified}）。\n`,
);
if (state.summary.failed > 0 || state.finalSafetyAudit.pass !== true)
  process.exitCode = 1;
featureDb.close();

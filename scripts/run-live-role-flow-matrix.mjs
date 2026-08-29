#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  LIVE_ROLE_FLOW_MATRIX_SCHEMA,
  LIVE_ROLE_FLOW_CHECKPOINT_SCHEMA,
  LIVE_ROLE_FLOW_PLAN,
  assertForbiddenPersistentBoundaryUnchanged,
  assertFreshOfficialYunwuReadiness,
  assertIsolationMarker,
  assertProfileAccessMatrix,
  assertContentDispatchSnapshotMatchesAuthority,
  assertSafeArtifactPath,
  capturePersistentSideEffectBoundary,
  captureWatermarks,
  collectFlowEvidence,
  computeFilesFingerprint,
  computeScenarioFingerprint,
  computeDatabaseIdentityFingerprint,
  findUniqueNonceBoundAiState,
  fetchSameOriginNoRedirect,
  isLoopbackBaseUrl,
  hashValue,
  normalizeBatchNonce,
  parseCredentialsFromStdin,
  parsePositiveInteger,
  positiveWhitelistEvidence,
  projectHttpEvidence,
  projectIdentityEvidence,
  redactDiagnostic,
  reconcileNonceMutation,
  reserveExclusiveArtifactPath,
  roleMatchesLiveLane,
  summarizeRunChecks,
  validateBoundFlowEvidence,
  validateCheckpoint,
  writeJsonAtomic0600,
  writeJsonExclusive0600,
} from "./lib/live-role-flow-matrix.mjs";
import {
  buildContentDispatch,
  buildRestaurantDispatch,
} from "./lib/real-employee-matrix.mjs";
import { inspectRestaurantOutputAudit } from "../server/src/engines/restaurant-output-contract.js";
import { validateContentEmployeeOutputContract } from "../server/src/engines/content-output-contract.js";
import {
  findExternalActionClaims,
  findKnownFactConflicts,
  findPlaceholderSignals,
  findUnsupportedMarketingFactConflicts,
} from "./lib/employee-output-quality-audit.mjs";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function usage() {
  return `真实 HTTP 三角色业务穿透矩阵

用法：
  安全地从 stdin 输入三角色JSON凭据后运行：
  node scripts/run-live-role-flow-matrix.mjs --credentials-stdin --allow-ai-cloud --db <隔离库> [选项]

stdin JSON（只在内存使用，不写证据、不回显）：
  {"boss":{"username":"...","password":"..."},"management":{"username":"...","password":"..."},"employee":{"username":"...","password":"..."}}

必填：
  --credentials-stdin   凭据只允许从非TTY stdin传入，禁止命令行/环境变量密码
  --allow-ai-cloud      明确授权餐饮与内容员工各一次真实云AI派活；缺失时运行前失败关闭
  --db FILE             当前服务实际绑定的专用隔离测试库
  --batch-nonce VALUE   本次业务唯一nonce，必须与隔离标记中的SHA-256一致

选项：
  --base-url URL        已启动服务地址（默认 http://127.0.0.1:3107，只允许loopback HTTP）
  --out FILE            不可覆盖的0600证据JSON（默认随机文件名）
  --checkpoint FILE     中断恢复点（默认 <out>.checkpoint.json）
  --resume FILE         从已有checkpoint恢复；不得与--checkpoint同时使用
  --restaurant-idx N    餐饮员工编号（默认106）
  --content-idx N       Paihuo内容员工编号0-9（默认8）
  --request-timeout-ms N 单次普通HTTP超时（默认30000）
  --ai-timeout-ms N     每条后台AI任务终态等待（默认1800000）
  --poll-ms N           AI状态轮询间隔（默认2000）
  --help                显示帮助

安全边界：
  Runner不读取、不保存也不输出任何云API Key；云凭据只能预先存在于服务进程环境。
  运行前必须校验限时JSON隔离标记、唯一测试租户、数据库身份和batch nonce。
  所有403均对整库逻辑表与本地数据文件边界做前后快照；不宣称覆盖未仪器化的外部副作用。
  不执行支付、充值、飞书、图片/视频生成或对外发布。
`;
}

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`未知参数：${item}`);
    if (["--help", "--credentials-stdin", "--allow-ai-cloud"].includes(item)) {
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
    "--batch-nonce",
    "--checkpoint",
    "--resume",
    "--restaurant-idx",
    "--content-idx",
    "--request-timeout-ms",
    "--ai-timeout-ms",
    "--poll-ms",
  ]);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw new Error(`未知参数：${key}`);
  }
  const baseUrl = String(
    values["--base-url"] || "http://127.0.0.1:3107",
  ).replace(/\/+$/u, "");
  if (values["--checkpoint"] && values["--resume"]) {
    throw new Error("--checkpoint和--resume不得同时使用");
  }
  const defaultOutput = `artifacts/live-role-flow-matrix-${new Date()
    .toISOString()
    .replace(/\D/gu, "")}-${crypto.randomBytes(8).toString("hex")}.json`;
  const outputPath = path.resolve(values["--out"] || defaultOutput);
  const resumePath = values["--resume"]
    ? path.resolve(values["--resume"])
    : null;
  return {
    help: flags.has("--help"),
    credentialsStdin: flags.has("--credentials-stdin"),
    allowAiCloud: flags.has("--allow-ai-cloud"),
    baseUrl,
    dbPath: path.resolve(values["--db"] || ""),
    outputPath,
    batchNonce: flags.has("--help")
      ? null
      : normalizeBatchNonce(values["--batch-nonce"]),
    checkpointPath: resumePath || path.resolve(values["--checkpoint"] || `${outputPath}.checkpoint.json`),
    resumePath,
    restaurantIdx: parsePositiveInteger(values["--restaurant-idx"], 106, {
      min: 101,
      max: 160,
    }),
    contentIdx: parsePositiveInteger(values["--content-idx"], 8, {
      min: 0,
      max: 9,
    }),
    requestTimeoutMs: parsePositiveInteger(
      values["--request-timeout-ms"],
      30_000,
      { min: 5_000, max: 120_000 },
    ),
    aiTimeoutMs: parsePositiveInteger(values["--ai-timeout-ms"], 1_800_000, {
      min: 60_000,
      max: 3_600_000,
    }),
    pollMs: parsePositiveInteger(values["--poll-ms"], 2_000, {
      min: 250,
      max: 30_000,
    }),
  };
}

async function readCredentialsStdin() {
  if (process.stdin.isTTY) {
    throw new Error(
      "--credentials-stdin 只接受管道或受控文件描述符，拒绝在会回显的TTY中输入密码",
    );
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16_384) throw new Error("stdin 凭据超过16KB限制");
    chunks.push(chunk);
  }
  return parseCredentialsFromStdin(Buffer.concat(chunks).toString("utf8"));
}

function tableExists(db, table) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table),
  );
}

function scalar(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function safeJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function moduleCount(value) {
  if (value == null || value === "") return null;
  const parsed = safeJson(value, []);
  return Array.isArray(parsed) ? parsed.length : null;
}

function preflightCredentialAccounts(db, credentials) {
  const actors = {};
  for (const lane of ["boss", "management", "employee"]) {
    const row = db
      .prepare(
        `SELECT id,username,name,role,status,tenant_id,manager_id,modules
        FROM users WHERE username=?`,
      )
      .get(credentials[lane].username);
    if (!row || row.status !== "启用") {
      throw new Error(`${lane}账号不存在或未启用`);
    }
    if (!roleMatchesLiveLane(lane, row.role)) {
      throw new Error(`${lane}账号角色不符合三角色矩阵`);
    }
    actors[lane] = row;
  }
  const tenantIds = new Set(
    Object.values(actors).map((row) => Number(row.tenant_id)),
  );
  if (tenantIds.size !== 1) throw new Error("三角色账号不属于同一隔离租户");
  if (Number(actors.management.manager_id) !== Number(actors.boss.id)) {
    throw new Error("管理层账号必须直接归属本次老板账号");
  }
  if (Number(actors.employee.manager_id) !== Number(actors.management.id)) {
    throw new Error("普通员工账号必须直接归属本次管理层账号");
  }
  const tenantId = Number(actors.boss.tenant_id);
  const tenant = db
    .prepare("SELECT id,name,status,data_mode,credits FROM tenants WHERE id=?")
    .get(tenantId);
  if (!tenant || tenant.status !== "已开通") throw new Error("隔离租户未开通");
  if (tenant.data_mode !== "live") {
    throw new Error("真实HTTP穿透只接受data_mode=live的专用隔离租户");
  }
  return { actors, tenant };
}

function loginWatermark(db, tenantId) {
  if (!tableExists(db, "login_logs")) return 0;
  return Number(
    scalar(
      db,
      "SELECT COALESCE(MAX(id),0) id FROM login_logs WHERE tenant_id=?",
      tenantId,
    )?.id || 0,
  );
}

function assertLoginWritesReachedBoundDatabase(
  db,
  tenantId,
  beforeId,
  credentials,
) {
  if (!tableExists(db, "login_logs")) {
    throw new Error("隔离库缺少login_logs，无法证明HTTP服务绑定的是指定数据库");
  }
  const rows = db
    .prepare(
      `SELECT username,success FROM login_logs
      WHERE tenant_id=? AND id>? ORDER BY id`,
    )
    .all(tenantId, beforeId);
  for (const lane of ["boss", "management", "employee"]) {
    if (
      !rows.some(
        (row) =>
          row.username === credentials[lane].username &&
          Number(row.success) === 1,
      )
    ) {
      throw new Error(`未在指定数据库回读到${lane}账号的成功登录审计`);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve, reject) => {
    if (runAbortController.signal.aborted) {
      reject(runAbortController.signal.reason || new Error("运行已中断"));
      return;
    }
    const timer = setTimeout(() => {
      runAbortController.signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(runAbortController.signal.reason || new Error("运行已中断"));
    };
    runAbortController.signal.addEventListener("abort", onAbort, { once: true });
  });
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(usage());
  process.exit(0);
}

if (!isLoopbackBaseUrl(options.baseUrl)) {
  throw new Error("真实三角色矩阵只允许连接loopback HTTP服务根地址");
}
if (!options.credentialsStdin) {
  throw new Error("必须使用--credentials-stdin；禁止从参数或环境变量读取密码");
}
if (!options.allowAiCloud) {
  throw new Error(
    "本矩阵包含两次真实云AI派活；缺少--allow-ai-cloud，已在业务写入前失败关闭",
  );
}
if (options.contentIdx !== 8) {
  throw new Error(
    "本三角色业务穿透要验证内容→素材→可使用内容→审批→资产全链路，--content-idx必须为8（分发官）",
  );
}
if (!process.argv.some((item) => item === "--db" || item.startsWith("--db="))) {
  throw new Error("必须通过--db显式指定服务实际绑定的专用隔离测试库");
}
if (!fs.existsSync(options.dbPath) || !fs.statSync(options.dbPath).isFile()) {
  throw new Error(`专用隔离测试库不存在：${options.dbPath}`);
}

const databasePath = fs.realpathSync(options.dbPath);
const productionDatabasePath = path.join(
  PROJECT_ROOT,
  "server/data/nanowork-industry.db",
);
if (
  fs.existsSync(productionDatabasePath) &&
  (() => {
    const live = fs.statSync(databasePath);
    const production = fs.statSync(productionDatabasePath);
    return live.dev === production.dev && live.ino === production.ino;
  })()
) {
  throw new Error("拒绝运行在默认业务库；必须使用带隔离标记的专用测试库");
}
let loadedCheckpointRaw = null;
const checkpointCanonicalPath = assertSafeArtifactPath({
  databasePath,
  artifactPath: options.checkpointPath,
  label: "checkpoint",
});
if (options.resumePath) {
  if (!fs.existsSync(options.resumePath) || !fs.statSync(options.resumePath).isFile()) {
    throw new Error(`要恢复的checkpoint不存在：${options.resumePath}`);
  }
  const checkpointStat = fs.statSync(options.resumePath);
  if ((checkpointStat.mode & 0o077) !== 0) {
    throw new Error("checkpoint权限必须是0600");
  }
  const raw = fs.readFileSync(options.resumePath, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 1_000_000) {
    throw new Error("checkpoint超过1MB限制");
  }
  try {
    loadedCheckpointRaw = JSON.parse(raw);
  } catch {
    throw new Error("checkpoint不是合法JSON");
  }
  if (!process.argv.some((item) => item === "--out" || item.startsWith("--out="))) {
    options.outputPath = path.resolve(String(loadedCheckpointRaw?.outputPath || ""));
  }
} else {
  reserveExclusiveArtifactPath({
    databasePath,
    artifactPath: options.checkpointPath,
    label: "checkpoint",
  });
}
const outputCanonicalPath = reserveExclusiveArtifactPath({
  databasePath,
  artifactPath: options.outputPath,
  label: "证据输出",
});
if (checkpointCanonicalPath === outputCanonicalPath) {
  throw new Error("--out与checkpoint必须是两个不同文件");
}

const credentials = await readCredentialsStdin();
const liveDb = new DatabaseSync(databasePath);
liveDb.exec("PRAGMA busy_timeout=5000");

const startedAt = new Date().toISOString();
const startedMs = Date.now();
const checks = [];
const scenarios = {
  manualTask: { ok: false },
  restaurantEmployee: { ok: false },
  contentEmployee: { ok: false },
};
let tenant = null;
let actors = null;
let watermarks = null;
let ids = {};
let markerKey = null;
let finalEvidence = null;
let providerReadiness = null;
let profileAccess = [];
let contractEvidence = [];
let checkpointState = null;
let expectedActorIds = null;
let interruptedSignal = null;
let removeSignalHandlers = () => {};
const runAbortController = new AbortController();
function recursivelyListCodeDependencyFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && /\.(?:js|mjs|cjs|json|md)$/u.test(entry.name)) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

const codeDependencyFiles = [
  path.join(PROJECT_ROOT, "scripts/run-live-role-flow-matrix.mjs"),
  path.join(PROJECT_ROOT, "scripts/lib/live-role-flow-matrix.mjs"),
  path.join(PROJECT_ROOT, "scripts/lib/real-employee-matrix.mjs"),
  path.join(PROJECT_ROOT, "scripts/lib/employee-output-quality-audit.mjs"),
  ...recursivelyListCodeDependencyFiles(path.join(PROJECT_ROOT, "server/src")),
  ...recursivelyListCodeDependencyFiles(path.join(PROJECT_ROOT, "server/catalog")),
];
const codeFingerprint = computeFilesFingerprint(codeDependencyFiles).sha256;
const scenarioFingerprint = computeScenarioFingerprint({
  plan: LIVE_ROLE_FLOW_PLAN,
  restaurantIdx: options.restaurantIdx,
  contentIdx: options.contentIdx,
  flow: "human-rework+restaurant-adopt+content-adopt",
  revision: 2,
});

function checkpointDocument(status = "running") {
  return {
    schema: LIVE_ROLE_FLOW_CHECKPOINT_SCHEMA,
    status,
    updatedAt: new Date().toISOString(),
    outputPath: options.outputPath,
    batchNonceSha256: hashValue(options.batchNonce),
    databaseIdentitySha256:
      checkpointState?.databaseIdentitySha256 || null,
    codeFingerprint,
    scenarioFingerprint,
    tenantId: tenant ? Number(tenant.id) : null,
    actorIds: actors
      ? Object.fromEntries(
          Object.entries(actors).map(([lane, actor]) => [lane, Number(actor.id)]),
        )
      : expectedActorIds || {},
    watermarks: watermarks || {},
    ids,
    stages: checkpointState?.stages || {},
    providerFingerprint: checkpointState?.providerFingerprint || null,
  };
}

function persistCheckpoint(status = "running") {
  if (!checkpointState) return;
  const document = checkpointDocument(status);
  writeJsonAtomic0600(options.checkpointPath, document);
}

function markStage(stage, extraIds = {}) {
  Object.assign(ids, extraIds);
  checkpointState.stages[stage] = {
    completed: true,
    at: new Date().toISOString(),
  };
  persistCheckpoint("running");
}

function stageComplete(stage) {
  return checkpointState?.stages?.[stage]?.completed === true;
}

function installSignalHandlers() {
  const handler = (signal) => {
    if (interruptedSignal) return;
    interruptedSignal = signal;
    runAbortController.abort(new Error(`received ${signal}`));
    try {
      persistCheckpoint("interrupted");
    } catch {
      // The main catch still reports the original interruption.
    }
  };
  const onSigint = () => handler("SIGINT");
  const onSigterm = () => handler("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return () => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  };
}

function recordCheck(value) {
  checks.push(projectHttpEvidence(value));
}

function persistentBoundary() {
  return capturePersistentSideEffectBoundary({
    db: liveDb,
    databasePath,
    dataRoots: [path.join(PROJECT_ROOT, "server/data")],
    ignoredPaths: [options.outputPath, options.checkpointPath],
  });
}

async function request(
  actor,
  route,
  { method = "GET", body, expectedStatus = 200, label, record = true } = {},
) {
  const began = Date.now();
  const response = await fetchSameOriginNoRedirect(options.baseUrl, route, {
    method,
    signal: AbortSignal.any([
      AbortSignal.timeout(options.requestTimeoutMs),
      runAbortController.signal,
    ]),
    headers: {
      ...(actor?.token ? { authorization: `Bearer ${actor.token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "user-agent": "nanowork-live-role-flow-matrix/1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  const check = {
    label: label || route,
    actor: actor?.lane || "anonymous",
    method,
    path: route,
    status: response.status,
    ok: response.status === expectedStatus,
    durationMs: Date.now() - began,
  };
  if (record) recordCheck(check);
  if (response.status !== expectedStatus) {
    const detail = redactDiagnostic(
      payload?.error || `HTTP ${response.status}`,
    );
    throw new Error(
      `${check.label}: expected HTTP ${expectedStatus}, got ${response.status}: ${detail}`,
    );
  }
  return { status: response.status, payload, check };
}

async function forbidden(actor, label, route, body, method = "POST") {
  const before = persistentBoundary();
  const result = await request(actor, route, {
    method,
    body,
    expectedStatus: 403,
    label,
    record: false,
  });
  const after = persistentBoundary();
  const proof = assertForbiddenPersistentBoundaryUnchanged({
    label,
    status: result.status,
    before,
    after,
  });
  checks.push({ ...projectHttpEvidence(result.check), ...proof, ok: true });
  return proof;
}

async function login(lane, credential) {
  const result = await request(null, "/api/auth/login", {
    method: "POST",
    body: credential,
    expectedStatus: 200,
    label: `${lane}_real_http_login`,
  });
  const user = result.payload?.user;
  const token = result.payload?.token;
  if (!user || typeof token !== "string" || !token) {
    throw new Error(`${lane}登录响应缺少账号或会话令牌`);
  }
  if (!roleMatchesLiveLane(lane, user.role)) {
    throw new Error(`${lane}登录后的真实角色不符合矩阵`);
  }
  return {
    lane,
    token,
    id: Number(user.id),
    name: String(user.name || ""),
    role: String(user.role || ""),
    tenantId: Number(user.tenant?.id),
    moduleCount: Array.isArray(user.modules) ? user.modules.length : null,
  };
}

function dbTask(id) {
  return liveDb
    .prepare("SELECT * FROM tasks WHERE tenant_id=? AND id=?")
    .get(tenant.id, Number(id));
}

function assertNoHeldCredits(label) {
  const count = Number(
    scalar(
      liveDb,
      "SELECT COUNT(*) count FROM credit_holds WHERE tenant_id=? AND status='held'",
      tenant.id,
    )?.count || 0,
  );
  assert.equal(count, 0, `${label}: 存在${count}条悬挂占扣`);
}

function assertNoActiveAiTasks(label) {
  const restaurant = Number(
    scalar(
      liveDb,
      "SELECT COUNT(*) count FROM agent_tasks WHERE tenant_id=? AND status='生成中'",
      tenant.id,
    )?.count || 0,
  );
  const content = Number(
    scalar(
      liveDb,
      "SELECT COUNT(*) count FROM content_employee_runs WHERE tenant_id=? AND status='生成中'",
      tenant.id,
    )?.count || 0,
  );
  assert.equal(
    restaurant + content,
    0,
    `${label}: 隔离租户仍有后台AI任务执行中`,
  );
}

function assertResumeContainsOnlyTrackedAiState() {
  if (ids.restaurantTaskId || ids.contentRunId) {
    assert.ok(watermarks?.ids, "checkpoint含AI任务但缺少业务watermarks");
  }
  const runTag = `LIVE-${hashValue(options.batchNonce).slice(0, 24)}`;
  const restaurantNonce = `${runTag}-restaurant-${options.restaurantIdx}`;
  const contentNonce = `${runTag}-content-${options.contentIdx}`;
  const restaurant = findUniqueNonceBoundAiState(liveDb, {
    domain: "restaurant",
    tenantId: tenant.id,
    actorId: expectedActorIds.management,
    requirementMarker: `任务唯一标识：${restaurantNonce}`,
    minimumIdExclusive: Number(watermarks?.ids?.agent_tasks || 0),
  });
  const content = findUniqueNonceBoundAiState(liveDb, {
    domain: "content",
    tenantId: tenant.id,
    actorId: expectedActorIds.employee,
    employeeIdx: options.contentIdx,
    requirementMarker: `任务唯一标识：${contentNonce}`,
    minimumIdExclusive: Number(
      watermarks?.ids?.content_employee_runs || 0,
    ),
  });
  if (ids.restaurantTaskId) {
    assert.ok(restaurant, "checkpoint餐饮任务ID存在但nonce绑定记录缺失");
    assert.equal(Number(ids.restaurantTaskId), Number(restaurant.id), "checkpoint餐饮任务ID与nonce记录不匹配");
  } else if (restaurant) {
    ids.restaurantTaskId = Number(restaurant.id);
  }
  if (restaurant) ids.restaurantSpecialistId = Number(restaurant.specialist_id);
  if (ids.contentRunId) {
    assert.ok(content, "checkpoint内容任务ID存在但nonce绑定记录缺失");
    assert.equal(Number(ids.contentRunId), Number(content.id), "checkpoint内容任务ID与nonce记录不匹配");
  } else if (content) {
    ids.contentRunId = Number(content.id);
  }
  if (content) ids.contentEmployeeIdx = Number(content.employee_idx);
  persistCheckpoint("running");
  const allowed = new Set(
    [
      ids.restaurantTaskId
        ? `agent_task:${Number(ids.restaurantTaskId)}`
        : null,
      ids.contentRunId
        ? `content_employee_run:${Number(ids.contentRunId)}`
        : null,
    ].filter(Boolean),
  );
  const held = liveDb
    .prepare(
      "SELECT ref_type,ref_id FROM credit_holds WHERE tenant_id=? AND status='held'",
    )
    .all(tenant.id);
  for (const row of held) {
    assert.ok(
      allowed.has(`${row.ref_type}:${Number(row.ref_id)}`),
      "checkpoint恢复时发现未绑定本次nonce的悬挂占扣",
    );
  }
  const activeRestaurant = liveDb
    .prepare(
      "SELECT id FROM agent_tasks WHERE tenant_id=? AND status='生成中'",
    )
    .all(tenant.id);
  const activeContent = liveDb
    .prepare(
      "SELECT id FROM content_employee_runs WHERE tenant_id=? AND status='生成中'",
    )
    .all(tenant.id);
  assert.ok(
    activeRestaurant.every(
      (row) => Number(row.id) === Number(ids.restaurantTaskId),
    ),
    "checkpoint恢复时存在未跟踪的餐饮AI任务",
  );
  assert.ok(
    activeContent.every((row) => Number(row.id) === Number(ids.contentRunId)),
    "checkpoint恢复时存在未跟踪的内容AI任务",
  );
}

async function waitForRestaurantTask(taskId) {
  const deadline = Date.now() + options.aiTimeoutMs;
  while (Date.now() < deadline) {
    const result = await request(
      actors.management,
      `/api/marshals/tasks/${taskId}/status`,
      { label: "restaurant_poll_status", record: false },
    );
    const status = String(result.payload?.status || "");
    if (status && status !== "生成中") {
      recordCheck({
        ...result.check,
        ok: status === "待审阅",
        entityId: taskId,
        businessStatus: status,
        displayStatus: result.payload?.displayStatus,
        presentationKey: result.payload?.presentationKey,
      });
      if (status !== "待审阅" || result.payload?.reviewReady !== true) {
        throw new Error(
          `餐饮任务#${taskId}未进入可审阅状态：${status || "未知"}`,
        );
      }
      return result.payload;
    }
    await sleep(options.pollMs);
  }
  throw new Error(`餐饮任务#${taskId}在${options.aiTimeoutMs}ms内未到达终态`);
}

async function waitForContentRun(runId) {
  const deadline = Date.now() + options.aiTimeoutMs;
  while (Date.now() < deadline) {
    const result = await request(
      actors.employee,
      `/api/employee-workbench/content/${options.contentIdx}/runs/${runId}`,
      { label: "content_employee_poll_status", record: false },
    );
    const run = result.payload?.run || {};
    const status = String(run.status || "");
    if (status && status !== "生成中") {
      recordCheck({
        ...result.check,
        ok: status === "待审阅",
        entityId: runId,
        businessStatus: status,
        displayStatus: run.displayStatus,
        presentationKey: run.presentationKey,
      });
      if (status !== "待审阅" || run.reviewReady !== true) {
        throw new Error(
          `内容任务#${runId}未进入可审阅状态：${status || "未知"}`,
        );
      }
      return run;
    }
    await sleep(options.pollMs);
  }
  throw new Error(`内容任务#${runId}在${options.aiTimeoutMs}ms内未到达终态`);
}

function assertRealAiBilling(refType, refId, label) {
  const hold = liveDb
    .prepare(
      `SELECT h.*,l.input_tokens,l.output_tokens,l.ai_mode
      FROM credit_holds h JOIN credit_logs l
        ON l.tenant_id=h.tenant_id AND l.id=h.log_id
      WHERE h.tenant_id=? AND h.ref_type=? AND h.ref_id=?
      ORDER BY h.id DESC LIMIT 1`,
    )
    .get(tenant.id, refType, Number(refId));
  assert.ok(hold, `${label}: 缺少关联占扣`);
  assert.equal(hold.status, "settled", `${label}: 占扣未结算`);
  assert.ok(
    Number(hold.settled_credits) > 0,
    `${label}: 客户真实结算必须大于0`,
  );
  assert.equal(hold.ai_mode, "api", `${label}: ai_mode不是api`);
  assert.ok(Number(hold.input_tokens) > 0, `${label}: 输入token缺失`);
  assert.ok(Number(hold.output_tokens) > 0, `${label}: 输出token缺失`);
  return hold;
}

function strictJson(value, label) {
  try {
    const parsed = JSON.parse(String(value || ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("顶层不是对象");
    }
    return parsed;
  } catch (error) {
    throw new Error(`${label}损坏：${error.message}`);
  }
}

function assertSemanticScans(body, domain, context = {}) {
  const placeholders = findPlaceholderSignals(body);
  const factScan = findKnownFactConflicts(body, domain);
  const unsupportedMarketing =
    domain === "content"
      ? findUnsupportedMarketingFactConflicts(body, context)
      : { checked: 0, conflicts: [] };
  const externalClaims = findExternalActionClaims(body);
  assert.deepEqual(placeholders, [], `${domain}产出含占位符`);
  assert.deepEqual(factScan.conflicts, [], `${domain}产出与已知事实冲突`);
  assert.deepEqual(unsupportedMarketing.conflicts, [], `${domain}产出含无依据营销事实`);
  assert.deepEqual(externalClaims, [], `${domain}产出冒充已执行外部动作`);
  return {
    placeholders: placeholders.length,
    knownFactsChecked: factScan.checked,
    factConflicts: factScan.conflicts.length,
    marketingClaimsChecked: unsupportedMarketing.checked,
    unsupportedMarketing: unsupportedMarketing.conflicts.length,
    externalActionClaims: externalClaims.length,
  };
}

function assertRestaurantContractFromDb(taskId) {
  const row = liveDb
    .prepare(
      `SELECT t.id,t.title,t.requirement,t.employee_profile_version,
        t.employee_web_snapshot,t.specialist_id,t.output_id,s.employee_idx,
        c.body,c.ai_mode,c.status,c.creator_id
      FROM agent_tasks t
      JOIN specialists s ON s.id=t.specialist_id AND s.tenant_id=t.tenant_id
      JOIN contents c ON c.id=t.output_id AND c.tenant_id=t.tenant_id
      WHERE t.tenant_id=? AND t.id=?`,
    )
    .get(tenant.id, Number(taskId));
  assert.ok(row, "餐饮任务缺少权威任务/岗位/产出关联");
  const executionEvidence = strictJson(
    row.employee_web_snapshot,
    "餐饮执行证据",
  );
  assert.equal(
    executionEvidence?.internalProfileLeakage?.detected,
    false,
    "餐饮产出检测到内部岗位档案泄露",
  );
  const audit = inspectRestaurantOutputAudit({
    employeeProfileVersion: row.employee_profile_version,
    aiMode: row.ai_mode,
    executionEvidence,
    employeeIdx: row.employee_idx,
    taskTitle: row.title,
    taskRequirement: row.requirement,
    outputBody: row.body,
  });
  assert.equal(audit.applicable, true);
  assert.equal(audit.valid, true, audit.error || "餐饮产出独立契约复验失败");
  assert.equal(audit.runtimeValidation?.valid, true);
  const semantic = assertSemanticScans(row.body, "restaurant");
  const artifactContent = audit.runtimeValidation?.artifacts?.[0]?.content;
  const evidence = {
    domain: "restaurant",
    entityId: Number(taskId),
    valid: true,
    providerFingerprint: ids.restaurantProviderFingerprint,
    verificationFingerprint:
      ids.restaurantProviderVerificationFingerprint,
    bodySha256: hashValue(String(row.body || "")),
    artifactSha256: hashValue(String(artifactContent || "")),
    semanticGate: semantic,
  };
  contractEvidence.push(evidence);
  return evidence;
}

function assertContentContractFromDb(runId) {
  const row = liveDb
    .prepare(
      `SELECT id,employee_idx,employee_key,title,requirement,status,result_md,
        ai_mode,snapshot_json,created_by
      FROM content_employee_runs WHERE tenant_id=? AND id=?`,
    )
    .get(tenant.id, Number(runId));
  assert.ok(row, "内容员工运行不存在");
  const snapshot = strictJson(row.snapshot_json, "内容员工运行快照");
  assert.ok(["待审阅", "已完成"].includes(row.status));
  assert.equal(row.ai_mode, "api");
  assert.equal(snapshot.contractValid, true);
  assert.deepEqual(snapshot.contractErrors, []);
  assert.equal(
    snapshot?.internalProfileLeakage?.detected,
    false,
    "内容员工产出检测到内部岗位档案泄露",
  );
  assert.ok(snapshot.validatedOutput, "内容员工快照缺少validatedOutput");
  const authorityDispatch = assertContentDispatchSnapshotMatchesAuthority(
    snapshot,
    row,
  );
  const validation = validateContentEmployeeOutputContract(
    Number(row.employee_idx),
    snapshot.validatedOutput,
    {
      ...authorityDispatch,
      web: snapshot.web,
      enforceRequiredInputs: true,
      outputForCompletionGate: snapshot.validatedOutput,
    },
  );
  assert.equal(validation.valid, true, validation.errors.join("；"));
  assert.deepEqual(validation.errors, []);
  assert.equal(String(row.result_md || ""), String(validation.previewMarkdown || ""));
  assert.equal(String(snapshot.previewMarkdown || ""), String(row.result_md || ""));
  const expectedArtifact = validation.artifacts?.find((item) => item.primary === true);
  const storedArtifacts = (Array.isArray(snapshot.artifacts) ? snapshot.artifacts : []).filter(
    (item) => item?.primary === true,
  );
  assert.equal(storedArtifacts.length, 1, "内容员工快照必须只有一个主产物");
  assert.ok(expectedArtifact, "内容契约复验缺少主产物");
  for (const key of [
    "kind",
    "filename",
    "mediaType",
    "employeeIdx",
    "employeeKey",
    "content",
  ]) {
    assert.deepEqual(
      storedArtifacts[0]?.[key],
      expectedArtifact?.[key],
      `内容员工主产物${key}与独立复验不一致`,
    );
  }
  assert.equal(Number(expectedArtifact.employeeIdx), Number(row.employee_idx));
  assert.equal(String(expectedArtifact.employeeKey), String(row.employee_key));
  const semantic = assertSemanticScans(expectedArtifact.content, "content", {
    requirement: row.requirement,
    web: snapshot.web,
  });
  const evidence = {
    domain: "content",
    entityId: Number(runId),
    valid: true,
    providerFingerprint: ids.contentProviderFingerprint,
    verificationFingerprint: ids.contentProviderVerificationFingerprint,
    bodySha256: hashValue(String(row.result_md || "")),
    artifactSha256: hashValue(String(expectedArtifact.content || "")),
    semanticGate: semantic,
  };
  contractEvidence.push(evidence);
  return evidence;
}

async function runProfileAccessFlow() {
  for (const domain of ["restaurant", "content"]) {
    const idx = domain === "restaurant" ? options.restaurantIdx : options.contentIdx;
    const root = `/api/employee-workbench/${domain}/${idx}`;
    const responses = {};
    for (const lane of ["boss", "management", "employee"]) {
      responses[lane] = (
        await request(actors[lane], root, {
          label: `${lane}_reads_${domain}_workbench_profile`,
        })
      ).payload;
    }
    profileAccess.push(
      assertProfileAccessMatrix({ domain, ...responses }),
    );
    const baselineKey = `${domain}ProfileBaselineRevision`;
    const promptSemanticKey = `${domain}ProfilePromptSemanticSha256`;
    const configSemanticKey = `${domain}ProfileConfigSemanticSha256`;
    const skillsSemanticKey = `${domain}ProfileSkillsSemanticSha256`;
    const semanticHashes = (profile) => ({
      prompt: hashValue({
        defaultTemplate: profile.prompts?.defaultTemplate,
        overrideTemplate: profile.prompts?.overrideTemplate,
        effectiveTemplate: profile.prompts?.effectiveTemplate,
      }),
      config: hashValue(profile.workConfig?.values),
      skills: hashValue(
        domain === "restaurant"
          ? {
              required: profile.skillLibrary?.required,
              optional: profile.skillLibrary?.optional,
              learned: profile.skillLibrary?.learned,
            }
          : {
              required: profile.skillLibrary?.required,
              historical: profile.skillLibrary?.historical,
              customSkills: profile.skillLibrary?.customSkills,
            },
      ),
    });
    const observedRevision = Number(responses.boss?.prompts?.revision || 0);
    const observedSemantics = semanticHashes(responses.boss);
    if (ids[baselineKey] == null) {
      ids[baselineKey] = observedRevision;
      ids[promptSemanticKey] = observedSemantics.prompt;
      ids[configSemanticKey] = observedSemantics.config;
      ids[skillsSemanticKey] = observedSemantics.skills;
      persistCheckpoint("running");
    }
    const beforeRevision = Number(ids[baselineKey]);
    const assertBaselineSemantics = (profile, label) => {
      const current = semanticHashes(profile);
      assert.equal(current.prompt, ids[promptSemanticKey], `${label}提示词语义发生变化`);
      assert.equal(current.config, ids[configSemanticKey], `${label}工作配置语义发生变化`);
      assert.equal(current.skills, ids[skillsSemanticKey], `${label}技能库语义发生变化`);
    };
    assertBaselineSemantics(responses.boss, `${domain}档案`);
    assert.ok(
      observedRevision >= beforeRevision && observedRevision <= beforeRevision + 3,
      `${domain}岗位配置在checkpoint恢复期间被额外修改`,
    );
    if (stageComplete(`profile_access_${domain}`)) {
      assert.equal(observedRevision, beforeRevision + 3, `${domain}档案完成阶段修订数不正确`);
      continue;
    }

    const updateCases = ["prompt", "config", "skills"];
    const legalBody = (kind, profile) => {
      if (kind === "prompt") {
        return { overrideTemplate: String(profile.prompts?.overrideTemplate || "") };
      }
      if (kind === "config") return { values: profile.workConfig?.values };
      return domain === "restaurant"
        ? {
            skills: [
              ...(profile.skillLibrary?.required || []),
              ...(profile.skillLibrary?.optional || []),
              ...(profile.skillLibrary?.learned || []),
            ],
          }
        : { customSkills: profile.skillLibrary?.customSkills || [] };
    };
    for (const kind of [...updateCases, "capabilities"]) {
      const body =
        kind === "capabilities"
          ? { enabled: false }
          : legalBody(kind, responses.boss);
      for (const lane of ["management", "employee"]) {
        await forbidden(
          actors[lane],
          `${lane}_cannot_edit_${domain}_${kind}`,
          `${root}/${kind}`,
          body,
          "PUT",
        );
      }
    }

    for (const [index, kind] of updateCases.entries()) {
      const currentResponse = await request(actors.boss, root, {
        label: `boss_reads_${domain}_before_${kind}_no_op`,
      });
      const current = currentResponse.payload;
      assertBaselineSemantics(current, `${domain}.${kind}变更前`);
      const currentRevision = Number(current.prompts?.revision || 0);
      const expectedBefore = beforeRevision + index;
      const expectedAfter = expectedBefore + 1;
      assert.ok(
        currentRevision === expectedBefore || currentRevision >= expectedAfter,
        `${domain}.${kind}恢复修订出现缺口`,
      );
      if (currentRevision === expectedBefore) {
        const update = await request(actors.boss, `${root}/${kind}`, {
          method: "PUT",
          body: legalBody(kind, current),
          label: `boss_updates_${domain}_${kind}_without_semantic_change`,
        });
        const updatedProfile =
          domain === "content" ? update.payload?.profile : update.payload;
        assert.ok(updatedProfile, `${domain}.${kind}更新响应缺少完整档案`);
        assert.equal(
          Number(updatedProfile.prompts?.revision),
          expectedAfter,
          `${domain}.${kind}未形成单一新修订`,
        );
        assertBaselineSemantics(updatedProfile, `${domain}.${kind}更新后`);
      }
      markStage(`profile_access_${domain}_${kind}`);
    }
    await request(actors.boss, `${root}/capabilities`, {
      method: "PUT",
      body: { enabled: false },
      expectedStatus: 400,
      label: `boss_confirms_${domain}_capabilities_locked`,
    });
    const after = await request(actors.boss, root, {
      label: `boss_verifies_${domain}_all_profile_revisions`,
    });
    assert.equal(Number(after.payload?.prompts?.revision), beforeRevision + 3);
    assertBaselineSemantics(after.payload, `${domain}三类更新完成后`);
    markStage(`profile_access_${domain}`);
  }
  markStage("profile_access_matrix");
}

async function runManualTaskFlow(runTag) {
  const assignees = await request(actors.boss, "/api/execution/assignees", {
    label: "boss_reads_real_assignee_scope",
  });
  const assigneeIds = new Set(
    (Array.isArray(assignees.payload) ? assignees.payload : []).map((item) =>
      Number(item.id),
    ),
  );
  assert.ok(
    assigneeIds.has(actors.management.id),
    "老板可派活范围缺少管理层账号",
  );
  const parentTitle = `${runTag}·经营目标拆解`;
  const parentMutation = await reconcileNonceMutation({
    label: "boss_dispatches_parent_manual_task",
    lookup: () =>
      liveDb
        .prepare(
          "SELECT * FROM tasks WHERE tenant_id=? AND title=? AND assigned_by=? AND assignee_id=? ORDER BY id",
        )
        .all(tenant.id, parentTitle, actors.boss.id, actors.management.id),
    mutate: () =>
      request(actors.boss, "/api/execution/tasks", {
        method: "POST",
        body: {
          title: parentTitle,
          detail: "把已核实的本周门店复盘目标拆成执行任务，并保留人工验收记录。",
          type: "数据",
          priority: "高",
          assignee_id: actors.management.id,
          source: "真实三角色穿刺",
        },
        label: "boss_dispatches_parent_manual_task",
      }),
    validate: (row, response) => {
      if (response) assert.equal(Number(response.payload?.id), Number(row.id));
      assert.equal(Number(row.assigned_by), actors.boss.id);
      assert.equal(Number(row.assignee_id), actors.management.id);
    },
  });
  ids.parentTaskId = Number(parentMutation.row.id);
  markStage("manual_parent_created", { parentTaskId: ids.parentTaskId });

  await forbidden(
    actors.employee,
    "employee_cannot_dispatch_upward",
    "/api/execution/tasks",
    {
      title: `${runTag}·不应创建`,
      assignee_id: actors.management.id,
    },
  );

  if (dbTask(ids.parentTaskId)?.status === "待执行") {
    await request(actors.management, `/api/execution/tasks/${ids.parentTaskId}`, {
      method: "PUT",
      body: { status: "进行中" },
      label: "management_accepts_parent_task",
    });
  }
  assert.equal(dbTask(ids.parentTaskId)?.status, "进行中");
  markStage("manual_parent_started");

  const childTitle = `${runTag}·核验门店原始数据`;
  const childMutation = await reconcileNonceMutation({
    label: "management_splits_child_task_to_employee",
    lookup: () =>
      liveDb
        .prepare(
          "SELECT * FROM tasks WHERE tenant_id=? AND title=? AND assigned_by=? AND assignee_id=? AND parent_task_id=? ORDER BY id",
        )
        .all(
          tenant.id,
          childTitle,
          actors.management.id,
          actors.employee.id,
          ids.parentTaskId,
        ),
    mutate: () =>
      request(actors.management, "/api/execution/tasks", {
        method: "POST",
        body: {
          title: childTitle,
          detail: "核对营业额、采购入库、库存变化和报损凭证；缺失项明确标注待补。",
          type: "数据",
          priority: "高",
          assignee_id: actors.employee.id,
          parent_task_id: ids.parentTaskId,
        },
        label: "management_splits_child_task_to_employee",
      }),
    validate: (row, response) => {
      if (response) assert.equal(Number(response.payload?.id), Number(row.id));
      assert.equal(Number(row.parent_task_id), ids.parentTaskId);
    },
  });
  ids.childTaskId = Number(childMutation.row.id);
  markStage("manual_child_created", { childTaskId: ids.childTaskId });

  const beforeProxyStart = persistentBoundary();
  const proxyStart = await request(
    actors.management,
    `/api/execution/tasks/${ids.childTaskId}`,
    {
      method: "PUT",
      body: { status: "进行中" },
      expectedStatus: 403,
      label: "management_cannot_execute_for_employee",
      record: false,
    },
  );
  const afterProxyStart = persistentBoundary();
  checks.push({
    ...projectHttpEvidence(proxyStart.check),
    ...assertForbiddenPersistentBoundaryUnchanged({
      label: "management_cannot_execute_for_employee",
      status: proxyStart.status,
      before: beforeProxyStart,
      after: afterProxyStart,
    }),
    ok: true,
  });

  if (dbTask(ids.childTaskId)?.status === "待执行") {
    await request(actors.employee, `/api/execution/tasks/${ids.childTaskId}`, {
      method: "PUT",
      body: { status: "进行中" },
      label: "employee_accepts_child_task",
    });
  }
  markStage("manual_child_started");
  const firstContent = `[批次:${hashValue(options.batchNonce).slice(0, 16)}:child-v1] 首轮提交：已核验营业额与采购入库；库存变化和报损凭证仍缺少原始单据。`;
  const firstSubmission = await reconcileNonceMutation({
    label: "employee_submits_child_first_version",
    lookup: () =>
      liveDb
        .prepare(
          "SELECT * FROM task_submissions WHERE tenant_id=? AND task_id=? AND user_id=? AND content=? ORDER BY id",
        )
        .all(tenant.id, ids.childTaskId, actors.employee.id, firstContent),
    mutate: () =>
      request(actors.employee, `/api/execution/tasks/${ids.childTaskId}/submit`, {
        method: "POST",
        body: { content: firstContent },
        label: "employee_submits_child_first_version",
      }),
  });
  ids.childFirstSubmissionId = Number(firstSubmission.row.id);
  markStage("manual_child_first_submitted", {
    childFirstSubmissionId: ids.childFirstSubmissionId,
  });

  await forbidden(
    actors.employee,
    "employee_cannot_review_own_submission",
    `/api/execution/tasks/${ids.childTaskId}/review`,
    { pass: true, reason: "普通员工不能自审" },
  );

  const firstResult = liveDb
    .prepare("SELECT result FROM task_submissions WHERE tenant_id=? AND id=?")
    .get(tenant.id, ids.childFirstSubmissionId)?.result;
  if (firstResult !== "驳回") {
    await request(actors.management, `/api/execution/tasks/${ids.childTaskId}/review`, {
      method: "POST",
      body: {
        pass: false,
        reason: "请补齐库存变化和报损凭证编号，再重新提交。",
      },
      label: "management_rejects_child_with_reason",
    });
  }
  assert.equal(dbTask(ids.childTaskId)?.status, "进行中");
  markStage("manual_child_rejected");

  const employeeTasks = await request(
    actors.employee,
    "/api/execution/tasks?status=%E8%BF%9B%E8%A1%8C%E4%B8%AD",
    { label: "employee_reads_rework_state" },
  );
  const reworkTask = (
    Array.isArray(employeeTasks.payload) ? employeeTasks.payload : []
  ).find((item) => Number(item.id) === ids.childTaskId);
  assert.equal(reworkTask?.workflow_state, "rework", "员工未看到明确返工状态");

  const secondContent = `[批次:${hashValue(options.batchNonce).slice(0, 16)}:child-v2] 第二轮提交：已补齐库存盘点单INV-LIVE-001与报损登记LOSS-LIVE-001；全部数字仅用于隔离验收。`;
  const secondSubmission = await reconcileNonceMutation({
    label: "employee_resubmits_child_after_rework",
    lookup: () =>
      liveDb
        .prepare(
          "SELECT * FROM task_submissions WHERE tenant_id=? AND task_id=? AND user_id=? AND content=? ORDER BY id",
        )
        .all(tenant.id, ids.childTaskId, actors.employee.id, secondContent),
    mutate: () =>
      request(actors.employee, `/api/execution/tasks/${ids.childTaskId}/submit`, {
        method: "POST",
        body: { content: secondContent },
        label: "employee_resubmits_child_after_rework",
      }),
  });
  ids.childSecondSubmissionId = Number(secondSubmission.row.id);
  markStage("manual_child_resubmitted", {
    childSecondSubmissionId: ids.childSecondSubmissionId,
  });
  if (secondSubmission.row.result !== "通过") {
    await request(actors.management, `/api/execution/tasks/${ids.childTaskId}/review`, {
      method: "POST",
      body: { pass: true, reason: "凭证编号和缺失边界已补齐，人工验收通过。" },
      label: "management_accepts_resubmitted_child",
    });
  }
  assert.equal(dbTask(ids.childTaskId)?.status, "已完成");
  markStage("manual_child_approved");

  const parentContent = `[批次:${hashValue(options.batchNonce).slice(0, 16)}:parent-v1] 管理层汇总：下级核验任务已经人工验收；本次只确认流程和凭证链路，不宣称经营改善。`;
  const parentSubmission = await reconcileNonceMutation({
    label: "management_submits_parent_after_child_complete",
    lookup: () =>
      liveDb
        .prepare(
          "SELECT * FROM task_submissions WHERE tenant_id=? AND task_id=? AND user_id=? AND content=? ORDER BY id",
        )
        .all(tenant.id, ids.parentTaskId, actors.management.id, parentContent),
    mutate: () =>
      request(actors.management, `/api/execution/tasks/${ids.parentTaskId}/submit`, {
        method: "POST",
        body: { content: parentContent },
        label: "management_submits_parent_after_child_complete",
      }),
  });
  ids.parentSubmissionId = Number(parentSubmission.row.id);
  markStage("manual_parent_submitted", {
    parentSubmissionId: ids.parentSubmissionId,
  });
  await forbidden(
    actors.management,
    "management_cannot_review_own_parent_submission",
    `/api/execution/tasks/${ids.parentTaskId}/review`,
    { pass: true, reason: "管理层不能自审" },
  );
  if (parentSubmission.row.result !== "通过") {
    await request(actors.boss, `/api/execution/tasks/${ids.parentTaskId}/review`, {
      method: "POST",
      body: { pass: true, reason: "老板已核对下级验收记录和任务汇总。" },
      label: "boss_accepts_parent_manual_task",
    });
  }
  assert.equal(dbTask(ids.parentTaskId)?.status, "已完成");
  markStage("manual_parent_approved");
  scenarios.manualTask = {
    ok: true,
    parentTaskId: ids.parentTaskId,
    childTaskId: ids.childTaskId,
  };
}

async function runRestaurantEmployeeFlow(runTag) {
  if (ids.restaurantProviderFingerprint) {
    assert.equal(
      ids.restaurantProviderFingerprint,
      providerReadiness.fingerprint,
      "餐饮样本恢复时云雾供应商配置发生变化",
    );
  } else {
    ids.restaurantProviderFingerprint = providerReadiness.fingerprint;
    ids.restaurantProviderVerificationFingerprint =
      providerReadiness.verificationFingerprint;
    persistCheckpoint("running");
  }
  const profileResponse = await request(
    actors.boss,
    `/api/employee-workbench/restaurant/${options.restaurantIdx}`,
    { label: "boss_reads_restaurant_dispatch_profile" },
  );
  ids.restaurantSpecialistId = Number(
    profileResponse.payload?.identity?.specialistId,
  );
  assert.ok(ids.restaurantSpecialistId > 0, "餐饮岗位缺少specialistId");
  const dispatchBody = buildRestaurantDispatch(
    profileResponse.payload,
    `${runTag}-restaurant-${options.restaurantIdx}`,
  );
  const mutation = await reconcileNonceMutation({
    label: "management_dispatches_real_restaurant_employee",
    lookup: () =>
      liveDb
        .prepare(
          `SELECT * FROM agent_tasks
          WHERE tenant_id=? AND title=? AND requirement=? AND specialist_id=? AND created_by=? ORDER BY id`,
        )
        .all(
          tenant.id,
          dispatchBody.title,
          dispatchBody.requirement,
          ids.restaurantSpecialistId,
          actors.management.id,
        ),
    mutate: () =>
      request(
        actors.management,
        `/api/employee-workbench/restaurant/${options.restaurantIdx}/dispatch`,
        {
          method: "POST",
          body: dispatchBody,
          label: "management_dispatches_real_restaurant_employee",
        },
      ),
    validate: (row, response) => {
      if (response) assert.equal(Number(response.payload?.taskId), Number(row.id));
      assert.equal(Number(row.created_by), actors.management.id);
      assert.equal(Number(row.specialist_id), ids.restaurantSpecialistId);
      assert.equal(String(row.title), String(dispatchBody.title));
      assert.equal(String(row.requirement), String(dispatchBody.requirement));
    },
  });
  ids.restaurantTaskId = Number(mutation.row.id);
  markStage("restaurant_dispatched", {
    restaurantTaskId: ids.restaurantTaskId,
    restaurantSpecialistId: ids.restaurantSpecialistId,
  });
  if (mutation.row.status === "生成中") {
    await waitForRestaurantTask(ids.restaurantTaskId);
  }
  let task = liveDb
    .prepare("SELECT * FROM agent_tasks WHERE tenant_id=? AND id=?")
    .get(tenant.id, ids.restaurantTaskId);
  if (!["待审阅", "已完成"].includes(task?.status)) {
    throw new Error(`餐饮任务#${ids.restaurantTaskId}不可恢复：${task?.status || "缺失"}`);
  }
  ids.restaurantOutputId = Number(task?.output_id);
  assert.ok(ids.restaurantOutputId > 0, "餐饮任务缺少落库产出");
  const output = liveDb
    .prepare("SELECT status,ai_mode FROM contents WHERE tenant_id=? AND id=?")
    .get(tenant.id, ids.restaurantOutputId);
  assert.ok(["待审核", "可使用"].includes(output?.status));
  assert.equal(output?.ai_mode, "api");
  assertRealAiBilling("agent_task", ids.restaurantTaskId, "餐饮员工真实任务");
  if (!contractEvidence.some((item) => item.domain === "restaurant")) {
    assertRestaurantContractFromDb(ids.restaurantTaskId);
  }
  markStage("restaurant_contract_gate", {
    restaurantOutputId: ids.restaurantOutputId,
  });

  const bossStatus = await request(
    actors.boss,
    `/api/marshals/tasks/${ids.restaurantTaskId}/status`,
    { label: "boss_reads_full_restaurant_execution_snapshot" },
  );
  assert.ok(bossStatus.payload?.executionSnapshot, "老板缺少餐饮执行快照");
  const managementStatus = await request(
    actors.management,
    `/api/marshals/tasks/${ids.restaurantTaskId}/status`,
    { label: "management_reads_redacted_restaurant_task" },
  );
  assert.equal(
    Object.hasOwn(managementStatus.payload || {}, "executionSnapshot"),
    false,
    "管理层不应读取餐饮员工内部执行快照",
  );
  assert.equal(managementStatus.payload?.internalProfileRedacted, true);

  await forbidden(
    actors.employee,
    "employee_cannot_review_restaurant_output",
    `/api/marshals/outputs/${ids.restaurantOutputId}/review`,
    { decision: "adopt", reason: "普通员工不应审阅数字员工产出" },
  );
  if (task.status === "待审阅") {
    const adopted = await request(
      actors.boss,
      `/api/marshals/outputs/${ids.restaurantOutputId}/review`,
      {
        method: "POST",
        body: {
          decision: "adopt",
          reason: "老板已核验事实边界、岗位交付与账务证据。",
        },
        label: "boss_adopts_real_restaurant_output",
      },
    );
    ids.restaurantKnowledgeId = Number(adopted.payload?.knowledgeId);
    ids.restaurantAssetId = Number(adopted.payload?.assetId);
  } else {
    ids.restaurantKnowledgeId = Number(
      liveDb
        .prepare(
          "SELECT id FROM kb_docs WHERE tenant_id=? AND source_type='content' AND source_id=?",
        )
        .get(tenant.id, ids.restaurantOutputId)?.id,
    );
    ids.restaurantAssetId = Number(
      liveDb
        .prepare(
          "SELECT id FROM biz_assets WHERE tenant_id=? AND source_type='content' AND source_id=?",
        )
        .get(tenant.id, ids.restaurantOutputId)?.id,
    );
  }
  const adoptedTask = liveDb
    .prepare("SELECT status FROM agent_tasks WHERE tenant_id=? AND id=?")
    .get(tenant.id, ids.restaurantTaskId);
  assert.equal(adoptedTask?.status, "已完成");
  assert.ok(ids.restaurantKnowledgeId > 0, "餐饮采纳未形成知识库记录");
  assert.ok(ids.restaurantAssetId > 0, "餐饮采纳未形成业务资产记录");
  markStage("restaurant_adopted", {
    restaurantKnowledgeId: ids.restaurantKnowledgeId,
    restaurantAssetId: ids.restaurantAssetId,
  });
  scenarios.restaurantEmployee = {
    ok: true,
    entityId: ids.restaurantTaskId,
    businessStatus: "已完成",
  };
}

async function runContentEmployeeFlow(runTag) {
  if (ids.contentProviderFingerprint) {
    assert.equal(
      ids.contentProviderFingerprint,
      providerReadiness.fingerprint,
      "内容样本恢复时云雾供应商配置发生变化",
    );
  } else {
    ids.contentProviderFingerprint = providerReadiness.fingerprint;
    ids.contentProviderVerificationFingerprint =
      providerReadiness.verificationFingerprint;
    persistCheckpoint("running");
  }
  const profileResponse = await request(
    actors.boss,
    `/api/employee-workbench/content/${options.contentIdx}`,
    { label: "boss_reads_content_dispatch_profile" },
  );
  const dispatchBody = buildContentDispatch(
    profileResponse.payload,
    `${runTag}-content-${options.contentIdx}`,
  );
  ids.contentEmployeeIdx = options.contentIdx;
  const mutation = await reconcileNonceMutation({
    label: "employee_dispatches_real_content_employee",
    lookup: () =>
      liveDb
        .prepare(
          `SELECT * FROM content_employee_runs
          WHERE tenant_id=? AND employee_idx=? AND title=? AND requirement=? AND created_by=? ORDER BY id`,
        )
        .all(
          tenant.id,
          options.contentIdx,
          dispatchBody.title,
          dispatchBody.requirement,
          actors.employee.id,
        ),
    mutate: () =>
      request(
        actors.employee,
        `/api/employee-workbench/content/${options.contentIdx}/dispatch`,
        {
          method: "POST",
          body: dispatchBody,
          label: "employee_dispatches_real_content_employee",
        },
      ),
    validate: (row, response) => {
      if (response) assert.equal(Number(response.payload?.runId), Number(row.id));
      assert.equal(Number(row.created_by), actors.employee.id);
      assert.equal(Number(row.employee_idx), options.contentIdx);
      assert.equal(String(row.title), String(dispatchBody.title));
      assert.equal(String(row.requirement), String(dispatchBody.requirement));
    },
  });
  ids.contentRunId = Number(mutation.row.id);
  markStage("content_dispatched", {
    contentRunId: ids.contentRunId,
    contentEmployeeIdx: ids.contentEmployeeIdx,
  });
  if (mutation.row.status === "生成中") {
    await waitForContentRun(ids.contentRunId);
  }
  let run = liveDb
    .prepare(
      "SELECT status,ai_mode,snapshot_json FROM content_employee_runs WHERE tenant_id=? AND id=?",
    )
    .get(tenant.id, ids.contentRunId);
  if (!["待审阅", "已完成"].includes(run?.status)) {
    throw new Error(`内容任务#${ids.contentRunId}不可恢复：${run?.status || "缺失"}`);
  }
  assert.equal(run?.ai_mode, "api");
  const snapshot = safeJson(run?.snapshot_json, {});
  assert.equal(
    snapshot?.contractValid ?? snapshot?.contract?.valid,
    true,
    "内容员工岗位契约未通过",
  );
  assertRealAiBilling(
    "content_employee_run",
    ids.contentRunId,
    "内容员工真实任务",
  );
  if (!contractEvidence.some((item) => item.domain === "content")) {
    assertContentContractFromDb(ids.contentRunId);
  }
  markStage("content_contract_gate");

  const bossDetail = await request(
    actors.boss,
    `/api/employee-workbench/content/${options.contentIdx}/runs/${ids.contentRunId}`,
    { label: "boss_reads_full_content_execution_snapshot" },
  );
  assert.ok(bossDetail.payload?.run?.snapshot, "老板缺少内容员工执行快照");
  const managementDetail = await request(
    actors.management,
    `/api/employee-workbench/content/${options.contentIdx}/runs/${ids.contentRunId}`,
    { label: "management_reads_redacted_content_run" },
  );
  assert.equal(
    Object.hasOwn(managementDetail.payload?.run || {}, "snapshot"),
    false,
    "管理层不应读取内容员工内部执行快照",
  );
  assert.equal(managementDetail.payload?.run?.internalProfileRedacted, true);

  await forbidden(
    actors.employee,
    "employee_cannot_self_review_content_output",
    `/api/employee-workbench/content/${options.contentIdx}/runs/${ids.contentRunId}/review`,
    { decision: "adopt", opinion: "普通员工不应自审" },
  );
  if (run.status === "待审阅") {
    const adopted = await request(
      actors.boss,
      `/api/employee-workbench/content/${options.contentIdx}/runs/${ids.contentRunId}/review`,
      {
        method: "POST",
        body: {
          decision: "adopt",
          opinion: "老板已核对事实、平台适配、授权边界和账务证据；未执行外发。",
        },
        label: "boss_adopts_real_content_employee_output",
      },
    );
    ids.contentMaterialId = Number(adopted.payload?.materialId);
    ids.contentId = Number(adopted.payload?.contentId);
  } else {
    ids.contentMaterialId = Number(
      liveDb
        .prepare(
          "SELECT id FROM materials WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=? ORDER BY id",
        )
        .get(tenant.id, ids.contentRunId)?.id,
    );
    ids.contentId = Number(
      liveDb
        .prepare(
          "SELECT id FROM contents WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=? ORDER BY id",
        )
        .get(tenant.id, ids.contentRunId)?.id,
    );
  }
  assert.ok(ids.contentMaterialId > 0, "内容采纳未形成素材记录");
  assert.ok(ids.contentId > 0, "内容采纳未形成可使用内容记录");
  const adoptedRun = liveDb
    .prepare(
      "SELECT status FROM content_employee_runs WHERE tenant_id=? AND id=?",
    )
    .get(tenant.id, ids.contentRunId);
  assert.equal(adoptedRun?.status, "已完成");
  const material = liveDb
    .prepare(
      `SELECT body_snapshot,artifact_snapshot_json,creator_id
      FROM materials WHERE tenant_id=? AND id=?
        AND source_type='content_employee_run' AND source_id=?`,
    )
    .get(tenant.id, ids.contentMaterialId, ids.contentRunId);
  assert.ok(material, "内容素材血缘丢失");
  const gate = contractEvidence.find((item) => item.domain === "content");
  assert.equal(hashValue(String(material.body_snapshot || "")), gate.bodySha256);
  const materialArtifact = strictJson(
    material.artifact_snapshot_json,
    "内容素材产物快照",
  );
  assert.equal(
    hashValue(String(materialArtifact.content || "")),
    gate.artifactSha256,
    "采纳后素材主产物与采纳前契约产物不一致",
  );
  markStage("content_adopted", {
    contentMaterialId: ids.contentMaterialId,
    contentId: ids.contentId,
  });
  scenarios.contentEmployee = {
    ok: true,
    entityId: ids.contentRunId,
    businessStatus: "已完成",
  };
}

let runError = null;
try {
  const preflight = preflightCredentialAccounts(liveDb, credentials);
  tenant = preflight.tenant;
  expectedActorIds = Object.fromEntries(
    Object.entries(preflight.actors).map(([lane, actor]) => [
      lane,
      Number(actor.id),
    ]),
  );
  const isolation = assertIsolationMarker(liveDb, tenant.id, {
    batchNonce: options.batchNonce,
    databasePath,
  });
  markerKey = isolation.markerKey;
  if (loadedCheckpointRaw) {
    validateCheckpoint(loadedCheckpointRaw, {
      batchNonceSha256: isolation.batchNonceSha256,
      databaseIdentitySha256: isolation.databaseIdentity.sha256,
      codeFingerprint,
      scenarioFingerprint,
      outputPath: options.outputPath,
    });
    assert.deepEqual(
      loadedCheckpointRaw.actorIds,
      expectedActorIds,
      "checkpoint三角色身份与本次凭据不匹配",
    );
    checkpointState = {
      databaseIdentitySha256: isolation.databaseIdentity.sha256,
      providerFingerprint: loadedCheckpointRaw.providerFingerprint || null,
      stages: loadedCheckpointRaw.stages,
    };
    ids = { ...loadedCheckpointRaw.ids };
    watermarks = loadedCheckpointRaw.watermarks;
  } else {
    checkpointState = {
      databaseIdentitySha256: isolation.databaseIdentity.sha256,
      providerFingerprint: null,
      stages: {},
    };
    writeJsonExclusive0600(options.checkpointPath, checkpointDocument("running"));
  }
  removeSignalHandlers = installSignalHandlers();
  if (loadedCheckpointRaw) {
    assertResumeContainsOnlyTrackedAiState();
  } else {
    assertNoHeldCredits("运行前检查");
    assertNoActiveAiTasks("运行前检查");
  }
  const integrity = scalar(liveDb, "PRAGMA integrity_check")?.integrity_check;
  assert.equal(integrity, "ok", "隔离库完整性检查失败");

  const health = await request(null, "/api/health", {
    label: "live_service_health",
  });
  assert.equal(health.payload?.ok, true, "真实HTTP服务健康状态不是ok");
  assert.equal(health.payload?.db, "up", "真实HTTP服务数据库状态不是up");

  const beforeLoginLogId = loginWatermark(liveDb, tenant.id);
  actors = {
    boss: await login("boss", credentials.boss),
    management: await login("management", credentials.management),
    employee: await login("employee", credentials.employee),
  };
  for (const lane of ["boss", "management", "employee"]) {
    assert.equal(actors[lane].id, Number(preflight.actors[lane].id));
    assert.equal(actors[lane].tenantId, Number(tenant.id));
    assert.equal(
      actors[lane].id,
      Number(expectedActorIds[lane]),
      `checkpoint中的${lane}账号身份已变更`,
    );
  }
  persistCheckpoint("running");
  assertLoginWritesReachedBoundDatabase(
    liveDb,
    tenant.id,
    beforeLoginLogId,
    credentials,
  );
  const readiness = await request(actors.boss, "/api/sys/runtime-readiness", {
    label: "boss_reads_live_runtime_readiness",
  });
  providerReadiness = assertFreshOfficialYunwuReadiness(readiness.payload);
  if (checkpointState.providerFingerprint) {
    assert.equal(
      providerReadiness.fingerprint,
      checkpointState.providerFingerprint,
      "checkpoint恢复时云雾供应商或显式验证证据已变化",
    );
  } else {
    checkpointState.providerFingerprint = providerReadiness.fingerprint;
    persistCheckpoint("running");
  }
  const readinessChannels = Array.isArray(readiness.payload?.channels)
    ? readiness.payload.channels
    : [];
  const schedulerReadiness = readinessChannels.find(
    (item) => item?.key === "scheduler",
  );
  assert.equal(
    schedulerReadiness?.activation,
    "disabled",
    "专用隔离库运行真实穿透时必须关闭Scheduler",
  );
  if (tableExists(liveDb, "content_automation_rules")) {
    const enabledAutomation = Number(
      scalar(
        liveDb,
        "SELECT COUNT(*) count FROM content_automation_rules WHERE tenant_id=? AND enabled=1",
        tenant.id,
      )?.count || 0,
    );
    assert.equal(enabledAutomation, 0, "隔离租户存在启用的内容自动化规则");
  }

  if (!watermarks || !Object.keys(watermarks).length) {
    watermarks = captureWatermarks(liveDb, tenant.id);
    persistCheckpoint("running");
  }
  const runTag = `LIVE-${hashValue(options.batchNonce).slice(0, 24)}`;
  await runProfileAccessFlow();
  await runManualTaskFlow(runTag);
  await runRestaurantEmployeeFlow(runTag);
  assertNoHeldCredits("餐饮员工完成后检查");
  await runContentEmployeeFlow(runTag);
  assertNoHeldCredits("全流程完成后检查");
  assertNoActiveAiTasks("全流程完成后检查");

  finalEvidence = collectFlowEvidence(liveDb, tenant.id, watermarks);
  const validation = validateBoundFlowEvidence(finalEvidence, ids, actors);
  assert.deepEqual(validation.errors, [], validation.errors.join("；"));
  assert.equal(
    watermarks.balance - finalEvidence.billing.balanceAfter,
    finalEvidence.billing.chargedCredits,
    "租户余额变化与两条AI任务真实结算不一致",
  );
  assert.equal(
    isolation.databaseIdentity.sha256,
    checkpointState.databaseIdentitySha256,
    "运行期间数据库身份发生变更",
  );
  const endingDatabaseIdentity = computeDatabaseIdentityFingerprint(
    liveDb,
    databasePath,
    isolation.databaseId,
  );
  assert.equal(
    endingDatabaseIdentity.sha256,
    isolation.databaseIdentity.sha256,
    "运行期间数据库路径、inode、schema或持久化PRAGMA发生变更",
  );
  assert.equal(
    computeFilesFingerprint(codeDependencyFiles).sha256,
    codeFingerprint,
    "运行期间测试执行器或服务端关键代码发生变更",
  );
  assert.equal(
    providerReadiness.fingerprint,
    checkpointState.providerFingerprint,
    "两条AI样本未绑定同一云雾供应商验证证据",
  );
} catch (error) {
  runError = error;
  if (tenant && watermarks) {
    try {
      finalEvidence = collectFlowEvidence(liveDb, tenant.id, watermarks);
    } catch {
      // Preserve the primary failure when partial evidence cannot be collected.
    }
  }
  try {
    persistCheckpoint(interruptedSignal ? "interrupted" : "failed");
  } catch {
    // Do not mask the primary failure.
  }
} finally {
  if (!runError) {
    const artifact = positiveWhitelistEvidence({
      schema: LIVE_ROLE_FLOW_MATRIX_SCHEMA,
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      baseUrl: options.baseUrl,
      database: path.basename(databasePath),
      batchNonceSha256: hashValue(options.batchNonce),
      fingerprints: {
        code: codeFingerprint,
        scenario: scenarioFingerprint,
        databaseIdentity: checkpointState?.databaseIdentitySha256,
        provider: providerReadiness?.fingerprint,
      },
      tenant: tenant
        ? {
            id: Number(tenant.id),
            name: tenant.name,
            status: tenant.status,
            dataMode: tenant.data_mode,
            markerKey,
          }
        : null,
      actors: actors
        ? Object.fromEntries(
            Object.entries(actors).map(([lane, actor]) => [
              lane,
              projectIdentityEvidence(actor),
            ]),
          )
        : null,
      cloudAiOptIn: options.allowAiCloud,
      providerReadiness,
      validationScope: "two_explicit_ai_business_samples_plus_one_manual_hierarchy",
      samplesValidated: {
        manualTask: { sampleCount: 1, ok: scenarios.manualTask.ok },
        restaurantEmployee: {
          sampleCount: 1,
          employeeIdx: options.restaurantIdx,
          ok: scenarios.restaurantEmployee.ok,
        },
        contentEmployee: {
          sampleCount: 1,
          employeeIdx: options.contentIdx,
          ok: scenarios.contentEmployee.ok,
        },
      },
      scenarios,
      profileAccess,
      outputContract: contractEvidence,
      checks,
      billing: finalEvidence?.billing || null,
      approvals: finalEvidence?.approvals || [],
      assets: finalEvidence?.assets || [],
      knowledge: finalEvidence?.knowledge || [],
      materials: finalEvidence?.materials || [],
      notifications: finalEvidence?.notifications || [],
      operations: finalEvidence?.operations || [],
      tasks: finalEvidence?.manualTask?.tasks || [],
      submissions: finalEvidence?.manualTask?.submissions || [],
      contents: finalEvidence?.contents || [],
      runs: [
        ...(finalEvidence?.restaurantEmployee?.tasks || []),
        ...(finalEvidence?.contentEmployee?.runs || []),
      ],
      summary: summarizeRunChecks(checks),
      checkpoint: { status: "complete" },
      error: null,
    });
    writeJsonExclusive0600(options.outputPath, artifact);
    persistCheckpoint("complete");
  }
  removeSignalHandlers();
  try {
    liveDb.close();
  } catch {
    // Database may already be closed after a fatal runtime error.
  }
}

if (runError) {
  process.stderr.write(
    `FAIL_LIVE_ROLE_FLOW_MATRIX ${redactDiagnostic(runError.message, 500)}\n`,
  );
  process.stderr.write(`checkpoint=${options.checkpointPath}\n`);
  process.exit(interruptedSignal ? 130 : 1);
}

const summary = summarizeRunChecks(checks);
process.stdout.write(
  [
    `PASS_LIVE_ROLE_FLOW_MATRIX checks=${summary.passed}/${summary.count} forbidden403=${summary.forbiddenChecks}`,
    `validatedSamples=manual:1,restaurant:${options.restaurantIdx}:1,content:${options.contentIdx}:1 held=0`,
    `evidence=${options.outputPath}`,
    "",
  ].join("\n"),
);

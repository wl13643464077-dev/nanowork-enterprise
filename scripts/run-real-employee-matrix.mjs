#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import {
  REAL_MATRIX_SCHEMA,
  REAL_MATRIX_COST_SEMANTICS,
  REAL_MATRIX_DEFAULT_JOB_TIMEOUT_MS,
  LEGACY_REAL_MATRIX_SCHEMA,
  applyProviderCostSemantics,
  buildContentDispatch,
  buildJobs,
  buildRestaurantMatrixGateDispatch,
  buildRestaurantDispatch,
  CONTENT_PIPELINE_INDEXES,
  classifyAttempt,
  classifyProviderEvidence,
  createContentLineageEnvelope,
  createInitialState,
  createProviderPricingSnapshot,
  contentProfileIntegrityEvidence,
  formatAttemptCostForCli,
  formatSummaryCostForCli,
  evaluateRestaurantMatrixOutputEvidence,
  isLoopbackServiceBaseUrl,
  isOfficialYunwuBaseUrl,
  isRestaurantMatrixReportFirstContract,
  mergeRunSelection,
  parseOnlyFilter,
  parsePositiveInteger,
  projectProviderBudget,
  projectProviderAttempts,
  summarizeWebResearchEvidence,
  summarizeProviderAttempts,
  summarizeState,
  validateContentDispatchEvidence,
  validateContentProfileCompleteness,
  validateContentProfileExecutionChain,
  validateContentLineageEdge,
  validateContentLineageInput,
  validateAttemptInvocation,
  validateRestaurantDispatchEvidence,
} from "./lib/real-employee-matrix.mjs";
import { validateRestaurantEmployeeOutputContract } from "../server/src/engines/restaurant-output-contract.js";
import { validateContentEmployeeOutputContract } from "../server/src/engines/content-output-contract.js";
import { buildContentEmployeeWorkbenchProfile } from "../server/src/engines/content-employee-workbench.js";
import {
  buildRealContentProductionLineageEdge,
  buildRealContentProductionPipelineBrief,
  contentProductionPickSelection,
  evaluateRealContentProductionStation,
} from "./lib/real-content-production-pipeline.mjs";
import { buildDeterministicVisionFixturePng } from "./lib/real-feature-matrix.mjs";
import {
  businessResultLooksLikeAbilityList,
  buildUnifiedAcceptancePlan,
  evaluateUnifiedAcceptanceGate,
  isPublicInfoUserQuestion,
  redactUnifiedGateForReport,
} from "./lib/real-acceptance-gates.mjs";

function usage() {
  return `真实云API验收运行器（61名餐饮单岗（60核心+1扩展） + 11名内容单岗（10个派活AI+1名AI带货员） + 内容0→9十阶段流水线）

用法：
  MATRIX_USERNAME=guan MATRIX_PASSWORD=... node scripts/run-real-employee-matrix.mjs [选项]
  node scripts/run-real-employee-matrix.mjs --reconcile-only --db FILE --out FILE --only LIST

选项：
  --base-url URL          已启动项目地址（默认 http://127.0.0.1:3107）
  --out FILE              断点与报告JSON（默认 artifacts/real-employee-matrix.json）
  --db FILE               必填：服务正在使用的专用隔离SQLite库
  --only LIST             仅跑指定岗位，如 restaurant:101,content:8
  --concurrency N         并发岗位数，1-6（默认1）
  --timeout-ms N          每岗等待生成超时（默认${REAL_MATRIX_DEFAULT_JOB_TIMEOUT_MS}，最长3600000）
  --poll-ms N             轮询间隔（默认2000）
  --force                 强制重跑 --only 选中的岗位（用于质量审计推翻旧通过证据）
  --no-retry-failures     续跑时跳过已有失败岗位（默认会重试失败岗位）
  --reconcile-only        仅用 --db 只读重建旧断点账务窗口；禁止HTTP、云API和业务写入
  --help                  显示帮助

约束：
  运行器不会读取或保存云API Key；云API Key必须只配置在已启动服务的进程环境中。
  业务服务只允许loopback，并必须使用含专用租户标记的隔离库。
  template/mock/fallback/failed、零token、未结算或契约失败一律不计通过。
  合格产物默认人工采纳到内部素材/资产终态，但绝不执行对外发布。
  11个内容岗先各自执行完整单岗能力验收；选中内容0→9全组时再串行执行独立的0→9流水线，AI带货员idx10走原生视频入口。
  流水线直接调用 /api/content/pipelines；每岗从数据库加载前面全部已完成工位，不上传伪造上游。
  报告把供应商成本估算与客户账本实扣分开；退款为0实扣不表示云调用成本为0。
`;
}

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`未知参数：${item}`);
    if (
      [
        "--help",
        "--force",
        "--no-retry-failures",
        "--reconcile-only",
      ].includes(item)
    ) {
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
    "--out",
    "--db",
    "--only",
    "--concurrency",
    "--timeout-ms",
    "--poll-ms",
  ]);
  for (const key of Object.keys(values))
    if (!allowed.has(key)) throw new Error(`未知参数：${key}`);
  return {
    help: flags.has("--help"),
    force: flags.has("--force"),
    reconcileOnly: flags.has("--reconcile-only"),
    retryFailures: !flags.has("--no-retry-failures"),
    baseUrl: String(
      values["--base-url"] ||
        process.env.MATRIX_BASE_URL ||
        "http://127.0.0.1:3107",
    ).replace(/\/+$/u, ""),
    outputPath: path.resolve(
      values["--out"] ||
        process.env.EMPLOYEE_REAL_MATRIX_FILE ||
        "artifacts/real-employee-matrix.json",
    ),
    databasePath:
      values["--db"] || process.env.MATRIX_DB || process.env.NANOWORK_DB || "",
    only: parseOnlyFilter(values["--only"] || process.env.MATRIX_ONLY || ""),
    concurrency: parsePositiveInteger(
      values["--concurrency"] || process.env.MATRIX_CONCURRENCY,
      1,
      { min: 1, max: 6 },
    ),
    timeoutMs: parsePositiveInteger(
      values["--timeout-ms"] || process.env.MATRIX_TIMEOUT_MS,
      REAL_MATRIX_DEFAULT_JOB_TIMEOUT_MS,
      // 完整岗位单轮云请求最长900秒，最坏情况下还需两轮真实修复；
      // runner必须比后台调用预算更长，不能先把仍在执行的任务误报为超时。
      { min: 30_000, max: 3_600_000 },
    ),
    pollMs: parsePositiveInteger(
      values["--poll-ms"] || process.env.MATRIX_POLL_MS,
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
if (!isLoopbackServiceBaseUrl(options.baseUrl)) {
  throw new Error("真实员工矩阵只允许连接loopback本地业务服务");
}
if (!options.databasePath) {
  throw new Error("必须通过--db或MATRIX_DB显式指定服务使用的专用隔离库");
}

const username = String(process.env.MATRIX_USERNAME || "").trim();
const password = String(process.env.MATRIX_PASSWORD || "");
if (!options.reconcileOnly && (!username || !password)) {
  process.stderr.write(
    "缺少MATRIX_USERNAME或MATRIX_PASSWORD；凭证不会写入报告。\n",
  );
  process.exit(2);
}

const selectedJobs = buildJobs(options.only);
if (!selectedJobs.length) throw new Error("没有选中任何岗位");
if (options.reconcileOnly && !options.only) {
  throw new Error("--reconcile-only 必须与 --only 一起使用，禁止隐式改写全量断点");
}
if (options.reconcileOnly && !fs.existsSync(options.outputPath)) {
  throw new Error("--reconcile-only 只能处理已存在的 --out 断点文件");
}
if (options.reconcileOnly && options.force) {
  throw new Error("--reconcile-only 不允许 --force；该模式只重建旧证据，不重跑任务");
}
if (options.force && !options.only) {
  throw new Error(
    "--force 必须与 --only 一起使用，避免意外重跑全部真实API岗位",
  );
}
fs.mkdirSync(path.dirname(options.outputPath), {
  recursive: true,
  mode: 0o700,
});

function readState() {
  if (!fs.existsSync(options.outputPath)) {
    return createInitialState({
      baseUrl: options.baseUrl,
      selectedJobs: selectedJobs.map((job) => job.key),
      concurrency: options.concurrency,
    });
  }
  const parsed = JSON.parse(fs.readFileSync(options.outputPath, "utf8"));
  if (
    ![REAL_MATRIX_SCHEMA, LEGACY_REAL_MATRIX_SCHEMA].includes(
      parsed.schemaVersion,
    )
  ) {
    throw new Error(`断点文件版本不兼容：${parsed.schemaVersion || "missing"}`);
  }
  if (parsed.schemaVersion === LEGACY_REAL_MATRIX_SCHEMA) {
    parsed.schemaVersion = REAL_MATRIX_SCHEMA;
    parsed.migratedFrom = LEGACY_REAL_MATRIX_SCHEMA;
  }
    parsed.pipeline ||= {
    enabled: CONTENT_PIPELINE_INDEXES.every((idx) =>
      selectedJobs.some(
        (job) => job.domain === "content" && Number(job.idx) === Number(idx),
      ),
    ),
    mode: "sequential_0_to_9",
    stages: {},
    edges: [],
  };
  parsed.evidencePolicy ||= {};
  parsed.evidencePolicy.costSemantics = REAL_MATRIX_COST_SEMANTICS;
  // 状态语义升级后允许只重判既有证据，避免因为报告器旧口径而重复消耗真实 Token。
  const reportSlots = [
    ...Object.values(parsed.jobs || {}),
    ...Object.values(parsed.pipeline?.stages || {}),
  ];
  for (const item of reportSlots) {
    if (!item?.latest || item.latest.verdict === "IN_PROGRESS") continue;
    const reclassified = {
      ...item.latest,
      ...classifyAttempt(item.latest),
    };
    const judged = applyProviderCostSemantics(
      reclassified,
      parsed.providerPricingSnapshot ||
        parsed.runtimeEvidence?.providerPricingSnapshot ||
        null,
    );
    item.latest = judged;
    if (Array.isArray(item.attempts) && item.attempts.length) {
      const last = item.attempts.length - 1;
      if (item.attempts[last]?.attemptId === judged.attemptId)
        item.attempts[last] = judged;
    }
  }
  return parsed;
}

const invocationId = crypto.randomUUID();
const state = mergeRunSelection(readState(), {
  baseUrl: options.baseUrl,
  selectedJobs: selectedJobs.map((job) => job.key),
  concurrency: options.concurrency,
  force: options.force,
  retryFailures: options.retryFailures,
  invocationId,
});
const currentInvocation = state.run?.invocations?.find(
  (item) => item.id === invocationId,
);
if (currentInvocation && options.reconcileOnly) {
  currentInvocation.mode = "reconcile_only";
  currentInvocation.httpRequestCount = 0;
  currentInvocation.providerCallCount = 0;
  currentInvocation.businessMutationCount = 0;
}
let stopped = false;

function recordInvocationJob(field, key) {
  const invocation = state.run?.invocations?.find(
    (item) => item.id === invocationId,
  );
  if (!invocation) return;
  invocation[field] ||= [];
  if (!invocation[field].includes(key)) invocation[field].push(key);
}

function persistState() {
  state.updatedAt = new Date().toISOString();
  state.summary = summarizeState(state);
  state.pipeline.summary = state.summary.pipeline;
  const temp = `${options.outputPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    temporaryCreated = true;
    fs.renameSync(temp, options.outputPath);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated && fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function setInProgress(key, attempt) {
  const existing = state.jobs[key] || { attempts: [] };
  state.jobs[key] = { ...existing, latest: attempt };
  persistState();
}

function finalizeAttempt(key, attempt) {
  const classified = classifyAttempt(attempt);
  const judged = applyProviderCostSemantics(
    {
      ...attempt,
      ...classified,
      capabilityPass: classified.pass,
      finishedAt: new Date().toISOString(),
    },
    state.providerPricingSnapshot,
  );
  const existing = state.jobs[key] || { attempts: [] };
  state.jobs[key] = {
    attempts: [
      ...(Array.isArray(existing.attempts) ? existing.attempts : []),
      judged,
    ],
    latest: judged,
  };
  persistState();
  return judged;
}

function setPipelineInProgress(idx, attempt) {
  const key = `content:${Number(idx)}`;
  const existing = state.pipeline.stages[key] || { attempts: [] };
  state.pipeline.stages[key] = { ...existing, latest: attempt };
  persistState();
}

function finalizePipelineAttempt(idx, attempt) {
  const key = `content:${Number(idx)}`;
  const classified = classifyAttempt(attempt);
  const judged = applyProviderCostSemantics(
    {
      ...attempt,
      ...classified,
      pipelinePass: classified.pass,
      finishedAt: new Date().toISOString(),
    },
    state.providerPricingSnapshot,
  );
  const existing = state.pipeline.stages[key] || { attempts: [] };
  state.pipeline.stages[key] = {
    attempts: [
      ...(Array.isArray(existing.attempts) ? existing.attempts : []),
      judged,
    ],
    latest: judged,
  };
  persistState();
  return judged;
}

function recordBlockedPipelineStage(idx, reason, upstream = null) {
  const attempt = {
    domain: "content",
    idx: Number(idx),
    employeeId: `content:${Number(idx)}`,
    acceptanceKind: "pipeline",
    attemptId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    phase: "blocked",
    verdict: "BLOCKED_PIPELINE",
    pass: false,
    pipelinePass: false,
    capabilityPass: null,
    lineageValid: false,
    lineageErrors: [String(reason)],
    httpError: String(reason),
    terminalStatus: "已阻断",
    upstreamBusinessId: Number(upstream?.businessId) || null,
    externalPublish: false,
  };
  const key = `content:${Number(idx)}`;
  const existing = state.pipeline.stages[key] || { attempts: [] };
  state.pipeline.stages[key] = {
    attempts: [
      ...(Array.isArray(existing.attempts) ? existing.attempts : []),
      attempt,
    ],
    latest: attempt,
  };
  persistState();
  return attempt;
}

process.once("SIGINT", () => {
  stopped = true;
  if (!options.reconcileOnly) persistState();
});
process.once("SIGTERM", () => {
  stopped = true;
  if (!options.reconcileOnly) persistState();
});

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
let authToken = "";
let httpRequestCount = 0;
let actorRole = "";

async function request(
  pathname,
  { method = "GET", body, timeoutMs = 30_000, retry429 = true } = {},
) {
  httpRequestCount += 1;
  const idempotentMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
  let attempt = 0;
  while (true) {
    attempt += 1;
    let response;
    try {
      response = await fetch(`${options.baseUrl}${pathname}`, {
        method,
        headers: {
          ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (idempotentMethod && attempt < 4) {
        await sleep(Math.min(5_000, 500 * 2 ** attempt));
        continue;
      }
      const failure = new Error(
        `${method} ${pathname}网络失败：${error.message}`,
      );
      failure.code = idempotentMethod
        ? "REQUEST_NETWORK_FAILED"
        : "MUTATION_RESULT_AMBIGUOUS";
      throw failure;
    }
    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = raw;
    }
    if (
      response.status === 429 &&
      retry429 &&
      idempotentMethod &&
      attempt < 30
    ) {
      const retrySeconds = Math.max(
        1,
        Number(response.headers.get("retry-after")) || 2,
      );
      await sleep(Math.min(60_000, retrySeconds * 1000));
      continue;
    }
    if (!response.ok) {
      const message =
        payload?.error || payload?.message || raw || `${response.status}`;
      const error = new Error(
        `${method} ${pathname}返回${response.status}：${message}`,
      );
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return { response, payload, raw };
  }
}

async function loginAndVerifyRuntime() {
  const login = await request("/api/auth/login", {
    method: "POST",
    body: { username, password },
    retry429: false,
  });
  authToken = login.payload?.token || "";
  if (!authToken) throw new Error("登录成功响应缺少token");
  tenantId = Number(login.payload?.user?.tenant?.id);
  userId = Number(login.payload?.user?.id);
  actorRole = String(login.payload?.user?.role || "").trim();
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
    throw new Error("验收账号缺少租户作用域");
  }
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("验收账号缺少用户ID");
  }
  if (
    state.pipeline?.runRequested === true &&
    !["boss", "ops_director", "manager", "admin", "platform_super"].includes(
      actorRole,
    )
  ) {
    throw new Error(
      `0→9真实流水线需要可审阅账号；当前角色=${actorRole || "missing"}`,
    );
  }
  assertDedicatedMatrixMarker();
  const config = await request("/api/admin/api-config");
  if (config.payload?.channel?.available !== true) {
    throw new Error(
      `真实云API不可用：${config.payload?.channel?.readiness?.reason || "服务未检测到环境变量凭证"}`,
    );
  }
  const provider = String(config.payload?.channel?.provider || "");
  if (!/云雾|yunwu/iu.test(provider))
    throw new Error(`当前提供商不是云雾API：${provider || "missing"}`);
  if (!isOfficialYunwuBaseUrl(config.payload?.channel?.baseUrl)) {
    throw new Error(
      "云雾API基址不是yunwu.ai官方HTTPS /v1地址，拒绝仿冒云验收",
    );
  }
  const checkedAt = new Date().toISOString();
  const providerPricingSnapshot = createProviderPricingSnapshot(
    config.payload?.billing,
    {
      pricingSource: "runtime_api_config.billing.text",
      capturedAt: checkedAt,
    },
  );
  const runtimeEvidence = {
    invocationId,
    checkedAt,
    provider,
    baseUrl: config.payload.channel.baseUrl,
    keySource: config.payload.channel.keySource,
    keyPersistence: config.payload.channel.keyPersistence,
    available: true,
    routing: config.payload.routing,
    providerPricingSnapshot,
  };
  state.providerPricingSnapshot = providerPricingSnapshot;
  state.runtimeEvidence = runtimeEvidence;
  const invocation = state.run?.invocations?.find(
    (item) => item.id === invocationId,
  );
  if (invocation) invocation.runtimeEvidence = runtimeEvidence;
  persistState();
}

let tenantId = null;
let userId = null;
const resolvedBillingDatabase = path.resolve(options.databasePath);
if (!fs.existsSync(resolvedBillingDatabase)) {
  throw new Error(`--db不存在：${resolvedBillingDatabase}`);
}
const canonicalBillingDatabase = fs.realpathSync.native(
  resolvedBillingDatabase,
);
const defaultBusinessDatabase = path.resolve(
  "server/data/nanowork-industry.db",
);
const canonicalDefaultBusinessDatabase = fs.existsSync(defaultBusinessDatabase)
  ? fs.realpathSync.native(defaultBusinessDatabase)
  : defaultBusinessDatabase;
if (canonicalBillingDatabase === canonicalDefaultBusinessDatabase) {
  throw new Error("真实员工矩阵拒绝运行在默认业务库");
}
const databaseStat = fs.statSync(canonicalBillingDatabase);
const databaseIdentity = `${databaseStat.dev}:${databaseStat.ino}`;
if (
  options.reconcileOnly &&
  (state.billingEvidenceSource?.kind !== "sqlite_read_only" ||
    state.billingEvidenceSource?.authoritative !== true ||
    state.billingEvidenceSource?.noteFallbackAllowed !== false ||
    !state.billingEvidenceSource?.path ||
    path.resolve(state.billingEvidenceSource.path) !==
      canonicalBillingDatabase ||
    !state.billingEvidenceSource?.identity ||
    state.billingEvidenceSource.identity !== databaseIdentity)
) {
  throw new Error(
    "--reconcile-only 要求断点已绑定同一个权威只读SQLite文件及其文件身份",
  );
}
if (
  state.billingEvidenceSource?.kind &&
  (state.billingEvidenceSource.kind !== "sqlite_read_only" ||
    path.resolve(state.billingEvidenceSource.path || "") !==
      canonicalBillingDatabase ||
    (state.billingEvidenceSource.identity &&
      state.billingEvidenceSource.identity !== databaseIdentity))
) {
  throw new Error(
    "断点文件的计费证据库路径或文件身份与本次--db不一致，禁止混合两套账务证据",
  );
}
let billingDb = new DatabaseSync(canonicalBillingDatabase, { readOnly: true });
state.billingEvidenceSource = {
  kind: "sqlite_read_only",
  path: canonicalBillingDatabase,
  identity: databaseIdentity,
  authoritative: true,
  noteFallbackAllowed: false,
};

function assertDedicatedMatrixMarker() {
  const markerKey = `real_employee_matrix_isolated:${tenantId}`;
  const row = billingDb
    .prepare("SELECT value FROM sys_config WHERE key=?")
    .get(markerKey);
  let marker = row?.value;
  try {
    marker = JSON.parse(marker);
  } catch {
    // 允许手工预置的纯文本标记。
  }
  const valid =
    marker === "REAL_EMPLOYEE_MATRIX_ISOLATED_V1" ||
    marker?.marker === "REAL_EMPLOYEE_MATRIX_ISOLATED_V1";
  if (!valid) {
    throw new Error(
      `租户#${tenantId}缺少专用隔离标记 ${markerKey}=REAL_EMPLOYEE_MATRIX_ISOLATED_V1，拒绝变更数据`,
    );
  }
  state.isolation = {
    loopbackService: true,
    dedicatedDatabase: canonicalBillingDatabase,
    tenantMarkerKey: markerKey,
  };
}

function billingFromDatabase(refType, refId) {
  const rows = billingDb
    .prepare(
      `SELECT
      h.id hold_id,h.tenant_id hold_tenant_id,h.user_id hold_user_id,
      h.log_id hold_log_id,h.status billing_state,h.feature hold_feature,
      h.kind hold_kind,h.model hold_model,h.held_credits,h.settled_credits,
      h.ref_type,h.ref_id,h.created_at hold_created_at,h.settled_at hold_settled_at,
      l.id log_id,l.tenant_id log_tenant_id,l.user_id log_user_id,
      l.feature log_feature,l.kind log_kind,l.model log_model,
      l.input_tokens,l.output_tokens,l.cost_yuan,l.credits charged_credits,
      l.balance_after,l.ai_mode,l.created_at log_created_at
      FROM credit_holds h
      JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
      WHERE h.tenant_id=? AND h.ref_type=? AND h.ref_id=?
      ORDER BY h.id`,
    )
    .all(tenantId, refType, refId);
  if (rows.length !== 1) {
    return { authority_error: `hold_count=${rows.length}`, hold_count: rows.length };
  }
  const row = rows[0];
  const creditLogCount = Number(
    billingDb
      .prepare(
        `SELECT COUNT(*) n FROM credit_logs
         WHERE tenant_id=? AND id=?`,
      )
      .get(tenantId, row.log_id)?.n || 0,
  );
  return { ...row, hold_count: rows.length, credit_log_count: creditLogCount };
}

function ledgerBaseline() {
  return {
    balance: Number(
      billingDb.prepare("SELECT credits FROM tenants WHERE id=?").get(tenantId)
        ?.credits,
    ),
    holdId: Number(
      billingDb
        .prepare(
          "SELECT COALESCE(MAX(id),0) id FROM credit_holds WHERE tenant_id=?",
        )
        .get(tenantId)?.id || 0,
    ),
    logId: Number(
      billingDb
        .prepare(
          "SELECT COALESCE(MAX(id),0) id FROM credit_logs WHERE tenant_id=?",
        )
        .get(tenantId)?.id || 0,
    ),
  };
}

function approvalCountForTenant() {
  if (!Number.isSafeInteger(Number(tenantId)) || Number(tenantId) <= 0) return null;
  try {
    return Number(
      billingDb
        .prepare("SELECT COUNT(*) n FROM approvals WHERE tenant_id=?")
        .get(tenantId)?.n || 0,
    );
  } catch {
    // Older isolated snapshots may not have the tenant migration.  Missing
    // approval evidence must fail the unified gate, never be inferred as 0.
    return null;
  }
}

function publicInfoGateEvidence(web, outputText = "", required = true) {
  const channels = Array.isArray(web?.channels) ? web.channels : [];
  const results = Array.isArray(web?.results) ? web.results : [];
  const attempted = web?.attempted === true || channels.some((item) => item?.attempted === true);
  const ok = web?.ok === true || channels.some((item) => item?.ok === true);
  const citedUrlCount = results.filter((item) => /^https?:\/\//iu.test(String(item?.url || "").trim())).length;
  // A public-information gap must be reported as an unknown plus a follow-up
  // action; it must not be turned into a question for the Boss.  Keep this
  // detector deliberately scoped to requests for externally discoverable
  // facts/materials so ordinary recommendation language such as “请确认
  // 后续动作” is not misclassified as a user question.
  const userQuestioned = isPublicInfoUserQuestion(outputText);
  return {
    required: required === true,
    attempted,
    ok,
    citedUrlCount,
    userQuestioned,
    provider: String(web?.provider || channels.map((item) => item?.provider).filter(Boolean).join(" + ") || "").slice(0, 120) || null,
  };
}

function unifiedRestaurantGateEvidence({
  attempt,
  dispatch,
  pending,
  contract,
  semantic,
  finalStatus,
  approvalAfter,
}) {
  const snapshot = pending?.executionSnapshot || {};
  const providerAttempt = snapshot.providerAttempt || {};
  const web = snapshot.webEvidence || null;
  const outputText = String(pending?.output_body || "");
  const primaryCount = Number(attempt.primaryArtifactCount || 0);
  const gate = evaluateUnifiedAcceptanceGate({
    demand: attempt.acceptanceDemand || dispatch?.acceptanceDemand,
    publicInfoEvidence: publicInfoGateEvidence(web, outputText, true),
    providerEvidence: {
      invocationValid: attempt.providerInvocationEvidenceValid === true,
      mode: attempt.providerMode || providerAttempt.mode || null,
      model: attempt.providerModel || providerAttempt.model || attempt.model || null,
      inputTokens: attempt.inputTokens || providerAttempt.usage?.inputTokens,
      outputTokens: attempt.outputTokens || providerAttempt.usage?.outputTokens,
      attempts: attempt.providerInvocationApiAttempts || attempt.providerAttempts?.length || 0,
    },
    dataAnalysisEvidence: {
      inputFactsMapped: attempt.inputEvidenceValid === true,
      semanticValid: semantic?.valid === true,
      analysisProduced: attempt.analysisProduced === true,
    },
    skillInvocationEvidence: {
      profileLoaded:
        Boolean(snapshot.profileVersion) &&
        (Array.isArray(snapshot.capabilities) || Array.isArray(snapshot.skills) || Boolean(snapshot.canonicalProfile)),
      canonicalVerified:
        snapshot.canonicalSnapshotStatus === "verified" && Boolean(snapshot.canonicalProfile),
      outputContractBound: Boolean(contract?.contractId || contract?.schemaVersion || snapshot.outputContract),
      capabilityCount: Array.isArray(snapshot.capabilities) ? snapshot.capabilities.length : 0,
      skillCount: Array.isArray(snapshot.skills) ? snapshot.skills.length : 0,
    },
    businessResultEvidence: {
      primaryArtifactCount: primaryCount,
      outputChars: outputText.length,
      notAbilityList: businessResultLooksLikeAbilityList(outputText),
      resultHashValid: attempt.resultHashValid === true,
      artifactHashValid: attempt.artifactHashValid === true,
    },
    approvalsBefore: attempt.approvalCountBefore,
    approvalsAfter: approvalAfter,
    inputRecorded: Boolean(dispatch?.requirement) && attempt.inputEvidenceValid === true,
    outputRecorded: outputText.length > 0 && Number(attempt.outputId) > 0,
    executionRecorded: Boolean(finalStatus?.status || attempt.terminalStatus),
    feeEvidenceRecorded:
      attempt.billingLinkValid === true &&
      ["settled", "released"].includes(String(attempt.billingState || "")),
  });
  return redactUnifiedGateForReport(gate);
}

function unifiedContentGateEvidence({
  attempt,
  dispatch,
  run,
  localContract,
  approvalAfter,
}) {
  const snapshot = run?.snapshot || {};
  const providerAttempt = snapshot.providerAttempt || {};
  const outputText = String(run?.resultMd || "");
  const gate = evaluateUnifiedAcceptanceGate({
    demand: attempt.acceptanceDemand || dispatch?.acceptanceDemand,
    publicInfoEvidence: publicInfoGateEvidence(snapshot.web, outputText, true),
    providerEvidence: {
      invocationValid: attempt.providerInvocationEvidenceValid === true,
      mode: attempt.providerMode || providerAttempt.mode || run?.aiMode || null,
      model: attempt.providerModel || providerAttempt.model || run?.model || null,
      inputTokens: attempt.inputTokens || providerAttempt.usage?.inputTokens,
      outputTokens: attempt.outputTokens || providerAttempt.usage?.outputTokens,
      attempts: attempt.providerInvocationApiAttempts || attempt.providerAttempts?.length || 0,
    },
    dataAnalysisEvidence: {
      inputFactsMapped: attempt.inputEvidenceValid === true,
      semanticValid: attempt.localContractValid === true,
      analysisProduced: outputText.length > 0 && !businessResultLooksLikeAbilityList(outputText),
    },
    skillInvocationEvidence: {
      profileLoaded: attempt.contentProfileComplete === true,
      canonicalVerified:
        attempt.contentProfileChainValid === true &&
        attempt.contentProfileExecutionEvidence?.execution?.canonicalMatch === true,
      outputContractBound: attempt.contentProfileChainValid === true && Boolean(run?.contract),
      capabilityCount: Number(attempt.contentProfileExecutionEvidence?.api?.capabilityCount || 0),
      skillCount: Number(attempt.contentProfileExecutionEvidence?.api?.skillCount || 0),
    },
    businessResultEvidence: {
      primaryArtifactCount: Number(attempt.primaryArtifactCount || 0),
      outputChars: outputText.length,
      notAbilityList: businessResultLooksLikeAbilityList(outputText),
      resultHashValid: Boolean(attempt.resultHash),
      artifactHashValid: attempt.primaryArtifactHashValid === true,
    },
    approvalsBefore: attempt.approvalCountBefore,
    approvalsAfter: approvalAfter,
    inputRecorded: Boolean(dispatch?.requirement) && attempt.inputEvidenceValid === true,
    outputRecorded: outputText.length > 0 && Boolean(attempt.businessId),
    executionRecorded: Boolean(attempt.terminalStatus || run?.status),
    feeEvidenceRecorded:
      attempt.billingLinkValid === true &&
      ["settled", "released"].includes(String(attempt.billingState || "")),
  });
  return redactUnifiedGateForReport(gate);
}

function recoverDispatchByNonce(domain, idx, nonce) {
  const pattern = `%${String(nonce).replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const rows =
    domain === "restaurant"
      ? billingDb
          .prepare(
            `SELECT id,status FROM agent_tasks
             WHERE tenant_id=? AND requirement LIKE ? ESCAPE '\\'
             ORDER BY id`,
          )
          .all(tenantId, pattern)
      : billingDb
          .prepare(
            `SELECT id,status FROM content_employee_runs
             WHERE tenant_id=? AND employee_idx=?
               AND requirement LIKE ? ESCAPE '\\'
             ORDER BY id`,
          )
          .all(tenantId, idx, pattern);
  if (rows.length !== 1) return null;
  return {
    response: { headers: { get: () => null } },
    payload:
      domain === "restaurant"
        ? { taskId: Number(rows[0].id), status: rows[0].status, recovered: true }
        : { runId: Number(rows[0].id), status: rows[0].status, recovered: true },
  };
}

async function dispatchWithNonce(domain, idx, pathname, body, nonce) {
  try {
    return await request(pathname, {
      method: "POST",
      body,
      timeoutMs: 60_000,
    });
  } catch (error) {
    if (error?.code !== "MUTATION_RESULT_AMBIGUOUS") throw error;
    const recovered = recoverDispatchByNonce(domain, idx, nonce);
    if (recovered) return recovered;
    throw new Error(
      `${domain}:${idx}派活POST结果不明，且未能按唯一nonce从权威DB恢复；禁止透明重放`,
      { cause: error },
    );
  }
}

async function waitBilling(refType, refId, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = billingFromDatabase(refType, refId);
    if (latest?.billing_state === "settled") return latest;
    await sleep(Math.min(options.pollMs, 2_000));
  }
  return latest;
}

async function poll(pathname, ready, label) {
  const deadline = Date.now() + options.timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    if (stopped) {
      const error = new Error(`${label}已安全中断，保留业务ID供下次续跑`);
      error.code = "MATRIX_INTERRUPTED";
      throw error;
    }
    latest = (await request(pathname, { timeoutMs: 20_000 })).payload;
    if (ready(latest)) return latest;
    await sleep(options.pollMs);
  }
  throw new Error(
    `${label}等待超时（${options.timeoutMs}ms）：${JSON.stringify(latest)?.slice(0, 500)}`,
  );
}

function localTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return Number.NaN;
  return Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(raw)
      ? raw.replace(" ", "T")
      : raw,
  );
}

function billingFields(billing, refType, refId, dispatchedAt, baseline) {
  const billingLinkValid =
    String(billing?.ref_type || "") === String(refType) &&
    Number(billing?.ref_id) === Number(refId) &&
    Number(billing?.hold_count) === 1 &&
    Number(billing?.credit_log_count) === 1 &&
    Number(billing?.hold_log_id) === Number(billing?.log_id);
  const billingCreatedAt =
    billing?.hold_created_at || billing?.log_created_at || null;
  const billingTimestamp = localTimestamp(billingCreatedAt);
  const dispatchTimestamp = Date.parse(String(dispatchedAt || ""));
  const billingFreshForAttempt =
    Number.isFinite(billingTimestamp) &&
    Number.isFinite(dispatchTimestamp) &&
    billingTimestamp >= dispatchTimestamp - 120_000 &&
    billingTimestamp <= Date.now() + 120_000;
  const rawChargedCostYuan =
    billing?.cost_yuan == null ? null : Number(billing.cost_yuan);
  const chargedCostYuan =
    Number.isFinite(rawChargedCostYuan) && rawChargedCostYuan >= 0
      ? rawChargedCostYuan
      : null;
  const currentTenantBalance = Number(
    billingDb.prepare("SELECT credits FROM tenants WHERE id=?").get(tenantId)
      ?.credits,
  );
  const baselineHoldId = Number(baseline?.holdId);
  const baselineBalance = Number(baseline?.balance);
  const targetHoldId = Number(billing?.hold_id);
  const targetSettledAt = localTimestamp(billing?.hold_settled_at);
  const balanceWindowRows = Number.isSafeInteger(baselineHoldId)
    ? billingDb
        .prepare(
          `SELECT id,status,held_credits,settled_credits,created_at,settled_at
           FROM credit_holds
           WHERE tenant_id=? AND id>?
           ORDER BY id`,
        )
        .all(tenantId, baselineHoldId)
    : [];
  let balanceWindowInvalidCount = 0;
  let balanceWindowAmbiguousTimestampCount = 0;
  let balanceWindowCurrentDebit = 0;
  let balanceWindowSettlementDebit = 0;
  let balanceWindowTargetCount = 0;
  for (const row of balanceWindowRows) {
    const held = Number(row.held_credits);
    const settled = Number(row.settled_credits);
    const createdAt = localTimestamp(row.created_at);
    const settledAt = localTimestamp(row.settled_at);
    const isSettled = row.status === "settled";
    const valid =
      ["held", "settled"].includes(String(row.status || "")) &&
      Number.isSafeInteger(held) &&
      held >= 0 &&
      (!isSettled ||
        (Number.isSafeInteger(settled) && settled >= 0 && settled <= held)) &&
      Number.isFinite(createdAt) &&
      (!isSettled || Number.isFinite(settledAt));
    if (!valid) {
      balanceWindowInvalidCount += 1;
      continue;
    }
    if (Number(row.id) === targetHoldId) balanceWindowTargetCount += 1;
    balanceWindowCurrentDebit += isSettled ? settled : held;
    if (Number.isFinite(targetSettledAt)) {
      if (
        Number(row.id) !== targetHoldId &&
        createdAt === targetSettledAt
      ) {
        // SQLite timestamps are second-granularity. A different hold created in
        // the exact target settlement second cannot be ordered safely, so fail
        // closed instead of guessing whether it affected balance_after.
        balanceWindowAmbiguousTimestampCount += 1;
      }
      if (createdAt <= targetSettledAt) {
        balanceWindowSettlementDebit +=
          isSettled && settledAt <= targetSettledAt ? settled : held;
      }
    }
  }
  const balanceWindowValid =
    Number.isFinite(baselineBalance) &&
    Number.isFinite(targetSettledAt) &&
    balanceWindowInvalidCount === 0 &&
    balanceWindowAmbiguousTimestampCount === 0 &&
    balanceWindowTargetCount === 1;
  return {
    billingId: billing?.hold_id == null ? null : Number(billing.hold_id),
    creditLogId: billing?.log_id == null ? null : Number(billing.log_id),
    tenantId,
    userId,
    billingTenantId:
      billing?.hold_tenant_id == null ? null : Number(billing.hold_tenant_id),
    creditLogTenantId:
      billing?.log_tenant_id == null ? null : Number(billing.log_tenant_id),
    billingUserId:
      billing?.hold_user_id == null ? null : Number(billing.hold_user_id),
    creditLogUserId:
      billing?.log_user_id == null ? null : Number(billing.log_user_id),
    billingHoldLogId:
      billing?.hold_log_id == null ? null : Number(billing.hold_log_id),
    billingHoldCount: Number(billing?.hold_count || 0),
    billingCreditLogCount: Number(billing?.credit_log_count || 0),
    billingState: billing?.billing_state || null,
    heldCredits: Number(billing?.held_credits) || 0,
    settledCredits: Number(billing?.settled_credits) || 0,
    model: billing?.log_model || null,
    inputTokens: Number(billing?.input_tokens) || 0,
    outputTokens: Number(billing?.output_tokens) || 0,
    chargedCostYuan,
    // Deprecated compatibility alias: this is customer ledger charge, not
    // provider/cloud cost. Provider cost is estimated from provider usage.
    costYuan: chargedCostYuan ?? 0,
    costYuanDeprecated: true,
    costYuanDeprecatedMeaning: "alias_of_chargedCostYuan_customer_ledger",
    chargedCredits: Number(billing?.charged_credits) || 0,
    balanceAfter:
      billing?.balance_after == null ? null : Number(billing.balance_after),
    billingAiMode: billing?.ai_mode || null,
    billingModel: billing?.log_model || null,
    billingHoldModel: billing?.hold_model || null,
    creditLogModel: billing?.log_model || null,
    billingFeature: billing?.hold_feature || null,
    creditLogFeature: billing?.log_feature || null,
    billingKind: billing?.hold_kind || null,
    creditLogKind: billing?.log_kind || null,
    creditLogCredits: Number(billing?.charged_credits) || 0,
    billingInputTokens: Number(billing?.input_tokens) || 0,
    billingOutputTokens: Number(billing?.output_tokens) || 0,
    billingRefType: billing?.ref_type || null,
    billingRefId: Number(billing?.ref_id) || null,
    billingLinkValid,
    billingCreatedAt,
    billingFreshForAttempt,
    balanceBefore:
      baseline?.balance == null ? null : Number(baseline.balance),
    tenantBalance: Number.isFinite(currentTenantBalance)
      ? currentTenantBalance
      : null,
    billingBaselineHoldId:
      baseline?.holdId == null ? null : Number(baseline.holdId),
    billingBaselineLogId:
      baseline?.logId == null ? null : Number(baseline.logId),
    billingBalanceWindowHoldCount: balanceWindowRows.length,
    billingBalanceWindowConcurrentHoldCount: Math.max(
      0,
      balanceWindowRows.length - balanceWindowTargetCount,
    ),
    billingBalanceWindowInvalidCount: balanceWindowInvalidCount,
    billingBalanceWindowAmbiguousTimestampCount:
      balanceWindowAmbiguousTimestampCount,
    billingBalanceWindowTargetCount: balanceWindowTargetCount,
    billingBalanceWindowCurrentDebit: balanceWindowCurrentDebit,
    billingBalanceWindowSettlementDebit: balanceWindowSettlementDebit,
    billingExpectedCurrentBalance: balanceWindowValid
      ? baselineBalance - balanceWindowCurrentDebit
      : null,
    billingExpectedSettlementBalance: balanceWindowValid
      ? baselineBalance - balanceWindowSettlementDebit
      : null,
    billingTargetSettledAt: billing?.hold_settled_at || null,
  };
}

const RECONCILED_BILLING_WINDOW_FIELDS = Object.freeze([
  "tenantBalance",
  "billingBalanceWindowHoldCount",
  "billingBalanceWindowConcurrentHoldCount",
  "billingBalanceWindowInvalidCount",
  "billingBalanceWindowAmbiguousTimestampCount",
  "billingBalanceWindowTargetCount",
  "billingBalanceWindowCurrentDebit",
  "billingBalanceWindowSettlementDebit",
  "billingExpectedCurrentBalance",
  "billingExpectedSettlementBalance",
  "billingTargetSettledAt",
]);

function positiveSafeInteger(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0
    ? normalized
    : null;
}

function exactExistingAttempt(job) {
  const slot = state.jobs?.[job.key];
  const latest = slot?.latest;
  const attempts = Array.isArray(slot?.attempts) ? slot.attempts : [];
  const last = attempts.at(-1);
  if (!latest || typeof latest !== "object" || Array.isArray(latest)) {
    throw new Error(`${job.key}断点缺少latest证据`);
  }
  if (!last || typeof last !== "object" || Array.isArray(last)) {
    throw new Error(`${job.key}断点缺少最后一条attempt证据`);
  }
  const attemptId = String(latest.attemptId || "").trim();
  if (!attemptId || String(last.attemptId || "").trim() !== attemptId) {
    throw new Error(`${job.key}的latest与最后attempt身份不一致`);
  }
  if (
    latest.domain !== job.domain ||
    Number(latest.idx) !== Number(job.idx) ||
    last.domain !== job.domain ||
    Number(last.idx) !== Number(job.idx)
  ) {
    throw new Error(`${job.key}断点的岗位身份不一致`);
  }
  const businessId = positiveSafeInteger(latest.businessId);
  if (!businessId || Number(last.businessId) !== businessId) {
    throw new Error(`${job.key}断点缺少一致的businessId`);
  }
  const invocation = validateAttemptInvocation(state, latest);
  if (!invocation.valid) {
    throw new Error(
      `${job.key}断点的原始真实调用证据不完整：${invocation.errors.join("；")}`,
    );
  }
  const expectedRefType =
    job.domain === "restaurant" ? "agent_task" : "content_employee_run";
  const tenant = positiveSafeInteger(latest.tenantId);
  const user = positiveSafeInteger(latest.userId);
  const billingId = positiveSafeInteger(latest.billingId);
  const creditLogId = positiveSafeInteger(latest.creditLogId);
  if (!tenant || !user || !billingId || !creditLogId) {
    throw new Error(`${job.key}断点缺少租户、用户、hold或credit log ID`);
  }
  if (
    latest.billingRefType !== expectedRefType ||
    Number(latest.billingRefId) !== businessId
  ) {
    throw new Error(`${job.key}断点的账务ref与业务ID不一致`);
  }
  const baseline = latest.ledgerBaseline;
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    throw new Error(`${job.key}断点缺少派活前权威账本基线`);
  }
  if (
    !Number.isFinite(Number(baseline.balance)) ||
    !Number.isSafeInteger(Number(baseline.holdId)) ||
    Number(baseline.holdId) < 0 ||
    !Number.isSafeInteger(Number(baseline.logId)) ||
    Number(baseline.logId) < 0 ||
    Number(latest.balanceBefore) !== Number(baseline.balance) ||
    Number(latest.billingBaselineHoldId) !== Number(baseline.holdId) ||
    Number(latest.billingBaselineLogId) !== Number(baseline.logId) ||
    billingId <= Number(baseline.holdId) ||
    creditLogId <= Number(baseline.logId)
  ) {
    throw new Error(`${job.key}断点的派活前账本基线缺失或已被篡改`);
  }
  return {
    job,
    slot,
    latest,
    attempts,
    attemptId,
    businessId,
    expectedRefType,
    tenant,
    user,
    billingId,
    creditLogId,
    baseline,
  };
}

function assertAuthoritativeBillingIdentity(candidate, billing) {
  const { job, latest } = candidate;
  if (billing?.authority_error) {
    throw new Error(
      `${job.key}权威DB账务不唯一：${billing.authority_error}`,
    );
  }
  const exact =
    Number(billing?.hold_id) === candidate.billingId &&
    Number(billing?.log_id) === candidate.creditLogId &&
    Number(billing?.hold_log_id) === candidate.creditLogId &&
    Number(billing?.hold_count) === Number(latest.billingHoldCount) &&
    Number(billing?.credit_log_count) ===
      Number(latest.billingCreditLogCount) &&
    Number(billing?.hold_tenant_id) === candidate.tenant &&
    Number(billing?.log_tenant_id) === candidate.tenant &&
    Number(billing?.hold_user_id) === candidate.user &&
    Number(billing?.log_user_id) === candidate.user &&
    Number(latest.billingTenantId) === candidate.tenant &&
    Number(latest.creditLogTenantId) === candidate.tenant &&
    Number(latest.billingUserId) === candidate.user &&
    Number(latest.creditLogUserId) === candidate.user &&
    Number(latest.billingHoldLogId) === candidate.creditLogId &&
    String(billing?.ref_type || "") === candidate.expectedRefType &&
    Number(billing?.ref_id) === candidate.businessId &&
    String(billing?.billing_state || "") ===
      String(latest.billingState || "") &&
    Number(billing?.held_credits) === Number(latest.heldCredits) &&
    Number(billing?.balance_after) === Number(latest.balanceAfter) &&
    Number(billing?.charged_credits) === Number(latest.chargedCredits) &&
    Number(billing?.charged_credits) === Number(latest.creditLogCredits) &&
    Number(billing?.settled_credits) === Number(latest.settledCredits) &&
    Number(billing?.input_tokens) === Number(latest.billingInputTokens) &&
    Number(billing?.output_tokens) === Number(latest.billingOutputTokens) &&
    String(billing?.ai_mode || "") === String(latest.billingAiMode || "") &&
    latest.billingLinkValid === true &&
    latest.billingFreshForAttempt === true &&
    String(billing?.log_model || "") === String(latest.billingModel || "") &&
    String(billing?.hold_model || "") ===
      String(latest.billingHoldModel || "") &&
    String(billing?.hold_feature || "") ===
      String(latest.billingFeature || "") &&
    String(billing?.log_feature || "") ===
      String(latest.creditLogFeature || "") &&
    String(billing?.hold_kind || "") === String(latest.billingKind || "") &&
    String(billing?.log_kind || "") === String(latest.creditLogKind || "");
  if (!exact) {
    throw new Error(`${job.key}断点账务身份与权威DB不一致`);
  }
}

function rebuildExistingBillingEvidence(candidate) {
  const billing = billingFromDatabase(
    candidate.expectedRefType,
    candidate.businessId,
  );
  assertAuthoritativeBillingIdentity(candidate, billing);
  const rebuilt = billingFields(
    billing,
    candidate.expectedRefType,
    candidate.businessId,
    candidate.latest.dispatchedAt,
    candidate.baseline,
  );
  const window = Object.fromEntries(
    RECONCILED_BILLING_WINDOW_FIELDS.map((field) => [field, rebuilt[field]]),
  );
  let webResearchEvidence = candidate.latest.webResearchEvidence || null;
  if (!webResearchEvidence) {
    const webTable = candidate.expectedRefType === "agent_task" ? "agent_tasks" : "content_employee_runs";
    const webColumn = candidate.expectedRefType === "agent_task" ? "employee_web_snapshot" : "snapshot_json";
    try {
      const raw = billingDb
        .prepare(`SELECT ${webColumn} snapshot FROM ${webTable} WHERE tenant_id=? AND id=?`)
        .get(candidate.tenant, candidate.businessId)?.snapshot;
      const parsed = raw ? JSON.parse(String(raw)) : null;
      const web = candidate.expectedRefType === "agent_task"
        ? parsed?.web || parsed?.webEvidence || null
        : parsed?.web || null;
      webResearchEvidence = summarizeWebResearchEvidence(web);
    } catch {
      webResearchEvidence = null;
    }
  }
  const refreshed = {
    ...candidate.latest,
    ...window,
    ...(webResearchEvidence ? { webResearchEvidence } : {}),
    billingReconciliation: {
      mode: "sqlite_read_only",
      reconciledAt: new Date().toISOString(),
      databaseIdentity,
      refType: candidate.expectedRefType,
      businessId: candidate.businessId,
      httpRequestCount: 0,
      providerCallCount: 0,
      businessMutationCount: 0,
    },
  };
  const classified = classifyAttempt(refreshed);
  return applyProviderCostSemantics(
    { ...refreshed, ...classified },
    state.providerPricingSnapshot ||
      state.runtimeEvidence?.providerPricingSnapshot ||
      null,
  );
}

function reconcileExistingEvidence() {
  const candidates = selectedJobs.map(exactExistingAttempt);
  const tenantIds = new Set(candidates.map((item) => item.tenant));
  const userIds = new Set(candidates.map((item) => item.user));
  if (tenantIds.size !== 1 || userIds.size !== 1) {
    throw new Error(
      "--reconcile-only 一次只允许处理同一租户、同一执行用户的断点证据",
    );
  }
  tenantId = [...tenantIds][0];
  userId = [...userIds][0];
  assertDedicatedMatrixMarker();

  // 先全部读取并校验，再一次性替换内存状态；任一岗身份不合
  // 法都会在persistState之前fail closed，不留下半份重建报告。
  const judgedRows = candidates.map(rebuildExistingBillingEvidence);
  if (httpRequestCount !== 0) {
    throw new Error("--reconcile-only 检测到HTTP请求，已拒绝落盘");
  }
  candidates.forEach((candidate, index) => {
    const judged = judgedRows[index];
    const lastIndex = candidate.attempts.length - 1;
    candidate.slot.latest = judged;
    candidate.slot.attempts[lastIndex] = judged;
  });
  const invocation = state.run?.invocations?.find(
    (item) => item.id === invocationId,
  );
  if (invocation) {
    invocation.finishedAt = new Date().toISOString();
    invocation.reconciledJobs = candidates.map((item) => item.job.key);
    invocation.httpRequestCount = 0;
    invocation.providerCallCount = 0;
    invocation.businessMutationCount = 0;
  }
  state.reconciliation = {
    mode: "sqlite_read_only",
    invocationId,
    reconciledAt: new Date().toISOString(),
    selectedJobs: candidates.map((item) => item.job.key),
    databaseIdentity,
    httpRequestCount: 0,
    providerCallCount: 0,
    businessMutationCount: 0,
  };
  persistState();
  return judgedRows;
}

function providerFields(providerAttempt) {
  return {
    providerMode: providerAttempt?.mode || null,
    providerModel: providerAttempt?.model || null,
    providerInputTokens: Number(providerAttempt?.usage?.inputTokens) || 0,
    providerOutputTokens: Number(providerAttempt?.usage?.outputTokens) || 0,
  };
}

function attachProviderEvidence(attempt) {
  const evidenced = {
    ...attempt,
    ...classifyProviderEvidence(attempt),
  };
  return applyProviderCostSemantics(evidenced, state.providerPricingSnapshot);
}

async function businessFlow(domain, id) {
  const type = domain === "restaurant" ? "restaurant_task" : "content_run";
  try {
    const result = await request(`/api/business-flow/${type}/${id}`);
    const nodes = Array.isArray(result.payload?.nodes)
      ? result.payload.nodes
      : [];
    const billingNode = nodes.find((node) => node?.kind === "billing");
    return {
      businessFlowStatus: result.payload?.status?.code || null,
      businessFlowTerminal: result.payload?.status?.terminal === true,
      businessFlowComplete:
        result.payload?.status?.complete === true ||
        result.payload?.status?.terminal === true,
      businessFlowNodeCount: nodes.length,
      businessFlowLinkCount: Array.isArray(result.payload?.links)
        ? result.payload.links.length
        : 0,
      businessFlowBillingSettled:
        /^积分已结算（实扣\s*[1-9]\d*(?:\.\d+)?）$/u.test(
          String(billingNode?.status || ""),
        ),
      businessFlowBillingNodeId: billingNode?.id || null,
    };
  } catch (error) {
    return {
      businessFlowStatus: null,
      businessFlowComplete: false,
      businessFlowError: error.message,
    };
  }
}

function chooseNativeVideoModel(config) {
  const routing = config?.routing || {};
  const listed = [
    ...(Array.isArray(routing.video) ? routing.video : []),
    routing.videoDefault,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const prices = config?.billing?.video || {};
  const allowed = listed.filter((model) =>
    /^MiniMax-Hailuo-(?:02|2\.3(?:-Fast)?)$/u.test(model),
  );
  const priced = allowed
    .map((model) => ({ model, price: Number(prices?.[model]) }))
    .filter((item) => Number.isFinite(item.price) && item.price > 0)
    .sort((left, right) => left.price - right.price || left.model.localeCompare(right.model));
  return {
    preferredModel: "MiniMax-Hailuo-2.3-Fast",
    selectedModel: priced[0]?.model || null,
    selectedPrice: priced[0]?.price || null,
    routingVideoModels: listed,
    allowedModels: allowed,
    pricedModels: priced,
  };
}

async function runNativeAiSalesVideo(job, existing) {
  const startedAt = existing?.startedAt || new Date().toISOString();
  let attempt = {
    ...(existing || {}),
    domain: job.domain,
    idx: job.idx,
    employeeId: job.key,
    attemptId: existing?.attemptId || crypto.randomUUID(),
    invocationId: existing?.invocationId || invocationId,
    resumedByInvocationId: existing ? invocationId : null,
    startedAt,
    phase: existing?.phase || "starting",
    businessId: Number(existing?.businessId) || null,
    acceptanceKind: "capability",
    nativeVideo: true,
    providerEvidence: "unverified",
    externalPublish: false,
  };
  try {
    const profile = (
      await request("/api/employee-workbench/content/10")
    ).payload;
    attempt.employeeKey = profile.identity?.key || "commerce_video";
    attempt.employeeName = profile.identity?.name || "AI带货员";
    attempt.profileVersion = profile.provenance?.profileVersion || null;
    attempt.contentProfileComplete = Number(profile.identity?.idx) === 10;
    attempt.contentProfileEvidence = {
      complete: attempt.contentProfileComplete,
      employeeIdx: Number(profile.identity?.idx) || null,
      employeeKey: profile.identity?.key || null,
    };
    attempt.contentProfileChainValid = attempt.contentProfileComplete;

    const configResponse = await request("/api/admin/api-config");
    const config = configResponse.payload || {};
    const channel = config.channel || {};
    const modelChoice = chooseNativeVideoModel(config);
    const channelReady =
      channel.available === true &&
      channel.readiness?.connected === true &&
      /云雾|yunwu/iu.test(String(channel.provider || "")) &&
      isOfficialYunwuBaseUrl(channel.baseUrl);
    const modelReady = Boolean(modelChoice.selectedModel);
    const model = modelChoice.selectedModel || modelChoice.preferredModel;
    const priceReady = Number.isFinite(Number(modelChoice.selectedPrice)) && modelChoice.selectedPrice > 0;
    const videoModels = await request("/api/content/video-models").catch(() => ({ payload: null }));
    const videoModelRows = Array.isArray(videoModels.payload?.models)
      ? videoModels.payload.models
      : Array.isArray(videoModels.payload)
        ? videoModels.payload
        : [];
    const modelMetadata = videoModelRows.find((row) => String(row?.id || row?.model || "") === model) || null;
    const synthesizerReady = modelMetadata?.supported === true || videoModels.payload == null;
    const videoGateReasons = [];
    if (!channelReady) videoGateReasons.push("云雾通道未同时满足available、recent verification、official base URL安全门");
    if (!modelReady) videoGateReasons.push("当前视频路由没有已允许且已核价的MiniMax海螺模型");
    if (!priceReady) videoGateReasons.push(`模型${model}没有正数视频价格配置`);
    if (!synthesizerReady) videoGateReasons.push(`模型${model}的服务端合成器/模型元数据未就绪`);
    attempt.videoGate = {
      channelReady,
      modelReady,
      priceReady,
      synthesizerReady,
      chosenModel: model,
      chosenPrice: modelChoice.selectedPrice,
      routingVideoModels: modelChoice.routingVideoModels,
      pricedModels: modelChoice.pricedModels,
    };
    attempt.videoGateReasons = videoGateReasons;
    attempt.providerModel = model;
    attempt.providerMode = channelReady && modelReady && priceReady && synthesizerReady ? "api" : null;
    attempt.nativeVideoModel = model;
    attempt.nativeVideoInput = {
      brief: "把已确认的招牌菜与到店动作做成30秒竖版带货视频；不写未核验价格、功效、评价或库存。",
      referenceImage: "deterministic_fixture_png",
    };
    attempt.acceptanceDemand =
      "请把已确认的招牌菜与到店动作整理成一份可审阅的30秒竖版带货成片。";
    attempt.acceptanceGatePlan = {
      schema: "nanowork.unified-acceptance-gate.v1",
      policy: {
        approvalPolicy: "boss_test_zero_approvals",
        requiredApprovalDelta: 0,
        noExternalSideEffect: true,
        publicInfoRequired: false,
      },
      demand: { text: attempt.acceptanceDemand, sentence: true },
      checks: [],
    };

    if (!attempt.businessId) {
      const fixture = buildDeterministicVisionFixturePng();
      const nonce = `real-native-video-${crypto.randomUUID()}`;
      const baseline = ledgerBaseline();
      const approvalCountBefore = approvalCountForTenant();
      const uploaded = await request("/api/files/upload", {
        method: "POST",
        body: {
          name: `${nonce}.png`,
          b64: fixture.toString("base64"),
          mime: "image/png",
          purpose: "real-employee-matrix-native-video",
          recognize: false,
        },
        timeoutMs: 60_000,
      });
      const fileId = Number(uploaded.payload?.file?.id);
      if (!Number.isSafeInteger(fileId) || fileId <= 0) {
        throw new Error("AI带货员参考图上传后不可读");
      }
      const dispatchedAt = Date.now();
      const dispatch = await request("/api/content/ai-sales-video", {
        method: "POST",
        body: {
          brief: attempt.nativeVideoInput.brief,
          model,
          fileIds: [fileId],
        },
        timeoutMs: 60_000,
      });
      const payload = dispatch.payload || {};
      attempt = {
        ...attempt,
        nonce,
        fileId,
        ledgerBaseline: baseline,
        approvalCountBefore,
        inputEvidenceValid: true,
        businessId: Number(payload.jobId),
        initialStatus: payload.status || null,
        requestId: dispatch.response.headers.get("x-request-id"),
        dispatchedAt: new Date(dispatchedAt).toISOString(),
        phase: payload.status === "blocked" ? "blocked" : "dispatched",
      };
      if (!Number.isSafeInteger(attempt.businessId) || attempt.businessId <= 0) {
        throw new Error("AI带货员响应缺少有效media job id");
      }
      setInProgress(job.key, attempt);
    }

    const deadline = Date.now() + options.timeoutMs;
    let media = null;
    while (Date.now() < deadline) {
      media = (await request(`/api/content/media-jobs/${attempt.businessId}`, { timeoutMs: 20_000 })).payload;
      const mediaStatus = String(media?.status || "").toLowerCase();
      if (!["处理中", "processing", "生成中", "pending", "running"].includes(mediaStatus)) break;
      await sleep(options.pollMs);
    }
    if (!media) throw new Error("AI带货员媒体任务未返回状态");
    let snapshot = null;
    try {
      snapshot = JSON.parse(String(media.snapshot_json || ""));
    } catch {
      snapshot = null;
    }
    const blockedMedia = media.status === "阻塞" || media.status === "blocked" || snapshot?.status === "阻塞";
    const billing = blockedMedia
      ? null
      : await waitBilling("media_job", attempt.businessId);
    const billed = billingFields(
      billing,
      "media_job",
      attempt.businessId,
      attempt.dispatchedAt,
      attempt.ledgerBaseline,
    );
    const result = snapshot?.result || {};
    const composition = result?.composition || {};
    const providerCalls = Number(result?.providerCalls || snapshot?.providerCalls || 0);
    attempt = {
      ...attempt,
      phase: "generated",
      nativeVideoStatus: media.status || snapshot?.status || null,
      generationStatus: media.status || null,
      nativeVideoBlocked: media.status === "阻塞" || snapshot?.status === "阻塞" || media.status === "blocked",
      nativeVideoProviderCalls: providerCalls,
      providerCallCount: providerCalls,
      nativeVideoComposition: {
        durationSeconds: Number(composition.durationSeconds || result.durationSeconds || snapshot?.durationSeconds || 0),
        width: Number(composition.width || 0) || null,
        height: Number(composition.height || 0) || null,
        segmentCount: Number(composition.segmentCount || result.segments?.length || snapshot?.segmentCount || 0),
        sha256: composition.sha256 || null,
      },
      nativeVideoSnapshot: snapshot
        ? {
            status: snapshot.status || null,
            reason: snapshot.reason || snapshot.blockedReason || null,
            workflow: snapshot.workflow || null,
            segmentCount: Number(snapshot.segmentCount || snapshot.segments?.length || 0),
            resultStatus: result.status || null,
          }
        : null,
      contractValid:
        snapshot?.workflow === "ai_sales_video" &&
        Number(snapshot?.durationSeconds || 0) === 30 &&
        Array.isArray(snapshot?.segments) &&
        snapshot.segments.length >= 2,
      localContractValid: true,
      primaryArtifactHashValid: media.status === "成功" ? Boolean(composition.sha256) : false,
      artifactReadbackValid: media.status === "成功" ? Boolean(media.url) : false,
      billingModel: billed.billingModel || model,
      model: billed.model || model,
      inputTokens: billed.inputTokens,
      outputTokens: billed.outputTokens,
      ...billed,
      latencyMs: Date.now() - Date.parse(startedAt),
      resultHash: snapshot ? crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") : null,
      resultChars: snapshot ? JSON.stringify(snapshot).length : 0,
      terminalStatus: media.status || snapshot?.status || "失败",
      businessFlowStatus: null,
      businessFlowComplete: media.status === "成功" || media.status === "阻塞",
      businessFlowTerminal: media.status === "成功" || media.status === "阻塞",
      businessFlowBillingSettled: billing?.billing_state === "settled",
    };
    const approvalCountAfter = approvalCountForTenant();
    attempt.approvalCountAfter = approvalCountAfter;
    attempt.approvalDelta =
      Number.isFinite(Number(attempt.approvalCountBefore)) &&
      Number.isFinite(Number(approvalCountAfter))
        ? Number(approvalCountAfter) - Number(attempt.approvalCountBefore)
        : null;
    const videoOutputText = snapshot ? JSON.stringify(snapshot) : "";
    attempt.unifiedGate = redactUnifiedGateForReport(
      evaluateUnifiedAcceptanceGate({
        demand: attempt.acceptanceDemand,
        publicInfoEvidence: { required: false, attempted: false, ok: false, citedUrlCount: 0, userQuestioned: false },
        providerEvidence: {
          invocationValid: attempt.nativeVideoBlocked !== true && Number(providerCalls) > 0,
          mode: attempt.providerMode || null,
          model: attempt.model || model,
          inputTokens: attempt.inputTokens,
          outputTokens: attempt.outputTokens,
          attempts: providerCalls,
        },
        dataAnalysisEvidence: {
          inputFactsMapped: attempt.inputEvidenceValid === true,
          semanticValid: attempt.contractValid === true,
          analysisProduced: videoOutputText.length > 0,
        },
        skillInvocationEvidence: {
          profileLoaded: attempt.contentProfileComplete === true,
          canonicalVerified: attempt.contentProfileChainValid === true,
          outputContractBound: attempt.contractValid === true,
          capabilityCount: 0,
          skillCount: 0,
        },
        businessResultEvidence: {
          primaryArtifactCount: attempt.nativeVideoStatus === "成功" ? 1 : 0,
          outputChars: videoOutputText.length,
          notAbilityList: videoOutputText.length > 0,
          resultHashValid: Boolean(attempt.resultHash),
          artifactHashValid: attempt.primaryArtifactHashValid === true && attempt.artifactReadbackValid === true,
        },
        approvalsBefore: attempt.approvalCountBefore,
        approvalsAfter: approvalCountAfter,
        inputRecorded: attempt.inputEvidenceValid === true,
        outputRecorded: videoOutputText.length > 0,
        executionRecorded: Boolean(attempt.terminalStatus),
        feeEvidenceRecorded: attempt.nativeVideoBlocked === true || attempt.billingState === "settled",
      }),
    );
    setInProgress(job.key, attempt);
    return finalizeAttempt(job.key, attempt);
  } catch (error) {
    if (error.code === "MATRIX_INTERRUPTED") {
      attempt.interruptedAt = new Date().toISOString();
      attempt.verdict = "IN_PROGRESS";
      setInProgress(job.key, attempt);
      return attempt;
    }
    const failedJobId = Number(error?.payload?.jobId);
    if (!attempt.businessId && Number.isSafeInteger(failedJobId) && failedJobId > 0) {
      attempt.businessId = failedJobId;
    }
    attempt.phase = "failed";
    attempt.httpError = error.message;
    attempt.nativeVideoStatus = "失败";
    attempt.nativeVideoBlocked = false;
    attempt.terminalStatus ||= "失败";
    attempt.latencyMs = Date.now() - Date.parse(startedAt);
    return finalizeAttempt(job.key, attempt);
  }
}

async function runRestaurant(job, existing) {
  const startedAt = existing?.startedAt || new Date().toISOString();
  let attempt = {
    ...(existing || {}),
    domain: job.domain,
    idx: job.idx,
    employeeId: job.key,
    attemptId: existing?.attemptId || crypto.randomUUID(),
    invocationId: existing?.invocationId || invocationId,
    resumedByInvocationId: existing ? invocationId : null,
    startedAt,
    phase: existing?.phase || "starting",
    businessId: Number(existing?.businessId) || null,
    providerEvidence: "unverified",
    acceptanceKind: "capability",
    externalPublish: false,
    acceptanceDemand:
      existing?.acceptanceDemand ||
      (Number(job.idx) === 102
        ? "请围绕“毛血旺 太原吾悦广场”核验竞品与商圈画像，给出下一步可执行的业务结论。"
        : `请围绕餐饮员工${job.idx}本次岗位任务核验公开信息并给出下一步可执行的业务结论。`),
    acceptanceGatePlan:
      existing?.acceptanceGatePlan ||
      buildUnifiedAcceptancePlan({
        demand:
          Number(job.idx) === 102
            ? "请围绕“毛血旺 太原吾悦广场”核验竞品与商圈画像，给出下一步可执行的业务结论。"
            : `请围绕餐饮员工${job.idx}本次岗位任务核验公开信息并给出下一步可执行的业务结论。`,
        publicInfoRequired: true,
      }),
  };
  try {
    const profile = (
      await request(`/api/employee-workbench/restaurant/${job.idx}`)
    ).payload;
    attempt.employeeKey = profile.identity?.key || null;
    attempt.employeeName = profile.identity?.name || null;
    attempt.profileVersion = profile.jobProfile?.profileVersion || null;
    if (!attempt.businessId) {
      const nonce = `real-restaurant-${job.idx}-${crypto.randomUUID()}`;
      const dispatchedAt = Date.now();
      const dispatchInput = buildRestaurantDispatch(profile, nonce);
      const baseline = ledgerBaseline();
      const approvalCountBefore = approvalCountForTenant();
      const inputEvidence = validateRestaurantDispatchEvidence(
        dispatchInput,
        profile,
      );
      if (!inputEvidence.valid) {
        throw new Error(
          `餐饮岗位输入材料未通过确定性校验：${inputEvidence.errors.join("；")}`,
        );
      }
      const dispatch = await dispatchWithNonce(
        "restaurant",
        job.idx,
        `/api/employee-workbench/restaurant/${job.idx}/dispatch`,
        dispatchInput,
        nonce,
      );
      attempt = {
        ...attempt,
        nonce,
        ledgerBaseline: baseline,
        approvalCountBefore,
        taskTitle: dispatchInput.title,
        acceptanceDemand: dispatchInput.acceptanceDemand,
        acceptanceGatePlan: dispatchInput.acceptanceGatePlan,
        acceptanceDemandValid: dispatchInput.acceptanceDemandValid === true,
        inputEvidenceValid: true,
        qaCapabilityRunnable: inputEvidence.qaCapabilityRunnable === true,
        operationalReady: inputEvidence.operationalReady === true,
        operationalBlockReasons: inputEvidence.operationalBlockReasons,
        operationalErrors: inputEvidence.operationalErrors,
        businessId: Number(dispatch.payload?.taskId),
        initialStatus: dispatch.payload?.status || null,
        requestId: dispatch.response.headers.get("x-request-id"),
        dispatchedAt: new Date(dispatchedAt).toISOString(),
        phase: "dispatched",
      };
      if (!Number.isSafeInteger(attempt.businessId) || attempt.businessId <= 0)
        throw new Error("派活响应缺少有效taskId");
      setInProgress(job.key, attempt);
    }
    const pending = await poll(
      `/api/marshals/tasks/${attempt.businessId}/status`,
      (payload) => payload?.status !== "生成中",
      job.key,
    );
    const contract = pending.executionSnapshot?.outputContract || null;
    // status 接口已对 boss/admin/platform_super 返回后端落库的安全账本。
    // runner 立即做第二次严格白名单投影并先写断点，即使后续账务
    // 查询失败，也不会丢掉“共调用几轮、为何失败”的可解释证据。
    const providerAttempts = projectProviderAttempts(
      contract?.providerAttempts,
    );
    attempt.providerAttempts = providerAttempts;
    attempt.providerBudget = projectProviderBudget(contract?.providerBudget);
    attempt.providerAttemptSummary =
      summarizeProviderAttempts(providerAttempts);
    setInProgress(job.key, attempt);
    const billing = await waitBilling("agent_task", attempt.businessId);
    const reportFirst = isRestaurantMatrixReportFirstContract(contract);
    const structuredSemantic = reportFirst
      ? null
      : validateRestaurantEmployeeOutputContract(
          job.idx,
          contract?.parsedOutput,
          {
            task: {
              title: pending.title || attempt.taskTitle,
              requirement: pending.requirement,
            },
          },
        );
    const outputEvidence = evaluateRestaurantMatrixOutputEvidence({
      contract,
      outputBody: pending.output_body,
      structuredSemantic,
    });
    const semantic = {
      valid: outputEvidence.semanticValid,
      errors: outputEvidence.semanticErrors,
      artifacts: Array.isArray(structuredSemantic?.artifacts)
        ? structuredSemantic.artifacts
        : [],
    };
    const providerAttempt = pending.executionSnapshot?.providerAttempt || null;
    const billed = billingFields(
      billing,
      "agent_task",
      attempt.businessId,
      attempt.dispatchedAt,
      attempt.ledgerBaseline,
    );
    attempt = attachProviderEvidence({
      ...attempt,
      phase: "generated",
      generationStatus: pending.status || null,
      outputId: Number(pending.output_id) || null,
      aiMode:
        pending.ai_mode || providerAttempt?.mode || billing?.ai_mode || null,
      contractValid: contract?.valid === true,
      semanticValid: semantic.valid === true,
      semanticErrors: semantic.valid ? [] : semantic.errors.slice(0, 20),
      analysisProduced: outputEvidence.analysisProduced === true,
      qualityMode: outputEvidence.qualityMode,
      reportFirstMarkdown: outputEvidence.reportFirstMarkdown,
      structuredReportFirst: outputEvidence.structuredReportFirst,
      hardDeliveryValid: outputEvidence.hardDeliveryValid,
      contractErrors: [
        contract?.blocked,
        contract?.skipped,
        ...(Array.isArray(contract?.errors) ? contract.errors : []),
      ]
        .filter(Boolean)
        .map(String),
      contractRepair: contract?.repair || null,
      artifactCount: Array.isArray(contract?.artifacts)
        ? contract.artifacts.length
        : 0,
      primaryArtifactCount: Array.isArray(contract?.artifacts)
        ? contract.artifacts.filter((item) => item.primary === true).length
        : 0,
      resultHash: outputEvidence.resultHash,
      resultHashValid: outputEvidence.resultHashValid,
      localArtifactHash: outputEvidence.localArtifactHash,
      serverArtifactHash: outputEvidence.serverArtifactHash,
      serverProviderResponseHash: outputEvidence.serverProviderResponseHash,
      serverRenderedBodyHash: outputEvidence.serverRenderedBodyHash,
      artifactHashValid: outputEvidence.artifactHashValid,
      artifactHashSource: outputEvidence.artifactHashSource,
      artifactHashErrors: outputEvidence.artifactHashErrors,
      resultChars: String(pending.output_body || "").length,
      webResearchEvidence: summarizeWebResearchEvidence(
        pending.executionSnapshot?.webEvidence || pending.executionSnapshot?.web || null,
      ),
      latencyMs: Date.now() - Date.parse(startedAt),
      ...billed,
      ...providerFields(providerAttempt),
      model: billed.model || providerAttempt?.model || null,
      inputTokens:
        billed.inputTokens || Number(providerAttempt?.usage?.inputTokens) || 0,
      outputTokens:
        billed.outputTokens ||
        Number(providerAttempt?.usage?.outputTokens) ||
        0,
    });
    setInProgress(job.key, attempt);
    const capabilityQualityPass =
      attempt.generationStatus === "待审阅" &&
      attempt.aiMode === "api" &&
      attempt.providerInvocationEvidenceValid === true &&
      attempt.businessDeliveryBillingEvidenceValid === true &&
      attempt.contractValid &&
      attempt.semanticValid &&
      attempt.primaryArtifactCount === 1 &&
      attempt.resultHashValid === true &&
      attempt.artifactHashValid === true &&
      attempt.inputEvidenceValid === true &&
      attempt.billingState === "settled" &&
      attempt.inputTokens > 0 &&
      attempt.outputTokens > 0;
    attempt.capabilityQualityPass = capabilityQualityPass;
    const unifiedAcceptanceMode =
      attempt.acceptanceGatePlan?.schema === "nanowork.unified-acceptance-gate.v1";
    if (attempt.outputId && attempt.generationStatus === "待审阅" && !unifiedAcceptanceMode) {
      const decision =
        capabilityQualityPass && attempt.operationalReady === true
          ? "adopt"
          : "reject";
      const review = await request(
        `/api/marshals/outputs/${attempt.outputId}/review`,
        {
          method: "POST",
          body: {
            decision,
            reason:
              decision === "adopt"
                ? `真实云API能力验收与业务就绪门均通过 ${attempt.attemptId}`
                : capabilityQualityPass && attempt.operationalReady === false
                  ? `真实云API能力验收质量门通过，但业务证据未齐，禁止生产采纳：${attempt.operationalBlockReasons.join("|")}`.slice(
                      0,
                      1000,
                    )
                  : `真实云API能力验收未通过：${classifyAttempt({ ...attempt, reviewDecision: "reject" }).failureReasons.join("；")}`.slice(
                      0,
                      1000,
                    ),
          },
        },
      );
      attempt.reviewDecision = decision;
      attempt.reviewId = Number(review.payload?.approvalId) || null;
      attempt.assetId = Number(review.payload?.assetId) || null;
      attempt.knowledgeId = Number(review.payload?.knowledgeId) || null;
      attempt.phase = "reviewed";
    } else if (attempt.outputId && attempt.generationStatus === "待审阅" && unifiedAcceptanceMode) {
      // Boss test runs must never create a human approval row.  A production
      // auto-adopt route should settle the task before this point; if it does
      // not, retain the pending state as a truthful gate failure for diagnosis.
      attempt.reviewSuppressed = true;
    }
    const finalStatus = (
      await request(`/api/marshals/tasks/${attempt.businessId}/status`)
    ).payload;
    attempt.terminalStatus = finalStatus.status || attempt.generationStatus;
    attempt.outputStatus = finalStatus.output_status || null;
    attempt = {
      ...attempt,
      ...(await businessFlow(job.domain, attempt.businessId)),
    };
    const approvalCountAfter = approvalCountForTenant();
    attempt.approvalCountAfter = approvalCountAfter;
    attempt.approvalDelta =
      Number.isFinite(Number(attempt.approvalCountBefore)) &&
      Number.isFinite(Number(approvalCountAfter))
        ? Number(approvalCountAfter) - Number(attempt.approvalCountBefore)
        : null;
    attempt.unifiedGate = unifiedRestaurantGateEvidence({
      attempt,
      dispatch: buildRestaurantMatrixGateDispatch({ pending, attempt }),
      pending,
      contract,
      semantic,
      finalStatus,
      approvalAfter: approvalCountAfter,
    });
    return finalizeAttempt(job.key, attempt);
  } catch (error) {
    if (error.code === "MATRIX_INTERRUPTED") {
      attempt.interruptedAt = new Date().toISOString();
      attempt.verdict = "IN_PROGRESS";
      setInProgress(job.key, attempt);
      return attempt;
    }
    const failedRunId = Number(error?.payload?.runId || error?.payload?.taskId);
    if (
      !attempt.businessId &&
      Number.isSafeInteger(failedRunId) &&
      failedRunId > 0
    ) {
      attempt.businessId = failedRunId;
    }
    attempt.phase = "failed";
    attempt.httpError = error.message;
    if (!attempt.webResearchEvidence && error?.web) {
      attempt.webResearchEvidence = summarizeWebResearchEvidence(error.web);
    }
    attempt.terminalStatus ||= "失败";
    attempt.latencyMs = Date.now() - Date.parse(startedAt);
    if (attempt.businessId) {
      attempt = {
        ...attempt,
        ...(await businessFlow(job.domain, attempt.businessId)),
      };
    }
    return finalizeAttempt(job.key, attempt);
  }
}

async function runContent(job, existing, context = {}) {
  const acceptanceKind =
    context.acceptanceKind === "pipeline" ? "pipeline" : "capability";
  const pipeline = acceptanceKind === "pipeline";
  const lineage = context.lineage || null;
  const setProgress = pipeline
    ? (attempt) => setPipelineInProgress(job.idx, attempt)
    : (attempt) => setInProgress(job.key, attempt);
  const finish = pipeline
    ? (attempt) => finalizePipelineAttempt(job.idx, attempt)
    : (attempt) => finalizeAttempt(job.key, attempt);
  const startedAt = existing?.startedAt || new Date().toISOString();
  let attempt = {
    ...(existing || {}),
    domain: job.domain,
    idx: job.idx,
    employeeId: job.key,
    attemptId: existing?.attemptId || crypto.randomUUID(),
    invocationId: existing?.invocationId || invocationId,
    resumedByInvocationId: existing ? invocationId : null,
    startedAt,
    phase: existing?.phase || "starting",
    businessId: Number(existing?.businessId) || null,
    acceptanceKind,
    providerEvidence: "unverified",
    externalPublish: false,
    lineageValid: pipeline ? job.idx === 0 : null,
    lineageErrors: [],
    acceptanceDemand:
      existing?.acceptanceDemand ||
      `请围绕内容员工${job.idx}本次岗位任务核验公开信息并给出下一步可执行的业务结论。`,
    acceptanceGatePlan:
      existing?.acceptanceGatePlan ||
      buildUnifiedAcceptancePlan({
        demand: `请围绕内容员工${job.idx}本次岗位任务核验公开信息并给出下一步可执行的业务结论。`,
        publicInfoRequired: true,
      }),
  };
  try {
    const canonicalProfile = buildContentEmployeeWorkbenchProfile(job.idx);
    const profile = (
      await request(`/api/employee-workbench/content/${job.idx}`)
    ).payload;
    const profileCompleteness = validateContentProfileCompleteness(
      profile,
      job.idx,
      canonicalProfile,
    );
    attempt.contentProfileComplete = profileCompleteness.valid;
    attempt.contentProfileEvidence = profileCompleteness.evidence;
    attempt.contentProfileErrors = profileCompleteness.errors;
    if (!profileCompleteness.valid) {
      throw new Error(
        `内容员工完整岗位档案未通过：${profileCompleteness.errors.join("；")}`,
      );
    }
    attempt.employeeKey = profile.identity?.key || null;
    attempt.employeeName = profile.identity?.name || null;
    attempt.profileVersion = profile.provenance?.profileVersion || null;
    let dispatchInput =
      context.dispatchInput ||
      buildContentDispatch(
        profile,
        `real-content-${acceptanceKind}-${job.idx}-${crypto.randomUUID()}`,
        { acceptanceKind, lineage },
      );
    const preflightInput = validateContentDispatchEvidence(
      dispatchInput,
      job.idx,
      {
        acceptanceKind,
        lineage,
      },
    );
    if (!preflightInput.valid) {
      attempt.inputEvidenceValid = false;
      throw new Error(
        `内容岗位完整输入未通过：${preflightInput.errors.join("；")}`,
      );
    }
    attempt.inputEvidenceValid = true;
    if (!attempt.businessId) {
      const nonce =
        dispatchInput.requirement.match(/任务唯一标识：([^\n]+)/u)?.[1] ||
        `real-content-${acceptanceKind}-${job.idx}-${crypto.randomUUID()}`;
      const dispatchedAt = Date.now();
      const baseline = ledgerBaseline();
      const approvalCountBefore = approvalCountForTenant();
      const dispatch = await dispatchWithNonce(
        "content",
        job.idx,
        `/api/employee-workbench/content/${job.idx}/dispatch`,
        dispatchInput,
        nonce,
      );
      attempt = {
        ...attempt,
        nonce,
        ledgerBaseline: baseline,
        approvalCountBefore,
        businessId: Number(dispatch.payload?.runId),
        initialStatus: dispatch.payload?.status || null,
        requestId: dispatch.response.headers.get("x-request-id"),
        dispatchedAt: new Date(dispatchedAt).toISOString(),
        taskTitle: dispatchInput.title,
        acceptanceDemand: dispatchInput.acceptanceDemand,
        acceptanceGatePlan: dispatchInput.acceptanceGatePlan,
        acceptanceDemandValid: dispatchInput.acceptanceDemandValid === true,
        taskRequirementHash: crypto
          .createHash("sha256")
          .update(dispatchInput.requirement)
          .digest("hex"),
        phase: "dispatched",
      };
      if (!Number.isSafeInteger(attempt.businessId) || attempt.businessId <= 0)
        throw new Error("派活响应缺少有效runId");
      setProgress(attempt);
    }
    const response = await poll(
      `/api/employee-workbench/content/${job.idx}/runs/${attempt.businessId}`,
      (payload) =>
        payload?.run?.status !== "生成中" &&
        !["held", "pending_settlement", "pending_release"].includes(
          payload?.run?.billing?.state,
        ),
      job.key,
    );
    const run = response.run;
    const executionProfile = contentProfileIntegrityEvidence(
      run.snapshot,
      job.idx,
      canonicalProfile,
    );
    const persistedRow = billingDb
      .prepare(
        `SELECT profile_version,snapshot_json FROM content_employee_runs
         WHERE tenant_id=? AND employee_idx=? AND id=?`,
      )
      .get(tenantId, job.idx, attempt.businessId);
    let persistedSnapshot = null;
    try {
      persistedSnapshot = JSON.parse(String(persistedRow?.snapshot_json || ""));
    } catch {
      persistedSnapshot = null;
    }
    const persistedProfile = contentProfileIntegrityEvidence(
      persistedSnapshot,
      job.idx,
      canonicalProfile,
    );
    const profileChain = validateContentProfileExecutionChain({
      api: {
        profileVersion: profile.provenance?.profileVersion || null,
        ...profileCompleteness.evidence,
      },
      execution: {
        profileVersion: run.snapshot?.profileVersion || null,
        ...executionProfile,
      },
      persisted: {
        profileVersion: persistedRow?.profile_version || null,
        ...persistedProfile,
      },
    });
    attempt.contentProfileChainValid =
      profileChain.valid &&
      executionProfile.canonicalMatch === true &&
      persistedProfile.canonicalMatch === true;
    attempt.contentProfileChainErrors = [
      ...profileChain.errors,
      ...(executionProfile.canonicalMatch
        ? []
        : ["执行快照与canonical档案指纹不一致"]),
      ...(persistedProfile.canonicalMatch
        ? []
        : ["落库快照与canonical档案指纹不一致"]),
    ];
    attempt.contentProfileExecutionEvidence = {
      api: profileChain.api,
      execution: profileChain.execution,
      persisted: profileChain.persisted,
    };
    const providerAttempt = run.snapshot?.providerAttempt || null;
    const contentAttemptSource =
      Array.isArray(run.snapshot?.qualityRetry?.attempts) &&
      run.snapshot.qualityRetry.attempts.length
        ? run.snapshot.qualityRetry.attempts
        : providerAttempt
          ? [
              {
                number: 1,
                phase: "acquire",
                mode: providerAttempt.mode,
                model: providerAttempt.model,
                apiObtained: providerAttempt.mode === "api",
                succeeded: run.contract?.valid === true,
                contractValid:
                  typeof run.contract?.valid === "boolean"
                    ? run.contract.valid
                    : null,
                failure: null,
                usage: providerAttempt.usage,
              },
            ]
          : [];
    attempt.providerAttempts = projectProviderAttempts(contentAttemptSource);
    attempt.providerAttemptSummary = summarizeProviderAttempts(
      attempt.providerAttempts,
    );
    setProgress(attempt);
    const billing = await waitBilling(
      "content_employee_run",
      attempt.businessId,
    );
    const billed = billingFields(
      billing,
      "content_employee_run",
      attempt.businessId,
      attempt.dispatchedAt,
      attempt.ledgerBaseline,
    );
    dispatchInput = {
      ...dispatchInput,
      title: run.title || dispatchInput.title,
      type: run.type || dispatchInput.type,
      requirement: run.requirement || dispatchInput.requirement,
      industry: run.industry || dispatchInput.industry,
      feedback: run.feedback || dispatchInput.feedback,
    };
    const actualInput = validateContentDispatchEvidence(
      dispatchInput,
      job.idx,
      {
        acceptanceKind,
        lineage,
      },
    );
    const validationAttachments = lineage
      ? [
          {
            name: lineage.filename,
            content: lineage.envelope,
          },
        ]
      : [];
    const effectiveRequirement = [
      dispatchInput.requirement,
      lineage?.envelope || "",
    ]
      .filter(Boolean)
      .join("\n");
    const localContract = validateContentEmployeeOutputContract(
      job.idx,
      run.snapshot?.validatedOutput,
      {
        title: dispatchInput.title,
        requirement: effectiveRequirement,
        feedback: dispatchInput.feedback,
        attachments: validationAttachments,
        web: run.snapshot?.web,
        enforceRequiredInputs: true,
        outputForCompletionGate: run.snapshot?.validatedOutput,
      },
    );
    const localPrimaryArtifacts = Array.isArray(localContract.artifacts)
      ? localContract.artifacts.filter((item) => item?.primary === true)
      : [];
    const localPrimary =
      localPrimaryArtifacts.length === 1 ? localPrimaryArtifacts[0] : null;
    const primaryArtifactContent = String(localPrimary?.content || "");
    const primaryArtifactHash = primaryArtifactContent
      ? crypto.createHash("sha256").update(primaryArtifactContent).digest("hex")
      : null;
    const serverTraceHash = String(
      run.snapshot?.parsedOutput?.artifactContentSha256 || "",
    );
    const primaryArtifactHashValid =
      localContract.valid === true &&
      Boolean(primaryArtifactHash) &&
      /^[a-f0-9]{64}$/u.test(serverTraceHash) &&
      serverTraceHash === primaryArtifactHash;
    let lineageAssessment = { valid: true, errors: [] };
    let readbackAttachmentHash = null;
    let lineageEnvelopeHash = null;
    let upstreamArtifactHash = null;
    if (pipeline && job.idx > 0) {
      const inputLineage = validateContentLineageInput(lineage);
      const attachmentRef = (
        Array.isArray(run.attachments) ? run.attachments : []
      ).find((item) => Number(item?.id) === Number(lineage?.fileId));
      readbackAttachmentHash =
        String(attachmentRef?.contentSha256 || "").toLowerCase() || null;
      lineageEnvelopeHash =
        String(lineage?.envelopeHash || "").toLowerCase() || null;
      upstreamArtifactHash =
        String(lineage?.sourceArtifactHash || "").toLowerCase() || null;
      const edgeCandidate = {
        fromIdx: Number(lineage?.fromIdx),
        toIdx: job.idx,
        sourceRunId: Number(lineage?.sourceRunId),
        targetRunId: attempt.businessId,
        sourceArtifactHash: upstreamArtifactHash,
        envelopeHash: lineageEnvelopeHash,
      };
      lineageAssessment = validateContentLineageEdge(
        edgeCandidate,
        context.upstreamStage,
        {
          idx: job.idx,
          businessId: attempt.businessId,
          upstreamArtifactHash,
          lineageEnvelopeHash,
          readbackAttachmentHash,
        },
      );
      if (!inputLineage.valid) {
        lineageAssessment = {
          valid: false,
          errors: [...inputLineage.errors, ...lineageAssessment.errors],
        };
      }
    }
    attempt = attachProviderEvidence({
      ...attempt,
      phase: "generated",
      generationStatus: run.status || null,
      aiMode: run.aiMode || billing?.ai_mode || null,
      model: run.model || billing?.model || null,
      inputEvidenceValid: actualInput.valid,
      inputEvidenceErrors: actualInput.errors.slice(0, 20),
      contractValid: run.contract?.valid === true,
      contractErrors: Array.isArray(run.contract?.errors)
        ? run.contract.errors.map(String)
        : [],
      localContractValid: localContract.valid === true,
      localContractErrors: Array.isArray(localContract.errors)
        ? localContract.errors.map(String).slice(0, 20)
        : [],
      qualityRetry: run.snapshot?.qualityRetry || null,
      webResearchEvidence: summarizeWebResearchEvidence(run.snapshot?.web || null),
      artifactCount: Array.isArray(run.contract?.artifacts)
        ? run.contract.artifacts.length
        : 0,
      primaryArtifactCount: Array.isArray(run.contract?.artifacts)
        ? run.contract.artifacts.filter((item) => item.primary === true).length
        : 0,
      primaryArtifactHash,
      primaryArtifactHashValid,
      primaryArtifactChars: [...primaryArtifactContent].length,
      primaryArtifactBytes: Buffer.byteLength(primaryArtifactContent),
      lineageValid: pipeline ? job.idx === 0 || lineageAssessment.valid : null,
      lineageErrors: pipeline ? lineageAssessment.errors.slice(0, 20) : [],
      upstreamBusinessId:
        pipeline && job.idx > 0 ? Number(lineage?.sourceRunId) || null : null,
      upstreamArtifactHash,
      lineageEnvelopeHash,
      readbackAttachmentHash,
      lineageAttachmentId:
        pipeline && job.idx > 0 ? Number(lineage?.fileId) || null : null,
      resultHash: run.resultMd
        ? crypto.createHash("sha256").update(run.resultMd).digest("hex")
        : null,
      resultChars: String(run.resultMd || "").length,
      latencyMs: Date.now() - Date.parse(startedAt),
      ...billed,
      ...providerFields(providerAttempt),
      model: run.model || billed.model || providerAttempt?.model || null,
      inputTokens:
        billed.inputTokens || Number(providerAttempt?.usage?.inputTokens) || 0,
      outputTokens:
        billed.outputTokens ||
        Number(providerAttempt?.usage?.outputTokens) ||
        0,
    });
    setProgress(attempt);
    const adoptable =
      attempt.generationStatus === "待审阅" &&
      attempt.aiMode === "api" &&
      attempt.providerInvocationEvidenceValid === true &&
      attempt.businessDeliveryBillingEvidenceValid === true &&
      attempt.contractValid &&
      attempt.localContractValid &&
      attempt.primaryArtifactHashValid &&
      attempt.inputEvidenceValid &&
      attempt.contentProfileChainValid === true &&
      (!pipeline || attempt.lineageValid) &&
      attempt.billingState === "settled" &&
      attempt.inputTokens > 0 &&
      attempt.outputTokens > 0 &&
      attempt.primaryArtifactCount === 1 &&
      attempt.primaryArtifactBytes > 0;
    const unifiedAcceptanceMode =
      attempt.acceptanceGatePlan?.schema === "nanowork.unified-acceptance-gate.v1";
    if (attempt.generationStatus === "待审阅" && !unifiedAcceptanceMode) {
      const decision = adoptable ? "adopt" : "reject";
      const preReviewFailures = [
        ...attempt.inputEvidenceErrors,
        ...attempt.localContractErrors,
        ...attempt.lineageErrors,
        ...attempt.contentProfileChainErrors,
        ...(!attempt.primaryArtifactHashValid
          ? ["主产物哈希未通过采纳前复验"]
          : []),
      ];
      const review = await request(
        `/api/employee-workbench/content/${job.idx}/runs/${attempt.businessId}/review`,
        {
          method: "POST",
          body: {
            decision,
            opinion:
              decision === "adopt"
                ? `真实云API${pipeline ? "0→9流水线" : "单岗能力"}验收通过 ${attempt.attemptId}`
                : `真实云API验收未通过：${preReviewFailures.join("；") || "真实来源、契约、计费或终态未通过"}`.slice(
                    0,
                    1000,
                  ),
          },
        },
      );
      attempt.reviewDecision = decision;
      attempt.materialId = Number(review.payload?.materialId) || null;
      attempt.contentId = Number(review.payload?.contentId) || null;
      attempt.terminalStatus = review.payload?.run?.status || null;
      attempt.phase = "reviewed";
      if (decision === "adopt") {
        const primaryIndex = Math.max(
          0,
          (run.contract?.artifacts || []).findIndex(
            (item) => item?.primary === true,
          ),
        );
        const artifact = await request(
          `/api/employee-workbench/content/${job.idx}/runs/${attempt.businessId}/artifacts/${primaryIndex}`,
        );
        const readbackHash = crypto
          .createHash("sha256")
          .update(artifact.raw)
          .digest("hex");
        attempt.primaryArtifactDownloadStatus = artifact.response.status;
        attempt.primaryArtifactReadbackHash = readbackHash;
        attempt.primaryArtifactReadbackBytes = Buffer.byteLength(artifact.raw);
        attempt.artifactReadbackValid =
          readbackHash === primaryArtifactHash &&
          artifact.raw === primaryArtifactContent;
      } else {
        attempt.artifactReadbackValid = false;
      }
    } else if (attempt.generationStatus === "待审阅" && unifiedAcceptanceMode) {
      attempt.reviewSuppressed = true;
    } else {
      attempt.terminalStatus = run.status || null;
      attempt.artifactReadbackValid = false;
    }
    attempt = {
      ...attempt,
      ...(await businessFlow(job.domain, attempt.businessId)),
    };
    const approvalCountAfter = approvalCountForTenant();
    attempt.approvalCountAfter = approvalCountAfter;
    attempt.approvalDelta =
      Number.isFinite(Number(attempt.approvalCountBefore)) &&
      Number.isFinite(Number(approvalCountAfter))
        ? Number(approvalCountAfter) - Number(attempt.approvalCountBefore)
        : null;
    attempt.unifiedGate = unifiedContentGateEvidence({
      attempt,
      dispatch: dispatchInput,
      run,
      localContract,
      approvalAfter: approvalCountAfter,
    });
    const judged = finish(attempt);
    if (pipeline && judged.pipelinePass && job.idx > 0) {
      const edge = {
        fromIdx: Number(lineage.fromIdx),
        toIdx: job.idx,
        sourceRunId: Number(lineage.sourceRunId),
        targetRunId: judged.businessId,
        sourceArtifactHash: lineage.sourceArtifactHash,
        envelopeHash: lineage.envelopeHash,
        attachmentId: Number(lineage.fileId),
        verified: true,
        verifiedAt: new Date().toISOString(),
      };
      state.pipeline.edges = [
        ...(Array.isArray(state.pipeline.edges)
          ? state.pipeline.edges
          : []
        ).filter((item) => Number(item?.toIdx) !== job.idx),
        edge,
      ].sort((left, right) => Number(left.toIdx) - Number(right.toIdx));
      persistState();
    }
    return judged;
  } catch (error) {
    if (error.code === "MATRIX_INTERRUPTED") {
      attempt.interruptedAt = new Date().toISOString();
      attempt.verdict = "IN_PROGRESS";
      setProgress(attempt);
      return attempt;
    }
    const failedRunId = Number(error?.payload?.runId || error?.payload?.taskId);
    if (
      !attempt.businessId &&
      Number.isSafeInteger(failedRunId) &&
      failedRunId > 0
    ) {
      attempt.businessId = failedRunId;
    }
    attempt.phase = "failed";
    attempt.httpError = error.message;
    if (!attempt.webResearchEvidence && error?.web) {
      attempt.webResearchEvidence = summarizeWebResearchEvidence(error.web);
    }
    attempt.terminalStatus ||= "失败";
    attempt.latencyMs = Date.now() - Date.parse(startedAt);
    if (attempt.businessId) {
      attempt = {
        ...attempt,
        ...(await businessFlow(job.domain, attempt.businessId)),
      };
    }
    return finish(attempt);
  }
}

async function loadPipelinePrimaryArtifact(stage) {
  if (!stage?.businessId || !stage?.primaryArtifactHash) {
    throw new Error("上游阶段缺少可读回的业务ID或主产物哈希");
  }
  const artifact = await request(
    `/api/employee-workbench/content/${stage.idx}/runs/${stage.businessId}/artifacts/0`,
  );
  const hash = crypto.createHash("sha256").update(artifact.raw).digest("hex");
  if (hash !== stage.primaryArtifactHash) {
    throw new Error(
      `上游content:${stage.idx}#${stage.businessId}主产物读回哈希不一致`,
    );
  }
  if (!artifact.raw.trim()) throw new Error("上游主产物原文为空");
  return artifact.raw;
}

async function uploadPipelineLineage(lineage) {
  const checked = validateContentLineageInput(lineage);
  if (!checked.valid)
    throw new Error(`上游血缘原文不可传递：${checked.errors.join("；")}`);
  const uploaded = await request("/api/files/upload", {
    method: "POST",
    body: {
      name: lineage.filename,
      mime: "text/markdown",
      purpose: "real-content-pipeline",
      recognize: false,
      b64: Buffer.from(lineage.envelope, "utf8").toString("base64"),
    },
    timeoutMs: 60_000,
  });
  const file = uploaded.payload?.file;
  if (
    !Number.isSafeInteger(Number(file?.id)) ||
    Number(file.id) <= 0 ||
    file?.readable !== true
  ) {
    throw new Error("上游原文附件上传后不可读，禁止进入下一岗");
  }
  return { ...lineage, fileId: Number(file.id) };
}

function parseStoredJson(value, fallback = null) {
  try {
    return value == null || value === "" ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function productionPipelineStationRefId(pipelineId, stationIdx) {
  const value = Number(pipelineId) * 10 + Number(stationIdx) + 1;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function productionPipelineMainBilling(pipelineId, stationIdx) {
  const refType = "content_production_pipeline_station";
  const refId = productionPipelineStationRefId(pipelineId, stationIdx);
  const row = refId ? billingFromDatabase(refType, refId) : null;
  const valid =
    row?.authority_error == null &&
    Number(row?.hold_count) === 1 &&
    Number(row?.credit_log_count) === 1 &&
    Number(row?.hold_tenant_id) === tenantId &&
    Number(row?.log_tenant_id) === tenantId &&
    Number(row?.hold_user_id) === userId &&
    Number(row?.log_user_id) === userId &&
    Number(row?.hold_log_id) === Number(row?.log_id) &&
    row?.ref_type === refType &&
    Number(row?.ref_id) === refId;
  return {
    valid,
    state: row?.billing_state || null,
    refType,
    refId,
    holdId: Number(row?.hold_id || 0) || null,
    logId: Number(row?.log_id || 0) || null,
    heldCredits: Number(row?.held_credits || 0),
    chargedCredits: Number(row?.charged_credits || 0),
    inputTokens: Number(row?.input_tokens || 0),
    outputTokens: Number(row?.output_tokens || 0),
    aiMode: row?.ai_mode || null,
    model: row?.log_model || null,
  };
}

function productionPipelineSpecialProviderEvidence(pipelineId, stationIdx) {
  const expected = [5, 6].includes(Number(stationIdx));
  const exists = billingDb
    .prepare(
      "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='content_pipeline_special_provider_attempts'",
    )
    .get()?.ok === 1;
  const rows = exists
    ? billingDb
        .prepare(
          `SELECT * FROM content_pipeline_special_provider_attempts
           WHERE tenant_id=? AND pipeline_id=? AND station_idx=? ORDER BY id`,
        )
        .all(tenantId, pipelineId, stationIdx)
    : [];
  const attempts = rows.map((row) => {
    const delivery = parseStoredJson(row.delivery_json, {});
    const artifactIds = Array.isArray(delivery?.artifactIds)
      ? delivery.artifactIds
      : [];
    const materialIds = artifactIds
      .map((value) => /^material:(\d+)$/u.exec(String(value)))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    const materials = materialIds.map((materialId) =>
      billingDb.prepare("SELECT * FROM materials WHERE id=?").get(materialId),
    );
    const artifactEvidenceValid =
      materialIds.length === 1 &&
      materials.length === 1 &&
      materials.every((material) => {
        const artifact = parseStoredJson(material?.artifact_snapshot_json, {});
        const source = String(material?.url || material?.body_snapshot || "");
        const sourceHash = source
          ? crypto.createHash("sha256").update(source, "utf8").digest("hex")
          : "";
        return (
          material &&
          material.source_type === "content_pipeline_provider" &&
          Number(material.source_id) === Number(pipelineId) &&
          Number(material.creator_id) === userId &&
          artifact.schemaVersion ===
            "nanowork.content-pipeline-provider-artifact/2" &&
          artifact.attemptId === row.attempt_id &&
          artifact.billingRefType === row.billing_ref_type &&
          Number(artifact.billingRefId) === Number(row.billing_ref_id) &&
          artifact.credentialsIncluded === false &&
          artifact.binaryInMetadata === false &&
          sourceHash &&
          artifact.contentSha256 === sourceHash &&
          material.snapshot_hash === sourceHash
        );
      });
    const billing = billingFromDatabase(
      row.billing_ref_type,
      row.billing_ref_id,
    );
    const billingValid =
      billing?.authority_error == null &&
      Number(billing?.hold_count) === 1 &&
      Number(billing?.credit_log_count) === 1 &&
      Number(billing?.hold_id) === Number(row.hold_id) &&
      Number(billing?.hold_tenant_id) === tenantId &&
      Number(billing?.hold_user_id) === userId &&
      billing?.billing_state === "settled";
    return {
      status: row.status,
      kind: row.provider_kind,
      namespaceStable: new RegExp(
        `^content-production-pipeline:pipeline:${pipelineId}:station:${stationIdx}:`,
        "u",
      ).test(String(row.attempt_id || "")),
      evidenceValid: artifactEvidenceValid && billingValid,
      delivery: {
        persisted: delivery?.persisted === true,
        artifactCount: artifactIds.length,
      },
      materialCount: materials.filter(Boolean).length,
      estimatedCredits: Number(billing?.held_credits || 0),
      heldCredits:
        billing?.billing_state === "held"
          ? Number(billing?.held_credits || 0)
          : 0,
      chargedCredits: Number(billing?.charged_credits || 0),
    };
  });
  return {
    expected,
    attemptCount: attempts.length,
    totalEstimatedCredits: attempts.reduce(
      (sum, attempt) => sum + attempt.estimatedCredits,
      0,
    ),
    totalHeldCredits: attempts.reduce(
      (sum, attempt) => sum + attempt.heldCredits,
      0,
    ),
    totalChargedCredits: attempts.reduce(
      (sum, attempt) => sum + attempt.chargedCredits,
      0,
    ),
    materialCount: attempts.reduce(
      (sum, attempt) => sum + attempt.materialCount,
      0,
    ),
    attempts,
  };
}

function storeProductionPipelineStage(stage) {
  const key = `content:${Number(stage.idx)}`;
  const attemptId = String(stage.attemptId || "");
  const existing = state.pipeline.stages[key] || { attempts: [] };
  const attempts = Array.isArray(existing.attempts)
    ? existing.attempts.filter(
        (attempt) => String(attempt?.attemptId || "") !== attemptId,
      )
    : [];
  state.pipeline.stages[key] = {
    attempts: [...attempts, stage],
    latest: stage,
  };
}

function recoverProductionPipelineByNonce(nonce) {
  const pattern = `%${String(nonce).replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const rows = billingDb
    .prepare(
      `SELECT id FROM content_production_pipeline_jobs
       WHERE tenant_id=? AND created_by=? AND title LIKE ? ESCAPE '\\'
       ORDER BY id`,
    )
    .all(tenantId, userId, pattern);
  return rows.length === 1 ? Number(rows[0].id) : null;
}

async function getProductionPipeline(pipelineId) {
  const payload = (
    await request(`/api/content/pipelines/${Number(pipelineId)}`, {
      timeoutMs: 30_000,
    })
  ).payload;
  const pipeline = payload?.pipeline;
  if (Number(pipeline?.id) !== Number(pipelineId)) {
    throw new Error(`流水线#${pipelineId}详情缺少一致业务ID`);
  }
  return pipeline;
}

async function createProductionPipeline(nonce, brief) {
  try {
    const payload = (
      await request("/api/content/pipelines", {
        method: "POST",
        body: { brief, workflow: { mode: "manual" } },
        timeoutMs: 60_000,
      })
    ).payload;
    const pipelineId = Number(payload?.pipeline?.id);
    if (!Number.isSafeInteger(pipelineId) || pipelineId <= 0) {
      throw new Error("创建流水线响应缺少pipeline.id");
    }
    return pipelineId;
  } catch (error) {
    if (error?.code !== "MUTATION_RESULT_AMBIGUOUS") throw error;
    const recovered = recoverProductionPipelineByNonce(nonce);
    if (recovered) return recovered;
    throw new Error(
      "创建0→9流水线的POST结果不明，且未能按nonce从数据库唯一恢复；禁止重放",
      { cause: error },
    );
  }
}

async function waitProductionPipelineStop(pipelineId) {
  return poll(
    `/api/content/pipelines/${pipelineId}`,
    (payload) => payload?.pipeline?.status !== "running",
    `内容流水线#${pipelineId}`,
  ).then((payload) => payload.pipeline);
}

async function approveProductionPipelineStation(pipeline, station) {
  const observed = contentProductionPickSelection(station);
  const selection = observed ? { candidateIndex: observed.candidateIndex } : null;
  try {
    const payload = (
      await request(`/api/content/pipelines/${pipeline.id}/review`, {
        method: "POST",
        body: {
          action: "approve",
          ...(selection ? { selection } : {}),
        },
        timeoutMs: 60_000,
      })
    ).payload;
    return payload?.pipeline || (await getProductionPipeline(pipeline.id));
  } catch (error) {
    if (error?.code !== "MUTATION_RESULT_AMBIGUOUS") throw error;
    const recovered = await getProductionPipeline(pipeline.id);
    const samePending =
      recovered.status === "awaiting_approval" &&
      Number(recovered.pendingStation) === Number(station.stationIdx);
    if (!samePending) return recovered;
    throw new Error(
      `工位${station.stationIdx}审批POST结果不明，服务端仍显示同一待审状态；禁止自动重放`,
      { cause: error },
    );
  }
}

function evaluateProductionPipelineStage(pipeline, station, upstreamOutputs, requireHumanReview) {
  const mainBilling = productionPipelineMainBilling(
    pipeline.id,
    station.stationIdx,
  );
  const specialProvider = productionPipelineSpecialProviderEvidence(
    pipeline.id,
    station.stationIdx,
  );
  const evaluated = evaluateRealContentProductionStation({
    pipeline,
    station,
    upstreamOutputs,
    mainBilling,
    specialProvider,
    requireHumanReview,
  });
  const stage = {
    ...evaluated.stage,
    attemptId: `content-production-pipeline:${pipeline.id}:station:${station.stationIdx}:attempt:${station.attempt}`,
    invocationId,
    dispatchedAt: pipeline.createdAt || station.startedAt || new Date().toISOString(),
    startedAt: station.startedAt || pipeline.createdAt || null,
    finishedAt: station.completedAt || station.updatedAt || new Date().toISOString(),
  };
  return { ...evaluated, stage };
}

function rebuildProductionPipelineReport(pipeline) {
  const upstreamOutputs = {};
  const evaluatedStages = [];
  for (let idx = 0; idx <= 9; idx += 1) {
    const station = (pipeline.stations || []).find(
      (candidate) => Number(candidate?.stationIdx) === idx,
    );
    if (!station || station.status !== "completed") break;
    const evaluated = evaluateProductionPipelineStage(
      pipeline,
      station,
      upstreamOutputs,
      true,
    );
    storeProductionPipelineStage(evaluated.stage);
    evaluatedStages.push(evaluated.stage);
    upstreamOutputs[idx] = station.output;
  }
  const edges = [];
  for (let idx = 1; idx < evaluatedStages.length; idx += 1) {
    const upstream = evaluatedStages[idx - 1];
    const downstream = evaluatedStages[idx];
    const edge = buildRealContentProductionLineageEdge({
      pipelineId: pipeline.id,
      upstreamStage: upstream,
      downstreamStage: downstream,
    });
    const checked = validateContentLineageEdge(edge, upstream, downstream);
    downstream.lineageValid = checked.valid;
    downstream.lineageErrors = checked.errors;
    if (!checked.valid) {
      downstream.pipelinePass = false;
      downstream.pass = false;
      downstream.verdict = "FAIL_REAL_API";
      downstream.failureReasons = [
        ...(downstream.failureReasons || []),
        ...checked.errors,
      ];
    }
    edges.push({ ...edge, valid: checked.valid, errors: checked.errors });
  }
  state.pipeline.edges = edges;
  persistState();
  return evaluatedStages;
}

async function runContentPipeline() {
  if (state.pipeline?.runRequested !== true) return;
  const source = "content_production_pipeline_api";
  const mustCreate =
    options.force ||
    state.pipeline?.source !== source ||
    !Number.isSafeInteger(Number(state.pipeline?.productionPipelineId));
  if (mustCreate) {
    const nonce = crypto.randomUUID();
    const brief = buildRealContentProductionPipelineBrief(nonce);
    state.pipeline = {
      enabled: true,
      runRequested: true,
      mode: "content_production_pipeline_api_manual",
      source,
      productionPipelineId: null,
      productionPipelineNonce: nonce,
      brief,
      stages: {},
      edges: [],
    };
    persistState();
    state.pipeline.productionPipelineId = await createProductionPipeline(
      nonce,
      brief,
    );
    persistState();
  }

  const pipelineId = Number(state.pipeline.productionPipelineId);
  let pipeline = await getProductionPipeline(pipelineId);
  if (
    pipeline.status === "failed" &&
    options.retryFailures &&
    state.pipeline?.lastFailedInvocationId !== invocationId
  ) {
    state.pipeline.lastFailedInvocationId = invocationId;
    persistState();
    try {
      const payload = (
        await request(`/api/content/pipelines/${pipelineId}/retry`, {
          method: "POST",
          body: {},
          timeoutMs: 60_000,
        })
      ).payload;
      pipeline = payload?.pipeline || pipeline;
    } catch (error) {
      if (error?.code !== "MUTATION_RESULT_AMBIGUOUS") throw error;
      pipeline = await getProductionPipeline(pipelineId);
      if (pipeline.status === "failed") throw error;
    }
  }

  while (!stopped) {
    if (pipeline.status === "running") {
      pipeline = await waitProductionPipelineStop(pipelineId);
      continue;
    }
    if (pipeline.status === "awaiting_approval") {
      const station = (pipeline.stations || []).find(
        (candidate) =>
          Number(candidate?.stationIdx) === Number(pipeline.pendingStation),
      );
      if (!station) throw new Error("流水线待审状态缺少pending station");
      const upstreamOutputs = Object.fromEntries(
        (pipeline.stations || [])
          .filter(
            (candidate) =>
              Number(candidate?.stationIdx) < Number(station.stationIdx) &&
              candidate.status === "completed",
          )
          .map((candidate) => [candidate.stationIdx, candidate.output]),
      );
      const preReview = evaluateProductionPipelineStage(
        pipeline,
        station,
        upstreamOutputs,
        false,
      );
      if (!preReview.pass) {
        storeProductionPipelineStage(preReview.stage);
        persistState();
        throw new Error(
          `工位${station.stationIdx}未通过真实员工包/上游/账务门禁，保留在待审不自动采纳：${preReview.errors.join("；")}`,
        );
      }
      process.stdout.write(
        `REVIEW pipeline#${pipelineId} station=${station.stationIdx} employee=${station.employeeName || station.employeeKey}\n`,
      );
      pipeline = await approveProductionPipelineStation(pipeline, station);
      continue;
    }
    break;
  }

  state.pipeline.terminalStatus = pipeline.status;
  state.pipeline.updatedAt = pipeline.updatedAt || new Date().toISOString();
  const stages = rebuildProductionPipelineReport(pipeline);
  if (pipeline.status !== "completed") {
    const failedIdx = Number(
      pipeline.pendingStation ?? pipeline.failure?.stationIdx ?? pipeline.currentStation,
    );
    for (let idx = Math.max(0, failedIdx); idx <= 9; idx += 1) {
      if (!state.pipeline.stages[`content:${idx}`]?.latest) {
        recordBlockedPipelineStage(
          idx,
          `真实流水线#${pipelineId}停在${pipeline.status}，不得伪造后续工位产物`,
          stages.at(-1) || null,
        );
      }
    }
    throw new Error(
      `0→9真实流水线#${pipelineId}未完成：status=${pipeline.status}`,
    );
  }
  if (stages.length !== 10 || stages.some((stage) => stage.pipelinePass !== true)) {
    throw new Error(
      `0→9真实流水线#${pipelineId}已结束，但验收只通过${stages.filter((stage) => stage.pipelinePass).length}/10`,
    );
  }
}

function resumableAttempt(job) {
  const latest = state.jobs?.[job.key]?.latest;
  if (!latest) return null;
  // 质量审计可以推翻“契约表面通过”的旧证据。强制模式只对用户
  // 显式 --only 选中的岗位生效，不会无意重跑全72岗。
  if (options.force) return null;
  if (!validateAttemptInvocation(state, latest).valid) return null;
  // 旧餐饮证据没有“能力可跑 / 业务就绪”双层状态，不得被新矩阵当作已验收。
  if (
    job.domain === "restaurant" &&
    (latest.qaCapabilityRunnable !== true ||
      typeof latest.operationalReady !== "boolean")
  )
    return null;
  if (latest.verdict === "PASS_REAL_API") return "skip";
  if (latest.verdict === "FAIL_REAL_API")
    return options.retryFailures ? null : "skip";
  if (latest.businessId && !["reviewed", "failed"].includes(latest.phase))
    return latest;
  return null;
}

async function worker(queue) {
  while (!stopped) {
    const job = queue.shift();
    if (!job) return;
    const resume = resumableAttempt(job);
    if (resume === "skip") {
      recordInvocationJob("skippedJobs", job.key);
      process.stdout.write(
        `SKIP ${job.key} ${state.jobs[job.key].latest.verdict}\n`,
      );
      continue;
    }
    recordInvocationJob(resume ? "resumedJobs" : "executedJobs", job.key);
    process.stdout.write(
      `RUN  ${job.key}${resume ? ` resume#${resume.businessId}` : ""}\n`,
    );
    const result =
      job.domain === "restaurant"
        ? await runRestaurant(job, resume)
        : job.idx === 10
          ? await runNativeAiSalesVideo(job, resume)
          : await runContent(job, resume);
    const label =
      result.verdict === "IN_PROGRESS"
        ? "HOLD"
        : result.pass && result.operationalReady === false
          ? "PASS-QA/BLOCKED-BIZ"
          : result.pass
            ? "PASS"
            : "FAIL";
    process.stdout.write(
      `${label} ${job.key} model=${result.model || "-"} ${formatAttemptCostForCli(result)} status=${result.terminalStatus || "-"}\n`,
    );
  }
}

try {
  if (options.reconcileOnly) {
    const judgedRows = reconcileExistingEvidence();
    const passed = judgedRows.filter((row) => row.pass === true).length;
    process.stdout.write(
      [
        "",
        `RECONCILE_ONLY selected=${judgedRows.length} passed=${passed} failed=${judgedRows.length - passed}`,
        "network httpRequests=0 providerCalls=0 businessMutations=0",
        `report=${options.outputPath}`,
        "",
      ].join("\n"),
    );
    process.exitCode = passed === judgedRows.length ? 0 : 1;
  } else {
    await loginAndVerifyRuntime();
    const queue = [...selectedJobs];
    await Promise.all(
      Array.from({ length: options.concurrency }, () => worker(queue)),
    );
    await runContentPipeline();
    const invocation = state.run?.invocations?.find(
      (item) => item.id === invocationId,
    );
    if (invocation) invocation.finishedAt = new Date().toISOString();
    persistState();
    const summary = state.summary;
    const selectedState = {
      jobs: Object.fromEntries(
        selectedJobs.map((job) => [job.key, state.jobs[job.key]]),
      ),
    };
    const selectedSummary = summarizeState(selectedState);
    process.stdout.write(
      [
        "",
        `REAL_API_MATRIX_SELECTED capability=${selectedSummary.passed}/${selectedJobs.length}; businessProduction=${selectedSummary.businessProductionPass}/${selectedJobs.length}; failed=${selectedSummary.failed}`,
        `selected restaurant capability=${selectedSummary.restaurant.capabilityPassed}/${selectedSummary.restaurant.total} businessProduction=${selectedSummary.restaurant.businessProductionPassed}/${selectedSummary.restaurant.total} operationallyBlocked=${selectedSummary.restaurant.operationallyBlockedAfterCapabilityPass}; content capability=${selectedSummary.content.capabilityPassed}/${selectedSummary.content.total}`,
        `REAL_API_MATRIX_OVERALL capability=${summary.passed}/${summary.total}; businessProduction=${summary.businessProductionPass}/${summary.total}; failed=${summary.failed}`,
        `CONTENT_PIPELINE ${summary.pipeline.passed}/${summary.pipeline.expected} passed; complete=${summary.pipeline.complete}`,
        `overall ${formatSummaryCostForCli(summary)}`,
        `report=${options.outputPath}`,
        "",
      ].join("\n"),
    );
    process.exitCode =
      selectedSummary.passed === selectedJobs.length &&
      (!summary.pipeline.enabled || summary.pipeline.complete)
        ? 0
        : 1;
  }
} finally {
  billingDb?.close();
}

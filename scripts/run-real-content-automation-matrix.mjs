#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import {
  REAL_CONTENT_AUTOMATION_MATRIX_SCHEMA,
  assertIsolatedDatabasePaths,
  assertSafeAutomationOutputPath,
  buildContentAutomationJobs,
  evaluateAutomationEvidence,
  isOfficialYunwuBaseUrl,
  parseAutomationModes,
  parseContentEmployeeSelection,
  projectAutomationEvidence,
  sanitizeAutomationArtifact,
  summarizeAutomationResults,
} from "./lib/real-content-automation-matrix.mjs";

function usage() {
  return `内容生产仓0-9号员工×立即/定时真实云API自动化矩阵

用法：
  MATRIX_PASSWORD=... YUNWU_API_KEY=... node scripts/run-real-content-automation-matrix.mjs \\
    --source-db server/data/nanowork-real.db \\
    --employees 0-9 --modes immediate,scheduled \\
    --out artifacts/real-content-automation-matrix.json

选项：
  --source-db FILE   只读源数据库（必填）；运行前使用 SQLite VACUUM INTO 复制到系统临时目录
  --employees LIST   内容员工编号，支持 0-9、0,3,9、all（默认0-9）
  --modes LIST       immediate、scheduled 或二者（默认二者）
  --out FILE         脱敏JSON证据（默认 artifacts/real-content-automation-matrix.json）
  --timeout-ms N     每次生成的最长等待时间（默认3600000，范围60000-7200000）
  --poll-ms N        立即运行轮询间隔（默认2000，范围250-30000）
  --help             显示帮助

安全与验收边界：
  · 源数据库只读打开；规则、运行、内容、计费和恢复探针全部发生在临时副本。
  · scheduled 由真实调度认领函数到期认领，不用“立即运行”冒充定时。
  · 验证同周期只认领一次、重复执行不重复计费、nextRunAt推进、无产物恢复全额退款。
  · 每条规则最终停用；禁止发布登记、外发或遗留本轮held。
  · 证据只保存正文哈希/长度、模型/token/结算投影；不保存密码、API Key、全量提示词或生成正文。
`;
}

function boundedInteger(value, fallback, { min, max, label }) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}必须是${min}-${max}之间的整数`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const values = {};
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help") {
      help = true;
      continue;
    }
    if (!item.startsWith("--")) throw new Error(`未知参数：${item}`);
    const [key, inline] = item.split("=", 2);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${key}缺少参数值`);
    values[key] = value;
  }
  const allowed = new Set([
    "--source-db",
    "--employees",
    "--modes",
    "--out",
    "--timeout-ms",
    "--poll-ms",
  ]);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw new Error(`未知参数：${key}`);
  }
  const sourceDb =
    values["--source-db"] || process.env.CONTENT_AUTOMATION_SOURCE_DB || "";
  return {
    help,
    sourceDb: sourceDb ? path.resolve(sourceDb) : "",
    employees: parseContentEmployeeSelection(
      values["--employees"] ||
        process.env.CONTENT_AUTOMATION_EMPLOYEES ||
        "0-9",
    ),
    modes: parseAutomationModes(
      values["--modes"] ||
        process.env.CONTENT_AUTOMATION_MODES ||
        "immediate,scheduled",
    ),
    outputPath: path.resolve(
      values["--out"] ||
        process.env.CONTENT_AUTOMATION_MATRIX_FILE ||
        "artifacts/real-content-automation-matrix.json",
    ),
    timeoutMs: boundedInteger(
      values["--timeout-ms"] || process.env.CONTENT_AUTOMATION_TIMEOUT_MS,
      3_600_000,
      { min: 60_000, max: 7_200_000, label: "--timeout-ms" },
    ),
    pollMs: boundedInteger(
      values["--poll-ms"] || process.env.CONTENT_AUTOMATION_POLL_MS,
      2_000,
      { min: 250, max: 30_000, label: "--poll-ms" },
    ),
  };
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(usage());
  process.exit(0);
}
if (!options.sourceDb) {
  process.stderr.write("--source-db必填；运行器不允许默认选择业务库。\n");
  process.exit(2);
}
if (
  !fs.existsSync(options.sourceDb) ||
  !fs.statSync(options.sourceDb).isFile()
) {
  process.stderr.write(`源数据库不存在：${options.sourceDb}\n`);
  process.exit(2);
}
options.sourceDb = fs.realpathSync.native(options.sourceDb);
try {
  assertSafeAutomationOutputPath({
    sourceDb: options.sourceDb,
    outputPath: options.outputPath,
  });
} catch (error) {
  process.stderr.write(`${String(error?.message || error)}\n`);
  process.exit(2);
}

const username = String(
  process.env.MATRIX_USERNAME || process.env.MATRIX_BOSS_USERNAME || "guan",
).trim();
const password = String(
  process.env.MATRIX_PASSWORD || process.env.MATRIX_BOSS_PASSWORD || "",
);
if (!username || !password) {
  process.stderr.write(
    "缺少验收账号密码；请设置MATRIX_PASSWORD（可选MATRIX_USERNAME）。\n",
  );
  process.exit(2);
}

const jobs = buildContentAutomationJobs({
  employees: options.employees,
  modes: options.modes,
});
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "nanowork-content-automation-real-"),
);
fs.chmodSync(temporaryDirectory, 0o700);
const isolatedDb = path.join(temporaryDirectory, "isolated.db");
assertIsolatedDatabasePaths(options.sourceDb, isolatedDb);
assertSafeAutomationOutputPath({
  sourceDb: options.sourceDb,
  outputPath: options.outputPath,
  isolatedDb,
});

function databaseFileSetFingerprint(databasePath) {
  const files = [databasePath, `${databasePath}-wal`]
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => {
      const stat = fs.statSync(filePath);
      const digest = crypto
        .createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex");
      return {
        suffix: filePath === databasePath ? "main" : "wal",
        bytes: stat.size,
        sha256: digest,
      };
    });
  return {
    algorithm: "sha256",
    files,
    fingerprint: crypto
      .createHash("sha256")
      .update(JSON.stringify(files), "utf8")
      .digest("hex"),
  };
}

let sourceFingerprintBefore;

function cloneDatabaseReadOnly(sourcePath, destinationPath) {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const integrity = Object.values(
      source.prepare("PRAGMA integrity_check").get() || {},
    )[0];
    if (integrity !== "ok")
      throw new Error(`源数据库完整性校验失败：${integrity || "unknown"}`);
    const escaped = destinationPath.replaceAll("'", "''");
    source.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    source.close();
  }
  fs.chmodSync(destinationPath, 0o600);
  const copy = new DatabaseSync(destinationPath, { readOnly: true });
  try {
    const integrity = Object.values(
      copy.prepare("PRAGMA integrity_check").get() || {},
    )[0];
    if (integrity !== "ok")
      throw new Error(`隔离数据库完整性校验失败：${integrity || "unknown"}`);
  } finally {
    copy.close();
  }
}

try {
  sourceFingerprintBefore = databaseFileSetFingerprint(options.sourceDb);
  cloneDatabaseReadOnly(options.sourceDb, isolatedDb);
} catch (error) {
  try {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  } catch {
    // 原始异常优先上抛；临时目录是本次mkdtemp创建的精确目标。
  }
  throw error;
}

// 所有 server 模块必须在这些环境变量设定后再动态导入，否则 db.js 会连到默认业务库。
process.env.NANOWORK_DB = isolatedDb;
process.env.ENABLE_SCHEDULER = "false";
process.env.SEED_DEMO = "false";
process.env.NODE_ENV = process.env.NODE_ENV || "development";

let server = null;
let db = null;
let runWithTenant = null;
let claimDueContentAutomationRules = null;
let recoverStaleContentAutomationRuns = null;
let executeContentAutomationRun = null;
let contentAutomationClock = null;
let buildContentEmployeeWorkbenchProfile = null;
let holdCredits = null;
let baseUrl = null;
let session = null;
let tenantId = null;
let userId = null;
const createdRuleIds = new Set();
let removedTemporaryDirectory = false;
let interruptedSignal = null;
const shutdownController = new AbortController();

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.once(signalName, () => {
    interruptedSignal = signalName;
    shutdownController.abort(
      new Error(`验收运行收到${signalName}，正在安全恢复`),
    );
  });
}

const startedAt = new Date().toISOString();
const artifact = {
  schemaVersion: REAL_CONTENT_AUTOMATION_MATRIX_SCHEMA,
  startedAt,
  finishedAt: null,
  scope: {
    employees: [...options.employees],
    modes: [...options.modes],
    jobKeys: jobs.map((job) => job.key),
  },
  isolation: {
    sourceOpenedReadOnly: true,
    cloneMethod: "sqlite_vacuum_into",
    serverUsesEphemeralClone: true,
    schedulerMode: "isolated_manual_tick",
    sourceMutations: null,
    sourceFingerprintBefore,
    sourceFingerprintAfter: null,
    sourceUnchanged: null,
    temporaryCloneDeleted: false,
    temporaryClonePreserved: false,
    preservedClonePath: null,
    temporaryCloneContainsSensitiveTenantData: true,
    cloneMayContainSensitiveConfiguration: true,
    retentionPolicy:
      "clean_exit_delete; unresolved_safety_preserve_0600_for_manual_recovery",
    preservationReason: null,
    preexistingRulesQuarantined: 0,
  },
  boundary: {
    externalPublish: false,
    publishLogExpected: 0,
    credentialsPersistedInArtifact: false,
    apiKeyPersistedInArtifact: false,
    generatedBodyPersistedInArtifact: false,
    officialYunwuBaseUrlVerified: false,
  },
  finalSafetyAudit: null,
  results: [],
  summary: null,
};

function persistArtifact() {
  artifact.summary = {
    ...summarizeAutomationResults(artifact.results),
    finalSafetyPass: artifact.finalSafetyAudit?.pass ?? null,
    overallPass:
      !artifact.fatalError &&
      artifact.results.length === jobs.length &&
      artifact.results.every((item) => item?.pass === true) &&
      artifact.finalSafetyAudit?.pass === true &&
      artifact.isolation.sourceUnchanged === true &&
      removedTemporaryDirectory,
  };
  const safe = sanitizeAutomationArtifact(artifact);
  fs.mkdirSync(path.dirname(options.outputPath), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${options.outputPath}.${crypto.randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(safe, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    temporaryCreated = true;
    fs.renameSync(temporary, options.outputPath);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated && fs.existsSync(temporary)) {
      fs.unlinkSync(temporary);
    }
  }
}

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withTotalTimeout(label, timeoutMs, action) {
  const controller = new AbortController();
  const forwardShutdown = () =>
    controller.abort(
      shutdownController.signal.reason || new Error("验收运行已中断"),
    );
  shutdownController.signal.addEventListener("abort", forwardShutdown, {
    once: true,
  });
  const timer = setTimeout(
    () => controller.abort(new Error(`${label}超过总时限${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    return await action(controller.signal);
  } finally {
    clearTimeout(timer);
    shutdownController.signal.removeEventListener("abort", forwardShutdown);
  }
}

async function requestJson(
  pathname,
  {
    method = "GET",
    body,
    timeoutMs = 60_000,
    token = session?.token || null,
    signal = null,
  } = {},
) {
  const requestSignal = AbortSignal.any(
    [shutdownController.signal, signal, AbortSignal.timeout(timeoutMs)].filter(
      Boolean,
    ),
  );
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: requestSignal,
  });
  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }
  if (!response.ok) {
    const error = new Error(
      `${method} ${pathname}返回${response.status}：${payload?.error || payload?.message || raw}`,
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return { status: response.status, payload };
}

function sqlGet(sql, ...params) {
  return db.prepare(sql).get(...params) || null;
}

function sqlRun(sql, ...params) {
  return db.prepare(sql).run(...params);
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function tenantReviewBoundarySnapshot() {
  return {
    approvals: Number(
      sqlGet("SELECT COUNT(*) n FROM approvals WHERE tenant_id=?", tenantId)
        ?.n || 0,
    ),
    pendingApprovals: Number(
      sqlGet(
        "SELECT COUNT(*) n FROM approvals WHERE tenant_id=? AND status='待审核'",
        tenantId,
      )?.n || 0,
    ),
    publishLogs: Number(
      sqlGet(
        "SELECT COUNT(*) n FROM content_publish_logs WHERE tenant_id=?",
        tenantId,
      )?.n || 0,
    ),
    assets: Number(
      sqlGet("SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=?", tenantId)
        ?.n || 0,
    ),
    knowledge: Number(
      sqlGet("SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=?", tenantId)?.n ||
        0,
    ),
    materials: Number(
      sqlGet("SELECT COUNT(*) n FROM materials WHERE tenant_id=?", tenantId)?.n ||
        0,
    ),
  };
}

function tenantBoundarySince(before) {
  const after = tenantReviewBoundarySnapshot();
  return {
    tenantId,
    userId,
    before,
    after,
    delta: Object.fromEntries(
      Object.keys(after).map((key) => [key, after[key] - Number(before[key])]),
    ),
  };
}

function ledgerBaseline() {
  const maxId = (table) => {
    const exists = sqlGet(
      "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?",
      table,
    );
    if (!exists) return 0;
    if (table === "credit_holds") {
      return Number(
        sqlGet("SELECT COALESCE(MAX(id),0) id FROM credit_holds")?.id || 0,
      );
    }
    return Number(
      sqlGet("SELECT COALESCE(MAX(id),0) id FROM credit_logs")?.id || 0,
    );
  };
  return {
    balance: Number(
      sqlGet("SELECT credits FROM tenants WHERE id=?", tenantId)?.credits || 0,
    ),
    maxHoldId: maxId("credit_holds"),
    maxCreditLogId: maxId("credit_logs"),
  };
}

function assertDedicatedAutomationMarker() {
  const markerKey = `real_content_automation_isolated:${tenantId}`;
  const row = sqlGet("SELECT value FROM sys_config WHERE key=?", markerKey);
  let marker = row?.value;
  try {
    marker = JSON.parse(marker);
  } catch {
    // 允许验收负责人预置纯文本标记。
  }
  const valid =
    marker === "REAL_CONTENT_AUTOMATION_ISOLATED_V1" ||
    marker?.marker === "REAL_CONTENT_AUTOMATION_ISOLATED_V1";
  if (!valid) {
    throw new Error(
      `租户#${tenantId}缺少专用隔离标记 ${markerKey}=REAL_CONTENT_AUTOMATION_ISOLATED_V1，拒绝启动真实内容自动化`,
    );
  }
  artifact.isolation.tenantMarkerKey = markerKey;
  artifact.isolation.dedicatedTenantMarkerVerified = true;
}

function billingLogCountForRun(runId) {
  return Number(
    sqlGet(
      `SELECT COUNT(*) n FROM credit_holds h
    JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    WHERE h.tenant_id=? AND h.ref_type='content_automation_run' AND h.ref_id=?`,
      tenantId,
      runId,
    )?.n || 0,
  );
}

function automationSpecialProviderTableExists() {
  return Boolean(
    sqlGet(
      "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='content_automation_special_provider_attempts'",
    ),
  );
}

function automationSpecialProviderRows(runId) {
  if (!automationSpecialProviderTableExists()) return [];
  return db
    .prepare(
      `SELECT * FROM content_automation_special_provider_attempts
       WHERE tenant_id=? AND run_id=? ORDER BY id`,
    )
    .all(tenantId, runId);
}

function billingLogCountForFullRun(runId) {
  const main = billingLogCountForRun(runId);
  const special = automationSpecialProviderRows(runId).reduce((total, row) => {
    return (
      total +
      Number(
        sqlGet(
          `SELECT COUNT(*) n FROM credit_holds h
           JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
           WHERE h.tenant_id=? AND h.ref_type=? AND h.ref_id=?`,
          tenantId,
          row.billing_ref_type,
          row.billing_ref_id,
        )?.n || 0,
      )
    );
  }, 0);
  return main + special;
}

function collectAutomationSpecialProviderEvidence(runId, employeeIdx) {
  const expected = [5, 6].includes(Number(employeeIdx));
  const rows = automationSpecialProviderRows(runId);
  const attempts = rows.map((row) => {
    const delivery = parseJson(row.delivery_json, {});
    const artifactIds = Array.isArray(delivery.artifactIds)
      ? delivery.artifactIds.map(String)
      : [];
    const materialIds = artifactIds
      .map((item) => item.match(/^material:(\d+)$/u))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    const holdRows = db
      .prepare(
        `SELECT * FROM credit_holds
         WHERE tenant_id=? AND ref_type=? AND ref_id=? ORDER BY id`,
      )
      .all(tenantId, row.billing_ref_type, row.billing_ref_id);
    const hold = holdRows.length === 1 ? holdRows[0] : null;
    const creditLog = hold?.log_id
      ? sqlGet(
          "SELECT * FROM credit_logs WHERE tenant_id=? AND id=?",
          tenantId,
          hold.log_id,
        )
      : null;
    const materials = materialIds.map((materialId) => {
      const material = sqlGet(
        `SELECT id,source_type,source_id,creator_id,snapshot_hash,artifact_snapshot_json
         FROM materials WHERE tenant_id=? AND id=?`,
        tenantId,
        materialId,
      );
      const artifact = parseJson(material?.artifact_snapshot_json, {});
      return {
        id: Number(material?.id || 0) || null,
        sourceType: material?.source_type || null,
        sourceId: Number(material?.source_id || 0) || null,
        creatorId: Number(material?.creator_id || 0) || null,
        snapshotHash: material?.snapshot_hash || null,
        schemaVersion: artifact.schemaVersion || null,
        attemptIdMatches: artifact.attemptId === row.attempt_id,
        billingRefMatches:
          artifact.billingRefType === row.billing_ref_type &&
          Number(artifact.billingRefId) === Number(row.billing_ref_id),
        credentialsIncluded: artifact.credentialsIncluded === true,
        binaryInMetadata: artifact.binaryInMetadata === true,
      };
    });
    return {
      attemptId: row.attempt_id,
      kind: row.provider_kind,
      status: row.status,
      requestFingerprint: row.request_fingerprint,
      namespaceStable: String(row.attempt_id || "").startsWith(
        "content-automation:pipeline:",
      ),
      billingRefType: row.billing_ref_type,
      billingRefId: Number(row.billing_ref_id),
      hold: hold
        ? {
            id: Number(hold.id),
            logId: Number(hold.log_id),
            status: hold.status,
            heldCredits: Number(hold.held_credits || 0),
            settledCredits:
              hold.settled_credits == null
                ? null
                : Number(hold.settled_credits),
          }
        : null,
      creditLog: creditLog
        ? {
            id: Number(creditLog.id),
            aiMode: creditLog.ai_mode,
            kind: creditLog.kind,
            model: creditLog.model,
            credits: Number(creditLog.credits || 0),
            balanceAfter: Number(creditLog.balance_after || 0),
          }
        : null,
      holdCount: holdRows.length,
      creditLogCount: creditLog ? 1 : 0,
      delivery: {
        persisted: delivery.persisted === true,
        artifactCount: artifactIds.length,
        materialCount: materials.filter((item) => item.id).length,
      },
      materials,
    };
  });
  return {
    expected,
    attemptCount: attempts.length,
    expectedAttemptCount: expected ? 1 : 0,
    attempts,
    totalEstimatedCredits: attempts.reduce(
      (sum, item) => sum + Number(item.hold?.heldCredits || 0),
      0,
    ),
    totalChargedCredits: attempts.reduce(
      (sum, item) => sum + Number(item.creditLog?.credits || 0),
      0,
    ),
    totalHeldCredits: attempts.reduce(
      (sum, item) =>
        sum + (item.hold?.status === "held" ? item.hold.heldCredits : 0),
      0,
    ),
    materialCount: attempts.reduce(
      (sum, item) => sum + Number(item.delivery.materialCount || 0),
      0,
    ),
  };
}

function runCount(ruleId, trigger, scheduledFor = null) {
  return Number(
    sqlGet(
      `SELECT COUNT(*) n FROM content_automation_runs
    WHERE tenant_id=? AND rule_id=? AND trigger=?
      ${scheduledFor == null ? "" : "AND scheduled_for=?"}`,
      tenantId,
      ruleId,
      trigger,
      ...(scheduledFor == null ? [] : [scheduledFor]),
    )?.n || 0,
  );
}

async function createRule(job, label, runTime) {
  const nonce = crypto.randomUUID();
  const name = `隔离真实验收-${job.employee.idx}-${label}-${nonce}`;
  const body = {
    name,
    enabled: true,
    employeeIdx: job.employee.idx,
    topic: `${job.employee.topic}-${nonce}`,
    requirement: job.employee.requirement,
    contentType: job.employee.taskType,
    contentCount: 1,
    frequency: "daily",
    runTime,
    weekday: null,
    approvalMode: "always",
    brief: {
      direction: `${job.employee.topic}-${nonce}`,
      template: job.employee.taskType,
      industry: "餐饮连锁经营",
      material: job.employee.requirement,
      platforms:
        job.employee.idx === 6 ? ["小红书", "视频号"] : ["小红书"],
      image_mode: "ai",
      image_count: [5, 6].includes(job.employee.idx) ? 1 : 0,
      enable_deck: job.employee.idx === 7,
    },
  };
  let response;
  try {
    response = await requestJson("/api/content/automations", {
      method: "POST",
      body,
    });
  } catch (error) {
    const rows = db
      .prepare(
        `SELECT * FROM content_automation_rules
        WHERE tenant_id=? AND name=? ORDER BY id`,
      )
      .all(tenantId, name);
    if (rows.length !== 1) throw error;
    const recovered = rows[0];
    if (
      Number(recovered.employee_idx) !== job.employee.idx ||
      recovered.content_type !== job.employee.taskType ||
      recovered.topic !== body.topic ||
      recovered.requirement !== body.requirement ||
      JSON.stringify(parseJson(recovered.brief_json, {})) !==
        JSON.stringify(body.brief) ||
      Number(recovered.created_by) !== userId
    ) {
      throw new Error("规则创建响应不确定，且按唯一nonce恢复的数据库行不匹配");
    }
    response = {
      payload: {
        rule: {
          id: Number(recovered.id),
          employeeIdx: Number(recovered.employee_idx),
          contentType: recovered.content_type,
          allowedTaskTypes: [job.employee.taskType],
        },
      },
    };
  }
  const rule = response.payload?.rule;
  if (
    !Number.isSafeInteger(Number(rule?.id)) ||
    Number(rule?.employeeIdx) !== job.employee.idx ||
    rule?.contentType !== job.employee.taskType
  ) {
    throw new Error(`内容员工${job.employee.idx}的自动化规则落库证据不完整`);
  }
  if (
    !Array.isArray(rule.allowedTaskTypes) ||
    !rule.allowedTaskTypes.includes(job.employee.taskType)
  ) {
    throw new Error(
      `内容员工${job.employee.idx}的任务类型“${job.employee.taskType}”不在规则白名单`,
    );
  }
  createdRuleIds.add(Number(rule.id));
  return rule;
}

function immediateClaimKey(idempotencyKey) {
  return `manual:${userId}:${idempotencyKey}`;
}

async function requestImmediateRun(ruleId, idempotencyKey, { replay }) {
  try {
    return await requestJson(`/api/content/automations/${ruleId}/run`, {
      method: "POST",
      body: { idempotencyKey },
      timeoutMs: 60_000,
    });
  } catch (error) {
    const rows = db
      .prepare(
        `SELECT id FROM content_automation_runs
        WHERE tenant_id=? AND rule_id=? AND trigger='immediate' AND claim_key=?
        ORDER BY id`,
      )
      .all(tenantId, ruleId, immediateClaimKey(idempotencyKey));
    if (rows.length !== 1) throw error;
    return {
      payload: {
        runId: Number(rows[0].id),
        reused: replay === true,
        recoveredFromAmbiguousResponse: true,
      },
    };
  }
}

async function disableRule(ruleId) {
  let response = null;
  try {
    response = await requestJson(`/api/content/automations/${ruleId}/toggle`, {
      method: "POST",
      body: { enabled: false },
    });
  } catch (error) {
    // 关停是安全边界：HTTP不可用时仍要在隔离库内直接收口，不得留下可再调度规则。
    sqlRun(
      `UPDATE content_automation_rules SET enabled=0,next_run_at=NULL,
      updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?`,
      tenantId,
      ruleId,
    );
    response = { payload: { rule: null }, fallbackError: error.message };
  }
  const authoritative = sqlGet(
    `SELECT enabled,next_run_at FROM content_automation_rules
    WHERE tenant_id=? AND id=?`,
    tenantId,
    ruleId,
  );
  return {
    ruleDisabled: Number(authoritative?.enabled) === 0,
    nextRunAt: authoritative?.next_run_at || null,
    usedDatabaseFallback: Boolean(response.fallbackError),
  };
}

async function pollRun(ruleId, runId, signal = null) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const response = await requestJson(
      `/api/content/automations/${ruleId}/runs?runId=${runId}`,
      { timeoutMs: 60_000, signal },
    );
    const run = response.payload?.runs?.[0];
    if (run && run.status !== "运行中") return run;
    await sleep(options.pollMs);
  }
  throw new Error(
    `内容自动化运行#${runId}在${options.timeoutMs}ms内未进入终态`,
  );
}

async function collectEvidence(
  job,
  {
    ruleId,
    runId,
    publicRun,
    idempotency = null,
    scheduler = null,
    recovery = null,
    cleanup,
    tenantBaseline,
    billingBaseline,
  },
) {
  const rule = sqlGet(
    `SELECT * FROM content_automation_rules
    WHERE tenant_id=? AND id=?`,
    tenantId,
    ruleId,
  );
  const run = sqlGet(
    `SELECT * FROM content_automation_runs
    WHERE tenant_id=? AND id=? AND rule_id=?`,
    tenantId,
    runId,
    ruleId,
  );
  const runSnapshot = parseJson(run?.snapshot_json, {});
  const content =
    run?.content_id == null
      ? null
      : sqlGet(
          `SELECT * FROM contents
    WHERE tenant_id=? AND id=?`,
          tenantId,
          Number(run.content_id),
        );
  let contentReadback = null;
  if (content?.id) {
    contentReadback = (await requestJson(`/api/content/detail/${content.id}`))
      .payload;
  }
  const hold = sqlGet(
    `SELECT * FROM credit_holds
    WHERE tenant_id=? AND ref_type='content_automation_run' AND ref_id=?
    ORDER BY id DESC LIMIT 1`,
    tenantId,
    runId,
  );
  const creditLog =
    hold?.log_id == null
      ? null
      : sqlGet(
          `SELECT * FROM credit_logs
    WHERE tenant_id=? AND id=?`,
          tenantId,
          Number(hold.log_id),
        );
  const approvalCount =
    content?.id == null
      ? 0
      : Number(
          sqlGet(
            `SELECT COUNT(*) n FROM approvals
    WHERE tenant_id=? AND target_type='content' AND target_id=?`,
            tenantId,
            content.id,
          )?.n || 0,
        );
  const pendingApprovalCount =
    content?.id == null
      ? 0
      : Number(
          sqlGet(
            `SELECT COUNT(*) n FROM approvals
    WHERE tenant_id=? AND target_type='content' AND target_id=? AND status='待审核'`,
            tenantId,
            content.id,
          )?.n || 0,
        );
  const publishLogCount =
    content?.id == null
      ? 0
      : Number(
          sqlGet(
            `SELECT COUNT(*) n FROM content_publish_logs
    WHERE tenant_id=? AND content_id=?`,
            tenantId,
            content.id,
          )?.n || 0,
        );
  const derivedAssetCount =
    content?.id == null
      ? 0
      : Number(
          sqlGet(
            `SELECT COUNT(*) n FROM biz_assets
    WHERE tenant_id=? AND source_type='content' AND source_id=?`,
            tenantId,
            content.id,
          )?.n || 0,
        );
  const derivedKnowledgeCount =
    content?.id == null
      ? 0
      : Number(
          sqlGet(
            `SELECT COUNT(*) n FROM kb_docs
    WHERE tenant_id=? AND source_type='content' AND source_id=?`,
            tenantId,
            content.id,
          )?.n || 0,
        );
  const holdCount = Number(
    sqlGet(
      `SELECT COUNT(*) n FROM credit_holds
    WHERE tenant_id=? AND ref_type='content_automation_run' AND ref_id=?`,
      tenantId,
      runId,
    )?.n || 0,
  );
  const creditLogCount = billingLogCountForRun(runId);
  const specialProvider = collectAutomationSpecialProviderEvidence(
    runId,
    job.employee.idx,
  );
  const tenantBalance = Number(
    sqlGet("SELECT credits FROM tenants WHERE id=?", tenantId)?.credits || 0,
  );
  const ownHeldCount = Number(
    (automationSpecialProviderTableExists()
      ? sqlGet(
          `SELECT COUNT(*) n FROM credit_holds h
           WHERE h.tenant_id=? AND h.status='held' AND (
             (h.ref_type='content_automation_run' AND h.ref_id=?)
             OR EXISTS (
               SELECT 1 FROM content_automation_special_provider_attempts a
               WHERE a.tenant_id=h.tenant_id AND a.run_id=?
                 AND a.billing_ref_type=h.ref_type AND a.billing_ref_id=h.ref_id
             )
           )`,
          tenantId,
          runId,
          runId,
        )
      : sqlGet(
          `SELECT COUNT(*) n FROM credit_holds
           WHERE tenant_id=? AND ref_type='content_automation_run'
             AND ref_id=? AND status='held'`,
          tenantId,
          runId,
        ))?.n || 0,
  );
  return projectAutomationEvidence({
    job,
    rule,
    publicRun,
    runRecord: run,
    content,
    contentReadback,
    runSnapshot,
    hold,
    creditLog,
    approvalCount,
    pendingApprovalCount,
    publishLogCount,
    derivedAssetCount,
    derivedKnowledgeCount,
    holdCount,
    creditLogCount,
    fullBillingLogCount: billingLogCountForFullRun(runId),
    tenantBalance,
    ownHeldCount,
    idempotency,
    scheduler,
    recovery,
    cleanup,
    canonicalProfile: buildContentEmployeeWorkbenchProfile(job.employee.idx),
    tenantBoundary: tenantBoundarySince(tenantBaseline),
    ledgerBaseline: billingBaseline,
    specialProvider,
  });
}

async function runImmediate(job, tenantBaseline) {
  const clock = contentAutomationClock(new Date());
  const rule = await createRule(job, "immediate", clock.time);
  const idempotencyKey = crypto.randomUUID();
  const billingBaseline = ledgerBaseline();
  let cleanup = null;
  try {
    const first = await requestImmediateRun(rule.id, idempotencyKey, {
      replay: false,
    });
    const second = await requestImmediateRun(rule.id, idempotencyKey, {
      replay: true,
    });
    const runId = Number(first.payload?.runId);
    if (!positiveId(runId)) throw new Error("立即运行响应缺少runId");
    const publicRun = await pollRun(rule.id, runId);
    const billingCount = billingLogCountForFullRun(runId);
    cleanup = await disableRule(rule.id);
    return collectEvidence(job, {
      ruleId: rule.id,
      runId,
      publicRun,
      idempotency: {
        sameRunId: Number(second.payload?.runId) === runId,
        reused: second.payload?.reused === true,
        runCount: runCount(rule.id, "immediate"),
        billingLogCount: billingCount,
        expectedBillingLogCount: [5, 6].includes(job.employee.idx) ? 2 : 1,
        // 重复计费只看“超出期望”；上游阶段失败导致的“少于期望”
        // 由 run 终态与专项provider证据单独判定，不得误报成重复扣费。
        billingLogCountStable:
          billingCount <= ([5, 6].includes(job.employee.idx) ? 2 : 1),
        billingLogCountComplete:
          billingCount === ([5, 6].includes(job.employee.idx) ? 2 : 1),
      },
      cleanup,
      tenantBaseline,
      billingBaseline,
    });
  } finally {
    if (!cleanup) await disableRule(rule.id);
  }
}

function positiveId(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

async function runRecoveryProbe(job, now) {
  const clock = contentAutomationClock(now);
  const rule = await createRule(job, "recovery", clock.time);
  let cleanup = null;
  try {
    const scheduledFor = clock.local;
    sqlRun(
      `UPDATE content_automation_rules SET enabled=1,next_run_at=?
      WHERE tenant_id=? AND id=?`,
      scheduledFor,
      tenantId,
      rule.id,
    );
    const claims = runWithTenant(tenantId, () =>
      claimDueContentAutomationRules(now),
    );
    const claim = claims.find(
      (item) => Number(item.ruleId) === Number(rule.id),
    );
    if (!claim) throw new Error("恢复探针的到期规则没有被调度器认领");
    const balanceBefore = Number(
      sqlGet("SELECT credits FROM tenants WHERE id=?", tenantId)?.credits || 0,
    );
    const hold = runWithTenant(tenantId, () =>
      holdCredits({
        userId,
        feature: `内容自动化·${job.employee.taskType}`,
        kind: "text",
        model: "gpt-5.5",
        credits: 1,
        refType: "content_automation_run",
        refId: claim.runId,
        note: "隔离调度恢复验收：无产物超时占扣应全额退回",
      }),
    );
    const staleClock = contentAutomationClock(
      new Date(now.getTime() - 31 * 60_000),
    );
    sqlRun(
      `UPDATE content_automation_runs SET started_at=?
      WHERE tenant_id=? AND id=? AND status='运行中'`,
      staleClock.local,
      tenantId,
      claim.runId,
    );
    const recovered = runWithTenant(tenantId, () =>
      recoverStaleContentAutomationRuns(now, 30),
    );
    const recovery = recovered.find(
      (item) => Number(item.runId) === Number(claim.runId),
    );
    const run = sqlGet(
      `SELECT status,snapshot_json FROM content_automation_runs
      WHERE tenant_id=? AND id=?`,
      tenantId,
      claim.runId,
    );
    const ruleAfterRecovery = sqlGet(
      `SELECT next_run_at FROM content_automation_rules
      WHERE tenant_id=? AND id=?`,
      tenantId,
      rule.id,
    );
    const authoritativeHold = sqlGet(
      "SELECT * FROM credit_holds WHERE tenant_id=? AND id=?",
      tenantId,
      hold.holdId,
    );
    const balanceAfter = Number(
      sqlGet("SELECT credits FROM tenants WHERE id=?", tenantId)?.credits || 0,
    );
    const snapshot = parseJson(run?.snapshot_json, {});
    cleanup = await disableRule(rule.id);
    const ownHeldCount = Number(
      sqlGet(
        `SELECT COUNT(*) n FROM credit_holds h
      JOIN content_automation_runs r ON r.tenant_id=h.tenant_id
        AND h.ref_type='content_automation_run' AND h.ref_id=r.id
      WHERE h.tenant_id=? AND r.rule_id=? AND h.status='held'`,
        tenantId,
        rule.id,
      )?.n || 0,
    );
    return {
      recoveredOnce:
        Boolean(recovery) &&
        recovered.filter((item) => Number(item.runId) === Number(claim.runId))
          .length === 1,
      runStatus: run?.status || null,
      billingState: snapshot?.billing?.state || recovery?.billingState || null,
      holdStatus: authoritativeHold?.status || null,
      settledCredits:
        authoritativeHold?.settled_credits == null
          ? null
          : Number(authoritativeHold.settled_credits),
      balanceRestored: balanceAfter === balanceBefore,
      nextRunAtAdvanced:
        Boolean(ruleAfterRecovery?.next_run_at) &&
        ruleAfterRecovery.next_run_at > scheduledFor,
      ownHeldCount,
      ruleDisabled: cleanup.ruleDisabled,
      scheduledFor,
    };
  } finally {
    if (!cleanup) await disableRule(rule.id);
  }
}

async function runScheduledWithinDeadline(job, tenantBaseline, signal) {
  const now = new Date();
  const clock = contentAutomationClock(now);
  const rule = await createRule(job, "scheduled", clock.time);
  let cleanup = null;
  try {
    const scheduledFor = clock.local;
    sqlRun(
      `UPDATE content_automation_rules SET enabled=1,next_run_at=?
      WHERE tenant_id=? AND id=?`,
      scheduledFor,
      tenantId,
      rule.id,
    );
    const firstClaims = runWithTenant(tenantId, () =>
      claimDueContentAutomationRules(now),
    );
    const claim = firstClaims.find(
      (item) => Number(item.ruleId) === Number(rule.id),
    );
    if (!claim) throw new Error("到期内容自动化规则没有被调度器认领");
    const secondClaims = runWithTenant(tenantId, () =>
      claimDueContentAutomationRules(now),
    );
    const nextRunAtAfterClaim =
      sqlGet(
        `SELECT next_run_at FROM content_automation_rules
      WHERE tenant_id=? AND id=?`,
        tenantId,
        rule.id,
      )?.next_run_at || null;
    const billingBaseline = ledgerBaseline();
    const delivery = await runWithTenant(tenantId, () =>
      executeContentAutomationRun({
        ruleId: claim.ruleId,
        runId: claim.runId,
        trigger: "scheduled",
        initiatedBy: claim.initiatedBy,
        signal,
      }),
    );
    const billingCountBeforeReplay = billingLogCountForFullRun(claim.runId);
    const replay = await runWithTenant(tenantId, () =>
      executeContentAutomationRun({
        ruleId: claim.ruleId,
        runId: claim.runId,
        trigger: "scheduled",
        initiatedBy: claim.initiatedBy,
        signal,
      }),
    );
    const billingCountAfterReplay = billingLogCountForFullRun(claim.runId);
    const publicRun = await pollRun(rule.id, claim.runId, signal);
    const recovery = await runRecoveryProbe(job, new Date());
    cleanup = await disableRule(rule.id);
    return collectEvidence(job, {
      ruleId: rule.id,
      runId: claim.runId,
      publicRun,
      scheduler: {
        firstClaimCount: firstClaims.filter(
          (item) => Number(item.ruleId) === Number(rule.id),
        ).length,
        secondClaimCount: secondClaims.filter(
          (item) => Number(item.ruleId) === Number(rule.id),
        ).length,
        scheduledFor,
        nextRunAtAfterClaim,
        runCountForScheduledFor: runCount(rule.id, "scheduled", scheduledFor),
        idempotentReplay:
          replay?.idempotent === true &&
          Number(replay?.runId) === Number(claim.runId) &&
          Number(replay?.contentId) === Number(delivery?.contentId),
        billingLogCountBeforeReplay: billingCountBeforeReplay,
        billingLogCountAfterReplay: billingCountAfterReplay,
        expectedBillingLogCount: [5, 6].includes(job.employee.idx) ? 2 : 1,
        // 重复计费的权威判定：重放不得新增任何计费，且不得超出期望条数。
        // “少于期望”属于上游阶段失败，另行判定，不算重复扣费。
        billingLogCountStable:
          billingCountAfterReplay === billingCountBeforeReplay &&
          billingCountBeforeReplay <=
            ([5, 6].includes(job.employee.idx) ? 2 : 1),
        billingLogCountComplete:
          billingCountBeforeReplay ===
            ([5, 6].includes(job.employee.idx) ? 2 : 1),
      },
      recovery,
      cleanup,
      tenantBaseline,
      billingBaseline,
    });
  } finally {
    if (!cleanup) await disableRule(rule.id);
  }
}

async function runScheduled(job, tenantBaseline) {
  return withTotalTimeout(`${job.key}定时运行`, options.timeoutMs, (signal) =>
    runScheduledWithinDeadline(job, tenantBaseline, signal),
  );
}

async function runJob(job) {
  const beganAt = new Date().toISOString();
  try {
    const tenantBaseline = tenantReviewBoundarySnapshot();
    const evidence =
      job.mode === "scheduled"
        ? await runScheduled(job, tenantBaseline)
        : await runImmediate(job, tenantBaseline);
    const evaluation = evaluateAutomationEvidence(evidence);
    return {
      jobKey: job.key,
      startedAt: beganAt,
      finishedAt: new Date().toISOString(),
      ...evaluation,
      evidence,
    };
  } catch (error) {
    return sanitizeAutomationArtifact({
      jobKey: job.key,
      startedAt: beganAt,
      finishedAt: new Date().toISOString(),
      pass: false,
      verdict: "FAIL_REAL_CONTENT_AUTOMATION",
      errors: [String(error?.message || error).slice(0, 1000)],
      evidence: {
        jobKey: job.key,
        employee: {
          idx: job.employee.idx,
          key: job.employee.key,
          name: job.employee.name,
          taskType: job.employee.taskType,
        },
        mode: job.mode,
      },
    });
  }
}

function recoverOwnedRunsAndHolds() {
  if (!db || !tenantId || !createdRuleIds.size) return [];
  const ids = [...createdRuleIds].filter(positiveId);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  sqlRun(
    `UPDATE content_automation_runs SET started_at='1970-01-01 00:00:00'
    WHERE tenant_id=? AND rule_id IN (${placeholders}) AND status='运行中'`,
    tenantId,
    ...ids,
  );
  return runWithTenant(tenantId, () =>
    recoverStaleContentAutomationRuns(new Date(), 1),
  ).filter((item) => ids.includes(Number(item.ruleId)));
}

async function closeRuntime({ preserveClone = false } = {}) {
  if (db && tenantId && createdRuleIds.size) {
    const ids = [...createdRuleIds].filter(positiveId);
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      sqlRun(
        `UPDATE content_automation_rules SET enabled=0,next_run_at=NULL,
        updated_at=datetime('now','localtime')
        WHERE tenant_id=? AND id IN (${placeholders})`,
        tenantId,
        ...ids,
      );
    }
  }
  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
  }
  if (db) {
    db.close();
    db = null;
  }
  if (preserveClone) {
    fs.chmodSync(temporaryDirectory, 0o700);
    if (fs.existsSync(isolatedDb)) fs.chmodSync(isolatedDb, 0o600);
    artifact.isolation.temporaryClonePreserved = true;
    artifact.isolation.preservedClonePath = isolatedDb;
    artifact.isolation.preservationReason =
      "unresolved_recovery_or_final_safety_failure; full clone contains tenant data and may contain credential configuration";
    removedTemporaryDirectory = false;
  } else {
    try {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      removedTemporaryDirectory = !fs.existsSync(temporaryDirectory);
      if (removedTemporaryDirectory) {
        artifact.isolation.preservationReason = null;
      }
    } catch {
      removedTemporaryDirectory = false;
    }
  }
}

function finalSafetyAudit() {
  const ids = [...createdRuleIds].filter(positiveId);
  if (!ids.length) {
    return {
      pass: true,
      ruleCount: 0,
      enabledRuleCount: 0,
      rulesWithNextRunAt: 0,
      activeRunCount: 0,
      heldCount: 0,
      publishLogCount: 0,
      duplicateScheduledCycleCount: 0,
      errors: [],
    };
  }
  const placeholders = ids.map(() => "?").join(",");
  // 最终安全审计只限定本运行器在隔离库创建的规则，不把克隆前的历史数据归因到本轮。
  const counts =
    sqlGet(
      `SELECT
      COUNT(*) rule_count,
      SUM(CASE WHEN enabled<>0 THEN 1 ELSE 0 END) enabled_count,
      SUM(CASE WHEN next_run_at IS NOT NULL THEN 1 ELSE 0 END) next_count
    FROM content_automation_rules
    WHERE tenant_id=? AND id IN (${placeholders})`,
      tenantId,
      ...ids,
    ) || {};
  const activeRunCount = Number(
    sqlGet(
      `SELECT COUNT(*) n FROM content_automation_runs
    WHERE tenant_id=? AND rule_id IN (${placeholders}) AND status='运行中'`,
      tenantId,
      ...ids,
    )?.n || 0,
  );
  const mainHeldCount = Number(
    sqlGet(
      `SELECT COUNT(*) n FROM credit_holds h
    JOIN content_automation_runs r ON r.tenant_id=h.tenant_id
      AND h.ref_type='content_automation_run' AND h.ref_id=r.id
    WHERE h.tenant_id=? AND r.rule_id IN (${placeholders}) AND h.status='held'`,
      tenantId,
      ...ids,
    )?.n || 0,
  );
  const specialHeldCount = automationSpecialProviderTableExists()
    ? Number(
        sqlGet(
          `SELECT COUNT(*) n FROM credit_holds h
           JOIN content_automation_special_provider_attempts a
             ON a.tenant_id=h.tenant_id
            AND a.billing_ref_type=h.ref_type
            AND a.billing_ref_id=h.ref_id
           JOIN content_automation_runs r
             ON r.tenant_id=a.tenant_id AND r.id=a.run_id
           WHERE h.tenant_id=? AND r.rule_id IN (${placeholders})
             AND h.status='held'`,
          tenantId,
          ...ids,
        )?.n || 0,
      )
    : 0;
  const heldCount = mainHeldCount + specialHeldCount;
  const publishLogCount = Number(
    sqlGet(
      `SELECT COUNT(*) n FROM content_publish_logs p
    JOIN content_automation_runs r ON r.tenant_id=p.tenant_id AND r.content_id=p.content_id
    WHERE p.tenant_id=? AND r.rule_id IN (${placeholders})`,
      tenantId,
      ...ids,
    )?.n || 0,
  );
  const duplicateScheduledCycleCount = Number(
    sqlGet(
      `SELECT COUNT(*) n FROM (
      SELECT rule_id,scheduled_for,COUNT(*) amount FROM content_automation_runs
      WHERE tenant_id=? AND rule_id IN (${placeholders})
        AND trigger='scheduled' AND scheduled_for IS NOT NULL
      GROUP BY rule_id,scheduled_for HAVING COUNT(*)>1
    )`,
      tenantId,
      ...ids,
    )?.n || 0,
  );
  const audit = {
    pass: false,
    ruleCount: Number(counts.rule_count || 0),
    enabledRuleCount: Number(counts.enabled_count || 0),
    rulesWithNextRunAt: Number(counts.next_count || 0),
    activeRunCount,
    heldCount,
    mainHeldCount,
    specialHeldCount,
    publishLogCount,
    duplicateScheduledCycleCount,
    errors: [],
  };
  if (audit.enabledRuleCount !== 0)
    audit.errors.push("本轮隔离验收仍有启用规则");
  if (audit.rulesWithNextRunAt !== 0)
    audit.errors.push("本轮隔离验收仍有规则保留nextRunAt");
  if (audit.activeRunCount !== 0)
    audit.errors.push("本轮隔离验收仍有运行中任务");
  if (audit.heldCount !== 0) audit.errors.push("本轮隔离验收仍有held预授权");
  if (audit.publishLogCount !== 0)
    audit.errors.push("本轮隔离验收产生了发布登记");
  if (audit.duplicateScheduledCycleCount !== 0)
    audit.errors.push("同一定时周期存在重复运行");
  audit.pass = audit.errors.length === 0;
  return audit;
}

try {
  const dbModule = await import("../server/src/db.js");
  db = dbModule.db;
  runWithTenant = dbModule.runWithTenant;
  dbModule.initSchema();
  dbModule.migrateV2();
  const { ensureBaselineCatalogs } = await import("../server/src/baseline.js");
  ensureBaselineCatalogs();
  const schedulerModule = await import("../server/src/engines/scheduler.js");
  claimDueContentAutomationRules =
    schedulerModule.claimDueContentAutomationRules;
  recoverStaleContentAutomationRuns =
    schedulerModule.recoverStaleContentAutomationRuns;
  const contentModule = await import("../server/src/routes/content.js");
  executeContentAutomationRun = contentModule.executeContentAutomationRun;
  contentAutomationClock = contentModule.contentAutomationClock;
  const profileModule = await import(
    "../server/src/engines/content-employee-workbench.js"
  );
  buildContentEmployeeWorkbenchProfile =
    profileModule.buildContentEmployeeWorkbenchProfile;
  const creditsModule = await import("../server/src/engines/credits.js");
  holdCredits = creditsModule.holdCredits;
  const { aiChannel } = await import("../server/src/engines/ai.js");
  if (aiChannel() !== "yunwu") {
    throw new Error(
      "隔离运行器未检测到云雾真实API通道，拒绝用模板或备用通道冒充验收",
    );
  }
  const yunwuBaseUrl =
    dbModule.getConfig("yunwu_base_url", null) ||
    process.env.YUNWU_BASE_URL ||
    "https://yunwu.ai/v1";
  if (!isOfficialYunwuBaseUrl(yunwuBaseUrl)) {
    throw new Error(
      "云雾API基址不是yunwu.ai官方HTTPS /v1地址，拒绝用本机或仿冒服务冒充真实云验收",
    );
  }
  artifact.boundary.officialYunwuBaseUrlVerified = true;
  const { createApp } = await import("../server/src/app.js");
  const app = createApp();
  server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  const login = await requestJson("/api/auth/login", {
    method: "POST",
    body: { username, password },
    token: null,
  });
  if (!login.payload?.token || !positiveId(login.payload?.user?.id)) {
    throw new Error("验收账号登录响应不完整");
  }
  if (!["boss", "admin"].includes(String(login.payload.user.role || ""))) {
    throw new Error("内容自动化真实验收必须使用老板或管理员账号");
  }
  session = { token: login.payload.token };
  userId = Number(login.payload.user.id);
  tenantId = Number(
    login.payload.user.tenant?.id || login.payload.user.tenant_id,
  );
  if (!positiveId(tenantId)) throw new Error("验收账号缺少租户作用域");
  assertDedicatedAutomationMarker();

  // 克隆中可能存在历史启用规则。隔离租户标记确认后再全部停用，
  // 防止验收调度tick误领历史工作；这个写入仅发生在临时副本。
  const quarantine = sqlRun(`UPDATE content_automation_rules
    SET enabled=0,next_run_at=NULL,updated_at=datetime('now','localtime')
    WHERE enabled<>0 OR next_run_at IS NOT NULL`);
  artifact.isolation.preexistingRulesQuarantined = Number(
    quarantine.changes || 0,
  );

  for (const job of jobs) {
    if (interruptedSignal) break;
    const result = await runJob(job);
    artifact.results.push(result);
    persistArtifact();
    process.stdout.write(
      `${result.pass ? "PASS" : "FAIL"} ${job.key} | ${result.verdict}` +
        ` | in=${result.evidence?.provider?.inputTokens || 0}` +
        ` out=${result.evidence?.provider?.outputTokens || 0}` +
        `${result.errors?.length ? ` | ${result.errors.join("；")}` : ""}\n`,
    );
  }
} catch (error) {
  artifact.fatalError = String(error?.message || error).slice(0, 1200);
} finally {
  if (interruptedSignal && !artifact.fatalError) {
    artifact.fatalError = `验收运行收到${interruptedSignal}，已停止后续任务并执行安全恢复`;
  }
  try {
    if (db && tenantId && createdRuleIds.size) {
      const ids = [...createdRuleIds].filter(positiveId);
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        sqlRun(
          `UPDATE content_automation_rules SET enabled=0,next_run_at=NULL,
          updated_at=datetime('now','localtime')
          WHERE tenant_id=? AND id IN (${placeholders})`,
          tenantId,
          ...ids,
        );
      }
    }
    const recovered = recoverOwnedRunsAndHolds();
    artifact.isolation.recoveredOwnedRuns = recovered.length;
  } catch (error) {
    artifact.isolation.recoveryError = String(error?.message || error).slice(
      0,
      500,
    );
  }
  if (db && tenantId) artifact.finalSafetyAudit = finalSafetyAudit();
  artifact.finishedAt = new Date().toISOString();
  const preserveClone =
    Boolean(artifact.isolation.recoveryError) ||
    artifact.finalSafetyAudit?.pass === false;
  await closeRuntime({ preserveClone });
  artifact.isolation.temporaryCloneDeleted = removedTemporaryDirectory;
  try {
    artifact.isolation.sourceFingerprintAfter =
      databaseFileSetFingerprint(options.sourceDb);
    artifact.isolation.sourceUnchanged =
      artifact.isolation.sourceFingerprintBefore.fingerprint ===
      artifact.isolation.sourceFingerprintAfter.fingerprint;
    artifact.isolation.sourceMutations = artifact.isolation.sourceUnchanged
      ? 0
      : null;
  } catch (error) {
    artifact.isolation.sourceUnchanged = false;
    artifact.isolation.sourceMutations = null;
    artifact.isolation.sourceFingerprintError = String(
      error?.message || error,
    ).slice(0, 500);
  }
  persistArtifact();
}

process.stdout.write(`\n脱敏证据：${options.outputPath}\n`);
process.stdout.write(
  `结果：${artifact.summary.passed}/${artifact.summary.total}通过，` +
    `${artifact.summary.failed}失败；输入token ${artifact.summary.tokens.input}，` +
    `输出token ${artifact.summary.tokens.output}。\n`,
);
process.stdout.write(
  `隔离：源库只读，临时副本${
    removedTemporaryDirectory
      ? "已删除"
      : artifact.isolation.temporaryClonePreserved
        ? `因未收口状态已按0600保留：${artifact.isolation.preservedClonePath}`
        : "删除失败，需人工检查"
  }；` + "本矩阵不执行发布、外发或账号操作。\n",
);
if (
  artifact.fatalError ||
  artifact.summary.failed > 0 ||
  artifact.finalSafetyAudit?.pass === false ||
  artifact.isolation.sourceUnchanged !== true ||
  !removedTemporaryDirectory
) {
  process.exitCode = 1;
}

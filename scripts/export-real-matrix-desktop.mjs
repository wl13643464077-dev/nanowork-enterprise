#!/usr/bin/env node

/**
 * Isolated real-matrix orchestrator and desktop evidence exporter.
 *
 * Scope is deliberately limited to test tooling and evidence files.  It can
 * clone a dedicated SQLite database, launch a loopback-only service with the
 * Scheduler disabled, run the existing real employee/feature runners, and
 * write one fixed three-file folder per employee.  API keys stay in the
 * service process environment and are never read into a report.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { summarizeWebResearchEvidence } from "./lib/real-employee-matrix.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE_DB = path.join(ROOT, "server/data/nanowork-real-final-2026-07-31-v1.db");
const DEFAULT_FEATURE_MATRIX = path.join(ROOT, "artifacts/real-feature-matrix.json");
const DEFAULT_DESKTOP_ROOT = path.join(os.homedir(), "Desktop");
const REQUIRED_FILES = ["01输入.md", "02输出.md", "03执行与费用报告.md"];
const REDACTED = "<redacted>";

function usage() {
  return `桌面三文件真实矩阵编排器

用法：
  MATRIX_USERNAME=guan MATRIX_PASSWORD=... node scripts/export-real-matrix-desktop.mjs [选项]

选项：
  --out-dir DIR             桌面独立交付目录（默认 ~/Desktop/NanoWork-真实验收-时间戳）
  --source-db FILE          隔离库来源（默认 ${DEFAULT_SOURCE_DB}）
  --db FILE                 已准备好的专用隔离库；不填则从--source-db克隆
  --base-url URL            已启动loopback服务；默认自动启动127.0.0.1隔离服务
  --no-start-service        不自动启动服务（必须同时指定--base-url）
  --only LIST               员工筛选，如 restaurant:101,content:10
  --feature-only LIST       功能筛选，原样传给功能矩阵
  --skip-run                只导出已有JSON，不发起HTTP/云调用
  --skip-features           不运行功能矩阵（仍生成静态全功能清单）
  --force                   透传员工 runner，强制重跑 --only 岗位
  --employee-matrix FILE    使用已有员工矩阵JSON
  --feature-matrix FILE     使用已有功能矩阵JSON
  --browser-evidence FILE   合并另一测试负责人的浏览器证据JSON
  --timeout-ms N            透传员工/功能运行超时（默认员工3600000、功能600000）
  --help                    显示帮助

安全边界：服务只监听127.0.0.1；Scheduler强制关闭；数据库必须专用且含双矩阵租户标记；
不访问/回显/保存API Key，不触碰 /Users/wanglei/Documents/派活AI，不执行支付、外发或发布。
`;
}

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`未知参数：${item}`);
    if (["--help", "--no-start-service", "--skip-run", "--skip-features", "--force"].includes(item)) {
      flags.add(item);
      continue;
    }
    const [key, inline] = item.split("=", 2);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${key}缺少参数值`);
    values[key] = value;
  }
  const allowed = new Set([
    "--out-dir",
    "--source-db",
    "--db",
    "--base-url",
    "--only",
    "--feature-only",
    "--employee-matrix",
    "--feature-matrix",
    "--browser-evidence",
    "--timeout-ms",
  ]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`未知参数：${key}`);
  const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return {
    help: flags.has("--help"),
    noStart: flags.has("--no-start-service"),
    skipRun: flags.has("--skip-run"),
    skipFeatures: flags.has("--skip-features"),
    force: flags.has("--force"),
    outDir: path.resolve(values["--out-dir"] || path.join(DEFAULT_DESKTOP_ROOT, `NanoWork-真实验收-${stamp}`)),
    sourceDb: path.resolve(values["--source-db"] || DEFAULT_SOURCE_DB),
    db: values["--db"] ? path.resolve(values["--db"]) : null,
    baseUrl: String(values["--base-url"] || "").replace(/\/+$/u, ""),
    only: values["--only"] || "",
    featureOnly: values["--feature-only"] || "",
    employeeMatrix: values["--employee-matrix"] ? path.resolve(values["--employee-matrix"]) : null,
    featureMatrix: values["--feature-matrix"] ? path.resolve(values["--feature-matrix"]) : null,
    browserEvidence: values["--browser-evidence"] ? path.resolve(values["--browser-evidence"]) : null,
    timeoutMs: values["--timeout-ms"] || "",
  };
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(usage());
  process.exit(0);
}

function assertLoopback(baseUrl) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error("桌面矩阵仅允许loopback服务地址");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("服务地址不得包含凭证、查询或片段");
}

function assertSafePath(value, label) {
  const resolved = path.resolve(value);
  if (resolved === path.resolve("/Users/wanglei/Documents/派活AI") || resolved.startsWith(path.resolve("/Users/wanglei/Documents/派活AI") + path.sep)) {
    throw new Error(`${label}禁止触碰派活AI目录`);
  }
  return resolved;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`无法读取JSON ${file}: ${error.message}`);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function quoteSql(value) {
  return String(value).replaceAll("'", "''");
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on non-POSIX */ }
}

function createIsolatedDatabase(sourcePath, targetPath) {
  const source = assertSafePath(sourcePath, "--source-db");
  const target = assertSafePath(targetPath, "--db");
  if (!fs.existsSync(source)) throw new Error(`隔离库来源不存在：${source}`);
  const production = path.resolve(ROOT, "server/data/nanowork-industry.db");
  if (path.resolve(source) === production || path.resolve(target) === production) throw new Error("拒绝使用默认业务库");
  if (fs.existsSync(target)) throw new Error(`隔离库已存在，拒绝覆盖：${target}`);
  ensurePrivateDir(path.dirname(target));
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  try {
    sourceDb.exec(`VACUUM INTO '${quoteSql(target)}'`);
  } finally {
    sourceDb.close();
  }
  const db = new DatabaseSync(target);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    const tenants = db.prepare("SELECT id FROM tenants ORDER BY id").all();
    for (const tenant of tenants) {
      db.prepare("INSERT OR REPLACE INTO sys_config(key,value) VALUES(?,?)").run(
        `real_employee_matrix_isolated:${tenant.id}`,
        JSON.stringify("REAL_EMPLOYEE_MATRIX_ISOLATED_V1"),
      );
      db.prepare("INSERT OR REPLACE INTO sys_config(key,value) VALUES(?,?)").run(
        `real_feature_matrix_isolated:${tenant.id}`,
        JSON.stringify("REAL_FEATURE_MATRIX_ISOLATED_V1"),
      );
    }
    const apiKeyConfig = db.prepare("SELECT 1 FROM sys_config WHERE key IN ('yunwu_api_key','anthropic_api_key') LIMIT 1").get();
    if (apiKeyConfig) throw new Error("隔离库存在旧API Key配置，拒绝把密钥带入测试证据");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
  return target;
}

function prepareExistingDatabase(dbPath) {
  const resolved = assertSafePath(dbPath, "--db");
  if (!fs.existsSync(resolved)) throw new Error(`隔离库不存在：${resolved}`);
  const production = path.resolve(ROOT, "server/data/nanowork-industry.db");
  if (path.resolve(resolved) === production) throw new Error("拒绝使用默认业务库");
  const db = new DatabaseSync(resolved);
  try {
    const tenants = db.prepare("SELECT id FROM tenants ORDER BY id").all();
    for (const tenant of tenants) {
      const employeeMarker = db.prepare("SELECT value FROM sys_config WHERE key=?").get(`real_employee_matrix_isolated:${tenant.id}`)?.value;
      const featureMarker = db.prepare("SELECT value FROM sys_config WHERE key=?").get(`real_feature_matrix_isolated:${tenant.id}`)?.value;
      const parseMarker = (value) => {
        try { return JSON.parse(String(value || "null")); } catch { return String(value || ""); }
      };
      if (parseMarker(employeeMarker) !== "REAL_EMPLOYEE_MATRIX_ISOLATED_V1" || parseMarker(featureMarker) !== "REAL_FEATURE_MATRIX_ISOLATED_V1") {
        throw new Error(`租户#${tenant.id}缺少双矩阵隔离标记`);
      }
    }
  } finally {
    db.close();
  }
  return resolved;
}

async function waitHealth(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.ok === true && payload?.db === "up") return payload;
      last = `${response.status} ${JSON.stringify(payload)}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`隔离服务健康检查超时：${last}`);
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.token) throw new Error(`隔离服务登录失败：${response.status}`);
  return payload.token;
}

async function providerProbe(baseUrl, token) {
  try {
    const response = await fetch(`${baseUrl}/api/admin/api-config/test`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => null);
    return {
      httpStatus: response.status,
      ok: payload?.ok === true,
      readiness: payload?.readiness
        ? {
            effective: payload.readiness.effective,
            connected: payload.readiness.connected,
            verification: payload.readiness.verification,
            checkedAt: payload.readiness.lastCheck?.checkedAt || null,
            provider: payload.readiness.lastCheck?.evidence?.provider || null,
            models: Number(payload.readiness.lastCheck?.evidence?.models || 0) || null,
          }
        : null,
      error: payload?.ok === true ? null : String(payload?.error || "probe failed").slice(0, 240),
    };
  } catch (error) {
    return { httpStatus: null, ok: false, readiness: null, error: String(error.message).slice(0, 240) };
  }
}

function runChild(command, args, env, logPath) {
  ensurePrivateDir(path.dirname(logPath));
  const fd = fs.openSync(logPath, "a", 0o600);
  const child = spawn(command, args, {
    cwd: ROOT,
    env,
    stdio: ["ignore", fd, fd],
  });
  child.once("close", () => { try { fs.closeSync(fd); } catch { /* noop */ } });
  return child;
}

async function runCommand(args, env, logPath) {
  ensurePrivateDir(path.dirname(logPath));
  const fd = fs.openSync(logPath, "a", 0o600);
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", fd, fd] });
    child.once("error", (error) => { try { fs.closeSync(fd); } catch {} reject(error); });
    child.once("close", (code, signal) => {
      try { fs.closeSync(fd); } catch {}
      resolve({ code: code ?? 1, signal });
    });
  });
}

function stopChild(child) {
  if (!child || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 8_000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    try { child.kill("SIGTERM"); } catch { clearTimeout(timer); resolve(); }
  });
}

function redact(text) {
  return String(text || "")
    .replace(/(api[_-]?key|authorization|bearer|password|secret)\s*[:=]\s*[^\s,;]+/giu, (_match, label) => `${label}=${REDACTED}`)
    .replace(/https?:\/\/[^\s]*[?&](?:key|token|secret)=[^\s&]+/giu, REDACTED)
    .replace(/data:[^\s;]+;base64,[A-Za-z0-9+/=]+/gu, "data:<redacted>");
}

function safeName(value, fallback) {
  const clean = String(value || fallback).replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-").trim();
  return (clean || fallback).slice(0, 80);
}

function md(value) {
  return redact(String(value ?? "未记录")).replace(/\r\n/gu, "\n");
}

function executionEvidenceLabel(row, dbRow) {
  if (row.providerMode === "api" || Number(row.providerCallCount || 0) > 0 || Number(row.nativeVideoProviderCalls || 0) > 0) {
    return "api";
  }
  const billingApi =
    (row.billingAiMode === "api" || dbRow?.ai_mode === "api" || dbRow?.content_ai_mode === "api") &&
    (Number(row.billingInputTokens || row.inputTokens || 0) > 0 ||
      Number(row.billingOutputTokens || row.outputTokens || 0) > 0) &&
    ["settled", "pending_settlement"].includes(String(row.billingState || ""));
  if (billingApi) return "账务API已结算（provider快照缺失）";
  return row.providerMode || "未记录";
}

function fmt(value) {
  if (value === null || value === undefined || value === "") return "N/A";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return md(value);
}

function parseSnapshot(value) {
  try { return JSON.parse(String(value || "")); } catch { return null; }
}

// Keep the execution chain auditable without copying page bodies, prompts, or
// URLs into the Desktop report. The raw, redacted-at-source snapshot remains
// in the isolated DB; this summary records only counts, providers, gates and
// bounded routing metadata needed to prove the real network path.
function summarizeWebExecutionChain(web) {
  const channels = Array.isArray(web?.channels) ? web.channels : [];
  return channels.map((channel) => {
    const evidence = channel?.evidence && typeof channel.evidence === "object" ? channel.evidence : {};
    const row = {
      kind: String(channel?.kind || "unknown").slice(0, 80),
      provider: String(channel?.provider || evidence.provider || "").slice(0, 160) || null,
      attempted: channel?.attempted === true,
      ok: channel?.ok === true,
      externalCall: evidence.externalCall === true,
      resultCount: Array.isArray(channel?.results) ? channel.results.length : 0,
    };
    if (row.kind === "agentic_web_research") {
      row.model = String(evidence.model || "").slice(0, 80) || null;
      row.toolCalls = Number.isFinite(Number(evidence.toolCalls)) ? Number(evidence.toolCalls) : null;
      row.toolAttempts = Number.isFinite(Number(evidence.toolAttempts)) ? Number(evidence.toolAttempts) : null;
      row.qualityGate = evidence.qualityGate && typeof evidence.qualityGate === "object"
        ? {
            requiredSearches: Number(evidence.qualityGate.requiredSearches || 0),
            observedSearches: Number(evidence.qualityGate.observedSearches || 0),
            observedSuccessfulToolResults: Number(evidence.qualityGate.observedSuccessfulToolResults || 0),
            observedSources: Number(evidence.qualityGate.observedSources || 0),
            passed: evidence.qualityGate.passed === true,
          }
        : null;
    }
    if (row.kind === "location_intelligence") {
      row.poiSource = String(evidence.poiSource || "").slice(0, 160) || null;
      row.namedPoiCount = Number.isFinite(Number(evidence.namedPoiCount)) ? Number(evidence.namedPoiCount) : null;
      row.poiCounts = evidence.counts && typeof evidence.counts === "object" ? evidence.counts : null;
      row.isochrone = {
        required: evidence.isochroneRequired === true,
        complete: evidence.isochroneComplete === true,
        provider: String(evidence.isochroneProvider || "").slice(0, 160) || null,
        modes: Array.isArray(evidence.isochroneModes) ? evidence.isochroneModes.map((item) => String(item).slice(0, 40)) : [],
        minutes: Array.isArray(evidence.isochroneMinutes) ? evidence.isochroneMinutes.map((item) => Number(item)).filter((item) => Number.isFinite(item)) : [],
        error: evidence.isochroneError ? String(evidence.isochroneError).slice(0, 240) : null,
      };
    }
    if (channel?.note) row.note = String(channel.note).slice(0, 320);
    return row;
  });
}

function formatWebExecutionChainLines(chain) {
  if (!Array.isArray(chain) || !chain.length) {
    return ["- 本次执行快照未提供联网链路摘要；不能据此声称已联网。"];
  }
  return chain.map((item) => {
    let line = "- " + item.kind
      + "：provider=" + fmt(item.provider)
      + "；attempted=" + item.attempted
      + "；ok=" + item.ok
      + "；结果数=" + item.resultCount;
    if (item.kind === "agentic_web_research") {
      const gate = item.qualityGate || {};
      line += "；model=" + fmt(item.model)
        + "；toolCalls=" + fmt(item.toolCalls)
        + "；toolAttempts=" + fmt(item.toolAttempts)
        + "；qualityGate=" + (gate.passed === true ? "PASS" : "未通过/未记录")
        + "（required=" + fmt(gate.requiredSearches)
        + " observed=" + fmt(gate.observedSearches)
        + " successful=" + fmt(gate.observedSuccessfulToolResults)
        + " sources=" + fmt(gate.observedSources) + "）";
    }
    if (item.kind === "location_intelligence") {
      const iso = item.isochrone || {};
      line += "；POI来源=" + fmt(item.poiSource)
        + "；命名POI=" + fmt(item.namedPoiCount)
        + "；等时圈=" + (iso.complete === true
          ? "完成（" + (iso.modes || []).join("/") + " × " + (iso.minutes || []).join("/") + "分钟；" + fmt(iso.provider) + "）"
          : "未完成");
      if (iso.error) line += "；等时圈错误=" + md(iso.error);
    }
    if (item.note) line += "；note=" + md(item.note);
    return line;
  });
}

function unifiedGateSummary(row) {
  const gate = row?.unifiedGate;
  if (!gate || typeof gate !== "object") {
    return {
      status: "未执行",
      failedChecks: [],
      checks: [],
      demand: row?.acceptanceDemand || null,
      approvalDelta: row?.approvalDelta ?? null,
    };
  }
  return {
    status: gate.pass === true ? "PASS" : "FAIL/BLOCKED",
    failedChecks: Array.isArray(gate.failedChecks) ? gate.failedChecks.map(String) : [],
    checks: Array.isArray(gate.checks)
      ? gate.checks.map((item) => ({
          id: String(item?.id || ""),
          status: String(item?.status || ""),
          pass: item?.pass === true,
          reason: String(item?.reason || ""),
        }))
      : [],
    demand: gate.demand?.text || row?.acceptanceDemand || null,
    approvalDelta: row?.approvalDelta ?? gate.checks?.find((item) => item?.id === "boss_zero_approvals")?.evidence?.delta ?? null,
  };
}

function dbTenantId(db, row) {
  const explicit = Number(row.tenantId || row.tenant_id || 0);
  if (explicit > 0) return explicit;
  const businessId = Number(row.businessId || 0);
  if (!businessId) return 0;
  try {
    let found = null;
    if (row.domain === "restaurant") {
      found = db.prepare("SELECT tenant_id FROM agent_tasks WHERE id=?").get(businessId);
    } else if (row.nativeVideo === true || Number(row.idx) === 10) {
      found = db.prepare("SELECT tenant_id FROM media_jobs WHERE id=?").get(businessId);
    } else {
      found = db.prepare("SELECT tenant_id FROM content_employee_runs WHERE id=? AND employee_idx=?").get(businessId, Number(row.idx));
    }
    return Number(found?.tenant_id || 0);
  } catch {
    return 0;
  }
}

function dbOutput(db, row) {
  const tenantId = dbTenantId(db, row);
  const businessId = Number(row.businessId || 0);
  if (!tenantId || !businessId) return null;
  if (row.domain === "restaurant") {
    return db.prepare(`SELECT t.*,c.body AS output_body,c.status AS output_status,c.ai_mode AS content_ai_mode
      FROM agent_tasks t LEFT JOIN contents c ON c.tenant_id=t.tenant_id AND c.id=t.output_id
      WHERE t.tenant_id=? AND t.id=?`).get(tenantId, businessId) || null;
  }
  if (row.nativeVideo === true || Number(row.idx) === 10) {
    return db.prepare("SELECT * FROM media_jobs WHERE tenant_id=? AND id=?").get(tenantId, businessId) || null;
  }
  return db.prepare("SELECT * FROM content_employee_runs WHERE tenant_id=? AND id=? AND employee_idx=?").get(tenantId, businessId, Number(row.idx)) || null;
}

// Read the authoritative hold/log linkage even when a run is still held or
// failed before settlement.  The runner's billingId/creditLogId fields are
// intentionally settlement-oriented and may be absent in that state; the
// evidence report must still identify the real preauthorization rows without
// turning the hold into a customer charge.
function dbBillingLink(db, row) {
  const tenantId = dbTenantId(db, row);
  const businessId = Number(row.businessId || 0);
  if (!tenantId || !businessId) return null;
  return db.prepare(`SELECT h.id AS holdId,h.status AS holdStatus,h.held_credits AS heldCredits,h.settled_credits AS settledCredits,
      h.log_id AS creditLogId,l.ai_mode AS logAiMode,l.input_tokens AS logInputTokens,l.output_tokens AS logOutputTokens,
      l.cost_yuan AS logCostYuan,l.credits AS logCredits,l.model AS logModel,l.note AS logNote
    FROM credit_holds h LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    WHERE h.tenant_id=? AND h.ref_id=? ORDER BY h.id DESC LIMIT 1`).get(tenantId, businessId) || null;
}

function authoritativeBilling(db, matrix) {
  const rows = Object.values(matrix?.jobs || {}).map((item) => item?.latest).filter(Boolean);
  const ids = [...new Set(rows.map((row) => Number(row.creditLogId)).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const tenantIds = [...new Set(rows.map((row) => dbTenantId(db, row)).filter((id) => id > 0))];
  const businessIds = [...new Set(rows.map((row) => Number(row.businessId)).filter((id) => Number.isSafeInteger(id) && id > 0))];
  let holdRows = [];
  if (tenantIds.length === 1 && businessIds.length) {
    const businessPlaceholders = businessIds.map(() => "?").join(",");
    holdRows = db.prepare(`SELECT id,log_id,status,held_credits,settled_credits,ref_id FROM credit_holds WHERE tenant_id=? AND ref_id IN (${businessPlaceholders}) ORDER BY id`).all(tenantIds[0], ...businessIds);
  }
  const holdEvidence = {
    holdCount: holdRows.length,
    holdIds: holdRows.map((item) => Number(item.id)).filter((id) => id > 0),
    holdLogIds: holdRows.map((item) => Number(item.log_id)).filter((id) => id > 0),
    heldCredits: holdRows.reduce((sum, item) => sum + Number(item.held_credits || 0), 0),
    settledHoldCredits: holdRows.reduce((sum, item) => sum + Number(item.settled_credits || 0), 0),
    statuses: [...new Set(holdRows.map((item) => String(item.status || "")).filter(Boolean))],
  };
  if (tenantIds.length !== 1 || !ids.length) return { tenantId: tenantIds[0] || null, logCount: 0, inputTokens: 0, outputTokens: 0, chargedCredits: 0, chargedCostYuan: 0, ...holdEvidence };
  const placeholders = ids.map(() => "?").join(",");
  const result = db.prepare(`SELECT COUNT(*) AS n,COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens,COALESCE(SUM(credits),0) AS chargedCredits,COALESCE(SUM(cost_yuan),0) AS chargedCostYuan FROM credit_logs WHERE tenant_id=? AND id IN (${placeholders})`).get(tenantIds[0], ...ids);
  return { tenantId: tenantIds[0], logCount: Number(result?.n || 0), inputTokens: Number(result?.inputTokens || 0), outputTokens: Number(result?.outputTokens || 0), chargedCredits: Number(result?.chargedCredits || 0), chargedCostYuan: Number(result?.chargedCostYuan || 0), ...holdEvidence };
}

function aggregateWebResearchFromRows(rows, db) {
  const evidenceRows = rows.map((row) => {
    const dbRow = dbOutput(db, row);
    const snapshot = parseSnapshot(dbRow?.employee_web_snapshot);
    return row.webResearchEvidence || summarizeWebResearchEvidence(
      snapshot?.web || snapshot?.webEvidence || null,
    );
  }).filter((item) => item && typeof item === "object");
  const usageRows = evidenceRows
    .map((item) => item.agenticWebResearch || item.usage || null)
    .filter((item) => item && typeof item === "object");
  const pricedRows = usageRows.filter((item) => item.costUsd != null && Number.isFinite(Number(item.costUsd)));
  return {
    attempts: evidenceRows.length,
    inputTokens: usageRows.reduce((sum, item) => sum + Number(item.inputTokens || 0), 0),
    outputTokens: usageRows.reduce((sum, item) => sum + Number(item.outputTokens || 0), 0),
    cacheReadInputTokens: usageRows.reduce((sum, item) => sum + Number(item.cacheReadInputTokens || 0), 0),
    usageRows: usageRows.length,
    pricedRows: pricedRows.length,
    costUsd: usageRows.length > 0 && usageRows.every((item) => item.costUsd != null && Number.isFinite(Number(item.costUsd)))
      ? usageRows.reduce((sum, item) => sum + Number(item.costUsd || 0), 0)
      : null,
    costCurrency: "USD",
    costComplete: usageRows.length > 0 && usageRows.every((item) => item.costUsd != null && Number.isFinite(Number(item.costUsd))),
  };
}

function employeeFiles(rootDir, row, db) {
  const domainLabel = row.domain === "restaurant" ? "餐饮" : "内容";
  const folder = path.join(rootDir, `${domainLabel}-${Number(row.idx)}-${safeName(row.employeeName || row.employeeKey, `${domainLabel}-${row.idx}`)}`);
  ensurePrivateDir(folder);
  const dbRow = dbOutput(db, row);
  const billingLink = dbBillingLink(db, row);
  const snapshot = parseSnapshot(dbRow?.snapshot_json);
  const executionSnapshot = parseSnapshot(dbRow?.employee_web_snapshot);
  const webRaw = executionSnapshot?.webEvidence || executionSnapshot?.web || null;
  const webResearch = row.webResearchEvidence || summarizeWebResearchEvidence(webRaw);
  const webChain = summarizeWebExecutionChain(webRaw);
  const sourceQuality = webRaw?.sourceQuality && typeof webRaw.sourceQuality === "object"
    ? webRaw.sourceQuality
    : null;
  let approvalCountAfter = null;
  try {
    approvalCountAfter = Number(db.prepare("SELECT COUNT(*) AS n FROM approvals").get()?.n);
    if (!Number.isFinite(approvalCountAfter)) approvalCountAfter = null;
  } catch {
    approvalCountAfter = null;
  }
  const approvalCountBefore = Number.isFinite(Number(row.approvalCountBefore)) ? Number(row.approvalCountBefore) : null;
  const approvalDelta = row.approvalDelta ?? (approvalCountBefore !== null && approvalCountAfter !== null ? approvalCountAfter - approvalCountBefore : null);
  const gate = unifiedGateSummary(row);
  const inputLines = [
    `# ${domainLabel}数字员工 #${row.idx} 输入`,
    "",
    `- 员工：${fmt(row.employeeName || row.employeeKey || `#${row.idx}`)}`,
    `- 员工键：${fmt(row.employeeKey)}`,
    `- 运行批次：${fmt(row.invocationId)}`,
    `- 业务ID：${fmt(row.businessId)}`,
    `- 真实派活时间：${fmt(row.dispatchedAt)}`,
    `- 输入校验：${row.inputEvidenceValid === true ? "通过" : row.inputEvidenceValid === false ? "失败" : "未记录"}`,
    `- 任务标题：${fmt(row.taskTitle || dbRow?.title || dbRow?.prompt)}`,
    `- 任务类型：${fmt(dbRow?.type || row.acceptanceKind)}`,
    `- 输入正文哈希：${fmt(row.taskRequirementHash)}`,
    `- 一句真实需求：${fmt(gate.demand)}`,
    `- 统一验收门禁：${gate.status}`,
    `- 输入附件/参考图：${fmt(row.fileId || row.nativeVideoInput?.referenceImage || (Array.isArray(dbRow?.fileIds) ? dbRow.fileIds.join(",") : null))}`,
    "",
    "## 实际输入摘要",
    "",
    md(dbRow?.requirement || row.nativeVideoInput?.brief || row.taskTitle || "矩阵输入摘要未在JSON中保留；以数据库真实任务记录为准。"),
  ];
  const outputBody = dbRow?.output_body || dbRow?.result_md || dbRow?.body_snapshot || dbRow?.error || row.nativeVideoSnapshot?.reason || "数据库未提供可读正文；保留状态、哈希与阻断原因。";
  const outputLines = [
    `# ${domainLabel}数字员工 #${row.idx} 输出`,
    "",
    `- 员工：${fmt(row.employeeName || row.employeeKey)}`,
    `- 业务ID：${fmt(row.businessId)}`,
    `- 当前判定：${fmt(row.verdict)}`,
    `- 终态：${fmt(row.terminalStatus || dbRow?.status)}`,
    `- 输出ID：${fmt(row.outputId || row.contentId || row.materialId || dbRow?.output_id)}`,
    `- 结果哈希：${fmt(row.resultHash || row.primaryArtifactHash || row.compositionSha256)}`,
    `- 统一验收门禁：${gate.status}`,
    `- 主产物哈希复验：${row.primaryArtifactHashValid === true || row.artifactReadbackValid === true ? "通过" : row.primaryArtifactHashValid === false || row.artifactReadbackValid === false ? "失败/不适用" : "未记录"}`,
    `- 视频计划/成片：${row.nativeVideo === true ? md(JSON.stringify(row.nativeVideoSnapshot || row.nativeVideoComposition || {})) : "不适用"}`,
    "",
    "## 实际输出正文或失败/阻断说明",
    "",
    md(outputBody),
    "",
    "## 失败与阻断原因",
    "",
    ...(Array.isArray(row.failureReasons) && row.failureReasons.length ? row.failureReasons.map((reason) => `- ${md(reason)}`) : ["- 无记录"]),
    "",
    "## 统一验收门禁结果",
    "",
    `- 一句真实需求：${fmt(gate.demand)}`,
    `- 门禁状态：${gate.status}`,
    `- Boss审批增量：${fmt(gate.approvalDelta)}（测试期要求0）`,
    ...(gate.failedChecks.length
      ? [`- 未通过检查：${gate.failedChecks.join("、")}`]
      : gate.status === "未执行"
        ? ["- 未通过检查：尚未执行，不能作为通过"]
        : ["- 未通过检查：无"]),
  ];
  const providerUsage = Number(row.providerInputTokens || row.inputTokens || 0) + Number(row.providerOutputTokens || row.outputTokens || 0);
  const webUsage = webResearch?.agenticWebResearch || webResearch?.usage || {};
  const webTokenTotal = Number(webUsage.inputTokens || 0) + Number(webUsage.outputTokens || 0);
  const finalProviderCostYuan = row.providerEstimatedCostYuan;
  const webCostUsd = webUsage.costUsd;
  const finalProviderCalled = row.providerMode === "api"
    || Number(row.providerCallCount || 0) > 0
    || (Array.isArray(row.providerAttempts) && row.providerAttempts.length > 0);
  const agenticResearchCalled = Number(webResearch?.agenticWebResearch?.channelCount || 0) > 0
    || Number(webResearch?.channelCount || 0) > 0
    || webTokenTotal > 0;
  const reportLines = [
    `# ${domainLabel}数字员工 #${row.idx} 执行力与费用报告`,
    "",
    `- 判定：${fmt(row.verdict)}`,
    `- 真实云调用：${fmt(executionEvidenceLabel(row, dbRow))}`,
    `- 云调用分层：最终生成模型=${finalProviderCalled ? "已调用" : "未调用"}；联网agentic调研=${agenticResearchCalled ? "已调用" : "未调用"}`,
    `- 提供商/模型：${fmt(row.providerModel || row.model || dbRow?.model)}`,
    `- 提供商尝试次数/摘要：${fmt(Array.isArray(row.providerAttempts) ? row.providerAttempts.length : null)} / ${fmt(row.providerAttemptSummary)}`,
    `- 输入Token：${fmt(row.inputTokens || row.providerInputTokens)}`,
    `- 输出Token：${fmt(row.outputTokens || row.providerOutputTokens)}`,
    `- Token合计：${providerUsage}`,
    `- 最终生成供应商成本估算（CNY，非客户实扣）：${fmt(finalProviderCostYuan)}`,
    `- 联网调研Token（agentic WebSearch）：${webTokenTotal}`,
    `- 联网调研供应商成本估算（USD，非客户实扣）：${fmt(webCostUsd)}`,
    `- 供应商成本总计（分币种，未擅自换算）：最终生成=${fmt(finalProviderCostYuan)} CNY；联网调研=${fmt(webCostUsd)} USD`,
    `- 客户账本实扣人民币：${fmt(row.chargedCostYuan)}`,
    `- 客户账本实扣积分：${fmt(row.chargedCredits)}`,
    `- 账务状态：${fmt(row.billingState || billingLink?.holdStatus || (dbRow?.status === "阻塞" ? "not_held" : dbRow?.status))}`,
    `- hold / credit log：${fmt(row.billingId ?? billingLink?.holdId)} / ${fmt(row.creditLogId ?? billingLink?.creditLogId)}`,
    `- hold明细（仅预授权，不代表客户实扣）：状态=${fmt(billingLink?.holdStatus)}；预授权积分=${fmt(billingLink?.heldCredits)}；结算积分=${fmt(billingLink?.settledCredits)}`,
    `- 账本余额前/后：${fmt(row.balanceBefore)} / ${fmt(row.balanceAfter || row.tenantBalance)}`,
    `- 耗时：${fmt(row.latencyMs)} ms`,
    `- 外发/发布：${row.externalPublish === false ? "明确未执行" : "未能证明为false"}`,
    `- 统一门禁：${gate.status}；Boss审批记录前/后/增量=${fmt(approvalCountBefore)} / ${fmt(approvalCountAfter)} / ${fmt(approvalDelta)}`,
    `- 证据来源：${fmt(row.billingReconciliation?.databaseIdentity || row.billingEvidenceSource || "隔离SQLite权威行 + 真实HTTP响应")}`,
    "",
    "## 费用口径",
    "",
    "供应商估算成本与客户账本实扣分开记录；0积分/全额退款不代表供应商没有成本。未知价格与未发生调用记为N/A，不写0冒充免费。",
    "联网调研（agentic WebSearch）成本来自本次执行快照 evidence.usage/evidence.costUsd；最终生成模型成本按模型价快照估算为CNY。两种币种不做无来源汇率换算。",
    "",
    "## 联网/API链路摘要（脱敏）",
    ...formatWebExecutionChainLines(webChain),
    `- 来源质量双锚点：${sourceQuality?.passed === true ? "PASS" : "FAIL/BLOCKED"}；locationAnchor=${fmt(sourceQuality?.locationAnchorCount)}；directRestaurant=${fmt(sourceQuality?.directRestaurantSourceCount)}；accepted=${fmt(sourceQuality?.acceptedCount)}；rejected=${fmt(sourceQuality?.rejectedCount)}`,
    "",
    "## 统一验收门禁（逐项）",
    "",
    `- 一句真实需求：${fmt(gate.demand)}`,
    `- 状态：${gate.status}`,
    `- Boss测试期审批增量：${fmt(gate.approvalDelta)}（要求0）`,
    ...(gate.checks.length
      ? gate.checks.map((item) => `- ${item.id || "unknown"}：${item.status || "未记录"}；${md(item.reason || "")}`)
      : ["- 尚未取得真实执行门禁证据；不可将岗位标记为通过。"]),
  ];
  const files = {
    [REQUIRED_FILES[0]]: `${inputLines.join("\n")}\n`,
    [REQUIRED_FILES[1]]: `${outputLines.join("\n")}\n`,
    [REQUIRED_FILES[2]]: `${reportLines.join("\n")}\n`,
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), redact(content), { mode: 0o600 });
  return { folder, files: Object.keys(files).map((name) => ({ name, path: path.join(folder, name), sha256: sha256(files[name]) })) };
}

function writeRootReports(rootDir, matrix, featureMatrix, inventory, matrixDb, context, employeeFolders) {
  ensurePrivateDir(rootDir);
  const jobs = Object.entries(matrix?.jobs || {}).map(([key, value]) => ({ key, ...(value?.latest || {}) })).filter((row) => row.idx !== undefined);
  const passed = jobs.filter((row) => row.pass === true).length;
  const blocked = jobs.filter((row) => String(row.verdict || "").startsWith("BLOCKED") || row.nativeVideoBlocked === true).length;
  const failed = jobs.filter((row) => row.pass !== true && !row.nativeVideoBlocked).length;
  const dbBilling = authoritativeBilling(matrixDb, matrix);
  const summary = matrix?.summary || {};
  const featureSummary = featureMatrix?.summary || {};
  const webResearch = summary.webResearch || summary.current?.webResearch || aggregateWebResearchFromRows(jobs, matrixDb);
  const webResearchCostUsd = webResearch.costUsd;
  const webResearchTokens = Number(webResearch.inputTokens || 0) + Number(webResearch.outputTokens || 0);
  const costLines = [
    "# 费用汇总（权威隔离SQLite）",
    "",
    `- 员工矩阵岗位数：${jobs.length}`,
    `- 员工矩阵输入/输出Token（latest JSON）：${fmt(summary.tokens?.input)} / ${fmt(summary.tokens?.output)}`,
    `- 员工矩阵客户实扣积分（latest JSON）：${fmt(summary.chargedCredits ?? summary.credits)}`,
    `- 员工矩阵客户实扣人民币（latest JSON）：${fmt(summary.chargedCostYuan ?? summary.costYuan)}`,
    `- 员工矩阵最终生成供应商成本估算（CNY，非客户实扣）：${fmt(summary.providerEstimatedCostYuan)}`,
    `- 员工矩阵联网调研Token（agentic WebSearch）：${webResearchTokens}`,
    `- 员工矩阵联网调研供应商成本估算（USD，非客户实扣）：${fmt(webResearchCostUsd)}`,
    `- 员工矩阵供应商成本总计（分币种，未擅自换算）：最终生成=${fmt(summary.providerEstimatedCostYuan)} CNY；联网调研=${fmt(webResearchCostUsd)} USD`,
    `- 功能矩阵输入/输出Token：${fmt(featureSummary.tokens?.input)} / ${fmt(featureSummary.tokens?.output)}`,
    `- 功能矩阵客户实扣积分：${fmt(featureSummary.chargedCredits ?? featureSummary.credits)}`,
    `- 功能矩阵客户实扣人民币：${fmt(featureSummary.chargedCostYuan ?? featureSummary.costYuan)}`,
    "",
    "## 数据库交叉核对",
    "",
    `- tenant_id：${fmt(dbBilling.tenantId)}`,
    `- 客户结算credit log唯一行数：${fmt(dbBilling.logCount)}`,
    `- 权威输入/输出Token：${fmt(dbBilling.inputTokens)} / ${fmt(dbBilling.outputTokens)}`,
    `- 权威客户实扣积分：${fmt(dbBilling.chargedCredits)}`,
    `- 权威客户实扣人民币：${fmt(dbBilling.chargedCostYuan)}`,
    `- 权威预授权hold行数/IDs：${fmt(dbBilling.holdCount)} / ${fmt((dbBilling.holdIds || []).join(",") || null)}`,
    `- 预授权关联credit_log IDs（不计入客户实扣）：${fmt((dbBilling.holdLogIds || []).join(",") || null)}`,
    `- 预授权积分/状态（不计入客户实扣）：${fmt(dbBilling.heldCredits)} / ${fmt((dbBilling.statuses || []).join(",") || null)}`,
    "",
    "若JSON与数据库不一致，以同一隔离库中按tenant_id和credit_log_id回读的权威行作为最终账务口径。",
    "联网调研成本来自任务执行快照中的 agentic_web_research evidence.usage/evidence.costUsd；与最终生成模型成本、客户账本实扣严格分列；无来源汇率时不把USD伪合并为CNY。",
  ];
  fs.writeFileSync(path.join(rootDir, "费用汇总.md"), `${costLines.join("\n")}\n`, { mode: 0o600 });

  const matrixLines = [
    "# 全功能矩阵（代码入口盘点 + 证据合并）",
    "",
    `- 总入口数：${fmt(inventory?.features?.length)}`,
    `- 分类统计：${md(JSON.stringify(inventory?.counts || {}))}`,
    "- 既有真实功能矩阵只覆盖其声明的用例；未将36条当作所有功能。",
    "- 统一验收门禁：一句真实需求；公开信息自行联网且不反问用户；真实API/数据分析/岗位技能调用；业务主结果；Boss测试期审批增量必须为0；输入/输出/执行力/费用证据齐全。",
    "",
    "|分类|状态|入口|方法|输入|输出|费用|统一门禁|审批/待审阅|证据|",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const row of inventory?.features || []) {
    const cost = row.cost || {};
    const gateStatus = row.acceptanceGate?.status || "UNVERIFIED";
    const reviewStatus = row.reviewPolicy?.status || "N/A";
    matrixLines.push(`|${md(row.coverageClass)}|${md(row.status)}|${md(row.path || row.id)}|${md(row.method)}|${md(row.input || "未执行").replaceAll("|", "\\|").slice(0, 160)}|${md(row.output || "未执行").replaceAll("|", "\\|").slice(0, 160)}|${fmt(cost.chargedCredits)} credits / ${fmt(cost.chargedCostYuan)} 元|${md(gateStatus)}|${md(reviewStatus)}|${md(row.evidenceType)}|`);
  }
  fs.writeFileSync(path.join(rootDir, "全功能矩阵.md"), `${matrixLines.join("\n")}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(rootDir, "full-feature-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });

  const failures = [
    "# 失败与阻断清单",
    "",
    `- 员工矩阵：PASS=${passed}，BLOCKED=${blocked}，FAIL/未通过=${failed}`,
    "",
    "## 员工",
    "",
  ];
  for (const row of jobs.filter((item) => item.pass !== true)) {
    failures.push(`- ${row.key || `${row.domain}:${row.idx}`}：${row.verdict || "未通过"}；${(row.failureReasons || row.videoGateReasons || [row.httpError || row.terminalStatus || "未记录"]).map(md).join("；")}`);
  }
  failures.push("", "## 全功能入口未通过/未验证", "");
  for (const row of inventory?.features || []) {
    if (row.status !== "PASS" || ["外部副作用安全阻断", "缺配置阻断", "未执行（无证据）"].includes(row.coverageClass)) {
      failures.push(`- ${row.id}：${row.coverageClass}；${row.status}；${md(row.caveat || "未记录")}`);
    }
  }
  fs.writeFileSync(path.join(rootDir, "失败与阻断清单.md"), `${failures.join("\n")}\n`, { mode: 0o600 });

  const summaryLines = [
    "# 总览",
    "",
    `- 生成时间：${context.generatedAt}`,
    `- 服务：${context.baseUrl}`,
    `- 导出模式：${context.executionMode || "real-run"}`,
    `- 隔离库：${context.databasePath}`,
    `- Scheduler：${context.scheduler}`,
    `- 员工矩阵：${jobs.length}岗，PASS=${passed}，BLOCKED=${blocked}，FAIL/未通过=${failed}`,
    `- 功能矩阵：${fmt(featureSummary.total)} 条（仅其声明范围，不等于所有功能）`,
    `- 全功能入口盘点：${fmt(inventory?.features?.length)} 条；分类=${md(JSON.stringify(inventory?.counts || {}))}`,
    "- 统一验收门禁作为每名员工与全功能清单的独立状态；缺证据标UNVERIFIED/FAIL，不以能力清单或底稿冒充业务结果。",
    `- 成本分列：最终生成模型供应商估算=${fmt(summary.providerEstimatedCostYuan)} CNY；联网调研供应商估算=${fmt(webResearchCostUsd)} USD；未提供汇率时不擅自相加。`,
    "- 外部支付、消息、发布和视频付费动作没有自动外发；视频安全门不满足时仅保留BLOCKED证据。",
    "- API Key、登录密码和完整内部提示词未写入桌面交付物。",
    "",
    "## 员工目录",
    "",
    ...employeeFolders.map((item) => `- [${path.basename(item.folder)}](${item.folder})`),
  ];
  fs.writeFileSync(path.join(rootDir, "00总览.md"), `${summaryLines.join("\n")}\n`, { mode: 0o600 });

  const index = {
    schemaVersion: "nanowork.desktop-evidence-index.v1",
    generatedAt: context.generatedAt,
    policy: {
      requiredEmployeeFiles: REQUIRED_FILES,
      noSecrets: true,
      noExternalPublish: true,
      unifiedAcceptanceGate: {
        schema: "nanowork.unified-acceptance-gate.v1",
        bossApprovalDeltaRequired: 0,
        publicInfoNoUserQuestion: true,
        requireRealApiTokensAndBusinessResult: true,
      },
    },
    context,
    employees: employeeFolders.map((item) => ({ folder: item.folder, files: item.files })),
    rootFiles: ["00总览.md", "全功能矩阵.md", "费用汇总.md", "失败与阻断清单.md", "full-feature-inventory.json"],
    digest: sha256(JSON.stringify(employeeFolders)),
  };
  fs.writeFileSync(path.join(rootDir, "证据索引.json"), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(rootDir, "证据索引.md"), `# 证据索引\n\n- 每名员工固定文件：${REQUIRED_FILES.join("、")}\n- 详细JSON：证据索引.json\n- 目录摘要哈希：${index.digest}\n`, { mode: 0o600 });
}

function scanEmployeeFolders(rootDir) {
  const dirs = fs.readdirSync(rootDir, { withFileTypes: true }).filter((item) => item.isDirectory() && /^(餐饮|内容)-\d+-/u.test(item.name));
  const invalid = [];
  for (const dir of dirs) {
    const names = fs.readdirSync(path.join(rootDir, dir.name)).sort();
    if (names.length !== REQUIRED_FILES.length || names.join("\u0000") !== [...REQUIRED_FILES].sort().join("\u0000")) invalid.push({ folder: dir.name, files: names });
  }
  return { folders: dirs.length, invalid };
}

async function main() {
  assertSafePath(options.outDir, "--out-dir");
  if (fs.existsSync(options.outDir) && !options.skipRun) throw new Error(`输出目录已存在；为避免覆盖请换--out-dir：${options.outDir}`);
  ensurePrivateDir(options.outDir);
  const runtimeDir = path.join(ROOT, "artifacts/real-matrix-runtime", path.basename(options.outDir));
  ensurePrivateDir(runtimeDir);
  // A skip-run export is often used to refresh reports after a long-running
  // canary has already finished.  Reuse the prior run context when present so
  // the refresh does not relabel a real loopback/API run as "未执行" merely
  // because this invocation did not issue HTTP calls.
  let priorContext = null;
  const priorContextPath = path.join(options.outDir, "运行上下文.json");
  if (options.skipRun && fs.existsSync(priorContextPath)) {
    try {
      const candidate = readJson(priorContextPath);
      if (candidate && typeof candidate === "object") priorContext = candidate;
    } catch {
      // A malformed/partial prior context must not make a read-only export
      // fail; the resulting report will explicitly use the skip-run marker.
    }
  }
  const databasePath = options.db
    ? prepareExistingDatabase(options.db)
    : createIsolatedDatabase(options.sourceDb, path.join(runtimeDir, "nanowork-isolated.db"));
  const employeeMatrixPath = options.employeeMatrix || path.join(runtimeDir, "real-employee-matrix.json");
  const featureMatrixPath = options.featureMatrix || path.join(runtimeDir, "real-feature-matrix.json");
  let recoveredMatrixContext = null;
  if (options.skipRun && fs.existsSync(employeeMatrixPath)) {
    try {
      const existingMatrix = readJson(employeeMatrixPath);
      const invocations = Array.isArray(existingMatrix?.run?.invocations) ? existingMatrix.run.invocations : [];
      const latestInvocation = invocations.at(-1) || null;
      const runtimeEvidence = latestInvocation?.runtimeEvidence || null;
      const matrixBaseUrl = String(existingMatrix?.run?.baseUrl || "");
      let loopbackBaseUrl = "";
      try {
        if (matrixBaseUrl) {
          assertLoopback(matrixBaseUrl);
          loopbackBaseUrl = matrixBaseUrl;
        }
      } catch {
        // Ignore stale/non-loopback metadata; skip-run remains read-only.
      }
      recoveredMatrixContext = {
        baseUrl: loopbackBaseUrl,
        generatedAt: String(existingMatrix?.createdAt || latestInvocation?.startedAt || ""),
        providerProbe: runtimeEvidence?.provider
          ? {
              recoveredFromEmployeeMatrix: true,
              provider: String(runtimeEvidence.provider).slice(0, 120),
              available: runtimeEvidence.available === true,
              capturedAt: runtimeEvidence.checkedAt || null,
            }
          : null,
      };
    } catch {
      // A malformed/partial matrix must not make a read-only export fail.
    }
  }
  const priorBaseUrl = String(priorContext?.baseUrl || "");
  const priorLoopback = (() => {
    try {
      if (!priorBaseUrl) return "";
      assertLoopback(priorBaseUrl);
      return priorBaseUrl;
    } catch {
      return "";
    }
  })();
  let baseUrl = options.baseUrl || (options.skipRun ? (priorLoopback || recoveredMatrixContext?.baseUrl || "") : "");
  let service = null;
  let serviceLog = String(priorContext?.serviceLog || path.join(runtimeDir, "service.log"));
  let probe = options.skipRun ? (priorContext?.providerProbe || recoveredMatrixContext?.providerProbe || null) : null;
  const generatedAt = new Date().toISOString();
  try {
    if (!options.skipRun && !options.noStart) {
      const port = 33107 + Math.floor(Math.random() * 500);
      baseUrl = `http://127.0.0.1:${port}`;
      const env = {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        NANOWORK_DB: databasePath,
        ENABLE_SCHEDULER: "false",
        NODE_ENV: "development",
      };
      service = runChild(process.execPath, ["--no-warnings", "server/src/index.js"], env, serviceLog);
      await waitHealth(baseUrl);
      const username = String(process.env.MATRIX_USERNAME || process.env.NANOWORK_ACCEPT_USERNAME || "guan");
      const password = String(process.env.MATRIX_PASSWORD || process.env.NANOWORK_ACCEPT_PASSWORD || "123456");
      const token = await login(baseUrl, username, password);
      probe = await providerProbe(baseUrl, token);
    } else if (!options.skipRun) {
      if (!baseUrl) throw new Error("--no-start-service必须同时指定--base-url");
      assertLoopback(baseUrl);
    }
    if (!options.skipRun) {
      const commonEnv = {
        ...process.env,
        MATRIX_USERNAME: process.env.MATRIX_USERNAME || process.env.NANOWORK_ACCEPT_USERNAME || "guan",
        MATRIX_PASSWORD: process.env.MATRIX_PASSWORD || process.env.NANOWORK_ACCEPT_PASSWORD || "123456",
        MATRIX_BASE_URL: baseUrl,
        MATRIX_DB: databasePath,
        ENABLE_SCHEDULER: "false",
      };
      const employeeArgs = ["--no-warnings", "scripts/run-real-employee-matrix.mjs", "--base-url", baseUrl, "--db", databasePath, "--out", employeeMatrixPath, "--concurrency", "1"];
      if (options.only) employeeArgs.push("--only", options.only);
      if (options.force) employeeArgs.push("--force");
      if (options.timeoutMs) employeeArgs.push("--timeout-ms", options.timeoutMs);
      const employeeResult = await runCommand(employeeArgs, commonEnv, path.join(runtimeDir, "employee-runner.log"));
      if (employeeResult.code !== 0) process.stderr.write(`员工矩阵退出码=${employeeResult.code}；证据仍保留\n`);
      if (!options.skipFeatures) {
        const featureArgs = ["--no-warnings", "scripts/run-real-feature-matrix.mjs", "--base-url", baseUrl, "--db", databasePath, "--out", featureMatrixPath, "--concurrency", "1"];
        if (options.featureOnly) featureArgs.push("--only", options.featureOnly);
        if (options.timeoutMs) featureArgs.push("--timeout-ms", options.timeoutMs);
        const featureResult = await runCommand(featureArgs, {
          ...commonEnv,
          MATRIX_BOSS_USERNAME: commonEnv.MATRIX_USERNAME,
          MATRIX_BOSS_PASSWORD: commonEnv.MATRIX_PASSWORD,
          MATRIX_MANAGER_USERNAME: commonEnv.MATRIX_USERNAME,
          MATRIX_MANAGER_PASSWORD: commonEnv.MATRIX_PASSWORD,
          MATRIX_EMPLOYEE_USERNAME: commonEnv.MATRIX_USERNAME,
          MATRIX_EMPLOYEE_PASSWORD: commonEnv.MATRIX_PASSWORD,
        }, path.join(runtimeDir, "feature-runner.log"));
        if (featureResult.code !== 0) process.stderr.write(`功能矩阵退出码=${featureResult.code}；证据仍保留\n`);
      }
    }
  } finally {
    await stopChild(service);
  }
  if (!fs.existsSync(employeeMatrixPath)) throw new Error(`员工矩阵证据不存在：${employeeMatrixPath}`);
  const matrix = readJson(employeeMatrixPath);
  const featureMatrix = fs.existsSync(featureMatrixPath) ? readJson(featureMatrixPath) : null;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const inventoryPath = path.join(runtimeDir, "full-feature-inventory.json");
    const inventoryArgs = ["--no-warnings", "scripts/build-full-feature-inventory.mjs", "--out", inventoryPath, "--employee-matrix", employeeMatrixPath];
    if (featureMatrix && fs.existsSync(featureMatrixPath)) inventoryArgs.push("--feature-matrix", featureMatrixPath);
    if (options.browserEvidence) inventoryArgs.push("--browser-evidence", options.browserEvidence);
    const inventoryResult = await runCommand(inventoryArgs, process.env, path.join(runtimeDir, "inventory.log"));
    if (inventoryResult.code !== 0) throw new Error(`全功能清单生成失败：${inventoryResult.code}`);
    const inventory = readJson(inventoryPath);
    const employeeFolders = [];
    for (const [key, slot] of Object.entries(matrix.jobs || {})) {
      const row = { key, ...(slot?.latest || {}) };
      if (row.idx === undefined) continue;
      employeeFolders.push(employeeFiles(options.outDir, row, db));
    }
    // If a filtered run is requested, do not manufacture absent employees.
    // A full run must have exactly 72 folders (61 restaurant + 11 content)
    // before it can be called complete.
    const scan = scanEmployeeFolders(options.outDir);
    writeRootReports(options.outDir, matrix, featureMatrix, inventory, db, {
      generatedAt,
      baseUrl: baseUrl || "未执行（skip-run）",
      executionMode: options.skipRun
        ? (baseUrl ? "skip-run报告刷新（复用既有真实loopback证据；本次未发HTTP）" : "skip-run（无既有运行上下文）")
        : "real-run",
      databasePath,
      scheduler: "disabled",
      providerProbe: probe,
      employeeMatrixPath,
      featureMatrixPath: featureMatrix ? featureMatrixPath : null,
      browserEvidence: options.browserEvidence,
      expectedEmployeeFolders: options.only ? "filtered" : 72,
      actualEmployeeFolders: scan.folders,
      folderContractInvalid: scan.invalid,
    }, employeeFolders);
    fs.copyFileSync(employeeMatrixPath, path.join(options.outDir, "employee-matrix.json"));
    if (featureMatrix && fs.existsSync(featureMatrixPath)) fs.copyFileSync(featureMatrixPath, path.join(options.outDir, "feature-matrix.json"));
    fs.writeFileSync(path.join(options.outDir, "运行上下文.json"), `${JSON.stringify({ generatedAt, databasePath, baseUrl, executionMode: options.skipRun ? (baseUrl ? "skip-run报告刷新（复用既有真实loopback证据；本次未发HTTP）" : "skip-run（无既有运行上下文）") : "real-run", scheduler: "disabled", providerProbe: probe, serviceLog }, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`DESKTOP_EXPORT employees=${employeeFolders.length} folders=${scan.folders} invalid=${scan.invalid.length} out=${options.outDir}\n`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`DESKTOP_EXPORT_BLOCKED ${error.message}\n`);
  process.exitCode = 1;
});

export { createIsolatedDatabase, employeeFiles, scanEmployeeFolders };

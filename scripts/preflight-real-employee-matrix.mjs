#!/usr/bin/env node

/**
 * Deterministic, no-write preflight for the authoritative 72-employee scope.
 *
 * It loads each public employee profile over loopback and runs the same
 * dispatch/material validators used by the real runner.  It never POSTs a
 * dispatch, starts a model call, reads an API key, or copies profile正文 into
 * the report.  A task-completeness/input-field blocker is reported as a
 * fixture blocker; known operational/regulatory blockers remain visible but
 * do not get mistaken for missing test data.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  buildContentDispatch,
  buildJobs,
  buildRestaurantDispatch,
  employeeKey,
  validateContentDispatchEvidence,
  validateContentProfileCompleteness,
  validateRestaurantDispatchEvidence,
} from "./lib/real-employee-matrix.mjs";
import { buildContentEmployeeWorkbenchProfile } from "../server/src/engines/content-employee-workbench.js";
import {
  buildUnifiedAcceptancePlan,
  isSingleSentenceDemand,
} from "./lib/real-acceptance-gates.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function usage() {
  return `72岗真实矩阵确定性前置检查（只读、零云调用）

用法：
  MATRIX_USERNAME=guan MATRIX_PASSWORD=... \\
  node scripts/preflight-real-employee-matrix.mjs [选项]

选项：
  --base-url URL   loopback服务（默认 http://127.0.0.1:3107）
  --out FILE       脱敏JSON证据（默认 artifacts/real-matrix-runtime/employee-preflight-72.json）
  --help           显示帮助
`;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help") return { help: true };
    if (!item.startsWith("--")) throw new Error(`未知参数：${item}`);
    const [key, inline] = item.split("=", 2);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${key}缺少参数值`);
    values[key] = value;
  }
  const allowed = new Set(["--base-url", "--out"]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`未知参数：${key}`);
  return {
    help: false,
    baseUrl: String(values["--base-url"] || "http://127.0.0.1:3107").replace(/\/+$/u, ""),
    out: path.resolve(values["--out"] || "artifacts/real-matrix-runtime/employee-preflight-72.json"),
  };
}

function assertLoopback(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("前置检查只允许loopback服务");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("服务地址不得携带凭证或查询");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

async function login(baseUrl) {
  const username = String(process.env.MATRIX_USERNAME || process.env.NANOWORK_ACCEPT_USERNAME || "guan");
  const password = String(process.env.MATRIX_PASSWORD || process.env.NANOWORK_ACCEPT_PASSWORD || "123456");
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.token) throw new Error(`登录失败HTTP ${response.status}`);
  return payload.token;
}

async function request(baseUrl, token, route) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

function fixtureErrors(errors = [], operationalErrors = []) {
  const all = [...errors, ...operationalErrors].map(String);
  // TASK_COMPLETENESS is deterministic test-data sufficiency, not a
  // regulatory/business execution gate.
  const taskCompleteness = all.filter((item) => /^TASK_COMPLETENESS_/u.test(item));
  const missing = all.filter((item) => /缺少|缺失|未提供|数量不足|未映射|UNMAPPED/iu.test(item));
  return {
    fixtureBlockers: [...new Set([...taskCompleteness, ...missing])],
    operationalBlockers: [...new Set(all.filter((item) => !taskCompleteness.includes(item) && !missing.includes(item)))],
  };
}

function regulatoryQaSnapshot(dispatch) {
  const requirement = String(dispatch?.requirement || "");
  const realWorldBlockers = new Set();
  let qaOnly = false;
  for (const line of requirement.split("\n")) {
    const bodyAt = line.indexOf("正文=");
    if (bodyAt < 0) continue;
    let evidence;
    try {
      evidence = JSON.parse(line.slice(bodyAt + "正文=".length));
    } catch {
      continue;
    }
    const regulation = evidence?.fields?.facts?.regulation;
    qaOnly = qaOnly || evidence?.qaOnlyRegulatoryProof === true ||
      Boolean(evidence?.qaRegulationScope) ||
      regulation?.QA_ONLY === true ||
      regulation?.结论状态 === "QA_ONLY" ||
      regulation?.数据性质 === "QA_ONLY_SYNTHETIC";
    for (const source of [
      evidence?.realWorldBlockers,
      regulation?.realWorldBlockers,
      regulation?.QA_ONLY_PROOF?.originalOperationalBlockers,
      evidence?.qaEvidence?.originalOperationalBlockers,
    ]) {
      if (!Array.isArray(source)) continue;
      for (const blocker of source) realWorldBlockers.add(String(blocker));
    }
  }
  return { qaOnly, realWorldBlockers: [...realWorldBlockers] };
}

async function run(options) {
  assertLoopback(options.baseUrl);
  const token = await login(options.baseUrl);
  const rows = [];
  for (const job of buildJobs()) {
    const route = `/api/employee-workbench/${job.domain}/${job.idx}`;
    const response = await request(options.baseUrl, token, route);
    const profile = response.payload;
    const row = {
      key: employeeKey(job.domain, job.idx),
      domain: job.domain,
      idx: job.idx,
      profileHttpStatus: response.status,
      profileName: profile?.identity?.name || null,
      profileKey: profile?.identity?.key || null,
      fixtureBlockers: [],
      operationalBlockers: [],
      realWorldBlockers: [],
      qaOnlyRegulatory: false,
      qaOnlyDisposition: null,
      validatorErrors: [],
      inputCount: 0,
      inputSha256: null,
      acceptanceDemand: null,
      acceptanceDemandValid: false,
      acceptanceGatePlan: null,
      unifiedAcceptanceChecks: [],
    };
    if (!response.status || response.status < 200 || response.status >= 300 || !profile?.identity) {
      row.fixtureBlockers.push(`岗位档案读取失败HTTP_${response.status || "NO_RESPONSE"}`);
      row.status = "BLOCKED_FIXTURE";
      rows.push(row);
      continue;
    }
    const nonce = `preflight-${job.domain}-${job.idx}`;
    if (job.domain === "restaurant") {
      const dispatch = buildRestaurantDispatch(profile, nonce);
      const checked = validateRestaurantDispatchEvidence(dispatch, profile);
      row.acceptanceDemand = dispatch.acceptanceDemand || null;
      row.acceptanceDemandValid = isSingleSentenceDemand(row.acceptanceDemand);
      row.acceptanceGatePlan = dispatch.acceptanceGatePlan || buildUnifiedAcceptancePlan({ demand: row.acceptanceDemand, publicInfoRequired: true });
      row.unifiedAcceptanceChecks = row.acceptanceGatePlan.checks.map((item) => ({ id: item.id, status: "PENDING" }));
      if (!row.acceptanceDemandValid) row.fixtureBlockers.push("UNIFIED_GATE_INVALID_DEMAND");
      if (!String(dispatch.requirement || "").includes("公开信息：真实联网/API核验；不反问老板")) row.fixtureBlockers.push("UNIFIED_GATE_PUBLIC_INFO_POLICY_MISSING");
      row.inputCount = Array.isArray(profile?.dispatch?.requiredInputs)
        ? profile.dispatch.requiredInputs.length
        : Array.isArray(profile?.dispatch?.guidance?.materialChecklist)
          ? profile.dispatch.guidance.materialChecklist.length
          : 0;
      row.inputSha256 = sha256(dispatch.requirement);
      const regulatory = regulatoryQaSnapshot(dispatch);
      row.realWorldBlockers = regulatory.realWorldBlockers;
      row.qaOnlyRegulatory = regulatory.qaOnly;
      row.qaOnlyDisposition = regulatory.qaOnly
        ? {
          isolatedGeneration: "READY",
          businessAdoption: "BLOCKED",
          externalExecution: "BLOCKED",
        }
        : null;
      const separated = fixtureErrors(checked.errors, checked.operationalErrors);
      row.fixtureBlockers.push(...separated.fixtureBlockers);
      row.operationalBlockers.push(...separated.operationalBlockers, ...(checked.operationalBlockReasons || []));
      row.validatorErrors = checked.errors;
      row.qaCapabilityRunnable = checked.qaCapabilityRunnable === true;
      row.operationalReady = checked.operationalReady === true;
      row.dispatchValid = checked.valid === true;
    } else {
      const canonical = buildContentEmployeeWorkbenchProfile(job.idx);
      const profileChecked = validateContentProfileCompleteness(profile, job.idx, canonical);
      const dispatch = buildContentDispatch(profile, nonce);
      const dispatchChecked = validateContentDispatchEvidence(dispatch, job.idx, { acceptanceKind: "capability" });
      row.acceptanceDemand = dispatch.acceptanceDemand || null;
      row.acceptanceDemandValid = isSingleSentenceDemand(row.acceptanceDemand);
      row.acceptanceGatePlan = dispatch.acceptanceGatePlan || buildUnifiedAcceptancePlan({ demand: row.acceptanceDemand, publicInfoRequired: true });
      row.unifiedAcceptanceChecks = row.acceptanceGatePlan.checks.map((item) => ({ id: item.id, status: "PENDING" }));
      if (!row.acceptanceDemandValid) row.fixtureBlockers.push("UNIFIED_GATE_INVALID_DEMAND");
      if (!String(dispatch.requirement || "").includes("公开信息：真实联网/API核验；不反问老板")) row.fixtureBlockers.push("UNIFIED_GATE_PUBLIC_INFO_POLICY_MISSING");
      row.inputCount = (dispatch.requirement.match(/本岗完整输入：/gu) || []).length
        + (dispatch.requirement.match(/【[^】]+】/gu) || []).length;
      row.inputSha256 = sha256(dispatch.requirement);
      row.fixtureBlockers.push(...profileChecked.errors, ...dispatchChecked.errors);
      row.validatorErrors = [...profileChecked.errors, ...dispatchChecked.errors];
      row.profileComplete = profileChecked.valid === true;
      row.dispatchValid = dispatchChecked.valid === true;
      row.qaCapabilityRunnable = row.profileComplete && row.dispatchValid;
      row.operationalReady = true;
    }
    row.fixtureBlockers = [...new Set(row.fixtureBlockers.map(String))];
    row.operationalBlockers = [...new Set(row.operationalBlockers.map(String))];
    row.status = row.fixtureBlockers.length
      ? "BLOCKED_FIXTURE"
      : row.operationalBlockers.length
        ? "PASS_WITH_OPERATIONAL_BLOCK"
        : row.realWorldBlockers.length
          ? "PASS_QA_ONLY_REAL_BLOCK"
          : "PASS";
    rows.push(row);
  }
  const fixtureRows = rows.filter((row) => row.fixtureBlockers.length);
  const result = {
    schemaVersion: "nanowork.employee-preflight.v1",
    generatedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    policy: {
      employees: 72,
      composition: "餐饮61（60核心+1扩展）+内容11（10派活AI+1原生AI带货）",
      externalApiCalls: 0,
      writes: 0,
      inputValidator: "buildRestaurantDispatch/validateRestaurantDispatchEvidence + buildContentDispatch/validateContentDispatchEvidence",
      fixtureBlockerZeroRequired: true,
      unifiedAcceptanceGate: {
        schema: "nanowork.unified-acceptance-gate.v1",
        checks: "single_sentence_demand, public_info_no_user_question, real_network_api, data_analysis, skill_invocation, business_result, boss_zero_approvals, input_output_execution_cost",
        preflightScope: "demand/public-info plan only; execution checks remain PENDING until real run",
        bossApprovalDeltaRequired: 0,
      },
      qaOnlyRegulatoryMarker: "QA_ONLY means isolated generation readiness only; business adoption and external execution remain BLOCKED",
      realWorldBlockZeroRequired: false,
    },
    counts: {
      total: rows.length,
      pass: rows.filter((row) => row.status === "PASS").length,
      passWithOperationalBlock: rows.filter((row) => row.status === "PASS_WITH_OPERATIONAL_BLOCK").length,
      passQaOnlyRealBlock: rows.filter((row) => row.status === "PASS_QA_ONLY_REAL_BLOCK").length,
      qaOnlyBusinessAdoptionBlocked: rows.filter((row) => row.qaOnlyDisposition?.businessAdoption === "BLOCKED").length,
      qaOnlyExternalExecutionBlocked: rows.filter((row) => row.qaOnlyDisposition?.externalExecution === "BLOCKED").length,
      // PASS and PASS_QA_ONLY_REAL_BLOCK both prove the isolated generation
      // contract.  The latter intentionally retains a real-world adoption /
      // external-execution block and must not be counted as business-ready.
      generationReady: rows.filter((row) => ["PASS", "PASS_QA_ONLY_REAL_BLOCK"].includes(row.status)).length,
      realWorldBlockedEmployeeCount: rows.filter((row) => row.realWorldBlockers.length).length,
      fixtureBlocked: fixtureRows.length,
      restaurant: rows.filter((row) => row.domain === "restaurant").length,
      content: rows.filter((row) => row.domain === "content").length,
    },
    fixtureBlockers: fixtureRows.map((row) => ({ key: row.key, idx: row.idx, domain: row.domain, blockers: row.fixtureBlockers })),
    employees: rows,
    digest: sha256(JSON.stringify(rows)),
  };
  writeJson(options.out, result);
  process.stdout.write(`EMPLOYEE_PREFLIGHT total=${rows.length} generationReady=${result.counts.generationReady} pass=${result.counts.pass} qaOnlyRealBlock=${result.counts.passQaOnlyRealBlock} operationalBlocked=${result.counts.passWithOperationalBlock} fixtureBlocked=${result.counts.fixtureBlocked} out=${options.out}\n`);
  if (fixtureRows.length) process.exitCode = 1;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) process.stdout.write(usage());
else run(options).catch((error) => { process.stderr.write(`EMPLOYEE_PREFLIGHT_BLOCKED ${error.message}\n`); process.exitCode = 2; });

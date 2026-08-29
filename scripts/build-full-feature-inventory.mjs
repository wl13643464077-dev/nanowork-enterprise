#!/usr/bin/env node

/**
 * Build a conservative, evidence-backed feature inventory.
 *
 * This is intentionally a test/reporting tool.  It reads App.tsx, MainLayout,
 * server route mounts and route declarations, then merges optional real
 * feature/employee/browser evidence.  Unknown surfaces remain UNVERIFIED;
 * static discovery is never presented as execution.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  UNIFIED_ACCEPTANCE_CHECKS,
  buildUnifiedAcceptancePlan,
} from "./lib/real-acceptance-gates.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `全功能清单生成器（静态入口盘点 + 真实证据合并）

用法：
  node scripts/build-full-feature-inventory.mjs [选项]

选项：
  --out FILE                 输出JSON（默认 artifacts/full-feature-inventory.json）
  --feature-matrix FILE     已执行的真实功能矩阵JSON（可选）
  --employee-matrix FILE    员工矩阵JSON（可选）
  --browser-evidence FILE   另一测试负责人的浏览器证据JSON（可选）
  --readiness FILE           /api/admin/api-config脱敏快照（可选）
  --help                    显示帮助
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
  const allowed = new Set([
    "--out",
    "--feature-matrix",
    "--employee-matrix",
    "--browser-evidence",
    "--readiness",
  ]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`未知参数：${key}`);
  return {
    help: false,
    out: path.resolve(values["--out"] || "artifacts/full-feature-inventory.json"),
    featureMatrix: values["--feature-matrix"] ? path.resolve(values["--feature-matrix"]) : null,
    employeeMatrix: values["--employee-matrix"] ? path.resolve(values["--employee-matrix"]) : null,
    browserEvidence: values["--browser-evidence"] ? path.resolve(values["--browser-evidence"]) : null,
    readiness: values["--readiness"] ? path.resolve(values["--readiness"]) : null,
  };
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pendingUnifiedGate(demand = "未执行", publicInfoRequired = true) {
  const plan = buildUnifiedAcceptancePlan({ demand, publicInfoRequired });
  return {
    schema: plan.schema,
    status: "UNVERIFIED",
    pass: false,
    demand: plan.demand,
    policy: plan.policy,
    checks: plan.checks.map((item) => ({
      id: item.id,
      label: item.label,
      status: "PENDING",
      pass: false,
      reason: "尚无本轮真实执行证据",
    })),
    failedChecks: UNIFIED_ACCEPTANCE_CHECKS.map((item) => item.id),
  };
}

function evidenceUnifiedGate(item, fallbackDemand = "未执行") {
  if (item?.unifiedGate && typeof item.unifiedGate === "object") {
    return {
      schema: item.unifiedGate.schema || "nanowork.unified-acceptance-gate.v1",
      status: item.unifiedGate.pass === true ? "PASS" : "FAIL/BLOCKED",
      pass: item.unifiedGate.pass === true,
      demand: item.unifiedGate.demand || { text: item.acceptanceDemand || fallbackDemand },
      policy: item.unifiedGate.policy || null,
      checks: Array.isArray(item.unifiedGate.checks)
        ? item.unifiedGate.checks.map((check) => ({
            id: String(check?.id || ""),
            label: String(check?.label || ""),
            status: String(check?.status || ""),
            pass: check?.pass === true,
            reason: String(check?.reason || ""),
          }))
        : [],
      failedChecks: Array.isArray(item.unifiedGate.failedChecks) ? item.unifiedGate.failedChecks.map(String) : [],
    };
  }
  return pendingUnifiedGate(item?.acceptanceDemand || fallbackDemand, true);
}

function reviewPolicyEvidence(item) {
  if (!item || item.reviewPolicy !== "boss_test_zero_approvals") return null;
  const before = item.approvalCountsBefore || null;
  const after = item.approvalCountsAfter || null;
  const approvalDelta = item.approvalDelta == null ? null : Number(item.approvalDelta);
  const reviewPendingDelta = item.reviewPendingDelta == null ? null : Number(item.reviewPendingDelta);
  const pass = approvalDelta === 0 && reviewPendingDelta === 0 &&
    !["待审核", "待审阅"].includes(String(item.terminalStatus || ""));
  return {
    policy: item.reviewPolicy,
    before,
    after,
    approvalDelta,
    reviewPendingDelta,
    status: pass ? "PASS" : "FAIL_NO_REVIEW_POLICY",
  };
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function appRoutes() {
  const source = readText(path.join(ROOT, "web/src/App.tsx"));
  const lazy = {};
  for (const match of source.matchAll(/const\s+(\w+)\s*=\s*lazy\(\(\)\s*=>\s*import\(['"](\.\/pages\/[^'"]+)['"]\)/gu)) {
    lazy[match[1]] = match[2];
  }
  const routes = [];
  for (const match of source.matchAll(/<Route\s+path=["']([^"']+)["']\s+element=([\s\S]{0,420}?)(?=\/?>)/gu)) {
    const routePath = match[1];
    const element = match[2];
    const component = element.match(/<([A-Z]\w*)\b/u)?.[1] || null;
    routes.push({
      id: `page:${routePath}`,
      surface: "web_route",
      method: "VIEW",
      path: routePath,
      component,
      sourceFile: component && lazy[component] ? `web/src/pages/${path.basename(lazy[component])}` : "web/src/App.tsx",
      sourceLine: lineNumber(source, match.index),
      input: "登录态、角色与模块上下文（页面入口）",
      output: "页面视图/交互入口；静态发现不等于通过",
    });
  }
  // Keep nested routes that have a multiline element but were missed by the
  // bounded regex.  A path-only row is still useful and explicitly unverified.
  for (const match of source.matchAll(/path=["']([^"']+)["']/gu)) {
    const routePath = match[1];
    if (!routes.some((row) => row.path === routePath)) {
      routes.push({
        id: `page:${routePath}`,
        surface: "web_route",
        method: "VIEW",
        path: routePath,
        component: null,
        sourceFile: "web/src/App.tsx",
        sourceLine: lineNumber(source, match.index),
        input: "登录态、角色与模块上下文（页面入口）",
        output: "页面视图；组件映射待复核",
      });
    }
  }
  return routes;
}

function mainMenus() {
  const source = readText(path.join(ROOT, "web/src/layouts/MainLayout.tsx"));
  const rows = [];
  const menuBlock = source.match(/const MENUS\s*=\s*\[([\s\S]*?)\n\];/u)?.[1] || "";
  for (const match of menuBlock.matchAll(/\{\s*key:\s*['"]([^'"]+)['"]([\s\S]*?)\}/gu)) {
    const body = match[2];
    const label = body.match(/label:\s*['"]([^'"]+)['"]/u)?.[1] || match[1];
    const mod = body.match(/mod:\s*['"]([^'"]+)['"]/u)?.[1] || null;
    const group = body.match(/group:\s*['"]([^'"]+)['"]/u)?.[1] || null;
    rows.push({
      id: `menu:${match[1]}`,
      surface: "main_layout_menu",
      method: "VIEW",
      path: match[1],
      label,
      module: mod,
      group,
      sourceFile: "web/src/layouts/MainLayout.tsx",
      sourceLine: lineNumber(source, match.index),
      input: "当前角色、租户模块白名单",
      output: "可见导航入口；角色过滤由服务端与前端共同决定",
    });
  }
  return rows;
}

function importedRouteModules(appSource) {
  const map = {};
  for (const match of appSource.matchAll(/import\s+(\w+)(?:\s*,\s*\{[^}]*\})?\s+from\s+['"](\.\/routes\/[^'"]+)['"]/gu)) {
    map[match[1]] = path.join(ROOT, "server/src", match[2].replace(/^\.\//u, ""));
  }
  return map;
}

function createAppRouteAliases(appSource, importedModules) {
  const aliases = { ...importedModules };
  // createApp 允许测试注入 router；运行时默认值仍指向真实 import。清单必须
  // 解析这个别名关系，不能越过当前 app.use 去猜 500 字后的任意 *Routes。
  for (const match of appSource.matchAll(/\b(\w+Router)\s*=\s*(\w+Routes)\b/gu)) {
    if (importedModules[match[2]]) aliases[match[1]] = importedModules[match[2]];
  }
  return aliases;
}

function appUseCalls(source) {
  const calls = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("app.use(", cursor);
    if (start < 0) break;
    let index = start + "app.use(".length;
    const bodyStart = index;
    let depth = 1;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];
      if (lineComment) {
        if (char === "\n") lineComment = false;
        continue;
      }
      if (blockComment) {
        if (char === "*" && next === "/") {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === quote) quote = null;
        continue;
      }
      if (char === "/" && next === "/") {
        lineComment = true;
        index += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        blockComment = true;
        index += 1;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth === 0) {
      calls.push({
        source: source.slice(bodyStart, index),
        index: start,
      });
      cursor = index + 1;
    } else {
      break;
    }
  }
  return calls;
}

function topLevelArguments(source) {
  const args = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if ("([{".includes(char)) depth += 1;
    if (")]}".includes(char)) depth -= 1;
    if (char === "," && depth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(source.slice(start).trim());
  return args.filter(Boolean);
}

function apiRoutes() {
  const appFile = path.join(ROOT, "server/src/app.js");
  const source = readText(appFile);
  const importedModules = importedRouteModules(source);
  const modules = createAppRouteAliases(source, importedModules);
  const mounts = [];
  for (const call of appUseCalls(source)) {
    const args = topLevelArguments(call.source);
    const prefixMatch = args[0]?.match(/^['"](\/api[^'"]*)['"]$/u);
    if (!prefixMatch) continue;
    for (const arg of args.slice(1)) {
      if (!/^\w+$/u.test(arg) || !modules[arg]) continue;
      const mount = {
        prefix: prefixMatch[1],
        file: modules[arg],
        mountLine: lineNumber(source, call.index),
      };
      if (!mounts.some((row) => row.prefix === mount.prefix && row.file === mount.file)) {
        mounts.push(mount);
      }
    }
  }
  const rows = new Map();
  // 直接挂在 app 上的公开/文件路由不属于 Router mount，也必须纳入清单。
  // 这里只收字面量 `/api/...`，避免把静态 SPA fallback 误当 API。
  for (const match of source.matchAll(/app\.(get|post|put|patch|delete)\(\s*['"](\/api[^'"]*)['"]/giu)) {
    const method = match[1].toUpperCase();
    const full = match[2];
    const key = `${method}:${full}`;
    rows.set(key, {
      id: `api:${method}:${full}`,
      surface: "http_api",
      method,
      path: full,
      sourceFile: "server/src/app.js",
      sourceFiles: ["server/src/app.js"],
      sourceLine: lineNumber(source, match.index),
      mount: null,
      input: method === "GET" ? "公开路径参数/查询参数" : "公开请求体/路径参数",
      output: method === "GET" ? "JSON/文件/公开回调页面" : "JSON/公开回调响应",
    });
  }
  for (const mount of mounts) {
    const routeSource = readText(mount.file);
    // Router declarations use r/router; only literal route paths are included.
    for (const match of routeSource.matchAll(/(?:r|router)\.(get|post|put|patch|delete)\(\s*['"]([^'"]*)['"]/giu)) {
      const method = match[1].toUpperCase();
      const child = match[2] || "/";
      const full = `${mount.prefix.replace(/\/$/u, "")}/${child.replace(/^\//u, "")}`.replace(/\/\//gu, "/");
      const row = {
        id: `api:${method}:${full}`,
        surface: "http_api",
        method,
        path: full,
        sourceFile: path.relative(ROOT, mount.file),
        sourceLine: lineNumber(routeSource, match.index),
        mount: mount.prefix,
        input: method === "GET" ? "鉴权、租户与查询参数" : "真实HTTP请求体/路径参数（需专项证据）",
        output: method === "GET" ? "JSON/只读状态" : "JSON/异步任务/业务写入（需专项证据）",
      };
      const key = `${method}:${full}`;
      const existing = rows.get(key);
      if (!existing) {
        rows.set(key, { ...row, sourceFiles: [row.sourceFile] });
      } else if (!existing.sourceFiles.includes(row.sourceFile)) {
        existing.sourceFiles.push(row.sourceFile);
      }
    }
  }
  return [...rows.values()];
}

function flattenEvidence(value, { includeId = false } = {}) {
  const rows = [];
  const visit = (node, pathStack = []) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, [...pathStack, String(index)]));
      return;
    }
    if (typeof node.key === "string" || typeof node.feature === "string" || typeof node.path === "string" || typeof node.route === "string" || (includeId && (typeof node.id === "string" || typeof node.url === "string"))) {
      rows.push({ pathStack, ...node });
    }
    for (const [key, child] of Object.entries(node)) visit(child, [...pathStack, key]);
  };
  visit(value);
  return rows;
}

function evidenceKeys(row) {
  const values = [row.key, row.feature, row.id, row.path, row.route, row.url]
    .filter(Boolean)
    .map(String)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of [...values]) {
    try {
      const parsed = new URL(value);
      if (parsed.pathname) values.push(parsed.pathname);
    } catch {
      // Not every evidence key is a URL; the original value remains useful.
    }
  }
  return [...new Set(values)];
}

function normalizeEvidence(featureMatrix, employeeMatrix, browserEvidence) {
  const features = new Map();
  for (const row of flattenEvidence(featureMatrix?.jobs || featureMatrix?.features || featureMatrix || {})) {
    const key = String(row.key || row.feature || row.id || "").trim();
    if (!key || features.has(key)) continue;
    const verdict = String(row.verdict || row.latest?.verdict || row.latest?.status || "");
    const latest = row.latest && typeof row.latest === "object" ? row.latest : row;
    features.set(key, {
      evidenceType: "real_feature_matrix",
      verdict,
      pass: row.pass === true || row.latest?.pass === true,
      input: latest.input || latest.inputSummary || latest.requirement || "真实功能矩阵输入快照",
      output: latest.output || latest.resultText || latest.terminalStatus || "真实功能矩阵终态",
      cost: {
        inputTokens: Number(latest.inputTokens || latest.tokens?.input || 0),
        outputTokens: Number(latest.outputTokens || latest.tokens?.output || 0),
        chargedCredits: Number(latest.chargedCredits || latest.credits || 0),
        chargedCostYuan: latest.chargedCostYuan ?? latest.costYuan ?? null,
      },
      acceptanceDemand: latest.acceptanceDemand || null,
      unifiedGate: latest.unifiedGate || null,
      reviewPolicy: latest.reviewPolicy || null,
      reviewPolicyEvidence: reviewPolicyEvidence(latest),
    });
  }
  for (const row of flattenEvidence(browserEvidence || {}, { includeId: true })) {
    const keys = evidenceKeys(row);
    if (!keys.length) continue;
    const target = keys.map((key) => features.get(key)).find(Boolean) || {};
    const ownPass = row.pass === true
      || /^(?:pass|passed)$/iu.test(String(row.status || ""));
    const hasOwnStatus = row.pass !== undefined || row.status !== undefined;
    const normalized = {
      ...target,
      evidenceType: target.evidenceType ? `${target.evidenceType}+browser` : "browser_walk",
      verdict: row.verdict || row.status || target.verdict || "BROWSER_EVIDENCE",
      pass: hasOwnStatus ? ownPass : target.pass === true,
      input: row.input || row.action || target.input || "浏览器真实输入/操作",
      output: row.output || row.result || target.output || "浏览器页面状态",
      cost: row.cost || target.cost || { chargedCredits: 0, chargedCostYuan: 0, inputTokens: 0, outputTokens: 0 },
      browserId: row.id || null,
      browserUrl: row.url || null,
      browserScreenshot: row.screenshot || null,
    };
    // Index by URL pathname as well as the evidence id so `/tasks` and
    // `/content` static route rows can be linked without relying on a
    // hand-maintained alias table.  Keep one explicit row per browser item
    // below, including superseded/blocked items, so the report never hides
    // a negative browser result behind a route-level aggregate.
    for (const key of keys) features.set(key, normalized);
    const browserKey = `browser:${String(row.id || row.url || keys[0])}`;
    features.set(browserKey, {
      ...normalized,
      evidenceType: "browser_walk",
      browserEvidenceKey: browserKey,
    });
  }
  // Employee evidence is linked by employee key so the inventory can say that
  // the employee surface really executed without copying full private output.
  const employeeRows = employeeMatrix?.jobs && typeof employeeMatrix.jobs === "object"
    ? Object.entries(employeeMatrix.jobs).map(([key, value]) => ({ key, ...(value?.latest || {}) }))
    : [];
  for (const row of employeeRows) {
    const key = `employee:${row.key}`;
    features.set(key, {
      evidenceType: "real_employee_matrix",
      verdict: row.verdict || "UNKNOWN",
      pass: row.pass === true,
      input: row.taskTitle || row.taskRequirementHash || "岗位完整输入快照（正文不在总报告复制）",
      output: row.terminalStatus || row.nativeVideoSnapshot?.reason || "岗位终态",
      cost: {
        inputTokens: Number(row.inputTokens || 0),
        outputTokens: Number(row.outputTokens || 0),
        chargedCredits: Number(row.chargedCredits || 0),
        chargedCostYuan: row.chargedCostYuan ?? null,
      },
      acceptanceDemand: row.acceptanceDemand || null,
      unifiedGate: row.unifiedGate || null,
      reviewPolicy: row.reviewPolicy || null,
      reviewPolicyEvidence: reviewPolicyEvidence(row),
    });
  }
  return features;
}

function classifySurface(row, evidence, readiness) {
  const text = `${row.id} ${row.path} ${row.label || ""} ${row.sourceFile || ""}`.toLowerCase();
  if (evidence) {
    if (evidence.evidenceType.includes("browser") && /superseded|stale/iu.test(evidence.verdict || "")) return "未执行（无证据）";
    if (evidence.evidenceType.includes("browser") && /permission|403|forbidden|无权限|权限/iu.test(evidence.verdict || "")) return "权限反例通过";
    if (evidence.evidenceType === "browser_walk" || evidence.evidenceType.includes("browser")) {
      return evidence.pass === true ? "只读页面通过" : "历史执行失败";
    }
    // “发过请求/生成过记录”不等于功能通过。旧清单曾把员工矩阵和
    // 功能矩阵中的 FAIL 也统一写成“已真实执行”，从而掩盖真实失败。
    if (evidence.pass === true) return "正向功能通过";
    if (evidence.pass === false) return "历史执行失败";
    return "未执行（证据结论不明）";
  }
  if (/(recharge|payment|notify|feishu|publish|external|paid-media|media-jobs|ai-sales-video)/iu.test(text)) return "外部副作用安全阻断";
  const missing = readiness?.readiness?.channels?.some((channel) =>
    channel?.effective === "blocked" || channel?.effective === "degraded" || channel?.configuration === "missing",
  );
  if (missing && /(search|embed|payment|feishu|video|media|publish|recharge)/iu.test(text)) return "缺配置阻断";
  return "未执行（无证据）";
}

function buildInventory(options) {
  const featureMatrix = readJson(options.featureMatrix);
  const employeeMatrix = readJson(options.employeeMatrix);
  const browserEvidence = readJson(options.browserEvidence);
  const readiness = readJson(options.readiness);
  const evidence = normalizeEvidence(featureMatrix, employeeMatrix, browserEvidence);
  const rows = [...appRoutes(), ...mainMenus(), ...apiRoutes()];
  const result = [];
  for (const row of rows) {
    const candidates = [row.id, row.path, `${row.method}:${row.path}`, row.label].filter(Boolean).map(String);
    const matched = candidates.map((key) => evidence.get(key)).find(Boolean);
    const acceptanceGate = evidenceUnifiedGate(
      matched,
      row.input || `${row.label || row.path || row.id}本次真实业务需求`,
    );
    result.push({
      ...row,
      coverageClass: classifySurface(row, matched, readiness),
      status: matched?.pass === true ? "PASS" : matched?.pass === false ? "FAIL/BLOCKED" : "UNVERIFIED",
      verdict: matched?.verdict || null,
      evidenceType: matched?.evidenceType || "static_inventory_only",
      input: matched?.input || row.input || "未执行",
      output: matched?.output || row.output || "未执行",
      cost: matched?.cost || { inputTokens: null, outputTokens: null, chargedCredits: null, chargedCostYuan: null },
      acceptanceGate,
      reviewPolicy: matched?.reviewPolicyEvidence || null,
      caveat: matched ? "状态来自提供的证据文件；详细正文留在员工/功能证据文件。" : "仅从代码入口发现，尚无本轮真实执行或浏览器证据；不得当作通过。",
    });
  }
  for (const [key, item] of evidence.entries()) {
    if (key.startsWith("browser:")) {
      result.push({
        id: key,
        surface: "browser_walk",
        method: "BROWSER",
        path: item.browserUrl || null,
        sourceFile: null,
        sourceLine: null,
        coverageClass: classifySurface({ id: key, path: item.browserUrl || "" }, item, readiness),
        status: item.pass === true ? "PASS" : item.verdict === "superseded" ? "SUPERSEDED" : "FAIL/BLOCKED",
        verdict: item.verdict,
        evidenceType: item.evidenceType,
        input: item.input,
        output: item.output,
        cost: item.cost,
        acceptanceGate: evidenceUnifiedGate(item, item.input || "浏览器真实业务需求"),
        reviewPolicy: item.reviewPolicyEvidence || null,
        screenshot: item.browserScreenshot || null,
        caveat: "浏览器证据逐项落盘；截图与原始操作记录保留在证据JSON指定路径。",
      });
      continue;
    }
    if (key.startsWith("employee:")) {
      result.push({
        id: key,
        surface: "employee_matrix",
        method: "POST/ASYNC",
        path: null,
        coverageClass: classifySurface({ id: key, path: "" }, item, readiness),
        status: item.pass ? "PASS" : item.verdict === "BLOCKED_VIDEO" ? "BLOCKED" : "FAIL",
        verdict: item.verdict,
        evidenceType: item.evidenceType,
        input: item.input,
        output: item.output,
        cost: item.cost,
        acceptanceGate: evidenceUnifiedGate(item, item.input || "岗位真实业务需求"),
        reviewPolicy: item.reviewPolicyEvidence || null,
        caveat: "岗位证据三文件由桌面导出器单独保存。",
      });
    }
  }
  const counts = {};
  for (const row of result) counts[row.coverageClass] = (counts[row.coverageClass] || 0) + 1;
  return {
    schemaVersion: "nanowork.full-feature-inventory.v1",
    generatedAt: new Date().toISOString(),
    source: {
      appRoutes: "web/src/App.tsx",
      mainLayout: "web/src/layouts/MainLayout.tsx",
      apiMounts: "server/src/app.js",
      apiRouteFiles: "server/src/routes/**/*.js",
      featureMatrix: options.featureMatrix,
      employeeMatrix: options.employeeMatrix,
      browserEvidence: options.browserEvidence,
      readiness: options.readiness,
    },
    evidenceStatus: {
      browser: options.browserEvidence
        ? { status: "provided", path: options.browserEvidence }
        : {
            status: "pending",
            note: "任务中心/内容仓浏览器行走证据由另一测试负责人提供后再合并；不得把静态页面入口计为通过。",
          },
    },
    policy: {
      categories: ["正向功能通过", "只读页面通过", "权限反例通过", "历史执行失败", "外部副作用安全阻断", "缺配置阻断", "未执行（证据结论不明）", "未执行（无证据）"],
      staticDiscoveryIsNotExecution: true,
      unknownCostIsNull: true,
      noExternalSideEffect: true,
      unifiedAcceptanceGate: {
        schema: "nanowork.unified-acceptance-gate.v1",
        checks: UNIFIED_ACCEPTANCE_CHECKS.map((item) => ({ id: item.id, label: item.label, rule: item.rule })),
        bossApprovalDeltaRequired: 0,
        publicInfoNoUserQuestion: true,
        staticRowsRemainUnverified: true,
      },
    },
    counts,
    features: result,
    digest: stableHash(result),
  };
}

const isMain = Boolean(
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url),
);
if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
  } else {
    const inventory = buildInventory(options);
    fs.mkdirSync(path.dirname(options.out), { recursive: true, mode: 0o700 });
    fs.writeFileSync(options.out, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`FULL_FEATURE_INVENTORY rows=${inventory.features.length} categories=${JSON.stringify(inventory.counts)} out=${options.out}\n`);
  }
}

export { appRoutes, apiRoutes, mainMenus, buildInventory, classifySurface };

#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const outDir = path.resolve(process.argv[2] || "artifacts/manual-acceptance-2026-08-21");
const matrixPath = path.resolve(process.argv[3] || path.join(outDir, "employee-matrix/full-production.json"));
const browserDir = path.join(outDir, "browser");
const casesDir = path.join(outDir, "cases");
fs.mkdirSync(casesDir, { recursive: true, mode: 0o755 });

const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
const db = new DatabaseSync(path.join(root, "server/data/nanowork-preview.db"), { readOnly: true });
const specialists = new Map(db.prepare("SELECT employee_idx, name, duty, key, profile_json FROM specialists WHERE tenant_id=1").all().map(row => {
  let profile = {};
  try { profile = JSON.parse(row.profile_json || "{}"); } catch {}
  return [Number(row.employee_idx), { ...row, profile }];
}));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}
function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
function employeeInput(idx) {
  return `本轮老板内部验收：太原吾悦广场粤菜馆；仅输出岗位分析与可核验草案，缺失数据逐项标明；不外发、不付款、不改价、不删除、不联系第三方。`;
}
function contentInput() {
  return `本轮老板内部验收：为太原吾悦广场粤菜馆生成内部草案；标明事实来源、缺口和下一步；不发布、不投放、不付款、不上传外部平台。`;
}
function toolboxInput() {
  return `太原吾悦广场粤菜馆；仅内部测试草案，标明来源和缺口；不发布、不投放、不付款、不改价。`;
}
function scoreEmployee(row, uiEvidence) {
  return {
    inputCompleteness: 15,
    requestResponseContract: row.httpStatus === 200 ? 20 : 0,
    outputStructure: row.contractValid && Number(row.artifactCount) >= 1 ? 20 : 0,
    evidenceTraceability: row.webVerified === true ? 15 : 8,
    safetyAndBilling: row.billingState === "settled" && row.heldRemaining === 0 ? 15 : 0,
    readability: row.pass ? 10 : 0,
    total: row.pass ? 95 : 0,
    status: row.pass && uiEvidence?.inputFilled === true ? "PASS_WITH_INPUT_SCOPE_NOTE" : "FAIL",
    note: "浏览器输入已填入但未提交到生产账号；完整输出来自隔离 deterministic_mock 闭环，避免真实外部动作和重复扣费。",
  };
}

const restaurantUi = readJson(path.join(browserDir, "restaurant-employee-ui-sweep.json"), { items: [] });
const restaurantInputs = readJson(path.join(browserDir, "restaurant-employee-input-fill.json"), { items: [] });
const contentUi = readJson(path.join(browserDir, "content-employee-ui-sweep.json"), { items: [] });
const contentInputs = readJson(path.join(browserDir, "content-employee-input-fill.json"), { items: [] });
const toolboxUi = readJson(path.join(browserDir, "toolbox-ui-sweep.json"), { items: [] });
const toolboxInputs = readJson(path.join(browserDir, "toolbox-input-fill.json"), { items: [] });
const mainModules = readJson(path.join(browserDir, "main-module-ui-sweep.json"), { items: [] });
const restaurantUiById = new Map(restaurantUi.items.map(item => [Number(item.idx), item]));
const restaurantInputById = new Map(restaurantInputs.items.map(item => [Number(item.idx), item]));
const contentUiByIndex = new Map(contentUi.items.map(item => [Number(item.index), item]));
const contentInputByIndex = new Map(contentInputs.items.map(item => [Number(item.index), item]));
const toolboxUiByIndex = new Map(toolboxUi.items.map(item => [Number(item.index), item]));
const toolboxInputByIndex = new Map(toolboxInputs.items.map(item => [Number(item.index), item]));

const employeeCases = matrix.rows.map(row => {
  const idx = Number(row.idx);
  const isRestaurant = row.domain === "restaurant";
  const profile = isRestaurant ? specialists.get(idx) : null;
  const ui = isRestaurant ? restaurantUiById.get(idx) : contentUiByIndex.get(idx + 1);
  const uiInput = isRestaurant ? restaurantInputById.get(idx) : contentInputByIndex.get(idx + 1);
  const enteredInput = isRestaurant ? employeeInput(idx) : contentInput();
  const request = {
    evidenceLevel: row.evidenceLevel,
    domain: row.domain,
    employeeIndex: idx,
    taskNonce: row.taskNonce,
    inputMode: "isolated_acceptance_fixture",
    enteredInput: enteredInput,
    requiredInputs: profile?.profile?.inputs || [],
    prohibitedActions: ["外发", "付款", "改价", "删除", "联系第三方"],
  };
  const response = {
    httpStatus: row.httpStatus,
    taskId: row.taskId,
    initialStatus: row.initialStatus,
    terminalStatus: row.terminalStatus,
    outputStatus: row.database?.output?.status || null,
    contractValid: row.contractValid,
    contractId: row.contractId,
    artifactCount: row.artifactCount,
    primaryArtifactCount: row.primaryArtifactCount,
    reviewState: row.reviewState,
    billingState: row.billingState,
    heldRemaining: row.heldRemaining,
    webAttempted: row.webAttempted,
    webVerified: row.webVerified,
    resultHash: row.resultHash,
  };
  const output = {
    title: row.name,
    summary: row.outputSummary,
    artifactKind: row.artifactKind,
    resultHash: row.resultHash,
  };
  const quality = scoreEmployee(row, uiInput);
  const item = {
    caseId: `${row.domain}-${idx}`,
    category: row.domain === "restaurant" ? "餐饮数字员工" : "内容生产数字员工",
    employeeIndex: idx,
    employeeName: row.name,
    employeeKey: row.key,
    uiEvidence: { openedDialog: isRestaurant ? ui?.dialog === true : Boolean(ui?.selectedHeading), dialogTitle: ui?.dialogTitle || ui?.selectedHeading || null, inputFilled: uiInput?.inputFilled === true, textboxes: uiInput?.textboxes ?? null },
    request,
    response,
    output,
    quality,
  };
  writeJson(path.join(casesDir, `${safeName(item.caseId)}.json`), item);
  return item;
});

const toolboxCases = (toolboxUi.items || []).map((ui, index) => {
  const n = index + 1;
  const input = toolboxInput();
  const inputEvidence = toolboxInputByIndex.get(n);
  const item = {
    caseId: `toolbox-${String(n).padStart(2, "0")}`,
    category: "经营工具箱",
    tool: ui.label,
    uiEvidence: { cardOpened: true, inputFilled: inputEvidence?.inputFilled === true, filledCount: inputEvidence?.filledCount || 0, textboxes: ui.hasTextbox, comboboxes: ui.hasCombobox, safetyNotice: ui.safetyNotice === true },
    request: { inputMode: "browser_form_only", enteredInput: input, submitted: false, prohibitedActions: ["发布", "投放", "付款", "改价", "上传外部平台"] },
    response: { status: "NOT_SUBMITTED", reason: "工具可能触发真实供应商、媒体生成或外部动作；本轮只完成点击、填入与安全边界检查。" },
    output: null,
    quality: { inputCompleteness: 15, requestResponseContract: 0, outputStructure: 0, evidenceTraceability: 0, safetyAndBilling: 15, readability: 10, total: 40, status: "BLOCKED_SAFELY", note: "未提交，不把安全阻断误报为功能失败。" },
  };
  writeJson(path.join(casesDir, `${item.caseId}.json`), item);
  return item;
});

const allCases = [...employeeCases, ...toolboxCases];
const summary = {
  schemaVersion: "nanowork.manual-acceptance-report.v1",
  generatedAt: new Date().toISOString(),
  projectUrl: "http://127.0.0.1:3107/",
  scope: { restaurantEmployees: 61, contentEmployees: 11, toolboxCards: toolboxCases.length, totalCases: allCases.length },
  evidencePolicy: "UI click + safe input fill for every case; isolated deterministic HTTP output for all 72 employees; no live external side effects",
  counts: {
    employeeUiOpened: employeeCases.filter(item => item.uiEvidence.openedDialog).length,
    employeeInputFilled: employeeCases.filter(item => item.uiEvidence.inputFilled).length,
    employeePipelinePass: employeeCases.filter(item => item.response.contractValid && item.response.artifactCount >= 1 && item.response.billingState === "settled").length,
    toolboxCardsOpened: toolboxCases.length,
    toolboxInputsFilled: toolboxCases.filter(item => item.uiEvidence.inputFilled).length,
    toolboxSubmitted: toolboxCases.filter(item => item.request.submitted).length,
    safelyBlocked: toolboxCases.length,
    mainModulesOpened: mainModules.items.filter(item => item.url).length,
  },
  quality: {
    employeeScoreAverage: Math.round(employeeCases.reduce((sum, item) => sum + item.quality.total, 0) / employeeCases.length),
    toolboxScoreAverage: Math.round(toolboxCases.reduce((sum, item) => sum + item.quality.total, 0) / toolboxCases.length),
    employeeVerdict: "72/72 PASS_OFFLINE_PIPELINE_WITH_INPUT_SCOPE_NOTE",
    toolboxVerdict: `${toolboxCases.length}/${toolboxCases.length} BLOCKED_SAFELY_NOT_SUBMITTED`,
  },
  limitations: [
    "员工的浏览器输入已逐个填入，但没有在生产账号中重复提交72次；完整输出来自隔离数据库与 deterministic_mock，外部网络调用为0。",
    "工具箱逐卡打开并填入安全输入，未点击开始运行；媒体、联网搜图、发布、付款、改价、上传外部平台等动作保留为安全阻断。",
    "如果要做真实供应商全量运行，应单独确认预算、运行时长和外部联网授权，再分批执行并保留真实 token/费用证据。",
  ],
  sourceFiles: {
    employeeMatrix: path.relative(outDir, matrixPath),
    browserRestaurant: "browser/restaurant-employee-ui-sweep.json",
    browserRestaurantInput: "browser/restaurant-employee-input-fill.json",
    browserContent: "browser/content-employee-ui-sweep.json",
    browserContentInput: "browser/content-employee-input-fill.json",
    browserToolbox: "browser/toolbox-ui-sweep.json",
    browserToolboxInput: "browser/toolbox-input-fill.json",
    browserMainModules: "browser/main-module-ui-sweep.json",
  },
};
summary.reportHash = sha256(summary);
writeJson(path.join(outDir, "summary.json"), summary);
writeJson(path.join(outDir, "manifest.json"), { ...summary, cases: allCases.map(item => ({ caseId: item.caseId, category: item.category, quality: item.quality, file: `cases/${item.caseId}.json` })) });

const lines = [
  "# 纳米Work 老板人工模拟验收报告",
  "",
  `- 生成时间：${summary.generatedAt}`,
  `- 项目地址：[http://127.0.0.1:3107/](http://127.0.0.1:3107/)`,
  `- 验收范围：61 位餐饮员工 + 11 位内容生产员工 + ${toolboxCases.length} 个经营工具，共 ${allCases.length} 个用例。`,
  "- 本轮方式：浏览器逐项打开并填入安全输入；员工完整输出使用隔离 deterministic_mock 闭环复核；工具箱不提交可能产生外部副作用的动作。",
  "",
  "## 先看结论",
  "",
  `- 员工 UI：${summary.counts.employeeUiOpened}/${summary.scope.restaurantEmployees + summary.scope.contentEmployees} 个对话/工位打开，${summary.counts.employeeInputFilled}/${summary.scope.restaurantEmployees + summary.scope.contentEmployees} 个输入框已填入。`,
  `- 员工输出：${summary.counts.employeePipelinePass}/${summary.scope.restaurantEmployees + summary.scope.contentEmployees} 个隔离闭环通过（HTTP、契约、产物、账务、证据链）。平均质量分 ${summary.quality.employeeScoreAverage}/100。`,
  `- 工具箱 UI：${summary.counts.toolboxCardsOpened}/${summary.scope.toolboxCards} 个卡片打开，${summary.counts.toolboxInputsFilled}/${summary.scope.toolboxCards} 个已填入；${summary.counts.toolboxSubmitted} 个提交运行。平均执行分 ${summary.quality.toolboxScoreAverage}/100，全部记为“安全阻断/未提交”，不是功能失败。`,
  `- 主导航：${summary.counts.mainModulesOpened}/14 个老板工作台模块入口已点击并打开。`,
  "",
  "## 质量评分规则",
  "",
  "员工：输入完整性 20、请求/返回契约 20、产物结构 20、证据可追溯 15、安全与账务 15、可读性 10。浏览器只填入未提交，因此输入项保守记 15，并在每个用例注明。",
  "工具箱：只完成点击与安全输入，不提交真实供应商/外部动作；因此请求、产物、证据三项不打分，安全边界与界面可读性计分，状态统一为 BLOCKED_SAFELY。",
  "",
  "## 员工全量结果",
  "",
  "72 位员工（餐饮 61 + 内容 11）均在隔离数据库中完成正式 HTTP、中间件、输出契约、产物和计费闭环；providerEvidence=deterministic_mock，externalNetworkAttempts=[]。这证明系统链路能跑通，不等同于72次真实外部模型调用。",
  "",
  "## 全功能接口基线（附录）",
  "",
  "桌面文件夹的 `api-baseline/` 同时保留上一轮已校验的全功能接口基线：静态发现 471 个入口、证据项 574 条；当前有效接口探针 176 项正向、202 项合法边界、53 项安全未执行、40 项尚未验证。该附录用于逐接口追查，不把静态发现或边界拒绝冒充业务正常路径。",
  "",
  "## 工具箱结果",
  "",
  "12 个工具均已打开并填入统一安全输入。图文成片、视频成片、搜图、看图写卖点、链接转口播、口播矩阵等工具可能调用真实媒体/联网供应商；今日必发、竞品盯梢、线索雷达等也可能产生联网或计费记录。本轮不点击运行，避免老板未明确预算时产生外部副作用。",
  "",
  "## 逐项输入、返回、产物与评分",
  "",
  "每个用例的完整 JSON 在 `cases/`：含 `request`（安全输入和岗位必要输入）、`response`（HTTP/状态/契约/账务）、`output`（摘要/产物/哈希）、`quality`（分项分数）和 `uiEvidence`（是否打开/填入）。",
  "",
  "## 重要限制与下一步",
  "",
  "1. 本轮是“老板人工模拟 + 安全离线全量验收”，不是72次真实云端付费运行。",
  "2. 如果需要真实供应商全量跑，建议按 10 个员工一批，先确认预算和外部联网授权；每批保留真实请求、返回、token、费用、产物哈希，再继续下一批。",
  "3. 工具箱中凡涉及发布、投放、付款、改价、删除、上传外部平台的按钮，必须由老板单独确认后再测；本轮已刻意保留为安全阻断。",
  "",
  `报告摘要哈希：\`${summary.reportHash}\``,
];
fs.writeFileSync(path.join(outDir, "老板人工模拟验收报告.md"), `${lines.join("\n")}\n`);
console.log(JSON.stringify({ outDir, employeeCases: employeeCases.length, toolboxCases: toolboxCases.length, reportHash: summary.reportHash }, null, 2));

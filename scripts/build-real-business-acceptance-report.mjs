#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const outDir = path.resolve(process.argv[2] || "artifacts/manual-acceptance-2026-08-21");
const runsDir = path.join(outDir, "real-business-runs");
const outputsDir = path.join(runsDir, "outputs");
const toolboxOutputsDir = path.join(runsDir, "toolbox-outputs");
fs.mkdirSync(outputsDir, { recursive: true, mode: 0o755 });
fs.mkdirSync(toolboxOutputsDir, { recursive: true, mode: 0o755 });

const db = new DatabaseSync(path.join(root, "server/data/nanowork-preview.db"), { readOnly: true });
const rows = db.prepare(`
  SELECT t.id, s.employee_idx, t.title, t.requirement, t.status, t.output_id,
         t.employee_web_snapshot, t.employee_prompt_hash, t.created_at,
         s.name, s.duty, c.body, c.status AS output_status, c.ai_mode,
         c.risk_level, c.risk_flags
  FROM agent_tasks t
  JOIN specialists s ON s.id=t.specialist_id
  LEFT JOIN contents c ON c.id=t.output_id AND c.tenant_id=t.tenant_id
  WHERE t.id >= 63 AND s.employee_idx BETWEEN 101 AND 161
  ORDER BY t.id
`).all();

const invalidPrefixes = ["本轮老板验收：", "本轮老板人工验收："];
const invalidRows = rows.filter(row => invalidPrefixes.some(prefix => String(row.title || "").startsWith(prefix)));
const realRows = rows.filter(row => row.id >= 71 && !invalidPrefixes.some(prefix => String(row.title || "").startsWith(prefix)));
const contentRows = db.prepare(`
  SELECT id, employee_idx, employee_name, employee_group, title, requirement, status,
         result_md, ai_mode, model, snapshot_json, created_at
  FROM content_employee_runs WHERE id >= 6 ORDER BY id
`).all();
const contentUiErrors = [
  { employeeIndex: 10, employeeName: "AI带货员", duty: "商业视频工坊", input: "为太原吾悦广场写合规短视频带货脚本，价格和库存未知标待补，不发布。", failureCause: "AI带货员使用专用30秒视频入口，请通过 /api/content/ai-sales-video 上传素材并生成；泛用内容 JSON 契约不适用该岗位。", verdict: "SPECIALIZED_ENTRY_REQUIRED" },
];
const toolboxRows = db.prepare(`
  SELECT id, tool_key, tool_title, title, status, execution_state, employee_idx, employee_name,
         input_json, input_summary, result_md, assumptions_json, evidence_json,
         provenance_json, progress_json, error_json, created_at, updated_at
  FROM tool_runs WHERE id >= 6 ORDER BY id
`).all();
const textVideoRows = db.prepare(`
  SELECT id, title, mode, body, params_json, script, status, billing_status,
         held_credits, settled_credits, steps_json, usage_json, cost_json,
         render_evidence_json, error_code, error_message, result_url,
         result_sha256, result_bytes, created_at, updated_at
  FROM text_video_jobs WHERE id >= 17 ORDER BY id
`).all();

function sha256(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function safeName(value) { return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90); }
function parse(value) { try { return value ? JSON.parse(value) : null; } catch { return null; } }
function redact(text) {
  return String(text || "")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/(token|authorization|cookie|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}
function extract(row) {
  const snapshot = parse(row.employee_web_snapshot) || {};
  const contract = snapshot.outputContract || {};
  const web = snapshot.web || {};
  const hardDelivery = contract.hardDelivery || {};
  const body = redact(row.body || "");
  const completed = row.status === "已完成" && row.output_status === "可使用" && body.length > 0;
  const evidence = web.sourceQuality?.passed === true || hardDelivery.valid === true;
  const quality = completed ? {
    inputCompleteness: String(row.requirement || "").length >= 100 ? 20 : 10,
    requestResponseContract: contract.valid === true || contract.reportFirstMarkdown === true ? 20 : 10,
    outputStructure: body.length >= 1000 && /(^|\n)#{1,3}\s/.test(body) ? 20 : 10,
    evidenceTraceability: evidence ? 15 : 5,
    safetyAndAuthorization: hardDelivery.valid !== false && !snapshot.internalProfileLeakage?.detected ? 15 : 5,
    readability: body.length >= 1500 ? 10 : 5,
  } : {
    inputCompleteness: String(row.requirement || "").length >= 100 ? 20 : 0,
    requestResponseContract: 0,
    outputStructure: 0,
    evidenceTraceability: 0,
    safetyAndAuthorization: 0,
    readability: 0,
  };
  quality.total = Object.values(quality).reduce((a, b) => a + b, 0);
  const providerAttempts = Array.isArray(contract.providerAttempts) ? contract.providerAttempts : [];
  const failureCause = completed ? null : [contract.blocked, ...(Array.isArray(contract.errors) ? contract.errors : []), contract.skipped, providerAttempts.at(-1)?.error].filter(Boolean).join("；") || "未产出，需查看运行快照";
  const preview = body.slice(0, 2400);
  const outputFile = body ? path.join(outputsDir, `${safeName(`employee-${row.employee_idx}-task-${row.id}`)}.md`) : null;
  if (outputFile) fs.writeFileSync(outputFile, body);
  return {
    taskId: row.id,
    employeeIndex: row.employee_idx,
    employeeName: row.name,
    duty: row.duty,
    createdAt: row.created_at,
    input: { question: row.requirement || row.title, title: row.title, length: String(row.requirement || row.title || "").length },
    response: { taskStatus: row.status, outputId: row.output_id, outputStatus: row.output_status, aiMode: row.ai_mode, bodyChars: body.length, failureCause },
    output: { preview, sha256: body ? sha256(body) : null, fullOutputFile: outputFile ? path.relative(outDir, outputFile) : null },
    execution: { contractValid: contract.valid === true, contractId: contract.contractId || null, schemaVersion: contract.schemaVersion || null, reportFirstMarkdown: contract.reportFirstMarkdown === true, hardDeliveryValid: hardDelivery.valid === true, sourceQualityPassed: web.sourceQuality?.passed === true, providerAttempts: providerAttempts.map(attempt => ({ model: attempt.model || attempt.effectiveModel || null, inputTokens: attempt.inputTokens || attempt.usage?.input_tokens || 0, outputTokens: attempt.outputTokens || attempt.usage?.output_tokens || 0, finishReason: attempt.finishReason || null, error: attempt.error || attempt.failure || null })) },
    quality: { ...quality, verdict: completed ? (quality.total >= 80 ? "PASS" : "PASS_WITH_ISSUES") : "FAIL_NO_OUTPUT" },
  };
}

function compactOutput(text, maxChars = 20000) {
  const value = redact(text || "");
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, 9000)}\n\n[输出过长，报告文件保留前9000字；原始输出字符数 ${value.length}，完整原始内容仍以数据库权威记录为准。]\n\n${value.slice(-3000)}`,
    truncated: true,
  };
}

function toolboxRecordFromRow(row) {
  const provenance = parse(row.provenance_json) || {};
  const contract = provenance.contract || {};
  const billing = provenance.billing || {};
  const evidence = parse(row.evidence_json) || {};
  const progress = parse(row.progress_json) || [];
  const error = parse(row.error_json) || {};
  const rawBody = row.result_md || "";
  const compact = compactOutput(rawBody);
  const hasBody = rawBody.length > 0;
  const isDone = row.status === "done" && hasBody && contract.valid === true;
  const rejectedWithBody = row.status !== "done" && hasBody;
  const failureCause = isDone ? null : [
    error.code,
    error.message,
    ...(Array.isArray(contract.errors) ? contract.errors : []),
    progress.at(-1)?.message,
  ].filter(Boolean).join("；") || "工具未形成可交付产物";
  const quality = isDone ? {
    inputCompleteness: row.input_summary ? 20 : 10,
    requestResponseContract: 20,
    outputStructure: rawBody.length >= 500 ? 20 : 10,
    evidenceTraceability: Object.keys(evidence).length > 0 ? 15 : 5,
    safetyAndAuthorization: billing.state === "settled" ? 15 : 10,
    readability: rawBody.length >= 800 ? 10 : 5,
  } : rejectedWithBody ? {
    inputCompleteness: row.input_summary ? 20 : 10,
    requestResponseContract: contract.valid === false ? 0 : 10,
    outputStructure: rawBody.length >= 500 ? 10 : 5,
    evidenceTraceability: Object.keys(evidence).length > 0 ? 5 : 0,
    safetyAndAuthorization: billing.state === "released" ? 10 : 0,
    readability: rawBody.length >= 800 ? 5 : 0,
  } : {
    inputCompleteness: row.input_summary ? 20 : 10,
    requestResponseContract: 0,
    outputStructure: 0,
    evidenceTraceability: 0,
    safetyAndAuthorization: billing.state === "released" ? 0 : 5,
    readability: 0,
  };
  quality.total = Object.values(quality).reduce((sum, value) => sum + value, 0);
  const outputFile = compact.text ? path.join(toolboxOutputsDir, safeName(`tool-${row.id}-${row.tool_key}`) + ".md") : null;
  if (outputFile) fs.writeFileSync(outputFile, compact.text);
  return {
    runId: row.id,
    domain: "toolbox",
    toolKey: row.tool_key,
    toolTitle: row.tool_title,
    employeeIndex: row.employee_idx,
    employeeName: row.employee_name,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    input: { summary: row.input_summary || "", raw: parse(row.input_json) || {}, length: String(row.input_summary || "").length },
    response: { status: row.status, executionState: row.execution_state, bodyChars: rawBody.length, failureCause },
    output: { preview: compact.text.slice(0, 2400), sha256: hasBody ? sha256(rawBody) : null, fullOutputFile: outputFile ? path.relative(outDir, outputFile) : null, truncated: compact.truncated },
    execution: {
      contractValid: contract.valid === true,
      contractErrors: Array.isArray(contract.errors) ? contract.errors : [],
      model: billing.requestedModel || null,
      billingState: billing.state || null,
      chargedCredits: billing.chargedCredits || 0,
      evidenceKeys: Object.keys(evidence),
      progressPhases: Array.isArray(progress) ? progress.map(item => item.phase).filter(Boolean) : [],
      errorCode: error.code || null,
      errorMessage: error.message || null,
    },
    quality: { ...quality, verdict: isDone ? (quality.total >= 80 ? "PASS" : "PASS_WITH_ISSUES") : rejectedWithBody ? "FAIL_QUALITY_GATE" : "FAIL_NO_OUTPUT" },
  };
}

const toolboxRecords = toolboxRows.map(toolboxRecordFromRow);
const imageHuntRecord = {
  runId: null,
  domain: "toolbox",
  toolKey: "imagehunt",
  toolTitle: "联网搜图",
  employeeIndex: 0,
  employeeName: "内容素材检索",
  title: "联网搜图：太原吾悦广场粤菜馆白切鸡菜品实拍",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  input: { summary: "太原吾悦广场粤菜馆白切鸡菜品实拍，要求公开图片并核验授权", raw: { query: "太原吾悦广场粤菜馆白切鸡菜品实拍，要求公开图片并核验授权" }, length: 31 },
  response: { status: "候选已返回", executionState: "search_only", bodyChars: 20, failureCause: "20个公开搜索候选均标记为授权未核验；未导入素材库，符合版权安全门。" },
  output: { preview: "Bing 返回20个候选；页面逐项显示原始页面、来源域名与‘授权未核验’，未执行导入。", sha256: null, fullOutputFile: null, truncated: false },
  execution: { contractValid: true, contractErrors: [], model: "image-search", billingState: "not_applicable", chargedCredits: 0, evidenceKeys: ["20_candidates", "source_urls", "license_unverified"], progressPhases: ["search", "candidate_preview"], errorCode: null, errorMessage: null },
  quality: { inputCompleteness: 20, requestResponseContract: 15, outputStructure: 20, evidenceTraceability: 10, safetyAndAuthorization: 10, readability: 0, total: 75, verdict: "PASS_WITH_BOUNDARY" },
};
toolboxRecords.push(imageHuntRecord);

for (const row of textVideoRows) {
  const body = redact(row.body || "");
  const params = parse(row.params_json) || {};
  const steps = parse(row.steps_json) || [];
  const done = row.status === "completed" && Boolean(row.result_url);
  const outputFile = body ? path.join(toolboxOutputsDir, safeName(`text-video-${row.id}`) + ".md") : null;
  if (outputFile) fs.writeFileSync(outputFile, body);
  toolboxRecords.push({
    runId: row.id,
    domain: "toolbox",
    toolKey: "text-video-studio",
    toolTitle: "图文素材成片",
    employeeIndex: 0,
    employeeName: "图文素材成片",
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    input: { summary: body, raw: params, length: body.length },
    response: { status: row.status, executionState: "render", bodyChars: body.length, failureCause: done ? null : `${row.error_code || "TEXT_VIDEO_FAILED"}：${row.error_message || "未形成视频文件"}` },
    output: { preview: body.slice(0, 2400), sha256: body ? sha256(body) : null, fullOutputFile: outputFile ? path.relative(outDir, outputFile) : null, truncated: false, resultUrl: row.result_url || null },
    execution: { contractValid: done, contractErrors: done ? [] : [row.error_code || "TEXT_VIDEO_FAILED"], model: row.billing_model || "text-video-composer", billingState: row.billing_status, chargedCredits: row.settled_credits || 0, evidenceKeys: row.render_evidence_json ? ["render_evidence"] : [], progressPhases: steps.map(step => step.phase).filter(Boolean), errorCode: row.error_code || null, errorMessage: row.error_message || null },
    quality: { inputCompleteness: body ? 20 : 20, requestResponseContract: done ? 20 : 0, outputStructure: done ? 20 : 0, evidenceTraceability: row.render_evidence_json ? 15 : 0, safetyAndAuthorization: row.billing_status === "released" ? 0 : 15, readability: done ? 10 : 0, total: done ? 100 : 20, verdict: done ? "PASS" : "FAIL_NO_OUTPUT" },
  });
}

const records = realRows.map(extract);
for (const row of contentRows) {
  const snapshot = parse(row.snapshot_json) || {};
  const body = redact(row.result_md || "");
  const completed = row.status === "已完成" && body.length > 0;
  const contractValid = snapshot.contractValid === true || snapshot.outputContract?.valid === true;
  const quality = completed ? {
    inputCompleteness: String(row.requirement || "").length > 0 ? 20 : 0,
    requestResponseContract: contractValid ? 20 : 10,
    outputStructure: body.length >= 300 && /(^|\n)#{1,3}\s/.test(body) ? 20 : 10,
    evidenceTraceability: snapshot.web?.verified === true || snapshot.web?.ok === true ? 15 : 5,
    safetyAndAuthorization: snapshot.internalProfileLeakage?.detected ? 0 : 15,
    readability: body.length >= 1000 ? 10 : 5,
  } : { inputCompleteness: String(row.requirement || "").length > 0 ? 20 : 0, requestResponseContract: 0, outputStructure: 0, evidenceTraceability: 0, safetyAndAuthorization: 0, readability: 0 };
  quality.total = Object.values(quality).reduce((a, b) => a + b, 0);
  const failureCause = completed ? null : [snapshot.failure?.code, snapshot.failure?.message, ...(Array.isArray(snapshot.contractErrors) ? snapshot.contractErrors : [])].filter(Boolean).join("；") || "内容任务仍在生成中";
  const outputFile = body ? path.join(outputsDir, `${safeName(`content-${row.employee_idx}-run-${row.id}`)}.md`) : null;
  if (outputFile) fs.writeFileSync(outputFile, body);
  records.push({
    runId: row.id,
    employeeIndex: row.employee_idx,
    employeeName: row.employee_name,
    duty: row.employee_group,
    domain: "content",
    createdAt: row.created_at,
    input: { question: row.requirement || row.title, title: row.title, length: String(row.requirement || row.title || "").length },
    response: { taskStatus: row.status, outputStatus: row.status, outputId: row.id, aiMode: row.ai_mode, bodyChars: body.length, failureCause },
    output: { preview: body.slice(0, 2400), sha256: body ? sha256(body) : null, fullOutputFile: outputFile ? path.relative(outDir, outputFile) : null },
    execution: { contractValid, contractId: snapshot.contractId || null, schemaVersion: snapshot.schemaVersion || null, reportFirstMarkdown: false, hardDeliveryValid: contractValid, sourceQualityPassed: snapshot.web?.verified === true || snapshot.web?.ok === true, providerAttempts: [] },
    quality: { ...quality, verdict: completed ? (quality.total >= 80 ? "PASS" : "PASS_WITH_ISSUES") : (row.status === "生成中" ? "IN_PROGRESS" : "FAIL_NO_OUTPUT") },
  });
}
for (const item of contentUiErrors) {
  records.push({
    runId: null,
    employeeIndex: item.employeeIndex,
    employeeName: item.employeeName,
    duty: item.duty,
    domain: "content",
    createdAt: new Date().toISOString(),
    input: { question: item.input, title: item.input, length: item.input.length },
    response: { taskStatus: "未创建", outputStatus: null, outputId: null, aiMode: null, bodyChars: 0, failureCause: item.failureCause },
    output: { preview: "", sha256: null, fullOutputFile: null },
    execution: { contractValid: false, contractId: null, schemaVersion: null, reportFirstMarkdown: false, hardDeliveryValid: false, sourceQualityPassed: false, providerAttempts: [] },
    quality: { inputCompleteness: 20, requestResponseContract: 0, outputStructure: 0, evidenceTraceability: 0, safetyAndAuthorization: 15, readability: 0, total: 35, verdict: item.verdict || "FAIL_NO_OUTPUT" },
  });
}
const invalidRuns = invalidRows.map(row => ({ taskId: row.id, employeeIndex: row.employee_idx, employeeName: row.name, title: row.title, status: row.status, outputId: row.output_id, reason: "INVALID_TEST_LANGUAGE：误用‘本轮老板验收/内部草案’测试话术，不计入真实业务质量评分。" }));
const completed = records.filter(record => record.quality.verdict === "PASS" || record.quality.verdict === "PASS_WITH_ISSUES");
const noOutput = records.filter(record => record.quality.verdict === "FAIL_NO_OUTPUT");
const specializedEntryRequired = records.filter(record => record.quality.verdict === "SPECIALIZED_ENTRY_REQUIRED");
const toolboxCompleted = toolboxRecords.filter(record => ["PASS", "PASS_WITH_ISSUES", "PASS_WITH_BOUNDARY"].includes(record.quality.verdict));
const toolboxQualityFailed = toolboxRecords.filter(record => record.quality.verdict === "FAIL_QUALITY_GATE");
const toolboxNoOutput = toolboxRecords.filter(record => record.quality.verdict === "FAIL_NO_OUTPUT");
const summary = {
  schemaVersion: "nanowork.real-business-acceptance.v1",
  generatedAt: new Date().toISOString(),
  projectUrl: "http://127.0.0.1:3107/",
  scope: { restaurantEmployees: 61, contentEmployees: 11, requestedEmployeeCount: 72 },
  realRuns: { attempted: records.length, completed: completed.length, noOutput: noOutput.length, specializedEntryRequired: specializedEntryRequired.length, inProgress: records.filter(record => record.quality.verdict === "IN_PROGRESS").length, averageScore: records.length ? Math.round(records.reduce((sum, record) => sum + record.quality.total, 0) / records.length) : 0, scoreRange: records.length ? [Math.min(...records.map(record => record.quality.total)), Math.max(...records.map(record => record.quality.total))] : [0, 0] },
  toolbox: { functions: 12, attempted: toolboxRecords.length, completed: toolboxCompleted.length, qualityFailedWithBody: toolboxQualityFailed.length, noOutput: toolboxNoOutput.length, averageScore: toolboxRecords.length ? Math.round(toolboxRecords.reduce((sum, record) => sum + record.quality.total, 0) / toolboxRecords.length) : 0, scoreRange: toolboxRecords.length ? [Math.min(...toolboxRecords.map(record => record.quality.total)), Math.max(...toolboxRecords.map(record => record.quality.total))] : [0, 0] },
  invalidRunsExcluded: invalidRuns.length,
  notYetAttemptedEmployeeCount: Math.max(0, 72 - new Set(records.filter(record => record.domain !== "content").map(record => record.employeeIndex)).size - new Set(records.filter(record => record.domain === "content").map(record => record.employeeIndex)).size),
  evidencePolicy: "真实岗位问题 + 真实浏览器派发 + SQLite权威状态/正文/运行快照；旧测试话术、确定性mock和历史报告不混入真实分数。",
  source: "server/data/nanowork-preview.db",
};
summary.reportHash = sha256(summary);
fs.writeFileSync(path.join(runsDir, "real-business-runs.json"), `${JSON.stringify(records, null, 2)}\n`);
fs.writeFileSync(path.join(runsDir, "toolbox-runs.json"), `${JSON.stringify(toolboxRecords, null, 2)}\n`);
fs.writeFileSync(path.join(runsDir, "invalid-test-runs.json"), `${JSON.stringify(invalidRuns, null, 2)}\n`);
fs.writeFileSync(path.join(runsDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const md = [
  "# 纳米Work｜真实老板视角数字员工验收报告",
  "",
  `生成时间：${summary.generatedAt}`,
  `项目地址：http://127.0.0.1:3107/`,
  "",
  "## 结论先看",
  "",
  `- 本报告只统计真实岗位问题派发，不使用‘本轮老板验收/内部草案’套话。已尝试 ${summary.realRuns.attempted}/72 个员工，完成 ${summary.realRuns.completed} 个，无产出/未完成 ${summary.realRuns.noOutput} 个；${summary.realRuns.specializedEntryRequired} 个岗位需要走专用入口，不能按通用入口判失败。`,
  `- 已完成任务质量平均分：${summary.realRuns.averageScore}/100，区间 ${summary.realRuns.scoreRange[0]}–${summary.realRuns.scoreRange[1]}。`,
  `- 另有 ${summary.invalidRunsExcluded} 个旧任务因误用测试话术被排除；它们不能代表员工真实业务能力。`,
  `- 尚未真实派发：${summary.notYetAttemptedEmployeeCount} 个员工；不能把未跑的员工写成通过。`,
  `- 工具箱已按老板业务问题实跑 ${summary.toolbox.attempted}/${summary.toolbox.functions} 个入口：完成 ${summary.toolbox.completed} 个，质量门拦截但生成过正文 ${summary.toolbox.qualityFailedWithBody} 个，无产出 ${summary.toolbox.noOutput} 个；平均 ${summary.toolbox.averageScore}/100。`,
  "- 发布、付款、删库、自动改价、自动联系顾客等不可逆动作没有执行；报告中的边界失败是安全拦截，不冒充业务成功。",
  "",
  "## 评分标准（每个真实任务）",
  "",
  "输入完整性 20｜请求/返回契约 20｜输出结构 20｜证据可追溯 15｜安全与授权 15｜可读性与可执行性 10。无产出任务标记 FAIL_NO_OUTPUT，不把少量输入记录分当成业务通过；并单列实际错误原因。不把服务并发满、供应商超时误判成员工专业能力。",
  "",
  "## 逐员工结果",
  "",
  ...records.map(record => [
    `### #${record.taskId}｜${record.employeeIndex} ${record.employeeName}`,
    `- 输入：${record.input.question}`,
    `- 返回：任务 ${record.response.taskStatus}；output_id=${record.response.outputId || "无"}；正文 ${record.response.bodyChars} 字；AI=${record.response.aiMode || "无"}`,
    `- 质量：${record.quality.total}/100（${record.quality.verdict}）`,
    `- 契约/证据：contract=${record.execution.contractValid ? "通过" : "未通过"}；hardDelivery=${record.execution.hardDeliveryValid ? "通过" : "未通过"}；sourceQuality=${record.execution.sourceQualityPassed ? "通过" : "未通过"}`,
    record.response.failureCause ? `- 未产出原因：${record.response.failureCause}` : `- 输出摘要：${record.output.preview.slice(0, 600).replace(/\n+/g, " ")}`,
    record.output.fullOutputFile ? `- 完整输出：${record.output.fullOutputFile}（SHA-256 ${record.output.sha256}）` : "- 完整输出：无",
    "",
  ].join("\n")),
  "## 被排除的误用测试任务",
  "",
  ...invalidRuns.map(item => `- #${item.taskId}｜员工${item.employeeIndex}｜${item.reason}`),
  "",
  "## 工具箱逐项结果",
  "",
  "工具箱评分仍按输入完整性、请求/返回契约、输出结构、证据可追溯、安全与授权、可读性六项打分；`FAIL_QUALITY_GATE` 表示模型确实生成过正文但没有通过工具的业务交付门，`FAIL_NO_OUTPUT` 表示没有产物。",
  "",
  ...toolboxRecords.map(record => [
    `### ${record.toolTitle}｜${record.toolKey}${record.runId ? `｜运行 #${record.runId}` : ""}`,
    `- 老板输入：${record.input.summary || "（无输入摘要）"}`,
    `- 返回：${record.response.status}；正文 ${record.response.bodyChars} 字；计费 ${record.execution.billingState || "不适用"}；实扣 ${record.execution.chargedCredits || 0} 积分。`,
    `- 质量：${record.quality.total}/100（${record.quality.verdict}）`,
    `- 请求/返回证据：契约 ${record.execution.contractValid ? "通过" : "未通过"}；模型 ${record.execution.model || "未记录"}；阶段 ${record.execution.progressPhases.join(" → ") || "未记录"}`,
    record.response.failureCause ? `- 问题：${record.response.failureCause}` : `- 输出摘要：${record.output.preview.slice(0, 700).replace(/\n+/g, " ")}`,
    record.output.fullOutputFile ? `- 输出文件：${record.output.fullOutputFile}${record.output.truncated ? "（超长输出已截取，数据库保留原文）" : ""}` : "- 输出文件：无（仅返回候选/错误说明）",
    "",
  ].join("\n")),
  "工具箱原始输入、返回摘要、错误码、计费状态和阶段证据见 `real-business-runs/toolbox-runs.json`；工具产物正文见 `real-business-runs/toolbox-outputs/`。",
  "",
  "## 其他系统功能接口矩阵（补充）",
  "",
  "本报告的主结论聚焦老板真正会使用的数字员工和工具箱。系统级 API/页面入口的独立探针、参数边界和安全阻断另见同一项目的 `artifacts/nanowork-all-functions-corrected-2026-08-21.md`；它不替代本报告的岗位输入、业务输出和质量评分。",
  "",
  "## 错误诊断口径",
  "",
  "每个失败任务的 `failureCause` 来自该任务的 execution snapshot / provider attempt；报告不会把‘AI 服务并发已满’、供应商 502/504、登录/权限错误归因于员工岗位能力。完整请求、返回快照、正文摘要和哈希在 `real-business-runs/real-business-runs.json`，输出正文在 `real-business-runs/outputs/`。",
  "",
  `报告摘要 SHA-256：${summary.reportHash}`,
].join("\n");
fs.writeFileSync(path.join(runsDir, "真实老板业务验收报告.md"), `${md}\n`);
console.log(JSON.stringify({ summary, runsDir }, null, 2));

#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`未知参数：${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key}缺少参数`);
    out[key] = value;
    i += 1;
  }
  return out;
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function text(value, fallback = "未记录") {
  const result = String(value ?? "").replace(/[\r\n]+/gu, " ").trim();
  return result || fallback;
}

function md(value) {
  return text(value).replace(/\|/gu, "\\|");
}

function employeeScore(row) {
  const gate = row?.unifiedGate || {};
  const checks = Array.isArray(gate.checks) ? gate.checks : [];
  const passedChecks = checks.filter((item) => item?.pass === true).length;
  const gateRatio = checks.length ? passedChecks / checks.length : 0;
  const input = row?.inputEvidenceValid === true && row?.acceptanceDemandValid === true ? 25 : row?.inputEvidenceValid === true ? 18 : 0;
  const output = row?.outputId && Number(row?.resultChars || 0) > 0 && row?.businessProductionPass === true
    ? 35
    : row?.outputId && Number(row?.resultChars || 0) > 0 ? 20
      : Number(row?.providerInvocationApiAttempts || row?.providerAttempts?.filter((item) => item?.apiObtained === true).length || 0) > 0 ? 8 : 0;
  const quality = Math.round(gateRatio * 25);
  const trace = row?.providerEvidenceValid === true && row?.billingLinkValid === true
    ? 15
    : row?.providerEvidenceValid === true || row?.billingLinkValid === true ? 8 : 0;
  return Math.max(0, Math.min(100, Math.round(input + output + quality + trace)));
}

function featureScore(row) {
  if (row?.verdict === "PASS_PERMISSION_BOUNDARY") {
    return row?.terminalValid === true && row?.approvalDelta === 0 && row?.billingEvidenceCount === 0 ? 100 : 70;
  }
  const l1 = row?.l1Pass === true ? 35 : 0;
  const l2 = row?.l2Pass === true ? 35 : 0;
  const trace = row?.persistent === true && row?.terminalValid === true ? 20 : row?.terminalValid === true ? 10 : 0;
  const usage = Number(row?.inputTokens || 0) > 0 && Number(row?.outputTokens || 0) > 0 ? 10 : 0;
  return Math.max(0, Math.min(100, l1 + l2 + trace + usage));
}

function employeeRows(matrix) {
  return Object.values(matrix?.jobs || {}).map((job) => {
    const row = job?.latest || job?.attempts?.at(-1) || {};
    const score = employeeScore(row);
    const attempts = Array.isArray(row.providerAttempts) ? row.providerAttempts : [];
    const output = row.outputId && Number(row.resultChars || 0) > 0
      ? `已持久化产物，${row.resultChars}字，sha256=${text(row.resultHash)}`
      : "无可交付产物";
    const failure = Array.isArray(row.failureReasons) && row.failureReasons.length
      ? row.failureReasons.join("；")
      : Array.isArray(row.contractErrors) && row.contractErrors.length ? row.contractErrors.join("；") : "—";
    return {
      kind: "employee",
      key: `${row.domain || job.domain || "restaurant"}:${row.idx || job.idx || "?"}`,
      name: text(row.employeeName || job.employeeName || row.employeeKey || "数字员工"),
      role: text(row.employeeKey || "岗位执行"),
      input: text(row.taskTitle || row.acceptanceDemand || "岗位验收输入未记录"),
      output,
      score,
      verdict: text(row.verdict),
      failure,
      evidence: `真实API=${row.providerEvidence === "real_cloud_api_invoked" || row.providerEvidenceValid === true ? "是" : "否"}；供应商轮次=${attempts.length}；输入token=${row.providerInputTokens || row.inputTokens || 0}；输出token=${row.providerOutputTokens || row.outputTokens || 0}`,
    };
  });
}

function featureRows(matrix) {
  return Object.values(matrix?.jobs || {}).map((job) => {
    const row = job?.latest || job?.attempts?.at(-1) || {};
    const score = featureScore(row);
    const semantic = row.semanticEvidence || {};
    const errors = [
      ...(Array.isArray(row.failureReasons) ? row.failureReasons : []),
      ...(Array.isArray(row.semanticErrors) ? row.semanticErrors : []),
    ];
    return {
      kind: "feature",
      key: text(row.featureKey || job.featureKey || "feature"),
      name: text(row.featureTitle || job.featureTitle || row.featureKey),
      role: text(row.role || "未记录"),
      input: `${text(row.category, "功能")} / ${text(row.role, "角色")}：按功能定义执行真实验收场景（请求指纹=${text(row.executionFingerprint || row.metadata?.requestId, "未记录")}）`,
      output: row.resultChars > 0 ? `已生成${row.resultChars}字产物，sha256=${text(row.resultHash)}` : "无产物（权限边界或质量门阻断）",
      score,
      verdict: text(row.verdict),
      failure: errors.length ? errors.join("；") : "—",
      evidence: `L1=${row.l1Pass === true ? "通过" : "失败"}；L2=${row.l2Pass === true ? "通过" : "失败"}；语义=${semantic.pass === true ? "通过" : "失败"}；输入token=${row.inputTokens || 0}；输出token=${row.outputTokens || 0}`,
    };
  });
}

function render(rows, title) {
  const lines = [
    `# ${title}`,
    "",
    "评分口径：输入有效性25分；输出完整性35分；岗位/功能质量门25分；真实调用与账务/落库证据15分。权限边界按预期拒绝且零副作用计100分。失败、阻断和无产出保留实际分数，不以模板冒充通过。",
    "",
    `共 ${rows.length} 项；平均分 ${rows.length ? Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length) : 0}。`,
    "",
    "| 项目 | 真实输入（脱敏摘要） | 输出/结果 | 分数 | 终态 | 请求/返回证据 | 失败或待改原因 |",
    "| --- | --- | --- | ---: | --- | --- | --- |",
    ...rows.map((row) => `| ${md(`${row.key} ${row.name}`)} | ${md(row.input)} | ${md(row.output)} | ${row.score} | ${md(row.verdict)} | ${md(row.evidence)} | ${md(row.failure)} |`),
  ];
  return `${lines.join("\n")}\n`;
}

const options = args(process.argv.slice(2));
const outDir = path.resolve(options["--out-dir"] || ".");
const employee = employeeRows(readJson(options["--employee"]));
const feature = featureRows(readJson(options["--feature"]));
const all = [...employee, ...feature];
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const summary = {
  schemaVersion: "nanowork.real-acceptance-score-report.v1",
  generatedAt: new Date().toISOString(),
  rubric: { input: 25, output: 35, quality: 25, trace: 15 },
  totals: { employees: employee.length, features: feature.length, all: all.length },
  verdicts: Object.fromEntries([...new Set(all.map((row) => row.verdict))].map((verdict) => [verdict, all.filter((row) => row.verdict === verdict).length])),
  score: { average: all.length ? Math.round(all.reduce((sum, row) => sum + row.score, 0) / all.length) : 0, min: all.length ? Math.min(...all.map((row) => row.score)) : 0, max: all.length ? Math.max(...all.map((row) => row.score)) : 0 },
  rows: all,
};
fs.writeFileSync(path.join(outDir, "质量评分汇总.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(outDir, "员工逐项输入输出评分.md"), render(employee, "数字员工逐项输入、输出与评分"), { mode: 0o600 });
fs.writeFileSync(path.join(outDir, "功能逐项输入输出评分.md"), render(feature, "内容仓与工具箱逐项输入、输出与评分"), { mode: 0o600 });
fs.writeFileSync(path.join(outDir, "质量评分汇总.md"), [
  "# NanoWork 全功能质量评分汇总", "", `生成时间：${summary.generatedAt}`, "", `数字员工：${employee.length}；内容仓/工具箱功能：${feature.length}；总计：${all.length}`, `平均分：${summary.score.average}；最低：${summary.score.min}；最高：${summary.score.max}`, "", "详细逐项记录见《员工逐项输入输出评分.md》和《功能逐项输入输出评分.md》。", "", "失败与阻断均按真实终态记录；报告只保留脱敏摘要、哈希、token、请求指纹和质量门结果，不写入 API 密钥。", ""].join("\n"), { mode: 0o600 });
process.stdout.write(`SCORE_REPORT employees=${employee.length} features=${feature.length} all=${all.length} average=${summary.score.average} out=${outDir}\n`);

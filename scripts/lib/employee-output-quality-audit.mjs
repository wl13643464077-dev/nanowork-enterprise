import crypto from "node:crypto";

import { findUnsupportedWriterMarketingFactClaims } from "../../server/src/engines/content-output-contract.js";
import { validateContentEmployeeOutputContract } from "../../server/src/engines/content-output-contract.js";
import { validateRestaurantEmployeeOutputContract } from "../../server/src/engines/restaurant-output-contract.js";
import {
  evaluateRestaurantMatrixOutputEvidence,
  isRestaurantMatrixReportFirstContract,
  validateContentLineageEdge,
} from "./real-employee-matrix.mjs";

export const EMPLOYEE_OUTPUT_QUALITY_AUDIT_SCHEMA =
  "nanowork.employee-output-quality-audit.v3";
export const EXPECTED_EMPLOYEE_COUNT = 70;
export const DEFAULT_MINIMUM_BODY_CHARS = Object.freeze({
  restaurant: 500,
  content: 400,
});
export const DEFAULT_CONTENT_MINIMUM_BODY_CHARS_BY_IDX = Object.freeze({
  0: 400,
  1: 400,
  2: 400,
  3: 400,
  4: 400,
  5: 400,
  6: 400,
  7: 400,
  8: 400,
  9: 400,
});

const REAL_MODEL_REJECT_PATTERN =
  /(?:mock|template|fallback|fixture|offline|no[-_ ]?network)/iu;
const INTERNAL_PROFILE_PATTERN =
  /(?:NW-IPG-[A-Za-z0-9-]+|【内部档案保密封条】|【完整岗位档案】|【全部核心能力·缺一不可】|【出厂必备岗位\s*Skill·不可停用】|【你的多项工作能力\(本次工作逐项运用|【你的进修技能库\(全网收集的最新打法|【内部岗位执行模板】|【完整工作方式】|【完整工作配置】)/iu;
const MISSING_MATERIAL_REQUIREMENT_PATTERN =
  /(?:岗位验收资料-\d+|当前没有额外岗位材料|未知项：[^\n]{0,300}未提供)/u;
const MISSING_MATERIAL_DISCLOSURE_PATTERN =
  /(?:待(?:核验|确认|补充|补齐|补证|采集|获取|验证|复核)|未知|未提供|缺少|不足以|无法(?:确认|判断|核验|得出)|数据缺口|证据缺口|材料缺口)/u;
const CONTENT_EMPLOYEES_REQUIRING_MISSING_MATERIAL_DISCLOSURE = new Set([
  3, 4, 7, 8, 9,
]);
const CONTENT_EMPLOYEES_REQUIRING_MARKETING_FACT_GROUNDING = new Set([
  3, 4, 5, 6, 7, 8,
]);

const PLACEHOLDER_PATTERNS = Object.freeze([
  { code: "LOREM_IPSUM", pattern: /lorem\s+ipsum/iu },
  {
    code: "TODO_TOKEN",
    pattern: /(?:^|[^A-Za-z])(?:TODO|TBD)(?:$|[^A-Za-z])/u,
  },
  { code: "TEMPLATE_VARIABLE", pattern: /\{\{[^{}\n]{1,120}\}\}/u },
  {
    code: "BRACKET_PLACEHOLDER",
    pattern: /[\[\uff3b](?:待填写|请填写|占位符|placeholder)[\]\uff3d]/iu,
  },
  {
    code: "PLAIN_RUNTIME_PLACEHOLDER",
    // “待补充/待核验”是证据不足时必须保留的诚实披露，不是运行时
    // 模板占位。只有明确要求调用者填写/指定内容的文本才按占位处理；
    // {{variable}}、[待填写]、替换指令等强模板信号仍由相邻规则拒绝。
    pattern: /(?:待填写|待指定)(?:\s*[：:]|[^，。；;\n]{0,40})/u,
  },
  {
    code: "REPLACE_INSTRUCTION",
    pattern: /请(?:在此)?(?:填写|替换)(?:为|：|:)/u,
  },
  {
    code: "MASKED_ENTITY",
    pattern:
      /(?:^|[\s：:|])(?:X{2,}|Ｘ{2,})(?:门店|公司|品牌|金额|日期|名称)?(?:$|[\s，。；;|])/u,
  },
  {
    code: "DEMO_PLACEHOLDER",
    pattern: /(?:仅供|只供|仅为|只是)(?:内部)?(?:演示|占位)|模板底稿|演示占位/u,
  },
  {
    code: "SELF_DECLARED_TEMPLATE",
    pattern:
      /(?:本内容|本产出|本结果|以下内容)[^\n。；]{0,18}(?:是|为|属于)[^\n。；]{0,8}(?:模板|演示|占位)/u,
  },
]);

const FACT_SPECS = Object.freeze({
  restaurant: Object.freeze([
    { code: "REVENUE", label: "营业额", expected: 100000, unit: "元" },
    { code: "ORDERS", label: "订单", expected: 2000, unit: "单" },
    { code: "FOOD_COST", label: "食材成本(?!率)", expected: 35000, unit: "元" },
    {
      code: "LABOR_COST",
      label: "人工成本(?!率)",
      expected: 22000,
      unit: "元",
    },
    { code: "COMPLAINTS", label: "顾客投诉", expected: 12, unit: "次" },
  ]),
  content: Object.freeze([
    { code: "REVENUE", label: "营业额", expected: 100000, unit: "元" },
    { code: "ORDERS", label: "订单", expected: 2000, unit: "单" },
    { code: "FOOD_COST", label: "食材成本(?!率)", expected: 35000, unit: "元" },
    {
      code: "TARGET_FOOD_COST_RATE",
      label: "目标食材成本率",
      expected: 32,
      unit: "%",
    },
  ]),
});

const EXTERNAL_ACTIONS = Object.freeze([
  { code: "PUBLISH", pattern: "(?:发布|上线)" },
  { code: "MEDIA_BUY", pattern: "投放" },
  { code: "PROCURE", pattern: "采购" },
  { code: "PAY", pattern: "(?:付款|支付|充值|退款)" },
  { code: "SIGN", pattern: "签约" },
  { code: "ACCOUNT_LOGIN", pattern: "登录(?:了)?(?:平台|渠道|账号|账户)" },
  {
    code: "ACCOUNT_CHANGE",
    pattern: "(?:调整|修改|删除|创建)(?:了)?(?:账号|账户)",
  },
  { code: "ORDER", pattern: "下单" },
  { code: "SCHEDULE", pattern: "定时(?:发布|执行|投放)" },
  {
    code: "SEND",
    pattern:
      "(?:发送|推送)(?:到|至|给)(?:[^\n。；]{0,12})(?:微信|公众号|小红书|视频号|客户|用户|外部平台|渠道|群)",
  },
]);

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex");
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function primaryTextArtifactFromSnapshot(
  value,
  expectedIdx,
  expectedEmployeeKey,
) {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const candidates = Array.isArray(parsed.artifacts)
    ? parsed.artifacts
    : [parsed];
  const matches = candidates.filter((candidate) => {
    if (!isPlainObject(candidate) || candidate.primary !== true) return false;
    if (
      !Number.isSafeInteger(candidate.employeeIdx) ||
      candidate.employeeIdx !== Number(expectedIdx)
    )
      return false;
    if (
      typeof candidate.employeeKey !== "string" ||
      candidate.employeeKey !== String(expectedEmployeeKey || "")
    )
      return false;
    if (typeof candidate.content !== "string" || !candidate.content.trim())
      return false;
    if (typeof candidate.mediaType !== "string") return false;
    const mediaType = candidate.mediaType.trim().toLowerCase().split(";", 1)[0];
    return (
      mediaType.startsWith("text/") ||
      mediaType === "application/json" ||
      mediaType.endsWith("+json")
    );
  });
  if (matches.length !== 1) return null;
  return {
    content: matches[0].content,
    kind: typeof matches[0].kind === "string" ? matches[0].kind : null,
    mediaType: matches[0].mediaType.trim(),
  };
}

function numberValue(raw, multiplier) {
  const numeric = Number(String(raw || "").replace(/,/gu, ""));
  if (!Number.isFinite(numeric)) return null;
  return numeric * (multiplier === "万" ? 10000 : 1);
}

function nearlyEqual(left, right) {
  return Math.abs(Number(left) - Number(right)) <= 0.0001;
}

function escapedRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sentenceBounds(text, index) {
  const stops = /[\n。！？；;]/u;
  let start = index;
  while (start > 0 && !stops.test(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !stops.test(text[end])) end += 1;
  return { start, end };
}

export function findPlaceholderSignals(body) {
  const text = String(body || "");
  return PLACEHOLDER_PATTERNS.filter((rule) => rule.pattern.test(text)).map(
    (rule) => rule.code,
  );
}

export function findKnownFactConflicts(body, domain) {
  const text = String(body || "");
  const conflicts = [];
  let checked = 0;
  for (const spec of FACT_SPECS[domain] || []) {
    // 只审计“指标名 + 直接数值 + 对应单位”的高置信陈述。
    // 不跨越“、”去拿下一个指标的数，也不把“占营业额57%”
    // 或“单均营业额50元/单”误判为57元、50元的营业额。
    const expression = new RegExp(
      `${spec.label}(?:\\s*(?:总额|实际(?:值)?|本期|当前))?\\s*(?:为|是|：|:|=)?\\s*([0-9][0-9,.]*)(万)?\\s*(%|元|单|次)`,
      "giu",
    );
    let match;
    while ((match = expression.exec(text))) {
      const { start, end } = sentenceBounds(text, match.index);
      const sentence = text.slice(start, end);
      const before = sentence.slice(0, match.index - start);
      const matchedText = match[0];
      const hypothetical =
        /(?:目标|假设|假如|如果|若|预计|预测|方案|场景|阈值|上限|下限|建议|预算|敏感性)/u.test(
          `${before.slice(-24)}${matchedText}`,
        ) && spec.code !== "TARGET_FOOD_COST_RATE";
      const derivedMetric =
        /(?:保本|盈亏平衡)(?:点)?(?:对应|所需|要求|需要)?\s*$/u.test(
          before.slice(-16),
        );
      const expectedUnit = spec.unit === "元" ? "元" : spec.unit;
      const observedUnit = match[3];
      const partOfFormula =
        /[+*/=][^\n。；;]{0,20}$/u.test(before) ||
        /(?:单均|均单|每单|客单)[^\n。；;]{0,8}$/u.test(before) ||
        /^\s*\/(?:单|笔|人)/u.test(
          sentence.slice(match.index - start + match[0].length),
        );
      if (
        hypothetical ||
        derivedMetric ||
        observedUnit !== expectedUnit ||
        partOfFormula
      )
        continue;
      const observed = numberValue(match[1], match[2]);
      if (observed === null) continue;
      checked += 1;
      if (!nearlyEqual(observed, spec.expected))
        conflicts.push({
          code: spec.code,
          expected: spec.expected,
          observed,
          unit: spec.unit,
        });
    }
  }
  return { checked, conflicts };
}

export function findUnsupportedMarketingFactConflicts(body, context = {}) {
  const groundingContext =
    context && typeof context === "object" && !Array.isArray(context)
      ? context
      : { requirement: String(context || "") };
  const claims = findUnsupportedWriterMarketingFactClaims(
    String(body || ""),
    groundingContext,
  );
  const unique = new Map();
  for (const claim of claims) {
    const key = `${claim.path}|${claim.label}`;
    if (!unique.has(key)) {
      unique.set(key, {
        code: "UNSUPPORTED_MARKETING_FACT",
        category: claim.label,
        path: claim.path,
      });
    }
  }
  return { checked: claims.length, conflicts: [...unique.values()] };
}

export function findExternalActionClaims(body) {
  const text = String(body || "");
  const findings = new Set();
  for (const action of EXTERNAL_ACTIONS) {
    const expression = new RegExp(
      `(?:已经|现已|已成功|成功(?:完成)?|已)(?:完成|执行|进行)?(?:了)?(?:对外)?${action.pattern}`,
      "giu",
    );
    let match;
    while ((match = expression.exec(text))) {
      const { start, end } = sentenceBounds(text, match.index);
      const sentence = text.slice(start, end);
      const localIndex = match.index - start;
      const before = sentence.slice(0, localIndex);
      const after = sentence.slice(localIndex + match[0].length);
      if (
        /(?:未|尚未|没有|并未|不得|不可|不能|不会|不应|禁止|严禁|拒绝|避免|不代表|不视为|不宣称|不声称|禁止声明|不得声称|若|如果|假如)[^\n。；;]{0,36}$/u.test(
          before,
        )
      )
        continue;
      if (
        /^(?:前|准备|草稿|计划|建议|清单|审核|审批|包|文案|素材|排期|能力|流程)/u.test(
          after,
        )
      )
        continue;
      findings.add(action.code);
    }
  }
  return [...findings].sort();
}

function check(code, label, passed, detail, metrics = {}) {
  return { code, label, status: passed ? "PASS" : "FAIL", detail, ...metrics };
}

function restaurantContractCheck(record, outputBody) {
  const contract = record.snapshot.outputContract || {};
  const artifacts = Array.isArray(contract.artifacts) ? contract.artifacts : [];
  const primary = artifacts.filter((item) => item?.primary === true);
  const expectedPattern = new RegExp(
    `^urn:nanowork:restaurant-output:${record.idx}:${escapedRegex(record.employeeKey)}:v[0-9]+$`,
    "u",
  );
  const actualId = String(contract.contractId || "");
  const reportFirst = isRestaurantMatrixReportFirstContract(contract);
  const qualityEvidenceMode = reportFirst
    ? "report_first_markdown"
    : "structured_json";
  const contractIdentityMatches = expectedPattern.test(actualId);
  const primaryEmployeeMatches =
    primary.length === 1 &&
    Number(primary[0]?.employeeIdx) === Number(record.idx);
  const sourceIdentityMatches =
    (record.source.specialistIdx == null ||
      Number(record.source.specialistIdx) === Number(record.idx)) &&
    (record.source.specialistKey == null ||
      String(record.source.specialistKey) === String(record.employeeKey));
  const reportFirstArtifactIdentityMatches =
    primaryEmployeeMatches &&
    (primary[0]?.employeeKey == null ||
      String(primary[0].employeeKey) === String(record.employeeKey || "")) &&
    (primary[0]?.contractId == null ||
      String(primary[0].contractId) === actualId);
  const structuredArtifactIdentityMatches =
    primaryEmployeeMatches &&
    String(primary[0]?.employeeKey || "") ===
      String(record.employeeKey || "") &&
    String(primary[0]?.contractId || "") === actualId;

  let identityMatches = false;
  let semanticValid = false;
  let authoritativeBodyHashValid = null;
  let hashSource = "structured_runtime_validator";
  let failureDetail = "契约ID、主产物或岗位标识不一致";

  if (reportFirst) {
    const reportFirstEvidence = evaluateRestaurantMatrixOutputEvidence({
      contract,
      outputBody,
      structuredSemantic: null,
    });
    identityMatches =
      contractIdentityMatches &&
      reportFirstArtifactIdentityMatches &&
      sourceIdentityMatches &&
      contract.parsedOutput == null &&
      String(primary[0]?.kind || "") === "markdown";
    authoritativeBodyHashValid =
      reportFirstEvidence.resultHashValid === true &&
      reportFirstEvidence.artifactHashValid === true;
    semanticValid =
      reportFirstEvidence.semanticValid === true && authoritativeBodyHashValid;
    hashSource = reportFirstEvidence.artifactHashSource;
    if (!reportFirstEvidence.semanticValid) {
      failureDetail = `report-first语义门未通过：${reportFirstEvidence.semanticErrors.slice(0, 5).join("；")}`;
    } else if (!authoritativeBodyHashValid) {
      failureDetail = `report-first权威正文哈希链未通过：${reportFirstEvidence.artifactHashErrors.slice(0, 5).join("；") || "正文与rendered/artifact/provider哈希不一致"}`;
    }
  } else {
    const parsedOutput = contract.parsedOutput || {};
    const runtimeValidation = validateRestaurantEmployeeOutputContract(
      record.idx,
      parsedOutput,
      { task: { title: record.taskTitle, requirement: record.requirement } },
    );
    identityMatches =
      contractIdentityMatches &&
      structuredArtifactIdentityMatches &&
      sourceIdentityMatches &&
      String(parsedOutput.contract_id || "") === actualId &&
      Number(parsedOutput.role?.employee_idx) === Number(record.idx) &&
      String(parsedOutput.role?.role_key || "") ===
        String(record.employeeKey || "");
    semanticValid = runtimeValidation.valid === true;
    if (!semanticValid) {
      failureDetail = `共享运行时语义门未通过：${runtimeValidation.errors.slice(0, 5).join("；")}`;
    }
  }

  if (contract.valid !== true) {
    failureDetail = "服务端输出契约未通过";
  } else if (record.matrix.contractValid !== true) {
    failureDetail = "真实员工矩阵未记录有效输出契约";
  } else if (!identityMatches) {
    failureDetail = "契约ID、主产物或岗位标识不一致";
  }

  const passed =
    contract.valid === true &&
    record.matrix.contractValid === true &&
    identityMatches &&
    semanticValid;
  return check(
    "CONTRACT_IDENTITY",
    "契约标识、岗位与运行时语义一致",
    passed,
    passed
      ? reportFirst
        ? "契约ID、Markdown主产物、岗位标识、最终交付硬门和权威正文哈希链均一致"
        : "契约ID、主产物、岗位标识和共享运行时语义门均一致"
      : failureDetail,
    {
      expectedIdentity: `restaurant:${record.idx}:${record.employeeKey}`,
      contractIdHash: actualId ? sha256(actualId) : null,
      semanticValid,
      qualityEvidenceMode,
      hashSource,
      authoritativeBodyHashValid,
    },
  );
}

function contentContractCheck(record) {
  const artifacts = Array.isArray(record.snapshot.artifacts)
    ? record.snapshot.artifacts
    : [];
  const primary = artifacts.filter((item) => item?.primary === true);
  const employee = record.snapshot.employee || {};
  const identityMatches =
    primary.length === 1 &&
    Number(primary[0]?.employeeIdx) === Number(record.idx) &&
    String(primary[0]?.employeeKey || "") ===
      String(record.employeeKey || "") &&
    Number(employee.idx) === Number(record.idx) &&
    String(employee.key || "") === String(record.employeeKey || "") &&
    Number(record.source.employeeIdx) === Number(record.idx) &&
    String(record.source.employeeKey || "") ===
      String(record.employeeKey || "");
  const errors = Array.isArray(record.snapshot.contractErrors)
    ? record.snapshot.contractErrors
    : [];
  const runtimeValidation = validateContentEmployeeOutputContract(
    record.idx,
    record.snapshot.validatedOutput,
    {
      title: record.snapshot.dispatch?.title || record.taskTitle,
      requirement: record.snapshot.dispatch?.requirement || record.requirement,
      feedback: record.snapshot.dispatch?.feedback || "",
      web: record.snapshot.web,
      enforceRequiredInputs: true,
      outputForCompletionGate: record.snapshot.validatedOutput,
    },
  );
  const passed =
    record.snapshot.contractValid === true &&
    record.matrix.contractValid === true &&
    errors.length === 0 &&
    identityMatches &&
    runtimeValidation.valid === true;
  return check(
    "CONTRACT_IDENTITY",
    "契约标识、岗位与采纳前运行时复验一致",
    passed,
    passed
      ? "内容契约、主产物、岗位标识和同源运行时契约均一致"
      : runtimeValidation.valid === false
        ? `同源运行时契约复验未通过：${runtimeValidation.errors.slice(0, 5).join("；")}`
        : "内容契约、主产物或岗位标识不一致",
    {
      expectedIdentity: `content:${record.idx}:${record.employeeKey}`,
      runtimeContractValid: runtimeValidation.valid === true,
      qualityEvidenceMode: "content_structured_json",
      hashSource: "content_runtime_validator",
    },
  );
}

function humanReviewCheck(record) {
  if (record.domain === "restaurant") {
    const review = record.review || {};
    const operationalHold =
      record.matrix.qaCapabilityRunnable === true &&
      record.matrix.operationalReady === false;
    if (operationalHold) {
      const blockers = Array.isArray(record.matrix.operationalBlockReasons)
        ? record.matrix.operationalBlockReasons.filter(Boolean)
        : [];
      const passed =
        record.matrix.capabilityPass === true &&
        record.matrix.businessProductionPass === false &&
        record.matrix.reviewDecision === "reject" &&
        record.matrix.terminalStatus === "已驳回" &&
        record.matrix.businessFlowStatus === "review_rejected" &&
        record.source.taskStatus === "已驳回" &&
        record.source.outputStatus === "已驳回" &&
        review.status === "已驳回" &&
        Number(review.reviewerId) > 0 &&
        Boolean(review.decidedAt) &&
        blockers.length > 0 &&
        (!record.matrix.reviewId ||
          Number(record.matrix.reviewId) === Number(review.id));
      return check(
        "HUMAN_REVIEW_TERMINAL",
        "人工审核终态",
        passed,
        passed
          ? "隔离QA能力产物已审阅；因业务证据未齐正确reject，未进入生产资产"
          : "业务未就绪时缺少明确阻塞码、有权驳回或非采纳终态",
        {
          reviewId: Number(review.id) || null,
          acceptanceOutcome: "CAPABILITY_PASS_OPERATIONALLY_BLOCKED",
          operationalBlockReasonCount: blockers.length,
          reviewDecision: record.matrix.reviewDecision || null,
          terminalStatus: record.matrix.terminalStatus || null,
          businessFlowStatus: record.matrix.businessFlowStatus || null,
        },
      );
    }
    const passed =
      record.matrix.reviewDecision === "adopt" &&
      record.matrix.terminalStatus === "已完成" &&
      record.source.taskStatus === "已完成" &&
      record.source.outputStatus === "可使用" &&
      review.status === "已通过" &&
      Number(review.reviewerId) > 0 &&
      Boolean(review.decidedAt) &&
      record.matrix.operationalReady !== false &&
      record.matrix.businessProductionPass !== false &&
      (!record.matrix.reviewId ||
        Number(record.matrix.reviewId) === Number(review.id));
    return check(
      "HUMAN_REVIEW_TERMINAL",
      "人工审核终态",
      passed,
      passed
        ? "主产物已由人工采纳并进入可使用终态"
        : "人工采纳、审批记录或可使用终态缺失",
      { reviewId: Number(review.id) || null },
    );
  }
  const review = record.snapshot.review || {};
  const permittedReviewerRole = ["boss", "admin", "platform_super"].includes(
    String(review.reviewerRole || ""),
  );
  const passed =
    record.matrix.reviewDecision === "adopt" &&
    record.matrix.terminalStatus === "已完成" &&
    record.source.runStatus === "已完成" &&
    review.decision === "adopt" &&
    Number(review.reviewerId) > 0 &&
    permittedReviewerRole &&
    Boolean(review.reviewedAt) &&
    Number(record.source.materialId) > 0 &&
    Number(record.source.materialId) === Number(review.materialId) &&
    (!record.matrix.materialId ||
      Number(record.matrix.materialId) === Number(record.source.materialId));
  return check(
    "HUMAN_REVIEW_TERMINAL",
    "人工审核终态",
    passed,
    passed
      ? "主产物已由有权人工采纳并沉淀为素材"
      : "有权人工采纳或素材终态证据缺失",
    { materialId: Number(record.source.materialId) || null },
  );
}

function minimumBodyCharsFor(record, options = {}) {
  const domain = record.domain === "content" ? "content" : "restaurant";
  const configured = Number(options.minimumBodyChars?.[domain]);
  const domainMinimum =
    Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_MINIMUM_BODY_CHARS[domain];
  if (
    domain !== "content" ||
    domainMinimum !== DEFAULT_MINIMUM_BODY_CHARS.content
  ) {
    return domainMinimum;
  }
  return (
    DEFAULT_CONTENT_MINIMUM_BODY_CHARS_BY_IDX[Number(record.idx)] ||
    domainMinimum
  );
}

export function auditEmployeeOutput(record, options = {}) {
  const domain = record.domain === "content" ? "content" : "restaurant";
  const primaryArtifact =
    domain === "content"
      ? primaryTextArtifactFromSnapshot(
          record.source?.artifactSnapshotJson,
          record.idx,
          record.employeeKey,
        )
      : null;
  const body = primaryArtifact?.content || String(record.body || "");
  const bodySource = primaryArtifact
    ? "material_primary_artifact"
    : "business_record";
  const minimumChars = minimumBodyCharsFor(record, options);
  const bodyPassed = !record.loadError && body.trim().length >= minimumChars;
  const leakage = record.snapshot.internalProfileLeakage;
  const internalMarkerDetected = INTERNAL_PROFILE_PATTERN.test(body);
  const leakageEvidencePresent = leakage && typeof leakage === "object";
  const placeholders = findPlaceholderSignals(body);
  const factAudit = findKnownFactConflicts(body, domain);
  const marketingFactAudit =
    domain === "content" &&
    CONTENT_EMPLOYEES_REQUIRING_MARKETING_FACT_GROUNDING.has(Number(record.idx))
      ? findUnsupportedMarketingFactConflicts(body, {
          requirement: record.requirement,
          web: record.snapshot?.web,
        })
      : { checked: 0, conflicts: [] };
  const factConflicts = [
    ...factAudit.conflicts,
    ...marketingFactAudit.conflicts,
  ];
  const requirementDeclaresMissingMaterial =
    MISSING_MATERIAL_REQUIREMENT_PATTERN.test(String(record.requirement || ""));
  const roleRequiresMissingDisclosure =
    domain === "restaurant" ||
    CONTENT_EMPLOYEES_REQUIRING_MISSING_MATERIAL_DISCLOSURE.has(
      Number(record.idx),
    );
  const requiresMissingDisclosure =
    roleRequiresMissingDisclosure && requirementDeclaresMissingMaterial;
  const hasMissingDisclosure = MISSING_MATERIAL_DISCLOSURE_PATTERN.test(body);
  const externalClaims = findExternalActionClaims(body);
  const providerModel = String(record.matrix.providerModel || "");
  const billingModel = String(record.matrix.billingModel || "");
  const resultModel = String(record.matrix.model || "");
  const positiveTokenEvidenceValid =
    Number(record.matrix.inputTokens) > 0 &&
    Number(record.matrix.outputTokens) > 0 &&
    Number(record.matrix.providerInputTokens) ===
      Number(record.matrix.inputTokens) &&
    Number(record.matrix.providerOutputTokens) ===
      Number(record.matrix.outputTokens) &&
    Number(record.matrix.billingInputTokens) ===
      Number(record.matrix.inputTokens) &&
    Number(record.matrix.billingOutputTokens) ===
      Number(record.matrix.outputTokens);
  const realMode =
    record.matrix.providerEvidence === "real_cloud_api" &&
    record.matrix.providerEvidenceValid === true &&
    record.matrix.aiMode === "api" &&
    record.source.aiMode === "api" &&
    record.matrix.providerMode === "api" &&
    providerModel.length > 0 &&
    !REAL_MODEL_REJECT_PATTERN.test(providerModel) &&
    record.matrix.billingAiMode === "api" &&
    billingModel.length > 0 &&
    !REAL_MODEL_REJECT_PATTERN.test(billingModel) &&
    providerModel.toLowerCase() === billingModel.toLowerCase() &&
    resultModel.toLowerCase() === providerModel.toLowerCase() &&
    positiveTokenEvidenceValid &&
    record.matrix.billingState === "settled" &&
    Number(record.matrix.chargedCredits) > 0 &&
    Number.isSafeInteger(Number(record.matrix.creditLogId)) &&
    Number(record.matrix.creditLogId) > 0 &&
    record.matrix.billingLinkValid === true &&
    record.matrix.billingFreshForAttempt === true &&
    record.matrix.businessFlowTerminal === true &&
    record.matrix.businessFlowComplete === true &&
    record.matrix.businessFlowBillingSettled === true &&
    record.matrix.externalPublish === false &&
    (domain !== "restaurant" ||
      (record.matrix.semanticValid === true &&
        record.matrix.inputEvidenceValid === true)) &&
    !REAL_MODEL_REJECT_PATTERN.test(resultModel);
  const contractIdentityCheck =
    domain === "restaurant"
      ? restaurantContractCheck(record, body)
      : contentContractCheck(record);
  const qualityEvidenceMode = contractIdentityCheck.qualityEvidenceMode;
  const hashSource = contractIdentityCheck.hashSource;
  const checks = [
    check(
      "BODY_INTEGRITY",
      "正文非空与长度",
      bodyPassed,
      bodyPassed
        ? `正文${body.trim().length}字符，达到${minimumChars}字符门槛`
        : record.loadError
          ? "数据库主产物不存在"
          : `正文${body.trim().length}字符，未达到${minimumChars}字符门槛`,
      {
        chars: body.trim().length,
        sha256: body ? sha256(body) : null,
        bodySource,
        artifactKind: primaryArtifact?.kind || null,
        artifactMediaType: primaryArtifact?.mediaType || null,
      },
    ),
    contractIdentityCheck,
    humanReviewCheck(record),
    check(
      "INTERNAL_PROFILE_CLEAR",
      "无内部档案标记",
      leakageEvidencePresent &&
        leakage.detected === false &&
        !internalMarkerDetected,
      !leakageEvidencePresent
        ? "缺少服务端内部档案防泄漏证据"
        : leakage.detected === true || internalMarkerDetected
          ? "产出命中内部档案防泄漏规则"
          : "服务端检查和独立文本扫描均未发现内部档案标记",
      {
        storedLeakageDetected: leakage?.detected ?? null,
        independentMarkerDetected: internalMarkerDetected,
      },
    ),
    check(
      "REAL_OUTPUT_NOT_PLACEHOLDER",
      "真实API、结算与无占位",
      realMode && placeholders.length === 0,
      !realMode
        ? "真实API提供商、Token、结算或餐饮语义/输入证据不完整"
        : placeholders.length
          ? `命中${placeholders.length}类占位信号`
          : "真实API、正Token、已结算和输入证据完整，未发现占位信号",
      {
        signals: placeholders,
        providerEvidence: record.matrix.providerEvidence || null,
        providerEvidenceValid: record.matrix.providerEvidenceValid === true,
        providerMode: record.matrix.providerMode || null,
        providerModel: providerModel || null,
        providerInputTokens: Number(record.matrix.providerInputTokens) || 0,
        providerOutputTokens: Number(record.matrix.providerOutputTokens) || 0,
        billingState: record.matrix.billingState || null,
        billingAiMode: record.matrix.billingAiMode || null,
        billingModel: billingModel || null,
        billingInputTokens: Number(record.matrix.billingInputTokens) || 0,
        billingOutputTokens: Number(record.matrix.billingOutputTokens) || 0,
        chargedCredits: Number(record.matrix.chargedCredits) || 0,
        creditLogId: Number(record.matrix.creditLogId) || null,
        billingLinkValid: record.matrix.billingLinkValid === true,
        billingFreshForAttempt: record.matrix.billingFreshForAttempt === true,
        businessFlowTerminal: record.matrix.businessFlowTerminal === true,
        businessFlowBillingSettled:
          record.matrix.businessFlowBillingSettled === true,
        semanticValid: record.matrix.semanticValid ?? null,
        inputEvidenceValid: record.matrix.inputEvidenceValid ?? null,
        positiveTokenEvidenceValid,
        qualityEvidenceMode,
        hashSource,
      },
    ),
    check(
      "KNOWN_FACTS_CONSISTENT",
      "已知事实未明显篡改",
      factConflicts.length === 0,
      factConflicts.length
        ? `发现${factConflicts.length}类高置信数值冲突或无依据营销事实`
        : "未发现与验收已知事实冲突的直接陈述",
      {
        checkedStatements: factAudit.checked,
        marketingClaimsDetected: marketingFactAudit.checked,
        conflicts: factConflicts,
      },
    ),
    check(
      "MISSING_MATERIAL_DISCLOSED",
      "缺材料时明确待核验",
      !requiresMissingDisclosure || hasMissingDisclosure,
      !roleRequiresMissingDisclosure
        ? "该岗位的验收产物不以重复披露任务中的通用缺料项为必选条件"
        : !requirementDeclaresMissingMaterial
          ? "任务未声明必须披露的材料缺口"
          : hasMissingDisclosure
            ? "已明确披露待确认、待核验或数据缺口"
            : "任务含缺失材料或未知项，正文未明确披露待核验",
      {
        applicable: requiresMissingDisclosure,
        roleRequiresDisclosure: roleRequiresMissingDisclosure,
        requirementDeclaresMissingMaterial,
        disclosed: hasMissingDisclosure,
      },
    ),
    check(
      "NO_EXTERNAL_ACTION_CLAIM",
      "无声称已执行外部动作",
      externalClaims.length === 0,
      externalClaims.length
        ? `发现${externalClaims.length}类疑似已执行外部动作声称`
        : "未发现已发布、付款、采购、签约、投放或操作账号的声称",
      { actionCodes: externalClaims },
    ),
  ];
  const failedChecks = checks
    .filter((item) => item.status === "FAIL")
    .map((item) => item.code);
  const operationalReady =
    domain !== "restaurant" || record.matrix.operationalReady !== false;
  const capabilityPass = failedChecks.length === 0;
  const operationalBlocked =
    capabilityPass && domain === "restaurant" && !operationalReady;
  const businessProductionPass =
    capabilityPass &&
    !operationalBlocked &&
    (domain !== "restaurant" || record.matrix.businessProductionPass !== false);
  return {
    employee: {
      domain,
      idx: Number(record.idx),
      key: String(record.employeeKey || ""),
      name: String(record.employeeName || ""),
    },
    trace: {
      businessType:
        domain === "restaurant" ? "restaurant_task" : "content_employee_run",
      businessId: Number(record.businessId) || null,
      outputId:
        Number(record.source.outputId || record.source.materialId) || null,
      attemptIdHash: record.attemptId ? sha256(record.attemptId) : null,
    },
    qaCapabilityRunnable:
      domain !== "restaurant" || record.matrix.qaCapabilityRunnable === true,
    qualityEvidenceMode,
    hashSource,
    positiveTokenEvidenceValid,
    operationalReady,
    operationalBlocked,
    operationalBlockReasons:
      operationalBlocked && Array.isArray(record.matrix.operationalBlockReasons)
        ? [...record.matrix.operationalBlockReasons]
        : [],
    capabilityPass,
    businessProductionPass,
    verdict: failedChecks.length
      ? "FAIL_QUALITY"
      : operationalBlocked
        ? "PASS_CAPABILITY_OPERATIONALLY_BLOCKED"
        : "PASS_QUALITY",
    failedChecks,
    checks,
  };
}

export function collectApprovedOutputRecords(matrix, database) {
  const entries = Object.entries(matrix?.jobs || {});
  const passedEntries = entries.filter(
    ([, value]) =>
      value?.latest?.pass === true &&
      value?.latest?.verdict === "PASS_REAL_API",
  );
  const records = [];
  const restaurantStatement =
    database.prepare(`SELECT t.id business_id,t.title task_title,t.requirement,t.status task_status,t.output_id,t.employee_web_snapshot,c.body,c.status output_status,c.ai_mode output_ai_mode,s.employee_idx specialist_idx,s.key specialist_key,a.id approval_id,a.status approval_status,a.reviewer_id,a.decided_at
    FROM agent_tasks t
    LEFT JOIN contents c ON c.id=t.output_id AND c.tenant_id=t.tenant_id
    LEFT JOIN specialists s ON s.id=t.specialist_id AND s.tenant_id=t.tenant_id
    LEFT JOIN approvals a ON a.id=(SELECT a2.id FROM approvals a2 WHERE a2.tenant_id=t.tenant_id AND a2.target_type='content' AND a2.target_id=t.output_id ORDER BY a2.id DESC LIMIT 1)
    WHERE t.id=?`);
  const contentStatement =
    database.prepare(`SELECT r.id business_id,r.title task_title,r.requirement,r.status run_status,r.result_md,r.ai_mode output_ai_mode,r.employee_idx,r.employee_key,r.snapshot_json,m.id material_id,m.artifact_snapshot_json
    FROM content_employee_runs r
    LEFT JOIN materials m ON m.id=(SELECT m2.id FROM materials m2 WHERE m2.tenant_id=r.tenant_id AND m2.source_type='content_employee_run' AND m2.source_id=r.id ORDER BY m2.id DESC LIMIT 1)
    WHERE r.id=?`);
  for (const [jobKey, value] of passedEntries) {
    const attempt = value.latest;
    const domain = attempt.domain === "content" ? "content" : "restaurant";
    const businessId = Number(attempt.businessId);
    const common = {
      domain,
      idx: Number(attempt.idx),
      employeeKey: String(attempt.employeeKey || ""),
      employeeName: String(attempt.employeeName || ""),
      businessId,
      attemptId: String(attempt.attemptId || ""),
      jobKey,
      matrix: {
        aiMode: attempt.aiMode,
        model: attempt.model,
        inputTokens: Number(attempt.inputTokens) || 0,
        outputTokens: Number(attempt.outputTokens) || 0,
        providerEvidence: attempt.providerEvidence,
        providerEvidenceValid: attempt.providerEvidenceValid === true,
        providerMode: attempt.providerMode,
        providerModel: attempt.providerModel,
        providerInputTokens: Number(attempt.providerInputTokens) || 0,
        providerOutputTokens: Number(attempt.providerOutputTokens) || 0,
        billingState: attempt.billingState,
        billingAiMode: attempt.billingAiMode,
        billingModel: attempt.billingModel,
        billingInputTokens: Number(attempt.billingInputTokens) || 0,
        billingOutputTokens: Number(attempt.billingOutputTokens) || 0,
        chargedCredits: Number(attempt.chargedCredits) || 0,
        creditLogId: Number(attempt.creditLogId) || null,
        billingLinkValid: attempt.billingLinkValid === true,
        billingFreshForAttempt: attempt.billingFreshForAttempt === true,
        contractValid: attempt.contractValid === true,
        semanticValid: attempt.semanticValid === true,
        inputEvidenceValid: attempt.inputEvidenceValid === true,
        qaCapabilityRunnable: attempt.qaCapabilityRunnable === true,
        operationalReady: attempt.operationalReady,
        operationalBlockReasons: Array.isArray(attempt.operationalBlockReasons)
          ? [...attempt.operationalBlockReasons]
          : [],
        capabilityPass: attempt.capabilityPass === true,
        businessProductionPass: attempt.businessProductionPass === true,
        reviewDecision: attempt.reviewDecision,
        reviewId: Number(attempt.reviewId) || null,
        materialId: Number(attempt.materialId) || null,
        terminalStatus: attempt.terminalStatus,
        businessFlowStatus: attempt.businessFlowStatus,
        businessFlowTerminal: attempt.businessFlowTerminal === true,
        businessFlowComplete: attempt.businessFlowComplete === true,
        businessFlowBillingSettled: attempt.businessFlowBillingSettled === true,
        externalPublish:
          attempt.externalPublish === false ? false : attempt.externalPublish,
      },
    };
    if (!Number.isSafeInteger(businessId) || businessId <= 0) {
      records.push({
        ...common,
        body: "",
        requirement: "",
        snapshot: {},
        source: {},
        review: {},
        loadError: "INVALID_BUSINESS_ID",
      });
      continue;
    }
    if (domain === "restaurant") {
      const row = restaurantStatement.get(businessId);
      records.push(
        row
          ? {
              ...common,
              body: String(row.body || ""),
              taskTitle: String(row.task_title || ""),
              requirement: String(row.requirement || ""),
              snapshot: parseJsonObject(row.employee_web_snapshot),
              source: {
                taskStatus: row.task_status,
                outputId: Number(row.output_id) || null,
                outputStatus: row.output_status,
                aiMode: row.output_ai_mode,
                specialistIdx:
                  row.specialist_idx == null
                    ? null
                    : Number(row.specialist_idx),
                specialistKey: row.specialist_key,
              },
              review: {
                id: Number(row.approval_id) || null,
                status: row.approval_status,
                reviewerId: Number(row.reviewer_id) || null,
                decidedAt: row.decided_at,
              },
            }
          : {
              ...common,
              body: "",
              requirement: "",
              snapshot: {},
              source: {},
              review: {},
              loadError: "RESTAURANT_TASK_NOT_FOUND",
            },
      );
      continue;
    }
    const row = contentStatement.get(businessId);
    records.push(
      row
        ? {
            ...common,
            body: String(row.result_md || ""),
            taskTitle: String(row.task_title || ""),
            requirement: String(row.requirement || ""),
            snapshot: parseJsonObject(row.snapshot_json),
            source: {
              runStatus: row.run_status,
              materialId: Number(row.material_id) || null,
              employeeIdx: Number(row.employee_idx),
              employeeKey: row.employee_key,
              aiMode: row.output_ai_mode,
              artifactSnapshotJson: row.artifact_snapshot_json,
            },
            review: {},
          }
        : {
            ...common,
            body: "",
            requirement: "",
            snapshot: {},
            source: {},
            review: {},
            loadError: "CONTENT_RUN_NOT_FOUND",
          },
    );
  }
  return records;
}

function checkSummary(results) {
  const codes = [
    ...new Set(
      results.flatMap((result) => result.checks.map((item) => item.code)),
    ),
  ];
  return codes.map((code) => {
    const checks = results
      .map((result) => result.checks.find((item) => item.code === code))
      .filter(Boolean);
    return {
      code,
      label: checks[0]?.label || code,
      passed: checks.filter((item) => item.status === "PASS").length,
      failed: checks.filter((item) => item.status === "FAIL").length,
    };
  });
}

function auditPipelineCoverage(matrix, required) {
  const stages = Array.from(
    { length: 10 },
    (_, idx) =>
      matrix?.pipeline?.stages?.[`content:${idx}`]?.latest ||
      matrix?.pipeline?.stages?.[`content:${idx}`] ||
      null,
  );
  const edges = Array.isArray(matrix?.pipeline?.edges)
    ? matrix.pipeline.edges
    : [];
  const failures = [];
  let passed = 0;
  for (let idx = 0; idx < stages.length; idx += 1) {
    const stage = stages[idx];
    if (!stage || stage.pipelinePass !== true) {
      failures.push({ idx, codes: ["STAGE_NOT_PASSED"] });
      continue;
    }
    if (idx === 0) {
      passed += 1;
      continue;
    }
    const edge = edges.find((item) => Number(item?.toIdx) === idx);
    const checked = validateContentLineageEdge(edge, stages[idx - 1], stage);
    if (!checked.valid) {
      failures.push({
        idx,
        codes: checked.errors.map(() => "LINEAGE_INVALID"),
      });
      continue;
    }
    passed += 1;
  }
  return {
    required,
    expectedStages: required ? 10 : 0,
    recordedStages: stages.filter(Boolean).length,
    passedStages: passed,
    edgeCount: edges.length,
    complete: required && passed === 10 && edges.length === 9,
    failures,
  };
}

export function buildEmployeeOutputQualityAudit({
  matrix,
  records,
  matrixFile,
  databaseFile,
  minimumBodyChars,
} = {}) {
  const results = records.map((record) =>
    auditEmployeeOutput(record, { minimumBodyChars }),
  );
  const matrixJobs = Object.values(matrix?.jobs || {})
    .map((value) => value?.latest)
    .filter(Boolean);
  const matrixPassed = matrixJobs.filter(
    (row) =>
      (row?.capabilityPass === true || row?.pass === true) &&
      row?.verdict === "PASS_REAL_API",
  ).length;
  const restaurantMatrixJobs = matrixJobs.filter(
    (row) => row.domain === "restaurant",
  );
  const restaurantQaCapabilityRunnable = restaurantMatrixJobs.filter(
    (row) => row.qaCapabilityRunnable === true,
  ).length;
  const restaurantOperationalReady = restaurantMatrixJobs.filter(
    (row) => row.operationalReady === true,
  ).length;
  const restaurantOperationalBlockedRows = restaurantMatrixJobs.filter(
    (row) =>
      row.qaCapabilityRunnable === true && row.operationalReady === false,
  );
  const selectedJobs = Array.isArray(matrix?.run?.selectedJobs)
    ? matrix.run.selectedJobs.length
    : EXPECTED_EMPLOYEE_COUNT;
  const expected = selectedJobs || EXPECTED_EMPLOYEE_COUNT;
  const qualityPassed = results.filter(
    (result) => result.capabilityPass === true,
  ).length;
  const qualityFailed = results.length - qualityPassed;
  const businessProductionPassed = results.filter(
    (result) => result.businessProductionPass === true,
  ).length;
  const operationalBlockedResults = results.filter(
    (result) => result.operationalBlocked === true,
  );
  const capabilityMatrixComplete =
    expected === EXPECTED_EMPLOYEE_COUNT &&
    matrixJobs.length === EXPECTED_EMPLOYEE_COUNT &&
    matrixPassed === EXPECTED_EMPLOYEE_COUNT;
  const pipeline = auditPipelineCoverage(
    matrix,
    expected === EXPECTED_EMPLOYEE_COUNT,
  );
  const matrixComplete = capabilityMatrixComplete && pipeline.complete;
  const overallStatus =
    qualityFailed > 0
      ? "FAIL_QUALITY"
      : matrixComplete
        ? operationalBlockedResults.length
          ? "PASS_COMPLETE_WITH_OPERATIONAL_BLOCKS"
          : "PASS_COMPLETE"
        : capabilityMatrixComplete
          ? "FAIL_PIPELINE"
          : operationalBlockedResults.length
            ? "PASS_PARTIAL_WITH_OPERATIONAL_BLOCKS"
            : "PASS_PARTIAL";
  return {
    schemaVersion: EMPLOYEE_OUTPUT_QUALITY_AUDIT_SCHEMA,
    generatedAt: new Date().toISOString(),
    evidencePolicy: {
      databaseAccess: "sqlite_read_only_query_only",
      externalApiCalls: 0,
      rawOutputIncluded: false,
      internalProfileIncluded: false,
      requiresStrictProviderBillingEvidence: true,
      expectedBlockedOutputCountsAsCapabilityPass: true,
      minimumBodyChars: {
        restaurant:
          Number(minimumBodyChars?.restaurant) ||
          DEFAULT_MINIMUM_BODY_CHARS.restaurant,
        content:
          Number(minimumBodyChars?.content) ||
          DEFAULT_MINIMUM_BODY_CHARS.content,
        contentByEmployeeIdx: Object.fromEntries(
          Array.from({ length: 10 }, (_, idx) => [
            idx,
            minimumBodyCharsFor(
              { domain: "content", idx },
              { minimumBodyChars },
            ),
          ]),
        ),
      },
    },
    source: {
      matrixFile:
        String(matrixFile || "")
          .split("/")
          .pop() || null,
      matrixSha256: matrix?.__sourceHash || null,
      databaseFile:
        String(databaseFile || "")
          .split("/")
          .pop() || null,
    },
    coverage: {
      expectedEmployees: expected,
      matrixJobs: matrixJobs.length,
      matrixPassed,
      matrixNotPassed: matrixJobs.length - matrixPassed,
      restaurantCapabilityPassed: restaurantMatrixJobs.filter(
        (row) => row.capabilityPass === true || row.pass === true,
      ).length,
      contentCapabilityPassed: matrixJobs.filter(
        (row) =>
          row.domain === "content" &&
          (row.capabilityPass === true || row.pass === true),
      ).length,
      restaurantQaCapabilityRunnable,
      restaurantOperationalReady,
      restaurantOperationalBlocked: restaurantOperationalBlockedRows.length,
      operationalBlockedEmployeeIndexes: restaurantOperationalBlockedRows
        .map((row) => Number(row.idx))
        .sort((left, right) => left - right),
      capabilityMatrixComplete,
      pipeline,
      auditedCapabilityOutputs: results.length,
      auditedTerminalOutputs: results.length,
      auditedBusinessProductionOutputs: businessProductionPassed,
      auditedOperationalBlockedOutputs: operationalBlockedResults.length,
      auditedApprovedOutputs: businessProductionPassed,
      auditedRejectedCapabilityOutputs: operationalBlockedResults.length,
      matrixComplete,
    },
    summary: {
      overallStatus,
      capabilityPassed: qualityPassed,
      businessProductionPassed,
      operationalBlocked: operationalBlockedResults.length,
      operationalBlockedEmployeeIndexes: operationalBlockedResults
        .map((result) => result.employee.idx)
        .sort((left, right) => left - right),
      qualityPassed,
      qualityFailed,
      checks: checkSummary(results),
    },
    employees: results,
  };
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\|/gu, "\\|")
    .replace(/[\r\n]+/gu, " ");
}

export function renderEmployeeOutputQualityAuditMarkdown(report) {
  const lines = [
    "# 真实数字员工产出质量审计",
    "",
    `生成时间：${report.generatedAt}`,
    "",
    "> 本报告仅包含脱敏校验结果、长度、哈希和业务追踪ID；不包含产出正文、提示词、技能库、工作配置或岗位档案。审计全程不调用外部API。",
    "",
    "## 结论",
    "",
    `- 总体状态：**${report.summary.overallStatus}**`,
    `- 单岗能力：餐饮${report.coverage.restaurantCapabilityPassed}/60，内容${report.coverage.contentCapabilityPassed}/10；能力通过=${report.coverage.matrixPassed}/${report.coverage.expectedEmployees}`,
    `- 餐饮隔离QA可跑=${report.coverage.restaurantQaCapabilityRunnable}/60；业务生产就绪=${report.coverage.restaurantOperationalReady}/60；业务阻断=${report.coverage.restaurantOperationalBlocked}/60（${report.coverage.operationalBlockedEmployeeIndexes.join("、") || "无"}）`,
    `- 0→9内容流水线：${report.coverage.pipeline.passedStages}/${report.coverage.pipeline.expectedStages}阶段，lineage edges=${report.coverage.pipeline.edgeCount}/9；流水线不替代内容10岗单岗数`,
    `- 本次审计：${report.coverage.auditedCapabilityOutputs}份真实API能力产物；能力/质量通过${report.summary.capabilityPassed}，业务生产通过${report.summary.businessProductionPassed}，生产阻断${report.summary.operationalBlocked}，失败${report.summary.qualityFailed}`,
    `- 终态口径：已采纳${report.coverage.auditedApprovedOutputs}，能力通过但预期驳回${report.coverage.auditedRejectedCapabilityOutputs}；预期驳回已真实运行并正确阻断生产，不计为未跑或失败。`,
    `- 数据库访问：${report.evidencePolicy.databaseAccess}；外部API调用：${report.evidencePolicy.externalApiCalls}`,
    "",
    "## 质量门汇总",
    "",
    "| 质量门 | 通过 | 失败 |",
    "| --- | ---: | ---: |",
    ...report.summary.checks.map(
      (item) =>
        `| ${markdownCell(item.label)} | ${item.passed} | ${item.failed} |`,
    ),
    "",
    "## 逐岗结果",
    "",
    "| 岗位 | 业务追踪 | 能力通过 | 业务生产通过 | 结果 | 正文字符 | 阻塞/未通过项 |",
    "| --- | --- | --- | --- | --- | ---: | --- |",
    ...report.employees.map((item) => {
      const body = item.checks.find(
        (checkItem) => checkItem.code === "BODY_INTEGRITY",
      );
      return `| ${markdownCell(`${item.employee.domain}:${item.employee.idx} ${item.employee.name}`)} | ${markdownCell(`${item.trace.businessType}#${item.trace.businessId}`)} | ${item.capabilityPass ? "YES" : "NO"} | ${item.businessProductionPass ? "YES" : "NO"} | ${item.verdict} | ${body?.chars || 0} | ${markdownCell(item.operationalBlockReasons.join("、") || item.failedChecks.join("、") || "—")} |`;
    }),
  ];
  const failures = report.employees.filter(
    (item) => item.capabilityPass !== true,
  );
  if (failures.length) {
    lines.push("", "## 需迭代项", "");
    for (const result of failures) {
      lines.push(
        `### ${result.employee.domain}:${result.employee.idx} ${result.employee.name}`,
        "",
      );
      for (const item of result.checks.filter(
        (checkItem) => checkItem.status === "FAIL",
      ))
        lines.push(`- ${item.code}：${item.detail}`);
      lines.push("");
    }
  }
  lines.push(
    "",
    "## 解读边界",
    "",
    "- “已知事实未明显篡改”是确定性高置信扫描，只阻断与验收任务中标准数值直接冲突的陈述；不替代专业事实核查。",
    "- “无声称已执行外部动作”检查已发布、投放、采购、支付、签约、登录/修改账号等完成性声称；“建议发布”或“尚未发布”不会被误判。",
    "- 单岗矩阵未达70/70时，报告只能是部分证据；即使70/70完成，0→9流水线未达10/10也不能记为完整验收。",
    "",
  );
  return lines.join("\n");
}

export function sourceHash(value) {
  return sha256(value);
}

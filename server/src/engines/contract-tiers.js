// 岗位契约分级（三视角评审 P0-1）：按“租户数据模式 × 模型档位”决定契约严格度。
//
// 本模块只有纯函数：不读配置、不访问数据库、不发网络请求。它回答三个问题：
// 1. 这次派活按哪个档位校验（resolveContractTier）；
// 2. 某条校验消息属于哪一类规则（classifyContractRule）；
// 3. 全部尝试用尽仍未通过时，能否以“未达标草稿”交付而不是交白卷
//    （classifyEmployeeDraftDisposition）。
//
// 安全底线（外发/付费/不可逆、内部档案泄漏、平台身份伪造、凭据 URL）在任何档位
// 都是硬门，也是唯一让草稿不落库、预授权走原释放路径的类别。这与 D-050（不放松
// 质量门）、D-065（demo 非安全类质检 advisory）、D-067（审核与交付解耦、草稿先可见）一致。

export const CONTRACT_TIERS = Object.freeze(["strict", "standard", "lenient"]);

export const CONTRACT_TIER_LABELS = Object.freeze({
  strict: "严格（老板级模型）",
  standard: "标准（员工级模型）",
  lenient: "宽松（演示租户）",
});

// 老板级模型：旗舰/推理类模型。未知模型在 live 下沿用既有 strict 行为，
// 不会因为新增了一个模型名而意外放宽。
const BOSS_GRADE_MODEL_PATTERN =
  /^(?:gpt-5|gpt-4|o[1-9](?:-|$)|claude-(?:opus|sonnet)|gemini-[\d.]+-pro|deepseek-(?:r\d|reasoner)|qwen-max|glm-[\d.]+-plus)/iu;
// 员工级模型：轻量/经济档。
const EMPLOYEE_GRADE_MODEL_PATTERN =
  /(?:flash|lite|mini|nano|turbo|haiku|deepseek-(?:chat|v\d)|qwen-(?:plus|turbo)|glm-[\d.]+-(?:air|flash))/iu;

export function normalizeContractTier(value, fallback = "strict") {
  const tier = String(value || "")
    .trim()
    .toLowerCase();
  return CONTRACT_TIERS.includes(tier) ? tier : fallback;
}

export function modelGrade(model) {
  const name = String(model || "").trim();
  if (!name) return "unknown";
  if (BOSS_GRADE_MODEL_PATTERN.test(name)) return "boss";
  if (EMPLOYEE_GRADE_MODEL_PATTERN.test(name)) return "employee";
  return "unknown";
}

/**
 * live + 老板级模型 → strict；live + 员工级模型 → standard；demo → lenient。
 * employeeIdx 目前只用于留下决策依据，不改变结果（预留岗位级覆盖）。
 */
export function resolveContractTier({ model, dataMode, employeeIdx } = {}) {
  if (String(dataMode || "").trim().toLowerCase() === "demo") return "lenient";
  const grade = modelGrade(model);
  void employeeIdx;
  return grade === "employee" ? "standard" : "strict";
}

export function describeContractTier({ model, dataMode, employeeIdx } = {}) {
  const tier = resolveContractTier({ model, dataMode, employeeIdx });
  return {
    tier,
    label: CONTRACT_TIER_LABELS[tier],
    dataMode: String(dataMode || "").trim().toLowerCase() === "demo" ? "demo" : "live",
    modelGrade: modelGrade(model),
    requestedModel: String(model || "").trim() || null,
  };
}

// ===== 规则分类 =====
// 分类只看校验消息文本，不改规则本体；restaurant-output-contract.js 的 severityFor
// 基于同一分类决定“硬门/警告”。
const RULE_CATEGORY_PATTERNS = Object.freeze([
  [
    "safety",
    /内部岗位档案|不得声称已外发|外发、付款或执行不可逆动作|绕过授权|伪造或冒用平台身份|规避平台规则|未经平台许可|带用户名、密码凭据的URL|无效URL/u,
  ],
  [
    "provenance",
    /补造来源|不在本次联网证据快照|不是本次已验证联网来源|无已验证联网快照时声称|没有权威允许来源快照|必须等于权威采集日期|禁止模型自填旧日期|逐字引用/u,
  ],
  [
    "authority",
    /review_note.*不得预先声称|机器契约、JSON结构或技术校验通过不等于/u,
  ],
  [
    "structure",
    /不是有效JSON|输出为空|顶层必须是JSON对象|缺少必需字段|未知字段|必须是JSON对象|必须是数组|必须是字符串|必须是非空文本|必须是整数|必须是布尔值|不在允许值范围|必须等于岗位契约规定值|不能为空数组|最多允许\d+项|模板占位文本|Schema示例|decision_context\.problem|检索责任退回给老板|正文不足200字|finish_reason|候选可能未完整|输出必须是JSON对象|JSON骨架而非可读岗位报告/u,
  ],
  ["skeleton", /\$\.input_audit|\$\.method_execution|输入审计|方法执行/u],
  ["arithmetic", /算术表达不一致|金额单位换算不一致/u],
  // 责任人/核验动作/时限：老板据此追责，standard 档保持硬门（lenient 与既有 demo advisory 一致为警告）
  [
    "accountability",
    /必须包含具体动作、责任角色、明确时限|必须包含具体假设、影响、核验动作、岗位责任角色|必须写具体owner、核验action和明确deadline|缺少明确执行动词|具体owner、明确deadline/u,
  ],
  [
    "completeness",
    /正文少于\d+项|未覆盖交付物核心维度|至少需要\d+个实际正文项|work_product”中“[^”]+”缺少|整份产出至少需要1项verified|岗位质量门必须至少有一项|至少一项必须有证据地通过|不能全部只是收集或补齐材料|只声明制品存在|禁止复制条目凑数|禁止复制泛化文本/u,
  ],
  ["numeric", /阈值/u],
  [
    "traceability",
    /可追溯的材料或系统来源|未回指本次来源|未引用本次任务提供的任何证据编号|可复核事实或具体证据缺口|写明可追溯来源/u,
  ],
]);

export function classifyContractRule(rule) {
  const text = String(rule || "");
  for (const [category, pattern] of RULE_CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return "quality";
}

// 各档位的硬门类别。lenient 与既有 demo advisory 完全一致；standard 在其上把
// “完整度”类规则升回硬门；strict 全部硬门。数值阈值/可追溯/措辞类在 standard 与
// lenient 下降为可见警告。
const HARD_CATEGORIES_BY_TIER = Object.freeze({
  strict: null, // 全部硬门
  standard: Object.freeze(
    new Set([
      "safety",
      "provenance",
      "authority",
      "structure",
      "skeleton",
      "arithmetic",
      "accountability",
      "completeness",
    ]),
  ),
  lenient: Object.freeze(
    new Set([
      "safety",
      "provenance",
      "authority",
      "structure",
      "skeleton",
      "arithmetic",
    ]),
  ),
});

export function ruleCategoryIsHard(category, tier) {
  const normalized = normalizeContractTier(tier);
  const hard = HARD_CATEGORIES_BY_TIER[normalized];
  if (hard === null) return true;
  return hard.has(String(category || ""));
}

export const CONTRACT_RULE_CATEGORIES = Object.freeze([
  "safety",
  "provenance",
  "authority",
  "structure",
  "skeleton",
  "arithmetic",
  "accountability",
  "completeness",
  "numeric",
  "traceability",
  "quality",
]);

/** 档位 × 类别 → 'error' | 'warning' 的完整表，供文档与测试锁定。 */
export function contractTierMatrix() {
  const matrix = {};
  for (const tier of CONTRACT_TIERS) {
    matrix[tier] = {};
    for (const category of CONTRACT_RULE_CATEGORIES) {
      matrix[tier][category] = ruleCategoryIsHard(category, tier)
        ? "error"
        : "warning";
    }
  }
  return matrix;
}

// ===== 老板可读的检查项名称（前端不出现契约 ID/指纹等技术词） =====
const CATEGORY_HUMAN_LABELS = Object.freeze({
  safety: "触碰安全边界（外发、付费、平台身份或内部档案）",
  provenance: "引用了本次未核验的来源或日期",
  authority: "把未完成的采用/授权写成已完成",
  structure: "报告结构不完整",
  skeleton: "输入核对或方法执行记录不完整",
  arithmetic: "数字前后不一致",
  accountability: "行动缺少明确的负责人、动作或时限",
  completeness: "交付内容不够完整",
  numeric: "指标或阈值没有写清",
  traceability: "结论缺少可追溯的依据",
  quality: "表述或论证质量不足",
});

function humanizeSingleRule(rule) {
  return String(rule || "")
    .replace(/字段“\$\.[^”]*”/gu, "对应栏目")
    .replace(/\$\.[A-Za-z0-9_.[\]]+/gu, "对应栏目")
    .replace(/decision_context|input_audit|method_execution|work_product|quality_review|acceptance_checks|deliverables|evidence_refs?|review_note/gu, "对应栏目")
    .replace(/供应商finish_reason=[a-z_]+，/gu, "")
    .replace(/(?:contractId|schemaVersion|digestFingerprint|sha256)[^，。；]*/gu, "")
    .replace(/JSON对象|JSON结构|JSON/gu, "报告格式")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .slice(0, 160);
}

/**
 * 把机器校验消息折叠成老板可读的“未通过的检查”。同类合并，附上最多两条具体说明。
 */
export function humanizeContractFailures(errors = []) {
  const groups = new Map();
  for (const error of Array.isArray(errors) ? errors : []) {
    const text = String(error || "").trim();
    if (!text) continue;
    const category = classifyContractRule(text);
    const entry = groups.get(category) || {
      category,
      label: CATEGORY_HUMAN_LABELS[category] || CATEGORY_HUMAN_LABELS.quality,
      count: 0,
      details: [],
    };
    entry.count += 1;
    if (entry.details.length < 2) {
      const detail = humanizeSingleRule(text);
      if (detail && !entry.details.includes(detail)) entry.details.push(detail);
    }
    groups.set(category, entry);
  }
  return [...groups.values()];
}

// ===== 草稿落库判定 =====
const SAFETY_CATEGORIES = new Set(["safety"]);
const NON_ACCEPTABLE_CATEGORIES = new Set(["safety", "provenance"]);

// “没有可用产物 / 伪造”：这些结构类失败说明模型根本没有交出一份可读的岗位产物
// （空输出、非 JSON、伪造契约身份、顶层骨架缺失、回显模板/Schema、截断），不是
// “拿到了真实正文但质量规则没过”。它们与模板底稿同样走原“失败 + 全额释放”路径，
// 不落草稿——草稿只保留给老板真的能读、能判断的正文。
// 顶层缺字段只看 `$.` 后一层（`缺少必需字段：$.deliverables。`）；嵌套缺字段仍是可读草稿。
// 派活 Markdown 模式下无法识别为契约、也不是报告的裸 JSON 骨架，与伪造契约身份同一处置。
const NO_DELIVERABLE_PATTERNS = Object.freeze([
  /输出为空/u,
  /不是有效JSON/u,
  /顶层必须是JSON对象|输出必须是JSON对象/u,
  /必须等于岗位契约规定值/u,
  /JSON骨架而非可读岗位报告/u,
  /缺少必需字段：\$\.[A-Za-z0-9_]+。/u,
  /模板占位文本|Schema示例/u,
  /finish_reason|候选可能未完整/u,
]);

export function isNoDeliverableRule(rule) {
  const text = String(rule || "");
  return NO_DELIVERABLE_PATTERNS.some((pattern) => pattern.test(text));
}

function positiveTokens(usage) {
  const input = Number(usage?.inputTokens);
  const output = Number(usage?.outputTokens);
  return (
    Number.isFinite(input) &&
    Number.isFinite(output) &&
    input > 0 &&
    output > 0
  );
}

/**
 * 全部尝试用尽仍未通过时的处置：
 * - blockedBy='safety'：命中安全底线（含内部档案泄漏），不落草稿，走原失败/释放路径；
 * - blockedBy='no_text' / 'not_api' / 'no_deliverable' / 'no_usage' / 'incomplete'：
 *   没有可展示的完整正文（空、模板底稿、非 JSON/伪造契约/顶层骨架缺失/回显模板、截断）
 *   或没有可结算用量，也不落草稿；
 * - eligible=true：以“未达标草稿”落库，按真实用量结算。acceptable=false 表示草稿
 *   含来源类硬错（补造来源），老板只能重新派活，不能“就用这份草稿”。
 */
export function classifyEmployeeDraftDisposition({
  contractErrors = [],
  hardDeliveryErrors = [],
  internalProfileLeakage = null,
  text = "",
  mode = "api",
  usage = null,
  complete = true,
  failReason = "contract",
} = {}) {
  const allErrors = [
    ...(Array.isArray(contractErrors) ? contractErrors : []),
    ...(Array.isArray(hardDeliveryErrors) ? hardDeliveryErrors : []),
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const unique = [...new Set(allErrors)];
  const categorized = unique.map((rule) => ({
    rule,
    category: classifyContractRule(rule),
  }));
  const safetyErrors = categorized
    .filter((item) => SAFETY_CATEGORIES.has(item.category))
    .map((item) => item.rule);
  if (internalProfileLeakage?.detected === true) {
    safetyErrors.push("餐饮数字员工输出包含内部岗位档案，已阻止交付。");
  }
  const provenanceErrors = categorized
    .filter((item) => item.category === "provenance")
    .map((item) => item.rule);
  const qualityErrors = categorized
    .filter((item) => !NON_ACCEPTABLE_CATEGORIES.has(item.category))
    .map((item) => item.rule);
  const noDeliverableErrors = unique.filter((rule) => isNoDeliverableRule(rule));
  const normalizedText = String(text || "").trim();

  let blockedBy = null;
  if (safetyErrors.length) blockedBy = "safety";
  else if (!normalizedText) blockedBy = "no_text";
  else if (String(mode || "").toLowerCase() !== "api") blockedBy = "not_api";
  else if (noDeliverableErrors.length) blockedBy = "no_deliverable";
  else if (!positiveTokens(usage)) blockedBy = "no_usage";
  else if (complete === false) blockedBy = "incomplete";

  return {
    eligible: blockedBy === null,
    blockedBy,
    acceptable: blockedBy === null && provenanceErrors.length === 0,
    failReason: String(failReason || "contract"),
    safetyErrors: [...new Set(safetyErrors)],
    provenanceErrors,
    noDeliverableErrors,
    qualityErrors,
    failedChecks: humanizeContractFailures(unique),
    categories: categorized,
  };
}

/** 写入 agent_tasks.contract_report 的快照（不含正文）。 */
export function buildDraftContractReport({
  disposition,
  contractTier,
  attempts = 0,
  transportFailures = 0,
  stoppedReason = null,
  deliveryStyle = null,
  requestedModel = null,
  effectiveModel = null,
  contractErrors = [],
} = {}) {
  return {
    schemaVersion: "nanowork.employee-draft-contract-report/1",
    contractTier: normalizeContractTier(contractTier),
    failReason: disposition?.failReason || "contract",
    acceptable: disposition?.acceptable === true,
    attempts: Number(attempts) || 0,
    transportFailures: Number(transportFailures) || 0,
    stoppedReason: stoppedReason || null,
    deliveryStyle: deliveryStyle || null,
    requestedModel: requestedModel || null,
    effectiveModel: effectiveModel || null,
    failedChecks: disposition?.failedChecks || [],
    failedRules: (Array.isArray(contractErrors) ? contractErrors : [])
      .map(String)
      .slice(0, 40),
    provenanceIssues: disposition?.provenanceErrors?.length || 0,
    qualityIssues: disposition?.qualityErrors?.length || 0,
  };
}

export const AGENT_TASK_DRAFT_STATUS = "草稿待处理";
export const CONTENT_DRAFT_STATUS = "未达标草稿";

/**
 * 契约分级（P0-1）：档位解析、严格度映射、草稿处置分类、老板可读文案。
 * 纯函数测试，不依赖数据库与网络。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NANOWORK_DB = ":memory:";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

const {
  CONTRACT_TIERS,
  CONTRACT_RULE_CATEGORIES,
  classifyContractRule,
  classifyEmployeeDraftDisposition,
  contractTierMatrix,
  humanizeContractFailures,
  isNoDeliverableRule,
  modelGrade,
  normalizeContractTier,
  resolveContractTier,
  ruleCategoryIsHard,
} = await import("../src/engines/contract-tiers.js");
const { severityFor, validateRestaurantEmployeeOutputContract } = await import(
  "../src/engines/restaurant-output-contract.js"
);

test("档位解析：live+老板级=strict，live+员工级=standard，demo=lenient，未知模型按 strict 收紧", () => {
  assert.equal(resolveContractTier({ model: "gpt-5.5", dataMode: "live" }), "strict");
  assert.equal(resolveContractTier({ model: "gpt-5.5", dataMode: "demo" }), "lenient");
  assert.equal(
    resolveContractTier({ model: "deepseek-v4-flash", dataMode: "live", employeeIdx: 102 }),
    "standard",
  );
  assert.equal(resolveContractTier({ model: "deepseek-v4-flash", dataMode: "demo" }), "lenient");
  assert.equal(resolveContractTier({ model: "gemini-3.1-flash-lite", dataMode: "live" }), "standard");
  assert.equal(resolveContractTier({ model: "some-unknown-model", dataMode: "live" }), "strict");
  assert.equal(resolveContractTier({ model: "", dataMode: "live" }), "strict");
  assert.equal(resolveContractTier({}), "strict");
  assert.equal(modelGrade("gpt-5.5"), "boss");
  assert.equal(modelGrade("deepseek-v4-flash"), "employee");
  assert.equal(normalizeContractTier("STANDARD"), "standard");
  assert.equal(normalizeContractTier("bogus"), "strict");
  assert.deepEqual([...CONTRACT_TIERS], ["strict", "standard", "lenient"]);
});

test("规则分类：安全/来源/结构/骨架/算术/完整度/数值/可追溯/表述", () => {
  assert.equal(
    classifyContractRule("餐饮数字员工不得声称已外发、付款或执行不可逆动作，也不得绕过授权。"),
    "safety",
  );
  assert.equal(classifyContractRule("餐饮数字员工输出包含内部岗位档案，已阻止交付。"), "safety");
  assert.equal(
    classifyContractRule("餐饮数字员工不得建议伪造或冒用平台身份、规避平台规则，亦不得建议未经平台许可与老板执行授权进行真实上架。"),
    "safety",
  );
  assert.equal(
    classifyContractRule("餐饮数字员工输出包含未在本次输入或联网证据快照中的URL，禁止补造来源：https://x"),
    "provenance",
  );
  assert.equal(
    classifyContractRule("字段“$.deliverables[0].evidence[0].period”引用本轮实时公开来源时，必须等于权威采集日期2026-08-01"),
    "provenance",
  );
  assert.equal(classifyContractRule("输出不是有效JSON：Unexpected token"), "structure");
  assert.equal(classifyContractRule("缺少必需字段：$.deliverables。"), "structure");
  assert.equal(classifyContractRule("运行时产出包含模板占位文本：xxx"), "structure");
  assert.equal(
    classifyContractRule("字段“$.input_audit[0]”必须逐项写明不少于18字的实际finding和不少于14字的具体业务impact。"),
    "skeleton",
  );
  assert.equal(classifyContractRule("字段“$.deliverables[0].summary”算术表达不一致：1+1=3"), "arithmetic");
  assert.equal(
    classifyContractRule("字段“$.deliverables[0].work_product”正文少于5项（互异正文为2项），不能只声明制品存在。"),
    "completeness",
  );
  assert.equal(
    classifyContractRule("字段“$.deliverables[0].work_product.items[1].result”必须逐卡写明客单价、毛利率阈值。"),
    "numeric",
  );
  assert.equal(
    classifyContractRule("字段“$.deliverables[0].actions[0]”不合格：owner泛化。必须包含具体动作、责任角色、明确时限和可复核指标。"),
    "accountability",
  );
  assert.equal(
    classifyContractRule("字段“$.decision_context.sources[0].source”必须写明可追溯的材料或系统来源。"),
    "traceability",
  );
  assert.equal(
    classifyContractRule("字段“$.deliverables[0].summary”必须围绕本岗位交付物写出具体结论，不能使用空泛复读。"),
    "quality",
  );
  assert.equal(
    classifyContractRule("字段“$.approval.review_note”不得预先声称流程已采纳、已上线或已执行；内部采用状态必须由质量门、账务门与任务快照策略共同决定。"),
    "authority",
  );
});

test("严格度矩阵：安全/来源/越权/结构/骨架/算术在任何档位都是硬门；档位单调（lenient ⊆ standard ⊆ strict）", () => {
  const matrix = contractTierMatrix();
  for (const category of ["safety", "provenance", "authority", "structure", "skeleton", "arithmetic"]) {
    for (const tier of CONTRACT_TIERS) {
      assert.equal(matrix[tier][category], "error", `${tier}.${category}`);
    }
  }
  for (const category of ["completeness", "accountability"]) {
    assert.equal(matrix.strict[category], "error");
    assert.equal(matrix.standard[category], "error");
    assert.equal(matrix.lenient[category], "warning");
  }
  for (const category of ["numeric", "traceability", "quality"]) {
    assert.equal(matrix.strict[category], "error");
    assert.equal(matrix.standard[category], "warning");
    assert.equal(matrix.lenient[category], "warning");
  }
  for (const category of CONTRACT_RULE_CATEGORIES) {
    if (ruleCategoryIsHard(category, "lenient")) assert.ok(ruleCategoryIsHard(category, "standard"));
    if (ruleCategoryIsHard(category, "standard")) assert.ok(ruleCategoryIsHard(category, "strict"));
  }
});

test("severityFor：不改规则本体，只按档位映射；lenient 与既有 demo advisory 一致", () => {
  const numeric = "字段“$.deliverables[0].work_product.items[0].result”必须逐卡写明阈值。";
  const completeness = "字段“$.deliverables[0].work_product”未覆盖交付物核心维度：客群、价格。";
  const safety = "餐饮数字员工不得声称已外发、付款或执行不可逆动作，也不得绕过授权。";
  const arithmetic = "字段“$.deliverables[0].summary”算术表达不一致：2×3=7";
  const sourceDate = "字段“$.deliverables[0].evidence[0].period”引用本轮实时公开来源时，必须等于权威采集日期2026-08-01或明确写“采集于2026-08-01”，禁止模型自填旧日期。";
  assert.equal(severityFor(numeric, "strict"), "error");
  assert.equal(severityFor(numeric, "standard"), "warning");
  assert.equal(severityFor(numeric, "lenient"), "warning");
  assert.equal(severityFor(completeness, "standard"), "error");
  assert.equal(severityFor(completeness, "lenient"), "warning");
  for (const tier of CONTRACT_TIERS) {
    assert.equal(severityFor(safety, tier), "error");
    assert.equal(severityFor(arithmetic, tier), "error");
    assert.equal(severityFor(sourceDate, tier), "error");
  }
  // demo 研究警告放行时，来源快照缺失不再是硬门（与 isHardRuntimeContractError 同口径）
  assert.equal(
    severityFor("本次联网任务没有权威允许来源快照，禁止把模型自述来源当作真实检索证据。", "lenient", {
      allowResearchWarning: true,
    }),
    "warning",
  );
  assert.equal(
    severityFor("本次联网任务没有权威允许来源快照，禁止把模型自述来源当作真实检索证据。", "lenient"),
    "error",
  );
});

test("校验器接受 contractTier：结构错误在任何档位都失败，且结果带回档位", () => {
  const broken = validateRestaurantEmployeeOutputContract(102, "{}", {
    contractTier: "standard",
    task: { title: "t", requirement: "r" },
  });
  assert.equal(broken.valid, false);
  assert.equal(broken.contractTier, "standard");
  const lenient = validateRestaurantEmployeeOutputContract(102, "not json", { qualityMode: "advisory" });
  assert.equal(lenient.valid, false);
  assert.equal(lenient.contractTier, "lenient");
  const strict = validateRestaurantEmployeeOutputContract(102, "not json", {});
  assert.equal(strict.contractTier, "strict");
});

test("草稿处置：非安全失败可落草稿；安全失败/空正文/零用量/未完整不落草稿；来源类失败不可直接采用", () => {
  const base = {
    text: "# 报告\n\n正文足够长".padEnd(300, "。"),
    mode: "api",
    usage: { inputTokens: 1200, outputTokens: 800 },
    complete: true,
  };
  const quality = classifyEmployeeDraftDisposition({
    ...base,
    contractErrors: ["字段“$.deliverables[0].summary”必须围绕本岗位交付物写出具体结论，不能使用空泛复读。"],
  });
  assert.equal(quality.eligible, true);
  assert.equal(quality.acceptable, true);
  assert.equal(quality.blockedBy, null);

  const provenance = classifyEmployeeDraftDisposition({
    ...base,
    hardDeliveryErrors: ["餐饮数字员工输出包含未在本次输入或联网证据快照中的URL，禁止补造来源：https://a"],
  });
  assert.equal(provenance.eligible, true);
  assert.equal(provenance.acceptable, false);
  assert.equal(provenance.provenanceErrors.length, 1);

  const safety = classifyEmployeeDraftDisposition({
    ...base,
    hardDeliveryErrors: ["餐饮数字员工不得声称已外发、付款或执行不可逆动作，也不得绕过授权。"],
  });
  assert.equal(safety.eligible, false);
  assert.equal(safety.blockedBy, "safety");

  const leakage = classifyEmployeeDraftDisposition({
    ...base,
    internalProfileLeakage: { detected: true },
  });
  assert.equal(leakage.blockedBy, "safety");

  assert.equal(classifyEmployeeDraftDisposition({ ...base, text: "   " }).blockedBy, "no_text");
  assert.equal(
    classifyEmployeeDraftDisposition({ ...base, usage: { inputTokens: 0, outputTokens: 0 } }).blockedBy,
    "no_usage",
  );
  assert.equal(classifyEmployeeDraftDisposition({ ...base, mode: "template" }).blockedBy, "not_api");
  assert.equal(classifyEmployeeDraftDisposition({ ...base, complete: false }).blockedBy, "incomplete");
  assert.equal(
    classifyEmployeeDraftDisposition({ ...base, failReason: "timeout" }).failReason,
    "timeout",
  );
});

test("草稿处置：没有可用产物/伪造（非JSON、伪造契约身份、顶层骨架缺失、回显模板、截断）不落草稿；嵌套缺字段仍可落草稿", () => {
  const base = {
    text: '{"contract_id":"伪造"}',
    mode: "api",
    usage: { inputTokens: 160, outputTokens: 20 },
    complete: true,
  };
  const cases = [
    ["输出不是有效JSON：Unexpected token # in JSON at position 0", "非 JSON 的 Markdown 冒充契约输出"],
    ["输出为空，无法通过岗位契约。", "空输出"],
    ["输出顶层必须是JSON对象，不能是数组、null或其他JSON值。", "顶层非对象"],
    ["字段“$.contract_id”必须等于岗位契约规定值。", "伪造契约身份"],
    ["缺少必需字段：$.deliverables。", "顶层骨架缺失"],
    ["运行时产出包含模板占位文本：待补充", "回显模板占位"],
    ["运行时产出不得原样返回岗位Schema示例。", "回显 Schema 示例"],
    ["供应商finish_reason=length，候选可能未完整，禁止直接交付。", "截断"],
    [
      "派活模式输出为JSON骨架而非可读岗位报告，无法识别为岗位契约，也不是Markdown报告。",
      "派活 Markdown 模式回了无法识别的裸 JSON 骨架",
    ],
  ];
  for (const [rule, label] of cases) {
    const disposition = classifyEmployeeDraftDisposition({ ...base, contractErrors: [rule] });
    assert.equal(disposition.eligible, false, label);
    assert.equal(disposition.blockedBy, "no_deliverable", label);
    assert.equal(disposition.acceptable, false, label);
    assert.deepEqual(disposition.noDeliverableErrors, [rule], label);
    assert.equal(isNoDeliverableRule(rule), true, label);
  }
  // 安全类优先于“无产物”：同时出现时 blockedBy 仍是 safety
  assert.equal(
    classifyEmployeeDraftDisposition({
      ...base,
      contractErrors: ["输出不是有效JSON：x"],
      hardDeliveryErrors: ["餐饮数字员工不得声称已外发、付款或执行不可逆动作，也不得绕过授权。"],
    }).blockedBy,
    "safety",
  );
  // 真实、完整、可解析的产物只是嵌套字段缺失/完整度不足：仍是可读草稿
  const nested = classifyEmployeeDraftDisposition({
    ...base,
    text: JSON.stringify({ contract_id: "ok", deliverables: { a: { work_product: {} } } }),
    contractErrors: [
      "缺少必需字段：$.deliverables.a.work_product.sections。",
      "字段“$.deliverables[0].work_product”正文少于5项（互异正文为2项），不能只声明制品存在。",
    ],
  });
  assert.equal(nested.eligible, true);
  assert.equal(nested.blockedBy, null);
  assert.equal(nested.acceptable, true);
  assert.equal(isNoDeliverableRule("缺少必需字段：$.deliverables.a.work_product.sections。"), false);
  // 派活 Markdown 过短属于完整度问题，正文仍可读 → 可落草稿（与 draft-on-failure 用例一致）
  assert.equal(
    classifyEmployeeDraftDisposition({
      ...base,
      text: "# 晚市机会初判\n\n建议先做 7 天低成本验证。",
      contractErrors: ["产出正文不足200字，未形成可交付的岗位报告。"],
    }).blockedBy,
    null,
  );
});

test("老板可读文案：同类合并计数，不出现契约ID/指纹/字段路径等技术词", () => {
  const checks = humanizeContractFailures([
    "字段“$.deliverables[0].summary”必须围绕本岗位交付物写出具体结论，不能使用空泛复读。",
    "字段“$.deliverables[1].summary”必须围绕本岗位交付物写出具体结论，不能使用空泛复读。",
    "餐饮数字员工输出包含未在本次输入或联网证据快照中的URL，禁止补造来源：https://a",
    "输出不是有效JSON：Unexpected end of JSON input contractId=restaurant-102 digestFingerprint=abc",
  ]);
  assert.equal(checks.length, 3);
  const quality = checks.find((item) => item.category === "quality");
  assert.equal(quality.count, 2);
  const serialized = JSON.stringify(checks);
  assert.doesNotMatch(serialized, /\$\./u);
  assert.doesNotMatch(serialized, /contractId|digestFingerprint|schemaVersion|JSON/u);
  assert.match(serialized, /未核验的来源/u);
});

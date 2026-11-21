// 餐饮数字员工·按题型的答题形态（PRD v2.2 FR-3）与反公式化校验。
//
// 以前每个问题都按岗位手册的全部交付物出一份长报告，导致“问一句、回一本”，
// 而且不同问题的报告长得一模一样。这里按 FR-1 判出的题型给出：
//   1) 注入 system prompt 的“本次答题形态”片段（追加式，不改写岗位手册）；
//   2) 反公式化检查（只做审计与提示，不拦截交付）；
//   3) 行情快查的覆盖度粗检（店铺数、价格档）。
// 纯函数，无 I/O。

import { INTENT_LABELS, normalizeIntentType } from "./employee-intent-router.js";

export const ANSWER_SHAPES_VERSION = "employee-answer-shapes/1";

const COMMON_RULES = Object.freeze([
  "先给结论，再给依据；老板看第一段就知道答案。",
  "只写和这个问题有关的内容：手册里的其他交付物这次不用逐个交付，手册作为方法参考。",
  "不要在正文里写“方法覆盖”“输入完整性”“岗位执行完整性”“方法n执行记录”“contract”等过程术语，也不要列“输入核查/方法执行/质量复核/安全复核”章节。",
  "每个数字标清来自哪里：老板给的数据、联网证据、还是行业经验区间（经验区间写明“需用自家账校准”）。",
  "老板没给、又必须用到的业务参数，用合理默认值并在文末“## 可改的假设”里用表格列出来（表头固定为：参数｜默认值｜改了会影响什么；默认值写数字加单位，如 8000元、3%、1.5km），不要停下来反问。",
  "本次没有联网证据的事实，不要写成“据公开资料/平台显示/来自官网”，也不要补造链接；写明“未联网核实”即可。",
]);

export const ANSWER_SHAPES = Object.freeze({
  "lookup.market_scan": {
    title: "行情快查·市场扫描",
    maxChars: 2500,
    sections: [
      "一句话结论（价格区间、主力档位、目标品类的位置）",
      "价格分档表：档次｜人均区间｜典型场景｜代表店（每档 2–4 家）",
      "目标品类清单：分“连锁主流 / 本地特色 / 新开或网红”，每行写店名、特色、人均、位置、来源",
      "相似竞品：抢同一预算、同一场景的替代品类，每类列代表店",
      "竞争格局 3 条",
      "对你意味着什么：有自家店名/人均/品类时对比空位和风险；没有就一句“补充你的门店信息后可对比”",
      "口径说明：人均来源（公开页/团购价/地图）、数据日期、本次没找到的部分",
    ],
    rules: [
      "区域级问题店铺清单尽量不少于 15 家、街道或商场级不少于 8 家；价格档不少于 3 档；找不到就如实写“本次只找到 N 家”和原因，不要用“待核验”填满表格。",
      "店铺、人均等事实只用本次联网证据和地图数据；榜单、团购、聚合页可以作为线索并标“参考”。",
      "不调用、不模拟美团/点评 App 端内接口；只用公开网页、高德开放数据和老板上传的文件。",
    ],
  },
  "lookup.quick_fact": {
    title: "快查",
    maxChars: 1500,
    sections: [
      "一句话结论",
      "要点清单或对照表（3–8 条）",
      "依据与来源（标注日期；规则类写明发布机关或平台）",
      "对你的影响或下一步（1–3 条）",
    ],
    rules: ["不展开成报告；没有可核验来源的事实写“未查到可靠来源”，不要编。"],
  },
  "diagnose.store_issue": {
    title: "诊断",
    maxChars: 2500,
    sections: [
      "结论：问题是什么、严重到什么程度",
      "关键数字：来自老板数据的口径和周期（没有数据就写明缺什么）",
      "原因排序：每条写证据和可信度（高/中/低）",
      "建议动作：不超过 5 条，每条写谁来做、什么时候、怎么验收",
      "还需要补的数据",
    ],
    rules: [
      "没有自家数据时不要硬诊断：写清需要导入哪类数据（如近 30 天订单/菜品销量/评价导出），同时给出“可能原因清单”并标明是推测。",
    ],
  },
  "plan.action_plan": {
    title: "方案",
    maxChars: 2800,
    sections: [
      "方案一句话（目标 + 打法）",
      "打法与时间表",
      "预算与物料（金额没确认的标“待确认”）",
      "执行清单：事项｜负责岗位｜截止｜验收标准",
      "风险与合规提醒（只写和本方案相关的）",
      "可改的假设：预算、客单、转化率、天数等，写成“参数｜默认值｜改了会影响什么”",
    ],
    rules: ["“负责岗位 + 截止”只用于执行清单，不要套到其他段落。"],
  },
  "produce.artifact": {
    title: "产物",
    maxChars: 3500,
    sections: [
      "直接给成品（SOP、清单、表格、话术、考题、文案等），可以复制就用",
      "使用说明不超过 3 行",
      "可替换字段：店名、价格、日期、负责人等用【】标出",
    ],
    rules: ["不附方法说明、不写背景分析；成品之外的话越少越好。"],
  },
  "full_report.standard": {
    title: "完整报告",
    maxChars: null,
    sections: [],
    rules: [
      "这是老板明确要的完整报告：按岗位手册的工作流执行，但交付物只选和本问题直接相关的 1–3 份，不必每次全部出齐。",
    ],
  },
  "team.squad": {
    title: "协同",
    maxChars: null,
    sections: [],
    rules: ["只写本岗位负责的那一部分，并说明需要哪个岗位接着做什么。"],
  },
});

export function answerShapeFor(intent) {
  const key = String(intent?.answer_shape || "").trim();
  if (ANSWER_SHAPES[key]) return { key, ...ANSWER_SHAPES[key] };
  const type = normalizeIntentType(intent?.type) || "full_report";
  const fallbackKey = {
    lookup: "lookup.quick_fact",
    diagnose: "diagnose.store_issue",
    plan: "plan.action_plan",
    produce: "produce.artifact",
    team: "team.squad",
  }[type] || "full_report.standard";
  return { key: fallbackKey, ...ANSWER_SHAPES[fallbackKey] };
}

/**
 * 注入到 system prompt 的“本次题型与答题形态”段（追加式）。
 * 不含任何 URL，避免模型把它当作来源写进正文。
 */
export function answerShapePromptLines(intent) {
  if (!intent || typeof intent !== "object") return [];
  const type = normalizeIntentType(intent.type) || "full_report";
  const shape = answerShapeFor(intent);
  const lines = [
    `【本次题型·最高优先级】${INTENT_LABELS[type]}（${shape.title}）。判题依据：${String(intent.reason || "").slice(0, 120)}`,
  ];
  if (type === "full_report") {
    lines.push(...shape.rules.map((rule) => `- ${rule}`));
    lines.push(`- ${COMMON_RULES[2]}`);
    return lines;
  }
  lines.push("【本次答题形态·必须执行】按下面的结构作答，段落可按问题取舍，不强制每段都出现：");
  shape.sections.forEach((section, index) => lines.push(`${index + 1}. ${section}`));
  if (shape.maxChars) lines.push(`- 正文控制在约 ${shape.maxChars} 字以内，信息密度优先。`);
  lines.push(...shape.rules.map((rule) => `- ${rule}`));
  lines.push(...COMMON_RULES.map((rule) => `- ${rule}`));
  const entities = intent.entities || {};
  const entityBits = [
    entities.city && `城市：${entities.city}`,
    entities.area && `商圈：${entities.area}`,
    entities.category && `品类：${entities.category}`,
    entities.related_categories?.length && `相似品类：${entities.related_categories.join("、")}`,
    entities.price_band && `人均：${entities.price_band}`,
    entities.store_count && `门店数：${entities.store_count}`,
    entities.period && `周期：${entities.period}`,
  ].filter(Boolean);
  if (entityBits.length) lines.push(`- 本题识别到：${entityBits.join("；")}（如与老板原话冲突，以原话为准）。`);
  const missing = Array.isArray(intent.missing_business_params) ? intent.missing_business_params : [];
  if (missing.length) {
    lines.push(
      `- 老板没说的业务参数按默认值先出稿，并写进“可改的假设”：${missing
        .map((item) => `${item.label}=${item.default}`)
        .join("；")}。`,
    );
  }
  if (intent.out_of_scope) {
    lines.push("- 这个问题不完全在本岗位主业内：先给出力所能及的部分，结尾一句话推荐更对口的岗位。");
  }
  return lines;
}

// —— 反公式化校验 ——
const PROCESS_TERMS = Object.freeze([
  "方法覆盖",
  "输入完整性",
  "岗位执行完整性",
  "input_audit",
  "method_execution",
  "quality_review",
  "safety_review",
  "contract_id",
  "contract",
]);
const PROCESS_SECTION = /^#{1,4}\s*(?:\d+[.、]\s*)?(?:输入核查|方法执行(?:记录)?|质量复核|安全复核|方法\s*\d+\s*执行记录)/mu;
const METHOD_RECORD = /方法\s*\d+\s*执行记录/u;

export function headingSet(markdown = "") {
  return new Set(
    String(markdown || "")
      .split("\n")
      .filter((line) => /^#{1,2}\s+/u.test(line))
      .map((line) => line.replace(/^#{1,2}\s+/u, "").replace(/^[\d一二三四五六七八九十]+[.、．)\s]+/u, "").trim())
      .filter(Boolean),
  );
}

export function headingJaccard(a = "", b = "") {
  const left = headingSet(a);
  const right = headingSet(b);
  if (!left.size && !right.size) return 0;
  let inter = 0;
  for (const item of left) if (right.has(item)) inter += 1;
  return inter / (left.size + right.size - inter);
}

/**
 * 反公式化检查：返回 { ok, issues[] }。只用于审计和评测，不阻断交付。
 * @param {string} markdown
 * @param {object} [options]
 * @param {string[]} [options.ownFacts] 本企业专属信息（店名、菜品、价格带等），有则正文至少命中 1 处
 */
export function antiFormulaIssues(markdown = "", { ownFacts = [] } = {}) {
  const text = String(markdown || "");
  const issues = [];
  const hitTerms = PROCESS_TERMS.filter((term) =>
    term === "contract" ? /\bcontract\b/iu.test(text) : text.includes(term),
  );
  if (hitTerms.length) issues.push({ code: "process_terms", detail: `正文出现过程术语：${hitTerms.join("、")}` });
  if (PROCESS_SECTION.test(text) || METHOD_RECORD.test(text)) {
    issues.push({ code: "process_sections", detail: "正文仍有输入核查/方法执行/质量复核/安全复核等过程章节" });
  }
  // 实测升级前交付：每个章节都套“证据/动作/验收”同一骨架，且“待核验”刷屏。
  const headingCounts = new Map();
  for (const match of text.matchAll(/^#{2,4}\s*(.+?)\s*$/gmu)) {
    const heading = match[1].replace(/[（(].*?[)）]/gu, "").trim();
    headingCounts.set(heading, (headingCounts.get(heading) || 0) + 1);
  }
  const repeated = [...headingCounts.entries()].filter(([, count]) => count >= 3).map(([heading]) => heading);
  if (repeated.length) {
    issues.push({ code: "repeated_skeleton", detail: `同一小标题重复套用：${repeated.slice(0, 4).join("、")}` });
  }
  const pendingCount = (text.match(/待核验/gu) || []).length;
  if (pendingCount >= 8) {
    issues.push({ code: "unverified_flood", detail: `“待核验”出现 ${pendingCount} 次，应按来源档位标注或直接写缺什么` });
  }
  const facts = (ownFacts || []).map((item) => String(item || "").trim()).filter((item) => item.length >= 2);
  if (facts.length && !facts.some((fact) => text.includes(fact))) {
    issues.push({ code: "no_own_facts", detail: "本企业有品牌或自有数据，但正文没有出现任何本企业专属信息" });
  }
  return { ok: issues.length === 0, issues };
}

/**
 * 行情快查覆盖度粗检：数表格里的店铺行、价格档。
 */
export function marketScanCoverage(markdown = "") {
  const lines = String(markdown || "").split("\n");
  const tableRows = lines.filter((line) => /^\s*\|/u.test(line) && !/^\s*\|\s*:?-{2,}/u.test(line));
  const priceBands = new Set();
  for (const line of lines) {
    for (const match of line.matchAll(/(\d{2,4})\s*[-–~至到]\s*(\d{2,4})\s*元/gu)) {
      priceBands.add(`${match[1]}-${match[2]}`);
    }
  }
  const storeRows = tableRows.filter((line) => /店|餐厅|火锅|烤肉|馆|坊|记|家/u.test(line) && /\d/u.test(line));
  return {
    storeRows: storeRows.length,
    priceBands: priceBands.size,
    meetsAreaTarget: storeRows.length >= 15 && priceBands.size >= 3,
    meetsStreetTarget: storeRows.length >= 8 && priceBands.size >= 3,
  };
}

/**
 * 交付后的答题形态审计（写入任务执行证据，只做评测与看板，不阻断交付）。
 */
export function buildAnswerShapeAudit(markdown, intent, { ownFacts = [] } = {}) {
  const shape = answerShapeFor(intent);
  const formula = antiFormulaIssues(markdown, { ownFacts });
  return {
    version: ANSWER_SHAPES_VERSION,
    intentType: normalizeIntentType(intent?.type) || null,
    answerShape: shape.key,
    chars: String(markdown || "").length,
    maxChars: shape.maxChars,
    overLength: Boolean(shape.maxChars && String(markdown || "").length > shape.maxChars * 1.5),
    antiFormula: formula,
    ...(shape.key === "lookup.market_scan" ? { coverage: marketScanCoverage(markdown) } : {}),
  };
}

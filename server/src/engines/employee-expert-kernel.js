// 61 位餐饮数字员工「真人技能流程 + 真实工具链」权威只读内核提取引擎。
//
// 硬约束：
// - 只读引用 canonical-employee-profile / employee-store-data-pack / store-inspections /
//   super-manager-campaign-materials / poster-text-capability，绝不修改任何 catalog JSON。
// - 工具清单 100% 映射服务端真实运行能力，绝不虚构任何未接入接口或抓包工具。

import { canonicalRestaurantEmployeeProfileFor } from "./canonical-employee-profile.js";
import {
  DATA_NEED_LABELS,
  dataNeedsForEmployee,
} from "./employee-store-data-pack.js";
import { posterTextCapabilityAppliesTo } from "./poster-text-capability.js";
import { INSPECTION_EMPLOYEE_IDX } from "./store-inspections.js";
import { SUPER_MANAGER_EMPLOYEE_IDX } from "./super-manager-campaign-materials.js";

export const HUMAN_ORIGIN_TAG = "真人专家技能流程沉淀 · 真实工具链驱动";

// 与 canonical-employee-profile.js 中 locationIntelligenceRequired 严格一致。
export const LOCATION_INTELLIGENCE_EMPLOYEE_IDS = Object.freeze([101, 102, 104]);
// 与 canonical-employee-profile.js 中 authorizedReviewImportRequired 严格一致。
export const REVIEW_IMPORT_EMPLOYEE_IDS = Object.freeze([143]);
// 方案 / 预算 / 定价 / 财务 / 测算 / 分析类岗位（支持 report-assumptions + report-refine 一键重算）。
export const ASSUMPTION_REFINE_EMPLOYEE_IDS = Object.freeze([
  101, 102, 103, 104, 105, 106, 107,
  108, 110, 111, 112, 113,
  126, 127, 129, 130,
  135, 136,
  141, 144, 145, 146,
  147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 158,
  160,
]);

const LOCATION_INTELLIGENCE_SET = new Set(LOCATION_INTELLIGENCE_EMPLOYEE_IDS);
const REVIEW_IMPORT_SET = new Set(REVIEW_IMPORT_EMPLOYEE_IDS);
const ASSUMPTION_REFINE_SET = new Set(ASSUMPTION_REFINE_EMPLOYEE_IDS);

const DELIVERABLE_LEADIN_RE = /^(?:提供|交付|输出|产出|包括|包含)[:：]?$/u;

function cleanText(value, max = 160) {
  return String(value ?? "")
    .replace(/\*\*|__|[*`#]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function parseWorkflowStep(rawStep, index) {
  const raw = String(rawStep ?? "").trim();
  const boldLead = /^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/u.exec(raw);
  if (boldLead) {
    const title = cleanText(boldLead[1], 24).replace(/[：:]+$/u, "");
    const summary = cleanText(boldLead[2] || boldLead[1], 140);
    return {
      index: index + 1,
      title: title || `步骤 ${index + 1}`,
      summary: summary || title || `步骤 ${index + 1}`,
    };
  }
  const plain = cleanText(raw, 200);
  if (!plain) {
    return {
      index: index + 1,
      title: `步骤 ${index + 1}`,
      summary: `执行第 ${index + 1} 步专家流程`,
    };
  }
  const colonIdx = plain.search(/[:：]/u);
  if (colonIdx >= 2 && colonIdx <= 18) {
    const title = plain.slice(0, colonIdx).trim();
    const rest = plain.slice(colonIdx + 1).trim();
    return {
      index: index + 1,
      title,
      summary: rest ? rest.slice(0, 140) : plain.slice(0, 140),
    };
  }
  if (plain.length <= 16) {
    return {
      index: index + 1,
      title: plain,
      summary: plain,
    };
  }
  const head = plain.split(/[，,。；;]/u)[0].trim();
  const title =
    head.length >= 2 && head.length <= 16
      ? head
      : `${plain.slice(0, 14).trim()}…`;
  return {
    index: index + 1,
    title,
    summary: plain.slice(0, 140),
  };
}

function cleanDeliverables(rawList, limit = 4) {
  if (!Array.isArray(rawList)) return [];
  const items = [];
  const seen = new Set();
  for (const raw of rawList) {
    const text = cleanText(raw, 80).replace(/[。；;]+$/u, "");
    if (!text || DELIVERABLE_LEADIN_RE.test(text) || seen.has(text)) continue;
    seen.add(text);
    items.push(text);
    if (items.length >= limit) break;
  }
  return items;
}

/**
 * 为指定餐饮岗位生成 100% 真实可追溯的运行时工具清单。
 * 优先级：岗位独家壁垒工具在前 → 业务数据/取证工具 → 知识包/重算/协同工具。
 */
export function resolveEmployeeTools(idx, { webMode = "required" } = {}) {
  const employeeIdx = Number(idx);
  const tools = [];

  if (LOCATION_INTELLIGENCE_SET.has(employeeIdx)) {
    tools.push({
      key: "amap_poi",
      label: "高德开放地图 POI",
      shortLabel: "高德POI",
      desc: "调用高德开放平台实时检索周边商圈 POI、餐饮供给密度与竞品分布，结合路网等时圈评估真实客流覆盖。",
      category: "location",
    });
  }

  if (employeeIdx === INSPECTION_EMPLOYEE_IDX) {
    tools.push({
      key: "inspection_standards",
      label: "国家法规巡店标准库",
      shortLabel: "巡店标准库",
      desc: "按国家法规与餐饮行业规范冻结快照逐项核查评分，法定红线（消防、证照、生熟分离）强制置顶并生成整改闭环。",
      category: "compliance",
    });
  }

  if (employeeIdx === SUPER_MANAGER_EMPLOYEE_IDX) {
    tools.push({
      key: "campaign_materials",
      label: "活动物料海报生图引擎",
      shortLabel: "物料生图",
      desc: "读取品牌知识包 Logo 与视觉调性，自动生成宣传单、Banner 横图、主 KV 海报、朋友圈方图与桌贴成图。",
      category: "creative",
    });
  }

  if (posterTextCapabilityAppliesTo("restaurant", employeeIdx)) {
    tools.push({
      key: "poster_text_overlay",
      label: "海报文字精确叠加",
      shortLabel: "海报叠字",
      desc: "菜名、价格与门店名通过矢量轮廓精确叠加到无字底图，避免图像模型写错汉字。",
      category: "creative",
    });
  }

  if (REVIEW_IMPORT_SET.has(employeeIdx)) {
    tools.push({
      key: "review_dataset_import",
      label: "授权评价数据归因",
      shortLabel: "评价归因",
      desc: "接入企业自有授权评价导出表，去重编码差评主题并自动转化为门店整改任务。",
      category: "data",
    });
  }

  const dataNeeds = dataNeedsForEmployee(employeeIdx);
  const businessNeeds = dataNeeds.filter((need) => need !== "stores");
  if (businessNeeds.length > 0) {
    const dimLabels = businessNeeds
      .map((need) => DATA_NEED_LABELS[need] || need)
      .join("、");
    tools.push({
      key: "store_data_pack",
      label: "门店自有经营数据包",
      shortLabel: "门店数据包",
      desc: `自动读取本企业已导入的${dimLabels}等真实台账注入分析上下文，未导入维度如实标注绝不编造。`,
      category: "data",
    });
  }

  if (String(webMode || "required").toLowerCase() !== "off") {
    tools.push({
      key: "web_evidence",
      label: "全网公开检索与受控网页取证",
      shortLabel: "公开取证",
      desc: "按岗位专家技能定制公开检索车道，核验法规、行业案例与公开数据，并通过受控取证保留来源与时间。",
      category: "research",
    });
  }

  tools.push({
    key: "brand_kb",
    label: "24 维品牌知识包",
    shortLabel: "品牌知识包",
    desc: "自动关联本企业 24 维品牌档案（主营品类、招牌菜、价格带、客群与口碑），确保交付紧贴自家门店。",
    category: "knowledge",
  });

  if (ASSUMPTION_REFINE_SET.has(employeeIdx)) {
    tools.push({
      key: "assumption_refine",
      label: "可改假设一键重算",
      shortLabel: "假设重算",
      desc: "自动提取预算、客单、毛利、房租等关键假设，老板修改数值后一键联动重算受影响指标并保留原稿。",
      category: "analysis",
    });
  }

  tools.push({
    key: "team_handoff",
    label: "跨岗位协同接棒",
    shortLabel: "协同接棒",
    desc: "交付完成后自动推荐上下游协作同事，支持一键带入本单结论派给下一位数字员工接力落地。",
    category: "collaboration",
  });

  return tools;
}

function resolveCanonicalSource(input) {
  if (!input) throw new Error("构建专家内核缺少员工档案或编号");
  const idx = Number(
    input?.identity?.idx ?? input?.idx ?? (typeof input === "number" ? input : NaN),
  );
  if (!Number.isInteger(idx) || idx < 101 || idx > 161) {
    throw new Error(`无效的餐饮数字员工编号：${idx}`);
  }
  return canonicalRestaurantEmployeeProfileFor(idx);
}

function collectCoreSkills(canonical, { enabledSupplements = [] } = {}) {
  const catalogSkills = Array.isArray(canonical?.skills?.catalog)
    ? canonical.skills.catalog
    : [];
  const requiredSkills = Array.isArray(canonical?.skills?.required)
    ? canonical.skills.required
    : [];
  const supplements = Array.isArray(enabledSupplements)
    ? enabledSupplements
    : [];

  const coreSkills = [];
  const seen = new Set();
  const pushSkill = (title, category) => {
    const clean = cleanText(title, 60);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    coreSkills.push({ title: clean, category });
  };

  for (const skill of catalogSkills) {
    pushSkill(skill?.title || skill?.name, "真人实战技能");
  }
  for (const skill of supplements) {
    pushSkill(skill?.title || skill?.name, "行业补充技能");
  }
  if (coreSkills.length === 0) {
    for (const skill of requiredSkills) {
      pushSkill(skill?.title || skill?.name, "岗位核心技能");
    }
  }

  // 真实技能总数：employee-skills.json 核心技能 + 岗位主技能（若目录为空时计入必备主技能，保证 61 位全员 > 0）+ 已启用补充技能。
  const baseCount =
    catalogSkills.length > 0 ? catalogSkills.length : requiredSkills.length;
  const skillCount = baseCount + supplements.length;

  return { skillCount, coreSkills };
}

/**
 * 构建完整专家内核对象（供 `/api/employee-workbench/restaurant/:idx` 使用）。
 */
export function buildEmployeeKernelDetail(profile, options = {}) {
  const canonical = resolveCanonicalSource(profile);
  const idx = canonical.identity.idx;
  const webMode =
    options.webMode ??
    profile?.workConfig?.webMode ??
    canonical?.workConfig?.factoryDefault?.webMode ??
    "required";

  const { skillCount, coreSkills } = collectCoreSkills(canonical, {
    enabledSupplements: options.enabledSupplements,
  });

  const rawSteps = Array.isArray(canonical?.workMethod?.steps)
    ? canonical.workMethod.steps
    : [];
  const workflowSteps = rawSteps.map((step, index) =>
    parseWorkflowStep(step, index),
  );
  const deliverables = cleanDeliverables(
    canonical?.workMethod?.deliverables,
    4,
  );
  const tools = resolveEmployeeTools(idx, { webMode });

  return {
    skillCount,
    coreSkills,
    stepCount: workflowSteps.length,
    workflowSteps,
    deliverables,
    tools,
    humanOriginTag: HUMAN_ORIGIN_TAG,
  };
}

/**
 * 构建轻量卡片内核摘要（供 `/api/employees` 全部 61 位员工卡片使用）。
 */
export function buildEmployeeKernelSummary(employee, profile = null, options = {}) {
  const detail = buildEmployeeKernelDetail(profile || employee, options);
  return {
    skillCount: detail.skillCount,
    stepCount: detail.stepCount,
    topSkills: detail.coreSkills.slice(0, 3).map((item) => item.title),
    tools: detail.tools.map(({ key, shortLabel, label, category }) => ({
      key,
      shortLabel,
      label,
      category,
    })),
    topDeliverables: detail.deliverables.slice(0, 2),
    humanOriginTag: detail.humanOriginTag,
  };
}

/**
 * 普通员工/受限角色掩码投影：保留工具链、技能数、步骤数与交付物等公开能力，
 * 不暴露内部能力名与技能标题，严格遵守服务端内部档案掩码边界。
 */
export function redactEmployeeKernelDetail(detail) {
  return {
    skillCount: detail.skillCount,
    coreSkills: [],
    stepCount: detail.stepCount,
    workflowSteps: [],
    deliverables: detail.deliverables,
    tools: detail.tools,
    humanOriginTag: detail.humanOriginTag,
    redacted: true,
  };
}

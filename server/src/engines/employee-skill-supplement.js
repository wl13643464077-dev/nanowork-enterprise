// 数字员工·技能补充包（PRD v2.2 FR-6，只追加、原卡零改动）。
//
// 为什么不改 catalog/employee-skills.json：那 409 张卡是老板多轮调试过的，且被
// employee-skills-verification 与派活源指纹门禁锁定。补充卡单独放在
// catalog/employee-skills-supplement.json，加载时先核对原目录 SHA-256 与补充包
// 记录的基线一致；不一致说明有人改了原卡，补充包拒绝加载（原卡照常工作）。
//
// 注入顺序：原卡（岗位技能库）在前 → 本岗位补充卡 → 全员通用卡。只注入老板
// 确认启用（owner_verified_enabled）的卡；待确认的只在技能页展示。
// 提示词里不放来源 URL：交付硬门会拦截不在本次联网证据里的链接。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EMPLOYEE_SKILL_SUPPLEMENT_PATH = path.join(
  __dirname,
  "..",
  "..",
  "catalog",
  "employee-skills-supplement.json",
);
export const EMPLOYEE_SKILLS_ORIGINAL_PATH = path.join(
  __dirname,
  "..",
  "..",
  "catalog",
  "employee-skills.json",
);

export const SUPPLEMENT_STATUS_PENDING = "supplement_pending_owner_review";
export const SUPPLEMENT_STATUS_ENABLED = "owner_verified_enabled";
export const SUPPLEMENT_STATUS_DECLINED = "owner_declined";
export const SUPPLEMENT_REVIEW_STATUSES = Object.freeze([
  SUPPLEMENT_STATUS_ENABLED,
  SUPPLEMENT_STATUS_DECLINED,
]);
// 平台规则类卡（美团/点评/小红书/抖音）180 天后提示复核。
const PLATFORM_RULE_PATTERN = /美团|点评|小红书|抖音|外卖|团购|店铺分/u;
const PLATFORM_RECHECK_DAYS = 180;

let cache = null;

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function resetEmployeeSkillSupplementCache() {
  cache = null;
}

/**
 * 读取并校验补充包。返回 { ok, error?, data?, byIdx, common, cardsById }。
 */
export function loadEmployeeSkillSupplement({
  supplementPath = EMPLOYEE_SKILL_SUPPLEMENT_PATH,
  originalPath = EMPLOYEE_SKILLS_ORIGINAL_PATH,
  force = false,
} = {}) {
  if (cache && !force && cache.supplementPath === supplementPath && cache.originalPath === originalPath) {
    return cache.result;
  }
  let result;
  try {
    const data = JSON.parse(fs.readFileSync(supplementPath, "utf8"));
    if (data?.schemaVersion !== "employee-skills-supplement/1") {
      throw new Error("技能补充包 schemaVersion 不符");
    }
    const expectedSha = String(data?.policy?.originalCatalogSha256 || "");
    const actualSha = sha256File(originalPath);
    if (!expectedSha || expectedSha !== actualSha) {
      throw new Error(
        `原技能目录指纹与补充包基线不一致（基线 ${expectedSha.slice(0, 12) || "缺失"}，当前 ${actualSha.slice(0, 12)}），补充包停用；原卡不受影响`,
      );
    }
    const byIdx = new Map();
    const cardsById = new Map();
    for (const profile of data.profiles || []) {
      const key = profile.catalog === "content" ? `content:${profile.idx}` : `restaurant:${profile.idx}`;
      const cards = (profile.skills || []).map((card) => Object.freeze({ ...card, employeeKey: key }));
      byIdx.set(key, cards);
      for (const card of cards) cardsById.set(card.id, card);
    }
    const common = (data.commonSkills || []).map((card) => Object.freeze({ ...card, employeeKey: "all" }));
    for (const card of common) cardsById.set(card.id, card);
    result = { ok: true, data, byIdx, common, cardsById, originalSha256: actualSha };
  } catch (error) {
    result = {
      ok: false,
      error: error?.message || String(error),
      byIdx: new Map(),
      common: [],
      cardsById: new Map(),
    };
  }
  cache = { supplementPath, originalPath, result };
  return result;
}

function employeeKey(idx, catalog = "restaurant") {
  return `${catalog === "content" ? "content" : "restaurant"}:${Number(idx)}`;
}

function needsRecheck(card, now = Date.now()) {
  if (!PLATFORM_RULE_PATTERN.test(`${card.title}${card.detail}${card.source}`)) return false;
  const date = Date.parse(String(card.sourceDate || "").slice(0, 10));
  if (!Number.isFinite(date)) return false;
  return now - date > PLATFORM_RECHECK_DAYS * 86_400_000;
}

/**
 * 某员工的补充卡（不含状态）。
 */
export function supplementCardsForEmployee(idx, { catalog = "restaurant", includeCommon = true } = {}) {
  const loaded = loadEmployeeSkillSupplement();
  if (!loaded.ok) return [];
  const own = loaded.byIdx.get(employeeKey(idx, catalog)) || [];
  return includeCommon ? [...own, ...loaded.common] : [...own];
}

/**
 * 读出租户对补充卡的审核状态：Map(cardId -> {status, reviewer, reviewedAt, note})。
 * reviewsReader 由调用方注入（避免本模块直接依赖数据库，便于单测）。
 */
export function withReviewStatus(cards, reviews = new Map(), { now = Date.now() } = {}) {
  return cards.map((card) => {
    const review = reviews.get(card.id) || null;
    return {
      id: card.id,
      title: card.title,
      detail: card.detail,
      source: card.source,
      sourceUrl: card.sourceUrl || null,
      sourceDate: card.sourceDate || null,
      gap: card.gap,
      gapNote: card.gapNote,
      // 专家卡（2026-11 第二批）附带的类型、来源置信度与口径说明；旧卡没有这些字段。
      cardType: card.cardType || null,
      confidence: card.confidence || null,
      expertNote: card.expertNote || null,
      scope: card.employeeKey === "all" ? "common" : "employee",
      origin: "supplement_2026_11",
      appendOnly: true,
      locked: false,
      status: review?.status || SUPPLEMENT_STATUS_PENDING,
      reviewer: review?.reviewer ?? null,
      reviewedAt: review?.reviewedAt ?? null,
      note: review?.note ?? null,
      needsRecheck: needsRecheck(card, now),
    };
  });
}

export function enabledSupplementCards(cardsWithStatus = []) {
  return cardsWithStatus.filter((card) => card.status === SUPPLEMENT_STATUS_ENABLED);
}

/**
 * 注入 system prompt 的“补充技能”段。原卡段落之后调用。
 */
// 专家卡的口径说明进提示词时截短，只保留让模型分清“来源原文”与“经验判读线”所需的一句话。
const EXPERT_CAVEAT_MAX = 90;
function expertCaveat(card) {
  const note = String(card.expertNote || "").replace(/\s+/gu, " ").trim();
  if (!note) return "";
  const chars = [...note];
  return `（口径：${chars.length > EXPERT_CAVEAT_MAX ? `${chars.slice(0, EXPERT_CAVEAT_MAX).join("")}…` : note}）`;
}

export function supplementSkillPromptLines(enabledCards = []) {
  if (!enabledCards.length) return [];
  const own = enabledCards.filter((card) => card.scope !== "common");
  const common = enabledCards.filter((card) => card.scope === "common");
  const lines = [
    "【补充技能（中国门店以此为准，运行期追加，不替代上方岗位技能）】",
    "上方技能中引用海外法规、平台或美元基准的，作为海外参考；在中国门店场景下，以下补充技能优先。补充技能的出处只用于你判断可信度，正文不要写这些出处的链接。",
    ...own.map((card) => `- 【${card.title}】${card.detail}${expertCaveat(card)}`),
  ];
  if (own.some((card) => card.cardType)) {
    lines.splice(
      2,
      0,
      "其中的行业基准是带年份和口径的参照值，不是这家店的实际数；引用时写明年份与口径，拿门店自己的数来对比，门店数据缺失就明说缺什么。标了“口径”的阈值是经验判读线，不是法定标准，不要说成法规要求。法规条款以卡内写明的版本为准，涉及处罚金额或时限的结论，提醒老板以当地监管部门最新口径为准。",
    );
  }
  if (common.length) {
    lines.push("【全员通用作答习惯】", ...common.map((card) => `- 【${card.title}】${card.detail}`));
  }
  return lines;
}

export function supplementSummary(cardsWithStatus = []) {
  const count = (status) => cardsWithStatus.filter((card) => card.status === status).length;
  return {
    total: cardsWithStatus.length,
    enabled: count(SUPPLEMENT_STATUS_ENABLED),
    pending: count(SUPPLEMENT_STATUS_PENDING),
    declined: count(SUPPLEMENT_STATUS_DECLINED),
  };
}

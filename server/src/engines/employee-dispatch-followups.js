// PRD v2.2 第三轮：
// - FR-7.2 我的版本：企业级保存的常用槽位值（城市/商圈/店名/品类…），自动填进“常用问法”。
// - FR-2 追问闸门：方案/产物/完整报告缺关键业务参数时最多追问 3 个，每个都有默认值、可跳过；
//   已在“我的版本”里保存过的参数不再追问。快查、诊断、无人值守派活不追问。
// - FR-8 派单闭环：方案/诊断里需要别的同事接手的动作，写明派给谁；服务端从交付里识别出
//   被点名的同事，前端一键带着任务书打开该员工。
// 本文件只读 restaurant.json 的 idx / person / duty / group 四个字段，不改动任何技能或手册。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTenantConfig, setTenantConfig, curTenant } from "../db.js";
import { normalizeIntentType } from "./employee-intent-router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESTAURANT_CATALOG_PATH = path.join(__dirname, "..", "..", "catalog", "restaurant.json");

export const SLOT_PREFERENCES_CONFIG_KEY = "employee_question_slot_values";
export const FOLLOWUP_MAX_QUESTIONS = 3;
export const HANDOFF_MAX = 3;

// 适合长期保存的槽位（店的基本面 + 常用经营参数）。一次性的槽位（活动名、数据、菜品…）不保存。
export const SLOT_PREFERENCE_KEYS = Object.freeze([
  "店名",
  "门店名",
  "城市",
  "商圈",
  "地址",
  "品类",
  "人均",
  "门店数",
  "招牌菜",
  "外卖平台",
  "竞品",
  "预算",
  "目标",
]);

const SLOT_VALUE_MAX = 40;
const URL_RE = /(?:https?:\/\/|www\.)\S+/giu;
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/gu;

function cleanText(value, max = SLOT_VALUE_MAX) {
  return String(value ?? "")
    .replace(URL_RE, "")
    .replace(PHONE_RE, "")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/[<>{}]/gu, "")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .slice(0, max);
}

/** 只保留白名单槽位，去掉网址、手机号、换行与模板括号。 */
export function normalizeSlotPreferences(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const values = {};
  for (const key of SLOT_PREFERENCE_KEYS) {
    const value = cleanText(source[key]);
    if (value) values[key] = value;
  }
  return values;
}

// FR-7.3 老板确认后保存的固定输出要求（如“控制在一屏内”“不要英文”），最多 8 条。
export const OUTPUT_PREFS_MAX = 8;

export function normalizeOutputPrefs(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const text = cleanText(item, 60);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= OUTPUT_PREFS_MAX) break;
  }
  return out;
}

function normalizeStored(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  return {
    values: normalizeSlotPreferences(data.values),
    outputPrefs: normalizeOutputPrefs(data.outputPrefs),
    skipFollowups: data.skipFollowups === true,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
    updatedBy: typeof data.updatedBy === "string" ? data.updatedBy : null,
  };
}

export function getSlotPreferences(tid = curTenant()) {
  try {
    return normalizeStored(getTenantConfig(SLOT_PREFERENCES_CONFIG_KEY, null, tid));
  } catch {
    return normalizeStored(null);
  }
}

export function saveSlotPreferences(input = {}, user = null, tid = curTenant()) {
  const current = getSlotPreferences(tid);
  const next = {
    values: input.values !== undefined ? normalizeSlotPreferences(input.values) : current.values,
    outputPrefs:
      input.outputPrefs !== undefined
        ? normalizeOutputPrefs(input.outputPrefs)
        : input.addOutputPref
          ? normalizeOutputPrefs([...current.outputPrefs, input.addOutputPref])
          : current.outputPrefs,
    skipFollowups:
      input.skipFollowups !== undefined ? input.skipFollowups === true : current.skipFollowups,
    updatedAt: new Date().toISOString(),
    updatedBy: cleanText(user?.name || user?.username || user?.id || "", 40) || null,
  };
  setTenantConfig(SLOT_PREFERENCES_CONFIG_KEY, next, tid);
  return next;
}

// ===== FR-2 追问闸门 =====

// 业务参数 → “我的版本”里对应的槽位。
const PARAM_SLOT = Object.freeze({ budget: "预算", goal: "目标" });

// 完整报告/产物缺地点或品类时的追问（只在文字里完全没提到时问）。
const CONTEXT_QUESTIONS = Object.freeze({
  place: {
    key: "place",
    label: "城市/商圈",
    slots: ["城市", "商圈"],
    default: "按“我的版本”里的门店所在地；没有则写成通用版，地点留【】待填",
    options: [],
  },
  category: {
    key: "category",
    label: "品类",
    slots: ["品类"],
    default: "按通用中式正餐写，品类相关处留【】待填",
    options: ["火锅", "烧烤", "中式快餐", "茶饮"],
  },
  store: {
    key: "store",
    label: "店名/门店",
    slots: ["店名", "门店名"],
    default: "用【店名】占位，复制后替换",
    options: [],
  },
});

const PARAM_OPTIONS = Object.freeze({
  budget: ["3000元以内", "1万元以内", "3万元以内"],
  goal: ["拉新客", "提复购", "提客单", "提翻台"],
  time: ["本周末", "下周", "下个月"],
});

/**
 * 根据判题结果生成追问（≤3）。
 * @param {object} intent classifyEmployeeIntent 的结果
 * @param {object} [options]
 * @param {object} [options.preferences] getSlotPreferences() 的结果
 * @param {boolean} [options.unattended] 定时/无人值守派活：不追问
 */
export function buildFollowupQuestions(intent, { preferences = null, unattended = false } = {}) {
  const type = normalizeIntentType(intent?.type);
  if (unattended || !["plan", "produce", "full_report"].includes(type)) return [];
  const prefs = preferences || { values: {}, skipFollowups: false };
  if (prefs.skipFollowups) return [];
  const saved = prefs.values || {};
  const questions = [];
  for (const param of intent?.missing_business_params || []) {
    const slot = PARAM_SLOT[param.key];
    if (slot && saved[slot]) continue;
    questions.push({
      key: param.key,
      label: param.label,
      default: param.default,
      options: PARAM_OPTIONS[param.key] || [],
    });
  }
  const entities = intent?.entities || {};
  if (type === "full_report" && !entities.city && !entities.area && !saved["城市"] && !saved["商圈"]) {
    questions.push({ ...CONTEXT_QUESTIONS.place });
  }
  if (["full_report", "plan"].includes(type) && !entities.category && !saved["品类"]) {
    questions.push({ ...CONTEXT_QUESTIONS.category });
  }
  if (type === "produce" && !saved["店名"] && !saved["门店名"]) {
    questions.push({ ...CONTEXT_QUESTIONS.store });
  }
  return questions.slice(0, FOLLOWUP_MAX_QUESTIONS).map((question) => ({
    key: question.key,
    label: question.label,
    default: question.default,
    options: [...(question.options || [])],
  }));
}

/**
 * 把追问答案拼到任务书末尾：“【老板补充】预算：8000元；目标：拉新客”。
 * answers: { key: value }；value 为空或 "__default__" 时使用该问题的默认值并标注“默认”。
 * 只接受 questions 里出现过的 key，防止任意文本注入。
 */
export function appendFollowupAnswers(requirement, answers = {}, questions = []) {
  const base = String(requirement || "");
  if (!questions.length || !answers || typeof answers !== "object") return base;
  const parts = [];
  for (const question of questions) {
    if (!Object.prototype.hasOwnProperty.call(answers, question.key)) continue;
    const raw = answers[question.key];
    const useDefault = raw == null || raw === "__default__" || String(raw).trim() === "";
    const value = useDefault ? `${cleanText(question.default, 60)}（默认）` : cleanText(raw, 60);
    if (value) parts.push(`${question.label}：${value}`);
  }
  if (!parts.length) return base;
  return `${base.trimEnd()}\n\n【老板补充】${parts.join("；")}`;
}

/**
 * 把“我的版本”中与本题相关的保存值作为背景附在任务书后（仅在文字里没提到时）。
 */
export function preferenceContextLine(intent, preferences = null) {
  const saved = preferences?.values || {};
  const entities = intent?.entities || {};
  const parts = [];
  if (saved["店名"]) parts.push(`店名：${saved["店名"]}`);
  if (!entities.city && saved["城市"]) parts.push(`城市：${saved["城市"]}`);
  if (!entities.area && saved["商圈"]) parts.push(`商圈：${saved["商圈"]}`);
  if (!entities.category && saved["品类"]) parts.push(`品类：${saved["品类"]}`);
  if (!entities.price_band && saved["人均"]) parts.push(`人均：${saved["人均"]}`);
  if (!entities.store_count && saved["门店数"]) parts.push(`门店数：${saved["门店数"]}`);
  if (normalizeIntentType(intent?.type) === "plan") {
    if (saved["预算"]) parts.push(`常用预算：${saved["预算"]}`);
    if (saved["目标"]) parts.push(`常用目标：${saved["目标"]}`);
  }
  return parts.length ? `【我的版本·老板预设】${parts.join("；")}` : "";
}

/** 老板确认保存的固定输出要求，追加在答题形态之后；不削弱任何质量与安全规则。 */
export function outputPrefsPromptLine(preferences = null) {
  const list = normalizeOutputPrefs(preferences?.outputPrefs);
  return list.length
    ? `【老板固定要求·只影响写法，不改变事实与安全规则】${list.join("；")}`
    : "";
}

// ===== FR-8 派单闭环 =====

let rosterCache = null;

export function loadRestaurantRoster(file = RESTAURANT_CATALOG_PATH) {
  if (rosterCache && rosterCache.file === file) return rosterCache.roster;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const roster = (data.employees || [])
    .filter((item) => Number.isInteger(Number(item.idx)) && String(item.person || "").trim())
    .map((item) => ({
      idx: Number(item.idx),
      person: String(item.person).trim(),
      duty: String(item.duty || item.name || "").trim(),
      group: String(item.group || "").trim(),
    }));
  rosterCache = { file, roster };
  return roster;
}

export function resetRestaurantRosterCache() {
  rosterCache = null;
}

/**
 * 方案/诊断题型：给模型一份按部门压缩的同事名单，要求需要别人接手的动作写明派给谁。
 */
export function handoffRosterPromptLines(intent, selfIdx) {
  const type = normalizeIntentType(intent?.type);
  if (!["plan", "diagnose"].includes(type)) return [];
  let roster;
  try {
    roster = loadRestaurantRoster();
  } catch {
    return [];
  }
  const others = roster.filter((item) => item.idx !== Number(selfIdx));
  if (!others.length) return [];
  const groups = new Map();
  for (const item of others) {
    const list = groups.get(item.group) || [];
    list.push(`${item.person}·${item.duty}`);
    groups.set(item.group, list);
  }
  return [
    "【可派单同事】建议动作里需要其他岗位接手的，写成“建议派给：某某（岗位）”，只用下列称呼，不需要的不要硬派：",
    ...[...groups.entries()].map(([group, list]) => `- ${group || "其他"}：${list.join("、")}`),
  ];
}

function lineAround(text, index) {
  const start = text.lastIndexOf("\n", index) + 1;
  const endRaw = text.indexOf("\n", index);
  const end = endRaw === -1 ? text.length : endRaw;
  return text
    .slice(start, end)
    .replace(/[#>*`|]+/gu, " ")
    .replace(/^\s*[-\d.、)]+\s*/u, "")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .slice(0, 120);
}

/**
 * 从交付 markdown 里找出被点名派单的同事（不含自己），最多 3 位。
 * 优先识别“派给/交给/转给/由…负责”附近的称呼；其次识别执行清单里的称呼。
 */
export function extractHandoffSuggestions(markdown, { selfIdx = null, intent = null } = {}) {
  const text = String(markdown || "");
  const type = normalizeIntentType(intent?.type);
  if (!text || (intent && !["plan", "diagnose", "team"].includes(type))) return [];
  let roster;
  try {
    roster = loadRestaurantRoster();
  } catch {
    return [];
  }
  const found = [];
  for (const member of roster) {
    if (member.idx === Number(selfIdx)) continue;
    const at = text.indexOf(member.person);
    if (at === -1) continue;
    const near = text.slice(Math.max(0, at - 12), at + member.person.length + 4);
    const explicit = /派给|交给|转给|由|请|负责|对接|协同/u.test(near);
    found.push({ member, at, explicit, reason: lineAround(text, at) });
  }
  found.sort((a, b) => Number(b.explicit) - Number(a.explicit) || a.at - b.at);
  return found.slice(0, HANDOFF_MAX).map(({ member, reason, explicit }) => ({
    idx: member.idx,
    person: member.person,
    duty: member.duty,
    group: member.group,
    explicit,
    reason,
  }));
}

/** 一键派给同事时预填的任务书。 */
export function handoffDirective(handoff, { fromPerson = "", taskTitle = "" } = {}) {
  const reason = cleanText(handoff?.reason || "", 120);
  const title = cleanText(taskTitle, 60);
  const from = cleanText(fromPerson, 20);
  return [
    `${from ? `${from}` : "同事"}在${title ? `《${title}》` : "上一单"}里建议由你接手：`,
    reason || "请按上一单结论跟进执行。",
    "请给出可直接执行的做法。",
  ].join("\n");
}

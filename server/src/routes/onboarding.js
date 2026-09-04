import { Router } from "express";
import { db, q, curTenant, getTenant, getTenantConfig, setTenantConfig } from "../db.js";
import { logOp, requireRole } from "../util.js";
import { embedDoc } from "../engines/rag.js";
import { yunwuAvailable } from "../engines/yunwu.js";
import { loadRestaurantCatalog } from "../catalog/restaurant.js";
import { restaurantAvatar, restaurantBusinessProfile } from "../catalog/business-profiles.js";
import { matchTeamByText } from "./employees.js";
import { menuDraftFromFileIds } from "./dataintake.js";
import { defaultStoreId } from "../engines/store-scope.js";

// 开店向导（租户级新手引导）：新企业老板用 5 个固定问题完成初始配置——
// 落门店档案、写一篇企业基础知识、推荐 3 位数字员工并预填第一单任务。
// 与 components/RoleOnboarding（"教你用系统"）边界不同：这里是"帮你把企业配起来"。
// 状态存在 tenants.onboarding_status / onboarding_answers / onboarding_completed_at。
const r = Router();

export const ONBOARDING_STATUSES = Object.freeze([
  "pending",
  "in_progress",
  "completed",
  "skipped",
]);
const WRITE_ROLES = ["boss", "admin"];
const KB_CATEGORY = "企业档案";
const ANSWERS_VERSION = 1;

export const BIZ_TYPES = Object.freeze([
  "正餐",
  "快餐",
  "火锅",
  "烧烤",
  "烘焙",
  "饮品",
  "便利店",
  "其他",
]);
// stores.biz_type 只有 快餐/正餐/茶饮/火锅/其他 五档（见 routes/store-data.js），
// 向导里更细的业态在门店表上按最接近的一档落库，原值保留在答案与知识档案中。
const STORE_BIZ_TYPE = Object.freeze({
  正餐: "正餐",
  快餐: "快餐",
  火锅: "火锅",
  饮品: "茶饮",
});
export const CUSTOMER_GROUPS = Object.freeze([
  "周边白领",
  "家庭顾客",
  "学生",
  "游客",
  "企业团餐",
  "夜宵人群",
  "社区居民",
  "其他",
]);
export const GOALS = Object.freeze([
  "营收",
  "复购",
  "客单价",
  "口碑",
  "出餐效率",
  "成本",
]);

// 五个固定问题（服务端单一事实来源，前端只负责渲染）。文案说"老板话"，不出现技术词。
export const ONBOARDING_STEPS = Object.freeze([
  {
    key: "store",
    title: "先说说你的店",
    hint: "店叫什么、主要做什么、开在哪，说清楚这几点就行。",
    fields: [
      { name: "storeName", label: "店名", type: "text", required: true, max: 60, placeholder: "比如：老王牛肉面（万达店）" },
      { name: "bizType", label: "主要做什么", type: "select", required: true, options: BIZ_TYPES },
      { name: "city", label: "在哪个城市", type: "text", required: true, max: 30, placeholder: "比如：成都" },
      { name: "district", label: "开在哪个商圈或位置", type: "text", max: 60, placeholder: "比如：万达广场 3 楼 / 龙湖小区门口" },
      { name: "address", label: "详细地址（选填）", type: "text", max: 120 },
      { name: "seats", label: "店里大概多少个座位", type: "number", min: 0, max: 2000, unit: "个" },
    ],
  },
  {
    key: "customers",
    title: "谁来吃、一顿花多少",
    hint: "知道客人是谁、花多少钱，数字员工给的建议才不会跑偏。",
    fields: [
      { name: "customerGroups", label: "主要是哪些客人", type: "multiselect", required: true, options: CUSTOMER_GROUPS, max: 4 },
      { name: "avgTicket", label: "人均大概花多少钱", type: "number", required: true, min: 1, max: 5000, unit: "元" },
      { name: "dineInRatio", label: "堂食大约占几成（剩下的算外卖/自提）", type: "slider", min: 0, max: 100, step: 5, unit: "%" },
    ],
  },
  {
    key: "menu",
    title: "招牌菜是什么",
    hint: "写 3 到 5 道最拿得出手的菜；有现成菜单文件也可以直接传上来。",
    fields: [
      { name: "signatureDishes", label: "招牌菜（3 到 5 道）", type: "tags", required: true, min: 1, max: 5, itemMax: 30, placeholder: "输入一道菜名后按回车" },
      { name: "menuFileIds", label: "上传菜单文件（选填，Excel / 图片 / PDF 都行）", type: "files", max: 3 },
    ],
  },
  {
    key: "goal",
    title: "未来 90 天最想提升什么",
    hint: "只选一个最要紧的，数字员工会围着这个目标干活。",
    fields: [
      { name: "goal", label: "最想提升的一件事", type: "select", required: true, options: GOALS },
      { name: "goalTarget", label: "有目标数字就写一句（选填）", type: "text", max: 60, placeholder: "比如：月营收从 30 万做到 36 万" },
    ],
  },
  {
    key: "pain",
    title: "现在最头疼的一件事",
    hint: "用你自己的话说，不用讲究措辞，200 字以内。",
    fields: [
      { name: "painPoint", label: "最头疼的一件事", type: "textarea", required: true, max: 200, placeholder: "比如：中午高峰出餐太慢，客人等不及就走了；周末有人排队但工作日很冷清……" },
    ],
  },
]);

const FIELD_BY_NAME = new Map(
  ONBOARDING_STEPS.flatMap((step) => step.fields.map((field) => [field.name, { ...field, step: step.key }])),
);

// AI 不可用（或积分不足）时的兜底推荐：按"最想提升什么"给出 3 位目录里的数字员工，
// 只是一张固定的默认表，不是匹配逻辑；AI 可用时始终以 /employees/match-team 的结果为准。
const DEFAULT_TEAM_BY_GOAL = Object.freeze({
  营收: [
    { idx: 154, task: "结合我们店的企业基础档案，做一份未来 90 天的营收提升诊断，列出最值得先做的 3 个动作" },
    { idx: 141, task: "按我们店的商圈和客群，排一份未来 30 天的本地门店营销日历，每周至少一个能落地的动作" },
    { idx: 153, task: "按堂食/外卖、餐段和招牌菜拆一拆我们店的生意结构，找出最能拉动营收的环节" },
  ],
  复购: [
    { idx: 144, task: "为我们店设计一套简单可执行的会员和老客回访方案，先让常客多来一次" },
    { idx: 143, task: "整理一套我们店的评价回复话术和差评补救流程，把口碑问题变成回头客" },
    { idx: 138, task: "梳理我们店常见客诉的处理标准和补救权限，做成店员能直接用的清单" },
  ],
  客单价: [
    { idx: 108, task: "围绕我们的招牌菜重新规划菜单结构，让招牌菜带流量、利润菜赚钱、组合拉客单" },
    { idx: 112, task: "用菜单工程方法分析我们现有菜品，指出该主推、该调价、该下架的菜" },
    { idx: 145, task: "设计 2 个能拉高客单价又不亏钱的搭配/套餐促销方案，并说明如何验证效果" },
  ],
  口碑: [
    { idx: 143, task: "分析我们店最近的线上评价，起草回复话术并把问题转成具体的运营改进项" },
    { idx: 133, task: "结合我们店的业态和客群，制定一套前厅服务标准和异常处理流程" },
    { idx: 142, task: "策划一个月的社媒内容和顾客晒单活动，让客人愿意替我们店宣传" },
  ],
  出餐效率: [
    { idx: 134, task: "结合我们店的招牌菜和高峰情况，重排后厨工位与出餐节奏，给出高峰期提速方案" },
    { idx: 130, task: "按我们店的客流和菜品需求，做一份分时段、分批次的备料计划" },
    { idx: 136, task: "按我们店的客流规律做一份需求驱动的排班方案，高峰不缺人、闲时不浪费" },
  ],
  成本: [
    { idx: 111, task: "为我们店的招牌菜建立成本卡并给出售价建议，把毛利算清楚" },
    { idx: 148, task: "对比我们店的理论食材成本和实际耗用，找出成本漏在哪里" },
    { idx: 157, task: "做一轮我们店的食物浪费审计并给出减量方案，省下的都是净利润" },
  ],
});

const RESTAURANT_CATALOG = loadRestaurantCatalog();
const CATALOG_BY_IDX = new Map(RESTAURANT_CATALOG.employees.map((employee) => [employee.idx, employee]));

const clean = (value, max) => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);
const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

function isWriter(user) {
  return WRITE_ROLES.includes(user?.role);
}

function parseStored(raw) {
  if (!raw) return { version: ANSWERS_VERSION, answers: {}, completion: null };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad");
    return {
      version: Number(parsed.version) || ANSWERS_VERSION,
      answers: parsed.answers && typeof parsed.answers === "object" && !Array.isArray(parsed.answers) ? parsed.answers : {},
      completion: parsed.completion && typeof parsed.completion === "object" ? parsed.completion : null,
    };
  } catch {
    return { version: ANSWERS_VERSION, answers: {}, completion: null };
  }
}

function loadTenantOnboarding() {
  const tenant = getTenant(curTenant());
  if (!tenant) return null;
  const status = ONBOARDING_STATUSES.includes(tenant.onboarding_status) ? tenant.onboarding_status : "pending";
  return { tenant, status, ...parseStored(tenant.onboarding_answers), completedAt: tenant.onboarding_completed_at || null };
}

function persist(status, stored, completedAt) {
  q.run(
    `UPDATE tenants SET onboarding_status=?, onboarding_answers=?, onboarding_completed_at=COALESCE(?, onboarding_completed_at)
     WHERE id=?`,
    status,
    JSON.stringify({ version: ANSWERS_VERSION, answers: stored.answers, completion: stored.completion }),
    completedAt ?? null,
    curTenant(),
  );
}

function fieldError(field, message) {
  return Object.assign(new Error(`${field.label}：${message}`), { status: 400, field: field.name });
}

// 单字段清洗：只接受题目定义中的字段与类型，超长截断、非法值直接 400。
function normalizeField(field, value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  switch (field.type) {
    case "text":
    case "textarea": {
      if (typeof value !== "string") throw fieldError(field, "必须是文字");
      const text = field.type === "textarea" ? String(value).trim() : clean(value, 10000);
      if (text.length > field.max) throw fieldError(field, `最多 ${field.max} 字`);
      return text || null;
    }
    case "select": {
      const text = clean(value, 60);
      if (!field.options.includes(text)) throw fieldError(field, `只能从 ${field.options.join("/")} 里选`);
      return text;
    }
    case "multiselect": {
      if (!Array.isArray(value)) throw fieldError(field, "格式不正确");
      const items = [...new Set(value.map((item) => clean(item, 60)).filter(Boolean))];
      if (items.some((item) => !field.options.includes(item))) throw fieldError(field, `只能从 ${field.options.join("/")} 里选`);
      if (field.max && items.length > field.max) throw fieldError(field, `最多选 ${field.max} 项`);
      return items.length ? items : null;
    }
    case "number":
    case "slider": {
      const number = Number(value);
      if (!Number.isFinite(number)) throw fieldError(field, "必须是数字");
      if (field.min !== undefined && number < field.min) throw fieldError(field, `不能小于 ${field.min}`);
      if (field.max !== undefined && number > field.max) throw fieldError(field, `不能大于 ${field.max}`);
      return Math.round(number * 100) / 100;
    }
    case "tags": {
      if (!Array.isArray(value)) throw fieldError(field, "格式不正确");
      const items = [...new Set(value.map((item) => clean(item, field.itemMax || 30)).filter(Boolean))];
      if (field.max && items.length > field.max) throw fieldError(field, `最多 ${field.max} 项`);
      return items.length ? items : null;
    }
    case "files": {
      if (!Array.isArray(value)) throw fieldError(field, "格式不正确");
      const ids = [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      if (field.max && ids.length > field.max) throw fieldError(field, `最多 ${field.max} 个文件`);
      if (!ids.length) return null;
      // 只接受本企业已通过 /api/files/upload 上传的文件，杜绝凭 id 引用别家附件。
      const owned = q.scopedAll("uploaded_files", `AND id IN (${ids.map(() => "?").join(",")})`, ...ids);
      if (owned.length !== ids.length) throw fieldError(field, "有文件不存在或不属于当前企业，请重新上传");
      return ids;
    }
    default:
      throw fieldError(field, "暂不支持的题型");
  }
}

function mergeAnswers(current, incoming) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    throw Object.assign(new Error("answers 必须是对象"), { status: 400 });
  }
  const next = { ...current };
  for (const [name, value] of Object.entries(incoming)) {
    const field = FIELD_BY_NAME.get(name);
    if (!field) continue; // 未知字段静默忽略，前端多传不致命
    const normalized = normalizeField(field, value);
    if (normalized === undefined) continue;
    if (normalized === null) delete next[name];
    else next[name] = normalized;
  }
  return next;
}

function missingRequired(answers) {
  const missing = [];
  for (const step of ONBOARDING_STEPS) {
    for (const field of step.fields) {
      if (!field.required) continue;
      const value = answers[field.name];
      const empty = value === undefined || value === null || (Array.isArray(value) && !value.length);
      if (empty) missing.push({ step: step.key, name: field.name, label: field.label });
      else if (field.type === "tags" && field.min && value.length < field.min) {
        missing.push({ step: step.key, name: field.name, label: `${field.label}（至少 ${field.min} 道）` });
      }
    }
  }
  return missing;
}

function answeredSteps(answers) {
  return ONBOARDING_STEPS.filter((step) =>
    step.fields.filter((field) => field.required).every((field) => {
      const value = answers[field.name];
      return !(value === undefined || value === null || (Array.isArray(value) && !value.length));
    }),
  ).map((step) => step.key);
}

function statePayload(state, user) {
  const done = answeredSteps(state.answers);
  const nextStep = ONBOARDING_STEPS.find((step) => !done.includes(step.key))?.key || null;
  return {
    status: state.status,
    canEdit: isWriter(user),
    answers: state.answers,
    completedAt: state.completedAt,
    completion: state.completion,
    steps: ONBOARDING_STEPS,
    progress: { answeredSteps: done, nextStep, total: ONBOARDING_STEPS.length },
    options: { bizTypes: BIZ_TYPES, customerGroups: CUSTOMER_GROUPS, goals: GOALS },
  };
}

function menuFiles(ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  return q.scopedAll("uploaded_files", `AND id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ...ids)
    .map((file) => ({ id: file.id, name: file.name, ext: file.ext, url: file.file_url || null }));
}

function ratioText(dineIn) {
  if (dineIn === undefined || dineIn === null) return "未填写";
  const dine = Math.round(Number(dineIn));
  return `堂食约 ${dine}%，外卖/自提约 ${100 - dine}%`;
}

export function buildProfileMarkdown(answers, files = [], generatedAt = now()) {
  const line = (label, value) => `- ${label}：${value === undefined || value === null || value === "" ? "未填写" : value}`;
  const dishes = Array.isArray(answers.signatureDishes) ? answers.signatureDishes.join("、") : "";
  const groups = Array.isArray(answers.customerGroups) ? answers.customerGroups.join("、") : "";
  const attachments = files.length
    ? files.map((file) => `- ${file.name}${file.url ? `（${file.url}）` : ""}`).join("\n")
    : "- 暂无菜单附件";
  return [
    `# ${answers.storeName} 企业基础档案`,
    "",
    `> 由开店向导于 ${generatedAt} 根据老板作答生成；老板可在知识库中随时修改，数字员工回答与本店相关的问题时以本档案为事实依据。`,
    "",
    "## 品牌与门店",
    line("店名", answers.storeName),
    line("业态", answers.bizType),
    line("城市", answers.city),
    line("商圈/位置", answers.district),
    line("地址", answers.address),
    line("座位数", answers.seats !== undefined && answers.seats !== null ? `${answers.seats} 个` : undefined),
    "",
    "## 客群与客单价",
    line("主力客群", groups),
    line("人均消费", answers.avgTicket !== undefined && answers.avgTicket !== null ? `约 ${answers.avgTicket} 元` : undefined),
    line("堂食/外卖占比", ratioText(answers.dineInRatio)),
    "",
    "## 招牌与菜单",
    line("招牌菜", dishes),
    "- 菜单附件：",
    attachments,
    "",
    "## 经营目标（未来 90 天）",
    line("最想提升", answers.goal),
    line("目标数字", answers.goalTarget),
    "",
    "## 当前最头疼的事",
    answers.painPoint || "未填写",
    "",
    "## 给数字员工的提示",
    "- 本档案是老板亲自填写的一手信息，优先级高于行业通用经验。",
    `- 所有方案都应围绕"${answers.goal || "经营提升"}"这个目标，并直接回应老板最头疼的事。`,
    "- 档案中「未填写」的信息不要猜测，需要时向老板追问。",
  ].join("\n");
}

function ensureKbCategory() {
  const DEFAULT_KB_CATS = ["品牌资料", "招商政策", "产品资料", "话术案例", "客户画像", "数据规范", "员工产出"];
  const cats = getTenantConfig("kb_categories", DEFAULT_KB_CATS);
  const list = Array.isArray(cats) && cats.length ? [...cats] : [...DEFAULT_KB_CATS];
  if (list.includes(KB_CATEGORY)) return;
  const at = list.indexOf("员工产出");
  list.splice(at >= 0 ? at : list.length, 0, KB_CATEGORY);
  setTenantConfig("kb_categories", list);
}

// 多门店兼容：租户在向导前若已被系统懒创建了一家「占位默认店」（名=企业名/总店、无地址、且是唯一门店），
// 向导直接把它改成真实门店，避免单店客户完成向导后出现两家门店。
function placeholderDefaultStore() {
  const stores = q.scopedAll("stores", "ORDER BY id LIMIT 2");
  if (stores.length !== 1) return null;
  const only = stores[0];
  const tenantName = String(getTenant(curTenant())?.name || "").trim();
  const placeholderNames = new Set(["总店", tenantName].filter(Boolean));
  if (Number(only.is_default) !== 1 || !placeholderNames.has(String(only.name || "").trim())) return null;
  if (only.address || only.city) return null;
  return only;
}

function upsertStore(answers, previousStoreId) {
  const bizType = STORE_BIZ_TYPE[answers.bizType] || "其他";
  const existing =
    (previousStoreId && q.scopedGet("stores", "AND id = ?", previousStoreId)) ||
    q.scopedGet("stores", "AND name = ? ORDER BY id LIMIT 1", answers.storeName) ||
    placeholderDefaultStore();
  if (existing) {
    q.run(
      `UPDATE stores SET name=?, address=?, city=?, area=?, biz_type=? WHERE tenant_id=? AND id=?`,
      answers.storeName,
      answers.address || existing.address || null,
      answers.city || existing.city || null,
      answers.district || existing.area || null,
      bizType,
      curTenant(),
      existing.id,
    );
    return { store: q.scopedGet("stores", "AND id = ?", existing.id), created: false };
  }
  const inserted = q.run(
    `INSERT INTO stores(name,code,address,city,area,biz_type,opened_at,status) VALUES(?,?,?,?,?,?,?,?)`,
    answers.storeName,
    null,
    answers.address || null,
    answers.city || null,
    answers.district || null,
    bizType,
    null,
    "营业中",
  );
  // 多门店：租户尚无默认门店时，向导落的第一家门店即默认店（defaultStoreId 会把首家标为默认）
  defaultStoreId(curTenant());
  return { store: q.scopedGet("stores", "AND id = ?", inserted.lastInsertRowid), created: true };
}

function upsertKbDoc(user, title, body, previousDocId) {
  const existing = previousDocId ? q.scopedGet("kb_docs", "AND id = ?", previousDocId) : null;
  if (existing) {
    q.run(
      `UPDATE kb_docs SET category=?, title=?, body=?, enabled=1, version=version+1, updated_at=datetime('now','localtime')
       WHERE tenant_id=? AND id=?`,
      KB_CATEGORY,
      title,
      body,
      curTenant(),
      existing.id,
    );
    return { id: existing.id, created: false };
  }
  const inserted = q.run(
    `INSERT INTO kb_docs(category,title,body,enabled,source_type) VALUES(?,?,?,1,'onboarding')`,
    KB_CATEGORY,
    title,
    body,
  );
  q.run(
    `INSERT INTO biz_assets(name,category,value,status,owner,source_type,source_id,creator_id,note)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    title,
    "知识资产",
    1000,
    "使用中",
    "开店向导",
    "kb",
    inserted.lastInsertRowid,
    user.id,
    "开店向导根据老板作答生成的企业基础档案，可继续编辑完善",
  );
  return { id: Number(inserted.lastInsertRowid), created: true };
}

function matchTextFor(answers) {
  const text = `我们是${answers.city || ""}的${answers.bizType || "餐饮"}店「${answers.storeName}」，主要客人是${
    (answers.customerGroups || []).join("、") || "周边顾客"
  }，人均约 ${answers.avgTicket ?? "-"} 元。未来 90 天最想提升${answers.goal}${
    answers.goalTarget ? `（${answers.goalTarget}）` : ""
  }。现在最头疼的是：${answers.painPoint}`;
  return text.slice(0, 300);
}

function recommendationCard(idx, extra, role) {
  const employee = CATALOG_BY_IDX.get(Number(idx));
  if (!employee) return null;
  const num = employee.idx - 100;
  const business = restaurantBusinessProfile(num, role);
  return {
    idx: employee.idx,
    key: employee.key,
    person: employee.person,
    name: employee.name,
    duty: employee.duty || "",
    group: employee.group,
    avatar: restaurantAvatar(num),
    intro: business?.intro || "",
    typicalCredits: business?.cost?.typicalCredits ?? null,
    ...extra,
  };
}

function defaultRecommendations(answers, role) {
  const plan = DEFAULT_TEAM_BY_GOAL[answers.goal] || DEFAULT_TEAM_BY_GOAL.营收;
  return plan
    .map((item, index) =>
      recommendationCard(
        item.idx,
        {
          roleInTeam: index === 0 ? "队长" : "成员",
          task: `${item.task}。补充背景：${answers.painPoint}`.slice(0, 300),
          why: `围绕"${answers.goal}"这个目标的常用搭配`,
        },
        role,
      ),
    )
    .filter(Boolean);
}

// 推荐 3 位数字员工：优先复用 /employees/match-team 的真实 AI 匹配（走它自己的计费）；
// AI 未配置、积分不足或匹配失败时退回按目标给出的默认三人组，并如实标注来源。
async function recommendTeam(req, answers) {
  const matchText = matchTextFor(answers);
  const wantAi = req.body?.aiMatch !== false;
  if (wantAi && yunwuAvailable()) {
    try {
      const matched = await matchTeamByText(req, matchText);
      const ordered = [...matched.team.members].sort((a, b) => (a.roleInTeam === "队长" ? -1 : 0) - (b.roleInTeam === "队长" ? -1 : 0));
      const cards = ordered
        .slice(0, 3)
        .map((member) =>
          recommendationCard(
            member.idx,
            { roleInTeam: member.roleInTeam, task: member.task || matchText, why: member.why || "" },
            req.user.role,
          ),
        )
        .filter(Boolean);
      if (cards.length) {
        return {
          source: "ai",
          note: matched.team.summary || "",
          teamName: matched.team.teamName || "",
          billing: matched.billing || null,
          matchText,
          members: cards,
        };
      }
    } catch (error) {
      return {
        source: "catalog_default",
        note: `AI 挑人没成功（${String(error?.message || "未知原因").slice(0, 120)}），先用按目标推荐的默认三人组`,
        billing: error?.billing || null,
        matchText,
        members: defaultRecommendations(answers, req.user.role),
      };
    }
  }
  return {
    source: "catalog_default",
    note: wantAi
      ? "AI 通道未配置，先用按目标推荐的默认三人组；配置后可在数字员工页用「一句话找人」重新挑人"
      : "按目标推荐的默认三人组",
    billing: null,
    matchText,
    members: defaultRecommendations(answers, req.user.role),
  };
}

r.get("/state", (req, res) => {
  const state = loadTenantOnboarding();
  if (!state) return res.status(404).json({ error: "当前企业不存在" });
  res.set("Cache-Control", "private, no-store");
  res.json(statePayload(state, req.user));
});

r.put("/answers", requireRole(...WRITE_ROLES), (req, res) => {
  const state = loadTenantOnboarding();
  if (!state) return res.status(404).json({ error: "当前企业不存在" });
  let answers;
  try {
    answers = mergeAnswers(state.answers, req.body?.answers ?? req.body ?? {});
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message, field: error.field || null });
  }
  const nextStatus = state.status === "completed" ? "completed" : "in_progress";
  persist(nextStatus, { answers, completion: state.completion }, null);
  logOp(req.user, "开店向导", "保存作答", Object.keys(req.body?.answers ?? req.body ?? {}).join(","));
  res.json(statePayload({ ...state, status: nextStatus, answers }, req.user));
});

r.post("/complete", requireRole(...WRITE_ROLES), async (req, res) => {
  const state = loadTenantOnboarding();
  if (!state) return res.status(404).json({ error: "当前企业不存在" });
  let answers;
  try {
    answers = mergeAnswers(state.answers, req.body?.answers ?? {});
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message, field: error.field || null });
  }
  const missing = missingRequired(answers);
  if (missing.length) {
    return res.status(400).json({
      error: `还有几个问题没答完：${missing.map((item) => item.label).join("、")}`,
      missing,
    });
  }

  const files = menuFiles(answers.menuFileIds);
  const generatedAt = now();
  const title = `${answers.storeName}·企业基础档案`;
  const body = buildProfileMarkdown(answers, files, generatedAt);
  let storeResult;
  let kbResult;
  let completion;
  try {
    db.exec("BEGIN IMMEDIATE");
    ensureKbCategory();
    storeResult = upsertStore(answers, state.completion?.storeId);
    kbResult = upsertKbDoc(req.user, title, body, state.completion?.kbDocId);
    completion = {
      storeId: storeResult.store.id,
      kbDocId: kbResult.id,
      kbTitle: title,
      menuFiles: files,
      completedAt: generatedAt,
      completedBy: req.user.id,
    };
    persist("completed", { answers, completion }, generatedAt);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    return res.status(500).json({ error: `开店向导落地失败，本次未保存任何数据：${String(error?.message || error).slice(0, 160)}` });
  }

  // 向量化走 rag 的后台队列与两阶段计费：积分不足/未配置/未开启只影响是否能语义检索，不影响完成。
  let vectorization;
  try {
    const embedded = embedDoc(kbResult.id, title, body, { userId: req.user.id });
    vectorization = {
      accepted: Boolean(embedded?.accepted),
      reason: embedded?.reason || (embedded?.accepted ? "queued" : "unknown"),
      error: embedded?.error || null,
    };
  } catch (error) {
    vectorization = { accepted: false, reason: "embed_failed", error: String(error?.message || error).slice(0, 160) };
  }

  const recommendation = await recommendTeam(req, answers);
  // 菜单文件解析成菜品「草稿预览」（Excel 走字段映射，图片走拍照识别 kind=menu），只返回不落库，
  // 由前端提示"识别到 N 道菜，去确认导入"。失败不影响向导完成。
  let menuDraft = null;
  if (Array.isArray(answers.menuFileIds) && answers.menuFileIds.length) {
    try {
      menuDraft = await menuDraftFromFileIds(answers.menuFileIds, req.user);
    } catch (error) {
      menuDraft = { status: "failed", dishes: 0, batches: [], files: [], error: String(error?.message || error).slice(0, 200) };
    }
  }
  logOp(
    req.user,
    "开店向导",
    "完成开店向导",
    `${answers.storeName} store#${completion.storeId}(${storeResult.created ? "新建" : "更新"}) kb#${completion.kbDocId}(${kbResult.created ? "新建" : "更新"}) 推荐:${recommendation.source}${menuDraft ? ` 菜单草稿:${menuDraft.dishes}道` : ""}`,
  );
  res.json({
    ok: true,
    status: "completed",
    completedAt: generatedAt,
    store: { ...storeResult.store, created: storeResult.created },
    kbDoc: { id: kbResult.id, title, category: KB_CATEGORY, created: kbResult.created },
    vectorization,
    recommendation,
    menuDraft,
    boundary: "本接口只落门店档案与企业知识、给出推荐；派活与扣积分在你点击「让 TA 现在就干」时才发生。菜单文件只生成草稿预览，需到数据录入中枢确认导入。",
  });
});

r.post("/skip", requireRole(...WRITE_ROLES), (req, res) => {
  const state = loadTenantOnboarding();
  if (!state) return res.status(404).json({ error: "当前企业不存在" });
  if (state.status === "completed") {
    return res.status(400).json({ error: "开店向导已经完成，不需要跳过；如需修改可重新进入向导" });
  }
  persist("skipped", { answers: state.answers, completion: state.completion }, null);
  logOp(req.user, "开店向导", "跳过开店向导", "");
  res.json(statePayload({ ...state, status: "skipped" }, req.user));
});

export default r;

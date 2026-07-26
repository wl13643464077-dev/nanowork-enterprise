import { Router } from 'express';
import { db, q, curTenant, mergeMarshal } from '../db.js';
import { logOp, notify, pct, monthStart } from '../util.js';
import { generate, tplActivityPlan, kbContext, ACTIVITY_PLAN_SCHEMA } from '../engines/ai.js';
import {
  syncActivityLifecycleToFeishu, pushFeishuToManagers, pushFeishuToUser,
  feishuUserRecipient, icsToken, appReady, appBotReady, feishuManagerSummary, feishuConfig,
} from '../engines/feishu.js';
import { precheck, precheckByRole, charge } from '../engines/credits.js';
import { embedDoc } from '../engines/rag.js';
import { accessibleUserExists, canAccessOwner, userScopeClause } from '../engines/access.js';
import { archiveAndDelete, deleteList, deletionDenied, isBossLike, isManagerLike, tableRows } from '../engines/deletion.js';
import { normalizeActivityPlan } from '../engines/activity-plan.js';

const r = Router();

function appUrl(req, path = '/activities') {
  return `${req.protocol}://${req.get('host')}${path}`;
}

const PLAN_DRAFT = '草稿';
const PLAN_PENDING = '待审批';
const CHECK_PENDING = '待审批';
const CHECK_BOSS = '总审中';
const CHECK_APPROVED = '已通过';
const CHECK_REJECTED = '已驳回';
const DEFAULT_ACTIVITY_TYPE = '门店主题活动';
const LEGACY_ACTIVITY_TYPE_MAP = {
  '品鉴会': DEFAULT_ACTIVITY_TYPE,
  '沙龙会': DEFAULT_ACTIVITY_TYPE,
  '招商说明会': '渠道合作活动',
  '回厂游': '门店参访活动',
};
const ACTIVITY_BASELINE_FIELDS = [
  ['inviteSign', '邀约到报名基准'],
  ['signArrive', '报名到场基准'],
  ['arriveDeal', '到场成交基准'],
  ['roi', '活动投入产出基准'],
];
const SMART_INVITE_STAGES = new Set(['已沟通', '已邀约', '已到店']);
const SMART_INVITE_RULES = [
  { id: 'grade', label: '客户等级为 A 或 B' },
  { id: 'stage', label: '当前阶段为已沟通、已邀约或已到店' },
  { id: 'contact', label: '至少有一种可用联系方式' },
  { id: 'not_invited', label: '尚未加入本活动邀约名单' },
];

function normalizeActivityType(value) {
  const type = String(value || '').trim();
  return LEGACY_ACTIVITY_TYPE_MAP[type] || type || DEFAULT_ACTIVITY_TYPE;
}

function configuredActivityBaseline() {
  // 只把租户负责人明确保存的值当作可比较基准；平台演示默认不能冒充本企业事实。
  const row = q.get('SELECT value FROM sys_config WHERE key=?', `activity_baseline:${curTenant()}`);
  let raw = {};
  try { raw = row?.value ? JSON.parse(row.value) : {}; } catch { raw = {}; }
  const entries = ACTIVITY_BASELINE_FIELDS.flatMap(([key]) => {
    if (raw[key] === '' || raw[key] === null || raw[key] === undefined) return [];
    const value = Number(raw[key]);
    return Number.isFinite(value) && value >= 0 ? [[key, value]] : [];
  });
  return Object.fromEntries(entries);
}

function boundedTimeout(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

const ACTIVITY_EMBED_TIMEOUT_MS = boundedTimeout('AI_INTERACTIVE_EMBED_TIMEOUT_MS', 3000, 250, 20000);
const ACTIVITY_CHAT_TIMEOUT_MS = boundedTimeout('AI_INTERACTIVE_CHAT_TIMEOUT_MS', 20000, 500, 60000);

function parseMaybeJson(v, fallback = null) {
  if (!v) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

function planDraftForUser(id, user) {
  const row = q.get(`SELECT * FROM activity_plan_drafts WHERE tenant_id=? AND id=?`, curTenant(), id);
  if (!row) return null;
  return canAccessOwner(user, row.user_id) ? row : null;
}

function validTargetJoin(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 1 && count <= 1_000_000 ? count : null;
}

function normalizedDateTime(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const [y, m, d, h, min, sec] = [year, month, day, hour, minute, second].map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, h, min, sec));
  if (y < 1900 || y > 2999 || h > 23 || min > 59 || sec > 59
    || probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${year}-${month}-${day}${match[4] ? ` ${hour}:${minute}:${second}` : ''}`;
}

function immediateTransaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw error;
  }
}

const ACTIVITY_STATUSES = new Set(['策划中', '筹备中', '报名中', '进行中', '已结束', '已复盘']);
const ACTIVITY_NUMBERS = {
  target_join: { label: '目标报名人数', integer: true, min: 1, max: 1_000_000 },
  target_deal: { label: '目标成交数', integer: true, min: 0, max: 1_000_000 },
  invited: { label: '邀约人数', integer: true, min: 0, max: 1_000_000_000 },
  signed_up: { label: '报名人数', integer: true, min: 0, max: 1_000_000_000 },
  arrived: { label: '到场人数', integer: true, min: 0, max: 1_000_000_000 },
  converted: { label: '成交数', integer: true, min: 0, max: 1_000_000_000 },
  budget: { label: '预算', integer: false, min: 0, max: 1_000_000_000_000 },
  cost: { label: '成本', integer: false, min: 0, max: 1_000_000_000_000 },
  revenue: { label: '收入', integer: false, min: 0, max: 1_000_000_000_000 },
  satisfaction: { label: '满意度', integer: false, min: 0, max: 5 },
};

function normalizedActivityInput(input, { creating = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('活动数据格式不正确'), { status: 400 });
  }
  const output = {};
  const has = field => Object.prototype.hasOwnProperty.call(input, field);
  const text = (field, label, max, { required = false, allowEmpty = false } = {}) => {
    if (!creating && !has(field)) return;
    if (creating && !required && !has(field)) return;
    if (typeof input[field] !== 'string') throw Object.assign(new Error(`${label}必须是文本`), { status: 400 });
    const value = input[field].trim();
    if (!value && (required || !allowEmpty)) throw Object.assign(new Error(`${label}不能为空`), { status: 400 });
    if (value.length > max) throw Object.assign(new Error(`${label}不能超过${max}字`), { status: 400 });
    output[field] = value;
  };
  text('title', '活动名称', 200, { required: creating });
  text('type', '活动类型', 40);
  if (output.type) output.type = normalizeActivityType(output.type);
  text('location', '活动地点', 200, { allowEmpty: true });
  if (creating || has('date')) {
    const date = normalizedDateTime(input.date);
    if (!date || date.includes(' ')) throw Object.assign(new Error('活动日期格式不正确'), { status: 400 });
    output.date = date;
  }
  if (has('status')) {
    if (typeof input.status !== 'string' || !ACTIVITY_STATUSES.has(input.status.trim())) {
      throw Object.assign(new Error('活动状态不正确'), { status: 400 });
    }
    output.status = input.status.trim();
  }
  for (const [field, rule] of Object.entries(ACTIVITY_NUMBERS)) {
    if (!has(field)) continue;
    if (input[field] === '' || input[field] === null || input[field] === undefined) {
      throw Object.assign(new Error(`${rule.label}不能为空`), { status: 400 });
    }
    const value = Number(input[field]);
    if (!Number.isFinite(value) || value < rule.min || value > rule.max || (rule.integer && !Number.isSafeInteger(value))) {
      throw Object.assign(new Error(`${rule.label}格式不正确`), { status: 400 });
    }
    output[field] = value;
  }
  return output;
}

function savePlan(actId, plan, status = PLAN_DRAFT) {
  const normalized = normalizeActivityPlan(plan);
  q.run(`UPDATE activities SET plan=?, plan_status=?, plan_submitted_at=NULL, plan_approved_at=NULL, plan_approval_id=NULL WHERE id=?`,
    JSON.stringify(normalized), status, actId);
}

function planSummary(plan = {}) {
  plan = normalizeActivityPlan(plan);
  const flowCount = Array.isArray(plan.flow) ? plan.flow.length : 0;
  const materials = Array.isArray(plan.materials) ? plan.materials.length : 0;
  const sop = Array.isArray(plan.sop) ? plan.sop.length : 0;
  return `流程${flowCount}项 / 物料${materials}项 / SOP${sop}项`;
}

function managerUsers(roles = ['boss', 'ops_director', 'admin']) {
  const list = roles.map(() => '?').join(',');
  return q.all(`SELECT id,name,role FROM users WHERE tenant_id=${curTenant()} AND role IN (${list})`, ...roles);
}

function notifyManagers(type, title, body, roles) {
  for (const u of managerUsers(roles)) notify(u.id, type, title, body);
}

function safeChecklist(raw) {
  const arr = parseMaybeJson(raw, []);
  return Array.isArray(arr) ? arr.map((x, idx) => (typeof x === 'object' && x ? x : { item: String(x || `事项${idx + 1}`), done: false })) : [];
}

function checklistItemLabel(item, idx = 0) {
  return String(item?.item || item?.title || item?.name || `待确认事项${idx + 1}`);
}

function classifyReviewKb(act, review) {
  const text = `${act?.title || ''} ${act?.type || ''} ${JSON.stringify(review || {})}`;
  if (/渠道|合作|联名|团餐|供应|商圈/.test(text)) return '员工产出';
  if (/话术|SOP|邀约|沟通|回访|追单|客户/.test(text)) return '话术案例';
  if (/画像|名单|企业主|高净值|老客|会员/.test(text)) return '客户画像';
  if (/转化|ROI|复盘|数据|基准|成本|收入/.test(text)) return '数据规范';
  return '员工产出';
}

function reviewKbBody(act, review, actor) {
  const lines = [
    `# 活动复盘：${act.title}`,
    '',
    `- 活动类型：${act.type || '-'}`,
    `- 活动日期：${act.date || '-'}`,
    `- 负责人：${actor?.name || '-'}`,
    `- 活动状态：已复盘`,
    `- 目标人数：${act.target_join || 0}`,
    `- 目标成交：${act.target_deal || 0}`,
    `- 实际邀约：${act.invited || 0}`,
    `- 实际报名：${act.signed_up || 0}`,
    `- 实际到场：${act.arrived || 0}`,
    `- 实际成交：${act.converted || 0}`,
    `- 收入：${act.revenue || 0}`,
    `- 成本：${act.cost || 0}`,
    '',
    '## 关键结论',
    ...(Array.isArray(review?.ok) && review.ok.length ? review.ok.map(x => `- ${x}`) : ['- 流程执行完整']),
    '',
    '## 差距与问题',
    ...(Array.isArray(review?.gaps) && review.gaps.length ? review.gaps.map(x => `- ${x}`) : ['- 暂无明显低于基准项']),
    ...(Array.isArray(review?.bad) && review.bad.length ? review.bad.map(x => `- ${x}`) : []),
    '',
    '## 改进动作',
    ...(Array.isArray(review?.improvements) && review.improvements.length ? review.improvements.map(x => `- ${x}`) : ['- 会后复盘并沉淀下一场活动检查表']),
    '',
    '## 下次跟进',
    ...(Array.isArray(review?.followup) ? review.followup.map(x => `- ${x}`) : [`- ${review?.followup || '会后24小时回访 + 3天追单 + 7天归因复盘'}`]),
  ];
  if (review?.aiText) lines.push('', `## ${review?.aiMeta?.marshal || '数据分析部'}深度复盘`, String(review.aiText));
  return lines.join('\n');
}

function syncReviewToKb(act, review, actor) {
  const category = classifyReviewKb(act, review);
  const title = `活动复盘：${act.title}`;
  const body = reviewKbBody(act, review, actor);
  const existed = q.get(`SELECT id FROM kb_docs WHERE tenant_id=${curTenant()} AND title=? ORDER BY id DESC LIMIT 1`, title);
  let id = existed?.id;
  if (id) {
    q.run(`UPDATE kb_docs SET category=?, body=?, enabled=1, version=version+1, updated_at=datetime('now','localtime') WHERE id=?`, category, body, id);
  } else {
    const result = q.run('INSERT INTO kb_docs(category,title,body,enabled) VALUES(?,?,?,1)', category, title, body);
    id = result.lastInsertRowid;
  }
  embedDoc(id, title, body);
  return { id, category, title };
}
function ensureActivityAccess(req, res, id) {
  const act = q.get(`SELECT * FROM activities WHERE tenant_id = ${curTenant()} AND id = ?`, id);
  if (!act || !canAccessOwner(req.user, act.owner_id)) {
    res.status(404).json({ error: '活动不存在或无权访问' });
    return null;
  }
  return act;
}

function smartInviteSelection(req, act, requestedLimit = 10) {
  const parsedLimit = Number(requestedLimit);
  const limit = Number.isSafeInteger(parsedLimit) ? Math.min(50, Math.max(1, parsedLimit)) : 10;
  const scope = userScopeClause(req.user, 'l.owner_id');
  const rows = q.all(`SELECT l.id,l.name,l.grade,l.score,l.stage,l.interest,l.phone,l.wechat,
      CASE WHEN i.id IS NULL THEN 0 ELSE 1 END already_invited
    FROM leads l
    LEFT JOIN activity_invites i
      ON i.tenant_id=? AND i.activity_id=? AND i.lead_id=l.id
    WHERE l.tenant_id=?${scope.sql}
    ORDER BY COALESCE(l.score,0) DESC,l.id DESC`, curTenant(), act.id, curTenant(), ...scope.params);

  const reasonOf = row => {
    const reasons = [];
    if (!['A', 'B'].includes(String(row.grade || '').toUpperCase())) reasons.push('客户等级未命中');
    if (!SMART_INVITE_STAGES.has(String(row.stage || ''))) reasons.push('客户阶段不适用');
    if (!String(row.phone || '').trim() && !String(row.wechat || '').trim()) reasons.push('缺少可用联系方式');
    if (Number(row.already_invited)) reasons.push('已在活动名单');
    return reasons;
  };
  const evaluated = rows.map(row => ({ row, reasons: reasonOf(row) }));
  const eligibleRows = evaluated.filter(item => item.reasons.length === 0).map(item => item.row);
  const candidateView = row => ({
    id: Number(row.id),
    name: row.name,
    grade: row.grade,
    score: Number(row.score || 0),
    stage: row.stage,
    interest: row.interest || '',
    contactChannels: [String(row.phone || '').trim() ? '手机' : '', String(row.wechat || '').trim() ? '微信' : ''].filter(Boolean),
    matchedRules: SMART_INVITE_RULES.map(rule => rule.id),
  });
  const exclusions = [...new Set(evaluated.flatMap(item => item.reasons))].map(reason => {
    const blocked = evaluated.filter(item => item.reasons.includes(reason));
    return {
      reason,
      count: blocked.length,
      samples: blocked.slice(0, 5).map(item => ({ id: Number(item.row.id), name: item.row.name })),
    };
  });
  const candidates = eligibleRows.slice(0, limit).map(candidateView);
  return {
    eligibleIds: new Set(eligibleRows.map(row => Number(row.id))),
    report: {
      activity: { id: Number(act.id), title: act.title },
      rules: SMART_INVITE_RULES,
      counts: {
        scopedTotal: rows.length,
        eligible: eligibleRows.length,
        selected: candidates.length,
        excluded: rows.length - eligibleRows.length,
      },
      candidates,
      exclusions,
      confirmationRequired: true,
      privacyNote: '候选仅来自当前账号有权查看的本企业 CRM；系统不会自动触达，联系授权与活动信息须由负责人复核。',
    },
  };
}

function activityDeletePolicy(req, act) {
  const inviteCount = q.get(`SELECT COUNT(*) n FROM activity_invites WHERE tenant_id=${curTenant()} AND activity_id=?`, act.id)?.n || 0;
  const approvalCount = q.get(`SELECT COUNT(*) n FROM approvals WHERE tenant_id=${curTenant()} AND target_type IN ('activity_plan','activity_checklist') AND target_id=?`, act.id)?.n || 0;
  const critical = ['已结束', '已复盘'].includes(act.status)
    || ['待审批', '总审中', '已通过'].includes(act.plan_status)
    || inviteCount > 0
    || approvalCount > 0
    || Number(act.revenue || 0) > 0
    || Number(act.cost || 0) > 0
    || Number(act.signed_up || 0) > 0
    || Number(act.arrived || 0) > 0
    || Number(act.converted || 0) > 0;
  if (critical) return {
    allowed: isBossLike(req.user),
    requiredRole: 'boss',
    reason: '活动已有审批、邀约或战果数据，属于经营事实，需老板/管理员删除',
    inviteCount,
    approvalCount,
  };
  if (isBossLike(req.user)) return { allowed: true, requiredRole: 'boss', reason: '老板/管理员删除活动', inviteCount, approvalCount };
  if (isManagerLike(req.user) && canAccessOwner(req.user, act.owner_id)) {
    return { allowed: true, requiredRole: 'manager', reason: '管理层删除团队筹备活动', inviteCount, approvalCount };
  }
  const ownDraft = Number(act.owner_id) === Number(req.user.id) && ['策划中', '筹备中'].includes(act.status);
  return {
    allowed: ownDraft,
    requiredRole: ownDraft ? 'self' : 'manager',
    reason: ownDraft ? '本人删除误建活动' : '非本人活动需管理层处理',
    inviteCount,
    approvalCount,
  };
}

function syncActivityStatuses() {
  const T = curTenant();
  q.run(`UPDATE activities
    SET status = '已结束'
    WHERE tenant_id = ?
      AND date(date) < date('now','localtime')
      AND status IN ('策划中','筹备中','报名中','进行中')`, T);
  q.run(`UPDATE activities
    SET status = '进行中'
    WHERE tenant_id = ?
      AND date(date) = date('now','localtime')
      AND status IN ('策划中','筹备中','报名中')`, T);
}

async function buildActivityPlan(act, { goal = '提升到店体验与成交', audience = '已授权触达的目标顾客', budget = '待确认' }, role) {
  // 前台同步生成必须有明确期限；上游异常时快速转热度召回和本地模板。
  const activityType = normalizeActivityType(act.type);
  const baseline = configuredActivityBaseline();
  const baselineRule = Object.keys(baseline).length
    ? `本企业已配置活动基准：${JSON.stringify(baseline)}。仅可将这些企业配置值用于目标参照。`
    : '本企业尚未配置活动转化基准；KPI目标必须标记待负责人确认，不得套用行业均值。';
  const kb = await kbContext(
    ['品牌资料', '客户画像', '产品资料', '话术案例'],
    role,
    `${act.title} ${goal} ${audience}`,
    { embedTimeoutMs: ACTIVITY_EMBED_TIMEOUT_MS },
  );
  const out = await generate({
    kind: 'activity-plan',
    responseSchema: ACTIVITY_PLAN_SCHEMA, // AI-C3：模型层 json_schema 约束，替代"提示词求 JSON + 裸 parse"
    system: `你是餐饮门店活动策划助手。输出结构化策划案JSON：{theme,flow:[{time,item}],materials:[],invites,sop:[],kpi:{},budgetNote}。方案必须覆盖真实场地容量、菜单与食材准备、食安/过敏原提示、人员分工、顾客联系授权、预算和复盘数据。${baselineRule} 不得编造活动名额、价格、优惠、顾客证言或转化结果；所有对外承诺和高风险事项必须标记负责人审批。方案必须能直接编辑、保存、审批和执行。知识库：${kb}`,
    role,
    userMsg: `活动：${act.title}（${activityType}），日期${act.date || '待定'}，目标人数${act.target_join || '待确认'}，活动目标：${goal}，目标人群：${audience}，预算：${budget}。只输出JSON。`,
    fallback: () => tplActivityPlan({ title: act.title, type: activityType, goal, audience, budget, date: act.date || '' }),
    timeoutMs: ACTIVITY_CHAT_TIMEOUT_MS,
  });
  let plan;
  try { plan = JSON.parse(out.text.replace(/^```json?\s*|```\s*$/g, '')); }
  catch { plan = JSON.parse(tplActivityPlan({ title: act.title, type: activityType, goal, audience, budget, date: act.date || '' })); }
  return { plan: normalizeActivityPlan(plan, act.title), out };
}

r.get('/stats', (req, res) => {
  syncActivityStatuses();
  const m = monthStart();
  const scope = userScopeClause(req.user, 'owner_id');
  const month = q.get(`SELECT COUNT(*) n FROM activities WHERE tenant_id = ${curTenant()} AND date >= ?${scope.sql}`, m, ...scope.params)?.n || 0;
  const agg = q.get(`SELECT SUM(signed_up) signed, SUM(arrived) arrived, SUM(converted) conv, SUM(revenue) revenue,
    AVG(CASE WHEN satisfaction > 0 THEN satisfaction END) sat
    FROM activities WHERE tenant_id = ${curTenant()} AND date >= date('now','-90 day')${scope.sql}`, ...scope.params) || {};
  res.json({
    monthCount: month, signedUp: agg.signed || 0,
    arriveRate: pct(agg.arrived || 0, agg.signed || 0),
    revenue: agg.revenue || 0,
    convRate: pct(agg.conv || 0, agg.arrived || 0),
    satisfaction: Math.round((agg.sat || 0) * 10) / 10,
    baseline: configuredActivityBaseline(),
  });
});

// 顶部统计卡钻取：近90天逐场活动明细（kind 决定前端排序/高亮口径）
r.get('/stats-drill', (req, res) => {
  syncActivityStatuses();
  const base = configuredActivityBaseline();
  const scope = userScopeClause(req.user, 'a.owner_id');
  const rows = q.all(`SELECT a.id, a.title, a.type, a.status, a.date, a.target_join, a.target_deal,
      a.invited, a.signed_up, a.arrived, a.converted, a.revenue, a.cost, a.satisfaction, u.name owner
    FROM activities a LEFT JOIN users u ON u.id = a.owner_id
    WHERE a.tenant_id = ${curTenant()} AND a.date >= date('now','-90 day')${scope.sql} ORDER BY a.date DESC`, ...scope.params).map(x => ({
    ...x,
    arriveRate: pct(x.arrived, x.signed_up),
    convRate: pct(x.converted, x.arrived),
    roi: x.cost > 0 ? Math.round((x.revenue || 0) / x.cost * 10) / 10 : null,
  }));
  res.json({ rows, baseline: base, range: '近90天' });
});

r.get('/', (req, res) => {
  syncActivityStatuses();
  const { status, month } = req.query;
  let where = `WHERE a.tenant_id = ${curTenant()}`; const params = [];
  const scope = userScopeClause(req.user, 'a.owner_id');
  where += scope.sql; params.push(...scope.params);
  if (status) { where += ' AND status = ?'; params.push(status); }
  if (month) { where += ` AND strftime('%Y-%m', date) = ?`; params.push(month); }
  const rows = q.all(`SELECT a.*, u.name owner FROM activities a LEFT JOIN users u ON u.id = a.owner_id ${where} ORDER BY a.date DESC`, ...params);
  res.json(rows.map(x => ({
    ...x,
    checklist: safeChecklist(x.checklist),
    plan: x.plan ? normalizeActivityPlan(parseMaybeJson(x.plan, {}), x.title) : null,
    review: parseMaybeJson(x.review, null),
  })));
});

r.post('/', (req, res) => {
  try {
    const b = normalizedActivityInput(req.body, { creating: true });
    const result = immediateTransaction(() => {
      const inserted = q.run(`INSERT INTO activities(title,type,status,date,location,target_join,target_deal,budget,owner_id,checklist)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, b.title, b.type || DEFAULT_ACTIVITY_TYPE, '策划中', b.date, b.location || '待确认',
      b.target_join ?? 12, b.target_deal ?? 0, b.budget ?? 0, req.user.id,
      JSON.stringify([{ item: '场地与接待容量确认', done: false }, { item: '菜单、食材与餐具准备', done: false }, { item: '食安与过敏原提示确认', done: false }, { item: '授权邀约名单确认', done: false }, { item: '人员分工与服务流程演练', done: false }]));
      logOp(req.user, '活动中心', '创建活动', b.title);
      return inserted;
    });
    res.json({ id: result.lastInsertRowid });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// 飞书日历对接信息（FR-ACT-07）：订阅地址 / ICS下载 / 直写状态
r.get('/calendar-sync', (req, res) => {
  if (!isManagerLike(req.user)) return res.status(403).json({ error: '只有老板或管理层可以查看企业日历订阅地址' });
  const token = icsToken();
  const base = `${req.protocol}://${req.get('host')}`;
  const cfg = feishuConfig();
  const scope = userScopeClause(req.user, 'owner_id');
  res.json({
    icsUrl: `${base}/api/public/calendar.ics?key=${token}`,
    appMode: appReady(),
    autoSyncReady: !!(cfg.enabled && appReady()),
    appBotReady: appBotReady(),
    managers: feishuManagerSummary(),
    eventCount: q.get(`SELECT COUNT(*) n FROM activities WHERE tenant_id = ${curTenant()} AND date >= date('now','-30 day') AND plan_status='已通过'${scope.sql}`, ...scope.params)?.n || 0,
  });
});

r.get('/assignees', (req, res) => {
  if (!isManagerLike(req.user)) return res.status(403).json({ error: '只有老板、运营总监或管理员可以分配活动工作' });
  const scope = userScopeClause(req.user, 'id');
  const users = q.all(`SELECT id,name,role,dept,status FROM users
    WHERE tenant_id=? AND status='启用' AND role!='platform_super'${scope.sql}
    ORDER BY CASE role WHEN 'boss' THEN 1 WHEN 'ops_director' THEN 2 WHEN 'admin' THEN 3 WHEN 'sales' THEN 4 ELSE 5 END,name`,
  curTenant(), ...scope.params);
  res.json(users.map(user => ({
    ...user,
    feishuBound: !!feishuUserRecipient(user.id, curTenant()),
  })));
});

r.get('/:id/assignments', (req, res) => {
  const act = ensureActivityAccess(req, res, req.params.id);
  if (!act) return;
  const scope = userScopeClause(req.user, 't.assignee_id');
  const rows = q.all(`SELECT t.id,t.title,t.detail,t.type,t.status,t.priority,t.assignee_id,t.due_at,t.source,
      t.activity_id,t.activity_plan_item,t.assigned_by,t.feishu_notified,t.created_at,u.name assignee
    FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
    WHERE t.tenant_id=? AND t.activity_id=?${scope.sql}
    ORDER BY t.created_at,t.id`, curTenant(), act.id, ...scope.params);
  res.json(rows);
});

r.post('/:id/assignments', (req, res) => {
  const act = ensureActivityAccess(req, res, req.params.id);
  if (!act) return;
  if (!isManagerLike(req.user)) return res.status(403).json({ error: '只有老板、运营总监或管理员可以分配活动工作' });
  if (!parseMaybeJson(act.plan, null)) return res.status(400).json({ error: '请先生成并保存活动策划案，再进行工作分配' });
  const input = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
  if (!input.length || input.length > 30) return res.status(400).json({ error: '请提交1至30项工作分配' });

  const priorities = new Set(['低', '中', '高', '紧急']);
  let normalized;
  try {
    normalized = input.map((item, index) => {
      const title = String(item?.title || '').trim().slice(0, 100);
      const detail = String(item?.detail || '').trim().slice(0, 4000);
      const assigneeId = Number(item?.assigneeId);
      const rawDueAt = String(item?.dueAt || (act.date ? `${act.date} 18:00:00` : '')).trim();
      const dueAt = normalizedDateTime(rawDueAt);
      const rawKey = String(item?.key || `item-${index + 1}-${title}`).trim();
      const key = rawKey.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 80) || `item-${index + 1}`;
      if (!title) throw Object.assign(new Error(`第${index + 1}项任务缺少名称`), { status: 400 });
      if (!Number.isInteger(assigneeId) || !accessibleUserExists(req.user, assigneeId)) {
        throw Object.assign(new Error(`第${index + 1}项负责人不存在或不在你的管理范围内`), { status: 400 });
      }
      if (!dueAt) throw Object.assign(new Error(`第${index + 1}项截止时间格式不正确`), { status: 400 });
      return { key, title, detail, assigneeId, dueAt, priority: priorities.has(item?.priority) ? item.priority : '中' };
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  if (new Set(normalized.map(item => item.key)).size !== normalized.length) {
    return res.status(400).json({ error: '工作分配中存在重复任务标识，请删除重复项后重试' });
  }

  const changed = [];
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const item of normalized) {
      const old = q.get(`SELECT id,title,detail,status,priority,assignee_id,due_at FROM tasks
        WHERE tenant_id=? AND activity_id=? AND activity_plan_item=?`, curTenant(), act.id, item.key);
      if (old?.status === '已完成') throw Object.assign(new Error(`任务“${old.title}”已完成，不能从活动策划中覆盖`), { status: 409 });
      const hasChanged = !old || old.title !== item.title || String(old.detail || '') !== item.detail
        || old.priority !== item.priority || Number(old.assignee_id) !== item.assigneeId || String(old.due_at || '') !== item.dueAt;
      let taskId = old?.id;
      if (old) {
        if (hasChanged) q.run(`UPDATE tasks SET title=?,detail=?,type='活动',priority=?,assignee_id=?,due_at=?,source='活动策划',assigned_by=?,feishu_notified=0
          WHERE tenant_id=? AND id=?`, item.title, item.detail, item.priority, item.assigneeId, item.dueAt, req.user.id, curTenant(), old.id);
      } else {
        const out = q.run(`INSERT INTO tasks(title,detail,type,status,priority,assignee_id,due_at,source,risk,activity_id,activity_plan_item,assigned_by,feishu_notified)
          VALUES(?,?,?,'待执行',?,?,?,?,0,?,?,?,0)`, item.title, item.detail, '活动', item.priority, item.assigneeId, item.dueAt,
        '活动策划', act.id, item.key, req.user.id);
        taskId = out.lastInsertRowid;
      }
      if (hasChanged) {
        notify(item.assigneeId, 'task', `活动任务：${item.title}`, `${act.title}｜截止 ${item.dueAt}｜分配人 ${req.user.name}`);
        changed.push({ ...item, taskId, action: old ? 'updated' : 'created' });
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    return res.status(e.status || 500).json({ error: e.message });
  }

  const rows = q.all(`SELECT t.id,t.title,t.detail,t.status,t.priority,t.assignee_id,t.due_at,t.activity_plan_item,
      t.feishu_notified,u.name assignee FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
    WHERE t.tenant_id=? AND t.activity_id=? ORDER BY t.created_at,t.id`, curTenant(), act.id);
  const tid = curTenant();
  const appLink = appUrl(req, '/execution');
  const feishuJobs = changed.filter(item => feishuUserRecipient(item.assigneeId, tid));
  if (changed.length) logOp(req.user, '活动中心', '分配活动工作', `${act.title}：${changed.length}项`);
  setImmediate(async () => {
    for (const item of feishuJobs) {
      try {
        const out = await pushFeishuToUser({
          title: `新活动任务 · ${item.title}`,
          lines: [
            `活动：**${act.title}**`,
            `负责人：${q.get('SELECT name FROM users WHERE tenant_id=? AND id=?', tid, item.assigneeId)?.name || '-'}`,
            `截止时间：${item.dueAt}`,
            `优先级：${item.priority}`,
            item.detail ? `执行要求：${item.detail.slice(0, 800)}` : '执行要求：按活动策划完成并回传结果',
          ],
          url: appLink,
        }, item.assigneeId, tid);
        if (out?.ok) {
          q.run(`UPDATE tasks SET feishu_notified=1
            WHERE tenant_id=? AND id=? AND assignee_id=? AND feishu_notified=0`, tid, item.taskId, item.assigneeId);
        }
      } catch {
        // 任务已提交后，飞书不可用不应导致进程异常；保留未通知状态供重试。
      }
    }
  });
  res.json({
    ok: true,
    created: changed.filter(x => x.action === 'created').length,
    updated: changed.filter(x => x.action === 'updated').length,
    unchanged: normalized.length - changed.length,
    feishuQueued: feishuJobs.length,
    tasks: rows,
  });
});

r.put('/:id', (req, res) => {
  if (!ensureActivityAccess(req, res, req.params.id)) return;
  try {
    const patch = normalizedActivityInput(req.body);
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'checklist')) {
      if (!Array.isArray(req.body.checklist) || req.body.checklist.length > 100) {
        return res.status(400).json({ error: '活动检查表必须是最多100项的列表' });
      }
      const encoded = JSON.stringify(req.body.checklist);
      if (encoded.length > 100_000) return res.status(400).json({ error: '活动检查表内容过长' });
      patch.checklist = encoded;
    }
    const entries = Object.entries(patch);
    if (entries.length) {
      immediateTransaction(() => {
        q.run(`UPDATE activities SET ${entries.map(([field]) => `${field}=?`).join(',')} WHERE tenant_id=? AND id=?`,
          ...entries.map(([, value]) => value), curTenant(), req.params.id);
      });
    }
    const updated = q.get(`SELECT * FROM activities WHERE tenant_id = ${curTenant()} AND id = ?`, req.params.id);
    res.json({
      ...updated,
      checklist: safeChecklist(updated.checklist),
      plan: updated.plan ? normalizeActivityPlan(parseMaybeJson(updated.plan, {}), updated.title) : null,
      review: parseMaybeJson(updated.review, null),
    });
    const fbTid = curTenant();
    const fbActor = { id: req.user.id, name: req.user.name, role: req.user.role };
    if (entries.length && updated.plan_status === '已通过') {
      setImmediate(() => syncActivityLifecycleToFeishu(updated, {
        tid: fbTid,
        actor: fbActor,
        action: patch.status ? 'status' : 'updated',
        url: appUrl(req),
      }).catch(() => {}));
    }
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

r.delete('/:id', (req, res) => {
  const act = ensureActivityAccess(req, res, req.params.id);
  if (!act) return;
  const policy = activityDeletePolicy(req, act);
  if (!policy.allowed) return deletionDenied(res, policy.requiredRole, policy.reason);
  const reviewKbDocs = tableRows('kb_docs', 'title=?', `活动复盘：${act.title}`);
  const kbIds = reviewKbDocs.map(x => x.id);
  const kbAssets = kbIds.length ? q.all(`SELECT * FROM biz_assets WHERE tenant_id=? AND source_type='kb' AND source_id IN (${kbIds.map(() => '?').join(',')})`, curTenant(), ...kbIds) : [];
  const assetIds = kbAssets.map(x => x.id);
  const children = {
    activity_invites: tableRows('activity_invites', 'activity_id=?', act.id),
    approvals: q.all(`SELECT * FROM approvals WHERE tenant_id=? AND target_type IN ('activity_plan','activity_checklist') AND target_id=?`, curTenant(), act.id),
    kb_docs: reviewKbDocs,
    biz_assets: kbAssets,
    asset_flows: assetIds.length ? q.all(`SELECT * FROM asset_flows WHERE tenant_id=? AND asset_id IN (${assetIds.map(() => '?').join(',')})`, curTenant(), ...assetIds) : [],
  };
  const archiveId = archiveAndDelete(req, {
    entityType: 'activity',
    entityId: act.id,
    table: 'activities',
    row: act,
    children,
    module: '活动中心',
    title: act.title,
    summary: `${act.type || '-'}；状态=${act.status || '-'}；邀约${policy.inviteCount}条；审批${policy.approvalCount}条`,
    requiredRole: policy.requiredRole,
    reason: req.body?.reason || policy.reason,
  }, () => {
    q.run(`UPDATE activity_plan_drafts SET activity_id=NULL,status='草稿',updated_at=datetime('now','localtime')
      WHERE tenant_id=? AND activity_id=?`, curTenant(), act.id);
    deleteList('activity_invites', 'activity_id=?', act.id);
    q.run(`DELETE FROM approvals WHERE tenant_id=? AND target_type IN ('activity_plan','activity_checklist') AND target_id=?`, curTenant(), act.id);
    if (assetIds.length) {
      q.run(`DELETE FROM asset_flows WHERE tenant_id=? AND asset_id IN (${assetIds.map(() => '?').join(',')})`, curTenant(), ...assetIds);
      q.run(`DELETE FROM biz_assets WHERE tenant_id=? AND id IN (${assetIds.map(() => '?').join(',')})`, curTenant(), ...assetIds);
    }
    if (kbIds.length) {
      q.run(`DELETE FROM kb_chunks WHERE doc_id IN (SELECT id FROM kb_docs WHERE tenant_id=? AND id IN (${kbIds.map(() => '?').join(',')}))`, curTenant(), ...kbIds); // 先清块向量防孤儿
      q.run(`DELETE FROM kb_docs WHERE tenant_id=? AND id IN (${kbIds.map(() => '?').join(',')})`, curTenant(), ...kbIds);
    }
    deleteList('activities', 'id=?', act.id);
  });
  logOp(req.user, '活动中心', '删除活动入回收站', `${act.title} / archive#${archiveId}`);
  res.json({ ok: true, archiveId, message: '已删除并进入回收站，老板/管理员可恢复' });
});

r.post('/:id/checklist/:idx/submit', (req, res) => {
  const act = ensureActivityAccess(req, res, req.params.id);
  if (!act) return;
  const idx = Number(req.params.idx);
  const checklist = safeChecklist(act.checklist);
  if (!Number.isInteger(idx) || idx < 0 || idx >= checklist.length) return res.status(400).json({ error: '待确认事项不存在' });
  const item = { ...checklist[idx] };
  const label = checklistItemLabel(item, idx);
  if (item.done) return res.status(400).json({ error: '该事项已完成，无需重复提交' });
  if ([CHECK_PENDING, CHECK_BOSS].includes(item.approvalStatus)) return res.status(400).json({ error: '该事项已在审批中，请等待处理' });

  item.done = false;
  item.approvalStatus = CHECK_PENDING;
  item.submittedBy = { id: req.user.id, name: req.user.name, role: req.user.role };
  item.submittedAt = new Date().toISOString();
  checklist[idx] = item;

  const payload = { activityId: act.id, checklistIndex: idx, item: label, submittedBy: item.submittedBy };
  let result;
  try {
    result = immediateTransaction(() => {
      const inserted = q.run(`INSERT INTO approvals(target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,payload,approval_level)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,
      'activity_checklist', act.id, `待确认事项审批：${act.title} / ${label}`,
      `活动：${act.title}；事项：${label}；提交人：${req.user.name}；流程：运营总监初审 → 老板终审 → 自动同步管理层`,
      'medium', JSON.stringify(['ACTIVITY_CHECKLIST_CONFIRM']), '待审核', req.user.id, JSON.stringify(payload), 'ops_director');
      item.approvalId = inserted.lastInsertRowid;
      checklist[idx] = item;
      q.run('UPDATE activities SET checklist = ? WHERE tenant_id=? AND id = ?', JSON.stringify(checklist), curTenant(), act.id);
      notifyManagers('活动审批', `待确认事项待初审：${act.title}`, `${req.user.name} 提交「${label}」完成确认，需运营总监初审后转老板终审。`, ['ops_director', 'admin', 'boss']);
      logOp(req.user, '活动中心', '提交待确认事项审批', `${act.title} / ${label}`);
      return inserted;
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
  const fbTid = curTenant();
  setImmediate(() => pushFeishuToManagers({
    title: '待确认事项待审批',
    lines: [
      `**${act.title}**`,
      `事项：${label}`,
      `提交人：${req.user.name}`,
      '流程：运营总监初审 → 老板终审 → 通过后自动同步给管理层',
    ],
    url: appUrl(req, '/system'),
  }, fbTid).catch(() => {}));
  res.json({ ok: true, approvalId: result.lastInsertRowid, checklist, message: '已提交审批，终审通过后会自动标记完成并同步管理层' });
});

// AI 活动策划（FR-ACT-02）
r.post('/:id/plan', async (req, res) => {
  try {
  const act = ensureActivityAccess(req, res, req.params.id);
  if (!act) return;
  precheckByRole(req.user.id, 'text', req.user.role);
  const { goal = '提升到店与服务转化', audience = '已授权触达的目标顾客', budget = '待确认' } = req.body || {};
  const { plan, out } = await buildActivityPlan(act, { goal, audience, budget }, req.user.role);
  const draftBill = immediateTransaction(() => {
    const billing = charge({ userId: req.user.id, feature: '活动中心·AI策划', kind: 'text', model: out.model, usage: out.usage,
      aiMode: out.mode, manageTransaction: false });
    savePlan(act.id, plan, PLAN_DRAFT);
    logOp(req.user, '活动中心', 'AI策划草稿', act.title);
    return billing;
  });
  return res.json({ plan, mode: out.mode, billing: draftBill, planStatus: PLAN_DRAFT });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// 独立AI活动策划室：不要求先建活动，生成结果持久化，刷新/跳转后仍可找回。
r.get('/plan-drafts/list', (req, res) => {
  const scope = userScopeClause(req.user, 'd.user_id');
  res.json(q.all(`SELECT d.id,d.user_id,d.activity_id,d.title,d.type,d.date,d.goal,d.audience,d.budget,d.target_join,d.status,d.created_at,d.updated_at,u.name owner_name
    FROM activity_plan_drafts d LEFT JOIN users u ON u.id=d.user_id
    WHERE d.tenant_id=?${scope.sql} ORDER BY d.updated_at DESC,d.id DESC LIMIT 50`, curTenant(), ...scope.params));
});

r.get('/plan-drafts/:draftId', (req, res) => {
  const row = planDraftForUser(req.params.draftId, req.user);
  if (!row) return res.status(404).json({ error: '策划草稿不存在' });
  res.json({ ...row, plan: normalizeActivityPlan(parseMaybeJson(row.plan, {}), row.title) });
});

r.post('/plan-drafts/generate', async (req, res) => {
  try {
    const { title, type = DEFAULT_ACTIVITY_TYPE, date, targetJoin = 12, goal = '提升到店体验与成交', audience = '已授权触达的目标顾客', budget = '待确认' } = req.body || {};
    const normalizedTitle = String(title || '').trim();
    if (!normalizedTitle) return res.status(400).json({ error: '请填写活动主题' });
    if (normalizedTitle.length > 80) return res.status(400).json({ error: '活动主题不能超过80字' });
    const targetCount = validTargetJoin(targetJoin);
    if (!targetCount) return res.status(400).json({ error: '目标人数必须是1到100万之间的整数' });
    const normalizedDate = date ? normalizedDateTime(date) : null;
    if (date && (!normalizedDate || normalizedDate.includes(' '))) return res.status(400).json({ error: '活动日期格式不正确' });
    precheckByRole(req.user.id, 'text', req.user.role);
    const act = { title: normalizedTitle, type: normalizeActivityType(type).slice(0, 40), date: normalizedDate || '', target_join: targetCount };
    const { plan, out } = await buildActivityPlan(act, { goal, audience, budget }, req.user.role);
    const normalized = normalizeActivityPlan(plan, act.title);
    const { draft, bill } = immediateTransaction(() => {
      const billing = charge({ userId: req.user.id, feature: '活动策划室·AI策划', kind: 'text', model: out.model, usage: out.usage,
        aiMode: out.mode, manageTransaction: false });
      const inserted = q.run(`INSERT INTO activity_plan_drafts(user_id,title,type,date,goal,audience,budget,target_join,plan,status) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        req.user.id, act.title, act.type, normalizedDate, String(goal).slice(0, 100), String(audience).slice(0, 200), String(budget).slice(0, 100), targetCount, JSON.stringify(normalized), '草稿');
      logOp(req.user, '活动中心', '独立生成活动策划', act.title);
      return { draft: inserted, bill: billing };
    });
    res.json({ draftId: draft.lastInsertRowid, plan: normalized, mode: out.mode, billing: bill, status: '草稿' });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

r.put('/plan-drafts/:draftId', (req, res) => {
  const row = planDraftForUser(req.params.draftId, req.user);
  if (!row) return res.status(404).json({ error: '策划草稿不存在或无权修改' });
  const plan = req.body?.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return res.status(400).json({ error: '策划内容不能为空' });
  const targetCount = req.body?.targetJoin === undefined ? Number(row.target_join || 12) : validTargetJoin(req.body.targetJoin);
  if (!targetCount) return res.status(400).json({ error: '目标人数必须是1到100万之间的整数' });
  q.run(`UPDATE activity_plan_drafts SET plan=?,target_join=?,updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?`,
    JSON.stringify(normalizeActivityPlan(plan, row.title)), targetCount, curTenant(), row.id);
  res.json({ ok: true });
});

r.post('/plan-drafts/:draftId/create-activity', (req, res) => {
  let draft = planDraftForUser(req.params.draftId, req.user);
  if (!draft) return res.status(404).json({ error: '策划草稿不存在或无权操作' });
  if (draft.activity_id) {
    const linkedActivity = q.get(`SELECT id FROM activities WHERE tenant_id=? AND id=?`, curTenant(), draft.activity_id);
    if (linkedActivity) return res.json({ ok: true, activityId: linkedActivity.id, alreadyCreated: true });
    q.run(`UPDATE activity_plan_drafts SET activity_id=NULL,status='草稿',updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?`,
      curTenant(), draft.id);
    draft = { ...draft, activity_id: null, status: '草稿' };
  }
  const date = normalizedDateTime(req.body?.date || draft.date);
  if (!date) return res.status(400).json({ error: '保存为活动前请补充活动日期' });
  if (date.includes(' ')) return res.status(400).json({ error: '活动日期格式不正确' });
  const targetCount = req.body?.targetJoin === undefined ? validTargetJoin(draft.target_join || 12) : validTargetJoin(req.body.targetJoin);
  if (!targetCount) return res.status(400).json({ error: '目标人数必须是1到100万之间的整数' });
  const normalized = normalizeActivityPlan(parseMaybeJson(draft.plan, {}), draft.title);
  const budgetAmount = Number(req.body?.budgetAmount || 0);
  if (!Number.isFinite(budgetAmount) || budgetAmount < 0 || budgetAmount > 1_000_000_000_000) return res.status(400).json({ error: '活动预算格式不正确' });
  let activityId;
  try {
    db.exec('BEGIN IMMEDIATE');
    const fresh = q.get(`SELECT activity_id FROM activity_plan_drafts WHERE tenant_id=? AND id=?`, curTenant(), draft.id);
    if (fresh?.activity_id) {
      db.exec('COMMIT');
      return res.json({ ok: true, activityId: fresh.activity_id, alreadyCreated: true });
    }
    const out = q.run(`INSERT INTO activities(title,type,status,date,location,target_join,target_deal,budget,owner_id,checklist,plan,plan_status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, draft.title, normalizeActivityType(draft.type), '策划中', date, String(req.body?.location || '待确认').slice(0, 200), targetCount,
      0, budgetAmount, draft.user_id,
      JSON.stringify([{ item: '场地与接待容量确认', done: false }, { item: '菜单、食材与餐具准备', done: false }, { item: '食安与过敏原提示确认', done: false }, { item: '授权邀约名单确认', done: false }, { item: '人员分工与服务流程演练', done: false }]),
      JSON.stringify(normalized), PLAN_DRAFT);
    activityId = out.lastInsertRowid;
    q.run(`UPDATE activity_plan_drafts SET activity_id=?,status='已转活动',target_join=?,updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?`,
      activityId, targetCount, curTenant(), draft.id);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw error;
  }
  logOp(req.user, '活动中心', '策划草稿转活动', draft.title);
  res.json({ ok: true, activityId });
});

r.put('/:id/plan/draft', (req, res) => {
  const act = ensureActivityAccess(req, res, req.params.id);
  if (!act) return;
  const plan = req.body?.plan;
  if (!plan || typeof plan !== 'object') return res.status(400).json({ error: '请先填写活动策划案' });
  savePlan(act.id, plan, PLAN_DRAFT);
  logOp(req.user, '活动中心', '保存活动策划草稿', act.title);
  res.json({ ok: true, planStatus: PLAN_DRAFT });
});

r.post('/:id/plan/submit', (req, res) => {
  const act = ensureActivityAccess(req, res, req.params.id);
  if (!act) return;
  const rawPlan = req.body?.plan || parseMaybeJson(act.plan, null);
  if (!rawPlan || typeof rawPlan !== 'object') return res.status(400).json({ error: '请先生成或填写活动策划案' });
  const plan = normalizeActivityPlan(rawPlan, act.title);
  const payload = { activityId: act.id, plan, submittedBy: { id: req.user.id, name: req.user.name, role: req.user.role } };
  let result;
  try {
    result = immediateTransaction(() => {
      const pending = q.get(`SELECT id FROM approvals WHERE tenant_id=${curTenant()} AND target_type='activity_plan' AND target_id=? AND status='待审核' ORDER BY id DESC LIMIT 1`, act.id);
      if (pending) throw Object.assign(new Error('该活动已有待审批策划案，请先处理当前审批'), { status: 400 });
      savePlan(act.id, plan, PLAN_PENDING);
      const inserted = q.run(`INSERT INTO approvals(target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,payload,approval_level)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,
      'activity_plan', act.id, `活动策划审批：${act.title}`,
      `活动日期：${act.date || '-'}；预算：${act.budget || 0}；${planSummary(plan)}`,
      'medium', JSON.stringify(['ACTIVITY_PLAN_APPROVAL']), '待审核', req.user.id, JSON.stringify(payload), 'ops_director');
      q.run(`UPDATE activities SET plan_status=?, plan_submitted_at=datetime('now','localtime'), plan_approval_id=? WHERE tenant_id=? AND id=?`,
        PLAN_PENDING, inserted.lastInsertRowid, curTenant(), act.id);
      notifyManagers('活动审批', `活动策划待运营总监初审：${act.title}`, `${req.user.name} 已提交策划案：${planSummary(plan)}`, ['ops_director', 'admin', 'boss']);
      logOp(req.user, '活动中心', '提交活动策划审批', act.title);
      return inserted;
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
  const fbTid = curTenant();
  setImmediate(() => pushFeishuToManagers({
    title: '活动策划待审批',
    lines: [
      `**${act.title}**`,
      `提交人：${req.user.name}`,
      `日期：${act.date || '-'} ｜ 地点：${act.location || '-'}`,
      '审批流程：运营总监初审 → 老板终审 → 自动同步飞书日历',
      `方案摘要：${planSummary(plan)}`,
    ],
    url: appUrl(req, '/system'),
  }, fbTid).catch(() => {}));
  res.json({ ok: true, approvalId: result.lastInsertRowid, planStatus: PLAN_PENDING, message: '已提交审批：运营总监初审通过后进入老板终审，通过后自动同步飞书日历' });
});

// 邀约名单（FR-ACT-03）：从CRM按规则圈选
r.get('/:id/invite-candidates', (req, res) => {
  const act = ensureActivityAccess(req, res, req.params.id);
  if (!act) return;
  res.json(smartInviteSelection(req, act, req.query.limit).report);
});
r.get('/:id/invites', (req, res) => {
  const act = ensureActivityAccess(req, res, req.params.id);
  if (!act) return;
  const leadScope = userScopeClause(req.user, 'l.owner_id');
  const rows = q.all(`SELECT i.id, i.status, i.note, l.id lead_id, l.name, l.grade, l.score, l.stage, l.interest
    FROM activity_invites i JOIN leads l ON l.id = i.lead_id WHERE i.tenant_id = ${curTenant()} AND i.activity_id = ?${leadScope.sql} ORDER BY l.score DESC`, req.params.id, ...leadScope.params);
  res.json(rows);
});
r.post('/:id/invites', (req, res) => {
  // 守卫1：活动须属本企业，杜绝把邀约塞进别家活动
  const act = ensureActivityAccess(req, res, req.params.id);
  if (!act) return;
  const { leadIds, autoSelect, selectionMode } = req.body || {};
  if (autoSelect !== undefined) {
    return res.status(400).json({ error: '智能圈选需先预览规则与排除原因，再由负责人明确提交复核后的 leadIds' });
  }
  if (leadIds !== undefined && !Array.isArray(leadIds)) {
    return res.status(400).json({ error: 'leadIds 必须是客户编号列表' });
  }
  const normalizedIds = [...new Set((leadIds || []).map(Number))];
  if (normalizedIds.some(id => !Number.isSafeInteger(id) || id <= 0) || normalizedIds.length > 50) {
    return res.status(400).json({ error: '单次最多确认50个有效客户编号' });
  }
  if (selectionMode === 'smart' && normalizedIds.length === 0) {
    return res.status(400).json({ error: '请至少选择一位候选客户后再确认' });
  }
  const leadScope = userScopeClause(req.user, 'owner_id');
  let ids = normalizedIds;
  if (selectionMode === 'smart') {
    const { eligibleIds } = smartInviteSelection(req, act, 50);
    const invalid = ids.filter(id => !eligibleIds.has(id));
    if (invalid.length) {
      return res.status(400).json({ error: '部分候选已变化或不符合当前智能圈选规则，请重新预览后确认' });
    }
  } else if (ids.length) {
    // 守卫2：只允许本企业的客户被邀约（防止用裸 leadId 把别家客户塞进来）
    ids = q.all(`SELECT id FROM leads WHERE tenant_id = ${curTenant()} AND id IN (${ids.map(() => '?').join(',')})${leadScope.sql}`, ...ids, ...leadScope.params).map(x => x.id);
  }
  let added = 0;
  immediateTransaction(() => {
    for (const id of ids) added += Number(q.run('INSERT OR IGNORE INTO activity_invites(activity_id,lead_id) VALUES(?,?)', req.params.id, id).changes || 0);
  });
  res.json({ added, skipped: normalizedIds.length - added });
});
r.put('/invites/:inviteId', (req, res) => {
  // 租户归属守卫前置：先确认该邀约属本企业，再改（原代码先改后查，存在 IDOR）
  const inv = q.get(`SELECT activity_id FROM activity_invites WHERE tenant_id = ${curTenant()} AND id = ?`, req.params.inviteId);
  if (!inv) return res.status(404).json({ error: '邀约不存在' });
  const act = ensureActivityAccess(req, res, inv.activity_id);
  if (!act) return;
  const { status, note } = req.body || {};
  q.run('UPDATE activity_invites SET status = COALESCE(?,status), note = COALESCE(?,note) WHERE id = ?', status, note, req.params.inviteId);
  {
    const agg = q.get(`SELECT
      SUM(CASE WHEN status IN ('已邀约','已报名','已到场','已转化') THEN 1 ELSE 0 END) invited,
      SUM(CASE WHEN status IN ('已报名','已到场','已转化') THEN 1 ELSE 0 END) signed,
      SUM(CASE WHEN status IN ('已到场','已转化') THEN 1 ELSE 0 END) arrived,
      SUM(CASE WHEN status = '已转化' THEN 1 ELSE 0 END) conv
      FROM activity_invites WHERE tenant_id = ${curTenant()} AND activity_id = ?`, inv.activity_id);
    q.run('UPDATE activities SET invited=?, signed_up=?, arrived=?, converted=? WHERE id=?',
      agg.invited, agg.signed, agg.arrived, agg.conv, inv.activity_id);
  }
  res.json({ ok: true });
});

// 批量战果录入（FR-ACT-08）：先完整校验与唯一匹配，再用一个事务回写所有有效行。
r.post('/batch-results', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: '没有可导入的数据行' });
  if (rows.length > 200) return res.status(400).json({ error: '单次最多导入200行战果数据' });
  const FIELDS = ['invited', 'signed_up', 'arrived', 'converted', 'revenue', 'cost', 'satisfaction'];
  const INTEGER_FIELDS = new Set(['invited', 'signed_up', 'arrived', 'converted']);
  const updated = []; const unmatched = []; const invalid = []; const syncedActs = [];
  const pending = []; const seenActivityIds = new Set();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      invalid.push(`第${index + 1}行：数据行格式不正确`);
      continue;
    }
    let act = null;
    const rowId = row.id === undefined || row.id === null || row.id === '' ? null : Number(row.id);
    if (rowId !== null && (!Number.isInteger(rowId) || rowId <= 0)) {
      invalid.push(`第${index + 1}行：活动ID必须是正整数`);
      continue;
    }
    if (rowId) {
      act = q.get(`SELECT id, title, owner_id FROM activities WHERE tenant_id = ${curTenant()} AND id = ?`, rowId);
    } else if (row.title !== undefined && row.title !== null) {
      if (typeof row.title !== 'string' || !row.title.trim()) {
        invalid.push(`第${index + 1}行：活动名称必须是非空文本`);
        continue;
      }
      const title = row.title.trim().slice(0, 200);
      const exactCandidates = q.all(`SELECT id, title, owner_id FROM activities
        WHERE tenant_id = ${curTenant()} AND title = ? ORDER BY date DESC, id DESC LIMIT 2`, title);
      if (exactCandidates.length === 1) {
        act = exactCandidates[0];
      } else if (exactCandidates.length > 1) {
        unmatched.push(`${title}（存在同名活动，请填写活动ID）`);
        continue;
      } else {
        const candidates = q.all(`SELECT id, title, owner_id FROM activities
          WHERE tenant_id = ${curTenant()} AND instr(title, ?) > 0 ORDER BY date DESC, id DESC LIMIT 2`, title);
        if (candidates.length === 1) act = candidates[0];
        else if (candidates.length > 1) {
          unmatched.push(`${title}（匹配到多场，请填写活动ID或完整名称）`);
          continue;
        }
      }
    }
    if (!act || !canAccessOwner(req.user, act.owner_id)) {
      unmatched.push(typeof row.title === 'string' && row.title.trim() ? row.title.trim().slice(0, 200) : `#${row.id || '?'}`);
      continue;
    }
    if (seenActivityIds.has(act.id)) {
      invalid.push(`第${index + 1}行：活动「${act.title}」在本次文件中重复`);
      continue;
    }
    const sets = []; const vals = [];
    let rowError = '';
    for (const f of FIELDS) {
      if (row[f] !== undefined && row[f] !== null && row[f] !== '') {
        const value = Number(typeof row[f] === 'string' ? row[f].trim() : row[f]);
        if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000_000) {
          rowError = `${f}必须是0到1万亿之间的数字`;
          break;
        }
        if (INTEGER_FIELDS.has(f) && !Number.isInteger(value)) {
          rowError = `${f}必须是整数`;
          break;
        }
        if (f === 'satisfaction' && value > 5) {
          rowError = '满意度必须在0到5之间';
          break;
        }
        sets.push(`${f} = ?`); vals.push(value);
      }
    }
    if (rowError) { invalid.push(`第${index + 1}行「${act.title}」：${rowError}`); continue; }
    if (!sets.length) { invalid.push(`第${index + 1}行「${act.title}」：无有效数值列`); continue; }
    seenActivityIds.add(act.id);
    pending.push({ act, sets, vals });
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const item of pending) {
      q.run(`UPDATE activities SET ${item.sets.join(', ')}, status = CASE WHEN status IN ('策划中','筹备中','报名中') THEN '已结束' ELSE status END
        WHERE tenant_id = ? AND id = ?`, ...item.vals, curTenant(), item.act.id);
      updated.push(item.act.title);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    return res.status(500).json({ error: '批量战果写入失败，本次未修改任何数据' });
  }
  for (const item of pending) {
    const fresh = q.get(`SELECT * FROM activities WHERE tenant_id = ${curTenant()} AND id = ?`, item.act.id);
    if (fresh) syncedActs.push(fresh);
  }
  logOp(req.user, '活动中心', '批量战果录入', `成功${updated.length}条/未匹配${unmatched.length}条/校验失败${invalid.length}条`);
  res.json({ updated, unmatched, invalid });
  const fbTid = curTenant();
  const fbActor = { id: req.user.id, name: req.user.name, role: req.user.role };
  setImmediate(() => syncedActs.filter(act => act.plan_status === '已通过').slice(0, 20).forEach(act =>
    syncActivityLifecycleToFeishu(act, { tid: fbTid, actor: fbActor, action: 'result', url: appUrl(req) }).catch(() => {})));
});

// 活动复盘（FR-ACT-05）：企业已配置基准对比 + 当前数据分析部深度复盘
r.post('/:id/review', async (req, res) => {
  const act = ensureActivityAccess(req, res, req.params.id);
  if (!act) return;
  const base = configuredActivityBaseline();
  const rates = {
    inviteSign: pct(act.signed_up, act.invited), signArrive: pct(act.arrived, act.signed_up),
    arriveDeal: pct(act.converted, act.arrived), roi: act.cost > 0 ? Math.round(act.revenue / act.cost * 10) / 10 : null,
  };
  const below = (key, value) => Number.isFinite(base[key]) && Number.isFinite(value) && value < base[key];
  const gaps = [
    below('inviteSign', rates.inviteSign) ? `邀约→报名 ${rates.inviteSign}% 低于企业配置基准 ${base.inviteSign}%：核对目标顾客、联系授权、信息准确性与触达时机` : null,
    below('signArrive', rates.signArrive) ? `报名→到场 ${rates.signArrive}% 低于企业配置基准 ${base.signArrive}%：核对活动时间、地点、菜单和到店确认流程` : null,
    below('arriveDeal', rates.arriveDeal) ? `到场→成交 ${rates.arriveDeal}% 低于企业配置基准 ${base.arriveDeal}%：复盘需求确认、菜单适配、服务体验与报价审批环节` : null,
    below('roi', rates.roi) ? `ROI ${rates.roi} 低于企业配置基准 ${base.roi}：核对真实收入、食材、人员、场地、物料与损耗成本` : null,
  ].filter(Boolean);
  const missingFields = ACTIVITY_BASELINE_FIELDS.filter(([key]) => !Number.isFinite(base[key])).map(([, label]) => label);
  const review = {
    target_vs_actual: { 邀约: act.invited, 报名: act.signed_up, 到场: act.arrived, 成交: act.converted, 收入: act.revenue, 目标人数: act.target_join, 目标成交: act.target_deal },
    rates, baseline: base, baselineStatus: missingFields.length === ACTIVITY_BASELINE_FIELDS.length ? 'unavailable' : missingFields.length ? 'partial' : 'available',
    missingFields, gaps,
    ok: req.body?.ok || ['流程执行完整'], bad: req.body?.bad || gaps.slice(0, 2),
    improvements: gaps.map(g => g.split('：')[1]).filter(Boolean),
    followup: ['按顾客联系授权完成服务回访', '核对订单、履约与顾客反馈', '基于真实收入和成本完成归因复盘'],
  };

  // 当前目录的数据分析部优先为 M-07；能力关键词是目录调整时的兼容兜底。
  let aiText = null, aiMeta = null;
  try {
    precheckByRole(req.user.id, 'text', req.user.role);
    const reviewDivision = mergeMarshal(q.get(`SELECT * FROM marshals
      WHERE online=1 AND (code='M-07' OR name LIKE '%数据分析%' OR duty LIKE '%活动复盘%')
      ORDER BY CASE WHEN code='M-07' THEN 0 ELSE 1 END, sort LIMIT 1`));
    if (!reviewDivision) throw Object.assign(new Error('当前餐饮数字员工目录未配置可用的数据分析部'), { status: 503 });
    const { marshalWork } = await import('../engines/ai.js');
    const baselineSummary = Object.keys(base).length
      ? ACTIVITY_BASELINE_FIELDS.filter(([key]) => Number.isFinite(base[key])).map(([key, label]) => `${label}=${base[key]}`).join('、')
      : '企业未配置活动对照基准，本次不得引用通用行业均值';
    const out = await marshalWork(reviewDivision, {
      title: `活动复盘：${act.title}`,
      type: '活动复盘',
      requirement: `请对这场活动做深度复盘。活动数据：类型${act.type}，日期${act.date}，目标${act.target_join}人/成交${act.target_deal}单；实际：邀约${act.invited}、报名${act.signed_up}、到场${act.arrived}、成交${act.converted}、收入¥${act.revenue || 0}、成本¥${act.cost || 0}、满意度${act.satisfaction || '-'}。
实际指标：邀约→报名 ${rates.inviteSign}%、报名→到场 ${rates.signArrive}%、到场→成交 ${rates.arriveDeal}%、ROI ${rates.roi ?? '因缺少有效成本而不可计算'}。
对照口径：${baselineSummary}。规则诊断已发现的差距：${gaps.join('；') || (Object.keys(base).length ? '已配置指标未发现低于基准项' : '缺少企业基准，暂不判断达标')}。
请按五段式输出：①这场活动的本质结论 ②最大卡点及证据/未知项 ③下一场活动的3条关键改进（每条带检查标准） ④经顾客授权的会后跟进动作清单（负责人+时限） ⑤食安、隐私、价格与履约风险。不得编造优惠、稀缺名额、顾客证言、行业均值或未发生的转化结果。`,
    }, req.user.role);
    const bill = charge({ userId: req.user.id, feature: '活动中心·数据分析复盘', kind: 'text', model: out.model, usage: out.usage, aiMode: out.mode });
    aiText = out.text; aiMeta = { model: out.model, mode: out.mode, billing: bill, marshal: reviewDivision.name, divisionCode: reviewDivision.code };
  } catch (e) { aiMeta = { error: e.message }; }
  review.aiText = aiText; review.aiMeta = aiMeta;
  review.kbSync = syncReviewToKb({ ...act, status: '已复盘' }, review, req.user);

  q.run(`UPDATE activities SET review = ?, status = '已复盘' WHERE id = ?`, JSON.stringify(review), act.id);
  notifyManagers('活动复盘', `活动复盘已入库：${act.title}`, `${req.user.name} 已完成复盘，并沉淀到知识库「${review.kbSync.category}」。`, ['boss', 'ops_director', 'admin']);
  const fbTid = curTenant();
  setImmediate(() => pushFeishuToManagers({
    title: '活动复盘已完成并入库',
    lines: [
      `**${act.title}**`,
      `复盘人：${req.user.name}`,
      `知识库分类：${review.kbSync.category}`,
      `知识库文档：${review.kbSync.title}`,
      `后续跟进：${Array.isArray(review.followup) ? review.followup.join('；') : review.followup}`,
    ],
    url: appUrl(req, '/system'),
  }, fbTid).catch(() => {}));
  logOp(req.user, '活动中心', '数据分析复盘', act.title);
  res.json(review);
});

r.post('/:id/review/sync-kb', (req, res) => {
  const act = ensureActivityAccess(req, res, req.params.id);
  if (!act) return;
  const review = parseMaybeJson(act.review, null);
  if (!review || typeof review !== 'object') return res.status(400).json({ error: '该活动还没有复盘记录，请先生成复盘' });
  review.kbSync = syncReviewToKb({ ...act, status: '已复盘' }, review, req.user);
  q.run(`UPDATE activities SET review = ?, status = '已复盘' WHERE id = ?`, JSON.stringify(review), act.id);
  notifyManagers('活动复盘', `活动复盘已同步知识库：${act.title}`, `${req.user.name} 已将复盘重新沉淀到知识库「${review.kbSync.category}」，可供后续AI调用。`, ['boss', 'ops_director', 'admin']);
  const fbTid = curTenant();
  setImmediate(() => pushFeishuToManagers({
    title: '活动复盘已同步知识库',
    lines: [
      `**${act.title}**`,
      `操作人：${req.user.name}`,
      `知识库分类：${review.kbSync.category}`,
      `知识库文档：${review.kbSync.title}`,
    ],
    url: appUrl(req, '/system'),
  }, fbTid).catch(() => {}));
  logOp(req.user, '活动中心', '复盘同步知识库', act.title);
  res.json({ ok: true, kbSync: review.kbSync, review });
});

export default r;

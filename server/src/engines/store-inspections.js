// ===== 巡店督导归档引擎（#161 巡店督导）=====
// 员工产出末尾的 ```nanowork-inspection JSON 块是唯一归档来源：
// 解析成功才入库；解析失败只记录原因，不伪造巡店数据。
// 统计口径：记录与任务实时状态 JOIN，待审阅/已审阅分开呈现，不把草稿冒充已核验巡店。
import { createRequire } from 'node:module';

import { q } from '../db.js';
import { matchStoreByName } from './store-scope.js';

const require = createRequire(import.meta.url);
// 巡店标准库 1:1 取自派活AI-R7 inspectionstandards（版本化产品数据，非租户数据）。
// mandatory 项不允许关闭或降级；weight/severity 供评分参考，评分仍由督导员工给出。
const RESTAURANT_INSPECTION_STANDARDS = Object.freeze(
  require('../../catalog/inspection-standards-restaurant.json'),
);

export const INSPECTION_EMPLOYEE_IDX = 161;

export function inspectionStandards() {
  return RESTAURANT_INSPECTION_STANDARDS;
}

export function inspectionStandardsVersion() {
  const version = RESTAURANT_INSPECTION_STANDARDS.version || {};
  return `${RESTAURANT_INSPECTION_STANDARDS.catalogVersion}#${String(version.sha256 || '').slice(0, 12)}`;
}

const TIER_LABEL = Object.freeze({
  mandatory: '法定必查·不可关闭',
  recommended: '行业建议',
  operations: '经营优化',
});
const SEVERITY_LABEL = Object.freeze({
  critical: '红线',
  high: '高',
  medium: '中',
  low: '低',
});

// 冻结标准清单文本：派活时注入 #161 提示词，让评分逐项锚定权威标准，
// 而不是只凭手册五板块概述。只下发白名单字段，来源URL保留供引用。
export function inspectionChecklistPromptBlock() {
  const lines = [
    `【本企业巡店标准·冻结快照 ${inspectionStandardsVersion()}（依据国家法规与行业规范，逐项核查）】`,
    ...RESTAURANT_INSPECTION_STANDARDS.items.map((item, index) => {
      const tier = TIER_LABEL[item.tier] || item.tier;
      const severity = SEVERITY_LABEL[item.severity] || item.severity;
      const source = item.source_no ? `依据${item.source_no}` : '';
      return `${index + 1}. [${item.item_code}]（${tier}·严重度${severity}·权重${item.weight}）${item.label}；证据要求：${item.evidence === 'photo' ? '照片' : item.evidence}，拍摄要点：${item.shot_guide}${source ? `；${source}` : ''}`;
    }),
    '检查记录或照片未覆盖的标准项必须明确标注「本次未覆盖」，不得凭空打分；mandatory 项发现问题一律计入高严重度并置顶。',
  ];
  return lines.join('\n');
}
const BLOCK_RE = /```nanowork-inspection\s*\n([\s\S]*?)```/u;
const TYPES = new Set(['例行巡店', '飞行检查', '整改复查']);
const SUB_KEYS = ['foodSafety', 'product', 'service', 'hygiene', 'display'];
// 法定红线问题模式（标准库 mandatory/critical 项的口径投影）：
// 消防疏散、证照失效、食安生熟红线。命中即强制高严重度。
const MANDATORY_RED_LINE_PATTERNS = [
  /疏散通道|安全出口|消防(?:通道|设施|器材|标识)/u,
  /(?:健康证|许可证|营业执照)[^。；]{0,20}(?:过期|失效|缺失|未办|无效)/u,
  /无证(?:上岗|经营)/u,
  /生熟(?:不分|混放|混用)/u,
];

// 解析并校验归档块；返回 { ok, data?, reason? }
export function parseInspectionBlock(text) {
  const match = BLOCK_RE.exec(String(text || ''));
  if (!match) return { ok: false, reason: '产出中没有 nanowork-inspection 归档块' };
  let raw;
  try {
    raw = JSON.parse(match[1]);
  } catch (error) {
    return { ok: false, reason: `归档块不是合法 JSON：${error.message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: '归档块必须是对象' };
  const store = String(raw.store || '').trim();
  if (!store || store.length > 120) return { ok: false, reason: 'store（门店名）缺失或超长' };
  const inspectionType = TYPES.has(raw.inspectionType) ? raw.inspectionType : '例行巡店';
  const score = Number(raw.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) return { ok: false, reason: 'score 必须是 0-100 数字' };
  const subScores = {};
  if (raw.subScores && typeof raw.subScores === 'object' && !Array.isArray(raw.subScores)) {
    for (const key of SUB_KEYS) {
      const value = raw.subScores[key];
      if (value === null || value === undefined) { subScores[key] = null; continue; }
      const n = Number(value);
      subScores[key] = Number.isFinite(n) && n >= 0 && n <= 20 ? n : null;
    }
  }
  const issues = Array.isArray(raw.issues) ? raw.issues.slice(0, 100).map(item => {
    const problem = String(item?.problem || '').slice(0, 500);
    let severity = ['高', '中', '低'].includes(item?.severity) ? item.severity : '中';
    // 确定性红线兜底（对齐派活AI-R7标准库 mandatory/critical 口径）：
    // 模型偶尔会把法定红线问题标成“中”，归档层按规则强制升级并留审计标记，
    // 只升不降，不改写问题事实。
    const mandatoryHit = severity !== '高'
      && MANDATORY_RED_LINE_PATTERNS.some(pattern => pattern.test(problem));
    if (mandatoryHit) severity = '高';
    return {
      board: String(item?.board || '').slice(0, 40),
      severity,
      ...(mandatoryHit ? { severityRaised: 'mandatory_red_line' } : {}),
      problem,
      evidence: String(item?.evidence || '').slice(0, 300),
      action: String(item?.action || '').slice(0, 500),
      deadline: String(item?.deadline || '').slice(0, 60),
    };
  }).filter(item => item.problem) : [];
  const rectified = raw.rectified && typeof raw.rectified === 'object' && !Array.isArray(raw.rectified)
    ? {
        done: Math.max(0, Number(raw.rectified.done) || 0),
        partial: Math.max(0, Number(raw.rectified.partial) || 0),
        pending: Math.max(0, Number(raw.rectified.pending) || 0),
      }
    : null;
  return {
    ok: true,
    data: {
      store,
      inspectionType,
      score: Math.round(score * 10) / 10,
      subScores,
      issues,
      highIssues: issues.filter(item => item.severity === '高').length,
      rectified,
    },
  };
}

// 任务完成时归档（幂等：task_id 唯一）；失败不抛出，返回结果供日志
export function recordInspectionFromTask({ tenantId, taskId, contentId = null, userId = null, userName = '', text }) {
  const parsed = parseInspectionBlock(text);
  if (!parsed.ok) return { recorded: false, reason: parsed.reason };
  const d = parsed.data;
  try {
    // 多门店：巡店结果里的门店名/编码能匹配到本租户门店时记 store_id，匹配不到保留 NULL（不猜）
    const storeId = matchStoreByName(d.store, tenantId);
    q.run(`INSERT INTO store_inspections(
        tenant_id,task_id,content_id,supervisor_user_id,supervisor_name,store_name,inspection_type,
        score,sub_scores_json,issue_count,high_issues,issues_json,rectified_json,standards_version,store_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(task_id) DO NOTHING`,
      tenantId, taskId, contentId, userId, String(userName || '').slice(0, 80), d.store, d.inspectionType,
      d.score, JSON.stringify(d.subScores), d.issues.length, d.highIssues,
      JSON.stringify(d.issues), d.rectified ? JSON.stringify(d.rectified) : null,
      inspectionStandardsVersion(), storeId);
    return { recorded: true, store: d.store, score: d.score, issues: d.issues.length };
  } catch (error) {
    return { recorded: false, reason: `归档写入失败：${error.message}` };
  }
}

// 巡店统计：督导×月、门店×月、明细；scopeSql 由调用方按角色注入（与任务可见性口径一致）
export function inspectionSummary(tenantId, { months = 3, scopeSql = '', scopeParams = [] } = {}) {
  const since = `date('now','localtime','start of month','-${Math.max(0, months - 1)} months')`;
  const base = `FROM store_inspections i JOIN agent_tasks t ON t.id=i.task_id AND t.tenant_id=i.tenant_id
    WHERE i.tenant_id=? AND date(i.created_at) >= ${since}${scopeSql}`;
  const bySupervisor = q.all(`SELECT
      strftime('%Y-%m', i.created_at) month,
      COALESCE(NULLIF(i.supervisor_name,''),'未记录') supervisor,
      COUNT(*) inspections,
      COUNT(DISTINCT i.store_name) stores,
      ROUND(AVG(i.score),1) avgScore,
      SUM(i.issue_count) issues,
      SUM(i.high_issues) highIssues
    ${base} GROUP BY month, supervisor ORDER BY month DESC, inspections DESC`, tenantId, ...scopeParams);
  const byStore = q.all(`SELECT
      i.store_name store,
      COUNT(*) inspections,
      ROUND(AVG(i.score),1) avgScore,
      MIN(i.score) minScore,
      SUM(i.issue_count) issues,
      SUM(i.high_issues) highIssues,
      MAX(i.created_at) lastAt
    ${base} GROUP BY i.store_name ORDER BY avgScore ASC`, tenantId, ...scopeParams);
  const recent = q.all(`SELECT i.id,i.task_id taskId,i.store_name store,i.inspection_type type,
      i.score,i.issue_count issues,i.high_issues highIssues,
      COALESCE(NULLIF(i.supervisor_name,''),'未记录') supervisor,
      t.status taskStatus,i.created_at createdAt
    ${base} ORDER BY i.id DESC LIMIT 20`, tenantId, ...scopeParams);
  const totals = q.get(`SELECT COUNT(*) inspections, COUNT(DISTINCT i.store_name) stores,
      ROUND(AVG(i.score),1) avgScore, SUM(i.high_issues) highIssues
    ${base}`, tenantId, ...scopeParams) || {};
  return { months, bySupervisor, byStore, recent, totals };
}

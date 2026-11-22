// ===== 巡店督导归档引擎（#161 巡店督导）=====
// 员工产出末尾的 ```nanowork-inspection JSON 块是唯一归档来源：
// 解析成功才入库；解析失败只记录原因，不伪造巡店数据。
// 统计口径：记录与任务实时状态 JOIN，待审阅/已审阅分开呈现，不把草稿冒充已核验巡店。
import { createRequire } from 'node:module';

import { db, q } from '../db.js';
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

function safeParseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function formatRectificationRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    inspectionId: Number(row.inspection_id ?? row.inspectionId),
    issueIndex: Number(row.issue_index ?? row.issueIndex),
    storeName: row.store_name ?? row.storeName ?? '',
    storeId: row.store_id != null ? Number(row.store_id) : (row.storeId != null ? Number(row.storeId) : null),
    board: row.board || '',
    severity: row.severity || '中',
    problem: row.problem || '',
    actionPlan: row.action_plan ?? row.actionPlan ?? '',
    assigneeId: row.assignee_id != null ? Number(row.assignee_id) : (row.assigneeId != null ? Number(row.assigneeId) : null),
    assigneeName: row.assignee_name ?? row.assigneeName ?? '',
    taskId: row.task_id != null ? Number(row.task_id) : (row.taskId != null ? Number(row.taskId) : null),
    taskStatus: row.task_status ?? row.taskStatus ?? null,
    status: row.status || 'in_progress',
    dueDate: row.due_date ?? row.dueDate ?? null,
    recheckNote: row.recheck_note ?? row.recheckNote ?? '',
    recheckBy: row.recheck_by ?? row.recheckBy ?? '',
    recheckAt: row.recheck_at ?? row.recheckAt ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
  };
}

function computeRectificationStats(tenantId, inspectionIds, totalIssues) {
  const safeTotal = Math.max(0, Number(totalIssues) || 0);
  const ids = [...new Set((inspectionIds || []).map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (!ids.length) {
    return { totalIssues: safeTotal, created: 0, closed: 0, pending: safeTotal, closedHigh: 0, closureRate: 0 };
  }
  let created = 0;
  let closed = 0;
  let closedHigh = 0;
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const agg = q.get(
      `SELECT
        COUNT(*) created,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) closed,
        SUM(CASE WHEN status = 'closed' AND severity = '高' THEN 1 ELSE 0 END) closedHigh
      FROM store_inspection_rectifications
      WHERE tenant_id = ? AND inspection_id IN (${placeholders})`,
      tenantId,
      ...slice,
    );
    created += Number(agg?.created) || 0;
    closed += Number(agg?.closed) || 0;
    closedHigh += Number(agg?.closedHigh) || 0;
  }
  const pending = Math.max(0, safeTotal - closed);
  const closureRate = safeTotal > 0 ? Math.min(100, Math.round((closed / safeTotal) * 100)) : 0;
  return { totalIssues: safeTotal, created, closed, pending, closedHigh, closureRate };
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
  const scopedRows = q.all(
    `SELECT i.id, i.issue_count issueCount ${base}`,
    tenantId,
    ...scopeParams,
  );
  const totalIssues = scopedRows.reduce((sum, row) => sum + (Number(row.issueCount) || 0), 0);
  const rectAgg = computeRectificationStats(
    tenantId,
    scopedRows.map(row => Number(row.id)),
    totalIssues,
  );
  const rectificationStats = {
    totalIssues: rectAgg.totalIssues,
    created: rectAgg.created,
    closed: rectAgg.closed,
    pending: rectAgg.pending,
    closureRate: rectAgg.closureRate,
  };
  return { months, bySupervisor, byStore, recent, totals, rectificationStats };
}

// 巡店整改闭环列表：返回巡店记录、逐条问题及其关联整改单，以及全量汇总统计
export function listInspectionsWithRectifications(
  tenantId,
  { limit = 30, scopeSql = '', scopeParams = [] } = {},
) {
  const tid = Number(tenantId);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const base = `FROM store_inspections i JOIN agent_tasks t ON t.id=i.task_id AND t.tenant_id=i.tenant_id
    WHERE i.tenant_id=?${scopeSql}`;
  const allScoped = q.all(
    `SELECT i.id, i.issue_count issueCount, i.high_issues highIssues ${base}`,
    tid,
    ...scopeParams,
  );
  const totalInspections = allScoped.length;
  const totalIssues = allScoped.reduce((sum, row) => sum + (Number(row.issueCount) || 0), 0);
  const highIssues = allScoped.reduce((sum, row) => sum + (Number(row.highIssues) || 0), 0);
  const rectAgg = computeRectificationStats(
    tid,
    allScoped.map(row => Number(row.id)),
    totalIssues,
  );

  const rows = q.all(
    `SELECT
      i.id,
      i.task_id taskId,
      i.store_name store,
      i.store_id storeId,
      i.inspection_type type,
      i.score,
      i.sub_scores_json subScoresJson,
      i.issue_count issueCount,
      i.high_issues highIssues,
      i.issues_json issuesJson,
      COALESCE(NULLIF(i.supervisor_name,''),'未记录') supervisor,
      t.status taskStatus,
      i.created_at createdAt
    ${base}
    ORDER BY i.id DESC
    LIMIT ?`,
    tid,
    ...scopeParams,
    safeLimit,
  );

  const rectMap = new Map();
  const rowIds = rows.map(row => Number(row.id)).filter(Boolean);
  if (rowIds.length) {
    const placeholders = rowIds.map(() => '?').join(',');
    const rectRows = q.all(
      `SELECT
        r.id, r.inspection_id, r.issue_index, r.store_name, r.store_id,
        r.board, r.severity, r.problem, r.action_plan,
        r.assignee_id, r.assignee_name, r.task_id, r.status, r.due_date,
        r.recheck_note, r.recheck_by, r.recheck_at, r.created_at, r.updated_at,
        tk.status task_status
      FROM store_inspection_rectifications r
      LEFT JOIN tasks tk ON tk.id = r.task_id AND tk.tenant_id = r.tenant_id
      WHERE r.tenant_id = ? AND r.inspection_id IN (${placeholders})
      ORDER BY r.id ASC`,
      tid,
      ...rowIds,
    );
    for (const r of rectRows) {
      const formatted = formatRectificationRow(r);
      rectMap.set(`${formatted.inspectionId}:${formatted.issueIndex}`, formatted);
    }
  }

  const items = rows.map(row => {
    const rawIssues = safeParseJson(row.issuesJson, []);
    const issues = (Array.isArray(rawIssues) ? rawIssues : []).map((issue, index) => ({
      index,
      board: String(issue?.board || ''),
      severity: String(issue?.severity || '中'),
      ...(issue?.severityRaised ? { severityRaised: issue.severityRaised } : {}),
      problem: String(issue?.problem || ''),
      evidence: String(issue?.evidence || ''),
      action: String(issue?.action || ''),
      deadline: String(issue?.deadline || ''),
      rectification: rectMap.get(`${row.id}:${index}`) || null,
    }));
    const rectifiedCount = issues.filter(item => item.rectification).length;
    const closedCount = issues.filter(item => item.rectification?.status === 'closed').length;
    return {
      id: Number(row.id),
      taskId: Number(row.taskId),
      store: row.store,
      storeId: row.storeId != null ? Number(row.storeId) : null,
      type: row.type,
      score: Number(row.score),
      subScores: safeParseJson(row.subScoresJson, {}),
      highIssues: Number(row.highIssues) || 0,
      issueCount: Number(row.issueCount) || issues.length,
      rectifiedCount,
      closedCount,
      supervisor: row.supervisor,
      taskStatus: row.taskStatus,
      createdAt: row.createdAt,
      issues,
    };
  });

  return {
    items,
    stats: {
      totalInspections,
      totalIssues,
      highIssues,
      highPending: Math.max(0, highIssues - rectAgg.closedHigh),
      created: rectAgg.created,
      closed: rectAgg.closed,
      pending: rectAgg.pending,
      closureRate: rectAgg.closureRate,
    },
  };
}

// 一键将巡店问题转为可执行整改任务（原子事务写入 tasks + store_inspection_rectifications）
export function createInspectionRectification({
  tenantId,
  inspectionId,
  issueIndex,
  assigneeId = null,
  assigneeName = '',
  dueDate = null,
  actionPlan = '',
  actor = null,
}) {
  const tid = Number(tenantId);
  const inspId = Number(inspectionId);
  const idx = Number(issueIndex);
  if (!Number.isInteger(tid) || tid <= 0) {
    throw Object.assign(new Error('租户上下文无效'), { status: 400 });
  }
  if (!Number.isInteger(inspId) || inspId <= 0) {
    throw Object.assign(new Error('巡店记录编号无效'), { status: 400 });
  }
  if (!Number.isInteger(idx) || idx < 0) {
    throw Object.assign(new Error('巡店问题编号无效'), { status: 400 });
  }

  const inspection = q.get(
    `SELECT id, tenant_id, store_name, store_id, issues_json
     FROM store_inspections
     WHERE tenant_id = ? AND id = ?`,
    tid,
    inspId,
  );
  if (!inspection) {
    throw Object.assign(new Error('巡店记录不存在或无权操作'), { status: 404 });
  }

  const issues = safeParseJson(inspection.issues_json, []);
  if (!Array.isArray(issues) || idx >= issues.length) {
    throw Object.assign(new Error('巡店问题项不存在'), { status: 400 });
  }
  const issue = issues[idx];

  const existing = q.get(
    `SELECT r.*, tk.status task_status
     FROM store_inspection_rectifications r
     LEFT JOIN tasks tk ON tk.id = r.task_id AND tk.tenant_id = r.tenant_id
     WHERE r.tenant_id = ? AND r.inspection_id = ? AND r.issue_index = ?`,
    tid,
    inspId,
    idx,
  );
  if (existing) {
    throw Object.assign(new Error('该巡店问题已派发整改单，请勿重复创建'), {
      status: 409,
      rectification: formatRectificationRow(existing),
    });
  }

  const explicitAssigneeId = assigneeId !== null && assigneeId !== undefined && assigneeId !== ''
    ? Number(assigneeId)
    : null;
  if (explicitAssigneeId !== null && (!Number.isInteger(explicitAssigneeId) || explicitAssigneeId <= 0)) {
    throw Object.assign(new Error('负责人编号无效'), { status: 400 });
  }
  const resolvedAssigneeId = explicitAssigneeId ?? (actor?.id ? Number(actor.id) : null);
  let assigneeRow = null;
  if (resolvedAssigneeId) {
    assigneeRow = q.get(
      `SELECT id, name, store_id FROM users WHERE tenant_id = ? AND id = ?`,
      tid,
      resolvedAssigneeId,
    );
    if (explicitAssigneeId && !assigneeRow) {
      throw Object.assign(new Error('指定的整改负责人不存在或不属于当前企业'), { status: 400 });
    }
  }

  const storeName = String(inspection.store_name || '').trim();
  const storeId = inspection.store_id != null
    ? Number(inspection.store_id)
    : (matchStoreByName(storeName, tid) ?? (assigneeRow?.store_id != null ? Number(assigneeRow.store_id) : null));
  const board = String(issue?.board || '').slice(0, 40);
  const severity = ['高', '中', '低'].includes(issue?.severity) ? issue.severity : '中';
  const problem = String(issue?.problem || '').trim().slice(0, 500);
  const plan = String(actionPlan || issue?.action || '').trim().slice(0, 1000);
  const resolvedAssigneeName = String(assigneeName || assigneeRow?.name || actor?.name || '').trim().slice(0, 80);
  const resolvedDueDate = dueDate ? String(dueDate).trim().slice(0, 32) : null;
  const taskTitle = `【巡店整改·${storeName}】${problem.slice(0, 48)}`;
  const taskPriority = severity === '高' ? '高' : '中';
  const taskDetail = [
    `巡店记录 #${inspection.id} · 门店：${storeName}${board ? ` · 板块：${board}` : ''} · 严重度：${severity}`,
    `问题描述：${problem}`,
    issue?.evidence ? `现场证据：${issue.evidence}` : '',
    plan ? `整改动作：${plan}` : '',
    resolvedDueDate ? `整改截止：${resolvedDueDate}` : '',
  ].filter(Boolean).join('\n');

  const manageTx = !db.inTransaction;
  if (manageTx) db.exec('BEGIN IMMEDIATE');
  let rectId;
  let taskId;
  try {
    const taskRes = q.run(
      `INSERT INTO tasks(
        tenant_id, title, detail, type, status, priority,
        assignee_id, assigned_by, due_at, source,
        source_ref_type, source_ref_id, risk, store_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      tid,
      taskTitle,
      taskDetail,
      '督导',
      '进行中',
      taskPriority,
      resolvedAssigneeId,
      actor?.id ? Number(actor.id) : null,
      resolvedDueDate,
      '巡店整改',
      'store_inspection',
      inspection.id,
      severity === '高' ? 1 : 0,
      storeId,
    );
    taskId = Number(taskRes.lastInsertRowid);

    const rectRes = q.run(
      `INSERT INTO store_inspection_rectifications(
        tenant_id, inspection_id, issue_index, store_name, store_id,
        board, severity, problem, action_plan,
        assignee_id, assignee_name, task_id, status, due_date
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      tid,
      inspection.id,
      idx,
      storeName,
      storeId,
      board,
      severity,
      problem,
      plan,
      resolvedAssigneeId,
      resolvedAssigneeName,
      taskId,
      'in_progress',
      resolvedDueDate,
    );
    rectId = Number(rectRes.lastInsertRowid);
    if (manageTx) db.exec('COMMIT');
  } catch (error) {
    if (manageTx && db.inTransaction) db.exec('ROLLBACK');
    if (/UNIQUE|CONSTRAINT/i.test(String(error?.message || ''))) {
      const dup = q.get(
        `SELECT r.*, tk.status task_status
         FROM store_inspection_rectifications r
         LEFT JOIN tasks tk ON tk.id = r.task_id AND tk.tenant_id = r.tenant_id
         WHERE r.tenant_id = ? AND r.inspection_id = ? AND r.issue_index = ?`,
        tid,
        inspId,
        idx,
      );
      throw Object.assign(new Error('该巡店问题已派发整改单，请勿重复创建'), {
        status: 409,
        rectification: formatRectificationRow(dup),
      });
    }
    throw error;
  }

  const created = q.get(
    `SELECT r.*, tk.status task_status
     FROM store_inspection_rectifications r
     LEFT JOIN tasks tk ON tk.id = r.task_id AND tk.tenant_id = r.tenant_id
     WHERE r.tenant_id = ? AND r.id = ?`,
    tid,
    rectId,
  );
  return { ...formatRectificationRow(created), taskTitle, taskId };
}

// 复检验收：更新整改单状态并同步关联 tasks 状态（通过→已完成；退回→进行中）
export function recheckInspectionRectification({
  tenantId,
  rectId,
  passed = true,
  recheckNote = '',
  actor = null,
}) {
  const tid = Number(tenantId);
  const rid = Number(rectId);
  if (!Number.isInteger(tid) || tid <= 0) {
    throw Object.assign(new Error('租户上下文无效'), { status: 400 });
  }
  if (!Number.isInteger(rid) || rid <= 0) {
    throw Object.assign(new Error('整改单编号无效'), { status: 400 });
  }

  const existing = q.get(
    `SELECT * FROM store_inspection_rectifications WHERE tenant_id = ? AND id = ?`,
    tid,
    rid,
  );
  if (!existing) {
    throw Object.assign(new Error('整改记录不存在或无权操作'), { status: 404 });
  }

  const isPassed = Boolean(passed);
  const nextStatus = isPassed ? 'closed' : 'in_progress';
  const note = String(recheckNote || '').trim().slice(0, 1000);
  const recheckBy = String(actor?.name || actor?.username || '复检员').trim().slice(0, 80);

  const manageTx = !db.inTransaction;
  if (manageTx) db.exec('BEGIN IMMEDIATE');
  try {
    q.run(
      `UPDATE store_inspection_rectifications
       SET status = ?,
           recheck_note = ?,
           recheck_by = ?,
           recheck_at = datetime('now','localtime'),
           updated_at = datetime('now','localtime')
       WHERE tenant_id = ? AND id = ?`,
      nextStatus,
      note,
      recheckBy,
      tid,
      rid,
    );
    if (existing.task_id) {
      if (isPassed) {
        q.run(
          `UPDATE tasks
           SET status = '已完成',
               done_at = COALESCE(done_at, datetime('now','localtime'))
           WHERE tenant_id = ? AND id = ?`,
          tid,
          existing.task_id,
        );
      } else {
        q.run(
          `UPDATE tasks
           SET status = '进行中',
               done_at = NULL
           WHERE tenant_id = ? AND id = ?`,
          tid,
          existing.task_id,
        );
      }
    }
    if (manageTx) db.exec('COMMIT');
  } catch (error) {
    if (manageTx && db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }

  const updated = q.get(
    `SELECT r.*, tk.status task_status
     FROM store_inspection_rectifications r
     LEFT JOIN tasks tk ON tk.id = r.task_id AND tk.tenant_id = r.tenant_id
     WHERE r.tenant_id = ? AND r.id = ?`,
    tid,
    rid,
  );
  return formatRectificationRow(updated);
}

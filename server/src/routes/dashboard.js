import { Router } from 'express';
import { q, curTenant, mergeMarshals } from '../db.js';
import { today, daysAgo, monthStart, pct, maskPhone, logOp, notify, safeJsonParse, requireRole } from '../util.js';
import { funnel } from '../engines/scoring.js';
import { healthScore } from '../engines/health.js';
import { generateBattlePlan } from '../engines/plans.js';
import { canAccessOwner, hasFullDataAccess, userScopeClause } from '../engines/access.js';

const r = Router();
const DASHBOARD_WIDGETS = [
  { key: 'kpi', label: '核心经营指标', description: '销售、客户、待跟进、活动、任务与健康度' },
  { key: 'follow', label: '沟通跟进与员工竞赛', description: '跟进趋势、竞赛榜和最近沟通' },
  { key: 'trend', label: '销售趋势', description: '周期销售与目标趋势' },
  { key: 'funnel', label: '客户阶段漏斗', description: '客户转化与瓶颈' },
  { key: 'briefing', label: 'AI经营简报', description: '经营判断和老板待拍板事项' },
  { key: 'channels', label: '渠道效果分析', description: '渠道线索与转化' },
  { key: 'customers', label: '重点客户', description: '高优先级客户清单' },
  { key: 'marshals', label: '餐饮数字员工入口', description: '员工状态、产出与待办' },
  { key: 'activities', label: '活动概览', description: '近期活动与飞书同步状态' },
];
const DEFAULT_DASHBOARD_WIDGETS = DASHBOARD_WIDGETS.map(x => x.key);
const MANAGER_ROLES = new Set(['boss', 'ops_director', 'admin', 'platform_super']);

function dashboardWidgetsFor(user) {
  return MANAGER_ROLES.has(user?.role) ? DASHBOARD_WIDGETS : DASHBOARD_WIDGETS.filter(item => item.key !== 'briefing');
}

r.get('/widgets/preferences', (req, res) => {
  const available = dashboardWidgetsFor(req.user);
  const allowedKeys = available.map(item => item.key);
  const row = q.get(`SELECT widgets,updated_at FROM dashboard_widget_preferences WHERE tenant_id=? AND user_id=?`, curTenant(), req.user.id);
  let selected = allowedKeys;
  if (row?.widgets) {
    try { selected = JSON.parse(row.widgets).filter(x => allowedKeys.includes(x)); } catch { /* use defaults */ }
  }
  res.json({ available, selected, updatedAt: row?.updated_at || null, canEdit: ['boss', 'admin'].includes(req.user.role) });
});

r.put('/widgets/preferences', (req, res) => {
  if (!['boss', 'admin'].includes(req.user.role)) return res.status(403).json({ error: '仅老板或管理员可自定义总驾驶舱' });
  const selected = [...new Set((Array.isArray(req.body?.widgets) ? req.body.widgets : []).filter(x => DEFAULT_DASHBOARD_WIDGETS.includes(x)))];
  if (!selected.length) return res.status(400).json({ error: '至少保留一个驾驶舱模块' });
  q.run(`INSERT INTO dashboard_widget_preferences(user_id,widgets,updated_at) VALUES(?,?,datetime('now','localtime'))
    ON CONFLICT(tenant_id,user_id) DO UPDATE SET widgets=excluded.widgets,updated_at=excluded.updated_at`, req.user.id, JSON.stringify(selected));
  logOp(req.user, '老板驾驶舱', '自定义数据模块', selected.join(','));
  res.json({ ok: true, selected });
});
const EVALUATOR_ROLES = new Set(['boss', 'admin', 'platform_super']);

function periodStart(period = 'month') {
  const d = new Date();
  if (period === 'week') {
    const offset = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - offset);
    return d.toLocaleDateString('sv-SE');
  }
  if (period === 'quarter') {
    d.setMonth(Math.floor(d.getMonth() / 3) * 3, 1);
    return d.toLocaleDateString('sv-SE');
  }
  return monthStart();
}
function monthKey() { return today().slice(0, 7); }
const n = (v) => Number(v || 0);
const mapByUser = (rows) => new Map(rows.map(row => [Number(row.user_id || 0), row]));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const QUARTER_RE = /^\d{4}-Q[1-4]$/;

function dateStr(d) {
  return d.toLocaleDateString('sv-SE');
}

function isValidDateStr(s) {
  if (!DATE_RE.test(String(s || ''))) return false;
  const d = new Date(`${s}T00:00:00`);
  return !Number.isNaN(d.getTime()) && dateStr(d) === s;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return dateStr(d);
}

function addMonths(date, months) {
  const d = new Date(`${date}T00:00:00`);
  d.setMonth(d.getMonth() + months, 1);
  return dateStr(d);
}

function daysBetween(start, endExclusive) {
  const a = new Date(`${start}T00:00:00`);
  const b = new Date(`${endExclusive}T00:00:00`);
  return Math.max(1, Math.round((b - a) / 86400000));
}

function monthLabel(month) {
  const [y, m] = month.split('-');
  return `${y}年${m}月`;
}

function quarterLabel(qkey) {
  const [y, qn] = qkey.split('-Q');
  return `${y}年第${qn}季度`;
}

function businessDataRange(user = null) {
  const tenantId = curTenant();
  const dates = [];
  const addRange = (row) => {
    if (row?.start) dates.push(row.start);
    if (row?.end) dates.push(row.end);
  };
  if (!user || hasFullDataAccess(user)) {
    addRange(q.get(`SELECT MIN(date) start,MAX(date) end
      FROM daily_ops WHERE tenant_id=? AND date IS NOT NULL`, tenantId));
  }
  const leadScope = user ? userScopeClause(user, 'owner_id') : { sql: '', params: [] };
  const orderScope = user ? userScopeClause(user, 'l.owner_id') : { sql: '', params: [] };
  const activityScope = user ? userScopeClause(user, 'owner_id') : { sql: '', params: [] };
  const taskScope = user ? userScopeClause(user, 'assignee_id') : { sql: '', params: [] };
  addRange(q.get(`SELECT MIN(date(o.created_at)) start,MAX(date(o.created_at)) end
    FROM orders o LEFT JOIN leads l ON l.id=o.lead_id
    WHERE o.tenant_id=? AND o.created_at IS NOT NULL${orderScope.sql}`,
  tenantId, ...orderScope.params));
  addRange(q.get(`SELECT MIN(date(created_at)) start,MAX(date(created_at)) end
    FROM leads WHERE tenant_id=? AND created_at IS NOT NULL${leadScope.sql}`,
  tenantId, ...leadScope.params));
  addRange(q.get(`SELECT MIN(date) start,MAX(date) end
    FROM activities WHERE tenant_id=? AND date IS NOT NULL${activityScope.sql}`,
  tenantId, ...activityScope.params));
  addRange(q.get(`SELECT MIN(date(created_at)) start,MAX(date(created_at)) end
    FROM tasks WHERE tenant_id=? AND created_at IS NOT NULL${taskScope.sql}`,
  tenantId, ...taskScope.params));
  dates.sort();
  return { start: dates[0] || today(), end: dates.at(-1) || today() };
}

function resolveDashboardScope(query = {}, fallbackPeriod = 'month', user = null) {
  const mode = String(query.mode || '');
  let scope;

  if (mode === 'all') {
    const range = businessDataRange(user);
    scope = {
      mode: 'all',
      start: range.start,
      endExclusive: addDays(range.end, 1),
      label: '全部经营数据',
      shortLabel: '全部',
      compareLabel: '较此前同期',
      preset: false,
      allData: true,
    };
  } else if (mode === 'day') {
    const date = isValidDateStr(query.date) ? String(query.date) : today();
    scope = {
      mode: 'day',
      start: date,
      endExclusive: addDays(date, 1),
      label: date,
      shortLabel: date.slice(5),
      compareLabel: '较前日',
      preset: false,
    };
  } else if (mode === 'month') {
    const month = MONTH_RE.test(String(query.month || '')) ? String(query.month) : today().slice(0, 7);
    scope = {
      mode: 'month',
      start: `${month}-01`,
      endExclusive: addMonths(`${month}-01`, 1),
      label: monthLabel(month),
      shortLabel: month,
      compareLabel: '较上月',
      awardPeriod: month,
      preset: false,
    };
  } else if (mode === 'quarter') {
    const qkey = QUARTER_RE.test(String(query.quarter || '')) ? String(query.quarter) : `${today().slice(0, 4)}-Q${Math.ceil(Number(today().slice(5, 7)) / 3)}`;
    const [year, qn] = qkey.split('-Q');
    const month = (Number(qn) - 1) * 3 + 1;
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    scope = {
      mode: 'quarter',
      start,
      endExclusive: addMonths(start, 3),
      label: quarterLabel(qkey),
      shortLabel: qkey,
      compareLabel: '较上季',
      preset: false,
    };
  } else {
    const period = ['week', 'month', 'quarter'].includes(String(query.period || '')) ? String(query.period) : fallbackPeriod;
    const labelMap = { week: '本周', month: '本月', quarter: '本季' };
    const compareMap = { week: '较上周', month: '较上月', quarter: '较上季' };
    scope = {
      mode: period,
      period,
      start: periodStart(period),
      endExclusive: addDays(today(), 1),
      label: labelMap[period],
      shortLabel: labelMap[period],
      compareLabel: compareMap[period],
      preset: true,
    };
  }

  const end = addDays(scope.endExclusive, -1);
  const spanDays = daysBetween(scope.start, scope.endExclusive);
  const prevStart = addDays(scope.start, -spanDays);
  return {
    ...scope,
    end,
    spanDays,
    prevStart,
    prevEndExclusive: scope.start,
    rangeText: scope.start === end ? scope.start : `${scope.start} 至 ${end}`,
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

function employeeScoreRows(period = 'month', viewer = null) {
  const T = curTenant();
  const scope = typeof period === 'object' ? period : resolveDashboardScope({ period }, period, viewer);
  const start = scope.start;
  const endExclusive = scope.endExclusive;
  const periodAward = scope.awardPeriod || monthKey();
  const employeeScope = viewer ? userScopeClause(viewer, 'id') : { sql: '', params: [] };
  const employees = q.all(`SELECT id user_id, username, name, role, dept, phone, avatar, status, created_at, last_login_at
    FROM users
    WHERE tenant_id = ? AND COALESCE(status,'启用') != '停用'
      AND role IN ('sales','ops_director','manager','partner')${employeeScope.sql}
    ORDER BY CASE role WHEN 'ops_director' THEN 1 WHEN 'manager' THEN 2 WHEN 'sales' THEN 3 WHEN 'partner' THEN 4 ELSE 9 END, id`, T, ...employeeScope.params);
  const followMap = mapByUser(q.all(`SELECT user_id, COUNT(*) follow_count, COUNT(DISTINCT lead_id) customer_count, MAX(created_at) last_follow_at
    FROM follow_ups WHERE tenant_id = ? AND created_at >= ? AND created_at < ? GROUP BY user_id`, T, start, endExclusive));
  const taskMap = mapByUser(q.all(`SELECT assignee_id user_id, COUNT(*) task_total,
      SUM(CASE WHEN status = '已完成' THEN 1 ELSE 0 END) completed_tasks,
      SUM(CASE WHEN status = '待审核' THEN 1 ELSE 0 END) review_tasks
    FROM tasks WHERE tenant_id = ? AND ((created_at >= ? AND created_at < ?) OR (COALESCE(done_at,'') >= ? AND COALESCE(done_at,'') < ?)) GROUP BY assignee_id`,
    T, start, endExclusive, start, endExclusive));
  const submissionMap = mapByUser(q.all(`SELECT user_id, COUNT(*) submissions,
      SUM(CASE WHEN result = '通过' THEN 1 ELSE 0 END) passed_submissions
    FROM task_submissions WHERE tenant_id = ? AND created_at >= ? AND created_at < ? GROUP BY user_id`, T, start, endExclusive));
  const contentMap = mapByUser(q.all(`SELECT creator_id user_id, COUNT(*) content_count
    FROM contents WHERE tenant_id = ? AND created_at >= ? AND created_at < ? GROUP BY creator_id`, T, start, endExclusive));
  const leadMap = mapByUser(q.all(`SELECT owner_id user_id, COUNT(*) new_leads,
      SUM(CASE WHEN stage IN ('已成交','复购') THEN 1 ELSE 0 END) deal_customers,
      COALESCE(SUM(CASE WHEN stage IN ('已成交','复购') THEN deal_amount ELSE 0 END),0) lead_deal_amount
    FROM leads WHERE tenant_id = ? AND created_at >= ? AND created_at < ? GROUP BY owner_id`, T, start, endExclusive));
  const orderMap = mapByUser(q.all(`SELECT l.owner_id user_id, COUNT(o.id) order_count, COALESCE(SUM(o.amount),0) order_amount
    FROM orders o LEFT JOIN leads l ON l.id = o.lead_id
    WHERE o.tenant_id = ? AND o.created_at >= ? AND o.created_at < ? GROUP BY l.owner_id`, T, start, endExclusive));
  const pointMap = mapByUser(q.all(`SELECT user_id, COALESCE(SUM(delta),0) bonus_points, COUNT(*) bonus_count
    FROM employee_point_logs WHERE tenant_id = ? AND created_at >= ? AND created_at < ? GROUP BY user_id`, T, start, endExclusive));
  const awardMap = mapByUser(q.all(`SELECT user_id, award_type, score award_score, comment award_comment, created_at award_at
    FROM employee_awards WHERE tenant_id = ? AND period = ?`, T, periodAward));

  const rows = employees.map((e) => {
    const f = followMap.get(e.user_id) || {};
    const t = taskMap.get(e.user_id) || {};
    const s = submissionMap.get(e.user_id) || {};
    const c = contentMap.get(e.user_id) || {};
    const l = leadMap.get(e.user_id) || {};
    const o = orderMap.get(e.user_id) || {};
    const p = pointMap.get(e.user_id) || {};
    const dealCount = Math.max(n(l.deal_customers), n(o.order_count));
    const dealAmount = Math.max(n(l.lead_deal_amount), n(o.order_amount));
    const scoreDetail = [
      { key: 'follow', label: '客户跟进', value: `${n(f.follow_count)}次`, rule: '每次3分', points: n(f.follow_count) * 3 },
      { key: 'customer', label: '触达客户', value: `${n(f.customer_count)}人`, rule: '每个客户8分', points: n(f.customer_count) * 8 },
      { key: 'lead', label: '新增线索', value: `${n(l.new_leads)}条`, rule: '每条5分', points: n(l.new_leads) * 5 },
      { key: 'task', label: '完成任务', value: `${n(t.completed_tasks)}个`, rule: '每个12分', points: n(t.completed_tasks) * 12 },
      { key: 'submission', label: '通过提交', value: `${n(s.passed_submissions)}条`, rule: '每条8分', points: n(s.passed_submissions) * 8 },
      { key: 'content', label: '内容产出', value: `${n(c.content_count)}条`, rule: '每条5分', points: n(c.content_count) * 5 },
      { key: 'deal', label: '成交贡献', value: `${dealCount}单 / ¥${Math.round(dealAmount)}`, rule: '每单30分 + 每千元1分', points: dealCount * 30 + Math.min(100, Math.round(dealAmount / 1000)) },
      { key: 'bonus', label: '荣誉调控', value: `${n(p.bonus_points)}分`, rule: '老板/管理员手动加减分', points: n(p.bonus_points) },
    ];
    const score = scoreDetail.reduce((sum, item) => sum + n(item.points), 0);
    const award = awardMap.get(e.user_id) || null;
    return {
      ...e,
      follow_count: n(f.follow_count),
      customer_count: n(f.customer_count),
      new_leads: n(l.new_leads),
      task_total: n(t.task_total),
      completed_tasks: n(t.completed_tasks),
      review_tasks: n(t.review_tasks),
      submissions: n(s.submissions),
      passed_submissions: n(s.passed_submissions),
      content_count: n(c.content_count),
      deal_count: dealCount,
      deal_amount: Math.round(dealAmount),
      bonus_points: n(p.bonus_points),
      bonus_count: n(p.bonus_count),
      score,
      score_detail: scoreDetail,
      score_formula: '客户跟进3分/次 + 触达客户8分/人 + 新线索5分/条 + 完成任务12分/个 + 通过提交8分/条 + 内容5分/条 + 成交30分/单 + 每千元成交1分 + 荣誉调控',
      last_follow_at: f.last_follow_at || null,
      award_type: award?.award_type || null,
      award_comment: award?.award_comment || null,
      award_at: award?.award_at || null,
    };
  }).sort((a, b) => b.score - a.score || b.follow_count - a.follow_count || b.customer_count - a.customer_count);
  rows.forEach((row, i) => { row.rank = i + 1; });
  return { start, endExclusive, label: scope.label, rangeText: scope.rangeText, period: scope.mode, rows };
}

function publicEmployeeScore(row) {
  return {
    user_id: row.user_id,
    name: row.name,
    role: row.role,
    dept: row.dept,
    avatar: row.avatar,
    rank: row.rank,
    score: row.score,
    follow_count: row.follow_count,
    customer_count: row.customer_count,
    new_leads: row.new_leads,
    completed_tasks: row.completed_tasks,
    submissions: row.submissions,
    passed_submissions: row.passed_submissions,
    content_count: row.content_count,
    deal_count: row.deal_count,
    bonus_points: row.bonus_points,
    award_type: row.award_type,
  };
}

r.get('/summary', (req, res) => {
  syncActivityStatuses();
  const t = today(), y = daysAgo(1);
  const leadScope = userScopeClause(req.user, 'owner_id');
  const leadJoinScope = userScopeClause(req.user, 'l.owner_id');
  const taskScope = userScopeClause(req.user, 'assignee_id');
  const activityScope = userScopeClause(req.user, 'owner_id');
  const orderScope = userScopeClause(req.user, 'l.owner_id');
  const scopeRequested = !!(req.query.period || req.query.mode);
  const selectedScope = resolveDashboardScope(req.query, 'month', req.user);
  const fullDataAccess = hasFullDataAccess(req.user);
  const health = fullDataAccess ? healthScore() : null;

  if (scopeRequested) {
    const T = curTenant();
    const orderSales = q.get(`SELECT COALESCE(SUM(o.amount),0) a FROM orders o LEFT JOIN leads l ON l.id=o.lead_id
      WHERE o.tenant_id=? AND o.created_at >= ? AND o.created_at < ?${orderScope.sql}`, T, selectedScope.start, selectedScope.endExclusive, ...orderScope.params)?.a || 0;
    const orderRows = q.get(`SELECT COUNT(*) n FROM orders o LEFT JOIN leads l ON l.id=o.lead_id
      WHERE o.tenant_id=? AND o.created_at >= ? AND o.created_at < ?${orderScope.sql}`, T, selectedScope.start, selectedScope.endExclusive, ...orderScope.params)?.n || 0;
    const prevOrderSales = q.get(`SELECT COALESCE(SUM(o.amount),0) a FROM orders o LEFT JOIN leads l ON l.id=o.lead_id
      WHERE o.tenant_id=? AND o.created_at >= ? AND o.created_at < ?${orderScope.sql}`, T, selectedScope.prevStart, selectedScope.prevEndExclusive, ...orderScope.params)?.a || 0;
    const opsSales = fullDataAccess
      ? q.get(`SELECT COALESCE(SUM(deal_amount),0) a FROM daily_ops WHERE tenant_id=? AND date >= ? AND date < ?`, T, selectedScope.start, selectedScope.endExclusive)?.a || 0
      : 0;
    const opsRows = fullDataAccess
      ? q.get(`SELECT COUNT(*) n FROM daily_ops WHERE tenant_id=? AND date >= ? AND date < ?`, T, selectedScope.start, selectedScope.endExclusive)?.n || 0
      : 0;
    const prevOpsSales = fullDataAccess
      ? q.get(`SELECT COALESCE(SUM(deal_amount),0) a FROM daily_ops WHERE tenant_id=? AND date >= ? AND date < ?`, T, selectedScope.prevStart, selectedScope.prevEndExclusive)?.a || 0
      : 0;
    // 显式营收口径（修双源短路 bug）：范围内 orders 有记录就用订单口径，否则才用 daily_ops 日报口径；
    // 不再按金额真值 || 回退——订单合计恰为 0 或口径缺失时会静默串源。对比期跟随当期口径，不跨源比较。
    const revenueSource = orderRows > 0 ? 'orders' : (opsRows > 0 ? 'daily_ops' : null);
    const rangeSales = revenueSource === 'orders' ? orderSales : revenueSource === 'daily_ops' ? opsSales : 0;
    const prevSales = revenueSource === 'orders' ? prevOrderSales : revenueSource === 'daily_ops' ? prevOpsSales : 0;
    const leadRows = q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ? AND created_at >= ? AND created_at < ?${leadScope.sql}`,
      T, selectedScope.start, selectedScope.endExclusive, ...leadScope.params)?.n || 0;
    const prevLeadRows = q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ? AND created_at >= ? AND created_at < ?${leadScope.sql}`,
      T, selectedScope.prevStart, selectedScope.prevEndExclusive, ...leadScope.params)?.n || 0;
    const opsLeads = fullDataAccess
      ? q.get(`SELECT COALESCE(SUM(new_leads),0) n FROM daily_ops WHERE tenant_id=? AND date >= ? AND date < ?`,
        T, selectedScope.start, selectedScope.endExclusive)?.n || 0
      : 0;
    const prevOpsLeads = fullDataAccess
      ? q.get(`SELECT COALESCE(SUM(new_leads),0) n FROM daily_ops WHERE tenant_id=? AND date >= ? AND date < ?`,
        T, selectedScope.prevStart, selectedScope.prevEndExclusive)?.n || 0
      : 0;
    const rangeLeads = leadRows || opsLeads || 0;
    const prevLeads = prevLeadRows || prevOpsLeads || 0;
    const pendingFollow = q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${T} AND stage NOT IN ('已成交','复购','已流失') AND next_follow_at IS NOT NULL${leadScope.sql}`, ...leadScope.params)?.n || 0;
    const overdue = q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${T} AND stage NOT IN ('已成交','复购','已流失') AND next_follow_at < datetime('now','localtime')${leadScope.sql}`, ...leadScope.params)?.n || 0;
    const communicatedCustomers = q.get(`SELECT COUNT(DISTINCT f.lead_id) n FROM follow_ups f JOIN leads l ON l.id=f.lead_id
      WHERE f.tenant_id = ? AND f.created_at >= ? AND f.created_at < ?${leadJoinScope.sql}`,
      T, selectedScope.start, selectedScope.endExclusive, ...leadJoinScope.params)?.n || 0;
    const followRecords = q.get(`SELECT COUNT(*) n FROM follow_ups f JOIN leads l ON l.id=f.lead_id
      WHERE f.tenant_id = ? AND f.created_at >= ? AND f.created_at < ?${leadJoinScope.sql}`,
      T, selectedScope.start, selectedScope.endExclusive, ...leadJoinScope.params)?.n || 0;
    const rangeActivities = q.get(`SELECT COUNT(*) n FROM activities WHERE tenant_id = ? AND date >= ? AND date < ?${activityScope.sql}`,
      T, selectedScope.start, selectedScope.endExclusive, ...activityScope.params)?.n || 0;
    const taskTotal = q.get(`SELECT COUNT(*) n FROM tasks WHERE tenant_id = ? AND created_at >= ? AND created_at < ?${taskScope.sql}`,
      T, selectedScope.start, selectedScope.endExclusive, ...taskScope.params)?.n || 0;
    const taskDone = q.get(`SELECT COUNT(*) n FROM tasks WHERE tenant_id = ? AND status = '已完成' AND created_at >= ? AND created_at < ?${taskScope.sql}`,
      T, selectedScope.start, selectedScope.endExclusive, ...taskScope.params)?.n || 0;
    const businessRows = Number(opsRows) + Number(orderRows) + Number(leadRows) + Number(rangeActivities) + Number(taskTotal);
    const latestOps = fullDataAccess
      ? q.get(`SELECT MAX(date) d FROM daily_ops WHERE tenant_id = ? AND date >= ? AND date < ?`, T, selectedScope.start, selectedScope.endExclusive)?.d || null
      : null;
    const latestActivity = q.get(`SELECT MAX(date) d FROM activities WHERE tenant_id = ? AND date >= ? AND date < ?${activityScope.sql}`,
      T, selectedScope.start, selectedScope.endExclusive, ...activityScope.params)?.d || null;
    return res.json({
      todaySales: rangeSales,
      rangeSales,
      revenueSource,
      salesWow: prevSales ? pct(rangeSales - prevSales, prevSales) : 0,
      monthLeads: rangeLeads,
      rangeLeads,
      leadsWow: prevLeads ? pct(rangeLeads - prevLeads, prevLeads) : 0,
      pendingFollow,
      overdue,
      communicatedCustomers,
      followRecords,
      runningActivities: rangeActivities,
      weekActivities: rangeActivities,
      taskRate: taskTotal ? pct(taskDone, taskTotal) : 0,
      businessRows,
      health: health ? { score: health.total, level: health.level } : null,
      scope: selectedScope,
      timeScope: {
        today: t,
        monthStart: monthStart(),
        latestOps,
        latestActivity,
        selected: selectedScope,
        hasData: businessRows > 0,
        hasHistoricalSamples: !!(latestOps || latestActivity) && !rangeSales,
        note: `${selectedScope.label}口径：销售、客户、沟通、活动、任务按 ${selectedScope.rangeText} 聚合；待跟进和健康度为当前状态。`,
      },
    });
  }

  const tOps = fullDataAccess
    ? q.get(`SELECT * FROM daily_ops WHERE tenant_id = ${curTenant()} AND date = ?`, t) || {}
    : {};
  const yOps = fullDataAccess
    ? q.get(`SELECT * FROM daily_ops WHERE tenant_id = ${curTenant()} AND date = ?`, y) || {}
    : {};
  const todaySales = q.get(`SELECT COALESCE(SUM(o.amount),0) a FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id=${curTenant()} AND date(o.created_at)=?${orderScope.sql}`, t, ...orderScope.params)?.a || 0;
  const todayOrderRows = q.get(`SELECT COUNT(*) n FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id=${curTenant()} AND date(o.created_at)=?${orderScope.sql}`, t, ...orderScope.params)?.n || 0;
  const yesterdaySales = q.get(`SELECT COALESCE(SUM(o.amount),0) a FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id=${curTenant()} AND date(o.created_at)=?${orderScope.sql}`, y, ...orderScope.params)?.a || 0;
  // 与范围口径同款修复：今日营收也用显式口径（有订单记录=订单口径，否则=日报口径），不按金额真值串源
  const todayRevenueSource = todayOrderRows > 0 ? 'orders' : (tOps.id ? 'daily_ops' : null);
  const mLeads = q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND created_at >= ?${leadScope.sql}`, monthStart(), ...leadScope.params)?.n || 0;
  const lmLeads = q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND created_at >= date(?, '-1 month') AND created_at < ?${leadScope.sql}`, monthStart(), monthStart(), ...leadScope.params)?.n || 0;
  const pendingFollow = q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND stage NOT IN ('已成交','复购','已流失') AND next_follow_at IS NOT NULL${leadScope.sql}`, ...leadScope.params)?.n || 0;
  const overdue = q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND stage NOT IN ('已成交','复购','已流失') AND next_follow_at < datetime('now','localtime')${leadScope.sql}`, ...leadScope.params)?.n || 0;
  const communicatedCustomers = q.get(`SELECT COUNT(DISTINCT f.lead_id) n FROM follow_ups f JOIN leads l ON l.id=f.lead_id WHERE f.tenant_id = ${curTenant()} AND f.created_at >= ?${leadJoinScope.sql}`, monthStart(), ...leadJoinScope.params)?.n || 0;
  const followRecords = q.get(`SELECT COUNT(*) n FROM follow_ups f JOIN leads l ON l.id=f.lead_id WHERE f.tenant_id = ${curTenant()} AND f.created_at >= ?${leadJoinScope.sql}`, monthStart(), ...leadJoinScope.params)?.n || 0;
  const running = q.get(`SELECT COUNT(*) n FROM activities WHERE tenant_id = ${curTenant()} AND status IN ('筹备中','报名中','进行中')${activityScope.sql}`, ...activityScope.params)?.n || 0;
  const week = q.get(`SELECT COUNT(*) n FROM activities WHERE tenant_id = ${curTenant()} AND date BETWEEN date('now') AND date('now','+7 day')${activityScope.sql}`, ...activityScope.params)?.n || 0;
  const latestOps = fullDataAccess
    ? q.get(`SELECT MAX(date) d FROM daily_ops WHERE tenant_id = ${curTenant()}`)?.d || null
    : null;
  const latestActivity = q.get(`SELECT MAX(date) d FROM activities WHERE tenant_id = ${curTenant()}${activityScope.sql}`, ...activityScope.params)?.d || null;
  const taskTotal = q.get(`SELECT COUNT(*) n FROM tasks WHERE tenant_id = ${curTenant()} AND created_at >= ?${taskScope.sql}`, monthStart(), ...taskScope.params)?.n || 1;
  const taskDone = q.get(`SELECT COUNT(*) n FROM tasks WHERE tenant_id = ${curTenant()} AND status = '已完成' AND created_at >= ?${taskScope.sql}`, monthStart(), ...taskScope.params)?.n || 0;
  res.json({
    todaySales: todayRevenueSource === 'orders' ? todaySales : todayRevenueSource === 'daily_ops' ? (tOps.deal_amount || 0) : 0,
    revenueSource: todayRevenueSource,
    salesWow: pct((todaySales || 0) - (yesterdaySales || 0), yesterdaySales || 1),
    monthLeads: mLeads, leadsWow: pct(mLeads - lmLeads, lmLeads || 1),
    pendingFollow, overdue, communicatedCustomers, followRecords, runningActivities: running, weekActivities: week,
    taskRate: pct(taskDone, taskTotal), health: health ? { score: health.total, level: health.level } : null,
    timeScope: {
      today: t,
      monthStart: monthStart(),
      latestOps,
      latestActivity,
      hasHistoricalSamples: !!(latestOps || latestActivity) && !todaySales && !tOps.deal_amount,
      note: '今日销售额为实时口径；本月新增、待跟进、活动和图表为本月/近周期经营口径。',
    },
  });
});

r.get('/trend', (req, res) => {
  const scopeRequested = !!(req.query.period || req.query.mode);
  const scope = scopeRequested
    ? resolveDashboardScope(req.query, 'month', req.user)
    : { start: daysAgo(29), endExclusive: addDays(today(), 1), label: '近30天', rangeText: `${daysAgo(29)} 至 ${today()}` };
  const leadScope = userScopeClause(req.user, 'l.owner_id');
  const opsDealAmount = hasFullDataAccess(req.user) ? 'op.deal_amount' : 'NULL';
  const opsDeals = hasFullDataAccess(req.user) ? 'op.deals' : 'NULL';
  const opsNewLeads = hasFullDataAccess(req.user) ? 'op.new_leads' : 'NULL';
  const rows = q.all(`WITH RECURSIVE dates(d) AS (
      SELECT date(?)
      UNION ALL
      SELECT date(d, '+1 day') FROM dates WHERE d < date(?, '-1 day')
    )
    SELECT ds.d date,
      COALESCE((SELECT SUM(o.amount) FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id=${curTenant()} AND date(o.created_at)=ds.d${leadScope.sql}), ${opsDealAmount}, 0) deal_amount,
      COALESCE(NULLIF((SELECT COUNT(*) FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id=${curTenant()} AND date(o.created_at)=ds.d${leadScope.sql}), 0), ${opsDeals}, 0) deals,
      COALESCE(NULLIF((SELECT COUNT(*) FROM leads l WHERE l.tenant_id=${curTenant()} AND date(l.created_at)=ds.d${leadScope.sql}), 0), ${opsNewLeads}, 0) new_leads
    FROM dates ds
    LEFT JOIN daily_ops op ON op.tenant_id = ${curTenant()} AND op.date = ds.d
    ORDER BY ds.d`,
    scope.start, scope.endExclusive, ...leadScope.params, ...leadScope.params, ...leadScope.params);
  if (!scopeRequested) return res.json(rows);
  res.json({ scope, rows });
});

r.get('/funnel', (req, res) => {
  const scope = userScopeClause(req.user, 'owner_id');
  res.json(funnel(scope.sql, ...scope.params));
});

r.get('/channels', (req, res) => {
  const scope = userScopeClause(req.user, 'owner_id');
  const selectedScope = (req.query.period || req.query.mode) ? resolveDashboardScope(req.query, 'month', req.user) : null;
  const rangeSql = selectedScope ? ' AND created_at >= ? AND created_at < ?' : '';
  const rangeParams = selectedScope ? [selectedScope.start, selectedScope.endExclusive] : [];
  const rows = q.all(`SELECT source channel, COUNT(*) leads,
    SUM(CASE WHEN stage IN ('已成交','复购') THEN 1 ELSE 0 END) deals FROM leads WHERE tenant_id = ${curTenant()}${rangeSql}${scope.sql} GROUP BY source ORDER BY deals DESC`,
    ...rangeParams, ...scope.params);
  const out = rows.map(x => ({ ...x, rate: pct(x.deals, x.leads) }));
  if (!selectedScope) return res.json(out);
  res.json({ scope: selectedScope, rows: out });
});

r.get('/key-customers', (req, res) => {
  const ownerScope = userScopeClause(req.user, 'l.owner_id');
  const rows = q.all(`SELECT l.id, l.name, l.grade, l.stage, l.score, l.budget_level, l.interest, u.name owner
    FROM leads l LEFT JOIN users u ON u.id = l.owner_id
    WHERE l.tenant_id = ${curTenant()} AND l.stage NOT IN ('已成交','复购','已流失')${ownerScope.sql} ORDER BY l.score DESC LIMIT 5`, ...ownerScope.params);
  res.json(rows);
});

r.get('/follow-overview', (req, res) => {
  const scope = resolveDashboardScope(req.query, 'month', req.user);
  const start = scope.start;
  const endExclusive = scope.endExclusive;
  const ownerScope = userScopeClause(req.user, 'l.owner_id');
  const ownerClause = ownerScope.sql;
  const params = ownerScope.params;
  const daily = q.all(`SELECT date(f.created_at) date, COUNT(*) records, COUNT(DISTINCT f.lead_id) customers
    FROM follow_ups f JOIN leads l ON l.id = f.lead_id
    WHERE f.tenant_id = ${curTenant()} AND f.created_at >= ? AND f.created_at < ? ${ownerClause}
    GROUP BY date(f.created_at) ORDER BY date(f.created_at)`, start, endExclusive, ...params);
  // 竞赛榜沿用当前账号的数据权限：老板看全员，管理者看管理范围，员工只看本人。
  const ranking = employeeScoreRows(scope, req.user);
  // 无任何经营动作且综合分为0的账号不进入竞赛榜，避免空账号占位影响激励。
  const staff = ranking.rows.filter(x => Number(x.score || 0) !== 0).map(publicEmployeeScore);
  const recent = q.all(`SELECT l.id, l.name, l.stage, l.grade, owner.name owner_name,
      f.content last_content, f.created_at last_follow_at, COALESCE(u.name, '未知账号') follower_name,
      l.next_follow_at, l.next_action,
      (SELECT COUNT(*) FROM follow_ups fx WHERE fx.lead_id = l.id AND fx.created_at >= ? AND fx.created_at < ?) range_follow_count
    FROM follow_ups f
    JOIN leads l ON l.id = f.lead_id
    LEFT JOIN users u ON u.id = f.user_id
    LEFT JOIN users owner ON owner.id = l.owner_id
    WHERE f.tenant_id = ${curTenant()} AND f.created_at >= ? AND f.created_at < ? ${ownerClause}
      AND f.id IN (SELECT MAX(id) FROM follow_ups WHERE tenant_id = ${curTenant()} AND created_at >= ? AND created_at < ? GROUP BY lead_id)
    ORDER BY f.created_at DESC LIMIT 8`, start, endExclusive, start, endExclusive, ...params, start, endExclusive);
  res.json({
    scope,
    summary: {
      communicatedCustomers: q.get(`SELECT COUNT(DISTINCT f.lead_id) n FROM follow_ups f JOIN leads l ON l.id = f.lead_id WHERE f.tenant_id = ${curTenant()} AND f.created_at >= ? AND f.created_at < ? ${ownerClause}`, start, endExclusive, ...params)?.n || 0,
      followRecords: q.get(`SELECT COUNT(*) n FROM follow_ups f JOIN leads l ON l.id = f.lead_id WHERE f.tenant_id = ${curTenant()} AND f.created_at >= ? AND f.created_at < ? ${ownerClause}`, start, endExclusive, ...params)?.n || 0,
      activeStaff: staff.filter(x => x.follow_count || x.completed_tasks || x.content_count || x.bonus_points).length,
    },
    daily,
    staff,
    recent,
  });
});

r.get('/employees/:id/detail', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '员工ID无效' });
  if (!canAccessOwner(req.user, id)) return res.status(403).json({ error: '只能查看本人或下级员工档案' });
  const T = curTenant();
  const scope = resolveDashboardScope(req.query, 'month', req.user);
  const profile = q.get(`SELECT id, username, name, role, dept, phone, avatar, status, created_at, last_login_at
    FROM users WHERE tenant_id = ? AND id = ?`, T, id);
  if (!profile) return res.status(404).json({ error: '员工不存在' });
  const ranking = employeeScoreRows(scope, req.user);
  const score = ranking.rows.find(x => Number(x.user_id) === id) || null;
  const profileSafe = { ...profile, phone: maskPhone(profile.phone, req.user.role) };
  const pointLogs = q.all(`SELECT p.id, p.delta, p.reason, p.source, p.created_at, op.name operator_name
    FROM employee_point_logs p LEFT JOIN users op ON op.id = p.operator_id
    WHERE p.tenant_id = ? AND p.user_id = ? AND p.created_at >= ? AND p.created_at < ? ORDER BY p.created_at DESC LIMIT 30`, T, id, scope.start, scope.endExclusive);
  const awards = q.all(`SELECT a.id, a.period, a.award_type, a.score, a.comment, a.created_at, op.name operator_name
    FROM employee_awards a LEFT JOIN users op ON op.id = a.operator_id
    WHERE a.tenant_id = ? AND a.user_id = ? ORDER BY a.period DESC, a.created_at DESC LIMIT 12`, T, id);
  const recentFollows = q.all(`SELECT f.id, f.content, f.stage_after, f.created_at, l.id lead_id, l.name lead_name, l.stage lead_stage
    FROM follow_ups f LEFT JOIN leads l ON l.id = f.lead_id
    WHERE f.tenant_id = ? AND f.user_id = ? AND f.created_at >= ? AND f.created_at < ? ORDER BY f.created_at DESC LIMIT 20`, T, id, scope.start, scope.endExclusive);
  const tasks = q.all(`SELECT id, title, type, status, source, due_at, done_at, created_at
    FROM tasks WHERE tenant_id = ? AND assignee_id = ? AND ((created_at >= ? AND created_at < ?) OR (COALESCE(done_at,'') >= ? AND COALESCE(done_at,'') < ?)) ORDER BY created_at DESC LIMIT 20`,
    T, id, scope.start, scope.endExclusive, scope.start, scope.endExclusive);
  const submissions = q.all(`SELECT s.id, s.content, s.result, s.created_at, t.title task_title
    FROM task_submissions s LEFT JOIN tasks t ON t.id = s.task_id
    WHERE s.tenant_id = ? AND s.user_id = ? AND s.created_at >= ? AND s.created_at < ? ORDER BY s.created_at DESC LIMIT 20`, T, id, scope.start, scope.endExclusive);
  const contents = q.all(`SELECT id, type, title, status, created_at
    FROM contents WHERE tenant_id = ? AND creator_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 12`, T, id, scope.start, scope.endExclusive);
  const ownedLeads = q.all(`SELECT id, name, grade, stage, score, next_follow_at
    FROM leads WHERE tenant_id = ? AND owner_id = ? ORDER BY score DESC, updated_at DESC LIMIT 12`, T, id);
  res.json({
    profile: profileSafe,
    score,
    period: ranking.period,
    periodStart: ranking.start,
    scope,
    pointLogs,
    awards,
    recentFollows,
    tasks,
    submissions,
    contents,
    ownedLeads,
    canEvaluate: EVALUATOR_ROLES.has(req.user.role),
  });
});

r.post('/employees/:id/points', (req, res) => {
  if (!EVALUATOR_ROLES.has(req.user.role)) return res.status(403).json({ error: '仅老板/管理员可调控员工荣誉积分' });
  const id = Number(req.params.id);
  const rawDelta = Math.round(Number(req.body.delta || 0));
  const delta = Math.max(-500, Math.min(500, rawDelta));
  const reason = String(req.body.reason || '').trim().slice(0, 160) || (delta >= 0 ? '经营表现优秀，老板荣誉奖励' : '经营动作未达标，老板荣誉扣分');
  if (!id || !delta) return res.status(400).json({ error: '参数无效' });
  if (!canAccessOwner(req.user, id)) return res.status(403).json({ error: '只能调控权限范围内的员工积分' });
  const user = q.get(`SELECT id, name FROM users WHERE tenant_id = ? AND id = ?`, curTenant(), id);
  if (!user) return res.status(404).json({ error: '员工不存在' });
  q.run(`INSERT INTO employee_point_logs(user_id,delta,reason,source,operator_id) VALUES(?,?,?,?,?)`, id, delta, reason, 'manual', req.user.id);
  notify(id, '员工评优', `荣誉积分 ${delta > 0 ? '+' : ''}${delta}`, `${req.user.name} 调整了你 ${delta} 分：${reason}`);
  logOp(req.user, '员工评优', '荣誉积分调控', `${user.name} ${delta > 0 ? '+' : ''}${delta}：${reason}`);
  res.json({ ok: true, delta, reason });
});

r.post('/employees/:id/award', (req, res) => {
  if (!EVALUATOR_ROLES.has(req.user.role)) return res.status(403).json({ error: '仅老板/管理员可评优秀员工' });
  const id = Number(req.params.id);
  const period = /^\d{4}-\d{2}$/.test(String(req.body.period || '')) ? String(req.body.period) : monthKey();
  const awardType = String(req.body.awardType || '月度优秀员工').trim().slice(0, 40) || '月度优秀员工';
  const comment = String(req.body.comment || '').trim().slice(0, 240) || '本月综合表现优秀，评为月度优秀员工';
  if (!canAccessOwner(req.user, id)) return res.status(403).json({ error: '只能评选权限范围内的员工' });
  const user = q.get(`SELECT id, name FROM users WHERE tenant_id = ? AND id = ?`, curTenant(), id);
  if (!user) return res.status(404).json({ error: '员工不存在' });
  const score = employeeScoreRows('month', req.user).rows.find(x => Number(x.user_id) === id)?.score || 0;
  q.run(`INSERT INTO employee_awards(user_id,period,award_type,score,comment,operator_id)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id, period, award_type) DO UPDATE SET
      score = excluded.score, comment = excluded.comment, operator_id = excluded.operator_id, created_at = datetime('now','localtime')`,
    id, period, awardType, score, comment, req.user.id);
  notify(id, '员工评优', `恭喜获得${awardType}`, `${period}｜${comment}`);
  logOp(req.user, '员工评优', '月度评优', `${user.name} / ${period} / ${awardType}`);
  res.json({ ok: true, period, awardType, score, comment });
});

r.get('/briefing', requireRole('boss', 'ops_director', 'admin', 'platform_super'), (req, res) => {
  let bp = q.get(`SELECT plan FROM battle_plans WHERE tenant_id = ${curTenant()} AND date = ?`, today());
  let plan = bp ? safeJsonParse(bp.plan, null) : null;
  // 自愈：旧版字符串简报 → 重新生成为结构化（text/link/source 可溯源）
  if (!plan || typeof plan.briefing?.[0] === 'string') plan = generateBattlePlan(today());
  res.json(plan);
});

r.get('/todos', (req, res) => {
  const leadScope = userScopeClause(req.user, 'owner_id');
  const taskScope = userScopeClause(req.user, 'assignee_id');
  const canManage = MANAGER_ROLES.has(req.user.role);
  res.json({
    approvals: q.get(`SELECT COUNT(*) n FROM approvals WHERE tenant_id = ${curTenant()} AND status = '待审核'${canManage ? '' : ' AND submitter_id = ?'}`,
      ...(canManage ? [] : [req.user.id]))?.n || 0,
    overdueLeads: q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND stage NOT IN ('已成交','复购','已流失') AND next_follow_at < datetime('now','localtime')${leadScope.sql}`, ...leadScope.params)?.n || 0,
    silentPartners: canManage ? q.get(`SELECT COUNT(*) n FROM partners WHERE tenant_id = ${curTenant()} AND status='活跃' AND id NOT IN (
      SELECT partner_id FROM partner_actions WHERE tenant_id = ${curTenant()} AND date >= date('now','-2 day')
      AND (studied + (posted_moments>0) + (posted_videos>0) + invited) >= 2)`)?.n || 0 : 0,
    reviewTasks: q.get(`SELECT COUNT(*) n FROM tasks WHERE tenant_id = ${curTenant()} AND status = '待审核'${taskScope.sql}`, ...taskScope.params)?.n || 0,
    bossLeads: canManage ? q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND boss_alert = 1 AND stage NOT IN ('已成交','复购','已流失')${leadScope.sql}`, ...leadScope.params)?.n || 0 : 0,
  });
});

r.get('/week-activities', (req, res) => {
  const scope = userScopeClause(req.user, 'owner_id');
  if (req.query.period || req.query.mode) {
    const selectedScope = resolveDashboardScope(req.query, 'week', req.user);
    return res.json({
      scope: selectedScope,
      rows: q.all(`SELECT id,title,type,status,date,location,signed_up,target_join FROM activities
        WHERE tenant_id = ${curTenant()} AND date >= ? AND date < ?${scope.sql} ORDER BY date LIMIT 8`,
        selectedScope.start, selectedScope.endExclusive, ...scope.params),
    });
  }
  res.json(q.all(`SELECT id,title,type,status,date,location,signed_up,target_join FROM activities
    WHERE tenant_id = ${curTenant()} AND status IN ('筹备中','报名中','进行中')${scope.sql} ORDER BY date LIMIT 4`, ...scope.params));
});

r.get('/marshal-shortcuts', (req, res) => {
  const taskScope = userScopeClause(req.user, 't.created_by');
  res.json(mergeMarshals(q.all(`SELECT m.id, m.code, m.name, m.emoji, m.avatar, m.online,
    (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id
      AND date(t.created_at) = date('now','localtime')${taskScope.sql}) today_outputs
    FROM marshals m ORDER BY m.sort`, ...taskScope.params)));
});

// 趋势下钻：某天的数据来源明细（订单/经营数据行/当日内容）
r.get('/day-detail', (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: '缺少日期' });
  const leadScope = userScopeClause(req.user, 'l.owner_id');
  const contentScope = userScopeClause(req.user, 'creator_id');
  res.json({
    date,
    ops: hasFullDataAccess(req.user)
      ? q.get(`SELECT * FROM daily_ops WHERE tenant_id = ${curTenant()} AND date = ?`, date) || null
      : null,
    orders: q.all(`SELECT o.id, o.product, o.amount, o.type, o.channel, l.name customer
      FROM orders o LEFT JOIN leads l ON l.id = o.lead_id WHERE o.tenant_id = ${curTenant()} AND date(o.created_at) = ?${leadScope.sql} ORDER BY o.amount DESC LIMIT 20`, date, ...leadScope.params),
    newLeads: q.all(`SELECT id, name, source, identity_tag, stage FROM leads l WHERE tenant_id = ${curTenant()} AND date(created_at) = ?${leadScope.sql} LIMIT 20`, date, ...leadScope.params),
    contents: q.get(`SELECT COUNT(*) n FROM contents WHERE tenant_id = ${curTenant()} AND date(created_at) = ?${contentScope.sql}`, date, ...contentScope.params)?.n || 0,
  });
});

export default r;

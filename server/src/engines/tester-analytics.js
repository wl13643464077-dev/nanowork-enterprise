import { q } from '../db.js';
import { ensureTesterSchema, testerAccount, requireActiveTester, testerError } from './tester-access.js';
import { testerEmployee } from './tester-employee-catalog.js';
import { loadTesterCallEvidence, testerCostEvidence, testerMoney as money } from './tester-cost-evidence.js';

const DAY = 86400000;
const SHANGHAI_OFFSET = 8 * 3600000;
const dateOf = epoch => new Date(epoch + SHANGHAI_OFFSET).toISOString().slice(0, 10);
const startOfDay = epoch => Math.floor((epoch + SHANGHAI_OFFSET) / DAY) * DAY - SHANGHAI_OFFSET;
// Existing rows mix SQLite server-local timestamps and ISO timestamps. Convert
// each correctly before grouping into the explicitly stated Shanghai day.
const epochSql = expression => `CASE WHEN instr(${expression},'T')>0 OR ${expression} LIKE '%Z'
  THEN unixepoch(${expression}) ELSE unixepoch(${expression},'utc') END`;
const metric = () => ({ totalCalls: 0, successfulCalls: 0, failedCalls: 0, runningCalls: 0, knownCostCny: 0, unverifiedCostCount: 0 });
function addCall(target, call, cost) {
  target.totalCalls++;
  if (call.status === 'succeeded') target.successfulCalls++;
  else if (call.status === 'failed') target.failedCalls++;
  else target.runningCalls++;
  target.knownCostCny = money(target.knownCostCny + cost.knownCostCny);
  if (cost.unverified) target.unverifiedCostCount++;
}
function employeeIdentity(id) {
  const employee = testerEmployee(id);
  return { employeeId: id, name: employee?.name || '历史数字员工', group: employee?.group || '历史岗位',
    domain: employee?.domain || 'historical' };
}

function analyticsScope(actor, options, admin) {
  if (!admin) {
    requireActiveTester(actor?.id);
    if (options.ownerUserId !== undefined) throw testerError('只能查看自己的客户看板', 403, 'ANALYTICS_OWNER_FORBIDDEN');
    return Number(actor.id);
  }
  const current = q.get("SELECT id FROM users WHERE id=? AND role='platform_super' AND status='启用'", Number(actor?.id));
  if (!current) throw testerError('仅平台超级管理员可查看全局客户看板', 403, 'SUPER_REQUIRED');
  if (options.ownerUserId === undefined || options.ownerUserId === '') return null;
  const id = Number(options.ownerUserId);
  if (!Number.isSafeInteger(id) || id < 1) throw testerError('销售账号筛选无效');
  if (!testerAccount(id)) throw testerError('销售账号不存在', 404);
  return id;
}

export function testerAnalytics(actor, options = {}, admin = false, nowMs = Date.now()) {
  ensureTesterSchema();
  const ownerId = analyticsScope(actor, options, admin);
  if (options.scope !== undefined && options.scope !== 'customers') throw testerError('客户看板只支持customers统计范围');
  const days = options.days === undefined ? '30' : String(options.days);
  if (!['7', '30', '90', 'all'].includes(days)) throw testerError('请选择最近7天、30天、90天或全部');
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > 8640000000000000) throw testerError('统计时间无效');
  const toSeconds = Math.floor(nowMs / 1000);
  const fromMs = days === 'all' ? 0 : startOfDay(nowMs) - (Number(days) - 1) * DAY;
  const inPeriod = seconds => Number.isFinite(seconds) && seconds * 1000 >= fromMs && seconds <= toSeconds;
  const filter = alias => ownerId === null ? { sql: '', args: [] } : { sql: ` AND ${alias}.owner_user_id=?`, args: [ownerId] };
  const leadsScope = filter('l'); const conversationScope = filter('c'); const interestsScope = filter('i');
  const leads = q.all(`SELECT l.id,l.status,l.used_turns,${epochSql('l.created_at')} event_at
    FROM tester_leads l WHERE 1=1${leadsScope.sql}`, ...leadsScope.args).filter(row => inPeriod(row.event_at));
  const conversations = q.all(`SELECT c.id,c.lead_id,c.employee_id,c.status,
    ${epochSql('COALESCE(c.completed_at,c.created_at)')} event_at FROM tester_conversations c
    WHERE c.lead_id IS NOT NULL${conversationScope.sql}`, ...conversationScope.args).filter(row => inPeriod(row.event_at));
  const interests = q.all(`SELECT i.lead_id,i.employee_id,${epochSql('i.created_at')} event_at
    FROM tester_interests i WHERE 1=1${interestsScope.sql}`, ...interestsScope.args).filter(row => inPeriod(row.event_at));
  // Load earlier attempts as well: a receipt replay inside the selected window
  // must not re-count a debit already observed before that window.
  const availableCalls = loadTesterCallEvidence(ownerId)
    .filter(row => Number.isFinite(row.event_at) && row.event_at <= toSeconds);
  const costByCall = testerCostEvidence(availableCalls);

  const scopedCalls = availableCalls.filter(call => inPeriod(call.event_at));
  const customerCalls = scopedCalls.filter(call => call.lead_id !== null);
  const personalCalls = scopedCalls.filter(call => call.lead_id === null);
  const summary = { totalCustomers: leads.length,
    pendingCustomers: leads.filter(lead => lead.status === 'pending').length,
    approvedCustomers: leads.filter(lead => lead.status === 'approved').length,
    rejectedCustomers: leads.filter(lead => lead.status === 'rejected').length,
    pausedCustomers: leads.filter(lead => lead.status === 'paused').length,
    usedCustomers: leads.filter(lead => lead.used_turns > 0).length,
    unusedCustomers: leads.filter(lead => lead.used_turns === 0).length,
    exhaustedCustomers: leads.filter(lead => lead.used_turns >= 2).length,
    successfulConversations: conversations.filter(conversation => conversation.status === 'succeeded').length,
    failedConversations: conversations.filter(conversation => conversation.status === 'failed').length,
    interestSelections: interests.length, legacyRecordCount: customerCalls.filter(call => call.legacy_record).length, ...metric() };
  const personalSummary = metric();
  const byEmployee = new Map(); const byModel = new Map(); const timeline = new Map();
  const visibleEvents = [...leads, ...conversations, ...interests, ...customerCalls].map(row => row.event_at * 1000);
  const firstDay = days === 'all' ? startOfDay(visibleEvents.reduce((earliest, event) => Math.min(earliest, event), nowMs)) : fromMs;
  for (let date = firstDay; date <= startOfDay(nowMs); date += DAY) timeline.set(dateOf(date), {
    date: dateOf(date), newCustomers: 0, used: new Set(), successfulCalls: 0, failedCalls: 0,
    knownCostCny: 0, unverifiedCostCount: 0,
  });
  const employeeMetric = id => {
    if (!byEmployee.has(id)) byEmployee.set(id, { ...employeeIdentity(id), ...metric(),
      selected: new Set(), used: new Set(), successfulConversations: 0 });
    return byEmployee.get(id);
  };
  for (const lead of leads) timeline.get(dateOf(lead.event_at * 1000)).newCustomers++;
  for (const interest of interests) employeeMetric(interest.employee_id).selected.add(interest.lead_id);
  for (const conversation of conversations) {
    if (conversation.status !== 'succeeded') continue;
    const employee = employeeMetric(conversation.employee_id);
    employee.successfulConversations++; employee.used.add(conversation.lead_id);
    timeline.get(dateOf(conversation.event_at * 1000)).used.add(conversation.lead_id);
  }
  for (const call of customerCalls) {
    const cost = costByCall.get(call.id); addCall(summary, call, cost);
    addCall(employeeMetric(call.employee_id), call, cost);
    const model = call.model || 'unknown'; const provider = call.provider || '360';
    const modelKey = `${provider}:${model}`;
    if (!byModel.has(modelKey)) byModel.set(modelKey, { model, provider, ...metric() });
    addCall(byModel.get(modelKey), call, cost);
    const day = timeline.get(dateOf(call.event_at * 1000));
    if (call.status === 'succeeded') day.successfulCalls++;
    if (call.status === 'failed') day.failedCalls++;
    day.knownCostCny = money(day.knownCostCny + cost.knownCostCny);
    if (cost.unverified) day.unverifiedCostCount++;
  }
  for (const call of personalCalls) addCall(personalSummary, call, costByCall.get(call.id));
  summary.customerCalls = summary.totalCalls;
  summary.selfCalls = personalSummary.totalCalls;
  const employees = [...byEmployee.values()].map(({ selected, used, ...item }) => ({
    ...item, selectedCustomers: selected.size, usedCustomers: used.size,
  })).sort((a, b) => b.totalCalls - a.totalCalls || b.selectedCustomers - a.selectedCustomers || a.employeeId.localeCompare(b.employeeId));
  return { period: { days, from: new Date(firstDay).toISOString(), to: new Date(nowMs).toISOString(), timeZone: 'Asia/Shanghai' },
    scope: 'customers', ownerUserId: ownerId, summary, personalSummary,
    timeline: [...timeline.values()].map(({ used, ...day }) => ({ ...day, usedCustomers: used.size })),
    employees, models: [...byModel.values()].sort((a, b) => b.totalCalls - a.totalCalls || a.model.localeCompare(b.model)),
    interests: employees.filter(item => item.selectedCustomers || item.usedCustomers).map(item => ({
      employeeId: item.employeeId, name: item.name, group: item.group, domain: item.domain,
      selectedCustomers: item.selectedCustomers, usedCustomers: item.usedCustomers,
    })).sort((a, b) => b.selectedCustomers + b.usedCustomers - a.selectedCustomers - a.usedCustomers),
    statusDistribution: ['pending', 'approved', 'rejected', 'paused'].map(status => ({ status, count: leads.filter(lead => lead.status === status).length })),
    definitions: {
      customers: '客户总数、审核状态和已用/未用/用尽，按所选时间内提交申请的客户统计其当前状态。',
      calls: '调用按发起日期统计每次真实API尝试，重试分别记成功/失败；对话按完成日期统计，同一请求重放不新增对话或调用。',
      legacy: '没有逐次调用日志的历史对话按一条留存记录计数，legacyRecordCount单独标记；不推算缺失的重试历史。旧记录归360，只有对应供应商的有效费用回执才计入已知金额。',
      costs: '金额合计自有Key的上游实际扣费，包含失败调用；360人民币回执直接计入，OpenLux按已核验quota、USD及汇率换算CNY。同一账号、供应商、请求的扣费回执只计一次；未知费用另计待核次数，不是平台统一销售定价。',
      interests: '选择人数是已同意记录选岗的客户首次主动选择；使用人数是成功完成对应岗位对话的客户，不推测客户心理或购买意向。',
      personal: '主图表仅包含客户体验，测试员本人用量单独列在personalSummary。',
    } };
}

import { q, curTenant } from '../db.js';
import { notify } from '../util.js';
import { funnel } from './scoring.js';
import { appBotReady, pushFeishuToManagers } from './feishu.js';
import { storeClauseFor } from './store-scope.js';

// 每日经营日报（规则版）：涨跌 → 归因 → 建议。
// 原则：宁缺毋滥——完全没有经营数据时不生成，不用空话冒充洞察。

const fmtYuan = (n) => `¥${Math.round(Number(n) || 0).toLocaleString('zh-CN')}`;

function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('sv-SE');
}

// 某天营收：orders 有记录用 orders（真实订单口径），否则用 daily_ops 手填日报口径
// storeScope：多门店「当前门店」过滤片段（无门店上下文为空串，口径与现状一致）
function revenueOf(date, storeScope = { sql: '', params: [] }) {
  const T = curTenant();
  const fromOrders = q.get(`SELECT COALESCE(SUM(amount),0) a, COUNT(*) n FROM orders
    WHERE tenant_id=? AND date(created_at)=?${storeScope.sql}`, T, date, ...storeScope.params);
  if (fromOrders?.n > 0) return { amount: fromOrders.a, orders: fromOrders.n, source: 'orders' };
  const fromOps = q.get(`SELECT deal_amount a, new_leads nl, orders n FROM daily_ops
    WHERE tenant_id=? AND date=?${storeScope.sql}`, T, date, ...storeScope.params);
  if (fromOps) return { amount: fromOps.a || 0, orders: fromOps.n || 0, newLeads: fromOps.nl || 0, source: 'daily_ops' };
  return null;
}

function overdueFollowCount() {
  return q.get(`SELECT COUNT(*) n FROM leads
    WHERE tenant_id=? AND stage NOT IN ('已成交','复购','已流失')
      AND next_follow_at IS NOT NULL AND next_follow_at < datetime('now','localtime')`, curTenant())?.n || 0;
}

function tableExists(name) {
  try {
    return Boolean(q.get(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, name));
  } catch {
    return false;
  }
}

// 近 7 日待复差评数（严格 tenant_id + 可选 storeScope 隔离）
function pendingBadReviewCount(storeScope = { sql: '', params: [] }) {
  if (!tableExists('store_reviews')) return 0;
  try {
    return q.get(
      `SELECT COUNT(*) n FROM store_reviews
       WHERE tenant_id=? AND rating <= 2
         AND (reply IS NULL OR trim(reply) = '')
         AND created_at >= datetime('now','localtime','-7 days')${storeScope.sql}`,
      curTenant(),
      ...storeScope.params,
    )?.n || 0;
  } catch {
    return 0;
  }
}

// 未闭环巡店整改数（兼容中文 '已通过' 与系统终态 'closed'/'completed'，严格 tenant_id + storeScope 隔离）
function openRectificationCount(storeScope = { sql: '', params: [] }) {
  if (!tableExists('store_inspection_rectifications')) return 0;
  try {
    return q.get(
      `SELECT COUNT(*) n FROM store_inspection_rectifications
       WHERE tenant_id=?
         AND COALESCE(status, '') NOT IN ('已通过', 'closed', 'completed')${storeScope.sql}`,
      curTenant(),
      ...storeScope.params,
    )?.n || 0;
  } catch {
    return 0;
  }
}

function buildRecommendedEmployees({ pendingBadReviews, openRectifications, overdueFollows, deltaPct }) {
  const list = [];
  if (pendingBadReviews > 0) {
    list.push({
      id: 143,
      code: '#143',
      name: '潘口碑',
      label: '#143 潘口碑',
      reason: `近 7 日有 ${pendingBadReviews} 条差评待回复`,
    });
  }
  if (openRectifications > 0) {
    list.push({
      id: 161,
      code: '#161',
      name: '查巡巡',
      label: '#161 查巡巡',
      reason: `当前有 ${openRectifications} 项巡店整改未闭环`,
    });
  }
  if (overdueFollows > 0) {
    list.push({
      id: 144,
      code: '#144',
      name: '葛会员',
      label: '#144 葛会员',
      reason: `有 ${overdueFollows} 位客户跟进已超期`,
    });
  }
  if (deltaPct !== null && deltaPct < 0) {
    list.push({
      id: 160,
      code: '#160',
      name: '店小满',
      label: '#160 店小满',
      reason: `昨日营收较前 7 日均值下降 ${Math.abs(deltaPct)}%`,
    });
  }
  return list;
}

const BOTTLENECK_ADVICE = {
  已沟通: '沟通后推进邀约的转化偏低：让「会员增长」里的高意向客户今天收到一条明确的到店邀约（时间+权益），可用内容生产仓的私聊邀约话术。',
  已邀约: '邀约后实际到店偏低：对已邀约客户做一轮到店前确认（提醒+加一个到店理由），并检查邀约权益是否可兑现。',
  已到店: '到店后成交转化偏低：复盘昨日接待动线与推荐话术，重点客户交给「餐饮数字员工」出一版针对性成交方案。',
  已成交: '成交后复购衔接偏弱：给近 30 天成交客户安排一次回访或会员权益触达，沉淀到会员增长的复购路径。',
};

// forDate = 被总结的那一天（通常是昨日）；options.user 传入时按其门店上下文过滤（驾驶舱头条），定时推送不传=全店
export function buildDailyDigest(forDate, { user = null } = {}) {
  const storeScope = user ? storeClauseFor(user, 'store_id') : { sql: '', params: [] };
  const yesterday = revenueOf(forDate, storeScope);
  const history = [];
  for (let i = 1; i <= 7; i += 1) {
    const row = revenueOf(shiftDate(forDate, -i), storeScope);
    if (row) history.push(row.amount);
  }
  const pendingBadReviews = pendingBadReviewCount(storeScope);
  const openRectifications = openRectificationCount(storeScope);
  const overdueFollows = overdueFollowCount();

  // 仅当营收/历史经营、待复差评、未闭环整改全部为空时返回 null
  if (!yesterday && !history.length && pendingBadReviews === 0 && openRectifications === 0) return null;

  const avg = history.length ? history.reduce((sum, v) => sum + v, 0) / history.length : null;
  const amount = yesterday?.amount || 0;
  const deltaPct = avg && avg > 0 ? Math.round(((amount - avg) / avg) * 100) : null;

  // 【昨日】
  let headline;
  if (!yesterday) headline = `昨日（${forDate}）没有经营数据回流。`;
  else if (deltaPct === null) headline = `昨日营收 ${fmtYuan(amount)}（暂无前 7 日数据可对比）。`;
  else headline = `昨日营收 ${fmtYuan(amount)}，较前 7 日均值${deltaPct >= 0 ? '增长' : '下降'} ${Math.abs(deltaPct)}%。`;

  // 【门店异常】
  const anomalyParts = [];
  if (pendingBadReviews > 0) anomalyParts.push(`近 7 日待复差评 ${pendingBadReviews} 条`);
  if (openRectifications > 0) anomalyParts.push(`未闭环巡店整改 ${openRectifications} 项`);
  if (overdueFollows > 0) anomalyParts.push(`超期跟进客户 ${overdueFollows} 位`);
  const anomalyLine = anomalyParts.length
    ? anomalyParts.join('；')
    : '暂无待复差评、未闭环巡店整改或超期跟进。';

  // 【归因】与【建议】
  const { bottleneck } = funnel();
  const recommendedEmployees = buildRecommendedEmployees({
    pendingBadReviews,
    openRectifications,
    overdueFollows,
    deltaPct,
  });
  let attribution;
  let suggestion;
  if (!yesterday) {
    if (pendingBadReviews > 0 || openRectifications > 0) {
      attribution = '昨日未录入订单或日报，但门店仍有待处理差评或未闭环巡店整改。';
      suggestion = '优先安排店长闭环口碑差评与巡店整改项，并在「系统管理 → 数据录入」补录昨日经营数据。';
    } else {
      attribution = '未录入订单或日报，系统无法判断昨日经营好坏。';
      suggestion = '在「系统管理 → 数据录入」补录昨日数据；长期建议接入收银/平台数据源，摆脱手工回填。';
    }
  } else if (bottleneck) {
    attribution = `转化漏斗当前卡在「${bottleneck}」环节（低于基准）。`;
    suggestion = BOTTLENECK_ADVICE[bottleneck] || '在「经营洞察」查看该环节明细并安排今日跟进动作。';
  } else if (pendingBadReviews > 0 || openRectifications > 0) {
    const issues = [];
    if (pendingBadReviews > 0) issues.push(`近 7 日尚有 ${pendingBadReviews} 条差评未回复`);
    if (openRectifications > 0) issues.push(`${openRectifications} 项巡店整改未闭环`);
    attribution = `门店存在待处理异常：${issues.join('，')}。`;
    suggestion = '先在「评价中心 / 门店运营」逐项清零差评回复与巡店整改，再同步复盘当日营收波动。';
  } else if (overdueFollows > 0) {
    attribution = `漏斗各环节未见明显异常，但有 ${overdueFollows} 位客户跟进已超期。`;
    suggestion = '先清超期跟进：按 A 级优先逐个联系，避免高意向客户流失。';
  } else {
    attribution = '漏斗各环节均在基准内，暂无明显异常。';
    suggestion = deltaPct !== null && deltaPct < 0
      ? '营收回落但转化正常，多半是流量侧波动：今天安排一条获客内容（今日必发）并检查平台曝光。'
      : '保持节奏：把昨日有效的动作（内容/活动/邀约）沉淀为模板，继续执行。';
  }

  const recommendSuffix = recommendedEmployees.length
    ? `\n【建议协办】${recommendedEmployees.map((emp) => emp.label).join('、')}`
    : '';

  return {
    date: forDate,
    amount,
    orders: yesterday?.orders || 0,
    avg7: avg === null ? null : Math.round(avg),
    deltaPct,
    source: yesterday?.source || null,
    headline,
    attribution,
    suggestion,
    pendingBadReviews,
    openRectifications,
    overdueFollows,
    recommendedEmployees,
    text: `【昨日】${headline}\n【门店异常】${anomalyLine}\n【归因】${attribution}\n【建议】${suggestion}${recommendSuffix}`,
  };
}

// 发送给老板与运营负责人（站内通知），并尽力推送到飞书群（异步、失败不影响主流程）
export function sendDailyDigest(forDate, { user = null } = {}) {
  const feishuReady = appBotReady();
  const digest = buildDailyDigest(forDate, { user });
  if (!digest) return { skipped: true, reason: 'no-data', feishuReady };
  const managers = q.all(`SELECT id FROM users
    WHERE tenant_id=? AND status='启用' AND role IN ('boss','ops_director','admin')`, curTenant());
  for (const mgr of managers) {
    notify(mgr.id, 'task', `每日经营日报 · ${forDate}`, digest.text);
  }
  if (feishuReady) {
    pushFeishuToManagers(`【纳米Work 每日经营日报 · ${forDate}】\n${digest.text}`)
      .catch((error) => console.error('[daily-digest] 飞书推送失败：', error?.message));
  }
  return { skipped: false, notified: managers.length, feishuReady, digest };
}

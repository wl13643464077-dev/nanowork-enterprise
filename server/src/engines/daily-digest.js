import { q, curTenant } from '../db.js';
import { notify } from '../util.js';
import { funnel } from './scoring.js';
import { appBotReady, pushFeishuToManagers } from './feishu.js';

// 每日经营日报（规则版）：涨跌 → 归因 → 建议。
// 原则：宁缺毋滥——完全没有经营数据时不生成，不用空话冒充洞察。

const fmtYuan = (n) => `¥${Math.round(Number(n) || 0).toLocaleString('zh-CN')}`;

function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('sv-SE');
}

// 某天营收：orders 有记录用 orders（真实订单口径），否则用 daily_ops 手填日报口径
function revenueOf(date) {
  const T = curTenant();
  const fromOrders = q.get(`SELECT COALESCE(SUM(amount),0) a, COUNT(*) n FROM orders
    WHERE tenant_id=? AND date(created_at)=?`, T, date);
  if (fromOrders?.n > 0) return { amount: fromOrders.a, orders: fromOrders.n, source: 'orders' };
  const fromOps = q.get(`SELECT deal_amount a, new_leads nl, orders n FROM daily_ops
    WHERE tenant_id=? AND date=?`, T, date);
  if (fromOps) return { amount: fromOps.a || 0, orders: fromOps.n || 0, newLeads: fromOps.nl || 0, source: 'daily_ops' };
  return null;
}

function overdueFollowCount() {
  return q.get(`SELECT COUNT(*) n FROM leads
    WHERE tenant_id=? AND stage NOT IN ('已成交','复购','已流失')
      AND next_follow_at IS NOT NULL AND next_follow_at < datetime('now','localtime')`, curTenant())?.n || 0;
}

const BOTTLENECK_ADVICE = {
  已沟通: '沟通后推进邀约的转化偏低：让「会员增长」里的高意向客户今天收到一条明确的到店邀约（时间+权益），可用内容生产仓的私聊邀约话术。',
  已邀约: '邀约后实际到店偏低：对已邀约客户做一轮到店前确认（提醒+加一个到店理由），并检查邀约权益是否可兑现。',
  已到店: '到店后成交转化偏低：复盘昨日接待动线与推荐话术，重点客户交给「餐饮数字员工」出一版针对性成交方案。',
  已成交: '成交后复购衔接偏弱：给近 30 天成交客户安排一次回访或会员权益触达，沉淀到会员增长的复购路径。',
};

// forDate = 被总结的那一天（通常是昨日）
export function buildDailyDigest(forDate) {
  const yesterday = revenueOf(forDate);
  const history = [];
  for (let i = 1; i <= 7; i += 1) {
    const row = revenueOf(shiftDate(forDate, -i));
    if (row) history.push(row.amount);
  }
  if (!yesterday && !history.length) return null; // 完全无数据，不硬生成

  const avg = history.length ? history.reduce((sum, v) => sum + v, 0) / history.length : null;
  const amount = yesterday?.amount || 0;
  const deltaPct = avg && avg > 0 ? Math.round(((amount - avg) / avg) * 100) : null;

  // 【涨跌】
  let headline;
  if (!yesterday) headline = `昨日（${forDate}）没有经营数据回流。`;
  else if (deltaPct === null) headline = `昨日营收 ${fmtYuan(amount)}（暂无前 7 日数据可对比）。`;
  else headline = `昨日营收 ${fmtYuan(amount)}，较前 7 日均值${deltaPct >= 0 ? '增长' : '下降'} ${Math.abs(deltaPct)}%。`;

  // 【归因】规则版：优先解释缺数据，其次漏斗卡点，再看跟进积压
  const { bottleneck } = funnel();
  const overdue = overdueFollowCount();
  let attribution;
  let suggestion;
  if (!yesterday) {
    attribution = '未录入订单或日报，系统无法判断昨日经营好坏。';
    suggestion = '在「系统管理 → 数据录入」补录昨日数据；长期建议接入收银/平台数据源，摆脱手工回填。';
  } else if (bottleneck) {
    attribution = `转化漏斗当前卡在「${bottleneck}」环节（低于基准）。`;
    suggestion = BOTTLENECK_ADVICE[bottleneck] || '在「经营洞察」查看该环节明细并安排今日跟进动作。';
  } else if (overdue > 0) {
    attribution = `漏斗各环节未见明显异常，但有 ${overdue} 位客户跟进已超期。`;
    suggestion = '先清超期跟进：按 A 级优先逐个联系，避免高意向客户流失。';
  } else {
    attribution = '漏斗各环节均在基准内，暂无明显异常。';
    suggestion = deltaPct !== null && deltaPct < 0
      ? '营收回落但转化正常，多半是流量侧波动：今天安排一条获客内容（今日必发）并检查平台曝光。'
      : '保持节奏：把昨日有效的动作（内容/活动/邀约）沉淀为模板，继续执行。';
  }

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
    text: `【昨日】${headline}\n【归因】${attribution}\n【建议】${suggestion}`,
  };
}

// 发送给老板与运营负责人（站内通知），并尽力推送到飞书群（异步、失败不影响主流程）
export function sendDailyDigest(forDate) {
  const digest = buildDailyDigest(forDate);
  if (!digest) return { skipped: true, reason: 'no-data' };
  const managers = q.all(`SELECT id FROM users
    WHERE tenant_id=? AND status='启用' AND role IN ('boss','ops_director')`, curTenant());
  for (const user of managers) {
    notify(user.id, 'task', `每日经营日报 · ${forDate}`, digest.text);
  }
  if (appBotReady()) {
    pushFeishuToManagers(`【纳米Work 每日经营日报 · ${forDate}】\n${digest.text}`)
      .catch((error) => console.error('[daily-digest] 飞书推送失败：', error?.message));
  }
  return { skipped: false, notified: managers.length, digest };
}

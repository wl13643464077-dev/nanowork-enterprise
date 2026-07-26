import { q, getTenantConfig, curTenant } from '../db.js';
import { monthStart, today, pct } from '../util.js';

// 经营健康度模型（PRD §10.2）
// 健康度 = 获客×0.25 + 转化×0.25 + 复购×0.15 + 协作伙伴活跃×0.20 + 内容产出×0.15
export function healthScore() {
  const w = getTenantConfig('health_weights', { leads: 0.25, conversion: 0.25, repurchase: 0.15, partner: 0.20, content: 0.15 });
  const month = today().slice(0, 7);
  const goal = q.get(`SELECT * FROM goals WHERE tenant_id = ${curTenant()} AND period = ?`, month) || {};
  const targets = getTenantConfig('month_targets', { leads: 900, conversionRate: 8, repurchaseRate: 25, partnerActive: 60, contentPerDay: 10 });

  const ops = q.get(`SELECT SUM(new_leads) leads, SUM(deals) deals, SUM(content_count) content, SUM(deal_amount) amount
                     FROM daily_ops WHERE tenant_id = ${curTenant()} AND date >= ?`, monthStart()) || {};
  const dayOfMonth = new Date().getDate();

  // 1) 获客达成：月新增线索 vs 目标按日折算
  const leadsTarget = (goal.leads_target || targets.leads) * dayOfMonth / 30;
  const leadsScore = Math.min(pct(ops.leads || 0, leadsTarget), 120);

  // 2) 转化达成：线索→成交转化率 vs 基准
  const convRate = pct(ops.deals || 0, ops.leads || 0);
  const convScore = Math.min(pct(convRate, targets.conversionRate), 120);

  // 3) 复购达成：统计期内购买≥2次客户 ÷ 有购买客户
  const re = q.get(`SELECT COUNT(*) n FROM (SELECT lead_id FROM orders WHERE tenant_id = ${curTenant()} GROUP BY lead_id HAVING COUNT(*) >= 2)`);
  const buyers = q.get(`SELECT COUNT(DISTINCT lead_id) n FROM orders WHERE tenant_id = ${curTenant()}`);
  const repRate = pct(re?.n || 0, buyers?.n || 0);
  const repScore = Math.min(pct(repRate, targets.repurchaseRate), 120);

  // 4) 协作伙伴活跃率：近7天日均活跃（当日动作≥2项）÷ 总人数（沿用 partners 数据表）
  // 注意：必须固定除以 7 天。早期用 AVG(按日分组) 会漏掉"0 活跃"的日期，把日均系统性高估数倍。
  const totalPartners = q.get(`SELECT COUNT(*) n FROM partners WHERE tenant_id = ${curTenant()} AND status != '退出'`)?.n || 0;
  const active7 = q.get(`SELECT COUNT(*) n FROM partner_actions
      WHERE tenant_id = ${curTenant()} AND date >= date('now','-7 day')
        AND (studied + (posted_moments>0) + (posted_videos>0) + invited) >= 2`)?.n || 0;
  const partnerRate = pct(active7 / 7, totalPartners);   // 7天达标人次 ÷ 7 = 日均活跃数
  const partnerScore = Math.min(pct(partnerRate, targets.partnerActive), 120);

  // 5) 内容产出达成：日均内容 vs 目标
  const contentAvg = (ops.content || 0) / dayOfMonth;
  const contentScore = Math.min(pct(contentAvg, targets.contentPerDay), 120);

  const subs = [
    { key: 'leads', name: '获客能力', score: Math.round(leadsScore), weight: w.leads, note: `本月新增线索 ${ops.leads || 0}` },
    { key: 'conversion', name: '转化效率', score: Math.round(convScore), weight: w.conversion, note: `线索成交率 ${convRate}%` },
    { key: 'repurchase', name: '复购留存', score: Math.round(repScore), weight: w.repurchase, note: `复购率 ${repRate}%` },
    { key: 'partner', name: '协作伙伴活跃', score: Math.round(partnerScore), weight: w.partner, note: `日均活跃率 ${partnerRate}%` },
    { key: 'content', name: '内容产出', score: Math.round(contentScore), weight: w.content, note: `日均产出 ${Math.round(contentAvg * 10) / 10} 条` },
  ];
  const total = Math.round(subs.reduce((acc, s) => acc + Math.min(s.score, 100) * s.weight, 0));
  const level = total >= 85 ? '优秀' : total >= 70 ? '良好' : total >= 55 ? '一般' : '预警';

  // 子项低于55 → 增长机会洞察（FR-ANA 健康度联动）
  const insights = subs.filter(s => s.score < 55).map(s => ({
    dimension: s.name,
    issue: `${s.name}得分 ${s.score}，低于预警线 55`,
    suggestion: SUGGESTIONS[s.key],
  }));
  return { total, level, subs, insights };
}

const SUGGESTIONS = {
  leads: '获客不足：建议由品牌与增长部结合门店真实客群，生成短视频、社群与到店活动方案；发布频次和活动容量需由门店负责人确认',
  conversion: '转化不足：由门店运营部按客户阶段生成逐客跟进清单，高预算或需特殊权益的客户交由门店负责人确认',
  repurchase: '复购不足：调取近90天真实成交客户，按用餐偏好、最近消费与节日场景生成会员触达方案，人工确认后再外发',
  partner: '协作伙伴活跃度偏低：对连续3日无动作人员启动定向督导，下发门店已审核素材，并由负责人核对任务与打卡结果',
  content: '内容产出不足：由品牌与增长部按今日经营主题生成素材草稿；门店应核对菜品、价格、库存与活动信息后再发布',
};

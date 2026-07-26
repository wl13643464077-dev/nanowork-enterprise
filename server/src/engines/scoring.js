import { q, getTenantConfig, curTenant } from '../db.js';

// 成交概率评分模型（PRD §6.3）—— 权重可在系统配置中调整
const DEFAULT_WEIGHTS = {
  identity: { '企业主': 20, '高管': 12, '个体创业者': 10, '普通消费者': 5 },
  budget: { '高': 25, '中': 15, '低': 5, '未知': 0 },
  stage: { '已到店': 20, '已邀约': 12, '已沟通': 6, '新线索': 0, '已成交': 20, '复购': 20, '已流失': 0 },
  interact: { fresh7: 10, fresh30: 5, stale: -10 },
  concernPenalty: -5, concernFloor: -15,
  source: {
    '转介绍': 10,
    '合作伙伴推荐': 10,
    '门店活动': 5,
    '到店': 5,
    '大众点评': 5,
    '地图搜索': 5,
    '外卖平台': 3,
    // 历史来源只做旧记录评分兼容；新写入由增长/导入接口归一为上方餐饮来源。
    '合伙人推荐': 10,
    '品鉴会': 5,
  },
  gradeA: 70, gradeB: 40,
};

export function getWeights() {
  return { ...DEFAULT_WEIGHTS, ...(getTenantConfig('score_weights', {}) || {}) };
}

export function scoreLead(lead, w = getWeights()) {
  const detail = {};
  detail['身份'] = w.identity[lead.identity_tag] ?? 0;
  detail['预算'] = w.budget[lead.budget_level] ?? 0;
  detail['阶段'] = w.stage[lead.stage] ?? 0;

  let interact = w.interact.stale;
  if (lead.last_interact_at) {
    const days = (Date.now() - new Date(lead.last_interact_at + 'T00:00:00')) / 86400000;
    interact = days <= 7 ? w.interact.fresh7 : days <= 30 ? w.interact.fresh30 : w.interact.stale;
  }
  detail['互动新鲜度'] = interact;

  let concerns = [];
  try { concerns = JSON.parse(lead.concerns || '[]'); } catch { /* keep [] */ }
  const open = concerns.filter(c => !c.resolved).length;
  detail['未解决顾虑'] = Math.max(open * w.concernPenalty, w.concernFloor);

  detail['来源加权'] = w.source[lead.source] ?? 0;

  const score = Math.max(0, Math.min(100, Object.values(detail).reduce((a, b) => a + b, 0)));
  const grade = score >= w.gradeA ? 'A' : score >= w.gradeB ? 'B' : 'C';
  // 建议负责人介入：A 类 + 高预算；最终跟进人由本企业权限与组织配置决定。
  const bossAlert = (grade === 'A' && lead.budget_level === '高' && !['已成交', '复购', '已流失'].includes(lead.stage)) ? 1 : 0;
  return { score, grade, detail, bossAlert };
}

export function rescoreLead(id) {
  const lead = q.get(`SELECT * FROM leads WHERE tenant_id = ${curTenant()} AND id = ?`, id);
  if (!lead) return null;
  const { score, grade, detail, bossAlert } = scoreLead(lead);
  q.run(`UPDATE leads SET score=?, grade=?, score_detail=?, boss_alert=?, updated_at=datetime('now','localtime') WHERE id=?`,
    score, grade, JSON.stringify(detail), bossAlert, id);
  return { ...lead, score, grade, score_detail: JSON.stringify(detail), boss_alert: bossAlert };
}

export function rescoreAll() {
  const leads = q.all(`SELECT * FROM leads WHERE tenant_id = ${curTenant()}`);
  const w = getWeights();
  const upd = q.run.bind(null);
  for (const lead of leads) {
    const { score, grade, detail, bossAlert } = scoreLead(lead, w);
    q.run('UPDATE leads SET score=?, grade=?, score_detail=?, boss_alert=? WHERE id=?',
      score, grade, JSON.stringify(detail), bossAlert, lead.id);
  }
  return leads.length;
}

// 漏斗统计：五级阶段（已流失不计入）
export function funnel(where = '', ...params) {
  const stages = ['新线索', '已沟通', '已邀约', '已到店', '已成交'];
  // 漏斗按"到达过该阶段"累计：后阶段客户也算到达过前阶段
  const reach = (idx) => stages.slice(idx).concat(idx <= 4 ? ['复购'] : []);
  const counts = stages.map((s, i) => {
    const list = reach(i).map(() => '?').join(',');
    const row = q.get(`SELECT COUNT(*) n FROM leads WHERE stage IN (${list}) AND tenant_id = ${curTenant()} ${where}`, ...reach(i), ...params);
    return { stage: s, count: row.n };
  });
  const baseline = getTenantConfig('funnel_baseline', { '已沟通': 70, '已邀约': 45, '已到店': 60, '已成交': 35 });
  const result = counts.map((c, i) => {
    const rate = i === 0 ? 100 : (counts[i - 1].count > 0 ? Math.round((c.count / counts[i - 1].count) * 1000) / 10 : 0);
    const base = i === 0 ? 100 : (baseline[c.stage] ?? 50);
    return { ...c, rate, baseline: base, gap: i === 0 ? 0 : Math.round((rate - base) * 10) / 10 };
  });
  // 卡点 = 相对基准跌幅最大的层
  let bottleneck = null, worst = 0;
  for (const r of result.slice(1)) { if (r.gap < worst) { worst = r.gap; bottleneck = r.stage; } }
  return { funnel: result, bottleneck };
}

import { q, getTenantConfig, curTenant } from '../db.js';
import { today, daysAgo, isoWeek, pct } from '../util.js';
import { funnel } from './scoring.js';

// ===== 节日节点表（餐饮门店消费日历驱动）=====
const FESTIVALS = [
  { date: '2026-06-19', name: '端午节', theme: '端午到店聚餐' },
  { date: '2026-08-25', name: '七夕', theme: '七夕双人用餐' },
  { date: '2026-09-25', name: '中秋节', theme: '中秋家庭聚餐' },
  { date: '2026-10-01', name: '国庆节', theme: '国庆多人聚餐' },
  { date: '2026-12-20', name: '企业年会季', theme: '年会与团建用餐' },
  { date: '2027-02-11', name: '春节', theme: '春节团圆餐' },
];
export function nextFestival(withinDays = 30) {
  const t = today();
  return FESTIVALS.find(f => f.date >= t && (new Date(f.date) - new Date(t)) / 86400000 <= withinDays) || null;
}

const money = (n = 0) => `¥${Math.round(Number(n) || 0).toLocaleString()}`;
const rateText = (r = 0) => `${Math.round((Number(r) || 0) * 100)}%`;
const compactNames = (rows = [], field = 'name', max = 5) => rows.slice(0, max).map(x => x[field]).filter(Boolean).join('、') || '暂无';
export const BATTLE_PLAN_VERSION = 3;

function pendingApprovalBossItems() {
  const rows = q.all(`SELECT title,risk_level,approval_level FROM approvals
    WHERE tenant_id = ${curTenant()} AND status = '待审核'
    ORDER BY created_at DESC,id DESC`);
  const bossReview = rows.filter(row => row.approval_level === 'boss');
  const highRisk = rows.filter(row => row.approval_level !== 'boss' && row.risk_level === 'high');
  const routine = rows.filter(row => row.approval_level !== 'boss' && row.risk_level !== 'high');
  const singleTitle = list => list.length === 1 && list[0]?.title
    ? `：${String(list[0].title).slice(0, 60)}`
    : '';
  return [
    ...(bossReview.length ? [`${bossReview.length} 条老板终审事项待处理${singleTitle(bossReview)}`] : []),
    ...(highRisk.length ? [`${highRisk.length} 条高风险事项待审批${singleTitle(highRisk)}`] : []),
    ...(routine.length ? [`${routine.length} 条事项待审批${singleTitle(routine)}`] : []),
  ];
}

// ===== 每日作战计划引擎（CTRL-02 / PRD §9.3）=====
// 只读构建器：可用于 GET 时刷新动态信号，不暗中改写 battle_plans。
export function buildBattlePlan(date = today(), fixed = {}) {
  const yesterday = daysAgo(1);
  const yOps = q.get(`SELECT * FROM daily_ops WHERE tenant_id = ${curTenant()} AND date = ?`, yesterday) || {};
  const { funnel: fn, bottleneck } = funnel();
  const fest = nextFestival(14);
  const month = date.slice(0, 7);
  const goal = q.get(`SELECT * FROM goals WHERE tenant_id = ${curTenant()} AND period = ?`, month) || {};
  const mOps = q.get(`SELECT SUM(deal_amount) amount, SUM(deals) deals FROM daily_ops WHERE tenant_id = ${curTenant()} AND date >= ?`, month + '-01') || {};

  // 主题优先级：节日临近 > 漏斗卡点 > 目标缺口
  let theme, audience;
  if (fest) { theme = `${fest.theme}预热战役`; audience = '企业主与老客户'; }
  else if (bottleneck === '已邀约' || bottleneck === '已到店') { theme = '到店活动邀约优化'; audience = 'B类培育客户'; }
  else if (bottleneck === '已成交') { theme = 'A类客户成交攻坚'; audience = 'A类高意向客户'; }
  else { theme = '门店招牌产品内容日更'; audience = '新流量人群'; }
  if (fixed.theme) theme = String(fixed.theme);
  if (fixed.audience) audience = String(fixed.audience);

  // 邀约目标 = 目标缺口反推：缺口成交数 ÷ 到店成交率 ÷ 邀约到店率
  const target = goal.revenue_target || getTenantConfig('month_revenue_target', 500000);
  const gapAmount = Math.max(0, target - (mOps.amount || 0));
  const avgDeal = getTenantConfig('avg_deal_amount', 120);
  const [, monthNumber, dayNumber] = date.split('-').map(Number);
  const yearNumber = Number(date.slice(0, 4));
  const daysInMonth = new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate();
  const daysLeft = Math.max(1, daysInMonth - dayNumber + 1);
  const needDealsPerDay = Math.ceil(gapAmount / avgDeal / daysLeft);
  const arriveRate = getTenantConfig('arrive_deal_rate', 0.25);
  const inviteArriveRate = getTenantConfig('invite_arrive_rate', 0.6);
  const inviteTarget = Math.max(3, Math.ceil(needDealsPerDay / arriveRate / inviteArriveRate));
  const expectedArrivals = Math.max(1, Math.ceil(inviteTarget * inviteArriveRate));

  // 重点跟进名单：A类 + 超期 + 即将成交（上限10）
  const focusLeads = q.all(`
    SELECT id, name, grade, stage, score, next_action FROM leads
    WHERE tenant_id = ${curTenant()} AND stage NOT IN ('已成交','复购','已流失')
      AND (grade = 'A' OR next_follow_at < datetime('now','localtime') OR score >= 80)
    ORDER BY score DESC LIMIT 10`);

  // 沉默协作伙伴（沿用 partners 数据表）
  const silent = q.all(`
    SELECT p.id, p.name, p.region FROM partners p
    WHERE p.tenant_id = ${curTenant()} AND p.status = '活跃' AND p.id NOT IN (
      SELECT partner_id FROM partner_actions
      WHERE date >= date('now','-2 day') AND (studied + (posted_moments>0) + (posted_videos>0) + invited) >= 2
    ) LIMIT 8`);

  // 待老板确认事项
  const approvalBossItems = pendingApprovalBossItems();
  const bossLeads = q.all(`SELECT name, score FROM leads WHERE tenant_id = ${curTenant()} AND boss_alert = 1 AND stage NOT IN ('已成交','复购','已流失') ORDER BY score DESC,id DESC LIMIT 5`);

  const contentWeek = q.get(`SELECT COUNT(*) pieces, COALESCE(SUM(effect_leads),0) leads
    FROM contents WHERE tenant_id = ${curTenant()} AND created_at >= date(?, '-6 day')`, date) || {};
  const pendingContent = q.get(`SELECT COUNT(*) n FROM contents
    WHERE tenant_id = ${curTenant()} AND status IN ('草稿','待审核') AND created_at >= date(?, '-2 day')`, date)?.n || 0;
  const readyInviteLeads = q.get(`SELECT COUNT(*) n FROM leads
    WHERE tenant_id = ${curTenant()} AND stage IN ('已沟通','已邀约','已到店') AND stage NOT IN ('已成交','复购','已流失')`)?.n || 0;
  const aLeadCount = q.get(`SELECT COUNT(*) n FROM leads
    WHERE tenant_id = ${curTenant()} AND grade = 'A' AND stage NOT IN ('已成交','复购','已流失')`)?.n || 0;
  const overdueLeadCount = q.get(`SELECT COUNT(*) n FROM leads
    WHERE tenant_id = ${curTenant()} AND next_follow_at < datetime('now','localtime') AND stage NOT IN ('已成交','复购','已流失')`)?.n || 0;
  const activePartnerCount = q.get(`SELECT COUNT(*) n FROM partners WHERE tenant_id = ${curTenant()} AND status = '活跃'`)?.n || 0;
  const partnerWeek = q.get(`SELECT COUNT(DISTINCT partner_id) active, COALESCE(SUM(invite_count),0) invites,
      COALESCE(SUM(arrive_count),0) arrives, COALESCE(SUM(deal_count),0) deals
    FROM partner_actions WHERE tenant_id = ${curTenant()} AND date >= date(?, '-6 day')`, date) || {};

  const contentBasis = {
    shortSource: '战役主题 + 内容标准包',
    source: '来自今日主推战役、目标人群和内容生产仓标准投放包，不直接按销售回款额拆出来。',
    target: '11条素材：3条短视频脚本 + 5条朋友圈 + 3条社群话题',
    formula: '1个主推主题 × 3类触点（短视频/朋友圈/社群） × 标准数量包 = 11条可分发素材。',
    evidence: [
      `今日主题：${theme}`,
      `主推人群：${audience}`,
      `昨日新增线索 ${yOps.new_leads || 0} 条，需要内容先完成种草、信任铺垫和转发素材补给`,
      `近7天内容产出 ${contentWeek.pieces || 0} 条，带来线索 ${contentWeek.leads || 0} 条；当前待人工审阅/草稿 ${pendingContent} 条`,
    ],
    rules: [
      '内容任务服务于获客、邀约和协作伙伴转发，不把它解释成“销售直接完成金额”。',
      '如果今日有节日或活动主题，内容优先围绕用餐场景、到店活动、招牌产品和老客转介绍生成。',
      '检查标准：真实输出先通过质检再进入待人工审阅；只有人工已采纳才可进入发布，模板/降级/契约失败均不算完成。',
    ],
  };

  const inviteBasis = {
    shortSource: '月缺口 + 邀约/到店/成交转化率',
    source: '来自月度回款缺口、平均客单价、邀约到店率和到店成交率反推，不是简单按销售目标平摊。',
    target: `今日电话/微信双触达 ${inviteTarget} 人，预计锁定到店/到会 ${expectedArrivals} 人，支撑日均成交 ${needDealsPerDay} 单`,
    formula: `本月缺口 ${money(gapAmount)} ÷ 客单价 ${money(avgDeal)} ÷ 剩余 ${daysLeft} 天 = 日均需成交 ${needDealsPerDay} 单；再 ÷ 到店成交率 ${rateText(arriveRate)} ÷ 邀约到店率 ${rateText(inviteArriveRate)} = 今日邀约触达 ${inviteTarget} 人。`,
    evidence: [
      `昨日邀约 ${yOps.invited || 0} 人、到店 ${yOps.arrived || 0} 人、成交 ${yOps.deals || 0} 单、回款 ${money(yOps.deal_amount || 0)}`,
      `CRM中已沟通/已邀约/已到店可推进客户 ${readyInviteLeads} 人`,
      bottleneck ? `当前漏斗卡点在「${bottleneck}」，电话邀约优先补这个环节` : '当前漏斗无明显低于基准环节，保持保底邀约动作',
    ],
    rules: [
      '电话邀约优先选已沟通、已邀约、已到店和高分客户，不从冷名单平均拨打。',
      '邀约结果必须回写CRM：已邀约、已到店、拒绝原因、下次跟进时间。',
      '如果到店率低，就复盘话术和确认SOP；如果成交率低，就复盘现场促成和政策表达。',
    ],
    relatedDrill: 'goals',
  };

  const followBasis = {
    shortSource: '重点客户池 + 跟进超期',
    source: '来自重点客户列表、即将成交客户和建议老板介入名单，不是从销售额直接拆给员工。',
    target: `跟进 ${focusLeads.length} 位重点客户：${compactNames(focusLeads)}`,
    formula: 'A类客户 / 评分≥80 / 跟进超期 / 老板介入标记 → 按成交评分倒序取前10 → 逐一推进下一步动作。',
    evidence: [
      `当前A类未成交客户 ${aLeadCount} 人`,
      `跟进已超期客户 ${overdueLeadCount} 人`,
      `本次入选客户：${compactNames(focusLeads, 'name', 10)}`,
    ],
    rules: [
      '重点跟进看客户阶段、预算、顾虑和最近互动，不按销售人员主观挑选。',
      '跟进完成后必须写入跟进记录，沉淀沟通内容、客户顾虑、AI建议和下次跟进时间。',
      '高预算A类客户或需要价格/政策拍板的客户，进入老板介入或待确认事项。',
    ],
  };

  const partnerBasis = {
    shortSource: '协作伙伴活跃档案 + 每日动作闭环',
    source: '来自协作伙伴活跃分层、近7天打卡/邀约/到店数据和沉默名单，不来自销售回款表。',
    target: `下发1套每日任务包，覆盖 ${activePartnerCount} 位活跃协作伙伴；每人的邀约目标需由负责人结合客群确认`,
    formula: '学习卡 + 已审核素材 + 经负责人确认的邀约目标 + 晚间回收打卡；近7天动作少于门店标准的协作伙伴进入督导/唤醒。',
    evidence: [
      `当前活跃协作伙伴 ${activePartnerCount} 人，近7天有动作 ${partnerWeek.active || 0} 人`,
      `近7天协作伙伴邀约 ${partnerWeek.invites || 0} 人、到店 ${partnerWeek.arrives || 0} 人、成交 ${partnerWeek.deals || 0} 单`,
      `低活跃协作伙伴 ${silent.length} 人：${compactNames(silent, 'name', 5)}`,
    ],
    rules: [
      '协作伙伴任务包看“学习、转发、邀约、到店、成交、反馈”动作链，不只看最终回款。',
      '低活跃协作伙伴要先给已审核素材和具体邀约场景，再由负责人督导。',
      '晚间打卡数据回流到协作伙伴分类，影响次日任务和管理层提醒。',
    ],
  };

  const silentBasis = {
    shortSource: '沉默名单 + 48小时激活',
    source: '来自协作伙伴近2天动作缺失名单，用于运营督导，不来自销售目标平摊。',
    target: `定向唤醒 ${silent.length} 位低活跃协作伙伴`,
    formula: '近2天学习/转发/邀约动作不足 → 进入沉默名单 → 运营总监定向督导 → 次日检查动作率。',
    evidence: [`沉默名单：${compactNames(silent, 'name', 8)}`],
    rules: ['督导重点是恢复动作：确认卡点、补素材、给具体邀约场景和截止时间。'],
  };

  const plan = {
    planVersion: BATTLE_PLAN_VERSION,
    date, theme, audience, bottleneck,
    festival: fest,
    yesterday: { newLeads: yOps.new_leads || 0, invited: yOps.invited || 0, arrived: yOps.arrived || 0, deals: yOps.deals || 0, amount: yOps.deal_amount || 0 },
    tasks: [
      { type: '内容', action: `生成一键日更包（3条短视频脚本+5条朋友圈+3条社群话题），主题：${theme}`, owner: '品牌与增长部→内容工具箱', count: 11, due: '10:00', check: '真实输出质检通过并进入待人工审阅，或已人工采纳；模板/降级/契约失败不算完成', basis: contentBasis },
      { type: '邀约', action: `电话+微信双触邀约，目标触达 ${inviteTarget} 人，预计到店/到会 ${expectedArrivals} 人，话术由AI生成人工确认后使用`, owner: '销售团队', count: inviteTarget, due: '18:00', check: '邀约结果回写CRM', basis: inviteBasis },
      { type: '跟进', action: `重点客户逐一跟进（${focusLeads.length}人），按评分倒序，先A后B`, owner: '销售成交官辅助', count: focusLeads.length, due: '20:00', check: '每客户新增1条跟进记录', basis: followBasis },
      { type: '培训', action: `下发协作伙伴每日任务包（学习卡+已审核素材+邀约目标，覆盖${activePartnerCount || 0}人）`, owner: '连锁与可持续部', count: Math.max(1, activePartnerCount), due: '06:30', check: '晚21:00回收打卡', basis: partnerBasis },
      ...(silent.length ? [{ type: '督导', action: `定向督导低活跃协作伙伴 ${silent.length} 人：${silent.slice(0, 3).map(s => s.name).join('、')}等`, owner: '连锁与可持续部', count: silent.length, due: '15:00', check: '次日检查实际动作并记录阻碍', basis: silentBasis }] : []),
    ],
    focusLeads, silentPartners: silent,
    bossItems: [
      ...approvalBossItems,
      ...bossLeads.map(l => `建议亲自跟进大客户「${l.name}」（成交概率 ${l.score} 分）`),
    ],
    briefing: [
      { text: `昨日战果：新增线索 ${yOps.new_leads || 0}，邀约 ${yOps.invited || 0}，到店 ${yOps.arrived || 0}，成交 ${yOps.deals || 0} 单 / ¥${(yOps.deal_amount || 0).toLocaleString()}`, link: '/analysis', source: '经营数据表·昨日行' },
      bottleneck ? { text: `漏斗诊断：当前最大卡点在「${bottleneck}」环节，今日资源向该环节倾斜`, link: '/growth', source: '线索漏斗·基准对比' } : { text: '漏斗各环节转化率均在基准之上', link: '/growth', source: '线索漏斗' },
      { text: `今日主推：${theme}（人群：${audience}）`, link: '/content', source: '作战计划引擎·主题决策' },
      fest ? { text: `节点提醒：${fest.name}（${fest.date}）临近，${fest.theme}方案需在7天前完成触达`, link: '/activities', source: '节日日历' } : null,
      { text: `本月目标缺口 ¥${gapAmount.toLocaleString()}，按当前客单需日均成交 ${needDealsPerDay} 单，反推今日邀约目标 ${inviteTarget} 人`, link: '/execution', source: '目标拆解·缺口反推公式' },
    ].filter(Boolean),
  };

  return plan;
}

// 已下发的任务保持稳定，但将审批、介入线索、昨日战果等会变信号刷新到当前真实状态。
export function refreshBattlePlanSnapshot(plan, date = today()) {
  const stored = plan && typeof plan === 'object' ? plan : {};
  const fresh = buildBattlePlan(date, {
    theme: stored.theme,
    audience: stored.audience,
  });
  return {
    ...stored,
    planVersion: Math.max(Number(stored.planVersion || 0), Number(fresh.planVersion || 0)),
    date,
    theme: stored.theme || fresh.theme,
    audience: stored.audience || fresh.audience,
    bottleneck: fresh.bottleneck,
    festival: fresh.festival,
    yesterday: fresh.yesterday,
    focusLeads: fresh.focusLeads,
    silentPartners: fresh.silentPartners,
    bossItems: fresh.bossItems,
    briefing: fresh.briefing,
    tasks: Array.isArray(stored.tasks) && stored.tasks.length ? stored.tasks : fresh.tasks,
  };
}

// 显式“生成/重新生成”才持久化；普通读取不应产生写入副作用。
export function generateBattlePlan(date = today()) {
  const plan = buildBattlePlan(date);
  q.run(`INSERT INTO battle_plans(date,theme,audience,plan) VALUES(?,?,?,?)
         ON CONFLICT(tenant_id,date) DO UPDATE SET theme=excluded.theme, audience=excluded.audience, plan=excluded.plan`,
    date, plan.theme, plan.audience, JSON.stringify(plan));
  return plan;
}

// ===== 每周经营复盘引擎（CTRL-03 / DASH-06 / DASH-07）=====
export function generateWeeklyReview(weekOf = today()) {
  const week = isoWeek(weekOf);
  const cur = q.get(`SELECT SUM(new_leads) leads, SUM(invited) invited, SUM(arrived) arrived, SUM(deals) deals,
                     SUM(deal_amount) amount, SUM(repurchase_amount) rep, SUM(content_count) content
                     FROM daily_ops WHERE tenant_id = ${curTenant()} AND date >= date(?, '-6 day') AND date <= ?`, weekOf, weekOf) || {};
  const prev = q.get(`SELECT SUM(new_leads) leads, SUM(invited) invited, SUM(arrived) arrived, SUM(deals) deals,
                      SUM(deal_amount) amount FROM daily_ops WHERE tenant_id = ${curTenant()} AND date >= date(?, '-13 day') AND date < date(?, '-6 day')`, weekOf, weekOf) || {};
  const wow = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : (a > 0 ? 100 : 0));

  const { funnel: fn, bottleneck } = funnel();
  const topContents = q.all(`SELECT id, type, title, effect_leads FROM contents
    WHERE tenant_id = ${curTenant()} AND created_at >= date(?, '-6 day') AND status IN ('可使用','已发布') ORDER BY effect_leads DESC LIMIT 3`, weekOf);
  const keyProgress = q.all(`SELECT l.name, l.grade, l.stage, f.content FROM follow_ups f JOIN leads l ON l.id = f.lead_id
    WHERE f.tenant_id = ${curTenant()} AND f.created_at >= date(?, '-6 day') AND l.grade = 'A' ORDER BY f.created_at DESC LIMIT 5`, weekOf);
  const board = q.all(`SELECT p.name, SUM(a.score) total FROM partner_actions a JOIN partners p ON p.id = a.partner_id
    WHERE a.tenant_id = ${curTenant()} AND a.date >= date(?, '-6 day') GROUP BY p.id ORDER BY total DESC LIMIT 5`, weekOf);
  const lost = q.all(`SELECT lost_reason, COUNT(*) n FROM leads
    WHERE tenant_id = ${curTenant()} AND stage = '已流失' AND updated_at >= date(?, '-6 day') AND lost_reason IS NOT NULL GROUP BY lost_reason ORDER BY n DESC LIMIT 3`, weekOf);

  const fest = nextFestival(21);
  const nextTheme = fest ? `${fest.theme}战役` : bottleneck ? `攻克「${bottleneck}」转化卡点` : '门店本地客群增长战役';
  const keyActions = [
    fest ? `提前${Math.round((new Date(fest.date) - new Date(weekOf)) / 86400000)}天启动${fest.name}触达：目标客户名单+用餐方案+已审核权益说明` : `针对「${bottleneck || '邀约'}」环节开展专项：话术升级+老客带新`,
    'A类客户周内全覆盖跟进；高预算、特殊折扣或对外承诺由门店负责人确认',
    '协作伙伴按真实动作完成度复盘，低活跃名单定向帮扶',
  ];

  const report = {
    week, range: `${q.get(`SELECT date(?, '-6 day') d`, weekOf)?.d} ~ ${weekOf}`,
    metrics: {
      新增线索: { value: cur.leads || 0, wow: wow(cur.leads || 0, prev.leads || 0) },
      邀约人数: { value: cur.invited || 0, wow: wow(cur.invited || 0, prev.invited || 0) },
      到店人数: { value: cur.arrived || 0, wow: wow(cur.arrived || 0, prev.arrived || 0) },
      成交单数: { value: cur.deals || 0, wow: wow(cur.deals || 0, prev.deals || 0) },
      成交金额: { value: cur.amount || 0, wow: wow(cur.amount || 0, prev.amount || 0) },
      复购金额: { value: cur.rep || 0, wow: 0 },
    },
    funnel: fn, bottleneck,
    diagnosis: bottleneck
      ? `本周最大卡点：「${bottleneck}」环节转化率低于本企业配置基准。${bottleneck === '已邀约' ? '建议检查邀约话术与触达时机，并用真实历史数据评估老客带新' : bottleneck === '已到店' ? '建议优化确认SOP：活动前确认、当天提醒，并记录未到原因' : bottleneck === '已成交' ? '建议复盘到店后的需求识别、产品介绍和已授权权益说明，禁止制造虚假稀缺' : '建议检查首触响应速度，并以门店实际服务能力设定时限'}`
      : '本周漏斗各环节均达基准，建议把资源投向获客放大',
    topContents, keyProgress, partnerBoard: board, lostReasons: lost,
    nextWeek: { theme: nextTheme, actions: keyActions, festival: fest },
  };

  q.run(`INSERT INTO weekly_reviews(week,report) VALUES(?,?)
         ON CONFLICT(tenant_id,week) DO UPDATE SET report=excluded.report`, week, JSON.stringify(report));
  return report;
}

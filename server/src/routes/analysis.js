import { Router } from 'express';
import { q , curTenant } from '../db.js';
import { daysAgo, logOp, monthStart, pct, today, safeJsonParse } from '../util.js';
import { healthScore } from '../engines/health.js';
import { generateWeeklyReview } from '../engines/plans.js';
import { funnel } from '../engines/scoring.js';
import { hasFullDataAccess, userScopeClause } from '../engines/access.js';
import employeeOutputRoutes from './employee-outputs.js';

const r = Router();

r.use('/employee-outputs', employeeOutputRoutes);

function range(req) {
  const { start, end } = req.query;
  return [start || daysAgo(29), end || today()];
}
function leadScope(req, column = 'l.owner_id') {
  return userScopeClause(req.user, column);
}

const countOf = (sql, ...params) => q.get(sql, ...params)?.n || 0;
const canSeeFinance = (user) => ['boss', 'ops_director', 'admin', 'platform_super'].includes(user?.role);
const GROSS_MARGIN_MISSING_FIELDS = [
  '净销售额口径',
  '菜品/商品销货成本',
  '期初与期末库存',
  '包装、配送及渠道可变成本',
  '退款、折扣与活动费用分摊',
];

function detailPayload(res, title, note, columns, rows, logs = []) {
  res.json({ title, note, columns, rows, logs });
}

const orderColumns = [
  { title: '客户', dataIndex: 'customer' },
  { title: '身份', dataIndex: 'identity_tag' },
  { title: '产品', dataIndex: 'product' },
  { title: '金额', dataIndex: 'amount', type: 'money' },
  { title: '类型', dataIndex: 'type' },
  { title: '渠道', dataIndex: 'channel' },
  { title: '区域', dataIndex: 'region' },
  { title: '时间', dataIndex: 'created_at' },
];

const leadColumns = [
  { title: '客户', dataIndex: 'name' },
  { title: '身份', dataIndex: 'identity_tag' },
  { title: '阶段', dataIndex: 'stage' },
  { title: '等级', dataIndex: 'grade' },
  { title: '评分', dataIndex: 'score' },
  { title: '来源', dataIndex: 'source' },
  { title: '路径', dataIndex: 'path_type' },
  { title: '负责人', dataIndex: 'owner' },
  { title: '最近动作', dataIndex: 'updated_at' },
];

function analysisDetail(res, title, note, columns, rows, extra = {}) {
  res.json({ title, note, columns, rows, ...extra });
}

function orderRows(req, extra = '', extraParams = [], limit = 120) {
  const [s, e] = range(req);
  const scope = leadScope(req);
  return q.all(`SELECT o.id, o.lead_id, o.product, o.amount, o.type, o.channel, o.region, o.created_at,
      l.name customer, l.identity_tag
    FROM orders o
    LEFT JOIN leads l ON l.id = o.lead_id
    WHERE o.tenant_id = ${curTenant()} AND o.created_at BETWEEN ? AND ? || ' 23:59'${scope.sql}${extra ? ` AND (${extra})` : ''}
    ORDER BY o.created_at DESC
    LIMIT ${limit}`, s, e, ...scope.params, ...extraParams);
}

function leadRows(req, extra = '', extraParams = [], limit = 120) {
  const scope = userScopeClause(req.user, 'l.owner_id');
  return q.all(`SELECT l.id lead_id, l.id, l.name, l.identity_tag, l.stage, l.grade, l.score, l.source, l.path_type,
      COALESCE(u.name, '-') owner, l.updated_at,
      COUNT(DISTINCT f.id) follow_count,
      COALESCE(SUM(o.amount), 0) deal_amount
    FROM leads l
    LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.owner_id
    LEFT JOIN follow_ups f ON f.tenant_id = l.tenant_id AND f.lead_id = l.id
    LEFT JOIN orders o ON o.tenant_id = l.tenant_id AND o.lead_id = l.id
    WHERE l.tenant_id = ${curTenant()}${scope.sql}${extra ? ` AND (${extra})` : ''}
    GROUP BY l.id
    ORDER BY l.score DESC, l.updated_at DESC
    LIMIT ${limit}`, ...scope.params, ...extraParams);
}

r.get('/source-map', (req, res) => {
  const scope = userScopeClause(req.user, 'owner_id');
  const leadVisible = countOf(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()}${scope.sql}`, ...scope.params);
  const orderScope = leadScope(req);
  const orderVisible = countOf(`SELECT COUNT(*) n FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id = ${curTenant()}${orderScope.sql}`, ...orderScope.params);
  const contentScope = userScopeClause(req.user, 'creator_id');
  const contentVisible = countOf(`SELECT COUNT(*) n FROM contents WHERE tenant_id = ${curTenant()}${contentScope.sql}`, ...contentScope.params);
  const financeVisible = canSeeFinance(req.user);
  res.json({
    cards: [
      {
        key: 'daily_ops',
        title: '日经营数据表',
        tables: 'daily_ops',
        count: countOf(`SELECT COUNT(*) n FROM daily_ops WHERE tenant_id = ${curTenant()}`),
        owner: '员工每日上报 + 系统自动汇总',
        upload: '可补录：新增线索、邀约、到店、内容数、活跃合伙人；成交/复购由订单自动归集',
        trace: '经营分析趋势点 → 当日明细 → 订单/客户档案',
      },
      {
        key: 'growth',
        title: '客户与订单事实源',
        tables: 'leads / follow_ups / orders',
        count: leadVisible,
        owner: '增长中心、私域跟进、客户阶段推进',
        upload: '批量导入线索在增长中心；成交金额随客户推进和订单生成写入',
        trace: `当前账号可见客户 ${leadVisible} 个，可见订单 ${orderVisible} 笔`,
      },
      {
        key: 'content',
        title: '内容与活动联动',
        tables: 'contents / media_jobs / activities',
        count: contentVisible,
        owner: '内容生产仓、活动中心、数字员工产出',
        upload: '内容生成、活动战果导入后自动影响经营分析与数据资产',
        trace: '内容效果TOP、活动复盘、素材导入均可回链到原记录',
      },
      {
        key: 'finance',
        title: '费用与利润口径',
        tables: 'daily_ops.marketing_cost / orders.amount',
        count: financeVisible ? countOf(`SELECT COUNT(*) n FROM daily_ops WHERE tenant_id = ${curTenant()} AND marketing_cost > 0`) : 0,
        owner: '老板/总监可见，员工端脱敏',
        upload: financeVisible ? '可补录营销费用；真实销货成本与库存口径未接入前，毛利保持不可用' : '员工端不可见费用和利润明细',
        trace: '营销费用钻取 → 日费用 → 获客成本 / 费比',
      },
    ],
    rules: [
      '成交单数、成交金额、复购金额以客户订单为唯一事实源，避免人工重复上报。',
      '员工只补自己负责的过程数据；经理看下属，老板看全局。',
      '所有人工补录都会写操作日志，可从经营分析和总控台追到来源。',
    ],
  });
});

r.post('/daily-upload', (req, res) => {
  const b = req.body || {};
  const date = String(b.date || today()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日期格式必须为 YYYY-MM-DD' });
  const canSeeFinance = ['boss', 'ops_director', 'admin', 'platform_super'].includes(req.user.role);
  const nums = {
    new_leads: Math.max(0, Number(b.new_leads) || 0),
    invited: Math.max(0, Number(b.invited) || 0),
    arrived: Math.max(0, Number(b.arrived) || 0),
    content_count: Math.max(0, Number(b.content_count) || 0),
    active_partners: Math.max(0, Number(b.active_partners) || 0),
    marketing_cost: canSeeFinance ? Math.max(0, Number(b.marketing_cost) || 0) : 0,
  };
  const weekProblem = String(b.week_problem || '').trim().slice(0, 300);
  const nextAction = String(b.next_action || '').trim().slice(0, 300);
  const hasAny = Object.values(nums).some(v => v > 0) || weekProblem || nextAction;
  if (!hasAny) return res.status(400).json({ error: '至少补录一项过程数据或经营备注' });
  q.run(`INSERT INTO daily_ops(date,new_leads,invited,arrived,content_count,active_partners,marketing_cost,week_problem,next_action)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id,date) DO UPDATE SET
           new_leads = new_leads + excluded.new_leads,
           invited = invited + excluded.invited,
           arrived = arrived + excluded.arrived,
           content_count = content_count + excluded.content_count,
           active_partners = active_partners + excluded.active_partners,
           marketing_cost = marketing_cost + excluded.marketing_cost,
           week_problem = CASE WHEN excluded.week_problem != '' THEN excluded.week_problem ELSE week_problem END,
           next_action = CASE WHEN excluded.next_action != '' THEN excluded.next_action ELSE next_action END`,
    date, nums.new_leads, nums.invited, nums.arrived, nums.content_count, nums.active_partners, nums.marketing_cost, weekProblem, nextAction);
  logOp(req.user, '经营分析', '补录经营数据', `${date} ${Object.entries(nums).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  res.json({ ok: true, date, added: nums, message: '已写入经营分析事实表，成交/复购仍以订单为准' });
});

r.get('/source-samples/:key', (req, res) => {
  const key = req.params.key;
  const financeVisible = canSeeFinance(req.user);
  const opScope = userScopeClause(req.user, 'user_id');
  const logs = q.all(`SELECT username, action, target, created_at FROM op_logs
    WHERE tenant_id = ${curTenant()} AND module = '经营分析'${opScope.sql}
    ORDER BY created_at DESC LIMIT 10`, ...opScope.params);

  if (key === 'daily_ops') {
    const cols = [
      { title: '日期', dataIndex: 'date' },
      { title: '内容', dataIndex: 'content_count' },
      { title: '新增线索', dataIndex: 'new_leads' },
      { title: '邀约', dataIndex: 'invited' },
      { title: '到店', dataIndex: 'arrived' },
      { title: '活跃合伙人', dataIndex: 'active_partners' },
      ...(financeVisible ? [{ title: '营销费用', dataIndex: 'marketing_cost' }] : []),
      { title: '问题', dataIndex: 'week_problem' },
      { title: '下一步', dataIndex: 'next_action' },
    ];
    const rows = q.all(`SELECT date, content_count, new_leads, invited, arrived, active_partners,
        ${financeVisible ? 'marketing_cost,' : ''}
        week_problem, next_action
      FROM daily_ops
      WHERE tenant_id = ${curTenant()}
      ORDER BY date DESC LIMIT 14`);
    return detailPayload(res, '日经营数据表样本', 'daily_ops 是经营分析的过程事实表；人工补录会写操作日志，成交/复购仍以订单表为准，避免重复计算。', cols, rows, logs);
  }

  if (key === 'growth') {
    const scope = leadScope(req, 'l.owner_id');
    const rows = q.all(`SELECT l.id, l.name, l.stage, l.grade, l.score, l.source,
        COALESCE(u.name, '-') owner, COUNT(DISTINCT f.id) follow_count,
        COALESCE(SUM(o.amount), 0) deal_amount, MAX(COALESCE(f.created_at, o.created_at, l.updated_at)) last_at
      FROM leads l
      LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.owner_id
      LEFT JOIN follow_ups f ON f.tenant_id = l.tenant_id AND f.lead_id = l.id
      LEFT JOIN orders o ON o.tenant_id = l.tenant_id AND o.lead_id = l.id
      WHERE l.tenant_id = ${curTenant()}${scope.sql}
      GROUP BY l.id
      ORDER BY last_at DESC LIMIT 20`, ...scope.params);
    return detailPayload(res, '客户与订单事实源样本', '客户、跟进和订单是增长/营收分析的事实源；当前账号只返回自己可见范围内的客户与订单。', [
      { title: '客户', dataIndex: 'name' },
      { title: '阶段', dataIndex: 'stage' },
      { title: '等级', dataIndex: 'grade' },
      { title: '评分', dataIndex: 'score' },
      { title: '来源', dataIndex: 'source' },
      { title: '负责人', dataIndex: 'owner' },
      { title: '跟进数', dataIndex: 'follow_count' },
      { title: '成交额', dataIndex: 'deal_amount' },
      { title: '最近动作', dataIndex: 'last_at' },
    ], rows);
  }

  if (key === 'content') {
    const scope = userScopeClause(req.user, 'c.creator_id');
    const rows = q.all(`SELECT c.id, c.type, c.title, c.topic, c.status,
        COALESCE(u.name, '-') creator, c.effect_views, c.effect_leads, c.created_at
      FROM contents c
      LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.creator_id
      WHERE c.tenant_id = ${curTenant()}${scope.sql}
      ORDER BY c.created_at DESC LIMIT 20`, ...scope.params);
    return detailPayload(res, '内容与活动联动样本', '内容生成、发布登记、素材入库和活动复盘会进入内容效果、数据资产和周复盘；员工只看自己的内容产出。', [
      { title: '类型', dataIndex: 'type' },
      { title: '标题', dataIndex: 'title' },
      { title: '主题', dataIndex: 'topic' },
      { title: '状态', dataIndex: 'status' },
      { title: '创建人', dataIndex: 'creator' },
      { title: '浏览', dataIndex: 'effect_views' },
      { title: '线索', dataIndex: 'effect_leads' },
      { title: '时间', dataIndex: 'created_at' },
    ], rows);
  }

  if (key === 'finance') {
    if (!financeVisible) return res.status(403).json({ error: '费用与利润明细仅老板/总监可见' });
    const rows = q.all(`SELECT d.date, d.marketing_cost, d.deal_amount, d.new_leads,
        CASE WHEN d.deal_amount > 0 THEN ROUND(d.marketing_cost * 1000.0 / d.deal_amount) / 10 ELSE 0 END fee_rate,
        CASE WHEN d.new_leads > 0 THEN ROUND(d.marketing_cost / d.new_leads) ELSE 0 END lead_cost
      FROM daily_ops d
      WHERE d.tenant_id = ${curTenant()} AND (d.marketing_cost > 0 OR d.deal_amount > 0)
      ORDER BY d.date DESC LIMIT 20`);
    return detailPayload(res, '费用与利润口径样本', '营销费用来自 daily_ops 补录，营收来自订单归集；真实销货成本、库存和费用分摊未接入前不计算毛利，员工端不展示财务明细。', [
      { title: '日期', dataIndex: 'date' },
      { title: '营销费用', dataIndex: 'marketing_cost' },
      { title: '营收', dataIndex: 'deal_amount' },
      { title: '新增线索', dataIndex: 'new_leads' },
      { title: '费比%', dataIndex: 'fee_rate' },
      { title: '获客成本', dataIndex: 'lead_cost' },
    ], rows, logs);
  }

  res.status(404).json({ error: '未知来源类型' });
});

r.get('/visual-drill/:kind', (req, res) => {
  const kind = req.params.kind;
  const [s, e] = range(req);
  const channel = String(req.query.channel || '').trim();
  const product = String(req.query.product || '').trim();
  const region = String(req.query.region || '').trim();
  const identity = String(req.query.identity || '').trim();
  const path = String(req.query.path || '').trim();
  const metric = String(req.query.metric || '').trim();
  const date = String(req.query.date || '').trim();
  const part = String(req.query.part || '').trim();
  const dimension = String(req.query.dimension || '').trim();

  if (kind === 'channel') {
    if (!channel) return res.status(400).json({ error: '缺少渠道' });
    return analysisDetail(res, `${channel}渠道订单明细`, '来自“渠道业绩占比”。这里按当前统计区间列出该渠道订单，点击订单行可继续进入客户档案。', orderColumns, orderRows(req, 'o.channel = ?', [channel]));
  }

  if (kind === 'product') {
    if (!product) return res.status(400).json({ error: '缺少商品' });
    return analysisDetail(res, `${product}销售明细`, '来自“商品销售TOP10”。销售额由订单事实表汇总，明细按订单展开，避免人工上报重复计算。', orderColumns, orderRows(req, 'o.product = ?', [product]));
  }

  if (kind === 'region') {
    if (!region) return res.status(400).json({ error: '缺少区域' });
    return analysisDetail(res, `${region}区域销售明细`, '来自“区域销售分布”。区域金额来自订单区域字段，明细行可继续追到客户档案。', orderColumns, orderRows(req, 'o.region = ?', [region]));
  }

  if (kind === 'identity') {
    const rows = identity && identity !== '未知'
      ? leadRows(req, 'l.identity_tag = ?', [identity])
      : leadRows(req, '(l.identity_tag IS NULL OR l.identity_tag = ?)', ['']);
    return analysisDetail(res, `${identity || '未知'}客群客户明细`, '来自“客群结构分析”。这里按客户身份标签钻取，展示阶段、负责人、跟进数和成交沉淀。', leadColumns, rows);
  }

  if (kind === 'path') {
    if (!path) return res.status(400).json({ error: '缺少成交路径' });
    return analysisDetail(res, `${path}路径客户明细`, '来自“成交路径分布”。路径由客户档案沉淀，便于核对这些客户到底来自哪里、走到什么阶段。', leadColumns, leadRows(req, 'l.path_type = ?', [path]));
  }

  if (kind === 'kpi-day') {
    if (!date) return res.status(400).json({ error: '缺少日期' });
    if (metric === 'deals' || metric === '成交') {
      return analysisDetail(res, `${date} 成交订单`, '来自“关键指标趋势”的成交点。订单是成交金额和成交单数的事实源。', orderColumns, orderRows(req, 'date(o.created_at) = ?', [date]));
    }
    if (metric === 'new_leads' || metric === '新增线索') {
      return analysisDetail(res, `${date} 新增线索`, '来自“关键指标趋势”的新增线索点。新增线索按客户创建日期归集。', leadColumns, leadRows(req, 'date(l.created_at) = ?', [date]));
    }
    if (metric === 'invited' || metric === '邀约') {
      return analysisDetail(res, `${date} 已邀约客户`, '来自“关键指标趋势”的邀约点。邀约按客户阶段更新时间归集。', leadColumns, leadRows(req, "l.stage = '已邀约' AND date(l.updated_at) = ?", [date]));
    }
    if (metric === 'arrived' || metric === '到店') {
      return analysisDetail(res, `${date} 已到店客户`, '来自“关键指标趋势”的到店点。到店按客户阶段更新时间归集。', leadColumns, leadRows(req, "l.stage = '已到店' AND date(l.updated_at) = ?", [date]));
    }
    const rows = q.all(`SELECT date, content_count, new_leads, invited, arrived, deals, deal_amount, repurchase_amount, active_partners, orders, week_problem, next_action
      FROM daily_ops
      WHERE tenant_id = ${curTenant()} AND date = ?`, date);
    return analysisDetail(res, `${date} 日经营事实表`, '来自“关键指标趋势”。这是当日过程数据底表，成交与复购仍以订单归集为准。', [
      { title: '日期', dataIndex: 'date' },
      { title: '内容', dataIndex: 'content_count' },
      { title: '新增线索', dataIndex: 'new_leads' },
      { title: '邀约', dataIndex: 'invited' },
      { title: '到店', dataIndex: 'arrived' },
      { title: '成交', dataIndex: 'deals' },
      { title: '成交额', dataIndex: 'deal_amount', type: 'money' },
      { title: '复购额', dataIndex: 'repurchase_amount', type: 'money' },
      { title: '下一步', dataIndex: 'next_action' },
    ], rows);
  }

  if (kind === 'health') {
    if (part === 'leads') {
      const rows = q.all(`SELECT date, new_leads, invited, arrived, deals, deal_amount, week_problem, next_action
        FROM daily_ops WHERE tenant_id = ${curTenant()} AND date BETWEEN ? AND ? ORDER BY date DESC`, s, e);
      return analysisDetail(res, '获客能力评分依据', '来自“经营健康度”。获客得分由本月新增线索与目标折算对比得出，下表是每日过程事实。', [
        { title: '日期', dataIndex: 'date' },
        { title: '新增线索', dataIndex: 'new_leads' },
        { title: '邀约', dataIndex: 'invited' },
        { title: '到店', dataIndex: 'arrived' },
        { title: '成交', dataIndex: 'deals' },
        { title: '成交额', dataIndex: 'deal_amount', type: 'money' },
        { title: '问题/下一步', dataIndex: 'next_action' },
      ], rows);
    }
    if (part === 'conversion') {
      return analysisDetail(res, '转化效率评分依据', '来自“经营健康度”。转化效率由线索到成交的比例核算，下表展示当前可见客户的阶段和评分。', leadColumns, leadRows(req, "l.stage NOT IN ('已流失')"));
    }
    if (part === 'repurchase') {
      const scope = leadScope(req);
      const rows = q.all(`SELECT l.id lead_id, l.name, l.identity_tag, COUNT(o.id) orders, SUM(o.amount) deal_amount, MAX(o.created_at) updated_at
        FROM orders o JOIN leads l ON l.id = o.lead_id
        WHERE o.tenant_id = ${curTenant()}${scope.sql}
        GROUP BY o.lead_id HAVING orders >= 2 ORDER BY deal_amount DESC LIMIT 120`, ...scope.params);
      return analysisDetail(res, '复购留存评分依据', '来自“经营健康度”。复购留存按购买2次及以上客户占比核算，点击客户可继续看订单和跟进。', [
        { title: '客户', dataIndex: 'name' },
        { title: '身份', dataIndex: 'identity_tag' },
        { title: '订单数', dataIndex: 'orders' },
        { title: '累计金额', dataIndex: 'deal_amount', type: 'money' },
        { title: '最近下单', dataIndex: 'updated_at' },
      ], rows);
    }
    if (part === 'partner') {
      const rows = q.all(`SELECT a.date, p.name partner, p.level, a.studied, a.posted_moments, a.posted_videos, a.invited, a.invite_count, a.arrive_count, a.deal_count, a.score, a.problem
        FROM partner_actions a JOIN partners p ON p.id = a.partner_id
        WHERE a.tenant_id = ${curTenant()} AND a.date BETWEEN ? AND ?
        ORDER BY a.date DESC, a.score DESC LIMIT 120`, s, e);
      return analysisDetail(res, '合伙人活跃评分依据', '来自“经营健康度”。活跃度按合伙人学习、发圈、邀约等动作计算，下表是具体动作记录。', [
        { title: '日期', dataIndex: 'date' },
        { title: '合伙人', dataIndex: 'partner' },
        { title: '层级', dataIndex: 'level' },
        { title: '学习', dataIndex: 'studied' },
        { title: '朋友圈', dataIndex: 'posted_moments' },
        { title: '短视频', dataIndex: 'posted_videos' },
        { title: '邀约', dataIndex: 'invited' },
        { title: '积分', dataIndex: 'score' },
      ], rows);
    }
    if (part === 'content') {
      const scope = userScopeClause(req.user, 'c.creator_id');
      const rows = q.all(`SELECT c.id, c.type, c.title, c.topic, c.status, COALESCE(u.name, '-') creator, c.effect_views, c.effect_leads, c.created_at
        FROM contents c LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.creator_id
        WHERE c.tenant_id = ${curTenant()} AND c.created_at BETWEEN ? AND ? || ' 23:59'${scope.sql}
        ORDER BY c.created_at DESC LIMIT 120`, s, e, ...scope.params);
      return analysisDetail(res, '内容产出评分依据', '来自“经营健康度”。内容产出按日均内容数量与目标对比，下表展示内容生产仓产出明细。', [
        { title: '类型', dataIndex: 'type' },
        { title: '标题', dataIndex: 'title' },
        { title: '主题', dataIndex: 'topic' },
        { title: '状态', dataIndex: 'status' },
        { title: '创建人', dataIndex: 'creator' },
        { title: '线索', dataIndex: 'effect_leads' },
        { title: '时间', dataIndex: 'created_at' },
      ], rows);
    }
    return analysisDetail(res, '经营健康度评分拆解', '来自“经营健康度”。点击具体子项可看对应事实表。', [
      { title: '子项', dataIndex: 'name' },
      { title: '得分', dataIndex: 'score' },
      { title: '权重', dataIndex: 'weight' },
      { title: '说明', dataIndex: 'note' },
    ], healthScore().subs || []);
  }

  if (kind === 'insight') {
    if (dimension.includes('团购')) {
      return analysisDetail(res, '团购机会依据客户', '来自“增长机会洞察”。系统按团购路径客户沉淀数量触发建议，点击客户可继续核验阶段和跟进。', leadColumns, leadRows(req, "l.path_type = '团购客户' AND l.stage NOT IN ('已流失')"));
    }
    if (dimension.includes('成交') || dimension.includes('转化')) {
      return analysisDetail(res, '成交机会依据客户', '来自“增长机会洞察”。系统按A类高意向、未成交客户触发建议。', leadColumns, leadRows(req, "l.grade = 'A' AND l.stage NOT IN ('已成交','复购','已流失')"));
    }
    return analysisDetail(res, `${dimension || '增长机会'}依据`, '来自“增长机会洞察”。这里列出与该建议相关的客户事实和经营过程数据。', leadColumns, leadRows(req, "l.stage NOT IN ('已流失')"));
  }

  res.status(404).json({ error: '未知可视化钻取类型' });
});

// 顶部统计卡钻取（跟随页面时间区间）
r.get('/drill/:kind', (req, res) => {
  const kind = req.params.kind;
  const [s, e] = range(req);
  const canSeeFinance = ['boss', 'ops_director', 'admin', 'platform_super'].includes(req.user.role);
  const orderScope = leadScope(req);
  if (kind === 'revenue') return res.json({ title: `逐日营收明细（${s} ~ ${e}）`,
    rows: q.all(`SELECT date(o.created_at) date, SUM(o.amount) deal_amount, COUNT(*) deals, COUNT(*) orders,
        SUM(CASE WHEN o.type='复购' THEN o.amount ELSE 0 END) repurchase_amount,
        COUNT(DISTINCT CASE WHEN date(l.created_at)=date(o.created_at) THEN l.id ELSE NULL END) new_leads,
        SUM(CASE WHEN l.stage='已到店' THEN 1 ELSE 0 END) arrived
      FROM orders o LEFT JOIN leads l ON l.id=o.lead_id
      WHERE o.tenant_id = ${curTenant()} AND o.created_at BETWEEN ? AND ? || ' 23:59'${orderScope.sql}
      GROUP BY date(o.created_at) ORDER BY date DESC`, s, e, ...orderScope.params),
    note: '营收=经营数据表逐日成交金额合计；成交由增长中心阶段推进自动归集，杜绝双计。' });
  if (kind === 'orders') {
    // 多层钻取：date=某日二层 / lo,hi=客单价分段二层
    const { date, lo, hi } = req.query;
    let where = `o.tenant_id = ${curTenant()} AND o.created_at BETWEEN ? AND ? || ' 23:59'`; const params = [date || s, date || e];
    where += orderScope.sql; params.push(...orderScope.params);
    if (lo) { where += ' AND o.amount >= ?'; params.push(+lo); }
    if (hi) { where += ' AND o.amount < ?'; params.push(+hi); }
    return res.json({ title: date ? `${date} 当日订单` : `订单明细（${s} ~ ${e}）`,
      rows: q.all(`SELECT o.id, o.lead_id, o.product, o.amount, o.type, o.channel, o.created_at, l.name customer, l.identity_tag
        FROM orders o LEFT JOIN leads l ON l.id = o.lead_id WHERE ${where} ORDER BY o.created_at DESC LIMIT 100`, ...params),
      note: '订单类型按门店真实业务记录，例如堂食、外卖、自提、团餐、首次消费或复购；点任意一行可继续核对客户档案与订单来源。' });
  }
  if (kind === 'avg-order') {
    const rows = q.all(`SELECT o.amount FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id = ${curTenant()} AND o.created_at BETWEEN ? AND ? || ' 23:59'${orderScope.sql}`, s, e, ...orderScope.params).map(x => x.amount || 0);
    const buckets = [['<2千', 0, 2000], ['2-5千', 2000, 5000], ['5千-1万', 5000, 10000], ['1-5万', 10000, 50000], ['≥5万', 50000, 1e12]]
      .map(([label, lo, hi]) => ({ label, n: rows.filter(v => v >= lo && v < hi).length,
        sum: Math.round(rows.filter(v => v >= lo && v < hi).reduce((a, b) => a + b, 0)) }));
    return res.json({ title: `客单价分布（${s} ~ ${e}）`, buckets,
      avg: rows.length ? Math.round(rows.reduce((a, b) => a + b, 0) / rows.length) : 0, count: rows.length,
      note: '客单价=订单总额÷订单数；改善应基于真实菜单贡献、套餐/加购、宴会团餐和会员复购数据，并同时核对顾客体验与履约能力。' });
  }
  if (kind === 'repurchase') return res.json({ title: `复购客户明细（${s} ~ ${e}）`,
    rows: q.all(`SELECT l.id, l.name, l.identity_tag, COUNT(o.id) cnt, SUM(o.amount) total, MAX(o.created_at) last_at
      FROM orders o JOIN leads l ON l.id = o.lead_id WHERE o.tenant_id = ${curTenant()} AND o.created_at BETWEEN ? AND ? || ' 23:59'
      ${orderScope.sql} GROUP BY o.lead_id HAVING cnt >= 2 ORDER BY total DESC LIMIT 50`, s, e, ...orderScope.params),
    note: '复购率=区间内下单≥2次客户 ÷ 下单客户总数；复购经营应依据真实消费频次、菜品偏好、服务反馈与合法联系授权制定。' });
  if (kind === 'marketing') {
    if (!canSeeFinance) return res.status(403).json({ error: '营销费用明细仅老板/总监可见' });
    return res.json({ title: `营销费用明细（${s} ~ ${e}）`,
      rows: q.all(`SELECT date, marketing_cost, deal_amount, new_leads FROM daily_ops
        WHERE tenant_id = ${curTenant()} AND date BETWEEN ? AND ? AND marketing_cost > 0 ORDER BY date DESC`, s, e),
      note: '费用占比=营销费用÷当日营收；获客成本=费用÷新增线索。投放建议结合内容效果TOP复盘。' });
  }
  if (kind === 'margin') {
    if (!canSeeFinance) return res.status(403).json({ error: '毛利数据仅老板/总监可见' });
    return res.json({
      title: '毛利率口径说明',
      status: 'unavailable',
      unavailable: true,
      missingFields: GROSS_MARGIN_MISSING_FIELDS,
      rows: [],
      formula: '(净销售额 - 同期销货成本) ÷ 净销售额',
      note: '当前没有足够的真实成本与库存数据，系统不估填数值或套用行业区间。补齐并由财务负责人确认同期间、同门店口径后才能计算。',
    });
  }
  res.status(400).json({ error: '未知钻取类型' });
});

r.get('/overview', (req, res) => {
  const [s, e] = range(req);
  const days = Math.max(1, Math.round((new Date(e) - new Date(s)) / 86400000) + 1);
  const scope = leadScope(req);
  const cur = q.get(`SELECT SUM(o.amount) amount, COUNT(*) orders FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id = ${curTenant()} AND o.created_at BETWEEN ? AND ? || ' 23:59'${scope.sql}`, s, e, ...scope.params) || {};
  const prev = q.get(`SELECT SUM(o.amount) amount, COUNT(*) orders FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id = ${curTenant()} AND o.created_at BETWEEN date(?, '-${days} day') AND date(?, '-1 day') || ' 23:59'${scope.sql}`, s, s, ...scope.params) || {};
  const curOps = q.get(`SELECT COALESCE(SUM(deal_amount),0) amount,COALESCE(SUM(orders),0) orders FROM daily_ops WHERE tenant_id=${curTenant()} AND date BETWEEN ? AND ?`, s, e) || {};
  const prevOps = q.get(`SELECT COALESCE(SUM(deal_amount),0) amount,COALESCE(SUM(orders),0) orders FROM daily_ops
    WHERE tenant_id=${curTenant()} AND date BETWEEN date(?, '-${days} day') AND date(?, '-1 day')`, s, s) || {};
  const curRevenue = cur.amount || curOps.amount || 0;
  const prevRevenue = prev.amount || prevOps.amount || 0;
  const curOrderCount = cur.orders || curOps.orders || 0;
  const prevOrderCount = prev.orders || prevOps.orders || 0;
  const re = q.get(`SELECT COUNT(*) n FROM (SELECT o.lead_id FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id = ${curTenant()} AND o.created_at BETWEEN ? AND ? || ' 23:59'${scope.sql} GROUP BY o.lead_id HAVING COUNT(*) >= 2)`, s, e, ...scope.params)?.n || 0;
  const buyers = q.get(`SELECT COUNT(DISTINCT o.lead_id) n FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id = ${curTenant()} AND o.created_at BETWEEN ? AND ? || ' 23:59'${scope.sql}`, s, e, ...scope.params)?.n || 1;
  // 毛利率仅老板/总监可见；缺少真实成本时保持不可用，不估填数值。
  const financeVisible = ['boss', 'ops_director'].includes(req.user.role);
  res.json({
    revenue: curRevenue, revenueWow: pct(curRevenue - prevRevenue, prevRevenue || 1),
    grossMargin: null,
    grossMarginStatus: financeVisible ? 'unavailable' : 'restricted',
    grossMarginMissingFields: financeVisible ? GROSS_MARGIN_MISSING_FIELDS : [],
    orders: curOrderCount, ordersWow: pct(curOrderCount - prevOrderCount, prevOrderCount || 1),
    avgOrder: curOrderCount > 0 ? Math.round(curRevenue / curOrderCount) : 0,
    repurchaseRate: pct(re, buyers),
    marketingCost: financeVisible && hasFullDataAccess(req.user) ? (q.get(`SELECT SUM(marketing_cost) cost FROM daily_ops WHERE tenant_id = ${curTenant()} AND date BETWEEN ? AND ?`, s, e)?.cost || 0) : null,
  });
});

r.get('/trend', (req, res) => {
  const [s, e] = range(req);
  const goal = q.get(`SELECT revenue_target FROM goals WHERE tenant_id = ${curTenant()} AND period = ?`, today().slice(0, 7)) || {};
  const dailyTarget = (goal.revenue_target || 1500000) / 30;
  const scope = leadScope(req);
  res.json({ rows: q.all(`SELECT d.date,
      COALESCE(NULLIF((SELECT SUM(o.amount) FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id=${curTenant()} AND date(o.created_at)=d.date${scope.sql}),0),d.deal_amount,0) deal_amount,
      COALESCE(NULLIF((SELECT COUNT(*) FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id=${curTenant()} AND date(o.created_at)=d.date${scope.sql}),0),d.deals,0) deals,
      COALESCE(NULLIF((SELECT COUNT(*) FROM leads l WHERE l.tenant_id=${curTenant()} AND date(l.created_at)=d.date${scope.sql}),0),d.new_leads,0) new_leads,
      COALESCE(NULLIF((SELECT COUNT(*) FROM leads l WHERE l.tenant_id=${curTenant()} AND l.stage='已邀约' AND date(l.updated_at)=d.date${scope.sql}),0),d.invited,0) invited,
      COALESCE(NULLIF((SELECT COUNT(*) FROM leads l WHERE l.tenant_id=${curTenant()} AND l.stage='已到店' AND date(l.updated_at)=d.date${scope.sql}),0),d.arrived,0) arrived,
      COALESCE(NULLIF((SELECT SUM(o.amount) FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id=${curTenant()} AND o.type='复购' AND date(o.created_at)=d.date${scope.sql}),0),d.repurchase_amount,0) repurchase_amount
    FROM daily_ops d WHERE d.tenant_id = ${curTenant()} AND d.date BETWEEN ? AND ? ORDER BY d.date`,
    ...scope.params, ...scope.params, ...scope.params, ...scope.params, ...scope.params, ...scope.params, s, e), dailyTarget: Math.round(dailyTarget) });
});

r.get('/channels', (req, res) => {
  const [s, e] = range(req);
  const scope = leadScope(req);
  res.json(q.all(`SELECT o.channel, COUNT(*) orders, SUM(o.amount) amount FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id = ${curTenant()} AND o.created_at BETWEEN ? AND ? || ' 23:59'${scope.sql} GROUP BY o.channel ORDER BY amount DESC`, s, e, ...scope.params));
});

r.get('/customers', (req, res) => {
  const scope = userScopeClause(req.user, 'owner_id');
  const byIdentity = q.all(`SELECT identity_tag k, COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND stage IN ('已成交','复购')${scope.sql} GROUP BY identity_tag ORDER BY n DESC`, ...scope.params);
  const byPath = q.all(`SELECT path_type k, COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND path_type IS NOT NULL${scope.sql} GROUP BY path_type ORDER BY n DESC`, ...scope.params);
  const newOld = q.get(`SELECT SUM(CASE WHEN stage='已成交' THEN 1 ELSE 0 END) newC, SUM(CASE WHEN stage='复购' THEN 1 ELSE 0 END) oldC FROM leads WHERE tenant_id = ${curTenant()}${scope.sql}`, ...scope.params);
  res.json({ byIdentity, byPath, newOld });
});

r.get('/products', (req, res) => {
  const [s, e] = range(req);
  const scope = leadScope(req);
  const rows = q.all(`SELECT o.product, COUNT(*) qty, SUM(o.amount) amount FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id = ${curTenant()} AND o.created_at BETWEEN ? AND ? || ' 23:59'${scope.sql} GROUP BY o.product ORDER BY amount DESC LIMIT 10`, s, e, ...scope.params);
  const total = rows.reduce((acc, x) => acc + x.amount, 0) || 1;
  res.json(rows.map(x => ({ ...x, share: pct(x.amount, total) })));
});

r.get('/regions', (req, res) => {
  const [s, e] = range(req);
  const scope = leadScope(req);
  const rows = q.all(`SELECT o.region, COUNT(*) orders, SUM(o.amount) amount FROM orders o LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id = ${curTenant()} AND o.created_at BETWEEN ? AND ? || ' 23:59' AND o.region IS NOT NULL${scope.sql} GROUP BY o.region ORDER BY amount DESC`, s, e, ...scope.params);
  const total = rows.reduce((acc, x) => acc + x.amount, 0) || 1;
  res.json(rows.map(x => ({ ...x, share: pct(x.amount, total) })));
});

r.get('/health', (req, res) => res.json(healthScore()));
r.get('/funnel', (req, res) => res.json(funnel()));

r.get('/insights', (req, res) => {
  const h = healthScore();
  const { bottleneck } = funnel();
  const extra = [];
  // 机会洞察：复购节点、A类客户、合伙人带单（增长机会洞察 FR-ANA）
  const fest = q.get(`SELECT 1`); // 占位
  const scope = userScopeClause(req.user, 'owner_id');
  const aCount = q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND grade='A' AND stage NOT IN ('已成交','复购','已流失')${scope.sql}`, ...scope.params)?.n || 0;
  if (aCount >= 5) extra.push({ dimension: '成交机会', issue: `当前有 ${aCount} 个A类高意向客户待跟进`, suggestion: '逐一核对顾客需求、预算、到店时间和未解决顾虑；价格、优惠与外部承诺由有权限的负责人确认' });
  const teamBuyers = q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND path_type='团购客户' AND stage NOT IN ('已流失')${scope.sql}`, ...scope.params)?.n || 0;
  if (teamBuyers >= 10) extra.push({ dimension: '团餐机会', issue: `团购/团餐路径客户已沉淀 ${teamBuyers} 人`, suggestion: '按企业客户已表达的用餐场景、人数、预算与日期分组，先核验门店接待和履约能力，再由负责人确认触达计划' });
  if (bottleneck) extra.push({ dimension: '漏斗卡点', issue: `「${bottleneck}」环节转化率低于基准`, suggestion: '见周报诊断与下周作战主题建议' });
  res.json([...h.insights, ...extra].slice(0, 6));
});

r.get('/weekly-review/latest', (req, res) => {
  const row = q.get(`SELECT * FROM weekly_reviews WHERE tenant_id = ${curTenant()} ORDER BY week DESC LIMIT 1`);
  if (!row) return res.json(null);
  res.json({ week: row.week, ...safeJsonParse(row.report, {}), generatedAt: row.created_at });
});
r.post('/weekly-review/generate', (req, res) => {
  res.json(generateWeeklyReview(today()));
});

export default r;

import { Router } from 'express';
import { db, q, runWithTenant } from '../db.js';
import { logOp, requireRole, notify, pageParams, safeJsonParse } from '../util.js';
import { creditTenant, billing } from '../engines/credits.js';
import { activatePlanForTenant, applyPlanForPaidOrderInTransaction, planSummary } from '../engines/plan.js';

const r = Router();
r.use(requireRole('platform_super')); // 全部接口仅平台超级管理员

const ALL_MODULES = ['dashboard', 'advisor', 'marshals', 'growth', 'activities', 'content', 'execution', 'analysis', 'assets', 'system'];

function normalizedModules(value) {
  if (value == null || (Array.isArray(value) && value.length === 0)) return null;
  if (!Array.isArray(value)) throw Object.assign(new Error('模块权限必须是数组'), { status: 400 });
  const modules = [...new Set(value.map(item => String(item).trim()))];
  if (modules.some(item => !ALL_MODULES.includes(item))) throw Object.assign(new Error('模块权限包含无效值'), { status: 400 });
  return modules.length ? JSON.stringify(modules) : null;
}

function boundedInteger(value, label, { min = 0, max = 1_000_000_000 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw Object.assign(new Error(`${label}必须是${min}到${max}之间的整数`), { status: 400 });
  }
  return number;
}

// 平台概览
r.get('/overview', (req, res) => {
  const tStats = q.get(`SELECT COUNT(*) total,
    SUM(CASE WHEN status='待审核' THEN 1 ELSE 0 END) pending,
    SUM(CASE WHEN status='已开通' THEN 1 ELSE 0 END) active,
    SUM(credits) poolTotal, SUM(total_recharged) rechargedTotal FROM tenants WHERE id > 1`) || {};
  const spent = q.get(`SELECT COALESCE(SUM(credits),0) s FROM credit_logs WHERE credits > 0 AND tenant_id > 1`)?.s || 0;
  const pendingOrders = q.get(`SELECT COUNT(*) n FROM recharge_orders WHERE status='待支付'`)?.n || 0;
  const rechargeYuan = q.get(`SELECT COALESCE(SUM(price_yuan),0) s FROM recharge_orders WHERE status='已支付'`)?.s || 0;
  res.json({
    tenants: tStats.total || 0, pending: tStats.pending || 0, active: tStats.active || 0,
    poolTotal: tStats.poolTotal || 0, rechargedTotal: tStats.rechargedTotal || 0, spentTotal: spent,
    pendingOrders, rechargeYuan,
  });
});

// 运营分析（卖方驾驶舱）：活跃/流失预警、营收趋势、ARPU、续费预警、新增趋势
r.get('/analytics', (req, res) => {
  const now = Date.now();
  const cy = billing().creditYuan;   // 1积分对应人民币（消耗折算售价用）
  const tenants = q.all(`SELECT t.id, t.name, t.status, t.plan, t.credits, t.total_recharged, t.created_at,
      (SELECT COALESCE(SUM(credits),0) FROM credit_logs WHERE tenant_id = t.id AND credits > 0) spent,
      (SELECT COALESCE(SUM(cost_yuan),0) FROM credit_logs WHERE tenant_id = t.id AND credits > 0) cost,
      (SELECT COUNT(*) FROM credit_logs WHERE tenant_id = t.id AND ai_mode NOT IN ('recharge','bonus')) calls,
      (SELECT MAX(created_at) FROM credit_logs WHERE tenant_id = t.id) last_active,
      (SELECT COUNT(*) FROM users WHERE tenant_id = t.id) users
    FROM tenants t WHERE t.id > 1 ORDER BY t.total_recharged DESC`).map(t => {
    const idle = t.last_active ? Math.floor((now - new Date(t.last_active).getTime()) / 86400000) : null;
    const health = t.status !== '已开通' ? t.status : (idle == null ? '未启用' : idle <= 3 ? '活跃' : idle <= 14 ? '一般' : '流失预警');
    // 该企业消耗对应的售价(=消耗积分×单价) 与 我的真实成本，差额即这家客户给我贡献的毛利
    const consumedYuan = Math.round((t.spent || 0) * cy * 100) / 100;
    const cost = Math.round((t.cost || 0) * 100) / 100;
    return { ...t, idleDays: idle, health, lowBalance: t.status === '已开通' && (t.credits ?? 0) < 5000,
      cost, consumedYuan, margin: Math.round((consumedYuan - cost) * 100) / 100 };
  });
  const totalRevenue = q.get(`SELECT COALESCE(SUM(price_yuan),0) s FROM recharge_orders WHERE status = '已支付'`)?.s || 0;
  const paying = q.get(`SELECT COUNT(DISTINCT tenant_id) n FROM recharge_orders WHERE status = '已支付' AND tenant_id > 1`)?.n || 0;
  // 平台真实成本（已发生的云雾 API 成本）；转售毛利率按"已消耗价值 vs 成本"算（不混入未消耗的预充值，口径更诚实）
  const totalCost = Math.round((q.get(`SELECT COALESCE(SUM(cost_yuan),0) s FROM credit_logs WHERE credits > 0 AND tenant_id > 1`)?.s || 0) * 100) / 100;
  const consumedYuan = Math.round(tenants.reduce((s, t) => s + (t.consumedYuan || 0), 0) * 100) / 100;
  res.json({
    summary: {
      total: tenants.length,
      active: tenants.filter(t => t.health === '活跃').length,
      churning: tenants.filter(t => t.health === '流失预警').length,
      lowBalance: tenants.filter(t => t.lowBalance).length,
      totalRevenue, paying, arpu: paying ? Math.round(totalRevenue / paying) : 0,
      totalCost, consumedYuan,
      marginRate: consumedYuan > 0 ? Math.round((1 - totalCost / consumedYuan) * 1000) / 10 : 0,
    },
    revByMonth: q.all(`SELECT substr(paid_at,1,7) m, SUM(price_yuan) yuan, COUNT(*) cnt
      FROM recharge_orders WHERE status='已支付' AND paid_at IS NOT NULL GROUP BY m ORDER BY m DESC LIMIT 6`),
    newByMonth: q.all(`SELECT substr(created_at,1,7) m, COUNT(*) n FROM tenants WHERE id > 1 GROUP BY m ORDER BY m DESC LIMIT 6`),
    tenants,
  });
});

// 全平台积分流水（平台超管专属，天然跨租户）：按企业/用户/类型/日期筛选，可导出
r.get('/credit-logs', (req, res) => {
  const { tenantId, userId, kind, from, to, export: exp } = req.query;
  let where = 'WHERE l.tenant_id > 0'; const params = [];
  if (tenantId) { where += ' AND l.tenant_id = ?'; params.push(tenantId); }
  if (userId) { where += ' AND l.user_id = ?'; params.push(userId); }
  if (kind) { where += ' AND l.kind = ?'; params.push(kind); }
  if (from) { where += ' AND date(l.created_at) >= ?'; params.push(from); }
  if (to) { where += ' AND date(l.created_at) <= ?'; params.push(to); }
  const total = q.get(`SELECT COUNT(*) n FROM credit_logs l ${where}`, ...params)?.n || 0;
  const { size, offset } = pageParams(req.query, 30);
  const lim = exp ? 10000 : size;
  const off = exp ? 0 : offset;
  const cy = billing().creditYuan;
  const rows = q.all(`SELECT l.*, u.name user_name, t.name tenant_name FROM credit_logs l
    LEFT JOIN users u ON u.id = l.user_id LEFT JOIN tenants t ON t.id = l.tenant_id
    ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`, ...params, lim, off)
    .map(r => ({ ...r, spend_yuan: r.credits > 0 ? Math.round(r.credits * cy * 100) / 100 : null }));
  res.json({ total, rows });
});

// 租户列表（含账号数/待付订单）
r.get('/tenants', (req, res) => {
  res.json(q.all(`SELECT t.*,
    (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) user_count,
    (SELECT COUNT(*) FROM recharge_orders o WHERE o.tenant_id = t.id AND o.status='待支付') pending_orders
    FROM tenants t ORDER BY t.id DESC`));
});

r.get('/tenants/:id', (req, res) => {
  const t = q.get('SELECT * FROM tenants WHERE id = ?', req.params.id);
  if (!t) return res.status(404).json({ error: '租户不存在' });
  const users = q.all('SELECT id,username,name,role,dept,status,last_login_at FROM users WHERE tenant_id = ? ORDER BY id', t.id);
  const orders = q.all('SELECT * FROM recharge_orders WHERE tenant_id = ? ORDER BY id DESC LIMIT 20', t.id);
  res.json({ ...t, modules: safeJsonParse(t.modules, null), users, orders, planSummary: planSummary(t) });
});

// 线下签约后手工开通年度套餐（招商会现场对公转账场景）：写到期日/席位并入账赠送积分；未到期则顺延
r.post('/tenants/:id/plan/activate', (req, res) => {
  const t = q.get('SELECT * FROM tenants WHERE id = ?', req.params.id);
  if (!t) return res.status(404).json({ error: '租户不存在' });
  const packageId = Number(req.body?.packageId);
  const pkg = Number.isInteger(packageId) && packageId > 0
    ? q.get('SELECT * FROM recharge_packages WHERE id = ?', packageId)
    : null;
  if (!pkg) return res.status(400).json({ error: '套餐不存在' });
  if (pkg.kind !== 'plan') return res.status(400).json({ error: '所选套餐不是年度套餐（kind=plan）' });
  if (!pkg.enabled) return res.status(400).json({ error: '该套餐已下架' });
  let outcome;
  try {
    outcome = activatePlanForTenant({ tenantId: t.id, pkg, operatorUserId: req.user.id, source: 'manual' });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
  runWithTenant(t.id, () => {
    for (const u of q.all(`SELECT id FROM users WHERE tenant_id = ? AND role IN ('boss','ops_director','admin')`, t.id)) {
      notify(u.id, '账号开通', `「${pkg.name}」已开通`,
        `有效期至 ${outcome.expiresAt}${outcome.rolledOver ? '（已按原到期日顺延）' : ''}，含 ${outcome.seatLimit ?? '-'} 个账号${outcome.bonusCredits > 0 ? `，赠送 ${outcome.bonusCredits} 积分已到账` : ''}`, '/recharge');
    }
  });
  logOp(req.user, '平台运营', '手工开通年度套餐', `${t.name}/${pkg.name} 至 ${outcome.expiresAt}`);
  res.json({ ok: true, ...outcome, plan: planSummary(t.id) });
});

// 审核开通（FR-SAAS-02）：分配模块权限 + 套餐，可选赠送体验积分
r.post('/tenants/:id/approve', (req, res) => {
  const t = q.get('SELECT * FROM tenants WHERE id = ?', req.params.id);
  if (!t) return res.status(404).json({ error: '租户不存在' });
  const { modules, plan = '标准版', grantCredits = 0, seatLimit } = req.body || {};
  const planName = typeof plan === 'string' ? plan.trim() : '';
  if (!planName || planName.length > 40) return res.status(400).json({ error: '套餐名称必须是1到40字的文本' });
  let mods; let grant; let seats;
  try {
    mods = normalizedModules(modules);
    grant = boundedInteger(grantCredits, '赠送积分');
    seats = seatLimit == null ? boundedInteger(t.seat_limit || 5, '席位数', { min: 1, max: 10000 })
      : boundedInteger(seatLimit, '席位数', { min: 1, max: 10000 });
  } catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  const wasActive = t.status === '已开通';
  try {
    db.exec('BEGIN IMMEDIATE');
    q.run(`UPDATE tenants SET status='已开通',modules=?,plan=?,seat_limit=?,approved_by=?,approved_at=datetime('now','localtime') WHERE id=?`,
      mods, planName, seats, req.user.id, t.id);
    if (grant > 0 && !wasActive) creditTenant({ tenantId: t.id, delta: grant, userId: req.user.id, feature: '开通赠送积分', note: '平台开通赠送', manageTransaction: false });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    return res.status(error.status || 500).json({ error: error.message });
  }
  runWithTenant(t.id, () => {
    for (const u of q.all('SELECT id FROM users WHERE tenant_id = ?', t.id)) {
      notify(u.id, '账号开通', '企业账号已开通', `您的「${t.name}」已开通（${planName}）${grant > 0 && !wasActive ? `，赠送 ${grant} 积分` : ''}，欢迎使用！`);
    }
  });
  logOp(req.user, '平台运营', '审核开通租户', `${t.name}/${planName}`);
  res.json({ ok: true });
});

// 调整租户：模块/套餐/停用启用
r.post('/tenants/:id/update', (req, res) => {
  const t = q.get('SELECT * FROM tenants WHERE id = ?', req.params.id);
  if (!t) return res.status(404).json({ error: '租户不存在' });
  const { modules, plan, status, seatLimit } = req.body || {};
  if (modules !== undefined) q.run('UPDATE tenants SET modules=? WHERE id=?', Array.isArray(modules) && modules.length ? JSON.stringify(modules) : null, t.id);
  if (plan !== undefined) q.run('UPDATE tenants SET plan=? WHERE id=?', plan, t.id);
  if (status !== undefined && ['已开通', '已停用', '待审核'].includes(status)) q.run('UPDATE tenants SET status=? WHERE id=?', status, t.id);
  if (seatLimit !== undefined) q.run('UPDATE tenants SET seat_limit=? WHERE id=?', Math.max(1, Number(seatLimit) || 5), t.id);
  logOp(req.user, '平台运营', '调整租户', `${t.name}: ${[plan && '套餐' + plan, status].filter(Boolean).join(' ')}`);
  res.json({ ok: true });
});

// 平台手动给租户加/减积分（补偿、线下成交直充）
r.post('/tenants/:id/credits', (req, res) => {
  const t = q.get('SELECT * FROM tenants WHERE id = ?', req.params.id);
  if (!t) return res.status(404).json({ error: '租户不存在' });
  const amount = Number(req.body?.delta);
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000_000) {
    return res.status(400).json({ error: '积分变动必须是绝对值不超过10亿的非零整数' });
  }
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 1000) : '';
  try {
    const r2 = creditTenant({ tenantId: t.id, delta: amount, userId: req.user.id, feature: amount >= 0 ? '平台直充' : '平台扣减', note });
    logOp(req.user, '平台运营', amount >= 0 ? '直充积分' : '扣减积分', `${t.name} ${amount}`);
    res.json(r2);
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

// 充值订单（全平台）
r.get('/recharge-orders', (req, res) => {
  const { status } = req.query;
  let where = ''; const params = [];
  if (status) { where = 'WHERE o.status = ?'; params.push(status); }
  res.json(q.all(`SELECT o.*, t.name tenant_name FROM recharge_orders o JOIN tenants t ON t.id = o.tenant_id
    ${where} ORDER BY o.id DESC LIMIT 100`, ...params));
});

// 确认到账（FR-SAAS-05）：发放积分到租户池 → 订单标记已支付（计费闭环入口）
r.post('/recharge-orders/:id/confirm', (req, res) => {
  const o = q.get('SELECT * FROM recharge_orders WHERE id = ?', req.params.id);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.status !== '待支付') return res.status(400).json({ error: '该订单已处理' });
  let bal; let plan = null;
  try {
    db.exec('BEGIN IMMEDIATE');
    const current = q.get(`SELECT status FROM recharge_orders WHERE id=?`, o.id);
    if (current?.status !== '待支付') throw Object.assign(new Error('该订单已处理'), { status: 409 });
    // 年度套餐订单 credits 可能为 0（不含积分）：只生效套餐 + 入账赠送积分，不记购买积分流水
    bal = Number(o.credits) > 0
      ? creditTenant({ tenantId: o.tenant_id, delta: Number(o.credits), userId: req.user.id,
        feature: `充值到账·${o.package_name}`, note: `订单 ${o.order_no}`, manageTransaction: false })
      : { balance: q.get('SELECT credits FROM tenants WHERE id = ?', o.tenant_id)?.credits ?? 0 };
    plan = applyPlanForPaidOrderInTransaction(o, { operatorUserId: req.user.id });
    if (plan) bal = { balance: plan.balance };
    const updated = q.run(`UPDATE recharge_orders SET status='已支付',confirmed_by=?,paid_at=datetime('now','localtime') WHERE id=? AND status='待支付'`, req.user.id, o.id);
    if (!updated.changes) throw Object.assign(new Error('该订单已处理'), { status: 409 });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    return res.status(error.status || 500).json({ error: error.message });
  }
  runWithTenant(o.tenant_id, () => {
    for (const u of q.all(`SELECT id FROM users WHERE tenant_id = ? AND role IN ('boss','ops_director')`, o.tenant_id)) {
      if (plan) {
        notify(u.id, '充值到账', `「${o.package_name}」已开通`,
          `有效期至 ${plan.expiresAt}${plan.rolledOver ? '（已按原到期日顺延）' : ''}，含 ${plan.seatLimit ?? '-'} 个账号${plan.bonusCredits > 0 ? `，赠送 ${plan.bonusCredits} 积分已到账` : ''}，当前余额 ${bal.balance} 积分`, '/recharge');
      } else {
        notify(u.id, '充值到账', `充值到账 ${o.credits} 积分`, `${o.package_name}（¥${o.price_yuan}）已到账，当前余额 ${bal.balance} 积分`);
      }
    }
  });
  logOp(req.user, '平台运营', '确认充值到账', `${o.order_no} +${o.credits}${plan ? ` 套餐至${plan.expiresAt}` : ''}`);
  res.json({ ok: true, balance: bal.balance, plan });
});

// 套餐管理
// kind=credits：到账积分 = 价格×100 + 赠送（沿用旧口径，支付成功一次入账）
// kind=plan：年度套餐，base/total 即套餐自带积分（默认 0=不含积分），bonus_credits 在套餐生效时独立入账；
//            seat_limit/valid_days 必填；is_active/sort_order 分别落到 enabled/sort 列。
const PACKAGE_KINDS = new Set(['credits', 'plan']);
function normalizePackageInput(body, prev = null) {
  const src = body || {};
  const kind = String(src.kind ?? prev?.kind ?? 'credits');
  if (!PACKAGE_KINDS.has(kind)) throw Object.assign(new Error('套餐类型只能是 credits（积分包）或 plan（年度套餐）'), { status: 400 });
  const name = String(src.name ?? prev?.name ?? '').trim();
  if (!name || name.length > 60) throw Object.assign(new Error('套餐名必填且不超过 60 字'), { status: 400 });
  const price = Number(src.price_yuan ?? prev?.price_yuan);
  if (!Number.isFinite(price) || price <= 0 || price > 10_000_000) throw Object.assign(new Error('价格（元）必须是大于 0 的数字'), { status: 400 });
  const bonus = boundedInteger(src.bonus_credits ?? prev?.bonus_credits ?? 0, '赠送积分');
  const enabledRaw = src.enabled ?? src.is_active;
  const enabled = enabledRaw === undefined ? (prev ? prev.enabled : 1) : (enabledRaw ? 1 : 0);
  const sort = boundedInteger(src.sort ?? src.sort_order ?? prev?.sort ?? 99, '排序', { min: -1000, max: 100000 });
  const tag = String(src.tag ?? prev?.tag ?? '').trim().slice(0, 20);
  const code = src.code === undefined ? (prev?.code ?? null) : (String(src.code || '').trim().slice(0, 60) || null);
  if (code && !/^[a-z0-9_.-]{2,60}$/i.test(code)) throw Object.assign(new Error('套餐编码只能是 2-60 位字母、数字、_ . -'), { status: 400 });
  let features = prev?.features ?? null;
  if (src.features !== undefined) {
    features = src.features == null || src.features === '' ? null
      : typeof src.features === 'string' ? src.features : JSON.stringify(src.features);
    if (features && features.length > 4000) throw Object.assign(new Error('features 过长'), { status: 400 });
  }
  if (kind === 'plan') {
    const seatLimit = boundedInteger(src.seat_limit ?? prev?.seat_limit, '账号数', { min: 1, max: 10000 });
    const validDays = boundedInteger(src.valid_days ?? prev?.valid_days, '有效期天数', { min: 1, max: 3650 });
    const base = boundedInteger(src.base_credits ?? (prev?.kind === 'plan' ? prev?.base_credits : 0) ?? 0, '套餐自带积分');
    return { kind, name, price, base, bonus, total: base, seatLimit, validDays, enabled, sort, tag, code, features };
  }
  const base = Math.round(price * 100);
  return { kind, name, price, base, bonus, total: base + bonus, seatLimit: null, validDays: null, enabled, sort, tag, code, features };
}
r.get('/packages', (req, res) => res.json(q.all('SELECT * FROM recharge_packages ORDER BY sort, price_yuan')
  .map(p => ({ ...p, kind: p.kind || 'credits', is_active: p.enabled, sort_order: p.sort }))));
r.post('/packages', (req, res) => {
  let v;
  try { v = normalizePackageInput(req.body); } catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  if (v.code && q.get('SELECT id FROM recharge_packages WHERE code = ?', v.code)) return res.status(409).json({ error: `套餐编码 ${v.code} 已存在` });
  const result = q.run(`INSERT INTO recharge_packages(code,name,kind,price_yuan,base_credits,bonus_credits,total_credits,seat_limit,valid_days,features,tag,sort,enabled)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  v.code, v.name, v.kind, v.price, v.base, v.bonus, v.total, v.seatLimit, v.validDays, v.features, v.tag, v.sort, v.enabled);
  logOp(req.user, '平台运营', '新增套餐', `${v.name}(${v.kind})`);
  res.json({ id: result.lastInsertRowid });
});
r.put('/packages/:id', (req, res) => {
  const p = q.get('SELECT * FROM recharge_packages WHERE id = ?', req.params.id);
  if (!p) return res.status(404).json({ error: '套餐不存在' });
  let v;
  try { v = normalizePackageInput(req.body, p); } catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  if (v.code && v.code !== p.code && q.get('SELECT id FROM recharge_packages WHERE code = ? AND id != ?', v.code, p.id)) {
    return res.status(409).json({ error: `套餐编码 ${v.code} 已存在` });
  }
  q.run(`UPDATE recharge_packages SET code=?, name=?, kind=?, price_yuan=?, base_credits=?, bonus_credits=?, total_credits=?,
    seat_limit=?, valid_days=?, features=?, tag=?, sort=?, enabled=? WHERE id=?`,
  v.code, v.name, v.kind, v.price, v.base, v.bonus, v.total, v.seatLimit, v.validDays, v.features, v.tag, v.sort, v.enabled, p.id);
  logOp(req.user, '平台运营', '修改套餐', `${v.name}(${v.kind})`);
  res.json({ ok: true });
});

export default r;

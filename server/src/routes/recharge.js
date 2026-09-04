import { Router } from 'express';
import crypto from 'node:crypto';
import { q, db, getTenant, runWithTenant, curTenant } from '../db.js';
import { logOp, requireRole, notify, safeJsonParse } from '../util.js';
import { balanceOfTenant, creditTenant, estimateCreditEquivalents, budgetSummary } from '../engines/credits.js';
import { paymentChannels, createPayment, queryPayment, closePayment } from '../engines/payment.js';
import { applyPlanForPaidOrderInTransaction, planSummary } from '../engines/plan.js';

// 在线支付扩展列（幂等迁移：首次用到时补齐，不改 db.js）
let payColumnsReady = false;
export function ensurePayColumns() {
  if (payColumnsReady) return;
  if (!q.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='recharge_orders'`)) return;
  const existing = new Set(q.all(`SELECT name FROM pragma_table_info('recharge_orders')`).map(c => c.name));
  for (const [col, def] of [
    ['pay_channel', 'TEXT'],        // wechat / alipay（空 = 对公转账旧流程）
    ['qr_url', 'TEXT'],             // 收款二维码内容（code_url / qr_code）
    ['pay_expire_at', 'TEXT'],      // 二维码过期时间（ISO）
    ['pay_trade_no', 'TEXT'],       // 网关交易号（transaction_id / trade_no）
  ]) {
    if (!existing.has(col)) db.exec(`ALTER TABLE recharge_orders ADD COLUMN ${col} ${def}`);
  }
  payColumnsReady = true;
}

// 支付回调幂等入账（微信/支付宝共用；也是平台超管手工确认的同一记账口径 creditTenant）。
// 幂等范式与 content.js 发布登记一致：BEGIN IMMEDIATE 锁内重查状态 + 条件更新，
// 订单号 UNIQUE + 状态机「待支付→已支付」单向迁移 = 同一订单重复回调只入账一次。
export function settlePaidOrder({ orderNo, channelName, tradeNo = '', paidFen }) {
  ensurePayColumns();
  let outcome;
  db.exec('BEGIN IMMEDIATE');
  try {
    const o = q.get('SELECT * FROM recharge_orders WHERE order_no = ?', String(orderNo || ''));
    if (!o) throw Object.assign(new Error(`充值订单不存在：${orderNo}`), { status: 404 });
    // 金额校验：回调实付金额（分）必须与订单应付一致，防“1分钱买万元套餐”类伪造
    const expectFen = Math.round(Number(o.price_yuan) * 100);
    if (!Number.isSafeInteger(paidFen) || paidFen !== expectFen) {
      throw Object.assign(new Error(`回调金额不符：订单 ${o.order_no} 应付 ${expectFen} 分，回调实付 ${paidFen} 分，拒绝入账`), { status: 400 });
    }
    if (o.status === '已支付') {
      // 重复回调：幂等成功（告知网关处理完成，停止重试），绝不二次入账
      db.exec('COMMIT');
      return { ok: true, duplicated: true, orderNo: o.order_no };
    }
    if (o.status !== '待支付') {
      throw Object.assign(new Error(`订单 ${o.order_no} 当前状态为「${o.status}」，不能自动入账，请平台人工核对`), { status: 409 });
    }
    // 年度套餐订单 credits 可能为 0（不含积分）：购买积分为 0 时不记 recharge 流水，只生效套餐与赠送积分
    const bal = Number(o.credits) > 0
      ? creditTenant({
        tenantId: o.tenant_id, delta: Number(o.credits), userId: o.created_by,
        feature: `充值到账·${o.package_name}`, note: `订单 ${o.order_no}`, manageTransaction: false,
      })
      : { balance: balanceOfTenant(o.tenant_id) };
    // 套餐订单：同一事务内写 plan_code/到期日/席位并入账赠送积分（顺延逻辑见 engines/plan.js）
    const plan = applyPlanForPaidOrderInTransaction(o);
    const updated = q.run(`UPDATE recharge_orders SET status='已支付', paid_at=datetime('now','localtime'), pay_method=?, pay_trade_no=? WHERE id=? AND status='待支付'`,
      channelName, String(tradeNo || ''), o.id);
    if (!updated.changes) throw Object.assign(new Error('订单已被并发处理'), { status: 409 });
    db.exec('COMMIT');
    outcome = { ok: true, duplicated: false, orderNo: o.order_no, balance: plan?.balance ?? bal.balance, order: o, plan };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
  // 到账通知（事务外，失败不影响入账结果）
  try {
    const o = outcome.order;
    runWithTenant(o.tenant_id, () => {
      for (const u of q.all(`SELECT id FROM users WHERE tenant_id = ? AND role IN ('boss','ops_director')`, o.tenant_id)) {
        if (outcome.plan) {
          notify(u.id, '充值到账', `「${o.package_name}」已开通`,
            `有效期至 ${outcome.plan.expiresAt}${outcome.plan.rolledOver ? '（已按原到期日顺延）' : ''}，含 ${outcome.plan.seatLimit ?? '-'} 个账号${outcome.plan.bonusCredits > 0 ? `，赠送 ${outcome.plan.bonusCredits} 积分已到账` : ''}，当前余额 ${outcome.balance} 积分`, '/recharge');
        } else {
          notify(u.id, '充值到账', `充值到账 ${o.credits} 积分`, `${o.package_name}（¥${o.price_yuan}，${channelName}）已到账，当前余额 ${outcome.balance} 积分`);
        }
      }
    });
  } catch (e) { console.warn('[recharge] 到账通知发送失败：', e?.message || e); }
  return { ok: outcome.ok, duplicated: outcome.duplicated, orderNo: outcome.orderNo, balance: outcome.balance, plan: outcome.plan || null };
}

const r = Router();

// 积分权益换算（A3）：登录即可读，供充值页"积分能做什么"与销售话术对齐；数字全部由价目表反算。
// 透传人民币口径（unit.*CostYuan / supplierCostYuan / marginFactor）与 basis：本企业真实文本流水样本足够时
// basis='observed'（observedSample 只含次数与 token 均值），否则 'price_table'。
r.get('/equivalents', (req, res) => {
  const raw = Number(req.query.credits);
  const credits = Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 1e12) : 60000;
  res.json(estimateCreditEquivalents(credits, { tenantId: req.user?.tenant_id ?? curTenant() }));
});

r.use(requireRole('boss', 'admin'));

function safePaymentAudit(user, action, target) {
  try {
    logOp(user, '充值中心', action, target);
    return true;
  } catch (error) {
    console.error(`[recharge-audit] ${action} 写入失败：`, error?.message || error);
    return false;
  }
}

// 已配置的在线支付通道（空数组 = 未配置，前端保持对公转账旧流程）
r.get('/channels', (_req, res) => {
  res.json({ channels: paymentChannels() });
});

// 充值套餐（启用中，按 sort）：kind=plan 为年度套餐、kind=credits 为纯积分包；features 为 JSON
r.get('/packages', (req, res) => {
  res.json(q.all('SELECT * FROM recharge_packages WHERE enabled = 1 ORDER BY sort, price_yuan')
    .map(p => ({ ...p, kind: p.kind || 'credits', features: safeJsonParse(p.features, null) })));
});

// 当前企业积分池 + 流水（充值 + 消耗合并时间线，对账用）
// plan 为套餐摘要 {code,name,seatLimit,seatsUsed,startedAt,expiresAt,status,daysLeft}；planLabel 保留旧文本标签
r.get('/balance', (req, res) => {
  const tid = req.user.tenant_id || 1;
  const t = getTenant(tid) || {};
  const logs = q.all(`SELECT feature, kind, credits, balance_after, ai_mode, note, created_at
    FROM credit_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT 50`, tid);
  const spent = q.get(`SELECT COALESCE(SUM(credits),0) s FROM credit_logs WHERE tenant_id = ? AND credits > 0`, tid)?.s || 0;
  res.json({
    credits: t.credits ?? 0, totalRecharged: t.total_recharged ?? 0, totalSpent: spent,
    plan: t.id ? planSummary(t) : null, planLabel: t.plan, tenantName: t.name, logs,
    // 月度 AI 预算摘要（与 /auth/me 同源，字段见 engines/credits.js budgetSummary）
    budget: t.id ? budgetSummary(t) : null,
  });
});

// 下单（FR-SAAS-04）：
// - 已配置在线支付通道：按 body.channel 调网关生成收款二维码，前端扫码支付、回调自动入账；
// - 未配置任何通道：保持原有对公转账流程与文案（超管确认到账后入账），二者并存。
r.post('/orders', async (req, res) => {
  const { packageId, channel } = req.body || {};
  const pkg = q.get('SELECT * FROM recharge_packages WHERE id = ? AND enabled = 1', packageId);
  if (!pkg) return res.status(400).json({ error: '套餐不存在或已下架' });
  const tid = req.user.tenant_id || 1;
  const orderNo = `R${Date.now()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const channels = paymentChannels();
  if (channels.length) {
    ensurePayColumns();
    const chosen = channels.find(c => c.channel === channel);
    if (!chosen) {
      return res.status(400).json({ error: `请选择支付方式（${channels.map(c => c.name).join(' / ')}）` });
    }
    // 先落本地订单，再请求远端。这样即使网关成功后本地二维码更新失败，
    // 回调和人工对账仍有可定位的 order_no，不会形成完全不可见的渠道孤儿单。
    let result;
    try {
      result = q.run(`INSERT INTO recharge_orders(
        order_no,tenant_id,package_id,package_name,price_yuan,credits,status,created_by,pay_channel,pay_method
      ) VALUES(?,?,?,?,?,?, '待支付', ?,?,?)`,
      orderNo, tid, pkg.id, pkg.name, pkg.price_yuan, pkg.total_credits, req.user.id,
      chosen.channel, chosen.name);
    } catch (error) {
      console.error(`[recharge] 本地订单预写失败 order=${orderNo}：`, error?.message || error);
      safePaymentAudit(req.user, '在线支付本地预写失败', `order=${orderNo};channel=${chosen.channel}`);
      return res.status(500).json({ error: '充值订单创建失败，尚未请求支付渠道，请稍后重试' });
    }

    let pay = null;
    let gatewayAttempted = false;
    let gatewayAccepted = false;
    try {
      gatewayAttempted = true;
      pay = await createPayment(chosen.channel, {
        orderNo, amountYuan: pkg.price_yuan, subject: `纳米Work积分充值·${pkg.name}`,
      });
      gatewayAccepted = true; // createPayment 只会返回验签通过的成功应答
      const finalized = q.run(`UPDATE recharge_orders
        SET qr_url=?,pay_expire_at=?
        WHERE id=? AND tenant_id=? AND order_no=? AND status='待支付'`,
      pay.qrUrl, pay.expireAt, result.lastInsertRowid, tid, orderNo);
      if (!finalized.changes) {
        throw Object.assign(new Error('远端下单成功，但本地订单收尾写入失败'), {
          status: 500,
          localFinalizationFailure: true,
        });
      }
    } catch (e) {
      // 请求已发出后即使收到的是超时/坏签名，也不能断言远端未建单。
      // 使用相同商户订单号尽最大努力关单；关单成功且验签通过后才本地取消，
      // 否则保留“待支付”供回调/主动查单/人工对账继续识别。
      let closeState = gatewayAttempted ? 'failed' : 'not_attempted';
      let closeError = null;
      if (gatewayAttempted) {
        try {
          await closePayment(chosen.channel, orderNo);
          closeState = 'closed';
        } catch (closeFailure) {
          closeError = closeFailure;
        }
      }
      let localStatus = '待支付';
      if (closeState === 'closed') {
        try {
          q.run(`UPDATE recharge_orders SET status='已取消',qr_url=NULL,pay_expire_at=NULL
            WHERE id=? AND tenant_id=? AND order_no=? AND status='待支付'`,
          result.lastInsertRowid, tid, orderNo);
        } catch (markError) {
          console.error(`[recharge] 渠道已关单但本地取消标记失败 order=${orderNo}：`, markError?.message || markError);
        }
      }
      // 响应中的本地状态必须以数据库事实为准，不能仅凭“渠道已关单”就宣称
      // 本地订单也已取消；本地标记失败时继续暴露待对账状态。
      try {
        localStatus = String(q.get(
          'SELECT status FROM recharge_orders WHERE id=? AND tenant_id=? AND order_no=?',
          result.lastInsertRowid, tid, orderNo,
        )?.status || '待支付');
      } catch (statusError) {
        console.error(`[recharge] 下单失败后读取本地状态失败 order=${orderNo}：`, statusError?.message || statusError);
      }
      const reconciliationRequired = closeState !== 'closed' || localStatus !== '已取消';
      safePaymentAudit(
        req.user,
        gatewayAccepted ? '在线支付远端成功后本地收尾失败' : '在线支付下单应答未采用',
        `order=${orderNo};channel=${chosen.channel};gatewayAccepted=${gatewayAccepted ? 1 : 0};close=${closeState};localStatus=${localStatus};reconcile=${reconciliationRequired ? 1 : 0}`,
      );
      console.error(
        `[recharge] ${chosen.name}下单未完成 order=${orderNo}; gatewayAccepted=${gatewayAccepted}; close=${closeState}：`,
        e?.message || e,
        closeError ? `；关单错误：${closeError?.message || closeError}` : '',
      );
      const status = gatewayAccepted
        ? 500
        : (Number.isInteger(e?.status) && e.status >= 400 && e.status < 600 && e.status !== 501
          ? e.status
          : 502);
      return res.status(status).json({
        error: gatewayAccepted
          ? '支付渠道已创建订单，但本地保存失败；系统已执行安全关单或保留待账务对账，请勿重复支付'
          : (e?.message || '支付下单失败，请稍后重试'),
        orderNo,
        status: localStatus,
        reconciliationRequired,
      });
    }
    safePaymentAudit(req.user, '提交充值订单', `${pkg.name} ¥${pkg.price_yuan}（${chosen.name}）`);
    return res.json({
      id: result.lastInsertRowid, orderNo, package: pkg,
      qrUrl: pay.qrUrl, channel: chosen.channel, channelName: chosen.name,
      expireAt: pay.expireAt, status: '待支付',
    });
  }
  const result = q.run(`INSERT INTO recharge_orders(order_no,tenant_id,package_id,package_name,price_yuan,credits,status,created_by)
    VALUES(?,?,?,?,?,?, '待支付', ?)`, orderNo, tid, pkg.id, pkg.name, pkg.price_yuan, pkg.total_credits, req.user.id);
  logOp(req.user, '充值中心', '提交充值订单', `${pkg.name} ¥${pkg.price_yuan}`);
  res.json({
    id: result.lastInsertRowid, orderNo, package: pkg,
    payGuide: '请通过对公转账或扫描门店收款码完成支付，备注订单号；平台确认到账后积分自动到账（通常5-30分钟）。',
  });
});

// 订单状态轮询（前端扫码支付页每3秒查一次）
// 网关主动查询节流：同一订单最短 15 秒查一次（前端 3 秒轮询主要读本地状态）
const gatewayQueryAt = new Map();
const GATEWAY_QUERY_MIN_MS = 15_000;
const EXPIRE_GRACE_MS = 5 * 60_000; // 二维码过期后留 5 分钟宽限给迟到回调，再自动关单
const CHANNEL_DISPLAY = { wechat: '微信支付', alipay: '支付宝' };

r.get('/orders/:orderNo/status', async (req, res) => {
  ensurePayColumns();
  const tid = req.user.tenant_id || 1;
  const orderNo = String(req.params.orderNo || '');
  const fetchOrder = () => q.get(`SELECT order_no, status, paid_at, credits, pay_channel, pay_expire_at
    FROM recharge_orders WHERE order_no = ? AND tenant_id = ?`, orderNo, tid);
  let o = fetchOrder();
  if (!o) return res.status(404).json({ error: '订单不存在' });

  // 主动对账（防掉单）：仅对通道订单，在轮询时顺带查网关（15 秒节流）；
  // 查询失败静默容错——异步回调仍是入账主路径。对公转账订单（无通道）不参与自动对账/关单。
  if (o.status === '待支付' && o.pay_channel) {
    const last = gatewayQueryAt.get(orderNo) || 0;
    if (Date.now() - last >= GATEWAY_QUERY_MIN_MS) {
      gatewayQueryAt.set(orderNo, Date.now());
      try {
        const gw = await queryPayment(o.pay_channel, orderNo);
        if (gw.paid) {
          settlePaidOrder({ orderNo, channelName: `${CHANNEL_DISPLAY[o.pay_channel] || o.pay_channel}（对账查得）`, tradeNo: gw.tradeNo, paidFen: gw.paidFen });
          o = fetchOrder();
        } else if (gw.closed) {
          q.run(`UPDATE recharge_orders SET status='已取消' WHERE order_no=? AND tenant_id=? AND status='待支付'`, orderNo, tid);
          o = fetchOrder();
        }
      } catch (e) {
        console.warn(`[recharge] 订单 ${orderNo} 网关对账查询失败（回调仍为主路径）：`, e?.message || e);
      }
    }
    // 超时自动关单：二维码过期 + 5 分钟宽限仍未支付。线上订单必须先让
    // 渠道关单成功且应答验签通过，远端失败时本地继续保持“待支付”。
    if (o.status === '待支付' && o.pay_expire_at && Date.now() > new Date(o.pay_expire_at).getTime() + EXPIRE_GRACE_MS) {
      try {
        await closePayment(o.pay_channel, orderNo);
        const closed = q.run(`UPDATE recharge_orders SET status='已取消' WHERE order_no=? AND tenant_id=? AND status='待支付'`, orderNo, tid);
        if (closed.changes) {
          gatewayQueryAt.delete(orderNo);
          logOp(req.user, '充值中心', '超时自动关单', `order ${orderNo}`);
          o = fetchOrder();
        }
      } catch (e) {
        console.warn(`[recharge] 订单 ${orderNo} 渠道关单失败，本地保持待支付：`, e?.message || e);
      }
    }
  }
  if (o.status !== '待支付') gatewayQueryAt.delete(orderNo);
  res.json({ orderNo: o.order_no, status: o.status, paidAt: o.paid_at, credits: o.credits, channel: o.pay_channel });
});

// 本企业充值记录
r.get('/orders', (req, res) => {
  const tid = req.user.tenant_id || 1;
  res.json(q.all(`SELECT o.*, u.name created_name FROM recharge_orders o LEFT JOIN users u ON u.id = o.created_by
    WHERE o.tenant_id = ? ORDER BY o.id DESC LIMIT 50`, tid));
});

// 取消未支付订单
r.post('/orders/:id/cancel', async (req, res) => {
  const tid = req.user.tenant_id || 1;
  const order = q.get(`SELECT id, order_no, status, pay_channel FROM recharge_orders
    WHERE id=? AND tenant_id=?`, req.params.id, tid);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  if (order.status !== '待支付') {
    return res.status(409).json({ error: `订单当前状态为“${order.status}”，不能取消` });
  }
  if (order.pay_channel) {
    try {
      await closePayment(order.pay_channel, order.order_no);
    } catch (e) {
      console.warn(`[recharge] 用户取消订单 ${order.order_no} 时渠道关单失败，本地保持待支付：`, e?.message || e);
      const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 600 ? e.status : 502;
      return res.status(status).json({ error: '支付渠道关单失败，订单仍保持待支付，请稍后重试' });
    }
  }
  const changed = q.run(`UPDATE recharge_orders SET status='已取消' WHERE id=? AND tenant_id=? AND status='待支付'`, req.params.id, tid);
  if (!changed.changes) {
    const existing = q.get('SELECT status FROM recharge_orders WHERE id=? AND tenant_id=?', req.params.id, tid);
    if (!existing) return res.status(404).json({ error: '订单不存在' });
    return res.status(409).json({ error: `订单当前状态为“${existing.status}”，不能取消` });
  }
  logOp(req.user, '充值中心', '取消充值订单', `order#${req.params.id}`);
  res.json({ ok: true });
});

export default r;

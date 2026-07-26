import { Router } from 'express';
import crypto from 'node:crypto';
import { q, getTenant } from '../db.js';
import { logOp, requireRole } from '../util.js';
import { balanceOfTenant } from '../engines/credits.js';

const r = Router();
r.use(requireRole('boss', 'admin', 'platform_super'));

// 充值套餐（启用中，按 sort）
r.get('/packages', (req, res) => {
  res.json(q.all('SELECT * FROM recharge_packages WHERE enabled = 1 ORDER BY sort, price_yuan'));
});

// 当前企业积分池 + 流水（充值 + 消耗合并时间线，对账用）
r.get('/balance', (req, res) => {
  const tid = req.user.tenant_id || 1;
  const t = getTenant(tid) || {};
  const logs = q.all(`SELECT feature, kind, credits, balance_after, ai_mode, note, created_at
    FROM credit_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT 50`, tid);
  const spent = q.get(`SELECT COALESCE(SUM(credits),0) s FROM credit_logs WHERE tenant_id = ? AND credits > 0`, tid)?.s || 0;
  res.json({
    credits: t.credits ?? 0, totalRecharged: t.total_recharged ?? 0, totalSpent: spent,
    plan: t.plan, tenantName: t.name, logs,
  });
});

// 下单（FR-SAAS-04）：生成待支付订单，返回收款指引；超管确认到账后入账
r.post('/orders', (req, res) => {
  const { packageId } = req.body || {};
  const pkg = q.get('SELECT * FROM recharge_packages WHERE id = ? AND enabled = 1', packageId);
  if (!pkg) return res.status(400).json({ error: '套餐不存在或已下架' });
  const tid = req.user.tenant_id || 1;
  const orderNo = `R${Date.now()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const result = q.run(`INSERT INTO recharge_orders(order_no,tenant_id,package_id,package_name,price_yuan,credits,status,created_by)
    VALUES(?,?,?,?,?,?, '待支付', ?)`, orderNo, tid, pkg.id, pkg.name, pkg.price_yuan, pkg.total_credits, req.user.id);
  logOp(req.user, '充值中心', '提交充值订单', `${pkg.name} ¥${pkg.price_yuan}`);
  res.json({
    id: result.lastInsertRowid, orderNo, package: pkg,
    payGuide: '请通过对公转账或扫描门店收款码完成支付，备注订单号；平台确认到账后积分自动到账（通常5-30分钟）。',
  });
});

// 本企业充值记录
r.get('/orders', (req, res) => {
  const tid = req.user.tenant_id || 1;
  res.json(q.all(`SELECT o.*, u.name created_name FROM recharge_orders o LEFT JOIN users u ON u.id = o.created_by
    WHERE o.tenant_id = ? ORDER BY o.id DESC LIMIT 50`, tid));
});

// 取消未支付订单
r.post('/orders/:id/cancel', (req, res) => {
  const tid = req.user.tenant_id || 1;
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

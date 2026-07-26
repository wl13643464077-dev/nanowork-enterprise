import express, { Router } from 'express';
import { verifyWechatNotify, verifyAlipayNotify, yuanToFen } from '../engines/payment.js';
import { settlePaidOrder } from './recharge.js';

// ===== 支付网关异步回调（免登录，须挂载在 authMiddleware 与全局 json 解析之前）=====
// 安全边界：回调的“鉴权”就是验签——验签失败一律 4xx 并记日志，绝不入账；
// 入账走 settlePaidOrder（与平台超管手工确认同一 creditTenant 口径），幂等保证重复回调只入账一次。

const r = Router();

// 微信支付 APIv3 回调：必须拿到 raw body 才能验签（签名对象是原始报文字节）
r.post('/wechat', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
  let event;
  try {
    event = verifyWechatNotify(req.headers, req.body);
  } catch (e) {
    console.warn(`[pay-notify][wechat] 回调被拒（${e?.status || 401}）：`, e?.message || e);
    return res.status(e?.status >= 400 && e?.status < 500 ? e.status : 401).json({ code: 'FAIL', message: '验签失败' });
  }
  try {
    const d = event.data || {};
    if (event.eventType !== 'TRANSACTION.SUCCESS' || d.trade_state !== 'SUCCESS') {
      // 非成功交易通知（退款/关单等）：确认收到但不入账
      return res.json({ code: 'SUCCESS', message: '非支付成功通知，已忽略' });
    }
    const out = settlePaidOrder({
      orderNo: d.out_trade_no,
      channelName: '微信支付',
      tradeNo: d.transaction_id,
      paidFen: Number(d.amount?.total),
    });
    if (out.duplicated) console.info(`[pay-notify][wechat] 重复回调已幂等忽略 order=${out.orderNo}`);
    res.json({ code: 'SUCCESS', message: '成功' });
  } catch (e) {
    console.error('[pay-notify][wechat] 入账失败：', e?.message || e);
    res.status(e?.status || 500).json({ code: 'FAIL', message: e?.message || '入账失败' });
  }
});

// 支付宝异步通知：form 表单（application/x-www-form-urlencoded），用支付宝公钥 RSA2 验签
r.post('/alipay', express.urlencoded({ extended: false, limit: '1mb' }), (req, res) => {
  let params;
  try {
    params = verifyAlipayNotify(req.body || {});
  } catch (e) {
    console.warn(`[pay-notify][alipay] 回调被拒（${e?.status || 401}）：`, e?.message || e);
    return res.status(e?.status >= 400 && e?.status < 500 ? e.status : 401).send('failure');
  }
  try {
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(String(params.trade_status || ''))) {
      return res.send('success'); // 非成功状态通知：确认收到但不入账
    }
    const out = settlePaidOrder({
      orderNo: params.out_trade_no,
      channelName: '支付宝',
      tradeNo: params.trade_no,
      paidFen: yuanToFen(params.total_amount),
    });
    if (out.duplicated) console.info(`[pay-notify][alipay] 重复回调已幂等忽略 order=${out.orderNo}`);
    res.send('success');
  } catch (e) {
    console.error('[pay-notify][alipay] 入账失败：', e?.message || e);
    res.status(e?.status || 500).send('failure');
  }
});

export default r;

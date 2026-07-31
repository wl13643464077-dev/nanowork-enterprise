import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';

// ===== 测试环境准备：独立临时库 + 禁止真实网络请求（NODE_ENV=test 时引擎层拒发真实请求）=====
const DBP = path.join(os.tmpdir(), `nanowork-recharge-pay-${process.pid}.db`);
for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = 'test';
// 确保初始为“未配置任何通道”
for (const k of ['WXPAY_MCHID', 'WXPAY_SERIAL_NO', 'WXPAY_PRIVATE_KEY', 'WXPAY_APIV3_KEY', 'WXPAY_APPID',
  'WXPAY_NOTIFY_URL', 'WXPAY_PLATFORM_CERT', 'WXPAY_PLATFORM_CERTS', 'ALIPAY_APPID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY',
  'ALIPAY_NOTIFY_URL', 'ALIPAY_GATEWAY']) delete process.env[k];

const { initSchema, migrateV2, q, db, runWithTenant } = await import('../src/db.js');
const payment = await import('../src/engines/payment.js');
const { paymentChannels, createPayment, queryPayment, yuanToFen, fenToYuanStr, _setHttpCall } = payment;
const rechargeRoutes = (await import('../src/routes/recharge.js')).default;
const notifyRoutes = (await import('../src/routes/recharge-notify.js')).default;

initSchema();
migrateV2();

const tenantId = q.run(`INSERT INTO tenants(name,status,plan,credits,total_recharged,seat_limit) VALUES('支付测试企业','已开通','标准版',0,0,10)`).lastInsertRowid;
const bossId = q.run(`INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('pay_boss','x','支付老板','boss',?)`, tenantId).lastInsertRowid;
const pkgId = q.run(`INSERT INTO recharge_packages(name,price_yuan,base_credits,bonus_credits,total_credits,tag,sort,enabled)
  VALUES('标准包88.8',88.8,8880,1000,9880,'热门',1,1)`).lastInsertRowid;
const boss = { id: Number(bossId), name: '支付老板', role: 'boss', tenant_id: Number(tenantId) };

// ===== 密钥材料：全部现场生成，不依赖外部 =====
const genKeys = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const priPem = (k) => k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pubPem = (k) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const wxMerchant = genKeys();   // 商户 API 私钥（我方签请求）
const wxPlatform = genKeys();   // 微信平台密钥（平台签回调）
const wxPlatformNext = genKeys(); // 微信平台轮换后的下一张证书
const aliMerchant = genKeys();  // 支付宝应用私钥（我方签请求）
const aliOfficial = genKeys();  // 支付宝官方密钥（支付宝签异步通知）
const APIV3_KEY = 'x'.repeat(32);

// ===== 支付网关同步应答构造：只在本地用临时平台私钥签名，绝不访问真实通道 =====
function buildWechatResponse(payload, {
  status = 200,
  signKey = wxPlatform.privateKey,
  serial = 'PLATFORM_SERIAL',
  timestamp = Math.floor(Date.now() / 1000),
} = {}) {
  const text = payload === '' ? '' : JSON.stringify(payload);
  const signedTimestamp = String(timestamp);
  const nonce = crypto.randomBytes(8).toString('hex');
  const signature = crypto.createSign('RSA-SHA256')
    .update(`${signedTimestamp}\n${nonce}\n${text}\n`, 'utf8')
    .sign(signKey, 'base64');
  return {
    status,
    text,
    headers: {
      'Wechatpay-Timestamp': signedTimestamp,
      'Wechatpay-Nonce': nonce,
      'Wechatpay-Signature': signature,
      'Wechatpay-Serial': serial,
    },
  };
}

function buildAlipayResponse(responseKey, payload, {
  status = 200,
  signKey = aliOfficial.privateKey,
} = {}) {
  const signedContent = JSON.stringify(payload);
  const sign = crypto.createSign('RSA-SHA256')
    .update(signedContent, 'utf8')
    .sign(signKey, 'base64');
  return {
    status,
    text: `{"${responseKey}":${signedContent},"sign":${JSON.stringify(sign)}}`,
  };
}

// ===== 可注入 fake HTTP 层：记录请求，返回固定二维码，绝不出网 =====
const httpCalls = [];
_setHttpCall(async (opts) => {
  httpCalls.push(opts);
  if (opts.url.includes('api.mch.weixin.qq.com')) {
    return buildWechatResponse({ code_url: 'weixin://wxpay/bizpayurl?pr=FAKE123' });
  }
  const form = new URLSearchParams(String(opts.body || ''));
  const orderNo = JSON.parse(form.get('biz_content') || '{}').out_trade_no;
  return buildAlipayResponse('alipay_trade_precreate_response', {
    code: '10000',
    msg: 'Success',
    out_trade_no: orderNo,
    qr_code: 'https://qr.alipay.com/FAKE456',
  });
});

// ===== 测试应用：notify 免登录挂载在 json 解析之前（与 index.js 相同拓扑）=====
function makeApp() {
  const app = express();
  app.use('/api/recharge/notify', notifyRoutes);
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(boss.tenant_id, () => { req.user = boss; next(); }));
  app.use('/api/recharge', rechargeRoutes);
  return app;
}
let server, base;
test.before(async () => {
  server = makeApp().listen(0);
  const port = await new Promise((r2) => server.once('listening', () => r2(server.address().port)));
  base = `http://127.0.0.1:${port}`;
});
test.after(async () => {
  await new Promise((r2) => server.close(r2));
  for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
});

const postJson = async (route, body) => {
  const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const getJson = async (route) => {
  const res = await fetch(`${base}${route}`);
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const tenantCredits = () => q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits;
const orderLogCount = (orderNo) => q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=? AND note=?`, tenantId, `订单 ${orderNo}`).n;

// ===== 微信回调构造：AES-256-GCM 加密 resource + 平台私钥签名 =====
function buildWechatNotify(txn, {
  signKey = wxPlatform.privateKey,
  serial = 'PLATFORM_SERIAL',
  timestamp = Math.floor(Date.now() / 1000),
} = {}) {
  const iv = crypto.randomBytes(6).toString('hex'); // 12 字符 nonce
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(APIV3_KEY, 'utf8'), Buffer.from(iv, 'utf8'));
  cipher.setAAD(Buffer.from('transaction', 'utf8'));
  const enc = Buffer.concat([cipher.update(JSON.stringify(txn), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const body = JSON.stringify({
    id: crypto.randomUUID(), create_time: new Date().toISOString(), event_type: 'TRANSACTION.SUCCESS',
    resource_type: 'encrypt-resource', summary: '支付成功',
    resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext: enc.toString('base64'), nonce: iv, associated_data: 'transaction' },
  });
  const nonce = crypto.randomBytes(8).toString('hex');
  const signature = crypto.createSign('RSA-SHA256').update(`${timestamp}\n${nonce}\n${body}\n`, 'utf8').sign(signKey, 'base64');
  return { body, headers: { 'Content-Type': 'application/json', 'Wechatpay-Timestamp': String(timestamp), 'Wechatpay-Nonce': nonce, 'Wechatpay-Signature': signature, 'Wechatpay-Serial': serial } };
}
const postWechatNotify = async ({ body, headers }) => {
  const res = await fetch(`${base}/api/recharge/notify/wechat`, { method: 'POST', headers, body });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

// ===== 支付宝异步通知构造：RSA2 签名 form =====
function buildAlipayNotify(fields, { signKey = aliOfficial.privateKey } = {}) {
  const params = {
    app_id: 'ALI_APP_ID_TEST', charset: 'utf-8', version: '1.0', sign_type: 'RSA2',
    notify_time: '2026-07-26 10:00:00', notify_type: 'trade_status_sync', trade_status: 'TRADE_SUCCESS',
    trade_no: `2026072622001${Math.floor(Math.random() * 1e6)}`, ...fields,
  };
  const content = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== undefined && params[k] !== '')
    .sort().map((k) => `${k}=${params[k]}`).join('&');
  params.sign = crypto.createSign('RSA-SHA256').update(content, 'utf8').sign(signKey, 'base64');
  return params;
}
const postAlipayNotify = async (params) => {
  const res = await fetch(`${base}/api/recharge/notify/alipay`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, text: await res.text() };
};

// =====================================================================

test('金额换算：元↔分（计费口径的地基）', () => {
  assert.equal(yuanToFen(88.8), 8880);
  assert.equal(yuanToFen(0.1), 10);
  assert.equal(yuanToFen('19.90'), 1990);
  assert.equal(yuanToFen(100), 10000);
  assert.equal(fenToYuanStr(8880), '88.80');
  assert.equal(fenToYuanStr(5), '0.05');
  assert.throws(() => yuanToFen(0), /大于0/);
  assert.throws(() => yuanToFen(-1), /大于0/);
  assert.throws(() => yuanToFen(9.999), /两位小数/);
  assert.throws(() => fenToYuanStr(1.5), /正整数/);
});

test('未配置任何通道：旧对公转账流程与文案完全不变', async () => {
  assert.deepEqual(paymentChannels(), []);
  const channels = await getJson('/api/recharge/channels');
  assert.deepEqual(channels.json.channels, []);
  // 即使带 channel 参数也走旧流程（未配置时诚实降级）
  const order = await postJson('/api/recharge/orders', { packageId: pkgId, channel: 'wechat' });
  assert.equal(order.status, 200);
  assert.ok(order.json.orderNo);
  assert.equal(order.json.qrUrl, undefined);
  assert.equal(order.json.payGuide, '请通过对公转账或扫描门店收款码完成支付，备注订单号；平台确认到账后积分自动到账（通常5-30分钟）。');
  assert.equal(q.get('SELECT status FROM recharge_orders WHERE order_no=?', order.json.orderNo).status, '待支付');
  // 微信/支付宝回调在未配置时一律被拒
  const wxRejected = await postWechatNotify(buildWechatNotify({ out_trade_no: order.json.orderNo, trade_state: 'SUCCESS', amount: { total: 8880 } }));
  assert.ok(wxRejected.status >= 400 && wxRejected.status < 600);
  assert.equal(tenantCredits(), 0);
});

test('配置通道后：微信/支付宝下单生成二维码，请求签名与金额正确', async () => {
  // 配置微信（私钥用 \n 转义单行，验证 PEM 归一化）+ 支付宝
  process.env.WXPAY_MCHID = '1900000001';
  process.env.WXPAY_SERIAL_NO = 'MCH_SERIAL_001';
  process.env.WXPAY_PRIVATE_KEY = priPem(wxMerchant).replace(/\n/g, '\\n');
  process.env.WXPAY_APIV3_KEY = APIV3_KEY;
  process.env.WXPAY_APPID = 'wx_test_appid';
  process.env.WXPAY_NOTIFY_URL = 'https://pay.example.com/api/recharge/notify/wechat';
  process.env.WXPAY_PLATFORM_CERT = pubPem(wxPlatform).replace(/\n/g, '\\n');
  process.env.ALIPAY_APPID = 'ALI_APP_ID_TEST';
  process.env.ALIPAY_PRIVATE_KEY = priPem(aliMerchant);
  process.env.ALIPAY_PUBLIC_KEY = pubPem(aliOfficial);
  process.env.ALIPAY_NOTIFY_URL = 'https://pay.example.com/api/recharge/notify/alipay';
  assert.deepEqual(paymentChannels().map((c) => c.channel), ['wechat', 'alipay']);

  // 通道校验：未选/选了未配置的通道 → 400
  const noChannel = await postJson('/api/recharge/orders', { packageId: pkgId });
  assert.equal(noChannel.status, 400);
  const badChannel = await postJson('/api/recharge/orders', { packageId: pkgId, channel: 'paypal' });
  assert.equal(badChannel.status, 400);

  // 微信下单
  httpCalls.length = 0;
  const wxOrder = await postJson('/api/recharge/orders', { packageId: pkgId, channel: 'wechat' });
  assert.equal(wxOrder.status, 200);
  assert.equal(wxOrder.json.qrUrl, 'weixin://wxpay/bizpayurl?pr=FAKE123');
  assert.equal(wxOrder.json.channel, 'wechat');
  assert.equal(wxOrder.json.status, '待支付');
  assert.ok(wxOrder.json.expireAt);
  const wxCall = httpCalls[0];
  const wxBody = JSON.parse(wxCall.body);
  assert.equal(wxBody.amount.total, 8880); // 88.8 元 → 8880 分
  assert.equal(wxBody.out_trade_no, wxOrder.json.orderNo);
  assert.equal(wxBody.mchid, '1900000001');
  // Authorization 头签名可用商户公钥验通过（SHA256-RSA2048）
  const auth = wxCall.headers.Authorization;
  assert.ok(auth.startsWith('WECHATPAY2-SHA256-RSA2048 '));
  const pick = (name) => auth.match(new RegExp(`${name}="([^"]+)"`))[1];
  const msg = `POST\n/v3/pay/transactions/native\n${pick('timestamp')}\n${pick('nonce_str')}\n${wxCall.body}\n`;
  assert.ok(crypto.createVerify('RSA-SHA256').update(msg, 'utf8').verify(wxMerchant.publicKey, pick('signature'), 'base64'));
  assert.equal(pick('serial_no'), 'MCH_SERIAL_001');
  // 订单落库带通道与二维码
  const row = q.get('SELECT * FROM recharge_orders WHERE order_no=?', wxOrder.json.orderNo);
  assert.equal(row.pay_channel, 'wechat');
  assert.equal(row.qr_url, 'weixin://wxpay/bizpayurl?pr=FAKE123');

  // 支付宝下单
  httpCalls.length = 0;
  const aliOrder = await postJson('/api/recharge/orders', { packageId: pkgId, channel: 'alipay' });
  assert.equal(aliOrder.status, 200);
  assert.equal(aliOrder.json.qrUrl, 'https://qr.alipay.com/FAKE456');
  const form = Object.fromEntries(new URLSearchParams(httpCalls[0].body));
  assert.equal(form.method, 'alipay.trade.precreate');
  assert.equal(form.sign_type, 'RSA2');
  const biz = JSON.parse(form.biz_content);
  assert.equal(biz.total_amount, '88.80'); // 元字符串两位小数
  assert.equal(biz.out_trade_no, aliOrder.json.orderNo);
  // RSA2 请求签名可用应用公钥验通过
  const content = Object.keys(form).filter((k) => k !== 'sign' && k !== 'sign_type' && form[k] !== '').sort().map((k) => `${k}=${form[k]}`).join('&');
  assert.ok(crypto.createVerify('RSA-SHA256').update(content, 'utf8').verify(aliMerchant.publicKey, form.sign, 'base64'));

  // 状态轮询接口
  const st = await getJson(`/api/recharge/orders/${wxOrder.json.orderNo}/status`);
  assert.equal(st.status, 200);
  assert.equal(st.json.status, '待支付');
});

test('微信回调：未配置平台证书默认拒绝；验签失败拒绝；验签通过幂等入账，重复回调不重复入账', async () => {
  const order = (await postJson('/api/recharge/orders', { packageId: pkgId, channel: 'wechat' })).json;
  const txn = { out_trade_no: order.orderNo, transaction_id: 'WX_TXN_001', trade_state: 'SUCCESS', amount: { total: 8880, payer_total: 8880 } };
  const before = tenantCredits();

  // 1) 未配置 WXPAY_PLATFORM_CERT → 即使签名有效也拒绝（安全默认拒绝）
  delete process.env.WXPAY_PLATFORM_CERT;
  const noCert = await postWechatNotify(buildWechatNotify(txn));
  assert.equal(noCert.status, 401);
  assert.equal(tenantCredits(), before);
  assert.equal(q.get('SELECT status FROM recharge_orders WHERE order_no=?', order.orderNo).status, '待支付');

  // 2) 配置平台公钥后：假签名（别人的私钥）→ 拒绝
  process.env.WXPAY_PLATFORM_CERT = pubPem(wxPlatform).replace(/\n/g, '\\n');
  const forged = await postWechatNotify(buildWechatNotify(txn, { signKey: aliOfficial.privateKey }));
  assert.equal(forged.status, 401);
  assert.equal(tenantCredits(), before);

  // 3) 时间戳超窗（重放）→ 拒绝
  const stale = await postWechatNotify(buildWechatNotify(txn, { timestamp: Math.floor(Date.now() / 1000) - 3600 }));
  assert.equal(stale.status, 401);
  assert.equal(tenantCredits(), before);

  // 4) 金额不符 → 拒绝入账
  const wrongAmount = await postWechatNotify(buildWechatNotify({ ...txn, amount: { total: 1 } }));
  assert.equal(wrongAmount.status, 400);
  assert.equal(tenantCredits(), before);
  assert.equal(q.get('SELECT status FROM recharge_orders WHERE order_no=?', order.orderNo).status, '待支付');

  // 5) 合法回调 → 入账一次，订单已支付，流水口径与平台手工确认一致（"订单 <orderNo>"）
  const ok = await postWechatNotify(buildWechatNotify(txn));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.code, 'SUCCESS');
  assert.equal(tenantCredits(), before + 9880);
  const paid = q.get('SELECT * FROM recharge_orders WHERE order_no=?', order.orderNo);
  assert.equal(paid.status, '已支付');
  assert.equal(paid.pay_trade_no, 'WX_TXN_001');
  assert.equal(orderLogCount(order.orderNo), 1);

  // 6) 核心用例：同一订单重复回调 → 响应成功（网关停止重试）但只入账一次
  const dup = await postWechatNotify(buildWechatNotify(txn));
  assert.equal(dup.status, 200);
  assert.equal(tenantCredits(), before + 9880);
  assert.equal(orderLogCount(order.orderNo), 1);
  assert.equal(q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=?`, tenantId).n,
    q.get(`SELECT COUNT(DISTINCT note) n FROM credit_logs WHERE tenant_id=?`, tenantId).n);
});

test('支付宝回调：验签失败拒绝；验签通过幂等入账；重复回调不重复入账；金额不符拒绝', async () => {
  const order = (await postJson('/api/recharge/orders', { packageId: pkgId, channel: 'alipay' })).json;
  const before = tenantCredits();
  const fields = { out_trade_no: order.orderNo, total_amount: '88.80' };

  // 1) 篡改报文（签名对不上）→ 拒绝
  const tampered = buildAlipayNotify(fields);
  tampered.total_amount = '0.01';
  const bad = await postAlipayNotify(tampered);
  assert.equal(bad.status, 401);
  assert.equal(bad.text, 'failure');
  assert.equal(tenantCredits(), before);

  // 2) 假私钥签名 → 拒绝
  const forged = await postAlipayNotify(buildAlipayNotify(fields, { signKey: wxPlatform.privateKey }));
  assert.equal(forged.status, 401);
  assert.equal(tenantCredits(), before);

  // 3) 签名有效但金额不符 → 拒绝入账
  const wrongAmount = await postAlipayNotify(buildAlipayNotify({ ...fields, total_amount: '0.01' }));
  assert.equal(wrongAmount.status, 400);
  assert.equal(tenantCredits(), before);

  // 4) 合法回调 → 入账一次
  const ok = await postAlipayNotify(buildAlipayNotify(fields));
  assert.equal(ok.status, 200);
  assert.equal(ok.text, 'success');
  assert.equal(tenantCredits(), before + 9880);
  assert.equal(q.get('SELECT status FROM recharge_orders WHERE order_no=?', order.orderNo).status, '已支付');
  assert.equal(orderLogCount(order.orderNo), 1);

  // 5) 核心用例：重复回调 → 幂等成功，不重复入账
  const dup = await postAlipayNotify(buildAlipayNotify(fields));
  assert.equal(dup.status, 200);
  assert.equal(dup.text, 'success');
  assert.equal(tenantCredits(), before + 9880);
  assert.equal(orderLogCount(order.orderNo), 1);

  // 6) 非成功状态通知（WAIT_BUYER_PAY）→ 确认收到但不入账
  const order2 = (await postJson('/api/recharge/orders', { packageId: pkgId, channel: 'alipay' })).json;
  const waiting = await postAlipayNotify(buildAlipayNotify({ out_trade_no: order2.orderNo, total_amount: '88.80', trade_status: 'WAIT_BUYER_PAY' }));
  assert.equal(waiting.status, 200);
  assert.equal(q.get('SELECT status FROM recharge_orders WHERE order_no=?', order2.orderNo).status, '待支付');

  // 支付成功后前端轮询能看到已支付
  const st = await getJson(`/api/recharge/orders/${order.orderNo}/status`);
  assert.equal(st.json.status, '已支付');
});

test('已取消订单收到回调：拒绝自动入账（人工核对）', async () => {
  const order = (await postJson('/api/recharge/orders', { packageId: pkgId, channel: 'alipay' })).json;
  q.run(`UPDATE recharge_orders SET status='已取消' WHERE order_no=?`, order.orderNo);
  const before = tenantCredits();
  const rsp = await postAlipayNotify(buildAlipayNotify({ out_trade_no: order.orderNo, total_amount: '88.80' }));
  assert.equal(rsp.status, 409);
  assert.equal(tenantCredits(), before);
  assert.equal(q.get('SELECT status FROM recharge_orders WHERE order_no=?', order.orderNo).status, '已取消');
});

test('测试环境安全阀：未注入 mock 时引擎拒绝发真实网络请求', async () => {
  _setHttpCall(null); // 还原为真实实现
  await assert.rejects(
    () => createPayment('wechat', { orderNo: 'RTEST', amountYuan: 1, subject: 't' }),
    /测试环境禁止调用真实支付网关/,
  );
  _setHttpCall(async () => ({ status: 200, text: '{}' }));
});

// =====================================================================
// 主动对账与超时关单（迭代八）：轮询状态时顺带查网关，防掉单；过期+宽限后自动关单
// =====================================================================

const setBothChannelEnvs = () => {
  process.env.WXPAY_MCHID = '1900000001';
  process.env.WXPAY_SERIAL_NO = 'MCH_SERIAL_TEST';
  process.env.WXPAY_PRIVATE_KEY = priPem(wxMerchant);
  process.env.WXPAY_APIV3_KEY = APIV3_KEY;
  process.env.WXPAY_APPID = 'wx_test_app';
  process.env.WXPAY_NOTIFY_URL = 'https://demo.example.com/api/recharge/notify/wechat';
  process.env.WXPAY_PLATFORM_CERT = pubPem(wxPlatform);
  process.env.ALIPAY_APPID = 'ALI_APP_ID_TEST';
  process.env.ALIPAY_PRIVATE_KEY = priPem(aliMerchant);
  process.env.ALIPAY_PUBLIC_KEY = pubPem(aliOfficial);
  process.env.ALIPAY_NOTIFY_URL = 'https://demo.example.com/api/recharge/notify/alipay';
};

function reconcileMock({
  aliQuery,
  wxQuery,
  aliQuerySignKey = aliOfficial.privateKey,
  wxQuerySignKey = wxPlatform.privateKey,
  aliCloseSignKey = aliOfficial.privateKey,
  wxCloseSignKey = wxPlatform.privateKey,
  closeFailure = false,
} = {}) {
  _setHttpCall(async (opts) => {
    const body = String(opts.body || '');
    if (opts.url.includes('/v3/pay/transactions/out-trade-no/') && opts.url.endsWith('/close')) {
      if (closeFailure) return { status: 503, text: JSON.stringify({ code: 'SYSTEM_ERROR' }) };
      return buildWechatResponse('', { status: 204, signKey: wxCloseSignKey });
    }
    if (opts.url.includes('/v3/pay/transactions/out-trade-no/')) {
      const orderNo = decodeURIComponent(opts.url.match(/out-trade-no\/([^/?]+)/)?.[1] || '');
      return buildWechatResponse(
        {
          appid: process.env.WXPAY_APPID,
          mchid: process.env.WXPAY_MCHID,
          out_trade_no: orderNo,
          ...(wxQuery || { trade_state: 'NOTPAY' }),
        },
        { signKey: wxQuerySignKey },
      );
    }
    if (opts.url.includes('api.mch.weixin.qq.com')) {
      return buildWechatResponse({ code_url: 'weixin://wxpay/bizpayurl?pr=RECON' });
    }
    const form = new URLSearchParams(body);
    if (form.get('method') === 'alipay.trade.query') {
      const orderNo = JSON.parse(form.get('biz_content') || '{}').out_trade_no;
      const payload = aliQuery || { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' };
      return buildAlipayResponse(
        'alipay_trade_query_response',
        payload.code === '10000' ? { out_trade_no: orderNo, ...payload } : payload,
        { signKey: aliQuerySignKey },
      );
    }
    if (form.get('method') === 'alipay.trade.close') {
      if (closeFailure) return { status: 503, text: JSON.stringify({ error: 'fake gateway unavailable' }) };
      const orderNo = JSON.parse(form.get('biz_content') || '{}').out_trade_no;
      return buildAlipayResponse(
        'alipay_trade_close_response',
        { code: '10000', msg: 'Success', out_trade_no: orderNo },
        { signKey: aliCloseSignKey },
      );
    }
    return buildAlipayResponse(
      'alipay_trade_precreate_response',
      {
        code: '10000',
        msg: 'Success',
        out_trade_no: JSON.parse(form.get('biz_content') || '{}').out_trade_no,
        qr_code: 'https://qr.alipay.com/RECON',
      },
    );
  });
}

test('下单成功响应必须验签：微信/支付宝坏签名二维码均拒绝采用', async () => {
  setBothChannelEnvs();
  _setHttpCall(async (opts) => {
    if (opts.url.includes('api.mch.weixin.qq.com')) {
      return buildWechatResponse(
        { code_url: 'weixin://wxpay/bizpayurl?pr=FORGED' },
        { signKey: aliOfficial.privateKey },
      );
    }
    return buildAlipayResponse(
      'alipay_trade_precreate_response',
      { code: '10000', msg: 'Success', qr_code: 'https://qr.alipay.com/FORGED' },
      { signKey: wxPlatform.privateKey },
    );
  });
  await assert.rejects(
    () => createPayment('wechat', { orderNo: 'R_FORGED_CREATE_WX', amountYuan: 88.8, subject: '验签测试' }),
    /验签失败/,
  );
  await assert.rejects(
    () => createPayment('alipay', { orderNo: 'R_FORGED_CREATE_ALI', amountYuan: 88.8, subject: '验签测试' }),
    /验签失败/,
  );
  reconcileMock();
});

test('支付宝同步应答重复业务节点不得让未签名对象覆盖已验签对象', async () => {
  setBothChannelEnvs();
  _setHttpCall(async (opts) => {
    const form = new URLSearchParams(String(opts.body || ''));
    const orderNo = JSON.parse(form.get('biz_content') || '{}').out_trade_no;
    const signedPayload = {
      code: '10000',
      msg: 'Success',
      out_trade_no: orderNo,
      qr_code: 'https://qr.alipay.com/SAFE_SIGNED',
    };
    const signedContent = JSON.stringify(signedPayload);
    const sign = crypto.createSign('RSA-SHA256')
      .update(signedContent, 'utf8')
      .sign(aliOfficial.privateKey, 'base64');
    const unsignedPayload = {
      ...signedPayload,
      qr_code: 'https://attacker.invalid/UNSIGNED',
    };
    return {
      status: 200,
      text: `{"alipay_trade_precreate_response":${signedContent},`
        + `"alipay_trade_precreate_response":${JSON.stringify(unsignedPayload)},`
        + `"sign":${JSON.stringify(sign)}}`,
    };
  });
  await assert.rejects(
    () => createPayment('alipay', {
      orderNo: 'R_ALIPAY_DUPLICATE_NODE',
      amountYuan: 88.8,
      subject: '重复业务节点防护测试',
    }),
    /重复业务响应节点/,
  );
  reconcileMock();
});

test('支付宝预下单成功应答必须绑定请求商户订单号', async () => {
  setBothChannelEnvs();
  _setHttpCall(async () => buildAlipayResponse(
    'alipay_trade_precreate_response',
    {
      code: '10000',
      msg: 'Success',
      out_trade_no: 'R_ALIPAY_OTHER_ORDER',
      qr_code: 'https://qr.alipay.com/VALID_SIGN_WRONG_ORDER',
    },
  ));
  await assert.rejects(
    () => createPayment('alipay', {
      orderNo: 'R_ALIPAY_EXPECTED_ORDER',
      amountYuan: 88.8,
      subject: '订单绑定测试',
    }),
    /订单号不匹配/,
  );
  reconcileMock();
});

test('微信同步成功应答即使签名正确，时间戳超窗也拒绝采用', async () => {
  setBothChannelEnvs();
  _setHttpCall(async () => buildWechatResponse(
    { code_url: 'weixin://wxpay/bizpayurl?pr=STALE_SIGNED' },
    { timestamp: Math.floor(Date.now() / 1000) - 3600 },
  ));
  await assert.rejects(
    () => createPayment('wechat', {
      orderNo: 'R_WECHAT_STALE_RESPONSE',
      amountYuan: 88.8,
      subject: '同步应答防重放测试',
    }),
    /时间戳超出5分钟/,
  );
  reconcileMock();
});

test('微信多平台证书按 Wechatpay-Serial 精确轮换，未知序列号在应答和回调均拒绝', async () => {
  setBothChannelEnvs();
  delete process.env.WXPAY_PLATFORM_CERT;
  process.env.WXPAY_PLATFORM_CERTS = JSON.stringify({
    SERIAL_CURRENT: pubPem(wxPlatform),
    SERIAL_NEXT: pubPem(wxPlatformNext),
  });
  _setHttpCall(async (opts) => {
    if (opts.url.includes('/v3/pay/transactions/out-trade-no/')) {
      const orderNo = decodeURIComponent(opts.url.match(/out-trade-no\/([^/?]+)/)?.[1] || '');
      return buildWechatResponse({
        appid: process.env.WXPAY_APPID,
        mchid: process.env.WXPAY_MCHID,
        out_trade_no: orderNo,
        trade_state: 'NOTPAY',
      }, { signKey: wxPlatformNext.privateKey, serial: 'SERIAL_NEXT' });
    }
    return buildWechatResponse(
      { code_url: 'weixin://wxpay/bizpayurl?pr=ROTATED' },
      { signKey: wxPlatformNext.privateKey, serial: 'SERIAL_NEXT' },
    );
  });
  const created = await createPayment('wechat', {
    orderNo: 'R_ROTATED_CREATE',
    amountYuan: 88.8,
    subject: '证书轮换测试',
  });
  assert.equal(created.qrUrl, 'weixin://wxpay/bizpayurl?pr=ROTATED');
  assert.equal((await queryPayment('wechat', 'R_ROTATED_QUERY')).paid, false);

  _setHttpCall(async () => buildWechatResponse(
    { code_url: 'weixin://wxpay/bizpayurl?pr=UNKNOWN' },
    { signKey: wxPlatformNext.privateKey, serial: 'SERIAL_UNKNOWN' },
  ));
  await assert.rejects(
    () => createPayment('wechat', {
      orderNo: 'R_UNKNOWN_SERIAL',
      amountYuan: 88.8,
      subject: '未知证书测试',
    }),
    /序列号 SERIAL_UNKNOWN 未配置/,
  );

  const callbackOrderNo = `R_ROTATED_NOTIFY_${Date.now()}`;
  q.run(`INSERT INTO recharge_orders(
    order_no,tenant_id,package_id,package_name,price_yuan,credits,status,created_by,pay_channel
  ) VALUES(?,?,?,?,?,?,'待支付',?,'wechat')`,
  callbackOrderNo, tenantId, pkgId, '标准包88.8', 88.8, 9880, bossId);
  const before = tenantCredits();
  const callback = await postWechatNotify(buildWechatNotify({
    out_trade_no: callbackOrderNo,
    transaction_id: 'WX_ROTATED_NOTIFY',
    trade_state: 'SUCCESS',
    amount: { total: 8880 },
  }, { signKey: wxPlatformNext.privateKey, serial: 'SERIAL_NEXT' }));
  assert.equal(callback.status, 200);
  assert.equal(tenantCredits(), before + 9880);

  const unknownOrderNo = `R_UNKNOWN_NOTIFY_${Date.now()}`;
  q.run(`INSERT INTO recharge_orders(
    order_no,tenant_id,package_id,package_name,price_yuan,credits,status,created_by,pay_channel
  ) VALUES(?,?,?,?,?,?,'待支付',?,'wechat')`,
  unknownOrderNo, tenantId, pkgId, '标准包88.8', 88.8, 9880, bossId);
  const beforeUnknown = tenantCredits();
  const rejected = await postWechatNotify(buildWechatNotify({
    out_trade_no: unknownOrderNo,
    transaction_id: 'WX_UNKNOWN_NOTIFY',
    trade_state: 'SUCCESS',
    amount: { total: 8880 },
  }, { signKey: wxPlatformNext.privateKey, serial: 'SERIAL_UNKNOWN' }));
  assert.equal(rejected.status, 401);
  assert.equal(tenantCredits(), beforeUnknown);

  delete process.env.WXPAY_PLATFORM_CERTS;
  process.env.WXPAY_PLATFORM_CERT = pubPem(wxPlatform);
  reconcileMock();
});

test('远端下单成功但本地二维码收尾失败时自动关单，并保留订单与安全审计', async () => {
  setBothChannelEnvs();
  const methods = [];
  _setHttpCall(async (opts) => {
    const form = new URLSearchParams(String(opts.body || ''));
    const method = form.get('method');
    methods.push(method);
    if (method === 'alipay.trade.precreate') {
      const orderNo = JSON.parse(form.get('biz_content') || '{}').out_trade_no;
      return buildAlipayResponse(
        'alipay_trade_precreate_response',
        {
          code: '10000',
          msg: 'Success',
          out_trade_no: orderNo,
          qr_code: 'https://qr.alipay.com/LOCAL_WRITE_FAIL',
        },
      );
    }
    if (method === 'alipay.trade.close') {
      const orderNo = JSON.parse(form.get('biz_content') || '{}').out_trade_no;
      return buildAlipayResponse(
        'alipay_trade_close_response',
        { code: '10000', msg: 'Success', out_trade_no: orderNo },
      );
    }
    throw new Error(`unexpected payment method: ${method}`);
  });
  db.exec(`CREATE TRIGGER injected_recharge_qr_finalize_failure
    BEFORE UPDATE OF qr_url ON recharge_orders
    WHEN NEW.qr_url IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT,'injected recharge qr finalize failure');
    END`);
  try {
    const result = await postJson('/api/recharge/orders', {
      packageId: pkgId,
      channel: 'alipay',
    });
    assert.equal(result.status, 500);
    assert.ok(result.json.orderNo);
    assert.equal(result.json.status, '已取消');
    assert.equal(result.json.reconciliationRequired, false);
    assert.deepEqual(methods, ['alipay.trade.precreate', 'alipay.trade.close']);
    const stored = q.get(
      'SELECT id,status,qr_url,pay_channel FROM recharge_orders WHERE order_no=?',
      result.json.orderNo,
    );
    assert.ok(stored?.id, '远端调用前必须已有可对账的本地订单');
    assert.equal(stored.status, '已取消');
    assert.equal(stored.qr_url, null);
    assert.equal(stored.pay_channel, 'alipay');
    assert.equal(q.get(
      `SELECT COUNT(*) n FROM op_logs
       WHERE tenant_id=? AND action='在线支付远端成功后本地收尾失败' AND target LIKE ?`,
      tenantId,
      `%order=${result.json.orderNo};%`,
    ).n, 1);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_recharge_qr_finalize_failure');
    reconcileMock();
  }
});

test('远端下单成功且本地收尾失败时，若渠道关单也失败则保留待支付并标记待对账', async () => {
  setBothChannelEnvs();
  reconcileMock({ closeFailure: true });
  db.exec(`CREATE TRIGGER injected_recharge_qr_finalize_and_close_failure
    BEFORE UPDATE OF qr_url ON recharge_orders
    WHEN NEW.qr_url IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT,'injected recharge qr finalize failure before close failure');
    END`);
  try {
    const result = await postJson('/api/recharge/orders', {
      packageId: pkgId,
      channel: 'alipay',
    });
    assert.equal(result.status, 500);
    assert.ok(result.json.orderNo);
    assert.equal(result.json.status, '待支付');
    assert.equal(result.json.reconciliationRequired, true);
    const stored = q.get(
      'SELECT status,qr_url,pay_channel FROM recharge_orders WHERE order_no=?',
      result.json.orderNo,
    );
    assert.equal(stored.status, '待支付');
    assert.equal(stored.qr_url, null);
    assert.equal(stored.pay_channel, 'alipay');
    assert.equal(q.get(
      `SELECT COUNT(*) n FROM op_logs
       WHERE tenant_id=? AND action='在线支付远端成功后本地收尾失败' AND target LIKE ?`,
      tenantId,
      `%order=${result.json.orderNo};%close=failed;%reconcile=1%`,
    ).n, 1);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_recharge_qr_finalize_and_close_failure');
    reconcileMock();
  }
});

test('主动查单严格验签：微信/支付宝坏签名均拒绝，不能把伪造应答当作支付结果', async () => {
  setBothChannelEnvs();
  reconcileMock({
    wxQuery: { trade_state: 'SUCCESS', transaction_id: 'FORGED_WX', amount: { total: 8880 } },
    wxQuerySignKey: aliOfficial.privateKey,
  });
  await assert.rejects(() => queryPayment('wechat', 'R_FORGED_WX'), /验签失败/);

  reconcileMock({
    aliQuery: {
      code: '10000',
      msg: 'Success',
      out_trade_no: 'R_FORGED_ALI',
      trade_status: 'TRADE_SUCCESS',
      trade_no: 'FORGED_ALI',
      total_amount: '88.80',
    },
    aliQuerySignKey: wxPlatform.privateKey,
  });
  await assert.rejects(() => queryPayment('alipay', 'R_FORGED_ALI'), /验签失败/);
});

test('微信主动查单金额按订单总额核对，优惠后的付款人实付额不应误判为订单金额', async () => {
  setBothChannelEnvs();
  reconcileMock({
    wxQuery: {
      trade_state: 'SUCCESS',
      transaction_id: 'WX_WITH_DISCOUNT',
      amount: { total: 8880, payer_total: 1, currency: 'CNY', payer_currency: 'CNY' },
    },
  });
  const result = await queryPayment('wechat', 'R_WX_DISCOUNT');
  assert.equal(result.paid, true);
  assert.equal(result.paidFen, 8880);
});

test('主动对账：轮询状态时查得支付宝已支付 → 自动入账一次，重复轮询不重复入账', async () => {
  setBothChannelEnvs();
  reconcileMock({ aliQuery: { code: '10000', msg: 'Success', trade_status: 'TRADE_SUCCESS', trade_no: 'RECON_TRADE_1', total_amount: '88.80' } });
  const before = tenantCredits();
  const created = await postJson('/api/recharge/orders', { packageId: pkgId, channel: 'alipay' });
  assert.ok(created.json.orderNo, `下单失败：${JSON.stringify(created.json)}`);
  const orderNo = created.json.orderNo;
  const polled = await getJson(`/api/recharge/orders/${orderNo}/status`);
  assert.equal(polled.json.status, '已支付');
  assert.equal(tenantCredits(), before + 9880);
  assert.equal(orderLogCount(orderNo), 1);
  const again = await getJson(`/api/recharge/orders/${orderNo}/status`);
  assert.equal(again.json.status, '已支付');
  assert.equal(orderLogCount(orderNo), 1); // 幂等：绝不二次入账
});

test('主动对账：微信侧订单已关闭（CLOSED）→ 本地订单自动取消', async () => {
  setBothChannelEnvs();
  reconcileMock({ wxQuery: { trade_state: 'CLOSED' } });
  const created = await postJson('/api/recharge/orders', { packageId: pkgId, channel: 'wechat' });
  assert.ok(created.json.orderNo, `下单失败：${JSON.stringify(created.json)}`);
  const polled = await getJson(`/api/recharge/orders/${created.json.orderNo}/status`);
  assert.equal(polled.json.status, '已取消');
});

test('超时自动关单：二维码过期超过宽限期且网关未支付 → 订单自动取消；对公转账订单不受影响', async () => {
  setBothChannelEnvs();
  reconcileMock(); // 网关返回未支付
  const created = await postJson('/api/recharge/orders', { packageId: pkgId, channel: 'alipay' });
  const orderNo = created.json.orderNo;
  // 把过期时间拨到 10 分钟前（宽限 5 分钟已过）
  q.run(`UPDATE recharge_orders SET pay_expire_at=? WHERE order_no=?`, new Date(Date.now() - 10 * 60_000).toISOString(), orderNo);
  const polled = await getJson(`/api/recharge/orders/${orderNo}/status`);
  assert.equal(polled.json.status, '已取消');
  // 对公转账订单（无通道）：即使很旧也绝不自动关单
  for (const k of ['WXPAY_MCHID', 'WXPAY_SERIAL_NO', 'WXPAY_PRIVATE_KEY', 'WXPAY_APIV3_KEY', 'WXPAY_APPID',
    'WXPAY_NOTIFY_URL', 'WXPAY_PLATFORM_CERT', 'WXPAY_PLATFORM_CERTS', 'ALIPAY_APPID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY',
    'ALIPAY_NOTIFY_URL']) delete process.env[k];
  const manual = await postJson('/api/recharge/orders', { packageId: pkgId });
  assert.ok(manual.json.orderNo, `下单失败：${JSON.stringify(manual.json)}`);
  const manualNo = manual.json.orderNo;
  q.run(`UPDATE recharge_orders SET created_at=datetime('now','-3 days') WHERE order_no=?`, manualNo);
  const manualPolled = await getJson(`/api/recharge/orders/${manualNo}/status`);
  assert.equal(manualPolled.json.status, '待支付');
});

test('本地取消：在线订单必须先关闭渠道交易；远端失败时本地保持待支付', async () => {
  setBothChannelEnvs();
  reconcileMock({ closeFailure: true });
  const created = await postJson('/api/recharge/orders', { packageId: pkgId, channel: 'alipay' });
  assert.ok(created.json.id, `下单失败：${JSON.stringify(created.json)}`);

  const cancelled = await postJson(`/api/recharge/orders/${created.json.id}/cancel`);
  assert.ok(cancelled.status >= 400);
  assert.equal(q.get('SELECT status FROM recharge_orders WHERE id=?', created.json.id).status, '待支付');

  reconcileMock();
  const ok = await postJson(`/api/recharge/orders/${created.json.id}/cancel`);
  assert.equal(ok.status, 200);
  assert.equal(q.get('SELECT status FROM recharge_orders WHERE id=?', created.json.id).status, '已取消');
});

test('超时取消：渠道关单失败或应答坏签名时，本地订单不得标为已取消', async () => {
  setBothChannelEnvs();
  reconcileMock({ closeFailure: true });
  const failed = await postJson('/api/recharge/orders', { packageId: pkgId, channel: 'wechat' });
  q.run(`UPDATE recharge_orders SET pay_expire_at=? WHERE order_no=?`,
    new Date(Date.now() - 10 * 60_000).toISOString(), failed.json.orderNo);
  const stillPending = await getJson(`/api/recharge/orders/${failed.json.orderNo}/status`);
  assert.equal(stillPending.json.status, '待支付');

  reconcileMock({ wxCloseSignKey: aliOfficial.privateKey });
  const forged = await postJson('/api/recharge/orders', { packageId: pkgId, channel: 'wechat' });
  q.run(`UPDATE recharge_orders SET pay_expire_at=? WHERE order_no=?`,
    new Date(Date.now() - 10 * 60_000).toISOString(), forged.json.orderNo);
  const stillPendingAfterBadSign = await getJson(`/api/recharge/orders/${forged.json.orderNo}/status`);
  assert.equal(stillPendingAfterBadSign.json.status, '待支付');
});

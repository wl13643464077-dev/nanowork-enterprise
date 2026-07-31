import crypto from 'node:crypto';
import { providerResponseError, sanitizeProviderError } from './provider-errors.js';

// ===== 支付通道引擎（配置即用，未配置诚实降级）=====
// 设计原则：
// 1. 全部凭 env 配置驱动，不引入新 npm 依赖（签名/验签/解密全用 node:crypto）；
// 2. 私钥只从 env 读取，任何日志/报错不回显密钥内容；
// 3. 验签失败一律拒绝——微信平台证书未配置（WXPAY_PLATFORM_CERT）时安全默认拒绝回调；
// 4. HTTP 层可注入（_setHttpCall），测试环境绝不发真实网络请求。

const HTTP_TIMEOUT_MS = 10_000;
const ORDER_EXPIRE_MINUTES = 30;
const WECHAT_RESPONSE_MAX_SKEW_SECONDS = 300;
const WECHAT_NATIVE_PATH = '/v3/pay/transactions/native';
const WECHAT_API_BASE = 'https://api.mch.weixin.qq.com';
const ALIPAY_DEFAULT_GATEWAY = 'https://openapi.alipay.com/gateway.do';

function payError(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

// ===== 金额换算（分/元）=====
// 数据库订单金额为元（REAL）；微信按“分”计价、支付宝按“元字符串（两位小数）”计价。
export function yuanToFen(yuan) {
  const n = Number(yuan);
  if (!Number.isFinite(n) || n <= 0) throw payError('支付金额必须是大于0的数字', 400);
  const fen = Math.round(n * 100);
  if (Math.abs(n * 100 - fen) > 0.001) throw payError('支付金额最多保留两位小数', 400);
  if (fen > 1_000_000_000) throw payError('单笔支付金额超出上限', 400);
  return fen;
}
export function fenToYuanStr(fen) {
  const n = Number(fen);
  if (!Number.isSafeInteger(n) || n <= 0) throw payError('金额（分）必须是正整数', 400);
  return (n / 100).toFixed(2);
}

// ===== PEM 归一化：env 中支持 \n 转义；裸 base64 自动补头尾 =====
function normalizePem(raw, kind) {
  const text = String(raw || '').replace(/\\n/g, '\n').trim();
  if (!text) return '';
  if (text.includes('-----BEGIN')) return text;
  // 裸 base64：按 64 字符折行并补上头尾（kind: 'PRIVATE KEY' | 'PUBLIC KEY'）
  const body = text.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') || '';
  return `-----BEGIN ${kind}-----\n${body}\n-----END ${kind}-----`;
}

// ===== HTTP 层（可注入，测试用 fake 替换；默认实现 10s 超时）=====
async function realHttpCall({ url, method = 'POST', headers = {}, body }) {
  if (process.env.NODE_ENV === 'test') {
    throw payError('测试环境禁止调用真实支付网关（请注入 mock HTTP 层）', 500);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    return { status: res.status, text: await res.text(), headers: res.headers };
  } catch (e) {
    if (e?.name === 'AbortError') throw payError('支付网关请求超时（10秒），请稍后重试');
    throw payError(sanitizeProviderError(e, { service: '支付网关' }).message);
  } finally {
    clearTimeout(timer);
  }
}
let httpCall = realHttpCall;
export function _setHttpCall(fn) { httpCall = typeof fn === 'function' ? fn : realHttpCall; }

// ===== 通道配置（每次调用即时读取 env，改配置无需改代码）=====
function wechatConfig() {
  const mchid = String(process.env.WXPAY_MCHID || '').trim();
  const serialNo = String(process.env.WXPAY_SERIAL_NO || '').trim();
  const privateKey = normalizePem(process.env.WXPAY_PRIVATE_KEY, 'PRIVATE KEY');
  const apiV3Key = String(process.env.WXPAY_APIV3_KEY || '').trim();
  const appid = String(process.env.WXPAY_APPID || '').trim();
  const notifyUrl = String(process.env.WXPAY_NOTIFY_URL || '').trim();
  if (!mchid || !serialNo || !privateKey || !apiV3Key || !appid || !notifyUrl) return null;
  return { mchid, serialNo, privateKey, apiV3Key, appid, notifyUrl };
}

function alipayConfig() {
  const appId = String(process.env.ALIPAY_APPID || '').trim();
  const privateKey = normalizePem(process.env.ALIPAY_PRIVATE_KEY, 'PRIVATE KEY');
  const publicKey = normalizePem(process.env.ALIPAY_PUBLIC_KEY, 'PUBLIC KEY');
  const notifyUrl = String(process.env.ALIPAY_NOTIFY_URL || '').trim();
  const gateway = String(process.env.ALIPAY_GATEWAY || '').trim() || ALIPAY_DEFAULT_GATEWAY;
  if (!appId || !privateKey || !publicKey || !notifyUrl) return null;
  return { appId, privateKey, publicKey, notifyUrl, gateway };
}

// 已配置的支付通道列表（前端据此展示通道选择；空数组 = 走原有对公转账流程）
export function paymentChannels() {
  const list = [];
  if (wechatConfig()) list.push({ channel: 'wechat', name: '微信支付' });
  if (alipayConfig()) list.push({ channel: 'alipay', name: '支付宝' });
  return list;
}

// ===== 时间格式 =====
function localOffsetString(date) {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  return `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}
function rfc3339Local(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return `${local.toISOString().slice(0, 19)}${localOffsetString(date)}`;
}
function alipayTimestamp(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19).replace('T', ' ');
}

// ===== 微信支付 Native（APIv3）=====
function wechatAuthorization(cfg, method, path, body = '') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex').toUpperCase();
  const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`;
  let signature;
  try {
    signature = crypto.createSign('RSA-SHA256').update(message, 'utf8').sign(cfg.privateKey, 'base64');
  } catch {
    throw payError('微信支付商户私钥无效，请检查 WXPAY_PRIVATE_KEY 配置', 500);
  }
  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${cfg.serialNo}"`;
}

async function wechatCreate(cfg, order) {
  const fen = yuanToFen(order.amountYuan);
  const expireAtDate = new Date(Date.now() + ORDER_EXPIRE_MINUTES * 60_000);
  const bodyObj = {
    appid: cfg.appid,
    mchid: cfg.mchid,
    description: String(order.subject || '积分充值').slice(0, 120),
    out_trade_no: order.orderNo,
    notify_url: cfg.notifyUrl,
    time_expire: rfc3339Local(expireAtDate),
    amount: { total: fen, currency: 'CNY' },
  };
  const body = JSON.stringify(bodyObj);
  const res = await httpCall({
    url: `${WECHAT_API_BASE}${WECHAT_NATIVE_PATH}`,
    method: 'POST',
    headers: {
      Authorization: wechatAuthorization(cfg, 'POST', WECHAT_NATIVE_PATH, body),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'nanowork-industry-pay/1.0',
    },
    body,
  });
  let data = {};
  try { data = JSON.parse(res.text); } catch { /* 保持空对象，走统一报错 */ }
  if (res.status !== 200) {
    throw providerResponseError(res.status || 502, data, { service: '微信支付网关' });
  }
  // Native 下单成功应答同样属于必须验签的支付事实；未验签的 code_url 不得展示给用户。
  verifyWechatResponse(res);
  const qrUrl = String(data.code_url || '').trim();
  if (!qrUrl || qrUrl.length > 2048) {
    throw payError('微信支付下单应答缺少有效二维码，拒绝采用网关结果');
  }
  return { qrUrl, channel: 'wechat', expireAt: expireAtDate.toISOString() };
}

// 解析平台证书 / 平台公钥（支持 X.509 证书 PEM 或纯公钥 PEM）
function parseWechatPlatformPublicKey(raw, configName) {
  const pem = normalizePem(raw, 'PUBLIC KEY');
  try { return new crypto.X509Certificate(pem).publicKey; } catch { /* 不是证书，按公钥再试 */ }
  try { return crypto.createPublicKey(pem); } catch { /* 均失败 */ }
  throw payError(`${configName} 无法解析为证书或公钥，请检查配置`, 500);
}

// 多证书轮换：WXPAY_PLATFORM_CERTS 为 {"平台证书序列号":"证书或公钥PEM"}。
// 配置映射时必须按 Wechatpay-Serial 精确选择，未知序列号安全拒绝；
// 未配置映射时继续兼容原有单证书 WXPAY_PLATFORM_CERT。
function wechatPlatformPublicKey(serial = '') {
  const rawMap = String(process.env.WXPAY_PLATFORM_CERTS || '').trim();
  const normalizedSerial = String(serial || '').trim().toUpperCase();
  if (rawMap) {
    let parsed;
    try { parsed = JSON.parse(rawMap); } catch {
      throw payError('WXPAY_PLATFORM_CERTS 必须是“证书序列号到PEM”的JSON对象', 500);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw payError('WXPAY_PLATFORM_CERTS 必须是“证书序列号到PEM”的JSON对象', 500);
    }
    if (!normalizedSerial) throw payError('微信支付应答缺少平台证书序列号，无法选择验签证书');
    const matched = Object.entries(parsed).find(
      ([key]) => String(key).trim().toUpperCase() === normalizedSerial,
    );
    if (!matched || typeof matched[1] !== 'string' || !matched[1].trim()) {
      throw payError(`微信支付平台证书序列号 ${normalizedSerial} 未配置，拒绝采用网关结果`);
    }
    return parseWechatPlatformPublicKey(
      matched[1],
      `WXPAY_PLATFORM_CERTS[${normalizedSerial}]`,
    );
  }
  const raw = String(process.env.WXPAY_PLATFORM_CERT || '');
  if (!raw.trim()) return null;
  return parseWechatPlatformPublicKey(raw, 'WXPAY_PLATFORM_CERT');
}

function responseHeader(headers, name) {
  if (typeof headers?.get === 'function') return String(headers.get(name) || '').trim();
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return String(value || '').trim();
  }
  return '';
}

function assertWechatTimestampFresh(timestamp, context, status = 502) {
  const value = String(timestamp || '').trim();
  const seconds = Number(value);
  const nowSeconds = Math.floor(Date.now() / 1000);
  // 微信签名时间戳单位为 Unix 秒。拒绝毫秒值、非十进制值及前后超窗响应，
  // 避免攻击者重放一份历史上签名合法的下单/查单/关单应答。
  if (
    !/^\d{10,11}$/.test(value)
    || !Number.isSafeInteger(seconds)
    || Math.abs(nowSeconds - seconds) > WECHAT_RESPONSE_MAX_SKEW_SECONDS
  ) {
    throw payError(`微信${context}时间戳超出5分钟容忍窗口，拒绝（防重放）`, status);
  }
}

// 微信 APIv3 官方要求商户对成功应答验签。签名串为 timestamp\nnonce\nbody\n，
// body 必须使用 HTTP 原始文本（包括 204 关单应答的空字符串），不能 JSON 重序列化。
function verifyWechatResponse(res) {
  const timestamp = responseHeader(res?.headers, 'wechatpay-timestamp');
  const nonce = responseHeader(res?.headers, 'wechatpay-nonce');
  const signature = responseHeader(res?.headers, 'wechatpay-signature');
  const serial = responseHeader(res?.headers, 'wechatpay-serial');
  const signatureType = responseHeader(res?.headers, 'wechatpay-signature-type');
  if (!timestamp || !nonce || !signature || !serial) {
    throw payError('微信支付应答缺少验签头，拒绝采用网关结果');
  }
  if (signatureType && signatureType !== 'WECHATPAY2-SHA256-RSA2048') {
    throw payError('微信支付应答签名算法不支持，拒绝采用网关结果');
  }
  assertWechatTimestampFresh(timestamp, '支付应答');
  const platformKey = wechatPlatformPublicKey(serial);
  if (!platformKey) {
    throw payError('未配置 WXPAY_PLATFORM_CERT，无法验证微信支付应答');
  }
  const body = String(res?.text ?? '');
  let ok = false;
  try {
    ok = crypto.createVerify('RSA-SHA256')
      .update(`${timestamp}\n${nonce}\n${body}\n`, 'utf8')
      .verify(platformKey, signature, 'base64');
  } catch { ok = false; }
  if (!ok) throw payError('微信支付应答验签失败，拒绝采用网关结果');
}

// APIv3 回调报文解密：AES-256-GCM（密文末 16 字节为认证标签）
function decryptWechatResource(apiV3Key, resource) {
  const key = Buffer.from(apiV3Key, 'utf8');
  if (key.length !== 32) throw payError('WXPAY_APIV3_KEY 必须是 32 字节字符串', 500);
  const buf = Buffer.from(String(resource?.ciphertext || ''), 'base64');
  if (buf.length <= 16) throw payError('微信回调密文长度异常', 400);
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(resource.nonce || ''), 'utf8'));
    if (resource.associated_data) decipher.setAAD(Buffer.from(String(resource.associated_data), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw payError('微信回调报文解密失败（APIv3 密钥不匹配或报文被篡改）', 401);
  }
}

// 微信支付回调验签 + 解密。安全默认：未配置平台证书/公钥时拒绝一切回调。
// 返回 { eventType, data }（data 为解密后的交易对象：out_trade_no/trade_state/transaction_id/amount 等）
export function verifyWechatNotify(headers, rawBody) {
  const cfg = wechatConfig();
  if (!cfg) throw payError('微信支付未配置，拒绝回调', 501);
  const h = (name) => String(headers?.[name] ?? headers?.[name.toLowerCase()] ?? '').trim();
  const timestamp = h('wechatpay-timestamp');
  const nonce = h('wechatpay-nonce');
  const signature = h('wechatpay-signature');
  const serial = h('wechatpay-serial');
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  if (!timestamp || !nonce || !signature || !serial || !bodyStr) throw payError('微信回调缺少验签头或报文体', 400);
  assertWechatTimestampFresh(timestamp, '回调', 401);
  const platformKey = wechatPlatformPublicKey(serial);
  if (!platformKey) {
    // 平台证书签名校验做成可配置：未提供时安全默认拒绝，绝不“跳过验签直接入账”。
    throw payError('未配置 WXPAY_PLATFORM_CERT（微信平台证书/平台公钥），出于安全默认拒绝回调；请在商户平台下载后配置', 401);
  }
  let ok = false;
  try {
    ok = crypto.createVerify('RSA-SHA256')
      .update(`${timestamp}\n${nonce}\n${bodyStr}\n`, 'utf8')
      .verify(platformKey, signature, 'base64');
  } catch { ok = false; }
  if (!ok) throw payError('微信回调验签失败，拒绝', 401);
  let payload;
  try { payload = JSON.parse(bodyStr); } catch { throw payError('微信回调报文不是合法 JSON', 400); }
  const data = JSON.parse(decryptWechatResource(cfg.apiV3Key, payload.resource || {}));
  return { eventType: String(payload.event_type || ''), data };
}

// ===== 支付宝当面付（alipay.trade.precreate，RSA2 签名）=====
// 待签名串：除 sign/sign_type 外全部参数按 key 升序 k=v 用 & 连接（值为原始未编码值）
function alipaySignContent(params) {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

// 支付宝同步应答只对 xxx_response 的原始 JSON 值验签（包含首尾花括号）。
// 为避免 JSON.parse 后重排字段/改变斜杠转义，这里从原始 HTTP 文本精确截取该对象。
function alipayTopLevelJsonMembers(rawBody) {
  const raw = String(rawBody ?? '');
  const members = [];
  let objectDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        if (objectDepth === 1 && arrayDepth === 0) {
          let colonAt = i + 1;
          while (/\s/.test(raw[colonAt] || '')) colonAt += 1;
          if (raw[colonAt] === ':') {
            members.push({
              key: JSON.parse(raw.slice(stringStart, i + 1)),
              colonAt,
            });
          }
        }
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i;
    } else if (ch === '{') {
      objectDepth += 1;
    } else if (ch === '}') {
      objectDepth -= 1;
    } else if (ch === '[') {
      arrayDepth += 1;
    } else if (ch === ']') {
      arrayDepth -= 1;
    }
  }
  return members;
}

function extractAlipayResponseContent(rawBody, responseKey) {
  const raw = String(rawBody ?? '');
  const matches = alipayTopLevelJsonMembers(raw)
    .filter(({ key }) => key === responseKey);
  if (matches.length === 0) throw payError('支付宝应答缺少业务响应节点');
  if (matches.length > 1) {
    throw payError('支付宝应答包含重复业务响应节点，拒绝采用网关结果');
  }
  const colonAt = matches[0].colonAt;
  let start = colonAt + 1;
  while (/\s/.test(raw[start] || '')) start += 1;
  if (raw[start] !== '{') throw payError('支付宝业务应答不是合法 JSON 对象');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  throw payError('支付宝业务应答 JSON 未闭合');
}

function verifyAlipayResponse(cfg, rawBody, responseKey) {
  const raw = String(rawBody ?? '');
  let envelope;
  try { envelope = JSON.parse(raw); } catch {
    throw payError('支付宝应答不是合法 JSON');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw payError('支付宝应答格式异常');
  }
  const signMembers = alipayTopLevelJsonMembers(raw)
    .filter(({ key }) => key === 'sign');
  if (signMembers.length > 1) {
    throw payError('支付宝应答包含重复签名节点，拒绝采用网关结果');
  }
  const sign = String(envelope?.sign || '');
  const signedContent = extractAlipayResponseContent(raw, responseKey);
  if (!sign) throw payError('支付宝应答缺少签名，拒绝采用网关结果');
  let ok = false;
  try {
    ok = crypto.createVerify('RSA-SHA256')
      .update(signedContent, 'utf8')
      .verify(cfg.publicKey, sign, 'base64');
  } catch { ok = false; }
  if (!ok) throw payError('支付宝应答验签失败，拒绝采用网关结果');
  // 只消费刚刚通过验签的原始业务节点，绝不再从 JSON.parse(envelope) 读取
  // 可能被重复顶层键覆盖的另一个对象。
  let data;
  try { data = JSON.parse(signedContent); } catch {
    throw payError('支付宝业务应答不是合法 JSON 对象');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw payError('支付宝业务应答格式异常');
  }
  return data;
}

async function alipayCreate(cfg, order) {
  const fen = yuanToFen(order.amountYuan);
  const expireAtDate = new Date(Date.now() + ORDER_EXPIRE_MINUTES * 60_000);
  const bizContent = JSON.stringify({
    out_trade_no: order.orderNo,
    total_amount: fenToYuanStr(fen),
    subject: String(order.subject || '积分充值').slice(0, 128),
    timeout_express: `${ORDER_EXPIRE_MINUTES}m`,
  });
  const params = {
    app_id: cfg.appId,
    method: 'alipay.trade.precreate',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: alipayTimestamp(),
    version: '1.0',
    notify_url: cfg.notifyUrl,
    biz_content: bizContent,
  };
  try {
    params.sign = crypto.createSign('RSA-SHA256').update(alipaySignContent(params), 'utf8').sign(cfg.privateKey, 'base64');
  } catch {
    throw payError('支付宝应用私钥无效，请检查 ALIPAY_PRIVATE_KEY 配置', 500);
  }
  const res = await httpCall({
    url: cfg.gateway,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
  });
  if (res.status !== 200) {
    let data = {};
    try { data = JSON.parse(res.text)?.alipay_trade_precreate_response || {}; } catch { /* 走统一报错 */ }
    throw providerResponseError(res.status || 502, data, { service: '支付宝网关' });
  }
  // 当面付预下单成功应答必须基于原始响应节点验签，不能采用未签名/坏签名二维码。
  const data = verifyAlipayResponse(cfg, res.text, 'alipay_trade_precreate_response');
  const qrUrl = String(data.qr_code || '').trim();
  if (data.code !== '10000') {
    throw providerResponseError(502, data, { service: '支付宝网关' });
  }
  if (String(data.out_trade_no || '') !== String(order.orderNo)) {
    throw payError('支付宝下单应答订单号不匹配，拒绝采用网关结果');
  }
  if (!qrUrl || qrUrl.length > 2048) {
    throw providerResponseError(502, data, { service: '支付宝网关' });
  }
  return { qrUrl, channel: 'alipay', expireAt: expireAtDate.toISOString() };
}

// 支付宝异步通知验签（RSA2 / RSA-SHA256，用支付宝公钥）。返回通过验签的参数对象。
export function verifyAlipayNotify(formParams) {
  const cfg = alipayConfig();
  if (!cfg) throw payError('支付宝支付未配置，拒绝回调', 501);
  const params = formParams && typeof formParams === 'object' ? formParams : {};
  const sign = String(params.sign || '');
  if (!sign) throw payError('支付宝回调缺少签名', 400);
  if (String(params.sign_type || 'RSA2').toUpperCase() !== 'RSA2') throw payError('支付宝回调签名算法不支持', 400);
  let ok = false;
  try {
    ok = crypto.createVerify('RSA-SHA256')
      .update(alipaySignContent(params), 'utf8')
      .verify(cfg.publicKey, sign, 'base64');
  } catch { ok = false; }
  if (!ok) throw payError('支付宝回调验签失败，拒绝', 401);
  if (String(params.app_id || '') !== cfg.appId) throw payError('支付宝回调 app_id 与配置不符，拒绝', 401);
  return params;
}

// ===== 主动对账查询（防掉单）=====
// 返回统一结构 { paid, tradeNo, paidFen, closed }；查询失败抛错（调用方按“回调仍是主路径”静默容错）。
async function wechatQuery(cfg, orderNo) {
  const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(cfg.mchid)}`;
  const res = await httpCall({
    url: `${WECHAT_API_BASE}${path}`,
    method: 'GET',
    headers: { Authorization: wechatAuthorization(cfg, 'GET', path), Accept: 'application/json', 'User-Agent': 'nanowork-industry-pay/1.0' },
  });
  let data = {};
  try { data = JSON.parse(res.text); } catch { /* 走统一报错 */ }
  if (res.status !== 200) throw providerResponseError(res.status || 502, data, { service: '微信支付网关' });
  verifyWechatResponse(res);
  if (String(data.out_trade_no || '') !== orderNo) {
    throw payError('微信支付查询应答订单号不匹配，拒绝采用网关结果');
  }
  if (String(data.mchid || '') !== cfg.mchid || String(data.appid || '') !== cfg.appid) {
    throw payError('微信支付查询应答商户身份不匹配，拒绝采用网关结果');
  }
  if (data?.amount?.currency && String(data.amount.currency) !== 'CNY') {
    throw payError('微信支付查询应答币种不匹配，拒绝采用网关结果');
  }
  const state = String(data.trade_state || '');
  return {
    paid: state === 'SUCCESS',
    closed: state === 'CLOSED' || state === 'REVOKED' || state === 'PAYERROR',
    tradeNo: String(data.transaction_id || ''),
    // 订单入账应核对商户订单总额 total；payer_total 是优惠后的付款人实付，
    // 可能小于 total，不能拿它误判成订单少付。
    paidFen: Number(data?.amount?.total ?? 0),
  };
}

async function alipayQuery(cfg, orderNo) {
  const params = {
    app_id: cfg.appId,
    method: 'alipay.trade.query',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: alipayTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify({ out_trade_no: orderNo }),
  };
  try {
    params.sign = crypto.createSign('RSA-SHA256').update(alipaySignContent(params), 'utf8').sign(cfg.privateKey, 'base64');
  } catch {
    throw payError('支付宝应用私钥无效，请检查 ALIPAY_PRIVATE_KEY 配置', 500);
  }
  const res = await httpCall({
    url: cfg.gateway,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
  });
  if (res.status !== 200) throw providerResponseError(res.status || 502, {}, { service: '支付宝网关' });
  const data = verifyAlipayResponse(cfg, res.text, 'alipay_trade_query_response');
  if (data.code === '40004') return { paid: false, closed: false, tradeNo: '', paidFen: 0 }; // 交易不存在=未支付
  if (data.code !== '10000') throw providerResponseError(502, data, { service: '支付宝网关' });
  if (String(data.out_trade_no || '') !== orderNo) {
    throw payError('支付宝查询应答订单号不匹配，拒绝采用网关结果');
  }
  const status = String(data.trade_status || '');
  return {
    paid: status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED',
    closed: status === 'TRADE_CLOSED',
    tradeNo: String(data.trade_no || ''),
    paidFen: data.total_amount ? yuanToFen(data.total_amount) : 0,
  };
}

async function wechatClose(cfg, orderNo) {
  const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}/close`;
  const body = JSON.stringify({ mchid: cfg.mchid });
  const res = await httpCall({
    url: `${WECHAT_API_BASE}${path}`,
    method: 'POST',
    headers: {
      Authorization: wechatAuthorization(cfg, 'POST', path, body),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'nanowork-industry-pay/1.0',
    },
    body,
  });
  if (res.status !== 204) {
    let data = {};
    try { data = JSON.parse(res.text); } catch { /* 统一安全报错 */ }
    throw providerResponseError(res.status || 502, data, { service: '微信支付网关' });
  }
  verifyWechatResponse(res);
  return { closed: true };
}

async function alipayClose(cfg, orderNo) {
  const params = {
    app_id: cfg.appId,
    method: 'alipay.trade.close',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: alipayTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify({ out_trade_no: orderNo }),
  };
  try {
    params.sign = crypto.createSign('RSA-SHA256').update(alipaySignContent(params), 'utf8').sign(cfg.privateKey, 'base64');
  } catch {
    throw payError('支付宝应用私钥无效，请检查 ALIPAY_PRIVATE_KEY 配置', 500);
  }
  const res = await httpCall({
    url: cfg.gateway,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
  });
  if (res.status !== 200) throw providerResponseError(res.status || 502, {}, { service: '支付宝网关' });
  const data = verifyAlipayResponse(cfg, res.text, 'alipay_trade_close_response');
  if (data.code !== '10000') throw providerResponseError(502, data, { service: '支付宝网关' });
  if (data.out_trade_no && String(data.out_trade_no) !== orderNo) {
    throw payError('支付宝关单应答订单号不匹配，拒绝采用网关结果');
  }
  return { closed: true, tradeNo: String(data.trade_no || '') };
}

export async function queryPayment(channel, orderNo) {
  if (!orderNo) throw payError('缺少订单号', 400);
  if (channel === 'wechat') {
    const cfg = wechatConfig();
    if (!cfg) throw payError('微信支付未配置', 501);
    return wechatQuery(cfg, orderNo);
  }
  if (channel === 'alipay') {
    const cfg = alipayConfig();
    if (!cfg) throw payError('支付宝支付未配置', 501);
    return alipayQuery(cfg, orderNo);
  }
  throw payError('不支持的支付通道', 400);
}

// 线上订单取消必须先调用对应渠道的关单/关闭交易接口。只有验签通过的成功应答
// 才返回 closed=true；调用方据此再做本地状态迁移，防止“本地取消、渠道仍可支付”。
export async function closePayment(channel, orderNo) {
  if (!orderNo) throw payError('缺少订单号', 400);
  if (channel === 'wechat') {
    const cfg = wechatConfig();
    if (!cfg) throw payError('微信支付未配置', 501);
    return wechatClose(cfg, orderNo);
  }
  if (channel === 'alipay') {
    const cfg = alipayConfig();
    if (!cfg) throw payError('支付宝支付未配置', 501);
    return alipayClose(cfg, orderNo);
  }
  throw payError('不支持的支付通道', 400);
}

// ===== 统一下单入口 =====
// order: { orderNo, amountYuan, subject }；返回 { qrUrl, channel, expireAt }
export async function createPayment(channel, order) {
  if (!order?.orderNo) throw payError('缺少订单号', 400);
  if (channel === 'wechat') {
    const cfg = wechatConfig();
    if (!cfg) throw payError('微信支付未配置', 501);
    return wechatCreate(cfg, order);
  }
  if (channel === 'alipay') {
    const cfg = alipayConfig();
    if (!cfg) throw payError('支付宝支付未配置', 501);
    return alipayCreate(cfg, order);
  }
  throw payError('不支持的支付通道', 400);
}

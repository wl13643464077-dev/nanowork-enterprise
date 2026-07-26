import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { setTenantConfig, curTenant, q } from '../db.js';

// 飞书配置纯租户私有：无"平台默认"概念（每家企业自己的应用机器人/凭据/令牌），故只读本租户键、不回退全局。
// 否则历史遗留的全局 feishu/feishu_ics_token 会串到未配置的企业，且 ICS 令牌反查不到租户。
function tcfg(key, dflt, tid = curTenant()) {
  const r = q.get('SELECT value FROM sys_config WHERE key = ?', `${key}:${tid}`);
  if (!r) return dflt;
  try { return JSON.parse(r.value); } catch { return r.value; }
}

const RECEIVE_ID_TYPES = new Set(['open_id', 'user_id', 'union_id', 'email']);
const CALENDAR_USER_ID_TYPES = new Set(['open_id', 'user_id', 'union_id']);
const MANAGER_ROLES = new Set(['boss', 'ops_director', 'admin']);
const CALENDAR_IDENTITY_VERSION = 1;
const oauthSessions = new Map();

function tenantDisplayName(tid = curTenant()) {
  const name = String(q.get('SELECT name FROM tenants WHERE id=?', Number(tid))?.name || '').replace(/\s+/g, ' ').trim();
  return name.slice(0, 80) || `企业${Number(tid) || ''}`;
}

function confirmedLocation(value) {
  return String(value || '').trim() || '待确认';
}

function calendarIdentity(tid = curTenant()) {
  const tenantName = tenantDisplayName(tid);
  return {
    tenantName,
    summary: `${tenantName} · Nano Work 经营活动`,
    description: `Nano Work 为「${tenantName}」同步的经营活动日历`,
  };
}

function notificationTitle(value) {
  return String(value || '通知')
    .replace(/纳米\s*Work(?:行业版)?/giu, 'Nano Work')
    .replace(/^Nano Work\s*[·｜|—-]\s*/iu, '')
    .trim() || '通知';
}

function notificationLine(value) {
  return String(value || '').replace(/地点：\s*[-—](?=\s*(?:｜|$))/gu, '地点：待确认');
}

function normalizeReceiveIdType(v) {
  const t = String(v || 'open_id').trim();
  return RECEIVE_ID_TYPES.has(t) ? t : 'open_id';
}

function cleanupOAuthSessions() {
  const now = Date.now();
  for (const [state, s] of oauthSessions) {
    if ((s.exp || 0) < now - 60_000) oauthSessions.delete(state);
  }
}

function isManagerRole(role) {
  return MANAGER_ROLES.has(String(role || ''));
}

function roleLabel(role) {
  return ({ boss: '老板', ops_director: '运营总监', admin: '管理员' })[role] || role || '管理者';
}

function maskId(v = '') {
  const s = String(v || '');
  return s ? `${s.slice(0, 8)}****` : '';
}

function dedupeRecipients(list = []) {
  const seen = new Set();
  return list.filter(r => {
    const receiveId = String(r.receiveId || r.calendarUserId || '').trim();
    if (!receiveId) return false;
    const receiveIdType = normalizeReceiveIdType(r.receiveIdType || r.calendarUserIdType || 'open_id');
    const key = `${receiveIdType}:${receiveId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function activeBoundUser(recipient, tid, { managerOnly = false } = {}) {
  const userId = Number(recipient?.userId);
  if (!Number.isInteger(userId) || userId <= 0) return !managerOnly;
  const user = q.get('SELECT role,status FROM users WHERE tenant_id=? AND id=?', tid, userId);
  if (!user || user.status !== '启用') return false;
  return !managerOnly || isManagerRole(user.role);
}

function upsertManagerReceiver(cfg, user = {}, receiver = {}) {
  if (!isManagerRole(user.role)) return cfg;
  const receiveIdType = normalizeReceiveIdType(receiver.receiveIdType || 'open_id');
  const receiveId = String(receiver.receiveId || '').trim();
  if (!receiveId) return cfg;
  const managerReceivers = Array.isArray(cfg.managerReceivers) ? cfg.managerReceivers : [];
  const nextItem = {
    userId: user.id || null,
    userName: user.name || receiver.receiverName || '',
    role: user.role || '',
    roleLabel: roleLabel(user.role),
    receiveId,
    receiveIdType,
    receiverName: receiver.receiverName || user.name || '',
    calendarUserId: CALENDAR_USER_ID_TYPES.has(receiveIdType) ? receiveId : '',
    calendarUserIdType: CALENDAR_USER_ID_TYPES.has(receiveIdType) ? receiveIdType : 'open_id',
    boundAt: new Date().toISOString(),
  };
  const next = managerReceivers.filter(x => {
    if (nextItem.userId && Number(x.userId) === Number(nextItem.userId)) return false;
    return `${x.receiveIdType}:${x.receiveId}` !== `${nextItem.receiveIdType}:${nextItem.receiveId}`;
  });
  next.push(nextItem);
  return { ...cfg, managerReceivers: next };
}

function upsertUserReceiver(cfg, user = {}, receiver = {}) {
  const userId = Number(user.id);
  const receiveIdType = normalizeReceiveIdType(receiver.receiveIdType || 'open_id');
  const receiveId = String(receiver.receiveId || '').trim();
  if (!Number.isInteger(userId) || userId <= 0 || !receiveId) return cfg;
  const current = Array.isArray(cfg.userReceivers) ? cfg.userReceivers : [];
  const nextItem = {
    userId,
    userName: user.name || receiver.receiverName || '',
    role: user.role || '',
    receiveId,
    receiveIdType,
    receiverName: receiver.receiverName || user.name || '',
    boundAt: new Date().toISOString(),
  };
  const next = current.filter(x => Number(x.userId) !== userId
    && `${x.receiveIdType}:${x.receiveId}` !== `${receiveIdType}:${receiveId}`);
  next.push(nextItem);
  return { ...cfg, userReceivers: next };
}

export function feishuUserRecipient(userId, tid = curTenant()) {
  const cfg = tcfg('feishu', {}, tid) || {};
  const candidates = dedupeRecipients([
    ...(Array.isArray(cfg.userReceivers) ? cfg.userReceivers : []),
    ...(Array.isArray(cfg.managerReceivers) ? cfg.managerReceivers : []),
  ]);
  return candidates.find(r => Number(r.userId) === Number(userId) && activeBoundUser(r, tid)) || null;
}

export function feishuUserSummary(userId, tid = curTenant()) {
  const recipient = feishuUserRecipient(userId, tid);
  return recipient ? {
    bound: true,
    userId: Number(recipient.userId),
    userName: recipient.userName || recipient.receiverName || '',
    receiverName: recipient.receiverName || recipient.userName || '',
    receiveIdType: recipient.receiveIdType || 'open_id',
    receiveId: maskId(recipient.receiveId),
    boundAt: recipient.boundAt || '',
  } : { bound: false, userId: Number(userId) || null };
}

export function feishuManagerRecipients(tid = curTenant()) {
  const cfg = tcfg('feishu', {}, tid) || {};
  const c = feishuConfig(tid);
  const primary = c.receiveId ? [{
    userId: null,
    userName: c.receiverName || '主接收人',
    role: 'primary',
    roleLabel: '主接收人',
    receiveId: c.receiveId,
    receiveIdType: c.receiveIdType,
    receiverName: c.receiverName || '主接收人',
    calendarUserId: c.calendarUserId,
    calendarUserIdType: c.calendarUserIdType,
    primary: true,
  }] : [];
  const managers = (Array.isArray(cfg.managerReceivers) ? cfg.managerReceivers : [])
    .filter(recipient => activeBoundUser(recipient, tid, { managerOnly: true }));
  return dedupeRecipients([...managers, ...primary]);
}

export function feishuManagerSummary(tid = curTenant()) {
  const recipients = feishuManagerRecipients(tid);
  return {
    count: recipients.length,
    calendarCount: recipients.filter(r => r.calendarUserId && CALENDAR_USER_ID_TYPES.has(r.calendarUserIdType || r.receiveIdType)).length,
    recipients: recipients.map(r => ({
      userId: r.userId || null,
      userName: r.userName || r.receiverName || '',
      role: r.role || '',
      roleLabel: r.roleLabel || roleLabel(r.role),
      receiverName: r.receiverName || r.userName || '',
      receiveIdType: r.receiveIdType || 'open_id',
      receiveId: maskId(r.receiveId),
      calendarReady: !!(r.calendarUserId && CALENDAR_USER_ID_TYPES.has(r.calendarUserIdType || r.receiveIdType)),
      boundAt: r.boundAt || '',
      primary: !!r.primary,
    })),
  };
}

// 飞书集成 V3（应用机器人单人绑定）—— 租户级：每家企业绑定自己的自建应用机器人与单个接收人，互不影响
// 仅支持企业自建应用机器人：App ID/Secret + receive_id_type + receive_id。
// 不再依赖群列表、群机器人 Webhook、chat_id 或"机器人入群"流程。
// 注意：异步推送（setImmediate/定时）脱离请求上下文，curTenant() 会丢失，调用方必须在派发前捕获 tid 显式传入。
export function feishuConfig(tid = curTenant()) {
  const cfg = tcfg('feishu', {}, tid) || {};
  const receiveIdType = normalizeReceiveIdType(cfg.receiveIdType || cfg.receiverIdType || cfg.userIdType);
  const receiveId = cfg.receiveId || cfg.openId || cfg.userId || cfg.unionId || cfg.email || '';
  const hasBoundRecipient = [...(Array.isArray(cfg.userReceivers) ? cfg.userReceivers : []),
    ...(Array.isArray(cfg.managerReceivers) ? cfg.managerReceivers : [])]
    .some(item => String(item?.receiveId || '').trim() && activeBoundUser(item, tid));
  return {
    enabled: !!(cfg.enabled && (receiveId || hasBoundRecipient)),
    mode: 'app',
    appId: cfg.appId || process.env.FEISHU_APP_ID || '',
    appSecret: cfg.appSecret || process.env.FEISHU_APP_SECRET || '',
    receiveId,
    receiveIdType,
    receiverName: cfg.receiverName || cfg.receiveName || '',
    calendarUserId: cfg.calendarUserId || (CALENDAR_USER_ID_TYPES.has(receiveIdType) ? receiveId : ''),
    calendarUserIdType: cfg.calendarUserIdType || (CALENDAR_USER_ID_TYPES.has(receiveIdType) ? receiveIdType : 'open_id'),
    calendarId: cfg.calendarId || '',
  };
}
export const appReady = (tid = curTenant()) => { const c = feishuConfig(tid); return !!(c.appId && c.appSecret); };
export const appBotReady = (tid = curTenant()) => { const c = feishuConfig(tid); return !!(c.enabled && c.appId && c.appSecret); };

// token 缓存按租户隔离（不同企业 App 凭据不同，token 不可共享）
const tokenCache = new Map();
async function tenantToken(tid = curTenant()) {
  const c = feishuConfig(tid);
  if (!c.appId || !c.appSecret) throw new Error('未配置飞书企业应用凭据（App ID/Secret）');
  const cached = tokenCache.get(tid);
  if (cached && Date.now() < cached.exp) return cached.token;
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }),
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(`飞书鉴权失败：${d.msg}`);
  tokenCache.set(tid, { token: d.tenant_access_token, exp: Date.now() + (d.expire - 300) * 1000 });
  return d.tenant_access_token;
}

// 兼容旧前端/旧接口：V3 不再读取群列表。
export async function listBotChats(tid = curTenant()) {
  return [];
}

// 兼容旧前端/旧接口：只返回打开应用机器人的链接，不做群绑定。
export async function bindQr(tid = curTenant()) {
  const c = feishuConfig(tid);
  if (!c.appId) return { ready: false };
  const applink = `https://applink.feishu.cn/client/bot/open?appId=${c.appId}`;
  return { ready: true, applink, appBotOnly: true };
}

export async function createOAuthBinding({ tid = curTenant(), user = {}, baseUrl = '' } = {}) {
  cleanupOAuthSessions();
  const c = feishuConfig(tid);
  if (!c.appId || !c.appSecret) throw new Error('后台未配置飞书企业应用 App ID / App Secret');
  const origin = String(baseUrl || '').replace(/\/+$/, '');
  const configuredRedirectUri = String(process.env.FEISHU_REDIRECT_URI || '').trim();
  if (!origin && !configuredRedirectUri) throw new Error('无法生成飞书授权回调地址');
  const redirectUri = configuredRedirectUri || `${origin}/api/public/feishu/oauth/callback`;
  const state = crypto.randomBytes(24).toString('base64url');
  const authorizeUrl = `https://open.feishu.cn/open-apis/authen/v1/index?app_id=${encodeURIComponent(c.appId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
  const qrDataUrl = await QRCode.toDataURL(authorizeUrl, { margin: 1, width: 260 });
  const exp = Date.now() + 5 * 60 * 1000;
  oauthSessions.set(state, {
    status: 'pending',
    tid,
    userId: user.id || null,
    userName: user.name || '',
    userRole: user.role || '',
    redirectUri,
    exp,
    createdAt: Date.now(),
  });
  return {
    state,
    authorizeUrl,
    qrDataUrl,
    appId: c.appId,
    redirectUri,
    expiresAt: new Date(exp).toISOString(),
    redirectUriConfigured: !!configuredRedirectUri,
    localMode: /^https?:\/\/(localhost|127\.0\.0\.1|::1)(:|\/|$)/i.test(redirectUri),
  };
}

export function oauthBindingStatus(state, tid = curTenant(), userId = null) {
  cleanupOAuthSessions();
  const s = oauthSessions.get(String(state || ''));
  if (!s || s.tid !== tid || (userId != null && Number(s.userId) !== Number(userId))) return { status: 'missing' };
  if (s.exp < Date.now() && s.status === 'pending') return { status: 'expired' };
  return {
    status: s.status,
    receiverName: s.receiverName || '',
    receiveIdType: s.receiveIdType || 'open_id',
    error: s.error || '',
  };
}

async function exchangeUserAccessToken(code, redirectUri, tid = curTenant()) {
  const c = feishuConfig(tid);
  const res = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: c.appId,
      client_secret: c.appSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(d.msg || d.error_description || d.error || '获取飞书用户授权失败');
  const token = d.data?.access_token || d.access_token || d.data?.user_access_token || d.user_access_token;
  if (!token) throw new Error('飞书未返回用户访问凭证');
  return token;
}

async function fetchOAuthUserInfo(userAccessToken) {
  const res = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
    headers: { Authorization: `Bearer ${userAccessToken}` },
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(d.msg || '获取飞书用户信息失败');
  return d.data || {};
}

export async function handleFeishuOAuthCallback({ code, state } = {}) {
  cleanupOAuthSessions();
  const s = oauthSessions.get(String(state || ''));
  if (!s) throw new Error('授权二维码已失效，请回到系统重新扫码');
  if (s.exp < Date.now()) {
    s.status = 'expired';
    throw new Error('授权二维码已过期，请重新生成');
  }
  if (!code) throw new Error('飞书未返回授权码');
  try {
    const userAccessToken = await exchangeUserAccessToken(String(code), s.redirectUri, s.tid);
    const info = await fetchOAuthUserInfo(userAccessToken);
    const openId = info.open_id || info.openId;
    if (!openId) throw new Error('飞书未返回 open_id，请确认应用已开通网页应用免登/用户信息权限');
    const cur = tcfg('feishu', {}, s.tid) || {};
    const receiverName = info.name || info.en_name || info.email || info.mobile || '飞书用户';
    const actor = s.userId ? q.get('SELECT id,name,role,status FROM users WHERE tenant_id = ? AND id = ?', s.tid, s.userId) : null;
    if (!actor || actor.status !== '启用') throw new Error('发起绑定的账号已停用或不存在，请重新登录后扫码');
    const bindingActor = actor;
    // OAuth here is always a personal binding. Tenant-wide recipients are
    // configured only through the manager-only enterprise settings endpoint.
    const base = {
      ...cur,
      enabled: isManagerRole(bindingActor.role) ? true : !!cur.enabled,
      mode: 'app',
      webhook: '',
      chatId: '',
      chatName: '',
      oauthBoundAt: new Date().toISOString(),
    };
    let next = upsertUserReceiver(base, bindingActor, {
      receiveId: openId,
      receiveIdType: 'open_id',
      receiverName,
    });
    next = upsertManagerReceiver(next, bindingActor, {
      receiveId: openId,
      receiveIdType: 'open_id',
      receiverName,
    });
    setTenantConfig('feishu', next, s.tid);
    s.status = 'bound';
    s.receiverName = receiverName;
    s.receiveIdType = 'open_id';
    s.boundAt = Date.now();
    await sendAppMessage(openId, 'open_id', buildCard({
      title: '绑定成功',
      lines: ['✅ 飞书应用机器人已绑定', '后续活动创建、状态变更和经营提醒都会单独推送给你'],
    }, s.tid), s.tid).catch(() => {});
    return { ok: true, receiverName, receiveIdType: 'open_id' };
  } catch (e) {
    s.status = 'error';
    s.error = e.message;
    throw e;
  }
}

async function sendAppMessage(receiveId, receiveIdType, cardObj, tid = curTenant()) {
  const token = await tenantToken(tid);
  const type = normalizeReceiveIdType(receiveIdType);
  const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(type)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ receive_id: receiveId, msg_type: 'interactive', content: JSON.stringify(cardObj) }),
  });
  const d = await res.json();
  return { ok: d.code === 0, resp: d };
}

function buildCard({ title, lines = [], url }, tid = curTenant()) {
  const tenantName = tenantDisplayName(tid);
  return {
    header: { title: { tag: 'plain_text', content: `Nano Work · ${tenantName}｜${notificationTitle(title)}` }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.map(notificationLine).join('\n') } },
      ...(url ? [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '打开 Nano Work' }, type: 'primary', url }] }] : []),
    ],
  };
}

export async function pushFeishu(msg, tid = curTenant()) {
  const c = feishuConfig(tid);
  if (!c.enabled) return { skipped: true };
  if (!c.appId || !c.appSecret) return { skipped: true, reason: '未配置飞书企业应用凭据' };
  if (!c.receiveId) return { skipped: true, reason: '未配置飞书应用机器人接收人' };
  const card = buildCard(msg, tid);
  try { return await sendAppMessage(c.receiveId, c.receiveIdType, card, tid); } catch (e) { return { ok: false, error: e.message }; }
}

export async function pushFeishuToManagers(msg, tid = curTenant()) {
  const c = feishuConfig(tid);
  if (!c.enabled) return { skipped: true, reason: '飞书应用机器人未启用' };
  if (!c.appId || !c.appSecret) return { skipped: true, reason: '未配置飞书企业应用凭据' };
  const recipients = feishuManagerRecipients(tid);
  if (!recipients.length) return { skipped: true, reason: '暂无已绑定的老板/管理层飞书接收人' };
  const card = buildCard(msg, tid);
  const results = [];
  for (const r of recipients) {
    try {
      const out = await sendAppMessage(r.receiveId, r.receiveIdType, card, tid);
      results.push({ ok: out.ok, receiverName: r.receiverName || r.userName, receiveIdType: r.receiveIdType, resp: out.resp });
    } catch (e) {
      results.push({ ok: false, receiverName: r.receiverName || r.userName, receiveIdType: r.receiveIdType, error: e.message });
    }
  }
  return { ok: results.some(x => x.ok), sent: results.filter(x => x.ok).length, total: recipients.length, results };
}

export async function pushFeishuToUser(msg, userId, tid = curTenant()) {
  const c = feishuConfig(tid);
  if (!c.appId || !c.appSecret) return { skipped: true, reason: '未配置飞书企业应用凭据' };
  const recipient = feishuUserRecipient(userId, tid);
  if (!recipient) return { skipped: true, reason: '该员工尚未绑定飞书' };
  try {
    const out = await sendAppMessage(recipient.receiveId, recipient.receiveIdType, buildCard(msg, tid), tid);
    return { ...out, receiverName: recipient.receiverName || recipient.userName || '' };
  } catch (e) {
    return { ok: false, error: e.message, receiverName: recipient.receiverName || recipient.userName || '' };
  }
}

// 应用机器人单人绑定：保存接收人，后续全部通知走应用机器人私发/单人接收。
export async function bindAppBotTarget(input = {}, tid = curTenant(), actor = {}) {
  const cur = tcfg('feishu', {}, tid) || {};
  const effective = feishuConfig(tid);
  const rawReceiveId = input.receiveId !== undefined && !String(input.receiveId).includes('****') ? input.receiveId : cur.receiveId;
  const receiveId = String(rawReceiveId ?? '').trim();
  const receiveIdType = normalizeReceiveIdType(input.receiveIdType ?? cur.receiveIdType);
  if (!receiveId) throw new Error('请填写飞书应用机器人接收人 ID');
  const base = {
    ...cur,
    enabled: true,
    mode: 'app',
    webhook: '',
    chatId: '',
    chatName: '',
    receiveId,
    receiveIdType,
    receiverName: String(input.receiverName ?? cur.receiverName ?? '').trim(),
    appId: input.appId !== undefined && !String(input.appId).includes('****') ? String(input.appId).trim() : (cur.appId || ''),
    appSecret: input.appSecret !== undefined && input.appSecret !== '' ? String(input.appSecret).trim() : (cur.appSecret || ''),
  };
  let next = upsertUserReceiver(base, actor, {
    receiveId,
    receiveIdType,
    receiverName: base.receiverName,
  });
  next = upsertManagerReceiver(next, actor, {
    receiveId,
    receiveIdType,
    receiverName: base.receiverName,
  });
  if (!(next.appId || effective.appId) || !(next.appSecret || effective.appSecret)) throw new Error('请先配置飞书企业应用 App ID / App Secret');
  setTenantConfig('feishu', next, tid);
  await sendAppMessage(receiveId, receiveIdType, buildCard({
    title: '绑定成功',
    lines: ['✅ 飞书应用机器人已绑定', '活动创建/状态变更、重要经营事件将通过应用机器人推送到这里'],
  }, tid), tid).catch(() => {});
  return { receiveId, receiveIdType, receiverName: next.receiverName };
}

export async function bindLatestChat() {
  throw new Error('已切换为飞书应用机器人单人绑定，不再支持群绑定');
}

// ===== 飞书日历同步（活动中心 ↔ 飞书日历，FR-ACT-07）=====
// 双通道：A·ICS 标准日历（零凭据：下载导入 / 公网部署后订阅地址自动同步）
//         B·企业应用模式直写飞书日历（calendar v4，凭据就绪后活动创建自动建日程）

// ICS 订阅令牌（公开路由鉴权用，按租户各一份，首次访问自动生成并持久化）
export function icsToken(tid = curTenant()) {
  let t = tcfg('feishu_ics_token', '', tid);
  if (!t) {
    t = crypto.randomBytes(32).toString('base64url');
    setTenantConfig('feishu_ics_token', t, tid);
  }
  return t;
}
// 反查：公开 ICS 路由无登录态，凭 key 找出它属于哪个租户（仅返回本租户活动，杜绝跨企业泄露）
export function tenantByIcsToken(key) {
  if (!key) return null;
  const row = q.get("SELECT key FROM sys_config WHERE key LIKE 'feishu_ics_token:%' AND value = ?", JSON.stringify(key));
  if (!row) return null;
  const tid = Number(row.key.split(':')[1]);
  return Number.isInteger(tid) ? tid : null;
}

const ICS_TYPE_TIME = { '沙龙会': ['T140000', 'T170000'], '品鉴会': ['T140000', 'T170000'], '招商说明会': ['T093000', 'T120000'], '回厂游': ['T080000', 'T180000'], '会员日': ['T100000', 'T200000'] };
export function buildIcs(activities = [], explicitTid = null) {
  const inferredTid = Number(explicitTid || activities.find(activity => Number(activity?.tenant_id))?.tenant_id || curTenant()) || 1;
  const identity = calendarIdentity(inferredTid);
  const esc = (s = '') => String(s).replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
  const productTenant = identity.tenantName.replace(/[\/\r\n]+/g, '-');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//Nano Work//${productTenant} Activities//CN`,
    `X-WR-CALNAME:${esc(identity.summary)}`, 'X-WR-TIMEZONE:Asia/Shanghai', 'METHOD:PUBLISH'];
  for (const [index, a] of activities.entries()) {
    if (!a.date) continue;
    const d = a.date.replace(/-/g, '');
    const [st, et] = ICS_TYPE_TIME[a.type] || ['T140000', 'T170000'];
    const stableId = String(a.id || `${d}-${index + 1}`).replace(/[^a-zA-Z0-9_.-]/g, '-');
    lines.push('BEGIN:VEVENT',
      `UID:nanowork-act-${inferredTid}-${stableId}@nano-work`,
      `DTSTART;TZID=Asia/Shanghai:${d}${st}`,
      `DTEND;TZID=Asia/Shanghai:${d}${et}`,
      `SUMMARY:${esc(`${a.title}（${a.type || '活动'}·${a.status || ''}）`)}`,
      `LOCATION:${esc(confirmedLocation(a.location))}`,
      `DESCRIPTION:${esc(`企业：${identity.tenantName}｜目标${a.target_join || '-'}人｜状态：${a.status || '-'}｜负责人：${a.owner || '-'}｜来自 Nano Work`)}`,
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// 企业应用模式：复用既有 calendarId；新建或原位更新显示名称时都不会更换日历 ID。
async function ensureCalendar(tid = curTenant()) {
  const cur = tcfg('feishu', {}, tid) || {};
  const identity = calendarIdentity(tid);
  if (cur.calendarId) {
    if (Number(cur.calendarIdentityVersion || 0) < CALENDAR_IDENTITY_VERSION) {
      try {
        const token = await tenantToken(tid);
        const response = await fetch(`https://open.feishu.cn/open-apis/calendar/v4/calendars/${cur.calendarId}`, {
          method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary: identity.summary, description: identity.description }),
        });
        const updated = await response.json();
        if (updated.code === 0) setTenantConfig('feishu', { ...cur, calendarIdentityVersion: CALENDAR_IDENTITY_VERSION }, tid);
      } catch {
        // 标题更新失败不能切断既有日历：继续复用原 calendarId，同步活动仍可正常进行。
      }
    }
    return cur.calendarId;
  }
  const token = await tenantToken(tid);
  const res = await fetch('https://open.feishu.cn/open-apis/calendar/v4/calendars', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: identity.summary, description: identity.description, permissions: 'show_only_free_busy' }),
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(`创建飞书日历失败：${d.msg}`);
  const id = d.data?.calendar?.calendar_id;
  setTenantConfig('feishu', { ...cur, calendarId: id, calendarIdentityVersion: CALENDAR_IDENTITY_VERSION }, tid);
  return id;
}

async function ensureEventAttendees(calendarId, eventId, tid = curTenant()) {
  const recipients = feishuManagerRecipients(tid)
    .filter(r => r.calendarUserId && CALENDAR_USER_ID_TYPES.has(r.calendarUserIdType || r.receiveIdType));
  if (!recipients.length) return { skipped: true, reason: '暂无可加入日历的老板/管理层飞书用户ID' };
  const token = await tenantToken(tid);
  const groups = new Map();
  for (const r of recipients) {
    const type = r.calendarUserIdType || r.receiveIdType || 'open_id';
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(r);
  }
  const results = [];
  for (const [userIdType, list] of groups) {
    const res = await fetch(`https://open.feishu.cn/open-apis/calendar/v4/calendars/${calendarId}/events/${eventId}/attendees?user_id_type=${encodeURIComponent(userIdType)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attendees: list.map(r => ({ type: 'user', is_optional: false, user_id: r.calendarUserId || r.receiveId })),
        need_notification: true,
      }),
    });
    const d = await res.json();
    results.push({ ok: d.code === 0, userIdType, count: list.length, resp: d });
  }
  return { ok: results.some(x => x.ok), total: recipients.length, results };
}

// 活动 → 飞书日程（创建/更新都走新建+覆盖式：以活动id做幂等键存映射）
export async function syncActivityToFeishuCalendar(act, tid = curTenant()) {
  const cfg = feishuConfig(tid);
  if (!cfg.enabled) return { skipped: true, reason: '飞书应用机器人未启用' };
  if (!appReady(tid)) return { skipped: true, reason: '未配置企业应用凭据' };
  if (!act?.id || !act?.date) return { skipped: true, reason: '活动缺少ID或日期' };
  const calId = await ensureCalendar(tid);
  const token = await tenantToken(tid);
  const [st, et] = ICS_TYPE_TIME[act.type] || ['T140000', 'T170000'];
  const toTs = (date, t) => String(Math.floor(new Date(`${date}T${t.slice(1, 3)}:${t.slice(3, 5)}:00+08:00`).getTime() / 1000));
  const eventMap = tcfg('feishu_event_map', {}, tid) || {};
  const identity = calendarIdentity(tid);
  const location = confirmedLocation(act.location);
  const body = {
    summary: `${act.title}（${act.type || '活动'}）`,
    description: `企业：${identity.tenantName}｜状态：${act.status || '-'}｜目标${act.target_join || '-'}人｜地点：${location}｜来自 Nano Work`,
    need_notification: true,
    visibility: 'public',
    free_busy_status: 'busy',
    attendee_ability: 'can_see_others',
    location: { name: location },
    reminders: [{ minutes: 1440 }, { minutes: 120 }],
    start_time: { timestamp: toTs(act.date, st), timezone: 'Asia/Shanghai' },
    end_time: { timestamp: toTs(act.date, et), timezone: 'Asia/Shanghai' },
  };
  let d; let eventId = eventMap[act.id];
  if (eventMap[act.id]) { // 已有日程 → PATCH 更新
    const res = await fetch(`https://open.feishu.cn/open-apis/calendar/v4/calendars/${calId}/events/${eventMap[act.id]}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    d = await res.json();
  } else {
    const res = await fetch(`https://open.feishu.cn/open-apis/calendar/v4/calendars/${calId}/events`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    d = await res.json();
    if (d.code === 0 && d.data?.event?.event_id) {
      eventId = d.data.event.event_id;
      eventMap[act.id] = eventId;
      setTenantConfig('feishu_event_map', eventMap, tid);
    }
  }
  const attendee = d.code === 0 && eventId ? await ensureEventAttendees(calId, eventId, tid).catch(e => ({ ok: false, error: e.message })) : null;
  return { ok: d.code === 0, resp: d.msg, attendee };
}

function activityLines(act = {}, actor, actionLabel = '活动同步', tid = curTenant()) {
  const owner = actor?.name || act.owner || '-';
  const identity = calendarIdentity(tid);
  return [
    `**${act.title || '未命名活动'}**`,
    `企业：${identity.tenantName}`,
    `动作：${actionLabel} ｜ 状态：${act.status || '-'}`,
    `类型：${act.type || '活动'} ｜ 日期：${act.date || '-'} ｜ 地点：${confirmedLocation(act.location)}`,
    `目标：${act.target_join || '-'}人 / ${act.target_deal || 0}单 ｜ 报名：${act.signed_up || 0} ｜ 到场：${act.arrived || 0} ｜ 成交：${act.converted || 0}`,
    `操作人：${owner}`,
    `已自动同步到飞书「${identity.summary}」日历，并设置 24小时前 / 2小时前提醒。`,
  ];
}

export async function syncActivityLifecycleToFeishu(act, { tid = curTenant(), actor = null, action = 'updated', url = '' } = {}) {
  const actionLabel = ({ created: '新活动创建', updated: '活动信息更新', status: `活动状态更新：${act?.status || ''}`, result: '活动战果更新', approved: '活动策划审批通过，已同步日历' })[action] || '活动信息更新';
  const calendar = await syncActivityToFeishuCalendar(act, tid).catch(e => ({ ok: false, error: e.message }));
  const message = await pushFeishuToManagers({
    title: actionLabel,
    lines: activityLines(act, actor, actionLabel, tid),
    url,
  }, tid).catch(e => ({ ok: false, error: e.message }));
  return { calendar, message };
}

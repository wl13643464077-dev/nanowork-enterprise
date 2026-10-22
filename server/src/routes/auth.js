import { Router } from 'express';
import { db, q, modulesFor, getTenant } from '../db.js';
import {
  verifyPassword, hashPassword, signToken, verifyToken, authMiddleware, logOp, notify, SESSION_COOKIE,
  tokenFromRequest, createSession, touchSession, revokeSession, revokeUserSessions, listSessions,
} from '../util.js';
import { planSummary, primaryUserIdFor, seatSummary } from '../engines/plan.js';
import { listTenantStores } from '../engines/store-scope.js';
import { budgetSummary } from '../engines/credits.js';
import { previewInvitation, registerWithInvitation } from '../engines/invitations.js';
import { testerAccount, testerPublicProfile } from '../engines/tester-access.js';

const r = Router();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const positiveInt = (value, fallback) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const LOGIN_MAX_FAILURES = positiveInt(process.env.LOGIN_ACCOUNT_MAX_FAILURES, 8);
const LOGIN_IP_MAX_FAILURES = positiveInt(process.env.LOGIN_IP_MAX_FAILURES, 40);
const REGISTER_IP_MAX_ATTEMPTS = positiveInt(process.env.REGISTER_IP_MAX_ATTEMPTS, 5);
const INVITATION_REGISTER_IP_MAX_ATTEMPTS = positiveInt(process.env.INVITATION_REGISTER_IP_MAX_ATTEMPTS, 60);
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const MAX_FAILURE_KEYS = 5000;
const loginFailures = new Map();
const ipLoginFailures = new Map();
const registerAttempts = new Map();
const invitationRegisterAttempts = new Map();
const invitationPreviewAttempts = new Map();
const passwordChangeFailures = new Map();
const PASSWORD_CHANGE_MAX_FAILURES = positiveInt(process.env.PASSWORD_CHANGE_MAX_FAILURES, 5);
const INVITATION_PREVIEW_WINDOW_MS = 10 * 60 * 1000;
const INVITATION_PREVIEW_MAX_ATTEMPTS = positiveInt(process.env.INVITATION_PREVIEW_IP_MAX_ATTEMPTS, 30);
const DUMMY_PASSWORD_HASH = hashPassword('not-a-real-account-password');

function pruneFailureMap(map, now) {
  for (const [key, value] of map) if (value.resetAt <= now) map.delete(key);
  while (map.size >= MAX_FAILURE_KEYS) map.delete(map.keys().next().value);
}

function recordFailure(map, key, now, windowMs = LOGIN_WINDOW_MS) {
  pruneFailureMap(map, now);
  const current = map.get(key);
  map.set(key, current?.resetAt > now
    ? { count: current.count + 1, resetAt: current.resetAt }
    : { count: 1, resetAt: now + windowMs });
}

function blockedBy(state, limit, now) {
  return state?.resetAt > now && state.count >= limit;
}

function rateLimited(res, state, now, message = '登录失败次数过多，请稍后再试') {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil((state.resetAt - now) / 1000))));
  return res.status(429).json({ error: message });
}

function sessionCookie(token, req, maxAge = 8 * 3600, name = SESSION_COOKIE) {
  const secure = Boolean(req.secure);
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Priority=High; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function signUserSession(user, jti) {
  return signToken({
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    tenant_id: user.tenant_id || 1,
    auth_version: Number(user.auth_version) || 0,
    ...(jti ? { jti } : {}),
  });
}

// Express 4 不捕获 async handler 的 rejection，包一层送错误中间件
const asyncRoute = fn => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };

r.post('/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  const now = Date.now();
  const clientIp = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const ipState = ipLoginFailures.get(clientIp);
  if (blockedBy(ipState, LOGIN_IP_MAX_FAILURES, now)) return rateLimited(res, ipState, now);

  const normalizedUsername = typeof username === 'string' ? username.trim() : '';
  if (!normalizedUsername || normalizedUsername.length > 100 || typeof password !== 'string' || password.length > 512) {
    recordFailure(ipLoginFailures, clientIp, now);
    return res.status(400).json({ error: '登录信息格式不正确' });
  }

  const failureKey = `${clientIp}:${normalizedUsername.toLowerCase()}`;
  const prior = loginFailures.get(failureKey);
  if (blockedBy(prior, LOGIN_MAX_FAILURES, now)) return rateLimited(res, prior, now);

  const user = q.get('SELECT * FROM users WHERE username = ?', normalizedUsername);
  const passwordValid = await verifyPassword(password || '', user?.password_hash || DUMMY_PASSWORD_HASH);
  const ok = user && user.status === '启用' && passwordValid;
  q.run('INSERT INTO login_logs(tenant_id,username,success,ip,ua) VALUES(?,?,?,?,?)',
    Number(user?.tenant_id || 0), normalizedUsername, ok ? 1 : 0, clientIp, req.headers['user-agent'] || '');
  if (!ok) {
    recordFailure(loginFailures, failureKey, now);
    recordFailure(ipLoginFailures, clientIp, now);
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  loginFailures.delete(failureKey);
  const tester = testerAccount(user.id);
  if (tester && tester.status !== 'approved') return res.status(403).json({ error: '测试员申请尚未通过或账号已暂停', code: 'TESTER_INACTIVE' });
  const tenant = getTenant(user.tenant_id || 1) || { id: 1, status: '已开通', name: '总部', plan: '旗舰版', credits: 0 };
  if (tenant.status === '已停用' && user.role !== 'platform_super')
    return res.status(403).json({ error: '企业账号已停用，请联系平台客服' });
  q.run(`UPDATE users SET last_login_at = datetime('now','localtime') WHERE id = ?`, user.id);
  // BE-H4：登录即落服务端会话（jti 写入令牌），支持之后按单个会话吊销
  const jti = createSession({
    userId: user.id, tenantId: user.tenant_id || 1,
    ip: clientIp, ua: req.headers['user-agent'] || '',
  });
  const token = signUserSession(user, jti);
  res.setHeader('Set-Cookie', sessionCookie(token, req));
  res.json({
    token,
    user: {
      id: user.id, username: user.username, name: user.name, role: user.role, dept: user.dept,
      credits: tenant.credits ?? 0, modules: modulesFor(user),
      ...(tester ? { accountType: 'tester', tester: testerPublicProfile(tester) } : {}),
      tenant: {
        id: tenant.id, name: tenant.name, status: tenant.status, plan: tenant.plan,
        dataMode: tenant.data_mode ?? 'live',
        onboardingStatus: tenant.onboarding_status ?? 'pending',
      },
    },
  });
}));

r.post('/session', authMiddleware, (req, res) => {
  // 刷新令牌时优先续期原会话（同一 jti，吊销一次即全部失效）；存量无 jti 的旧令牌换发时补建会话
  const jti = req.user.jti && touchSession(req.user.jti)
    ? req.user.jti
    : createSession({
      userId: req.user.id, tenantId: req.user.tenant_id || 1,
      ip: String(req.ip || ''), ua: req.headers['user-agent'] || '',
    });
  const token = signUserSession(req.user, jti);
  res.setHeader('Set-Cookie', sessionCookie(token, req));
  res.json({ ok: true });
});

// 单点登出：只吊销当前这个会话，其他设备登录不受影响
r.post('/logout', (req, res) => {
  const payload = verifyToken(tokenFromRequest(req));
  if (payload?.jti) revokeSession(payload.jti, payload.id);
  res.setHeader('Set-Cookie', sessionCookie('', req, 0));
  res.json({ ok: true });
});

// 当前账号的活跃会话列表（供"登录设备管理"界面）
r.get('/sessions', authMiddleware, (req, res) => {
  res.json(listSessions(req.user.id).map(s => ({ ...s, current: s.jti === req.user.jti })));
});

// 任何已登录账号修改本人密码：校验当前密码，递增认证版本并吊销全部会话，
// 之后所有设备（包括当前）都必须用新密码重新登录。管理员重置不走这里。
r.post('/password', authMiddleware, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const now = Date.now();
  const failureKey = `user:${req.user.id}`;
  const prior = passwordChangeFailures.get(failureKey);
  if (blockedBy(prior, PASSWORD_CHANGE_MAX_FAILURES, now)) return rateLimited(res, prior, now, '当前密码错误次数过多，请稍后再试');
  const { currentPassword, password } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof password !== 'string') return res.status(400).json({ error: '请填写当前密码和新密码' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: '新密码须为8到128位' });
  if (password === currentPassword) return res.status(400).json({ error: '新密码不能与当前密码相同' });
  const stored = q.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!stored || !(await verifyPassword(currentPassword, stored.password_hash))) {
    recordFailure(passwordChangeFailures, failureKey, now);
    return res.status(403).json({ error: '当前密码不正确' });
  }
  passwordChangeFailures.delete(failureKey);
  q.run('UPDATE users SET password_hash=?, auth_version=COALESCE(auth_version,0)+1 WHERE id=?', hashPassword(password), req.user.id);
  const revoked = revokeUserSessions(req.user.id);
  logOp(req.user, '账号安全', '修改密码', `本人自助修改，吊销${revoked}个会话`);
  res.setHeader('Set-Cookie', sessionCookie('', req, 0));
  res.json({ ok: true, revokedSessions: revoked, message: '密码已修改，请使用新密码重新登录' });
}));

// 按 jti 吊销任一属于自己的会话（踢掉某台设备）；吊销后该会话旧令牌立即 401
r.delete('/sessions/:jti', authMiddleware, (req, res) => {
  const jti = String(req.params.jti || '');
  if (!revokeSession(jti, req.user.id)) return res.status(404).json({ error: '会话不存在或已退出' });
  logOp(req.user, '账号安全', '吊销会话', jti.slice(0, 8));
  res.json({ ok: true, current: jti === req.user.jti });
});

// 企业注册（FR-SAAS-01）：创建租户（待审核）+ 该企业管理员账号
r.post('/invitations/preview', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const now = Date.now();
  const clientIp = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const attempt = invitationPreviewAttempts.get(clientIp);
  if (blockedBy(attempt, INVITATION_PREVIEW_MAX_ATTEMPTS, now)) return rateLimited(res, attempt, now, '邀请码查询过于频繁，请稍后再试');
  recordFailure(invitationPreviewAttempts, clientIp, now, INVITATION_PREVIEW_WINDOW_MS);
  try { res.json(previewInvitation(req.body?.code)); }
  catch (error) {
    res.status(error.status || 500).json({ valid: false, code: error.code || 'INVITATION_ERROR',
      error: error.status ? error.message : '邀请码查询失败，请稍后重试' });
  }
});

r.post('/register', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { company, contactName, phone, username, password } = req.body || {};
  const hasInviteCode = Object.hasOwn(req.body || {}, 'inviteCode');
  const now = Date.now();
  const clientIp = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const attempts = hasInviteCode ? invitationRegisterAttempts : registerAttempts;
  const limit = hasInviteCode ? INVITATION_REGISTER_IP_MAX_ATTEMPTS : REGISTER_IP_MAX_ATTEMPTS;
  const attempt = attempts.get(clientIp);
  if (blockedBy(attempt, limit, now)) return rateLimited(res, attempt, now,
    hasInviteCode ? '邀请码注册过于频繁，请稍后再试' : '注册申请过于频繁，请稍后再试');
  // Every request carrying inviteCode uses the same IP bucket, even if the
  // code or account fields are invalid. Changing codes cannot reset the limit.
  if (hasInviteCode) recordFailure(invitationRegisterAttempts, clientIp, now, REGISTER_WINDOW_MS);
  const companyName = typeof company === 'string' ? company.trim() : '';
  const account = typeof username === 'string' ? username.trim() : '';
  const contact = typeof contactName === 'string' ? contactName.trim() : '';
  if ((!hasInviteCode && !companyName) || !account || typeof password !== 'string') return res.status(400).json({ error: '企业名称、登录账号、密码必填' });
  if (companyName.length > 120 || contact.length > 40) return res.status(400).json({ error: '企业名称或联系人过长' });
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{3,39}$/.test(account)) return res.status(400).json({ error: '登录账号须为4到40位字母、数字、点、横线或下划线' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: '密码须为8到128位' });
  if (phone && !/^1\d{10}$/.test(String(phone))) return res.status(400).json({ error: '手机号格式不正确' });
  if (!hasInviteCode) recordFailure(registerAttempts, clientIp, now, REGISTER_WINDOW_MS);

  if (hasInviteCode) {
    try {
      return res.json(registerWithInvitation({ inviteCode: req.body.inviteCode, company: companyName,
        contactName: contact, phone: phone ? String(phone) : null, username: account, password }));
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.status ? error.message : '注册失败，请检查账号信息后重试',
        code: error.code || 'REGISTRATION_FAILED' });
    }
  }

  let tenantId;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (q.get('SELECT id FROM users WHERE username = ?', account)) throw Object.assign(new Error('该登录账号已被注册'), { status: 400 });
    // 1) 建租户（待审核、积分池0、模块待分配）
    const t = q.run(`INSERT INTO tenants(name,contact_name,phone,status,plan,credits) VALUES(?,?,?,'待审核','标准版',0)`,
      companyName, contact || account, phone || null);
    tenantId = t.lastInsertRowid;
    // 2) 建企业管理员账号（企业内老板角色）
    const primaryUser = q.run(`INSERT INTO users(username,password_hash,name,role,dept,phone,status,tenant_id) VALUES(?,?,?,?,?,?, '启用', ?)`,
      account, hashPassword(password), contact || companyName, 'boss', '管理层', phone || null, tenantId);
    q.run('UPDATE tenants SET primary_user_id=? WHERE id=?', primaryUser.lastInsertRowid, tenantId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    return res.status(error.status || 400).json({ error: error.status ? error.message : '注册失败，请检查账号信息后重试' });
  }
  // 3) 通知平台超管审核
  for (const su of q.all(`SELECT id FROM users WHERE role = 'platform_super'`))
    notify(su.id, '新企业注册', `${companyName} 申请开通`, `联系人 ${contact || '-'}｜${phone || '-'}｜账号 ${account}，待审核开通`);
  logOp({ id: null, name: account }, '注册', '企业注册', companyName);
  res.json({ ok: true, tenantId, registrationType: 'application', canLogin: false, message: '注册成功！平台审核开通后即可登录使用，我们会尽快处理。' });
});

r.get('/me', authMiddleware, (req, res) => {
  const u = q.get('SELECT id,username,name,role,dept,phone,tenant_id,store_id,last_login_at FROM users WHERE id = ?', req.user.id);
  const tester = testerAccount(req.user.id);
  const tenant = getTenant(u?.tenant_id || 1);
  res.json({
    ...u, credits: tenant?.credits ?? 0, modules: modulesFor(u),
    accountType: tester ? 'tester' : u?.role === 'platform_super' ? 'platform' : primaryUserIdFor(tenant?.id) === u?.id ? 'primary' : 'sub',
    ...(tester ? { tester: testerPublicProfile(tester), billingMode: 'personal', canManageUsers: false } : {}),
    // 多门店：storeId=NULL 表示总部/全店；tenant.stores 供顶栏门店切换器（>1 家才显示）
    storeId: u?.store_id == null ? null : Number(u.store_id),
    tenant: tenant ? {
      id: tenant.id, name: tenant.name, status: tenant.status, plan: tenant.plan,
      dataMode: tenant.data_mode ?? 'live',
      onboardingStatus: tenant.onboarding_status ?? 'pending',
      stores: listTenantStores(tenant.id, 200),
      // 年度套餐摘要（plan 仍是旧文本标签，只追加字段）：{code,name,seatLimit,seatsUsed,startedAt,expiresAt,status,daysLeft}
      planSummary: planSummary(tenant),
      seatSummary: seatSummary(tenant.id, u?.id),
      // 月度 AI 预算摘要（顶栏预警 Tag 用）：{month,budget,alertRatio,used,remaining,forecast,ratioUsed,state}
      budgetSummary: budgetSummary(tenant),
    } : null,
  });
});

export default r;

import './env.js';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { q, db } from './db.js';
import { jwtSecretStrengthError } from './security-config.js';

export const SESSION_COOKIE = 'nanowork_session';
const configuredSecret = String(process.env.JWT_SECRET || '');
if (process.env.NODE_ENV === 'production') {
  const problem = jwtSecretStrengthError(configuredSecret);
  if (problem) throw new Error(`[FATAL] 生产环境 JWT_SECRET ${problem}，请更新 server/.env 后重启。`);
}
if (process.env.NODE_ENV !== 'production' && !process.env.JWT_SECRET) {
  console.warn('[security] 未设置 JWT_SECRET：本次开发进程使用随机会话密钥，重启后现有登录会失效。');
}
const SECRET = configuredSecret || crypto.randomBytes(32).toString('hex');

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
// BE-H3：scryptSync 会同步阻塞事件循环（每次约几十毫秒），登录高峰或被恶意打点时全服卡顿。
// 改为异步 crypto.scrypt（libuv 线程池执行），调用点必须 await。
const scryptAsync = promisify(crypto.scrypt);
export async function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  try {
    const storedHash = Buffer.from(hash, 'hex');
    if (storedHash.length !== 32) return false;
    const check = await scryptAsync(pw, salt, 32);
    return crypto.timingSafeEqual(storedHash, check);
  } catch {
    return false;
  }
}

export function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function safeJsonArray(value) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function signToken(payload, expiresInSec = 8 * 3600) {
  const body = { ...payload, exp: Date.now() + expiresInSec * 1000 };
  const data = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}
export function verifyToken(token) {
  if (!token) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expect = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  const actualSig = Buffer.from(sig);
  const expectedSig = Buffer.from(expect);
  if (actualSig.length !== expectedSig.length || !crypto.timingSafeEqual(actualSig, expectedSig)) return null;
  try {
    const body = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (body.exp < Date.now()) return null;
    return body;
  } catch { return null; }
}

// ===== 服务端会话表（BE-H4）=====
// 自研 HMAC 令牌无状态、固定 8h，过去只能靠 auth_version+1 全量踢下线。
// 现在登录时落一行 auth_sessions（主键 jti，写入令牌 payload），认证时校验该会话未吊销未过期，
// 即可按单个会话精确吊销（单点登出、踢掉某台设备）。旧格式无 jti 的令牌仍可用（兼容存量，最长 8h 自然过期）。
let sessionStoreReady = false;
function ensureSessionStore() {
  if (sessionStoreReady) return;
  db.exec(`CREATE TABLE IF NOT EXISTS auth_sessions (
    jti TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    ip TEXT DEFAULT '',
    ua TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    expires_at INTEGER NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, expires_at);
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);`);
  sessionStoreReady = true;
}

export function createSession({ userId, tenantId = 1, ip = '', ua = '', ttlSec = 8 * 3600 }) {
  ensureSessionStore();
  // 顺手清理过期超过一天的旧会话，避免表无限膨胀（量小，索引命中，开销可忽略）
  q.run('DELETE FROM auth_sessions WHERE expires_at < ?', Date.now() - 24 * 3600 * 1000);
  const jti = crypto.randomUUID();
  q.run('INSERT INTO auth_sessions(jti,user_id,tenant_id,ip,ua,expires_at) VALUES(?,?,?,?,?,?)',
    jti, userId, Number(tenantId) || 1, String(ip).slice(0, 100), String(ua).slice(0, 300), Date.now() + ttlSec * 1000);
  return jti;
}
export function sessionActive(jti) {
  if (!jti) return false;
  ensureSessionStore();
  return Boolean(q.get('SELECT 1 ok FROM auth_sessions WHERE jti=? AND revoked_at IS NULL AND expires_at > ?', String(jti), Date.now()));
}
export function touchSession(jti, ttlSec = 8 * 3600) {
  ensureSessionStore();
  return q.run('UPDATE auth_sessions SET expires_at=? WHERE jti=? AND revoked_at IS NULL AND expires_at > ?',
    Date.now() + ttlSec * 1000, String(jti), Date.now()).changes > 0;
}
// 吊销单个会话；传 userId 时仅允许吊销该用户自己的会话（防他人按 jti 乱踢）
export function revokeSession(jti, userId = null) {
  ensureSessionStore();
  const scoped = userId !== null && userId !== undefined;
  return q.run(`UPDATE auth_sessions SET revoked_at=datetime('now','localtime')
    WHERE jti=? AND revoked_at IS NULL${scoped ? ' AND user_id=?' : ''}`,
  ...(scoped ? [String(jti), userId] : [String(jti)])).changes > 0;
}
export function revokeUserSessions(userId) {
  ensureSessionStore();
  return q.run('UPDATE auth_sessions SET revoked_at=datetime(\'now\',\'localtime\') WHERE user_id=? AND revoked_at IS NULL', userId).changes;
}
export function listSessions(userId) {
  ensureSessionStore();
  return q.all(`SELECT jti, ip, ua, created_at, expires_at FROM auth_sessions
    WHERE user_id=? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`, userId, Date.now());
}

export function tokenFromRequest(req) {
  const headerToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const cookies = new Map(String(req.headers.cookie || '').split(';').map(part => {
    const [name, ...value] = part.trim().split('=');
    return [name, value.join('=')];
  }).filter(([name]) => name));
  const cookieToken = cookies.get(SESSION_COOKIE) || '';
  return headerToken || cookieToken;
}

export function authMiddleware(req, res, next) {
  const token = tokenFromRequest(req);
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: '未登录或登录已过期' });
  // BE-H4：带 jti 的令牌必须对应仍有效的服务端会话；登出或被吊销后旧令牌立即失效
  if (payload.jti && !sessionActive(payload.jti)) {
    return res.status(401).json({ error: '会话已退出或被吊销，请重新登录' });
  }
  const current = q.get(`SELECT id,username,name,role,dept,phone,avatar,status,tenant_id,manager_id,modules,auth_version
    FROM users WHERE id=?`, payload.id);
  if (!current || current.status !== '启用') {
    return res.status(401).json({ error: '账号已停用或不存在，请重新登录' });
  }
  if (Number(payload.auth_version || 0) !== Number(current.auth_version || 0)) {
    return res.status(401).json({ error: '登录状态已失效，请重新登录' });
  }
  // 权限和租户以数据库实时状态为准，避免旧令牌在停用、调岗或角色变更后继续越权。
  req.user = { ...payload, ...current, tenant_id: Number(current.tenant_id) || 1 };
  next();
}

export function csrfOriginGuard({ allowedOrigins = new Set(), production = process.env.NODE_ENV === 'production' } = {}) {
  const trustedOrigins = allowedOrigins instanceof Set ? allowedOrigins : new Set(allowedOrigins);
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const origin = String(req.get?.('Origin') || '').trim();
    const fetchSite = String(req.get?.('Sec-Fetch-Site') || '').trim().toLowerCase();
    if (!origin) {
      if (fetchSite === 'cross-site') return res.status(403).json({ error: '请求来源不可信' });
      return next();
    }
    let parsed;
    try { parsed = new URL(origin); } catch { return res.status(403).json({ error: '请求来源不可信' }); }
    // Express resolves the protocol through the configured trusted proxy chain.
    const protocol = req.protocol || (req.secure ? 'https' : 'http');
    const host = String(req.get?.('host') || '').trim();
    const sameOrigin = Boolean(host) && parsed.origin === `${protocol}://${host}`;
    const localDevelopment = !production && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(parsed.origin);
    if (sameOrigin || localDevelopment || trustedOrigins.has(parsed.origin)) return next();
    return res.status(403).json({ error: '请求来源不可信' });
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: '无权限执行此操作' });
    next();
  };
}

// 手机号脱敏：销售角色看不到全号
export function maskPhone(phone, role) {
  if (!phone) return phone;
  if (role === 'boss' || role === 'ops_director' || role === 'admin') return phone;
  return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
}

export function logOp(user, module, action, target) {
  try {
    q.run('INSERT INTO op_logs(user_id,username,module,action,target,ip) VALUES(?,?,?,?,?,?)',
      user?.id ?? null, user?.name ?? 'system', module, action, target ?? '', user?.ip ?? '127.0.0.1');
  } catch { /* logging must never break business flow */ }
}

export function notify(userId, type, title, body, link = null) {
  const safeLink = typeof link === 'string'
    && link.length <= 1000
    && /^\/(?!\/)[^\\\r\n]*$/u.test(link)
    ? link
    : null;
  q.run('INSERT INTO notifications(user_id,type,title,body,link) VALUES(?,?,?,?,?)',
    userId, type, title, body ?? '', safeLink);
}

export const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD 本地时区
export function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toLocaleDateString('sv-SE');
}
export function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const t = new Date(d.valueOf());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const firstThu = new Date(t.getFullYear(), 0, 4);
  const week = 1 + Math.round(((t - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return `${t.getFullYear()}-W${String(week).padStart(2, '0')}`;
}
export const monthStart = () => today().slice(0, 7) + '-01';
export const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

// 列表分页参数：防 NaN（LIMIT NaN 在 SQLite 里会退化成全表返回）、防超大 size 拉爆内存、防负 page
export function pageParams(query = {}, defSize = 10, maxSize = 100) {
  const size = Math.min(Math.max(1, parseInt(query.size, 10) || defSize), maxSize);
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { size, page, offset: (page - 1) * size };
}

import crypto from 'node:crypto';
import { db, q } from '../db.js';

export const TESTER_PROVIDERS = Object.freeze([
  { id: 'openlux', label: 'OpenLux', baseUrl: 'https://api.openlux.ai/v1', model: 'deepseek-v4-flash' },
  { id: '360', label: '360智脑', baseUrl: 'https://api.360.cn/v1', model: 'deepseek/deepseek-v4-flash' },
]);
export function testerProvider(value) {
  const provider = TESTER_PROVIDERS.find(item => item.id === value);
  if (!provider) throw testerError('请选择 OpenLux 或 360 智脑', 400, 'TESTER_PROVIDER_INVALID');
  return provider;
}

let ready = false;
export function ensureTesterSchema() {
  if (ready) return;
  db.exec(`CREATE TABLE IF NOT EXISTS tester_accounts (
    user_id INTEGER PRIMARY KEY, phone TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','paused')),
    api_key_cipher TEXT, key_updated_at TEXT, consent_at TEXT NOT NULL,
    reviewed_by INTEGER, reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS tester_invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL, token_cipher TEXT NOT NULL,
    title TEXT NOT NULL, sales_phone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_tester_invitations_owner ON tester_invitations(owner_user_id);
  CREATE TABLE IF NOT EXISTS tester_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, invitation_id INTEGER NOT NULL,
    phone TEXT UNIQUE NOT NULL, name TEXT NOT NULL, store_name TEXT NOT NULL DEFAULT '',
    access_hash TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','approved','rejected','paused')),
    used_turns INTEGER NOT NULL DEFAULT 0 CHECK(used_turns BETWEEN 0 AND 2),
    consent_at TEXT NOT NULL, consent_version TEXT NOT NULL,
    reviewed_by INTEGER, reviewed_at TEXT, last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_tester_leads_owner ON tester_leads(owner_user_id);
  CREATE TABLE IF NOT EXISTS tester_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, lead_id INTEGER,
    request_id TEXT NOT NULL, employee_id TEXT NOT NULL, input TEXT NOT NULL,
    output TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'running'
      CHECK(status IN ('running','succeeded','failed')),
    model TEXT, usage_json TEXT NOT NULL DEFAULT '{}', supplier_costs_json TEXT NOT NULL DEFAULT '[]',
    supplier_cost_cny REAL, cost_status TEXT NOT NULL DEFAULT 'unverified', error_code TEXT,
    attempts INTEGER NOT NULL DEFAULT 1, lease_expires INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), completed_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tester_conversation_request
    ON tester_conversations(owner_user_id,COALESCE(lead_id,0),request_id);
  CREATE INDEX IF NOT EXISTS idx_tester_conversations_lead ON tester_conversations(lead_id,status);
  CREATE TABLE IF NOT EXISTS tester_call_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL,
    attempt_number INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'running'
      CHECK(status IN ('running','succeeded','failed')),
    model TEXT, usage_json TEXT NOT NULL DEFAULT '{}', supplier_costs_json TEXT NOT NULL DEFAULT '[]',
    supplier_cost_cny REAL, cost_status TEXT NOT NULL DEFAULT 'unverified', error_code TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), completed_at TEXT,
    UNIQUE(conversation_id,attempt_number)
  );
  CREATE TABLE IF NOT EXISTS tester_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id INTEGER, target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL, action TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS tester_interests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, lead_id INTEGER NOT NULL,
    employee_id TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(lead_id,employee_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tester_interests_owner_date ON tester_interests(owner_user_id,created_at);
  CREATE INDEX IF NOT EXISTS idx_tester_leads_owner_date ON tester_leads(owner_user_id,created_at);
  CREATE INDEX IF NOT EXISTS idx_tester_conversations_owner_date ON tester_conversations(owner_user_id,created_at);
  CREATE INDEX IF NOT EXISTS idx_tester_attempts_date ON tester_call_attempts(created_at);`);
  // Old rows always belong to 360. New applications explicitly choose OpenLux.
  for (const [table, column] of [['tester_accounts', 'active_provider'], ['tester_invitations', 'provider'],
    ['tester_conversations', 'provider'], ['tester_call_attempts', 'provider']]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT '360'
        CHECK(${column} IN ('360','openlux'))`);
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS tester_provider_keys (
    owner_user_id INTEGER NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('360','openlux')),
    api_key_cipher TEXT NOT NULL, key_updated_at TEXT,
    PRIMARY KEY(owner_user_id,provider)
  );
  SAVEPOINT tester_provider_key_migration;
  INSERT OR IGNORE INTO tester_provider_keys(owner_user_id,provider,api_key_cipher,key_updated_at)
    SELECT user_id,'360',api_key_cipher,key_updated_at FROM tester_accounts WHERE api_key_cipher IS NOT NULL;
  UPDATE tester_accounts SET api_key_cipher=NULL WHERE api_key_cipher IS NOT NULL;
  RELEASE tester_provider_key_migration;`);
  ready = true;
}

export const testerError = (message, status = 400, code = 'TESTER_ERROR') =>
  Object.assign(new Error(message), { status, code });
export const tokenHash = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function encryptionKey() {
  const secret = process.env.TESTER_KEY_ENCRYPTION_SECRET || process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw testerError('平台尚未完成个人 Key 加密配置，请联系管理员', 503, 'KEY_ENCRYPTION_NOT_READY');
  return crypto.createHash('sha256').update(`nanowork-tester-v1:${secret}`).digest();
}
export function encryptTesterSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}
export function decryptTesterSecret(value) {
  try {
    const [iv, tag, encrypted] = String(value).split('.').map(part => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw testerError('个人 Key 配置无法读取，请重新填写 Key', 409, 'PERSONAL_KEY_UNREADABLE');
  }
}

export function testerAccount(userId) {
  ensureTesterSchema();
  return q.get(`SELECT t.*,u.username,u.name,u.status user_status,u.tenant_id,u.role
    FROM tester_accounts t JOIN users u ON u.id=t.user_id WHERE t.user_id=?`, Number(userId)) || null;
}

export function requireActiveTester(userId) {
  const account = testerAccount(userId);
  if (!account || account.status !== 'approved' || account.user_status !== '启用')
    throw testerError('测试员账号未开通或已暂停，请联系平台管理员', 403, 'TESTER_INACTIVE');
  return account;
}

export function testerPublicProfile(account) {
  if (!account) return null;
  const providers = TESTER_PROVIDERS.map(({ id, label }) => {
    const stored = testerProviderKey(account.user_id, id);
    let maskedKey = '';
    if (stored?.api_key_cipher) {
      try { const key = decryptTesterSecret(stored.api_key_cipher); maskedKey = `${key.slice(0, 5)}••••••${key.slice(-4)}`; }
      catch { maskedKey = '配置需更新'; }
    }
    return { id, label, configured: Boolean(stored?.api_key_cipher), maskedKey, keyUpdatedAt: stored?.key_updated_at || null };
  });
  const activeProvider = account.active_provider || '360';
  const active = providers.find(item => item.id === activeProvider);
  return { id: account.user_id, userId: account.user_id, username: account.username,
    name: account.name, phone: account.phone, status: account.status, accountType: 'tester',
    activeProvider, providers, keyConfigured: active.configured, keyMasked: active.maskedKey, keyUpdatedAt: active.keyUpdatedAt,
    createdAt: account.created_at, reviewedAt: account.reviewed_at };
}

export function testerProviderKey(userId, provider) {
  ensureTesterSchema(); testerProvider(provider);
  return q.get('SELECT api_key_cipher,key_updated_at FROM tester_provider_keys WHERE owner_user_id=? AND provider=?', Number(userId), provider) || null;
}

// The check lives in the shared authentication path: a tester cannot bypass
// its portal by directly requesting enterprise, seat, payment or upload APIs.
export function testerRequestAllowed(account, req) {
  if (!account) return true;
  const pathname = String(req.originalUrl || req.url || '').split('?')[0];
  return /^\/api\/tester(?:\/|$)/.test(pathname)
    || /^\/api\/auth\/(?:me|session|logout|sessions(?:\/[^/]+)?)$/.test(pathname);
}

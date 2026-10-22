import crypto from 'node:crypto';
import { db, q, activeTenantId } from '../db.js';

export const TESTER_BUSINESS_MODULES = Object.freeze([
  'dashboard', 'advisor', 'marshals', 'growth', 'activities', 'content',
  'execution', 'analysis', 'assets',
]);

// This is deliberately a DB identity, not a claim supplied by a browser or a
// transient request context. Persistent jobs can recover the same personal
// owner from their existing tenant/user metadata without storing credentials.
export function testerExecutionIdentity({ userId, tenantId, provider, requireActive = true } = {}) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tester_accounts'").get()) return null;
  const user = userId == null ? null : db.prepare('SELECT id,tenant_id FROM users WHERE id=?').get(Number(userId));
  const target = tenantId ?? user?.tenant_id ?? activeTenantId();
  if (target == null) return null;
  const tid = Number(target);
  const accounts = db.prepare(`SELECT a.*,u.status user_status,
    u.tenant_id,t.status tenant_status FROM tester_accounts a JOIN users u ON u.id=a.user_id
    JOIN tenants t ON t.id=u.tenant_id WHERE u.tenant_id=?`).all(tid);
  if (!accounts.length) {
    if (user && Number(user.tenant_id) !== tid && db.prepare('SELECT 1 FROM tester_accounts WHERE user_id=?').get(user.id))
      throw testerError('个人调用账号与任务空间不一致', 403, 'TESTER_OWNER_MISMATCH');
    return null;
  }
  const account = accounts[0];
  if (accounts.length !== 1 || (userId != null && (!user || Number(user.id) !== Number(account.user_id) || Number(user.tenant_id) !== tid)))
    throw testerError('个人调用账号与任务空间不一致', 403, 'TESTER_OWNER_MISMATCH');
  if (requireActive && (account.status !== 'approved' || account.user_status !== '启用' || account.tenant_status !== '已开通'))
    throw testerError('测试员账号未开通或已暂停，请联系平台管理员', 403, 'TESTER_INACTIVE');
  const selected = testerProvider(provider ?? account.active_provider ?? '360');
  return Object.freeze({ ownerUserId: Number(account.user_id), tenantId: tid, provider: selected.id,
    baseUrl: selected.baseUrl, billingMode: 'personal', testerManaged: true });
}

export function testerExecutionCredentials(options = {}) {
  const identity = testerExecutionIdentity(options);
  if (!identity) return null;
  const stored = testerProviderKey(identity.ownerUserId, identity.provider);
  if (!stored?.api_key_cipher) throw testerError('请先在测试员中心填写所选供应商的个人 API Key', 409, 'PERSONAL_KEY_REQUIRED');
  return { ...identity, apiKey: decryptTesterSecret(stored.api_key_cipher) };
}

export function isTesterBusinessActor(user) {
  if (!Number.isSafeInteger(Number(user?.id)) || Number(user.id) < 1) return false;
  try { return Boolean(testerExecutionIdentity({ userId: user.id, tenantId: user.tenant_id })); }
  catch (error) {
    if (['TESTER_INACTIVE', 'TESTER_OWNER_MISMATCH'].includes(error?.code)) return false;
    throw error;
  }
}

export function assertTesterProviderSupported(capability) {
  if (testerExecutionIdentity()) throw testerError(`个人 API Key 暂不支持${capability}，请使用数字员工中的 360 图文或带货视频能力`, 409, 'PERSONAL_PROVIDER_UNSUPPORTED');
}

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
function ensureTrialQuotaSchema() {
  // SQLite cannot remove the old fixed-two CHECK with ALTER COLUMN. Rebuild
  // only that table, preserving rows, custom columns, indexes, and sequence.
  const legacyCheck = /CHECK\s*\(\s*used_turns\s+BETWEEN\s+0\s+AND\s+2\s*\)/i;
  const missingQuotaTables = ['tester_invitations', 'tester_leads'].filter(table =>
    !db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'turn_limit'));
  if (!missingQuotaTables.length && !legacyCheck.test(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tester_leads'").get().sql)) return;
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  let savepoint = false;
  try {
    // DROP of the parent must not cascade to historical conversations/interests.
    // This PRAGMA must run before the migration's transaction starts.
    if (foreignKeys) db.exec('PRAGMA foreign_keys=OFF');
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys) throw new Error('Tester quota migration requires an outer transaction boundary');
    const existingViolations = new Set(db.prepare('PRAGMA foreign_key_check').all().map(row => JSON.stringify(row)));
    db.exec('SAVEPOINT tester_trial_quota_migration'); savepoint = true;
    for (const table of missingQuotaTables) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN turn_limit INTEGER NOT NULL DEFAULT 2
        CHECK(typeof(turn_limit)='integer' AND turn_limit BETWEEN 1 AND 100)`);
    }
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tester_leads'").get().sql;
    if (legacyCheck.test(schema)) {
      const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='tester_leads' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
      const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='tester_leads'").get()?.seq || 0;
      const columns = db.prepare('PRAGMA table_info(tester_leads)').all().map(column => `"${column.name.replaceAll('"', '""')}"`).join(',');
      db.exec(schema.replace(/^(CREATE TABLE(?: IF NOT EXISTS)?\s+)(?:"tester_leads"|tester_leads)/i, '$1tester_leads_quota_upgrade')
        .replace(legacyCheck, "CHECK(typeof(used_turns)='integer' AND used_turns BETWEEN 0 AND turn_limit)"));
      db.exec(`INSERT INTO tester_leads_quota_upgrade(${columns}) SELECT ${columns} FROM tester_leads;
        DROP TABLE tester_leads;
        ALTER TABLE tester_leads_quota_upgrade RENAME TO tester_leads;`);
      for (const { sql } of objects) db.exec(sql);
      const restored = db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='tester_leads'").run(sequence);
      if (!restored.changes) db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run('tester_leads', sequence);
    }
    if (db.prepare('PRAGMA foreign_key_check').all().some(row => !existingViolations.has(JSON.stringify(row)))) {
      throw new Error('Tester quota migration would introduce foreign key violations');
    }
    db.exec('RELEASE tester_trial_quota_migration');
  } catch (error) {
    if (savepoint) db.exec('ROLLBACK TO tester_trial_quota_migration; RELEASE tester_trial_quota_migration');
    throw error;
  } finally {
    if (foreignKeys) db.exec('PRAGMA foreign_keys=ON');
  }
}
export function ensureTesterSchema() {
  if (ready) return;
  db.exec(`CREATE TABLE IF NOT EXISTS tester_accounts (
    user_id INTEGER PRIMARY KEY, phone TEXT UNIQUE NOT NULL, department TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','paused')),
    api_key_cipher TEXT, key_updated_at TEXT, consent_at TEXT NOT NULL,
    reviewed_by INTEGER, reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS tester_invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL, token_cipher TEXT NOT NULL,
    title TEXT NOT NULL, sales_phone TEXT NOT NULL,
    turn_limit INTEGER NOT NULL DEFAULT 2 CHECK(typeof(turn_limit)='integer' AND turn_limit BETWEEN 1 AND 100),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_tester_invitations_owner ON tester_invitations(owner_user_id);
  CREATE TABLE IF NOT EXISTS tester_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, invitation_id INTEGER NOT NULL,
    phone TEXT UNIQUE NOT NULL, name TEXT NOT NULL, store_name TEXT NOT NULL DEFAULT '',
    access_hash TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','approved','rejected','paused')),
    turn_limit INTEGER NOT NULL DEFAULT 2 CHECK(typeof(turn_limit)='integer' AND turn_limit BETWEEN 1 AND 100),
    used_turns INTEGER NOT NULL DEFAULT 0 CHECK(typeof(used_turns)='integer' AND used_turns BETWEEN 0 AND turn_limit),
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
  // Legacy rows and new applications start on 360; saved provider choices remain unchanged.
  if (!db.prepare('PRAGMA table_info(tester_accounts)').all().some(column => column.name === 'department'))
    db.exec("ALTER TABLE tester_accounts ADD COLUMN department TEXT NOT NULL DEFAULT ''");
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
  ensureTrialQuotaSchema();
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
    name: account.name, phone: account.phone, department: account.department || '', status: account.status, accountType: 'tester',
    activeProvider, providers, keyConfigured: active.configured, keyMasked: active.maskedKey, keyUpdatedAt: active.keyUpdatedAt,
    createdAt: account.created_at, reviewedAt: account.reviewed_at };
}

export function testerProviderKey(userId, provider) {
  ensureTesterSchema(); testerProvider(provider);
  return q.get('SELECT api_key_cipher,key_updated_at FROM tester_provider_keys WHERE owner_user_id=? AND provider=?', Number(userId), provider) || null;
}

// Business access and administrative authority are separate. This allowlist
// also applies to direct API requests; adding a new route never grants it to a
// tester implicitly. Ownership/tenant/module guards still run afterwards.
export function testerRequestAllowed(account, req) {
  if (!account) return true;
  const pathname = String(req.originalUrl || req.url || '').split('?')[0];
  return /^\/api\/tester(?:\/|$)/.test(pathname)
    || /^\/api\/auth\/(?:me|session|logout|sessions(?:\/[^/]+)?)$/.test(pathname)
    || (req.method === 'GET' && /^\/api\/sys\/(?:notifications|feishu\/me)$/.test(pathname))
    || (req.method === 'POST' && /^\/api\/sys\/notifications\/(?:[1-9]\d*\/)?read$/.test(pathname))
    || /^\/api\/(?:meta|events|inbox|onboarding|business-flow|dashboard|store-ops|reviews|growth|content|toolbox|imagehunt|activities|marshals|employees|employee-workbench|employee-intro|agents|files|advisor|execution|task-center|analysis|store-data|assets)(?:\/|$)/.test(pathname)
    || (['GET', 'HEAD'].includes(req.method || 'GET') && /^\/uploads\//.test(pathname));
}

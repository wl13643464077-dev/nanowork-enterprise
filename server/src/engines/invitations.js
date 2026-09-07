import { createHash, randomBytes } from 'node:crypto';
import { db, q } from '../db.js';
import { assertSeatAvailable } from './plan.js';
import { hashPassword } from '../util.js';

export const INVITATION_ROLES = Object.freeze([
  { role: 'boss', label: '老板' }, { role: 'admin', label: '管理员' },
  { role: 'ops_director', label: '运营负责人' }, { role: 'manager', label: '店长' },
  { role: 'sales', label: '员工' }, { role: 'partner', label: '推广伙伴' },
]);
const ROLES = new Set(INVITATION_ROLES.map(item => item.role));
const DAY_MS = 86_400_000;
const CODE_PATTERN = /^NW-[A-Za-z0-9_-]{32}$/u;
const roleLabel = role => INVITATION_ROLES.find(item => item.role === role)?.label || '';
const error = (message, status = 400, code = 'INVITATION_INVALID') => Object.assign(new Error(message), { status, code });
const invalid = () => error('邀请码无效、已过期或当前不可使用，请联系邀请人');
const iso = () => new Date().toISOString();
const codeHash = code => createHash('sha256').update(code).digest('hex');

function currentManager(actor, scope) {
  const user = q.get('SELECT id,name,role,tenant_id,status FROM users WHERE id=?', actor?.id);
  if (!user || user.status !== '启用') throw error('账号已停用或不存在', 403, 'INVITATION_FORBIDDEN');
  if (scope === 'platform') {
    if (user.role !== 'platform_super') throw error('仅平台超级管理员可管理平台邀请码', 403, 'INVITATION_FORBIDDEN');
  } else {
    if (!['boss', 'admin'].includes(user.role)) throw error('仅企业老板或管理员可邀请成员', 403, 'INVITATION_FORBIDDEN');
    if (q.get('SELECT status FROM tenants WHERE id=?', user.tenant_id)?.status !== '已开通')
      throw error('企业尚未开通或已停用', 403, 'INVITATION_FORBIDDEN');
  }
  return user;
}

function issuerStillAuthorized(invitation) {
  const issuer = q.get('SELECT role,status,tenant_id FROM users WHERE id=?', invitation.created_by);
  if (!issuer || issuer.status !== '启用') return false;
  if (invitation.creator_scope === 'platform') return issuer.role === 'platform_super';
  return ['boss', 'admin'].includes(issuer.role)
    && Number(issuer.tenant_id) === Number(invitation.issuer_tenant_id)
    && Number(issuer.tenant_id) === Number(invitation.tenant_id)
    && q.get('SELECT status FROM tenants WHERE id=?', issuer.tenant_id)?.status === '已开通';
}

function invitationStatus(row, now = Date.now()) {
  if (row.revoked_at) return 'revoked';
  if (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now) return 'expired';
  if (Number(row.used_count) >= Number(row.max_uses)) return 'exhausted';
  if (!issuerStillAuthorized(row)) return 'unavailable';
  if (row.type === 'existing_tenant') {
    if (q.get('SELECT status FROM tenants WHERE id=?', row.tenant_id)?.status !== '已开通') return 'unavailable';
    if (row.store_id != null && !q.get('SELECT id FROM stores WHERE id=? AND tenant_id=?', row.store_id, row.tenant_id)) return 'unavailable';
  }
  return 'active';
}

function safeInvitation(row) {
  return {
    id: Number(row.id), type: row.type, tenantId: row.tenant_id == null ? null : Number(row.tenant_id),
    tenantName: row.tenant_id == null ? null : q.get('SELECT name FROM tenants WHERE id=?', row.tenant_id)?.name || '',
    role: row.role, roleLabel: roleLabel(row.role), storeId: row.store_id == null ? null : Number(row.store_id),
    codeMasked: row.code_masked, maxUses: Number(row.max_uses), usedCount: Number(row.used_count),
    expiresAt: row.expires_at, status: invitationStatus(row), createdAt: row.created_at, revokedAt: row.revoked_at,
  };
}

function audit(invitationId, event, actorId, tenantId, userId = null) {
  q.run('INSERT INTO invitation_events(invitation_id,event,actor_id,tenant_id,user_id,created_at) VALUES(?,?,?,?,?,?)',
    invitationId, event, actorId, tenantId, userId, iso());
}

export function createInvitation(actor, input = {}, scope = 'tenant') {
  const manager = currentManager(actor, scope);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('邀请码配置必须是对象');
  if (Object.keys(input).some(key => !['type', 'tenantId', 'role', 'storeId', 'maxUses', 'expiresAt'].includes(key)))
    throw error('邀请码配置包含不支持的字段');
  const type = input.type || 'existing_tenant';
  if (!['new_tenant', 'existing_tenant'].includes(type)) throw error('邀请码类型无效');
  if (type === 'new_tenant' && scope !== 'platform') throw error('仅平台超级管理员可开通新企业', 403, 'INVITATION_FORBIDDEN');
  const maxUses = input.maxUses === undefined ? 1 : input.maxUses;
  if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 50) throw error('使用次数必须是1到50之间的整数');
  const expiresAtMs = input.expiresAt === undefined ? Date.now() + 7 * DAY_MS
    : typeof input.expiresAt === 'string' ? Date.parse(input.expiresAt) : NaN;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() || expiresAtMs > Date.now() + 90 * DAY_MS)
    throw error('到期时间必须在未来90天内');
  let tenantId = null;
  let storeId = null;
  const role = type === 'new_tenant' ? 'boss' : input.role || 'sales';
  if (!ROLES.has(role) || (type === 'new_tenant' && input.role !== undefined && input.role !== 'boss')) throw error('邀请角色无效');
  if (type === 'new_tenant' && (input.tenantId != null || input.storeId != null)) throw error('新企业邀请码不能绑定已有企业或门店');
  if (type === 'existing_tenant') {
    tenantId = input.tenantId === undefined && scope === 'tenant' ? Number(manager.tenant_id) : Number(input.tenantId);
    if (!Number.isSafeInteger(tenantId) || tenantId < 1) throw error('请选择有效企业');
    if (scope === 'tenant' && tenantId !== Number(manager.tenant_id)) throw error('不能邀请成员进入其他企业', 403, 'INVITATION_FORBIDDEN');
    if (q.get('SELECT status FROM tenants WHERE id=?', tenantId)?.status !== '已开通') throw error('目标企业尚未开通或已停用');
    if (input.storeId != null && input.storeId !== '') {
      storeId = Number(input.storeId);
      if (!Number.isSafeInteger(storeId) || !q.get('SELECT id FROM stores WHERE id=? AND tenant_id=?', storeId, tenantId))
        throw error('门店不存在或不属于目标企业');
    }
  }
  const code = `NW-${randomBytes(24).toString('base64url')}`;
  const createdAt = iso();
  db.exec('BEGIN IMMEDIATE');
  let id;
  let invitation;
  try {
    id = Number(q.run(`INSERT INTO invitations(code_hash,code_masked,type,tenant_id,role,store_id,creator_scope,issuer_tenant_id,created_by,max_uses,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, codeHash(code), `NW-••••••-${code.slice(-6)}`, type, tenantId, role, storeId,
    scope, manager.tenant_id, manager.id, maxUses, new Date(expiresAtMs).toISOString(), createdAt).lastInsertRowid);
    audit(id, 'created', manager.id, tenantId);
    invitation = safeInvitation(q.get('SELECT * FROM invitations WHERE id=?', id));
    db.exec('COMMIT');
  } catch (failure) { db.exec('ROLLBACK'); throw failure; }
  return { ok: true, code, invitation };
}

export function listInvitations(actor, scope = 'tenant') {
  const manager = currentManager(actor, scope);
  const rows = scope === 'platform'
    ? q.all('SELECT * FROM invitations ORDER BY id DESC LIMIT 200')
    : q.all("SELECT * FROM invitations WHERE type='existing_tenant' AND tenant_id=? ORDER BY id DESC LIMIT 200", manager.tenant_id);
  return { items: rows.map(safeInvitation), roles: INVITATION_ROLES };
}

export function revokeInvitation(actor, id, scope = 'tenant') {
  const manager = currentManager(actor, scope);
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw error('邀请码不存在', 404);
  db.exec('BEGIN IMMEDIATE');
  let row;
  let invitation;
  try {
    row = q.get('SELECT * FROM invitations WHERE id=?', Number(id));
    if (!row || (scope !== 'platform' && (row.type !== 'existing_tenant' || Number(row.tenant_id) !== Number(manager.tenant_id))))
      throw error('邀请码不存在', 404);
    if (!row.revoked_at) {
      q.run('UPDATE invitations SET revoked_at=?,revoked_by=? WHERE id=? AND revoked_at IS NULL', iso(), manager.id, row.id);
      audit(row.id, 'revoked', manager.id, row.tenant_id);
    }
    invitation = safeInvitation(q.get('SELECT * FROM invitations WHERE id=?', row.id));
    db.exec('COMMIT');
  } catch (failure) { db.exec('ROLLBACK'); throw failure; }
  return { ok: true, invitation };
}

function validInvitation(code) {
  if (typeof code !== 'string' || !CODE_PATTERN.test(code.trim())) throw invalid();
  const row = q.get('SELECT * FROM invitations WHERE code_hash=?', codeHash(code.trim()));
  if (!row || invitationStatus(row) !== 'active') throw invalid();
  return row;
}

export function previewInvitation(code) {
  const row = validInvitation(code);
  return { valid: true, type: row.type,
    tenantName: row.tenant_id == null ? null : q.get('SELECT name FROM tenants WHERE id=?', row.tenant_id)?.name,
    roleLabel: roleLabel(row.role), expiresAt: row.expires_at };
}

// Synchronous BEGIN IMMEDIATE covers fresh authorization, seats, single-use
// consumption, user creation and audit. Failed signup cannot spend an invite.
export function registerWithInvitation({ inviteCode, company, contactName, phone, username, password }) {
  const passwordHash = hashPassword(password);
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = validInvitation(inviteCode);
    if (q.get('SELECT id FROM users WHERE username=?', username)) throw error('该登录账号已被注册', 400, 'USERNAME_TAKEN');
    let tenantId = row.tenant_id;
    if (row.type === 'new_tenant') {
      if (!company) throw error('开通新企业需要填写企业名称', 400, 'REGISTRATION_INVALID');
      tenantId = Number(q.run(`INSERT INTO tenants(name,contact_name,phone,status,plan,credits,seat_limit,approved_by,approved_at)
        VALUES(?,?,?,'已开通','标准版',0,5,?,?)`, company, contactName || username, phone || null, row.created_by, iso()).lastInsertRowid);
    } else {
      assertSeatAvailable(tenantId);
    }
    const consumed = q.run('UPDATE invitations SET used_count=used_count+1 WHERE id=? AND revoked_at IS NULL AND used_count<max_uses', row.id);
    if (Number(consumed.changes) !== 1) throw invalid();
    const userId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,dept,phone,status,tenant_id,store_id,modules,credits)
      VALUES(?,?,?,?,?,?,'启用',?,?,NULL,0)`, username, passwordHash, contactName || username, row.role,
    ['boss', 'admin', 'ops_director'].includes(row.role) ? '管理层' : '', phone || null, tenantId, row.store_id).lastInsertRowid);
    if (row.type === 'new_tenant') q.run('UPDATE tenants SET primary_user_id=? WHERE id=?', userId, tenantId);
    audit(row.id, 'redeemed', userId, tenantId, userId);
    db.exec('COMMIT');
    return { ok: true, tenantId: Number(tenantId), registrationType: row.type, canLogin: true,
      message: row.type === 'new_tenant' ? '企业已开通，账号创建成功，请登录使用。' : '已加入受邀企业，请登录使用。' };
  } catch (failure) { db.exec('ROLLBACK'); throw failure; }
}

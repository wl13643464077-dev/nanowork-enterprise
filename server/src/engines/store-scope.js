import { AsyncLocalStorage } from 'node:async_hooks';
import { q, qRaw, curTenant } from '../db.js';

// ===== 多门店「当前门店上下文」（连锁客户）=====
// 请求头 X-Store-Id（可选）→ storeScope 中间件校验归属与权限 → AsyncLocalStorage。
// 未传头 = 全店（不过滤），单店客户与所有既有调用零感知。
// 与 db.js 的 tenantScope 同款实现：独立 ALS 实例，嵌套在租户上下文之内。

const _sctx = new AsyncLocalStorage();

export const curStore = () => _sctx.getStore() ?? null;
export const runWithStore = (storeId, fn) =>
  _sctx.run(storeId == null ? null : Number(storeId), fn);

// 任意门店：老板/管理员/平台超管/门店运营（总部视角）
export const ANY_STORE_ROLES = new Set(['boss', 'admin', 'platform_super', 'ops_director']);

export function storeExistsInTenant(storeId, tenantId = curTenant()) {
  const id = Number(storeId);
  if (!Number.isInteger(id) || id <= 0) return false;
  return !!q.get('SELECT id FROM stores WHERE tenant_id=? AND id=?', tenantId, id);
}

// 用户对某门店是否可见：任意门店角色→租户内即可；其他角色绑了 store_id 只能看本店，没绑（总部/全店）沿用原有范围
export function canAccessStore(user, storeId) {
  if (!storeExistsInTenant(storeId)) return false;
  if (ANY_STORE_ROLES.has(String(user?.role || ''))) return true;
  const own = user?.store_id == null ? null : Number(user.store_id);
  return own == null || own === Number(storeId);
}

// 读取过滤用的「生效门店」：显式上下文优先，其后是非总部角色的绑定门店；总部角色未传头=全店
export function effectiveStoreId(user) {
  const ctx = curStore();
  if (ctx != null) return ctx;
  if (!user || ANY_STORE_ROLES.has(String(user.role || ''))) return null;
  const own = user.store_id == null ? null : Number(user.store_id);
  return own || null;
}

// 租户默认门店：is_default=1 → 否则把第一家标为默认 → 都没有则懒创建一家（企业名，兜底「总店」）。
// 幂等；所有 SQL 带 tenant_id。
export function defaultStoreId(tenantId = curTenant(), { create = true } = {}) {
  const flagged = q.get(
    'SELECT id FROM stores WHERE tenant_id=? AND is_default=1 ORDER BY id LIMIT 1',
    tenantId,
  );
  if (flagged) return Number(flagged.id);
  const first = q.get('SELECT id FROM stores WHERE tenant_id=? ORDER BY id LIMIT 1', tenantId);
  if (first) {
    qRaw.run('UPDATE stores SET is_default=1 WHERE tenant_id=? AND id=?', tenantId, first.id);
    return Number(first.id);
  }
  if (!create) return null;
  const tenant = q.get('SELECT name FROM tenants WHERE id=?', tenantId);
  const inserted = qRaw.run(
    `INSERT INTO stores(tenant_id,name,is_default,biz_type,status) VALUES(?,?,1,'快餐','营业中')`,
    tenantId,
    String(tenant?.name || '').trim() || '总店',
  );
  return Number(inserted.lastInsertRowid);
}

// 按门店名/编码在本租户内匹配门店（评价/巡店等只有「门店名」文本的场景）；匹配不到返回 null
export function matchStoreByName(name, tenantId = curTenant()) {
  const text = String(name || '').trim();
  if (!text) return null;
  const row = q.get(
    `SELECT id FROM stores WHERE tenant_id=? AND (name=? OR (code IS NOT NULL AND code<>'' AND code=?)) ORDER BY is_default DESC, id LIMIT 1`,
    tenantId,
    text,
    text,
  );
  return row ? Number(row.id) : null;
}

// 把某门店设为租户唯一默认店（清掉同租户其他默认标记）
export function setDefaultStore(storeId, tenantId = curTenant()) {
  qRaw.run('UPDATE stores SET is_default=0 WHERE tenant_id=? AND id<>?', tenantId, storeId);
  qRaw.run('UPDATE stores SET is_default=1 WHERE tenant_id=? AND id=?', tenantId, storeId);
}

// 写入默认：入参 storeId → 当前门店上下文 → 用户绑定门店 → 租户默认门店（懒创建）
// preferUser：业务上「归属人」明确时（任务执行人、被排班员工）其绑定店优先于当前上下文，
// 避免总部切到 B 店视角给 A 店员工派活却把任务落到 B 店、员工反而看不见自己的任务。
export function resolveWriteStoreId(user, explicit = null, { fallbackUser = null, preferUser = null } = {}) {
  const wanted = explicit == null || explicit === '' ? null : Number(explicit);
  if (wanted) return storeExistsInTenant(wanted) ? wanted : null;
  const boundOf = (candidate) => {
    const own = candidate?.store_id == null ? null : Number(candidate.store_id);
    return own && storeExistsInTenant(own) ? own : null;
  };
  const preferred = boundOf(preferUser);
  if (preferred) return preferred;
  const ctx = curStore();
  if (ctx != null) return ctx;
  return boundOf(fallbackUser) ?? boundOf(user) ?? defaultStoreId();
}

// 供 SQL 拼接的门店过滤片段（与 access.userScopeClause 同风格）：无生效门店返回空串，结果与现状完全一致
export function storeClauseFor(user, column = 'store_id', options = {}) {
  const storeId = effectiveStoreId(user);
  if (storeId == null) return { sql: '', params: [], storeId: null };
  const prefix = options.prefix ?? 'AND';
  return { sql: ` ${prefix} ${column} = ?`, params: [storeId], storeId };
}

// Express 中间件：校验 X-Store-Id 并注入上下文。必须挂在 tenantScope 之内（依赖 curTenant）。
export function storeScope(req, res, next) {
  const raw = String(req.get?.('X-Store-Id') ?? '').trim();
  if (!raw) return runWithStore(null, () => next());
  const storeId = Number(raw);
  if (!/^\d{1,12}$/.test(raw) || !Number.isInteger(storeId) || storeId <= 0) {
    return res.status(400).json({ error: 'X-Store-Id 必须是门店编号' });
  }
  if (!canAccessStore(req.user, storeId)) {
    return res.status(403).json({ error: '门店不存在或当前账号无权查看该门店' });
  }
  return runWithStore(storeId, () => next());
}

// 租户门店清单（/auth/me 等轻量场景）：最多 200 家
export function listTenantStores(tenantId = curTenant(), limit = 200) {
  return q
    .all(
      `SELECT id,name,code,is_default FROM stores WHERE tenant_id=? ORDER BY is_default DESC, id LIMIT ?`,
      tenantId,
      Math.max(1, Math.min(200, Number(limit) || 200)),
    )
    .map((row) => ({
      id: Number(row.id),
      name: row.name,
      code: row.code || null,
      isDefault: Number(row.is_default) === 1,
    }));
}

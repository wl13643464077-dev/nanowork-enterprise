import { q, curTenant } from '../db.js';
import { storeClauseFor } from './store-scope.js';

export const FULL_DATA_ROLES = new Set(['boss', 'admin', 'platform_super']);
export const MANAGER_DATA_ROLES = new Set(['ops_director', 'manager']);

export function hasFullDataAccess(user) {
  return FULL_DATA_ROLES.has(String(user?.role || ''));
}

export function isManagerRole(user) {
  return hasFullDataAccess(user) || MANAGER_DATA_ROLES.has(String(user?.role || ''));
}

// manager 绑定门店时（users.store_id 非空）：数据范围 = 本店全体员工 ∪ manager_id 下级树 ∪ 本人。
// 未绑定门店（总部/全店）沿用原来的 manager_id 树。req.user 可能来自旧令牌缺 store_id，按需回查。
function boundStoreIdOf(user) {
  if (user?.store_id !== undefined) return user.store_id == null ? null : Number(user.store_id) || null;
  const row = q.get('SELECT store_id FROM users WHERE tenant_id = ? AND id = ?', curTenant(), Number(user?.id));
  return row?.store_id == null ? null : Number(row.store_id) || null;
}

export function scopedUserIds(user) {
  const userId = Number(user?.id);
  if (!userId) return [];
  if (hasFullDataAccess(user)) return null;
  const ids = new Set([userId]);
  if (!MANAGER_DATA_ROLES.has(String(user?.role || ''))) return [...ids];

  if (String(user?.role) === 'manager') {
    const storeId = boundStoreIdOf(user);
    if (storeId) {
      for (const row of q.all(
        'SELECT id FROM users WHERE tenant_id = ? AND store_id = ?',
        curTenant(),
        storeId,
      )) {
        if (Number(row.id)) ids.add(Number(row.id));
      }
    }
  }

  const queue = [userId];
  while (queue.length) {
    const parentId = queue.shift();
    const children = q.all(
      'SELECT id FROM users WHERE tenant_id = ? AND manager_id = ?',
      curTenant(),
      parentId,
    );
    for (const child of children) {
      const id = Number(child.id);
      if (!id || ids.has(id)) continue;
      ids.add(id);
      queue.push(id);
    }
  }
  return [...ids];
}

export function userScopeClause(user, column, options = {}) {
  const ids = scopedUserIds(user);
  if (ids === null) return { sql: '', params: [], ids: null };
  if (!ids.length) return { sql: ' AND 1=0', params: [], ids: [] };
  const placeholders = ids.map(() => '?').join(',');
  const scoped = `${column} IN (${placeholders})`;
  const expr = options.includeNull ? `(${scoped} OR ${column} IS NULL)` : scoped;
  const prefix = options.prefix ?? 'AND';
  return { sql: ` ${prefix} ${expr}`, params: ids, ids };
}

// 门店过滤片段（与 userScopeClause 同风格）：X-Store-Id 上下文 > 非总部角色的绑定门店 > 空串（全店，结果不变）。
// 用法：const s = storeScopeClause(req.user, 'o.store_id'); sql += s.sql; params.push(...s.params)
export function storeScopeClause(user, column = 'store_id', options = {}) {
  return storeClauseFor(user, column, options);
}

export function canAccessOwner(user, ownerId) {
  if (ownerId == null) return hasFullDataAccess(user);
  const ids = scopedUserIds(user);
  if (ids === null) return true;
  return ids.includes(Number(ownerId));
}

export function canReviewManualTask(user, task) {
  if (!isManagerRole(user) || !task || !canAccessOwner(user, task.assignee_id)) return false;
  // 只有老板可以终审自己负责的任务；其他管理角色必须保留职责分离。
  if (Number(task.assignee_id) === Number(user?.id) && user?.role !== 'boss') return false;
  return true;
}

export function accessibleUserExists(user, ownerId) {
  const id = Number(ownerId);
  if (!id) return false;
  if (!canAccessOwner(user, id)) return false;
  return !!q.get('SELECT id FROM users WHERE tenant_id = ? AND id = ?', curTenant(), id);
}

export function roleListAllows(raw, role) {
  if (raw == null || raw === '') return true;
  try {
    const roles = Array.isArray(raw) ? raw : JSON.parse(raw);
    return Array.isArray(roles) && (!roles.length || roles.includes(role));
  } catch {
    return false;
  }
}

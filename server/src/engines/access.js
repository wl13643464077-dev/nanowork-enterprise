import { q, curTenant } from '../db.js';

export const FULL_DATA_ROLES = new Set(['boss', 'admin', 'platform_super']);
export const MANAGER_DATA_ROLES = new Set(['ops_director', 'manager']);

export function hasFullDataAccess(user) {
  return FULL_DATA_ROLES.has(String(user?.role || ''));
}

export function isManagerRole(user) {
  return hasFullDataAccess(user) || MANAGER_DATA_ROLES.has(String(user?.role || ''));
}

export function scopedUserIds(user) {
  const userId = Number(user?.id);
  if (!userId) return [];
  if (hasFullDataAccess(user)) return null;
  const ids = new Set([userId]);
  if (!MANAGER_DATA_ROLES.has(String(user?.role || ''))) return [...ids];

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

import { db, q, curTenant } from '../db.js';
import { canAccessOwner, isManagerRole } from './access.js';

const BOSS_ROLES = new Set(['boss', 'admin', 'platform_super']);
const MANAGER_ROLES = new Set(['ops_director', 'manager']);
const ROLE_LABEL = {
  self: '本人',
  manager: '管理层',
  boss: '老板/管理员',
};

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(name || ''))) throw new Error(`非法表名：${name}`);
  return `"${name}"`;
}

export function isBossLike(user) {
  return BOSS_ROLES.has(String(user?.role || ''));
}

export function isManagerLike(user) {
  return isBossLike(user) || MANAGER_ROLES.has(String(user?.role || '')) || isManagerRole(user);
}

export function canDeleteByOwnerScope(user, ownerId, minRole = 'self') {
  if (isBossLike(user)) return true;
  if (minRole === 'boss') return false;
  if (minRole === 'manager') return isManagerLike(user) && canAccessOwner(user, ownerId);
  if (Number(ownerId) === Number(user?.id)) return true;
  return isManagerLike(user) && canAccessOwner(user, ownerId);
}

export function deletionDenied(res, requiredRole = 'boss', reason = '无权删除该数据') {
  return res.status(403).json({
    error: `${reason}。需要权限：${ROLE_LABEL[requiredRole] || requiredRole}`,
    requiredRole,
  });
}

export function tableRows(table, whereSql, ...params) {
  return q.all(`SELECT * FROM ${quoteIdent(table)} WHERE tenant_id = ? AND ${whereSql}`, curTenant(), ...params);
}

function archiveInsert(req, spec) {
  const snapshot = JSON.stringify({ table: spec.table, row: spec.row || spec.snapshot || {} });
  const childSnapshot = JSON.stringify(spec.children || spec.childSnapshot || {});
  const out = q.run(`INSERT INTO deleted_records(entity_type,entity_id,module,title,summary,required_role,reason,snapshot,child_snapshot,deleted_by,deleted_by_name,deleted_by_role)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    spec.entityType,
    Number(spec.entityId),
    spec.module || '',
    spec.title || `${spec.entityType}#${spec.entityId}`,
    spec.summary || '',
    spec.requiredRole || 'boss',
    spec.reason || '',
    snapshot,
    childSnapshot,
    req.user?.id || null,
    req.user?.name || req.user?.username || '',
    req.user?.role || '',
  );
  return Number(out.lastInsertRowid);
}

export function archiveAndDelete(req, spec, deleteFn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const archiveId = archiveInsert(req, spec);
    deleteFn();
    db.exec('COMMIT');
    return archiveId;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(x => x.name);
}

function insertRow(table, row) {
  const cols = tableColumns(table).filter(c => Object.prototype.hasOwnProperty.call(row, c));
  if (!cols.length) return;
  const placeholders = cols.map(() => '?').join(',');
  const sql = `INSERT INTO ${quoteIdent(table)}(${cols.map(quoteIdent).join(',')}) VALUES(${placeholders})`;
  db.prepare(sql).run(...cols.map(c => row[c]));
}

function reactivateDataImport(record, primary, user) {
  if (record.reason !== '导入数据纠错') return;
  const importItemId = Number(String(record.summary || '').match(/导入记录#(\d+)/)?.[1]);
  if (!Number.isInteger(importItemId) || importItemId <= 0) return;
  q.run(`UPDATE data_import_items
    SET status='active',current_snapshot=?,last_operator_id=?,last_operator_name=?,updated_at=datetime('now','localtime')
    WHERE tenant_id=? AND id=? AND record_id=? AND status='deleted'`,
  JSON.stringify(primary.row), user.id || null, user.name || user.username || '', curTenant(), importItemId, primary.row.id);
}

function checkIdConflict(table, row) {
  if (!row?.id) return;
  const hasTenant = tableColumns(table).includes('tenant_id');
  const sql = hasTenant
    ? `SELECT id FROM ${quoteIdent(table)} WHERE tenant_id=? AND id=?`
    : `SELECT id FROM ${quoteIdent(table)} WHERE id=?`;
  const hit = hasTenant ? db.prepare(sql).get(curTenant(), row.id) : db.prepare(sql).get(row.id);
  if (hit) throw new Error(`无法恢复：${table}#${row.id} 已存在，请先确认是否已被重新创建`);
}

export function restoreDeletedRecord(record, user) {
  if (!isBossLike(user)) {
    const err = new Error('仅老板/管理员可恢复删除数据');
    err.status = 403;
    throw err;
  }
  if (record.restored_at) {
    const err = new Error('该记录已恢复，无需重复操作');
    err.status = 400;
    throw err;
  }
  let primary;
  let children;
  try {
    primary = JSON.parse(record.snapshot || '{}');
    children = JSON.parse(record.child_snapshot || '{}');
  } catch {
    const err = new Error('删除快照已损坏，无法自动恢复，请联系管理员检查备份');
    err.status = 400;
    throw err;
  }
  if (!primary?.table || !primary?.row) {
    const err = new Error('删除快照不完整，无法恢复');
    err.status = 400;
    throw err;
  }
  const rows = [{ table: primary.table, row: primary.row }];
  const childRows = [];
  for (const [table, list] of Object.entries(children)) {
    if (Array.isArray(list)) for (const row of list) childRows.push({ table, row });
  }
  // 恢复 RAG 文档时必须先恢复文档，再恢复其块；不依赖 JSON 对象键顺序。
  // 其余子表保持快照原顺序（稳定排序），避免改变既有业务恢复语义。
  const restorePriority = table => table === 'kb_docs' ? 10 : table === 'kb_chunks' ? 20 : 100;
  childRows.sort((a, b) => restorePriority(a.table) - restorePriority(b.table));
  rows.push(...childRows);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of rows) checkIdConflict(item.table, item.row);
    for (const item of rows) insertRow(item.table, item.row);
    if (primary.table === 'kb_docs' && primary.row?.file_path) {
      q.run(`UPDATE generated_artifacts SET kb_doc_id=?,status='已入档',updated_at=datetime('now','localtime')
        WHERE tenant_id=? AND file_url=? AND kb_doc_id IS NULL`, primary.row.id, curTenant(), primary.row.file_path);
    }
    reactivateDataImport(record, primary, user);
    q.run(`UPDATE deleted_records SET restored_by=?, restored_by_name=?, restored_at=datetime('now','localtime')
      WHERE tenant_id=? AND id=?`, user.id || null, user.name || user.username || '', curTenant(), record.id);
    db.exec('COMMIT');
    return { restored: rows.length };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function deleteList(table, whereSql, ...params) {
  return q.run(`DELETE FROM ${quoteIdent(table)} WHERE tenant_id=? AND ${whereSql}`, curTenant(), ...params);
}

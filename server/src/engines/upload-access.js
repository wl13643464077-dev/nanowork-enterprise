import { q, curTenant } from '../db.js';
import { canAccessOwner, roleListAllows } from './access.js';

const KB_ADMIN_ROLES = new Set(['boss', 'ops_director', 'admin', 'platform_super']);

export function uploadAccessGuard(req, res, next) {
  const publicPath = req.originalUrl.split('?')[0];
  const tenantId = curTenant();
  const kbAdmin = KB_ADMIN_ROLES.has(req.user.role);

  // 入档后的附件同时受“知识库可见性”和“原文件归属”保护；任一授权成立即可读取。
  const knowledge = q.get('SELECT enabled,visible_roles FROM kb_docs WHERE tenant_id=? AND file_path=?', tenantId, publicPath);
  if (knowledge) {
    const visible = kbAdmin || (knowledge.enabled && roleListAllows(knowledge.visible_roles, req.user.role));
    if (visible) return next();
  }

  const uploaded = q.get('SELECT user_id FROM uploaded_files WHERE tenant_id=? AND file_url=?', tenantId, publicPath);
  if (uploaded && canAccessOwner(req.user, uploaded.user_id)) return next();

  const artifact = q.get('SELECT user_id FROM generated_artifacts WHERE tenant_id=? AND file_url=?', tenantId, publicPath);
  if (artifact && canAccessOwner(req.user, artifact.user_id)) return next();

  const escapedPath = publicPath.replace(/[\\%_]/g, '\\$&');
  const candidates = q.all(`SELECT s.user_id,t.assignee_id,s.content FROM task_submissions s
    JOIN tasks t ON t.id=s.task_id AND t.tenant_id=?
    WHERE s.content LIKE ? ESCAPE '\\' LIMIT 20`, tenantId, `%${escapedPath}%`);
  const submission = candidates.find(row => {
    try {
      const payload = JSON.parse(row.content || '{}');
      return Array.isArray(payload.attachments) && payload.attachments.some(file => file?.url === publicPath);
    } catch { return false; }
  });
  if (submission) {
    const visible = canAccessOwner(req.user, submission.user_id) || canAccessOwner(req.user, submission.assignee_id);
    return visible ? next() : res.status(404).end();
  }
  return res.status(404).end();
}

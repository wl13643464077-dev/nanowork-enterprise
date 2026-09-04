import { q, curTenant } from '../db.js';
import { canAccessOwner, roleListAllows } from './access.js';
import { loadAgentTaskSupersession } from './delivery-state.js';

const KB_ADMIN_ROLES = new Set(['boss', 'ops_director', 'admin', 'platform_super']);

export function uploadAccessGuard(req, res, next) {
  const publicPath = req.originalUrl.split('?')[0];
  const tenantId = curTenant();
  const kbAdmin = KB_ADMIN_ROLES.has(req.user.role);

  // 同一文件可能同时是 generated_artifact 和已入档 KB 附件。
  // 先取产物的取代状态，避免 KB 管理角色在 knowledge 分支提前
  // next()，绕过旧报告静态下载门禁。
  const artifact = q.get(`SELECT user_id,source_type,source_id
    FROM generated_artifacts WHERE tenant_id=? AND file_url=?`, tenantId, publicPath);
  const artifactSupersededBy = String(artifact?.source_type || '') === 'agent_task'
    ? loadAgentTaskSupersession(artifact.source_id, { tenantId })
    : null;
  const supersededResponse = () => res.status(409).json({
    error: `旧报告已由安全修订任务 #${artifactSupersededBy.taskId} 取代，请使用修订版文件`,
    code: 'DELIVERY_SUPERSEDED',
    supersededBy: artifactSupersededBy,
  });

  if (artifactSupersededBy && canAccessOwner(req.user, artifact.user_id)) {
    return supersededResponse();
  }

  // 入档后的附件同时受“知识库可见性”和“原文件归属”保护；任一授权成立即可读取。
  const knowledge = q.get('SELECT enabled,visible_roles FROM kb_docs WHERE tenant_id=? AND file_path=?', tenantId, publicPath);
  if (knowledge) {
    const visible = kbAdmin || (knowledge.enabled && roleListAllows(knowledge.visible_roles, req.user.role));
    if (visible) {
      if (artifactSupersededBy) return supersededResponse();
      return next();
    }
  }

  const uploaded = q.get('SELECT user_id FROM uploaded_files WHERE tenant_id=? AND file_url=?', tenantId, publicPath);
  if (uploaded && canAccessOwner(req.user, uploaded.user_id)) return next();

  if (artifact && canAccessOwner(req.user, artifact.user_id)) {
    return next();
  }

  // AI媒体成片在人工验收前仍以 media_jobs 作为权威归属记录。
  // 只允许当前租户内任务所有人及其有权管理者预览；未入库路径不能变成公开静态文件。
  const media = q.get(
    `SELECT user_id,status FROM media_jobs
    WHERE tenant_id=? AND url=? AND status='成功'`,
    tenantId,
    publicPath,
  );
  if (media && (
    canAccessOwner(req.user, media.user_id)
    || String(req.user?.role || '') === 'platform_super'
  )) return next();

  // 海报叠字的“无字底图”副产物：归属跟随其 media_job（快照里记录了底图地址）。
  const overlayBase = q.get(
    `SELECT user_id FROM media_jobs
    WHERE tenant_id=? AND status='成功'
      AND json_extract(snapshot_json,'$.textOverlay.baseImageUrl')=?`,
    tenantId,
    publicPath,
  );
  if (overlayBase && (
    canAccessOwner(req.user, overlayBase.user_id)
    || String(req.user?.role || '') === 'platform_super'
  )) return next();

  // 样片库：平台级样片（sample_scope='platform'）对所有已登录租户可见；
  // 租户自有样片只对本租户可见。
  const sample = q.get(
    `SELECT id FROM materials
    WHERE is_sample=1 AND url=? AND (sample_scope='platform' OR tenant_id=?)
    LIMIT 1`,
    publicPath,
    tenantId,
  );
  if (sample) return next();

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

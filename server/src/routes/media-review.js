import { createHash } from 'node:crypto';
import { Router } from 'express';
import { db, q, curTenant } from '../db.js';
import { canAccessOwner } from '../engines/access.js';
import { twoPhaseBillingSummary } from '../engines/two-phase-delivery.js';

const r = Router();

export const MEDIA_REVIEW_ROLES = new Set([
  'manager',
  'ops_director',
  'boss',
  'admin',
  'platform_super',
  'super_admin',
]);

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv']);
const TERMINAL_MEDIA_STATUSES = new Set(['成功', '失败']);
const REVIEW_ACTION = '人工验收媒体素材';

export function canReviewMedia(user) {
  return MEDIA_REVIEW_ROLES.has(String(user?.role || ''));
}

function safeJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function mediaTypeLabel(kind) {
  if (kind === 'image') return '图片';
  if (kind === 'video') return '视频';
  return '未知媒体';
}

function pathExtension(value) {
  const clean = String(value || '').split(/[?#]/, 1)[0];
  const match = clean.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
}

export function inferMediaMime(kind, url) {
  const value = String(url || '').trim();
  const dataMime = value.match(/^data:([^;,]+)[;,]/i)?.[1]?.toLowerCase();
  if (dataMime) return dataMime;
  const extension = pathExtension(value);
  const mimeByExtension = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
    heic: 'image/heic',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    m4v: 'video/x-m4v',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
  };
  return mimeByExtension[extension] || (kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : null);
}

export function validateMediaDelivery(job) {
  const kind = String(job?.kind || '');
  const status = String(job?.status || '');
  const url = String(job?.url || '').trim();
  if (status !== '成功') {
    return {
      ready: false,
      reason: `媒体任务当前为“${status || '未知'}”，技术生成尚未成功`,
    };
  }
  if (!['image', 'video'].includes(kind)) {
    return { ready: false, reason: '只有图片或视频任务可以进入人工验收' };
  }
  if (!url) return { ready: false, reason: '供应商未返回可用媒体地址，不能进入业务验收' };
  if (/^(javascript|vbscript|file):/i.test(url) || /[\u0000-\u001f]/.test(url)) {
    return { ready: false, reason: '媒体地址协议不安全，不能进入业务验收' };
  }
  const supportedAddress = /^(https?:\/\/|\/(?!\/)|data:(image|video)\/)/i.test(url);
  if (!supportedAddress) return { ready: false, reason: '媒体地址不是受支持的 HTTPS、站内路径或媒体数据地址' };
  const dataKind = url.match(/^data:(image|video)\//i)?.[1]?.toLowerCase();
  if (dataKind && dataKind !== kind) {
    return { ready: false, reason: `任务声明为${mediaTypeLabel(kind)}，但返回地址是${mediaTypeLabel(dataKind)}` };
  }
  const extension = pathExtension(url);
  if (kind === 'image' && VIDEO_EXTENSIONS.has(extension)) {
    return { ready: false, reason: '任务声明为图片，但返回地址指向视频文件' };
  }
  if (kind === 'video' && IMAGE_EXTENSIONS.has(extension)) {
    return { ready: false, reason: '任务声明为视频，但返回地址指向图片文件' };
  }
  return { ready: true, reason: '' };
}

function reviewLog(jobId) {
  return q.get(`SELECT user_id,username,created_at,target
    FROM op_logs
    WHERE tenant_id=? AND module='内容生产仓' AND action=?
      AND target LIKE ?
    ORDER BY id ASC LIMIT 1`,
  curTenant(), REVIEW_ACTION, `media_job#${Number(jobId)};%`);
}

function linkedMaterial(jobId) {
  return q.get(`SELECT * FROM materials
    WHERE tenant_id=? AND source_type='media_job' AND source_id=?
    ORDER BY id ASC LIMIT 1`, curTenant(), Number(jobId));
}

function linkedAsset(jobId) {
  return q.get(`SELECT * FROM biz_assets
    WHERE tenant_id=? AND source_type='media_job' AND source_id=?
    ORDER BY id ASC LIMIT 1`, curTenant(), Number(jobId));
}

function reviewMetaFromMaterial(material) {
  const artifact = safeJson(material?.artifact_snapshot_json, {}) || {};
  return artifact.manualReview && typeof artifact.manualReview === 'object'
    ? artifact.manualReview
    : null;
}

function mediaBilling(job, fallback = null) {
  let holdRow = null;
  try {
    holdRow = q.get(`SELECT h.*,l.balance_after,l.cost_yuan
      FROM credit_holds h
      LEFT JOIN credit_logs l ON l.id=h.log_id AND l.tenant_id=h.tenant_id
      WHERE h.tenant_id=? AND h.ref_type='media_job' AND h.ref_id=?
      ORDER BY h.id DESC LIMIT 1`, curTenant(), Number(job?.id));
  } catch {
    // 兼容尚未初始化两阶段计费表的旧数据库；不虚构账务状态。
  }
  if (!holdRow) {
    if (fallback?.state) return fallback;
    if (Number.isFinite(Number(fallback?.credits)) && TERMINAL_MEDIA_STATUSES.has(String(job?.status || ''))) {
      const amount = Number(fallback.credits);
      return {
        state: job.status === '失败' && amount === 0 ? 'released' : 'settled',
        holdId: null,
        estimatedCredits: amount,
        heldCredits: 0,
        chargedCredits: job.status === '失败' ? 0 : amount,
        credits: job.status === '失败' ? 0 : amount,
        balance: fallback.balance ?? null,
        costYuan: fallback.costYuan ?? null,
        pendingReconciliation: false,
        note: '历史任务未保留预授权明细，按既有终态账务记录展示。',
        error: null,
      };
    }
    return fallback || null;
  }
  const hold = {
    holdId: holdRow.id,
    credits: Number(holdRow.held_credits || 0),
    balance: holdRow.balance_after ?? null,
  };
  if (holdRow.status === 'held') {
    const pendingReconciliation = String(job?.status || '') === '成功';
    return twoPhaseBillingSummary({
      state: pendingReconciliation ? 'pending_reconciliation' : 'held',
      hold,
      note: pendingReconciliation
        ? '媒体已技术生成成功，但预授权尚未完成实扣结算，保留待人工对账。'
        : '异步媒体任务仍在处理中；当前仅为预授权占扣，尚未实扣。',
    });
  }
  const settledCredits = Number(holdRow.settled_credits || 0);
  const released = String(job?.status || '') === '失败' && settledCredits === 0;
  return twoPhaseBillingSummary({
    state: released ? 'released' : 'settled',
    hold,
    settled: {
      credits: settledCredits,
      balance: holdRow.balance_after ?? null,
      costYuan: holdRow.cost_yuan ?? null,
    },
    note: released
      ? '媒体任务未交付，预授权已全额退回。'
      : '媒体任务已技术交付，并完成实扣结算。',
  });
}

export function augmentMediaJob(job, user) {
  if (!job || typeof job !== 'object') return job;
  const delivery = validateMediaDelivery(job);
  const material = linkedMaterial(job.id);
  const audit = reviewLog(job.id);
  const snapshotReview = reviewMetaFromMaterial(material);
  const reviewed = Boolean(material && (audit || snapshotReview));
  const reviewer = audit?.username || snapshotReview?.reviewedByName || null;
  const reviewedAt = audit?.created_at || snapshotReview?.reviewedAt || null;
  const roleAllowed = canReviewMedia(user);
  const reviewStatus = reviewed
    ? '已人工验收并入库'
    : material
      ? '待补人工验收记录'
      : delivery.ready
        ? '待人工验收'
        : '未进入人工验收';
  const canImport = Boolean(roleAllowed && delivery.ready && !reviewed);
  const canImportReason = canImport
    ? null
    : reviewed
      ? '该媒体已由管理角色人工验收并导入素材库'
      : !roleAllowed
        ? '仅管理角色可人工验收并导入素材库'
        : delivery.reason;
  return {
    ...job,
    kind: String(job.kind || ''),
    mediaType: mediaTypeLabel(job.kind),
    mimeType: inferMediaMime(job.kind, job.url),
    previewUrl: job.url || null,
    urlAvailable: Boolean(String(job.url || '').trim()),
    technicalStatus: String(job.status || '未知'),
    technicalSuccess: delivery.ready,
    businessStatus: reviewStatus,
    reviewStatus,
    reviewRequired: delivery.ready && !reviewed,
    businessUsable: reviewed,
    isImported: Boolean(material),
    importedMaterialId: material ? Number(material.id) : null,
    reviewedBy: reviewer,
    reviewedAt,
    canImport,
    canImportReason,
    billing: mediaBilling(job, job.billing),
  };
}

function augmentResponse(req, body) {
  if (!body || typeof body !== 'object') return body;
  if (req.method === 'GET' && req.path === '/media-jobs' && Array.isArray(body)) {
    return body.map(job => augmentMediaJob(job, req.user));
  }
  if (req.method === 'GET' && /^\/media-jobs\/\d+$/.test(req.path)) {
    return augmentMediaJob(body, req.user);
  }
  if (req.method === 'POST' && ['/generate-image', '/generate-video'].includes(req.path) && body.jobId) {
    const job = q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', curTenant(), Number(body.jobId));
    if (!job) return body;
    const enriched = augmentMediaJob({ ...job, billing: body.billing }, req.user);
    return {
      ...body,
      status: enriched.technicalStatus,
      providerStatus: body.status || null,
      kind: enriched.kind,
      mediaType: enriched.mediaType,
      mimeType: enriched.mimeType,
      url: enriched.previewUrl,
      urlAvailable: enriched.urlAvailable,
      technicalStatus: enriched.technicalStatus,
      technicalSuccess: enriched.technicalSuccess,
      businessStatus: enriched.businessStatus,
      reviewStatus: enriched.reviewStatus,
      reviewRequired: enriched.reviewRequired,
      businessUsable: enriched.businessUsable,
      canImport: enriched.canImport,
      canImportReason: enriched.canImportReason,
      billing: enriched.billing,
    };
  }
  return body;
}

// 现有内容生产路由内含媒体任务接口。此前置层只增强这些接口的响应，
// 其余请求直接放行，不改变正在并行开发的内容生成主链。
r.use((req, res, next) => {
  const shouldAugment = (
    (req.method === 'GET' && (req.path === '/media-jobs' || /^\/media-jobs\/\d+$/.test(req.path)))
    || (req.method === 'POST' && ['/generate-image', '/generate-video'].includes(req.path))
  );
  if (!shouldAugment) return next();
  const sendJson = res.json.bind(res);
  res.json = body => sendJson(augmentResponse(req, body));
  next();
});

// 详情读取与列表保持同一数据作用域：员工看本人，管理层可看下属，
// 避免列表能看到下属任务、点进详情却被旧的“仅本人”条件误拒绝。
r.get('/media-jobs/:id', (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isInteger(jobId) || jobId <= 0) return res.status(404).json({ error: '任务不存在或无权访问' });
  const job = q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', curTenant(), jobId);
  if (!job || (!canAccessOwner(req.user, job.user_id)
    && !['platform_super', 'super_admin'].includes(String(req.user?.role || '')))) {
    return res.status(404).json({ error: '任务不存在或无权访问' });
  }
  const content = job.result_id
    ? q.get(`SELECT id,type,title,body,topic,status,risk_level,ai_mode
      FROM contents WHERE tenant_id=? AND id=?`, curTenant(), job.result_id)
    : null;
  return res.json({ ...job, content });
});

export function importMediaJobMaterial(req, res) {
  if (!canReviewMedia(req.user)) {
    return res.status(403).json({
      error: '媒体技术生成成功不等于业务可用；仅管理角色可完成人工验收并导入素材库',
      requiredRole: 'manager',
      canImport: false,
    });
  }
  const jobId = Number(req.params.id);
  if (!Number.isInteger(jobId) || jobId <= 0) return res.status(404).json({ error: '媒体任务不存在' });
  const job = q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', curTenant(), jobId);
  if (!job || (!canAccessOwner(req.user, job.user_id)
    && !['platform_super', 'super_admin'].includes(String(req.user?.role || '')))) {
    return res.status(404).json({ error: '媒体任务不存在或无权访问' });
  }
  const delivery = validateMediaDelivery(job);
  if (!delivery.ready) {
    return res.status(409).json({
      error: `${delivery.reason}，不能导入素材库`,
      technicalStatus: job.status || '未知',
      businessStatus: '未进入人工验收',
      canImport: false,
    });
  }

  const type = mediaTypeLabel(job.kind);
  const name = `${type}素材·${String(job.prompt || '').slice(0, 28) || job.model || `任务${job.id}`}`;
  const mimeType = inferMediaMime(job.kind, job.url);
  const reviewedAt = q.get(`SELECT datetime('now','localtime') value`)?.value || new Date().toISOString();
  const manualReview = {
    decision: 'accepted',
    source: 'manager_manual_media_review',
    reviewedById: Number(req.user.id) || null,
    reviewedByName: req.user.name || req.user.username || '管理角色',
    reviewedByRole: req.user.role || '',
    reviewedAt,
    technicalStatus: job.status,
    boundary: '供应商技术生成成功不等于业务可用；本素材仅在管理角色显式验收后入库。',
  };
  const artifact = {
    kind: job.kind,
    mediaJobId: Number(job.id),
    mediaType: type,
    mimeType,
    model: job.model || null,
    prompt: String(job.prompt || '').slice(0, 2000),
    url: String(job.url).slice(0, 200000),
    recognitionPerformed: false,
    manualReview,
    boundary: '只持久化生成任务元数据与文件地址；人工验收确认业务可用，但不表示系统已识别或核验全部媒体内容。',
  };
  const artifactSnapshot = JSON.stringify(artifact);
  const snapshotHash = createHash('sha256').update(JSON.stringify({
    body: null,
    artifact,
  }), 'utf8').digest('hex');
  const tags = [
    type,
    'AI媒体',
    '人工验收',
    job.content_employee_name || '',
  ].filter(Boolean).join(',');
  const note = `人工验收入库：验收人=${manualReview.reviewedByName}（${manualReview.reviewedByRole}）；验收时间=${reviewedAt}；来源=媒体生成任务#${job.id}；模型=${job.model || '-'}；技术状态=${job.status}。仅保存安全元数据与文件地址，未额外执行图片/视频识别。`;

  let material;
  let existed = false;
  let reviewRecorded = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    material = linkedMaterial(job.id);
    if (!material) {
      const inserted = q.run(`INSERT INTO materials(
        name,type,tags,url,source_type,source_id,creator_id,note,
        body_snapshot,artifact_snapshot_json,snapshot_hash
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      name, type, tags, job.url, 'media_job', job.id, job.user_id || req.user.id, note,
      null, artifactSnapshot, snapshotHash);
      material = q.get('SELECT * FROM materials WHERE tenant_id=? AND id=?', curTenant(), inserted.lastInsertRowid);
    } else {
      existed = true;
    }

    let asset = linkedAsset(job.id);
    if (!asset) {
      q.run(`INSERT INTO biz_assets(
        name,category,value,status,use_count,owner,source_type,source_id,creator_id,url,note
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      name, '内容资产', job.kind === 'video' ? 220 : 160, '使用中', 0, '内容生产仓',
      'media_job', job.id, job.user_id || req.user.id, job.url, note);
      asset = linkedAsset(job.id);
    }

    const existingAudit = reviewLog(job.id);
    if (!existingAudit) {
      if (existed && !String(material.note || '').includes('人工验收入库')) {
        q.run(`UPDATE materials SET note=? WHERE tenant_id=? AND id=?`,
          `${note}；该素材为历史同源记录，本次只补记人工验收，原始不可变快照保持不变。`,
          curTenant(), material.id);
        material = q.get('SELECT * FROM materials WHERE tenant_id=? AND id=?', curTenant(), material.id);
      }
      if (asset && !String(asset.note || '').includes('人工验收入库')) {
        q.run(`UPDATE biz_assets SET note=? WHERE tenant_id=? AND id=?`, note, curTenant(), asset.id);
      }
      q.run(`INSERT INTO op_logs(user_id,username,module,action,target,ip)
        VALUES(?,?,?,?,?,?)`,
      req.user.id || null,
      req.user.name || req.user.username || '管理角色',
      '内容生产仓',
      REVIEW_ACTION,
      `media_job#${job.id};material#${material.id};source=manager_manual_review`,
      req.ip || req.user.ip || '127.0.0.1');
      reviewRecorded = true;
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw error;
  }

  const reviewedJob = augmentMediaJob(job, req.user);
  return res.json({
    id: Number(material.id),
    name: material.name || name,
    type: material.type || type,
    tags: material.tags || tags,
    url: material.url || job.url,
    source_type: 'media_job',
    source_id: Number(job.id),
    use_count: Number(material.use_count || 0),
    created_at: material.created_at || null,
    existed,
    reviewRecorded,
    reviewStatus: reviewedJob.reviewStatus,
    businessUsable: reviewedJob.businessUsable,
    reviewedBy: reviewedJob.reviewedBy,
    reviewedAt: reviewedJob.reviewedAt,
    mediaType: reviewedJob.mediaType,
    mimeType: reviewedJob.mimeType,
    canImport: reviewedJob.canImport,
  });
}

r.post('/media-jobs/:id/import-material', importMediaJobMaterial);

export default r;

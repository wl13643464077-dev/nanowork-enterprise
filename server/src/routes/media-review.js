import { createHash } from 'node:crypto';
import { Router } from 'express';
import { db, q, curTenant } from '../db.js';
import { canAccessOwner } from '../engines/access.js';
import { twoPhaseBillingSummary } from '../engines/two-phase-delivery.js';
import { loadContentDeliveryState } from '../engines/delivery-state.js';

const r = Router();

export const MEDIA_REVIEW_ROLES = new Set([
  'manager',
  'ops_director',
  'boss',
  'admin',
  'platform_super',
]);

const INTERNAL_PROFILE_ROLES = new Set(['boss', 'admin', 'platform_super']);

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv']);
const REVIEW_ACTION = '人工验收媒体素材';
const MANUAL_MEDIA_SOURCE_TYPES = new Set([
  'manual',
  'manual_upload',
  'manual_import',
  'human',
  'human_upload',
  'human_import',
]);

export function canReviewMedia(user) {
  return MEDIA_REVIEW_ROLES.has(String(user?.role || ''));
}

function canViewInternalProfile(user) {
  return INTERNAL_PROFILE_ROLES.has(String(user?.role || ''));
}

function projectLinkedContent(content) {
  if (!content || typeof content !== 'object' || !content.id) return content;
  const delivery = loadContentDeliveryState(content.id, {
    tenantId: curTenant(),
    requireFlowStatus: false,
    requireBilling: false,
  });
  if (delivery.code !== 'DELIVERY_SUPERSEDED') return content;
  return {
    ...content,
    body: '',
    snapshot_json: undefined,
    bodyAvailability: 'superseded',
    businessUsable: false,
    deliveryState: delivery.code,
    supersededBy: delivery.supersededBy || null,
  };
}

// Media rows contain the immutable employee execution snapshot.  Never expose a
// database row wholesale: ordinary employees and operating managers only need
// the task/result fields required to run and review the business workflow.
export function projectMediaJob(job, user) {
  if (!job || typeof job !== 'object') return job;
  const projected = {
    id: Number(job.id),
    user_id: job.user_id == null ? null : Number(job.user_id),
    kind: String(job.kind || ''),
    model: job.model || null,
    prompt: job.prompt || '',
    status: job.status || '处理中',
    task_id: job.task_id || null,
    error: job.error || null,
    credits: job.credits == null ? null : Number(job.credits),
    result_id: job.result_id == null ? null : Number(job.result_id),
    content_employee_idx: job.content_employee_idx == null
      ? null
      : Number(job.content_employee_idx),
    content_employee_key: job.content_employee_key || null,
    content_employee_name: job.content_employee_name || null,
    content_employee_group: job.content_employee_group || null,
    content_run_mode: job.content_run_mode || null,
    created_at: job.created_at || null,
  };
  if (job.canDelete !== undefined) projected.canDelete = Boolean(job.canDelete);
  if (job.deleteBlockedReason !== undefined) {
    projected.deleteBlockedReason = job.deleteBlockedReason || null;
  }
  if (Array.isArray(job.materialReferences)) {
    projected.materialReferences = job.materialReferences;
  }
  if (job.content !== undefined) projected.content = projectLinkedContent(job.content);
  if (job.billing !== undefined) projected.billing = job.billing;
  if (canViewInternalProfile(user)) {
    projected.profile_version = job.profile_version || null;
    projected.prompt_hash = job.prompt_hash || null;
    projected.snapshot_json = job.snapshot_json || null;
  }
  return projected;
}

function safeJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function aiSalesVideoRecoveryPresentation(job, billing) {
  const snapshot = safeJson(job?.snapshot_json, {}) || {};
  const planned = Array.isArray(snapshot?.segments) ? snapshot.segments : [];
  const providerSegments = Array.isArray(snapshot?.providerExecution?.segments)
    ? snapshot.providerExecution.segments
    : [];
  const taskIds = providerSegments
    .map(segment => String(segment?.taskId || '').trim())
    .filter(taskId => /^[\p{L}\p{N}_.:+-]+$/u.test(taskId) && taskId.length <= 240);
  const available =
    snapshot?.workflow === 'ai_sales_video'
    && ['失败', '阻塞'].includes(String(job?.status || ''))
    && !String(job?.url || '').trim()
    && [2, 3].includes(planned.length)
    && providerSegments.length === planned.length
    && taskIds.length === planned.length
    && new Set(taskIds).size === taskIds.length;
  return {
    available,
    mode: available ? 'reuse_existing_provider_tasks' : null,
    providerSubmissions: 0,
    reusedTaskCount: available ? taskIds.length : 0,
    requiresBillingConfirmation: available && billing?.state === 'released',
    estimatedCredits: available
      ? Number(billing?.estimatedCredits || billing?.heldCredits || 0)
      : 0,
    note: available
      ? '可复用原供应商任务恢复本地合成；不会重复提交供应商生成。'
      : null,
  };
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
  const review = artifact.manualReview && typeof artifact.manualReview === 'object'
    ? artifact.manualReview
    : null;
  if (!review) return null;
  return review.decision === 'accepted' && review.source === 'manager_manual_media_review'
    ? review
    : null;
}

function manualMediaBillingExemption(job) {
  const sourceType = String(job?.source_type || '').trim().toLowerCase();
  if (!MANUAL_MEDIA_SOURCE_TYPES.has(sourceType)) return null;
  return {
    state: 'not_required',
    code: 'MEDIA_BILLING_NOT_REQUIRED',
    exempt: true,
    authoritative: true,
    evidenceSource: 'media_jobs.source_type',
    sourceType,
    holdId: null,
    estimatedCredits: 0,
    heldCredits: 0,
    chargedCredits: 0,
    credits: 0,
    balance: null,
    costYuan: null,
    pendingReconciliation: false,
    note: '该媒体由权威来源字段明确标记为人工上传，不涉及 AI 供应商计费。',
    error: null,
  };
}

function missingMediaBilling({
  code = 'MEDIA_BILLING_MISSING',
  note = '真实 AI 媒体缺少可核验的正向结算记录，不能进入人工验收或导出。',
  hold = null,
} = {}) {
  return {
    state: code === 'MEDIA_BILLING_MISSING' ? 'missing' : 'pending_reconciliation',
    code,
    exempt: false,
    authoritative: false,
    holdId: Number(hold?.id || hold?.holdId || 0) || null,
    estimatedCredits: Number(hold?.held_credits || hold?.credits || 0),
    heldCredits: Number(hold?.status === 'held' ? hold?.held_credits : 0),
    chargedCredits: null,
    credits: null,
    balance: null,
    costYuan: null,
    pendingReconciliation: true,
    note,
    error: null,
  };
}

function mediaBilling(job) {
  const exemption = manualMediaBillingExemption(job);
  if (exemption) return exemption;
  let holdRow = null;
  try {
    holdRow = q.get(`SELECT h.*,
        l.id AS billing_log_id,l.user_id AS billing_log_user_id,
        l.kind AS billing_log_kind,l.credits AS billing_log_credits,
        l.ai_mode AS billing_log_ai_mode,l.balance_after,l.cost_yuan
      FROM credit_holds h
      LEFT JOIN credit_logs l ON l.id=h.log_id AND l.tenant_id=h.tenant_id
      WHERE h.tenant_id=? AND h.ref_type='media_job' AND h.ref_id=?
      ORDER BY h.id DESC LIMIT 1`, curTenant(), Number(job?.id));
  } catch {
    // 兼容尚未初始化两阶段计费表的旧数据库；不虚构账务状态。
  }
  if (!holdRow) return missingMediaBilling();
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
  if (released) return {
    ...twoPhaseBillingSummary({
      state: 'released',
      hold,
      settled: {
        credits: 0,
        balance: holdRow.balance_after ?? null,
        costYuan: holdRow.cost_yuan ?? null,
      },
      note: '媒体任务未交付，预授权已全额退回。',
    }),
    code: 'MEDIA_BILLING_RELEASED',
    exempt: false,
    authoritative: Boolean(holdRow.billing_log_id),
    evidenceSource: 'credit_holds',
    evidenceSourceId: Number(holdRow.id),
  };

  const authoritativeSettlement = holdRow.status === 'settled'
    && Number(holdRow.billing_log_id) > 0
    && Number(holdRow.user_id) === Number(job?.user_id)
    && Number(holdRow.billing_log_user_id) === Number(holdRow.user_id)
    && String(holdRow.kind || '') === String(job?.kind || '')
    && String(holdRow.billing_log_kind || '') === String(holdRow.kind || '')
    && String(holdRow.billing_log_ai_mode || '') === 'api'
    && settledCredits > 0
    && Number(holdRow.billing_log_credits) === settledCredits;
  if (!authoritativeSettlement) {
    return missingMediaBilling({
      code: 'MEDIA_BILLING_UNVERIFIED',
      note: '媒体虽有终态账务行，但缺少与当前任务、账号、媒体类型和实扣金额一致的正向结算证据，需人工对账。',
      hold: holdRow,
    });
  }

  return {
    ...twoPhaseBillingSummary({
      state: 'settled',
      hold,
      settled: {
        credits: settledCredits,
        balance: holdRow.balance_after ?? null,
        costYuan: holdRow.cost_yuan ?? null,
      },
      note: '媒体任务已技术交付，并完成实扣结算。',
    }),
    code: 'MEDIA_BILLING_SETTLED',
    exempt: false,
    authoritative: true,
    evidenceSource: 'credit_holds',
    evidenceSourceId: Number(holdRow.id),
  };
}

function billingAllowsReview(billing) {
  return billing?.state === 'settled'
    || (billing?.state === 'not_required'
      && billing?.exempt === true
      && billing?.authoritative === true);
}

function billingBlockCode(billing) {
  return billing?.state === 'missing' || billing?.code === 'MEDIA_BILLING_MISSING'
    ? 'MEDIA_BILLING_MISSING'
    : 'MEDIA_BILLING_UNSETTLED';
}

export function augmentMediaJob(job, user) {
  if (!job || typeof job !== 'object') return job;
  const publicJob = projectMediaJob(job, user);
  const delivery = validateMediaDelivery(job);
  const material = linkedMaterial(job.id);
  const audit = reviewLog(job.id);
  const snapshotReview = reviewMetaFromMaterial(material);
  const reviewed = Boolean(material && (audit || snapshotReview));
  const reviewer = audit?.username || snapshotReview?.reviewedByName || null;
  const reviewedAt = audit?.created_at || snapshotReview?.reviewedAt || null;
  const roleAllowed = canReviewMedia(user);
  const billing = mediaBilling(job);
  const billingReady = billingAllowsReview(billing);
  const billingBlocked = !billingReady;
  const reviewStatus = billingBlocked && delivery.ready
    ? reviewed
      ? '人工验收记录存在，但业务暂不可采用（待账务对账）'
      : '业务暂不可采用（待账务对账）'
    : reviewed
      ? '已人工验收（可用于业务）'
      : material
        ? '可验收（待补人工验收记录）'
        : delivery.ready
          ? '可验收（待管理层审阅）'
          : '尚未形成可验收产物';
  const canImport = Boolean(roleAllowed && delivery.ready && !billingBlocked && !reviewed);
  const canImportReason = canImport
    ? null
    : billingBlocked && delivery.ready
      ? billing?.state === 'missing'
        ? '媒体已技术生成，但缺少数据库权威正向结算记录；当前业务暂不可采用，也不能人工验收入库'
        : '媒体已技术生成，但积分尚未完成结算或仍待账务对账；当前业务暂不可采用，也不能人工验收入库'
      : reviewed
      ? '该媒体已由管理角色人工验收并导入素材库'
      : !roleAllowed
        ? '仅管理角色可人工验收并导入素材库'
        : delivery.reason;
  const businessUsable = reviewed && billingReady;
  const previewAllowed = delivery.ready && billingReady && (roleAllowed || businessUsable);
  const originalUrl = String(job.url || '').trim() || null;
  const recovery = aiSalesVideoRecoveryPresentation(job, billing);
  return {
    ...publicJob,
    url: businessUsable ? originalUrl : null,
    kind: String(job.kind || ''),
    mediaType: mediaTypeLabel(job.kind),
    mimeType: inferMediaMime(job.kind, job.url),
    previewUrl: previewAllowed ? originalUrl : null,
    urlAvailable: Boolean(String(job.url || '').trim()),
    technicalStatus: String(job.status || '未知'),
    technicalSuccess: delivery.ready,
    businessStatus: reviewStatus,
    reviewStatus,
    reviewRequired: delivery.ready && !billingBlocked && !reviewed,
    businessUsable,
    canExport: businessUsable && Boolean(originalUrl),
    isImported: Boolean(material),
    importedMaterialId: material ? Number(material.id) : null,
    reviewedBy: reviewer,
    reviewedAt,
    canImport,
    canImportReason,
    billing,
    recovery,
  };
}

function augmentResponse(req, body) {
  if (!body || typeof body !== 'object') return body;
  if (req.method === 'GET' && req.path === '/media-jobs' && Array.isArray(body)) {
    return body.map(job => {
      const stored = q.get(
        'SELECT * FROM media_jobs WHERE tenant_id=? AND id=?',
        curTenant(),
        Number(job?.id),
      );
      return augmentMediaJob(stored ? {
        ...stored,
        canDelete: job.canDelete,
        deleteBlockedReason: job.deleteBlockedReason,
        materialReferences: job.materialReferences,
      } : job, req.user);
    });
  }
  if (req.method === 'GET' && /^\/media-jobs\/\d+$/.test(req.path)) {
    const stored = q.get(
      'SELECT * FROM media_jobs WHERE tenant_id=? AND id=?',
      curTenant(),
      Number(body?.id),
    );
    return augmentMediaJob(stored ? { ...stored, content: body.content } : body, req.user);
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
      url: enriched.url,
      previewUrl: enriched.previewUrl,
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
    && String(req.user?.role || '') !== 'platform_super')) {
    return res.status(404).json({ error: '任务不存在或无权访问' });
  }
  const content = job.result_id
    ? q.get(`SELECT id,type,title,body,topic,status,risk_level,ai_mode
      FROM contents WHERE tenant_id=? AND id=?`, curTenant(), job.result_id)
    : null;
  return res.json(projectMediaJob({ ...job, content }, req.user));
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
    && String(req.user?.role || '') !== 'platform_super')) {
    return res.status(404).json({ error: '媒体任务不存在或无权访问' });
  }
  const delivery = validateMediaDelivery(job);
  if (!delivery.ready) {
    return res.status(409).json({
      error: `${delivery.reason}，不能导入素材库`,
      technicalStatus: job.status || '未知',
      businessStatus: '尚未形成可验收产物',
      canImport: false,
    });
  }
  const billing = mediaBilling(job);
  if (!billingAllowsReview(billing)) {
    return res.status(409).json({
      error: billing?.state === 'missing'
        ? '媒体已技术生成，但缺少数据库权威正向结算记录，不能人工验收入库'
        : '媒体已技术生成，但积分尚未完成结算或仍待账务对账，不能人工验收入库',
      code: billingBlockCode(billing),
      technicalStatus: job.status || '未知',
      businessStatus: '业务暂不可采用（待账务对账）',
      reviewStatus: '业务暂不可采用（待账务对账）',
      canImport: false,
      billing,
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

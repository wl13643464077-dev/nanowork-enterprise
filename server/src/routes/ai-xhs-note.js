import { Router } from 'express';
import { selectedProviderId, withTaskProvider } from '../engines/ai-provider-selection.js';
import { createHash, randomUUID } from 'node:crypto';
import { db, q, curTenant, getTenantConfig, runWithTenant } from '../db.js';
import { generate, aiAvailable } from '../engines/ai.js';
import { routing, editImage, yunwuAvailable as imageAvailable } from '../engines/yunwu.js';
import { resolveRequestedAttachments, readTenantUploadedFileByUrl, saveUploadedFile } from '../engines/filehub.js';
import { loadGeneratedImageBytes, detectImageFormat } from '../engines/poster-text-overlay.js';
import { canAccessOwner, userScopeClause } from '../engines/access.js';
import { canDispatchEmployee, DISPATCH_DENIED_MESSAGE } from '../engines/employee-dispatch-policy.js';
import { holdCredits, settleHold, releaseHold, refundHold, getSupplierExpense, estimateCallCredits, estimateMaxCredits } from '../engines/credits.js';
import { executeHeldDelivery, twoPhaseBillingSummary, withImmediateTransaction } from '../engines/two-phase-delivery.js';
import { scanText } from '../engines/risk.js';
import { buildNativeContentSkillContext } from '../engines/native-content-skill-context.js';
import { activeContentEvolutionNotes } from '../engines/employee-evolution.js';
import { evolutionNotesPromptLines, sanitizeEvolutionNotesForPrompt } from '../engines/employee-evolution-prompt.js';
import { approvedNativeChatPlan } from '../engines/native-creative-chat-store.js';
import { XHS_STYLES, XHS_COVER_LAYOUTS, xhsImageCount, xhsImageRoles, buildXhsImagePlan, XHS_NOTE_SOURCE, XHS_NOTE_SYSTEM, xhsImageModel, XHS_IMAGE_TIMEOUT_MS, XHS_IMAGE_ROLES, normalizeXhsNoteInput, xhsNotePrompt, parseXhsNoteOutput, xhsNoteMarkdown, xhsNoteFailure, xhsImagePrompt, renderXhsImage } from '../engines/ai-xhs-note.js';

const router = Router();
const instanceId = randomUUID();
const active = new Set();
const activeImages = new Set();
const activeLayouts = new Set();
const imageLeaseMs = 4 * XHS_IMAGE_TIMEOUT_MS + 5 * 60_000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const imageInput = snapshot => snapshot.imageGeneration?.input || snapshot.input || {};
const imageOutput = snapshot => snapshot.imageGeneration?.outputSnapshot || snapshot.output || {};
const imageRoles = snapshot => xhsImageRoles(imageInput(snapshot), { legacy: true });
const currentOutput = snapshot => snapshot.editedOutput || snapshot.output || null;
const json = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const readRow = id => q.get('SELECT * FROM contents WHERE tenant_id=? AND id=? AND source_type=?', curTenant(), id, XHS_NOTE_SOURCE);
const imageRoleAllowed = role => {
  const roles = getTenantConfig('feature_flags', {})['content.image'];
  return !roles || roles.includes(role);
};
const imageRows = id => q.all(`SELECT * FROM media_jobs WHERE tenant_id=? AND kind='image'
  AND json_extract(snapshot_json,'$.source')='ai_xhs_note_image'
  AND json_extract(snapshot_json,'$.contentId')=? ORDER BY id`, curTenant(), id);

function imageBilling(row, snapshot) {
  const hold = q.get("SELECT name FROM sqlite_master WHERE type='table' AND name='credit_holds'") && q.get(`SELECT * FROM credit_holds
    WHERE tenant_id=? AND user_id=? AND ref_type='media_job' AND ref_id=? ORDER BY id DESC LIMIT 1`, curTenant(), row.user_id, row.id);
  if (!hold) return { state: 'not_held', heldCredits: 0, chargedCredits: 0, pendingReconciliation: false };
  const ledger = q.get('SELECT credits,cost_yuan FROM credit_logs WHERE id=? AND tenant_id=? AND user_id=?', hold.log_id, curTenant(), row.user_id);
  if (hold.status === 'settled' && ledger && Number(ledger.credits) === Number(hold.settled_credits)) {
    const expense = getSupplierExpense(hold.id, curTenant());
    if (expense?.refundedAt && expense.userId === row.user_id) return {
      ...twoPhaseBillingSummary({ state: 'released', hold: { holdId: hold.id, credits: hold.held_credits },
        settled: { credits: 0, costYuan: expense.costYuan }, note: '本张图片积分已退回；取回原结果不会再次收费。' }),
      refundedCredits: expense.refundedCredits,
    };
    return twoPhaseBillingSummary({ state: Number(ledger.credits) === 0 ? 'released' : 'settled',
      hold: { holdId: hold.id, credits: hold.held_credits }, settled: { credits: ledger.credits, costYuan: ledger.cost_yuan } });
  }
  return { ...snapshot.billing, state: 'pending_reconciliation', holdId: hold.id, heldCredits: hold.held_credits,
    chargedCredits: null, pendingReconciliation: true, note: '这张图片的调用或结算中断，费用待核对，不会重复生成。' };
}

function imageReceiptFor(row, state) {
  const receipt = state.providerReceipt;
  if (!receipt || receipt.kind !== 'image2_result' || !['gpt-image-2', 'openai/gpt-image-2'].includes(receipt.model) || !(receipt.status >= 200 && receipt.status < 300)
    || receipt.tenantId !== curTenant() || receipt.userId !== row.user_id || receipt.mediaJobId !== row.id
    || receipt.contentId !== state.contentId || receipt.promptHash !== state.promptHash || receipt.requestKey !== state.idempotencyKey
    || (!receipt.url && !receipt.b64 && !state.originalUrl)) return null;
  const { receiptHash, ...data } = receipt;
  if (hash(data) !== receiptHash) return null;
  const hold = q.get(`SELECT * FROM credit_holds WHERE tenant_id=? AND user_id=? AND id=? AND ref_type='media_job' AND ref_id=?`,
    curTenant(), row.user_id, receipt.holdId, row.id);
  if (!hold || !['held', 'settled'].includes(hold.status) || hold.kind !== 'image' || hold.model !== receipt.model) return null;
  const log = q.get('SELECT kind,model,credits FROM credit_logs WHERE tenant_id=? AND user_id=? AND id=?', curTenant(), row.user_id, hold.log_id);
  if (!log || log.kind !== 'image' || log.model !== receipt.model || (hold.status === 'settled' && Number(log.credits) !== Number(hold.settled_credits))) return null;
  return { receipt, hold };
}

function removeInlineReceipt(state) {
  if (!state.providerReceipt?.b64 || !state.originalUrl) return;
  const { receiptHash: _oldHash, b64: _inlineImage, ...receipt } = state.providerReceipt;
  state.providerReceipt = { ...receipt, receiptHash: hash(receipt) };
}

function publicImage(row) {
  let snapshot = json(row.snapshot_json);
  const inFlight = activeImages.has(`${curTenant()}:${row.id}`);
  if (!inFlight && ['held', 'pending_reconciliation', 'settled', 'released'].includes(snapshot.billing?.state)) snapshot.billing = imageBilling(row, snapshot);
  if (row.status === '处理中' && !inFlight && ((snapshot.status === 'running' && (snapshot.instanceId === instanceId || Date.now() > snapshot.deadline))
    || (snapshot.status === 'pending' && Date.now() > snapshot.deadline))) {
    snapshot = { ...snapshot, billing: imageBilling(row, snapshot), status: row.url ? 'success' : 'failed',
      error: row.url ? null : '图片执行中断，已有文案和其他图片仍保留。' };
    try { q.run('UPDATE media_jobs SET status=?,error=?,snapshot_json=? WHERE tenant_id=? AND id=?',
      row.url ? '成功' : '失败', snapshot.error, JSON.stringify(snapshot), curTenant(), row.id); } catch { /* keep readable evidence */ }
  }
  const status = snapshot.status || (row.status === '成功' ? 'success' : row.status === '失败' ? 'failed' : 'running');
  const creator = q.get('SELECT role,status FROM users WHERE tenant_id=? AND id=?', curTenant(), row.user_id);
  return { id: snapshot.role, role: snapshot.role, label: snapshot.label || XHS_IMAGE_ROLES.find(item => item.id === snapshot.role)?.label || '配图',
    purpose: snapshot.purpose || null, index: snapshot.index || null, layoutStatus: snapshot.layoutStatus || null,
    status, mediaJobId: row.id, url: row.url || null, fileId: snapshot.fileId || null, aiGenerated: true,
    width: snapshot.width || null, height: snapshot.height || null, error: snapshot.error || null,
    warning: snapshot.warning || null, originalUrl: snapshot.originalUrl || null,
    canRetry: status === 'failed' && ['released', 'not_held'].includes(snapshot.billing?.state)
      && !imageReceiptFor(row, snapshot)
      && creator?.status === '启用' && imageRoleAllowed(creator.role),
    canRecover: !inFlight && (status === 'failed' || snapshot.billing?.state === 'pending_reconciliation') && !!imageReceiptFor(row, snapshot),
    billing: snapshot.billing || null };
}

function imageGeneration(row, snapshot) {
  const model = snapshot.imageGeneration?.model || xhsImageModel();
  if (imageInput(snapshot).generateImages !== true) return { model, status: 'disabled', items: [], completedCount: 0, failedCount: 0 };
  const rows = imageRows(row.id);
  const items = rows.length ? rows.map(publicImage) : imageRoles(snapshot).map(role => ({ ...role, role: role.id,
    status: snapshot.status === 'running' ? 'pending' : 'failed', aiGenerated: true, url: null, fileId: null,
    canRetry: !!snapshot.output && snapshot.billing?.state === 'settled', billing: null,
    error: snapshot.status === 'running' ? null : '配图尚未开始，文案与照片仍保留。' }));
  const completedCount = items.filter(item => item.status === 'success').length;
  const failedCount = items.filter(item => item.status === 'failed').length;
  const status = activeLayouts.has(`${curTenant()}:${row.id}`) || items.some(item => item.status === 'running') ? 'running'
    : items.some(item => item.status === 'pending') ? 'pending'
      : completedCount === imageRoles(snapshot).length ? 'success' : completedCount ? 'partial' : 'failed';
  return { model, status, items, completedCount, failedCount, imageCount: imageRoles(snapshot).length,
    plan: buildXhsImagePlan(imageInput(snapshot), imageOutput(snapshot), { legacy: true }), coverLayout: imageInput(snapshot).coverLayout || 'photo' };
}

function ensureImageJobs(content, snapshot, options = {}) {
  const binding = { providerId: snapshot.imageGeneration?.providerId, model: snapshot.imageGeneration?.model || xhsImageModel() };
  return withTaskProvider(binding, () => ensureImageJobsSelected(content, snapshot, options));
}
function ensureImageJobsSelected(content, snapshot, { transaction = false } = {}) {
  const work = () => {
    const existing = imageRows(content.id);
    for (const role of buildXhsImagePlan(imageInput(snapshot), imageOutput(snapshot), { legacy: true })) {
      if (existing.some(row => json(row.snapshot_json).role === role.id)) continue;
      const prompt = xhsImagePrompt({ input: imageInput(snapshot), output: imageOutput(snapshot), role: role.id });
      const imageSnapshot = { source: 'ai_xhs_note_image', contentId: content.id, role: role.id, label: role.label, purpose: role.purpose, visualTask: role.visualTask, index: role.index, status: 'pending',
        model: xhsImageModel(), providerId: selectedProviderId(), instanceId, deadline: Date.now() + imageLeaseMs, attempts: 0,
        creditsPerImage: snapshot.imageGeneration?.creditsPerImage || estimateMaxCredits('image', xhsImageModel()),
        billing: { state: 'not_held', heldCredits: 0, chargedCredits: 0 },
        referenceFileIds: imageInput(snapshot).fileIds, promptHash: createHash('sha256').update(prompt).digest('hex'),
        skillRevision: snapshot.employeeExecution?.skills?.revision, skillApplication: 'upstream_visual_plan', aiGenerated: true };
      q.run(`INSERT INTO media_jobs(tenant_id,user_id,kind,model,prompt,status,content_employee_idx,content_employee_key,content_employee_name,content_employee_group,content_run_mode,snapshot_json)
        VALUES(?,?,'image',?,?,'处理中',11,'xhs_note','AI小红书种草员','图文种草部','single_station',?)`,
      curTenant(), content.creator_id, xhsImageModel(), prompt, JSON.stringify(imageSnapshot));
    }
    return imageRows(content.id);
  };
  return transaction ? work() : withImmediateTransaction(db, work);
}

export async function executeXhsImageJob(row, content, snapshot, runtime = {}) {
  const stored = q.get('SELECT model,snapshot_json FROM media_jobs WHERE tenant_id=? AND id=?', curTenant(), Number(row?.id));
  if (!stored) throw fail('配图任务不存在', 404);
  return withTaskProvider({ model: stored.model, providerId: json(stored.snapshot_json).providerId },
    () => executeXhsImageJobSelected(row, content, snapshot, runtime));
}
async function executeXhsImageJobSelected(row, content, snapshot, runtime = {}) {
  // Public helper for isolated acceptance/recovery tooling. Re-read all scoped
  // rows rather than treating caller-supplied prompts, owners or bills as facts.
  const stored = q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', curTenant(), Number(row?.id));
  const storedSnapshot = json(stored?.snapshot_json);
  const parent = readRow(Number(content?.id));
  if (!stored || !parent || !['ai_xhs_note_image', 'ai_xhs_note_image_acceptance'].includes(storedSnapshot.source) || storedSnapshot.contentId !== parent.id
    || stored.user_id !== parent.creator_id || stored.kind !== 'image' || stored.model !== xhsImageModel())
    throw fail('配图任务与当前企业上下文不匹配', 403);
  row = stored; content = parent; snapshot = json(parent.snapshot_json);
  if (!snapshot.output || imageInput(snapshot).generateImages !== true || !textBillingSettled(content, snapshot))
    throw fail('原文案尚未交付或费用待核对', 409);
  const existingHold = q.get("SELECT name FROM sqlite_master WHERE type='table' AND name='credit_holds'") && q.get(`SELECT id,status,settled_credits FROM credit_holds
    WHERE tenant_id=? AND user_id=? AND ref_type='media_job' AND ref_id=? ORDER BY id DESC LIMIT 1`, curTenant(), stored.user_id, stored.id);
  const priorRefund = existingHold && getSupplierExpense(existingHold.id, curTenant())?.refundedAt;
  if (existingHold && (storedSnapshot.status === 'pending' || existingHold.status === 'held' || (Number(existingHold.settled_credits) > 0 && !priorRefund)))
    throw fail('该图片已有未核对或已结算费用，不能再次调用', 409);
  if (imageReceiptFor(stored, storedSnapshot)) throw fail('该图片已有原结果回执，请免费取回原图片，不会重复生成', 409);
  if (!['pending', 'failed'].includes(storedSnapshot.status)) return;
  if (storedSnapshot.status === 'failed' && !publicImage(stored).canRetry) throw fail('待对账配图不能重新调用', 409);
  const key = `${curTenant()}:${row.id}`;
  if (activeImages.has(key)) return;
  // Claim the media row synchronously before a hold or awaited operation, also
  // preventing a second server process from charging the same retry.
  let state = json(row.snapshot_json);
  const claimed = q.run(`UPDATE media_jobs SET status='处理中',snapshot_json=? WHERE tenant_id=? AND id=?
    AND (status='失败' OR json_extract(snapshot_json,'$.status')='pending')`,
  JSON.stringify({ ...state, status: 'running', instanceId, deadline: Date.now() + XHS_IMAGE_TIMEOUT_MS + 120000 }), curTenant(), row.id);
  if (!claimed.changes) return;
  activeImages.add(key);
  state = { ...state, status: 'running', attempts: Number(state.attempts || 0) + 1, instanceId, deadline: Date.now() + XHS_IMAGE_TIMEOUT_MS + 120000, error: null };
  let hold = null;
  let invoked = false;
  const persistState = (status = '处理中', url = row.url || null) => q.run(
    'UPDATE media_jobs SET status=?,url=?,error=?,snapshot_json=? WHERE tenant_id=? AND id=?',
    status, url, state.error || null, JSON.stringify(state), curTenant(), row.id);
  const persistProviderReceipt = async out => {
    if (state.providerReceipt?.kind === 'image2_result') return;
    if (out?.model !== xhsImageModel() || (!out.url && !out.b64)) throw fail('图片服务未返回有效产物', 502);
    const receipt = { kind: 'image2_result', model: xhsImageModel(), status: Number(out.providerStatus) || state.providerResponse?.status || null,
      tenantId: curTenant(), userId: content.creator_id, contentId: content.id, mediaJobId: row.id, holdId: hold.holdId,
      requestKey: state.idempotencyKey, promptHash: state.promptHash, receivedAt: new Date().toISOString(),
      url: out.url || null, ...(out.b64 && !out.url && out.b64.length <= 28 * 1024 * 1024 ? { b64: out.b64 } : {}),
      mimeType: out.mimeType || 'image/png', usage: out.usage || null };
    state.providerReceipt = { ...receipt, receiptHash: hash(receipt) };
    state.providerFinishedAt = receipt.receivedAt;
    state.providerElapsedMs = Date.now() - Date.parse(state.providerStartedAt);
    state.providerStatus = receipt.status; state.usage = receipt.usage;
    // The provider URL must be durable before its download starts. It stays
    // server-side and can only be replayed as a GET for this already held image.
    persistState();
  };
  try {
    if (!(runtime.imageAvailable || imageAvailable)()) throw fail('配图通道暂未配置，文案已保留', 503);
    const creator = q.get("SELECT id,role,status,tenant_id FROM users WHERE tenant_id=? AND id=?", curTenant(), content.creator_id);
    if (!creator || creator.status !== '启用') throw Object.assign(fail('原任务账号不可用，尚未发起配图', 403), { imageFailureReason: 'account' });
    if (!imageRoleAllowed(creator.role)) throw Object.assign(fail('当前账号未开通图片生成', 403), { imageFailureReason: 'permission' });
    const attachments = resolveRequestedAttachments(imageInput(snapshot).fileIds, creator, 6);
    const references = attachments.map(file => {
      const loaded = readTenantUploadedFileByUrl({ fileUrl: file.url });
      const mime = file.ext === 'jpg' || file.ext === 'jpeg' ? 'image/jpeg' : `image/${file.ext}`;
      return `data:${mime};base64,${loaded.bytes.toString('base64')}`;
    });
    hold = holdCredits({ userId: content.creator_id, tenantId: curTenant(), feature: `AI小红书配图·${state.role}`,
      kind: 'image', model: xhsImageModel(), credits: state.creditsPerImage, refType: 'media_job', refId: row.id });
    state.billing = twoPhaseBillingSummary({ state: 'held', hold, note: '本张配图单独预授权；成功保存后按张结算。' });
    state.idempotencyKey = `xhs-image:${curTenant()}:${row.id}:attempt:${state.attempts}`;
    state.referenceHashes = references.map(value => createHash('sha256').update(value).digest('hex'));
    persistState();
    await executeHeldDelivery({ hold, externalInvocationStarted: () => invoked,
      generate: async () => {
        invoked = true;
        state.invocationStarted = true;
        state.providerStartedAt = new Date().toISOString();
        state.providerTimeoutMs = XHS_IMAGE_TIMEOUT_MS;
        persistState();
        let out;
        try {
          out = await (runtime.editImage || editImage)({ prompt: row.prompt, images: references,
            size: '1024x1536', model: xhsImageModel(), timeoutMs: XHS_IMAGE_TIMEOUT_MS, idempotencyKey: state.idempotencyKey,
            onResponse: metadata => { state.providerResponse = metadata; persistState(); },
            onBodyProgress: metadata => { state.providerResponse = { ...state.providerResponse, ...metadata }; persistState(); }, onReceipt: persistProviderReceipt });
        } catch (error) {
          // An explicit request refusal is distinct from an unknown network or
          // 5xx outcome; only the former may release and permit a new attempt.
          if ([400, 401, 403, 404, 409, 422, 429].includes(error?.providerStatus)) invoked = false;
          throw error;
        }
        if (out?.model !== xhsImageModel() || (!out.url && !out.b64)) throw fail('图片服务未返回有效产物', 502);
        await persistProviderReceipt(out);
        state.providerFinishedAt = new Date().toISOString();
        state.providerElapsedMs = Date.now() - Date.parse(state.providerStartedAt);
        state.providerStatus = Number(out.providerStatus) || null;
        state.usage = out.usage || null;
        const bytes = await loadGeneratedImageBytes(out, { fetchFn: runtime.fetchImage || globalThis.fetch });
        const format = detectImageFormat(bytes);
        if (!format) throw fail('图片服务未返回可读取图像', 502);
        // Preserve the paid original before any optional local layout. A font,
        // renderer or layout failure must not erase a successful Image2 image.
        const original = saveUploadedFile({ name: `小红书-${state.role}-Image2原图.${format.ext}`, mime: format.mime,
          b64: bytes.toString('base64'), purpose: 'ai-xhs-images', userId: content.creator_id }).row;
        state = { ...state, fileId: original.id, originalFileId: original.id, originalUrl: original.file_url,
          width: format.width, height: format.height };
        removeInlineReceipt(state);
        persistState('处理中', original.file_url);
        try {
          const png = await (runtime.renderImage || renderXhsImage)(bytes, { role: state.role, input: { ...imageInput(snapshot), ...(state.role === 'cover' && imageInput(snapshot).coverLayout === 'collage4' ? { coverLayout: 'photo' } : {}) }, output: imageOutput(snapshot) });
          if (state.role === 'cover' && imageInput(snapshot).coverLayout === 'collage4') { state.layoutStatus = 'waiting_for_images'; state.warning = '封面原图已交付；集齐4张不同的成功配图后，免费完成四宫格。'; }
          return { png, original };
        } catch {
          state.warning = '已交付Image2原图；本地比例与文字排版未完成。此图为AI创意，发布时请标注，不能冒充实拍顾客。';
          return { png: null, original };
        }
      },
      persist: ({ png, original }) => {
        let file = original;
        if (png) {
          try {
            file = saveUploadedFile({ name: `小红书-${state.role}-AI创意.png`, mime: 'image/png',
              b64: png.toString('base64'), purpose: 'ai-xhs-images', userId: content.creator_id }).row;
            state.width = 768; state.height = 1024;
          } catch { state.warning = '已交付Image2原图；本地排版文件未能保存。此图为AI创意，发布时请标注。'; }
        }
        state = { ...state, fileId: file.id, status: 'success', error: null };
        persistState('成功', file.file_url);
        return { url: file.file_url, fileId: file.id };
      },
      settle: runtime.settleImage || settleHold, release: releaseHold,
      refund: refundHold,
      hasDeliverable: () => !!q.get('SELECT url FROM media_jobs WHERE tenant_id=? AND id=?', curTenant(), row.id)?.url,
      settlement: () => ({ model: xhsImageModel(), credits: hold.credits, usage: state.usage || {}, aiMode: 'api' }),
      onBillingFinalized: ({ billing, delivery }) => {
        state.billing = billing;
        q.run('UPDATE media_jobs SET credits=? WHERE tenant_id=? AND id=?', billing.chargedCredits, curTenant(), row.id);
        persistState('成功', delivery.url);
      },
    });
  } catch (error) {
    const latest = q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', curTenant(), row.id);
    const saved = json(latest?.snapshot_json);
    const delivered = !!latest?.url && !!saved.fileId;
    let billing = error.billing;
    if (!billing && hold) {
      if (!invoked) {
        try { billing = twoPhaseBillingSummary({ state: 'released', hold, settled: releaseHold(hold, '配图调用前失败，预授权退回') }); }
        catch { billing = twoPhaseBillingSummary({ state: 'pending_reconciliation', hold }); }
      } else billing = twoPhaseBillingSummary({ state: 'pending_reconciliation', hold });
    }
    billing ||= { state: 'not_held', heldCredits: 0, chargedCredits: 0, pendingReconciliation: false };
    const safeReasons = new Set(['auth', 'rate_limit', 'prompt_too_long', 'unsupported_size', 'unsupported_model', 'model_unavailable', 'not_found', 'invalid_request', 'timeout', 'network', 'upstream']);
    const diagnostic = { phase: error.deliveryPhase || (invoked ? 'generate' : 'preflight'),
      reason: safeReasons.has(error.providerReason) ? error.providerReason : error.imageFailureReason || 'local_or_unknown',
      httpStatus: Number.isSafeInteger(error.responseStatus) ? error.responseStatus
        : Number.isSafeInteger(error.providerStatus) ? error.providerStatus : null,
      responseEmpty: error.responseEmpty === true,
      responsePhase: error.providerResponsePhase || null,
      responseBodyComplete: error.providerResponseBodyComplete === true, responseBytes: Number(error.providerResponseBytes) || 0,
      firstByteAt: error.providerFirstByteAt || null, lastByteAt: error.providerLastByteAt || null,
      elapsedMs: state.providerStartedAt ? Math.max(0, Date.now() - Date.parse(state.providerStartedAt)) : 0,
      timeoutMs: state.providerTimeoutMs || null, recordedAt: new Date().toISOString() };
    state = { ...state, ...saved, status: delivered ? 'success' : 'failed', billing,
      providerFailure: diagnostic,
      error: delivered ? null : error.imageFailureReason === 'permission' ? '当前账号未开通图片生成，本次未扣费；文案已保留。'
        : error.imageFailureReason === 'account' ? '原任务账号不可用，尚未发起配图，本次未扣费。'
        : error.providerReason === 'model_unavailable'
        ? `图片供应商未接受Image2模型，平台需核对模型路由；${billing.state === 'pending_reconciliation' ? '本张费用待核对' : '本张预授权已退回'}，文案和其他图片已保留。`
        : billing.state === 'pending_reconciliation'
        ? '本张图片未完成，费用待核对；文案和其他图片已保留。'
        : '本张图片未完成，本次未扣费；可单独重试，文案和其他图片已保留。' };
    persistState(delivered ? '成功' : '失败', latest?.url || null);
  } finally { activeImages.delete(key); }
}

async function startImages(id, runtime, selectedIds = null) {
  const content = readRow(id);
  const snapshot = json(content?.snapshot_json);
  if (!content || !snapshot.output || imageInput(snapshot).generateImages !== true || snapshot.billing?.state !== 'settled') return;
  const rows = ensureImageJobs(content, snapshot);
  const queue = rows.filter(row => {
    const state = json(row.snapshot_json);
    return selectedIds ? selectedIds.includes(state.role) : state.status === 'pending' && !Number(state.attempts);
  });
  // Keep provider pressure bounded even for twelve pages. Pending rows are
  // queued work, not interrupted calls, and have no reservation until claimed.
  await Promise.allSettled(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const row = queue.shift();
      try { await executeXhsImageJob(row, content, snapshot, runtime); } catch { /* retain each row's own billing evidence */ }
    }
  }));
  const layoutKey = `${curTenant()}:${id}`;
  activeLayouts.add(layoutKey);
  try { await finalizeCollage(id, runtime); } finally { activeLayouts.delete(layoutKey); }
}

async function recoverImageReceipt(row, content, runtime = {}) {
  const stored = q.get('SELECT model,snapshot_json FROM media_jobs WHERE tenant_id=? AND id=?', curTenant(), row.id);
  if (!stored) return;
  return withTaskProvider({ model: stored.model, providerId: json(stored.snapshot_json).providerId }, () => recoverImageReceiptSelected(row, content, runtime));
}
async function recoverImageReceiptSelected(row, content, runtime = {}) {
  row = q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', curTenant(), row.id);
  const state = json(row?.snapshot_json), verified = row && imageReceiptFor(row, state);
  if (!verified || state.contentId !== content.id || row.user_id !== content.creator_id || !publicImage(row).canRecover) return;
  const key = `${curTenant()}:${row.id}`, snapshot = json(readRow(content.id)?.snapshot_json);
  if (activeImages.has(key)) return;
  const claimedState = { ...state, status: 'running', recoveryStage: 'stored_receipt_download', instanceId,
    deadline: Date.now() + 120000, error: null, recoveryStartedAt: new Date().toISOString() };
  const claim = q.run("UPDATE media_jobs SET status='处理中',error=NULL,snapshot_json=? WHERE tenant_id=? AND id=? AND snapshot_json=?",
    JSON.stringify(claimedState), curTenant(), row.id, row.snapshot_json);
  if (!claim.changes) return;
  Object.assign(state, claimedState); activeImages.add(key);
  let outputUrl = row.url || null;
  const persist = () => q.run('UPDATE media_jobs SET status=?,url=?,error=?,credits=?,snapshot_json=? WHERE tenant_id=? AND id=?',
    state.status === 'success' ? '成功' : state.status === 'failed' ? '失败' : '处理中', outputUrl, state.error || null,
    state.billing?.chargedCredits || row.credits || 0, JSON.stringify(state), curTenant(), row.id);
  try {
    // No holdCredits, editImage or generation POST exists in this recovery path.
    // Prefer the already saved original; otherwise GET only the verified URL.
    const bytes = state.originalUrl ? readTenantUploadedFileByUrl({ fileUrl: state.originalUrl }).bytes
      : await loadGeneratedImageBytes({ url: verified.receipt.url, b64: verified.receipt.b64 }, { fetchFn: runtime.fetchImage || globalThis.fetch });
    const format = detectImageFormat(bytes);
    if (!format) throw fail('已返回的图片数据无法识别', 502);
    if (!state.originalUrl) {
      const original = saveUploadedFile({ name: `小红书-${state.role}-Image2原图.${format.ext}`, mime: format.mime,
        b64: bytes.toString('base64'), purpose: 'ai-xhs-images', userId: content.creator_id }).row;
      Object.assign(state, { originalFileId: original.id, originalUrl: original.file_url, fileId: original.id, width: format.width, height: format.height });
      outputUrl = original.file_url; removeInlineReceipt(state); persist();
    } else outputUrl = state.originalUrl;
    try {
      const input = imageInput(snapshot);
      const png = await (runtime.renderImage || renderXhsImage)(bytes, { role: state.role, input: { ...input,
        ...(state.role === 'cover' && input.coverLayout === 'collage4' ? { coverLayout: 'photo' } : {}) }, output: imageOutput(snapshot) });
      const file = saveUploadedFile({ name: `小红书-${state.role}-AI创意.png`, mime: 'image/png', b64: png.toString('base64'), purpose: 'ai-xhs-images', userId: content.creator_id }).row;
      Object.assign(state, { fileId: file.id, width: 768, height: 1024, warning: null }); outputUrl = file.file_url;
    } catch { state.warning = '已取回Image2原图；本地排版未完成。此图为AI创意，发布时请标注，不冒充实拍。'; }
    state.status = 'success'; state.error = null; persist();
    // Re-read the original reservation after download. A concurrent refund must
    // never be reversed by a stale recovery closure.
    const currentReceipt = imageReceiptFor(row, state);
    if (!currentReceipt) throw fail('原图片账务绑定已变化，请重新读取任务', 409);
    const hold = currentReceipt.hold;
    const expense = getSupplierExpense(hold.id, curTenant());
    if (hold.status === 'held' && !expense?.refundedAt) {
      const held = { holdId: hold.id, tenantId: hold.tenant_id, userId: hold.user_id, credits: hold.held_credits, kind: hold.kind, model: hold.model };
      const settled = (runtime.settleImage || settleHold)(held, { model: xhsImageModel(), credits: hold.held_credits, usage: verified.receipt.usage || {}, aiMode: 'api' });
      if (!settled) throw fail('已有预授权结算尚待核对', 409);
      state.billing = twoPhaseBillingSummary({ state: 'settled', hold: held, settled, note: '仅取回同一次Image2结果，沿用原预授权结算，没有重新生成或新增预授权。' });
    } else state.billing = imageBilling(row, state);
    state.recoveryStage = 'completed'; state.recoveredAt = new Date().toISOString(); persist();
  } catch {
    state.billing = imageBilling(row, state);
    state.status = outputUrl && state.fileId ? 'success' : 'failed';
    state.error = state.status === 'success' ? null : '同一次图片结果暂未取回，已保留回执；可继续免费取回，不会重新生成或再次收费。';
    state.recoveryStage = 'pending'; persist();
  } finally { activeImages.delete(key); }
}

export function recoverXhsNoteImages({ actor, jobId, imageIds, runtime = {} }) {
  checkRole({ user: actor });
  const content = authorizedRow(jobId, actor), current = imageGeneration(content, json(content.snapshot_json));
  if (!Array.isArray(imageIds) || !imageIds.length || new Set(imageIds).size !== imageIds.length || imageIds.length > current.items.length)
    throw fail('请选择需要恢复的配图');
  if (imageIds.some(id => !current.items.find(item => item.id === id)?.canRecover)) throw fail('只能免费取回已有供应商结果回执的图片；此操作不会重新生成或再次收费', 409);
  const tenant = curTenant(), rows = imageRows(content.id).filter(row => imageIds.includes(json(row.snapshot_json).role));
  const work = runWithTenant(tenant, async () => {
    const queue = [...rows];
    await Promise.allSettled(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) await recoverImageReceipt(queue.shift(), content, runtime);
    }));
    const key = `${tenant}:${content.id}`; activeLayouts.add(key);
    try { await finalizeCollage(content.id, runtime); } finally { activeLayouts.delete(key); }
  });
  work.catch(() => {});
  return publicJob(readRow(content.id));
}

async function finalizeCollage(id, runtime = {}) {
  const content = readRow(id), snapshot = json(content?.snapshot_json);
  if (!content || imageInput(snapshot).coverLayout !== 'collage4') return;
  const rows = imageRows(id), cover = rows.find(row => json(row.snapshot_json).role === 'cover');
  if (!cover || json(cover.snapshot_json).status !== 'success') return;
  const sources = [], hashes = new Set();
  for (const row of [cover, ...rows.filter(row => row.id !== cover.id)]) {
    const state = json(row.snapshot_json);
    if (state.status !== 'success' || !state.originalUrl) continue;
    try {
      const { bytes } = readTenantUploadedFileByUrl({ fileUrl: state.originalUrl });
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (!hashes.has(digest)) { hashes.add(digest); sources.push({ bytes, digest, fileId: state.originalFileId }); }
    } catch { /* unavailable local originals never cause another paid request */ }
    if (sources.length === 4) break;
  }
  const state = json(cover.snapshot_json);
  const sourceHashes = sources.map(source => source.digest);
  if (sources.length < 4) {
    state.layoutStatus = 'waiting_for_images';
    state.warning = '已有封面与成功配图可下载；四宫格需要4张不同的成功素材，暂未拼接，不会复制同一张或额外生成。';
  } else if (state.layoutStatus === 'ready' && JSON.stringify(state.collageSourceHashes) === JSON.stringify(sourceHashes)) return;
  else {
    try {
      const png = await (runtime.renderImage || renderXhsImage)(sources[0].bytes, { role: 'cover', input: imageInput(snapshot), output: imageOutput(snapshot), collageImages: sources.map(source => source.bytes) });
      const file = saveUploadedFile({ name: '小红书-四宫格封面-AI创意.png', mime: 'image/png', b64: png.toString('base64'), purpose: 'ai-xhs-images', userId: content.creator_id }).row;
      Object.assign(state, { fileId: file.id, width: 768, height: 1024, layoutStatus: 'ready', warning: null,
        collageSourceHashes: sourceHashes, collageSourceFileIds: sources.map(source => source.fileId) });
      q.run('UPDATE media_jobs SET url=?,snapshot_json=? WHERE tenant_id=? AND id=?', file.file_url, JSON.stringify(state), curTenant(), cover.id);
      return;
    } catch {
      state.layoutStatus = 'local_layout_failed';
      state.warning = '已保留成功配图和封面；本地四宫格排版暂未完成，不会再次收费生成。';
    }
  }
  q.run('UPDATE media_jobs SET snapshot_json=? WHERE tenant_id=? AND id=?', JSON.stringify(state), curTenant(), cover.id);
}

function textBillingSettled(content, snapshot) {
  const reference = snapshot.billingReference || { refType: 'content', refId: content.id };
  const hold = q.get(`SELECT * FROM credit_holds WHERE tenant_id=? AND user_id=? AND id=? AND ref_type=? AND ref_id=?`,
    curTenant(), content.creator_id, Number(snapshot.billing?.holdId) || 0, reference.refType, reference.refId);
  const ledger = hold && q.get('SELECT credits FROM credit_logs WHERE tenant_id=? AND user_id=? AND id=?', curTenant(), content.creator_id, hold.log_id);
  return snapshot.billing?.state === 'settled' && hold?.status === 'settled' && !!ledger && Number(ledger.credits) === Number(hold.settled_credits);
}

// Both HTTP and the confirmed-chat adapter use this one image-only path. The
// manuscript and creation request remain unchanged; image options are frozen
// separately so later edits cannot silently change an already charged image.
export function startXhsNoteImages({ actor, jobId, requestKey, outputHash, imageCount, coverLayout, includeDiner, runtime = {} }) {
  checkRole({ user: actor });
  if (!imageRoleAllowed(actor.role)) throw fail('当前角色未开通图片生成', 403);
  if (!canDispatchEmployee(actor, { kind: 'crew', idx: 11, group: '内容生产部' })) throw fail(DISPATCH_DENIED_MESSAGE, 403);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestKey || '')) throw fail('配图任务标识无效');
  let content = authorizedRow(jobId, actor), shouldStart = false;
  withImmediateTransaction(db, () => {
    content = readRow(content.id);
    const snapshot = json(content.snapshot_json), output = currentOutput(snapshot);
    if (snapshot.status !== 'success' || !output || !textBillingSettled(content, snapshot)) throw fail('原文案尚未交付或费用待核对', 409);
    if (typeof outputHash !== 'string' || hash(output) !== outputHash) throw fail('文案已变化，请重新确认当前成果后出图', 409);
    const oldInput = imageInput(snapshot);
    const next = normalizeXhsNoteInput({ ...snapshot.input, ...oldInput, generateImages: true,
      imageCount: imageCount ?? oldInput.imageCount ?? 6, coverLayout: coverLayout ?? oldInput.coverLayout ?? 'photo',
      includeDiner: includeDiner ?? oldInput.includeDiner ?? false });
    if (snapshot.imageGeneration?.requestKey) {
      if (snapshot.imageGeneration.requestKey !== requestKey || snapshot.imageGeneration.outputHash !== outputHash || hash(snapshot.imageGeneration.input) !== hash(next))
        throw fail('本任务已确认配图；已有成功图保留，失败图请单独重试', 409);
      return;
    }
    if (imageRows(content.id).length || imageInput(snapshot).generateImages === true) throw fail('本任务已启动配图；失败图请单独重试', 409);
    if (!(runtime.imageAvailable || imageAvailable)()) throw fail('配图通道暂未配置，文案已保留', 503);
    // Verify references before any reservations, including revoked ownership.
    resolveRequestedAttachments(next.fileIds, actor, 6);
    snapshot.imageGeneration = { ...snapshot.imageGeneration, model: xhsImageModel(), providerId: selectedProviderId(), creditsPerImage: estimateMaxCredits('image', xhsImageModel()),
      requestKey, outputHash, outputSnapshot: output, input: next, confirmedAt: new Date().toISOString() };
    q.run('UPDATE contents SET snapshot_json=? WHERE tenant_id=? AND id=?', JSON.stringify(snapshot), curTenant(), content.id);
    ensureImageJobs(content, snapshot, { transaction: true });
    shouldStart = true;
  });
  if (shouldStart) {
    const tenant = curTenant();
    setImmediate(() => runWithTenant(tenant, () => startImages(content.id, runtime)).catch(() => {}));
  }
  return publicJob(readRow(content.id));
}

export function createXhsNoteFromConfirmedChat({ actor, chatEvidence }) {
  checkRole({ user: actor });
  if (!canDispatchEmployee(actor, { kind: 'crew', idx: 11, group: '内容生产部' })) throw fail(DISPATCH_DENIED_MESSAGE, 403);
  const authority = approvedNativeChatPlan({ actor, sessionId: chatEvidence?.sessionId, planVersion: chatEvidence?.planVersion, employeeIdx: 11 });
  const plan = authority.plan;
  const input = normalizeXhsNoteInput({ ...plan.options, brandName: plan.brandName, brief: plan.brief, fileIds: plan.fileIds,
    generateImages: false, requestKey: `chat_${authority.provenance.sessionId}_${authority.provenance.planVersion}` });
  if (!plan.output || typeof plan.output.body !== 'string' || !plan.output.body.trim() || !Array.isArray(plan.output.tags)) throw fail('已确认方案没有可用正文', 409);
  const attachments = resolveRequestedAttachments(input.fileIds, actor, 6);
  if (attachments.some(file => !['png', 'jpg', 'jpeg', 'webp'].includes(String(file.ext).toLowerCase()))) throw fail('请使用PNG、JPG或WebP照片');
  const files = attachments.map(file => ({ id: file.id, name: file.name, file_url: file.url }));
  // Keep the exact approved output; adding a plan in the response must not
  // manufacture a different paid manuscript or a second text invocation.
  const output = plan.output, body = xhsNoteMarkdown(output), risk = scanText(body);
  const skillContext = buildNativeContentSkillContext(11, { tenantId: curTenant(), userId: actor.id });
  return withImmediateTransaction(db, () => {
    const existing = q.get(`SELECT * FROM contents WHERE tenant_id=? AND creator_id=? AND source_type=? AND json_extract(snapshot_json,'$.input.requestKey')=?`, curTenant(), actor.id, XHS_NOTE_SOURCE, input.requestKey);
    if (existing) {
      if (json(existing.snapshot_json).chatProvenance?.planHash !== authority.provenance.planHash) throw fail('已保存方案版本不匹配', 409);
      return publicJob(existing);
    }
    const snapshot = { schemaVersion: 'nanowork.ai-xhs-note/2', status: 'success', decision: 'pending', input, inputHash: hash(input), files, output,
      photoAnalysis: 'vision_model', billing: authority.billing, billingReference: { refType: 'native_chat_message', refId: authority.messageId },
      chatProvenance: authority.provenance, finishedAt: new Date().toISOString(),
      employeeExecution: { identity: skillContext.profile.identity, skills: skillContext.evidence, workflow: 'ai_xhs_note', automaticPublishing: false },
      imageGeneration: { model: xhsImageModel(), providerId: selectedProviderId(), creditsPerImage: estimateMaxCredits('image', xhsImageModel()) } };
    const id = Number(q.run(`INSERT INTO contents(tenant_id,type,title,brand,body,status,ai_mode,creator_id,content_employee_idx,content_employee_key,content_employee_name,content_employee_group,source_type,risk_level,risk_flags,snapshot_json)
      VALUES(?,?,?,?,?,'草稿','api',?,11,'xhs_note','AI小红书种草员','图文种草部',?,?,?,?)`, curTenant(), '小红书种草图文', output.title, input.brandName, body,
    actor.id, XHS_NOTE_SOURCE, risk.level, JSON.stringify(risk.hits), JSON.stringify(snapshot)).lastInsertRowid);
    q.run('UPDATE native_chat_plans SET generation_json=? WHERE tenant_id=? AND user_id=? AND session_id=? AND version=?',
      JSON.stringify({ kind: 'xhs', planVersion: authority.provenance.planVersion, jobId: id, pollUrl: `/content/ai-xhs-note/jobs/${id}` }),
      curTenant(), actor.id, authority.provenance.sessionId, authority.provenance.planVersion);
    return publicJob(readRow(id));
  });
}
function authorizedRow(id, actor) {
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId < 1) throw fail('任务不存在或无权访问', 404);
  const row = readRow(numericId);
  if (!row || Number(actor?.tenant_id) !== Number(curTenant()) || !canAccessOwner(actor, row.creator_id)) throw fail('任务不存在或无权访问', 404);
  return row;
}
function interruptedBilling(row, snapshot) {
  // The ledger, not an interrupted snapshot write, is authoritative. Restrict
  // both the hold and its log to this task's tenant and creator.
  const hold = q.get("SELECT name FROM sqlite_master WHERE type='table' AND name='credit_holds'") && q.get(`SELECT id,log_id,held_credits,status,settled_credits FROM credit_holds
    WHERE tenant_id=? AND user_id=? AND ref_type='content' AND ref_id=?
    ORDER BY id DESC LIMIT 1`, curTenant(), row.creator_id, row.id);
  // A crash before holdCredits cannot have started the provider. A missing log
  // is different: the hold still exists and its charge must be reconciled.
  if (!hold) return twoPhaseBillingSummary({ state: 'released', hold: null,
    note: '生成尚未开始，本次未扣费，可重新生成。' });
  const ledger = q.get('SELECT credits,cost_yuan,balance_after FROM credit_logs WHERE id=? AND tenant_id=? AND user_id=?', hold.log_id, curTenant(), row.creator_id);
  if (hold.status === 'settled' && ledger && Number(hold.settled_credits) === Number(ledger.credits)) {
    const released = !snapshot.output && Number(ledger.credits) === 0;
    return twoPhaseBillingSummary({ state: released ? 'released' : 'settled',
      hold: { holdId: hold.id, credits: hold.held_credits },
      settled: { credits: ledger.credits, costYuan: ledger.cost_yuan,
        balance: q.get('SELECT credits FROM tenants WHERE id=?', curTenant())?.credits ?? ledger.balance_after },
      note: released ? '生成尚未开始，预授权已退回。' : '完整结果已保留，费用已按账务记录确认。' });
  }
  return { ...snapshot.billing, state: 'pending_reconciliation', pendingReconciliation: true,
    holdId: hold.id, chargedCredits: null, credits: null,
    heldCredits: hold.held_credits,
    note: '生成执行已中断，已有内容仍保留；本次费用待核对，不会自动重复生成。' };
}
function publicJob(row) {
  let snapshot = json(row.snapshot_json);
  const key = `${curTenant()}:${row.id}`;
  // A restart never repeats a possibly charged generation. Keep any delivered
  // body; interrupted provider work stays available for billing reconciliation.
  if (snapshot.status === 'running' && !active.has(key)
    && (snapshot.instanceId === instanceId || !Number.isFinite(snapshot.deadline) || Date.now() > snapshot.deadline)) {
    const billing = interruptedBilling(row, snapshot);
    snapshot = { ...snapshot, status: snapshot.output ? 'success' : 'failed',
      error: snapshot.output ? null : billing.state === 'released'
        ? '生成尚未开始，本次未扣费，可重新生成。'
        : '生成服务已中断，未收到完整结果；请先核对本次费用再发起新任务。',
      billing };
    try {
      q.run('UPDATE contents SET status=?,snapshot_json=? WHERE tenant_id=? AND id=?', snapshot.output ? '草稿' : '失败', JSON.stringify(snapshot), curTenant(), row.id);
    } catch {
      // Read access can remain healthy while a write fails. Return the already
      // persisted body and ledger status; the next read can retry this write.
    }
  }
  return { id: row.id, status: snapshot.status, title: row.title, brandName: row.brand,
    output: snapshot.editedOutput || snapshot.output || null, originalOutput: snapshot.output || null,
    brief: snapshot.input?.brief || '', fileIds: snapshot.input?.fileIds || [], files: snapshot.files || [],
    decision: snapshot.decision || 'pending', error: snapshot.error || null,
    billing: snapshot.billing ? { ...snapshot.billing, balance: q.get('SELECT credits FROM tenants WHERE id=?', curTenant())?.credits ?? null } : null,
    includeDiner: imageInput(snapshot).includeDiner === true, generateImages: imageInput(snapshot).generateImages === true,
    imageCount: xhsImageCount(imageInput(snapshot).imageCount, { legacy: true }), style: imageInput(snapshot).style || 'seed', coverLayout: imageInput(snapshot).coverLayout || 'photo',
    outputHash: currentOutput(snapshot) ? hash(currentOutput(snapshot)) : null,
    ...(currentOutput(snapshot) || imageRows(row.id).some(item => item.url) ? { downloadUrl: `/api/content/native-deliverables/xhs/${row.id}/download`, downloadName: `${row.brand || '小红书'}图文包.zip` } : {}),
    imageGeneration: imageGeneration(row, snapshot),
    failure: snapshot.failure || null,
    createdAt: row.created_at, canRetry: snapshot.billing?.state !== 'pending_reconciliation' };
}
function checkRole(req) {
  const flags = getTenantConfig('feature_flags', {});
  if (flags['content.copy'] && !flags['content.copy'].includes(req.user.role)) throw fail('当前角色未开通图文生成', 403);
}

router.get('/ai-xhs-note/options', (req, res) => {
  try {
    checkRole(req);
    const creditsPerImage = estimateMaxCredits('image', xhsImageModel());
    const permitted = imageRoleAllowed(req.user.role);
    const configured = (req.app.locals.aiXhsNoteRuntime?.imageAvailable || imageAvailable)();
    const imageCount = xhsImageCount(req.query.imageCount === undefined ? undefined : Number(req.query.imageCount));
    res.json({ imageModel: xhsImageModel(), imageCount, imageCounts: [6, 9, 12], styles: XHS_STYLES, coverLayouts: XHS_COVER_LAYOUTS, creditsPerImage, imageTotalCredits: creditsPerImage * imageCount,
      textBilling: 'actual_usage', available: permitted && configured,
      reason: !permitted ? '当前角色未开通图片生成，可关闭配图仅生成文案。' : !configured ? '配图通道暂未配置，可先生成文案。' : null });
  } catch (error) { res.status(error.status || 500).json({ error: '暂时无法读取配图报价' }); }
});

router.post('/ai-xhs-note/jobs/:id/retry-images', (req, res) => {
  try {
    checkRole(req);
    if (!imageRoleAllowed(req.user.role)) throw fail('当前角色未开通图片生成', 403);
    if (!canDispatchEmployee(req.user, { kind: 'crew', idx: 11, group: '内容生产部' })) throw fail(DISPATCH_DENIED_MESSAGE, 403);
    const content = authorizedRow(req.params.id, req.user);
    const snapshot = json(content.snapshot_json);
    if (snapshot.status !== 'success' || !snapshot.output || snapshot.billing?.state !== 'settled' || imageInput(snapshot).generateImages !== true)
      throw fail('文案尚未交付或费用待核对，不能重试配图', 409);
    const ids = req.body?.imageIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > imageRoles(snapshot).length || new Set(ids).size !== ids.length
      || ids.some(id => !imageRoles(snapshot).some(role => role.id === id))) throw fail('请选择需要重试的失败配图');
    const current = imageGeneration(content, snapshot);
    if (ids.some(id => !current.items.find(item => item.id === id)?.canRetry)) throw fail('只能重试未扣费或已退回预授权的失败配图；成功和待对账图片不会重复生成', 409);
    const release = req.aiGuard?.defer?.(imageLeaseMs) || (() => {});
    const tenant = curTenant();
    const running = runWithTenant(tenant, () => startImages(content.id, req.app.locals.aiXhsNoteRuntime || {}, ids));
    running.catch(() => {}).finally(release);
    res.status(202).json(publicJob(readRow(content.id)));
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '暂时无法重试配图' }); }
});

router.post('/ai-xhs-note/jobs/:id/images', (req, res) => {
  try {
    const job = startXhsNoteImages({ ...req.body, actor: req.user, jobId: req.params.id, runtime: req.app.locals.aiXhsNoteRuntime || {} });
    res.status(202).json(job);
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '暂时无法启动配图，已有文案仍保留' }); }
});

router.post('/ai-xhs-note/jobs/:id/recover-images', (req, res) => {
  try {
    res.status(202).json(recoverXhsNoteImages({ actor: req.user, jobId: req.params.id, imageIds: req.body?.imageIds, runtime: req.app.locals.aiXhsNoteRuntime || {} }));
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '暂时无法取回图片，已有回执仍保留' }); }
});

router.get('/ai-xhs-note/jobs', (req, res) => {
  try {
    checkRole(req);
    const scope = userScopeClause(req.user, 'creator_id');
    const rows = q.all(`SELECT * FROM contents WHERE tenant_id=? AND source_type=?${scope.sql} ORDER BY id DESC LIMIT 30`, curTenant(), XHS_NOTE_SOURCE, ...scope.params);
    res.json({ jobs: rows.map(publicJob) });
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '暂时无法读取种草任务' }); }
});
router.get('/ai-xhs-note/jobs/:id', (req, res) => {
  try { checkRole(req); res.json(publicJob(authorizedRow(req.params.id, req.user))); }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '暂时无法读取种草任务' }); }
});
router.post('/ai-xhs-note/jobs/:id/decision', (req, res) => {
  try {
    checkRole(req);
    const decision = req.body?.decision;
    if (!['adopted', 'rejected'].includes(decision)) throw fail('请选择采纳或不采纳');
    const row = authorizedRow(req.params.id, req.user);
    const snapshot = json(row.snapshot_json);
    if (snapshot.status !== 'success' || !snapshot.output) throw fail('任务尚未交付内容', 409);
    if (req.body.output !== undefined) {
      const edited = req.body.output;
      if (!edited || typeof edited !== 'object' || Array.isArray(edited)
        || !['title', 'body', 'firstComment'].every(field => typeof edited[field] === 'string')
        || !edited.body.trim() || !Array.isArray(edited.tags) || edited.tags.some(tag => typeof tag !== 'string')
        || JSON.stringify(edited).length > 200000) throw fail('编辑内容格式不正确或超过保存容量');
      snapshot.editedOutput = { ...snapshot.output, title: edited.title, body: edited.body, firstComment: edited.firstComment, tags: edited.tags };
    }
    snapshot.decision = decision;
    snapshot.decidedBy = req.user.id;
    snapshot.decidedAt = new Date().toISOString();
    // User selection is distinct from publishing, risk approval and settlement.
    const output = snapshot.editedOutput || snapshot.output;
    const body = xhsNoteMarkdown(output);
    const risk = scanText(body);
    const usable = snapshot.billing?.state === 'settled' && risk.level === 'none';
    q.run('UPDATE contents SET status=?,title=?,body=?,risk_level=?,risk_flags=?,snapshot_json=? WHERE tenant_id=? AND id=?',
      decision === 'rejected' ? '已驳回' : usable ? '可使用' : '草稿', output.title, body, risk.level, JSON.stringify(risk.hits), JSON.stringify(snapshot), curTenant(), row.id);
    res.json(publicJob(readRow(row.id)));
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '暂时无法保存选择' }); }
});

router.post('/ai-xhs-note', (req, res) => {
  try {
    checkRole(req);
    if (!canDispatchEmployee(req.user, { kind: 'crew', idx: 11, group: '内容生产部' })) {
      throw fail(DISPATCH_DENIED_MESSAGE, 403);
    }
    const actor = { ...req.user }, tenantId = curTenant();
    const input = normalizeXhsNoteInput(req.body);
    if (input.generateImages && !imageRoleAllowed(req.user.role)) throw fail('当前角色未开通图片生成，可关闭配图仅生成文案。尚未发起生成或扣费。', 403);
    const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = q.get(`SELECT * FROM contents WHERE tenant_id=? AND creator_id=? AND source_type=? AND json_extract(snapshot_json,'$.input.requestKey')=?`, tenantId, actor.id, XHS_NOTE_SOURCE, input.requestKey);
    if (existing) {
      if (json(existing.snapshot_json).inputHash !== inputHash) throw fail('这份任务已提交，修改素材后请新建任务', 409);
      return res.status(200).json(publicJob(existing));
    }
    const runtime = req.app.locals.aiXhsNoteRuntime || {};
    if (!(runtime.available || aiAvailable)()) throw fail('请先在模型设置中配置可用的识图生成通道', 503);
    const attachments = resolveRequestedAttachments(input.fileIds, actor, 6);
    if (attachments.some(file => !['png', 'jpg', 'jpeg', 'webp'].includes(String(file.ext).toLowerCase()))) throw fail('请使用PNG、JPG或WebP照片');
    const files = attachments.map(file => ({ id: file.id, name: file.name, file_url: file.url }));
    const images = attachments.map(file => {
      const loaded = readTenantUploadedFileByUrl({ fileUrl: file.url });
      const mime = file.ext === 'jpg' || file.ext === 'jpeg' ? 'image/jpeg' : `image/${file.ext}`;
      return { type: 'image_url', image_url: { url: `data:${mime};base64,${loaded.bytes.toString('base64')}` } };
    });
    const skillContext = buildNativeContentSkillContext(11, { tenantId, userId: actor.id });
    const notes = sanitizeEvolutionNotesForPrompt(activeContentEvolutionNotes(11, { tenantId }));
    const system = [skillContext.prompt, ...evolutionNotesPromptLines(notes), XHS_NOTE_SYSTEM].join('\n\n');
    const prompt = xhsNotePrompt(input, files);
    const model = routing().vision;
    const estimate = (runtime.estimate || estimateCallCredits)({ model, texts: [system, prompt], outputTokens: 6000, overheadTokens: 12000 * files.length });
    let hold, id, duplicateRow;
    let snapshot = { schemaVersion: 'nanowork.ai-xhs-note/2', instanceId, deadline: Date.now() + 360000,
      status: 'running', decision: 'pending', input, inputHash, files, model, photoAnalysis: 'vision_model',
      employeeExecution: { identity: skillContext.profile.identity, skills: skillContext.evidence,
        evolutionNoteIds: notes.map(note => note.id), workflow: 'ai_xhs_note', automaticPublishing: false },
      imageGeneration: { model: xhsImageModel(), providerId: selectedProviderId(), creditsPerImage: estimateMaxCredits('image', xhsImageModel()) },
      promptHash: createHash('sha256').update(`${system}\n${prompt}`).digest('hex') };
    withImmediateTransaction(db, () => {
      const duplicate = q.get(`SELECT * FROM contents WHERE tenant_id=? AND creator_id=? AND source_type=? AND json_extract(snapshot_json,'$.input.requestKey')=?`, tenantId, actor.id, XHS_NOTE_SOURCE, input.requestKey);
      if (duplicate) {
        if (json(duplicate.snapshot_json).inputHash !== inputHash) throw fail('这份任务已提交，修改素材后请新建任务', 409);
        duplicateRow = duplicate;
        return;
      }
      id = Number(q.run(`INSERT INTO contents(tenant_id,type,title,brand,body,status,ai_mode,creator_id,content_employee_idx,content_employee_key,content_employee_name,content_employee_group,source_type,snapshot_json)
        VALUES(?,?,?,?,?,'生成中','api',?,11,'xhs_note','AI小红书种草员','图文种草部',?,?)`,
        tenantId, '小红书种草图文', `${input.brandName}的小红书图文`, input.brandName, '', actor.id, XHS_NOTE_SOURCE, JSON.stringify(snapshot)).lastInsertRowid);
    });
    if (duplicateRow) return res.status(200).json(publicJob(duplicateRow));
    try {
      hold = holdCredits({ userId: actor.id, tenantId, feature: 'AI小红书种草员', kind: 'text', model, credits: estimate, refType: 'content', refId: id });
    } catch (error) {
      q.run('DELETE FROM contents WHERE tenant_id=? AND id=? AND source_type=?', tenantId, id, XHS_NOTE_SOURCE);
      throw error;
    }
    snapshot.billing = twoPhaseBillingSummary({ state: 'held', hold, note: '生成后按实际用量结算' });
    try {
      q.run('UPDATE contents SET snapshot_json=? WHERE tenant_id=? AND id=?', JSON.stringify(snapshot), tenantId, id);
    } catch {
      // No external work has started: release this hold instead of leaving an
      // invisible charge after a receipt-storage failure.
      try { releaseHold(hold, '任务回执保存失败，尚未发起生成'); } catch { /* ledger remains pending */ }
      throw fail('任务回执暂时未能保存，尚未发起生成；请刷新任务核对费用。', 503);
    }
    const activeKey = `${tenantId}:${id}`;
    const releaseAiLease = req.aiGuard?.defer?.(input.generateImages ? imageLeaseMs : 360000) || (() => {});
    active.add(activeKey);
    res.status(202).json(publicJob(readRow(id)));
    setImmediate(() => runWithTenant(tenantId, async () => {
      let invoked = false;
      try {
        await executeHeldDelivery({ hold, externalInvocationStarted: () => invoked,
          generate: async () => {
            invoked = true;
            return (runtime.generate || generate)({ kind: 'content', role: actor.role, model,
              system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images] }],
              maxTokens: 6000, timeoutMs: 300000, providerPolicy: 'yunwu_only', fallback: () => '' });
          },
          persist: result => {
            const output = parseXhsNoteOutput(result, { brandName: input.brandName, files, confirmedDetails: input.brief, input });
            const body = xhsNoteMarkdown(output);
            const risk = scanText(body);
            if (risk.hits.length) output.warnings.push(...risk.hits.map(hit => `发布前请核对：${hit.name}`));
            snapshot = { ...snapshot, output, usage: result.usage, model: result.model, finishReason: result.finishReason };
            q.run('UPDATE contents SET title=?,body=?,risk_flags=?,risk_level=?,snapshot_json=? WHERE tenant_id=? AND id=?', output.title, body, JSON.stringify(risk.hits), risk.level, JSON.stringify(snapshot), tenantId, id);
            return { id };
          },
          settlement: result => ({ model: result.model || model, usage: result.usage, aiMode: result.mode }),
          settle: settleHold, release: releaseHold, refund: refundHold,
          hasDeliverable: () => !!json(readRow(id)?.snapshot_json).output,
          onBillingFinalized: ({ billing }) => {
            snapshot = { ...snapshot, status: 'success', billing };
            q.run("UPDATE contents SET status='草稿',snapshot_json=? WHERE tenant_id=? AND id=?", JSON.stringify(snapshot), tenantId, id);
          },
        });
      } catch (error) {
        // Persistence or billing errors never erase an already saved response.
        const current = readRow(id);
        const saved = json(current?.snapshot_json);
        const output = saved.output || snapshot.output;
        const delivered = !!output;
        const billing = error.billing || saved.billing;
        const failure = xhsNoteFailure(error);
        const feeNote = billing?.state === 'released' ? '预授权已退回'
          : billing?.state === 'settled' ? '费用已结算' : '本次费用待核对';
        snapshot = { ...saved, ...(output ? { output, usage: snapshot.usage, model: snapshot.model } : {}),
          status: delivered ? 'success' : 'failed', billing,
          failure: { code: failure.code, phase: failure.phase },
          error: delivered ? null : `${failure.message}；${feeNote}，已有照片仍保留。` };
        const body = delivered ? xhsNoteMarkdown(output) : current.body;
        const risk = scanText(body || '');
        q.run('UPDATE contents SET status=?,title=?,body=?,risk_level=?,risk_flags=?,snapshot_json=? WHERE tenant_id=? AND id=?',
          delivered ? '草稿' : '失败', output?.title || current.title, body, risk.level, JSON.stringify(risk.hits), JSON.stringify(snapshot), tenantId, id);
      } finally {
        try { await startImages(id, runtime); } finally { active.delete(activeKey); releaseAiLease(); }
      }
    }).catch(() => {
      // A database outage must not produce an unhandled rejection or repeat a
      // paid call. publicJob recovers from the saved response and scoped ledger.
    }));
    return undefined;
  } catch (error) { return res.status(error.status || 500).json({ error: error.status ? error.message : '种草任务暂时无法创建，请稍后重试' }); }
});

export { authorizedRow as authorizedXhsNoteJob, publicJob as publicXhsNoteJob };
export default router;

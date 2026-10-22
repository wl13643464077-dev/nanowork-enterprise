import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { db, q, curTenant, runWithTenant } from '../db.js';
import { generate } from './ai.js';
import { scanText } from './risk.js';
import { canAccessOwner, isManagerRole } from './access.js';
import { billing, holdCredits, settleHold, releaseHold, refundHold, estimateCallCredits } from './credits.js';
import { AI_SALES_VIDEO_EMPLOYEE, AI_SALES_VIDEO_WORKFLOW, normalizeAiSalesVideoBrief } from './ai-sales-video.js';
import { generateAiSalesVideoScript, validateAiSalesVideoScript, wanNativeAudioPrompt, AI_SALES_NATIVE_NARRATION_STYLE, AI_SALES_NATIVE_NARRATION_TIMING } from './ai-sales-video-script.js';
import { approvedNativeChatPlan } from './native-creative-chat-store.js';
import { withImmediateTransaction } from './two-phase-delivery.js';
import {
  buildAiSalesVideoSubtitleCues,
  AI_SALES_VIDEO_SYSTEM_VOICES,
  safeAiSalesVideoVoiceId,
  AI_SALES_VIDEO_TTS_MODEL,
} from './ai-sales-video-voice.js';
import { assertAiSalesVoicedComposerReady, composeAiSalesVideo, runAiSalesMediaCommand } from './video-composer.js';
import { downloadProviderVideoClip, waitForProviderVideo } from './video-provider-download.js';
import { yunwuAvailable, textModelFor, submitAliBailianVideoSegment, queryAliBailianVideoSegment, supplierRequestCost, provider360Active } from './yunwu.js';
import { selectedProviderId, withTaskProvider } from './ai-provider-selection.js';
import { PROVIDER_360_VIDEO_MODEL } from './provider-360.js';
import { listBenchmarkCards } from './content-benchmark-cards.js';
import { activeContentEvolutionNotes } from './employee-evolution.js';
import { buildNativeContentSkillContext } from './native-content-skill-context.js';
import { publicVoicedSalesProgress, voicedSalesDeliveryVerified } from './ai-sales-video-presentation.js';
import { preserveSalesVideoClip } from './ai-sales-video-partials.js';
import { resolveAiSalesVideoDuration } from './ai-sales-video-duration.js';
import { aggregateSupplierCosts } from './provider-cost-receipts.js';
import { prepareAiSalesVideoReferenceFrames } from './ai-sales-video-reference-frames.js';

export const AI_SALES_VOICED_MODEL = 'wan2.6-i2v';
const videoModel = () => provider360Active() ? PROVIDER_360_VIDEO_MODEL : AI_SALES_VOICED_MODEL;
export const aiSalesVoicedModel = videoModel;
const nativeSegmentCount = (duration, model = videoModel()) => model === PROVIDER_360_VIDEO_MODEL ? 1 : duration / 15;
const supportedSalesModel = model => ['wan2.6-i2v', PROVIDER_360_VIDEO_MODEL].includes(model);
const fail = (message, code = 'AI_SALES_VOICED_BLOCKED', status = 409) =>
  Object.assign(new Error(message), { code, status });
// Script/contract errors are produced by our own validators (never raw provider
// bodies); keep a bounded, printable copy so the boss can see why a run failed.
const safeReasonText = value => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, 300);
export function voicedSalesFailureDetail(error) {
  // Only our own script-contract errors are known to be free of provider text.
  if (error?.name !== 'AiSalesVideoScriptError' || error?.blocked !== true) return null;
  const attempts = Array.isArray(error?.attempts) ? error.attempts.slice(0, 3) : [];
  return {
    message: safeReasonText(error?.message).slice(0, 500),
    errors: (Array.isArray(error?.errors) ? error.errors : []).slice(0, 6).map(safeReasonText).filter(Boolean),
    attempts: attempts.map(item => ({ attempt: Number(item?.attempt) || 0, ok: item?.ok === true,
      errors: (Array.isArray(item?.errors) ? item.errors : []).slice(0, 6).map(safeReasonText).filter(Boolean) })),
    lastOutput: String(error?.lastOutput || '').slice(0, 1200),
  };
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const taskId = value => (/^[\p{L}\p{N}_.+^:/-]{1,500}$/u.test(String(value || '')) ? String(value) : null);

export function resolveSalesVoice(user, value) {
  const id = safeAiSalesVideoVoiceId(value);
  if (AI_SALES_VIDEO_SYSTEM_VOICES.some(voice => voice.id === id)) return id;
  const row = q.get(
    `SELECT created_by FROM avatar_voices WHERE tenant_id=? AND provider_voice_id=? AND status='ready' AND billing_status='settled'`,
    curTenant(),
    id,
  );
  if (!row || !canAccessOwner(user, row.created_by))
    throw fail('克隆音色不存在、未结算或无权使用', 'AI_SALES_VIDEO_VOICE_NOT_FOUND', 404);
  return id;
}

export async function voicedSalesVideoOptions(actor, runtime = {}, { durationSeconds = 15 } = {}) {
  const duration = resolveAiSalesVideoDuration(durationSeconds), segmentCount = nativeSegmentCount(duration);
  if (Number(actor.tenant_id) !== Number(curTenant()))
    throw fail('企业上下文不一致', 'AI_SALES_VIDEO_TENANT_CONTEXT_INVALID', 403);
  const blockers = [];
  if ((!runtime.generateFn || !runtime.submitSegment) && !yunwuAvailable()) blockers.push('未配置文本与Wan生成通道');
  let estimatedMaxCredits = null,
    quoteFingerprint = null, durationOptions = [];
  try {
    durationOptions = [15, 30].map(seconds => {
      const quote = salesVideoPriceQuote(textModelFor(actor.role), { durationSeconds: seconds });
      return { durationSeconds: seconds, segmentCount: nativeSegmentCount(seconds), estimatedMaxCredits: quote.maxCredits,
        quoteFingerprint: quote.fingerprint, limits: { text: 2, tts: 0, video: nativeSegmentCount(seconds) } };
    });
    const quote = salesVideoPriceQuote(textModelFor(actor.role), { durationSeconds: duration });
    estimatedMaxCredits = quote.maxCredits;
    quoteFingerprint = quote.fingerprint;
  } catch {
    blockers.push('组合任务价目尚未配置完整');
  }
  try {
    await (runtime.mediaReady
      ? runtime.mediaReady()
      : assertAiSalesVoicedComposerReady({ audioMode: 'provider_native', durationSeconds: duration }));
  } catch {
    blockers.push('本机音视频工具尚未就绪');
  }
  return {
    model: videoModel(),
    audioMode: 'provider_native',
    voices: [],
    subtitleTiming: 'script_estimated',
    narrationStyle: AI_SALES_NATIVE_NARRATION_STYLE,
    narrationTiming: AI_SALES_NATIVE_NARRATION_TIMING,
    subtitleNotice: '保留模型原生成声音；字幕按脚本分句估时，未经过逐字语音识别，请预览核对。',
    blockers,
    ready: blockers.length === 0,
    estimatedMaxCredits,
    quoteFingerprint,
    durationSeconds: duration,
    segmentCount,
    durationOptions,
    limits: { text: 2, tts: 0, video: segmentCount },
    canRecover: isManagerRole(actor),
    note: '先预占参考费用，按上游实际扣款结算，多退少补；费用待核时保留生成结果。',
  };
}

export function salesVideoPriceQuote(textModel, options = {}) {
  return buildSalesVideoPriceQuote(textModel, { ...options, durationSeconds: resolveAiSalesVideoDuration(options.durationSeconds) });
}
function buildSalesVideoPriceQuote(textModel, { audioMode = 'provider_native', confirmedChat = false, durationSeconds = 30, legacy = false, priceBilling = null, model = videoModel() } = {}) {
  const duration = resolveAiSalesVideoDuration(durationSeconds), segmentCount = nativeSegmentCount(duration, model);
  const externalTts = audioMode === 'external_tts';
  if (externalTts && duration !== 30) throw fail('历史独立配音只恢复原30秒任务');
  if (!externalTts && audioMode !== 'provider_native') throw fail('音频模式不正确');
  const b = priceBilling || billing(),
    textPrice = b.text[textModel],
    video = Number(b.video[model]) * (model === PROVIDER_360_VIDEO_MODEL ? duration / 15 : 1),
    tts = externalTts ? Number(b.tts[AI_SALES_VIDEO_TTS_MODEL]) : 0;
  if (
    !textPrice ||
    ![Number(textPrice.in), Number(textPrice.out), video, tts, b.marginMultiplier, b.creditYuan].every(
      Number.isFinite,
    ) ||
    Number(textPrice.in) < 0 ||
    !(Number(textPrice.out) > 0) ||
    !(video > 0) ||
    (externalTts && !(tts > 0)) ||
    !(b.marginMultiplier > 0) ||
    !(b.creditYuan > 0)
  )
    throw fail(externalTts ? '文本、配音或Wan模型尚未配置有效价格' : '文本或Wan模型尚未配置有效价格');
  const prices = {
    ...(!legacy ? { durationSeconds: duration, segmentCount } : {}),
    ...(confirmedChat ? { confirmedChat: true } : {}),
    ...(!externalTts ? { audioMode } : {}),
    textModel,
    text: { in: Number(textPrice.in), out: Number(textPrice.out) },
    video,
    tts,
    margin: b.marginMultiplier,
    creditYuan: b.creditYuan,
  };
  const textMax = estimateCallCredits({
    model: textModel,
    texts: ['x'.repeat(30000)],
    outputTokens: 1800,
    overheadTokens: 2000,
    b,
  });
  return {
    ...prices,
    fingerprint: digest(prices),
    maxCredits:
      textMax * (confirmedChat ? 0 : externalTts ? 3 : 2) + Math.ceil(((video * segmentCount + tts * 3) * b.marginMultiplier) / b.creditYuan),
  };
}

export function voicedSalesSettlement(plan) {
  const duration = resolveAiSalesVideoDuration(plan?.durationSeconds, 30), segmentCount = nativeSegmentCount(duration, plan?.model);
  const audioMode = plan?.audioMode ?? 'external_tts';
  const externalTts = audioMode === 'external_tts';
  const confirmedChat = !!plan?.approvedChat;
  if (confirmedChat) {
    const approval = approvedNativeChatPlan({ actor: { id: plan.approvedChat.userId, tenant_id: plan.approvedChat.tenantId },
      sessionId: plan.approvedChat.sessionId, planVersion: plan.approvedChat.planVersion, employeeIdx: 10 });
    if (externalTts || (approval.plan.options?.durationSeconds ?? 30) !== duration || digest(approval.plan.script) !== digest(plan.script) || approval.provenance.planHash !== plan.approvedChat.planHash)
      throw fail('已确认脚本与执行版本不一致', 'AI_SALES_VIDEO_CONFIRMED_SCRIPT_MISMATCH');
  }
  if (!externalTts && audioMode !== 'provider_native') throw fail('原任务音频模式不正确');
  const price = plan?.priceQuote,
    events = plan?.paidExecution;
  const legacy = price?.durationSeconds === undefined;
  if (legacy && duration !== 30) throw fail('旧报价只能用于原30秒任务', 'AI_SALES_VIDEO_RECOVERY_PRICE_CHANGED');
  // Compare against the price accepted when this hold was created. An admin
  // changing tomorrow's rates must not invalidate today's completed video.
  const heldPrice = plan.billing?.holdId ? q.get("SELECT pricing_snapshot_json FROM credit_holds WHERE tenant_id=? AND id=? AND kind='video' AND model=?", curTenant(), plan.billing.holdId, plan.model) : null;
  let priceBilling = null;
  if (heldPrice?.pricing_snapshot_json) {
    try { priceBilling = JSON.parse(heldPrice.pricing_snapshot_json); } catch { throw fail('原预授权价格快照无法核验'); }
    if (priceBilling?.version !== 1) throw fail('原预授权价格版本无法核验');
  }
  const currentQuote = price ? buildSalesVideoPriceQuote(price.textModel, { audioMode, confirmedChat, durationSeconds: duration, legacy, priceBilling, model: plan.model }) : null;
  if (
    !price ||
    !Array.isArray(events) ||
    !supportedSalesModel(plan.model) ||
    currentQuote.fingerprint !== price.fingerprint
  )
    throw fail('原任务报价不完整或价目已变化，需人工对账', 'AI_SALES_VIDEO_RECOVERY_PRICE_CHANGED');
  if (
    ['durationSeconds', 'segmentCount', 'audioMode', 'textModel', 'video', 'tts', 'margin', 'creditYuan', 'maxCredits'].some(
      key => price[key] !== currentQuote[key],
    ) ||
    price.text?.in !== currentQuote.text.in ||
    price.text?.out !== currentQuote.text.out
  )
    throw fail('原任务报价内容与签名不一致', 'AI_SALES_VIDEO_RECOVERY_PRICE_CHANGED');
  const byKind = kind => events.filter(event => event?.kind === kind);
  const textEvents = byKind('text'),
    ttsEvents = byKind('tts'),
    videoEvents = byKind('video');
  if (
    (confirmedChat ? textEvents.length !== 0 : textEvents.length < 1) ||
    textEvents.length > (externalTts ? 3 : 2) ||
    (externalTts ? ttsEvents.length < 2 || ttsEvents.length > 3 : ttsEvents.length !== 0) ||
    videoEvents.length !== segmentCount ||
    plan.providerExecution?.segments?.length !== segmentCount ||
    events.length !== textEvents.length + ttsEvents.length + videoEvents.length ||
    events.some((event, i) => event.id !== i + 1 || event.status !== 'returned') ||
    textEvents.some(
      event =>
        event.model !== price.textModel ||
        !Number.isSafeInteger(event.inputTokens) ||
        event.inputTokens <= 0 ||
        !Number.isSafeInteger(event.outputTokens) ||
        event.outputTokens <= 0,
    ) ||
    ttsEvents.some(event => event.model !== AI_SALES_VIDEO_TTS_MODEL) ||
    videoEvents.some(
      (event, i) =>
        event.model !== plan.model ||
        event.index !== i + 1 ||
        !taskId(event.taskId) ||
        event.taskId !== plan.providerExecution?.segments?.[i]?.taskId,
    ) ||
    new Set(videoEvents.map(event => event.taskId)).size !== segmentCount
  )
    throw fail('原任务调用/用量证据不完整，不能自动对账', 'AI_SALES_VIDEO_RECOVERY_BILLING_UNVERIFIED');
  const personalBilling = priceBilling?.billingMode === 'personal';
  const requiresReceipts = personalBilling || priceBilling?.supplierCostPolicy?.enabled === true
    || events.some(event => event.supplierCosts?.length);
  const supplierCosts = requiresReceipts ? events.flatMap(event => event.supplierCosts?.length
    ? event.supplierCosts : [{ status: 'pending', requestId: event.providerRequestId || null, model: event.model }]) : [];
  const actual = aggregateSupplierCosts(supplierCosts);
  const referencePricing = priceBilling?.salePolicy?.basis === 'reference_360';
  const referenceYuan = actualCost(events, price);
  const yuan = actual?.status === 'known' ? actual.costYuanOverride : personalBilling || referencePricing ? undefined : referenceYuan;
  const credits = personalBilling ? 0 : Math.ceil(((referencePricing ? referenceYuan : yuan) * price.margin) / price.creditYuan);
  const walletPricing = priceBilling?.supplierCostPolicy?.basis === 'upstream_debit';
  if (!Number.isSafeInteger(credits) || credits < 0 || (credits > price.maxCredits && !walletPricing))
    throw fail('实际费用不在原预授权范围内', 'AI_SALES_VIDEO_RECOVERY_BILLING_UNVERIFIED');
  const usage = textEvents.reduce(
    (a, event) => ({
      inputTokens: a.inputTokens + event.inputTokens,
      outputTokens: a.outputTokens + event.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
  if (supplierCosts.length) usage.supplierCosts = supplierCosts;
  return {
    credits,
    ...(yuan !== undefined ? { costYuanOverride: yuan } : {}),
    ...(actual?.status === 'known' ? { costSource: actual.costSource } : {}),
    usage,
    model: plan.model,
    note: externalTts
      ? '独白/配音/Wan实际调用组合结算，未使用的授权差额退回'
      : '脚本与Wan原生有声视频实际调用结算，无独立TTS费用，未使用的授权差额退回',
  };
}

// Recheck only saved request IDs. This never submits another paid generation.
export async function refreshVoicedSalesReceipts(plan, readCost = supplierRequestCost) {
  const hold = plan.billing?.holdId ? q.get('SELECT pricing_snapshot_json FROM credit_holds WHERE tenant_id=? AND id=?', curTenant(), plan.billing.holdId) : null;
  let required = false;
  try { required = JSON.parse(hold?.pricing_snapshot_json || '{}').supplierCostPolicy?.enabled === true; } catch { return; }
  for (const event of plan.paidExecution || []) {
    if (event.status !== 'returned' || (!required && !event.supplierCosts?.length)) continue;
    if (event.supplierCosts?.length && event.supplierCosts.every(cost => cost.status === 'known')) continue;
    const requestId = event.providerRequestId || event.supplierCosts?.find(cost => cost.requestId)?.requestId;
    if (!requestId) continue;
    const receipt = await readCost({ requestId, model: event.model, providerId: event.providerId || plan.providerId });
    if (receipt) event.supplierCosts = [receipt];
  }
}

function actualCost(events, price) {
  return events.reduce((sum, event) => {
    if (event.status !== 'returned') throw fail('调用缺少返回证据，保留待对账');
    if (event.kind === 'text')
      return sum + (event.inputTokens * price.text.in + event.outputTokens * price.text.out) / 1e6;
    return sum + (event.kind === 'tts' ? price.tts : price.video);
  }, 0);
}

// Locally decode and normalize each authorized reference before paid work. No
// ffmpeg network protocols or original local paths are exposed to the vendor.

/** The caller supplies resolved attachments and tenant-scoped grounding, never
 * body-provided facts/cards/notes. Runtime seams exist only on app.locals. */
export async function createVoicedSalesVideoJob({
  durationSeconds = 15,
  actor,
  brief,
  references,
  providerImages,
  grounding,
  audience = '',
  quoteFingerprint,
  approvedChat = null,
  runtime = {},
}) {
  const duration = resolveAiSalesVideoDuration(durationSeconds), segmentCount = nativeSegmentCount(duration);
  const segmentDuration = duration / segmentCount;
  const tenantId = curTenant(),
    textModel = textModelFor(actor.role);
  if (Number(actor.tenant_id) !== Number(tenantId))
    throw fail('视频租户上下文不一致', 'AI_SALES_VIDEO_TENANT_CONTEXT_INVALID', 403);
  const approval = approvedChat ? approvedNativeChatPlan({ actor, sessionId: approvedChat.sessionId, planVersion: approvedChat.planVersion, employeeIdx: 10 }) : null;
  if (approval) {
    if ((approval.plan.options?.durationSeconds ?? 30) !== duration) throw fail('所选时长与已确认方案不一致', 'AI_SALES_VIDEO_CONFIRMED_SCRIPT_MISMATCH');
    const checked = validateAiSalesVideoScript(approval.plan.script, { pack: approval.plan.grounding?.storeFacts, scanText: runtime.scanText || scanText, durationSeconds: duration });
    if (!checked.ok || digest(checked.script) !== digest(approval.plan.script)) throw fail('已确认脚本未通过事实与安全核验', 'AI_SALES_VIDEO_CONFIRMED_SCRIPT_INVALID');
    if (brief !== approval.plan.brief || digest(references.map(ref => Number(ref.id))) !== digest(approval.plan.fileIds)) throw fail('素材或需求与确认版本不一致', 'AI_SALES_VIDEO_CONFIRMED_SCRIPT_MISMATCH');
    grounding = approval.plan.grounding;
    const existing = q.get("SELECT id,snapshot_json FROM media_jobs WHERE tenant_id=? AND user_id=? AND json_extract(snapshot_json,'$.approvedChat.sessionId')=? AND json_extract(snapshot_json,'$.approvedChat.planVersion')=?", tenantId, actor.id, approval.provenance.sessionId, approval.provenance.planVersion);
    if (existing) return { response: { jobId: existing.id, pollUrl: `/content/media-jobs/${existing.id}`, salesVideo: publicVoicedSalesProgress(JSON.parse(existing.snapshot_json), tenantId) }, run: null };
  }
  const cleanBrief = normalizeAiSalesVideoBrief(brief);
  if (!providerImages.length || providerImages.length > 6)
    throw fail('请提供1–6张参考图', 'AI_SALES_VIDEO_FRAME_INVALID', 400);
  if (quoteFingerprint !== undefined && quoteFingerprint !== salesVideoPriceQuote(textModel, { confirmedChat: !!approval, durationSeconds: duration }).fingerprint)
    throw fail('报价已变化，请关闭并重新打开面板确认预授权上限；未占扣', 'AI_SALES_VIDEO_QUOTE_CHANGED');
  const skillContext = buildNativeContentSkillContext(10, { tenantId, userId: actor.id,
    nativeVideoContext: { durationSeconds: duration, referenceCount: providerImages.length } });
  const plan = {
    workflow: AI_SALES_VIDEO_WORKFLOW,
    voiceMode: 'voiced',
    audioMode: 'provider_native',
    subtitleTiming: 'script_estimated',
    employee: { ...AI_SALES_VIDEO_EMPLOYEE },
    narrationStyle: AI_SALES_NATIVE_NARRATION_STYLE,
    narrationTiming: AI_SALES_NATIVE_NARRATION_TIMING,
    model: videoModel(),
    providerId: selectedProviderId(),
    durationSeconds: duration,
    segmentDurationSeconds: segmentDuration,
    segmentCount,
    brief: cleanBrief,
    phase: 'preflight',
    scriptMode: 'pending',
    script: null,
    segments: Array.from({ length: segmentCount }, (_, i) => i + 1).map(index => ({
      index,
      durationSeconds: segmentDuration,
      status: 'planned',
    })),
    references: references.map((ref, i) => ({
      id: Number(ref.id) || null,
      name: String(ref.name || `参考图${i + 1}`).slice(0, 200),
      contentSha256: digest(providerImages[i]),
    })),
    employeeExecution: {
      ...skillContext.profile,
      appliedSkills: skillContext.evidence,
      selectedRuntime: {
        workflow: AI_SALES_VIDEO_WORKFLOW,
        model: videoModel(),
        textModel,
        audioMode: 'provider_native',
        subtitleTiming: 'script_estimated',
        automaticPublishing: false,
      },
    },
    grounding: grounding.evidence,
    storeFactSnapshot: grounding.storeFacts || { facts: [] },
    paidExecution: [],
    ...(approval ? { approvedChat: approval.provenance } : {}),
    providerExecution: {
      invocationStarted: false,
      invocationCount: 0,
      segments: Array.from({ length: segmentCount }, (_, i) => i + 1).map(index => ({
        index,
        durationSeconds: segmentDuration,
        status: 'planned',
        taskId: null,
      })),
    },
    billing: {
      state: 'not_held',
      heldCredits: 0,
      chargedCredits: 0,
      pendingReconciliation: false,
    },
  };
  const inserted = withImmediateTransaction(db, () => {
    const result = q.run(
    `INSERT INTO media_jobs(user_id,kind,model,prompt,status,content_employee_idx,content_employee_key,content_employee_name,content_employee_group,content_run_mode,profile_version,prompt_hash,snapshot_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    actor.id,
    'video',
    plan.model,
    `AI有声带货：${cleanBrief}`.slice(0, 500),
    '阻塞',
    10,
    'commerce_video',
    'AI带货员',
    '商业视频工坊',
    AI_SALES_VIDEO_WORKFLOW,
    'ai_sales_video.native_audio.v4',
    digest(cleanBrief),
    JSON.stringify(plan),
  );
    if (approval) q.run('UPDATE native_chat_plans SET generation_json=? WHERE tenant_id=? AND session_id=? AND version=?',
      JSON.stringify({ kind: 'video', planVersion: approval.provenance.planVersion, jobId: Number(result.lastInsertRowid), pollUrl: `/content/media-jobs/${result.lastInsertRowid}` }),
      tenantId, approval.provenance.sessionId, approval.provenance.planVersion);
    return result;
  });
  const jobId = Number(inserted.lastInsertRowid),
    pollUrl = `/content/media-jobs/${jobId}`;
  let workDir, binaries, images, quote, hold;
  let savedSnapshot = JSON.stringify(plan);
  const runner = runtime.runner || runAiSalesMediaCommand;
  const persist = (status, error = null, url = null, credits = null, expected = '处理中') => {
    plan.status = status;
    plan.providerExecution.updatedAt = new Date().toISOString();
    const nextSnapshot = JSON.stringify(plan);
    const result = q.run(
      `UPDATE media_jobs SET status=?,error=?,url=?,credits=?,snapshot_json=? WHERE tenant_id=? AND id=? AND status=? AND snapshot_json=?`,
      status,
      error,
      url,
      credits,
      nextSnapshot,
      tenantId,
      jobId,
      expected,
      savedSnapshot,
    );
    if (result.changes !== 1) throw fail('有声带货执行状态未成功落库', 'AI_SALES_VIDEO_STATE_CONFLICT');
    savedSnapshot = nextSnapshot;
  };
  try {
    if ((!runtime.generateFn || !runtime.submitSegment) && !yunwuAvailable())
      throw fail('未配置真实文本/Wan通道，未调用收费服务');
    quote = salesVideoPriceQuote(textModel, { confirmedChat: !!approval, durationSeconds: duration });
    binaries = runtime.mediaReady
      ? await runtime.mediaReady()
      : await assertAiSalesVoicedComposerReady({
          audioMode: 'provider_native',
          durationSeconds: duration,
        });
    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nw-voiced-sales-'));
    const preparedReferences = await (runtime.prepareImages || prepareAiSalesVideoReferenceFrames)(
      providerImages, workDir, binaries, runner, { sizingMode: plan.model === PROVIDER_360_VIDEO_MODEL && providerImages.length > 1 ? 'preserve_aspect' : 'portrait_first_frame' });
    // Runtime seams may return the historical array. Production also persists
    // the exact original/prepared geometry and hashes before any paid call.
    images = Array.isArray(preparedReferences) ? preparedReferences : preparedReferences.images;
    if (!Array.isArray(preparedReferences)) plan.referencePreparation = preparedReferences.metadata;
    if (salesVideoPriceQuote(textModel, { confirmedChat: !!approval, durationSeconds: duration }).fingerprint !== quote.fingerprint)
      throw fail('检查期间报价发生变化，请重新确认预授权上限；未占扣', 'AI_SALES_VIDEO_QUOTE_CHANGED');
    const cards = listBenchmarkCards(tenantId, {
      verifiedOnly: true,
      limit: 3,
    });
    const notes = activeContentEvolutionNotes(10, { tenantId });
    plan.learning = {
      benchmarkCardIds: cards.map(card => card.id),
      evolutionNoteIds: notes.map(note => note.id),
      skillRevision: skillContext.evidence.revision,
      learnedSkillIds: skillContext.evidence.learnedSkillIds,
      customSkillIds: skillContext.evidence.customSkillIds,
      skillPromptHash: skillContext.evidence.promptHash,
    };
    plan.priceQuote = quote;
    hold = holdCredits({
      userId: actor.id,
      feature: `AI带货员·有声${duration}秒成片`,
      kind: 'video',
      model: plan.model,
      credits: quote.maxCredits,
      refType: 'media_job',
      refId: jobId,
      note: approval ? `复用已确认且已结算脚本，仅生成原生有声${segmentDuration}秒${segmentCount}段，不重复收取文字费` : `文本最多2次、原生有声${segmentDuration}秒最多${segmentCount}段的预授权，无独立TTS`,
    });
    plan.billing = {
      state: 'held',
      heldCredits: hold.credits,
      chargedCredits: null,
      holdId: Number(hold.holdId),
      pendingReconciliation: false,
    };
    plan.phase = 'queued';
    persist('处理中', null, null, null, '阻塞');
    const run = () =>
      runWithTenant(tenantId, () => withTaskProvider(plan, async () => {
        // Claim once before any external action. Repeated/late invocations cannot
        // submit duplicate paid jobs, including a restarted browser poll.
        const current = q.get(
          'SELECT status,snapshot_json FROM media_jobs WHERE tenant_id=? AND id=?',
          tenantId,
          jobId,
        );
        if (current?.status !== '处理中' || JSON.parse(current.snapshot_json).workerStarted) return;
        plan.workerStarted = true;
        let delivered = null;
        try {
          persist('处理中');
          const begin = (kind, model, index) => {
            if (!['text', 'video'].includes(kind)) throw fail('原生音画同生不调用独立TTS');
            const limit = kind === 'video' ? segmentCount : 2;
            if (plan.paidExecution.filter(e => e.kind === kind).length >= limit) throw fail('供应商调用超过授权次数');
            const event = {
              id: plan.paidExecution.length + 1,
              kind,
              model, providerId: plan.providerId,
              index,
              status: 'started',
              startedAt: new Date().toISOString(),
            };
            plan.paidExecution.push(event);
            plan.phase = kind === 'text' ? 'script' : 'video';
            plan.providerExecution.invocationStarted = true;
            persist('处理中'); // durable intent BEFORE invocation
            return event;
          };
          const textFn = async params => {
            if (
              params.system.length + params.userMsg.length + JSON.stringify(params.responseSchema || {}).length >
                30000 ||
              params.maxTokens > 1800
            )
              throw fail('文本调用超过组合预授权输入上限');
            const event = begin('text', textModel, params.kind);
            const result = await (runtime.generateFn || generate)(params);
            const usage = result?.usage;
            if (
              result?.mode !== 'api' ||
              String(result.model).toLowerCase() !== textModel.toLowerCase() ||
              !Number.isSafeInteger(usage?.inputTokens) ||
              !Number.isSafeInteger(usage?.outputTokens) ||
              usage.inputTokens <= 0 ||
              usage.outputTokens <= 0
            )
              throw fail('脚本供应商缺少真实模型/用量证据，保留待对账');
            Object.assign(event, {
              status: 'returned',
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              ...(usage.supplierCosts ? { supplierCosts: usage.supplierCosts } : {}),
            });
            persist('处理中');
            return result;
          };
          const context = {
            durationSeconds: duration,
            brief: cleanBrief,
            storeFacts: grounding.storeFacts,
            storeFactsPrompt: grounding.storeFactsPrompt,
            promptContext: grounding.promptContext,
            benchmarkCards: cards,
            evolutionNotes: notes,
            skillPrompt: skillContext.prompt,
            audience: String(audience).slice(0, 120),
            model: textModel,
            role: actor.role,
            generateFn: textFn,
            scanText: runtime.scanText || scanText,
          };
          const generated = approval ? { script: approval.plan.script, warnings: approval.plan.warnings || [] } : await generateAiSalesVideoScript(context);
          plan.scriptMode = 'model';
          plan.script = generated.script;
          plan.scriptWarnings = generated.warnings || [];
          persist('处理中');
          plan.voiceScriptSha256 = digest(plan.script);
          persist('处理中');
          const clips = [],
            submittedSegments = [];
          let providerError = null;
          const providerShots = plan.model === PROVIDER_360_VIDEO_MODEL ? [{
            ...plan.script.shots[0],
            visual: plan.script.shots.map(shot => `${shot.start}–${shot.end}秒：${shot.visual}`).join('\n'),
            voiceover: plan.script.shots.map(shot => shot.voiceover).join(''),
          }] : plan.script.shots;
          for (const [i, shot] of providerShots.entries()) {
            const segment = plan.providerExecution.segments[i];
            segment.status = 'submitting';
            const event = begin('video', plan.model, i + 1);
            try {
            const submitted = await (runtime.submitSegment || submitAliBailianVideoSegment)({
              model: plan.model,
              duration: segmentDuration,
              resolution: '720P',
              promptExtend: false,
              images: plan.model === PROVIDER_360_VIDEO_MODEL ? images : [images[i % images.length]],
              // Omit audio_url: Wan generates its own speech and sound with the video.
              prompt: wanNativeAudioPrompt(shot, { durationSeconds: duration, segmentDurationSeconds: segmentDuration, singleGeneration: plan.model === PROVIDER_360_VIDEO_MODEL }),
            });
            segment.taskId = taskId(submitted.taskId);
            if (!segment.taskId) throw fail('Wan未返回可持久化任务ID');
            event.taskId = segment.taskId;
            event.providerRequestId = submitted.providerRequestId || null;
            event.durationSeconds = segmentDuration;
            if (submitted.supplierCosts?.length) event.supplierCosts = submitted.supplierCosts;
            event.status = 'returned';
            segment.status = 'provider_submitted';
            plan.providerExecution.invocationCount += 1;
            persist('处理中');
            submittedSegments.push(submitted);
            } catch (error) {
              event.failure = { code: String(error?.code || 'PROVIDER_SUBMISSION_UNKNOWN'),
                phase: error?.providerResponsePhase || 'request', responseStatus: error?.responseStatus || null,
                requestId: error?.providerRequestId || null };
              providerError = error;
              persist('处理中');
              break; // Never repeat an uncertain paid POST. Retrieve known tasks below.
            }
          }
          for (const [i, segment] of plan.providerExecution.segments.entries()) {
            const submitted = submittedSegments[i];
            if (!segment.taskId || !submitted) continue;
            try {
            const ready = submitted.url
              ? submitted
              : await waitForProviderVideo({
                  taskId: segment.taskId,
                  model: plan.model,
                  query: async params => {
                    const result = await (runtime.querySegment || queryAliBailianVideoSegment)(params);
                    persist('处理中'); // heartbeat; polling must not look like an abandoned paid job
                    return result;
                  },
                  timeoutMs: runtime.timeoutMs || 12 * 60 * 1000,
                  intervalMs: runtime.intervalMs || 5000,
                  sleep: runtime.sleep,
                });
            const paidEvent = plan.paidExecution.find(event => event.kind === 'video' && event.index === i + 1);
            if (paidEvent && ready.supplierCosts?.some(cost => cost.status === 'known')) {
              paidEvent.supplierCosts = ready.supplierCosts;
              persist('处理中');
            }
            const clip = await (runtime.downloadSegment || downloadProviderVideoClip)({
              url: ready.url,
              outputDir: workDir,
              index: i + 1,
              fetchImpl: runtime.fetchImpl,
            });
            clips.push(clip.path || clip.absolutePath);
            const supplierCost = ready.supplierCosts?.find(cost => cost.status === 'known')
              || paidEvent?.supplierCosts?.find(cost => cost.status === 'known')
              || await (runtime.supplierRequestCost || supplierRequestCost)({ requestId: paidEvent?.providerRequestId, model: plan.model });
            if (supplierCost && paidEvent) paidEvent.supplierCosts = [supplierCost];
            segment.status = 'downloaded';
            try {
              const partial = await preserveSalesVideoClip({ clip, tenantId, jobId, index: i + 1, binaries, runner });
              plan.partialResults = [...(plan.partialResults || []).filter(item => item.index !== i + 1), partial];
            } catch {
              // A failed optional preview must not discard footage still usable by the composer.
              segment.partialSaveFailed = true;
            }
            persist('处理中');
            } catch (error) { providerError ||= error; }
          }
          if (providerError) throw providerError;
          const subtitleCues = buildAiSalesVideoSubtitleCues({
            script: plan.script,
            timing: plan.narrationTiming,
            durationSeconds: duration,
          });
          plan.phase = 'compose';
          persist('处理中');
          delivered = await (runtime.compose || composeAiSalesVideo)({
            ...binaries,
            tenantId,
            segments: clips,
            audioMode: 'provider_native',
            targetDurationSeconds: duration,
            subtitleCues,
            requireAudio: true,
          });
          if (!voicedSalesDeliveryVerified(delivered, tenantId, plan.audioMode, duration))
            throw fail(`合成器未返回可核验的${duration}秒有声字幕成片`);
          plan.result = {
            url: delivered.url,
            durationSeconds: delivered.durationSeconds,
            sha256: delivered.sha256,
            audioVerified: true,
            subtitlesBurnedIn: true,
            subtitleCount: subtitleCues.length,
            audioVerification: delivered.audioVerification || [],
            audioSource: delivered.audioSource,
            ...(delivered.nativeAudioLevel ? { nativeAudioLevel: delivered.nativeAudioLevel } : {}),
            subtitleTiming: 'script_estimated',
            ...(delivered.transition ? { transition: delivered.transition } : {}),
          };
          plan.segments = plan.script.shots.map(shot => ({
            index: shot.index,
            durationSeconds: 15,
            title: shot.visual,
            voiceover: shot.voiceover,
            status: 'composed',
          }));
          persist('成功', null, delivered.url);
          await refreshVoicedSalesReceipts(plan, runtime.supplierRequestCost || supplierRequestCost);
          persist('成功', null, delivered.url, null, '成功');
          const settlement = voicedSalesSettlement(plan);
          const settled = settleHold(hold, settlement);
          if (!settled) throw fail('组合账务未成功结算');
          plan.billing = {
            ...plan.billing,
            state: 'settled',
            chargedCredits: settled.credits,
            pendingReconciliation: false,
            costYuan: settled.costYuan,
            supplierCostStatus: settled.supplierCostStatus,
          };
          plan.phase = 'complete';
          persist('成功', null, delivered.url, settled.credits, '成功');
        } catch (error) {
          const hasPaid = plan.paidExecution.length > 0;
          let released = false;
          const row = q.get('SELECT status,url,snapshot_json FROM media_jobs WHERE tenant_id=? AND id=?', tenantId, jobId);
          // A late worker cannot refund a replacement worker's active task.
          if (!row || row.snapshot_json !== savedSnapshot) return;
          const hasDeliverable = row?.status === '成功' && !!row.url;
          if (!hasDeliverable) {
            try {
              if (hasPaid) {
                const refundOptions = { note: '带货视频最终失败且无完整成片，积分全退，供应商成本由平台承担',
                    assertRefundable: () => {
                      const owned = q.get('SELECT snapshot_json FROM media_jobs WHERE tenant_id=? AND id=?', tenantId, jobId);
                      if (owned?.snapshot_json !== savedSnapshot) throw fail('任务已由其他执行者接管，不调整账本', 'AI_SALES_VIDEO_STATE_CONFLICT');
                      return true;
                    } };
                let knownCost = {};
                try {
                  const actual = voicedSalesSettlement(plan);
                  if (actual.costSource && Number.isFinite(actual.costYuanOverride))
                    knownCost = { supplierCostYuan: actual.costYuanOverride, costSource: actual.costSource };
                } catch { /* Missing or inconsistent cost evidence must not block the full refund. */ }
                try { released = Boolean(refundHold(hold, { ...refundOptions, ...knownCost })); }
                catch (costError) {
                  if (!knownCost.costSource) throw costError;
                  released = Boolean(refundHold(hold, refundOptions));
                }
              } else released = Boolean(releaseHold(hold, '供应商调用前失败，全额退回'));
            } catch {
              /* reconciliation */
            }
          }
          plan.billing = {
            ...plan.billing,
            state: released ? 'released' : 'pending_reconciliation',
            chargedCredits: released ? 0 : null,
            pendingReconciliation: !released,
            providerInvocationStarted: hasPaid,
            releaseSuppressed: !released,
          };
          plan.failureCode = String(error?.code || 'AI_SALES_VOICED_FAILED');
          // A bare failure code is not actionable for the boss. Keep the safe,
          // already-sanitized contract errors (no prompts, keys or raw bodies).
          plan.failureDetail = voicedSalesFailureDetail(error);
          if (['处理中', '成功'].includes(row?.status)) {
            try {
              persist(
                row.status === '成功' ? '成功' : '失败',
                released ? '本次未生成完整成片，积分已全额退回。' : '成片或费用待核验；请查看任务结果。',
                row.url,
                released ? 0 : null,
                row.status,
              );
            } catch {
              /* durable hold remains authoritative */
            }
          }
        } finally {
          if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
      }));
    const publicPlan = publicVoicedSalesProgress(plan, tenantId);
    return {
      response: {
        jobId,
        pollUrl,
        status: 'processing',
        workflow: plan.workflow,
        durationSeconds: duration,
        providerCalls: 0,
        billing: plan.billing,
        plan: publicPlan,
        salesVideo: publicPlan,
        contentEmployeeIdx: 10,
        contentEmployeeKey: 'commerce_video',
      },
      run,
    };
  } catch (error) {
    if (hold) {
      let released = false;
      try {
        released = Boolean(releaseHold(hold, '启动前失败，全额退回'));
      } catch {
        /* authoritative hold remains pending */
      }
      plan.billing = {
        ...plan.billing,
        state: released ? 'released' : 'pending_reconciliation',
        chargedCredits: released ? 0 : null,
        pendingReconciliation: !released,
      };
    }
    if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    const reason = error?.code?.startsWith('AI_SALES_') ? error.message : '有声带货预检未通过，未发起供应商调用';
    plan.failureCode = error.code || 'AI_SALES_VOICED_PREFLIGHT_FAILED';
    plan.failureDetail = voicedSalesFailureDetail(error);
    plan.reason = reason;
    persist('阻塞', reason, null, plan.billing.pendingReconciliation ? null : 0, '阻塞');
    const publicPlan = publicVoicedSalesProgress(plan, tenantId);
    return {
      response: {
        jobId,
        pollUrl,
        status: 'blocked',
        workflow: plan.workflow,
        durationSeconds: duration,
        providerCalls: 0,
        reason,
        billing: plan.billing,
        plan: publicPlan,
        salesVideo: publicPlan,
        contentEmployeeIdx: 10,
        contentEmployeeKey: 'commerce_video',
      },
      run: null,
    };
  }
}

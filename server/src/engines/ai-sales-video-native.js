import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { q, curTenant, getTenantConfig, runWithTenant } from '../db.js';
import { generate } from './ai.js';
import { scanText } from './risk.js';
import { canAccessOwner, isManagerRole } from './access.js';
import { billing, holdCredits, settleHold, releaseHold, estimateCallCredits } from './credits.js';
import { AI_SALES_VIDEO_EMPLOYEE, AI_SALES_VIDEO_WORKFLOW, normalizeAiSalesVideoBrief } from './ai-sales-video.js';
import { generateAiSalesVideoScript, condenseAiSalesVideoShot } from './ai-sales-video-script.js';
import {
  synthesizeAiSalesVideoVoiceTracks,
  buildAiSalesVideoSubtitleCues,
  AI_SALES_VIDEO_SYSTEM_VOICES,
  safeAiSalesVideoVoiceId,
  AI_SALES_VIDEO_TTS_MODEL,
} from './ai-sales-video-voice.js';
import { assertAiSalesVoicedComposerReady, composeAiSalesVideo, runAiSalesMediaCommand } from './video-composer.js';
import { downloadProviderVideoClip, waitForProviderVideo } from './video-provider-download.js';
import { createMiniMaxVoiceClient } from './minimax-voice.js';
import {
  aiSalesVideoProviderPublicBaseUrl,
  createAiSalesVideoAssetPublisher,
} from './ai-sales-video-provider-assets.js';
import {
  yunwuAvailable,
  yunwuApiKey,
  yunwuMediaBaseUrl,
  textModelFor,
  submitAliBailianVideoSegment,
  queryAliBailianVideoSegment,
} from './yunwu.js';
import { listBenchmarkCards } from './content-benchmark-cards.js';
import { activeContentEvolutionNotes } from './employee-evolution.js';
import { buildContentEmployeeWorkbenchProfile } from './content-employee-workbench.js';
import { publicVoicedSalesProgress, voicedSalesDeliveryVerified } from './ai-sales-video-presentation.js';

export const AI_SALES_VOICED_MODEL = 'wan2.6-i2v';
const fail = (message, code = 'AI_SALES_VOICED_BLOCKED', status = 409) =>
  Object.assign(new Error(message), { code, status });
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const taskId = value => (/^[\p{L}\p{N}_.+-]{1,240}$/u.test(String(value || '')) ? String(value) : null);

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

export async function voicedSalesVideoOptions(actor, runtime = {}) {
  if (Number(actor.tenant_id) !== Number(curTenant()))
    throw fail('企业上下文不一致', 'AI_SALES_VIDEO_TENANT_CONTEXT_INVALID', 403);
  const blockers = [];
  if ((!runtime.generateFn || !runtime.submitSegment) && !yunwuAvailable()) blockers.push('未配置文本与Wan生成通道');
  if (!runtime.publishAsset && !aiSalesVideoProviderPublicBaseUrl())
    blockers.push('未配置供应商可拉取音轨的公网HTTPS地址');
  const voiceConfig = getTenantConfig('avatar_minimax_voice', {});
  if (!runtime.voiceClient && !(voiceConfig?.apiKey || voiceConfig?.key || yunwuApiKey()))
    blockers.push('未配置配音通道');
  let estimatedMaxCredits = null,
    quoteFingerprint = null;
  try {
    const quote = salesVideoPriceQuote(textModelFor(actor.role));
    estimatedMaxCredits = quote.maxCredits;
    quoteFingerprint = quote.fingerprint;
  } catch {
    blockers.push('组合任务价目尚未配置完整');
  }
  try {
    await (runtime.mediaReady ? runtime.mediaReady() : assertAiSalesVoicedComposerReady());
  } catch {
    blockers.push('本机音视频工具尚未就绪');
  }
  const cloned = q
    .all(
      "SELECT provider_voice_id,label,created_by FROM avatar_voices WHERE tenant_id=? AND status='ready' AND billing_status='settled' ORDER BY id DESC",
      curTenant(),
    )
    .filter(row => canAccessOwner(actor, row.created_by))
    .filter(row => /^[a-z0-9_-]{3,64}$/iu.test(String(row.provider_voice_id || '')))
    .map(row => ({ id: row.provider_voice_id, label: `${row.label}（已授权克隆）`, cloned: true }));
  return {
    model: AI_SALES_VOICED_MODEL,
    voices: [...AI_SALES_VIDEO_SYSTEM_VOICES, ...cloned],
    blockers,
    ready: blockers.length === 0,
    estimatedMaxCredits,
    quoteFingerprint,
    durationSeconds: 30,
    segmentCount: 2,
    limits: { text: 3, tts: 3, video: 2 },
    canRecover: isManagerRole(actor),
    note: '先占扣上限，再按配置价目和实际调用用量结算；未用额度退回，调用结果不明时保留待对账。',
  };
}

export function salesVideoPriceQuote(textModel) {
  const b = billing(),
    textPrice = b.text[textModel],
    video = Number(b.video[AI_SALES_VOICED_MODEL]),
    tts = Number(b.tts[AI_SALES_VIDEO_TTS_MODEL]);
  if (
    !textPrice ||
    ![Number(textPrice.in), Number(textPrice.out), video, tts, b.marginMultiplier, b.creditYuan].every(
      Number.isFinite,
    ) ||
    Number(textPrice.in) < 0 ||
    !(Number(textPrice.out) > 0) ||
    !(video > 0) ||
    !(tts > 0) ||
    !(b.marginMultiplier > 0) ||
    !(b.creditYuan > 0)
  )
    throw fail('文本、配音或Wan模型尚未配置有效价格');
  const prices = {
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
    maxCredits: textMax * 3 + Math.ceil(((video * 2 + tts * 3) * b.marginMultiplier) / b.creditYuan),
  };
}

export function voicedSalesSettlement(plan) {
  const price = plan?.priceQuote,
    events = plan?.paidExecution;
  if (
    !price ||
    !Array.isArray(events) ||
    plan.model !== AI_SALES_VOICED_MODEL ||
    salesVideoPriceQuote(price.textModel).fingerprint !== price.fingerprint
  )
    throw fail('原任务报价不完整或价目已变化，需人工对账', 'AI_SALES_VIDEO_RECOVERY_PRICE_CHANGED');
  const currentQuote = salesVideoPriceQuote(price.textModel);
  if (
    ['textModel', 'video', 'tts', 'margin', 'creditYuan', 'maxCredits'].some(key => price[key] !== currentQuote[key]) ||
    price.text?.in !== currentQuote.text.in ||
    price.text?.out !== currentQuote.text.out
  )
    throw fail('原任务报价内容与签名不一致', 'AI_SALES_VIDEO_RECOVERY_PRICE_CHANGED');
  const byKind = kind => events.filter(event => event?.kind === kind);
  const textEvents = byKind('text'),
    ttsEvents = byKind('tts'),
    videoEvents = byKind('video');
  if (
    textEvents.length < 1 ||
    textEvents.length > 3 ||
    ttsEvents.length < 2 ||
    ttsEvents.length > 3 ||
    videoEvents.length !== 2 ||
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
        event.model !== AI_SALES_VOICED_MODEL ||
        event.index !== i + 1 ||
        !taskId(event.taskId) ||
        event.taskId !== plan.providerExecution?.segments?.[i]?.taskId,
    ) ||
    new Set(videoEvents.map(event => event.taskId)).size !== 2
  )
    throw fail('原任务调用/用量证据不完整，不能自动对账', 'AI_SALES_VIDEO_RECOVERY_BILLING_UNVERIFIED');
  const yuan = actualCost(events, price),
    credits = Math.ceil((yuan * price.margin) / price.creditYuan);
  if (!Number.isSafeInteger(credits) || credits <= 0 || credits > price.maxCredits)
    throw fail('实际费用不在原预授权范围内', 'AI_SALES_VIDEO_RECOVERY_BILLING_UNVERIFIED');
  const usage = textEvents.reduce(
    (a, event) => ({
      inputTokens: a.inputTokens + event.inputTokens,
      outputTokens: a.outputTokens + event.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
  return {
    credits,
    costYuanOverride: yuan,
    usage,
    model: plan.model,
    note: '独白/配音/Wan实际调用组合结算，未使用的授权差额退回',
  };
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
async function prepareImages(images, workDir, binaries, runner) {
  const prepared = [];
  for (const [i, image] of images.entries()) {
    const match = String(image).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u);
    if (!match) throw fail('有声首帧只支持PNG/JPEG/WebP本地图片', 'AI_SALES_VIDEO_FRAME_INVALID', 400);
    const input = path.join(workDir, `frame-${i}.${match[1]}`),
      output = path.join(workDir, `frame-${i}.jpg`);
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 15 * 1024 * 1024)
      throw fail('首帧大小不符合要求', 'AI_SALES_VIDEO_FRAME_INVALID', 400);
    await fsp.writeFile(input, bytes, { flag: 'wx', mode: 0o600 });
    const result = await runner(
      binaries.ffprobePath,
      ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'stream=width,height', '-of', 'json', input],
      { cwd: workDir },
    );
    const stream = JSON.parse(result.stdout).streams?.[0];
    if (
      !stream ||
      !Number.isInteger(stream.width) ||
      !Number.isInteger(stream.height) ||
      stream.width < 240 ||
      stream.height < 240 ||
      stream.width > 8000 ||
      stream.height > 8000
    )
      throw fail('首帧宽高须在240–8000像素', 'AI_SALES_VIDEO_FRAME_INVALID', 400);
    await runner(
      binaries.ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        input,
        '-vf',
        'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=white,format=rgb24',
        '-frames:v',
        '1',
        output,
      ],
      { cwd: workDir },
    );
    prepared.push(`data:image/jpeg;base64,${(await fsp.readFile(output)).toString('base64')}`);
  }
  return prepared;
}

/** The caller supplies resolved attachments and tenant-scoped grounding, never
 * body-provided facts/cards/notes. Runtime seams exist only on app.locals. */
export async function createVoicedSalesVideoJob({
  actor,
  brief,
  references,
  providerImages,
  grounding,
  voiceId,
  audience = '',
  quoteFingerprint,
  runtime = {},
}) {
  const tenantId = curTenant(),
    selectedVoice = resolveSalesVoice(actor, voiceId),
    textModel = textModelFor(actor.role);
  if (Number(actor.tenant_id) !== Number(tenantId))
    throw fail('视频租户上下文不一致', 'AI_SALES_VIDEO_TENANT_CONTEXT_INVALID', 403);
  const cleanBrief = normalizeAiSalesVideoBrief(brief);
  if (!providerImages.length || providerImages.length > 6)
    throw fail('请提供1–6张参考图', 'AI_SALES_VIDEO_FRAME_INVALID', 400);
  if (quoteFingerprint !== undefined && quoteFingerprint !== salesVideoPriceQuote(textModel).fingerprint)
    throw fail('报价已变化，请关闭并重新打开面板确认预授权上限；未占扣', 'AI_SALES_VIDEO_QUOTE_CHANGED');
  const plan = {
    workflow: AI_SALES_VIDEO_WORKFLOW,
    voiceMode: 'voiced',
    employee: { ...AI_SALES_VIDEO_EMPLOYEE },
    model: AI_SALES_VOICED_MODEL,
    durationSeconds: 30,
    segmentDurationSeconds: 15,
    segmentCount: 2,
    brief: cleanBrief,
    voiceId: selectedVoice,
    phase: 'preflight',
    scriptMode: 'pending',
    script: null,
    segments: [1, 2].map(index => ({ index, durationSeconds: 15, status: 'planned' })),
    references: references.map((ref, i) => ({
      id: Number(ref.id) || null,
      name: String(ref.name || `参考图${i + 1}`).slice(0, 200),
      contentSha256: digest(providerImages[i]),
    })),
    employeeExecution: {
      ...buildContentEmployeeWorkbenchProfile(10),
      selectedRuntime: {
        workflow: AI_SALES_VIDEO_WORKFLOW,
        model: AI_SALES_VOICED_MODEL,
        textModel,
        ttsModel: AI_SALES_VIDEO_TTS_MODEL,
        automaticPublishing: false,
      },
    },
    grounding: grounding.evidence,
    storeFactSnapshot: grounding.storeFacts || { facts: [] },
    paidExecution: [],
    providerExecution: {
      invocationStarted: false,
      invocationCount: 0,
      segments: [1, 2].map(index => ({ index, durationSeconds: 15, status: 'planned', taskId: null })),
    },
    billing: { state: 'not_held', heldCredits: 0, chargedCredits: 0, pendingReconciliation: false },
  };
  const inserted = q.run(
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
    'ai_sales_video.voiced.v1',
    digest(cleanBrief),
    JSON.stringify(plan),
  );
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
    const publicBaseUrl = aiSalesVideoProviderPublicBaseUrl();
    if (!runtime.publishAsset && !publicBaseUrl) throw fail('配音需要供应商可拉取的HTTPS公网地址，尚未配置');
    const voiceConfig = getTenantConfig('avatar_minimax_voice', {}, tenantId);
    if (!runtime.voiceClient && !(voiceConfig?.apiKey || voiceConfig?.key || yunwuApiKey()))
      throw fail('未配置配音服务凭据');
    quote = salesVideoPriceQuote(textModel);
    binaries = runtime.mediaReady ? await runtime.mediaReady() : await assertAiSalesVoicedComposerReady();
    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nw-voiced-sales-'));
    images = await (runtime.prepareImages || prepareImages)(providerImages, workDir, binaries, runner);
    if (salesVideoPriceQuote(textModel).fingerprint !== quote.fingerprint)
      throw fail('检查期间报价发生变化，请重新确认预授权上限；未占扣', 'AI_SALES_VIDEO_QUOTE_CHANGED');
    const cards = listBenchmarkCards(tenantId, { verifiedOnly: true, limit: 3 });
    const notes = activeContentEvolutionNotes(10, { tenantId });
    plan.learning = { benchmarkCardIds: cards.map(card => card.id), evolutionNoteIds: notes.map(note => note.id) };
    plan.priceQuote = quote;
    hold = holdCredits({
      userId: actor.id,
      feature: 'AI带货员·有声30秒成片',
      kind: 'video',
      model: plan.model,
      credits: quote.maxCredits,
      refType: 'media_job',
      refId: jobId,
      note: '文本最多3次、配音最多3次、Wan15秒最多2段的组合预授权',
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
      runWithTenant(tenantId, async () => {
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
            const limit = kind === 'video' ? 2 : 3;
            if (plan.paidExecution.filter(e => e.kind === kind).length >= limit) throw fail('供应商调用超过授权次数');
            const event = {
              id: plan.paidExecution.length + 1,
              kind,
              model,
              index,
              status: 'started',
              startedAt: new Date().toISOString(),
            };
            plan.paidExecution.push(event);
            plan.phase = kind === 'text' ? 'script' : kind === 'tts' ? 'voice' : 'video';
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
            });
            persist('处理中');
            return result;
          };
          const context = {
            brief: cleanBrief,
            storeFacts: grounding.storeFacts,
            storeFactsPrompt: grounding.storeFactsPrompt,
            promptContext: grounding.promptContext,
            benchmarkCards: cards,
            evolutionNotes: notes,
            audience: String(audience).slice(0, 120),
            model: textModel,
            role: actor.role,
            generateFn: textFn,
            scanText: runtime.scanText || scanText,
          };
          const generated = await generateAiSalesVideoScript(context);
          plan.scriptMode = 'model';
          plan.script = generated.script;
          persist('处理中');
          const client =
            runtime.voiceClient ||
            createMiniMaxVoiceClient({
              apiKey: voiceConfig?.apiKey || voiceConfig?.key || yunwuApiKey(),
              baseUrl: voiceConfig?.baseUrl || yunwuMediaBaseUrl(),
            });
          const trackedClient = {
            synthesize: async params => {
              const event = begin(
                'tts',
                AI_SALES_VIDEO_TTS_MODEL,
                plan.paidExecution.filter(e => e.kind === 'tts').length + 1,
              );
              const output = await client.synthesize(params);
              if (!output?.audioUrl) throw fail('配音调用未返回音轨');
              event.status = 'returned';
              persist('处理中');
              return output;
            },
          };
          const voiced = await synthesizeAiSalesVideoVoiceTracks({
            ...binaries,
            runner,
            script: plan.script,
            voiceId: selectedVoice,
            voiceClient: trackedClient,
            workDir,
            fetchImpl: runtime.fetchImpl,
            publishAsset:
              runtime.publishAsset ||
              createAiSalesVideoAssetPublisher({ tenantId, userId: actor.id, publicBaseUrl, includeMetadata: true }),
            condenseShot: request => condenseAiSalesVideoShot({ ...context, ...request }),
            onTrackReady: (track, script) => {
              plan.script = script;
              const { index, fileId, sha256, durationSeconds, measuredSeconds, speechSeconds, tempo, condensed } =
                track;
              plan.voiceTracks = [
                ...(plan.voiceTracks || []),
                { index, fileId, sha256, durationSeconds, measuredSeconds, speechSeconds, tempo, condensed },
              ];
              plan.voiceScriptSha256 = digest(script);
              persist('处理中');
            },
          });
          plan.script = voiced.script;
          const clips = [],
            submittedSegments = [];
          for (const [i, shot] of plan.script.shots.entries()) {
            const segment = plan.providerExecution.segments[i];
            segment.status = 'submitting';
            const event = begin('video', plan.model, i + 1);
            const submitted = await (runtime.submitSegment || submitAliBailianVideoSegment)({
              model: plan.model,
              duration: 15,
              resolution: '720P',
              promptExtend: false,
              images: [images[i % images.length]],
              audioUrl: voiced.tracks[i].publicUrl,
              prompt:
                `${shot.visual}\n中文独白：${shot.voiceover}\n参考图保持产品及人物身份；使用给定音轨，不生成新口播或字幕。`.slice(
                  0,
                  1500,
                ),
            });
            segment.taskId = taskId(submitted.taskId);
            if (!segment.taskId) throw fail('Wan未返回可持久化任务ID');
            event.taskId = segment.taskId;
            event.status = 'returned';
            segment.status = 'provider_submitted';
            plan.providerExecution.invocationCount += 1;
            persist('处理中');
            submittedSegments.push(submitted);
          }
          for (const [i, segment] of plan.providerExecution.segments.entries()) {
            const submitted = submittedSegments[i];
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
            const clip = await (runtime.downloadSegment || downloadProviderVideoClip)({
              url: ready.url,
              outputDir: workDir,
              index: i + 1,
              fetchImpl: runtime.fetchImpl,
            });
            clips.push(clip.path || clip.absolutePath);
            segment.status = 'downloaded';
            persist('处理中');
          }
          const subtitleCues = buildAiSalesVideoSubtitleCues({ script: plan.script, tracks: voiced.tracks });
          plan.phase = 'compose';
          persist('处理中');
          delivered = await (runtime.compose || composeAiSalesVideo)({
            ...binaries,
            tenantId,
            segments: clips,
            voiceTracks: voiced.tracks.map(track => track.localPath),
            subtitleCues,
            requireAudio: true,
          });
          if (!voicedSalesDeliveryVerified(delivered, tenantId)) throw fail('合成器未返回可核验的30秒有声字幕成片');
          plan.result = {
            url: delivered.url,
            durationSeconds: delivered.durationSeconds,
            sha256: delivered.sha256,
            audioVerified: true,
            subtitlesBurnedIn: true,
            subtitleCount: subtitleCues.length,
            audioVerification: delivered.audioVerification || [],
          };
          plan.segments = plan.script.shots.map(shot => ({
            index: shot.index,
            durationSeconds: 15,
            title: shot.visual,
            voiceover: shot.voiceover,
            status: 'composed',
          }));
          persist('成功', null, delivered.url);
          const settlement = voicedSalesSettlement(plan);
          const settled = settleHold(hold, settlement);
          if (!settled) throw fail('组合账务未成功结算');
          plan.billing = {
            ...plan.billing,
            state: 'settled',
            chargedCredits: settled.credits,
            pendingReconciliation: false,
            costYuan: settlement.costYuanOverride,
          };
          plan.phase = 'complete';
          persist('成功', null, delivered.url, settled.credits, '成功');
        } catch (error) {
          const hasPaid = plan.paidExecution.length > 0;
          let released = false;
          if (!hasPaid) {
            try {
              released = Boolean(releaseHold(hold, '供应商调用前失败，全额退回'));
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
            releaseSuppressed: hasPaid,
          };
          plan.failureCode = String(error?.code || 'AI_SALES_VOICED_FAILED');
          const row = q.get('SELECT status,url FROM media_jobs WHERE tenant_id=? AND id=?', tenantId, jobId);
          if (['处理中', '成功'].includes(row?.status)) {
            try {
              persist(
                row.status === '成功' ? '成功' : '失败',
                '有声带货未完整交付或账务待核验；请查看执行阶段，不要重复提交收费任务',
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
      });
    const publicPlan = publicVoicedSalesProgress(plan, tenantId);
    return {
      response: {
        jobId,
        pollUrl,
        status: 'processing',
        workflow: plan.workflow,
        durationSeconds: 30,
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
    plan.reason = reason;
    persist('阻塞', reason, null, plan.billing.pendingReconciliation ? null : 0, '阻塞');
    const publicPlan = publicVoicedSalesProgress(plan, tenantId);
    return {
      response: {
        jobId,
        pollUrl,
        status: 'blocked',
        workflow: plan.workflow,
        durationSeconds: 30,
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

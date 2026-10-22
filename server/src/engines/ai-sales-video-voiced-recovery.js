import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { q, curTenant, runWithTenant } from '../db.js';
import { canAccessOwner, isManagerRole } from './access.js';
import { settleHold, getSupplierExpense } from './credits.js';
import { voicedSalesSettlement, refreshVoicedSalesReceipts } from './ai-sales-video-native.js';
import { withTaskProvider, taskProviderId } from './ai-provider-selection.js';
import { testerExecutionIdentity } from './tester-access.js';
import { PROVIDER_360_VIDEO_MODEL } from './provider-360.js';
import { validateAiSalesVideoScript } from './ai-sales-video-script.js';
import { buildAiSalesVideoSubtitleCues, measureAudioDuration } from './ai-sales-video-voice.js';
import { readAiSalesVideoVoiceAsset } from './ai-sales-video-provider-assets.js';
import {
  assertAiSalesVoicedComposerReady,
  runAiSalesMediaCommand,
  composeAiSalesVideo,
  AI_SALES_VIDEO_UPLOAD_ROOT,
} from './video-composer.js';
import { assertAudibleTrack } from './video-voice-composition.js';
import { downloadProviderVideoClip, waitForProviderVideo } from './video-provider-download.js';
import { yunwuAvailable } from './yunwu.js';
import { SALES_SEEDANCE_MODEL, salesFallbackModel, querySalesVideoSegment } from './sales-video-premium.js';
import {
  publicVoicedSalesProgress,
  voicedSalesDeliveryVerified,
  voicedSalesRecoveryAvailable,
} from './ai-sales-video-presentation.js';
import { scanText } from './risk.js';
import { preserveSalesVideoClip } from './ai-sales-video-partials.js';
import { resolveAiSalesVideoDuration } from './ai-sales-video-duration.js';

// Intentionally no generator, TTS, submit-video, new-hold or release-hold calls.
const fail = (message, code = 'AI_SALES_VIDEO_RECOVERY_NOT_AVAILABLE', status = 409) =>
  Object.assign(new Error(message), { code, status });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));

function originalHold(job, plan, { allowRefunded = false } = {}) {
  const hold = q.get(
    `SELECT * FROM credit_holds WHERE tenant_id=? AND ref_type='media_job' AND ref_id=? ORDER BY id DESC LIMIT 1`,
    job.tenant_id,
    job.id,
  );
  const expense = hold ? getSupplierExpense(hold.id, job.tenant_id) : null;
  const refunded = !!expense?.refundedAt;
  const canReadRefunded =
    allowRefunded && refunded && expense.userId === job.user_id && hold.status === 'settled';
  let price = {};
  try { price = JSON.parse(hold?.pricing_snapshot_json || '{}'); } catch { /* malformed snapshots cannot authorize a zero hold */ }
  const personal = price.billingMode === 'personal';
  if (personal) {
    const identity = testerExecutionIdentity({ userId: job.user_id, tenantId: job.tenant_id,
      provider: price.provider, requireActive: false });
    if (!identity || Number(price.ownerUserId) !== Number(job.user_id)
      || Number(price.tenantId) !== Number(job.tenant_id) || price.provider !== taskProviderId(plan)
      || hold.held_credits !== 0 || (hold.status === 'settled' && hold.settled_credits !== 0))
      throw fail('个人调用任务的原账号、供应商或账目不匹配', 'AI_SALES_VIDEO_RECOVERY_HOLD_INVALID');
  }
  if (
    !hold ||
    Number(hold.id) !== Number(plan.billing?.holdId) ||
    Number(hold.user_id) !== Number(job.user_id) ||
    hold.kind !== 'video' ||
    hold.model !== plan.model ||
    !['held', 'settled'].includes(hold.status) ||
    !Number.isSafeInteger(hold.held_credits) ||
    (!personal && (hold.held_credits <= 0 || hold.held_credits !== plan.priceQuote?.maxCredits)) ||
    (refunded && !canReadRefunded) ||
    (hold.status === 'settled' && !(hold.settled_credits > 0) && !personal && !canReadRefunded)
  )
    throw fail('原预授权不存在、已退回或不匹配；不会重新占扣', 'AI_SALES_VIDEO_RECOVERY_HOLD_INVALID');
  const log = q.get('SELECT * FROM credit_logs WHERE tenant_id=? AND id=?', job.tenant_id, hold.log_id);
  if (
    !log ||
    Number(log.user_id) !== Number(job.user_id) ||
    log.kind !== 'video' ||
    log.model !== plan.model ||
    (hold.status === 'held' && (log.ai_mode !== 'hold' || log.credits !== hold.held_credits)) ||
    (hold.status === 'settled' &&
      ((log.ai_mode !== 'api' && !(canReadRefunded && log.ai_mode === 'failed')) ||
        log.credits !== hold.settled_credits))
  )
    throw fail('原任务账本证据不一致，需人工对账', 'AI_SALES_VIDEO_RECOVERY_HOLD_INVALID');
  return { hold, log, expense, personal };
}

function recoverySettlement(plan, original) {
  const settlement = voicedSalesSettlement(plan);
  // Supplier usage/cost evidence stays intact; a verified BYOK hold never debits
  // the platform wallet, even when the shared customer quote is positive.
  return original.personal ? { ...settlement, credits: 0 } : settlement;
}

function originalCostMatches(original, settlement) {
  if (Number.isFinite(settlement.costYuanOverride))
    return original.log.cost_yuan === Math.round(settlement.costYuanOverride * 10000) / 10000;
  // A settled customer bill may still have a supplier expense awaiting its receipt.
  // Unknown cost must stay null; it is not the frozen 360 reference price.
  return original.log.cost_yuan == null && original.expense?.status !== 'known';
}

// Refunded failures may only finish from their own already-paid, hash-verified
// local clips. They never query/resubmit a provider or reopen the customer bill.
async function readRefundedLocalClips(job, plan) {
  const root = await fsp.realpath(AI_SALES_VIDEO_UPLOAD_ROOT);
  const tenantDir = path.join(root, String(job.tenant_id));
  if (await fsp.realpath(tenantDir) !== tenantDir) throw fail('原片租户目录无法核验');
  const clips = [];
  for (const segment of plan.providerExecution.segments) {
    const part = plan.partialResults?.find(item => item.index === segment.index);
    if (!part || !/^[a-f0-9]{64}$/u.test(String(part.sha256 || ''))) throw fail('缺少已保存的原片');
    const name = `partial-${job.id}-${segment.index}-${part.sha256.slice(0,24)}.mp4`;
    if (part.url !== `/uploads/ai-sales-video/${job.tenant_id}/${name}`) throw fail('原片不属于本任务');
    const file = await fsp.open(path.join(tenantDir,name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 180*1024*1024 || stat.size !== part.bytes) throw fail('原片大小无法核验');
      const bytes = await file.readFile();
      if (hash(bytes) !== part.sha256) throw fail('原片哈希不匹配');
      clips.push(bytes);
    } finally { await file.close(); }
  }
  return clips;
}

async function verifyExistingResult(result, tenantId, binaries, runner, audioMode, durationSeconds = 30) {
  if (!voicedSalesDeliveryVerified(result, tenantId, audioMode, durationSeconds)) return false;
  try {
    const root = path.join(await fsp.realpath(AI_SALES_VIDEO_UPLOAD_ROOT), String(tenantId));
    const file = path.join(root, path.posix.basename(result.url)),
      realFile = await fsp.realpath(file),
      stat = await fsp.lstat(file);
    if (
      !realFile.startsWith(`${root}${path.sep}`) ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > 180 * 1024 * 1024
    )
      return false;
    const actualHash = crypto.createHash('sha256');
    for await (const bytes of fs.createReadStream(realFile)) actualHash.update(bytes);
    if (actualHash.digest('hex') !== result.sha256) return false;
    const probe = JSON.parse(
      (
        await runner(binaries.ffprobePath, [
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-show_format',
          '-show_streams',
          '-of',
          'json',
          realFile,
        ])
      ).stdout,
    );
    const video = probe.streams?.find(stream => stream.codec_type === 'video'),
      audio = probe.streams?.find(stream => stream.codec_type === 'audio');
    if (
      !Number.isFinite(Number(probe.format?.duration)) ||
      Math.abs(Number(probe.format.duration) - durationSeconds) > 0.25 ||
      video?.width !== 1080 ||
      video?.height !== 1920 ||
      video?.codec_name !== 'h264' ||
      audio?.codec_name !== 'aac'
    )
      return false;
    for (const startSeconds of Array.from({ length: durationSeconds / 15 }, (_, i) => i * 15))
      await assertAudibleTrack({
        runner,
        ffmpegPath: binaries.ffmpegPath,
        filePath: realFile,
        durationSeconds: 15,
        startSeconds,
      });
    return true;
  } catch {
    return false;
  }
}

// Free retrieval only. An unknown second submission stays unknown: this helper
// cannot submit a provider job or settle/release the original hold.
export async function recoverVoicedSalesVideoClips(args) {
  const job = q.get('SELECT model,snapshot_json FROM media_jobs WHERE tenant_id=? AND id=?', curTenant(), Number(args.jobId));
  if (!job) throw fail('任务不存在或无权访问');
  let snapshot; try { snapshot = JSON.parse(job.snapshot_json); } catch { throw fail('任务快照无法核验'); }
  return withTaskProvider({ model: job.model, providerId: snapshot.providerId }, () => recoverVoicedSalesVideoClipsSelected(args));
}
async function recoverVoicedSalesVideoClipsSelected({ actor, jobId, runtime = {} }) {
  const tenantId = curTenant();
  const job = q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', tenantId, Number(jobId));
  if (!isManagerRole(actor) || Number(actor.tenant_id) !== Number(tenantId) || !job || !canAccessOwner(actor, job.user_id))
    throw fail('任务不存在或无权访问', 'AI_SALES_VIDEO_RECOVERY_NOT_FOUND', 404);
  const plan = JSON.parse(job.snapshot_json || '{}');
  const duration = resolveAiSalesVideoDuration(plan.durationSeconds, 30);
  if (plan.workflow !== 'ai_sales_video' || plan.audioMode !== 'provider_native'
    || !['wan2.6-i2v', PROVIDER_360_VIDEO_MODEL, SALES_SEEDANCE_MODEL].includes(job.model) || job.model !== plan.model || !['失败', '阻塞'].includes(job.status)
    || plan.voiceScriptSha256 !== jsonHash(plan.script)) throw fail('仅可取回已停止原生有声任务的原始片段');
  originalHold(job, plan, { allowRefunded: true });
  const segments = (plan.providerExecution?.segments || []).filter((segment, i) =>
    segment.index === i + 1 && segment.index <= duration / 15 && /^[\p{L}\p{N}_.+^:/-]{1,500}$/u.test(String(segment.taskId || ''))
    && plan.paidExecution?.some(event => event.kind === 'video' && [plan.model, salesFallbackModel(plan.model)].includes(event.model)
      && event.index === segment.index && event.status === 'returned' && event.taskId === segment.taskId));
  if (!segments.length || new Set(segments.map(item => item.taskId)).size !== segments.length) throw fail('缺少可核验的原任务号');
  const runner = runtime.runner || runAiSalesMediaCommand;
  const binaries = runtime.mediaReady ? await runtime.mediaReady() : await assertAiSalesVoicedComposerReady({ audioMode: 'provider_native', durationSeconds: duration });
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nw-paid-clips-'));
  let expected = job.snapshot_json;
  const save = () => {
    const encoded = JSON.stringify(plan);
    if (q.run('UPDATE media_jobs SET snapshot_json=? WHERE tenant_id=? AND id=? AND status=? AND snapshot_json=?',
      encoded, tenantId, job.id, job.status, expected).changes !== 1) throw fail('原任务已被更新，请重新读取');
    expected = encoded;
  };
  try {
    for (const segment of segments) {
      const existing = (plan.partialResults || []).find(item => item.index === segment.index);
      if (existing && publicVoicedSalesProgress(plan, tenantId).partialResults.some(item => item.url === existing.url)) {
        try {
          const local = path.join(AI_SALES_VIDEO_UPLOAD_ROOT, String(tenantId), path.posix.basename(existing.url));
          const file = await fsp.open(local, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try { if (hash(await file.readFile()) === existing.sha256) continue; } finally { await file.close(); }
        } catch { /* Re-query the original task if its saved artifact is missing. */ }
      }
      const ready = await waitForProviderVideo({ taskId: segment.taskId, model: segment.model || plan.model,
        query: params => (runtime.querySegment || querySalesVideoSegment)({ ...params, model: segment.model || plan.model }), timeoutMs: runtime.timeoutMs || 12 * 60 * 1000,
        intervalMs: runtime.intervalMs || 5000, sleep: runtime.sleep });
      const clip = await (runtime.downloadSegment || downloadProviderVideoClip)({ url: ready.url, outputDir: workDir,
        index: segment.index, fetchImpl: runtime.fetchImpl });
      const partial = await preserveSalesVideoClip({ clip, tenantId, jobId: Number(jobId), index: segment.index, binaries, runner });
      plan.partialResults = [...(plan.partialResults || []).filter(item => item.index !== segment.index), partial];
      segment.status = 'downloaded';
      plan.partialRecovery = { retrievedAt: new Date().toISOString(), providerSubmissions: 0, billingUnchanged: true };
      save();
    }
    return { jobId: job.id, salesVideo: publicVoicedSalesProgress(plan, tenantId), billingUnchanged: true };
  } finally { await fsp.rm(workDir, { recursive: true, force: true }); }
}

export async function createVoicedSalesVideoRecovery(args) {
  const job = q.get('SELECT model,snapshot_json FROM media_jobs WHERE tenant_id=? AND id=?', curTenant(), Number(args.jobId));
  if (!job) throw fail('任务不存在或无权访问');
  let snapshot; try { snapshot = JSON.parse(job.snapshot_json); } catch { throw fail('任务快照无法核验'); }
  return withTaskProvider({ model: job.model, providerId: snapshot.providerId }, () => createVoicedSalesVideoRecoverySelected(args));
}
async function createVoicedSalesVideoRecoverySelected({ actor, jobId, runtime = {} }) {
  const tenantId = curTenant();
  if (!isManagerRole(actor))
    throw fail('只有管理角色可恢复原视频与账本', 'AI_SALES_VIDEO_RECOVERY_ROLE_FORBIDDEN', 403);
  const job = q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', tenantId, Number(jobId));
  if (Number(actor.tenant_id) !== Number(tenantId) || !job || !canAccessOwner(actor, job.user_id))
    throw fail('任务不存在或无权访问', 'AI_SALES_VIDEO_RECOVERY_NOT_FOUND', 404);
  let plan;
  try {
    plan = JSON.parse(job.snapshot_json);
  } catch {
    throw fail('原任务快照无法核验');
  }
  if (!voicedSalesRecoveryAvailable(job, plan, { state: plan.billing?.state }))
    throw fail('该有声任务缺少原音轨/任务号、仍在执行或已完整结算');
  const duration = resolveAiSalesVideoDuration(plan.durationSeconds, 30);
  if (
    plan.voiceScriptSha256 !== jsonHash(plan.script) ||
    !validateAiSalesVideoScript(plan.script, {
      pack: plan.storeFactSnapshot,
      scanText: runtime.scanText || scanText,
      audioMode: plan.audioMode || 'external_tts',
      durationSeconds: duration,
    }).ok
  )
    throw fail('原脚本校验或哈希不匹配，禁止重新生成代替');
  const refundedRecovery = plan.billing?.state === 'released' && plan.audioMode === 'provider_native';
  const original = originalHold(job, plan, { allowRefunded: refundedRecovery });
  if (refundedRecovery && (!original.expense?.refundedAt || original.hold.settled_credits !== 0))
    throw fail('免费恢复必须保留原任务已全额退款的账目');
  const savedClips = refundedRecovery ? await readRefundedLocalClips(job, plan) : null;
  if (original.hold.status === 'held') await refreshVoicedSalesReceipts(plan, runtime.supplierRequestCost);
  const settlement = recoverySettlement(plan, original);
  const walletPricing = JSON.parse(original.hold.pricing_snapshot_json || '{}').supplierCostPolicy?.basis === 'upstream_debit';
  if (settlement.credits > original.hold.held_credits && !walletPricing) throw fail('实际费用超过原预授权，需人工对账');
  if (
    original.hold.status === 'settled' && !refundedRecovery &&
    (original.hold.settled_credits !== settlement.credits ||
      !originalCostMatches(original, settlement) ||
      original.log.input_tokens !== settlement.usage.inputTokens ||
      original.log.output_tokens !== settlement.usage.outputTokens)
  )
    throw fail('原实扣记录与任务用量不一致');
  const runner = runtime.runner || runAiSalesMediaCommand;
  const binaries = runtime.mediaReady
    ? await runtime.mediaReady()
    : await assertAiSalesVoicedComposerReady({
        audioMode: plan.audioMode || 'external_tts',
        durationSeconds: duration,
      });
  const hasResult = job.url === plan.result?.url && voicedSalesDeliveryVerified(plan.result, tenantId, plan.audioMode, duration);
  const canReuseResult =
    hasResult &&
    (await (runtime.verifyExistingResult || verifyExistingResult)(
      plan.result,
      tenantId,
      binaries,
      runner,
      plan.audioMode,
      duration,
    ));
  if (
    !canReuseResult &&
    q.get(
      "SELECT id FROM materials WHERE tenant_id=? AND source_type='media_job' AND source_id=? LIMIT 1",
      tenantId,
      job.id,
    )
  )
    throw fail('该成片已导入素材库，禁止用新文件静默替换；需管理层核对原素材', 'AI_SALES_VIDEO_RECOVERY_IMPORTED');
  if (!canReuseResult && !savedClips && !runtime.recoverQuery && !runtime.querySegment && !yunwuAvailable())
    throw fail('原Wan任务查询通道未配置', 'AI_SALES_VIDEO_RECOVERY_QUERY_UNAVAILABLE', 503);
  let savedSnapshot = job.snapshot_json,
    currentStatus = job.status,
    activeUrl = job.url || null;
  const token = crypto.randomUUID();
  const persist = (status, error = null, credits = null) => {
    plan.status = status;
    plan.providerExecution.updatedAt = new Date().toISOString();
    const encoded = JSON.stringify(plan);
    const changed = q.run(
      'UPDATE media_jobs SET status=?,error=?,url=?,credits=?,snapshot_json=? WHERE tenant_id=? AND id=? AND status=? AND snapshot_json=?',
      status,
      error,
      activeUrl,
      credits,
      encoded,
      tenantId,
      job.id,
      currentStatus,
      savedSnapshot,
    );
    if (changed.changes !== 1)
      throw fail('该任务状态已变化，请刷新；未重复执行恢复', 'AI_SALES_VIDEO_RECOVERY_STATE_CONFLICT');
    savedSnapshot = encoded;
    currentStatus = status;
  };
  plan.recoveryAttempts = [
    ...(Array.isArray(plan.recoveryAttempts) ? plan.recoveryAttempts : []),
    {
      token,
      actorId: actor.id,
      startedAt: new Date().toISOString(),
      providerSubmissions: 0,
    },
  ];
  plan.recovery = {
    token,
    started: false,
    stage: 'queued',
    reusedResult: Boolean(canReuseResult),
    providerSubmissions: 0,
    ...(refundedRecovery ? { refundedBillPreserved: true, source: 'verified_local_clips' } : {}),
  };
  plan.phase = 'recovery';
  persist('处理中', null, original.hold.status === 'settled' ? original.hold.settled_credits : null);
  const run = () =>
    runWithTenant(tenantId, () => withTaskProvider(plan, async () => {
      const current = q.get('SELECT status,snapshot_json FROM media_jobs WHERE tenant_id=? AND id=?', tenantId, job.id);
      if (current?.status !== '处理中' || current.snapshot_json !== savedSnapshot || plan.recovery.started) return;
      let workDir;
      try {
        plan.recovery.started = true;
        plan.recovery.stage = canReuseResult ? 'settle' : 'verify_assets';
        persist('处理中');
        if (!canReuseResult) {
          // macOS /var is an alias of /private/var. Compare files against the
          // canonical task directory while still rejecting symlink escapes.
          workDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'nw-voiced-recovery-')));
          const voicePaths = [];
          if (plan.audioMode !== 'provider_native') {
            if (
              !Array.isArray(plan.voiceTracks) ||
              plan.voiceTracks.length !== 2 ||
              new Set(plan.voiceTracks.map(track => track.fileId)).size !== 2
            )
              throw fail('缺少独立的原配音资产');
            for (const [i, track] of plan.voiceTracks.entries()) {
              if (
                track.index !== i + 1 ||
                !Number.isSafeInteger(track.fileId) ||
                track.fileId <= 0 ||
                !Number.isFinite(track.speechSeconds) ||
                track.speechSeconds <= 0 ||
                track.speechSeconds > 15 ||
                !Number.isFinite(track.durationSeconds) ||
                Math.abs(track.durationSeconds - 15) > 0.25
              )
                throw fail('原音轨测量记录不完整');
              const bytes = await (runtime.readVoiceAsset || readAiSalesVideoVoiceAsset)({
                tenantId,
                userId: job.user_id,
                fileId: track.fileId,
                sha256: track.sha256,
              });
              if (
                !Buffer.isBuffer(bytes) ||
                bytes.length <= 0 ||
                bytes.length > 15 * 1024 * 1024 ||
                hash(bytes) !== track.sha256
              )
                throw fail('原音轨读回哈希不一致');
              const voicePath = path.join(workDir, `voice-${i + 1}.mp3`);
              await fsp.writeFile(voicePath, bytes, {
                flag: 'wx',
                mode: 0o600,
              });
              const duration = await measureAudioDuration({
                runner,
                ffprobePath: binaries.ffprobePath,
                filePath: voicePath,
                cwd: workDir,
              });
              if (Math.abs(duration - 15) > 0.25) throw fail('原配音实测时长不符合15秒');
              await assertAudibleTrack({
                runner,
                ffmpegPath: binaries.ffmpegPath,
                filePath: voicePath,
                cwd: workDir,
                durationSeconds: 15,
              });
              voicePaths.push(voicePath);
            }
          }
          const clips = [];
          plan.recovery.stage = 'query';
          persist('处理中');
          for (const [i, segment] of plan.providerExecution.segments.entries()) {
            if (savedClips) {
              const file = path.join(workDir, `paid-original-${i+1}.mp4`);
              await fsp.writeFile(file, savedClips[i], { flag: 'wx', mode: 0o600 });
              clips.push(file);
              continue;
            }
            const ready = await waitForProviderVideo({
              taskId: segment.taskId,
              model: segment.model || plan.model,
              query: async params => {
                const out = await (runtime.recoverQuery || runtime.querySegment || querySalesVideoSegment)({ ...params, model: segment.model || plan.model });
                const event = plan.paidExecution?.find(item => item.kind === 'video' && item.taskId === segment.taskId);
                if (event && out?.supplierCosts?.some(cost => cost.status === 'known')) event.supplierCosts = out.supplierCosts;
                persist('处理中');
                return out;
              },
              timeoutMs: runtime.timeoutMs || 12 * 60 * 1000,
              intervalMs: runtime.intervalMs || 5000,
              sleep: runtime.sleep,
            });
            const downloaded = await (runtime.recoverDownload || runtime.downloadSegment || downloadProviderVideoClip)({
              url: ready.url,
              outputDir: workDir,
              index: i + 1,
              fetchImpl: runtime.fetchImpl,
            });
            const file = downloaded.path || downloaded.absolutePath;
            if (
              typeof file !== 'string' ||
              !path.isAbsolute(file) ||
              !file.startsWith(`${workDir}${path.sep}`) ||
              !(await fsp.lstat(file)).isFile() ||
              !(await fsp.realpath(file)).startsWith(`${workDir}${path.sep}`)
            )
              throw fail('恢复下载未形成安全本地片段');
            clips.push(file);
            persist('处理中');
          }
          plan.recovery.stage = 'compose';
          persist('处理中');
          const subtitleCues = buildAiSalesVideoSubtitleCues({
            script: plan.script,
            ...(plan.audioMode === 'provider_native' ? { timing: plan.narrationTiming } : { tracks: plan.voiceTracks }),
            durationSeconds: duration,
          });
          const delivered = await (runtime.recoverCompose || runtime.compose || composeAiSalesVideo)({
            ...binaries,
            tenantId,
            segments: clips,
            ...(plan.audioMode === 'provider_native' ? { audioMode: 'provider_native' } : { voiceTracks: voicePaths }),
            targetDurationSeconds: duration,
            subtitleCues,
            requireAudio: true,
          });
          if (!voicedSalesDeliveryVerified(delivered, tenantId, plan.audioMode, duration))
            throw fail('恢复成片未通过音轨和字幕验证');
          plan.result = {
            url: delivered.url,
            durationSeconds: delivered.durationSeconds,
            sha256: delivered.sha256,
            audioVerified: true,
            subtitlesBurnedIn: true,
            subtitleCount: subtitleCues.length,
            audioVerification: delivered.audioVerification,
            ...(plan.audioMode === 'provider_native'
              ? {
                  audioSource: delivered.audioSource,
                  subtitleTiming: 'script_estimated',
                  ...(delivered.transition ? { transition: delivered.transition } : {}),
                }
              : {}),
          };
          activeUrl = delivered.url;
        }
        plan.recovery.stage = 'settle';
        persist('成功');
        // Re-read price + hold after asynchronous I/O; neither snapshot state nor
        // a stale closure may authorize a second debit or overwrite a refund.
        const latest = originalHold(job, plan, { allowRefunded: refundedRecovery }),
          currentSettlement = recoverySettlement(plan, latest);
        let settled;
        if (refundedRecovery) {
          if (!latest.expense?.refundedAt || latest.hold.settled_credits !== 0) throw fail('原退款账目已变化，未重新扣款');
        } else if (latest.hold.status === 'held') {
          settled = settleHold({ holdId: Number(latest.hold.id) }, currentSettlement);
          if (!settled) throw fail('原预授权结算未完成');
        } else if (
          latest.hold.settled_credits !== currentSettlement.credits ||
          !originalCostMatches(latest, currentSettlement) ||
          latest.log.input_tokens !== currentSettlement.usage.inputTokens ||
          latest.log.output_tokens !== currentSettlement.usage.outputTokens
        )
          throw fail('原实扣与恢复用量不一致');
        plan.billing = {
          ...plan.billing,
          state: refundedRecovery ? 'released' : 'settled',
          chargedCredits: settled?.credits ?? latest.hold.settled_credits,
          pendingReconciliation: false,
          costYuan: settled?.costYuan ?? latest.log.cost_yuan,
          ...(refundedRecovery ? { recoveredAfterRefund: true, platformAbsorbedCostYuan: currentSettlement.costYuanOverride ?? null, note: '已用保存原片完成本地恢复；原退款不变，用户扣款为0，原供应商成本由平台承担。' } : {}),
        };
        plan.phase = 'complete';
        plan.recovery.stage = 'complete';
        delete plan.failureCode;
        Object.assign(plan.recoveryAttempts.at(-1), {
          finishedAt: new Date().toISOString(),
          status: 'complete',
        });
        persist('成功', null, plan.billing.chargedCredits);
      } catch (error) {
        plan.failureCode = /^[A-Z0-9_]{1,100}$/u.test(String(error?.code || ''))
          ? error.code
          : 'AI_SALES_VOICED_RECOVERY_FAILED';
        plan.recovery.stage = 'failed';
        Object.assign(plan.recoveryAttempts.at(-1), {
          finishedAt: new Date().toISOString(),
          status: 'failed',
          code: plan.failureCode,
        });
        try {
          const latest = originalHold(job, plan, { allowRefunded: refundedRecovery }).hold,
            settled = latest.status === 'settled';
          plan.billing = {
            ...plan.billing,
            state: refundedRecovery ? 'released' : settled ? 'settled' : 'pending_reconciliation',
            pendingReconciliation: !settled,
            chargedCredits: settled ? latest.settled_credits : null,
          };
          persist(
            activeUrl && voicedSalesDeliveryVerified(plan.result, tenantId, plan.audioMode, duration) ? '成功' : '失败',
            '原任务恢复未完成，未新增生成或占扣；请查看阶段并刷新重试',
            settled ? latest.settled_credits : null,
          );
        } catch {
          /* preserve the winning worker / authoritative ledger */
        }
      } finally {
        if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    }));
  return {
    response: {
      jobId: Number(job.id),
      status: 'processing',
      pollUrl: `/content/media-jobs/${job.id}`,
      workflow: 'ai_sales_video',
      billing: plan.billing,
      salesVideo: publicVoicedSalesProgress(plan, tenantId),
      recovery: {
        mode: savedClips ? 'reuse_verified_local_clips_after_refund' : canReuseResult ? 'verify_existing_result' : 'reuse_existing_provider_tasks',
        providerSubmissions: 0,
        reusedTaskCount: canReuseResult ? 0 : plan.providerExecution.segments.length,
      },
    },
    run,
  };
}

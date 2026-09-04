import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { q, curTenant, runWithTenant } from '../db.js';
import { canAccessOwner, isManagerRole } from './access.js';
import { settleHold } from './credits.js';
import { voicedSalesSettlement, AI_SALES_VOICED_MODEL } from './ai-sales-video-native.js';
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
import { queryAliBailianVideoSegment, yunwuAvailable } from './yunwu.js';
import {
  publicVoicedSalesProgress,
  voicedSalesDeliveryVerified,
  voicedSalesRecoveryAvailable,
} from './ai-sales-video-presentation.js';
import { scanText } from './risk.js';

// Intentionally no generator, TTS, submit-video, new-hold or release-hold calls.
const fail = (message, code = 'AI_SALES_VIDEO_RECOVERY_NOT_AVAILABLE', status = 409) =>
  Object.assign(new Error(message), { code, status });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));

function originalHold(job, plan) {
  const hold = q.get(
    `SELECT * FROM credit_holds WHERE tenant_id=? AND ref_type='media_job' AND ref_id=? ORDER BY id DESC LIMIT 1`,
    job.tenant_id,
    job.id,
  );
  if (
    !hold ||
    Number(hold.id) !== Number(plan.billing?.holdId) ||
    Number(hold.user_id) !== Number(job.user_id) ||
    hold.kind !== 'video' ||
    hold.model !== AI_SALES_VOICED_MODEL ||
    !['held', 'settled'].includes(hold.status) ||
    !Number.isSafeInteger(hold.held_credits) ||
    hold.held_credits <= 0 ||
    hold.held_credits !== plan.priceQuote?.maxCredits ||
    (hold.status === 'settled' && !(hold.settled_credits > 0))
  )
    throw fail('原预授权不存在、已退回或不匹配；不会重新占扣', 'AI_SALES_VIDEO_RECOVERY_HOLD_INVALID');
  const log = q.get('SELECT * FROM credit_logs WHERE tenant_id=? AND id=?', job.tenant_id, hold.log_id);
  if (
    !log ||
    Number(log.user_id) !== Number(job.user_id) ||
    log.kind !== 'video' ||
    log.model !== AI_SALES_VOICED_MODEL ||
    (hold.status === 'held' && (log.ai_mode !== 'hold' || log.credits !== hold.held_credits)) ||
    (hold.status === 'settled' && (log.ai_mode !== 'api' || log.credits !== hold.settled_credits))
  )
    throw fail('原任务账本证据不一致，需人工对账', 'AI_SALES_VIDEO_RECOVERY_HOLD_INVALID');
  return { hold, log };
}

async function verifyExistingResult(result, tenantId, binaries, runner) {
  if (!voicedSalesDeliveryVerified(result, tenantId)) return false;
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
      Math.abs(Number(probe.format.duration) - 30) > 0.25 ||
      video?.width !== 1080 ||
      video?.height !== 1920 ||
      video?.codec_name !== 'h264' ||
      audio?.codec_name !== 'aac'
    )
      return false;
    for (const startSeconds of [0, 15])
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

export async function createVoicedSalesVideoRecovery({ actor, jobId, runtime = {} }) {
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
  if (
    plan.voiceScriptSha256 !== jsonHash(plan.script) ||
    !validateAiSalesVideoScript(plan.script, { pack: plan.storeFactSnapshot, scanText: runtime.scanText || scanText })
      .ok
  )
    throw fail('原脚本校验或哈希不匹配，禁止重新生成代替');
  const settlement = voicedSalesSettlement(plan),
    original = originalHold(job, plan);
  if (settlement.credits > original.hold.held_credits) throw fail('实际费用超过原预授权，需人工对账');
  if (
    original.hold.status === 'settled' &&
    (original.hold.settled_credits !== settlement.credits ||
      original.log.cost_yuan !== Math.round(settlement.costYuanOverride * 10000) / 10000 ||
      original.log.input_tokens !== settlement.usage.inputTokens ||
      original.log.output_tokens !== settlement.usage.outputTokens)
  )
    throw fail('原实扣记录与任务用量不一致');
  const runner = runtime.runner || runAiSalesMediaCommand;
  const binaries = runtime.mediaReady ? await runtime.mediaReady() : await assertAiSalesVoicedComposerReady();
  const hasResult = job.url === plan.result?.url && voicedSalesDeliveryVerified(plan.result, tenantId);
  const canReuseResult =
    hasResult &&
    (await (runtime.verifyExistingResult || verifyExistingResult)(plan.result, tenantId, binaries, runner));
  if (
    !canReuseResult &&
    q.get(
      "SELECT id FROM materials WHERE tenant_id=? AND source_type='media_job' AND source_id=? LIMIT 1",
      tenantId,
      job.id,
    )
  )
    throw fail('该成片已导入素材库，禁止用新文件静默替换；需管理层核对原素材', 'AI_SALES_VIDEO_RECOVERY_IMPORTED');
  if (!canReuseResult && !runtime.recoverQuery && !runtime.querySegment && !yunwuAvailable())
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
    { token, actorId: actor.id, startedAt: new Date().toISOString(), providerSubmissions: 0 },
  ];
  plan.recovery = {
    token,
    started: false,
    stage: 'queued',
    reusedResult: Boolean(canReuseResult),
    providerSubmissions: 0,
  };
  plan.phase = 'recovery';
  persist('处理中', null, original.hold.status === 'settled' ? original.hold.settled_credits : null);
  const run = () =>
    runWithTenant(tenantId, async () => {
      const current = q.get('SELECT status,snapshot_json FROM media_jobs WHERE tenant_id=? AND id=?', tenantId, job.id);
      if (current?.status !== '处理中' || current.snapshot_json !== savedSnapshot || plan.recovery.started) return;
      let workDir;
      try {
        plan.recovery.started = true;
        plan.recovery.stage = canReuseResult ? 'settle' : 'verify_assets';
        persist('处理中');
        if (!canReuseResult) {
          workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nw-voiced-recovery-'));
          const voicePaths = [];
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
            await fsp.writeFile(voicePath, bytes, { flag: 'wx', mode: 0o600 });
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
          const clips = [];
          plan.recovery.stage = 'query';
          persist('处理中');
          for (const [i, segment] of plan.providerExecution.segments.entries()) {
            const ready = await waitForProviderVideo({
              taskId: segment.taskId,
              model: AI_SALES_VOICED_MODEL,
              query: async params => {
                const out = await (runtime.recoverQuery || runtime.querySegment || queryAliBailianVideoSegment)(params);
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
          const subtitleCues = buildAiSalesVideoSubtitleCues({ script: plan.script, tracks: plan.voiceTracks });
          const delivered = await (runtime.recoverCompose || runtime.compose || composeAiSalesVideo)({
            ...binaries,
            tenantId,
            segments: clips,
            voiceTracks: voicePaths,
            subtitleCues,
            requireAudio: true,
          });
          if (!voicedSalesDeliveryVerified(delivered, tenantId)) throw fail('恢复成片未通过音轨和字幕验证');
          plan.result = {
            url: delivered.url,
            durationSeconds: delivered.durationSeconds,
            sha256: delivered.sha256,
            audioVerified: true,
            subtitlesBurnedIn: true,
            subtitleCount: subtitleCues.length,
            audioVerification: delivered.audioVerification,
          };
          activeUrl = delivered.url;
        }
        plan.recovery.stage = 'settle';
        persist('成功');
        // Re-read price + hold after asynchronous I/O; neither snapshot state nor
        // a stale closure may authorize a second debit or overwrite a refund.
        const currentSettlement = voicedSalesSettlement(plan),
          latest = originalHold(job, plan);
        if (latest.hold.status === 'held') {
          if (!settleHold({ holdId: Number(latest.hold.id) }, currentSettlement)) throw fail('原预授权结算未完成');
        } else if (
          latest.hold.settled_credits !== currentSettlement.credits ||
          latest.log.cost_yuan !== Math.round(currentSettlement.costYuanOverride * 10000) / 10000 ||
          latest.log.input_tokens !== currentSettlement.usage.inputTokens ||
          latest.log.output_tokens !== currentSettlement.usage.outputTokens
        )
          throw fail('原实扣与恢复用量不一致');
        plan.billing = {
          ...plan.billing,
          state: 'settled',
          chargedCredits: currentSettlement.credits,
          pendingReconciliation: false,
          costYuan: currentSettlement.costYuanOverride,
        };
        plan.phase = 'complete';
        plan.recovery.stage = 'complete';
        delete plan.failureCode;
        Object.assign(plan.recoveryAttempts.at(-1), { finishedAt: new Date().toISOString(), status: 'complete' });
        persist('成功', null, currentSettlement.credits);
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
          const latest = originalHold(job, plan).hold,
            settled = latest.status === 'settled';
          plan.billing = {
            ...plan.billing,
            state: settled ? 'settled' : 'pending_reconciliation',
            pendingReconciliation: !settled,
            chargedCredits: settled ? latest.settled_credits : null,
          };
          persist(
            activeUrl && voicedSalesDeliveryVerified(plan.result, tenantId) ? '成功' : '失败',
            '原任务恢复未完成，未新增生成或占扣；请查看阶段并刷新重试',
            settled ? latest.settled_credits : null,
          );
        } catch {
          /* preserve the winning worker / authoritative ledger */
        }
      } finally {
        if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  return {
    response: {
      jobId: Number(job.id),
      status: 'processing',
      pollUrl: `/content/media-jobs/${job.id}`,
      workflow: 'ai_sales_video',
      billing: plan.billing,
      salesVideo: publicVoicedSalesProgress(plan, tenantId),
      recovery: {
        mode: canReuseResult ? 'verify_existing_result' : 'reuse_existing_provider_tasks',
        providerSubmissions: 0,
        reusedTaskCount: canReuseResult ? 0 : 2,
      },
    },
    run,
  };
}

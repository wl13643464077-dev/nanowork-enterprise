// Business-only projection shared by submission, polling and media review.
// Never return factory prompts, signed provider URLs, local paths or task IDs.
import { PROVIDER_360_VIDEO_MODEL } from './provider-360.js';
export function voicedSalesDeliveryVerified(result, tenantId, audioMode = 'external_tts', durationSeconds = 30) {
  const tid = Number(tenantId);
  return (
    Number.isSafeInteger(tid) &&
    [15, 30].includes(durationSeconds) &&
    (audioMode !== 'external_tts' || durationSeconds === 30) &&
    ['provider_native', 'external_tts'].includes(audioMode) &&
    tid > 0 &&
    new RegExp(`^/uploads/ai-sales-video/${tid}/[a-zA-Z0-9_-]+\\.mp4$`, 'u').test(String(result?.url || '')) &&
    result?.audioVerified === true &&
    (audioMode !== 'provider_native' ||
      (result?.audioSource === 'provider_native' && result?.subtitleTiming === 'script_estimated')) &&
    result?.subtitlesBurnedIn === true &&
    Number.isFinite(result?.durationSeconds) &&
    Math.abs(result.durationSeconds - durationSeconds) <= 0.25 &&
    /^[a-f0-9]{64}$/u.test(String(result?.sha256 || '')) &&
    Array.isArray(result?.audioVerification) &&
    result.audioVerification.length === durationSeconds / 15 &&
    result.audioVerification.every(
      (check, i) =>
        check?.startSeconds === i * 15 &&
        check?.durationSeconds === 15 &&
        check?.method === 'ffmpeg-volumedetect' &&
        Number.isFinite(check?.peakDb) &&
        check.peakDb > -60,
    )
  );
}

export function publicVoicedSalesProgress(plan, tenantId) {
  if (plan?.workflow !== 'ai_sales_video' || plan?.voiceMode !== 'voiced') return null;
  const text = value => String(value || '').slice(0, 1200);
  const events = Array.isArray(plan.paidExecution) ? plan.paidExecution : [];
  const durationSeconds = plan.durationSeconds ?? 30, segmentCount = plan.model === PROVIDER_360_VIDEO_MODEL ? 1 : durationSeconds / 15;
  const scriptReady = plan.scriptMode === 'model' && plan.script?.shots?.length === durationSeconds / 15;
  const audioMode = plan.audioMode || 'external_tts';
  const verified = voicedSalesDeliveryVerified(plan.result, tenantId, audioMode, durationSeconds);
  return {
    workflow: 'ai_sales_video',
    voiceMode: 'voiced',
    audioMode,
    audioSource: audioMode === 'provider_native' ? 'provider_native' : 'reviewed_tts',
    model: plan.model || 'wan2.6-i2v',
    voiceId: text(plan.voiceId),
    durationSeconds,
    segmentDurationSeconds: durationSeconds / segmentCount,
    segmentCount,
    stage: ['preflight', 'queued', 'script', 'voice', 'video', 'compose', 'recovery', 'complete'].includes(plan.phase)
      ? plan.phase
      : 'preflight',
    scriptMode: scriptReady ? 'model' : 'pending',
    scriptWarnings: Array.isArray(plan.scriptWarnings) ? plan.scriptWarnings.map(text) : [],
    script: scriptReady
      ? {
          hook_3s: text(plan.script.hook_3s),
          cta: text(plan.script.cta),
          shots: plan.script.shots.map((shot, index) => ({
            index: index + 1,
            start: index * 15,
            end: (index + 1) * 15,
            visual: text(shot.visual),
            voiceover: text(shot.voiceover),
            subtitle: text(shot.subtitle),
          })),
        }
      : null,
    segments: (Array.isArray(plan.providerExecution?.segments) ? plan.providerExecution.segments : [])
      .slice(0, segmentCount)
      .map((segment, i) => ({
        index: i + 1,
        durationSeconds: durationSeconds / segmentCount,
        status: ['planned', 'submitting', 'provider_submitted', 'downloaded'].includes(segment?.status)
          ? segment.status
          : 'planned',
      })),
    calls: Object.fromEntries(
      ['text', 'tts', 'video'].map(kind => [kind, events.filter(event => event.kind === kind).length]),
    ),
    learning: {
      benchmarkCount: plan.learning?.benchmarkCardIds?.length || 0,
      evolutionCount: plan.learning?.evolutionNoteIds?.length || 0,
    },
    audioVerified: verified,
    partialResults: (Array.isArray(plan.partialResults) ? plan.partialResults : [])
      .filter(item => Number.isInteger(item?.index) && item.index >= 1 && item.index <= segmentCount
        && new RegExp(`^/uploads/ai-sales-video/${Number(tenantId)}/partial-[a-zA-Z0-9_-]+\\.mp4$`, 'u').test(String(item.url || ''))
        && /^[a-f0-9]{64}$/u.test(String(item.sha256 || ''))
        && Number.isFinite(item.durationSeconds) && item.durationSeconds > 0 && item.durationSeconds <= durationSeconds / segmentCount + 1)
      .slice(0, segmentCount).map(item => ({ index: item.index, url: item.url, durationSeconds: item.durationSeconds,
        sha256: item.sha256, bytes: item.bytes, audioSource: 'provider_native', subtitlesBurnedIn: false })),
    subtitlesBurnedIn: verified,
    subtitleCount: verified && Number.isSafeInteger(plan.result?.subtitleCount) ? plan.result.subtitleCount : 0,
    subtitleTiming: audioMode === 'provider_native' ? 'script_estimated' : 'speech-duration-proportional',
    subtitleNotice:
      audioMode === 'provider_native'
        ? '字幕按脚本分句估时，未经过逐字语音识别；请预览核对中文独白与字幕。'
        : '字幕按原配音时长分句估时；请预览核对。',
    recovering: plan.phase === 'recovery' && plan.recovery?.stage !== 'failed',
    failureCode: /^[A-Z0-9_]{1,100}$/u.test(String(plan.failureCode || '')) ? plan.failureCode : null,
    failureReasons: Array.isArray(plan.failureDetail?.errors)
      ? plan.failureDetail.errors.filter(item => typeof item === 'string' && item).slice(0, 6) : [],
  };
}

export function voicedSalesRecoveryAvailable(job, plan, billing) {
  const duration = plan?.durationSeconds ?? 30, segmentCount = plan?.model === PROVIDER_360_VIDEO_MODEL ? 1 : duration / 15;
  const refundedWithSavedClips = billing?.state === 'released' && plan?.audioMode === 'provider_native'
    && Array.isArray(plan?.partialResults) && plan.partialResults.length === segmentCount
    && plan.partialResults.every((part, i) => part.index === i + 1 && /^[a-f0-9]{64}$/u.test(String(part.sha256 || '')));
  if (
    plan?.voiceMode !== 'voiced' ||
    ![15, 30].includes(duration) ||
    plan?.workflow !== 'ai_sales_video' ||
    !['wan2.6-i2v', PROVIDER_360_VIDEO_MODEL].includes(job?.model) || job?.model !== plan?.model ||
    !['失败', '阻塞', '成功'].includes(job?.status) ||
    (!['held', 'pending_reconciliation', 'settled'].includes(billing?.state) && !refundedWithSavedClips)
  )
    return false;
  if (job.status === '成功' && ['settled', 'released'].includes(billing.state) && plan.phase === 'complete') return false;
  if (job.url === plan.result?.url && voicedSalesDeliveryVerified(plan.result, job.tenant_id, plan.audioMode, duration))
    return true;
  const segments = plan.providerExecution?.segments,
    tracks = plan.voiceTracks;
  return (
    Array.isArray(segments) &&
    segments.length === segmentCount &&
    segments.every(
      (segment, i) => segment.index === i + 1 && /^[\p{L}\p{N}_.+^:/-]{1,500}$/u.test(String(segment.taskId || '')),
    ) &&
    new Set(segments.map(segment => segment.taskId)).size === segmentCount &&
    (plan.audioMode === 'provider_native' ||
      (Array.isArray(tracks) &&
        tracks.length === 2 &&
        tracks.every(
          (track, i) =>
            track.index === i + 1 &&
            Number.isSafeInteger(track.fileId) &&
            track.fileId > 0 &&
            /^[a-f0-9]{64}$/u.test(String(track.sha256 || '')),
        )))
  );
}

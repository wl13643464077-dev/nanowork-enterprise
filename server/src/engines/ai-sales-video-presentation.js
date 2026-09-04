// Business-only projection shared by submission, polling and media review.
// Never return factory prompts, signed provider URLs, local paths or task IDs.
export function voicedSalesDeliveryVerified(result, tenantId) {
  const tid = Number(tenantId);
  return (
    Number.isSafeInteger(tid) &&
    tid > 0 &&
    new RegExp(`^/uploads/ai-sales-video/${tid}/[a-zA-Z0-9_-]+\\.mp4$`, 'u').test(String(result?.url || '')) &&
    result?.audioVerified === true &&
    result?.subtitlesBurnedIn === true &&
    Number.isFinite(result?.durationSeconds) &&
    Math.abs(result.durationSeconds - 30) <= 0.25 &&
    /^[a-f0-9]{64}$/u.test(String(result?.sha256 || '')) &&
    Array.isArray(result?.audioVerification) &&
    result.audioVerification.length === 2 &&
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
  const scriptReady = plan.scriptMode === 'model' && plan.script?.shots?.length === 2;
  const verified = voicedSalesDeliveryVerified(plan.result, tenantId);
  return {
    workflow: 'ai_sales_video',
    voiceMode: 'voiced',
    model: 'wan2.6-i2v',
    voiceId: text(plan.voiceId),
    durationSeconds: 30,
    segmentDurationSeconds: 15,
    segmentCount: 2,
    stage: ['preflight', 'queued', 'script', 'voice', 'video', 'compose', 'recovery', 'complete'].includes(plan.phase)
      ? plan.phase
      : 'preflight',
    scriptMode: scriptReady ? 'model' : 'pending',
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
      .slice(0, 2)
      .map((segment, i) => ({
        index: i + 1,
        durationSeconds: 15,
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
    subtitlesBurnedIn: verified,
    subtitleCount: verified && Number.isSafeInteger(plan.result?.subtitleCount) ? plan.result.subtitleCount : 0,
    subtitleTiming: 'speech-duration-proportional',
    recovering: plan.phase === 'recovery' && plan.recovery?.stage !== 'failed',
    failureCode: /^[A-Z0-9_]{1,100}$/u.test(String(plan.failureCode || '')) ? plan.failureCode : null,
  };
}

export function voicedSalesRecoveryAvailable(job, plan, billing) {
  if (
    plan?.voiceMode !== 'voiced' ||
    plan?.workflow !== 'ai_sales_video' ||
    job?.model !== 'wan2.6-i2v' ||
    !['失败', '阻塞', '成功'].includes(job?.status) ||
    !['held', 'pending_reconciliation', 'settled'].includes(billing?.state)
  )
    return false;
  if (job.status === '成功' && billing.state === 'settled' && plan.phase === 'complete') return false;
  if (job.url === plan.result?.url && voicedSalesDeliveryVerified(plan.result, job.tenant_id)) return true;
  const segments = plan.providerExecution?.segments,
    tracks = plan.voiceTracks;
  return (
    Array.isArray(segments) &&
    segments.length === 2 &&
    segments.every(
      (segment, i) => segment.index === i + 1 && /^[\p{L}\p{N}_.+-]{1,240}$/u.test(String(segment.taskId || '')),
    ) &&
    new Set(segments.map(segment => segment.taskId)).size === 2 &&
    Array.isArray(tracks) &&
    tracks.length === 2 &&
    tracks.every(
      (track, i) =>
        track.index === i + 1 &&
        Number.isSafeInteger(track.fileId) &&
        track.fileId > 0 &&
        /^[a-f0-9]{64}$/u.test(String(track.sha256 || '')),
    )
  );
}

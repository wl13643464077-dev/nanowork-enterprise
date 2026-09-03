import crypto from 'node:crypto';

export const AI_SALES_VIDEO_WORKFLOW = 'ai_sales_video';
export const AI_SALES_VIDEO_EMPLOYEE = Object.freeze({
  idx: 10,
  key: 'commerce_video',
  name: 'AI带货员',
  group: '商业视频工坊',
});
export const AI_SALES_VIDEO_DURATION_SECONDS = 30;
export const AI_SALES_VIDEO_SEGMENT_SECONDS = 10;
export const AI_SALES_VIDEO_SEGMENT_COUNT = 3;
export const AI_SALES_VIDEO_H3_SEGMENT_SECONDS = 15;
export const AI_SALES_VIDEO_H3_SEGMENT_COUNT = 2;
export const AI_SALES_VIDEO_MAX_REFERENCES = 6;

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'AI_SALES_VIDEO_INVALID_INPUT';
  return error;
}

function cleanText(value, field, max = 3000) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw invalid(`${field}不能为空`);
  if (text.length > max) throw invalid(`${field}不能超过${max}字`);
  return text;
}

export function normalizeAiSalesVideoBrief(value) {
  return cleanText(value, '带货 brief', 3000);
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function referenceSnapshot(ref, source = 'file') {
  return {
    source,
    ...(Number.isSafeInteger(Number(ref?.id)) && Number(ref.id) > 0 ? { id: Number(ref.id) } : {}),
    name: String(ref?.name || `${source === 'inline' ? '参考图' : '文件'}`).slice(0, 200),
    ext: ref?.ext ? String(ref.ext).slice(0, 12).toLowerCase() : undefined,
    contentSha256: /^[a-f0-9]{64}$/iu.test(String(ref?.contentSha256 || ''))
      ? String(ref.contentSha256).toLowerCase()
      : hash(ref?.dataUrl || ref?.url || ref?.name || ''),
    // Private file URLs and raw data are intentionally excluded from the
    // persistent snapshot. Provider delivery must use a future signed/stream
    // resolver, never a tenant-private `/uploads` URL copied into a job.
  };
}

function segmentPlan(brief, index, { segmentCount, durationSeconds }) {
  const beats = [
    {
      title: '先抓住注意力',
      scene: '人物出镜或门店外景建立真实场景，快速点出顾客最关心的卖点。',
      voiceover: `开场先回答顾客为什么现在要了解：${brief}`,
    },
    {
      title: '展示产品价值',
      scene: '切到菜品近景、制作细节与门店环境，突出可核验的产品体验。',
      voiceover: '把菜品、分量、口感和到店体验讲清楚；没有依据的价格、评价和效果不在视频中臆造。',
    },
    {
      title: '给出行动入口',
      scene: '人物回到镜头前，明确到店、咨询或预约动作，收束品牌记忆点。',
      voiceover: '如果这正是你要找的体验，欢迎按门店实际营业信息咨询或到店；发布前请完成事实与人工审核。',
    },
  ];
  const beat = beats[index] || beats[beats.length - 1];
  const twoPartVoiceover = index === 1 && segmentCount === 2
    ? `${beats[1].voiceover}结尾补上行动入口：${beats[2].voiceover}`
    : beat.voiceover;
  return {
    index: index + 1,
    durationSeconds,
    title: beat.title,
    scene: beat.scene,
    voiceover: twoPartVoiceover,
    status: 'planned',
  };
}

/**
 * Build a deterministic, reviewable sales-video script and model-aware
 * state machine (H3 2×15s, Hailuo 3×10s). This is template-mode: it does not spend text
 * credits or claim that an LLM/provider has generated a script.
 */
export function buildAiSalesVideoPlan({ brief, references = [], model = 'MiniMax-Hailuo-2.3' } = {}) {
  const normalizedBrief = normalizeAiSalesVideoBrief(brief);
  if (!Array.isArray(references) || references.length < 1) throw invalid('至少上传1张人物、菜品或门店参考图');
  if (references.length > AI_SALES_VIDEO_MAX_REFERENCES) throw invalid(`一次最多上传${AI_SALES_VIDEO_MAX_REFERENCES}张参考图`);
  const refSnapshot = references.map((ref) => referenceSnapshot(ref, ref?.source || (ref?.dataUrl ? 'inline' : 'file')));
  const h3 = String(model || '').trim() === 'MiniMax-H3';
  const segmentDurationSeconds = h3
    ? AI_SALES_VIDEO_H3_SEGMENT_SECONDS
    : AI_SALES_VIDEO_SEGMENT_SECONDS;
  const segmentCount = h3
    ? AI_SALES_VIDEO_H3_SEGMENT_COUNT
    : AI_SALES_VIDEO_SEGMENT_COUNT;
  const segments = Array.from(
    { length: segmentCount },
    (_, index) => segmentPlan(normalizedBrief, index, { segmentCount, durationSeconds: segmentDurationSeconds }),
  );
  return {
    workflow: AI_SALES_VIDEO_WORKFLOW,
    employee: { ...AI_SALES_VIDEO_EMPLOYEE },
    model: String(model || '').trim(),
    durationSeconds: AI_SALES_VIDEO_DURATION_SECONDS,
    segmentDurationSeconds,
    segmentCount,
    brief: normalizedBrief,
    scriptMode: 'template',
    script: {
      hook: segments[0].voiceover,
      value: segments[1].voiceover,
      cta: (segments[2] || segments[1]).voiceover,
    },
    references: refSnapshot,
    segments,
    composer: {
      required: true,
      status: 'authorization_required',
      reason: `30秒成片需要${segmentCount}段${segmentDurationSeconds}秒视频、真实供应商结果与本地安全合成。`,
    },
    providerCalls: 0,
  };
}

/**
 * Execute only when an explicit, tested composer is supplied. The default
 * route supplies no composer and therefore returns `blocked` without calling
 * a paid provider. Unit tests can inject both functions to verify the exact
 * segment orchestration without networking or real credits.
 */
export async function executeAiSalesVideoPlan({
  plan,
  submitSegment,
  resolveSegment,
  downloadSegment,
  compose,
  onProviderInvocationStarted,
  onSegmentState,
} = {}) {
  if (!plan || plan.workflow !== AI_SALES_VIDEO_WORKFLOW) throw invalid('带货视频计划无效');
  if (typeof submitSegment !== 'function' || typeof compose !== 'function') {
    return {
      status: 'blocked',
      providerCalls: 0,
      reason: plan.composer?.reason || '合成器未就绪',
      segments: plan.segments.map(segment => ({ ...segment, status: 'blocked' })),
      url: null,
    };
  }
  const completed = [];
  for (const segment of plan.segments) {
    let output = null;
    let providerTaskId = null;
    let invocationStarted = false;
    try {
      // The durable marker is awaited before the paid provider call. If the
      // marker cannot be persisted, submitSegment is never invoked and the
      // caller can still prove that releasing the hold is safe.
      if (typeof onProviderInvocationStarted === 'function') {
        await onProviderInvocationStarted({
          segment,
          model: plan.model,
        });
      }
      invocationStarted = true;
      output = await submitSegment({
        segment,
        prompt: `${plan.brief}\n镜头段落：${segment.title}\n${segment.scene}\n${segment.voiceover}`,
        durationSeconds: segment.durationSeconds,
        references: plan.references,
        model: plan.model,
      });
      if (!output?.url && !output?.taskId) {
        const error = new Error(`第${segment.index}段视频未返回任务或交付地址`);
        error.code = 'AI_SALES_VIDEO_SEGMENT_SUBMIT_FAILED';
        throw error;
      }
      providerTaskId = output.taskId || null;
      if (typeof onSegmentState === 'function') {
        await onSegmentState({
          segment,
          status: output.url ? 'provider_ready' : 'provider_submitted',
          taskId: output.taskId || null,
        });
      }
      if (!output.url) {
        if (typeof resolveSegment !== 'function') {
          const error = new Error(`第${segment.index}段视频仍在生成，但未配置任务轮询器`);
          error.code = 'AI_SALES_VIDEO_SEGMENT_RESOLVER_MISSING';
          throw error;
        }
        output = await resolveSegment({
          ...output,
          segment,
          model: plan.model,
        });
        output = {
          ...output,
          taskId: output?.taskId || providerTaskId,
        };
        if (!output?.url) {
          const error = new Error(`第${segment.index}段视频未取得可交付地址`);
          error.code = 'AI_SALES_VIDEO_SEGMENT_NOT_READY';
          throw error;
        }
        if (typeof onSegmentState === 'function') {
          await onSegmentState({
            segment,
            status: 'provider_ready',
            taskId: output.taskId || null,
          });
        }
      }
      const local = typeof downloadSegment === 'function'
        ? await downloadSegment({ ...output, segment, model: plan.model })
        : null;
      if (typeof onSegmentState === 'function') {
        await onSegmentState({
          segment,
          status: 'downloaded',
          taskId: output.taskId || null,
        });
      }
      completed.push({
        ...segment,
        status: 'ready',
        taskId: output.taskId || null,
        url: output.url,
        ...(local?.path || local?.absolutePath
          ? { localPath: local.path || local.absolutePath, download: local }
          : {}),
      });
    } catch (error) {
      if (invocationStarted && typeof onSegmentState === 'function') {
        try {
          await onSegmentState({
            segment,
            status: 'failed',
            taskId: output?.taskId || providerTaskId,
          });
        } catch {
          // Preserve the provider/processing error. The caller already has a
          // durable invocation marker and will retain the hold for reconciliation.
        }
      }
      throw error;
    }
  }
  const composed = await compose({ plan, segments: completed });
  if (!composed?.url) {
    const error = new Error('三段视频已提交，但合成器未返回可交付地址');
    error.code = 'AI_SALES_VIDEO_COMPOSITION_FAILED';
    throw error;
  }
  return {
    status: 'success',
    providerCalls: completed.length,
    reason: '',
    segments: completed.map(segment => ({ ...segment, status: 'composed' })),
    url: composed.url,
    // 服务器内部用于交付校验与失败清理；对外响应必须经路由投影脱敏。
    composition: composed,
  };
}

export function blockedAiSalesVideoResponse(plan, reason = plan?.composer?.reason) {
  return {
    status: 'blocked',
    workflow: AI_SALES_VIDEO_WORKFLOW,
    durationSeconds: AI_SALES_VIDEO_DURATION_SECONDS,
    providerCalls: 0,
    reason: String(reason || '当前未启用安全合成器'),
    plan,
  };
}

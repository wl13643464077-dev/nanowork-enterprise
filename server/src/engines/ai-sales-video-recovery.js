import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AI_SALES_VIDEO_TARGET_DURATION_SECONDS,
  composeAiSalesVideo,
} from './video-composer.js';
import { downloadProviderVideoClip } from './video-provider-download.js';

export const AI_SALES_VIDEO_RECOVERY_SCHEMA = 'nanowork.ai-sales-video-recovery/1';
export const AI_SALES_VIDEO_PROVIDER_PROGRESS_SCHEMA = 'nanowork.ai-sales-video-provider-progress/1';

const AI_SALES_VIDEO_WORKFLOW = 'ai_sales_video';
const ALLOWED_SEGMENT_COUNTS = new Set([2, 3]);
const PROVIDER_FAILURE_STATES = new Set([
  'fail',
  'failed',
  'error',
  'cancelled',
  'canceled',
]);
const SAFE_PROVIDER_TASK_ID = /^[\p{L}\p{N}_.:+-]+$/u;
const SAFE_OUTPUT_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}\.mp4$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export class AiSalesVideoRecoveryError extends Error {
  constructor(message, {
    code = 'AI_SALES_VIDEO_RECOVERY_FAILED',
    status = 502,
    retryable = true,
    phase = 'recovery',
    segmentIndex = null,
    cause,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AiSalesVideoRecoveryError';
    this.code = code;
    this.status = status;
    this.retryable = retryable === true;
    this.phase = phase;
    this.segmentIndex = Number.isSafeInteger(Number(segmentIndex))
      ? Number(segmentIndex)
      : null;
  }
}
function recoveryError(message, options) {
  return new AiSalesVideoRecoveryError(message, options);
}

function invalid(message, code = 'AI_SALES_VIDEO_RECOVERY_INVALID_INPUT') {
  return recoveryError(message, {
    code,
    status: 400,
    retryable: false,
    phase: 'validation',
  });
}

export function safeAiSalesVideoProviderTaskId(value) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return null;
  const taskId = String(value).trim();
  if (!taskId || taskId.length > 240) return null;
  if (/^(?:https?:|data:|file:)/iu.test(taskId) || /[\\/]/u.test(taskId)) return null;
  return SAFE_PROVIDER_TASK_ID.test(taskId) ? taskId : null;
}

function safeTenantId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/u.test(text)) throw invalid('tenantId必须是正整数');
  const tenantId = Number(text);
  if (!Number.isSafeInteger(tenantId) || tenantId < 1 || tenantId > 2_147_483_647) {
    throw invalid('tenantId必须是有效正整数');
  }
  return tenantId;
}

function safeModel(value) {
  const model = String(value || '').trim();
  if (!model || model.length > 160 || /[\u0000-\u001f\u007f]/u.test(model)) {
    throw invalid('带货视频计划缺少有效模型');
  }
  return model;
}

function normalizedRecoveryInput({ plan, providerExecution, tenantId }) {
  const resolvedTenantId = safeTenantId(tenantId);
  if (!plan || typeof plan !== 'object' || plan.workflow !== AI_SALES_VIDEO_WORKFLOW) {
    throw invalid('带货视频恢复计划无效');
  }
  const model = safeModel(plan.model);
  if (!Array.isArray(plan.segments) || !ALLOWED_SEGMENT_COUNTS.has(plan.segments.length)) {
    throw invalid('带货视频恢复必须包含2或3个分段');
  }

  const segments = plan.segments.map((segment, offset) => {
    const index = Number(segment?.index);
    const durationSeconds = Number(segment?.durationSeconds);
    if (!Number.isSafeInteger(index) || index !== offset + 1) {
      throw invalid('带货视频分段编号必须从1连续排列');
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 30) {
      throw invalid(`第${index}段时长无效`);
    }
    return { index, durationSeconds };
  });
  const duration = segments.reduce((total, segment) => total + segment.durationSeconds, 0);
  if (Math.abs(duration - AI_SALES_VIDEO_TARGET_DURATION_SECONDS) > 0.01) {
    throw invalid('带货视频分段总时长必须为30秒');
  }

  const providerSegments = Array.isArray(providerExecution?.segments)
    ? providerExecution.segments
    : [];
  if (providerSegments.length !== segments.length) {
    throw invalid('已有供应商任务数量与视频分段不匹配');
  }
  const byIndex = new Map();
  for (const item of providerSegments) {
    const index = Number(item?.index);
    if (!Number.isSafeInteger(index) || byIndex.has(index)) {
      throw invalid('已有供应商任务的分段编号无效');
    }
    byIndex.set(index, item);
  }
  const seenTaskIds = new Set();
  const recoverableSegments = segments.map((segment) => {
    const taskId = safeAiSalesVideoProviderTaskId(byIndex.get(segment.index)?.taskId);
    if (!taskId) {
      throw invalid(
        `第${segment.index}段缺少可安全复用的供应商taskId`,
        'AI_SALES_VIDEO_RECOVERY_TASK_ID_INVALID',
      );
    }
    if (seenTaskIds.has(taskId)) {
      throw invalid(
        '已有供应商taskId重复，禁止合成不完整成片',
        'AI_SALES_VIDEO_RECOVERY_TASK_ID_DUPLICATE',
      );
    }
    seenTaskIds.add(taskId);
    return { ...segment, taskId };
  });
  return {
    tenantId: resolvedTenantId,
    model,
    segments: recoverableSegments,
    invocationCount: Math.max(
      recoverableSegments.length,
      Number.isSafeInteger(Number(providerExecution?.invocationCount))
        ? Number(providerExecution.invocationCount)
        : 0,
    ),
  };
}

function abortError(phase, segmentIndex = null) {
  return recoveryError('已取消本次已有视频恢复，可稍后重试', {
    code: 'AI_SALES_VIDEO_RECOVERY_ABORTED',
    status: 499,
    retryable: true,
    phase,
    segmentIndex,
  });
}

function assertNotAborted(signal, phase, segmentIndex = null) {
  if (signal?.aborted) throw abortError(phase, segmentIndex);
}

async function sleepWithSignal(ms, signal, sleep, segmentIndex) {
  assertNotAborted(signal, 'query', segmentIndex);
  if (!signal) {
    await sleep(ms);
    return;
  }
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError('query', segmentIndex));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => sleep(ms))
      .then(() => finish(resolve), () => finish(
        reject,
        recoveryError('等待供应商任务状态时失败，可重试', {
          code: 'AI_SALES_VIDEO_RECOVERY_WAIT_FAILED',
          status: 502,
          retryable: true,
          phase: 'query',
          segmentIndex,
        }),
      ));
  });
}

async function resolveExistingProviderTask({
  segment,
  model,
  query,
  signal,
  timeoutMs,
  intervalMs,
  sleep,
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    assertNotAborted(signal, 'query', segment.index);
    let output;
    try {
      output = await query({
        taskId: segment.taskId,
        model,
        signal: signal || undefined,
      });
    } catch (cause) {
      if (signal?.aborted || cause?.name === 'AbortError' || Number(cause?.status) === 499) {
        throw abortError('query', segment.index);
      }
      throw recoveryError(`第${segment.index}段已有供应商任务查询失败，可重试`, {
        code: 'AI_SALES_VIDEO_RECOVERY_QUERY_FAILED',
        status: 502,
        retryable: true,
        phase: 'query',
        segmentIndex: segment.index,
        cause,
      });
    }
    const status = String(output?.status || output?.state || '').trim().toLowerCase();
    if (PROVIDER_FAILURE_STATES.has(status)) {
      throw recoveryError(`第${segment.index}段已有供应商任务已失败，无法直接恢复`, {
        code: 'AI_SALES_VIDEO_RECOVERY_PROVIDER_TASK_FAILED',
        status: 409,
        retryable: false,
        phase: 'query',
        segmentIndex: segment.index,
      });
    }
    if (typeof output?.url === 'string' && output.url.trim()) {
      return { url: output.url.trim() };
    }
    if (Date.now() - startedAt >= timeoutMs) break;
    await sleepWithSignal(intervalMs, signal, sleep, segment.index);
  }
  throw recoveryError(`第${segment.index}段已有供应商任务仍未就绪，可稍后重试`, {
    code: 'AI_SALES_VIDEO_RECOVERY_QUERY_TIMEOUT',
    status: 504,
    retryable: true,
    phase: 'query',
    segmentIndex: segment.index,
  });
}

function safeDownloadPath(download, tempDir, segmentIndex) {
  const candidate = typeof download?.path === 'string'
    ? download.path
    : download?.absolutePath;
  if (!candidate || !path.isAbsolute(candidate) || path.resolve(candidate) !== candidate) {
    throw recoveryError(`第${segmentIndex}段下载未形成安全的本地视频，可重试`, {
      code: 'AI_SALES_VIDEO_RECOVERY_DOWNLOAD_INVALID',
      status: 502,
      retryable: true,
      phase: 'download',
      segmentIndex,
    });
  }
  const relative = path.relative(tempDir, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw recoveryError(`第${segmentIndex}段下载产物超出本次隔离目录，已拒绝合成`, {
      code: 'AI_SALES_VIDEO_RECOVERY_DOWNLOAD_PATH_UNSAFE',
      status: 502,
      retryable: false,
      phase: 'download',
      segmentIndex,
    });
  }
  return candidate;
}

function safeSha256(value) {
  const digest = String(value || '').trim().toLowerCase();
  return SHA256.test(digest) ? digest : null;
}

function safeOutputUrl(value, tenantId) {
  const url = String(value || '').trim();
  const prefix = `/uploads/ai-sales-video/${tenantId}/`;
  if (!url.startsWith(prefix)) return null;
  const filename = url.slice(prefix.length);
  return SAFE_OUTPUT_FILENAME.test(filename) ? url : null;
}

function publicComposition(composition, tenantId, segmentCount) {
  const url = safeOutputUrl(composition?.url, tenantId);
  const durationSeconds = Number(composition?.durationSeconds ?? composition?.duration);
  const width = Number(composition?.width);
  const height = Number(composition?.height);
  const videoCodec = String(composition?.videoCodec || '').toLowerCase();
  const audioCodec = String(composition?.audioCodec || '').toLowerCase();
  const compositionSegmentCount = Number(composition?.segmentCount ?? segmentCount);
  if (!url
    || !Number.isFinite(durationSeconds)
    || Math.abs(durationSeconds - AI_SALES_VIDEO_TARGET_DURATION_SECONDS) > 1.5
    || width !== 1080
    || height !== 1920
    || !['h264', 'avc1'].includes(videoCodec)
    || audioCodec !== 'aac'
    || compositionSegmentCount !== segmentCount) {
    throw recoveryError('已有片段完成合成，但成片未通过30秒竖版交付校验，可重试', {
      code: 'AI_SALES_VIDEO_RECOVERY_COMPOSITION_INVALID',
      status: 502,
      retryable: true,
      phase: 'compose',
    });
  }
  return {
    url,
    sha256: safeSha256(composition?.sha256),
    durationSeconds,
    width,
    height,
    videoCodec: 'h264',
    audioCodec: 'aac',
    segmentCount,
  };
}

function createProgressFactory({ model, segments, invocationCount }) {
  const startedAt = new Date().toISOString();
  const states = new Map(segments.map(segment => [segment.index, 'provider_submitted']));
  return {
    set(index, status) {
      if (states.has(index)) states.set(index, status);
    },
    snapshot(stage, {
      retryable = null,
      errorCode = null,
      segmentIndex = null,
    } = {}) {
      const updatedAt = new Date().toISOString();
      return {
        schemaVersion: AI_SALES_VIDEO_PROVIDER_PROGRESS_SCHEMA,
        updatedAt,
        lastActivityAt: updatedAt,
        invocationStarted: true,
        invocationCount,
        segments: segments.map(segment => ({
          index: segment.index,
          durationSeconds: segment.durationSeconds,
          status: states.get(segment.index),
          taskId: segment.taskId,
        })),
        recovery: {
          schemaVersion: AI_SALES_VIDEO_RECOVERY_SCHEMA,
          mode: 'reuse_existing_provider_tasks',
          stage,
          model,
          providerSubmissions: 0,
          reusedTaskCount: segments.length,
          startedAt,
          updatedAt,
          ...(retryable == null ? {} : { retryable: retryable === true }),
          ...(errorCode ? { errorCode: String(errorCode).slice(0, 120) } : {}),
          ...(Number.isSafeInteger(Number(segmentIndex))
            ? { segmentIndex: Number(segmentIndex) }
            : {}),
        },
      };
    },
  };
}

async function emitProgress(onProgress, progress) {
  if (typeof onProgress !== 'function') return;
  try {
    await onProgress(progress);
  } catch (cause) {
    throw recoveryError('视频恢复进度未能安全落库，已停止后续处理，可重试', {
      code: 'AI_SALES_VIDEO_RECOVERY_PROGRESS_PERSIST_FAILED',
      status: 500,
      retryable: true,
      phase: 'persistence',
      cause,
    });
  }
}

function normalizeUnexpectedError(error, phase, segmentIndex) {
  if (error instanceof AiSalesVideoRecoveryError) return error;
  if (error?.name === 'AbortError' || Number(error?.status) === 499) {
    return abortError(phase, segmentIndex);
  }
  const phaseLabels = {
    query: '查询已有供应商任务',
    download: '下载已有视频片段',
    compose: '合成30秒成片',
    persistence: '保存恢复进度',
  };
  return recoveryError(`${phaseLabels[phase] || '恢复已有视频'}失败，未发起新的供应商生成，可重试`, {
    code: `AI_SALES_VIDEO_RECOVERY_${String(phase || 'recovery').toUpperCase()}_FAILED`,
    status: 502,
    retryable: true,
    phase,
    segmentIndex,
    cause: error,
  });
}

/**
 * Rebuild a 30-second AI sales video only from durable provider task IDs.
 *
 * There is deliberately no submit callback or provider-submit import in this
 * module. Recovery may query, download and compose existing results; it can
 * never create another paid provider task. Every progress/result projection
 * is safe for persistence and excludes provider URLs and local file paths.
 */
export async function recoverAiSalesVideoFromExistingTasks({
  plan,
  providerExecution,
  tenantId,
  query,
  download = downloadProviderVideoClip,
  compose = composeAiSalesVideo,
  signal = null,
  timeoutMs = 12 * 60 * 1000,
  intervalMs = 5000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onProgress = null,
  fetchImpl,
} = {}) {
  const input = normalizedRecoveryInput({ plan, providerExecution, tenantId });
  if (typeof query !== 'function') {
    throw invalid('已有供应商任务查询器未配置', 'AI_SALES_VIDEO_RECOVERY_QUERY_MISSING');
  }
  if (typeof download !== 'function' || typeof compose !== 'function' || typeof sleep !== 'function') {
    throw invalid('带货视频恢复器配置不完整', 'AI_SALES_VIDEO_RECOVERY_RUNTIME_INVALID');
  }
  const queryTimeoutMs = Number(timeoutMs);
  const queryIntervalMs = Number(intervalMs);
  if (!Number.isFinite(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 24 * 60 * 60 * 1000
    || !Number.isFinite(queryIntervalMs) || queryIntervalMs < 1 || queryIntervalMs > 60 * 1000) {
    throw invalid('带货视频恢复轮询参数无效', 'AI_SALES_VIDEO_RECOVERY_POLL_INVALID');
  }

  const progressFactory = createProgressFactory(input);
  let progress = progressFactory.snapshot('starting');
  let phase = 'query';
  let segmentIndex = null;
  let tempDir = null;
  try {
    assertNotAborted(signal, 'starting');
    await emitProgress(onProgress, progress);
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nanowork-ai-sales-recovery-'));
    const downloaded = [];
    for (const segment of input.segments) {
      segmentIndex = segment.index;
      phase = 'query';
      progress = progressFactory.snapshot('querying', { segmentIndex });
      await emitProgress(onProgress, progress);
      const provider = await resolveExistingProviderTask({
        segment,
        model: input.model,
        query,
        signal,
        timeoutMs: queryTimeoutMs,
        intervalMs: queryIntervalMs,
        sleep,
      });
      progressFactory.set(segment.index, 'provider_ready');
      progress = progressFactory.snapshot('downloading', { segmentIndex });
      await emitProgress(onProgress, progress);

      phase = 'download';
      assertNotAborted(signal, phase, segmentIndex);
      let local;
      try {
        local = await download({
          url: provider.url,
          outputDir: tempDir,
          index: segment.index,
          signal: signal || undefined,
          ...(fetchImpl === undefined ? {} : { fetchImpl }),
        });
      } catch (cause) {
        if (signal?.aborted || cause?.name === 'AbortError' || Number(cause?.status) === 499) {
          throw abortError(phase, segmentIndex);
        }
        throw recoveryError(`第${segment.index}段已有视频下载失败，未重新生成，可重试`, {
          code: 'AI_SALES_VIDEO_RECOVERY_DOWNLOAD_FAILED',
          status: 502,
          retryable: true,
          phase,
          segmentIndex,
          cause,
        });
      }
      assertNotAborted(signal, phase, segmentIndex);
      const localPath = safeDownloadPath(local, tempDir, segment.index);
      progressFactory.set(segment.index, 'downloaded');
      downloaded.push({
        index: segment.index,
        durationSeconds: segment.durationSeconds,
        taskId: segment.taskId,
        localPath,
        sourceSha256: safeSha256(local?.sha256),
      });
      progress = progressFactory.snapshot('downloading', { segmentIndex });
      await emitProgress(onProgress, progress);
    }

    phase = 'compose';
    segmentIndex = null;
    assertNotAborted(signal, phase);
    progress = progressFactory.snapshot('composing');
    await emitProgress(onProgress, progress);
    let composition;
    try {
      composition = await compose({
        tenantId: input.tenantId,
        segments: downloaded.map(segment => segment.localPath),
        targetDurationSeconds: AI_SALES_VIDEO_TARGET_DURATION_SECONDS,
        signal: signal || undefined,
      });
    } catch (cause) {
      if (signal?.aborted || cause?.name === 'AbortError' || Number(cause?.status) === 499) {
        throw abortError(phase);
      }
      throw recoveryError('已有视频片段合成失败，未重新生成，可重试', {
        code: 'AI_SALES_VIDEO_RECOVERY_COMPOSE_FAILED',
        status: 502,
        retryable: true,
        phase,
        cause,
      });
    }
    assertNotAborted(signal, phase);
    const safeComposition = publicComposition(composition, input.tenantId, input.segments.length);
    progress = progressFactory.snapshot('completed', { retryable: false });
    await emitProgress(onProgress, progress);

    const result = {
      status: 'success',
      url: safeComposition.url,
      durationSeconds: AI_SALES_VIDEO_TARGET_DURATION_SECONDS,
      providerCalls: 0,
      reusedProviderTasks: input.segments.length,
      segments: downloaded.map(segment => ({
        index: segment.index,
        durationSeconds: segment.durationSeconds,
        status: 'composed',
        taskId: segment.taskId,
        sourceSha256: segment.sourceSha256,
      })),
      composition: {
        sha256: safeComposition.sha256,
        durationSeconds: safeComposition.durationSeconds,
        width: safeComposition.width,
        height: safeComposition.height,
        videoCodec: safeComposition.videoCodec,
        audioCodec: safeComposition.audioCodec,
        segmentCount: safeComposition.segmentCount,
      },
      recovery: {
        schemaVersion: AI_SALES_VIDEO_RECOVERY_SCHEMA,
        mode: 'reuse_existing_provider_tasks',
        providerSubmissions: 0,
        reusedTaskCount: input.segments.length,
      },
    };
    return {
      status: 'success',
      url: result.url,
      result,
      providerExecution: progress,
    };
  } catch (error) {
    const normalized = normalizeUnexpectedError(error, phase, segmentIndex);
    const failedProgress = progressFactory.snapshot('failed', {
      retryable: normalized.retryable,
      errorCode: normalized.code,
      segmentIndex: normalized.segmentIndex,
    });
    normalized.progress = failedProgress;
    try {
      await emitProgress(onProgress, failedProgress);
    } catch {
      // Preserve the primary recovery failure. Its attached progress remains
      // safe for a caller to persist even when the callback is unavailable.
    }
    throw normalized;
  } finally {
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

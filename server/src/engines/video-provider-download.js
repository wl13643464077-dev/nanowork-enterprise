import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 180 * 1024 * 1024;

function downloadError(message, status = 502, code = 'VIDEO_PROVIDER_DOWNLOAD_FAILED') {
  return Object.assign(new Error(message), { status, code });
}

function safeHttpsUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw downloadError('视频供应商返回的下载地址无效');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw downloadError('视频供应商下载地址必须是无凭据的HTTPS地址');
  }
  return parsed;
}

/**
 * Download one provider clip into a caller-owned temporary directory. The
 * production path only accepts HTTPS and caps bytes before writing; tests may
 * inject fetchImpl without opening a network connection.
 */
export async function downloadProviderVideoClip({
  url,
  outputDir,
  index = 1,
  fetchImpl = globalThis.fetch,
  signal = null,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const parsed = safeHttpsUrl(url);
  if (typeof fetchImpl !== 'function') throw downloadError('视频下载器未配置');
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || outputDir.includes('\0')) {
    throw downloadError('视频临时目录无效', 500, 'VIDEO_DOWNLOAD_DIRECTORY_INVALID');
  }
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit < 1024 || limit > 1024 * 1024 * 1024) {
    throw downloadError('视频下载大小上限无效', 500, 'VIDEO_DOWNLOAD_LIMIT_INVALID');
  }
  await fsp.mkdir(outputDir, { recursive: true });
  const fileName = `segment-${Number(index) || 1}-${crypto.randomBytes(10).toString('hex')}.mp4`;
  const filePath = path.join(outputDir, fileName);
  let response;
  try {
    response = await fetchImpl(parsed, {
      method: 'GET',
      redirect: 'follow',
      signal: signal || undefined,
      headers: { Accept: 'video/*,application/octet-stream;q=0.8' },
    });
    if (!response?.ok) throw downloadError(`视频片段下载失败（HTTP ${Number(response?.status || 0) || '未知'}）`);
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > limit) {
      throw downloadError('视频片段超过安全大小上限', 413, 'VIDEO_PROVIDER_DOWNLOAD_TOO_LARGE');
    }
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType && !contentType.startsWith('video/') && !contentType.includes('octet-stream')) {
      throw downloadError('视频供应商返回的文件类型不是视频');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw downloadError('视频供应商返回了空文件');
    if (bytes.length > limit) {
      throw downloadError('视频片段超过安全大小上限', 413, 'VIDEO_PROVIDER_DOWNLOAD_TOO_LARGE');
    }
    await fsp.writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
    return {
      path: filePath,
      absolutePath: filePath,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      contentType: contentType || 'application/octet-stream',
    };
  } catch (error) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    if (error?.code?.startsWith('VIDEO_')) throw error;
    throw downloadError(error?.name === 'AbortError'
      ? '视频片段下载超时或已取消'
      : `视频片段下载失败：${String(error?.message || error).slice(0, 180)}`);
  }
}

export async function waitForProviderVideo({
  taskId,
  model,
  query,
  timeoutMs = 12 * 60 * 1000,
  intervalMs = 5000,
  signal = null,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!String(taskId || '').trim() || typeof query !== 'function') {
    throw downloadError('视频任务轮询参数不完整', 500, 'VIDEO_PROVIDER_POLL_INVALID');
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (signal?.aborted) throw downloadError('视频任务已取消', 499, 'VIDEO_PROVIDER_POLL_CANCELLED');
    const result = await query({ taskId, model, signal });
    const status = String(result?.status || '').toLowerCase();
    if (result?.url) return result;
    if (['fail', 'failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      throw downloadError('视频供应商任务生成失败');
    }
    await sleep(Math.max(250, Number(intervalMs) || 5000));
  }
  throw downloadError('视频供应商任务超时', 504, 'VIDEO_PROVIDER_POLL_TIMEOUT');
}

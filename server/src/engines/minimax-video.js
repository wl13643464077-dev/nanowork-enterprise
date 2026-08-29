import { providerResponseError, sanitizeProviderError } from './provider-errors.js';

// MiniMax's Hailuo endpoints exposed by the Yunwu connector currently accept
// short asynchronous jobs.  Keep the model/capability contract here so the
// route and the provider adapter share one source of truth.  The 30-second
// sales-video workflow deliberately composes three 10-second plans above this
// layer; this adapter never lies about a provider returning a 30-second file.
export const MINIMAX_HAILUO_MODELS = Object.freeze([
  'MiniMax-Hailuo-2.3-Fast',
  'MiniMax-Hailuo-2.3',
  'MiniMax-Hailuo-02',
]);
export const MINIMAX_H3_MODEL = 'MiniMax-H3';
export const MINIMAX_HAILUO_DURATIONS = Object.freeze([6, 10]);
export const MINIMAX_H3_DURATIONS = Object.freeze([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

function safeBaseUrl(value = '') {
  const raw = String(value || '').trim().replace(/\/+$/u, '');
  return raw.replace(/\/v1$/iu, '');
}

function missingCredentials() {
  const error = new Error('MiniMax 视频通道未配置云雾凭证');
  error.status = 503;
  error.code = 'PROVIDER_CREDENTIALS_MISSING';
  return error;
}

function disabledH3() {
  const error = new Error('MiniMax H3 尚未完成云雾路由与价格核验，暂不开放调用');
  error.status = 403;
  error.code = 'MINIMAX_H3_DISABLED';
  return error;
}

function invalidInput(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'MINIMAX_INVALID_INPUT';
  return error;
}

function assertModel(model, h3Enabled) {
  const id = String(model || '').trim();
  if (MINIMAX_HAILUO_MODELS.includes(id)) return id;
  if (id === MINIMAX_H3_MODEL && h3Enabled) return id;
  if (id === MINIMAX_H3_MODEL) throw disabledH3();
  throw invalidInput(`MiniMax 视频模型未开放：${id || '未指定'}`);
}

function durationFor(model, duration) {
  const n = Number(duration);
  const allowed = model === MINIMAX_H3_MODEL ? MINIMAX_H3_DURATIONS : MINIMAX_HAILUO_DURATIONS;
  if (!Number.isInteger(n) || !allowed.includes(n)) {
    throw invalidInput(`${model} 仅支持 ${allowed.join('、')} 秒视频任务`);
  }
  return n;
}

function taskIdFrom(payload = {}) {
  return payload.task_id || payload.taskId || payload.id || payload.data?.task_id || payload.data?.id || '';
}

function statusFrom(payload = {}) {
  return payload.status || payload.state || payload.task_status || payload.data?.status || payload.data?.task_status || '';
}

function urlFrom(payload = {}) {
  return payload.url
    || payload.video_url
    || payload.download_url
    || payload.content?.url
    || payload.content?.video_url
    || payload.task?.content?.url
    || payload.data?.url
    || payload.data?.video_url
    || payload.file?.download_url
    || payload.file?.backup_download_url
    || null;
}

function normalizedTask(payload, model, fallbackTaskId = '') {
  const taskId = String(taskIdFrom(payload) || fallbackTaskId || '');
  const rawStatus = String(statusFrom(payload) || payload.task?.status || '').toLowerCase();
  const url = urlFrom(payload);
  const failed = ['fail', 'failed', 'error', 'cancelled', 'canceled'].includes(rawStatus);
  const complete = Boolean(url) || ['success', 'succeed', 'succeeded', 'complete', 'completed'].includes(rawStatus);
  return {
    model,
    taskId,
    url: url || null,
    status: failed ? 'Fail' : complete ? 'Success' : (rawStatus || 'Processing'),
    ready: Boolean(url),
    raw: failed
      ? '视频任务失败，上游未返回可交付结果'
      : complete && url ? '视频任务已完成' : '任务已提交，视频将在后台继续生成',
  };
}

function h3Content({ prompt, images = [] }) {
  const content = [{ type: 'text', text: String(prompt || '').slice(0, 7000) }];
  images.forEach((url, index) => {
    content.push({
      type: 'image_url',
      image_url: { url: String(url) },
      role: index === 0 ? 'first_frame' : 'reference_image',
    });
  });
  return content;
}

/**
 * Create a transport with injectable fetch for unit tests.  The production
 * caller passes the existing Yunwu base URL/key; this module never reads or
 * stores credentials itself.  A missing key is rejected before fetch, which
 * makes the default test transport fail closed without network access.
 */
export function createMiniMaxVideoTransport({
  baseUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
  h3Enabled = false,
  timeoutMs = 60_000,
  hailuoSubmitPath = '/minimax/v1/video_generation',
  hailuoQueryPath = '/minimax/v1/query/video_generation',
  hailuoRetrievePath = '/minimax/v1/files/retrieve',
} = {}) {
  const root = safeBaseUrl(baseUrl);
  const key = String(apiKey || '').trim();
  const request = async (path, { method = 'GET', body, signal } = {}) => {
    if (!key) throw missingCredentials();
    if (typeof fetchImpl !== 'function') throw new Error('MiniMax 测试传输未提供 fetch 实现');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 60_000));
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    try {
      const response = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(body == null ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body == null ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw providerResponseError(response.status, payload, { service: 'MiniMax 视频服务' });
      return payload;
    } catch (error) {
      if (error?.code === 'PROVIDER_CREDENTIALS_MISSING' || error?.code === 'MINIMAX_H3_DISABLED') throw error;
      throw sanitizeProviderError(error, { service: 'MiniMax 视频服务' });
    } finally {
      clearTimeout(timer);
    }
  };

  return Object.freeze({
    async submit({ model, prompt, images = [], duration = 10, resolution = '768P', signal } = {}) {
      const id = assertModel(model, h3Enabled);
      const refs = Array.isArray(images) ? images.filter(Boolean).slice(0, 9) : [];
      const seconds = durationFor(id, duration);
      if (!String(prompt || '').trim()) throw invalidInput('MiniMax 视频提示词不能为空');
      let payload;
      let path = hailuoSubmitPath;
      if (id === MINIMAX_H3_MODEL) {
        path = '/v2/video_generation';
        payload = {
          model: id,
          content: h3Content({ prompt, images: refs }),
          duration: seconds,
          resolution: resolution === '2K' ? '2K' : '768P',
        };
      } else {
        payload = {
          model: id,
          prompt: String(prompt).slice(0, 7000),
          duration: seconds,
          resolution: resolution === '2K' ? '2K' : '768P',
          ...(refs[0] ? { first_frame_image: refs[0] } : {}),
        };
      }
      const response = await request(path, { method: 'POST', body: payload, signal });
      const taskId = taskIdFrom(response);
      if (!taskId) throw providerResponseError(502, response, { service: 'MiniMax 视频服务' });
      return {
        ...normalizedTask(response, id, taskId),
        taskId,
        status: 'Processing',
        ready: false,
        raw: '任务已提交，视频将在后台继续生成',
      };
    },
    async query({ taskId, model, signal } = {}) {
      const id = assertModel(model, h3Enabled);
      const tid = String(taskId || '').trim();
      if (!tid) throw invalidInput('MiniMax 视频任务编号不能为空');
      if (id === MINIMAX_H3_MODEL) {
        const response = await request(`/v2/query/video_generation/${encodeURIComponent(tid)}`, { signal });
        return normalizedTask(response.task || response, id, tid);
      }
      const response = await request(`${hailuoQueryPath}?task_id=${encodeURIComponent(tid)}`, { signal });
      if (String(response.status || '').toLowerCase() === 'success' && response.file_id) {
        const file = await request(`${hailuoRetrievePath}?file_id=${encodeURIComponent(response.file_id)}`, { signal });
        const url = urlFrom(file);
        return normalizedTask({ ...response, url }, id, tid);
      }
      return normalizedTask(response, id, tid);
    },
  });
}

export function isMiniMaxModel(id = '') {
  return MINIMAX_HAILUO_MODELS.includes(String(id)) || String(id) === MINIMAX_H3_MODEL;
}

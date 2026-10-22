// AI带货员高阶视频通道（OpenLux）：
// - 默认豆包 Seedance 2.5 图生视频，720p、竖屏、模型原生生成口播与环境音（实测可逐字说出脚本）。
// - Seedance 会拒绝“疑似真人”的参考图，此时同一分段自动改走可灵 v3（kling-video）pro 模式、有声。
// 两者都只提交一次 POST；任务失败绝不自动重复提交同一模型（避免重复扣费）。
import { providerVideoJson, providerVideoRoot, queryAliBailianVideoSegment } from './yunwu.js';
import { selectedProviderId, withTaskProvider } from './ai-provider-selection.js';

export const SALES_SEEDANCE_MODEL = 'doubao-seedance-2-5-260628';
export const SALES_KLING_MODEL = 'kling-video';
export const SALES_PREMIUM_RESOLUTION = '720p';
const SEEDANCE_TASKS = '/api/v3/contents/generations/tasks';
const KLING_TASKS = '/kling/v1/videos/image2video';
const REAL_PERSON = /real person|真人|人脸|portrait rights|InputImageSensitiveContentDetected/iu;

export const isSalesSeedance = model => model === SALES_SEEDANCE_MODEL;
export const isSalesKling = model => model === SALES_KLING_MODEL;
export const salesFallbackModel = model => (isSalesSeedance(model) ? SALES_KLING_MODEL : null);

export function realPersonRejection(error) {
  const text = `${error?.message || ''} ${error?.providerMessage || ''} ${JSON.stringify(error?.providerBody || '')}`;
  return error?.code === 'SALES_VIDEO_REAL_PERSON' || REAL_PERSON.test(text);
}
const personError = detail => Object.assign(new Error('参考图疑似真人，Seedance 拒绝生成'), {
  code: 'SALES_VIDEO_REAL_PERSON', status: 422, providerDetail: String(detail || '').slice(0, 200) });

function dataUri(image) {
  const match = String(image || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u);
  if (!match) throw Object.assign(new Error('参考图格式不正确'), { status: 400, code: 'SALES_VIDEO_REFERENCE_INVALID' });
  return { uri: image, base64: match[2] };
}
const clampDuration = value => Math.min(15, Math.max(4, Math.round(Number(value) || 15)));

export function buildSeedanceRequest({ prompt, images = [], duration = 15 }) {
  const { uri } = dataUri(images[0]);
  return { model: SALES_SEEDANCE_MODEL, content: [{ type: 'text', text: String(prompt || '') },
    { type: 'image_url', role: 'first_frame', image_url: { url: uri } }],
  ratio: 'adaptive', duration: clampDuration(duration), resolution: SALES_PREMIUM_RESOLUTION, generate_audio: true, watermark: false };
}
export function buildKlingRequest({ prompt, images = [], duration = 15 }) {
  const { base64 } = dataUri(images[0]);
  return { model_name: 'kling-v3', image: base64, prompt: String(prompt || ''),
    negative_prompt: '画面文字，水印，变形，闪烁，人物面部扭曲', duration: String(clampDuration(duration)), mode: 'pro', sound: 'on' };
}

export async function submitSeedanceSegment({ prompt, images, duration, signal, fetchImpl, timeoutMs = 120000 }) {
  try {
    const data = await providerVideoJson(`${providerVideoRoot()}${SEEDANCE_TASKS}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildSeedanceRequest({ prompt, images, duration })) },
    timeoutMs, signal, fetchImpl);
    const taskId = String(data?.id || data?.task_id || '');
    if (!taskId) throw Object.assign(new Error('Seedance 未返回任务ID'), { status: 502 });
    return { taskId, model: SALES_SEEDANCE_MODEL, status: 'queued', providerRequestId: data._gatewayRequestId || null,
      provider: selectedProviderId(), providerId: selectedProviderId(), hasAudioClaimed: true,
      requestedDuration: clampDuration(duration), requestedResolution: SALES_PREMIUM_RESOLUTION };
  } catch (error) {
    if (realPersonRejection(error)) throw personError(error?.message);
    throw error;
  }
}
export async function querySeedanceSegment({ taskId, signal, fetchImpl }) {
  const data = await providerVideoJson(`${providerVideoRoot()}${SEEDANCE_TASKS}/${encodeURIComponent(taskId)}`, {}, 30000, signal, fetchImpl);
  const status = String(data?.status || '').toLowerCase();
  const base = { taskId, model: SALES_SEEDANCE_MODEL, provider: selectedProviderId(), providerId: selectedProviderId() };
  if (status === 'succeeded' && data?.content?.video_url) return { ...base, status: 'Success', ready: true, url: data.content.video_url };
  if (['failed', 'cancelled', 'expired'].includes(status)) {
    const message = data?.error?.message || data?.error?.code || '';
    if (REAL_PERSON.test(message)) throw personError(message);
    return { ...base, status: 'Fail', ready: false, url: null };
  }
  return { ...base, status: status || 'Processing', ready: false, url: null };
}
export async function submitKlingSegment({ prompt, images, duration, signal, fetchImpl, timeoutMs = 120000 }) {
  const data = await providerVideoJson(`${providerVideoRoot()}${KLING_TASKS}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildKlingRequest({ prompt, images, duration })) },
  timeoutMs, signal, fetchImpl);
  const taskId = String(data?.data?.task_id || '');
  if (!taskId) throw Object.assign(new Error('可灵未返回任务ID'), { status: 502 });
  return { taskId, model: SALES_KLING_MODEL, status: 'queued', providerRequestId: data._gatewayRequestId || null,
    provider: selectedProviderId(), providerId: selectedProviderId(), hasAudioClaimed: true,
    requestedDuration: clampDuration(duration), requestedResolution: '1080p' };
}
export async function queryKlingSegment({ taskId, signal, fetchImpl }) {
  const data = await providerVideoJson(`${providerVideoRoot()}${KLING_TASKS}/${encodeURIComponent(taskId)}`, {}, 30000, signal, fetchImpl);
  const task = data?.data || {};
  const base = { taskId, model: SALES_KLING_MODEL, provider: selectedProviderId(), providerId: selectedProviderId() };
  const url = task.task_result?.videos?.[0]?.url;
  if (task.task_status === 'succeed' && url) return { ...base, status: 'Success', ready: true, url };
  if (task.task_status === 'failed') return { ...base, status: 'Fail', ready: false, url: null };
  return { ...base, status: task.task_status || 'Processing', ready: false, url: null };
}

// 按模型路由：带货主链与恢复链共用，避免用万相接口去查 Seedance/可灵任务。
export async function submitSalesVideoSegment(args) {
  if (isSalesSeedance(args.model)) return submitSeedanceSegment(args);
  if (isSalesKling(args.model)) return submitKlingSegment(args);
  const { submitAliBailianVideoSegment } = await import('./yunwu.js');
  return submitAliBailianVideoSegment(args);
}
export async function querySalesVideoSegment(args) {
  return withTaskProvider(args, () => (isSalesSeedance(args.model) ? querySeedanceSegment(args)
    : isSalesKling(args.model) ? queryKlingSegment(args) : queryAliBailianVideoSegment(args)));
}

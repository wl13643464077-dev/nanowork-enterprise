import { parseProviderMediaUrl } from './provider-media-download.js';

export const PROVIDER_360_BASE_URL = 'https://api.360.cn/v1';
export const PROVIDER_360_IMAGE_MODEL = 'openai/gpt-image-2';
export const PROVIDER_360_VIDEO_MODEL = 'alibaba/wan3.0-video';
export const PROVIDER_360_VIDEO_PATH = '/videos/async_generations';
export const PROVIDER_360_TEXT_MODEL = 'deepseek/deepseek-v4-flash';
export const PROVIDER_360_BOSS_MODEL = 'deepseek/deepseek-v4-pro';
export const PROVIDER_360_VISION_MODEL = 'qwen/qwen3.8-flash';

export function is360BaseUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://api.360.cn' && /^\/v1\/?$/.test(url.pathname);
  } catch { return false; }
}

export function provider360Catalog() {
  const text = [
    { id: PROVIDER_360_BOSS_MODEL, label: 'DeepSeek V4 Pro', tier: '旗舰', note: '360通道，老板与管理层的复杂分析' },
    { id: PROVIDER_360_TEXT_MODEL, label: 'DeepSeek V4 Flash', tier: '经济', note: '360通道，日常问答和内容创作' },
    { id: PROVIDER_360_VISION_MODEL, label: 'Qwen 3.8 Flash', tier: '多模态', note: '360通道，参考图理解与日常整理' },
    { id: 'qwen/qwen3.8-max', label: 'Qwen 3.8 Max', tier: '多模态', note: '360通道，复杂图文分析' },
  ];
  return {
    text,
    image: [{ id: PROVIDER_360_IMAGE_MODEL, label: 'GPT Image 2', tier: '标准', note: '360官方Image2接口，支持文生图与参考图编辑' }],
    vision: text.filter(item => item.id.startsWith('qwen/')),
    video: [{ id: PROVIDER_360_VIDEO_MODEL, label: '万相 3.0', tier: '原生有声', supported: true, note: '360通道，默认15秒，可选30秒原生视频' }],
  };
}

// A successful /models request verifies the connection only. In particular,
// 360 can return a valid directory without the configured Image2 model.
function directoryIds(models) {
  return new Set((Array.isArray(models) ? models : []).map(item => item?.id).filter(id => typeof id === 'string' && id));
}

export function describe360ModelDirectory(models, configured = {}) {
  const ids = directoryIds(models);
  return [
    ['text', '文本', configured.text?.sales || PROVIDER_360_TEXT_MODEL],
    ['image', '图片', configured.image || PROVIDER_360_IMAGE_MODEL],
    ['video', '视频', configured.videoDefault || PROVIDER_360_VIDEO_MODEL],
  ].map(([kind, label, model]) => ({ kind, label, model, listed: ids.has(model), generationVerified: false }));
}

// Image-output model IDs as named by 360's marketplace and its image API
// examples. Vision (image input) and video models are deliberately excluded.
const IMAGE_MODEL_ID = /gpt-image|dall-e|imagen|flux|kolors|cogview|seedream|-image(?:$|[-_])/i;
export function is360ImageModelId(id) {
  return typeof id === 'string' && !/video|vision|-vl|embedding/i.test(id) && IMAGE_MODEL_ID.test(id);
}

// 2026-09-07 finding: every 1001 image failure (Image2, Nano Banana, 万相2.7,
// Seedream) came with a same-key directory that listed the working video model
// and zero image models. The directory therefore does reflect what this
// organization may call; the block is on the provider side, not in our body.
export function describe360ImageAvailability(models, configured = {}) {
  const ids = directoryIds(models);
  const configuredModel = configured.image || PROVIDER_360_IMAGE_MODEL;
  const imageModels = [...ids].filter(is360ImageModelId);
  const videoListed = ids.has(configured.videoDefault || PROVIDER_360_VIDEO_MODEL);
  if (ids.has(configuredModel)) return { verdict: 'configured_listed', configuredModel, imageModels, videoListed,
    message: `目录已向本组织开放 ${configuredModel}；是否真实出图仍以生成接口返回为准` };
  if (imageModels.length) return { verdict: 'other_image_models_only', configuredModel, imageModels, videoListed,
    message: `目录未开放 ${configuredModel}，但已开放其他图片模型：${imageModels.join('、')}。请按需求核对后再决定是否切换，不能把其他模型的成功当作Image2验收` };
  return { verdict: 'no_image_models', configuredModel, imageModels, videoListed,
    message: `360 当前未向本组织开放任何图片生成模型（目录 ${ids.size} 个模型，图片模型 0 个${videoListed ? '，视频模型万相3.0在目录中且可用' : ''}）。`
      + '图片请求返回 1001“模型不存在或未授权”属于供应商侧未开通，不是参数或代码问题；请携带组织ID、请求时间和模型名联系 360 接入人员开通。开通前小红书图文仅交付文字与配图方案，不收取图片费用' };
}

// DeepSeek V4 defaults to thinking, which shares max_tokens with the answer.
// Short customer experiences can explicitly reserve that budget for正文.
// This is a raw HTTP field; an SDK's extra_body wrapper is not sent on wire.
export function build360ThinkingOptions(model, thinking) {
  return typeof thinking === 'boolean' && /^deepseek\/deepseek-v4-(flash|pro)$/.test(model)
    ? { thinking: { type: thinking ? 'enabled' : 'disabled' } } : {};
}

// Only known retired choices are migrated. An arbitrary capability or model
// must fail before a network call instead of silently becoming another model.
const LEGACY_MODELS = Object.freeze({
  'gpt-5.5': PROVIDER_360_BOSS_MODEL,
  'claude-opus-4-8': PROVIDER_360_BOSS_MODEL,
  'deepseek-v4-flash': PROVIDER_360_TEXT_MODEL,
  'gemini-3.1-flash-lite': PROVIDER_360_VISION_MODEL,
  'gpt-image-2': PROVIDER_360_IMAGE_MODEL,
});
export function resolve360Model(kind, value, fallback) {
  const model = String(value || fallback || '').trim();
  const migrated = kind === 'vision' && ['gpt-5.5', 'claude-opus-4-8'].includes(model)
    ? 'qwen/qwen3.8-max' : LEGACY_MODELS[model] || model;
  if (provider360Catalog()[kind]?.some(item => item.id === migrated)) return migrated;
  throw Object.assign(new Error(`360通道尚未开放此${kind === 'video' ? '视频' : kind === 'image' ? '图片' : '文本'}模型，请重新选择模型`), {
    status: 400, code: 'PROVIDER_360_MODEL_UNSUPPORTED', providerReason: 'unsupported_model',
  });
}

export function provider360VideoInfo(id) {
  if (id !== PROVIDER_360_VIDEO_MODEL) return {
    id, displayName: id, shortName: id, provider: '360智脑', adapter: 'blocked', supported: false,
    note: '供应商已切换360，请选择万相3.0；旧供应商任务不会跨通道重试',
  };
  return { id, displayName: '万相 3.0', shortName: 'WAN-3.0', provider: '360智脑', adapter: '360-video',
    supported: true, nativeAudio: true, durationRange: [2, 30], note: '360异步视频接口；原生声音随画面生成' };
}

function mediaReference(value) {
  const raw = String(value || '').trim();
  // Documentation copied from chat can wrap a URL in a Markdown link. Read
  // its destination only, then apply the same public-URL validation as usual.
  const markdown = raw.match(/^\[[^\]\r\n]*\]\(\s*(https?:\/\/[^\s<>]+)\s*\)$/u);
  const string = markdown ? markdown[1] : raw;
  if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(string)) return string;
  return parseProviderMediaUrl(string).toString();
}

export function build360ImageGenerationBody({ model, prompt, size = '1024x1024' } = {}) {
  return { model: resolve360Model('image', model, PROVIDER_360_IMAGE_MODEL), prompt: String(prompt || ''),
    n: 1, size, response_format: '', style: '', quality: 'medium' };
}

export function build360ImageEditBody({ model, prompt, size = '1024x1024', images = [], mask } = {}) {
  if (!Array.isArray(images) || !images.length || images.length > 16)
    throw Object.assign(new Error('请提供1–16张参考图'), { status: 400 });
  return { ...build360ImageGenerationBody({ model, prompt, size }),
    extra_body: { images: images.map(mediaReference), ...(mask ? { mask: mediaReference(mask) } : {}) } };
}

export function build360VideoBody({ model, prompt, images = [], duration = 15, resolution = '720P', audioUrl = null, promptExtend = false } = {}) {
  const resolved = resolve360Model('video', model, PROVIDER_360_VIDEO_MODEL);
  const seconds = Number(duration);
  if (!Number.isInteger(seconds) || seconds < 2 || seconds > 30)
    throw Object.assign(new Error('万相3.0视频时长必须为2–30秒整数'), { status: 400 });
  if (!['480P', '720P', '1080P'].includes(String(resolution).toUpperCase()))
    throw Object.assign(new Error('万相3.0视频分辨率请选择480P、720P或1080P'), { status: 400 });
  if (audioUrl) throw Object.assign(new Error('当前360万相3.0录音参考接口尚未核验，请使用模型原生配音'), { status: 400 });
  if (!Array.isArray(images) || images.length > 6)
    throw Object.assign(new Error('视频参考图最多6张'), { status: 400 });
  // Wan3.0 uses the native DashScope input/parameters envelope. The 360
  // adapter forwards that envelope from extra_body (as in its Alibaba video
  // examples). Flat extra_body.duration/resolution are ignored by this model
  // and caused a real 15s/720P request to fall back to 5s/1080P.
  // Sources: ai.360.com/docs/413292019e0 and
  // help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference.
  return { model: resolved, duration: seconds, extra_body: {
    input: { prompt: String(prompt || ''), ...(images.length ? {
      media: images.map(url => ({ type: images.length === 1 ? 'first_frame' : 'reference_image', url: mediaReference(url) })),
    } : {}) },
    parameters: { duration: seconds, resolution: String(resolution).toUpperCase(), ratio: '9:16',
      audio: true, prompt_extend: promptExtend === true, watermark: false },
  } };
}

export function valid360VideoTaskId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.+^:/-]{1,500}$/.test(value);
}

export function normalize360VideoTask(response, model, fallbackTaskId = '') {
  const source = response?.data && !Array.isArray(response.data) ? response.data : response;
  const taskId = source?.id || fallbackTaskId;
  if (!valid360VideoTaskId(taskId)) throw Object.assign(new Error('360未返回有效视频任务编号'), { status: 502 });
  const state = String(source?.status || '').toLowerCase();
  const failed = ['failed', 'fail', 'failure', 'error', 'canceled', 'cancelled'].includes(state);
  const succeeded = ['success', 'succeeded', 'completed', 'complete'].includes(state);
  const url = source?.url ? parseProviderMediaUrl(source.url).toString() : null;
  let mediaUsage = source?.extra_data;
  if (typeof mediaUsage === 'string') {
    try { mediaUsage = mediaUsage.length <= 10000 ? JSON.parse(mediaUsage) : null; } catch { mediaUsage = null; }
  }
  const duration = Number(mediaUsage?.output_video_duration ?? mediaUsage?.duration ?? source?.duration);
  const resolution = Number(mediaUsage?.SR);
  return { model, taskId, status: failed ? 'Fail' : succeeded ? 'Success' : state || 'Processing',
    ready: !failed && succeeded && !!url, url: failed || !succeeded ? null : url, provider: '360',
    actualDurationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    actualResolution: [480, 720, 1080].includes(resolution) ? `${resolution}P` : null,
    raw: failed ? '360视频生成失败，未返回可交付视频' : succeeded && url ? '视频任务已完成' : '视频任务处理中' };
}

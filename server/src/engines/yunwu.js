import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../db.js';
import { providerResponseError, sanitizeProviderError } from './provider-errors.js';

// ===== 云雾API服务（OpenAI兼容协议，https://yunwu.ai/v1）=====
// .env 加载（不引第三方依赖）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const legacyStoredKey = () => String(getConfig('yunwu_api_key', null) || '').trim();
const environmentKey = () => String(process.env.YUNWU_API_KEY || '').trim();
const KEY = () => environmentKey() || legacyStoredKey();
const BASE = () => getConfig('yunwu_base_url', null) || process.env.YUNWU_BASE_URL || 'https://yunwu.ai/v1';
export const yunwuAvailable = () => !!KEY();
export const maskedKey = () => { const k = KEY(); return k ? `${k.slice(0, 8)}****${k.slice(-4)}` : '（未配置）'; };
export const yunwuKeySource = () => environmentKey() ? 'environment' : legacyStoredKey() ? 'legacy_db' : 'none';
export const yunwuApiKey = () => KEY();

// 分层模型路由（PRD V2 §22：老板/管理层/员工 三级，后台接口管理可改）
const DEFAULT_ROUTING = {
  text: { boss: 'gpt-5.5', ops_director: 'gemini-3.1-flash-lite', sales: 'deepseek-v4-flash', admin: 'deepseek-v4-flash', partner: 'deepseek-v4-flash' },
  image: 'gpt-image-2',
  vision: 'gemini-3.1-flash-lite',  // 多模态识图模型（员工对话发图时使用，后台可改）
  video: [
    'kling-video',
    'kling-omni-video',
    'kling-avatar-image2video',
    'kling-video-extend',
    'kling-motion-control',
    'kling-multi-elements',
    'kling-effects',
    'wan2.6-i2v',
    'wan2.5-i2v-preview',
    'happyhorse-1.0-t2v:floor',
    'happyhorse-1.0-t2v:nitro',
    'happyhorse-1.0-t2v:stable',
    'happyhorse-1.0-i2v',
    'happyhorse-1.0-r2v',
    'happyhorse-1.0-video-edit',
    'veo-3.1-generate-preview',
    'veo-3.1-fast-generate-preview',
  ],
  videoDefault: 'happyhorse-1.0-t2v:floor',
  deepThink: 'gpt-5.5',             // 深度思考模式统一升级到老板级模型（后台可改）
};
const VIDEO_MODEL_CATALOG = {
  'MiniMax-Hailuo-02': { displayName: 'MiniMax 海螺 02', shortName: 'HL-02', provider: 'MiniMax 海螺', adapter: 'minimax', supported: true, note: '已接入海螺专属任务接口，支持文生视频/首帧图生视频' },
  'MiniMax-Hailuo-2.3': { displayName: 'MiniMax 海螺 2.3', shortName: 'HL-2.3', provider: 'MiniMax 海螺', adapter: 'minimax', supported: true, note: '已接入海螺专属任务接口，适合高质量试片' },
  'MiniMax-Hailuo-2.3-Fast': { displayName: 'MiniMax 海螺 2.3 Fast', shortName: 'HL-FAST', provider: 'MiniMax 海螺', adapter: 'minimax', supported: true, note: '已接入海螺专属任务接口，适合快速出片' },
  'kling-video': { displayName: '可灵标准视频', shortName: 'KL-V', provider: '快手可灵', adapter: 'planned', supported: false, note: '当前未拿到官网专用视频任务端点证据，先不开放员工生成，避免继续报错' },
  'kling-omni-video': { displayName: '可灵全能视频', shortName: 'KL-OMNI', provider: '快手可灵', adapter: 'planned', supported: false, note: '当前未拿到官网专用视频任务端点证据，先不开放员工生成，避免继续报错' },
  'kling-avatar-image2video': { displayName: '可灵数字人口播', shortName: 'KL-AV', provider: '快手可灵', adapter: 'planned', supported: false, requiresImage: true, requiresAudio: true, note: '当前云雾返回 Audio duration is invalid；该模型需要音频/口播参数，现有表单暂不开放员工使用' },
  'kling-video-extend': { displayName: '可灵视频续写', shortName: 'KL-EXT', provider: '快手可灵', adapter: 'planned', supported: false, requiresImage: true, note: '续写模型需要原视频/续写素材参数，当前通用表单暂不开放员工使用' },
  'kling-motion-control': { displayName: '可灵运动控制', shortName: 'KL-MC', provider: '快手可灵', adapter: 'planned', supported: false, note: '运动控制需要专用动作参数，当前通用表单暂不开放员工使用' },
  'kling-multi-elements': { displayName: '可灵多元素视频', shortName: 'KL-ME', provider: '快手可灵', adapter: 'planned', supported: false, note: '多元素模型需要多主体/多参考图参数，当前通用表单暂不开放员工使用' },
  'kling-effects': { displayName: '可灵视频特效', shortName: 'KL-FX', provider: '快手可灵', adapter: 'planned', supported: false, note: '云雾上游返回厂商 token 鉴权错误，先从员工端隐藏，避免反复失败' },
  'pixverse-video': { displayName: 'PixVerse 标准视频', shortName: 'PX-V', provider: 'PixVerse', adapter: 'unified', supported: true, note: '已接入云雾统一视频任务接口' },
  'pixverse-lipsync': { displayName: 'PixVerse 口型同步', shortName: 'PX-LIP', provider: 'PixVerse', adapter: 'unified', supported: true, requiresImage: true, note: '已接入云雾统一视频任务接口，建议上传人物图/视频参考' },
  'pixverse-mimic': { displayName: 'PixVerse 动作模仿', shortName: 'PX-MIMIC', provider: 'PixVerse', adapter: 'unified', supported: true, requiresImage: true, note: '已接入云雾统一视频任务接口，建议上传参考图' },
  'pixverse-multi-transition': { displayName: 'PixVerse 多图转场', shortName: 'PX-MT', provider: 'PixVerse', adapter: 'unified', supported: true, requiresImage: true, note: '已接入云雾统一视频任务接口，适合多图转场' },
  'pixverse-restyle': { displayName: 'PixVerse 风格重塑', shortName: 'PX-RS', provider: 'PixVerse', adapter: 'unified', supported: true, requiresImage: true, note: '已接入云雾统一视频任务接口，需上传参考图' },
  'pixverse-modify': { displayName: 'PixVerse 视频/图像修改', shortName: 'PX-MOD', provider: 'PixVerse', adapter: 'unified', supported: true, requiresImage: true, note: '已接入云雾统一视频任务接口，需上传参考素材' },
  'viduq3-turbo': { displayName: 'Vidu Q3 Turbo', shortName: 'VD-Q3T', provider: 'Vidu', adapter: 'unified', supported: true, note: '已接入云雾统一视频任务接口，速度优先' },
  'viduq3': { displayName: 'Vidu Q3', shortName: 'VD-Q3', provider: 'Vidu', adapter: 'unified', supported: true, note: '已接入云雾统一视频任务接口' },
  'viduq3-pro': { displayName: 'Vidu Q3 Pro', shortName: 'VD-Q3P', provider: 'Vidu', adapter: 'unified', supported: true, note: '已接入云雾统一视频任务接口，质量优先' },
  'viduq3-mix': { displayName: 'Vidu Q3 Mix', shortName: 'VD-Q3M', provider: 'Vidu', adapter: 'unified', supported: true, note: '已接入云雾统一视频任务接口，混合创作' },
  'vidu2.0': { displayName: 'Vidu 2.0', shortName: 'VD-2.0', provider: 'Vidu', adapter: 'unified', supported: true, note: '已接入云雾统一视频任务接口' },
  'viduq1': { displayName: 'Vidu Q1', shortName: 'VD-Q1', provider: 'Vidu', adapter: 'unified', supported: true, note: '已接入云雾统一视频任务接口' },
  'viduq1-classic': { displayName: 'Vidu Q1 Classic', shortName: 'VD-Q1C', provider: 'Vidu', adapter: 'unified', supported: true, note: '已接入云雾统一视频任务接口' },
  'viduq2': { displayName: 'Vidu Q2', shortName: 'VD-Q2', provider: 'Vidu', adapter: 'unified', supported: true, note: '已接入云雾统一视频任务接口' },
  'viduq2-turbo': { displayName: 'Vidu Q2 Turbo', shortName: 'VD-Q2T', provider: 'Vidu', adapter: 'unified', supported: true, note: '已接入云雾统一视频任务接口，速度优先' },
  'viduq2-pro': { displayName: 'Vidu Q2 Pro', shortName: 'VD-Q2P', provider: 'Vidu', adapter: 'unified', supported: true, note: '已接入云雾统一视频任务接口' },
  'wan2.6-i2v': { displayName: '通义万相 2.6 图生视频', shortName: 'WAN-2.6', provider: '通义万相', adapter: 'planned', supported: false, requiresImage: true, note: '当前账号 /video/generations 与 /videos 均返回 404；说明模型可见但视频任务通道未开放，先从员工端隐藏' },
  'wan2.5-i2v-preview': { displayName: '通义万相 2.5 预览', shortName: 'WAN-2.5P', provider: '通义万相', adapter: 'planned', supported: false, requiresImage: true, note: '当前账号尚未验证到可用视频任务端点，先作为待接入模型保留给管理员查看' },
  'happyhorse-1.0-t2v:floor': { displayName: 'HappyHorse 首帧视频 低价', shortName: 'HH-FLOOR', provider: 'HappyHorse', adapter: 'alibailian-video', supported: true, requiresImage: true, upstreamModel: 'happyhorse-1.0-t2v', note: '已按官网专用接口验证可提交；显示后缀用于档位，转发给云雾时自动剥离后缀' },
  'happyhorse-1.0-t2v:nitro': { displayName: 'HappyHorse 首帧视频 快速', shortName: 'HH-NITRO', provider: 'HappyHorse', adapter: 'alibailian-video', supported: true, requiresImage: true, upstreamModel: 'happyhorse-1.0-t2v', note: '已按官网专用接口验证可提交；速度优先档，提交时自动剥离后缀' },
  'happyhorse-1.0-t2v:stable': { displayName: 'HappyHorse 首帧视频 稳定', shortName: 'HH-STABLE', provider: 'HappyHorse', adapter: 'alibailian-video', supported: true, requiresImage: true, upstreamModel: 'happyhorse-1.0-t2v', note: '已按官网专用接口验证可提交；成功率优先档，提交时自动剥离后缀' },
  'happyhorse-1.0-t2v': { displayName: 'HappyHorse 文生视频', shortName: 'HH-T2V', provider: 'HappyHorse', adapter: 'planned', supported: false, note: '官网建议使用带后缀模型名：happyhorse-1.0-t2v:floor / :nitro / :stable' },
  'happyhorse-1.0-i2v': { displayName: 'HappyHorse 图生视频', shortName: 'HH-I2V', provider: 'HappyHorse', adapter: 'planned', supported: false, requiresImage: true, note: '云雾当前返回 Unsupported model type，先不开放员工生成，避免反复失败' },
  'happyhorse-1.0-r2v': { displayName: 'HappyHorse 参考生视频', shortName: 'HH-R2V', provider: 'HappyHorse', adapter: 'planned', supported: false, requiresImage: true, note: '云雾当前返回 Unsupported model type，先不开放员工生成，避免反复失败' },
  'happyhorse-1.0-video-edit': { displayName: 'HappyHorse 视频编辑', shortName: 'HH-EDIT', provider: 'HappyHorse', adapter: 'planned', supported: false, requiresImage: true, note: '云雾当前返回 Unsupported model type，先不开放员工生成，避免反复失败' },
  'veo-3.1-generate-preview': { displayName: 'Google VEO 3.1 高质量', shortName: 'VEO-3.1', provider: 'Google VEO', adapter: 'planned', supported: false, note: '当前云雾 /v1/models 未暴露该模型，先预留给最高权限查看，待账号可用后再开放员工使用' },
  'veo-3.1-fast-generate-preview': { displayName: 'Google VEO 3.1 快速', shortName: 'VEO-FAST', provider: 'Google VEO', adapter: 'planned', supported: false, note: '当前云雾 /v1/models 未暴露该模型，先预留给最高权限查看，待账号可用后再开放员工使用' },
  'veo-3.0-generate-001': { displayName: 'Google VEO 3.0 高质量', shortName: 'VEO-3.0', provider: 'Google VEO', adapter: 'planned', supported: false, note: '当前云雾 /v1/models 未暴露该模型，暂不开放生成' },
  'veo-3.0-fast-generate-001': { displayName: 'Google VEO 3.0 快速', shortName: 'VEO-3F', provider: 'Google VEO', adapter: 'planned', supported: false, note: '当前云雾 /v1/models 未暴露该模型，暂不开放生成' },
  'doubao-seedance-2-0-fast-260128': { displayName: '豆包 Seedance 2.0 Fast', shortName: 'DB-SD-F', provider: '豆包 Seedance', adapter: 'unified', supported: true, note: '已接入云雾统一视频任务接口，速度优先' },
  'doubao-seedance-2-0-260128': { displayName: '豆包 Seedance 2.0 Pro', shortName: 'DB-SD-P', provider: '豆包 Seedance', adapter: 'unified', supported: true, note: '已接入云雾统一视频任务接口，质量优先' },
  'mj_video': { displayName: 'Midjourney Video', shortName: 'MJ-V', provider: 'Midjourney Video', adapter: 'planned', supported: false, note: '需接入 Midjourney 专属 /mj 视频流程，暂不走统一视频接口' },
};
const ALLOWED_VIDEO_MODEL_RE = /^(kling-|happyhorse-|wan|veo-)/i;
function allowedVideoModel(id = '') {
  return ALLOWED_VIDEO_MODEL_RE.test(String(id || ''));
}
export function videoModelInfo(id = '') {
  const known = VIDEO_MODEL_CATALOG[id];
  if (known) return { id, ...known };
  const planned = !allowedVideoModel(id);
  return { id, displayName: id, shortName: id, provider: planned ? '未开放品牌' : '云雾视频模型', adapter: planned ? 'blocked' : 'planned', supported: false, note: planned ? '当前只开放可灵、HappyHorse、Wan、VEO 品牌' : '待确认该模型的视频任务接口' };
}
export function videoTaskSupported(id = '') { return videoModelInfo(id).supported === true; }
export function routing() {
  const cfg = getConfig('model_routing', {}) || {};
  const out = {
    ...DEFAULT_ROUTING,
    ...cfg,
    text: { ...DEFAULT_ROUTING.text, ...(cfg.text || {}) },
  };
  const configuredVideo = Array.isArray(cfg.video) ? cfg.video : [];
  out.video = [...new Set([...configuredVideo, ...DEFAULT_ROUTING.video])].filter(allowedVideoModel);
  out.videoDefault = out.video.includes(out.videoDefault) && videoTaskSupported(out.videoDefault)
    ? out.videoDefault
    : DEFAULT_ROUTING.videoDefault;
  return out;
}
export function textModelFor(role) { const r = routing(); return r.text[role] || r.text.sales; }

let usage = { calls: 0, input: 0, output: 0, images: 0, videos: 0, errors: 0 };
export const yunwuUsage = () => usage;

function boundedTimeout(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

const INTERACTIVE_EMBED_TIMEOUT_MS = boundedTimeout('AI_INTERACTIVE_EMBED_TIMEOUT_MS', 4000, 250, 20000);
const INTERACTIVE_CHAT_TIMEOUT_MS = boundedTimeout('AI_INTERACTIVE_CHAT_TIMEOUT_MS', 85000, 500, 110000);
const IMAGE_TIMEOUT_MS = boundedTimeout('AI_IMAGE_TIMEOUT_MS', 105000, 1000, 115000);

function timedSignal(timeoutMs, externalSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const signal = externalSignal ? AbortSignal.any([ctrl.signal, externalSignal]) : ctrl.signal;
  return { signal, clear: () => clearTimeout(timer), timedOut: () => ctrl.signal.aborted };
}

function normalizeFetchError(error, timedOut, externalSignal) {
  if (error?.name !== 'AbortError') return sanitizeProviderError(error, { service: '云雾AI服务' });
  if (externalSignal?.aborted && !timedOut()) {
    return Object.assign(new Error('请求已由客户端取消'), { status: 499 });
  }
  return Object.assign(new Error('AI服务响应超时，系统已停止等待，请缩短要求后重试'), { status: 504 });
}

async function post(pathName, body, timeoutMs = 60000, externalSignal) {
  const timed = timedSignal(timeoutMs, externalSignal);
  try {
    const res = await fetch(`${BASE()}${pathName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY()}` },
      body: JSON.stringify(body),
      signal: timed.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw providerResponseError(res.status, data, { service: '云雾AI服务' });
    }
    return data;
  } catch (error) {
    throw normalizeFetchError(error, timed.timedOut, externalSignal);
  } finally { timed.clear(); }
}

// 文本向量化（RAG 语义检索用；失败返回 null 由调用方降级）
export async function embed(text, timeoutMs = INTERACTIVE_EMBED_TIMEOUT_MS, signal) {
  if (!text || !KEY()) return null;
  try {
    const model = getConfig('embed_model', null) || 'text-embedding-3-small';
    const timeout = Math.min(20000, Math.max(250, Number(timeoutMs) || INTERACTIVE_EMBED_TIMEOUT_MS));
    const data = await post('/embeddings', { model, input: String(text).slice(0, 6000) }, timeout, signal);
    return data.data?.[0]?.embedding || null;
  } catch (error) {
    if (error?.status === 499) throw error;
    return null;
  }
}

// AI-C3 结构化输出：OpenAI 兼容 response_format（json_schema）请求体片段
// 云雾主流文本模型（gpt-5.5/deepseek 等）按 OpenAI 协议支持；不支持的模型报错后由 generate() 正常走降级链
export function jsonSchemaFormat(name, schema) {
  return { type: 'json_schema', json_schema: { name: String(name || 'result'), schema, strict: true } };
}

// 文本对话（OpenAI chat/completions 协议）
export async function chat({ role, model, system, messages, maxTokens = 2000, timeoutMs = INTERACTIVE_CHAT_TIMEOUT_MS, signal, responseFormat }) {
  const m = model || textModelFor(role);
  const body = {
    model: m,
    max_tokens: maxTokens,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
  };
  const timeout = Math.min(110000, Math.max(500, Number(timeoutMs) || INTERACTIVE_CHAT_TIMEOUT_MS));
  const data = await post('/chat/completions', body, timeout, signal);
  const text = data.choices?.[0]?.message?.content || '';
  const u = data.usage || {};
  usage.calls++; usage.input += u.prompt_tokens || 0; usage.output += u.completion_tokens || 0;
  return { text, model: m, inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0 };
}

// 文本对话·流式（OpenAI SSE 协议）：onDelta 逐段回调；usage 缺失时按字数估算（计费口径，中文≈2字符/token）
export async function chatStream({ role, model, system, messages, maxTokens = 2000, timeoutMs = INTERACTIVE_CHAT_TIMEOUT_MS, signal, onDelta, responseFormat }) {
  const m = model || textModelFor(role);
  const body = {
    model: m,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...(responseFormat ? { response_format: responseFormat } : {}),
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
  };
  const timeout = Math.min(110000, Math.max(500, Number(timeoutMs) || INTERACTIVE_CHAT_TIMEOUT_MS));
  const timed = timedSignal(timeout, signal);
  try {
    const res = await fetch(`${BASE()}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY()}` },
      body: JSON.stringify(body),
      signal: timed.signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw providerResponseError(res.status, data, { service: '云雾AI服务' });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', text = '', u = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json; try { json = JSON.parse(payload); } catch { continue; }
        const delta = json.choices?.[0]?.delta?.content || '';
        if (delta) { text += delta; onDelta?.(delta); }
        if (json.usage) u = json.usage;
      }
    }
    if (!text) { const e = new Error('AI流式返回为空'); e.status = 502; throw e; }
    const inputTokens = u?.prompt_tokens ?? Math.ceil(JSON.stringify(body.messages).length / 3);
    const outputTokens = u?.completion_tokens ?? Math.ceil(text.length / 2);
    usage.calls++; usage.input += inputTokens; usage.output += outputTokens;
    return { text, model: m, inputTokens, outputTokens };
  } catch (error) {
    throw normalizeFetchError(error, timed.timedOut, signal);
  } finally { timed.clear(); }
}

// 图片生成（OpenAI images/generations 协议，模型 gpt-image-2）
export async function generateImage({ prompt, size = '1024x1024', model, signal }) {
  const m = model || routing().image;
  const data = await post('/images/generations', { model: m, prompt, n: 1, size }, IMAGE_TIMEOUT_MS, signal);
  const item = data.data?.[0] || {};
  usage.images++;
  return { model: m, url: item.url || null, b64: item.b64_json || null };
}

// 图生图 / 图片编辑（OpenAI images/edits 协议，multipart；上传参考图 + 提示词改图）
export async function editImage({ prompt, images = [], image, size = '1024x1024', model, signal }) {
  const m = model || routing().image;
  const references = (Array.isArray(images) && images.length ? images : [image]).filter(Boolean);
  if (!references.length) throw Object.assign(new Error('缺少参考图'), { status: 400 });
  const fd = new FormData();
  fd.append('model', m);
  fd.append('prompt', prompt);
  fd.append('size', size);
  references.forEach((reference, index) => {
    const match = String(reference).match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    if (!match) throw Object.assign(new Error(`第${index + 1}张参考图格式不正确`), { status: 400 });
    const ext = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
    fd.append(references.length > 1 ? 'image[]' : 'image', new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }), `reference-${index + 1}.${ext}`);
  });
  const timed = timedSignal(IMAGE_TIMEOUT_MS, signal);
  try {
    const res = await fetch(`${BASE()}/images/edits`, {
      method: 'POST', headers: { Authorization: `Bearer ${KEY()}` }, body: fd, signal: timed.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw providerResponseError(res.status, data, { service: '云雾AI服务' });
    }
    const item = data.data?.[0] || {};
    usage.images++;
    return { model: m, url: item.url || null, b64: item.b64_json || null };
  } catch (error) {
    throw normalizeFetchError(error, timed.timedOut, signal);
  } finally { timed.clear(); }
}

// —— MiniMax 海螺视频：专属异步任务接口（提交→轮询查询→取片，最终为可直链访问的 OSS mp4）——
const ywRoot = () => BASE().replace(/\/v1\/?$/, '');     // https://yunwu.ai
async function ywJson(url, opts = {}, timeoutMs = 60000, externalSignal) {
  const timed = timedSignal(timeoutMs, externalSignal);
  try {
    const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${KEY()}`, ...(opts.headers || {}) }, signal: timed.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw providerResponseError(res.status, data, { service: '云雾视频服务' });
    }
    return data;
  } catch (error) {
    throw normalizeFetchError(error, timed.timedOut, externalSignal);
  } finally { timed.clear(); }
}
function friendlyVideoError(err, info) {
  if (err?.providerReason === 'audio_duration') {
    const e = new Error(`视频模型「${info.displayName}（${info.shortName}）」需要音频/口播时长参数，当前通用视频表单不能直接生成。请改用 HappyHorse 文生视频或可灵标准视频。`);
    e.status = 400;
    return e;
  }
  if (err?.providerReason === 'not_found') {
    const e = new Error(`视频模型「${info.displayName}（${info.shortName}）」当前接口路径不可用或账号未开通任务通道。请优先选择 HappyHorse 文生视频（HH-FLOOR/HH-NITRO/HH-STABLE）或可灵标准视频。`);
    e.status = 400;
    return e;
  }
  if (err?.providerReason === 'unsupported_model') {
    const e = new Error(`视频模型「${info.displayName}（${info.shortName}）」当前不是云雾可用的视频任务模型，已阻止继续使用。请先切换可灵标准视频或 Wan 图生视频；该模型需等云雾侧开放任务通道后再启用。`);
    e.status = 400;
    return e;
  }
  if (err?.providerReason === 'auth') {
    const e = new Error(`视频模型「${info.displayName}（${info.shortName}）」上游通道鉴权失败，云雾侧该模型可能暂时没有可用厂商通道。请先切换 HappyHorse 文生视频或 Wan 图生视频重试；如果必须用这个模型，需要在云雾后台确认该模型通道已开通。`);
    e.status = 502;
    return e;
  }
  return sanitizeProviderError(err, { service: '云雾视频服务' });
}
function shouldTryNextVideoEndpoint(err) {
  return ['not_found', 'unsupported_model', 'auth', 'upstream'].includes(err?.providerReason)
    || [404, 405, 500, 502].includes(err?.providerStatus);
}
function videoUrlFrom(data = {}) {
  return data.url || data.video_url || data.download_url ||
    data.metadata?.url || data.metadata?.video_url ||
    data.data?.url || data.data?.video_url ||
    data.data?.task_result?.videos?.[0]?.url ||
    data.output?.video_url ||
    data.content?.video_url ||
    data.file?.download_url || data.file?.backup_download_url ||
    null;
}
function videoTaskIdFrom(data = {}, fallback = '') {
  return data.id || data.task_id || data.taskId || data.data?.task_id || data.data?.id || data.output?.task_id || fallback || '';
}
function videoStatusFrom(data = {}, fallback = '') {
  return data.status || data.state || data.task_status || data.data?.task_status || data.output?.task_status || fallback || 'queued';
}
function normalizeVideoTask(data = {}, model, fallbackTaskId = '') {
  const taskId = videoTaskIdFrom(data, fallbackTaskId);
  const status = String(videoStatusFrom(data, '') || '').toLowerCase();
  const url = videoUrlFrom(data);
  const ready = !!url || ['success', 'succeed', 'succeeded', 'completed', 'complete'].includes(status);
  const failed = ['fail', 'failed', 'error', 'canceled', 'cancelled'].includes(status);
  return {
    model,
    url: url || null,
    taskId,
    status: failed ? 'Fail' : ready ? 'Success' : (status || 'Processing'),
    ready: ready && !!url,
    raw: failed
      ? '视频任务失败，上游未返回可交付结果'
      : ready ? '视频任务已完成' : '视频任务处理中',
  };
}
function videoDefaultsFor(model, images = []) {
  const image = images[0];
  const size = /^wan/i.test(model) ? '1080P' : '1280x720';
  const metadata = {
    duration: 6,
    negative_prompt: '低清晰度，画面抖动，错误文字，水印，畸形手指，过曝，低质感',
  };
  if (/^kling/i.test(model)) Object.assign(metadata, { mode: 'std', aspect_ratio: '16:9', cfg_scale: 0.5 });
  if (/^pixverse/i.test(model)) Object.assign(metadata, { aspect_ratio: '16:9', style: 'realistic' });
  if (/^vidu/i.test(model)) Object.assign(metadata, { resolution: '1080p', movement_amplitude: 'auto' });
  if (/^wan/i.test(model)) Object.assign(metadata, { resolution: '1080P', prompt_extend: true, watermark: false });
  if (/^doubao-seedance/i.test(model)) Object.assign(metadata, { ratio: '16:9', resolution: '1080p', service_tier: model.includes('fast') ? 'fast' : 'standard' });
  if (/^happyhorse/i.test(model)) Object.assign(metadata, { ratio: '16:9' });
  const body = { model, prompt: '', duration: 6, seconds: '6', size, response_format: 'url', metadata };
  if (image) {
    body.image = image;
    body.images = images;
    body.input_reference = image;
  }
  return body;
}
async function submitAliBailianVideoTask({ prompt, model, images = [], signal }) {
  const info = videoModelInfo(model);
  const image = images[0];
  if (!image) {
    const err = new Error(`视频模型「${info.displayName}（${info.shortName}）」需要上传首帧参考图后再生成。`);
    err.status = 400;
    throw err;
  }
  const input = { prompt };
  if (image) input.img_url = image;
  const body = {
    model: info.upstreamModel || model.replace(/:(floor|nitro|stable)$/i, ''),
    input,
    parameters: {
      duration: 6,
      resolution: '720P',
      size: '1280*720',
    },
  };
  const data = await ywJson(`${ywRoot()}/alibailian/api/v1/services/aigc/video-generation/video-synthesis`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' }, body: JSON.stringify(body) }, 60000, signal);
  const task = normalizeVideoTask(data, model);
  if (!task.taskId) throw providerResponseError(502, data, { service: '云雾视频服务' });
  return { ...task, status: task.status || 'queued', raw: task.ready ? task.raw : '任务已提交，视频生成需数分钟，请在列表刷新查看' };
}
async function queryAliBailianVideoTask({ taskId, model }) {
  const data = await ywJson(`${ywRoot()}/alibailian/tasks/${encodeURIComponent(taskId)}`, {}, 30000);
  return normalizeVideoTask(data, model, taskId);
}
async function submitUnifiedVideoTask({ prompt, model, images = [], signal }) {
  const info = videoModelInfo(model);
  const image = images[0];
  if (info.requiresImage && !image) {
    const err = new Error(`视频模型「${info.displayName}（${info.shortName}）」需要上传首帧图或参考图后再生成。`);
    err.status = 400;
    throw err;
  }
  const body = { ...videoDefaultsFor(model, images), prompt };
  let lastErr;
  for (const endpoint of ['/video/generations', '/videos']) {
    try {
      const data = await ywJson(`${BASE()}${endpoint}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 60000, signal);
      const task = normalizeVideoTask(data, model);
      if (!task.taskId) throw new Error('云雾视频任务提交成功但未返回 task_id');
      return { ...task, status: task.status || 'queued', raw: task.ready ? task.raw : '任务已提交，视频生成需数分钟，请在列表刷新查看' };
    } catch (e) {
      lastErr = e;
      if (!shouldTryNextVideoEndpoint(e)) break;
    }
  }
  throw friendlyVideoError(lastErr, info);
}
async function queryUnifiedVideoTask({ taskId, model }) {
  let lastErr;
  for (const endpoint of [`/video/generations/${encodeURIComponent(taskId)}`, `/videos/${encodeURIComponent(taskId)}`]) {
    try {
      const data = await ywJson(`${BASE()}${endpoint}`, {}, 30000);
      return normalizeVideoTask(data, model, taskId);
    } catch (e) {
      lastErr = e;
      if (![404, 405, 500, 502].includes(e.status)) break;
    }
  }
  throw lastErr;
}
async function submitMiniMaxVideoTask({ prompt, model, images = [], signal }) {
  const root = ywRoot();
  const body = { model, prompt, duration: 6, resolution: '768P' };
  const image = images[0];
  if (image) body.first_frame_image = image;     // 图生视频：首帧图（data URL 或 http 均可）
  const sub = await ywJson(`${root}/minimax/v1/video_generation`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 60000, signal);
  const taskId = sub.task_id;
  if (!taskId) throw providerResponseError(502, sub, { service: '云雾视频服务' });
  usage.videos++;
  return { model, url: null, taskId, status: 'Processing', ready: false, raw: '任务已提交，视频将在后台继续生成' };
}
async function queryMiniMaxVideoTask({ taskId, model }) {
  const root = ywRoot();
  const qr = await ywJson(`${root}/minimax/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`, {}, 30000);
  if (qr.status === 'Success' && qr.file_id) {
    const fr = await ywJson(`${root}/minimax/v1/files/retrieve?file_id=${encodeURIComponent(qr.file_id)}`, {}, 30000);
    const url = fr.file?.download_url || fr.file?.backup_download_url || null;
    return { model, url, taskId, status: 'Success', ready: !!url, raw: '视频任务已完成' };
  }
  if (qr.status === 'Fail') return { model, url: null, taskId, status: 'Fail', ready: false, raw: '视频任务失败，上游未返回可交付结果' };
  return { model, url: null, taskId, status: qr.status || 'Processing', ready: false, raw: '视频任务处理中' };
}

async function summarizeVideoReferences(images, prompt, signal) {
  if (images.length <= 1) return '';
  try {
    const content = [
      { type: 'text', text: `分析这些视频参考图，提炼必须保持一致的主体、服装、产品、空间、配色和镜头语言。只输出一段不超过220字的中文视觉约束，服务于提示词：${String(prompt).slice(0, 500)}` },
      ...images.map(url => ({ type: 'image_url', image_url: { url } })),
    ];
    const out = await chat({
      model: routing().vision,
      messages: [{ role: 'user', content }],
      maxTokens: 450,
      timeoutMs: 20000,
      signal,
    });
    return out.text.trim().slice(0, 600);
  } catch (error) {
    if (error?.status === 499) throw error;
    return '';
  }
}

// 视频任务只在当前请求中完成“参考图理解+任务提交”，成片由媒体任务列表异步轮询。
export async function generateVideo({ prompt, model, images = [], image, signal }) {
  const m = model || routing().videoDefault;
  const info = videoModelInfo(m);
  const references = (Array.isArray(images) && images.length ? images : [image]).filter(Boolean);
  const referenceBrief = await summarizeVideoReferences(references, prompt, signal);
  const effectivePrompt = referenceBrief ? `${prompt}\n多图视觉一致性约束：${referenceBrief}` : prompt;
  let out;
  if (info.adapter === 'minimax') out = await submitMiniMaxVideoTask({ prompt: effectivePrompt, model: m, images: references, signal });
  else if (info.adapter === 'alibailian-video' && info.supported) out = await submitAliBailianVideoTask({ prompt: effectivePrompt, model: m, images: references, signal });
  else if (info.adapter === 'unified' && info.supported) out = await submitUnifiedVideoTask({ prompt: effectivePrompt, model: m, images: references, signal });
  if (out) return {
    ...out,
    referencesUsed: references.length,
    referenceMode: references.length > 1
      ? (info.adapter === 'unified' ? 'multi-reference' : 'multi-reference-analysis+first-frame')
      : references.length ? 'first-frame' : 'text-only',
  };
  const err = new Error(`视频模型「${info.displayName}（${info.shortName}）」暂未接入可用任务接口，不能走文字聊天接口生成视频。请先选择绿色“已接入”的视频模型。`);
  err.status = 400;
  throw err;
}
export async function fetchVideoTask({ taskId, model }) {
  if (!taskId) return null;
  const info = videoModelInfo(model);
  if (info.adapter === 'minimax') return queryMiniMaxVideoTask({ taskId, model });
  if (info.adapter === 'alibailian-video' && info.supported) return queryAliBailianVideoTask({ taskId, model });
  if (info.adapter === 'unified' && info.supported) return queryUnifiedVideoTask({ taskId, model });
  return null;
}

// AI 带货员 · TTS 音轨（MiniMax speech-2.8-hd 经云雾）+ 时长量测/压速/精简回路 + 字幕时间轴
//
// 每段口播 → minimax-voice.js synthesize → 下载 mp3 → ffprobe 量时长：
//   ≤ 15s            直接用；
//   15s < d ≤ 16.5s  atempo（≤1.1）压回 15s 内；
//   > 16.5s          交回脚本引擎精简该段（最多 1 次），再合成一次；仍超 → blocked。
// 固定两段各15秒：音轨补齐到15秒，视频也请求15秒，第二段起点不会随口播长度漂移。
//
// 音轨必须能被云雾/百炼拉取：publishAsset 注入限时令牌 URL（有效期内可重复拉取），
// 本机无公网 base URL 时 publishAsset 返回 null → blocked（原因：音轨需公网可达地址）。

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { countSpeechChars, splitSpeechSentences } from './ai-sales-video-script.js';
import { fetchProviderMediaBytes, parseProviderMediaUrl } from './provider-media-download.js';

export const AI_SALES_VIDEO_TTS_MODEL = 'speech-2.8-hd';
export const AI_SALES_VIDEO_VOICE_SEGMENT_SECONDS = 15;
export const AI_SALES_VIDEO_VOICE_TEMPO_MAX = 1.1;
export const AI_SALES_VIDEO_VOICE_CONDENSE_THRESHOLD_SECONDS = 16.5;
export const AI_SALES_VIDEO_VOICE_MIN_PROVIDER_DURATION = 3;
export const AI_SALES_VIDEO_VOICE_MAX_TTS_CALLS = 3; // 2 段 + 最多 1 次精简重合成
export const AI_SALES_VIDEO_DEFAULT_VOICE_ID = 'presenter_female';
export const AI_SALES_VIDEO_SYSTEM_VOICES = Object.freeze([
  { id: 'presenter_female', label: '主持女声（播音腔）', cloned: false },
  { id: 'presenter_male', label: '主持男声（播音腔）', cloned: false },
  { id: 'female-yujie', label: '御姐音（沉稳）', cloned: false },
  { id: 'female-shaonv', label: '少女音（活泼）', cloned: false },
  { id: 'male-qn-jingying', label: '精英男声（干练商务）', cloned: false },
  { id: 'male-qn-qingse', label: '青涩男声（阳光少年）', cloned: false },
  { id: 'audiobook_female_1', label: '有声书女声（温柔）', cloned: false },
  { id: 'audiobook_male_1', label: '有声书男声（讲述感）', cloned: false },
]);

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const VOICE_ID_RE = /^[a-z0-9_-]{3,64}$/iu;

export class AiSalesVideoVoiceError extends Error {
  constructor(message, { code = 'AI_SALES_VIDEO_VOICE_BLOCKED', status = 409, blocked = true, ttsCalls = 0 } = {}) {
    super(message);
    this.name = 'AiSalesVideoVoiceError';
    this.code = code;
    this.status = status;
    this.blocked = blocked;
    this.ttsCalls = ttsCalls;
  }
}

function fail(message, options) {
  return new AiSalesVideoVoiceError(message, options);
}

export function safeAiSalesVideoVoiceId(value) {
  const id = String(value || AI_SALES_VIDEO_DEFAULT_VOICE_ID).trim();
  if (!VOICE_ID_RE.test(id)) {
    throw fail('音色ID格式不正确', { code: 'AI_SALES_VIDEO_VOICE_ID_INVALID', status: 400, blocked: false });
  }
  return id;
}

function numberForFilter(value) {
  return Number(value)
    .toFixed(3)
    .replace(/\.?0+$/u, '');
}

function parseDuration(result) {
  let payload;
  try {
    payload = JSON.parse(String(result?.stdout || ''));
  } catch {
    throw fail('音轨探测结果无效', { code: 'AI_SALES_VIDEO_VOICE_PROBE_FAILED', status: 502 });
  }
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const audio = streams.find(stream => stream?.codec_type === 'audio');
  const duration = Number(payload?.format?.duration || audio?.duration);
  if (!audio || !Number.isFinite(duration) || duration <= 0 || duration > 600) {
    throw fail('音轨缺少可用音频流或时长无效', { code: 'AI_SALES_VIDEO_VOICE_PROBE_FAILED', status: 502 });
  }
  return duration;
}

export async function measureAudioDuration({ runner, ffprobePath, filePath, cwd }) {
  const args = [
    '-v',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-show_entries',
    'format=duration:stream=codec_type,duration',
    '-of',
    'json',
    filePath,
  ];
  let result;
  try {
    result = await runner(ffprobePath, args, { cwd });
  } catch (error) {
    if (error instanceof AiSalesVideoVoiceError) throw error;
    throw fail(`ffprobe 量测音轨失败${error?.code ? `（${String(error.code).slice(0, 40)}）` : ''}`, {
      code: 'AI_SALES_VIDEO_VOICE_PROBE_FAILED',
      status: 502,
    });
  }
  return parseDuration(result);
}

/**
 * 时长决策（纯函数）：返回 { action:'keep'|'tempo'|'condense', tempo, providerDuration }。
 */
export function decideVoiceTrackFit(
  measuredSeconds,
  {
    segmentSeconds = AI_SALES_VIDEO_VOICE_SEGMENT_SECONDS,
    tempoMax = AI_SALES_VIDEO_VOICE_TEMPO_MAX,
    condenseThreshold = AI_SALES_VIDEO_VOICE_CONDENSE_THRESHOLD_SECONDS,
  } = {},
) {
  const measured = Number(measuredSeconds);
  if (
    !Number.isFinite(measured) ||
    measured <= 0 ||
    !Number.isFinite(segmentSeconds) ||
    segmentSeconds < 3 ||
    segmentSeconds > 15 ||
    !Number.isFinite(tempoMax) ||
    tempoMax < 1 ||
    tempoMax > 1.1 ||
    !Number.isFinite(condenseThreshold) ||
    condenseThreshold < segmentSeconds
  ) {
    throw fail('音轨时长无效', { code: 'AI_SALES_VIDEO_VOICE_PROBE_FAILED', status: 502 });
  }
  if (measured > Math.min(condenseThreshold, segmentSeconds * tempoMax)) {
    return { action: 'condense', tempo: 1, providerDuration: segmentSeconds, speechSeconds: measured };
  }
  if (measured > segmentSeconds) {
    const tempo = Math.min(tempoMax, Math.ceil((measured / segmentSeconds) * 1000) / 1000);
    const speechSeconds = measured / tempo;
    return {
      action: 'tempo',
      tempo,
      speechSeconds,
      providerDuration: segmentSeconds,
    };
  }
  return {
    action: 'keep',
    tempo: 1,
    speechSeconds: measured,
    providerDuration: segmentSeconds,
  };
}

/** 组装 ffmpeg 参数（纯函数，测试可断言 atempo / apad / -t）。 */
export function buildVoiceTrackFitArgs({ inputPath, outputPath, tempo = 1, providerDuration }) {
  const filters = [];
  if (Number(tempo) > 1) filters.push(`atempo=${numberForFilter(tempo)}`);
  filters.push(`apad=whole_dur=${numberForFilter(providerDuration)}`);
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-protocol_whitelist',
    'file,pipe',
    '-i',
    inputPath,
    '-af',
    filters.join(','),
    '-t',
    numberForFilter(providerDuration),
    '-ar',
    '32000',
    '-ac',
    '1',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    outputPath,
  ];
}

async function downloadAudio({ url, destination, fetchImpl, signal }) {
  const { bytes } = await fetchProviderMediaBytes(url, { kind: 'audio', maxBytes: MAX_AUDIO_BYTES, fetchImpl, signal });
  await fsp.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  return bytes;
}

async function sha256File(filePath) {
  const bytes = await fsp.readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * 为脚本的每段口播合成音轨。返回 { tracks, ttsCalls, script（可能被精简）, condensed }。
 *
 * @param {object} options
 * @param {object} options.script 已通过契约的脚本
 * @param {string} options.voiceId 系统音色或租户已克隆音色
 * @param {{synthesize:Function}} options.voiceClient minimax-voice.js 客户端
 * @param {Function} options.runner (command,args,opts)=>Promise<{stdout}> 可注入
 * @param {Function} options.fetchImpl 下载配音 URL
 * @param {Function} options.publishAsset ({bytes,ext,mime,purpose,label})=>Promise<string|null> 供应商可拉取 URL
 * @param {Function} [options.condenseShot] ({script,shotIndex,measuredSeconds})=>Promise<{script}>
 */
export async function synthesizeAiSalesVideoVoiceTracks({
  script,
  voiceId,
  voiceClient,
  runner,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
  fetchImpl,
  workDir,
  publishAsset,
  condenseShot = null,
  segmentSeconds = AI_SALES_VIDEO_VOICE_SEGMENT_SECONDS,
  maxTtsCalls = AI_SALES_VIDEO_VOICE_MAX_TTS_CALLS,
  signal,
  onTtsCall = null,
  onTrackReady = null,
} = {}) {
  if (!voiceClient || typeof voiceClient.synthesize !== 'function') {
    throw fail('配音通道未配置（MiniMax 语音客户端缺失）', {
      code: 'AI_SALES_VIDEO_VOICE_CLIENT_MISSING',
      status: 503,
    });
  }
  if (typeof runner !== 'function') {
    throw fail('音轨处理缺少 ffmpeg 执行器', {
      code: 'AI_SALES_VIDEO_VOICE_RUNNER_MISSING',
      status: 500,
      blocked: false,
    });
  }
  if (typeof publishAsset !== 'function') {
    throw fail('音轨需公网可达地址，请在演示服务器运行（未配置供应商可拉取的令牌 URL）', {
      code: 'AI_SALES_VIDEO_VOICE_PUBLIC_URL_MISSING',
      status: 503,
    });
  }
  if (typeof workDir !== 'string' || !path.isAbsolute(workDir)) {
    throw fail('音轨工作目录无效', { code: 'AI_SALES_VIDEO_VOICE_WORKDIR_INVALID', status: 500, blocked: false });
  }
  const resolvedVoiceId = safeAiSalesVideoVoiceId(voiceId);
  if (
    segmentSeconds !== 15 ||
    !Number.isInteger(maxTtsCalls) ||
    maxTtsCalls < 2 ||
    maxTtsCalls > AI_SALES_VIDEO_VOICE_MAX_TTS_CALLS
  ) {
    throw fail('有声带货固定每段15秒且最多3次配音调用', {
      code: 'AI_SALES_VIDEO_INVALID_INPUT',
      status: 400,
      blocked: false,
    });
  }
  let currentScript = script;
  let ttsCalls = 0;
  let condensed = false;
  const tracks = [];
  const shots = Array.isArray(currentScript?.shots) ? [...currentScript.shots] : [];
  if (
    shots.length !== 2 ||
    shots.some((shot, i) => Number(shot.index) !== i + 1 || !String(shot.voiceover || '').trim())
  ) {
    throw fail('脚本必须包含顺序正确的两段口播', { code: 'AI_SALES_VIDEO_INVALID_INPUT', status: 400, blocked: false });
  }

  const synthesizeOnce = async (shot, attemptLabel) => {
    if (ttsCalls >= maxTtsCalls) {
      throw fail(`配音调用次数超过上限 ${maxTtsCalls} 次，已停止`, {
        code: 'AI_SALES_VIDEO_VOICE_CALL_LIMIT',
        status: 409,
        ttsCalls,
      });
    }
    ttsCalls += 1;
    if (typeof onTtsCall === 'function') await onTtsCall({ shotIndex: shot.index, ttsCalls });
    const output = await voiceClient.synthesize({ text: shot.voiceover, voiceId: resolvedVoiceId, signal });
    const audioUrl = String(output?.audioUrl || '').trim();
    if (!audioUrl)
      throw fail('配音服务未返回音频地址', { code: 'AI_SALES_VIDEO_VOICE_TTS_FAILED', status: 502, ttsCalls });
    const rawPath = path.join(workDir, `voice-${shot.index}-${attemptLabel}-raw.mp3`);
    await downloadAudio({ url: audioUrl, destination: rawPath, fetchImpl, signal });
    const measured = await measureAudioDuration({ runner, ffprobePath, filePath: rawPath, cwd: workDir });
    return { rawPath, measured };
  };

  for (let offset = 0; offset < shots.length; offset += 1) {
    let shot = shots[offset];
    let { rawPath, measured } = await synthesizeOnce(shot, 'a');
    let fit = decideVoiceTrackFit(measured, { segmentSeconds });
    let condensedThisShot = false;
    if (fit.action === 'condense') {
      if (condensed)
        throw fail('本任务已使用一次精简，不能再次调用精简模型', { code: 'AI_SALES_VIDEO_VOICE_CALL_LIMIT', ttsCalls });
      if (typeof condenseShot !== 'function') {
        throw fail(
          `第 ${shot.index} 段配音实测 ${measured.toFixed(1)} 秒，超过 ${AI_SALES_VIDEO_VOICE_CONDENSE_THRESHOLD_SECONDS} 秒且未配置精简回路`,
          {
            code: 'AI_SALES_VIDEO_VOICE_TOO_LONG',
            ttsCalls,
          },
        );
      }
      const condensedResult = await condenseShot({
        script: currentScript,
        shotIndex: shot.index,
        measuredSeconds: measured,
        targetSeconds: segmentSeconds,
      });
      if (!condensedResult?.script) {
        throw fail(`第 ${shot.index} 段配音超时且精简失败`, { code: 'AI_SALES_VIDEO_VOICE_TOO_LONG', ttsCalls });
      }
      currentScript = condensedResult.script;
      shot = currentScript.shots.find(item => Number(item.index) === Number(shots[offset].index)) || shot;
      shots[offset] = shot;
      condensed = true;
      condensedThisShot = true;
      await fsp.rm(rawPath, { force: true }).catch(() => {});
      ({ rawPath, measured } = await synthesizeOnce(shot, 'b'));
      fit = decideVoiceTrackFit(measured, { segmentSeconds });
      if (fit.action === 'condense') {
        throw fail(
          `第 ${shot.index} 段精简后配音仍 ${measured.toFixed(1)} 秒，超过 ${AI_SALES_VIDEO_VOICE_CONDENSE_THRESHOLD_SECONDS} 秒上限；请缩短口播后重试`,
          {
            code: 'AI_SALES_VIDEO_VOICE_TOO_LONG',
            ttsCalls,
          },
        );
      }
    }
    const outputPath = path.join(workDir, `voice-${shot.index}-fit.mp3`);
    const args = buildVoiceTrackFitArgs({
      inputPath: rawPath,
      outputPath,
      tempo: fit.tempo,
      providerDuration: fit.providerDuration,
    });
    try {
      await runner(ffmpegPath, args, { cwd: workDir });
    } catch (error) {
      if (error instanceof AiSalesVideoVoiceError) throw error;
      throw fail(`第 ${shot.index} 段音轨压速/补齐失败`, {
        code: 'AI_SALES_VIDEO_VOICE_FIT_FAILED',
        status: 502,
        ttsCalls,
      });
    }
    const finalDuration = await measureAudioDuration({ runner, ffprobePath, filePath: outputPath, cwd: workDir });
    if (Math.abs(finalDuration - segmentSeconds) > 0.25) {
      throw fail(`第 ${shot.index} 段音轨处理后时长 ${finalDuration.toFixed(2)} 秒，不符合 ${segmentSeconds} 秒`, {
        code: 'AI_SALES_VIDEO_VOICE_TOO_LONG',
        ttsCalls,
      });
    }
    const bytes = await fsp.readFile(outputPath);
    if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw fail('处理后音轨超过安全大小上限', { ttsCalls });
    const published = await publishAsset({
      bytes,
      ext: 'mp3',
      mime: 'audio/mpeg',
      purpose: 'ai-sales-video-audio',
      label: `voice-${shot.index}`,
    });
    const publicUrl = typeof published === 'string' ? published : published?.url;
    if (!publicUrl || !/^https:\/\//iu.test(String(publicUrl))) {
      throw fail('音轨需公网可达地址，请在演示服务器运行（当前未生成 HTTPS 供应商可拉取地址）', {
        code: 'AI_SALES_VIDEO_VOICE_PUBLIC_URL_MISSING',
        status: 503,
        ttsCalls,
      });
    }
    parseProviderMediaUrl(publicUrl);
    const track = {
      index: Number(shot.index),
      text: shot.voiceover,
      chars: countSpeechChars(shot.voiceover),
      voiceId: resolvedVoiceId,
      model: AI_SALES_VIDEO_TTS_MODEL,
      measuredSeconds: Math.round(measured * 100) / 100,
      speechSeconds: Math.round(fit.speechSeconds * 100) / 100,
      tempo: fit.tempo,
      providerDuration: fit.providerDuration,
      durationSeconds: Math.round(finalDuration * 100) / 100,
      condensed: condensedThisShot,
      localPath: outputPath,
      sha256: await sha256File(outputPath),
      publicUrl: String(publicUrl),
      ...(Number.isSafeInteger(published?.fileId) && published.fileId > 0 ? { fileId: published.fileId } : {}),
    };
    if (published?.sha256 && published.sha256 !== track.sha256) throw fail('原配音资产回执与实测文件哈希不一致');
    tracks.push(track);
    if (typeof onTrackReady === 'function') await onTrackReady(track, currentScript);
  }
  return { tracks, ttsCalls, script: currentScript, condensed };
}

/**
 * 字幕时间轴：按脚本逐句切分，时间按 TTS 实测语速在该段内按字数比例分配。
 * 返回绝对时间 cues [{ index, shotIndex, start, end, text }]。
 */
export function buildAiSalesVideoSubtitleCues({
  script,
  tracks,
  segmentSeconds = AI_SALES_VIDEO_VOICE_SEGMENT_SECONDS,
} = {}) {
  const cues = [];
  const shots = Array.isArray(script?.shots) ? script.shots : [];
  for (const [offset, shot] of shots.entries()) {
    const track = (Array.isArray(tracks) ? tracks : []).find(item => Number(item.index) === Number(shot.index));
    const base = offset * segmentSeconds;
    const speech = Math.min(
      segmentSeconds,
      Math.max(1, Number(track?.speechSeconds || track?.durationSeconds || segmentSeconds)),
    );
    const sentences = splitSpeechSentences(shot.voiceover, { maxChars: 18 });
    const total = sentences.reduce((sum, sentence) => sum + Math.max(1, countSpeechChars(sentence)), 0) || 1;
    let cursor = 0;
    sentences.forEach((sentence, sentenceIndex) => {
      const share = (Math.max(1, countSpeechChars(sentence)) / total) * speech;
      const start = base + cursor;
      const isLast = sentenceIndex === sentences.length - 1;
      const end = isLast
        ? Math.min(base + segmentSeconds, base + speech)
        : Math.min(base + segmentSeconds, start + share);
      cues.push({
        index: cues.length + 1,
        shotIndex: Number(shot.index),
        start: Math.round(start * 1000) / 1000,
        end: Math.round(end * 1000) / 1000,
        text: sentence.replace(/[，,、；;]$/u, ''),
      });
      cursor += share;
    });
  }
  return cues;
}

function srtTime(seconds) {
  const total = Math.round(Math.max(0, Number(seconds) || 0) * 1000);
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const secs = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
}

export function buildAiSalesVideoSrt(cues) {
  return (Array.isArray(cues) ? cues : [])
    .map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`)
    .join('\n');
}

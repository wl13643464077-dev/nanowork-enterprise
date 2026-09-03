import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { mediaBinarySearchDirectories } from './media-binaries.js';

export const AI_SALES_VIDEO_TARGET_DURATION_SECONDS = 30;
export const AI_SALES_VIDEO_ALLOWED_SEGMENT_COUNTS = Object.freeze([2, 3]);
export const AI_SALES_VIDEO_UPLOAD_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/uploads/ai-sales-video',
);

const FFMPEG_BINARY_NAME = 'ffmpeg';
const FFPROBE_BINARY_NAME = 'ffprobe';
const VIDEO_CODEC = 'h264';
const AUDIO_CODEC = 'aac';
const MAX_TENANT_ID = 2_147_483_647;
const MIN_SEGMENT_DURATION_SECONDS = 0.05;
const MAX_SEGMENT_DURATION_SECONDS = 600;

function composerError(message, code = 'AI_SALES_VIDEO_COMPOSER_INVALID') {
  const error = new Error(message);
  error.code = code;
  error.status = code === 'AI_SALES_VIDEO_COMPOSER_INVALID' ? 400 : 502;
  return error;
}

function composerBinaryError(binaryName, code = 'AI_SALES_VIDEO_COMPOSER_BINARY_MISSING') {
  const label = binaryName === FFPROBE_BINARY_NAME ? 'ffprobe' : 'ffmpeg';
  const error = composerError(
    `视频合成环境缺少可执行的 ${label}；请安装 FFmpeg，或在服务环境中配置${label === 'ffmpeg' ? ' FFMPEG_PATH' : ' FFPROBE_PATH'}`,
    code,
  );
  error.binary = label;
  return error;
}

async function defaultExecutableCheck(candidate) {
  try {
    const stat = await fsp.stat(candidate);
    if (!stat.isFile()) return false;
    await fsp.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveComposerBinary({
  binaryName,
  explicitPath,
  pathEnv,
  isExecutable,
}) {
  const configured = String(explicitPath || '').trim();
  if (configured.includes('\0')) {
    throw composerBinaryError(binaryName, 'AI_SALES_VIDEO_COMPOSER_BINARY_PATH_INVALID');
  }
  if (configured && !path.isAbsolute(configured) && /[\\/]/u.test(configured)) {
    throw composerBinaryError(binaryName, 'AI_SALES_VIDEO_COMPOSER_BINARY_PATH_INVALID');
  }
  const executableName = configured && !path.isAbsolute(configured)
    ? configured
    : binaryName;
  if (!/^[A-Za-z0-9._+-]+$/u.test(executableName)) {
    throw composerBinaryError(binaryName, 'AI_SALES_VIDEO_COMPOSER_BINARY_PATH_INVALID');
  }
  // 目录探测清单与 media-binaries 保持同源，launchd 最小 PATH 也能命中 Homebrew。
  const candidates = path.isAbsolute(configured)
    ? [path.normalize(configured)]
    : mediaBinarySearchDirectories(pathEnv).map(directory => (
        path.join(directory, executableName)
      ));
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  throw composerBinaryError(binaryName);
}

/**
 * Resolve and preflight the native video tools before a caller creates a
 * credit hold or starts provider work. Explicit paths win; LaunchAgent's
 * minimal PATH is supplemented with the standard Homebrew locations.
 */
export async function assertAiSalesVideoComposerReady({
  env = process.env,
  pathEnv = env?.PATH,
  ffmpegPath,
  ffprobePath,
  isExecutable = defaultExecutableCheck,
} = {}) {
  if (typeof isExecutable !== 'function') {
    throw new TypeError('isExecutable must be a function');
  }
  const resolvedFfmpeg = await resolveComposerBinary({
    binaryName: FFMPEG_BINARY_NAME,
    explicitPath: ffmpegPath === undefined ? env?.FFMPEG_PATH : ffmpegPath,
    pathEnv,
    isExecutable,
  });
  const resolvedFfprobe = await resolveComposerBinary({
    binaryName: FFPROBE_BINARY_NAME,
    explicitPath: ffprobePath === undefined ? env?.FFPROBE_PATH : ffprobePath,
    pathEnv,
    isExecutable,
  });
  return {
    ffmpegPath: resolvedFfmpeg,
    ffprobePath: resolvedFfprobe,
  };
}

function commandError(file, args, result) {
  if (result?.code === 'ENOENT') {
    return composerBinaryError(path.basename(String(file || FFMPEG_BINARY_NAME)));
  }
  const error = composerError(
    `${path.basename(String(file || 'ffmpeg'))}执行失败${result?.stderr ? `：${String(result.stderr).slice(-500)}` : ''}`,
    'AI_SALES_VIDEO_COMPOSER_COMMAND_FAILED',
  );
  error.command = path.basename(String(file || ''));
  // Never expose the input/output paths or arbitrary provider diagnostics in a
  // public message. The redacted command metadata remains useful to logs/tests.
  error.commandArgCount = Array.isArray(args) ? args.length : 0;
  return error;
}

function ensureSafeTenantId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/u.test(text)) throw composerError('tenantId必须是正整数');
  const id = Number(text);
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_TENANT_ID) {
    throw composerError('tenantId必须是有效正整数');
  }
  return id;
}

function normalizeSegmentInput(value, index) {
  const candidate = typeof value === 'string' ? value : value?.path;
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw composerError(`第${index + 1}段缺少本地文件路径`);
  }
  if (candidate.includes('\0')) throw composerError(`第${index + 1}段路径包含非法字符`);
  const resolved = path.resolve(candidate);
  if (!path.isAbsolute(candidate) || resolved !== candidate) {
    throw composerError(`第${index + 1}段必须使用规范绝对本地路径`);
  }
  return resolved;
}

async function validateLocalSegments(segments) {
  if (!Array.isArray(segments) || !AI_SALES_VIDEO_ALLOWED_SEGMENT_COUNTS.includes(segments.length)) {
    throw composerError('视频合成必须提供2或3个本地片段');
  }
  const paths = segments.map(normalizeSegmentInput);
  const seen = new Set();
  for (const [index, filePath] of paths.entries()) {
    if (seen.has(filePath)) throw composerError(`第${index + 1}段与其他片段重复`);
    seen.add(filePath);
    let stat;
    try {
      // lstat deliberately rejects symlinks. A caller cannot use a link to
      // escape whatever local download directory the host granted it.
      stat = await fsp.lstat(filePath);
    } catch {
      throw composerError(`第${index + 1}段本地文件不存在`);
    }
    if (!stat.isFile()) throw composerError(`第${index + 1}段不是普通本地文件`);
  }
  return paths;
}

function commandResult(value) {
  if (!value || typeof value !== 'object') return { stdout: '', stderr: '' };
  return {
    stdout: String(value.stdout || ''),
    stderr: String(value.stderr || ''),
  };
}

function spawnCommand(file, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const result = { stdout, stderr, code, signal };
      if (code === 0) resolve(result);
      else reject(commandError(file, args, result));
    });
  });
}

function parseProbeResult(result, label) {
  let payload;
  try {
    payload = JSON.parse(commandResult(result).stdout);
  } catch {
    throw composerError(`${label}媒体探测结果无效`, 'AI_SALES_VIDEO_COMPOSER_PROBE_FAILED');
  }
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video');
  if (!video) throw composerError(`${label}缺少视频轨道`, 'AI_SALES_VIDEO_COMPOSER_PROBE_FAILED');
  const audio = streams.find((stream) => stream?.codec_type === 'audio');
  const duration = Number(payload?.format?.duration || video?.duration);
  if (!Number.isFinite(duration)
    || duration < MIN_SEGMENT_DURATION_SECONDS
    || duration > MAX_SEGMENT_DURATION_SECONDS) {
    throw composerError(`${label}时长无效`, 'AI_SALES_VIDEO_COMPOSER_PROBE_FAILED');
  }
  return {
    duration,
    hasAudio: Boolean(audio),
    width: Number(video.width) || null,
    height: Number(video.height) || null,
    videoCodec: String(video.codec_name || '').toLowerCase() || null,
    audioCodec: String(audio?.codec_name || '').toLowerCase() || null,
  };
}

function numberForFilter(value) {
  return Number(value).toFixed(3).replace(/\.000$/u, '');
}

function buildFilterGraph(probes, targetDuration) {
  const concatInputs = [];
  const filters = [];
  for (const [index, probe] of probes.entries()) {
    const videoLabel = `v${index}`;
    const audioLabel = `a${index}`;
    filters.push(
      `[${index}:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
      `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,` +
      `fps=30,format=yuv420p,setpts=PTS-STARTPTS[${videoLabel}]`,
    );
    if (probe.hasAudio) {
      filters.push(`[${index}:a]aresample=48000,asetpts=PTS-STARTPTS[${audioLabel}]`);
    } else {
      filters.push(
        `anullsrc=channel_layout=stereo:sample_rate=48000,` +
        `atrim=duration=${numberForFilter(probe.duration)},` +
        `asetpts=PTS-STARTPTS[${audioLabel}]`,
      );
    }
    concatInputs.push(`[${videoLabel}][${audioLabel}]`);
  }
  const concatVideo = 'concatVideo';
  const concatAudio = 'concatAudio';
  filters.push(
    `${concatInputs.join('')}concat=n=${probes.length}:v=1:a=1[${concatVideo}][${concatAudio}]`,
  );
  const padding = Math.max(0, targetDuration - probes.reduce((sum, probe) => sum + probe.duration, 0));
  filters.push(
    `[${concatVideo}]tpad=stop_mode=clone:stop_duration=${numberForFilter(padding)},` +
    `trim=duration=${numberForFilter(targetDuration)},setpts=PTS-STARTPTS[vout]`,
  );
  filters.push(
    `[${concatAudio}]apad=pad_dur=${numberForFilter(padding)},` +
    `atrim=duration=${numberForFilter(targetDuration)},asetpts=PTS-STARTPTS[aout]`,
  );
  return filters.join(';');
}

function secureOutputPath(outputRoot, tenantId) {
  const tenantDir = path.resolve(outputRoot, String(tenantId));
  const root = path.resolve(outputRoot);
  const relative = path.relative(root, tenantDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw composerError('输出目录越界');
  }
  const filename = `sales-video-${crypto.randomBytes(18).toString('hex')}.mp4`;
  const filePath = path.resolve(tenantDir, filename);
  const fileRelative = path.relative(tenantDir, filePath);
  if (fileRelative.startsWith('..') || path.isAbsolute(fileRelative) || !/^sales-video-[a-f0-9]{36}\.mp4$/u.test(filename)) {
    throw composerError('输出文件名不安全');
  }
  return { tenantDir, filePath };
}

function parseOutputDuration(probeResult, targetDuration) {
  const parsed = parseProbeResult(probeResult, '合成结果');
  const tolerance = Math.max(0.75, targetDuration * 0.05);
  if (Math.abs(parsed.duration - targetDuration) > tolerance) {
    throw composerError(
      `合成结果时长${parsed.duration.toFixed(2)}秒不在目标范围内`,
      'AI_SALES_VIDEO_COMPOSER_OUTPUT_INVALID',
    );
  }
  if (parsed.width !== 1080 || parsed.height !== 1920
    || !['h264', 'avc1'].includes(parsed.videoCodec)
    || parsed.audioCodec !== 'aac') {
    throw composerError(
      '合成结果编码或竖屏尺寸不符合1080x1920/H264/AAC契约',
      'AI_SALES_VIDEO_COMPOSER_OUTPUT_INVALID',
    );
  }
  return parsed;
}

/**
 * Normalize two or three downloaded local clips and concatenate them into a
 * protected 30-second portrait MP4. `runner` receives `(command,args,opts)`
 * and is injectable for hermetic tests; the production runner always uses
 * spawn with `shell:false` and an argument array.
 */
export async function composeAiSalesVideo({
  tenantId,
  segments,
  outputRoot = AI_SALES_VIDEO_UPLOAD_ROOT,
  ffmpegPath,
  ffprobePath,
  runner = spawnCommand,
  targetDurationSeconds = AI_SALES_VIDEO_TARGET_DURATION_SECONDS,
} = {}) {
  let resolvedFfmpegPath = ffmpegPath;
  let resolvedFfprobePath = ffprobePath;
  if (runner === spawnCommand) {
    const ready = await assertAiSalesVideoComposerReady({
      ffmpegPath,
      ffprobePath,
    });
    resolvedFfmpegPath = ready.ffmpegPath;
    resolvedFfprobePath = ready.ffprobePath;
  } else {
    // Injected runners are hermetic test/adaptor boundaries; they receive the
    // requested command label without inspecting the host filesystem.
    resolvedFfmpegPath = resolvedFfmpegPath || process.env.FFMPEG_PATH || FFMPEG_BINARY_NAME;
    resolvedFfprobePath = resolvedFfprobePath || process.env.FFPROBE_PATH || FFPROBE_BINARY_NAME;
  }
  const safeTenantId = ensureSafeTenantId(tenantId);
  const targetDuration = Number(targetDurationSeconds);
  if (!Number.isFinite(targetDuration) || targetDuration <= 0 || targetDuration > 3600) {
    throw composerError('目标视频时长无效');
  }
  const inputPaths = await validateLocalSegments(segments);
  if (typeof outputRoot !== 'string' || !outputRoot.trim() || outputRoot.includes('\0')
    || !path.isAbsolute(outputRoot)) {
    throw composerError('输出目录必须是绝对本地路径');
  }
  const root = path.resolve(outputRoot);
  if (root !== outputRoot || root === path.parse(root).root) throw composerError('输出目录无效');
  const { tenantDir, filePath } = secureOutputPath(root, safeTenantId);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nanowork-ai-sales-video-'));
  const tempOutput = path.join(tempDir, 'composed.mp4');
  let committed = false;
  try {
    const probes = [];
    for (const [index, inputPath] of inputPaths.entries()) {
      const args = [
        '-v', 'error',
        '-show_entries', 'format=duration:stream=codec_type,width,height,duration',
        '-of', 'json',
        inputPath,
      ];
      let result;
      try {
        result = await runner(resolvedFfprobePath, args, { cwd: tempDir });
      } catch (error) {
        if (error?.code?.startsWith('AI_SALES_VIDEO_COMPOSER_')) throw error;
        throw commandError(resolvedFfprobePath, args, error);
      }
      probes.push(parseProbeResult(result, `第${index + 1}段`));
    }

    const ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-y'];
    for (const inputPath of inputPaths) ffmpegArgs.push('-i', inputPath);
    ffmpegArgs.push(
      '-filter_complex', buildFilterGraph(probes, targetDuration),
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', VIDEO_CODEC,
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      '-c:a', AUDIO_CODEC,
      '-ar', '48000',
      '-ac', '2',
      '-movflags', '+faststart',
      '-t', numberForFilter(targetDuration),
      tempOutput,
    );
    try {
      const result = await runner(resolvedFfmpegPath, ffmpegArgs, { cwd: tempDir });
      if (result?.code !== undefined && Number(result.code) !== 0) {
        throw commandError(resolvedFfmpegPath, ffmpegArgs, result);
      }
    } catch (error) {
      if (error?.code?.startsWith('AI_SALES_VIDEO_COMPOSER_')) throw error;
      throw commandError(resolvedFfmpegPath, ffmpegArgs, error);
    }
    const outputStat = await fsp.stat(tempOutput).catch(() => null);
    if (!outputStat?.isFile() || outputStat.size < 1) {
      throw composerError('ffmpeg未形成合成文件', 'AI_SALES_VIDEO_COMPOSER_OUTPUT_INVALID');
    }
    let outputProbeResult;
    try {
      outputProbeResult = await runner(resolvedFfprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height',
        '-of', 'json',
        tempOutput,
      ], { cwd: tempDir });
    } catch (error) {
      if (error?.code?.startsWith('AI_SALES_VIDEO_COMPOSER_')) throw error;
      throw commandError(resolvedFfprobePath, [], error);
    }
    const outputProbe = parseOutputDuration(outputProbeResult, targetDuration);
    await fsp.mkdir(tenantDir, { recursive: true, mode: 0o750 });
    await fsp.rename(tempOutput, filePath);
    committed = true;
    const digest = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.once('error', reject);
      stream.once('end', () => resolve(hash.digest('hex')));
    });
    return {
      path: filePath,
      absolutePath: filePath,
      url: `/uploads/ai-sales-video/${safeTenantId}/${path.basename(filePath)}`,
      duration: outputProbe.duration,
      durationSeconds: outputProbe.duration,
      sha256: digest,
      tenantId: safeTenantId,
      width: outputProbe.width || 1080,
      height: outputProbe.height || 1920,
      videoCodec: VIDEO_CODEC,
      audioCodec: AUDIO_CODEC,
      segmentCount: inputPaths.length,
    };
  } catch (error) {
    if (committed) await fsp.rm(filePath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export const composeVideo = composeAiSalesVideo;

// Read-only media inspection. Writes evidence images/JSON, never a replacement video.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/verify-native-live-artifacts.mjs --input /path/generated.mp4 --out /path/acceptance');
  process.exit(0);
}
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--input', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--'))
    throw new Error('Required: --input local.mp4 --out evidence-directory');
  options[args[i].slice(2)] = args[i + 1];
}
if (!options.input || !options.out) throw new Error('Required: --input local.mp4 --out evidence-directory');
const input = await fsp.realpath(path.resolve(options.input));
if (path.extname(input).toLowerCase() !== '.mp4' || !(await fsp.stat(input)).isFile())
  throw new Error('Input must be an existing local MP4 file');
const run = (binary, parameters) => {
  const result = spawnSync(binary, parameters, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new Error(`${binary} failed: ${result.error?.message || result.stderr?.slice(-4000) || result.status}`);
  return result;
};
const sha256 = async (file) => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const beforeHash = await sha256(input);
const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe',
  '-show_streams', '-show_format', '-of', 'json', input]).stdout);
const video = probe.streams.find(stream => stream.codec_type === 'video');
if (!video) throw new Error('Input contains no video stream');
const duration = Number(probe.format.duration || video.duration);
if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not determine duration');
await fsp.mkdir(path.resolve(options.out), { recursive: true });
const directory = await fsp.mkdtemp(path.join(path.resolve(options.out), 'video-analysis-'));
const framerate = String(video.avg_frame_rate || video.r_frame_rate || '0/1').split('/').map(Number);
const audioTracks = [];
for (const audio of probe.streams.filter(stream => stream.codec_type === 'audio')) {
  const log = run(ffmpeg, ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', input,
    '-map', `0:${audio.index}`, '-vn', '-af', 'silencedetect=noise=-50dB:d=0.5,volumedetect', '-f', 'null', '-']).stderr;
  await fsp.writeFile(path.join(directory, `audio-${audio.index}-analysis.log`), log);
  const audioDuration = Number(audio.duration) || duration;
  const intervals = [];
  let start = null;
  for (const match of log.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
    const value = Number(match[2]);
    if (match[1] === 'start') start = value;
    else { intervals.push([Math.max(0, start ?? 0), Math.min(audioDuration, value)]); start = null; }
  }
  if (start !== null) intervals.push([start, audioDuration]);
  const seconds = intervals.reduce((sum, [from, to]) => sum + Math.max(0, to - from), 0);
  const volume = name => {
    const value = log.match(new RegExp(`${name}_volume:\\s*(-?(?:[\\d.]+|inf))\\s*dB`))?.[1];
    return value === '-inf' ? '-Infinity' : value === undefined ? null : Number(value);
  };
  audioTracks.push({ index: audio.index, codec: audio.codec_name, sampleRate: Number(audio.sample_rate),
    channels: audio.channels, durationSeconds: audioDuration, thresholdDb: -50, minimumSilenceSeconds: 0.5,
    silenceIntervals: intervals, silentSeconds: seconds, silentFraction: Math.min(1, seconds / audioDuration),
    whollySilent: seconds >= audioDuration - 0.05, meanVolumeDb: volume('mean'), peakVolumeDb: volume('max') });
}
const frames = [];
for (const second of [2, 12, 22]) {
  if (second >= duration) { frames.push({ second, available: false, reason: 'beyond_video_duration' }); continue; }
  const file = path.join(directory, `frame-${String(second).padStart(2, '0')}s.png`);
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe',
    '-ss', String(second), '-i', input, '-map', `0:${video.index}`, '-frames:v', '1', '-an', file]);
  frames.push({ second, available: true, file });
}
const available = frames.filter(frame => frame.available);
let contactSheet = null;
if (available.length) {
  contactSheet = path.join(directory, 'contact-sheet-2s-12s-22s.png');
  const filters = available.map((_, index) => `[${index}:v]scale=360:640:force_original_aspect_ratio=decrease,pad=360:640:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v${index}]`);
  filters.push(available.length === 1 ? '[v0]null[out]' : `${available.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${available.length}[out]`);
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
    ...available.flatMap(frame => ['-protocol_whitelist', 'file,pipe', '-i', frame.file]),
    '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', contactSheet]);
}
const afterHash = await sha256(input);
if (beforeHash !== afterHash) throw new Error('Source video changed during inspection');
const report = {
  analyzedAt: new Date().toISOString(), analysisOnly: true,
  input: { path: input, sha256: beforeHash, bytes: (await fsp.stat(input)).size, unchanged: true },
  video: { durationSeconds: duration, width: video.width, height: video.height,
    frameRate: framerate[1] ? framerate[0] / framerate[1] : null,
    frameRateFraction: video.avg_frame_rate, codec: video.codec_name, pixelFormat: video.pix_fmt },
  audio: { streamPresent: audioTracks.length > 0, tracks: audioTracks,
    audibleAboveThreshold: audioTracks.some(track => !track.whollySilent),
    status: !audioTracks.length ? 'no_audio_stream' : audioTracks.every(track => track.whollySilent) ? 'wholly_silent' : 'not_wholly_silent',
    limitation: 'Detects silence at -50 dB; an audio stream alone does not prove audible speech, music or content quality.' },
  frames, contactSheet,
  checks: { durationMatches30Seconds: Math.abs(duration - 30) <= 0.25, allRequestedFramesExtracted: available.length === 3 },
};
const reportPath = path.join(directory, 'verification.json');
await fsp.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ reportPath, contactSheet, video: report.video, audioStatus: report.audio.status,
  sourceUnchanged: true }, null, 2));

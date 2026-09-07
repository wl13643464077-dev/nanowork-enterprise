import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AI_SALES_VIDEO_UPLOAD_ROOT, runAiSalesMediaCommand } from './video-composer.js';

// Preserve provider footage separately from a verified, subtitled 15/30-second delivery.
export async function preserveSalesVideoClip({ clip, tenantId, jobId, index, binaries, runner = runAiSalesMediaCommand }) {
  if (![tenantId, jobId, index].every(Number.isSafeInteger) || tenantId < 1 || jobId < 1 || ![1, 2].includes(index))
    throw new Error('片段归属无效');
  const source = clip.path || clip.absolutePath;
  const handle = await fsp.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 180 * 1024 * 1024) throw new Error('片段文件无效');
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  const probe = JSON.parse((await runner(binaries.ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', source])).stdout);
  const durationSeconds = Number(probe.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 31
    || !probe.streams?.some(stream => stream.codec_type === 'video')) throw new Error('片段视频或时长未核验');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const root = path.join(AI_SALES_VIDEO_UPLOAD_ROOT, String(tenantId));
  await fsp.mkdir(root, { recursive: true });
  if (await fsp.realpath(root) !== path.join(await fsp.realpath(AI_SALES_VIDEO_UPLOAD_ROOT), String(tenantId)))
    throw new Error('片段目录越界');
  const name = `partial-${jobId}-${index}-${sha256.slice(0, 24)}.mp4`;
  const output = path.join(root, name);
  try { await fsp.writeFile(output, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await fsp.open(output, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { if (crypto.createHash('sha256').update(await existing.readFile()).digest('hex') !== sha256) throw new Error('已有片段校验失败'); }
    finally { await existing.close(); }
  }
  return { index, url: `/uploads/ai-sales-video/${tenantId}/${name}`, durationSeconds, sha256, bytes: bytes.length,
    audioSource: 'provider_native', hasAudio: probe.streams.some(stream => stream.codec_type === 'audio'), subtitlesBurnedIn: false };
}

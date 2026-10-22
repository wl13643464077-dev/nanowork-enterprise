import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareAiSalesVideoReferenceFrames } from '../src/engines/ai-sales-video-reference-frames.js';
import { assertAiSalesVideoComposerReady, runAiSalesMediaCommand as runner } from '../src/engines/video-composer.js';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nw-reference-frame-test-'));
  try { return await run(root, await assertAiSalesVideoComposerReady()); }
  finally { await fsp.rm(root, { recursive: true, force: true }); }
}
async function makeImage(root, tools, name, size, color = '0x269c60', extra = []) {
  const file = path.join(root, name);
  await runner(tools.ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=${size},format=rgba`, ...extra, '-frames:v', '1', file]);
  return fsp.readFile(file);
}
async function pixels(root, tools, index, width, height) {
  const output = path.join(root, `pixels-${index}.rgb`);
  await runner(tools.ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error',
    '-i', path.join(root, `reference-prepared-${index}.jpg`), '-frames:v', '1',
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', output]);
  const bytes = await fsp.readFile(output);
  assert.equal(bytes.length, width * height * 3);
  return (x, y) => [...bytes.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
}
function near(actual, expected, tolerance = 12) {
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance,
    `pixel ${actual} differs from ${expected}`));
}

test('真实FFmpeg：横图、方图、竖图和超长图均填满720×1280，无白边或黑边，原字节保留', { timeout: 60_000 }, async () => fixture(async (root, tools) => {
  const sizes = ['1600x900', '800x800', '900x1600', '480x1800'];
  const originals = await Promise.all(sizes.map((size, index) => makeImage(root, tools, `input-${index}.png`, size)));
  const result = await prepareAiSalesVideoReferenceFrames(originals.map(bytes => `data:image/png;base64,${bytes.toString('base64')}`), root, tools, runner);
  assert.equal(result.images.length, sizes.length);
  for (const [index, info] of result.metadata.entries()) {
    assert.deepEqual([info.source.width, info.source.height], sizes[index].split('x').map(Number));
    assert.deepEqual([info.prepared.width, info.prepared.height], [720, 1280]);
    assert.equal(info.method, 'portrait_cover_center_crop');
    assert.equal(info.addedPadding, false);
    assert.equal(info.source.sha256, sha256(originals[index]));
    assert.deepEqual(await fsp.readFile(path.join(root, `reference-original-${index}.png`)), originals[index]);
    assert.equal(info.prepared.sha256, sha256(Buffer.from(result.images[index].split(',')[1], 'base64')));
    const sample = await pixels(root, tools, index, 720, 1280);
    for (const [x, y] of [[0, 0], [719, 0], [0, 1279], [719, 1279], [360, 640]]) near(sample(x, y), [38, 156, 96]);
  }
}));

test('真实FFmpeg：360多图模式所有参考图均维持横图构图，不强行裁切或补白', async () => fixture(async (root, tools) => {
  const bytes = await makeImage(root, tools, 'source.png', '1600x900');
  const image = `data:image/png;base64,${bytes.toString('base64')}`;
  const result = await prepareAiSalesVideoReferenceFrames([image, image], root, tools, runner, { sizingMode: 'preserve_aspect' });
  assert.deepEqual(result.metadata.map(info => [info.prepared.width, info.prepared.height]), [[1280, 720], [1280, 720]]);
  assert.ok(result.metadata.every(info => info.method === 'preserve_aspect_downscale' && info.role === 'reference_image'));
  const sample = await pixels(root, tools, 1, 1280, 720);
  near(sample(0, 0), [38, 156, 96]);
  near(sample(1279, 719), [38, 156, 96]);
}));

test('真实FFmpeg：透明像素按原几何合成中性灰，不替换成白色画布', async () => fixture(async (root, tools) => {
  const bytes = await makeImage(root, tools, 'transparent.png', '640x360', '0xff0000@0.5');
  const result = await prepareAiSalesVideoReferenceFrames([`data:image/png;base64,${bytes.toString('base64')}`], root, tools, runner);
  const sample = await pixels(root, tools, 0, 720, 1280);
  near(sample(0, 0), [151, 26, 30]);
  near(sample(719, 1279), [151, 26, 30]);
  assert.equal(result.metadata[0].alphaBackground, '#30343b');
}));

test('真实FFmpeg：1080P配置产出实际1080×1920首帧，保持无补边', async () => fixture(async (root, tools) => {
  const bytes = await makeImage(root, tools, 'landscape.png', '1600x900');
  const result = await prepareAiSalesVideoReferenceFrames([`data:image/png;base64,${bytes.toString('base64')}`], root, tools, runner, { targetResolution: '1080P' });
  assert.deepEqual([result.metadata[0].prepared.width, result.metadata[0].prepared.height], [1080, 1920]);
  assert.equal(result.metadata[0].targetResolution, '1080P');
  const sample = await pixels(root, tools, 0, 1080, 1920);
  near(sample(0, 0), [38, 156, 96]);
  near(sample(1079, 1919), [38, 156, 96]);
}));

test('真实FFmpeg：JPEG的EXIF旋转先应用再裁切，送出JPEG不保留二次旋转标签', async () => fixture(async (root, tools) => {
  const jpeg = await makeImage(root, tools, 'unrotated.jpg', '640x360', 'red', ['-vf', 'drawbox=x=320:y=0:w=320:h=360:color=blue:t=fill']);
  // A minimal standard EXIF APP1 segment: little-endian TIFF orientation = 6
  // means the encoded landscape pixels are displayed rotated 90° clockwise.
  const exif = Buffer.from('45786966000049492a0008000000010012010300010000000600000000000000', 'hex');
  const segment = Buffer.alloc(4); segment[0] = 0xff; segment[1] = 0xe1; segment.writeUInt16BE(exif.length + 2, 2);
  const oriented = Buffer.concat([jpeg.subarray(0, 2), segment, exif, jpeg.subarray(2)]);
  const result = await prepareAiSalesVideoReferenceFrames([`data:image/jpeg;base64,${oriented.toString('base64')}`], root, tools, runner);
  assert.deepEqual([result.metadata[0].source.width, result.metadata[0].source.height], [640, 360]);
  const sample = await pixels(root, tools, 0, 720, 1280);
  near(sample(360, 200), [255, 0, 0]);
  near(sample(360, 1080), [0, 0, 255]);
  const probe = JSON.parse((await runner(tools.ffprobePath, ['-v', 'error', '-show_streams', '-of', 'json', path.join(root, 'reference-prepared-0.jpg')])).stdout);
  assert.ok(!probe.streams[0].side_data_list?.some(item => item.rotation));
}));

test('参考帧继续拒绝外部地址、不支持格式、超限文件和超限尺寸', async () => fixture(async (root, tools) => {
  for (const image of ['https://example.com/frame.png', 'data:image/svg+xml;base64,PHN2Zz4=', `data:image/png;base64,${Buffer.alloc(15 * 1024 * 1024 + 1).toString('base64')}`]) {
    await assert.rejects(prepareAiSalesVideoReferenceFrames([image], root, tools, runner), { code: 'AI_SALES_VIDEO_FRAME_INVALID', status: 400 });
  }
  const image = await makeImage(root, tools, 'too-small.png', '238x400');
  await assert.rejects(prepareAiSalesVideoReferenceFrames([`data:image/png;base64,${image.toString('base64')}`], root, tools, runner), { code: 'AI_SALES_VIDEO_FRAME_INVALID', status: 400 });
}));

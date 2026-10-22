import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const invalidFrame = message => Object.assign(new Error(message), {
  code: 'AI_SALES_VIDEO_FRAME_INVALID', status: 400,
});
const NEUTRAL_ALPHA_BACKGROUND = '0x30343b';

/** Prepare copies only. The uploaded originals remain unchanged. The first
 * frame must fill the intended portrait video, without asking the model to
 * animate artificial letterboxing. Wan 3 multiple-image mode has no fixed
 * first frame, so every reference retains its original composition. */
export async function prepareAiSalesVideoReferenceFrames(images, workDir, binaries, runner, {
  sizingMode = 'portrait_first_frame', targetResolution = '720P',
} = {}) {
  if (!['portrait_first_frame', 'preserve_aspect'].includes(sizingMode)
    || !['720P', '1080P'].includes(targetResolution)) throw invalidFrame('视频参考帧处理模式无效');
  const [targetWidth, targetHeight] = targetResolution === '1080P' ? [1080, 1920] : [720, 1280];
  const prepared = [], metadata = [];
  for (const [index, image] of images.entries()) {
    const match = String(image).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u);
    if (!match) throw invalidFrame('有声首帧只支持PNG/JPEG/WebP本地图片');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 15 * 1024 * 1024) throw invalidFrame('首帧大小不符合要求');
    const input = path.join(workDir, `reference-original-${index}.${match[1]}`);
    const output = path.join(workDir, `reference-prepared-${index}.jpg`);
    await fsp.writeFile(input, bytes, { flag: 'wx', mode: 0o600 });
    const probe = async file => JSON.parse((await runner(binaries.ffprobePath, [
      '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-of', 'json', file,
    ], { cwd: workDir })).stdout).streams?.find(stream => stream.codec_type === 'video');
    const source = await probe(input);
    if (!source || ![source.width, source.height].every(value =>
      Number.isInteger(value) && value >= 240 && value <= 8000))
      throw invalidFrame('首帧宽高须在240–8000像素');

    const preserveAspect = sizingMode === 'preserve_aspect';
    const geometry = preserveAspect
      ? `scale=w='min(${targetHeight},iw)':h='min(${targetHeight},ih)':force_original_aspect_ratio=decrease,setsar=1`
      : `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},setsar=1`;
    // JPEG cannot carry alpha. Composite actual transparent pixels onto a
    // neutral background with the same geometry; this introduces no padding.
    // ffmpeg's default autorotate applies EXIF/display-matrix orientation before
    // these filters. Dropping metadata afterwards avoids a second rotation.
    const filter = `[0:v]format=rgba,${geometry},split[foreground][canvas];`
      + `[canvas]drawbox=c=${NEUTRAL_ALPHA_BACKGROUND}:t=fill:replace=1[background];`
      + '[background][foreground]overlay=shortest=1:format=auto,format=rgb24[frame]';
    await runner(binaries.ffmpegPath, [
      '-hide_banner', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-i', input, '-filter_complex', filter, '-map', '[frame]', '-map_metadata', '-1',
      '-frames:v', '1', '-q:v', '2', output,
    ], { cwd: workDir });
    const encoded = await fsp.readFile(output), actual = await probe(output);
    if (!encoded.length || encoded.length > 15 * 1024 * 1024 || !actual
      || actual.codec_name !== 'mjpeg'
      || ![actual.width, actual.height].every(value => Number.isInteger(value) && value > 0 && value <= targetHeight)
      || (!preserveAspect && (actual.width !== targetWidth || actual.height !== targetHeight)))
      throw invalidFrame('视频参考帧尺寸或编码未通过核验');
    prepared.push(`data:image/jpeg;base64,${encoded.toString('base64')}`);
    const rotation = source.side_data_list?.find(item => Number.isFinite(item.rotation))?.rotation;
    metadata.push({
      index: index + 1, role: preserveAspect ? 'reference_image' : 'first_frame', targetResolution,
      source: { width: source.width, height: source.height, mimeType: `image/${match[1]}`,
        bytes: bytes.length, sha256: hash(bytes), rotationDegrees: Number.isFinite(rotation) ? rotation : 0 },
      prepared: { width: actual.width, height: actual.height, mimeType: 'image/jpeg',
        bytes: encoded.length, sha256: hash(encoded) },
      method: preserveAspect ? 'preserve_aspect_downscale' : 'portrait_cover_center_crop',
      orientation: 'ffmpeg_autorotate', alphaBackground: '#30343b', addedPadding: false,
    });
  }
  return { images: prepared, metadata };
}

const DATA_IMAGE_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export const MAX_REFERENCE_IMAGES = 6;
export const MAX_REFERENCE_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_REFERENCE_TOTAL_BYTES = 18 * 1024 * 1024;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function parseReferenceImage(value, index = 0) {
  if (typeof value !== 'string') throw invalid(`第${index + 1}张参考图格式不正确`);
  const match = value.match(DATA_IMAGE_RE);
  if (!match) throw invalid(`第${index + 1}张参考图仅支持 PNG、JPG 或 WebP`);
  const bytes = Buffer.byteLength(match[2], 'base64');
  if (!bytes) throw invalid(`第${index + 1}张参考图内容为空`);
  if (bytes > MAX_REFERENCE_IMAGE_BYTES) throw invalid(`第${index + 1}张参考图超过4MB`);
  return { dataUrl: value, mime: match[1], b64: match[2], bytes };
}

export function normalizeReferenceImages(input = {}) {
  const source = input.images === undefined
    ? (input.image ? [input.image] : [])
    : input.images;
  if (!Array.isArray(source)) throw invalid('参考图列表格式不正确');
  if (source.length > MAX_REFERENCE_IMAGES) throw invalid(`一次最多上传${MAX_REFERENCE_IMAGES}张参考图`);
  const images = source.map(parseReferenceImage);
  const totalBytes = images.reduce((sum, image) => sum + image.bytes, 0);
  if (totalBytes > MAX_REFERENCE_TOTAL_BYTES) throw invalid('参考图合计不能超过18MB');
  return images;
}

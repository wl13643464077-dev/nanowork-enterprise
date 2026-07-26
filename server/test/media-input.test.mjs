import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_REFERENCE_IMAGES,
  normalizeReferenceImages,
} from '../src/engines/media-input.js';

const png = bytes => `data:image/png;base64,${Buffer.alloc(bytes, 1).toString('base64')}`;

test('媒体参考图兼容单图旧契约并支持多图', () => {
  const legacy = normalizeReferenceImages({ image: png(4) });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].mime, 'image/png');

  const multiple = normalizeReferenceImages({ images: [png(3), png(5)] });
  assert.deepEqual(multiple.map(item => item.bytes), [3, 5]);
});

test('媒体参考图拒绝数量、格式和大小越界', () => {
  assert.throws(
    () => normalizeReferenceImages({ images: Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, () => png(1)) }),
    /最多上传6张/,
  );
  assert.throws(() => normalizeReferenceImages({ images: ['data:image/gif;base64,AAAA'] }), /仅支持 PNG、JPG 或 WebP/);
  assert.throws(() => normalizeReferenceImages({ images: [png(4 * 1024 * 1024 + 1)] }), /超过4MB/);
});

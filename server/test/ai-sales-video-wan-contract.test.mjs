import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NODE_ENV = 'test';
process.env.NANOWORK_DB = ':memory:';
process.env.YUNWU_API_KEY = '';
const { buildAliBailianVideoRequestBody } = await import('../src/engines/yunwu.js');
const base = { model: 'wan2.6-i2v', prompt: '菜品特写', images: ['https://images.example/frame.jpg'], audioUrl: 'https://audio.example/voice.mp3', duration: 15 };

test('Wan2.6原生有声只传audio_url，不发送flash专属audio开关', () => {
  const body = buildAliBailianVideoRequestBody({ ...base, promptExtend: false });
  assert.equal(body.input.audio_url, base.audioUrl);
  assert.deepEqual(body.parameters, { duration: 15, resolution: '720P', prompt_extend: false });
});
test('Wan时长不能静默截断/四舍五入，2.5仅允许5或10秒', () => {
  for (const duration of [1, 16, 9.5, NaN, 'not-duration']) assert.throws(() => buildAliBailianVideoRequestBody({ ...base, duration }), /时长/u);
  for (const duration of [6, 7, 15]) assert.throws(() => buildAliBailianVideoRequestBody({ ...base, model: 'wan2.5-i2v-preview', duration }), /时长/u);
  for (const duration of [5, 10]) assert.equal(buildAliBailianVideoRequestBody({ ...base, model: 'wan2.5-i2v-preview', duration }).parameters.duration, duration);
});
test('Wan无效分辨率、超长提示、私网音轨调用前拦截', () => {
  assert.throws(() => buildAliBailianVideoRequestBody({ ...base, resolution: '768P' }), /分辨率/u);
  assert.throws(() => buildAliBailianVideoRequestBody({ ...base, prompt: '字'.repeat(1501) }), /提示/u);
  assert.throws(() => buildAliBailianVideoRequestBody({ ...base, audioUrl: 'https://localhost/private.mp3' }), /公网/u);
});
test('无音轨通用Wan调用保持兼容，旧HappyHorse请求字段不变', () => {
  const wan = buildAliBailianVideoRequestBody({ ...base, duration: undefined, audioUrl: null });
  assert.equal(wan.parameters.duration, 10);
  assert.equal(wan.input.audio_url, undefined);
  const horse = buildAliBailianVideoRequestBody({ prompt: '画面', model: 'happyhorse-1.0-t2v:floor', images: base.images });
  assert.equal(horse.model, 'happyhorse-1.0-t2v');
  assert.equal(horse.parameters.duration, 6);
  assert.equal(horse.input.img_url, base.images[0]);
});

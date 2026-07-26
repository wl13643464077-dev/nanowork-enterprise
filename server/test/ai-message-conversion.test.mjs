import { test } from 'node:test';
import assert from 'node:assert/strict';

const { toAnthropicMessages } = await import('../src/engines/ai.js');

test('OpenAI 图像消息可转换为 Anthropic base64 图像块', () => {
  const converted = toAnthropicMessages([{ role: 'user', content: [
    { type: 'text', text: '请识别图片' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
  ] }]);
  assert.deepEqual(converted, [{ role: 'user', content: [
    { type: 'text', text: '请识别图片' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
  ] }]);
});

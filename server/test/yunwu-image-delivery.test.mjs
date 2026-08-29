import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { generateImage } from '../src/engines/yunwu.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('generateImage把逐图幂等键发给云雾并保留真实图片token用量', async () => {
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2UtYnl0ZXM=', mime_type: 'image/png' }],
      usage: { input_tokens: 17, output_tokens: 29, total_tokens: 46 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await generateImage({
    prompt: '太原餐饮首图',
    size: '1024x1536',
    model: 'gpt-image-2',
    idempotencyKey: 'content-pipeline:1:station:5:image:1',
  });

  assert.match(captured.url, /\/images\/generations$/u);
  assert.equal(
    new Headers(captured.options.headers).get('idempotency-key'),
    'content-pipeline:1:station:5:image:1',
  );
  assert.deepEqual(JSON.parse(captured.options.body), {
    model: 'gpt-image-2',
    prompt: '太原餐饮首图',
    n: 1,
    size: '1024x1536',
  });
  assert.equal(result.b64, 'aW1hZ2UtYnl0ZXM=');
  assert.equal(result.mimeType, 'image/png');
  assert.deepEqual(result.usage, {
    inputTokens: 17,
    outputTokens: 29,
    totalTokens: 46,
  });
});

test('generateImage在网络请求前拒绝无法安全传递的幂等键', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('不应调用');
  };
  await assert.rejects(
    () => generateImage({
      prompt: '图片',
      model: 'gpt-image-2',
      idempotencyKey: 'bad key\nInjected: true',
    }),
    /幂等键格式无效/u,
  );
  assert.equal(called, false);
});

test('generateImage遇到限流会退避重试并在后续成功时交付图片', async () => {
  process.env.NANOWORK_IMAGE_RATE_LIMIT_RETRY_MS = '1';
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        error: { message: 'Rate limit exceeded' },
      }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      data: [{ b64_json: 'cmV0cnktb2s=', mime_type: 'image/png' }],
      usage: { input_tokens: 9, output_tokens: 11, total_tokens: 20 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await generateImage({
    prompt: '晚市两人套餐配图',
    model: 'gpt-image-2',
    idempotencyKey: 'content-pipeline:18:station:5:image:1',
  });

  assert.equal(calls, 2);
  assert.equal(result.b64, 'cmV0cnktb2s=');
  assert.deepEqual(result.usage, {
    inputTokens: 9,
    outputTokens: 11,
    totalTokens: 20,
  });
});

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createMiniMaxVideoTransport, MINIMAX_H3_MODEL } from '../src/engines/minimax-video.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('Hailuo 2.3-Fast submits a 10-second image-to-video task through Yunwu', async () => {
  let captured;
  const transport = createMiniMaxVideoTransport({
    baseUrl: 'https://yunwu.test/v1',
    apiKey: 'test-only-key',
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return new Response(JSON.stringify({ task_id: 'hailuo-task-1' }), { status: 200 });
    },
  });

  const output = await transport.submit({
    model: 'MiniMax-Hailuo-2.3-Fast',
    prompt: '人物展示门店新品',
    images: ['data:image/png;base64,YWJj'],
    duration: 10,
  });

  assert.equal(output.taskId, 'hailuo-task-1');
  assert.equal(output.ready, false);
  assert.equal(captured.url, 'https://yunwu.test/minimax/v1/video_generation');
  assert.deepEqual(JSON.parse(captured.options.body), {
    model: 'MiniMax-Hailuo-2.3-Fast',
    prompt: '人物展示门店新品',
    duration: 10,
    resolution: '768P',
    first_frame_image: 'data:image/png;base64,YWJj',
  });
});

test('missing credentials fail closed before transport fetch', async () => {
  let called = false;
  const transport = createMiniMaxVideoTransport({
    baseUrl: 'https://yunwu.test/v1',
    apiKey: '',
    fetchImpl: async () => {
      called = true;
      throw new Error('network must not be called');
    },
  });

  await assert.rejects(
    () => transport.submit({ model: 'MiniMax-Hailuo-2.3', prompt: '测试', duration: 10 }),
    error => error.code === 'PROVIDER_CREDENTIALS_MISSING' && error.status === 503,
  );
  assert.equal(called, false);
});

test('H3 requires an explicit capability gate and uses the official v2 shape when enabled', async () => {
  let called = false;
  const disabled = createMiniMaxVideoTransport({
    baseUrl: 'https://yunwu.test/v1',
    apiKey: 'test-only-key',
    fetchImpl: async () => {
      called = true;
      throw new Error('disabled H3 must not call');
    },
    h3Enabled: false,
  });
  await assert.rejects(
    () => disabled.submit({ model: MINIMAX_H3_MODEL, prompt: '测试', duration: 10 }),
    error => error.code === 'MINIMAX_H3_DISABLED' && error.status === 403,
  );
  assert.equal(called, false);

  let captured;
  const enabled = createMiniMaxVideoTransport({
    baseUrl: 'https://yunwu.test/v1',
    apiKey: 'test-only-key',
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return new Response(JSON.stringify({ task_id: 'h3-task-1' }), { status: 200 });
    },
    h3Enabled: true,
  });
  const result = await enabled.submit({
    model: MINIMAX_H3_MODEL,
    prompt: '参考人物、菜品与门店外观制作短片',
    images: ['https://provider.test/person.png', 'https://provider.test/dish.png'],
    duration: 10,
    resolution: '2K',
  });
  const body = JSON.parse(captured.options.body);
  assert.equal(result.taskId, 'h3-task-1');
  assert.equal(captured.url, 'https://yunwu.test/v2/video_generation');
  assert.equal(body.model, MINIMAX_H3_MODEL);
  assert.equal(body.duration, 10);
  assert.equal(body.resolution, '2K');
  assert.deepEqual(body.content.slice(1).map(item => item.role), ['first_frame', 'reference_image']);
});

test('Hailuo query retrieves a completed file URL and keeps task id stable', async () => {
  const calls = [];
  const transport = createMiniMaxVideoTransport({
    baseUrl: 'https://yunwu.test/v1',
    apiKey: 'test-only-key',
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/query/')) return new Response(JSON.stringify({ status: 'Success', file_id: 'file-1' }), { status: 200 });
      return new Response(JSON.stringify({ file: { download_url: 'https://cdn.test/video.mp4' } }), { status: 200 });
    },
  });
  const result = await transport.query({ taskId: 'hailuo-task-1', model: 'MiniMax-Hailuo-2.3' });
  assert.equal(result.ready, true);
  assert.equal(result.url, 'https://cdn.test/video.mp4');
  assert.equal(result.taskId, 'hailuo-task-1');
  assert.deepEqual(calls, [
    'https://yunwu.test/minimax/v1/query/video_generation?task_id=hailuo-task-1',
    'https://yunwu.test/minimax/v1/files/retrieve?file_id=file-1',
  ]);
});

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NODE_ENV = 'test';
process.env.NANOWORK_DB = ':memory:';
process.env.ENABLE_SCHEDULER = 'false';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';
process.env.YUNWU_API_KEY = 'synthetic-relay-key';
process.env.YUNWU_BASE_URL = 'https://relay.invalid/v1';
process.env.MINIMAX_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Real network is forbidden in relay contract tests'); };
after(() => { globalThis.fetch = realFetch; });
const { submitAliBailianVideoSegment, queryAliBailianVideoSegment } =
  await import('../src/engines/yunwu.js');
const input = {
  model: 'wan2.6-i2v', prompt: '合成测试图口播', images: ['https://images.invalid/frame.jpg'],
  audioUrl: 'https://audio.invalid/voice.mp3', duration: 15, resolution: '720P', promptExtend: false,
};
const response = (body, status = 200) => Response.json(body, { status });

// Yunwu public documents 359496147 and 359507346, checked 2026-09-04.
// Assert literals independently of exported constants: otherwise a wrong path passes both sides.
test('云雾Wan提交沿用专用入口且由网关处理异步头', async () => {
  const calls = [];
  const result = await submitAliBailianVideoSegment({ ...input, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response({ request_id: 'synthetic-request', output: { task_id: 'synthetic-task', task_status: 'PENDING' } });
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://relay.invalid/alibailian/api/v1/services/aigc/video-generation/video-synthesis');
  assert.equal(calls[0].options.method, 'POST');
  const headers = new Headers(calls[0].options.headers);
  assert.equal(headers.get('authorization'), 'Bearer synthetic-relay-key');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.has('x-dashscope-async'), false);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: input.model,
    input: { prompt: input.prompt, img_url: input.images[0], audio_url: input.audioUrl },
    parameters: { duration: 15, resolution: '720P', prompt_extend: false },
  });
  assert.equal(result.taskId, 'synthetic-task');
  assert.equal(result.ready, false);
});

test('云雾查询保留api/v1前缀并编码原任务号，无提交或成片下载', async () => {
  const calls = [];
  const taskId = 'synthetic/task ?#';
  const result = await queryAliBailianVideoSegment({ taskId, model: input.model, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response({ output: { task_id: taskId, task_status: 'SUCCEEDED', video_url: 'https://media.invalid/result.mp4' } });
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://relay.invalid/alibailian/api/v1/tasks/synthetic%2Ftask%20%3F%23');
  assert.equal(calls[0].options.method || 'GET', 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(new Headers(calls[0].options.headers).get('authorization'), 'Bearer synthetic-relay-key');
  assert.equal(result.taskId, taskId);
  assert.equal(result.ready, true);
  assert.equal(result.url, 'https://media.invalid/result.mp4');
});

test('查询拒绝时只报原错误，不切换旧路径或重新付费提交', async () => {
  for (const status of [401, 404, 500]) {
    const calls = [];
    await assert.rejects(queryAliBailianVideoSegment({ taskId: 'existing-task', model: input.model, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ error: { message: 'synthetic upstream error' } }, status);
    } }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://relay.invalid/alibailian/api/v1/tasks/existing-task');
    assert.equal(calls[0].options.method || 'GET', 'GET');
  }
});

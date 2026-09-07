import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NODE_ENV = 'test';
process.env.NANOWORK_DB = ':memory:';
// 供应商未配置 Key 时不会发出请求；本契约测试用假 Key 配合注入的 fetchImpl。
process.env.YUNWU_API_KEY = 'wan-contract-test-key';
const { initSchema, migrateV2 } = await import('../src/db.js');
initSchema();
migrateV2();
const { buildAliBailianVideoRequestBody, submitAliBailianVideoSegment } = await import('../src/engines/yunwu.js');
const { wanNativeAudioPrompt, AI_SALES_NATIVE_NARRATION_STYLE } = await import('../src/engines/ai-sales-video-script.js');
const base = {
  model: 'wan2.6-i2v',
  prompt: '菜品特写',
  images: ['https://images.example/frame.jpg'],
  audioUrl: 'https://audio.example/voice.mp3',
  duration: 15,
};

test('Wan单次提交默认等待6分钟，不在60秒自行放弃且不自动重复POST', async t => {
  const realTimeout = globalThis.setTimeout, delays = [];
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => {
    delays.push(delay); return realTimeout(fn, delay, ...args);
  });
  let calls = 0;
  const result = await submitAliBailianVideoSegment({ ...base, fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ output: { task_id: 'existing-wan-task', task_status: 'PENDING' } }));
  } });
  assert.equal(result.taskId, 'existing-wan-task');
  assert.deepEqual(delays, [360000]);
  assert.equal(calls, 1);
});

test('Wan收到200但响应体超时保留未知诊断，不能变空响应或重提', async () => {
  let calls = 0;
  await assert.rejects(submitAliBailianVideoSegment({ ...base, fetchImpl: async () => {
    calls++;
    return { status: 200, ok: true, headers: new Headers({ 'x-request-id': 'provider-trace-1' }),
      json: async () => { throw new DOMException('body aborted', 'AbortError'); } };
  } }), error => {
    assert.equal(error.responseStatus, 200);
    assert.equal(error.providerResponsePhase, 'response_body');
    assert.equal(error.providerRequestId, 'provider-trace-1');
    return true;
  });
  assert.equal(calls, 1);
});

test('Wan2.6历史外部配音只传audio_url，不发送flash专属audio开关', () => {
  const body = buildAliBailianVideoRequestBody({
    ...base,
    promptExtend: false,
  });
  assert.equal(body.input.audio_url, base.audioUrl);
  assert.deepEqual(body.parameters, {
    duration: 15,
    resolution: '720P',
    prompt_extend: false,
  });
});
test('Wan2.6原生中文独白不传audio_url，允许台词结束后环境音留白', () => {
  const voiceover = '今天想吃火锅吗？欢迎到店看看。';
  const prompt = wanNativeAudioPrompt({
    visual: '参考菜品自然近景',
    voiceover,
  });
  const body = buildAliBailianVideoRequestBody({
    ...base,
    audioUrl: undefined,
    prompt,
    promptExtend: false,
  });
  assert.equal(Object.hasOwn(body.input, 'audio_url'), false);
  assert.equal(Object.hasOwn(body.parameters, 'audio'), false);
  assert.match(body.input.prompt, /普通话中文独白/u);
  assert.ok(body.input.prompt.includes(voiceover));
  assert.match(body.input.prompt, /不为填满15秒重复或新增台词/u);
  assert.equal(body.parameters.duration, 15);
  assert.ok(body.input.prompt.includes(AI_SALES_NATIVE_NARRATION_STYLE));
  assert.match(body.input.prompt, /14秒前说完整句/u);
  assert.match(body.input.prompt, /不改造门头/u);
  assert.match(body.input.prompt, /像与朋友聊天/u);
  assert.match(body.input.prompt, /正常说话音高/u);
  assert.match(body.input.prompt, /轻微换气/u);
  assert.match(body.input.prompt, /无广告配乐、无混响/u);
  assert.doesNotMatch(body.input.prompt, /每秒3\.5|中低音区|0\.3秒后开始/u);
  const maximum = wanNativeAudioPrompt({ visual: '画'.repeat(400), voiceover: '词'.repeat(399) + '。' });
  assert.ok(maximum.includes('词'.repeat(399) + '。'), '有效上限内的台词不能被风格提示挤掉');
  assert.ok(maximum.length <= 1500);
  assert.match(maximum, /不为填满15秒重复或新增台词/u, '完整台词和结尾约束均不能被slice丢掉');
});
test('Wan时长不能静默截断/四舍五入，2.5仅允许5或10秒', () => {
  for (const duration of [1, 16, 9.5, NaN, 'not-duration'])
    assert.throws(() => buildAliBailianVideoRequestBody({ ...base, duration }), /时长/u);
  for (const duration of [6, 7, 15])
    assert.throws(
      () =>
        buildAliBailianVideoRequestBody({
          ...base,
          model: 'wan2.5-i2v-preview',
          duration,
        }),
      /时长/u,
    );
  for (const duration of [5, 10])
    assert.equal(
      buildAliBailianVideoRequestBody({
        ...base,
        model: 'wan2.5-i2v-preview',
        duration,
      }).parameters.duration,
      duration,
    );
});
test('Wan无效分辨率、超长提示、私网音轨调用前拦截', () => {
  assert.throws(() => buildAliBailianVideoRequestBody({ ...base, resolution: '768P' }), /分辨率/u);
  assert.throws(() => buildAliBailianVideoRequestBody({ ...base, prompt: '字'.repeat(1501) }), /提示/u);
  assert.throws(
    () =>
      buildAliBailianVideoRequestBody({
        ...base,
        audioUrl: 'https://localhost/private.mp3',
      }),
    /公网/u,
  );
});
test('无音轨通用Wan调用保持兼容，旧HappyHorse请求字段不变', () => {
  const wan = buildAliBailianVideoRequestBody({
    ...base,
    duration: undefined,
    audioUrl: null,
  });
  assert.equal(wan.parameters.duration, 10);
  assert.equal(wan.input.audio_url, undefined);
  const horse = buildAliBailianVideoRequestBody({
    prompt: '画面',
    model: 'happyhorse-1.0-t2v:floor',
    images: base.images,
  });
  assert.equal(horse.model, 'happyhorse-1.0-t2v');
  assert.equal(horse.parameters.duration, 6);
  assert.equal(horse.input.img_url, base.images[0]);
});

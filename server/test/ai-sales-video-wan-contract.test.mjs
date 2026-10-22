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
const { build360VideoBody } = await import('../src/engines/provider-360.js');
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
  assert.match(body.input.prompt, /普通话女声/u);
  assert.ok(body.input.prompt.includes(voiceover));
  assert.ok(body.input.prompt.includes(`「${voiceover}」`), '逐字台词仍作为独立引用传给上游');
  assert.match(body.input.prompt, /只说给定台词，说完保留轻微环境音/u);
  assert.equal(body.parameters.duration, 15);
  assert.ok(body.input.prompt.includes(AI_SALES_NATIVE_NARRATION_STYLE));
  assert.match(body.input.prompt, /不添加其他物体或画面文字/u);
  assert.match(body.input.prompt, /轻松邀请朋友吃饭/u);
  assert.match(body.input.prompt, /无背景音乐，无画面字幕/u);
  assert.match(body.input.prompt, /生成单镜头/u);
  assert.match(body.input.prompt, /使用画外音/u);
  assert.doesNotMatch(body.input.prompt, /不朗读|换气|正常说话音高|门头|招牌|宣传页|海报|混响|每秒3\.5|0\.3秒|14秒/u);
  assert.ok(body.input.prompt.length < 230, '简单画面不再携带冗长的制作说明');
  const maximum = wanNativeAudioPrompt({ visual: '画'.repeat(400), voiceover: '词'.repeat(399) + '。' });
  assert.ok(maximum.includes('词'.repeat(399) + '。'), '有效上限内的台词不能被风格提示挤掉');
  assert.ok(maximum.length <= 1500);
  assert.match(maximum, /只说给定台词/u, '完整台词和结尾约束均不能被slice丢掉');
});
test('360最终视频请求只含画面和台词指令，不把模型与供应商名带进画面', () => {
  const voiceover = '周末约朋友到小锅馆聚餐，欢迎到店看看。';
  const prompt = wanNativeAudioPrompt({ visual: '原图菜品缓慢推进，保留盘子与自然光线。', voiceover });
  const body = build360VideoBody({ model: 'alibaba/wan3.0-video', prompt, images: base.images, duration: 15 });
  assert.equal(body.model, 'alibaba/wan3.0-video');
  assert.equal(body.extra_body.input.prompt, prompt);
  assert.ok(body.extra_body.input.prompt.includes(voiceover));
  assert.doesNotMatch(body.extra_body.input.prompt, /wan|360|alibaba|智脑|供应商|模型|参考图确定.*品牌|保留标牌文字/iu);
  assert.match(body.extra_body.input.prompt, /不添加其他物体或画面文字/u);
  assert.equal(body.extra_body.input.prompt.split(voiceover).length, 2, '准确台词只传一次，不重复插入品牌');
  assert.equal(body.extra_body.parameters.audio, true);
  assert.equal(body.extra_body.parameters.watermark, false);
  assert.equal(body.extra_body.parameters.prompt_extend, false);
});
test('人物参考和30秒分段保留其说话方式，不改变已确认脚本', () => {
  const shot = { visual: '原图人物轻轻点头。', voiceover: '今天路过，来店里坐坐。', reference_hint: 'person' };
  const before = structuredClone(shot);
  const prompt = wanNativeAudioPrompt(shot, { durationSeconds: 30 });
  assert.match(prompt, /由参考人物说话/u);
  assert.match(prompt, /两段保持同一人声/u);
  assert.ok(prompt.includes(`「${shot.voiceover}」`));
  assert.deepEqual(shot, before);
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

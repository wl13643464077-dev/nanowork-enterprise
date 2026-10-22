import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build360ImageGenerationBody, build360ImageEditBody, build360VideoBody, normalize360VideoTask,
  resolve360Model, describe360ModelDirectory, build360ThinkingOptions, PROVIDER_360_VIDEO_MODEL } from '../src/engines/provider-360.js';
import { runWithProviderContext } from '../src/engines/tester-provider-context.js';

process.env.NANOWORK_DB = ':memory:';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NANOWORK_AI_PROVIDER = '360';
process.env.AI360_API_KEY = 'test-platform-360';
const { initSchema, migrateV2, setConfig } = await import('../src/db.js');
initSchema(); migrateV2();
const provider = await import('../src/engines/yunwu.js');
const provider360 = await import('../src/engines/provider-360.js');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('360短文字体验可关闭DeepSeek思考，为正文保留输出预算，其他模型不接收此参数', async () => {
  assert.deepEqual(build360ThinkingOptions('deepseek/deepseek-v4-flash', false), { thinking: { type: 'disabled' } });
  assert.deepEqual(build360ThinkingOptions('deepseek/deepseek-v4-pro', true), { thinking: { type: 'enabled' } });
  assert.deepEqual(build360ThinkingOptions('deepseek/deepseek-v4-pro'), {});
  assert.deepEqual(build360ThinkingOptions('qwen/qwen3.8-flash', false), {});
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.360.cn/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_tokens, 2400);
    assert.equal(Object.hasOwn(body, 'extra_body'), false);
    return json({ id: 'non-thinking-example', choices: [{ message: { content: '可交付正文' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8, amount: '0.0001' } });
  };
  const result = await provider.chat({ model: 'deepseek/deepseek-v4-flash', maxTokens: 2400, thinking: false,
    messages: [{ role: 'user', content: '写一句门店介绍' }] });
  assert.equal(result.text, '可交付正文');
});

test('360目录连接成功不能冒充Image2真实生图验证，空模型ID不能算已发现', () => {
  const checks = describe360ModelDirectory([
    { id: 'deepseek/deepseek-v4-flash', object: 'model' },
    { id: 'alibaba/wan3.0-video', object: 'model' },
    { id: '', object: '' },
  ]);
  assert.equal(checks.find(item => item.kind === 'text').listed, true);
  assert.equal(checks.find(item => item.kind === 'video').listed, true);
  assert.equal(checks.find(item => item.kind === 'image').listed, false);
  assert.ok(checks.every(item => !item.generationVerified));
  const listed = describe360ModelDirectory([{ id: 'openai/gpt-image-2' }]).find(item => item.kind === 'image');
  assert.equal(listed.listed, true);
  assert.equal(listed.generationVerified, false);
});

test('360目录缺少图片模型不能推断无权限，仍需按官方模型名真实生成验证', () => {
  const { describe360ImageAvailability, is360ImageModelId } = provider360;
  // 2026-09-07 真实目录节选：90个模型里有可用的万相3.0视频、视觉模型，但没有任何图片生成模型。
  const realDirectory = ['deepseek/deepseek-v4-flash-vision-exp', 'qwen/qwen3.8-flash', 'alibaba/wan3.0-video',
    'qwen/qwen3.8-max', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'z-ai/glm-4.6v', 'alibaba/qwen-vl-max']
    .map(id => ({ id, object: 'model' }));
  const none = describe360ImageAvailability(realDirectory);
  assert.equal(none.verdict, 'no_image_models');
  assert.deepEqual(none.imageModels, []);
  assert.equal(none.videoListed, true);
  assert.match(none.message, /目录中未列出图片模型/u);
  assert.match(none.message, /不能据此判断图片权限/u);
  assert.match(none.message, /openai\/gpt-image-2/u);
  assert.equal(is360ImageModelId('deepseek/deepseek-v4-flash-vision-exp'), false, '视觉理解模型不是图片生成模型');
  assert.equal(is360ImageModelId('alibaba/wan3.0-video'), false);
  for (const id of ['openai/gpt-image-2', 'google/gemini-3-pro-image-preview', 'alibaba/wan2.7-image', 'volcengine/doubao-seedream-5.0-lite'])
    assert.equal(is360ImageModelId(id), true, id);
  const others = describe360ImageAvailability([...realDirectory, { id: 'alibaba/wan2.7-image' }]);
  assert.equal(others.verdict, 'other_image_models_only');
  assert.deepEqual(others.imageModels, ['alibaba/wan2.7-image']);
  assert.match(others.message, /目录不代表完整权限/u);
  const listed = describe360ImageAvailability([...realDirectory, { id: 'openai/gpt-image-2' }]);
  assert.equal(listed.verdict, 'configured_listed');
  assert.match(listed.message, /仍以生成接口返回为准/u);
});

test('360模型迁移只接受对应能力，旧视频缺少原供应商Key时不请求，embedding不跨通道', async () => {
  setConfig('model_routing', { text: { boss: 'gpt-5.5' }, image: 'gpt-image-2', videoDefault: 'wan2.6-i2v' });
  assert.equal(provider.routing().text.boss, 'deepseek/deepseek-v4-pro');
  assert.equal(provider.routing().image, 'openai/gpt-image-2');
  assert.deepEqual(provider.routing().video, [PROVIDER_360_VIDEO_MODEL]);
  assert.throws(() => resolve360Model('text', 'gpt-image-2'), /尚未开放/u);
  assert.throws(() => resolve360Model('video', 'wan2.6-i2v'), /尚未开放/u);
  globalThis.fetch = () => { throw new Error('must not send'); };
  assert.equal(await provider.embed('门店会员'), null);
  await assert.rejects(provider.queryAliBailianVideoSegment({ taskId: 'old-id', model: 'wan2.6-i2v' }), /原供应商尚未配置/u);
});

test('360员工旧配置在预授权前迁移，故障备用模型也使用360真实模型ID', async () => {
  const { employeeTextModelFailoverPlan, resolveEmployeeExecutionModel } = await import('../src/engines/ai.js');
  assert.equal(resolveEmployeeExecutionModel({ workConfig: { textModel: 'claude-opus-4-8' }, role: 'boss' }), 'deepseek/deepseek-v4-pro');
  assert.equal(resolveEmployeeExecutionModel({ workConfig: { visionModel: 'gemini-3.1-flash-lite' }, image: 'image', role: 'sales' }), 'qwen/qwen3.8-flash');
  assert.equal(resolveEmployeeExecutionModel({ workConfig: { visionModel: 'gpt-5.5' }, image: 'image', role: 'boss' }), 'qwen/qwen3.8-max');
  assert.deepEqual(employeeTextModelFailoverPlan('deepseek-v4-flash'), {
    version: 1, requestedModel: 'deepseek/deepseek-v4-flash',
    models: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'], backupModel: 'deepseek/deepseek-v4-pro',
  });
  assert.equal(employeeTextModelFailoverPlan('gpt-5.5').backupModel, null);
});

test('360图片编辑使用JSON extra_body.images并拒绝私网引用', async () => {
  const image = 'data:image/png;base64,aW1hZ2U=';
  assert.deepEqual(build360ImageEditBody({ model: 'gpt-image-2', prompt: '餐厅封面', images: [image] }).extra_body, { images: [image] });
  assert.throws(() => build360ImageEditBody({ images: ['http://127.0.0.1/private'] }));
  const out = await provider.editImage({ prompt: '餐厅封面', images: [image], fetchFn: async (url, options) => {
    assert.equal(url, 'https://api.360.cn/v1/images/edits');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body).extra_body.images, [image]);
    return json({ id: 'edit-id', model: 'openai/gpt-image-2', data: [{ b64_json: 'cGljdHVyZQ==' }], usage: { amount: '0.4' } });
  } });
  assert.equal(out.b64, 'cGljdHVyZQ==');
  assert.equal(out.usage.supplierCosts[0].status, 'known');
});

test('360两份完整官方Image2实例都由统一builder发送，Markdown参考图和mask安全归一', async () => {
  const generation = { model: 'openai/gpt-image-2', prompt: 'A photograph of a red fox in an autumn forest',
    n: 1, size: '1024x1024', response_format: '', style: '', quality: 'medium' };
  const image = 'https://p0.qhimg.com/t11098f6bcd6edcb77e8375269a.png';
  const mask = 'https://p0.qhimg.com/t11098f6bcd97bb10c6dcc5c07d.png';
  const editing = { ...generation, prompt: 'A sunlit indoor lounge area with a pool containing a flamingo',
    extra_body: { images: [image], mask } };
  assert.deepEqual(build360ImageGenerationBody(generation), generation);
  assert.deepEqual(build360ImageEditBody({ ...editing, images: [`[${image}](${image})`], mask: `[${mask}](${mask})` }), editing);
  let calls = 0;
  const fetchFn = async (url, options) => {
    const edit = url.endsWith('/images/edits');
    assert.equal(url, 'https://api.360.cn/v1/images/' + (edit ? 'edits' : 'generations'));
    assert.deepEqual(JSON.parse(options.body), edit ? editing : generation);
    assert.equal(new Headers(options.headers).get('Content-Type'), 'application/json');
    calls++;
    return json({ id: `official-example-${calls}`, data: [{ b64_json: 'aW1hZ2U=' }], usage: { amount: '0.4' } });
  };
  await provider.generateImage({ ...generation, fetchFn });
  await provider.editImage({ ...editing, images: [`[参考图](${image})`], mask: `[蒙版](${mask})`, fetchFn });
  assert.equal(calls, 2);
  assert.equal(Object.hasOwn(build360ImageEditBody({ images: [image] }).extra_body, 'mask'), false);
  assert.throws(() => build360ImageEditBody({ images: [`[公网](http://127.0.0.1/private)`] }));
  assert.throws(() => build360ImageEditBody({ images: [image], mask: '[蒙版](http://169.254.169.254/latest/meta-data)' }));
  assert.throws(() => build360ImageEditBody({ images: ['[图片](javascript:alert(1))'] }));
});

test('360个人Key上下文并行隔离，原始usage.amount和双UUID回执保留', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.360.cn/v1/chat/completions');
    const owner = options.headers.Authorization;
    await new Promise(resolve => setTimeout(resolve, owner.endsWith('A') ? 20 : 1));
    return json({ id: `first-${owner.slice(-1)}|second-id`, model: 'tencent/deepseek/deepseek-v4-flash',
      choices: [{ message: { content: owner.slice(-1) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 107, completion_tokens: 149, amount: '0.001662' } });
  };
  const run = (id, key) => runWithProviderContext({ provider: '360', baseUrl: 'https://api.360.cn/v1', apiKey: key, ownerUserId: id },
    () => provider.chat({ role: 'sales', messages: [{ role: 'user', content: '写一句介绍' }] }));
  const [a, b] = await Promise.all([run(1, 'personal-A'), run(2, 'personal-B')]);
  assert.equal(a.text, 'A'); assert.equal(b.text, 'B');
  assert.equal(a.inputTokens, 107); assert.equal(a.outputTokens, 149);
  assert.equal(a.supplierCosts[0].status, 'known');
  assert.notEqual(a.supplierCosts[0].requestId, b.supplierCosts[0].requestId);
  assert.equal(provider.yunwuApiKey(), 'test-platform-360');
});

test('360视频仅提交一次且正确解析嵌套状态和带^^的任务号', async () => {
  let calls = 0;
  const taskId = '12345^^wan3.0-video^^0';
  const fetchImpl = async (url, options) => {
    calls++;
    if (options.method === 'POST') {
      assert.equal(url, 'https://api.360.cn/v1/videos/async_generations');
      const body = JSON.parse(options.body);
      assert.equal(body.model, PROVIDER_360_VIDEO_MODEL);
      assert.equal(body.duration, 30); assert.equal(body.extra_body.input.prompt, '餐馆菜品');
      assert.deepEqual(body.extra_body.parameters, { duration: 30, resolution: '720P', ratio: '9:16', audio: true, prompt_extend: false, watermark: false });
      assert.equal(Object.hasOwn(body.extra_body, 'duration'), false);
      return json({ data: { id: taskId, status: 'created', url: '' } });
    }
    assert.ok(url.endsWith(encodeURIComponent(taskId)));
    return json({ data: { id: taskId, status: 'success', url: 'https://cdn.example.com/video.mp4', duration: '30' } });
  };
  const submitted = await provider.submitAliBailianVideoSegment({ prompt: '餐馆菜品', model: PROVIDER_360_VIDEO_MODEL, duration: 30, fetchImpl });
  assert.equal(submitted.taskId, taskId); assert.equal(submitted.ready, false);
  const ready = await provider.queryAliBailianVideoSegment({ taskId, model: PROVIDER_360_VIDEO_MODEL, fetchImpl });
  assert.equal(ready.ready, true); assert.equal(ready.status, 'Success'); assert.equal(calls, 2);
  const failed = normalize360VideoTask({ data: { id: taskId, status: 'failed', url: 'https://cdn.example.com/stale.mp4' } }, PROVIDER_360_VIDEO_MODEL);
  assert.equal(failed.ready, false); assert.equal(failed.url, null);
  assert.throws(() => build360VideoBody({ duration: 31 }), /2–30/u);
  assert.throws(() => build360VideoBody({ audioUrl: 'https://cdn.example.com/voice.wav' }), /尚未核验/u);
});

test('Wan3.0按原厂input/parameters传时长分辨率，正确区分首帧与多参考并解析实测规格', () => {
  const first = 'https://images.example.com/first.png', second = 'https://images.example.com/second.png';
  const body = build360VideoBody({ prompt: '保持菜品与门头', duration: 15, resolution: '720P', images: [first] });
  assert.deepEqual(body.extra_body.input, { prompt: '保持菜品与门头', media: [{ type: 'first_frame', url: first }] });
  assert.equal(body.extra_body.parameters.ratio, 'adaptive', '首帧模式保留实际输入画幅');
  const references = build360VideoBody({ images: [first, first], duration: 15 });
  assert.equal(references.extra_body.parameters.ratio, '9:16');
  assert.deepEqual(references.extra_body.input.media.map(item => item.type), ['reference_image', 'reference_image']);
  assert.equal(body.extra_body.parameters.duration, 15);
  assert.equal(body.extra_body.parameters.resolution, '720P');
  assert.equal(Object.hasOwn(body, 'content'), false, '不要由通用content适配器重新覆盖原厂input');
  assert.deepEqual(build360VideoBody({ images: [first, second] }).extra_body.input.media,
    [{ type: 'reference_image', url: first }, { type: 'reference_image', url: second }]);
  const actual = normalize360VideoTask({ data: { id: 'wan30-result', status: 'SUCCEEDED', url: 'https://cdn.example.com/result.mp4',
    extra_data: JSON.stringify({ duration: 5, output_video_duration: 5, SR: 1080 }) } }, PROVIDER_360_VIDEO_MODEL);
  assert.equal(actual.actualDurationSeconds, 5);
  assert.equal(actual.actualResolution, '1080P');
  assert.equal(actual.ready, true, '保存真实片段，不能把请求规格冒充实际规格');
});

test('360模型参数错误不切换端点或重提付费视频', async () => {
  let calls = 0;
  await assert.rejects(provider.submit360VideoSegment({ prompt: '菜品', fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ error: { code: '1001', message: '模型不存在或未授权' } }), { status: 400 });
  } }));
  assert.equal(calls, 1);
});

test('360流式正文结束后仍读取实际amount回执，不用token估价替代', async () => {
  globalThis.fetch = async () => new Response([
    'data: ' + JSON.stringify({ id: 'stream-one|stream-two', model: 'tencent/deepseek/deepseek-v4-flash', choices: [{ delta: { content: '这道菜值得尝尝。' } }] }),
    'data: ' + JSON.stringify({ id: 'stream-one|stream-two', model: 'tencent/deepseek/deepseek-v4-flash', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 6, amount: '0.000063' } }),
    'data: [DONE]', '',
  ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } });
  const deltas = [];
  const out = await provider.chatStream({ role: 'sales', messages: [{ role: 'user', content: '菜品介绍' }], onDelta: value => deltas.push(value) });
  assert.equal(out.text, deltas.join(''));
  assert.equal(out.supplierCosts[0].status, 'known');
  assert.equal(out.supplierCosts[0].costYuanOverride, 0.000063);
  assert.equal(out.supplierCosts[0].costSource.rawRequestId, 'stream-one|stream-two');
});

test('360已扣费却没有正文时返回失败，同时保留销售Key实际成本证据', async () => {
  const response = { id: 'empty-output-receipt', model: 'deepseek/deepseek-v4-flash', choices: [{ message: { content: '' } }],
    usage: { prompt_tokens: 4, completion_tokens: 8, amount: '0.002' } };
  globalThis.fetch = async () => json(response);
  await assert.rejects(provider.chat({ role: 'sales', messages: [{ role: 'user', content: '菜品' }] }), error => {
    assert.equal(error.supplierCosts[0].costYuanOverride, 0.002);
    assert.equal(error.providerUsage.inputTokens, 4);
    return true;
  });
  globalThis.fetch = async () => new Response('data: ' + JSON.stringify({ ...response, choices: [{ delta: {} }] }) + '\n\ndata: [DONE]\n');
  await assert.rejects(provider.chatStream({ role: 'sales', messages: [{ role: 'user', content: '菜品' }] }), error => {
    assert.equal(error.supplierCosts[0].costYuanOverride, 0.002);
    assert.equal(error.providerUsage.outputTokens, 8);
    return true;
  });
});

test('360带货30秒整段只提交一次，原始回执乘二结算，重复run不会再次收费', async () => {
  const { q, runWithTenant } = await import('../src/db.js');
  const { createVoicedSalesVideoJob } = await import('../src/engines/ai-sales-video-native.js');
  const { read360Cost } = await import('../src/engines/provider-360-cost.js');
  const { countSpeechChars } = await import('../src/engines/ai-sales-video-script.js');
  q.run("UPDATE tenants SET credits=100000,status='已开通' WHERE id=1");
  const id = Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('360-boss','x','测试老板','boss',1)").lastInsertRowid);
  const actor = q.get('SELECT * FROM users WHERE id=?', id);
  const voices = ['今天吃什么？看看这道菜。', '喜欢这样的口味，欢迎到店咨询。'];
  const script = { hook_3s: '今天吃什么？', shots: voices.map((voiceover, i) => ({ index: i + 1, start: i * 15, end: (i + 1) * 15,
    visual: '菜品近景', voiceover, subtitle: voiceover, sfx: '无', reference_hint: 'dish' })),
  cta: '欢迎到店咨询。', facts_used: [], total_chars: countSpeechChars(voices.join('')), estimated_seconds: 30, risk_flags: [] };
  const receipt = (requestId, model, amount) => read360Cost({ response: { id: requestId, model, usage: { amount } }, model });
  let submissions = 0;
  const created = await runWithTenant(1, () => createVoicedSalesVideoJob({ durationSeconds: 30, actor,
    brief: '介绍菜品，邀请到店', references: [{ name: '菜品' }], providerImages: ['data:image/png;base64,YWJj'],
    grounding: { evidence: {}, storeFacts: { facts: [] }, promptContext: '' }, runtime: {
      mediaReady: async () => ({ ffmpegPath: 'test-ffmpeg', ffprobePath: 'test-ffprobe' }),
      prepareImages: async images => images,
      generateFn: async params => ({ mode: 'api', model: params.model, text: JSON.stringify(script),
        usage: { inputTokens: 1000, outputTokens: 500, supplierCosts: [receipt('native-text-360', params.model, '0.02')] } }),
      scanText: () => ({ hits: [] }),
      submitSegment: async params => {
        submissions++; assert.equal(params.duration, 30); assert.equal(params.model, PROVIDER_360_VIDEO_MODEL);
        assert.match(params.prompt, /本段30秒/u); assert.ok(voices.every(voice => params.prompt.includes(voice)));
        return { taskId: 'single30^^wan3.0-video^^0', url: 'https://cdn.example.com/30.mp4',
          supplierCosts: [receipt('native-video-360', params.model, '9')] };
      },
      downloadSegment: async () => ({ path: '/tmp/test-360-no-artifact.mp4' }),
      compose: async params => {
        assert.equal(params.segments.length, 1); assert.equal(params.targetDurationSeconds, 30);
        assert.ok(params.subtitleCues.some(cue => cue.start >= 15));
        return { url: '/uploads/ai-sales-video/1/test360.mp4', durationSeconds: 30, sha256: 'a'.repeat(64),
          audioSource: 'provider_native', subtitleTiming: 'script_estimated', audioVerified: true, subtitlesBurnedIn: true,
          audioVerification: [0, 15].map(startSeconds => ({ startSeconds, durationSeconds: 15, method: 'ffmpeg-volumedetect', peakDb: -20 })) };
      },
    } }));
  await created.run();
  const job = q.get('SELECT * FROM media_jobs WHERE id=?', created.response.jobId);
  const plan = JSON.parse(job.snapshot_json);
  assert.equal(job.status, '成功', plan.failureReason || job.error);
  assert.equal(plan.providerExecution.segments.length, 1);
  assert.equal(plan.priceQuote.video, 18); // 720P实测9元/15秒；结算仍以本次回执为准。
  assert.equal(plan.billing.chargedCredits, 1804);
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, 98196);
  await created.run(); assert.equal(submissions, 1);
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, 98196);
});

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Set isolation BEFORE any import that can transitively open the database.
Object.assign(process.env, {
  NANOWORK_DB: ':memory:',
  NANOWORK_TEST_TEMPLATE_AI: '1',
  NODE_ENV: 'test',
  ENABLE_SCHEDULER: 'false',
  ENABLE_BACKGROUND_EMBEDDINGS: 'false',
  YUNWU_API_KEY: '',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
});
const networkFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  assert.equal(new URL(url).hostname, '127.0.0.1', '测试禁止访问外站');
  return networkFetch(url, opts);
};
const { db, q, initSchema, migrateV2, runWithTenant, getConfig, setConfig } = await import('../src/db.js');
const { createVoicedSalesVideoJob, salesVideoPriceQuote, resolveSalesVoice, voicedSalesVideoOptions } =
  await import('../src/engines/ai-sales-video-native.js');
const { countSpeechChars } = await import('../src/engines/ai-sales-video-script.js');
const { voicedSalesDeliveryVerified } = await import('../src/engines/ai-sales-video-presentation.js');
const { billing, settleHold, holdCredits, releaseHold, getSupplierExpense } = await import('../src/engines/credits.js');
const cards = await import('../src/engines/content-benchmark-cards.js');
const {
  augmentMediaJob,
  projectMediaJob,
  validateMediaDelivery,
  default: mediaReviewRoutes,
} = await import('../src/routes/media-review.js');
const contentRoutes = (await import('../src/routes/content.js')).default;
const { assertAiSalesVoicedComposerReady, runAiSalesMediaCommand, composeAiSalesVideo } =
  await import('../src/engines/video-composer.js');
assert.equal(db.prepare('PRAGMA database_list').get().file, '');
initSchema();
migrateV2();
q.run("UPDATE tenants SET credits=1000000,status='已开通' WHERE id=1");
q.run("INSERT INTO tenants(id,name,status,credits) VALUES(2,'隔离企业二','已开通',1000000)");
for (const id of [1, 2])
  q.run(
    "INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES(?,'x',?,'boss',?)",
    `voiced-boss-${id}`,
    `测试老板${id}`,
    id,
  );
const actor = q.get("SELECT id,role,name,tenant_id FROM users WHERE username='voiced-boss-1'");
const other = runWithTenant(2, () => q.get("SELECT id,role,name,tenant_id FROM users WHERE username='voiced-boss-2'"));
const image = 'data:image/png;base64,YWJj';
const grounding = {
  evidence: { source: 'isolated-test' },
  storeFacts: { facts: [] },
  storeFactsPrompt: '',
  promptContext: '',
};
const snapshot = id =>
  JSON.parse(q.get('SELECT snapshot_json FROM media_jobs WHERE tenant_id=? AND id=?', 1, id).snapshot_json);
const job = id => q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', 1, id);
const held = id => q.get("SELECT * FROM credit_holds WHERE tenant_id=? AND ref_type='media_job' AND ref_id=?", 1, id);
function assertFailedRefund(id, before) {
  const hold = held(id), state = snapshot(id), expense = getSupplierExpense(hold.id, 1);
  assert.equal(hold.status, 'settled');
  assert.equal(hold.settled_credits, 0);
  assert.equal(state.billing.state, 'released');
  assert.equal(state.billing.chargedCredits, 0);
  assert.ok(expense.refundedAt, '退款必须有独立供应商费用台账证据');
  assert.equal(expense.refundedCredits, hold.held_credits);
  if (before !== undefined) assert.equal(balance(), before);
}
const balance = () => q.get('SELECT credits FROM tenants WHERE id=1').credits;
function script() {
  const a = '今天吃什么？' + '口味可以按自己的喜好来选。'.repeat(4);
  const b = '想知道菜品详情吗？' + '口味可以按自己的喜好来选。'.repeat(3) + '选好再下单。到店咨询详情。';
  return {
    hook_3s: '今天吃什么？',
    shots: [a, b].map((voiceover, i) => ({
      index: i + 1,
      start: i * 15,
      end: (i + 1) * 15,
      visual: '菜品近景',
      voiceover,
      subtitle: voiceover,
      sfx: '无',
      reference_hint: 'dish',
    })),
    cta: '到店咨询详情。',
    facts_used: [],
    total_chars: countSpeechChars(a + b),
    estimated_seconds: 30,
    risk_flags: [],
  };
}
function harness(overrides = {}) {
  const calls = [],
    inputs = [],
    dirs = [];
  const capture = kind => {
    const latest = q.get('SELECT id,snapshot_json FROM media_jobs WHERE tenant_id=? ORDER BY id DESC LIMIT 1', 1);
    const state = JSON.parse(latest.snapshot_json);
    assert.equal(state.paidExecution.at(-1)?.kind, kind);
    assert.equal(state.paidExecution.at(-1)?.status, 'started', '外部调用前必须落盘意图');
    assert.equal(held(latest.id).status, 'held');
    calls.push(kind);
  };
  const runtime = {
    kbSearch: async () => ({ text: '', refs: [], mode: 'test' }),
    scanText: () => ({ hits: [] }),
    mediaReady: async () => ({
      ffmpegPath: 'test-ffmpeg',
      ffprobePath: 'test-ffprobe',
    }),
    prepareImages: async (images, dir) => {
      dirs.push(dir);
      return images;
    },
    generateFn: async params => {
      capture('text');
      inputs.push(params);
      return {
        mode: 'api',
        model: params.model,
        usage: { inputTokens: 1000, outputTokens: 450 },
        text: JSON.stringify(script()),
      };
    },
    voiceClient: {
      synthesize: async () => {
        capture('tts');
        return { audioUrl: 'https://cdn.example.com/voice.mp3' };
      },
    },
    fetchImpl: async () =>
      new Response(Buffer.from('isolated-audio'), {
        headers: { 'Content-Type': 'audio/mpeg' },
      }),
    runner: async (command, args) => {
      if (command === 'test-ffprobe')
        return {
          stdout: JSON.stringify({
            format: { duration: 15 },
            streams: [{ codec_type: 'audio', duration: 15 }],
          }),
        };
      await fsp.writeFile(args.at(-1), Buffer.from('fitted-audio'));
      return { stdout: '', stderr: '' };
    },
    publishAsset: async () => 'https://assets.example.com/voiced-test.mp3',
    submitSegment: async params => {
      capture('video');
      assert.equal(params.duration, 15);
      assert.equal(params.audioUrl, undefined);
      assert.match(params.prompt, /普通话中文独白/u);
      assert.match(params.prompt, /请完整说出/u);
      assert.equal(params.promptExtend, false);
      assert.equal(params.model, 'wan2.6-i2v');
      return { taskId: `voiced-task-${calls.length}` };
    },
    querySegment: async () => ({
      status: 'success',
      url: 'https://cdn.example.com/video.mp4',
    }),
    downloadSegment: async ({ outputDir, index }) => {
      const filePath = path.join(outputDir, `clip-${index}.mp4`);
      await fsp.writeFile(filePath, 'video');
      return { path: filePath };
    },
    compose: async params => {
      assert.equal(params.requireAudio, true);
      assert.equal(params.voiceTracks, undefined);
      assert.equal(params.audioMode, 'provider_native');
      assert.equal(params.segments.length, 2);
      assert.ok(params.subtitleCues.length > 2);
      return {
        url: '/uploads/ai-sales-video/1/native-test.mp4',
        durationSeconds: 30,
        sha256: 'a'.repeat(64),
        audioVerified: true,
        audioSource: 'provider_native',
        subtitleTiming: 'script_estimated',
        subtitlesBurnedIn: true,
        audioVerification: [0, 15].map(startSeconds => ({
          startSeconds,
          durationSeconds: 15,
          peakDb: -20,
          method: 'ffmpeg-volumedetect',
        })),
      };
    },
    intervalMs: 1,
    timeoutMs: 100,
    ...overrides,
  };
  return { runtime, calls, inputs, dirs };
}
const create = runtime =>
  runWithTenant(1, () =>
    createVoicedSalesVideoJob({
      durationSeconds: 30,
      actor,
      brief: '介绍本店菜品，邀请顾客到店咨询',
      references: [{ name: '菜品图' }],
      providerImages: [image],
      grounding,
      runtime,
    }),
  );

test('新任务未填时长默认15秒，只提交一段原生视频，结算一段费用且重复执行无新扣款', async () => {
  const h = harness(), originalGenerate = h.runtime.generateFn, before = balance();
  h.runtime.generateFn = async params => {
    const response = await originalGenerate(params), value = JSON.parse(response.text);
    const voiceover = '今天吃什么？来店里坐坐。';
    value.shots = [{ ...value.shots[0], voiceover, subtitle: voiceover }];
    value.cta = '来店里坐坐。'; value.total_chars = countSpeechChars(voiceover); value.estimated_seconds = 15;
    assert.equal(params.responseSchema.schema.properties.shots.maxItems, 1);
    return { ...response, text: JSON.stringify(value) };
  };
  h.runtime.compose = async params => {
    assert.equal(params.segments.length, 1);
    assert.equal(params.targetDurationSeconds, 15);
    assert.equal(params.audioMode, 'provider_native');
    assert.equal(params.voiceTracks, undefined);
    assert.ok(params.subtitleCues.every(cue => cue.shotIndex === 1 && cue.end <= 15));
    return { url:'/uploads/ai-sales-video/1/native-15-test.mp4',durationSeconds:15,sha256:'a'.repeat(64),
      audioVerified:true,audioSource:'provider_native',subtitleTiming:'script_estimated',subtitlesBurnedIn:true,
      audioVerification:[{startSeconds:0,durationSeconds:15,peakDb:-20,method:'ffmpeg-volumedetect'}] };
  };
  const created = await runWithTenant(1, () => createVoicedSalesVideoJob({ actor, brief:'介绍本次菜品照片',
    references:[{name:'菜品图'}],providerImages:[image],grounding,runtime:h.runtime }));
  assert.equal(created.response.plan.durationSeconds, 15);
  assert.equal(created.response.plan.segmentCount, 1);
  await created.run();
  const state = snapshot(created.response.jobId), final = job(created.response.jobId);
  assert.equal(final.status, '成功', JSON.stringify(state));
  assert.deepEqual(h.calls, ['text', 'video']);
  assert.equal(state.priceQuote.segmentCount, 1);
  assert.equal(state.billing.state, 'settled');
  assert.equal(voicedSalesDeliveryVerified(state.result, 1, 'provider_native', 15), true);
  assert.equal(voicedSalesDeliveryVerified(state.result, 1, 'provider_native'), false, '历史省略时长始终按30秒验证');
  assert.equal(voicedSalesDeliveryVerified({ ...state.result, durationSeconds:30 }, 1, 'provider_native', 15), false);
  assert.equal(voicedSalesDeliveryVerified(state.result, 1, 'external_tts', 15), false, '新单段不得伪装旧TTS');
  const price = state.priceQuote;
  assert.equal(final.credits, Math.ceil((price.video + (1000 * price.text.in + 450 * price.text.out) / 1e6) * price.margin / price.creditYuan));
  assert.equal(before - balance(), final.credits);
  const currentBalance = balance();
  await created.run();
  assert.equal(balance(), currentBalance);
  assert.deepEqual(h.calls, ['text', 'video']);
  assert.equal(augmentMediaJob(final, actor).salesVideo.durationSeconds, 15);
  const inputs = { actor,brief:'介绍本次照片',references:[{name:'菜品图'}],providerImages:[image],grounding,runtime:h.runtime };
  await assert.rejects(runWithTenant(1, () => createVoicedSalesVideoJob({ ...inputs,durationSeconds:20 })), /15.*30/u);
  await assert.rejects(runWithTenant(1, () => createVoicedSalesVideoJob({ ...inputs,durationSeconds:30,quoteFingerprint:price.fingerprint })), /报价/u);
  assert.equal(balance(), currentBalance);
});
async function appFor(user, runtime) {
  const app = express();
  app.use(express.json());
  app.locals.aiSalesVideoRuntime = runtime;
  app.use((req, _res, next) =>
    runWithTenant(user.tenant_id, () => {
      req.user = user;
      next();
    }),
  );
  app.use('/api/content', mediaReviewRoutes, contentRoutes);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message, code: error.code }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}/api/content`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('第二段提交未知且无完整成片全退，已退款仍免费取回第一段，费用不变且不重提', async () => {
  const h = harness();
  const submit = h.runtime.submitSegment;
  let submissions = 0, queries = 0;
  h.runtime.submitSegment = async params => {
    submissions++;
    if (submissions === 2) throw Object.assign(new Error('submit timeout'), { code: 'PROVIDER_TIMEOUT', providerResponsePhase: 'request' });
    return submit(params);
  };
  h.runtime.querySegment = async () => { queries++; return { status: 'success', url: 'https://cdn.example.com/existing.mp4' }; };
  h.runtime.runner = async () => ({ stdout: JSON.stringify({ format: { duration: 15.125 },
    streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }) });
  h.runtime.compose = async () => { assert.fail('缺少第二段不能合成伪完整视频'); };
  const before = balance(), created = await create(h.runtime), id = created.response.jobId;
  await created.run();
  const state = snapshot(id), output = augmentMediaJob(job(id), actor);
  assert.equal(submissions, 2); assert.equal(queries, 1);
  assert.equal(job(id).status, '失败'); assert.equal(job(id).url, null);
  assertFailedRefund(id, before);
  assert.equal(state.paidExecution.filter(event => event.kind === 'video').length, 2);
  assert.equal(state.paidExecution.at(-1).status, 'started');
  assert.equal(state.billing.state, 'released');
  const partial = state.partialResults[0];
  assert.equal(partial.index, 1); assert.equal(partial.durationSeconds, 15.125);
  assert.equal(output.salesVideo.partialResults[0].url, partial.url);
  const file = path.resolve(import.meta.dirname, '../data', partial.url.replace(/^\//u, ''));
  assert.equal((await fsp.readFile(file)).toString(), 'video');
  const { recoverVoicedSalesVideoClips } = await import('../src/engines/ai-sales-video-voiced-recovery.js');
  const beforeHold = held(id), beforeBalance = balance();
  await runWithTenant(1, () => recoverVoicedSalesVideoClips({ actor, jobId: id, runtime: h.runtime }));
  assert.equal(queries, 1, '本地原片存在时不再查询或下载');
  assert.deepEqual(held(id), beforeHold); assert.equal(balance(), beforeBalance);
  await assert.rejects(runWithTenant(2, () => recoverVoicedSalesVideoClips({ actor: other, jobId: id, runtime: h.runtime })), /无权/u);
  await fsp.unlink(file);
  await runWithTenant(1, () => recoverVoicedSalesVideoClips({ actor, jobId: id, runtime: h.runtime }));
  assert.equal(queries, 2); assert.equal(submissions, 2);
  assert.deepEqual(held(id), beforeHold);
  await fsp.unlink(file);
});
async function finish(id) {
  for (let i = 0; i < 500; i++) {
    if (['失败', '成功'].includes(job(id)?.status)) return job(id);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('隔离任务未到终态');
}

test('实际HTTP有声任务：先预授权→独白→2段Wan原生声音→脚本估时字幕成片→按组合用量结算；禁止自动发布', async () => {
  const h = harness(),
    app = await appFor(actor, h.runtime),
    before = balance();
  const counts = ['contents', 'materials', 'biz_assets'].map(
    table => q.get(`SELECT count(*) n FROM ${table} WHERE tenant_id=?`, 1).n,
  );
  try {
    const res = await fetch(`${app.base}/ai-sales-video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        durationSeconds: 30,
        brief: '介绍本店菜品，邀请顾客到店咨询',
        mode: 'voiced',
        referenceImages: [image],
      }),
    });
    assert.equal(res.status, 202);
    const response = await res.json();
    assert.equal(response.status, 'processing', response.reason);
    assert.equal(response.pollUrl, `/content/media-jobs/${response.jobId}`, '前端api客户端统一添加/api前缀');
    assert.equal(response.plan.segmentCount, 2);
    assert.equal(response.plan.voiceMode, 'voiced');
    assert.equal(response.plan.employeeExecution, undefined);
    assert.equal(response.plan.priceQuote, undefined);
    assert.equal(response.salesVideo.stage, 'queued');
    assert.equal(response.salesVideo.script, null);
    const row = await finish(response.jobId),
      state = snapshot(row.id);
    assert.equal(row.status, '成功', JSON.stringify(state));
    assert.deepEqual(h.calls, ['text', 'video', 'video']);
    assert.equal(state.billing.state, 'settled');
    assert.equal(held(row.id).status, 'settled');
    assert.equal(before - balance(), row.credits);
    const price = state.priceQuote,
      expectedYuan = 2 * price.video + (1000 * price.text.in + 450 * price.text.out) / 1e6;
    assert.equal(row.credits, Math.ceil((expectedYuan * price.margin) / price.creditYuan));
    assert.equal(
      q.get('SELECT cost_yuan FROM credit_logs WHERE tenant_id=? AND id=?', 1, held(row.id).log_id).cost_yuan,
      Math.round(expectedYuan * 10000) / 10000,
    );
    assert.ok(held(row.id).held_credits > row.credits, '未使用的脚本修复授权退回');
    assert.ok(Number.isFinite(Date.parse(state.providerExecution.updatedAt)));
    assert.equal(state.result.audioVerified, true);
    assert.doesNotMatch(row.snapshot_json, /data:image|cdn\.example|assets\.example|nw-voiced-sales/u);
    assert.deepEqual(
      ['contents', 'materials', 'biz_assets'].map(
        table => q.get(`SELECT count(*) n FROM ${table} WHERE tenant_id=?`, 1).n,
      ),
      counts,
    );
    const polled = await fetch(`${app.base}/media-jobs/${row.id}`);
    assert.equal(polled.status, 200);
    const media = await polled.json();
    assert.equal(media.billing.state, 'settled');
    assert.equal(media.businessUsable, false, '未审批不得业务使用');
    assert.equal(media.salesVideo.audioVerified, true);
    assert.equal(media.salesVideo.stage, 'complete');
    assert.deepEqual(media.salesVideo.calls, { text: 1, tts: 0, video: 2 });
    const ordinary = projectMediaJob(row, { ...actor, role: 'employee' });
    assert.equal(ordinary.snapshot_json, undefined);
    assert.equal(ordinary.salesVideo.script.shots.length, 2);
    assert.doesNotMatch(
      JSON.stringify(ordinary),
      /employeeExecution|systemPrompt|priceQuote|provider_submitted.*taskId/u,
    );
    const tampered = {
      ...state,
      result: { ...state.result, audioVerification: [] },
    };
    const corrupted = { ...row, snapshot_json: JSON.stringify(tampered) };
    assert.equal(validateMediaDelivery(corrupted).ready, false);
    assert.equal(augmentMediaJob(corrupted, actor).canImport, false, '已结算也不能跳过有声交付证据');
  } finally {
    await app.close();
  }
  for (const dir of h.dirs) {
    // HTTP status can be observed before the worker's asynchronous finally.
    for (let i = 0; i < 400; i++) {
      if (
        !(await fsp.stat(dir).then(
          () => true,
          e => {
            if (e.code !== 'ENOENT') throw e;
            return false;
          },
        ))
      )
        break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await assert.rejects(fsp.stat(dir), { code: 'ENOENT' });
  }
});

test('M2确认卡/M5内容域有效心得从本企业DB进入idx10真实user消息，未确认/停用/其它企业和餐饮域均不进入', async () => {
  const card = {
    platform: '抖音',
    hook_type: '悬念',
    opening_3s: '开头结构独特标记',
    structure: ['需求', '展示', '邀请咨询'],
    emotion_trigger: '信任',
    selling_point_presentation: '现场展示',
    cta_type: '到店',
    duration_or_length: '30秒',
    reusable_pattern: '由真实需求过渡到行动',
    risk_flags: [],
  };
  const own = cards.insertBenchmarkCards({
    tenantId: 1,
    employeeRunId: 901,
    cards: [card],
  })[0];
  cards.markBenchmarkCardVerified(own.id, actor.id, { tenantId: 1 });
  cards.insertBenchmarkCards({
    tenantId: 1,
    employeeRunId: 902,
    cards: [{ ...card, opening_3s: '未确认卡禁止' }],
  });
  const foreign = runWithTenant(2, () =>
    cards.insertBenchmarkCards({
      tenantId: 2,
      employeeRunId: 903,
      cards: [{ ...card, opening_3s: '其它企业卡禁止' }],
    }),
  )[0];
  cards.markBenchmarkCardVerified(foreign.id, other.id, { tenantId: 2 });
  for (const [tenant, domain, status, note] of [
    [1, 'content', 'active', '人工采纳心得独特标记'],
    [1, 'content', 'retired', '停用心得禁止'],
    [1, 'restaurant', 'active', '餐饮域心得禁止'],
    [2, 'content', 'active', '其它企业心得禁止'],
  ]) {
    runWithTenant(tenant, () =>
      q.run(
        'INSERT INTO employee_evolution_notes(tenant_id,domain,specialist_id,note,rationale,status) VALUES(?,?,10,?,?,?)',
        tenant,
        domain,
        note,
        '复盘证据',
        status,
      ),
    );
  }
  const h = harness(),
    created = await create(h.runtime);
  await created.run();
  assert.equal(job(created.response.jobId).status, '成功');
  assert.match(h.inputs[0].userMsg, /开头结构独特标记/u);
  assert.match(h.inputs[0].userMsg, /人工采纳心得独特标记/u);
  assert.doesNotMatch(h.inputs[0].userMsg, /未确认卡禁止|其它企业卡禁止|停用心得禁止|餐饮域心得禁止|其它企业心得禁止/u);
  assert.doesNotMatch(h.inputs[0].system, /独特标记/u);
  assert.deepEqual(snapshot(created.response.jobId).learning.benchmarkCardIds, [own.id]);
  assert.equal(snapshot(created.response.jobId).learning.evolutionNoteIds.length, 1);
  const prior = h.calls.length,
    priorBalance = balance();
  await created.run();
  assert.equal(h.calls.length, prior);
  assert.equal(balance(), priorBalance);
});

test('未配置真实通道/媒体环境/合法首帧时调用数与占扣均为零', async () => {
  for (const overrides of [
    { generateFn: null, submitSegment: null },
    {
      mediaReady: async () => {
        throw new Error('missing-media');
      },
    },
    {
      prepareImages: async () => {
        throw new Error('invalid-image');
      },
    },
  ]) {
    const h = harness(overrides),
      before = balance(),
      created = await create(h.runtime);
    assert.equal(created.response.status, 'blocked');
    assert.equal(created.run, null);
    assert.deepEqual(h.calls, []);
    assert.equal(balance(), before);
    assert.equal(held(created.response.jobId), undefined);
    assert.equal(snapshot(created.response.jobId).billing.state, 'not_held');
  }
});

test('坏脚本只重试一次不提交视频；用量不明或视频失败无成片全退，不自动重付', async () => {
  for (const scenario of ['script', 'unknown-usage', 'video']) {
    const h = harness();
    if (scenario === 'script' || scenario === 'unknown-usage') {
      const original = h.runtime.generateFn;
      h.runtime.generateFn = async p => {
        const out = await original(p);
        return scenario === 'script' ? { ...out, text: '{}' } : { ...out, usage: {} };
      };
    } else
      h.runtime.submitSegment = async () => {
        h.calls.push('video-failed');
        throw new Error('provider-secret-do-not-leak');
      };
    const before = balance(),
      created = await create(h.runtime);
    await created.run();
    const id = created.response.jobId;
    assert.equal(job(id).status, '失败', scenario);
    assertFailedRefund(id, before);
    assert.doesNotMatch(job(id).snapshot_json + job(id).error, /provider-secret/u);
    const prior = h.calls.length;
    await created.run();
    assert.equal(h.calls.length, prior);
    if (scenario === 'script') assert.deepEqual(h.calls, ['text', 'text']);
    if (scenario === 'unknown-usage') assert.deepEqual(h.calls, ['text']);
  }
});

test('非法成片不成功且全退；已接受新报价调价仍按冻结价结算，旧无快照保持待核对', async () => {
  for (const invalid of [
    { durationSeconds: NaN },
    { audioVerified: false },
    { audioVerification: [] },
    { url: '/uploads/ai-sales-video/1/../2/leak.mp4' },
  ]) {
    const h = harness(),
      compose = h.runtime.compose;
    h.runtime.compose = async p => ({ ...(await compose(p)), ...invalid });
    const created = await create(h.runtime);
    await created.run();
    assert.equal(job(created.response.jobId).status, '失败');
    assertFailedRefund(created.response.jobId);
  }
  for (const legacy of [false, true]) {
    const originalBilling = getConfig('billing', {}),
      h = harness(),
      compose = h.runtime.compose;
    h.runtime.compose = async p => {
      const out = await compose(p);
      setConfig('billing', {
        ...originalBilling,
        video: {
          ...originalBilling.video,
          'wan2.6-i2v': billing().video['wan2.6-i2v'] + 1,
        },
      });
      return out;
    };
    try {
      const created = await create(h.runtime);
      if (legacy) q.run('UPDATE credit_holds SET pricing_snapshot_json=NULL WHERE id=?', held(created.response.jobId).id);
      await created.run();
      const row = job(created.response.jobId);
      assert.equal(row.status, '成功');
      if (legacy) {
        assert.equal(snapshot(row.id).billing.state, 'pending_reconciliation');
        assert.equal(held(row.id).status, 'held');
        assert.equal(augmentMediaJob(row, actor).businessUsable, false);
      } else {
        assert.equal(snapshot(row.id).billing.state, 'settled');
        assert.equal(held(row.id).status, 'settled');
        const price = snapshot(row.id).priceQuote;
        const expectedYuan = 2 * price.video + (1000 * price.text.in + 450 * price.text.out) / 1e6;
        assert.equal(row.credits, Math.ceil(expectedYuan * price.margin / price.creditYuan));
        assert.equal(getSupplierExpense(held(row.id).id, 1).refundedAt, null);
      }
    } finally {
      setConfig('billing', originalBilling);
    }
  }
});

test('有声失败任务不能通过旧恢复入口再扣费/走错供应商；跨企业GET与恢复均404', async () => {
  const h = harness({
    compose: async () => {
      throw new Error('composition-failed');
    },
  });
  const created = await create(h.runtime);
  await created.run();
  const id = created.response.jobId;
  assert.ok(snapshot(id).providerExecution.segments.every(s => s.taskId));
  const ownApp = await appFor(actor, h.runtime),
    foreignApp = await appFor(other, h.runtime),
    before = balance(),
    beforeCalls = h.calls.length;
  try {
    const denied = await fetch(`${ownApp.base}/media-jobs/${id}/recover-ai-sales-video`, { method: 'POST' });
    assert.equal(denied.status, 409, '整单退款后不能走完整恢复再结算；仍可独立免费取回原片段');
    assert.equal(snapshot(id).recovery, undefined);
    assert.equal((await fetch(`${foreignApp.base}/media-jobs/${id}`)).status, 404);
    assert.equal(
      (await fetch(`${foreignApp.base}/media-jobs/${id}/recover-ai-sales-video`, { method: 'POST' })).status,
      404,
    );
    assert.equal(h.calls.length, beforeCalls);
    assert.equal(balance(), before);
  } finally {
    await ownApp.close();
    await foreignApp.close();
  }
});

test('组合成本覆盖仅允许绑定有声任务、正确金额和预授权上限；异常事务完整回滚', () => {
  const id = Number(
    q.run(
      "INSERT INTO media_jobs(user_id,kind,model,status,snapshot_json) VALUES(?,'video','wan2.6-i2v','处理中',?)",
      actor.id,
      JSON.stringify({ voiceMode: 'voiced', workflow: 'ai_sales_video' }),
    ).lastInsertRowid,
  );
  const h = holdCredits({
    userId: actor.id,
    kind: 'video',
    model: 'wan2.6-i2v',
    credits: 100,
    refType: 'media_job',
    refId: id,
    feature: '组合成本测试',
  });
  const before = balance(),
    b = billing();
  for (const opts of [
    { credits: 20, costYuanOverride: NaN },
    { credits: 20, costYuanOverride: -1 },
    { credits: 20, costYuanOverride: '0.1' },
    { credits: 20, costYuanOverride: 0.2 },
    { credits: 20, costYuanOverride: 0.1, aiMode: 'template' },
  ]) {
    assert.throws(() => settleHold(h, opts), {
      code: 'BILLING_COMPOSITE_COST_INVALID',
    });
    assert.equal(balance(), before);
    assert.equal(held(id).status, 'held');
  }
  assert.throws(
    () =>
      settleHold(h, {
        credits: Math.ceil((2 * b.marginMultiplier) / b.creditYuan),
        costYuanOverride: 2,
      }),
    /预授权/u,
  );
  assert.equal(balance(), before);
  const out = settleHold(h, {
    credits: Math.ceil((0.1 * b.marginMultiplier) / b.creditYuan),
    costYuanOverride: 0.1,
  });
  assert.equal(out.credits, 20);
  assert.equal(balance(), before + 80);
  assert.equal(settleHold(h, { credits: 20, costYuanOverride: 0.1 }), null);
  const ordinary = holdCredits({
    userId: actor.id,
    kind: 'video',
    model: 'wan2.6-i2v',
    credits: 100,
    refType: 'not_media',
    refId: 99,
    feature: '普通媒体测试',
  });
  assert.throws(() => settleHold(ordinary, { credits: 20, costYuanOverride: 0.1 }), {
    code: 'BILLING_COMPOSITE_COST_INVALID',
  });
  releaseHold(ordinary);
});

test('音色ID、企业与价格预检不接受非法输入', async () => {
  assert.throws(() => resolveSalesVoice(actor, 'unowned-clone'), {
    code: 'AI_SALES_VIDEO_VOICE_NOT_FOUND',
  });
  assert.throws(() => resolveSalesVoice(actor, '../../voice'), {
    code: 'AI_SALES_VIDEO_VOICE_ID_INVALID',
  });
  assert.equal(resolveSalesVoice(actor, 'presenter_female'), 'presenter_female');
  assert.throws(() => salesVideoPriceQuote('no-exact-price'), /价格/u);
  await assert.rejects(
    runWithTenant(2, () =>
      createVoicedSalesVideoJob({
      durationSeconds: 30,
        actor,
        brief: '测试',
        voiceId: 'presenter_female',
        references: [],
        providerImages: [],
        grounding,
      }),
    ),
    { code: 'AI_SALES_VIDEO_TENANT_CONTEXT_INVALID' },
  );
  const fileId = Number(
    q.run(
      "INSERT INTO uploaded_files(user_id,name,stored_name,purpose) VALUES(?,'clone-test','clone-test.mp3','avatar-audio')",
      actor.id,
    ).lastInsertRowid,
  );
  for (const [tid, creator, voiceId, status] of [
    [1, actor.id, 'own-ready-voice', 'settled'],
    [1, actor.id, 'own-held-voice', 'held'],
    [2, other.id, 'foreign-ready-voice', 'settled'],
  ]) {
    runWithTenant(tid, () =>
      q.run(
        "INSERT INTO avatar_voices(tenant_id,created_by,source_file_id,label,provider_voice_id,status,billing_status) VALUES(?,?,?,'合成测试音色',?,'ready',?)",
        tid,
        creator,
        fileId,
        voiceId,
        status,
      ),
    );
  }
  assert.equal(resolveSalesVoice(actor, 'own-ready-voice'), 'own-ready-voice');
  assert.throws(() => resolveSalesVoice(actor, 'own-held-voice'), {
    code: 'AI_SALES_VIDEO_VOICE_NOT_FOUND',
  });
  assert.throws(() => resolveSalesVoice(actor, 'foreign-ready-voice'), {
    code: 'AI_SALES_VIDEO_VOICE_NOT_FOUND',
  });
});

test('音量证据必须分别覆盖两半且不是静音；非整数token用量不作结算依据', async () => {
  for (const invalid of [
    { audioVerification: [{}, {}] },
    {
      audioVerification: [0, 0].map(startSeconds => ({
        startSeconds,
        durationSeconds: 15,
        peakDb: -20,
        method: 'ffmpeg-volumedetect',
      })),
    },
    {
      audioVerification: [0, 15].map(startSeconds => ({
        startSeconds,
        durationSeconds: 15,
        peakDb: -90,
        method: 'ffmpeg-volumedetect',
      })),
    },
  ]) {
    const h = harness(),
      compose = h.runtime.compose;
    h.runtime.compose = async p => ({ ...(await compose(p)), ...invalid });
    const created = await create(h.runtime);
    await created.run();
    assert.equal(job(created.response.jobId).status, '失败');
    assertFailedRefund(created.response.jobId);
  }
  const h = harness(),
    generate = h.runtime.generateFn;
  h.runtime.generateFn = async p => ({
    ...(await generate(p)),
    usage: { inputTokens: 1.5, outputTokens: 1 },
  });
  const created = await create(h.runtime);
  await created.run();
  assert.equal(job(created.response.jobId).status, '失败');
  assertFailedRefund(created.response.jobId);
  assert.deepEqual(h.calls, ['text']);
});

test('预授权后启动状态写入失败：零供应商调用，账本与快照都显示已退回', async () => {
  db.exec(
    "CREATE TRIGGER fail_voiced_start BEFORE UPDATE OF status ON media_jobs WHEN OLD.status='阻塞' AND NEW.status='处理中' BEGIN SELECT RAISE(ABORT, 'isolated-start-write-failure'); END;",
  );
  try {
    const h = harness(),
      before = balance(),
      created = await create(h.runtime),
      id = created.response.jobId;
    assert.equal(created.response.status, 'blocked');
    assert.deepEqual(h.calls, []);
    assert.equal(held(id).status, 'settled');
    assert.equal(held(id).settled_credits, 0);
    assert.equal(snapshot(id).billing.state, 'released');
    assert.equal(balance(), before);
  } finally {
    db.exec('DROP TRIGGER fail_voiced_start');
  }
});

test('一次脚本修复仅计入2次文本和2段视频，未配置TTS或公网音轨仍成功且重复run不收费', async () => {
  const h = harness({ voiceClient: null, publishAsset: null }),
    generate = h.runtime.generateFn;
  let textCalls = 0;
  h.runtime.generateFn = async p => {
    const out = await generate(p);
    return ++textCalls === 1 ? { ...out, text: '{}' } : out;
  };
  const created = await create(h.runtime);
  await created.run();
  const id = created.response.jobId,
    state = snapshot(id);
  assert.equal(job(id).status, '成功', JSON.stringify(state));
  assert.deepEqual(h.calls, ['text', 'text', 'video', 'video']);
  assert.equal(state.voiceTracks, undefined);
  assert.equal(state.audioMode, 'provider_native');
  const price = state.priceQuote,
    yuan = 2 * price.video + (2000 * price.text.in + 900 * price.text.out) / 1e6;
  assert.equal(price.tts, 0);
  assert.equal(state.billing.chargedCredits, Math.ceil((yuan * price.margin) / price.creditYuan));
  const before = balance();
  await created.run();
  assert.equal(balance(), before);
  assert.equal(h.calls.length, 4);
});

test('结算数据库失败时不丢掉技术产物，也不通过人工验收入库门禁', async () => {
  db.exec(
    "CREATE TRIGGER fail_voiced_settle BEFORE UPDATE OF status ON credit_holds WHEN NEW.settled_credits>0 BEGIN SELECT RAISE(ABORT, 'isolated-billing-write-failure'); END;",
  );
  const h = harness();
  try {
    const created = await create(h.runtime);
    await created.run();
    const id = created.response.jobId,
      row = job(id),
      media = augmentMediaJob(row, actor);
    assert.equal(row.status, '成功');
    assert.ok(row.url);
    assert.equal(held(id).status, 'held');
    assert.equal(media.billing.state, 'pending_reconciliation');
    assert.equal(media.businessUsable, false);
    assert.equal(media.canImport, false);
    assert.equal(media.previewUrl, row.url, '原生成品可以预览核对，待对账仍不能采纳或入库');
    assert.equal(snapshot(id).billing.pendingReconciliation, true);
  } finally {
    db.exec('DROP TRIGGER fail_voiced_settle');
  }
});

test(
  '真实本机媒体工具贯穿原生任务：透明PNG预检转9:16JPEG→原音轨验证→脚本估时字幕成片→组合账本',
  { timeout: 180_000 },
  async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nw-native-media-test-'));
    try {
      const tools = await assertAiSalesVoicedComposerReady();
      const run = args =>
        runAiSalesMediaCommand(tools.ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], {
          cwd: root,
        });
      const frame = path.join(root, 'reference.png'),
        audio = path.join(root, 'voice.mp3'),
        clip = path.join(root, 'clip.mp4');
      await run(['-f', 'lavfi', '-i', 'color=c=0x304050@0.5:s=240x400,format=rgba', '-frames:v', '1', frame]);
      await run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=32000', '-t', '14', '-c:a', 'libmp3lame', audio]);
      await run([
        '-f',
        'lavfi',
        '-i',
        'color=c=0x304050:s=270x480:r=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=220:sample_rate=48000',
        '-t',
        '15',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        '-pix_fmt',
        'yuv420p',
        clip,
      ]);
      const audioBytes = await fsp.readFile(audio),
        h = harness();
      delete h.runtime.prepareImages;
      h.runtime.mediaReady = () => Promise.resolve(tools);
      h.runtime.runner = runAiSalesMediaCommand;
      h.runtime.fetchImpl = async () => new Response(audioBytes, { headers: { 'content-type': 'audio/mpeg' } });
      const submit = h.runtime.submitSegment;
      let checkedFrames = 0;
      h.runtime.submitSegment = async params => {
        assert.match(params.images[0], /^data:image\/jpeg;base64,/u);
        const jpeg = path.join(root, `normalized-${++checkedFrames}.jpg`);
        await fsp.writeFile(jpeg, Buffer.from(params.images[0].split(',')[1], 'base64'));
        const probe = await runAiSalesMediaCommand(tools.ffprobePath, [
          '-v',
          'error',
          '-show_streams',
          '-of',
          'json',
          jpeg,
        ]);
        const actual = JSON.parse(probe.stdout).streams[0];
        assert.equal(actual.width, 720);
        assert.equal(actual.height, 1280);
        assert.equal(actual.codec_name, 'mjpeg');
        return submit(params);
      };
      h.runtime.downloadSegment = async ({ outputDir, index }) => {
        const destination = path.join(outputDir, `downloaded-${index}.mp4`);
        await fsp.copyFile(clip, destination);
        return { path: destination };
      };
      let rendered;
      h.runtime.compose = async params => {
        rendered = await composeAiSalesVideo({
          ...params,
          outputRoot: path.join(root, 'output'),
        });
        return rendered;
      };
      const referenceImage = `data:image/png;base64,${(await fsp.readFile(frame)).toString('base64')}`;
      const created = await runWithTenant(1, () =>
        createVoicedSalesVideoJob({
      durationSeconds: 30,
          actor,
          brief: '介绍本店菜品，邀请顾客到店咨询',
          references: [{ name: '合成测试图' }],
          providerImages: [referenceImage],
          grounding,
          runtime: h.runtime,
        }),
      );
      // No real AI: only local generated color blocks and tones exercise the media chain.
      await created.run();
      const row = job(created.response.jobId),
        state = snapshot(row.id);
      assert.equal(row.status, '成功', state.failureCode);
      assert.equal(state.billing.state, 'settled');
      assert.equal(checkedFrames, 2);
      assert.deepEqual(h.calls, ['text', 'video', 'video']);
      assert.equal(state.voiceTracks, undefined);
      assert.equal(state.result.audioSource, 'provider_native');
      assert.equal(state.result.subtitleTiming, 'script_estimated');
      assert.ok(state.result.audioVerification.every(check => check.peakDb > -60));
      assert.ok(state.result.subtitleCount > 2);
      assert.equal(rendered.width, 1080);
      assert.equal(rendered.height, 1920);
      assert.equal(rendered.audioCodec, 'aac');
      assert.ok((await fsp.stat(rendered.absolutePath)).size > 10000);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  },
);

test('配置选项只读且不泄漏凭据；过期报价在创建任务和占扣前拒绝', async () => {
  const h = harness(),
    app = await appFor(actor, h.runtime),
    before = balance();
  const jobs = q.get('SELECT count(*) n FROM media_jobs WHERE tenant_id=?', 1).n;
  try {
    const response = await fetch(`${app.base}/ai-sales-video/options`);
    assert.equal(response.status, 200);
    const options = await response.json();
    assert.equal(options.ready, true);
    assert.equal(options.canRecover, true);
    assert.match(options.quoteFingerprint, /^[a-f0-9]{64}$/u);
    assert.deepEqual(options.voices, []);
    assert.equal(options.audioMode, 'provider_native');
    assert.equal(options.subtitleTiming, 'script_estimated');
    assert.equal(options.durationSeconds, 15);
    assert.deepEqual(options.limits, { text: 2, tts: 0, video: 1 });
    assert.deepEqual(options.durationOptions.map(item => [item.durationSeconds, item.segmentCount, item.limits.video]), [[15, 1, 1], [30, 2, 2]]);
    assert.notEqual(options.durationOptions[0].quoteFingerprint, options.durationOptions[1].quoteFingerprint);
    assert.ok(options.durationOptions[0].estimatedMaxCredits < options.durationOptions[1].estimatedMaxCredits);
    assert.doesNotMatch(JSON.stringify(options), /apiKey|publicBaseUrl|file_path|created_by|taskId/u);
    assert.ok(options.estimatedMaxCredits > 0);
    const denied = await fetch(`${app.base}/ai-sales-video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        brief: '介绍本店菜品，邀请到店咨询',
        mode: 'voiced',
        referenceImages: [image],
        quoteFingerprint: 'stale',
      }),
    });
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).code, 'AI_SALES_VIDEO_QUOTE_CHANGED');
    assert.equal(q.get('SELECT count(*) n FROM media_jobs WHERE tenant_id=?', 1).n, jobs);
    assert.equal(balance(), before);
    assert.deepEqual(h.calls, []);
  } finally {
    await app.close();
  }
  const blockedApp = await appFor(actor, { mediaReady: h.runtime.mediaReady });
  try {
    const options = await (await fetch(`${blockedApp.base}/ai-sales-video/options`)).json();
    assert.equal(options.ready, false);
    assert.equal(options.canRecover, true);
    assert.equal(options.blockers.length, 1);
    assert.equal(balance(), before);
  } finally {
    await blockedApp.close();
  }
  const staff = { ...actor, role: 'employee' };
  const staffOptions = await runWithTenant(1, () => voicedSalesVideoOptions(staff, h.runtime));
  assert.equal(staffOptions.canRecover, false);
  const staffApp = await appFor(staff, h.runtime);
  try {
    assert.equal((await fetch(`${staffApp.base}/ai-sales-video/options`)).status, 403);
  } finally {
    await staffApp.close();
  }
});

test('异步媒体检查期间变价时不沿用旧报价占扣，也不调用供应商', async () => {
  const original = getConfig('billing', {}),
    h = harness(),
    before = balance();
  h.runtime.prepareImages = async images => {
    setConfig('billing', {
      ...original,
      video: {
        ...original.video,
        'wan2.6-i2v': billing().video['wan2.6-i2v'] + 1,
      },
    });
    return images;
  };
  try {
    const created = await create(h.runtime);
    assert.equal(created.response.status, 'blocked');
    assert.equal(held(created.response.jobId), undefined);
    assert.equal(balance(), before);
    assert.deepEqual(h.calls, []);
  } finally {
    setConfig('billing', original);
  }
});

function walletReceipt(requestId, amount) {
  return { status: 'known', requestId, costYuanOverride: amount,
    costSource: { type:'provider_receipt', provider:'openlux', requestId, currency:'USD', amount,
      exchangeRate:1, basis:'upstream_debit', quota:amount * 500000, quotaPerUnit:500000,
      exchangeRateSource:'https://api.openlux.ai/api/status', statusRetrievedAt:new Date().toISOString() } };
}

test('视频按每个真实回执汇总结算，超预占只补差额且快照显示真实金额', async () => {
  const old=getConfig('supplier_cost_openlux',null), oldBase=process.env.YUNWU_BASE_URL;
  try {
    process.env.YUNWU_BASE_URL='https://api.openlux.ai/v1';
    setConfig('supplier_cost_openlux',{enabled:true,basis:'upstream_debit'});
    const h=harness(), originalGenerate=h.runtime.generateFn, originalSubmit=h.runtime.submitSegment;
    h.runtime.generateFn=async params=>{const r=await originalGenerate(params);r.usage.supplierCosts=[walletReceipt('native-wallet-script',1)];return r;};
    h.runtime.submitSegment=async params=>{const r=await originalSubmit(params);return {...r,providerRequestId:`native-wallet-${r.taskId}`};};
    h.runtime.supplierRequestCost=async ({requestId})=>walletReceipt(requestId,100);
    const before=balance(),created=await create(h.runtime), id=created.response.jobId;
    await created.run();
    const state=snapshot(id);
    assert.equal(job(id).status,'成功');
    assert.equal(state.billing.state,'settled',JSON.stringify(state.billing));
    assert.equal(job(id).credits,40200);
    assert.equal(before-balance(),40200);
    assert.ok(job(id).credits>held(id).held_credits);
    assert.equal(state.billing.costYuan,201);
    assert.equal(state.billing.supplierCostStatus,'known');
    await created.run();assert.equal(before-balance(),40200);assert.deepEqual(h.calls,['text','video','video']);
  } finally {setConfig('supplier_cost_openlux',old);if(oldBase===undefined)delete process.env.YUNWU_BASE_URL;else process.env.YUNWU_BASE_URL=oldBase;}
});

test('组合视频缺一条回执不按剩余部分扣费，免费补查后复用成片结算', async () => {
  const old=getConfig('supplier_cost_openlux',null),oldBase=process.env.YUNWU_BASE_URL;
  try {
    process.env.YUNWU_BASE_URL='https://api.openlux.ai/v1';setConfig('supplier_cost_openlux',{enabled:true,basis:'upstream_debit'});
    const h=harness(), originalGenerate=h.runtime.generateFn, originalSubmit=h.runtime.submitSegment;
    h.runtime.generateFn=async params=>{const r=await originalGenerate(params);r.usage.supplierCosts=[walletReceipt('native-late-script',0.5)];return r;};
    h.runtime.submitSegment=async params=>{const r=await originalSubmit(params);return {...r,providerRequestId:`native-late-${r.taskId}`};};
    let receiptReady=false;
    h.runtime.supplierRequestCost=async ({requestId,model})=>requestId.endsWith('3')&&!receiptReady
      ? {status:'pending',requestId,model}:walletReceipt(requestId,1);
    const before=balance(),created=await create(h.runtime), id=created.response.jobId;await created.run();
    assert.equal(job(id).status,'成功');assert.equal(snapshot(id).billing.state,'pending_reconciliation');
    assert.equal(job(id).credits,null);assert.equal(held(id).status,'held');assert.equal(before-balance(),held(id).held_credits);
    receiptReady=true;
    const {createVoicedSalesVideoRecovery}=await import('../src/engines/ai-sales-video-voiced-recovery.js');
    const recovery=await runWithTenant(1,()=>createVoicedSalesVideoRecovery({actor,jobId:id,runtime:{...h.runtime,verifyExistingResult:async()=>true}}));
    await recovery.run();
    assert.equal(snapshot(id).billing.state,'settled');assert.equal(job(id).credits,500);
    assert.equal(before-balance(),500);assert.equal(snapshot(id).billing.costYuan,2.5);
    assert.deepEqual(h.calls,['text','video','video'],'补查不能重新收费生成');
  } finally {setConfig('supplier_cost_openlux',old);if(oldBase===undefined)delete process.env.YUNWU_BASE_URL;else process.env.YUNWU_BASE_URL=oldBase;}
});

after(() => {
  globalThis.fetch = networkFetch;
  db.close();
});

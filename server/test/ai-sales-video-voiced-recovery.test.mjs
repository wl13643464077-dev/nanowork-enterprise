import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { after, test as nodeTest } from 'node:test';
Object.assign(process.env, {
  NANOWORK_DB: ':memory:',
  NANOWORK_TEST_TEMPLATE_AI: '1',
  NODE_ENV: 'test',
  ENABLE_SCHEDULER: 'false',
  ENABLE_BACKGROUND_EMBEDDINGS: 'false',
  YUNWU_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
});
const { db, q, initSchema, migrateV2, runWithTenant, getConfig, setConfig } = await import('../src/db.js');
const { createVoicedSalesVideoJob, voicedSalesSettlement } = await import('../src/engines/ai-sales-video-native.js');
const { createVoicedSalesVideoRecovery } = await import('../src/engines/ai-sales-video-voiced-recovery.js');
const { createAiSalesVideoAssetPublisher, readAiSalesVideoVoiceAsset } =
  await import('../src/engines/ai-sales-video-provider-assets.js');
const { countSpeechChars } = await import('../src/engines/ai-sales-video-script.js');
const { releaseHold, billing } = await import('../src/engines/credits.js');
const { augmentMediaJob, default: mediaReviewRoutes } = await import('../src/routes/media-review.js');
const contentRoutes = (await import('../src/routes/content.js')).default;
assert.equal(db.prepare('PRAGMA database_list').get().file, '');
initSchema();
migrateV2();
const tenantId = crypto.randomInt(10000000, 99999999);
q.run("INSERT INTO tenants(id,name,status,credits) VALUES(?,'有声恢复测试','已开通',1000000)", tenantId);
const userId = Number(
  q.run(
    "INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES(?,'x','测试老板','boss',?)",
    `voiced-recovery-${tenantId}`,
    tenantId,
  ).lastInsertRowid,
);
const actor = { id: userId, tenant_id: tenantId, role: 'boss' };
const uploadRoot = path.resolve(import.meta.dirname, '../data/uploads/files'),
  tenantRoot = path.join(uploadRoot, String(tenantId));
await assert.rejects(fsp.stat(tenantRoot), { code: 'ENOENT' });
const test = (name, fn) => nodeTest(name, () => runWithTenant(tenantId, fn));
const row = id => q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', tenantId, id);
const snap = id => JSON.parse(row(id).snapshot_json);
const hold = id =>
  q.get("SELECT * FROM credit_holds WHERE tenant_id=? AND ref_type='media_job' AND ref_id=?", tenantId, id);
const balance = () => q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits;
function script() {
  const a = '今天吃什么？' + '口味可以按自己的喜好来选。'.repeat(4),
    b = '想知道菜品详情吗？' + '口味可以按自己的喜好来选。'.repeat(3) + '选好再下单。到店咨询详情。';
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
async function prepared({ failAt = 'query', beforeRun, mutateRuntime } = {}) {
  const counts = { text: 0, tts: 0, submit: 0, query: 0, recoverQuery: 0, compose: 0 },
    fixtureId = crypto.randomUUID();
  const render = async p => {
    counts.compose++;
    assert.equal(p.requireAudio, true);
    assert.equal(p.voiceTracks.length, 2);
    return {
      url: `/uploads/ai-sales-video/${tenantId}/fixture-${fixtureId}.mp4`,
      durationSeconds: 30,
      sha256: 'a'.repeat(64),
      audioVerified: true,
      subtitlesBurnedIn: true,
      audioVerification: [0, 15].map(startSeconds => ({
        startSeconds,
        durationSeconds: 15,
        peakDb: -20,
        method: 'ffmpeg-volumedetect',
      })),
    };
  };
  const runtime = {
    mediaReady: async () => ({ ffmpegPath: 'local-test-ffmpeg', ffprobePath: 'local-test-ffprobe' }),
    prepareImages: async images => images,
    scanText: () => ({ hits: [] }),
    generateFn: async p => {
      counts.text++;
      return {
        mode: 'api',
        model: p.model,
        usage: { inputTokens: 1000, outputTokens: 450 },
        text: JSON.stringify(script()),
      };
    },
    voiceClient: {
      synthesize: async () => {
        counts.tts++;
        return { audioUrl: 'https://synthetic.example.com/audio.mp3' };
      },
    },
    fetchImpl: async () => new Response(Buffer.from('fixture-audio'), { headers: { 'content-type': 'audio/mpeg' } }),
    runner: async (cmd, args) => {
      if (cmd === 'local-test-ffprobe')
        return {
          stdout: JSON.stringify({ format: { duration: 15 }, streams: [{ codec_type: 'audio', duration: 15 }] }),
        };
      if (args.includes('volumedetect')) return { stderr: 'max_volume: -20 dB' };
      await fsp.writeFile(args.at(-1), Buffer.from('fitted-audio'));
      return { stdout: '' };
    },
    publishAsset: createAiSalesVideoAssetPublisher({
      tenantId,
      userId,
      publicBaseUrl: 'https://assets.example.com',
      includeMetadata: true,
    }),
    submitSegment: async () => {
      counts.submit++;
      return { taskId: `synthetic-${fixtureId}-${counts.submit}` };
    },
    querySegment: async () => {
      counts.query++;
      if (failAt === 'query') throw new Error('synthetic-query-failure');
      return { status: 'success', url: 'https://synthetic.example.com/video.mp4' };
    },
    recoverQuery: async () => {
      counts.recoverQuery++;
      return { status: 'success', url: 'https://synthetic.example.com/video.mp4' };
    },
    downloadSegment: async ({ outputDir, index }) => {
      const file = path.join(outputDir, `clip-${index}.mp4`);
      await fsp.writeFile(file, 'synthetic-video');
      return { path: file };
    },
    compose: render,
    recoverCompose: render,
    intervalMs: 1,
    timeoutMs: 100,
  };
  if (mutateRuntime) mutateRuntime(runtime, counts);
  const created = await createVoicedSalesVideoJob({
    actor,
    brief: '介绍本店菜品，邀请到店咨询',
    references: [{ name: '合成图' }],
    providerImages: ['data:image/png;base64,YWJj'],
    grounding: { evidence: {}, storeFacts: { facts: [] }, storeFactsPrompt: '', promptContext: '' },
    runtime,
  });
  assert.equal(created.response.status, 'processing', created.response.reason);
  if (beforeRun) await beforeRun();
  await created.run();
  return { id: created.response.jobId, counts, runtime, created };
}

test('实际资产回执逐段持久化：第一段查询超时前，两段视频ID和原配音均可复用', async () => {
  const h = await prepared(),
    plan = snap(h.id);
  assert.equal(row(h.id).status, '失败');
  assert.equal(h.counts.submit, 2);
  assert.equal(h.counts.query, 1);
  assert.ok(plan.voiceTracks.every(track => Number.isSafeInteger(track.fileId)));
  for (const track of plan.voiceTracks)
    assert.deepEqual(await readAiSalesVideoVoiceAsset({ tenantId, userId, ...track }), Buffer.from('fitted-audio'));
  assert.equal(augmentMediaJob(row(h.id), actor).recovery.available, true);
  const before = balance(),
    originalHold = hold(h.id),
    calls = { ...h.counts };
  const recovery = await createVoicedSalesVideoRecovery({ actor, jobId: h.id, runtime: h.runtime });
  assert.equal(recovery.response.pollUrl, `/content/media-jobs/${h.id}`);
  await recovery.run();
  assert.equal(row(h.id).status, '成功', snap(h.id).failureCode);
  assert.equal(hold(h.id).id, originalHold.id);
  assert.equal(hold(h.id).status, 'settled');
  assert.equal(balance() - before, originalHold.held_credits - row(h.id).credits);
  assert.equal(h.counts.text, calls.text);
  assert.equal(h.counts.tts, calls.tts);
  assert.equal(h.counts.submit, calls.submit);
  assert.equal(h.counts.recoverQuery, 2);
  assert.equal(snap(h.id).recovery.providerSubmissions, 0);
  assert.doesNotMatch(row(h.id).snapshot_json, /https:\/\/assets|nw-voiced-recovery|file_path|publicUrl/u);
  const total = balance();
  await recovery.run();
  assert.equal(balance(), total);
  assert.equal(h.counts.recoverQuery, 2);
  await assert.rejects(createVoicedSalesVideoRecovery({ actor, jobId: h.id, runtime: h.runtime }), /已完整结算/u);
});

test('并发恢复只有一个认领，重复worker不会重新查询、合成或扣款', async () => {
  const h = await prepared();
  const outcomes = await Promise.allSettled(
    [1, 2].map(() => createVoicedSalesVideoRecovery({ actor, jobId: h.id, runtime: h.runtime })),
  );
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'AI_SALES_VIDEO_RECOVERY_STATE_CONFLICT');
  const winner = outcomes.find(item => item.status === 'fulfilled').value;
  await Promise.all([winner.run(), winner.run()]);
  assert.equal(row(h.id).status, '成功');
  assert.equal(h.counts.recoverQuery, 2);
  assert.equal(h.counts.compose, 1);
});

test('结算中断但原成片实物核验有效：仅补原账本，不拉取视频/配音，不新建hold', async () => {
  let h;
  try {
    h = await prepared({
      failAt: 'settle',
      beforeRun: () =>
        db.exec(
          "CREATE TRIGGER fail_recovery_billing BEFORE UPDATE OF status ON credit_holds WHEN NEW.settled_credits>0 BEGIN SELECT RAISE(ABORT,'synthetic-settle-failure'); END;",
        ),
    });
  } finally {
    db.exec('DROP TRIGGER fail_recovery_billing');
  }
  assert.equal(row(h.id).status, '成功');
  assert.equal(hold(h.id).status, 'held');
  h.runtime.verifyExistingResult = async () => true;
  h.runtime.readVoiceAsset = async () => {
    assert.fail('已有有效成片不应重读原音轨');
  };
  const before = { ...h.counts },
    original = hold(h.id).id;
  const recovery = await createVoicedSalesVideoRecovery({ actor, jobId: h.id, runtime: h.runtime });
  await recovery.run();
  assert.deepEqual(h.counts, before);
  assert.equal(hold(h.id).id, original);
  assert.equal(hold(h.id).status, 'settled');
  assert.equal(snap(h.id).recovery.reusedResult, true);
});

test('有成片标志但文件失效时不直接结算，而复用原任务恢复新成片', async () => {
  let h;
  try {
    h = await prepared({
      failAt: 'settle',
      beforeRun: () =>
        db.exec(
          "CREATE TRIGGER fail_recovery_file BEFORE UPDATE OF status ON credit_holds WHEN NEW.settled_credits>0 BEGIN SELECT RAISE(ABORT,'synthetic-settle-failure'); END;",
        ),
    });
  } finally {
    db.exec('DROP TRIGGER fail_recovery_file');
  }
  // Default verifier must reject the fixture URL, for which no MP4 was written.
  const recovery = await createVoicedSalesVideoRecovery({ actor, jobId: h.id, runtime: h.runtime });
  await recovery.run();
  assert.equal(hold(h.id).status, 'settled');
  assert.equal(h.counts.recoverQuery, 2);
  assert.equal(snap(h.id).recovery.reusedResult, false);
});

test('音轨被替换/跨企业/错账号/错hash拒绝；无新调用，原hold保留', async () => {
  const h = await prepared(),
    track = snap(h.id).voiceTracks[0],
    args = { tenantId, userId, fileId: track.fileId, sha256: track.sha256 };
  for (const invalid of [
    { ...args, userId: -1 },
    { ...args, tenantId: tenantId + 1 },
    { ...args, sha256: 'f'.repeat(64) },
  ])
    await assert.rejects(readAiSalesVideoVoiceAsset(invalid));
  const file = q.get(
    'SELECT file_path FROM uploaded_files WHERE tenant_id=? AND id=?',
    tenantId,
    track.fileId,
  ).file_path;
  await fsp.writeFile(file, Buffer.from('replaced-aaa')); // same size, different bytes
  const before = balance(),
    calls = { ...h.counts };
  const recovery = await createVoicedSalesVideoRecovery({ actor, jobId: h.id, runtime: h.runtime });
  await recovery.run();
  assert.equal(row(h.id).status, '失败');
  assert.equal(hold(h.id).status, 'held');
  assert.equal(balance(), before);
  assert.deepEqual(h.counts, calls);
});

test('已退款/未知用量/变价/篡改快照均在查询前拒绝，不自动重新占扣', async () => {
  for (const mode of ['refunded', 'usage', 'script', 'price']) {
    const h = await prepared();
    if (mode === 'refunded') releaseHold({ holdId: hold(h.id).id });
    else {
      const plan = snap(h.id);
      if (mode === 'usage') plan.paidExecution[0].inputTokens = null;
      if (mode === 'script') plan.script.shots[0].voiceover += '篡改';
      if (mode === 'price') plan.priceQuote.tts = 0.01;
      q.run('UPDATE media_jobs SET snapshot_json=? WHERE tenant_id=? AND id=?', JSON.stringify(plan), tenantId, h.id);
    }
    const before = balance();
    await assert.rejects(createVoicedSalesVideoRecovery({ actor, jobId: h.id, runtime: h.runtime }));
    assert.equal(balance(), before);
    assert.equal(h.counts.recoverQuery, 0);
  }
  const h = await prepared(),
    original = getConfig('billing', {});
  try {
    setConfig('billing', {
      ...original,
      video: { ...original.video, 'wan2.6-i2v': billing().video['wan2.6-i2v'] + 1 },
    });
    await assert.rejects(createVoicedSalesVideoRecovery({ actor, jobId: h.id, runtime: h.runtime }), {
      code: 'AI_SALES_VIDEO_RECOVERY_PRICE_CHANGED',
    });
  } finally {
    setConfig('billing', original);
  }
});

test('已经实扣但最后快照写入中断：恢复不再次扣款，只补齐终态', async () => {
  const h = await prepared({ failAt: 'none' }),
    plan = snap(h.id),
    before = balance(),
    original = hold(h.id).id;
  plan.phase = 'compose';
  plan.billing.state = 'held';
  plan.billing.pendingReconciliation = true;
  q.run('UPDATE media_jobs SET snapshot_json=? WHERE tenant_id=? AND id=?', JSON.stringify(plan), tenantId, h.id);
  h.runtime.verifyExistingResult = async () => true;
  const recovery = await createVoicedSalesVideoRecovery({ actor, jobId: h.id, runtime: h.runtime });
  await recovery.run();
  assert.equal(balance(), before);
  assert.equal(hold(h.id).id, original);
  assert.equal(snap(h.id).phase, 'complete');
  assert.equal(snap(h.id).billing.state, 'settled');
});

test('HTTP复用入口接有声恢复，普通员工禁止，跨企业不可见', async () => {
  const h = await prepared();
  const app = express();
  app.use(express.json());
  app.locals.aiSalesVideoRuntime = h.runtime;
  app.use((req, _res, next) =>
    runWithTenant(req.headers['x-test-other'] ? 1 : tenantId, () => {
      req.user = req.headers['x-test-other']
        ? { ...actor, tenant_id: 1 }
        : { ...actor, role: req.headers['x-test-staff'] ? 'employee' : 'boss' };
      next();
    }),
  );
  app.use('/content', mediaReviewRoutes, contentRoutes);
  const local = app.listen(0, '127.0.0.1');
  await new Promise(resolve => local.once('listening', resolve));
  const url = `http://127.0.0.1:${local.address().port}/content/media-jobs/${h.id}/recover-ai-sales-video`;
  try {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'x-test-staff': '1' } })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'x-test-other': '1' } })).status, 404);
    const response = await fetch(url, { method: 'POST' });
    assert.equal(response.status, 202);
    for (let i = 0; i < 500 && row(h.id).status === '处理中'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(row(h.id).status, '成功');
    assert.equal(hold(h.id).status, 'settled');
  } finally {
    await new Promise(resolve => local.close(resolve));
  }
});

test('旧worker晚返回不能覆盖恢复者快照或继续提交视频', async () => {
  let resume, entered;
  const started = new Promise(resolve => {
    entered = resolve;
  });
  const outstanding = prepared({
    mutateRuntime: runtime => {
      runtime.voiceClient.synthesize = async () => {
        entered();
        await new Promise(resolve => {
          resume = resolve;
        });
        return { audioUrl: 'https://synthetic.example.com/audio.mp3' };
      };
    },
  });
  await started;
  const latest = q.get('SELECT id,snapshot_json FROM media_jobs WHERE tenant_id=? ORDER BY id DESC LIMIT 1', tenantId),
    plan = JSON.parse(latest.snapshot_json);
  plan.recoveryOwnerMarker = 'new-owner';
  q.run('UPDATE media_jobs SET snapshot_json=? WHERE tenant_id=? AND id=?', JSON.stringify(plan), tenantId, latest.id);
  resume();
  const h = await outstanding;
  assert.equal(snap(h.id).recoveryOwnerMarker, 'new-owner');
  assert.equal(snap(h.id).paidExecution.at(-1).status, 'started');
  assert.equal(h.counts.submit, 0);
  assert.equal(hold(h.id).status, 'held');
});

test('已导入素材库的任务不能重建文件并静默替换原业务素材', async () => {
  const h = await prepared();
  q.run(
    "INSERT INTO materials(name,type,url,source_type,source_id) VALUES('已导入测试视频','视频','/uploads/original.mp4','media_job',?)",
    h.id,
  );
  const original = row(h.id).snapshot_json,
    before = balance(),
    calls = { ...h.counts };
  await assert.rejects(createVoicedSalesVideoRecovery({ actor, jobId: h.id, runtime: h.runtime }), {
    code: 'AI_SALES_VIDEO_RECOVERY_IMPORTED',
  });
  assert.equal(row(h.id).snapshot_json, original);
  assert.equal(balance(), before);
  assert.deepEqual(h.counts, calls);
  assert.equal(
    q.get("SELECT url FROM materials WHERE tenant_id=? AND source_type='media_job' AND source_id=?", tenantId, h.id)
      .url,
    '/uploads/original.mp4',
  );
});

after(async () => {
  db.close();
  assert.equal(path.dirname(tenantRoot), uploadRoot);
  await fsp.rm(tenantRoot, { recursive: true, force: true });
});

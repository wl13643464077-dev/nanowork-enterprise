import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { after, test as nodeTest } from 'node:test';
Object.assign(process.env, {
  NANOWORK_DB: ':memory:',
  JWT_SECRET: 'isolated-voiced-recovery-test-secret-not-production',
  NANOWORK_TEST_TEMPLATE_AI: '1',
  NODE_ENV: 'test',
  ENABLE_SCHEDULER: 'false',
  ENABLE_BACKGROUND_EMBEDDINGS: 'false',
  YUNWU_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
});
const { db, q, initSchema, migrateV2, runWithTenant, getConfig, setConfig } = await import('../src/db.js');
const { createVoicedSalesVideoJob, voicedSalesSettlement, salesVideoPriceQuote } =
  await import('../src/engines/ai-sales-video-native.js');
const { createVoicedSalesVideoRecovery } = await import('../src/engines/ai-sales-video-voiced-recovery.js');
const { createAiSalesVideoAssetPublisher, readAiSalesVideoVoiceAsset } =
  await import('../src/engines/ai-sales-video-provider-assets.js');
const { countSpeechChars } = await import('../src/engines/ai-sales-video-script.js');
const { AI_SALES_VIDEO_UPLOAD_ROOT } = await import('../src/engines/video-composer.js');
const { read360Cost } = await import('../src/engines/provider-360-cost.js');
const { releaseHold, holdCredits, getSupplierExpense, billing } = await import('../src/engines/credits.js');
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
function script(durationSeconds = 30) {
  const a = '今天吃什么？' + '口味可以按自己的喜好来选。'.repeat(4),
    b = '想知道菜品详情吗？' + '口味可以按自己的喜好来选。'.repeat(3) + '选好再下单。到店咨询详情。';
  const voices = durationSeconds === 15 ? [a + '到店咨询详情。'] : [a, b];
  return {
    hook_3s: '今天吃什么？',
    shots: voices.map((voiceover, i) => ({
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
    total_chars: countSpeechChars(voices.join('')),
    estimated_seconds: durationSeconds,
    risk_flags: [],
  };
}
async function prepared({ failAt = 'query', beforeRun, mutateRuntime, legacy = false, durationSeconds = 30 } = {}) {
  const counts = {
      text: 0,
      tts: 0,
      submit: 0,
      query: 0,
      recoverQuery: 0,
      compose: 0,
    },
    fixtureId = crypto.randomUUID();
  const render = async p => {
    counts.compose++;
    assert.equal(p.requireAudio, true);
    if (p.audioMode === 'provider_native') assert.equal(p.voiceTracks, undefined);
    else assert.equal(p.voiceTracks.length, 2);
    return {
      url: `/uploads/ai-sales-video/${tenantId}/fixture-${fixtureId}.mp4`,
      durationSeconds,
      sha256: 'a'.repeat(64),
      audioVerified: true,
      ...(p.audioMode === 'provider_native'
        ? { audioSource: 'provider_native', subtitleTiming: 'script_estimated' }
        : {}),
      subtitlesBurnedIn: true,
      audioVerification: Array.from({ length: durationSeconds / 15 }, (_, i) => i * 15).map(startSeconds => ({
        startSeconds,
        durationSeconds: 15,
        peakDb: -20,
        method: 'ffmpeg-volumedetect',
      })),
    };
  };
  const runtime = {
    mediaReady: async () => ({
      ffmpegPath: 'local-test-ffmpeg',
      ffprobePath: 'local-test-ffprobe',
    }),
    prepareImages: async images => images,
    scanText: () => ({ hits: [] }),
    generateFn: async p => {
      counts.text++;
      return {
        mode: 'api',
        model: p.model,
        usage: { inputTokens: 1000, outputTokens: 450 },
        text: JSON.stringify(script(durationSeconds)),
      };
    },
    voiceClient: {
      synthesize: async () => {
        counts.tts++;
        return { audioUrl: 'https://synthetic.example.com/audio.mp3' };
      },
    },
    fetchImpl: async () =>
      new Response(Buffer.from('fixture-audio'), {
        headers: { 'content-type': 'audio/mpeg' },
      }),
    runner: async (cmd, args) => {
      if (cmd === 'local-test-ffprobe')
        return {
          stdout: JSON.stringify({
            format: { duration: 15 },
            streams: [{ codec_type: 'audio', duration: 15 }],
          }),
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
      return {
        status: 'success',
        url: 'https://synthetic.example.com/video.mp4',
      };
    },
    recoverQuery: async () => {
      counts.recoverQuery++;
      return {
        status: 'success',
        url: 'https://synthetic.example.com/video.mp4',
      };
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
    durationSeconds,
    actor,
    brief: '介绍本店菜品，邀请到店咨询',
    references: [{ name: '合成图' }],
    providerImages: ['data:image/png;base64,YWJj'],
    grounding: {
      evidence: {},
      storeFacts: { facts: [] },
      storeFactsPrompt: '',
      promptContext: '',
    },
    runtime,
  });
  assert.equal(created.response.status, 'processing', created.response.reason);
  if (beforeRun) await beforeRun();
  await created.run();
  let fixtureJobId = created.response.jobId;
  if (failAt === 'query' && row(fixtureJobId).status === '失败') {
    // The modern runner correctly refunds terminal failures. Recovery contracts
    // below exercise pre-policy, unrefunded history, so create a separate scoped
    // historical fixture; never reopen or rewrite the refunded task/ledger.
    const completed = row(fixtureJobId), plan = snap(fixtureJobId), refundedHold = hold(fixtureJobId);
    assert.ok(getSupplierExpense(refundedHold.id, tenantId).refundedAt);
    fixtureJobId = Number(q.run(`INSERT INTO media_jobs(tenant_id,user_id,kind,model,prompt,status,snapshot_json)
      VALUES(?,?,'video',?,?,'失败','{}')`, tenantId, userId, completed.model, completed.prompt).lastInsertRowid);
    const historicHold = holdCredits({ tenantId, userId, feature: '隔离历史恢复回执', kind: 'video', model: completed.model,
      credits: plan.priceQuote.maxCredits, refType: 'media_job', refId: fixtureJobId });
    q.run('UPDATE credit_holds SET pricing_snapshot_json=NULL WHERE tenant_id=? AND id=?', tenantId, historicHold.holdId);
    plan.billing = { ...plan.billing, holdId: historicHold.holdId, heldCredits: historicHold.credits,
      state: 'pending_reconciliation', chargedCredits: null, pendingReconciliation: true, releaseSuppressed: true };
    q.run('UPDATE media_jobs SET snapshot_json=? WHERE tenant_id=? AND id=?', JSON.stringify(plan), tenantId, fixtureJobId);
    assert.equal(hold(created.response.jobId).settled_credits, 0, '现代任务的退款记录保持原样');
  }
  if (legacy) {
    // Restore the historical external-TTS snapshot shape in the isolated DB.
    // New production jobs can no longer request this legacy generation mode.
    assert.equal(failAt, 'query');
    const id = fixtureJobId,
      plan = snap(id),
      original = hold(id);
    const quote = salesVideoPriceQuote(plan.priceQuote.textModel, {
      audioMode: 'external_tts', durationSeconds: 30,
    });
    delete quote.durationSeconds;
    delete quote.segmentCount;
    const { fingerprint: _oldFingerprint, maxCredits: _maxCredits, ...oldPrices } = quote;
    quote.fingerprint = crypto.createHash('sha256').update(JSON.stringify(oldPrices)).digest('hex');
    plan.priceQuote = quote;
    delete plan.durationSeconds;
    delete plan.segmentCount;
    delete plan.audioMode;
    delete plan.subtitleTiming;
    plan.voiceTracks = [];
    for (const index of [1, 2]) {
      const asset = await runtime.publishAsset({
        bytes: Buffer.from('fitted-audio'),
        mime: 'audio/mpeg',
        purpose: 'ai-sales-video-audio',
        label: `旧配音${index}`,
      });
      plan.voiceTracks.push({
        index,
        fileId: asset.fileId,
        sha256: asset.sha256,
        durationSeconds: 15,
        speechSeconds: 15,
      });
    }
    const textEvents = plan.paidExecution.filter(e => e.kind === 'text'),
      videos = plan.paidExecution.filter(e => e.kind === 'video');
    plan.paidExecution = [
      ...textEvents,
      ...[1, 2].map(index => ({
        kind: 'tts',
        model: 'speech-2.8-hd',
        index,
        status: 'returned',
      })),
      ...videos,
    ].map((e, i) => ({ ...e, id: i + 1 }));
    plan.billing.heldCredits = quote.maxCredits;
    db.prepare('UPDATE tenants SET credits=credits-? WHERE id=?').run(
      quote.maxCredits - original.held_credits,
      tenantId,
    );
    q.run('UPDATE credit_holds SET held_credits=? WHERE tenant_id=? AND id=?', quote.maxCredits, tenantId, original.id);
    q.run(
      'UPDATE credit_logs SET credits=?,balance_after=? WHERE tenant_id=? AND id=?',
      quote.maxCredits,
      balance(),
      tenantId,
      original.log_id,
    );
    q.run('UPDATE media_jobs SET snapshot_json=? WHERE tenant_id=? AND id=?', JSON.stringify(plan), tenantId, id);
    counts.tts = 2;
  }
  return { id: fixtureJobId, counts, runtime, created };
}

test('已全退的本地合成故障只复用本任务原片，恢复不查询上游不改账且拒绝无原片或越权', async () => {
  const h=await prepared({failAt:'compose',durationSeconds:15,mutateRuntime(runtime){
    const runner=runtime.runner;
    runtime.runner=async(cmd,args)=>cmd==='local-test-ffprobe'?{stdout:JSON.stringify({format:{duration:15},streams:[{codec_type:'video'},{codec_type:'audio'}]})}:runner(cmd,args);
    runtime.compose=async()=>{throw Object.assign(new Error('cross-device link'),{code:'EXDEV'});};
  }});
  assert.equal(row(h.id).status,'失败');assert.equal(hold(h.id).settled_credits,0);
  const plan=snap(h.id);assert.equal(plan.failureCode,'EXDEV');assert.equal(plan.partialResults.length,1);
  assert.equal(augmentMediaJob(row(h.id),actor).recovery.available,true);
  const ledger=()=>JSON.stringify({hold:hold(h.id),log:q.get('SELECT * FROM credit_logs WHERE id=?',hold(h.id).log_id),expense:getSupplierExpense(hold(h.id).id,tenantId),balance:balance()});
  const before=ledger(),snapshot=row(h.id).snapshot_json;
  for(const other of [{...actor,tenant_id:tenantId+1},{...actor,role:'sales'}])await assert.rejects(createVoicedSalesVideoRecovery({actor:other,jobId:h.id,runtime:h.runtime}));
  const part=path.join(AI_SALES_VIDEO_UPLOAD_ROOT,String(tenantId),path.posix.basename(plan.partialResults[0].url));
  const bytes=await fsp.readFile(part);
  await fsp.unlink(part);
  await assert.rejects(createVoicedSalesVideoRecovery({actor,jobId:h.id,runtime:h.runtime}));
  await fsp.writeFile(part,bytes);
  const foreignPart={...plan,partialResults:[{...plan.partialResults[0],url:plan.partialResults[0].url.replace(`/${tenantId}/`,`/${tenantId+1}/`)}]};
  q.run('UPDATE media_jobs SET snapshot_json=? WHERE id=?',JSON.stringify(foreignPart),h.id);
  await assert.rejects(createVoicedSalesVideoRecovery({actor,jobId:h.id,runtime:h.runtime}),/不属于本任务/);
  q.run('UPDATE media_jobs SET snapshot_json=? WHERE id=?',snapshot,h.id);
  const calls={...h.counts};
  for(const key of ['submitSegment','querySegment','recoverQuery','downloadSegment','recoverDownload','generateFn'])h.runtime[key]=async()=>{throw new Error(`免费恢复不得调用${key}`);};
  const recovered=await createVoicedSalesVideoRecovery({actor,jobId:h.id,runtime:h.runtime});
  assert.equal(recovered.response.recovery.mode,'reuse_verified_local_clips_after_refund');
  await recovered.run();await recovered.run();
  assert.equal(row(h.id).status,'成功');assert.equal(ledger(),before,'原退款、平台成本台账及用户余额全部不变');
  assert.equal(snap(h.id).billing.state,'released');assert.equal(snap(h.id).billing.chargedCredits,0);
  assert.equal(snap(h.id).billing.recoveredAfterRefund,true);assert.equal(snap(h.id).recovery.providerSubmissions,0);
  const presented=augmentMediaJob(row(h.id),actor);
  assert.equal(presented.billing.state,'not_required');assert.equal(presented.billing.chargedCredits,0);
  assert.equal(presented.billing.code,'MEDIA_BILLING_RECOVERED_AFTER_REFUND');assert.equal(presented.billing.authoritative,true);
  assert.equal(presented.canImport,true,'免费恢复后老板仍可正常采纳验收');
  assert.notEqual(augmentMediaJob({...row(h.id),user_id:userId+1},actor).billing.exempt,true,'另一账号不能凭恢复布尔取得免费账务授权');
  const changed=snap(h.id);changed.recovery.providerSubmissions=1;
  assert.notEqual(augmentMediaJob({...row(h.id),snapshot_json:JSON.stringify(changed)},actor).billing.exempt,true,'有新上游调用的快照不属于免费本地恢复');
  assert.equal(h.counts.compose,calls.compose+1);assert.equal(h.counts.submit,calls.submit);assert.equal(h.counts.recoverQuery,calls.recoverQuery);
  assert.deepEqual(await fsp.readFile(part),bytes,'恢复后保留原片');
  await assert.rejects(createVoicedSalesVideoRecovery({actor,jobId:h.id,runtime:h.runtime}),'完成后不能重复恢复');
});

test('合成失败已有真实9元回执时平台成本记9元且客户全退，坏成本证据也不能阻止退款', async()=>{
  for(const valid of [true,false]){
    const prefix=crypto.randomUUID();
    const receipt=(id,amount,model='wan2.6-i2v')=>read360Cost({model,response:{id,model,usage:{amount:String(amount)}}});
    const h=await prepared({failAt:'compose',durationSeconds:15,mutateRuntime(runtime){
      const generate=runtime.generateFn;
      runtime.generateFn=async params=>{const out=await generate(params);out.usage.supplierCosts=[receipt(`${prefix}-text`,0,params.model)];return out;};
      runtime.querySegment=async()=>({status:'success',url:'https://synthetic.example.com/video.mp4',supplierCosts:[{...receipt(`${prefix}-video`,9),...(!valid?{costSource:{}}:{})}]});
      runtime.compose=async()=>{throw Object.assign(new Error('cross-device link'),{code:'EXDEV'});};
    }});
    assert.equal(row(h.id).status,'失败');assert.equal(hold(h.id).settled_credits,0);
    const expense=getSupplierExpense(hold(h.id).id,tenantId);
    assert.equal(expense.refundedCredits,hold(h.id).held_credits);
    assert.ok(expense.refundedAt);
    if(valid){assert.equal(expense.status,'known');assert.equal(expense.costYuan,9);}
    else assert.equal(snap(h.id).billing.state,'released','坏回执只能影响成本核对，不能阻止用户全退');
  }
});

test('原生任务逐段持久化：第一段查询超时前，两段视频ID均可复用且无需独立配音资产', async () => {
  const h = await prepared(),
    plan = snap(h.id);
  assert.equal(row(h.id).status, '失败');
  assert.equal(h.counts.submit, 2);
  assert.equal(h.counts.query, 2, '第一段查询失败也应尝试免费取回已提交的第二段');
  assert.equal(plan.audioMode, 'provider_native');
  assert.equal(plan.voiceTracks, undefined);
  assert.equal(h.counts.tts, 0);
  assert.equal(augmentMediaJob(row(h.id), actor).recovery.available, true);
  const before = balance(),
    originalHold = hold(h.id),
    calls = { ...h.counts };
  const recovery = await createVoicedSalesVideoRecovery({
    actor,
    jobId: h.id,
    runtime: h.runtime,
  });
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

test('旧任务缺audioMode仍核验原TTS资产和旧报价，恢复不重复配音或视频生成', async () => {
  const h = await prepared({ legacy: true }),
    plan = snap(h.id),
    original = hold(h.id);
  assert.equal(plan.audioMode, undefined);
  assert.equal(plan.durationSeconds, undefined);
  assert.equal(plan.priceQuote.durationSeconds, undefined);
  for (const track of plan.voiceTracks)
    assert.deepEqual(await readAiSalesVideoVoiceAsset({ tenantId, userId, ...track }), Buffer.from('fitted-audio'));
  const calls = { ...h.counts };
  const recovery = await createVoicedSalesVideoRecovery({
    actor,
    jobId: h.id,
    runtime: h.runtime,
  });
  await recovery.run();
  assert.equal(row(h.id).status, '成功', snap(h.id).failureCode);
  assert.equal(hold(h.id).id, original.id);
  assert.equal(hold(h.id).status, 'settled');
  assert.equal(h.counts.tts, calls.tts);
  assert.equal(h.counts.submit, calls.submit);
  assert.equal(h.counts.recoverQuery, 2);
  assert.equal(snap(h.id).recovery.providerSubmissions, 0);
});

test('15秒已提交任务恢复只取回一个原任务，原hold结算一次且不会扩为两段', async () => {
  const h = await prepared({ durationSeconds: 15 });
  assert.equal(row(h.id).status, '失败');
  assert.equal(h.counts.submit, 1);
  assert.equal(snap(h.id).providerExecution.segments.length, 1);
  const originalHold = hold(h.id), before = { ...h.counts };
  const recovery = await createVoicedSalesVideoRecovery({ actor, jobId: h.id, runtime: h.runtime });
  await recovery.run();
  assert.equal(row(h.id).status, '成功', JSON.stringify(snap(h.id)));
  assert.equal(hold(h.id).id, originalHold.id);
  assert.equal(hold(h.id).status, 'settled');
  assert.equal(h.counts.submit, before.submit);
  assert.equal(h.counts.text, before.text);
  assert.equal(h.counts.tts, 0);
  assert.equal(h.counts.recoverQuery, 1);
  assert.equal(snap(h.id).result.durationSeconds, 15);
  assert.equal(snap(h.id).result.audioVerification.length, 1);
  assert.equal(snap(h.id).recovery.providerSubmissions, 0);
  const finalBalance = balance();
  await recovery.run();
  assert.equal(balance(), finalBalance);
});

test('旧Wan原生任务无duration与旧报价签名仍按30秒恢复，不改写原价格或扩大收费', async () => {
  const h = await prepared(), plan = snap(h.id), original = hold(h.id);
  delete plan.durationSeconds;
  delete plan.segmentCount;
  delete plan.priceQuote.durationSeconds;
  delete plan.priceQuote.segmentCount;
  const { fingerprint: _previousFingerprint, maxCredits: _previousMax, ...prices } = plan.priceQuote;
  plan.priceQuote.fingerprint = crypto.createHash('sha256').update(JSON.stringify(prices)).digest('hex');
  q.run('UPDATE media_jobs SET snapshot_json=? WHERE tenant_id=? AND id=?', JSON.stringify(plan), tenantId, h.id);
  const originalQuote = structuredClone(plan.priceQuote);
  const recovery = await createVoicedSalesVideoRecovery({ actor, jobId:h.id, runtime:h.runtime });
  await recovery.run();
  assert.equal(row(h.id).status, '成功', JSON.stringify(snap(h.id)));
  assert.equal(hold(h.id).id, original.id);
  assert.equal(hold(h.id).held_credits, original.held_credits);
  assert.equal(snap(h.id).durationSeconds, undefined, '不把旧任务的缺省语义改写为新默认');
  assert.equal(snap(h.id).result.durationSeconds, 30);
  assert.deepEqual(snap(h.id).priceQuote, originalQuote);
  assert.equal(h.counts.submit, 2);
  assert.equal(h.counts.recoverQuery, 2);
  assert.equal(h.counts.tts, 0);
});
test('恢复使用规范化临时目录仍拒绝下载软链逃逸，不合成不结算', async () => {
  const h = await prepared();
  const outside = path.join(tenantRoot, `escape-${h.id}.mp4`);
  await fsp.mkdir(tenantRoot, { recursive: true });
  await fsp.writeFile(outside, 'outside-task-directory');
  h.runtime.recoverDownload = async ({ outputDir, index }) => {
    const linked = path.join(outputDir, `linked-${index}.mp4`);
    await fsp.symlink(outside, linked);
    return { path: linked };
  };
  try {
    const recovery = await createVoicedSalesVideoRecovery({
      actor,
      jobId: h.id,
      runtime: h.runtime,
    });
    await recovery.run();
    assert.equal(row(h.id).status, '失败');
    assert.equal(hold(h.id).status, 'held');
    assert.equal(h.counts.compose, 0);
    assert.equal(h.counts.submit, 2);
  } finally {
    await fsp.rm(outside, { force: true });
  }
});

test('并发恢复只有一个认领，重复worker不会重新查询、合成或扣款', async () => {
  const h = await prepared();
  const outcomes = await Promise.allSettled(
    [1, 2].map(() =>
      createVoicedSalesVideoRecovery({
        actor,
        jobId: h.id,
        runtime: h.runtime,
      }),
    ),
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
  const recovery = await createVoicedSalesVideoRecovery({
    actor,
    jobId: h.id,
    runtime: h.runtime,
  });
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
  const recovery = await createVoicedSalesVideoRecovery({
    actor,
    jobId: h.id,
    runtime: h.runtime,
  });
  await recovery.run();
  assert.equal(hold(h.id).status, 'settled');
  assert.equal(h.counts.recoverQuery, 2);
  assert.equal(snap(h.id).recovery.reusedResult, false);
});

test('旧TTS任务音轨被替换/跨企业/错账号/错hash拒绝；无新调用，原hold保留', async () => {
  const h = await prepared({ legacy: true }),
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
  const recovery = await createVoicedSalesVideoRecovery({
    actor,
    jobId: h.id,
    runtime: h.runtime,
  });
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
    await assert.rejects(
      createVoicedSalesVideoRecovery({
        actor,
        jobId: h.id,
        runtime: h.runtime,
      }),
    );
    assert.equal(balance(), before);
    assert.equal(h.counts.recoverQuery, 0);
  }
  const h = await prepared(),
    original = getConfig('billing', {});
  try {
    setConfig('billing', {
      ...original,
      video: {
        ...original.video,
        'wan2.6-i2v': billing().video['wan2.6-i2v'] + 1,
      },
    });
    await assert.rejects(
      createVoicedSalesVideoRecovery({
        actor,
        jobId: h.id,
        runtime: h.runtime,
      }),
      {
        code: 'AI_SALES_VIDEO_RECOVERY_PRICE_CHANGED',
      },
    );
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
  const recovery = await createVoicedSalesVideoRecovery({
    actor,
    jobId: h.id,
    runtime: h.runtime,
  });
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
      const generate = runtime.generateFn;
      runtime.generateFn = async params => {
        const output = await generate(params);
        entered();
        await new Promise(resolve => {
          resume = resolve;
        });
        return output;
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


async function personalRecoveryFixture() {
  const h = await prepared({ durationSeconds: 15 });
  const api = await import('../src/engines/tester-trials.js');
  const suffix = crypto.randomBytes(6).toString('hex');
  api.applyTester({ username: `recovery_${suffix}`, password: 'Fixture-Password-Only!', name: '恢复测试员',
    phone: `139${String(crypto.randomInt(10000000, 99999999))}`, consent: true });
  const user = q.get('SELECT id,tenant_id FROM users WHERE username=?', `recovery_${suffix}`);
  const administrator = { id: Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES(?,'x','恢复测试管理员','platform_super',1,'启用')", `recovery_super_${suffix}`).lastInsertRowid) };
  api.updateTesterStatus(administrator, user.id, 'approved');
  api.setTesterKey(user, 'fake-original-openlux-key', 'openlux');
  api.setTesterKey(user, 'fake-new-360-key', '360');
  api.setTesterProvider(user, 'openlux');
  const plan = snap(h.id);
  plan.providerId = 'openlux';
  const tester = { ...user, role: 'tester' };
  return runWithTenant(user.tenant_id, () => {
    const id = Number(q.run(`INSERT INTO media_jobs(tenant_id,user_id,kind,model,prompt,status,snapshot_json)
      VALUES(?,?,'video',?,'个人恢复隔离测试','失败','{}')`, user.tenant_id, user.id, plan.model).lastInsertRowid);
    const original = holdCredits({ userId: user.id, tenantId: user.tenant_id, feature: '个人恢复测试',
      kind: 'video', model: plan.model, credits: plan.priceQuote.maxCredits, refType: 'media_job', refId: id });
    plan.billing = { ...plan.billing, holdId: original.holdId, heldCredits: 0,
      state: 'pending_reconciliation', pendingReconciliation: true };
    q.run('UPDATE media_jobs SET snapshot_json=? WHERE tenant_id=? AND id=?', JSON.stringify(plan), user.tenant_id, id);
    const compose = h.runtime.recoverCompose;
    h.runtime.recoverCompose = async input => ({ ...await compose(input), url: `/uploads/ai-sales-video/${user.tenant_id}/fixture.mp4` });
    h.runtime.supplierRequestCost = async () => null;
    return { ...h, id, plan, tester, api, original };
  });
}

test('个人原供应商视频恢复接受权威零占扣，切换默认供应商仍按原Key恢复且不扣企业余额', async () => {
  const h = await personalRecoveryFixture();
  const { selectedProviderCredentials } = await import('../src/engines/ai-provider-selection.js');
  h.api.setTesterProvider(h.tester, '360');
  const query = h.runtime.recoverQuery;
  h.runtime.recoverQuery = async args => {
    const credential = selectedProviderCredentials();
    assert.equal(credential.id, 'openlux');
    assert.equal(credential.apiKey, 'fake-original-openlux-key');
    return query(args);
  };
  await runWithTenant(h.tester.tenant_id, async () => {
    const recovery = await createVoicedSalesVideoRecovery({ actor: h.tester, jobId: h.id, runtime: h.runtime });
    await recovery.run();
    const result = q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', h.tester.tenant_id, h.id);
    assert.equal(result.status, '成功', result.error);
    assert.equal(result.credits, 0);
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', h.tester.tenant_id).credits, 0);
    assert.equal(q.get('SELECT held_credits,status,settled_credits FROM credit_holds WHERE id=?', h.original.holdId).status, 'settled');
    assert.equal(h.counts.recoverQuery, 1);
    // Final-snapshot interruption must also recognize a legitimate settled zero bill.
    const plan = JSON.parse(result.snapshot_json);
    plan.phase = 'compose'; plan.billing.state = 'held';
    q.run('UPDATE media_jobs SET snapshot_json=? WHERE tenant_id=? AND id=?', JSON.stringify(plan), h.tester.tenant_id, h.id);
    h.runtime.verifyExistingResult = async () => true;
    const retry = await createVoicedSalesVideoRecovery({ actor: h.tester, jobId: h.id, runtime: h.runtime });
    await retry.run();
    assert.equal(h.counts.recoverQuery, 1);
    assert.equal(q.get('SELECT settled_credits FROM credit_holds WHERE id=?', h.original.holdId).settled_credits, 0);
  });
});

test('个人恢复拒绝伪造零账目归属，普通企业零占扣也不能绕过旧金额校验', async () => {
  const h = await personalRecoveryFixture();
  await runWithTenant(h.tester.tenant_id, async () => {
    const row = q.get('SELECT pricing_snapshot_json FROM credit_holds WHERE id=?', h.original.holdId);
    const price = JSON.parse(row.pricing_snapshot_json);
    for (const patch of [{ ownerUserId: userId }, { tenantId }, { provider: '360' }, { billingMode: 'enterprise' }]) {
      q.run('UPDATE credit_holds SET pricing_snapshot_json=? WHERE id=?', JSON.stringify({ ...price, ...patch }), h.original.holdId);
      await assert.rejects(createVoicedSalesVideoRecovery({ actor: h.tester, jobId: h.id, runtime: h.runtime }),
        { code: 'AI_SALES_VIDEO_RECOVERY_HOLD_INVALID' });
    }
    assert.equal(h.counts.recoverQuery, 0);
    q.run('UPDATE credit_holds SET pricing_snapshot_json=? WHERE id=?', row.pricing_snapshot_json, h.original.holdId);
  });
});

after(async () => {
  db.close();
  assert.equal(path.dirname(tenantRoot), uploadRoot);
  await fsp.rm(tenantRoot, { recursive: true, force: true });
  await fsp.rm(path.join(AI_SALES_VIDEO_UPLOAD_ROOT,String(tenantId)),{recursive:true,force:true});
});

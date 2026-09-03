import assert from 'node:assert/strict';
import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';

process.env.NANOWORK_DB = ':memory:';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.YUNWU_API_KEY = '';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { holdCredits, releaseHold } = await import('../src/engines/credits.js');
const { buildAiSalesVideoPlan } = await import('../src/engines/ai-sales-video.js');
const { augmentMediaJob } = await import('../src/routes/media-review.js');
const contentRoutes = (await import('../src/routes/content.js')).default;

initSchema();
migrateV2();
q.run(`UPDATE tenants SET name='AI带货测试租户',status='已开通',credits=100000 WHERE id=1`);
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,?)`,
  'sales-video-route-user', 'x', '带货测试老板', 'boss', '内容部', 1);
const user = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username=?`, 'sales-video-route-user');

function appFor(currentUser = user, runtime = null) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  if (runtime) app.locals.aiSalesVideoRuntime = runtime;
  app.use((req, _res, next) => runWithTenant(currentUser.tenant_id, () => {
    req.user = currentUser;
    next();
  }));
  app.use('/content', contentRoutes);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  return app;
}

async function listenApp(app) {
  const local = app.listen(0, '127.0.0.1');
  const port = await new Promise(resolve => local.once('listening', () => resolve(local.address().port)));
  return { server: local, base: `http://127.0.0.1:${port}` };
}

async function waitForMediaJob(jobId, expectedStatus, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let row;
  while (Date.now() < deadline) {
    row = q.get(`SELECT * FROM media_jobs WHERE tenant_id=? AND id=?`, 1, jobId);
    if (row?.status === expectedStatus) return row;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(row?.status, expectedStatus, `media_job#${jobId} 未在 ${timeoutMs}ms 内进入${expectedStatus}`);
  return row;
}

let server;
let base;
const tinyImage = 'data:image/png;base64,YWJj';

test('POST /content/ai-sales-video persists a blocked 30-second plan without network or credits', async () => {
  const app = appFor();
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/content/ai-sales-video`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      brief: '突出人物介绍、招牌菜和门店到店动作',
      referenceImages: [tinyImage],
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(body.workflow, 'ai_sales_video');
  assert.equal(body.status, 'blocked');
  assert.equal(body.durationSeconds, 30);
  assert.equal(body.providerCalls, 0);
  assert.match(body.pollUrl, new RegExp(`/content/media-jobs/${body.jobId}$`, 'u'));
  assert.equal(body.contentEmployeeIdx, 10);
  assert.equal(body.contentEmployeeKey, 'commerce_video');
  assert.match(body.reason, /未配置云雾|合成器/u);

  const row = q.get(`SELECT * FROM media_jobs WHERE tenant_id=? AND id=?`, 1, body.jobId);
  assert.equal(row.status, '阻塞');
  assert.equal(row.content_employee_idx, 10);
  assert.equal(row.content_employee_key, 'commerce_video');
  const snapshot = JSON.parse(row.snapshot_json);
  assert.equal(snapshot.workflow, 'ai_sales_video');
  assert.equal(snapshot.durationSeconds, 30);
  assert.deepEqual(snapshot.segments.map(segment => segment.durationSeconds), [10, 10, 10]);
  assert.equal(snapshot.references[0].contentSha256.length, 64);
  assert.equal(snapshot.references[0].dataUrl, undefined);
  assert.equal(snapshot.employeeExecution.identity.idx, 10);
  assert.ok(snapshot.employeeExecution.capabilities.length >= 4);
  assert.ok(snapshot.employeeExecution.skillLibrary.required.length >= 1);
  assert.ok(snapshot.employeeExecution.prompts.systemPrompt);
  assert.ok(snapshot.employeeExecution.workConfig.factoryDefault);
  assert.ok(snapshot.employeeExecution.jobProfile.expectedDeliverables.length > 0);
  assert.ok(snapshot.employeeExecution.runtimeBindings.currentRuntimeBindings.connectors.length > 0);
  assert.equal(snapshot.employeeExecution.selectedRuntime.model, 'MiniMax-Hailuo-2.3');
  assert.equal(snapshot.grounding.knowledgeBase.allowed, true);
  assert.equal(snapshot.grounding.knowledgeBase.tenantScoped, true);
  assert.equal(snapshot.grounding.web.allowed, true);
  assert.equal(snapshot.grounding.web.triggered, false);
  const holdTable = q.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='credit_holds'`);
  if (holdTable) {
    assert.equal(q.get(`SELECT COUNT(*) count FROM credit_holds WHERE tenant_id=? AND ref_type='media_job' AND ref_id=?`, 1, body.jobId)?.count || 0, 0);
  }
});

test('injected provider completes exactly three 10-second segments, settles the hold, and does not auto-publish/import', async () => {
  // This is a fully local provider harness. The route must exercise its real
  // asynchronous orchestration, but no fetch/network/provider credential is
  // allowed to participate in this test.
  const submitCalls = [];
  const queryCalls = [];
  const downloadCalls = [];
  const composeCalls = [];
  const kbCalls = [];
  const webCalls = [];
  const runtime = {
    intervalMs: 1,
    timeoutMs: 100,
    kbSearch: async (categories, role, query) => {
      kbCalls.push({ categories, role, query });
      return {
        text: '企业已确认知识：招牌菜名为金牌拌饭。',
        refs: [{ id: 71, category: '产品资料', title: '菜品档案', sim: 0.91 }],
        degraded: false,
        mode: 'semantic',
      };
    },
    webSearch: async query => {
      webCalls.push(query);
      return {
        ok: true,
        provider: 'local-test-search',
        results: [{
          title: '官方平台当前发布指引',
          url: 'https://official.test/current-guide',
          snippet: '本次测试用已验证摘要。',
        }],
      };
    },
    submitSegment: async ({ duration, model, images, prompt }) => {
      submitCalls.push({ duration, model, imageCount: images.length, prompt });
      const index = submitCalls.length;
      return { taskId: `local-sales-task-${index}`, model };
    },
    querySegment: async ({ taskId }) => {
      queryCalls.push(taskId);
      return {
        url: `https://provider.invalid/local-sales/${taskId}.mp4`,
        status: 'success',
      };
    },
    downloadSegment: async ({ url, outputDir, index }) => {
      downloadCalls.push({ url, outputDir, index });
      return {
        path: `/tmp/local-sales-provider-segment-${index}.mp4`,
        sha256: String(index).repeat(64),
        bytes: 1024,
      };
    },
    compose: async ({ plan, segments }) => {
      composeCalls.push({ plan, segments });
      assert.equal(segments.length, 3);
      assert.deepEqual(segments.map(segment => segment.durationSeconds), [10, 10, 10]);
      assert.ok(segments.every(segment => segment.localPath.startsWith('/tmp/local-sales-provider-segment-')));
      return {
        url: '/uploads/ai-sales-video/1/local-sales-job.mp4',
        durationSeconds: 30,
        width: 1080,
        height: 1920,
        videoCodec: 'h264',
        audioCodec: 'aac',
        segmentCount: 3,
        sha256: 'f'.repeat(64),
      };
    },
  };
  const app = appFor(user, runtime);
  const local = await listenApp(app);
  const contentCountBefore = q.get(`SELECT COUNT(*) count FROM contents WHERE tenant_id=?`, 1).count;
  const assetCountBefore = q.get(`SELECT COUNT(*) count FROM biz_assets WHERE tenant_id=?`, 1).count;
  const materialCountBefore = q.get(`SELECT COUNT(*) count FROM materials WHERE tenant_id=?`, 1).count;
  const balanceBefore = Number(q.get(`SELECT credits FROM tenants WHERE id=?`, 1).credits);
  try {
    const response = await fetch(`${local.base}/content/ai-sales-video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        brief: '结合最新官方信息，突出人物介绍、招牌菜和门店到店动作',
        referenceImages: [tinyImage],
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.status, 'processing');
    assert.equal(body.workflow, 'ai_sales_video');
    assert.equal(body.plan.segmentCount, 3);
    assert.equal(body.plan.segmentDurationSeconds, 10);
    assert.equal(body.billing.state, 'held');
    assert.match(body.pollUrl, new RegExp(`/content/media-jobs/${body.jobId}$`, 'u'));

    const row = await waitForMediaJob(body.jobId, '成功');
    assert.equal(row.url, '/uploads/ai-sales-video/1/local-sales-job.mp4');
    assert.equal(row.result_id, null, 'AI带货员只交付媒体验收，不应自动生成内容正文');
    assert.ok(Number(row.credits) > 0, '成功任务应记录正向实扣积分');
    assert.equal(submitCalls.length, 3);
    assert.deepEqual(submitCalls.map(call => call.duration), [10, 10, 10]);
    assert.equal(kbCalls.length, 1);
    assert.equal(webCalls.length, 1);
    assert.ok(submitCalls.every(call => call.prompt.includes('企业已确认知识')));
    assert.ok(submitCalls.every(call => call.prompt.includes('official.test/current-guide')));
    assert.equal(queryCalls.length, 3);
    assert.equal(downloadCalls.length, 3);
    assert.equal(composeCalls.length, 1);

    const hold = q.get(
      `SELECT * FROM credit_holds WHERE tenant_id=? AND ref_type='media_job' AND ref_id=?`,
      1,
      body.jobId,
    );
    assert.ok(hold, '任务必须有唯一的权威预授权记录');
    assert.equal(hold.status, 'settled');
    assert.equal(Number(hold.held_credits), 1710, 'Hailuo 2.3应按¥3.80/10秒×3段×1.5毛利系数预授权');
    assert.ok(Number(hold.settled_credits) > 0);
    assert.equal(Number(hold.settled_credits), Number(row.credits));
    const ledger = q.get(`SELECT * FROM credit_logs WHERE tenant_id=? AND id=?`, 1, hold.log_id);
    assert.equal(ledger.ai_mode, 'api');
    assert.ok(Number(ledger.credits) > 0);

    const snapshot = JSON.parse(row.snapshot_json);
    assert.equal(snapshot.status, '成功');
    assert.equal(snapshot.billing.state, 'settled');
    assert.ok(Number(snapshot.billing.chargedCredits) > 0);
    assert.equal(snapshot.providerExecution.invocationStarted, true);
    assert.equal(snapshot.providerExecution.invocationCount, 3);
    assert.ok(Number.isFinite(Date.parse(snapshot.providerExecution.updatedAt)));
    assert.deepEqual(
      snapshot.providerExecution.segments.map(segment => segment.status),
      ['downloaded', 'downloaded', 'downloaded'],
    );
    assert.deepEqual(
      snapshot.providerExecution.segments.map(segment => segment.taskId),
      ['local-sales-task-1', 'local-sales-task-2', 'local-sales-task-3'],
    );
    assert.equal(snapshot.result.providerCalls, 3);
    assert.equal(snapshot.grounding.knowledgeBase.tenantScoped, true);
    assert.equal(snapshot.grounding.knowledgeBase.verified, true);
    assert.equal(snapshot.grounding.web.triggered, true);
    assert.equal(snapshot.grounding.web.verified, true);
    assert.deepEqual(snapshot.result.segments.map(segment => segment.durationSeconds), [10, 10, 10]);
    assert.equal(snapshot.result.url, row.url);
    const serialized = row.snapshot_json;
    assert.doesNotMatch(serialized, /data:image\//u, '持久化快照不得泄漏参考图 data URL');
    assert.doesNotMatch(serialized, /provider\.invalid/u, '持久化快照不得泄漏供应商临时 URL');
    assert.doesNotMatch(serialized, /local-sales-provider-segment/u, '持久化快照不得泄漏服务器本地路径');

    // Delivery stays in the media review area. No content, material, or
    // business asset is silently imported/published by the AI employee.
    assert.equal(q.get(`SELECT COUNT(*) count FROM contents WHERE tenant_id=?`, 1).count, contentCountBefore);
    assert.equal(q.get(`SELECT COUNT(*) count FROM biz_assets WHERE tenant_id=?`, 1).count, assetCountBefore);
    assert.equal(q.get(`SELECT COUNT(*) count FROM materials WHERE tenant_id=?`, 1).count, materialCountBefore);
    assert.equal(Number(q.get(`SELECT credits FROM tenants WHERE id=?`, 1).credits), balanceBefore - Number(row.credits));
  } finally {
    await new Promise(resolve => local.server.close(resolve));
  }
});

test('provider failure after invocation retains the complete hold for reconciliation', async () => {
  q.run(`UPDATE tenants SET credits=100000 WHERE id=?`, 1);
  const submitCalls = [];
  const runtime = {
    skipPriceCheck: true,
    submitSegment: async ({ duration }) => {
      submitCalls.push(duration);
      if (submitCalls.length === 2) throw new Error('local provider segment failure');
      return {
        taskId: `local-failure-task-${submitCalls.length}`,
        url: `https://provider.invalid/failure-${submitCalls.length}.mp4`,
      };
    },
    downloadSegment: async ({ index }) => ({
      path: `/tmp/local-sales-failure-${index}.mp4`,
      sha256: String(index + 4).repeat(64),
    }),
    compose: async () => {
      throw new Error('compose must not run after provider failure');
    },
  };
  const app = appFor(user, runtime);
  const local = await listenApp(app);
  const balanceBefore = Number(q.get(`SELECT credits FROM tenants WHERE id=?`, 1).credits);
  try {
    const response = await fetch(`${local.base}/content/ai-sales-video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: '验证供应商失败退款', referenceImages: [tinyImage] }),
    });
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.status, 'processing');
    const row = await waitForMediaJob(body.jobId, '失败');
    assert.equal(row.url, null);
    assert.equal(row.credits, null);
    assert.equal(submitCalls.length, 2);
    const hold = q.get(
      `SELECT * FROM credit_holds WHERE tenant_id=? AND ref_type='media_job' AND ref_id=?`,
      1,
      body.jobId,
    );
    assert.ok(hold);
    assert.equal(hold.status, 'held');
    assert.equal(hold.settled_credits, null, '供应商已调用时不得伪造结算或自动退款');
    assert.ok(Number(hold.held_credits) > 0);
    const ledger = q.get(`SELECT * FROM credit_logs WHERE tenant_id=? AND id=?`, 1, hold.log_id);
    assert.equal(Number(ledger.credits), Number(hold.held_credits));
    assert.equal(ledger.ai_mode, 'hold');
    assert.equal(
      Number(q.get(`SELECT credits FROM tenants WHERE id=?`, 1).credits),
      balanceBefore - Number(hold.held_credits),
    );
    const snapshot = JSON.parse(row.snapshot_json);
    assert.equal(snapshot.status, '失败');
    assert.equal(snapshot.billing.state, 'pending_reconciliation');
    assert.equal(snapshot.billing.chargedCredits, null);
    assert.equal(snapshot.billing.releaseSuppressed, true);
    assert.equal(snapshot.providerExecution.invocationStarted, true);
    assert.equal(snapshot.providerExecution.invocationCount, 2);
    assert.deepEqual(
      snapshot.providerExecution.segments.map(segment => segment.status),
      ['downloaded', 'failed', 'planned'],
    );
    assert.deepEqual(
      snapshot.providerExecution.segments.map(segment => segment.taskId),
      ['local-failure-task-1', null, null],
    );
    assert.doesNotMatch(row.snapshot_json, /provider\.invalid|local-sales-failure/u);
  } finally {
    await new Promise(resolve => local.server.close(resolve));
  }
});

test('failure before the first provider invocation releases the complete hold', async () => {
  q.run(`UPDATE tenants SET credits=100000 WHERE id=?`, 1);
  let providerCalls = 0;
  const runtime = {
    skipPriceCheck: true,
    beforeProviderInvocation: async () => {
      throw new Error('local pre-provider gate failure');
    },
    submitSegment: async () => {
      providerCalls += 1;
      return { url: 'https://provider.invalid/must-not-run.mp4' };
    },
    compose: async () => {
      throw new Error('compose must not run before provider invocation');
    },
  };
  const app = appFor(user, runtime);
  const local = await listenApp(app);
  const balanceBefore = Number(q.get(`SELECT credits FROM tenants WHERE id=?`, 1).credits);
  try {
    const response = await fetch(`${local.base}/content/ai-sales-video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: '验证供应商调用前失败退款', referenceImages: [tinyImage] }),
    });
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.status, 'processing');
    const row = await waitForMediaJob(body.jobId, '失败');
    assert.equal(providerCalls, 0);
    assert.equal(Number(row.credits), 0);
    const hold = q.get(
      `SELECT * FROM credit_holds WHERE tenant_id=? AND ref_type='media_job' AND ref_id=?`,
      1,
      body.jobId,
    );
    assert.ok(hold);
    assert.equal(hold.status, 'settled');
    assert.equal(Number(hold.settled_credits), 0);
    assert.equal(Number(q.get(`SELECT credits FROM tenants WHERE id=?`, 1).credits), balanceBefore);
    const snapshot = JSON.parse(row.snapshot_json);
    assert.equal(snapshot.billing.state, 'released');
    assert.equal(snapshot.providerExecution.invocationStarted, false);
    assert.deepEqual(
      snapshot.providerExecution.segments.map(segment => segment.status),
      ['planned', 'planned', 'planned'],
    );
  } finally {
    await new Promise(resolve => local.server.close(resolve));
  }
});

test('refunded historical job can recover existing provider tasks with zero new submissions', async () => {
  q.run(`UPDATE tenants SET credits=100000 WHERE id=?`, 1);
  const plan = buildAiSalesVideoPlan({
    brief: '复用三个已经完成的旧供应商视频片段',
    references: [{ source: 'inline', name: '旧任务参考图', dataUrl: tinyImage }],
    model: 'MiniMax-Hailuo-2.3',
  });
  const providerExecution = {
    invocationStarted: true,
    invocationCount: 3,
    segments: plan.segments.map(segment => ({
      index: segment.index,
      durationSeconds: segment.durationSeconds,
      status: 'downloaded',
      taskId: `historical-provider-task-${segment.index}`,
    })),
  };
  const jobId = Number(q.run(
    `INSERT INTO media_jobs(
      tenant_id,user_id,kind,model,prompt,status,content_run_mode,snapshot_json
    ) VALUES(?,?,?,?,?,'失败','ai_sales_video',?)`,
    1,
    user.id,
    'video',
    plan.model,
    '历史带货视频恢复测试',
    JSON.stringify({ ...plan, status: '失败', providerExecution }),
  ).lastInsertRowid);
  const releasedHold = holdCredits({
    userId: user.id,
    feature: '历史带货视频恢复测试',
    kind: 'video',
    model: plan.model,
    credits: 1710,
    refType: 'media_job',
    refId: jobId,
  });
  releaseHold(releasedHold, '模拟旧版本误判超时后的全额退回');
  const projected = runWithTenant(1, () => augmentMediaJob(
    q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', 1, jobId),
    user,
  ));
  assert.equal(projected.recovery.available, true);
  assert.equal(projected.recovery.requiresBillingConfirmation, true);
  assert.equal(projected.recovery.providerSubmissions, 0);
  const queryCalls = [];
  const runtime = {
    recoverQuery: async ({ taskId }) => {
      queryCalls.push(taskId);
      return { status: 'Success', url: `https://provider.invalid/${taskId}.mp4` };
    },
    recoverDownload: async ({ outputDir, index }) => {
      const filePath = path.join(outputDir, `recovered-${index}.mp4`);
      await fsp.writeFile(filePath, Buffer.from(`segment-${index}`));
      return { path: filePath, sha256: String(index).repeat(64) };
    },
    recoverCompose: async ({ tenantId, segments }) => ({
      url: `/uploads/ai-sales-video/${tenantId}/recovered-route-job.mp4`,
      durationSeconds: 30,
      width: 1080,
      height: 1920,
      videoCodec: 'h264',
      audioCodec: 'aac',
      segmentCount: segments.length,
      sha256: 'a'.repeat(64),
    }),
  };
  const app = appFor(user, runtime);
  const local = await listenApp(app);
  const balanceBefore = Number(q.get('SELECT credits FROM tenants WHERE id=?', 1).credits);
  try {
    const quoteResponse = await fetch(`${local.base}/content/media-jobs/${jobId}/recover-ai-sales-video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const quote = await quoteResponse.json();
    assert.equal(quoteResponse.status, 409);
    assert.equal(quote.code, 'AI_SALES_VIDEO_RECOVERY_BILLING_CONFIRMATION_REQUIRED');
    assert.equal(quote.billing.estimatedCredits, 1710);
    assert.equal(quote.billing.providerSubmissions, 0);
    assert.equal(queryCalls.length, 0);

    const response = await fetch(`${local.base}/content/media-jobs/${jobId}/recover-ai-sales-video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmCharge: true }),
    });
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.status, 'processing');
    assert.equal(body.recovery.providerSubmissions, 0);
    const row = await waitForMediaJob(jobId, '成功');
    assert.equal(row.url, '/uploads/ai-sales-video/1/recovered-route-job.mp4');
    assert.equal(queryCalls.length, 3);
    const snapshot = JSON.parse(row.snapshot_json);
    assert.equal(snapshot.result.providerCalls, 0);
    assert.equal(snapshot.result.reusedProviderTasks, 3);
    assert.equal(snapshot.providerExecution.recovery.providerSubmissions, 0);
    const latestHold = q.get(
      `SELECT * FROM credit_holds WHERE tenant_id=? AND ref_type='media_job' AND ref_id=? ORDER BY id DESC LIMIT 1`,
      1,
      jobId,
    );
    assert.equal(latestHold.status, 'settled');
    assert.equal(Number(latestHold.settled_credits), 1710);
    assert.equal(Number(q.get('SELECT credits FROM tenants WHERE id=?', 1).credits), balanceBefore - 1710);
  } finally {
    await new Promise(resolve => local.server.close(resolve));
  }
});

test('reference file ids remain tenant-authorized and invalid ids fail before job creation', async () => {
  const before = q.get(`SELECT COUNT(*) count FROM media_jobs WHERE tenant_id=?`, 1).count;
  const app = appFor();
  const local = app.listen(0, '127.0.0.1');
  const port = await new Promise(resolve => local.once('listening', () => resolve(local.address().port)));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/content/ai-sales-video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: '新品展示', fileIds: [999999] }),
    });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /不存在|无权/u);
  } finally {
    await new Promise(resolve => local.close(resolve));
  }
  const after = q.get(`SELECT COUNT(*) count FROM media_jobs WHERE tenant_id=?`, 1).count;
  assert.equal(after, before);
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  try { db.close(); } catch { /* already closed */ }
});

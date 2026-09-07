import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const databasePath = path.join(os.tmpdir(), `provider-360-generic-video-${process.pid}.db`);
Object.assign(process.env, { NANOWORK_DB: databasePath, NODE_ENV: 'test', NANOWORK_TEST_TEMPLATE_AI: '1',
  ENABLE_SCHEDULER: 'false', SEED_DEMO: 'false', NANOWORK_AI_PROVIDER: '360', AI360_API_KEY: 'generic-video-test-key',
  YUNWU_API_KEY: '', ANTHROPIC_API_KEY: '' });
const nativeFetch = globalThis.fetch;
const { db, q, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
initSchema(); migrateV2();
const credits = await import('../src/engines/credits.js');
const content = await import('../src/routes/content.js');
const media = await import('../src/routes/media-review.js');
const { read360Cost } = await import('../src/engines/provider-360-cost.js');
const model = 'alibaba/wan3.0-video';
let sequence = 0;
function actor() {
  const tenantId = Number(q.run("INSERT INTO tenants(name,status,credits) VALUES('视频专项企业','已开通',10000)").lastInsertRowid);
  const id = Number(q.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id,modules) VALUES(?,'unused','视频老板','boss','启用',?,'[\"content\"]')", `video360-owner-${++sequence}`, tenantId).lastInsertRowid);
  return { id, role: 'boss', name: '视频老板', tenant_id: tenantId };
}
function receipt(taskId, amount) {
  return read360Cost({ response: { id: taskId, model, usage: { amount: String(amount) } }, model });
}
function videoJob(user, taskId = `generic-task-${++sequence}`) {
  return runWithTenant(user.tenant_id, () => {
    const id = Number(q.run("INSERT INTO media_jobs(user_id,kind,model,prompt,status,task_id,snapshot_json) VALUES(?,'video',?,'火锅门店短片','处理中',?,'{}')", user.id, model, taskId).lastInsertRowid);
    const hold = credits.holdCredits({ userId: user.id, feature: '360通用视频测试', kind: 'video', model,
      credits: credits.estimateMaxCredits('video', model), refType: 'media_job', refId: id });
    return { job: q.get('SELECT * FROM media_jobs WHERE id=?', id), hold };
  });
}
const balance = user => credits.balanceOfTenant(user.tenant_id);
const rowFor = id => q.get('SELECT * FROM media_jobs WHERE id=?', id);
function snapshot(id) { return JSON.parse(rowFor(id).snapshot_json).genericVideoProvider; }
async function serverFor(user, action) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => { req.user = user; req.requestId = 'generic-video-http'; next(); }));
  app.use('/api/content', media.default, content.default);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    return await action(async (route, method = 'GET', body) => {
      const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/api/content${route}`, {
        method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
}
function providerResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

test('通用视频成功使用out.supplierCosts按实际2元收4元，不按900分预占报价结算', () => {
  const owner = actor(); const { job, hold } = videoJob(owner);
  runWithTenant(owner.tenant_id, () => {
    const bill = content.settleVideoJobSuccess(job, 'https://cdn.example.com/generic-success.mp4', {
      provider: '360', model, taskId: job.task_id, status: 'Success', supplierCosts: [receipt(job.task_id, 2)],
    });
    assert.equal(bill.state, 'settled'); assert.equal(bill.chargedCredits, 400); assert.equal(balance(owner), 9600);
    assert.equal(rowFor(job.id).credits, 400); assert.equal(rowFor(job.id).status, '成功');
    assert.equal(credits.getSupplierExpense(hold.holdId, owner.tenant_id).costYuan, 2);
    assert.equal(snapshot(job.id).supplierCosts[0].costSource.reportedAmount, '2');
    content.settleVideoJobSuccess(rowFor(job.id), 'https://cdn.example.com/generic-success.mp4', {
      provider: '360', taskId: job.task_id, status: 'Success', supplierCosts: [receipt(job.task_id, 2)],
    });
    assert.equal(balance(owner), 9600); assert.equal(snapshot(job.id).supplierCosts.length, 1);
  });
});

test('未知费用不收估价且保留视频：同企业有权者可预览下载，错误租户和不相干员工不放行', () => {
  const owner = actor(); const foreign = actor(); const { job, hold } = videoJob(owner);
  const url = 'https://cdn.example.com/generic-pending.mp4';
  runWithTenant(owner.tenant_id, () => {
    const bill = content.settleVideoJobSuccess(job, url, { provider: '360', model, taskId: job.task_id, status: 'Success',
      supplierCosts: [{ status: 'pending', requestId: null, model }] });
    assert.equal(bill.state, 'pending_reconciliation'); assert.equal(bill.chargedCredits, null);
    assert.equal(rowFor(job.id).credits, null); assert.equal(rowFor(job.id).url, url);
    assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', hold.holdId).status, 'held');
    const result = media.augmentMediaJob(rowFor(job.id), owner);
    assert.equal(result.previewUrl, url); assert.equal(result.downloadUrl, url); assert.equal(result.canExport, true);
    assert.equal(result.businessUsable, false); assert.equal(result.billing.pendingReconciliation, true);
    const stranger = { id: 9999999, tenant_id: owner.tenant_id, role: 'sales' };
    assert.equal(media.augmentMediaJob(rowFor(job.id), stranger).previewUrl, null);
    assert.equal(media.augmentMediaJob(rowFor(job.id), foreign).previewUrl, null);
    const tampered = { ...rowFor(job.id), url: 'javascript:alert(1)' };
    assert.equal(media.augmentMediaJob(tampered, owner).previewUrl, null);
    assert.equal(balance(owner), 10000 - hold.credits);
  });
  runWithTenant(foreign.tenant_id, () => {
    assert.equal(media.augmentMediaJob(rowFor(job.id), foreign).previewUrl, null);
    assert.throws(() => content.settleVideoJobSuccess(job, url, {}), error => error.status === 404);
  });
});

test('终态Fail全额退款并记供应商已扣成本，重复回填不重复退款', () => {
  const owner = actor(); const { job, hold } = videoJob(owner);
  runWithTenant(owner.tenant_id, () => {
    const bill = content.refundVideoJobFailure(job, '360视频没有产物', {
      provider: '360', model, taskId: job.task_id, status: 'Fail', supplierCosts: [receipt(job.task_id, 1.2)],
    });
    assert.equal(bill.state, 'released'); assert.equal(balance(owner), 10000);
    assert.equal(rowFor(job.id).status, '失败'); assert.equal(rowFor(job.id).credits, 0);
    const cost = credits.getSupplierExpense(hold.holdId, owner.tenant_id);
    assert.equal(cost.costYuan, 1.2); assert.equal(cost.refundedCredits, hold.credits);
    content.refundVideoJobFailure(rowFor(job.id)); assert.equal(balance(owner), 10000);
    assert.equal(snapshot(job.id).supplierCosts[0].costYuanOverride, 1.2);
  });
});

test('提交与轮询费用证据落snapshot，同一个回执不会算两次；HTTP入口真实调用适配器', async () => {
  const owner = actor(); const taskId = `http-async-${++sequence}`; let calls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input); assert.ok(url.startsWith('https://api.360.cn/v1/videos/async_generations'));
    assert.equal(init.headers.Authorization, 'Bearer generic-video-test-key'); calls++;
    if (init.method === 'POST') return providerResponse({ data: { id: taskId, model, status: 'processing', usage: { amount: '0.4' } } });
    return providerResponse({ data: { id: taskId, model, status: 'succeeded', url: 'https://cdn.example.com/http-async.mp4', usage: { amount: '0.4' } } });
  };
  try {
    await serverFor(owner, async request => {
      const submitted = await request('/generate-video', 'POST', { prompt: '火锅门店自然转场视频', model, employeeIdx: 5 });
      assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
      assert.equal(submitted.body.billing.state, 'held'); assert.equal(submitted.body.billing.credits, null);
      const id = submitted.body.jobId; assert.equal(snapshot(id).events[0].phase, 'submit');
      const listed = await request('/media-jobs?kind=video'); assert.equal(listed.status, 200);
      const output = listed.body.find(item => item.id === id);
      assert.equal(output.technicalStatus, '成功'); assert.equal(output.billing.chargedCredits, 80);
      assert.equal(snapshot(id).events.length, 2); assert.equal(snapshot(id).supplierCosts.length, 1);
      assert.equal(balance(owner), 9920); assert.equal(calls, 2);
    });
  } finally { globalThis.fetch = nativeFetch; }
});

test('360即时完成同样按真实费用结算，并向原页面返回可下载结果', async () => {
  const owner = actor(); const taskId = `http-instant-${++sequence}`;
  globalThis.fetch = async () => providerResponse({ data: { id: taskId, model, status: 'succeeded', url: 'https://cdn.example.com/instant.mp4', usage: { amount: '0.5' } } });
  try {
    await serverFor(owner, async request => {
      const result = await request('/generate-video', 'POST', { prompt: '餐厅门头短片', model, employeeIdx: 5 });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.billing.chargedCredits, 100); assert.equal(balance(owner), 9900);
      assert.equal(result.body.previewUrl, 'https://cdn.example.com/instant.mp4');
      assert.equal(result.body.downloadAvailable, true); assert.equal(result.body.canExport, true);
    });
  } finally { globalThis.fetch = nativeFetch; }
});

test('异步轮询Fail携带实际费用时，HTTP历史显示失败且用户全退，提交与失败回执均保留', async () => {
  const owner = actor(); const taskId = `http-failure-${++sequence}`;
  globalThis.fetch = async (_input, init = {}) => init.method === 'POST'
    ? providerResponse({ data: { id: taskId, model, status: 'processing' } })
    : providerResponse({ data: { id: taskId, model, status: 'failed', usage: { amount: '0.35' } } });
  try {
    await serverFor(owner, async request => {
      const submitted = await request('/generate-video', 'POST', { prompt: '餐馆晚市视频', model, employeeIdx: 5 });
      assert.equal(submitted.status, 200);
      const id = submitted.body.jobId;
      const listed = await request('/media-jobs?kind=video');
      const failed = listed.body.find(item => item.id === id);
      assert.equal(failed.technicalStatus, '失败'); assert.equal(failed.billing.state, 'released');
      assert.equal(failed.billing.chargedCredits, 0); assert.equal(balance(owner), 10000);
      assert.equal(snapshot(id).events.length, 2); assert.equal(snapshot(id).supplierCosts[0].costYuanOverride, 0.35);
      const hold = q.get("SELECT id FROM credit_holds WHERE tenant_id=? AND ref_type='media_job' AND ref_id=?", owner.tenant_id, id);
      assert.equal(credits.getSupplierExpense(hold.id, owner.tenant_id).costYuan, 0.35);
    });
  } finally { globalThis.fetch = nativeFetch; }
});

test('提交和终态出现同一回执不同金额时保留双方证据与视频，不能任选一个金额扣款', async () => {
  const owner = actor(); const taskId = `http-conflict-${++sequence}`;
  globalThis.fetch = async (_input, init = {}) => init.method === 'POST'
    ? providerResponse({ data: { id: taskId, model, status: 'processing', usage: { amount: '0.4' } } })
    : providerResponse({ data: { id: taskId, model, status: 'succeeded', url: 'https://cdn.example.com/conflicting-cost.mp4', usage: { amount: '0.8' } } });
  try {
    await serverFor(owner, async request => {
      const submitted = await request('/generate-video', 'POST', { prompt: '品牌餐馆视频', model, employeeIdx: 5 });
      const balanceHeld = balance(owner); const id = submitted.body.jobId;
      const listed = await request('/media-jobs?kind=video');
      const output = listed.body.find(item => item.id === id);
      assert.equal(output.technicalStatus, '成功'); assert.equal(output.billing.state, 'pending_reconciliation');
      assert.equal(output.billing.chargedCredits, null); assert.equal(balance(owner), balanceHeld);
      assert.equal(output.previewUrl, 'https://cdn.example.com/conflicting-cost.mp4');
      assert.deepEqual(snapshot(id).events.map(event => event.supplierCosts[0].costYuanOverride), [0.4, 0.8]);
      assert.ok(snapshot(id).supplierCosts.some(cost => cost.status === 'pending' && cost.reason === 'conflicting_receipt'));
    });
  } finally { globalThis.fetch = nativeFetch; }
});

test('成功但金额缺失的任务可继续查回执；后续已知金额完成结算，不重生成或重复扣款', async () => {
  const owner = actor(); const { job, hold } = videoJob(owner); const url = 'https://cdn.example.com/later-receipt.mp4';
  runWithTenant(owner.tenant_id, () => content.settleVideoJobSuccess(job, url, { provider: '360', model, taskId: job.task_id,
    supplierCosts: [{ status: 'pending', requestId: null, model }] }));
  let calls = 0;
  globalThis.fetch = async (input, init = {}) => {
    assert.notEqual(init.method, 'POST'); calls++;
    return providerResponse({ data: { id: job.task_id, model, status: 'succeeded', url, usage: { amount: '0.8' } } });
  };
  try {
    await runWithTenant(owner.tenant_id, () => content.refreshProcessingVideoJobs([rowFor(job.id)]));
    assert.equal(balance(owner), 9840); assert.equal(rowFor(job.id).credits, 160);
    assert.equal(snapshot(job.id).billing.state, 'settled'); assert.equal(snapshot(job.id).events.length, 2);
    assert.equal(snapshot(job.id).supplierCosts.length, 1);
    await runWithTenant(owner.tenant_id, () => content.refreshProcessingVideoJobs([rowFor(job.id)]));
    assert.equal(calls, 1); assert.equal(credits.getSupplierExpense(hold.holdId, owner.tenant_id).costYuan, 0.8);
  } finally { globalThis.fetch = nativeFetch; }
});

test('跨租户HTTP列表与详情不泄露已保存但待核费的视频', async () => {
  const owner = actor(); const outsider = actor(); const { job } = videoJob(owner);
  runWithTenant(owner.tenant_id, () => content.settleVideoJobSuccess(job, 'https://cdn.example.com/private-tenant.mp4', { provider: '360', model, taskId: job.task_id }));
  await serverFor(outsider, async request => {
    const detail = await request(`/media-jobs/${job.id}`); assert.equal(detail.status, 404);
    const list = await request('/media-jobs?kind=video'); assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.body).includes('private-tenant.mp4'));
  });
});

after(() => { globalThis.fetch = nativeFetch; db.close(); removeTempDbSafely(databasePath); });

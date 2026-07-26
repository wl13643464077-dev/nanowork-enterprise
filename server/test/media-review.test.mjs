import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-media-review-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* fresh test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { holdCredits, settleHold, releaseHold } = await import('../src/engines/credits.js');
const {
  default: mediaReviewRoutes,
  canReviewMedia,
  validateMediaDelivery,
} = await import('../src/routes/media-review.js');
const { default: contentRoutes } = await import('../src/routes/content.js');

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'媒体验收A企业','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(2,'媒体验收B企业','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);

function insertUser(tenantId, username, role, managerId = null) {
  return Number(q.run(`INSERT INTO users(
    username,password_hash,name,role,dept,status,tenant_id,manager_id
  ) VALUES(?,?,?,?,?,'启用',?,?)`,
  username, 'x', username, role, '内容部', tenantId, managerId).lastInsertRowid);
}

const managerId = insertUser(1, '媒体经理', 'manager');
const staffId = insertUser(1, '媒体员工', 'sales', managerId);
const bossId = insertUser(1, '媒体老板', 'boss');
const otherTenantBossId = insertUser(2, 'B企业老板', 'boss');
const manager = { id: managerId, name: '媒体经理', role: 'manager', tenant_id: 1 };
const staff = { id: staffId, name: '媒体员工', role: 'sales', tenant_id: 1 };
const boss = { id: bossId, name: '媒体老板', role: 'boss', tenant_id: 1 };
const otherTenantBoss = { id: otherTenantBossId, name: 'B企业老板', role: 'boss', tenant_id: 2 };

function insertJob(tenantId, userId, {
  kind = 'image',
  status = '成功',
  url = 'https://cdn.example.com/result.png',
  prompt = '真实菜品主图',
  model = 'media-test',
} = {}) {
  return runWithTenant(tenantId, () => Number(q.run(`INSERT INTO media_jobs(
    user_id,kind,model,prompt,status,url
  ) VALUES(?,?,?,?,?,?)`, userId, kind, model, prompt, status, url).lastInsertRowid));
}

function appFor(user, { withReviewLayer = true } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => {
    req.user = user;
    next();
  }));
  app.use('/content', ...(withReviewLayer ? [mediaReviewRoutes, contentRoutes] : [contentRoutes]));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  return app;
}

async function withServer(user, fn, options) {
  const server = appFor(user, options).listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function request(base, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

test('媒体人工验收角色和媒体交付地址使用白名单语义', () => {
  for (const role of ['manager', 'ops_director', 'boss', 'admin', 'platform_super', 'super_admin']) {
    assert.equal(canReviewMedia({ role }), true, role);
  }
  for (const role of ['sales', 'employee', 'partner', '', null]) {
    assert.equal(canReviewMedia({ role }), false, String(role));
  }

  assert.equal(validateMediaDelivery({ status: '成功', kind: 'image', url: 'https://cdn.example.com/a.png' }).ready, true);
  assert.equal(validateMediaDelivery({ status: '成功', kind: 'video', url: '/uploads/a.mp4' }).ready, true);
  assert.equal(validateMediaDelivery({ status: '处理中', kind: 'video', url: '/a.mp4' }).ready, false);
  assert.equal(validateMediaDelivery({ status: '成功', kind: 'image', url: 'javascript:alert(1)' }).ready, false);
  assert.match(validateMediaDelivery({ status: '成功', kind: 'image', url: '/a.mp4' }).reason, /声明为图片/);
});

test('员工只能看到技术成功与待人工验收，不能自行导入素材库', async () => {
  const jobId = insertJob(1, staff.id);
  await withServer(staff, async base => {
    const listed = await request(base, '/content/media-jobs?kind=image');
    assert.equal(listed.response.status, 200);
    const job = listed.data.find(row => row.id === jobId);
    assert.equal(job.technicalStatus, '成功');
    assert.equal(job.technicalSuccess, true);
    assert.equal(job.businessStatus, '待人工验收');
    assert.equal(job.businessUsable, false);
    assert.equal(job.canImport, false);
    assert.equal(job.mediaType, '图片');
    assert.equal(job.mimeType, 'image/png');
    assert.equal(job.urlAvailable, true);

    const blocked = await request(base, `/content/media-jobs/${jobId}/import-material`, {
      method: 'POST',
      body: {},
    });
    assert.equal(blocked.response.status, 403);
    assert.equal(blocked.data.canImport, false);
    assert.equal(blocked.data.requiredRole, 'manager');
  });
  assert.equal(q.get(`SELECT COUNT(*) n FROM materials
    WHERE tenant_id=1 AND source_type='media_job' AND source_id=?`, jobId).n, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets
    WHERE tenant_id=1 AND source_type='media_job' AND source_id=?`, jobId).n, 0);
});

test('单独挂载原 contentRoutes 时仍复用同一媒体人工验收门禁和入库处理器', async () => {
  const staffJobId = insertJob(1, staff.id, { prompt: '直接路由员工任务' });
  await withServer(staff, async base => {
    const blocked = await request(base, `/content/media-jobs/${staffJobId}/import-material`, {
      method: 'POST',
      body: {},
    });
    assert.equal(blocked.response.status, 403);
    assert.equal(blocked.data.requiredRole, 'manager');
  }, { withReviewLayer: false });

  const managedJobId = insertJob(1, staff.id, { prompt: '直接路由管理层验收任务' });
  await withServer(manager, async base => {
    const accepted = await request(base, `/content/media-jobs/${managedJobId}/import-material`, {
      method: 'POST',
      body: {},
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.data.reviewRecorded, true);
    assert.equal(accepted.data.businessUsable, true);
    assert.equal(accepted.data.reviewedBy, manager.name);
  }, { withReviewLayer: false });

  assert.equal(q.get(`SELECT COUNT(*) n FROM materials
    WHERE tenant_id=1 AND source_type='media_job' AND source_id=?`, managedJobId).n, 1);
  assert.equal(q.get(`SELECT COUNT(*) n FROM op_logs
    WHERE tenant_id=1 AND action='人工验收媒体素材' AND target LIKE ?`, `media_job#${managedJobId};%`).n, 1);
});

test('管理角色显式验收后幂等入库，并记录验收人、时间、来源和不可变快照', async () => {
  const jobId = insertJob(1, staff.id, {
    kind: 'video',
    url: 'https://cdn.example.com/final.mp4',
    prompt: '门店后厨真实工作流短视频',
  });
  await withServer(manager, async base => {
    const before = await request(base, '/content/media-jobs?kind=video');
    const pending = before.data.find(row => row.id === jobId);
    assert.equal(pending.canImport, true);
    assert.equal(pending.reviewRequired, true);
    assert.equal(pending.businessStatus, '待人工验收');

    const first = await request(base, `/content/media-jobs/${jobId}/import-material`, {
      method: 'POST',
      body: {},
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.data.existed, false);
    assert.equal(first.data.reviewRecorded, true);
    assert.equal(first.data.businessUsable, true);
    assert.equal(first.data.reviewStatus, '已人工验收并入库');
    assert.equal(first.data.reviewedBy, manager.name);
    assert.equal(first.data.mediaType, '视频');
    assert.equal(first.data.mimeType, 'video/mp4');

    const second = await request(base, `/content/media-jobs/${jobId}/import-material`, {
      method: 'POST',
      body: {},
    });
    assert.equal(second.response.status, 200);
    assert.equal(second.data.existed, true);
    assert.equal(second.data.reviewRecorded, false);

    const after = await request(base, `/content/media-jobs/${jobId}`);
    assert.equal(after.response.status, 200);
    assert.equal(after.data.businessUsable, true);
    assert.equal(after.data.canImport, false);
    assert.equal(after.data.isImported, true);
    assert.equal(after.data.reviewedBy, manager.name);
    assert.ok(after.data.reviewedAt);
  });

  const material = q.get(`SELECT * FROM materials
    WHERE tenant_id=1 AND source_type='media_job' AND source_id=?`, jobId);
  const artifact = JSON.parse(material.artifact_snapshot_json);
  assert.equal(artifact.manualReview.reviewedById, manager.id);
  assert.equal(artifact.manualReview.reviewedByRole, 'manager');
  assert.equal(artifact.manualReview.source, 'manager_manual_media_review');
  assert.equal(artifact.recognitionPerformed, false);
  assert.match(material.note, /人工验收入库/);
  assert.equal(q.get(`SELECT COUNT(*) n FROM materials
    WHERE tenant_id=1 AND source_type='media_job' AND source_id=?`, jobId).n, 1);
  assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets
    WHERE tenant_id=1 AND source_type='media_job' AND source_id=?`, jobId).n, 1);
  assert.equal(q.get(`SELECT COUNT(*) n FROM op_logs
    WHERE tenant_id=1 AND action='人工验收媒体素材' AND target LIKE ?`, `media_job#${jobId};%`).n, 1);
});

test('跨租户、失败、处理中、无地址和类型错配的任务均不能验收入库', async () => {
  const invalidJobs = [
    insertJob(1, staff.id, { status: '失败', url: '/failed.png' }),
    insertJob(1, staff.id, { kind: 'video', status: '处理中', url: '/running.mp4' }),
    insertJob(1, staff.id, { url: null }),
    insertJob(1, staff.id, { kind: 'image', url: '/wrong.mp4' }),
  ];
  const otherJob = insertJob(2, otherTenantBoss.id, { url: 'https://cdn.example.com/private.png' });
  await withServer(boss, async base => {
    for (const id of invalidJobs) {
      const result = await request(base, `/content/media-jobs/${id}/import-material`, {
        method: 'POST',
        body: {},
      });
      assert.equal(result.response.status, 409, String(id));
      assert.equal(result.data.canImport, false);
    }
    const hidden = await request(base, `/content/media-jobs/${otherJob}/import-material`, {
      method: 'POST',
      body: {},
    });
    assert.equal(hidden.response.status, 404);
  });
});

test('媒体任务响应按真实账务状态区分预授权、实扣、退款和待对账', async () => {
  const heldId = insertJob(1, staff.id, { kind: 'video', status: '处理中', url: null });
  const pendingId = insertJob(1, staff.id, { kind: 'video', status: '成功', url: '/pending.mp4' });
  const settledId = insertJob(1, staff.id, { kind: 'video', status: '成功', url: '/settled.mp4' });
  const releasedId = insertJob(1, staff.id, { kind: 'video', status: '失败', url: null });

  const held = runWithTenant(1, () => holdCredits({
    userId: staff.id, feature: '异步视频', kind: 'video', model: 'media-test', credits: 11,
    refType: 'media_job', refId: heldId,
  }));
  runWithTenant(1, () => holdCredits({
    userId: staff.id, feature: '结算异常视频', kind: 'video', model: 'media-test', credits: 12,
    refType: 'media_job', refId: pendingId,
  }));
  const settled = runWithTenant(1, () => holdCredits({
    userId: staff.id, feature: '即时视频', kind: 'video', model: 'media-test', credits: 13,
    refType: 'media_job', refId: settledId,
  }));
  runWithTenant(1, () => settleHold(settled, { credits: 13, model: 'media-test', note: '测试即时结算' }));
  const released = runWithTenant(1, () => holdCredits({
    userId: staff.id, feature: '失败视频', kind: 'video', model: 'media-test', credits: 14,
    refType: 'media_job', refId: releasedId,
  }));
  runWithTenant(1, () => releaseHold(released, '测试失败退款'));

  await withServer(staff, async base => {
    const listed = await request(base, '/content/media-jobs?kind=video');
    const byId = new Map(listed.data.map(row => [row.id, row]));
    assert.equal(byId.get(heldId).billing.state, 'held');
    assert.equal(byId.get(heldId).billing.heldCredits, 11);
    assert.equal(byId.get(heldId).billing.credits, null);

    assert.equal(byId.get(pendingId).billing.state, 'pending_reconciliation');
    assert.equal(byId.get(pendingId).billing.heldCredits, 12);
    assert.equal(byId.get(pendingId).billing.credits, null);
    assert.equal(byId.get(pendingId).billing.pendingReconciliation, true);

    assert.equal(byId.get(settledId).billing.state, 'settled');
    assert.equal(byId.get(settledId).billing.chargedCredits, 13);
    assert.equal(byId.get(settledId).billing.credits, 13);
    assert.equal(byId.get(settledId).billing.heldCredits, 0);

    assert.equal(byId.get(releasedId).billing.state, 'released');
    assert.equal(byId.get(releasedId).billing.chargedCredits, 0);
    assert.equal(byId.get(releasedId).billing.credits, 0);
    assert.equal(byId.get(releasedId).billing.heldCredits, 0);
  });
  assert.ok(held.holdId);
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore cleanup */ }
  }
});

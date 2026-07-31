import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-content-routes-two-phase-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';

const { db, qRaw, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
const { balanceOfTenant, releaseHold } = await import('../src/engines/credits.js');
const contentRoutes = (await import('../src/routes/content.js')).default;

initSchema();
migrateV2();

const tenantId = Number(qRaw.run(
  "INSERT INTO tenants(name,status,credits) VALUES('内容路由计费企业','已开通',500)",
).lastInsertRowid);
const userId = Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,tenant_id)
   VALUES('route-billing-u','x','内容路由计费用户','boss',?)`,
  tenantId,
).lastInsertRowid);
const user = { id: userId, name: '内容路由计费用户', role: 'boss', tenant_id: tenantId };
const contentLeaseEvents = [];

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, _res, next) => runWithTenant(tenantId, () => {
  req.user = user;
  req.aiGuard = {
    defer: timeoutMs => {
      const lease = { action: 'defer', timeoutMs, released: false };
      contentLeaseEvents.push(lease);
      return () => {
        if (lease.released) return;
        lease.released = true;
        contentLeaseEvents.push({ action: 'release', timeoutMs });
      };
    },
  };
  next();
}));
app.use('/content', contentRoutes);

const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

const post = async (route, body) => {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
};
const heldRows = () => db.prepare(
  `SELECT * FROM credit_holds WHERE tenant_id=? AND status='held' ORDER BY id`,
).all(tenantId);

test('同步文案与PPT先占扣后落库，模板降级按0分结算且不留悬挂占扣', async () => {
  const before = balanceOfTenant(tenantId);
  const copy = await post('/content/generate', {
    type: '朋友圈文案',
    topic: '两阶段同步文案验收',
    employeeIdx: 3,
  });
  assert.equal(copy.response.status, 200);
  assert.equal(copy.payload.billing.state, 'settled');
  assert.equal(copy.payload.billing.chargedCredits, 0);
  assert.equal(JSON.parse(db.prepare(
    'SELECT snapshot_json FROM contents WHERE tenant_id=? AND id=?',
  ).get(tenantId, copy.payload.id).snapshot_json).billing.state, 'settled');

  const ppt = await post('/content/generate-ppt', {
    topic: '两阶段PPT验收',
    pages: 5,
    employeeIdx: 7,
  });
  assert.equal(ppt.response.status, 200);
  assert.equal(ppt.payload.billing.state, 'settled');
  assert.equal(ppt.payload.billing.chargedCredits, 0);
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before);
});

test('实际内容落库事务失败时路由释放预授权且不留半成品', async () => {
  const before = balanceOfTenant(tenantId);
  db.exec(`CREATE TRIGGER injected_content_persist_failure
    BEFORE INSERT ON contents
    WHEN NEW.topic='强制落库失败'
    BEGIN
      SELECT RAISE(ABORT,'injected content persistence failure');
    END`);
  try {
    const failed = await post('/content/generate', {
      type: '朋友圈文案',
      topic: '强制落库失败',
      employeeIdx: 3,
    });
    assert.equal(failed.response.status, 500);
    assert.equal(failed.payload.billing.state, 'released');
    assert.equal(failed.payload.billing.chargedCredits, 0);
    assert.equal(db.prepare(
      `SELECT COUNT(*) n FROM contents WHERE tenant_id=? AND topic='强制落库失败'`,
    ).get(tenantId).n, 0);
    assert.equal(heldRows().length, 0);
    assert.equal(balanceOfTenant(tenantId), before);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_content_persist_failure');
  }
});

test('实际结算事务异常时内容仍交付，响应与持久快照明确待对账', async () => {
  const before = balanceOfTenant(tenantId);
  db.exec(`CREATE TRIGGER injected_content_settlement_failure
    BEFORE UPDATE OF status ON credit_holds
    WHEN OLD.feature='内容生产仓·朋友圈文案' AND OLD.status='held' AND NEW.status='settled'
    BEGIN
      SELECT RAISE(ABORT,'injected settlement failure');
    END`);
  let pendingHold;
  try {
    const pending = await post('/content/generate', {
      type: '朋友圈文案',
      topic: '结算异常仍需保留交付',
      employeeIdx: 3,
    });
    assert.equal(pending.response.status, 200, JSON.stringify(pending.payload));
    assert.equal(pending.payload.billing.state, 'pending_reconciliation');
    assert.equal(pending.payload.billing.chargedCredits, null);
    assert.ok(pending.payload.id);
    const row = db.prepare(
      'SELECT body,snapshot_json FROM contents WHERE tenant_id=? AND id=?',
    ).get(tenantId, pending.payload.id);
    assert.ok(row.body);
    assert.equal(JSON.parse(row.snapshot_json).billing.state, 'pending_reconciliation');
    [pendingHold] = heldRows();
    assert.ok(pendingHold);
    assert.equal(balanceOfTenant(tenantId), before - pendingHold.held_credits);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_content_settlement_failure');
    if (pendingHold) {
      releaseHold({
        holdId: pendingHold.id,
        logId: pendingHold.log_id,
        tenantId: pendingHold.tenant_id,
        userId: pendingHold.user_id,
        feature: pendingHold.feature,
        kind: pendingHold.kind,
        model: pendingHold.model,
        credits: pendingHold.held_credits,
        balance: balanceOfTenant(tenantId),
      }, '专项测试清理待对账占扣');
    }
  }
  assert.equal(balanceOfTenant(tenantId), before);
  assert.equal(heldRows().length, 0);
});

test('后台文案在返回jobId前已占扣，终态按模板0分结算且快照可对账', async () => {
  const before = balanceOfTenant(tenantId);
  const leaseBefore = contentLeaseEvents.length;
  const queued = await post('/content/generate', {
    type: '社群话题',
    topic: '后台两阶段计费验收',
    employeeIdx: 3,
    background: true,
  });
  assert.equal(queued.response.status, 200);
  assert.equal(queued.payload.background, true);
  assert.equal(queued.payload.billing.state, 'held');
  assert.ok(queued.payload.billing.heldCredits > 0);
  assert.equal(contentLeaseEvents.slice(leaseBefore).filter(event => event.action === 'defer').length, 1);
  const immediateJob = db.prepare(
    'SELECT status FROM media_jobs WHERE tenant_id=? AND id=?',
  ).get(tenantId, queued.payload.jobId);
  if (immediateJob.status === '处理中') {
    assert.equal(balanceOfTenant(tenantId), before - queued.payload.billing.heldCredits);
  } else {
    // setImmediate 可能在客户端读完响应体前已完成；此时以终态账本为准。
    assert.equal(immediateJob.status, '成功');
    assert.equal(balanceOfTenant(tenantId), before);
  }

  let job;
  for (let i = 0; i < 100; i++) {
    job = db.prepare(
      'SELECT * FROM media_jobs WHERE tenant_id=? AND id=?',
    ).get(tenantId, queued.payload.jobId);
    if (job?.status !== '处理中') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(job?.status, '成功');
  assert.ok(job.result_id);
  assert.equal(JSON.parse(job.snapshot_json).billing.state, 'settled');
  assert.equal(job.credits, 0);
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before);
  assert.equal(contentLeaseEvents.slice(leaseBefore).filter(event => event.action === 'release').length, 1);
});

test('日更包三个子任务分别结算并返回逐项可对账账本', async () => {
  const before = balanceOfTenant(tenantId);
  const daily = await post('/content/daily-pack', {
    topic: '日更逐子任务两阶段验收',
    employeeIdx: 3,
  });
  assert.equal(daily.response.status, 200, JSON.stringify(daily.payload));
  assert.equal(daily.payload.status, 'success');
  assert.equal(daily.payload.results.length, 3);
  assert.equal(daily.payload.billing.items.length, 3);
  assert.ok(daily.payload.billing.items.every(item => item.state === 'settled'));
  assert.ok(daily.payload.billing.items.every(item => item.chargedCredits === 0));
  assert.equal(daily.payload.billing.pendingReconciliation, 0);
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before);
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
  }
});

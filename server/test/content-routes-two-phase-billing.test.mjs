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

const { db, qRaw, initSchema, migrateV2, runWithTenant, setConfig } = await import('../src/db.js');
const { balanceOfTenant, releaseHold } = await import('../src/engines/credits.js');
const contentRoutes = (await import('../src/routes/content.js')).default;

initSchema();
migrateV2();

const tenantId = Number(qRaw.run(
  "INSERT INTO tenants(name,status,credits) VALUES('内容路由计费企业','已开通',10000)",
).lastInsertRowid);
const userId = Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,tenant_id)
   VALUES('route-billing-u','x','内容路由计费用户','boss',?)`,
  tenantId,
).lastInsertRowid);
const user = { id: userId, name: '内容路由计费用户', role: 'boss', tenant_id: tenantId };
const contentLeaseEvents = [];
let providerReturnsZeroUsage = true;

const providerApp = express();
providerApp.use(express.json({ limit: '2mb' }));
providerApp.post('/v1/chat/completions', (req, res) => {
  const requestText = JSON.stringify(req.body?.messages || []);
  const text = requestText.includes('只输出一个合法JSON对象')
    ? JSON.stringify({
        title: '零token PPT',
        subtitle: '仅用于账务门禁测试',
        pages: [{ title: '核心结论', bullets: ['事实待人工核验'], note: '不得外发' }],
      })
    : '【零token测试正文】供应商返回了非空内容，但没有可结算的 token 证据。';
  res.json({
    choices: [{ message: { content: text } }],
    usage: providerReturnsZeroUsage
      ? { prompt_tokens: 0, completion_tokens: 0 }
      : { prompt_tokens: 120, completion_tokens: 180 },
  });
});
const providerServer = providerApp.listen(0, '127.0.0.1');
const providerPort = await new Promise(resolve => {
  providerServer.once('listening', () => resolve(providerServer.address().port));
});
setConfig('yunwu_base_url', `http://127.0.0.1:${providerPort}/v1`);

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

test('同步文案与PPT先占扣，模板降级不得交付并全额释放占扣', async () => {
  const before = balanceOfTenant(tenantId);
  const contentBefore = db.prepare('SELECT COUNT(*) n FROM contents WHERE tenant_id=?').get(tenantId).n;
  const copy = await post('/content/generate', {
    type: '朋友圈文案',
    topic: '两阶段同步文案验收',
    employeeIdx: 3,
  });
  assert.equal(copy.response.status, 409);
  assert.match(copy.payload.error, /模板|降级|不是真实可交付/u);
  assert.equal(copy.payload.billing.state, 'released');
  assert.equal(copy.payload.billing.chargedCredits, 0);
  assert.equal(copy.payload.id, undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM contents WHERE tenant_id=?').get(tenantId).n, contentBefore);

  const ppt = await post('/content/generate-ppt', {
    topic: '两阶段PPT验收',
    pages: 5,
    employeeIdx: 7,
  });
  assert.equal(ppt.response.status, 409);
  assert.equal(ppt.payload.billing.state, 'released');
  assert.equal(ppt.payload.billing.chargedCredits, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM contents WHERE tenant_id=?').get(tenantId).n, contentBefore);
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before);
});

test('内容、PPT与日更包 API 返回正文但 usage 为0时，均在持久化前失败关闭', async () => {
  const before = balanceOfTenant(tenantId);
  const contentBefore = db.prepare('SELECT COUNT(*) n FROM contents WHERE tenant_id=?')
    .get(tenantId).n;
  process.env.YUNWU_API_KEY = 'sk-local-content-zero-usage-test';
  providerReturnsZeroUsage = true;
  try {
    const copy = await post('/content/generate', {
      type: '朋友圈文案',
      topic: '同步文案零token',
      employeeIdx: 3,
    });
    assert.equal(copy.response.status, 409, JSON.stringify(copy.payload));
    assert.equal(copy.payload.billing.state, 'released');

    const ppt = await post('/content/generate-ppt', {
      topic: 'PPT零token',
      pages: 3,
      employeeIdx: 7,
    });
    assert.equal(ppt.response.status, 409, JSON.stringify(ppt.payload));
    assert.equal(ppt.payload.billing.state, 'released');

    const daily = await post('/content/daily-pack', {
      topic: '日更包零token',
      employeeIdx: 3,
    });
    assert.equal(daily.response.status, 502, JSON.stringify(daily.payload));
    assert.equal(daily.payload.status, 'failed');
    assert.equal(daily.payload.results.length, 0);
    assert.equal(daily.payload.failures.length, 3);
    assert.ok(daily.payload.failures.every(item => item.billing.state === 'released'));

    assert.equal(db.prepare('SELECT COUNT(*) n FROM contents WHERE tenant_id=?')
      .get(tenantId).n, contentBefore);
    assert.equal(heldRows().length, 0);
    assert.equal(balanceOfTenant(tenantId), before);
  } finally {
    process.env.YUNWU_API_KEY = '';
    providerReturnsZeroUsage = true;
  }
});

test('自定义内容类型没有内置提示词代码时仍走通用契约，不向SQLite绑定undefined', async () => {
  const before = balanceOfTenant(tenantId);
  const contentBefore = db.prepare('SELECT COUNT(*) n FROM contents WHERE tenant_id=?').get(tenantId).n;
  const generated = await post('/content/generate', {
    type: '经营复盘文案',
    topic: '自定义类型验收',
    requirement: '只整理已知事实，未知项标记待确认。',
    employeeIdx: 3,
  });
  assert.equal(generated.response.status, 409, JSON.stringify(generated.payload));
  assert.doesNotMatch(String(generated.payload.error || ''), /SQLite|cannot be bound/iu);
  assert.equal(generated.payload.billing.state, 'released');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM contents WHERE tenant_id=?').get(tenantId).n, contentBefore);
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
  process.env.YUNWU_API_KEY = 'sk-local-content-settlement-test';
  providerReturnsZeroUsage = false;
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
    process.env.YUNWU_API_KEY = '';
    providerReturnsZeroUsage = true;
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

test('后台文案在返回jobId前已占扣，模板终态必须失败并退回预授权', async () => {
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
    assert.equal(immediateJob.status, '失败');
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
  assert.equal(job?.status, '失败');
  assert.equal(job.result_id, null);
  assert.equal(JSON.parse(job.snapshot_json).billing.state, 'released');
  assert.equal(job.credits, 0);
  // 失败记录写入与退款在后台同一条链路上，轮询至“失败 + 无 held”再判定退款完成。
  for (let i = 0; i < 100 && heldRows().length; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before);
  assert.equal(contentLeaseEvents.slice(leaseBefore).filter(event => event.action === 'release').length, 1);
});

test('日更包逐项结算，模板子任务全部失败且逐项退款', async () => {
  const before = balanceOfTenant(tenantId);
  const leaseBefore = contentLeaseEvents.length;
  const daily = await post('/content/daily-pack', {
    topic: '日更逐子任务两阶段验收',
    employeeIdx: 3,
  });
  assert.equal(daily.response.status, 502, JSON.stringify(daily.payload));
  assert.equal(daily.payload.status, 'failed');
  assert.equal(daily.payload.results.length, 0);
  assert.equal(daily.payload.failures.length, 3);
  assert.ok(daily.payload.failures.every(item => item.billing.state === 'released'));
  assert.equal(daily.payload.billing.items.length, 3);
  assert.deepEqual(daily.payload.billing.items.map(item => item.type), [
    '短视频脚本',
    '朋友圈文案',
    '社群话题',
  ]);
  assert.equal(daily.payload.billing.items.filter(item => item.state === 'released').length, 3);
  assert.ok(daily.payload.billing.items.every(item => item.chargedCredits === 0));
  assert.equal(daily.payload.summary.producedItems, 0);
  assert.equal(daily.payload.billing.pendingReconciliation, 0);
  assert.equal(daily.payload.billing.balance, before, '并发结算后必须返回企业最终余额，不能取某个子任务的中间余额');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM biz_assets
    WHERE tenant_id=? AND source_type='content'`).get(tenantId).n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM kb_docs
    WHERE tenant_id=? AND source_type='content'`).get(tenantId).n, 0);
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before);
  const lease = contentLeaseEvents.slice(leaseBefore);
  assert.equal(lease.filter(event => event.action === 'defer').length, 1);
  assert.ok(
    lease.find(event => event.action === 'defer').timeoutMs >= 1_260_000,
    '两个并发worker的请求租约必须覆盖两波上游及备用通道终态',
  );
  assert.equal(lease.filter(event => event.action === 'release').length, 1);
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => providerServer.close(resolve));
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
  }
});

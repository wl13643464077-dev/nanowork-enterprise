import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `nanowork-kb-vector-backfill-${process.pid}.db`);
for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}

process.env.NANOWORK_DB = dbPath;
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';
process.env.BACKGROUND_EMBED_MAX_CALLS_PER_DOC = '2';
process.env.BACKGROUND_EMBED_CREDITS_PER_CALL = '1';
process.env.YUNWU_API_KEY = 'test-only-kb-vector-backfill';
process.env.YUNWU_BASE_URL = 'https://offline.invalid/v1';

const originalFetch = global.fetch;
const {
  db,
  initSchema,
  migrateV2,
  qRaw,
  runWithTenant,
  setConfig,
} = await import('../src/db.js');
const systemRoutes = (await import('../src/routes/system.js')).default;

initSchema();
migrateV2();
const tenantId = Number(qRaw.run(
  "INSERT INTO tenants(name,status,credits) VALUES('知识向量回填测试企业','已开通',100)",
).lastInsertRowid);
const userId = Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
   VALUES('kb-vector-owner','x','知识库老板','boss','启用',?)`,
  tenantId,
).lastInsertRowid);
let requestUser = {
  id: userId,
  name: '知识库老板',
  role: 'boss',
  tenant_id: tenantId,
};

qRaw.run(`INSERT INTO kb_docs(tenant_id,category,title,body,enabled,embedding)
  VALUES(?,?,?,?,1,?)`, tenantId, '品牌资料', '已向量知识', '已向量正文', JSON.stringify([1, 0]));
qRaw.run(`INSERT INTO kb_docs(tenant_id,category,title,body,enabled,embedding)
  VALUES(?,?,?,?,1,NULL)`, tenantId, '品牌资料', '待回填知识甲', '待回填正文甲');
qRaw.run(`INSERT INTO kb_docs(tenant_id,category,title,body,enabled,embedding)
  VALUES(?,?,?,?,1,NULL)`, tenantId, '品牌资料', '待回填知识乙', '待回填正文乙');
qRaw.run(`INSERT INTO kb_docs(tenant_id,category,title,body,enabled,embedding)
  VALUES(?,?,?,?,0,NULL)`, tenantId, '品牌资料', '停用知识', '停用正文');
setConfig('yunwu_base_url', 'https://offline.invalid/v1');

const app = express();
app.use(express.json());
app.use((req, _res, next) => runWithTenant(tenantId, () => {
  req.user = requestUser;
  next();
}));
app.use('/sys', systemRoutes);
const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

async function call(url, { method = 'GET', body } = {}) {
  const response = await originalFetch(`${base}${url}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function waitFor(check, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('等待后台向量任务完成超时');
}

test('知识库就绪度区分已入库与已向量化，开关关闭时回填严格拒绝且零调用', async () => {
  let providerCalls = 0;
  global.fetch = async () => {
    providerCalls += 1;
    return { ok: true, json: async () => ({ data: [{ embedding: [0.5, 0.5] }] }) };
  };

  const readiness = await call('/sys/kb/readiness');
  assert.equal(readiness.response.status, 200);
  assert.deepEqual(readiness.payload.vector, {
    state: 'disabled',
    message: '后台向量化开关未启用，2 条知识只完成入库、尚不能参与语义召回',
    backgroundEnabled: false,
    enabledDocs: 3,
    vectorizedDocs: 1,
    missingDocs: 2,
    percent: 33,
    activeDocs: 0,
    activeJobs: 0,
    reconciliationDocs: 0,
    reconciliationJobs: 0,
    availableForBackfill: 2,
    canBackfill: false,
    providerConfigured: true,
  });

  const missingConfirmation = await call('/sys/kb/vector/backfill', {
    method: 'POST', body: { limit: 10 },
  });
  assert.equal(missingConfirmation.response.status, 400);

  const disabled = await call('/sys/kb/vector/backfill', {
    method: 'POST', body: { confirm: true, limit: 10 },
  });
  assert.equal(disabled.response.status, 409);
  assert.match(disabled.payload.error, /ENABLE_BACKGROUND_EMBEDDINGS=true/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM kb_embedding_jobs').get().n, 0);
  const holdTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_holds'",
  ).get();
  if (holdTable) {
    assert.equal(db.prepare("SELECT COUNT(*) n FROM credit_holds WHERE ref_type='kb_embedding'").get().n, 0);
  }
  assert.equal(providerCalls, 0);

  requestUser = { ...requestUser, role: 'ops_director' };
  const forbidden = await call('/sys/kb/vector/backfill', {
    method: 'POST', body: { confirm: true, limit: 1 },
  });
  assert.equal(forbidden.response.status, 403);
  requestUser = { ...requestUser, role: 'boss' };
});

test('显式开启后老板可分批回填，响应不回传正文且任务按真实持久化数结算', async () => {
  process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'true';
  let providerCalls = 0;
  global.fetch = async url => {
    assert.match(String(url), /^https:\/\/offline\.invalid\/v1\/embeddings$/);
    providerCalls += 1;
    return {
      ok: true,
      json: async () => ({ data: [{ embedding: [providerCalls, 0.25] }] }),
    };
  };

  const first = await call('/sys/kb/vector/backfill', {
    method: 'POST', body: { confirm: true, limit: 1 },
  });
  assert.equal(first.response.status, 202, JSON.stringify(first.payload));
  assert.equal(first.payload.accepted, 1);
  assert.equal(first.payload.rejected, 0);
  assert.equal(first.payload.results.length, 1);
  assert.doesNotMatch(JSON.stringify(first.payload), /待回填知识|待回填正文/);
  await waitFor(() => db.prepare(
    `SELECT COUNT(*) n FROM kb_embedding_jobs
     WHERE tenant_id=? AND status='settled'`,
  ).get(tenantId).n === 1);

  const second = await call('/sys/kb/vector/backfill', {
    method: 'POST', body: { confirm: true, limit: 10 },
  });
  assert.equal(second.response.status, 202, JSON.stringify(second.payload));
  assert.equal(second.payload.accepted, 1);
  await waitFor(() => db.prepare(
    `SELECT COUNT(*) n FROM kb_embedding_jobs
     WHERE tenant_id=? AND status='settled'`,
  ).get(tenantId).n === 2);

  const readiness = await call('/sys/kb/readiness');
  assert.equal(readiness.payload.vector.state, 'ready');
  assert.equal(readiness.payload.vector.enabledDocs, 3);
  assert.equal(readiness.payload.vector.vectorizedDocs, 3);
  assert.equal(readiness.payload.vector.missingDocs, 0);
  assert.equal(readiness.payload.vector.percent, 100);
  assert.equal(readiness.payload.vector.canBackfill, false);
  assert.equal(providerCalls, 2);
  assert.equal(db.prepare(
    "SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=? AND ref_type='kb_embedding' AND status='held'",
  ).get(tenantId).n, 0);
  assert.equal(db.prepare('SELECT credits FROM tenants WHERE id=?').get(tenantId).credits, 98);
});

after(async () => {
  global.fetch = originalFetch;
  await new Promise(resolve => server.close(resolve));
  try { db.close(); } catch {}
  delete process.env.ENABLE_BACKGROUND_EMBEDDINGS;
  delete process.env.YUNWU_API_KEY;
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

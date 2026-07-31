import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `nanowork-rag-billing-${process.pid}.db`);
for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = dbPath;
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'true';
process.env.BACKGROUND_EMBED_MAX_CALLS_PER_DOC = '4';
process.env.BACKGROUND_EMBED_CREDITS_PER_CALL = '1';
process.env.BACKGROUND_EMBED_JOB_TIMEOUT_MS = '10000';
process.env.BACKGROUND_EMBED_QUEUE_WAIT_TIMEOUT_MS = '30';
process.env.AI_MAX_CONCURRENT = '1';
process.env.YUNWU_API_KEY = 'test-only-never-sent';
process.env.YUNWU_BASE_URL = 'https://offline.invalid/v1';

const originalFetch = global.fetch;
const { initSchema, migrateV2, db, q, runWithTenant } = await import('../src/db.js');
const {
  embedDoc,
  recoverStaleEmbeddingHolds,
} = await import('../src/engines/rag.js');
const { acquireBackgroundAiLease } = await import('../src/ai-limits.js');
const { holdCredits, releaseHold } = await import('../src/engines/credits.js');

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits)
  VALUES(1,'RAG计费测试租户','已开通',100)
  ON CONFLICT(id) DO UPDATE SET credits=100,status='已开通'`);
const user = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, `rag-billing-${process.pid}`, 'test-hash', 'RAG计费用户', 'boss', '启用', 1);

const addDoc = (title, body) => q.run(
  'INSERT INTO kb_docs(category,title,body,enabled) VALUES(?,?,?,1)',
  '品牌资料',
  title,
  body,
).lastInsertRowid;

test('中央 schema 注册向量任务表，scoped 查询按租户隔离', () => {
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='kb_embedding_jobs'`).get());
  q.run(`INSERT INTO tenants(id,name,status,credits)
    VALUES(2,'RAG隔离测试租户','已开通',100)
    ON CONFLICT(id) DO UPDATE SET status='已开通',credits=100`);
  db.prepare(`INSERT INTO kb_embedding_jobs(
    tenant_id,doc_id,status,planned_calls,credits_per_call
  ) VALUES(1,900001,'settled',1,1),(2,900002,'settled',1,1)`).run();
  assert.equal(runWithTenant(1, () => q.scopedCount('kb_embedding_jobs')), 1);
  assert.equal(runWithTenant(2, () => q.scopedCount('kb_embedding_jobs')), 1);
});

test('后台向量入队前预授权，成功后按实际持久化调用数结算且不超过单文档上限', async () => {
  let providerCalls = 0;
  global.fetch = async () => {
    providerCalls += 1;
    return {
      ok: true,
      json: async () => ({ data: [{ embedding: [providerCalls, 0.25] }] }),
    };
  };
  const body = Array.from(
    { length: 20 },
    (_, index) => `经营资料第${index + 1}段。${'门店流程与指标说明。'.repeat(50)}`,
  ).join('\n\n');
  const id = addDoc('长文向量计费', body);

  const queued = runWithTenant(1, () => embedDoc(
    id,
    '长文向量计费',
    body,
    { userId: user.lastInsertRowid },
  ));
  assert.equal(queued.accepted, true);
  assert.equal(queued.callsPlanned, 4);
  assert.equal(queued.billing.state, 'held');

  const completed = await queued.completion;
  assert.equal(completed.error, null);
  assert.equal(completed.attemptedCalls, 4);
  assert.equal(completed.persistedCalls, 4);
  assert.equal(completed.billing.state, 'settled');
  assert.equal(completed.billing.chargedCredits, 4);
  assert.equal(providerCalls, 4);
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, 96);
  assert.equal(q.get(`SELECT COUNT(*) count FROM kb_chunks WHERE doc_id=?`, id).count, 3);
});

test('调用点仍在业务事务内时延迟到提交后占额，避免嵌套事务破坏主业务落库', async () => {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ embedding: [0.5, 0.5] }] }),
  });
  db.exec('BEGIN IMMEDIATE');
  let queued;
  try {
    const body = '事务内新增的知识正文';
    const id = addDoc('事务后向量化', body);
    queued = runWithTenant(1, () => embedDoc(id, '事务后向量化', body));
    assert.equal(queued.accepted, true);
    assert.equal(queued.deferred, true);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  const completed = await queued.completion;
  assert.equal(completed.persistedCalls, 1);
  assert.equal(completed.billing.state, 'settled');
});

test('供应商首调用失败立即停止剩余分块并全额释放预授权', async () => {
  const before = q.get('SELECT credits FROM tenants WHERE id=1').credits;
  let providerCalls = 0;
  global.fetch = async () => {
    providerCalls += 1;
    return {
      ok: false,
      status: 503,
      json: async () => ({ error: { message: 'offline fixture failure' } }),
    };
  };
  const body = `${'失败后不应继续调用。'.repeat(1000)}\n\n${'第二块。'.repeat(1000)}`;
  const id = addDoc('失败释放测试', body);
  const queued = runWithTenant(1, () => embedDoc(id, '失败释放测试', body));
  assert.equal(queued.accepted, true, JSON.stringify(queued));

  const completed = await queued.completion;
  assert.equal(completed.attemptedCalls, 1);
  assert.equal(completed.persistedCalls, 0);
  assert.equal(completed.billing.state, 'released');
  assert.equal(completed.billing.chargedCredits, 0);
  assert.equal(providerCalls, 1);
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, before);
});

test('长期拿不到共享 AI 租约时排队超时并释放预授权，供应商零调用', async () => {
  const blockingLease = acquireBackgroundAiLease({ kind: 'blocking-integration-test' });
  assert.ok(blockingLease);
  const before = q.get('SELECT credits FROM tenants WHERE id=1').credits;
  let providerCalls = 0;
  global.fetch = async () => {
    providerCalls += 1;
    return { ok: true, json: async () => ({ data: [{ embedding: [1] }] }) };
  };
  const body = '租约等待超时测试';
  const id = addDoc('租约等待超时测试', body);
  const queued = runWithTenant(1, () => embedDoc(id, '租约等待超时测试', body));
  assert.equal(queued.accepted, true);
  assert.equal(queued.billing.state, 'held');

  const completed = await queued.completion;
  assert.equal(completed.billing.state, 'released');
  assert.match(completed.error, /租约等待超时/);
  assert.equal(providerCalls, 0);
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, before);
  blockingLease.release();
});

test('重启恢复只处理足够陈旧的 hold：无产物全退，有产物按持久化数结算', () => {
  const createHeldJob = ({
    title,
    persistedCalls = 0,
    stale = true,
    withOutput = false,
  }) => {
    const docId = addDoc(title, `${title}正文`);
    if (withOutput) q.run('UPDATE kb_docs SET embedding=? WHERE id=?', JSON.stringify([0.1, 0.2]), docId);
    const jobId = Number(db.prepare(`INSERT INTO kb_embedding_jobs(
      tenant_id,doc_id,status,planned_calls,credits_per_call,persisted_calls
    ) VALUES(1,?,'running',4,1,?)`).run(docId, persistedCalls).lastInsertRowid);
    const hold = runWithTenant(1, () => holdCredits({
      tenantId: 1,
      userId: user.lastInsertRowid,
      feature: '知识库后台向量化',
      kind: 'text',
      model: 'text-embedding-3-small',
      credits: 4,
      refType: 'kb_embedding',
      refId: jobId,
    }));
    db.prepare('UPDATE kb_embedding_jobs SET hold_id=? WHERE tenant_id=1 AND id=?')
      .run(hold.holdId, jobId);
    if (stale) {
      db.prepare(`UPDATE credit_holds SET created_at=datetime('now','localtime','-30 minutes') WHERE id=?`)
        .run(hold.holdId);
    }
    return { docId, jobId, hold };
  };

  const before = q.get('SELECT credits FROM tenants WHERE id=1').credits;
  const empty = createHeldJob({ title: '重启无产物' });
  const delivered = createHeldJob({
    title: '重启已有产物',
    persistedCalls: 1,
    withOutput: true,
  });
  const recent = createHeldJob({ title: '近期任务不恢复', stale: false });
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, before - 12);

  const recovered = recoverStaleEmbeddingHolds({ staleMinutes: 5 });
  assert.equal(recovered.find(item => item.jobId === empty.jobId)?.action, 'released');
  assert.equal(recovered.find(item => item.jobId === delivered.jobId)?.action, 'settled');
  assert.equal(recovered.find(item => item.jobId === delivered.jobId)?.chargedCredits, 1);
  assert.equal(recovered.some(item => item.jobId === recent.jobId), false);
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, before - 5);
  assert.equal(
    q.get('SELECT status FROM credit_holds WHERE id=?', empty.hold.holdId).status,
    'settled',
  );
  assert.equal(
    q.get('SELECT settled_credits FROM credit_holds WHERE id=?', delivered.hold.holdId).settled_credits,
    1,
  );
  assert.equal(
    q.get('SELECT status FROM credit_holds WHERE id=?', recent.hold.holdId).status,
    'held',
  );

  runWithTenant(1, () => releaseHold(recent.hold, '测试清理近期任务占扣'));
  q.run('UPDATE tenants SET credits=? WHERE id=1', before - 1);
});

test('余额不足时在入队和供应商调用前明确拒绝', () => {
  q.run('UPDATE tenants SET credits=0 WHERE id=1');
  let providerCalls = 0;
  global.fetch = async () => {
    providerCalls += 1;
    return { ok: true, json: async () => ({ data: [{ embedding: [1] }] }) };
  };
  const body = '余额不足时不得调用供应商';
  const id = addDoc('预授权拒绝测试', body);
  const result = runWithTenant(1, () => embedDoc(id, '预授权拒绝测试', body));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'billing_hold_failed');
  assert.equal(result.status, 402);
  assert.equal(providerCalls, 0);
});

after(() => {
  global.fetch = originalFetch;
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

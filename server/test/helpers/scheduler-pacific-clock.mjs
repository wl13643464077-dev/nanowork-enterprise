import assert from 'node:assert/strict';

// Standalone subprocess fixture: isolation is established before dynamic imports.
process.env.NANOWORK_DB = ':memory:';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NODE_ENV = 'test';
process.env.ENABLE_SCHEDULER = 'false';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';
process.env.SEED_DEMO = 'false';
for (const key of ['YUNWU_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) process.env[key] = '';
const { db, initSchema, migrateV2, q, runWithTenant } = await import('../../src/db.js');
const { recoverStaleMediaJobs } = await import('../../src/engines/scheduler.js');
try {
  const databaseFile = db.prepare('PRAGMA database_list').get().file;
  assert.equal(databaseFile, '');
  const now = new Date('2026-07-23T02:00:00.000Z');
  const sqliteNow = db.prepare("SELECT datetime(?,'localtime') value").get(now.toISOString()).value;
  // Independent fixed expectation catches accidentally running this on Shanghai
  // time instead of weakening the non-Shanghai recovery regression.
  assert.equal(sqliteNow, '2026-07-22 19:00:00');
  initSchema();
  migrateV2();
  q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'PDT隔离企业','已开通',10000)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,credits=excluded.credits`);
  const creatorId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES('pacific-owner','x','时钟隔离测试','boss','启用',1)`).lastInsertRowid);
  const insertJob = (createdAt) => runWithTenant(1, () => Number(q.run(
    `INSERT INTO media_jobs(user_id,kind,model,prompt,status,created_at)
     VALUES(?,'image','gpt-image-2','PDT恢复测试','处理中',?)`, creatorId, createdAt,
  ).lastInsertRowid));
  const freshJobId = insertJob('2026-07-22 18:50:00');
  const staleJobId = insertJob('2026-07-22 18:00:00');
  const recovered = runWithTenant(1, () => recoverStaleMediaJobs(now));
  assert.equal(recovered.some(item => item.jobId === freshJobId), false);
  assert.equal(recovered.some(item => item.jobId === staleJobId), true);
  const freshStatus = q.get('SELECT status FROM media_jobs WHERE id=?', freshJobId).status;
  const staleStatus = q.get('SELECT status FROM media_jobs WHERE id=?', staleJobId).status;
  assert.equal(freshStatus, '处理中');
  assert.equal(staleStatus, '失败');
  console.log(JSON.stringify({ sqliteNow, freshStatus, staleStatus, databaseFile }));
} finally {
  db.close();
}

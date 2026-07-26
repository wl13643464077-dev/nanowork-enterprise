import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-content-kb-provenance-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* fresh database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { syncContentToKb } = await import('../src/engines/kbsync.js');
const contentRoutes = (await import('../src/routes/content.js')).default;
const systemRoutes = (await import('../src/routes/system.js')).default;

initSchema();
migrateV2();

q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'知识来源A企业','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(2,'知识来源B企业','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);

function insertUser(tenantId, username, name) {
  return Number(q.run(`INSERT INTO users(
    username,password_hash,name,role,dept,status,tenant_id
  ) VALUES(?,?,?,'boss','老板办','启用',?)`,
  username, 'x', name, tenantId).lastInsertRowid);
}

const bossA = {
  id: insertUser(1, 'kb-source-boss-a', 'A企业老板'),
  name: 'A企业老板',
  role: 'boss',
  tenant_id: 1,
};
const bossB = {
  id: insertUser(2, 'kb-source-boss-b', 'B企业老板'),
  name: 'B企业老板',
  role: 'boss',
  tenant_id: 2,
};

function insertContent(tenantId, creatorId, title, body = `${title}正文`) {
  return runWithTenant(tenantId, () => Number(q.run(`INSERT INTO contents(
    type,title,body,topic,status,risk_flags,risk_level,creator_id
  ) VALUES('朋友圈文案',?,?,?,'可使用','[]','none',?)`,
  title, body, '知识来源闭环', creatorId).lastInsertRowid));
}

function syncContent(tenantId, contentId, title, body = `${title}正文`) {
  return runWithTenant(tenantId, () => syncContentToKb({
    contentId,
    type: '朋友圈文案',
    title,
    topic: '知识来源闭环',
    body,
  }));
}

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => {
    req.user = user;
    next();
  }));
  app.use('/content', contentRoutes);
  app.use('/sys', systemRoutes);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function jsonRequest(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

const flushEmbedding = () => new Promise(resolve => setTimeout(resolve, 30));

test('来源迁移与唯一索引：同标题不同内容分别沉淀，同一内容幂等，租户互不串扰', async () => {
  const columns = db.prepare(`PRAGMA table_info(kb_docs)`).all().map(column => column.name);
  assert.ok(columns.includes('source_type'));
  assert.ok(columns.includes('source_id'));
  assert.ok(db.prepare(`SELECT name FROM sqlite_master
    WHERE type='index' AND name='idx_kb_docs_tenant_source'`).get());

  const legacyContentId = insertContent(1, bossA.id, '旧库唯一文案', '旧库可核对正文');
  const legacyDocId = Number(runWithTenant(1, () => q.run(`INSERT INTO kb_docs(
    category,title,body,enabled
  ) VALUES('话术案例','[朋友圈文案] 旧库唯一文案','旧库可核对正文',1)`).lastInsertRowid));
  migrateV2();
  assert.deepEqual(
    { ...q.get(`SELECT source_type,source_id FROM kb_docs WHERE tenant_id=1 AND id=?`, legacyDocId) },
    { source_type: 'content', source_id: legacyContentId },
  );

  const firstId = insertContent(1, bossA.id, '同名活动文案', 'A企业第一份正文');
  const secondId = insertContent(1, bossA.id, '同名活动文案', 'A企业第二份正文');
  assert.equal(syncContent(1, firstId, '同名活动文案', 'A企业第一份正文'), '话术案例');
  assert.equal(syncContent(1, secondId, '同名活动文案', 'A企业第二份正文'), '话术案例');
  assert.equal(syncContent(1, firstId, '同名活动文案', '不应覆盖原正文'), '话术案例');
  const duplicateLegacyDocId = Number(runWithTenant(1, () => q.run(`INSERT INTO kb_docs(
    category,title,body,enabled
  ) VALUES('话术案例','[朋友圈文案] 同名活动文案','A企业第一份正文',1)`).lastInsertRowid));
  assert.doesNotThrow(() => migrateV2());
  assert.deepEqual(
    { ...q.get(`SELECT source_type,source_id FROM kb_docs WHERE tenant_id=1 AND id=?`, duplicateLegacyDocId) },
    { source_type: null, source_id: null },
  );

  const tenantARows = q.all(`SELECT source_id,title,body FROM kb_docs
    WHERE tenant_id=1 AND source_type='content' AND source_id IN (?,?) ORDER BY source_id`,
  firstId, secondId);
  assert.equal(tenantARows.length, 2);
  assert.deepEqual(tenantARows.map(row => row.body), ['A企业第一份正文', 'A企业第二份正文']);
  assert.deepEqual(new Set(tenantARows.map(row => row.title)).size, 1);

  const tenantBContentId = insertContent(2, bossB.id, '同名活动文案', 'B企业独立正文');
  assert.equal(syncContent(2, tenantBContentId, '同名活动文案', 'B企业独立正文'), '话术案例');
  assert.equal(q.get(`SELECT COUNT(*) n FROM kb_docs
    WHERE tenant_id=1 AND source_type='content'`).n, 3);
  assert.equal(q.get(`SELECT COUNT(*) n FROM kb_docs
    WHERE tenant_id=2 AND source_type='content' AND source_id=?`, tenantBContentId).n, 1);

  assert.throws(() => runWithTenant(1, () => q.run(`INSERT INTO kb_docs(
    category,title,body,source_type,source_id,enabled
  ) VALUES('话术案例','重复来源','重复','content',?,1)`, firstId)), /UNIQUE constraint failed/u);

  // 唯一索引明确包含 tenant_id：相同 source key 在另一租户不会互相占位。
  assert.doesNotThrow(() => runWithTenant(2, () => q.run(`INSERT INTO kb_docs(
    category,title,body,source_type,source_id,enabled
  ) VALUES('话术案例','租户独立来源键','仅用于索引边界测试','content',?,1)`, firstId)));
  await flushEmbedding();
});

test('删除内容时来源知识与块共同进入快照；恢复时文档先于块且不留孤儿', async () => {
  const contentId = insertContent(1, bossA.id, '待删除来源文案', '需要跟随内容回收的正文');
  syncContent(1, contentId, '待删除来源文案', '需要跟随内容回收的正文');
  await flushEmbedding();
  const doc = q.get(`SELECT * FROM kb_docs
    WHERE tenant_id=1 AND source_type='content' AND source_id=?`, contentId);
  assert.ok(doc);
  q.run(`INSERT INTO kb_chunks(doc_id,seq,text,embedding) VALUES(?,?,?,NULL)`, doc.id, 0, '来源块一');
  q.run(`INSERT INTO kb_chunks(doc_id,seq,text,embedding) VALUES(?,?,?,NULL)`, doc.id, 1, '来源块二');

  let archiveId;
  await withServer(bossA, async base => {
    const removed = await jsonRequest(base, `/content/${contentId}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: '验证内容知识来源回收闭环' }),
    });
    assert.equal(removed.response.status, 200);
    archiveId = removed.data.archiveId;
  });

  assert.equal(q.get(`SELECT COUNT(*) n FROM contents WHERE tenant_id=1 AND id=?`, contentId).n, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=1 AND id=?`, doc.id).n, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM kb_chunks WHERE doc_id=?`, doc.id).n, 0);
  const archive = q.get(`SELECT child_snapshot FROM deleted_records
    WHERE tenant_id=1 AND id=?`, archiveId);
  const children = JSON.parse(archive.child_snapshot);
  assert.equal(children.kb_docs.length, 1);
  assert.equal(children.kb_docs[0].source_id, contentId);
  assert.deepEqual(children.kb_chunks.map(row => row.text), ['来源块一', '来源块二']);

  await withServer(bossA, async base => {
    const restored = await jsonRequest(base, `/sys/deletions/${archiveId}/restore`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.data.restored >= 4, true);
  });

  assert.equal(q.get(`SELECT title FROM contents WHERE tenant_id=1 AND id=?`, contentId).title, '待删除来源文案');
  assert.equal(q.get(`SELECT source_type FROM kb_docs WHERE tenant_id=1 AND id=?`, doc.id).source_type, 'content');
  assert.deepEqual(q.all(`SELECT text FROM kb_chunks WHERE doc_id=? ORDER BY seq`, doc.id).map(row => row.text),
    ['来源块一', '来源块二']);
  assert.equal(q.get(`SELECT COUNT(*) n FROM kb_chunks kc
    LEFT JOIN kb_docs kd ON kd.id=kc.doc_id WHERE kd.id IS NULL`).n, 0);
});

test('内容事务回滚后迟到的异步向量任务不会写出孤儿块', async () => {
  const longBody = `${'第一段事实。'.repeat(90)}\n\n${'第二段事实。'.repeat(90)}`;
  let rolledBackDocId;
  runWithTenant(1, () => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const contentId = Number(q.run(`INSERT INTO contents(
        type,title,body,topic,status,risk_flags,risk_level,creator_id
      ) VALUES('朋友圈文案','回滚来源文案',?,'知识来源闭环','可使用','[]','none',?)`,
      longBody, bossA.id).lastInsertRowid);
      syncContentToKb({
        contentId,
        type: '朋友圈文案',
        title: '回滚来源文案',
        topic: '知识来源闭环',
        body: longBody,
      });
      rolledBackDocId = Number(q.get(`SELECT id FROM kb_docs
        WHERE tenant_id=1 AND source_type='content' AND source_id=?`, contentId).id);
    } finally {
      db.exec('ROLLBACK');
    }
  });

  await flushEmbedding();
  assert.equal(q.get(`SELECT COUNT(*) n FROM kb_docs WHERE id=?`, rolledBackDocId).n, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM kb_chunks WHERE doc_id=?`, rolledBackDocId).n, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM kb_chunks kc
    LEFT JOIN kb_docs kd ON kd.id=kc.doc_id WHERE kd.id IS NULL`).n, 0);
});

after(async () => {
  await flushEmbedding();
  db.close();
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
});

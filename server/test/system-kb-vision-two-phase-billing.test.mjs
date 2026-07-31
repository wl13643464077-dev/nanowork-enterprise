import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-system-kb-vision-two-phase-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = 'sk-local-system-kb-vision-test';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';

const {
  db,
  qRaw,
  initSchema,
  migrateV2,
  runWithTenant,
  setConfig,
} = await import('../src/db.js');
const {
  balanceOfTenant,
  holdCredits,
  releaseHold,
} = await import('../src/engines/credits.js');
const systemRoutes = (await import('../src/routes/system.js')).default;

initSchema();
migrateV2();

const tenantId = Number(qRaw.run(
  "INSERT INTO tenants(name,status,credits) VALUES('系统知识库识图企业','已开通',1000)",
).lastInsertRowid);
const userId = Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,tenant_id)
   VALUES('system-kb-vision-u','x','知识库识图用户','boss',?)`,
  tenantId,
).lastInsertRowid);
const user = { id: userId, name: '知识库识图用户', role: 'boss', tenant_id: tenantId };
// 让本地假供应商能够在旧实现尚未触发 hold 时也安全检查占额表。
const bootstrapHold = holdCredits({
  userId,
  feature: '测试初始化',
  kind: 'text',
  model: 'gemini-3.1-flash-lite',
  credits: 1,
});
releaseHold(bootstrapHold, '测试初始化完成');

const providerObservations = [];
const providerApp = express();
providerApp.use(express.json({ limit: '2mb' }));
providerApp.post('/v1/chat/completions', (req, res) => {
  const held = db.prepare(
    `SELECT id,status FROM credit_holds
     WHERE tenant_id=? AND status='held' ORDER BY id DESC LIMIT 1`,
  ).get(tenantId);
  const requestText = JSON.stringify(req.body?.messages || []);
  providerObservations.push({ heldBeforeProvider: !!held, requestText });
  if (requestText.includes('识图上游失败.png')) {
    return res.status(503).json({ error: { message: 'local injected provider failure' } });
  }
  return res.json({
    choices: [{ message: { content: '一句话说明：门店经营表。\\n关键信息：本月到店人数 28。\\n适用场景：经营复盘。\\n待核验：统计周期。' } }],
    usage: { prompt_tokens: 180, completion_tokens: 95 },
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
  next();
}));
app.use('/sys', systemRoutes);
const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;
const imageB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=';
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const writtenPaths = [];

async function upload(name) {
  const response = await fetch(`${base}/sys/kb/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      category: '品牌资料',
      b64: imageB64,
    }),
  });
  const payload = await response.json();
  if (payload.fileUrl) {
    writtenPaths.push(path.join(serverRoot, 'data', decodeURIComponent(payload.fileUrl)));
  }
  return { response, payload };
}

const heldRows = () => db.prepare(
  `SELECT * FROM credit_holds WHERE tenant_id=? AND status='held' ORDER BY id`,
).all(tenantId);

test('知识库图片在供应商调用前占额，文档与资产原子入库后按真实用量结算', async () => {
  const before = balanceOfTenant(tenantId);
  const observationStart = providerObservations.length;
  const result = await upload('识图成功.png');

  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(providerObservations[observationStart]?.heldBeforeProvider, true);
  assert.equal(result.payload.billing.state, 'settled');
  assert.ok(result.payload.billing.chargedCredits > 0);
  assert.equal(result.payload.billing.heldCredits, 0);
  assert.match(result.payload.extractMode, /^AI识图/);
  assert.match(result.payload.body, /到店人数 28/);
  const doc = db.prepare('SELECT * FROM kb_docs WHERE tenant_id=? AND id=?').get(tenantId, result.payload.id);
  const asset = db.prepare(
    `SELECT * FROM biz_assets
     WHERE tenant_id=? AND source_type='kb' AND source_id=?`,
  ).get(tenantId, result.payload.id);
  assert.match(doc.body, /到店人数 28/);
  assert.ok(asset);
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before - result.payload.billing.chargedCredits);
});

test('知识库图片识别失败会释放占额，文件和待重试档案仍保留', async () => {
  const before = balanceOfTenant(tenantId);
  const result = await upload('识图上游失败.png');

  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.billing.state, 'released');
  assert.equal(result.payload.billing.chargedCredits, 0);
  assert.match(result.payload.extractMode, /图片已存档·识图待重试/);
  assert.equal(result.payload.enabled, 0);
  assert.equal(fs.existsSync(path.join(serverRoot, 'data', decodeURIComponent(result.payload.fileUrl))), true);
  const doc = db.prepare('SELECT * FROM kb_docs WHERE tenant_id=? AND id=?').get(tenantId, result.payload.id);
  const asset = db.prepare(
    `SELECT * FROM biz_assets
     WHERE tenant_id=? AND source_type='kb' AND source_id=?`,
  ).get(tenantId, result.payload.id);
  assert.equal(doc.body, '');
  assert.match(asset.note, /识图待重试/);
  assert.equal(balanceOfTenant(tenantId), before);
  assert.equal(heldRows().length, 0);
});

test('识图正文原子落库失败会释放占额，并改存为明确的待重试档案', async () => {
  const before = balanceOfTenant(tenantId);
  db.exec(`CREATE TRIGGER injected_system_kb_vision_persist_failure
    BEFORE INSERT ON kb_docs
    WHEN NEW.title='识图落库失败' AND NEW.body LIKE '%到店人数 28%'
    BEGIN
      SELECT RAISE(ABORT,'injected system kb vision persistence failure');
    END`);
  try {
    const result = await upload('识图落库失败.png');
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.billing.state, 'released');
    assert.equal(result.payload.billing.chargedCredits, 0);
    assert.match(result.payload.extractMode, /图片已存档·识图待重试/);
    assert.equal(result.payload.enabled, 0);
    const docs = db.prepare(
      `SELECT * FROM kb_docs WHERE tenant_id=? AND title='识图落库失败'`,
    ).all(tenantId);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].body, '');
    assert.equal(db.prepare(
      `SELECT COUNT(*) n FROM biz_assets
       WHERE tenant_id=? AND source_type='kb' AND source_id=?`,
    ).get(tenantId, docs[0].id).n, 1);
    assert.equal(balanceOfTenant(tenantId), before);
    assert.equal(heldRows().length, 0);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_system_kb_vision_persist_failure');
  }
});

test('知识已交付但结算失败时保留待对账，不把占额冒充实扣', async () => {
  const before = balanceOfTenant(tenantId);
  db.exec(`CREATE TRIGGER injected_system_kb_vision_settlement_failure
    BEFORE UPDATE OF status ON credit_holds
    WHEN OLD.tenant_id=${tenantId} AND OLD.status='held'
    BEGIN
      SELECT RAISE(ABORT,'injected system kb vision settlement failure');
    END`);
  try {
    const result = await upload('识图结算失败.png');
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.billing.state, 'pending_reconciliation');
    assert.equal(result.payload.billing.pendingReconciliation, true);
    assert.equal(result.payload.billing.chargedCredits, null);
    assert.equal(result.payload.billing.credits, null);
    assert.ok(result.payload.billing.heldCredits > 0);
    assert.match(result.payload.body, /到店人数 28/);
    assert.ok(db.prepare('SELECT id FROM kb_docs WHERE tenant_id=? AND id=?').get(tenantId, result.payload.id));
    assert.ok(db.prepare(
      `SELECT id FROM biz_assets WHERE tenant_id=? AND source_type='kb' AND source_id=?`,
    ).get(tenantId, result.payload.id));
    assert.equal(heldRows().length, 1);
    assert.equal(balanceOfTenant(tenantId), before - result.payload.billing.heldCredits);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_system_kb_vision_settlement_failure');
  }
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => providerServer.close(resolve));
  delete process.env.YUNWU_API_KEY;
  for (const filePath of writtenPaths) {
    try { fs.rmSync(filePath, { force: true }); } catch { /* clean uploaded test file */ }
  }
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
  }
});

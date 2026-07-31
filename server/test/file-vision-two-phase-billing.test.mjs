import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-file-vision-two-phase-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = 'sk-local-file-vision-test';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const {
  db,
  qRaw,
  initSchema,
  migrateV2,
  runWithTenant,
  setConfig,
} = await import('../src/db.js');
const { balanceOfTenant } = await import('../src/engines/credits.js');
const fileRoutes = (await import('../src/routes/files.js')).default;

initSchema();
migrateV2();

const tenantId = Number(qRaw.run(
  "INSERT INTO tenants(name,status,credits) VALUES('文件识图计费企业','已开通',500)",
).lastInsertRowid);
const userId = Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,tenant_id)
   VALUES('file-vision-u','x','文件识图用户','boss',?)`,
  tenantId,
).lastInsertRowid);
const user = { id: userId, name: '文件识图用户', role: 'boss', tenant_id: tenantId };

const providerApp = express();
providerApp.use(express.json({ limit: '2mb' }));
providerApp.post('/v1/chat/completions', (_req, res) => {
  res.json({
    choices: [{ message: { content: '图片说明：门店经营表。\\n识别内容：本月到店 28 人。\\n可引用字段：到店人数=28。' } }],
    usage: { prompt_tokens: 160, completion_tokens: 90 },
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
app.use('/files', fileRoutes);
const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;
const writtenPaths = [];
const imageB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=';

async function upload(name) {
  const response = await fetch(`${base}/files/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      mime: 'image/png',
      purpose: 'two-phase-test',
      recognize: true,
      b64: imageB64,
    }),
  });
  const payload = await response.json();
  const stored = payload.file?.id
    ? db.prepare('SELECT file_path FROM uploaded_files WHERE tenant_id=? AND id=?').get(tenantId, payload.file.id)
    : null;
  if (stored?.file_path) writtenPaths.push(stored.file_path);
  return { response, payload };
}

const heldRows = () => db.prepare(
  `SELECT * FROM credit_holds WHERE tenant_id=? AND status='held' ORDER BY id`,
).all(tenantId);

test('文件识图在供应商调用前预授权，识别正文落库后按真实用量结算', async () => {
  const before = balanceOfTenant(tenantId);
  const result = await upload('识图成功.png');

  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.billing.state, 'settled');
  assert.ok(result.payload.billing.chargedCredits > 0);
  assert.match(result.payload.file.preview, /到店人数=28/);
  assert.equal(result.payload.file.readable, true);
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before - result.payload.billing.chargedCredits);
});

test('文件识图正文落库失败时释放预授权并保留可重试文件', async () => {
  const before = balanceOfTenant(tenantId);
  db.exec(`CREATE TRIGGER injected_file_vision_persist_failure
    BEFORE UPDATE OF extracted_text ON uploaded_files
    WHEN NEW.name='识图落库失败.png' AND NEW.extract_mode LIKE 'AI识图%'
    BEGIN
      SELECT RAISE(ABORT,'injected file vision persistence failure');
    END`);
  try {
    const failed = await upload('识图落库失败.png');
    assert.equal(failed.response.status, 200, JSON.stringify(failed.payload));
    assert.equal(failed.payload.billing.state, 'released');
    assert.equal(failed.payload.billing.chargedCredits, 0);
    assert.equal(failed.payload.file.readable, false);
    assert.match(failed.payload.file.extract_mode, /识图待重试/);
    assert.equal(balanceOfTenant(tenantId), before);
    assert.equal(heldRows().length, 0);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_file_vision_persist_failure');
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

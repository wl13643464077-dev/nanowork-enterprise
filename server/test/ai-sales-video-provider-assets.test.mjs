import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
Object.assign(process.env, {
  NANOWORK_DB: ':memory:',
  NANOWORK_TEST_TEMPLATE_AI: '1',
  NODE_ENV: 'test',
  YUNWU_API_KEY: '',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  ENABLE_SCHEDULER: 'false',
  ENABLE_BACKGROUND_EMBEDDINGS: 'false',
  AI_SALES_VIDEO_PUBLIC_BASE_URL: '',
  AVATAR_PROVIDER_PUBLIC_BASE_URL: '',
  PUBLIC_BASE_URL: '',
  APP_PUBLIC_URL: '',
});
const { db, q, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
const { signToken } = await import('../src/util.js');
const assets = await import('../src/engines/ai-sales-video-provider-assets.js');
assert.equal(db.prepare('PRAGMA database_list').get().file, '');
initSchema();
migrateV2();
const tenantId = crypto.randomInt(10000000, 99999999);
q.run("INSERT INTO tenants(id,name,status) VALUES(?,'限时素材隔离测试','已开通')", tenantId);
const userId = Number(
  q.run(
    "INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES(?,'x','测试老板','boss',?)",
    `asset-test-${tenantId}`,
    tenantId,
  ).lastInsertRowid,
);
const uploadRoot = path.resolve(import.meta.dirname, '../data/uploads/files');
const tenantRoot = path.resolve(uploadRoot, String(tenantId));
assert.equal(path.dirname(tenantRoot), uploadRoot);
await assert.rejects(fsp.stat(tenantRoot), { code: 'ENOENT' }, '测试只允许使用全新临时企业目录');
const app = express();
app.get('/assets/:token', assets.serveAiSalesVideoProviderAsset);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const bytes = Buffer.from('isolated-audio-fixture');
const save = args =>
  runWithTenant(tenantId, () =>
    assets.persistAiSalesVideoProviderAsset({
      tenantId,
      userId,
      purpose: 'ai-sales-video-audio',
      bytes,
      mime: 'audio/mpeg',
      label: 'test',
      ...args,
    }),
  );
const url = row =>
  assets.createAiSalesVideoProviderAssetUrl(
    { tenantId, fileId: row.id, purpose: 'ai-sales-video-audio' },
    { publicBaseUrl: 'https://assets.example.com' },
  );
const read = token => fetch(`${base}/assets/${encodeURIComponent(token)}`);
const tokenOf = publicUrl => decodeURIComponent(publicUrl.split('/').at(-1));

test('公网资源基址拒绝私网、尾点localhost、凭据、查询和非标准端口', () => {
  for (const value of [
    'http://example.com',
    'https://127.0.0.1',
    'https://localhost.',
    'https://my.local.',
    'https://host.internal.',
    'https://10.1.2.3',
    'https://example.com:444',
    'https://user:secret@example.com',
    'https://example.com?token=secret',
  ]) {
    assert.equal(assets.aiSalesVideoProviderPublicBaseUrl(value), null, value);
  }
  assert.equal(
    assets.aiSalesVideoProviderPublicBaseUrl('https://example.com/nanowork/'),
    'https://example.com/nanowork',
  );
});

test('签名音轨不需要登录且有效期内可重复拉取，类型/长度/不缓存标头一致', async () => {
  const row = await save(),
    publicUrl = url(row),
    token = tokenOf(publicUrl);
  assert.match(publicUrl, /^https:\/\/assets\.example\.com\/api\/ai-sales-video\/provider-assets\//u);
  assert.equal(row.tenant_id, tenantId);
  assert.ok(row.file_path.startsWith(`${tenantRoot}${path.sep}`));
  for (let i = 0; i < 2; i++) {
    const res = await read(token);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.match(res.headers.get('cache-control'), /no-store/u);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Number(res.headers.get('content-length')), bytes.length);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  }
  for (const invalid of ['not-a-token', token + '.extra', token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a')])
    assert.equal((await read(invalid)).status, 404);
  const payload = { tokenPurpose: 'ai_sales_video_provider_asset', tenantId, fileId: row.id, filePurpose: row.purpose };
  for (const invalid of [
    signToken(payload, -1),
    signToken({ ...payload, tenantId: tenantId + 1 }),
    signToken({ ...payload, filePurpose: 'ai-sales-video-frame' }),
    signToken({ ...payload, tokenPurpose: 'auth' }),
  ])
    assert.equal((await read(invalid)).status, 404);
});

test('音轨用途不能登记成图片，拒绝超限、错租户、他人账号；无公网发布不写文件行', async () => {
  for (const args of [
    { mime: 'image/png' },
    { mime: 'text/html' },
    { bytes: Buffer.alloc(0) },
    { bytes: Buffer.alloc(15 * 1024 * 1024 + 1) },
    { tenantId: tenantId + 1 },
    { userId: -100 },
  ])
    await assert.rejects(save(args));
  const before = q.get('SELECT count(*) n FROM uploaded_files WHERE tenant_id=?', tenantId).n;
  const publish = assets.createAiSalesVideoAssetPublisher({ tenantId, userId, publicBaseUrl: 'https://localhost.' });
  assert.equal(
    await runWithTenant(tenantId, () => publish({ bytes, mime: 'audio/mpeg', purpose: 'ai-sales-video-audio' })),
    null,
  );
  assert.equal(q.get('SELECT count(*) n FROM uploaded_files WHERE tenant_id=?', tenantId).n, before);
});

test('签名不能越过用途目录、借同大小另一文件、或读取大小发生变化的素材', async () => {
  const row = await save(),
    token = tokenOf(url(row));
  await fsp.appendFile(row.file_path, 'changed');
  assert.equal((await read(token)).status, 404);
  const imageRow = await save({ purpose: 'ai-sales-video-frame', mime: 'image/png' });
  runWithTenant(tenantId, () =>
    q.run(
      'UPDATE uploaded_files SET file_path=?,size=? WHERE tenant_id=? AND id=?',
      imageRow.file_path,
      bytes.length,
      tenantId,
      row.id,
    ),
  );
  assert.equal((await read(token)).status, 404, '音频令牌不能读取frame目录');
});

test('素材登记失败不遗留磁盘文件', async () => {
  const directory = path.join(tenantRoot, 'ai-sales-video-audio'),
    before = await fsp.readdir(directory);
  db.exec(
    "CREATE TRIGGER fail_asset_insert BEFORE INSERT ON uploaded_files BEGIN SELECT RAISE(ABORT, 'isolated-file-row-failure'); END;",
  );
  try {
    await assert.rejects(save(), /isolated-file-row-failure/u);
  } finally {
    db.exec('DROP TRIGGER fail_asset_insert');
  }
  assert.deepEqual(await fsp.readdir(directory), before);
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  assert.equal(path.dirname(tenantRoot), uploadRoot);
  // The random tenant directory was verified absent before this test created it.
  await fsp.rm(tenantRoot, { recursive: true, force: true });
});

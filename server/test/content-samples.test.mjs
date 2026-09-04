import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { removeTempDbSafely, removeTempDirSafely } from './helpers/temp-db.mjs';

const DBP = path.join(os.tmpdir(), `nanowork-content-samples-${process.pid}.db`);
const SAMPLE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-sample-uploads-'));
const SOURCE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-sample-source-'));
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* fresh test database */
  }
}
process.env.NANOWORK_DB = DBP;
process.env.NANOWORK_SAMPLE_UPLOAD_ROOT = SAMPLE_ROOT;
process.env.JWT_SECRET = 'content-samples-test-secret';
process.env.SEED_DEMO = 'false';
process.env.ENABLE_SCHEDULER = 'false';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { authMiddleware, signToken } = await import('../src/util.js');
const { uploadAccessGuard } = await import('../src/engines/upload-access.js');
const contentSamplesRoutes = (await import('../src/routes/content-samples.js')).default;
const {
  normalizeSampleTags,
  normalizeSampleNote,
  parseFfprobeDuration,
  parseSampleFileMeta,
  sampleTypeForExt,
  validateSampleFileStat,
} = await import('../src/engines/content-samples.js');
const { resolveFfmpeg, resolveFfprobe } = await import('../src/engines/media-binaries.js');
const { collectSampleFiles, importSampleDirectory, parseCliArgs } = await import(
  '../../scripts/import-video-samples.mjs'
);

initSchema();
migrateV2();
for (const [id, name] of [[1, '总部'], [2, '样片B店'], [3, '样片C店']]) {
  q.run(
    `INSERT INTO tenants(id,name,status,credits) VALUES(?,?,'已开通',1000)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status`,
    id,
    name,
  );
}
function insertUser(tenantId, username, role) {
  return Number(
    q.run(
      `INSERT INTO users(username,password_hash,name,role,dept,status,tenant_id)
      VALUES(?,?,?,?,?,'启用',?)`,
      username,
      'x',
      username,
      role,
      '测试',
      tenantId,
    ).lastInsertRowid,
  );
}
const platformSuper = { id: insertUser(1, 'ps', 'platform_super'), name: 'ps', role: 'platform_super', tenant_id: 1 };
const bossB = { id: insertUser(2, 'boss-b', 'boss'), name: 'boss-b', role: 'boss', tenant_id: 2 };
const salesB = { id: insertUser(2, 'sales-b', 'sales'), name: 'sales-b', role: 'sales', tenant_id: 2 };
const bossC = { id: insertUser(3, 'boss-c', 'boss'), name: 'boss-c', role: 'boss', tenant_id: 3 };

function insertUploadedFile(tenantId, userId, name, ext, size, url) {
  return Number(
    q.run(
      `INSERT INTO uploaded_files(user_id,name,stored_name,ext,mime,size,purpose,file_path,file_url,tenant_id)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
      userId,
      name,
      name,
      ext,
      ext === 'png' ? 'image/png' : 'video/mp4',
      size,
      'sample',
      `/tmp/${name}`,
      url,
      tenantId,
    ).lastInsertRowid,
  );
}
const platformFileUrl = '/uploads/files/1/sample/platform-hotpot.png';
const platformFileId = insertUploadedFile(1, platformSuper.id, 'platform-hotpot.png', 'png', 2048, platformFileUrl);
const tenantBFileUrl = '/uploads/files/2/sample/b-store-front.png';
const tenantBFileId = insertUploadedFile(2, bossB.id, 'b-store-front.png', 'png', 4096, tenantBFileUrl);
const tenantBDocId = insertUploadedFile(2, bossB.id, 'menu.pdf', 'pdf', 4096, '/uploads/files/2/sample/menu.pdf');
const tenantBVideoUrl = '/uploads/ai-sales-video/2/sales-video-abc.mp4';
const tenantBJobId = Number(
  runWithTenant(2, () =>
    q.run(
      `INSERT INTO media_jobs(user_id,kind,model,prompt,status,url) VALUES(?,?,?,?,?,?)`,
      bossB.id,
      'video',
      'MiniMax-Hailuo-2.3',
      '火锅门店30秒带货视频',
      '成功',
      tenantBVideoUrl,
    ),
  ).lastInsertRowid,
);
const tenantBPendingJobId = Number(
  runWithTenant(2, () =>
    q.run(`INSERT INTO media_jobs(user_id,kind,status,url) VALUES(?,?,?,?)`, bossB.id, 'video', '处理中', null),
  ).lastInsertRowid,
);
const tenantBMaterialId = Number(
  runWithTenant(2, () =>
    q.run(
      `INSERT INTO materials(name,type,tags,url,source_type,source_id,creator_id) VALUES(?,?,?,?,?,?,?)`,
      '门头海报',
      '海报',
      '海报',
      '/uploads/files/2/sample/poster.png',
      'manual',
      null,
      bossB.id,
    ),
  ).lastInsertRowid,
);

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) =>
    runWithTenant(user.tenant_id, () => {
      req.user = user;
      next();
    }),
  );
  app.use('/content/samples', contentSamplesRoutes);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function call(base, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

after(async () => {
  await removeTempDbSafely(DBP);
  await removeTempDirSafely(SAMPLE_ROOT);
  await removeTempDirSafely(SOURCE_DIR);
});

test('纯函数：文件名标签 / 同名 json / 标签与讲解词规范化 / 扩展名与大小白名单', () => {
  const byName = parseSampleFileMeta('火锅门头实拍[火锅, 门头,菜品特写,火锅].mp4');
  assert.equal(byName.name, '火锅门头实拍');
  assert.deepEqual(byName.tags, ['火锅', '门头', '菜品特写']);
  assert.equal(byName.type, 'video');
  assert.equal(byName.ext, 'mp4');

  const plain = parseSampleFileMeta('招牌菜特写.PNG');
  assert.equal(plain.type, 'image');
  assert.deepEqual(plain.tags, []);
  assert.equal(plain.name, '招牌菜特写');

  const sidecar = parseSampleFileMeta('火锅门头实拍[火锅].mp4', JSON.stringify({
    name: '朝阳店门头实拍',
    tags: ['火锅', '门头', '夜景'],
    note: '给客户看：这条 30 秒成片从 3 张照片生成，\r\n重点看字幕与门店名准确。',
  }));
  assert.equal(sidecar.name, '朝阳店门头实拍');
  assert.deepEqual(sidecar.tags, ['火锅', '门头', '夜景']);
  assert.ok(sidecar.note.includes('门店名准确'));
  assert.equal(sidecar.note.includes('\r'), false);
  assert.throws(() => parseSampleFileMeta('a.mp4', '{bad json'), /不是合法 JSON/u);

  assert.deepEqual(normalizeSampleTags('火锅，门头、菜品特写;火锅'), ['火锅', '门头', '菜品特写']);
  assert.deepEqual(normalizeSampleTags('["茶饮","门头"]'), ['茶饮', '门头']);
  assert.equal(normalizeSampleTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 12);
  assert.equal(normalizeSampleTags([`${'长'.repeat(40)}`])[0].length, 20);
  assert.equal(normalizeSampleNote(`  ${'讲'.repeat(3000)}  `).length, 2000);

  assert.equal(sampleTypeForExt('.MP4'), 'video');
  assert.equal(sampleTypeForExt('webp'), 'image');
  assert.equal(sampleTypeForExt('mov'), null);
  assert.equal(validateSampleFileStat({ ext: 'png', size: 100 }), 'image');
  assert.throws(() => validateSampleFileStat({ ext: 'pdf', size: 100 }), /不支持 \.pdf/u);
  assert.throws(() => validateSampleFileStat({ ext: 'mp4', size: 0 }), /为空/u);
  assert.throws(() => validateSampleFileStat({ ext: 'png', size: 16 * 1024 * 1024 }), /大小上限/u);

  const probe = parseFfprobeDuration(JSON.stringify({
    streams: [{ codec_type: 'video', width: 1080, height: 1920 }],
    format: { duration: '30.02' },
  }));
  assert.deepEqual(probe, { duration: 30.02, width: 1080, height: 1920, hasVideoStream: true });
  assert.equal(parseFfprobeDuration('not json'), null);
});

test('脚本参数解析与目录扫描（同名 json 优先、忽略非媒体文件）', () => {
  const options = parseCliArgs(['D:/samples', '--tenant', '1', '--scope', 'platform', '--dry-run']);
  assert.deepEqual(options, {
    directory: 'D:/samples',
    tenantId: 1,
    scope: 'platform',
    creatorId: null,
    dryRun: true,
    help: false,
  });
  assert.equal(parseCliArgs(['--help']).help, true);
  assert.equal(parseCliArgs(['-h']).help, true);
  assert.throws(() => parseCliArgs([]), /请提供样片目录/u);
  assert.throws(() => parseCliArgs(['x', '--scope', 'global']), /scope/u);
  assert.throws(() => parseCliArgs(['x', '--bogus']), /未知参数/u);

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  fs.writeFileSync(path.join(SOURCE_DIR, '茶饮门头[茶饮,门头].png'), png);
  fs.writeFileSync(path.join(SOURCE_DIR, '菜品特写.png'), png);
  fs.writeFileSync(path.join(SOURCE_DIR, '菜品特写.json'), JSON.stringify({ tags: ['火锅', '菜品特写'], note: '现场讲解：菜名与价格逐字准确。' }));
  fs.writeFileSync(path.join(SOURCE_DIR, 'readme.txt'), 'ignore me');
  fs.writeFileSync(path.join(SOURCE_DIR, 'clip.mov'), 'not supported');
  const files = collectSampleFiles(SOURCE_DIR);
  assert.deepEqual(
    files
      .map(item => [item.meta.name, item.meta.tags, Boolean(item.sidecarPath)])
      .sort((a, b) => a[0].localeCompare(b[0])),
    [
      ['茶饮门头', ['茶饮', '门头'], false],
      ['菜品特写', ['火锅', '菜品特写'], true],
    ].sort((a, b) => a[0].localeCompare(b[0])),
  );
});

test('脚本导入：png 落盘到 uploads/samples/platform 并写为平台样片；mp4 走 ffprobe 时长校验', async () => {
  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();
  if (ffmpeg && ffprobe) {
    execFileSync(
      ffmpeg,
      ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-pix_fmt', 'yuv420p', path.join(SOURCE_DIR, '火锅门头[火锅,门头].mp4')],
      { windowsHide: true },
    );
  }
  const logs = [];
  const dry = await importSampleDirectory({ directory: SOURCE_DIR, tenantId: 1, scope: 'platform', creatorId: platformSuper.id, dryRun: true }, { log: message => logs.push(message) });
  assert.equal(dry.imported.every(item => item.dryRun), true);
  assert.equal(q.get(`SELECT COUNT(*) n FROM materials WHERE is_sample=1`).n, 0, 'dry-run 不写库');

  const result = await importSampleDirectory({ directory: SOURCE_DIR, tenantId: 1, scope: 'platform', creatorId: platformSuper.id, dryRun: false }, { log: message => logs.push(message) });
  assert.equal(result.skipped.length, 0, JSON.stringify(result.skipped));
  const expectedCount = ffmpeg && ffprobe ? 3 : 2;
  assert.equal(result.imported.length, expectedCount);
  for (const item of result.imported) {
    assert.equal(item.scope, 'platform');
    assert.match(item.url, /^\/uploads\/samples\/platform\//u);
    const stored = path.join(SAMPLE_ROOT, 'platform', decodeURIComponent(path.basename(item.url)));
    assert.ok(fs.existsSync(stored), `未落盘：${stored}`);
  }
  const dish = result.imported.find(item => item.name === '菜品特写');
  assert.deepEqual(dish.tags, ['火锅', '菜品特写']);
  assert.equal(dish.note, '现场讲解：菜名与价格逐字准确。');
  if (ffmpeg && ffprobe) {
    const video = result.imported.find(item => item.type === 'video');
    assert.ok(video.durationSeconds > 0.5 && video.durationSeconds < 2, `时长异常 ${video.durationSeconds}`);
    assert.equal(video.width, 64);
  }
  const rows = q.all(`SELECT tenant_id,sample_scope,is_sample FROM materials WHERE source_type='sample_script_import'`);
  assert.equal(rows.length, expectedCount);
  assert.ok(rows.every(row => row.tenant_id === 1 && row.sample_scope === 'platform' && row.is_sample === 1));
});

let platformSampleId = 0;
let tenantBSampleId = 0;

test('导入权限：platform_super 可导平台样片；boss 只能导本租户样片；普通员工不能导入', async () => {
  const created = await withServer(platformSuper, base =>
    call(base, '/content/samples/import', {
      method: 'POST',
      body: { fileId: platformFileId, scope: 'platform', tags: ['火锅', '门头'], note: '平台样片讲解词', name: '火锅门头样片' },
    }),
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.scope, 'platform');
  assert.equal(created.data.type, 'image');
  assert.equal(created.data.url, platformFileUrl);
  assert.deepEqual(created.data.tags, ['火锅', '门头']);
  platformSampleId = created.data.id;

  const bossPlatform = await withServer(bossB, base =>
    call(base, '/content/samples/import', { method: 'POST', body: { fileId: tenantBFileId, scope: 'platform', tags: ['茶饮'] } }),
  );
  assert.equal(bossPlatform.response.status, 403);
  assert.equal(bossPlatform.data.code, 'CONTENT_SAMPLE_SCOPE_FORBIDDEN');

  const bossTenant = await withServer(bossB, base =>
    call(base, '/content/samples/import', {
      method: 'POST',
      body: { fileId: tenantBFileId, tags: ['茶饮', '门头'], note: 'B店自有样片' },
    }),
  );
  assert.equal(bossTenant.response.status, 201, JSON.stringify(bossTenant.data));
  assert.equal(bossTenant.data.scope, 'tenant');
  assert.equal(bossTenant.data.ownTenant, true);
  tenantBSampleId = bossTenant.data.id;

  const sales = await withServer(salesB, base =>
    call(base, '/content/samples/import', { method: 'POST', body: { fileId: tenantBFileId } }),
  );
  assert.equal(sales.response.status, 403);

  const doc = await withServer(bossB, base =>
    call(base, '/content/samples/import', { method: 'POST', body: { fileId: tenantBDocId } }),
  );
  assert.equal(doc.response.status, 400);
  assert.match(doc.data.error, /不支持 \.pdf/u);

  const foreignFile = await withServer(bossC, base =>
    call(base, '/content/samples/import', { method: 'POST', body: { fileId: tenantBFileId } }),
  );
  assert.equal(foreignFile.response.status, 404, '跨租户文件不可见');

  const none = await withServer(bossB, base => call(base, '/content/samples/import', { method: 'POST', body: {} }));
  assert.equal(none.response.status, 400);
});

test('导入来源：已完成 media_job 可作视频样片，处理中的任务与既有素材按规则处理', async () => {
  const job = await withServer(bossB, base =>
    call(base, '/content/samples/import', {
      method: 'POST',
      body: { mediaJobId: tenantBJobId, tags: ['火锅', '带货视频'], note: '30秒带货成片' },
    }),
  );
  assert.equal(job.response.status, 201, JSON.stringify(job.data));
  assert.equal(job.data.type, 'video');
  assert.equal(job.data.url, tenantBVideoUrl);
  assert.equal(job.data.mimeType, 'video/mp4');
  assert.equal(job.data.sourceType, 'sample_media_job');

  const pending = await withServer(bossB, base =>
    call(base, '/content/samples/import', { method: 'POST', body: { mediaJobId: tenantBPendingJobId } }),
  );
  assert.equal(pending.response.status, 409);

  const material = await withServer(bossB, base =>
    call(base, '/content/samples/import', { method: 'POST', body: { materialId: tenantBMaterialId, tags: ['海报'], note: '海报样例' } }),
  );
  assert.equal(material.response.status, 201, JSON.stringify(material.data));
  assert.equal(material.data.id, tenantBMaterialId);
  assert.equal(material.data.type, 'image');
  assert.equal(q.get(`SELECT is_sample, sample_scope FROM materials WHERE id=?`, tenantBMaterialId).sample_scope, 'tenant');

  const foreignJob = await withServer(bossC, base =>
    call(base, '/content/samples/import', { method: 'POST', body: { mediaJobId: tenantBJobId } }),
  );
  assert.equal(foreignJob.response.status, 404);
});

test('可见性：平台样片跨租户可见；租户自有样片不可跨租户；type/tag 筛选与标签统计', async () => {
  const listC = await withServer(bossC, base => call(base, '/content/samples'));
  assert.equal(listC.response.status, 200);
  assert.deepEqual(listC.data.items.map(item => item.id).includes(platformSampleId), true);
  assert.equal(listC.data.items.some(item => item.id === tenantBSampleId), false, 'C 店不能看到 B 店自有样片');
  assert.ok(listC.data.items.every(item => item.scope === 'platform'));
  assert.equal(listC.data.canImport, true);
  assert.equal(listC.data.canImportPlatform, false);

  const listB = await withServer(salesB, base => call(base, '/content/samples'));
  assert.equal(listB.response.status, 200, '登录即可读');
  assert.equal(listB.data.canImport, false);
  const idsB = listB.data.items.map(item => item.id);
  assert.ok(idsB.includes(platformSampleId));
  assert.ok(idsB.includes(tenantBSampleId));
  assert.equal(listB.data.items.find(item => item.id === tenantBSampleId).ownTenant, true);
  assert.equal(listB.data.items.find(item => item.id === platformSampleId).ownTenant, false);
  assert.ok(listB.data.tags.some(item => item.tag === '门头' && item.count >= 2));

  const videos = await withServer(bossB, base => call(base, '/content/samples?type=video'));
  assert.ok(videos.data.items.length >= 1);
  assert.ok(videos.data.items.every(item => item.type === 'video'));
  const tea = await withServer(bossB, base => call(base, '/content/samples?type=image&tag=茶饮'));
  assert.ok(tea.data.items.some(item => item.id === tenantBSampleId));
  assert.ok(tea.data.items.every(item => item.type === 'image' && item.tags.includes('茶饮')));
  assert.equal(tea.data.items[0].id, tenantBSampleId, '本租户自有样片排在平台样片之前');
  const teaC = await withServer(bossC, base => call(base, '/content/samples?tag=茶饮'));
  assert.equal(teaC.data.items.some(item => item.id === tenantBSampleId), false);
  assert.ok(teaC.data.items.every(item => item.scope === 'platform'));
  const bad = await withServer(bossB, base => call(base, '/content/samples?type=audio'));
  assert.equal(bad.response.status, 400);

  const detailC = await withServer(bossC, base => call(base, `/content/samples/${tenantBSampleId}`));
  assert.equal(detailC.response.status, 404);
  const detailPlatform = await withServer(bossC, base => call(base, `/content/samples/${platformSampleId}`));
  assert.equal(detailPlatform.response.status, 200);
  assert.equal(detailPlatform.data.canManage, false);
});

test('PATCH：租户老板改自有样片；平台样片只有平台超管能改；enabled:false 取消样片', async () => {
  const own = await withServer(bossB, base =>
    call(base, `/content/samples/${tenantBSampleId}`, { method: 'PATCH', body: { tags: ['茶饮', '夜景'], note: '改后的讲解词' } }),
  );
  assert.equal(own.response.status, 200, JSON.stringify(own.data));
  assert.deepEqual(own.data.tags, ['茶饮', '夜景']);
  assert.equal(own.data.note, '改后的讲解词');

  const bossOnPlatform = await withServer(bossB, base =>
    call(base, `/content/samples/${platformSampleId}`, { method: 'PATCH', body: { note: '越权' } }),
  );
  assert.equal(bossOnPlatform.response.status, 403);
  assert.equal(bossOnPlatform.data.code, 'CONTENT_SAMPLE_MANAGE_FORBIDDEN');

  const foreign = await withServer(bossC, base =>
    call(base, `/content/samples/${tenantBSampleId}`, { method: 'PATCH', body: { note: '越权' } }),
  );
  assert.equal(foreign.response.status, 404);

  const sales = await withServer(salesB, base =>
    call(base, `/content/samples/${tenantBSampleId}`, { method: 'PATCH', body: { note: '越权' } }),
  );
  assert.equal(sales.response.status, 403);

  const superEdit = await withServer(platformSuper, base =>
    call(base, `/content/samples/${platformSampleId}`, { method: 'PATCH', body: { name: '火锅门头·平台样片', tags: ['火锅', '门头', '夜景'] } }),
  );
  assert.equal(superEdit.response.status, 200);
  assert.equal(superEdit.data.name, '火锅门头·平台样片');

  const empty = await withServer(platformSuper, base =>
    call(base, `/content/samples/${platformSampleId}`, { method: 'PATCH', body: {} }),
  );
  assert.equal(empty.response.status, 400);

  const disabled = await withServer(bossB, base =>
    call(base, `/content/samples/${tenantBSampleId}`, { method: 'PATCH', body: { enabled: false } }),
  );
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.data.enabled, false);
  const listB = await withServer(bossB, base => call(base, '/content/samples'));
  assert.equal(listB.data.items.some(item => item.id === tenantBSampleId), false);
  assert.equal(q.get(`SELECT is_sample FROM materials WHERE id=?`, tenantBSampleId).is_sample, 0);
});

test('uploads 门禁：平台样片文件全租户可读；租户自有样片文件不可跨租户', async () => {
  // 重新把 B 店自有样片启用，验证文件门禁
  q.run(`UPDATE materials SET is_sample=1 WHERE id=?`, tenantBSampleId);
  const app = express();
  app.use(
    '/uploads',
    authMiddleware,
    (req, _res, next) => runWithTenant(req.user.tenant_id, () => next()),
    uploadAccessGuard,
    (_req, res) => res.send('ok'),
  );
  const server = app.listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  const base = `http://127.0.0.1:${port}`;
  const tokenFor = user => signToken({ id: user.id, username: user.name, name: user.name, role: user.role, tenant_id: user.tenant_id });
  const get = (url, user) => fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${tokenFor(user)}` } });
  try {
    assert.equal((await fetch(`${base}${platformFileUrl}`)).status, 401, '未登录不可读');
    assert.equal((await get(platformFileUrl, bossC)).status, 200, '平台样片跨租户可读');
    assert.equal((await get(platformFileUrl, salesB)).status, 200, '普通员工也能看平台样片');
    assert.equal((await get(tenantBFileUrl, bossB)).status, 200);
    assert.equal((await get(tenantBFileUrl, salesB)).status, 200, '本租户员工可看本租户样片');
    assert.equal((await get(tenantBFileUrl, bossC)).status, 404, '租户自有样片不可跨租户');
    assert.equal((await get(tenantBVideoUrl, bossC)).status, 404);
    q.run(`UPDATE materials SET is_sample=0 WHERE id=?`, tenantBSampleId);
    assert.equal((await get(tenantBFileUrl, salesB)).status, 404, '取消样片后回到原归属规则');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

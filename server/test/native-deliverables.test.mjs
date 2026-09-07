import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { once } from 'node:events';
import AdmZip from 'adm-zip';

Object.assign(process.env, { NANOWORK_DB: ':memory:', NODE_ENV: 'test', ENABLE_SCHEDULER: 'false', ENABLE_BACKGROUND_EMBEDDINGS: 'false' });
const { db, q, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
const { saveUploadedFile } = await import('../src/engines/filehub.js');
const { buildNativeDeliverable, readLocalVideo } = await import('../src/engines/native-deliverables.js');
const { default: routes } = await import('../src/routes/native-deliverables.js');
initSchema(); migrateV2();
assert.equal(db.prepare('PRAGMA database_list').get().file, '');
const tenantId = 8_800_000 + process.pid * 3;
const otherTenant = tenantId + 1;
for (const id of [tenantId, otherTenant]) q.run("INSERT INTO tenants(id,name,status,credits) VALUES(?,'打包隔离验收','已开通',1000000)", id);
const makeUser = tenant => Number(q.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES(?,'no-login','本地验收','sales','启用',?)", `bundle-${tenant}-${Math.random()}`, tenant).lastInsertRowid);
const actor = { id: makeUser(tenantId), tenant_id: tenantId, role: 'sales' };
const peer = { id: makeUser(tenantId), tenant_id: tenantId, role: 'sales' };
const other = { id: makeUser(otherTenant), tenant_id: otherTenant, role: 'sales' };
const files = [];
const output = { title: '今晚围着这锅坐', body: '这是保留下来的正文。\n\n' + '原始细节不截断。'.repeat(15000), tags: ['测试品牌'], firstComment: '你会先涮什么？' };
const createXhs = (count = 12, owner = actor) => runWithTenant(owner.tenant_id, () => {
  const id = Number(q.run("INSERT INTO contents(tenant_id,creator_id,title,body,type,source_type,snapshot_json) VALUES(?,?,?,?,?,'ai_xhs_note',?)",
    owner.tenant_id, owner.id, output.title, output.body, '小红书', JSON.stringify({ input: { brandName: '../../测试品牌', brief: '请按所选张数生成', imageCount: count, generateImages: true }, output })).lastInsertRowid);
  for (let index = 0; index < count; index++) {
    const bytes = Buffer.from(`saved-image-${index}`);
    const file = saveUploadedFile({ name: `成果${index + 1}.png`, b64: bytes.toString('base64'), mime: 'image/png', purpose: 'native-bundle-test', userId: owner.id }).row;
    files.push(file.file_path);
    q.run("INSERT INTO media_jobs(tenant_id,user_id,kind,status,url,snapshot_json) VALUES(?,?,'image','成功',?,?)", owner.tenant_id, owner.id, file.file_url,
      JSON.stringify({ source: 'ai_xhs_note_image', contentId: id, role: index ? `page-${index + 1}` : 'cover', label: index ? `第${index + 1}页` : '../../封面', status: 'success' }));
  }
  return id;
});
const xhsId = createXhs();
const foreignId = createXhs(6, other);
const app = express();
app.use((req, _res, next) => { req.user = req.headers['x-peer'] ? peer : actor; runWithTenant(tenantId, next); });
app.use('/downloads', routes);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  assert.equal(new URL(url).origin, base, '打包不允许调用供应商或远程下载');
  return originalFetch(url, init);
};
const nativeDir = fileURLToPath(new URL(`../data/uploads/ai-sales-video/${tenantId}/`, import.meta.url));
after(async () => {
  await new Promise(resolve => server.close(resolve));
  for (const file of files) fs.rmSync(file, { force: true });
  fs.rmSync(nativeDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch; db.close();
});

test('12图按顺序打包完整原文与首评，安全文件名且下载不写任务或费用', async () => {
  const before = db.prepare('SELECT total_changes() n').get().n;
  const response = await fetch(`${base}/downloads/xhs/${xhsId}/download`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
  const names = zip.getEntries().map(entry => entry.entryName);
  assert.equal(names.filter(name => name.startsWith('图片/')).length, 12);
  assert.ok(names.every(name => !name.includes('../') && !name.startsWith('/')));
  assert.ok(names.some(name => name.startsWith('图片/01-')));
  assert.ok(names.some(name => name.startsWith('图片/12-')));
  assert.ok(zip.readAsText('小红书文案.txt').includes(output.body));
  assert.equal(zip.readAsText('评论区首评.txt'), output.firstComment);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
});

test('图片缺失或失败仍交付可用文案和图片，并列明缺项，不将部分成果冒充完整套图', () => {
  const id = createXhs(6);
  runWithTenant(tenantId, () => {
    const rows = q.all("SELECT * FROM media_jobs WHERE tenant_id=? AND json_extract(snapshot_json,'$.contentId')=? ORDER BY id", tenantId, id);
    q.run("UPDATE media_jobs SET status='失败',url=NULL WHERE tenant_id=? AND id=?", tenantId, rows[1].id);
    const file = q.get('SELECT file_path FROM uploaded_files WHERE tenant_id=? AND file_url=?', tenantId, rows[2].url);
    fs.rmSync(file.file_path);
    const zip = new AdmZip(buildNativeDeliverable('xhs', id, actor).bytes);
    assert.equal(zip.getEntries().filter(entry => entry.entryName.startsWith('图片/')).length, 4);
    const note = zip.readAsText('交付说明.txt');
    assert.match(note, /选择图片：6张；本包包含：4张/);
    assert.match(note, /尚未完成/);
    assert.match(note, /本地文件暂不可读取/);
    assert.ok(zip.readAsText('小红书文案.txt').includes(output.body));
  });
});

test('跨企业和同企业其他普通账号均不能用ID下载，非法来源及空成果不冒充ZIP', async () => {
  assert.equal((await fetch(`${base}/downloads/xhs/${xhsId}/download`, { headers: { 'x-peer': '1' } })).status, 404);
  assert.equal((await fetch(`${base}/downloads/xhs/${foreignId}/download`)).status, 404);
  assert.equal((await fetch(`${base}/downloads/anything/${xhsId}/download`)).status, 404);
  assert.throws(() => runWithTenant(tenantId, () => buildNativeDeliverable('xhs', -1, actor)), { status: 404 });
  const empty = runWithTenant(tenantId, () => Number(q.run("INSERT INTO contents(tenant_id,creator_id,title,body,type,source_type,snapshot_json) VALUES(?,?,'等待生成','','小红书','ai_xhs_note','{}')", tenantId, actor.id).lastInsertRowid));
  const response = await fetch(`${base}/downloads/xhs/${empty}/download`);
  assert.equal(response.status, 409);
  assert.match(response.headers.get('content-type'), /application\/json/);
});

test('视频包复用本地成片和已确认脚本，不重新调用AI，也不跟随成片路径的符号链接', () => {
  runWithTenant(tenantId, () => {
    fs.mkdirSync(nativeDir, { recursive: true });
    const name = 'saved-native-delivery.mp4';
    const video = Buffer.from('local-video-file-preserved-byte-for-byte');
    fs.writeFileSync(path.join(nativeDir, name), video);
    const script = { shots: [{ start: 0, end: 15, voiceover: '今晚一起围炉坐坐。', visual: '缓慢推进菜品' }, { start: 15, end: 30, voiceover: '欢迎到店看看。', visual: '门头平稳停留' }] };
    const id = Number(q.run("INSERT INTO media_jobs(tenant_id,user_id,kind,status,url,snapshot_json) VALUES(?,?,'video','成功',?,?)", tenantId, actor.id, `/uploads/ai-sales-video/${tenantId}/${name}`, JSON.stringify({ workflow: 'ai_sales_video', script })).lastInsertRowid);
    const zip = new AdmZip(buildNativeDeliverable('sales', id, actor).bytes);
    assert.deepEqual(zip.readFile('带货视频.mp4'), video);
    assert.match(zip.readAsText('视频脚本.txt'), /欢迎到店看看/);
    fs.unlinkSync(path.join(nativeDir, name));
    fs.symlinkSync(files[0], path.join(nativeDir, name));
    const protectedZip = new AdmZip(buildNativeDeliverable('sales', id, actor).bytes);
    assert.equal(protectedZip.getEntry('带货视频.mp4'), null);
    assert.match(protectedZip.readAsText('交付说明.txt'), /视频本地文件暂不可打包/);
    assert.match(protectedZip.readAsText('视频脚本.txt'), /今晚一起围炉坐坐/);
  });
});

test('部署数据卷父目录可用符号链接，租户目录及成片仍禁止符号链接越界', () => {
  const sandbox = path.join(nativeDir, 'deployment-layout');
  const physical = path.join(sandbox, 'persistent', 'uploads', 'ai-sales-video');
  const tenant = path.join(physical, String(tenantId));
  fs.mkdirSync(tenant, { recursive: true });
  fs.symlinkSync(path.join(sandbox, 'persistent'), path.join(sandbox, 'data'));
  const managedRoot = path.join(sandbox, 'data', 'uploads', 'ai-sales-video');
  const bytes = Buffer.from('same-file-through-release-data-volume');
  fs.writeFileSync(path.join(tenant, 'delivery.mp4'), bytes);
  const url = `/uploads/ai-sales-video/${tenantId}/delivery.mp4`;
  assert.deepEqual(readLocalVideo(url, tenantId, managedRoot), bytes);
  fs.symlinkSync(path.join(tenant, 'delivery.mp4'), path.join(tenant, 'alias.mp4'));
  assert.throws(() => readLocalVideo(`/uploads/ai-sales-video/${tenantId}/alias.mp4`, tenantId, managedRoot));
  fs.renameSync(tenant, `${tenant}-outside`);
  fs.symlinkSync(`${tenant}-outside`, tenant);
  assert.throws(() => readLocalVideo(url, tenantId, managedRoot));
});

test('视频部分交付包保存原片段且不冒充成片，拒绝串用其他任务和哈希变化的片段', () => {
  runWithTenant(tenantId, () => {
    const bytes = Buffer.from('already-generated-original-segment');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const id = Number(q.run("INSERT INTO media_jobs(tenant_id,user_id,kind,status,snapshot_json) VALUES(?,?,'video','失败','{}')", tenantId, actor.id).lastInsertRowid);
    const name = `partial-${id}-1-${sha256.slice(0,24)}.mp4`;
    fs.mkdirSync(nativeDir, {recursive:true}); fs.writeFileSync(path.join(nativeDir,name),bytes);
    const snapshot = {workflow:'ai_sales_video',script:{shots:[{voiceover:'保存的真实脚本'}]},billing:{state:'pending_reconciliation'},partialResults:[{index:1,url:`/uploads/ai-sales-video/${tenantId}/${name}`,sha256,durationSeconds:15}]};
    const save = () => q.run('UPDATE media_jobs SET snapshot_json=? WHERE tenant_id=? AND id=?',JSON.stringify(snapshot),tenantId,id);
    save();
    const before = db.prepare('SELECT total_changes() n').get().n;
    const zip = new AdmZip(buildNativeDeliverable('sales',id,actor).bytes);
    assert.deepEqual(zip.readFile('已生成片段/01-15秒原片段.mp4'),bytes);
    assert.equal(zip.getEntry('带货视频.mp4'),null);
    assert.match(zip.readAsText('交付说明.txt'),/完整视频尚未完成/);
    assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
    snapshot.partialResults[0].url = `/uploads/ai-sales-video/${tenantId}/partial-${id+1}-1-${sha256.slice(0,24)}.mp4`;save();
    assert.equal(new AdmZip(buildNativeDeliverable('sales',id,actor).bytes).getEntry('已生成片段/01-15秒原片段.mp4'),null);
    snapshot.partialResults[0].url = `/uploads/ai-sales-video/${tenantId}/${name}`;save();
    fs.writeFileSync(path.join(nativeDir,name),'changed bytes');
    assert.equal(new AdmZip(buildNativeDeliverable('sales',id,actor).bytes).getEntry('已生成片段/01-15秒原片段.mp4'),null);
  });
});

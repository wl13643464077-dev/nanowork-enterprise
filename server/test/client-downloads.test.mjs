import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { createClientDownloadsRouter } from '../src/routes/client-downloads.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-client-downloads-'));
const file = 'NanoWork-0.1.1-windows-x64.exe';
const bytes = Buffer.from('MZ-isolated-download-fixture');
const release = { id: 'windows-x64', file, version: '0.1.1', sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
const manifest = releases => fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ releases }));
const app = express();
app.use(createClientDownloadsRouter({ directory }));
const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('无需登录即可下载真实安装包，返回附件并支持断点范围请求', async () => {
  fs.writeFileSync(path.join(directory, file), bytes);
  manifest([release]);
  const metadata = await (await fetch(`${base}/api/public/client-downloads`)).json();
  assert.equal(metadata.releases.length, 3);
  const item = metadata.releases.find(item => item.id === release.id);
  assert.equal(item.available, true); assert.equal(item.bytes, bytes.length);
  assert.equal(item.filePath, undefined); assert.equal(item.sha256, release.sha256);
  const response = await fetch(base + item.downloadUrl);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const partial = await fetch(base + item.downloadUrl, { headers: { Range: 'bytes=0-1' } });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), 'MZ');
  const head = await fetch(base + item.downloadUrl, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length));
});

test('未发布/损坏清单/缺少真实文件均不伪造可用链接，不退回SPA', async () => {
  fs.unlinkSync(path.join(directory, file));
  for (const value of [JSON.stringify({ releases: [release] }), '{bad-json']) {
    fs.writeFileSync(path.join(directory, 'manifest.json'), value);
    const metadata = await (await fetch(`${base}/api/public/client-downloads`)).json();
    assert.ok(metadata.releases.every(item => !item.available && !item.downloadUrl));
    const response = await fetch(`${base}/downloads/clients/windows-x64`);
    assert.equal(response.status, 404); assert.match(response.headers.get('content-type'), /json/);
  }
});

test('公开下载只允许固定平台及安装器文件，不允许越目录/符号链接/其他文件类型', async () => {
  fs.writeFileSync(path.join(directory, 'private.txt'), 'private');
  fs.symlinkSync(path.join(directory, 'private.txt'), path.join(directory, file));
  for (const candidate of [{ ...release, file: '../private.exe' }, { ...release, file: 'private.txt' }, release]) {
    manifest([candidate]);
    const response = await fetch(`${base}/downloads/clients/windows-x64`);
    assert.equal(response.status, 404);
  }
  for (const id of ['private.txt', 'manifest.json', 'anything', '..%2Fprivate.txt'])
    assert.equal((await fetch(`${base}/downloads/clients/${id}`)).status, 404);
});

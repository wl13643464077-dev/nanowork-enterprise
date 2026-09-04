import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { assertPrivateArtifact, protectPrivateArtifact, windowsAclFingerprints, writePrivateArtifact, writePrivateArtifactAsync, createPrivateArtifact } from '../src/engines/private-artifact.js';

test('原生文件权限限制在新生成文件，父目录不变，别名与目录不接受', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-private-artifact-'));
  try {
    const target = path.join(root, '中文 space & literal.json');
    const other = path.join(root, 'sibling.json');
    fs.writeFileSync(target, '', { flag: 'wx', mode: 0o666 });
    fs.writeFileSync(other, 'preserved', { flag: 'wx', mode: 0o666 });
    const fingerprint = () => process.platform === 'win32'
      ? windowsAclFingerprints([root, other])
      : [fs.statSync(root).mode, fs.statSync(other).mode];
    const before = fingerprint();
    if (process.platform === 'win32') assert.throws(() => assertPrivateArtifact(target), /Windows ACL/u);
    protectPrivateArtifact(target);
    assertPrivateArtifact(target);
    writePrivateArtifact(target, 'replacement', { overwrite: true });
    assertPrivateArtifact(target);
    assert.equal(fs.readFileSync(target, 'utf8'), 'replacement');
    assert.throws(() => writePrivateArtifact(target, 'forbidden overwrite'), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'replacement');
    assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
    fs.writeFileSync(target, '{"ok":true}\n');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"ok":true}\n');
    assert.deepEqual(fingerprint(), before);
    assert.throws(() => protectPrivateArtifact(root), /regular file/u);
    const alias = path.join(root, 'alias.json');
    fs.linkSync(target, alias);
    assert.throws(() => protectPrivateArtifact(alias), /unaliased/u);
    assert.throws(() => assertPrivateArtifact(target), /unaliased/u);
    fs.unlinkSync(alias);
    assertPrivateArtifact(target);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('异步私有图片写入不阻塞事件循环，不覆盖原文件且清理自建临时文件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-private-async-'));
  try {
    const target = path.join(root, 'overlay.png');
    let eventLoopTicked = false;
    const tick = new Promise(resolve => setImmediate(() => { eventLoopTicked = true; resolve(); }));
    await writePrivateArtifactAsync(target, Buffer.from('synthetic image bytes'));
    assert.equal(eventLoopTicked, true);
    await tick;
    assertPrivateArtifact(target);
    await assert.rejects(writePrivateArtifactAsync(target, Buffer.from('replacement')), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic image bytes');
    assert.deepEqual(fs.readdirSync(root), ['overlay.png']);
    assert.throws(() => createPrivateArtifact(target));
    assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic image bytes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

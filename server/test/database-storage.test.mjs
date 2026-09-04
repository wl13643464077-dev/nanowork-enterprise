import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { prepareDatabaseStorage } from '../src/engines/database-storage.js';
import { assertPrivateArtifact, windowsAclFingerprints, inspectWindowsPermissions } from '../src/engines/private-artifact.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const permissionFingerprint = target => process.platform === 'win32'
  ? windowsAclFingerprints([target])[0] : fs.statSync(target).mode & 0o777;

test('隔离模式不能落到应用data子目录，数据库硬链接在创建日志前拒绝', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-db-boundary-'));
  const dataDirectory = path.join(root, 'data');
  try {
    assert.throws(() => prepareDatabaseStorage({ databasePath: path.join(dataDirectory, 'nested', 'db.sqlite'),
      dataDirectory, protectDataDirectory: false }), /Isolated test database/u);
    assert.equal(fs.existsSync(dataDirectory), false);
    const original = path.join(root, 'original.db');
    const alias = path.join(root, 'alias.db');
    fs.writeFileSync(original, 'original synthetic bytes');
    fs.linkSync(original, alias);
    const permissions = permissionFingerprint(original);
    assert.throws(() => prepareDatabaseStorage({ databasePath: alias, dataDirectory, protectDataDirectory: false }), /unaliased/u);
    assert.equal(fs.readFileSync(original, 'utf8'), 'original synthetic bytes');
    assert.equal(permissionFingerprint(original), permissions);
    assert.equal(fs.existsSync(alias + '-wal'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('独立默认data目录具有可继承私有权限，重复打开/截断/关闭数据完整且不修改父目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-default-data-'));
  const dataDirectory = path.join(root, 'data');
  const databasePath = path.join(dataDirectory, 'private.sqlite');
  const beforeParent = permissionFingerprint(root);
  try {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      prepareDatabaseStorage({ databasePath, dataDirectory });
      const db = new DatabaseSync(databasePath);
      try {
        db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sentinel(id INTEGER PRIMARY KEY, body TEXT)');
        db.prepare('INSERT INTO sentinel(body) VALUES(?)').run(`cycle ${cycle}`);
        for (const suffix of ['', '-wal', '-shm']) assertPrivateArtifact(databasePath + suffix);
        assert.equal(db.prepare('SELECT count(*) n FROM sentinel').get().n, cycle + 1);
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        for (const suffix of ['', '-wal', '-shm']) assertPrivateArtifact(databasePath + suffix);
      } finally { db.close(); }
      assert.equal(fs.existsSync(databasePath + '-wal'), false);
      assert.equal(fs.existsSync(databasePath + '-shm'), false);
      assert.equal(fs.existsSync(databasePath + '-journal'), false);
    }
    const descendant = path.join(dataDirectory, 'new-descendant');
    fs.mkdirSync(descendant);
    const ordinaryFile = path.join(descendant, 'inherited.json');
    fs.writeFileSync(ordinaryFile, 'synthetic inheritance sentinel');
    if (process.platform === 'win32') {
      const [directory, child] = inspectWindowsPermissions([dataDirectory, ordinaryFile]);
      assert.equal(directory.private, true);
      assert.equal(child.restricted, true, 'Future descendants must not inherit broad parent access');
    } else {
      assert.equal(fs.statSync(dataDirectory).mode & 0o777, 0o700);
      assertPrivateArtifact(ordinaryFile);
    }
    assert.equal(permissionFingerprint(root), beforeParent);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('强制终止后保留热WAL，重开前不覆盖任何字节并恢复已提交数据', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-hot-wal-'));
  const databasePath = path.join(root, 'crash.sqlite');
  const dataDirectory = path.join(root, 'unused-default-data');
  const moduleUrl = new URL('../src/engines/database-storage.js', import.meta.url).href;
  try {
    const child = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const { prepareDatabaseStorage } = await import(${JSON.stringify(moduleUrl)});
      prepareDatabaseStorage(${JSON.stringify({ databasePath, dataDirectory, protectDataDirectory: false })});
      const db = new DatabaseSync(${JSON.stringify(databasePath)});
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE hot(note TEXT); INSERT INTO hot VALUES('committed before crash')");
      process.kill(process.pid, 'SIGKILL');
    `], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000 });
    assert.ok(child.signal || child.status !== 0, child.stderr);
    const files = ['', '-wal', '-shm'].map(suffix => databasePath + suffix);
    assert.ok(fs.statSync(files[1]).size > 0, 'Crash must actually leave a nonempty WAL');
    const before = files.map(file => hash(fs.readFileSync(file)));
    prepareDatabaseStorage({ databasePath, dataDirectory, protectDataDirectory: false });
    assert.deepEqual(files.map(file => hash(fs.readFileSync(file))), before);
    for (const file of files) assertPrivateArtifact(file);
    const db = new DatabaseSync(databasePath);
    try {
      assert.equal(db.prepare('SELECT note FROM hot').get().note, 'committed before crash');
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { db.close(); }
    assert.equal(fs.existsSync(dataDirectory), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

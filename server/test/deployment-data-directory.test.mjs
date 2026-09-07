import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { prepareDatabaseStorage } from '../src/engines/database-storage.js';
import { ensurePrivateDataDirectory, assertPrivateArtifact } from '../src/engines/private-artifact.js';

const posixOnly = { skip: process.platform === 'win32' && 'Deployment symlink contract is for the Linux release layout' };
const mode = file => fs.statSync(file).mode & 0o777;
const temporaryRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-deploy-data-')));

function linkedFixture(root) {
  const dataDirectory = path.join(root, 'release', 'server', 'data');
  const anchor = path.join(root, 'owned-data');
  fs.mkdirSync(path.dirname(dataDirectory), { recursive: true });
  fs.mkdirSync(anchor);
  fs.symlinkSync(anchor, dataDirectory, 'dir');
  return { dataDirectory, anchor, databasePath: path.join(dataDirectory, 'nanowork-industry.db') };
}

test('生产发布链接仅信任明确且真实的目录；数据库、父目录和重复开启保持完整', posixOnly, () => {
  const root = temporaryRoot();
  try {
    const fixture = linkedFixture(root);
    fs.chmodSync(root, 0o750);
    fs.chmodSync(fixture.anchor, 0o755);
    const parentBefore = mode(root);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      prepareDatabaseStorage({ ...fixture, trustedDataDirectory: fixture.anchor });
      const db = new DatabaseSync(fixture.databasePath);
      try {
        db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sentinel(note TEXT)');
        db.prepare('INSERT INTO sentinel VALUES (?)').run(`cycle ${cycle}`);
        assert.equal(db.prepare('SELECT count(*) n FROM sentinel').get().n, cycle + 1);
        for (const suffix of ['', '-wal', '-shm']) assertPrivateArtifact(fixture.databasePath + suffix);
      } finally { db.close(); }
    }
    assert.equal(mode(fixture.anchor), 0o700);
    assert.equal(mode(root), parentBefore);
    assert.equal(fs.lstatSync(fixture.dataDirectory).isSymbolicLink(), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('未配置、目标不符、链式链接、相对及根目录信任锚均拒绝且不更改目标权限', posixOnly, () => {
  const root = temporaryRoot();
  try {
    const fixture = linkedFixture(root);
    const unrelated = path.join(root, 'unrelated');
    const alias = path.join(root, 'anchor-alias');
    fs.mkdirSync(unrelated);
    fs.symlinkSync(fixture.anchor, alias, 'dir');
    fs.chmodSync(fixture.anchor, 0o755);
    fs.chmodSync(unrelated, 0o755);
    assert.throws(() => prepareDatabaseStorage({ ...fixture, trustedDataDirectory: null }), /must not be an alias/u);
    assert.throws(() => prepareDatabaseStorage({ ...fixture, trustedDataDirectory: unrelated }), /does not match/u);
    assert.throws(() => prepareDatabaseStorage({ ...fixture, trustedDataDirectory: alias }), /real unaliased/u);
    assert.throws(() => prepareDatabaseStorage({ ...fixture, trustedDataDirectory: 'owned-data' }), /absolute directory/u);
    assert.throws(() => prepareDatabaseStorage({ ...fixture, trustedDataDirectory: path.parse(root).root }), /root data trust anchor/u);
    fs.unlinkSync(fixture.dataDirectory);
    fs.symlinkSync(alias, fixture.dataDirectory, 'dir');
    assert.throws(() => prepareDatabaseStorage({ ...fixture, trustedDataDirectory: fixture.anchor }), /does not match/u);
    assert.equal(mode(fixture.anchor), 0o755);
    assert.equal(mode(unrelated), 0o755);
    assert.equal(fs.existsSync(fixture.databasePath), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('受信任目录链接不放行数据库或任一sidecar的符号链接、悬空链接与硬链接', posixOnly, () => {
  const root = temporaryRoot();
  try {
    let index = 0;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      for (const kind of ['symlink', 'dangling', 'hardlink']) {
        const caseRoot = path.join(root, String(index++));
        fs.mkdirSync(caseRoot);
        const fixture = linkedFixture(caseRoot);
        const target = path.join(caseRoot, 'outside-sentinel');
        if (kind !== 'dangling') {
          fs.writeFileSync(target, 'must remain untouched');
          fs.chmodSync(target, 0o640);
        }
        const alias = fixture.databasePath + suffix;
        if (kind === 'hardlink') fs.linkSync(target, alias);
        else fs.symlinkSync(target, alias);
        assert.throws(() => prepareDatabaseStorage({ ...fixture, trustedDataDirectory: fixture.anchor }), /unaliased/u, `${suffix || 'database'} ${kind}`);
        if (kind === 'dangling') assert.equal(fs.existsSync(target), false);
        else {
          assert.equal(fs.readFileSync(target, 'utf8'), 'must remain untouched');
          assert.equal(mode(target), 0o640);
        }
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('受信任data中的嵌套目录不得逃逸，隔离测试不得通过真实路径使用生产data', posixOnly, () => {
  const root = temporaryRoot();
  try {
    const fixture = linkedFixture(root);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(fixture.anchor, 'nested'), 'dir');
    assert.throws(() => prepareDatabaseStorage({ ...fixture,
      databasePath: path.join(fixture.dataDirectory, 'nested', 'escaped.db'), trustedDataDirectory: fixture.anchor }), /must not escape/u);
    assert.throws(() => prepareDatabaseStorage({ ...fixture,
      databasePath: path.join(fixture.anchor, 'isolated.db'), protectDataDirectory: false }), /Isolated test database/u);
    assert.equal(fs.readdirSync(outside).length, 0);
    assert.equal(fs.existsSync(path.join(fixture.anchor, 'isolated.db')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('真实目录无配置保持兼容，显式信任锚也可直接指向该目录', () => {
  const root = temporaryRoot();
  try {
    const directory = path.join(root, 'data');
    assert.equal(ensurePrivateDataDirectory(directory), directory);
    assert.equal(ensurePrivateDataDirectory(directory, { trustedDirectory: directory }), directory);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function migrationFixture(root, useLink) {
  const release = path.join(root, 'release');
  const engines = path.join(release, 'server', 'src', 'engines');
  const scripts = path.join(release, 'scripts');
  fs.mkdirSync(engines, { recursive: true });
  fs.mkdirSync(path.join(scripts, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(release, 'package.json'), '{"type":"module"}');
  for (const file of ['database-storage.js', 'private-artifact.js']) {
    fs.copyFileSync(new URL(`../src/engines/${file}`, import.meta.url), path.join(engines, file));
  }
  fs.copyFileSync(new URL('../../scripts/migrate.mjs', import.meta.url), path.join(scripts, 'migrate.mjs'));
  fs.writeFileSync(path.join(scripts, 'migrations', '0001-sentinel.mjs'),
    "export function up(db) { db.exec(\"CREATE TABLE migration_result(note TEXT); INSERT INTO migration_result VALUES('migration applied')\"); }\n");
  const dataDirectory = path.join(release, 'server', 'data');
  const anchor = useLink ? path.join(root, 'owned-data') : dataDirectory;
  fs.mkdirSync(anchor);
  if (useLink) fs.symlinkSync(anchor, dataDirectory, 'dir');
  const databasePath = path.join(anchor, 'nanowork-industry.db');
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE sentinel(note TEXT); INSERT INTO sentinel VALUES('existing business data')");
  db.close();
  return { anchor, databasePath, scripts, snapshots: path.join(root, 'snapshots') };
}

test('真实migrate CLI在真实目录及显式信任的release链接上完成快照和迁移，无配置链接在写库前拒绝', posixOnly, () => {
  const root = temporaryRoot();
  try {
    for (const kind of ['directory', 'trusted-link', 'untrusted-link']) {
      const caseRoot = path.join(root, kind);
      fs.mkdirSync(caseRoot);
      const fixture = migrationFixture(caseRoot, kind !== 'directory');
      const before = fs.readFileSync(fixture.databasePath);
      const child = spawnSync(process.execPath, ['--no-warnings', path.join(fixture.scripts, 'migrate.mjs'), 'up'], {
        env: { ...process.env, NODE_ENV: 'production', NANOWORK_DB: '',
          NANOWORK_DATA_DIR: kind === 'trusted-link' ? fixture.anchor : '', MIGRATE_SNAPSHOT_DIR: fixture.snapshots },
        encoding: 'utf8', shell: false, timeout: 30_000,
      });
      if (kind === 'untrusted-link') {
        assert.notEqual(child.status, 0);
        assert.match(child.stderr, /Application data directory must not be an alias/u);
        assert.deepEqual(fs.readFileSync(fixture.databasePath), before);
        assert.equal(fs.existsSync(fixture.snapshots), false);
        continue;
      }
      assert.equal(child.status, 0, `${kind}: ${child.stderr}\n${child.stdout}`);
      const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT note FROM sentinel').get().note, 'existing business data');
        assert.equal(db.prepare('SELECT note FROM migration_result').get().note, 'migration applied');
        assert.equal(db.prepare('SELECT version FROM schema_migrations').get().version, 1);
        assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      } finally { db.close(); }
      const snapshots = fs.readdirSync(fixture.snapshots);
      assert.equal(snapshots.length, 1);
      assertPrivateArtifact(path.join(fixture.snapshots, snapshots[0]));
      const snapshot = new DatabaseSync(path.join(fixture.snapshots, snapshots[0]), { readOnly: true });
      try {
        assert.equal(snapshot.prepare('SELECT note FROM sentinel').get().note, 'existing business data');
        assert.equal(snapshot.prepare("SELECT count(*) n FROM sqlite_master WHERE name='migration_result'").get().n, 0);
      } finally { snapshot.close(); }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

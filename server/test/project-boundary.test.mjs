import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { assertPrivateArtifact, windowsAclFingerprints, inspectWindowsPermissions } from '../src/engines/private-artifact.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('新项目运行时和迁移器只接受 NANOWORK_DB，不兼容旧项目数据库变量', () => {
  for (const relative of ['server/src/db.js', 'scripts/migrate.mjs']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /process\.env\.SHANMEI_DB/, `${relative} 不得读取旧项目数据库变量`);
  }
});

test('说明文档不得把旧项目数据库变量描述为受支持配置', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /SHANMEI_DB/, 'README 只能说明新项目 NANOWORK_DB');
});

test('生产模式运行库与迁移器保护默认data和数据库原生权限，自定义父目录与系统Temp不变', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-data-permissions-'));
  const customParent = path.join(temporaryRoot, 'custom-parent');
  const dbPath = path.join(customParent, 'runtime.sqlite');
  const projectData = path.join(ROOT, 'server', 'data');
  const modeOf = target => fs.statSync(target).mode & 0o777;
  fs.mkdirSync(customParent, { mode: 0o755 });
  fs.chmodSync(customParent, 0o755);
  const parents = [customParent, os.tmpdir(), projectData].filter(target => fs.existsSync(target));
  const parentPermissions = () => process.platform === 'win32' ? windowsAclFingerprints(parents) : parents.map(modeOf);
  const beforeParents = parentPermissions();

  // Stage the actual runtime/migrator sources, not a substitute implementation,
  // so production-mode directory ACL changes never touch the user's live tree.
  const stagedRoot = path.join(temporaryRoot, 'isolated-project');
  for (const relative of ['server/package.json', 'server/src/db.js', 'server/src/env.js',
    'server/src/engines/private-artifact.js', 'server/src/engines/database-storage.js',
    'server/src/engines/windows-private-artifact.ps1', 'scripts/migrate.mjs']) {
    const destination = path.join(stagedRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), destination);
  }
  const stagedData = path.join(stagedRoot, 'server/data');
  const assertPrivateDirectory = () => process.platform === 'win32'
    ? assert.equal(inspectWindowsPermissions([stagedData])[0].private, true)
    : assert.equal(modeOf(stagedData), 0o700);

  try {
    const dbUrl = pathToFileURL(path.join(stagedRoot, 'server', 'src', 'db.js')).href;
    const runtime = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import fs from 'node:fs';
       const { db } = await import(${JSON.stringify(dbUrl)});
       const { assertPrivateArtifact } = await import(${JSON.stringify(pathToFileURL(path.join(stagedRoot, 'server/src/engines/private-artifact.js')).href)});
       db.exec("CREATE TABLE private_boundary(id INTEGER PRIMARY KEY, note TEXT); INSERT INTO private_boundary(note) VALUES('isolated sentinel')");
       for (const suffix of ['', '-wal', '-shm']) assertPrivateArtifact(${JSON.stringify(dbPath)} + suffix);
       console.log(JSON.stringify({ strategy: process.platform === 'win32' ? 'windows_acl' : 'posix_0600', umask: process.umask().toString(8), privateFiles: 3 }));
       db.close();`], {
      cwd: ROOT,
      env: { ...process.env, NANOWORK_DB: dbPath, NODE_ENV: 'development', NANOWORK_TEST_TEMPLATE_AI: '1' },
      encoding: 'utf8',
    });
    assert.equal(runtime.status, 0, runtime.stderr);
    const proof = JSON.parse(runtime.stdout.trim());
    assert.equal(proof.privateFiles, 3);
    assert.equal(proof.strategy, process.platform === 'win32' ? 'windows_acl' : 'posix_0600');
    if (process.platform !== 'win32') assert.equal(proof.umask, '77');
    assertPrivateArtifact(dbPath);
    assertPrivateDirectory();
    assert.deepEqual(parentPermissions(), beforeParents);

    if (process.platform === 'win32') {
      // Copying to a newly-created, inherited-ACL file deliberately weakens the
      // synthetic DB only; the migration must restore privacy without new data.
      const copied = path.join(customParent, 'inherited.sqlite');
      fs.writeFileSync(copied, fs.readFileSync(dbPath), { flag: 'wx', mode: 0o666 });
      fs.renameSync(copied, dbPath);
      assert.throws(() => assertPrivateArtifact(dbPath), /Windows ACL/u);
    } else fs.chmodSync(dbPath, 0o666);
    // This is the isolated, empty data directory created above, not live data.
    fs.rmdirSync(stagedData);
    fs.mkdirSync(stagedData, { mode: 0o755 });
    const migrateUrl = pathToFileURL(path.join(stagedRoot, 'scripts', 'migrate.mjs')).href;
    const migration = spawnSync(process.execPath, ['--input-type=module', '-e',
      `process.umask(0o022); await import(${JSON.stringify(migrateUrl)}); console.log('umask=' + process.umask().toString(8));`], {
      cwd: ROOT,
      env: { ...process.env, NANOWORK_DB: dbPath, NODE_ENV: 'development', NANOWORK_TEST_TEMPLATE_AI: '1' },
      encoding: 'utf8',
    });
    assert.equal(migration.status, 0, migration.stderr);
    if (process.platform !== 'win32') assert.match(migration.stdout, /umask=77/);
    assertPrivateArtifact(dbPath);
    assertPrivateDirectory();
    assert.deepEqual(parentPermissions(), beforeParents);
    const check = new DatabaseSync(dbPath, { readOnly: true });
    try { assert.equal(check.prepare('SELECT note FROM private_boundary').get().note, 'isolated sentinel'); }
    finally { check.close(); }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

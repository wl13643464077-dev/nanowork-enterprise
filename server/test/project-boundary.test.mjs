import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

test('运行库使用077 umask、项目data为0700、数据库为0600且不修改临时父目录', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-data-permissions-'));
  const customParent = path.join(temporaryRoot, 'custom-parent');
  const dbPath = path.join(customParent, 'runtime.sqlite');
  const projectData = path.join(ROOT, 'server', 'data');
  const modeOf = target => fs.statSync(target).mode & 0o777;
  fs.mkdirSync(customParent, { mode: 0o755 });
  fs.chmodSync(customParent, 0o755);
  const temporaryParentMode = modeOf(os.tmpdir());

  try {
    const dbUrl = pathToFileURL(path.join(ROOT, 'server', 'src', 'db.js')).href;
    const runtime = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { db } = await import(${JSON.stringify(dbUrl)}); console.log(process.umask().toString(8)); db.close();`], {
      cwd: ROOT,
      env: { ...process.env, NANOWORK_DB: dbPath },
      encoding: 'utf8',
    });
    assert.equal(runtime.status, 0, runtime.stderr);
    assert.equal(runtime.stdout.trim(), '77');
    assert.equal(modeOf(projectData), 0o700);
    assert.equal(modeOf(dbPath), 0o600);
    assert.equal(modeOf(customParent), 0o755, '不得 chmod 自定义数据库父目录');
    assert.equal(modeOf(os.tmpdir()), temporaryParentMode, '不得 chmod /tmp 父目录');

    fs.chmodSync(dbPath, 0o666);
    const migrateUrl = pathToFileURL(path.join(ROOT, 'scripts', 'migrate.mjs')).href;
    const migration = spawnSync(process.execPath, ['--input-type=module', '-e',
      `process.umask(0o022); await import(${JSON.stringify(migrateUrl)}); console.log('umask=' + process.umask().toString(8));`], {
      cwd: ROOT,
      env: { ...process.env, NANOWORK_DB: dbPath },
      encoding: 'utf8',
    });
    assert.equal(migration.status, 0, migration.stderr);
    assert.match(migration.stdout, /umask=77/);
    assert.equal(modeOf(dbPath), 0o600);
    assert.equal(modeOf(customParent), 0o755, '迁移器不得 chmod 自定义数据库父目录');
    assert.equal(modeOf(os.tmpdir()), temporaryParentMode, '迁移器不得 chmod /tmp 父目录');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

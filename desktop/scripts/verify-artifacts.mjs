import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const platform = process.argv[2];
const requestedOutputDirectory = process.argv[3];
const outputDirectory = requestedOutputDirectory
  ? resolve(process.cwd(), requestedOutputDirectory)
  : resolve(scriptDirectory, '../dist');
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

if (!['mac', 'win'].includes(platform)) {
  console.error('用法：node scripts/verify-artifacts.mjs <mac|win> [output-directory]');
  process.exit(2);
}

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    result.push(path);
    if (entry.isDirectory()) result.push(...(await walk(path)));
  }
  return result;
}

function countExtensions(paths, extension) {
  return paths.filter(path => extname(path).toLowerCase() === extension).length;
}

function validateAsar(archivePath) {
  const entries = asar.listPackage(archivePath).map(name => name.replace(/^\//, ''));
  const forbidden = entries.filter(name => /(^|\/)(server|uploads|artifacts)(\/|$)|(^|\/)\.env($|\.)|\.(sqlite|sqlite3|db)$/i.test(name));
  assert.deepEqual(forbidden, [], `app.asar 含禁止内容：${forbidden.join(', ')}`);
  const unexpectedApplicationFiles = entries.filter(name =>
    !/^(node_modules(?:\/|$)|assets(?:$|\/icon\.png$)|renderer(?:\/|$)|src(?:\/|$)|package\.json$)/.test(name),
  );
  assert.deepEqual(unexpectedApplicationFiles, [], `app.asar 超出白名单：${unexpectedApplicationFiles.join(', ')}`);
  const manifest = JSON.parse(asar.extractFile(archivePath, 'package.json').toString('utf8'));
  assert.equal(manifest.main, 'src/main.cjs');
  assert.deepEqual(manifest.dependencies, { 'electron-updater': '6.8.9' });
  assert.equal(manifest.scripts, undefined, '打包后 package.json 不得保留构建脚本');
  assert.equal(manifest.devDependencies, undefined, '打包后 package.json 不得保留开发依赖');
}

async function main() {
  assert.equal((await stat(outputDirectory)).isDirectory(), true, '缺少 desktop/dist');
  const paths = await walk(outputDirectory);
  const names = paths.map(path => path.slice(outputDirectory.length + 1).replaceAll('\\', '/'));
  const lowerNames = names.map(name => name.toLowerCase());
  const forbidden = lowerNames.filter(name => /(^|\/)(server|uploads|artifacts)(\/|$)|\.env($|\.)|\.(sqlite|sqlite3|db)$/.test(name));
  assert.deepEqual(forbidden, [], `产物含禁止内容：${forbidden.join(', ')}`);
  const archives = paths.filter(path => path.toLowerCase().endsWith('/resources/app.asar'));
  assert.ok(archives.length > 0, '产物缺少 resources/app.asar');
  for (const archive of archives) validateAsar(archive);
  if (platform === 'mac') {
    assert.ok(countExtensions(paths, '.dmg') >= 2, 'macOS 必须同时产出 x64/arm64 DMG');
    assert.ok(countExtensions(paths, '.zip') >= 2, 'macOS 必须同时产出 x64/arm64 ZIP');
    assert.ok(names.some(name => name.includes('.app/Contents/MacOS/')), 'macOS 解包产物缺少可执行文件');
  } else {
    assert.ok(countExtensions(paths, '.exe') >= 2, 'Windows 必须产出 NSIS 安装器和解包可执行文件');
    assert.ok(countExtensions(paths, '.zip') >= 1, 'Windows 必须产出 x64 ZIP');
    assert.ok(names.some(name => /win-unpacked\/.+\.exe$/i.test(name)), 'Windows 解包产物缺少应用 EXE');
  }
  console.log(`${platform === 'mac' ? 'macOS' : 'Windows'} 产物结构校验通过：${paths.length} 个文件/目录，无后端、密钥或业务数据入包。`);
}

main().catch(error => {
  console.error(`${basename(outputDirectory)} 产物校验失败：${error.message}`);
  process.exitCode = 1;
});

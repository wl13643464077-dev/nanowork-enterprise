import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPackagedAsarName, toArtifactName } from './artifact-paths.mjs';

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

async function requireNonemptyFile(path, label) {
  const metadata = await stat(path);
  assert.equal(metadata.isFile(), true, `${label}必须是文件：${path}`);
  assert.ok(metadata.size > 0, `${label}不能为空：${path}`);
}

async function requireArtifacts(names, label) {
  await Promise.all(
    names.map(name =>
      requireNonemptyFile(join(outputDirectory, ...name.split('/')), `${label} ${name}`),
    ),
  );
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
  const sourceManifest = JSON.parse(
    await readFile(resolve(scriptDirectory, '../package.json'), 'utf8'),
  );
  const buildConfig = JSON.parse(
    await readFile(resolve(scriptDirectory, '../electron-builder.yml'), 'utf8'),
  );
  const releasePrefix = `NanoWork-${sourceManifest.version}`;
  const productName = buildConfig.productName;
  const paths = await walk(outputDirectory);
  const names = paths.map(path => toArtifactName(outputDirectory, path));
  const lowerNames = names.map(name => name.toLowerCase());
  const forbidden = lowerNames.filter(name => /(^|\/)(server|uploads|artifacts)(\/|$)|\.env($|\.)|\.(sqlite|sqlite3|db)$/.test(name));
  assert.deepEqual(forbidden, [], `产物含禁止内容：${forbidden.join(', ')}`);
  const archiveEntries = paths
    .map((path, index) => ({ path, name: names[index] }))
    .filter(({ name }) => isPackagedAsarName(name));
  assert.ok(archiveEntries.length > 0, '产物缺少 resources/app.asar');
  for (const archive of archiveEntries) validateAsar(archive.path);
  if (platform === 'mac') {
    const expectedPackages = [
      `${releasePrefix}-mac-x64.dmg`,
      `${releasePrefix}-mac-arm64.dmg`,
      `${releasePrefix}-mac-x64.zip`,
      `${releasePrefix}-mac-arm64.zip`,
    ];
    const expectedArchives = [
      `mac/${productName}.app/Contents/Resources/app.asar`,
      `mac-arm64/${productName}.app/Contents/Resources/app.asar`,
    ];
    const expectedExecutables = [
      `mac/${productName}.app/Contents/MacOS/${productName}`,
      `mac-arm64/${productName}.app/Contents/MacOS/${productName}`,
    ];
    await requireArtifacts(expectedPackages, 'macOS 发行包');
    await requireArtifacts(expectedExecutables, 'macOS 解包可执行文件');
    assert.deepEqual(
      archiveEntries.map(({ name }) => name).sort(),
      expectedArchives.sort(),
      'macOS x64/arm64 解包产物必须各含一个 app.asar',
    );
    assert.ok(countExtensions(paths, '.dmg') >= 2, 'macOS 必须同时产出 x64/arm64 DMG');
    assert.ok(countExtensions(paths, '.zip') >= 2, 'macOS 必须同时产出 x64/arm64 ZIP');
  } else {
    const expectedPackages = [
      `${releasePrefix}-win-x64.exe`,
      `${releasePrefix}-win-x64.zip`,
    ];
    const expectedArchive = 'win-unpacked/resources/app.asar';
    const expectedExecutable = `win-unpacked/${productName}.exe`;
    await requireArtifacts(expectedPackages, 'Windows 发行包');
    await requireArtifacts([expectedExecutable], 'Windows 解包可执行文件');
    assert.deepEqual(
      archiveEntries.map(({ name }) => name),
      [expectedArchive],
      'Windows 解包产物必须含且仅含一个 app.asar',
    );
    assert.ok(countExtensions(paths, '.exe') >= 2, 'Windows 必须产出 NSIS 安装器和解包可执行文件');
    assert.ok(countExtensions(paths, '.zip') >= 1, 'Windows 必须产出 x64 ZIP');
  }
  console.log(`${platform === 'mac' ? 'macOS' : 'Windows'} 产物结构校验通过：${paths.length} 个文件/目录，无后端、密钥或业务数据入包。`);
}

main().catch(error => {
  console.error(`${basename(outputDirectory)} 产物校验失败：${error.message}`);
  process.exitCode = 1;
});

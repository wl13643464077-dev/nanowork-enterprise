import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const repositoryDirectory = resolve(desktopDirectory, '..');
const expectedFileAllowlist = ['src/**/*', 'renderer/**/*', 'assets/icon.png', 'package.json'];

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function requireFile(path, label) {
  const metadata = await stat(path);
  assert.equal(metadata.isFile(), true, `${label}必须是文件：${path}`);
  assert.ok(metadata.size > 0, `${label}不能为空：${path}`);
}

function targetMap(targets) {
  return new Map(targets.map(item => [item.target, [...item.arch].sort()]));
}

function validateTargets(config) {
  const macTargets = targetMap(config.mac.target);
  assert.deepEqual(macTargets.get('dmg'), ['arm64', 'x64']);
  assert.deepEqual(macTargets.get('zip'), ['arm64', 'x64']);
  const windowsTargets = targetMap(config.win.target);
  assert.deepEqual(windowsTargets.get('nsis'), ['x64']);
  assert.deepEqual(windowsTargets.get('zip'), ['x64']);
}

function readPngDimensions(png) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(png.subarray(0, 8), signature, 'assets/icon.png 不是有效 PNG');
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR', 'PNG 缺少 IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function validateAssets() {
  const source = await readFile(join(repositoryDirectory, 'web/public/brand/nanowork-icon.svg'));
  const sourceCopy = await readFile(join(desktopDirectory, 'assets/icon.svg'));
  assert.deepEqual(sourceCopy, source, '桌面图标源与 Web 品牌 SVG 不一致，请运行 npm run icons');
  const png = await readFile(join(desktopDirectory, 'assets/icon.png'));
  assert.deepEqual(readPngDimensions(png), { width: 1024, height: 1024 });
  const icns = await readFile(join(desktopDirectory, 'assets/icon.icns'));
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns', 'assets/icon.icns 头无效');
  assert.equal(icns.readUInt32BE(4), icns.length, 'assets/icon.icns 长度头无效');
  const ico = await readFile(join(desktopDirectory, 'assets/icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0, 'assets/icon.ico reserved 字段无效');
  assert.equal(ico.readUInt16LE(2), 1, 'assets/icon.ico 类型无效');
  assert.ok(ico.readUInt16LE(4) >= 7, 'assets/icon.ico 应包含至少 7 个分辨率');
  await requireFile(join(desktopDirectory, 'assets/entitlements.mac.plist'), 'macOS entitlements');
}

async function validateWorkflow() {
  const workflow = await readFile(join(repositoryDirectory, '.github/workflows/desktop-build.yml'), 'utf8');
  for (const marker of ['runs-on: macos-14', 'runs-on: windows-2022', 'npm ci', 'npm run verify', 'npm run dist:mac', 'npm run dist:win', 'actions/upload-artifact@v4']) {
    assert.ok(workflow.includes(marker), `桌面 CI 缺少：${marker}`);
  }
  assert.equal(/\bpublish\b\s*:\s*(always|onTagOrDraft)/.test(workflow), false, '桌面 CI 不得发布安装包');
}

async function main() {
  const manifest = await readJson(join(desktopDirectory, 'package.json'));
  const config = await readJson(join(desktopDirectory, 'electron-builder.yml'));
  const rootManifest = await readJson(join(repositoryDirectory, 'package.json'));
  assert.equal(manifest.private, true);
  assert.equal(manifest.main, 'src/main.cjs');
  assert.equal(manifest.dependencies['electron-updater'], '6.8.9');
  assert.equal(manifest.devDependencies.electron, '43.4.1');
  assert.equal(manifest.devDependencies['electron-builder'], '26.15.7');
  assert.ok(manifest.scripts.verify.startsWith('npm run icons &&'), '校验前必须从品牌 SVG 重建图标');
  assert.equal(config.electronVersion, manifest.devDependencies.electron);
  assert.deepEqual(config.toolsets, { winCodeSign: '1.1.0', nsis: '1.2.1', wine: '1.0.1' });
  assert.equal(config.asar, true);
  assert.equal(config.npmRebuild, false);
  assert.equal(config.artifactName.includes('${arch}'), true, '产物名必须包含架构，避免双架构覆盖');
  assert.deepEqual(config.files, [{ from: '.', filter: expectedFileAllowlist }]);
  assert.equal(JSON.stringify(config.files).match(/server|\.env|sqlite|uploads|artifacts/iu), null);
  assert.equal(config.mac.icon, 'assets/icon.icns');
  assert.equal(config.win.icon, 'assets/icon.ico');
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.win.requestedExecutionLevel, 'asInvoker');
  validateTargets(config);
  for (const script of ['desktop:start', 'desktop:smoke', 'desktop:test', 'desktop:verify', 'desktop:icons', 'desktop:pack', 'desktop:dist:mac', 'desktop:dist:win']) {
    assert.ok(rootManifest.scripts[script], `根 package.json 缺少 ${script}`);
  }
  await Promise.all([
    requireFile(join(desktopDirectory, manifest.main), 'Electron main 入口'),
    requireFile(join(desktopDirectory, 'renderer/settings.html'), '服务器设置页'),
    validateAssets(),
    validateWorkflow(),
  ]);
  console.log('桌面打包配置校验通过：严格白名单、双平台目标、品牌图标和 CI 契约均有效。');
}

main().catch(error => {
  console.error(`桌面打包配置校验失败：${error.message}`);
  process.exitCode = 1;
});

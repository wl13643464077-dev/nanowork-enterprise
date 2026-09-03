import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAllowedAsarEntryName,
  isPackagedAsarName,
  normalizeAsarEntryName,
  toPortablePath,
} from '../scripts/artifact-paths.mjs';

test('artifact paths use one portable representation on Windows and POSIX', () => {
  assert.equal(
    toPortablePath('win-unpacked\\resources\\app.asar'),
    'win-unpacked/resources/app.asar',
  );
  assert.equal(
    toPortablePath('mac/纳米Work.app/Contents/Resources/app.asar'),
    'mac/纳米Work.app/Contents/Resources/app.asar',
  );
});

test('packaged app.asar detection accepts both platform separators without accepting lookalikes', () => {
  for (const name of [
    'win-unpacked\\resources\\app.asar',
    'win-unpacked/resources/app.asar',
    'mac/纳米Work.app/Contents/Resources/app.asar',
  ]) {
    assert.equal(isPackagedAsarName(name), true, name);
  }

  for (const name of [
    'resources/app.asar.unpacked',
    'win-unpacked/resources/app.asar.backup',
    'win-unpacked/app.asar',
  ]) {
    assert.equal(isPackagedAsarName(name), false, name);
  }
});

test('ASAR entries normalize Windows separators and every leading separator', () => {
  assert.equal(
    normalizeAsarEntryName('\\node_modules\\electron-updater\\package.json'),
    'node_modules/electron-updater/package.json',
  );
  assert.equal(
    normalizeAsarEntryName('///renderer/settings.html'),
    'renderer/settings.html',
  );
  assert.equal(normalizeAsarEntryName('src/main.cjs'), 'src/main.cjs');
});

test('ASAR entry allowlist keeps the packaged application boundary unchanged on Windows', () => {
  for (const name of [
    '\\node_modules\\electron-updater\\package.json',
    '\\src\\main.cjs',
    '\\renderer\\settings.html',
    '\\assets\\icon.png',
    '\\package.json',
  ]) {
    assert.equal(isAllowedAsarEntryName(name), true, name);
  }

  for (const name of [
    '\\assets\\icon.svg',
    '\\assets\\nested\\icon.png',
    '\\server\\index.js',
    '\\uploads\\receipt.png',
    '\\artifacts\\report.pdf',
    '\\.env',
    '\\business.sqlite',
    '\\package-lock.json',
  ]) {
    assert.equal(isAllowedAsarEntryName(name), false, name);
  }
});

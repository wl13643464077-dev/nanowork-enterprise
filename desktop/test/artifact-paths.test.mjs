import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPackagedAsarName,
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageServerRuntime } from './helpers/stage-server-runtime.mjs';
import {
  jwtSecretStrengthError,
  platformSuperPasswordStrengthError,
} from '../src/security-config.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strongJwt = '8xQ!2vZ#7mL@4pR$9cT%6kN&3wF*5sH?';

function runProductionProbe(modulePath, env = {}) {
  const dbPath = path.join(os.tmpdir(), `nanowork-production-config-${process.pid}-${Math.random().toString(16).slice(2)}.db`);
  const stage = stageServerRuntime();
  const moduleUrl = pathToFileURL(path.join(stage.serverDir, modulePath)).href;
  const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)});`], {
    cwd: stage.serverDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NANOWORK_DB: dbPath,
      SEED_DEMO: 'false',
      HOST: '127.0.0.1',
      PORT: '0',
      ...env,
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(file, { force: true });
  stage.cleanup();
  return { ...result, output: `${result.stdout || ''}\n${result.stderr || ''}` };
}

test('生产 JWT_SECRET 强度规则拒绝短值、重复值和占位值', () => {
  assert.match(jwtSecretStrengthError('too-short'), /至少 32 字节/);
  assert.match(jwtSecretStrengthError('a'.repeat(64)), /字符变化不足/);
  assert.match(jwtSecretStrengthError('change-me-this-is-an-example-jwt-key-123456789'), /占位/);
  assert.equal(jwtSecretStrengthError(strongJwt), '');
});

test('生产平台超管密码强度规则要求长度与字符类型', () => {
  assert.match(platformSuperPasswordStrengthError('Short1!'), /至少 12 位/);
  assert.match(platformSuperPasswordStrengthError('all-lowercase-only'), /至少三类/);
  assert.equal(platformSuperPasswordStrengthError('NanoWork-Admin#2026'), '');
});

test('生产运行时拒绝弱 JWT_SECRET', () => {
  const result = runProductionProbe('src/util.js', { JWT_SECRET: 'too-short' });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /JWT_SECRET.*至少 32 字节/);
});

test('空库生产首启拒绝弱 PLATFORM_SUPER_PASSWORD', () => {
  const result = runProductionProbe('src/index.js', {
    JWT_SECRET: strongJwt,
    PLATFORM_SUPER_PASSWORD: 'weak-password',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /PLATFORM_SUPER_PASSWORD.*至少三类/);
});

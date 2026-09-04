import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { test } from 'node:test';
import { initialEnvironment, parseLocalEnv, localSettings } from '../../scripts/local-setup.mjs';
import { portOccupied, syncSource } from '../../scripts/local-start.mjs';

test('local env parsing matches literal quoted values and never evaluates shell input', () => {
  assert.deepEqual(parseLocalEnv('# comment\nA="x=y"\r\nB=\'literal # text\'\nC=\nD=$(not-executed)\n'), {
    A: 'x=y', B: 'literal # text', C: '', D: '$(not-executed)',
  });
});

test('new installations receive independent secrets and keep safe template defaults', () => {
  const template = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const first = parseLocalEnv(initialEnvironment(template));
  const second = parseLocalEnv(initialEnvironment(template));
  assert.match(first.JWT_SECRET, /^[a-f0-9]{64}$/u);
  assert.notEqual(first.JWT_SECRET, second.JWT_SECRET);
  assert.notEqual(first.PLATFORM_SUPER_PASSWORD, second.PLATFORM_SUPER_PASSWORD);
  assert.ok(first.PLATFORM_SUPER_PASSWORD.length >= 24);
  assert.equal(first.SEED_DEMO, 'false');
  assert.equal(first.ENABLE_SCHEDULER, 'false');
  assert.equal(first.YUNWU_API_KEY, '');
  assert.equal(first.HOST, '127.0.0.1');
});

test('missing secret keys in a template fail explicitly', () => {
  assert.throws(() => initialEnvironment('JWT_SECRET=\n'), /PLATFORM_SUPER_PASSWORD/u);
});

test('settings preserve existing config, use server-relative DB paths, and validate overrides', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-local-settings-'));
  fs.mkdirSync(path.join(root, 'server'));
  const envPath = path.join(root, 'server/.env');
  const content = 'PORT=3207\nHOST=127.0.0.1\nNANOWORK_DB=data/custom.db\nJWT_SECRET=existing\n';
  fs.writeFileSync(envPath, content);
  try {
    const settings = localSettings(root, {});
    assert.equal(settings.port, 3207);
    assert.equal(settings.databasePath, path.join(root, 'server/data/custom.db'));
    assert.equal(settings.values.JWT_SECRET, 'existing');
    assert.equal(localSettings(root, { PORT: '3208' }).port, 3208);
    for (const override of [{ HOST: '0.0.0.0' }, { NODE_ENV: 'production' }, { PORT: 'bad' },
      { PORT: '80' }, { SEED_DEMO: 'true' }, { NANOWORK_TEST_TEMPLATE_AI: '1' }, { NANOWORK_DB: '../external.db' }]) {
      assert.throws(() => localSettings(root, override));
    }
    assert.equal(fs.readFileSync(envPath, 'utf8'), content);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ZIP directory sync fails before reaching parent repositories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-zip-sync-'));
  try { assert.throws(() => syncSource(root), /ZIP/u); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('occupied local ports are detected without stopping their owner', async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try { assert.equal(await portOccupied(port), true); assert.equal(server.listening, true); }
  finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(await portOccupied(port), false);
});

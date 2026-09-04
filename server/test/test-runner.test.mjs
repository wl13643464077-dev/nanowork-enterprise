import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testInvocation, serverRoot } from '../scripts/run-tests.mjs';

test('npm test uses this Node, server cwd, all files and isolation before imports', () => {
  const result = testInvocation(['--test-reporter=tap'], {
    NANOWORK_DB: '/not-the-test-database.sqlite',
    NODE_ENV: 'production', YUNWU_API_KEY: 'host-secret',
    ANTHROPIC_API_KEY: 'host-secret', OPENAI_API_KEY: 'host-secret',
    CONTENTCREW_CLAUDE_PATH: '/host/claude', ENABLE_SCHEDULER: 'true',
    ENABLE_BACKGROUND_EMBEDDINGS: 'true', PATH: 'preserved-path',
  });
  assert.equal(result.command, process.execPath);
  assert.equal(result.options.cwd, serverRoot);
  assert.equal(result.options.shell, false);
  assert.equal(result.options.env.NANOWORK_DB, ':memory:');
  assert.equal(result.options.env.NODE_ENV, 'test');
  assert.equal(result.options.env.NANOWORK_TEST_TEMPLATE_AI, '1');
  assert.equal(result.options.env.ENABLE_SCHEDULER, 'false');
  assert.equal(result.options.env.ENABLE_BACKGROUND_EMBEDDINGS, 'false');
  for (const key of ['YUNWU_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CONTENTCREW_CLAUDE_PATH']) {
    assert.equal(result.options.env[key], '');
  }
  assert.equal(result.options.env.PATH, 'preserved-path');
  assert.deepEqual(result.args.slice(0, 4), ['--test', '--no-warnings', '--test-concurrency=4', '--test-reporter=tap']);
  assert.deepEqual(result.args.slice(4), fs.readdirSync(path.join(serverRoot, 'test'))
    .filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join('test', name)));
});

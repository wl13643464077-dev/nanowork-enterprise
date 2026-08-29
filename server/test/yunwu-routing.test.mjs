import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NANOWORK_DB = ':memory:';

const { initSchema, migrateV2, setConfig } = await import('../src/db.js');
initSchema();
migrateV2();

const { routing, textModelFor } = await import('../src/engines/yunwu.js');

test('default text routing keeps management roles on verified available models', () => {
  const models = routing().text;

  assert.equal(models.boss, 'gpt-5.5');
  assert.equal(models.ops_director, 'gpt-5.5');
  assert.equal(models.manager, 'gpt-5.5');
  assert.equal(models.sales, 'deepseek-v4-flash');
  assert.equal(textModelFor('ops_director'), 'gpt-5.5');
  assert.equal(textModelFor('manager'), 'gpt-5.5');
  assert.notEqual(models.ops_director, 'gemini-3.1-flash-lite');
});

test('tenant routing overrides still take precedence over management defaults', () => {
  setConfig('model_routing', {
    text: {
      manager: 'deepseek-v4-flash',
    },
  });

  assert.equal(textModelFor('manager'), 'deepseek-v4-flash');
  assert.equal(textModelFor('ops_director'), 'gpt-5.5');
});

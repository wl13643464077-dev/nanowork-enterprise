import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NANOWORK_DB = ':memory:';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.YUNWU_API_KEY = '';

const { initSchema, migrateV2, setConfig } = await import('../src/db.js');
const { miniMaxH3Enabled, routing, videoModelInfo, videoTaskSupported } = await import('../src/engines/yunwu.js');

initSchema();
migrateV2();

test('Hailuo 2.3 and Fast are routable while H3 stays hidden by default', () => {
  const configured = routing();
  assert.ok(configured.video.includes('MiniMax-Hailuo-2.3-Fast'));
  assert.ok(configured.video.includes('MiniMax-Hailuo-2.3'));
  assert.equal(videoTaskSupported('MiniMax-Hailuo-2.3-Fast'), true);
  assert.equal(miniMaxH3Enabled(), false);
  assert.equal(videoModelInfo('MiniMax-H3').supported, false);
  assert.equal(configured.video.includes('MiniMax-H3'), false);
});

test('H3 appears only when deployment flag plus provider and billing verification are explicit', () => {
  process.env.NANOWORK_MINIMAX_H3_ENABLED = '1';
  setConfig('minimax_h3_capability', { providerVerified: true, billingVerified: true });
  const configured = routing();
  assert.equal(miniMaxH3Enabled(), true);
  assert.equal(videoModelInfo('MiniMax-H3').supported, true);
  assert.ok(configured.video.includes('MiniMax-H3'));
  assert.equal(videoTaskSupported('MiniMax-H3'), true);
});

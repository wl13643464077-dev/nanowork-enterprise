import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

process.env.NANOWORK_DB = ':memory:';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.YUNWU_API_KEY = '';
process.env.MINIMAX_API_KEY = '';

const { initSchema, migrateV2, setConfig } = await import('../src/db.js');
const {
  miniMaxH3Availability,
  miniMaxH3Enabled,
  routing,
  videoModelInfo,
  videoTaskSupported,
} = await import('../src/engines/yunwu.js');

initSchema();
migrateV2();

beforeEach(() => {
  delete process.env.NANOWORK_MINIMAX_H3_ENABLED;
  delete process.env.MINIMAX_BASE_URL;
  process.env.MINIMAX_API_KEY = '';
  process.env.YUNWU_API_KEY = '';
  setConfig('minimax_h3_capability', {
    providerVerified: false,
    billingVerified: false,
  });
});

test('Hailuo 2.3 and Fast are routable while H3 stays hidden by default', () => {
  const configured = routing();
  assert.ok(configured.video.includes('MiniMax-Hailuo-2.3-Fast'));
  assert.ok(configured.video.includes('MiniMax-Hailuo-2.3'));
  assert.equal(videoTaskSupported('MiniMax-Hailuo-2.3-Fast'), true);
  assert.equal(miniMaxH3Enabled(), false);
  assert.equal(videoModelInfo('MiniMax-H3').supported, false);
  assert.equal(configured.video.includes('MiniMax-H3'), false);
});

test('H3 does not reuse a configured Yunwu credential', () => {
  process.env.NANOWORK_MINIMAX_H3_ENABLED = '1';
  process.env.YUNWU_API_KEY = 'yunwu-only-test-key';
  setConfig('minimax_h3_capability', { providerVerified: true, billingVerified: true });
  const availability = miniMaxH3Availability();
  assert.equal(availability.enabled, false);
  assert.equal(availability.credentialConfigured, false);
  assert.equal(availability.credentialSource, 'none');
  assert.equal(JSON.stringify(availability).includes('yunwu-only-test-key'), false);
  assert.equal(routing().video.includes('MiniMax-H3'), false);
});

test('H3 remains blocked whenever any one of the four readiness gates is missing', () => {
  const cases = [
    { name: 'deployment flag', flag: false, key: true, provider: true, billing: true },
    { name: 'official credential', flag: true, key: false, provider: true, billing: true },
    { name: 'provider verification', flag: true, key: true, provider: false, billing: true },
    { name: 'billing verification', flag: true, key: true, provider: true, billing: false },
  ];
  for (const item of cases) {
    process.env.NANOWORK_MINIMAX_H3_ENABLED = item.flag ? '1' : '0';
    process.env.MINIMAX_API_KEY = item.key ? 'official-test-only-key' : '';
    setConfig('minimax_h3_capability', {
      providerVerified: item.provider,
      billingVerified: item.billing,
    });
    assert.equal(miniMaxH3Enabled(), false, `${item.name} must fail closed`);
  }
});

test('H3 appears only when flag, official credential, provider and billing verification are explicit', () => {
  process.env.NANOWORK_MINIMAX_H3_ENABLED = '1';
  process.env.MINIMAX_API_KEY = 'official-test-only-key';
  setConfig('minimax_h3_capability', { providerVerified: true, billingVerified: true });
  const configured = routing();
  assert.deepEqual(miniMaxH3Availability(), {
    enabled: true,
    deploymentFlagEnabled: true,
    providerVerified: true,
    billingVerified: true,
    credentialConfigured: true,
    credentialSource: 'environment',
    baseUrlSource: 'default',
  });
  assert.equal(miniMaxH3Enabled(), true);
  assert.equal(videoModelInfo('MiniMax-H3').supported, true);
  assert.ok(configured.video.includes('MiniMax-H3'));
  assert.equal(videoTaskSupported('MiniMax-H3'), true);
});

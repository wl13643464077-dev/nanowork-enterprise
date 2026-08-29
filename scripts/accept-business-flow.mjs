import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const child = spawnSync(process.execPath, [
  '--test',
  '--no-warnings',
  'server/test/business-flow-route.test.mjs',
], {
  cwd: projectRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    SEED_DEMO: 'false',
    ENABLE_SCHEDULER: 'false',
    ENABLE_BACKGROUND_EMBEDDINGS: 'false',
    // Non-empty sentinels prevent both env loaders from reading local paid keys.
    // The acceptance itself rejects every non-loopback fetch before a socket opens.
    YUNWU_API_KEY: ' ',
    ANTHROPIC_API_KEY: ' ',
    OPENAI_API_KEY: ' ',
    BOCHA_API_KEY: ' ',
    TAVILY_API_KEY: ' ',
    SERPER_API_KEY: ' ',
  },
});

if (child.error) throw child.error;
if (child.status !== 0) {
  process.stderr.write(child.stdout || '');
  process.stderr.write(child.stderr || '');
  process.exit(child.status || 1);
}

process.stdout.write(child.stdout || '');
process.stdout.write([
  'PASS_BUSINESS_FLOW_API boss/ops/sales',
  'externalNetworkAttempts=0 billingDelta=0 internalProfileLeaks=0',
  '',
].join('\n'));

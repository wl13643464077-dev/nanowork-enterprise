import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const requestedDirectory = String(process.env.EMPLOYEE_MATRIX_DIR || '').trim();
const reportDirectory = requestedDirectory
  ? path.resolve(requestedDirectory)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-employee-matrix-report-'));
fs.mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });

const child = spawnSync(process.execPath, [
  '--test',
  '--no-warnings',
  '--test-name-pattern=\\[employee-output-matrix\\]',
  'server/test/full-employee-output-matrix.test.mjs',
], {
  cwd: projectRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    EMPLOYEE_MATRIX_DIR: reportDirectory,
    NODE_ENV: 'test',
    SEED_DEMO: 'false',
    ENABLE_SCHEDULER: 'false',
    ENABLE_BACKGROUND_EMBEDDINGS: 'false',
    // Do not inherit paid credentials into an offline acceptance command.
    YUNWU_API_KEY: ' ',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
  },
});

if (child.error) throw child.error;
if (child.status !== 0) {
  process.stderr.write(child.stdout || '');
  process.stderr.write(child.stderr || '');
  process.exit(child.status || 1);
}

const reportPath = path.join(reportDirectory, 'full-production.json');
assert.ok(fs.existsSync(reportPath), `matrix report was not written: ${reportPath}`);
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const rows = Array.isArray(report.rows) ? report.rows : [];
const expectedRestaurant = new Set(Array.from({ length: 60 }, (_, index) => 101 + index));
const expectedContent = new Set(Array.from({ length: 10 }, (_, index) => index));
const actualRestaurant = rows.filter(row => row.domain === 'restaurant');
const actualContent = rows.filter(row => row.domain === 'content');

assert.equal(report.schemaVersion, 'nanowork.employee-output-matrix.v1');
assert.equal(report.evidenceLevel, 'L4_FULL_PRODUCTION_HTTP');
assert.equal(report.providerEvidence, 'deterministic_mock');
assert.equal(report.verdict, 'PASS_OFFLINE_PIPELINE');
assert.deepEqual(report.externalNetworkAttempts, []);
assert.equal(rows.length, 70, 'matrix must contain exactly 70 employees');
assert.equal(actualRestaurant.length, 60, 'restaurant matrix must contain 60 employees');
assert.equal(actualContent.length, 10, 'content matrix must contain 10 employees');
assert.equal(new Set(rows.map(row => row.employeeId)).size, 70, 'employee ids must be unique');

for (const row of actualRestaurant) {
  assert.equal(expectedRestaurant.delete(Number(row.idx)), true,
    `restaurant employee is missing or duplicated: ${row.idx}`);
}
for (const row of actualContent) {
  assert.equal(expectedContent.delete(Number(row.idx)), true,
    `content employee is missing or duplicated: ${row.idx}`);
}
assert.equal(expectedRestaurant.size, 0, `missing restaurant employees: ${[...expectedRestaurant]}`);
assert.equal(expectedContent.size, 0, `missing content employees: ${[...expectedContent]}`);

for (const row of rows) {
  assert.equal(row.pass, true, `${row.employeeId} did not pass`);
  assert.equal(row.verdict, 'PASS_OFFLINE_PIPELINE', `${row.employeeId} verdict`);
  assert.equal(row.providerEvidence, 'deterministic_mock', `${row.employeeId} provider label`);
  assert.equal(row.contractValid, true, `${row.employeeId} contract`);
  assert.ok(Number(row.artifactCount) >= 1, `${row.employeeId} artifact`);
  assert.equal(Number(row.primaryArtifactCount), 1, `${row.employeeId} primary artifact`);
  assert.equal(row.billingState, 'settled', `${row.employeeId} billing`);
  assert.equal(Number(row.heldRemaining), 0, `${row.employeeId} open hold`);
  assert.match(String(row.resultHash || ''), /^[a-f0-9]{64}$/u, `${row.employeeId} result hash`);
}

assert.equal(report.middlewareEvidence?.authMiddleware, true);
assert.equal(report.middlewareEvidence?.tenantGate, true);
assert.equal(report.middlewareEvidence?.moduleGuard, true);
assert.equal(report.middlewareEvidence?.crossTenantReadDenied, true);

process.stdout.write([
  'PASS_OFFLINE_PIPELINE 70/70',
  'restaurant=60/60 content=10/10',
  `providerEvidence=${report.providerEvidence} externalNetworkAttempts=0`,
  `report=${reportPath}`,
  '',
].join('\n'));

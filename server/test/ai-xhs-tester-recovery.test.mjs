import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';

// No real user database, credentials or network are used by these recovery checks.
Object.assign(process.env, {
  NANOWORK_DB: ':memory:', NANOWORK_TEST_TEMPLATE_AI: '1', NODE_ENV: 'test',
  ENABLE_SCHEDULER: 'false', ENABLE_BACKGROUND_EMBEDDINGS: 'false',
  JWT_SECRET: 'isolated-xhs-personal-recovery-secret-2026',
  AI360_API_KEY: 'platform-360-must-never-be-used',
  OPENLUX_API_KEY: 'platform-openlux-must-never-be-used',
  YUNWU_API_KEY: 'platform-legacy-must-never-be-used',
  YUNWU_BASE_URL: 'https://api.openlux.ai/v1',
});
const { db, q, initSchema, migrateV2, runWithTenant, setConfig } = await import('../src/db.js');
initSchema(); migrateV2();
assert.equal(db.prepare('PRAGMA database_list').get().file, '');
const { ensureTesterSchema, encryptTesterSecret, testerExecutionIdentity } = await import('../src/engines/tester-access.js');
const { selectedProviderCredentials, selectedProviderId, withTaskProvider } = await import('../src/engines/ai-provider-selection.js');
const { runWithTesterIdentity, providerContext } = await import('../src/engines/tester-provider-context.js');
const { holdCredits, settleHold } = await import('../src/engines/credits.js');
const { XHS_NOTE_SOURCE } = await import('../src/engines/ai-xhs-note.js');
const routes = await import('../src/routes/ai-xhs-note.js');
// A second handler instance has fresh in-memory worker/lease state, like restart recovery.
const restarted = await import('../src/routes/ai-xhs-note.js?tester-recovery-restart');
ensureTesterSchema();
const originalFetch = globalThis.fetch;
globalThis.fetch = () => assert.fail('禁止真实供应商网络请求');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZfcAAAAASUVORK5CYII=', 'base64');
let sequence = 0;
const owners = [];
function owner() {
  const serial = ++sequence;
  const tenantId = Number(q.run("INSERT INTO tenants(name,status,credits) VALUES('个人XHS隔离测试','已开通',1234)").lastInsertRowid);
  const userId = Number(q.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES(?,'unused','隔离测试员','boss','启用',?)", `xhs-personal-${serial}`, tenantId).lastInsertRowid);
  q.run("INSERT INTO tester_accounts(user_id,phone,status,consent_at,active_provider) VALUES(?,?,'approved','2026-09-14','360')", userId, `1000000${String(serial).padStart(4, '0')}`);
  const keys = { '360': `fake-personal-360-${serial}`, openlux: `fake-personal-openlux-${serial}` };
  for (const provider of ['360', 'openlux']) q.run('INSERT INTO tester_provider_keys(owner_user_id,provider,api_key_cipher) VALUES(?,?,?)', userId, provider, encryptTesterSecret(keys[provider]));
  const result = { tenantId, userId, keys, actor: { id: userId, tenant_id: tenantId, role: 'boss', accountType: 'tester' } };
  owners.push(result); return result;
}
function fixture(person, provider = '360') {
  return runWithTenant(person.tenantId, () => withTaskProvider({ providerId: provider }, () => {
    const imageModel = provider === '360' ? 'openai/gpt-image-2' : 'gpt-image-2';
    const textModel = provider === '360' ? 'deepseek/deepseek-v4-flash' : 'deepseek-v4-flash';
    const contentId = Number(q.run("INSERT INTO contents(tenant_id,creator_id,source_type,type,title,body,status) VALUES(?,?,?,'小红书种草图文','测试标题','测试正文','草稿')", person.tenantId, person.userId, XHS_NOTE_SOURCE).lastInsertRowid);
    const hold = holdCredits({ userId: person.userId, tenantId: person.tenantId, kind: 'text', model: textModel, feature: '测试文案', credits: 50, refType: 'content', refId: contentId });
    settleHold(hold, { model: textModel, usage: { inputTokens: 10, outputTokens: 10 }, aiMode: 'api' });
    const snapshot = { status: 'success', input: { brandName: '演示店', brief: '隔离测试', fileIds: [], imageCount: 3, generateImages: true }, output: { title: '测试标题', body: '测试正文', tags: [] },
      billing: { state: 'settled', holdId: hold.holdId }, imageGeneration: { model: imageModel, providerId: provider, creditsPerImage: 50 } };
    q.run('UPDATE contents SET snapshot_json=? WHERE id=?', JSON.stringify(snapshot), contentId);
    const state = { source: 'ai_xhs_note_image', contentId, role: 'cover', label: '封面', model: imageModel, providerId: provider,
      status: 'failed', attempts: 0, billing: { state: 'not_held' }, creditsPerImage: 50, promptHash: 'fixture-prompt-hash', deadline: 0 };
    const imageId = Number(q.run("INSERT INTO media_jobs(tenant_id,user_id,kind,model,prompt,status,snapshot_json) VALUES(?,?,'image',?,'fixture image prompt','失败',?)", person.tenantId, person.userId, imageModel, JSON.stringify(state)).lastInsertRowid);
    return { contentId, imageId, imageModel };
  }));
}
function media(job) { return q.get('SELECT * FROM media_jobs WHERE id=?', job.imageId); }
function context(person, provider) {
  const credentials = selectedProviderCredentials();
  assert.equal(credentials.id, provider);
  assert.equal(credentials.apiKey, person.keys[provider]);
  assert.equal(credentials.ownerUserId, person.userId);
  assert.equal(credentials.billingMode, 'personal');
  assert.equal(providerContext().tenantId, person.tenantId);
  return credentials;
}
function runtime(person, provider, calls, overrides = {}) {
  return {
    imageAvailable() { context(person, provider); return true; },
    async editImage(params) {
      context(person, provider); calls.push(params.model);
      return { model: params.model, b64: png.toString('base64'), providerStatus: 200, usage: { inputTokens: 10, outputTokens: 20 } };
    },
    renderImage: async bytes => bytes,
    ...overrides,
  };
}
function assertPrivatePersistence(person) {
  const serialized = JSON.stringify([
    q.all('SELECT snapshot_json FROM contents WHERE tenant_id=?', person.tenantId),
    q.all('SELECT snapshot_json FROM media_jobs WHERE tenant_id=?', person.tenantId),
    q.all('SELECT pricing_snapshot_json FROM credit_holds WHERE tenant_id=?', person.tenantId),
    q.all('SELECT api_key_cipher FROM tester_provider_keys WHERE owner_user_id=?', person.userId),
  ]);
  for (const key of Object.values(person.keys)) assert.ok(!serialized.includes(key), '任务与存储中不能出现明文个人Key');
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', person.tenantId).credits, 1234);
}
async function execute(handler, person, job, implementation) {
  return handler.executeXhsImageJob({ id: job.imageId }, { id: job.contentId }, {}, implementation);
}
after(() => {
  for (const person of owners) for (const file of q.all('SELECT file_path FROM uploaded_files WHERE tenant_id=?', person.tenantId)) fs.rmSync(file.file_path, { force: true });
  globalThis.fetch = originalFetch; db.close();
});

test('旧图片重试覆盖当前HTTP个人供应商，仍使用原模型与本人原Key', async () => {
  const person = owner(), job = fixture(person, '360'), calls = [];
  q.run("UPDATE tester_accounts SET active_provider='openlux' WHERE user_id=?", person.userId);
  setConfig('ai_provider_default', 'openlux');
  await runWithTenant(person.tenantId, () => runWithTesterIdentity(testerExecutionIdentity(), async () => {
    assert.equal(selectedProviderId(), 'openlux');
    await execute(routes, person, job, runtime(person, '360', calls));
    assert.equal(selectedProviderId(), 'openlux', '任务绑定不会污染外层新任务供应商');
  }));
  assert.deepEqual(calls, ['openai/gpt-image-2']);
  assert.equal(media(job).status, '成功');
  const hold = q.get("SELECT * FROM credit_holds WHERE ref_type='media_job' AND ref_id=? AND tenant_id=?", job.imageId, person.tenantId);
  assert.equal(JSON.parse(hold.pricing_snapshot_json).provider, '360');
  assert.equal(hold.held_credits, 0);
  assertPrivatePersistence(person);
});

test('新服务实例只恢复落库tenant，不依赖原HTTP上下文，也不跟随平台或个人默认供应商', async () => {
  const person = owner(), job = fixture(person, 'openlux'), calls = [];
  q.run("UPDATE tester_accounts SET active_provider='360' WHERE user_id=?", person.userId);
  setConfig('ai_provider_default', '360');
  await runWithTenant(person.tenantId, () => execute(restarted, person, job, runtime(person, 'openlux', calls)));
  assert.deepEqual(calls, ['gpt-image-2']);
  assert.equal(media(job).status, '成功');
  assertPrivatePersistence(person);
});

test('删除原个人Key后失败关闭，不借其他个人Key或平台Key，不产生新预授权', async () => {
  const person = owner(), job = fixture(person), calls = [];
  q.run("UPDATE tester_accounts SET active_provider='openlux' WHERE user_id=?", person.userId);
  q.run("DELETE FROM tester_provider_keys WHERE owner_user_id=? AND provider='360'", person.userId);
  await runWithTenant(person.tenantId, () => execute(restarted, person, job, runtime(person, '360', calls)));
  assert.deepEqual(calls, []);
  assert.equal(media(job).status, '失败');
  assert.equal(JSON.parse(media(job).snapshot_json).billing.state, 'not_held');
  assert.equal(q.get("SELECT COUNT(*) count FROM credit_holds WHERE ref_type='media_job' AND ref_id=? AND tenant_id=?", job.imageId, person.tenantId).count, 0);
  assertPrivatePersistence(person);
});

test('暂停测试员及无法识别原供应商的历史图片都不能恢复生成', async () => {
  const person = owner(), job = fixture(person), calls = [];
  q.run("UPDATE tester_accounts SET status='paused' WHERE user_id=?", person.userId);
  await assert.rejects(runWithTenant(person.tenantId, () => execute(restarted, person, job, runtime(person, '360', calls))), error => error.code === 'TESTER_INACTIVE');
  q.run("UPDATE tester_accounts SET status='approved' WHERE user_id=?", person.userId);
  const state = JSON.parse(media(job).snapshot_json); delete state.providerId;
  q.run('UPDATE media_jobs SET model=?,snapshot_json=? WHERE id=?', 'unknown-old-model', JSON.stringify(state), job.imageId);
  await assert.rejects(runWithTenant(person.tenantId, () => execute(restarted, person, job, runtime(person, '360', calls))), error => error.code === 'TASK_PROVIDER_UNKNOWN');
  assert.deepEqual(calls, []);
  assertPrivatePersistence(person);
});

test('重启后取回已付费原图片仍绑定原个人供应商，只下载同一回执，不新生成或重复预授权', async () => {
  const person = owner(), job = fixture(person), calls = [];
  const receiptUrl = 'https://image-receipt.example.test/existing-result.png';
  await runWithTenant(person.tenantId, () => execute(routes, person, job, runtime(person, '360', calls, {
    async editImage(params) { context(person, '360'); calls.push(params.model); return { model: params.model, url: receiptUrl, providerStatus: 200, usage: { inputTokens: 10, outputTokens: 20 } }; },
    fetchImage: async () => { throw new Error('isolated receipt download interruption'); },
  })));
  assert.equal(media(job).status, '失败');
  assert.ok(JSON.parse(media(job).snapshot_json).providerReceipt);
  const heldBefore = q.get("SELECT COUNT(*) count FROM credit_holds WHERE ref_type='media_job' AND ref_id=? AND tenant_id=?", job.imageId, person.tenantId).count;
  q.run("UPDATE tester_accounts SET active_provider='openlux' WHERE user_id=?", person.userId);
  setConfig('ai_provider_default', 'openlux');
  const downloads = [];
  runWithTenant(person.tenantId, () => restarted.recoverXhsNoteImages({ actor: person.actor, jobId: job.contentId, imageIds: ['cover'], runtime: runtime(person, '360', calls, {
    editImage: () => assert.fail('恢复不能重新调用生图API'),
    async fetchImage(url) { context(person, '360'); downloads.push(url); return new Response(png, { status: 200 }); },
  }) }));
  for (let attempt = 0; attempt < 50 && JSON.parse(media(job).snapshot_json).recoveryStage !== 'completed'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.parse(media(job).snapshot_json).recoveryStage, 'completed');
  assert.deepEqual(downloads, [receiptUrl]);
  assert.deepEqual(calls, ['openai/gpt-image-2']);
  assert.equal(q.get("SELECT COUNT(*) count FROM credit_holds WHERE ref_type='media_job' AND ref_id=? AND tenant_id=?", job.imageId, person.tenantId).count, heldBefore);
  assertPrivatePersistence(person);
});

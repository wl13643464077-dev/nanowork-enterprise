import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import express from 'express';
Object.assign(process.env, { NANOWORK_DB: ':memory:', NODE_ENV: 'test',
  NANOWORK_TEST_TEMPLATE_AI: '1', ENABLE_SCHEDULER: 'false', SEED_DEMO: 'false',
  JWT_SECRET: 'isolated-content-provider-test-encryption-secret', AI360_API_KEY: 'platform-never-used' });
const { db, q, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
initSchema(); migrateV2();
const api = await import('../src/engines/tester-trials.js');
const { bindContentPipelineProvider, runWithContentPipelineProvider, createContentProductionPipelineRouter } = await import('../src/routes/content-production-pipeline.js');
const { selectedProviderCredentials } = await import('../src/engines/ai-provider-selection.js');
const superUser = { id: Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES('pipeline_super','x','测试超管','platform_super',1,'启用')").lastInsertRowid) };
let count = 0;
function personalJob() {
  const n = ++count;
  api.applyTester({ username: `pipeline_personal_${n}`, password: 'Fixture-Password-Only!', name: '流水线测试员', phone: `1385678${String(n).padStart(4,'0')}`, consent: true });
  const user = q.get('SELECT id,tenant_id FROM users WHERE username=?', `pipeline_personal_${n}`);
  api.updateTesterStatus(superUser, user.id, 'approved');
  api.setTesterKey(user, 'fake-original-360-key', '360');
  api.setTesterKey(user, 'fake-other-openlux-key', 'openlux');
  const job = { tenantId: user.tenant_id, createdBy: user.id, settings: {
    providerBinding: bindContentPipelineProvider({ tenantId: user.tenant_id, createdBy: user.id }),
  } };
  return { user, job };
}

test('a queued personal pipeline keeps original supplier and owner across default switch and tenant context', async () => {
  const a = personalJob(), b = personalJob();
  api.setTesterProvider(a.user, 'openlux');
  assert.equal(a.job.settings.providerBinding.providerId, '360');
  assert.doesNotMatch(JSON.stringify(a.job.settings), /fake-|apiKey/);
  await runWithTenant(b.user.tenant_id, () => runWithContentPipelineProvider(a.job, async () => {
    await Promise.resolve();
    const credentials = selectedProviderCredentials();
    assert.equal(credentials.id, '360');
    assert.equal(credentials.apiKey, 'fake-original-360-key');
    assert.equal(credentials.ownerUserId, a.user.id);
  }));
});

test('legacy missing or altered personal owner/provider evidence cannot fall back to platform credentials', () => {
  const { user, job } = personalJob();
  const frozen = job.settings.providerBinding;
  for (const binding of [null, {}, { ...frozen, ownerUserId: superUser.id }, { ...frozen, tenantId: 1 }, { ...frozen, providerId: undefined }]) {
    assert.throws(() => runWithContentPipelineProvider({ ...job, settings: { providerBinding: binding } }, () => {
      assert.fail('must not execute');
    }), error => ['CONTENT_PIPELINE_PERSONAL_PROVIDER_UNKNOWN', 'TASK_PROVIDER_UNKNOWN'].includes(error.code));
  }
  api.clearTesterKey(user, '360');
  assert.throws(() => runWithContentPipelineProvider(job, () => selectedProviderCredentials()), { code: 'PERSONAL_KEY_REQUIRED' });
  api.updateTesterStatus(superUser, user.id, 'paused');
  assert.throws(() => runWithContentPipelineProvider(job, () => assert.fail('must not execute')), { code: 'TESTER_INACTIVE' });
});

test('ordinary enterprise pipeline keeps existing behavior without a personal binding', () => {
  assert.equal(bindContentPipelineProvider({ tenantId: 1, createdBy: superUser.id }), null);
  assert.equal(runWithContentPipelineProvider({ tenantId: 1, createdBy: superUser.id, settings: {} }, () => 'existing'), 'existing');
});


test('only approved personal owners may configure pipeline approval and authorize/review their own content', async (t) => {
  const { user } = personalJob();
  let actor = { ...user, role: 'tester', status: '启用' };
  const { createContentProductionPipeline, createSqliteContentProductionPipelineRepository } = await import('../src/engines/content-production-pipeline.js');
  const { evaluateContentHandlerApprovalBoundary } = await import('../src/engines/content-handler-approval-boundary.js');
  const { createContentPaidMediaAuthorization } = await import('../src/engines/content-paid-media-authorization.js');
  const repository = createSqliteContentProductionPipelineRepository({ db }); repository.ensureSchema();
  const pipeline = createContentProductionPipeline({ repository, handlerRegistry: { invoke() { throw new Error('no supplier in this test'); } },
    resolveImageModel: () => 'openai/gpt-image-2', estimateMaxCredits: () => 75,
    bindProvider: bindContentPipelineProvider, runWithJobProvider: runWithContentPipelineProvider });
  const brief = { direction: '个人内容流水线', platforms: ['小红书'], image_mode: 'ai', image_count: 1, enable_deck: false };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = actor; req.aiGuard = { defer: () => () => {} }; runWithTenant(actor.tenant_id, next); });
  app.use('/content', createContentProductionPipelineRouter({ getRuntime: () => ({ pipeline, repository }),
    providerAvailableFn: () => true, precheckByRoleFn: () => {}, estimateMaxCreditsFn: () => 75,
    resolveImageModelFn: () => 'openai/gpt-image-2', scheduleFn: () => {}, logOpFn: () => {}, notifyFn: () => {},
    profileStore: { load: () => ({ profile: {}, revision: 0 }) },
    resolveStructuredBriefFn: () => ({ paihuoBrief: brief, handlerContext: { companyProfile: {}, profile: { persona: {} } }, evidence: {} }),
  }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/content`;
  const post = async (url, body) => { const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const created = await post('/pipelines', { brief, workflow: { approvalPolicy: { mode: 'custom', reviewStations: [3, 8] }, paidMediaAuthorized: true } });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const id = created.body.pipeline.id;
  assert.equal(repository.getJob(user.tenant_id, id).workflow.paidMediaAuthorization.authorizedBy.role, 'tester');
  api.setTesterProvider(user, 'openlux');
  const authorized = await post(`/pipelines/${id}/paid-media-authorization`, { authorized: true });
  assert.equal(authorized.status, 200, JSON.stringify(authorized.body));
  const review = evaluateContentHandlerApprovalBoundary({ boundary: { code: 'force' }, action: 'adopt', actor });
  assert.equal(review.allowed, true); assert.equal(review.auditRecord.actor.actorRole, 'tester');
  const external = evaluateContentHandlerApprovalBoundary({ boundary: { code: 'force' }, action: 'external_publish', actor });
  assert.equal(external.allowed, false);
  const another = personalJob(); actor = { ...another.user, role: 'tester' };
  assert.equal((await post(`/pipelines/${id}/paid-media-authorization`, { authorized: true })).status, 404);
  const salesId = Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES('pipeline_plain_sales','x','普通员工','sales',1,'启用')").lastInsertRowid);
  for (const role of ['sales', 'tester']) {
    const claimed = { id: salesId, tenant_id: 1, role };
    assert.equal(evaluateContentHandlerApprovalBoundary({ boundary: { code: 'force' }, action: 'adopt', actor: claimed }).allowed, false);
    assert.throws(() => createContentPaidMediaAuthorization({ task: brief, actor: claimed, imageModel: 'openai/gpt-image-2', estimatedUnitCredits: 75 }), { code: 'CONTENT_PAID_MEDIA_AUTHORITY_REQUIRED' });
  }
  api.updateTesterStatus(superUser, user.id, 'paused');
  assert.equal(evaluateContentHandlerApprovalBoundary({ boundary: { code: 'force' }, action: 'adopt', actor: { ...user, role: 'tester' } }).allowed, false);
});

after(() => db.close());

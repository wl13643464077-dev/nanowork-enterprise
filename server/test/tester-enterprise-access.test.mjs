import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const databasePath = path.join(os.tmpdir(), `tester-enterprise-${process.pid}.db`);
Object.assign(process.env, { NANOWORK_DB: databasePath, NODE_ENV: 'test', NANOWORK_TEST_TEMPLATE_AI: '1',
  ENABLE_SCHEDULER: 'false', JWT_SECRET: 'enterprise-tester-fake-secret-'.repeat(3),
  AI360_API_KEY: 'platform-360-DO-NOT-USE', OPENLUX_API_KEY: 'platform-openlux-DO-NOT-USE',
  MINIMAX_API_KEY: 'platform-minimax-DO-NOT-USE', TINYFISH_API_KEY: 'platform-tinyfish-DO-NOT-USE',
  BOCHA_API_KEY: 'platform-bocha-DO-NOT-USE', TAVILY_API_KEY: 'platform-tavily-DO-NOT-USE' });
const { db, q, initSchema, migrateV2, runWithTenant, modulesFor, getTenantConfig } = await import('../src/db.js');
initSchema(); migrateV2();
(await import('../src/seed.js')).seed();
const trials = await import('../src/engines/tester-trials.js');
const access = await import('../src/engines/tester-access.js');
const { providerContext, runWithTesterIdentity } = await import('../src/engines/tester-provider-context.js');
const { selectedProviderId, selectedProviderCredentials, withTaskProvider, withPlatformProvider } = await import('../src/engines/ai-provider-selection.js');
const { chat, chatStream, generateImage, miniMaxH3Availability, yunwuAvailable } = await import('../src/engines/yunwu.js');
const { agenticWebResearchReadiness } = await import('../src/engines/agentic-web-research.js');
const { webSearchProviders } = await import('../src/engines/websearch.js');
const { createApp } = await import('../src/app.js');
const { signToken } = await import('../src/util.js');
const { hasFullDataAccess } = await import('../src/engines/access.js');
const { canReviewMedia } = await import('../src/routes/media-review.js');
const { contentEmployeeRunReviewAccess } = await import('../src/engines/content-approval-policy.js');
const { executeHeldDelivery } = await import('../src/engines/two-phase-delivery.js');
const superUser = { id: Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES('tester_enterprise_super','unused','super','platform_super',1,'启用')").lastInsertRowid) };
let counter = 0;
function tester({ key = true } = {}) {
  const n = ++counter;
  trials.applyTester({ username: `product_tester_${n}`, name: `测试${n}`, phone: `1387766${String(n).padStart(4, '0')}`,
    password: 'Example-password-123', consent: true });
  const actor = q.get('SELECT * FROM users WHERE username=?', `product_tester_${n}`);
  trials.updateTesterStatus(superUser, actor.id, 'approved');
  if (key) trials.setTesterKey(actor, `personal-360-${n}-private`, '360');
  return q.get('SELECT * FROM users WHERE id=?', actor.id);
}
const nativeFetch = globalThis.fetch;
async function httpTest(actor, action) {
  const app = createApp({ serveStatic: false, autoRecoverAvatar: false, autoRecoverTextVideo: false, autoRecoverWechatDraft: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const token = signToken({ id: actor.id, auth_version: actor.auth_version });
  try {
    await action(async (route, method = 'GET', body) => {
      const response = await nativeFetch(`http://127.0.0.1:${server.address().port}${route}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      return { status: response.status, data };
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('完整企业页面使用独立测试空间和业务能力，DB角色仍为sales；通知可读，平台/人员/席位仍禁', async () => {
  const actor = tester();
  await httpTest(actor, async request => {
    const me = await request('/api/auth/me');
    assert.equal(me.status, 200); assert.equal(me.data.accountType, 'tester');
    assert.equal(me.data.role, 'sales'); assert.equal(me.data.billingMode, 'personal');
    assert.equal(me.data.tenant.id, actor.tenant_id);
    assert.deepEqual(me.data.modules, [...access.TESTER_BUSINESS_MODULES]);
    assert.equal(JSON.stringify(me.data).includes('private'), false);
    for (const route of ['/api/employees', '/api/task-center', '/api/sys/notifications', '/api/sys/feishu/me'])
      assert.equal((await request(route)).status, 200, route);
    const employee = await request('/api/employee-workbench/restaurant/104');
    assert.equal(employee.status, 200);
    assert.equal(employee.data.permissions.canReviewRuns, true);
    assert.equal((await request('/api/sys/notifications/read', 'POST', {})).status, 200);
    for (const [route, method] of [
      ['/api/admin/users', 'POST'], ['/api/admin/invitations', 'POST'], ['/api/admin/seat-requests', 'POST'],
      ['/api/admin/api-config', 'GET'], ['/api/sys/config', 'PUT'], ['/api/sys/backup', 'GET'],
      ['/api/platform/tenants', 'GET'], ['/api/recharge/packages', 'GET'],
      ['/api/avatar/jobs', 'POST'], ['/api/text-video/jobs', 'POST'], ['/api/wechat-draft', 'POST'],
      ['/api/tester/admin/applications', 'GET'],
    ]) assert.equal((await request(route, method, method === 'POST' || method === 'PUT' ? {} : undefined)).status, 403, route);
  });
  assert.equal(q.get('SELECT role FROM users WHERE id=?', actor.id).role, 'sales');
  assert.equal(q.get('SELECT seat_limit FROM tenants WHERE id=?', actor.tenant_id).seat_limit, 1);
  assert.equal(modulesFor(actor).includes('system'), false);
  assert.equal(getTenantConfig('feature_flags', {}, actor.tenant_id)['content.video'].includes('sales'), true);
  assert.equal(hasFullDataAccess(actor), true);
  assert.equal(canReviewMedia(actor), true);
  assert.equal(contentEmployeeRunReviewAccess(actor, { approvalPolicy: { mode: '老板审核' } }).allowed, true);
});

test('未填个人Key也可浏览完整产品；真正生成明确缺Key，不借平台Key', async () => {
  const actor = tester({ key: false });
  await httpTest(actor, async request => {
    assert.equal((await request('/api/auth/me')).status, 200);
    assert.equal((await request('/api/employees')).status, 200);
    const generated = await request('/api/advisor/chat', 'POST', { message: '帮我策划开业' });
    assert.equal(generated.status, 409); assert.equal(generated.data.code, 'PERSONAL_KEY_REQUIRED');
  });
  runWithTenant(actor.tenant_id, () => {
    assert.equal(yunwuAvailable(), false);
    assert.throws(() => selectedProviderCredentials(), error => error.code === 'PERSONAL_KEY_REQUIRED');
  });
});

test('DB个人身份拒绝跨用户跨空间伪造，系统任务无tenant时不猜测用户；恢复任务不读平台凭据', () => {
  const a = tester(), b = tester();
  assert.equal(access.testerExecutionIdentity(), null);
  assert.equal(providerContext(), null);
  assert.throws(() => access.testerExecutionIdentity({ userId: a.id, tenantId: b.tenant_id }), error => error.code === 'TESTER_OWNER_MISMATCH');
  assert.throws(() => access.testerExecutionIdentity({ userId: a.id, tenantId: 1 }), error => error.code === 'TESTER_OWNER_MISMATCH');
  const identity = access.testerExecutionIdentity({ tenantId: a.tenant_id });
  assert.equal(identity.ownerUserId, a.id); assert.equal(Object.hasOwn(identity, 'apiKey'), false);
  assert.throws(() => runWithTesterIdentity(identity, () => runWithTenant(b.tenant_id, selectedProviderCredentials)),
    error => error.code === 'TESTER_OWNER_MISMATCH');
  runWithTenant(a.tenant_id, () => withPlatformProvider('openlux', () => {
    assert.equal(selectedProviderId(), '360');
    assert.equal(selectedProviderCredentials().ownerUserId, a.id);
  }));
});

test('两个完整产品任务并发文本/图片只带各自个人Key，平台搜索灾备和H3不会被借用', async () => {
  const actors = [tester(), tester()]; const observed = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); observed.push({ url: String(url), authorization: init.headers.Authorization, model: body.model });
    await new Promise(resolve => setTimeout(resolve, 4));
    return new Response(JSON.stringify({ id: `personal-call-${observed.length}-${body.model}`, model: body.model,
      choices: [{ message: { content: '真实接口协议模拟产出' } }], data: [{ url: 'https://example.test/photo.png' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, amount: 0.02 } }), { status: 200 });
  };
  try {
    await Promise.all(actors.map(actor => runWithTenant(actor.tenant_id, async () => {
      const text = await chat({ role: 'sales', messages: [{ role: 'user', content: '测试' }] });
      const image = await generateImage({ prompt: '一份菜品', size: '1024x1024' });
      assert.equal(text.text, '真实接口协议模拟产出'); assert.equal(image.url, 'https://example.test/photo.png');
      assert.equal(miniMaxH3Availability().credentialConfigured, false);
      assert.equal(agenticWebResearchReadiness().preferred, 'claude_websearch');
      assert.equal(JSON.stringify(webSearchProviders()).includes('bocha'), false);
    })));
  } finally { globalThis.fetch = nativeFetch; }
  assert.equal(observed.length, 4);
  for (const actor of actors) {
    const key = access.testerExecutionCredentials({ userId: actor.id }).apiKey;
    assert.equal(observed.filter(row => row.authorization === `Bearer ${key}`).length, 2);
  }
  assert.equal(observed.some(row => /DO-NOT-USE/.test(row.authorization)), false);
});

test('切换供应商后的旧任务按已存模型取原个人Key；缺原Key、未知模型和停用均不能恢复生成', () => {
  const actor = tester(); trials.setTesterKey(actor, 'original-openlux-key', 'openlux');
  const original = access.testerExecutionIdentity({ userId: actor.id });
  trials.setTesterProvider(actor, 'openlux');
  runWithTenant(actor.tenant_id, () => {
    assert.equal(selectedProviderId(), 'openlux');
    withTaskProvider({ model: 'openai/gpt-image-2' }, () => assert.equal(selectedProviderId(), '360'));
    runWithTesterIdentity(original, () => withTaskProvider({ model: 'gpt-image-2' }, () => {
      assert.equal(selectedProviderCredentials().apiKey, 'original-openlux-key');
    }));
    assert.throws(() => withTaskProvider({ model: 'unrecognized-model' }, () => null), error => error.code === 'TASK_PROVIDER_UNKNOWN');
    trials.clearTesterKey(actor, '360');
    assert.throws(() => withTaskProvider({ model: 'openai/gpt-image-2' }, selectedProviderCredentials), error => error.code === 'PERSONAL_KEY_REQUIRED');
  });
  trials.updateTesterStatus(superUser, actor.id, 'paused');
  assert.throws(() => runWithTenant(actor.tenant_id, () => withTaskProvider({ model: 'gpt-image-2' }, selectedProviderCredentials)), error => error.code === 'TESTER_INACTIVE');
});

test('Super暂停在途真实协议请求后不交付正文，仍能记录该次上游费用', async () => {
  const actor = tester();
  globalThis.fetch = async (_url, init) => {
    trials.updateTesterStatus(superUser, actor.id, 'paused');
    return new Response(JSON.stringify({ id: 'paid-before-pause', model: JSON.parse(init.body).model,
      choices: [{ message: { content: '暂停后不可交付的正文' } }], usage: { prompt_tokens: 10, completion_tokens: 20, amount: 0.035 } }), { status: 200 });
  };
  try {
    await assert.rejects(() => runWithTenant(actor.tenant_id, () => chat({ role: 'sales', messages: [{ role: 'user', content: '测试暂停' }] })), error => {
      assert.equal(error.code, 'TESTER_INACTIVE'); assert.equal(error.supplierCosts[0].costYuanOverride, 0.035); return true;
    });
  } finally { globalThis.fetch = nativeFetch; }
});

test('个人预授权生成期间停用，通用执行器不会先持久化产出再交付', async () => {
  const actor = tester(); let persisted = false, settled = false;
  await assert.rejects(() => runWithTenant(actor.tenant_id, () => executeHeldDelivery({
    hold: { holdId: 987, userId: actor.id, tenantId: actor.tenant_id, billingMode: 'personal', credits: 0 },
    generate: async () => { trials.updateTesterStatus(superUser, actor.id, 'paused'); return { text: '暂停结果' }; },
    persist: () => { persisted = true; }, settle: () => { settled = true; }, release: () => ({ credits: 0 }),
  })), error => error.code === 'TESTER_INACTIVE');
  assert.equal(persisted, false); assert.equal(settled, false);
});

test('流式任务暂停后停止后续正文回调，结束时仍保留费用回执', async () => {
  const actor = tester(), chunks = [];
  globalThis.fetch = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    let step = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (step === 0) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'paused-stream', model, choices: [{ delta: { content: '暂停前' } }] })}\n\n`));
        } else if (step === 1) {
          trials.updateTesterStatus(superUser, actor.id, 'paused');
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'paused-stream', model, choices: [{ delta: { content: '暂停后不得显示' } }], usage: { prompt_tokens: 10, completion_tokens: 20, amount: 0.04 } })}\n\n`));
        } else controller.close();
        step++;
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    await assert.rejects(() => runWithTenant(actor.tenant_id, () => chatStream({ role: 'sales', messages: [{ role: 'user', content: '测试流式暂停' }],
      onDelta: text => chunks.push(text) })), error => error.code === 'TESTER_INACTIVE' && error.supplierCosts?.[0]?.costYuanOverride === 0.04);
    assert.equal(chunks.some(chunk => chunk.includes('暂停后')), false);
  } finally { globalThis.fetch = nativeFetch; }
});

after(() => { globalThis.fetch = nativeFetch; db.close(); return removeTempDbSafely(databasePath); });

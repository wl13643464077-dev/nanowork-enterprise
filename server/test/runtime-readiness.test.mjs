import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const nativeFetch = globalThis.fetch;
const DBP = path.join(os.tmpdir(), `nanowork-runtime-readiness-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });

process.env.NANOWORK_DB = DBP;
process.env.ENABLE_SCHEDULER = 'false';
for (const key of [
  'YUNWU_API_KEY',
  'ANTHROPIC_API_KEY',
  'BOCHA_API_KEY',
  'TAVILY_API_KEY',
  'SERPER_API_KEY',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'WXPAY_MCHID',
  'WXPAY_SERIAL_NO',
  'WXPAY_PRIVATE_KEY',
  'WXPAY_APIV3_KEY',
  'WXPAY_APPID',
  'WXPAY_NOTIFY_URL',
  'WXPAY_PLATFORM_CERT',
  'WXPAY_PLATFORM_CERTS',
  'ALIPAY_APPID',
  'ALIPAY_PRIVATE_KEY',
  'ALIPAY_PUBLIC_KEY',
  'ALIPAY_NOTIFY_URL',
]) process.env[key] = '';

const {
  initSchema,
  migrateV2,
  q,
  runWithTenant,
  setConfig,
  setTenantConfig,
} = await import('../src/db.js');
const {
  buildRuntimeReadiness,
  clearRuntimeReadinessChecks,
  recordRuntimeReadinessCheck,
  runtimeReadinessConfigFingerprint,
} = await import('../src/engines/runtime-readiness.js');
const adminRoutes = (await import('../src/routes/admin.js')).default;
const systemRoutes = (await import('../src/routes/system.js')).default;

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits)
  VALUES(1,'运行就绪测试企业','已开通',10000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status`);
const bossId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('runtime-readiness-boss','unused','运行就绪负责人','boss','启用',1)`).lastInsertRowid);
const boss = q.get('SELECT id,name,username,role,tenant_id FROM users WHERE id=?', bossId);

function channel(matrix, key) {
  const result = matrix.channels.find(item => item.key === key);
  assert.ok(result, `missing readiness channel: ${key}`);
  return result;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(1, () => {
    req.user = { ...boss, ip: '127.0.0.1' };
    next();
  }));
  app.use('/admin', adminRoutes);
  app.use('/sys', systemRoutes);
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function request(base, pathname, method = 'GET', body) {
  const response = await nativeFetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, json: await response.json().catch(() => ({})) };
}

test('无凭证矩阵诚实阻断模型生成，不用本地替代文本冒充业务产物', () => {
  clearRuntimeReadinessChecks();
  const matrix = runWithTenant(1, () => buildRuntimeReadiness({ tenantId: 1 }));
  assert.equal(matrix.schemaVersion, 'runtime-readiness.v1');
  assert.equal(matrix.externalChecksPerformed, false);
  assert.equal(matrix.scope, 'process');

  const ai = channel(matrix, 'ai');
  assert.equal(ai.configured, false);
  assert.equal(ai.verified, false);
  assert.equal(ai.effective, 'blocked');
  assert.equal(ai.canExecute, false, '兼容字段也必须反映真实阻断状态');
  assert.equal(ai.canGenerateLocalDraft, false);
  assert.equal(ai.canDeliverForHumanReview, false);
  assert.equal(ai.canPerformExternalAction, false);
  assert.equal(ai.capabilitySummary, '真实生成通道未配置；任务不会启动，也不会形成业务产物');
  assert.match(ai.nextAction, /密钥|凭证/);

  for (const item of matrix.channels) {
    assert.equal(typeof item.canGenerateLocalDraft, 'boolean', `${item.key}缺少本地底稿能力维度`);
    assert.equal(typeof item.canDeliverForHumanReview, 'boolean', `${item.key}缺少人工审阅交付维度`);
    assert.equal(typeof item.canPerformExternalAction, 'boolean', `${item.key}缺少外部动作能力维度`);
    assert.equal(typeof item.canExecute, 'boolean', `${item.key}必须保留旧客户端兼容字段`);
  }

  const scheduler = channel(matrix, 'scheduler');
  assert.equal(scheduler.configured, true);
  assert.equal(scheduler.effective, 'disabled');
  assert.equal(scheduler.canExecute, false);
  assert.match(scheduler.nextAction, /ENABLE_SCHEDULER/);

  const search = channel(matrix, 'web_search');
  assert.equal(search.configured, false);
  assert.equal(search.effective, 'degraded');
  assert.equal(search.verified, false);

  const externalPublish = channel(matrix, 'external_publish');
  assert.equal(externalPublish.effective, 'manual_only');
  assert.equal(externalPublish.canGenerateLocalDraft, true);
  assert.equal(externalPublish.canDeliverForHumanReview, true);
  assert.equal(externalPublish.canPerformExternalAction, false);
  assert.equal(externalPublish.capabilitySummary, '仅登记发布包，不能代发');

  const connectors = channel(matrix, 'content_connectors');
  assert.deepEqual(connectors.details.counts, {
    total: 15,
    localAssist: 6,
    verifiedInputAssist: 2,
    employeeGeneration: 7,
    externalPublish: 0,
  });
  assert.equal(connectors.canExecute, true);
  assert.equal(connectors.canGenerateLocalDraft, false);
  assert.equal(connectors.canDeliverForHumanReview, false);
  assert.equal(connectors.capabilitySummary, '本地辅助连接器可运行，但依赖真实模型的生成任务被阻断；不形成替代业务产物，也不执行外部发布');
  assert.equal(connectors.canPerformExternalAction, false);

  recordRuntimeReadinessCheck('ai', {
    tenantId: 1,
    outcome: 'failed',
    checkedBy: boss.id,
    error: '尚未配置 API Key',
  });
  const afterExplicitFailure = runWithTenant(1, () => buildRuntimeReadiness({ tenantId: 1 }));
  assert.equal(channel(afterExplicitFailure, 'ai').verification, 'failed');
  assert.equal(channel(afterExplicitFailure, 'ai').lastCheck.scope, 'process');
});

test('只有当前配置最近一次显式测试通过才叫 connected，失败、过期和配置变化均失效', () => {
  clearRuntimeReadinessChecks();
  process.env.YUNWU_API_KEY = 'sk-runtime-readiness-one';
  setConfig('yunwu_base_url', 'https://93.184.216.34/v1?token=config-secret');

  let matrix = runWithTenant(1, () => buildRuntimeReadiness({ tenantId: 1, now: 1_000 }));
  assert.equal(channel(matrix, 'ai').configured, true);
  assert.equal(channel(matrix, 'ai').effective, 'configured_unverified');

  const fingerprint = runWithTenant(1, () => runtimeReadinessConfigFingerprint('ai', { tenantId: 1 }));
  recordRuntimeReadinessCheck('ai', {
    tenantId: 1,
    outcome: 'passed',
    configFingerprint: fingerprint,
    checkedAt: 1_000,
    ttlMs: 10_000,
    checkedBy: boss.id,
    evidence: {
      provider: 'yunwu',
      models: 2,
      endpoint: 'https://operator:password@example.com/v1?token=do-not-leak',
    },
  });
  matrix = runWithTenant(1, () => buildRuntimeReadiness({ tenantId: 1, now: 5_000 }));
  assert.equal(channel(matrix, 'ai').verified, true);
  assert.equal(channel(matrix, 'ai').verification, 'passed');
  assert.equal(channel(matrix, 'ai').effective, 'connected');
  assert.equal(channel(matrix, 'ai').canGenerateLocalDraft, false);
  assert.equal(channel(matrix, 'ai').canDeliverForHumanReview, true);
  assert.equal(channel(matrix, 'ai').canPerformExternalAction, false);
  assert.equal(channel(matrix, 'ai').lastCheck.scope, 'process');
  assert.doesNotMatch(JSON.stringify(matrix), /password|do-not-leak|config-secret/);

  matrix = runWithTenant(1, () => buildRuntimeReadiness({ tenantId: 1, now: 20_000 }));
  assert.equal(channel(matrix, 'ai').verified, false);
  assert.equal(channel(matrix, 'ai').verification, 'stale');
  assert.notEqual(channel(matrix, 'ai').effective, 'connected');

  recordRuntimeReadinessCheck('ai', {
    tenantId: 1,
    outcome: 'failed',
    checkedAt: 21_000,
    ttlMs: 10_000,
    checkedBy: boss.id,
    error: 'invalid token sk-runtime-readiness-secret-must-not-leak',
  });
  matrix = runWithTenant(1, () => buildRuntimeReadiness({ tenantId: 1, now: 22_000 }));
  assert.equal(channel(matrix, 'ai').verification, 'failed');
  assert.equal(channel(matrix, 'ai').effective, 'configured_unverified');
  assert.doesNotMatch(JSON.stringify(matrix), /runtime-readiness-secret/);

  recordRuntimeReadinessCheck('ai', {
    tenantId: 1,
    outcome: 'passed',
    checkedAt: 23_000,
    ttlMs: 10_000,
  });
  process.env.YUNWU_API_KEY = 'sk-runtime-readiness-two';
  matrix = runWithTenant(1, () => buildRuntimeReadiness({ tenantId: 1, now: 24_000 }));
  assert.equal(channel(matrix, 'ai').verification, 'stale');
  assert.notEqual(channel(matrix, 'ai').effective, 'connected');
});

test('支付与飞书完整配置在未显式验收前只能是 configured_unverified', () => {
  clearRuntimeReadinessChecks();
  Object.assign(process.env, {
    WXPAY_MCHID: 'merchant',
    WXPAY_SERIAL_NO: 'serial',
    WXPAY_PRIVATE_KEY: 'private-key-placeholder',
    WXPAY_APIV3_KEY: '12345678901234567890123456789012',
    WXPAY_APPID: 'wx-app',
    WXPAY_NOTIFY_URL: 'https://example.com/pay/wechat',
    WXPAY_PLATFORM_CERT: '',
  });
  setTenantConfig('feishu', {
    enabled: true,
    appId: 'cli_runtime',
    appSecret: 'secret_runtime',
    receiveId: 'ou_runtime',
    receiveIdType: 'open_id',
    receiverName: '老板',
  }, 1);

  const matrix = runWithTenant(1, () => buildRuntimeReadiness({ tenantId: 1 }));
  const wechat = channel(matrix, 'payment_wechat');
  assert.equal(wechat.configured, false);
  assert.equal(wechat.configuration, 'partial');
  assert.match(wechat.missing.join(' '), /平台证书/);
  assert.notEqual(wechat.effective, 'connected');

  const feishu = channel(matrix, 'feishu');
  assert.equal(feishu.configured, true);
  assert.equal(feishu.verified, false);
  assert.equal(feishu.effective, 'configured_unverified');
  assert.equal(feishu.canPerformExternalAction, false);
});

test('readiness GET 严禁联网，AI 显式测试成败会更新进程内证据且配置变化使证据过期', async () => {
  clearRuntimeReadinessChecks();
  process.env.YUNWU_API_KEY = 'sk-route-readiness-key';
  setConfig('yunwu_base_url', 'https://93.184.216.34/v1');

  await withServer(async base => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return Response.json({ data: [{ id: 'gpt-test' }] });
    };
    let result = await request(base, '/admin/api-config/test', 'POST', {});
    assert.equal(result.response.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(fetchCalls, 1);

    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('readiness GET 不允许调用 fetch');
    };
    result = await request(base, '/admin/runtime-readiness');
    assert.equal(result.response.status, 200);
    assert.equal(fetchCalls, 1);
    assert.equal(channel(result.json, 'ai').effective, 'connected');

    result = await request(base, '/admin/overview');
    assert.equal(result.response.status, 200);
    assert.equal(fetchCalls, 1);
    assert.equal(result.json.readiness.externalChecksPerformed, false);

    result = await request(base, '/admin/api-config');
    assert.equal(result.response.status, 200);
    assert.equal(fetchCalls, 1);
    assert.equal(result.json.channel.readiness.effective, 'connected');

    result = await request(base, '/sys/runtime-readiness');
    assert.equal(result.response.status, 200);
    assert.equal(fetchCalls, 1);
    assert.equal(channel(result.json, 'ai').effective, 'connected');

    result = await request(base, '/sys/status');
    assert.equal(result.response.status, 200);
    assert.equal(fetchCalls, 1);
    assert.equal(result.json.readiness.externalChecksPerformed, false);

    result = await request(base, '/sys/feishu');
    assert.equal(result.response.status, 200);
    assert.equal(fetchCalls, 1);
    assert.ok(result.json.readiness);

    setConfig('yunwu_base_url', 'https://93.184.216.35/v1');
    result = await request(base, '/admin/runtime-readiness');
    assert.equal(result.response.status, 200);
    assert.equal(fetchCalls, 1);
    assert.equal(channel(result.json, 'ai').verification, 'stale');
    assert.notEqual(channel(result.json, 'ai').effective, 'connected');

    setConfig('yunwu_base_url', 'https://93.184.216.34/v1');
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return Response.json({ error: { message: 'invalid token sk-upstream-secret' } }, { status: 401 });
    };
    result = await request(base, '/admin/api-config/test', 'POST', {});
    assert.equal(result.response.status, 200);
    assert.equal(result.json.ok, false);
    result = await request(base, '/admin/runtime-readiness');
    assert.equal(channel(result.json, 'ai').verification, 'failed');
    assert.notEqual(channel(result.json, 'ai').effective, 'connected');
    assert.doesNotMatch(JSON.stringify(result.json), /sk-upstream-secret/);
  });
});

after(() => {
  globalThis.fetch = nativeFetch;
  clearRuntimeReadinessChecks();
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });
});

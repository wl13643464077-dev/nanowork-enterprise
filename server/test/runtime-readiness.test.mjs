import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const nativeFetch = globalThis.fetch;
const DBP = path.join(os.tmpdir(), `nanowork-runtime-readiness-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });

process.env.NANOWORK_DB = DBP;
process.env.ENABLE_SCHEDULER = 'false';
for (const key of [
  'YUNWU_API_KEY',
  'ANTHROPIC_API_KEY',
  'TINYFISH_API_KEY',
  'CONTENTCREW_CLAUDE_PATH',
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
  'AMAP_WEB_KEY',
  'AMAP_BASE_URL',
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
const {
  resetAmapRuntimeState,
  createAmapClient,
} = await import('../src/engines/amap.js');

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

test('联网检索展示 TinyFish 首选与 Claude 自动回退，并将 TinyFish 密钥纳入配置指纹', () => {
  const previous = {
    tinyfish: process.env.TINYFISH_API_KEY,
    yunwu: process.env.YUNWU_API_KEY,
    claudePath: process.env.CONTENTCREW_CLAUDE_PATH,
  };
  try {
    clearRuntimeReadinessChecks();
    process.env.TINYFISH_API_KEY = 'tinyfish-runtime-readiness-one';
    process.env.YUNWU_API_KEY = '';
    process.env.CONTENTCREW_CLAUDE_PATH = '';

    let matrix = runWithTenant(1, () => buildRuntimeReadiness({ tenantId: 1, now: 1_000 }));
    let search = channel(matrix, 'web_search');
    assert.equal(search.configured, true);
    assert.equal(search.effective, 'configured_unverified');
    assert.equal(search.details.preferredProvider, 'tinyfish');
    assert.equal(search.details.fallbackProvider, 'claude_websearch');
    assert.equal(search.details.automaticFallback, true);
    assert.equal(search.details.providerRoute[0].role, 'primary');
    assert.equal(search.details.providerRoute[0].ready, true);
    assert.equal(search.details.providerRoute[0].verified, false);
    assert.equal(search.details.providerRoute[1].role, 'fallback');
    assert.equal(search.details.providerRoute[1].ready, false);
    assert.equal(search.details.providerRoute[1].verified, false);
    assert.match(search.description, /TinyFish.*首选/u);

    const fingerprint = runWithTenant(1, () => runtimeReadinessConfigFingerprint('web_search', { tenantId: 1 }));
    recordRuntimeReadinessCheck('web_search', {
      tenantId: 1,
      outcome: 'passed',
      configFingerprint: fingerprint,
      checkedAt: 1_000,
      ttlMs: 10_000,
      evidence: { provider: 'TinyFish' },
    });
    matrix = runWithTenant(1, () => buildRuntimeReadiness({ tenantId: 1, now: 2_000 }));
    assert.equal(channel(matrix, 'web_search').effective, 'connected');
    assert.equal(channel(matrix, 'web_search').details.providerRoute[0].verified, true);

    process.env.TINYFISH_API_KEY = 'tinyfish-runtime-readiness-two';
    matrix = runWithTenant(1, () => buildRuntimeReadiness({ tenantId: 1, now: 3_000 }));
    search = channel(matrix, 'web_search');
    assert.equal(search.verification, 'stale');
    assert.notEqual(search.effective, 'connected');
    assert.doesNotMatch(JSON.stringify(search), /tinyfish-runtime-readiness-(?:one|two)/u);

    clearRuntimeReadinessChecks();
    process.env.TINYFISH_API_KEY = '';
    process.env.YUNWU_API_KEY = 'sk-runtime-search-fallback';
    process.env.CONTENTCREW_CLAUDE_PATH = process.execPath;
    matrix = runWithTenant(1, () => buildRuntimeReadiness({ tenantId: 1 }));
    search = channel(matrix, 'web_search');
    const tinyfishRoute = search.details.providerRoute.find(item => item.id === 'tinyfish');
    const claudeRoute = search.details.providerRoute.find(item => item.id === 'claude_websearch');
    assert.equal(search.configured, true);
    assert.equal(search.effective, 'configured_unverified');
    assert.equal(tinyfishRoute.ready, false);
    assert.equal(claudeRoute.configured, true);
    assert.equal(claudeRoute.ready, true);
    assert.match(search.description, /Claude WebSearch.*自动回退.*前置已齐全/u);
    assert.doesNotMatch(JSON.stringify(search), /sk-runtime-search-fallback/u);
  } finally {
    if (previous.tinyfish === undefined) delete process.env.TINYFISH_API_KEY;
    else process.env.TINYFISH_API_KEY = previous.tinyfish;
    if (previous.yunwu === undefined) delete process.env.YUNWU_API_KEY;
    else process.env.YUNWU_API_KEY = previous.yunwu;
    if (previous.claudePath === undefined) delete process.env.CONTENTCREW_CLAUDE_PATH;
    else process.env.CONTENTCREW_CLAUDE_PATH = previous.claudePath;
  }
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

test('第 9 通道高德：未配置=disabled，已配置未验证=configured_unverified，测试通过=connected，配额超限=blocked，密钥变化使验证过期', async () => {
  const previousKey = process.env.AMAP_WEB_KEY;
  const previousBase = process.env.AMAP_BASE_URL;
  const amapKey = 'amap-runtime-readiness-key-must-never-leak';
  try {
    clearRuntimeReadinessChecks();
    resetAmapRuntimeState();
    setConfig('amap_verified_at', '');
    setConfig('amap_verified_fingerprint', '');
    process.env.AMAP_WEB_KEY = '';
    process.env.AMAP_BASE_URL = '';

    let matrix = runWithTenant(1, () => buildRuntimeReadiness({ tenantId: 1 }));
    assert.equal(matrix.channels.length, 9, '就绪矩阵应为 9 通道');
    assert.equal(matrix.summary.total, 9);
    let amap = channel(matrix, 'amap');
    assert.equal(amap.configured, false);
    assert.equal(amap.effective, 'disabled');
    assert.equal(amap.verification, 'not_applicable');
    assert.equal(amap.description, '高德地图未配置，选址岗位使用 OSM 与公开检索。');
    assert.match(amap.missing.join(' '), /AMAP_WEB_KEY/u);
    assert.equal(amap.canPerformExternalAction, false);
    assert.equal(amap.details.fallback, 'osm_and_public_web_search');
    assert.equal(amap.details.cacheTable, 'geo_poi_cache');

    process.env.AMAP_WEB_KEY = amapKey;
    matrix = runWithTenant(1, () => buildRuntimeReadiness({ tenantId: 1, now: 1_000 }));
    amap = channel(matrix, 'amap');
    assert.equal(amap.configured, true);
    assert.equal(amap.effective, 'configured_unverified');
    assert.equal(amap.verified, false);
    assert.match(amap.nextAction, /api-config\/amap\/test/u);
    assert.doesNotMatch(JSON.stringify(amap), /must-never-leak/u);

    await withServer(async base => {
      let amapCalls = 0;
      globalThis.fetch = async input => {
        const url = new URL(String(input));
        assert.equal(url.hostname, 'restapi.amap.com');
        assert.equal(url.pathname, '/v3/geocode/geo');
        assert.equal(url.searchParams.get('key'), amapKey);
        amapCalls += 1;
        return Response.json({
          status: '1',
          infocode: '10000',
          geocodes: [{ location: '116.48,39.99', adcode: '110105', formatted_address: '北京市朝阳区阜通东大街6号' }],
        });
      };
      let result = await request(base, '/admin/api-config/amap/test', 'POST', {});
      assert.equal(result.response.status, 200);
      assert.equal(result.json.ok, true);
      assert.equal(result.json.adcode, '110105');
      assert.equal(result.json.readiness.effective, 'connected');
      assert.equal(result.json.readiness.verification, 'passed');
      assert.equal(result.json.readiness.lastCheck.evidence.blocked, false);
      assert.equal(amapCalls, 1);
      assert.doesNotMatch(JSON.stringify(result.json), /must-never-leak/u);
      assert.equal(typeof q.get("SELECT value FROM sys_config WHERE key='amap_verified_at'")?.value, 'string');

      globalThis.fetch = async () => {
        amapCalls += 1;
        throw new Error('readiness GET 不允许调用 fetch');
      };
      result = await request(base, '/admin/runtime-readiness');
      assert.equal(result.response.status, 200);
      assert.equal(amapCalls, 1);
      assert.equal(channel(result.json, 'amap').effective, 'connected');
      assert.ok(channel(result.json, 'amap').details.persistedVerifiedAt);

      // 进程内检查清空后，持久化 amap_verified_at（指纹一致、24h 内）仍支撑 connected
      clearRuntimeReadinessChecks();
      result = await request(base, '/admin/runtime-readiness');
      assert.equal(channel(result.json, 'amap').effective, 'connected');
      assert.equal(channel(result.json, 'amap').verification, 'never');

      // 密钥变化 → 指纹不同 → 持久化验证失效
      process.env.AMAP_WEB_KEY = `${amapKey}-rotated`;
      result = await request(base, '/admin/runtime-readiness');
      assert.equal(channel(result.json, 'amap').effective, 'configured_unverified');
      assert.equal(channel(result.json, 'amap').details.persistedVerificationStale, true);
      process.env.AMAP_WEB_KEY = amapKey;

      // 日配额超限 → blocked，且旧持久化验证被作废
      globalThis.fetch = async () => Response.json({ status: '0', info: 'DAILY_QUERY_OVER_LIMIT', infocode: '10003' });
      result = await request(base, '/admin/api-config/amap/test', 'POST', {});
      assert.equal(result.response.status, 200);
      assert.equal(result.json.ok, false);
      assert.equal(result.json.blocked, true);
      assert.equal(result.json.quotaExceeded, true);
      assert.equal(result.json.infocode, '10003');
      assert.equal(result.json.readiness.effective, 'blocked');
      assert.match(result.json.readiness.description, /受阻/u);
      assert.match(result.json.readiness.capabilitySummary, /回落 OSM/u);
      assert.equal(q.get("SELECT value FROM sys_config WHERE key='amap_verified_at'")?.value, '""');

      // 运行时（派活链）命中 10001 同样翻 blocked，成功调用后恢复
      clearRuntimeReadinessChecks();
      resetAmapRuntimeState();
      result = await request(base, '/admin/runtime-readiness');
      assert.equal(channel(result.json, 'amap').effective, 'configured_unverified');
      const runtimeClient = createAmapClient({
        fetchImpl: async () => Response.json({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' }),
        cache: false,
      });
      await assert.rejects(() => runtimeClient.geocode('太原吾悦广场', '太原'));
      result = await request(base, '/admin/runtime-readiness');
      assert.equal(channel(result.json, 'amap').effective, 'blocked');
      assert.equal(channel(result.json, 'amap').details.runtime.lastBlocked.infocode, '10001');
      const okClient = createAmapClient({
        fetchImpl: async () => Response.json({ status: '1', infocode: '10000', geocodes: [{ location: '1,2', adcode: '1' }] }),
        cache: false,
      });
      await okClient.geocode('x', 'y');
      result = await request(base, '/admin/runtime-readiness');
      assert.equal(channel(result.json, 'amap').effective, 'configured_unverified');
    });
  } finally {
    globalThis.fetch = nativeFetch;
    resetAmapRuntimeState();
    setConfig('amap_verified_at', '');
    setConfig('amap_verified_fingerprint', '');
    if (previousKey === undefined) delete process.env.AMAP_WEB_KEY;
    else process.env.AMAP_WEB_KEY = previousKey;
    if (previousBase === undefined) delete process.env.AMAP_BASE_URL;
    else process.env.AMAP_BASE_URL = previousBase;
  }
});

after(async () => {
  globalThis.fetch = nativeFetch;
  clearRuntimeReadinessChecks();
  await removeTempDbSafely(DBP);
});

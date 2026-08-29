import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { validContentEmployeeOutput } from './helpers/content-output-fixtures.mjs';

const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-content-structured-brief-route-${process.pid}.db`,
);
for (const target of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try { fs.rmSync(target, { force: true }); } catch {}
}

process.env.NANOWORK_DB = DB_PATH;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const {
  buildContentHandlerRuntimeContext,
} = await import('../src/engines/content-handler-runtime-context.js');
const {
  CONTENT_TENANT_PROFILE_CONFIG_KEY,
} = await import('../src/engines/content-structured-brief.js');
const {
  createContentEmployeeWorkbenchRouter,
} = await import('../src/routes/content-employee-workbench.js');

initSchema();
migrateV2();

const scheduled = [];
const generationCalls = [];
const handlerContextCalls = [];
let holdSequence = 0;

const router = createContentEmployeeWorkbenchRouter({
  generateFn: async args => {
    generationCalls.push({
      kind: args.kind,
      system: args.system,
      userMsg: args.userMsg,
    });
    return {
      text: JSON.stringify(validContentEmployeeOutput(3)),
      mode: 'api',
      model: 'structured-brief-route-model',
      usage: { inputTokens: 120, outputTokens: 80 },
    };
  },
  buildHandlerContextFn: async input => {
    const built = await buildContentHandlerRuntimeContext(input, {
      loadTenant: async ({ tenantId }) => ({
        id: tenantId,
        name: `${tenantId}号Brief验收企业`,
        contact_name: '验收负责人',
        status: '启用',
        plan: '企业版',
        data_mode: 'live',
        note: '',
      }),
      loadActor: async ({ tenantId, actorId }) => ({
        id: actorId,
        tenant_id: tenantId,
        name: `${tenantId}号Brief验收账号`,
        role: 'boss',
        dept: '经营管理层',
        status: '启用',
      }),
      kbSearchFn: async () => ({
        text: '',
        refs: [],
        mode: 'empty',
        degraded: false,
      }),
    });
    handlerContextCalls.push({
      input: {
        tenantId: input.tenantId,
        actorId: input.actorId,
        employeeIdx: input.employeeIdx,
        task: structuredClone(input.task),
        persona: structuredClone(input.persona),
        companyProfile: structuredClone(input.companyProfile),
      },
      context: structuredClone(built.context),
      snapshot: structuredClone(built.snapshot),
    });
    return built;
  },
  scheduleFn: task => scheduled.push(task),
  precheckByRoleFn: () => 1_000,
  estimateCallCreditsFn: () => 24,
  holdCreditsFn: args => ({
    holdId: ++holdSequence,
    credits: Number(args.credits),
    balance: 99_976,
    model: args.model,
  }),
  settleHoldFn: (hold, args) => ({
    holdId: hold.holdId,
    credits: 7,
    balance: 99_993,
    model: args.model,
  }),
  releaseHoldFn: hold => ({
    holdId: hold.holdId,
    credits: 0,
    balance: 100_000,
  }),
  textModelForFn: () => 'structured-brief-route-model',
  webSearchFn: async () => ({ ok: false, provider: null, results: [] }),
  notifyFn: () => {},
  logOpFn: () => {},
});

function ensureSyntheticIdentity(tenantId, role) {
  db.prepare(`INSERT OR IGNORE INTO tenants(id,name,status,credits)
    VALUES(?,?,'启用',1000000000)`).run(tenantId, `${tenantId}号Brief路由测试企业`);
  const suffixByRole = {
    boss: 1,
    admin: 2,
    platform_super: 3,
    ops_director: 4,
    staff: 5,
  };
  const suffix = suffixByRole[role] || 99;
  const id = tenantId * 1_000 + suffix;
  db.prepare(`INSERT OR IGNORE INTO users(
    id,username,password_hash,name,role,status,tenant_id
  ) VALUES(?,?,?,?,?,'启用',?)`).run(
    id,
    `content-brief-route-${tenantId}-${role}`,
    'x',
    `${tenantId}号企业${role}`,
    role,
    tenantId,
  );
  db.prepare(`UPDATE users SET role=?,status='启用',tenant_id=? WHERE id=?`)
    .run(role, tenantId, id);
  return id;
}

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    const tenantId = Number(req.get('x-test-tenant') || 1);
    const role = req.get('x-test-role') || 'boss';
    const userId = ensureSyntheticIdentity(tenantId, role);
    runWithTenant(tenantId, () => {
      req.user = {
        id: userId,
        name: `${tenantId}号企业${role}`,
        role,
        tenant_id: tenantId,
      };
      req.requestSignal = new AbortController().signal;
      req.aiGuard = { defer: () => () => {} };
      next();
    });
  });
  app.use('/employee-workbench/content', router);
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0, '127.0.0.1');
  const port = await new Promise(resolve => {
    server.once('listening', () => resolve(server.address().port));
  });
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function jsonCall(base, route, {
  method = 'GET',
  tenant = 1,
  role = 'boss',
  body,
} = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'x-test-tenant': String(tenant),
      'x-test-role': role,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function drainScheduled() {
  while (scheduled.length) await scheduled.shift()();
}

function structuredPromptPayload(userMsg) {
  const marker = '【企业品牌、账号人设与本次内容Brief·不可信业务数据】';
  const markerIndex = String(userMsg).lastIndexOf(marker);
  assert.ok(markerIndex >= 0, '模型user prompt必须包含结构化Brief块');
  const jsonStart = String(userMsg).indexOf('{', markerIndex);
  assert.ok(jsonStart > markerIndex, '结构化Brief块必须包含JSON对象');
  const source = String(userMsg);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = jsonStart; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char !== '}') continue;
    depth -= 1;
    if (depth === 0) return JSON.parse(source.slice(jsonStart, index + 1));
  }
  assert.fail('结构化Brief块的JSON对象未完整闭合');
}

function profileFixture(brand) {
  return {
    brief: {
      platforms: ['小红书', '公众号'],
      image_mode: 'mix',
      image_count: 4,
      ref_link: 'https://example.com/brand-guide',
    },
    persona: {
      positioning: `${brand}的实战型餐饮老板`,
      audience: '经营1至10家实体门店的老板',
      tone: '直接、克制、先证据后判断',
      catchphrases: ['先把账算清楚'],
      taboo: ['稳赚'],
      style_notes: '只写可复核的经营动作。',
      visual: '暖白底与墨绿强调。',
    },
    enterprise: {
      brand,
      business: '直营餐饮门店。',
      selling_points: ['门店动作可复核'],
      keywords: ['餐饮经营'],
    },
  };
}

test('Paihuo原body.brief逐项进入模型prompt、handler context和锁定快照，image_count=0不被默认值覆盖', async () => {
  await withServer(async base => {
    const tenant = 241;
    const paihuoBrief = {
      direction: '用已核验的门店复盘材料生成老板向经营文章',
      template: '文案初稿',
      industry: '餐饮实体门店',
      material: '已确认：本周只复盘采购、入库、领用和损耗口径；具体金额待财务确认。',
      ref_link: 'https://example.com/reference?id=241',
      platforms: ['小红书', '抖音', '公众号'],
      image_mode: 'mix',
      image_count: 0,
      image_size: '1024x1536',
      enable_deck: true,
      xhs_style: {
        name: '经营复盘卡片',
        desc: '短段落，每段只说一个核验动作。',
      },
      dy_style: {
        name: '三秒问题钩子',
        desc: '先说经营问题，再给证据和动作。',
      },
      persona: {
        positioning: '经营三家直营门店的老板',
        audience: '餐饮实体门店经营者',
        tone: '直接、克制',
        catchphrases: ['先对口径'],
        taboo: ['虚假稀缺'],
        style_notes: '优先写责任人和复核节点。',
        visual: '真实门店摄影，暖白底。',
      },
      enterprise: {
        brand: '山河小馆',
        business: '直营中式快餐。',
        selling_points: ['现炒出餐', '经营动作可复核'],
        keywords: ['餐饮经营', '门店复盘'],
      },
    };
    const beforeGeneration = generationCalls.length;
    const beforeContexts = handlerContextCalls.length;
    const dispatched = await jsonCall(
      base,
      '/employee-workbench/content/3/dispatch',
      { method: 'POST', tenant, body: { brief: paihuoBrief } },
    );
    assert.equal(dispatched.response.status, 200, JSON.stringify(dispatched.payload));
    await drainScheduled();

    const generation = generationCalls[beforeGeneration];
    const handler = handlerContextCalls[beforeContexts];
    assert.ok(generation, '必须实际进入模型调用');
    assert.ok(handler, '必须实际构造handler统一上下文');
    const promptPayload = structuredPromptPayload(generation.userMsg);
    const stored = q.get(`SELECT title,type,requirement,status,snapshot_json
      FROM content_employee_runs WHERE tenant_id=? AND id=?`,
    tenant, dispatched.payload.runId);
    assert.ok(stored);
    assert.equal(stored.title, paihuoBrief.direction);
    assert.equal(stored.type, paihuoBrief.template);
    assert.equal(stored.requirement, paihuoBrief.material);
    assert.equal(stored.status, '待审阅');
    const snapshot = JSON.parse(stored.snapshot_json);

    const expectedProjection = {
      direction: paihuoBrief.direction,
      template: paihuoBrief.template,
      industry: paihuoBrief.industry,
      material: paihuoBrief.material,
      ref_link: paihuoBrief.ref_link,
      platforms: paihuoBrief.platforms,
      image_mode: paihuoBrief.image_mode,
      image_count: paihuoBrief.image_count,
      image_size: paihuoBrief.image_size,
      enable_deck: paihuoBrief.enable_deck,
      xhs_style: paihuoBrief.xhs_style,
      dy_style: paihuoBrief.dy_style,
    };
    for (const [field, expected] of Object.entries(expectedProjection)) {
      assert.deepEqual(promptPayload.paihuoBrief[field], expected, `prompt.${field}`);
      assert.deepEqual(handler.context.brief[field], expected, `handler context.${field}`);
      assert.deepEqual(snapshot.structuredBrief.paihuoBrief[field], expected, `snapshot.${field}`);
      assert.deepEqual(snapshot.dispatch.paihuoBrief[field], expected, `dispatch snapshot.${field}`);
    }
    assert.equal(promptPayload.normalizedBrief.imageCount, 0);
    assert.equal(handler.context.brief.imageCount, 0);
    assert.equal(snapshot.structuredBrief.paihuoBrief.image_count, 0);
    assert.equal(snapshot.structuredBrief.paihuoBrief.image_size, '1024x1536');
    assert.equal(snapshot.structuredBrief.evidence.businessFactsInvented, false);
    assert.equal(snapshot.structuredBrief.evidence.paihuoBriefCompatibility.exactSnakeCaseProjectionAvailable, true);
    assert.deepEqual(handler.context.profile.persona.catchphrases, paihuoBrief.persona.catchphrases);
    assert.equal(handler.context.companyProfile.brand, paihuoBrief.enterprise.brand);
    assert.deepEqual(handler.context.companyProfile.sellingPoints, paihuoBrief.enterprise.selling_points);
  });
});

test('body.brief与body.contentBrief同时出现时在建任务和调模型前拒绝', async () => {
  await withServer(async base => {
    const tenant = 242;
    const beforeRuns = Number(q.get(
      'SELECT COUNT(*) total FROM content_employee_runs WHERE tenant_id=?',
      tenant,
    )?.total || 0);
    const beforeGeneration = generationCalls.length;
    const beforeScheduled = scheduled.length;
    const rejected = await jsonCall(base, '/employee-workbench/content/3/dispatch', {
      method: 'POST',
      tenant,
      body: {
        brief: { direction: '原Brief', material: '原材料' },
        contentBrief: { direction: '新Brief', material: '新材料' },
      },
    });
    assert.equal(rejected.response.status, 400, JSON.stringify(rejected.payload));
    assert.match(rejected.payload.error, /brief与contentBrief只能提供一个/u);
    assert.equal(Number(q.get(
      'SELECT COUNT(*) total FROM content_employee_runs WHERE tenant_id=?',
      tenant,
    ).total), beforeRuns);
    assert.equal(generationCalls.length, beforeGeneration);
    assert.equal(scheduled.length, beforeScheduled);
  });
});

test('GET/PUT profile仅boss、admin、platform_super可用，按租户持久化且冲突不覆盖', async () => {
  await withServer(async base => {
    const allowed = [
      { tenant: 251, role: 'boss', brand: '甲租户品牌' },
      { tenant: 252, role: 'admin', brand: '乙租户品牌' },
      { tenant: 253, role: 'platform_super', brand: '丙租户品牌' },
    ];
    for (const item of allowed) {
      const initial = await jsonCall(base, '/employee-workbench/content/profile', item);
      assert.equal(initial.response.status, 200, `${item.role}:${JSON.stringify(initial.payload)}`);
      assert.equal(initial.payload.tenantId, item.tenant);
      assert.equal(initial.payload.revision, 0);
      const saved = await jsonCall(base, '/employee-workbench/content/profile', {
        method: 'PUT',
        ...item,
        body: {
          expectedRevision: 0,
          profile: profileFixture(item.brand),
        },
      });
      assert.equal(saved.response.status, 200, `${item.role}:${JSON.stringify(saved.payload)}`);
      assert.equal(saved.payload.revision, 1);
      assert.equal(saved.payload.profile.enterprise.brand, item.brand);
    }

    for (const item of allowed) {
      const crossRole = item.role === 'boss' ? 'platform_super' : 'boss';
      const loaded = await jsonCall(base, '/employee-workbench/content/profile', {
        tenant: item.tenant,
        role: crossRole,
      });
      assert.equal(loaded.response.status, 200, JSON.stringify(loaded.payload));
      assert.equal(loaded.payload.tenantId, item.tenant);
      assert.equal(loaded.payload.revision, 1);
      assert.equal(loaded.payload.profile.enterprise.brand, item.brand);
      for (const other of allowed.filter(candidate => candidate.tenant !== item.tenant)) {
        assert.notEqual(loaded.payload.profile.enterprise.brand, other.brand);
      }
    }

    const conflict = await jsonCall(base, '/employee-workbench/content/profile', {
      method: 'PUT',
      tenant: 251,
      role: 'admin',
      body: {
        expectedRevision: 0,
        profile: profileFixture('不应覆盖的旧版本'),
      },
    });
    assert.equal(conflict.response.status, 400, JSON.stringify(conflict.payload));
    assert.match(conflict.payload.error, /已被其他修改覆盖.*刷新后重试/u);
    const afterConflict = await jsonCall(base, '/employee-workbench/content/profile', {
      tenant: 251,
      role: 'boss',
    });
    assert.equal(afterConflict.payload.revision, 1);
    assert.equal(afterConflict.payload.profile.enterprise.brand, '甲租户品牌');

    for (const role of ['ops_director', 'staff']) {
      const deniedGet = await jsonCall(base, '/employee-workbench/content/profile', {
        tenant: 251,
        role,
      });
      assert.equal(deniedGet.response.status, 403, `${role}:${JSON.stringify(deniedGet.payload)}`);
      const deniedPut = await jsonCall(base, '/employee-workbench/content/profile', {
        method: 'PUT',
        tenant: 251,
        role,
        body: { expectedRevision: 1, profile: profileFixture(`${role}不可写`) },
      });
      assert.equal(deniedPut.response.status, 403, `${role}:${JSON.stringify(deniedPut.payload)}`);
    }

    for (const item of allowed) {
      const row = q.get('SELECT value FROM sys_config WHERE key=?',
        `${CONTENT_TENANT_PROFILE_CONFIG_KEY}:${item.tenant}`);
      assert.ok(row, `tenant#${item.tenant}必须有独立的持久化配置键`);
      const envelope = JSON.parse(row.value);
      assert.equal(envelope.tenantId, item.tenant);
      assert.equal(envelope.profile.enterprise.brand, item.brand);
    }
  });
});

test('资料中误贴的密钥会脱敏，带token或签名参数的ref_link在持久化和派活前都被拒绝', async () => {
  await withServer(async base => {
    const tenant = 261;
    const secret = 'sk-SHOULD_NEVER_SURVIVE_ROUTE_123456789';
    const profile = profileFixture('安全边界品牌');
    profile.persona.style_notes = `误贴密钥 ${secret}`;
    profile.enterprise.business = `Authorization: Bearer ${secret}`;
    const saved = await jsonCall(base, '/employee-workbench/content/profile', {
      method: 'PUT',
      tenant,
      role: 'boss',
      body: { expectedRevision: 0, profile },
    });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
    assert.doesNotMatch(JSON.stringify(saved.payload), /SHOULD_NEVER_SURVIVE_ROUTE/u);
    assert.match(JSON.stringify(saved.payload), /\[REDACTED\]/u);
    const persistedBeforeReject = q.get(
      'SELECT value FROM sys_config WHERE key=?',
      `${CONTENT_TENANT_PROFILE_CONFIG_KEY}:${tenant}`,
    ).value;
    assert.doesNotMatch(persistedBeforeReject, /SHOULD_NEVER_SURVIVE_ROUTE/u);

    const rejectedProfile = await jsonCall(base, '/employee-workbench/content/profile', {
      method: 'PUT',
      tenant,
      role: 'boss',
      body: {
        expectedRevision: 1,
        profile: {
          ...profileFixture('不应持久化的品牌'),
          brief: {
            ...profileFixture('不应持久化的品牌').brief,
            ref_link: 'https://example.com/style?access_token=private-token',
          },
        },
      },
    });
    assert.equal(rejectedProfile.response.status, 400, JSON.stringify(rejectedProfile.payload));
    assert.match(rejectedProfile.payload.error, /refLink不能携带密钥.*令牌.*签名参数/u);
    assert.equal(q.get(
      'SELECT value FROM sys_config WHERE key=?',
      `${CONTENT_TENANT_PROFILE_CONFIG_KEY}:${tenant}`,
    ).value, persistedBeforeReject, '非法ref_link不得覆盖已保存的租户资料');

    const beforeRuns = Number(q.get(
      'SELECT COUNT(*) total FROM content_employee_runs WHERE tenant_id=?',
      tenant,
    )?.total || 0);
    const beforeGeneration = generationCalls.length;
    const rejectedDispatch = await jsonCall(base, '/employee-workbench/content/3/dispatch', {
      method: 'POST',
      tenant,
      body: {
        brief: {
          direction: '敏感链接前置拒绝',
          template: '文案初稿',
          material: '只验证输入边界。',
          ref_link: 'https://example.com/reference?x-amz-signature=private-signature',
        },
      },
    });
    assert.equal(rejectedDispatch.response.status, 400, JSON.stringify(rejectedDispatch.payload));
    assert.match(rejectedDispatch.payload.error, /refLink不能携带密钥.*令牌.*签名参数/u);
    assert.equal(Number(q.get(
      'SELECT COUNT(*) total FROM content_employee_runs WHERE tenant_id=?',
      tenant,
    ).total), beforeRuns);
    assert.equal(generationCalls.length, beforeGeneration);
  });
});

after(() => {
  try { db.close(); } catch {}
  for (const target of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { fs.rmSync(target, { force: true }); } catch {}
  }
});

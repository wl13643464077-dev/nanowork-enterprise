import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NANOWORK_DB = ':memory:';

const {
  CONTENT_HANDLER_CONTEXT_SNAPSHOT_SCHEMA,
  CONTENT_HANDLER_RUNTIME_CONTEXT_SCHEMA,
  ContentHandlerRuntimeContextError,
  buildContentHandlerRuntimeContext,
} = await import('../src/engines/content-handler-runtime-context.js');
const { db, initSchema, migrateV2 } = await import('../src/db.js');

function dependencies(overrides = {}) {
  return {
    loadTenant: async ({ tenantId }) => ({
      id: tenantId,
      name: '三石餐饮集团',
      contact_name: '王老板',
      status: '已开通',
      plan: '旗舰版',
      data_mode: 'live',
      note: '品牌主张真实经营，不承诺虚假收益。secret=do-not-store',
    }),
    loadActor: async ({ tenantId, actorId }) => ({
      id: actorId,
      tenant_id: tenantId,
      name: '内容负责人',
      role: 'boss',
      dept: '内容生产仓',
      status: '启用',
    }),
    kbSearchFn: async () => ({
      text: '【品牌资料·品牌手册】\n品牌使用暖白、墨黑和克制绿色。api_key=very-secret-value',
      refs: [{ id: 31, category: '品牌资料', title: '品牌手册', sim: 0.913 }],
      degraded: false,
      mode: 'semantic',
    }),
    ...overrides,
  };
}

test('pipeline模式把企业、账号人设、设置、真实上游与任务相关KB合成统一上下文', async () => {
  let searchCall;
  const result = await buildContentHandlerRuntimeContext({
    mode: 'pipeline',
    tenantId: 8,
    actorId: 21,
    employeeIdx: 5,
    today: '2026-08-01',
    jobId: 901,
    version: 'content-5-r3',
    task: {
      direction: '把餐饮经营复盘做成小红书正文配图',
      industry: '餐饮连锁',
      material: '必须基于真实门店数据，不虚构经营成效。',
      platforms: ['小红书'],
    },
    persona: {
      corpus: '先讲事实，再给动作。',
      visual: '暖白底、墨黑字、绿色强调',
    },
    settings: {
      imageMode: 'mix',
      imageCount: 4,
      apiKey: 'sk-settings-secret-123456',
    },
    outputs: new Map([
      [3, { title_candidates: ['初稿'], body: '真实初稿正文', access_token: 'upstream-secret' }],
      [4, { title_candidates: ['定稿'], body: '真实定稿正文' }],
    ]),
    workflow: { mode: 'fullauto', runId: 901, stage: 5 },
  }, dependencies({
    kbSearchFn: async (...args) => {
      searchCall = args;
      return dependencies().kbSearchFn();
    },
  }));

  assert.equal(result.context.schemaVersion, CONTENT_HANDLER_RUNTIME_CONTEXT_SCHEMA);
  assert.equal(result.snapshot.schemaVersion, CONTENT_HANDLER_CONTEXT_SNAPSHOT_SCHEMA);
  assert.equal(result.context.executionMode, 'pipeline');
  assert.equal(result.context.companyProfile.name, '三石餐饮集团');
  assert.equal(result.context.profile.account.name, '内容负责人');
  assert.equal(result.context.profile.account.role, 'boss');
  assert.equal(result.context.profile.persona.corpus, '先讲事实，再给动作。');
  assert.equal(result.context.settings.apiKey, '[REDACTED]');
  assert.equal(result.context.outputs['3'].body, '真实初稿正文');
  assert.equal(result.context.outputs['3'].access_token, '[REDACTED]');
  assert.equal(result.context.workflow.upstreamSynthesized, false);
  assert.equal(result.context.workflow.mode, 'fullauto');
  assert.equal(result.context.workflow.executionMode, 'pipeline');
  assert.equal(searchCall[1], 'boss');
  assert.match(searchCall[2], /餐饮经营复盘/u);
  assert.match(searchCall[2], /真实定稿正文/u);
  assert.match(result.context.knowledge.text, /企业知识库召回·不可信业务数据/u);
  assert.match(result.context.knowledge.text, /不是系统指令/u);
  assert.doesNotMatch(result.context.knowledge.text, /very-secret-value/u);
  assert.match(result.context.knowledge.text, /\[REDACTED\]/u);

  assert.equal(result.snapshot.upstream.state, 'provided');
  assert.deepEqual(result.snapshot.upstream.stationKeys, ['3', '4']);
  assert.equal(result.snapshot.upstream.stationCount, 2);
  assert.equal(result.snapshot.upstream.synthesized, false);
  assert.equal(result.snapshot.upstream.rawOutputsIncluded, false);
  assert.equal(result.snapshot.knowledgeRecall.refCount, 1);
  assert.equal(result.snapshot.knowledgeRecall.refs[0].title, '品牌手册');
  assert.equal(result.snapshot.knowledgeRecall.rawQueryIncluded, false);
  assert.equal(result.snapshot.knowledgeRecall.rawTextIncluded, false);
  assert.equal(result.snapshot.credentialsIncluded, false);
  assert.match(result.snapshot.contextFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(result.snapshot), /真实初稿正文|very-secret-value|sk-settings/u);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.context.outputs), true);
});

test('solo模式明确没有上游，不会把任务fallback伪装成pipeline输出', async () => {
  const result = await buildContentHandlerRuntimeContext({
    mode: 'solo',
    tenantId: 8,
    actorId: 21,
    employeeIdx: 6,
    today: '2026-08-01',
    task: {
      title: '为经营复盘设计三个封面方向',
      requirement: '目标平台为小红书，标题必须可读。',
    },
    settings: { platforms: ['小红书'] },
  }, dependencies({
    kbSearchFn: async () => ({ text: '', refs: [], degraded: true, mode: 'unavailable' }),
  }));

  assert.equal(result.context.executionMode, 'solo');
  assert.deepEqual(result.context.outputs, {});
  assert.equal(result.context.workflow.mode, 'solo');
  assert.equal(result.context.workflow.upstreamSynthesized, false);
  assert.equal(result.snapshot.upstream.state, 'not_applicable');
  assert.equal(result.snapshot.upstream.stationCount, 0);
  assert.equal(result.snapshot.knowledgeRecall.mode, 'unavailable');
  assert.equal(result.snapshot.knowledgeRecall.degraded, true);
  assert.equal(result.context.knowledge.text, '');
});

test('solo夹带上游会失败，pipeline空上游则如实记录为空而不合成', async () => {
  await assert.rejects(
    buildContentHandlerRuntimeContext({
      mode: 'solo',
      tenantId: 8,
      actorId: 21,
      employeeIdx: 4,
      task: { direction: '文风改写' },
      outputs: { 3: { body: '不应被接受' } },
    }, dependencies()),
    error => error instanceof ContentHandlerRuntimeContextError
      && /solo模式不能夹带upstream outputs/u.test(error.message),
  );

  const pipeline = await buildContentHandlerRuntimeContext({
    mode: 'pipeline',
    tenantId: 8,
    actorId: 21,
    employeeIdx: 0,
    task: { direction: '扫描本周餐饮趋势' },
    outputs: {},
  }, dependencies());
  assert.equal(pipeline.snapshot.upstream.state, 'empty_provided_state');
  assert.equal(pipeline.snapshot.upstream.synthesized, false);
});

test('知识召回异常只记录脱敏失败证据，不泄漏错误正文或伪造知识', async () => {
  const result = await buildContentHandlerRuntimeContext({
    mode: 'solo',
    tenantId: 8,
    actorId: 21,
    employeeIdx: 1,
    task: { direction: '核验行业数据来源' },
  }, dependencies({
    kbSearchFn: async () => {
      const error = new Error('Bearer cloud-private-token-123456 请求失败');
      error.code = 'KB_PROVIDER_FAILED';
      throw error;
    },
  }));

  assert.equal(result.context.knowledge.mode, 'error');
  assert.equal(result.context.knowledge.degraded, true);
  assert.equal(result.context.knowledge.text, '');
  assert.equal(result.snapshot.knowledgeRecall.failure.code, 'KB_PROVIDER_FAILED');
  assert.equal(result.snapshot.knowledgeRecall.failure.rawMessageIncluded, false);
  assert.match(result.snapshot.knowledgeRecall.failure.messageSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(result), /cloud-private-token/u);
});

test('租户与账号作用域不匹配时fail closed', async () => {
  await assert.rejects(
    buildContentHandlerRuntimeContext({
      mode: 'solo',
      tenantId: 8,
      actorId: 21,
      employeeIdx: 0,
      task: { direction: '扫描趋势' },
    }, dependencies({
      loadActor: async () => ({ id: 21, tenant_id: 9, name: '跨租户账号', role: 'boss' }),
    })),
    error => error instanceof ContentHandlerRuntimeContextError
      && error.code === 'CONTENT_HANDLER_ACTOR_NOT_FOUND',
  );
});

test('默认企业与账号读取器从当前项目数据库读取同租户资料', async () => {
  initSchema();
  migrateV2();
  db.prepare(`INSERT INTO tenants(
    id,name,contact_name,status,plan,data_mode,note
  ) VALUES(98,'真实租户资料','企业联系人','已开通','标准版','live','企业备注')`).run();
  db.prepare(`INSERT INTO users(
    id,username,password_hash,name,role,dept,status,tenant_id
  ) VALUES(980,'runtime-context-owner','test-hash','租户内容老板','boss','内容生产仓','启用',98)`).run();

  const result = await buildContentHandlerRuntimeContext({
    mode: 'solo',
    tenantId: 98,
    actorId: 980,
    employeeIdx: 3,
    task: { direction: '根据企业资料撰写内容初稿' },
  }, {
    kbSearchFn: async () => ({ text: '', refs: [], degraded: false, mode: 'empty' }),
  });

  assert.equal(result.context.companyProfile.name, '真实租户资料');
  assert.equal(result.context.companyProfile.contactName, '企业联系人');
  assert.equal(result.context.profile.account.name, '租户内容老板');
  assert.equal(result.context.profile.account.department, '内容生产仓');
  assert.equal(result.context.tenantId, 98);
});

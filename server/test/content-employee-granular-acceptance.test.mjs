import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { after, test } from 'node:test';

// This file is an isolated Luna acceptance harness.  It only exercises the
// local catalogue, contracts, handlers and an injected model/accounting
// runtime; no network, provider or paid API is called.
const dbPath = path.join(
  os.tmpdir(),
  `nanowork-content-granular-acceptance-${process.pid}.db`,
);
for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
}
process.env.NANOWORK_DB = dbPath;
process.env.SEED_DEMO = 'false';
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const {
  CONTENT_EMPLOYEES,
  CONTENT_EMPLOYEE_ROSTER,
  contentEmployeeByIdx,
} = await import('../src/catalog/content-crew.js');
const {
  buildContentEmployeeWorkbenchProfile,
  buildContentEmployeeConnectorExecution,
} = await import('../src/engines/content-employee-workbench.js');
const {
  CONTENT_CONNECTOR_REGISTRY,
  connectorDescriptor,
  executeContentConnector,
} = await import('../src/engines/content-connectors.js');
const {
  getContentEmployeeOutputResponseSchema,
} = await import('../src/engines/content-output-contract.js');
const {
  resolveApprovalRoute,
} = await import('../src/engines/approval-routing-policy.js');
const { holdCredits, settleHold } = await import('../src/engines/credits.js');
const { releaseFailedAiHold } = await import('../src/engines/ai-delivery-status.js');
const { createContentEmployeeWorkbenchRouter } = await import(
  '../src/routes/content-employee-workbench.js'
);
const { validContentEmployeeOutput } = await import('./helpers/content-output-fixtures.mjs');

initSchema();
migrateV2();

const TENANT_ID = 811;
const BOSS_ID = 811001;
const SUPER_ID = 811002;
const STAFF_ID = 811003;
db.prepare(`INSERT OR REPLACE INTO tenants(id,name,status,credits)
  VALUES(?,?,?,?)`).run(TENANT_ID, '内容生产颗粒度验收租户', '已开通', 1_000_000);
for (const [id, username, name, role] of [
  [BOSS_ID, 'granular-boss', '验收老板', 'boss'],
  [SUPER_ID, 'granular-super', '验收平台超管', 'platform_super'],
  [STAFF_ID, 'granular-staff', '验收普通员工', 'staff'],
]) {
  db.prepare(`INSERT OR REPLACE INTO users(
    id,username,password_hash,name,role,dept,status,tenant_id
  ) VALUES(?,?,?,?,?,?,?,?)`).run(
    id, username, 'x', name, role, '内容生产部', '启用', TENANT_ID,
  );
}

const primaryConnectorByIdx = new Map(
  CONTENT_EMPLOYEE_ROSTER.map(employee => [
    employee.idx,
    employee.connectorPolicy.connectors.find(connector => connector.primary === true),
  ]),
);

function assertCompleteProfile(profile, employee) {
  assert.equal(profile.identity.idx, employee.idx, employee.name);
  assert.equal(profile.identity.key, employee.key, employee.name);
  assert.ok(profile.capabilities.length >= 3, `${employee.name}: capability count`);
  assert.ok(profile.capabilities.every(capability => (
    capability.required === true
      && capability.enabled === true
      && capability.locked === true
  )), `${employee.name}: all capabilities must be required/enabled/locked`);
  assert.ok(profile.skillLibrary.required.length >= 1, `${employee.name}: required Skill`);
  assert.ok(profile.skillLibrary.defaultInjected.length >= profile.skillLibrary.required.length);
  assert.ok(profile.prompts.pipelinePrompt?.template, `${employee.name}: pipeline prompt`);
  assert.ok(profile.prompts.soloPrompt?.template, `${employee.name}: solo prompt`);
  for (const key of ['workMethod', 'workConfig', 'jobProfile', 'runtimeBindings']) {
    assert.ok(profile[key] && !profile[key].redacted, `${employee.name}: full ${key}`);
  }
  for (const key of ['input', 'execution', 'output', 'approval', 'handoff']) {
    assert.ok(profile.workMethod[key], `${employee.name}: workMethod.${key}`);
  }
  assert.ok(profile.workConfig.factoryDefault, `${employee.name}: factory work config`);
  assert.ok(profile.workConfig.safeLegacyConfig, `${employee.name}: safe legacy config`);
  assert.ok(profile.jobProfile.outputSchema?.contract, `${employee.name}: output contract`);
  assert.ok(profile.jobProfile.connectorPolicy?.connectors?.length, `${employee.name}: connector policy`);
  const webPolicy = profile.runtimeBindings.currentRuntimeBindings.webPolicy;
  assert.equal(webPolicy.available, true, `${employee.name}: web available`);
  assert.equal(webPolicy.allowed, true, `${employee.name}: web allowed`);
  assert.equal(webPolicy.tenantScoped, true, `${employee.name}: web tenant scoped`);
  assert.equal(webPolicy.knowledgeBase.allowed, true, `${employee.name}: KB allowed`);
  assert.equal(webPolicy.knowledgeBase.tenantScoped, true, `${employee.name}: KB tenant scoped`);
  assert.equal(profile.workMethod.execution.webAllowed, true, `${employee.name}: execution web flag`);
  assert.equal(profile.workMethod.execution.tenantKnowledgeBaseAllowed, true, `${employee.name}: execution KB flag`);
  assert.equal(
    profile.runtimeBindings.currentRuntimeBindings.work.handler,
    employee.idx === 10
      ? 'native-content-handler:ai-sales-video'
      : `content-handler-adapter:${employee.workMethod.execution.handler}`,
    `${employee.name}: bound handler`,
  );
  for (const field of [
    'identity', 'provenance', 'jobProfile', 'capabilities', 'skills',
    'workMethod', 'prompts', 'runtimeBindings', 'workConfig', 'contracts', 'permissions',
  ]) {
    assert.ok(profile.canonicalProfile?.fingerprints?.fields?.[field], `${employee.name}: canonical ${field}`);
  }
}

function appFor(router, user) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    runWithTenant(TENANT_ID, () => {
      req.user = user;
      req.requestSignal = new AbortController().signal;
      req.aiGuard = { defer: () => () => {} };
      next();
    });
  });
  app.use('/employee-workbench/content', router);
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ error: error.message });
  });
  return app;
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function callJson(base, route, { user, method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-test-user': String(user.id),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test('11名内容员工管理视图完整复用派活档案：能力、技能、提示词、工作方式、配置、岗位档案与接线', () => {
  assert.equal(CONTENT_EMPLOYEES.length, 10, 'Paihuo source roster must remain ten employees');
  assert.equal(CONTENT_EMPLOYEE_ROSTER.length, 11, 'runtime roster must add AI带货员');
  for (const employee of CONTENT_EMPLOYEE_ROSTER) {
    const profile = buildContentEmployeeWorkbenchProfile(employee.idx);
    assertCompleteProfile(profile, employee);
  }
});

test('0-9及AI带货员编译完整连接器包；每个连接器均绑定正确处理器与输出契约', () => {
  for (const employee of CONTENT_EMPLOYEE_ROSTER) {
    const descriptor = primaryConnectorByIdx.get(employee.idx);
    assert.ok(descriptor, `${employee.name}: primary connector`);
    const profile = buildContentEmployeeWorkbenchProfile(employee.idx);
    const execution = buildContentEmployeeConnectorExecution(employee.idx, {
      direction: `请完成${employee.name}的一句话业务任务`,
      industry: '餐饮',
      material: '只提供一个业务目标，公开资料由系统侧检索，不能要求老板重复填写材料清单。',
      feedback: '',
      length: 'std',
    }, {
      connectorKind: descriptor.kind,
      connectorContract: {
        name: `${employee.name}主连接器验收`,
        outputFormat: profile.jobProfile.outputSchema.primaryArtifact,
        instruction: '必须输出完整岗位契约，不得删减能力、技能或工作方式。',
      },
      tenantOverlay: { revision: 0 },
    });
    assert.equal(execution.snapshot.identity.idx, employee.idx);
    assert.equal(execution.snapshot.connector.kind, descriptor.kind);
    assert.equal(execution.snapshot.connector.nativePrimaryArtifact, profile.jobProfile.outputSchema.primaryArtifact);
    assert.equal(execution.snapshot.promptCompilation.completeProfileIncluded, true);
    assert.equal(execution.snapshot.promptCompilation.connectorContractAppendedLast, true);
    assert.equal(execution.snapshot.handlerExecution.connectorMode, descriptor.mode);
    assert.equal(
      execution.snapshot.handlerExecution.currentConnectorHandler,
      descriptor.mode === 'employee_generation'
        ? 'buildContentEmployeeConnectorExecution'
        : 'executeContentConnector',
    );
    if (employee.idx <= 9) {
      const responseSchema = getContentEmployeeOutputResponseSchema(employee.idx);
      assert.ok(responseSchema && responseSchema.schema, `${employee.name}: response schema`);
      assert.equal(responseSchema.schema.properties ? typeof responseSchema.schema.properties : 'object', 'object');
    } else {
      assert.match(profile.jobProfile.outputSchema.contract, /video_plan|durationSeconds|segmentDurationSeconds/u);
    }
  }
});

test('0-9本地连接器使用各自真实本地处理器，员工生成连接器严格转入单员工链', () => {
  const liveData = [{
    title: '本地测试公开来源',
    source: '官方公开页面',
    observedAt: '2026-08-08',
    excerpt: '本地隔离测试观测，不联网、不代表当前业务事实。',
    url: 'https://evidence.invalid/local-test',
  }];
  const localInputs = {
    trend_research: { input: { channels: ['公开渠道'] }, context: { liveData } },
    evidence_research: { input: { task: '核验公开事实' }, context: { liveData } },
    benchmark_analysis: { input: { samples: [{ title: '样本', body: '样本正文，用于本地拆解。', platform: '小红书' }] }, context: {} },
    style_rewrite: { input: { sourceText: '原稿正文', styleGuide: '直接、克制、先证据后判断' }, context: {} },
    cover: { input: { title: '经营判断', platform: '小红书', subtitle: '本地安全封面草稿' }, context: {} },
    html: { input: { title: '经营复盘', sections: [{ heading: '第一段', body: '本地HTML正文' }] }, context: {} },
    publish_package: { input: { title: '发布包', content: '仅本地发布包正文', platforms: ['公众号'] }, context: { operation: 'package' } },
    performance_retro: { input: { contentId: 'local-content-1' }, context: {} },
  };
  for (const descriptor of CONTENT_CONNECTOR_REGISTRY) {
    const result = descriptor.mode === 'employee_generation'
      ? executeContentConnector(descriptor.kind, {}, {})
      : executeContentConnector(
        descriptor.kind,
        localInputs[descriptor.kind]?.input || {},
        localInputs[descriptor.kind]?.context || {},
      );
    if (descriptor.mode === 'employee_generation') {
      assert.equal(result.ok, false, descriptor.kind);
      assert.equal(result.code, 'CONTENT_CONNECTOR_EMPLOYEE_GENERATION_REQUIRED', descriptor.kind);
      assert.equal(result.networkAccess, false, descriptor.kind);
      assert.equal(result.costIncurred, false, descriptor.kind);
    } else {
      assert.equal(result.ok, true, descriptor.kind);
      assert.equal(result.completed, true, descriptor.kind);
      assert.equal(result.networkAccess, false, descriptor.kind);
      assert.equal(result.costIncurred, false, descriptor.kind);
      assert.ok(result.output, `${descriptor.kind}: local output`);
    }
  }
});

test('AI带货员只走专用30秒视频能力，图片/视频/PPT需求不会被文档冒充', () => {
  const employee = contentEmployeeByIdx(10);
  const profile = buildContentEmployeeWorkbenchProfile(10);
  assert.equal(employee.key, 'commerce_video');
  assert.equal(profile.runtimeBindings.currentRuntimeBindings.work.adapter, 'ai-sales-video');
  assert.equal(profile.runtimeBindings.currentRuntimeBindings.work.execution.workflow, 'ai_sales_video');
  assert.equal(profile.runtimeBindings.currentRuntimeBindings.work.execution.durationSeconds, 30);
  assert.equal(profile.runtimeBindings.currentRuntimeBindings.work.execution.segmentCount, 3);
  assert.equal(profile.runtimeBindings.currentRuntimeBindings.work.execution.segmentDurationSeconds, 10);
  const kinds = profile.runtimeBindings.currentRuntimeBindings.connectors.map(connector => connector.kind);
  assert.deepEqual(kinds, ['sales_video_plan', 'sales_video_generation']);
  for (const connector of profile.runtimeBindings.currentRuntimeBindings.connectors) {
    assert.equal(connector.businessEndpoint, '/api/content/ai-sales-video');
    assert.equal(connector.handler, 'ai-sales-video');
  }
  assert.equal(profile.jobProfile.outputSchema.primaryArtifact, 'video_plan');
  assert.equal(profile.runtime.bindings?.workflow || profile.runtime.workflow, 'ai_sales_video');
});

test('普通角色服务端掩码内部档案，老板/管理员视图保留完整字段', async () => {
  const router = createContentEmployeeWorkbenchRouter({
    scheduleFn: () => {},
    notifyFn: () => {},
    logOpFn: () => {},
  });
  const boss = { id: BOSS_ID, name: '验收老板', role: 'boss', tenant_id: TENANT_ID };
  const staff = { id: STAFF_ID, name: '验收普通员工', role: 'staff', tenant_id: TENANT_ID };
  await withServer(appFor(router, boss), async base => {
    const { response, payload } = await callJson(base, '/employee-workbench/content/5', { user: boss });
    assert.equal(response.status, 200);
    assert.equal(payload.permissions.canViewCapabilities, true);
    assert.ok(payload.capabilities.length > 0);
    assert.ok(payload.workMethod.steps?.length > 0);
    assert.ok(payload.skillLibrary.required.length > 0);
    assert.ok(payload.prompts.soloPrompt.template);
    assert.ok(payload.workConfig.factoryDefault);
    assert.ok(payload.jobProfile.outputSchema);
    assert.ok(payload.runtimeBindings.currentRuntimeBindings);
  });
  await withServer(appFor(router, staff), async base => {
    const { response, payload } = await callJson(base, '/employee-workbench/content/5', { user: staff });
    assert.equal(response.status, 200);
    for (const permission of [
      'canViewInternalProfile',
      'canViewCapabilities',
      'canViewSkills',
      'canViewPrompt',
      'canViewWorkMethod',
      'canViewWorkConfig',
      'canViewJobProfile',
      'canViewRuntimeBindings',
    ]) assert.equal(payload.permissions[permission], false, permission);
    assert.deepEqual(payload.capabilities, []);
    assert.equal(payload.skillLibrary.redacted, true);
    assert.equal(payload.prompts.redacted, true);
    assert.equal(payload.workMethod.redacted, true);
    assert.equal(payload.workConfig.redacted, true);
    assert.equal(payload.jobProfile.redacted, true);
    assert.equal(payload.runtimeBindings.redacted, true);
  });
});

test('只输入一句业务问题即可派活；Boss/platform_super 内部任务不创建审批', async () => {
  // Pin the injected local model in the tenant overlay so the authoritative
  // hold and the generated provider evidence use the same model identity.
  q.run(`INSERT OR REPLACE INTO content_employee_workbench_configs(
    tenant_id,employee_idx,prompt_override,work_config_json,skills_json,revision,updated_by,updated_at
  ) VALUES(?,?,?,?,?,?,?,datetime('now','localtime'))`,
  TENANT_ID, 3, null, JSON.stringify({ textModel: 'local-luna-test-model' }), '[]', 1, BOSS_ID);
  const scheduled = [];
  const modelCalls = [];
  let holdCounter = 0;
  const router = createContentEmployeeWorkbenchRouter({
    generateFn: async args => {
      modelCalls.push(args);
      return {
        text: JSON.stringify(validContentEmployeeOutput(3)),
        mode: 'api',
        model: 'local-luna-test-model',
        usage: { inputTokens: 120, outputTokens: 80 },
      };
    },
    scheduleFn: task => scheduled.push(task),
    precheckByRoleFn: () => 1_000,
    estimateCallCreditsFn: () => 30,
    holdCreditsFn: args => holdCredits({ ...args, credits: 30 }),
    settleHoldFn: (hold, args) => settleHold(hold, {
      ...args,
      credits: 7,
      model: 'local-luna-test-model',
      aiMode: 'api',
      usage: { inputTokens: 120, outputTokens: 80 },
    }),
    releaseHoldFn: hold => releaseFailedAiHold(hold, 'isolated acceptance cleanup'),
    textModelForFn: () => 'local-luna-test-model',
    buildHandlerContextFn: async () => ({
      context: {},
      snapshot: { schemaVersion: 'local-luna-content-handler-context/1' },
    }),
    webSearchFn: async () => {
      throw new Error('network must never be called by this non-web task');
    },
    notifyFn: () => {},
    logOpFn: () => {},
  });
  const boss = { id: BOSS_ID, name: '验收老板', role: 'boss', tenant_id: TENANT_ID };
  const platformSuper = { id: SUPER_ID, name: '验收平台超管', role: 'platform_super', tenant_id: TENANT_ID };

  for (const user of [boss, platformSuper]) {
    await withServer(appFor(router, user), async base => {
      const beforeApprovals = Number(q.get(
        `SELECT COUNT(*) count FROM approvals WHERE tenant_id=?`, TENANT_ID,
      )?.count || 0);
      const { response, payload } = await callJson(
        base,
        '/employee-workbench/content/3/dispatch',
        {
          user,
          method: 'POST',
          // Deliberately no industry/material/feedback/brief: one question only.
          body: {
            title: '门店经营复盘',
            requirement: '请把本周门店经营复盘整理成老板能直接执行的内容初稿。',
          },
        },
      );
      assert.equal(response.status, 200, JSON.stringify(payload));
      assert.equal(payload.queued, true);
      while (scheduled.length) await scheduled.shift()();
      const row = q.get(
        `SELECT status,result_md,snapshot_json FROM content_employee_runs WHERE tenant_id=? AND id=?`,
        TENANT_ID,
        payload.runId,
      );
      assert.ok(row, `${user.role}: run persisted`);
      const snapshot = JSON.parse(row.snapshot_json);
      assert.equal(snapshot.dispatch.requirement, '请把本周门店经营复盘整理成老板能直接执行的内容初稿。');
      assert.equal(snapshot.approvalRouting.requiresReview, false, `${user.role}: no internal approval`);
      assert.equal(snapshot.approvalRouting.autoAdopt, true, `${user.role}: auto adopt`);
      assert.equal(snapshot.approvalRouting.actorAuthorizationSatisfied, false,
        `${user.role}: auto policy should not fake self-authorization when no approval step exists`);
      assert.equal(snapshot.review?.decision, 'auto_adopt', `${user.role}: internally adopted`);
      assert.equal(row.status, '已完成', `${user.role}: terminal status`);
      assert.equal(modelCalls.at(-1)?.mode, undefined, 'only injected local model call is used');
      const afterApprovals = Number(q.get(
        `SELECT COUNT(*) count FROM approvals WHERE tenant_id=?`, TENANT_ID,
      )?.count || 0);
      assert.equal(afterApprovals, beforeApprovals, `${user.role}: approval rows must stay unchanged`);
    });
  }
});

test('审批路由本身保留老板可配置能力，但内部 auto 不生成步骤，外部动作才锁老板执行授权', () => {
  const policy = {
    employeeOutput: { mode: 'auto' },
    activityPlan: { mode: 'two_step' },
    activityChecklist: { mode: 'two_step' },
  };
  for (const actorRole of ['boss', 'platform_super']) {
    const internal = resolveApprovalRoute({
      targetType: 'content',
      riskLevel: 'high',
      actorRole,
      actorUserId: actorRole === 'boss' ? BOSS_ID : SUPER_ID,
      policy,
    });
    assert.equal(internal.requiresReview, false, actorRole);
    assert.equal(internal.autoAdopt, true, actorRole);
    assert.deepEqual(internal.steps, [], actorRole);

    const external = resolveApprovalRoute({
      targetType: 'content',
      externalAction: true,
      actorRole,
      actorUserId: actorRole === 'boss' ? BOSS_ID : SUPER_ID,
      policy,
    });
    assert.equal(external.executionAuthorizationRequired, false, actorRole);
    assert.equal(external.executionAuthorizationSatisfied, true, actorRole);
    assert.deepEqual(external.steps, [], actorRole);
  }
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
});

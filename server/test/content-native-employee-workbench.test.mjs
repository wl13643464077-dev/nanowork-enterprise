import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTENT_EMPLOYEES,
  CONTENT_EMPLOYEE_ROSTER,
  NATIVE_CONTENT_EMPLOYEES,
  publicContentCrew,
} from '../src/catalog/content-crew.js';
// 模型白名单读取平台开关，显式准备独立内存配置。
process.env.NANOWORK_DB = ':memory:';
const { db, initSchema } = await import('../src/db.js');
initSchema();
after(() => db.close());

const {
  buildContentEmployeeConnectorExecution,
  buildContentEmployeeWorkbenchProfile,
  compileContentEmployeeSoloPrompt,
  contentEmployeeTaskTypes,
} = await import('../src/engines/content-employee-workbench.js');

const nativeTask = {
  direction: '用人物和招牌菜图片做一支30秒带货视频',
  industry: '餐饮',
  material: '已上传人物、菜品和门店参考图；价格与评价未提供，禁止猜测。',
  feedback: '没有真实供应商结果时只返回计划或阻断状态。',
  length: 'std',
};

test('内容仓保留0-9来源目录并提供AI带货和小红书种草两名原生员工', () => {
  assert.equal(CONTENT_EMPLOYEES.length, 10);
  assert.equal(NATIVE_CONTENT_EMPLOYEES.length, 2);
  assert.deepEqual(
    CONTENT_EMPLOYEE_ROSTER.map(employee => employee.idx),
    Array.from({ length: 12 }, (_, idx) => idx),
  );
  const native = NATIVE_CONTENT_EMPLOYEES[0];
  assert.equal(native.key, 'commerce_video');
  assert.equal(native.name, 'AI带货员');
  assert.ok(native.capabilities.length >= 4);
  assert.ok(native.capabilities.every(capability => (
    capability.required && capability.enabled && capability.locked
  )));
  assert.deepEqual(native.outputSchema.keys, native.outputKeys);
  assert.equal(native.defaultWorkConfig.roleSpecific.durationSeconds, 15);
  assert.equal(native.defaultWorkConfig.roleSpecific.segmentPolicy, 'model_dependent');
  assert.deepEqual(native.defaultWorkConfig.roleSpecific.segmentPlans.map(plan => [plan.segmentCount, plan.segmentDurationSeconds]), [[1, 15], [2, 15], [3, 10]]);
  assert.equal(native.sourceProvenance.native, true);
  assert.equal(publicContentCrew().employees.length, 12);
  assert.equal(publicContentCrew().employees.at(-1).idx, 11);
  const xhs = NATIVE_CONTENT_EMPLOYEES.find(employee => employee.idx === 11);
  assert.equal(xhs.key, 'xhs_note');
  assert.equal(xhs.name, 'AI小红书种草员');
  assert.deepEqual(xhs.connectorPolicy.connectors.map(connector => connector.kind), ['xhs_note_generation']);
  assert.equal(xhs.sourceProvenance.native, true);
});

test('AI带货员工作台完整装载岗位包、权限、运行绑定与30秒输出契约', () => {
  const profile = buildContentEmployeeWorkbenchProfile(10);
  for (const field of [
    'identity', 'capabilities', 'workMethod', 'skillLibrary', 'prompts',
    'workConfig', 'jobProfile', 'runtimeBindings', 'runtime', 'dispatch',
    'permissions', 'provenance', 'canonicalProfile',
  ]) assert.ok(profile[field], field);
  assert.equal(profile.identity.idx, 10);
  assert.equal(profile.identity.key, 'commerce_video');
  assert.equal(profile.identity.person, null);
  assert.equal(profile.skillLibrary.required.length, 1);
  assert.equal(profile.skillLibrary.historical.length, 0);
  assert.equal(profile.skillLibrary.defaultInjected.length, 1);
  assert.equal(profile.runtime.workflow, 'ai_sales_video');
  assert.equal(profile.runtime.durationSeconds, 15);
  assert.equal(profile.runtime.segmentPolicy, 'model_dependent');
  assert.deepEqual(profile.runtime.segmentPlans.map(plan => [plan.segmentCount, plan.segmentDurationSeconds]), [[1, 15], [2, 15], [3, 10]]);
  assert.equal(profile.skillLibrary.required[0].title, '图生带货视频制作');
  assert.equal(profile.runtimeBindings.currentRuntimeBindings.skillLearning.supported, true);
  assert.equal(profile.permissions.mayDisableRequiredCapabilities, false);
  assert.equal(profile.jobProfile.outputSchema.primaryArtifact, 'video_plan');
  assert.deepEqual(profile.jobProfile.outputSchema.keys, [
    'facts', 'script', 'subtitles', 'segments', 'cover', 'video',
  ]);
  assert.equal(profile.canonicalProfile.fingerprints.fields.permissions.startsWith('sha256:'), true);
  assert.ok(Object.isFrozen(profile));
});

test('AI带货员按模型选择30秒分段计划，支持全网进修且连接器不伪造成片', () => {
  assert.deepEqual(contentEmployeeTaskTypes(10), [
    '15秒带货视频', '菜品口播视频', '门店探店转化视频',
  ]);
  const compiled = compileContentEmployeeSoloPrompt(10, nativeTask);
  assert.match(compiled.systemPrompt, /30秒/u);
  assert.match(compiled.systemPrompt, /三段10秒/u);
  assert.match(compiled.systemPrompt, /两段15秒/u);
  assert.match(compiled.systemPrompt, /只有真实供应商结果才能称为成片/u);
  assert.equal(compiled.snapshot.runtimePackageLoad.allRequiredFieldsLoaded, true);
  assert.equal(compiled.snapshot.runtimePackageLoad.connectorBindingCount, 2);

  const planConnector = buildContentEmployeeConnectorExecution(10, nativeTask, {
    connectorKind: 'sales_video_plan',
    connectorContract: {
      name: 'sales_video_plan',
      outputFormat: 'application/json',
      instruction: '只输出脚本、字幕和三段10秒视频计划。',
    },
    tenantOverlay: {},
  });
  assert.equal(planConnector.profile.identity.idx, 10);
  assert.equal(planConnector.connector.kind, 'sales_video_plan');
  assert.equal(planConnector.snapshot.handlerExecution.connectorRelationship, 'primary_connector');
  assert.equal(planConnector.snapshot.connector.kind, 'sales_video_plan');
  assert.match(planConnector.snapshot.provenance.contentCatalog.sourceBoundary, /原生扩展/u);
});

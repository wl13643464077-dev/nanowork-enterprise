import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTENT_EMPLOYEES,
  CONTENT_EMPLOYEE_ROSTER,
  NATIVE_CONTENT_EMPLOYEES,
  publicContentCrew,
} from '../src/catalog/content-crew.js';
import {
  buildContentEmployeeConnectorExecution,
  buildContentEmployeeWorkbenchProfile,
  compileContentEmployeeSoloPrompt,
  contentEmployeeTaskTypes,
} from '../src/engines/content-employee-workbench.js';

const nativeTask = {
  direction: '用人物和招牌菜图片做一支30秒带货视频',
  industry: '餐饮',
  material: '已上传人物、菜品和门店参考图；价格与评价未提供，禁止猜测。',
  feedback: '没有真实供应商结果时只返回计划或阻断状态。',
  length: 'std',
};

test('内容仓组合roster在不改写0-9来源目录的前提下提供第11名原生AI带货员', () => {
  assert.equal(CONTENT_EMPLOYEES.length, 10);
  assert.equal(NATIVE_CONTENT_EMPLOYEES.length, 1);
  assert.deepEqual(
    CONTENT_EMPLOYEE_ROSTER.map(employee => employee.idx),
    [...Array.from({ length: 10 }, (_, idx) => idx), 10],
  );
  const native = NATIVE_CONTENT_EMPLOYEES[0];
  assert.equal(native.key, 'commerce_video');
  assert.equal(native.name, 'AI带货员');
  assert.ok(native.capabilities.length >= 4);
  assert.ok(native.capabilities.every(capability => (
    capability.required && capability.enabled && capability.locked
  )));
  assert.deepEqual(native.outputSchema.keys, native.outputKeys);
  assert.equal(native.defaultWorkConfig.roleSpecific.durationSeconds, 30);
  assert.equal(native.defaultWorkConfig.roleSpecific.segmentCount, 3);
  assert.equal(native.sourceProvenance.native, true);
  assert.equal(publicContentCrew().employees.length, 11);
  assert.equal(publicContentCrew().employees.at(-1).idx, 10);
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
  assert.equal(profile.runtime.durationSeconds, 30);
  assert.equal(profile.runtime.segmentDurationSeconds, 10);
  assert.equal(profile.runtime.segmentCount, 3);
  assert.equal(profile.permissions.mayDisableRequiredCapabilities, false);
  assert.equal(profile.jobProfile.outputSchema.primaryArtifact, 'video_plan');
  assert.deepEqual(profile.jobProfile.outputSchema.keys, [
    'facts', 'script', 'subtitles', 'segments', 'cover', 'video',
  ]);
  assert.equal(profile.canonicalProfile.fingerprints.fields.permissions.startsWith('sha256:'), true);
  assert.ok(Object.isFrozen(profile));
});

test('AI带货员沿用现有ai-sales-video的30秒三段10秒计划描述且连接器不伪造成片', () => {
  assert.deepEqual(contentEmployeeTaskTypes(10), [
    '30秒带货视频', '菜品口播视频', '门店探店转化视频',
  ]);
  const compiled = compileContentEmployeeSoloPrompt(10, nativeTask);
  assert.match(compiled.systemPrompt, /30秒/u);
  assert.match(compiled.systemPrompt, /三段10秒/u);
  assert.match(compiled.systemPrompt, /不得伪造视频URL/u);
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  CONTENT_CREW,
  CONTENT_CREW_CATALOG_PATH,
  publicContentCrew,
  validateContentCrewCatalog,
} from '../src/catalog/content-crew.js';
import {
  CONTENT_CONNECTOR_REGISTRY,
  connectorDescriptor,
  executeContentConnector,
  prepareContentConnectorEmployeeExecution,
} from '../src/engines/content-connectors.js';

const FORMER_CATALOG_ONLY_KINDS = [
  'trend_research',
  'evidence_research',
  'benchmark_analysis',
  'style_rewrite',
  'cover',
  'html',
  'publish_package',
  'performance_retro',
];

const catalogConnectors = CONTENT_CREW.employees.flatMap(employee => (
  employee.connectorPolicy.connectors.map(connector => ({
    ...connector,
    employeeIdx: employee.idx,
    employeeName: employee.name,
  }))
));

const rosterConnectors = [
  ...CONTENT_CREW.employees,
  ...(Array.isArray(CONTENT_CREW.nativeEmployees) ? CONTENT_CREW.nativeEmployees : []),
].flatMap(employee => (
  employee.connectorPolicy.connectors.map(connector => ({
    ...connector,
    employeeIdx: employee.idx,
    employeeName: employee.name,
  }))
));

function assertLocalFacts(result) {
  assert.equal(result.networkAccess, false);
  assert.deepEqual(result.externalActionsPerformed, []);
  assert.equal(result.costIncurred, false);
  assert.equal(result.credentialsAccepted, false);
}

function runtimeBoundaryProjection(value) {
  return String(value || '')
    .replaceAll('人工复核', '岗位质量门')
    .replaceAll('人工审核', '中央采用策略')
    .replaceAll('老板审批', '中央采用策略')
    .replaceAll('人类审批', '老板执行授权');
}

test('历史8个catalog_only连接器全部归零且逐项进入明确运行状态', () => {
  const raw = JSON.parse(fs.readFileSync(CONTENT_CREW_CATALOG_PATH, 'utf8'));
  const rawConnectors = raw.employees.flatMap(employee => employee.connectorPolicy.connectors);
  assert.equal(rawConnectors.filter(connector => connector.newProjectStatus === 'catalog_only').length, 0);
  assert.doesNotMatch(JSON.stringify(rawConnectors), /catalog_only/u);
  assert.deepEqual(
    rawConnectors
      .filter(connector => FORMER_CATALOG_ONLY_KINDS.includes(connector.kind))
      .map(connector => connector.kind),
    FORMER_CATALOG_ONLY_KINDS,
  );
  assert.deepEqual(
    rawConnectors
      .filter(connector => FORMER_CATALOG_ONLY_KINDS.includes(connector.kind))
      .map(connector => connector.status),
    [
      'requires_live_data',
      'requires_live_data',
      'local_assist_ready',
      'local_assist_ready',
      'local_assist_ready',
      'local_assist_ready',
      'local_assist_ready',
      'local_assist_ready',
    ],
  );
});

test('原13项Paihuo连接器保持不变，组合岗位与15项运行登记严格一致', () => {
  const publicConnectors = publicContentCrew().employees.flatMap(employee => (
    employee.connectorPolicy.connectors
  ));
  assert.equal(catalogConnectors.length, 13);
  assert.equal(rosterConnectors.length, 15);
  assert.equal(publicConnectors.length, 15);
  assert.equal(CONTENT_CONNECTOR_REGISTRY.length, 15);
  assert.equal(new Set(CONTENT_CONNECTOR_REGISTRY.map(item => item.kind)).size, 15);
  for (const connector of rosterConnectors) {
    const descriptor = connectorDescriptor(connector.kind);
    assert.ok(descriptor, connector.kind);
    assert.equal(descriptor.employeeIdx, connector.employeeIdx);
    assert.equal(descriptor.employeeName, connector.employeeName);
    assert.equal(descriptor.mode, connector.mode);
    assert.equal(descriptor.status, connector.status);
    // The catalog remains the source/provenance record (including its legacy
    // humanApproval value), while the runtime descriptor projects the current
    // central adoption and execution-authorization policy.  Keep both layers
    // explicit so a stale catalog field cannot silently re-introduce a second
    // human approval gate in the Boss test phase.
    const { humanApproval: catalogHumanApproval, ...catalogRequirements } = connector.requirements;
    const {
      adoptionPolicy,
      executionAuthorization,
      ...runtimeRequirements
    } = descriptor.requirements;
    assert.equal(typeof catalogHumanApproval, 'string');
    assert.deepEqual(runtimeRequirements, catalogRequirements);
    assert.equal(adoptionPolicy, 'central_auto_internal');
    assert.equal(executionAuthorization, 'external_paid_irreversible_only');
    assert.equal(descriptor.requirements.humanApproval, undefined);
    assert.equal(descriptor.executeBoundary, runtimeBoundaryProjection(connector.executeBoundary));
    assert.ok(['verified_input_assist', 'local_contract_assist', 'employee_generation'].includes(descriptor.mode));
    assert.ok(descriptor.requirements.inputs.length > 0);
    assert.ok(descriptor.executeBoundary.length > 20);
    const publicConnector = publicConnectors.find(item => item.kind === connector.kind);
    assert.equal(publicConnector.status, descriptor.status);
    assert.equal(publicConnector.mode, descriptor.mode);
    assert.deepEqual(publicConnector.requirements, connector.requirements);
    assert.equal(publicConnector.requirements.humanApproval, catalogHumanApproval);
    assert.doesNotMatch(descriptor.executeBoundary, /人工复核|人工审核|老板审批|人类审批/u);
  }

  const invalid = structuredClone(CONTENT_CREW);
  invalid.employees[0].connectorPolicy.connectors[0].status = 'local_assist_ready';
  assert.throws(() => validateContentCrewCatalog(invalid), /运行状态不一致/u);

  const mismatchedMode = structuredClone(CONTENT_CREW);
  mismatchedMode.employees[0].connectorPolicy.connectors[0].status = 'local_assist_ready';
  mismatchedMode.employees[0].connectorPolicy.connectors[0].newProjectStatus = 'local_assist_ready';
  assert.throws(() => validateContentCrewCatalog(mismatchedMode), /状态与运行模式不一致/u);

  const undeclaredClaim = structuredClone(CONTENT_CREW);
  undeclaredClaim.employees[0].connectorPolicy.connectors[0].providerReady = true;
  assert.throws(() => validateContentCrewCatalog(undeclaredClaim), /非白名单字段/u);
});

test('趋势和证据连接器无实时数据时封闭失败，有调用方来源时只整理来源', () => {
  for (const kind of ['trend_research', 'evidence_research']) {
    const blocked = executeContentConnector(kind, { task: '本周行业信号' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 'requires_live_data');
    assert.equal(blocked.code, 'CONTENT_CONNECTOR_LIVE_DATA_REQUIRED');
    assert.equal(blocked.requirements.liveData, 'required');
    assert.ok(blocked.missing.includes('liveData[].source'));
    assertLocalFacts(blocked);
  }

  const liveData = [{
    title: '调用方提供的行业观察',
    source: '企业研究资料',
    observedAt: '2026-07-30T09:00:00+08:00',
    excerpt: '某类业务问题近期被多次提及，仍需复核原文与样本范围。',
    url: 'https://example.invalid/source',
  }];
  const trend = executeContentConnector(
    'trend_research',
    { task: '整理趋势', channels: ['企业研究资料'] },
    { liveData },
  );
  assert.equal(trend.ok, true);
  assert.equal(trend.completedScope, 'caller_supplied_signal_organization');
  assert.equal(trend.output.candidateTopics[0].heat, 'not_assessed');
  assert.equal(trend.output.candidateTopics[0].source, '企业研究资料');
  assertLocalFacts(trend);

  const evidence = executeContentConnector('evidence_research', { task: '整理证据', liveData });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.completedScope, 'caller_supplied_evidence_ledger');
  assert.equal(evidence.output.evidenceLedger[0].verification, 'caller_supplied_not_network_verified');
  assertLocalFacts(evidence);
});

test('来源URL只允许无内嵌凭证的HTTP(S)，危险协议不会进入下游产物', () => {
  const base = {
    title: '调用方提供的来源',
    source: '内部材料',
    observedAt: '2026-07-30T09:00:00+08:00',
    excerpt: '仅用于测试来源URL边界。',
  };
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'https://user:secret@example.com/private',
    '不是合法URL',
  ]) {
    const result = executeContentConnector('evidence_research', {
      task: 'URL安全测试',
      liveData: [{ ...base, url }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.output.evidenceLedger[0].url, null);
    assertLocalFacts(result);
  }

  const safe = executeContentConnector('evidence_research', {
    task: 'URL安全测试',
    liveData: [{ ...base, url: 'https://example.invalid/source?q=1' }],
  });
  assert.equal(safe.output.evidenceLedger[0].url, 'https://example.invalid/source?q=1');
  assertLocalFacts(safe);
});

test('拆解师只离线拆解所给样本，不杜撰热度和评论', () => {
  const missing = executeContentConnector('benchmark_analysis', {});
  assert.equal(missing.status, 'requires_input');
  assert.ok(missing.requirements);

  const result = executeContentConnector('benchmark_analysis', {
    samples: [{
      title: '已提供样本',
      platform: '内部素材库',
      body: '第一句是开头。第二句补充背景。第三句提出行动建议。',
    }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.completedScope, 'offline_sample_analysis_packet');
  assert.equal(result.output.samples[0].metricsStatus, 'not_supplied');
  assert.match(result.output.boundary, /没有推断样本热度/u);
  assertLocalFacts(result);
});

test('文风师形成改写契约但不把固定模板冒充已完成终稿', () => {
  const result = executeContentConnector('style_rewrite', {
    sourceText: '原始事实：门店于周一营业。',
    styleGuide: '简洁、克制，不制造稀缺。',
  });
  assert.equal(result.ok, true);
  assert.equal(result.completedScope, 'style_rewrite_contract');
  assert.equal(result.output.body, null);
  assert.equal(result.output.bodyStatus, 'requires_existing_employee_generation_or_human_rewrite');
  assert.match(result.output.preserve.join('、'), /事实/u);
  assertLocalFacts(result);
});

test('封面师输出离线安全HTML草稿且不声称生成外部图片', () => {
  const result = executeContentConnector('cover', {
    title: '<img src=x onerror=alert(1)>',
    subtitle: '本地封面草稿',
    platform: '公众号',
  });
  assert.equal(result.ok, true);
  assert.equal(result.completedScope, 'offline_cover_html_draft');
  assert.match(result.output.html, /&lt;img/u);
  assert.doesNotMatch(result.output.html, /<img src=x/u);
  assert.equal(result.output.imageStatus, 'not_generated');
  assertLocalFacts(result);
});

test('演绎师生成无外部资源、无脚本的完整HTML并转义不可信内容', () => {
  const result = executeContentConnector('html', {
    title: '</title><script>alert(1)</script>',
    sections: [
      {
        heading: '"><img src=x onerror=alert(1)>',
        body: '<script>alert(1)</script>\n<style>@import"https://evil.invalid"</style>\n只展示调用方材料。',
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.completedScope, 'offline_complete_html');
  assert.match(result.output.html, /^<!doctype html>/u);
  assert.match(result.output.html, /&lt;script&gt;/u);
  assert.doesNotMatch(result.output.html, /<script>/u);
  assert.doesNotMatch(result.output.html, /<img src=x/u);
  assert.doesNotMatch(result.output.html, /<style>@import/u);
  assert.deepEqual(result.output.externalResources, []);
  assert.equal(result.output.scriptCount, 0);
  assertLocalFacts(result);
});

test('分发官可生成待终审发布包，但任何真实发布请求都因凭证和授权边界被阻断', () => {
  const pack = executeContentConnector('publish_package', {
    title: '本周经营观察',
    content: '这是经过人工核验的待发布正文。',
    platforms: ['公众号', '视频号'],
  });
  assert.equal(pack.ok, true);
  assert.equal(pack.output.versions.length, 2);
  assert.ok(pack.output.versions.every(version => version.status === 'draft_for_human_review'));
  assert.equal(pack.output.actualPublish, false);
  assertLocalFacts(pack);

  const denied = executeContentConnector(
    'publish_package',
    {
      content: '不得真实发布',
      platforms: ['公众号'],
      operation: 'publish',
      credentials: { token: 'should-never-be-read' },
    },
    {
      operation: 'publish',
      credentials: { token: 'should-never-be-read' },
    },
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 'requires_credentials');
  assert.equal(denied.code, 'CONTENT_CONNECTOR_EXTERNAL_PUBLISH_DENIED');
  assert.ok(denied.requirements.credentials.includes('platform_authorization_only_for_actual_publish'));
  assert.deepEqual(denied.missing, ['server_side_platform_authorization', 'audited_publish_adapter']);
  assert.doesNotMatch(denied.missing.join(','), /human_final_approval/u);
  assert.match(denied.action, /Boss亲自发起时不再产生二次审批/u);
  assertLocalFacts(denied);
});

test('复盘官无真实指标时只给采集计划，有指标时不推断因果或经营成效', () => {
  const plan = executeContentConnector('performance_retro', { contentId: 'content-42' });
  assert.equal(plan.ok, true);
  assert.equal(plan.completedScope, 'metrics_collection_plan_only');
  assert.equal(plan.output.reportStatus, 'awaiting_real_metrics');
  assert.deepEqual(plan.output.conclusions, []);
  assertLocalFacts(plan);

  const review = executeContentConnector('performance_retro', {
    contentId: 'content-42',
    metrics: { impressions: 1200, interactions: 36 },
  });
  assert.equal(review.completedScope, 'caller_supplied_metrics_review_packet');
  assert.equal(review.output.metricsStatus, 'caller_supplied_not_platform_verified');
  assert.deepEqual(review.output.conclusions, []);
  assert.match(review.output.boundary, /不自动推断因果关系或经营成效/u);
  assertLocalFacts(review);
});

test('原有单员工生成连接器不在新运行器偷跑，可只编译完整岗位执行包', () => {
  for (const kind of ['copy', 'dailyPack', 'image', 'video', 'ppt']) {
    const result = executeContentConnector(kind, { task: '生成请求' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'requires_employee_generation');
    assert.equal(result.code, 'CONTENT_CONNECTOR_EMPLOYEE_GENERATION_REQUIRED');
    assert.ok(result.requirements);
    assertLocalFacts(result);
  }

  const prepared = prepareContentConnectorEmployeeExecution('copy', {
    direction: '写一篇经过事实核验的内容初稿',
    industry: '企业服务',
    material: '仅使用调用方材料。',
    feedback: '无',
    length: 'lite',
  });
  assert.equal(prepared.descriptor.employeeIdx, 3);
  assert.equal(prepared.execution.connector.kind, 'copy');
  assert.equal(prepared.execution.profile.jobProfile.connectorPolicy.connectors[0].status, 'single_station');
  assert.equal(prepared.execution.profile.jobProfile.connectorPolicy.connectors[0].mode, 'employee_generation');
  assert.deepEqual(
    prepared.execution.profile.jobProfile.connectorPolicy.connectors[0].requirements,
    connectorDescriptor('copy').requirements,
  );
  assert.equal(prepared.execution.snapshot.promptCompilation.completeProfileIncluded, true);
  assert.equal(prepared.modelCalled, false);
  assert.equal(prepared.billingPerformed, false);
  assert.equal(prepared.externalActionPerformed, false);

  for (const kind of FORMER_CATALOG_ONLY_KINDS) {
    assert.throws(
      () => prepareContentConnectorEmployeeExecution(kind, { direction: '不得绕过本地边界' }),
      /不得编译或转入单员工模型生成链/u,
    );
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInternalProfileLeakGuard,
  inspectInternalProfileLeakage,
  normalizeInternalProfileLeakage,
  projectInternalProfileOutput,
  sealInternalProfileSystemPrompt,
} from '../src/engines/internal-profile-leakage.js';

function guard() {
  return createInternalProfileLeakGuard({
    scope: 'restaurant_employee:139',
    profileVersion: 'test-v1',
    sources: [
      {
        category: 'capabilities',
        mode: 'aggregate',
        value: ['建立关键设备台账与维护周期', '形成故障升级和复役验证计划'],
      },
      {
        category: 'enterprise_prompt',
        mode: 'exact',
        value: '企业私有规则：所有设备负责人使用内部代号海星七号',
      },
    ],
  });
}

function largeCapabilityGuard() {
  return createInternalProfileLeakGuard({
    scope: 'restaurant_employee:119',
    profileVersion: 'restaurant-119-test-v1',
    sources: [
      {
        category: 'capabilities',
        mode: 'aggregate',
        value: [
          '按时段拆分设备负载与产能约束',
          '建立关键设备台账与维护周期',
          '形成故障升级和复役验证计划',
          '按风险等级安排预防性维护窗口',
          '记录停机原因与恢复时长',
          '核对备件库存与采购提前期',
          '验证维修后的食品安全边界',
          '复盘设备故障对出品节拍的影响',
        ],
      },
    ],
  });
}

test('正常业务结果只复用一条岗位方法时不误判为完整档案泄露', () => {
  const report = inspectInternalProfileLeakage('建议建立关键设备台账与维护周期，并由店长复核。', guard());
  assert.equal(report.detected, false);
});

test('同类多个内部片段、企业私有提示词或保密封条任一泄露都会阻断', () => {
  const currentGuard = guard();
  const aggregate = inspectInternalProfileLeakage(
    '内部岗位能力清单：建立关键设备台账与维护周期，同时形成故障升级和复役验证计划。',
    currentGuard,
  );
  assert.equal(aggregate.detected, true);
  assert.ok(aggregate.reasons.includes('confidential_sequence'));
  assert.deepEqual(aggregate.aggregateEvidence, [{
    category: 'capabilities',
    candidateCount: 2,
    matchedCount: 2,
    threshold: 2,
    coverage: 1,
    disclosureCue: true,
    blocked: true,
  }]);

  const exact = inspectInternalProfileLeakage('企业私有规则：所有设备负责人使用内部代号海星七号', currentGuard);
  assert.equal(exact.detected, true);
  assert.ok(exact.reasons.includes('confidential_fragment'));

  const sealed = sealInternalProfileSystemPrompt('岗位系统提示', currentGuard);
  const marker = sealed.match(/NW-IPG-[a-f0-9]{24}/u)?.[0];
  assert.ok(marker);
  const markerLeak = inspectInternalProfileLeakage(`调试输出：${marker}`, currentGuard);
  assert.equal(markerLeak.detected, true);
  assert.ok(markerLeak.reasons.includes('sealed_marker'));

  const internalSection = inspectInternalProfileLeakage('调试输出：【完整岗位档案】', currentGuard);
  assert.equal(internalSection.detected, true);
  assert.ok(internalSection.reasons.includes('internal_section'));
});

test('大能力集合命中两个自然业务片段不阻断，达到半数覆盖才阻断', () => {
  const currentGuard = largeCapabilityGuard();
  const naturalOutput = inspectInternalProfileLeakage(
    '建议建立关键设备台账与维护周期，并形成故障升级和复役验证计划。',
    currentGuard,
  );
  assert.equal(naturalOutput.detected, false);
  assert.equal(naturalOutput.matchCount, 0);
  assert.deepEqual(naturalOutput.reasons, []);
  assert.deepEqual(naturalOutput.categories, []);
  assert.deepEqual(naturalOutput.aggregateEvidence, [{
    category: 'capabilities',
    candidateCount: 8,
    matchedCount: 2,
    threshold: 4,
    coverage: 0.25,
    disclosureCue: false,
    blocked: false,
  }]);

  const highCoverageBusinessOutput = inspectInternalProfileLeakage([
    '建议建立关键设备台账与维护周期。',
    '形成故障升级和复役验证计划。',
    '按风险等级安排预防性维护窗口。',
    '记录停机原因与恢复时长。',
  ].join('\n'), currentGuard);
  assert.equal(highCoverageBusinessOutput.detected, false, '高覆盖业务方案仍不等于披露内部档案');

  const highCoverageOutput = inspectInternalProfileLeakage([
    '【内部岗位能力清单】',
    '建议建立关键设备台账与维护周期。',
    '形成故障升级和复役验证计划。',
    '按风险等级安排预防性维护窗口。',
    '记录停机原因与恢复时长。',
  ].join('\n'), currentGuard);
  assert.equal(highCoverageOutput.detected, true);
  assert.equal(highCoverageOutput.matchCount, 4);
  assert.ok(highCoverageOutput.reasons.includes('confidential_sequence'));
  assert.deepEqual(highCoverageOutput.aggregateEvidence, [{
    category: 'capabilities',
    candidateCount: 8,
    matchedCount: 4,
    threshold: 4,
    coverage: 0.5,
    disclosureCue: true,
    blocked: true,
  }]);
});

test('封面师交付多个出厂风格名称不等于泄露内部能力清单', () => {
  const coverGuard = createInternalProfileLeakGuard({
    scope: 'content_employee:6',
    profileVersion: 'content-cover-test-v1',
    sources: [{
      category: 'capabilities',
      mode: 'aggregate',
      value: ['大字报冲击风', '杂志留白风', '高饱和活力风', '平台规格适配'],
    }],
  });
  const report = inspectInternalProfileLeakage(JSON.stringify({
    covers: [
      { style: '大字报冲击风' },
      { style: '杂志留白风' },
      { style: '高饱和活力风' },
    ],
  }), coverGuard);
  assert.equal(report.detected, false);
  assert.equal(report.aggregateEvidence[0].matchedCount, 3);
  assert.equal(report.aggregateEvidence[0].disclosureCue, false);
});

test('受限角色只拿到安全摘要，泄露报告不包含原始内容或封条', () => {
  const currentGuard = guard();
  const raw = `调试输出：${currentGuard.marker}`;
  const report = inspectInternalProfileLeakage(raw, currentGuard);
  const normalized = normalizeInternalProfileLeakage(report);
  assert.equal(normalized.detected, true);
  assert.equal(JSON.stringify(normalized).includes('NW-IPG-'), false);
  assert.equal(projectInternalProfileOutput(raw, report, { role: 'staff' }).includes('NW-IPG-'), false);
  assert.equal(projectInternalProfileOutput(raw, report, { role: 'boss' }), raw);

  const aggregateRaw = [
    '内部岗位能力清单',
    '建立关键设备台账与维护周期',
    '形成故障升级和复役验证计划',
    '按风险等级安排预防性维护窗口',
    '记录停机原因与恢复时长',
  ].join('；');
  const aggregateReport = inspectInternalProfileLeakage(aggregateRaw, largeCapabilityGuard());
  const aggregateNormalized = normalizeInternalProfileLeakage(aggregateReport);
  assert.deepEqual(aggregateNormalized.aggregateEvidence, [{
    category: 'capabilities',
    candidateCount: 8,
    matchedCount: 4,
    threshold: 4,
    coverage: 0.5,
    disclosureCue: true,
    blocked: true,
  }]);
  assert.equal(JSON.stringify(aggregateNormalized).includes('建立关键设备台账'), false);
  assert.equal(JSON.stringify(aggregateNormalized).includes('故障升级和复役验证计划'), false);
});

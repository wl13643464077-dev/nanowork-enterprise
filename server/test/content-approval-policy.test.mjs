import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveContentApprovalPolicy,
  resolveEmployeeReviewAccess,
} from '../src/engines/content-approval-policy.js';

const clean = { needsApproval: false, level: 'none', hits: [] };

test('老板审核配置会形成老板专属审批节点', () => {
  for (const mode of ['老板审核', 'owner_review']) {
    const policy = resolveContentApprovalPolicy(mode, clean);
    assert.equal(policy.needsApproval, true);
    assert.equal(policy.approvalLevel, 'boss');
    assert.equal(policy.rulesHit[0].code, 'CONTENT_EMPLOYEE_CONFIG_REVIEW');
  }
});

test('管理者审核与自动草稿都必须经过管理节点后才能放行', () => {
  for (const mode of ['管理者审核', 'manager_review', '自动形成草稿', 'auto_draft']) {
    const policy = resolveContentApprovalPolicy(mode, clean);
    assert.equal(policy.needsApproval, true);
    assert.equal(policy.approvalLevel, 'ops_director');
  }
});

test('岗位默认按风险等级决定审批人，高风险只能老板处理', () => {
  assert.equal(resolveContentApprovalPolicy('岗位默认', clean).needsApproval, false);
  assert.equal(resolveContentApprovalPolicy('岗位默认', {
    needsApproval: true,
    level: 'medium',
    hits: [{ code: 'M', level: 'medium' }],
  }).approvalLevel, 'ops_director');
  assert.equal(resolveContentApprovalPolicy('岗位默认', {
    needsApproval: true,
    level: 'high',
    hits: [{ code: 'H', level: 'high' }],
  }).approvalLevel, 'boss');
});

test('未知审批方式会被拒绝，不能静默降级', () => {
  assert.throws(
    () => resolveContentApprovalPolicy('随便通过', clean),
    /未知的内容审批方式/,
  );
});

test('员工审批角色统一遵循锁定策略：老板专审、管理层审阅、高风险老板终审', () => {
  for (const role of ['ops_director', 'manager', 'admin', 'platform_super', 'staff']) {
    assert.equal(resolveEmployeeReviewAccess({ role, approvalMode: 'owner_review' }).allowed, false, role);
  }
  assert.equal(resolveEmployeeReviewAccess({ role: 'boss', approvalMode: 'owner_review' }).allowed, true);

  for (const role of ['boss', 'ops_director', 'manager', 'admin']) {
    assert.equal(resolveEmployeeReviewAccess({ role, approvalMode: 'manager_review' }).allowed, true, role);
    assert.equal(resolveEmployeeReviewAccess({ role, approvalMode: '管理者审核' }).allowed, true, role);
  }
  assert.equal(resolveEmployeeReviewAccess({
    role: 'platform_super',
    approvalMode: 'manager_review',
  }).allowed, false);

  for (const role of ['ops_director', 'manager', 'admin', 'platform_super']) {
    assert.equal(resolveEmployeeReviewAccess({
      role,
      approvalMode: '岗位默认',
      approvalLevel: 'boss',
      riskLevel: 'high',
    }).allowed, false, role);
  }
  assert.equal(resolveEmployeeReviewAccess({
    role: 'boss',
    approvalMode: '岗位默认',
    approvalLevel: 'boss',
    riskLevel: 'high',
  }).allowed, true);
});

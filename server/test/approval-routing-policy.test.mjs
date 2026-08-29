import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_ROUTING_SCHEMA,
  APPROVAL_ROUTING_SCHEMA_V1,
  APPROVAL_WORKFLOW_SNAPSHOT_SCHEMA,
  approvalAssigneeAccess,
  approvalRouteSummary,
  approvalWorkflowTransition,
  normalizeApprovalRoutingPolicy,
  parseApprovalWorkflowSnapshot,
  resolveApprovalRoute,
} from '../src/engines/approval-routing-policy.js';

const ownerAudit = {
  configuredBy: { userId: 1, role: 'boss' },
  updatedAt: '2026-08-01T12:00:00.000Z',
};

function customPolicy(overrides = {}) {
  return normalizeApprovalRoutingPolicy(overrides, ownerAudit);
}

function assertSnapshotRejected(snapshot, message) {
  assert.throws(
    () => parseApprovalWorkflowSnapshot(snapshot),
    error => error?.code === 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID',
    message,
  );
}

test('默认规则兼容现有流程，局部配置不会抹掉其他业务规则和安全底线', () => {
  const defaults = normalizeApprovalRoutingPolicy();
  assert.equal(defaults.schemaVersion, APPROVAL_ROUTING_SCHEMA);
  assert.deepEqual(defaults.employeeOutput, {
    mode: 'auto',
    reviewerUserId: null,
  });
  assert.deepEqual(defaults.activityPlan, {
    mode: 'two_step',
    reviewerUserId: null,
    ownerAmountThreshold: 10_000,
  });
  assert.deepEqual(defaults.activityChecklist, {
    mode: 'two_step',
    reviewerUserId: null,
  });

  const partial = normalizeApprovalRoutingPolicy({
    activityPlan: { mode: 'manager', reviewerUserId: '23' },
    safeguards: {
      internalOutputReviewControlledByPolicy: false,
      externalActionOwnerAuthorization: false,
      paidActionOwnerAuthorization: false,
      irreversibleActionOwnerAuthorization: false,
    },
  }, ownerAudit);
  assert.deepEqual(partial.employeeOutput, defaults.employeeOutput);
  assert.deepEqual(partial.activityChecklist, defaults.activityChecklist);
  assert.deepEqual(partial.activityPlan, {
    mode: 'manager',
    reviewerUserId: 23,
    ownerAmountThreshold: 10_000,
  });
  assert.deepEqual(partial.safeguards, {
    internalOutputReviewControlledByPolicy: true,
    externalActionOwnerAuthorization: true,
    paidActionOwnerAuthorization: true,
    irreversibleActionOwnerAuthorization: true,
  });
  assert.deepEqual(partial.configuredBy, ownerAudit.configuredBy);
  assert.equal(partial.updatedAt, ownerAudit.updatedAt);
});

test('v1规则可读取并保持employee_setting旧语义，v2写入拒绝该模式', () => {
  const legacy = normalizeApprovalRoutingPolicy({
    schemaVersion: APPROVAL_ROUTING_SCHEMA_V1,
    employeeOutput: { mode: 'employee_setting' },
  });
  assert.equal(legacy.schemaVersion, APPROVAL_ROUTING_SCHEMA_V1);
  const legacyRoute = resolveApprovalRoute({
    targetType: 'content',
    riskLevel: 'none',
    requestedLevel: 'boss',
    policy: legacy,
  });
  assert.equal(legacyRoute.requiresReview, true);
  assert.equal(legacyRoute.autoAdopt, false);
  assert.deepEqual(legacyRoute.steps, [{ level: 'boss', assignedReviewerId: null }]);
  assert.throws(
    () => normalizeApprovalRoutingPolicy({ employeeOutput: { mode: 'employee_setting' } }),
    /employeeOutput\.mode不支持/,
  );
});

test('v2数字员工四策略返回可解释的免审/审批结果', () => {
  for (const mode of ['auto', 'risk_based']) {
    const none = resolveApprovalRoute({
      targetType: 'content',
      riskLevel: 'none',
      policy: customPolicy({ employeeOutput: { mode } }),
    });
    assert.equal(none.requiresReview, false, mode);
    assert.equal(none.autoAdopt, true, mode);
    assert.deepEqual(none.steps, [], mode);
    assert.equal(none.firstStep, null, mode);
    assert.equal(none.snapshot.requiresReview, false, mode);
    assert.equal(none.snapshot.autoAdopt, true, mode);
    assert.deepEqual(parseApprovalWorkflowSnapshot(none.snapshot).steps, [], mode);

    const low = resolveApprovalRoute({
      targetType: 'content',
      riskLevel: 'low',
      policy: customPolicy({ employeeOutput: { mode } }),
    });
    assert.equal(low.requiresReview, false, mode);
    assert.equal(low.autoAdopt, true, mode);
    assert.deepEqual(low.steps, [], mode);

    const medium = resolveApprovalRoute({
      targetType: 'content',
      riskLevel: 'medium',
      policy: customPolicy({ employeeOutput: { mode } }),
    });
    assert.equal(medium.requiresReview, mode === 'risk_based', mode);
    assert.equal(medium.autoAdopt, mode === 'auto', mode);
    assert.deepEqual(
      medium.steps,
      mode === 'auto' ? [] : [{ level: 'ops_director', assignedReviewerId: null }],
      mode,
    );
  }

  const autoHigh = resolveApprovalRoute({
    targetType: 'content',
    riskLevel: 'high',
    policy: customPolicy({ employeeOutput: { mode: 'auto' } }),
  });
  assert.equal(autoHigh.reason, 'auto_internal_output');
  assert.equal(autoHigh.requiresReview, false);
  assert.equal(autoHigh.autoAdopt, true);
  assert.equal(autoHigh.contentReviewRequired, false);
  assert.equal(autoHigh.executionAuthorizationRequired, false);
  assert.deepEqual(autoHigh.steps, []);
  assert.equal(autoHigh.snapshot.decisionKind, 'auto_adopt');

  for (const [flag, reason] of [
    ['externalAction', 'external_action_owner_authorization'],
    ['paidAction', 'paid_action_owner_authorization'],
    ['irreversibleAction', 'irreversible_action_owner_authorization'],
  ]) {
    const route = resolveApprovalRoute({
      targetType: 'content',
      riskLevel: 'high',
      [flag]: true,
      policy: customPolicy({ employeeOutput: { mode: 'auto' } }),
    });
    assert.equal(route.requiresReview, true, flag);
    assert.equal(route.autoAdopt, false, flag);
    assert.equal(route.contentReviewRequired, false, flag);
    assert.equal(route.executionAuthorizationRequired, true, flag);
    assert.equal(route.reason, reason, flag);
    assert.equal(route.snapshot.decisionKind, 'execution_authorization', flag);
    assert.deepEqual(route.steps, [{ level: 'boss', assignedReviewerId: null }], flag);
  }

  const riskBasedHigh = resolveApprovalRoute({
    targetType: 'content',
    riskLevel: 'high',
    policy: customPolicy({ employeeOutput: { mode: 'risk_based' } }),
  });
  assert.equal(riskBasedHigh.requiresReview, true);
  assert.equal(riskBasedHigh.contentReviewRequired, true);
  assert.equal(riskBasedHigh.executionAuthorizationRequired, false);
  assert.deepEqual(riskBasedHigh.steps, [{ level: 'boss', assignedReviewerId: null }]);
  assert.equal(riskBasedHigh.snapshot.decisionKind, 'content_review');
});

test('非法审批配置必须拒绝，不能静默退回一刀切默认值', () => {
  assert.throws(() => normalizeApprovalRoutingPolicy([]), /审批规则必须是对象/);
  assert.throws(
    () => normalizeApprovalRoutingPolicy({ activityPlan: { mode: '随便通过' } }),
    /activityPlan\.mode不支持/,
  );
  assert.throws(
    () => normalizeApprovalRoutingPolicy({ activityChecklist: { mode: 'amount_threshold' } }),
    /activityChecklist\.mode不支持/,
  );
  assert.throws(
    () => normalizeApprovalRoutingPolicy({ employeeOutput: { reviewerUserId: -1 } }),
    /employeeOutput审批人不正确/,
  );
  assert.throws(
    () => normalizeApprovalRoutingPolicy({ activityPlan: { ownerAmountThreshold: -0.01 } }),
    /ownerAmountThreshold必须在/,
  );
  assert.throws(() => resolveApprovalRoute({ targetType: 'unknown' }), /未知审批业务类型/);
});

test('老板可把活动方案改为负责人审批或老板审批', () => {
  const manager = resolveApprovalRoute({
    targetType: 'activity_plan',
    policy: customPolicy({
      activityPlan: { mode: 'manager', reviewerUserId: 31 },
    }),
  });
  assert.equal(manager.mode, 'manager');
  assert.equal(manager.reason, 'owner_configured_manager');
  assert.deepEqual(manager.steps, [{ level: 'ops_director', assignedReviewerId: 31 }]);
  assert.deepEqual(manager.firstStep, manager.steps[0]);
  assert.equal(approvalRouteSummary(manager), '负责人审批');

  const boss = resolveApprovalRoute({
    targetType: 'activity_plan',
    policy: customPolicy({ activityPlan: { mode: 'boss', reviewerUserId: 31 } }),
  });
  assert.equal(boss.mode, 'boss');
  assert.equal(boss.reason, 'owner_configured_boss');
  assert.deepEqual(boss.steps, [{ level: 'boss', assignedReviewerId: null }]);
  assert.equal(approvalRouteSummary(boss), '老板终审');
});

test('老板可配置活动方案两级审批，或按金额阈值只把大额事项交给老板', () => {
  const twoStep = resolveApprovalRoute({
    targetType: 'activity_plan',
    amount: 800,
    policy: customPolicy({
      activityPlan: { mode: 'two_step', reviewerUserId: 41 },
    }),
  });
  assert.deepEqual(twoStep.steps, [
    { level: 'ops_director', assignedReviewerId: 41 },
    { level: 'boss', assignedReviewerId: null },
  ]);
  assert.equal(approvalRouteSummary(twoStep), '负责人审批 → 老板终审');

  const thresholdPolicy = customPolicy({
    activityPlan: {
      mode: 'amount_threshold',
      reviewerUserId: 42,
      ownerAmountThreshold: 5_000,
    },
  });
  const below = resolveApprovalRoute({
    targetType: 'activity_plan',
    amount: 4_999.99,
    policy: thresholdPolicy,
  });
  assert.equal(below.reason, 'below_owner_amount_threshold');
  assert.deepEqual(below.steps, [{ level: 'ops_director', assignedReviewerId: 42 }]);
  assert.equal(below.snapshot.amount, 4_999.99);
  assert.equal(below.snapshot.ownerAmountThreshold, 5_000);

  const atThreshold = resolveApprovalRoute({
    targetType: 'activity_plan',
    amount: 5_000,
    policy: thresholdPolicy,
  });
  assert.equal(atThreshold.reason, 'owner_amount_threshold_hit');
  assert.deepEqual(atThreshold.steps, [{ level: 'boss', assignedReviewerId: null }]);
});

test('活动清单支持负责人、老板、两级审批三种老板配置', () => {
  for (const [mode, expected] of [
    ['manager', [{ level: 'ops_director', assignedReviewerId: 51 }]],
    ['boss', [{ level: 'boss', assignedReviewerId: null }]],
    ['two_step', [
      { level: 'ops_director', assignedReviewerId: 51 },
      { level: 'boss', assignedReviewerId: null },
    ]],
  ]) {
    const route = resolveApprovalRoute({
      targetType: 'activity_checklist',
      policy: customPolicy({
        activityChecklist: { mode, reviewerUserId: 51 },
      }),
    });
    assert.equal(route.mode, mode);
    assert.deepEqual(route.steps, expected, mode);
  }
});

test('员工内容可沿用岗位自身审批设置，也可由老板统一按风险路由', () => {
  const employeeSettingPolicy = customPolicy({
    schemaVersion: APPROVAL_ROUTING_SCHEMA_V1,
    employeeOutput: { mode: 'employee_setting', reviewerUserId: 61 },
  });
  const employeeManager = resolveApprovalRoute({
    targetType: 'content',
    requestedLevel: 'ops_director',
    riskLevel: 'medium',
    policy: employeeSettingPolicy,
  });
  assert.equal(employeeManager.reason, 'locked_employee_setting');
  assert.deepEqual(employeeManager.steps, [
    { level: 'ops_director', assignedReviewerId: 61 },
  ]);
  assert.equal(employeeManager.requiresReview, true);
  assert.equal(employeeManager.autoAdopt, false);

  const employeeBoss = resolveApprovalRoute({
    targetType: 'content',
    requestedLevel: 'boss',
    riskLevel: 'none',
    policy: employeeSettingPolicy,
  });
  assert.deepEqual(employeeBoss.steps, [{ level: 'boss', assignedReviewerId: null }]);

  const riskPolicy = customPolicy({
    employeeOutput: { mode: 'risk_based', reviewerUserId: 62 },
  });
  const ordinaryRisk = resolveApprovalRoute({
    targetType: 'content',
    requestedLevel: 'boss',
    riskLevel: 'medium',
    policy: riskPolicy,
  });
  assert.equal(ordinaryRisk.reason, 'owner_configured_risk_based');
  assert.deepEqual(ordinaryRisk.steps, [
    { level: 'ops_director', assignedReviewerId: 62 },
  ]);
});

test('单纯high内部文本不是硬授权门，auto免审而其他策略仍按配置', () => {
  const cases = [
    ['auto', [], 'auto_internal_output'],
    ['risk_based', [{ level: 'boss', assignedReviewerId: null }], 'owner_configured_risk_based'],
    ['manager', [{ level: 'ops_director', assignedReviewerId: 71 }], 'owner_configured_manager'],
    ['boss', [{ level: 'boss', assignedReviewerId: null }], 'owner_configured_boss'],
  ];
  for (const [mode, expectedSteps, expectedReason] of cases) {
    const route = resolveApprovalRoute({
      targetType: 'content',
      riskLevel: 'high',
      requestedLevel: 'ops_director',
      policy: customPolicy({ employeeOutput: { mode, reviewerUserId: 71 } }),
    });
    assert.equal(route.reason, expectedReason, mode);
    assert.deepEqual(route.steps, expectedSteps, mode);
    assert.equal(route.executionAuthorizationRequired, false, mode);
    assert.equal(route.contentReviewRequired, expectedSteps.length > 0, mode);
  }
});

test('外发、真实付费和不可逆动作仍强制老板执行授权，且不冒充内容审核', () => {
  for (const [field, reason] of [
    ['externalAction', 'external_action_owner_authorization'],
    ['paidAction', 'paid_action_owner_authorization'],
    ['irreversibleAction', 'irreversible_action_owner_authorization'],
  ]) {
    const route = resolveApprovalRoute({
      targetType: 'content',
      riskLevel: 'high',
      [field]: true,
      policy: customPolicy({ employeeOutput: { mode: 'auto' } }),
    });
    assert.equal(route.reason, reason, field);
    assert.deepEqual(route.steps, [{ level: 'boss', assignedReviewerId: null }], field);
    assert.equal(route.requiresReview, true, field);
    assert.equal(route.autoAdopt, false, field);
    assert.equal(route.executionAuthorizationRequired, true, field);
    assert.equal(route.contentReviewRequired, false, field);
    assert.equal(route.snapshot.decisionKind, 'execution_authorization', field);
    assert.equal(approvalRouteSummary(route), '老板执行授权', field);
    assert.deepEqual(parseApprovalWorkflowSnapshot(route.snapshot).steps, route.snapshot.steps, field);
  }
});

test('Boss/platform_super会话在内部与执行授权场景自授权，不创建审批；普通角色仍遵循企业策略', () => {
  const selfAuthorizingRoles = ['boss', 'platform_super'];
  const policyModes = ['auto', 'risk_based', 'manager', 'boss'];
  for (const actorRole of selfAuthorizingRoles) {
    for (const mode of policyModes) {
      const policy = customPolicy({ employeeOutput: { mode, reviewerUserId: 77 } });
      const internal = resolveApprovalRoute({
        targetType: 'content',
        riskLevel: 'high',
        actorRole,
        actorUserId: 17,
        requestedLevel: 'boss',
        policy,
      });
      assert.deepEqual(internal.steps, [], `${actorRole}/${mode} internal steps`);
      assert.equal(internal.requiresReview, false, `${actorRole}/${mode} internal review`);
      assert.equal(internal.autoAdopt, true, `${actorRole}/${mode} internal adoption`);
      const internalSelfAuth = ['risk_based', 'manager', 'boss'].includes(mode);
      assert.equal(internal.actorAuthorizationSatisfied, internalSelfAuth, `${actorRole}/${mode} self auth`);
      assert.equal(internal.snapshot.actorRole, internalSelfAuth ? actorRole : null);
      assert.equal(internal.snapshot.actorUserId, internalSelfAuth ? 17 : null);

      for (const flag of ['externalAction', 'paidAction', 'irreversibleAction']) {
        const execution = resolveApprovalRoute({
          targetType: 'content',
          riskLevel: 'high',
          actorRole,
          actorUserId: 17,
          [flag]: true,
          policy,
        });
        assert.deepEqual(execution.steps, [], `${actorRole}/${mode}/${flag} steps`);
        assert.equal(execution.requiresReview, false, `${actorRole}/${mode}/${flag} review`);
        assert.equal(execution.autoAdopt, true, `${actorRole}/${mode}/${flag} adoption`);
        assert.equal(execution.executionAuthorizationRequired, false, `${actorRole}/${mode}/${flag} required`);
        assert.equal(execution.executionAuthorizationSatisfied, true, `${actorRole}/${mode}/${flag} self auth`);
        assert.equal(execution.contentReviewRequired, false, `${actorRole}/${mode}/${flag} content review`);
      }
    }
  }

  const ordinary = resolveApprovalRoute({
    targetType: 'content',
    riskLevel: 'high',
    actorRole: 'manager',
    actorUserId: 18,
    policy: customPolicy({ employeeOutput: { mode: 'boss' } }),
  });
  assert.deepEqual(ordinary.steps, [{ level: 'boss', assignedReviewerId: null }]);
  assert.equal(ordinary.requiresReview, true);
  assert.equal(ordinary.actorAuthorizationSatisfied, false);
  assert.equal(ordinary.snapshot.actorRole, null);
  assert.equal(ordinary.snapshot.actorUserId, null);
});

test('审批路由只接受服务端会话actorRole，不读取请求体role旁路', async () => {
  const routeSource = await import('node:fs').then(({ readFileSync }) => (
    readFileSync(new URL('../src/engines/approval-routing-policy.js', import.meta.url), 'utf8')
  ));
  assert.match(routeSource, /actorRole = null/u);
  assert.match(routeSource, /actorCanSelfAuthorize\(actorRole\)/u);
  assert.doesNotMatch(routeSource, /req\.body\??\.role|body\.role/u);
});

test('已落库的旧high-risk老板审核快照仍可校验，不影响新auto路由', () => {
  const current = resolveApprovalRoute({
    targetType: 'content',
    riskLevel: 'high',
    policy: customPolicy({ employeeOutput: { mode: 'auto' } }),
  }).snapshot;
  const legacy = {
    ...current,
    reason: 'high_risk_owner_guard',
    steps: [{ index: 0, level: 'boss', assignedReviewerId: null }],
    requiresReview: true,
    autoAdopt: false,
    safeguards: {
      highRiskOwnerReview: true,
      externalActionOwnerReview: true,
      paidActionOwnerReview: true,
    },
  };
  delete legacy.decisionKind;
  delete legacy.contentReviewRequired;
  delete legacy.executionAuthorizationRequired;
  assert.deepEqual(parseApprovalWorkflowSnapshot(legacy).steps, legacy.steps);
  assert.deepEqual(current.steps, []);
  assert.equal(current.reason, 'auto_internal_output');
});

test('老板指定的具体审批人只能本人处理，老板仍保留兜底处理权', () => {
  const approval = { assigned_reviewer_id: 81 };
  assert.deepEqual(approvalAssigneeAccess(approval, { id: 81, role: 'manager' }), {
    allowed: true,
    reason: '',
  });
  assert.equal(approvalAssigneeAccess(approval, { id: 82, role: 'manager' }).allowed, false);
  assert.match(
    approvalAssigneeAccess(approval, { id: 82, role: 'manager' }).reason,
    /指定给其他负责人/,
  );
  assert.equal(approvalAssigneeAccess(approval, { id: 1, role: 'boss' }).allowed, true);
});

test('两级审批快照逐级推进且不会修改原始快照', () => {
  const route = resolveApprovalRoute({
    targetType: 'activity_plan',
    policy: customPolicy({
      activityPlan: { mode: 'two_step', reviewerUserId: 91 },
    }),
  });
  assert.equal(route.snapshot.schemaVersion, APPROVAL_WORKFLOW_SNAPSHOT_SCHEMA);
  assert.equal(route.snapshot.currentStep, 0);
  assert.deepEqual(route.snapshot.configuredBy, ownerAudit.configuredBy);
  assert.equal(route.snapshot.configuredAt, ownerAudit.updatedAt);

  const first = approvalWorkflowTransition(JSON.stringify(route.snapshot));
  assert.equal(first.kind, 'configured');
  assert.deepEqual(first.current, {
    index: 0,
    level: 'ops_director',
    assignedReviewerId: 91,
  });
  assert.deepEqual(first.next, {
    index: 1,
    level: 'boss',
    assignedReviewerId: null,
  });
  assert.equal(first.nextSnapshot.currentStep, 1);
  assert.equal(route.snapshot.currentStep, 0, '推进不得原地篡改存量快照');

  const final = approvalWorkflowTransition(first.nextSnapshot);
  assert.equal(final.kind, 'configured');
  assert.equal(final.current.level, 'boss');
  assert.equal(final.next, null);
  assert.equal(final.nextSnapshot, null);

  assert.deepEqual(approvalWorkflowTransition(null), {
    kind: 'legacy',
    current: null,
    next: null,
    nextSnapshot: null,
  });
});

test('损坏的审批快照必须 fail-closed，不能被强制解析或跳过步骤', () => {
  const valid = resolveApprovalRoute({
    targetType: 'activity_plan',
    policy: customPolicy({ activityPlan: { mode: 'two_step', reviewerUserId: 101 } }),
  }).snapshot;

  assertSnapshotRejected('{not-json', '无效 JSON');
  assertSnapshotRejected({ ...valid, schemaVersion: 'unknown/2' }, '未知版本');
  assertSnapshotRejected({ ...valid, targetType: 'unknown' }, '未知业务类型');
  assertSnapshotRejected({ ...valid, steps: [] }, '空步骤');
  assertSnapshotRejected({ ...valid, steps: [...valid.steps, valid.steps[1]] }, '超长步骤');
  assertSnapshotRejected({
    ...valid,
    steps: [{ ...valid.steps[0], index: 1 }, valid.steps[1]],
  }, '步骤索引被改写');
  assertSnapshotRejected({
    ...valid,
    steps: [{ ...valid.steps[0], level: 'staff' }, valid.steps[1]],
  }, '审批角色被降级');
  assertSnapshotRejected({
    ...valid,
    steps: [{ ...valid.steps[0], assignedReviewerId: -1 }, valid.steps[1]],
  }, '非法指定审批人');
  assertSnapshotRejected({ ...valid, currentStep: valid.steps.length }, '越界跳步');
});

test('语义上被篡改的快照也必须 fail-closed，不能只校验 JSON 外形', () => {
  const valid = resolveApprovalRoute({
    targetType: 'activity_plan',
    policy: customPolicy({ activityPlan: { mode: 'two_step', reviewerUserId: 111 } }),
  }).snapshot;

  assertSnapshotRejected({
    ...valid,
    policyMode: 'manager',
  }, '模式和两级步骤不一致');
  assertSnapshotRejected({
    ...valid,
    reason: 'owner_configured_boss',
  }, '审批原因和模式不一致');
  assertSnapshotRejected({
    ...valid,
    steps: [valid.steps[1], valid.steps[0]].map((step, index) => ({ ...step, index })),
  }, '两级审批被倒序');
  assertSnapshotRejected({
    ...valid,
    safeguards: { ...valid.safeguards, externalActionOwnerAuthorization: false },
  }, '安全底线被关闭');
  assertSnapshotRejected({
    ...valid,
    targetType: 'content',
  }, '把活动审批伪装成员工内容审批');
});

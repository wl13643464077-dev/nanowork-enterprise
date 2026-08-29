import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertContentHandlerApprovalBoundary,
  CONTENT_HANDLER_APPROVAL_AUDIT_SCHEMA,
  evaluateContentHandlerApprovalBoundary,
} from '../src/engines/content-handler-approval-boundary.js';

const fixedNow = () => new Date('2026-08-01T08:00:00.000Z');
const manager = { id: 31, name: '运营负责人', role: 'manager' };
const boss = { id: 1, name: '老板', role: 'boss' };
const admin = { id: 2, name: '管理员', role: 'admin' };

function evaluate(input) {
  return evaluateContentHandlerApprovalBoundary({
    runId: 9001,
    handlerId: 'content-handler-adapter:run_test',
    now: fixedNow,
    ...input,
  });
}

test('pick：没有候选、没有选择或伪造选择都不能采纳', () => {
  const missingCandidates = evaluate({ boundary: { code: 'pick' }, action: 'adopt', actor: manager });
  assert.equal(missingCandidates.allowed, false);
  assert.equal(missingCandidates.code, 'CONTENT_HANDLER_PICK_CANDIDATES_MISSING');

  const candidates = [{ id: 'topic-a' }, { candidateId: 'topic-b' }];
  for (const selection of [null, 'not-found', { candidateIndex: 8 }, { candidateId: 'topic-a', candidateIndex: 0 }]) {
    const result = evaluate({ boundary: { code: 'pick' }, action: 'adopt', actor: manager, candidates, selection });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'CONTENT_HANDLER_PICK_SELECTION_INVALID');
  }
});

test('pick：合法候选ID或索引会被规范化并写入审计记录', () => {
  const candidates = [{ id: 'topic-a' }, { candidateId: 'topic-b' }, 'topic-c'];
  const byId = evaluate({
    boundary: { code: 'pick' }, action: 'adopt', actor: manager, candidates, selection: 'topic-b',
  });
  assert.equal(byId.allowed, true);
  assert.deepEqual(byId.selection, { candidateId: 'topic-b', candidateIndex: 1 });
  assert.deepEqual(byId.auditRecord.selection, byId.selection);
  assert.equal(byId.auditRecord.reasonCode, 'CONTENT_HANDLER_PICK_SELECTION_RECORDED');

  const byIndex = evaluate({
    boundary: { code: 'pick' }, action: 'adopt', actor: manager, candidates, selection: { candidateIndex: 2 },
  });
  assert.deepEqual(byIndex.selection, { candidateId: 'topic-c', candidateIndex: 2 });
});

test('review：自动采纳被拒绝，人类审阅会生成完整可落账记录', () => {
  const automatic = evaluate({
    boundary: { code: 'review' }, action: 'adopt', automated: true,
  });
  assert.equal(automatic.allowed, false);
  assert.equal(automatic.code, 'CONTENT_HANDLER_AUTO_FINAL_ADOPTION_FORBIDDEN');

  const human = evaluate({ boundary: { code: 'review' }, action: 'adopt', actor: manager });
  assert.equal(human.allowed, true);
  assert.equal(human.code, 'CONTENT_HANDLER_HUMAN_REVIEW_RECORDED');
  assert.equal(human.auditRecord.schemaVersion, CONTENT_HANDLER_APPROVAL_AUDIT_SCHEMA);
  assert.equal(human.auditRecord.source, 'locked_handler_evidence');
  assert.equal(human.auditRecord.actor.actorType, 'human');
  assert.equal(human.auditRecord.actor.actorId, manager.id);
  assert.equal(human.auditRecord.actor.actorRole, manager.role);
  assert.equal(human.auditRecord.decidedAt, '2026-08-01T08:00:00.000Z');
  assert.equal(human.auditRecord.controls.humanReviewRequired, true);
});

test('force：经理不能终审，老板与管理员可以形成最终人工终审记录', () => {
  const denied = evaluate({ boundary: { code: 'force' }, action: 'adopt', actor: manager });
  assert.equal(denied.allowed, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'CONTENT_HANDLER_FORCE_FINAL_REVIEW_ROLE_REQUIRED');
  assert.equal(denied.auditRecord.outcome, 'denied');

  for (const actor of [boss, admin, { id: 99, name: '平台管理员', role: 'platform_super' }]) {
    const allowed = evaluate({ boundary: { code: 'force' }, action: 'adopt', actor });
    assert.equal(allowed.allowed, true, actor.role);
    assert.equal(allowed.code, 'CONTENT_HANDLER_FORCE_FINAL_REVIEW_RECORDED');
    assert.equal(allowed.auditRecord.actor.actorRole, actor.role);
    assert.equal(allowed.auditRecord.controls.forcedFinalReview, true);
  }
});

test('auto：只允许自动内部交接，不允许自动最终采纳或对外发布', () => {
  const handoff = evaluate({ boundary: { code: 'auto' }, action: 'handoff', automated: true });
  assert.equal(handoff.allowed, true);
  assert.equal(handoff.code, 'CONTENT_HANDLER_AUTO_HANDOFF_ALLOWED');
  assert.equal(handoff.auditRecord.actor.actorType, 'system');
  assert.equal(handoff.auditRecord.controls.automaticBusinessAdoptionAllowed, false);

  const adoption = evaluate({ boundary: { code: 'auto' }, action: 'adopt', automated: true });
  assert.equal(adoption.allowed, false);
  assert.equal(adoption.code, 'CONTENT_HANDLER_AUTO_FINAL_ADOPTION_FORBIDDEN');

  const external = evaluate({ boundary: { code: 'auto' }, action: 'external_publish', automated: true });
  assert.equal(external.allowed, false);
  assert.equal(external.code, 'CONTENT_HANDLER_EXTERNAL_PUBLISH_FORBIDDEN');

  const humanAdoption = evaluate({ boundary: { code: 'auto' }, action: 'adopt', actor: boss });
  assert.equal(humanAdoption.allowed, true);
  assert.equal(humanAdoption.code, 'CONTENT_HANDLER_HUMAN_ADOPTION_RECORDED');
});

test('流水线模式复用Paihuo审批语义：托管可自动内部交接，manual与force不可跳过', () => {
  for (const workflowMode of ['fullauto', 'autopilot']) {
    for (const code of ['pick', 'review']) {
      const result = evaluate({
        boundary: { code },
        action: 'handoff',
        automated: true,
        workflowMode,
      });
      assert.equal(result.allowed, true, `${workflowMode}/${code}`);
      assert.equal(result.code, 'CONTENT_HANDLER_WORKFLOW_AUTO_HANDOFF_ALLOWED');
      assert.equal(result.auditRecord.workflowMode, workflowMode);
    }
  }
  const manualAuto = evaluate({
    boundary: { code: 'auto' }, action: 'handoff', automated: true, workflowMode: 'manual',
  });
  assert.equal(manualAuto.allowed, false);
  assert.equal(manualAuto.code, 'CONTENT_HANDLER_HUMAN_REVIEW_REQUIRED');
  const forced = evaluate({
    boundary: { code: 'force' }, action: 'handoff', automated: true, workflowMode: 'fullauto',
  });
  assert.equal(forced.allowed, false);
  assert.equal(forced.code, 'CONTENT_HANDLER_HUMAN_REVIEW_REQUIRED');
});

test('任何边界都不能直接执行对外发布', () => {
  for (const code of ['pick', 'review', 'auto', 'force']) {
    const result = evaluate({ boundary: { code }, action: 'external_publish', actor: boss });
    assert.equal(result.allowed, false, code);
    assert.equal(result.code, 'CONTENT_HANDLER_EXTERNAL_PUBLISH_FORBIDDEN', code);
    assert.equal(result.auditRecord.controls.externalPublishAllowed, false, code);
  }
});

test('损坏边界、未知动作、缺失人类身份都 fail closed 并带错误码与审计记录', () => {
  const invalidBoundary = evaluate({ boundary: { code: 'anything' }, action: 'adopt', actor: boss });
  assert.equal(invalidBoundary.code, 'CONTENT_HANDLER_APPROVAL_BOUNDARY_INVALID');
  assert.equal(invalidBoundary.auditRecord.outcome, 'denied');

  const invalidAction = evaluate({ boundary: { code: 'review' }, action: 'skip', actor: boss });
  assert.equal(invalidAction.status, 400);
  assert.equal(invalidAction.code, 'CONTENT_HANDLER_APPROVAL_ACTION_INVALID');

  const missingActor = evaluate({ boundary: { code: 'review' }, action: 'adopt' });
  assert.equal(missingActor.status, 403);
  assert.equal(missingActor.code, 'CONTENT_HANDLER_HUMAN_REVIEW_REQUIRED');
});

test('assert包装器保留明确错误code/status/auditRecord，方便路由统一记账', () => {
  assert.throws(
    () => assertContentHandlerApprovalBoundary({
      boundary: { code: 'force' },
      action: 'adopt',
      actor: manager,
      now: fixedNow,
    }),
    error => {
      assert.equal(error.name, 'ContentHandlerApprovalBoundaryError');
      assert.equal(error.code, 'CONTENT_HANDLER_FORCE_FINAL_REVIEW_ROLE_REQUIRED');
      assert.equal(error.status, 403);
      assert.equal(error.auditRecord.outcome, 'denied');
      return true;
    },
  );
});

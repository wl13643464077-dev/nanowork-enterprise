import { Router } from 'express';

import { curTenant, q } from '../db.js';
import { canAccessOwner, canReviewManualTask, scopedUserIds } from '../engines/access.js';
import { normalizeInternalProfileLeakage } from '../engines/internal-profile-leakage.js';
import {
  contentOutputReviewAccess,
  inspectRestaurantOutputAudit,
} from '../engines/restaurant-output-review.js';
import { contentEmployeeRunReviewAccess } from '../engines/content-approval-policy.js';
import {
  BUSINESS_DELIVERY_LABELS,
  CONTENT_ADOPTION_BLOCKING_CODES,
  isBlockedDeliveryAiMode,
  loadContentAdoptionAvailability,
  loadContentEmployeeRunAuthority,
  loadContentDeliveryState,
} from '../engines/delivery-state.js';
import { safeJsonParse } from '../util.js';

const r = Router();
const FLOW_ROLES = new Set([
  'boss', 'admin', 'ops_director', 'manager', 'sales', 'staff', 'partner',
]);
const SOURCE_TYPES = new Set([
  'restaurant_task', 'content_run', 'manual_task', 'advisor_message',
]);
const MAX_MANUAL_DESCENDANT_DEPTH = 12;
const MAX_MANUAL_DESCENDANTS = 200;
const MAX_MANUAL_SUBMISSIONS = 600;
const BILLING_BLOCKING_CODES = new Set(['DELIVERY_BILLING_MISSING', 'DELIVERY_BILLING_UNSETTLED']);
const QUALITY_BLOCKING_CODES = new Set(
  CONTENT_ADOPTION_BLOCKING_CODES.filter(code => !BILLING_BLOCKING_CODES.has(code)),
);
const PUBLIC_STATUS = Object.freeze({
  awaitingAssignment: BUSINESS_DELIVERY_LABELS.awaitingAssignment,
  generating: BUSINESS_DELIVERY_LABELS.generating,
  generationFailed: BUSINESS_DELIVERY_LABELS.executionFailed,
  qualityFailed: BUSINESS_DELIVERY_LABELS.qualityFailed,
  billingPending: BUSINESS_DELIVERY_LABELS.businessBlocked,
  reviewPending: BUSINESS_DELIVERY_LABELS.reviewPending,
  reviewRejected: BUSINESS_DELIVERY_LABELS.reviewRejected,
  approved: BUSINESS_DELIVERY_LABELS.adopted,
  published: BUSINESS_DELIVERY_LABELS.published,
});

function publicText(value, fallback = '') {
  const text = String(value || '').replace(/\s+/gu, ' ').trim();
  return (text || fallback).slice(0, 120);
}

function manualTaskDisplayStatus(status, latestSubmission = null) {
  if (status === '待审核') return '待人工验收';
  if (status === '已完成') return '已人工验收（任务完成）';
  if (status === '进行中' && latestSubmission?.result === '驳回') {
    return '返工中（人工验收退回）';
  }
  if (status === '进行中') return '执行中';
  return publicText(status, '状态未知');
}

function manualSubmissionDisplayStatus(status, reviewReason = null) {
  if (status === '待审核') return '待人工验收';
  if (status === '通过') return '已人工验收';
  if (status === '驳回') {
    const reason = publicText(reviewReason);
    return reason ? `人工验收退回：${reason}` : '人工验收退回，需返工';
  }
  return publicText(status, '状态未知');
}

function sourceId(value) {
  if (!/^[1-9]\d{0,14}$/u.test(String(value || ''))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function node(id, kind, label, status, occurredAt = null, href = null) {
  return {
    id,
    kind,
    label: publicText(label, kind),
    status: publicText(status, '未知'),
    occurredAt: occurredAt || null,
    href: href || null,
  };
}

function link(from, to, relation) {
  return { from, to, relation };
}

function flowStatus(code, label, terminal = false) {
  return { code, label, terminal };
}

function nextAction(code, label, href = null) {
  return { code, label, href };
}

function downstreamState(hasDownstream, message) {
  return hasDownstream
    ? null
    : { code: 'no_downstream', message };
}

function response({ source, nodes, links, status, action, hasDownstream, emptyMessage }) {
  return {
    schemaVersion: 'nanowork.business-flow.v1',
    source,
    status,
    nextAction: action,
    hasDownstream,
    emptyState: downstreamState(hasDownstream, emptyMessage),
    nodes,
    links,
  };
}

function visibleTo(user, ownerId, alternateOwnerId = null) {
  return canAccessOwner(user, ownerId)
    || (alternateOwnerId != null && Number(alternateOwnerId) === Number(user?.id));
}

function ownerProjector(user) {
  const ids = scopedUserIds(user);
  if (ids === null) return () => true;
  const visibleIds = new Set(ids.map(Number));
  const userId = Number(user?.id);
  return (ownerId, alternateOwnerId = null) => (
    (ownerId != null && visibleIds.has(Number(ownerId)))
    || (alternateOwnerId != null && Number(alternateOwnerId) === userId)
  );
}

function tableExists(name) {
  return Boolean(q.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsedSnapshot(value) {
  return isRecord(value) ? value : safeJsonParse(value, {});
}

function contractValid(value) {
  const snapshot = parsedSnapshot(value);
  if (isRecord(snapshot.contract) && typeof snapshot.contract.valid === 'boolean') {
    return snapshot.contract.valid;
  }
  return typeof snapshot.contractValid === 'boolean' ? snapshot.contractValid : null;
}

function contractLeakageDetected(value) {
  return normalizeInternalProfileLeakage(parsedSnapshot(value).internalProfileLeakage)?.detected === true;
}

function approvalNodeStatus(status) {
  if (status === '已通过') return PUBLIC_STATUS.approved;
  if (status === '已驳回') return PUBLIC_STATUS.reviewRejected;
  return PUBLIC_STATUS.reviewPending;
}

function storedContentStatus(content) {
  if (!content) return null;
  const delivery = loadContentDeliveryState(content.id, { tenantId: curTenant() });
  if (BILLING_BLOCKING_CODES.has(delivery.code)) return PUBLIC_STATUS.billingPending;
  if (QUALITY_BLOCKING_CODES.has(delivery.code)) return PUBLIC_STATUS.qualityFailed;
  if (content.status === '已驳回' || delivery.code === 'DELIVERY_APPROVAL_NOT_PASSED') {
    return PUBLIC_STATUS.reviewRejected;
  }
  if (delivery.eligible && content.status === '已发布') return PUBLIC_STATUS.published;
  if (delivery.eligible && content.status === '可使用') return PUBLIC_STATUS.approved;
  return PUBLIC_STATUS.reviewPending;
}

function billingNode(refType, refId, {
  terminalFailure = false,
  terminalRejected = false,
  forcePendingReconciliation = false,
} = {}) {
  if (!tableExists('credit_holds')) return null;
  const row = q.get(`SELECT id,status,held_credits,settled_credits,created_at,settled_at
    FROM credit_holds
    WHERE tenant_id=? AND ref_type=? AND ref_id=?
    ORDER BY id DESC LIMIT 1`, curTenant(), refType, refId);
  if (!row) return null;
  const fullyReleased = row.status === 'released'
    || (row.status === 'settled' && Number(row.settled_credits || 0) === 0);
  const label = forcePendingReconciliation
    ? PUBLIC_STATUS.billingPending
    : fullyReleased
    ? '预授权已释放（已退款）'
    : row.status === 'settled'
      ? `积分已结算（实扣 ${Number(row.settled_credits || 0)}）`
      : row.status === 'held'
        ? (terminalRejected
            ? '产出已驳回，预授权退款待账务对账'
            : terminalFailure
              ? '预授权待账务对账'
              : '积分预授权处理中')
        : '积分账务待人工核对';
  return node(`billing:${row.id}`, 'billing', '积分账务', label, row.settled_at || row.created_at);
}

function contentRunBillingState(run, snapshot) {
  const snapshotState = String(snapshot?.billing?.state || '').trim();
  if (snapshotState) return snapshotState;
  if (!tableExists('credit_holds')) return null;
  const hold = q.get(`SELECT status,settled_credits FROM credit_holds
    WHERE tenant_id=? AND ref_type='content_employee_run' AND ref_id=?
    ORDER BY id DESC LIMIT 1`, curTenant(), run.id);
  if (!hold) return null;
  if (hold.status === 'held') return 'pending_reconciliation';
  if (hold.status === 'released'
    || (hold.status === 'settled' && Number(hold.settled_credits || 0) === 0)) {
    return 'released';
  }
  return hold.status === 'settled' ? 'settled' : 'pending_reconciliation';
}

function realContentRunSource(run, snapshot) {
  const provider = isRecord(snapshot?.providerAttempt) ? snapshot.providerAttempt : {};
  const usage = isRecord(provider.usage) ? provider.usage : {};
  return !isBlockedDeliveryAiMode(run.ai_mode)
    && String(run.ai_mode || '').trim().toLowerCase() === 'api'
    && String(provider.mode || '').trim().toLowerCase() === 'api'
    && Boolean(String(run.model || '').trim())
    && Boolean(String(provider.model || '').trim())
    && Number(usage.inputTokens) > 0
    && Number(usage.outputTokens) > 0;
}

function restaurantState(task, output, approval, user) {
  if (output) {
    const adoption = loadContentAdoptionAvailability(output.id, { tenantId: curTenant() });
    if (BILLING_BLOCKING_CODES.has(adoption.state?.code)) {
      return {
        status: flowStatus('billing_pending', PUBLIC_STATUS.billingPending),
        action: nextAction('reconcile_billing', '完成账务对账后再进入人工审阅与交付'),
      };
    }
  }
  if (task.status === '失败') {
    const evidence = parsedSnapshot(task.employee_web_snapshot);
    const qualityFailed = evidence?.outputContract?.valid === false
      || contractLeakageDetected(evidence);
    return {
      status: qualityFailed
        ? flowStatus('quality_failed', PUBLIC_STATUS.qualityFailed, true)
        : flowStatus('generation_failed', PUBLIC_STATUS.generationFailed, true),
      action: nextAction('retry', '检查材料和模型通道后重新派活', '/employees'),
    };
  }
  if (task.status === '执行中' && !task.employee_profile_version) {
    return {
      status: flowStatus('awaiting_assignment', PUBLIC_STATUS.awaitingAssignment),
      action: nextAction('dispatch_employee', '选择具体数字员工继续派活', '/employees'),
    };
  }

  if (output) {
    const audit = inspectRestaurantOutputAudit({
      employeeProfileVersion: task.employee_profile_version,
      aiMode: output.ai_mode,
      executionEvidence: task.employee_web_snapshot,
      employeeIdx: task.employee_idx,
      taskTitle: task.title,
      taskRequirement: task.requirement,
      outputBody: output.body,
    });
    if (output.ai_mode === 'template' || (audit.applicable && !audit.valid)) {
      return {
        status: flowStatus('quality_failed', PUBLIC_STATUS.qualityFailed, true),
        action: nextAction('retry', '修复输入或模型通道后重新派活', '/employees'),
      };
    }
  } else if (['待审阅', '已完成'].includes(task.status)) {
    return {
      status: flowStatus('quality_failed', PUBLIC_STATUS.qualityFailed, true),
      action: nextAction('retry', '未找到可验证产出，请重新派活', '/employees'),
    };
  }

  const awaitingReview = task.status === '待审阅' || task.status === '已完成'
    || output?.status === '待审核' || approval?.status === '待审核';
  if (output && awaitingReview) {
    const adoption = loadContentAdoptionAvailability(output.id, { tenantId: curTenant() });
    if (['DELIVERY_BILLING_MISSING', 'DELIVERY_BILLING_UNSETTLED'].includes(adoption.state?.code)) {
      return {
        status: flowStatus('billing_pending', PUBLIC_STATUS.billingPending),
        action: nextAction('reconcile_billing', '完成账务对账后再进入人工审阅与交付'),
      };
    }
  }

  if (task.status === '已驳回' || approval?.status === '已驳回' || output?.status === '已驳回') {
    return {
      status: flowStatus('review_rejected', PUBLIC_STATUS.reviewRejected, true),
      action: nextAction('redispatch', '根据人工审阅意见返工后重新派活', '/employees'),
    };
  }
  if (output?.status === '已发布' && approval?.status === '已通过') {
    return {
      status: flowStatus('published', PUBLIC_STATUS.published, true),
      action: nextAction('view_result', '查看已发布结果', '/content'),
    };
  }
  if (approval?.status === '已通过' && ['可使用', '已发布'].includes(output?.status)) {
    return {
      status: flowStatus('approved', PUBLIC_STATUS.approved, true),
      action: nextAction('view_result', '查看已采纳的业务结果', '/assets'),
    };
  }
  if (task.status === '待审阅' || task.status === '已完成'
    || output?.status === '待审核' || approval?.status === '待审核') {
    const canReview = contentOutputReviewAccess(user, task, approval, output).allowed;
    return {
      status: flowStatus('review_pending', PUBLIC_STATUS.reviewPending),
      action: canReview
        ? nextAction('review_output', '前往审批中心完成人工审阅', '/system?tab=approvals')
        : nextAction('wait_for_review', '等待老板或有审阅权限的管理人员处理'),
    };
  }
  return {
    status: flowStatus('generating', PUBLIC_STATUS.generating),
    action: nextAction('wait_for_output', '等待生成并达到可验收条件', '/employees'),
  };
}

function restaurantFlow(id, user) {
  const task = q.get(`SELECT t.id,t.title,t.type,t.requirement,t.status,t.output_id,t.created_by,t.created_at,
      t.employee_profile_version,t.employee_web_snapshot,s.employee_idx
    FROM agent_tasks t LEFT JOIN specialists s ON s.id=t.specialist_id
    WHERE t.tenant_id=? AND t.id=?`, curTenant(), id);
  if (!task || !visibleTo(user, task.created_by)) return null;

  const output = task.output_id
    ? q.get(`SELECT id,title,body,status,ai_mode,snapshot_json,created_at FROM contents
      WHERE tenant_id=? AND id=?`, curTenant(), task.output_id)
    : null;
  const approval = output
    ? q.get(`SELECT id,title,status,created_at,decided_at FROM approvals
      WHERE tenant_id=? AND target_type='content' AND target_id=?
      ORDER BY id DESC LIMIT 1`, curTenant(), output.id)
    : null;
  const state = restaurantState(task, output, approval, user);

  const nodes = [node(
    `restaurant-task:${task.id}`,
    'restaurant_task',
    task.title,
    state.status.label,
    task.created_at,
    `/employees?taskId=${task.id}`,
  )];
  const links = [];
  const bill = billingNode('agent_task', task.id, {
    terminalFailure: ['generation_failed', 'quality_failed'].includes(state.status.code),
    terminalRejected: state.status.code === 'review_rejected',
    forcePendingReconciliation: state.status.code === 'billing_pending',
  });
  if (bill) {
    nodes.push(bill);
    links.push(link(nodes[0].id, bill.id, 'billing'));
  }

  if (output) {
    const blockingStatus = ['generation_failed', 'quality_failed', 'billing_pending'].includes(state.status.code)
      ? state.status.label
      : null;
    const outputNode = node(
      `content:${output.id}`,
      'content',
      output.title || '数字员工业务产出',
      blockingStatus || (state.status.code === 'quality_failed' ? PUBLIC_STATUS.qualityFailed
        : output.status === '已发布' ? PUBLIC_STATUS.published
          : output.status === '可使用' ? PUBLIC_STATUS.approved
            : output.status === '已驳回' ? PUBLIC_STATUS.reviewRejected
              : PUBLIC_STATUS.reviewPending),
      output.created_at,
      `/content?contentId=${output.id}`,
    );
    nodes.push(outputNode);
    links.push(link(nodes[0].id, outputNode.id, 'produced'));

    if (approval && !blockingStatus) {
      const approvalNode = node(
        `approval:${approval.id}`,
        'approval',
        approval.title || '人工审批',
        approvalNodeStatus(approval.status),
        approval.decided_at || approval.created_at,
        '/system?tab=approvals',
      );
      nodes.push(approvalNode);
      links.push(link(outputNode.id, approvalNode.id, 'reviewed_by'));
    }

    const asset = q.get(`SELECT id,name,status,created_at FROM biz_assets
      WHERE tenant_id=? AND source_id=? AND source_type IN ('content','kb_marshal')
      ORDER BY id DESC LIMIT 1`, curTenant(), output.id);
    if (asset && !blockingStatus) {
      const assetNode = node(
        `asset:${asset.id}`,
        'asset',
        asset.name || '业务资产',
        asset.status,
        asset.created_at,
        '/assets',
      );
      nodes.push(assetNode);
      links.push(link(outputNode.id, assetNode.id, 'archived_as'));
    }
  }

  const hasDownstream = Boolean(output || bill);
  return response({
    source: { type: 'restaurant_task', id: task.id, label: publicText(task.title, '餐饮数字员工任务') },
    nodes,
    links,
    ...state,
    hasDownstream,
    emptyMessage: state.status.code === 'awaiting_assignment'
      ? '任务已建立，但尚未选择具体数字员工，也没有生成业务产出。'
      : '任务已建立，业务产出尚未形成。',
  });
}

function contentState(run, contents = [], user = null) {
  const authority = loadContentEmployeeRunAuthority(run.id, { tenantId: curTenant() });
  if (run.status !== '生成中' && (authority.pendingReconciliation
    || (['待审阅', '已完成'].includes(run.status)
      && authority.billingState === 'missing'))) {
    return {
      status: flowStatus('billing_pending', PUBLIC_STATUS.billingPending),
      action: nextAction('reconcile_billing', '完成账务对账后再进入人工审阅与交付'),
    };
  }
  if (run.status === '失败' || run.ai_mode === 'failed') {
    const snapshot = parsedSnapshot(run.snapshot_json);
    const qualityFailed = contractValid(snapshot) === false || contractLeakageDetected(snapshot);
    return {
      status: qualityFailed
        ? flowStatus('quality_failed', PUBLIC_STATUS.qualityFailed, true)
        : flowStatus('generation_failed', PUBLIC_STATUS.generationFailed, true),
      action: nextAction('retry', '检查材料和模型通道后重新派活', `/content?employee=${run.employee_idx}`),
    };
  }
  if (run.status === '生成中') {
    return {
      status: flowStatus('generating', PUBLIC_STATUS.generating),
      action: nextAction('wait_for_output', '等待生成并达到可验收条件', `/content?employee=${run.employee_idx}`),
    };
  }

  const snapshot = parsedSnapshot(run.snapshot_json);
  const verified = authority.verified;
  const invalidDownstream = contents.some(content => (
    storedContentStatus(content) === PUBLIC_STATUS.qualityFailed
  ));
  if (!verified || invalidDownstream) {
    return {
      status: flowStatus('quality_failed', PUBLIC_STATUS.qualityFailed, true),
      action: nextAction('retry', '修复输入或模型通道后重新派活', `/content?employee=${run.employee_idx}`),
    };
  }
  if (run.status === '已驳回' || snapshot.review?.decision === 'reject') {
    return {
      status: flowStatus('review_rejected', PUBLIC_STATUS.reviewRejected, true),
      action: nextAction('redispatch', '根据人工审阅意见返工后重新派活', `/content?employee=${run.employee_idx}`),
    };
  }
  if (contents.some(content => storedContentStatus(content) === PUBLIC_STATUS.published)) {
    return {
      status: flowStatus('published', PUBLIC_STATUS.published, true),
      action: nextAction('view_content', '查看已发布内容', '/content'),
    };
  }
  if (run.status === '已完成' && snapshot.review?.decision === 'adopt') {
    return {
      status: flowStatus('approved', PUBLIC_STATUS.approved, true),
      action: nextAction('view_material', '查看已采纳的素材与内容', '/content'),
    };
  }
  return {
    status: flowStatus('review_pending', PUBLIC_STATUS.reviewPending),
    action: contentEmployeeRunReviewAccess(user, snapshot).allowed
      ? nextAction('review_output', '前往内容员工工作台完成人工审阅', `/content?employee=${run.employee_idx}&runId=${run.id}`)
      : nextAction('wait_for_review', '等待老板或有审阅权限的管理人员处理'),
  };
}

function contentFlow(id, user) {
  const run = q.get(`SELECT id,employee_idx,employee_name,title,status,result_md,ai_mode,model,snapshot_json,
      created_by,created_at,updated_at
    FROM content_employee_runs WHERE tenant_id=? AND id=?`, curTenant(), id);
  if (!run || !visibleTo(user, run.created_by)) return null;

  const contents = q.all(`SELECT id,title,body,status,ai_mode,snapshot_json,created_at FROM contents
    WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?
    ORDER BY id`, curTenant(), run.id);
  const state = contentState(run, contents, user);

  const runNode = node(
    `content-run:${run.id}`,
    'content_run',
    `${run.employee_name}：${run.title}`,
    state.status.label,
    run.updated_at || run.created_at,
    `/content?employee=${run.employee_idx}&runId=${run.id}`,
  );
  const nodes = [runNode];
  const links = [];
  const bill = billingNode('content_employee_run', run.id, {
    terminalFailure: ['generation_failed', 'quality_failed'].includes(state.status.code),
    terminalRejected: state.status.code === 'review_rejected',
    forcePendingReconciliation: state.status.code === 'billing_pending',
  });
  if (bill) {
    nodes.push(bill);
    links.push(link(runNode.id, bill.id, 'billing'));
  }

  const blockingStatus = ['generation_failed', 'quality_failed', 'billing_pending'].includes(state.status.code)
    ? state.status.label
    : null;
  if (['待审阅', '已完成', '已驳回'].includes(run.status) && !blockingStatus) {
    const snapshot = parsedSnapshot(run.snapshot_json);
    const reviewStatus = state.status.code === 'quality_failed'
      ? PUBLIC_STATUS.qualityFailed
      : snapshot.review?.decision === 'adopt'
        ? PUBLIC_STATUS.approved
        : snapshot.review?.decision === 'reject' || run.status === '已驳回'
          ? PUBLIC_STATUS.reviewRejected
          : PUBLIC_STATUS.reviewPending;
    const reviewNode = node(
      `content-review:${run.id}`,
      'review',
      '人工审阅',
      reviewStatus,
      run.updated_at,
      `/content?employee=${run.employee_idx}&runId=${run.id}`,
    );
    nodes.push(reviewNode);
    links.push(link(runNode.id, reviewNode.id, 'reviewed_by'));
  }

  const materials = q.all(`SELECT id,name,'已沉淀' status,created_at FROM materials
    WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?
    ORDER BY id`, curTenant(), run.id);
  for (const material of materials) {
    const materialNode = node(
      `material:${material.id}`,
      'material',
      material.name || '内容素材',
      blockingStatus || material.status || '已沉淀',
      material.created_at,
      '/content',
    );
    nodes.push(materialNode);
    links.push(link(runNode.id, materialNode.id, 'archived_as'));
  }

  for (const content of contents) {
    const contentNode = node(
      `content:${content.id}`,
      'content',
      content.title || '可发布内容',
      blockingStatus || storedContentStatus(content),
      content.created_at,
      `/content?contentId=${content.id}`,
    );
    nodes.push(contentNode);
    links.push(link(runNode.id, contentNode.id, 'produced'));
  }

  const hasDownstream = Boolean(bill || materials.length || contents.length || run.status !== '生成中');
  return response({
    source: { type: 'content_run', id: run.id, label: publicText(`${run.employee_name}：${run.title}`) },
    nodes,
    links,
    ...state,
    hasDownstream,
    emptyMessage: '内容员工任务已建立，产物仍在生成中。',
  });
}

function manualState(task, user, latestSubmission = null) {
  if (task.status === '已完成') {
    return {
      status: flowStatus('completed', '已人工验收（任务完成）', true),
      action: nextAction('view_task', '查看任务结果', `/execution?taskId=${task.id}`),
    };
  }
  if (task.status === '待审核') {
    const canReview = canReviewManualTask(user, task);
    return {
      status: flowStatus('review_pending', '待人工验收'),
      action: canReview
        ? nextAction('review_task', '前往任务看板完成人工验收', `/execution?taskId=${task.id}`)
        : nextAction('wait_for_review', '等待有权限的管理人员验收'),
    };
  }
  if (task.status === '进行中') {
    if (latestSubmission?.result === '驳回') {
      const reason = publicText(latestSubmission.review_reason, '请查看人工验收意见');
      return {
        status: flowStatus('rework', '返工中（人工验收退回）'),
        action: nextAction(
          'resubmit_task',
          `退回原因：${reason}；修改后重新提交人工验收`,
          `/execution?taskId=${task.id}`,
        ),
      };
    }
    return {
      status: flowStatus('running', '人工任务执行中'),
      action: nextAction('continue_task', '继续执行并提交结果', `/execution?taskId=${task.id}`),
    };
  }
  return {
    status: flowStatus('pending', '人工任务待执行'),
    action: nextAction('execute_task', '开始执行任务', `/execution?taskId=${task.id}`),
  };
}

function manualDescendants(rootTaskId) {
  const descendants = [];
  const visited = new Set([Number(rootTaskId)]);
  let frontier = [Number(rootTaskId)];
  for (let depth = 1; depth <= MAX_MANUAL_DESCENDANT_DEPTH; depth += 1) {
    if (!frontier.length || descendants.length >= MAX_MANUAL_DESCENDANTS) break;
    const placeholders = frontier.map(() => '?').join(',');
    // Each breadth query and the accumulated tree are both bounded. This makes
    // corrupt cycles and unusually wide trees finite before response assembly.
    const candidates = q.all(`SELECT id,title,status,assignee_id,assigned_by,parent_task_id,
      created_at,done_at,
      (SELECT s.result FROM task_submissions s
        WHERE s.tenant_id=tasks.tenant_id AND s.task_id=tasks.id ORDER BY s.id DESC LIMIT 1) last_submission_result,
      (SELECT s.review_reason FROM task_submissions s
        WHERE s.tenant_id=tasks.tenant_id AND s.task_id=tasks.id ORDER BY s.id DESC LIMIT 1) last_review_reason
      FROM tasks
      WHERE tenant_id=? AND parent_task_id IN (${placeholders})
      ORDER BY id LIMIT ?`, curTenant(), ...frontier, MAX_MANUAL_DESCENDANTS);
    const next = [];
    for (const candidate of candidates) {
      const candidateId = Number(candidate.id);
      if (!candidateId || visited.has(candidateId)) continue;
      visited.add(candidateId);
      descendants.push({ ...candidate, depth });
      next.push(candidateId);
      if (descendants.length >= MAX_MANUAL_DESCENDANTS) break;
    }
    frontier = next;
  }
  return descendants;
}

function manualSubmissions(taskIds) {
  if (!taskIds.length) return [];
  const placeholders = taskIds.map(() => '?').join(',');
  return q.all(`SELECT id,task_id,user_id,result,review_reason,source_ref_type,source_ref_id,created_at,reviewed_at FROM task_submissions
    WHERE tenant_id=? AND task_id IN (${placeholders})
    ORDER BY task_id,id
    LIMIT ?`, curTenant(), ...taskIds, MAX_MANUAL_SUBMISSIONS);
}

function customAgentOutputReference(messageId, ownerId) {
  return q.get(`SELECT m.id,m.session_id,m.created_at,s.agent_id,s.user_id,a.name agent_name,
      (SELECT status FROM approvals ap
        WHERE ap.tenant_id=m.tenant_id AND ap.target_type='custom_agent_msg' AND ap.target_id=m.id
        ORDER BY ap.id DESC LIMIT 1) approval_status
    FROM custom_agent_chat_msgs m
    JOIN custom_agent_chat_sessions s
      ON s.tenant_id=m.tenant_id AND s.id=m.session_id
    LEFT JOIN custom_agents a
      ON a.tenant_id=m.tenant_id AND a.id=s.agent_id
    WHERE m.tenant_id=? AND m.id=? AND m.role='assistant' AND s.user_id=?`,
  curTenant(), messageId, ownerId);
}

function manualFlow(id, user) {
  const canSee = ownerProjector(user);
  const task = q.get(`SELECT id,title,status,source,assignee_id,assigned_by,parent_task_id,
    source_ref_type,source_ref_id,created_at,done_at
    FROM tasks WHERE tenant_id=? AND id=?`, curTenant(), id);
  if (!task || !canSee(task.assignee_id, task.assigned_by)) return null;
  const latestSubmission = q.get(`SELECT result,review_reason,reviewed_at,created_at
    FROM task_submissions WHERE tenant_id=? AND task_id=? ORDER BY id DESC LIMIT 1`, curTenant(), task.id);
  const taskNode = node(
    `manual-task:${task.id}`,
    'manual_task',
    task.title,
    manualTaskDisplayStatus(task.status, latestSubmission),
    task.done_at || task.created_at,
    `/execution?taskId=${task.id}`,
  );
  const nodes = [];
  const links = [];

  if (task.source_ref_type === 'advisor_message' && task.source_ref_id) {
    const sourceMessage = q.get(`SELECT m.id,c.user_id FROM ai_messages m
      JOIN ai_conversations c ON c.tenant_id=m.tenant_id AND c.id=m.conversation_id
      WHERE m.tenant_id=? AND m.id=? AND m.role='assistant'`, curTenant(), task.source_ref_id);
    const sourceVisible = sourceMessage && canSee(sourceMessage.user_id);
    nodes.push(node(
      sourceVisible ? `advisor-message:${sourceMessage.id}` : `management-source:${task.id}`,
      sourceVisible ? 'advisor_message' : 'management_source',
      sourceVisible ? '老板参谋会诊结论' : '管理层任务来源',
      '已形成',
      null,
      sourceVisible ? `/advisor?messageId=${sourceMessage.id}` : null,
    ));
  }

  if (task.parent_task_id) {
    const parent = q.get(`SELECT id,title,status,assignee_id,assigned_by,created_at,done_at FROM tasks
      WHERE tenant_id=? AND id=?`, curTenant(), task.parent_task_id);
    if (parent) {
      const parentVisible = canSee(parent.assignee_id, parent.assigned_by);
      nodes.push(node(
        parentVisible ? `manual-task:${parent.id}` : `management-parent:${task.id}`,
        parentVisible ? 'manual_task' : 'management_source',
        parentVisible ? parent.title : '管理层拆解任务',
        parentVisible ? manualTaskDisplayStatus(parent.status) : '已拆解',
        parentVisible ? parent.done_at || parent.created_at : null,
        parentVisible ? `/execution?taskId=${parent.id}` : null,
      ));
    }
  }

  const upstream = nodes.at(-1);
  nodes.push(taskNode);
  if (upstream) {
    links.push(link(upstream.id, taskNode.id, task.parent_task_id ? 'decomposed_to' : 'converted_to'));
  }

  const descendants = manualDescendants(task.id);
  const visibleDescendants = descendants.filter(descendant => (
    canSee(descendant.assignee_id, descendant.assigned_by)
  ));
  const visibleTaskIds = new Set([Number(task.id)]);
  for (const descendant of visibleDescendants) {
    const descendantNode = node(
      `manual-task:${descendant.id}`,
      'manual_task',
      descendant.title,
      manualTaskDisplayStatus(descendant.status, {
        result: descendant.last_submission_result,
        review_reason: descendant.last_review_reason,
      }),
      descendant.done_at || descendant.created_at,
      `/execution?taskId=${descendant.id}`,
    );
    nodes.push(descendantNode);
    visibleTaskIds.add(Number(descendant.id));
  }

  for (const descendant of visibleDescendants) {
    const descendantNodeId = `manual-task:${descendant.id}`;
    const parentNodeId = Number(descendant.parent_task_id) === Number(task.id)
      ? taskNode.id
      : visibleTaskIds.has(Number(descendant.parent_task_id))
        ? `manual-task:${descendant.parent_task_id}`
        : null;
    if (parentNodeId) {
      links.push(link(parentNodeId, descendantNodeId, 'decomposed_to'));
      continue;
    }
    // Legacy/corrupt data may place a visible task below an out-of-scope branch.
    // Preserve the visible task without exposing the hidden parent's fields or id.
    const projectionNode = node(
      `management-branch:${descendant.id}`,
      'management_source',
      '管理层拆解任务',
      '已拆解',
    );
    nodes.push(projectionNode);
    links.push(link(projectionNode.id, descendantNodeId, 'decomposed_to'));
  }

  const submissions = manualSubmissions([...visibleTaskIds]);
  const sourceNodeIds = new Set();
  for (const submission of submissions) {
    const submissionNode = node(
      `task-submission:${submission.id}`,
      'submission',
      '任务结果提交',
      manualSubmissionDisplayStatus(submission.result, submission.review_reason),
      submission.reviewed_at || submission.created_at,
      `/execution?taskId=${submission.task_id}`,
    );
    nodes.push(submissionNode);
    links.push(link(`manual-task:${submission.task_id}`, submissionNode.id, 'submitted_as'));
    if (submission.source_ref_type === 'custom_agent_msg' && submission.source_ref_id) {
      const output = customAgentOutputReference(submission.source_ref_id, submission.user_id);
      if (!output) continue;
      const outputNodeId = `custom-agent-msg:${output.id}`;
      if (!sourceNodeIds.has(outputNodeId)) {
        sourceNodeIds.add(outputNodeId);
        nodes.push(node(
          outputNodeId,
          'custom_agent_msg',
          `智能体产出：${output.agent_name || '已删除的智能体'}`,
          output.approval_status ? approvalNodeStatus(output.approval_status) : '已生成',
          output.created_at,
          '/toolbox',
        ));
      }
      links.push(link(outputNodeId, submissionNode.id, 'referenced_by'));
    }
  }

  const baseState = manualState(task, user, latestSubmission);
  let state = baseState;
  if (
    visibleDescendants.length > 0
    && task.status === '进行中'
    && latestSubmission?.result !== '驳回'
  ) {
    const hasIncompleteDescendant = visibleDescendants.some(descendant => (
      descendant.status !== '已完成'
    ));
    state = hasIncompleteDescendant
      ? {
          status: flowStatus('children_running', '上级任务正在等待下级任务结果'),
          action: nextAction('follow_children', '跟进未完成的下级任务', `/execution?taskId=${task.id}`),
        }
      : {
          status: flowStatus('children_ready_to_aggregate', '下级任务已全部完成，等待上级汇总提交'),
          action: nextAction('aggregate_children', '汇总下级任务结果并提交人工验收', `/execution?taskId=${task.id}`),
        };
  }
  return response({
    source: { type: 'manual_task', id: task.id, label: publicText(task.title, '人工任务') },
    nodes,
    links,
    ...state,
    hasDownstream: submissions.length > 0 || visibleDescendants.length > 0 || task.status === '已完成',
    emptyMessage: `任务来源为“${publicText(task.source, '手动')}”，尚未形成后续人工验收或完成记录。`,
  });
}

function advisorFlow(id, user) {
  const message = q.get(`SELECT m.id,m.conversation_id,m.created_at,c.user_id,c.title,c.created_at conversation_created_at
    FROM ai_messages m
    JOIN ai_conversations c ON c.tenant_id=m.tenant_id AND c.id=m.conversation_id
    WHERE m.tenant_id=? AND m.id=? AND m.role='assistant'`, curTenant(), id);
  if (!message || !visibleTo(user, message.user_id)) return null;

  const conversationNode = node(
    `advisor-conversation:${message.conversation_id}`,
    'advisor_conversation',
    message.title || '老板参谋会诊',
    '已形成会诊',
    message.conversation_created_at,
    `/advisor?conversationId=${message.conversation_id}`,
  );
  const messageNode = node(
    `advisor-message:${message.id}`,
    'advisor_message',
    '会诊业务结论',
    '可转任务',
    message.created_at,
    `/advisor?conversationId=${message.conversation_id}`,
  );
  const nodes = [conversationNode, messageNode];
  const links = [link(conversationNode.id, messageNode.id, 'produced')];
  const taskRows = q.all(`SELECT id,title,status,created_at,done_at FROM tasks
    WHERE tenant_id=? AND source_ref_type='advisor_message' AND source_ref_id=?
    ORDER BY id`, curTenant(), message.id);
  for (const task of taskRows) {
    const taskNode = node(
      `manual-task:${task.id}`,
      'manual_task',
      task.title,
      task.status,
      task.done_at || task.created_at,
      `/execution?taskId=${task.id}`,
    );
    nodes.push(taskNode);
    links.push(link(messageNode.id, taskNode.id, 'converted_to'));
  }
  const hasDownstream = taskRows.length > 0;
  const allDone = hasDownstream && taskRows.every(task => task.status === '已完成');
  return response({
    source: { type: 'advisor_message', id: message.id, label: publicText(message.title, '老板参谋会诊') },
    nodes,
    links,
    status: allDone
      ? flowStatus('completed', '会诊行动项已完成', true)
      : hasDownstream
        ? flowStatus('tasks_pending', '会诊已转成执行任务')
        : flowStatus('ready_to_convert', '会诊结论尚未转任务'),
    action: allDone
      ? nextAction('view_tasks', '查看已完成行动项', '/execution')
      : hasDownstream
        ? nextAction('follow_tasks', '跟进会诊行动项', '/execution')
        : nextAction('convert_to_tasks', '将会诊结论转成任务', `/advisor?conversationId=${message.conversation_id}`),
    hasDownstream,
    emptyMessage: '会诊结论已经形成，但尚未转成任何人工执行任务。',
  });
}

r.use((req, res, next) => {
  if (!FLOW_ROLES.has(req.user?.role)) {
    return res.status(403).json({ error: '当前角色无权查看企业业务流' });
  }
  next();
});

r.get('/:sourceType/:sourceId', (req, res) => {
  const { sourceType } = req.params;
  if (!SOURCE_TYPES.has(sourceType)) {
    return res.status(400).json({
      error: '来源类型不正确，可选 restaurant_task、content_run、manual_task、advisor_message',
    });
  }
  const id = sourceId(req.params.sourceId);
  if (!id) return res.status(400).json({ error: '来源编号必须是正整数' });

  const builders = {
    restaurant_task: restaurantFlow,
    content_run: contentFlow,
    manual_task: manualFlow,
    advisor_message: advisorFlow,
  };
  const flow = builders[sourceType](id, req.user);
  if (!flow) return res.status(404).json({ error: '业务来源不存在或无权查看' });
  res.set('Cache-Control', 'private, no-store');
  return res.json(flow);
});

export default r;

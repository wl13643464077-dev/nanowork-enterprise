import { curTenant, db, q } from '../db.js';
import { inspectRestaurantOutputAudit } from './restaurant-output-contract.js';
import { inspectStructuredReportFirstEvidence } from './restaurant-report-first-validation.js';
import { parseApprovalWorkflowSnapshot } from './approval-routing-policy.js';
import { employeeModelSettlementBindingValid } from './credits.js';
import { canAccessOwner } from './access.js';

export const CONTENT_DELIVERY_STATUSES = Object.freeze(['可使用', '已发布']);

// 数据库存储状态用于兼容既有流程；页面和业务接口统一使用这组“人能做决定”的状态。
// 任何调用方都不应再把“可使用”解释成仅通过机器质检，或把账务阻断写成含糊的“禁用”。
export const BUSINESS_DELIVERY_LABELS = Object.freeze({
  awaitingAssignment: '待派活',
  generating: '生成中',
  draft: '草稿（待提交人工审阅）',
  reviewReady: '可验收（待提交人工审阅）',
  reviewPending: '待人工审阅',
  adopted: '已人工采纳（可用于业务）',
  published: '已发布',
  businessBlocked: '业务暂不可采用（待账务对账）',
  qualityFailed: '失败需返工（质检未通过）',
  executionFailed: '失败需处理（执行异常）',
  reviewRejected: '失败需返工（人工审阅未通过）',
  remediated: '历史失败（后续已修复）',
  superseded: '已由安全修订版取代',
  // P0-1 失败不交白卷：质量门未通过但正文已保留；老板可重新派活或接受为内部参考稿
  draftPending: '未达标草稿（待老板处理）',
  draftAccepted: '已接受草稿（内部参考，未通过质量门）',
});

const DELIVERY_STATUS_SET = new Set(CONTENT_DELIVERY_STATUSES);
const BLOCKED_AI_MODE = /(?:^|[_-])(template|fallback|failed|error|mock|demo|degraded)(?:$|[_-])/iu;
const ALLOWED_AI_MODES = new Set(['api', 'human_adopted', 'manual', 'human', 'human_authored', 'imported']);
const MANUAL_AI_MODES = new Set(['manual', 'human', 'human_authored', 'imported']);
const MANUAL_SOURCE_TYPES = new Set(['manual', 'manual_import', 'human', 'human_import']);
const INVALID_CONTRACT_STATUSES = new Set(['invalid', 'incomplete', 'draft', 'failed', 'error']);
export const CONTENT_ADOPTION_BLOCKING_CODES = Object.freeze([
  'DELIVERY_CONTENT_MISSING',
  'DELIVERY_SUPERSEDED',
  'DELIVERY_BODY_EMPTY',
  'DELIVERY_PROVENANCE_BLOCKED',
  'DELIVERY_PROVENANCE_UNKNOWN',
  'DELIVERY_CONTRACT_MISSING',
  'DELIVERY_CONTRACT_INVALID',
  'DELIVERY_BILLING_MISSING',
  'DELIVERY_BILLING_UNSETTLED',
]);
const CONTENT_ADOPTION_BLOCKING_CODE_SET = new Set(CONTENT_ADOPTION_BLOCKING_CODES);

export function isBlockedDeliveryAiMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return !mode || BLOCKED_AI_MODE.test(mode) || !ALLOWED_AI_MODES.has(mode);
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function parseObject(value) {
  if (plainObject(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    return plainObject(JSON.parse(value)) || {};
  } catch {
    return {};
  }
}

function blockedProviderModel(value) {
  const model = String(value || '').trim().toLowerCase();
  return !model
    || /(?:^|[_-])(template|fallback|failed|error|mock|demo|degraded|unknown|inherit)(?:$|[_-])/u.test(model);
}

const CONTENT_SPECIAL_PROVIDER_REF_TYPE = 'content_special_provider';

function billingComponents(billing) {
  return plainObject(billing?.components);
}

function primaryBillingComponent(billing) {
  const components = billingComponents(billing);
  if (!components) return billing;
  // mergeContentSpecialProviderBillingEvidence keeps the text hold under the
  // caller-provided key.  Accept the two names used by content employees and
  // the automation compatibility path, but never compare the aggregate to a
  // single primary hold.
  return plainObject(components.text)
    || plainObject(components.automationText)
    || null;
}

function inspectSpecialProviderBilling({ billing, tenantId, holdsTableReady }) {
  const components = billingComponents(billing);
  if (!components) {
    return {
      configured: false,
      valid: true,
      settled: true,
      released: true,
      pending: false,
      chargedCredits: 0,
    };
  }
  const attempts = Array.isArray(components.specialProviders)
    ? components.specialProviders
    : null;
  if (!attempts) {
    return {
      configured: true,
      valid: false,
      settled: false,
      released: false,
      pending: true,
      chargedCredits: 0,
      reason: 'special_provider_components_missing',
    };
  }
  if (!holdsTableReady && attempts.length) {
    return {
      configured: true,
      valid: false,
      settled: false,
      released: false,
      pending: true,
      chargedCredits: 0,
      reason: 'credit_holds_table_missing',
    };
  }

  const seenRefs = new Set();
  const seenHolds = new Set();
  let valid = true;
  let settled = true;
  let released = true;
  let chargedCredits = 0;
  for (const attempt of attempts) {
    const item = plainObject(attempt);
    const itemBilling = plainObject(item?.billing) || {};
    const refType = String(
      item?.refType || item?.hold?.refType || itemBilling.refType || '',
    ).trim();
    const refId = Number(
      item?.refId || item?.hold?.refId || itemBilling.refId || 0,
    );
    const holdId = Number(
      item?.holdId || item?.hold?.holdId || itemBilling.holdId || 0,
    );
    const refKey = `${refType}:${refId}`;
    if (
      refType !== CONTENT_SPECIAL_PROVIDER_REF_TYPE
      || !Number.isSafeInteger(refId)
      || refId <= 0
      || !Number.isSafeInteger(holdId)
      || holdId <= 0
      || seenRefs.has(refKey)
      || seenHolds.has(holdId)
    ) {
      valid = false;
      settled = false;
      released = false;
      continue;
    }
    seenRefs.add(refKey);
    seenHolds.add(holdId);
    const rows = q.all(`SELECT id,status,held_credits,settled_credits,tenant_id,ref_type,ref_id
      FROM credit_holds WHERE tenant_id=? AND ref_type=? AND ref_id=?`,
    tenantId, refType, refId);
    if (rows.length !== 1 || Number(rows[0]?.id) !== holdId) {
      valid = false;
      settled = false;
      released = false;
      continue;
    }
    const row = rows[0];
    const rowHeld = Number(row.held_credits || 0);
    const rowSettled = Number(row.settled_credits);
    const itemEstimated = itemBilling.estimatedCredits;
    if (itemEstimated != null && Number(itemEstimated) !== rowHeld) valid = false;
    const state = String(itemBilling.state || item.status || '').trim().toLowerCase();
    const itemCharged = itemBilling.chargedCredits;
    if (state === 'settled') {
      const matchesSettled = row.status === 'settled'
        && Number.isFinite(rowSettled)
        && rowSettled >= 0
        && itemCharged != null
        && Number(itemCharged) === rowSettled;
      if (!matchesSettled) valid = false;
      chargedCredits += Number.isFinite(rowSettled) ? rowSettled : 0;
      if (!matchesSettled) settled = false;
      released = false;
      continue;
    }
    if (state === 'released') {
      const matchesReleased = row.status === 'settled'
        && Number.isFinite(rowSettled)
        && rowSettled === 0
        && (itemCharged == null || Number(itemCharged) === 0);
      if (!matchesReleased) valid = false;
      settled = false;
      if (!matchesReleased) released = false;
      continue;
    }
    // A provider hold that is still held (or otherwise unknown) must keep the
    // complete content run out of the business-ready/auto-adopt path.
    settled = false;
    released = false;
    if (row.status !== 'held' || itemCharged != null) valid = false;
  }
  if (!attempts.length) {
    // An empty list is a valid “no paid special provider” component.
    settled = true;
    released = true;
  }
  return {
    configured: true,
    valid,
    settled: valid && settled,
    released: valid && released,
    pending: !settled,
    chargedCredits,
  };
}

/**
 * Canonical read-only authority for one content-employee run. UI projections and
 * dashboard counters must use this instead of trusting snapshot.billing.
 */
export function loadContentEmployeeRunAuthority(runOrId, { tenantId = curTenant() } = {}) {
  const id = Number(plainObject(runOrId)?.id ?? runOrId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { exists: false, verified: false, reviewable: false, billingState: 'missing' };
  }
  const run = q.get(`SELECT id,employee_name,status,result_md,ai_mode,model,snapshot_json,created_by
    FROM content_employee_runs WHERE tenant_id=? AND id=?`, tenantId, id);
  if (!run) return { exists: false, verified: false, reviewable: false, billingState: 'missing' };
  const snapshot = parseObject(run.snapshot_json);
  const provider = plainObject(snapshot.providerAttempt) || {};
  const usage = plainObject(provider.usage) || {};
  const billing = plainObject(snapshot.billing) || {};
  const holdsTableReady = Boolean(q.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_holds'"));
  const holds = holdsTableReady
    ? q.all(`SELECT h.id,h.status,h.settled_credits,h.user_id hold_user_id,h.log_id,
        h.feature hold_feature,h.kind hold_kind,h.model hold_model,
        l.id ledger_id,l.user_id log_user_id,l.feature log_feature,l.kind log_kind,
        l.model ledger_model,l.ai_mode ledger_ai_mode,l.input_tokens,l.output_tokens,l.credits ledger_credits
      FROM credit_holds h LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
      WHERE h.tenant_id=? AND h.ref_type='content_employee_run' AND h.ref_id=? ORDER BY h.id`,
    tenantId, id)
    : [];
  const hold = holds[0];
  const expectedFeature = `内容员工单派·${String(run.employee_name || '').trim()}`;
  const chargedCredits = Number(hold?.settled_credits || 0);
  const primaryBilling = primaryBillingComponent(billing);
  const hasBillingComponents = Boolean(billingComponents(billing));
  const bindingValid = holds.length === 1
    && Number(hold?.ledger_id) === Number(hold?.log_id)
    && Number(hold?.hold_user_id) === Number(run.created_by)
    && Number(hold?.log_user_id) === Number(run.created_by)
    && hold?.hold_feature === expectedFeature
    && hold?.hold_kind === 'text'
    && hold?.hold_feature === hold?.log_feature
    && hold?.hold_kind === hold?.log_kind
    && String(hold?.hold_model || '').trim().toLowerCase()
      === String(hold?.ledger_model || '').trim().toLowerCase();
  const primarySettled = bindingValid
    && hold.status === 'settled'
    && chargedCredits > 0
    && Number(hold.ledger_credits) === chargedCredits
    && String(hold.ledger_ai_mode || '').trim().toLowerCase() === 'api'
    && Number(hold.input_tokens) > 0
    && Number(hold.output_tokens) > 0
    && String(run.model || '').trim().toLowerCase() === String(provider.model || '').trim().toLowerCase()
    && String(run.model || '').trim().toLowerCase() === String(hold.ledger_model || '').trim().toLowerCase()
    && Number(usage.inputTokens) === Number(hold.input_tokens)
    && Number(usage.outputTokens) === Number(hold.output_tokens)
    && Number(primaryBilling?.chargedCredits) === chargedCredits;
  const primaryReleased = bindingValid
    && hold.status === 'settled'
    && chargedCredits === 0
    && Number(hold.ledger_credits) === 0;
  const specialProviderLedger = inspectSpecialProviderBilling({
    billing,
    tenantId,
    holdsTableReady: Boolean(holdsTableReady),
  });
  const specialLedgerSettled = !hasBillingComponents || specialProviderLedger.settled;
  const specialLedgerReleased = !hasBillingComponents || specialProviderLedger.released;
  const aggregateChargedCredits = Number(billing.chargedCredits);
  const canonicalSettledCredits = chargedCredits + Number(specialProviderLedger.chargedCredits || 0);
  const aggregateMatchesComponents = !hasBillingComponents
    || (Number.isFinite(aggregateChargedCredits)
      && aggregateChargedCredits === canonicalSettledCredits);
  const settled = primarySettled
    && specialProviderLedger.valid
    && specialLedgerSettled
    && aggregateMatchesComponents;
  const released = primaryReleased
    && specialProviderLedger.valid
    && specialLedgerReleased;
  const claimedState = String(billing.state || '').trim().toLowerCase();
  const billingConflict = holds.length > 1
    || holds.some(item => item.status === 'held')
    || (holds.length === 1 && !primarySettled && !primaryReleased)
    || (hasBillingComponents && (!specialProviderLedger.valid || !specialLedgerSettled))
    || (hasBillingComponents && !aggregateMatchesComponents)
    || (holds.length === 0 && ['held', 'settled', 'released', 'pending_reconciliation', 'unsettled']
      .includes(claimedState));
  const contract = plainObject(snapshot.contract);
  const contractValid = contract && typeof contract.valid === 'boolean'
    ? contract.valid === true
    : snapshot.contractValid === true;
  const leakageClear = plainObject(snapshot.internalProfileLeakage)?.detected === false;
  const qualityValid = String(run.ai_mode || '').trim().toLowerCase() === 'api'
    && String(provider.mode || '').trim().toLowerCase() === 'api'
    && !blockedProviderModel(run.model)
    && !blockedProviderModel(provider.model)
    && Number(usage.inputTokens) > 0
    && Number(usage.outputTokens) > 0
    && contractValid
    && leakageClear
    && Boolean(String(run.result_md || '').trim());
  const verified = qualityValid && settled;
  return {
    exists: true,
    run,
    snapshot,
    qualityValid,
    verified,
    reviewable: verified && run.status === '待审阅',
    billingState: settled ? 'settled'
      : released ? 'released'
        : billingConflict ? 'pending_reconciliation'
          : 'missing',
    pendingReconciliation: billingConflict,
    chargedCredits: settled ? canonicalSettledCredits : 0,
  };
}

function normalizedMode(content) {
  return String(content?.ai_mode || '').trim().toLowerCase();
}

function provenanceState(content) {
  const mode = normalizedMode(content);
  const sourceType = String(content?.source_type || '').trim().toLowerCase();
  const explicitManualSource = MANUAL_SOURCE_TYPES.has(sourceType);

  if (mode && BLOCKED_AI_MODE.test(mode) && !(mode === 'template' && explicitManualSource)) {
    return {
      valid: false,
      kind: 'blocked',
      mode,
      sourceType: sourceType || null,
      code: 'DELIVERY_PROVENANCE_BLOCKED',
      reason: `内容来源为“${mode}”，仅是模板、降级或失败底稿，不是真实可交付产物`,
    };
  }

  // source_type is the authoritative discriminator for an actual human import.
  // This preserves legacy rows whose ai_mode inherited the old database default
  // "template" even though the row was explicitly recorded as a manual import.
  if (explicitManualSource) {
    return { valid: true, kind: 'manual', mode: mode || 'manual', sourceType };
  }
  if (!mode || BLOCKED_AI_MODE.test(mode)) {
    return {
      valid: false,
      kind: 'blocked',
      mode: mode || 'unknown',
      sourceType: sourceType || null,
      code: 'DELIVERY_PROVENANCE_BLOCKED',
      reason: mode
        ? `内容来源为“${mode}”，仅是模板、降级或失败底稿，不是真实可交付产物`
        : '内容缺少可追溯的人工或真实 API 产出来源',
    };
  }
  if (!ALLOWED_AI_MODES.has(mode)) {
    return {
      valid: false,
      kind: 'blocked',
      mode,
      sourceType: sourceType || null,
      code: 'DELIVERY_PROVENANCE_UNKNOWN',
      reason: `内容来源“${mode}”未经可交付白名单确认`,
    };
  }
  return {
    valid: true,
    kind: MANUAL_AI_MODES.has(mode) ? 'manual' : 'ai',
    mode,
    sourceType: sourceType || null,
  };
}

function contractSignal(value, source) {
  const contract = plainObject(value);
  if (!contract) return null;
  const status = String(contract.status || '').trim().toLowerCase();
  const hasValidity = typeof contract.valid === 'boolean' || Boolean(status);
  if (!hasValidity) return null;
  const invalid = contract.valid === false
    || INVALID_CONTRACT_STATUSES.has(status)
    || contract.incomplete === true
    || contract.requiresManualRepair === true;
  const valid = !invalid && (contract.valid === true || status === 'valid');
  return {
    source,
    valid,
    status: status || (valid ? 'valid' : 'unknown'),
    errors: Array.isArray(contract.errors) ? contract.errors.map(String).slice(0, 20) : [],
  };
}

function contractState(content, task, { dataMode = 'live' } = {}) {
  const snapshot = parseObject(content?.snapshot_json);
  const signals = [
    contractSignal(snapshot.contract, 'content_snapshot.contract'),
    contractSignal(snapshot.outputContract, 'content_snapshot.outputContract'),
    contractSignal(snapshot.executionEvidence?.outputContract, 'content_snapshot.executionEvidence.outputContract'),
  ].filter(Boolean);

  if (typeof snapshot.contractValid === 'boolean') {
    signals.push({
      source: 'content_snapshot.contractValid',
      valid: snapshot.contractValid === true,
      status: snapshot.contractValid === true ? 'valid' : 'invalid',
      errors: [],
    });
  }

  const reportFirstAudit = inspectStructuredReportFirstEvidence({
    dataMode,
    content,
    task,
    executionEvidence: task?.employee_web_snapshot,
  });
  if (reportFirstAudit.applicable) {
    signals.push({
      source: 'restaurant_report_first_audit',
      valid: reportFirstAudit.valid,
      status: reportFirstAudit.valid ? 'valid' : 'invalid',
      errors: reportFirstAudit.errors,
    });
  } else {
    const restaurantAudit = inspectRestaurantOutputAudit({
      employeeProfileVersion: task?.employee_profile_version,
      aiMode: content?.ai_mode,
      executionEvidence: task?.employee_web_snapshot,
      employeeIdx: task?.employee_idx,
      taskTitle: task?.title,
      taskRequirement: task?.requirement,
      outputBody: content?.body,
    });
    if (restaurantAudit.applicable) {
      signals.push({
        source: 'restaurant_output_audit',
        valid: restaurantAudit.valid,
        status: restaurantAudit.valid ? 'valid' : 'invalid',
        errors: restaurantAudit.error ? [restaurantAudit.error] : [],
      });
    }
  }

  const runMode = String(content?.content_run_mode || '').trim().toLowerCase();
  const requiresResultContract = String(content?.source_type || '') === 'content_employee_run'
    || runMode === 'automation_immediate'
    || runMode === 'automation_scheduled';
  if (requiresResultContract && signals.length === 0) {
    return {
      applicable: true,
      valid: false,
      signals: [],
      code: 'DELIVERY_CONTRACT_MISSING',
      reason: '内容员工产出缺少可验证的结果契约证据',
    };
  }
  if (!signals.length) return { applicable: false, valid: true, signals: [] };

  const failed = signals.find(signal => !signal.valid);
  return failed
    ? {
        applicable: true,
        valid: false,
        signals,
        code: 'DELIVERY_CONTRACT_INVALID',
        reason: failed.errors[0] || '内容输出契约未通过，不能采纳或对外使用',
      }
    : {
        applicable: true,
        valid: true,
        signals,
        ...(reportFirstAudit.applicable ? { reportFirst: true } : {}),
      };
}

function billingState(content, provenance) {
  // 明确的人工编写/导入没有供应商调用，因此不要求 AI 计费凭证。
  if (provenance.kind === 'manual') {
    return {
      applicable: false,
      valid: true,
      state: 'not_required',
      reason: '人工内容不涉及 AI 供应商计费',
    };
  }

  const snapshot = parseObject(content?.snapshot_json);
  const billing = plainObject(snapshot.billing);
  if (!billing || !String(billing.state || '').trim()) {
    return {
      applicable: true,
      valid: false,
      state: 'missing',
      code: 'DELIVERY_BILLING_MISSING',
      reason: '真实 AI 内容缺少可核验的结算凭证，不能进入使用、采纳或发布链路',
    };
  }

  const state = String(billing.state).trim().toLowerCase();
  const evidence = String(billing.evidenceSource || '').trim()
    ? {
        evidenceSource: String(billing.evidenceSource),
        evidenceSourceId: Number(billing.evidenceSourceId) || null,
      }
    : {};
  if (state !== 'settled') {
    const reason = state === 'pending_reconciliation'
      ? '内容已完成技术生成，但积分仍待账务对账，当前业务暂不可采用，也不能进入发布'
      : state === 'held'
        ? '内容仍处于预授权占扣状态，尚未完成实扣结算，当前业务暂不可采用'
        : `内容账务状态为“${state || '未知'}”，尚未完成实扣结算，当前业务暂不可采用`;
    return {
      applicable: true,
      valid: false,
      state,
      code: 'DELIVERY_BILLING_UNSETTLED',
      reason,
      pendingReconciliation: state === 'pending_reconciliation' || state === 'held',
      ...evidence,
    };
  }

  return {
    applicable: true,
    valid: true,
    state: 'settled',
    pendingReconciliation: false,
    ...evidence,
  };
}

function approvalState(content, approvals) {
  const rows = Array.isArray(approvals) ? approvals : [];
  const pending = rows.filter(row => row.status === '待审核');
  const approved = rows.filter(row => row.status === '已通过');
  const rejected = rows.filter(row => row.status === '已驳回');
  const latest = rows[0] || null;
  return {
    pendingCount: pending.length,
    approvedCount: approved.length,
    rejectedCount: rejected.length,
    latestId: latest ? Number(latest.id) : null,
    latestStatus: latest?.status || null,
    hasPending: pending.length > 0,
    hasApproved: approved.length > 0,
    contentStatus: String(content?.status || ''),
  };
}

function canonicalAutomaticAdoption(content) {
  const snapshot = parseObject(content?.snapshot_json);
  try {
    const route = parseApprovalWorkflowSnapshot(snapshot.approvalRouting);
    const valid = route?.targetType === 'content'
      && route.requiresReview === false
      && route.autoAdopt === true
      && route.steps.length === 0;
    return {
      valid,
      mode: valid ? route.policyMode : null,
      reason: valid ? route.reason : null,
    };
  } catch {
    return { valid: false, mode: null, reason: null };
  }
}

function blockedState(content, provenance, contract, billing, approval, code, reason, nextAction) {
  return {
    eligible: false,
    state: code === 'DELIVERY_REVIEW_PENDING' || code === 'DELIVERY_HUMAN_APPROVAL_REQUIRED'
      ? 'review_required'
      : code === 'DELIVERY_BILLING_UNSETTLED' || code === 'DELIVERY_BILLING_MISSING'
        ? 'pending_reconciliation'
        : 'blocked',
    code,
    reason,
    nextAction,
    status: String(content?.status || '未知'),
    provenance,
    contract,
    billing,
    approval,
  };
}

/**
 * Pure delivery-state evaluator. Callers that own database rows should normally
 * use loadContentDeliveryState/assertContentDeliverable so approval and task
 * evidence cannot be spoofed by a partial object supplied by a caller.
 */
export function inspectContentDeliveryState(content, {
  approvals = [],
  task = null,
  requireFlowStatus = true,
  requireBilling = true,
  allowPolicyAutoAdopt = false,
  dataMode = 'live',
} = {}) {
  const provenance = provenanceState(content);
  const contract = contractState(content, task, { dataMode });
  const contentBilling = billingState(content, provenance);
  const approval = approvalState(content, approvals);
  const automaticAdoption = allowPolicyAutoAdopt
    ? canonicalAutomaticAdoption(content)
    : { valid: false, mode: null, reason: null };
  const status = String(content?.status || '');

  if (!content || !Number(content.id)) {
    return blockedState(content, provenance, contract, contentBilling, approval,
      'DELIVERY_CONTENT_MISSING', '内容记录不存在', '刷新后重试');
  }
  if (!String(content.body || '').trim()) {
    return blockedState(content, provenance, contract, contentBilling, approval,
      'DELIVERY_BODY_EMPTY', '内容正文为空，没有可交付产物', '重新生成或完成正文');
  }
  if (!provenance.valid) {
    return blockedState(content, provenance, contract, contentBilling, approval,
      provenance.code, provenance.reason, '使用真实 API 重新执行，或以明确的人工来源新建内容');
  }
  if (requireBilling && !contentBilling.valid) {
    return blockedState(content, provenance, contract, contentBilling, approval,
      contentBilling.code, contentBilling.reason, '完成积分结算或人工对账后再进入后续流程');
  }
  if (!contract.valid) {
    return blockedState(content, provenance, contract, contentBilling, approval,
      contract.code, contract.reason, '按岗位契约返工并生成新修订稿');
  }

  if (status === '待审核') {
    if (!approval.hasPending) {
      return blockedState(content, provenance, contract, contentBilling, approval,
        'DELIVERY_APPROVAL_MISSING', '内容已到可验收阶段，但缺少对应的人工审阅单', '补建审阅单后再由有权限的人审阅');
    }
    return blockedState(content, provenance, contract, contentBilling, approval,
      'DELIVERY_REVIEW_PENDING', '内容正在等待人工审阅；被采纳前不能用于正式业务', '由有权限的人员完成人工审阅');
  }

  if (approval.hasPending) {
    return blockedState(content, provenance, contract, contentBilling, approval,
      'DELIVERY_REVIEW_PENDING', '内容存在未处理的人工审阅单；被采纳前不能用于正式业务', '先完成人工审阅');
  }
  if (approval.latestStatus && approval.latestStatus !== '已通过') {
    return blockedState(content, provenance, contract, contentBilling, approval,
      'DELIVERY_APPROVAL_NOT_PASSED', `最近一次人工审阅结果为“${approval.latestStatus}”，当前稿件不能采用`, '按审阅意见返工并提交新修订稿');
  }
  if (requireFlowStatus && !DELIVERY_STATUS_SET.has(status)) {
    return blockedState(content, provenance, contract, contentBilling, approval,
      'DELIVERY_STATUS_NOT_READY', `内容当前为“${status || '未知'}”，未达到可交付终态`, '完成生成、契约校验和必要人工审阅');
  }
  // 明确的人工原创/人工导入在创建时已经由创建人完成事实确认，避免再让本人
  // 审批本人一次。AI 来源（含 human_adopted 派生内容）则必须依赖数据库中的
  // canonical 已通过审批，不能靠 contents.status 或 snapshot.review 自报采纳。
  if (requireFlowStatus && provenance.kind !== 'manual'
    && !approval.hasApproved && !automaticAdoption.valid) {
    return blockedState(content, provenance, contract, contentBilling, approval,
      'DELIVERY_HUMAN_APPROVAL_REQUIRED',
      '内容已通过机器质检，但尚未人工采纳；当前仅可内部预览，不能导入正式素材或登记发布',
      '提交人工审阅，通过后再进入正式使用与发布流程');
  }

  return {
    eligible: true,
    state: status === '已发布' ? 'published' : 'usable',
    code: status === '已发布' ? 'DELIVERY_PUBLISHED' : 'DELIVERY_USABLE',
    reason: status === '已发布' ? '内容已通过交付门禁并完成发布登记' : '内容已通过交付门禁',
    nextAction: null,
    status,
    provenance,
    contract,
    billing: contentBilling,
    approval,
    automaticAdoption,
  };
}

function canonicalContent(contentOrId, tenantId) {
  const id = Number(plainObject(contentOrId)?.id ?? contentOrId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return q.get(`SELECT * FROM contents WHERE tenant_id=? AND id=?`, tenantId, id) || null;
}

function contentWithCanonicalSourceBilling(content, tenantId) {
  if (!content) return content;
  const snapshot = parseObject(content.snapshot_json);
  if (String(content.source_type || '').trim().toLowerCase() !== 'content_employee_run') {
    return content;
  }
  const sourceId = Number(content.source_id);
  const authority = loadContentEmployeeRunAuthority(sourceId, { tenantId });
  // AI来源内容的源运行账本是唯一正向权威。无效source_id、重复账本、错用户或
  // 快照自报settled都只能进入待对账，绝不回退信任contents.snapshot_json。
  const state = authority.billingState === 'settled'
    ? 'settled'
    : authority.billingState === 'released'
      ? 'released'
      : 'pending_reconciliation';
  return {
    ...content,
    snapshot_json: {
      ...snapshot,
      billing: {
        state,
        chargedCredits: Number(authority.chargedCredits || 0),
        pendingReconciliation: state === 'pending_reconciliation',
        evidenceSource: 'content_employee_run',
        evidenceSourceId: Number.isSafeInteger(sourceId) && sourceId > 0 ? sourceId : null,
      },
    },
  };
}

function taskBillingEvidence(task, tenantId) {
  if (!task?.id) return null;
  const taskSnapshot = parseObject(task.employee_web_snapshot);
  const embedded = plainObject(taskSnapshot.billing)
    || plainObject(taskSnapshot.executionEvidence?.billing);

  const hasHoldTable = q.get(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_holds'",
  );
  if (hasHoldTable) {
    const holds = q.all(`SELECT h.id,h.status,h.held_credits,h.settled_credits,h.settled_at,
        h.user_id hold_user_id,h.log_id,h.feature hold_feature,h.kind hold_kind,h.model hold_model,
        l.id ledger_id,l.user_id log_user_id,l.feature log_feature,l.kind log_kind,
        l.ai_mode ledger_ai_mode,l.model ledger_model,l.credits ledger_credits,
        l.input_tokens ledger_input_tokens,l.output_tokens ledger_output_tokens
      FROM credit_holds h
      LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
      WHERE h.tenant_id=? AND h.ref_type='agent_task' AND h.ref_id=?
      ORDER BY h.id DESC`, tenantId, task.id);
    const expectedOwner = Number(task.created_by);
    const expectedFeature = `员工任务·${String(task.marshal_name || '').trim()}`;
    const validOwner = hold => Number(hold.hold_user_id) === expectedOwner
      && Number(hold.log_user_id) === expectedOwner
      && Number(task.output_creator_id) === expectedOwner;
    const validBinding = hold => Number(hold.ledger_id) === Number(hold.log_id)
      && hold.hold_feature === expectedFeature
      && hold.hold_kind === 'text'
      && hold.hold_feature === hold.log_feature
      && hold.hold_kind === hold.log_kind
      && employeeModelSettlementBindingValid({
        holdModel: hold.hold_model,
        ledgerModel: hold.ledger_model,
        executionEvidence: taskSnapshot,
        ledgerUsage: {
          inputTokens: hold.ledger_input_tokens,
          outputTokens: hold.ledger_output_tokens,
        },
      });
    const settled = holds[0];
    const chargedCredits = Number(settled?.settled_credits || 0);
    const validApiSettlement = holds.length === 1
      && settled?.status === 'settled'
      && chargedCredits > 0
      && Number(settled.ledger_credits) === chargedCredits
      && validOwner(settled)
      && validBinding(settled)
      && String(settled.ledger_ai_mode || '').trim().toLowerCase() === 'api'
      && Number(settled.ledger_input_tokens) > 0
      && Number(settled.ledger_output_tokens) > 0;
    const cleanRelease = holds.length === 1
      && settled?.status === 'settled'
      && chargedCredits === 0
      && Number(settled.ledger_credits) === 0
      && validOwner(settled)
      && validBinding(settled);
    if (validApiSettlement) {
      return {
        state: 'settled',
        heldCredits: Number(settled.held_credits || 0),
        chargedCredits,
        pendingReconciliation: false,
        settledAt: settled.settled_at || null,
        evidenceSource: 'agent_task_credit_hold',
        evidenceSourceId: Number(task.id),
      };
    }
    if (cleanRelease) {
      return {
        state: 'released',
        heldCredits: Number(settled.held_credits || 0),
        chargedCredits: 0,
        pendingReconciliation: false,
        settledAt: settled.settled_at || null,
        evidenceSource: 'agent_task_credit_hold',
        evidenceSourceId: Number(task.id),
      };
    }
    if (holds.length > 0) {
      return {
        state: 'pending_reconciliation',
        pendingReconciliation: true,
        evidenceSource: 'agent_task_credit_hold',
        evidenceSourceId: Number(task.id),
      };
    }
  }

  if (!embedded || !String(embedded.state || '').trim()) {
    return {
      state: 'pending_reconciliation',
      pendingReconciliation: true,
      evidenceSource: 'agent_task_credit_hold_missing',
      evidenceSourceId: Number(task.id),
    };
  }
  const embeddedState = String(embedded.state).trim().toLowerCase();
  // Task execution snapshots are useful as negative evidence, but the credit
  // ledger is the sole positive authority for an agent-task settlement.
  if (!['held', 'pending_reconciliation'].includes(embeddedState)) {
    return {
      state: 'pending_reconciliation',
      pendingReconciliation: true,
      evidenceSource: 'agent_task_credit_hold_missing',
      evidenceSourceId: Number(task.id),
    };
  }
  return {
    ...embedded,
    evidenceSource: 'agent_task_snapshot',
    evidenceSourceId: Number(task.id),
  };
}

function supersessionError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function publicSupersession(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    supersededTaskId: Number(row.superseded_task_id),
    replacementTaskId: Number(row.replacement_task_id),
    replacementOutputId: Number(row.replacement_output_id),
    taskId: Number(row.replacement_task_id),
    outputId: Number(row.replacement_output_id),
    title: row.replacement_title || null,
    employeeIdx:
      row.replacement_employee_idx == null
        ? null
        : Number(row.replacement_employee_idx),
    reason: row.reason || null,
    createdBy: Number(row.created_by),
    createdAt: row.created_at,
  };
}

/**
 * Canonical append-only projection for a restaurant task that has been
 * replaced by a later safety revision. The original task/body/artifacts remain
 * immutable audit evidence; all business-facing readers use this row to make
 * them non-deliverable.
 */
export function loadAgentTaskSupersession(taskOrId, {
  tenantId = curTenant(),
} = {}) {
  const taskId = Number(plainObject(taskOrId)?.id ?? taskOrId);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) return null;
  const row = q.get(`SELECT ats.*,
      replacement.title replacement_title,
      replacement_specialist.employee_idx replacement_employee_idx
    FROM agent_task_supersessions ats
    JOIN agent_tasks replacement
      ON replacement.tenant_id=ats.tenant_id
      AND replacement.id=ats.replacement_task_id
    LEFT JOIN specialists replacement_specialist
      ON replacement_specialist.id=replacement.specialist_id
    WHERE ats.tenant_id=? AND ats.superseded_task_id=?`,
  tenantId, taskId);
  return publicSupersession(row);
}

function loadContentSupersession(contentId, tenantId) {
  const id = Number(contentId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = q.get(`SELECT ats.*,
      replacement.title replacement_title,
      replacement_specialist.employee_idx replacement_employee_idx
    FROM agent_task_supersessions ats
    JOIN agent_tasks superseded
      ON superseded.tenant_id=ats.tenant_id
      AND superseded.id=ats.superseded_task_id
    JOIN agent_tasks replacement
      ON replacement.tenant_id=ats.tenant_id
      AND replacement.id=ats.replacement_task_id
    LEFT JOIN specialists replacement_specialist
      ON replacement_specialist.id=replacement.specialist_id
    WHERE ats.tenant_id=? AND superseded.output_id=?
    ORDER BY ats.id DESC LIMIT 1`, tenantId, id);
  return publicSupersession(row);
}

/**
 * Resolve whether a knowledge document is only an index/archive projection of
 * a superseded restaurant task.  Callers must use this before exposing or
 * mutating KB bodies because a disabled document can otherwise be re-enabled
 * through a secondary administration/import route.
 */
export function loadKbDocSupersession(docOrId, {
  tenantId = curTenant(),
} = {}) {
  const docId = Number(plainObject(docOrId)?.id ?? docOrId);
  if (!Number.isSafeInteger(docId) || docId <= 0) return null;
  const doc = plainObject(docOrId) || q.get(
    `SELECT id,source_type,source_id,file_path FROM kb_docs
    WHERE tenant_id=? AND id=?`,
    tenantId,
    docId,
  );
  if (!doc) return null;
  if (doc.source_type === 'content' && Number(doc.source_id) > 0) {
    const supersededBy = loadContentSupersession(doc.source_id, tenantId);
    if (supersededBy) return supersededBy;
  }
  const taskIds = [];
  if (doc.source_type === 'agent_task' && Number(doc.source_id) > 0) {
    taskIds.push(Number(doc.source_id));
  }
  const artifacts = q.all(
    `SELECT source_id FROM generated_artifacts
    WHERE tenant_id=? AND source_type='agent_task' AND (
      kb_doc_id=? OR (COALESCE(?,'')<>'' AND file_url=?))`,
    tenantId,
    docId,
    doc.file_path,
    doc.file_path,
  );
  taskIds.push(
    ...artifacts.map((row) => Number(row.source_id)).filter((id) => id > 0),
  );
  for (const taskId of new Set(taskIds)) {
    const supersededBy = loadAgentTaskSupersession(taskId, { tenantId });
    if (supersededBy) return supersededBy;
  }
  return null;
}

function canonicalSupersessionTask(taskId, tenantId) {
  return q.get(`SELECT t.*,
      s.employee_idx,
      m.name marshal_name,
      c.id canonical_output_id,
      c.creator_id output_creator_id,
      c.ai_mode output_ai_mode,
      c.body output_body,
      c.status output_status
    FROM agent_tasks t
    JOIN marshals m ON m.id=t.marshal_id
    LEFT JOIN specialists s ON s.id=t.specialist_id
    LEFT JOIN contents c ON c.tenant_id=t.tenant_id AND c.id=t.output_id
    WHERE t.tenant_id=? AND t.id=?`, tenantId, taskId);
}

function verifiedReplacementTask(task, tenantId) {
  const evidence = parseObject(task?.employee_web_snapshot);
  const contract = plainObject(evidence.outputContract) || {};
  const hardDelivery = plainObject(contract.hardDelivery) || {};
  const hardProvider = plainObject(hardDelivery.provider) || {};
  const hardUsage = plainObject(hardProvider.usage) || {};
  const provider = plainObject(evidence.providerAttempt) || {};
  const providerUsage = plainObject(provider.usage) || {};
  const leakage = plainObject(evidence.internalProfileLeakage);
  const billing = taskBillingEvidence(task, tenantId);
  const hardErrors = Array.isArray(hardDelivery.errors)
    ? hardDelivery.errors.map(String).filter(Boolean)
    : [];
  // Both the demo report-first fallback and the native Paihuo Markdown
  // delivery are persisted without parsedOutput.  Route both through the
  // same current-body validator; otherwise a valid native report is
  // incorrectly rechecked as a missing structured runtime output.
  const reportFirst = (
    (contract.qualityMode === 'report_first' && contract.structuredReportFirst === true)
    || contract.deliveryStyle === 'paihuo_markdown'
    || contract.qualityMode === 'paihuo_markdown'
  ) && contract.reportFirstMarkdown === true;
  const strictContract = contract.parsedOutput != null;
  const model = String(hardProvider.model || provider.model || '').trim();
  const dataMode = q.get(
    'SELECT data_mode FROM tenants WHERE id=?',
    tenantId,
  )?.data_mode || 'live';
  const currentValidation = reportFirst
    ? inspectStructuredReportFirstEvidence({
        dataMode,
        content: {
          body: task?.output_body,
          ai_mode: task?.output_ai_mode,
        },
        task,
        executionEvidence: task?.employee_web_snapshot,
      })
    : inspectRestaurantOutputAudit({
        employeeProfileVersion: task?.employee_profile_version,
        aiMode: task?.output_ai_mode,
        executionEvidence: task?.employee_web_snapshot,
        employeeIdx: task?.employee_idx,
        taskTitle: task?.title,
        taskRequirement: task?.requirement,
        outputBody: task?.output_body,
      });
  const valid = task?.status === '已完成'
    && Number(task.output_id) > 0
    && Number(task.canonical_output_id) === Number(task.output_id)
    && Number(task.output_creator_id) === Number(task.created_by)
    && String(task.output_ai_mode || '').trim().toLowerCase() === 'api'
    && Boolean(String(task.output_body || '').trim())
    && evidence.kind === 'restaurant_employee_execution_evidence'
    && String(provider.mode || '').trim().toLowerCase() === 'api'
    && Number(providerUsage.inputTokens) > 0
    && Number(providerUsage.outputTokens) > 0
    && contract.valid === true
    && (strictContract || reportFirst)
    && hardDelivery.valid === true
    && hardErrors.length === 0
    && String(hardProvider.mode || '').trim().toLowerCase() === 'api'
    && !blockedProviderModel(model)
    && Number(hardUsage.inputTokens) > 0
    && Number(hardUsage.outputTokens) > 0
    && leakage?.detected === false
    && billing?.state === 'settled'
    && Number(billing.chargedCredits) > 0
    && currentValidation?.valid === true;
  return {
    valid,
    reportFirst,
    contract,
    hardDelivery,
    billing,
    currentValidation,
    currentErrors: Array.isArray(currentValidation?.errors)
      ? currentValidation.errors
      : currentValidation?.error
        ? [currentValidation.error]
        : [],
    provider: {
      mode: String(hardProvider.mode || provider.mode || '').trim() || null,
      model: model || null,
      usage: {
        inputTokens: Number(hardUsage.inputTokens || 0),
        outputTokens: Number(hardUsage.outputTokens || 0),
      },
    },
  };
}

function archiveSupersededTaskBusinessLinks({
  tenantId,
  taskId,
  outputId,
}) {
  const artifacts = q.all(`SELECT id,kb_doc_id,file_url
    FROM generated_artifacts
    WHERE tenant_id=? AND source_type='agent_task' AND source_id=?`,
  tenantId, taskId);
  const artifactIds = artifacts.map((row) => Number(row.id)).filter(Boolean);
  const artifactUrls = artifacts.map((row) => String(row.file_url || '')).filter(Boolean);
  const kbRows = q.all(`SELECT id FROM kb_docs
    WHERE tenant_id=? AND (
      (source_type='content' AND source_id=?)
      ${artifactUrls.length
        ? `OR file_path IN (${artifactUrls.map(() => '?').join(',')})`
        : ''}
      ${artifacts.some((row) => Number(row.kb_doc_id) > 0)
        ? `OR id IN (${artifacts.filter((row) => Number(row.kb_doc_id) > 0).map(() => '?').join(',')})`
        : ''}
    )`,
  tenantId,
  outputId,
  ...artifactUrls,
  ...artifacts.map((row) => Number(row.kb_doc_id)).filter((id) => id > 0));
  const kbIds = [...new Set(kbRows.map((row) => Number(row.id)).filter(Boolean))];
  if (kbIds.length) {
    q.run(`UPDATE kb_docs SET enabled=0,updated_at=datetime('now','localtime')
      WHERE tenant_id=? AND id IN (${kbIds.map(() => '?').join(',')})`,
    tenantId, ...kbIds);
  }

  const assetClauses = [
    `(source_type='content' AND source_id=?)`,
    `(source_type='agent_task' AND source_id=?)`,
  ];
  const assetParams = [outputId, taskId];
  if (kbIds.length) {
    assetClauses.push(`(source_type='kb' AND source_id IN (${kbIds.map(() => '?').join(',')}))`);
    assetParams.push(...kbIds);
  }
  if (artifactIds.length) {
    assetClauses.push(`(source_type IN ('artifact','generated_artifact')
      AND source_id IN (${artifactIds.map(() => '?').join(',')}))`);
    assetParams.push(...artifactIds);
  }
  q.run(`UPDATE biz_assets SET status='已归档',updated_at=datetime('now','localtime')
    WHERE tenant_id=? AND (${assetClauses.join(' OR ')})`,
  tenantId, ...assetParams);
  q.run(`UPDATE generated_artifacts
    SET status='已取代',updated_at=datetime('now','localtime')
    WHERE tenant_id=? AND source_type='agent_task' AND source_id=?`,
  tenantId, taskId);
  return {
    artifactIds,
    kbDocIds: kbIds,
  };
}

/**
 * Create the narrow, append-only safety-revision edge. No task, content or file
 * body is rewritten. The edge and every business-disable write are committed in
 * one IMMEDIATE transaction so readers can never observe a supersession while
 * its old knowledge/assets remain active (or the reverse).
 */
export function createAgentTaskSupersession({
  tenantId = curTenant(),
  supersededTaskId,
  replacementTaskId,
  actor,
  reason = '',
} = {}) {
  const tid = Number(tenantId);
  const oldId = Number(supersededTaskId);
  const nextId = Number(replacementTaskId);
  if (!Number.isSafeInteger(tid) || tid <= 0)
    throw supersessionError(400, 'SUPERSESSION_TENANT_INVALID', '租户无效');
  if (!Number.isSafeInteger(oldId) || oldId <= 0
    || !Number.isSafeInteger(nextId) || nextId <= 0) {
    throw supersessionError(400, 'SUPERSESSION_TASK_INVALID', '安全修订任务ID无效');
  }
  if (oldId === nextId) {
    throw supersessionError(400, 'SUPERSESSION_SELF_REFERENCE', '任务不能取代自身');
  }

  const existing = loadAgentTaskSupersession(oldId, { tenantId: tid });
  if (existing) {
    if (existing.taskId !== nextId) {
      throw supersessionError(
        409,
        'SUPERSESSION_ALREADY_REPLACED',
        `旧任务已由任务 #${existing.taskId} 取代，不能改写只追加审计关系`,
      );
    }
    return { ...existing, created: false };
  }

  const normalizedReason = String(reason || '').trim();
  if (normalizedReason.length < 8 || normalizedReason.length > 500) {
    throw supersessionError(
      400,
      'SUPERSESSION_REASON_INVALID',
      '请用8到500字说明旧任务被安全修订版取代的原因',
    );
  }
  if (!actor?.id) {
    throw supersessionError(403, 'SUPERSESSION_ACTOR_REQUIRED', '缺少安全修订操作人');
  }
  if (String(actor.role || '') !== 'platform_super'
    && Number(actor.tenant_id) !== tid) {
    throw supersessionError(403, 'SUPERSESSION_TENANT_FORBIDDEN', '无权操作其他租户任务');
  }
  let began = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    began = true;
    const oldTask = canonicalSupersessionTask(oldId, tid);
    const replacement = canonicalSupersessionTask(nextId, tid);
    if (!oldTask || !replacement) {
      throw supersessionError(404, 'SUPERSESSION_TASK_NOT_FOUND', '旧任务或安全修订任务不存在于当前租户');
    }
    if (!canAccessOwner(actor, oldTask.created_by)) {
      throw supersessionError(403, 'SUPERSESSION_OWNER_FORBIDDEN', '无权取代该负责人的任务');
    }
    if (Number(replacement.created_by) !== Number(oldTask.created_by)) {
      throw supersessionError(409, 'SUPERSESSION_OWNER_MISMATCH', '安全修订任务必须与旧任务属于同一负责人');
    }
    if (!Number(oldTask.specialist_id)
      || Number(replacement.specialist_id) !== Number(oldTask.specialist_id)
      || Number(replacement.employee_idx) !== Number(oldTask.employee_idx)) {
      throw supersessionError(409, 'SUPERSESSION_EMPLOYEE_MISMATCH', '安全修订任务必须由同一数字员工生成');
    }
    if (nextId <= oldId) {
      throw supersessionError(409, 'SUPERSESSION_NOT_NEWER', '安全修订任务必须晚于旧任务生成');
    }
    if (!Number(oldTask.output_id)) {
      throw supersessionError(409, 'SUPERSESSION_OLD_OUTPUT_MISSING', '旧任务没有可被取代的业务产物');
    }
    if (!Number(replacement.output_id)) {
      throw supersessionError(
        409,
        'SUPERSESSION_REPLACEMENT_OUTPUT_MISSING',
        '安全修订任务尚未形成新的业务产物',
      );
    }
    if (Number(replacement.output_id) === Number(oldTask.output_id)) {
      throw supersessionError(
        409,
        'SUPERSESSION_OUTPUT_REUSED',
        '安全修订任务必须形成新的业务产物，不能复用旧任务正文',
      );
    }
    if (loadAgentTaskSupersession(nextId, { tenantId: tid })) {
      throw supersessionError(409, 'SUPERSESSION_REPLACEMENT_STALE', '指定的安全修订任务本身已被后续版本取代');
    }
    const validation = verifiedReplacementTask(replacement, tid);
    if (replacement.status !== '已完成') {
      throw supersessionError(409, 'SUPERSESSION_REPLACEMENT_INCOMPLETE', '安全修订任务尚未完成');
    }
    if (String(replacement.output_ai_mode || '').trim().toLowerCase() !== 'api') {
      throw supersessionError(409, 'SUPERSESSION_REPLACEMENT_NOT_API', '安全修订任务必须来自真实API执行');
    }
    if (validation.contract?.valid !== true) {
      throw supersessionError(409, 'SUPERSESSION_CONTRACT_INVALID', '安全修订任务的岗位契约未通过');
    }
    if (validation.hardDelivery?.valid !== true) {
      throw supersessionError(409, 'SUPERSESSION_HARD_DELIVERY_INVALID', '安全修订任务的hardDelivery硬交付未通过');
    }
    if (validation.billing?.state !== 'settled'
      || Number(validation.billing?.chargedCredits) <= 0) {
      throw supersessionError(409, 'SUPERSESSION_BILLING_INVALID', '安全修订任务账务尚未权威结算');
    }
    if (validation.currentValidation?.valid !== true) {
      throw supersessionError(
        409,
        'SUPERSESSION_CURRENT_OUTPUT_INVALID',
        `安全修订任务未通过当前正文重新校验：${validation.currentErrors[0] || '当前岗位方法、算术或交付证据不完整'}`,
      );
    }
    if (!validation.valid) {
      throw supersessionError(409, 'SUPERSESSION_REPLACEMENT_INVALID', '安全修订任务未通过真实API、契约、硬交付与账务联合验收');
    }

    const invalidated = archiveSupersededTaskBusinessLinks({
      tenantId: tid,
      taskId: oldId,
      outputId: Number(oldTask.output_id),
    });
    const validationSnapshot = {
      schemaVersion: 'nanowork.agent-task-supersession-validation/1',
      employeeIdx: Number(replacement.employee_idx),
      ownerId: Number(replacement.created_by),
      status: replacement.status,
      aiMode: replacement.output_ai_mode,
      contract: {
        valid: true,
        qualityMode: validation.contract.qualityMode || 'strict',
        contractId: validation.contract.contractId || null,
        schemaVersion: validation.contract.schemaVersion || null,
      },
      hardDelivery: {
        valid: true,
        provider: validation.provider,
      },
      billing: {
        state: validation.billing.state,
        chargedCredits: Number(validation.billing.chargedCredits),
        evidenceSource: validation.billing.evidenceSource || null,
        evidenceSourceId: validation.billing.evidenceSourceId || null,
      },
      invalidated,
    };
    const inserted = q.run(`INSERT INTO agent_task_supersessions(
      tenant_id,superseded_task_id,replacement_task_id,superseded_output_id,
      replacement_output_id,created_by,reason,validation_snapshot
    ) VALUES(?,?,?,?,?,?,?,?)`,
    tid,
    oldId,
    nextId,
    Number(oldTask.output_id),
    Number(replacement.output_id),
    Number(actor.id),
    normalizedReason,
    JSON.stringify(validationSnapshot));
    db.exec('COMMIT');
    began = false;
    return {
      ...loadAgentTaskSupersession(oldId, { tenantId: tid }),
      id: Number(inserted.lastInsertRowid),
      created: true,
    };
  } catch (error) {
    if (began) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* SQLite may already have closed the failed transaction. */
      }
    }
    throw error;
  }
}

function contentWithCanonicalTaskBilling(content, task, tenantId) {
  if (!content || !task) return content;
  const snapshot = parseObject(content.snapshot_json);
  // 数字员工任务的账本是唯一正向权威；contents.snapshot_json 只是展示快照，
  // 不得用自报 settled 覆盖缺失档案版本、错用户、错 feature 或重复 hold。
  const billing = taskBillingEvidence(task, tenantId);
  if (!billing) return content;
  return {
    ...content,
    snapshot_json: {
      ...snapshot,
      billing,
    },
  };
}

export function loadContentDeliveryState(contentOrId, {
  tenantId = curTenant(),
  requireFlowStatus = true,
  requireBilling = true,
} = {}) {
  const canonical = canonicalContent(contentOrId, tenantId);
  if (!canonical) return inspectContentDeliveryState(null, { requireFlowStatus, requireBilling });
  const supersededBy = loadContentSupersession(canonical.id, tenantId);
  if (supersededBy) {
    return {
      eligible: false,
      state: 'blocked',
      code: 'DELIVERY_SUPERSEDED',
      reason: `该产物已由安全修订任务 #${supersededBy.taskId} 取代，旧正文仅保留审计，不可继续用于业务`,
      nextAction: `查看并使用安全修订任务 #${supersededBy.taskId} 的报告与交付文件`,
      status: String(canonical.status || '未知'),
      provenance: null,
      contract: null,
      billing: null,
      approval: null,
      supersededBy,
    };
  }
  const sourceEnrichedContent = contentWithCanonicalSourceBilling(canonical, tenantId);
  const taskRows = q.all(`SELECT t.id,t.tenant_id,t.title,t.type,t.requirement,t.status,t.employee_profile_version,t.employee_web_snapshot,
      t.created_by,m.name marshal_name,s.employee_idx,c.creator_id output_creator_id
    FROM agent_tasks t
    JOIN marshals m ON m.id=t.marshal_id
    LEFT JOIN specialists s ON s.id=t.specialist_id
    LEFT JOIN contents c ON c.tenant_id=t.tenant_id AND c.id=t.output_id
    WHERE t.tenant_id=? AND t.output_id=?
    ORDER BY t.id DESC LIMIT 2`, tenantId, sourceEnrichedContent.id);
  const task = taskRows[0] || null;
  const content = taskRows.length === 1
    ? contentWithCanonicalTaskBilling(sourceEnrichedContent, task, tenantId)
    : taskRows.length > 1
      ? {
          ...sourceEnrichedContent,
          snapshot_json: {
            ...parseObject(sourceEnrichedContent.snapshot_json),
            billing: {
              state: 'pending_reconciliation',
              pendingReconciliation: true,
              evidenceSource: 'agent_task_duplicate_linkage',
            },
          },
        }
      : sourceEnrichedContent;
  const approvals = q.all(`SELECT id,status,created_at,decided_at
    FROM approvals
    WHERE tenant_id=? AND target_type='content' AND target_id=?
    ORDER BY id DESC`, tenantId, content.id);
  return inspectContentDeliveryState(content, {
    approvals,
    task,
    requireFlowStatus,
    requireBilling,
    // Only the canonical row loaded above may use a persisted automatic
    // adoption route.  The pure inspector keeps this false by default so a
    // caller-supplied object cannot self-assert approval bypass.
    allowPolicyAutoAdopt: true,
    dataMode: q.get('SELECT data_mode FROM tenants WHERE id=?', tenantId)?.data_mode || 'live',
  });
}

function deliveryError(state, action) {
  const error = new Error(`${action}被阻止：${state.reason}`);
  error.name = 'ContentDeliveryStateError';
  error.code = state.code;
  error.status = 409;
  error.deliveryState = state;
  return error;
}

export function assertContentDeliverable(contentOrId, {
  tenantId = curTenant(),
  action = '使用内容',
} = {}) {
  const state = loadContentDeliveryState(contentOrId, { tenantId, requireFlowStatus: true });
  if (!state.eligible) throw deliveryError(state, action);
  return state;
}

/**
 * Read-only adoption preflight shared by approval queues and decision commands.
 * Review-pending is intentionally adoptable: the decision itself resolves that
 * state. Missing body, untrusted provenance and missing/invalid contracts are not.
 */
export function loadContentAdoptionAvailability(contentOrId, {
  tenantId = curTenant(),
  requireBilling = true,
} = {}) {
  const state = loadContentDeliveryState(contentOrId, {
    tenantId,
    requireFlowStatus: false,
    requireBilling,
  });
  const blocked = CONTENT_ADOPTION_BLOCKING_CODE_SET.has(state.code);
  const qualityRejectedWithoutLedgerHold = ['DELIVERY_BILLING_MISSING', 'DELIVERY_BILLING_UNSETTLED']
    .includes(state.code)
    && state.contract?.valid === false
    && state.billing?.evidenceSource === 'agent_task_credit_hold_missing';
  const billingBlocksRejection = ['DELIVERY_BILLING_MISSING', 'DELIVERY_BILLING_UNSETTLED']
    .includes(state.code)
    && !qualityRejectedWithoutLedgerHold;
  const superseded = state.code === 'DELIVERY_SUPERSEDED';
  return {
    canAdopt: !blocked,
    reason: blocked ? state.reason : '',
    // 无效契约且根本没有预授权记录时，允许“驳回清理”。
    // 一旦存在 held、错绑定、重复账本或释放歧义，采纳和驳回都必须先对账。
    canReject: !superseded && !billingBlocksRejection,
    rejectReason: superseded || billingBlocksRejection ? state.reason : '',
    state,
  };
}

/**
 * Validate the business artifact before settlement. Billing is deliberately
 * deferred here because the caller still owns a held authorization; every
 * public delivery/adoption path continues to require a settled billing state.
 */
export function assertContentPreSettlementQuality(contentOrId, {
  tenantId = curTenant(),
  action = '完成内容交付',
} = {}) {
  const availability = loadContentAdoptionAvailability(contentOrId, {
    tenantId,
    requireBilling: false,
  });
  if (!availability.canAdopt) throw deliveryError(availability.state, action);
  return availability.state;
}

/** Validate provenance/body/contract before an approval can adopt the row. */
export function assertContentAdoptable(contentOrId, {
  tenantId = curTenant(),
  action = '采纳内容',
} = {}) {
  const availability = loadContentAdoptionAvailability(contentOrId, { tenantId });
  if (!availability.canAdopt) throw deliveryError(availability.state, action);
  return availability.state;
}

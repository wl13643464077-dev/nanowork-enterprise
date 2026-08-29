import crypto from 'node:crypto';
import { Router } from 'express';
import { curTenant, getTenant, q } from '../db.js';
import { userScopeClause } from '../engines/access.js';
import { daysAgo, safeJsonParse, today } from '../util.js';
import { contentEmployeeByIdx } from '../catalog/content-crew.js';
import { validateCanonicalEmployeeProfile } from '../engines/canonical-employee-profile.js';
import { employeeModelSettlementBindingValid } from '../engines/credits.js';
import {
  normalizeInternalProfileLeakage,
  projectInternalProfileOutput,
} from '../engines/internal-profile-leakage.js';
import {
  contentOutputReviewAccess,
  inspectRestaurantOutputAudit,
} from '../engines/restaurant-output-review.js';
import {
  contentEmployeeRunReviewAccess,
  EMPLOYEE_MANAGEMENT_REVIEW_ROLES,
} from '../engines/content-approval-policy.js';
import {
  BUSINESS_DELIVERY_LABELS,
  CONTENT_ADOPTION_BLOCKING_CODES,
  isBlockedDeliveryAiMode,
  loadAgentTaskSupersession,
  loadContentEmployeeRunAuthority,
  loadContentDeliveryState,
} from '../engines/delivery-state.js';
import { augmentMediaJob } from './media-review.js';

const r = Router();

const SOURCE_LABELS = {
  task: '数字员工任务',
  tool: '经营工具',
  content: '内容生产仓',
  content_solo: '内容员工单独派活',
};
const DOMAIN_LABELS = {
  restaurant: '餐饮数字员工',
  tool: '餐饮经营工具',
  content: 'Paihuo内容生产部',
};

const DIMENSIONS = new Set(['domain', 'group', 'employee', 'source', 'status']);
const SOURCES = new Set(['all', 'task', 'tool', 'content', 'content_solo']);
const DOMAINS = new Set(['all', 'restaurant', 'tool', 'content']);
const INTERNAL_PROFILE_ROLES = new Set(['boss', 'admin', 'platform_super']);
const BILLING_BLOCKING_CODES = new Set([
  'DELIVERY_BILLING_MISSING',
  'DELIVERY_BILLING_UNSETTLED',
]);
const QUALITY_BLOCKING_CODES = new Set(
  CONTENT_ADOPTION_BLOCKING_CODES.filter(code => !BILLING_BLOCKING_CODES.has(code)),
);
const PUBLIC_TOOL_PROVENANCE_KEYS = Object.freeze([
  'mode',
  'sourceSystem',
  'engine',
  'generatedAt',
  'confidence',
  'completionState',
  'model',
  'usage',
  'contract',
  'billing',
  'persisted',
]);
function canViewInternalProfile(user) {
  return INTERNAL_PROFILE_ROLES.has(user?.role);
}

function canonicalEmployeeSnapshot(value, taskId) {
  if (value == null || value === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`任务${taskId}的统一员工对象快照损坏，拒绝静默降级`);
  }
  return validateCanonicalEmployeeProfile(parsed);
}

function pickDefined(source, keys) {
  return Object.fromEntries(keys
    .filter(key => source?.[key] !== undefined)
    .map(key => [key, source[key]]));
}

function publicToolProvenance(value, user) {
  const provenance = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (canViewInternalProfile(user)) return provenance;
  return pickDefined(provenance, PUBLIC_TOOL_PROVENANCE_KEYS);
}

function redactedExecution() {
  return {
    internalProfileApplied: true,
    redacted: true,
  };
}

function fail(res, message) {
  res.status(400).json({ error: message });
  return null;
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function parseQuery(req, res) {
  const start = String(req.query.start || daysAgo(29));
  const end = String(req.query.end || today());
  const group = String(req.query.group || '').trim();
  const employee = String(req.query.employee || '').trim();
  const domain = String(req.query.domain || 'all').trim();
  const source = String(req.query.source || 'all').trim();
  const status = String(req.query.status || '').trim();
  const dimension = String(req.query.dimension || 'employee').trim();
  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(5, Number.parseInt(String(req.query.pageSize || '20'), 10) || 20));

  if (!isIsoDate(start) || !isIsoDate(end) || start > end) {
    return fail(res, '时间范围不正确');
  }
  if (group.length > 80 || employee.length > 100 || status.length > 40) {
    return fail(res, '筛选条件过长');
  }
  if (!SOURCES.has(source)) return fail(res, '来源筛选不正确');
  if (!DOMAINS.has(domain)) return fail(res, '能力域筛选不正确');
  if (!DIMENSIONS.has(dimension)) return fail(res, '透视维度不正确');
  return { start, end, group, employee, domain, source, status, dimension, page, pageSize };
}

const STATUS = Object.freeze({
  awaitingAssignment: '待派活',
  generating: '生成中',
  generationFailed: '生成失败（可重跑）',
  qualityFailed: '质检失败（可重跑）',
  qualityPassed: '质检通过，待发布决策',
  reconciliationPending: '待账务对账',
  reviewPending: '待审核',
  reviewRejected: '审核未通过（可重跑）',
  remediated: '历史未通过（后续已修复）',
  superseded: '已由安全修订版取代',
  approved: '已通过',
  published: '已发布',
});
const OUTPUT_REVIEW_ROLES = new Set(EMPLOYEE_MANAGEMENT_REVIEW_ROLES);

function displayStatus(status) {
  const labels = {
    [STATUS.generationFailed]: BUSINESS_DELIVERY_LABELS.executionFailed,
    [STATUS.qualityFailed]: BUSINESS_DELIVERY_LABELS.qualityFailed,
    [STATUS.qualityPassed]: BUSINESS_DELIVERY_LABELS.reviewReady,
    [STATUS.reconciliationPending]: BUSINESS_DELIVERY_LABELS.businessBlocked,
    [STATUS.reviewPending]: BUSINESS_DELIVERY_LABELS.reviewPending,
    [STATUS.reviewRejected]: BUSINESS_DELIVERY_LABELS.reviewRejected,
    [STATUS.remediated]: BUSINESS_DELIVERY_LABELS.remediated,
    [STATUS.superseded]: BUSINESS_DELIVERY_LABELS.superseded,
    [STATUS.approved]: BUSINESS_DELIVERY_LABELS.adopted,
  };
  return labels[status] || status || '状态未知';
}

function publicNextAction(status, user, record = null) {
  if (status === STATUS.remediated) {
    return '查看后续已采纳运行；原记录仅供复盘，无需重跑';
  }
  if (status === STATUS.superseded) {
    return record?.supersededBy?.taskId
      ? `查看并使用安全修订任务 #${record.supersededBy.taskId} 的报告与交付文件`
      : '查看并使用安全修订版报告与交付文件';
  }
  if (status === STATUS.generationFailed) {
    return '先查看执行失败原因，再检查输入、额度和模型通道后重新派活';
  }
  if (status === STATUS.qualityFailed) {
    return '查看岗位质检错误，补充或修正材料后重新派活';
  }
  if (status === STATUS.reviewRejected) {
    return '查看人工审阅退回意见，按意见返工后重新派活';
  }
  if (status === STATUS.reviewPending) {
    const canReview = typeof record?.canReview === 'boolean'
      ? record.canReview
      : OUTPUT_REVIEW_ROLES.has(user?.role);
    return canReview
      ? '前往对应工作台完成人工审阅'
      : '等待老板或有审阅权限的管理人员处理';
  }
  if (status === STATUS.qualityPassed) return '提交人工审阅；被采纳前仅供内部预览';
  if (status === STATUS.reconciliationPending) return '先完成积分结算或人工对账，再进入验收与业务采用';
  if ([STATUS.approved, STATUS.published].includes(status)) return '查看已采纳的业务结果';
  if (status === STATUS.awaitingAssignment) return '选择具体数字员工继续派活';
  return '等待生成完成';
}

function withPublicState(record, user) {
  return {
    ...record,
    displayStatus: displayStatus(record.status),
    nextAction: publicNextAction(record.status, user, record),
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsedSnapshot(value) {
  return isRecord(value) ? value : safeJsonParse(value, {});
}

function snapshotContractValid(value) {
  const snapshot = parsedSnapshot(value);
  if (isRecord(snapshot.contract) && typeof snapshot.contract.valid === 'boolean') {
    return snapshot.contract.valid;
  }
  return typeof snapshot.contractValid === 'boolean' ? snapshot.contractValid : null;
}

function snapshotLeakageDetected(value) {
  const snapshot = parsedSnapshot(value);
  return normalizeInternalProfileLeakage(snapshot.internalProfileLeakage)?.detected === true;
}

function isCompleted(status) {
  return [STATUS.approved, STATUS.published].includes(String(status || ''));
}

function isFailed(status) {
  return [STATUS.generationFailed, STATUS.qualityFailed, STATUS.reviewRejected]
    .includes(String(status || ''));
}

function isRemediated(status) {
  return String(status || '') === STATUS.remediated;
}

function isSuperseded(status) {
  return String(status || '') === STATUS.superseded;
}

function normalizedRunTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .toLocaleLowerCase('zh-CN');
}

function normalizedTaskType(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, '')
    .toLocaleLowerCase('zh-CN');
}

function normalizedTaskRequirement(value) {
  return String(value || '')
    .normalize('NFKC')
    // 真实逐岗矩阵每次运行只替换这一条技术性 nonce；它不是业务需求的一部分。
    // 普通业务文字、数字和其他唯一标识均原样参与指纹，避免“同题不同活”互相消除失败。
    .replace(/^\s*任务唯一标识：real-(?:restaurant|content)-\d+-[0-9a-f]{8}-[0-9a-f-]{27}\s*$/gimu, '')
    .trim()
    .replace(/\s+/gu, '')
    .toLocaleLowerCase('zh-CN');
}

function remediationContext(row, source) {
  if (source === 'content_solo') {
    const snapshot = parsedSnapshot(row?.snapshot_json);
    const dispatch = isRecord(snapshot.dispatch) ? snapshot.dispatch : {};
    return {
      industry: dispatch.industry ?? null,
      feedback: dispatch.feedback ?? null,
      dueAt: dispatch.dueAt ?? row?.due_at ?? null,
      imageEvidence: dispatch.imageEvidence ?? null,
      attachments: dispatch.attachments ?? null,
    };
  }
  if (source === 'task') {
    const input = safeJsonParse(row?.employee_input_snapshot, null);
    const config = safeJsonParse(row?.employee_config_snapshot, null);
    return {
      input: isRecord(input) && Object.keys(input).length === 0 ? null : input,
      config: isRecord(config) && Object.keys(config).length === 0 ? null : config,
      dueAt: row?.due_at ?? null,
    };
  }
  return null;
}

function remediationKey(employeeIdx, title, type, requirement, context = null) {
  const idx = Number(employeeIdx);
  const normalizedTitle = normalizedRunTitle(title);
  const normalizedType = normalizedTaskType(type);
  const normalizedRequirement = normalizedTaskRequirement(requirement);
  if (!Number.isSafeInteger(idx) || idx < 0 || !normalizedTitle
    || !normalizedType || !normalizedRequirement) return '';
  const contextHash = sha256(JSON.stringify(canonicalJsonValue(context)));
  return `${idx}\u0000${normalizedTitle}\u0000${normalizedType}\u0000${sha256(normalizedRequirement)}\u0000${contextHash}`;
}

function latestCandidateIndex(rows, source) {
  const index = new Map();
  for (const row of rows) {
    const key = remediationKey(row.employee_idx, row.title, row.type, row.requirement,
      remediationContext(row, source));
    if (!key) continue;
    const current = index.get(key);
    if (!current || Number(row.id) > Number(current.id)) index.set(key, row);
  }
  return index;
}

function remediationFor(row, originalStatus, candidateIndex, source) {
  if (!isFailed(originalStatus)) return null;
  const candidate = candidateIndex.get(remediationKey(
    row.employee_idx,
    row.title,
    row.type,
    row.requirement,
    remediationContext(row, source),
  ));
  if (!candidate || Number(candidate.id) <= Number(row.id)) return null;
  return {
    status: STATUS.remediated,
    originalStatus,
    remediated: true,
    remediatedByRunId: Number(candidate.id),
    remediatedByRef: `${source}:${candidate.id}`,
  };
}

function normalizedToolKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedToolTaskTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, '')
    // 真实矩阵会给同一个稳定验收任务追加8位十六进制运行nonce。
    // 只去掉这一种明确后缀；普通业务标题保持逐字匹配。
    .replace(/(真实验收)-[0-9a-f]{8}$/iu, '$1')
    .toLocaleLowerCase('zh-CN');
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonicalJsonValue(value[key])]));
}

function toolInputFingerprint(value) {
  return sha256(JSON.stringify(canonicalJsonValue(safeJsonParse(value, {}))));
}

function toolRemediationKey(row) {
  const key = normalizedToolKey(row?.tool_key);
  const title = normalizedToolTaskTitle(row?.title);
  if (!key || !title) return '';
  return `${key}\u0000${title}\u0000${toolInputFingerprint(row?.input_json)}`;
}

function latestToolCandidateIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const key = toolRemediationKey(row);
    if (!key) continue;
    const current = index.get(key);
    if (!current || Number(row.id) > Number(current.id)) index.set(key, row);
  }
  return index;
}

function toolRemediationFor(row, originalState, candidateIndex) {
  if (!isFailed(originalState?.status)) return null;
  const candidate = candidateIndex.get(toolRemediationKey(row));
  if (!candidate || Number(candidate.id) <= Number(row.id)) return null;
  const originalFailureReasons = Array.isArray(originalState.failureReasons)
    ? originalState.failureReasons
    : [];
  return {
    status: STATUS.remediated,
    originalStatus: originalState.status,
    originalFailureReasons,
    remediated: true,
    remediatedByRunId: Number(candidate.id),
    remediatedByRef: `tool:${candidate.id}`,
  };
}

function restaurantTaskStatus(row) {
  const rawStatus = String(row.status || '');
  if (rawStatus !== '生成中' && restaurantBillingConflict(row)) {
    return STATUS.reconciliationPending;
  }
  if (rawStatus === '失败') {
    const evidence = parsedSnapshot(row.employee_web_snapshot);
    const qualityFailed = evidence?.outputContract?.valid === false
      || normalizeInternalProfileLeakage(evidence?.internalProfileLeakage)?.detected === true;
    return qualityFailed ? STATUS.qualityFailed : STATUS.generationFailed;
  }
  if (rawStatus === '执行中' && !row.employee_profile_version) return STATUS.awaitingAssignment;

  if (row.output_id) {
    const evidence = parsedSnapshot(row.employee_web_snapshot);
    const audit = inspectRestaurantOutputAudit({
      employeeProfileVersion: row.employee_profile_version,
      aiMode: row.ai_mode,
      executionEvidence: row.employee_web_snapshot,
      employeeIdx: row.employee_idx,
      taskTitle: row.title,
      taskRequirement: row.requirement,
      outputBody: row.output_body,
    });
    if (row.ai_mode === 'template' || (audit.applicable && !audit.valid)
      || !isRecord(evidence.internalProfileLeakage)
      || snapshotLeakageDetected(evidence)) {
      return STATUS.qualityFailed;
    }
    if (!strictRestaurantBilling(row)) return STATUS.qualityFailed;
  } else if (rawStatus === '已完成' || rawStatus === '待审阅') {
    return STATUS.qualityFailed;
  }

  if (['已驳回'].includes(rawStatus)
    || row.approval_status === '已驳回'
    || row.output_status === '已驳回') return STATUS.reviewRejected;
  if (row.output_status === '已发布' && row.approval_status === '已通过') {
    return STATUS.published;
  }
  if (row.approval_status === '已通过' && ['可使用', '已发布'].includes(row.output_status)) {
    return row.output_status === '已发布' ? STATUS.published : STATUS.approved;
  }
  if (rawStatus === '待审阅' || rawStatus === '已完成'
    || row.output_status === '待审核' || row.approval_status === '待审核') {
    return STATUS.reviewPending;
  }
  return STATUS.generating;
}

function toolRunState(row, provenance) {
  const runStatus = String(row.status || '').trim().toLowerCase();
  const mode = String(provenance.mode || 'unknown').trim().toLowerCase();
  const completionState = String(provenance.completionState || '').trim().toLowerCase();
  const contract = isRecord(provenance.contract) ? provenance.contract : {};
  const contractStatus = String(contract.status || '').trim().toLowerCase();
  const billing = isRecord(provenance.billing) ? provenance.billing : {};
  const billingState = String(billing.state || 'unsettled').trim().toLowerCase();
  const hasOutput = Boolean(row.has_output ?? String(row.result_md || '').trim());
  const internalProfileLeakage = snapshotLeakageDetected(provenance);
  const failureReasons = [];
  if (runStatus === 'failed') failureReasons.push('运行终态为 failed');
  if (mode !== 'api') failureReasons.push(`未形成真实 API 产物（mode=${mode || 'unknown'}）`);
  if (completionState !== 'completed') {
    failureReasons.push(`生成未到 completed（completionState=${completionState || '缺失'}）`);
  }
  if (!isRecord(provenance.contract)) {
    failureReasons.push('缺少当前运行的交付契约快照（历史运行）');
  } else if (contract.valid !== true || contractStatus !== 'valid') {
    failureReasons.push('交付契约未通过');
  }
  for (const error of Array.isArray(contract.errors) ? contract.errors : []) {
    const message = String(error || '').trim();
    if (message) failureReasons.push(`交付契约：${message}`);
  }
  if (provenance.persisted !== true) {
    failureReasons.push('缺少当前运行的产物落库确认（历史运行）');
  }
  if (!isRecord(provenance.internalProfileLeakage)) {
    failureReasons.push('缺少当前运行的内部档案泄漏审计快照（历史运行）');
  } else if (internalProfileLeakage) {
    failureReasons.push('命中内部档案泄漏风险');
  }
  if (!hasOutput) failureReasons.push('工具产物正文为空');
  if (billingState !== 'settled' || billing.pendingReconciliation === true) {
    failureReasons.push(`账务未完成结算（billing=${billingState || 'unsettled'}）`);
  }

  // 与 /toolbox/runs 的权威可用门保持同一口径：真实 API、
  // completed、有效契约、已落库且无内部档案泄漏。聚合页不得
  // 因 result_md 非空就把底稿、对账中记录或质检失败记录投影为已通过。
  const qualityValid = runStatus === 'done'
    && mode === 'api'
    && completionState === 'completed'
    && contract.valid === true
    && contractStatus === 'valid'
    && provenance.persisted === true
    && !internalProfileLeakage
    && hasOutput;
  const billingSettled = strictToolSuccess(row);
  if (billingSettled) {
    return { status: STATUS.approved, verifiedOutput: true };
  }

  const needsReconciliation = runStatus !== 'running' && toolBillingPending(row, provenance);
  if (needsReconciliation) {
    return { status: STATUS.reconciliationPending, verifiedOutput: false };
  }
  if (runStatus === 'running') {
    return { status: STATUS.generating, verifiedOutput: false };
  }

  const qualityFailure = runStatus === 'done'
    || isBlockedDeliveryAiMode(mode)
    || ['draft', 'template_only', 'quality_failed'].includes(completionState)
    || internalProfileLeakage
    || contract.valid === false
    || (contractStatus && contractStatus !== 'valid');
  if (qualityFailure) {
    return {
      status: STATUS.qualityFailed,
      verifiedOutput: false,
      failureReasons: [...new Set(failureReasons)],
    };
  }
  return {
    status: runStatus === 'failed' ? STATUS.generationFailed : STATUS.generating,
    verifiedOutput: false,
    ...(runStatus === 'failed' ? {
      failureReasons: [...new Set(failureReasons.length
        ? failureReasons
        : ['运行失败，未形成可验证交付'])],
    } : {}),
  };
}

function contentRunState(row) {
  const rawStatus = String(row.status || '');
  const snapshot = parsedSnapshot(row.snapshot_json);
  const contractValid = snapshotContractValid(snapshot);
  const authority = loadContentEmployeeRunAuthority(row.id, { tenantId: curTenant() });
  if (rawStatus !== '生成中' && authority.pendingReconciliation) {
    return { status: STATUS.reconciliationPending, verifiedOutput: false };
  }
  if (rawStatus === '失败' || row.ai_mode === 'failed') {
    const qualityFailed = contractValid === false || snapshotLeakageDetected(snapshot);
    return {
      status: qualityFailed ? STATUS.qualityFailed : STATUS.generationFailed,
      verifiedOutput: false,
    };
  }
  if (rawStatus === '生成中') return { status: STATUS.generating, verifiedOutput: false };
  const verifiedOutput = authority.verified;
  if (!verifiedOutput) return { status: STATUS.qualityFailed, verifiedOutput: false };
  if (rawStatus === '已驳回') return { status: STATUS.reviewRejected, verifiedOutput: true };
  if (rawStatus === '已完成') {
    return snapshot.review?.decision === 'adopt'
      ? { status: STATUS.approved, verifiedOutput: true }
      : { status: STATUS.reviewPending, verifiedOutput: true };
  }
  return { status: STATUS.reviewPending, verifiedOutput: true };
}

function storedContentState(row) {
  const delivery = loadContentDeliveryState(row.id, { tenantId: curTenant() });
  if (BILLING_BLOCKING_CODES.has(delivery.code)) {
    return { status: STATUS.reconciliationPending, verifiedOutput: false };
  }
  if (QUALITY_BLOCKING_CODES.has(delivery.code)) {
    return { status: STATUS.qualityFailed, verifiedOutput: false };
  }
  if (row.status === '已驳回' || delivery.code === 'DELIVERY_APPROVAL_NOT_PASSED') {
    return { status: STATUS.reviewRejected, verifiedOutput: true };
  }
  if (delivery.eligible && row.status === '已发布') {
    return { status: STATUS.published, verifiedOutput: true };
  }
  if (delivery.eligible && row.status === '可使用') {
    return {
      status: row.approval_status === '已通过' ? STATUS.approved : STATUS.qualityPassed,
      verifiedOutput: true,
    };
  }
  return { status: STATUS.reviewPending, verifiedOutput: true };
}

function storedContentEvidence(state) {
  if (state.status === STATUS.reconciliationPending) return '待账务对账内容记录';
  return state.verifiedOutput ? '质检合格内容产出' : '质检失败记录';
}

function mediaRecordState(row, user) {
  const media = augmentMediaJob(row, user);
  if (String(row.status || '') === '失败') {
    return { media, status: STATUS.generationFailed, verifiedOutput: false };
  }
  if (!media.technicalSuccess) {
    return { media, status: STATUS.generating, verifiedOutput: false };
  }
  const billingReady = media.billing?.state === 'settled'
    || (media.billing?.state === 'not_required'
      && media.billing?.exempt === true
      && media.billing?.authoritative === true);
  if (!billingReady) {
    return { media, status: STATUS.reconciliationPending, verifiedOutput: false };
  }
  if (media.businessUsable) {
    return { media, status: STATUS.approved, verifiedOutput: true };
  }
  return { media, status: STATUS.reviewPending, verifiedOutput: true };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0;
}

function isBlockedProviderModel(value) {
  const model = String(value || '').trim().toLowerCase();
  return !model
    || /(?:^|[_-])(template|fallback|failed|error|mock|demo|degraded|unknown|inherit)(?:$|[_-])/iu.test(model);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function billingPending(row, snapshotBilling = null) {
  const billing = isRecord(snapshotBilling) ? snapshotBilling : {};
  const state = String(billing.state || '').trim().toLowerCase();
  return Number(row?.billing_held_count) > 0
    || billing.pendingReconciliation === true
    || ['held', 'unsettled', 'pending_reconciliation', 'pending_settlement', 'pending_release', 'ambiguous']
      .includes(state);
}

function strictSettledLedger(row) {
  const settledCredits = Number(row?.settled_credits);
  const ledgerCredits = Number(row?.ledger_credits);
  return Number(row?.billing_record_count) === 1
    && positiveInteger(row?.ledger_hold_id)
    && String(row?.billing_status || '').trim().toLowerCase() === 'settled'
    && positiveInteger(settledCredits)
    && positiveInteger(ledgerCredits)
    && settledCredits === ledgerCredits
    && Number(row?.billing_user_id) === Number(row?.created_by)
    && Number(row?.log_user_id) === Number(row?.created_by)
    && String(row?.ledger_ai_mode || '').trim().toLowerCase() === 'api'
    && !isBlockedProviderModel(row?.ledger_model)
    && positiveInteger(row?.input_tokens)
    && positiveInteger(row?.output_tokens);
}

function strictReleasedLedger(row) {
  return Number(row?.billing_record_count) === 1
    && positiveInteger(row?.ledger_hold_id)
    && String(row?.billing_status || '').trim().toLowerCase() === 'settled'
    && Number(row?.settled_credits) === 0
    && Number(row?.ledger_credits) === 0
    && Number(row?.billing_user_id) === Number(row?.created_by)
    && Number(row?.log_user_id) === Number(row?.created_by)
    && String(row?.hold_feature || '') === String(row?.log_feature || '')
    && String(row?.hold_kind || '') === 'text'
    && String(row?.log_kind || '') === 'text';
}

function billingAuthorityConflict(row, { settled, released, claimedState = '', expectLedger = false }) {
  const count = Number(row?.billing_record_count) || 0;
  if (Number(row?.billing_held_count) > 0 || count > 1) return true;
  if (count === 1) return !settled && !released;
  return expectLedger || ['held', 'unsettled', 'pending_reconciliation', 'pending_settlement',
    'pending_release', 'settled', 'released', 'ambiguous'].includes(claimedState);
}

function strictToolLedger(row, provenance) {
  const billing = isRecord(provenance.billing) ? provenance.billing : {};
  return strictSettledLedger(row)
    && String(row.hold_feature || '') === `经营工具箱·${String(row.tool_title || '').trim()}`
    && String(row.hold_kind || '') === 'text'
    && String(row.hold_feature || '') === String(row.log_feature || '')
    && String(row.hold_kind || '') === String(row.log_kind || '')
    && String(row.hold_model || '').trim().toLowerCase()
      === String(billing.requestedModel || '').trim().toLowerCase();
}

function strictToolReleased(row) {
  return Number(row?.billing_record_count) === 1
    && positiveInteger(row?.ledger_hold_id)
    && String(row?.billing_status || '').trim().toLowerCase() === 'settled'
    && Number(row?.settled_credits) === 0
    && Number(row?.ledger_credits) === 0
    && Number(row?.billing_user_id) === Number(row?.created_by)
    && Number(row?.log_user_id) === Number(row?.created_by)
    && String(row?.hold_feature || '') === `经营工具箱·${String(row?.tool_title || '').trim()}`
    && String(row?.hold_kind || '') === 'text'
    && String(row?.hold_feature || '') === String(row?.log_feature || '')
    && String(row?.hold_kind || '') === String(row?.log_kind || '');
}

function strictToolBilling(row, provenance) {
  const billing = isRecord(provenance.billing) ? provenance.billing : {};
  const usage = isRecord(provenance.usage) ? provenance.usage : {};
  const settledCredits = Number(row?.settled_credits);
  const chargedCredits = Number(billing.chargedCredits ?? billing.credits);
  return strictToolLedger(row, provenance)
    && String(billing.state || '').trim().toLowerCase() === 'settled'
    && billing.pendingReconciliation !== true
    && Number(billing.holdId) === Number(row?.ledger_hold_id)
    && positiveInteger(chargedCredits)
    && chargedCredits === settledCredits
    && String(row?.ledger_model || '').trim().toLowerCase()
      === String(provenance.model || '').trim().toLowerCase()
    && Number(usage.inputTokens) === Number(row?.input_tokens)
    && Number(usage.outputTokens) === Number(row?.output_tokens);
}

function toolBillingPending(row, provenance) {
  const billing = isRecord(provenance.billing) ? provenance.billing : {};
  const claimedState = String(billing.state || '').trim().toLowerCase();
  return billingPending(row, billing)
    || Number(row?.billing_record_count) > 1
    || (claimedState === 'settled' && !strictToolBilling(row, provenance))
    || (claimedState === 'released' && !strictToolReleased(row));
}

function strictRestaurantBilling(row) {
  const executionEvidence = parsedSnapshot(row.employee_web_snapshot);
  return strictSettledLedger(row)
    && String(row.hold_feature || '') === `员工任务·${String(row.marshal_name || '').trim()}`
    && String(row.hold_kind || '') === 'text'
    && String(row.hold_feature || '') === String(row.log_feature || '')
    && String(row.hold_kind || '') === String(row.log_kind || '')
    && employeeModelSettlementBindingValid({
      holdModel: row.hold_model,
      ledgerModel: row.ledger_model,
      executionEvidence,
      ledgerUsage: {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
      },
    })
    && Number(row.output_creator_id) === Number(row.created_by);
}

function strictRestaurantReleased(row) {
  return strictReleasedLedger(row)
    && String(row.hold_feature || '') === `员工任务·${String(row.marshal_name || '').trim()}`;
}

function restaurantBillingConflict(row) {
  return billingAuthorityConflict(row, {
    settled: strictRestaurantBilling(row),
    released: strictRestaurantReleased(row),
    expectLedger: Boolean(row.output_id)
      && ['待审阅', '已完成', '已驳回'].includes(String(row.status || '')),
  });
}

function strictContentSoloDelivery(row) {
  const snapshot = parsedSnapshot(row.snapshot_json);
  const provider = isRecord(snapshot.providerAttempt) ? snapshot.providerAttempt : {};
  const billing = isRecord(snapshot.billing) ? snapshot.billing : {};
  const providerModel = String(provider.model || '').trim();
  const rowModel = String(row.model || '').trim();
  const ledgerModel = String(row.ledger_model || '').trim();
  const chargedCredits = Number(billing.chargedCredits);
  return ['待审阅', '已完成', '已驳回'].includes(String(row.status || ''))
    && String(row.ai_mode || '').trim().toLowerCase() === 'api'
    && String(provider.mode || '').trim().toLowerCase() === 'api'
    && !isBlockedProviderModel(rowModel)
    && !isBlockedProviderModel(providerModel)
    && !isBlockedProviderModel(ledgerModel)
    && rowModel === providerModel
    && rowModel === ledgerModel
    && positiveInteger(provider.usage?.inputTokens)
    && positiveInteger(provider.usage?.outputTokens)
    && Number(provider.usage.inputTokens) === Number(row.input_tokens)
    && Number(provider.usage.outputTokens) === Number(row.output_tokens)
    && snapshotContractValid(snapshot) === true
    && isRecord(snapshot.internalProfileLeakage)
    && snapshot.internalProfileLeakage.detected === false
    && Boolean(row.has_output ?? String(row.result_md || '').trim())
    && String(billing.state || '').trim().toLowerCase() === 'settled'
    && billing.pendingReconciliation !== true
    && positiveInteger(chargedCredits)
    && chargedCredits === Number(row.settled_credits)
    && strictSettledLedger(row)
    && String(row.hold_feature || '') === `内容员工单派·${String(row.employee_name || '').trim()}`
    && String(row.hold_kind || '') === 'text'
    && String(row.hold_feature || '') === String(row.log_feature || '')
    && String(row.hold_kind || '') === String(row.log_kind || '')
    && String(row.hold_model || '').trim().toLowerCase()
      === String(row.ledger_model || '').trim().toLowerCase();
}

function strictContentSoloReleased(row) {
  return strictReleasedLedger(row)
    && String(row.hold_feature || '') === `内容员工单派·${String(row.employee_name || '').trim()}`;
}

function contentSoloBillingConflict(row, snapshot) {
  const billing = isRecord(snapshot.billing) ? snapshot.billing : {};
  return billingAuthorityConflict(row, {
    settled: strictContentSoloDelivery(row),
    released: strictContentSoloReleased(row),
    claimedState: String(billing.state || '').trim().toLowerCase(),
    expectLedger: ['待审阅', '已完成', '已驳回'].includes(String(row.status || ''))
      && Boolean(row.has_output ?? String(row.result_md || '').trim()),
  });
}

function strictToolSuccess(row) {
  const provenance = parsedSnapshot(row.provenance_json);
  const contract = isRecord(provenance.contract) ? provenance.contract : {};
  const billing = isRecord(provenance.billing) ? provenance.billing : {};
  const usage = isRecord(provenance.usage) ? provenance.usage : {};
  const leakage = isRecord(provenance.internalProfileLeakage)
    ? provenance.internalProfileLeakage
    : null;
  const attempts = Array.isArray(provenance.attempts) ? provenance.attempts : [];
  const acceptedAttempts = attempts.filter(attempt => (
    String(attempt?.mode || '').trim().toLowerCase() === 'api'
    && String(attempt?.outcome || '').trim().toLowerCase() === 'accepted'
    && String(attempt?.reason || '').trim().toLowerCase() === 'accepted'
    && !isBlockedProviderModel(attempt?.model)
    && positiveInteger(attempt?.usage?.inputTokens)
    && positiveInteger(attempt?.usage?.outputTokens)
  ));
  const attemptUsage = attempts.reduce((sum, attempt) => ({
    inputTokens: sum.inputTokens + (Number(attempt?.usage?.inputTokens) || 0),
    outputTokens: sum.outputTokens + (Number(attempt?.usage?.outputTokens) || 0),
  }), { inputTokens: 0, outputTokens: 0 });
  const acceptedAttempt = acceptedAttempts[0];
  const result = String(row.result_md || '');
  return String(row.status || '').trim().toLowerCase() === 'done'
    && String(provenance.mode || '').trim().toLowerCase() === 'api'
    && String(provenance.completionState || '').trim().toLowerCase() === 'completed'
    && Boolean(String(provenance.model || '').trim())
    && !isBlockedProviderModel(provenance.model)
    && positiveInteger(usage.inputTokens)
    && positiveInteger(usage.outputTokens)
    && acceptedAttempts.length === 1
    && String(acceptedAttempt.model || '').trim() === String(provenance.model || '').trim()
    && attemptUsage.inputTokens === Number(usage.inputTokens)
    && attemptUsage.outputTokens === Number(usage.outputTokens)
    && contract.valid === true
    && String(contract.status || '').trim().toLowerCase() === 'valid'
    && provenance.persisted === true
    && leakage?.detected === false
    && String(leakage.status || '').trim().toLowerCase() === 'clear'
    && Boolean(String(leakage.outputHash || '').trim())
    && leakage.outputHash === sha256(result)
    && Boolean(result.trim())
    && strictToolBilling(row, provenance);
}

function toolRemediationIndex(req) {
  if (!tableExists('tool_runs')
    || !tableExists('credit_holds')
    || !tableExists('credit_logs')) return new Map();
  const scope = userScopeClause(req.user, 'tr.created_by');
  const candidates = q.all(`SELECT
      tr.id,tr.tool_key,tr.tool_title,tr.title,tr.status,tr.input_json,tr.result_md,tr.provenance_json,tr.created_by,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=tr.tenant_id AND hx.ref_type='tool_run' AND hx.ref_id=tr.id
      ) billing_record_count,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=tr.tenant_id AND hx.ref_type='tool_run' AND hx.ref_id=tr.id
          AND hx.status='held') billing_held_count,
      h.id ledger_hold_id,h.status billing_status,h.settled_credits,
      h.feature hold_feature,h.kind hold_kind,h.model hold_model,
      h.user_id billing_user_id,
      l.user_id log_user_id,l.feature log_feature,l.kind log_kind,
      l.ai_mode ledger_ai_mode,l.model ledger_model,
      l.input_tokens,l.output_tokens,l.credits ledger_credits
    FROM tool_runs tr
    LEFT JOIN credit_holds h ON h.id=(
      SELECT MAX(h2.id) FROM credit_holds h2
      WHERE h2.tenant_id=tr.tenant_id AND h2.ref_type='tool_run' AND h2.ref_id=tr.id
    )
    LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    WHERE tr.tenant_id=?${scope.sql}
    ORDER BY tr.id`, curTenant(), ...scope.params)
    .filter(strictToolSuccess);
  return latestToolCandidateIndex(candidates);
}

function strictRestaurantSuccess(row) {
  const snapshot = parsedSnapshot(row.employee_web_snapshot);
  const contract = isRecord(snapshot.outputContract) ? snapshot.outputContract : {};
  const status = restaurantTaskStatus(row);
  return [STATUS.approved, STATUS.published].includes(status)
    && String(row.status || '') === '已完成'
    && String(row.ai_mode || '').trim().toLowerCase() === 'api'
    && !isBlockedDeliveryAiMode(row.ai_mode)
    && ['可使用', '已发布'].includes(String(row.output_status || ''))
    && String(row.approval_status || '') === '已通过'
    && Boolean(String(row.output_body || '').trim())
    && contract.valid === true
    && isRecord(snapshot.internalProfileLeakage)
    && snapshotLeakageDetected(snapshot) !== true
    && strictRestaurantBilling(row);
}

function restaurantRemediationIndex(req) {
  if (!tableExists('credit_holds') || !tableExists('credit_logs')) return new Map();
  const scope = userScopeClause(req.user, 't.created_by');
  const candidates = q.all(`SELECT
      t.id,t.title,t.type,t.requirement,t.status,t.created_at,t.due_at,t.output_id,t.employee_profile_version,
      t.employee_web_snapshot,t.employee_input_snapshot,t.employee_config_snapshot,t.created_by,
      m.name marshal_name,s.employee_idx,
      c.status output_status,c.ai_mode,c.body output_body,c.creator_id output_creator_id,
      c.risk_level,
      (SELECT a.status FROM approvals a
        WHERE a.tenant_id=t.tenant_id AND a.target_type='content' AND a.target_id=c.id
        ORDER BY a.id DESC LIMIT 1) approval_status,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=t.tenant_id AND hx.ref_type='agent_task' AND hx.ref_id=t.id
      ) billing_record_count,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=t.tenant_id AND hx.ref_type='agent_task' AND hx.ref_id=t.id
          AND hx.status='held') billing_held_count,
      h.id ledger_hold_id,h.status billing_status,h.settled_credits,h.user_id billing_user_id,
      h.feature hold_feature,h.kind hold_kind,h.model hold_model,
      l.user_id log_user_id,l.feature log_feature,l.kind log_kind,
      l.ai_mode ledger_ai_mode,l.model ledger_model,
      l.input_tokens,l.output_tokens,l.credits ledger_credits
    FROM agent_tasks t
    JOIN marshals m ON m.id=t.marshal_id
    LEFT JOIN specialists s ON s.id=t.specialist_id AND s.marshal_id=t.marshal_id
    LEFT JOIN contents c ON c.id=t.output_id AND c.tenant_id=t.tenant_id
    LEFT JOIN credit_holds h ON h.id=(
      SELECT MAX(h2.id) FROM credit_holds h2
      WHERE h2.tenant_id=t.tenant_id AND h2.ref_type='agent_task' AND h2.ref_id=t.id
    )
    LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    WHERE t.tenant_id=? AND t.output_id IS NOT NULL${scope.sql}
    ORDER BY t.id`, curTenant(), ...scope.params)
    .filter(strictRestaurantSuccess);
  return latestCandidateIndex(candidates, 'task');
}

function strictContentSoloSuccess(row) {
  const snapshot = parsedSnapshot(row.snapshot_json);
  const state = contentRunState(row);
  return state.status === STATUS.approved
    && state.verifiedOutput === true
    && String(row.status || '') === '已完成'
    && String(row.ai_mode || '').trim().toLowerCase() === 'api'
    && Boolean(String(row.model || '').trim())
    && !isBlockedProviderModel(row.model)
    && snapshotContractValid(snapshot) === true
    && snapshotLeakageDetected(snapshot) !== true
    && snapshot.review?.decision === 'adopt'
    && positiveInteger(row.material_id)
    && Number(row.material_creator_id) === Number(row.created_by)
    && strictContentSoloDelivery(row);
}

function contentSoloRemediationIndex(req) {
  if (!tableExists('content_employee_runs')
    || !tableExists('credit_holds')
    || !tableExists('credit_logs')
    || !tableExists('materials')) return new Map();
  const scope = userScopeClause(req.user, 'cer.created_by');
  const candidates = q.all(`SELECT
      cer.id,cer.employee_idx,cer.employee_name,cer.title,cer.type,cer.requirement,cer.due_at,cer.status,cer.result_md,cer.ai_mode,cer.model,
      cer.snapshot_json,cer.created_by,cer.created_at,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=cer.tenant_id AND hx.ref_type='content_employee_run'
          AND hx.ref_id=cer.id) billing_record_count,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=cer.tenant_id AND hx.ref_type='content_employee_run'
          AND hx.ref_id=cer.id AND hx.status='held') billing_held_count,
      h.id ledger_hold_id,h.status billing_status,h.settled_credits,h.user_id billing_user_id,
      h.feature hold_feature,h.kind hold_kind,h.model hold_model,
      l.user_id log_user_id,l.feature log_feature,l.kind log_kind,
      l.ai_mode ledger_ai_mode,l.model ledger_model,
      l.input_tokens,l.output_tokens,l.credits ledger_credits,
      material.id material_id,material.creator_id material_creator_id,
      CASE WHEN length(trim(COALESCE(cer.result_md,''))) > 0 THEN 1 ELSE 0 END has_output
    FROM content_employee_runs cer
    LEFT JOIN credit_holds h ON h.id=(
      SELECT MAX(h2.id) FROM credit_holds h2
      WHERE h2.tenant_id=cer.tenant_id AND h2.ref_type='content_employee_run'
        AND h2.ref_id=cer.id
    )
    LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    LEFT JOIN materials material ON material.id=(
      SELECT MAX(m2.id) FROM materials m2
      WHERE m2.tenant_id=cer.tenant_id AND m2.source_type='content_employee_run'
        AND m2.source_id=cer.id
    )
    WHERE cer.tenant_id=?${scope.sql}
    ORDER BY cer.id`, curTenant(), ...scope.params)
    .filter(strictContentSoloSuccess);
  return latestCandidateIndex(candidates, 'content_solo');
}

function taskRows(req, filters) {
  const remediationIndex = restaurantRemediationIndex(req);
  const scope = userScopeClause(req.user, 't.created_by');
  return q.all(`SELECT
      t.id, t.title, t.status, t.type, t.requirement, t.created_at, t.due_at, t.output_id,
      t.employee_profile_version,t.employee_web_snapshot,t.employee_input_snapshot,t.employee_config_snapshot,
      t.created_by, u.name operator_name,
      m.id marshal_id, m.name marshal_name,
      s.id specialist_id, s.employee_idx, s.key employee_key,
      s.name employee_name, s.person employee_person,
      COALESCE(s.group_name, m.name) group_name,
      c.status output_status,c.ai_mode,c.body output_body,c.creator_id output_creator_id,
      c.risk_level,
      CASE WHEN length(trim(COALESCE(c.body,''))) > 0 THEN 1 ELSE 0 END has_output,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=t.tenant_id AND hx.ref_type='agent_task' AND hx.ref_id=t.id
      ) billing_record_count,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=t.tenant_id AND hx.ref_type='agent_task' AND hx.ref_id=t.id
          AND hx.status='held') billing_held_count,
      h.id ledger_hold_id,h.status billing_status,h.settled_credits,h.user_id billing_user_id,
      h.feature hold_feature,h.kind hold_kind,h.model hold_model,
      l.user_id log_user_id,l.feature log_feature,l.kind log_kind,
      l.ai_mode ledger_ai_mode,l.model ledger_model,
      l.input_tokens,l.output_tokens,l.credits ledger_credits,
      (SELECT a.status FROM approvals a
        WHERE a.tenant_id=t.tenant_id AND a.target_type='content' AND a.target_id=c.id
        ORDER BY a.id DESC LIMIT 1) approval_status,
      (SELECT a.approval_level FROM approvals a
        WHERE a.tenant_id=t.tenant_id AND a.target_type='content' AND a.target_id=c.id
        ORDER BY a.id DESC LIMIT 1) approval_level,
      (SELECT a.rules_hit FROM approvals a
        WHERE a.tenant_id=t.tenant_id AND a.target_type='content' AND a.target_id=c.id
        ORDER BY a.id DESC LIMIT 1) approval_rules_hit
    FROM agent_tasks t
    JOIN marshals m ON m.id=t.marshal_id
    LEFT JOIN specialists s ON s.id=t.specialist_id AND s.marshal_id=t.marshal_id
    LEFT JOIN contents c ON c.id=t.output_id AND c.tenant_id=t.tenant_id
    LEFT JOIN credit_holds h ON h.id=(
      SELECT MAX(h2.id) FROM credit_holds h2
      WHERE h2.tenant_id=t.tenant_id AND h2.ref_type='agent_task' AND h2.ref_id=t.id
    )
    LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    LEFT JOIN users u ON u.id=t.created_by AND u.tenant_id=t.tenant_id
    WHERE t.tenant_id=?
      AND t.created_at BETWEEN ? AND ? || ' 23:59:59'
      ${scope.sql}
    ORDER BY t.created_at DESC, t.id DESC`, curTenant(), filters.start, filters.end, ...scope.params)
    .map(row => {
      const supersededBy = loadAgentTaskSupersession(row.id, {
        tenantId: curTenant(),
      });
      const originalStatus = supersededBy
        ? STATUS.superseded
        : restaurantTaskStatus(row);
      const remediation = supersededBy
        ? null
        : remediationFor(row, originalStatus, remediationIndex, 'task');
      const status = remediation?.status || originalStatus;
      const hasOutput = Boolean(row.has_output)
        && ![STATUS.awaitingAssignment, STATUS.generating, STATUS.generationFailed, STATUS.qualityFailed,
          STATUS.reconciliationPending, STATUS.remediated, STATUS.superseded]
          .includes(status);
      return {
        id: Number(row.id),
        ref: `task:${row.id}`,
        source: 'task',
        sourceLabel: SOURCE_LABELS.task,
        abilityDomain: 'restaurant',
        abilityDomainLabel: DOMAIN_LABELS.restaurant,
        title: row.title || '未命名员工任务',
        status,
        outputStatus: status,
        hasOutput,
        createdAt: row.created_at,
        group: row.group_name || row.marshal_name || '未分组',
        employeeIdx: row.employee_idx == null ? null : Number(row.employee_idx),
        employeeKey: row.employee_key || '',
        employee: row.employee_name || row.marshal_name || '分部协同',
        person: row.employee_person || '',
        operator: row.operator_name || '-',
        evidenceKind: supersededBy
          ? '旧版本审计记录（正文不可用于业务）'
          : remediation
          ? '历史未通过记录（后续已修复）'
          : hasOutput ? '质检合格产出' : status === STATUS.qualityFailed ? '质检失败记录' : '运行状态',
        evidenceLabel: row.output_id ? `内容记录 #${row.output_id}` : `任务记录 #${row.id}`,
        evidenceId: row.output_id || row.id,
        type: row.type || '常规',
        canReview: !supersededBy && status === STATUS.reviewPending && contentOutputReviewAccess(
          req.user,
          row,
          {
            status: row.approval_status,
            approval_level: row.approval_level,
            rules_hit: row.approval_rules_hit,
            risk_level: row.risk_level,
          },
          { risk_level: row.risk_level, creator_id: row.output_creator_id },
        ).allowed,
        ...(supersededBy
          ? {
              deliveryState: 'DELIVERY_SUPERSEDED',
              supersededBy,
            }
          : {}),
        ...(remediation || {}),
      };
    });
}

function tableExists(name) {
  return Boolean(q.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
}

function toolRows(req, filters) {
  // tool_runs 由经营工具模块创建。并行升级或旧库尚未迁移时，分析页仍可安全展示员工任务。
  if (!tableExists('tool_runs')) return [];
  const remediationIndex = toolRemediationIndex(req);
  const scope = userScopeClause(req.user, 'tr.created_by');
  return q.all(`SELECT
      tr.id, tr.tool_key, tr.tool_title, tr.title, tr.status, tr.input_json,
      tr.employee_idx, tr.employee_name, tr.specialist_id,
      tr.created_by, tr.result_md, tr.provenance_json, tr.created_at,
      u.name operator_name,
      s.key employee_key, s.person employee_person,
      COALESCE(s.group_name,m.name,'经营工具协同') group_name,
      CASE WHEN length(trim(COALESCE(tr.result_md,''))) > 0 THEN 1 ELSE 0 END has_output,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=tr.tenant_id AND hx.ref_type='tool_run' AND hx.ref_id=tr.id
      ) billing_record_count,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=tr.tenant_id AND hx.ref_type='tool_run' AND hx.ref_id=tr.id
          AND hx.status='held') billing_held_count,
      h.id ledger_hold_id,h.status billing_status,h.settled_credits,h.user_id billing_user_id,
      h.feature hold_feature,h.kind hold_kind,h.model hold_model,
      l.user_id log_user_id,l.feature log_feature,l.kind log_kind,
      l.ai_mode ledger_ai_mode,l.model ledger_model,
      l.input_tokens,l.output_tokens,l.credits ledger_credits
    FROM tool_runs tr
    LEFT JOIN specialists s ON s.id=tr.specialist_id
    LEFT JOIN marshals m ON m.id=s.marshal_id
    LEFT JOIN credit_holds h ON h.id=(
      SELECT MAX(h2.id) FROM credit_holds h2
      WHERE h2.tenant_id=tr.tenant_id AND h2.ref_type='tool_run' AND h2.ref_id=tr.id
    )
    LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    LEFT JOIN users u ON u.id=tr.created_by AND u.tenant_id=tr.tenant_id
    WHERE tr.tenant_id=?
      AND tr.created_at BETWEEN ? AND ? || ' 23:59:59'
      ${scope.sql}
    ORDER BY tr.created_at DESC, tr.id DESC`, curTenant(), filters.start, filters.end, ...scope.params)
    .map(row => {
      const provenance = safeJsonParse(row.provenance_json, {});
      const state = toolRunState(row, provenance);
      const remediation = toolRemediationFor(row, state, remediationIndex);
      const hasOutput = remediation ? false : state.verifiedOutput;
      const status = remediation?.status || state.status;
      return {
        id: Number(row.id),
        ref: `tool:${row.id}`,
        source: 'tool',
        sourceLabel: SOURCE_LABELS.tool,
        abilityDomain: 'tool',
        abilityDomainLabel: DOMAIN_LABELS.tool,
        title: row.title || row.tool_title || '未命名工具运行',
        status,
        outputStatus: status,
        hasOutput,
        createdAt: row.created_at,
        group: row.group_name || '经营工具协同',
        employeeIdx: row.employee_idx == null ? null : Number(row.employee_idx),
        employeeKey: row.employee_key || '',
        employee: row.employee_name || '未指定数字员工',
        person: row.employee_person || '',
        operator: row.operator_name || '-',
        evidenceKind: remediation
          ? '历史未通过记录（后续已修复）'
          : hasOutput
            ? '质检合格工具结果'
            : status === STATUS.reconciliationPending
              ? '待账务对账工具记录'
              : status === STATUS.qualityFailed
                ? '质检失败记录'
                : '工具运行状态',
        evidenceLabel: `工具运行 #${row.id}`,
        evidenceId: row.id,
        type: row.tool_title || row.tool_key || '经营工具',
        ...(state.failureReasons?.length ? { failureReasons: state.failureReasons } : {}),
        ...(remediation || {}),
      };
    });
}

function contentRows(req, filters) {
  const contentScope = userScopeClause(req.user, 'c.creator_id');
  const mediaScope = userScopeClause(req.user, 'j.user_id');
  const outputs = q.all(`SELECT
      c.id, c.type, c.title, c.topic, c.status, c.body, c.ai_mode, c.snapshot_json,c.created_at,
      c.content_employee_idx, c.content_employee_key, c.content_employee_name,
      c.content_employee_group, c.content_run_mode,
      u.name operator_name,
      (SELECT a.status FROM approvals a
        WHERE a.tenant_id=c.tenant_id AND a.target_type='content' AND a.target_id=c.id
        ORDER BY a.id DESC LIMIT 1) approval_status
    FROM contents c
    LEFT JOIN users u ON u.id=c.creator_id AND u.tenant_id=c.tenant_id
    WHERE c.tenant_id=? AND c.content_employee_idx IS NOT NULL
      AND c.created_at BETWEEN ? AND ? || ' 23:59:59'${contentScope.sql}
    ORDER BY c.created_at DESC,c.id DESC`, curTenant(), filters.start, filters.end, ...contentScope.params)
    .map(row => {
      const catalogEmployee = contentEmployeeByIdx(Number(row.content_employee_idx));
      const state = storedContentState(row);
      return {
        id: `output-${row.id}`,
        ref: `content:output:${row.id}`,
        source: 'content',
        sourceLabel: SOURCE_LABELS.content,
        abilityDomain: 'content',
        abilityDomainLabel: DOMAIN_LABELS.content,
        domain: 'content_output',
        domainLabel: '内容成品',
        title: row.title || row.topic || `内容#${row.id}`,
        status: state.status,
        outputStatus: state.status,
        hasOutput: state.verifiedOutput,
        createdAt: row.created_at,
        group: row.content_employee_group || catalogEmployee?.group || '内容生产部',
        employeeIdx: Number(row.content_employee_idx),
        employeeKey: row.content_employee_key || catalogEmployee?.key || '',
        employee: row.content_employee_name || catalogEmployee?.name || '内容员工',
        person: null,
        operator: row.operator_name || '-',
        evidenceKind: storedContentEvidence(state),
        evidenceLabel: `内容记录 #${row.id}`,
        evidenceId: row.id,
        type: row.type || '内容成品',
        executionMode: row.content_run_mode || 'single_station',
      };
    });

  const media = q.all(`SELECT
      j.id, j.user_id, j.kind, j.prompt, j.status, j.url, j.error, j.credits,
      j.snapshot_json,j.created_at,
      j.content_employee_idx, j.content_employee_key, j.content_employee_name,
      j.content_employee_group, j.content_run_mode,
      u.name operator_name
    FROM media_jobs j
    LEFT JOIN users u ON u.id=j.user_id AND u.tenant_id=j.tenant_id
    WHERE j.tenant_id=? AND j.content_employee_idx IS NOT NULL
      AND j.kind IN ('image','video')
      AND j.created_at BETWEEN ? AND ? || ' 23:59:59'${mediaScope.sql}
    ORDER BY j.created_at DESC,j.id DESC`, curTenant(), filters.start, filters.end, ...mediaScope.params)
    .map(row => {
      const catalogEmployee = contentEmployeeByIdx(Number(row.content_employee_idx));
      const state = mediaRecordState(row, req.user);
      const status = state.status;
      const hasOutput = state.verifiedOutput;
      return {
        id: `media-${row.id}`,
        ref: `content:media:${row.id}`,
        source: 'content',
        sourceLabel: SOURCE_LABELS.content,
        abilityDomain: 'content',
        abilityDomainLabel: DOMAIN_LABELS.content,
        domain: 'content_media',
        domainLabel: row.kind === 'video' ? '视频任务' : '图片任务',
        title: String(row.prompt || '').slice(0, 80) || `${row.kind === 'video' ? '视频' : '图片'}任务#${row.id}`,
        status,
        outputStatus: status,
        hasOutput,
        createdAt: row.created_at,
        group: row.content_employee_group || catalogEmployee?.group || '内容生产部',
        employeeIdx: Number(row.content_employee_idx),
        employeeKey: row.content_employee_key || catalogEmployee?.key || '',
        employee: row.content_employee_name || catalogEmployee?.name || '内容员工',
        person: null,
        operator: row.operator_name || '-',
        evidenceKind: status === STATUS.approved
          ? '已人工验收媒体产出'
          : status === STATUS.reviewPending
            ? '待人工审阅媒体产出'
            : status === STATUS.reconciliationPending
              ? '待账务对账媒体记录'
              : '媒体运行状态',
        evidenceLabel: `媒体任务 #${row.id}`,
        evidenceId: row.id,
        type: row.kind === 'video' ? 'AI视频' : 'AI图片',
        executionMode: row.content_run_mode || 'single_station',
        canReview: state.media.canImport === true,
      };
    });
  return [...outputs, ...media];
}

function contentSoloEvidence(status, hasOutput) {
  if (status === STATUS.remediated) return '历史未通过记录（后续已修复）';
  if (hasOutput) return '质检合格内容产出';
  if (status === STATUS.qualityFailed) return '质检失败记录';
  if (status === STATUS.generationFailed) return '内容员工生成失败';
  return '内容员工运行状态';
}

function contentSoloRows(req, filters) {
  // 老版本数据库可能还没有该表；聚合页必须继续服务已有任务、工具与内容成品。
  if (!tableExists('content_employee_runs')) return [];
  const remediationIndex = contentSoloRemediationIndex(req);
  const scope = userScopeClause(req.user, 'cer.created_by');
  return q.all(`SELECT
      cer.id,cer.employee_idx,cer.employee_key,cer.employee_name,cer.employee_group,
      cer.title,cer.type,cer.requirement,cer.due_at,cer.status,cer.result_md,cer.ai_mode,cer.model,
      cer.profile_version,cer.prompt_hash,cer.snapshot_json,cer.created_by,cer.created_at,cer.updated_at,
      u.name operator_name,
      CASE WHEN length(trim(COALESCE(cer.result_md,''))) > 0 THEN 1 ELSE 0 END has_output,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=cer.tenant_id AND hx.ref_type='content_employee_run'
          AND hx.ref_id=cer.id) billing_record_count,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=cer.tenant_id AND hx.ref_type='content_employee_run'
          AND hx.ref_id=cer.id AND hx.status='held') billing_held_count,
      h.id ledger_hold_id,h.status billing_status,h.settled_credits,h.user_id billing_user_id,
      h.feature hold_feature,h.kind hold_kind,h.model hold_model,
      l.user_id log_user_id,l.feature log_feature,l.kind log_kind,
      l.ai_mode ledger_ai_mode,l.model ledger_model,
      l.input_tokens,l.output_tokens,l.credits ledger_credits
    FROM content_employee_runs cer
    LEFT JOIN credit_holds h ON h.id=(
      SELECT MAX(h2.id) FROM credit_holds h2
      WHERE h2.tenant_id=cer.tenant_id AND h2.ref_type='content_employee_run'
        AND h2.ref_id=cer.id
    )
    LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    LEFT JOIN users u ON u.id=cer.created_by AND u.tenant_id=cer.tenant_id
    WHERE cer.tenant_id=?
      AND cer.created_at BETWEEN ? AND ? || ' 23:59:59'
      ${scope.sql}
    ORDER BY cer.created_at DESC,cer.id DESC`,
  curTenant(), filters.start, filters.end, ...scope.params)
    .map(row => {
      const state = contentRunState(row);
      const remediation = remediationFor(row, state.status, remediationIndex, 'content_solo');
      const status = remediation?.status || state.status;
      const hasOutput = remediation ? false : state.verifiedOutput;
      return {
        id: Number(row.id),
        ref: `content_solo:${row.id}`,
        source: 'content_solo',
        sourceLabel: SOURCE_LABELS.content_solo,
        abilityDomain: 'content',
        abilityDomainLabel: DOMAIN_LABELS.content,
        domain: 'content_solo',
        domainLabel: '内容员工单独派活',
        title: row.title || `内容员工派活 #${row.id}`,
        status,
        outputStatus: hasOutput ? status : '',
        hasOutput,
        createdAt: row.created_at,
        group: row.employee_group || 'Paihuo内容生产部',
        employeeIdx: row.employee_idx == null ? null : Number(row.employee_idx),
        employeeKey: row.employee_key || '',
        employee: row.employee_name || '内容员工',
        person: null,
        operator: row.operator_name || '-',
        evidenceKind: contentSoloEvidence(status, hasOutput),
        evidenceLabel: `内容员工运行 #${row.id}`,
        evidenceId: row.id,
        type: row.type || '岗位交付',
        executionMode: 'single_user',
        canReview: status === STATUS.reviewPending
          && contentEmployeeRunReviewAccess(req.user, parsedSnapshot(row.snapshot_json)).allowed,
        ...(remediation || {}),
        ...(canViewInternalProfile(req.user) ? {
          profileVersion: row.profile_version || '',
          promptHash: row.prompt_hash || '',
        } : {}),
      };
    });
}

function matches(row, filters) {
  if (filters.domain !== 'all' && row.abilityDomain !== filters.domain) return false;
  if (filters.group && row.group !== filters.group) return false;
  if (filters.employee && ![row.employeeIdx, row.employeeKey, row.employee]
    .some(value => String(value ?? '') === filters.employee)) return false;
  if (filters.status && row.status !== filters.status) return false;
  return true;
}

function dimensionValue(row, dimension) {
  if (dimension === 'domain') return row.abilityDomainLabel || '未分类能力域';
  if (dimension === 'group') return row.group || '未分组';
  if (dimension === 'source') return row.sourceLabel;
  if (dimension === 'status') return row.status || '未知';
  return row.employeeIdx != null ? `${row.employeeIdx} · ${row.employee}` : row.employee;
}

function pivotRows(rows, dimension) {
  const buckets = new Map();
  for (const row of rows) {
    const label = dimensionValue(row, dimension);
    const item = buckets.get(label) || {
      key: label,
      label,
      total: 0,
      withOutput: 0,
      completed: 0,
      pending: 0,
      failed: 0,
      remediated: 0,
      superseded: 0,
    };
    item.total += 1;
    if (row.hasOutput) item.withOutput += 1;
    if (isCompleted(row.status)) item.completed += 1;
    else if (isFailed(row.status)) item.failed += 1;
    else if (isRemediated(row.status)) item.remediated += 1;
    else if (isSuperseded(row.status)) item.superseded += 1;
    else item.pending += 1;
    buckets.set(label, item);
  }
  return [...buckets.values()]
    .map(item => {
      const { superseded, ...publicItem } = item;
      return {
        ...publicItem,
        ...(superseded > 0 ? { superseded } : {}),
        outputRate: item.total ? Math.round((item.withOutput / item.total) * 1000) / 10 : 0,
        completionRate: item.total ? Math.round((item.completed / item.total) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.total - a.total || String(a.label).localeCompare(String(b.label), 'zh-CN'));
}

function filterOptions(rows) {
  const uniq = values => [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
  const employees = new Map();
  for (const row of rows) {
    const value = row.employeeIdx != null ? String(row.employeeIdx) : (row.employeeKey || row.employee);
    const label = row.employeeIdx != null ? `${row.employeeIdx} · ${row.employee}` : row.employee;
    if (value && !employees.has(value)) employees.set(value, { value, label, group: row.group });
  }
  return {
    domains: Object.entries(DOMAIN_LABELS).map(([value, label]) => ({ value, label })),
    groups: uniq(rows.map(row => row.group)),
    employees: [...employees.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')),
    statuses: uniq(rows.map(row => row.status)),
    sources: Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label })),
  };
}

r.get('/', (req, res) => {
  const filters = parseQuery(req, res);
  if (!filters) return;

  let all = [];
  if (filters.source === 'all' || filters.source === 'task') all.push(...taskRows(req, filters));
  if (filters.source === 'all' || filters.source === 'tool') all.push(...toolRows(req, filters));
  if (filters.source === 'all' || filters.source === 'content') all.push(...contentRows(req, filters));
  if (filters.source === 'all' || filters.source === 'content_solo') all.push(...contentSoloRows(req, filters));
  all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.ref).localeCompare(String(a.ref)));
  all = all.map(row => withPublicState(row, req.user));
  const options = filterOptions(all);
  const rows = all.filter(row => matches(row, filters));
  const offset = (filters.page - 1) * filters.pageSize;
  const supersededCount = rows.filter(row => isSuperseded(row.status)).length;
  const summary = {
    total: rows.length,
    withOutput: rows.filter(row => row.hasOutput).length,
    completed: rows.filter(row => isCompleted(row.status)).length,
    pending: rows.filter(row => !isCompleted(row.status)
      && !isFailed(row.status)
      && !isRemediated(row.status)).length,
    failed: rows.filter(row => isFailed(row.status)).length,
    remediated: rows.filter(row => isRemediated(row.status)).length,
    ...(supersededCount > 0 ? { superseded: supersededCount } : {}),
  };
  const tenant = getTenant(curTenant());
  const isDemoEnvironment = tenant?.data_mode === 'demo';

  res.set('Cache-Control', 'private, no-store');
  res.json({
    range: { start: filters.start, end: filters.end },
    dimension: filters.dimension,
    filters: {
      domain: filters.domain,
      group: filters.group,
      employee: filters.employee,
      source: filters.source,
      status: filters.status,
    },
    dataset: {
      kind: isDemoEnvironment ? '当前环境待核验运行记录' : '当前企业运行记录',
      isDemoEnvironment,
      store: { id: curTenant(), name: tenant?.name || `门店 ${curTenant()}`, fixedToCurrentTenant: true },
      disclaimer: '数字员工任务、经营工具、内容生产仓与内容员工单独派活记录只证明对应单次能力已运行，不代表十工位流水线已自动执行，也不代表营业额、利润或客户转化已经提升；经营成效需继续与订单、会员等事实表核验。',
    },
    calculation: {
      unit: '一条持久化运行记录',
      outputRate: '已通过机器质检且有可查看产出的记录数 ÷ 当前筛选后的运行记录数',
      completionRate: '已经人工审阅通过或已发布的记录数 ÷ 当前筛选后的运行记录数',
      effectBoundary: '本透视不做营业额、利润、订单或顾客转化归因。',
    },
    summary,
    options,
    pivot: pivotRows(rows, filters.dimension),
    rows: rows.slice(offset, offset + filters.pageSize),
    pagination: { page: filters.page, pageSize: filters.pageSize, total: rows.length },
  });
});

r.get('/drill/task/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: '运行记录不存在' });
  const scope = userScopeClause(req.user, 't.created_by');
  const row = q.get(`SELECT
      t.id, t.title, t.type, t.requirement, t.status, t.created_at, t.due_at,
      t.is_collab, t.collab_marshals, t.output_id,
      t.created_by,
      t.employee_profile_version,t.employee_prompt_hash,
      t.employee_capabilities_snapshot,t.employee_config_snapshot,t.employee_skills_snapshot,
      t.employee_canonical_snapshot,t.employee_input_snapshot,t.employee_web_snapshot,
      m.name marshal_name,
      s.employee_idx, s.key employee_key, s.name employee_name,
      s.person employee_person, COALESCE(s.group_name,m.name) group_name,
      u.name operator_name,
      c.title output_title, c.body output_body, c.status output_status,
      c.risk_level, c.risk_flags, c.ai_mode, c.creator_id output_creator_id,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=t.tenant_id AND hx.ref_type='agent_task' AND hx.ref_id=t.id
      ) billing_record_count,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=t.tenant_id AND hx.ref_type='agent_task' AND hx.ref_id=t.id
          AND hx.status='held') billing_held_count,
      h.id ledger_hold_id,h.status billing_status,h.settled_credits,h.user_id billing_user_id,
      h.feature hold_feature,h.kind hold_kind,h.model hold_model,
      l.user_id log_user_id,l.feature log_feature,l.kind log_kind,
      l.ai_mode ledger_ai_mode,l.model ledger_model,
      l.input_tokens,l.output_tokens,l.credits ledger_credits,
      (SELECT a.status FROM approvals a
        WHERE a.tenant_id=t.tenant_id AND a.target_type='content' AND a.target_id=c.id
        ORDER BY a.id DESC LIMIT 1) approval_status,
      (SELECT a.approval_level FROM approvals a
        WHERE a.tenant_id=t.tenant_id AND a.target_type='content' AND a.target_id=c.id
        ORDER BY a.id DESC LIMIT 1) approval_level,
      (SELECT a.rules_hit FROM approvals a
        WHERE a.tenant_id=t.tenant_id AND a.target_type='content' AND a.target_id=c.id
        ORDER BY a.id DESC LIMIT 1) approval_rules_hit
    FROM agent_tasks t
    JOIN marshals m ON m.id=t.marshal_id
    LEFT JOIN specialists s ON s.id=t.specialist_id AND s.marshal_id=t.marshal_id
    LEFT JOIN users u ON u.id=t.created_by AND u.tenant_id=t.tenant_id
    LEFT JOIN contents c ON c.id=t.output_id AND c.tenant_id=t.tenant_id
    LEFT JOIN credit_holds h ON h.id=(
      SELECT MAX(h2.id) FROM credit_holds h2
      WHERE h2.tenant_id=t.tenant_id AND h2.ref_type='agent_task' AND h2.ref_id=t.id
    )
    LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    WHERE t.tenant_id=? AND t.id=?${scope.sql}`, curTenant(), id, ...scope.params);
  if (!row) return res.status(404).json({ error: '运行记录不存在或无权查看' });
  const supersededBy = loadAgentTaskSupersession(row.id, {
    tenantId: curTenant(),
  });
  const canViewProfile = canViewInternalProfile(req.user);
  const executionEvidence = safeJsonParse(row.employee_web_snapshot, null);
  const wrappedExecutionEvidence = executionEvidence?.kind === 'restaurant_employee_execution_evidence'
    ? executionEvidence
    : null;
  const internalProfileLeakage = normalizeInternalProfileLeakage(
    wrappedExecutionEvidence?.internalProfileLeakage,
  );
  const inputEvidence = safeJsonParse(row.employee_input_snapshot, null);
  const originalStatus = supersededBy
    ? STATUS.superseded
    : restaurantTaskStatus(row);
  const remediation = supersededBy
    ? null
    : remediationFor(
        row,
        originalStatus,
        restaurantRemediationIndex(req),
        'task',
      );
  const publicStatus = remediation?.status || originalStatus;
  const canReview = !supersededBy && publicStatus === STATUS.reviewPending && contentOutputReviewAccess(
    req.user,
    row,
    {
      status: row.approval_status,
      approval_level: row.approval_level,
      rules_hit: row.approval_rules_hit,
      risk_level: row.risk_level,
    },
    { risk_level: row.risk_level, creator_id: row.output_creator_id },
  ).allowed;
  const verifiedOutput = Boolean(String(row.output_body || '').trim())
    && ![STATUS.awaitingAssignment, STATUS.generating, STATUS.generationFailed, STATUS.qualityFailed,
      STATUS.reconciliationPending, STATUS.remediated, STATUS.superseded]
      .includes(publicStatus);
  const execution = supersededBy
    ? null
    : row.employee_profile_version
    ? canViewProfile
      ? {
          profileVersion: row.employee_profile_version,
          promptHash: row.employee_prompt_hash || '',
          snapshot: {
            canonicalProfile: canonicalEmployeeSnapshot(row.employee_canonical_snapshot, row.id),
            capabilities: safeJsonParse(row.employee_capabilities_snapshot, []),
            workConfig: safeJsonParse(row.employee_config_snapshot, {}),
            skills: safeJsonParse(row.employee_skills_snapshot, []),
            inputEvidence,
            webEvidence: wrappedExecutionEvidence ? wrappedExecutionEvidence.web : executionEvidence,
            outputContract: wrappedExecutionEvidence?.outputContract || null,
            internalProfileLeakage,
          },
        }
      : redactedExecution()
    : null;
  res.set('Cache-Control', 'private, no-store');
  res.json({
    source: 'task',
    sourceLabel: SOURCE_LABELS.task,
    evidenceKind: remediation
      ? '历史未通过记录（后续已修复）'
      : supersededBy
        ? '旧版本审计记录（正文不可用于业务）'
        : verifiedOutput ? '质检合格产出' : publicStatus === STATUS.qualityFailed ? '质检失败记录' : '运行状态',
    record: {
      id: row.id,
      title: row.title,
      type: row.type || '常规',
      status: publicStatus,
      displayStatus: displayStatus(publicStatus),
      nextAction: publicNextAction(publicStatus, req.user, { canReview }),
      ...(remediation || {}),
      ...(supersededBy
        ? {
            deliveryState: 'DELIVERY_SUPERSEDED',
            supersededBy,
          }
        : {}),
      canReview,
      createdAt: row.created_at,
      dueAt: row.due_at,
      group: row.group_name,
      employeeIdx: row.employee_idx,
      employeeKey: row.employee_key,
      employee: row.employee_name || row.marshal_name,
      person: row.employee_person || '',
      operator: row.operator_name || '-',
      requirement: row.requirement || '',
      collaboration: row.is_collab ? String(row.collab_marshals || '').split(',').filter(Boolean) : [],
    },
    output: row.output_id ? {
      id: row.output_id,
      title: row.output_title,
      body: supersededBy
        ? ''
        : projectInternalProfileOutput(row.output_body || '', internalProfileLeakage, req.user),
      ...(supersededBy
        ? {
            bodyAvailability: 'superseded',
            deliveryState: 'DELIVERY_SUPERSEDED',
            supersededBy,
          }
        : {}),
      status: publicStatus,
      displayStatus: displayStatus(publicStatus),
      aiMode: row.ai_mode,
      riskLevel: row.risk_level || 'none',
      riskFlags: safeJsonParse(row.risk_flags, []),
    } : null,
    execution,
    disclaimer: '本页是可追溯的系统运行证据，不把内容产出推断为真实经营成效。',
  });
});

r.get('/drill/tool/:id', (req, res) => {
  if (!tableExists('tool_runs')) return res.status(404).json({ error: '工具运行记录不存在' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: '工具运行记录不存在' });
  const scope = userScopeClause(req.user, 'tr.created_by');
  const row = q.get(`SELECT
      tr.id, tr.tool_key, tr.tool_title, tr.title, tr.status,
      tr.employee_idx, tr.employee_name, tr.specialist_id,tr.created_by,
      tr.input_json, tr.input_summary, tr.result_md,
      tr.assumptions_json, tr.evidence_json, tr.provenance_json,
      tr.created_at, tr.updated_at,
      u.name operator_name,
      s.key employee_key, s.person employee_person,
      COALESCE(s.group_name,m.name,'经营工具协同') group_name,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=tr.tenant_id AND hx.ref_type='tool_run' AND hx.ref_id=tr.id
      ) billing_record_count,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=tr.tenant_id AND hx.ref_type='tool_run' AND hx.ref_id=tr.id
          AND hx.status='held') billing_held_count,
      h.id ledger_hold_id,h.status billing_status,h.settled_credits,h.user_id billing_user_id,
      h.feature hold_feature,h.kind hold_kind,h.model hold_model,
      l.user_id log_user_id,l.feature log_feature,l.kind log_kind,
      l.ai_mode ledger_ai_mode,l.model ledger_model,
      l.input_tokens,l.output_tokens,l.credits ledger_credits
    FROM tool_runs tr
    LEFT JOIN specialists s ON s.id=tr.specialist_id
    LEFT JOIN marshals m ON m.id=s.marshal_id
    LEFT JOIN credit_holds h ON h.id=(
      SELECT MAX(h2.id) FROM credit_holds h2
      WHERE h2.tenant_id=tr.tenant_id AND h2.ref_type='tool_run' AND h2.ref_id=tr.id
    )
    LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    LEFT JOIN users u ON u.id=tr.created_by AND u.tenant_id=tr.tenant_id
    WHERE tr.tenant_id=? AND tr.id=?${scope.sql}`, curTenant(), id, ...scope.params);
  if (!row) return res.status(404).json({ error: '工具运行记录不存在或无权查看' });
  const storedProvenance = safeJsonParse(row.provenance_json, {});
  const provenance = publicToolProvenance(storedProvenance, req.user);
  const internalProfileLeakage = normalizeInternalProfileLeakage(
    storedProvenance.internalProfileLeakage,
  );
  const state = toolRunState(row, storedProvenance);
  const remediation = toolRemediationFor(row, state, toolRemediationIndex(req));
  const recordStatus = remediation?.status || state.status;
  res.set('Cache-Control', 'private, no-store');
  res.json({
    source: 'tool',
    sourceLabel: SOURCE_LABELS.tool,
    evidenceKind: remediation
      ? '历史未通过记录（后续已修复）'
      : state.verifiedOutput
        ? '质检合格工具结果'
        : recordStatus === STATUS.reconciliationPending
          ? '待账务对账工具记录'
          : recordStatus === STATUS.qualityFailed
            ? '质检失败记录'
            : '工具运行状态',
    record: {
      id: row.id,
      title: row.title || row.tool_title,
      type: row.tool_title || row.tool_key,
      toolKey: row.tool_key,
      status: recordStatus,
      displayStatus: displayStatus(recordStatus),
      nextAction: publicNextAction(recordStatus, req.user),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      group: row.group_name,
      employeeIdx: row.employee_idx,
      employeeKey: row.employee_key,
      employee: row.employee_name || '未指定数字员工',
      person: row.employee_person || '',
      operator: row.operator_name || '-',
      inputSummary: row.input_summary || '',
      inputs: safeJsonParse(row.input_json, {}),
      ...(state.failureReasons?.length ? { failureReasons: state.failureReasons } : {}),
      ...(remediation || {}),
    },
    output: row.result_md ? {
      body: projectInternalProfileOutput(row.result_md, internalProfileLeakage, req.user),
      assumptions: safeJsonParse(row.assumptions_json, []),
      evidence: safeJsonParse(row.evidence_json, []),
      provenance,
      ...(internalProfileLeakage ? { internalProfileLeakage } : {}),
    } : null,
    disclaimer: '本页是可追溯的系统运行证据；假设、输入与模板生成结果不等同于真实经营成效。',
  });
});

r.get('/drill/content_solo/:id', (req, res) => {
  if (!tableExists('content_employee_runs')) {
    return res.status(404).json({ error: '内容员工运行记录不存在' });
  }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(404).json({ error: '内容员工运行记录不存在' });
  }
  const scope = userScopeClause(req.user, 'cer.created_by');
  const row = q.get(`SELECT
      cer.id,cer.employee_idx,cer.employee_key,cer.employee_name,cer.employee_group,
      cer.title,cer.type,cer.requirement,cer.due_at,cer.status,cer.result_md,
      cer.ai_mode,cer.model,cer.profile_version,cer.prompt_hash,cer.snapshot_json,
      cer.created_by,cer.created_at,cer.updated_at,u.name operator_name,
      CASE WHEN length(trim(COALESCE(cer.result_md,''))) > 0 THEN 1 ELSE 0 END has_output,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=cer.tenant_id AND hx.ref_type='content_employee_run'
          AND hx.ref_id=cer.id) billing_record_count,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=cer.tenant_id AND hx.ref_type='content_employee_run'
          AND hx.ref_id=cer.id AND hx.status='held') billing_held_count,
      h.id ledger_hold_id,h.status billing_status,h.settled_credits,h.user_id billing_user_id,
      h.feature hold_feature,h.kind hold_kind,h.model hold_model,
      l.user_id log_user_id,l.feature log_feature,l.kind log_kind,
      l.ai_mode ledger_ai_mode,l.model ledger_model,
      l.input_tokens,l.output_tokens,l.credits ledger_credits
    FROM content_employee_runs cer
    LEFT JOIN credit_holds h ON h.id=(
      SELECT MAX(h2.id) FROM credit_holds h2
      WHERE h2.tenant_id=cer.tenant_id AND h2.ref_type='content_employee_run'
        AND h2.ref_id=cer.id
    )
    LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    LEFT JOIN users u ON u.id=cer.created_by AND u.tenant_id=cer.tenant_id
    WHERE cer.tenant_id=? AND cer.id=?${scope.sql}`,
  curTenant(), id, ...scope.params);
  if (!row) return res.status(404).json({ error: '内容员工运行记录不存在或无权查看' });

  const snapshot = safeJsonParse(row.snapshot_json, {});
  const internalProfileLeakage = normalizeInternalProfileLeakage(snapshot?.internalProfileLeakage);
  const canViewProfile = canViewInternalProfile(req.user);
  const capabilities = Array.isArray(snapshot?.capabilities) ? snapshot.capabilities : [];
  const coreSkills = Array.isArray(snapshot?.coreSkill) ? snapshot.coreSkill : [];
  const historicalSkills = Array.isArray(snapshot?.historicalSkills) ? snapshot.historicalSkills : [];
  const customSkills = Array.isArray(snapshot?.customSkills) ? snapshot.customSkills : [];
  const result = String(row.result_md || '').trim();
  const state = contentRunState({ ...row, has_output: Boolean(result) ? 1 : 0 });
  const remediation = remediationFor(
    row,
    state.status,
    contentSoloRemediationIndex(req),
    'content_solo',
  );
  const publicStatus = remediation?.status || state.status;
  const hasOutput = remediation ? false : state.verifiedOutput;
  const approvalBoundary = {
    workMethod: snapshot?.workMethod?.approval || null,
    jobProfile: Array.isArray(snapshot?.jobProfile?.boundaries)
      ? snapshot.jobProfile.boundaries
      : [],
  };
  const skillSources = {
    core: [...new Set(coreSkills.map(item => item?.source).filter(Boolean))],
    historical: snapshot?.provenance?.historicalSkills || null,
    custom: [...new Set(customSkills.map(item => item?.source).filter(Boolean))],
  };
  const outputProvenance = canViewProfile
    ? {
        profileVersion: row.profile_version || '',
        promptHash: row.prompt_hash || '',
        persisted: true,
        reviewRequired: row.status === '待审阅',
      }
    : {
        persisted: true,
        reviewRequired: row.status === '待审阅',
      };
  const execution = canViewProfile
    ? {
        profileVersion: row.profile_version || snapshot?.profileVersion || '',
        promptHash: row.prompt_hash || snapshot?.promptHash || '',
        snapshot: {
          schemaVersion: snapshot?.schemaVersion || null,
          messageMode: snapshot?.messageMode || null,
          employee: snapshot?.employee || null,
          capabilities,
          workMethod: snapshot?.workMethod || null,
          workConfig: snapshot?.workConfig || null,
          skills: {
            core: coreSkills,
            historical: historicalSkills,
            custom: customSkills,
          },
          skillSources,
          jobProfile: snapshot?.jobProfile || null,
          approvalBoundary,
          promptCompilation: snapshot?.promptCompilation || null,
          provenance: snapshot?.provenance || null,
        },
      }
    : redactedExecution();

  res.set('Cache-Control', 'private, no-store');
  return res.json({
    source: 'content_solo',
    sourceLabel: SOURCE_LABELS.content_solo,
    domain: 'content_solo',
    evidenceKind: contentSoloEvidence(publicStatus, hasOutput),
    record: {
      id: Number(row.id),
      title: row.title || `内容员工派活 #${row.id}`,
      type: row.type || '岗位交付',
      status: publicStatus,
      displayStatus: displayStatus(publicStatus),
      nextAction: publicNextAction(publicStatus, req.user),
      ...(remediation || {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      dueAt: row.due_at,
      group: row.employee_group || 'Paihuo内容生产部',
      employeeIdx: Number(row.employee_idx),
      employeeKey: row.employee_key || '',
      employee: row.employee_name || '内容员工',
      person: null,
      operator: row.operator_name || '-',
      inputSummary: row.requirement || '',
      inputs: {
        title: row.title || '',
        type: row.type || '',
        requirement: row.requirement || '',
        dueAt: row.due_at || null,
      },
    },
    output: result ? {
      body: projectInternalProfileOutput(result, internalProfileLeakage, req.user),
      status: publicStatus,
      displayStatus: displayStatus(publicStatus),
      aiMode: row.ai_mode || null,
      model: row.model || null,
      provenance: outputProvenance,
    } : null,
    execution,
    disclaimer: '这是当前门店内单个内容员工的一次可追溯运行记录；模板、契约失败或仅有正文的记录都不算合格产出，待人工审阅不代表已通过或已发布，本记录也不归因营业额、利润、订单或顾客转化。',
  });
});

r.get('/drill/content/:recordId', (req, res) => {
  const match = String(req.params.recordId || '').match(/^(output|media)-(\d{1,15})$/);
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1) {
    return res.status(404).json({ error: '内容生产仓记录不存在' });
  }
  const [, kind, rawId] = match;
  const id = Number(rawId);

  if (kind === 'output') {
    const scope = userScopeClause(req.user, 'c.creator_id');
    const row = q.get(`SELECT
        c.*,u.name operator_name
      FROM contents c
      LEFT JOIN users u ON u.id=c.creator_id AND u.tenant_id=c.tenant_id
      WHERE c.tenant_id=? AND c.id=? AND c.content_employee_idx IS NOT NULL${scope.sql}`,
    curTenant(), id, ...scope.params);
    if (!row) return res.status(404).json({ error: '内容生产仓记录不存在或无权查看' });
    const employee = contentEmployeeByIdx(Number(row.content_employee_idx));
    const state = storedContentState(row);
    res.set('Cache-Control', 'private, no-store');
    return res.json({
      source: 'content',
      sourceLabel: SOURCE_LABELS.content,
      domain: 'content_output',
      evidenceKind: storedContentEvidence(state),
      record: {
        id: row.id,
        title: row.title || row.topic || `内容#${row.id}`,
        type: row.type || '内容成品',
        status: state.status,
        displayStatus: displayStatus(state.status),
        nextAction: publicNextAction(state.status, req.user),
        createdAt: row.created_at,
        group: row.content_employee_group || employee?.group || '内容生产部',
        employeeIdx: Number(row.content_employee_idx),
        employeeKey: row.content_employee_key || employee?.key || '',
        employee: row.content_employee_name || employee?.name || '内容员工',
        person: null,
        operator: row.operator_name || '-',
        inputSummary: [row.topic && `主题：${row.topic}`, row.brand && `品牌：${row.brand}`].filter(Boolean).join('；'),
        inputs: { topic: row.topic || '', brand: row.brand || '', contentType: row.type || '' },
      },
      output: {
        id: row.id,
        title: row.title,
        body: row.body || '',
        status: state.status,
        displayStatus: displayStatus(state.status),
        aiMode: row.ai_mode,
        riskLevel: row.risk_level || 'none',
        riskFlags: safeJsonParse(row.risk_flags, []),
        provenance: {
          executionMode: row.content_run_mode || 'single_station',
          employeeKey: row.content_employee_key || employee?.key || '',
          persisted: true,
        },
      },
      disclaimer: '这是单个内容员工名下的生成记录，不表示内容部十个工位已串行执行；发布效果仍需用真实平台与经营数据核验。',
    });
  }

  const scope = userScopeClause(req.user, 'j.user_id');
  const row = q.get(`SELECT j.*,u.name operator_name
    FROM media_jobs j
    LEFT JOIN users u ON u.id=j.user_id AND u.tenant_id=j.tenant_id
    WHERE j.tenant_id=? AND j.id=? AND j.content_employee_idx IS NOT NULL
      AND j.kind IN ('image','video')${scope.sql}`,
  curTenant(), id, ...scope.params);
  if (!row) return res.status(404).json({ error: '内容生产仓记录不存在或无权查看' });
  const employee = contentEmployeeByIdx(Number(row.content_employee_idx));
  const mediaState = mediaRecordState(row, req.user);
  const mediaStatus = mediaState.status;
  res.set('Cache-Control', 'private, no-store');
  return res.json({
    source: 'content',
    sourceLabel: SOURCE_LABELS.content,
    domain: 'content_media',
    evidenceKind: mediaStatus === STATUS.approved
      ? '已人工验收媒体产出'
      : mediaStatus === STATUS.reviewPending
        ? '待人工审阅媒体产出'
        : mediaStatus === STATUS.reconciliationPending
          ? '待账务对账媒体记录'
          : '媒体运行状态',
    record: {
      id: row.id,
      title: String(row.prompt || '').slice(0, 80) || `媒体任务#${row.id}`,
      type: row.kind === 'video' ? 'AI视频' : row.kind === 'image' ? 'AI图片' : row.kind || '媒体任务',
      status: mediaStatus,
      displayStatus: displayStatus(mediaStatus),
      nextAction: publicNextAction(mediaStatus, req.user, { canReview: mediaState.media.canImport === true }),
      createdAt: row.created_at,
      group: row.content_employee_group || employee?.group || '内容生产部',
      employeeIdx: Number(row.content_employee_idx),
      employeeKey: row.content_employee_key || employee?.key || '',
      employee: row.content_employee_name || employee?.name || '内容员工',
      person: null,
      operator: row.operator_name || '-',
      inputSummary: row.prompt || '',
      inputs: { prompt: row.prompt || '', model: row.model || '', kind: row.kind || '' },
    },
    output: {
      body: row.status === '成功' ? '媒体任务已完成，文件地址保存在运行记录中。' : (row.error || '媒体任务尚未完成。'),
      ...(mediaState.media.businessUsable && mediaState.media.url
        ? { artifactUrl: mediaState.media.url }
        : {}),
      error: row.error || null,
      provenance: {
        executionMode: row.content_run_mode || 'single_station',
        employeeKey: row.content_employee_key || employee?.key || '',
        model: row.model || '',
        persisted: true,
        billingState: mediaState.media.billing?.state || null,
        reviewStatus: mediaState.media.reviewStatus,
      },
    },
    disclaimer: '这是单个内容员工名下的媒体任务，不表示内容部十个工位已串行执行；成功状态也不代表已经发布或产生经营成效。',
  });
});

export default r;

import crypto from 'node:crypto';

import { db, q } from '../db.js';
import { safeJsonParse } from '../util.js';
import { canonicalContentEmployeeProfileFor } from './canonical-employee-profile.js';
import { validateContentEmployeeOutputContract } from './content-output-contract.js';
import { billing } from './credits.js';
import {
  createInternalProfileLeakGuard,
  inspectInternalProfileLeakage,
} from './internal-profile-leakage.js';
import { inspectRestaurantOutputAudit } from './restaurant-output-contract.js';

const ACTIVE_STATUS = new Set(['生成中', '运行中', '处理中', 'running']);
const CONTENT_PIPELINE_REF_TYPE = 'content_production_pipeline_station';
const CONTENT_SPECIAL_PROVIDER_REF_TYPE = 'content_special_provider';
const STALE_MINUTES = Object.freeze({
  content_employee_run: 15,
  agent_task: 35,
  [CONTENT_PIPELINE_REF_TYPE]: 35,
  [CONTENT_SPECIAL_PROVIDER_REF_TYPE]: 35,
});

function jsonObject(value) {
  const parsed = safeJsonParse(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function positiveUsage(value) {
  const usage = value && typeof value === 'object' ? value : {};
  const inputTokens = Number(usage.inputTokens || 0);
  const outputTokens = Number(usage.outputTokens || 0);
  return {
    inputTokens,
    outputTokens,
    valid: Number.isSafeInteger(inputTokens) && inputTokens > 0
      && Number.isSafeInteger(outputTokens) && outputTokens > 0,
  };
}

function blockedModel(value) {
  const model = String(value || '').trim();
  return !model
    || /(?:^|[_-])(?:template|fallback|failed|error|mock|fixture|demo|degraded|unknown|inherit)(?:$|[_-])/iu.test(model);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
  );
}

function fingerprint(value) {
  return `sha256:${crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(value)), 'utf8')
    .digest('hex')}`;
}

function reconciliationError(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

export function decodeContentPipelineStationRef(refId) {
  const value = Number(refId);
  if (!Number.isSafeInteger(value) || value <= 10) return null;
  const encoded = value - 1;
  const stationIdx = encoded % 10;
  const pipelineId = (encoded - stationIdx) / 10;
  if (!Number.isSafeInteger(pipelineId) || pipelineId <= 0
    || !Number.isInteger(stationIdx) || stationIdx < 0 || stationIdx > 9) {
    return null;
  }
  return { pipelineId, stationIdx };
}

function pipelineContractOutput(stationIdx, output) {
  if (!isRecord(output)) return output;
  const value = structuredClone(output);
  // 流水线在岗位契约校验通过后才附加这些内部选中标记；复核原岗位
  // contract 时必须剥离，不能把流水线元数据误判成模型输出未知字段。
  delete value.selection;
  if (stationIdx === 0) delete value.selected;
  if (stationIdx === 5) delete value.selected_image;
  if (stationIdx === 6) delete value.selected_cover;
  return value;
}

function pipelineLeakageReport(stationIdx, output) {
  const profile = canonicalContentEmployeeProfileFor(stationIdx);
  const guard = createInternalProfileLeakGuard({
    scope: `content_pipeline_station:${stationIdx}`,
    profileVersion: profile.version?.profile || '',
    sources: [
      { category: 'capabilities', value: profile.capabilities },
      { category: 'skills', value: profile.skills },
      { category: 'work_method', value: profile.workMethod },
      { category: 'work_config', value: profile.workConfig },
      { category: 'prompts', value: profile.prompts },
      { category: 'job_profile', value: profile.jobProfile },
    ],
  });
  return inspectInternalProfileLeakage(JSON.stringify(output), guard);
}

function contentEmployeeEvidence(tenantId, refId) {
  const run = q.get(`SELECT * FROM content_employee_runs
    WHERE tenant_id=? AND id=?`, tenantId, refId);
  if (!run) {
    return {
      kind: 'content_employee_run',
      exists: false,
      label: `内容员工运行 #${refId}`,
      status: '业务记录缺失',
      hasOutput: false,
      deliveryValid: false,
      usage: positiveUsage(null),
      model: '',
      errors: ['业务运行记录不存在，不能推断已经交付'],
    };
  }
  const snapshot = jsonObject(run.snapshot_json);
  const provider = jsonObject(snapshot.providerAttempt);
  const usage = positiveUsage(provider.usage);
  const leakage = jsonObject(snapshot.internalProfileLeakage);
  const hasOutput = Boolean(String(run.result_md || '').trim());
  const runtime = hasOutput
    ? validateContentEmployeeOutputContract(
        Number(run.employee_idx),
        isRecord(snapshot.validatedOutput) ? snapshot.validatedOutput : run.result_md,
        {
        requirement: run.requirement,
        feedback: snapshot?.task?.feedback || snapshot?.dispatch?.feedback || '',
        web: snapshot.web,
        enforceRequiredInputs: true,
        outputForCompletionGate: snapshot.parsedOutput || {},
        },
      )
    : { valid: false, errors: ['没有可复核的岗位主产物'] };
  const model = String(provider.model || run.model || '').trim();
  const deliveryValid = hasOutput
    && run.ai_mode === 'api'
    && provider.mode === 'api'
    && !blockedModel(model)
    && usage.valid
    && runtime.valid === true
    && snapshot.contractValid === true
    && leakage.detected === false;
  return {
    kind: 'content_employee_run',
    exists: true,
    label: `${run.employee_name || '内容员工'} · ${run.title || `运行 #${run.id}`}`,
    status: run.status,
    active: ACTIVE_STATUS.has(String(run.status || '')),
    hasOutput,
    deliveryValid,
    usage,
    model,
    errors: deliveryValid
      ? []
      : [
          ...(hasOutput ? [] : ['没有持久化主产物']),
          ...(run.ai_mode === 'api' && provider.mode === 'api' ? [] : ['缺少真实 API 来源证据']),
          ...(!blockedModel(model) ? [] : ['模型证据缺失或属于降级/测试模型']),
          ...(usage.valid ? [] : ['缺少可结算的正 token 用量']),
          ...(runtime.valid ? [] : (runtime.errors || ['岗位语义契约未通过'])),
          ...(snapshot.contractValid === true ? [] : ['运行快照未标记契约通过']),
          ...(leakage.detected === false ? [] : ['内部岗位档案防泄漏证据未通过']),
        ].slice(0, 12),
  };
}

function restaurantTaskEvidence(tenantId, refId) {
  const task = q.get(`SELECT t.*,s.employee_idx,s.key employee_key,
      c.body output_body,c.ai_mode output_ai_mode,c.status output_status
    FROM agent_tasks t
    LEFT JOIN specialists s ON s.id=t.specialist_id
    LEFT JOIN contents c ON c.tenant_id=t.tenant_id AND c.id=t.output_id
    WHERE t.tenant_id=? AND t.id=?`, tenantId, refId);
  if (!task) {
    return {
      kind: 'agent_task', exists: false, label: `餐饮员工任务 #${refId}`,
      status: '业务记录缺失', hasOutput: false, deliveryValid: false,
      usage: positiveUsage(null), model: '', errors: ['业务任务记录不存在，不能推断已经交付'],
    };
  }
  const evidence = jsonObject(task.employee_web_snapshot);
  const provider = jsonObject(evidence.providerAttempt);
  const usage = positiveUsage(provider.usage);
  const model = String(provider.model || '').trim();
  const hasOutput = Number(task.output_id) > 0 && Boolean(String(task.output_body || '').trim());
  const audit = hasOutput
    ? inspectRestaurantOutputAudit({
        employeeProfileVersion: task.employee_profile_version,
        aiMode: task.output_ai_mode,
        executionEvidence: evidence,
        employeeIdx: Number(task.employee_idx),
        taskTitle: task.title,
        taskRequirement: task.requirement,
        outputBody: task.output_body,
      })
    : { valid: false, error: '没有可复核的岗位主产物' };
  const deliveryValid = hasOutput
    && provider.mode === 'api'
    && !blockedModel(model)
    && usage.valid
    && audit.valid === true;
  return {
    kind: 'agent_task',
    exists: true,
    label: `${task.title || `餐饮员工任务 #${task.id}`}`,
    status: task.status,
    active: ACTIVE_STATUS.has(String(task.status || '')),
    hasOutput,
    deliveryValid,
    usage,
    model,
    errors: deliveryValid
      ? []
      : [
          ...(hasOutput ? [] : ['没有持久化主产物']),
          ...(provider.mode === 'api' ? [] : ['缺少真实 API 来源证据']),
          ...(!blockedModel(model) ? [] : ['模型证据缺失或属于降级/测试模型']),
          ...(usage.valid ? [] : ['缺少可结算的正 token 用量']),
          ...(audit.valid ? [] : [audit.error || '岗位语义契约未通过']),
        ].slice(0, 12),
  };
}

function contentPipelineStationEvidence(tenantId, refId, holdRow = {}) {
  const decoded = decodeContentPipelineStationRef(refId);
  if (!decoded) {
    return {
      kind: CONTENT_PIPELINE_REF_TYPE,
      exists: false,
      label: `内容流水线工位 #${refId}`,
      status: '业务引用无效',
      active: false,
      hasOutput: false,
      deliveryValid: false,
      releaseSafe: false,
      usage: positiveUsage(null),
      model: '',
      errors: ['流水线工位计费引用无法解码，禁止推断结算或退款'],
    };
  }
  const { pipelineId, stationIdx } = decoded;
  const row = q.get(`SELECT
      s.status station_status,s.output_json,s.handler_evidence_json,
      s.billing_evidence_json,s.context_snapshot_json,s.failure_json station_failure_json,
      s.started_at,s.updated_at station_updated_at,
      j.title,j.status job_status,j.current_station,j.pending_station,j.task_json,
      j.persona_json,j.settings_json,j.workflow_json,j.failure_json job_failure_json,
      j.updated_at job_updated_at
    FROM content_production_pipeline_stations s
    JOIN content_production_pipeline_jobs j
      ON j.tenant_id=s.tenant_id AND j.id=s.pipeline_id
    WHERE s.tenant_id=? AND s.pipeline_id=? AND s.station_idx=?`,
  tenantId, pipelineId, stationIdx);
  if (!row) {
    return {
      kind: CONTENT_PIPELINE_REF_TYPE,
      exists: false,
      label: `内容流水线 #${pipelineId} · 工位 ${stationIdx}`,
      status: '业务记录缺失',
      active: false,
      hasOutput: false,
      deliveryValid: false,
      releaseSafe: false,
      usage: positiveUsage(null),
      model: '',
      pipelineId,
      stationIdx,
      errors: ['同租户流水线或工位记录不存在，禁止推断结算或退款'],
    };
  }

  const output = safeJsonParse(row.output_json, null);
  const contractOutput = pipelineContractOutput(stationIdx, output);
  const handler = jsonObject(row.handler_evidence_json);
  const productionRuntime = jsonObject(handler.productionRuntime);
  const provider = jsonObject(handler.providerDelivery || productionRuntime.providerDelivery);
  const billingEvidence = jsonObject(row.billing_evidence_json);
  const contextSnapshot = jsonObject(row.context_snapshot_json);
  const handlerLoad = jsonObject(handler.runtimePackageLoad);
  const contextLoad = jsonObject(contextSnapshot.runtimePackageLoad);
  const webEvidence = jsonObject(productionRuntime.web);
  const task = jsonObject(row.task_json);
  const persona = jsonObject(row.persona_json);
  const settings = jsonObject(row.settings_json);
  const workflow = jsonObject(row.workflow_json);
  const upstream = Object.fromEntries(q.all(`SELECT station_idx,output_json
      FROM content_production_pipeline_stations
      WHERE tenant_id=? AND pipeline_id=? AND station_idx<? AND status='completed'
      ORDER BY station_idx`, tenantId, pipelineId, stationIdx)
    .map(item => [Number(item.station_idx), safeJsonParse(item.output_json, {})]));
  const usage = positiveUsage(provider.usage);
  const model = String(provider.model || '').trim();
  const hasOutput = isRecord(output);
  let contract = { valid: false, errors: ['没有可复核的工位主产物'] };
  let leakage = { detected: true, reasons: ['leakage_check_unavailable'] };
  let canonicalFingerprint = '';
  if (hasOutput) {
    try {
      contract = validateContentEmployeeOutputContract(stationIdx, contractOutput, {
        title: task.direction || row.title || '',
        requirement: JSON.stringify({
          brief: task,
          outputs: upstream,
          persona,
          companyProfile: jsonObject(settings.companyProfile),
        }),
        feedback: '',
        trustedEvidence: workflow.trustedEvidence,
        ...(webEvidence.verified === true ? {
          web: {
            verified: true,
            results: Array.isArray(webEvidence.results) ? webEvidence.results : [],
          },
        } : {}),
        // 与生产 pipeline handler 的原始岗位 contract 调用保持一致；流水线
        // 上游由数据库完整性门禁另行保证，不启用单独派活的缺料语义。
        enforceRequiredInputs: false,
      });
      const canonical = canonicalContentEmployeeProfileFor(stationIdx);
      canonicalFingerprint = String(canonical.fingerprints?.aggregate || '');
      leakage = pipelineLeakageReport(stationIdx, contractOutput);
    } catch (error) {
      contract = {
        valid: false,
        errors: [`岗位契约复核异常：${String(error?.message || error).slice(0, 180)}`],
      };
    }
  }

  const expectedOutputFingerprint = hasOutput ? fingerprint(contractOutput) : '';
  const providerFingerprintValid = Boolean(expectedOutputFingerprint)
    && provider.outputFingerprint === expectedOutputFingerprint;
  const runtimePackageValid = handler.completed === true
    && Number(handler.employeeIdx) === stationIdx
    && handler.executionMode === 'pipeline'
    && handlerLoad.allRequiredFieldsLoaded === true
    && handlerLoad.fullCanonicalObjectInSystemMessage === true
    && Boolean(canonicalFingerprint)
    && handlerLoad.aggregateFingerprint === canonicalFingerprint
    && contextLoad.aggregateFingerprint === canonicalFingerprint;
  const webValid = stationIdx > 2 || (
    webEvidence.required === true
    && webEvidence.verified === true
    && Array.isArray(webEvidence.results)
    && webEvidence.results.length > 0
  );
  const providerValid = provider.mode === 'api'
    && provider.validated === true
    && !blockedModel(model)
    && usage.valid
    && providerFingerprintValid;
  const linkedBilling = Number(billingEvidence.holdId) === Number(holdRow.id)
    && Number(holdRow.id) > 0
    && (
      billingEvidence.pendingReconciliation === true
      || ['pending_reconciliation', 'held'].includes(String(
        billingEvidence.state || billingEvidence.status || '',
      ))
    );
  const resumeStationStatus = String(billingEvidence.resumeStationStatus || '');
  const resumable = ['completed', 'awaiting_approval'].includes(resumeStationStatus);
  const active = row.job_status === 'running' || row.station_status === 'running';
  const settleStateValid = row.job_status === 'billing_pending'
    && row.station_status === 'billing_pending'
    && Number(row.current_station) === stationIdx
    && resumable;
  const releaseStateValid = (
    row.job_status === 'billing_pending'
      && row.station_status === 'billing_pending'
      && Number(row.current_station) === stationIdx
  ) || (
    row.job_status === 'failed'
      && row.station_status === 'failed'
      && Number(row.current_station) === stationIdx
  );
  const deliveryValid = hasOutput
    && settleStateValid
    && linkedBilling
    && runtimePackageValid
    && webValid
    && providerValid
    && contract.valid === true
    && leakage.detected === false;
  const releaseSafe = linkedBilling && releaseStateValid && !deliveryValid;
  const errors = deliveryValid ? [] : [
    ...(hasOutput ? [] : ['没有持久化工位主产物']),
    ...(linkedBilling ? [] : ['工位账务证据未唯一关联当前预授权']),
    ...(settleStateValid || releaseStateValid ? [] : ['流水线与工位状态不属于可对账状态']),
    ...(runtimePackageValid ? [] : ['完整员工包、工位身份或运行证据未通过']),
    ...(webValid ? [] : ['强制联网工位缺少已核验联网证据']),
    ...(provider.mode === 'api' ? [] : ['缺少真实 API 来源证据']),
    ...(provider.validated === true ? [] : ['供应商输出未标记为通过岗位校验']),
    ...(!blockedModel(model) ? [] : ['模型证据缺失或属于降级/测试模型']),
    ...(usage.valid ? [] : ['缺少可结算的正 token 用量']),
    ...(providerFingerprintValid ? [] : ['供应商输出指纹与持久化主产物不一致']),
    ...(contract.valid ? [] : (contract.errors || ['岗位语义契约未通过'])),
    ...(leakage.detected === false ? [] : ['内部岗位档案防泄漏复核未通过']),
  ].slice(0, 16);

  return {
    kind: CONTENT_PIPELINE_REF_TYPE,
    exists: true,
    label: `内容流水线 #${pipelineId} · 工位 ${stationIdx}`,
    status: `${row.job_status}/${row.station_status}`,
    active,
    hasOutput,
    deliveryValid,
    releaseSafe,
    usage,
    model,
    errors,
    pipelineId,
    stationIdx,
    stationStatus: row.station_status,
    jobStatus: row.job_status,
    currentStation: Number(row.current_station),
    pendingStation: row.pending_station == null ? null : Number(row.pending_station),
    resumeStationStatus: resumable ? resumeStationStatus : null,
    linkedHoldId: Number(billingEvidence.holdId || 0) || null,
    outputFingerprint: expectedOutputFingerprint || null,
    contractValid: contract.valid === true,
    leakageClear: leakage.detected === false,
    stationFailure: safeJsonParse(row.station_failure_json, null),
    jobFailure: safeJsonParse(row.job_failure_json, null),
    billingEvidence,
    contextSnapshot,
  };
}

function reconciliationTableExists(name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name=?`).get(name));
}

function rawSha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function specialProviderEntries(output) {
  if (!isRecord(output)) return [];
  const entries = [
    ...(Array.isArray(output.images) ? output.images : []),
    ...(Array.isArray(output.assets) ? output.assets : []),
  ];
  if (!entries.length && (output.url || output.b64 || output.content)) entries.push(output);
  return entries.filter(isRecord);
}

function specialProviderEntrySource(entry) {
  const url = String(entry?.url || entry?.file || '').trim();
  if (url) return url;
  if (typeof entry?.b64 === 'string' && entry.b64) {
    return `data:${String(entry.mimeType || entry.mime_type || 'image/png')};base64,${entry.b64}`;
  }
  return typeof entry?.content === 'string' ? entry.content : '';
}

function specialMaterialAuthorizationValid(providerKind, output, provider) {
  if (providerKind === 'image') return true;
  const evidence = jsonObject(
    output.authorizationEvidence
      || output.licenseEvidence
      || provider.authorizationEvidence
      || provider.licenseEvidence,
  );
  return evidence.verified === true
    && Boolean(String(evidence.provider || evidence.source || evidence.licenseId || '').trim());
}

function specialProviderArtifactAudit({
  tenantId,
  pipelineId,
  stationIdx,
  attemptId,
  refId,
  providerKind,
  model,
  output,
  delivery,
}) {
  const artifactIds = Array.isArray(delivery.artifactIds) ? delivery.artifactIds : [];
  const parsedIds = artifactIds.map(value => {
    const match = /^material:([1-9]\d*)$/u.exec(String(value || ''));
    return match ? Number(match[1]) : null;
  });
  const outputEntries = specialProviderEntries(output);
  const results = [];
  for (const [index, materialId] of parsedIds.entries()) {
    if (!Number.isSafeInteger(materialId)) {
      results.push({ materialId: null, valid: false, reason: '产物ID不是material:正整数' });
      continue;
    }
    const material = q.get(`SELECT id,tenant_id,url,body_snapshot,source_type,source_id,
        artifact_snapshot_json,snapshot_hash
      FROM materials WHERE tenant_id=? AND id=?`, tenantId, materialId);
    const snapshot = jsonObject(material?.artifact_snapshot_json);
    const actualSource = String(material?.url || '').trim()
      || (typeof material?.body_snapshot === 'string' ? material.body_snapshot : '');
    const actualSha256 = actualSource ? rawSha256(actualSource) : '';
    const outputSource = specialProviderEntrySource(outputEntries[index]);
    const expectedSha256 = outputSource ? rawSha256(outputSource) : '';
    const valid = Boolean(material)
      && Number(material.tenant_id) === Number(tenantId)
      && material.source_type === 'content_pipeline_provider'
      && Number(material.source_id) === Number(pipelineId)
      && snapshot.schemaVersion === 'nanowork.content-pipeline-provider-artifact/2'
      && snapshot.attemptId === attemptId
      && Number(snapshot.pipelineId) === Number(pipelineId)
      && Number(snapshot.employeeIdx) === Number(stationIdx)
      && snapshot.kind === providerKind
      && snapshot.billingRefType === CONTENT_SPECIAL_PROVIDER_REF_TYPE
      && Number(snapshot.billingRefId) === Number(refId)
      && snapshot.model === model
      && /^[a-f0-9]{64}$/u.test(String(snapshot.contentSha256 || ''))
      && snapshot.contentSha256 === actualSha256
      && String(material.snapshot_hash || '') === actualSha256
      && Boolean(expectedSha256)
      && expectedSha256 === actualSha256;
    results.push({
      materialId,
      valid,
      contentSha256: actualSha256 || null,
      reason: valid ? null : '素材租户、attempt、计费引用或内容哈希不一致',
    });
  }
  const idsComplete = artifactIds.length > 0
    && parsedIds.every(Number.isSafeInteger)
    && new Set(parsedIds).size === parsedIds.length;
  const deliveryComplete = delivery.persisted === true
    && delivery.targetType === 'material'
    && Number(delivery.targetId) === parsedIds[0]
    && idsComplete;
  const outputComplete = outputEntries.length === artifactIds.length
    && outputEntries.length > 0
    && outputEntries.every(entry => Boolean(specialProviderEntrySource(entry)));
  return {
    artifactIds: artifactIds.map(String),
    materialIds: results.filter(item => Number.isSafeInteger(item.materialId))
      .map(item => item.materialId),
    contentSha256: results.map(item => item.contentSha256),
    deliveryComplete,
    outputComplete,
    valid: deliveryComplete && outputComplete && results.length === artifactIds.length
      && results.every(item => item.valid),
    errors: results.filter(item => !item.valid).map(item => item.reason),
  };
}

function contentSpecialProviderEvidence(tenantId, refId, holdRow = {}) {
  const requiredTables = [
    'content_pipeline_special_provider_attempts',
    'content_production_pipeline_stations',
    'content_production_pipeline_jobs',
    'materials',
  ];
  if (!requiredTables.every(reconciliationTableExists)) {
    return {
      kind: CONTENT_SPECIAL_PROVIDER_REF_TYPE,
      exists: false,
      label: `特殊图片Provider #${refId}`,
      status: '业务证据表未就绪',
      active: false,
      hasOutput: null,
      deliveryValid: false,
      releaseSafe: false,
      usage: positiveUsage(null),
      model: '',
      errors: ['特殊provider证据表不完整，禁止推断结算或退款'],
    };
  }
  const reference = Number(refId);
  const attempts = q.all(`SELECT a.*,
      s.status station_status,s.billing_evidence_json station_billing_evidence_json,
      s.context_snapshot_json station_context_snapshot_json,s.failure_json station_failure_json,
      j.status job_status,j.current_station,j.pending_station,j.failure_json job_failure_json
    FROM content_pipeline_special_provider_attempts a
    LEFT JOIN content_production_pipeline_stations s
      ON s.tenant_id=a.tenant_id AND s.pipeline_id=a.pipeline_id AND s.station_idx=a.station_idx
    LEFT JOIN content_production_pipeline_jobs j
      ON j.tenant_id=a.tenant_id AND j.id=a.pipeline_id
    WHERE a.tenant_id=? AND a.billing_ref_type=? AND a.billing_ref_id=?`,
  tenantId, CONTENT_SPECIAL_PROVIDER_REF_TYPE, reference);
  if (attempts.length !== 1) {
    return {
      kind: CONTENT_SPECIAL_PROVIDER_REF_TYPE,
      exists: attempts.length > 0,
      label: `特殊图片Provider #${refId}`,
      status: attempts.length ? '业务引用不唯一' : '业务记录缺失',
      active: false,
      hasOutput: null,
      deliveryValid: false,
      releaseSafe: false,
      usage: positiveUsage(null),
      model: '',
      attemptCount: attempts.length,
      errors: [attempts.length
        ? '同租户refType/refId未唯一，禁止处理'
        : '同租户特殊provider attempt不存在，禁止推断退款'],
    };
  }

  const row = attempts[0];
  const output = safeJsonParse(row.output_json, null);
  const delivery = jsonObject(row.delivery_json);
  const attemptBilling = jsonObject(row.billing_json);
  const attemptError = jsonObject(row.error_json);
  const provider = jsonObject(output?.provider);
  const model = String(output?.model || provider.model || '').trim();
  const mode = String(output?.mode || provider.mode || '').trim();
  const stationBillingEvidence = jsonObject(row.station_billing_evidence_json);
  const stationContextSnapshot = jsonObject(row.station_context_snapshot_json);
  const specialComponents = Array.isArray(stationBillingEvidence.components?.specialProviders)
    ? stationBillingEvidence.components.specialProviders.filter(isRecord)
    : [];
  const component = specialComponents.find(item => (
    item.attemptId === row.attempt_id
    && Number(item.refId) === reference
    && Number(item.holdId) === Number(holdRow.id)
  ));
  const stationAttemptRows = q.all(`SELECT attempt_id,billing_ref_id,hold_id,status
    FROM content_pipeline_special_provider_attempts
    WHERE tenant_id=? AND pipeline_id=? AND station_idx=?
      AND hold_id IS NOT NULL AND status IN ('persisted','pending_reconciliation')`,
  tenantId, row.pipeline_id, row.station_idx);
  const stationComponentsComplete = stationAttemptRows.every(attempt => (
    specialComponents.some(item => (
      item.attemptId === attempt.attempt_id
      && Number(item.refId) === Number(attempt.billing_ref_id)
      && Number(item.holdId) === Number(attempt.hold_id)
    ))
  ));
  const artifactAudit = specialProviderArtifactAudit({
    tenantId,
    pipelineId: Number(row.pipeline_id),
    stationIdx: Number(row.station_idx),
    attemptId: row.attempt_id,
    refId: reference,
    providerKind: row.provider_kind,
    model,
    output,
    delivery,
  });
  const billingComplete = Number(row.hold_id) === Number(holdRow.id)
    && Number(attemptBilling.holdId) === Number(holdRow.id)
    && Number(attemptBilling.estimatedCredits) === Number(holdRow.held_credits)
    && Number(attemptBilling.heldCredits) === Number(holdRow.held_credits)
    && attemptBilling.pendingReconciliation === true
    && attemptBilling.state === 'pending_reconciliation';
  const componentComplete = Boolean(component)
    && component.refType === CONTENT_SPECIAL_PROVIDER_REF_TYPE
    && component.kind === row.provider_kind
    && component.delivery?.persisted === true
    && Number(component.billing?.holdId || component.holdId) === Number(holdRow.id);
  const providerValid = mode === 'api'
    && provider.mode === 'api'
    && !blockedModel(model)
    && String(holdRow.model || '') === model;
  const materialAuthorizationValid = specialMaterialAuthorizationValid(
    row.provider_kind,
    isRecord(output) ? output : {},
    provider,
  );
  const fixedPriceValid = row.provider_kind === 'image';
  const attemptStateValid = ['persisted', 'pending_reconciliation'].includes(row.status);
  const billingPendingState = row.station_status === 'billing_pending'
    && row.job_status === 'billing_pending'
    && Number(row.current_station) === Number(row.station_idx);
  const failedPipelineState = row.station_status === 'failed'
    && row.job_status === 'failed'
    && Number(row.current_station) === Number(row.station_idx);
  const pipelineStateValid = billingPendingState || failedPipelineState;
  const hasOutput = isRecord(output) && Object.keys(output).length > 0;
  const hasDelivery = Object.keys(delivery).length > 0;
  const deliveryValid = attemptStateValid
    && billingComplete
    && componentComplete
    && stationComponentsComplete
    && pipelineStateValid
    && artifactAudit.valid
    && providerValid
    && materialAuthorizationValid
    && fixedPriceValid;
  const explicitNoDelivery = !hasOutput
    && !hasDelivery
    && Object.keys(attemptError).length > 0;
  const deliveryValidationFailed = (hasOutput || hasDelivery)
    && (
      !artifactAudit.outputComplete
      || !artifactAudit.deliveryComplete
      || !artifactAudit.valid
      || !providerValid
    );
  const materialAuthorizationOnlyUnknown = row.provider_kind === 'material'
    && !materialAuthorizationValid
    && artifactAudit.valid
    && providerValid;
  const releaseSafe = attemptStateValid
    && billingComplete
    && componentComplete
    && stationComponentsComplete
    && pipelineStateValid
    && !materialAuthorizationOnlyUnknown
    && (explicitNoDelivery || deliveryValidationFailed);
  const active = row.status === 'claimed'
    || row.station_status === 'running'
    || row.job_status === 'running';
  const errors = deliveryValid ? [] : [
    ...(attemptStateValid ? [] : ['attempt不在persisted/pending_reconciliation可对账状态']),
    ...(billingComplete ? [] : ['attempt账务证据未与当前预授权完整匹配']),
    ...(componentComplete ? [] : ['工位合并账务组件未关联当前attempt']),
    ...(stationComponentsComplete ? [] : ['工位特殊provider待对账组件不完整']),
    ...(pipelineStateValid ? [] : ['所属流水线工位不在可对账状态']),
    ...(artifactAudit.outputComplete ? [] : ['provider输出不完整']),
    ...(artifactAudit.deliveryComplete ? [] : ['provider交付回执不完整']),
    ...(artifactAudit.valid ? [] : ['素材内容、attempt或计费引用校验失败']),
    ...(providerValid ? [] : ['provider缺少真实API模型证据或模型与预授权不一致']),
    ...(materialAuthorizationValid ? [] : ['素材provider缺少可核验授权证据，禁止结算或凭感觉退款']),
    ...(fixedPriceValid ? [] : ['当前只有图片provider完成固定价对账契约，素材provider保持阻断']),
  ].slice(0, 16);

  return {
    kind: CONTENT_SPECIAL_PROVIDER_REF_TYPE,
    exists: true,
    label: `内容流水线 #${row.pipeline_id} · 工位 ${row.station_idx} · ${row.provider_kind} Provider`,
    status: `${row.status}/${row.job_status || 'missing'}/${row.station_status || 'missing'}`,
    active,
    hasOutput,
    deliveryValid,
    releaseSafe,
    usage: positiveUsage(null),
    model,
    errors,
    attemptCount: 1,
    attemptId: row.attempt_id,
    attemptStatus: row.status,
    providerKind: row.provider_kind,
    providerMode: mode,
    providerValid,
    materialAuthorizationValid,
    fixedPriceValid,
    billingComplete,
    componentComplete,
    stationComponentsComplete,
    artifactIds: artifactAudit.artifactIds,
    materialIds: artifactAudit.materialIds,
    contentSha256: artifactAudit.contentSha256,
    artifactsValid: artifactAudit.valid,
    outputComplete: artifactAudit.outputComplete,
    deliveryComplete: artifactAudit.deliveryComplete,
    pipelineId: Number(row.pipeline_id),
    stationIdx: Number(row.station_idx),
    stationStatus: row.station_status || null,
    jobStatus: row.job_status || null,
    currentStation: row.current_station == null ? null : Number(row.current_station),
    pendingStation: row.pending_station == null ? null : Number(row.pending_station),
    resumeStationStatus: ['completed', 'awaiting_approval'].includes(
      String(stationBillingEvidence.resumeStationStatus || ''),
    ) ? stationBillingEvidence.resumeStationStatus : null,
    linkedHoldId: Number(row.hold_id || 0) || null,
    releaseDisposition: explicitNoDelivery ? 'released' : 'failed',
    attemptBilling,
    attemptError,
    stationBillingEvidence,
    stationContextSnapshot,
    stationFailure: safeJsonParse(row.station_failure_json, null),
    jobFailure: safeJsonParse(row.job_failure_json, null),
    attemptFingerprint: fingerprint({
      attemptId: row.attempt_id,
      status: row.status,
      output,
      delivery,
      billing: attemptBilling,
      error: attemptError,
      artifactIds: artifactAudit.artifactIds,
      contentSha256: artifactAudit.contentSha256,
      stationBillingEvidence,
    }),
  };
}

function unsupportedEvidence(refType, refId) {
  return {
    kind: String(refType || 'unbound'),
    exists: null,
    label: `${refType || '未绑定业务'} #${refId || '-'}`,
    status: '需专项核验',
    active: false,
    hasOutput: null,
    deliveryValid: false,
    usage: positiveUsage(null),
    model: '',
    errors: ['该业务类型尚无统一的可交付证据提取器，系统不会猜测退款或实扣'],
  };
}

function businessEvidence(tenantId, refType, refId, holdRow = {}) {
  if (refType === 'content_employee_run') return contentEmployeeEvidence(tenantId, refId);
  if (refType === 'agent_task') return restaurantTaskEvidence(tenantId, refId);
  if (refType === CONTENT_PIPELINE_REF_TYPE) {
    return contentPipelineStationEvidence(tenantId, refId, holdRow);
  }
  if (refType === CONTENT_SPECIAL_PROVIDER_REF_TYPE) {
    return contentSpecialProviderEvidence(tenantId, refId, holdRow);
  }
  return unsupportedEvidence(refType, refId);
}

function evidenceHash(item) {
  return crypto.createHash('sha256').update(JSON.stringify({
    holdId: item.holdId,
    tenantId: item.tenantId,
    status: item.holdStatus,
    heldCredits: item.heldCredits,
    refType: item.refType,
    refId: item.refId,
    logId: item.logId,
    logCount: item.logCount,
    sameRefHoldCount: item.sameRefHoldCount,
    business: {
      status: item.business.status,
      hasOutput: item.business.hasOutput,
      deliveryValid: item.business.deliveryValid,
      releaseSafe: item.business.releaseSafe === true,
      model: item.business.model,
      usage: item.business.usage,
      errors: item.business.errors,
      pipelineId: item.business.pipelineId ?? null,
      stationIdx: item.business.stationIdx ?? null,
      stationStatus: item.business.stationStatus ?? null,
      jobStatus: item.business.jobStatus ?? null,
      currentStation: item.business.currentStation ?? null,
      pendingStation: item.business.pendingStation ?? null,
      resumeStationStatus: item.business.resumeStationStatus ?? null,
      linkedHoldId: item.business.linkedHoldId ?? null,
      outputFingerprint: item.business.outputFingerprint ?? null,
      contractValid: item.business.contractValid ?? null,
      leakageClear: item.business.leakageClear ?? null,
      attemptCount: item.business.attemptCount ?? null,
      attemptId: item.business.attemptId ?? null,
      attemptStatus: item.business.attemptStatus ?? null,
      providerKind: item.business.providerKind ?? null,
      providerMode: item.business.providerMode ?? null,
      providerValid: item.business.providerValid ?? null,
      materialAuthorizationValid: item.business.materialAuthorizationValid ?? null,
      fixedPriceValid: item.business.fixedPriceValid ?? null,
      billingComplete: item.business.billingComplete ?? null,
      componentComplete: item.business.componentComplete ?? null,
      stationComponentsComplete: item.business.stationComponentsComplete ?? null,
      artifactIds: item.business.artifactIds ?? null,
      materialIds: item.business.materialIds ?? null,
      contentSha256: item.business.contentSha256 ?? null,
      artifactsValid: item.business.artifactsValid ?? null,
      outputComplete: item.business.outputComplete ?? null,
      deliveryComplete: item.business.deliveryComplete ?? null,
      releaseDisposition: item.business.releaseDisposition ?? null,
      attemptFingerprint: item.business.attemptFingerprint ?? null,
    },
  }), 'utf8').digest('hex');
}

export function inspectAiReconciliationHold({ tenantId, holdId }) {
  const tid = Number(tenantId);
  const hid = Number(holdId);
  const row = q.get(`SELECT h.*,
      CAST((julianday('now','localtime')-julianday(h.created_at))*1440 AS INTEGER) age_minutes,
      (SELECT COUNT(*) FROM credit_logs l WHERE l.tenant_id=h.tenant_id AND l.id=h.log_id) log_count,
      (SELECT COUNT(*) FROM credit_holds hx
        WHERE hx.tenant_id=h.tenant_id
          AND COALESCE(hx.ref_type,'')=COALESCE(h.ref_type,'')
          AND COALESCE(hx.ref_id,-1)=COALESCE(h.ref_id,-1)
          AND hx.status='held') same_ref_hold_count
    FROM credit_holds h
    WHERE h.tenant_id=? AND h.id=?`, tid, hid);
  if (!row) return null;
  const business = businessEvidence(tid, row.ref_type, Number(row.ref_id), row);
  const integrityErrors = [];
  if (row.status !== 'held') integrityErrors.push('预授权已终结，无需再次对账');
  if (Number(row.log_count) !== 1) integrityErrors.push('预授权缺少唯一的同租户积分流水');
  if (Number(row.same_ref_hold_count) !== 1) integrityErrors.push('同一业务引用存在多笔占扣，需逐笔人工审计');
  const ageMinutes = Math.max(0, Number(row.age_minutes || 0));
  const staleAfter = STALE_MINUTES[row.ref_type] || null;
  const stillActive = business.active === true && staleAfter != null && ageMinutes < staleAfter;
  const actions = [];
  if (!integrityErrors.length && !stillActive && business.deliveryValid === true) {
    actions.push('settle');
  }
  if (!integrityErrors.length && !stillActive
    && (
      ['content_employee_run', 'agent_task'].includes(row.ref_type)
      || (row.ref_type === CONTENT_PIPELINE_REF_TYPE && business.releaseSafe === true)
      || (row.ref_type === CONTENT_SPECIAL_PROVIDER_REF_TYPE && business.releaseSafe === true)
    )
    && business.deliveryValid !== true) {
    actions.push('release');
  }
  const item = {
    holdId: Number(row.id),
    tenantId: Number(row.tenant_id),
    userId: Number(row.user_id),
    logId: Number(row.log_id),
    feature: row.feature,
    kind: row.kind,
    requestedModel: row.model,
    heldCredits: Number(row.held_credits || 0),
    holdStatus: row.status,
    refType: row.ref_type || null,
    refId: row.ref_id == null ? null : Number(row.ref_id),
    createdAt: row.created_at,
    ageMinutes,
    logCount: Number(row.log_count || 0),
    sameRefHoldCount: Number(row.same_ref_hold_count || 0),
    business,
    integrityErrors,
    stillActive,
    availableActions: actions,
    recommendedAction: actions.includes('settle') ? 'settle' : actions.includes('release') ? 'release' : null,
    blockedReason: integrityErrors[0]
      || (stillActive ? `业务仍在正常执行窗口内（${ageMinutes}/${staleAfter}分钟）` : null)
      || (actions.length ? null : business.errors[0] || '缺少可自动核验的业务证据'),
  };
  return { ...item, evidenceHash: evidenceHash(item) };
}

function billingStateForSettledHold(hold, attemptStatus = null) {
  if (hold.status === 'held') return 'pending_reconciliation';
  if (['released', 'failed'].includes(String(attemptStatus || ''))) return 'released';
  return Number(hold.settled_credits || 0) > 0 ? 'settled' : 'released';
}

function refreshPipelineStationBillingEvidence({
  tenantId,
  pipelineId,
  stationIdx,
  sourceEvidence,
  balance,
  reason,
  reconciledAt,
  actor,
}) {
  const evidence = structuredClone(isRecord(sourceEvidence) ? sourceEvidence : {});
  const components = isRecord(evidence.components) ? evidence.components : {};
  const stationText = isRecord(components.stationText) ? components.stationText : null;
  const specialProviders = Array.isArray(components.specialProviders)
    ? components.specialProviders.filter(isRecord).map(item => structuredClone(item))
    : [];
  const attempts = reconciliationTableExists('content_pipeline_special_provider_attempts')
    ? q.all(`SELECT attempt_id,billing_ref_id,hold_id,status
      FROM content_pipeline_special_provider_attempts
      WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND hold_id IS NOT NULL`,
    tenantId, pipelineId, stationIdx)
    : [];
  const holdIds = new Set();
  const collectHoldId = value => {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0) holdIds.add(id);
  };
  collectHoldId(evidence.holdId);
  collectHoldId(stationText?.holdId);
  specialProviders.forEach(item => collectHoldId(item.holdId || item.billing?.holdId));
  attempts.forEach(item => collectHoldId(item.hold_id));
  const holds = new Map([...holdIds].map(holdId => {
    const hold = q.get(`SELECT id,status,held_credits,settled_credits,ref_type,ref_id
      FROM credit_holds WHERE tenant_id=? AND id=?`, tenantId, holdId);
    if (!hold) {
      throw reconciliationError(
        `工位账务组件hold#${holdId}缺失，禁止恢复流水线`,
        'CONTENT_PIPELINE_RECONCILIATION_COMPONENT_HOLD_MISSING',
      );
    }
    return [holdId, hold];
  }));
  const attemptByHold = new Map(attempts.map(item => [Number(item.hold_id), item]));
  const componentBilling = (value, holdId) => {
    const hold = holds.get(Number(holdId));
    if (!hold) return isRecord(value) ? structuredClone(value) : {};
    const state = billingStateForSettledHold(hold, attemptByHold.get(Number(holdId))?.status);
    return {
      ...(isRecord(value) ? structuredClone(value) : {}),
      state,
      status: state,
      holdId: Number(hold.id),
      estimatedCredits: Number(hold.held_credits || 0),
      heldCredits: hold.status === 'held' ? Number(hold.held_credits || 0) : 0,
      chargedCredits: hold.status === 'held' ? null : Number(hold.settled_credits || 0),
      credits: hold.status === 'held' ? null : Number(hold.settled_credits || 0),
      pendingReconciliation: hold.status === 'held',
    };
  };
  const refreshedStationText = stationText
    ? componentBilling(stationText, stationText.holdId)
    : null;
  const refreshedSpecialProviders = specialProviders.map(item => {
    const holdId = Number(item.holdId || item.billing?.holdId || 0);
    const attempt = attemptByHold.get(holdId);
    return {
      ...item,
      ...(attempt ? { status: attempt.status } : {}),
      billing: componentBilling(item.billing, holdId),
    };
  });
  const pendingHolds = [...holds.values()].filter(hold => hold.status === 'held');
  const chargedCredits = [...holds.values()]
    .filter(hold => hold.status !== 'held')
    .reduce((sum, hold) => sum + Number(hold.settled_credits || 0), 0);
  const releasedComponent = [...holds.values()].some(hold => (
    billingStateForSettledHold(hold, attemptByHold.get(Number(hold.id))?.status) === 'released'
  ));
  const state = pendingHolds.length
    ? 'pending_reconciliation'
    : releasedComponent ? 'released' : 'settled';
  return {
    evidence: {
      ...evidence,
      state,
      status: state,
      pendingReconciliation: pendingHolds.length > 0,
      heldCredits: pendingHolds.reduce((sum, hold) => sum + Number(hold.held_credits || 0), 0),
      chargedCredits: pendingHolds.length ? null : chargedCredits,
      credits: pendingHolds.length ? null : chargedCredits,
      balance,
      note: pendingHolds.length
        ? `工位仍有${pendingHolds.length}笔预授权待对账，不得恢复后续工位。`
        : state === 'settled'
          ? '工位主调用与特殊provider预授权已全部完成结算。'
          : '工位存在未通过交付门禁的provider组件，流水线保持失败。',
      reconciliation: {
        reason,
        reconciledAt,
        reconciledBy: {
          id: Number(actor.id),
          name: String(actor.name || '').slice(0, 120),
          role: String(actor.role || '').slice(0, 64),
        },
      },
      components: {
        ...components,
        stationText: refreshedStationText,
        specialProviders: refreshedSpecialProviders,
      },
    },
    pendingHoldIds: pendingHolds.map(hold => Number(hold.id)),
    allTerminal: pendingHolds.length === 0,
    releasedComponent,
  };
}

function pipelineSettlementAmount(holdRow, business, action) {
  const heldCredits = Number(holdRow.held_credits || 0);
  if (!Number.isSafeInteger(heldCredits) || heldCredits <= 0) {
    throw reconciliationError(
      '流水线预授权金额无效，禁止自动处理',
      'CONTENT_PIPELINE_RECONCILIATION_HOLD_INVALID',
    );
  }
  const model = String(business.model || holdRow.model || '').trim();
  if (action === 'release') {
    return { credits: 0, costYuan: 0, inputTokens: 0, outputTokens: 0, model };
  }
  if (String(holdRow.kind || '') !== 'text'
    || blockedModel(model)
    || business.usage?.valid !== true) {
    throw reconciliationError(
      '流水线结算缺少可信文本模型或正 token 证据',
      'CONTENT_PIPELINE_RECONCILIATION_USAGE_INVALID',
    );
  }
  const config = billing();
  const price = config.text[model] || config.text.default;
  const inputTokens = Number(business.usage.inputTokens);
  const outputTokens = Number(business.usage.outputTokens);
  const costYuan = (inputTokens * Number(price.in) + outputTokens * Number(price.out)) / 1e6;
  const credits = Math.ceil((costYuan * Number(config.marginMultiplier)) / Number(config.creditYuan));
  if (!Number.isFinite(costYuan) || costYuan < 0
    || !Number.isSafeInteger(credits) || credits < 0) {
    throw reconciliationError(
      '流水线结算价格配置或计算结果无效',
      'CONTENT_PIPELINE_RECONCILIATION_PRICE_INVALID',
      500,
    );
  }
  if (credits > heldCredits) {
    if (['completed', 'awaiting_approval'].includes(String(business.resumeStationStatus || ''))) {
      return {
        credits: heldCredits,
        costYuan,
        inputTokens,
        outputTokens,
        model,
        cappedAtAuthorizedHold: true,
      };
    }
    throw reconciliationError(
      '真实用量超过预授权额度，未追加扣款，仍保留待人工专项核验',
      'BILLING_HOLD_EXCEEDED',
    );
  }
  return { credits, costYuan, inputTokens, outputTokens, model };
}

function updatePipelineAfterReconciliation({
  item,
  action,
  settlement,
  actor,
  reason,
  balance,
  reconciledAt,
}) {
  const business = item.business;
  const refreshedBilling = refreshPipelineStationBillingEvidence({
    tenantId: item.tenantId,
    pipelineId: business.pipelineId,
    stationIdx: business.stationIdx,
    sourceEvidence: business.billingEvidence,
    balance,
    reason,
    reconciledAt,
    actor,
  });
  const billingEvidence = {
    ...refreshedBilling.evidence,
    holdId: item.holdId,
    model: action === 'settle' ? settlement.model : null,
    reconciliation: {
      ...refreshedBilling.evidence.reconciliation,
      action,
    },
  };
  const contextSnapshot = {
    ...business.contextSnapshot,
    billingEvidence,
  };

  if (action === 'settle') {
    if (!refreshedBilling.allTerminal) {
      const stationChanged = q.run(`UPDATE content_production_pipeline_stations
        SET billing_evidence_json=?,context_snapshot_json=?,updated_at=?
        WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND status='billing_pending'
          AND CAST(json_extract(billing_evidence_json,'$.holdId') AS INTEGER)=?`,
      JSON.stringify(billingEvidence),
      JSON.stringify(contextSnapshot),
      reconciledAt,
      item.tenantId,
      business.pipelineId,
      business.stationIdx,
      item.holdId);
      if (Number(stationChanged.changes) !== 1) {
        throw reconciliationError(
          '流水线工位对账状态已变化，未写入组件结算结果',
          'CONTENT_PIPELINE_RECONCILIATION_STATION_CAS_FAILED',
        );
      }
      return 'billing_pending';
    }
    const stationStatus = business.resumeStationStatus;
    const nextStation = business.stationIdx + 1;
    const jobStatus = stationStatus === 'awaiting_approval'
      ? 'awaiting_approval'
      : nextStation >= 10 ? 'completed' : 'running';
    const currentStation = stationStatus === 'awaiting_approval'
      ? business.stationIdx
      : nextStation;
    const stationChanged = q.run(`UPDATE content_production_pipeline_stations
      SET status=?,billing_evidence_json=?,context_snapshot_json=?,failure_json=NULL,updated_at=?
      WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND status='billing_pending'
        AND CAST(json_extract(billing_evidence_json,'$.holdId') AS INTEGER)=?`,
    stationStatus,
    JSON.stringify(billingEvidence),
    JSON.stringify(contextSnapshot),
    reconciledAt,
    item.tenantId,
    business.pipelineId,
    business.stationIdx,
    item.holdId);
    if (Number(stationChanged.changes) !== 1) {
      throw reconciliationError(
        '流水线工位对账状态已变化，未写入恢复结果',
        'CONTENT_PIPELINE_RECONCILIATION_STATION_CAS_FAILED',
      );
    }
    const jobChanged = q.run(`UPDATE content_production_pipeline_jobs
      SET status=?,current_station=?,pending_station=?,failure_json=NULL,
          version=version+1,updated_at=?
      WHERE tenant_id=? AND id=? AND status='billing_pending' AND current_station=?`,
    jobStatus,
    currentStation,
    stationStatus === 'awaiting_approval' ? business.stationIdx : null,
    reconciledAt,
    item.tenantId,
    business.pipelineId,
    business.stationIdx);
    if (Number(jobChanged.changes) !== 1) {
      throw reconciliationError(
        '流水线任务对账状态已变化，未写入恢复结果',
        'CONTENT_PIPELINE_RECONCILIATION_JOB_CAS_FAILED',
      );
    }
    return jobStatus;
  }

  const failure = {
    ...(isRecord(business.stationFailure) ? business.stationFailure : {}),
    code: 'CONTENT_PIPELINE_RECONCILIATION_RELEASED',
    name: 'ContentPipelineReconciliationReleased',
    message: '账务对账确认工位没有通过交付门禁，预授权已退款，流水线停止在失败工位',
    stationIdx: business.stationIdx,
    reconciledAt,
    reconciliationReason: reason,
  };
  const stationChanged = q.run(`UPDATE content_production_pipeline_stations
    SET status='failed',billing_evidence_json=?,context_snapshot_json=?,failure_json=?,updated_at=?
    WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND status=?
      AND CAST(json_extract(billing_evidence_json,'$.holdId') AS INTEGER)=?`,
  JSON.stringify(billingEvidence),
  JSON.stringify(contextSnapshot),
  JSON.stringify(failure),
  reconciledAt,
  item.tenantId,
  business.pipelineId,
  business.stationIdx,
  business.stationStatus,
  item.holdId);
  if (Number(stationChanged.changes) !== 1) {
    throw reconciliationError(
      '流水线工位对账状态已变化，未写入失败结果',
      'CONTENT_PIPELINE_RECONCILIATION_STATION_CAS_FAILED',
    );
  }
  const jobChanged = q.run(`UPDATE content_production_pipeline_jobs
    SET status='failed',current_station=?,pending_station=NULL,failure_json=?,
        version=version+1,updated_at=?
    WHERE tenant_id=? AND id=? AND status=? AND current_station=?`,
  business.stationIdx,
  JSON.stringify(failure),
  reconciledAt,
  item.tenantId,
  business.pipelineId,
  business.jobStatus,
  business.stationIdx);
  if (Number(jobChanged.changes) !== 1) {
    throw reconciliationError(
      '流水线任务对账状态已变化，未写入失败结果',
      'CONTENT_PIPELINE_RECONCILIATION_JOB_CAS_FAILED',
    );
  }
  q.run(`UPDATE materials
    SET source_type='content_pipeline_provider_quality_quarantine',
        note=CASE WHEN COALESCE(note,'')='' THEN ? ELSE note || '；' || ? END
    WHERE tenant_id=? AND source_type='content_pipeline_provider' AND source_id=?
      AND CAST(json_extract(artifact_snapshot_json,'$.employeeIdx') AS INTEGER)=?`,
  `流水线#${business.pipelineId}工位${business.stationIdx}对账未通过，素材只读隔离`,
  `流水线#${business.pipelineId}工位${business.stationIdx}对账未通过，素材只读隔离`,
  item.tenantId,
  business.pipelineId,
  business.stationIdx);
  return 'failed';
}

/**
 * 流水线账务对账必须把 hold、唯一积分流水和工位/job 状态放在同一
 * BEGIN IMMEDIATE 中完成。这样进程在任意写入点退出都不会留下“积分已结、
 * 流水线仍 billing_pending”或相反的半完成状态。
 */
export function resolveContentPipelineReconciliation({
  tenantId,
  holdId,
  action,
  evidenceHash: suppliedEvidenceHash,
  actor,
  reason,
} = {}) {
  const tid = Number(tenantId);
  const hid = Number(holdId);
  const normalizedAction = String(action || '').trim();
  const normalizedReason = String(reason || '').trim();
  if (!Number.isSafeInteger(tid) || tid <= 0
    || !Number.isSafeInteger(hid) || hid <= 0) {
    throw reconciliationError('对账租户或预授权编号无效', 'AI_RECONCILIATION_REFERENCE_INVALID', 400);
  }
  if (!['settle', 'release'].includes(normalizedAction)) {
    throw reconciliationError('对账动作无效', 'AI_RECONCILIATION_ACTION_INVALID', 400);
  }
  if (!['boss', 'admin', 'platform_super'].includes(String(actor?.role || ''))
    || !Number.isSafeInteger(Number(actor?.id)) || Number(actor.id) <= 0) {
    throw reconciliationError('当前账号无权处理流水线账务对账', 'AI_RECONCILIATION_ROLE_FORBIDDEN', 403);
  }
  if (normalizedReason.length < 6 || normalizedReason.length > 300) {
    throw reconciliationError('对账依据必须为6到300字', 'AI_RECONCILIATION_REASON_INVALID', 400);
  }
  if (!/^[a-f0-9]{64}$/u.test(String(suppliedEvidenceHash || ''))) {
    throw reconciliationError('对账证据哈希无效', 'AI_RECONCILIATION_EVIDENCE_HASH_INVALID', 409);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const item = inspectAiReconciliationHold({ tenantId: tid, holdId: hid });
    if (!item || item.refType !== CONTENT_PIPELINE_REF_TYPE) {
      throw reconciliationError('流水线待对账预授权不存在', 'CONTENT_PIPELINE_RECONCILIATION_NOT_FOUND', 404);
    }
    if (item.evidenceHash !== suppliedEvidenceHash) {
      throw reconciliationError(
        '对账证据已变化，系统未执行扣费、退款或业务状态变更',
        'AI_RECONCILIATION_EVIDENCE_CHANGED',
      );
    }
    if (!item.availableActions.includes(normalizedAction)) {
      throw reconciliationError(
        item.blockedReason || '当前证据不允许该对账动作',
        'AI_RECONCILIATION_ACTION_BLOCKED',
      );
    }
    const holdRow = q.get(`SELECT * FROM credit_holds
      WHERE tenant_id=? AND id=? AND status='held'`, tid, hid);
    if (!holdRow
      || holdRow.ref_type !== CONTENT_PIPELINE_REF_TYPE
      || Number(holdRow.ref_id) !== Number(item.refId)) {
      throw reconciliationError(
        '预授权已由其他请求处理或业务引用不一致',
        'AI_RECONCILIATION_HOLD_CAS_FAILED',
      );
    }
    const log = q.get(`SELECT id,tenant_id FROM credit_logs
      WHERE tenant_id=? AND id=?`, tid, holdRow.log_id);
    if (!log || !q.get('SELECT id FROM tenants WHERE id=?', tid)) {
      throw reconciliationError(
        '预授权、积分流水或租户完整性校验失败',
        'AI_RECONCILIATION_LEDGER_INTEGRITY_FAILED',
      );
    }
    const settlement = pipelineSettlementAmount(holdRow, item.business, normalizedAction);
    const reconciledAt = new Date().toISOString();
    const claimed = q.run(`UPDATE credit_holds
      SET status='settled',settled_credits=?,settled_at=datetime('now','localtime')
      WHERE tenant_id=? AND id=? AND status='held' AND log_id=?
        AND ref_type=? AND ref_id=?`,
    settlement.credits,
    tid,
    hid,
    holdRow.log_id,
    CONTENT_PIPELINE_REF_TYPE,
    item.refId);
    if (Number(claimed.changes) !== 1) {
      throw reconciliationError(
        '预授权已由其他请求处理',
        'AI_RECONCILIATION_HOLD_CAS_FAILED',
      );
    }
    const tenantChanged = q.run('UPDATE tenants SET credits=credits+? WHERE id=?',
      Number(holdRow.held_credits) - settlement.credits, tid);
    if (Number(tenantChanged.changes) !== 1) {
      throw reconciliationError('租户积分池不存在', 'AI_RECONCILIATION_TENANT_CAS_FAILED');
    }
    const balance = Number(q.get('SELECT credits FROM tenants WHERE id=?', tid)?.credits || 0);
    const logChanged = q.run(`UPDATE credit_logs
      SET credits=?,model=?,input_tokens=?,output_tokens=?,cost_yuan=?,balance_after=?,
          ai_mode='api',note=?
      WHERE tenant_id=? AND id=?`,
    settlement.credits,
    settlement.model,
    settlement.inputTokens,
    settlement.outputTokens,
    Math.round(settlement.costYuan * 10000) / 10000,
    balance,
    `${normalizedAction === 'settle'
      ? '管理员依据流水线持久化交付证据完成对账'
      : '管理员确认流水线工位未通过交付门禁并退款'}：${normalizedReason}；预授权${holdRow.held_credits}分→实扣${settlement.credits}分`,
    tid,
    holdRow.log_id);
    if (Number(logChanged.changes) !== 1) {
      throw reconciliationError('唯一积分流水更新失败', 'AI_RECONCILIATION_LOG_CAS_FAILED');
    }
    const pipelineStatus = updatePipelineAfterReconciliation({
      item,
      action: normalizedAction,
      settlement,
      actor,
      reason: normalizedReason,
      balance,
      reconciledAt,
    });
    db.exec('COMMIT');
    return {
      credits: settlement.credits,
      balance,
      costYuan: Math.round(settlement.costYuan * 100) / 100,
      pipelineId: item.business.pipelineId,
      stationIdx: item.business.stationIdx,
      pipelineStatus,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 保留原始错误 */ }
    throw error;
  }
}

function specialProviderSettlementAmount(holdRow, business, action) {
  const heldCredits = Number(holdRow.held_credits || 0);
  if (!Number.isSafeInteger(heldCredits) || heldCredits <= 0) {
    throw reconciliationError(
      '特殊provider预授权金额无效',
      'CONTENT_SPECIAL_PROVIDER_RECONCILIATION_HOLD_INVALID',
    );
  }
  const model = String(business.model || holdRow.model || '').trim();
  if (action === 'release') {
    return { credits: 0, costYuan: 0, inputTokens: 0, outputTokens: 0, model };
  }
  if (business.providerKind !== 'image'
    || String(holdRow.kind || '') !== 'image'
    || blockedModel(model)
    || business.providerValid !== true
    || business.artifactsValid !== true) {
    throw reconciliationError(
      '特殊图片provider缺少可按固定价结算的真实交付证据',
      'CONTENT_SPECIAL_PROVIDER_RECONCILIATION_PRICING_INVALID',
    );
  }
  const config = billing();
  const costYuan = (heldCredits * Number(config.creditYuan))
    / Number(config.marginMultiplier);
  if (!Number.isFinite(costYuan) || costYuan < 0) {
    throw reconciliationError(
      '特殊provider固定价配置无效',
      'CONTENT_SPECIAL_PROVIDER_RECONCILIATION_PRICE_INVALID',
      500,
    );
  }
  return {
    credits: heldCredits,
    costYuan,
    inputTokens: 0,
    outputTokens: 0,
    model,
  };
}

function updateSpecialProviderAfterReconciliation({
  item,
  action,
  settlement,
  actor,
  reason,
  balance,
  reconciledAt,
}) {
  const business = item.business;
  const releasedAttemptStatus = business.releaseDisposition === 'released' ? 'released' : 'failed';
  const attemptStatus = action === 'settle' ? 'settled' : releasedAttemptStatus;
  const attemptBilling = {
    ...business.attemptBilling,
    state: action === 'settle' ? 'settled' : 'released',
    status: action === 'settle' ? 'settled' : 'released',
    holdId: item.holdId,
    estimatedCredits: item.heldCredits,
    heldCredits: 0,
    chargedCredits: settlement.credits,
    credits: settlement.credits,
    pendingReconciliation: false,
    balance,
    model: action === 'settle' ? settlement.model : null,
    reconciliation: {
      action,
      reason,
      reconciledAt,
      reconciledBy: {
        id: Number(actor.id),
        name: String(actor.name || '').slice(0, 120),
        role: String(actor.role || '').slice(0, 64),
      },
    },
  };
  const failure = action === 'release' ? {
    ...(isRecord(business.attemptError) ? business.attemptError : {}),
    code: 'CONTENT_SPECIAL_PROVIDER_RECONCILIATION_RELEASED',
    name: 'ContentSpecialProviderReconciliationReleased',
    message: business.releaseDisposition === 'released'
      ? '对账确认特殊provider没有可交付产物，预授权已退款'
      : '对账确认特殊provider产物校验失败，预授权已退款且素材已隔离',
    stationIdx: business.stationIdx,
    attemptId: business.attemptId,
    reconciledAt,
    reconciliationReason: reason,
  } : null;
  const attemptChanged = q.run(`UPDATE content_pipeline_special_provider_attempts
    SET status=?,billing_json=?,error_json=?,updated_at=?
    WHERE tenant_id=? AND billing_ref_type=? AND billing_ref_id=? AND hold_id=? AND status=?`,
  attemptStatus,
  JSON.stringify(attemptBilling),
  failure ? JSON.stringify(failure) : null,
  reconciledAt,
  item.tenantId,
  CONTENT_SPECIAL_PROVIDER_REF_TYPE,
  item.refId,
  item.holdId,
  business.attemptStatus);
  if (Number(attemptChanged.changes) !== 1) {
    throw reconciliationError(
      '特殊provider attempt状态已变化，未写入对账结果',
      'CONTENT_SPECIAL_PROVIDER_RECONCILIATION_ATTEMPT_CAS_FAILED',
    );
  }

  const refreshedBilling = refreshPipelineStationBillingEvidence({
    tenantId: item.tenantId,
    pipelineId: business.pipelineId,
    stationIdx: business.stationIdx,
    sourceEvidence: business.stationBillingEvidence,
    balance,
    reason,
    reconciledAt,
    actor,
  });
  const billingEvidence = {
    ...refreshedBilling.evidence,
    reconciliation: {
      ...refreshedBilling.evidence.reconciliation,
      action,
      attemptId: business.attemptId,
      refType: CONTENT_SPECIAL_PROVIDER_REF_TYPE,
      refId: item.refId,
    },
  };
  const contextSnapshot = {
    ...business.stationContextSnapshot,
    billingEvidence,
  };

  if (action === 'release') {
    const stationFailure = {
      ...(isRecord(business.stationFailure) ? business.stationFailure : {}),
      ...failure,
      code: 'CONTENT_PIPELINE_SPECIAL_PROVIDER_RECONCILIATION_FAILED',
      name: 'ContentPipelineSpecialProviderReconciliationFailed',
      message: '特殊provider未通过交付门禁，流水线停在失败工位',
    };
    const stationChanged = q.run(`UPDATE content_production_pipeline_stations
      SET status='failed',billing_evidence_json=?,context_snapshot_json=?,failure_json=?,updated_at=?
      WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND status=?`,
    JSON.stringify(billingEvidence),
    JSON.stringify(contextSnapshot),
    JSON.stringify(stationFailure),
    reconciledAt,
    item.tenantId,
    business.pipelineId,
    business.stationIdx,
    business.stationStatus);
    if (Number(stationChanged.changes) !== 1) {
      throw reconciliationError(
        '特殊provider对账时工位状态已变化',
        'CONTENT_SPECIAL_PROVIDER_RECONCILIATION_STATION_CAS_FAILED',
      );
    }
    const jobChanged = q.run(`UPDATE content_production_pipeline_jobs
      SET status='failed',current_station=?,pending_station=NULL,failure_json=?,
          version=version+1,updated_at=?
      WHERE tenant_id=? AND id=? AND status=? AND current_station=?`,
    business.stationIdx,
    JSON.stringify(stationFailure),
    reconciledAt,
    item.tenantId,
    business.pipelineId,
    business.jobStatus,
    business.stationIdx);
    if (Number(jobChanged.changes) !== 1) {
      throw reconciliationError(
        '特殊provider对账时流水线任务状态已变化',
        'CONTENT_SPECIAL_PROVIDER_RECONCILIATION_JOB_CAS_FAILED',
      );
    }
    q.run(`UPDATE materials
      SET source_type='content_pipeline_provider_quality_quarantine',
          note=CASE WHEN COALESCE(note,'')='' THEN ? ELSE note || '；' || ? END
      WHERE tenant_id=? AND source_type='content_pipeline_provider' AND source_id=?
        AND json_extract(artifact_snapshot_json,'$.attemptId')=?
        AND CAST(json_extract(artifact_snapshot_json,'$.billingRefId') AS INTEGER)=?`,
    `attempt=${business.attemptId}对账未通过，素材只读隔离`,
    `attempt=${business.attemptId}对账未通过，素材只读隔离`,
    item.tenantId,
    business.pipelineId,
    business.attemptId,
    item.refId);
    return 'failed';
  }

  if (business.stationStatus === 'failed' && business.jobStatus === 'failed') {
    const changed = q.run(`UPDATE content_production_pipeline_stations
      SET billing_evidence_json=?,context_snapshot_json=?,updated_at=?
      WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND status='failed'`,
    JSON.stringify(billingEvidence), JSON.stringify(contextSnapshot), reconciledAt,
    item.tenantId, business.pipelineId, business.stationIdx);
    if (Number(changed.changes) !== 1) {
      throw reconciliationError(
        '失败工位的provider结算状态已变化',
        'CONTENT_SPECIAL_PROVIDER_RECONCILIATION_STATION_CAS_FAILED',
      );
    }
    return 'failed';
  }

  if (!refreshedBilling.allTerminal) {
    const changed = q.run(`UPDATE content_production_pipeline_stations
      SET billing_evidence_json=?,context_snapshot_json=?,updated_at=?
      WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND status='billing_pending'`,
    JSON.stringify(billingEvidence), JSON.stringify(contextSnapshot), reconciledAt,
    item.tenantId, business.pipelineId, business.stationIdx);
    if (Number(changed.changes) !== 1) {
      throw reconciliationError(
        '特殊provider结算后工位账务状态已变化',
        'CONTENT_SPECIAL_PROVIDER_RECONCILIATION_STATION_CAS_FAILED',
      );
    }
    return 'billing_pending';
  }

  const stationStatus = business.resumeStationStatus;
  if (!['completed', 'awaiting_approval'].includes(stationStatus)) {
    throw reconciliationError(
      '工位缺少可验证的恢复状态，禁止自动推进',
      'CONTENT_SPECIAL_PROVIDER_RECONCILIATION_RESUME_STATE_INVALID',
    );
  }
  const nextStation = business.stationIdx + 1;
  const jobStatus = stationStatus === 'awaiting_approval'
    ? 'awaiting_approval'
    : nextStation >= 10 ? 'completed' : 'running';
  const currentStation = stationStatus === 'awaiting_approval'
    ? business.stationIdx
    : nextStation;
  const stationChanged = q.run(`UPDATE content_production_pipeline_stations
    SET status=?,billing_evidence_json=?,context_snapshot_json=?,failure_json=NULL,updated_at=?
    WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND status='billing_pending'`,
  stationStatus,
  JSON.stringify(billingEvidence),
  JSON.stringify(contextSnapshot),
  reconciledAt,
  item.tenantId,
  business.pipelineId,
  business.stationIdx);
  if (Number(stationChanged.changes) !== 1) {
    throw reconciliationError(
      '特殊provider结算后工位恢复CAS失败',
      'CONTENT_SPECIAL_PROVIDER_RECONCILIATION_STATION_CAS_FAILED',
    );
  }
  const jobChanged = q.run(`UPDATE content_production_pipeline_jobs
    SET status=?,current_station=?,pending_station=?,failure_json=NULL,
        version=version+1,updated_at=?
    WHERE tenant_id=? AND id=? AND status='billing_pending' AND current_station=?`,
  jobStatus,
  currentStation,
  stationStatus === 'awaiting_approval' ? business.stationIdx : null,
  reconciledAt,
  item.tenantId,
  business.pipelineId,
  business.stationIdx);
  if (Number(jobChanged.changes) !== 1) {
    throw reconciliationError(
      '特殊provider结算后流水线恢复CAS失败',
      'CONTENT_SPECIAL_PROVIDER_RECONCILIATION_JOB_CAS_FAILED',
    );
  }
  return jobStatus;
}

export function resolveContentSpecialProviderReconciliation({
  tenantId,
  holdId,
  action,
  evidenceHash: suppliedEvidenceHash,
  actor,
  reason,
} = {}) {
  const tid = Number(tenantId);
  const hid = Number(holdId);
  const normalizedAction = String(action || '').trim();
  const normalizedReason = String(reason || '').trim();
  if (!Number.isSafeInteger(tid) || tid <= 0
    || !Number.isSafeInteger(hid) || hid <= 0) {
    throw reconciliationError('对账租户或预授权编号无效', 'AI_RECONCILIATION_REFERENCE_INVALID', 400);
  }
  if (!['settle', 'release'].includes(normalizedAction)) {
    throw reconciliationError('对账动作无效', 'AI_RECONCILIATION_ACTION_INVALID', 400);
  }
  if (!['boss', 'admin', 'platform_super'].includes(String(actor?.role || ''))
    || !Number.isSafeInteger(Number(actor?.id)) || Number(actor.id) <= 0) {
    throw reconciliationError('当前账号无权处理特殊provider账务对账', 'AI_RECONCILIATION_ROLE_FORBIDDEN', 403);
  }
  if (normalizedReason.length < 6 || normalizedReason.length > 300) {
    throw reconciliationError('对账依据必须为6到300字', 'AI_RECONCILIATION_REASON_INVALID', 400);
  }
  if (!/^[a-f0-9]{64}$/u.test(String(suppliedEvidenceHash || ''))) {
    throw reconciliationError('对账证据哈希无效', 'AI_RECONCILIATION_EVIDENCE_HASH_INVALID', 409);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const item = inspectAiReconciliationHold({ tenantId: tid, holdId: hid });
    if (!item || item.refType !== CONTENT_SPECIAL_PROVIDER_REF_TYPE) {
      throw reconciliationError('特殊provider待对账预授权不存在', 'CONTENT_SPECIAL_PROVIDER_RECONCILIATION_NOT_FOUND', 404);
    }
    if (item.evidenceHash !== suppliedEvidenceHash) {
      throw reconciliationError(
        '对账证据已变化，系统未执行扣费、退款或业务状态变更',
        'AI_RECONCILIATION_EVIDENCE_CHANGED',
      );
    }
    if (!item.availableActions.includes(normalizedAction)) {
      throw reconciliationError(
        item.blockedReason || '当前证据不允许该对账动作',
        'AI_RECONCILIATION_ACTION_BLOCKED',
      );
    }
    const holdRow = q.get(`SELECT * FROM credit_holds
      WHERE tenant_id=? AND id=? AND status='held'`, tid, hid);
    if (!holdRow
      || holdRow.ref_type !== CONTENT_SPECIAL_PROVIDER_REF_TYPE
      || Number(holdRow.ref_id) !== Number(item.refId)) {
      throw reconciliationError(
        '预授权已由其他请求处理或业务引用不一致',
        'AI_RECONCILIATION_HOLD_CAS_FAILED',
      );
    }
    const log = q.get(`SELECT id FROM credit_logs WHERE tenant_id=? AND id=?`, tid, holdRow.log_id);
    if (!log || !q.get('SELECT id FROM tenants WHERE id=?', tid)) {
      throw reconciliationError(
        '预授权、积分流水或租户完整性校验失败',
        'AI_RECONCILIATION_LEDGER_INTEGRITY_FAILED',
      );
    }
    const settlement = specialProviderSettlementAmount(holdRow, item.business, normalizedAction);
    const reconciledAt = new Date().toISOString();
    const claimed = q.run(`UPDATE credit_holds
      SET status='settled',settled_credits=?,settled_at=datetime('now','localtime')
      WHERE tenant_id=? AND id=? AND status='held' AND log_id=?
        AND ref_type=? AND ref_id=?`,
    settlement.credits,
    tid,
    hid,
    holdRow.log_id,
    CONTENT_SPECIAL_PROVIDER_REF_TYPE,
    item.refId);
    if (Number(claimed.changes) !== 1) {
      throw reconciliationError('预授权已由其他请求处理', 'AI_RECONCILIATION_HOLD_CAS_FAILED');
    }
    const tenantChanged = q.run('UPDATE tenants SET credits=credits+? WHERE id=?',
      Number(holdRow.held_credits) - settlement.credits, tid);
    if (Number(tenantChanged.changes) !== 1) {
      throw reconciliationError('租户积分池不存在', 'AI_RECONCILIATION_TENANT_CAS_FAILED');
    }
    const balance = Number(q.get('SELECT credits FROM tenants WHERE id=?', tid)?.credits || 0);
    const logChanged = q.run(`UPDATE credit_logs
      SET credits=?,model=?,input_tokens=0,output_tokens=0,cost_yuan=?,balance_after=?,
          ai_mode='api',note=?
      WHERE tenant_id=? AND id=?`,
    settlement.credits,
    settlement.model,
    Math.round(settlement.costYuan * 10000) / 10000,
    balance,
    `${normalizedAction === 'settle'
      ? '管理员依据特殊图片provider固定价与素材哈希完成对账'
      : '管理员确认特殊provider未形成可交付产物并退款'}：${normalizedReason}；预授权${holdRow.held_credits}分→实扣${settlement.credits}分`,
    tid,
    holdRow.log_id);
    if (Number(logChanged.changes) !== 1) {
      throw reconciliationError('唯一积分流水更新失败', 'AI_RECONCILIATION_LOG_CAS_FAILED');
    }
    const pipelineStatus = updateSpecialProviderAfterReconciliation({
      item,
      action: normalizedAction,
      settlement,
      actor,
      reason: normalizedReason,
      balance,
      reconciledAt,
    });
    db.exec('COMMIT');
    return {
      credits: settlement.credits,
      balance,
      costYuan: Math.round(settlement.costYuan * 100) / 100,
      pipelineId: item.business.pipelineId,
      stationIdx: item.business.stationIdx,
      attemptId: item.business.attemptId,
      pipelineStatus,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 保留原始错误 */ }
    throw error;
  }
}

export function listAiReconciliationHolds({ tenantId, limit = 100 } = {}) {
  const tid = Number(tenantId);
  const capped = Math.max(1, Math.min(200, Number(limit) || 100));
  const ids = q.all(`SELECT id FROM credit_holds
    WHERE tenant_id=? AND status='held'
    ORDER BY created_at,id LIMIT ?`, tid, capped);
  const rows = ids.map(row => inspectAiReconciliationHold({ tenantId: tid, holdId: row.id })).filter(Boolean);
  const activeRows = rows.filter(row => row.stillActive === true);
  const attentionRows = rows.filter(row => row.stillActive !== true);
  return {
    rows,
    summary: {
      total: rows.length,
      active: activeRows.length,
      requiresAttention: attentionRows.length,
      canSettle: rows.filter(row => row.availableActions.includes('settle')).length,
      canRelease: rows.filter(row => row.availableActions.includes('release')).length,
      blocked: rows.filter(row => row.availableActions.length === 0).length,
      blockedNeedsReview: attentionRows.filter(row => row.availableActions.length === 0).length,
      heldCredits: rows.reduce((sum, row) => sum + row.heldCredits, 0),
      activeHeldCredits: activeRows.reduce((sum, row) => sum + row.heldCredits, 0),
      attentionHeldCredits: attentionRows.reduce((sum, row) => sum + row.heldCredits, 0),
    },
  };
}

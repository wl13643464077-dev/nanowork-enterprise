import { createHash } from 'node:crypto';
import { Router } from 'express';

import { curTenant, db, q, runWithTenant } from '../db.js';
import { CONTENT_EMPLOYEES } from '../catalog/content-crew.js';
import {
  buildContentEmployeeWorkbenchProfile,
  compileContentEmployeeSoloPrompt,
  CONTENT_TASK_TYPES_BY_EMPLOYEE,
} from '../engines/content-employee-workbench.js';
import { validateContentEmployeeOutputContract } from '../engines/content-output-contract.js';
import { ensureContentAsset } from '../engines/content-assets.js';
import { generate } from '../engines/ai.js';
import {
  estimateCallCredits,
  holdCredits,
  precheckByRole,
  releaseHold,
  settleHold,
} from '../engines/credits.js';
import { refsBlock, webSearch } from '../engines/websearch.js';
import { attachmentRefsForStorage, resolveRequestedAttachments } from '../engines/filehub.js';
import { UNTRUSTED_GUARD, wrapUntrusted } from '../engines/risk.js';
import { logOp, notify } from '../util.js';

const CONFIG_ADMIN_ROLES = new Set(['boss', 'admin', 'platform_super']);
const REVIEWER_ROLES = new Set([...CONFIG_ADMIN_ROLES, 'ops_director']);
const CONFIG_KEYS = new Set([
  'textModel',
  'imageModel',
  'outputLength',
  'approvalMode',
  'timeoutSeconds',
]);
const OUTPUT_LENGTHS = new Set(['lite', 'std', 'full']);
const APPROVAL_MODES = new Set(['岗位默认', '老板审核', '管理者审核', '形成待审阅草稿']);
const RUN_STATUSES = new Set(['生成中', '待审阅', '已完成', '已驳回', '失败']);
const MAX_CUSTOM_SKILLS = 50;
const MAX_INLINE_IMAGE_CHARS = 11_200_000;

class WorkbenchRouteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'WorkbenchRouteError';
    this.status = status;
  }
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanText(value, max, label, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new WorkbenchRouteError(`${label}必填`);
    return '';
  }
  if (typeof value !== 'string') throw new WorkbenchRouteError(`${label}必须是字符串`);
  if (value.includes('\u0000')) throw new WorkbenchRouteError(`${label}不能包含NUL字符`);
  const output = value.trim();
  if (required && !output) throw new WorkbenchRouteError(`${label}必填`);
  if (output.length > max) throw new WorkbenchRouteError(`${label}不能超过${max}个字符`);
  return output;
}

function employeeIdx(value) {
  if (!/^(?:0|[1-9])$/.test(String(value))) {
    throw new WorkbenchRouteError('内容员工编号必须是0-9之间的整数');
  }
  return Number(value);
}

function contentTaskTypes(idx) {
  return [...CONTENT_TASK_TYPES_BY_EMPLOYEE[idx]];
}

function tenantIdFor(user) {
  return Number(user?.tenant_id) || curTenant();
}

function assertManager(user) {
  if (!CONFIG_ADMIN_ROLES.has(user?.role)) {
    throw new WorkbenchRouteError('仅老板或管理员可修改内容员工工作台', 403);
  }
}

function assertReviewer(user) {
  if (!REVIEWER_ROLES.has(user?.role)) {
    throw new WorkbenchRouteError('仅老板、管理员或运营负责人可审阅内容员工产出', 403);
  }
}

function permissionsFor(user) {
  const configAdmin = CONFIG_ADMIN_ROLES.has(user?.role);
  const reviewer = REVIEWER_ROLES.has(user?.role);
  return {
    canDispatch: Boolean(user?.id),
    canReviewRuns: reviewer,
    canViewPrompt: configAdmin,
    canViewFullPrompt: configAdmin,
    canEditPrompt: configAdmin,
    canEditConfig: configAdmin,
    canEditSkills: configAdmin,
  };
}

function configRow(idx, tenantId) {
  return q.get(`SELECT prompt_override,work_config_json,skills_json,revision,updated_by,updated_at
    FROM content_employee_workbench_configs
    WHERE tenant_id=? AND employee_idx=?`, tenantId, idx) || null;
}

function customSkillId(idx, title, source = '') {
  return `content-custom:${idx}:${sha256(`${title}\n${source}`).slice(0, 16)}`;
}

function normalizeCustomSkill(raw, idx, index) {
  if (!isPlainObject(raw)) throw new WorkbenchRouteError(`customSkills[${index}]必须是对象`);
  const title = cleanText(raw.title ?? raw.name, 80, `customSkills[${index}].title`, { required: true });
  const detail = cleanText(raw.detail ?? raw.description, 2000, `customSkills[${index}].detail`, { required: true });
  const source = cleanText(raw.source || '本企业自定义', 200, `customSkills[${index}].source`);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new WorkbenchRouteError(`customSkills[${index}].enabled必须是布尔值`);
  }
  const expectedId = customSkillId(idx, title, source);
  const suppliedId = raw.id === undefined ? '' : cleanText(raw.id, 160, `customSkills[${index}].id`);
  if (suppliedId && !suppliedId.startsWith(`content-custom:${idx}:`)) {
    throw new WorkbenchRouteError('出厂岗位 Skill 与历史待核验技能不可被企业自定义技能替换');
  }
  return {
    id: suppliedId || expectedId,
    title,
    detail,
    source,
    enabled: raw.enabled !== false,
    kind: 'custom',
    origin: 'tenant_custom',
    required: false,
    locked: false,
    verificationStatus: 'tenant_supplied',
  };
}

function normalizeCustomSkills(value, idx) {
  if (!Array.isArray(value)) throw new WorkbenchRouteError('customSkills必须是数组');
  if (value.length > MAX_CUSTOM_SKILLS) {
    throw new WorkbenchRouteError(`单个内容员工最多配置${MAX_CUSTOM_SKILLS}项企业自定义技能`);
  }
  const normalized = value.map((item, index) => normalizeCustomSkill(item, idx, index));
  const ids = new Set();
  const titles = new Set();
  for (const item of normalized) {
    const titleKey = item.title.toLocaleLowerCase('zh-CN');
    if (ids.has(item.id) || titles.has(titleKey)) {
      throw new WorkbenchRouteError(`企业自定义技能重复：${item.title}`);
    }
    ids.add(item.id);
    titles.add(titleKey);
  }
  return normalized;
}

function normalizeConfigPatch(value) {
  if (!isPlainObject(value)) throw new WorkbenchRouteError('values必须是对象');
  const extras = Object.keys(value).filter(key => !CONFIG_KEYS.has(key));
  if (extras.length) throw new WorkbenchRouteError(`工作配置包含不支持字段：${extras.join('、')}`);
  const output = {};
  if (Object.hasOwn(value, 'textModel')) output.textModel = cleanText(value.textModel, 100, 'textModel');
  if (Object.hasOwn(value, 'imageModel')) output.imageModel = cleanText(value.imageModel, 100, 'imageModel');
  if (Object.hasOwn(value, 'outputLength')) {
    if (!OUTPUT_LENGTHS.has(value.outputLength)) throw new WorkbenchRouteError('outputLength必须是lite、std或full');
    output.outputLength = value.outputLength;
  }
  if (Object.hasOwn(value, 'approvalMode')) {
    if (!APPROVAL_MODES.has(value.approvalMode)) {
      throw new WorkbenchRouteError(`approvalMode必须是：${[...APPROVAL_MODES].join('、')}`);
    }
    output.approvalMode = value.approvalMode;
  }
  if (Object.hasOwn(value, 'timeoutSeconds')) {
    if (!Number.isInteger(value.timeoutSeconds)
      || value.timeoutSeconds < 30
      || value.timeoutSeconds > 600) {
      throw new WorkbenchRouteError('timeoutSeconds必须是30-600之间的整数');
    }
    output.timeoutSeconds = value.timeoutSeconds;
  }
  return output;
}

function savedConfig(row) {
  if (!row) return {};
  let value;
  try {
    value = JSON.parse(row.work_config_json);
  } catch {
    throw new WorkbenchRouteError('内容员工工作配置存储损坏，请管理员修复后再执行', 500);
  }
  if (!isPlainObject(value)) {
    throw new WorkbenchRouteError('内容员工工作配置存储格式无效，请管理员修复后再执行', 500);
  }
  try {
    return normalizeConfigPatch(value);
  } catch (error) {
    throw new WorkbenchRouteError(`内容员工工作配置存储无效：${error.message}`, 500);
  }
}

function savedSkills(row, idx) {
  if (!row) return [];
  let value;
  try {
    value = JSON.parse(row.skills_json);
  } catch {
    throw new WorkbenchRouteError('内容员工企业技能存储损坏，请管理员修复后再执行', 500);
  }
  if (!Array.isArray(value)) {
    throw new WorkbenchRouteError('内容员工企业技能存储格式无效，请管理员修复后再执行', 500);
  }
  try {
    return normalizeCustomSkills(value, idx);
  } catch (error) {
    throw new WorkbenchRouteError(`内容员工企业技能存储无效：${error.message}`, 500);
  }
}

function defaultConfig(profile) {
  const common = profile.workConfig.factoryDefault.common;
  return {
    textModel: common.textModel || profile.workConfig.safeLegacyConfig.modelText || '',
    imageModel: common.imageModel || profile.workConfig.safeLegacyConfig.modelImage || '',
    outputLength: 'std',
    approvalMode: '岗位默认',
    timeoutSeconds: 120,
  };
}

function effectiveConfig(profile, row) {
  return { ...defaultConfig(profile), ...savedConfig(row) };
}

function configFields() {
  return [
    {
      key: 'textModel',
      label: '文本模型',
      type: 'text',
      description: 'inherit 或留空表示跟随企业模型；不会改变岗位能力。',
    },
    {
      key: 'imageModel',
      label: '视觉模型',
      type: 'text',
      description: '仅供支持视觉产出的岗位参考；不会冒充已接入连接器。',
    },
    {
      key: 'outputLength',
      label: '交付篇幅',
      type: 'select',
      options: [
        { label: '精简', value: 'lite' },
        { label: '标准', value: 'std' },
        { label: '详尽', value: 'full' },
      ],
    },
    {
      key: 'approvalMode',
      label: '企业审批偏好',
      type: 'select',
      options: [...APPROVAL_MODES].map(value => ({ label: value, value })),
      description: '只能增加人工审批要求；任何选择都不能授权AI对外发布或执行不可逆操作。',
    },
    {
      key: 'timeoutSeconds',
      label: '执行超时（秒）',
      type: 'number',
      description: '允许范围30-600秒。',
    },
  ];
}

function normalizeWorkMethod(profile) {
  const method = profile.workMethod;
  return {
    inputs: [...new Set([
      method.input.upstream,
      ...(method.input.context || []),
    ].filter(Boolean))],
    steps: [
      `执行处理器：${method.execution.handler}`,
      method.execution.capabilities,
      method.execution.skills,
      method.execution.webRequired
        ? '岗位要求联网核验时效性信息；如果当前运行没有联网能力，必须明确列出待核验项。'
        : '该岗位不强制联网；不得声称执行了实际未发生的外部检索。',
      method.execution.realtimeSteps
        ? '按实时步骤形成过程记录与自检。'
        : '按岗位档案完成过程记录与自检。',
    ].filter(Boolean),
    deliverables: [
      method.output.duty,
      ...(method.output.keys || []).map(key => `交付字段：${key}`),
    ].filter(Boolean),
    approval: method.approval.description,
    qualityGate: `岗位审批：${method.approval.code}；交付后必须按${method.approval.description}处理`,
    handoff: `${method.handoff.target}${method.handoff.optional ? '（按需）' : ''}`,
    executionBoundary: '单独派活只运行当前内容员工，不表示十工位流水线已自动执行；任何外部发布或不可逆操作仍须有权限的人类审批。',
    raw: clone(method),
  };
}

function runtimeFor(idx, user) {
  const tenantId = tenantIdFor(user);
  const access = runAccess(user);
  const totals = q.get(`SELECT COUNT(*) runs,
    SUM(CASE WHEN status='已完成' THEN 1 ELSE 0 END) completed_runs,
    SUM(CASE WHEN status='待审阅' THEN 1 ELSE 0 END) review_pending_runs,
    SUM(CASE WHEN status='生成中' THEN 1 ELSE 0 END) running_tasks,
    MAX(created_at) last_run_at
    FROM content_employee_runs WHERE tenant_id=? AND employee_idx=?${access.sql}`,
  tenantId, idx, ...access.params) || {};
  const recent = q.all(`SELECT id,title,type,status,created_at,updated_at
    FROM content_employee_runs WHERE tenant_id=? AND employee_idx=?${access.sql}
    ORDER BY id DESC LIMIT 8`, tenantId, idx, ...access.params);
  return {
    status: Number(totals.running_tasks || 0) > 0 ? '执行中' : '可派活',
    runs: Number(totals.runs || 0),
    completedRuns: Number(totals.completed_runs || 0),
    reviewPendingRuns: Number(totals.review_pending_runs || 0),
    runningTasks: Number(totals.running_tasks || 0),
    lastRunAt: totals.last_run_at || null,
    lastTask: recent[0] || null,
    recentTasks: recent,
  };
}

function runId(value) {
  if (!/^[1-9]\d*$/.test(String(value))) {
    throw new WorkbenchRouteError('运行记录编号必须是正整数');
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new WorkbenchRouteError('运行记录编号无效');
  return id;
}

function parseRunSnapshot(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function runAccess(user, column = 'created_by') {
  if (REVIEWER_ROLES.has(user?.role)) return { sql: '', params: [] };
  return { sql: ` AND ${column}=?`, params: [Number(user?.id) || 0] };
}

function runStatusLabel(status) {
  return status === '已完成' ? '已采纳' : status;
}

function publicContract(snapshot, row) {
  const nested = isPlainObject(snapshot.contract) ? snapshot.contract : null;
  const hasTopLevel = typeof snapshot.contractValid === 'boolean'
    || Array.isArray(snapshot.contractErrors)
    || Array.isArray(snapshot.artifacts);
  if (!nested && !hasTopLevel) return null;
  const valid = nested ? nested.valid === true : snapshot.contractValid === true;
  const errors = nested?.errors ?? snapshot.contractErrors;
  const artifacts = nested?.artifacts ?? snapshot.artifacts;
  return {
    valid,
    errors: Array.isArray(errors) ? errors.map(String) : [],
    artifacts: (Array.isArray(artifacts) ? artifacts : []).map((artifact, index) => ({
      kind: artifact?.kind || 'unknown',
      primary: artifact?.primary === true,
      filename: artifact?.filename || `content-employee-${row.id}-artifact-${index + 1}`,
      mediaType: artifact?.mediaType || 'application/octet-stream',
      employeeIdx: Number(artifact?.employeeIdx ?? row.employee_idx),
      employeeKey: artifact?.employeeKey || row.employee_key,
      sourceKeys: Array.isArray(artifact?.sourceKeys) ? artifact.sourceKeys : [],
      downloadUrl: artifact?.kind === 'html' && typeof artifact?.content === 'string'
        ? `/api/employee-workbench/content/${row.employee_idx}/runs/${row.id}/artifacts/${index}`
        : null,
    })),
  };
}

function publicRun(row, user, { includeSnapshot = false } = {}) {
  const snapshot = parseRunSnapshot(row.snapshot_json);
  const review = isPlainObject(snapshot.review) ? snapshot.review : null;
  const failure = isPlainObject(snapshot.failure) ? snapshot.failure : null;
  const contract = publicContract(snapshot, row);
  const status = RUN_STATUSES.has(row.status) ? row.status : '失败';
  const output = {
    id: Number(row.id),
    runId: Number(row.id),
    employeeIdx: Number(row.employee_idx),
    employeeKey: row.employee_key,
    employeeName: row.employee_name,
    employeeGroup: row.employee_group,
    title: row.title,
    type: row.type,
    requirement: row.requirement || '',
    industry: snapshot.dispatch?.industry || '',
    feedback: snapshot.dispatch?.feedback || '',
    attachments: Array.isArray(snapshot.dispatch?.attachments)
      ? clone(snapshot.dispatch.attachments)
      : [],
    dueAt: row.due_at || null,
    status,
    displayStatus: status === '待审阅' && contract?.valid === false
      ? '待审阅·格式待修复'
      : runStatusLabel(status),
    resultMd: row.result_md || null,
    resultPreview: row.result_md ? String(row.result_md).replace(/\s+/g, ' ').slice(0, 180) : null,
    error: failure?.message || (status === '失败' ? '生成失败，未形成可审阅产出。' : null),
    aiMode: row.ai_mode || null,
    model: row.model || null,
    profileVersion: row.profile_version,
    promptHash: row.prompt_hash,
    createdBy: Number(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    billing: isPlainObject(snapshot.billing) ? clone(snapshot.billing) : null,
    contract,
    review: review ? {
      decision: review.decision || null,
      reviewerId: Number(review.reviewerId) || null,
      reviewerName: review.reviewerName || null,
      reviewerRole: review.reviewerRole || null,
      reviewedAt: review.reviewedAt || null,
      opinion: review.opinion || '',
      materialId: Number(review.materialId) || null,
      contentId: Number(review.contentId) || null,
    } : null,
    materialId: Number(review?.materialId) || null,
    contentId: Number(review?.contentId) || null,
    canReview: REVIEWER_ROLES.has(user?.role) && status === '待审阅',
    terminal: ['已完成', '已驳回', '失败'].includes(status),
  };
  if (includeSnapshot) {
    const publicSnapshot = clone(snapshot);
    if (Array.isArray(publicSnapshot.artifacts)) {
      publicSnapshot.artifacts = publicSnapshot.artifacts.map(artifact => {
        if (!isPlainObject(artifact)) return artifact;
        const { content: _content, ...metadata } = artifact;
        return metadata;
      });
    }
    if (isPlainObject(publicSnapshot.contract) && Array.isArray(publicSnapshot.contract.artifacts)) {
      publicSnapshot.contract.artifacts = publicSnapshot.contract.artifacts.map(artifact => {
        if (!isPlainObject(artifact)) return artifact;
        const { content: _content, ...metadata } = artifact;
        return metadata;
      });
    }
    output.snapshot = publicSnapshot;
  }
  return output;
}

function runRow(idx, id, user) {
  const access = runAccess(user);
  return q.get(`SELECT * FROM content_employee_runs
    WHERE tenant_id=? AND employee_idx=? AND id=?${access.sql}`,
  tenantIdFor(user), idx, id, ...access.params);
}

function failureSnapshot(tenantId, id, error) {
  const row = q.get(`SELECT snapshot_json FROM content_employee_runs
    WHERE tenant_id=? AND id=?`, tenantId, id);
  const snapshot = parseRunSnapshot(row?.snapshot_json);
  snapshot.failure = {
    message: String(error?.message || error || '内容员工执行失败').slice(0, 500),
    failedAt: new Date().toISOString(),
  };
  return JSON.stringify(snapshot);
}

function finalOutputContract(profile) {
  const outputKeys = clone(profile.jobProfile.outputKeys || []);
  const schema = profile.jobProfile.outputSchema || {};
  const primaryArtifact = schema.primaryArtifact || 'json';
  const block = [
    '【当前岗位最终输出契约·最高格式优先级】',
    '来源模板中若仍写有“只输出 Markdown”等通用要求，以本段岗位原生契约为准。',
    `只输出一个合法 JSON 对象，不要在 JSON 前后添加客套话或 Markdown 围栏；必须完整覆盖字段：${outputKeys.join('、')}。`,
    schema.contract || '',
    profile.identity.idx === 7
      ? '演绎师的 html 字段必须是可独立打开的完整 HTML 主产物；PPT 只可作为按需附加连接器，不能替代 HTML。'
      : `主产物类型：${primaryArtifact}。`,
  ].filter(Boolean).join('\n');
  return {
    format: schema.format || 'json_object',
    outputKeys,
    contract: schema.contract || '',
    primaryArtifact,
    block,
  };
}

function promptProfile(profile, row, canViewPrompt) {
  const revision = Number(row?.revision || 0);
  const overrideTemplate = row?.prompt_override || '';
  const outputContract = finalOutputContract(profile);
  const factoryWithContract = `${profile.prompts.soloPrompt.template}\n\n${outputContract.block}`;
  const profileHash = sha256(JSON.stringify({
    idx: profile.identity.idx,
    prompts: profile.prompts,
    overrideTemplate,
    config: savedConfig(row),
    skills: savedSkills(row, profile.identity.idx),
    revision,
  }));
  const boundary = '企业覆盖提示词只能追加在出厂完整提示词之后，不能替换岗位身份、核心能力、出厂岗位 Skill、工作方式、工作配置或人工审批边界。';
  if (!canViewPrompt) {
    return {
      defaultTemplate: null,
      effectiveTemplate: null,
      overrideTemplate: null,
      systemPrompt: {
        messageMode: profile.prompts.systemPrompt.messageMode,
        template: null,
        reason: profile.prompts.systemPrompt.reason,
      },
      pipelinePrompt: {
        messageMode: profile.prompts.pipelinePrompt.messageMode,
        assemblyOrder: clone(profile.prompts.pipelinePrompt.assemblyOrder),
      },
      soloPrompt: {
        messageMode: profile.prompts.soloPrompt.messageMode,
      },
      finalOutputContract: outputContract,
      hash: profileHash,
      effectiveHash: profileHash,
      revision,
      version: `content-${profile.identity.idx}-r${revision}`,
      redacted: true,
      boundary,
    };
  }
  return {
    defaultTemplate: factoryWithContract,
    overrideTemplate,
    effectiveSummary: overrideTemplate
      ? `出厂完整岗位提示词 + 当前岗位最终JSON输出契约（${outputContract.outputKeys.join('、')}；主产物${outputContract.primaryArtifact}）+ 本企业补充提示词（追加层）+ 本企业自定义技能 + 不可覆盖的人工审批边界`
      : `出厂完整岗位提示词 + 当前岗位最终JSON输出契约（${outputContract.outputKeys.join('、')}；主产物${outputContract.primaryArtifact}）+ 本企业自定义技能 + 不可覆盖的人工审批边界`,
    effectiveTemplate: overrideTemplate
      ? `${factoryWithContract}\n\n【本企业补充提示词·追加层】\n${overrideTemplate}`
      : factoryWithContract,
    systemPrompt: clone(profile.prompts.systemPrompt),
    pipelinePrompt: clone(profile.prompts.pipelinePrompt),
    soloPrompt: clone(profile.prompts.soloPrompt),
    placeholders: clone(profile.prompts.placeholders),
    interpolationPolicy: clone(profile.prompts.interpolationPolicy),
    finalOutputContract: outputContract,
    hash: profileHash,
    effectiveHash: profileHash,
    revision,
    version: `content-${profile.identity.idx}-r${revision}`,
    redacted: false,
    boundary,
  };
}

function buildProfile(idx, user) {
  const staticProfile = buildContentEmployeeWorkbenchProfile(idx);
  const tenantId = tenantIdFor(user);
  const row = configRow(idx, tenantId);
  const permissions = permissionsFor(user);
  const custom = savedSkills(row, idx);
  const config = effectiveConfig(staticProfile, row);
  const revision = Number(row?.revision || 0);
  const profileVersion = `content-${idx}-r${revision}`;
  const taskTypes = contentTaskTypes(idx);
  return {
    identity: {
      ...clone(staticProfile.identity),
      title: staticProfile.identity.name,
      department: staticProfile.identity.group,
      status: '可派活',
    },
    capabilities: clone(staticProfile.capabilities),
    workMethod: normalizeWorkMethod(staticProfile),
    skillLibrary: {
      required: clone(staticProfile.skillLibrary.required),
      historical: clone(staticProfile.skillLibrary.historical),
      custom,
      customSkills: clone(custom),
      boundary: '出厂岗位 Skill 与全部核心能力始终锁定；历史技能默认注入但必须重新核验；企业自定义技能只能追加，不能替换岗位能力。',
    },
    prompts: promptProfile(staticProfile, row, permissions.canViewPrompt),
    workConfig: {
      fields: configFields(),
      values: config,
      factoryDefault: clone(staticProfile.workConfig.factoryDefault),
      safeLegacyConfig: clone(staticProfile.workConfig.safeLegacyConfig),
      enterpriseOverrides: savedConfig(row),
      version: `r${revision}`,
      mode: 'factory_plus_tenant_overlay',
      summary: '出厂配置完整保留；企业配置仅影响运行参数，不会停用或删减岗位核心能力。',
      boundary: 'capabilitiesRequired / capabilitiesEnabled / capabilitiesLocked 始终为 true，不能通过本接口覆盖。',
    },
    jobProfile: {
      ...clone(staticProfile.jobProfile),
      duty: staticProfile.identity.duty,
      intro: staticProfile.identity.intro,
      group: staticProfile.identity.moduleGroup,
      source: staticProfile.provenance.contentCatalog.referencePath,
      sourceVersion: staticProfile.provenance.contentCatalog.schemaVersion,
      profileVersion,
      boundaries: [...new Set([
        ...(staticProfile.jobProfile.boundaries || []),
        '只形成当前岗位的待审阅交付，不冒充十工位流水线已自动完成。',
        '不得声称已经完成实际未发生的联网、发布、账号操作或其他外部执行。',
        '外部发布、付费投放、采购、合同、监管判断及不可逆动作必须由有权限的人类审批。',
      ])],
    },
    runtime: runtimeFor(idx, user),
    dispatch: {
      endpoint: `/api/employee-workbench/content/${idx}/dispatch`,
      taskTypes,
      types: [...taskTypes],
      defaultTaskType: taskTypes[0],
      defaultType: taskTypes[0],
      available: true,
      enabled: true,
      lockedCapabilityCount: staticProfile.capabilities.length,
      snapshotNotice: '派活会锁定当前岗位档案修订、全部核心能力、岗位 Skill、历史技能、企业自定义技能、工作配置与完整单用户提示词哈希。',
      form: clone(staticProfile.dispatch.form),
      guidance: clone(staticProfile.dispatch.guidance),
      approval: clone(staticProfile.dispatch.approval),
      handoff: clone(staticProfile.dispatch.handoff),
    },
    permissions,
    provenance: {
      authority: 'Paihuo内容员工权威目录 + 本企业只追加覆盖层',
      source: staticProfile.provenance.contentCatalog.referencePath,
      sourceVersion: staticProfile.provenance.contentCatalog.schemaVersion,
      referenceSha256: staticProfile.provenance.contentCatalog.referenceSha256,
      skillsCatalogHash: staticProfile.provenance.historicalSkills.snapshot.sha256,
      profileVersion,
      updatedAt: row?.updated_at || null,
      executionMode: 'single_user',
      tenantId,
      noSilentFallback: true,
      boundary: '旧项目只作为只读来源证据；本工作台与运行数据仅写入纳米Work行业版新项目数据库。',
    },
  };
}

function upsertConfig(idx, user, values) {
  const tenantId = tenantIdFor(user);
  const current = configRow(idx, tenantId);
  const prompt = Object.hasOwn(values, 'prompt')
    ? values.prompt || null
    : current?.prompt_override || null;
  const config = Object.hasOwn(values, 'config')
    ? values.config
    : savedConfig(current);
  const skills = Object.hasOwn(values, 'skills')
    ? values.skills
    : savedSkills(current, idx);
  q.run(`INSERT INTO content_employee_workbench_configs(
    tenant_id,employee_idx,prompt_override,work_config_json,skills_json,revision,updated_by,updated_at
  ) VALUES(?,?,?,?,?,1,?,datetime('now','localtime'))
  ON CONFLICT(tenant_id,employee_idx) DO UPDATE SET
    prompt_override=excluded.prompt_override,
    work_config_json=excluded.work_config_json,
    skills_json=excluded.skills_json,
    revision=content_employee_workbench_configs.revision+1,
    updated_by=excluded.updated_by,
    updated_at=excluded.updated_at`,
  tenantId, idx, prompt, JSON.stringify(config), JSON.stringify(skills), user.id);
}

function applySkillUpdate(idx, row, body) {
  if (!isPlainObject(body)) throw new WorkbenchRouteError('请求体必须是对象');
  const current = savedSkills(row, idx);
  if (Array.isArray(body.customSkills)) return normalizeCustomSkills(body.customSkills, idx);
  if (!Array.isArray(body.skills) || !body.skills.length) {
    throw new WorkbenchRouteError('skills必须是非空增量数组，或提供customSkills完整数组');
  }
  const byId = new Map(current.map(skill => [skill.id, skill]));
  for (const [index, patch] of body.skills.entries()) {
    if (!isPlainObject(patch)) throw new WorkbenchRouteError(`skills[${index}]必须是对象`);
    const id = cleanText(patch.id || patch.key, 160, `skills[${index}].id`, { required: true });
    if (!id.startsWith(`content-custom:${idx}:`) || !byId.has(id)) {
      throw new WorkbenchRouteError('出厂岗位 Skill、历史待核验技能与不存在的技能不能通过增量接口修改');
    }
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
      throw new WorkbenchRouteError(`skills[${index}].enabled必须是布尔值`);
    }
    byId.set(id, { ...byId.get(id), enabled: patch.enabled !== false });
  }
  return [...byId.values()];
}

function dispatchInput(body) {
  if (!isPlainObject(body)) throw new WorkbenchRouteError('请求体必须是对象');
  const title = cleanText(body.title, 100, 'title', { required: true });
  const type = cleanText(body.type || '岗位交付', 80, 'type', { required: true });
  const requirement = cleanText(body.requirement, 8000, 'requirement', { required: true });
  const industry = cleanText(body.industry, 200, 'industry');
  const feedback = cleanText(body.feedback, 4000, 'feedback');
  let dueAt = null;
  if (body.dueAt !== undefined && body.dueAt !== null && body.dueAt !== '') {
    dueAt = cleanText(body.dueAt, 64, 'dueAt');
    if (!Number.isFinite(Date.parse(dueAt))) throw new WorkbenchRouteError('dueAt必须是有效日期时间');
  }
  let image = null;
  let imageEvidence = null;
  if (body.image !== undefined && body.image !== null && body.image !== '') {
    if (typeof body.image !== 'string') throw new WorkbenchRouteError('图片必须使用受支持的data URL');
    const match = body.image.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/u);
    if (!match) throw new WorkbenchRouteError('图片格式不支持，仅接受PNG、JPEG或WebP');
    if (body.image.length > MAX_INLINE_IMAGE_CHARS) {
      throw new WorkbenchRouteError('图片超过8MB，请压缩后重试', 413);
    }
    const name = cleanText(body.imageName || '', 160, 'imageName')
      || `岗位证据.${match[1] === 'jpeg' || match[1] === 'jpg' ? 'jpg' : match[1]}`;
    image = body.image;
    imageEvidence = {
      name,
      mime: `image/${match[1] === 'jpg' ? 'jpeg' : match[1]}`,
      bytes: Math.floor((match[2].replace(/=+$/u, '').length * 3) / 4),
      sha256: sha256(match[2]),
      persistedRawImage: false,
    };
  }
  return { title, type, requirement, industry, feedback, dueAt, image, imageEvidence };
}

function attachmentMaterial(requirement, attachments) {
  if (!attachments.length) return requirement;
  const readable = attachments.filter(file => file.readable && String(file.content || '').trim());
  const perFileBudget = readable.length ? Math.max(1200, Math.floor(16000 / readable.length)) : 0;
  const sections = attachments.map(file => {
    const content = String(file.content || '').trim();
    if (file.readable && content) {
      return wrapUntrusted(`用户上传·${file.name}`, content.slice(0, perFileBudget));
    }
    const kind = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(String(file.ext || '').toLowerCase())
      ? '图片'
      : '文件';
    return `【附件证据·${file.name}】该${kind}已上传，但没有可读正文；只能记录文件证据，不得声称已识图、已阅读或已核验其中内容。`;
  });
  return [
    requirement,
    '',
    UNTRUSTED_GUARD,
    '【本次统一文件中心附件】',
    ...sections,
  ].join('\n');
}

async function buildEffectiveExecution(idx, user, input, attachments, webSearchFn) {
  const tenantId = tenantIdFor(user);
  const staticProfile = buildContentEmployeeWorkbenchProfile(idx);
  const row = configRow(idx, tenantId);
  const config = effectiveConfig(staticProfile, row);
  const customSkills = savedSkills(row, idx);
  const enabledCustomSkills = customSkills.filter(skill => skill.enabled);
  const attachmentRefs = attachmentRefsForStorage(attachments);
  const task = {
    direction: `${input.title}\n交付形式：${input.type}`,
    industry: input.industry,
    material: attachmentMaterial(input.requirement, attachments),
    feedback: [
      input.feedback,
      input.dueAt ? `期望时间：${input.dueAt}` : '',
    ].filter(Boolean).join('\n'),
    length: config.outputLength,
  };
  const compiled = compileContentEmployeeSoloPrompt(idx, task);
  const enterprisePrompt = row?.prompt_override || '';
  let web = {
    attempted: false,
    ok: false,
    results: [],
    note: '该岗位不强制联网；本次未触发联网检索',
  };
  if (staticProfile.workMethod.execution.webRequired) {
    const result = await webSearchFn(
      `${input.title} ${input.industry} ${input.requirement} ${staticProfile.identity.duty}`,
      { max: 5, timeoutMs: 9000 },
    );
    web = {
      attempted: true,
      ok: Boolean(result?.ok),
      results: Array.isArray(result?.results) ? result.results : [],
      note: result?.note || null,
    };
  }
  const webContext = !web.attempted
    ? ''
    : web.results.length
      ? refsBlock(web.results)
      : `\n【联网核验状态】${web.note || '本次未取得可引用的联网结果'}。禁止凭模型记忆冒充实时检索；所有需要当前官方信息的结论必须列入“待核验项”，并说明需要补查的来源。\n`;
  const overlay = [
    '',
    '【本企业运行覆盖层·只能追加，不能替换出厂岗位】',
    `企业工作配置：${JSON.stringify(config)}`,
    enterprisePrompt ? `本企业补充提示词：\n${enterprisePrompt}` : '本企业补充提示词：未配置',
    enabledCustomSkills.length
      ? `本企业启用的自定义技能：\n${enabledCustomSkills.map((skill, index) => `${index + 1}. ${skill.title}：${skill.detail}（来源：${skill.source}）`).join('\n')}`
      : '本企业启用的自定义技能：未配置',
    '',
    '【最终不可覆盖边界】',
    '本企业配置、补充提示词和自定义技能只能追加要求，不得删减、停用、替换或绕过出厂岗位身份、全部核心能力、出厂岗位 Skill、历史待核验技能、工作方式、输出契约和人工审批边界。',
    '对外发布、账号操作、付费投放、采购、合同、监管判断及不可逆动作必须由有权限的人类审批；不得声称已经完成实际未发生的联网、发布或外部执行。',
  ].join('\n');
  const effectivePrompt = `${compiled.prompt}${webContext}\n${overlay}`;
  const revision = Number(row?.revision || 0);
  const profileVersion = `content-${idx}-r${revision}`;
  const promptHash = sha256(effectivePrompt);
  const snapshot = {
    schemaVersion: 'content-employee-run-snapshot.v1',
    profileVersion,
    promptHash,
    messageMode: 'single_user',
    employee: clone(staticProfile.identity),
    capabilities: clone(staticProfile.capabilities),
    coreSkill: clone(staticProfile.skillLibrary.required),
    historicalSkills: clone(staticProfile.skillLibrary.historical),
    customSkills: clone(customSkills),
    workMethod: clone(staticProfile.workMethod),
    workConfig: {
      factory: clone(staticProfile.workConfig),
      effective: clone(config),
    },
    jobProfile: clone(staticProfile.jobProfile),
    dispatch: {
      title: input.title,
      type: input.type,
      requirement: input.requirement,
      industry: input.industry,
      feedback: input.feedback,
      dueAt: input.dueAt,
      imageEvidence: clone(input.imageEvidence),
      attachments: clone(attachmentRefs),
    },
    task: {
      ...clone(task),
      material: input.requirement,
      attachmentRefs: clone(attachmentRefs),
    },
    promptCompilation: {
      factoryPromptHash: compiled.promptHash,
      effectivePromptHash: promptHash,
      enterprisePromptAppended: Boolean(enterprisePrompt),
      customSkillsAppended: enabledCustomSkills.length,
      promptStoredInSnapshot: false,
    },
    provenance: clone(staticProfile.provenance),
    web: clone(web),
  };
  return {
    staticProfile,
    effectivePrompt,
    profileVersion,
    promptHash,
    snapshot,
    config,
  };
}

function honestDraft(input, staticProfile) {
  const webRequired = staticProfile.workMethod.execution.webRequired;
  return [
    `# ${input.title}｜${staticProfile.identity.name}待审阅岗位底稿`,
    '',
    '> 当前没有可用AI通道。本记录只是按岗位契约建立的待审阅底稿，不代表已经完成联网检索、平台账号操作、对外发布或任何外部执行。',
    '',
    '## 任务书',
    `- 交付形式：${input.type}`,
    `- 行业 / 赛道：${input.industry || '未指定'}`,
    `- 任务要求：${input.requirement}`,
    `- 上一版意见 / 必须落实：${input.feedback || '无'}`,
    `- 期望时间：${input.dueAt || '未指定'}`,
    '',
    '## 本岗位应执行的全部核心能力',
    ...staticProfile.capabilities.map((capability, index) => (
      `${index + 1}. ${capability.name}：${capability.desc}`
    )),
    '',
    '## 待补充与待核验',
    webRequired
      ? '- 本岗位要求联网核验，但当前运行没有可用AI通道；请由有权限的人补充来源、日期、链接与核验结果。'
      : '- 请由负责人补充门店真实材料、经营约束与审核意见。',
    '- 历史技能只作为待核验线索，不能当作当前平台规则或事实。',
    '',
    '## 人工审批',
    `- ${staticProfile.workMethod.approval.description}`,
    '- 审批前不得对外发布、操作账号、付费投放或执行不可逆动作。',
  ].join('\n');
}

function outputTokenBudget(outputLength) {
  if (outputLength === 'full') return 4000;
  if (outputLength === 'lite') return 1600;
  return 2800;
}

function safeBillingSummary(value) {
  if (!isPlainObject(value)) return null;
  return {
    state: value.state || 'unknown',
    estimatedCredits: Number(value.estimatedCredits) || 0,
    chargedCredits: value.chargedCredits == null ? null : Number(value.chargedCredits) || 0,
    balance: value.balance == null ? null : Number(value.balance) || 0,
    model: value.model || '',
    note: value.note || '',
  };
}

function withImmediateTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
}

function primaryArtifact(contract) {
  return contract?.artifacts?.find(artifact => artifact.primary) || contract?.artifacts?.[0] || null;
}

function materialTypeForRun(row, artifact) {
  const artifactLabels = {
    html: 'HTML演绎稿',
    markdown: '内容文稿',
    images: '图片素材方案',
    covers: '封面素材方案',
    publish_packages: '平台发布包',
    json: '结构化内容资料',
  };
  return artifactLabels[artifact?.kind] || row.type || '数字员工产出';
}

function runMaterialSnapshots(row, snapshot) {
  const rawArtifacts = Array.isArray(snapshot.artifacts)
    ? snapshot.artifacts
    : isPlainObject(snapshot.contract) && Array.isArray(snapshot.contract.artifacts)
      ? snapshot.contract.artifacts
      : [];
  const artifact = rawArtifacts.find(item => item?.primary === true) || rawArtifacts[0] || null;
  const bodySnapshot = String(row.result_md || '');
  const artifactSnapshot = artifact
    ? JSON.stringify({
      kind: artifact.kind || 'unknown',
      primary: artifact.primary === true,
      filename: artifact.filename || null,
      mediaType: artifact.mediaType || 'application/octet-stream',
      employeeIdx: Number(artifact.employeeIdx ?? row.employee_idx),
      employeeKey: artifact.employeeKey || row.employee_key,
      sourceKeys: Array.isArray(artifact.sourceKeys) ? clone(artifact.sourceKeys) : [],
      // HTML 主文件必须随素材独立持久化；其他岗位的完整正文保存在 body_snapshot。
      ...(artifact.kind === 'html' && typeof artifact.content === 'string'
        ? { content: artifact.content }
        : {}),
    })
    : JSON.stringify({
      kind: 'markdown',
      primary: true,
      mediaType: 'text/markdown',
      employeeIdx: Number(row.employee_idx),
      employeeKey: row.employee_key,
    });
  return {
    bodySnapshot,
    artifactSnapshot,
    snapshotHash: sha256(JSON.stringify({
      body: bodySnapshot,
      artifact: JSON.parse(artifactSnapshot),
    })),
  };
}

function repairRunMaterialSnapshot(material, row, snapshot) {
  const expected = runMaterialSnapshots(row, snapshot);
  const bodySnapshot = String(material.body_snapshot || '').trim()
    ? material.body_snapshot
    : expected.bodySnapshot;
  const artifactSnapshot = String(material.artifact_snapshot_json || '').trim()
    ? material.artifact_snapshot_json
    : expected.artifactSnapshot;
  const snapshotHash = String(material.snapshot_hash || '').trim()
    ? material.snapshot_hash
    : sha256(JSON.stringify({
      body: bodySnapshot,
      artifact: (() => {
        try { return JSON.parse(artifactSnapshot); } catch { return artifactSnapshot; }
      })(),
    }));
  const changed = q.run(`UPDATE materials SET
      body_snapshot=CASE WHEN body_snapshot IS NULL OR body_snapshot='' THEN ? ELSE body_snapshot END,
      artifact_snapshot_json=CASE WHEN artifact_snapshot_json IS NULL OR artifact_snapshot_json='' THEN ? ELSE artifact_snapshot_json END,
      snapshot_hash=CASE WHEN snapshot_hash IS NULL OR snapshot_hash='' THEN ? ELSE snapshot_hash END
    WHERE tenant_id=? AND id=? AND (
      body_snapshot IS NULL OR body_snapshot='' OR
      artifact_snapshot_json IS NULL OR artifact_snapshot_json='' OR
      snapshot_hash IS NULL OR snapshot_hash=''
    )`,
  expected.bodySnapshot, expected.artifactSnapshot, snapshotHash,
  tenantIdFor({ tenant_id: material.tenant_id }), material.id);
  return {
    row: q.get(`SELECT * FROM materials WHERE tenant_id=? AND id=?`,
      Number(material.tenant_id), Number(material.id)),
    repaired: changed.changes > 0,
  };
}

function ensureRunMaterial(row, snapshot, reviewer) {
  const tenantId = tenantIdFor(reviewer);
  const existed = q.get(`SELECT * FROM materials
    WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?
    ORDER BY id ASC LIMIT 1`, tenantId, row.id);
  if (existed) return repairRunMaterialSnapshot(existed, row, snapshot).row;

  const contract = publicContract(snapshot, row);
  if (contract?.valid !== true) {
    throw new WorkbenchRouteError('输出格式契约尚未通过，不能进入内容生产仓素材库', 409);
  }
  const artifact = primaryArtifact(contract);
  const artifactIndex = contract.artifacts.indexOf(artifact);
  const url = artifact?.kind === 'html' && artifactIndex >= 0
    ? `/api/employee-workbench/content/${row.employee_idx}/runs/${row.id}/artifacts/${artifactIndex}`
    : null;
  const name = `${row.employee_name}｜${row.title}`;
  const type = materialTypeForRun(row, artifact);
  const tags = [...new Set([
    '数字员工产出',
    '已采纳',
    row.employee_name,
    row.employee_group,
    row.type,
    artifact?.kind,
  ].filter(Boolean))].join(',');
  const note = [
    `来源：内容员工单派运行 #${row.id}`,
    `岗位：${row.employee_name}（${row.employee_group}）`,
    `任务：${row.title} / ${row.type}`,
    `主产物：${artifact?.kind || '结构化岗位产物'}${artifact?.filename ? ` / ${artifact.filename}` : ''}`,
    `审阅人：${reviewer.name || reviewer.id}`,
    '仅将已采纳产物沉淀为内容生产仓素材；未创建可发布内容，未执行对外发布。',
  ].join('；');
  const stored = runMaterialSnapshots(row, snapshot);
  const inserted = q.run(`INSERT INTO materials(
    name,type,tags,url,source_type,source_id,creator_id,note,
    body_snapshot,artifact_snapshot_json,snapshot_hash
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  name, type, tags, url, 'content_employee_run', row.id, row.created_by, note,
  stored.bodySnapshot, stored.artifactSnapshot, stored.snapshotHash);
  return q.get(`SELECT * FROM materials WHERE tenant_id=? AND id=?`,
    tenantId, Number(inserted.lastInsertRowid));
}

function ensurePublishableContentFromRun(row, snapshot, reviewer) {
  if (Number(row.employee_idx) !== 8) return null;
  const tenantId = tenantIdFor(reviewer);
  const existed = q.get(`SELECT * FROM contents
    WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?
    ORDER BY id ASC LIMIT 1`, tenantId, row.id);
  if (existed) {
    ensureContentAsset(existed, {
      tenantId,
      creatorId: row.created_by,
      note: `分发官产出经人工采纳形成可发布内容；来源=content_employee_run#${row.id}；未执行对外发布。`,
    });
    return existed;
  }
  const body = String(row.result_md || '').trim();
  if (!body) throw new WorkbenchRouteError('分发官产出正文为空，不能形成可发布内容', 409);
  const sourceSnapshot = {
    source: { type: 'content_employee_run', id: Number(row.id) },
    adoptedReview: {
      reviewerId: Number(reviewer.id),
      reviewerName: reviewer.name || '',
      reviewerRole: reviewer.role,
      adoptedAt: new Date().toISOString(),
    },
    contract: publicContract(snapshot, row),
    boundary: '本内容由分发官产出经人工采纳形成；可继续走发布登记，但系统没有自动对外发布。',
  };
  const inserted = q.run(`INSERT INTO contents(
    type,title,body,topic,brand,status,risk_flags,risk_level,ai_mode,creator_id,
    content_employee_idx,content_employee_key,content_employee_name,content_employee_group,content_run_mode,
    profile_version,prompt_hash,snapshot_json,source_type,source_id
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  row.type || '平台发布包', row.title, body, row.title, '', '可使用', '[]', 'none',
  row.ai_mode || 'human_adopted', row.created_by,
  row.employee_idx, row.employee_key, row.employee_name, row.employee_group, 'single_station_adopted',
  row.profile_version, row.prompt_hash, JSON.stringify(sourceSnapshot),
  'content_employee_run', row.id);
  const content = q.get(`SELECT * FROM contents WHERE tenant_id=? AND id=?`,
    tenantId, Number(inserted.lastInsertRowid));
  ensureContentAsset(content, {
    tenantId,
    creatorId: row.created_by,
    note: `分发官产出经人工采纳形成可发布内容；来源=content_employee_run#${row.id}；未执行对外发布。`,
  });
  return content;
}

async function executeRun({
  runId,
  tenantId,
  userId,
  role,
  input,
  execution,
  hold,
  generateFn,
  settleHoldFn,
  releaseHoldFn,
  notifyFn,
  signal,
}) {
  try {
    const maxTokens = outputTokenBudget(execution.config.outputLength);
    const model = !input.image && execution.config.textModel
      && execution.config.textModel !== 'inherit'
      ? execution.config.textModel
      : undefined;
    const output = await generateFn({
      kind: 'content-employee-workbench',
      system: '',
      userMsg: execution.effectivePrompt,
      messages: input.image ? [{
        role: 'user',
        content: [
          { type: 'text', text: execution.effectivePrompt },
          { type: 'image_url', image_url: { url: input.image } },
        ],
      }] : undefined,
      fallback: () => honestDraft(input, execution.staticProfile),
      maxTokens,
      role,
      model,
      timeoutMs: execution.config.timeoutSeconds * 1000,
      signal,
    });
    const text = typeof output?.text === 'string' ? output.text.trim() : '';
    if (!text) throw new Error('内容员工执行没有返回可保存的文本');
    const contract = validateContentEmployeeOutputContract(
      execution.staticProfile.identity.idx,
      text,
    );
    const snapshot = clone(execution.snapshot);
    snapshot.contractValid = contract.valid;
    snapshot.contractErrors = clone(contract.errors);
    snapshot.previewMarkdown = contract.previewMarkdown || text;
    snapshot.artifacts = contract.artifacts.map(artifact => ({
      kind: artifact.kind,
      primary: artifact.primary === true,
      filename: artifact.filename,
      mediaType: artifact.mediaType,
      employeeIdx: artifact.employeeIdx,
      employeeKey: artifact.employeeKey,
      sourceKeys: clone(artifact.sourceKeys),
      ...(artifact.kind === 'html' ? { content: artifact.content } : {}),
    }));
    try {
      const settled = settleHoldFn(hold, {
        usage: output.usage,
        model: output.model,
        aiMode: output.mode,
        note: `内容员工运行#${runId}生成成功`,
      });
      snapshot.billing = safeBillingSummary({
        state: 'settled',
        estimatedCredits: hold.credits,
        chargedCredits: settled?.credits ?? hold.credits,
        balance: settled?.balance ?? hold.balance,
        model: output.model || hold.model,
        note: '已按真实用量结算；未执行对外发布。',
      });
    } catch (settleError) {
      console.error(`[credits] 内容员工运行#${runId}结算失败，保留预授权占扣待人工对账:`,
        settleError?.message || settleError);
      snapshot.billing = safeBillingSummary({
        state: 'pending_reconciliation',
        estimatedCredits: hold.credits,
        chargedCredits: null,
        balance: hold.balance,
        model: output.model || hold.model,
        note: '生成已成功，预授权占扣保留待人工对账；未执行对外发布。',
      });
    }
    q.run(`UPDATE content_employee_runs
      SET status='待审阅',result_md=?,ai_mode=?,model=?,snapshot_json=?,updated_at=datetime('now','localtime')
      WHERE tenant_id=? AND id=? AND status='生成中'`,
    contract.previewMarkdown || text, output.mode || 'unknown', output.model || 'unknown',
    JSON.stringify(snapshot), tenantId, runId);
    try {
      const billed = snapshot.billing?.state === 'settled'
        ? `实扣${snapshot.billing.chargedCredits}积分`
        : '预授权占扣待对账';
      notifyFn(userId, 'content', `${execution.staticProfile.identity.name}已完成「${input.title}」`,
        `产出已进入人工审阅（${billed}）；未创建可发布内容，未执行对外发布。`);
    } catch (notifyError) {
      console.error(`[content-employee-workbench] run#${runId}完成通知失败:`,
        notifyError?.message || notifyError);
    }
  } catch (error) {
    let released;
    let releaseFailed = false;
    try {
      released = releaseHoldFn(hold,
        `内容员工运行#${runId}生成失败（${String(error?.message || '').slice(0, 80)}），预授权全额退回`);
    } catch (releaseError) {
      releaseFailed = true;
      console.error(`[credits] 内容员工运行#${runId}释放预授权失败，保留待人工对账:`,
        releaseError?.message || releaseError);
    }
    const failedSnapshot = parseRunSnapshot(failureSnapshot(tenantId, runId, error));
    failedSnapshot.billing = safeBillingSummary({
      state: releaseFailed ? 'pending_reconciliation' : 'released',
      estimatedCredits: hold.credits,
      chargedCredits: releaseFailed ? null : (released?.credits ?? 0),
      balance: released?.balance ?? hold.balance,
      model: hold.model,
      note: releaseFailed
        ? '生成失败，预授权释放异常，保留待人工对账；未执行对外发布。'
        : '生成失败，预授权已全额退回；未执行对外发布。',
    });
    q.run(`UPDATE content_employee_runs
      SET status='失败',result_md=NULL,ai_mode='failed',model=NULL,snapshot_json=?,updated_at=datetime('now','localtime')
      WHERE tenant_id=? AND id=? AND status='生成中'`, JSON.stringify(failedSnapshot), tenantId, runId);
    try {
      notifyFn(userId, 'content', `${execution.staticProfile.identity.name}任务「${input.title}」生成失败`,
        `${String(error?.message || error).slice(0, 100)}；${releaseFailed ? '预授权释放异常，已留待对账' : '预授权已退回'}；未执行对外发布。`);
    } catch (notifyError) {
      console.error(`[content-employee-workbench] run#${runId}失败通知失败:`,
        notifyError?.message || notifyError);
    }
    console.error(`[content-employee-workbench] run#${runId} failed: ${error?.message || error}`);
  }
}

function defaultSchedule(task) {
  setImmediate(() => {
    Promise.resolve(task()).catch(error => {
      console.error('[content-employee-workbench] background task failed:', error?.message || error);
    });
  });
}

export function createContentEmployeeWorkbenchRouter({
  generateFn = generate,
  webSearchFn = webSearch,
  scheduleFn = defaultSchedule,
  precheckByRoleFn = precheckByRole,
  estimateCallCreditsFn = estimateCallCredits,
  holdCreditsFn = holdCredits,
  settleHoldFn = settleHold,
  releaseHoldFn = releaseHold,
  notifyFn = notify,
  logOpFn = logOp,
} = {}) {
  const router = Router();

  function sendError(res, error) {
    res.status(error?.status || 400).json({ error: error?.message || '内容员工工作台操作失败' });
  }

  router.get('/:idx/runs', (req, res) => {
    try {
      const idx = employeeIdx(req.params.idx);
      const requestedLimit = req.query.limit === undefined ? 8 : Number(req.query.limit);
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
        throw new WorkbenchRouteError('limit必须是1-50之间的整数');
      }
      const tenantId = tenantIdFor(req.user);
      const access = runAccess(req.user);
      const rows = q.all(`SELECT * FROM content_employee_runs
        WHERE tenant_id=? AND employee_idx=?${access.sql}
        ORDER BY id DESC LIMIT ?`,
      tenantId, idx, ...access.params, requestedLimit);
      const total = q.get(`SELECT COUNT(*) n FROM content_employee_runs
        WHERE tenant_id=? AND employee_idx=?${access.sql}`,
      tenantId, idx, ...access.params)?.n || 0;
      res.set('Cache-Control', 'private, no-store');
      res.json({
        runs: rows.map(row => publicRun(row, req.user)),
        total: Number(total),
        limit: requestedLimit,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:idx/runs/:runId', (req, res) => {
    try {
      const idx = employeeIdx(req.params.idx);
      const row = runRow(idx, runId(req.params.runId), req.user);
      if (!row) throw new WorkbenchRouteError('运行记录不存在或无权查看', 404);
      res.set('Cache-Control', 'private, no-store');
      res.json({ run: publicRun(row, req.user, { includeSnapshot: true }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:idx/runs/:runId/artifacts/:artifactIndex', (req, res) => {
    try {
      const idx = employeeIdx(req.params.idx);
      const id = runId(req.params.runId);
      const artifactIndex = Number(req.params.artifactIndex);
      if (!Number.isInteger(artifactIndex) || artifactIndex < 0 || artifactIndex > 20) {
        throw new WorkbenchRouteError('产物编号无效');
      }
      const row = runRow(idx, id, req.user);
      if (!row) throw new WorkbenchRouteError('运行记录不存在或无权查看', 404);
      const snapshot = parseRunSnapshot(row.snapshot_json);
      const artifacts = Array.isArray(snapshot.artifacts)
        ? snapshot.artifacts
        : isPlainObject(snapshot.contract) && Array.isArray(snapshot.contract.artifacts)
          ? snapshot.contract.artifacts
          : [];
      const artifact = artifacts[artifactIndex];
      if (idx !== 7 || artifact?.kind !== 'html' || typeof artifact?.content !== 'string') {
        throw new WorkbenchRouteError('HTML演绎产物不存在', 404);
      }
      const filename = String(artifact.filename || `content-employee-07-deck-${id}.html`)
        .replace(/[^a-zA-Z0-9._-]/g, '-')
        .slice(0, 180);
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename || `content-employee-07-deck-${id}.html`}"`,
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(artifact.content);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:idx/runs/:runId/review', (req, res) => {
    try {
      assertReviewer(req.user);
      const idx = employeeIdx(req.params.idx);
      const id = runId(req.params.runId);
      const decision = req.body?.decision;
      if (!['adopt', 'reject'].includes(decision)) {
        throw new WorkbenchRouteError('请选择采纳或驳回');
      }
      const opinion = cleanText(req.body?.opinion ?? req.body?.reason, 1000, '审阅意见');
      if (decision === 'reject' && !opinion) {
        throw new WorkbenchRouteError('驳回必须填写意见');
      }

      const targetStatus = decision === 'adopt' ? '已完成' : '已驳回';
      const outcome = withImmediateTransaction(() => {
        const row = runRow(idx, id, req.user);
        if (!row) throw new WorkbenchRouteError('运行记录不存在或无权审阅', 404);
        if (row.status === targetStatus) {
          const snapshot = parseRunSnapshot(row.snapshot_json);
          const material = decision === 'adopt'
            ? ensureRunMaterial(row, snapshot, req.user)
            : null;
          const content = decision === 'adopt'
            ? ensurePublishableContentFromRun(row, snapshot, req.user)
            : null;
          if (decision === 'adopt' && isPlainObject(snapshot.review)
            && (Number(snapshot.review.materialId) !== Number(material?.id)
              || Number(snapshot.review.contentId || 0) !== Number(content?.id || 0))) {
            snapshot.review.materialId = material ? Number(material.id) : null;
            snapshot.review.contentId = content ? Number(content.id) : null;
            q.run(`UPDATE content_employee_runs SET snapshot_json=?,updated_at=datetime('now','localtime')
              WHERE tenant_id=? AND employee_idx=? AND id=?`,
            JSON.stringify(snapshot), tenantIdFor(req.user), idx, id);
          }
          return {
            alreadyReviewed: true,
            row: runRow(idx, id, req.user),
            materialId: material ? Number(material.id) : Number(snapshot.review?.materialId) || null,
            contentId: content ? Number(content.id) : Number(snapshot.review?.contentId) || null,
          };
        }
        if (['已完成', '已驳回'].includes(row.status)) {
          throw new WorkbenchRouteError(
            `该产出已经${runStatusLabel(row.status)}，不能改为${runStatusLabel(targetStatus)}`,
            409,
          );
        }
        if (row.status !== '待审阅') {
          throw new WorkbenchRouteError(
            row.status === '生成中' ? '产出仍在生成中，暂不能审阅' : '失败任务没有可审阅产出',
            409,
          );
        }

        const snapshot = parseRunSnapshot(row.snapshot_json);
        const contract = publicContract(snapshot, row);
        if (decision === 'adopt' && contract?.valid !== true) {
          throw new WorkbenchRouteError(
            '输出格式契约尚未通过，不能采纳；请驳回并填写返工意见，修复格式后重新提交。',
            409,
          );
        }
        const material = decision === 'adopt'
          ? ensureRunMaterial(row, snapshot, req.user)
          : null;
        const content = decision === 'adopt'
          ? ensurePublishableContentFromRun(row, snapshot, req.user)
          : null;
        const reviewedAt = new Date().toISOString();
        snapshot.review = {
          decision,
          reviewerId: Number(req.user.id),
          reviewerName: req.user.name || '',
          reviewerRole: req.user.role,
          reviewedAt,
          opinion,
          materialId: material ? Number(material.id) : null,
          contentId: content ? Number(content.id) : null,
        };
        const changed = q.run(`UPDATE content_employee_runs
          SET status=?,snapshot_json=?,updated_at=datetime('now','localtime')
          WHERE tenant_id=? AND employee_idx=? AND id=? AND status='待审阅'`,
        targetStatus, JSON.stringify(snapshot), tenantIdFor(req.user), idx, id);
        if (!changed.changes) {
          throw new WorkbenchRouteError('该产出已被其他审阅人处理，请刷新后查看', 409);
        }
        return {
          alreadyReviewed: false,
          row: runRow(idx, id, req.user),
          materialId: material ? Number(material.id) : null,
          contentId: content ? Number(content.id) : null,
        };
      });

      if (!outcome.alreadyReviewed) {
        logOpFn(req.user, '内容生产仓', decision === 'adopt' ? '采纳内容员工产出并入素材库' : '驳回内容员工产出',
          `run#${id}${outcome.materialId ? `/material#${outcome.materialId}` : ''}${outcome.contentId ? `/content#${outcome.contentId}` : ''}；未执行外发`);
        if (Number(outcome.row.created_by) !== Number(req.user.id)) {
          try {
            notifyFn(outcome.row.created_by, 'content',
              `内容员工任务「${outcome.row.title}」${decision === 'adopt' ? '已采纳' : '已驳回'}`,
              decision === 'adopt'
                ? outcome.contentId
                  ? `产出已沉淀到内容生产仓素材 #${outcome.materialId}，并经人工采纳形成可发布内容 #${outcome.contentId}；未执行对外发布。`
                  : `产出已沉淀到内容生产仓素材 #${outcome.materialId}；未创建可发布内容，未执行对外发布。`
                : `返工意见：${opinion}；未创建可发布内容，未执行对外发布。`);
          } catch (notifyError) {
            console.error(`[content-employee-workbench] run#${id}审阅通知失败:`,
              notifyError?.message || notifyError);
          }
        }
      }
      res.json({
        ok: true,
        alreadyReviewed: outcome.alreadyReviewed,
        materialId: outcome.materialId,
        contentId: outcome.contentId || null,
        run: publicRun(outcome.row, req.user, { includeSnapshot: true }),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:idx', (req, res) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.json(buildProfile(employeeIdx(req.params.idx), req.user));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/:idx/prompt', (req, res) => {
    try {
      assertManager(req.user);
      const idx = employeeIdx(req.params.idx);
      if (!isPlainObject(req.body) || !Object.hasOwn(req.body, 'overrideTemplate')) {
        throw new WorkbenchRouteError('overrideTemplate字段必填；传空字符串表示恢复出厂提示词');
      }
      const prompt = cleanText(req.body.overrideTemplate, 20000, 'overrideTemplate');
      upsertConfig(idx, req.user, { prompt });
      res.json({ profile: buildProfile(idx, req.user) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/:idx/config', (req, res) => {
    try {
      assertManager(req.user);
      const idx = employeeIdx(req.params.idx);
      if (!isPlainObject(req.body) || !Object.hasOwn(req.body, 'values')) {
        throw new WorkbenchRouteError('values字段必填且必须是对象');
      }
      const tenantId = tenantIdFor(req.user);
      const current = configRow(idx, tenantId);
      const patch = normalizeConfigPatch(req.body.values);
      upsertConfig(idx, req.user, { config: { ...savedConfig(current), ...patch } });
      res.json({ profile: buildProfile(idx, req.user) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/:idx/skills', (req, res) => {
    try {
      assertManager(req.user);
      const idx = employeeIdx(req.params.idx);
      const tenantId = tenantIdFor(req.user);
      const skills = applySkillUpdate(idx, configRow(idx, tenantId), req.body);
      upsertConfig(idx, req.user, { skills });
      res.json({ profile: buildProfile(idx, req.user) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/:idx/capabilities', (req, res) => {
    try {
      assertManager(req.user);
      employeeIdx(req.params.idx);
      res.status(400).json({ error: '内容员工全部核心能力是出厂硬能力，不能停用、删除或降级' });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:idx/dispatch', async (req, res) => {
    let hold = null;
    let backgroundStarted = false;
    try {
      const idx = employeeIdx(req.params.idx);
      const permissions = permissionsFor(req.user);
      if (!permissions.canDispatch) throw new WorkbenchRouteError('当前账号无权派活', 403);
      const input = dispatchInput(req.body);
      const attachments = resolveRequestedAttachments(req.body?.fileIds, req.user, 6);
      const execution = await buildEffectiveExecution(idx, req.user, input, attachments, webSearchFn);
      const employee = CONTENT_EMPLOYEES[idx];
      const tenantId = tenantIdFor(req.user);
      const holdModel = execution.config.textModel && execution.config.textModel !== 'inherit'
        ? execution.config.textModel
        : '';
      precheckByRoleFn(req.user.id, 'text', req.user.role);
      const estimatedCredits = estimateCallCreditsFn({
        kind: 'text',
        model: holdModel,
        outputTokens: outputTokenBudget(execution.config.outputLength),
        texts: [
          execution.effectivePrompt,
          input.image
            ? `视觉附件：${input.imageEvidence?.mime || 'image'}，约${Math.ceil(input.image.length * 0.75)}字节`
            : '',
        ],
      });
      hold = holdCreditsFn({
        userId: req.user.id,
        feature: `内容员工单派·${employee.name}`,
        kind: 'text',
        model: holdModel,
        credits: estimatedCredits,
        note: `任务“${input.title}”按最终提示词、视觉附件和期望输出长度预授权；生成失败全额退回。`,
      });
      execution.snapshot.billing = safeBillingSummary({
        state: 'held',
        estimatedCredits: hold.credits,
        chargedCredits: null,
        balance: hold.balance,
        model: hold.model || holdModel,
        note: '已预授权占扣，后台生成后按真实用量结算；未执行对外发布。',
      });
      const inserted = q.run(`INSERT INTO content_employee_runs(
        tenant_id,employee_idx,employee_key,employee_name,employee_group,
        title,type,requirement,due_at,status,result_md,ai_mode,model,
        profile_version,prompt_hash,snapshot_json,created_by,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'生成中',NULL,NULL,NULL,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`,
      tenantId, idx, employee.key, employee.name, employee.group,
      input.title, input.type, input.requirement, input.dueAt,
      execution.profileVersion, execution.promptHash, JSON.stringify(execution.snapshot), req.user.id);
      const runId = Number(inserted.lastInsertRowid);
      const role = req.user.role;
      const requestSignal = req.requestSignal;
      scheduleFn(() => runWithTenant(tenantId, () => executeRun({
        runId,
        tenantId,
        userId: req.user.id,
        role,
        input,
        execution,
        hold,
        generateFn,
        settleHoldFn,
        releaseHoldFn,
        notifyFn,
        signal: requestSignal,
      })));
      backgroundStarted = true;
      logOpFn(req.user, '内容生产仓', '派发内容员工任务',
        `${employee.name}:run#${runId}:${input.title}；已预授权${hold.credits}积分；未执行外发`);
      res.json({
        runId,
        taskId: runId,
        status: '生成中',
        queued: true,
        msg: `${employee.name}已接单，完整能力快照已锁定；结果生成后进入人工审阅。`,
        billing: safeBillingSummary(execution.snapshot.billing),
        snapshot: {
          profileVersion: execution.profileVersion,
          promptHash: execution.promptHash,
          capabilityCount: execution.snapshot.capabilities.length,
          skillCount: execution.snapshot.coreSkill.length
            + execution.snapshot.historicalSkills.length
            + execution.snapshot.customSkills.filter(skill => skill.enabled).length,
          configVersion: `r${configRow(idx, tenantId)?.revision || 0}`,
          messageMode: 'single_user',
          employeeIdx: idx,
          employeeKey: employee.key,
          status: '生成中',
        },
      });
    } catch (error) {
      if (hold && !backgroundStarted) {
        try {
          releaseHoldFn(hold,
            `内容员工任务派发失败（${String(error?.message || '').slice(0, 80)}），预授权全额退回`);
        } catch (releaseError) {
          console.error('[credits] 内容员工任务派发失败且预授权释放异常，保留待人工对账:',
            releaseError?.message || releaseError);
        }
      }
      sendError(res, error);
    }
  });

  return router;
}

export default createContentEmployeeWorkbenchRouter();

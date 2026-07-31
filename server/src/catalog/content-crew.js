import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMPLOYEE_SKILL_EVIDENCE_CATALOG_PATH,
  validateEmployeeSkillEvidenceCatalog,
  verifiedEmployeeSkillsFor,
} from './employee-skills-verification.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONTENT_CREW_CATALOG_PATH = path.join(__dirname, '..', '..', 'catalog', 'content-crew.json');
export const EMPLOYEE_SKILL_CATALOG_PATH = EMPLOYEE_SKILL_EVIDENCE_CATALOG_PATH;

const EXPECTED_IDENTITIES = [
  [0, 'trend', '趋势官', '热点雷达部'],
  [1, 'research', '情报员', '情报检索部'],
  [2, 'benchmark', '拆解师', '爆款研究部'],
  [3, 'draft', '撰稿人', '文案创作部'],
  [4, 'style', '文风师', '风格工坊'],
  [5, 'media', '多媒体师', '视觉工厂'],
  [6, 'cover', '封面师', '封面设计部'],
  [7, 'deck', '演绎师', '互动演绎部'],
  [8, 'publish', '分发官', '发行调度部'],
  [9, 'retro', '复盘官', '数据复盘部'],
];

const APPROVALS = new Set(['pick', 'review', 'auto', 'force']);
const CONTENT_SKILL_COUNTS = [12, 6, 6, 5, 6, 6, 6, 6, 6, 6];
const EXPECTED_SKILL_INDEXES = [
  ...Array.from({ length: 10 }, (_, idx) => idx),
  ...Array.from({ length: 60 }, (_, idx) => idx + 101),
];
const ALLOWED_TEXT_MODELS = new Set([null, 'deepseek-v4-flash', 'gpt-5.5']);
const ALLOWED_IMAGE_MODELS = new Set([null, 'gpt-image-2']);
const ALLOWED_SETTING_KEYS = new Set(['channels', 'targets', 'dimensions']);
const ALLOWED_CONNECTOR_MODES = new Set([
  'verified_input_assist',
  'local_contract_assist',
  'employee_generation',
]);
const ALLOWED_CONNECTOR_STATUSES = new Set([
  'requires_live_data',
  'local_assist_ready',
  'single_station',
]);
const CONNECTOR_STATUS_BY_MODE = Object.freeze({
  verified_input_assist: 'requires_live_data',
  local_contract_assist: 'local_assist_ready',
  employee_generation: 'single_station',
});
const ALLOWED_LIVE_DATA_REQUIREMENTS = new Set(['required', 'optional', 'not_required']);

function fail(message) {
  throw new Error(`内容生产仓目录无效：${message}`);
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label}不能为空`);
}

function objectValue(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象`);
}

function exactKeys(value, allowed, label) {
  const extras = Object.keys(value).filter(key => !allowed.includes(key));
  if (extras.length) fail(`${label}包含非白名单字段：${extras.join('、')}`);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function normalizeCurrentProjectContentWording(value) {
  const normalized = structuredClone(value);
  for (const employee of normalized.employees || []) {
    const replaceLegacyLabels = input => String(input || '')
      .replaceAll('生成正文配图(V1:SVG 信息图)', '生成正文配图与SVG信息图')
      .replaceAll(
        'V1 适配层用联网检索近似替代平台爬虫;商业授权闭环后切换为真实采集',
        '当前运行使用已接通的联网检索核验公开信息;未授权的平台账号或采集连接器不得冒充已经执行',
      )
      .replaceAll(
        '对应开源 Skill:Auto-Redbook-Skills,V1 只用其文案生成职责',
        '对应开源 Skill:Auto-Redbook-Skills;本岗位完整承担文案生成职责',
      )
      .replaceAll(
        'V1 未接 muapi.ai 付费生图,用精美 SVG 信息图/插画本地渲染,零成本;接入后可切换 AI 生图',
        '按当前已启用连接器生成视觉素材;没有外部生图连接器时使用可审阅的 SVG 信息图,不得冒充外部生图已经完成',
      )
      .replaceAll(
        'V1 未托管真实平台账号,产出"各平台完整发布包",老板一键复制/打包上传;\n 绑定平台 Cookie 后可切换为真实自动发布',
        '默认产出各平台完整发布包并进入人工终审;只有账号已授权且发布连接器明确启用时才允许执行平台操作',
      )
      .replaceAll(
        'V1 未接真实平台数据回流,产出"发布后复盘计划+预测性复盘";接入采集后切换为 T+1/3/7 真实数据',
        '有真实平台数据时按 T+1/3/7 复盘;没有数据时只形成复盘计划和待补数据清单,不得把预测冒充真实成效',
      );
    employee.duty = replaceLegacyLabels(employee.duty);
    if (employee.workMethod?.output) {
      employee.workMethod.output.duty = replaceLegacyLabels(employee.workMethod.output.duty);
    }
    if (employee.pipelinePrompt) {
      employee.pipelinePrompt.template = replaceLegacyLabels(employee.pipelinePrompt.template);
    }
    if (employee.soloPrompt) {
      employee.soloPrompt.template = replaceLegacyLabels(employee.soloPrompt.template);
    }
  }
  return normalized;
}

export function validateContentCrewCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('根节点必须是对象');
  if (value.department?.key !== 'content' || value.department?.name !== '内容生产部') {
    fail('部门必须是 content / 内容生产部');
  }
  if (value.department?.employeeTotal !== 10) fail('employeeTotal必须为10');
  if (!Array.isArray(value.employees) || value.employees.length !== 10) fail('必须恰好包含10名正式员工');
  if (!Array.isArray(value.moduleGroups) || value.moduleGroups.length !== 4) fail('必须包含4个生产阶段分组');
  if (value.qualityGate?.employee !== false || value.qualityGate?.countedInEmployeeTotal !== false) {
    fail('审查官必须是独立quality_gate服务，不能计入员工总数');
  }
  if (value.qualityGate?.idx !== undefined && value.qualityGate?.idx !== null) fail('审查官不能拥有员工idx');

  const idxSet = new Set();
  const keySet = new Set();
  const connectorKindSet = new Set();
  const groupMembership = new Map();
  let capabilityTotal = 0;
  for (const group of value.moduleGroups) {
    nonEmpty(group?.key, '模块分组key');
    nonEmpty(group?.name, `模块分组${group?.key || '-'}名称`);
    if (!Array.isArray(group.members) || !group.members.length) fail(`模块分组${group.key}没有成员`);
    for (const idx of group.members) {
      if (groupMembership.has(idx)) fail(`员工${idx}被多个模块分组引用`);
      groupMembership.set(idx, group.key);
    }
  }

  for (let order = 0; order < EXPECTED_IDENTITIES.length; order += 1) {
    const employee = value.employees[order];
    const [idx, key, name, group] = EXPECTED_IDENTITIES[order];
    if (employee?.idx !== idx || employee?.key !== key || employee?.name !== name || employee?.group !== group) {
      fail(`员工${order}身份不匹配，必须为${idx}/${key}/${name}/${group}`);
    }
    if (employee.person !== null) fail(`员工${idx}的person必须为null，禁止虚构人物姓名`);
    if (idxSet.has(idx) || keySet.has(key)) fail(`员工idx或key重复：${idx}/${key}`);
    idxSet.add(idx); keySet.add(key);
    for (const field of ['moduleGroup', 'skill', 'emoji', 'color', 'duty', 'intro', 'approval']) {
      nonEmpty(employee[field], `员工${idx}.${field}`);
    }
    if (groupMembership.get(idx) !== employee.moduleGroup) fail(`员工${idx}的moduleGroup与阶段成员表不一致`);
    if (!APPROVALS.has(employee.approval)) fail(`员工${idx}的approval不正确`);
    if (employee.optional !== (idx === 7)) fail('仅演绎师(idx=7)允许optional=true');
    if (!Array.isArray(employee.capabilities) || !employee.capabilities.length) fail(`员工${idx}缺少capabilities`);
    const capabilityNames = new Set();
    for (const capability of employee.capabilities) {
      for (const field of ['name', 'emoji', 'desc']) nonEmpty(capability?.[field], `员工${idx}.capability.${field}`);
      if (capability.required !== true || capability.enabled !== true || capability.locked !== true) {
        fail(`员工${idx}核心能力必须required/enabled/locked`);
      }
      if (capabilityNames.has(capability.name)) fail(`员工${idx}能力名称重复：${capability.name}`);
      capabilityNames.add(capability.name);
    }
    capabilityTotal += employee.capabilities.length;
    if (!Array.isArray(employee.outputKeys) || !employee.outputKeys.length || employee.outputKeys.some(keyName => typeof keyName !== 'string' || !keyName)) {
      fail(`员工${idx}的outputKeys不完整`);
    }
    objectValue(employee.skillProfile, `员工${idx}.skillProfile`);
    if (employee.skillProfile.employeeIdx !== idx
      || employee.skillProfile.expectedSkillCount !== CONTENT_SKILL_COUNTS[idx]
      || employee.skillProfile.verificationStatus !== 'legacy_unverified') {
      fail(`员工${idx}.skillProfile不完整`);
    }
    objectValue(employee.systemPrompt, `员工${idx}.systemPrompt`);
    if (employee.systemPrompt.messageMode !== 'none' || employee.systemPrompt.template !== null) {
      fail(`员工${idx}.systemPrompt必须忠实记录旧版无独立system消息`);
    }
    nonEmpty(employee.systemPrompt.reason, `员工${idx}.systemPrompt.reason`);
    objectValue(employee.pipelinePrompt, `员工${idx}.pipelinePrompt`);
    if (employee.pipelinePrompt.messageMode !== 'single_user') fail(`员工${idx}.pipelinePrompt.messageMode不正确`);
    nonEmpty(employee.pipelinePrompt.template, `员工${idx}.pipelinePrompt.template`);
    if (!Array.isArray(employee.pipelinePrompt.assemblyOrder) || employee.pipelinePrompt.assemblyOrder.length < 6) {
      fail(`员工${idx}.pipelinePrompt.assemblyOrder不完整`);
    }
    objectValue(employee.soloPrompt, `员工${idx}.soloPrompt`);
    if (employee.soloPrompt.messageMode !== 'single_user') fail(`员工${idx}.soloPrompt.messageMode不正确`);
    nonEmpty(employee.soloPrompt.template, `员工${idx}.soloPrompt.template`);
    objectValue(employee.soloPrompt.placeholders, `员工${idx}.soloPrompt.placeholders`);
    objectValue(employee.placeholders, `员工${idx}.placeholders`);
    objectValue(employee.workMethod, `员工${idx}.workMethod`);
    for (const field of ['input', 'execution', 'output', 'approval', 'handoff']) {
      objectValue(employee.workMethod[field], `员工${idx}.workMethod.${field}`);
    }
    nonEmpty(employee.workMethod.execution.handler, `员工${idx}.workMethod.execution.handler`);
    nonEmpty(employee.workMethod.output.duty, `员工${idx}.workMethod.output.duty`);
    objectValue(employee.defaultWorkConfig, `员工${idx}.defaultWorkConfig`);
    objectValue(employee.defaultWorkConfig.common, `员工${idx}.defaultWorkConfig.common`);
    objectValue(employee.defaultWorkConfig.roleSpecific, `员工${idx}.defaultWorkConfig.roleSpecific`);
    if (employee.defaultWorkConfig.common.capabilitiesRequired !== true
      || employee.defaultWorkConfig.common.capabilitiesEnabled !== true
      || employee.defaultWorkConfig.common.capabilitiesLocked !== true) {
      fail(`员工${idx}.defaultWorkConfig没有锁定核心能力`);
    }
    objectValue(employee.dispatchForm, `员工${idx}.dispatchForm`);
    if (!Array.isArray(employee.dispatchForm.fields) || employee.dispatchForm.fields.length < 4) {
      fail(`员工${idx}.dispatchForm.fields不完整`);
    }
    if (!employee.dispatchForm.fields.some(field => field?.key === 'direction' && field.required === true)) {
      fail(`员工${idx}.dispatchForm缺少必填任务内容`);
    }
    objectValue(employee.outputSchema, `员工${idx}.outputSchema`);
    nonEmpty(employee.outputSchema.contract, `员工${idx}.outputSchema.contract`);
    if (employee.outputSchema.format !== 'json_object'
      || JSON.stringify(employee.outputSchema.keys) !== JSON.stringify(employee.outputKeys)) {
      fail(`员工${idx}.outputSchema与outputKeys不一致`);
    }
    for (const outputKey of employee.outputKeys) {
      if (!employee.outputSchema.contract.includes(`"${outputKey}"`)) {
        fail(`员工${idx}.outputSchema缺少${outputKey}`);
      }
    }
    objectValue(employee.connectorPolicy, `员工${idx}.connectorPolicy`);
    if (!Array.isArray(employee.connectorPolicy.connectors) || !employee.connectorPolicy.connectors.length) {
      fail(`员工${idx}.connectorPolicy.connectors不完整`);
    }
    for (const connector of employee.connectorPolicy.connectors) {
      objectValue(connector, `员工${idx}.connector`);
      exactKeys(
        connector,
        [
          'kind', 'primary', 'addon', 'legacyHandler', 'newProjectStatus',
          'status', 'mode', 'requirements', 'executeBoundary',
        ],
        `员工${idx}.connector`,
      );
      nonEmpty(connector?.kind, `员工${idx}.connector.kind`);
      nonEmpty(connector?.newProjectStatus, `员工${idx}.connector.newProjectStatus`);
      nonEmpty(connector?.status, `员工${idx}.connector.status`);
      nonEmpty(connector?.mode, `员工${idx}.connector.mode`);
      nonEmpty(connector?.executeBoundary, `员工${idx}.connector.executeBoundary`);
      if (connector.legacyHandler !== null
        && (typeof connector.legacyHandler !== 'string' || !connector.legacyHandler.trim())) {
        fail(`员工${idx}.connector.${connector.kind}.legacyHandler不正确`);
      }
      if (typeof connector.primary !== 'boolean' || typeof connector.addon !== 'boolean') {
        fail(`员工${idx}.connector主附状态不完整`);
      }
      if (connectorKindSet.has(connector.kind)) fail(`连接器kind重复：${connector.kind}`);
      connectorKindSet.add(connector.kind);
      if (connector.newProjectStatus === 'catalog_only' || connector.status === 'catalog_only') {
        fail(`员工${idx}.connector.${connector.kind}仍是catalog_only占位`);
      }
      if (connector.newProjectStatus !== connector.status
        || !ALLOWED_CONNECTOR_STATUSES.has(connector.status)) {
        fail(`员工${idx}.connector.${connector.kind}运行状态不一致`);
      }
      if (!ALLOWED_CONNECTOR_MODES.has(connector.mode)) {
        fail(`员工${idx}.connector.${connector.kind}运行模式不正确`);
      }
      if (CONNECTOR_STATUS_BY_MODE[connector.mode] !== connector.status) {
        fail(`员工${idx}.connector.${connector.kind}状态与运行模式不一致`);
      }
      objectValue(connector.requirements, `员工${idx}.connector.${connector.kind}.requirements`);
      exactKeys(
        connector.requirements,
        ['inputs', 'liveData', 'credentials', 'humanApproval'],
        `员工${idx}.connector.${connector.kind}.requirements`,
      );
      if (!Array.isArray(connector.requirements.inputs)
        || !connector.requirements.inputs.length
        || connector.requirements.inputs.some(input => typeof input !== 'string' || !input.trim())) {
        fail(`员工${idx}.connector.${connector.kind}.requirements.inputs不完整`);
      }
      if (!ALLOWED_LIVE_DATA_REQUIREMENTS.has(connector.requirements.liveData)) {
        fail(`员工${idx}.connector.${connector.kind}.requirements.liveData不正确`);
      }
      if (connector.mode === 'verified_input_assist'
        && connector.requirements.liveData !== 'required') {
        fail(`员工${idx}.connector.${connector.kind}必须要求调用方实时数据`);
      }
      if (!Array.isArray(connector.requirements.credentials)
        || connector.requirements.credentials.some(item => typeof item !== 'string' || !item.trim())) {
        fail(`员工${idx}.connector.${connector.kind}.requirements.credentials不正确`);
      }
      if (!APPROVALS.has(connector.requirements.humanApproval)) {
        fail(`员工${idx}.connector.${connector.kind}.requirements.humanApproval不正确`);
      }
    }
    objectValue(employee.sourceProvenance, `员工${idx}.sourceProvenance`);
    if (employee.sourceProvenance.referenceSha256 !== value.source.referenceSha256
      || employee.sourceProvenance.legacyIdx !== idx) {
      fail(`员工${idx}.sourceProvenance不一致`);
    }
  }
  if (capabilityTotal !== 45) fail(`核心能力总数必须为45，当前${capabilityTotal}`);
  if (connectorKindSet.size !== 13) fail(`连接器必须恰好13种，当前${connectorKindSet.size}`);
  if (groupMembership.size !== 10 || [...idxSet].some(idx => !groupMembership.has(idx))) fail('模块分组没有完整覆盖10名员工');
  const deck = value.employees[7];
  if (deck.outputSchema.primaryArtifact !== 'html'
    || !deck.connectorPolicy.connectors.some(connector => connector.kind === 'html' && connector.primary === true)
    || !deck.connectorPolicy.connectors.some(connector => connector.kind === 'ppt' && connector.addon === true)) {
    fail('演绎师必须以HTML为原生能力，PPT只能作为附加connector');
  }

  return deepFreeze(value);
}

export function loadContentCrewCatalog(catalogPath = CONTENT_CREW_CATALOG_PATH) {
  try {
    const source = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    return validateContentCrewCatalog(normalizeCurrentProjectContentWording(source));
  } catch (error) {
    if (String(error?.message || '').startsWith('内容生产仓目录无效：')) throw error;
    throw new Error(`内容生产仓目录读取失败（${catalogPath}）：${error.message}`);
  }
}

export const CONTENT_CREW = loadContentCrewCatalog();
export const CONTENT_EMPLOYEES = CONTENT_CREW.employees;

export function validateEmployeeSkillCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('技能目录根节点必须是对象');
  if (value.schemaVersion !== 'paihuo-employee-skills.v1') fail('技能目录schemaVersion不正确');
  objectValue(value.source, '技能目录source');
  objectValue(value.source.snapshot, '技能目录source.snapshot');
  if (value.source.snapshot.date !== '2026-07-18'
    || !/^[a-f0-9]{64}$/.test(value.source.snapshot.sha256 || '')) {
    fail('技能目录sourceSnapshot不正确');
  }
  if (value.employeeCount !== 70 || value.skillCount !== 409
    || value.contentSkillCount !== 65 || value.restaurantSkillCount !== 344) {
    fail('技能目录声明数量不正确');
  }
  if (!Array.isArray(value.profiles) || value.profiles.length !== 70) fail('技能目录必须恰好包含70位员工');

  let contentSkillCount = 0;
  let restaurantSkillCount = 0;
  value.profiles.forEach((profile, order) => {
    const expectedIdx = EXPECTED_SKILL_INDEXES[order];
    if (profile?.idx !== expectedIdx) fail(`技能目录员工顺序不正确，位置${order}必须为${expectedIdx}`);
    exactKeys(profile, [
      'idx', 'key', 'name', 'group', 'department', 'learnedAt',
      'safeLegacyConfig', 'expectedSkillCount', 'skills',
    ], `技能目录员工${profile.idx}`);
    for (const field of ['key', 'name', 'group', 'department']) nonEmpty(profile[field], `技能目录员工${profile.idx}.${field}`);
    objectValue(profile.safeLegacyConfig, `技能目录员工${profile.idx}.safeLegacyConfig`);
    exactKeys(profile.safeLegacyConfig, ['modelText', 'modelImage', 'settings'], `技能目录员工${profile.idx}.safeLegacyConfig`);
    if (!ALLOWED_TEXT_MODELS.has(profile.safeLegacyConfig.modelText)
      || !ALLOWED_IMAGE_MODELS.has(profile.safeLegacyConfig.modelImage)) {
      fail(`技能目录员工${profile.idx}模型ID未通过白名单`);
    }
    objectValue(profile.safeLegacyConfig.settings, `技能目录员工${profile.idx}.settings`);
    for (const [key, setting] of Object.entries(profile.safeLegacyConfig.settings)) {
      if (!ALLOWED_SETTING_KEYS.has(key) || !Array.isArray(setting)
        || setting.some(item => typeof item !== 'string')) {
        fail(`技能目录员工${profile.idx}.settings包含非白名单字段`);
      }
    }
    if (!Array.isArray(profile.skills) || profile.skills.length !== profile.expectedSkillCount) {
      fail(`技能目录员工${profile.idx}技能数量与expectedSkillCount不一致`);
    }
    if (profile.idx < 10 && profile.expectedSkillCount !== CONTENT_SKILL_COUNTS[profile.idx]) {
      fail(`技能目录员工${profile.idx}内容技能数量不正确`);
    }
    for (const [skillIndex, skill] of profile.skills.entries()) {
      exactKeys(skill, [
        'title', 'detail', 'source', 'enabled', 'learnedAt',
        'verificationStatus', 'sourceSnapshot',
      ], `技能目录员工${profile.idx}.skills.${skillIndex}`);
      for (const field of ['title', 'detail', 'source']) nonEmpty(skill[field], `技能目录员工${profile.idx}.skills.${skillIndex}.${field}`);
      if (skill.enabled !== true || skill.verificationStatus !== 'legacy_unverified') {
        fail(`技能目录员工${profile.idx}.skills.${skillIndex}状态不正确`);
      }
      if (skill.learnedAt !== null && typeof skill.learnedAt !== 'number') {
        fail(`技能目录员工${profile.idx}.skills.${skillIndex}.learnedAt不正确`);
      }
      objectValue(skill.sourceSnapshot, `技能目录员工${profile.idx}.skills.${skillIndex}.sourceSnapshot`);
      if (skill.sourceSnapshot.date !== value.source.snapshot.date
        || skill.sourceSnapshot.sha256 !== value.source.snapshot.sha256) {
        fail(`技能目录员工${profile.idx}.skills.${skillIndex}.sourceSnapshot不一致`);
      }
    }
    if (profile.idx < 10) contentSkillCount += profile.skills.length;
    else restaurantSkillCount += profile.skills.length;
  });
  if (contentSkillCount !== 65 || restaurantSkillCount !== 344
    || contentSkillCount + restaurantSkillCount !== 409) {
    fail(`技能数量不正确：内容${contentSkillCount}/餐饮${restaurantSkillCount}`);
  }
  return deepFreeze(value);
}

export function loadEmployeeSkillCatalog(catalogPath = EMPLOYEE_SKILL_CATALOG_PATH) {
  try {
    const source = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    validateEmployeeSkillCatalog(source);
    return validateEmployeeSkillEvidenceCatalog(source);
  } catch (error) {
    if (/^(?:内容生产仓目录无效|员工技能验证证据无效)：/u.test(String(error?.message || ''))) throw error;
    throw new Error(`员工技能目录读取失败（${catalogPath}）：${error.message}`);
  }
}

export const EMPLOYEE_SKILL_CATALOG = loadEmployeeSkillCatalog();
export const EMPLOYEE_SKILL_RAW_PROFILES = EMPLOYEE_SKILL_CATALOG.profiles;
export const EMPLOYEE_SKILL_PROFILES = deepFreeze(EMPLOYEE_SKILL_RAW_PROFILES.map(profile => ({
  ...profile,
  skills: verifiedEmployeeSkillsFor(EMPLOYEE_SKILL_CATALOG, profile.idx),
})));

for (const employee of CONTENT_EMPLOYEES) {
  const profile = EMPLOYEE_SKILL_PROFILES.find(candidate => candidate.idx === employee.idx);
  if (!profile || profile.key !== employee.key || profile.name !== employee.name
    || profile.expectedSkillCount !== employee.skillProfile.expectedSkillCount) {
    fail(`员工${employee.idx}静态档案与技能档案不一致`);
  }
}

const BY_IDX = new Map(CONTENT_EMPLOYEES.map(employee => [employee.idx, employee]));

export class ContentEmployeeSelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContentEmployeeSelectionError';
    this.status = 400;
  }
}

export const CONTENT_GENERATION_POLICIES = deepFreeze({
  copy: { defaultIdx: 3, allowed: [3] },
  ppt: { defaultIdx: 7, allowed: [7] },
  image: { defaultIdx: 5, allowed: [5] },
  video: { defaultIdx: 5, allowed: [5] },
  dailyPack: { defaultIdx: 3, allowed: [3] },
});

export function contentEmployeeByIdx(idx) {
  return Number.isInteger(idx) ? BY_IDX.get(idx) || null : null;
}

export function selectContentEmployee(rawIdx, generationKind) {
  const policy = CONTENT_GENERATION_POLICIES[generationKind];
  if (!policy) throw new Error(`未知内容生成类型：${generationKind}`);
  const omitted = rawIdx === undefined || rawIdx === null;
  if (!omitted && !Number.isInteger(rawIdx)) {
    throw new ContentEmployeeSelectionError('employeeIdx必须是0-9之间的整数，不能使用字符串或小数');
  }
  const idx = omitted ? policy.defaultIdx : rawIdx;
  const employee = contentEmployeeByIdx(idx);
  if (!employee) throw new ContentEmployeeSelectionError('employeeIdx不存在于内容生产部');
  if (!policy.allowed.includes(idx)) {
    const labels = policy.allowed.map(allowedIdx => `${allowedIdx}·${BY_IDX.get(allowedIdx).name}`).join('、');
    throw new ContentEmployeeSelectionError(`该生成类型仅支持：${labels}`);
  }
  return employee;
}

export function contentEmployeeMetadata(employee) {
  return {
    contentEmployeeIdx: employee.idx,
    contentEmployeeKey: employee.key,
    contentEmployeeName: employee.name,
    contentEmployeeGroup: employee.group,
    contentRunMode: 'single_station',
  };
}

export function publicContentCrew() {
  return {
    schemaVersion: CONTENT_CREW.schemaVersion,
    source: {
      kind: CONTENT_CREW.source.kind,
      authority: CONTENT_CREW.source.authority,
      referenceSha256: CONTENT_CREW.source.referenceSha256,
    },
    department: CONTENT_CREW.department,
    moduleGroups: CONTENT_CREW.moduleGroups,
    qualityGate: CONTENT_CREW.qualityGate,
    employees: CONTENT_CREW.employees.map(employee => ({
      idx: employee.idx,
      key: employee.key,
      person: employee.person,
      name: employee.name,
      group: employee.group,
      moduleGroup: employee.moduleGroup,
      skill: employee.skill,
      emoji: employee.emoji,
      color: employee.color,
      duty: employee.duty,
      intro: employee.intro,
      approval: employee.approval,
      optional: employee.optional,
      capabilities: employee.capabilities,
      outputKeys: employee.outputKeys,
      connectorPolicy: employee.connectorPolicy,
    })),
    executionBoundary: '10位内容员工均有完整工作台和单独派活能力；这不表示十个工位已经自动串行执行。',
  };
}

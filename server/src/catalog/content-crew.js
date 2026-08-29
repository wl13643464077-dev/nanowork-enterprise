import { createHash } from 'node:crypto';
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
const SOURCE_FINGERPRINT_ALGORITHM = 'sha256-json-utf8';

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

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function jsonFingerprint(value) {
  return `sha256:${sha256(JSON.stringify(value))}`;
}

function textFingerprint(value) {
  return `sha256:${sha256(value)}`;
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
      .replaceAll(
        '材料不足就合理假设并标注「假设」',
        '材料不足就列出待确认项,不得猜测、补写或暗示任何未提供事实',
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
  objectValue(value.source, 'source');
  if (!/^[a-f0-9]{64}$/u.test(value.source.referenceSha256 || '')) {
    fail('source.referenceSha256不正确');
  }
  if (value.source.sourceFingerprintAlgorithm !== SOURCE_FINGERPRINT_ALGORITHM) {
    fail('source.sourceFingerprintAlgorithm不正确');
  }
  if (value.source.capabilityCount !== 45 || value.source.promptCount !== 10) {
    fail('source必须声明45项源能力与10份源提示词');
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.source.capabilitySetFingerprint || '')
    || !/^sha256:[a-f0-9]{64}$/u.test(value.source.promptSetFingerprint || '')) {
    fail('source源字段集合指纹不正确');
  }

  const idxSet = new Set();
  const keySet = new Set();
  const connectorKindSet = new Set();
  const groupMembership = new Map();
  const sourceCapabilitiesByRole = {};
  const sourcePromptsByRole = {};
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
      objectValue(capability.sourceDefinition, `员工${idx}.capability.sourceDefinition`);
      exactKeys(
        capability.sourceDefinition,
        ['name', 'emoji', 'desc'],
        `员工${idx}.capability.sourceDefinition`,
      );
      for (const field of ['name', 'emoji', 'desc']) {
        nonEmpty(
          capability.sourceDefinition[field],
          `员工${idx}.capability.sourceDefinition.${field}`,
        );
      }
      if (capability.sourceDefinition.name !== capability.name
        || capability.sourceDefinition.emoji !== capability.emoji) {
        fail(`员工${idx}能力源定义与当前安全视图错位`);
      }
      if (capability.sourceFingerprint !== jsonFingerprint(capability.sourceDefinition)) {
        fail(`员工${idx}能力${capability.name}源指纹不一致`);
      }
      capabilityNames.add(capability.name);
    }
    sourceCapabilitiesByRole[employee.key] = employee.capabilities.map(
      capability => capability.sourceDefinition,
    );
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
    nonEmpty(employee.pipelinePrompt.sourceTemplate, `员工${idx}.pipelinePrompt.sourceTemplate`);
    if (employee.pipelinePrompt.sourceFingerprint
      !== textFingerprint(employee.pipelinePrompt.sourceTemplate)) {
      fail(`员工${idx}.pipelinePrompt.sourceFingerprint不一致`);
    }
    sourcePromptsByRole[employee.key] = employee.pipelinePrompt.sourceTemplate;
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
    if (employee.sourceProvenance.sourceCapabilitySetFingerprint
      !== jsonFingerprint(sourceCapabilitiesByRole[employee.key])
      || employee.sourceProvenance.sourcePromptFingerprint
        !== employee.pipelinePrompt.sourceFingerprint) {
      fail(`员工${idx}.sourceProvenance源字段指纹不一致`);
    }
  }
  if (capabilityTotal !== 45) fail(`核心能力总数必须为45，当前${capabilityTotal}`);
  if (value.source.capabilitySetFingerprint !== jsonFingerprint(sourceCapabilitiesByRole)
    || value.source.promptSetFingerprint !== jsonFingerprint(sourcePromptsByRole)) {
    fail('source源字段集合指纹与10岗目录不一致');
  }
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

/**
 * Native content employees are deliberately kept outside `employees`.
 *
 * `employees` is the immutable 10-role Paihuo source snapshot and several
 * parity tests intentionally lock its count, source fingerprints and indexes.
 * A NanoWork-native role must therefore be additive: it joins the runtime
 * roster without changing the source snapshot or re-numbering 0-9.
 */
function validateNativeContentEmployee(value) {
  objectValue(value, '原生内容员工');
  if (value.idx !== 10 || value.key !== 'commerce_video' || value.name !== 'AI带货员') {
    fail('原生内容员工必须是10/commerce_video/AI带货员');
  }
  if (value.person !== null) fail('原生内容员工person必须为null');
  for (const field of [
    'group', 'moduleGroup', 'skill', 'emoji', 'color', 'duty', 'intro', 'approval',
  ]) nonEmpty(value[field], `原生内容员工.${field}`);
  if (value.optional !== false || !APPROVALS.has(value.approval)) {
    fail('原生内容员工optional/approval不正确');
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length < 3) {
    fail('原生内容员工capabilities不完整');
  }
  const capabilityNames = new Set();
  const sourceCapabilities = [];
  for (const [index, capability] of value.capabilities.entries()) {
    for (const field of ['name', 'emoji', 'desc']) {
      nonEmpty(capability?.[field], `原生内容员工.capabilities.${index}.${field}`);
    }
    if (capability.required !== true || capability.enabled !== true || capability.locked !== true) {
      fail(`原生内容员工能力${capability.name}必须required/enabled/locked`);
    }
    if (capabilityNames.has(capability.name)) fail(`原生内容员工能力名称重复：${capability.name}`);
    objectValue(capability.sourceDefinition, `原生内容员工能力${capability.name}.sourceDefinition`);
    exactKeys(capability.sourceDefinition, ['name', 'emoji', 'desc'], `原生内容员工能力${capability.name}.sourceDefinition`);
    if (JSON.stringify(capability.sourceDefinition) !== JSON.stringify({
      name: capability.name,
      emoji: capability.emoji,
      desc: capability.desc,
    })) fail(`原生内容员工能力${capability.name}源定义与当前能力错位`);
    if (!/^sha256:[a-f0-9]{64}$/u.test(String(capability.sourceFingerprint || ''))) {
      fail(`原生内容员工能力${capability.name}源指纹不正确`);
    }
    if (capability.sourceFingerprint !== jsonFingerprint(capability.sourceDefinition)) {
      fail(`原生内容员工能力${capability.name}源指纹不一致`);
    }
    capabilityNames.add(capability.name);
    sourceCapabilities.push(capability.sourceDefinition);
  }
  if (!Array.isArray(value.outputKeys) || value.outputKeys.length < 3
    || value.outputKeys.some(key => typeof key !== 'string' || !key.trim())) {
    fail('原生内容员工outputKeys不完整');
  }
  objectValue(value.skillProfile, '原生内容员工.skillProfile');
  if (value.skillProfile.employeeIdx !== 10
    || value.skillProfile.expectedSkillCount !== 0
    || value.skillProfile.verificationStatus !== 'native_verified') {
    fail('原生内容员工.skillProfile不完整');
  }
  for (const promptKey of ['pipelinePrompt', 'soloPrompt']) objectValue(value[promptKey], `原生内容员工.${promptKey}`);
  if (value.pipelinePrompt.messageMode !== 'single_user'
    || value.soloPrompt.messageMode !== 'single_user') {
    fail('原生内容员工提示词必须是single_user');
  }
  nonEmpty(value.pipelinePrompt.template, '原生内容员工.pipelinePrompt.template');
  nonEmpty(value.pipelinePrompt.sourceTemplate, '原生内容员工.pipelinePrompt.sourceTemplate');
  if (value.pipelinePrompt.sourceFingerprint !== textFingerprint(value.pipelinePrompt.sourceTemplate)) {
    fail('原生内容员工.pipelinePrompt.sourceFingerprint不一致');
  }
  nonEmpty(value.soloPrompt.template, '原生内容员工.soloPrompt.template');
  objectValue(value.soloPrompt.placeholders, '原生内容员工.soloPrompt.placeholders');
  objectValue(value.placeholders, '原生内容员工.placeholders');
  for (const field of ['input', 'execution', 'output', 'approval', 'handoff']) {
    objectValue(value.workMethod?.[field], `原生内容员工.workMethod.${field}`);
  }
  nonEmpty(value.workMethod.execution.handler, '原生内容员工.workMethod.execution.handler');
  nonEmpty(value.workMethod.output.duty, '原生内容员工.workMethod.output.duty');
  objectValue(value.defaultWorkConfig, '原生内容员工.defaultWorkConfig');
  objectValue(value.defaultWorkConfig.common, '原生内容员工.defaultWorkConfig.common');
  objectValue(value.defaultWorkConfig.roleSpecific, '原生内容员工.defaultWorkConfig.roleSpecific');
  if (value.defaultWorkConfig.common.capabilitiesRequired !== true
    || value.defaultWorkConfig.common.capabilitiesEnabled !== true
    || value.defaultWorkConfig.common.capabilitiesLocked !== true) {
    fail('原生内容员工defaultWorkConfig没有锁定核心能力');
  }
  objectValue(value.dispatchForm, '原生内容员工.dispatchForm');
  if (!Array.isArray(value.dispatchForm.fields)
    || !value.dispatchForm.fields.some(field => field?.key === 'direction' && field.required === true)) {
    fail('原生内容员工dispatchForm缺少必填任务目标');
  }
  objectValue(value.outputSchema, '原生内容员工.outputSchema');
  if (value.outputSchema.format !== 'json_object'
    || JSON.stringify(value.outputSchema.keys) !== JSON.stringify(value.outputKeys)
    || !value.outputSchema.contract.includes('"facts"')) {
    fail('原生内容员工outputSchema不完整');
  }
  objectValue(value.connectorPolicy, '原生内容员工.connectorPolicy');
  if (!Array.isArray(value.connectorPolicy.connectors) || value.connectorPolicy.connectors.length < 2) {
    fail('原生内容员工connectorPolicy不完整');
  }
  const connectorKinds = new Set();
  for (const connector of value.connectorPolicy.connectors) {
    objectValue(connector, '原生内容员工.connector');
    exactKeys(
      connector,
      ['kind', 'primary', 'addon', 'legacyHandler', 'newProjectStatus', 'status', 'mode', 'requirements', 'executeBoundary'],
      '原生内容员工.connector',
    );
    for (const field of ['kind', 'newProjectStatus', 'status', 'mode', 'executeBoundary']) nonEmpty(connector[field], `原生内容员工.connector.${field}`);
    if (connectorKinds.has(connector.kind)) fail(`原生内容员工连接器重复：${connector.kind}`);
    connectorKinds.add(connector.kind);
    if (connector.newProjectStatus !== connector.status
      || !ALLOWED_CONNECTOR_STATUSES.has(connector.status)
      || !ALLOWED_CONNECTOR_MODES.has(connector.mode)
      || CONNECTOR_STATUS_BY_MODE[connector.mode] !== connector.status) {
      fail(`原生内容员工连接器${connector.kind}状态或模式不正确`);
    }
    if (typeof connector.primary !== 'boolean' || typeof connector.addon !== 'boolean') {
      fail(`原生内容员工连接器${connector.kind}主附状态不完整`);
    }
    objectValue(connector.requirements, `原生内容员工连接器${connector.kind}.requirements`);
    if (!Array.isArray(connector.requirements.inputs) || !connector.requirements.inputs.length
      || !ALLOWED_LIVE_DATA_REQUIREMENTS.has(connector.requirements.liveData)
      || !Array.isArray(connector.requirements.credentials)
      || !APPROVALS.has(connector.requirements.humanApproval)) {
      fail(`原生内容员工连接器${connector.kind}requirements不完整`);
    }
  }
  objectValue(value.sourceProvenance, '原生内容员工.sourceProvenance');
  if (value.sourceProvenance.native !== true || value.sourceProvenance.legacyIdx !== 10
    || value.sourceProvenance.sourceCapabilitySetFingerprint !== jsonFingerprint(sourceCapabilities)
    || value.sourceProvenance.sourcePromptFingerprint !== value.pipelinePrompt.sourceFingerprint) {
    fail('原生内容员工sourceProvenance不完整');
  }
  objectValue(value.systemPrompt, '原生内容员工.systemPrompt');
  if (value.systemPrompt.messageMode !== 'none' || value.systemPrompt.template !== null) {
    fail('原生内容员工systemPrompt必须忠实记录单用户运行模式');
  }
  nonEmpty(value.systemPrompt.reason, '原生内容员工.systemPrompt.reason');
  objectValue(value.runtime, '原生内容员工.runtime');
  objectValue(value.permissions, '原生内容员工.permissions');
  if (!Array.isArray(value.permissions.profileAudience) || value.permissions.mayDisableRequiredCapabilities !== false) {
    fail('原生内容员工.permissions不完整');
  }
  return deepFreeze(value);
}

export const NATIVE_CONTENT_EMPLOYEES = deepFreeze(
  (CONTENT_CREW.nativeEmployees || []).map(validateNativeContentEmployee),
);
if (NATIVE_CONTENT_EMPLOYEES.length !== 1) fail('必须恰好包含1名原生内容员工');

// Runtime roster is additive; the legacy export remains the 10-role source
// snapshot for all parity and source-fingerprint consumers.
export const CONTENT_EMPLOYEE_ROSTER = deepFreeze([
  ...CONTENT_EMPLOYEES,
  ...NATIVE_CONTENT_EMPLOYEES,
]);
export const CONTENT_EMPLOYEES_WITH_NATIVE = CONTENT_EMPLOYEE_ROSTER;

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

const BY_IDX = new Map(CONTENT_EMPLOYEE_ROSTER.map(employee => [employee.idx, employee]));

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
    // `department.employeeTotal` intentionally remains the immutable Paihuo
    // source count (10). The additive roster count is explicit and is what
    // the content warehouse UI/runtime should display.
    rosterEmployeeTotal: CONTENT_EMPLOYEE_ROSTER.length,
    moduleGroups: CONTENT_CREW.moduleGroups,
    qualityGate: CONTENT_CREW.qualityGate,
    employees: CONTENT_EMPLOYEE_ROSTER.map(employee => ({
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
    executionBoundary: '10位Paihuo来源员工 + 1位NanoWork原生AI带货员均有独立工作台和单独派活能力；这不表示十个工位已经自动串行执行，也不表示完整团队已经自动串行执行。',
  };
}

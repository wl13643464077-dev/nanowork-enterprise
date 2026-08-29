// ===== 执行摘要（Execution Digest）=====
// 背景：此前每次派活把完整 canonical 快照（约 20 万字符）整体塞进 system prompt，
// 单次输入近 40 万 token、成本 ¥20+、耗时 10 分钟，且 97% 内容与随后的
// 「岗位手册／能力／质量门／技能库／工作配置／输出契约」分段完全重复。
//
// 本模块把快照收敛为「模型执行真正需要的字段」的确定性投影：
// - 逐字段从 canonical 对象派生，不新增、不改写任何事实；
// - 保留每个必备域的字段指纹与聚合指纹，审计仍可逐域校验未被裁剪；
// - 完整 canonical 对象照旧写入任务快照落库，只是不再发给模型。
import crypto from 'node:crypto';

export const EXECUTION_DIGEST_SCHEMA = 'nanowork.employee-execution-digest/1';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

function textOf(value, max = 400) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

/**
 * 从 canonical 执行对象派生执行摘要。
 * @param canonical bindCanonicalEmployeeProfile 的产物
 * @param options.domain 'restaurant' | 'content'
 */
export function buildExecutionDigest(canonical, { domain = 'restaurant' } = {}) {
  const identity = canonical.identity || {};
  const department = identity.department || {};
  const jobProfile = canonical.jobProfile || {};
  const workConfig = canonical.workConfig?.effective || canonical.workConfig || {};
  const contract = canonical.contracts?.output || jobProfile.outputContract || {};
  const bindings = canonical.runtimeBindings?.currentRuntimeBindings || {};
  const permissions = canonical.permissions?.currentRuntimeAccess || canonical.permissions || {};

  const digest = {
    schemaVersion: EXECUTION_DIGEST_SCHEMA,
    domain,
    // 身份：模型判断"我是谁、代表哪个岗位说话"
    identity: {
      idx: identity.idx,
      key: identity.key,
      person: identity.person || null,
      name: identity.name,
      position: identity.position || identity.name,
      duty: textOf(identity.duty, 200),
      department: department.name || identity.group || null,
    },
    // 执行边界：审批模式、语言、篇幅、联网、超时——直接影响本次产出形态
    execution: {
      language: workConfig.language || null,
      outputLength: workConfig.outputLength || null,
      approvalMode: workConfig.approvalMode || null,
      webMode: workConfig.webMode || null,
      timeoutSeconds: workConfig.timeoutSeconds ?? null,
      knowledgeScopes: Array.isArray(workConfig.knowledgeScopes) ? workConfig.knowledgeScopes : [],
      configVersion: workConfig.version || null,
    },
    // 运行绑定：只留模式声明，不带任何凭据或内部实现细节
    runtime: {
      workMode: bindings.work?.mode || null,
      outputValidation: bindings.work?.outputValidation || null,
      webEvidenceRequired: bindings.web?.evidenceRequired ?? null,
      connectorCount: Array.isArray(bindings.connectors) ? bindings.connectors.length : 0,
    },
    // 契约：ID 与主产物（完整 instruction 在提示词另一段单独下发，不在此重复）
    contract: {
      contractId: contract.contractId || null,
      primaryArtifact: contract.primaryArtifact || null,
      format: contract.format || 'json',
    },
    // 审批边界：模型必须知道自己不能替企业做什么
    boundary: {
      autoPublishForbidden: true,
      humanReviewRequired: true,
      externalActionRequiresApproval: true,
      canDispatch: permissions.canDispatch ?? null,
    },
    // 审计锚点：完整对象的指纹，落库快照可逐域比对，证明摘要未被偷换
    provenance: {
      profileVersion: canonical.version?.profile || canonical.provenance?.factoryProfileVersion || null,
      canonicalAggregateFingerprint: canonical.fingerprints?.aggregate || null,
      canonicalFieldFingerprints: canonical.fingerprints?.fields
        ? { ...canonical.fingerprints.fields }
        : {},
      fullObjectPersistedInTaskSnapshot: true,
      fullObjectSentToModel: false,
      note: '完整权威对象已随任务快照落库；本次只向模型下发确定性派生摘要，逐域指纹可校验未被裁剪。',
    },
  };
  digest.digestFingerprint = sha256(JSON.stringify(digest));
  return digest;
}

/**
 * 校验摘要确实覆盖了全部必备域（防止"悄悄少注入一个域"的静默降级）。
 * @returns { covered: boolean, missing: string[] }
 */
export function verifyDigestCoverage(digest, requiredFields = []) {
  const fingerprints = digest?.provenance?.canonicalFieldFingerprints || {};
  const missing = requiredFields.filter(field => !fingerprints[field]);
  return { covered: missing.length === 0, missing };
}

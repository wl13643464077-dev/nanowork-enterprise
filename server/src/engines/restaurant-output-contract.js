import { createHash } from 'node:crypto';

import { loadRestaurantCatalog } from '../catalog/restaurant.js';

const SCHEMA_VERSION = 'restaurant-role-output/1';
const TOP_LEVEL_KEYS = Object.freeze([
  'contract_id',
  'role',
  'decision_context',
  'deliverables',
  'quality_review',
  'safety_review',
  'approval',
]);

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const PROVIDER_UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  '$id',
  'minLength',
  'minItems',
  'maxItems',
]);

function toProviderSchema(value) {
  if (Array.isArray(value)) return value.map(toProviderSchema);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (PROVIDER_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === 'const') {
      result.enum = [toProviderSchema(child)];
      continue;
    }
    result[key] = toProviderSchema(child);
  }
  return result;
}

function nonEmptyString({ description, constant, values } = {}) {
  return {
    type: 'string',
    minLength: 1,
    ...(description ? { description } : {}),
    ...(constant !== undefined ? { const: constant } : {}),
    ...(values ? { enum: values } : {}),
  };
}

function strictObject(properties, required = Object.keys(properties), extra = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
    ...extra,
  };
}

function nonEmptyArray(items, extra = {}) {
  return {
    type: 'array',
    minItems: 1,
    items,
    ...extra,
  };
}

function stableFieldKey(prefix, index, source) {
  return `${prefix}_${String(index + 1).padStart(2, '0')}_${sha256(source).slice(0, 10)}`;
}

function namedReviewObject(items, prefix, valueSchemaFactory) {
  const entries = items.map((item, index) => [
    stableFieldKey(prefix, index, item),
    valueSchemaFactory(item),
  ]);
  return {
    keys: entries.map(([key]) => key),
    schema: strictObject(Object.fromEntries(entries)),
  };
}

function deliverableSchema(deliverable) {
  return strictObject({
    deliverable_name: nonEmptyString({
      constant: deliverable,
      description: '权威岗位手册中的交付物名称，必须原样保留。',
    }),
    summary: nonEmptyString({
      description: '基于真实输入形成的交付摘要；未知信息必须明确标为待核验。',
    }),
    evidence: nonEmptyArray(strictObject({
      source: nonEmptyString({ description: '证据、业务材料或系统记录的可追溯来源。' }),
      period: nonEmptyString({ description: '证据对应的统计期、版本日期或采集时间。' }),
      finding: nonEmptyString({ description: '只记录该来源能够支持的事实或待核验项。' }),
    })),
    actions: nonEmptyArray(strictObject({
      action: nonEmptyString({ description: '可执行动作，不得用空泛建议代替。' }),
      owner: nonEmptyString({ description: '待指定或已确认的责任角色。' }),
      deadline: nonEmptyString({ description: '待指定或已确认的截止时间。' }),
      success_metric: nonEmptyString({ description: '可复核的完成或效果检查标准。' }),
    })),
    acceptance_checks: nonEmptyArray(strictObject({
      criterion: nonEmptyString({ description: '该交付物的逐项验收标准。' }),
      result: nonEmptyString({
        values: ['pass', 'needs_review', 'blocked', 'pending_human_review'],
      }),
      evidence: nonEmptyString({ description: '验收结论的证据或待补证据说明。' }),
    })),
  });
}

function qualityCheckSchema(criterion) {
  return strictObject({
    criterion: nonEmptyString({ constant: criterion }),
    status: nonEmptyString({
      values: ['pass', 'needs_review', 'blocked', 'pending_human_review'],
    }),
    evidence: nonEmptyString({ description: '支持质量判断的证据或待补材料。' }),
  });
}

function safetyCheckSchema(boundary) {
  return strictObject({
    boundary: nonEmptyString({ constant: boundary }),
    status: nonEmptyString({
      values: ['compliant', 'needs_review', 'blocked', 'pending_human_review'],
    }),
    handling: nonEmptyString({ description: '遵守边界的处置动作或人工升级路径。' }),
  });
}

function buildFixture(employee, {
  contractId,
  deliverableKeys,
  qualityKeys,
  safetyKeys,
}) {
  return {
    contract_id: contractId,
    role: {
      employee_idx: employee.idx,
      role_key: employee.key,
      role_title: employee.role || employee.name,
    },
    decision_context: {
      problem: `待填写：请${employee.name}解决的单一具体问题`,
      period: '待填写：本次分析或执行所覆盖的期间',
      scope: `待填写：${employee.duty || employee.name}任务的门店、渠道或业务范围`,
      sources: [{
        source: '待填写：真实业务材料、系统记录或可追溯外部来源',
        period: '待填写：来源对应期间或版本日期',
        fact: '待填写：该来源能够支持的事实，不把假设写成事实',
      }],
      assumptions: [{
        assumption: '待填写：当前仍未核验的关键假设',
        impact: '待填写：假设不成立时对结论的影响',
        verification: '待填写：负责人如何、何时完成核验',
      }],
    },
    deliverables: Object.fromEntries(employee.deliverables.map((deliverable, index) => [
      deliverableKeys[index],
      {
        deliverable_name: deliverable,
        summary: `待填写：基于真实材料完成“${deliverable}”`,
        evidence: [{
          source: '待填写：支持本交付物的材料或系统记录',
          period: '待填写：证据期间或版本日期',
          finding: '待填写：已核验发现；未知部分明确标为待核验',
        }],
        actions: [{
          action: `待填写：围绕“${deliverable}”执行的下一步动作`,
          owner: '待指定：有权限的责任人',
          deadline: '待指定：明确截止时间',
          success_metric: '待填写：可复核的完成标准',
        }],
        acceptance_checks: [{
          criterion: `核验“${deliverable}”是否覆盖岗位手册要求并有证据支撑`,
          result: 'pending_human_review',
          evidence: '待补充：由有权限负责人审阅并记录结论',
        }],
      },
    ])),
    quality_review: {
      checks: Object.fromEntries(employee.qualityGates.map((criterion, index) => [
        qualityKeys[index],
        {
          criterion,
          status: 'pending_human_review',
          evidence: '待补充：按岗位质量门提供可追溯证据',
        },
      ])),
      overall_status: 'pending_human_review',
      review_note: '当前是机器生成的待审阅稿，全部质量门须由有权限负责人确认。',
    },
    safety_review: {
      checks: Object.fromEntries(employee.safetyBoundaries.map((boundary, index) => [
        safetyKeys[index],
        {
          boundary,
          status: 'pending_human_review',
          handling: '待确认：涉及食安、价格、财务、监管、隐私或外部动作时升级人工审批。',
        },
      ])),
      overall_status: 'pending_human_review',
      escalation_note: '机器产出不得替代食品安全、财务、法律、监管或管理层决策。',
    },
    approval: {
      status: 'draft_pending_human_review',
      reviewer_roles: ['门店负责人'],
      external_action_allowed: false,
      financial_or_regulatory_commitment_allowed: false,
      review_note: '审批通过前不得发布、付款、调价、修改生产系统或形成监管承诺。',
    },
  };
}

function buildContract(employee) {
  const contractId = `urn:nanowork:restaurant-output:${employee.idx}:${employee.key}:v1`;
  const primaryArtifact = `restaurant-${employee.idx}-${employee.key}-delivery-package`;
  const deliverableKeys = employee.deliverables.map((item, index) => (
    stableFieldKey('deliverable', index, item)
  ));
  const quality = namedReviewObject(employee.qualityGates, 'quality', qualityCheckSchema);
  const safety = namedReviewObject(employee.safetyBoundaries, 'safety', safetyCheckSchema);

  if (new Set(deliverableKeys).size !== deliverableKeys.length) {
    throw new Error(`员工${employee.idx}交付物字段发生稳定键冲突`);
  }

  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: contractId,
    title: `${employee.idx}·${employee.name}机器输出契约`,
    ...strictObject({
      contract_id: nonEmptyString({ constant: contractId }),
      role: strictObject({
        employee_idx: { type: 'integer', const: employee.idx },
        role_key: nonEmptyString({ constant: employee.key }),
        role_title: nonEmptyString({ constant: employee.role || employee.name }),
      }),
      decision_context: strictObject({
        problem: nonEmptyString(),
        period: nonEmptyString(),
        scope: nonEmptyString(),
        sources: nonEmptyArray(strictObject({
          source: nonEmptyString(),
          period: nonEmptyString(),
          fact: nonEmptyString(),
        })),
        assumptions: nonEmptyArray(strictObject({
          assumption: nonEmptyString(),
          impact: nonEmptyString(),
          verification: nonEmptyString(),
        })),
      }),
      deliverables: strictObject(Object.fromEntries(employee.deliverables.map((item, index) => [
        deliverableKeys[index],
        deliverableSchema(item),
      ]))),
      quality_review: strictObject({
        checks: quality.schema,
        overall_status: nonEmptyString({
          values: ['pass', 'needs_review', 'blocked', 'pending_human_review'],
        }),
        review_note: nonEmptyString(),
      }),
      safety_review: strictObject({
        checks: safety.schema,
        overall_status: nonEmptyString({
          values: ['compliant', 'needs_review', 'blocked', 'pending_human_review'],
        }),
        escalation_note: nonEmptyString(),
      }),
      approval: strictObject({
        status: nonEmptyString({ values: ['draft_pending_human_review'] }),
        reviewer_roles: nonEmptyArray(nonEmptyString()),
        external_action_allowed: { type: 'boolean', const: false },
        financial_or_regulatory_commitment_allowed: { type: 'boolean', const: false },
        review_note: nonEmptyString(),
      }),
    }),
  };
  const validFixture = buildFixture(employee, {
    contractId,
    deliverableKeys,
    qualityKeys: quality.keys,
    safetyKeys: safety.keys,
  });
  // 云雾与 Claude 的 structured-output 仅接受受限 JSON Schema 子集。
  // 供应商层只负责生成合法形状；非空数组/非空文本等完整业务约束始终由内部 validator 复核。
  const providerSchema = toProviderSchema(schema);

  return deepFreeze({
    contractId,
    schemaVersion: SCHEMA_VERSION,
    employeeIdx: employee.idx,
    employeeKey: employee.key,
    format: 'json_object',
    primaryArtifact,
    topLevelKeys: [...TOP_LEVEL_KEYS],
    deliverableKeys,
    instruction: [
      '只输出一个符合 JSON Schema 的 JSON 对象，不添加 Markdown 围栏或解释文字。',
      '不得遗漏、补造或改名任何字段；未知事实写成明确的待核验说明，不能使用 null、空文本或空数组。',
      '所有产出保持 draft_pending_human_review，审批前禁止外部发布、付款、调价、生产系统修改或监管承诺。',
    ].join(''),
    schema,
    providerSchema,
    validFixture,
  });
}

const RESTAURANT_CONTRACTS = new Map(
  loadRestaurantCatalog().employees.map(employee => [employee.idx, buildContract(employee)]),
);

if (RESTAURANT_CONTRACTS.size !== 60) {
  throw new Error(`餐饮输出契约必须覆盖60岗，当前为${RESTAURANT_CONTRACTS.size}岗`);
}

function contractFor(idx) {
  const employeeIdx = Number(idx);
  const contract = RESTAURANT_CONTRACTS.get(employeeIdx);
  if (!contract) {
    throw Object.assign(new Error('餐饮数字员工输出契约编号必须在101-160'), { status: 404 });
  }
  return contract;
}

export function getRestaurantOutputContract(idx) {
  return structuredClone(contractFor(idx));
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSchemaValue(value, schema, path, errors) {
  if (Object.hasOwn(schema, 'const') && !sameJsonValue(value, schema.const)) {
    errors.push(`字段“${path}”必须等于岗位契约规定值。`);
    return;
  }
  if (schema.enum && !schema.enum.some(item => sameJsonValue(value, item))) {
    errors.push(`字段“${path}”不在允许值范围内。`);
    return;
  }

  if (schema.type === 'object') {
    if (!isPlainObject(value)) {
      errors.push(`字段“${path}”必须是JSON对象。`);
      return;
    }
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) errors.push(`缺少必需字段：${path}.${key}。`);
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).filter(key => !Object.hasOwn(properties, key));
      if (unknown.length) errors.push(`字段“${path}”包含未知字段：${unknown.join('、')}。`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateSchemaValue(value[key], child, `${path}.${key}`, errors);
    }
    return;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`字段“${path}”必须是数组。`);
      return;
    }
    if (value.length < Number(schema.minItems || 0)) {
      errors.push(`字段“${path}”不能为空数组，至少需要${schema.minItems}项。`);
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push(`字段“${path}”最多允许${schema.maxItems}项。`);
    }
    value.forEach((item, index) => validateSchemaValue(item, schema.items, `${path}[${index}]`, errors));
    return;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`字段“${path}”必须是字符串。`);
      return;
    }
    if (schema.minLength > 0 && !value.trim()) {
      errors.push(`字段“${path}”必须是非空文本。`);
    }
    return;
  }

  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) errors.push(`字段“${path}”必须是整数。`);
    return;
  }

  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    errors.push(`字段“${path}”必须是布尔值。`);
  }
}

function parseOutput(rawOutput) {
  if (isPlainObject(rawOutput)) return { parsed: structuredClone(rawOutput), error: null };
  if (typeof rawOutput !== 'string') {
    return { parsed: null, error: '输出必须是JSON对象或包含单个JSON对象的字符串。' };
  }
  if (!rawOutput.trim()) return { parsed: null, error: '输出为空，无法通过岗位契约。' };
  try {
    return { parsed: JSON.parse(rawOutput), error: null };
  } catch (error) {
    return { parsed: null, error: `输出不是有效JSON：${error.message}` };
  }
}

function safeFilenamePart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'employee';
}

function buildArtifact(contract, parsed) {
  const content = JSON.stringify(parsed, null, 2);
  const digest = sha256(content).slice(0, 12);
  return {
    kind: contract.primaryArtifact,
    primary: true,
    filename: `${safeFilenamePart(contract.primaryArtifact)}-${digest}.json`,
    mediaType: 'application/json',
    content,
    employeeIdx: contract.employeeIdx,
    employeeKey: contract.employeeKey,
    contractId: contract.contractId,
    schemaVersion: contract.schemaVersion,
  };
}

export function validateRestaurantEmployeeOutputContract(idx, rawOutput) {
  const contract = contractFor(idx);
  const { parsed, error } = parseOutput(rawOutput);
  const errors = error ? [error] : [];
  if (!error) {
    if (!isPlainObject(parsed)) {
      errors.push('输出顶层必须是JSON对象，不能是数组、null或其他JSON值。');
    } else {
      validateSchemaValue(parsed, contract.schema, '$', errors);
    }
  }

  if (errors.length) {
    return {
      valid: false,
      parsed,
      errors,
      artifacts: [],
    };
  }

  return {
    valid: true,
    parsed,
    errors: [],
    artifacts: [buildArtifact(contract, parsed)],
  };
}

export function inspectRestaurantOutputAudit({
  employeeProfileVersion,
  aiMode,
  executionEvidence,
} = {}) {
  if (!employeeProfileVersion) return { applicable: false, valid: true, audit: null, error: null };
  if (aiMode !== 'api') {
    return {
      applicable: true,
      valid: false,
      audit: null,
      error: '模板模式仅生成未完成底稿，不能采纳；请恢复AI通道并按岗位机器输出契约重新执行',
    };
  }
  let evidence = executionEvidence;
  if (typeof evidence === 'string') {
    try {
      evidence = JSON.parse(evidence || 'null');
    } catch {
      return {
        applicable: true,
        valid: false,
        audit: null,
        error: '岗位输出契约审计证据损坏，拒绝采纳',
      };
    }
  }
  const audit = evidence?.kind === 'restaurant_employee_execution_evidence'
    ? evidence.outputContract
    : null;
  const artifact = Array.isArray(audit?.artifacts) && audit.artifacts.length === 1
    ? audit.artifacts[0]
    : null;
  const complete = audit?.valid === true
    && typeof audit.contractId === 'string'
    && audit.contractId.trim()
    && typeof audit.schemaVersion === 'string'
    && audit.schemaVersion.trim()
    && typeof audit.primaryArtifact === 'string'
    && audit.primaryArtifact.trim()
    && artifact?.primary === true
    && artifact.kind === audit.primaryArtifact
    && artifact.contractId === audit.contractId
    && artifact.schemaVersion === audit.schemaVersion
    && /^[a-f0-9]{64}$/u.test(String(artifact.contentSha256 || ''));
  return complete
    ? { applicable: true, valid: true, audit, error: null }
    : {
        applicable: true,
        valid: false,
        audit,
        error: '岗位输出缺少完整且有效的机器契约审计证据，拒绝采纳',
      };
}

export function assertRestaurantOutputAdoptable(options = {}) {
  const result = inspectRestaurantOutputAudit(options);
  if (!result.valid) {
    throw Object.assign(new Error(result.error), {
      code: 'RESTAURANT_OUTPUT_NOT_ADOPTABLE',
      status: 409,
    });
  }
  return result;
}

function markdownTable(rows) {
  return [
    '| 项目 | 内容 |',
    '| --- | --- |',
    ...rows.map(([label, value]) => `| ${String(label).replaceAll('|', '\\|')} | ${String(value).replaceAll('|', '\\|')} |`),
  ].join('\n');
}

/**
 * 将已通过契约校验的结构化产出渲染为审批页可读 Markdown。
 * 本函数不补字段、不修复非法输出；调用前必须使用同一 validator 严格验收。
 */
export function renderRestaurantOutputMarkdown(idx, parsedOutput) {
  const validated = validateRestaurantEmployeeOutputContract(idx, parsedOutput);
  if (!validated.valid) {
    throw Object.assign(new Error(`餐饮岗位输出契约校验失败：${validated.errors.join('；')}`), {
      code: 'RESTAURANT_OUTPUT_CONTRACT_INVALID',
      status: 422,
      contractErrors: validated.errors,
    });
  }
  const contract = contractFor(idx);
  const output = validated.parsed;
  const sections = [
    `# ${output.role.role_title}｜待审阅结构化交付`,
    '',
    `> 契约：\`${contract.contractId}\`。本产出仍为 \`${output.approval.status}\`，人工审批前不得执行外部动作或形成财务、食安、法律、监管承诺。`,
    '',
    '## 决策上下文',
    markdownTable([
      ['问题', output.decision_context.problem],
      ['期间', output.decision_context.period],
      ['范围', output.decision_context.scope],
    ]),
    '',
    '### 决策来源',
    ...output.decision_context.sources.map(entry => (
      `- **${entry.source}**（${entry.period}）：${entry.fact}`
    )),
    '',
    '### 待核验假设',
    ...output.decision_context.assumptions.map(entry => (
      `- ${entry.assumption}｜影响：${entry.impact}｜核验：${entry.verification}`
    )),
  ];

  for (const key of contract.deliverableKeys) {
    const item = output.deliverables[key];
    sections.push(
      '',
      `## ${item.deliverable_name}`,
      '',
      item.summary,
      '',
      '### 证据',
      ...item.evidence.map(entry => `- **${entry.source}**（${entry.period}）：${entry.finding}`),
      '',
      '### 动作',
      ...item.actions.map(entry => (
        `- ${entry.action}｜负责人：${entry.owner}｜截止：${entry.deadline}｜检查标准：${entry.success_metric}`
      )),
      '',
      '### 验收',
      ...item.acceptance_checks.map(entry => `- [${entry.result === 'pass' ? 'x' : ' '}] ${entry.criterion}：${entry.evidence}`),
    );
  }

  sections.push(
    '',
    '## 质量门复核',
    `- 总体状态：${output.quality_review.overall_status}`,
    ...Object.values(output.quality_review.checks).map(entry => (
      `- **${entry.criterion}**｜${entry.status}｜${entry.evidence}`
    )),
    `- 复核说明：${output.quality_review.review_note}`,
    '',
    '## 安全边界复核',
    `- 总体状态：${output.safety_review.overall_status}`,
    ...Object.values(output.safety_review.checks).map(entry => (
      `- **${entry.boundary}**｜${entry.status}｜${entry.handling}`
    )),
    `- 升级说明：${output.safety_review.escalation_note}`,
    '',
    '## 审批边界',
    `- 状态：${output.approval.status}`,
    `- 审批角色：${output.approval.reviewer_roles.join('、')}`,
    `- 外部动作：${output.approval.external_action_allowed ? '允许' : '禁止'}`,
    `- 财务或监管承诺：${output.approval.financial_or_regulatory_commitment_allowed ? '允许' : '禁止'}`,
    `- 审批说明：${output.approval.review_note}`,
  );
  return sections.join('\n');
}

export const RESTAURANT_OUTPUT_SCHEMA_VERSION = SCHEMA_VERSION;

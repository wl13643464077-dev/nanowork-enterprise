/**
 * 自定义智能体导出/导入（最小可用）。
 *
 * 支持两种输入：
 * 1) 本平台导出的 JSON（schemaVersion = nanowork.custom-agent-export/1）；
 * 2) 通用“提示词工作流” JSON：{ name, description?, steps:[{title,prompt}], variables?:[{key,label}] }。
 *    导入时把 steps 编译成一个带步骤编号与变量占位说明的系统提示词。
 *
 * 不承诺兼容扣子/火山/龙虾等平台的私有格式；这些平台请先导出为提示词步骤。
 * 本文件是纯函数，不触碰数据库。
 */

export const AGENT_EXPORT_SCHEMA = 'nanowork.custom-agent-export/1';
export const PROMPT_WORKFLOW_SCHEMA = 'nanowork.prompt-workflow/1';

const MAX_STEPS = 30;
const MAX_VARIABLES = 30;
const MAX_STEP_TITLE = 80;
const MAX_STEP_PROMPT = 4000;
const MAX_DESCRIPTION = 2000;
const MAX_NAME = 60;
const MAX_COMPILED_PROMPT = 20000;
const MAX_SOURCE_BYTES = 200_000;
const VARIABLE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/u;

function importError(message, code = 'AGENT_IMPORT_INVALID') {
  return Object.assign(new Error(message), { status: 400, code });
}

function record(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function safeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 数据库行 → 导出 JSON（不含租户/创建者等内部字段）。 */
export function exportCustomAgent(agent, { exportedAt = new Date().toISOString() } = {}) {
  if (!record(agent)) throw importError('智能体不存在', 'AGENT_NOT_FOUND');
  let sourceWorkflow = null;
  if (agent.source_workflow) {
    try {
      sourceWorkflow = JSON.parse(agent.source_workflow);
    } catch {
      sourceWorkflow = null;
    }
  }
  return {
    schemaVersion: AGENT_EXPORT_SCHEMA,
    exportedAt,
    agent: {
      name: text(agent.name),
      emoji: text(agent.emoji) || '🤖',
      tier: text(agent.tier) || 'simple',
      prompt: text(agent.prompt),
      skills: safeArray(agent.skills).map(item => String(item)),
      persona: text(agent.persona),
    },
    sourceWorkflow,
  };
}

/** 兼容“上传 JSON 文件”与“粘贴文本”两种入口。 */
export function parseImportSource(input) {
  if (record(input)) return input;
  const raw = text(input);
  if (!raw) throw importError('请上传或粘贴工作流 JSON');
  if (Buffer.byteLength(raw, 'utf8') > MAX_SOURCE_BYTES) throw importError('工作流 JSON 超过 200KB 上限');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw importError('不是合法的 JSON：请检查引号、逗号与括号是否成对', 'AGENT_IMPORT_JSON_INVALID');
  }
  if (!record(parsed)) throw importError('工作流 JSON 的根节点必须是对象');
  return parsed;
}

function normalizeVariables(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw importError('variables 必须是数组');
  if (value.length > MAX_VARIABLES) throw importError(`variables 最多 ${MAX_VARIABLES} 个`);
  const seen = new Set();
  return value.map((item, index) => {
    const source = typeof item === 'string' ? { key: item } : item;
    if (!record(source)) throw importError(`variables[${index}] 必须是对象或字符串`);
    const key = text(source.key || source.name);
    if (!VARIABLE_KEY_RE.test(key)) {
      throw importError(`variables[${index}].key 只能是字母、数字、下划线，且以字母或下划线开头：${key || '（空）'}`);
    }
    if (seen.has(key)) throw importError(`变量重复：${key}`);
    seen.add(key);
    const label = text(source.label || source.description || source.title) || key;
    return { key, label: label.slice(0, 120) };
  });
}

function normalizeSteps(value) {
  if (!Array.isArray(value) || !value.length) throw importError('steps 必须是非空数组：每一步至少包含 prompt');
  if (value.length > MAX_STEPS) throw importError(`steps 最多 ${MAX_STEPS} 步`);
  return value.map((item, index) => {
    const source = typeof item === 'string' ? { prompt: item } : item;
    if (!record(source)) throw importError(`steps[${index}] 必须是对象或字符串`);
    const prompt = text(source.prompt || source.instruction || source.content);
    if (!prompt) throw importError(`steps[${index}].prompt 不能为空`);
    if (prompt.length > MAX_STEP_PROMPT) throw importError(`steps[${index}].prompt 超过 ${MAX_STEP_PROMPT} 字`);
    const title = text(source.title || source.name) || `步骤 ${index + 1}`;
    if (title.length > MAX_STEP_TITLE) throw importError(`steps[${index}].title 超过 ${MAX_STEP_TITLE} 字`);
    return { index: index + 1, title, prompt };
  });
}

function referencedVariables(steps) {
  const found = new Set();
  for (const step of steps) {
    for (const match of step.prompt.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,39})\s*\}\}/gu)) {
      found.add(match[1]);
    }
  }
  return found;
}

/** 通用步骤式工作流 → 单个系统提示词。 */
export function compilePromptWorkflow(workflow) {
  if (!record(workflow)) throw importError('工作流必须是对象');
  const name = text(workflow.name || workflow.title);
  if (!name) throw importError('工作流缺少 name（智能体名称）');
  if (name.length > MAX_NAME) throw importError(`name 超过 ${MAX_NAME} 字`);
  const description = text(workflow.description || workflow.purpose).slice(0, MAX_DESCRIPTION);
  const steps = normalizeSteps(workflow.steps);
  const variables = normalizeVariables(workflow.variables);
  const declared = new Set(variables.map(item => item.key));
  const referenced = referencedVariables(steps);
  // 步骤里出现但未声明的占位符自动补进变量说明，避免模型把 {{x}} 当成字面量。
  const undeclared = [...referenced].filter(key => !declared.has(key)).map(key => ({ key, label: key }));
  const allVariables = [...variables, ...undeclared];

  const sections = [`【工作流：${name}】`];
  if (description) sections.push(description);
  if (allVariables.length) {
    sections.push(
      [
        '【变量说明】开始执行前，先向用户确认下列信息；步骤中出现 {{变量名}} 的地方一律替换为用户提供的值，不得自行编造：',
        ...allVariables.map(item => `- {{${item.key}}}：${item.label}`),
      ].join('\n'),
    );
  }
  sections.push(
    [
      '【执行步骤】请严格按顺序逐步执行；每一步先写“第 N 步 · 标题”，再给出该步结果，完成后再进入下一步：',
      ...steps.map(step => `第 ${step.index} 步 · ${step.title}\n${step.prompt}`),
    ].join('\n\n'),
  );
  sections.push('【输出要求】全部步骤完成后，用一段“最终结论”汇总关键结果；缺少信息时明确指出缺什么，不要臆造。');
  const prompt = sections.join('\n\n');
  if (prompt.length > MAX_COMPILED_PROMPT) {
    throw importError(`编译后的提示词 ${prompt.length} 字，超过智能体 ${MAX_COMPILED_PROMPT} 字上限，请拆分工作流`);
  }
  return {
    name,
    description,
    steps,
    variables: allVariables,
    undeclaredVariables: undeclared.map(item => item.key),
    prompt,
  };
}

/**
 * 判定格式并转换为可直接交给 agents 路由 normalizedAgent 的输入。
 * 返回 { kind, agent, workflow, sourceWorkflow }。
 */
export function parseAgentImport(input) {
  const source = parseImportSource(input);
  if (source.schemaVersion === AGENT_EXPORT_SCHEMA || record(source.agent)) {
    if (source.schemaVersion !== undefined && source.schemaVersion !== AGENT_EXPORT_SCHEMA) {
      throw importError(`不支持的导出版本：${String(source.schemaVersion)}`, 'AGENT_IMPORT_SCHEMA_UNSUPPORTED');
    }
    const agent = source.agent;
    if (!record(agent)) throw importError('导出文件缺少 agent 字段');
    const name = text(agent.name);
    const prompt = text(agent.prompt);
    if (!name || !prompt) throw importError('导出文件的 agent.name 与 agent.prompt 不能为空');
    return {
      kind: 'nanowork_export',
      agent: {
        name,
        emoji: text(agent.emoji) || '🤖',
        tier: text(agent.tier) || 'simple',
        prompt,
        skills: Array.isArray(agent.skills) ? agent.skills.map(item => String(item)) : [],
        persona: text(agent.persona),
      },
      workflow: record(source.sourceWorkflow) ? source.sourceWorkflow : null,
      sourceWorkflow: source,
    };
  }
  if (Array.isArray(source.steps)) {
    if (source.schemaVersion !== undefined && source.schemaVersion !== PROMPT_WORKFLOW_SCHEMA) {
      throw importError(`不支持的工作流版本：${String(source.schemaVersion)}`, 'AGENT_IMPORT_SCHEMA_UNSUPPORTED');
    }
    const compiled = compilePromptWorkflow(source);
    return {
      kind: 'prompt_workflow',
      agent: {
        name: compiled.name,
        emoji: text(source.emoji) || '🧩',
        tier: 'simple',
        prompt: compiled.prompt,
        skills: [],
        persona: '',
      },
      workflow: {
        name: compiled.name,
        description: compiled.description,
        steps: compiled.steps,
        variables: compiled.variables,
        undeclaredVariables: compiled.undeclaredVariables,
      },
      sourceWorkflow: source,
    };
  }
  throw importError(
    '无法识别的格式：仅支持本平台导出的智能体 JSON，或包含 steps 数组的通用提示词工作流 JSON；扣子/火山等平台请先导出为提示词步骤',
    'AGENT_IMPORT_FORMAT_UNSUPPORTED',
  );
}

/** 落库到 custom_agents.source_workflow 的回溯信封。 */
export function sourceWorkflowEnvelope(parsed, { importedAt = new Date().toISOString(), importedBy = null } = {}) {
  return JSON.stringify({
    schemaVersion: 'nanowork.custom-agent-source-workflow/1',
    kind: parsed.kind,
    importedAt,
    importedBy,
    source: parsed.sourceWorkflow,
  });
}

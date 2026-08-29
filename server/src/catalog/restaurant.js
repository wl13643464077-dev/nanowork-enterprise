import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RESTAURANT_CATALOG_PATH = path.join(__dirname, '..', '..', 'catalog', 'restaurant.json');

const SECTION_ALIASES = {
  inputs: new Set(['必要输入', '输入', '必须输入']),
  steps: new Set(['工作流', '流程', '分步工作流']),
  deliverables: new Set(['交付物', '交付成果']),
  qualityGates: new Set(['质量门', '质量标准', '验收标准']),
  safetyBoundaries: new Set(['安全边界', '禁止事项', '红线']),
};

function cleanHeading(value) {
  return String(value || '')
    .replace(/[*_`]/g, '')
    .replace(/[：:]$/u, '')
    .replace(/\s+/g, '')
    .trim();
}

function sectionName(heading) {
  const normalized = cleanHeading(heading);
  const exact = Object.entries(SECTION_ALIASES).find(([, aliases]) => aliases.has(normalized))?.[0];
  if (exact) return exact;
  // 后一批岗位手册会把边界标题写成“外部动作与劳动/合规/隐私/高风险边界”。
  // 它们都属于真实的安全边界，不能因为标题更具体就退化成质量门副本。
  if (normalized.includes('边界')) return 'safetyBoundaries';
  return null;
}

function cleanItem(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[；;]\s*$/u, '')
    .trim();
}

function listItems(lines) {
  const items = [];
  let current = -1;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const match = line.match(/^\s*(?:[-+*]\s+|\d+[.)、]\s*)(.+?)\s*$/u);
    if (match) {
      const item = cleanItem(match[1]);
      if (item) {
        items.push(item);
        current = items.length - 1;
      }
      continue;
    }
    // 兼容 Markdown 列表项的缩进续行，但不把“收集并标注缺失项”等普通引导语当成交付内容。
    if (current >= 0 && /^\s{2,}\S/u.test(rawLine) && !/^\s*```/u.test(rawLine)) {
      items[current] = cleanItem(`${items[current]} ${line.trim()}`);
    }
  }
  return items;
}

/**
 * 从单个 employee.md 的正文解析结构化字段。
 * 历史目录使用过“必要输入/输入”“工作流/流程/分步工作流”等不同标题，均在此统一兼容。
 */
export function parseEmployeeMarkdown(markdown = '') {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const sections = { inputs: [], steps: [], deliverables: [], qualityGates: [], safetyBoundaries: [] };
  let active = null;
  let buffer = [];

  const flush = () => {
    if (active && sections[active].length === 0) sections[active] = listItems(buffer);
    buffer = [];
  };

  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      flush();
      active = sectionName(heading[1]);
      continue;
    }
    if (active) buffer.push(line);
  }
  flush();
  return sections;
}

function bracketSection(markdown, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(markdown || '').match(new RegExp(`【${escaped}】([\\s\\S]*?)(?=\\n【|$)`, 'u'));
  if (!match) return [];
  return match[1]
    .split(/\n+|[；;]/u)
    .map(value => cleanItem(value.replace(/^\s*\d+[.)、]\s*/u, '')))
    .filter(Boolean);
}

function isLeadIn(field, value) {
  const normalized = cleanHeading(value);
  if (field === 'inputs') {
    return /^(?:收集并标注缺失项|收集并标注来源日期|请提供以下信息|请先提供|必要输入如下)$/u.test(normalized);
  }
  if (field === 'deliverables') {
    return /^(?:提供|输出|交付内容如下|最终提供)$/u.test(normalized);
  }
  return false;
}

function normalizeEmployee(employee) {
  const parsed = parseEmployeeMarkdown(employee?.md);
  const normalized = { ...employee };
  for (const field of ['inputs', 'steps', 'deliverables', 'qualityGates', 'safetyBoundaries']) {
    const current = Array.isArray(employee?.[field])
      ? employee[field].map(cleanItem).filter(item => item && !isLeadIn(field, item))
      : [];
    normalized[field] = current.length ? current : parsed[field];
  }
  // 早期岗位手册把安全红线写在“质量门”里；超级店长使用【禁止】段。
  // 这里保留原文条目并显式记录来源，不编造不存在的行业规则。
  const forbidden = bracketSection(employee?.md, '禁止');
  if (!normalized.qualityGates.length) normalized.qualityGates = forbidden;
  if (!normalized.safetyBoundaries.length) {
    normalized.safetyBoundaries = forbidden.length ? forbidden : [...normalized.qualityGates];
    normalized.safetyBoundarySource = forbidden.length ? 'manual:禁止' : 'manual:质量门';
  } else {
    normalized.safetyBoundarySource = 'manual:安全边界';
  }
  return normalized;
}

function fail(message) {
  throw new Error(`餐饮数字员工目录无效：${message}`);
}

export function validateRestaurantCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('根节点必须是对象');
  if (!Array.isArray(value.groups) || value.groups.length !== 8) fail(`必须包含8个分部，当前为${value.groups?.length ?? 0}个`);
  if (!Array.isArray(value.employees) || value.employees.length !== 61) fail(`必须包含61名员工，当前为${value.employees?.length ?? 0}名`);

  const employees = value.employees.map(normalizeEmployee);
  const byIdx = new Map();
  const keys = new Set();
  for (const employee of employees) {
    if (!Number.isInteger(employee.idx)) fail(`员工idx必须是整数：${employee.idx}`);
    if (byIdx.has(employee.idx)) fail(`员工idx重复：${employee.idx}`);
    byIdx.set(employee.idx, employee);
    if (typeof employee.key !== 'string' || !employee.key.trim()) fail(`员工${employee.idx}缺少key`);
    if (keys.has(employee.key)) fail(`员工key重复：${employee.key}`);
    keys.add(employee.key);
    if (typeof employee.md !== 'string' || employee.md.trim().length < 100) fail(`员工${employee.idx}的完整岗位手册为空或过短`);
    for (const field of ['inputs', 'steps', 'deliverables', 'qualityGates', 'safetyBoundaries']) {
      if (!employee[field].length) fail(`员工${employee.idx}的${field}为空，且无法从employee.md解析`);
    }
  }

  for (let idx = 101; idx <= 161; idx += 1) {
    if (!byIdx.has(idx)) fail(`缺少员工idx：${idx}`);
  }
  for (const idx of byIdx.keys()) {
    if (idx < 101 || idx > 161) fail(`员工idx超出101-161：${idx}`);
  }

  const groupNames = new Set();
  const referenced = new Map();
  for (const group of value.groups) {
    const name = String(group?.name || '').trim();
    if (!name) fail('分部名称不能为空');
    if (groupNames.has(name)) fail(`分部名称重复：${name}`);
    groupNames.add(name);
    if (!Array.isArray(group.members) || group.members.length === 0) fail(`分部${name}没有成员`);
    for (const idx of group.members) {
      const employee = byIdx.get(idx);
      if (!employee) fail(`分部${name}引用了不存在的员工idx：${idx}`);
      if (referenced.has(idx)) fail(`员工${idx}被${referenced.get(idx)}和${name}重复引用`);
      if (employee.group !== name) fail(`员工${idx}声明分部“${employee.group}”，但被“${name}”引用`);
      referenced.set(idx, name);
    }
  }
  if (referenced.size !== employees.length) {
    const missing = employees.filter(employee => !referenced.has(employee.idx)).map(employee => employee.idx);
    fail(`存在未被分部引用的员工：${missing.join(',')}`);
  }

  return {
    ...value,
    tagline: String(value.tagline || '').replace(/59\s*位/u, '60 位'),
    groups: value.groups.map(group => ({ ...group, members: [...group.members] })),
    employees,
  };
}

export function loadRestaurantCatalog(catalogPath = RESTAURANT_CATALOG_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch (error) {
    throw new Error(`餐饮数字员工目录读取失败（${catalogPath}）：${error.message}`);
  }
  return validateRestaurantCatalog(parsed);
}

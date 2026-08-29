const COUNT_TOKEN_SOURCE = '(?:[0-9０-９]{1,2}|[一二两三四五六七八九十]{1,3})';
const TITLE_TERM_SOURCE = '(?:候选标题|标题候选|标题方案|标题)';
const COUNT_UNIT_SOURCE = '(?:个|条|组|款|版)';
const TITLE_MODIFIER_SOURCE = '(?:(?:差异化|不同(?:风格|方向|角度|类型)?|备选|可选|候选|原创|吸睛|多风格)(?:的)?\\s*){0,2}';
const ACTION_SOURCE = '(?:给(?:出)?|提供|输出|生成|写(?:出)?|列(?:出)?|拟(?:定)?|准备|交付|需要|要求|要|需|做|来|还是)';
const CHANGE_SOURCE = '(?:改成|改为|调整为|变成|设为|定为)';
const CLAUSE_BOUNDARY_SOURCE = '(?:^|[，,、。；;！!？?\\n：:])';

const NEGATED_TITLE_COUNT_LEAD_RE = /(?:不要|无需|无须|不需要|不要求|不必|不用|别|禁止|不得|不可|不能|不再|不用拘泥于|不必拘泥于|不要拘泥于|不限于)(?:(?:再|只|仅|恰好|正好)\s*)*(?:给(?:出)?|提供|输出|生成|写(?:出)?|列(?:出)?|拟(?:定)?|准备|交付|需要|要求|要|需|做|来|拘泥于)?(?:(?:再|只|仅|恰好|正好)\s*)*$/u;
const HISTORICAL_REFERENCE_RE = /(?:原来|原先|原本|之前|先前|上次|上一版|此前|曾经|过去)(?:[^，,。；;！!？?\n]{0,14})$/u;
const MINIMUM_LEAD_RE = /(?:至少|不少于|起码|最少|最低|不低于)(?:\s*(?:要|需|需要|给|写|做|来|输出|提供))?\s*$/u;
const MAXIMUM_LEAD_RE = /(?:至多|最多|不超过|不多于|最高|不高于)(?:\s*(?:要|需|需要|给|写|做|来|输出|提供))?\s*$/u;
const MINIMUM_TAIL_RE = /^\s*(?:起步|以上|及以上|或更多|太少(?:了)?|不够(?:多)?)/u;
const MAXIMUM_TAIL_RE = /^\s*(?:以内|以下|及以下|封顶|太多(?:了)?|过多)/u;

const EXACT_TITLE_COUNT_PATTERNS = Object.freeze([
  new RegExp(
    `(?:请\\s*)?(?:${ACTION_SOURCE}|${CHANGE_SOURCE})`
      + `\\s*(?:我\\s*)?(?:恰好|正好|共|共计)?\\s*(${COUNT_TOKEN_SOURCE})\\s*${COUNT_UNIT_SOURCE}?\\s*${TITLE_MODIFIER_SOURCE}${TITLE_TERM_SOURCE}`,
    'giu',
  ),
  new RegExp(
    `${TITLE_TERM_SOURCE}\\s*(?:的)?\\s*(?:数量|个数)?\\s*(?:必须|需要|要求|要|需|为|是|共|共计|给|写|来|做|还是|${CHANGE_SOURCE}|[:：])`
      + `\\s*(?:恰好|正好)?\\s*(${COUNT_TOKEN_SOURCE})\\s*${COUNT_UNIT_SOURCE}?`,
    'giu',
  ),
  new RegExp(
    `${CLAUSE_BOUNDARY_SOURCE}\\s*(?:恰好|正好|共|共计)?\\s*(${COUNT_TOKEN_SOURCE})`
      + `\\s*${COUNT_UNIT_SOURCE}\\s*${TITLE_MODIFIER_SOURCE}${TITLE_TERM_SOURCE}`,
    'gimu',
  ),
]);

const RANGE_TITLE_COUNT_PATTERNS = Object.freeze([
  {
    kind: 'range',
    pattern: new RegExp(
      `(?:${ACTION_SOURCE}|${CHANGE_SOURCE})?\\s*(${COUNT_TOKEN_SOURCE})\\s*(?:到|至|[-—–~～])\\s*(${COUNT_TOKEN_SOURCE})\\s*${COUNT_UNIT_SOURCE}?\\s*${TITLE_MODIFIER_SOURCE}${TITLE_TERM_SOURCE}`,
      'giu',
    ),
  },
  {
    kind: 'range',
    pattern: new RegExp(
      `${TITLE_TERM_SOURCE}\\s*(?:的)?\\s*(?:数量|个数)?\\s*(?:为|是|要|需|需要|要求|给|写|来|做|[:：])?\\s*(${COUNT_TOKEN_SOURCE})\\s*(?:到|至|[-—–~～])\\s*(${COUNT_TOKEN_SOURCE})\\s*${COUNT_UNIT_SOURCE}?`,
      'giu',
    ),
  },
  {
    kind: 'min',
    pattern: new RegExp(
      `(?:至少|不少于|起码|最少|最低|不低于)\\s*(?:${ACTION_SOURCE})?\\s*(${COUNT_TOKEN_SOURCE})\\s*${COUNT_UNIT_SOURCE}?\\s*${TITLE_MODIFIER_SOURCE}${TITLE_TERM_SOURCE}`,
      'giu',
    ),
  },
  {
    kind: 'min',
    pattern: new RegExp(
      `${TITLE_TERM_SOURCE}\\s*(?:的)?\\s*(?:数量|个数)?\\s*(?:至少|不少于|起码|最少|最低|不低于)\\s*(${COUNT_TOKEN_SOURCE})\\s*${COUNT_UNIT_SOURCE}?`,
      'giu',
    ),
  },
  {
    kind: 'max',
    pattern: new RegExp(
      `(?:至多|最多|不超过|不多于|最高|不高于)\\s*(?:${ACTION_SOURCE})?\\s*(${COUNT_TOKEN_SOURCE})\\s*${COUNT_UNIT_SOURCE}?\\s*${TITLE_MODIFIER_SOURCE}${TITLE_TERM_SOURCE}`,
      'giu',
    ),
  },
  {
    kind: 'max',
    pattern: new RegExp(
      `${TITLE_TERM_SOURCE}\\s*(?:的)?\\s*(?:数量|个数)?\\s*(?:至多|最多|不超过|不多于|最高|不高于)\\s*(${COUNT_TOKEN_SOURCE})\\s*${COUNT_UNIT_SOURCE}?`,
      'giu',
    ),
  },
]);

const FREE_TITLE_COUNT_PATTERNS = Object.freeze([
  /(?:这次|本次|现在)?[^，,。；;！!？?\n]{0,8}标题(?:的)?(?:数量|个数)?[^，,。；;！!？?\n]{0,6}(?:你看着办|看内容(?:需要)?|按内容需要|根据内容需要|自行决定|自由安排|灵活安排|不限|不限定|不固定)/giu,
  /(?:按|根据)内容(?:需要|情况)[^，,。；;！!？?\n]{0,10}(?:写|给|做|安排)?[^，,。；;！!？?\n]{0,6}标题/giu,
  /(?:不用|不必|不要|别)(?:再)?拘泥于[^，,。；;！!？?\n]{0,10}标题/giu,
]);

const CHINESE_DIGITS = Object.freeze({
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
});

function parseChineseNumber(value) {
  if (value === '十') return 10;
  if (!value.includes('十')) return CHINESE_DIGITS[value] ?? null;
  const [tensText, onesText] = value.split('十');
  const tens = tensText ? CHINESE_DIGITS[tensText] : 1;
  const ones = onesText ? CHINESE_DIGITS[onesText] : 0;
  if (!Number.isInteger(tens) || !Number.isInteger(ones)) return null;
  return tens * 10 + ones;
}

function parseCountToken(value) {
  const normalized = String(value || '').replace(/[０-９]/gu, digit => (
    String(digit.codePointAt(0) - '０'.codePointAt(0))
  ));
  if (/^\d{1,2}$/u.test(normalized)) return Number(normalized);
  return parseChineseNumber(normalized);
}

function clauseStart(value, index) {
  return Math.max(
    value.lastIndexOf('，', index - 1),
    value.lastIndexOf(',', index - 1),
    value.lastIndexOf('。', index - 1),
    value.lastIndexOf('；', index - 1),
    value.lastIndexOf(';', index - 1),
    value.lastIndexOf('！', index - 1),
    value.lastIndexOf('!', index - 1),
    value.lastIndexOf('？', index - 1),
    value.lastIndexOf('?', index - 1),
    value.lastIndexOf('\n', index - 1),
  ) + 1;
}

function exactMatchContext(value, match) {
  const index = Number(match.index || 0);
  const countOffset = match[0].indexOf(match[1]);
  const beforeCount = value.slice(clauseStart(value, index), index)
    + match[0].slice(0, countOffset < 0 ? 0 : countOffset);
  const afterMatch = value.slice(index + match[0].length, index + match[0].length + 18);
  return { index, beforeCount, afterMatch };
}

function exactEvent(value, match, { historicalReferences = false } = {}) {
  const count = parseCountToken(match[1]);
  if (!Number.isInteger(count)) return null;
  const { index, beforeCount, afterMatch } = exactMatchContext(value, match);
  if (historicalReferences && HISTORICAL_REFERENCE_RE.test(beforeCount)) return null;
  if (NEGATED_TITLE_COUNT_LEAD_RE.test(beforeCount)) {
    return { kind: 'cancel', count, index, end: index + match[0].length };
  }
  if (MINIMUM_LEAD_RE.test(beforeCount) || MINIMUM_TAIL_RE.test(afterMatch)) {
    const tooFew = /^\s*(?:太少|不够)/u.test(afterMatch);
    return {
      kind: 'range',
      min: count + (tooFew ? 1 : 0),
      max: null,
      index,
      end: index + match[0].length,
    };
  }
  if (MAXIMUM_LEAD_RE.test(beforeCount) || MAXIMUM_TAIL_RE.test(afterMatch)) {
    const tooMany = /^\s*(?:太多|过多)/u.test(afterMatch);
    return {
      kind: 'range',
      min: null,
      max: count - (tooMany ? 1 : 0),
      index,
      end: index + match[0].length,
    };
  }
  return { kind: 'exact', count, index, end: index + match[0].length };
}

function titleCountInstructionInText(value, { historicalReferences = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    return { constraint: null, canceledCounts: [], cancelsAll: false };
  }
  const events = [];
  for (const { kind, pattern } of RANGE_TITLE_COUNT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const first = parseCountToken(match[1]);
      const second = kind === 'range' ? parseCountToken(match[2]) : null;
      if (!Number.isInteger(first) || (kind === 'range' && !Number.isInteger(second))) continue;
      events.push({
        kind: 'range',
        min: kind === 'max' ? null : Math.min(first, second ?? first),
        max: kind === 'min' ? null : Math.max(first, second ?? first),
        index: Number(match.index || 0),
        end: Number(match.index || 0) + match[0].length,
      });
    }
  }
  for (const pattern of EXACT_TITLE_COUNT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const event = exactEvent(value, match, { historicalReferences });
      if (!event) continue;
      const overlapsRange = events.some(candidate => (
        candidate.kind === 'range'
        && event.index < candidate.end
        && event.end > candidate.index
      ));
      if (!overlapsRange) events.push(event);
    }
  }
  for (const pattern of FREE_TITLE_COUNT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      events.push({
        kind: 'free',
        index: Number(match.index || 0),
        end: Number(match.index || 0) + match[0].length,
      });
    }
  }
  events.sort((left, right) => left.index - right.index || left.end - right.end);
  const latest = events.at(-1) || null;
  return {
    constraint: latest?.kind === 'exact' || latest?.kind === 'range' ? latest : null,
    canceledCounts: [...new Set(events.filter(event => event.kind === 'cancel').map(event => event.count))],
    cancelsAll: latest?.kind === 'free',
    latestKind: latest?.kind || null,
  };
}

function resolvedConstraint(source, instruction) {
  const event = instruction.constraint;
  if (!event) return null;
  if (event.kind === 'exact') {
    return { kind: 'exact', count: event.count, min: event.count, max: event.count, source };
  }
  return { kind: 'range', count: null, min: event.min, max: event.max, source };
}

/**
 * 提取撰稿人任务里的标题数量约束。反馈优先于原要求；历史引用、取消语句、
 * “至少/至多/起步/太少”等不会伪装成精确数量，而是保留范围语义。
 */
export function resolveWriterTitleCountRequirement({ requirement, feedback } = {}) {
  const feedbackInstruction = titleCountInstructionInText(feedback, { historicalReferences: true });
  const requirementInstruction = titleCountInstructionInText(requirement);
  const feedbackConstraint = resolvedConstraint('feedback', feedbackInstruction);
  const requirementConstraint = resolvedConstraint('requirement', requirementInstruction);
  const feedbackCancelsRequirement = Boolean(requirementConstraint) && (
    feedbackInstruction.cancelsAll
    || feedbackInstruction.latestKind === 'cancel'
    || (requirementConstraint.kind === 'exact'
      && feedbackInstruction.canceledCounts.includes(requirementConstraint.count))
  );
  const constraint = feedbackConstraint
    || (!feedbackCancelsRequirement ? requirementConstraint : null);
  const min = constraint?.min ?? null;
  const max = constraint?.max ?? null;
  const effectiveMin = constraint ? Math.max(3, min ?? 3) : 3;
  const effectiveMax = constraint ? Math.min(5, max ?? 5) : 5;
  const contractSatisfiable = !constraint || effectiveMin <= effectiveMax;
  return Object.freeze({
    explicit: constraint?.kind === 'exact',
    hasConstraint: Boolean(constraint),
    constraintKind: constraint?.kind || 'none',
    count: constraint?.kind === 'exact' ? constraint.count : null,
    min,
    max,
    effectiveMin,
    effectiveMax,
    contractSatisfiable,
    inContractRange: constraint?.kind === 'exact'
      && constraint.count >= 3
      && constraint.count <= 5,
    source: constraint?.source || null,
  });
}

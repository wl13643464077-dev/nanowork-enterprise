import { createHash } from 'node:crypto';

import { buildContentEmployeeWorkbenchProfile } from './content-employee-workbench.js';
import { resolveWriterTitleCountRequirement } from './content-title-count.js';

const ARTIFACT_EXTENSIONS = Object.freeze({
  json: 'json',
  markdown: 'md',
  images: 'json',
  covers: 'json',
  html: 'html',
  publish_packages: 'json',
});

const ARTIFACT_MEDIA_TYPES = Object.freeze({
  json: 'application/json',
  markdown: 'text/markdown',
  images: 'application/json',
  covers: 'application/json',
  html: 'text/html',
  publish_packages: 'application/json',
});

const MINIMUM_TEXT = Object.freeze({
  label: 2,
  title: 6,
  detail: 12,
  rationale: 16,
  trendBriefing: 120,
  researchSummary: 60,
  consistencyNote: 24,
  deckSummary: 30,
  article: 240,
  platformBody: 120,
  retrospectiveReport: 180,
  svg: 180,
  coverHtml: 300,
  deckHtml: 500,
});

const NO_SIGNAL_FINDING_RE = /^(?:本次)?无明显信号(?:[：:，,][^。！？!?\n]{0,48})?[。.]?$/u;

function isNoSignalFinding(value) {
  return typeof value === 'string' && NO_SIGNAL_FINDING_RE.test(value.trim());
}

const MINIMUM_ITEMS = Object.freeze({
  channelScan: 3,
  facts: 3,
  dataPoints: 2,
  viewpoints: 2,
  sourceCoverage: 3,
  sources: 2,
  insightLists: 3,
  images: 2,
  covers: 3,
  versions: 3,
  versionTags: 3,
  nextTopics: 3,
});

const MAXIMUM_TEXT = Object.freeze({
  retrospectiveReport: 1200,
  retrospectiveTopicTitle: 80,
  retrospectiveTopicReason: 160,
  retrospectiveProfileUpdate: 160,
});

const BENCHMARK_DIMENSIONS = Object.freeze([
  '选题角度',
  '标题/钩子',
  '内容结构',
  '情绪曲线',
  '封面与视觉',
  '评论区洞察',
]);

const WEB_EVIDENCE_TRACKING_QUERY_KEY = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|yclid|mc_cid|mc_eid|igshid|ttclid|twclid)$/iu;

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function jsonFence(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function unwrapJsonFence(value) {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```json(?:[ \t]*\r?\n|[ \t]+)([\s\S]*?)(?:\r?\n)?```$/iu);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseOutput(rawOutput) {
  if (isPlainObject(rawOutput)) {
    return {
      parsed: structuredClone(rawOutput),
      parseError: null,
      rawPreview: jsonFence(rawOutput),
    };
  }

  if (typeof rawOutput !== 'string') {
    return {
      parsed: null,
      parseError: '输出必须是 JSON 字符串或 JSON 对象。',
      rawPreview: rawOutput == null ? '' : String(rawOutput),
    };
  }

  if (!rawOutput.trim()) {
    return {
      parsed: null,
      parseError: '输出为空，无法解析为 JSON 对象。',
      rawPreview: rawOutput,
    };
  }

  try {
    return {
      parsed: JSON.parse(unwrapJsonFence(rawOutput)),
      parseError: null,
      rawPreview: rawOutput,
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: `输出不是有效 JSON：${error.message}`,
      rawPreview: rawOutput,
    };
  }
}

function normalizedHtmlForProtocolCheck(html) {
  return html
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/giu, (_match, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return '';
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return '';
      }
    })
    .replace(/&colon;?/giu, ':')
    .replace(/&(?:tab|newline);?/giu, '')
    .replace(/[\u0000-\u0020\u007f]+/gu, '')
    .toLowerCase();
}

function visibleHtmlBodyText(html) {
  const body = String(html || '').match(/<body(?:\s[^>]*)?>([\s\S]*?)<\/body\s*>/iu)?.[1] || '';
  const accessibleText = [...body.matchAll(/\b(?:alt|aria-label|title)\s*=\s*(["'])([\s\S]*?)\1/giu)]
    .map(match => match[2])
    .join(' ');
  const renderedText = body
    .replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)\s*>/giu, ' ')
    .replace(/<!--[^]*?-->/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&(?:nbsp|ensp|emsp|thinsp);/giu, ' ')
    .replace(/&#(?:x[0-9a-f]+|[0-9]+);?/giu, '字')
    .replace(/\s+/gu, ' ')
    .trim();
  return `${accessibleText} ${renderedText}`.replace(/\s+/gu, ' ').trim();
}

function validateCompleteHtml(html, path = 'html', {
  minLength = 1,
  minBodyTextLength = 1,
} = {}) {
  if (typeof html !== 'string' || !html.trim()) {
    return [`字段“${path}”必须是非空字符串。`];
  }

  const errors = [];
  if ([...html.trim()].length < minLength) {
    errors.push(`字段“${path}”至少需要${minLength}个字符，不能是空壳页面。`);
  }
  if (!/<html(?:\s|>)/iu.test(html) || !/<\/html\s*>/iu.test(html)) {
    errors.push(`字段“${path}”必须包含完整的 <html> 根元素。`);
  }
  if (!/<body(?:\s|>)/iu.test(html) || !/<\/body\s*>/iu.test(html)) {
    errors.push(`字段“${path}”必须包含完整的 <body> 正文元素。`);
  }
  if (normalizedHtmlForProtocolCheck(html).includes('javascript:')) {
    errors.push(`字段“${path}”禁止使用 javascript: URL。`);
  }
  if (/<script\b[^>]*\bsrc\s*=/iu.test(html)) {
    errors.push(`字段“${path}”禁止引用外部脚本；脚本必须内联并经过人工审阅。`);
  }
  const cssGeneratedText = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu)]
    .some(match => /(?:^|[;{])\s*content\s*:/imu.test(match[1]));
  if (cssGeneratedText) {
    errors.push(`字段“${path}”禁止使用CSS content生成正文；所有可见文字必须直接写入HTML并接受事实校验。`);
  }
  const visibleTextLength = [...visibleHtmlBodyText(html)].length;
  if (visibleTextLength < minBodyTextLength) {
    errors.push(`字段“${path}”的body可见正文至少需要${minBodyTextLength}个字符。`);
  }
  return errors;
}

function validateNonEmptyString(value, path, errors) {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`字段“${path}”必须是非空字符串。`);
    return false;
  }
  return true;
}

function validateMinimumText(value, path, errors, minLength = 1) {
  if (!validateNonEmptyString(value, path, errors)) return false;
  const length = [...value.trim()].length;
  if (length < minLength) {
    errors.push(`字段“${path}”至少需要${minLength}个字符，当前只有${length}个。`);
    return false;
  }
  return true;
}

function validateMaximumText(value, path, errors, maxLength) {
  if (typeof value !== 'string') return false;
  const length = [...value.trim()].length;
  if (length > maxLength) {
    errors.push(`字段“${path}”最多允许${maxLength}个字符，当前有${length}个。`);
    return false;
  }
  return true;
}

function validateSegmentedMarkdown(value, path, errors) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  const collapsedHeading = !text.includes('\n') && /(?:^| )#{1,3} |\s##\s/u.test(text);
  if (collapsedHeading) {
    errors.push(`字段“${path}”必须是分段 Markdown，标题和段落要用换行分隔，禁止把全文压成一行空格。`);
    return false;
  }
  return true;
}

function validateArray(value, path, errors, {
  min = 1,
  max = null,
  exact = null,
  item = null,
} = {}) {
  if (!Array.isArray(value)) {
    errors.push(`字段“${path}”必须是数组。`);
    return false;
  }
  if (exact !== null && value.length !== exact) {
    errors.push(`字段“${path}”必须恰好包含${exact}项。`);
  } else if (max !== null && (value.length < min || value.length > max)) {
    errors.push(`字段“${path}”必须包含${min}-${max}项${value.length === 0 ? '，不能是空数组' : ''}。`);
  } else {
    if (value.length < min) {
      errors.push(`字段“${path}”必须至少包含${min}项，不能是空数组。`);
    }
  }
  if (typeof item === 'function') {
    value.forEach((entry, index) => item(entry, `${path}[${index}]`, errors));
  }
  return true;
}

function validateStringArray(value, path, errors, bounds = {}) {
  const { itemMin = 1, itemMax = null, ...arrayBounds } = bounds;
  return validateArray(value, path, errors, {
    ...arrayBounds,
    item: (entry, itemPath, targetErrors) => {
      validateMinimumText(entry, itemPath, targetErrors, itemMin);
      if (itemMax !== null) validateMaximumText(entry, itemPath, targetErrors, itemMax);
    },
  });
}

function validateTagArray(value, path, errors, bounds = {}) {
  const isArray = validateStringArray(value, path, errors, bounds);
  if (!isArray) return false;
  value.forEach((tag, index) => {
    if (typeof tag === 'string' && /[#＃]/u.test(tag)) {
      errors.push(`字段“${path}[${index}]”是纯文本标签，不得包含 # 或＃。`);
    }
  });
  validateUniqueStrings(value, path, errors);
  return true;
}

function validateObject(value, path, errors, fields) {
  if (!isPlainObject(value)) {
    errors.push(`字段“${path}”必须是JSON对象。`);
    return false;
  }
  for (const [key, validator] of Object.entries(fields)) {
    const childPath = `${path}.${key}`;
    if (!Object.hasOwn(value, key)) {
      errors.push(`缺少必需字段：${childPath}。`);
      continue;
    }
    validator(value[key], childPath, errors);
  }
  const extras = Object.keys(value).filter(key => !Object.hasOwn(fields, key));
  if (extras.length) {
    errors.push(`字段“${path}”包含未知字段：${extras.join('、')}。`);
  }
  return true;
}

const STRING_FIELD = (value, path, errors) => validateNonEmptyString(value, path, errors);

function minimumTextField(minLength) {
  return (value, path, errors) => validateMinimumText(value, path, errors, minLength);
}

function textRangeField(minLength, maxLength) {
  return (value, path, errors) => {
    validateMinimumText(value, path, errors, minLength);
    validateMaximumText(value, path, errors, maxLength);
  };
}

const TAG_WITHOUT_HASH_PATTERN = '^[^#＃]+$';

function schemaString(extra = {}) {
  return {
    type: 'string',
    minLength: 1,
    ...extra,
  };
}

function schemaTagString() {
  return schemaString({
    pattern: TAG_WITHOUT_HASH_PATTERN,
    description: '标签只返回文本，不得包含 # 或＃。',
  });
}

function schemaObject(properties, extra = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
    ...extra,
  };
}

function schemaArray(items, {
  minItems = 1,
  maxItems,
} = {}) {
  return {
    type: 'array',
    minItems,
    ...(Number.isInteger(maxItems) ? { maxItems } : {}),
    items,
  };
}

function exactSchemaArray(items, count) {
  return schemaArray(items, { minItems: count, maxItems: count });
}

const CONTENT_EMPLOYEE_OUTPUT_SCHEMAS = Object.freeze([
  schemaObject({
    briefing: schemaString({ minLength: MINIMUM_TEXT.trendBriefing }),
    channel_scan: schemaArray(schemaObject({
      channel: schemaString({ minLength: MINIMUM_TEXT.label }),
      finding: schemaString({ minLength: MINIMUM_TEXT.detail }),
    }), { minItems: MINIMUM_ITEMS.channelScan }),
    topics: exactSchemaArray(schemaObject({
      title: schemaString({ minLength: MINIMUM_TEXT.title }),
      angle: schemaString({ minLength: MINIMUM_TEXT.title }),
      hook: schemaString({ minLength: 10 }),
      reason: schemaString({ minLength: MINIMUM_TEXT.rationale }),
      heat: schemaString(),
      evidence: schemaString({ minLength: 8 }),
    }), 5),
  }),
  schemaObject({
    summary: schemaString({ minLength: MINIMUM_TEXT.researchSummary }),
    facts: schemaArray(schemaString({ minLength: MINIMUM_TEXT.detail }), { minItems: MINIMUM_ITEMS.facts }),
    data_points: schemaArray(schemaString({ minLength: MINIMUM_TEXT.detail }), { minItems: MINIMUM_ITEMS.dataPoints }),
    viewpoints: schemaArray(schemaString({ minLength: MINIMUM_TEXT.detail }), { minItems: MINIMUM_ITEMS.viewpoints }),
    source_coverage: schemaArray(schemaObject({
      channel: schemaString({ minLength: MINIMUM_TEXT.label }),
      got: schemaString({ minLength: 10 }),
    }), { minItems: MINIMUM_ITEMS.sourceCoverage }),
    sources: schemaArray(schemaObject({
      title: schemaString({ minLength: MINIMUM_TEXT.title }),
      url: schemaString({
        pattern: '^https?://',
        description: '必须是可核验的 http(s) 来源链接。',
      }),
    }), { minItems: MINIMUM_ITEMS.sources }),
  }),
  schemaObject({
    benchmarks: schemaArray(schemaObject({
      title: schemaString({ minLength: MINIMUM_TEXT.title }),
      platform: schemaString({ minLength: MINIMUM_TEXT.label }),
      account: schemaString({ minLength: MINIMUM_TEXT.label }),
      dimensions: schemaObject(Object.fromEntries(BENCHMARK_DIMENSIONS.map(key => [
        key,
        schemaString({ minLength: MINIMUM_TEXT.detail }),
      ])), { description: '按拆解师出厂工作配置的六个维度逐项分析。' }),
      why_hot: schemaString({ minLength: MINIMUM_TEXT.rationale }),
    }), { minItems: 3, maxItems: 5 }),
    comment_insights: schemaArray(schemaString({ minLength: MINIMUM_TEXT.detail }), { minItems: MINIMUM_ITEMS.insightLists }),
    user_language: schemaArray(schemaString({ minLength: MINIMUM_TEXT.label }), { minItems: MINIMUM_ITEMS.insightLists }),
    takeaways: schemaArray(schemaString({ minLength: MINIMUM_TEXT.detail }), { minItems: MINIMUM_ITEMS.insightLists }),
  }),
  schemaObject({
    title_candidates: schemaArray(schemaString({ minLength: MINIMUM_TEXT.title }), {
      minItems: 3,
      maxItems: 5,
    }),
    body: schemaString({ minLength: MINIMUM_TEXT.article }),
    tags: schemaArray(schemaTagString(), { minItems: 5, maxItems: 8 }),
    image_plan: schemaArray(schemaObject({
      slot: schemaString({ minLength: MINIMUM_TEXT.label }),
      desc: schemaString({ minLength: MINIMUM_TEXT.detail }),
    }), { minItems: 2, maxItems: 4 }),
  }),
  schemaObject({
    body: schemaString({ minLength: MINIMUM_TEXT.article }),
    title_candidates: exactSchemaArray(schemaString({ minLength: MINIMUM_TEXT.title }), 3),
    consistency_note: schemaString({ minLength: MINIMUM_TEXT.consistencyNote }),
  }),
  schemaObject({
    images: schemaArray(schemaObject({
      slot: schemaString({ minLength: MINIMUM_TEXT.label }),
      desc: schemaString({ minLength: MINIMUM_TEXT.detail }),
      platform: schemaString({ minLength: MINIMUM_TEXT.label }),
      svg: schemaString({ minLength: MINIMUM_TEXT.svg, description: '必须是从 <svg> 开始并以 </svg> 结束的完整 SVG。' }),
    }), { minItems: MINIMUM_ITEMS.images, maxItems: 4 }),
  }),
  schemaObject({
    covers: exactSchemaArray(schemaObject({
      style: schemaString({ minLength: MINIMUM_TEXT.label }),
      platform: schemaString({ minLength: MINIMUM_TEXT.label }),
      size: schemaString({ minLength: MINIMUM_TEXT.title }),
      html: schemaString({ minLength: MINIMUM_TEXT.coverHtml, description: '必须是包含完整 html 与 body 元素的独立 HTML 页面。' }),
    }), MINIMUM_ITEMS.covers),
  }),
  schemaObject({
    summary: schemaString({ minLength: MINIMUM_TEXT.deckSummary }),
    html: schemaString({ minLength: MINIMUM_TEXT.deckHtml, description: '必须是包含完整 html 与 body 元素的独立 HTML 页面。' }),
  }),
  schemaObject({
    versions: exactSchemaArray(schemaObject({
      platform: schemaString({ minLength: MINIMUM_TEXT.label }),
      title: schemaString({ minLength: MINIMUM_TEXT.title }),
      body: schemaString({ minLength: MINIMUM_TEXT.platformBody }),
      tags: schemaArray(schemaTagString(), { minItems: MINIMUM_ITEMS.versionTags, maxItems: 8 }),
      best_time: schemaString({ minLength: 3 }),
      checklist: schemaArray(schemaString({ minLength: MINIMUM_TEXT.title }), { minItems: 2, maxItems: 4 }),
      note: schemaString({ minLength: MINIMUM_TEXT.detail }),
    }), MINIMUM_ITEMS.versions),
    publish_plan: schemaString({ minLength: MINIMUM_TEXT.deckSummary }),
  }),
  schemaObject({
    report: schemaString({
      minLength: MINIMUM_TEXT.retrospectiveReport,
      maxLength: MAXIMUM_TEXT.retrospectiveReport,
      description: '有真实指标或已核验来源时据此复盘。两者均缺失时按派活产出发布后复盘计划：T+1/T+3/T+7 指标计划、标注为待验证假设的预测性分析，以及数据补齐说明；达标线只能写待补历史基线或由负责人设定，不得把技能卡数字写成已发生效果。',
    }),
    next_topics: schemaArray(schemaObject({
      title: schemaString({
        minLength: MINIMUM_TEXT.title,
        maxLength: MAXIMUM_TEXT.retrospectiveTopicTitle,
      }),
      reason: schemaString({
        minLength: MINIMUM_TEXT.detail,
        maxLength: MAXIMUM_TEXT.retrospectiveTopicReason,
      }),
    }), { minItems: MINIMUM_ITEMS.nextTopics, maxItems: 5 }),
    profile_updates: schemaArray(schemaString({
      minLength: MINIMUM_TEXT.detail,
      maxLength: MAXIMUM_TEXT.retrospectiveProfileUpdate,
      description: '只写有真实数据或已核验来源支持的可复用经验；没有可写回经验时返回空数组。',
    }), {
      minItems: 0,
      maxItems: 5,
    }),
  }),
]);

function parseRequirementObject(requirement) {
  if (isPlainObject(requirement)) return requirement;
  if (typeof requirement !== 'string' || !requirement.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(requirement);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function requestedMediaImageCount(context) {
  if (!isPlainObject(context)) return MINIMUM_ITEMS.images;
  const requirement = parseRequirementObject(context.requirement);
  const candidates = [
    context.brief?.image_count,
    context.brief?.imageCount,
    context.task?.image_count,
    context.task?.imageCount,
    requirement?.brief?.image_count,
    requirement?.brief?.imageCount,
    requirement?.task?.image_count,
    requirement?.task?.imageCount,
  ];
  const raw = candidates.find((value) => value !== undefined && value !== null && value !== '');
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) return MINIMUM_ITEMS.images;
  return Math.min(count, 4);
}

function requestedPublishPlatforms(context) {
  if (!isPlainObject(context)) return null;
  const requirement = parseRequirementObject(context.requirement);
  const candidates = [
    context.brief?.platforms,
    context.task?.platforms,
    requirement?.brief?.platforms,
    requirement?.task?.platforms,
    requirement?.platforms,
  ];
  const explicit = candidates.find(Array.isArray);
  if (!explicit?.length) return null;
  const platforms = [...new Set(explicit
    .map(platform => typeof platform === 'string' ? platform.trim() : '')
    .filter(Boolean))];
  return platforms.length ? platforms : null;
}

/**
 * 返回给云模型 structured-output 通道使用的岗位响应契约。
 *
 * 每层对象都要求完整字段并拒绝额外字段；模型层约束输出形状后，
 * validateContentEmployeeOutputContract 仍会执行最终业务校验。
 */
export function getContentEmployeeOutputResponseSchema(idx, context = {}) {
  const profile = buildContentEmployeeWorkbenchProfile(idx);
  const schema = CONTENT_EMPLOYEE_OUTPUT_SCHEMAS[profile.identity.idx];
  if (!schema) throw new RangeError('内容员工输出契约编号必须在0-9');
  if (JSON.stringify(Object.keys(schema.properties))
    !== JSON.stringify(profile.jobProfile.outputSchema.keys)) {
    throw new Error(`内容员工${profile.identity.idx}响应Schema与岗位输出字段不一致`);
  }
  const responseSchema = structuredClone(schema);
  const requestedPlatforms = requestedPublishPlatforms(context);
  if (profile.identity.idx === 8 && requestedPlatforms) {
    const versions = responseSchema.properties.versions;
    versions.minItems = requestedPlatforms.length;
    versions.maxItems = requestedPlatforms.length * 3;
    versions.description = '只为任务书请求的平台生成发布包；每个请求平台至少一个主发布包，同平台后续项可作为可选变体，不能补造未请求平台。';
    versions.items.properties.platform.enum = [...requestedPlatforms];
    versions.items.properties.platform.description = '必须严格匹配任务书 requested platforms 中的平台名称。';
  }
  return {
    name: `content_employee_${profile.identity.idx}_output`,
    schema: responseSchema,
  };
}

function validateObjectArray(value, path, errors, fields, bounds = {}) {
  return validateArray(value, path, errors, {
    ...bounds,
    item: (entry, itemPath, targetErrors) => {
      validateObject(entry, itemPath, targetErrors, fields);
    },
  });
}

/**
 * 仅用于判定“是否同一篇联网证据”，不用于放宽最终来源的精确归因。
 *
 * 主机名不区分大小写；路径可能区分大小写，因此绝不转小写。去掉
 * fragment、默认端口和广告追踪参数，再对余下 query 做稳定排序，避免
 * 同一文章用两个 utm 链接充当两个独立来源。
 */
function normalizedEvidenceUrlIdentity(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    if (
      (url.protocol === 'http:' && url.port === '80')
      || (url.protocol === 'https:' && url.port === '443')
    ) {
      url.port = '';
    }
    const query = [...url.searchParams.entries()]
      .filter(([key]) => !WEB_EVIDENCE_TRACKING_QUERY_KEY.test(key))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        const keyOrder = leftKey.localeCompare(rightKey, 'en');
        return keyOrder || leftValue.localeCompare(rightValue, 'en');
      });
    url.search = '';
    for (const [key, queryValue] of query) {
      url.searchParams.append(key, queryValue);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function validateHttpUrl(value, path, errors) {
  if (!validateNonEmptyString(value, path, errors)) return;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    if (url.username || url.password) {
      errors.push(`字段“${path}”的URL禁止携带用户名或密码凭据。`);
    }
  } catch {
    errors.push(`字段“${path}”必须是有效的 http(s) 链接。`);
  }
}

function validateDimensions(value, path, errors) {
  validateObject(value, path, errors, Object.fromEntries(BENCHMARK_DIMENSIONS.map(key => [
    key,
    minimumTextField(MINIMUM_TEXT.detail),
  ])));
}

function validateSvg(value, path, errors) {
  if (!validateMinimumText(value, path, errors, MINIMUM_TEXT.svg)) return;
  if (!/^\s*<svg(?:\s|>)[\s\S]*<\/svg>\s*$/iu.test(value)) {
    errors.push(`字段“${path}”必须是完整的SVG。`);
  }
  if (!/<svg\b[^>]*\bviewBox\s*=\s*["'][^"']+["']/iu.test(value)) {
    errors.push(`字段“${path}”必须声明viewBox，确保跨端缩放可用。`);
  }
  if (!/<(?:path|rect|circle|ellipse|line|polyline|polygon|text|image)\b/iu.test(value)) {
    errors.push(`字段“${path}”至少需要一个可见绘制元素，不能是空SVG。`);
  }
}

function normalizedUniqueText(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/[\s，,。！？!?;；：:'"“”‘’()[\]{}【】<>《》_-]+/gu, '')
    .toLocaleLowerCase('zh-CN');
}

function validateUniqueStrings(value, path, errors) {
  if (!Array.isArray(value)) return;
  const seen = new Map();
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) return;
    const normalized = normalizedUniqueText(entry);
    if (!normalized) return;
    if (seen.has(normalized)) {
      errors.push(`字段“${path}”的各项必须唯一：第${seen.get(normalized) + 1}项与第${index + 1}项重复。`);
    } else {
      seen.set(normalized, index);
    }
  });
}

function validateUniqueObjectFields(value, path, errors, fields) {
  if (!Array.isArray(value)) return;
  const seen = new Map();
  value.forEach((entry, index) => {
    if (!isPlainObject(entry)) return;
    const parts = fields.map(field => normalizedUniqueText(entry[field]));
    if (parts.some(part => !part)) return;
    const normalized = parts.join('\u241f');
    if (seen.has(normalized)) {
      errors.push(`字段“${path}”中的“${fields.join('+')}”组合必须唯一：第${seen.get(normalized) + 1}项与第${index + 1}项重复。`);
    } else {
      seen.set(normalized, index);
    }
  });
}

function validateUniqueObjectField(value, path, errors, field) {
  validateUniqueObjectFields(value, path, errors, [field]);
}

function validateUniqueEvidenceUrlIdentities(value, path, errors) {
  if (!Array.isArray(value)) return;
  const seen = new Map();
  value.forEach((entry, index) => {
    if (!isPlainObject(entry)) return;
    const identity = normalizedEvidenceUrlIdentity(entry.url);
    if (!identity) return;
    if (seen.has(identity)) {
      errors.push(`字段“${path}”中的文章身份必须唯一，至少需要2个独立来源：第${seen.get(identity) + 1}项与第${index + 1}项指向同一篇文章，追踪参数或fragment不能充当新来源。`);
    } else {
      seen.set(identity, index);
    }
  });
}

const OUTPUT_VALIDATORS = Object.freeze([
  (value, errors) => {
    validateMinimumText(value.briefing, 'briefing', errors, MINIMUM_TEXT.trendBriefing);
    validateObjectArray(value.channel_scan, 'channel_scan', errors, {
      channel: minimumTextField(MINIMUM_TEXT.label),
      finding: (finding, path, targetErrors) => {
        if (isNoSignalFinding(finding)) return true;
        return validateMinimumText(finding, path, targetErrors, MINIMUM_TEXT.detail);
      },
    }, { min: MINIMUM_ITEMS.channelScan });
    validateUniqueObjectField(value.channel_scan, 'channel_scan', errors, 'channel');
    validateObjectArray(value.topics, 'topics', errors, {
      title: minimumTextField(MINIMUM_TEXT.title),
      angle: minimumTextField(MINIMUM_TEXT.title),
      hook: minimumTextField(10),
      reason: minimumTextField(MINIMUM_TEXT.rationale),
      heat: STRING_FIELD,
      evidence: minimumTextField(8),
    }, { exact: 5 });
    validateUniqueObjectField(value.topics, 'topics', errors, 'title');
  },
  (value, errors) => {
    validateMinimumText(value.summary, 'summary', errors, MINIMUM_TEXT.researchSummary);
    validateStringArray(value.facts, 'facts', errors, {
      min: MINIMUM_ITEMS.facts,
      itemMin: MINIMUM_TEXT.detail,
    });
    validateUniqueStrings(value.facts, 'facts', errors);
    validateStringArray(value.data_points, 'data_points', errors, {
      min: MINIMUM_ITEMS.dataPoints,
      itemMin: MINIMUM_TEXT.detail,
    });
    validateUniqueStrings(value.data_points, 'data_points', errors);
    validateStringArray(value.viewpoints, 'viewpoints', errors, {
      min: MINIMUM_ITEMS.viewpoints,
      itemMin: MINIMUM_TEXT.detail,
    });
    validateUniqueStrings(value.viewpoints, 'viewpoints', errors);
    validateObjectArray(value.source_coverage, 'source_coverage', errors, {
      channel: minimumTextField(MINIMUM_TEXT.label),
      got: minimumTextField(10),
    }, { min: MINIMUM_ITEMS.sourceCoverage });
    validateUniqueObjectField(value.source_coverage, 'source_coverage', errors, 'channel');
    validateObjectArray(value.sources, 'sources', errors, {
      title: minimumTextField(MINIMUM_TEXT.title),
      url: validateHttpUrl,
    }, { min: MINIMUM_ITEMS.sources });
    validateUniqueEvidenceUrlIdentities(value.sources, 'sources', errors);
  },
  (value, errors) => {
    validateObjectArray(value.benchmarks, 'benchmarks', errors, {
      title: minimumTextField(MINIMUM_TEXT.title),
      platform: minimumTextField(MINIMUM_TEXT.label),
      account: minimumTextField(MINIMUM_TEXT.label),
      dimensions: validateDimensions,
      why_hot: minimumTextField(MINIMUM_TEXT.rationale),
    }, { min: 3, max: 5 });
    validateUniqueObjectFields(
      value.benchmarks,
      'benchmarks',
      errors,
      ['platform', 'account', 'title'],
    );
    validateStringArray(value.comment_insights, 'comment_insights', errors, {
      min: MINIMUM_ITEMS.insightLists,
      itemMin: MINIMUM_TEXT.detail,
    });
    validateUniqueStrings(value.comment_insights, 'comment_insights', errors);
    validateStringArray(value.user_language, 'user_language', errors, {
      min: MINIMUM_ITEMS.insightLists,
      itemMin: MINIMUM_TEXT.label,
    });
    validateUniqueStrings(value.user_language, 'user_language', errors);
    validateStringArray(value.takeaways, 'takeaways', errors, {
      min: MINIMUM_ITEMS.insightLists,
      itemMin: MINIMUM_TEXT.detail,
    });
    validateUniqueStrings(value.takeaways, 'takeaways', errors);
  },
  (value, errors) => {
    validateStringArray(value.title_candidates, 'title_candidates', errors, {
      min: 3,
      max: 5,
      itemMin: MINIMUM_TEXT.title,
    });
    validateUniqueStrings(value.title_candidates, 'title_candidates', errors);
    validateMinimumText(value.body, 'body', errors, MINIMUM_TEXT.article);
    validateSegmentedMarkdown(value.body, 'body', errors);
    validateTagArray(value.tags, 'tags', errors, { min: 5, max: 8 });
    validateObjectArray(value.image_plan, 'image_plan', errors, {
      slot: minimumTextField(MINIMUM_TEXT.label),
      desc: minimumTextField(MINIMUM_TEXT.detail),
    }, { min: 2, max: 4 });
    validateUniqueObjectField(value.image_plan, 'image_plan', errors, 'slot');
  },
  (value, errors) => {
    validateMinimumText(value.body, 'body', errors, MINIMUM_TEXT.article);
    validateSegmentedMarkdown(value.body, 'body', errors);
    validateStringArray(value.title_candidates, 'title_candidates', errors, {
      exact: 3,
      itemMin: MINIMUM_TEXT.title,
    });
    validateUniqueStrings(value.title_candidates, 'title_candidates', errors);
    validateMinimumText(
      value.consistency_note,
      'consistency_note',
      errors,
      MINIMUM_TEXT.consistencyNote,
    );
  },
  (value, errors, context = {}) => {
    validateObjectArray(value.images, 'images', errors, {
      slot: minimumTextField(MINIMUM_TEXT.label),
      desc: minimumTextField(MINIMUM_TEXT.detail),
      platform: minimumTextField(MINIMUM_TEXT.label),
      svg: validateSvg,
    }, { min: requestedMediaImageCount(context), max: 4 });
    validateUniqueObjectField(value.images, 'images', errors, 'slot');
  },
  (value, errors) => {
    validateObjectArray(value.covers, 'covers', errors, {
      style: minimumTextField(MINIMUM_TEXT.label),
      platform: minimumTextField(MINIMUM_TEXT.label),
      size: minimumTextField(MINIMUM_TEXT.title),
      html: (html, path, targetErrors) => {
        targetErrors.push(...validateCompleteHtml(html, path, {
          minLength: MINIMUM_TEXT.coverHtml,
          minBodyTextLength: 30,
        }));
      },
    }, { exact: MINIMUM_ITEMS.covers });
    validateUniqueObjectField(value.covers, 'covers', errors, 'style');
  },
  (value, errors) => {
    validateMinimumText(value.summary, 'summary', errors, MINIMUM_TEXT.deckSummary);
    errors.push(...validateCompleteHtml(value.html, 'html', {
      minLength: MINIMUM_TEXT.deckHtml,
      minBodyTextLength: 80,
    }));
  },
  (value, errors, context = {}) => {
    const requestedPlatforms = requestedPublishPlatforms(context);
    validateObjectArray(value.versions, 'versions', errors, {
      platform: minimumTextField(MINIMUM_TEXT.label),
      title: minimumTextField(MINIMUM_TEXT.title),
      body: (body, path, targetErrors) => {
        validateMinimumText(body, path, targetErrors, MINIMUM_TEXT.platformBody);
        validateSegmentedMarkdown(body, path, targetErrors);
      },
      tags: (tags, path, targetErrors) => validateTagArray(tags, path, targetErrors, {
        min: MINIMUM_ITEMS.versionTags,
        max: 8,
      }),
      best_time: minimumTextField(3),
      checklist: (items, path, targetErrors) => (
        validateStringArray(items, path, targetErrors, {
          min: 2,
          max: 4,
          itemMin: MINIMUM_TEXT.title,
        })
      ),
      note: minimumTextField(MINIMUM_TEXT.detail),
    }, requestedPlatforms
      ? { min: requestedPlatforms.length, max: requestedPlatforms.length * 3 }
      : { exact: MINIMUM_ITEMS.versions });
    if (requestedPlatforms && Array.isArray(value.versions)) {
      value.versions.forEach((version, index) => {
        const platform = version?.platform;
        if (typeof platform === 'string' && !requestedPlatforms.includes(platform)) {
          errors.push(`字段“versions[${index}].platform”的平台“${platform}”未在任务书请求平台中。`);
        }
      });
      requestedPlatforms.forEach((platform) => {
        if (!value.versions.some(version => version?.platform === platform)) {
          errors.push(`字段“versions”缺少请求平台“${platform}”的主发布包。`);
        }
      });
    } else {
      validateUniqueObjectField(value.versions, 'versions', errors, 'platform');
    }
    validateMinimumText(value.publish_plan, 'publish_plan', errors, MINIMUM_TEXT.deckSummary);
  },
  (value, errors) => {
    validateMinimumText(value.report, 'report', errors, MINIMUM_TEXT.retrospectiveReport);
    validateMaximumText(value.report, 'report', errors, MAXIMUM_TEXT.retrospectiveReport);
    validateSegmentedMarkdown(value.report, 'report', errors);
    validateObjectArray(value.next_topics, 'next_topics', errors, {
      title: textRangeField(MINIMUM_TEXT.title, MAXIMUM_TEXT.retrospectiveTopicTitle),
      reason: textRangeField(MINIMUM_TEXT.detail, MAXIMUM_TEXT.retrospectiveTopicReason),
    }, { min: MINIMUM_ITEMS.nextTopics, max: 5 });
    validateUniqueObjectField(value.next_topics, 'next_topics', errors, 'title');
    validateStringArray(value.profile_updates, 'profile_updates', errors, {
      min: 0,
      max: 5,
      itemMin: MINIMUM_TEXT.detail,
      itemMax: MAXIMUM_TEXT.retrospectiveProfileUpdate,
    });
  },
]);

const FACT_CONTEXT_MISSING_RE = /(?:未(?:提供|给出|说明|填写|确认|核验|知|确定|补充)|尚未(?:提供|给出|说明|填写|确认|核验|确定)|没有(?:提供|给出|说明|填写|确认|核验|确定)|未知|不详|暂无|待[^，,。！？!?;；\n]{0,18}(?:确认|补充|核验|提供|填写|补齐)|缺(?:失|少)|无法(?:确认|确定|提供|核验)|不能(?:确认|确定)|不确定|(?:需要|需|须)(?:在)?(?:发布前)?补齐|发布前(?:需要|需|须)?补齐)/u;

const MISSING_FACT_DEFINITIONS = Object.freeze([
  {
    key: 'booking_link',
    label: '预约/报名链接',
    terms: /(?:预约|报名|下单|购买)(?:链接|网址|URL|二维码|入口)/iu,
  },
  {
    key: 'phone',
    label: '联系电话',
    terms: /(?:联系电话|电话|手机号码|手机号|热线|联系方式)/u,
  },
  {
    key: 'address',
    label: '门店地址',
    terms: /(?:门店地址|地址|门店位置|到店位置|定位)/u,
  },
  {
    key: 'price',
    label: '价格/金额',
    terms: /(?:价格|售价|价目|金额|费用|客单价|人均)/u,
  },
  {
    key: 'discount',
    label: '折扣/优惠',
    terms: /(?:折扣|优惠|满减|促销|活动价|特价)/u,
  },
  {
    key: 'inventory',
    label: '库存/限量',
    terms: /(?:库存|存量|数量|限量|余量|现货)/u,
  },
  {
    key: 'gift',
    label: '赠品/赠送',
    terms: /(?:赠品|赠送|礼品|伴手礼|附赠)/u,
  },
]);

const BEST_TIME_TERMS_RE = /(?:历史(?:最佳|最优)?发布(?:时间|时段)|最佳发布(?:时间|时段)|账号历史(?:发布)?数据|发布(?:时间|时段))/u;
const PENDING_CONFIRMATION_RE = /(?:待[^，,。！？!?;；\n]{0,18}(?:确认|核验|补齐|提供)|(?:未|尚未|无法|不能)[^，,。！？!?;；\n]{0,18}(?:确认|核验|确定|提供)|未知|不详|暂无)/u;
const TIME_OR_NUMBER_RE = /(?:[0-9０-９零〇一二两三四五六七八九十百千万半]|工作日|周末|星期[一二三四五六日天]|周[一二三四五六日天]|早上|上午|中午|下午|晚上|凌晨|黄金时段|高峰(?:期|时段)?)/u;
const TIME_QUANTITY_RE = /(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半]+)(?:\s*(?:-|--|–|—|~|～|至|到)\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半]+))?\s*(?:秒钟?|分钟|小时|钟头|天|日|周|星期|个月|月)/giu;
const ASSERTION_NEGATION_RE = /(?:不得|禁止|不要|不可|不能|不应|避免|未经确认不得)(?:[^。！？!?;；\n]{0,18})$/u;

const BOOKING_URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'）)，,。；;]+/iu;
const BOOKING_CUE_RE = /(?:预约|报名|下单|购买|订座|订餐|扫码|点击|入口|链接)/u;
const MOBILE_RE = /(?:\+?86[\s-]?)?1[3-9]\d(?:[\s-]?\d){8}/u;
const LANDLINE_RE = /(?:0\d{2,3}[\s-]?)?\d{7,8}/u;
const PHONE_CUE_RE = /(?:联系|电话|热线|致电|手机|咨询)/u;
const ADDRESS_RE = /(?:(?:[\p{Script=Han}]{2,}(?:省|市|区|县|镇|乡|街道)){2,}.{0,36}(?:(?<!思|线|套|出|回|电|网)路|街|巷|(?<!渠|味|知|报|说|通|赛)道|号|楼|层|室|广场|中心)|(?:地址|位于|导航至|门店在).{0,48}(?:(?<!思|线|套|出|回|电|网)路|街|巷|(?<!渠|味|知|报|说|通|赛)道|号|楼|层|室|广场|中心))/u;
const PRICE_RE = /(?:[¥￥$]\s*\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s*(?:元|块钱|人民币))/u;
const DISCOUNT_RE = /(?:(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半]+)\s*折|满\s*\d+\s*(?:元)?\s*减\s*\d+|立减\s*(?:[¥￥])?\s*\d+|第(?:二|2)件半价|买[一二两三四五六七八九十\d]+送[一二两三四五六七八九十\d]+|全场(?:特价|优惠)|(?:限时|会员|新客|到店|下单)优惠)/u;
const INVENTORY_RE = /(?:仅剩|剩余\s*\d+|库存(?:充足|紧张|告急|有货)|现货(?:供应|在售|充足)|限量(?:\s*\d+|\s*(?:份|件|套|个|名)|供应|发售|开放|抢购)|售完即止|先到先得|数量有限|限购)/u;
const GIFT_RE = /(?:赠送\s*[^\s，,、/。！？!?;；]{1,20}|附赠\s*[^\s，,、/。！？!?;；]{1,20}|到店送\s*[^\s，,、/。！？!?;；]{1,20}|免费送\s*[^\s，,、/。！？!?;；]{1,20}|赠品(?:为|是|包含)\s*[^\s，,、/。！？!?;；]{1,20}|礼品(?:为|是|包含)\s*[^\s，,、/。！？!?;；]{1,20}|买.{0,12}送.{1,12})/u;
const FACT_QUESTION_RE = /(?:有没有|是否|是不是|有无|能否|可否|会不会|要不要|吗\s*$|[？?])/u;
const GIFT_CONDITIONAL_RE = /(?:如果|若|假如|倘若|如有|一旦)[^。！？!?;；\n]{0,48}(?:赠送|附赠|到店送|免费送|赠品|礼品)/u;
const GIFT_CONFIRMED_EVENT_RE = /(?:(?:已|已经|现已|本次|此次|实际|确实|当天|当日|今日|昨日|刚刚|累计|共计|总计)[^。！？!?;；\n]{0,12}(?:赠送|附赠|到店送|免费送)|(?:赠送|附赠|到店送|免费送)[^。！？!?;；\n]{0,24}(?:已完成|完成了|成功|发生了?))/u;
const GIFT_PROCEDURAL_RE = /(?:核验|核对|复核|查明|排查|检查|审计|待核验|待确认|建议|应当|应该|需要|需|须|分类|分开|分别|单列|独立统计|归类|拆分|区分|统计口径|归集口径|核算口径|待核验清单|待确认清单)/u;
const PRODUCT_QUALITY_SUBJECT_SOURCE = '(?:每(?:一)?道|菜品|菜肴|套餐|产品|食材|肉质|汤底|汤汁|口感|口味|味道|风味|香气|香味|余味|回味|入口|吃起来|喝起来|闻起来|味觉体验|品质|水准|火候|烹饪|制作|工艺|出品)';
const PRODUCT_QUALITY_PREDICATE_SOURCE = '(?:招牌水准|好吃|美味|鲜香|鲜嫩|多汁|入口即化|浓郁|香辣|过瘾|扑鼻|绵长|绝佳|很绝|真绝|太绝|绝了|惊艳|很棒|超棒|优秀|上乘|新鲜|地道|正宗|稳定|有保障|令人放心|醇厚|层次丰富|层次分明|恰到好处|有记忆点|难忘|食欲大开)';
const PRODUCT_QUALITY_CLAIM_RE = new RegExp(
  `(?:${PRODUCT_QUALITY_SUBJECT_SOURCE}[^，,。！？!?;；\\n]{0,20}${PRODUCT_QUALITY_PREDICATE_SOURCE}|(?:入口)?鲜香|鲜嫩多汁|入口即化|香辣过瘾|(?:余味|回味)(?:十分|非常|格外)?绵长|层次(?:丰富|分明)|品质令人放心|(?:真的|确实|简直)(?:很|超|特别|非常)?(?:好吃|美味|绝|绝了|惊艳)|出品(?:始终|一直|依然|依旧|很|非常|相当|稳定|都)?在线)`,
  'u',
);
const CUSTOMER_PREFERENCE_CLAIM_RE = /(?:(?:食客|顾客|消费者|用户|大家|人人|所有人|客人)[^，,。！？!?;；\n]{0,18}(?:一定|肯定|自然|都会?|会|更会)?[^，,。！？!?;；\n]{0,10}(?:喜欢|满意|爱上|回购|推荐|夸(?:值|好吃|划算)|一致认可)|(?:闭眼入|放心入|冲就对了|不会错|绝不踩雷|值得(?:一试|推荐|购买|打卡)|不容错过|一口上瘾|让人上瘾|吃过都说好|回头客(?:很多|多)|一致认可|复购率爆表)|(?:让人|令人)[^，,。！？!?;；\n]{0,8}(?:垂涎|回味无穷|忍不住下单|上瘾))/u;
const PRODUCT_PRODUCTION_CLAIM_RE = /(?:(?:现做现卖|现点现做|每日现做|当天(?:熬制|制作|现做)|正宗做法)|(?:全部|全都|一律|均|只)?(?:使用|选用)[^，,。！？!?;；\n]{0,8}(?:精选|优质|新鲜|当季|天然)(?:食材|原料)|(?:精选|优质|新鲜|当季|天然)(?:食材|原料)|(?:零添加|无添加|不含添加剂|纯手工(?:制作)?|手工现做|手工制作))/u;
const HEALTH_NUTRITION_CLAIM_RE = /(?:低脂(?:又)?健康|营养丰富|老少皆宜|减脂(?:(?:也可|也|可)?放心|(?:人群)?首选)|零糖零脂|无麸质|无过敏原|糖尿病(?:人|患者)?(?:(?:也可|也|可)?放心(?:吃)?|(?:也可|也|可)吃)|孕妇(?:和|与|、)?儿童(?:(?:都|也|可)?放心|(?:都|也|可)?能吃)|孕妇放心|儿童放心)/u;
const SAFETY_CERTIFICATION_CLAIM_RE = /(?:权威认证|安全卫生|安全放心|清真(?:认证)?|有机认证|农残(?:通过|已经|已)?检测|国家(?:食品?|食安)(?:安全)?标准|符合国家(?:食品?|食安)(?:安全)?标准)/u;
const ORIGIN_SUPPLY_CHAIN_CLAIM_RE = /(?:真材实料|绝无预制(?:菜)?|绝非预制(?:菜)?|绝不使用预制(?:菜)?|不是预制(?:菜)?|原产地(?:直供)?|产地直供|(?:食材|原料)来自本地|本地(?:食材|原料)|全程冷链(?:配送)?|冷链配送)/u;
const AWARD_RANKING_CLAIM_RE = /(?:米其林(?:推荐|品质)|百年(?:老店|老字号)|非遗(?:品牌|技艺)|全市销量第一|本地(?:唯一|独家)|销量冠军|销量第一|排名第一|全城第一)/u;
const VALUE_COMPARISON_CLAIM_RE = /(?:性价比(?:超|很|非常|特别)?高|全城性价比最高|全城最划算|全市最划算|同城最划算|全城最低价|全市最低价|比周边(?:门店|餐厅|店家)?都便宜)/u;
const WRITER_FACT_CLAIM_DEFINITIONS = Object.freeze([
  {
    key: 'experience',
    label: '亲历/体验背书',
    pattern: /(?:(?:我|我们|本人|小编|编辑|团队)(?:已经|已|曾经|曾|刚刚|亲自|实际)?(?:替[^，,。！？!?;；\n]{1,8})?(?:试过|尝过|吃过|喝过|用过|体验过|到店体验过|打卡过)|(?:亲测|实测|亲自(?:试吃|体验|品尝|到店)))/u,
  },
  {
    key: 'quality',
    label: '产品品质/口味',
    pattern: PRODUCT_QUALITY_CLAIM_RE,
  },
  {
    key: 'preference',
    label: '顾客偏好/推荐',
    pattern: CUSTOMER_PREFERENCE_CLAIM_RE,
  },
  {
    key: 'production',
    label: '制作/食材/配方',
    pattern: PRODUCT_PRODUCTION_CLAIM_RE,
  },
  {
    key: 'health',
    label: '健康营养/特殊人群适用',
    pattern: HEALTH_NUTRITION_CLAIM_RE,
  },
  {
    key: 'safety_certification',
    label: '食安/认证/合规',
    pattern: SAFETY_CERTIFICATION_CLAIM_RE,
  },
  {
    key: 'origin_supply_chain',
    label: '食材来源/供应链/非预制',
    pattern: ORIGIN_SUPPLY_CHAIN_CLAIM_RE,
  },
  {
    key: 'award_ranking',
    label: '奖项/历史/排名/唯一性',
    pattern: AWARD_RANKING_CLAIM_RE,
  },
  {
    key: 'value_comparison',
    label: '价格价值/竞品比较',
    pattern: VALUE_COMPARISON_CLAIM_RE,
  },
  {
    key: 'portion',
    label: '分量/适用人数',
    pattern: /(?:(?:分量|份量)[^，,。！？!?;；\n]{0,16}(?:刚好|正好|十足|很足|足够|实在|管饱|够吃|偏多|偏少|适合[^，,。！？!?;；\n]{0,6}(?:人|个人))|(?:两|二|2)(?:个)?人[^，,。！？!?;；\n]{0,14}(?:刚好|正好|够吃|吃饱|吃完(?:全|完)?没问题|完全没问题|没问题))/u,
  },
  {
    key: 'environment',
    label: '环境/氛围/服务体验',
    pattern: /(?:环境|氛围|空间|装修|卫生|服务)[^，,。！？!?;；\n]{0,14}(?:超棒|很好|很棒|不错|舒适|安静|宽敞|干净|温馨|高级|有氛围|贴心|周到|一流)/u,
  },
  {
    key: 'occasion',
    label: '消费场景适配',
    pattern: /(?:很|非常|特别|更|也)?适合(?:约会|聚会|闺蜜|情侣|亲子|家庭|朋友|商务|宴请|小聚|团建|周末犒劳|两人|二人)/u,
    evidencePattern: /(?:(?:目标|核心)(?:人群|客群|受众)|面向)[^，,。！？!?;；\n]{0,28}(?:约会|聚会|闺蜜|情侣|亲子|家庭|朋友|商务|宴请|小聚|团建|周末犒劳|两人|二人)/u,
  },
  {
    key: 'popularity',
    label: '热度/客流/拥挤',
    pattern: /(?:(?:(?:周末|平时|门店|现场|店里|这家店)?(?:人|客人|顾客|客流))[^，,。！？!?;；\n]{0,10}(?:超多|很多|爆满|拥挤|排满|络绎不绝)|(?:人气|热度)[^，,。！？!?;；\n]{0,10}(?:很高|超高|火爆|爆棚)|(?:经常|总是|周末|天天|每天)[^，,。！？!?;；\n]{0,10}(?:排队|爆满|满座|很快售罄|迅速售罄)|(?:不用|无需|不必|免|不会|绝不)[^，,。！？!?;；\n]{0,4}排队|一位难求|座无虚席|排长队|抢不到位)/u,
  },
  {
    key: 'booking',
    label: '预约渠道/可预约/锁位',
    pattern: /(?:(?:现在|当前|本周末|周末|随时)?(?:就)?(?:可以|可|能|支持|接受|开放)[^，,。！？!?;；\n]{0,16}(?:预约|订座|订位)|(?:私信|电话|扫码|点击链接)[^，,。！？!?;；\n]{0,12}(?:即可|可以|可)?(?:预约|订座|订位)|(?:预约|订座|订位)(?:渠道|通道|入口|名额|时段)[^，,。！？!?;；\n]{0,12}(?:开放|可用|充足|已开|有位)|(?:现在|当前|周末)?(?:还有|有|剩余)[^，,。！？!?;；\n]{0,6}(?:空位|座位|席位|名额|双人位)|(?:锁定|预留|保留)[^，,。！？!?;；\n]{0,12}(?:位|座|名额|时段)|(?:一定要|记得|赶紧|马上|立即|现在就)[^，,。！？!?;；\n]{0,10}(?:提前)?(?:预约|订座|订位))/u,
    evidencePattern: /(?:(?:(?:目标|目的)(?:动作)?|行动号召|CTA|引导|要求(?:正文)?)[^，,。！？!?;；\n]{0,24}(?:到店)?(?:预约|订座|订位)|(?:正文|文案)[^，,。！？!?;；\n]{0,18}(?:要有|需要|必须有|明确)[^，,。！？!?;；\n]{0,10}(?:预约|订座|订位)(?:动作|引导|CTA)?)/iu,
  },
  {
    key: 'limited',
    label: '限定/稀缺性',
    pattern: /(?:(?:周末|工作日|今日|当天|本周|本月|季节|节日)限定(?:供应|发售|上新|开放|套餐|菜品|口味|名额|时段|席位|快乐|体验)?|(?:仅限|只限|限于)(?:周末|今日|当天|本周|本月|[^，,。！？!?;；\n]{0,8}(?:供应|发售|开放))|(?:每天|天天|经常|总是)?[^，,。！？!?;；\n]{0,8}(?:很快|迅速)?售罄|(?:晚来|来晚了)[^，,。！？!?;；\n]{0,8}(?:吃不到|买不到|没有了))/u,
  },
]);
const WRITER_FACT_BOUNDARY_RE = /(?:待[^，,。！？!?;；\n]{0,18}(?:确认|核验|补齐|提供)|(?:未|尚未|无法|不能)[^，,。！？!?;；\n]{0,18}(?:确认|核验|确定|提供)|发布前[^，,。！？!?;；\n]{0,24}(?:补齐|确认|核验)|(?:不得|禁止|不可|不应|避免|不(?:声称|写成|作为|下结论))|未经[^，,。！？!?;；\n]{0,18}(?:确认|核验)|待验证假设|仅供实验)/u;
const WRITER_BOOKING_CONDITIONAL_RE = /(?:如需|若需|如果需要|若要)[^，,。！？!?;；\n]{0,12}(?:预约|订座|订位)/u;
const WRITER_BOOKING_PROCEDURAL_RE = /(?:(?:检查项|核对项|待办|待补清单|发布清单)[^。！？!?;；\n]{0,56}(?:确认|核验|补齐|咨询)[^。！？!?;；\n]{0,16}(?:预约|订座|订位)(?:渠道|方式|入口)|(?:请|需|须|需要|应当)[^。！？!?;；\n]{0,16}(?:确认|核验|补齐|咨询)[^。！？!?;；\n]{0,16}(?:预约|订座|订位)(?:渠道|方式|入口))/u;
const DERIVED_AMOUNT_PERMISSION_RE = /(?:(?:只|仅)(?:可|能|允许)?|明确(?:允许|可以)|允许)(?:[^。！？!?;；\n]{0,16})(?:基于|依据|使用)(?:上述|这些|已知|已提供|输入(?:中)?(?:已)?提供的?)[^。！？!?;；\n]{0,12}(?:数字|数值|金额|数据)(?:进行)?(?:计算|推导)/u;
const PERCENT_RE = /(?:(?:百分之)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*[%％])/u;
const LABELED_QUANTITY_RE = /(?:订单(?:数|量)?|订单量|单量|销量|销售量|成交量|数量|件数|份数|人数|桌数|杯数|瓶数|门店数)\s*(?:为|是|共|合计|累计|[:：])?\s*(\d[\d,]*(?:\.\d+)?)/u;
const UNIT_QUANTITY_RE = /(\d[\d,]*(?:\.\d+)?)\s*(?:单|笔|份|件|个|人|桌|杯|瓶|套|家|店|次|公斤|千克|斤|克)(?![元块钱人民币])/u;
const RETROSPECTIVE_METRIC_TERM_SOURCE = [
  '(?:完播|互动|收藏|转发|点赞|评论|点击|打开|停留|跳出|转化|咨询|线索|到店|成交|阅读|播放|曝光)(?:率|量|数)?(?:指标)?(?:权重)?',
  '(?:行业|账号|历史|平台)(?:均值|平均值?|基准|达标线|阈值)',
  '(?:指标)?(?:权重|基准|达标线|阈值|目标值)',
].join('|');
const RETROSPECTIVE_PERCENT_RE = /(?:(?:百分之)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:[%％]|个百分点))/giu;
const RETROSPECTIVE_SCALAR_RE = new RegExp(
  `(${RETROSPECTIVE_METRIC_TERM_SOURCE})\\s*(?:的)?\\s*(?:目标(?:值)?|阈值|达标线|基准|均值|平均值?|权重)?\\s*(?:为|是|设为|定为|达到|超过|超|不低于|不高于|至少|至多|>=|<=|>|<|≥|≤|[:：])\\s*(\\d+(?:\\.\\d+)?)\\s*(条|次|个|人|笔|份|点)?`,
  'giu',
);
const RETROSPECTIVE_PLATFORM_RE = /(?:微信)?视频号|抖音|小红书|微信公众号|公众号|快手|B站|哔哩哔哩|微博|知乎|各平台|平台/iu;
const RETROSPECTIVE_PLATFORM_RULE_RE = /(?:最新)?算法|(?:推荐|流量|分发|排序)(?:机制|逻辑|规则)?|权重(?:变化|调整|规则)?|平台规则|单列|四维得分|得分|评分|更看重|优先级/u;
const RETROSPECTIVE_METRIC_RELATION_RE = new RegExp(
  `(?:${RETROSPECTIVE_METRIC_TERM_SOURCE})\\s*(?:高于|低于|优于|弱于|大于|小于|不低于|不高于|≥|≤|>|<)\\s*(?:${RETROSPECTIVE_METRIC_TERM_SOURCE})`,
  'iu',
);
const RETROSPECTIVE_INDUSTRY_GENERALIZATION_RE = /(?:(?:根据|基于)?(?:餐饮(?:实体)?门店|餐饮行业|行业)[^\n。！？!?;；]{0,30}(?:普遍|通常|一般|往往|多数|共性|规律|共识|特点)|(?:普遍|通常|一般|往往|多数|大多)[^\n。！？!?;；]{0,40}(?:高于|低于|优于|弱于|更高|更低|更好|更差|提升|降低|增加|减少))/u;
const RETROSPECTIVE_CAUSAL_RE = /(?:可|会|能|能够|有助于|有利于|促使|促进|必然|一定会|直接|往往能|通常能)[^\n。！？!?;；]{0,12}(?:显著)?(?:提升|提高|增加|增长|延长|改善|降低|减少|带动)/u;
const RETROSPECTIVE_STRONG_HYPOTHESIS_RE = /(?:待验证假设|实验假设|仅供实验|仅作为实验|只作为实验|仅作为假设|只作为假设)/u;
const RETROSPECTIVE_VERIFICATION_RE = /(?:需|需要|须|待)(?:来源|数据|实验|平台|负责人)?(?:核验|验证|查证)|尚待验证|尚无证据/u;
const RETROSPECTIVE_NON_CONCLUSION_RE = /不(?:作为|视为|写成|直接形成|直接下|用作)[^\n。！？!?;；]{0,16}结论|不能[^\n。！？!?;；]{0,12}下结论|不直接下结论|只列为[^\n。！？!?;；]{0,12}(?:查证项|待验证项|实验项)/u;
const RETROSPECTIVE_UNSUPPORTED_EVIDENCE_RE = /(?:未|尚未|尚无|没有|无法|不能)[^\n。！？!?;；]{0,18}(?:提供|确认|核验|证明|支持|作为结论)|(?:禁止|不得|不应)[^\n。！？!?;；]{0,18}(?:使用|复述|引用|写成结论)/u;
const RETROSPECTIVE_PROHIBITION_RE = new RegExp(
  [
    '(?:不(?:提供|给出|写|写入|复述|引用|采用|使用|声称|形成|作为|视为)|未(?:提供|给出|写入|形成)|不得|禁止|避免)',
    '[^\n。！？!?;；，,]{0,32}',
    '(?:平台(?:算法|权重|规则|机制|比较)?|算法|权重|流量规则|行业(?:规律|普遍结论|特点)?|效果因果|因果结论|效果结论|达标结论)',
    '|',
    '(?:平台(?:算法|权重|规则|机制)?|行业(?:规律|普遍结论)?|效果因果|因果结论)',
    '[^\n。！？!?;；，,]{0,24}',
    '(?:不|不得|不能|未)(?:作为|视为|写成|形成|用作)[^\n。！？!?;；，,]{0,12}结论',
  ].join(''),
  'u',
);
const MAX_DERIVED_MONEY_VALUES = 64;
const MAX_KNOWN_QUANTITIES = 32;
const DERIVED_MONEY_DIFFERENCE_ROUNDS = 2;

function appendGroundingStrings(value, target, depth = 0) {
  if (depth > 4 || value == null) return;
  if (typeof value === 'string') {
    if (value.trim()) target.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 20).forEach(item => appendGroundingStrings(item, target, depth + 1));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of ['title', 'snippet', 'summary', 'text', 'body', 'content', 'note']) {
    if (Object.hasOwn(value, key)) appendGroundingStrings(value[key], target, depth + 1);
  }
  if (Object.hasOwn(value, 'results')) appendGroundingStrings(value.results, target, depth + 1);
}

function factContextText(context) {
  if (!isPlainObject(context)) return '';
  const parts = [];
  for (const value of [
    context.title,
    context.requirement,
    context.feedback,
    context.material,
    context.sourceMaterial,
    context.providedMaterial,
    context.providedMaterials,
    context.trustedEvidence,
    context.trustedWebEvidence,
    context.publicationMetrics,
  ]) appendGroundingStrings(value, parts);
  if (context.web?.verified === true) appendGroundingStrings(context.web.results, parts);
  if (context.webEvidence?.verified === true) appendGroundingStrings(context.webEvidence.results, parts);
  return parts.join('\n').trim();
}

function explicitlyMissing(text, terms) {
  return text.split(/[。！？!?;；\n]+/u).some(clause => (
    terms.test(clause) && FACT_CONTEXT_MISSING_RE.test(clause)
  ));
}

function collectStringEntries(value, path = '$', target = []) {
  if (typeof value === 'string') {
    target.push({ path, text: value });
    return target;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStringEntries(entry, `${path}[${index}]`, target));
    return target;
  }
  if (isPlainObject(value)) {
    Object.entries(value).forEach(([key, entry]) => (
      collectStringEntries(entry, path === '$' ? key : `${path}.${key}`, target)
    ));
  }
  return target;
}

function authoredContentEntries(idx, parsed) {
  return idx >= 3 && idx <= 8 ? collectStringEntries(parsed) : [];
}

function visibleMarkupText(value) {
  return String(value || '')
    .replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)\s*>/giu, ' ')
    .replace(/<!--[^]*?-->/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&(?:nbsp|ensp|emsp|thinsp);/giu, ' ')
    .replace(/&#(?:x[0-9a-f]+|[0-9]+);?/giu, '字')
    .replace(/\s+/gu, ' ')
    .trim();
}

function outwardMarketingContentEntries(idx, parsed) {
  const entries = [];
  const add = (path, text) => {
    if (typeof text === 'string' && text.trim()) entries.push({ path, text: text.trim() });
  };
  if (idx === 3 || idx === 4) {
    add('body', parsed?.body);
    if (Array.isArray(parsed?.title_candidates)) {
      parsed.title_candidates.forEach((title, index) => add(`title_candidates[${index}]`, title));
    }
    if (idx === 3 && Array.isArray(parsed?.image_plan)) {
      parsed.image_plan.forEach((item, index) => add(`image_plan[${index}].desc`, item?.desc));
    }
  } else if (idx === 5 && Array.isArray(parsed?.images)) {
    parsed.images.forEach((item, index) => {
      add(`images[${index}].desc`, item?.desc);
      add(`images[${index}].svg`, visibleMarkupText(item?.svg));
    });
  } else if (idx === 6 && Array.isArray(parsed?.covers)) {
    parsed.covers.forEach((item, index) => add(
      `covers[${index}].html`,
      visibleHtmlBodyText(item?.html),
    ));
  } else if (idx === 7) {
    add('summary', parsed?.summary);
    add('html', visibleHtmlBodyText(parsed?.html));
  } else if (idx === 8 && Array.isArray(parsed?.versions)) {
    parsed.versions.forEach((version, index) => {
      add(`versions[${index}].title`, version?.title);
      add(`versions[${index}].body`, version?.body);
      if (Array.isArray(version?.checklist)) {
        version.checklist.forEach((item, itemIndex) => (
          add(`versions[${index}].checklist[${itemIndex}]`, item)
        ));
      }
      add(`versions[${index}].note`, version?.note);
    });
    add('publish_plan', parsed?.publish_plan);
  }
  return entries;
}

function writerFactClaimIsNonAssertive(raw, definition) {
  if (FACT_QUESTION_RE.test(raw) || WRITER_FACT_BOUNDARY_RE.test(raw)) return true;
  if (definition.key === 'quality'
    && /(?:写作|文章|正文|内容|结构|表达|叙事|信息|逻辑)[^，,。！？!?;；\n]{0,12}(?:层次丰富|层次分明|有记忆点)/u.test(raw)) {
    return true;
  }
  return definition.key === 'booking'
    && (WRITER_BOOKING_CONDITIONAL_RE.test(raw)
      || WRITER_BOOKING_PROCEDURAL_RE.test(raw));
}

const WRITER_FACT_SUPPORT_TOKENS = Object.freeze({
  experience: Object.freeze([
    ['experienced', /(?:试过|尝过|吃过|喝过|用过|体验过|到店体验过|打卡过|亲测|实测|试吃|品尝)/u],
  ]),
  quality: Object.freeze([
    ['signature_quality', /招牌水准/u],
    ['tasty', /(?:好吃|美味)/u],
    ['excellent', /(?:绝佳|很绝|真绝|绝了?|惊艳)/u],
    ['great', /(?:很棒|超棒|优秀|上乘)/u],
    ['fresh', /新鲜/u],
    ['authentic', /(?:地道|正宗)/u],
    ['stable', /(?:稳定|有保障)/u],
    ['aromatic', /(?:鲜香|(?:香气|香味)(?:十分|非常|格外)?扑鼻|入口鲜香)/u],
    ['aftertaste', /(?:余味|回味)(?:十分|非常|格外)?绵长/u],
    ['mellow', /醇厚/u],
    ['layered_texture', /(?:口感)?(?:层次)?(?:十分|非常|格外)?(?:丰富|分明)/u],
    ['cooking_quality', /(?:火候|烹饪|制作|工艺)[^，,。！？!?;；\n]{0,10}恰到好处/u],
    ['reassuring', /(?:令人放心|有保障)/u],
    ['memorable', /(?:有记忆点|难忘)/u],
    ['appetizing', /食欲大开/u],
    ['tender', /(?:鲜嫩|入口即化)/u],
    ['juicy', /多汁/u],
    ['rich_flavor', /(?:浓郁|香辣|过瘾)/u],
    ['output_online', /出品(?:始终|一直|依然|依旧|很|非常|相当|稳定|都)?在线/u],
  ]),
  preference: Object.freeze([
    ['liked', /(?:喜欢|满意|爱上|一致认可|夸(?:值|好吃|划算)|一口上瘾|让人上瘾|吃过都说好|回头客(?:很多|多))/u],
    ['repurchase', /(?:回购|复购率爆表)/u],
    ['recommended', /(?:推荐|值得一试|值得购买|值得打卡|不容错过)/u],
    ['blind_buy', /(?:闭眼入|放心入|冲就对了|不会错|绝不踩雷)/u],
    ['desire', /(?:垂涎|回味无穷|忍不住下单)/u],
  ]),
  production: Object.freeze([
    ['freshly_made', /(?:现做现卖|现点现做|每日现做|当天现做)/u],
    ['same_day', /当天(?:熬制|制作)/u],
    ['selected_ingredients', /(?:精选|优质|新鲜|当季|天然)(?:食材|原料)/u],
    ['no_additives', /(?:零添加|无添加|不含添加剂)/u],
    ['handmade', /(?:纯手工(?:制作)?|手工现做|手工制作)/u],
    ['authentic_method', /正宗做法/u],
  ]),
  health: Object.freeze([
    ['low_fat_healthy', /低脂(?:又)?健康/u],
    ['nutritious', /营养丰富/u],
    ['all_ages', /老少皆宜/u],
    ['weight_loss', /减脂(?:(?:也可|也|可)?放心|(?:人群)?首选)/u],
    ['zero_sugar_fat', /零糖零脂/u],
    ['gluten_free', /无麸质/u],
    ['allergen_free', /无过敏原/u],
    ['diabetes_safe', /糖尿病(?:人|患者)?(?:(?:也可|也|可)?放心(?:吃)?|(?:也可|也|可)吃)/u],
    ['pregnant_children_safe', /(?:孕妇(?:和|与|、)?儿童(?:(?:都|也|可)?放心|(?:都|也|可)?能吃)|孕妇放心|儿童放心)/u],
  ]),
  safety_certification: Object.freeze([
    ['authoritative_certification', /权威认证/u],
    ['safe_hygienic', /(?:安全卫生|安全放心)/u],
    ['halal', /清真(?:认证)?/u],
    ['organic', /有机认证/u],
    ['pesticide_test', /农残(?:通过|已经|已)?检测/u],
    ['food_safety_standard', /(?:国家(?:食品?|食安)(?:安全)?标准|符合国家(?:食品?|食安)(?:安全)?标准)/u],
  ]),
  origin_supply_chain: Object.freeze([
    ['real_ingredients', /真材实料/u],
    ['not_prepared', /(?:绝无预制(?:菜)?|绝非预制(?:菜)?|绝不使用预制(?:菜)?|不是预制(?:菜)?)/u],
    ['origin', /(?:原产地(?:直供)?|产地直供|(?:食材|原料)来自本地|本地(?:食材|原料))/u],
    ['cold_chain', /(?:全程冷链(?:配送)?|冷链配送)/u],
  ]),
  award_ranking: Object.freeze([
    ['michelin', /米其林(?:推荐|品质)/u],
    ['century_old', /百年(?:老店|老字号)/u],
    ['heritage', /非遗(?:品牌|技艺)/u],
    ['top_sales', /(?:全市销量第一|销量冠军|销量第一)/u],
    ['unique_local', /本地(?:唯一|独家)/u],
    ['top_rank', /(?:排名第一|全城第一)/u],
  ]),
  value_comparison: Object.freeze([
    ['high_value', /(?:性价比(?:超|很|非常|特别)?高|全城性价比最高)/u],
    ['best_deal', /(?:全城最划算|全市最划算|同城最划算)/u],
    ['lowest_price', /(?:全城最低价|全市最低价)/u],
    ['cheaper_than_nearby', /比周边(?:门店|餐厅|店家)?都便宜/u],
  ]),
  portion: Object.freeze([
    ['just_right', /(?:刚好|正好)/u],
    ['plentiful', /(?:十足|很足|足够|实在|管饱|够吃|吃完(?:全|完)?没问题|完全没问题|没问题)/u],
    ['more', /偏多/u],
    ['less', /偏少/u],
    ['fit_people', /适合[^，,。！？!?;；\n]{0,6}(?:人|个人)/u],
  ]),
  environment: Object.freeze([
    ['great', /(?:超棒|很好|很棒|不错)/u],
    ['comfortable', /舒适/u],
    ['quiet', /安静/u],
    ['spacious', /宽敞/u],
    ['clean', /干净/u],
    ['warm', /温馨/u],
    ['premium', /高级/u],
    ['atmosphere', /有氛围/u],
    ['attentive', /(?:贴心|周到|一流)/u],
  ]),
  occasion: Object.freeze([
    ['dating', /(?:约会|情侣)/u],
    ['friends', /(?:聚会|闺蜜|朋友|小聚)/u],
    ['family', /(?:亲子|家庭)/u],
    ['business', /(?:商务|宴请|团建)/u],
    ['weekend_reward', /周末犒劳/u],
    ['two_people', /(?:两人|二人)/u],
  ]),
  popularity: Object.freeze([
    ['crowded', /(?:超多|很多|爆满|拥挤|排满|络绎不绝|火爆|爆棚|排队|满座|售罄|一位难求|座无虚席|排长队|抢不到位)/u],
    ['weekend', /周末/u],
  ]),
  booking: Object.freeze([
    ['private_message', /私信/u],
    ['phone', /(?:电话|致电|热线)/u],
    ['scan', /(?:扫码|二维码)/u],
    ['link', /(?:点击链接|链接|网址)/u],
    ['available', /(?:可以|可|能|支持|接受|开放|可用|充足|已开|有位|有(?:空位|座位|席位|名额|双人位)|剩余)/u],
    ['cta', /(?:(?:一定要|记得|赶紧|马上|立即|现在就(?!\s*(?:可以|可|能|支持|接受|开放)))[^，,。！？!?;；\n]{0,10}(?:提前)?(?:预约|订座|订位)|(?:目标|目的)(?:动作)?[^，,。！？!?;；\n]{0,18}(?:到店)?(?:预约|订座|订位)|(?:行动号召|CTA|引导|明确预约动作)[^，,。！？!?;；\n]{0,12}(?:预约|订座|订位)?)/iu],
    ['locked', /(?:锁定|预留|保留)/u],
    ['weekend', /周末/u],
    ['workday', /工作日/u],
  ]),
  limited: Object.freeze([
    ['limited', /(?:限定|仅限|只限|限于|售罄|吃不到|买不到|没有了)/u],
    ['weekend', /周末/u],
    ['workday', /工作日/u],
    ['today', /(?:今日|当天)/u],
    ['this_week', /本周/u],
    ['this_month', /本月/u],
    ['seasonal', /(?:季节|节日)/u],
  ]),
});

function writerFactSupportTokenSet(definition, text) {
  return new Set((WRITER_FACT_SUPPORT_TOKENS[definition.key] || [])
    .filter(([, pattern]) => pattern.test(text))
    .map(([token]) => token));
}

function normalizedWriterFactText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[#>*_`\s，,。！？!?;；：:"'“”‘’()[\]{}【】～~]/gu, '')
    .toLowerCase();
}

function writerFactEvidenceSupportsClaim(definition, claim, evidence) {
  const normalizedClaim = normalizedWriterFactText(claim);
  const normalizedEvidence = normalizedWriterFactText(evidence);
  if (normalizedClaim.length >= 4 && normalizedEvidence.length >= 4
    && (normalizedEvidence.includes(normalizedClaim)
      || normalizedClaim.includes(normalizedEvidence))) return true;
  const required = writerFactSupportTokenSet(definition, claim);
  if (!required.size) return false;
  const provided = writerFactSupportTokenSet(definition, evidence);
  return [...required].every(token => provided.has(token));
}

const VERIFIED_FACT_SECTION_RE = /(?:已核验(?:事实|信息|证据)?|经核验(?:确认)?|已确认(?:事实|信息|证据)?|经确认|事实白名单|确认事实|门店(?:已经|已)?确认|任务书(?:已经|已)?确认|带来源的已核验事实)\s*[：:]?\s*([^。！？!?\n]+)/giu;

function appendExplicitVerifiedFactSections(value, target) {
  if (typeof value !== 'string' || !value.trim()) return;
  for (const match of value.matchAll(VERIFIED_FACT_SECTION_RE)) {
    const section = String(match[1] || '').trim();
    if (section) target.push(section);
  }
}

function writerVerifiedFactText(context) {
  const normalized = typeof context === 'string' ? { requirement: context } : context;
  if (!isPlainObject(normalized)) return '';
  const parts = [];
  for (const value of [
    normalized.title,
    normalized.requirement,
    normalized.feedback,
    normalized.material,
    normalized.sourceMaterial,
    normalized.providedMaterial,
    normalized.providedMaterials,
  ]) {
    if (Array.isArray(value)) value.forEach(item => appendExplicitVerifiedFactSections(item, parts));
    else appendExplicitVerifiedFactSections(value, parts);
  }
  appendGroundingStrings(normalized.trustedEvidence, parts);
  appendGroundingStrings(normalized.trustedWebEvidence, parts);
  if (normalized.web?.verified === true) appendGroundingStrings(normalized.web.results, parts);
  if (normalized.webEvidence?.verified === true) {
    appendGroundingStrings(normalized.webEvidence.results, parts);
  }
  return parts.join('\n').trim();
}

function directiveEvidenceClauses(context, definition) {
  if (!definition.evidencePattern) return [];
  return factContextText(typeof context === 'string' ? { requirement: context } : context)
    .split(/[。！？!?;；，,\n]+/u)
    .map(clause => clause.trim())
    .filter(clause => (
      clause
      && !FACT_CONTEXT_MISSING_RE.test(clause)
      && !WRITER_FACT_BOUNDARY_RE.test(clause)
      && definition.evidencePattern.test(clause)
    ));
}

function writerFactEvidenceClauses(context, definition) {
  const verifiedClauses = writerVerifiedFactText(context)
    .split(/[。！？!?;；，,\n]+/u)
    .map(clause => clause.trim())
    .filter(clause => (
      clause
      && !FACT_CONTEXT_MISSING_RE.test(clause)
      && !WRITER_FACT_BOUNDARY_RE.test(clause)
      && definition.pattern.test(clause)
    ));
  return [...verifiedClauses, ...directiveEvidenceClauses(context, definition)];
}

function writerQualitativeFactClaims(idx, parsed, context) {
  const claims = [];
  for (const entry of outwardMarketingContentEntries(idx, parsed)) {
    for (const match of entry.text.matchAll(/[^，,\n。！？!?;；]+(?:[，,\n。！？!?;；]|$)/gu)) {
      const raw = match[0].trim().replace(/[，,\n。！？!?;；]+$/gu, '');
      if (!raw) continue;
      for (const definition of WRITER_FACT_CLAIM_DEFINITIONS) {
        if (!definition.pattern.test(raw)
          || writerFactClaimIsNonAssertive(raw, definition)) continue;
        if (writerFactEvidenceClauses(context, definition)
          .some(evidence => writerFactEvidenceSupportsClaim(definition, raw, evidence))) continue;
        claims.push({ path: entry.path, raw: raw.slice(0, 180), label: definition.label });
      }
    }
  }
  return claims;
}

/**
 * 给只读历史质量审计复用同一套撰稿事实门禁。
 *
 * 调用方若要持久化结果，必须只保存 label/path 等脱敏类别，不能保存 raw 原句。
 */
export function findUnsupportedWriterMarketingFactClaims(body, context = {}) {
  if (typeof body !== 'string' || !body.trim()) return [];
  const normalizedContext = typeof context === 'string'
    ? { requirement: context }
    : context;
  return writerQualitativeFactClaims(
    3,
    { body },
    normalizedContext,
  ).map(claim => ({ ...claim }));
}

function validateMarketingQualitativeFactGrounding(idx, parsed, context, errors) {
  for (const claim of writerQualitativeFactClaims(idx, parsed, context)) {
    const gate = idx === 3 ? '撰稿事实门禁' : '内容事实门禁';
    errors.push(`${gate}：字段“${claim.path}”将“${claim.raw}”写成了任务输入或已核验证据未支持的${claim.label}事实；请删除该断言，或改写为发布前待确认/待核验项。`);
    if (errors.length >= 24) break;
  }
}

function validateRequiredStationInputs(idx, context, errors) {
  if (!isPlainObject(context) || context.enforceRequiredInputs !== true) return;
  const text = [
    context.title,
    context.requirement,
    context.feedback,
    ...(Array.isArray(context.attachments)
      ? context.attachments.map(item => `${item?.name || ''}\n${item?.content || ''}`)
      : []),
  ].filter(Boolean).join('\n');
  if (idx === 4) {
    const missingDraft = /(?:暂无|尚无|未|没有|并未|尚未|缺少|缺失|无法)(?:提供|取得|拿到|读取|确认)?[^，,。！？!?;；\n]{0,16}(?:完整)?(?:原稿|初稿|正文|撰稿人产出)/u.test(text);
    const missingPersona = /(?:暂无|尚无|未|没有|并未|尚未|缺少|缺失|无法)(?:提供|取得|拿到|读取|确认)?[^，,。！？!?;；\n]{0,16}(?:账号)?(?:人设|文风|语气规则|参考样文)/u.test(text);
    // 原稿往往是多段 Markdown，不能只看标签后的同一行。同时只截取到
    // 下一个明确输入标签，避免“完整原稿：暂无”借后续长任务说明凑够长度。
    const draftSection = text.match(
      /(?:待改写(?:完整)?(?:原稿|正文)|完整原稿|撰稿人产出|初稿正文|原文)[：:]\s*([\s\S]*?)(?=\n(?:账号人设(?:档案)?|人设档案|文风|语气规则|参考样文|必须保留的事实|禁用词|发布边界)[：:]|$)/u,
    )?.[1] || '';
    const hasDraft = [...draftSection.replace(/\s+/gu, '')].length >= 40;
    const hasPersona = /(?:账号)?人设(?:档案)?[：:]?[^\n]{4,}|(?:文风|语气规则|参考样文|禁用词)[：:]?[^\n]{4,}/u.test(text);
    if (missingDraft || missingPersona || !hasDraft || !hasPersona) {
      errors.push('工位必需输入门禁：文风师必须同时取得待改写的完整原稿和账号人设/语气规则；当前任务缺少真实上游输入，只能退回补料，不能形成可采纳交付。');
    }
  }
  if (idx === 9) {
    const hasPublishedContent = /(?:发布记录|已发布内容|发布批次|内容ID|content[_ -]?id|工位9·分发官产出)/iu.test(text);
    const hasRealMetric = /(?:播放|阅读|曝光|完播|互动|收藏|转发|点赞|评论|点击|打开|停留|跳出|转化|咨询|线索|到店|成交)(?:率|量|数)?[^，,。！？!?;；\n]{0,12}(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万亿]+)/u.test(text);
    if (!hasPublishedContent || !hasRealMetric) {
      errors.push('工位必需输入门禁：复盘官缺少真实发布记录和至少一项发布后效果指标；本轮只能形成数据采集计划，不能作为已完成复盘被采纳。');
    }
  }
  if (idx >= 3 && idx <= 9) {
    const completionBlocker = authoredContentEntries(idx, context.outputForCompletionGate || {})
      .find(entry => /(?:无法|不能|未能)(?:生成|完成|改写|交付|形成)[^，,。！？!?;；\n]{0,24}|非最终交付|(?:字段|正文|内容|原稿|人设)[^，,。！？!?;；\n]{0,10}待补充|仅(?:能|可)?(?:提供|输出|形成)[^，,。！？!?;；\n]{0,18}(?:框架|说明|占位|待办清单)/u.test(entry.text));
    if (completionBlocker) {
      errors.push(`任务完成度门禁：字段“${completionBlocker.path}”明确表示无法完成、非最终交付或仍为待补占位，不能作为本岗位已完成产物被采纳。`);
    }
  }
}

function webAttributionContextPresent(context) {
  return isPlainObject(context)
    && (Object.hasOwn(context, 'web') || Object.hasOwn(context, 'webEvidence'));
}

function verifiedWebAttributionSources(context) {
  if (!isPlainObject(context)) return [];
  const evidence = context.web?.verified === true
    ? context.web
    : context.webEvidence?.verified === true
      ? context.webEvidence
      : null;
  if (!evidence || !Array.isArray(evidence.results)) return [];
  return evidence.results.map((item, index) => {
    const title = String(item?.title || '').trim();
    const url = String(item?.url || '').trim();
    const snippet = String(item?.snippet || '').trim();
    if (!title || !normalizedEvidenceUrlIdentity(url)) return null;
    return {
      id: String(item?.sourceId || `来源${index + 1}`).trim(),
      title,
      url,
      snippet,
      searchable: normalizedWriterFactText(`${title}\n${snippet}\n${url}`),
    };
  }).filter(Boolean);
}

function escapedPattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function citedWebSources(value, sources) {
  const textValue = String(value || '');
  const normalized = normalizedWriterFactText(textValue);
  return sources.filter(source => {
    const idPattern = new RegExp(`(?:\\[${escapedPattern(source.id)}\\]|${escapedPattern(source.id)})`, 'iu');
    if (idPattern.test(textValue) || textValue.includes(source.url)) return true;
    const title = normalizedWriterFactText(source.title);
    return title.length >= 6 && normalized.includes(title);
  });
}

const EXTERNAL_QUANTITY_RE = /(?:\d+(?:\.\d+)?\s*(?:[%％]|个百分点|万|亿|千|百)\s*(?:粉丝?|播放(?:量)?|阅读(?:量)?|点赞|收藏|转发|评论|曝光|浏览|增长|上涨|下降|提升|降低|次|人|个)?|[零〇一二两三四五六七八九十百千万亿]+\s*(?:粉丝?|播放(?:量)?|阅读(?:量)?|点赞|收藏|转发|评论|曝光|浏览|次))/gu;

const RESEARCH_QUALITATIVE_CLAIM_DEFINITIONS = Object.freeze([
  {
    label: '成本趋势',
    pattern: /(?:(?:全国|行业|餐饮|门店)?[^，,。！？!?;；\n]{0,10}成本[^，,。！？!?;；\n]{0,12}(?:持续)?(?:上涨|上升|增长|走高|下降|降低|回落)|(?:上涨|上升|增长|走高|下降|降低|回落)[^，,。！？!?;；\n]{0,10}成本)/u,
    tokens: [
      ['cost', /成本/u],
      ['rise', /(?:上涨|上升|增长|走高)/u],
      ['fall', /(?:下降|降低|回落)/u],
      ['nationwide', /全国/u],
    ],
  },
  {
    label: '消费者口味偏好',
    pattern: /(?:(?:顾客|消费者|食客|用户)[^，,。！？!?;；\n]{0,20}(?:偏爱|喜欢|爱吃|一致认可)[^，,。！？!?;；\n]{0,12}(?:甜味|甜口|辣味|辣口|咸味|酸味)|(?:甜味|甜口|辣味|辣口|咸味|酸味)[^，,。！？!?;；\n]{0,12}(?:最受欢迎|更受欢迎|偏好))/u,
    tokens: [
      ['audience', /(?:顾客|消费者|食客|用户)/u],
      ['preference', /(?:偏爱|喜欢|爱吃|一致认可|最受欢迎|更受欢迎|偏好)/u],
      ['sweet', /(?:甜味|甜口)/u],
      ['spicy', /(?:辣味|辣口)/u],
      ['salty', /咸味/u],
      ['sour', /酸味/u],
    ],
  },
  {
    label: '爆款/全平台热度',
    pattern: /(?:(?:话题|内容|案例|选题|行业)[^，,。！？!?;；\n]{0,18}(?:全平台)?(?:爆发|爆火|爆款|火爆)|全平台[^，,。！？!?;；\n]{0,8}(?:爆发|爆火|火爆))/u,
    tokens: [
      ['all_platforms', /全平台/u],
      ['viral', /(?:爆发|爆火|爆款|火爆)/u],
    ],
  },
  {
    label: '客流/到店增长',
    pattern: /(?:(?:晚市|午市|客流|到店|顾客|食客)[^，,。！？!?;；\n]{0,20}(?:增长|上涨|激增|暴增|大量到店|明显增加)|(?:大量|明显更多)[^，,。！？!?;；\n]{0,8}(?:顾客)?到店)/u,
    tokens: [
      ['traffic', /(?:晚市|午市|客流|到店|顾客|食客)/u],
      ['increase', /(?:增长|上涨|激增|暴增|大量|明显增加|明显更多)/u],
    ],
  },
  {
    label: '经营效果因果',
    pattern: /(?:带动|促进|导致|实现|显著提升)[^，,。！？!?;；\n]{0,14}(?:转化|到店|成交|销量|客流)/u,
    tokens: [
      ['causal', /(?:带动|促进|导致|实现|显著提升)/u],
      ['outcome', /(?:转化|到店|成交|销量|客流)/u],
    ],
  },
]);

function researchQualitativeTokenSet(definition, value) {
  return new Set(definition.tokens
    .filter(([, pattern]) => pattern.test(String(value || '')))
    .map(([token]) => token));
}

function externalQuantityTokens(value) {
  const withoutReferences = String(value || '')
    .replace(/\[?来源\s*\d+\]?/giu, ' ')
    .replace(/https?:\/\/[^\s，,。！？!?;；]+/giu, ' ');
  return [...withoutReferences.matchAll(EXTERNAL_QUANTITY_RE)]
    .map(match => normalizedWriterFactText(match[0]))
    .filter(Boolean);
}

const RESEARCH_DISCLOSURE_SUBJECT_RE = /(?:数据|资料|记录|指标|信息|证据|来源|样本|原文|凭证|口径|数值|事实|结论|判断|账号历史内容)/u;
const RESEARCH_DISCLOSURE_ACTION_RE = /^(?:应|需|需要|建议|后续|下一步|请|由|将|待|发布前|取得[^]{0,24}后)[^]{0,80}(?:取数|核验|核对|复核|确认|补齐|补充|提供|导出|收集|列入|记录|暂停|不(?:作|下|写入|声称))/u;

/**
 * 只豁免“整项都在说证据缺口”的条目。
 *
 * 不能因为一段已有结论的文字末尾出现“待核验”，就跳过整段引用与
 * 证据支持校验。先拒绝带具体数量或已知高风险定性断言的文字，再要求每个
 * 分句都是明确的缺证说明或其直接后续动作。
 */
function entirelyUnverifiableResearchItem(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (externalQuantityTokens(text).length) return false;
  if (RESEARCH_QUALITATIVE_CLAIM_DEFINITIONS.some(definition => definition.pattern.test(text))) {
    return false;
  }
  if (isNoSignalFinding(text)) return true;
  if (/(?:无可验证事实|不含可验证事实|整项待核验|本项仅为待核验项)/u.test(text)) return true;

  const clauses = text
    .replace(/\[来源[^\]]+\]/gu, ' ')
    .split(/[，,。！？!?;；\n]+/u)
    .map(clause => clause.trim())
    .filter(Boolean);
  return clauses.length > 0 && clauses.every(clause => (
    (RESEARCH_DISCLOSURE_SUBJECT_RE.test(clause)
      && (FACT_CONTEXT_MISSING_RE.test(clause) || WRITER_FACT_BOUNDARY_RE.test(clause)))
    || RESEARCH_DISCLOSURE_ACTION_RE.test(clause)
  ));
}

function validateAttributedResearchText(path, value, sources, errors, { account = '' } = {}) {
  if (typeof value !== 'string' || !value.trim() || entirelyUnverifiableResearchItem(value)) return;
  const cited = citedWebSources(value, sources);
  if (!cited.length) {
    errors.push(`联网证据归因：字段“${path}”必须逐项引用本次已验证检索快照中的[来源N]、来源标题或URL。`);
    return;
  }
  const supportedQuantities = new Set(cited.flatMap(source => (
    externalQuantityTokens(`${source.title}\n${source.snippet}`)
  )));
  const unsupportedQuantity = externalQuantityTokens(value)
    .find(quantity => !supportedQuantities.has(quantity));
  if (unsupportedQuantity) {
    errors.push(`联网证据归因：字段“${path}”中的数量“${unsupportedQuantity}”其引用的检索快照未支持。`);
  }
  const citedEvidenceText = cited.map(source => `${source.title}\n${source.snippet}`).join('\n');
  for (const clause of String(value).split(/[。！？!?;；\n]+/u).map(item => item.trim()).filter(Boolean)) {
    for (const definition of RESEARCH_QUALITATIVE_CLAIM_DEFINITIONS) {
      if (!definition.pattern.test(clause)) continue;
      const required = researchQualitativeTokenSet(definition, clause);
      const supported = researchQualitativeTokenSet(definition, citedEvidenceText);
      if ([...required].every(token => supported.has(token))) continue;
      errors.push(`联网证据归因：字段“${path}”中的${definition.label}定性断言“${clause.slice(0, 120)}”未被其引用的检索快照支持。`);
    }
  }
  const normalizedAccount = normalizedWriterFactText(account);
  if (normalizedAccount && !cited.some(source => source.searchable.includes(normalizedAccount))) {
    errors.push(`联网证据归因：字段“${path}”中的账号“${String(account).slice(0, 80)}”未出现在其引用的检索快照中。`);
  }
}

function finalResearchSources(parsedSources, verifiedSources) {
  if (!Array.isArray(parsedSources)) return [];
  return verifiedSources.filter(source => parsedSources.some(item => (
    exactEvidenceUrl(item?.url) === exactEvidenceUrl(source.url)
    && exactEvidenceTitle(item?.title) === exactEvidenceTitle(source.title)
  )));
}

function validateResearchSourceClosure(path, value, verifiedSources, deliveredSources, errors) {
  const deliveredIds = new Set(deliveredSources.map(source => source.id));
  const omitted = citedWebSources(value, verifiedSources)
    .find(source => !deliveredIds.has(source.id));
  if (!omitted) return;
  errors.push(`联网证据归因：字段“${path}”引用了“${omitted.id}”，但该来源未出现在最终sources清单中。`);
}

function exactEvidenceUrl(value) {
  return String(value || '').trim();
}

function exactEvidenceTitle(value) {
  return String(value || '').trim();
}

function validateWebEvidenceAttribution(idx, parsed, context, errors) {
  if (idx < 0 || idx > 2 || !webAttributionContextPresent(context)) return;
  const sources = verifiedWebAttributionSources(context);
  if (!sources.length) {
    errors.push('联网证据归因：本次没有已验证检索快照，趋势官、情报员和拆解师不得交付外部事实、来源或对标结论。');
    return;
  }
  if (idx === 0) {
    validateAttributedResearchText('briefing', parsed?.briefing, sources, errors);
    parsed?.channel_scan?.forEach((item, index) => {
      validateAttributedResearchText(`channel_scan[${index}].finding`, item?.finding, sources, errors);
    });
    parsed?.topics?.forEach((item, index) => {
      validateAttributedResearchText(`topics[${index}].evidence`, item?.evidence, sources, errors);
    });
    return;
  }
  if (idx === 1) {
    const deliveredSources = finalResearchSources(parsed?.sources, sources);
    const validateResearchItem = (path, value) => {
      validateAttributedResearchText(path, value, sources, errors);
      validateResearchSourceClosure(path, value, sources, deliveredSources, errors);
    };
    validateResearchItem('summary', parsed?.summary);
    parsed?.facts?.forEach((item, index) => validateResearchItem(`facts[${index}]`, item));
    parsed?.data_points?.forEach((item, index) => {
      validateResearchItem(`data_points[${index}]`, item);
    });
    parsed?.viewpoints?.forEach((item, index) => {
      validateResearchItem(`viewpoints[${index}]`, item);
    });
    parsed?.source_coverage?.forEach((item, index) => {
      validateResearchItem(`source_coverage[${index}].got`, item?.got);
    });
    parsed?.sources?.forEach((item, index) => {
      const url = exactEvidenceUrl(item?.url);
      const title = exactEvidenceTitle(item?.title);
      const matched = sources.some(source => (
        exactEvidenceUrl(source.url) === url
        && exactEvidenceTitle(source.title) === title
      ));
      if (!matched) {
        errors.push(`联网证据归因：字段“sources[${index}]”不是本次已验证检索快照的子集，禁止补造来源标题或URL。`);
      }
    });
    return;
  }
  parsed?.benchmarks?.forEach((item, index) => {
    const combined = [
      item?.title,
      item?.platform,
      item?.account,
      ...Object.values(isPlainObject(item?.dimensions) ? item.dimensions : {}),
      item?.why_hot,
    ].filter(Boolean).join('；');
    validateAttributedResearchText(
      `benchmarks[${index}]`,
      combined,
      sources,
      errors,
      { account: item?.account },
    );
  });
}

function matcherFor(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

function negatedBefore(text, index) {
  return ASSERTION_NEGATION_RE.test(text.slice(Math.max(0, index - 36), index));
}

function matchesForPattern(text, pattern, cue = null) {
  const matches = [];
  const matcher = matcherFor(pattern);
  let match;
  while ((match = matcher.exec(text)) !== null) {
    const surrounding = text.slice(
      Math.max(0, match.index - 48),
      Math.min(text.length, match.index + match[0].length + 48),
    );
    if ((!cue || cue.test(surrounding)) && !negatedBefore(text, match.index)) {
      matches.push({ raw: match[0], index: match.index });
    }
    if (!match[0]) matcher.lastIndex += 1;
  }
  return matches;
}

function sentenceAt(text, index) {
  const before = text.slice(0, index);
  const startMatch = [...before.matchAll(/[。！？!?;；\n]/gu)].at(-1);
  const start = startMatch ? startMatch.index + startMatch[0].length : 0;
  const after = text.slice(index);
  const endOffset = after.search(/[。！？!?;；\n]/u);
  const end = endOffset === -1 ? text.length : index + endOffset + 1;
  return text.slice(start, end);
}

function normalizedRetrospectiveMetric(value) {
  const metric = String(value || '').replace(/\s+/gu, '');
  const weight = /权重/u.test(metric) ? ':权重' : '';
  const aliases = [
    [/完播/u, '完播率'],
    [/互动/u, '互动率'],
    [/收藏/u, '收藏率'],
    [/转发/u, '转发率'],
    [/点赞/u, '点赞率'],
    [/评论/u, '评论率'],
    [/点击/u, '点击率'],
    [/打开/u, '打开率'],
    [/停留/u, '停留率'],
    [/跳出/u, '跳出率'],
    [/转化/u, '转化率'],
    [/咨询/u, '咨询率'],
    [/线索/u, '线索率'],
    [/到店/u, '到店率'],
    [/成交/u, '成交率'],
    [/阅读/u, '阅读指标'],
    [/播放/u, '播放指标'],
    [/曝光/u, '曝光指标'],
  ];
  for (const [pattern, normalized] of aliases) {
    if (pattern.test(metric)) return `${normalized}${weight}`;
  }
  if (/(?:行业|账号|历史|平台)(?:均值|平均|基准|达标线|阈值)/u.test(metric)) {
    return '通用基准';
  }
  if (/权重/u.test(metric)) return '通用权重';
  if (/(?:基准|达标线|阈值|目标值)/u.test(metric)) return '通用阈值';
  return '未标注指标';
}

function retrospectiveMetricNear(text, index) {
  const start = Math.max(0, index - 64);
  const end = Math.min(text.length, index + 64);
  const window = text.slice(start, end);
  const matcher = new RegExp(RETROSPECTIVE_METRIC_TERM_SOURCE, 'giu');
  let closest = null;
  for (const match of window.matchAll(matcher)) {
    const absoluteStart = start + match.index;
    const absoluteEnd = absoluteStart + match[0].length;
    const distance = index < absoluteStart
      ? absoluteStart - index
      : index > absoluteEnd
        ? index - absoluteEnd
        : 0;
    if (!closest || distance < closest.distance) closest = { raw: match[0], distance };
  }
  return normalizedRetrospectiveMetric(closest?.raw);
}

function normalizedMetricNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : '';
}

function retrospectiveMetricClaims(value) {
  const claims = [];
  for (const entry of collectStringEntries(value)) {
    const percentMatcher = matcherFor(RETROSPECTIVE_PERCENT_RE);
    let percentMatch;
    while ((percentMatch = percentMatcher.exec(entry.text)) !== null) {
      const number = normalizedMetricNumber(percentMatch[1] || percentMatch[2]);
      if (number) {
        claims.push({
          path: entry.path,
          metric: retrospectiveMetricNear(entry.text, percentMatch.index),
          value: `percent:${number}`,
          raw: percentMatch[0],
        });
      }
      if (!percentMatch[0]) percentMatcher.lastIndex += 1;
    }

    const scalarMatcher = matcherFor(RETROSPECTIVE_SCALAR_RE);
    let scalarMatch;
    while ((scalarMatch = scalarMatcher.exec(entry.text)) !== null) {
      const after = entry.text.slice(scalarMatcher.lastIndex).trimStart();
      if (!/^(?:[%％]|个百分点)/u.test(after)) {
        const number = normalizedMetricNumber(scalarMatch[2]);
        if (number) {
          claims.push({
            path: entry.path,
            metric: normalizedRetrospectiveMetric(scalarMatch[1]),
            value: `scalar:${number}:${scalarMatch[3] || ''}`,
            raw: `${scalarMatch[2]}${scalarMatch[3] || ''}`,
          });
        }
      }
      if (!scalarMatch[0]) scalarMatcher.lastIndex += 1;
    }
  }
  const unique = new Map();
  for (const claim of claims) {
    const key = `${claim.path}|${claim.metric}|${claim.value}`;
    if (!unique.has(key)) unique.set(key, claim);
  }
  return [...unique.values()];
}

function retrospectiveClaimSupported(claim, evidenceClaims) {
  return evidenceClaims.some(evidence => (
    evidence.value === claim.value
    && (
      evidence.metric === claim.metric
      || evidence.metric === '未标注指标'
      || claim.metric === '未标注指标'
    )
  ));
}

function retrospectiveQualitativeCategories(clause) {
  const categories = [];
  if (RETROSPECTIVE_PLATFORM_RE.test(clause) && RETROSPECTIVE_PLATFORM_RULE_RE.test(clause)) {
    categories.push('平台算法/权重/规则');
  }
  if (RETROSPECTIVE_PLATFORM_RE.test(clause) && RETROSPECTIVE_METRIC_RELATION_RE.test(clause)) {
    categories.push('平台指标比较规则');
  }
  if (RETROSPECTIVE_INDUSTRY_GENERALIZATION_RE.test(clause)) {
    categories.push('行业普遍规律');
  }
  if (RETROSPECTIVE_CAUSAL_RE.test(clause)) {
    categories.push('效果提升/降低因果');
  }
  return [...new Set(categories)];
}

function qualifiedRetrospectiveHypothesis(window) {
  if (RETROSPECTIVE_STRONG_HYPOTHESIS_RE.test(window)) return true;
  return RETROSPECTIVE_VERIFICATION_RE.test(window)
    && RETROSPECTIVE_NON_CONCLUSION_RE.test(window);
}

function normalizedQualitativeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[#>*_`\s，,。！？!?;；：:"'“”‘’()[\]{}【】]/gu, '')
    .toLowerCase();
}

function retrospectiveEvidenceClauses(contextText) {
  if (!contextText) return [];
  return [...contextText.matchAll(/[^\n。！？!?;；]+(?:[\n。！？!?;；]|$)/gu)]
    .map(match => match[0].trim())
    .filter(clause => clause && !FACT_CONTEXT_MISSING_RE.test(clause)
      && !RETROSPECTIVE_UNSUPPORTED_EVIDENCE_RE.test(clause));
}

function retrospectiveQualitativeSupported(claim, evidenceClauses) {
  const normalizedClaim = normalizedQualitativeText(claim.raw);
  if (normalizedClaim.length < 6) return false;
  return evidenceClauses.some(clause => {
    const normalizedEvidence = normalizedQualitativeText(clause);
    return normalizedEvidence.includes(normalizedClaim)
      || (normalizedEvidence.length >= 8 && normalizedClaim.includes(normalizedEvidence));
  });
}

function retrospectiveQualitativeClaims(parsed) {
  const claims = [];
  for (const entry of collectStringEntries(parsed)) {
    const matcher = /[^\n。！？!?;；]+(?:[\n。！？!?;；]|$)/gu;
    for (const match of entry.text.matchAll(matcher)) {
      const sentence = match[0].trim();
      if (!sentence) continue;
      const qualificationWindow = entry.text.slice(
        Math.max(0, match.index - 120),
        Math.min(entry.text.length, match.index + match[0].length),
      );
      for (const segmentMatch of sentence.matchAll(/[^，,]+(?:[，,]|$)/gu)) {
        const raw = segmentMatch[0].trim();
        if (!raw) continue;
        const categories = retrospectiveQualitativeCategories(raw);
        if (!categories.length) continue;
        // 仅豁免同一逗号分句内明确“不写/不提供/禁止/未形成”的边界陈述。
        // 同一句中的“待验证+不作为结论”仍可限定前置分句；但禁止性陈述
        // 不会豁免后续另一分句的肯定断言。“不低于”也不在禁止动词白名单内。
        if (RETROSPECTIVE_PROHIBITION_RE.test(raw)) continue;
        if (qualifiedRetrospectiveHypothesis(qualificationWindow)) continue;
        claims.push({
          path: entry.path,
          raw: raw.replace(/[\n。！？!?;；，,]+$/gu, '').slice(0, 180),
          categories,
        });
      }
    }
  }
  return claims;
}

function validateRetrospectiveQualitativeGrounding(parsed, contextText, errors) {
  const claims = retrospectiveQualitativeClaims(parsed);
  if (!claims.length) return;
  const evidenceClauses = retrospectiveEvidenceClauses(contextText);
  for (const claim of claims) {
    if (retrospectiveQualitativeSupported(claim, evidenceClauses)) continue;
    errors.push(`复盘定性事实门禁：字段“${claim.path}”将“${claim.raw}”写成了无来源的${claim.categories.join('、')}结论；如任务书、已提供资料或已核验联网证据不支持，必须删除，或明确标注为“待验证假设/仅供实验/需来源核验且不作为结论”。`);
    if (errors.length >= 24) break;
  }
}

function validateRetrospectiveMetricGrounding(parsed, contextText, errors) {
  validateRetrospectiveQualitativeGrounding(parsed, contextText, errors);
  const claims = retrospectiveMetricClaims(parsed);
  if (!claims.length) return;
  const evidenceClaims = contextText ? retrospectiveMetricClaims(contextText) : [];
  for (const claim of claims) {
    if (retrospectiveClaimSupported(claim, evidenceClaims)) continue;
    errors.push(`复盘指标事实门禁：字段“${claim.path}”给出了未在任务书、已提供资料或已核验联网证据中出现的${claim.metric}具体值“${claim.raw}”；请删除该数值，改为“待补历史基线”或“由负责人设定”。`);
    if (errors.length >= 24) break;
  }
}

function hasEvidencePayload(value) {
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.some(hasEvidencePayload);
  if (!isPlainObject(value)) return false;
  return Object.values(value).some(hasEvidencePayload);
}

const RETROSPECTIVE_NO_DATA_EXAMPLE = Object.freeze({
  report: [
    '# 发布后复盘计划（预测性，待真实回流校准）',
    '当前任务未提供可核验的发布记录、真实效果指标或历史基线，因此本轮按内容流水线产出发布后复盘计划与预测性分析；所有达标线均为待补历史基线、由负责人设定，不把技能卡数字写成已发生效果。',
    '## 指标计划',
    '- T+1：曝光或阅读、完播或停留、首屏互动；先确认已发布且可统计。',
    '- T+3：互动、收藏或在看、主页访问；与同类内容对比后再设基线。',
    '- T+7：咨询或到店线索、有效评论问题数；样本不足只记现象，不写因果。',
    '## 预测性分析（待验证假设，不作为结论）',
    '可能成立的优点：开头把经营问题写成可验证实验，结构清楚，便于老板照做。',
    '可能拖后腿的地方：缺现场实拍与真实结果，方法说明多、现场证据少。',
    '## 数据补齐',
    '由负责人从目标平台后台导出同一观察窗口的原始指标，对齐内容标识后再把预测改成结论。',
  ].join('\n\n'),
  next_topics: [
    { title: '现场验证怎么写成老板向短文', reason: '把可执行验证步骤做成下一轮内容，回流后再对照真实数据。' },
    { title: '套餐表达是否一眼看懂', reason: '验证顾客能不能快速理解组合与价格，适合下一轮内容实验。' },
    { title: '高峰承接压力测试日记', reason: '把接住或接不住写成可验证内容，避免只停留在方法说明。' },
  ],
  profile_updates: [],
});

export function retrospectiveNoDataFallbackOutput() {
  return structuredClone(RETROSPECTIVE_NO_DATA_EXAMPLE);
}

/**
 * 给首轮生成与契约返工共用的复盘事实边界。
 *
 * 没有真实指标或已核验来源时，按派活产出发布后复盘计划与预测性复盘；
 * 不得把技能卡数字、平台规则或行业阈值写成已发生效果。
 */
export function contentEmployeeContractGenerationGuidance(idx, context = {}) {
  if (Number(idx) !== 9) return { mode: 'standard', system: '', user: '' };
  const contextText = factContextText(context);
  const hasMetricEvidence = retrospectiveMetricClaims(contextText).length > 0;
  const hasVerifiedSource = (
    (context.web?.verified === true && hasEvidencePayload(context.web.results))
    || (context.webEvidence?.verified === true && hasEvidencePayload(context.webEvidence.results))
    || hasEvidencePayload(context.trustedEvidence)
    || hasEvidencePayload(context.trustedWebEvidence)
  );
  if (hasMetricEvidence || hasVerifiedSource) {
    return { mode: 'grounded_retrospective', system: '', user: '' };
  }

  const system = [
    '【复盘官无数据安全返工模式·最高事实优先级】',
    '当前任务无真实指标或已核验来源。按派活内容流水线产出发布后复盘计划与预测性复盘，不得把技能卡或行业数字写成已发生效果。',
    'report 必须包含 T+1/T+3/T+7 指标计划、标注为待验证假设的预测性分析，以及数据补齐说明。达标线只能写待补历史基线或由负责人设定。',
    '禁止复述历史技能中的平台算法、权重、评分公式、流量规则、行业规律、效果因果或具体阈值，并把它们写成当前事实；“待数据补全后执行”也不能作为复述这些说法的豁免。',
    `report 必须在${MINIMUM_TEXT.retrospectiveReport}-${MAXIMUM_TEXT.retrospectiveReport}个字符内；next_topics 必须是下一轮内容选题，不得改成纯取数任务；profile_updates 必须返回空数组。`,
  ].join('\n');
  const user = [
    '【无数据复盘输出模板】',
    '请按下列对象的语义和精简度输出合法 JSON，可根据任务主题改写预测分析与选题，但不得加入未核验的效果事实、平台规则或数值阈值。',
    JSON.stringify(RETROSPECTIVE_NO_DATA_EXAMPLE, null, 2),
    '最终只输出一个可解析 JSON 对象，字符串内换行必须正确转义，不得输出Markdown围栏、解释、前后缀或额外字段。',
  ].join('\n');
  return { mode: 'retrospective_no_data', system, user };
}

function isProceduralGiftMentionAt(text, index) {
  const sentence = sentenceAt(text, index).trim();
  if (FACT_QUESTION_RE.test(sentence)) return true;
  if (GIFT_CONDITIONAL_RE.test(sentence)) return true;
  // “建议记录：已赠送……”仍包含已发生的具体事实，不能被“建议”豁免。
  if (GIFT_CONFIRMED_EVENT_RE.test(sentence)) return false;
  return GIFT_PROCEDURAL_RE.test(sentence);
}

function concreteMatches(key, text) {
  if (key === 'booking_link') return matchesForPattern(text, BOOKING_URL_RE, BOOKING_CUE_RE);
  if (key === 'phone') {
    const mobile = matchesForPattern(text, MOBILE_RE);
    const landline = matchesForPattern(text, LANDLINE_RE, PHONE_CUE_RE);
    return [...mobile, ...landline].sort((left, right) => left.index - right.index);
  }
  if (key === 'address') return matchesForPattern(text, ADDRESS_RE);
  if (key === 'price') return matchesForPattern(text, PRICE_RE);
  if (key === 'discount') return matchesForPattern(text, DISCOUNT_RE);
  if (key === 'inventory') return matchesForPattern(text, INVENTORY_RE);
  if (key === 'gift') {
    return matchesForPattern(text, GIFT_RE)
      .filter(match => !isProceduralGiftMentionAt(text, match.index));
  }
  return [];
}

function normalizedConcreteValue(key, raw) {
  const normalized = String(raw || '').normalize('NFKC').trim();
  if (key === 'price') {
    const numeric = normalized.replace(/[^\d.]/gu, '');
    const amount = Number(numeric);
    if (!Number.isFinite(amount)) return '';
    const currency = /^\$/u.test(normalized) ? 'usd' : 'cny';
    return `${currency}:${amount.toFixed(2)}`;
  }
  if (key === 'phone') {
    const digits = normalized.replace(/\D/gu, '');
    return digits.startsWith('86') && digits.length === 13 ? digits.slice(2) : digits;
  }
  if (key === 'booking_link') {
    const withProtocol = /^www\./iu.test(normalized) ? `https://${normalized}` : normalized;
    try {
      const url = new URL(withProtocol);
      url.hash = '';
      return url.href.replace(/\/$/u, '').toLowerCase();
    } catch {
      return normalized.toLowerCase();
    }
  }
  if (key === 'address') {
    return normalized
      .replace(/^(?:地址|位于|导航至|门店在)/u, '')
      .replace(/[\s，,。；;：:]/gu, '');
  }
  if (key === 'gift') {
    return normalized
      .replace(/^(?:赠送|附赠|到店送|免费送|赠品(?:为|是|包含)|礼品(?:为|是|包含))/u, '')
      .replace(/\s+/gu, '');
  }
  return normalized.replace(/\s+/gu, '').toLowerCase();
}

function factSegments(contextText) {
  const segmentationText = contextText.replace(/(?<=\d),(?=\d{3}(?:\D|$))/gu, '');
  return segmentationText.split(/[。！？!?;；，,、\n]+/u);
}

function knownConcreteValues(key, contextText) {
  const known = new Set();
  for (const segment of factSegments(contextText)) {
    if (!segment.trim() || FACT_CONTEXT_MISSING_RE.test(segment)) continue;
    for (const match of concreteMatches(key, segment)) {
      const normalized = normalizedConcreteValue(key, match.raw);
      if (normalized) known.add(normalized);
    }
  }
  return known;
}

function knownPercentageRatios(contextText) {
  const ratios = new Set();
  for (const segment of factSegments(contextText)) {
    if (!segment.trim() || FACT_CONTEXT_MISSING_RE.test(segment)) continue;
    const matcher = matcherFor(PERCENT_RE);
    let match;
    while ((match = matcher.exec(segment)) !== null) {
      const percentage = Number(match[1] || match[2]);
      if (Number.isFinite(percentage) && percentage >= 0 && percentage <= 100) {
        ratios.add(percentage / 100);
      }
      if (!match[0]) matcher.lastIndex += 1;
    }
  }
  return [...ratios];
}

function knownPositiveQuantities(contextText) {
  const quantities = new Set();
  for (const segment of factSegments(contextText)) {
    if (!segment.trim() || FACT_CONTEXT_MISSING_RE.test(segment)) continue;
    const normalized = segment.normalize('NFKC').replace(/(?<=\d),(?=\d{3}(?:\D|$))/gu, '');
    for (const pattern of [LABELED_QUANTITY_RE, UNIT_QUANTITY_RE]) {
      const matcher = matcherFor(pattern);
      let match;
      while ((match = matcher.exec(normalized)) !== null) {
        const quantity = Number(String(match[1] || '').replace(/,/gu, ''));
        // 0 与非有限值不进入除数白名单；数量上限防止恶意上下文放大派生集。
        if (Number.isFinite(quantity) && quantity > 0 && quantity <= Number.MAX_SAFE_INTEGER) {
          quantities.add(quantity);
        }
        if (quantities.size >= MAX_KNOWN_QUANTITIES || !match[0]) break;
      }
      if (quantities.size >= MAX_KNOWN_QUANTITIES) break;
    }
    if (quantities.size >= MAX_KNOWN_QUANTITIES) break;
  }
  return [...quantities];
}

function parsedMoneyValue(canonical) {
  const match = String(canonical || '').match(/^(cny|usd):(\d+(?:\.\d{2})?)$/u);
  if (!match) return null;
  const cents = Math.round(Number(match[2]) * 100);
  if (!Number.isSafeInteger(cents) || cents < 0) return null;
  return { currency: match[1], cents };
}

function canonicalMoneyValue(currency, cents) {
  return `${currency}:${(cents / 100).toFixed(2)}`;
}

function derivedKnownPriceValues(contextText, directValues) {
  const allowed = new Set(directValues);
  if (!DERIVED_AMOUNT_PERMISSION_RE.test(contextText)) return allowed;

  const directMoney = [...directValues]
    .map(parsedMoneyValue)
    .filter(Boolean);
  const ratios = knownPercentageRatios(contextText);
  const quantities = knownPositiveQuantities(contextText);
  const pool = new Map(directMoney.map(value => [
    canonicalMoneyValue(value.currency, value.cents),
    value,
  ]));

  // 只接受可从输入金额和输入百分比复算的值；数量与轮数均设硬上限，
  // 避免差额闭包无限扩张，也让每个白名单值保持确定、可审计。
  for (const amount of directMoney) {
    for (const ratio of ratios) {
      if (pool.size >= MAX_DERIVED_MONEY_VALUES) break;
      const cents = Math.round(amount.cents * ratio);
      const canonical = canonicalMoneyValue(amount.currency, cents);
      pool.set(canonical, { currency: amount.currency, cents });
      allowed.add(canonical);
    }
  }

  for (let round = 0; round < DERIVED_MONEY_DIFFERENCE_ROUNDS; round += 1) {
    const values = [...pool.values()];
    let added = false;
    for (let left = 0; left < values.length; left += 1) {
      for (let right = left + 1; right < values.length; right += 1) {
        if (pool.size >= MAX_DERIVED_MONEY_VALUES) break;
        if (values[left].currency !== values[right].currency) continue;
        const cents = Math.abs(values[left].cents - values[right].cents);
        const canonical = canonicalMoneyValue(values[left].currency, cents);
        if (pool.has(canonical)) continue;
        pool.set(canonical, { currency: values[left].currency, cents });
        allowed.add(canonical);
        added = true;
      }
      if (pool.size >= MAX_DERIVED_MONEY_VALUES) break;
    }
    if (!added) break;
  }

  // 单位金额只允许“输入已确认的直接金额 ÷ 输入已确认的正数数量”。
  // 结果按货币最小单位四舍五入，不把商值再放回差额闭包，避免生成无业务意义的混合金额。
  for (const amount of directMoney) {
    for (const quantity of quantities) {
      if (allowed.size >= MAX_DERIVED_MONEY_VALUES) break;
      const cents = Math.round(amount.cents / quantity);
      if (!Number.isSafeInteger(cents) || cents < 0) continue;
      allowed.add(canonicalMoneyValue(amount.currency, cents));
    }
    if (allowed.size >= MAX_DERIVED_MONEY_VALUES) break;
  }
  return allowed;
}

function concreteMissingFactEntry(key, entries, knownValues = new Set()) {
  for (const entry of entries) {
    for (const match of concreteMatches(key, entry.text)) {
      const normalized = normalizedConcreteValue(key, match.raw);
      if (!normalized || !knownValues.has(normalized)) {
        return { ...entry, concreteValue: match.raw };
      }
    }
  }
  return null;
}

function normalizedTimeQuantity(value) {
  return value.normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/(?:--|–|—|~|～|至|到)/gu, '-');
}

function timeQuantities(value) {
  return [...String(value || '').matchAll(TIME_QUANTITY_RE)]
    .map(match => ({ raw: match[0], normalized: normalizedTimeQuantity(match[0]) }));
}

function supportedTimeQuantities(contextText) {
  const supported = new Set();
  for (const clause of contextText.split(/[。！？!?;；，,\n]+/u)) {
    if (FACT_CONTEXT_MISSING_RE.test(clause)) continue;
    for (const quantity of timeQuantities(clause)) supported.add(quantity.normalized);
  }
  return supported;
}

function validateFactGrounding(idx, parsed, context, errors) {
  const contextText = factContextText(context);
  validateWebEvidenceAttribution(idx, parsed, context, errors);
  if (idx === 9) validateRetrospectiveMetricGrounding(parsed, contextText, errors);
  if (idx >= 3 && idx <= 8) {
    validateMarketingQualitativeFactGrounding(idx, parsed, context, errors);
  }
  if (!contextText) return;
  const entries = authoredContentEntries(idx, parsed);

  for (const definition of MISSING_FACT_DEFINITIONS) {
    if (!explicitlyMissing(contextText, definition.terms)) continue;
    const directValues = knownConcreteValues(definition.key, contextText);
    const confirmedValues = definition.key === 'price'
      ? derivedKnownPriceValues(contextText, directValues)
      : directValues;
    const violation = concreteMissingFactEntry(definition.key, entries, confirmedValues);
    if (violation) {
      errors.push(`事实缺失硬校验：任务书/反馈明确“${definition.label}”未提供或待确认，但字段“${violation.path}”给出了未在输入中确认的具体值“${violation.concreteValue}”或肯定断言。`);
    }
  }

  if (idx !== 8) return;
  if (explicitlyMissing(contextText, BEST_TIME_TERMS_RE) && Array.isArray(parsed.versions)) {
    parsed.versions.forEach((version, index) => {
      const bestTime = version?.best_time;
      if (typeof bestTime !== 'string') return;
      if (!PENDING_CONFIRMATION_RE.test(bestTime) || TIME_OR_NUMBER_RE.test(bestTime)) {
        errors.push(`事实缺失硬校验：字段“versions[${index}].best_time”必须只保留待账号历史数据确认语义，不得包含时间或数字。`);
      }
    });
  }

  if (explicitlyMissing(contextText, BEST_TIME_TERMS_RE) && typeof parsed.publish_plan === 'string') {
    const supported = supportedTimeQuantities(contextText);
    const unsupported = timeQuantities(parsed.publish_plan)
      .find(quantity => !supported.has(quantity.normalized));
    if (unsupported) {
      errors.push(`事实缺失硬校验：字段“publish_plan”包含任务书/反馈未提供的具体时间间隔“${unsupported.raw}”。`);
    }
  }
}

function safeEmployeeKey(value) {
  const safe = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return safe || 'unknown';
}

function artifactFilename(profile, kind, content) {
  const extension = ARTIFACT_EXTENSIONS[kind] || 'txt';
  const idx = String(profile.identity.idx).padStart(2, '0');
  const digest = createHash('sha256').update(String(content)).digest('hex').slice(0, 12);
  return `content-employee-${idx}-${safeEmployeeKey(profile.identity.key)}-${digest}.${extension}`;
}

function markdownNumberedList(values) {
  return values.map((value, index) => `${index + 1}. ${String(value).trim()}`).join('\n');
}

function renderWriterMarkdown(parsed) {
  const imagePlan = parsed.image_plan.map((item, index) => [
    `${index + 1}. **${item.slot.trim()}**`,
    `   ${item.desc.trim()}`,
  ].join('\n')).join('\n');
  return [
    '# 撰稿人岗位交付报告',
    '',
    '## 标题候选',
    '',
    markdownNumberedList(parsed.title_candidates),
    '',
    '## 正文',
    '',
    parsed.body.trim(),
    '',
    '## 标签',
    '',
    parsed.tags.map(tag => `#${tag.trim()}`).join(' '),
    '',
    '## 配图计划',
    '',
    imagePlan,
  ].join('\n');
}

function renderStylistMarkdown(parsed) {
  return [
    '# 文风师岗位交付报告',
    '',
    '## 标题候选',
    '',
    markdownNumberedList(parsed.title_candidates),
    '',
    '## 正文',
    '',
    parsed.body.trim(),
    '',
    '## 人设与文风一致性说明',
    '',
    parsed.consistency_note.trim(),
  ].join('\n');
}

function renderRetrospectiveMarkdown(parsed) {
  const nextTopics = parsed.next_topics.map((topic, index) => [
    `${index + 1}. **${topic.title.trim()}**`,
    `   ${topic.reason.trim()}`,
  ].join('\n')).join('\n');
  const profileUpdates = parsed.profile_updates.length
    ? parsed.profile_updates.map(update => `- ${update.trim()}`).join('\n')
    : '（本次没有可回写的岗位经验）';
  return [
    '# 复盘官岗位交付报告',
    '',
    '## 复盘报告',
    '',
    parsed.report.trim(),
    '',
    '## 下一轮候选选题',
    '',
    nextTopics,
    '',
    '## 可回写岗位经验',
    '',
    profileUpdates,
  ].join('\n');
}

function renderPublishPackagesMarkdown(parsed) {
  const versions = Array.isArray(parsed.versions) ? parsed.versions : [];
  const sections = [
    '# 分发官岗位交付报告',
    '',
    '## 发布计划',
    '',
    String(parsed.publish_plan || '').trim(),
    '',
  ];
  versions.forEach((version) => {
    const tags = Array.isArray(version?.tags)
      ? version.tags.map(tag => `#${String(tag).trim()}`).join(' ')
      : '';
    const checklist = Array.isArray(version?.checklist)
      ? version.checklist.map(item => `- ${String(item).trim()}`).join('\n')
      : '';
    sections.push(
      `## ${String(version?.platform || '平台').trim()}发布包`,
      '',
      `**标题**：${String(version?.title || '').trim()}`,
      `**建议发布时间**：${String(version?.best_time || '').trim()}`,
      tags ? `**标签**：${tags}` : '',
      version?.note ? `**注意事项**：${String(version.note).trim()}` : '',
      '',
      '### 适配正文',
      '',
      String(version?.body || '').trim(),
      '',
      checklist ? '### 后台操作清单\n' : '',
      checklist,
      '',
    );
  });
  return sections.filter((item, index, list) => item !== '' || list[index - 1] !== '').join('\n').trim();
}

const MARKDOWN_ARTIFACT_RENDERERS = Object.freeze({
  3: renderWriterMarkdown,
  4: renderStylistMarkdown,
  9: renderRetrospectiveMarkdown,
});

function renderMarkdownArtifact(profile, parsed) {
  const render = MARKDOWN_ARTIFACT_RENDERERS[profile.identity.idx];
  if (!render) {
    throw new Error(`内容员工${profile.identity.idx}缺少Markdown完整交付物渲染器`);
  }
  return render(parsed);
}

function artifactContent(profile, kind, parsed) {
  if (kind === 'html') return parsed.html;
  if (kind === 'markdown') return renderMarkdownArtifact(profile, parsed);
  if (kind === 'images' && Object.hasOwn(parsed, 'images')) {
    return JSON.stringify(parsed.images, null, 2);
  }
  if (kind === 'covers' && Object.hasOwn(parsed, 'covers')) {
    return JSON.stringify(parsed.covers, null, 2);
  }
  return JSON.stringify(parsed, null, 2);
}

function buildArtifact(profile, parsed) {
  const kind = profile.jobProfile.outputSchema.primaryArtifact;
  const content = artifactContent(profile, kind, parsed);
  return {
    kind,
    primary: true,
    filename: artifactFilename(profile, kind, content),
    mediaType: ARTIFACT_MEDIA_TYPES[kind] || 'text/plain',
    content,
    employeeIdx: profile.identity.idx,
    employeeKey: profile.identity.key,
    sourceKeys: [...profile.jobProfile.outputSchema.keys],
  };
}

function parsedOutputTrace(parsed, artifact) {
  const fields = Object.fromEntries(Object.entries(parsed).map(([key, value]) => {
    if (artifact.kind === 'markdown' && ['body', 'report'].includes(key)
      && typeof value === 'string') {
      return [key, {
        storedIn: 'artifact.content',
        sectionHeading: key === 'body' ? '正文' : '复盘报告',
        contentSha256: createHash('sha256').update(value).digest('hex'),
        characterCount: [...value].length,
      }];
    }
    return [key, structuredClone(value)];
  }));
  return {
    schemaVersion: 1,
    sourceKeys: Object.keys(parsed),
    artifactFilename: artifact.filename,
    artifactContentSha256: createHash('sha256').update(artifact.content).digest('hex'),
    fields,
  };
}

const REPORT_FIELD_LABELS = Object.freeze({
  briefing: '核心结论',
  summary: '执行摘要',
  body: '完整正文',
  report: '复盘报告',
  publish_plan: '发布计划',
  consistency_note: '风格一致性说明',
  channel_scan: '渠道扫描',
  source_coverage: '来源覆盖',
  facts: '关键事实',
  data_points: '数据要点',
  viewpoints: '观点与判断',
  takeaways: '可执行启示',
  comment_insights: '评论洞察',
  user_language: '用户原话',
  title_candidates: '标题备选',
  next_topics: '下一轮选题',
  profile_updates: '人设与策略更新',
  topics: '选题机会',
  benchmarks: '竞品样本',
  sources: '核验来源',
  versions: '平台发布版本',
  images: '图片产物',
  covers: '封面产物',
  tags: '标签',
  image_plan: '配图计划',
  html: 'HTML演绎稿',
});

const REPORT_HEADING_KEYS = Object.freeze([
  'title',
  'topic',
  'name',
  'account',
  'platform',
  'channel',
  'slot',
  'filename',
]);

function reportFieldLabel(key) {
  return REPORT_FIELD_LABELS[key] || String(key).replaceAll('_', ' ');
}

function reportScalar(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function reportObjectHeading(value, index) {
  for (const key of REPORT_HEADING_KEYS) {
    const label = reportScalar(value?.[key]);
    if (label) return label;
  }
  return `第 ${index + 1} 项`;
}

function reportInlineValue(value) {
  const scalar = reportScalar(value);
  if (scalar) return scalar;
  if (Array.isArray(value)) {
    return value.map(reportInlineValue).filter(Boolean).join('、');
  }
  if (isPlainObject(value)) {
    return Object.entries(value)
      .map(([key, child]) => {
        const rendered = reportInlineValue(child);
        return rendered ? `${reportFieldLabel(key)}：${rendered}` : '';
      })
      .filter(Boolean)
      .join('；');
  }
  return '';
}

function renderReportSources(value) {
  if (!Array.isArray(value)) return [];
  return value.map((source, index) => {
    if (!isPlainObject(source)) return `- ${reportInlineValue(source)}`;
    const url = reportScalar(source.url || source.source_url || source.sourceUrl);
    const title = reportScalar(source.title || source.name) || `来源 ${index + 1}`;
    const detail = Object.entries(source)
      .filter(([key]) => !['url', 'source_url', 'sourceUrl', 'title', 'name'].includes(key))
      .map(([key, child]) => {
        const rendered = reportInlineValue(child);
        return rendered ? `${reportFieldLabel(key)}：${rendered}` : '';
      })
      .filter(Boolean)
      .join('；');
    const label = url ? `[${title}](${url})` : `**${title}**`;
    return `- ${label}${detail ? `：${detail}` : ''}`;
  });
}

function renderReportField(key, value) {
  const title = reportFieldLabel(key);
  if (key === 'html') {
    return [`## ${title}`, '', '完整 HTML 已作为独立主产物保存，请使用报告顶部的产物操作打开或下载。'];
  }
  if (key === 'sources') return [`## ${title}`, '', ...renderReportSources(value)];
  const scalar = reportScalar(value);
  if (scalar) return [`## ${title}`, '', scalar];
  if (Array.isArray(value)) {
    if (value.every(item => !isPlainObject(item))) {
      return [`## ${title}`, '', ...value.map(item => `- ${reportInlineValue(item)}`).filter(item => item !== '- ')];
    }
    return [
      `## ${title}`,
      '',
      ...value.flatMap((item, index) => {
        if (!isPlainObject(item)) return [`- ${reportInlineValue(item)}`];
        const heading = reportObjectHeading(item, index);
        const rows = Object.entries(item)
          .filter(([field]) => !REPORT_HEADING_KEYS.includes(field))
          .map(([field, child]) => {
            const rendered = reportInlineValue(child);
            return rendered ? `- **${reportFieldLabel(field)}**：${rendered}` : '';
          })
          .filter(Boolean);
        return [`### ${heading}`, '', ...rows, ''];
      }),
    ];
  }
  if (isPlainObject(value)) {
    return [
      `## ${title}`,
      '',
      ...Object.entries(value)
        .map(([field, child]) => {
          const rendered = reportInlineValue(child);
          return rendered ? `- **${reportFieldLabel(field)}**：${rendered}` : '';
        })
        .filter(Boolean),
    ];
  }
  return [];
}

export function renderContentEmployeeReportMarkdown(profile, parsed, artifact, context = {}) {
  const reportTitle = String(context.title || '').trim() || `${profile.identity.name}岗位交付报告`;
  const sections = [
    `# ${reportTitle}`,
    '',
    `> ${profile.identity.name} · 内容团队数字员工交付报告`,
    ...(artifact.kind === 'html'
      ? ['', `> HTML 主产物已通过契约校验：\`${artifact.filename}\``]
      : []),
    '',
  ];
  for (const key of profile.jobProfile.outputSchema.keys) {
    const value = parsed[key];
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue;
    sections.push(...renderReportField(key, value), '');
  }
  sections.push(
    '## 交付文件',
    '',
    `- 主产物：\`${artifact.filename}\``,
    `- 产物类型：${artifact.kind}`,
    '- 机器结构化数据已保存在运行证据中，不占用老板阅读报告的正文。',
    '',
    '## 下一步建议',
    '',
    '- 先核对报告中标注的来源、事实边界和待确认项。',
    '- 需要继续生产时，可将本报告交给内容团队下一工位作为完整上游材料。',
    '- 涉及外部发布、付费或不可逆动作时，再从对应执行入口发起。',
  );
  return sections.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function buildPreviewMarkdown(profile, parsed, artifact, context = {}) {
  if (artifact.kind === 'markdown') {
    return artifact.content;
  }
  if (artifact.kind === 'publish_packages') {
    return [
      renderPublishPackagesMarkdown(parsed),
      '',
      `> ${profile.identity.name} · 内容团队数字员工交付报告`,
      '',
      '## 交付文件',
      '',
      `- 主产物：\`${artifact.filename}\``,
      `- 产物类型：${artifact.kind}`,
      '',
      '## 下一步建议',
      '',
      '- 先按各平台发布包核对标题、正文、封面和配图。',
      '- 打开发布后台链接，按清单完成上传与人工终审。',
    ].join('\n');
  }
  return renderContentEmployeeReportMarkdown(profile, parsed, artifact, context);
}

/**
 * 校验内容生产仓单工位的模型输出。
 *
 * 无效输出不会被补字段或伪装成合格产物；调用方仍可通过 previewMarkdown
 * 展示原始降级底稿。只有完整通过岗位契约后才会返回 artifacts。
 */
export function validateContentEmployeeOutputContract(idx, rawOutput, context = {}) {
  const profile = buildContentEmployeeWorkbenchProfile(idx);
  const requiredKeys = profile.jobProfile.outputSchema.keys;
  const { parsed, parseError, rawPreview } = parseOutput(rawOutput);
  const errors = [];

  if (parseError) {
    errors.push(parseError);
  } else if (!isPlainObject(parsed)) {
    errors.push('输出顶层必须是 JSON 对象，不能是数组、null 或其他 JSON 值。');
  } else {
    const missingKeys = requiredKeys.filter(key => !Object.hasOwn(parsed, key));
    if (missingKeys.length) {
      errors.push(`缺少必需字段：${missingKeys.join('、')}。`);
    }
    const unknownKeys = Object.keys(parsed).filter(key => !requiredKeys.includes(key));
    if (unknownKeys.length) {
      errors.push(`输出包含未知字段：${unknownKeys.join('、')}。`);
    }
    OUTPUT_VALIDATORS[profile.identity.idx](parsed, errors, context);
    validateRequiredStationInputs(profile.identity.idx, {
      ...context,
      outputForCompletionGate: parsed,
    }, errors);
    if (profile.identity.idx === 3 && Array.isArray(parsed.title_candidates)) {
      const titleCount = resolveWriterTitleCountRequirement({
        requirement: context?.requirement,
        feedback: context?.feedback,
      });
      if (titleCount.hasConstraint && !titleCount.contractSatisfiable) {
        if (titleCount.constraintKind === 'exact') {
          errors.push(
            `老板明确要求${titleCount.count}个标题，但撰稿人岗位契约仅允许3-5个；当前任务无法满足，请将标题数量改为3、4或5个后重试。`,
          );
        } else {
          const requested = titleCount.min != null
            ? `至少${titleCount.min}个`
            : `至多${titleCount.max}个`;
          errors.push(
            `老板要求${requested}标题，但撰稿人岗位契约仅允许3-5个；当前任务无法满足，请将标题数量改为3-5个范围内后重试。`,
          );
        }
      } else if (titleCount.inContractRange && parsed.title_candidates.length !== titleCount.count) {
        errors.push(
          `字段“title_candidates”必须匹配老板明确要求，恰好包含${titleCount.count}项。`,
        );
      } else if (titleCount.constraintKind === 'range'
        && (parsed.title_candidates.length < titleCount.effectiveMin
          || parsed.title_candidates.length > titleCount.effectiveMax)) {
        errors.push(
          `字段“title_candidates”必须匹配老板的范围要求，包含${titleCount.effectiveMin}-${titleCount.effectiveMax}项。`,
        );
      }
    }
    validateFactGrounding(profile.identity.idx, parsed, context, errors);
  }

  if (errors.length) {
    return {
      valid: false,
      parsed,
      errors,
      previewMarkdown: rawPreview,
      artifacts: [],
    };
  }

  const artifact = buildArtifact(profile, parsed);
  return {
    valid: true,
    parsed,
    parsedOutput: parsedOutputTrace(parsed, artifact),
    errors: [],
    previewMarkdown: buildPreviewMarkdown(profile, parsed, artifact, context),
    artifacts: [artifact],
  };
}

export const validateContentOutputContract = validateContentEmployeeOutputContract;

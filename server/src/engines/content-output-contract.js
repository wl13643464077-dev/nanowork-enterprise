import { createHash } from 'node:crypto';

import { buildContentEmployeeWorkbenchProfile } from './content-employee-workbench.js';

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

function validateCompleteHtml(html, path = 'html') {
  if (typeof html !== 'string' || !html.trim()) {
    return [`字段“${path}”必须是非空字符串。`];
  }

  const errors = [];
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
  return errors;
}

function validateNonEmptyString(value, path, errors) {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`字段“${path}”必须是非空字符串。`);
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
  return validateArray(value, path, errors, {
    ...bounds,
    item: (entry, itemPath, targetErrors) => {
      validateNonEmptyString(entry, itemPath, targetErrors);
    },
  });
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

function validateObjectArray(value, path, errors, fields, bounds = {}) {
  return validateArray(value, path, errors, {
    ...bounds,
    item: (entry, itemPath, targetErrors) => {
      validateObject(entry, itemPath, targetErrors, fields);
    },
  });
}

function validateHttpUrl(value, path, errors) {
  if (!validateNonEmptyString(value, path, errors)) return;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
  } catch {
    errors.push(`字段“${path}”必须是有效的 http(s) 链接。`);
  }
}

function validateDimensions(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`字段“${path}”必须是JSON对象。`);
    return;
  }
  const entries = Object.entries(value);
  if (!entries.length) {
    errors.push(`字段“${path}”必须至少包含一个拆解维度。`);
    return;
  }
  for (const [key, detail] of entries) {
    if (!key.trim()) errors.push(`字段“${path}”包含空维度名。`);
    validateNonEmptyString(detail, `${path}.${key || '(空)'}`, errors);
  }
}

function validateSvg(value, path, errors) {
  if (!validateNonEmptyString(value, path, errors)) return;
  if (!/^\s*<svg(?:\s|>)[\s\S]*<\/svg>\s*$/iu.test(value)) {
    errors.push(`字段“${path}”必须是完整的SVG。`);
  }
}

const OUTPUT_VALIDATORS = Object.freeze([
  (value, errors) => {
    validateNonEmptyString(value.briefing, 'briefing', errors);
    validateObjectArray(value.channel_scan, 'channel_scan', errors, {
      channel: STRING_FIELD,
      finding: STRING_FIELD,
    });
    validateObjectArray(value.topics, 'topics', errors, {
      title: STRING_FIELD,
      angle: STRING_FIELD,
      hook: STRING_FIELD,
      reason: STRING_FIELD,
      heat: STRING_FIELD,
      evidence: STRING_FIELD,
    }, { exact: 5 });
  },
  (value, errors) => {
    validateNonEmptyString(value.summary, 'summary', errors);
    for (const key of ['facts', 'data_points', 'viewpoints']) {
      validateStringArray(value[key], key, errors);
    }
    validateObjectArray(value.source_coverage, 'source_coverage', errors, {
      channel: STRING_FIELD,
      got: STRING_FIELD,
    });
    validateObjectArray(value.sources, 'sources', errors, {
      title: STRING_FIELD,
      url: validateHttpUrl,
    });
  },
  (value, errors) => {
    validateObjectArray(value.benchmarks, 'benchmarks', errors, {
      title: STRING_FIELD,
      platform: STRING_FIELD,
      account: STRING_FIELD,
      dimensions: validateDimensions,
      why_hot: STRING_FIELD,
    }, { min: 3, max: 5 });
    for (const key of ['comment_insights', 'user_language', 'takeaways']) {
      validateStringArray(value[key], key, errors);
    }
  },
  (value, errors) => {
    validateStringArray(value.title_candidates, 'title_candidates', errors, { exact: 3 });
    validateNonEmptyString(value.body, 'body', errors);
    validateStringArray(value.tags, 'tags', errors, { min: 5, max: 8 });
    validateObjectArray(value.image_plan, 'image_plan', errors, {
      slot: STRING_FIELD,
      desc: STRING_FIELD,
    }, { min: 2, max: 4 });
  },
  (value, errors) => {
    validateNonEmptyString(value.body, 'body', errors);
    validateStringArray(value.title_candidates, 'title_candidates', errors, { exact: 3 });
    validateNonEmptyString(value.consistency_note, 'consistency_note', errors);
  },
  (value, errors) => {
    validateObjectArray(value.images, 'images', errors, {
      slot: STRING_FIELD,
      desc: STRING_FIELD,
      platform: STRING_FIELD,
      svg: validateSvg,
    });
  },
  (value, errors) => {
    validateObjectArray(value.covers, 'covers', errors, {
      style: STRING_FIELD,
      platform: STRING_FIELD,
      size: STRING_FIELD,
      html: (html, path, targetErrors) => {
        targetErrors.push(...validateCompleteHtml(html, path));
      },
    });
  },
  (value, errors) => {
    validateNonEmptyString(value.summary, 'summary', errors);
    errors.push(...validateCompleteHtml(value.html, 'html'));
  },
  (value, errors) => {
    validateObjectArray(value.versions, 'versions', errors, {
      platform: STRING_FIELD,
      title: STRING_FIELD,
      body: STRING_FIELD,
      tags: (tags, path, targetErrors) => validateStringArray(tags, path, targetErrors),
      best_time: STRING_FIELD,
      checklist: (items, path, targetErrors) => (
        validateStringArray(items, path, targetErrors, { min: 2, max: 4 })
      ),
      note: STRING_FIELD,
    });
    validateNonEmptyString(value.publish_plan, 'publish_plan', errors);
  },
  (value, errors) => {
    validateNonEmptyString(value.report, 'report', errors);
    validateObjectArray(value.next_topics, 'next_topics', errors, {
      title: STRING_FIELD,
      reason: STRING_FIELD,
    });
    validateStringArray(value.profile_updates, 'profile_updates', errors);
  },
]);

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

function artifactContent(kind, parsed) {
  if (kind === 'html') return parsed.html;
  if (kind === 'markdown') {
    for (const key of ['body', 'report']) {
      if (typeof parsed[key] === 'string') return parsed[key];
    }
  }
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
  const content = artifactContent(kind, parsed);
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

function buildPreviewMarkdown(parsed, artifact) {
  if (artifact.kind === 'markdown') {
    return artifact.content;
  }
  if (artifact.kind === 'html') {
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const notice = `> HTML 主产物已通过契约校验：\`${artifact.filename}\``;
    return [summary, notice].filter(Boolean).join('\n\n');
  }
  return jsonFence(parsed);
}

/**
 * 校验内容生产仓单工位的模型输出。
 *
 * 无效输出不会被补字段或伪装成合格产物；调用方仍可通过 previewMarkdown
 * 展示原始降级底稿。只有完整通过岗位契约后才会返回 artifacts。
 */
export function validateContentEmployeeOutputContract(idx, rawOutput) {
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
    OUTPUT_VALIDATORS[profile.identity.idx](parsed, errors);
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
    errors: [],
    previewMarkdown: buildPreviewMarkdown(parsed, artifact),
    artifacts: [artifact],
  };
}

export const validateContentOutputContract = validateContentEmployeeOutputContract;

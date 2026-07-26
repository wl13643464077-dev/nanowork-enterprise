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

function validateDeckHtml(html) {
  if (typeof html !== 'string' || !html.trim()) {
    return ['字段“html”必须是非空字符串。'];
  }

  const errors = [];
  if (!/<html(?:\s|>)/iu.test(html) || !/<\/html\s*>/iu.test(html)) {
    errors.push('演绎师的 html 字段必须包含完整的 <html> 根元素。');
  }
  if (!/<body(?:\s|>)/iu.test(html) || !/<\/body\s*>/iu.test(html)) {
    errors.push('演绎师的 html 字段必须包含完整的 <body> 正文元素。');
  }
  if (normalizedHtmlForProtocolCheck(html).includes('javascript:')) {
    errors.push('演绎师 HTML 禁止使用 javascript: URL。');
  }
  if (/<script\b[^>]*\bsrc\s*=/iu.test(html)) {
    errors.push('演绎师 HTML 禁止引用外部脚本；脚本必须内联并经过人工审阅。');
  }
  return errors;
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
    if (profile.identity.idx === 7 && Object.hasOwn(parsed, 'html')) {
      errors.push(...validateDeckHtml(parsed.html));
    }
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

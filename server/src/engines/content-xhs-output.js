import { createHash } from 'node:crypto';
import { STORE_FACT_INTERNAL_EVIDENCE, validateFactsUsed } from './content-store-facts.js';
import { XHS_LIMITS, XHS_STRATEGIES, xhsSalesVersionTextIssues, xhsPreferredVersionIndex, findXhsUngroundedConcreteDigits } from './content-xhs-playbook.js';

const VERSION_KEYS = ['strategy', 'framework_ref', 'title', 'cover_text', 'body', 'tags', 'comment_prompt', 'facts_used', 'self_score'];
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const string = (minLength = 1, maxLength = 1000) => ({ type: 'string', minLength, maxLength });
const array = (items, minItems, maxItems) => ({ type: 'array', items, minItems, maxItems });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function xhsSalesOutputSchema({ versionCount }) {
  return object({
    versions: array(object({
      strategy: { type: 'string', enum: [...XHS_STRATEGIES] },
      framework_ref: string(2, 200), title: string(1, 40), cover_text: string(1, 20),
      body: string(XHS_LIMITS.bodyMin, XHS_LIMITS.bodyMax),
      tags: array(string(1, 30), XHS_LIMITS.tagsMin, XHS_LIMITS.tagsMax),
      comment_prompt: string(4, 200),
      facts_used: array(object({ claim: string(1, 1000), factId: string(1, 160) }), 0, 30),
      self_score: object({
        hook: { type: 'integer', minimum: 1, maximum: 5 },
        credibility: { type: 'integer', minimum: 1, maximum: 5 },
        conversion: { type: 'integer', minimum: 1, maximum: 5 },
        note: string(1, XHS_LIMITS.scoreNoteMax),
      }),
    }), versionCount, versionCount),
    image_plan: array(object({ slot: string(2, 80), desc: string(12, 1000) }), 2, 4),
  });
}

function objectFields(value, keys, path, errors) {
  if (!plain(value)) { errors.push(`${path} 必须是对象`); return false; }
  if (keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) {
    errors.push(`${path} 必须且只能包含 ${keys.join('、')}`);
  }
  return true;
}
function textField(value, path, errors, min = 1, max = 1000) {
  if (typeof value !== 'string' || [...value.trim()].length < min || [...value.trim()].length > max) {
    errors.push(`${path} 必须是 ${min}–${max} 字的非空字符串`);
  }
}

export function validateXhsSalesOutput(parsed, mode, pack, errors) {
  const publicFacts = (pack?.facts || []).filter(fact => fact && fact.usage !== STORE_FACT_INTERNAL_EVIDENCE);
  if (!objectFields(parsed, ['versions', 'image_plan'], '小红书输出', errors)) return;
  if (!Array.isArray(parsed.versions) || parsed.versions.length !== mode.versionCount) {
    errors.push(`versions 必须恰好包含 ${mode.versionCount} 版`);
  }
  const strategies = new Set(); const bodies = new Set();
  for (const [index, version] of (Array.isArray(parsed.versions) ? parsed.versions : []).entries()) {
    const path = `versions[${index}]`;
    if (!objectFields(version, VERSION_KEYS, path, errors)) continue;
    if (!XHS_STRATEGIES.includes(version.strategy) || strategies.has(version.strategy)) errors.push(`${path}.strategy 必须是互不重复的有效策略`);
    strategies.add(version.strategy);
    for (const [key, min, max] of [['title', 1, 40], ['cover_text', 1, 20], ['framework_ref', 2, 200], ['body', 120, 1000], ['comment_prompt', 4, 200]]) textField(version[key], `${path}.${key}`, errors, min, max);
    const body = typeof version.body === 'string' ? version.body.replace(/\s+/gu, '') : '';
    if (bodies.has(body)) errors.push(`${path}.body 不能与其他策略使用完全相同的正文`);
    bodies.add(body);
    errors.push(...xhsSalesVersionTextIssues(version, { path, requireFactPack: publicFacts.length > 0 }));
    if (findXhsUngroundedConcreteDigits(version.cover_text).some(hit => hit.kind === 'price')) errors.push(`${path}.cover_text 封面不写价格`);
    const outward = [version.title, version.cover_text, version.body, version.comment_prompt, ...(Array.isArray(version.tags) ? version.tags : [])];
    if (!publicFacts.length && outward.some(text => findXhsUngroundedConcreteDigits(text).length)) errors.push(`${path} 无门店事实包，不得出现具体价格或地址数字`);
    if (!Array.isArray(version.tags) || version.tags.length < 5 || version.tags.length > 8) errors.push(`${path}.tags 必须有5–8个标签`);
    else {
      for (const tag of version.tags) { textField(tag, `${path}.tags`, errors, 1, 30); if (typeof tag === 'string' && /[#＃\r\n]/u.test(tag)) errors.push(`${path}.tags 不带#或换行`); }
      if (new Set(version.tags).size !== version.tags.length) errors.push(`${path}.tags 不得重复`);
    }
    if (objectFields(version.self_score, ['hook', 'credibility', 'conversion', 'note'], `${path}.self_score`, errors)) {
      for (const key of ['hook', 'credibility', 'conversion']) if (!Number.isInteger(version.self_score[key]) || version.self_score[key] < 1 || version.self_score[key] > 5) errors.push(`${path}.self_score.${key} 必须是1–5的整数`);
      textField(version.self_score.note, `${path}.self_score.note`, errors, 1, 200);
    }
    if (!Array.isArray(version.facts_used) || version.facts_used.length > 30) errors.push(`${path}.facts_used 必须是至多30项的数组`);
    else for (const entry of version.facts_used) {
      if (!objectFields(entry, ['claim', 'factId'], `${path}.facts_used`, errors)) continue;
      textField(entry.claim, `${path}.facts_used.claim`, errors);
      textField(entry.factId, `${path}.facts_used.factId`, errors, 1, 160);
      const fact = publicFacts.find(item => item.id === entry.factId);
      if (fact && entry.claim !== fact.claim) errors.push(`${path}.facts_used.claim 必须逐字匹配所登记的事实声明，不能借真实ID登记虚构事实`);
    }
    const registered = validateFactsUsed(version.facts_used, pack, { min: publicFacts.length ? XHS_LIMITS.factsUsedMin : 0 });
    errors.push(...registered.errors.map(error => `${path}.${error}`));
  }
  if (!Array.isArray(parsed.image_plan) || parsed.image_plan.length < 2 || parsed.image_plan.length > 4) errors.push('image_plan 必须有2–4个点位');
  else parsed.image_plan.forEach((item, index) => {
    const path = `image_plan[${index}]`;
    if (!objectFields(item, ['slot', 'desc'], path, errors)) return;
    textField(item.slot, `${path}.slot`, errors, 2, 80);
    textField(item.desc, `${path}.desc`, errors, 12, 1000);
  });
}

/** 标识绑定完整版本内容；自评分仅推荐，绝不自动成为所选发布版本。 */
export function xhsVersionId(version) {
  const stable = value => Array.isArray(value) ? value.map(stable) : plain(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return `xhs-${createHash('sha256').update(JSON.stringify(stable(version))).digest('hex').slice(0, 24)}`;
}
export function xhsVersionsForDisplay(parsed) {
  const recommended = xhsPreferredVersionIndex(parsed.versions);
  return parsed.versions.map((version, index) => ({ ...version, versionId: xhsVersionId(version), recommended: index === recommended }));
}
export function renderXhsSalesMarkdown(parsed) {
  return [
    '# 小红书带货多策略稿', '', '尚未选择发布版本。自评分是模型建议，不是实际发布效果；选择后再导出发布包。', '',
    ...xhsVersionsForDisplay(parsed).flatMap(v => [
      `## ${v.strategy}${v.recommended ? '（自评推荐）' : ''}`, '',
      `标题：${v.title}`, `封面文案：${v.cover_text}`, '', v.body, '',
      v.tags.map(tag => `#${tag}`).join(' '), '', `首评：${v.comment_prompt}`, '',
      `结构参考：${v.framework_ref}`, `自评：钩子 ${v.self_score.hook}/5 · 可信 ${v.self_score.credibility}/5 · 转化 ${v.self_score.conversion}/5`,
      v.self_score.note, '', '事实登记：', ...v.facts_used.map(f => `- [${f.factId}] ${f.claim}`), '',
    ]),
    '## 配图计划', '', ...parsed.image_plan.map(item => `- ${item.slot}：${item.desc}`), '',
    '发布前由老板核对事实、素材授权及AI辅助创作标注；本报告没有执行平台发布。',
  ].join('\n');
}

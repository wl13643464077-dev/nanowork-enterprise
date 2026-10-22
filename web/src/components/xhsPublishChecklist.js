// 小红书发布前自查：只读检查老板当前编辑稿，不改写内容、不阻止复制下载。
// 规则与服务端 XHS_COMMERCIAL_PLAYBOOK 的硬指标一致，便于老板逐条核对。

const chars = value => [...String(value || '').trim()].length;
const paragraphs = body =>
  String(body || '')
    .split(/\n+/u)
    .map(part => part.trim())
    .filter(Boolean).length;
const emojiCount = value => (String(value || '').match(/\p{Extended_Pictographic}/gu) || []).length;

/**
 * @param {{title?: string, body?: string, tags?: string[], firstComment?: string,
 *   compliance?: {blocked?: boolean, hits?: Array<{severity: string}>}}} draft
 * @param {{imageCount?: number, aiImageCount?: number}} [media]
 * @returns {{items: Array<{key: string, label: string, ok: boolean, level: 'pass'|'warn'|'block', detail: string}>, passed: number, total: number, ready: boolean}}
 */
export function xhsPublishChecklist(draft, media = {}) {
  const title = String(draft?.title || '');
  const body = String(draft?.body || '');
  const tags = Array.isArray(draft?.tags) ? draft.tags.filter(Boolean) : [];
  const firstComment = String(draft?.firstComment || '');
  const hits = Array.isArray(draft?.compliance?.hits) ? draft.compliance.hits : [];
  const blockHits = hits.filter(hit => hit?.severity === 'block').length;
  const warnHits = hits.length - blockHits;
  const titleLen = chars(title);
  const bodyLen = chars(body);
  const paraCount = paragraphs(body);
  const emojis = emojiCount(body);
  const imageCount = Number(media.imageCount || 0);
  const aiImageCount = Number(media.aiImageCount || 0);
  const item = (key, label, level, detail) => ({ key, label, ok: level === 'pass', level, detail });
  const items = [
    item('title', '标题 ≤ 20 字', titleLen > 0 && titleLen <= 20 ? 'pass' : 'warn',
      titleLen ? `当前 ${titleLen} 字` : '还没有标题'),
    item('body', '正文 150–300 字', bodyLen >= 150 && bodyLen <= 300 ? 'pass' : 'warn', `当前 ${bodyLen} 字`),
    item('paragraphs', '短段落 ≥ 4 段（手机好读）', paraCount >= 4 ? 'pass' : 'warn', `当前 ${paraCount} 段`),
    item('emoji', 'emoji 1–8 个', emojis >= 1 && emojis <= 8 ? 'pass' : 'warn', `当前 ${emojis} 个`),
    item('tags', '标签 6–8 个', tags.length >= 6 && tags.length <= 8 ? 'pass' : 'warn', `当前 ${tags.length} 个`),
    item('comment', '首评是选择题式提问', /[？?]/u.test(firstComment) ? 'pass' : 'warn',
      firstComment ? '建议用“A 还是 B？”带动评论' : '还没有首评'),
    item('images', '配图 3 张以上', imageCount >= 3 ? 'pass' : 'warn', `当前 ${imageCount} 张`),
    item('compliance', '无平台红线词', blockHits ? 'block' : warnHits ? 'warn' : 'pass',
      blockHits ? `${blockHits} 处必改` : warnHits ? `${warnHits} 处建议调整` : '已扫描通过'),
  ];
  if (aiImageCount) items.push(item('ai_label', 'AI 配图已标注“非实拍”', 'pass', `${aiImageCount} 张已自动加角标`));
  const passed = items.filter(entry => entry.ok).length;
  return { items, passed, total: items.length, ready: !items.some(entry => entry.level === 'block') };
}

/** 正文前 N 个字（模拟信息流折叠） */
export function xhsFoldedBody(body, limit = 90) {
  const all = [...String(body || '')];
  return all.length > limit ? { text: all.slice(0, limit).join(''), folded: true } : { text: all.join(''), folded: false };
}

const IMAGE_MODES = new Set(['ai', 'real', 'mix']);
const DEFAULT_PLATFORMS = ['小红书'];
const DEFAULT_IMAGE_MODE = 'ai';

function cleanText(value) {
  return typeof value === 'string' ? value.normalize('NFC').trim() : '';
}

function normalizeStyle(value, enabled) {
  if (!enabled || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = cleanText(value.name);
  const desc = cleanText(value.desc);
  return name || desc ? { name, desc } : null;
}

function normalizePlatforms(value) {
  if (value === undefined || value === null || value === '') return [...DEFAULT_PLATFORMS];
  if (!Array.isArray(value)) throw new Error('发布平台必须是数组');
  const platforms = [...new Set(value.map(cleanText).filter(Boolean))];
  if (!platforms.length) throw new Error('请至少选择一个发布平台');
  return platforms;
}

function normalizeImageCount(value) {
  if (value === undefined || value === null || value === '') return null;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > 12) {
    throw new Error('配图数量必须是 0–12 的整数');
  }
  return count;
}

/**
 * 从单员工派活表单生成 Paihuo 原始 Brief。
 * 新契约只要求 question/goal（旧 title/requirement/type 继续兼容），平台、配图和模板均由岗位默认值补齐。
 */
export function buildPaihuoContentBrief(values) {
  const source = values && typeof values === 'object' ? values : {};
  const direction = cleanText(source.question || source.goal || source.direction || source.title);
  if (!direction) throw new Error('请填写问题或任务目标');
  const imageMode = cleanText(source.imageMode || source.image_mode) || DEFAULT_IMAGE_MODE;
  if (!IMAGE_MODES.has(imageMode)) throw new Error('配图来源不正确');
  const platforms = normalizePlatforms(source.platforms);

  return {
    direction,
    template: cleanText(source.type || source.template),
    industry: cleanText(source.industry),
    material: cleanText(source.material || source.requirement || source.materials),
    ref_link: cleanText(source.refLink),
    platforms,
    image_mode: imageMode,
    image_count: normalizeImageCount(source.imageCount),
    enable_deck: source.enableDeck === true,
    xhs_style: normalizeStyle(source.xhsStyle, platforms.includes('小红书')),
    dy_style: normalizeStyle(source.dyStyle, platforms.includes('抖音')),
  };
}

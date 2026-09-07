// Deterministic post-check for copy written from a boss's own facts.
// The model prompt already forbids inventing menu details; this catches what
// still slips through and turns it into advice the user can act on. It never
// blocks delivery, never rewrites text and never triggers a paid retry.

const CATEGORIES = [
  { key: 'taste', label: '口味/口感', terms: [
    '鲜嫩', '嫩滑', '滑嫩', '香脆', '酥脆', '酥香', '麻辣', '鲜香', '入口即化', '软糯', '爽口', 'Q弹', '弹牙', '多汁', '爆汁',
    '浓郁', '回甘', '酸甜', '咸香', '劲道', '鲜甜', '外酥里嫩', '肥而不腻', '油而不腻', '鲜美', '醇厚', '清爽', '香而不腻',
    '入味', '嫩而不柴', '筋道', '绵密', '奶香', '焦香', '蒜香', '椒香', '汤底浓郁', '汤汁浓郁', '口感丝滑', '丝滑', '咸鲜', '微辣', '香辣',
  ] },
  { key: 'audience', label: '适合人群', terms: [
    '老少皆宜', '家庭聚餐', '情侣', '闺蜜', '学生党', '上班族', '打工人', '带娃', '亲子', '宝妈', '一家人', '朋友聚会', '同事聚餐',
    '商务宴请', '年轻人', '老人', '小孩', '孩子们', '白领',
  ] },
  { key: 'process', label: '配料/工艺', terms: [
    '秘制', '手工', '现做', '现切', '现熬', '现炒', '现烤', '慢炖', '慢煮', '文火', '熬制', '选用', '精选', '进口', '有机', '无添加',
    '土鸡', '山泉水', '老汤', '老卤', '传承', '祖传', '古法', '独家配方', '每日新鲜', '当天现', '手打', '现磨', '现榨', '新鲜直供', '产地直供',
  ] },
  { key: 'reputation', label: '顾客评价/销量', terms: [
    '顾客说', '回头客', '好评', '排队', '网红', '爆款', '人气', '口碑', '销量', '必点', '第一名', '最好吃', '吃过都说', '好评如潮',
    '复购', '天天爆满', '座无虚席', '年销', '月销', '万份', '千份', '本地人都', '开了多年', '老字号', '老店',
  ] },
];

const PRICE_PATTERN = /(?:[¥￥]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:元|块钱|块|折)(?![a-zA-Z]))/gu;
const YEARS_PATTERN = /\d+\s*年(?:老店|历史|经验|传承)/gu;

function normalize(value) {
  return String(value || '').replace(/\s+/gu, '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Find concrete claims in `output` that are absent from every confirmed text.
 * @param {string} output generated copy
 * @param {string|string[]} confirmed user messages, brief, store facts the boss supplied
 * @returns {{category:string,label:string,terms:string[]}[]}
 */
export function detectUnconfirmedClaims(output, confirmed = []) {
  const text = normalize(output);
  if (!text) return [];
  const confirmedText = normalize((Array.isArray(confirmed) ? confirmed : [confirmed]).join('\n'));
  const findings = [];
  for (const category of CATEGORIES) {
    const terms = category.terms.filter(term => text.includes(term) && !confirmedText.includes(term));
    if (terms.length) findings.push({ category: category.key, label: category.label, terms: unique(terms) });
  }
  const prices = unique([...text.matchAll(PRICE_PATTERN)].map(match => match[0]))
    .filter(value => !confirmedText.includes(value));
  if (prices.length) findings.push({ category: 'price', label: '价格/折扣', terms: prices });
  const years = unique([...text.matchAll(YEARS_PATTERN)].map(match => match[0]))
    .filter(value => !confirmedText.includes(value));
  if (years.length) findings.push({ category: 'history', label: '年限/历史', terms: years });
  return findings;
}

/**
 * Advice lines for the delivered result. Empty when nothing needs confirming.
 */
export function factGroundingAdvice(output, confirmed = []) {
  return detectUnconfirmedClaims(output, confirmed).map(finding =>
    `正文出现你未确认的${finding.label}：${finding.terms.slice(0, 6).join('、')}${finding.terms.length > 6 ? ' 等' : ''}。发布前请核对，或删掉换成你确认过的说法。`);
}

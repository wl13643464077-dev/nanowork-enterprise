// AI 带货视频「多平台发布包」：只从已确认口播脚本里取词，不新增事实、不调用模型、不发布。
// 输出抖音 / 视频号 / 小红书三套标题、文案、话题与置顶评论，老板复制后自行发布。

const CATEGORY_WORDS = [
  ['火锅', ['火锅', '涮', '锅底', '毛肚']],
  ['烤鸭', ['烤鸭', '鸭']],
  ['面馆', ['面', '拉面', '小面', '牛肉面', '米线', '米粉']],
  ['烧烤', ['烧烤', '烤串', '串']],
  ['小龙虾', ['小龙虾', '龙虾']],
  ['茶饮', ['奶茶', '茶饮', '果茶', '柠檬茶']],
  ['咖啡', ['咖啡', '拿铁', '美式']],
  ['烘焙', ['蛋糕', '面包', '烘焙', '甜品']],
  ['中餐', ['炒菜', '家常菜', '小炒', '中餐', '湘菜', '川菜', '粤菜', '鲁菜']],
  ['快餐', ['快餐', '盖饭', '套餐', '便当']],
];
const SCENE_WORDS = [
  ['朋友聚餐', ['朋友', '聚餐', '聚会']],
  ['家庭聚餐', ['家人', '带娃', '孩子', '爸妈', '全家']],
  ['下班吃什么', ['下班', '晚饭', '夜宵', '打工人']],
  ['一人食', ['一个人', '一人食', '独自']],
  ['约会', ['约会', '情侣']],
];
const RISKY = /最好吃|第一|顶级|全网最|最低价|绝对|100%|国家级|特效|根治|保证|免费送|加微信|扫码领/u;

const clean = value => String(value || '').replace(/\s+/gu, ' ').trim();
const chars = value => [...String(value || '')];
const cut = (value, max) => {
  const list = chars(clean(value));
  return list.length > max ? `${list.slice(0, max).join('')}` : list.join('');
};
const sentence = value => clean(value).replace(/[｜|]/gu, '，');
const pick = (text, table) => table.filter(([, words]) => words.some(word => text.includes(word))).map(([label]) => label);

/**
 * @param {any} script 带货视频已确认脚本（hook_3s / shots[].voiceover / cta / facts_used）
 * @param {{brandName?: string, city?: string}} [context]
 */
export function buildSalesVideoPublishKit(script, context = {}) {
  if (!script || typeof script !== 'object') return null;
  const shots = Array.isArray(script.shots) ? script.shots : [];
  const narration = shots.map(shot => sentence(shot?.voiceover)).filter(Boolean).join('');
  if (!narration) return null;
  const trimEnd = value => clean(value).replace(/[，,、；;。！？!?\s]+$/u, '');
  const sentences = narration.match(/[^。！？!?]+[。！？!?]?/gu)?.map(clean).filter(Boolean) || [narration];
  const firstSentence = trimEnd(sentences[0]);
  const rawHook = trimEnd(script.hook_3s);
  // 钩子常是半句（“下班饿了，”），标题改用口播首句，避免只剩一个短语。
  const hook = rawHook && chars(rawHook).length >= 8 ? rawHook : firstSentence || rawHook;
  const cta = sentence(script.cta) || '欢迎到店看看';
  const ctaKey = trimEnd(cta);
  const body = sentences.filter(line => !ctaKey || !line.includes(ctaKey)).join('');
  const facts = (Array.isArray(script.facts_used) ? script.facts_used : [])
    .map(item => clean(item?.claim))
    .filter(Boolean)
    .slice(0, 4);
  const blob = `${narration}${facts.join('')}${context.brandName || ''}`;
  const brand = cut(context.brandName, 16);
  const city = cut(context.city, 8);
  const categories = pick(blob, CATEGORY_WORDS);
  const scenes = pick(blob, SCENE_WORDS);
  const base = [...new Set([brand, ...categories, ...scenes, city && `${city}美食`, '探店', '美食推荐'].filter(Boolean))];
  const hashtags = platform => {
    const extra = platform === 'douyin' ? ['抖音美食', '同城美食'] : platform === 'channels' ? ['视频号美食'] : ['小红书美食', '今天吃什么'];
    return [...new Set([...base, ...extra])].slice(0, platform === 'xhs' ? 8 : 6);
  };
  const factLine = facts.length ? facts.join('；') : '';
  const pieces = {
    douyin: {
      label: '抖音',
      title: cut(hook, 30),
      caption: [body, factLine, cta].filter(Boolean).join('\n'),
      hashtags: hashtags('douyin'),
      pinnedComment: `你会先点哪一道？评论区告诉我们～${city ? `门店在${city}，` : ''}具体位置看主页。`,
      tip: '建议在午饭前 11:00–12:00 或晚饭前 17:00–19:00 发布，挂上门店 POI 定位。',
    },
    channels: {
      label: '视频号',
      title: cut(hook, 30),
      caption: [body, factLine, `${trimEnd(cta)}，转给想一起去的朋友。`].filter(Boolean).join('\n'),
      hashtags: hashtags('channels'),
      pinnedComment: '想一起去的朋友，转发给 TA 看看～',
      tip: '视频号靠熟人转发，发布后先转到门店社群和老板朋友圈。',
    },
    xhs: {
      label: '小红书',
      title: cut(`${scenes[0] ? `${scenes[0]}｜` : ''}${hook}`, 20),
      caption: [body, factLine, cta].filter(Boolean).join('\n\n'),
      hashtags: hashtags('xhs'),
      pinnedComment: '你更想先尝哪一道？评论区说说～',
      tip: '小红书标题 ≤ 20 字，封面用视频里最有食欲的一帧。',
    },
  };
  const coverText = cut(rawHook && chars(rawHook).length >= 4 ? rawHook : firstSentence, 12);
  const allText = Object.values(pieces)
    .map(piece => `${piece.title}${piece.caption}${piece.pinnedComment}`)
    .join('');
  const warnings = [];
  if (RISKY.test(allText)) warnings.push('文案含绝对化或导流表述，发布前请删改（广告法与平台限流风险）。');
  if (!facts.length) warnings.push('脚本没有登记已确认事实，文案只复述口播，价格、地址等请发布前自行补充。');
  return { coverText, platforms: pieces, warnings };
}

export function publishKitText(piece) {
  if (!piece) return '';
  return [piece.title, '', piece.caption, '', piece.hashtags.map(tag => `#${tag}`).join(' '), '', `置顶评论：${piece.pinnedComment}`].join('\n');
}

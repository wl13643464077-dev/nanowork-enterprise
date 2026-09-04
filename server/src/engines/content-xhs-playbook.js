// ===== 小红书带货笔记方法论（撰稿人 idx 3 / 文风师 idx 4 共用）=====
// 纯函数、零 DB 依赖。派活源 catalog/content-crew.json 与 employee-skills.json
// 受指纹门禁保护，因此所有平台规则只在运行期编译进 prompt，并由
// content-output-contract.js 的 idx 3 小红书带货模式做机器校验。
//
// 本模块只提供：规则行、违禁词正则、文本级校验、模式判定与 few-shot 注入位。
// 门店事实包（M1）与爆款卡（M2）由调用方注入，这里不查库、不造表。

export const XHS_PLATFORM = '小红书';
export const XHS_SALES_TASK_TYPE = '小红书带货笔记';
export const XHS_SALES_CONTENT_TYPE = '小红书带货文案';
export const XHS_SALES_PROMPT_CODE = 'CON-COPY-XHS-SALES';

export const XHS_STRATEGIES = Object.freeze(['痛点型', '场景型', '对比型', '测评型']);
export const XHS_AUDIENCES = Object.freeze(['学生', '白领', '家庭', '约会', '其他']);
export const XHS_SALES_DEFAULT_VERSION_COUNT = 3;
export const XHS_SALES_MIN_VERSION_COUNT = 2;
export const XHS_SALES_MAX_VERSION_COUNT = XHS_STRATEGIES.length;

export const XHS_LIMITS = Object.freeze({
  titleMax: 20,
  coverTextMax: 8,
  bodyMax: 1000,
  bodyMin: 120,
  bodyFirstLineMax: 20,
  bodyMinParagraphs: 5,
  emojiMin: 1,
  emojiMax: 12,
  tagsMin: 5,
  tagsMax: 8,
  scoreMin: 1,
  scoreMax: 5,
  scoreNoteMax: 200,
  factsUsedMin: 2,
});

const AUDIENCE_PLAYBOOK = Object.freeze({
  学生: '学生客群：主打性价比、拼单/分食、人均可控与校园周边可达；语气轻松、少用职场词；性价比结论仍必须有事实包人均/售价支撑。',
  白领: '白领客群：主打午餐效率（出餐快、离办公区近）、一人食友好、减脂轻食可写"清爽/低负担"等体验描述，但不得写减肥/燃脂等功效词。',
  家庭: '家庭客群：主打分量与多人分享、儿童友好（餐椅/儿童餐具需事实包确认）、停车与等位体验；语气稳妥、少玩梗。',
  约会: '约会客群：主打氛围、拍照点位、安静座位与仪式感；避免"人挤人/排队"等热度话术，除非事实包有评价聚合支撑。',
  其他: '其他客群：先在 self_score.note 写明你推断的核心人群，再按其消费动机组织痛点与场景，不得同时讨好所有人群。',
});

const HOOK_TYPES = Object.freeze([
  '数字型：用可核验的数字制造具体感（如"3个人吃了两荤一素"），数字只能来自事实包或任务书。',
  '反常识型：用"别再…""原来…"打破读者默认认知，但结论必须能被正文证据支撑。',
  '身份代入型：用读者的身份标签开头（"打工人""带娃妈妈""期末周学生"），让人群一眼对号入座。',
]);

const EXTREME_WORD_SOURCE = [
  '最(?:好|佳|低|便宜|强|优|高|大|全|新|先进|棒|赞|香|好吃|划算|实惠|火|正宗|地道|受欢迎|顶级|高级|值)',
  '(?:全国|全网|全城|全市|全省|行业|销量|人气|口碑|地区|同城)第一',
  '第一(?:名|品牌|家店|选择)',
  '全网最低',
  '顶级',
  '国家级',
  '极致',
  '史上',
].join('|');
const EFFICACY_WORD_SOURCE = [
  '治疗',
  '治愈',
  '疗效',
  '减肥',
  '瘦身',
  '燃脂',
  '排毒',
  '降血糖',
  '降血压',
  '降血脂',
  '抗癌',
  '防癌',
  '美白',
  '抗衰',
  '养生功效',
].join('|');
const ABSOLUTE_WORD_SOURCE = [
  '100\\s*[%％]',
  '百分百',
  '百分之百',
  '永久',
  '绝对',
  '零差评',
].join('|');
const URGENCY_WORD_SOURCE = [
  '亏本',
  '清仓',
  '跳楼价',
  '最后一天',
  '仅此一天',
  '错过不再',
  '血亏',
  '倒闭价',
  '甩卖',
].join('|');
const FORBIDDEN_WORD_SOURCE = `(?:${EXTREME_WORD_SOURCE}|${EFFICACY_WORD_SOURCE}|${ABSOLUTE_WORD_SOURCE}|${URGENCY_WORD_SOURCE})`;

export const XHS_FORBIDDEN_WORD_GROUPS = Object.freeze({
  extreme: '极限词',
  efficacy: '功效词',
  absolute: '绝对化',
  urgency: '亏本清仓类',
});

/** 每次返回新实例（无 g 标记），可直接 .test()。 */
export function xhsForbiddenWordRegex() {
  return new RegExp(FORBIDDEN_WORD_SOURCE, 'u');
}

/** 列出文本中命中的违禁词（去重、保持出现顺序）。 */
export function findXhsForbiddenWords(text) {
  const source = String(text ?? '');
  if (!source) return [];
  const matcher = new RegExp(FORBIDDEN_WORD_SOURCE, 'gu');
  const found = [];
  for (const match of source.matchAll(matcher)) {
    const word = match[0];
    if (!found.includes(word)) found.push(word);
  }
  return found;
}

const PRICE_DIGIT_RE = /(?:[¥￥]\s*\d|\d+(?:\.\d+)?\s*(?:元|块钱?|人民币|RMB|r\b)|人均\s*[¥￥]?\s*\d)/iu;
const ADDRESS_DIGIT_RE = /(?:\d+\s*号(?:楼|铺|店)?|\d+\s*[楼层]|[路街巷道]\s*\d+|\d+\s*[米m]\b|地铁\s*\d+\s*号线)/iu;

/** 无事实包时，正文不得出现具体价格/地址数字；返回命中片段（可能为空数组）。 */
export function findXhsUngroundedConcreteDigits(text) {
  const source = String(text ?? '');
  const hits = [];
  const price = source.match(PRICE_DIGIT_RE);
  if (price) hits.push({ kind: 'price', raw: price[0] });
  const address = source.match(ADDRESS_DIGIT_RE);
  if (address) hits.push({ kind: 'address', raw: address[0] });
  return hits;
}

const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*|[\u{1F1E6}-\u{1F1FF}]{2}/gu;

export function countXhsEmoji(text) {
  const source = String(text ?? '');
  let count = 0;
  for (const _match of source.matchAll(EMOJI_RE)) count += 1;
  return count;
}

export function stripXhsEmoji(text) {
  return String(text ?? '').replace(EMOJI_RE, '');
}

/** 可见字数：去掉 emoji 与全部空白后的码点数。 */
export function xhsVisibleLength(text) {
  return [...stripXhsEmoji(text).replace(/\s+/gu, '')].length;
}

export function xhsBodyParagraphs(body) {
  return String(body ?? '')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean);
}

function cleanShort(value, max = 120) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

export function normalizeXhsAudience(value) {
  const text = cleanShort(value, 40);
  if (!text) return '';
  return XHS_AUDIENCES.includes(text) ? text : '其他';
}

export function normalizeXhsVersionCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count)) return XHS_SALES_DEFAULT_VERSION_COUNT;
  return Math.min(XHS_SALES_MAX_VERSION_COUNT, Math.max(XHS_SALES_MIN_VERSION_COUNT, count));
}

function platformListIncludesXhs(platforms) {
  return Array.isArray(platforms)
    && platforms.some(item => typeof item === 'string' && item.includes(XHS_PLATFORM));
}

const XHS_SALES_TYPE_RE = /小红书[^\n]{0,8}带货|带货[^\n]{0,8}小红书/u;

function taskTypeIsXhsSales(taskType) {
  const text = cleanShort(taskType, 120);
  return text === XHS_SALES_TASK_TYPE || text === XHS_SALES_CONTENT_TYPE || XHS_SALES_TYPE_RE.test(text);
}

/**
 * 统一模式判定：
 * - platformXhs：idx∈{3,4} 且平台含小红书（或任务类型即小红书带货）→ 注入方法论行；
 * - salesMode：idx===3 且任务类型/模板明确为小红书带货 → 输出契约切换为 versions 多版模式。
 * 平台默认值常为 ['小红书']，因此 salesMode 必须由明确的任务类型触发，不能只看平台。
 */
export function resolveXhsSalesMode({
  idx,
  taskType = '',
  template = '',
  platforms = [],
  direction = '',
  audience = '',
  scene = '',
  category = '',
  city = '',
  strategies,
  explicit = null,
} = {}) {
  const employeeIdx = Number(idx);
  if (explicit && typeof explicit === 'object' && typeof explicit.salesMode === 'boolean') {
    return Object.freeze({
      platformXhs: explicit.platformXhs === true || explicit.salesMode,
      salesMode: explicit.salesMode && employeeIdx === 3,
      audience: normalizeXhsAudience(explicit.audience),
      scene: cleanShort(explicit.scene, 120),
      category: cleanShort(explicit.category, 60),
      city: cleanShort(explicit.city, 40),
      versionCount: normalizeXhsVersionCount(explicit.versionCount ?? explicit.strategies),
    });
  }
  const salesTyped = taskTypeIsXhsSales(taskType) || taskTypeIsXhsSales(template)
    || (typeof direction === 'string' && /交付形式[：:]\s*小红书带货笔记/u.test(direction));
  const platformXhs = (employeeIdx === 3 || employeeIdx === 4)
    && (platformListIncludesXhs(platforms) || salesTyped);
  return Object.freeze({
    platformXhs,
    salesMode: employeeIdx === 3 && salesTyped,
    audience: normalizeXhsAudience(audience),
    scene: cleanShort(scene, 120),
    category: cleanShort(category, 60),
    city: cleanShort(city, 40),
    versionCount: normalizeXhsVersionCount(strategies),
  });
}

/** 编译、生成和复验共用同一锁定模式；默认平台不触发多版输出。 */
export function resolveXhsSalesContext(idx, context = {}) {
  const task = context.task || context.brief || {};
  return resolveXhsSalesMode({
    idx, taskType: task.type || context.taskType, template: task.template,
    platforms: task.platforms || context.platforms, direction: task.direction,
    strategies: task.xhsOptions?.versionCount, audience: task.xhsOptions?.audience,
    scene: task.xhsOptions?.scene, category: task.xhsOptions?.category, city: task.xhsOptions?.city,
    explicit: context.xhsSales,
  });
}

/**
 * 方法论规则行。audience/scene/category/city 只影响“本次客群/场景”那几行，
 * 其余规则稳定，便于快照测试。
 */
export function xhsSalesPlaybookLines({ audience = '', scene = '', category = '', city = '' } = {}) {
  const normalizedAudience = normalizeXhsAudience(audience);
  const sceneText = cleanShort(scene, 120);
  const categoryText = cleanShort(category, 60);
  const cityText = cleanShort(city, 40);
  const lines = [
    '【小红书带货笔记方法论·运行期注入，只追加不覆盖岗位契约】',
    `1. 标题：≤${XHS_LIMITS.titleMax}字；按"四件套"组合=人群+场景+结果+悬念，至少命中3件；钩子只用三型之一：`,
    ...HOOK_TYPES.map(item => `   - ${item}`),
    `2. 封面文案：≤${XHS_LIMITS.coverTextMax}字，只放一个卖点或一个情绪词，不写价格、不写极限词。`,
    '3. 正文固定五段：痛点→场景→菜品→证据→行动。菜品段只能引用门店事实包中的菜名/售价/人均并登记 facts_used；证据段只用评价聚合口径（条数/均分/高频词）或实拍画面描述，不搬顾客原话；行动段只给一个明确动作。',
    `4. 排版：每2–3行换行；段首最多1个 emoji，全文 emoji ${XHS_LIMITS.emojiMin}–${XHS_LIMITS.emojiMax} 个，不连排、不刷屏；正文≤${XHS_LIMITS.bodyMax}字、首行≤${XHS_LIMITS.bodyFirstLineMax}字、至少${XHS_LIMITS.bodyMinParagraphs}个短段。`,
    '5. 话题标签6个：大词2个（城市美食/探店类）+ 精准词2个（品类/菜名）+ 同城或长尾2个（城市+商圈、人群+场景）；tags 只写文字不带#。',
    '6. 评论区引导：结尾放1个具体、读者能直接回答的问题（必须带问号），如"你们午饭一般能给自己留几分钟？"；不问"喜欢吗/想吃吗"这类空问题。',
    '7. 避雷词一律不得出现在标题、封面、正文、标签与评论引导：极限词（最好/最佳/最低/第一/全网最低/顶级/国家级/极致）、功效词（治疗/减肥/燃脂/排毒/降血糖）、绝对化（100%/百分百/永久/绝对/零差评）、亏本/清仓/跳楼价/最后一天类紧迫话术。',
    '8. AI 辅助声明：在自评 note 或发布备注提醒老板按平台要求标注"AI 辅助创作"；正文不得伪装真人亲历（"我吃过/亲测"仍受事实门禁约束）。',
    '9. 目标客群与场景映射：学生→性价比/拼单；白领→午餐效率/减脂轻食（不写功效）；家庭→分量/儿童友好；约会→氛围/拍照点。',
    `   本次客群：${normalizedAudience || '未指定（按场景推断并在 self_score.note 说明）'}${normalizedAudience ? `。${AUDIENCE_PLAYBOOK[normalizedAudience]}` : ''}`,
    `10. 本次场景：${sceneText || '待补充'}；品类：${categoryText || '待补充'}；城市：${cityText || '待补充'}。缺失项只写"待补充"，不得编造商圈、门店位置或人群画像。`,
  ];
  return lines;
}

/** 三版策略互异 + 自评分指令（仅 salesMode 注入）。 */
export function xhsSalesVersionInstructionLines({ versionCount = XHS_SALES_DEFAULT_VERSION_COUNT, hasFactPack = null } = {}) {
  const count = normalizeXhsVersionCount(versionCount);
  return [
    `【小红书带货多版输出·恰好 ${count} 版策略互异 + 自评分】`,
    `- 顶层输出 versions 数组，恰好 ${count} 项；每项 strategy 从「${XHS_STRATEGIES.join('/')}」中选取且互不相同；framework_ref 写明所用结构或对标卡编号（如"痛点→场景→菜品→证据→行动"）。`,
    '- 每版字段：strategy、framework_ref、title、cover_text、body、tags、comment_prompt、facts_used、self_score；每版独立成稿，同一事实可复用但切入角度必须不同。',
    `- self_score：hook/credibility/conversion 各为 ${XHS_LIMITS.scoreMin}–${XHS_LIMITS.scoreMax} 的整数，note ≤${XHS_LIMITS.scoreNoteMax}字写明打分理由与主要风险；总分最高只作为推荐，必须由老板显式选择发布版本。顶层不输出 title_candidates/body/tags。`,
    '- 顶层仍需输出 image_plan（2–4个配图点位，服务首选版）。',
    hasFactPack === false
      ? '- 本次没有可引用的门店事实包：facts_used 输出空数组；所有对外字段不得出现具体价格、人均、门牌号、楼层、地铁线路等数字，只能写"待补充"。'
      : `- 以本次用户消息内的门店事实包为准：有可公开事实时，每版 facts_used 至少登记 ${XHS_LIMITS.factsUsedMin} 个不同的 { claim, factId }，claim 逐字复制对应事实声明；内部证据不得登记或原句引用。无可公开事实时 facts_used 必须为空，所有对外字段不得出现具体价格、地址数字。`,
    '- 对比型只能对比本店不同菜品/时段/吃法或已核验事实，不得贬低具名竞品；测评型只能测评事实包里存在的维度。',
  ];
}

/**
 * 爆款学习 few-shot 注入位。卡片由 M2（content_benchmark_cards）提供；
 * 这里只做轻渲染，无卡时返回空数组，编译器据此跳过整段。
 */
export function xhsBenchmarkFewShotLines(cards, { platform = XHS_PLATFORM, limit = 3 } = {}) {
  if (!Array.isArray(cards) || !cards.length) return [];
  const cap = Math.max(1, Math.min(6, Number(limit) || 3));
  const picked = cards
    .filter(card => card && typeof card === 'object')
    .filter(card => !card.platform || String(card.platform).includes(platform))
    .slice(0, cap);
  if (!picked.length) return [];
  const lines = ['【爆款结构参考·仅学结构与节奏，不得抄标题、不得把样本数据当本店事实】'];
  picked.forEach((card, index) => {
    const label = cleanShort(card.title || card.name || card.id || `卡片${index + 1}`, 60);
    const structure = cleanShort(card.structure || card.framework || card.summary || '', 200);
    const hook = cleanShort(card.hook || card.hookType || '', 80);
    const ref = cleanShort(card.id || card.cardId || '', 60);
    lines.push(
      `${index + 1}. ${label}${ref ? `（framework_ref 可写 ${ref}）` : ''}${hook ? `｜钩子：${hook}` : ''}${structure ? `｜结构：${structure}` : ''}`,
    );
  });
  return lines;
}

/**
 * 单版文本级校验（不含事实包校验）。返回错误字符串数组；path 用于报错定位。
 */
export function xhsSalesVersionTextIssues(version, { path = 'versions[0]', requireFactPack = null } = {}) {
  const errors = [];
  if (!version || typeof version !== 'object' || Array.isArray(version)) {
    return [`字段“${path}”必须是JSON对象。`];
  }
  const title = typeof version.title === 'string' ? version.title.trim() : '';
  const titleLength = xhsVisibleLength(title);
  if (titleLength > XHS_LIMITS.titleMax) {
    errors.push(`字段“${path}.title”小红书标题最多${XHS_LIMITS.titleMax}字，当前${titleLength}字。`);
  }
  const cover = typeof version.cover_text === 'string' ? version.cover_text.trim() : '';
  if (!cover) {
    errors.push(`字段“${path}.cover_text”必须是非空字符串。`);
  } else if (xhsVisibleLength(cover) > XHS_LIMITS.coverTextMax) {
    errors.push(`字段“${path}.cover_text”封面文案最多${XHS_LIMITS.coverTextMax}字，当前${xhsVisibleLength(cover)}字。`);
  }
  const body = typeof version.body === 'string' ? version.body : '';
  const bodyLength = [...body.trim()].length;
  if (bodyLength > XHS_LIMITS.bodyMax) {
    errors.push(`字段“${path}.body”小红书正文最多${XHS_LIMITS.bodyMax}字，当前${bodyLength}字。`);
  }
  const paragraphs = xhsBodyParagraphs(body);
  if (paragraphs.length && xhsVisibleLength(paragraphs[0]) > XHS_LIMITS.bodyFirstLineMax) {
    errors.push(`字段“${path}.body”首行是3秒钩子，最多${XHS_LIMITS.bodyFirstLineMax}字，当前${xhsVisibleLength(paragraphs[0])}字。`);
  }
  if (paragraphs.length < XHS_LIMITS.bodyMinParagraphs) {
    errors.push(`字段“${path}.body”必须是小红书短段落排版，至少${XHS_LIMITS.bodyMinParagraphs}个换行分隔的段落，当前${paragraphs.length}个；不得写成公众号长段。`);
  }
  const emojiCount = countXhsEmoji(body);
  if (emojiCount < XHS_LIMITS.emojiMin || emojiCount > XHS_LIMITS.emojiMax) {
    errors.push(`字段“${path}.body”emoji 数量必须在${XHS_LIMITS.emojiMin}–${XHS_LIMITS.emojiMax}个之间，当前${emojiCount}个。`);
  }
  const comment = typeof version.comment_prompt === 'string' ? version.comment_prompt.trim() : '';
  if (!comment) {
    errors.push(`字段“${path}.comment_prompt”必须是非空字符串。`);
  } else if (!/[？?]/u.test(comment)) {
    errors.push(`字段“${path}.comment_prompt”必须是一个带问号的具体问题。`);
  }
  const outward = [
    ['title', title],
    ['cover_text', cover],
    ['body', body],
    ['comment_prompt', comment],
    ...(Array.isArray(version.tags) ? version.tags.map((tag, index) => [`tags[${index}]`, tag]) : []),
  ];
  for (const [field, text] of outward) {
    const hits = findXhsForbiddenWords(text);
    if (hits.length) {
      errors.push(`字段“${path}.${field}”命中小红书避雷词：${hits.join('、')}；极限词、功效词、绝对化与亏本清仓话术不得出现。`);
    }
  }
  if (requireFactPack === false) {
    for (const [field, text] of [['title', title], ['body', body]]) {
      const digits = findXhsUngroundedConcreteDigits(text);
      if (digits.length) {
        errors.push(`字段“${path}.${field}”在没有门店事实包时出现了具体${digits.map(item => (item.kind === 'price' ? '价格' : '地址')).join('/')}数字“${digits.map(item => item.raw).join('、')}”，必须改写为"待补充"。`);
      }
    }
  }
  return errors;
}

export function xhsSelfScoreTotal(selfScore) {
  if (!selfScore || typeof selfScore !== 'object') return 0;
  return ['hook', 'credibility', 'conversion']
    .map(key => Number(selfScore[key]))
    .filter(score => Number.isInteger(score))
    .reduce((sum, score) => sum + score, 0);
}

/** 自评总分最高的版本下标（并列取先出现者）；versions 非法时返回 -1。 */
export function xhsPreferredVersionIndex(versions) {
  if (!Array.isArray(versions) || !versions.length) return -1;
  let best = -1;
  let bestScore = -Infinity;
  versions.forEach((version, index) => {
    if (!version || typeof version !== 'object') return;
    const total = xhsSelfScoreTotal(version.self_score);
    if (total > bestScore) {
      bestScore = total;
      best = index;
    }
  });
  return best;
}

#!/usr/bin/env node
// 把分部调研产出的「专家卡」追加进技能补充包（只追加、原卡零改动）。
//
// 用法：node scripts/merge-expert-cards.mjs [--dry-run]
// 输入：docs/expert-cards-2026-11/dept-*.json（调研原件，含每张卡的来源、置信度与口径说明）
// 输出：server/catalog/employee-skills-supplement.json
//
// 幂等：每次先移除上一次写入的专家卡（id 以 supp-2026-11b: 开头）再整体重写，重复执行结果一致。
// 不触碰 server/catalog/employee-skills.json 与 restaurant.json（SHA-256 锁）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const inputDir = path.join(root, 'docs/expert-cards-2026-11');
const packPath = path.join(root, 'server/catalog/employee-skills-supplement.json');
const dryRun = process.argv.includes('--dry-run');

const EXPERT_PREFIX = 'supp-2026-11b:';
const TYPE_LABEL = { BENCH: '专家卡·行业基准', REG: '专家卡·法规条款', METHOD: '专家卡·诊断方法', PITFALL: '专家卡·常见误判' };
const length = value => [...String(value ?? '')].length;

// 对标样本所属业态。线上实测（任务 #556）发现：卡片把几家公司的数字并排写，模型会把小菜园、九毛九的数
// 也当成“火锅”样本。合并时在每张卡里给每个品牌首次出现处补上业态标注，调研原件不改。
const BRAND_FORMATS = [
  [['海底捞'], '火锅'],
  [['怂火锅', '怂'], '火锅'],
  [['湊湊', '凑凑'], '火锅'],
  [['呷哺呷哺', '呷哺'], '小火锅'],
  [['小菜园'], '大众中餐'],
  [['绿茶'], '休闲中餐'],
  [['九毛九'], '多品牌集团，酸菜鱼为主'],
  [['太二'], '酸菜鱼'],
  [['百胜中国'], '西式快餐'],
  [['肯德基'], '西式快餐'],
  [['必胜客'], '休闲西餐'],
  [['遇见小面'], '面馆快餐'],
  [['瑞幸'], '咖啡'],
  [['蜜雪冰城', '蜜雪'], '茶饮'],
  [['古茗'], '茶饮'],
  [['奈雪'], '茶饮'],
];
const BRAND_LOOKUP = new Map(BRAND_FORMATS.flatMap(([aliases, format], group) => aliases.map(alias => [alias, { format, group }])));
const BRAND_PATTERN = new RegExp(
  [...BRAND_LOOKUP.keys()].sort((a, b) => b.length - a.length).join('|'),
  'gu',
);
function tagBrandFormats(detail) {
  const tagged = new Set();
  return String(detail).replace(BRAND_PATTERN, (name, offset, whole) => {
    const { format, group } = BRAND_LOOKUP.get(name);
    if (tagged.has(group) || whole.startsWith('〔', offset + name.length)) return name;
    tagged.add(group);
    return `${name}〔${format}〕`;
  });
}
const fingerprint = card =>
  `sha256:${crypto.createHash('sha256').update(JSON.stringify([card.title, card.detail, card.source])).digest('hex')}`;

const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
const profiles = new Map(pack.profiles.filter(profile => profile.catalog !== 'content').map(profile => [profile.idx, profile]));

// 上一轮补充卡里已核实的错误，按 id 修正正文（见 docs/expert-cards-2026-11/README.md）。
const CORRECTIONS = {
  'supp-2026-11:118:01': {
    detail:
      '冷藏 0~8℃、冷冻宜低于 -12℃（《餐饮服务食品安全操作规范》术语定义）；门店点检表以此为准。冷链物流环节另有 GB 31605 的冷藏 0~10℃、冷冻不高于 -18℃，只用于运输与到货交接，不要拿来当门店冰箱的合格线。海外 41°F/TPHC 做法作参考。',
  },
};

const files = fs.readdirSync(inputDir).filter(name => /^dept-.*\.json$/u.test(name)).sort();
if (!files.length) throw new Error(`没有找到调研原件：${inputDir}`);

const incoming = new Map();
const titles = new Set();
for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.join(inputDir, file), 'utf8'));
  for (const employee of data.employees || []) {
    const profile = profiles.get(employee.idx);
    if (!profile) throw new Error(`${file}：补充包里没有员工 ${employee.idx}`);
    if (profile.person !== employee.person) throw new Error(`${file}：员工 ${employee.idx} 姓名不一致`);
    if (incoming.has(employee.idx)) throw new Error(`${file}：员工 ${employee.idx} 重复出现`);
    const cards = employee.cards.map((card, index) => {
      const where = `${file} ${employee.idx}#${index + 1}「${card.title}」`;
      if (!TYPE_LABEL[card.type]) throw new Error(`${where}：未知类型 ${card.type}`);
      if (!card.title || length(card.title) > 22) throw new Error(`${where}：标题须为 1–22 字`);
      if (length(card.detail) < 100 || length(card.detail) > 300) throw new Error(`${where}：正文须为 100–300 字`);
      const detail = tagBrandFormats(card.detail);
      if (/https?:\/\//u.test(`${card.title}${card.detail}`)) throw new Error(`${where}：正文不得含链接`);
      if (!/^https?:\/\//u.test(card.sourceUrl || '')) throw new Error(`${where}：缺少来源链接`);
      if (!['high', 'medium'].includes(card.confidence)) throw new Error(`${where}：置信度须为 high/medium`);
      if (titles.has(card.title)) throw new Error(`${where}：标题重复`);
      titles.add(card.title);
      const merged = {
        id: `${EXPERT_PREFIX}${employee.idx}:${String(index + 1).padStart(2, '0')}`,
        title: card.title,
        detail,
        source: card.source,
        sourceUrl: card.sourceUrl,
        sourceDate: String(card.sourceDate || ''),
        gap: 'EXPERT',
        gapNote: TYPE_LABEL[card.type],
        cardType: card.type,
        confidence: card.confidence,
        expertNote: String(card.note || '').trim(),
        origin: 'supplement_2026_11',
        appendOnly: true,
        enabled: true,
        locked: false,
        verificationStatus: 'supplement_pending_owner_review',
      };
      merged.fingerprint = fingerprint(merged);
      return merged;
    });
    incoming.set(employee.idx, cards);
  }
}

let corrected = 0;
for (const profile of pack.profiles) {
  const kept = profile.skills.filter(card => !String(card.id).startsWith(EXPERT_PREFIX));
  for (const card of kept) {
    const fix = CORRECTIONS[card.id];
    if (fix && card.detail !== fix.detail) {
      card.detail = fix.detail;
      card.fingerprint = fingerprint(card);
      card.correctedAt = '2026-11-25';
      corrected += 1;
    }
  }
  const expert = profile.catalog === 'content' ? [] : incoming.get(profile.idx) || [];
  profile.skills = [...kept, ...expert];
  profile.supplementSkillCount = profile.skills.length;
}

const restaurant = pack.profiles.filter(profile => profile.catalog !== 'content');
const expertCards = restaurant.flatMap(profile => profile.skills.filter(card => String(card.id).startsWith(EXPERT_PREFIX)));
const countBy = key => expertCards.reduce((acc, card) => ({ ...acc, [card[key]]: (acc[card[key]] || 0) + 1 }), {});
pack.stats = {
  ...pack.stats,
  restaurantSupplementCards: restaurant.reduce((sum, profile) => sum + profile.skills.length, 0),
  expertCards: expertCards.length,
  expertCardsByType: countBy('cardType'),
  expertCardsByConfidence: countBy('confidence'),
  employeesWithoutExpertCards: restaurant
    .filter(profile => !profile.skills.some(card => String(card.id).startsWith(EXPERT_PREFIX)))
    .map(profile => profile.idx),
};
pack.expertPack = {
  generatedAt: '2026-11-25',
  idPrefix: EXPERT_PREFIX,
  researchFiles: files.map(name => `docs/expert-cards-2026-11/${name}`),
  note: '专家卡与此前的补充卡走同一套审核：老板/管理员在员工技能页启用后才进入派活提示词。confidence=medium 的卡出自媒体或二手转述，启用前建议复核。',
};

console.log(
  `专家卡 ${expertCards.length} 张 / 员工 ${incoming.size} 位；类型 ${JSON.stringify(pack.stats.expertCardsByType)}；置信度 ${JSON.stringify(pack.stats.expertCardsByConfidence)}；修正旧卡 ${corrected} 张`,
);
if (pack.stats.employeesWithoutExpertCards.length) console.warn(`没有专家卡的员工：${pack.stats.employeesWithoutExpertCards.join(', ')}`);
if (dryRun) console.log('（--dry-run：未写入）');
else fs.writeFileSync(packPath, JSON.stringify(pack, null, 1)); // 与原文件一致：缩进 1、无结尾换行

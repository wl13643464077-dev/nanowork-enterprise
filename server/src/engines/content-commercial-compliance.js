// 商业化内容合规扫描（小红书 / 抖音 / 视频号 通用，2026 平台规则口径）。
//
// 与 risk.js（企业自定义敏感词、审批触发）分工：这里是“发出去会被平台限流或违反
// 广告法”的平台侧红线与软风险，按分组给出老板能懂的说明和合规替换建议。
// 输出只用于两件事：①生成阶段写进提示词让模型不要写；②产出阶段扫描并把命中
// 逐条列给老板（硬红线阻断/软风险提醒），不静默改写老板要发布的文案。

import { findXhsForbiddenWords } from './content-xhs-playbook.js';

const GROUPS = Object.freeze([
  {
    key: 'extreme',
    label: '极限词/绝对化（广告法第九条）',
    severity: 'block',
    // 基础“最/第一/顶级/100%/亏本”交给 content-xhs-playbook 的既有词表；这里补 2026 平台严查的网络衍生与等级夸大类。
    pattern: /(?:yyds|天花板|封神|绝绝子|绝版|绝无仅有|无敌|完美|独家(?:秘方|原料|配方)?|唯一|仅此一家|首款|首发|首个|无可替代|世界级|宇宙级|顶尖|特级|鼎级|鼻祖|王牌|销冠|榜首|TOP\s*1|NO\.?\s*1|万能|终身有效|根治|全部消除|全民(?:最爱|种草)|人手必备|博主首选)/iu,
    suggestion: '改成可核验的相对描述：口碑不错 / 很多人回购 / 人气单品 / 我们店的招牌做法。',
  },
  {
    key: 'medical',
    label: '医疗/功效宣称（食品不得宣传治疗保健）',
    severity: 'block',
    pattern: /(?:增强免疫力|提高免疫|提高记忆力|健脑|延年益寿|调理三高|祛湿|止咳|化痰|护肝|排毒|消炎|杀菌|抑菌|抗炎|防癌|抗癌|降血糖|降血压|降血脂|减肥|瘦身|燃脂|美白|抗衰|养胃|补肾|壮阳|治疗|疗效|药用|医用|祖传秘方|宫廷秘方)/u,
    suggestion: '食品只说食材、做法与口味：改成“用了 XX 食材”“适合晚上吃点清淡的”，不写功效。',
  },
  {
    key: 'diversion',
    label: '站外/私域导流（小红书第一红线）',
    severity: 'block',
    pattern: /(?:微信|weixin|wechat|vx\b|v信|加\s*v\b|加我(?!们)|二维码|扫码加|扫码领|私信领取|私信领|进群|拉群|淘宝|天猫|京东|拼多多|抖音搜|App\s*搜|小程序搜|公众号|手机号|1[3-9]\d{9})/iu,
    suggestion: '正文与首评不出现任何站外/私域指向；地址、营业时间、菜单放主页“店铺地址”和简介，首评只引导评论区提问。',
  },
  {
    key: 'inducement',
    label: '诱导互动（平台降权）',
    severity: 'warn',
    pattern: /(?:一键三连|求点赞|求收藏|求关注|互关|互赞|刷赞|点赞过\s*\d+|收藏过\s*\d+|不点赞|先赞后看|关注不迷路)/u,
    suggestion: '用具体问题带动评论（“你们会先涮肉还是先下菜？”），不写求赞求藏。',
  },
  {
    key: 'urgency',
    label: '虚假紧迫/促销（需有真实活动依据）',
    severity: 'warn',
    pattern: /(?:疯抢|秒杀|抢购|限时\s*\d*\s*小时|仅限今天|仅限今日|今天最后|手慢无|错过等一年|全场\s*\d+\s*折|买一送一|免单)/u,
    suggestion: '促销只写老板确认的活动名、价格、期限与限制条件；没有活动就不写促销语。',
  },
  {
    key: 'endorsement',
    label: '虚假背书（无授权不得使用）',
    severity: 'warn',
    pattern: /(?:央视|CCTV|明星同款|明星都在吃|专家推荐|权威认证|官方认证|国家认证|米其林|黑珍珠|必吃榜|大众点评第一|网红打卡地)/iu,
    suggestion: '有证书/榜单就写具体名称与年份并保留凭证；没有就删掉。',
  },
]);

export const COMMERCIAL_COMPLIANCE_GROUPS = Object.freeze(
  GROUPS.map(({ key, label, severity }) => ({ key, label, severity })),
);

function scanGroup(group, text) {
  const matcher = new RegExp(group.pattern.source, `${group.pattern.flags.replace('g', '')}g`);
  const words = [];
  for (const match of String(text || '').matchAll(matcher)) {
    const word = match[0].trim();
    if (word && !words.includes(word)) words.push(word);
  }
  return words;
}

/**
 * 扫描对外文案（标题/正文/首评/标签/字幕/口播）。
 * @returns {{ level:'none'|'warn'|'block', blocked:boolean, hits:Array<{group,label,severity,words,suggestion}> }}
 */
export function scanCommercialCompliance(text, { platform = 'xhs' } = {}) {
  const source = String(text || '');
  const hits = [];
  const baseWords = findXhsForbiddenWords(source);
  if (baseWords.length) {
    hits.push({
      group: 'extreme_base',
      label: '极限词/功效词/绝对化/亏本清仓（基础词表）',
      severity: 'block',
      words: baseWords,
      suggestion: '删掉“最/第一/100%/亏本清仓/治疗减肥”类表述，改成可核验的具体描述。',
    });
  }
  for (const group of GROUPS) {
    // 抖音团购视频允许口播“左下角团购/点击团购”，不属于站外导流；小红书正文则一律不出现。
    const words = scanGroup(group, source);
    if (!words.length) continue;
    hits.push({ group: group.key, label: group.label, severity: group.severity, words, suggestion: group.suggestion });
  }
  const blocked = hits.some(hit => hit.severity === 'block');
  return {
    platform,
    level: blocked ? 'block' : hits.length ? 'warn' : 'none',
    blocked,
    hits,
  };
}

/** 给老板看的逐条提醒（可直接放进 warnings）。 */
export function commercialComplianceWarnings(text, options = {}) {
  const scan = scanCommercialCompliance(text, options);
  return scan.hits.map(hit =>
    `${hit.severity === 'block' ? '【发布前必改】' : '【建议调整】'}${hit.label}：“${hit.words.slice(0, 6).join('”“')}”。${hit.suggestion}`,
  );
}

/** 写进生成提示词的合规段落（平台通用 + 平台差异）。 */
export function commercialCompliancePromptLines({ platform = 'xhs' } = {}) {
  const lines = [
    '【平台合规硬门·2026】以下词一律不写，谐音/拼音/符号拆分同样违规：',
    '- 极限词与绝对化：最/第一/顶级/唯一/独家/首发/100%/永久/完美/无敌/yyds/天花板/绝绝子/封神/国家级/世界级/顶尖/鼻祖/王牌/销冠。',
    '- 医疗与功效：治疗/疗效/增强免疫力/排毒/祛湿/降三高/减肥/美白/抗衰/养胃/秘方；食品只说食材、做法、口味。',
    '- 虚假背书：央视/明星同款/专家推荐/权威认证/米其林/必吃榜等，除非用户明确提供凭证。',
    '- 虚假紧迫：疯抢/秒杀/仅限今天/手慢无/买一送一/免单，除非用户确认了真实活动、价格与期限。',
    '- 诱导互动：求点赞/求收藏/求关注/一键三连/关注不迷路。',
  ];
  if (platform === 'xhs') {
    lines.push(
      '- 站外与私域导流（小红书第一红线）：微信/VX/加V/二维码/私信领取/进群/淘宝/京东/手机号/公众号一律不出现；地址与菜单靠主页“店铺地址”和简介承接，首评只引导评论区提问。',
      '- 商业内容如属品牌合作需按平台要求标注；价格、原价、赠品、活动期限必须真实可核验。',
    );
  } else {
    lines.push(
      '- 抖音本地生活：团购权益、有效期、使用限制必须口语化复述；“左下角团购/到店核销”只有在用户确认已上架团购时才能出现；不写微信/二维码/站外链接。',
    );
  }
  return lines;
}

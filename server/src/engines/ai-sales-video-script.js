// AI 带货员 · 15/30 秒中文独白脚本引擎（文本模型 + 纯函数契约校验）
//
// 老板决策：带货视频必须有中文独白，脚本由文本模型按 json_schema 产出，
// 不允许常量模板冒充（D-019）。失败路径：首轮 → 带首轮产物与错误清单的一次
// 修复重试 → 仍失败则 blocked，给出可读原因，不回退模板。
//
// 契约（validateAiSalesVideoScript，纯函数，可独立测试）：
// - 默认1段0–15s；明确选择30秒时2段0–15s、15–30s；
// - 原生声音允许短独白和环境音留白；字数只给节奏建议，不触发付费重写；
// - 历史外部 TTS 脚本保留原 3.5–4.5 字/秒校验，供旧任务恢复；
// - hook_3s 非空，且是第 1 段口播的前缀或首句；
// - 最后一段含自然行动邀请（如到店咨询），不编造优惠口令或交易渠道；
// - facts_used 用门店事实包 validateFactsUsed 闭合；口播/字幕里出现的价格、
//   地址、菜名必须来自事实包，否则拒；
// - risk_flags 非空或命中 risk.js 禁用词 → 拒；
// - 每段以完整句（。！？）收尾；reference_hint ∈ person|dish|storefront。

import { validateFactsUsed } from './content-store-facts.js';
import { validateStoreFactClosure } from './content-output-contract.js';
import { contentBenchmarkFewShotBlock } from './content-benchmark-cards.js';
import { evolutionNotesPromptLines, sanitizeEvolutionNotesForPrompt } from './employee-evolution-prompt.js';
import { resolveAiSalesVideoDuration } from './ai-sales-video-duration.js';

export const AI_SALES_VIDEO_SCRIPT_SCHEMA_NAME = 'ai_sales_video_script';
export const AI_SALES_VIDEO_SCRIPT_SHOT_COUNT = 2;
export const AI_SALES_VIDEO_SCRIPT_SHOT_SECONDS = 15;
export const AI_SALES_VIDEO_SCRIPT_TOTAL_SECONDS = 30;
export const AI_SALES_VIDEO_CHARS_PER_SECOND_MIN = 3.5;
export const AI_SALES_VIDEO_CHARS_PER_SECOND_MAX = 4.5;
export const AI_SALES_VIDEO_HOOK_MAX_CHARS = 14; // 3 秒 × 4.5 字/秒，向上取整
export const AI_SALES_VIDEO_REFERENCE_HINTS = Object.freeze(['person', 'dish', 'storefront']);
export const AI_SALES_VIDEO_SCRIPT_MAX_ATTEMPTS = 2;
export const AI_SALES_NATIVE_NARRATION_STYLE = '一位成年女性用自然普通话说话，像与朋友聊天；情绪轻松亲切，温暖清楚的音色，正常说话音高，随句意有轻重、停顿和轻微换气，语速从容自然';
export const AI_SALES_NATIVE_NARRATION_TIMING = 'native_pause_v1';

// Wan2.6 generates speech when audio_url is omitted. Keep narration explicit;
// the app adds subtitles after generation and records their estimated timing.
export function wanNativeAudioPrompt(shot, { durationSeconds = 15, segmentDurationSeconds = 15, singleGeneration = false } = {}) {
  const multiple = resolveAiSalesVideoDuration(durationSeconds) === 30 && !singleGeneration;
  const segmentSeconds = singleGeneration ? resolveAiSalesVideoDuration(segmentDurationSeconds) : 15;
  return [
    `【画面，不朗读】${String(shot?.visual || '').trim()}`,
    '参考图确定主体、场景和品牌。保留标牌文字、菜品和光线，只做轻微运动或缓慢单向运镜；单镜头、首尾平稳，不改造门头。',
    `本段${segmentSeconds}秒，由Wan原生生成普通话中文独白和视频。`,
    `【声音设定，不朗读】${AI_SALES_NATIVE_NARRATION_STYLE}。`,
    `开头留短暂环境音再自然起句，尽量在${segmentSeconds - 1}秒前说完整句，句间可停顿和换气；结尾保留环境音，不把一句话跨过片段边界。`,
    `请完整说出以下中文内容：「${String(shot?.voiceover || '').trim()}」`,
    `没有人物参考时使用画外音，不增加人物。${multiple ? '两段使用相同声音设定。' : ''}只说给定台词，不朗读画面或制作指令。`,
    '人声近而清楚，保留轻微现场环境音；无广告配乐、无混响，不唱歌、不喊口号，不生成画面字幕或额外促销文字。',
    `说完后自然停留，不为填满${segmentSeconds}秒重复或新增台词。`,
  ]
    .join('\n');
}

const CTA_ACTION_RE =
  /(?:到店|进店|来店|(?:来|到)[^，。！？]{1,30}(?:坐坐|聚聚|看看|吃饭|用餐|聚餐)|点外卖|外卖搜|搜[「“"]?[^，。！？]{1,12}|下单|扫码|私信|预约|订座|报[我暗]|说[「“"]?[^，。！？]{1,10}|导航|来[找吃喝试])/u;
const SENTENCE_END_RE = /[。！？!?]$/u;
const PRICE_RE = /(\d+(?:\.\d+)?)\s*(?:元|块|块钱|￥|¥)|[¥￥]\s*(\d+(?:\.\d+)?)/gu;
const ADDRESS_HINT_RE =
  /(?:地址|位于|坐落|就在[^，。！？]{1,14}(?:路|街|巷|大道|广场|商场|中心|口|站)|\d+\s*号[楼铺]?|[^，。！？]{1,8}(?:路|街|大道)\d*号)/u;
const CJK_OR_ALNUM_RE = /[\p{Script=Han}\p{L}\p{N}]/u;

export class AiSalesVideoScriptError extends Error {
  constructor(
    message,
    { code = 'AI_SALES_VIDEO_SCRIPT_BLOCKED', status = 409, errors = [], attempts = [], usage = null } = {},
  ) {
    super(message);
    this.name = 'AiSalesVideoScriptError';
    this.code = code;
    this.status = status;
    this.blocked = true;
    this.errors = errors;
    this.attempts = attempts;
    this.usage = usage;
  }
}

function blocked(message, extra = {}) {
  return new AiSalesVideoScriptError(message, extra);
}

function text(value, max = 4000) {
  return String(value == null ? '' : value)
    .replace(/\r/gu, '')
    .trim()
    .slice(0, max);
}

function normalizeForCompare(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s「」『』“”"'‘’《》〈〉【】\[\]()（）、，。！？!?,.:：;；…~～-]+/gu, '')
    .toLowerCase();
}

/** 只统计汉字、字母、数字，标点与空白不计入口播字数。 */
export function countSpeechChars(value) {
  let count = 0;
  for (const character of String(value || '')) {
    if (CJK_OR_ALNUM_RE.test(character)) count += 1;
  }
  return count;
}

/** 按中文句读切分口播，供字幕逐句时间轴使用。 */
export function splitSpeechSentences(value, { maxChars = 18 } = {}) {
  const raw = String(value || '').replace(/\s+/gu, '');
  if (!raw) return [];
  const pieces = raw
    .split(/(?<=[。！？!?；;，,、])/u)
    .map(part => part.trim())
    .filter(Boolean);
  const output = [];
  for (const piece of pieces) {
    const chars = Array.from(piece);
    if (chars.length <= maxChars) {
      output.push(piece);
      continue;
    }
    for (let index = 0; index < chars.length; index += maxChars) {
      output.push(chars.slice(index, index + maxChars).join(''));
    }
  }
  return output;
}

function firstSentence(value) {
  return splitSpeechSentences(value, { maxChars: 200 })[0] || '';
}

function factText(fact) {
  const parts = [String(fact?.claim || '')];
  if (typeof fact?.value === 'string') parts.push(fact.value);
  else if (fact?.value && typeof fact.value === 'object') parts.push(JSON.stringify(fact.value));
  return parts.join(' ');
}

function factPrices(facts) {
  const numbers = new Set();
  for (const fact of facts) {
    if (!['dish_price', 'avg_ticket'].includes(fact?.kind)) continue;
    const source = factText(fact);
    for (const match of source.matchAll(/(\d+(?:\.\d+)?)/gu)) {
      numbers.add(Number(match[1]).toString());
    }
  }
  return numbers;
}

function quotedName(fact) {
  return String(fact?.claim || '').match(/「([^」]{1,40})」/u)?.[1] || '';
}

function shotsText(script) {
  return (Array.isArray(script?.shots) ? script.shots : [])
    .map(shot => `${shot?.voiceover || ''}\n${shot?.subtitle || ''}\n${shot?.visual || ''}\n${shot?.sfx || ''}`)
    .join('\n');
}

export function aiSalesVideoScriptResponseSchema({ durationSeconds = 15 } = {}) {
  const shotCount = resolveAiSalesVideoDuration(durationSeconds) / 15;
  const stringField = (extra = {}) => ({ type: 'string', ...extra });
  return {
    name: AI_SALES_VIDEO_SCRIPT_SCHEMA_NAME,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['hook_3s', 'shots', 'cta', 'facts_used', 'total_chars', 'estimated_seconds', 'risk_flags'],
      properties: {
        hook_3s: stringField({
          description: '前 3 秒钩子，≤14 个汉字，必须是第 1 段口播的开头。',
        }),
        shots: {
          type: 'array',
          minItems: shotCount,
          maxItems: shotCount,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['index', 'start', 'end', 'visual', 'voiceover', 'subtitle', 'sfx', 'reference_hint'],
            properties: {
              index: { type: 'integer', minimum: 1, maximum: shotCount },
              start: { type: 'number' },
              end: { type: 'number' },
              visual: stringField({
                description: '这一段画面怎么拍（人物/菜品/门头，镜头动作）。',
              }),
              voiceover: stringField({
                description:
                  '只说给食客听的自然中文独白，以。！？收尾；允许短句和环境音留白，不凑字数，拍摄/运镜指令只写visual。',
              }),
              subtitle: stringField({
                description: '字幕文本，与口播一致，可用｜分句。',
              }),
              sfx: stringField({ description: '音效/氛围提示，可为“无”。' }),
              reference_hint: {
                type: 'string',
                enum: [...AI_SALES_VIDEO_REFERENCE_HINTS],
              },
            },
          },
        },
        cta: stringField({
          description: '给食客的自然行动邀请，如“欢迎到店看看”；不编造优惠口令、外卖渠道或扫码入口。',
        }),
        facts_used: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['claim', 'factId'],
            properties: { claim: stringField(), factId: stringField() },
          },
        },
        total_chars: { type: 'integer' },
        estimated_seconds: { type: 'number' },
        risk_flags: { type: 'array', items: stringField() },
      },
    },
  };
}

/**
 * 纯函数契约校验。返回 { ok, errors, script }，script 为规范化副本（不改写口播正文）。
 * @param {object} raw 模型输出（已解析为对象）
 * @param {object} options
 * @param {object|null} options.pack 门店事实包（buildContentStoreFactPack 产物）
 * @param {(text:string)=>{hits:Array}} [options.scanText] risk.js scanText（可注入）
 */
export function validateAiSalesVideoScript(
  raw,
  {
    pack = null,
    scanText = null,
    shotSeconds = AI_SALES_VIDEO_SCRIPT_SHOT_SECONDS,
    durationSeconds = 15,
    shotCount = resolveAiSalesVideoDuration(durationSeconds) / 15,
    audioMode = 'provider_native',
  } = {},
) {
  const errors = [];
  const warnings = [];
  if (shotSeconds !== 15 || shotCount !== resolveAiSalesVideoDuration(durationSeconds) / 15)
    return { ok: false, errors: ['脚本分段与所选15或30秒时长不一致'], warnings, script: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['脚本必须是 JSON 对象'], script: null };
  }
  const requireFields = (obj, keys, label) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      errors.push(`${label}必须是对象`);
      return;
    }
    if (keys.some(key => !Object.hasOwn(obj, key)) || Object.keys(obj).some(key => !keys.includes(key)))
      errors.push(`${label}字段必须且只能包含${keys.join('、')}`);
  };
  requireFields(
    raw,
    ['hook_3s', 'shots', 'cta', 'facts_used', 'total_chars', 'estimated_seconds', 'risk_flags'],
    '脚本',
  );
  if (!Array.isArray(raw.risk_flags) || raw.risk_flags.some(v => typeof v !== 'string'))
    errors.push('risk_flags必须是字符串数组');
  if (
    !Number.isSafeInteger(raw.total_chars) ||
    raw.total_chars < 0 ||
    !Number.isFinite(raw.estimated_seconds) ||
    raw.estimated_seconds <= 0
  )
    errors.push('脚本统计必须是有效数值');
  for (const field of ['hook_3s', 'cta']) {
    if (typeof raw[field] !== 'string' || !raw[field].trim() || raw[field].length > 120)
      errors.push(`${field}必须是有效口播文本`);
  }
  const shots = Array.isArray(raw.shots) ? raw.shots : [];
  if (shots.length !== shotCount) {
    errors.push(
      `shots 必须恰好 ${shotCount} 段，每段${shotSeconds}秒，当前 ${shots.length} 段`,
    );
  }
  const normalizedShots = shots.map((shot, offset) => {
    requireFields(
      shot,
      ['index', 'start', 'end', 'visual', 'voiceover', 'subtitle', 'sfx', 'reference_hint'],
      `第${offset + 1}段`,
    );
    for (const field of ['voiceover', 'subtitle', 'visual', 'sfx', 'reference_hint']) {
      if (typeof shot?.[field] !== 'string' || !shot[field].trim() || shot[field].length > 400)
        errors.push(`第${offset + 1}段${field}类型或长度无效`);
    }
    const index = Number(shot?.index);
    const start = Number(shot?.start);
    const end = Number(shot?.end);
    if (!['index', 'start', 'end'].every(field => Number.isSafeInteger(shot?.[field])))
      errors.push(`第${offset + 1}段时间轴必须使用整数`);
    const expectedStart = offset * shotSeconds;
    const expectedEnd = (offset + 1) * shotSeconds;
    if (index !== offset + 1) errors.push(`第 ${offset + 1} 段 index 必须为 ${offset + 1}`);
    if (start !== expectedStart || end !== expectedEnd) {
      errors.push(
        `第 ${offset + 1} 段时间轴必须为 ${expectedStart}–${expectedEnd} 秒，当前 ${shot?.start}–${shot?.end}`,
      );
    }
    const voiceover = text(shot?.voiceover, 400);
    const subtitleText = String(shot?.subtitle || '').replace(/[|｜\s]/gu, '');
    if (subtitleText !== voiceover.replace(/\s/gu, '')) errors.push(`第${offset + 1}段字幕必须与口播一致`);
    if (/<#|\([^)]*\)|\{[^}]*\}/u.test(voiceover)) errors.push(`第${offset + 1}段口播不得包含TTS控制标记`);
    const chars = countSpeechChars(voiceover);
    const seconds = Number.isFinite(end - start) && end > start ? end - start : shotSeconds;
    const minChars = seconds * AI_SALES_VIDEO_CHARS_PER_SECOND_MIN;
    const maxChars = seconds * AI_SALES_VIDEO_CHARS_PER_SECOND_MAX;
    if (!voiceover || chars === 0) errors.push(`第 ${offset + 1} 段 voiceover 为空`);
    else if (audioMode === 'external_tts' && (chars < minChars || chars > maxChars)) {
      errors.push(
        `第 ${offset + 1} 段口播 ${chars} 字，必须在 ${Math.ceil(minChars)}–${Math.floor(maxChars)} 字之间（${seconds} 秒 × 3.5–4.5 字/秒）`,
      );
    } else if (chars > maxChars) {
      warnings.push(`第 ${offset + 1} 段独白较长，可能说不完；已保留原稿，请预览后选择是否精简。`);
    }
    if (voiceover && !SENTENCE_END_RE.test(voiceover)) {
      errors.push(`第 ${offset + 1} 段口播必须以完整句收尾（。！？）`);
    }
    const referenceHint = String(shot?.reference_hint || '').trim();
    if (!AI_SALES_VIDEO_REFERENCE_HINTS.includes(referenceHint)) {
      errors.push(`第 ${offset + 1} 段 reference_hint 必须是 person / dish / storefront`);
    }
    const visual = text(shot?.visual, 400);
    if (!visual) errors.push(`第 ${offset + 1} 段 visual 为空`);
    return {
      index: offset + 1,
      start: expectedStart,
      end: expectedEnd,
      visual,
      voiceover,
      subtitle: text(shot?.subtitle, 400) || voiceover,
      sfx: text(shot?.sfx, 120) || '无',
      reference_hint: referenceHint,
      chars,
    };
  });

  const hook = text(raw.hook_3s, 80);
  if (!hook) errors.push('hook_3s 不能为空');
  else {
    if (countSpeechChars(hook) > AI_SALES_VIDEO_HOOK_MAX_CHARS) {
      (audioMode === 'external_tts' ? errors : warnings).push(
        `hook_3s 超过前 3 秒建议长度（≤${AI_SALES_VIDEO_HOOK_MAX_CHARS} 字），可预览后精简开头`,
      );
    }
    const firstVoiceover = normalizedShots[0]?.voiceover || '';
    const hookNormalized = normalizeForCompare(hook);
    const voiceoverNormalized = normalizeForCompare(firstVoiceover);
    const firstSentenceNormalized = normalizeForCompare(firstSentence(firstVoiceover));
    if (
      hookNormalized &&
      !(voiceoverNormalized.startsWith(hookNormalized) || firstSentenceNormalized === hookNormalized)
    ) {
      errors.push('hook_3s 必须是第 1 段口播的前缀或首句（前 3 秒就要说出钩子）');
    }
  }

  const cta = text(raw.cta, 120);
  if (!cta) errors.push('cta 不能为空');
  else {
    const lastVoiceover = normalizedShots.at(-1)?.voiceover || '';
    if (!normalizeForCompare(lastVoiceover).includes(normalizeForCompare(cta))) {
      errors.push('最后一段口播必须包含 cta 原句（结尾给出行动入口）');
    }
    if (!CTA_ACTION_RE.test(cta)) {
      errors.push('cta 必须是自然行动邀请，例如“欢迎到店看看”');
    }
  }

  const riskFlags = Array.isArray(raw.risk_flags) ? raw.risk_flags.map(item => text(item, 80)).filter(Boolean) : [];
  if (riskFlags.length) errors.push(`模型自报风险未清零：${riskFlags.join('；')}`);
  const allText = shotsText({ shots: normalizedShots });
  if (typeof scanText === 'function') {
    let scan = null;
    try {
      scan = scanText(`${hook}\n${allText}\n${cta}`);
    } catch {
      errors.push('风控服务异常，脚本未通过安全校验');
    }
    if (!Array.isArray(scan?.hits)) errors.push('风控服务未返回有效校验结果');
    const hits = Array.isArray(scan?.hits) ? scan.hits : [];
    if (hits.length) {
      errors.push(`口播命中风控禁用词：${hits.map(hit => hit.name || hit.code).join('、')}`);
    }
  }

  // References are metadata, not evidence. Drop unknown IDs rather than paying
  // for a rewrite; actual narration still passes price/address/risk closure.
  const facts = Array.isArray(pack?.facts) ? pack.facts.filter(Boolean) : [];
  const bodyNormalized = normalizeForCompare(allText);
  if (Array.isArray(raw.facts_used)) {
    const registered = raw.facts_used.filter(entry => {
      if (entry && facts.some(fact => fact.id === entry.factId)) return true;
      warnings.push('已移除无法核实的事实引用编号；原口播仍按实际内容核验，未把引用说明当作用户事实。');
      return false;
    });
    for (const fact of facts) {
      if (fact.kind !== 'store_name' || fact.usage === 'internal_evidence' || registered.some(item => item.factId === fact.id)) continue;
      const name = normalizeForCompare(fact.value || fact.claim);
      if (name.length >= 2 && bodyNormalized.includes(name)) registered.push({ claim: fact.claim, factId: fact.id });
    }
    raw = { ...raw, facts_used: registered };
  }
  const registration = validateFactsUsed(raw.facts_used ?? [], pack || { facts: [] });
  errors.push(...registration.errors);
  for (const used of registration.used) {
    if (used.claim !== facts.find(fact => fact.id === used.factId)?.claim)
      errors.push(`事实[${used.factId}]声明必须逐字对应本店事实包`);
  }
  const closure = validateStoreFactClosure(raw, pack || { facts: [] }, {
    requireUsage: true,
  });
  errors.push(...closure.warnings.map(warning => warning.message));
  const registered = new Set(registration.used.map(entry => entry.factId));
  const knownPrices = factPrices(facts);
  for (const match of allText.matchAll(PRICE_RE)) {
    const amount = Number(match[1] ?? match[2]).toString();
    if (!knownPrices.has(amount)) {
      errors.push(`口播/字幕出现价格 ${amount} 元，不在门店事实包中（价格只能引用事实包）`);
    }
  }
  if (ADDRESS_HINT_RE.test(allText)) {
    const addressRegistered = registration.used.some(entry => ['address', 'area', 'city'].includes(entry.kind));
    if (!addressRegistered) {
      errors.push('口播/字幕提到了地址或位置，但 facts_used 未登记地址类事实（地址只能引用事实包）');
    }
  }
  for (const fact of facts) {
    if (!['signature_dish', 'dish_price'].includes(fact?.kind) || registered.has(fact.id)) continue;
    const name = normalizeForCompare(quotedName(fact));
    if (name.length >= 2 && bodyNormalized.includes(name)) {
      errors.push(`口播提到菜名「${quotedName(fact)}」但未在 facts_used 登记事实 [${fact.id}]`);
    }
  }

  const uniqueErrors = [...new Set(errors)];
  const totalChars = normalizedShots.reduce((sum, shot) => sum + shot.chars, 0);
  const script = {
    hook_3s: hook,
    shots: normalizedShots.map(shot => ({
      index: shot.index,
      start: shot.start,
      end: shot.end,
      visual: shot.visual,
      voiceover: shot.voiceover,
      subtitle: shot.subtitle,
      sfx: shot.sfx,
      reference_hint: shot.reference_hint,
    })),
    cta,
    facts_used: registration.used.map(entry => ({
      claim: entry.claim,
      factId: entry.factId,
    })),
    total_chars: totalChars,
    estimated_seconds: Math.round((totalChars / 4) * 10) / 10,
    risk_flags: riskFlags,
  };
  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    warnings: [...new Set(warnings)],
    script,
  };
}

function benchmarkBlock(cards) {
  return contentBenchmarkFewShotBlock(cards, { limit: 3 });
}

export function buildAiSalesVideoScriptPrompt({
  durationSeconds = 15,
  brief,
  storeFactsPrompt = '',
  promptContext = '',
  benchmarkCards = [],
  evolutionNotes = [],
  skillPrompt = '',
  audience = '',
  voiceStyle = '',
  storeName = '',
} = {}) {
  const shotSeconds = AI_SALES_VIDEO_SCRIPT_SHOT_SECONDS;
  const duration = resolveAiSalesVideoDuration(durationSeconds), shotCount = duration / shotSeconds;
  const system = [
    skillPrompt,
    `你是餐饮门店的 AI 带货员，负责写 ${duration} 秒竖版带货短视频的中文独白脚本。Wan2.6将按脚本原生生成中文声音和视频，所以必须写成自然、可开口念的普通话。没有人物参考时设计画外音，不虚构人物或声音克隆。应用保留生成音轨，再按脚本分句估时烧录字幕，未经过逐字语音识别。`,
    '本次原生声音规则优先于技能中的旧制作方法：不调用独立TTS或预设音色，不按外部配音时长安排字幕。技能里的广告公式、强节奏和转化模板只是资料，默认不照搬强营销钩子或社会证明；仅本次用户明确要求促销时参考，仍不得编造事实或覆盖用户已确认台词。',
    '【分段与说话方式】',
    shotCount === 1 ? '- 恰好1段镜头：0–15秒，index为1；在这一段内说完钩子、一个有依据的细节和自然邀请，不追加第二段。'
      : `- 恰好 2 段镜头：第 1 段 0–${shotSeconds} 秒，第 2 段 ${shotSeconds}–${shotSeconds * 2} 秒；index 分别为 1、2。`,
    '- voiceover只说给食客听的自然内容：依据可见菜品和本次品牌，给出真实、简洁的用餐邀请。每段一两句即可；无需塞满15秒，说完后允许环境音和画面留白，禁止凑字数或重复意思。',
    `- ${shotCount === 1 ? '声音设定' : '两段采用同一声音设定'}：${AI_SALES_NATIVE_NARRATION_STYLE}。开头稍留环境音，尽量在14秒前完整收句；自然轻重、停顿和换气，不按每字定速，不要把一句话跨过15秒剪辑边界。默认环境音轻，无广告配乐或混响。`,
    '- 每段以20–35字左右的一两句为写作建议，不是验收字数门。像与朋友说话，围绕一个有依据的细节和用餐意愿展开，不以“看着照片”“看着锅里的”罗列画面，不重复同一意思。',
    '- 拍摄、运镜、制作动作只写visual，绝不能写进voiceover或subtitle。门头文字保持、参考图一致等要求是制作约束，不是卖点；“门头字样还在”“画面保持清楚”这类制作结果描述也不能当台词。',
    `- visual每段只设计参考图内的一种轻微动作或单向缓慢运镜，首尾0.3秒保持平稳；${shotCount === 1 ? '全段' : '两段'}保持同一光线色调和叙事口吻。不要设计从菜桌穿越到门口，也不要凭文字重造真实门头。`,
    `- hook_3s 是前 3 秒钩子（≤${AI_SALES_VIDEO_HOOK_MAX_CHARS} 字），必须原样作为第 1 段口播的开头。`,
    `- ${shotCount === 1 ? '本段结尾接住用餐意愿' : '第 2 段接住前段用餐意愿'}，品牌自然带入邀请，cta原句出现在口播里。表达示例：“下班路过，来【本次品牌】坐坐。”只学习说话方式，不照抄模板，品牌取本次输入；不固定以“欢迎到店”结尾。不逐项念门头画面，不硬补无依据的新卖点。没有已证实的优惠或渠道，不写“到店说某某”、报暗号、扫码或外卖搜索指令。`,
    '- 每段口播以完整句收尾（。！？），按句意自然停顿，不逐句数汉字。使用日常口语，不堆成语，不用“匠心”“臻选”类广告腔。',
    '- reference_hint 标注该段首帧用什么素材：person（人物出镜）/ dish（菜品）/ storefront（门头）。',
    '【事实边界】',
    '- 本次用户明确的品牌与素材范围优先；事实包中其他门店的品牌、菜名、地址、价格不得移用，也不为了登记facts_used强行引用不相关资料。',
    '- 价格、地址、菜名、营业时间只能引用【门店真实事实】里的条目，并在 facts_used 中逐条登记 { claim, factId }；事实包没有的数字不许出现，可以说“以门店公示为准”。',
    '- 不得写评价原句、不得承诺效果/收益、不得出现“最”“第一”“治疗”类绝对化或功效词；写完自查，risk_flags 必须为空数组。',
    `【输出】只输出一个合法 JSON 对象，字段：hook_3s、shots[${shotCount}]{index,start,end,visual,voiceover,subtitle,sfx,reference_hint}、cta、facts_used、total_chars、estimated_seconds、risk_flags。`,
  ].join('\n');
  const user = [
    `【本次带货目标】${text(brief, 3000)}`,
    storeName ? `【门店】${text(storeName, 80)}` : '',
    audience ? `【目标客群】${text(audience, 120)}` : '',
    voiceStyle ? `【口播风格】${text(voiceStyle, 120)}` : '',
    storeFactsPrompt ? text(storeFactsPrompt, 2400) : '',
    promptContext ? text(promptContext, 3200) : '',
    benchmarkBlock(benchmarkCards),
    evolutionNotesPromptLines(sanitizeEvolutionNotesForPrompt(evolutionNotes)).join('\n'),
    '【口播复核】把voiceover单独读一遍：每句都应让食客知道吃什么、为什么想来，或如何自然受邀；只是在描述制作是否完成的句子删去。拍摄指令留在visual，以自然、真实为先，不为了时长和字数填充；台词说完可留环境音。',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { system, user };
}

function parseJsonObject(value) {
  const raw = String(value || '').trim();
  if (!raw) return { parsed: null, error: '模型没有返回内容' };
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  if (fenced) candidates.push(fenced.trim());
  const braceStart = raw.indexOf('{');
  const braceEnd = raw.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) candidates.push(raw.slice(braceStart, braceEnd + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { parsed, error: null };
    } catch {
      // try next candidate
    }
  }
  return { parsed: null, error: '模型输出不是合法 JSON 对象' };
}

function addUsage(total, usage) {
  return {
    inputTokens: Number(total?.inputTokens || 0) + Number(usage?.inputTokens || 0),
    outputTokens: Number(total?.outputTokens || 0) + Number(usage?.outputTokens || 0),
  };
}

/**
 * 调文本模型生成独白脚本；一次修复重试；仍失败 → AiSalesVideoScriptError（blocked）。
 * generateFn 与 ai.js 的 generate 同签名，返回 { text, mode, model, usage }。
 */
export async function generateAiSalesVideoScript({
  durationSeconds = 15,
  brief,
  storeFacts = null,
  storeFactsPrompt = '',
  promptContext = '',
  benchmarkCards = [],
  evolutionNotes = [],
  skillPrompt = '',
  audience = '',
  voiceStyle = '',
  storeName = storeFacts?.storeName || '',
  model,
  role = 'boss',
  generateFn,
  scanText = null,
  signal,
  timeoutMs = 120_000,
  maxAttempts = AI_SALES_VIDEO_SCRIPT_MAX_ATTEMPTS,
} = {}) {
  if (typeof generateFn !== 'function') {
    throw blocked('独白脚本引擎未配置文本模型调用器', {
      code: 'AI_SALES_VIDEO_SCRIPT_GENERATOR_MISSING',
      status: 500,
    });
  }
  const normalizedBrief = text(brief, 3000);
  if (!normalizedBrief) {
    throw blocked('带货 brief 不能为空', {
      code: 'AI_SALES_VIDEO_INVALID_INPUT',
      status: 400,
    });
  }
  const prompt = buildAiSalesVideoScriptPrompt({
    durationSeconds,
    brief: normalizedBrief,
    storeFactsPrompt,
    promptContext,
    benchmarkCards,
    evolutionNotes,
    skillPrompt,
    audience,
    voiceStyle,
    storeName,
  });
  const responseSchema = aiSalesVideoScriptResponseSchema({ durationSeconds });
  const attempts = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let usedModel = model || null;
  let userMsg = prompt.user;
  const attemptLimit = Math.min(AI_SALES_VIDEO_SCRIPT_MAX_ATTEMPTS, Math.max(1, Math.trunc(Number(maxAttempts) || 2)));
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    const output = await generateFn({
      kind: 'ai_sales_video_script',
      system: prompt.system,
      userMsg,
      fallback: () => '',
      maxTokens: 1800,
      role,
      model,
      timeoutMs,
      signal,
      responseSchema,
      providerPolicy: 'yunwu_only',
    });
    usage = addUsage(usage, output?.usage);
    if (output?.model && output.model !== 'template') usedModel = output.model;
    if (!output || output.mode !== 'api') {
      attempts.push({
        attempt,
        ok: false,
        errors: ['文本模型不可用，未取得模型产出（拒绝模板冒充）'],
      });
      throw blocked('独白脚本需要真实文本模型产出，当前模型通道不可用；未使用模板冒充脚本。', {
        code: 'AI_SALES_VIDEO_SCRIPT_MODEL_UNAVAILABLE',
        status: 503,
        errors: attempts.at(-1).errors,
        attempts,
        usage,
      });
    }
    const { parsed, error } = parseJsonObject(output.text);
    const validation = parsed
      ? validateAiSalesVideoScript(parsed, { pack: storeFacts, scanText, durationSeconds })
      : { ok: false, errors: [error], script: null };
    attempts.push({
      attempt,
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings || [],
    });
    if (validation.ok) {
      return {
        script: validation.script,
        mode: 'model',
        model: usedModel,
        usage,
        attempts,
        warnings: validation.warnings || [],
        prompt: {
          systemChars: prompt.system.length,
          userChars: prompt.user.length,
        },
      };
    }
    if (attempt < attemptLimit) {
      userMsg = [
        prompt.user,
        '【上一轮产物（需修复）】',
        String(output.text || '').slice(0, 6000),
        '【契约校验失败原因，逐条修复后重新输出完整 JSON】',
        ...validation.errors.map((item, index) => `${index + 1}. ${item}`),
      ].join('\n');
    }
  }
  const last = attempts.at(-1);
  throw blocked(`独白脚本两轮均未通过契约校验：${(last?.errors || []).slice(0, 4).join('；')}`, {
    errors: last?.errors || [],
    attempts,
    usage,
  });
}

/**
 * 语音回路：某段 TTS 实测 > 16.5s 时，让模型只精简该段口播（最多 1 次），其余字段保持不变。
 */
export async function condenseAiSalesVideoShot({
  script,
  shotIndex,
  measuredSeconds,
  targetSeconds = AI_SALES_VIDEO_SCRIPT_SHOT_SECONDS,
  storeFacts = null,
  model,
  role = 'boss',
  generateFn,
  scanText = null,
  signal,
  timeoutMs = 90_000,
} = {}) {
  if (typeof generateFn !== 'function') {
    throw blocked('独白脚本引擎未配置文本模型调用器', {
      code: 'AI_SALES_VIDEO_SCRIPT_GENERATOR_MISSING',
      status: 500,
    });
  }
  const index = Number(shotIndex);
  const shot = (script?.shots || []).find(item => Number(item.index) === index);
  if (!shot)
    throw blocked(`第 ${shotIndex} 段不存在，无法精简`, {
      code: 'AI_SALES_VIDEO_INVALID_INPUT',
      status: 400,
    });
  const currentChars = countSpeechChars(shot.voiceover);
  const ratio = Number(measuredSeconds) > 0 ? targetSeconds / Number(measuredSeconds) : 0.9;
  const targetChars = Math.max(
    Math.ceil(targetSeconds * AI_SALES_VIDEO_CHARS_PER_SECOND_MIN),
    Math.min(Math.floor(targetSeconds * AI_SALES_VIDEO_CHARS_PER_SECOND_MAX), Math.floor(currentChars * ratio * 0.95)),
  );
  const system = [
    '你是餐饮门店的 AI 带货员。下面是一份已通过审核的 30 秒独白脚本 JSON，其中一段配音实测超时。',
    `只精简第 ${index} 段的 voiceover（同步更新该段 subtitle），压到 ${targetChars} 个汉字左右（不少于 ${Math.ceil(targetSeconds * AI_SALES_VIDEO_CHARS_PER_SECOND_MIN)} 字），保留原有钩子/行动指令原句与所有事实，不新增任何价格、地址、菜名。`,
    '其余段落与字段逐字保持不变。只输出修改后的完整 JSON 对象。',
  ].join('\n');
  const output = await generateFn({
    kind: 'ai_sales_video_script_condense',
    system,
    userMsg: JSON.stringify(script),
    fallback: () => '',
    maxTokens: 1800,
    role,
    model,
    timeoutMs,
    signal,
    responseSchema: aiSalesVideoScriptResponseSchema({ durationSeconds: 30 }),
    providerPolicy: 'yunwu_only',
  });
  if (!output || output.mode !== 'api') {
    throw blocked('精简口播需要真实文本模型产出，当前模型通道不可用。', {
      code: 'AI_SALES_VIDEO_SCRIPT_MODEL_UNAVAILABLE',
      status: 503,
      usage: output?.usage || null,
    });
  }
  const { parsed, error } = parseJsonObject(output.text);
  const validation = parsed
    ? validateAiSalesVideoScript(parsed, {
        pack: storeFacts,
        scanText,
        audioMode: 'external_tts',
        durationSeconds: 30,
      })
    : { ok: false, errors: [error], script: null };
  if (!validation.ok) {
    throw blocked(`精简后的脚本未通过契约校验：${validation.errors.slice(0, 3).join('；')}`, {
      errors: validation.errors,
      usage: output.usage || null,
    });
  }
  const immutableProjection = value => ({
    hook_3s: value.hook_3s,
    cta: value.cta,
    facts_used: value.facts_used,
    risk_flags: value.risk_flags,
    shots: value.shots.map(item =>
      item.index === index
        ? {
            index: item.index,
            start: item.start,
            end: item.end,
            visual: item.visual,
            sfx: item.sfx,
            reference_hint: item.reference_hint,
          }
        : item,
    ),
  });
  const changedOther =
    JSON.stringify(immutableProjection(validation.script)) !== JSON.stringify(immutableProjection(script));
  if (changedOther) {
    throw blocked('精简时改动了非目标口播/字幕之外的字段，已拒绝', {
      errors: ['非目标字段被改写'],
      usage: output.usage || null,
    });
  }
  return {
    script: validation.script,
    usage: output.usage || { inputTokens: 0, outputTokens: 0 },
    model: output.model || model || null,
    targetChars,
  };
}

import { excludedRestaurantSource } from './restaurant-source-host.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { curTenant, q } from '../db.js';
import { campaignBrandIdentity, isPlatformBrandStamp } from './brand-knowledge-pack.js';
import { buildContentStoreFactPack } from './content-store-facts.js';
import { estimateMaxCredits, holdCredits, refundHold, settleHold } from './credits.js';
import {
  loadGeneratedImageBytes,
  persistPosterTextArtifacts,
  POSTER_TEXT_UPLOAD_ROOT,
  renderSvgToPng,
} from './poster-text-overlay.js';
import { routing } from './yunwu.js';

export const SUPER_MANAGER_EMPLOYEE_IDX = 160;
export const CAMPAIGN_MATERIALS_FENCE = 'nanowork-campaign-materials';
export const CAMPAIGN_MATERIAL_MAX_SLOTS = 8;

export const CAMPAIGN_MATERIAL_CATALOG = Object.freeze([
  Object.freeze({
    kind: 'flyer',
    title: '宣传单',
    size: '1024x1536',
    aspect: '3 / 4',
    default: true,
    variants: 2,
    aliases: Object.freeze(['宣传单', '传单', '单页', '彩页', 'flyer']),
    compositions: Object.freeze([
      'finished vertical A4 campaign flyer, full-bleed food photography with designed typographic title integrated into the scene, no empty caption bars',
      'finished vertical flyer still life of the same campaign set, steam and tableware, custom lettering woven into the lighting rather than stamped on top',
    ]),
  }),
  Object.freeze({
    kind: 'banner',
    title: 'Banner横图',
    size: '1536x1024',
    aspect: '3 / 2',
    default: true,
    variants: 2,
    aliases: Object.freeze(['banner', 'Banner', '横幅', '横图', '店招横图', '门头图']),
    compositions: Object.freeze([
      'finished wide landscape restaurant banner, cinematic food photography, artistic title designed into the left atmosphere, no blank typesetting slab',
      'finished wide window-display banner of the same campaign set, dish centered-right, custom lettering as part of the set design',
    ]),
  }),
  Object.freeze({
    kind: 'kv_poster',
    title: '主KV海报',
    size: '1024x1536',
    aspect: '3 / 4',
    default: true,
    variants: 1,
    aliases: Object.freeze(['主kv', 'KV海报', '主海报', '竖版海报']),
    compositions: Object.freeze([
      'finished vertical campaign key visual, hero dish filling the frame, artistic headline designed into the atmosphere, no reserved caption band',
    ]),
  }),
  Object.freeze({
    kind: 'social_square',
    title: '朋友圈方图',
    size: '1024x1024',
    aspect: '1 / 1',
    default: true,
    variants: 1,
    aliases: Object.freeze(['朋友圈', '方图', '正方形', '社群图']),
    compositions: Object.freeze([
      'finished square social crop of the same campaign set, dish centered, artistic lettering as a design element rather than a caption',
    ]),
  }),
  Object.freeze({
    kind: 'table_card',
    title: '桌贴台卡',
    size: '1024x1536',
    aspect: '3 / 4',
    default: true,
    variants: 1,
    aliases: Object.freeze(['桌贴', '台卡', '桌卡', '台牌']),
    compositions: Object.freeze([
      'finished table-tent still life of the same campaign set, closer crop, small brand mark only if a logo was provided',
    ]),
  }),
  Object.freeze({
    kind: 'takeout_cover',
    title: '外卖封面',
    size: '1024x1024',
    aspect: '1 / 1',
    default: false,
    variants: 1,
    aliases: Object.freeze(['外卖', '美团', '饿了么', '外卖封面']),
    compositions: Object.freeze([
      'finished square takeout-app cover of the same campaign set, dish filling the frame, artistic title designed into the crop',
    ]),
  }),
]);

function catalogByKind(kind) {
  return CAMPAIGN_MATERIAL_CATALOG.find(item => item.kind === kind) || null;
}

function expandKindSlots(kind, variantCount) {
  const count = Math.max(1, Math.min(kind.variants, Number(variantCount) || 1));
  const labels = ['A', 'B', 'C'];
  return kind.compositions.slice(0, count).map((composition, index) => Object.freeze({
    id: count > 1 ? `${kind.kind}_${String.fromCharCode(97 + index)}` : kind.kind,
    kind: kind.kind,
    variant: count > 1 ? labels[index] : '',
    title: count > 1 ? `${kind.title} · 方案${labels[index]}` : kind.title,
    groupTitle: kind.title,
    size: kind.size,
    aspect: kind.aspect,
    composition,
  }));
}

export function resolveCampaignMaterialSlots({
  requirement = '',
  selectedKinds,
} = {}) {
  const source = textOf(requirement);
  const requested = [...new Set((Array.isArray(selectedKinds) ? selectedKinds : [])
    .map(value => textOf(value))
    .filter(value => catalogByKind(value)))];
  const matched = requested.length
    ? requested.map(kind => catalogByKind(kind)).filter(Boolean)
    : CAMPAIGN_MATERIAL_CATALOG.filter(item => item.aliases.some(alias => source.includes(alias)));
  const kinds = matched.length ? matched : CAMPAIGN_MATERIAL_CATALOG.filter(item => item.default);
  const wantChoices = /备选|多套|几套|选一套|可以选|样张|样品|宣传单样|两套|两版|多版/u.test(source);
  const slots = [];
  for (const kind of kinds) {
    const alwaysChoose = kind.kind === 'flyer' || kind.kind === 'banner';
    const variantCount = wantChoices || alwaysChoose ? kind.variants : 1;
    slots.push(...expandKindSlots(kind, variantCount));
    if (slots.length >= CAMPAIGN_MATERIAL_MAX_SLOTS) break;
  }
  return Object.freeze(slots.slice(0, CAMPAIGN_MATERIAL_MAX_SLOTS).map(item => Object.freeze(item)));
}

export const CAMPAIGN_MATERIAL_SLOTS = resolveCampaignMaterialSlots({});

const PALETTES = Object.freeze([
  Object.freeze({ bg: 'warm charcoal and ember red lacquer', accent: 'antique brass gold', light: 'tungsten restaurant lighting with soft steam' }),
  Object.freeze({ bg: 'deep soy brown and cream porcelain', accent: 'cinnabar red', light: 'soft window side light on a wooden table' }),
  Object.freeze({ bg: 'ink black and celadon glaze', accent: 'warm ivory', light: 'lantern glow with shallow depth of field' }),
]);

function textOf(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

export function isUnusableCampaignStamp(value) {
  const text = textOf(value);
  if (!text) return true;
  if (isPlatformBrandStamp(text) || /超级店长/u.test(text)) return true;
  return /折扣|特价|满减|券后价|原价|现价/u.test(text) && text.length <= 8;
}

function usableStoreName(value) {
  const text = textOf(value).slice(0, 24);
  return text && !isUnusableCampaignStamp(text) ? text : '';
}

function confirmedFragment(value, sources) {
  const text = textOf(value).slice(0, 40);
  if (!text || isUnusableCampaignStamp(text)) return '';
  return sources.some(source => source.includes(text)) ? text : '';
}

export function collectCampaignReferenceImages(sources = []) {
  const seen = new Set();
  const out = [];
  const visit = (value) => {
    if (!value || out.length >= 4) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object') {
      visit(value.dataUrl || value.image || value.url);
      return;
    }
    const text = String(value).trim();
    if (seen.has(text)) return;
    if (/^data:image\/(?:png|jpeg|webp);base64,/iu.test(text)) {
      seen.add(text);
      out.push(text);
      return;
    }
    if (/^https?:\/\/[^\s]+$/iu.test(text) && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  };
  visit(sources);
  return out;
}

async function materializeReferenceImages(sources, { fetchFn = globalThis.fetch, signal } = {}) {
  const collected = collectCampaignReferenceImages(sources);
  const out = [];
  for (const item of collected) {
    if (out.length >= 3) break;
    if (/^data:image\//iu.test(item)) {
      out.push(item);
      continue;
    }
    const loaded = await loadBrandLogoReference(item, { fetchFn, signal });
    if (loaded) out.push(loaded);
  }
  return out;
}

async function loadBrandLogoReference(url, { fetchFn = globalThis.fetch, signal } = {}) {
  const href = String(url || '').trim();
  if (!/^https?:\/\//iu.test(href)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    let target = href;
    let response;
    for (let hop = 0; hop <= 3; hop++) {
      if (excludedRestaurantSource(target)) return null;
      response = await fetchFn(target, { signal: controller.signal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response?.status)) break;
      const location = response.headers?.get?.('location');
      if (!location) return null;
      target = new URL(location, target).href;
      if (!/^https?:\/\//iu.test(target)) return null;
    }
    if (!response?.ok) return null;
    const mime = String(response.headers?.get?.('content-type') || 'image/png').split(';')[0].trim();
    if (!/^image\/(?:png|jpeg|jpg|webp|svg\+xml)$/iu.test(mime) && !/\.(?:png|jpe?g|webp|svg)$/iu.test(href)) {
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 6 * 1024 * 1024) return null;
    const safeMime = mime.startsWith('image/') ? mime : 'image/png';
    if (/svg/iu.test(safeMime) || /\.svg(?:\?|$)/iu.test(href)) {
      try {
        const raster = await renderSvgToPng(buffer.toString('utf8'));
        return `data:image/png;base64,${raster.toString('base64')}`;
      } catch {
        return null;
      }
    }
    return `data:${safeMime};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

function persistJobId(jobKey, slotId, index) {
  const digest = crypto.createHash('sha256')
    .update(`${jobKey || ''}|${slotId}|${index}`)
    .digest('hex');
  return String(Number.parseInt(digest.slice(0, 8), 16) % 1_000_000_000).padStart(9, '0');
}

function firstMatch(source, patterns) {
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return textOf(match[1]).slice(0, 40);
  }
  return '';
}

function publicFailureNote(error) {
  const cleaned = String(error?.message || '生图未完成')
    .replace(/https?:\/\/[^\s]+/giu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned.slice(0, 80) || '生图未完成';
}

export function parseCampaignMaterialBrief(markdown, {
  requirement = '',
  storeName = '',
  storeFacts = null,
  brandIdentity = null,
} = {}) {
  const identity = brandIdentity || resolveCampaignBrandIdentity();
  const facts = Array.isArray(storeFacts?.facts) ? storeFacts.facts : [];
  const factValue = kind => textOf(facts.find(item => item.kind === kind && (item.value || item.claim))?.value
    || facts.find(item => item.kind === kind)?.claim);
  const requirementText = textOf(requirement);
  const markdownText = textOf(markdown);
  const packStoreName = usableStoreName(storeFacts?.storeName);
  const brandName = usableStoreName(identity?.brandName);
  const packSlogan = textOf(identity?.slogan).slice(0, 40);
  const packSeason = textOf(identity?.seasonal).split(/[。；;\n]/u)[0].slice(0, 40);
  const signatureDishes = [
    ...(Array.isArray(identity?.dishes) ? identity.dishes : []),
    ...facts
      .filter(item => item.kind === 'signature_dish')
      .map(item => textOf(item.value || item.claim)),
  ].filter(Boolean);
  const trustedSources = [
    requirementText,
    brandName,
    packStoreName,
    packSlogan,
    packSeason,
    factValue('store_name'),
    factValue('category'),
    ...signatureDishes,
  ].filter(Boolean);
  const sources = [...trustedSources, markdownText];
  const store = usableStoreName(brandName
    || confirmedFragment(factValue('store_name'), trustedSources)
    || firstMatch(requirementText, [
      /本店([\u4e00-\u9fffA-Za-z0-9]{2,16}(?:川菜馆|火锅店|牛肉面|馆|店|烤鸭))/u,
      /((?:北京|上海|天津|重庆|广州|深圳|杭州|成都|武汉)?[\u4e00-\u9fffA-Za-z0-9]{2,16}(?:烤鸭|火锅|牛肉面|川菜馆|酒楼))/u,
      /门店名称[:：]\s*([^\n，。]{2,24})/u,
      /(?:品牌|店名)[:：]\s*([^\n，。]{2,24})/u,
    ])
    || packStoreName
    || confirmedFragment(usableStoreName(storeName), trustedSources));
  const themeFromPack = packSeason
    && /活动|套餐|宴|聚餐|节日|中秋|国庆|周末|季节/u.test(packSeason)
    && !isUnusableCampaignStamp(packSeason)
    ? packSeason
    : '';
  const theme = confirmedFragment(firstMatch(requirementText, [
    /活动主题[:：]\s*([^\n]{2,40})/u,
    /主题[:：]\s*([^\n]{2,40})/u,
    /(中秋[^，。\n]{0,12}国庆[^，。\n]{0,12}(?:家庭宴|套餐|活动|聚餐))/u,
    /(国庆[^，。\n]{2,16}(?:家庭宴|套餐|活动|聚餐))/u,
    /(中秋[^，。\n]{2,16}(?:家庭宴|套餐|活动|聚餐))/u,
    /(周末[^，。\n]{2,16}活动)/u,
  ]) || firstMatch(requirementText, [/(?:做|办)([\u4e00-\u9fff]{2,16}(?:套餐|活动|聚餐|家庭宴))/u]), trustedSources)
    || confirmedFragment(firstMatch(markdownText, [
      /活动主题[:：]\s*([^\n]{2,40})/u,
      /主题[:：]\s*([^\n]{2,40})/u,
    ]), sources)
    || themeFromPack;
  const dishes = [...new Set([
    ...signatureDishes,
    ...[...requirementText.matchAll(/(?:招牌菜|主打|菜品)[:：]?\s*([^\n，。、\s]{2,20})/gu)].map(item => textOf(item[1])),
  ].filter(value => value && (signatureDishes.includes(value) || confirmedFragment(value, trustedSources))))].slice(0, 3);
  const offer = confirmedFragment(firstMatch(requirementText, [
    /((?:满\d+|减\d+|折扣|特价|套餐价)[^\n，。]{0,16})/u,
    /(¥\s*\d+(?:\.\d+)?)/u,
  ]), trustedSources);
  const date = confirmedFragment(firstMatch(requirementText, [
    /((?:本周末|本周六|本周日|\d{1,2}月\d{1,2}日))/u,
  ]), trustedSources) || confirmedFragment(firstMatch(markdownText, [
    /((?:本周末|本周六|本周日|\d{1,2}月\d{1,2}日))/u,
  ]), sources);
  const cuisine = confirmedFragment(factValue('category'), trustedSources)
    || confirmedFragment(firstMatch(`${requirementText}\n${markdownText}`, [
      /((?:火锅|牛肉面|烧烤|川菜|粤菜|湘菜|日料|烤鸭|北京菜|咖啡|烘焙)[馆店堂]?)/u,
    ]), sources);
  return Object.freeze({
    storeName: store,
    theme,
    dishes,
    offer,
    date,
    cuisine,
    logoUrl: identity?.logoUrl || '',
    slogan: packSlogan && !isUnusableCampaignStamp(packSlogan) ? packSlogan : '',
    style: textOf(identity?.style).slice(0, 400),
    mission: textOf(identity?.mission).slice(0, 200),
  });
}

function resolveCampaignBrandIdentity() {
  try {
    return campaignBrandIdentity();
  } catch {
    return null;
  }
}

function paletteFromStyle(style) {
  const text = textOf(style);
  if (!text) return null;
  if (/红|朱|金|漆|橙/u.test(text)) return PALETTES[0];
  if (/木|棕|陶|米|奶油/u.test(text)) return PALETTES[1];
  if (/黑|青|墨|瓷/u.test(text)) return PALETTES[2];
  return Object.freeze({
    bg: text.slice(0, 72),
    accent: 'brand accent taken from style notes',
    light: 'restaurant lighting matching the brand world',
  });
}

function parseBrandVisionJson(text) {
  const source = String(text || '');
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const raw = fenced?.[1] || source;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function fallbackBrandUnderstanding(brief = {}) {
  const palette = paletteFromStyle(brief.style)
    || PALETTES[Number.parseInt(
      crypto.createHash('sha256').update(brief.storeName || 'brand').digest('hex').slice(0, 2),
      16,
    ) % PALETTES.length];
  return Object.freeze({
    palette: Object.freeze({ bg: palette.bg, accent: palette.accent, light: palette.light }),
    mark: brief.storeName ? `official ${brief.storeName} mark, keep geometry and colors unchanged` : '',
    mood: textOf(brief.style).slice(0, 180) || 'warm family restaurant campaign',
    placement: 'integrate the official logo as a designed lockup on signage or tableware, small and faithful, never a later sticker',
    lettering: [brief.storeName, brief.theme].filter(Boolean).join(' / '),
    source: 'pack',
  });
}

function normalizeBrandUnderstanding(parsed, brief = {}) {
  const fallback = fallbackBrandUnderstanding(brief);
  const palette = parsed?.palette && typeof parsed.palette === 'object' ? parsed.palette : {};
  return Object.freeze({
    palette: Object.freeze({
      bg: textOf(palette.bg).slice(0, 80) || fallback.palette.bg,
      accent: textOf(palette.accent).slice(0, 80) || fallback.palette.accent,
      light: textOf(palette.light).slice(0, 80) || fallback.palette.light,
    }),
    mark: textOf(parsed?.mark).slice(0, 180) || fallback.mark,
    mood: textOf(parsed?.mood).slice(0, 200) || fallback.mood,
    placement: textOf(parsed?.placement).slice(0, 180) || fallback.placement,
    lettering: textOf(parsed?.lettering).slice(0, 180) || fallback.lettering,
    source: 'vision',
  });
}

export async function understandCampaignBrandVisuals({
  brief = {},
  logoDataUrl = '',
  chatFn,
  signal,
} = {}) {
  const fallback = fallbackBrandUnderstanding(brief);
  if (!chatFn || !logoDataUrl) return fallback;
  const notes = [
    brief.storeName && `Brand name: ${brief.storeName}`,
    brief.slogan && `Slogan: ${brief.slogan}`,
    brief.style && `Style notes: ${brief.style}`,
    brief.mission && `Mission: ${brief.mission}`,
    brief.theme && `Campaign: ${brief.theme}`,
  ].filter(Boolean).join('\n');
  try {
    const out = await chatFn({
      model: routing().vision,
      maxTokens: 500,
      timeoutMs: 25_000,
      signal,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              'You are the brand art director. Look at this official logo plus the brand notes.',
              'Return JSON only with keys palette{bg,accent,light}, mark, mood, placement, lettering.',
              'palette values are short English visual phrases. mark describes the logo geometry and colors to reproduce faithfully. mood is the brand world. placement says how a designer would integrate the real logo into campaign art. lettering says how the store name and campaign title should be painted into the scene.',
              'Never invent discounts, platform product names, or a different logo.',
              notes,
            ].join('\n'),
          },
          { type: 'image_url', image_url: { url: logoDataUrl } },
        ],
      }],
    });
    const parsed = parseBrandVisionJson(out?.text);
    if (!parsed) return fallback;
    const understood = normalizeBrandUnderstanding(parsed, brief);
    return Object.freeze({
      ...understood,
      usage: out?.usage || {},
    });
  } catch (error) {
    if (error?.status === 499) throw error;
    return fallback;
  }
}

export function campaignVisualLock(brief = {}, understanding = null) {
  const seed = crypto.createHash('sha256')
    .update(`${brief.storeName || 'unbranded'}|${brief.theme || 'campaign'}|${brief.cuisine || ''}|${brief.style || ''}`)
    .digest('hex');
  const palette = understanding?.palette?.bg
    ? understanding.palette
    : paletteFromStyle(brief.style) || PALETTES[Number.parseInt(seed.slice(0, 2), 16) % PALETTES.length];
  const mood = textOf(understanding?.mood || brief.style).slice(0, 180);
  return Object.freeze({
    seed: seed.slice(0, 12),
    photography: mood
      ? `one cohesive restaurant campaign set in this brand world: ${mood}, identical lighting, lens and tableware, commercial food photography, no collage`
      : 'one cohesive restaurant campaign set, identical lighting, lens and tableware, commercial food photography, no collage',
    palette: Object.freeze({
      bg: palette.bg,
      accent: palette.accent,
      light: palette.light,
    }),
    cuisine: brief.cuisine || 'only dishes explicitly confirmed in the brief',
    storeName: brief.storeName || '',
    theme: brief.theme || '',
    mark: textOf(understanding?.mark).slice(0, 180),
    mood,
    placement: textOf(understanding?.placement).slice(0, 180),
    lettering: textOf(understanding?.lettering).slice(0, 180),
  });
}

export function campaignImagePrompt(brief, lock, slot, { hasBrandAssets = false } = {}) {
  const dishes = (brief.dishes || []).join(', ');
  const theme = textOf(brief.theme);
  const store = usableStoreName(brief.storeName || lock.storeName);
  const letteringTarget = [store, theme && !isUnusableCampaignStamp(theme) ? theme : '']
    .filter(Boolean)
    .join(' / ');
  return [
    'Finished commercial campaign artwork a restaurant can print and post. Designed as one complete visual, not a photo with captions glued on later.',
    `Visual lock seed ${lock.seed}: ${lock.photography}. Palette ${lock.palette.bg}, accent ${lock.palette.accent}, lighting ${lock.palette.light}.`,
    lock.mood ? `Brand tonality: ${lock.mood}.` : '',
    lock.mark ? `Official mark to reproduce faithfully: ${lock.mark}.` : '',
    lock.placement ? `Logo placement: ${lock.placement}.` : '',
    brief.style ? `Brand style notes: ${textOf(brief.style).slice(0, 220)}.` : '',
    dishes ? `Confirmed dishes only: ${dishes}. Do not invent ingredients or extra menu items.` : 'No confirmed dish names; use a generic plated restaurant scene.',
    letteringTarget
      ? `Paint artistic custom lettering of this exact brand/campaign copy into the scene: ${letteringTarget}. ${lock.lettering || 'Hand-lettered, painted, neon or metal type as part of the set'}. Never a caption bar, never a system-font stamp, never empty slabs reserved for later typesetting.`
      : 'Prefer a wordless cinematic food campaign still. If any lettering appears it must be abstract decorative mark-making, not readable prices or slogans.',
    hasBrandAssets
      ? 'The first reference image is the official brand logo. Image-to-image: study its colors, geometry and lettering, then generate the campaign art around that understood mark. Keep the logo recognizable and design it into signage, tableware or a corner lockup. Never invent a different logo, never stamp it as a giant crude sticker after the photo is done.'
      : 'Do not invent a logo, watermark, QR code or platform name.',
    'Never render discounts, prices, currency, phone numbers, or any software-platform product name. Never invent offers.',
    slot.composition,
    'Fill the entire frame. Keep the same tableware, linens and lighting family across this set.',
  ].filter(Boolean).join('\n');
}

export function overlayLayersForSlot(brief = {}) {
  const layers = [];
  const theme = textOf(brief.theme);
  const dish = textOf((brief.dishes || [])[0]);
  const slogan = textOf(brief.slogan);
  const store = usableStoreName(brief.storeName);
  if (theme && !isUnusableCampaignStamp(theme)) {
    layers.push({ text: theme.slice(0, 24), role: 'title', position: 'top', align: 'center', maxWidth: 0.72 });
  }
  const subtitle = dish && !isUnusableCampaignStamp(dish) && dish !== theme
    ? dish
    : slogan && !isUnusableCampaignStamp(slogan) && slogan !== theme
      ? slogan
      : '';
  if (subtitle) {
    layers.push({ text: subtitle.slice(0, 20), role: 'subtitle', position: 'center', align: 'center' });
  }
  if (store) {
    layers.push({ text: store.slice(0, 18), role: 'store', position: 'bottom', align: 'center' });
  }
  return layers;
}

export function parseCampaignMaterialsPack(markdown) {
  const source = String(markdown || '');
  const match = source.match(new RegExp(`\`\`\`${CAMPAIGN_MATERIALS_FENCE}\\s*\\n([\\s\\S]*?)\`\`\``, 'u'));
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || parsed.record_type !== CAMPAIGN_MATERIALS_FENCE || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function stripCampaignMaterialsFence(markdown) {
  return String(markdown || '').replace(new RegExp(`\`\`\`${CAMPAIGN_MATERIALS_FENCE}[\\s\\S]*?\`\`\`\\s*`, 'gu'), '').trimEnd();
}

export function appendCampaignMaterialsSection(markdown, pack) {
  const body = stripCampaignMaterialsFence(markdown).trimEnd();
  const items = Array.isArray(pack?.items) ? pack.items : [];
  const lines = items.map((item, index) => {
    const status = item.status === 'succeeded'
      ? '已生成，可下载使用'
      : `未生成：${publicFailureNote({ message: item.note || '本轮生图未完成' })}`;
    return `${index + 1}. **${item.title}** — ${status}`;
  });
  const succeeded = items.filter(item => item.status === 'succeeded').length;
  const section = [
    '',
    '## 六、活动物料成图',
    succeeded
      ? `本轮先读取品牌 Logo 和视觉调性，理解后再图生图，生成了 ${succeeded} 张同一套品牌视觉物料。同类物料有多套备选，挑一套用即可。`
      : '本轮方案已完成，但物料图还没有生成成功。下面保留失败原因，不假装已经出图。',
    ...lines,
    '',
    `\`\`\`${CAMPAIGN_MATERIALS_FENCE}`,
    JSON.stringify(pack),
    '```',
  ].join('\n');
  return `${body}\n${section}\n`;
}

function mergeSupplierCosts(left = {}, right = {}) {
  const costs = [
    ...(Array.isArray(left.supplierCosts) ? left.supplierCosts : []),
    ...(Array.isArray(right.supplierCosts) ? right.supplierCosts : []),
    ...(Array.isArray(right.usage?.supplierCosts) ? right.usage.supplierCosts : []),
  ];
  return {
    inputTokens: Number(left.inputTokens || 0) + Number(right.inputTokens || right.usage?.inputTokens || 0),
    outputTokens: Number(left.outputTokens || 0) + Number(right.outputTokens || right.usage?.outputTokens || 0),
    ...(costs.length ? { supplierCosts: costs } : {}),
  };
}

function persistArtifactRow({ userId, sourceType, sourceId, title, fileUrl, fileName, metadata }) {
  q.run(
    `INSERT INTO generated_artifacts(user_id,source_type,source_id,title,format,content,file_url,file_name,metadata)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    userId,
    String(sourceType || 'agent_task').slice(0, 40),
    sourceId || null,
    String(title || '活动物料').slice(0, 100),
    'png',
    '',
    fileUrl,
    fileName,
    JSON.stringify(metadata || {}),
  );
}

export function campaignMaterialFilePath(url, tenantId) {
  const tenant = String(tenantId ?? '');
  const match = String(url || '').match(new RegExp(`^/uploads/poster-text/${tenant}/([A-Za-z0-9._-]+)$`, 'u'));
  if (!match) return null;
  const filePath = path.resolve(POSTER_TEXT_UPLOAD_ROOT, tenant, match[1]);
  const root = path.resolve(POSTER_TEXT_UPLOAD_ROOT, tenant);
  if (!filePath.startsWith(`${root}${path.sep}`)) return null;
  return filePath;
}

export async function generateSuperManagerCampaignMaterials({
  markdown,
  requirement = '',
  storeName = '',
  storeFacts = null,
  brandIdentity = null,
  referenceImages = [],
  attachments = [],
  tenantId,
  userId,
  sourceType = 'agent_task',
  sourceId = null,
  jobKey,
  selectedKinds,
  generateImageFn,
  editImageFn,
  chatFn,
  fetchFn,
  signal,
} = {}) {
  const identity = brandIdentity || resolveCampaignBrandIdentity();
  const brief = parseCampaignMaterialBrief(markdown, { requirement, storeName, storeFacts, brandIdentity: identity });
  const slots = resolveCampaignMaterialSlots({ requirement, selectedKinds });
  const model = routing().image;
  const items = [];
  let usage = {};
  const references = await materializeReferenceImages([
    identity?.logoUrl,
    ...(Array.isArray(identity?.logoUrls) ? identity.logoUrls : []),
    brief.logoUrl,
    referenceImages,
    attachments,
  ], { fetchFn, signal });
  const logoDataUrl = references.find((item) => /^data:image\/(?:png|jpeg|webp);base64,/iu.test(item)) || '';
  const understanding = await understandCampaignBrandVisuals({
    brief,
    logoDataUrl,
    chatFn,
    signal,
  });
  usage = mergeSupplierCosts(usage, understanding?.usage || {});
  const lock = campaignVisualLock(brief, understanding);
  const canDraw = Boolean(generateImageFn || (references.length && editImageFn));
  const credits = estimateMaxCredits('image', model) * Math.max(1, slots.length);
  let hold = null;
  if (userId && canDraw) {
    hold = holdCredits({
      userId,
      tenantId,
      feature: '超级店长·活动物料图',
      kind: 'image',
      model,
      credits,
      refType: 'campaign_materials',
      refId: sourceId,
    });
  }
  try {
    for (const [index, slot] of slots.entries()) {
      if (!canDraw) {
        items.push({
          id: slot.id,
          kind: slot.kind,
          variant: slot.variant || '',
          title: slot.title,
          groupTitle: slot.groupTitle,
          status: 'failed',
          note: '本轮未接入生图模型',
          url: null,
        });
        continue;
      }
      const prompt = campaignImagePrompt(brief, lock, slot, {
        hasBrandAssets: references.length > 0,
      });
      try {
        const generated = references.length && editImageFn
          ? await editImageFn({ prompt, images: references, size: slot.size, model, signal })
          : await generateImageFn({ prompt, size: slot.size, model, signal });
        usage = mergeSupplierCosts(usage, generated?.usage || generated || {});
        const url = generated?.url || (generated?.b64 ? `data:image/png;base64,${generated.b64}` : null);
        if (!url && !generated?.b64) throw new Error('生图模型未返回图像');
        const baseBytes = await loadGeneratedImageBytes(generated.b64 ? { b64: generated.b64 } : { url }, { signal });
        const persisted = await persistPosterTextArtifacts({
          tenantId: tenantId || curTenant(),
          jobId: persistJobId(jobKey, slot.id, index),
          basePng: baseBytes,
          baseFormat: { ext: 'png' },
          finalPng: baseBytes,
        });
        if (userId) {
          persistArtifactRow({
            userId,
            sourceType,
            sourceId,
            title: `${brief.theme || '活动'}·${slot.title}`,
            fileUrl: persisted.url,
            fileName: path.basename(persisted.finalImagePath),
            metadata: {
              schemaVersion: 'nanowork.campaign-material/3',
              slot: slot.id,
              kind: slot.kind,
              variant: slot.variant || '',
              visualLock: lock.seed,
              overlayBilled: false,
              overlayApplied: false,
              brandVision: understanding.source || '',
              brandIntegrated: references.length > 0,
              storeName: brief.storeName || '',
              theme: brief.theme || '',
            },
          });
        }
        items.push({
          id: slot.id,
          kind: slot.kind,
          variant: slot.variant || '',
          title: slot.title,
          groupTitle: slot.groupTitle,
          status: 'succeeded',
          url: persisted.url,
          baseImageUrl: persisted.baseImageUrl,
          note: references.length
            ? `已先理解品牌Logo与调性，再图生图融入${[brief.storeName, brief.theme].filter(Boolean).join(' / ')}`
            : '艺术成图',
        });
      } catch (error) {
        items.push({
          id: slot.id,
          kind: slot.kind,
          variant: slot.variant || '',
          title: slot.title,
          groupTitle: slot.groupTitle,
          status: 'failed',
          url: null,
          note: publicFailureNote(error),
        });
      }
    }
    const succeeded = items.filter(item => item.status === 'succeeded').length;
    if (hold) {
      if (succeeded) {
        try {
          settleHold(hold, { usage, model, aiMode: 'api' });
        } catch (error) {
          if (error?.code !== 'BILLING_SUPPLIER_COST_PENDING') throw error;
        }
      } else {
        refundHold(hold, { note: '超级店长活动物料图未生成可交付文件，预授权全额退回' });
      }
      hold = null;
    }
    return Object.freeze({
      record_type: CAMPAIGN_MATERIALS_FENCE,
      visualLock: lock.seed,
      brandVision: understanding.source || '',
      brief: {
        storeName: brief.storeName,
        theme: brief.theme,
        dishes: brief.dishes,
        offer: brief.offer,
        date: brief.date,
        logoUrl: brief.logoUrl || '',
        style: brief.style || '',
      },
      items: Object.freeze(items.map(item => Object.freeze(item))),
      usage,
    });
  } catch (error) {
    if (hold) {
      refundHold(hold, { note: '超级店长活动物料图中断，预授权全额退回' });
    }
    throw error;
  }
}

export async function readCampaignMaterialFile(url, tenantId) {
  const filePath = campaignMaterialFilePath(url, tenantId);
  if (!filePath) return null;
  try {
    const bytes = await fs.readFile(filePath);
    if (!bytes.length) return null;
    return { filePath, bytes, mimeType: 'image/png', fileName: path.basename(filePath) };
  } catch {
    return null;
  }
}

export async function attachSuperManagerCampaignMaterials(result, context = {}) {
  const markdown = String(result?.text || '').trim();
  if (!markdown) return result;
  const storeFacts = context.storeFacts || (context.tenantId
    ? buildContentStoreFactPack(Number(context.tenantId), { storeId: context.storeId })
    : null);
  const brandIdentity = context.brandIdentity || resolveCampaignBrandIdentity();
  const pack = await generateSuperManagerCampaignMaterials({
    markdown,
    requirement: context.requirement || '',
    storeName: brandIdentity?.brandName || context.storeName || storeFacts?.storeName || '',
    storeFacts,
    brandIdentity,
    referenceImages: context.referenceImages || [],
    attachments: context.attachments || [],
    tenantId: context.tenantId,
    userId: context.userId,
    sourceType: context.sourceType,
    sourceId: context.sourceId,
    jobKey: context.jobKey,
    selectedKinds: context.selectedKinds,
    generateImageFn: context.generateImageFn,
    editImageFn: context.editImageFn,
    chatFn: context.chatFn,
    signal: context.signal,
  });
  return {
    ...result,
    text: appendCampaignMaterialsSection(markdown, pack),
    campaignMaterials: pack,
    usage: mergeSupplierCosts(result.usage || {}, pack.usage || {}),
  };
}

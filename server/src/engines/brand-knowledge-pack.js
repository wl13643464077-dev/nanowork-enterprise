import { curTenant, q } from '../db.js';
import { estimateMaxCredits, holdCredits, refundHold, settleHold } from './credits.js';
import { embedDoc } from './rag.js';
import { webSearch } from './websearch.js';
import { chat, routing } from './yunwu.js';
import { AMAP_RESTAURANT_TYPECODE, searchText } from './amap.js';
import { fetchPublicPageEvidence } from './controlled-web-evidence.js';

export const BRAND_KB_CATEGORY = '品牌知识包';
export const COMPETITOR_KB_CATEGORY = '竞品档案';
export const COMPETITOR_PACK_LIMIT = 3;
export const BRAND_PACK_SOURCE_TYPE = 'brand_pack';
export const BRAND_PACK_WINDOW_DAYS = 90;

function normalizePackRole(value) {
  return String(value || '').trim().toLowerCase() === 'competitor' ? 'competitor' : 'own';
}

export const BRAND_KNOWLEDGE_DIMENSIONS = Object.freeze([
  Object.freeze({ key: 'identity', title: '品牌全称与别名' }),
  Object.freeze({ key: 'logo', title: '品牌Logo与视觉识别' }),
  Object.freeze({ key: 'mission', title: '品牌理念与使命' }),
  Object.freeze({ key: 'story', title: '品牌故事与创立背景' }),
  Object.freeze({ key: 'slogan', title: '口号与传播语' }),
  Object.freeze({ key: 'category', title: '主营品类' }),
  Object.freeze({ key: 'products', title: '招牌产品与SKU' }),
  Object.freeze({ key: 'price', title: '价格带' }),
  Object.freeze({ key: 'audience', title: '目标客群' }),
  Object.freeze({ key: 'channels', title: '门店与渠道布局' }),
  Object.freeze({ key: 'campaigns', title: '近三个月活动' }),
  Object.freeze({ key: 'news', title: '近三个月新闻与舆情' }),
  Object.freeze({ key: 'competitors', title: '竞品对照' }),
  Object.freeze({ key: 'service', title: '服务承诺与售后' }),
  Object.freeze({ key: 'style', title: '视觉与包装风格' }),
  Object.freeze({ key: 'official', title: '官方渠道' }),
  Object.freeze({ key: 'people', title: '创始人与公开管理层' }),
  Object.freeze({ key: 'franchise', title: '加盟与招商政策' }),
  Object.freeze({ key: 'compliance', title: '资质与食品安全公开信息' }),
  Object.freeze({ key: 'reviews', title: '用户口碑关键词' }),
  Object.freeze({ key: 'seasonal', title: '季节与节日打法' }),
  Object.freeze({ key: 'supply', title: '产地与供应链故事' }),
  Object.freeze({ key: 'esg', title: '社会责任与公开承诺' }),
  Object.freeze({ key: 'content', title: '近三个月内容热点' }),
]);

function textOf(value, max = 80) {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function nowWindowLabel() {
  const end = new Date();
  const start = new Date(end.getTime() - BRAND_PACK_WINDOW_DAYS * 24 * 3600 * 1000);
  const fmt = (date) => `${date.getFullYear()}年${date.getMonth() + 1}月`;
  return `${fmt(start)}至${fmt(end)}`;
}

export function normalizeBrandName(value) {
  const brand = textOf(value, 40);
  if (brand.length < 2) {
    throw Object.assign(new Error('请输入至少2个字的品牌名'), { status: 400, code: 'BRAND_NAME_REQUIRED' });
  }
  return brand;
}

function parseJsonPayload(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const source = fenced ? fenced[1] : text;
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(source.slice(start, end + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}

const SYNTH_BATCH_SIZE = 8;
const CITY_PREFIX = /^(北京|上海|天津|重庆|广州|深圳|杭州|南京|成都|武汉|西安|苏州|青岛|厦门|长沙|郑州|沈阳|大连|合肥|福州|济南|哈尔滨|长春|石家庄|太原|南昌|南宁|海口|贵阳|昆明|兰州)/u;
const TIME_SENSITIVE_KEYS = new Set(['campaigns', 'news', 'content']);
const NEWS_HOST = /(?:news\.google|google\.com\/rss|sogou\.com\/sogou)/iu;
const BRAND_PAGE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BRAND_PAGE_LIMIT = 16;

function usableEvidenceItem(item) {
  if (!item?.url) return false;
  const blob = `${item.body || ''} ${item.snippet || ''}`.replace(/\s+/gu, ' ').trim();
  if (blob.length >= 20) return true;
  if (Array.isArray(item.images) && item.images.some(image => image?.url)) return true;
  return /高德门店/.test(item.title || '');
}

function encyclopediaSeeds(brand) {
  return brandTokens(brand).slice(0, 2).map(token => ({
    title: `${token} 百科`,
    url: `https://baike.baidu.com/item/${encodeURIComponent(token)}`,
    snippet: '',
  }));
}

function urlsFromText(value) {
  return [...String(value || '').matchAll(/https?:\/\/[^\s)）"'<>]+/gu)]
    .map(match => match[0].replace(/[.,;。，]+$/u, ''))
    .filter(url => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    });
}

function urlsFromDimensions(dimensions = []) {
  return (Array.isArray(dimensions) ? dimensions : []).flatMap(item => [
    ...urlsFromText(item.body),
    ...((item.sources || []).map(source => source.url).filter(Boolean)),
  ]);
}

async function fetchBrandPages(sources, {
  limit = BRAND_PAGE_LIMIT,
  timeoutMs = 12000,
  signal,
  fetchPageFn = (url, opts) => fetchPublicPageEvidence(url, { ...opts, userAgent: BRAND_PAGE_UA }),
} = {}) {
  const urls = [...new Set((Array.isArray(sources) ? sources : [])
    .map(source => String(source?.url || source || '').trim())
    .filter(url => url.startsWith('http')))]
    .slice(0, Math.max(1, Math.min(BRAND_PAGE_LIMIT, Number(limit) || BRAND_PAGE_LIMIT)));
  const settled = await Promise.allSettled(urls.map(url => fetchPageFn(url, { timeoutMs, signal })));
  return {
    results: settled.flatMap((entry, index) => {
      if (entry.status !== 'fulfilled' || !entry.value) return [];
      return [{ ...entry.value, requestedUrl: urls[index] }];
    }),
  };
}

function brandTokens(brand) {
  const full = textOf(brand, 40);
  const stripped = full.replace(CITY_PREFIX, '').trim();
  const core = stripped.replace(/(烤鸭|火锅|烧烤|餐饮|酒楼|集团|股份)$/u, '').trim();
  return [...new Set([full, stripped, core].filter(item => item.length >= 2))];
}

function inferCity(brand) {
  return String(brand || '').match(CITY_PREFIX)?.[1] || '';
}

function textMentionsBrand(text, brand) {
  const hay = String(text || '').replace(/\s+/gu, '');
  return brandTokens(brand).some(token => hay.includes(token.replace(/\s+/gu, '')));
}

function searchQueries(brand) {
  const core = brandTokens(brand).at(-1) || brand;
  return [
    `${brand}`,
    `${brand} 官网`,
    `${core} 官方网站`,
    `${core} 餐饮有限公司 官网`,
    `${brand} 品牌故事 创立 理念 使命 口号`,
    `${brand} logo 标志 视觉识别`,
    `${brand} 百度百科`,
    `${core} 百科`,
    `${brand} 关于我们 企业文化`,
    `${brand} 菜单 招牌菜`,
    `${brand} 门店 地址`,
    `${brand} 加盟`,
    `${brand} 大众点评`,
    `${core} 美团 评分 推荐菜`,
    `${brand} 食品安全 资质 许可证 ICP`,
    `${brand} 中秋 端午 年夜饭 节假日`,
  ];
}

function chunkKeys(keys, size = SYNTH_BATCH_SIZE) {
  const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
  const chunks = [];
  for (let index = 0; index < list.length; index += size) {
    chunks.push(list.slice(index, index + size));
  }
  return chunks.length ? chunks : [[]];
}

function mergeChatUsage(left = {}, right = {}) {
  return {
    ...right,
    inputTokens: Number(left.inputTokens || 0) + Number(right.inputTokens || 0),
    outputTokens: Number(left.outputTokens || 0) + Number(right.outputTokens || 0),
    text: right.text || left.text,
  };
}

function evidenceLines(results) {
  return (Array.isArray(results) ? results : [])
    .filter(item => item?.title && item?.url)
    .slice(0, 40)
    .map(item => {
      const logos = (Array.isArray(item.images) ? item.images : [])
        .filter(image => image?.url && (image.isLogo || /logo/iu.test(image.url)))
        .filter(image => !isThirdPartyBrandAsset(image.url) && !isThirdPartyBrandAsset(item.url))
        .map(image => image.url);
      const excerpt = textOf(item.body || item.snippet, 1800);
      return `- ${textOf(item.title, 80)}｜${String(item.url).slice(0, 240)}${excerpt ? `｜${excerpt}` : ''}${logos.length ? `｜Logo图片:${logos.slice(0, 3).join(' ')}` : ''}`;
    });
}

function preferFilled(seed = [], synthesized = []) {
  const byKey = new Map((synthesized || []).map(item => [item.key, item]));
  return (seed.length ? seed : emptyDimensions()).map(item => {
    const next = byKey.get(item.key);
    if (!next) return item;
    if (item.status === 'filled' && next.status === 'pending') return item;
    if (item.key === 'logo' && item.status === 'filled' && /https?:\/\/\S+\.(?:png|jpe?g|gif|svg|webp)/iu.test(item.body)) {
      return item;
    }
    return { ...next, sortOrder: item.sortOrder };
  });
}

export function emptyDimensions() {
  return BRAND_KNOWLEDGE_DIMENSIONS.map((item, index) => ({
    key: item.key,
    title: item.title,
    body: '待核验：公开检索未形成可引用事实。',
    status: 'pending',
    included: true,
    sources: [],
    sortOrder: index + 1,
  }));
}

function mergeDimensions(parsed) {
  const incoming = Array.isArray(parsed?.dimensions)
    ? parsed.dimensions
    : Array.isArray(parsed)
      ? parsed
      : [];
  const byKey = new Map(incoming.map(item => [String(item?.key || ''), item]));
  return BRAND_KNOWLEDGE_DIMENSIONS.map((item, index) => {
    const found = byKey.get(item.key) || {};
    const body = textOf(found.body || found.text || found.content, 2000);
    const sources = Array.isArray(found.sources)
      ? found.sources.map(source => ({
        title: textOf(source.title || source.name, 80),
        url: String(source.url || '').slice(0, 400),
      })).filter(source => source.url.startsWith('http'))
      : [];
    const filled = Boolean(body) && !/^待核验/u.test(body);
    return {
      key: item.key,
      title: item.title,
      body: filled ? body : '待核验：公开检索未形成可引用事实。',
      status: filled ? 'filled' : 'pending',
      included: found.included !== false,
      sources,
      sortOrder: index + 1,
    };
  });
}

export function compileBrandPackMarkdown(pack, dimensions) {
  const rows = (Array.isArray(dimensions) ? dimensions : []).filter(item => item.included !== false);
  const filled = rows.filter(item => item.status === 'filled' || item.status === 'edited').length;
  const isCompetitor = normalizePackRole(pack.packRole || pack.pack_role) === 'competitor';
  return [
    isCompetitor ? `# 【竞品档案】${pack.brandName} 品牌知识包` : `# ${pack.brandName} 品牌知识包`,
    '',
    ...(isCompetitor ? ['- 档案角色：竞品对照档案（仅供竞争分析与差异化定位对照，禁止与本企业自有品牌混淆）'] : []),
    `- 覆盖窗口：近 ${pack.windowDays || BRAND_PACK_WINDOW_DAYS} 天（${pack.windowLabel || nowWindowLabel()}）`,
    `- 版本：v${pack.version || 1}`,
    `- 已填写维度：${filled}/${BRAND_KNOWLEDGE_DIMENSIONS.length}`,
    '- 未核验证据一律标「待核验」，数字员工不得写成当前门店已确认事实。',
    pack.summary ? `- 摘要：${pack.summary}` : '',
    '',
    ...rows.flatMap(item => [
      `## ${item.sortOrder}. ${item.title}`,
      '',
      item.body || '待核验',
      ...(Array.isArray(item.sources) && item.sources.length
        ? ['', '来源：', ...item.sources.slice(0, 4).map(source => `- ${source.title || '公开网页'} ${source.url}`)]
        : []),
      '',
    ]),
  ].filter(line => line !== '').join('\n');
}

export function loadActiveBrandPack(tenantId = curTenant()) {
  return q.get(
    `SELECT * FROM brand_knowledge_packs
     WHERE tenant_id=? AND COALESCE(pack_role, 'own') = 'own'
       AND status IN ('ready','review','collecting','failed')
     ORDER BY id DESC LIMIT 1`,
    tenantId,
  ) || null;
}

export function loadCompetitorBrandPacks(tenantId = curTenant()) {
  return q.all(
    `SELECT * FROM brand_knowledge_packs
     WHERE tenant_id=? AND COALESCE(pack_role, 'own') = 'competitor'
       AND status != 'archived'
     ORDER BY id DESC LIMIT ?`,
    tenantId,
    COMPETITOR_PACK_LIMIT,
  );
}

function loadBrandPackById(packId, tenantId = curTenant()) {
  const id = Number(packId);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error('无效的品牌知识包 ID'), { status: 400, code: 'BRAND_PACK_INVALID_ID' });
  }
  return q.get(
    `SELECT * FROM brand_knowledge_packs
     WHERE tenant_id=? AND id=? AND status != 'archived'`,
    tenantId,
    id,
  ) || null;
}

function resolveTargetPack(packId = null, tenantId = curTenant()) {
  if (packId !== null && packId !== undefined && packId !== '') {
    const found = loadBrandPackById(packId, tenantId);
    if (!found) {
      throw Object.assign(new Error('指定的品牌知识包不存在'), { status: 404, code: 'BRAND_PACK_NOT_FOUND' });
    }
    return found;
  }
  const pack = loadActiveBrandPack(tenantId);
  if (!pack) throw Object.assign(new Error('还没有品牌知识包'), { status: 404, code: 'BRAND_PACK_NOT_FOUND' });
  return pack;
}

export function loadBrandDimensions(packId, tenantId = curTenant()) {
  return q.all(
    `SELECT * FROM brand_knowledge_dimensions
     WHERE tenant_id=? AND pack_id=? ORDER BY sort_order ASC, id ASC`,
    tenantId,
    packId,
  );
}

export const PLATFORM_BRAND_STAMP = /纳米\s*work|纳米work|nano\s*work|nanowork|纳米企业|企业版本|行业版/iu;

export function isPlatformBrandStamp(value) {
  const text = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!text) return false;
  if (/^(?:纳米|企业|work|nanowork|nano work)$/iu.test(text)) return true;
  return PLATFORM_BRAND_STAMP.test(text);
}

// 第三方平台（企查查、百科、点评、搜索引擎、社媒）页面里的 logo 是平台自己的标志，
// 不能当成品牌 Logo。只接受品牌自有站点的图片，并优先与官网同域、文件名带 logo 的。
const THIRD_PARTY_ASSET_HOST = /(?:^|\.)(?:qcc\.com|qichacha\.com|tianyancha\.com|aiqicha\.baidu\.com|baidu\.com|bdstatic\.com|bdimg\.com|sogou\.com|so\.com|360\.cn|qhimg\.com|qhres\.com|dianping\.com|meituan\.com|meituan\.net|amap\.com|autonavi\.com|google\.com|gstatic\.com|bing\.com|bing\.net|xiaohongshu\.com|xhscdn\.com|douyin\.com|douyinpic\.com|weibo\.com|sinaimg\.cn|sina\.com\.cn|zhihu\.com|zhimg\.com|sohu\.com|163\.com|126\.net|qq\.com|gtimg\.cn|wikipedia\.org|wikimedia\.org|toutiao\.com|bytedance\.com|jd\.com|360buyimg\.com|taobao\.com|alicdn\.com)$/iu;

function assetHost(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return '';
  }
}

export function isThirdPartyBrandAsset(url) {
  const host = assetHost(url);
  return !host || THIRD_PARTY_ASSET_HOST.test(host);
}

export function rankBrandLogoCandidates(pages = [], brand = '') {
  const seen = new Set();
  return (Array.isArray(pages) ? pages : [])
    .flatMap(page => (Array.isArray(page?.images) ? page.images : []).map(image => ({
      ...image,
      pageTitle: page.title,
      pageUrl: page.url,
    })))
    .filter(image => image?.url && (image.isLogo || /logo/iu.test(image.url)))
    .filter(image => !isThirdPartyBrandAsset(image.url) && !isThirdPartyBrandAsset(image.pageUrl))
    .filter(image => (seen.has(image.url) ? false : seen.add(image.url)))
    .map(image => {
      const sameSite = assetHost(image.url) && assetHost(image.url) === assetHost(image.pageUrl);
      const named = /logo/iu.test(String(image.url).split('/').pop() || '');
      const branded = textMentionsBrand(`${image.pageTitle || ''} ${image.alt || ''}`, brand);
      return { ...image, score: (sameSite ? 4 : 0) + (named ? 2 : 0) + (branded ? 2 : 0) + (image.isLogo ? 1 : 0) };
    })
    .sort((a, b) => b.score - a.score);
}

export function extractBrandAssetUrl(body) {
  const text = String(body || '');
  const match = text.match(/https?:\/\/[^\s"'<>]+(?:logo[^/\s"'<>]*|\.(?:png|jpe?g|webp|svg))/iu)
    || text.match(/https?:\/\/[^\s"'<>]+/iu);
  return match ? match[0].replace(/[).,，。；;]+$/u, '').slice(0, 400) : '';
}

export function extractBrandAssetUrls(body) {
  const text = String(body || '');
  const urls = [];
  const seen = new Set();
  const pattern = /https?:\/\/[^\s"'<>]+(?:logo[^/\s"'<>]*|\.(?:png|jpe?g|webp|svg))/giu;
  for (const match of text.matchAll(pattern)) {
    const url = match[0].replace(/[).,，。；;]+$/u, '').slice(0, 400);
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls.slice(0, 4);
}

export function campaignBrandIdentity(tenantId = curTenant()) {
  const pack = loadActiveBrandPack(tenantId);
  if (!pack || pack.status !== 'ready') return null;
  const brandName = String(pack.brand_name || '').replace(/\s+/gu, ' ').trim();
  if (brandName.length < 2) return null;
  const rows = loadBrandDimensions(pack.id, tenantId);
  const filled = (key) => rows.find((row) => row.dim_key === key
    && Number(row.included ?? 1) !== 0
    && row.status !== 'pending'
    && String(row.body || '').trim());
  const products = String(filled('products')?.body || '');
  const dishes = [...products.matchAll(/[\u4e00-\u9fff]{2,12}(?:烤鸭|挂炉|片皮|卤鸭|酥皮虾|大拌菜)/gu)]
    .map((item) => item[0])
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, 3);
  const logoUrls = [
    ...extractBrandAssetUrls(filled('logo')?.body),
    ...extractBrandAssetUrls(filled('style')?.body),
    ...extractBrandAssetUrls(filled('official')?.body),
  ].filter((item, index, all) => all.indexOf(item) === index && !isThirdPartyBrandAsset(item)).slice(0, 4);
  return {
    brandName,
    logoUrl: logoUrls[0] || '',
    logoUrls,
    slogan: String(filled('slogan')?.body || '').replace(/\s+/gu, ' ').trim().slice(0, 40),
    dishes,
    seasonal: String(filled('seasonal')?.body || '').replace(/\s+/gu, ' ').trim().slice(0, 80),
    style: String(filled('style')?.body || '').replace(/\s+/gu, ' ').trim().slice(0, 400),
    mission: String(filled('mission')?.body || '').replace(/\s+/gu, ' ').trim().slice(0, 200),
    identity: String(filled('identity')?.body || '').replace(/\s+/gu, ' ').trim().slice(0, 160),
  };
}

export function uploadedKnowledgeSummary(tenantId = curTenant()) {
  const row = q.get(
    `SELECT COUNT(*) n FROM kb_docs
     WHERE tenant_id=? AND enabled=1
       AND (source_type IS NULL OR source_type <> ?)`,
    tenantId,
    BRAND_PACK_SOURCE_TYPE,
  );
  return { count: Number(row?.n || 0) };
}

export function withBrandKnowledgeCategories(categories = []) {
  const requested = Array.isArray(categories) ? categories.filter(Boolean) : [];
  const fallback = requested.length
    ? requested
    : ['品牌资料', '招商政策', '话术案例', '客户画像'];
  return [...new Set([BRAND_KB_CATEGORY, COMPETITOR_KB_CATEGORY, ...fallback, '员工产出'])];
}

export function brandMatchExcerpts(query, tenantId = curTenant()) {
  const pack = loadActiveBrandPack(tenantId);
  if (!pack || pack.status !== 'ready') return '';
  const brand = String(pack.brand_name || '').trim();
  if (brand.length < 2 || isPlatformBrandStamp(brand)) return '';
  const qtext = String(query || '').replace(/\s+/gu, ' ').trim();
  const dimensions = loadBrandDimensions(pack.id, tenantId).map(projectDimension);
  const filled = dimensions.filter((dim) => dim
    && dim.included !== false
    && dim.status !== 'pending'
    && String(dim.body || '').trim()
    && !/^待核验/u.test(String(dim.body || '').trim()));
  if (!filled.length) return '';
  const coreKeys = ['identity', 'logo', 'mission', 'slogan', 'story', 'products', 'style', 'seasonal', 'audience', 'category'];
  const core = coreKeys.map((key) => filled.find((dim) => dim.key === key)).filter(Boolean);
  const scored = [];
  const brandHit = Boolean(brand) && qtext.toLowerCase().includes(brand.toLowerCase());
  if (qtext.length >= 2) {
    for (const dim of filled) {
      if (core.some((item) => item.key === dim.key)) continue;
      const hay = `${dim.title}\n${dim.body}`;
      let score = 0;
      if (brandHit && ['identity', 'logo', 'mission', 'products', 'style', 'slogan'].includes(dim.key)) {
        score += 2;
      }
      if (hay.includes(qtext.slice(0, 24))) score += 2;
      for (let i = 0; i < qtext.length - 1; i += 1) {
        const gram = qtext.slice(i, i + 2);
        if (/[\u4e00-\u9fff]/u.test(gram) && hay.includes(gram)) score += 0.35;
      }
      if (dim.key === 'products') score += 0.4;
      if (score >= 1.2) scored.push({ dim, score });
    }
    scored.sort((a, b) => b.score - a.score);
  }
  const picked = [];
  const seen = new Set();
  for (const dim of [...core, ...scored.map((item) => item.dim)]) {
    if (seen.has(dim.key)) continue;
    seen.add(dim.key);
    picked.push(dim);
  }
  if (!picked.length) return '';
  return [
    `【品牌知识包·优先匹配·${pack.brand_name}】`,
    `本租户已确认入库的品牌是「${brand}」。对外店名、口号、理念、招牌和视觉调性只能用下面已核验正文；禁止改成平台产品名，禁止编造未出现的折扣价格。没有公开价就标待核验。`,
    ...picked.slice(0, 12).map((item) => `## ${item.title}\n${item.body}`),
  ].join('\n\n').slice(0, 3200);
}

function projectDimension(row) {
  if (!row) return null;
  let sources = [];
  try { sources = JSON.parse(row.sources_json || '[]'); } catch { sources = []; }
  return {
    id: Number(row.id),
    key: row.dim_key,
    title: row.title,
    body: row.body,
    status: row.status,
    included: Number(row.included ?? 1) !== 0,
    sources: Array.isArray(sources) ? sources : [],
    sortOrder: Number(row.sort_order || 0),
    updatedAt: row.updated_at,
  };
}

export function projectBrandPack(pack, dimensions = loadBrandDimensions(pack?.id)) {
  if (!pack) return null;
  const items = (dimensions || []).map(projectDimension);
  return {
    id: Number(pack.id),
    brandName: pack.brand_name,
    packRole: normalizePackRole(pack.pack_role),
    status: pack.status,
    version: Number(pack.version || 1),
    windowDays: Number(pack.window_days || BRAND_PACK_WINDOW_DAYS),
    source: pack.source,
    summary: pack.summary || '',
    kbDocId: pack.kb_doc_id ? Number(pack.kb_doc_id) : null,
    lastError: pack.last_error || '',
    collectedAt: pack.collected_at,
    createdAt: pack.created_at,
    updatedAt: pack.updated_at,
    dimensionCount: items.length,
    filledCount: items.filter(item => item.status === 'filled' || item.status === 'edited').length,
    selectedCount: items.filter(item => item.included !== false).length,
    published: pack.status === 'ready' && Boolean(pack.kb_doc_id),
    dimensions: items,
  };
}

function replacePackDimensions(packId, dimensions, tenantId = curTenant()) {
  q.run(`DELETE FROM brand_knowledge_dimensions WHERE tenant_id=? AND pack_id=?`, tenantId, packId);
  for (const item of dimensions) {
    q.run(
      `INSERT INTO brand_knowledge_dimensions(pack_id,dim_key,title,body,status,sources_json,included,sort_order)
       VALUES(?,?,?,?,?,?,?,?)`,
      packId,
      item.key,
      item.title,
      item.body,
      item.status,
      JSON.stringify(item.sources || []),
      item.included === false ? 0 : 1,
      item.sortOrder,
    );
  }
}

function upsertKbDoc(pack, markdown) {
  const isCompetitor = normalizePackRole(pack.pack_role) === 'competitor';
  const category = isCompetitor ? COMPETITOR_KB_CATEGORY : BRAND_KB_CATEGORY;
  const title = isCompetitor
    ? `【竞品档案】${pack.brand_name} 品牌知识包`
    : `${pack.brand_name}·品牌知识包`;
  const existing = pack.kb_doc_id
    ? q.get(`SELECT id FROM kb_docs WHERE tenant_id=? AND id=?`, curTenant(), pack.kb_doc_id)
    : q.get(
      `SELECT id FROM kb_docs WHERE tenant_id=? AND source_type=? AND source_id=?`,
      curTenant(),
      BRAND_PACK_SOURCE_TYPE,
      pack.id,
    );
  if (existing) {
    q.run(
      `UPDATE kb_docs SET title=?, body=?, category=?, enabled=1, version=version+1, updated_at=datetime('now','localtime')
       WHERE tenant_id=? AND id=?`,
      title,
      markdown,
      category,
      curTenant(),
      existing.id,
    );
    try { embedDoc(existing.id, title, markdown); } catch { /* 向量化失败不阻断知识包入库 */ }
    return existing.id;
  }
  const inserted = q.run(
    `INSERT INTO kb_docs(category,title,body,source_type,source_id,enabled)
     VALUES(?,?,?,?,?,1)`,
    category,
    title,
    markdown,
    BRAND_PACK_SOURCE_TYPE,
    pack.id,
  );
  try { embedDoc(inserted.lastInsertRowid, title, markdown); } catch { /* 向量化失败不阻断知识包入库 */ }
  return Number(inserted.lastInsertRowid);
}

function amapPlaceUrl(poi) {
  if (poi?.coords?.lng != null && poi?.coords?.lat != null) {
    return `https://uri.amap.com/marker?position=${poi.coords.lng},${poi.coords.lat}&name=${encodeURIComponent(poi.name || '')}`;
  }
  return poi?.id ? `https://www.amap.com/detail/${poi.id}` : '';
}

function seedDimensionsFromPois(brand, pois = []) {
  const rows = (Array.isArray(pois) ? pois : []).filter(item => item?.name);
  const seeded = emptyDimensions();
  if (!rows.length) return seeded;
  const names = [...new Set(rows.map(item => item.name))].slice(0, 10);
  const cities = [...new Set(rows.map(item => item.cityname).filter(Boolean))];
  const types = [...new Set(rows.map(item => String(item.type || '').split(';')[0]).filter(Boolean))];
  const costs = rows.map(item => Number(item.biz_ext?.cost)).filter(value => value > 0);
  const sources = rows.slice(0, 8).map(item => ({
    title: textOf(item.name, 80),
    url: amapPlaceUrl(item),
  })).filter(item => item.url.startsWith('http'));
  const fill = (key, body) => {
    const index = seeded.findIndex(item => item.key === key);
    if (index < 0) return;
    seeded[index] = { ...seeded[index], body, status: 'filled', sources };
  };
  fill('identity', `公开检索到的门店名称包括：${names.join('、')}。检索品牌名：${brand}。`);
  if (types.length) fill('category', `高德餐饮分类公开为：${types.slice(0, 4).join('、')}。`);
  fill('channels', `高德公开门店 ${rows.length} 家${cities.length ? `，分布城市：${cities.join('、')}` : ''}。门店样例：${rows.slice(0, 8).map(item => `${item.name}｜${item.cityname || ''}${item.adname || ''}${item.address || ''}${item.tel ? `｜电话${item.tel}` : ''}`).join('；')}。`);
  if (costs.length) {
    fill('price', `高德门店公开人均 ${Math.min(...costs)}-${Math.max(...costs)} 元（样本 ${costs.length} 家，不是本店价目表）。`);
  }
  return seeded;
}

function pageSourceList(pages = [], extra = []) {
  return [...(Array.isArray(pages) ? pages : []), ...extra]
    .map(item => ({
      title: textOf(item.title || item.name, 80),
      url: String(item.url || ''),
    }))
    .filter(item => item.url.startsWith('http'))
    .filter((item, index, list) => list.findIndex(other => other.url === item.url) === index)
    .slice(0, 8);
}

function uniqueSentences(values) {
  const seen = new Set();
  const rows = [];
  for (const value of values) {
    const line = textOf(value, 240);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    rows.push(line);
  }
  return rows;
}

function evidenceCorpus(pages = []) {
  return (Array.isArray(pages) ? pages : [])
    .map(page => `${page.title || ''}\n${page.snippet || ''}\n${page.body || ''}`)
    .join('\n');
}

function firstMatch(corpus, pattern) {
  return String(corpus || '').match(pattern)?.[0] || '';
}

function seedDimensionsFromEvidence(brand, { pois = [], results = [] } = {}) {
  const seeded = seedDimensionsFromPois(brand, pois);
  const pages = (Array.isArray(results) ? results : []).filter(item => item?.url);
  if (!pages.length) return seeded;
  const corpus = evidenceCorpus(pages);
  const officialPages = pages.filter(item => /官网|有限公司|餐饮集团|About\.aspx|Newslist\.aspx|\/about/iu.test(`${item.title || ''} ${item.url || ''}`));
  const reviewPages = pages.filter(item => /dianping|大众点评|meituan|美团/iu.test(`${item.title || ''} ${item.url || ''}`));
  const fill = (key, body, extraSources = []) => {
    const index = seeded.findIndex(item => item.key === key);
    if (index < 0 || !body) return;
    const sources = pageSourceList([
      ...extraSources,
      ...(officialPages.length ? officialPages : pages),
    ]);
    seeded[index] = {
      ...seeded[index],
      body: textOf(body, 2000),
      status: 'filled',
      sources: sources.length ? sources : seeded[index].sources,
    };
  };

  const logos = rankBrandLogoCandidates(pages, brand);
  if (logos.length) {
    fill(
      'logo',
      `官网公开的品牌标志图片：${logos[0].url}。请打开该链接核对照片是否为本品牌 Logo，不要把导航图标或门头照误当成司徽。`,
      [{ title: '官网Logo', url: logos[0].url }, { title: logos[0].pageTitle, url: logos[0].pageUrl }],
    );
  }

  const founded = firstMatch(corpus, /成立于\d{4}年\d{1,2}月(?:\d{1,2}日)?/);
  const firstStore = firstMatch(corpus, /第一家.{0,24}(?:开业|成立)/u);
  const storeScale = firstMatch(corpus, /直营门店\d+余家/);
  const canada = firstMatch(corpus, /2012年.{0,20}加拿大/u);
  if (founded || firstStore) {
    fill('story', [
      founded ? `官网公开：品牌所属公司${founded}。` : '',
      firstStore ? `官网新闻写明${firstStore}。` : '',
      storeScale ? `官网称现有${storeScale}，以北京为核心。` : '',
      canada ? `官网称${canada}。` : '',
    ].filter(Boolean).join(''));
  }

  const idea = firstMatch(corpus, /秉承[“"「][^”"」]{6,40}[”"」]之理念/);
  const vision = firstMatch(corpus, /我们的愿景[：:]\s*[^\n。]{2,40}/);
  const missionLine = firstMatch(corpus, /我们的使命[：:]\s*[^\n。]{2,80}/);
  const belief = firstMatch(corpus, /我们的信念[：:]\s*[^\n。]{2,40}/);
  if (idea || vision || missionLine) {
    fill('mission', uniqueSentences([
      idea ? `官网公开品牌理念：${idea}。` : '',
      vision,
      missionLine,
      belief,
      firstMatch(corpus, /诚实信用.{0,6}是.{0,12}根本之道/),
      firstMatch(corpus, /服务大众.{0,6}是.{0,12}经营之道/),
    ]).join(' '));
  }

  const slogans = uniqueSentences([
    vision?.replace(/^我们的愿景[：:]\s*/u, ''),
    firstMatch(corpus, /我们的客户观[：:]\s*[^\n。]{2,40}/),
    firstMatch(corpus, /我们的产品观[：:]\s*[^\n。]{2,40}/),
    firstMatch(corpus, /我们的司训[：:]\s*[^\n。]{2,40}/),
    firstMatch(corpus, /专注烤鸭二十[年载]/),
    firstMatch(corpus, /吃烤鸭哪里去[，,].{2,20}/),
    firstMatch(corpus, /百年基业[，, ]?百店常兴/),
    firstMatch(corpus, /客户的满意高于一切/),
    firstMatch(corpus, /鸭梨味[，, ]?味天下/),
  ].filter(Boolean));
  if (slogans.length) {
    fill('slogan', `官网公开传播语：${slogans.join('；')}。`);
  }

  if (seeded.find(item => item.key === 'identity')?.status !== 'filled') {
    const mentioned = pages.filter(item => textMentionsBrand(`${item.title} ${item.snippet} ${item.body}`, brand));
    if (mentioned.length) {
      fill(
        'identity',
        `公开网页使用的品牌称呼：${brand}。来源标题样例：${mentioned.slice(0, 4).map(item => textOf(item.title, 40)).join('、')}。`,
        mentioned,
      );
    }
  }

  const officialUrl = officialPages[0]?.url || pages.find(item => /官网/.test(item.title || ''))?.url;
  const phone = firstMatch(corpus, /400[- ]?\d{3}[- ]?\d{4}/);
  const address = firstMatch(corpus, /地址[：:]\s*[^\n]{8,80}/);
  if (officialUrl) {
    fill('official', [
      `官网：${officialUrl}。`,
      address || '',
      phone ? `公开服务电话 ${phone}。` : '',
    ].filter(Boolean).join(''), officialPages);
  }

  const icp = firstMatch(corpus, /(?:京|沪|粤|浙|苏|川|鲁)ICP备\d+号(?:-\d+)?/);
  const licenses = uniqueSentences([
    icp ? `网站底部公开备案 ${icp}。` : '',
    firstMatch(corpus, /绿色食品厨房/),
    firstMatch(corpus, /餐饮安全治理.{0,20}奖/),
    firstMatch(corpus, /餐饮业质量安全提升工程示范单位/),
    firstMatch(corpus, /许可项目[：:][^。]{4,80}/),
    firstMatch(corpus, /食品经营许可[^。]{0,40}/),
  ]);
  if (licenses.length) {
    fill('compliance', `公开资质与食品安全信息：${licenses.join('；')}。门店食品经营许可证以市场监管局公示和店内公示牌为准，这里只收录已检索到的公开表述。`);
  }

  const seasonal = uniqueSentences([
    /端午.{0,40}粽子/.test(corpus) ? '官网曾公布端午节到店赠粽子的节日打法（历史公开活动，需核对本季是否仍执行）。' : '',
    /中秋佳节/.test(corpus) ? '官网设有中秋佳节慰问/节日内容栏目，节庆打法按中秋节点做顾客与员工沟通。' : '',
    /年夜饭/.test(corpus) ? '官网荣誉与新闻提到新春年夜饭节点，节日聚餐是公开传播重点。' : '',
    /春节|元宵|国庆/.test(corpus) ? '官网公开内容覆盖春节等法定假日节点。' : '',
  ]);
  if (seasonal.length) {
    fill('seasonal', seasonal.join(''));
  }

  const people = uniqueSentences([
    firstMatch(corpus, /董事长[^，。,\n]{0,12}/),
    firstMatch(corpus, /总经理[^，。,\n]{0,12}/),
    firstMatch(corpus, /法定代表人[：:]\s*[\u4e00-\u9fff]{2,4}/),
  ]);
  if (people.length) {
    fill('people', `官网/公开资料出现的管理层：${people.join('；')}。`);
  }

  if (reviewPages.length) {
    const scores = uniqueSentences(reviewPages.flatMap(item => {
      const blob = `${item.title || ''} ${item.snippet || ''}`;
      const score = blob.match(/\d\.\d\s*分?/)?.[0];
      const dish = blob.match(/招牌[\u4e00-\u9fff]{2,12}/)?.[0];
      return [`${textOf(item.title, 40)}${score ? ` ${score}` : ''}${dish ? ` 推荐${dish}` : ''}`];
    }));
    if (scores.length) {
      fill('reviews', `大众点评/美团公开口碑样例：${scores.slice(0, 6).join('；')}。评分以平台实时页为准。`, reviewPages);
    }
  }

  const dishes = uniqueSentences([
    ...[...corpus.matchAll(/招牌[\u4e00-\u9fff]{2,10}/gu)].map(item => item[0]),
    firstMatch(corpus, /主营北京正宗挂炉烤鸭/),
    firstMatch(corpus, /香酥烤鸭/),
    firstMatch(corpus, /宫保虾球|宫爆大虾球/),
  ]);
  if (dishes.length && seeded.find(item => item.key === 'products')?.status !== 'filled') {
    fill('products', `公开页面出现的招牌/主推：${dishes.slice(0, 8).join('、')}。`);
  }

  return seeded;
}

function officialOrigins(results = [], brand = '') {
  const aggregators = /(?:baidu|bing|sogou|so\.com|google|zhihu|weibo|douyin|xiaohongshu|wikipedia|baike\.baidu|news\.google|amap\.com|uri\.amap)/iu;
  const origins = [];
  for (const item of Array.isArray(results) ? results : []) {
    try {
      const parsed = new URL(item.url);
      if (aggregators.test(parsed.hostname)) continue;
      const hint = `${item.title || ''} ${item.url} ${item.snippet || ''} ${item.body || ''}`;
      const markedOfficial = /官网|有限公司|餐饮集团|About\.aspx|Newslist\.aspx|\/about/iu.test(hint);
      const brandOnOwnSite = textMentionsBrand(hint, brand) && !/\/news\/|\/article\/|\/s\?/iu.test(parsed.pathname + parsed.search);
      if (!markedOfficial && !brandOnOwnSite) continue;
      const origin = `${parsed.protocol}//${parsed.host}`;
      if (!origins.includes(origin)) origins.push(origin);
    } catch { /* skip bad url */ }
  }
  return origins.slice(0, 3);
}

function withOfficialSeeds(results, origins) {
  const extra = [];
  for (const origin of origins) {
    extra.push({ title: '品牌官网', url: `${origin}/`, snippet: '' });
    extra.push({ title: '品牌官网', url: `${origin}/index.aspx`, snippet: '' });
    extra.push({ title: '关于我们', url: `${origin}/About.aspx`, snippet: '' });
    extra.push({ title: '关于我们', url: `${origin}/about`, snippet: '' });
    extra.push({ title: '新闻资讯', url: `${origin}/Newslist.aspx`, snippet: '' });
  }
  const seen = new Set(results.map(item => item.url));
  const merged = [...results];
  for (const item of extra) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    merged.unshift(item);
  }
  return merged;
}

async function collectPoiEvidence(brand, { poiSearchFn = searchText, signal } = {}) {
  if (process.env.NANOWORK_TEST_TEMPLATE_AI === '1' && poiSearchFn === searchText) return [];
  try {
    const city = inferCity(brand);
    const keyword = brand.replace(CITY_PREFIX, '').trim() || brand;
    const found = await poiSearchFn({
      keywords: keyword,
      city: city || undefined,
      types: AMAP_RESTAURANT_TYPECODE,
      citylimit: false,
      pageSize: 25,
      pages: 2,
      signal,
    });
    if (found?.unavailable) return [];
    return (found?.data?.pois || []).filter(item => textMentionsBrand(`${item.name} ${item.address}`, brand));
  } catch (error) {
    return [];
  }
}

async function enrichPageSnippets(results, { fetchPagesFn = fetchBrandPages, signal, limit = 12 } = {}) {
  if (process.env.NANOWORK_TEST_TEMPLATE_AI === '1' && fetchPagesFn === fetchBrandPages) return results;
  const ranked = [...(results || [])].sort((left, right) => {
    const score = (item) => {
      const blob = `${item.title || ''} ${item.url || ''} ${item.snippet || ''}`;
      let value = 0;
      if (/官网|有限公司|餐饮集团|About\.aspx|Newslist\.aspx/iu.test(blob)) value += 10;
      if (/dianping|大众点评|meituan/iu.test(blob)) value += 5;
      if (/百科|理念|口号|logo|食品安全|端午|中秋/iu.test(blob)) value += 3;
      if (NEWS_HOST.test(item.url || '')) value -= 8;
      return value;
    };
    return score(right) - score(left);
  });
  const sources = ranked.filter(item => String(item.url || '').startsWith('http')).slice(0, limit);
  if (!sources.length || typeof fetchPagesFn !== 'function') return results;
  try {
    const fetched = await fetchPagesFn(sources, { limit, timeoutMs: 10000, signal });
    const byUrl = new Map((fetched?.results || []).map(page => [String(page.url || page.requestedUrl || ''), page]));
    return results.map(item => {
      const page = byUrl.get(item.url) || [...byUrl.values()].find(entry => entry.requestedUrl === item.url);
      if (!page?.body && !page?.snippet && !page?.images?.length) return item;
      return {
        ...item,
        title: textOf(page.title, 80) || item.title,
        snippet: textOf(page.snippet || page.body, 1600) || item.snippet,
        body: textOf(page.body || page.snippet, 3000),
        images: Array.isArray(page.images) ? page.images : item.images,
        pageLinks: Array.isArray(page.pageLinks) ? page.pageLinks : item.pageLinks,
      };
    });
  } catch {
    return results;
  }
}

async function followOfficialPages(hits, { fetchPagesFn, signal } = {}) {
  const extra = [];
  const seen = new Set(hits.map(item => item.url));
  for (const hit of hits) {
    for (const url of hit.pageLinks || []) {
      if (!url || seen.has(url)) continue;
      if (!/About|News|Newslist|Culture|Honor|Join|Franchise|Contact|Menu|关于|简介|文化|荣誉|理念|使命|价值|加盟|菜单|资质/iu.test(url)) continue;
      seen.add(url);
      extra.push({ title: textOf(hit.title, 40) || '官网内页', url, snippet: '' });
    }
  }
  if (!extra.length) return hits;
  const followed = await enrichPageSnippets(extra, { fetchPagesFn, signal, limit: 8 });
  return [...hits, ...followed.filter(item => item.snippet || item.body || item.images?.length)];
}

async function collectEvidence(brand, { webSearchFn = webSearch, poiSearchFn = searchText, fetchPagesFn = fetchBrandPages, previousUrls = [], signal } = {}) {
  const notes = [];
  const searchOptions = {
    max: 10,
    timeoutMs: 14000,
    signal,
    skipTiered: true,
    allowBroadFallback: false,
    fallbackOrder: 'web_first',
  };
  const searches = await Promise.all(searchQueries(brand).map(async query => {
    try {
      const found = await webSearchFn(query, searchOptions);
      const items = Array.isArray(found?.results) ? found.results : Array.isArray(found) ? found : [];
      if (found?.note) notes.push(found.note);
      return items;
    } catch (error) {
      notes.push(String(error?.message || '检索失败').slice(0, 80));
      return [];
    }
  }));
  const seen = new Set();
  const unique = [];
  for (const item of searches.flat()) {
    const url = String(item?.url || '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push({
      title: textOf(item.title, 80),
      url,
      snippet: textOf(item.snippet || item.body, 800),
    });
  }
  const matched = unique.filter(item => textMentionsBrand(`${item.title} ${item.url} ${item.snippet}`, brand));
  const usable = unique.filter(item => !NEWS_HOST.test(item.url || ''));
  const hits = matched.length
    ? [...matched]
    : usable.filter(item => /官网|餐饮|烤鸭|火锅|有限公司|百科/iu.test(`${item.title || ''} ${item.snippet || ''}`));
  if (!matched.length && hits.length) notes.push('检索结果未精确命中品牌全称，已放宽到相关公开网页供核验，请逐条确认');
  for (const item of encyclopediaSeeds(brand)) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    hits.push(item);
  }
  const origins = [...new Set([
    ...officialOrigins(hits.filter(item => !NEWS_HOST.test(item.url || '')), brand),
    ...officialOrigins(previousUrls.map(url => ({ title: '已收录官网', url, snippet: '' })), brand),
  ])];
  const seeded = withOfficialSeeds(hits, origins);
  const webHits = (await followOfficialPages(
    await enrichPageSnippets(seeded, { fetchPagesFn, signal, limit: BRAND_PAGE_LIMIT }),
    { fetchPagesFn, signal },
  )).filter(usableEvidenceItem);
  const pois = await collectPoiEvidence(brand, { poiSearchFn, signal });
  const poiHits = pois.slice(0, 12).map(item => ({
    title: `${item.name}（高德门店）`,
    url: amapPlaceUrl(item),
    snippet: `${item.cityname || ''}${item.adname || ''}${item.address || ''}；${item.tel ? `电话${item.tel}；` : ''}${item.biz_ext?.cost ? `人均${item.biz_ext.cost}元；` : ''}${item.type || ''}`.trim(),
  })).filter(item => item.url);
  if (!webHits.length && !poiHits.length) notes.push('公开检索未命中带品牌名的网页，也未命中高德门店');
  return { results: [...poiHits, ...webHits].slice(0, 40), notes, pois };
}

async function synthesizeDimensions(brand, evidence, { chatFn = chat, signal, focusKeys = [], feedback = '' } = {}) {
  const wanted = (Array.isArray(focusKeys) ? focusKeys : []).filter(key => BRAND_KNOWLEDGE_DIMENSIONS.some(item => item.key === key));
  const catalog = wanted.length
    ? BRAND_KNOWLEDGE_DIMENSIONS.filter(item => wanted.includes(item.key))
    : BRAND_KNOWLEDGE_DIMENSIONS;
  const keys = catalog.map(item => item.key).join(', ');
  const result = await chatFn({
    role: 'boss',
    model: routing().text?.boss,
    maxTokens: catalog.length <= SYNTH_BATCH_SIZE ? 3500 : 8000,
    timeoutMs: 90000,
    signal,
    thinking: false,
    responseFormat: { type: 'json_object' },
    system: [
      '你是品牌公开资料整理员。只根据检索证据填写，禁止编造未出现的价格、销量、证言。官网 HTML 里出现的 Logo 图片地址必须原样写入 logo 维度。',
      `必须覆盖这些维度 key：${keys}。`,
      '输出 JSON：{"summary":"...","dimensions":[{"key":"...","body":"...","sources":[{"title":"...","url":"..."}]}]}。',
      '常青维度（品牌名、理念、故事、口号、品类、招牌、客群、门店、竞品、服务、视觉、官网、创始人、加盟、资质、口碑、节庆、供应链、社会责任）：写当前仍公开可核对的事实，不要求出现在近三个月新闻里。有高德门店、百科、官网、大众点评证据就必须写成老板能判断对错的具体句子。',
      '证据里出现成立年份、秉承理念、愿景使命、口号、京ICP、食品经营许可、端午/中秋/年夜饭打法、点评评分，对应维度禁止再写「待核验」。',
      'logo 维度：正文里必须给出可打开的图片 URL（官网 /skin/images/logo.png、og:image 或带 logo 的 img）。没有图片 URL 才待核验。',
      `时效维度（${[...TIME_SENSITIVE_KEYS].join('、')}）：只写近三个月；没有就待核验。季节与节日打法可以写官网公开过的节庆玩法，并标明是否为历史活动。`,
      '证据不足的维度 body 才以「待核验」开头。禁止把无关行业新闻当成该品牌事实。禁止用「未形成可引用事实」应付已经出现在证据里的门店名、地址、电话、人均、招牌、理念或 Logo。',
      feedback ? '老板指出当前抓取有误，必须按纠正说明重写被点名的维度，不能重复错误句子。' : '',
    ].filter(Boolean).join('\n'),
    messages: [{
      role: 'user',
      content: [
        `品牌：${brand}`,
        `近三个月窗口仅约束活动/新闻/内容热点：${nowWindowLabel()}`,
        feedback ? `老板纠正：${textOf(feedback, 800)}` : '',
        `公开检索证据：\n${evidenceLines(evidence).join('\n') || '（无结果）'}`,
      ].filter(Boolean).join('\n'),
    }],
  });
  const parsed = parseJsonPayload(result?.text);
  const merged = mergeDimensions(parsed);
  return {
    summary: textOf(parsed?.summary, 200),
    dimensions: wanted.length ? merged.filter(item => wanted.includes(item.key)) : merged,
    usage: result,
  };
}

async function synthesizeDimensionBatches(brand, evidence, { chatFn = chat, signal, focusKeys = [], feedback = '' } = {}) {
  const wanted = (Array.isArray(focusKeys) ? focusKeys : []).filter(key => BRAND_KNOWLEDGE_DIMENSIONS.some(item => item.key === key));
  const keys = wanted.length ? wanted : BRAND_KNOWLEDGE_DIMENSIONS.map(item => item.key);
  const chunks = chunkKeys(keys);
  let dimensions = emptyDimensions();
  let summary = '';
  let usage = {};
  const errors = [];
  for (const chunk of chunks) {
    try {
      const part = await synthesizeDimensions(brand, evidence, { chatFn, signal, focusKeys: chunk, feedback });
      const byKey = new Map((part.dimensions || []).map(item => [item.key, item]));
      dimensions = dimensions.map(item => byKey.get(item.key) || item);
      if (part.summary) summary = part.summary;
      usage = mergeChatUsage(usage, part.usage);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === chunks.length) throw errors[0];
  return {
    summary,
    dimensions: wanted.length ? dimensions.filter(item => wanted.includes(item.key)) : dimensions,
    usage,
    lastError: errors[0] ? String(errors[0].message || '部分维度未能写成正文').slice(0, 180) : '',
  };
}

export async function collectBrandKnowledgePack({
  brandName,
  packRole,
  packId: requestedPackId = null,
  userId,
  upgrade = false,
  webSearchFn = webSearch,
  chatFn = chat,
  poiSearchFn = searchText,
  fetchPagesFn = fetchBrandPages,
  signal,
} = {}) {
  const brand = normalizeBrandName(brandName);
  const tenantId = curTenant();
  const hasPackId = requestedPackId !== null && requestedPackId !== undefined && requestedPackId !== '';
  let existing = null;
  let role = normalizePackRole(packRole);

  if (hasPackId) {
    existing = loadBrandPackById(requestedPackId, tenantId);
    if (!existing) {
      throw Object.assign(new Error('指定的品牌知识包不存在'), { status: 404, code: 'BRAND_PACK_NOT_FOUND' });
    }
    const existingRole = normalizePackRole(existing.pack_role);
    if (packRole !== undefined && packRole !== null && packRole !== '' && role !== existingRole) {
      throw Object.assign(new Error('指定的品牌知识包类型不匹配'), { status: 400, code: 'BRAND_PACK_ROLE_MISMATCH' });
    }
    role = existingRole;
  } else if (role === 'competitor') {
    const competitors = loadCompetitorBrandPacks(tenantId);
    if (competitors.length >= COMPETITOR_PACK_LIMIT) {
      throw Object.assign(
        new Error(`最多同时维护 ${COMPETITOR_PACK_LIMIT} 个竞品品牌档案，请先删除旧竞品后再采集`),
        { status: 409, code: 'COMPETITOR_PACK_LIMIT_REACHED' },
      );
    }
  } else {
    existing = loadActiveBrandPack(tenantId);
  }

  if (existing?.status === 'collecting') {
    throw Object.assign(new Error('品牌知识包正在采集，请稍后再试'), {
      status: 409,
      code: 'BRAND_PACK_COLLECTING',
    });
  }
  const model = routing().text?.boss || '';
  const credits = estimateMaxCredits('text', model);
  let hold = null;
  if (userId) {
    hold = holdCredits({
      userId,
      tenantId,
      feature: role === 'competitor' ? '竞品品牌档案采集' : '品牌知识包采集',
      kind: 'text',
      model,
      credits,
      refType: 'brand_knowledge_pack',
      refId: existing?.id || null,
    });
  }
  let packId = existing?.id || null;
  try {
    if (existing) {
      q.run(
        `UPDATE brand_knowledge_packs
         SET status='collecting', brand_name=?, last_error='', updated_at=datetime('now','localtime')
         WHERE tenant_id=? AND id=?`,
        brand,
        tenantId,
        existing.id,
      );
    } else {
      const inserted = q.run(
        `INSERT INTO brand_knowledge_packs(brand_name,pack_role,status,version,window_days,source)
         VALUES(?,?,'collecting',1,?, 'web_collect')`,
        brand,
        role,
        BRAND_PACK_WINDOW_DAYS,
      );
      packId = Number(inserted.lastInsertRowid);
    }
    const previous = existing ? loadBrandDimensions(existing.id, tenantId).map(projectDimension) : [];
    const sameBrand = Boolean(existing && normalizeBrandName(existing.brand_name) === brand);
    const evidence = await collectEvidence(brand, {
      webSearchFn,
      poiSearchFn,
      fetchPagesFn,
      previousUrls: sameBrand
        ? urlsFromDimensions(previous.filter(item => ['official', 'story', 'mission', 'slogan', 'compliance'].includes(item.key)))
        : [],
      signal,
    });
    const seeded = seedDimensionsFromEvidence(brand, evidence);
    let summary = `${brand} 公开资料集合`;
    let dimensions = seeded;
    let usage = {};
    let lastError = '';
    if (process.env.NANOWORK_TEST_TEMPLATE_AI === '1' && chatFn === chat) {
      summary = `${brand} 公开资料待核验（模板模式未调用真实模型）。`;
    } else if (!evidence.results.length) {
      lastError = evidence.notes.filter(Boolean).slice(0, 3).join('；')
        || '公开检索没有抓到该品牌网页或门店，请核对品牌名后重试';
    } else {
      try {
        const synthesized = await synthesizeDimensionBatches(brand, evidence.results, { chatFn, signal });
        dimensions = preferFilled(seeded, synthesized.dimensions);
        summary = synthesized.summary || summary;
        usage = synthesized.usage || {};
        lastError = synthesized.lastError || '';
      } catch (error) {
        lastError = String(error?.message || '采集失败').slice(0, 180);
        dimensions = seeded;
      }
    }
    if (upgrade && existing) {
      const previous = loadBrandDimensions(existing.id, tenantId).map(projectDimension);
      const edited = new Map(previous.filter(item => item.status === 'edited').map(item => [item.key, item]));
      const included = new Map(previous.map(item => [item.key, item.included !== false]));
      dimensions = dimensions.map(item => {
        const kept = edited.get(item.key) || item;
        return { ...kept, included: included.has(item.key) ? included.get(item.key) : true };
      });
    }
    const filledCount = dimensions.filter(item => item.status === 'filled' || item.status === 'edited').length;
    const usableResults = (evidence.results || []).filter(usableEvidenceItem);
    const emptyCollect = !usableResults.length && filledCount === 0;
    if (emptyCollect) {
      lastError = lastError
        || evidence.notes.filter(Boolean).slice(0, 3).join('；')
        || '公开检索没有抓到该品牌网页或门店，请核对品牌名后重试，不要把空卡片当成已采集';
    }
    const version = Number(existing?.version || 1);
    replacePackDimensions(packId, dimensions, tenantId);
    q.run(
      `UPDATE brand_knowledge_packs
       SET status=?, brand_name=?, version=?, summary=?, last_error=?,
           collected_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
       WHERE tenant_id=? AND id=?`,
      emptyCollect ? 'failed' : 'review',
      brand,
      version,
      emptyCollect ? `${brand} 本次没有抓到可核验公开资料` : summary,
      lastError,
      tenantId,
      packId,
    );
    if (hold) {
      const billed = Number(usage.outputTokens || usage.output || 0) > 0 || Number(usage.inputTokens || usage.input || 0) > 0;
      if (lastError && !billed) {
        refundHold(hold, { note: '品牌知识包未写出可核验正文，预授权全额退回' });
      } else {
        try {
          settleHold(hold, { usage, model, aiMode: 'api' });
        } catch (error) {
          if (error?.code !== 'BILLING_SUPPLIER_COST_PENDING') throw error;
        }
      }
    }
    const ready = q.get(`SELECT * FROM brand_knowledge_packs WHERE tenant_id=? AND id=?`, tenantId, packId);
    return projectBrandPack(ready);
  } catch (error) {
    if (packId) {
      q.run(
        `UPDATE brand_knowledge_packs
         SET status='failed', last_error=?, updated_at=datetime('now','localtime')
         WHERE tenant_id=? AND id=?`,
        String(error?.message || '采集失败').slice(0, 180),
        tenantId,
        packId,
      );
    }
    if (hold) refundHold(hold, { note: '品牌知识包采集未完成，预授权全额退回' });
    throw error;
  }
}

export function updateBrandDimension(dimensionId, { body, title } = {}) {
  const tenantId = curTenant();
  const row = q.get(
    `SELECT * FROM brand_knowledge_dimensions WHERE tenant_id=? AND id=?`,
    tenantId,
    Number(dimensionId),
  );
  if (!row) throw Object.assign(new Error('该维度不存在'), { status: 404, code: 'BRAND_DIMENSION_NOT_FOUND' });
  const nextBody = textOf(body, 4000);
  if (!nextBody) throw Object.assign(new Error('维度内容不能为空'), { status: 400 });
  q.run(
    `UPDATE brand_knowledge_dimensions
     SET body=?, title=?, status='edited', included=1, updated_at=datetime('now','localtime')
     WHERE tenant_id=? AND id=?`,
    nextBody,
    textOf(title, 40) || row.title,
    tenantId,
    row.id,
  );
  markPackNeedsReview(row.pack_id);
  return snapshotPack(row.pack_id);
}

export function setDimensionIncluded(dimensionId, included) {
  const tenantId = curTenant();
  const row = q.get(
    `SELECT * FROM brand_knowledge_dimensions WHERE tenant_id=? AND id=?`,
    tenantId,
    Number(dimensionId),
  );
  if (!row) throw Object.assign(new Error('该维度不存在'), { status: 404, code: 'BRAND_DIMENSION_NOT_FOUND' });
  q.run(
    `UPDATE brand_knowledge_dimensions
     SET included=?, updated_at=datetime('now','localtime')
     WHERE tenant_id=? AND id=?`,
    included ? 1 : 0,
    tenantId,
    row.id,
  );
  markPackNeedsReview(row.pack_id);
  return snapshotPack(row.pack_id);
}

export function deleteBrandDimension(dimensionId) {
  return setDimensionIncluded(dimensionId, false);
}

function markPackNeedsReview(packId) {
  const tenantId = curTenant();
  const pack = q.get(`SELECT * FROM brand_knowledge_packs WHERE tenant_id=? AND id=?`, tenantId, packId);
  if (!pack || pack.status === 'collecting') return pack;
  if (pack.status === 'ready') {
    q.run(
      `UPDATE brand_knowledge_packs SET status='review', updated_at=datetime('now','localtime')
       WHERE tenant_id=? AND id=?`,
      tenantId,
      packId,
    );
  }
  return q.get(`SELECT * FROM brand_knowledge_packs WHERE tenant_id=? AND id=?`, tenantId, packId);
}

function snapshotPack(packId) {
  const tenantId = curTenant();
  return projectBrandPack(q.get(`SELECT * FROM brand_knowledge_packs WHERE tenant_id=? AND id=?`, tenantId, packId));
}

export function confirmBrandPack(packId = null) {
  const tenantId = curTenant();
  const pack = resolveTargetPack(packId, tenantId);
  if (pack.status === 'collecting') {
    throw Object.assign(new Error('正在采集，请稍后再确认入库'), { status: 409, code: 'BRAND_PACK_COLLECTING' });
  }
  const dimensions = loadBrandDimensions(pack.id, tenantId).map(projectDimension);
  const selected = dimensions.filter(item => item.included !== false);
  if (!selected.length) {
    throw Object.assign(new Error('请至少勾选一个维度再确认入库'), { status: 400, code: 'BRAND_PACK_EMPTY_SELECTION' });
  }
  const version = pack.kb_doc_id && pack.status !== 'ready'
    ? Number(pack.version || 1) + 1
    : Number(pack.version || 1);
  const markdown = compileBrandPackMarkdown({
    brandName: pack.brand_name,
    packRole: normalizePackRole(pack.pack_role),
    version,
    windowDays: pack.window_days,
    windowLabel: nowWindowLabel(),
    summary: pack.summary,
  }, selected);
  const kbDocId = upsertKbDoc({ ...pack, brand_name: pack.brand_name, id: pack.id }, markdown);
  q.run(
    `UPDATE brand_knowledge_packs
     SET status='ready', version=?, kb_doc_id=?, last_error='', updated_at=datetime('now','localtime')
     WHERE tenant_id=? AND id=?`,
    version,
    kbDocId,
    tenantId,
    pack.id,
  );
  return snapshotPack(pack.id);
}

export async function recollectBrandDimensions({
  packId = null,
  keys = [],
  feedback = '',
  userId,
  webSearchFn = webSearch,
  chatFn = chat,
  poiSearchFn = searchText,
  fetchPagesFn = fetchBrandPages,
  signal,
} = {}) {
  const tenantId = curTenant();
  const pack = resolveTargetPack(packId, tenantId);
  if (pack.status === 'collecting') {
    throw Object.assign(new Error('品牌知识包正在采集，请稍后再试'), { status: 409, code: 'BRAND_PACK_COLLECTING' });
  }
  const previous = loadBrandDimensions(pack.id, tenantId).map(projectDimension);
  const wanted = [...new Set((Array.isArray(keys) ? keys : []).filter(key => previous.some(item => item.key === key)))];
  if (!wanted.length && !textOf(feedback, 800)) {
    throw Object.assign(new Error('请勾选要重抓的维度，或写下哪些内容是错的'), { status: 400, code: 'BRAND_RECOLLECT_EMPTY' });
  }
  const focusKeys = wanted.length ? wanted : previous.filter(item => item.included !== false).map(item => item.key);
  const note = textOf(feedback, 800);
  const model = routing().text?.boss || '';
  const credits = estimateMaxCredits('text', model);
  let hold = null;
  if (userId) {
    hold = holdCredits({
      userId,
      tenantId,
      feature: '品牌知识包重抓',
      kind: 'text',
      model,
      credits,
      refType: 'brand_knowledge_pack',
      refId: pack.id,
    });
  }
  q.run(
    `UPDATE brand_knowledge_packs SET status='collecting', last_error='', updated_at=datetime('now','localtime')
     WHERE tenant_id=? AND id=?`,
    tenantId,
    pack.id,
  );
  try {
    const evidence = await collectEvidence(pack.brand_name, {
      webSearchFn,
      poiSearchFn,
      fetchPagesFn,
      previousUrls: urlsFromDimensions(previous.filter(item => ['official', 'story', 'mission', 'slogan', 'compliance'].includes(item.key))),
      signal,
    });
    const seeded = seedDimensionsFromEvidence(pack.brand_name, evidence);
    let recaptured = preferFilled(seeded, emptyDimensions()).filter(item => focusKeys.includes(item.key));
    let usage = {};
    let summary = pack.summary || '';
    if (!(process.env.NANOWORK_TEST_TEMPLATE_AI === '1' && chatFn === chat)) {
      const synthesized = await synthesizeDimensionBatches(pack.brand_name, evidence.results, {
        chatFn,
        signal,
        focusKeys,
        feedback: note,
      });
      recaptured = preferFilled(seeded, synthesized.dimensions).filter(item => focusKeys.includes(item.key));
      if (synthesized.summary) summary = synthesized.summary;
      usage = synthesized.usage || {};
    }
    const byKey = new Map(recaptured.map(item => [item.key, item]));
    const merged = previous.map(item => {
      const next = byKey.get(item.key);
      if (!next) return item;
      return { ...next, included: true, sortOrder: item.sortOrder };
    });
    replacePackDimensions(pack.id, merged, tenantId);
    q.run(
      `UPDATE brand_knowledge_packs
       SET status='review', summary=?, last_error='', collected_at=datetime('now','localtime'),
           updated_at=datetime('now','localtime')
       WHERE tenant_id=? AND id=?`,
      summary,
      tenantId,
      pack.id,
    );
    if (hold) {
      try {
        settleHold(hold, { usage, model, aiMode: 'api' });
      } catch (error) {
        if (error?.code !== 'BILLING_SUPPLIER_COST_PENDING') throw error;
      }
    }
    return snapshotPack(pack.id);
  } catch (error) {
    q.run(
      `UPDATE brand_knowledge_packs
       SET status='review', last_error=?, updated_at=datetime('now','localtime')
       WHERE tenant_id=? AND id=?`,
      String(error?.message || '重抓失败').slice(0, 180),
      tenantId,
      pack.id,
    );
    if (hold) refundHold(hold, { note: '品牌知识包重抓未完成，预授权全额退回' });
    throw error;
  }
}

export function republishBrandPack(packId = null) {
  return confirmBrandPack(packId);
}

export function archiveBrandPack(packId = null) {
  const tenantId = curTenant();
  const pack = resolveTargetPack(packId, tenantId);
  if (pack.kb_doc_id) {
    q.run(
      `UPDATE kb_docs SET enabled=0, updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?`,
      tenantId,
      pack.kb_doc_id,
    );
  }
  q.run(
    `UPDATE brand_knowledge_packs SET status='archived', updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?`,
    tenantId,
    pack.id,
  );
  return { ok: true, id: Number(pack.id), packRole: normalizePackRole(pack.pack_role) };
}

export function brandKnowledgeOverview() {
  const pack = loadActiveBrandPack();
  const competitors = loadCompetitorBrandPacks();
  return {
    category: BRAND_KB_CATEGORY,
    competitorCategory: COMPETITOR_KB_CATEGORY,
    windowDays: BRAND_PACK_WINDOW_DAYS,
    windowLabel: nowWindowLabel(),
    dimensionCatalog: BRAND_KNOWLEDGE_DIMENSIONS,
    uploaded: uploadedKnowledgeSummary(),
    pack: pack ? projectBrandPack(pack) : null,
    competitors: competitors.map(item => projectBrandPack(item)),
    competitorLimit: COMPETITOR_PACK_LIMIT,
  };
}

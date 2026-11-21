// PRD v2.2 FR-4.1 / 4.4 / 4.5：行情快查（市场扫描）的证据编排。
// - 4.1 多角度短查询扇出：按判题实体生成 6–10 条短查询，不把长指令当查询词；
//       榜单/聚合/团购页不再一律剔除，降级为 B 档“线索来源”。
// - 4.4 覆盖度门槛与二轮补检：店铺 ≥15、价格档 ≥3、来源 ≥8；第一轮不达标换角度补检一轮，
//       仍不达标时正文顶部如实写“本次只找到 N 家，原因……，你可以……”。
// - 4.5 来源可信档位 A/B/C，替代笼统的“待核验”。
//
// 合规红线（FR-4.6）：本模块只组织“搜索引擎可索引的公开网页 + 高德开放 API + 客户自己导出上传的文件”。
// 不调用、不模拟美团/点评 App 端内接口，不做给客户使用的抓取工具或插件；
// 检索结果只抽取事实（店名、人均、地址、公开评分），不整段搬运原文。
import { normalizeIntentType } from "./employee-intent-router.js";

export const MARKET_SCAN_COVERAGE = Object.freeze({ stores: 15, priceBands: 3, sources: 8 });
export const MARKET_SCAN_ROUND1_MAX = 10;
export const MARKET_SCAN_ROUND2_MAX = 8;
export const MARKET_SCAN_QUERY_LIMIT = 18;

const STORE_SUFFIX =
  "火锅|串串香|串串|毛血旺|料理|锅物|酒家|餐吧|烤串|酸菜鱼|鱼火锅|干锅|麻辣香锅|冒菜|烤肉|烧烤|烤鱼|小龙虾|麻辣烫|米线|拉面|牛肉面|面馆|饺子|包子|粥|烘焙|面包|甜品|咖啡|茶饮|奶茶|酒馆|酒吧|小馆|餐厅|饭店|酒楼|食堂|饭庄|菜馆|川菜|湘菜|粤菜|东北菜|日料|寿司|韩料|西餐|披萨|汉堡|炸鸡|自助|海鲜|羊蝎子|涮肉|铜锅";
const STORE_NAME_RE = new RegExp(
  `([\\u4e00-\\u9fa5A-Za-z0-9·&]{1,10}(?:${STORE_SUFFIX}))(?:\\s*[（(]\\s*([\\u4e00-\\u9fa5A-Za-z0-9]{2,12}店)\\s*[)）])?`,
  "gu",
);
// 明显不是店名的“泛词+后缀”。
const NOT_STORE_RE =
  /^(?:的|和|与|及|吃|家|附近|周边|推荐|必吃|排行|人均|这家|那家|一家|哪家|好吃的|网红|新开|本地|特色|老字号|平价|高端|商圈|望京|热门|十大|top\d*|TOP\d*|[0-9]+)/u;
const GENERIC_STORE_WORDS = new Set([
  "火锅", "串串", "冒菜", "烤肉", "烧烤", "烤鱼", "餐厅", "饭店", "酒楼", "小馆", "面馆", "咖啡", "茶饮", "奶茶",
  "甜品", "烘焙", "面包", "自助", "海鲜", "西餐", "日料", "韩料", "川菜", "湘菜", "粤菜", "食堂", "菜馆",
]);

const CATEGORY_SYNONYMS = Object.freeze({
  火锅: ["涮锅", "牛肉火锅", "老火锅"],
  烤肉: ["韩式烤肉", "日式烧肉"],
  烧烤: ["烤串", "撸串"],
  茶饮: ["奶茶", "新茶饮"],
  咖啡: ["咖啡馆", "精品咖啡"],
  烘焙: ["面包店", "蛋糕店"],
  湘菜: ["湖南菜"],
  川菜: ["四川菜"],
  牛肉面: ["拉面", "兰州拉面"],
});

function clean(value, max = 40) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);
}

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

/** 行情快查（市场扫描）或带地点的完整报告才走本模块的扇出与覆盖度门槛。 */
export function isMarketScanIntent(intent) {
  if (!intent) return false;
  if (String(intent.answer_shape || "") === "lookup.market_scan") return true;
  const type = normalizeIntentType(intent.type);
  return type === "full_report" && Boolean(intent.entities?.area || intent.entities?.city);
}

/**
 * 第 1 轮：多角度短查询（6–10 条）。第 2 轮：换同义词、换商场名、换细分品类（≤8 条）。
 * 只带地点和品类，不发送客户名单、预算等内部数据。
 */
export function buildMarketScanQueries({ entities = {}, center = "", round = 1, year = new Date().getFullYear() } = {}) {
  const area = clean(entities.area || "", 12) || clean(center, 16).replace(/(?:商圈|片区|附近|周边)$/u, "");
  const city = clean(entities.city || "", 8);
  const place = area || city;
  if (!place) return [];
  const category = clean(entities.category || "", 10);
  const related = (Array.isArray(entities.related_categories) ? entities.related_categories : [])
    .map((item) => clean(item, 10))
    .filter(Boolean);
  const centerWord = clean(center, 20);
  const mallLike = centerWord && centerWord !== place && /(?:SOHO|广场|中心|商场|大厦|里|天地|城|汇|港)$/iu.test(centerWord)
    ? centerWord
    : "";
  if (round === 2) {
    const synonyms = category ? CATEGORY_SYNONYMS[category] || [] : [];
    const list = [
      ...(city && area ? [`${city}${area} ${category || "餐厅"} 店`] : []),
      ...synonyms.slice(0, 2).map((word) => `${place} ${word}`),
      ...(mallLike ? [`${mallLike} 餐厅 楼层`, `${mallLike} ${category || "美食"}`] : [`${place} 商场 餐饮 品牌`]),
      `${place} ${category || "餐饮"} 团购 人均`,
      ...related.slice(1, 3).map((word) => `${place} ${word} 人均`),
      `${place} ${category || "美食"} 口碑 老店`,
      `${place} 美食 地图`,
    ];
    return uniq(list).slice(0, MARKET_SCAN_ROUND2_MAX);
  }
  const list = [
    `${place} 人均 餐厅`,
    ...(category ? [`${place} ${category} 推荐`, `${place} ${category} 人均`] : [`${place} 餐厅 推荐`]),
    `${place} 必吃 榜`,
    ...related.slice(0, 2).map((word) => `${place} ${word}`),
    ...(mallLike ? [`${mallLike} 餐饮`] : []),
    `${place} 新开 ${category || "餐厅"} ${year}`,
    ...(city && area ? [`${city} ${area} ${category || "美食"}`] : []),
    `${place} ${category || "餐饮"} 连锁 品牌`,
  ];
  return uniq(list).slice(0, MARKET_SCAN_ROUND1_MAX);
}

/** 把市场扫描查询和岗位/客源查询合并，市场扫描排前，硬上限保护搜索供应商限流。 */
export function mergeMarketScanQueries(marketQueries = [], baseQueries = [], limit = MARKET_SCAN_QUERY_LIMIT) {
  return uniq([...marketQueries, ...baseQueries].map((query) => clean(query, 120))).slice(0, limit);
}

function normalizeStoreName(name) {
  return String(name || "")
    .replace(/[\s·&]/gu, "")
    .replace(/(?:总店|旗舰店)$/u, "")
    .toLowerCase();
}

/**
 * 从来源标题/摘要/正文里抽店铺实体（店名、分店、人均、来源）。只抽事实，不搬原文。
 * 按“店名 + 分店”去重。
 */
export function extractStoreEntities(sources = [], { maxPerSource = 12 } = {}) {
  const byKey = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    const text = `${source?.title || ""}\n${source?.snippet || ""}\n${String(source?.body || "").slice(0, 4000)}`;
    let count = 0;
    for (const match of text.matchAll(STORE_NAME_RE)) {
      if (count >= maxPerSource) break;
      const name = match[1];
      if (!name || name.length < 3 || NOT_STORE_RE.test(name) || GENERIC_STORE_WORDS.has(name)) continue;
      const branch = match[2] || null;
      const key = `${normalizeStoreName(name)}|${branch || ""}`;
      const tail = text.slice(match.index, match.index + match[0].length + 40);
      const price = tail.match(/人均\s*[:：]?\s*[¥￥]?\s*(\d{2,4})/u);
      count += 1;
      if (byKey.has(key)) {
        const existing = byKey.get(key);
        if (!existing.price && price) existing.price = Number(price[1]);
        continue;
      }
      byKey.set(key, {
        name,
        branch,
        price: price ? Number(price[1]) : null,
        sourceUrl: String(source?.url || "") || null,
      });
    }
  }
  return [...byKey.values()];
}

/** 价格档：≤50 / 51–100 / 101–150 / 151–250 / 250+ */
export function priceBandOf(price) {
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value <= 50) return "≤50";
  if (value <= 100) return "51–100";
  if (value <= 150) return "101–150";
  if (value <= 250) return "151–250";
  return "250+";
}

function amapStoreRows(tradeAreaFacts) {
  const rows = [...(tradeAreaFacts?.topCompetitors?.value || [])];
  for (const group of tradeAreaFacts?.relatedCompetitors?.categories || []) rows.push(...(group?.value || []));
  return rows.filter((row) => row && row.name);
}

/**
 * 覆盖度评估：店铺数（高德 + 公开网页去重合并）、价格档数、可用来源数。
 */
export function assessMarketScanCoverage({ webSources = [], tradeAreaFacts = null, thresholds = MARKET_SCAN_COVERAGE } = {}) {
  const names = new Set();
  const bands = new Set();
  for (const row of amapStoreRows(tradeAreaFacts)) {
    names.add(normalizeStoreName(row.name));
    const band = priceBandOf(row.cost) || priceBandOf(row.costFromWeb?.value);
    if (band) bands.add(band);
  }
  const amapStores = names.size;
  const entities = extractStoreEntities(webSources);
  for (const entity of entities) {
    names.add(normalizeStoreName(`${entity.name}${entity.branch || ""}`));
    const band = priceBandOf(entity.price);
    if (band) bands.add(band);
  }
  const sources = new Set((Array.isArray(webSources) ? webSources : []).map((source) => String(source?.url || "")).filter(Boolean)).size
    + (amapStores ? 1 : 0);
  const coverage = {
    stores: names.size,
    amapStores,
    webStores: entities.length,
    priceBands: bands.size,
    sources,
    amapAvailable: tradeAreaFacts ? tradeAreaFacts.amap?.ok === true || amapStores > 0 : null,
    thresholds: { ...thresholds },
  };
  const shortfalls = [];
  if (coverage.stores < thresholds.stores) shortfalls.push("stores");
  if (coverage.priceBands < thresholds.priceBands) shortfalls.push("priceBands");
  if (coverage.sources < thresholds.sources) shortfalls.push("sources");
  return { ...coverage, shortfalls, passed: shortfalls.length === 0 };
}

/**
 * 覆盖度不达标时的正文要求：顶部如实说明，不用“待核验”填满表格。
 * 高德不可用时说明“本次地图数据不可用，店铺信息来自公开网页”。
 */
export function marketScanCoveragePromptLines(coverage) {
  if (!coverage) return [];
  const lines = [];
  if (coverage.amapAvailable === false) {
    lines.push("【地图数据状态】本次地图数据不可用，店铺信息来自公开网页；口径说明里写清这一点，不要输出大面积“未获取”的表格。");
  }
  if (coverage.passed) return lines;
  const reasons = [];
  if (coverage.shortfalls.includes("stores")) reasons.push(`店铺只找到约 ${coverage.stores} 家（目标 ≥${coverage.thresholds.stores}）`);
  if (coverage.shortfalls.includes("priceBands")) reasons.push(`价格档只有 ${coverage.priceBands} 档（目标 ≥${coverage.thresholds.priceBands}）`);
  if (coverage.shortfalls.includes("sources")) reasons.push(`可用来源 ${coverage.sources} 个（目标 ≥${coverage.thresholds.sources}）`);
  lines.push(
    `【覆盖度未达标·已自动补检一轮】${reasons.join("；")}。正文第一段必须如实写“本次只找到 N 家（N 为你实际列出的店数），原因……，你可以……”（可以：把商圈写得更具体到商场/路名、补一个细分品类、上传自己导出的平台数据）。表格只列真实找到的店，不要用“待核验”“—”行凑数。`,
  );
  return lines;
}

// ===== FR-4.5 来源可信档位 =====

const TIER_A_HOST = [
  /(?:^|\.)amap\.com$/u,
  /(?:^|\.)gaode\.com$/u,
  /(?:^|\.)gov\.cn$/u,
  /(?:^|\.)stats\.gov\.cn$/u,
];
const TIER_B_HOST = [
  /(?:^|\.)dianping\.com$/u,
  /(?:^|\.)meituan\.com$/u,
  /(?:^|\.)ele\.me$/u,
  /(?:^|\.)ctrip\.com$/u,
  /(?:^|\.)trip\.com$/u,
  /(?:^|\.)xiaohongshu\.com$/u,
  /(?:^|\.)douyin\.com$/u,
  /(?:^|\.)sohu\.com$/u,
  /(?:^|\.)163\.com$/u,
  /(?:^|\.)qq\.com$/u,
  /(?:^|\.)sina\.com\.cn$/u,
  /(?:^|\.)thepaper\.cn$/u,
];
const OFFICIAL_TEXT = /(?:官网|官方网站|官方|品牌门店|门店查询|门店列表|商场官网|购物中心官网|政府|统计局|公告)/u;
const AGGREGATION_LEAD_TEXT = /(?:推荐榜|排行榜|必吃榜|榜单|top\s*\d|十大|盘点|合集|攻略|团购|代金券|套餐券)/iu;

function hostOf(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function sourceDate(source) {
  const raw = source?.publishedAt || source?.published_at || source?.date || null;
  const fromText = raw || String(source?.snippet || "").match(/(20\d{2})[-年/.](\d{1,2})/u)?.[0] || null;
  if (!fromText) return null;
  const match = String(fromText).match(/(20\d{2})[-年/.](\d{1,2})/u);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, 1);
}

/**
 * A：官方或一手（品牌/商场官网、高德、政府统计、客户自有数据）
 * B：公开平台页、团购页、榜单、聚合页、媒体报道（标“参考”）
 * C：日期超过 12 个月、来源无法归类的单一网页、模型推断（标“推测”）
 */
export function classifySourceTier(source, { now = new Date() } = {}) {
  const kind = String(source?.kind || source?.sourceKind || "");
  if (kind === "own_data" || kind === "store_data" || kind === "amap") {
    return { tier: "A", label: "一手", reason: kind === "amap" ? "高德开放接口" : "客户自有数据" };
  }
  const host = hostOf(source?.url);
  const text = `${source?.title || ""} ${String(source?.snippet || "").slice(0, 300)}`;
  const date = sourceDate(source);
  if (date && now - date > 365 * 24 * 3600 * 1000) {
    return { tier: "C", label: "推测", reason: "信息日期超过 12 个月" };
  }
  if (TIER_A_HOST.some((pattern) => pattern.test(host))) return { tier: "A", label: "一手", reason: "官方或地图接口" };
  if (AGGREGATION_LEAD_TEXT.test(text)) return { tier: "B", label: "参考", reason: "榜单/聚合/团购线索" };
  if (TIER_B_HOST.some((pattern) => pattern.test(host))) return { tier: "B", label: "参考", reason: "公开平台或媒体页" };
  if (OFFICIAL_TEXT.test(text)) return { tier: "A", label: "一手", reason: "品牌或商场官方页面" };
  return { tier: "C", label: "推测", reason: "单一网页，未能归类" };
}

export function sourceTierPrefix(source, options) {
  const { tier, label, reason } = classifySourceTier(source, options);
  return `【可信档位】${tier}·${label}（${reason}）`;
}

export function sourceTierPromptRule() {
  return "【来源档位】每条来源已标【可信档位】：A 一手可直接用；B 参考（榜单、团购、平台、聚合页，适合找店名和人均区间，引用时在数字或店名后标“(参考)”）；C 推测（旧于 12 个月或单一来源，标“(推测)”，不能作为关键结论的唯一依据）。不要再笼统写“待核验”，按档位标注即可；来源全表放到文末工作底稿。";
}

/** 榜单/聚合/团购页：市场扫描时降级为 B 档线索，不再一律剔除。 */
export function isAggregationLeadSource(source) {
  return AGGREGATION_LEAD_TEXT.test(`${source?.title || ""} ${String(source?.snippet || "").slice(0, 300)}`);
}

// ===== FR-4.2 人均回填 =====

/**
 * 高德没给人均（cost 为空）的店，用公开网页里抽到的同名店人均回填，并标注 B 档“参考”。
 * 返回新对象，不改原 facts；没有可回填的返回原对象。
 */
export function backfillCompetitorPricesFromWeb(tradeAreaFacts, webSources = []) {
  const rows = tradeAreaFacts?.topCompetitors?.value;
  if (!Array.isArray(rows) || !rows.length) return { facts: tradeAreaFacts, filled: 0 };
  const priced = extractStoreEntities(webSources).filter((entity) => entity.price);
  if (!priced.length) return { facts: tradeAreaFacts, filled: 0 };
  let filled = 0;
  const value = rows.map((row) => {
    const hasCost = row?.cost != null && String(row.cost).trim() !== "" && Number(row.cost) > 0;
    if (hasCost || !row?.name) return row;
    const target = normalizeStoreName(row.name).replace(/[()（）]/gu, "");
    const match = priced.find((entity) => {
      const name = normalizeStoreName(entity.name);
      return name.length >= 3 && (target.includes(name) || name.includes(target));
    });
    if (!match) return row;
    filled += 1;
    return {
      ...row,
      costFromWeb: {
        value: match.price,
        sourceTier: "B",
        label: "参考",
        sourceUrl: match.sourceUrl,
        note: "高德未提供人均，取自公开网页，仅作参考",
      },
    };
  });
  if (!filled) return { facts: tradeAreaFacts, filled: 0 };
  return {
    facts: { ...tradeAreaFacts, topCompetitors: { ...tradeAreaFacts.topCompetitors, value } },
    filled,
  };
}

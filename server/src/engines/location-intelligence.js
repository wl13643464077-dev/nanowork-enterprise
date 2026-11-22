import {
  AMAP_FACILITY_TYPECODES,
  AMAP_RESTAURANT_TYPECODE,
  AMAP_UNCONFIGURED_REASON,
  amapTaskRequestBudget,
  createAmapClient,
} from "./amap.js";

const DEFAULT_USER_AGENT =
  process.env.NANOWORK_HTTP_USER_AGENT ||
  "NanoWorkEnterprise/1.0 (restaurant-location-intelligence)";

const DEFAULT_VALHALLA_ISOCHRONE_ENDPOINT =
  "https://valhalla1.openstreetmap.de/isochrone";
const DEFAULT_ISOCHRONE_MODES = Object.freeze([
  "walking",
  "cycling",
  "driving",
  "transit",
]);
const DEFAULT_ISOCHRONE_MINUTES = Object.freeze([10, 20, 30]);
const VALHALLA_COSTING_BY_MODE = Object.freeze({
  walking: "pedestrian",
  cycling: "bicycle",
  driving: "auto",
  transit: "multimodal",
});

// 长后缀必须放在短后缀前面，否则“春熙路地铁站”会在“路”处被提前截断。
// “底商/商圈”是铺位形态或分析范围，不是地理编码中心，因此不放进
// 地点后缀；它们由 normalizeLocationIntent 单独拆成范围和设施需求。
const LOCATION_SUFFIX =
  "(?:购物中心|商业街|步行街|写字楼|地铁站|公交站|火车站|高铁站|街道|大道|广场|商场|社区|园区|大厦|小区|公寓|中心|医院|学校|公园|街区|路|街|站|城|园|号|栋|座|区|县|桥|镇|村|屯|巷)";
const NAMED_PLACE_SUFFIX =
  /(?:购物中心|商业街|步行街|写字楼|广场|商场|社区|园区|大厦|小区|公寓|中心|街区|城|园|栋|座|太古里|太古汇|合生汇|万象汇|万象天地|来福士|新天地|天街|颐堤港|蓝色港湾|SOHO|MALL|PLAZA|K11|IFS|SKP)(?:\s*[A-Za-z]?\d+[号栋座]?)?$/iu;
const ROAD_SUFFIX = /(?:街道|大道|路|街|号)$/u;
const FACILITY_SUFFIX =
  /(?:地铁站|公交站|火车站|高铁站|车站|医院|学校|公园|站)$/u;
const GENERIC_LOCATION_CORE =
  /^(?:地铁站|地铁口|地铁|公交站|公交|火车站|高铁站|车站|站|商圈|商业圈|片区|核心区|一带|底商|商铺|门店|周边|附近|周围|当地|本地|目标|核心|主要|热门|商业|餐饮|美食|全国|同城|全市|这个|那个|该|本|某)$/u;
const COMMERCIAL_LANDMARK_RE =
  /([\p{Script=Han}]{2,12}\s*(?:SOHO|CBD|MALL|PLAZA|K11|IFS|SKP)(?:\s*[A-Za-z]?\d+[号栋座]?)?|[\p{Script=Han}]{1,10}(?:太古里|太古汇|合生汇|万象汇|万象天地|来福士|新天地|天街|颐堤港|蓝色港湾))/giu;
const BUSINESS_DISTRICT_RE =
  /([\p{Script=Han}A-Za-z0-9·-]{2,20}?)(?:商圈|商业圈|片区|核心区|一带)/gu;
const LOCATION_SCOPE_START =
  /(?:\d+(?:\.\d+)?\s*(?:楼|层)(?:底商|商铺|铺位)?|(?:底商|商铺|铺位)|(?:周边|周围|附近|方圆|半径|覆盖范围)\s*(?:(?:\d+(?:\.\d+)?\s*(?:公里|千米|km|米|m)?\s*(?:-|~|～|–|—|至|到|\/)\s*)?\d+(?:\.\d+)?\s*(?:公里|千米|km|米|m))?)/iu;
const LOCATION_LEADING_REQUEST =
  /^(?:(?:(?:我们|我家|咱们|咱家|本店)(?:的)?(?:门店|店面|店|餐厅|商铺|铺子|新店)?\s*(?:在|位于|开在|选在)?|请|帮我|帮忙|给我|我想|我要|需要|如何|怎么|怎样|围绕|针对|关于|基于|分析|调研|研究|看看|查看|核验|评估|判断|了解|调查|做|完成|把|在|位于|开在|选在|周边|周围|附近|方圆|我|本)\s*)+/u;
const NON_DISTRICT_TERM_RE =
  /(?:如何|怎么|怎样|什么|哪些|分析|调研|评估|判断|了解|提升|优化|选择|考察|比较|对比|整理|目标|核心|主要|热门|周边|周围|附近|当地|本地|餐饮|美食|火锅|客流|选址|竞品|竞争|行业|市场|全国|同城|全市|门店|餐厅|品牌|风险|候选|备选|待选|拟选|两个|三个|多个|几个|一个|不同|各个|所有|全部|成熟|新兴|老旧|大型|小型|中型|社区|办公|住宅|写字楼|高校|学校|交通|地铁|商业|高档|中档|低档|平价|高端|普通|一般|典型|常见|具体|实际|现有|当前|目前|原有|新开|重点|优先|优质|潜力|空白|流量|客群|消费|资料|报告|方案|清单|问题|情况|的|在|是|去|到|看|查|帮|做|个|类|型)/u;
const LOCATION_INSTRUCTION_FRAGMENT =
  /(?:输出标准|交付物|上下游|前置依赖|专业词|首次出现|用括号|括号做|一句话解释|行动项|负责人|每家标注|给出住宅|白领数量)/u;
const CITY_NAMES = [
  "北京",
  "上海",
  "天津",
  "重庆",
  "广州",
  "深圳",
  "太原",
  "杭州",
  "南京",
  "成都",
  "武汉",
  "西安",
  "郑州",
  "长沙",
  "济南",
  "青岛",
  "沈阳",
  "大连",
  "苏州",
  "无锡",
  "宁波",
  "合肥",
  "福州",
  "厦门",
  "昆明",
  "南宁",
  "贵阳",
  "石家庄",
  "哈尔滨",
  "长春",
  "兰州",
  "乌鲁木齐",
  "呼和浩特",
  "海口",
];

function safeText(value, max = 300) {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function unique(values) {
  return [
    ...new Set(values.map((value) => safeText(value, 120)).filter(Boolean)),
  ];
}

function metersFromDistance(value, unit) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(
    amount * (/^(?:公里|千米|km)$/iu.test(String(unit || "")) ? 1000 : 1),
  );
}

function radiiForRange(minMeters, maxMeters) {
  const minimum = Math.min(minMeters, maxMeters);
  const maximum = Math.max(minMeters, maxMeters);
  const values = [minimum];
  // 公里级商圈用整公里中间圈，“1-3公里”才会得到1/2/3公里，
  // 而“300-800米”不会被自动扩成数十个半径。
  if (maximum - minimum >= 1000) {
    for (
      let radius = Math.ceil(minimum / 1000) * 1000;
      radius < maximum;
      radius += 1000
    ) {
      if (radius > minimum) values.push(radius);
    }
  }
  values.push(maximum);
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * 只解析用户明确写出的距离；不把时间、楼层或商圈默认值当成距离。
 */
export function parseLocationDistanceRange(value) {
  const text = safeText(value, 1200);
  if (!text) return null;
  const range = text.match(
    /(\d+(?:\.\d+)?)\s*(公里|千米|km|米|m)?\s*(?:-|~|～|–|—|至|到|\/)\s*(\d+(?:\.\d+)?)\s*(公里|千米|km|米|m)/iu,
  );
  if (range) {
    const firstUnit = range[2] || range[4];
    const first = metersFromDistance(range[1], firstUnit);
    const second = metersFromDistance(range[3], range[4]);
    if (first && second) {
      const minMeters = Math.min(first, second);
      const maxMeters = Math.max(first, second);
      return {
        explicit: true,
        minMeters,
        maxMeters,
        radiiMeters: radiiForRange(minMeters, maxMeters),
        matchedText: safeText(range[0], 80),
      };
    }
  }
  const single = text.match(
    /(\d+(?:\.\d+)?)\s*(公里|千米|km|米|m)/iu,
  );
  if (!single) return null;
  const meters = metersFromDistance(single[1], single[2]);
  if (!meters) return null;
  return {
    explicit: true,
    minMeters: meters,
    maxMeters: meters,
    radiiMeters: [meters],
    matchedText: safeText(single[0], 80),
  };
}

export function hasExplicitLocationIsochroneRequest(value) {
  const text = safeText(value, 1200);
  if (!text) return false;
  return (
    /(?:步行|骑行|骑车|自行车|驾车|开车|公交(?:车)?|公共交通|地铁)\s*(?:时间|可达时间|路线|圈)?\s*[:：]?\s*\d+(?:\.\d+)?\s*(?:分钟|min(?:ute)?s?)/iu.test(
      text,
    ) ||
    /\d+(?:\.\d+)?\s*(?:分钟|min(?:ute)?s?)\s*(?:步行|骑行|骑车|自行车|驾车|开车|公交(?:车)?|公共交通|地铁)(?:可达|圈|范围)?/iu.test(
      text,
    )
  );
}

function stripLocationScope(value) {
  let text = safeText(value, 160)
    .replace(/^[\s｜|,，、。；;:：/]+/u, "")
    .replace(/[\s｜|,，、。；;:：/]+$/u, "");
  const cityOffset = Math.min(
    ...CITY_NAMES.map((city) => text.indexOf(city)).filter((index) => index >= 0),
  );
  if (Number.isFinite(cityOffset) && cityOffset > 0) text = text.slice(cityOffset);
  text = text.replace(LOCATION_LEADING_REQUEST, "");
  const scope = text.match(LOCATION_SCOPE_START);
  if (scope?.index > 0) text = text.slice(0, scope.index);
  return text
    .replace(/(?:的)?(?:周边|周围|附近|方圆|半径)$/u, "")
    .replace(/[\s｜|,，、。；;:：/]+$/u, "")
    .trim();
}

function candidateCore(value) {
  return safeText(value, 120).replace(
    new RegExp(`^(?:${CITY_NAMES.join("|")})(?:市)?`, "u"),
    "",
  );
}

function isGenericLocationCandidate(value) {
  const core = candidateCore(value);
  return !core || GENERIC_LOCATION_CORE.test(core);
}

const COARSE_AMAP_GEOCODE_LEVELS = /^(?:国家|省|市|直辖市|区县|district|country|province|city)$/iu;

export function isCoarseAmapGeocode(data, candidate, city = "") {
  if (!data) return true;
  const level = String(data.level || "").trim();
  if (!COARSE_AMAP_GEOCODE_LEVELS.test(level)) return false;
  const hay = String(candidate || "");
  const cityHint = String(city || data.city || data.province || "").replace(/[省市]$/u, "");
  const districtHint = String(data.district || "").replace(/[区县市]$/u, "");
  let remainder = hay;
  const strip = (token) => {
    if (!token) return;
    remainder = remainder.replace(
      new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"),
      "",
    );
  };
  strip(cityHint);
  strip(districtHint);
  remainder = remainder.replace(/中华人民共和国|[省市县]/gu, "");
  return /[\u4e00-\u9fffA-Za-z0-9]{2,}/u.test(remainder);
}

function withoutLocationExamples(value) {
  return safeText(value, 1200)
    // 输出规范里的“如/例如”只是写作示例，不能成为地图中心候选。
    .replace(/[（(]\s*(?:如|例如|比如|譬如)\s*[:：]?[^）)]*[）)]/gu, " ")
    .replace(/(?:例如|比如|譬如|举例(?:说)?)\s*[:：][^\n。；;]*/gu, " ");
}

function isInstructionalLocationCandidate(value) {
  return LOCATION_INSTRUCTION_FRAGMENT.test(safeText(value, 160));
}

function locationCandidateScore(value) {
  const candidate = safeText(value, 120);
  const core = candidateCore(candidate);
  const cityScore = CITY_NAMES.some((city) => candidate.startsWith(city))
    ? 120
    : 0;
  const kindScore = NAMED_PLACE_SUFFIX.test(candidate)
    ? 300
    : FACILITY_SUFFIX.test(candidate)
      ? 230
      : ROAD_SUFFIX.test(candidate)
        ? 180
        : new RegExp(`${LOCATION_SUFFIX}$`, "u").test(candidate)
          ? 120
          : 0;
  const nestedSuffixCount = (
    candidate.match(new RegExp(LOCATION_SUFFIX, "gu")) || []
  ).length;
  // 同时夹着“天府三街+清风时代城”的复合查询可作为兜底，
  // 但不应压过已单独提取的具体项目名。
  const nestedPenalty = Math.max(0, nestedSuffixCount - 1) * 80;
  return (
    cityScore +
    kindScore +
    Math.min(40, Array.from(core).length) -
    nestedPenalty
  );
}

function buildLocationCandidates(value) {
  const text = safeText(withoutLocationExamples(value), 600);
  if (!text) return [];
  const cities = CITY_NAMES.filter((city) => text.includes(city));
  const primaryCity = cities[0] || null;
  const landmarkFragments = [];
  for (const match of text.matchAll(COMMERCIAL_LANDMARK_RE)) {
    const fragment = stripLocationScope(match[1]);
    if (
      fragment &&
      !isGenericLocationCandidate(fragment) &&
      !isInstructionalLocationCandidate(fragment)
    ) {
      landmarkFragments.push(fragment);
    }
  }
  const fragments = [];
  const suffixPattern = new RegExp(
    `[\\p{Script=Han}A-Za-z0-9·-]{2,40}?${LOCATION_SUFFIX}`,
    "gu",
  );
  for (const match of text.matchAll(suffixPattern)) {
    const fragment = stripLocationScope(match[0]);
    if (fragment) fragments.push(fragment);
  }
  for (const token of text.split(/[｜|,，、。；;:：\s/]+/u)) {
    const fragment = stripLocationScope(token);
    if (new RegExp(`${LOCATION_SUFFIX}$`, "u").test(fragment))
      fragments.push(fragment);
  }

  const usableFragments = unique([...landmarkFragments, ...fragments]).filter(
    (fragment) =>
      !isGenericLocationCandidate(fragment) &&
      !isInstructionalLocationCandidate(fragment) &&
      (NAMED_PLACE_SUFFIX.test(fragment) ||
        new RegExp(`${LOCATION_SUFFIX}$`, "u").test(fragment)),
  );

  // 这条链路只解析一个商圈中心。一旦正文已经出现明确命名场所，后续
  // 出现的道路、地铁站和写作示例都只能是周边事实，不能成为中心回退。
  // 中心地理编码失败时，只尝试同一实体的“城市+名称/名称”及去掉楼栋号的基础地标。
  const primaryNamedPlace = usableFragments.find((fragment) =>
    NAMED_PLACE_SUFFIX.test(fragment),
  );
  if (primaryNamedPlace) {
    const core = candidateCore(primaryNamedPlace);
    const baseCore = core.replace(/\s+[A-Za-z]?\d+[号栋座]?$/u, "").trim();
    const entityCity =
      CITY_NAMES.find((city) => primaryNamedPlace.startsWith(city)) ||
      primaryCity;
    // 带楼栋号（如“望京SOHO T1”）时，优先用“望京SOHO”定位商圈中心，同时保留完整名作备选。
    const orderedCores =
      baseCore && baseCore !== core && !isGenericLocationCandidate(baseCore)
        ? [baseCore, core]
        : [core];
    return unique(
      orderedCores.flatMap((item) => [
        entityCity ? `${entityCity}${item}` : null,
        item,
      ]),
    ).filter(
      (candidate) =>
        !isGenericLocationCandidate(candidate) &&
        !isInstructionalLocationCandidate(candidate),
    );
  }

  const districtFragments = [];
  for (const match of text.matchAll(BUSINESS_DISTRICT_RE)) {
    const cleaned = stripLocationScope(match[1]);
    if (!cleaned || isInstructionalLocationCandidate(cleaned)) continue;
    const core = candidateCore(cleaned);
    if (
      core.length >= 2 &&
      core.length <= 6 &&
      !isGenericLocationCandidate(core) &&
      !NON_DISTRICT_TERM_RE.test(core)
    ) {
      const entityCity =
        CITY_NAMES.find((city) => cleaned.startsWith(city)) || primaryCity;
      if (entityCity) districtFragments.push(`${entityCity}${core}`);
      districtFragments.push(core);
    }
  }

  const candidates = [];
  for (const fragment of usableFragments) {
    candidates.push(fragment);
    if (
      primaryCity &&
      !CITY_NAMES.some((city) => fragment.startsWith(city)) &&
      !isGenericLocationCandidate(fragment)
    ) {
      candidates.push(`${primaryCity}${fragment}`);
    }
  }
  const districtSet = new Set(districtFragments);
  for (const district of districtFragments) {
    candidates.push(district);
  }
  return unique(candidates)
    .filter(
      (candidate) =>
        !isGenericLocationCandidate(candidate) &&
        !isInstructionalLocationCandidate(candidate) &&
        (districtSet.has(candidate) ||
          NAMED_PLACE_SUFFIX.test(candidate) ||
          new RegExp(`${LOCATION_SUFFIX}$`, "u").test(candidate)),
    )
    .sort(
      (a, b) =>
        locationCandidateScore(b) - locationCandidateScore(a) ||
        Number(districtSet.has(b)) - Number(districtSet.has(a)) ||
        a.length - b.length,
    )
    .slice(0, 6);
}

/**
 * 地点中心、显式距离和设施意图的单一解析入口；地图、高德和来源锚点
 * 应复用同一结果，避免各自从长句里猜不同的地点。
 */
export function normalizeLocationIntent(value) {
  const text = safeText(value, 1200);
  const centerCandidates = buildLocationCandidates(text);
  const distance = parseLocationDistanceRange(text);
  const requestedFacilities = [];
  if (/(?:地铁站|地铁口|地铁|轨道交通站)/u.test(text))
    requestedFacilities.push("地铁站");
  if (/(?:公交站|公交车站)/u.test(text)) requestedFacilities.push("公交站");
  return {
    city: CITY_NAMES.find((city) => text.includes(city)) || null,
    center: centerCandidates[0] || null,
    centerCandidates,
    radiusRangeMeters: distance
      ? { min: distance.minMeters, max: distance.maxMeters }
      : null,
    radiiMeters: distance?.radiiMeters || [],
    radiusMeters: distance?.maxMeters || null,
    requestedFacilities,
    explicitIsochroneRequested: hasExplicitLocationIsochroneRequest(text),
  };
}

export function locationQueryCandidates(value) {
  return normalizeLocationIntent(value).centerCandidates;
}

function withTimeout(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, Number(timeoutMs) || 9000),
  );
  const signals = [controller.signal];
  if (externalSignal) signals.push(externalSignal);
  return {
    signal: AbortSignal.any(signals),
    clear: () => clearTimeout(timer),
  };
}

async function jsonGet(url, { fetchImpl, signal, timeoutMs, headers = {} }) {
  const attempt = withTimeout(timeoutMs, signal);
  try {
    const response = await fetchImpl(url, {
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept-Language": "zh-CN,zh;q=0.9",
        Accept: "application/json",
        ...headers,
      },
      signal: attempt.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    attempt.clear();
  }
}

function positiveUniqueNumbers(values, fallback) {
  const normalized = [
    ...new Set(
      (Array.isArray(values) ? values : fallback)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.round(value)),
    ),
  ].sort((a, b) => a - b);
  return normalized.length ? normalized.slice(0, 4) : [...fallback];
}

function supportedIsochroneModes(values) {
  const normalized = [
    ...new Set(
      (Array.isArray(values) ? values : DEFAULT_ISOCHRONE_MODES)
        .map((value) => safeText(value, 30).toLowerCase())
        .filter((value) => Object.hasOwn(VALHALLA_COSTING_BY_MODE, value)),
    ),
  ];
  return normalized.length ? normalized : [...DEFAULT_ISOCHRONE_MODES];
}

/**
 * Normalize per-mode contour durations while retaining the legacy shared
 * `minutes` contract.  A task may explicitly ask for e.g. walking=15,
 * cycling=20 and driving=30; in that case the routing adapter must not
 * silently request the cartesian product of every mode and every duration.
 */
function normalizeIsochroneModeMinutes(modeMinutes, modes, minutes) {
  const requestedModes = supportedIsochroneModes(modes);
  const sharedMinutes = positiveUniqueNumbers(
    minutes,
    DEFAULT_ISOCHRONE_MINUTES,
  );
  const normalized = {};
  for (const mode of requestedModes) {
    const candidate =
      modeMinutes && typeof modeMinutes === "object"
        ? modeMinutes[mode]
        : null;
    const values = positiveUniqueNumbers(
      candidate == null ? [] : Array.isArray(candidate) ? candidate : [candidate],
      [],
    );
    normalized[mode] = values.length ? values : [...sharedMinutes];
  }
  return normalized;
}

function flattenIsochroneModeMinutes(modeMinutes) {
  return positiveUniqueNumbers(
    Object.values(modeMinutes || {}).flatMap((values) => values),
    DEFAULT_ISOCHRONE_MINUTES,
  );
}

function configuredValhallaEndpoint() {
  const raw = safeText(
    process.env.NANOWORK_VALHALLA_ISOCHRONE_ENDPOINT ||
      DEFAULT_VALHALLA_ISOCHRONE_ENDPOINT,
    500,
  );
  const endpoint = new URL(raw);
  const local = ["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname);
  if (
    endpoint.protocol !== "https:" &&
    !(local && process.env.NANOWORK_ALLOW_LOCAL_ROUTING === "1")
  ) {
    throw new Error(
      "等时圈服务端点必须使用HTTPS；本机自托管需显式启用NANOWORK_ALLOW_LOCAL_ROUTING=1",
    );
  }
  if (!endpoint.pathname || endpoint.pathname === "/")
    endpoint.pathname = "/isochrone";
  return endpoint;
}

function validGeoJsonGeometry(value) {
  if (!value || !["Polygon", "MultiPolygon"].includes(value.type)) return null;
  if (!Array.isArray(value.coordinates) || !value.coordinates.length)
    return null;
  // 防止异常供应商响应无限膨胀任务快照。官方请求已用generalize压缩；这里仍设硬上限。
  const serialized = JSON.stringify(value);
  if (serialized.length > 180_000) return null;
  return JSON.parse(serialized);
}

function valhallaFeatureMinutes(feature) {
  const value = Number(
    feature?.properties?.contour ?? feature?.properties?.time,
  );
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/**
 * 真实时间等时圈供应商。默认使用 Valhalla 官方项目列出的全球公开演示端点；
 * 企业部署可通过环境变量切换到自托管 Valhalla，调用契约保持一致。
 *
 * 一个 costing 只能表达一种交通方式，因此四种模式分别请求，任何一种缺失
 * 都会由上层质量门阻断，绝不以固定半径或直线距离替代。
 */
export async function fetchValhallaIsochrones({
  lat,
  lon,
  modes = DEFAULT_ISOCHRONE_MODES,
  minutes = DEFAULT_ISOCHRONE_MINUTES,
  modeMinutes,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
  signal,
} = {}) {
  const centerLat = Number(lat);
  const centerLon = Number(lon);
  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
    throw new Error("等时圈中心坐标无效");
  }
  if (typeof fetchImpl !== "function")
    throw new Error("等时圈HTTP客户端不可用");

  const requestedModes = supportedIsochroneModes(modes);
  const requestedModeMinutes = normalizeIsochroneModeMinutes(
    modeMinutes,
    requestedModes,
    minutes,
  );
  const requestedMinutes = flattenIsochroneModeMinutes(requestedModeMinutes);
  const endpoint = configuredValhallaEndpoint();
  const calls = requestedModes.map(async (mode) => {
    const url = new URL(endpoint);
    const request = {
      locations: [{ lat: centerLat, lon: centerLon }],
      costing: VALHALLA_COSTING_BY_MODE[mode],
      contours: requestedModeMinutes[mode].map((time) => ({ time })),
      polygons: true,
      denoise: 1,
      generalize: 100,
      show_locations: false,
    };
    url.searchParams.set("json", JSON.stringify(request));
    const payload = await jsonGet(url, {
      fetchImpl,
      signal,
      timeoutMs,
      headers: {
        Accept: "application/geo+json, application/json",
        "X-Client-Id": "nanowork-enterprise",
      },
    });
    const features = Array.isArray(payload?.features) ? payload.features : [];
    const zones = features
      .map((feature) => {
        const contourMinutes = valhallaFeatureMinutes(feature);
        const polygon = validGeoJsonGeometry(feature?.geometry);
        if (!contourMinutes || !polygon) return null;
        return {
          mode,
          minutes: contourMinutes,
          polygon,
          provider: "Valhalla (OpenStreetMap routing graph)",
          source: url.toString(),
        };
      })
      .filter(Boolean);
    const returnedMinutes = new Set(zones.map((zone) => zone.minutes));
    const missingMinutes = requestedModeMinutes[mode].filter(
      (value) => !returnedMinutes.has(value),
    );
    if (missingMinutes.length) {
      throw new Error(`${mode}等时圈缺少${missingMinutes.join("/")}分钟边界`);
    }
    return zones;
  });
  const zonesByMode = await Promise.all(calls);
  return {
    provider: "Valhalla (OpenStreetMap routing graph)",
    source: endpoint.toString(),
    modes: requestedModes,
    minutes: requestedMinutes,
    modeMinutes: requestedModeMinutes,
    isochrones: zonesByMode.flat(),
    fetchedAt: new Date().toISOString(),
    externalCall: true,
  };
}

function normalizeIsochroneEvidence(value, { modes, minutes, modeMinutes }) {
  const requestedModes = supportedIsochroneModes(modes);
  const requestedModeMinutes = normalizeIsochroneModeMinutes(
    modeMinutes,
    requestedModes,
    minutes,
  );
  const requestedMinutes = flattenIsochroneModeMinutes(requestedModeMinutes);
  const zones = (Array.isArray(value?.isochrones) ? value.isochrones : [])
    .map((zone) => {
      const mode = safeText(zone?.mode, 30).toLowerCase();
      const contourMinutes = Number(zone?.minutes);
      const polygon = validGeoJsonGeometry(zone?.polygon || zone?.boundary);
      const source = safeText(zone?.source || value?.source, 3000);
      const provider = safeText(zone?.provider || value?.provider, 160);
      if (
        !requestedModes.includes(mode) ||
        !Number.isFinite(contourMinutes) ||
        contourMinutes <= 0 ||
        !requestedModeMinutes[mode]?.includes(Math.round(contourMinutes)) ||
        !polygon ||
        !provider ||
        !/^https:\/\//u.test(source)
      )
        return null;
      return {
        mode,
        minutes: Math.round(contourMinutes),
        polygon,
        provider,
        source,
      };
    })
    .filter(Boolean);
  const missing = [];
  for (const mode of requestedModes) {
    for (const contourMinutes of requestedModeMinutes[mode]) {
      if (
        !zones.some(
          (zone) => zone.mode === mode && zone.minutes === contourMinutes,
        )
      ) {
        missing.push(`${mode}:${contourMinutes}`);
      }
    }
  }
  return {
    provider: safeText(value?.provider || zones[0]?.provider, 160),
    source: safeText(value?.source || zones[0]?.source, 3000),
    isochrones: zones,
    requestedModes,
    requestedMinutes,
    requestedModeMinutes,
    complete: missing.length === 0,
    missing,
    fetchedAt: safeText(value?.fetchedAt, 80) || new Date().toISOString(),
    externalCall: value?.externalCall !== false,
  };
}

function placeMatchesExpectedCities(place, expectedCities) {
  if (!expectedCities.length) return true;
  const address = place?.address || {};
  const haystack = safeText(
    [
      place?.display_name,
      address.city,
      address.town,
      address.county,
      address.state,
    ]
      .filter(Boolean)
      .join(" "),
    500,
  );
  return expectedCities.some((city) => haystack.includes(city));
}

async function geocode(candidates, options, expectedCities = []) {
  const attempts = [];
  for (const query of candidates) {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "3");
    url.searchParams.set("countrycodes", "cn");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("q", query);
    try {
      const rows = await jsonGet(url, options);
      const matching = (Array.isArray(rows) ? rows : []).find((place) =>
        placeMatchesExpectedCities(place, expectedCities),
      );
      attempts.push({
        query,
        ok: Boolean(matching),
        rejectedCityMismatch: Math.max(
          0,
          (Array.isArray(rows) ? rows.length : 0) - (matching ? 1 : 0),
        ),
      });
      if (matching) return { query, place: matching, attempts };
    } catch (error) {
      attempts.push({ query, ok: false, error: safeText(error?.message, 120) });
    }
  }
  return { query: candidates[0] || "", place: null, attempts };
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (Number(value) * Math.PI) / 180;
  const aLat = toRad(lat1);
  const bLat = toRad(lat2);
  const dLat = bLat - aLat;
  const dLon = toRad(lon2) - toRad(lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat) * Math.cos(bLat) * Math.sin(dLon / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

function osmUrl(element) {
  const type =
    element?.type === "node"
      ? "node"
      : element?.type === "way"
        ? "way"
        : "relation";
  return `https://www.openstreetmap.org/${type}/${Number(element?.id)}`;
}

function poiKind(tags = {}) {
  if (
    tags.amenity === "restaurant" ||
    tags.amenity === "fast_food" ||
    tags.amenity === "cafe"
  )
    return "餐饮";
  if (tags.shop === "mall" || tags.amenity === "marketplace") return "商业";
  if (["school", "university", "college"].includes(tags.amenity)) return "学校";
  if (["hospital", "clinic"].includes(tags.amenity)) return "医疗";
  if (
    tags.highway === "bus_stop" ||
    tags.public_transport ||
    ["station", "halt", "subway_entrance"].includes(tags.railway)
  )
    return "交通";
  if (tags.office) return "办公";
  if (tags.tourism || tags.leisure === "park") return "休闲/景点";
  return "其他";
}

async function nearbyPois(lat, lon, radiusMeters, options) {
  const query = `[out:json][timeout:20];(
    nwr(around:${radiusMeters},${lat},${lon})[amenity~"restaurant|fast_food|cafe|school|university|college|hospital|clinic|marketplace"];
    nwr(around:${radiusMeters},${lat},${lon})[shop=mall];
    nwr(around:${radiusMeters},${lat},${lon})[highway=bus_stop];
    nwr(around:${radiusMeters},${lat},${lon})[railway=subway_entrance];
    nwr(around:${radiusMeters},${lat},${lon})[railway=station][station~"subway|light_rail"];
    nwr(around:${radiusMeters},${lat},${lon})[public_transport=station][subway=yes];
    nwr(around:${radiusMeters},${lat},${lon})[office];
    nwr(around:${radiusMeters},${lat},${lon})[tourism];
    nwr(around:${radiusMeters},${lat},${lon})[leisure=park];
  );out center tags 120;`;
  const configuredEndpoints = String(
    process.env.NANOWORK_OVERPASS_ENDPOINTS || "",
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const endpoints = [
    ...new Set([
      ...configuredEndpoints,
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
      "https://overpass.private.coffee/api/interpreter",
    ]),
  ];
  const failures = [];
  let payload = null;
  for (const endpoint of endpoints) {
    try {
      const url = new URL(endpoint);
      url.searchParams.set("data", query);
      payload = await jsonGet(url, options);
      break;
    } catch (error) {
      failures.push(
        `${new URL(endpoint).hostname}:${safeText(error?.message, 80)}`,
      );
    }
  }
  if (!payload) throw new Error(`Overpass全部端点失败：${failures.join("；")}`);
  return (Array.isArray(payload?.elements) ? payload.elements : [])
    .map((element) => {
      const elementLat = Number(element.lat ?? element.center?.lat);
      const elementLon = Number(element.lon ?? element.center?.lon);
      const name = safeText(element.tags?.name || element.tags?.brand, 120);
      if (!Number.isFinite(elementLat) || !Number.isFinite(elementLon) || !name)
        return null;
      return {
        element,
        name,
        kind: poiKind(element.tags),
        distanceMeters: haversineMeters(lat, lon, elementLat, elementLon),
        tags: element.tags || {},
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

function nominatimPoiTags(place) {
  const category = String(place?.category || "");
  const type = String(place?.type || "");
  if (category === "amenity") return { amenity: type };
  if (category === "shop") return { shop: type };
  if (category === "highway") return { highway: type };
  if (category === "railway") return { railway: type };
  if (category === "public_transport") return { public_transport: type };
  return {};
}

function nominatimPoiMatchesQuery(place, query) {
  const category = String(place?.category || "");
  const type = String(place?.type || "");
  if (query === "餐厅") {
    return (
      category === "amenity" &&
      ["restaurant", "fast_food", "cafe"].includes(type)
    );
  }
  if (query === "学校") {
    return (
      category === "amenity" &&
      ["school", "college", "university", "kindergarten"].includes(type)
    );
  }
  if (query === "医院") {
    return (
      category === "amenity" &&
      ["hospital", "clinic", "doctors", "dentist"].includes(type)
    );
  }
  if (query === "公交站") {
    return (
      (category === "highway" && type === "bus_stop") ||
      category === "public_transport" ||
      (category === "railway" &&
        ["station", "halt", "subway_entrance"].includes(type))
    );
  }
  if (query === "地铁站") {
    return (
      (category === "railway" &&
        ["station", "halt", "subway_entrance"].includes(type)) ||
      (category === "public_transport" &&
        ["station", "stop_position", "platform"].includes(type))
    );
  }
  if (query === "购物中心") {
    return (
      (category === "shop" && ["mall", "department_store"].includes(type)) ||
      (category === "amenity" && type === "marketplace")
    );
  }
  return false;
}

async function nearbyPoisViaNominatim(lat, lon, radiusMeters, options) {
  const latDelta = Math.max(0.006, radiusMeters / 111_000);
  const lonDelta = Math.max(
    0.006,
    radiusMeters / (111_000 * Math.max(0.2, Math.cos((lat * Math.PI) / 180))),
  );
  const viewbox = `${lon - lonDelta},${lat + latDelta},${lon + lonDelta},${lat - latDelta}`;
  // Nominatim 的 category/type 搜索词是 OSM 英文标签语义。
  // 在太原同一 viewbox 内 q=餐厅会返回0条，q=restaurant 可正常
  // 返回餐饮POI。之前中文查询把 Overpass 故障时的备用链变成
  // “只有医院/学校，没有餐厅”，最终误拦整单。
  const queries = [
    { label: "餐厅", value: "restaurant" },
    { label: "学校", value: "school" },
    { label: "医院", value: "hospital" },
    { label: "公交站", value: "bus stop" },
    { label: "地铁站", value: "subway station" },
    { label: "购物中心", value: "shopping mall" },
  ];
  const output = [];
  const attempts = [];
  for (const [index, query] of queries.entries()) {
    // Nominatim公共服务要求低频访问；只有Overpass失败才进入本降级链，
    // 相邻请求至少间隔1秒，避免把恢复能力变成对公共服务的滥用。
    if (index > 0)
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, Number(options.fallbackDelayMs ?? 1050)),
        ),
      );
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "8");
    url.searchParams.set("countrycodes", "cn");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("bounded", "1");
    url.searchParams.set("viewbox", viewbox);
    url.searchParams.set("q", query.value);
    try {
      const rows = await jsonGet(url, {
        ...options,
        timeoutMs: Math.min(
          Math.max(4000, Number(options.timeoutMs) || 7000),
          8000,
        ),
      });
      attempts.push({
        query: query.label,
        providerQuery: query.value,
        ok: true,
        count: Array.isArray(rows) ? rows.length : 0,
      });
      for (const place of Array.isArray(rows) ? rows : []) {
        if (!nominatimPoiMatchesQuery(place, query.label)) continue;
        const placeLat = Number(place.lat);
        const placeLon = Number(place.lon);
        const name = safeText(
          place.name || String(place.display_name || "").split(",")[0],
          120,
        );
        if (!name || !Number.isFinite(placeLat) || !Number.isFinite(placeLon))
          continue;
        const tags = nominatimPoiTags(place);
        output.push({
          name,
          kind: poiKind(tags),
          distanceMeters: haversineMeters(lat, lon, placeLat, placeLon),
          tags: { ...tags, categoryQuery: query.label },
          url: placeOsmUrl(place, placeLat, placeLon),
        });
      }
    } catch (error) {
      attempts.push({
        query: query.label,
        providerQuery: query.value,
        ok: false,
        error: safeText(error?.message, 120),
      });
    }
  }
  const seen = new Set();
  return {
    pois: output
      .filter((item) => {
        const key = `${item.kind}:${item.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.distanceMeters - b.distanceMeters),
    attempts,
  };
}

function placeOsmUrl(place, lat, lon) {
  const type = String(place?.osm_type || "").toLowerCase();
  const id = Number(place?.osm_id);
  if (id > 0 && ["node", "way", "relation"].includes(type)) {
    return `https://www.openstreetmap.org/${type}/${id}`;
  }
  return `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lon)}#map=16/${encodeURIComponent(lat)}/${encodeURIComponent(lon)}`;
}

export async function collectLocationIntelligence(
  value,
  {
    radiusMeters,
    maxResults = 10,
    timeoutMs = 12000,
    signal,
    fetchImpl = globalThis.fetch,
    isochroneProvider,
    requireIsochrones = false,
    isochroneModes = DEFAULT_ISOCHRONE_MODES,
    isochroneMinutes = DEFAULT_ISOCHRONE_MINUTES,
    isochroneModeMinutes,
    nominatimFallbackDelayMs = 1050,
  } = {},
) {
  const locationIntent = normalizeLocationIntent(value);
  const candidates = locationIntent.centerCandidates;
  const effectiveRadiusMeters = Math.max(
    300,
    Math.min(
      5000,
      Number(radiusMeters ?? locationIntent.radiusMeters ?? 1500) || 1500,
    ),
  );
  if (!candidates.length) {
    return {
      attempted: false,
      ok: false,
      provider: null,
      results: [],
      note: "任务中未识别到可检索地点",
    };
  }
  if (typeof fetchImpl !== "function") {
    return {
      attempted: true,
      ok: false,
      provider: null,
      results: [],
      note: "地图检索客户端不可用",
    };
  }
  const expectedCities = CITY_NAMES.filter((city) =>
    safeText(value, 600).includes(city),
  );
  const geocoded = await geocode(
    candidates,
    { fetchImpl, signal, timeoutMs },
    expectedCities,
  );
  if (!geocoded.place) {
    return {
      attempted: true,
      ok: false,
      provider: "OpenStreetMap Nominatim",
      results: [],
      note: `真实地图地理编码未命中：${candidates.join("、")}`,
      evidence: { candidates, geocodeAttempts: geocoded.attempts },
    };
  }
  const lat = Number(geocoded.place.lat);
  const lon = Number(geocoded.place.lon);
  let pois = [];
  let poiError = null;
  let poiSource = "Overpass";
  let poiFallbackAttempts = [];
  try {
    pois = await nearbyPois(
      lat,
      lon,
      effectiveRadiusMeters,
      {
        fetchImpl,
        signal,
        timeoutMs: Math.min(Math.max(timeoutMs, 6000), 10000),
      },
    );
  } catch (error) {
    poiError = safeText(error?.message, 160);
    const fallback = await nearbyPoisViaNominatim(
      lat,
      lon,
      effectiveRadiusMeters,
      {
        fetchImpl,
        signal,
        timeoutMs,
        fallbackDelayMs: nominatimFallbackDelayMs,
      },
    );
    pois = fallback.pois;
    poiFallbackAttempts = fallback.attempts;
    if (pois.length) poiSource = "Nominatim bounded POI supplement";
  }
  const counts = Object.fromEntries(
    [...new Set(pois.map((item) => item.kind))].map((kind) => [
      kind,
      pois.filter((item) => item.kind === kind).length,
    ]),
  );
  let isochroneEvidence = null;
  let isochroneError = null;
  if (typeof isochroneProvider === "function" || requireIsochrones) {
    const provider =
      typeof isochroneProvider === "function"
        ? isochroneProvider
        : fetchValhallaIsochrones;
    try {
      const requestedModeMinutes = normalizeIsochroneModeMinutes(
        isochroneModeMinutes,
        isochroneModes,
        isochroneMinutes,
      );
      const providerRequest = {
        lat,
        lon,
        modes: supportedIsochroneModes(isochroneModes),
        minutes: flattenIsochroneModeMinutes(requestedModeMinutes),
      };
      // Only add the new field when a caller supplied an explicit mapping;
      // omitted mappings preserve the legacy provider request exactly.
      if (isochroneModeMinutes && typeof isochroneModeMinutes === "object")
        providerRequest.modeMinutes = requestedModeMinutes;
      // 可注入供应商只接收可序列化业务参数，避免把HTTP客户端、AbortSignal
      // 或其他运行时对象泄漏到插件边界；内建Valhalla适配器才接收传输控制项。
      const supplied =
        typeof isochroneProvider === "function"
          ? await provider(providerRequest)
          : await provider({
              ...providerRequest,
              fetchImpl,
              timeoutMs,
              signal,
            });
      isochroneEvidence = normalizeIsochroneEvidence(supplied, {
        modes: isochroneModes,
        minutes: isochroneMinutes,
        modeMinutes: isochroneModeMinutes,
      });
      if (!isochroneEvidence.complete) {
        isochroneError = `真实等时圈不完整：${isochroneEvidence.missing.join("、")}`;
      }
    } catch (error) {
      isochroneError = safeText(error?.message || error, 300);
    }
  }
  const centerTitle = safeText(
    geocoded.place.display_name || geocoded.query,
    180,
  );
  const results = [
    {
      title: `OpenStreetMap定位·${geocoded.query}`,
      url: placeOsmUrl(geocoded.place, lat, lon),
      snippet: `地图核验位置：${centerTitle}；坐标 ${lat.toFixed(6)}, ${lon.toFixed(6)}；周边${effectiveRadiusMeters}米已命名POI分类计数：${
        Object.entries(counts)
          .map(([key, count]) => `${key}${count}`)
          .join("、") || "0"
      }。`,
    },
  ];
  // 餐饮POI必须保留给直接来源质量门；老板另外明确要地铁/公交时，
  // 交通POI优先进结果，不用自动生成12个等时圈来代替“附近站点”。
  const wantsTransitPoi = locationIntent.requestedFacilities.some((facility) =>
    ["地铁站", "公交站"].includes(facility),
  );
  const byDistance = (items) =>
    [...items].sort((a, b) => a.distanceMeters - b.distanceMeters);
  const restaurantPois = byDistance(
    pois.filter((item) => item.kind === "餐饮"),
  );
  const transitPois = byDistance(pois.filter((item) => item.kind === "交通"));
  const otherPois = byDistance(
    pois.filter((item) => !["餐饮", "交通"].includes(item.kind)),
  );
  const prioritizedPois = wantsTransitPoi
    ? [
        ...transitPois.slice(0, 1),
        ...restaurantPois,
        ...transitPois.slice(1),
        ...otherPois,
      ]
    : [...restaurantPois, ...transitPois, ...otherPois];
  for (const poi of prioritizedPois.slice(
    0,
    Math.max(1, Number(maxResults) - 1),
  )) {
    results.push({
      title: `OpenStreetMap周边${poi.kind}·${poi.name}`,
      url: poi.url || osmUrl(poi.element),
      snippet: `地图中心=${centerTitle}；距中心直线约${poi.distanceMeters}米；类别=${poi.kind}${poi.tags.cuisine ? `；cuisine=${safeText(poi.tags.cuisine, 80)}` : ""}${poi.tags.opening_hours ? `；营业时间标签=${safeText(poi.tags.opening_hours, 80)}` : ""}。OSM公开数据可能不完整，营业状态与价格仍需交叉核验。`,
      evidenceKind:
        poi.kind === "餐饮"
          ? "structured_location_restaurant_poi"
          : "structured_location_poi",
    });
  }
  if (isochroneEvidence?.complete) {
    for (const mode of isochroneEvidence.requestedModes) {
      const zones = isochroneEvidence.isochrones.filter(
        (zone) => zone.mode === mode,
      );
      results.push({
        title: `Valhalla时间等时圈·${mode}`,
        url: zones[0]?.source || isochroneEvidence.source,
        snippet: `${mode}真实路网时间边界：${zones.map((zone) => `${zone.minutes}分钟`).join("、")}；中心=${centerTitle}；供应商=${zones[0]?.provider || isochroneEvidence.provider}。该证据基于路网可达时间，不是固定半径或直线距离。`,
      });
    }
  }
  const isochroneComplete = isochroneEvidence?.complete === true;
  return {
    attempted: true,
    ok: results.length > 0 && (!requireIsochrones || isochroneComplete),
    provider: [
      `OpenStreetMap Nominatim + ${poiSource}`,
      isochroneEvidence?.provider,
    ]
      .filter(Boolean)
      .join(" + "),
    results: results.slice(0, Math.max(1, Number(maxResults)) + 4),
    note:
      [
        poiError
          ? `地点已定位；主POI节点不可达，已切换备用公开地图检索：${poiError}`
          : null,
        isochroneError ? `时间等时圈未完成：${isochroneError}` : null,
      ]
        .filter(Boolean)
        .join("；") || null,
    evidence: {
      schemaVersion: "nanowork.location-intelligence/2",
      query: geocoded.query,
      candidates,
      geocodeAttempts: geocoded.attempts,
      center: { displayName: centerTitle, lat, lon },
      radiusMeters: effectiveRadiusMeters,
      requestedRadiusRangeMeters: locationIntent.radiusRangeMeters,
      requestedFacilities: locationIntent.requestedFacilities,
      namedPoiCount: pois.length,
      restaurants: restaurantPois.slice(0, 25).map((poi) => ({
        name: poi.name,
        distance: poi.distanceMeters,
        cuisine: safeText(poi.tags.cuisine, 80),
        lat: Number(poi.element?.lat ?? poi.element?.center?.lat),
        lon: Number(poi.element?.lon ?? poi.element?.center?.lon),
      })),
      counts,
      poiSource,
      poiFallbackAttempts,
      isochroneRequired: Boolean(requireIsochrones),
      isochroneComplete,
      isochroneProvider: isochroneEvidence?.provider || null,
      isochroneSource: isochroneEvidence?.source || null,
      isochroneModes:
        isochroneEvidence?.requestedModes ||
        supportedIsochroneModes(isochroneModes),
      isochroneMinutes:
        isochroneEvidence?.requestedMinutes ||
        positiveUniqueNumbers(isochroneMinutes, DEFAULT_ISOCHRONE_MINUTES),
      isochroneModeMinutes:
        isochroneEvidence?.requestedModeMinutes ||
        (isochroneModeMinutes && typeof isochroneModeMinutes === "object"
          ? normalizeIsochroneModeMinutes(
              isochroneModeMinutes,
              isochroneModes,
              isochroneMinutes,
            )
          : null),
      isochrones: isochroneEvidence?.isochrones || [],
      isochroneError,
      fetchedAt: new Date().toISOString(),
      externalCall: true,
    },
  };
}

// ===========================================================================
// 商圈结构化事实：高德 Web 服务优先，失败/未配置回落 OSM 证据；逐字段 provenance。
// ===========================================================================

export const TRADE_AREA_FACTS_SCHEMA_VERSION = "nanowork.trade-area-facts/1";
export const DEFAULT_TRADE_AREA_RADII = Object.freeze([500, 1000, 1500]);
const TRADE_AREA_FACILITY_RADIUS = 1000;
const TRADE_AREA_TOP_N = 10;
// PRD v2.2 FR-4.2：行情快查/完整报告最多取 30 家；最近 5 家无论如何保留，其余按
// “品类匹配 × 评分 × 距离衰减”综合分排序。默认调用仍为 10 家（兼容既有岗位）。
export const TRADE_AREA_TOP_N_MAX = 30;
const TRADE_AREA_KEEP_NEAREST = 5;
const RELATED_CATEGORY_LIMIT = 3;
const RELATED_CATEGORY_ROWS = 6;

function rankTradeAreaPois(pois, limit, radius) {
  const byDistance = [...pois].sort(
    (a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY),
  );
  if (limit <= TRADE_AREA_TOP_N) return byDistance.slice(0, limit);
  const nearest = byDistance.slice(0, TRADE_AREA_KEEP_NEAREST);
  const span = Math.max(300, Number(radius) || 1500);
  const score = (poi) => {
    const rating = Number(poi?.biz_ext?.rating);
    const ratingFactor = Number.isFinite(rating) && rating > 0 ? rating / 5 : 0.7;
    const distance = Number(poi?.distance);
    const decay = Number.isFinite(distance) ? Math.exp(-distance / span) : 0.3;
    return ratingFactor * (0.4 + 0.6 * decay);
  };
  const rest = byDistance
    .slice(TRADE_AREA_KEEP_NEAREST)
    .sort((a, b) => score(b) - score(a))
    .slice(0, Math.max(0, limit - nearest.length));
  return [...nearest, ...rest];
}
const COST_BUCKETS = Object.freeze([
  ["≤30元", 0, 30],
  ["30-60元", 30, 60],
  ["60-100元", 60, 100],
  ["100-150元", 100, 150],
  [">150元", 150, Number.POSITIVE_INFINITY],
]);
const RATING_BUCKETS = Object.freeze([
  ["<3.5", 0, 3.5],
  ["3.5-4.0", 3.5, 4],
  ["4.0-4.5", 4, 4.5],
  ["≥4.5", 4.5, Number.POSITIVE_INFINITY],
]);
const OSM_FACILITY_LABELS = Object.freeze({
  商业: "商场",
  学校: "学校",
  医疗: "医院",
  交通: "公交/地铁站",
  办公: "写字楼",
});

export function detectCity(text) {
  const value = safeText(text, 600);
  return CITY_NAMES.find((city) => value.includes(city)) || null;
}

/**
 * 从派活文本解析可地理编码的地址与城市；识别不到具体场所时返回 null，
 * 避免把整句需求送去地理编码。城市识别沿用既有 CITY_NAMES 正则（provenance=regex）。
 */
export function extractTradeAreaAddress(text) {
  const value = safeText(text, 600);
  if (!value) return null;
  const intent = normalizeLocationIntent(value);
  const city = intent.city;
  const candidates = intent.centerCandidates;
  const addressText = candidates[0] || null;
  if (!addressText) return null;
  return {
    addressText,
    city,
    candidates,
    centerCandidates: candidates,
    radiusRangeMeters: intent.radiusRangeMeters,
    radiiMeters: intent.radiiMeters,
    radiusMeters: intent.radiusMeters,
    requestedFacilities: intent.requestedFacilities,
    explicitIsochroneRequested: intent.explicitIsochroneRequested,
    provenance: {
      provider: "regex",
      endpoint: "normalizeLocationIntent",
      fetchedAt: new Date().toISOString(),
    },
  };
}

function provenanceOf(provider, endpoint, fetchedAt, extra = {}) {
  return {
    provider,
    endpoint: endpoint || null,
    fetchedAt: fetchedAt || null,
    ...extra,
  };
}

function roundTo(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function bucketCounts(values, buckets) {
  return Object.fromEntries(
    buckets.map(([label, min, max]) => [
      label,
      values.filter((value) => value >= min && value < max).length,
    ]),
  );
}

function numericDistribution(values, buckets) {
  // 高德缺失字段已被适配器归一为 null；Number(null)===0 会把“未提供”伪装成 0 元/0 分，必须先剔除。
  const nums = values
    .filter((value) => value != null && value !== "")
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!nums.length) return null;
  const percentile = (p) =>
    nums[Math.min(nums.length - 1, Math.floor(p * (nums.length - 1)))];
  return {
    sampleSize: nums.length,
    min: nums[0],
    p25: percentile(0.25),
    median: percentile(0.5),
    p75: percentile(0.75),
    max: nums.at(-1),
    mean: roundTo(nums.reduce((sum, value) => sum + value, 0) / nums.length),
    buckets: bucketCounts(nums, buckets),
  };
}

function poiCategory(poi) {
  const parts = String(poi?.type || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    category: parts[1] || parts[0] || "未分类",
    subcategory: parts[2] || null,
  };
}

const PET_FOOD_RE = /宠物|宠粮|猫粮|狗粮|犬粮|宠物鲜食/iu;
const NOODLE_EXCLUDE_RE =
  /刀削面|炸酱面|热干面|阳春面|意大利面|意面|米线|米粉|螺蛳粉|过桥米线|重庆小面|担担面|凉皮|馄饨面/iu;
const BEEF_NOODLE_INCLUDE_RE = /牛肉面|牛肉拉面|兰州拉面|兰州牛肉/iu;

const CATEGORY_PROFILES = Object.freeze([
  {
    keys: Object.freeze(["兰州牛肉面", "牛肉拉面", "牛肉面"]),
    searchKeywords: Object.freeze(["牛肉面", "兰州拉面"]),
    include: BEEF_NOODLE_INCLUDE_RE,
    exclude: NOODLE_EXCLUDE_RE,
  },
  {
    keys: Object.freeze(["兰州拉面"]),
    searchKeywords: Object.freeze(["兰州拉面", "牛肉面"]),
    include: BEEF_NOODLE_INCLUDE_RE,
    exclude: NOODLE_EXCLUDE_RE,
  },
  {
    keys: Object.freeze(["烘焙", "面包", "蛋糕", "糕点", "糕饼", "甜品"]),
    include: /烘焙|面包|蛋糕|糕点|糕饼|西饼|甜品|甜点|\bcake\b|\bbakery\b/iu,
    exclude: PET_FOOD_RE,
  },
  {
    keys: Object.freeze(["挂炉烤鸭", "片皮烤鸭", "北京烤鸭", "烤鸭"]),
    searchKeywords: Object.freeze(["烤鸭", "北京菜"]),
    include: /烤鸭|挂炉|片皮鸭|北京菜/iu,
    exclude: PET_FOOD_RE,
  },
]);

const GENERIC_CATEGORY_KEYWORDS = Object.freeze([
  "火锅", "毛血旺", "川菜", "湘菜", "粤菜", "烧烤", "烤肉", "日料", "寿司", "西餐",
  "咖啡", "奶茶", "茶饮", "快餐", "小吃", "面馆", "米线", "麻辣烫", "串串", "烤鱼",
  "海鲜", "东北菜", "本帮菜", "江浙菜", "云南菜", "新疆菜", "披萨", "汉堡", "炸鸡",
  "早餐", "粥", "饺子", "包子", "鲁菜", "徽菜", "闽菜", "刀削面", "炸酱面", "热干面",
  "螺蛳粉", "过桥米线", "烤鸭", "北京菜", "挂炉烤鸭", "片皮烤鸭", "北京烤鸭",
]);

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function profileForKeyword(keyword) {
  const key = String(keyword || "").trim();
  if (!key) return null;
  return CATEGORY_PROFILES.find((profile) => profile.keys.includes(key)) || null;
}

function normalizeExtractedCategory(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const stripped = text.replace(/(?:专门店|餐厅|馆|店)$/u, "");
  return stripped.length >= 2 ? stripped : text;
}

/**
 * 从任务文本提取同品类关键词。更具体的菜品优先于“面馆/快餐”等大类，
 * 避免“牛肉面馆”被收成所有面馆。
 */
export function resolveTradeAreaCategory(text) {
  const value = String(text || "");
  if (!value.trim()) return null;
  const keyed = [
    ...CATEGORY_PROFILES.flatMap((profile) => profile.keys.map((key) => ({ key, profile }))),
    ...GENERIC_CATEGORY_KEYWORDS.map((key) => ({ key, profile: null })),
  ].filter((item) => value.includes(item.key));
  keyed.sort((a, b) => b.key.length - a.key.length || a.key.localeCompare(b.key, "zh"));
  const hit = keyed[0];
  if (hit) {
    const keyword = hit.profile ? hit.key : normalizeExtractedCategory(hit.key);
    const profile = hit.profile || profileForKeyword(keyword);
    return {
      keyword,
      searchKeywords: [...(profile?.searchKeywords || [keyword])],
      include: profile?.include || new RegExp(escapeRegExp(keyword), "iu"),
      exclude: profile?.exclude || PET_FOOD_RE,
    };
  }
  const opened = value.match(
    /(?:开了|开一家|经营|做|同类|同类型|同品类)\s*(?:一家)?\s*([\u4e00-\u9fff]{2,12}(?:面馆|面店|拉面|米线|火锅|烧烤|烘焙|餐厅)?)/u,
  );
  if (!opened) return null;
  const keyword = normalizeExtractedCategory(opened[1]);
  if (!keyword) return null;
  const profile = profileForKeyword(keyword);
  return {
    keyword,
    searchKeywords: [...(profile?.searchKeywords || [keyword])],
    include: profile?.include || new RegExp(escapeRegExp(keyword), "iu"),
    exclude: profile?.exclude || PET_FOOD_RE,
  };
}

export function categorySearchKeywords(keyword) {
  const profile = profileForKeyword(keyword);
  if (profile?.searchKeywords?.length) return [...profile.searchKeywords];
  return keyword ? [String(keyword)] : [];
}

export function matchesCategoryKeyword(poi, keyword) {
  if (!keyword) return true;
  const haystack = `${poi?.name || ""} ${poi?.type || ""}`;
  if (PET_FOOD_RE.test(haystack)) return false;
  const profile = profileForKeyword(keyword) || resolveTradeAreaCategory(keyword);
  const include = profile?.include || new RegExp(escapeRegExp(keyword), "iu");
  const exclude = profile?.exclude || PET_FOOD_RE;
  if (exclude.test(haystack) && !include.test(haystack)) return false;
  return include.test(haystack);
}

function namedPlacesMatchingCategory(rows, keyword) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const lng = Number(row?.lng ?? row?.lon);
      const lat = Number(row?.lat);
      return {
        id: row?.id || null,
        name: safeText(row?.name, 80),
        coords: Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null,
        distance: Number.isFinite(Number(row?.distance)) ? Number(row.distance) : null,
        address: safeText(row?.address, 200) || null,
        type: safeText(row?.cuisine || row?.type, 80) || "公开地图餐饮",
        cost: null,
        rating: null,
      };
    })
    .filter((poi) => poi.name && matchesCategoryKeyword(poi, keyword));
}

function countByCategory(pois) {
  const counts = {};
  for (const poi of pois) {
    const { category } = poiCategory(poi);
    counts[category] = (counts[category] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1]),
  );
}

function facilityMatches(poi, typecode) {
  const code = String(poi?.typecode || "");
  if (!code) return false;
  // 高德 typecode 六位：大类2位+中类2位+小类2位；配置为中类码（末两位 00）时按前四位匹配。
  const prefix = typecode.endsWith("00") ? typecode.slice(0, 4) : typecode;
  return code
    .split("|")
    .some((item) => item.trim().startsWith(prefix));
}

function amapErrorSummary(error) {
  return {
    message: safeText(error?.message || error, 200),
    infocode: error?.infocode || null,
    blocked: error?.blocked === true,
    transient: error?.transient === true,
    quotaExceeded: error?.quotaExceeded === true,
  };
}

async function recoverSameCategoryByTextSearch({
  client,
  city,
  place,
  keyword,
  signal,
} = {}) {
  const empty = { pois: [], source: null, count: 0, truncated: false, attempts: [] };
  if (!client?.searchText || !keyword) return empty;
  const placeCore = safeText(place, 24).replace(/^(?:北京|上海|天津|重庆|广州|深圳)市?/u, "");
  const queries = unique([
    ...categorySearchKeywords(keyword).map((item) => `${placeCore} ${item}`.trim()),
    ...categorySearchKeywords(keyword),
  ]).slice(0, 3);
  const pois = [];
  const attempts = [];
  let source = null;
  let count = 0;
  let truncated = false;
  for (const keywords of queries) {
    try {
      const result = await client.searchText({
        keywords,
        city: safeText(city, 40) || undefined,
        types: AMAP_RESTAURANT_TYPECODE,
        citylimit: Boolean(city),
        pages: 2,
        signal,
      });
      if (result?.unavailable) {
        attempts.push({ step: "amap_category_text", ok: false, keywords, note: result.reason || "关键字补采未配置" });
        continue;
      }
      const data = result?.data;
      source = source || result?.source;
      count += Number(data?.count || 0);
      truncated = truncated || data?.truncated === true;
      pois.push(...(data?.pois || []));
      attempts.push({
        step: "amap_category_text",
        ok: true,
        keywords,
        count: data?.count,
        returned: data?.returned,
      });
    } catch (error) {
      const reason = amapErrorSummary(error);
      attempts.push({ step: "amap_category_text", ok: false, keywords, note: reason.message });
      if (reason.blocked) break;
    }
  }
  return { pois, source, count, truncated, attempts };
}

/**
 * 解析商圈结构化事实。
 *
 * @param {object} params
 * @param {string} params.addressText 可地理编码的地址/场所
 * @param {string[]} params.addressCandidates 同一中心的有序具体地址候选
 * @param {string|null} params.city 城市（可空）
 * @param {number[]} params.radii 竞品统计半径（米）
 * @param {string|null} params.categoryKeyword 同品类关键词（如“火锅”），用于 Top10 同品类竞品
 * @param {object} params.amapClient 可注入高德客户端（createAmapClient 返回值）
 * @param {Function} params.fetchImpl 未注入客户端时用于构造默认客户端的 fetch
 * @param {object|null} params.osmEvidence collectLocationIntelligence 返回的 evidence（回落与等时圈补充）
 * @param {Function|null} params.osmFallback 惰性获取 osmEvidence 的函数（可复用在途请求）
 */
export async function resolveTradeAreaFacts({
  addressText,
  addressCandidates = [],
  city = null,
  radii = DEFAULT_TRADE_AREA_RADII,
  categoryKeyword = null,
  amapClient,
  fetchImpl,
  cache,
  signal,
  osmEvidence = null,
  osmFallback = null,
  requireIsochrones = false,
  topN = TRADE_AREA_TOP_N,
  relatedCategories = [],
  now = () => new Date(),
} = {}) {
  const startedAt = now().toISOString();
  const competitorLimit = Math.max(1, Math.min(TRADE_AREA_TOP_N_MAX, Math.floor(Number(topN)) || TRADE_AREA_TOP_N));
  const relatedCategoryList = unique(
    (Array.isArray(relatedCategories) ? relatedCategories : []).map((item) => safeText(item, 20)).filter(Boolean),
  ).slice(0, RELATED_CATEGORY_LIMIT);
  const normalizedRadii = positiveUniqueNumbers(radii, DEFAULT_TRADE_AREA_RADII)
    .map((value) => Math.max(100, Math.min(5000, value)))
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((a, b) => a - b);
  const normalizedAddressCandidates = unique([
    safeText(addressText, 200),
    ...(Array.isArray(addressCandidates) ? addressCandidates : []),
  ])
    .filter((candidate) => !isGenericLocationCandidate(candidate))
    // 同一中心只尝试少量有序候选。若是凭证、配额或传输错误，下方会
    // 立即停止；只有高德正常返回“未匹配”时才继续下一个候选。
    .slice(0, 4);
  const facts = {
    schemaVersion: TRADE_AREA_FACTS_SCHEMA_VERSION,
    ok: false,
    provider: null,
    input: {
      addressText: normalizedAddressCandidates[0] || null,
      addressCandidates: normalizedAddressCandidates,
      city: safeText(city, 40) || null,
      radii: normalizedRadii,
      categoryKeyword: safeText(categoryKeyword, 40) || null,
    },
    center: null,
    competitors: null,
    topCompetitors: null,
    priceDistribution: null,
    ratingDistribution: null,
    facilities: null,
    isochrones: null,
    amap: {
      configured: false,
      attempted: false,
      ok: false,
      blocked: false,
      error: null,
      requestCount: 0,
      cacheHits: 0,
    },
    sources: [],
    missingCriticalFacts: [],
    attempts: [],
    startedAt,
    fetchedAt: startedAt,
  };
  const missing = (field, reason) => {
    if (!facts.missingCriticalFacts.some((item) => item.field === field)) {
      facts.missingCriticalFacts.push({ field, reason: safeText(reason, 240) });
    }
  };
  const addSource = (source, label) => {
    if (!source?.provider) return;
    facts.sources.push({
      label,
      provider: source.provider,
      endpoint: source.endpoint || null,
      fetchedAt: source.fetchedAt || null,
      cached: source.cached === true,
    });
    if (source.cached === true) facts.amap.cacheHits += 1;
  };

  // PRD v2.2 FR-4.3：系统自建的高德客户端按任务分配请求预算（默认 25 次，接近日配额时收紧）。
  const client = amapClient || createAmapClient({ fetchImpl, cache, requestBudget: amapTaskRequestBudget() });
  facts.amap.configured = client.configured === true;
  if (!normalizedAddressCandidates.length)
    missing("center", "任务中未识别到可地理编码的地址或场所");

  // ---- 高德：地理编码 ----
  let center = null;
  if (normalizedAddressCandidates.length && facts.amap.configured) {
    facts.amap.attempted = true;
    for (const [index, candidate] of normalizedAddressCandidates.entries()) {
      try {
        const geo = await client.geocode(candidate, facts.input.city, { signal });
        if (geo?.unavailable) {
          facts.amap.error = { message: geo.reason, blocked: false };
          facts.attempts.push({
            step: "amap_geocode",
            candidate,
            candidateIndex: index,
            ok: false,
            note: geo.reason,
          });
          break;
        }
        facts.amap.requestCount += 1;
        addSource(geo.source, `商圈中心地理编码（候选${index + 1}）`);
        if (!geo?.data) {
          facts.attempts.push({
            step: "amap_geocode",
            candidate,
            candidateIndex: index,
            ok: false,
            note: geo?.note || "高德未匹配到该地址",
          });
          continue;
        }
        if (isCoarseAmapGeocode(geo.data, candidate, facts.input.city)) {
          facts.attempts.push({
            step: "amap_geocode",
            candidate,
            candidateIndex: index,
            ok: false,
            note: `高德只定位到${geo.data.level || "城市"}级，未落到任务地点`,
            level: geo.data.level || null,
          });
          continue;
        }
        center = geo.data;
        facts.provider = "amap";
        facts.amap.ok = true;
        facts.center = {
          value: {
            lng: center.lng,
            lat: center.lat,
            adcode: center.adcode,
            formattedAddress: center.formattedAddress,
            province: center.province,
            city: center.city,
            district: center.district,
            level: center.level,
            matchedAddressText: candidate,
          },
          provenance: provenanceOf(
            "amap",
            geo.source.endpoint,
            geo.source.fetchedAt,
          ),
        };
        facts.attempts.push({
          step: "amap_geocode",
          candidate,
          candidateIndex: index,
          ok: true,
        });
        break;
      } catch (error) {
        facts.amap.error = amapErrorSummary(error);
        facts.amap.blocked = error?.blocked === true;
        facts.attempts.push({
          step: "amap_geocode",
          candidate,
          candidateIndex: index,
          ok: false,
          note: facts.amap.error.message,
        });
        // 凭证、配额或传输错误与候选地址无关，换一个地名只会重复消耗。
        // 只对“高德正常响应但无匹配”继续下一个具体候选。
        break;
      }
    }
    if (!center && !facts.amap.blocked && typeof client.searchText === "function") {
      // 商圈名（如“北京望京”）偶尔被 geocode 判为区县粗定位时，按候选顺序用高德 POI 关键词搜索补定精确中心。
      for (const anchorCandidate of normalizedAddressCandidates.slice(0, 2)) {
        try {
          const textRes = await client.searchText({
            keywords: anchorCandidate,
            city: facts.input.city || undefined,
            citylimit: Boolean(facts.input.city),
            pages: 1,
            signal,
          });
          if (textRes?.unavailable) break;
          facts.amap.requestCount += Number(textRes?.data?.requestCount || 1);
          addSource(textRes.source, "商圈中心POI搜索补定位");
          const hit = (textRes?.data?.pois || []).find(
            (poi) =>
              poi?.coords &&
              Number.isFinite(Number(poi.coords.lng)) &&
              Number.isFinite(Number(poi.coords.lat)),
          );
          if (hit) {
            center = {
              lng: Number(hit.coords.lng),
              lat: Number(hit.coords.lat),
              adcode: hit.adcode || null,
              formattedAddress: safeText(hit.address || hit.name, 200) || anchorCandidate,
              province: hit.pname || null,
              city: hit.cityname || facts.input.city || null,
              district: hit.adname || null,
              level: "poi_search",
            };
            facts.provider = "amap";
            facts.amap.ok = true;
            facts.center = {
              value: {
                ...center,
                matchedAddressText: anchorCandidate,
              },
              provenance: provenanceOf(
                "amap",
                textRes.source?.endpoint || "/v3/place/text",
                textRes.source?.fetchedAt || now().toISOString(),
              ),
            };
            facts.attempts.push({
              step: "amap_center_text_search",
              candidate: anchorCandidate,
              ok: true,
              poiName: hit.name || null,
            });
            break;
          }
          facts.attempts.push({
            step: "amap_center_text_search",
            candidate: anchorCandidate,
            ok: false,
            note: "高德POI搜索未返回带坐标中心点",
          });
        } catch (error) {
          const reason = amapErrorSummary(error);
          if (reason.blocked) facts.amap.blocked = true;
          if (!facts.amap.error || reason.blocked) facts.amap.error = reason;
          facts.attempts.push({
            step: "amap_center_text_search",
            candidate: anchorCandidate,
            ok: false,
            note: reason.message,
          });
          if (reason.blocked) break;
        }
      }
    }
  } else if (normalizedAddressCandidates.length) {
    facts.amap.error = { message: AMAP_UNCONFIGURED_REASON, blocked: false };
  }

  let osm = osmEvidence && typeof osmEvidence === "object" ? osmEvidence : null;
  const loadOsmEvidence = async () => {
    if (osm || typeof osmFallback !== "function") return osm;
    try {
      osm = (await osmFallback()) || null;
    } catch (error) {
      facts.attempts.push({
        step: "osm_fallback",
        ok: false,
        note: safeText(error?.message || error, 160),
      });
    }
    return osm;
  };
  if (!center && facts.amap.configured && !facts.amap.blocked) {
    await loadOsmEvidence();
    const osmPin = osm?.center
      && Number.isFinite(Number(osm.center.lat))
      && Number.isFinite(Number(osm.center.lon))
      ? osm.center
      : null;
    if (osmPin) {
      center = {
        lng: Number(osmPin.lon),
        lat: Number(osmPin.lat),
        city: facts.input.city,
        formattedAddress: safeText(osmPin.displayName, 200) || facts.input.addressText,
        level: "osm_pin",
      };
      facts.center = {
        value: {
          lng: center.lng,
          lat: center.lat,
          adcode: null,
          formattedAddress: center.formattedAddress,
          matchedAddressText: facts.input.addressText,
          level: "osm_pin",
        },
        provenance: provenanceOf(
          "osm",
          "nominatim.openstreetmap.org/search",
          osm?.fetchedAt,
        ),
      };
      facts.attempts.push({
        step: "amap_geocode_osm_pin",
        ok: true,
        note: "高德定位过粗，改用公开地图坐标做周边检索",
      });
    }
  }

  // ---- 高德：周边竞品 / 分布 / 配套 ----
  if (center) {
    const categoryRadius = normalizedRadii.at(-1);
    const aroundResults = await Promise.allSettled([
      ...normalizedRadii.map((radius) =>
        client.searchAround({
          lng: center.lng,
          lat: center.lat,
          radius,
          types: AMAP_RESTAURANT_TYPECODE,
          signal,
        }),
      ),
      ...categorySearchKeywords(facts.input.categoryKeyword).slice(0, 2).map((keywords) =>
        client.searchAround({
          lng: center.lng, lat: center.lat, radius: categoryRadius,
          types: AMAP_RESTAURANT_TYPECODE,
          keywords,
          pages: 3,
          signal,
        }),
      ),
    ]);
    const byRadius = [];
    let widest = null;
    aroundResults.slice(0, normalizedRadii.length).forEach((entry, index) => {
      const radius = normalizedRadii[index];
      if (entry.status === "rejected" || entry.value?.unavailable) {
        const reason =
          entry.status === "rejected"
            ? amapErrorSummary(entry.reason)
            : { message: entry.value.reason, blocked: false };
        if (reason.blocked) facts.amap.blocked = true;
        if (!facts.amap.error || reason.blocked) facts.amap.error = reason;
        facts.attempts.push({
          step: `amap_around_${radius}`,
          ok: false,
          note: reason.message,
        });
        missing(
          `competitors.${radius}m`,
          `高德周边搜索（${radius}米）失败：${reason.message}`,
        );
        return;
      }
      const { data, source } = entry.value;
      facts.amap.requestCount += Number(data?.requestCount || 0);
      addSource(source, `周边餐饮POI（${radius}米）`);
      facts.attempts.push({
        step: `amap_around_${radius}`,
        ok: true,
        count: data.count,
        returned: data.returned,
        cached: source.cached === true,
      });
      byRadius.push({
        radius,
        value: {
          count: data.count,
          returned: data.returned,
          truncated: data.truncated === true,
          byCategory: countByCategory(data.pois),
          sameCategoryCount: facts.input.categoryKeyword
            ? data.pois.filter((poi) =>
                matchesCategoryKeyword(poi, facts.input.categoryKeyword),
              ).length
            : null,
        },
        provenance: provenanceOf("amap", source.endpoint, source.fetchedAt, {
          cached: source.cached === true,
        }),
      });
      if (!widest || radius > widest.radius) {
        widest = { radius, pois: data.pois, source, truncated: data.truncated === true };
      }
    });
    if (byRadius.length) {
      facts.amap.ok = true;
      facts.provider = facts.provider || "amap";
      facts.competitors = {
        byRadius,
        typecode: AMAP_RESTAURANT_TYPECODE,
        note: byRadius.some((item) => item.value.truncated)
          ? "部分半径的POI明细按高德分页上限截断（≤75条），count 为高德返回总数；品类/价格/评分分布仅基于已返回明细"
          : null,
      };
    }
    let categoryBatch = null;
    const categoryKeywordsUsed = categorySearchKeywords(facts.input.categoryKeyword).slice(0, 2);
    const categoryEntries = aroundResults.slice(normalizedRadii.length);
    const mergedCategoryPois = [];
    const seenCategoryIds = new Set();
    let categoryCount = 0;
    let categoryTruncated = false;
    let categorySource = null;
    categoryEntries.forEach((categoryEntry, index) => {
      const keywords = categoryKeywordsUsed[index] || facts.input.categoryKeyword;
      if (categoryEntry?.status === "fulfilled" && !categoryEntry.value?.unavailable) {
        const { data, source } = categoryEntry.value;
        facts.amap.requestCount += Number(data?.requestCount || 0);
        addSource(source, `目标品类关键词餐饮POI（${categoryRadius}米·${keywords}）`);
        categoryCount += Number(data.count || 0);
        categoryTruncated = categoryTruncated || data.truncated === true;
        categorySource = categorySource || source;
        for (const poi of data.pois || []) {
          const id = String(poi?.id || poi?.name || "");
          if (!id || seenCategoryIds.has(id)) continue;
          seenCategoryIds.add(id);
          mergedCategoryPois.push(poi);
        }
        facts.attempts.push({
          step: "amap_category_around",
          ok: true,
          radius: categoryRadius,
          keywords,
          count: data.count,
          returned: data.returned,
        });
      } else if (categoryEntry) {
        const reason = categoryEntry.status === "rejected" ? amapErrorSummary(categoryEntry.reason) : { message: categoryEntry.value?.reason || "品类检索未获取" };
        if (reason.blocked) facts.amap.blocked = true;
        facts.attempts.push({ step: "amap_category_around", ok: false, keywords, note: reason.message });
      }
    });
    if (mergedCategoryPois.length && categorySource) {
      categoryBatch = {
        radius: categoryRadius,
        pois: mergedCategoryPois,
        source: categorySource,
        count: categoryCount,
        truncated: categoryTruncated,
      };
    }
    const aroundMatched = mergedCategoryPois.filter((poi) =>
      matchesCategoryKeyword(poi, facts.input.categoryKeyword),
    );
    if (facts.input.categoryKeyword && !aroundMatched.length) {
      const recovered = await recoverSameCategoryByTextSearch({
        client,
        city: facts.input.city || center.city || center.province,
        place: facts.input.addressText || center.formattedAddress,
        keyword: facts.input.categoryKeyword,
        signal,
      });
      facts.attempts.push(...(recovered.attempts || []));
      if (recovered.source) addSource(recovered.source, `目标品类关键字补采（${facts.input.categoryKeyword}）`);
      for (const poi of recovered.pois || []) {
        const id = String(poi?.id || poi?.name || "");
        if (!id || seenCategoryIds.has(id)) continue;
        if (!matchesCategoryKeyword(poi, facts.input.categoryKeyword)) continue;
        seenCategoryIds.add(id);
        mergedCategoryPois.push(poi);
      }
      if (mergedCategoryPois.length && (recovered.source || categorySource)) {
        categoryBatch = {
          radius: categoryRadius,
          pois: mergedCategoryPois,
          source: recovered.source || categorySource,
          count: (categoryCount || 0) + Number(recovered.count || recovered.pois.length || 0),
          truncated: categoryTruncated || recovered.truncated === true,
        };
      }
    }
    const topBatch = categoryBatch || widest;
    if (topBatch) {
      const sameCategory = topBatch.pois.filter((poi) =>
        matchesCategoryKeyword(poi, facts.input.categoryKeyword),
      );
      const referenceBatch = sameCategory.length ? topBatch : (widest || topBatch);
      const ranked = rankTradeAreaPois(
        sameCategory.length ? sameCategory : referenceBatch.pois.filter(poi => !/宠物|宠粮|猫粮|狗粮|犬粮/iu.test(`${poi.name} ${poi.type}`)),
        competitorLimit,
        referenceBatch.radius,
      )
        .map((poi) => ({
          id: poi.id,
          name: poi.name,
          coords: poi.coords,
          distance: poi.distance,
          address: poi.address,
          type: poi.type,
          cost: poi.biz_ext?.cost ?? null,
          rating: poi.biz_ext?.rating ?? null,
          categoryEvidence: sameCategory.length ? "name_or_type" : "unverified_nearby",
        }));
      facts.topCompetitors = {
        radius: referenceBatch.radius,
        matchedCategoryKeyword: Boolean(
          facts.input.categoryKeyword && sameCategory.length,
        ),
        value: ranked,
        coverage: {
          keywordQuery: categoryBatch ? categoryKeywordsUsed.join("、") : null,
          providerCount: categoryBatch?.count ?? null,
          returned: topBatch.pois.length,
          matchedInReturned: sameCategory.length,
          truncated: topBatch.truncated === true,
          note: "品类匹配基于店名/类别；兰州拉面等别名计入牛肉面；总量是上游检索命中数，不代表全部已打开菜单核验",
        },
        note: facts.input.categoryKeyword && !sameCategory.length
          ? `本次返回明细中未匹配到“${facts.input.categoryKeyword}”；以下仅为周边餐饮参考，不是同品类竞品清单`
          : null,
        provenance: provenanceOf("amap", referenceBatch.source.endpoint, referenceBatch.source.fetchedAt, {
          cached: referenceBatch.source.cached === true,
          ...(categoryBatch && sameCategory.length ? { keywords: categoryKeywordsUsed.join("、") } : {}),
        }),
      };
      if (!ranked.length) missing("topCompetitors", `高德在${referenceBatch.radius}米内未返回餐饮POI`);
      else if (facts.input.categoryKeyword && !sameCategory.length)
        missing("topCompetitors.sameCategory", `本次返回明细中未匹配到“${facts.input.categoryKeyword}”，不能用其他餐饮凑足同品类竞品`);

      // FR-4.2：相似品类（抢同一预算、同一场景的替代品类）各补一次周边关键词检索。
      if (relatedCategoryList.length) {
        const knownIds = new Set(ranked.map((poi) => String(poi.id || poi.name)));
        const relatedResults = await Promise.allSettled(
          relatedCategoryList.map((keywords) =>
            client.searchAround({
              lng: center.lng,
              lat: center.lat,
              radius: categoryRadius,
              types: AMAP_RESTAURANT_TYPECODE,
              keywords,
              pages: 1,
              signal,
            }),
          ),
        );
        const groups = [];
        let relatedSource = null;
        relatedResults.forEach((entry, index) => {
          if (entry.status !== "fulfilled" || entry.value?.unavailable || !entry.value?.data) return;
          relatedSource = relatedSource || entry.value.source;
          const rows = (entry.value.data.pois || [])
            .filter((poi) => !knownIds.has(String(poi.id || poi.name)))
            .sort((a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY))
            .slice(0, RELATED_CATEGORY_ROWS)
            .map((poi) => {
              knownIds.add(String(poi.id || poi.name));
              return {
                id: poi.id,
                name: poi.name,
                coords: poi.coords,
                distance: poi.distance,
                address: poi.address,
                type: poi.type,
                cost: poi.biz_ext?.cost ?? null,
                rating: poi.biz_ext?.rating ?? null,
              };
            });
          if (rows.length) groups.push({ category: relatedCategoryList[index], value: rows });
        });
        facts.relatedCompetitors = relatedSource && groups.length
          ? {
              radius: categoryRadius,
              categories: groups,
              note: "相似品类按店名关键词检索，作为替代竞争参考，未逐家核验菜单",
              provenance: provenanceOf("amap", relatedSource.endpoint, relatedSource.fetchedAt, {
                cached: relatedSource.cached === true,
                keywords: relatedCategoryList.join("、"),
              }),
            }
          : null;
      }

    }
    if (widest) {
      const costs = widest.pois.map((poi) => poi.biz_ext?.cost);
      const costDistribution = numericDistribution(costs, COST_BUCKETS);
      const bandExamples = costDistribution
        ? Object.fromEntries(
            COST_BUCKETS.map(([label, min, max]) => [
              label,
              widest.pois
                .filter((poi) => {
                  const raw = poi?.biz_ext?.cost;
                  if (raw == null || raw === "") return false;
                  const num = Number(raw);
                  return Number.isFinite(num) && num >= min && num < max && Boolean(poi?.name);
                })
                .sort(
                  (a, b) =>
                    (a.distance ?? Number.POSITIVE_INFINITY) -
                    (b.distance ?? Number.POSITIVE_INFINITY),
                )
                .slice(0, 4)
                .map((poi) => ({
                  name: poi.name,
                  cost: Number(poi.biz_ext.cost),
                  distance: poi.distance ?? null,
                })),
            ]),
          )
        : null;
      facts.priceDistribution = {
        radius: widest.radius,
        value: costDistribution,
        ...(bandExamples ? { bandExamples } : {}),
        note: costDistribution
          ? `周边全部餐饮返回明细中 ${costDistribution.sampleSize}/${widest.pois.length} 个POI带人均字段，非目标品类总体`
          : "高德未提供人均（周边POI的 biz_ext.cost 为空）",
        provenance: provenanceOf("amap", widest.source.endpoint, widest.source.fetchedAt),
      };
      if (!costDistribution) missing("priceDistribution", "高德未提供人均，未获取");

      const ratings = widest.pois.map((poi) => poi.biz_ext?.rating);
      const ratingDistribution = numericDistribution(ratings, RATING_BUCKETS);
      facts.ratingDistribution = {
        radius: widest.radius,
        value: ratingDistribution,
        note: ratingDistribution
          ? `周边全部餐饮返回明细中 ${ratingDistribution.sampleSize}/${widest.pois.length} 个POI带评分字段，非目标品类总体`
          : "高德未提供评分（周边POI的 biz_ext.rating 为空）",
        provenance: provenanceOf("amap", widest.source.endpoint, widest.source.fetchedAt),
      };
      if (!ratingDistribution) missing("ratingDistribution", "高德未提供评分，未获取");
    }

    const facilityEntries = Object.entries(AMAP_FACILITY_TYPECODES);
    const facilityResults = await Promise.allSettled(
      facilityEntries.map(([, typecode]) =>
        client.searchAround({
          lng: center.lng,
          lat: center.lat,
          radius: TRADE_AREA_FACILITY_RADIUS,
          types: typecode,
          pages: 1,
          signal,
        }),
      ),
    );
    const facilityValue = {};
    const facilityFailures = [];
    let facilitySource = null;
    facilityResults.forEach((entry, index) => {
      const [label, typecode] = facilityEntries[index];
      if (entry.status === "rejected" || entry.value?.unavailable) {
        const reason =
          entry.status === "rejected"
            ? amapErrorSummary(entry.reason)
            : { message: entry.value.reason, blocked: false };
        if (reason.blocked) facts.amap.blocked = true;
        facilityValue[label] = null;
        facilityFailures.push(`${label}：${reason.message}`);
        return;
      }
      const { data, source } = entry.value;
      facts.amap.requestCount += Number(data?.requestCount || 0);
      if (!facilitySource) facilitySource = source;
      const matched = data.pois.filter((poi) => facilityMatches(poi, typecode)).length;
      facilityValue[label] = Number.isFinite(data.count) ? data.count : matched;
    });
    if (facilitySource) addSource(facilitySource, `周边配套POI（${TRADE_AREA_FACILITY_RADIUS}米）`);
    facts.facilities = {
      radius: TRADE_AREA_FACILITY_RADIUS,
      typecodes: { ...AMAP_FACILITY_TYPECODES },
      value: facilityValue,
      note: facilityFailures.length ? `部分配套类型未获取：${facilityFailures.join("；")}` : null,
      provenance: facilitySource
        ? provenanceOf("amap", facilitySource.endpoint, facilitySource.fetchedAt)
        : provenanceOf("amap", "/v3/place/around", null, { failed: true }),
    };
    for (const failure of facilityFailures) missing("facilities", `周边配套部分类型未获取：${failure}`);
  }

  // ---- OSM 证据：回落中心/计数，并始终补充路网等时圈 ----
  await loadOsmEvidence();
  const osmCenter =
    osm?.center &&
    Number.isFinite(Number(osm.center.lat)) &&
    Number.isFinite(Number(osm.center.lon))
      ? osm.center
      : null;
  if (!center) {
    if (osmCenter) {
      facts.provider = "osm";
      facts.center = {
        value: {
          lng: Number(osmCenter.lon),
          lat: Number(osmCenter.lat),
          adcode: null,
          formattedAddress: safeText(osmCenter.displayName, 200) || null,
        },
        provenance: provenanceOf(
          "osm",
          "nominatim.openstreetmap.org/search",
          osm.fetchedAt,
        ),
      };
      const counts = osm.counts && typeof osm.counts === "object" ? osm.counts : {};
      const osmRadius = Number(osm.radiusMeters) || 1500;
      const poiEndpoint =
        osm.poiSource === "Overpass"
          ? "overpass-api.de/api/interpreter"
          : "nominatim.openstreetmap.org/search";
      facts.competitors = {
        byRadius: [
          {
            radius: osmRadius,
            value: {
              count: Number(counts["餐饮"]) || 0,
              returned: Number(counts["餐饮"]) || 0,
              truncated: null,
              byCategory: null,
              sameCategoryCount: null,
            },
            provenance: provenanceOf("osm", poiEndpoint, osm.fetchedAt),
          },
        ],
        typecode: null,
        note: "OpenStreetMap 已命名餐饮POI计数；OSM 覆盖不完整，不含品类细分、人均与评分",
      };
      facts.facilities = {
        radius: osmRadius,
        typecodes: null,
        value: Object.fromEntries(
          Object.entries(OSM_FACILITY_LABELS).map(([kind, label]) => [
            label,
            Number(counts[kind]) || 0,
          ]),
        ),
        note: "OpenStreetMap 分类计数，覆盖不完整",
        provenance: provenanceOf("osm", poiEndpoint, osm.fetchedAt),
      };
      facts.attempts.push({ step: "osm_fallback", ok: true });
      const why = facts.amap.configured
        ? `高德未命中或调用失败（${facts.amap.error?.message || "未知原因"}）`
        : "高德地图未配置";
      missing("topCompetitors", `${why}；OSM 证据仅提供分类计数，竞品名录未获取`);
      missing("priceDistribution", `${why}；OSM 不提供人均消费，未获取`);
      missing("ratingDistribution", `${why}；OSM 不提供评分，未获取`);
      missing(
        "competitors.byCategory",
        `${why}；OSM 不提供餐饮品类细分，未获取`,
      );
    } else {
      const why = !normalizedAddressCandidates.length
        ? "任务中未识别到可地理编码的地址"
        : facts.amap.configured
          ? `高德未命中或调用失败（${facts.amap.error?.message || "未知原因"}），且无 OSM 定位证据`
          : "高德地图未配置，且无 OSM 定位证据";
      missing("center", why);
      missing("competitors", `${why}；竞品数量未获取`);
      missing("topCompetitors", `${why}；竞品名录未获取`);
      missing("priceDistribution", `${why}；人均分布未获取`);
      missing("ratingDistribution", `${why}；评分分布未获取`);
      missing("facilities", `${why}；周边配套未获取`);
    }
  }

  if (osm?.isochroneComplete === true && Array.isArray(osm.isochrones) && osm.isochrones.length) {
    facts.isochrones = {
      value: {
        provider: osm.isochroneProvider || null,
        modes: osm.isochroneModes || [],
        minutes: osm.isochroneMinutes || [],
        modeMinutes: osm.isochroneModeMinutes || null,
        zones: osm.isochrones.map((zone) => ({
          mode: zone.mode,
          minutes: zone.minutes,
        })),
      },
      provenance: provenanceOf("osm", osm.isochroneSource || null, osm.fetchedAt, {
        routing: "Valhalla (OpenStreetMap routing graph)",
      }),
    };
    facts.sources.push({
      label: "步行/骑行/驾车/公交等时圈",
      provider: "osm",
      endpoint: osm.isochroneSource || null,
      fetchedAt: osm.fetchedAt || null,
      cached: false,
    });
  } else if (requireIsochrones || osm?.isochroneRequired === true) {
    missing(
      "isochrones",
      osm?.isochroneError
        ? `路网等时圈未完成：${osm.isochroneError}`
        : "路网等时圈未获取（OSM 定位链未返回等时圈）",
    );
  }

  if (facts.input.categoryKeyword && facts.topCompetitors?.matchedCategoryKeyword !== true) {
    const recoveredOsm = namedPlacesMatchingCategory(osm?.restaurants, facts.input.categoryKeyword)
      .map((poi) => ({ ...poi, categoryEvidence: "osm_name_or_cuisine" }));
    if (recoveredOsm.length) {
      facts.topCompetitors = {
        radius: facts.topCompetitors?.radius || facts.input.radii.at(-1) || 1500,
        matchedCategoryKeyword: true,
        value: recoveredOsm.slice(0, TRADE_AREA_TOP_N),
        coverage: {
          ...(facts.topCompetitors?.coverage || {}),
          recoveredFrom: "osm",
          note: `高德周边未命中“${facts.input.categoryKeyword}”，已用公开地图店名/菜系补采`,
        },
        note: null,
        provenance: provenanceOf("osm", osm?.poiSource || "openstreetmap.org", osm?.fetchedAt),
      };
      addSource(
        { provider: "osm", endpoint: osm?.poiSource || "openstreetmap.org", fetchedAt: osm?.fetchedAt },
        `目标品类公开地图补采（${facts.input.categoryKeyword}）`,
      );
      facts.attempts.push({
        step: "osm_category_name",
        ok: true,
        keywords: facts.input.categoryKeyword,
        returned: recoveredOsm.length,
      });
      facts.missingCriticalFacts = facts.missingCriticalFacts.filter(
        (item) => item.field !== "topCompetitors.sameCategory" && item.field !== "topCompetitors",
      );
    }
  }

  facts.ok = Boolean(facts.center);
  facts.fetchedAt = now().toISOString();
  const budgetState = typeof client.requestBudget === "function" ? client.requestBudget() : null;
  if (budgetState?.limit != null) facts.amap.requestBudget = budgetState;
  const seenSources = new Set();
  facts.sources = facts.sources.filter((source) => {
    const key = `${source.provider}|${source.endpoint}|${source.label}`;
    if (seenSources.has(key)) return false;
    seenSources.add(key);
    return true;
  });
  return facts;
}

function shopNameFromMenuPage(page) {
  const title = String(page?.title || "").trim();
  if (!title) return "";
  const cut = title
    .split(/\s*[-_|·]\s*/u)[0]
    .replace(/[（(].*$/u, "")
    .trim();
  if (cut.length < 2 || cut.length > 24) return "";
  if (/大众点评|美团|饿了么|菜单|推荐|攻略|排行|附近|商圈/u.test(cut)) return "";
  return cut;
}

function isShopMenuUrl(url) {
  return /(?:dianping|meituan|ele\.me|amap)\.com/iu.test(String(url || ""));
}

function pagesForShop(name, pages) {
  const needle = String(name || "").trim();
  if (needle.length < 2) return [];
  return pages.filter((page) => page.text.includes(needle));
}

/**
 * 用已打开的点评/美团/网页正文核对同品类：店名对不上但菜单在卖的补进来，
 * 打开后证明在卖别的品类的剔掉。没有打开过的店名匹配结果保留。
 */
export function applyPublicMenuEvidence(facts, sources, keyword) {
  if (!facts?.topCompetitors || !keyword) return facts;
  const profile = profileForKeyword(keyword) || resolveTradeAreaCategory(keyword);
  const include = profile?.include || new RegExp(escapeRegExp(keyword), "iu");
  const exclude = profile?.exclude || PET_FOOD_RE;
  const pages = (Array.isArray(sources) ? sources : [])
    .map((source) => ({
      title: String(source?.title || ""),
      url: String(source?.url || ""),
      text: `${source?.title || ""} ${source?.snippet || ""} ${source?.body || ""}`,
    }))
    .filter((page) => page.text.trim());

  const pageVerdict = (poi) => {
    const related = pagesForShop(poi?.name, pages);
    if (!related.length) return null;
    const blob = related.map((page) => page.text).join("\n");
    const cleaned = blob.replace(/(?:没有|不含|不卖|不是|非)[^。；\n]{0,16}/gu, " ");
    const sellsTarget = include.test(cleaned);
    const sellsOther = exclude.test(blob);
    if (sellsTarget) return true;
    if (sellsOther) return false;
    return null;
  };

  const verified = [];
  const rejected = [];
  const seen = new Set();
  const remember = (poi) => {
    const key = String(poi?.id || poi?.name || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  for (const poi of facts.topCompetitors.value || []) {
    const nameMatch = matchesCategoryKeyword(poi, keyword);
    const menuMatch = pageVerdict(poi);
    if (menuMatch === false) {
      if (remember(poi)) rejected.push({ ...poi, categoryEvidence: "page_different_category" });
      continue;
    }
    if (nameMatch || menuMatch === true) {
      if (remember(poi)) {
        verified.push({
          ...poi,
          categoryEvidence: menuMatch === true ? "page_menu" : "name_or_type",
        });
      }
    }
  }

  for (const page of pages) {
    const menuPage = isShopMenuUrl(page.url);
    const titleHasCategory = include.test(page.title) && !exclude.test(page.title);
    if (!(menuPage || titleHasCategory) || !include.test(page.text)) continue;
    const name = shopNameFromMenuPage(page);
    if (!name || seen.has(name)) continue;
    if (exclude.test(name) && !include.test(name)) continue;
    if (!include.test(`${name} ${page.text}`)) continue;
    seen.add(name);
    verified.push({
      id: null,
      name,
      coords: null,
      distance: null,
      address: null,
      type: "公开商户页",
      cost: null,
      rating: null,
      categoryEvidence: "page_menu",
      sourceUrl: page.url.slice(0, 300),
    });
  }

  const ranked = verified.slice(0, TRADE_AREA_TOP_N);
  facts.topCompetitors = {
    ...facts.topCompetitors,
    matchedCategoryKeyword: ranked.length > 0,
    value: ranked,
    coverage: {
      ...(facts.topCompetitors.coverage || {}),
      pageVerified: ranked.filter((item) => item.categoryEvidence === "page_menu").length,
      pageRejected: rejected.length,
      note: "同品类以店名/类别或已打开的商户页菜单核验；页面证明在卖其他品类的已剔除，不把未打开的面馆都算成目标品类",
    },
    rejectedDifferentCategory: rejected.slice(0, 10).map((item) => ({
      name: item.name,
      reason: "已打开的商户页未体现目标品类",
    })),
    note: ranked.length
      ? facts.topCompetitors.note
      : `已打开的商户页与店名均未核验到“${keyword}”；不得把其他餐饮凑进同品类清单`,
  };
  if (keyword && !ranked.length) {
    const existing = (facts.missingCriticalFacts || []).some((item) => item.field === "topCompetitors.sameCategory");
    if (!existing) {
      (facts.missingCriticalFacts ||= []).push({
        field: "topCompetitors.sameCategory",
        reason: `店名与已打开商户页均未核验到“${keyword}”，不能用其他餐饮凑足同品类竞品`,
      });
    }
  }
  return facts;
}

/** 将本次真实高德响应转换为现有地图来源快照；API 路径和 Key 不作为分享链接。 */
export function tradeAreaFactsLocationEvidence(facts, { previous = null, requireIsochrones = false } = {}) {
  const validProvenance = (value, endpoint) => value?.provider === "amap"
    && value.failed !== true && value.endpoint === endpoint
    && typeof value.fetchedAt === "string" && Number.isFinite(Date.parse(value.fetchedAt));
  const validCoords = (value) => value && value.lng != null && value.lat != null
    && Number.isFinite(Number(value.lng)) && Math.abs(Number(value.lng)) <= 180
    && Number.isFinite(Number(value.lat)) && Math.abs(Number(value.lat)) <= 90;
  if (facts?.ok !== true || facts.provider !== "amap" || facts.amap?.ok !== true
    || facts.amap?.configured !== true || !validCoords(facts.center?.value)
    || (!validProvenance(facts.center?.provenance, "/v3/geocode/geo")
      && !validProvenance(facts.center?.provenance, "/v3/place/text"))) return null;
  const center = facts.center.value;
  const centerTitle = safeText(center.matchedAddressText || facts.input?.addressText || center.formattedAddress, 200);
  const markerUrl = (coords, name, id) => {
    const url = new URL("https://uri.amap.com/marker");
    url.searchParams.set("position", `${Number(coords.lng)},${Number(coords.lat)}`);
    url.searchParams.set("name", safeText(name, 200));
    url.searchParams.set("coordinate", "gaode");
    if (id) url.searchParams.set("id", safeText(id, 40));
    return url.href;
  };
  const results = [{
    title: `高德地图定位·${centerTitle}`,
    url: markerUrl(center, centerTitle),
    snippet: `高德 API 核验中心=${centerTitle}；地址=${safeText(center.formattedAddress, 200)}；GCJ-02坐标 ${center.lng}, ${center.lat}。此定位不代表路网距离或等时圈已获取。周边餐饮条目字段口径：名称/类别/地址/直线距离为接口返回，部分门店带人均与评分；月销量、营业时间与步行时长不在本接口字段内，需平台页或现场补采。`,
    fetchedAt: facts.center.provenance.fetchedAt,
    evidenceKind: "structured_location_center",
    provenance: facts.center.provenance,
  }];
  if (validProvenance(facts.topCompetitors?.provenance, "/v3/place/around")) {
    for (const poi of facts.topCompetitors.value || []) {
      if (!safeText(poi.name, 120) || !validCoords(poi.coords)) continue;
      const distance = poi.distance != null && Number.isFinite(Number(poi.distance)) && Number(poi.distance) >= 0
        ? `${Number(poi.distance)}米（高德周边搜索distance字段，非步行路网距离）` : "接口未返回";
      // 只写本次真实返回的字段；接口不提供的字段（月销量/营业时间/步行时长）
      // 统一在中心条目与“数据来源与时效”里说明一次，不在每家门店后面重复。
      const optionalFields = [
        poi.cost != null && poi.cost !== "" ? `人均=${safeText(poi.cost, 20)}` : "",
        poi.rating != null && poi.rating !== "" ? `评分=${safeText(poi.rating, 20)}` : "",
      ].filter(Boolean);
      results.push({
        title: `高德周边餐饮·${safeText(poi.name, 120)}`,
        url: markerUrl(poi.coords, poi.name, poi.id),
        snippet: `地图中心=${centerTitle}；餐饮门店=${safeText(poi.name, 120)}；类别=${safeText(poi.type, 120)}；地址=${safeText(poi.address, 200)}；距中心=${distance}；${facts.topCompetitors.matchedCategoryKeyword ? (poi.categoryEvidence === "page_menu" ? "商户页菜单已核验为目标同品类" : "店名/类别判定为同品类，菜单以打开的商户页为准") : "周边餐饮参考，未核验为目标同品类竞品"}${optionalFields.length ? `。${optionalFields.join("；")}` : ""}。`,
        fetchedAt: facts.topCompetitors.provenance.fetchedAt,
        evidenceKind: "structured_location_restaurant_poi",
        provenance: facts.topCompetitors.provenance,
      });
    }
  }
  if (validProvenance(facts.relatedCompetitors?.provenance, "/v3/place/around")) {
    for (const group of facts.relatedCompetitors.categories || []) {
      for (const poi of group.value || []) {
        if (!safeText(poi.name, 120) || !validCoords(poi.coords)) continue;
        const optionalFields = [
          poi.cost != null && poi.cost !== "" ? `人均=${safeText(poi.cost, 20)}` : "",
          poi.rating != null && poi.rating !== "" ? `评分=${safeText(poi.rating, 20)}` : "",
        ].filter(Boolean);
        results.push({
          title: `高德相似品类·${safeText(group.category, 20)}·${safeText(poi.name, 120)}`,
          url: markerUrl(poi.coords, poi.name, poi.id),
          snippet: `地图中心=${centerTitle}；相似品类=${safeText(group.category, 20)}；餐饮门店=${safeText(poi.name, 120)}；类别=${safeText(poi.type, 120)}；地址=${safeText(poi.address, 200)}；距中心=${poi.distance != null ? `${Number(poi.distance)}米（直线）` : "接口未返回"}；替代竞争参考，未核验菜单${optionalFields.length ? `。${optionalFields.join("；")}` : ""}。`,
          fetchedAt: facts.relatedCompetitors.provenance.fetchedAt,
          evidenceKind: "structured_location_restaurant_poi",
          provenance: facts.relatedCompetitors.provenance,
        });
      }
    }
  }
  const routeComplete = previous?.evidence?.isochroneComplete === true;
  return {
    kind: "location_intelligence",
    attempted: true,
    ok: !requireIsochrones || routeComplete,
    provider: routeComplete ? "高德地图 + OpenStreetMap路网" : "高德地图",
    results: [...results, ...(previous?.results || [])],
    note: requireIsochrones && !routeComplete ? "高德中心与餐饮POI已获取，明确要求的真实路网等时圈尚未取得" : null,
    evidence: {
      ...(previous?.evidence || {}),
      schemaVersion: "nanowork.location-intelligence/2",
      center: { lat: Number(center.lat), lon: Number(center.lng), displayName: centerTitle, coordinateSystem: "GCJ-02" },
      // 旧路网证据保留原中心，不将其坐标悄悄改成高德坐标。
      ...(previous?.evidence?.center ? { routingCenter: previous.evidence.center } : {}),
      poiSource: "高德地图 Web 服务 API",
      namedPoiCount: results.length - 1,
      radiusMeters: facts.topCompetitors?.radius || Math.max(...(facts.input?.radii || [1500])),
      fetchedAt: facts.fetchedAt,
      isochroneRequired: Boolean(requireIsochrones),
      isochroneComplete: routeComplete,
      amap: { configured: true, ok: true },
    },
  };
}

/** 供 prompt 使用的紧凑摘要（去掉 attempts，控制体积）。 */
export function tradeAreaFactsPromptSummary(facts, { maxChars = 6000 } = {}) {
  if (!facts || typeof facts !== "object") return "";
  const compact = {
    schemaVersion: facts.schemaVersion,
    provider: facts.provider,
    input: facts.input,
    center: facts.center,
    // 配套与证据缺口优先保留；不能被前面的十家竞品长地址截掉。
    facilities: facts.facilities,
    missingCriticalFacts: facts.missingCriticalFacts,
    competitors: facts.competitors,
    topCompetitors: facts.topCompetitors
      ? {
          ...facts.topCompetitors,
          value: (facts.topCompetitors.value || []).slice(0, TRADE_AREA_TOP_N_MAX),
        }
      : null,
    ...(facts.relatedCompetitors ? { relatedCompetitors: facts.relatedCompetitors } : {}),
    priceDistribution: facts.priceDistribution,
    ratingDistribution: facts.ratingDistribution,
    isochrones: facts.isochrones,
    amap: {
      configured: facts.amap?.configured === true,
      ok: facts.amap?.ok === true,
      blocked: facts.amap?.blocked === true,
      error: facts.amap?.error?.message || null,
    },
    sources: facts.sources,
    fetchedAt: facts.fetchedAt,
  };
  const budget = Math.max(1000, Number(maxChars) || 6000);
  if (JSON.stringify(compact).length <= budget) return JSON.stringify(compact);
  compact.summaryOmissions = [];
  // 按完整条目缩减，而不是截出半段 JSON；完整证据仍保留在任务快照。
  const rows = compact.topCompetitors?.value;
  if (rows?.length) {
    compact.topCompetitors = { ...compact.topCompetitors, value: [...rows] };
    while (compact.topCompetitors.value.length && JSON.stringify(compact).length > budget)
      compact.topCompetitors.value.pop();
    if (compact.topCompetitors.value.length < rows.length)
      compact.summaryOmissions.push("部分竞品明细未放入摘要，不代表未获取；完整记录见任务证据");
  }
  for (const field of ["sources", "relatedCompetitors", "isochrones", "competitors", "topCompetitors", "priceDistribution", "ratingDistribution"]) {
    if (JSON.stringify(compact).length <= budget) break;
    if (compact[field] != null) {
      delete compact[field];
      compact.summaryOmissions.push(`${field}明细略，不能据此认定该数据未获取`);
    }
  }
  // 核心定位、配套、来源与缺口宁可略超预算，也不静默删除或截断。
  return JSON.stringify(compact);
}

const PROVIDER_LABELS = Object.freeze({
  amap: "高德地图 Web 服务 API",
  osm: "OpenStreetMap（Nominatim/Overpass/Valhalla）",
  regex: "任务文本解析",
});

function provenanceLabel(provenance) {
  if (!provenance?.provider) return "—";
  const provider = PROVIDER_LABELS[provenance.provider] || provenance.provider;
  const endpoint = provenance.endpoint
    ? `（${String(provenance.endpoint).replace(/^https?:\/\//u, "").slice(0, 80)}）`
    : "";
  return `${provider}${endpoint}${provenance.cached ? "，缓存命中" : ""}`;
}

function fetchedAtLabel(value) {
  const text = safeText(value, 40);
  return text ? text.replace("T", " ").replace(/\.\d+Z$/u, "Z") : "—";
}

export const TRADE_AREA_PROVENANCE_HEADING = "## 数据来源与时效";

/**
 * 交付报告尾部的“数据来源与时效”一节。措辞刻意避开输出契约里的
 * “据/来自…公开/地图/平台”断言模式，防止在无来源快照时被硬交付门误判。
 */
export function renderTradeAreaProvenanceMarkdown(facts) {
  if (!facts || typeof facts !== "object") return "";
  const rows = [];
  const missingFor = (field) =>
    (facts.missingCriticalFacts || []).find(
      (item) => item.field === field || String(item.field).startsWith(`${field}.`),
    );
  const row = (label, node, field) => {
    const gap = missingFor(field);
    if (node?.value != null && (!Array.isArray(node.value) || node.value.length)) {
      const note = node.note ? `已获取；${node.note}` : "已获取";
      rows.push(`| ${label} | ${provenanceLabel(node.provenance)} | ${fetchedAtLabel(node.provenance?.fetchedAt)} | ${note} |`);
    } else {
      rows.push(`| ${label} | — | — | 待补采：${gap?.reason || node?.note || "本次未取得"}；补采方式见“待补数据与现场核实清单” |`);
    }
  };
  row("商圈中心定位", facts.center, "center");
  if (facts.competitors?.byRadius?.length) {
    for (const item of facts.competitors.byRadius) {
      row(`周边餐饮竞品（${item.radius}米）`, { ...item, note: item.value?.truncated ? "明细按分页上限截断" : null }, `competitors.${item.radius}m`);
    }
  } else {
    row("周边餐饮竞品", null, "competitors");
  }
  row(facts.topCompetitors?.matchedCategoryKeyword ? "同品类竞品 Top 10" : "周边餐饮参考 Top 10", facts.topCompetitors, "topCompetitors");
  row("人均消费分布", facts.priceDistribution, "priceDistribution");
  row("评分分布", facts.ratingDistribution, "ratingDistribution");
  row("周边配套计数", facts.facilities, "facilities");
  row("步行/骑行/驾车/公交等时圈", facts.isochrones, "isochrones");

  const statement =
    facts.provider === "amap"
      ? `本报告商圈数字由高德地图 Web 服务 API 实时抓取（抓取时间 ${fetchedAtLabel(facts.fetchedAt)}）；${facts.isochrones?.value?.zones?.length ? "已取得的等时圈由 OpenStreetMap 路网计算" : "本次没有取得路网等时圈"}；标注“待补采”的项目本次没有取得，报告不做推断，已列入现场核实清单。`
      : facts.provider === "osm"
        ? "本报告未接入高德实时数据；商圈数字仅依赖 OpenStreetMap 与公开网页检索结果，仅供参考，标注“待补采”的项目本次没有取得，已列入现场核实清单。"
        : "本报告未接入高德实时数据；商圈数字仅依赖公开网页检索结果，仅供参考，标注“待补采”的项目本次没有取得，已列入现场核实清单。";
  const amapLine =
    facts.amap?.blocked
      ? `- 高德通道状态：受阻（${facts.amap?.error?.message || "凭证或配额问题"}），请管理员在接口管理中重新测试连接。`
      : facts.amap?.configured
        ? facts.amap?.ok
          ? "- 高德通道状态：已调用成功。"
          : `- 高德通道状态：已配置但本次未成功（${facts.amap?.error?.message || "未命中"}）。`
        : "- 高德通道状态：未配置（AMAP_WEB_KEY 为空）。";
  return [
    TRADE_AREA_PROVENANCE_HEADING,
    "",
    "| 项目 | 来源 | 抓取时间 | 状态 |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    statement,
    amapLine,
  ].join("\n");
}

const TRADE_AREA_PROVENANCE_HEADING_PATTERN = /^#{1,6}\s*数据来源与时效/mu;

/** 报告是否已含“数据来源与时效”一节（任意级别标题）。 */
export function hasTradeAreaProvenanceSection(markdown) {
  return TRADE_AREA_PROVENANCE_HEADING_PATTERN.test(String(markdown || ""));
}

/**
 * 若报告缺少“数据来源与时效”一节则追加；已存在时原样返回。
 * 注意：派活主链路的正文必须与供应商响应逐字节一致（哈希反造假门），
 * 本函数只供导出/展示层使用，不得用于改写入库正文。
 */
export function ensureTradeAreaProvenanceSection(markdown, facts) {
  const text = String(markdown || "");
  if (!facts || typeof facts !== "object") return text;
  if (hasTradeAreaProvenanceSection(text)) return text;
  const section = renderTradeAreaProvenanceMarkdown(facts);
  if (!section) return text;
  return `${text.trimEnd()}\n\n${section}\n`;
}

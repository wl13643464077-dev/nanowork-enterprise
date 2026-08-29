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

const LOCATION_SUFFIX =
  "(?:广场|购物中心|商场|商业街|步行街|街道|大道|路|街|站|社区|园区|大厦|写字楼|医院|学校|公园)";
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

export function locationQueryCandidates(value) {
  const text = safeText(value, 600);
  if (!text) return [];
  const candidates = [];
  const cities = CITY_NAMES.filter((city) => text.includes(city));
  const locationFragments = [];
  const suffixPattern = new RegExp(
    `[\\p{Script=Han}A-Za-z0-9·-]{2,32}?${LOCATION_SUFFIX}`,
    "gu",
  );
  for (const match of text.matchAll(suffixPattern))
    locationFragments.push(match[0]);
  // 短派活经常写成“城市 + 菜品 + 商场”，例如“太原毛血旺 吾悦广场”。
  // 菜品不是地点。先把城市与显式场所片段重新组合，避免 Nominatim 把
  // “太原毛血旺”命中杭州同名餐厅后，整条商圈链都在错误城市执行。
  for (const city of cities) {
    for (const fragment of locationFragments) {
      const place = fragment.replace(
        new RegExp(`^(?:${CITY_NAMES.join("|")})`, "u"),
        "",
      );
      if (place && !place.includes(city)) candidates.push(`${city}${place}`);
    }
  }
  const cityPattern = new RegExp(
    `(?:${CITY_NAMES.join("|")})[\\p{Script=Han}A-Za-z0-9·-]{1,28}`,
    "gu",
  );
  for (const match of text.matchAll(cityPattern)) {
    const candidate =
      match[0].match(
        new RegExp(
          `^[\\p{Script=Han}A-Za-z0-9·-]{2,32}?${LOCATION_SUFFIX}`,
          "u",
        ),
      )?.[0] || match[0];
    candidates.push(candidate);
  }
  candidates.push(...locationFragments);
  for (const token of text.split(/[｜|,，。；;:\s/]+/u)) {
    if (new RegExp(`${LOCATION_SUFFIX}$`, "u").test(token))
      candidates.push(token);
  }
  // 完整短标题作为最后兜底；Nominatim找不到时会继续尝试上面的地点片段。
  if (text.length <= 60) candidates.push(text);
  return unique(candidates)
    .sort((a, b) => {
      const aCity = CITY_NAMES.some((city) => a.includes(city)) ? 1 : 0;
      const bCity = CITY_NAMES.some((city) => b.includes(city)) ? 1 : 0;
      const aPlace = new RegExp(`${LOCATION_SUFFIX}$`, "u").test(a) ? 1 : 0;
      const bPlace = new RegExp(`${LOCATION_SUFFIX}$`, "u").test(b) ? 1 : 0;
      return bCity - aCity || bPlace - aPlace || a.length - b.length;
    })
    .slice(0, 4);
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
    tags.railway === "subway_entrance"
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
    radiusMeters = 1500,
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
  const candidates = locationQueryCandidates(value);
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
      Math.max(300, Math.min(5000, Number(radiusMeters) || 1500)),
      {
        fetchImpl,
        signal,
        timeoutMs: Math.min(Math.max(timeoutMs, 6000), 10000),
      },
    );
  } catch (error) {
    poiError = safeText(error?.message, 160);
    const fallback = await nearbyPoisViaNominatim(lat, lon, radiusMeters, {
      fetchImpl,
      signal,
      timeoutMs,
      fallbackDelayMs: nominatimFallbackDelayMs,
    });
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
      snippet: `地图核验位置：${centerTitle}；坐标 ${lat.toFixed(6)}, ${lon.toFixed(6)}；周边${radiusMeters}米已命名POI分类计数：${
        Object.entries(counts)
          .map(([key, count]) => `${key}${count}`)
          .join("、") || "0"
      }。`,
    },
  ];
  // 这是餐饮数字员工的地点取证链；在结果上限内先保留餐饮POI，
  // 不能让更近的学校/医院把餐厅全部挤出最终证据快照。
  const prioritizedPois = [...pois].sort(
    (a, b) =>
      Number(b.kind === "餐饮") - Number(a.kind === "餐饮") ||
      a.distanceMeters - b.distanceMeters,
  );
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
      radiusMeters,
      namedPoiCount: pois.length,
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

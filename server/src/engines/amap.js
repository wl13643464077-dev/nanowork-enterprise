/**
 * 高德开放平台 Web 服务 API 适配器（地理编码 / 周边搜索 / 关键字搜索 / 行政区）。
 *
 * 设计边界：
 * - 密钥只从服务端环境变量 AMAP_WEB_KEY 读取；未配置时所有调用返回
 *   `{ unavailable: true, reason }`，绝不抛错拖垮派活链。
 * - fetch 可注入（createAmapClient({ fetchImpl }) 或模块级 setFetch），测试零外网。
 * - 每次成功调用返回 `{ data, source: { provider: 'amap', endpoint, fetchedAt, requestId } }`，
 *   供上层逐字段写 provenance；缺失字段一律 null，不补造评分或人均。
 * - 高德 status!=='1' 时把 info/infocode 映射为可读 AmapError；密钥/配额类错误
 *   标记 blocked=true，供就绪矩阵翻成 blocked。
 * - around/text 结果按 (坐标四舍五入3位, radius, types, keywords) 缓存 24h
 *   到全局表 geo_poi_cache，避免演示反复消耗免费配额。
 */

export const AMAP_DEFAULT_BASE_URL = "https://restapi.amap.com";
export const AMAP_DEFAULT_TIMEOUT_MS = 8_000;
// 旧版“全局串行 1.1 秒”的单 QPS 间隔，保留为下限参考与兼容导出。
export const AMAP_REQUEST_INTERVAL_MS = 1_100;
// PRD v2.2 FR-4.3：按 QPS 发放请求令牌（默认 3 QPS，可用 AMAP_QPS 配置 0.5–20）。
// 均匀间隔发放等价于容量为 1 的令牌桶，既提升吞吐，又不会在同一出口 IP 上形成突发。
export const AMAP_DEFAULT_QPS = 3;
export function amapConfiguredQps(env = process.env) {
  const raw = Number(String(env.AMAP_QPS ?? "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return AMAP_DEFAULT_QPS;
  return Math.min(20, Math.max(0.5, raw));
}
export function amapRequestIntervalMs(env = process.env) {
  return Math.ceil(1000 / amapConfiguredQps(env));
}
// 每日调用量提醒：AMAP_DAILY_QUOTA（默认 5000 次/天），达到 80% 视为接近配额。
export const AMAP_DEFAULT_DAILY_QUOTA = 5_000;
export const AMAP_QUOTA_WARN_RATIO = 0.8;
// PRD v2.2 FR-4.3：每个任务分配高德请求预算（默认 ≤25 次，可用 AMAP_TASK_REQUEST_BUDGET 调整）；
// 当日调用接近配额（≥80%）时预算收紧到 AMAP_NEAR_QUOTA_TASK_BUDGET，其余数据优先走 24 小时缓存与公开检索。
export const AMAP_DEFAULT_TASK_REQUEST_BUDGET = 25;
export const AMAP_NEAR_QUOTA_TASK_BUDGET = 8;
// 凭证/配额类告警节流：同一 infocode 30 分钟内只告警一次。
export const AMAP_ALERT_THROTTLE_MS = 30 * 60 * 1000;
export const AMAP_QUEUE_TIMEOUT_MS = 60_000;
export const AMAP_MAX_PAGE_SIZE = 25;
export const AMAP_MAX_PAGES = 3;
export const GEO_POI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 高德 POI 分类码：餐饮服务大类及本项目关心的周边配套。 */
export const AMAP_RESTAURANT_TYPECODE = "050000";
export const AMAP_FACILITY_TYPECODES = Object.freeze({
  商场: "060100",
  写字楼: "120201",
  住宅区: "120300",
  地铁站: "150500",
  学校: "141200",
  医院: "090100",
  公交站: "150700",
});

/**
 * 高德 infocode → 分类。blocked：凭证/配额问题，需要人工处理，就绪矩阵翻 blocked；
 * transient：限流/服务繁忙，可稍后重试；其余归为 request 错误。
 */
const BLOCKING_INFOCODES = Object.freeze({
  10001: "key不正确或已过期",
  10002: "没有权限使用该服务或接口路径错误",
  10003: "访问已超出日访问量（日配额用尽）",
  10005: "IP白名单出错，服务器IP不在白名单内",
  10006: "绑定域名无效",
  10007: "数字签名未通过验证",
  10009: "请求key与绑定平台不符（需 Web服务 类型 Key）",
  10012: "权限不足，服务请求被拒绝",
  10013: "Key已被删除",
  10026: "账号处于被封禁状态",
  10044: "账号维度日调用量超出限制",
  10045: "账号维度海外服务日调用量超出限制",
  40000: "余额耗尽",
  40002: "购买服务已到期",
});
const TRANSIENT_INFOCODES = Object.freeze({
  10004: "单位时间内访问过于频繁",
  10010: "IP访问超限",
  10014: "服务QPS超限",
  10015: "受单机QPS限流限制",
  10016: "服务器负载过高",
  10017: "所请求的资源不可用",
  10019: "服务总QPS超限",
  10020: "Key在该接口的QPS超出限制",
  10021: "同一IP在该服务的QPS超出限制",
  10022: "服务并发或QPS超出限制",
});
const QUOTA_INFOCODES = new Set(["10003", "10044", "10045", "40000", "40002"]);
const RETRYABLE_QPS_INFOCODES = new Set(["10020", "10021", "10022"]);

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("已取消高德请求", "AbortError");
}

function abortableWait(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", cancel); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(abortReason(signal)); };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

/** 同一进程、同一 API origin 的所有 Key/客户端共享启动间隔，避免同出口 IP 的 QPS 冲突。 */
export function createAmapRequestPacer({ intervalMs = AMAP_REQUEST_INTERVAL_MS, nowMs = Date.now, waitFn = abortableWait } = {}) {
  const origins = new Map();
  return {
    async wait(origin, { signal, deadlineAt = Infinity, onStart } = {}) {
      if (signal?.aborted) throw abortReason(signal);
      const state = origins.get(origin) || { tail: Promise.resolve(), lastStart: null };
      origins.set(origin, state);
      const work = state.tail.then(async () => {
        if (signal?.aborted) throw abortReason(signal);
        const interval = Math.max(0, Number(typeof intervalMs === "function" ? intervalMs() : intervalMs) || 0);
        const delay = state.lastStart == null ? 0 : Math.max(0, state.lastStart + interval - nowMs());
        if (nowMs() + delay >= deadlineAt) throw new DOMException("高德排队等待超时", "TimeoutError");
        if (delay) await waitFn(delay, signal);
        if (signal?.aborted) throw abortReason(signal);
        if (nowMs() >= deadlineAt) throw new DOMException("高德排队等待超时", "TimeoutError");
        // 在同一队列回调中启动 HTTP，再计算下一个起点；响应可并行。
        onStart?.();
        state.lastStart = nowMs();
      });
      state.tail = work.catch(() => {});
      if (!signal) return work;
      // 队列中撤销立即返回；轮到这个节点时再次检查，绝不发送已取消请求。
      return new Promise((resolve, reject) => {
        const cancel = () => { cleanup(); reject(abortReason(signal)); };
        const cleanup = () => signal.removeEventListener("abort", cancel);
        signal.addEventListener("abort", cancel, { once: true });
        work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        if (signal.aborted) cancel();
      });
    },
  };
}

const sharedRequestPacer = createAmapRequestPacer({
  intervalMs: () => process.env.NODE_ENV === "test" ? 0 : amapRequestIntervalMs(),
});

export class AmapError extends Error {
  constructor(message, { endpoint, infocode = null, info = null, category = "request", httpStatus = null } = {}) {
    super(message);
    this.name = "AmapError";
    this.code = `AMAP_${String(category).toUpperCase()}`;
    this.endpoint = endpoint || null;
    this.infocode = infocode == null ? null : String(infocode);
    this.info = info == null ? null : String(info).slice(0, 200);
    this.category = category;
    this.blocked = category === "blocked";
    this.transient = category === "transient";
    this.quotaExceeded = this.infocode != null && QUOTA_INFOCODES.has(this.infocode);
    this.httpStatus = httpStatus;
  }
}

export function classifyAmapInfocode(infocode) {
  const code = String(infocode ?? "").trim();
  if (Object.hasOwn(BLOCKING_INFOCODES, code)) {
    return { category: "blocked", message: BLOCKING_INFOCODES[code] };
  }
  if (Object.hasOwn(TRANSIENT_INFOCODES, code)) {
    return { category: "transient", message: TRANSIENT_INFOCODES[code] };
  }
  return { category: "request", message: null };
}

// ---------------------------------------------------------------------------
// 配置读取（每次调用时读，测试可在运行中切换环境变量）
// ---------------------------------------------------------------------------

export function amapWebKey(env = process.env) {
  return String(env.AMAP_WEB_KEY || "").trim();
}

export function amapBaseUrl(env = process.env) {
  const raw = String(env.AMAP_BASE_URL || "").trim() || AMAP_DEFAULT_BASE_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return AMAP_DEFAULT_BASE_URL;
    return url.origin;
  } catch {
    return AMAP_DEFAULT_BASE_URL;
  }
}

export function amapConfigured(env = process.env) {
  return Boolean(amapWebKey(env));
}

/** 供就绪矩阵做配置指纹；返回值含密钥，调用方只能哈希，不得输出。 */
export function amapConfigurationFacts(env = process.env) {
  return { key: amapWebKey(env), baseUrl: amapBaseUrl(env) };
}

export const AMAP_UNCONFIGURED_REASON = "AMAP_WEB_KEY 未配置";

// ---------------------------------------------------------------------------
// 运行时状态（供就绪矩阵判断 blocked）
// ---------------------------------------------------------------------------

const runtimeState = {
  lastSuccessAt: null,
  lastBlocked: null,
  lastError: null,
  callCount: 0,
  cacheHits: 0,
  // FR-4.3：最近 20 次错误、当日调用计数（进程内，重启清零；配额以高德控制台为准）。
  recentErrors: [],
  daily: { date: null, count: 0 },
};

function localDateKey(at = new Date()) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function noteCall(at = new Date()) {
  const key = localDateKey(at);
  if (runtimeState.daily.date !== key) runtimeState.daily = { date: key, count: 0 };
  runtimeState.daily.count += 1;
  try {
    const usage = amapDailyUsage();
    if (usage.nearQuota) {
      emitAmapAlert("near_quota", { date: usage.date, count: usage.count, quota: usage.quota });
    }
  } catch {
    // 配额统计异常不影响调用。
  }
}

export function amapDailyUsage(env = process.env) {
  const quotaRaw = Number(String(env.AMAP_DAILY_QUOTA ?? "").trim());
  const quota = Number.isFinite(quotaRaw) && quotaRaw > 0 ? quotaRaw : AMAP_DEFAULT_DAILY_QUOTA;
  const today = localDateKey();
  const count = runtimeState.daily.date === today ? runtimeState.daily.count : 0;
  return {
    date: today,
    count,
    quota,
    ratio: Number((count / quota).toFixed(3)),
    nearQuota: count >= quota * AMAP_QUOTA_WARN_RATIO,
    qps: amapConfiguredQps(env),
  };
}

export function amapRecentErrors() {
  return runtimeState.recentErrors.map((item) => ({ ...item }));
}

export function amapRuntimeState() {
  const blocked =
    Boolean(runtimeState.lastBlocked) &&
    (!runtimeState.lastSuccessAt ||
      Date.parse(runtimeState.lastBlocked.at) > Date.parse(runtimeState.lastSuccessAt));
  return {
    lastSuccessAt: runtimeState.lastSuccessAt,
    lastBlocked: runtimeState.lastBlocked ? { ...runtimeState.lastBlocked } : null,
    lastError: runtimeState.lastError ? { ...runtimeState.lastError } : null,
    callCount: runtimeState.callCount,
    cacheHits: runtimeState.cacheHits,
    blocked,
    daily: amapDailyUsage(),
    recentErrors: amapRecentErrors(),
  };
}

export function resetAmapRuntimeState() {
  runtimeState.lastSuccessAt = null;
  runtimeState.lastBlocked = null;
  runtimeState.lastError = null;
  runtimeState.callCount = 0;
  runtimeState.cacheHits = 0;
  runtimeState.recentErrors = [];
  runtimeState.daily = { date: null, count: 0 };
}

function noteSuccess(at) {
  runtimeState.lastSuccessAt = at;
}

let alertHandler = null;
const alertSentAt = new Map();

/** 注册凭证/配额告警处理器（站内信 + 飞书推送在 amap-alerts.js 里实现，本模块保持无依赖）。 */
export function setAmapAlertHandler(fn) {
  alertHandler = typeof fn === "function" ? fn : null;
}

export function resetAmapAlertState() {
  alertSentAt.clear();
}

function emitAmapAlert(kind, payload, nowMs = Date.now()) {
  if (!alertHandler) return false;
  const key = `${kind}:${payload?.infocode || payload?.date || ""}`;
  const last = alertSentAt.get(key);
  if (last != null && nowMs - last < AMAP_ALERT_THROTTLE_MS) return false;
  alertSentAt.set(key, nowMs);
  try {
    const result = alertHandler({ kind, ...payload });
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // 告警失败不影响高德调用本身。
  }
  return true;
}

export function amapTaskRequestBudget(env = process.env) {
  const raw = Number(String(env.AMAP_TASK_REQUEST_BUDGET ?? "").trim());
  const configured = Number.isFinite(raw) && raw > 0 ? Math.min(200, Math.max(5, Math.round(raw))) : AMAP_DEFAULT_TASK_REQUEST_BUDGET;
  return amapDailyUsage(env).nearQuota ? Math.min(configured, AMAP_NEAR_QUOTA_TASK_BUDGET) : configured;
}

function noteFailure(error, at) {
  const summary = {
    at,
    endpoint: error?.endpoint || null,
    infocode: error?.infocode || null,
    info: error?.info || null,
    message: redactKey(String(error?.message || error || "")).slice(0, 200),
  };
  runtimeState.lastError = summary;
  runtimeState.recentErrors = [
    { ...summary, explanation: summary.infocode ? classifyAmapInfocode(summary.infocode).message || null : null },
    ...runtimeState.recentErrors,
  ].slice(0, 20);
  if (error?.blocked) {
    runtimeState.lastBlocked = summary;
    emitAmapAlert(error?.quotaExceeded ? "quota" : "credential", {
      infocode: summary.infocode,
      explanation: summary.infocode ? classifyAmapInfocode(summary.infocode).message || null : null,
      message: summary.message,
      at,
    });
  }
}

// ---------------------------------------------------------------------------
// fetch 注入
// ---------------------------------------------------------------------------

let moduleFetch = null;

export function setFetch(fn) {
  moduleFetch = typeof fn === "function" ? fn : null;
}

export function resetFetch() {
  moduleFetch = null;
}

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === "function") return fetchImpl;
  if (typeof moduleFetch === "function") return moduleFetch;
  return typeof globalThis.fetch === "function" ? globalThis.fetch : null;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function redactKey(text) {
  return String(text || "").replace(/([?&]key=)[^&\s]+/giu, "$1[已脱敏]");
}

/** 高德把缺失字段返回成 [] 或 ""；统一成 null。 */
function str(value, max = 300) {
  if (value == null || Array.isArray(value)) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function num(value) {
  if (value == null || Array.isArray(value) || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseLocation(value) {
  const text = str(value, 60);
  if (!text) return null;
  const [lng, lat] = text.split(",").map((part) => Number(part));
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

function roundCoord(value, digits = 3) {
  const factor = 10 ** digits;
  return String(Math.round(Number(value) * factor) / factor);
}

function clampInt(value, { min, max, fallback }) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function requestId() {
  return `amap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeAmapPoi(poi) {
  if (!poi || typeof poi !== "object") return null;
  const name = str(poi.name, 120);
  if (!name) return null;
  const location = str(poi.location, 60);
  const bizExt = poi.biz_ext && typeof poi.biz_ext === "object" ? poi.biz_ext : {};
  return {
    id: str(poi.id, 40),
    name,
    type: str(poi.type, 120),
    typecode: str(poi.typecode, 40),
    address: str(poi.address, 200),
    location,
    coords: parseLocation(location),
    distance: num(poi.distance),
    tel: str(poi.tel, 80),
    adcode: str(poi.adcode, 12),
    cityname: str(poi.cityname, 40),
    adname: str(poi.adname, 40),
    biz_ext: {
      rating: num(bizExt.rating),
      cost: num(bizExt.cost),
    },
  };
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

export function createMemoryGeoPoiCache() {
  const store = new Map();
  return {
    kind: "memory",
    get(key, now = Date.now()) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now) {
        store.delete(key);
        return null;
      }
      return { payload: entry.payload, fetchedAt: entry.fetchedAt };
    },
    set(key, { payload, fetchedAt, ttlMs = GEO_POI_CACHE_TTL_MS, provider = "amap", endpoint = "" }, now = Date.now()) {
      store.set(key, { payload, fetchedAt, provider, endpoint, expiresAt: now + ttlMs });
    },
    size() {
      return store.size;
    },
  };
}

/**
 * SQLite 全局缓存表（非租户表：POI 是公开地理事实，跨租户共享节省配额）。
 * db.js 延迟导入，避免仅用内存缓存的测试或工具在 import 时就打开数据库。
 */
export function createSqliteGeoPoiCache() {
  let ready = null;
  const ensure = async () => {
    if (!ready) {
      ready = (async () => {
        const mod = await import("../db.js");
        mod.db.exec(`CREATE TABLE IF NOT EXISTS geo_poi_cache (
          cache_key TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          payload TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )`);
        return mod;
      })().catch((error) => {
        ready = null;
        throw error;
      });
    }
    return ready;
  };
  return {
    kind: "sqlite",
    async get(key, now = Date.now()) {
      try {
        const mod = await ensure();
        const row = mod.q.get(
          "SELECT payload, fetched_at, expires_at FROM geo_poi_cache WHERE cache_key=?",
          key,
        );
        if (!row) return null;
        if (Number(row.expires_at) <= now) {
          mod.qRaw.run("DELETE FROM geo_poi_cache WHERE cache_key=?", key);
          return null;
        }
        return { payload: JSON.parse(row.payload), fetchedAt: row.fetched_at };
      } catch {
        return null;
      }
    },
    async set(key, { payload, fetchedAt, ttlMs = GEO_POI_CACHE_TTL_MS, provider = "amap", endpoint = "" }, now = Date.now()) {
      try {
        const mod = await ensure();
        // 全局共享表，不在 ISOLATED 集合内；显式走 qRaw 表明非租户写入意图。
        mod.qRaw.run(
          `INSERT INTO geo_poi_cache(cache_key,provider,endpoint,payload,fetched_at,expires_at)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(cache_key) DO UPDATE SET provider=excluded.provider,endpoint=excluded.endpoint,
             payload=excluded.payload,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at`,
          key,
          provider,
          endpoint,
          JSON.stringify(payload),
          fetchedAt,
          now + ttlMs,
        );
      } catch {
        // 缓存只是省配额；写失败不得影响真实调用结果。
      }
    },
  };
}

let defaultCache = null;
function resolveCache(cache) {
  if (cache === false) return null;
  if (cache && typeof cache === "object") return cache;
  if (!defaultCache) defaultCache = createSqliteGeoPoiCache();
  return defaultCache;
}

export function poiCacheKey({ kind, lng, lat, radius, types, keywords, city, pageSize, pages }) {
  return [
    kind,
    lng == null || lat == null ? "" : `${roundCoord(lng)},${roundCoord(lat)}`,
    radius ?? "",
    String(types || ""),
    String(keywords || ""),
    String(city || ""),
    pageSize ?? "",
    pages ?? "",
  ].join("|");
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export function createAmapClient({
  apiKey,
  baseUrl,
  fetchImpl,
  timeoutMs = AMAP_DEFAULT_TIMEOUT_MS,
  queueTimeoutMs = AMAP_QUEUE_TIMEOUT_MS,
  requestPacer = sharedRequestPacer,
  cache,
  now = () => new Date(),
  env = process.env,
  requestBudget = null,
} = {}) {
  const key = apiKey === undefined ? amapWebKey(env) : String(apiKey || "").trim();
  const budgetLimit = Number.isFinite(Number(requestBudget)) && Number(requestBudget) > 0
    ? Math.round(Number(requestBudget))
    : null;
  let budgetUsed = 0;
  const origin = baseUrl ? amapBaseUrl({ AMAP_BASE_URL: baseUrl }) : amapBaseUrl(env);
  const timeout = Math.max(1_000, Math.min(30_000, Number(timeoutMs) || AMAP_DEFAULT_TIMEOUT_MS));
  const queueTimeout = Math.max(1, Math.min(120_000, Number(queueTimeoutMs) || AMAP_QUEUE_TIMEOUT_MS));
  const cacheStore = resolveCache(cache);

  const unavailable = (reason = AMAP_UNCONFIGURED_REASON) => ({
    unavailable: true,
    reason,
    source: { provider: "amap", endpoint: null, fetchedAt: null, requestId: null },
  });

  async function call(endpoint, params, { signal } = {}) {
    const fetcher = resolveFetch(fetchImpl);
    if (!fetcher) {
      throw new AmapError("高德HTTP客户端不可用", { endpoint, category: "transient" });
    }
    const url = new URL(endpoint, origin);
    url.searchParams.set("key", key);
    url.searchParams.set("output", "json");
    for (const [name, value] of Object.entries(params)) {
      if (value == null || value === "") continue;
      url.searchParams.set(name, String(value));
    }
    const deadlineAt = Date.now() + queueTimeout + timeout;
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => deadlineController.abort(new DOMException("高德请求总等待超时", "TimeoutError")), queueTimeout + timeout);
    const totalSignal = signal ? AbortSignal.any([signal, deadlineController.signal]) : deadlineController.signal;
    const safeErrorText = value => redactKey(String(value || "")).split(key).join("[已脱敏]");
    try {
      for (let attempt = 0; attempt <= 2; attempt += 1) {
        const send = async () => {
          if (totalSignal.aborted) throw abortReason(totalSignal);
          if (budgetLimit != null && budgetUsed >= budgetLimit) {
            throw new AmapError(`本单高德请求预算已用完（${budgetLimit} 次），其余数据改用缓存或公开检索`, {
              endpoint,
              category: "budget",
            });
          }
          budgetUsed += 1;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new DOMException("高德网络请求超时", "TimeoutError")), timeout);
          const fetchSignal = AbortSignal.any([totalSignal, controller.signal]);
          const fetchedAt = now().toISOString();
          const id = requestId();
          runtimeState.callCount += 1;
          noteCall();
          let payload;
          try {
            const response = await fetcher(url.toString(), {
              method: "GET", headers: { Accept: "application/json" }, signal: fetchSignal,
            });
            if (!response?.ok) throw new AmapError(`高德HTTP ${response?.status ?? "?"}`, {
              endpoint, category: Number(response?.status) === 429 ? "transient" : "request", httpStatus: Number(response?.status) || null,
            });
            try { payload = await response.json(); }
            catch { throw new AmapError("高德响应不是合法JSON", { endpoint, category: "request" }); }
          } catch (error) {
            if (error instanceof AmapError) throw error;
            throw new AmapError(signal?.aborted ? "高德请求已取消" : fetchSignal.aborted
              ? `高德请求超时（${timeout}ms）` : `高德请求失败：${safeErrorText(error?.message || error)}`,
            { endpoint, category: signal?.aborted ? "cancelled" : "transient" });
          } finally { clearTimeout(timer); }
          return { payload, fetchedAt, id };
        };
        let pending;
        await requestPacer.wait(origin, {
          signal: totalSignal,
          deadlineAt,
          onStart() {
            pending = send();
            // 即便在排队信号回调中取消，网络请求的拒绝也始终有人接收。
            pending.catch(() => {});
          },
        });
        // 外部注入的旧版节流器只实现 wait，保留其放行后再发请求的契约。
        const { payload, fetchedAt, id } = await (pending || send());
        if (String(payload?.status) !== "1") {
          const infocode = str(payload?.infocode, 12);
          const info = safeErrorText(str(payload?.info, 200));
          const classified = classifyAmapInfocode(infocode);
          const error = new AmapError(`高德${classified.category === "blocked" ? "凭证/配额" : ""}错误 ${infocode || "?"}：${classified.message || info || "未知错误"}`,
            { endpoint, infocode, info, category: classified.category });
          noteFailure(error, fetchedAt);
          if (RETRYABLE_QPS_INFOCODES.has(infocode) && attempt < 2 && !totalSignal.aborted) continue;
          throw error;
        }
        noteSuccess(fetchedAt);
        return { payload, source: { provider: "amap", endpoint, fetchedAt, requestId: id, requestAttempts: attempt + 1 } };
      }
    } catch (error) {
      const safe = error instanceof AmapError ? error : new AmapError(signal?.aborted ? "高德请求已取消" : "高德请求排队或执行超时", { endpoint, category: signal?.aborted ? "cancelled" : "transient" });
      // 本单预算用完是主动限流，不计入“最近错误”。
      if (safe.category !== "budget") noteFailure(safe, now().toISOString());
      throw safe;
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  async function withCache(cacheKey, endpoint, loader) {
    if (cacheStore) {
      const hit = await cacheStore.get(cacheKey, now().getTime());
      if (hit) {
        runtimeState.cacheHits += 1;
        return {
          data: hit.payload,
          source: { provider: "amap", endpoint, fetchedAt: hit.fetchedAt, requestId: null, cached: true },
        };
      }
    }
    const result = await loader();
    if (cacheStore) {
      await cacheStore.set(
        cacheKey,
        {
          payload: result.data,
          fetchedAt: result.source.fetchedAt,
          provider: "amap",
          endpoint,
        },
        now().getTime(),
      );
    }
    return { ...result, source: { ...result.source, cached: false } };
  }

  async function geocode(address, city, { signal } = {}) {
    if (!key) return unavailable();
    const endpoint = "/v3/geocode/geo";
    const text = str(address, 200);
    if (!text) {
      return { data: null, source: { provider: "amap", endpoint, fetchedAt: now().toISOString(), requestId: null }, note: "地址为空" };
    }
    const { payload, source } = await call(endpoint, { address: text, city: str(city, 40) || undefined }, { signal });
    const first = Array.isArray(payload?.geocodes) ? payload.geocodes[0] : null;
    const coords = parseLocation(first?.location);
    const data = first && coords
      ? {
          lng: coords.lng,
          lat: coords.lat,
          adcode: str(first.adcode, 12),
          citycode: str(first.citycode, 12),
          formattedAddress: str(first.formatted_address, 200),
          province: str(first.province, 40),
          city: str(first.city, 40),
          district: str(first.district, 40),
          level: str(first.level, 40),
        }
      : null;
    return { data, source, ...(data ? {} : { note: "高德未匹配到该地址" }) };
  }

  async function searchPlaces(endpoint, { baseParams, pageSize, pages, signal, kind, cacheParams }) {
    const size = clampInt(pageSize, { min: 1, max: AMAP_MAX_PAGE_SIZE, fallback: AMAP_MAX_PAGE_SIZE });
    const pageLimit = clampInt(pages, { min: 1, max: AMAP_MAX_PAGES, fallback: AMAP_MAX_PAGES });
    const cacheKey = poiCacheKey({ kind, ...cacheParams, pageSize: size, pages: pageLimit });
    return withCache(cacheKey, endpoint, async () => {
      const pois = [];
      let total = null;
      let firstSource = null;
      let requestCount = 0;
      for (let page = 1; page <= pageLimit; page += 1) {
        const { payload, source } = await call(
          endpoint,
          { ...baseParams, offset: size, page, extensions: "all" },
          { signal },
        );
        requestCount += source.requestAttempts || 1;
        if (!firstSource) firstSource = source;
        const rows = Array.isArray(payload?.pois) ? payload.pois : [];
        if (total == null) total = num(payload?.count);
        for (const row of rows) {
          const normalized = normalizeAmapPoi(row);
          if (normalized) pois.push(normalized);
        }
        if (rows.length < size) break;
        if (total != null && pois.length >= total) break;
      }
      const seen = new Set();
      const unique = pois.filter((poi) => {
        const id = poi.id || `${poi.name}|${poi.location}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      return {
        data: {
          pois: unique,
          count: total ?? unique.length,
          returned: unique.length,
          truncated: total != null && unique.length < total,
          requestCount,
        },
        source: firstSource,
      };
    });
  }

  async function searchAround({ lng, lat, radius = 1000, types, keywords, pageSize, pages, sortrule = "distance", signal } = {}) {
    if (!key) return unavailable();
    const centerLng = Number(lng);
    const centerLat = Number(lat);
    if (!Number.isFinite(centerLng) || !Number.isFinite(centerLat)) {
      throw new AmapError("周边搜索中心坐标无效", { endpoint: "/v3/place/around", category: "request" });
    }
    const radiusMeters = clampInt(radius, { min: 50, max: 50_000, fallback: 1000 });
    return searchPlaces("/v3/place/around", {
      kind: "around",
      baseParams: {
        location: `${centerLng},${centerLat}`,
        radius: radiusMeters,
        types: str(types, 200) || undefined,
        keywords: str(keywords, 100) || undefined,
        sortrule,
      },
      cacheParams: { lng: centerLng, lat: centerLat, radius: radiusMeters, types, keywords },
      pageSize,
      pages,
      signal,
    });
  }

  async function searchText({ keywords, city, types, citylimit = true, pageSize, pages, signal } = {}) {
    if (!key) return unavailable();
    const text = str(keywords, 100);
    const typeText = str(types, 200);
    if (!text && !typeText) {
      throw new AmapError("关键字搜索需要 keywords 或 types", { endpoint: "/v3/place/text", category: "request" });
    }
    return searchPlaces("/v3/place/text", {
      kind: "text",
      baseParams: {
        keywords: text || undefined,
        types: typeText || undefined,
        city: str(city, 40) || undefined,
        citylimit: citylimit ? "true" : "false",
      },
      cacheParams: { types: typeText, keywords: text, city },
      pageSize,
      pages,
      signal,
    });
  }

  async function districtInfo(adcode, { signal } = {}) {
    if (!key) return unavailable();
    const endpoint = "/v3/config/district";
    const code = str(adcode, 20);
    if (!code) throw new AmapError("行政区查询缺少 adcode", { endpoint, category: "request" });
    const { payload, source } = await call(endpoint, { keywords: code, subdistrict: 0, extensions: "base" }, { signal });
    const first = Array.isArray(payload?.districts) ? payload.districts[0] : null;
    const center = parseLocation(first?.center);
    const data = first
      ? {
          adcode: str(first.adcode, 12),
          citycode: str(first.citycode, 12),
          name: str(first.name, 60),
          level: str(first.level, 20),
          center,
        }
      : null;
    return { data, source, ...(data ? {} : { note: "高德未返回该行政区" }) };
  }

  return Object.freeze({
    configured: Boolean(key),
    baseUrl: origin,
    timeoutMs: timeout,
    geocode,
    searchAround,
    searchText,
    districtInfo,
    requestBudget: () => ({ limit: budgetLimit, used: budgetUsed }),
  });
}

// 模块级便捷入口：每次调用按当前环境变量构造客户端，测试可随时切换密钥。
export const geocode = (address, city, options) => createAmapClient(options).geocode(address, city, options);
export const searchAround = (params = {}) => createAmapClient(params).searchAround(params);
export const searchText = (params = {}) => createAmapClient(params).searchText(params);
export const districtInfo = (adcode, options) => createAmapClient(options).districtInfo(adcode, options);

/**
 * 管理后台“测试连接”用：一次最小地理编码调用，返回可脱敏的验收证据。
 * 不向调用方泄露 key；错误信息经 redactKey 处理。
 */
export async function verifyAmapConnection({ fetchImpl, address = "北京市朝阳区阜通东大街6号", city = "北京", signal, cache = false } = {}) {
  const client = createAmapClient({ fetchImpl, cache });
  if (!client.configured) {
    return { ok: false, configured: false, blocked: false, error: AMAP_UNCONFIGURED_REASON };
  }
  try {
    const result = await client.geocode(address, city, { signal });
    if (!result?.data) {
      return {
        ok: false,
        configured: true,
        blocked: false,
        error: "高德已响应但未返回地理编码结果",
        endpoint: result?.source?.endpoint || "/v3/geocode/geo",
      };
    }
    return {
      ok: true,
      configured: true,
      blocked: false,
      endpoint: result.source.endpoint,
      fetchedAt: result.source.fetchedAt,
      adcode: result.data.adcode,
      formattedAddress: result.data.formattedAddress,
      baseUrl: client.baseUrl,
    };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      blocked: error?.blocked === true,
      quotaExceeded: error?.quotaExceeded === true,
      infocode: error?.infocode || null,
      error: redactKey(error?.message || String(error)).slice(0, 200),
      endpoint: error?.endpoint || "/v3/geocode/geo",
    };
  }
}

/**
 * PRD v2.2 FR-4.3：三步自检（固定公开地标与关键词，不接受任意地址，避免成为代理）。
 * 地理编码（望京SOHO）→ 周边搜索（1000 米，餐饮 050000）→ 关键字搜索（望京 火锅）。
 * 每步输出：是否成功、耗时、返回条数、是否带人均（biz_ext.cost）、infocode 与中文说明。
 */
export async function runAmapSelfCheck({ fetchImpl, signal } = {}) {
  const client = createAmapClient({ fetchImpl, cache: false });
  const startedAt = new Date().toISOString();
  if (!client.configured) {
    return { ok: false, configured: false, startedAt, steps: [], error: AMAP_UNCONFIGURED_REASON, usage: amapDailyUsage() };
  }
  const steps = [];
  const timed = async (name, fn) => {
    const t0 = Date.now();
    try {
      const result = await fn();
      const pois = Array.isArray(result?.data?.pois) ? result.data.pois : null;
      const step = {
        name,
        ok: Boolean(result?.data),
        ms: Date.now() - t0,
        returned: pois ? pois.length : result?.data ? 1 : 0,
        withCost: pois ? pois.filter((poi) => Number(poi?.biz_ext?.cost) > 0).length : null,
        infocode: null,
        explanation: result?.data ? null : result?.note || "未返回数据",
      };
      steps.push(step);
      return result;
    } catch (error) {
      steps.push({
        name,
        ok: false,
        ms: Date.now() - t0,
        returned: 0,
        withCost: null,
        infocode: error?.infocode || null,
        explanation: redactKey(error?.message || String(error)).slice(0, 200),
        blocked: error?.blocked === true,
      });
      return null;
    }
  };
  const geo = await timed("地理编码·望京SOHO", () => client.geocode("望京SOHO", "北京", { signal }));
  const center = geo?.data ? { lng: geo.data.lng, lat: geo.data.lat } : { lng: 116.4807, lat: 39.9965 };
  await timed("周边搜索·1000米餐饮", () =>
    client.searchAround({ ...center, radius: 1000, types: AMAP_RESTAURANT_TYPECODE, pages: 1, signal }));
  await timed("关键字搜索·望京 火锅", () =>
    client.searchText({ keywords: "望京 火锅", city: "北京", types: AMAP_RESTAURANT_TYPECODE, pages: 1, signal }));
  return {
    ok: steps.every((step) => step.ok),
    configured: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps,
    usage: amapDailyUsage(),
  };
}

const LOCATION_HOST_PATTERNS = Object.freeze([
  /(?:^|\.)openstreetmap\.org$/u,
  /(?:^|\.)openstreetmap\.de$/u,
  /(?:^|\.)amap\.com$/u,
  /(?:^|\.)gaode\.com$/u,
  /(?:^|\.)map\.baidu\.com$/u,
  /(?:^|\.)map\.qq\.com$/u,
  /(?:^|\.)maps\.apple\.com$/u,
  /(?:^|\.)maps\.google\.com$/u,
  /(?:^|\.)maps\.app\.goo\.gl$/u,
]);

const LOCATION_TASK_BLOCKED_HOST_PATTERNS = Object.freeze([
  /(?:^|\.)sites\.google\.com$/u,
  /(?:^|\.)fanyi\.taobao\.com$/u,
  /(?:^|\.)cnblogs\.com$/u,
  /(?:^|\.)wikipedia\.org$/u,
]);

const PREFERRED_RESTAURANT_SOURCE_HOST_PATTERNS = Object.freeze([
  /(?:^|\.)dianping\.com$/u,
  /(?:^|\.)meituan\.com$/u,
  /(?:^|\.)ele\.me$/u,
  /(?:^|\.)ctrip\.com$/u,
  /(?:^|\.)trip\.com$/u,
  /(?:^|\.)seazen\.com\.cn$/u,
  /(?:^|\.)mcdonalds\.com\.cn$/u,
  /(?:^|\.)alittle-tea\.com$/u,
  /(?:^|\.)meet-fresh\.cn$/u,
]);

const ALWAYS_REJECT_TEXT =
  /(?:假.{0,5}(?:护照|证件|身份证|驾照)|(?:护照|证件).{0,5}(?:代办|定制|仿制)|whats?app|telegram|电报群|飞机号)/iu;
const TRANSLATION_PAGE_TEXT =
  /(?:怎么翻译|英文用法|英语例句|在线翻译|词典释义|中英翻译)/iu;
const LOCATION_MARKETING_TEXT =
  /(?:geo.{0,8}(?:推广|营销|获客)|精准破局流量|线上获客|小红书推广|营销图鉴|推广服务|流量难题)/iu;
const LOCATION_AGGREGATION_TEXT =
  /(?:(?:餐厅|饭店|美食).{0,12}(?:推荐榜|排行榜|top\s*\d|靠谱之选|专业测评)|包包回收|回收指南)/iu;
const RESTAURANT_EVIDENCE_TEXT =
  /(?:餐饮|餐厅|饭店|门店|商户|菜单|菜品|营业|价格|人均|评价|点评|外卖|堂食|午餐|晚餐|夜宵|火锅|毛血旺|中餐|竞品)/iu;
const LOCATION_BUSINESS_CONTEXT_TEXT =
  /(?:餐饮|餐厅|饭店|门店|商户|菜单|菜品|营业|价格|人均|评价|点评|外卖|堂食|午餐|晚餐|夜宵|火锅|毛血旺|中餐|竞品|商圈|客流|交通|公交|地铁|车站|学校|医院|办公|住宅|商场|购物中心|景点|活动场所)/iu;
const SENSITIVE_URL_PARAMETER =
  /^(?:api[_-]?key|access[_-]?token|authorization|auth|signature|secret|token|password|passwd|credential)$/iu;

function cleanText(value, limit = 6000) {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function parsedHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/u.test(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    parsed.hash = "";
    return parsed;
  } catch {
    return null;
  }
}

function hasMalformedEncodedUrlMaterial(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    for (const initial of [parsed.search.slice(1), parsed.hash.slice(1)]) {
      const decoded = decodeURIComponent(initial.replace(/\+/gu, "%20"));
      if (decoded.includes("�")) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function hasSensitiveUrlParameter(parsed) {
  return [...parsed.searchParams.keys()].some((key) => {
    let decoded = key;
    try {
      for (let depth = 0; depth < 2; depth += 1) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
    } catch {
      return true;
    }
    return SENSITIVE_URL_PARAMETER.test(decoded);
  });
}

function hasSensitiveUrlFragment(value) {
  try {
    let hash = new URL(String(value || "").trim()).hash.slice(1);
    for (let depth = 0; depth < 2; depth += 1) {
      const decoded = decodeURIComponent(hash);
      if (decoded === hash) break;
      hash = decoded;
    }
    return /(?:^|[&;{\[,"'\s])(?:api[_-]?key|access[_-]?token|authorization|auth|signature|secret|token|password|passwd|credential)["']?\s*(?:=|:)/iu.test(
      hash,
    );
  } catch {
    return true;
  }
}

function sourceHost(source) {
  return parsedHttpUrl(source?.url)?.hostname.toLowerCase() || "";
}

function sourceKey(source) {
  const parsed = parsedHttpUrl(source?.url);
  return parsed ? parsed.href : "";
}

function hostMatches(host, patterns) {
  return Boolean(host && patterns.some((pattern) => pattern.test(host)));
}

function sourceText(source) {
  return cleanText(
    [source?.title, source?.snippet, source?.body].filter(Boolean).join(" "),
  );
}

function decodedUrlText(source) {
  try {
    const parsed = parsedHttpUrl(source?.url);
    if (!parsed) return "";
    return cleanText(
      decodeURIComponent(`${parsed.hostname} ${parsed.pathname}`),
      1200,
    );
  } catch {
    return "";
  }
}

function auditSafeTitle(value) {
  const cleaned = cleanText(value, 500)
    .replace(/https?:\/\/[^\s<>{}"'，。；！？）】》]+/giu, "[URL已移除]")
    .replace(
      /\b(?:api[_-]?key|access[_-]?token|authorization|signature|secret|token)\s*[=:]\s*[^\s&，。；]+/giu,
      "[敏感参数已移除]",
    )
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned && cleaned !== "[URL已移除]"
    ? cleaned.slice(0, 180)
    : "拒绝来源";
}

function rejectionReason(
  source,
  {
    locationBusinessTask = false,
    requireTaskRelevance = false,
    allowUnresolvedToolCandidate = false,
    task = null,
  } = {},
) {
  const parsed = parsedHttpUrl(source?.url);
  if (!parsed) return "invalid_or_non_http_url";
  if (hasMalformedEncodedUrlMaterial(source?.url)) {
    return "malformed_url_encoding";
  }
  if (
    hasSensitiveUrlParameter(parsed) ||
    hasSensitiveUrlFragment(source?.url)
  ) {
    return "credential_bearing_url";
  }
  if (!cleanText(source?.title, 300)) return "missing_source_title";
  const host = parsed.hostname.toLowerCase();
  const text = sourceText(source);
  if (ALWAYS_REJECT_TEXT.test(text)) return "fraud_or_off_platform_contact";
  if (TRANSLATION_PAGE_TEXT.test(text))
    return "translation_page_not_business_evidence";
  if (!locationBusinessTask) return null;
  if (hostMatches(host, LOCATION_TASK_BLOCKED_HOST_PATTERNS)) {
    return "low_authority_host_for_location_business_task";
  }
  if (LOCATION_MARKETING_TEXT.test(text))
    return "generic_marketing_or_lead_generation";
  if (LOCATION_AGGREGATION_TEXT.test(text))
    return "seo_ranking_or_unrelated_aggregation";
  if (
    requireTaskRelevance &&
    !isLocationHost(source) &&
    !isLocationBusinessSourceRelevant(source, task) &&
    !(
      allowUnresolvedToolCandidate &&
      /来自本次真实WebSearch工具结果.{0,80}受控WebFetch/iu.test(
        sourceText(source),
      )
    )
  ) {
    return "not_relevant_to_location_business_task";
  }
  return null;
}

function rejectedSourceRecord(source, reason, stage) {
  return {
    title: auditSafeTitle(source?.title),
    host: sourceHost(source) || "invalid",
    reason,
    stage,
  };
}

export function sanitizePublicSources(
  sources,
  {
    locationBusinessTask = false,
    requireTaskRelevance = false,
    allowUnresolvedToolCandidate = false,
    stage = "final",
    task = null,
  } = {},
) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const rawSource of Array.isArray(sources) ? sources : []) {
    const reason = rejectionReason(rawSource, {
      locationBusinessTask,
      requireTaskRelevance,
      allowUnresolvedToolCandidate,
      task,
    });
    if (reason) {
      rejected.push(rejectedSourceRecord(rawSource, reason, stage));
      continue;
    }
    const key = sourceKey(rawSource);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const parsed = parsedHttpUrl(rawSource?.url);
    accepted.push({
      ...rawSource,
      title: cleanText(rawSource?.title, 300),
      url: parsed.href,
      snippet: cleanText(rawSource?.snippet, 1600),
      ...(rawSource?.body == null
        ? {}
        : { body: cleanText(rawSource.body, 12_000) }),
    });
  }
  return { accepted, rejected };
}

export function retainControlledSourceMatches(
  sources,
  controlledSources,
  { stage = "controlled_match" } = {},
) {
  const controlledByUrl = new Map();
  for (const source of Array.isArray(controlledSources)
    ? controlledSources
    : []) {
    const key = sourceKey(source);
    if (key && cleanText(source?.body, 12_000).length >= 80) {
      controlledByUrl.set(key, source);
    }
  }
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const source of Array.isArray(sources) ? sources : []) {
    const key = sourceKey(source);
    const controlled = key ? controlledByUrl.get(key) : null;
    if (!controlled) {
      rejected.push(
        rejectedSourceRecord(source, "not_controlled_page_evidence", stage),
      );
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push({
      ...source,
      ...controlled,
      title: cleanText(controlled.title || source?.title, 300),
      url: key,
      snippet: cleanText(controlled.snippet || source?.snippet, 1600),
      body: cleanText(controlled.body, 12_000),
    });
  }
  return { accepted, rejected };
}

function controlledCandidateScore(source, task = {}) {
  const host = sourceHost(source);
  const combinedText = `${sourceText(source)} ${decodedUrlText(source)}`;
  const taskRelevant = isLocationBusinessSourceRelevant(
    { ...source, snippet: combinedText },
    task,
  );
  let score = 0;
  if (hostMatches(host, PREFERRED_RESTAURANT_SOURCE_HOST_PATTERNS))
    score += 500;
  if (taskRelevant) score += 260;
  if (RESTAURANT_EVIDENCE_TEXT.test(combinedText)) score += 120;
  if (
    /(?:官网|官方|商场|购物中心|具体商户|门店详情|菜单|营业时间|用户评价)/iu.test(
      combinedText,
    )
  ) {
    score += 100;
  }
  if (isLocationHost(source)) score += 40;
  if (/来自本次真实WebSearch工具结果/iu.test(sourceText(source))) score += 10;
  return score;
}

export function rankControlledFetchCandidates(sources, { task } = {}) {
  const ranked = (Array.isArray(sources) ? sources : [])
    .map((source, index) => ({
      source,
      index,
      score: controlledCandidateScore(source, task),
    }))
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );
  const perHost = new Map();
  const output = [];
  const overflow = [];
  for (const item of ranked) {
    const host = sourceHost(item.source) || "invalid";
    const count = perHost.get(host) || 0;
    if (count >= 2) {
      overflow.push(item.source);
      continue;
    }
    perHost.set(host, count + 1);
    output.push(item.source);
  }
  return [...output, ...overflow];
}

function strippedTaskSegment(value) {
  return cleanText(value, 80)
    .replace(
      /(?:竞品|商圈画像|商圈分析|选址分析|市场分析|公开核验|调研|研究|分析|画像)+$/gu,
      "",
    )
    .trim();
}

function taskAnchorTerms(task = {}) {
  const title = cleanText(task?.title, 300);
  const requirement = cleanText(task?.requirement, 1200);
  const quoted = [
    ...requirement.matchAll(/[“"「『]([^”"」』]{2,60})[”"」』]/gu),
  ].map((match) => match[1]);
  const chunks = [title, ...quoted]
    .flatMap((value) => value.split(/[\s,，。;；:：·|｜/\\()[\]【】]+/gu))
    .map(strippedTaskSegment)
    .filter((value) => value.length >= 2 && value.length <= 24);
  const output = new Set(chunks);
  for (const chunk of chunks) {
    if (!/(?:广场|商场|购物中心|门店|餐厅|饭店|酒店|大厦|街区)/u.test(chunk)) {
      continue;
    }
    const chars = Array.from(chunk);
    if (chars.length >= 6) output.add(chars.slice(0, 2).join(""));
    if (chars.length > 4) output.add(chars.slice(-4).join(""));
    if (chars.length > 6) output.add(chars.slice(-6).join(""));
  }
  return [...output].filter(
    (value) =>
      !/^(?:任务|需求|餐饮|门店|竞品|商圈|公开信息|业务结论)$/u.test(value),
  );
}

function isLocationHost(source) {
  const parsed = parsedHttpUrl(source?.url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  if (
    /(?:^|\.)google\.com$/u.test(host) &&
    /^\/maps(?:\/|$)/u.test(parsed.pathname)
  ) {
    return true;
  }
  return hostMatches(host, LOCATION_HOST_PATTERNS);
}

function isLocationBusinessSourceRelevant(source, task = {}) {
  const text = sourceText(source);
  if (!LOCATION_BUSINESS_CONTEXT_TEXT.test(text)) return false;
  const anchors = taskAnchorTerms(task);
  return anchors.length > 0 && anchors.some((anchor) => text.includes(anchor));
}

export function isDirectRestaurantSource(source, task = {}) {
  if (!parsedHttpUrl(source?.url) || isLocationHost(source)) return false;
  // 受控 WebFetch 的生产门要求至少80字可读正文。这里只接受同等证据，
  // 禁止搜索标题/摘要或供应商自报 metadata 冒充“已核验商户正文”。
  if (cleanText(source?.body, 12_000).length < 80) return false;
  const text = sourceText(source);
  if (!RESTAURANT_EVIDENCE_TEXT.test(text)) return false;
  const anchors = taskAnchorTerms(task);
  if (!anchors.length) return false;
  return anchors.some((anchor) => text.includes(anchor));
}

function isStructuredLocationRestaurantSource(source, task = {}) {
  if (
    source?.evidenceKind !== "structured_location_restaurant_poi" ||
    !isLocationHost(source)
  )
    return false;
  const text = sourceText(source);
  if (!RESTAURANT_EVIDENCE_TEXT.test(text)) return false;
  const anchors = taskAnchorTerms(task);
  return anchors.length > 0 && anchors.some((anchor) => text.includes(anchor));
}

export function sanitizeAgenticFacts(evidence, acceptedSources) {
  if (!evidence || typeof evidence !== "object") return evidence || null;
  const acceptedUrls = new Set(
    (Array.isArray(acceptedSources) ? acceptedSources : [])
      .map(sourceKey)
      .filter(Boolean),
  );
  const facts = Array.isArray(evidence.facts) ? evidence.facts : [];
  const safeFacts = facts.filter((fact) => {
    const urls = Array.isArray(fact?.sourceUrls) ? fact.sourceUrls : [];
    return (
      urls.length > 0 &&
      urls.every((url) => {
        const parsed = parsedHttpUrl(url);
        return Boolean(parsed && acceptedUrls.has(parsed.href));
      })
    );
  });
  return {
    ...evidence,
    facts: safeFacts,
    rejectedFactCount:
      Number(evidence.rejectedFactCount || 0) +
      (facts.length - safeFacts.length),
  };
}

export function assessLocationBusinessSourceQuality({
  locationSources,
  controlledSources,
  task,
  rejectedSources,
  required = false,
} = {}) {
  const locationAnchorCount = (
    Array.isArray(locationSources) ? locationSources : []
  ).filter((source) => isLocationHost(source)).length;
  const controlledRestaurantSources = (
    Array.isArray(controlledSources) ? controlledSources : []
  ).filter((source) => isDirectRestaurantSource(source, task));
  const structuredRestaurantSources = (
    Array.isArray(locationSources) ? locationSources : []
  ).filter((source) => isStructuredLocationRestaurantSource(source, task));
  const directRestaurantSources = [
    ...new Map(
      [...controlledRestaurantSources, ...structuredRestaurantSources].map(
        (source) => [sourceKey(source), source],
      ),
    ).values(),
  ];
  const rejected = [];
  const seenRejected = new Set();
  for (const item of Array.isArray(rejectedSources) ? rejectedSources : []) {
    const key = `${item?.host || ""}|${item?.title || ""}|${item?.reason || ""}`;
    if (!key || seenRejected.has(key)) continue;
    seenRejected.add(key);
    rejected.push({
      title: auditSafeTitle(item?.title),
      host: cleanText(item?.host, 160) || "invalid",
      reason: cleanText(item?.reason, 120) || "rejected",
      stage: cleanText(item?.stage, 80) || "final",
    });
  }
  const passed =
    !required ||
    (locationAnchorCount >= 1 && directRestaurantSources.length >= 1);
  return {
    schemaVersion: "nanowork.public-source-quality/1",
    required,
    passed,
    locationAnchorCount,
    directRestaurantSourceCount: directRestaurantSources.length,
    directRestaurantControlledCount: controlledRestaurantSources.length,
    directRestaurantStructuredCount: structuredRestaurantSources.length,
    rejectedCount: rejected.length,
    rejected,
  };
}

// 内容部来源时效标注（纯函数，零 DB / 零网络依赖）。
// content-live-research.js 负责真实检索并复用这里的标注与渲染；
// content-connectors.js / content-output-contract.js 只需要这些纯函数，
// 因此单独成模块，避免把 db.js 的打开副作用带进纯目录测试。

export const CONTENT_FRESHNESS_HEADING = '信息时效';

const RESEARCH_KINDS = Object.freeze({
  trend: Object.freeze({
    label: '趋势官实时抓榜',
    freshnessWindowDays: 7,
    minimumItems: 1,
    roleHints: '最新 热点 趋势 近期动态',
    fallbackOrder: 'news_first',
  }),
  intel: Object.freeze({
    label: '情报员事实核验',
    freshnessWindowDays: 30,
    minimumItems: 2,
    roleHints: '官方来源 原始数据 事实核验',
    fallbackOrder: 'web_first',
  }),
  decompose: Object.freeze({
    label: '拆解师对标样本',
    freshnessWindowDays: 30,
    minimumItems: 1,
    roleHints: '爆款案例 对标账号 公众号 小红书 视频号',
    fallbackOrder: 'web_first',
  }),
});

export const CONTENT_LIVE_RESEARCH_KINDS = Object.freeze(Object.keys(RESEARCH_KINDS));

export function contentResearchKindMeta(kind) {
  return RESEARCH_KINDS[kind] || null;
}

export function contentResearchKindFor(employeeIdxOrKind) {
  if (typeof employeeIdxOrKind === 'string' && RESEARCH_KINDS[employeeIdxOrKind]) {
    return employeeIdxOrKind;
  }
  const idx = Number(employeeIdxOrKind);
  if (idx === 0) return 'trend';
  if (idx === 1) return 'intel';
  if (idx === 2) return 'decompose';
  return null;
}

export function contentFreshnessWindowDays(kind) {
  return RESEARCH_KINDS[kind]?.freshnessWindowDays ?? 30;
}

function safeText(value, max = 2_000) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isoOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./u, '').toLowerCase();
  } catch {
    return '';
  }
}

// Google News RSS 把发布时间塞进 snippet（“发布：<pubDate>”），检索源本身
// 没有独立字段；这里只解析明确带标签的时间，不猜测正文里的裸日期。
const SNIPPET_PUBLISHED_RE = /发布[：:]\s*([^；;]+)/u;

export function publishedAtFrom(...candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (plainObject(candidate)) {
      const direct = isoOrNull(candidate.publishedAt || candidate.published_at || candidate.date);
      if (direct) return direct;
      const fromSnippet = String(candidate.snippet || '').match(SNIPPET_PUBLISHED_RE)?.[1];
      const parsedSnippet = fromSnippet ? isoOrNull(fromSnippet.trim()) : null;
      if (parsedSnippet) return parsedSnippet;
      continue;
    }
    const direct = isoOrNull(candidate);
    if (direct) return direct;
  }
  return null;
}

function qualityScoreFor(item, { kind, platform, stale }) {
  let score = 0;
  if (item.controlledBody) score += 50;
  if (item.publishedAt) score += 15;
  if (stale === false) score += 15;
  if (safeText(item.snippet, 4_000).length >= 200) score += 10;
  const host = hostOf(item.url);
  if (platform && new RegExp(String(platform).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu').test(item.title || '')) {
    score += 5;
  }
  if (kind === 'intel' && /(?:gov\.cn|\.gov$|\.edu\.cn|\.org\.cn|xinhuanet|people\.com\.cn)/iu.test(host)) score += 10;
  return Math.min(100, score);
}

export function summarizeContentFreshness(items, { freshnessWindowDays = 30, fetchedAt = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const published = list.map(item => isoOrNull(item?.publishedAt)).filter(Boolean).sort();
  return {
    windowDays: Number(freshnessWindowDays) || 30,
    fetchedAt: isoOrNull(fetchedAt) || list.map(item => isoOrNull(item?.fetchedAt)).filter(Boolean).sort().at(-1) || null,
    total: list.length,
    newest: published.at(-1) || null,
    oldest: published[0] || null,
    knownCount: published.length,
    unknownCount: list.filter(item => !isoOrNull(item?.publishedAt)).length,
    staleCount: list.filter(item => item?.stale === true).length,
    freshCount: list.filter(item => item?.stale === false).length,
  };
}

/**
 * 为来源集合补齐抓取时间与时效标注。publishedAt 未知时 stale=null，
 * 不会被猜成“新鲜”或“过期”。
 */
export function annotateContentSourceFreshness(items, {
  kind = 'intel',
  fetchedAt = new Date().toISOString(),
  freshnessWindowDays = contentFreshnessWindowDays(kind),
  platform = null,
} = {}) {
  const fetchedIso = isoOrNull(fetchedAt) || new Date().toISOString();
  const fetchedMs = Date.parse(fetchedIso);
  const windowMs = Math.max(1, Number(freshnessWindowDays) || contentFreshnessWindowDays(kind)) * 86_400_000;
  const annotated = (Array.isArray(items) ? items : []).map(item => {
    const publishedAt = publishedAtFrom(item);
    const itemFetchedAt = isoOrNull(item?.fetchedAt) || fetchedIso;
    const stale = publishedAt ? fetchedMs - Date.parse(publishedAt) > windowMs : null;
    return {
      ...item,
      fetchedAt: itemFetchedAt,
      publishedAt,
      stale,
      qualityScore: Number.isFinite(item?.qualityScore)
        ? item.qualityScore
        : qualityScoreFor(item || {}, { kind, platform, stale }),
    };
  });
  return {
    items: annotated,
    freshness: summarizeContentFreshness(annotated, { freshnessWindowDays, fetchedAt: fetchedIso }),
  };
}

function shanghaiLabel(iso) {
  if (!iso) return '未知';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(iso)).map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function dateLabel(iso) {
  return iso ? shanghaiLabel(iso).slice(0, 10) : '未知';
}

function laneLabel(lane, provider) {
  if (lane === 'tinyfish') return 'TinyFish Search + Fetch';
  if (lane === 'claude_websearch') return 'Claude WebSearch';
  if (lane === 'search_api') return `商业检索 API${provider ? `（${provider}）` : ''}`;
  if (lane === 'keyless_fallback') return `免 Key 灾备检索${provider ? `（${provider}）` : ''}`;
  return '受控网页正文核验';
}

/**
 * 系统按本次真实检索确定性渲染的“信息时效”一节。放进证据区要求模型原样附在正文末尾；
 * 系统绝不改写模型正文（正文与供应商响应哈希一致的反造假链，见 paihuo-dispatch-markdown 测试）。
 *
 * 措辞刻意避开输出契约会追责的量词/归因模式：不写 [来源N]，不写 URL，不写百分比。
 */
export function renderContentFreshnessSection({ freshness, lane = null, provider = null, kind = 'intel' } = {}) {
  const summary = freshness || summarizeContentFreshness([]);
  const window = summary.windowDays || contentFreshnessWindowDays(kind);
  return [
    `【${CONTENT_FRESHNESS_HEADING}】`,
    `检索通道：${laneLabel(lane, provider)}；抓取时间：${shanghaiLabel(summary.fetchedAt)}（上海时间）。`,
    summary.knownCount
      ? `已核验来源共 ${summary.total} 条，其中 ${summary.knownCount} 条可确认发布时间（最新 ${dateLabel(summary.newest)}，最早 ${dateLabel(summary.oldest)}），${summary.unknownCount} 条发布时间未知。`
      : `已核验来源共 ${summary.total} 条，均未能从网页元数据取得发布时间，只保证抓取时间。`,
    summary.staleCount
      ? `时效窗口 ${window} 天：${summary.staleCount} 条超出窗口，引用其内容时须标注“信息可能过期”。`
      : `时效窗口 ${window} 天：没有来源超出窗口；发布时间未知的来源引用时须标注“发布时间未核实”。`,
  ].join('\n');
}

export function hasContentFreshnessSection(text) {
  return new RegExp(`(?:【|#+\\s*|\\*\\*)?${CONTENT_FRESHNESS_HEADING}`, 'u').test(String(text || ''));
}

export function contentFreshnessPromptBlock({ items, freshness, lane = null, provider = null, kind = 'intel' }) {
  const list = Array.isArray(items) ? items : [];
  return [
    '',
    '【本次检索来源的时效标注·系统生成】',
    ...list.map((item, index) => {
      const label = item?.sourceId || `来源${index + 1}`;
      const published = item?.publishedAt ? `发布 ${dateLabel(item.publishedAt)}` : '发布时间未知';
      const staleLabel = item?.stale === true
        ? '；已超出时效窗口，引用时标注“信息可能过期”'
        : item?.stale === null || item?.stale === undefined
          ? '；引用时标注“发布时间未核实”'
          : '';
      return `[${label}] 抓取 ${shanghaiLabel(item?.fetchedAt)}；${published}${staleLabel}`;
    }),
    '',
    `【${CONTENT_FRESHNESS_HEADING}·系统按本次真实检索生成，必须原样附在正文（briefing / summary 等主叙述字段）末尾，不得改动任何时间、数量或通道名称】`,
    renderContentFreshnessSection({ freshness, lane, provider, kind }),
  ].join('\n');
}

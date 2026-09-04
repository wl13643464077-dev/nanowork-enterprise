// 内容部真联网检索统一入口（趋势官 / 情报员 / 拆解师）。
//
// 复用餐饮岗位已验证的链路，不复制实现：
//   agentic-web-research（TinyFish → Claude CLI WebSearch）
//   → websearch（博查 / Tavily / Serper 商业检索 API；CLI 不可用时的回落层）
//   → controlled-web-evidence（受控 WebFetch，SSRF 钉住 DNS）
//   → public-source-quality（来源质量门）
//
// 每条结果都带抓取时间；发布时间只在网页/检索源明确给出时才填，拿不到就 null，
// 再按 freshnessWindowDays 标注 stale。未配置任何检索通道时返回 unavailable，
// 不回退到模板冒充实时结果（D-019 / D-055）。
import { createHash } from 'node:crypto';

import {
  agenticWebResearch,
  agenticWebResearchReadiness,
} from './agentic-web-research.js';
import { fetchControlledWebEvidence } from './controlled-web-evidence.js';
import {
  rankControlledFetchCandidates,
  retainControlledSourceMatches,
  sanitizePublicSources,
} from './public-source-quality.js';
import { webSearch, webSearchProviders } from './websearch.js';
import {
  CONTENT_FRESHNESS_HEADING,
  CONTENT_LIVE_RESEARCH_KINDS,
  annotateContentSourceFreshness,
  contentFreshnessPromptBlock,
  contentFreshnessWindowDays,
  contentResearchKindFor,
  contentResearchKindMeta,
  hasContentFreshnessSection,
  isoOrNull,
  publishedAtFrom,
  renderContentFreshnessSection,
  summarizeContentFreshness,
} from './content-source-freshness.js';

export {
  CONTENT_FRESHNESS_HEADING,
  CONTENT_LIVE_RESEARCH_KINDS,
  annotateContentSourceFreshness,
  contentFreshnessPromptBlock,
  contentFreshnessWindowDays,
  contentResearchKindFor,
  hasContentFreshnessSection,
  renderContentFreshnessSection,
  summarizeContentFreshness,
};

export const CONTENT_LIVE_RESEARCH_SCHEMA = 'nanowork.content-live-research/1';

const KEYLESS_PROVIDERS = new Set(['DuckDuckGo', 'Google News RSS']);
const TIERED_LANES = new Set(['tinyfish', 'claude_websearch']);
const DEFAULT_MAX_ITEMS = 8;
const DEFAULT_TIMEOUT_MS = 150_000;
const SEARCH_API_TIMEOUT_MS = 9_000;
const CONTROLLED_FETCH_TIMEOUT_MS = 15_000;
const CONTROLLED_FETCH_LIMIT = 8;

function safeText(value, max = 2_000) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./u, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 当前进程内真实可用的联网通道。免 Key 的 DuckDuckGo / Google News 不计入
 * “已配置”——它们只是配置通道全部失效后的灾备，不能让“未配置”被虚报成可用。
 */
export function contentLiveResearchReadiness() {
  const tiered = agenticWebResearchReadiness();
  const searchApis = webSearchProviders().filter(name => !['TinyFish', 'Claude WebSearch'].includes(name));
  const lanes = [
    {
      key: 'tinyfish',
      label: 'TinyFish Search + Fetch',
      ready: tiered.primaryReady === true,
      role: 'primary',
    },
    {
      key: 'claude_websearch',
      label: 'Claude CLI WebSearch（云雾网关）',
      ready: tiered.fallbackReady === true,
      cliReady: tiered.cliReady === true,
      credentialReady: tiered.credentialReady === true,
      role: 'fallback',
    },
    {
      key: 'search_api',
      label: searchApis.length
        ? `商业检索 API（${searchApis.join(' / ')}）`
        : '商业检索 API（博查 / Tavily / Serper）',
      ready: searchApis.length > 0,
      providers: searchApis,
      role: 'api_fallback',
    },
  ];
  const configured = lanes.some(lane => lane.ready);
  return {
    configured,
    lanes,
    cliAvailable: tiered.cliReady === true,
    summary: configured
      ? `联网检索已启用：${lanes.filter(lane => lane.ready).map(lane => lane.label).join(' → ')}`
      : '联网检索未配置：TinyFish / Claude CLI / 博查 / Tavily / Serper 均未就绪',
  };
}

function laneForProvider(provider) {
  const name = String(provider || '');
  if (/tinyfish/iu.test(name)) return 'tinyfish';
  if (/claude/iu.test(name)) return 'claude_websearch';
  if (KEYLESS_PROVIDERS.has(name)) return 'keyless_fallback';
  if (name) return 'search_api';
  return null;
}

function buildQuery({ kind, brief, platform, channels }) {
  const meta = contentResearchKindMeta(kind);
  const topic = safeText(brief, 400);
  return [
    `内容生产岗位：${meta.label}`,
    `主题：${topic}`,
    platform ? `目标平台：${safeText(platform, 60)}` : '',
    channels?.length
      ? `覆盖渠道：${channels.map(item => safeText(item, 40)).filter(Boolean).join('、')}`
      : '',
    `检索重点：${meta.roleHints}`,
    '只返回公开网页候选，并尽量给出每条来源的发布时间；最终只使用受控 WebFetch 读取成功的正文。',
  ].filter(Boolean).join('\n');
}

function compactQuery({ kind, brief, platform }) {
  const meta = contentResearchKindMeta(kind);
  return safeText([safeText(brief, 120), platform, meta.roleHints].filter(Boolean).join(' '), 180);
}

function normalizedCandidates(rows, limit) {
  const seen = new Set();
  const output = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const url = safeHttpUrl(row?.url);
    const title = safeText(row?.title, 300);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    output.push({
      title,
      url,
      snippet: safeText(row?.snippet || row?.body, 1_600),
      publishedAt: publishedAtFrom(row),
      source: safeText(row?.source || row?.channel, 120) || hostOf(url),
    });
    if (output.length >= limit) break;
  }
  return output;
}

function unavailable({ kind, query, readiness, fetchedAt, note, status = 'unavailable', provenance = {} }) {
  return {
    schemaVersion: CONTENT_LIVE_RESEARCH_SCHEMA,
    ok: false,
    status,
    kind,
    querySha256: fingerprint(query),
    items: [],
    fetchedAt,
    freshness: summarizeContentFreshness([], {
      freshnessWindowDays: contentFreshnessWindowDays(kind),
      fetchedAt,
    }),
    lane: null,
    provider: null,
    note,
    provenance: {
      schemaVersion: CONTENT_LIVE_RESEARCH_SCHEMA,
      readiness,
      lanesAttempted: [],
      failures: [],
      externalCall: false,
      templateFallbackUsed: false,
      cliFallback: { triggered: false, reason: null },
      ...provenance,
    },
    cost: { lane: null, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, credits: null },
  };
}

/**
 * 统一入口。
 *
 * @param {object} params
 * @param {'trend'|'intel'|'decompose'} params.kind
 * @param {string} params.brief 业务主题/任务说明（已净化，不含租户私有资料）
 * @param {string} [params.platform]
 * @param {string[]} [params.channels]
 * @param {number} [params.tenantId] 只用于证据归属，不参与检索
 * @param {{maxItems?:number,timeoutMs?:number,freshnessWindowDays?:number}} [params.budget]
 * @param {AbortSignal} [params.signal]
 */
export async function runContentLiveResearch({
  kind,
  brief,
  platform = null,
  channels = [],
  tenantId = null,
  budget = {},
  signal = null,
  now = () => new Date(),
  // 依赖注入只服务测试与私有部署；生产默认走同一条真实链路。
  readinessFn = contentLiveResearchReadiness,
  agenticWebResearchFn = agenticWebResearch,
  webSearchFn = webSearch,
  controlledWebFetchFn = fetchControlledWebEvidence,
} = {}) {
  const resolvedKind = contentResearchKindFor(kind);
  if (!resolvedKind) {
    throw Object.assign(new Error(`不支持的内容联网检索类型：${String(kind)}`), {
      status: 400,
      code: 'CONTENT_LIVE_RESEARCH_KIND_INVALID',
    });
  }
  const topic = safeText(brief, 4_000);
  if (!topic) {
    throw Object.assign(new Error('联网检索主题不能为空'), {
      status: 400,
      code: 'CONTENT_LIVE_RESEARCH_BRIEF_REQUIRED',
    });
  }
  const meta = contentResearchKindMeta(resolvedKind);
  const startedAt = isoOrNull(now()) || new Date().toISOString();
  const readiness = readinessFn();
  const query = buildQuery({ kind: resolvedKind, brief: topic, platform, channels });
  const maxItems = Math.max(1, Math.min(20, Number(budget?.maxItems) || DEFAULT_MAX_ITEMS));
  const timeoutMs = Math.max(5_000, Math.min(600_000, Number(budget?.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const freshnessWindowDays = Math.max(
    1,
    Number(budget?.freshnessWindowDays) || contentFreshnessWindowDays(resolvedKind),
  );

  if (!readiness.configured) {
    return unavailable({
      kind: resolvedKind,
      query,
      readiness,
      fetchedAt: startedAt,
      note: '联网检索未配置：请在接口管理中配置 TinyFish、Claude CLI（云雾）或博查 / Tavily / Serper 任一通道；未配置前不会用模板或模型记忆冒充实时信息。',
    });
  }

  const lanesAttempted = [];
  const failures = [];
  let candidates = [];
  let lane = null;
  let provider = null;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let costUsd = 0;
  let agenticEvidence = null;

  const tieredLaneReady = readiness.lanes.some(item => TIERED_LANES.has(item.key) && item.ready);
  if (tieredLaneReady) {
    lanesAttempted.push('tiered_agentic');
    try {
      const agentic = await agenticWebResearchFn(query, {
        maxResults: Math.max(5, Math.min(20, maxItems + 4)),
        timeoutMs: Math.min(timeoutMs, DEFAULT_TIMEOUT_MS),
        signal,
        researchMode: 'content_business',
      });
      agenticEvidence = agentic?.evidence || null;
      const raw = [
        ...(Array.isArray(agentic?.fetchCandidates) ? agentic.fetchCandidates : []),
        ...(Array.isArray(agentic?.results) ? agentic.results : []),
      ];
      const agenticUsage = agentic?.evidence?.usage || agentic?.usage || {};
      usage = {
        inputTokens: Number(agenticUsage.inputTokens || agenticUsage.input_tokens || 0) || 0,
        outputTokens: Number(agenticUsage.outputTokens || agenticUsage.output_tokens || 0) || 0,
      };
      costUsd = Number(agentic?.evidence?.costUsd || agentic?.costUsd || 0) || 0;
      if (agentic?.ok === true && agentic?.candidateReady === true && raw.length) {
        candidates = normalizedCandidates(raw, maxItems * 2);
        lane = laneForProvider(agentic.provider) || 'tinyfish';
        provider = agentic.provider || null;
      } else {
        failures.push({
          lane: 'tiered_agentic',
          note: safeText(agentic?.note || '分层联网检索未形成可核验候选', 200),
          code: safeText(agentic?.evidence?.failureCode || agentic?.evidence?.fallback?.reasonCode || '', 80) || null,
        });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push({
        lane: 'tiered_agentic',
        note: safeText(error?.message || '分层联网检索执行失败', 200),
        code: safeText(error?.code || 'AGENTIC_RESEARCH_FAILED', 80),
      });
    }
  }

  if (!candidates.length) {
    lanesAttempted.push('search_api');
    try {
      const searched = await webSearchFn(compactQuery({ kind: resolvedKind, brief: topic, platform }), {
        max: Math.max(5, Math.min(10, maxItems + 2)),
        timeoutMs: SEARCH_API_TIMEOUT_MS,
        signal,
        skipTiered: true,
        fallbackOrder: meta.fallbackOrder,
      });
      if (searched?.ok && Array.isArray(searched.results) && searched.results.length) {
        candidates = normalizedCandidates(searched.results, maxItems * 2);
        lane = laneForProvider(searched.provider) || 'search_api';
        provider = searched.provider || null;
      } else {
        failures.push({
          lane: 'search_api',
          note: safeText(searched?.note || '商业检索 API 未命中', 300),
          code: 'SEARCH_API_NO_RESULTS',
        });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push({
        lane: 'search_api',
        note: safeText(error?.message || '商业检索 API 执行失败', 200),
        code: safeText(error?.code || 'SEARCH_API_FAILED', 80),
      });
    }
  }

  const fetchedAt = isoOrNull(now()) || new Date().toISOString();
  const cliFallback = lane && !TIERED_LANES.has(lane)
    ? {
      triggered: true,
      reason: tieredLaneReady
        ? 'tiered_lane_no_candidates'
        : readiness.cliAvailable
          ? 'tiered_lane_unconfigured'
          : 'claude_cli_unavailable',
    }
    : { triggered: false, reason: null };
  const baseProvenance = {
    schemaVersion: CONTENT_LIVE_RESEARCH_SCHEMA,
    tenantId: tenantId == null ? null : Number(tenantId),
    readiness,
    lanesAttempted,
    failures,
    agentic: agenticEvidence,
    externalCall: lanesAttempted.length > 0,
    templateFallbackUsed: false,
    cliFallback,
  };

  if (!candidates.length) {
    return unavailable({
      kind: resolvedKind,
      query,
      readiness,
      fetchedAt,
      status: 'no_results',
      note: `联网检索已执行但未取得可核验来源：${failures.map(item => item.note).filter(Boolean).join('；') || '所有通道均未命中'}`,
      provenance: baseProvenance,
    });
  }

  const sanitized = sanitizePublicSources(candidates, { stage: 'content_live_research_candidate' });
  const ranked = rankControlledFetchCandidates(sanitized.accepted, { task: { title: topic } });
  let controlled = { results: [], evidence: { failures: [] }, provider: null };
  lanesAttempted.push('controlled_fetch');
  try {
    controlled = await controlledWebFetchFn(ranked.slice(0, CONTROLLED_FETCH_LIMIT), {
      limit: CONTROLLED_FETCH_LIMIT,
      timeoutMs: CONTROLLED_FETCH_TIMEOUT_MS,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    failures.push({
      lane: 'controlled_fetch',
      note: safeText(error?.message || '受控网页正文核验失败', 200),
      code: safeText(error?.code || 'CONTROLLED_WEB_FETCH_FAILED', 80),
    });
  }
  const controlledQuality = sanitizePublicSources(controlled?.results, { stage: 'content_live_research_controlled' });
  const matched = retainControlledSourceMatches(ranked, controlledQuality.accepted, {
    stage: 'content_live_research_controlled_match',
  });
  const controlledByUrl = new Map(matched.accepted.map(item => [item.url, item]));

  const merged = ranked.map(candidate => {
    const page = controlledByUrl.get(candidate.url);
    const body = page ? safeText(page.body, 4_000) : null;
    return {
      title: safeText(page?.title || candidate.title, 300),
      url: candidate.url,
      source: candidate.source || hostOf(candidate.url),
      snippet: safeText(page?.snippet || candidate.snippet, 1_600),
      body,
      bodySha256: body ? fingerprint(body) : null,
      controlledBody: Boolean(page),
      publishedAt: publishedAtFrom(page, candidate),
      fetchedAt: isoOrNull(page?.fetchedAt) || fetchedAt,
      lane,
    };
  })
    .sort((left, right) => Number(right.controlledBody) - Number(left.controlledBody))
    .slice(0, maxItems);

  const { items, freshness } = annotateContentSourceFreshness(merged, {
    kind: resolvedKind,
    fetchedAt,
    freshnessWindowDays,
    platform,
  });
  const verifiedCount = items.filter(item => item.controlledBody).length;
  const status = verifiedCount >= meta.minimumItems ? 'completed' : 'insufficient_evidence';

  return {
    schemaVersion: CONTENT_LIVE_RESEARCH_SCHEMA,
    ok: status === 'completed',
    status,
    kind: resolvedKind,
    querySha256: fingerprint(query),
    lane,
    provider,
    items,
    fetchedAt,
    freshness,
    freshnessSection: renderContentFreshnessSection({ freshness, lane, provider, kind: resolvedKind }),
    note: status === 'completed'
      ? null
      : `受控网页正文核验只取得 ${verifiedCount}/${meta.minimumItems} 条，其余来源只有检索摘要，不能作为已核验事实`,
    provenance: {
      ...baseProvenance,
      candidateCount: candidates.length,
      candidateRejected: sanitized.rejected,
      controlledFetch: {
        provider: controlled?.provider || null,
        requested: Math.min(ranked.length, CONTROLLED_FETCH_LIMIT),
        verifiedBodyCount: verifiedCount,
        failures: Array.isArray(controlled?.evidence?.failures) ? controlled.evidence.failures : [],
        rejected: [...controlledQuality.rejected, ...matched.rejected],
      },
      startedAt,
      completedAt: fetchedAt,
    },
    cost: {
      lane,
      usage,
      costUsd,
      credits: null,
    },
  };
}

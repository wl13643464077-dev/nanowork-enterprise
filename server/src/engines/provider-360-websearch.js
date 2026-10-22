import { selectedProviderCredentials } from './ai-provider-selection.js';
import {
  responseRequestId,
  supplierRequestCost,
} from './yunwu.js';
import {
  providerResponseError,
  sanitizeProviderError,
} from './provider-errors.js';

const PROVIDER_360_ORIGIN = 'https://api.360.cn';
const SEARCH_ENDPOINT = `${PROVIDER_360_ORIGIN}/v1/chat/completions`;
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6';
const MAX_RESPONSE_BYTES = 2_000_000;
const MODEL = /^anthropic\/claude-[A-Za-z0-9.-]{1,80}$/u;

function safeText(value, max = 1_000) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

// Search APIs expect a query, not the employee's full instruction prompt.
// Keep extraction shared with the TinyFish entry so both routes use the same
// task entities, including when the actual task appears after a long role brief.
export function publicResearchSearchQuery(value, { searchQuery = null } = {}) {
  const explicit = typeof searchQuery === 'string' && searchQuery.trim();
  const lines = String(explicit || value || '')
    .split(/\r?\n/u)
    .map(line => safeText(line, 4_000))
    .filter(Boolean);
  const searchRows = lines.flatMap(line => {
    const match = line.match(/^(?:(?:岗位技能)?取证查询|检索查询|搜索查询|searchQuery)\s*\d*\s*[:：]\s*(.+)$/iu);
    return match ? [match[1]] : [];
  });
  const taskRows = lines.flatMap(line => {
    const match = line.match(/^(?:老板的任务|具体要求|选题|检索任务|任务目标|打开并核验|公开链接)\s*[:：]\s*(.+)$/u);
    return match ? [match[1]] : [];
  });
  const hasRoleContext = lines.some(line => /^(?:数字员工|岗位职责)\s*[:：]/u.test(line));
  const selected = explicit
    ? lines
    : searchRows.length
      ? searchRows
      : taskRows.length
        ? taskRows
        : hasRoleContext
          ? lines.filter(line => !/^(?:数字员工|岗位职责|当前员工技能驱动|必须|不得|优先|地点类任务)/u.test(line))
          : lines;
  const seen = new Set();
  const unique = selected.filter(line => {
    const key = line.replace(/\s+/gu, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return safeText(unique.slice(0, 4).join(' '), 400);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function configuredModel() {
  const explicit = String(
    process.env.NANOWORK_360_RESEARCH_MODEL
      || process.env.NANOWORK_RESEARCH_MODEL
      || '',
  ).trim();
  return MODEL.test(explicit) ? explicit : DEFAULT_MODEL;
}

function providerCredentials() {
  try {
    const credentials = selectedProviderCredentials();
    const url = new URL(credentials?.baseUrl || '');
    if (credentials?.id !== '360' || url.origin !== PROVIDER_360_ORIGIN || !credentials.apiKey) return null;
    return credentials;
  } catch {
    return null;
  }
}

export function provider360ClaudeWebSearchReadiness() {
  const credentials = providerCredentials();
  return {
    ready: Boolean(credentials),
    credentialReady: Boolean(credentials),
    cliReady: false,
    cliPath: null,
    transport: '360_search_api',
    model: configuredModel(),
    provider: '360 Claude WebSearch API',
  };
}

function responseModelMatches(requested, actual) {
  if (typeof actual !== 'string' || !actual.trim()) return false;
  // 360 has returned softwareone/anthropic/claude-sonnet-4.6 for the requested
  // anthropic/claude-sonnet-4-6. Normalize only this observed model alias and
  // retain the existing route-prefix matching; never fold arbitrary versions,
  // families or suffixes. The original response model remains in the receipt.
  const canonical = value => value.replace(/(^|\/)claude-sonnet-4\.6$/u, '$1claude-sonnet-4-6');
  const expected = canonical(requested);
  const reported = canonical(actual);
  const leaf = expected.split('/').at(-1);
  return reported === expected || reported === leaf || reported.endsWith(`/${leaf}`);
}

function contextCandidates(payload, limit, requestId) {
  const records = Array.isArray(payload?.context?.web_search_records)
    ? payload.context.web_search_records
    : [];
  const seen = new Set();
  const output = [];
  for (const [recordIndex, record] of records.slice(0, 100).entries()) {
    const url = safeHttpUrl(record?.url);
    const title = safeText(record?.title, 220);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    output.push({
      title,
      url,
      snippet: safeText(record?.summary, 1_000),
      publishedAt: safeText(record?.date, 80) || null,
      // This provenance is constructed from the provider-owned record itself;
      // neither model prose nor fields supplied by the record can overwrite it.
      sourceProvenance: Object.freeze({
        schemaVersion: 'nanowork.web-search-candidate/1',
        provider: '360',
        transport: '360_search_api',
        sourcePath: 'context.web_search_records',
        recordIndex,
        url,
        requestId,
      }),
    });
    if (output.length >= limit) break;
  }
  return output;
}

async function jsonResponse(response) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw providerResponseError(502, {}, { service: '360联网检索服务' });
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw providerResponseError(502, {}, { service: '360联网检索服务' });
  }
  try {
    return JSON.parse(text);
  } catch {
    // An HTML/text authentication or rate-limit response still carries a
    // useful HTTP status; parsing it must not turn every failure into HTTP 502.
    throw providerResponseError(response.ok ? 502 : response.status, {}, { service: '360联网检索服务' });
  }
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(240_000, Number(timeoutMs) || 60_000)));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * 360's Claude-format Messages endpoint currently reports a search count but
 * does not return attributable result blocks for the enabled Claude routes.
 * Search Enhancement returns the provider-owned `context.web_search_records`,
 * so only those records become candidates. Text generated by the model is
 * deliberately ignored for source attribution.
 */
export async function run360ClaudeWebSearch(query, {
  searchQuery: explicitSearchQuery = null,
  maxResults = 12,
  timeoutMs = 60_000,
  signal = null,
  onProgress = null,
  fetchFn = globalThis.fetch,
  costFn = supplierRequestCost,
} = {}) {
  const readiness = provider360ClaudeWebSearchReadiness();
  const credentials = providerCredentials();
  if (!readiness.ready || !credentials) {
    return {
      attempted: false,
      ok: false,
      candidateReady: false,
      provider: readiness.provider,
      results: [],
      note: '360联网检索凭证未配置',
      evidence: { ...readiness, toolCalls: 0, externalCall: false },
    };
  }
  const searchQuery = publicResearchSearchQuery(query, { searchQuery: explicitSearchQuery });
  const normalizedQuery = safeText(query, 4_000) || searchQuery;
  if (!searchQuery) {
    return {
      attempted: false,
      ok: false,
      candidateReady: false,
      provider: readiness.provider,
      results: [],
      note: '360联网检索任务为空，未取得可执行的搜索查询',
      evidence: { ...readiness, toolCalls: 0, externalCall: false },
    };
  }

  const requestBody = {
    model: readiness.model,
    messages: [
      {
        role: 'system',
        content: '只根据搜索增强上下文简短回复，不得凭记忆补链接。来源由应用从上游响应的context.web_search_records独立核验。',
      },
      { role: 'user', content: normalizedQuery },
    ],
    // Candidates come only from context.web_search_records; generated prose
    // is unused, so a short response budget avoids unnecessary generation.
    max_tokens: 64,
    stream: false,
    tools: [
      {
        type: 'web_search',
        web_search: {
          search_mode: 'always',
          search_query: searchQuery,
        },
      },
    ],
  };

  try {
    onProgress?.({
      kind: 'search',
      tool: '360 Claude WebSearch API',
      query: searchQuery,
      at: new Date().toISOString(),
    });
    const response = await fetchFn(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      redirect: 'error',
      signal: combinedSignal(signal, timeoutMs),
    });
    const payload = await jsonResponse(response);
    if (!response.ok || payload?.error) {
      throw providerResponseError(response.ok ? 502 : response.status, payload, {
        service: '360联网检索服务',
      });
    }
    if (!responseModelMatches(readiness.model, payload?.model)) {
      throw providerResponseError(502, {}, { service: '360联网检索服务' });
    }
    const sourceLimit = Math.max(5, Math.min(60, (Number(maxResults) || 12) * 5));
    const candidates = contextCandidates(payload, sourceLimit, responseRequestId(response));
    const candidateReady = candidates.length >= 1;
    const inputTokens = Number(payload?.usage?.prompt_tokens || 0);
    const outputTokens = Number(payload?.usage?.completion_tokens || 0);
    const receiptModel = safeText(payload.model, 160);
    const receipt = await costFn({
      requestId: responseRequestId(response),
      model: receiptModel,
      response: payload,
      providerId: '360',
    });
    const supplierCosts = receipt ? [receipt] : [];
    const result = {
      attempted: true,
      ok: candidateReady,
      candidateReady,
      provider: readiness.provider,
      results: [],
      note: candidateReady
        ? null
        : '360联网检索已执行，但没有返回可打开的真实网页候选',
      evidence: {
        schemaVersion: 'nanowork.agentic-web-research/1',
        executionMode: 'provider_360_search_enhancement',
        transport: readiness.transport,
        model: readiness.model,
        actualModel: receiptModel,
        providerRoute: ['claude_websearch'],
        toolAttempts: 1,
        // A successful provider context batch is stronger attribution evidence
        // than URLs appearing in model prose. Do not infer calls from prose.
        toolCalls: candidates.length ? 1 : 0,
        toolCallEvidence: candidates.length ? 'context.web_search_records' : 'none',
        providerRecordCount: candidates.length,
        ...(candidateReady ? {} : {
          failureCode: 'PROVIDER_360_SEARCH_NO_CANDIDATES',
        }),
        candidateGate: {
          requiredCandidates: 1,
          observedCandidates: candidates.length,
          sourcePath: 'context.web_search_records',
          passed: candidateReady,
          requiresControlledWebFetch: true,
        },
        qualityGate: {
          requiredSources: 5,
          observedSources: 0,
          passed: false,
          pendingControlledWebFetch: candidateReady,
        },
        queries: [searchQuery],
        steps: [{
          id: null,
          kind: 'search',
          tool: '360 Claude WebSearch API',
          query: searchQuery,
          at: new Date().toISOString(),
        }],
        usage: {
          inputTokens: Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : 0,
          outputTokens: Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : 0,
          cacheReadInputTokens: Number(payload?.usage?.prompt_cache_hit_tokens || 0) || 0,
          supplierCosts,
        },
        supplierCosts,
        costYuan: receipt?.status === 'known' ? Number(receipt.costYuanOverride) : null,
        costStatus: receipt?.status || 'pending',
        costUsd: 0,
        externalCall: true,
        sourceTextTrusted: false,
        sourceRecordsTrusted: candidates.length > 0,
        credentialMode: credentials.billingMode,
      },
    };
    Object.defineProperty(result, 'fetchCandidates', {
      value: candidates,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return result;
  } catch (error) {
    if (signal?.aborted) {
      throw Object.assign(new Error('联网工具执行已取消'), {
        status: 499,
        code: 'AGENTIC_RESEARCH_ABORTED',
      });
    }
    // AbortSignal.timeout rejects with TimeoutError, whereas the shared
    // sanitizer's historical timeout contract accepts AbortError only.
    const safe = sanitizeProviderError(error?.name === 'TimeoutError'
      ? { name: 'AbortError' }
      : error, { service: '360联网检索服务' });
    Object.defineProperties(safe, {
      code: { value: `PROVIDER_360_SEARCH_${safe.providerReason.toUpperCase()}`, enumerable: true, configurable: true },
      transport: { value: readiness.transport, enumerable: true, configurable: true },
    });
    throw safe;
  }
}

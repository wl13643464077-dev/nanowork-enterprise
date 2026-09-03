import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../db.js';
import { yunwuApiKey } from './yunwu.js';
import {
  tinyfishAvailable,
  tinyfishFetchPages,
  tinyfishSearch,
} from './tinyfish.js';

const DEFAULT_MODEL = 'claude-opus-4-8';
const MAX_STDERR_BYTES = 8192;
const MAX_RESULT_BYTES = 2_000_000;
const PUBLIC_ENV_KEYS = new Set([
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
]);
const SANDBOX_PROXY_ENV_KEYS = new Set([
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY',
  'https_proxy', 'http_proxy', 'all_proxy',
  'NO_PROXY', 'no_proxy',
]);

function safeText(value, max = 1000) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '')
    .replace(/\s+/gu, ' ').trim().slice(0, max);
}

function researchBaseUrl() {
  const raw = String(
    getConfig('yunwu_base_url', null)
      || process.env.YUNWU_BASE_URL
      || 'https://yunwu.ai',
  ).trim().replace(/\/+$/u, '');
  return raw.replace(/\/v1$/u, '');
}

function cliCandidates() {
  return [
    process.env.CONTENTCREW_CLAUDE_PATH,
    '/Users/wanglei/.local/bin/claude',
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ].map(value => String(value || '').trim()).filter(Boolean);
}

export function resolveAgenticResearchCli() {
  return cliCandidates().find(candidate => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || null;
}

function claudeGatewayReadiness() {
  const cliPath = resolveAgenticResearchCli();
  const apiKey = yunwuApiKey();
  return {
    ready: Boolean(cliPath && apiKey),
    cliReady: Boolean(cliPath),
    credentialReady: Boolean(apiKey),
    cliPath: cliPath ? path.basename(cliPath) : null,
    model: process.env.NANOWORK_RESEARCH_MODEL || DEFAULT_MODEL,
    provider: 'Yunwu Claude WebSearch gateway',
  };
}

export function agenticWebResearchReadiness() {
  const claude = claudeGatewayReadiness();
  const tinyfishReady = tinyfishAvailable();
  return {
    ...claude,
    ready: tinyfishReady || claude.ready,
    primaryReady: tinyfishReady,
    fallbackReady: claude.ready,
    preferred: 'tinyfish',
    fallback: 'claude_websearch',
    autoFallback: true,
    routes: [
      { key: 'tinyfish', label: 'TinyFish Search + Fetch', ready: tinyfishReady, role: 'primary' },
      { key: 'claude_websearch', label: claude.provider, ready: claude.ready, role: 'fallback' },
    ],
    provider: tinyfishReady
      ? claude.ready
        ? 'TinyFish → Yunwu Claude WebSearch gateway'
        : 'TinyFish Search + Fetch'
      : claude.provider,
  };
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  // Claude CLI 可能再启动网络工具子进程；仅杀直接子进程会让孙进程继续持有
  // stdout/stderr 管道，导致调用方超时后仍卡在 close。
  if (process.platform !== 'win32' && Number.isSafeInteger(child.pid)) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (error) {
      if (error?.code === 'ESRCH') return;
    }
  }
  try { child.kill('SIGKILL'); } catch { /* process already exited */ }
}

function hostnameFromGatewayUrl(baseUrl) {
  try {
    const raw = String(baseUrl || '').trim();
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const hostname = String(parsed.hostname || '').trim().toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) return null;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return null;
    if (!/^[a-z0-9.-]+$/u.test(hostname) || hostname.length > 253) return null;
    return hostname;
  } catch {
    return null;
  }
}

export function researchGatewayHosts(baseUrl = researchBaseUrl()) {
  const hostname = hostnameFromGatewayUrl(baseUrl) || 'yunwu.ai';
  const apex = hostname.replace(/^www\./u, '');
  const hosts = [apex, `*.${apex}`];
  if (apex === 'yunwu.ai' || apex.endsWith('.yunwu.ai')) hosts.push('api.yunwu.ai');
  return [...new Set(hosts)];
}

function inheritedProxyLooksLikeAllowlistSandbox(env = process.env) {
  const cursorMarked = env.CURSOR_AGENT === '1'
    || env.CURSOR_SANDBOX === '1'
    || Boolean(env.__CURSOR_SANDBOX_ENV_RESTORE);
  if (!cursorMarked) return false;
  const proxy = String(
    env.HTTPS_PROXY
      || env.https_proxy
      || env.HTTP_PROXY
      || env.http_proxy
      || env.ALL_PROXY
      || env.all_proxy
      || '',
  ).trim();
  if (!proxy) return false;
  try {
    const url = new URL(proxy);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  } catch {
    return false;
  }
}

function writeResearchNetworkSettings(configDir, allowedDomains) {
  const settingsPath = path.join(configDir, 'research-network.json');
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify({ sandbox: { network: { allowedDomains } } })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return settingsPath;
}

function safeRunnerEnv(runtimeRoot) {
  const dropAllowlistProxy = inheritedProxyLooksLikeAllowlistSandbox(process.env);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      if (!PUBLIC_ENV_KEYS.has(key)) return false;
      if (dropAllowlistProxy && SANDBOX_PROXY_ENV_KEYS.has(key)) return false;
      return true;
    }),
  );
  const home = path.join(runtimeRoot, 'home');
  const claudeConfigDir = path.join(home, 'claude');
  for (const directory of [
    home,
    path.join(home, 'config'),
    path.join(home, 'cache'),
    path.join(home, 'data'),
    path.join(home, 'tmp'),
    claudeConfigDir,
  ]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const allowedDomains = researchGatewayHosts();
  const settingsPath = writeResearchNetworkSettings(claudeConfigDir, allowedDomains);
  return {
    env: {
      ...env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'config'),
      XDG_CACHE_HOME: path.join(home, 'cache'),
      XDG_DATA_HOME: path.join(home, 'data'),
      TMPDIR: path.join(home, 'tmp'),
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_SAFE_MODE: '1',
      IS_SANDBOX: '1',
      ANTHROPIC_BASE_URL: researchBaseUrl(),
      ANTHROPIC_AUTH_TOKEN: yunwuApiKey(),
    },
    settingsPath,
    allowedDomains,
    droppedAllowlistProxy: dropAllowlistProxy,
  };
}

function researchCliFailureMessage(resultEvent, processResult) {
  const blob = safeText([
    resultEvent?.result,
    resultEvent?.error,
    resultEvent?.errors,
  ].filter(Boolean).join(' '), 2_000);
  if (/sandbox network policy|not on allow list|blocked by sandbox|CONNECT tunnel failed/iu.test(blob)) {
    return '云雾联网工具执行失败：运行环境拦截了对上游的访问';
  }
  if (
    resultEvent?.error === 'authentication_failed'
    || /failed to authenticate|invalid api key|unauthorized|鉴权/iu.test(blob)
  ) {
    return '云雾联网工具执行失败：上游鉴权未通过';
  }
  if (!resultEvent && Number.isInteger(processResult?.code) && processResult.code !== 0) {
    return `云雾联网工具执行失败：进程退出码${processResult.code}`;
  }
  return '云雾联网工具执行失败';
}

function extractJsonObject(value) {
  const text = String(value || '');
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, index + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function normalizedSources(payload, limit, allowedUrls = null) {
  const source = Array.isArray(payload?.sources) ? payload.sources : [];
  const seen = new Set();
  const output = [];
  for (const item of source) {
    const url = safeHttpUrl(item?.url || item?.source_url);
    const title = safeText(item?.title || item?.source_title, 220);
    const snippet = safeText(
      item?.snippet
        || item?.summary
        || (Array.isArray(item?.claims) ? item.claims.join('；') : ''),
      800,
    );
    if (!url || !title || seen.has(url) || (allowedUrls && !allowedUrls.has(url))) continue;
    seen.add(url);
    output.push({ title, url, snippet, publishedAt: safeText(item?.publishedAt || item?.date, 80) || null });
    if (output.length >= limit) break;
  }
  return output;
}

function toolResultCandidates(toolResults, limit) {
  const seen = new Set();
  const output = [];
  const queues = toolResults
    .filter(result => result?.success)
    .map(result => [...(result.urls || [])]);
  // 各次 WebSearch 轮流取候选，不能让第一条搜索返回的十几个SEO链接
  // 吞掉后续“官网/具体商户/菜单评价”查询的真实URL。
  while (queues.some(queue => queue.length) && output.length < limit) {
    for (const queue of queues) {
      while (queue.length) {
        const value = queue.shift();
        const url = safeHttpUrl(value);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        let title = 'WebSearch公开网页候选';
        try { title = new URL(url).hostname; } catch { /* safeHttpUrl already checked */ }
        output.push({
          title,
          url,
          snippet: '该URL来自本次真实WebSearch工具结果，必须经应用受控WebFetch读取正文后才可作为业务证据。',
          publishedAt: null,
        });
        break;
      }
      if (output.length >= limit) break;
    }
  }
  return output;
}

function mergeSourceCandidates(primary, secondary, limit) {
  const seen = new Set();
  const output = [];
  for (const item of [...primary, ...secondary]) {
    const url = safeHttpUrl(item?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    output.push({ ...item, url });
    if (output.length >= limit) break;
  }
  return output;
}

function normalizedFacts(payload, allowedUrls) {
  const source = Array.isArray(payload?.facts) ? payload.facts : [];
  const facts = [];
  let rejected = 0;
  for (const item of source.slice(0, 80)) {
    const claim = safeText(item?.claim, 800);
    const urls = [...new Set((Array.isArray(item?.sourceUrls) ? item.sourceUrls : [])
      .map(safeHttpUrl).filter(Boolean))];
    if (!claim || !urls.length || urls.some(url => !allowedUrls.has(url))) {
      rejected += 1;
      continue;
    }
    facts.push({
      claim,
      sourceUrls: urls,
      confidence: ['high', 'medium', 'low'].includes(item?.confidence)
        ? item.confidence
        : 'low',
    });
    if (facts.length >= 40) break;
  }
  return { facts, rejected };
}

function toolStepsFromEvent(event, steps, onProgress) {
  if (event?.type !== 'assistant') return;
  const blocks = Array.isArray(event?.message?.content) ? event.message.content : [];
  for (const block of blocks) {
    if (block?.type !== 'tool_use') continue;
    const name = safeText(block.name, 80);
    const input = block.input && typeof block.input === 'object' ? block.input : {};
    const query = name === 'WebSearch' ? safeText(input.query, 500) : '';
    const step = {
      id: safeText(block.id, 120) || null,
      kind: name === 'WebSearch' ? 'search' : 'tool',
      tool: name || 'unknown',
      query: query || null,
      at: new Date().toISOString(),
    };
    steps.push(step);
    try { onProgress?.(step); } catch { /* observability never breaks execution */ }
  }
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => (
    typeof item === 'string' ? item : item?.type === 'text' ? item.text : ''
  )).filter(Boolean).join('\n');
}

function toolResultsFromEvent(event, toolResults) {
  if (event?.type !== 'user') return;
  const blocks = Array.isArray(event?.message?.content) ? event.message.content : [];
  for (const block of blocks) {
    if (block?.type !== 'tool_result') continue;
    const text = toolResultText(block.content);
    const permissionDenied = /(?:permission|权限).{0,80}(?:denied|未授予|拒绝|not\s+granted|haven't\s+granted|not\s+permitted)|not\s+allowed/iu.test(text);
    const urls = [...new Set((text.match(/https?:\/\/[^\s"'<>]+/giu) || [])
      .map(value => safeHttpUrl(value.replace(/[)>\]}.;,!?，。；！？）】》]+$/gu, '')))
      .filter(Boolean))];
    toolResults.push({
      toolUseId: safeText(block.tool_use_id, 120) || null,
      success: block.is_error !== true && !permissionDenied,
      isError: block.is_error === true,
      permissionDenied,
      urlCount: urls.length,
      urls,
    });
  }
}

function promptFor(query, maxResults, researchMode = 'location_business') {
  if (researchMode === 'employee_skill_learning') {
    return `【已净化的公开岗位进修检索任务】\n${safeText(query, 12_000)}\n\n` +
      `你必须真实调用 WebSearch 至少5次，分别覆盖：官方产品或平台文档、最近三个月规则变化、权威方法论、可执行工具用法、带原始出处的业务案例。` +
      `只能检索公开岗位主题，不得索取或推断企业内部资料、员工私有档案、现有技能详情、账号登录态或本地文件。` +
      `只返回一个合法JSON对象：` +
      `{"queries":["真实执行过的查询"],"sources":[{"title":"来源原始标题","url":"完整https URL","snippet":"该来源直接支持的事实","publishedAt":"可空"}],` +
      `"facts":[{"claim":"事实","sourceUrls":["必须来自sources.url"],"confidence":"high|medium|low"}],"gaps":["仍无法由公开来源核验的缺口"]}。` +
      `sources最多${maxResults}条；优先官方文档、平台规则、权威机构和原始案例，排除翻译页、下载站、SEO推荐榜、获客软文、无关聚合页、站外联系方式和只重复关键词的页面。` +
      `标题和URL必须逐字保留搜索结果，禁止补造。不要输出最终技能卡、业务报告、Markdown或岗位内部资料。`;
  }
  if (researchMode === 'content_business') {
    return `【已净化的公开内容业务检索任务】\n${safeText(query, 12_000)}\n\n` +
      `你必须真实调用 WebSearch 至少5次，覆盖官方平台规则、近期趋势、原始事件或数据、同主题标杆案例、用户讨论或反馈。` +
      `只返回一个合法JSON对象：` +
      `{"queries":["真实执行过的查询"],"sources":[{"title":"来源原始标题","url":"完整https URL","snippet":"该来源直接支持的事实","publishedAt":"可空"}],` +
      `"facts":[{"claim":"事实","sourceUrls":["必须来自sources.url"],"confidence":"high|medium|low"}],"gaps":["仍待核验项"]}。` +
      `sources最多${maxResults}条；优先官方平台、权威机构、原始报道和可回看的具体案例，排除诈骗、翻译页、SEO榜单、泛营销软文、APP下载页和无事实支撑的聚合页。` +
      `标题和URL必须逐字保留搜索结果，禁止补造。不要输出最终内容、Markdown或岗位内部资料。`;
  }
  return `【已净化的公开业务检索任务】\n${safeText(query, 12_000)}\n\n` +
    `你必须真实调用 WebSearch 至少5次，分别覆盖：官方/地图位置、交通与周边需求发生器、直接和间接竞品、菜单价格与评价、近期营业状态或新闻。` +
    `若任务含具体城市、商场、门店或菜品，至少2次搜索必须逐字带上这些实体；其中至少1次优先查品牌/商场官网，至少1次优先查大众点评、美团、携程或其他可回看的具体商户平台页。` +
    `不能要求用户补充网上本可查询的公开信息。只返回一个合法JSON对象：` +
    `{"queries":["真实执行过的查询"],"sources":[{"title":"来源原始标题","url":"完整https URL","snippet":"该来源直接支持的事实","publishedAt":"可空"}],` +
    `"facts":[{"claim":"事实","sourceUrls":["必须来自sources.url"],"confidence":"high|medium|low"}],"gaps":["只写仍需企业私有数据或实地核验的缺口"]}。` +
    `sources最多${maxResults}条；按“与任务直接相关性、权威性、可核验性”排序，优先官方机构/品牌/商场、地图交通、具体门店菜单价格与营业信息、主流媒体和有明确对象的消费者页面。` +
    `排除假证件或站外联系方式页面、翻译词典、无关百科及多语言镜像、SEO推荐榜、GEO/获客推广软文、泛营销博客、房产售楼页、APP下载页、纯导航聚合页和只重复关键词却不支持业务事实的页面。` +
    `具体地点任务不得用地图/等时圈替代餐饮直接证据，也不得用异地同名“吾悦广场店”冒充目标城市门店。` +
    `标题和URL必须逐字保留搜索结果，禁止补造。不要输出最终业务报告、Markdown或岗位内部资料。`;
}

async function claudeAgenticWebResearch(query, {
  maxResults = 12,
  timeoutMs = 240_000,
  signal = null,
  onProgress = null,
  researchMode = 'location_business',
} = {}) {
  const readiness = claudeGatewayReadiness();
  // readiness 对外只暴露 basename，避免把本机目录写进任务证据；真正
  // spawn 必须重新解析绝对可执行路径，不能拿展示字段 cliPath 启动。
  const cliExecutable = resolveAgenticResearchCli();
  if (!readiness.ready) {
    return {
      attempted: false,
      ok: false,
      provider: readiness.provider,
      results: [],
      note: readiness.cliReady ? '云雾联网工具凭据未配置' : 'Claude WebSearch工具执行器未安装',
      evidence: { ...readiness, toolCalls: 0, externalCall: false },
    };
  }
  const normalizedQuery = safeText(query, 12_000);
  if (!normalizedQuery) {
    return {
      attempted: false,
      ok: false,
      provider: readiness.provider,
      results: [],
      note: '公开检索任务为空',
      evidence: { ...readiness, toolCalls: 0, externalCall: false },
    };
  }
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-research-'));
  const workdir = path.join(runtimeRoot, 'work');
  fs.mkdirSync(workdir, { recursive: true, mode: 0o700 });
  const runner = safeRunnerEnv(runtimeRoot);
  const args = [
    '-p', '--safe-mode', '--setting-sources', '', '--settings', runner.settingsPath,
    '--strict-mcp-config',
    '--disable-slash-commands', '--no-session-persistence', '--no-chrome',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', readiness.model,
    '--system-prompt', '你是隔离的公开网络调查代理。只能调用WebSearch并整理可核验公开来源；不接触本地文件、项目、账号登录态或岗位私有资料。',
    '--tools', 'WebSearch',
    '--allowedTools', 'WebSearch',
    '--permission-mode', 'dontAsk',
    '--max-budget-usd', '5',
  ];
  const steps = [];
  const toolResults = [];
  let resultEvent = null;
  let stdoutBuffer = '';
  let stderrBytes = 0;
  let timedOut = false;
  let child = null;
  let processTimer = null;
  let killGraceTimer = null;
  let onAbort = null;
  try {
    child = spawn(cliExecutable, args, {
      cwd: workdir,
      env: runner.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let forceComplete;
    const forcedCompletion = new Promise(resolve => { forceComplete = resolve; });
    const terminate = () => {
      killProcessTree(child);
      if (!killGraceTimer) {
        killGraceTimer = setTimeout(() => {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          forceComplete({
            code: child.exitCode,
            processSignal: child.signalCode || 'SIGKILL',
            forced: true,
          });
        }, 250);
        killGraceTimer.unref?.();
      }
    };
    processTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.max(1, Number(timeoutMs) || 240_000));
    processTimer.unref?.();
    onAbort = () => terminate();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    const processEventLine = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event?.type === 'result') resultEvent = event;
        else {
          toolStepsFromEvent(event, steps, onProgress);
          toolResultsFromEvent(event, toolResults);
        }
      } catch { /* ignore non-JSON CLI diagnostics */ }
    };
    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > MAX_RESULT_BYTES) {
        stdoutBuffer = stdoutBuffer.slice(-MAX_RESULT_BYTES);
      }
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) processEventLine(line);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += Math.min(Buffer.byteLength(chunk), MAX_STDERR_BYTES - stderrBytes);
    });
    const completed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, processSignal) => resolve({ code, processSignal }));
    });
    child.stdin.end(promptFor(normalizedQuery, maxResults, researchMode));
    const processResult = await Promise.race([completed, forcedCompletion]);
    processEventLine(stdoutBuffer);
    if (signal?.aborted) throw Object.assign(new Error('联网工具执行已取消'), { status: 499 });
    const payload = extractJsonObject(resultEvent?.result);
    const successfulToolResults = toolResults.filter(result => result.success);
    const toolResultUrls = new Set(successfulToolResults.flatMap(result => result.urls));
    const sourceLimit = Math.max(1, Math.min(20, Number(maxResults) || 12));
    // 最终提示词仍只接收 sourceLimit 条已核验结果；受控抓取候选则要跨越
    // 所有搜索步骤保留更宽池，避免第一组SEO/百科URL把后续官方/商户页挤掉。
    const controlledCandidateLimit = Math.max(
      sourceLimit,
      Math.min(60, sourceLimit * 5),
    );
    const declaredCandidates = normalizedSources(payload, sourceLimit);
    const directToolCandidates = toolResultCandidates(
      successfulToolResults,
      controlledCandidateLimit,
    );
    // Claude CLI 的最终文本偶尔会漏掉约定的 sources JSON，但流式
    // tool_result 已经包含真实 WebSearch URL。不能因此把真实检索判成“通道
    // 不可用”，也不能把这些URL直接当事实；把它们作为同一调用栈内候选，
    // 强制交给受控WebFetch读取真实标题/正文后才进入最终模型。
    const fetchCandidates = mergeSourceCandidates(
      declaredCandidates,
      directToolCandidates,
      controlledCandidateLimit,
    );
    const querySteps = steps.filter(step => step.tool === 'WebSearch' && step.query);
    const candidateGatePassed = querySteps.length >= 5
      && successfulToolResults.length >= 5
      && toolResultUrls.size >= 5
      && fetchCandidates.length >= 5;
    if (timedOut && !candidateGatePassed) {
      throw Object.assign(new Error('联网工具执行超时'), { code: 'AGENTIC_RESEARCH_TIMEOUT' });
    }
    if (
      !candidateGatePassed &&
      (processResult.code !== 0 || !resultEvent || resultEvent.is_error)
    ) {
      throw Object.assign(
        new Error(researchCliFailureMessage(resultEvent, processResult)),
        { code: 'AGENTIC_RESEARCH_FAILED' },
      );
    }
    const results = normalizedSources(
      payload,
      sourceLimit,
      toolResultUrls.size ? toolResultUrls : new Set(),
    );
    const usage = resultEvent?.usage || {};
    const qualityPassed = candidateGatePassed && results.length >= 5;
    const queries = [
      ...new Set([
        ...querySteps.map(step => step.query),
        ...(Array.isArray(payload?.queries) ? payload.queries.map(item => safeText(item, 500)) : []),
      ].filter(Boolean)),
    ];
    const normalizedFactResult = normalizedFacts(payload, toolResultUrls);
    const response = {
      attempted: true,
      ok: qualityPassed,
      candidateReady: candidateGatePassed,
      provider: readiness.provider,
      results,
      note: qualityPassed
        ? null
        : candidateGatePassed
          ? `WebSearch已真实执行并形成${fetchCandidates.length}条网页候选；其中${results.length}条与工具结果URL完全一致，其余必须由应用受控WebFetch逐页核验后才能进入最终模型`
          : `联网工具已运行，但候选检索门未通过：调用意图${querySteps.length}次、成功工具结果${successfulToolResults.length}次、工具结果URL ${toolResultUrls.size}条、网页候选${fetchCandidates.length}条；四项最低要求均为5`,
      evidence: {
        schemaVersion: 'nanowork.agentic-web-research/1',
        executionMode: 'isolated_claude_cli',
        model: readiness.model,
        toolCalls: successfulToolResults.length,
        toolAttempts: querySteps.length,
        toolResults: toolResults.map(result => ({
          toolUseId: result.toolUseId,
          success: result.success,
          isError: result.isError,
          permissionDenied: result.permissionDenied,
          urlCount: result.urlCount,
        })),
        qualityGate: {
          requiredSearches: 5,
          requiredSources: 5,
          observedSearches: querySteps.length,
          observedSuccessfulToolResults: successfulToolResults.length,
          observedToolResultUrls: toolResultUrls.size,
          observedSources: results.length,
          passed: qualityPassed,
        },
        candidateGate: {
          requiredSearches: 5,
          requiredSuccessfulToolResults: 5,
          requiredToolResultUrls: 5,
          requiredCandidates: 5,
          observedSearches: querySteps.length,
          observedSuccessfulToolResults: successfulToolResults.length,
          observedToolResultUrls: toolResultUrls.size,
          observedCandidates: fetchCandidates.length,
          declaredCandidates: declaredCandidates.length,
          toolResultCandidates: directToolCandidates.length,
          finalPayloadParsed: Boolean(payload),
          passed: candidateGatePassed,
          requiresControlledWebFetch: true,
        },
        queries,
        steps,
        facts: normalizedFactResult.facts,
        rejectedFactCount: normalizedFactResult.rejected,
        gaps: Array.isArray(payload?.gaps) ? payload.gaps.map(item => safeText(item, 300)).filter(Boolean).slice(0, 20) : [],
        usage: {
          inputTokens: Number(usage.input_tokens || 0),
          outputTokens: Number(usage.output_tokens || 0),
          cacheReadInputTokens: Number(usage.cache_read_input_tokens || 0),
        },
        costUsd: Number(resultEvent?.total_cost_usd || 0),
        timedOut,
        harvestedAfterTimeout: timedOut === true && candidateGatePassed === true,
        harvestedAfterCliError:
          timedOut !== true
          && candidateGatePassed === true
          && (
            processResult.code !== 0
            || !resultEvent
            || resultEvent.is_error
          ),
        externalCall: true,
        localLoginInherited: false,
        stderrStored: false,
      },
    };
    // 候选URL只在同一调用栈内交给受控WebFetch；它们尚未通过网页核验，
    // 因而设为不可枚举，禁止被JSON快照、接口响应或日志误当成已验证来源。
    Object.defineProperty(response, 'fetchCandidates', {
      value: candidateGatePassed ? fetchCandidates : [],
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return response;
  } finally {
    clearTimeout(processTimer);
    clearTimeout(killGraceTimer);
    signal?.removeEventListener?.('abort', onAbort);
    killProcessTree(child);
    // 只删除本次 mkdtemp 返回的精确目录；绝不接受外部路径或环境变量作为目标。
    if (runtimeRoot.startsWith(`${os.tmpdir()}${path.sep}nanowork-research-`)) {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  }
}

const TIERED_RESEARCH_SCHEMA = 'nanowork.tiered-web-research/1';
const TINYFISH_REQUIRED_CANDIDATES = 5;
const TINYFISH_REQUIRED_FETCHED_PAGES = 3;
const TINYFISH_REQUIRED_DOMAINS = 2;
const TINYFISH_REQUIRED_BODY_CHARS = 1200;
const TINYFISH_REQUIRED_RELEVANT_PAGES = 2;
const TINYFISH_REQUIRED_UNIQUE_BODIES = 3;

function tinyfishQueryFor(value) {
  const lines = String(value || '')
    .split(/\r?\n/u)
    .map(line => safeText(line, 500))
    .filter(Boolean);
  const prioritized = lines.filter(line =>
    /(?:老板的任务|具体要求|取证查询|公开链接|选题|检索任务|任务目标|打开并核验)/u.test(line),
  );
  return safeText((prioritized.length ? prioritized : lines).slice(0, 4).join(' '), 400);
}

function normalizedTinyfishCandidates(rows, limit) {
  const seen = new Set();
  const candidates = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const url = safeHttpUrl(row?.url);
    const title = safeText(row?.title, 220);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    candidates.push({
      title,
      url,
      snippet: safeText(row?.snippet, 800),
      publishedAt: safeText(row?.publishedAt || row?.date, 80) || null,
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

function querySignals(value) {
  const ignored = new Set([
    '老板', '任务', '要求', '必须', '不得', '公开', '信息', '来源', '查询',
    '检索', '核验', '联网', '内容', '资料', '数字员工', '岗位职责',
  ]);
  return [...new Set(safeText(value, 2_000).toLowerCase().match(/[\p{L}\p{N}]{2,24}/gu) || [])]
    .filter(term => !ignored.has(term))
    .slice(0, 40);
}

function contentFingerprint(value) {
  return safeText(value, 1_500)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 1_200);
}

function tinyfishFetchedPages(rows, requestedCandidates = []) {
  const allowed = new Set((Array.isArray(requestedCandidates) ? requestedCandidates : [])
    .map(item => safeHttpUrl(item?.url || item))
    .filter(Boolean));
  const seen = new Set();
  const pages = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const url = safeHttpUrl(row?.url);
    const requestedUrl = safeHttpUrl(row?.requestedUrl);
    const body = safeText(row?.body || row?.text || row?.snippet, 3_000);
    const belongsToRequest = !allowed.size || allowed.has(requestedUrl) || allowed.has(url);
    if (!url || !belongsToRequest || body.length < 80 || seen.has(url)) continue;
    seen.add(url);
    pages.push({
      title: safeText(row?.title, 220) || new URL(url).hostname,
      url,
      requestedUrl,
      snippet: safeText(row?.snippet || body, 800),
      body,
    });
  }
  return pages;
}

function domainCount(rows) {
  const domains = new Set();
  for (const row of rows) {
    try { domains.add(new URL(row.url).hostname.replace(/^www\./u, '')); } catch { /* normalized earlier */ }
  }
  return domains.size;
}

function relevantPageCount(rows, query) {
  const signals = querySignals(query);
  if (!signals.length) return rows.length;
  return rows.filter(row => {
    const material = safeText(`${row?.title || ''} ${row?.url || ''} ${row?.body || ''}`, 4_000)
      .toLowerCase();
    return signals.some(term => material.includes(term));
  }).length;
}

function uniqueBodyCount(rows) {
  return new Set(rows.map(row => contentFingerprint(row?.body)).filter(Boolean)).size;
}

function materialQuality(rows, query) {
  const fetchedPageCount = rows.length;
  const uniqueDomainCount = domainCount(rows);
  const distinctBodies = uniqueBodyCount(rows);
  const relevantPages = relevantPageCount(rows, query);
  const totalBodyChars = rows.reduce((sum, page) => sum + page.body.length, 0);
  return {
    fetchedPageCount,
    uniqueDomainCount,
    uniqueBodyCount: distinctBodies,
    relevantPageCount: relevantPages,
    totalBodyChars,
    passed:
      fetchedPageCount >= TINYFISH_REQUIRED_FETCHED_PAGES &&
      uniqueDomainCount >= TINYFISH_REQUIRED_DOMAINS &&
      totalBodyChars >= TINYFISH_REQUIRED_BODY_CHARS &&
      relevantPages >= TINYFISH_REQUIRED_RELEVANT_PAGES &&
      distinctBodies >= TINYFISH_REQUIRED_UNIQUE_BODIES,
  };
}

export function assessWebResearchMaterial(rows, query = '') {
  return materialQuality(tinyfishFetchedPages(rows), query);
}

function defineFetchCandidates(response, candidates) {
  Object.defineProperty(response, 'fetchCandidates', {
    value: Array.isArray(candidates) ? candidates : [],
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return response;
}

function safeFailureCode(error, fallback = 'TINYFISH_FAILED') {
  const code = String(error?.code || '').trim().toUpperCase();
  return /^[A-Z0-9_]{3,80}$/u.test(code) ? code : fallback;
}

function tieredFallbackEvidence(tinyfish, claude, reasonCode) {
  return {
    schemaVersion: TIERED_RESEARCH_SCHEMA,
    executionMode: 'tinyfish_then_claude',
    providerRoute: ['tinyfish', 'claude_websearch'],
    fallback: { triggered: true, reasonCode },
    tinyfish,
    claude: claude?.evidence || null,
    externalCall: true,
  };
}

export async function agenticWebResearch(query, {
  maxResults = 12,
  timeoutMs = 240_000,
  signal = null,
  onProgress = null,
  researchMode = 'location_business',
  tinyfishEnabled = tinyfishAvailable(),
  tinyfishSearchFn = tinyfishSearch,
  tinyfishFetchFn = tinyfishFetchPages,
  claudeResearchFn = claudeAgenticWebResearch,
} = {}) {
  const normalizedQuery = safeText(query, 12_000);
  const totalBudgetMs = Math.max(1, Number(timeoutMs) || 240_000);
  // 未配置 TinyFish 时完全保留旧 Claude 路径自己的 timeout / abort 语义。
  // 若在这里再叠一只同期限时钟，会在高并发下与 Claude 定时器竞态，
  // 把真实超时误判为调用方取消。
  if (!tinyfishEnabled || !normalizedQuery) {
    return claudeResearchFn(query, {
      maxResults,
      timeoutMs: totalBudgetMs,
      signal,
      onProgress,
      researchMode,
    });
  }
  const deadlineAt = Date.now() + totalBudgetMs;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), totalBudgetMs);
  deadlineTimer.unref?.();
  const tieredSignal = signal
    ? AbortSignal.any([signal, deadlineController.signal])
    : deadlineController.signal;
  const remainingBudget = cap => Math.max(1, Math.min(cap, deadlineAt - Date.now()));
  const claudeOptions = () => ({
    maxResults,
    timeoutMs: remainingBudget(totalBudgetMs),
    signal: tieredSignal,
    onProgress,
    researchMode,
  });
  try {
    const sourceLimit = Math.max(5, Math.min(20, Number(maxResults) || 12));
    let candidates = [];
    let fetchedPages = [];
    let fallbackReasonCode = null;
    let tinyfishFailureCodes = [];
    try {
      const searchQuery = tinyfishQueryFor(query);
      onProgress?.({ kind: 'search', tool: 'TinyFish Search', query: searchQuery, at: new Date().toISOString() });
      const searched = await tinyfishSearchFn(searchQuery, {
        max: sourceLimit,
        timeoutMs: remainingBudget(12_000),
        signal: tieredSignal,
        purpose: safeText(`纳米Work公开业务调研：${normalizedQuery}`, 500),
      });
      candidates = normalizedTinyfishCandidates(searched, sourceLimit);
      if (!candidates.length) fallbackReasonCode = 'TINYFISH_NO_RESULTS';
      else if (candidates.length < TINYFISH_REQUIRED_CANDIDATES) {
        fallbackReasonCode = 'TINYFISH_CANDIDATES_INSUFFICIENT';
      }

      if (!fallbackReasonCode) {
        onProgress?.({ kind: 'fetch', tool: 'TinyFish Fetch', count: candidates.length, at: new Date().toISOString() });
        const fetched = await tinyfishFetchFn(candidates.map(item => item.url), {
          timeoutMs: remainingBudget(20_000),
          signal: tieredSignal,
          purpose: '核验公开网页正文是否足以支持餐饮经营任务',
        });
        fetchedPages = tinyfishFetchedPages(fetched?.results, candidates);
        tinyfishFailureCodes = [...new Set((Array.isArray(fetched?.failures) ? fetched.failures : [])
          .map(item => safeFailureCode({ code: item?.code }, 'TINYFISH_PAGE_FAILED')))]
          .slice(0, 20);
        const quality = materialQuality(fetchedPages, searchQuery);
        if (quality.fetchedPageCount < TINYFISH_REQUIRED_FETCHED_PAGES) {
          fallbackReasonCode = 'TINYFISH_FETCH_INSUFFICIENT';
        } else if (!quality.passed) {
          fallbackReasonCode = 'TINYFISH_ORGANIZATION_INSUFFICIENT';
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        throw Object.assign(new Error('联网工具执行已取消'), { status: 499, code: 'AGENTIC_RESEARCH_ABORTED' });
      }
      if (deadlineController.signal.aborted) {
        throw Object.assign(new Error('分层联网检索超过本次总预算'), { status: 504, code: 'AGENTIC_RESEARCH_TIMEOUT' });
      }
      fallbackReasonCode = candidates.length ? 'TINYFISH_FETCH_FAILED' : 'TINYFISH_SEARCH_FAILED';
      tinyfishFailureCodes = [safeFailureCode(error)];
    }

    const tinyfishQuality = materialQuality(fetchedPages, tinyfishQueryFor(query));
    const tinyfishEvidence = {
      attempted: true,
      candidateCount: candidates.length,
      fetchedPageCount: tinyfishQuality.fetchedPageCount,
      uniqueDomainCount: tinyfishQuality.uniqueDomainCount,
      uniqueBodyCount: tinyfishQuality.uniqueBodyCount,
      relevantPageCount: tinyfishQuality.relevantPageCount,
      totalBodyChars: tinyfishQuality.totalBodyChars,
      failureCodes: tinyfishFailureCodes,
      qualityGate: {
        requiredCandidates: TINYFISH_REQUIRED_CANDIDATES,
        requiredFetchedPages: TINYFISH_REQUIRED_FETCHED_PAGES,
        requiredDomains: TINYFISH_REQUIRED_DOMAINS,
        requiredBodyChars: TINYFISH_REQUIRED_BODY_CHARS,
        requiredRelevantPages: TINYFISH_REQUIRED_RELEVANT_PAGES,
        requiredUniqueBodies: TINYFISH_REQUIRED_UNIQUE_BODIES,
        passed: fallbackReasonCode === null && tinyfishQuality.passed,
      },
    };
    if (!fallbackReasonCode) {
      const fetchedByRequestedUrl = new Map();
      for (const page of fetchedPages) {
        for (const value of [page.requestedUrl, page.url]) {
          const url = safeHttpUrl(value);
          if (url) fetchedByRequestedUrl.set(url, page);
        }
      }
      const enrichedCandidates = candidates.map(candidate => {
        const page = fetchedByRequestedUrl.get(candidate.url);
        return page
          ? { ...candidate, title: page.title || candidate.title, snippet: page.snippet || candidate.snippet }
          : candidate;
      });
      return defineFetchCandidates({
        attempted: true,
        ok: true,
        candidateReady: true,
        provider: 'TinyFish Search + Fetch',
        results: enrichedCandidates,
        note: null,
        evidence: {
          schemaVersion: TIERED_RESEARCH_SCHEMA,
          executionMode: 'tinyfish_first',
          providerRoute: ['tinyfish'],
          fallback: { triggered: false, reasonCode: null },
          tinyfish: tinyfishEvidence,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
          costUsd: 0,
          externalCall: true,
        },
      }, enrichedCandidates);
    }

    onProgress?.({
      kind: 'fallback',
      tool: 'Claude WebSearch',
      reasonCode: fallbackReasonCode,
      at: new Date().toISOString(),
    });
    let claude;
    try {
      if (Date.now() >= deadlineAt) {
        throw Object.assign(new Error('分层联网检索超过本次总预算'), { status: 504, code: 'AGENTIC_RESEARCH_TIMEOUT' });
      }
      claude = await claudeResearchFn(query, claudeOptions());
    } catch (error) {
      if (signal?.aborted) throw error;
      if (deadlineController.signal.aborted || error?.code === 'AGENTIC_RESEARCH_TIMEOUT') {
        throw Object.assign(new Error('分层联网检索超过本次总预算'), { status: 504, code: 'AGENTIC_RESEARCH_TIMEOUT' });
      }
      claude = {
        attempted: true,
        ok: false,
        candidateReady: false,
        provider: 'Yunwu Claude WebSearch gateway',
        results: [],
        note: 'Claude WebSearch 回退通道执行失败',
        evidence: {
          schemaVersion: 'nanowork.agentic-web-research/1',
          executionMode: 'isolated_claude_cli',
          failureCode: safeFailureCode(error, 'CLAUDE_WEBSEARCH_FAILED'),
          externalCall: true,
        },
      };
    }
    const claudeCandidates = Array.isArray(claude?.fetchCandidates) ? claude.fetchCandidates : [];
    return defineFetchCandidates({
      ...(claude || {}),
      provider: claude?.provider || 'Yunwu Claude WebSearch gateway',
      evidence: tieredFallbackEvidence(tinyfishEvidence, claude, fallbackReasonCode),
    }, claudeCandidates);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

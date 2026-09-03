import assert from 'node:assert/strict';
import test from 'node:test';

const ISOLATED_ENV_KEYS = [
  'TINYFISH_API_KEY',
  'YUNWU_API_KEY',
  'YUNWU_BASE_URL',
  'ANTHROPIC_API_KEY',
  'CONTENTCREW_CLAUDE_PATH',
  'NANOWORK_RESEARCH_MODEL',
  'BOCHA_API_KEY',
  'TAVILY_API_KEY',
  'SERPER_API_KEY',
  'NANOWORK_TEST_TEMPLATE_AI',
];

function captureEnvironment(keys = ISOLATED_ENV_KEYS) {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

function restoreEnvironment(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withIsolatedSearchEnvironment(values, run) {
  const original = captureEnvironment();
  for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
  process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
  for (const [key, value] of Object.entries(values || {})) {
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await run();
  } finally {
    restoreEnvironment(original);
  }
}

// 必须在加载 yunwu/agentic 模块前隔离真实服务端凭证，否则本机 .env 会让
// 这些纯单元测试误入真实 TinyFish/Claude 通道。
const originalModuleEnvironment = captureEnvironment();
for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
const { webSearch } = await import('../src/engines/websearch.js');
test.after(() => restoreEnvironment(originalModuleEnvironment));

test('no-key 联网检索使用 Google News RSS 真实来源兜底并保留日期', async () => {
  const originalFetch = globalThis.fetch;
  const original = {
    BOCHA_API_KEY: process.env.BOCHA_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    SERPER_API_KEY: process.env.SERPER_API_KEY,
  };
  delete process.env.BOCHA_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPER_API_KEY;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(`<?xml version="1.0"?><rss><channel>
      <item><title>餐饮降本增效新趋势 - 新华网</title>
      <link>https://news.google.com/rss/articles/example?oc=5</link>
      <description>&lt;a href="https://example.com/report"&gt;餐饮企业关注食材与能耗成本&lt;/a&gt;</description>
      <pubDate>Thu, 30 Jul 2026 08:00:00 GMT</pubDate><source url="https://www.news.cn">新华网</source></item>
    </channel></rss>`, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  };
  try {
    const result = await webSearch('餐饮门店 食材成本 趋势', { timeoutMs: 500 });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'Google News RSS');
    assert.equal(result.results.length, 1);
    assert.match(result.results[0].title, /餐饮降本增效/u);
    assert.match(result.results[0].snippet, /新华网/u);
    assert.match(result.results[0].snippet, /30 Jul 2026/u);
    assert.match(requested[0], /^https:\/\/news\.google\.com\/rss\/search\?/u);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Google News 未命中时继续尝试 DDG，两者无结果不伪造来源', async () => {
  const originalFetch = globalThis.fetch;
  const original = {
    BOCHA_API_KEY: process.env.BOCHA_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    SERPER_API_KEY: process.env.SERPER_API_KEY,
  };
  delete process.env.BOCHA_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPER_API_KEY;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(calls === 1 ? '<rss><channel></channel></rss>' : '<html><body>challenge</body></html>', { status: 200 });
  };
  try {
    const result = await webSearch('完全不存在的验收词', { timeoutMs: 500 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.results, []);
    assert.match(result.note, /Google News RSS:未命中/u);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('web_first优先尝试DDG，成功时不先请求Google News', async () => {
  const originalFetch = globalThis.fetch;
  const original = {
    BOCHA_API_KEY: process.env.BOCHA_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    SERPER_API_KEY: process.env.SERPER_API_KEY,
  };
  delete process.env.BOCHA_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPER_API_KEY;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(`
      <article class="web-result">
        <a class="result__a" href="https://example.com/web-first">网页优先来源</a>
        <div class="result__snippet">网页优先摘要</div>
      </article>
    `, { status: 200 });
  };
  try {
    const result = await webSearch('网页优先测试', { timeoutMs: 500, fallbackOrder: 'web_first' });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'DuckDuckGo');
    assert.equal(result.results[0].url, 'https://example.com/web-first');
    assert.equal(requested.length, 1);
    assert.match(requested[0], /^https:\/\/html\.duckduckgo\.com\/html\//u);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('web_first在DDG空结果时才回退Google News，顺序不反转', async () => {
  const originalFetch = globalThis.fetch;
  const original = {
    BOCHA_API_KEY: process.env.BOCHA_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    SERPER_API_KEY: process.env.SERPER_API_KEY,
  };
  delete process.env.BOCHA_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPER_API_KEY;
  const requested = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    requested.push(target);
    if (target.startsWith('https://html.duckduckgo.com/')) {
      return new Response('<html><body>无结果</body></html>', { status: 200 });
    }
    return new Response(`<?xml version="1.0"?><rss><channel>
      <item><title>网页优先后的新闻来源</title><link>https://news.google.com/rss/articles/web-first-fallback</link>
      <description>DDG空结果后的新闻兜底</description><pubDate>Fri, 31 Jul 2026 08:00:00 GMT</pubDate>
      <source url="https://example.com">测试媒体</source></item>
    </channel></rss>`, { status: 200 });
  };
  try {
    const result = await webSearch('网页优先空结果测试', { timeoutMs: 500, fallbackOrder: 'web_first' });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'Google News RSS');
    assert.equal(requested.length, 2);
    assert.match(requested[0], /^https:\/\/html\.duckduckgo\.com\/html\//u);
    assert.match(requested[1], /^https:\/\/news\.google\.com\/rss\/search\?/u);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('DDG 非 2xx 响应失败关闭，不能采信错误页中伪装的结果', async () => {
  const originalFetch = globalThis.fetch;
  const original = {
    BOCHA_API_KEY: process.env.BOCHA_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    SERPER_API_KEY: process.env.SERPER_API_KEY,
  };
  delete process.env.BOCHA_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPER_API_KEY;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('<rss><channel></channel></rss>', { status: 200 });
    return new Response(`
      <div class="result results_links">
        <a class="result__a" href="https://attacker.invalid/fake">伪装结果</a>
      </div>
    `, { status: 503 });
  };
  try {
    const result = await webSearch('错误页不能作为来源', { timeoutMs: 500 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.results, []);
    assert.match(result.note, /DuckDuckGo.*HTTP 503/u);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('DDG 解析当前 HTML 变体：属性乱序、单引号与非 a 摘要标签', async () => {
  const originalFetch = globalThis.fetch;
  const original = {
    BOCHA_API_KEY: process.env.BOCHA_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    SERPER_API_KEY: process.env.SERPER_API_KEY,
  };
  delete process.env.BOCHA_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPER_API_KEY;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('<rss><channel></channel></rss>', { status: 200 });
    return new Response(`
      <article class="web-result">
        <a class="result__a" href="https://api-key:secret@example.net/private">带凭据地址不得成为来源</a>
        <div class="result__snippet">敏感地址</div>
      </article>
      <article data-testid="result" class="web-result">
        <h2><a rel='nofollow' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Freport&amp;rut=abc' class='result__a extra'>
          太原餐饮行业报告
        </a></h2>
        <div data-testid="result-snippet" class='result__snippet'>门店经营与消费趋势</div>
      </article>
      <table>
        <tr><td><a href="https://example.org/statistics" class="result-link">官方统计资料</a></td></tr>
        <tr><td class="result-snippet">统计口径与发布时间</td></tr>
      </table>
    `, { status: 200 });
  };
  try {
    const result = await webSearch('太原 餐饮 数据', { max: 5, timeoutMs: 500 });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'DuckDuckGo');
    assert.deepEqual(result.results, [
      {
        title: '太原餐饮行业报告',
        url: 'https://example.com/report',
        snippet: '门店经营与消费趋势',
      },
      {
        title: '官方统计资料',
        url: 'https://example.org/statistics',
        snippet: '统计口径与发布时间',
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('一个检索源超时后为后续源创建新预算，不复用已中止 signal', async () => {
  const originalFetch = globalThis.fetch;
  const original = {
    BOCHA_API_KEY: process.env.BOCHA_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    SERPER_API_KEY: process.env.SERPER_API_KEY,
  };
  process.env.BOCHA_API_KEY = 'test-key';
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPER_API_KEY;
  const signals = [];
  globalThis.fetch = async (url, options = {}) => {
    signals.push(options.signal);
    if (String(url).includes('api.bochaai.com')) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(new DOMException('timed out', 'AbortError'));
        }, { once: true });
      });
    }
    return new Response(`<?xml version="1.0"?><rss><channel>
      <item><title>后续真实新闻</title><link>https://news.google.com/rss/articles/recovered</link>
      <description>独立预算验证</description><pubDate>Fri, 31 Jul 2026 08:00:00 GMT</pubDate>
      <source url="https://example.com">测试媒体</source></item>
    </channel></rss>`, { status: 200 });
  };
  try {
    const result = await webSearch('独立超时预算', { timeoutMs: 20 });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'Google News RSS');
    assert.equal(result.results.length, 1);
    assert.equal(signals.length, 2);
    assert.notEqual(signals[0], signals[1]);
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('已配置商业源返回零结果时继续检索，不能提前返回空成功', async () => {
  const originalFetch = globalThis.fetch;
  const original = {
    BOCHA_API_KEY: process.env.BOCHA_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    SERPER_API_KEY: process.env.SERPER_API_KEY,
  };
  process.env.BOCHA_API_KEY = 'test-key';
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPER_API_KEY;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).includes('api.bochaai.com')) {
      return Response.json({ data: { webPages: { value: [] } } });
    }
    return new Response(`<rss><channel>
      <item><title>补位新闻来源</title><link>https://news.google.com/rss/articles/fallback</link>
      <description>商业源未命中后的真实来源</description><pubDate>Fri, 31 Jul 2026 09:00:00 GMT</pubDate>
      <source url="https://example.com">测试媒体</source></item>
    </channel></rss>`, { status: 200 });
  };
  try {
    const result = await webSearch('商业源空结果继续兜底', { timeoutMs: 500 });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'Google News RSS');
    assert.equal(result.results.length, 1);
    assert.equal(requested.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('调用方 signal 取消后立即停止整条检索链，不再请求后续源', async () => {
  const originalFetch = globalThis.fetch;
  const original = {
    BOCHA_API_KEY: process.env.BOCHA_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    SERPER_API_KEY: process.env.SERPER_API_KEY,
  };
  delete process.env.BOCHA_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPER_API_KEY;
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async (_url, options = {}) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(new DOMException('cancelled', 'AbortError'));
      }, { once: true });
      controller.abort();
    });
  };
  try {
    const result = await webSearch('取消后不得继续联网', {
      timeoutMs: 500,
      signal: controller.signal,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.results, []);
    assert.match(result.note, /调用方已取消/u);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('分层检索成功时透传 provider，且不调用博查或免 Key 灾备源', async () => {
  await withIsolatedSearchEnvironment(
    {
      TINYFISH_API_KEY: 'tiered-test-key',
      BOCHA_API_KEY: 'bocha-must-not-be-used',
    },
    async () => {
      let tieredCalls = 0;
      let legacyFetchCalls = 0;
      const tieredEvidence = {
        schemaVersion: 'nanowork.tiered-web-research/1',
        providerRoute: ['tinyfish'],
      };
      const result = await webSearch('分层通道优先级验证', {
        max: 3,
        timeoutMs: 500,
        fetchImpl: async () => {
          legacyFetchCalls += 1;
          throw new Error('分层成功后不得调用旧检索源');
        },
        tieredResearchFn: async (_query, options) => {
          tieredCalls += 1;
          assert.equal(options.maxResults, 5);
          assert.equal(options.researchMode, 'simple_search');
          assert.equal(options.signal.aborted, false);
          return {
            attempted: true,
            ok: true,
            candidateReady: true,
            provider: 'TinyFish Search + Fetch',
            results: [
              {
                title: '分层来源一',
                url: 'https://tiered-one.example.com/report',
                snippet: '已由分层入口整理的公开来源',
              },
              {
                title: '分层来源二',
                url: 'https://tiered-two.example.com/report',
                snippet: '第二条公开来源',
              },
            ],
            evidence: tieredEvidence,
          };
        },
      });

      assert.equal(tieredCalls, 1);
      assert.equal(legacyFetchCalls, 0);
      assert.equal(result.ok, true);
      assert.equal(result.provider, 'TinyFish Search + Fetch');
      assert.equal(result.results.length, 2);
      assert.equal(result.evidence, tieredEvidence);
    },
  );
});

test('分层质量门失败后继续旧商业源灾备', async () => {
  await withIsolatedSearchEnvironment(
    {
      TINYFISH_API_KEY: 'tiered-test-key',
      BOCHA_API_KEY: 'bocha-test-key',
    },
    async () => {
      const requested = [];
      const result = await webSearch('分层失败后商业灾备', {
        timeoutMs: 500,
        tieredResearchFn: async () => ({
          attempted: true,
          ok: false,
          candidateReady: false,
          provider: 'TinyFish Search + Fetch',
          results: [],
          evidence: {
            schemaVersion: 'nanowork.tiered-web-research/1',
            fallback: {
              triggered: true,
              reasonCode: 'TINYFISH_ORGANIZATION_INSUFFICIENT',
            },
          },
        }),
        fetchImpl: async (url) => {
          requested.push(String(url));
          if (!String(url).includes('api.bochaai.com')) {
            throw new Error('博查命中后不得继续免 Key 灾备');
          }
          return Response.json({
            data: {
              webPages: {
                value: [
                  {
                    name: '博查灾备来源',
                    url: 'https://bocha-fallback.example.com/report',
                    summary: '分层质量不足后由既有商业源接管',
                  },
                ],
              },
            },
          });
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.provider, '博查');
      assert.equal(result.results[0].url, 'https://bocha-fallback.example.com/report');
      assert.equal(requested.length, 1);
      assert.match(requested[0], /api\.bochaai\.com/u);
    },
  );
});

test('Claude 只有候选而没有正文产物时继续旧商业源灾备', async () => {
  await withIsolatedSearchEnvironment(
    {
      TINYFISH_API_KEY: 'tiered-test-key',
      BOCHA_API_KEY: 'bocha-test-key',
    },
    async () => {
      let legacyFetchCalls = 0;
      const result = await webSearch('Claude候选不等于可交付正文', {
        timeoutMs: 500,
        tieredResearchFn: async () => ({
          attempted: true,
          ok: false,
          candidateReady: true,
          provider: 'Claude WebSearch',
          results: [],
          fetchCandidates: [
            {
              title: '仅候选来源',
              url: 'https://candidate-only.example.com/report',
              snippet: '尚未抓取和核验正文',
            },
          ],
        }),
        fetchImpl: async (url) => {
          legacyFetchCalls += 1;
          assert.match(String(url), /api\.bochaai\.com/u);
          return Response.json({
            data: {
              webPages: {
                value: [
                  {
                    name: '博查正文灾备来源',
                    url: 'https://bocha-fallback.example.com/body-verified',
                    summary: '候选不可交付时继续既有灾备链',
                  },
                ],
              },
            },
          });
        },
      });

      assert.equal(legacyFetchCalls, 1);
      assert.equal(result.ok, true);
      assert.equal(result.provider, '博查');
      assert.equal(result.results[0].url, 'https://bocha-fallback.example.com/body-verified');
    },
  );
});

test('分层质量门失败且无商业源时继续免 Key 灾备', async () => {
  await withIsolatedSearchEnvironment(
    { TINYFISH_API_KEY: 'tiered-test-key' },
    async () => {
      const requested = [];
      const result = await webSearch('分层失败后免费灾备', {
        timeoutMs: 500,
        tieredResearchFn: async () => ({
          attempted: true,
          ok: false,
          candidateReady: false,
          provider: 'TinyFish Search + Fetch',
          results: [],
        }),
        fetchImpl: async (url) => {
          requested.push(String(url));
          return new Response(`<?xml version="1.0"?><rss><channel>
            <item><title>免Key灾备新闻</title>
            <link>https://news.google.com/rss/articles/tiered-fallback</link>
            <description>分层质量失败后的真实新闻来源</description>
            <pubDate>Mon, 31 Aug 2026 08:00:00 GMT</pubDate>
            <source url="https://example.com">测试媒体</source></item>
          </channel></rss>`, { status: 200 });
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.provider, 'Google News RSS');
      assert.equal(result.results.length, 1);
      assert.equal(requested.length, 1);
      assert.match(requested[0], /^https:\/\/news\.google\.com\/rss\/search\?/u);
    },
  );
});

test('调用方在分层入口取消后不再调用商业或免 Key 后续源', async () => {
  await withIsolatedSearchEnvironment(
    {
      TINYFISH_API_KEY: 'tiered-test-key',
      YUNWU_API_KEY: 'yunwu-must-not-be-used',
      BOCHA_API_KEY: 'bocha-must-not-be-used',
    },
    async () => {
      const controller = new AbortController();
      let tieredCalls = 0;
      let legacyFetchCalls = 0;
      const result = await webSearch('分层入口取消传播', {
        timeoutMs: 500,
        signal: controller.signal,
        fetchImpl: async () => {
          legacyFetchCalls += 1;
          throw new Error('取消后不得调用后续检索源');
        },
        tieredResearchFn: async (_query, options) => {
          tieredCalls += 1;
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(new DOMException('cancelled', 'AbortError')),
              { once: true },
            );
            controller.abort();
          });
        },
      });

      assert.equal(tieredCalls, 1);
      assert.equal(legacyFetchCalls, 0);
      assert.equal(result.ok, false);
      assert.deepEqual(result.results, []);
      assert.match(result.note, /调用方已取消/u);
    },
  );
});

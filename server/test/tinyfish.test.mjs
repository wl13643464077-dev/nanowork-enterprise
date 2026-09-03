import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

const TEST_API_KEY = "unit-test-token-tinyfish-offline";
const originalApiKey = process.env.TINYFISH_API_KEY;
process.env.TINYFISH_API_KEY = TEST_API_KEY;

const {
  clearTinyfishRuntimeState,
  tinyfishFailureNote,
  tinyfishFetchPages,
  tinyfishSearch,
} = await import("../src/engines/tinyfish.js");

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function abortAwareFetch(_url, init = {}) {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () =>
      reject(new DOMException("cancelled", "AbortError"));
    if (init.signal?.aborted) {
      rejectAbort();
      return;
    }
    init.signal?.addEventListener("abort", rejectAbort, { once: true });
  });
}

function longBody(label = "公开材料") {
  return `${label}：${"餐饮门店经营数据与公开监管信息。".repeat(12)}`;
}

describe("TinyFish adapter", { concurrency: false }, () => {
  beforeEach(() => {
    process.env.TINYFISH_API_KEY = TEST_API_KEY;
    clearTinyfishRuntimeState();
  });

  after(() => {
    clearTinyfishRuntimeState();
    if (originalApiKey === undefined) delete process.env.TINYFISH_API_KEY;
    else process.env.TINYFISH_API_KEY = originalApiKey;
  });

  test("Search 使用 X-API-Key 并映射统一结果，不把密钥带入输出", async () => {
    let capturedUrl;
    let capturedInit;
    const result = await tinyfishSearch("太原餐饮消费趋势", {
      max: 2,
      recencyMinutes: 90.9,
      purpose: "门店经营调研",
      fetchImpl: async (url, init) => {
        capturedUrl = new URL(url);
        capturedInit = init;
        return jsonResponse({
          results: [
            {
              title: "  太原餐饮趋势报告  ",
              url: "https://research.example/report",
              snippet: "消费\n  趋势\t持续增长",
            },
            { title: "缺少地址", snippet: "应被过滤" },
            {
              title: "市场监管公示",
              url: "https://gov.example/notice",
              snippet: "公开公示",
            },
            {
              title: "超过 max 的结果",
              url: "https://extra.example/item",
              snippet: "不应返回",
            },
          ],
        });
      },
    });

    assert.equal(capturedUrl.origin, "https://api.search.tinyfish.ai");
    assert.equal(capturedUrl.searchParams.get("query"), "太原餐饮消费趋势");
    assert.equal(capturedUrl.searchParams.get("language"), "zh");
    assert.equal(capturedUrl.searchParams.get("recency_minutes"), "90");
    assert.equal(capturedUrl.searchParams.get("purpose"), "门店经营调研");
    assert.equal(capturedInit.headers["X-API-Key"], TEST_API_KEY);
    assert.deepEqual(result, [
      {
        title: "太原餐饮趋势报告",
        url: "https://research.example/report",
        snippet: "消费 趋势 持续增长",
      },
      {
        title: "市场监管公示",
        url: "https://gov.example/notice",
        snippet: "公开公示",
      },
    ]);
    assert.equal(JSON.stringify(result).includes(TEST_API_KEY), false);
  });

  test("Search 的上游 HTTP 错误与安全说明均不泄露 API Key", async () => {
    let capturedHeader;
    let caught;
    try {
      await tinyfishSearch("鉴权失败样例", {
        fetchImpl: async (_url, init) => {
          capturedHeader = init.headers["X-API-Key"];
          return jsonResponse(
            { message: `invalid credential ${TEST_API_KEY}` },
            401,
          );
        },
      });
    } catch (error) {
      caught = error;
    }

    assert.equal(capturedHeader, TEST_API_KEY);
    assert.equal(caught?.code, "TINYFISH_HTTP_FAILED");
    assert.equal(caught?.providerStatus, 401);
    const publicText = `${caught?.message}\n${JSON.stringify(caught)}\n${tinyfishFailureNote(caught)}`;
    assert.equal(publicText.includes(TEST_API_KEY), false);
  });

  test("Fetch 映射正文与逐 URL 错误，并发送官方批量请求字段", async () => {
    const requestedUrls = [
      "https://one.example/article",
      "https://two.example/article",
      "https://three.example/article",
    ];
    let capturedInit;
    const output = await tinyfishFetchPages(requestedUrls, {
      timeoutMs: 1_500,
      ttlSeconds: 720,
      purpose: "公开证据核验",
      fetchImpl: async (_url, init) => {
        capturedInit = init;
        return jsonResponse({
          results: [
            {
              url: requestedUrls[0],
              final_url: "https://one.example/article-final",
              title: "  门店公开信息  ",
              text: longBody("门店公开信息"),
            },
          ],
          errors: [
            {
              url: requestedUrls[1],
              error: { type: "ROBOTS_DENIED", message: "robots policy denied" },
            },
            {
              url: requestedUrls[2],
              type: "FETCH_TIMEOUT",
              message: "page timed out",
            },
          ],
        });
      },
    });

    assert.equal(capturedInit.method, "POST");
    assert.equal(capturedInit.headers["X-API-Key"], TEST_API_KEY);
    assert.equal(capturedInit.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(capturedInit.body), {
      urls: requestedUrls,
      format: "markdown",
      ttl: 720,
      per_url_timeout_ms: 1_500,
      purpose: "公开证据核验",
    });
    assert.equal(output.results.length, 1);
    assert.equal(output.results[0].url, "https://one.example/article-final");
    assert.equal(output.results[0].requestedUrl, requestedUrls[0]);
    assert.equal(output.results[0].title, "门店公开信息");
    assert.deepEqual(output.failures, [
      {
        url: requestedUrls[1],
        code: "ROBOTS_DENIED",
        error: "robots policy denied",
      },
      {
        url: requestedUrls[2],
        code: "FETCH_TIMEOUT",
        error: "page timed out",
      },
    ]);
    assert.equal(JSON.stringify(output).includes(TEST_API_KEY), false);
  });

  test("内部截止时间与外部 AbortSignal 都会取消请求", async () => {
    await assert.rejects(
      tinyfishSearch("超时样例", {
        timeoutMs: 5,
        fetchImpl: abortAwareFetch,
      }),
      (error) => error?.name === "AbortError",
    );

    clearTinyfishRuntimeState();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      tinyfishFetchPages(["https://cancel.example/article"], {
        signal: controller.signal,
        fetchImpl: abortAwareFetch,
      }),
      (error) => error?.name === "AbortError",
    );
  });

  test("Search 本地滚动窗口允许 30 次并在第 31 次短路", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse({ results: [] });
    };

    for (let index = 0; index < 30; index += 1) {
      await tinyfishSearch(`额度样例 ${index + 1}`, { fetchImpl });
    }
    await assert.rejects(
      tinyfishSearch("额度样例 31", { fetchImpl }),
      (error) => error?.code === "TINYFISH_THROTTLED",
    );
    assert.equal(calls, 30);
  });

  test("Fetch 本地滚动窗口按 URL 计数并在 150 条后短路", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse({ results: [], errors: [] });
    };

    for (let batch = 0; batch < 15; batch += 1) {
      const urls = Array.from(
        { length: 10 },
        (_unused, index) => `https://quota-${batch}-${index}.example/article`,
      );
      await tinyfishFetchPages(urls, { fetchImpl });
    }
    await assert.rejects(
      tinyfishFetchPages(["https://quota-overflow.example/article"], {
        fetchImpl,
      }),
      (error) => error?.code === "TINYFISH_THROTTLED",
    );
    assert.equal(calls, 15);
  });

  test("无查询参数的成功页面在十分钟内命中本地缓存", async () => {
    const requestedUrl = "https://cache.example/article";
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse({
        results: [
          {
            url: requestedUrl,
            final_url: "https://cache.example/article-final",
            title: "缓存材料",
            text: longBody("缓存材料"),
          },
        ],
        errors: [],
      });
    };

    const first = await tinyfishFetchPages([requestedUrl], { fetchImpl });
    const second = await tinyfishFetchPages([requestedUrl], {
      fetchImpl: async () => {
        throw new Error("缓存命中时不应再次请求 provider");
      },
    });

    assert.equal(calls, 1);
    assert.equal(first.cached, 0);
    assert.equal(second.cached, 1);
    assert.deepEqual(second.results, first.results);
  });

  test("带任何查询参数的页面可抓取但绝不进入本地缓存", async () => {
    const requestedUrl = "https://cache.example/article?utm_source=unit-test";
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse({
        results: [
          {
            url: requestedUrl,
            final_url: requestedUrl,
            title: "动态查询页面",
            text: longBody("动态查询页面"),
          },
        ],
        errors: [],
      });
    };

    const first = await tinyfishFetchPages([requestedUrl], { fetchImpl });
    const second = await tinyfishFetchPages([requestedUrl], { fetchImpl });

    assert.equal(first.results.length, 1);
    assert.equal(second.results.length, 1);
    assert.equal(first.cached, 0);
    assert.equal(second.cached, 0);
    assert.equal(calls, 2);
  });

  test("Fetch 发送前拒绝本机、私网保留IP、非默认端口、凭据和敏感参数", async () => {
    const safeUrl = "https://public.example/article";
    const unsafeUrls = [
      "http://localhost/admin",
      "http://service.internal/config",
      "http://printer.local/status",
      "http://10.0.0.8/private",
      "http://172.20.0.8/private",
      "http://192.168.1.8/private",
      "http://169.254.169.254/latest/meta-data",
      "http://198.18.0.8/benchmark",
      "http://198.51.100.8/documentation",
      "http://203.0.113.8/documentation",
      "http://[::1]/private",
      "http://[fd00::8]/private",
      "https://public.example:8443/article",
      "https://user:password@public.example/article",
      "https://public.example/article?token=do-not-send",
      "https://public.example/article?%2561ccess_token=do-not-send",
    ];
    let providerUrls;
    await tinyfishFetchPages([...unsafeUrls, safeUrl], {
      fetchImpl: async (_url, init) => {
        providerUrls = JSON.parse(init.body).urls;
        return jsonResponse({ results: [], errors: [] });
      },
    });

    assert.deepEqual(providerUrls, [safeUrl]);
  });

  test("含敏感查询参数的 URL 会在发往 provider 前被拒绝", async () => {
    const sensitiveUrls = [
      "https://private.example/a?token=do-not-send",
      "https://private.example/b?access_token=do-not-send",
      "https://private.example/c?api-key=do-not-send",
      "https://private.example/d?signature=do-not-send",
      "https://private.example/e?password=do-not-send",
    ];
    let calls = 0;
    const output = await tinyfishFetchPages(sensitiveUrls, {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ results: [], errors: [] });
      },
    });

    assert.equal(calls, 0);
    assert.deepEqual(output, { results: [], failures: [] });
  });

  test("忽略 provider 注入的非请求 URL，但允许请求 URL 的正常重定向", async () => {
    const requestedUrl = "https://requested.example/article";
    const redirectedUrl = "https://requested.example/article-final";
    const output = await tinyfishFetchPages([requestedUrl], {
      fetchImpl: async () =>
        jsonResponse({
          results: [
            {
              url: "https://unrequested.example/injected",
              final_url: "https://unrequested.example/injected-final",
              title: "非请求页面",
              text: longBody("非请求页面"),
            },
            {
              url: requestedUrl,
              final_url: redirectedUrl,
              title: "请求页面",
              text: longBody("请求页面"),
            },
          ],
          errors: [],
        }),
    });

    assert.equal(output.results.length, 1);
    assert.equal(output.results[0].requestedUrl, requestedUrl);
    assert.equal(output.results[0].url, redirectedUrl);
    assert.equal(output.results[0].title, "请求页面");
  });

  test("provider 返回的 final_url 也必须通过完整静态公开URL边界", async () => {
    const requestedUrl = "https://requested.example/article";
    const safeFinalUrl = "https://public.example/article-final";
    const unsafeFinalUrls = [
      "http://localhost/private",
      "http://service.internal/private",
      "http://10.0.0.8/private",
      "http://169.254.169.254/latest/meta-data",
      "http://198.51.100.8/documentation",
      "http://[::1]/private",
      "https://public.example:9443/private",
      "https://user:password@public.example/private",
      "https://public.example/private?authorization=do-not-accept",
    ];
    const output = await tinyfishFetchPages([requestedUrl], {
      fetchImpl: async () => jsonResponse({
        results: [
          ...unsafeFinalUrls.map((finalUrl, index) => ({
            url: requestedUrl,
            final_url: finalUrl,
            title: `不安全最终页${index + 1}`,
            text: longBody(`不安全最终页${index + 1}`),
          })),
          {
            url: requestedUrl,
            final_url: safeFinalUrl,
            title: "安全最终页",
            text: longBody("安全最终页"),
          },
        ],
        errors: [],
      }),
    });

    assert.equal(output.results.length, 1);
    assert.equal(output.results[0].url, safeFinalUrl);
    assert.equal(output.results[0].requestedUrl, requestedUrl);
  });

  test("Search 结果同样不会放行不安全候选 URL", async () => {
    const output = await tinyfishSearch("公开来源过滤", {
      max: 10,
      fetchImpl: async () => jsonResponse({
        results: [
          { title: "本机", url: "http://127.0.0.1/private", snippet: "不安全" },
          { title: "内网", url: "http://10.0.0.8/private", snippet: "不安全" },
          { title: "非默认端口", url: "https://public.example:8443/private", snippet: "不安全" },
          { title: "敏感参数", url: "https://public.example/a?secret=value", snippet: "不安全" },
          { title: "公开来源", url: "https://public.example/article#section", snippet: "安全" },
        ],
      }),
    });

    assert.deepEqual(output, [{
      title: "公开来源",
      url: "https://public.example/article",
      snippet: "安全",
    }]);
  });
});

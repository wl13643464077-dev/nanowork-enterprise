import test from "node:test";
import assert from "node:assert/strict";

process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
process.env.YUNWU_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.TINYFISH_API_KEY = "";

const { agenticWebResearch } =
  await import("../src/engines/agentic-web-research.js");

function searchCandidates(count = 5, { sharedHost = false } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    title: `公开来源 ${index + 1}`,
    url: sharedHost
      ? `https://shared.example.com/article-${index + 1}`
      : `https://source-${index + 1}.example.com/article-${index + 1}`,
    snippet: `候选摘要 ${index + 1}`,
  }));
}

function fetchedPages(candidates, { bodyLength = 450, count = 3 } = {}) {
  return candidates.slice(0, count).map((candidate, index) => ({
    title: candidate?.title || `公开来源 ${index + 1}`,
    url: typeof candidate === "string" ? candidate : candidate.url,
    snippet: `受控正文摘要 ${index + 1}`,
    body: `核验近期公开经营信息 ${index + 1} ${String(index + 1).repeat(bodyLength)}`,
  }));
}

function claudeSuccess(provider = "fixture-claude-websearch") {
  const candidates = searchCandidates(6);
  const response = {
    attempted: true,
    ok: true,
    candidateReady: true,
    provider,
    results: candidates.slice(0, 5),
    evidence: {
      schemaVersion: "nanowork.agentic-web-research/1",
      executionMode: "isolated_claude_cli",
      externalCall: true,
    },
  };
  Object.defineProperty(response, "fetchCandidates", {
    value: candidates,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return response;
}

async function runTiered({
  searchResult = searchCandidates(),
  fetchResult,
  searchError,
  fetchError,
} = {}) {
  const calls = { search: 0, fetch: 0, claude: 0 };
  const result = await agenticWebResearch("核验近期公开经营信息", {
    maxResults: 8,
    timeoutMs: 5_000,
    tinyfishEnabled: true,
    tinyfishSearchFn: async () => {
      calls.search += 1;
      if (searchError) throw searchError;
      return searchResult;
    },
    tinyfishFetchFn: async (candidates) => {
      calls.fetch += 1;
      if (fetchError) throw fetchError;
      return (
        fetchResult || {
          results: fetchedPages(candidates),
          failures: [],
        }
      );
    },
    claudeResearchFn: async () => {
      calls.claude += 1;
      return claudeSuccess();
    },
  });
  return { result, calls };
}

test("TinyFish 搜索与抓取达到质量门时不调用 Claude", async () => {
  const { result, calls } = await runTiered();

  assert.deepEqual(calls, { search: 1, fetch: 1, claude: 0 });
  assert.equal(result.provider, "TinyFish Search + Fetch");
  assert.equal(result.candidateReady, true);
  assert.ok(Array.isArray(result.fetchCandidates));
  assert.ok(result.fetchCandidates.length >= 5);
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(result, "fetchCandidates"),
    false,
  );
  assert.equal(
    result.evidence?.schemaVersion,
    "nanowork.tiered-web-research/1",
  );
  assert.deepEqual(result.evidence?.providerRoute, ["tinyfish"]);
  assert.equal(result.evidence?.fallback?.triggered, false);
});

test("TinyFish 搜索零结果时直接回退 Claude", async () => {
  const { result, calls } = await runTiered({ searchResult: [] });

  assert.deepEqual(calls, { search: 1, fetch: 0, claude: 1 });
  assert.equal(result.provider, "fixture-claude-websearch");
  assert.equal(result.candidateReady, true);
  assert.deepEqual(result.evidence?.providerRoute, [
    "tinyfish",
    "claude_websearch",
  ]);
  assert.equal(result.evidence?.fallback?.triggered, true);
  assert.equal(typeof result.evidence?.fallback?.reasonCode, "string");
});

test("TinyFish 抓取失败时回退 Claude，证据不泄露原始错误或密钥", async () => {
  const secret = "tf-secret-key-must-not-leak";
  const { result, calls } = await runTiered({
    fetchError: Object.assign(
      new Error(`TinyFish upstream rejected X-API-Key=${secret}`),
      { code: "TINYFISH_HTTP_FAILED", providerStatus: 401 },
    ),
  });

  assert.deepEqual(calls, { search: 1, fetch: 1, claude: 1 });
  assert.equal(result.provider, "fixture-claude-websearch");
  assert.deepEqual(result.evidence?.providerRoute, [
    "tinyfish",
    "claude_websearch",
  ]);
  assert.equal(result.evidence?.fallback?.triggered, true);
  assert.match(
    String(result.evidence?.fallback?.reasonCode || ""),
    /^[a-z0-9_:-]{1,120}$/iu,
  );
  const serializedEvidence = JSON.stringify(result.evidence);
  assert.equal(serializedEvidence.includes(secret), false);
  assert.equal(serializedEvidence.includes("X-API-Key"), false);
  assert.equal(serializedEvidence.includes("upstream rejected"), false);
});

test("TinyFish 整理质量不足时回退 Claude", async () => {
  const candidates = searchCandidates(5, { sharedHost: true });
  const { result, calls } = await runTiered({
    searchResult: candidates,
    fetchResult: {
      results: fetchedPages(candidates, { bodyLength: 399, count: 3 }),
      failures: [],
    },
  });

  // 虽有5个合法候选和3篇正文，但只有1个域名且正文总量低于1200字。
  assert.deepEqual(calls, { search: 1, fetch: 1, claude: 1 });
  assert.equal(result.provider, "fixture-claude-websearch");
  assert.equal(result.candidateReady, true);
  assert.deepEqual(result.evidence?.providerRoute, [
    "tinyfish",
    "claude_websearch",
  ]);
  assert.equal(result.evidence?.fallback?.triggered, true);
  assert.equal(typeof result.evidence?.fallback?.reasonCode, "string");
});

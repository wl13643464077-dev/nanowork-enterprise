import test from "node:test";
import assert from "node:assert/strict";

process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
process.env.YUNWU_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.TINYFISH_API_KEY = "";

const { agenticWebResearch } =
  await import("../src/engines/agentic-web-research.js");
const { sanitizePublicSources } =
  await import("../src/engines/public-source-quality.js");

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

test("TinyFish回退Claude时把真实usage与供应商回执透传给结算层", async () => {
  const candidates = searchCandidates(6);
  const receipt = {
    status: "known",
    costYuanOverride: 0.08,
    costSource: { provider: "360", requestId: "receipt-fixture" },
  };
  const claude = {
    attempted: true,
    ok: true,
    candidateReady: true,
    provider: "360 Claude WebSearch API",
    results: [],
    evidence: {
      schemaVersion: "nanowork.agentic-web-research/1",
      executionMode: "provider_360_search_enhancement",
      model: "anthropic/claude-sonnet-4-6",
      usage: { inputTokens: 800, outputTokens: 120, supplierCosts: [receipt] },
      supplierCosts: [receipt],
      costYuan: 0.08,
      costStatus: "known",
      externalCall: true,
    },
  };
  Object.defineProperty(claude, "fetchCandidates", {
    value: candidates,
    enumerable: false,
  });
  const result = await agenticWebResearch("核验近期公开经营信息", {
    tinyfishEnabled: true,
    tinyfishSearchFn: async () => [],
    claudeResearchFn: async () => claude,
  });
  assert.equal(result.evidence.model, "anthropic/claude-sonnet-4-6");
  assert.deepEqual(result.evidence.usage, claude.evidence.usage);
  assert.deepEqual(result.evidence.supplierCosts, [receipt]);
  assert.equal(result.evidence.costYuan, 0.08);
  assert.equal(result.evidence.costStatus, "known");
  assert.equal(result.fetchCandidates.length, 6);
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

const LOCATION_TASK = Object.freeze({
  title: "清凤时代城商圈竞品与流量勘察",
  requirement: "成都清凤时代城1楼底商周边1-3公里的烘焙餐饮门店、菜单及评价。",
});
const LOCATION_QUERY = "成都清凤时代城 烘焙 门店 菜单";

function strictTaskCandidates(rows) {
  return sanitizePublicSources(rows, {
    locationBusinessTask: true,
    requireTaskRelevance: true,
    task: LOCATION_TASK,
  }).accepted;
}

function taskCandidates() {
  return searchCandidates(5).map(source => ({
    ...source,
    title: "成都清凤时代城烘焙餐饮门店",
    snippet: "成都清凤时代城餐饮门店菜单与营业状态。",
  }));
}

function taskPages(candidates, { unrelated = false } = {}) {
  return candidates.slice(0, 3).map((source, index) => ({
    title: unrelated ? "上海餐饮门店菜单" : source.title,
    url: source.url,
    snippet: unrelated ? "上海门店菜单与评价。" : source.snippet,
    body: `${unrelated ? "上海餐饮门店" : "成都清凤时代城烘焙餐饮门店"}菜单与营业时间，评价主题与经营状态按核验日回看。${String(index + 1).repeat(500)}`,
  }));
}

test("TinyFish七条泛站点未通过任务候选门时只回退360一次", async () => {
  let fetchCalls = 0;
  let fallbackCalls = 0;
  const response = await agenticWebResearch(LOCATION_QUERY, {
    tinyfishEnabled: true,
    tinyfishSearchFn: async () => [
      "https://www.lianjia.com/", "https://www.trip.com/", "https://www.openrice.com/",
      "https://www.bank.example/", "https://www.facebook.com/", "https://www.hotels.example/", "https://www.travel.example/",
    ].map((url, index) => ({ title: `全球门店与旅游站点${index + 1}`, url, snippet: "餐饮门店与出行信息" })),
    tinyfishFetchFn: async () => {
      fetchCalls += 1;
      assert.fail("不相关泛站点不应占用正文抓取预算");
    },
    validateCandidates: strictTaskCandidates,
    claudeResearchFn: async () => {
      fallbackCalls += 1;
      return claudeSuccess("360 Claude WebSearch API");
    },
  });
  assert.equal(fetchCalls, 0);
  assert.equal(fallbackCalls, 1);
  assert.equal(response.provider, "360 Claude WebSearch API");
  assert.equal(response.evidence.fallback.reasonCode, "TINYFISH_TASK_CANDIDATES_INSUFFICIENT");
  assert.equal(response.evidence.tinyfish.taskValidation.rejectedCandidateCount, 7);
  assert.equal(response.evidence.tinyfish.qualityGate.passed, false);
});

test("TinyFish搜索标题相关但实际正文异地时不能直达成功，并保留360候选provenance", async () => {
  const candidates = taskCandidates();
  const fallback = claudeSuccess("360 Claude WebSearch API");
  const provenance = Object.freeze({ provider: "360", sourcePath: "context.web_search_records" });
  fallback.fetchCandidates[0].sourceProvenance = provenance;
  const validationStages = [];
  let fallbackCalls = 0;
  const result = await agenticWebResearch(LOCATION_QUERY, {
    tinyfishEnabled: true,
    tinyfishSearchFn: async () => candidates,
    tinyfishFetchFn: async () => ({ results: taskPages(candidates, { unrelated: true }), failures: [] }),
    validateCandidates: rows => {
      validationStages.push(rows.some(row => typeof row.body === "string") ? "pages" : "candidates");
      return strictTaskCandidates(rows);
    },
    claudeResearchFn: async () => {
      fallbackCalls += 1;
      return fallback;
    },
  });
  assert.deepEqual(validationStages, ["candidates", "pages"], "360记录应留给调用方独立的provenance与正文门");
  assert.equal(fallbackCalls, 1);
  assert.equal(result.evidence.fallback.reasonCode, "TINYFISH_TASK_PAGES_INSUFFICIENT");
  assert.equal(result.evidence.tinyfish.fetchedPageCount, 0);
  assert.equal(result.evidence.tinyfish.taskValidation.rejectedPageCount, 3);
  assert.equal(result.evidence.tinyfish.qualityGate.passed, false);
  assert.equal(result.fetchCandidates[0].sourceProvenance, provenance);
});

test("TinyFish正文通过任务门与原材料门时不回退，validator不能注入新来源或provider归因", async () => {
  const candidates = taskCandidates();
  let fallbackCalls = 0;
  const result = await agenticWebResearch(LOCATION_QUERY, {
    tinyfishEnabled: true,
    tinyfishSearchFn: async () => candidates,
    tinyfishFetchFn: async () => ({ results: taskPages(candidates), failures: [] }),
    validateCandidates: rows => [
      ...strictTaskCandidates(rows).map(row => ({ ...row, sourceProvenance: { provider: "360" } })),
      { title: "伪造来源", url: "https://not-requested.example/fake", body: "伪造正文" },
    ],
    claudeResearchFn: async () => { fallbackCalls += 1; return claudeSuccess(); },
  });
  assert.equal(fallbackCalls, 0);
  assert.equal(result.provider, "TinyFish Search + Fetch");
  assert.equal(result.evidence.tinyfish.qualityGate.passed, true);
  assert.equal(result.evidence.tinyfish.fetchedPageCount, 3);
  assert.ok(result.fetchCandidates.every(row => row.sourceProvenance === undefined));
  assert.ok(result.fetchCandidates.every(row => !row.url.includes("not-requested.example")));
});

test("TinyFish任务校验异常失败关闭并脱敏，仍只调用一次备用通道", async () => {
  let fallbackCalls = 0;
  const result = await agenticWebResearch(LOCATION_QUERY, {
    tinyfishEnabled: true,
    tinyfishSearchFn: async () => taskCandidates(),
    validateCandidates: () => { throw new Error("secret-validator-error"); },
    claudeResearchFn: async () => { fallbackCalls += 1; return claudeSuccess(); },
  });
  assert.equal(fallbackCalls, 1);
  assert.equal(result.evidence.fallback.reasonCode, "TINYFISH_CANDIDATE_VALIDATION_FAILED");
  assert.equal(JSON.stringify(result.evidence).includes("secret-validator-error"), false);
});

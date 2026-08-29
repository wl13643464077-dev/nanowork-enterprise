import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), `nanowork-agentic-research-test-${process.pid}-`),
);
const dbPath = path.join(testRoot, "research.db");
const fakeCliPath = path.join(testRoot, "fake-claude.mjs");
const originalEnv = {
  NANOWORK_DB: process.env.NANOWORK_DB,
  NANOWORK_TEST_TEMPLATE_AI: process.env.NANOWORK_TEST_TEMPLATE_AI,
  YUNWU_API_KEY: process.env.YUNWU_API_KEY,
  CONTENTCREW_CLAUDE_PATH: process.env.CONTENTCREW_CLAUDE_PATH,
  NANOWORK_RESEARCH_MODEL: process.env.NANOWORK_RESEARCH_MODEL,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  AWS_PROFILE: process.env.AWS_PROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  TMPDIR: process.env.TMPDIR,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  HTTP_PROXY: process.env.HTTP_PROXY,
  ALL_PROXY: process.env.ALL_PROXY,
  NO_PROXY: process.env.NO_PROXY,
  https_proxy: process.env.https_proxy,
  http_proxy: process.env.http_proxy,
  CURSOR_AGENT: process.env.CURSOR_AGENT,
  CURSOR_SANDBOX: process.env.CURSOR_SANDBOX,
};

process.env.NANOWORK_DB = dbPath;
process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
process.env.YUNWU_API_KEY = "qa-agentic-key";
process.env.NANOWORK_RESEARCH_MODEL = "claude-qa-websearch";
process.env.TMPDIR = testRoot;
// These values simulate a developer workstation login. The child must not
// inherit them; safeRunnerEnv is expected to construct a fresh HOME instead.
process.env.CLAUDE_CODE_OAUTH_TOKEN = "host-login-must-not-leak";
process.env.AWS_PROFILE = "host-profile-must-not-leak";
process.env.CLAUDE_CONFIG_DIR = "/host/claude-config-must-not-leak";

const { initSchema } = await import("../src/db.js");
initSchema();
const {
  agenticWebResearch,
  agenticWebResearchReadiness,
  researchGatewayHosts,
} = await import("../src/engines/agentic-web-research.js");
const { fetchControlledWebEvidence } = await import(
  "../src/engines/controlled-web-evidence.js",
);

function writeFakeCli({ mode = "success", capturePath }) {
  const source = `#!/usr/bin/env node
import fs from "node:fs";

const capturePath = ${JSON.stringify(capturePath)};
const mode = ${JSON.stringify(mode)};
const input = fs.readFileSync(0, "utf8");
const settingsIndex = process.argv.indexOf("--settings");
const settingsValue = settingsIndex >= 0 ? process.argv[settingsIndex + 1] : null;
let settings = null;
if (settingsValue) {
  try {
    settings = settingsValue.startsWith("{")
      ? JSON.parse(settingsValue)
      : JSON.parse(fs.readFileSync(settingsValue, "utf8"));
  } catch {
    settings = { path: settingsValue };
  }
}
fs.writeFileSync(capturePath, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  settings,
  env: {
    HOME: process.env.HOME || null,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || null,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || null,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME || null,
    TMPDIR: process.env.TMPDIR || null,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || null,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || null,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
    AWS_PROFILE: process.env.AWS_PROFILE || null,
    HTTPS_PROXY: process.env.HTTPS_PROXY || null,
    HTTP_PROXY: process.env.HTTP_PROXY || null,
    ALL_PROXY: process.env.ALL_PROXY || null,
    NO_PROXY: process.env.NO_PROXY || null,
  },
  input,
}));
if (mode === "timeout") {
  setInterval(() => {}, 1000);
} else if (mode === "timeout-with-candidates") {
  const queries = [
    "太原吾悦广场 毛血旺 官方位置",
    "太原吾悦广场 餐饮竞品 菜单价格",
    "太原吾悦广场 交通 周边需求",
    "太原吾悦广场 近期营业状态 新闻",
    "太原吾悦广场 评价 客单价",
  ];
  const events = queries.flatMap((query, index) => {
    const toolUseId = "timeout-web-search-" + (index + 1);
    return [
      { type: "assistant", message: { content: [
        { type: "tool_use", id: toolUseId, name: "WebSearch", input: { query } },
      ] } },
      { type: "user", message: { content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          is_error: false,
          content: "WebSearch result URL: https://tool.example/timeout-source-" + (index + 1),
        },
      ] } },
    ];
  });
  events.forEach((event) => process.stdout.write(JSON.stringify(event) + "\\n"));
  setInterval(() => {}, 1000);
} else if (mode === "failure") {
  process.stderr.write("fake CLI failure\\n");
  process.exit(7);
} else if (mode === "sandbox-blocked") {
  process.stdout.write(JSON.stringify({
    type: "result",
    is_error: true,
    error: "authentication_failed",
    result: "Failed to authenticate. API Error: 403 Blocked by sandbox network policy\\nDestination: yunwu.ai:443\\nReason: not on allow list\\n",
  }) + "\\n");
  process.exit(0);
} else if (mode === "failure-with-candidates") {
  const queries = [
    "太原吾悦广场 毛血旺 官方位置",
    "太原吾悦广场 餐饮竞品 菜单价格",
    "太原吾悦广场 交通 周边需求",
    "太原吾悦广场 近期营业状态 新闻",
    "太原吾悦广场 评价 客单价",
  ];
  const events = queries.flatMap((query, index) => {
    const toolUseId = "fail-web-search-" + (index + 1);
    return [
      { type: "assistant", message: { content: [
        { type: "tool_use", id: toolUseId, name: "WebSearch", input: { query } },
      ] } },
      { type: "user", message: { content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          is_error: false,
          content: "WebSearch result URL: https://tool.example/fail-source-" + (index + 1),
        },
      ] } },
    ];
  });
  events.push({
    type: "result",
    is_error: true,
    error: "api_error",
    result: "upstream interrupted after successful searches",
  });
  events.forEach((event) => process.stdout.write(JSON.stringify(event) + "\\n"));
  process.exit(1);
} else if (mode === "long-candidates") {
  const longUrls = Array.from({ length: 60 }, (_unused, index) => {
    if (index === 12) return "https://www.dianping.com/shop/after-thirteen-wuyue";
    if (index === 13) return "https://www.seazen.com.cn/project/after-thirteen-wuyue";
    if (index === 20) return "https://zh.wikipedia.org/wiki/太原市";
    return "https://candidate.example/source-" + (index + 1);
  });
  const queries = [
    "太原吾悦广场 毛血旺 官方位置",
    "太原吾悦广场 餐饮竞品 菜单价格",
    "太原吾悦广场 交通 周边需求",
    "太原吾悦广场 近期营业状态 新闻",
    "太原吾悦广场 评价 客单价",
  ];
  const toolEvents = queries.flatMap((query, index) => {
    const toolUseId = "long-web-search-" + (index + 1);
    return [
      { type: "assistant", message: { content: [
        { type: "tool_use", id: toolUseId, name: "WebSearch", input: { query } },
      ] } },
      { type: "user", message: { content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          is_error: false,
          content: "WebSearch result URLs: " + longUrls.join(" "),
        },
      ] } },
    ];
  });
  const events = [
    ...toolEvents,
    { type: "result", is_error: false, result: JSON.stringify({
      queries,
      sources: longUrls.slice(0, 12).map((url, index) => ({
        title: "公开来源" + (index + 1),
        url,
        snippet: "太原吾悦广场毛血旺餐饮公开候选" + (index + 1),
      })),
      facts: [],
      gaps: [],
    }), usage: { input_tokens: 123, output_tokens: 456 }, total_cost_usd: 0.42 },
  ];
  events.forEach((event, index) => process.stdout.write(
    JSON.stringify(event) + (index === events.length - 1 ? "" : "\\n"),
  ));
} else {
  const manySearches = mode === "eleven-searches";
  const queries = manySearches
    ? Array.from({ length: 11 }, (_unused, index) => "太原吾悦广场 轮次" + (index + 1))
    : [
      "太原吾悦广场 毛血旺 官方位置",
      "太原吾悦广场 餐饮竞品 菜单价格",
      "太原吾悦广场 交通 周边需求",
      "太原吾悦广场 近期营业状态 新闻",
      "太原吾悦广场 评价 客单价",
    ];
  const toolUrls = manySearches
    ? queries.flatMap((_query, queryIndex) => Array.from(
      { length: 10 },
      (_unused, urlIndex) => "https://tool.example/search-" + (queryIndex + 1) + "-" + (urlIndex + 1),
    ))
    : queries.map((_query, index) => "https://tool.example/source-" + (index + 1));
  const toolEvents = queries.flatMap((query, index) => {
    const toolUseId = "web-search-" + (index + 1);
    const denied = mode === "permission-denied";
    const resultUrls = manySearches
      ? toolUrls.slice(index * 10, index * 10 + 10)
      : [toolUrls[index]];
    return [
      { type: "assistant", message: { content: [
        { type: "tool_use", id: toolUseId, name: "WebSearch", input: { query } },
      ] } },
      { type: "user", message: { content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          is_error: denied,
          content: denied
            ? "Permission denied: WebSearch is not allowed"
            : "WebSearch result URL: " + resultUrls.join(" "),
        },
      ] } },
    ];
  });
  const payloadUrls = mode === "missing-sources"
    ? []
    : mode === "forged-sources"
    ? queries.map((_query, index) => "https://forged.example/not-in-tool-" + (index + 1))
    : toolUrls;
  const events = [
    ...toolEvents,
    { type: "result", is_error: false, result: JSON.stringify({
      queries: ["payload query should be merged"],
      sources: payloadUrls.map((url, index) => ({
        title: "公开来源" + (index + 1),
        url,
        snippet: "来源支持公开事实" + (index + 1),
        date: "2026-08-08",
      })),
      facts: [{ claim: "吾悦广场位置由工具结果来源支持", sourceUrls: [payloadUrls[0] || toolUrls[0]], confidence: "high" }],
      gaps: ["仍需企业私有客流与实地核验"],
    }), usage: { input_tokens: 123, output_tokens: 456, cache_read_input_tokens: 9 }, total_cost_usd: 0.42 },
  ];
  events.forEach((event, index) => process.stdout.write(
    JSON.stringify(event) + (index === events.length - 1 ? "" : "\\n"),
  ));
}
`;
  fs.writeFileSync(fakeCliPath, source, { mode: 0o700 });
}

function readCapture(capturePath) {
  return JSON.parse(fs.readFileSync(capturePath, "utf8"));
}

function activeResearchRuntimeDirs() {
  return fs
    .readdirSync(testRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("nanowork-research-"))
    .map((entry) => entry.name)
    .sort();
}

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("agentic web research only runs isolated Claude WebSearch and preserves evidence", { concurrency: false }, async () => {
  const capturePath = path.join(testRoot, "success-capture.json");
  writeFakeCli({ capturePath });
  process.env.CONTENTCREW_CLAUDE_PATH = fakeCliPath;

  const readiness = agenticWebResearchReadiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.cliReady, true);
  assert.equal(readiness.credentialReady, true);
  assert.equal(readiness.model, "claude-qa-websearch");

  const result = await agenticWebResearch("毛血旺 太原吾悦广场", {
    maxResults: 6,
    // The full suite runs many subprocess-heavy cases in parallel. Keep this
    // success-path fixture comfortably above scheduler jitter; dedicated tests
    // below still verify the hard-timeout behavior with short limits.
    timeoutMs: 5_000,
  });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, true);
  assert.equal(result.candidateReady, true);
  assert.equal(result.results.length, 5);
  assert.equal(result.fetchCandidates.length, 5);
  assert.equal(Object.keys(result).includes("fetchCandidates"), false, "未核验候选不得可枚举");
  assert.equal(JSON.stringify(result).includes("fetchCandidates"), false, "未核验候选不得进入JSON快照");
  assert.deepEqual(
    result.results.map((item) => item.url),
    [
      "https://tool.example/source-1",
      "https://tool.example/source-2",
      "https://tool.example/source-3",
      "https://tool.example/source-4",
      "https://tool.example/source-5",
    ],
  );
  assert.equal(result.results[0].publishedAt, "2026-08-08");
  assert.equal(result.evidence.executionMode, "isolated_claude_cli");
  assert.equal(result.evidence.toolCalls, 5);
  assert.equal(result.evidence.toolAttempts, 5);
  assert.equal(result.evidence.toolResults.length, 5);
  assert.deepEqual(
    result.evidence.toolResults.map((item) => item.toolUseId),
    ["web-search-1", "web-search-2", "web-search-3", "web-search-4", "web-search-5"],
  );
  assert.ok(result.evidence.toolResults.every((item) => item.success === true));
  assert.ok(result.evidence.toolResults.every((item) => item.permissionDenied === false));
  assert.ok(result.evidence.toolResults.every((item) => item.urlCount === 1));
  assert.equal(result.evidence.qualityGate.observedSearches, 5);
  assert.equal(result.evidence.qualityGate.observedSuccessfulToolResults, 5);
  assert.equal(result.evidence.qualityGate.observedToolResultUrls, 5);
  assert.equal(result.evidence.qualityGate.observedSources, 5);
  assert.equal(result.evidence.qualityGate.passed, true);
  assert.equal(result.evidence.candidateGate.passed, true);
  assert.equal(result.evidence.candidateGate.observedCandidates, 5);
  assert.equal(result.evidence.candidateGate.requiresControlledWebFetch, true);
  assert.deepEqual(
    result.evidence.steps.filter((step) => step.tool === "WebSearch").map((step) => step.id),
    ["web-search-1", "web-search-2", "web-search-3", "web-search-4", "web-search-5"],
  );
  assert.deepEqual(result.evidence.queries, [
    "太原吾悦广场 毛血旺 官方位置",
    "太原吾悦广场 餐饮竞品 菜单价格",
    "太原吾悦广场 交通 周边需求",
    "太原吾悦广场 近期营业状态 新闻",
    "太原吾悦广场 评价 客单价",
    "payload query should be merged",
  ]);
  assert.equal(result.evidence.usage.inputTokens, 123);
  assert.equal(result.evidence.usage.outputTokens, 456);
  assert.equal(result.evidence.usage.cacheReadInputTokens, 9);
  assert.equal(result.evidence.costUsd, 0.42);
  assert.equal(result.evidence.externalCall, true);
  assert.equal(result.evidence.localLoginInherited, false);

  const capture = readCapture(capturePath);
  assert.equal(capture.input.includes("毛血旺 太原吾悦广场"), true);
  assert.equal(capture.argv.join(" ").includes("只能调用WebSearch"), true);
  assert.equal(capture.argv.includes("--tools"), true);
  assert.equal(capture.argv[capture.argv.indexOf("--tools") + 1], "WebSearch");
  assert.equal(capture.argv.includes("--allowedTools"), true);
  assert.equal(capture.argv[capture.argv.indexOf("--allowedTools") + 1], "WebSearch");
  assert.equal(capture.argv.includes("--permission-mode"), true);
  assert.equal(capture.argv[capture.argv.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(capture.argv.includes("--strict-mcp-config"), true);
  assert.equal(capture.argv.includes("--setting-sources"), true);
  assert.equal(capture.argv[capture.argv.indexOf("--setting-sources") + 1], "");
  assert.equal(capture.argv.includes("--settings"), true);
  assert.match(
    capture.argv[capture.argv.indexOf("--settings") + 1],
    /research-network\.json$/u,
  );
  assert.deepEqual(
    capture.settings?.sandbox?.network?.allowedDomains,
    researchGatewayHosts(),
  );
  assert.equal(capture.settings.sandbox.network.allowedDomains.includes("yunwu.ai"), true);
  assert.equal(capture.settings.sandbox.network.allowedDomains.includes("*.yunwu.ai"), true);
  assert.equal(capture.argv.includes("--no-session-persistence"), true);
  assert.equal(capture.argv.includes("--no-chrome"), true);
  assert.equal(capture.argv.includes("--output-format"), true);
  assert.equal(capture.argv[capture.argv.indexOf("--output-format") + 1], "stream-json");
  assert.equal(capture.env.ANTHROPIC_AUTH_TOKEN, "qa-agentic-key");
  assert.equal(capture.env.CLAUDE_CODE_OAUTH_TOKEN, null);
  assert.equal(capture.env.AWS_PROFILE, null);
  assert.notEqual(capture.env.HOME, process.env.HOME);
  assert.match(capture.env.HOME, /nanowork-research-[^/]+\/home/u);
  assert.match(capture.env.CLAUDE_CONFIG_DIR, /nanowork-research-[^/]+\/home\/claude/u);
  assert.equal(fs.existsSync(capture.cwd), false, "research workdir must be removed");
});

test("11轮WebSearch按轮次公平汇入最多60条受控候选", { concurrency: false }, async () => {
  const capturePath = path.join(testRoot, "eleven-searches-capture.json");
  writeFakeCli({ mode: "eleven-searches", capturePath });
  process.env.CONTENTCREW_CLAUDE_PATH = fakeCliPath;

  const result = await agenticWebResearch("跨轮次候选池容量测试", {
    maxResults: 12,
    timeoutMs: 2_000,
  });
  assert.equal(result.attempted, true);
  assert.equal(result.candidateReady, true);
  assert.equal(result.evidence.toolAttempts, 11);
  assert.equal(result.evidence.toolCalls, 11);
  assert.equal(result.evidence.candidateGate.observedCandidates, 60);
  assert.equal(result.fetchCandidates.length, 60);
  assert.equal(new Set(result.fetchCandidates.map((item) => item.url)).size, 60);
  for (let queryIndex = 1; queryIndex <= 11; queryIndex += 1) {
    assert.ok(
      result.fetchCandidates.some((item) => item.url.includes(`/search-${queryIndex}-`)),
      `第${queryIndex}轮搜索至少应贡献候选`,
    );
  }
  assert.equal(Object.keys(result).includes("fetchCandidates"), false);
  assert.equal(
    JSON.stringify(result).includes("/search-11-"),
    false,
    "候选池尾部URL只能通过不可枚举句柄传给同栈受控抓取",
  );
});

test("tool_use配对permission denied时不把失败冒充为成功来源", { concurrency: false }, async () => {
  const capturePath = path.join(testRoot, "permission-denied-capture.json");
  writeFakeCli({ mode: "permission-denied", capturePath });
  process.env.CONTENTCREW_CLAUDE_PATH = fakeCliPath;

  const result = await agenticWebResearch("WebSearch权限拒绝测试", {
    maxResults: 6,
    timeoutMs: 2_000,
  });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 0);
  assert.equal(result.evidence.toolAttempts, 5);
  assert.equal(result.evidence.toolCalls, 0);
  assert.equal(result.evidence.toolResults.length, 5);
  assert.ok(result.evidence.toolResults.every((item) => item.success === false));
  assert.ok(result.evidence.toolResults.every((item) => item.permissionDenied === true));
  assert.equal(result.evidence.qualityGate.observedSearches, 5);
  assert.equal(result.evidence.qualityGate.observedSuccessfulToolResults, 0);
  assert.equal(result.evidence.qualityGate.observedToolResultUrls, 0);
  assert.equal(result.evidence.qualityGate.observedSources, 0);
  assert.equal(result.evidence.qualityGate.passed, false);
  assert.equal(result.candidateReady, false);
  assert.equal(result.evidence.candidateGate.passed, false);
  assert.match(result.note, /成功工具结果0次/u);
});

test("最终sources补造不在tool_result中的URL时被归因门拒绝", { concurrency: false }, async () => {
  const capturePath = path.join(testRoot, "forged-sources-capture.json");
  writeFakeCli({ mode: "forged-sources", capturePath });
  process.env.CONTENTCREW_CLAUDE_PATH = fakeCliPath;

  const result = await agenticWebResearch("最终来源归因测试", {
    maxResults: 6,
    timeoutMs: 2_000,
  });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.equal(result.candidateReady, true, "工具结果已满足候选门，即使最终来源归因失败也应保留候选能力");
  assert.deepEqual(result.results, [], "最终补造URL不得进入归因通过来源");
  assert.ok(result.fetchCandidates.length >= 5, "补造来源只能停留在同栈受控抓取候选");
  assert.ok(
    result.fetchCandidates.some((candidate) => /tool\.example\/source-/u.test(candidate.url)),
    "候选应至少包含真实tool_result URL，供受控抓取继续",
  );
  assert.equal(Object.keys(result).includes("fetchCandidates"), false);
  assert.equal(JSON.stringify(result).includes("forged.example"), false, "候选URL不得进入可枚举JSON");
  assert.equal(result.evidence.toolAttempts, 5);
  assert.equal(result.evidence.toolCalls, 5);
  assert.equal(result.evidence.toolResults.length, 5);
  assert.ok(result.evidence.toolResults.every((item) => item.success === true));
  assert.equal(result.evidence.qualityGate.observedSuccessfulToolResults, 5);
  assert.equal(result.evidence.qualityGate.observedToolResultUrls, 5);
  assert.equal(result.evidence.qualityGate.observedSources, 0);
  assert.equal(result.evidence.qualityGate.passed, false);
  assert.equal(result.evidence.candidateGate.passed, true);
  assert.ok(result.evidence.candidateGate.observedCandidates >= 5);
  assert.match(result.note, /其中0条与工具结果URL完全一致/u);
});

test("payload缺失sources但五个成功tool_result仍形成候选并可继续受控抓取", { concurrency: false }, async () => {
  const capturePath = path.join(testRoot, "missing-sources-capture.json");
  writeFakeCli({ mode: "missing-sources", capturePath });
  process.env.CONTENTCREW_CLAUDE_PATH = fakeCliPath;

  const result = await agenticWebResearch("最终payload缺失来源测试", {
    maxResults: 6,
    timeoutMs: 2_000,
  });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false, "未提供最终sources时仍需等待受控正文，不能直接视为完整成功");
  assert.equal(result.candidateReady, true);
  assert.deepEqual(result.results, []);
  assert.ok(result.fetchCandidates.length >= 5);
  assert.equal(result.evidence.candidateGate.declaredCandidates, 0);
  assert.equal(result.evidence.candidateGate.toolResultCandidates, 5);
  assert.equal(result.evidence.candidateGate.observedCandidates, result.fetchCandidates.length);
  assert.equal(result.evidence.candidateGate.passed, true);
  assert.ok(result.fetchCandidates.every((candidate) => /tool\.example\/source-/u.test(candidate.url)));
  assert.equal(Object.keys(result).includes("fetchCandidates"), false);

  const fetchCalls = [];
  const fetched = await fetchControlledWebEvidence(result.fetchCandidates, {
    limit: 6,
    fetchPageFn: async (url) => {
      fetchCalls.push(url);
      return {
        title: "受控候选正文",
        url,
        snippet: "受控候选正文摘要",
        body: "受控候选正文已抽取，允许后续业务模型核验。",
      };
    },
  });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.evidence.requested, result.fetchCandidates.length);
  assert.equal(fetched.evidence.fetched, result.fetchCandidates.length);
  assert.deepEqual(fetchCalls, result.fetchCandidates.map((candidate) => candidate.url));
});

test("agentic候选池保留第13条之后的Dianping/Seazen候选，且上限为60条", { concurrency: false }, async () => {
  const capturePath = path.join(testRoot, "long-candidates-capture.json");
  writeFakeCli({ mode: "long-candidates", capturePath });
  process.env.CONTENTCREW_CLAUDE_PATH = fakeCliPath;

  const result = await agenticWebResearch("毛血旺 太原吾悦广场长候选池", {
    maxResults: 12,
    timeoutMs: 2_000,
  });
  assert.equal(result.attempted, true);
  assert.equal(result.candidateReady, true);
  assert.equal(result.evidence.candidateGate.toolResultCandidates, 60);
  assert.equal(result.evidence.candidateGate.observedCandidates, 60);
  assert.equal(result.fetchCandidates.length, 60);
  assert.equal(result.fetchCandidates[12].url, "https://www.dianping.com/shop/after-thirteen-wuyue");
  assert.equal(result.fetchCandidates[13].url, "https://www.seazen.com.cn/project/after-thirteen-wuyue");
  assert.ok(result.fetchCandidates.some(candidate => candidate.url.includes("wikipedia.org")));
  assert.equal(Object.keys(result).includes("fetchCandidates"), false);
  assert.equal(JSON.stringify(result).includes("after-thirteen-wuyue"), false);
});

test("CLI立即失败且结果含沙箱拦截时给出稳定失败面，不回显上游原文", { concurrency: false }, async () => {
  const capturePath = path.join(testRoot, "sandbox-blocked-capture.json");
  writeFakeCli({ mode: "sandbox-blocked", capturePath });
  process.env.CONTENTCREW_CLAUDE_PATH = fakeCliPath;
  await assert.rejects(
    agenticWebResearch("沙箱拦截诊断测试", { timeoutMs: 1_000 }),
    (error) => {
      assert.equal(error.code, "AGENTIC_RESEARCH_FAILED");
      assert.match(error.message, /运行环境拦截了对上游的访问/u);
      assert.equal(error.message.includes("yunwu.ai"), false);
      assert.equal(error.message.includes("allow list"), false);
      return true;
    },
  );
  assert.deepEqual(activeResearchRuntimeDirs(), []);
});

test("CLI非零退出但已有至少5条真实工具候选时继续交给受控抓取", { concurrency: false }, async () => {
  const capturePath = path.join(testRoot, "failure-with-candidates-capture.json");
  writeFakeCli({ mode: "failure-with-candidates", capturePath });
  process.env.CONTENTCREW_CLAUDE_PATH = fakeCliPath;
  const result = await agenticWebResearch("失败但仍有真实候选", {
    timeoutMs: 2_000,
  });
  assert.equal(result.attempted, true);
  assert.equal(result.candidateReady, true);
  assert.equal(result.evidence.timedOut, false);
  assert.equal(result.evidence.harvestedAfterCliError, true);
  assert.equal(result.fetchCandidates.length >= 5, true);
  assert.deepEqual(activeResearchRuntimeDirs(), []);
});

test("超时但已有至少5条真实工具候选时继续交给受控抓取，不整次作废", { concurrency: false }, async () => {
  const capturePath = path.join(testRoot, "timeout-with-candidates-capture.json");
  writeFakeCli({ mode: "timeout-with-candidates", capturePath });
  process.env.CONTENTCREW_CLAUDE_PATH = fakeCliPath;
  const result = await agenticWebResearch("超时但仍有真实候选", {
    timeoutMs: 400,
  });
  assert.equal(result.attempted, true);
  assert.equal(result.candidateReady, true);
  assert.equal(result.evidence.timedOut, true);
  assert.equal(result.evidence.harvestedAfterTimeout, true);
  assert.equal(result.fetchCandidates.length >= 5, true);
  assert.deepEqual(activeResearchRuntimeDirs(), []);
});

test("agentic web research timeout and CLI failure clean their exact runtime directories", { concurrency: false }, async () => {
  for (const mode of ["timeout", "failure"]) {
    const capturePath = path.join(testRoot, `${mode}-capture.json`);
    writeFakeCli({ mode, capturePath });
    process.env.CONTENTCREW_CLAUDE_PATH = fakeCliPath;
    assert.deepEqual(activeResearchRuntimeDirs(), []);
    await assert.rejects(
      agenticWebResearch("隔离失败清理测试", {
        // 运行目录已被限制在本测试独占的 TMPDIR；无需依赖子进程先写
        // capture 文件，避免高并发下 CLI 尚未启动便超时的时序竞态。
        timeoutMs: mode === "timeout" ? 180 : 1_000,
      }),
      (error) => {
        assert.equal(
          error.code,
          mode === "timeout" ? "AGENTIC_RESEARCH_TIMEOUT" : "AGENTIC_RESEARCH_FAILED",
        );
        return true;
      },
    );
    assert.deepEqual(activeResearchRuntimeDirs(), [], `${mode} runtime root must be removed`);
  }
});

test("Cursor沙箱允许名单代理不传给联网CLI，并显式开放云雾网关域名", { concurrency: false }, async () => {
  const capturePath = path.join(testRoot, "sandbox-proxy-capture.json");
  writeFakeCli({ capturePath });
  process.env.CONTENTCREW_CLAUDE_PATH = fakeCliPath;
  process.env.CURSOR_AGENT = "1";
  process.env.HTTPS_PROXY = "http://127.0.0.1:39999";
  process.env.HTTP_PROXY = "http://127.0.0.1:39999";
  process.env.NO_PROXY = "localhost,127.0.0.1,github.com,registry.npmjs.org";
  try {
    await agenticWebResearch("开放云雾网关", { timeoutMs: 2_000 });
  } finally {
    restoreEnv();
    process.env.CONTENTCREW_CLAUDE_PATH = fakeCliPath;
    process.env.NANOWORK_DB = dbPath;
    process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
    process.env.YUNWU_API_KEY = "qa-agentic-key";
    process.env.NANOWORK_RESEARCH_MODEL = "claude-qa-websearch";
    process.env.TMPDIR = testRoot;
  }
  const capture = readCapture(capturePath);
  assert.equal(capture.env.HTTPS_PROXY, null);
  assert.equal(capture.env.HTTP_PROXY, null);
  assert.equal(capture.env.NO_PROXY, null);
  assert.equal(capture.settings.sandbox.network.allowedDomains.includes("yunwu.ai"), true);
  assert.equal(capture.settings.sandbox.network.allowedDomains.includes("*.yunwu.ai"), true);
});

test("真实上游代理仍会传给联网CLI，不被误判成沙箱允许名单", { concurrency: false }, async () => {
  const capturePath = path.join(testRoot, "corporate-proxy-capture.json");
  writeFakeCli({ capturePath });
  process.env.CONTENTCREW_CLAUDE_PATH = fakeCliPath;
  delete process.env.CURSOR_AGENT;
  delete process.env.CURSOR_SANDBOX;
  delete process.env.__CURSOR_SANDBOX_ENV_RESTORE;
  process.env.HTTPS_PROXY = "http://proxy.example:8080";
  try {
    await agenticWebResearch("保留企业代理", { timeoutMs: 2_000 });
  } finally {
    restoreEnv();
    process.env.CONTENTCREW_CLAUDE_PATH = fakeCliPath;
    process.env.NANOWORK_DB = dbPath;
    process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
    process.env.YUNWU_API_KEY = "qa-agentic-key";
    process.env.NANOWORK_RESEARCH_MODEL = "claude-qa-websearch";
    process.env.TMPDIR = testRoot;
  }
  const capture = readCapture(capturePath);
  assert.equal(capture.env.HTTPS_PROXY, "http://proxy.example:8080");
  assert.equal(capture.settings.sandbox.network.allowedDomains.includes("yunwu.ai"), true);
});

test("agentic web research fails closed when credential is unavailable", { concurrency: false }, async () => {
  process.env.CONTENTCREW_CLAUDE_PATH = fakeCliPath;
  const savedKey = process.env.YUNWU_API_KEY;
  delete process.env.YUNWU_API_KEY;
  const noCredential = await agenticWebResearch("没有凭据", { timeoutMs: 50 });
  assert.equal(noCredential.attempted, false);
  assert.equal(noCredential.ok, false);
  assert.equal(noCredential.evidence.externalCall, false);
  process.env.YUNWU_API_KEY = savedKey;
});

after(() => {
  restoreEnv();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

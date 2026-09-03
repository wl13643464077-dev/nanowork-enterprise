import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), `nanowork-admin-web-search-${process.pid}-`),
);
const dbPath = path.join(testRoot, 'admin-web-search.db');
const fakeClaudePath = path.join(testRoot, 'fake-claude.mjs');
const claudeCapturePath = path.join(testRoot, 'claude-invocations.log');
const nativeFetch = globalThis.fetch;
const originalEnv = {
  NANOWORK_DB: process.env.NANOWORK_DB,
  ENABLE_SCHEDULER: process.env.ENABLE_SCHEDULER,
  TINYFISH_API_KEY: process.env.TINYFISH_API_KEY,
  YUNWU_API_KEY: process.env.YUNWU_API_KEY,
  CONTENTCREW_CLAUDE_PATH: process.env.CONTENTCREW_CLAUDE_PATH,
  TMPDIR: process.env.TMPDIR,
};

process.env.NANOWORK_DB = dbPath;
process.env.ENABLE_SCHEDULER = 'false';
process.env.TINYFISH_API_KEY = 'unit-test-token-tinyfish-admin-route-must-never-leak';
process.env.YUNWU_API_KEY = 'sk-claude-admin-route-must-never-leak';
process.env.CONTENTCREW_CLAUDE_PATH = fakeClaudePath;
process.env.TMPDIR = testRoot;

const claudeUrls = [
  'https://regulator.example/food-safety-1',
  'https://restaurant.example/food-safety-2',
  'https://standards.example/food-safety-3',
  'https://operator.example/food-safety-4',
  'https://inspection.example/food-safety-5',
];

const fakeClaudeSource = `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(claudeCapturePath)}, "called\\n");
const urls = ${JSON.stringify(claudeUrls)};
const queries = [
  "市场监管总局 餐饮规范",
  "餐饮服务 食品安全",
  "餐饮操作规范 官方",
  "餐饮食品安全 核验",
  "餐饮监管 公开信息",
];
for (let index = 0; index < queries.length; index += 1) {
  const id = "admin-route-search-" + (index + 1);
  process.stdout.write(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "WebSearch", input: { query: queries[index] } }] },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "user",
    message: { content: [{
      type: "tool_result",
      tool_use_id: id,
      is_error: false,
      content: "WebSearch result URL: " + urls[index],
    }] },
  }) + "\\n");
}
process.stdout.write(JSON.stringify({
  type: "result",
  is_error: false,
  result: JSON.stringify({ queries, sources: [], facts: [], gaps: [] }),
  usage: { input_tokens: 1, output_tokens: 1 },
  total_cost_usd: 0,
}));
`;
fs.writeFileSync(fakeClaudePath, fakeClaudeSource, { mode: 0o700 });

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const adminModule = await import('../src/routes/admin.js');
const adminRoutes = adminModule.default;
const { evaluateAdminWebSearchResult } = adminModule;
const {
  clearRuntimeReadinessChecks,
} = await import('../src/engines/runtime-readiness.js');
const { clearTinyfishRuntimeState } = await import('../src/engines/tinyfish.js');

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits)
  VALUES(1,'联网路由测试企业','已开通',10000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status`);
const bossId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('admin-web-search-boss','unused','联网验收老板','boss','启用',1)`).lastInsertRowid);
const boss = q.get('SELECT id,name,username,role,tenant_id FROM users WHERE id=?', bossId);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(1, () => {
    req.user = { ...boss, ip: '127.0.0.1' };
    next();
  }));
  app.use('/admin', adminRoutes);
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0, '127.0.0.1');
  const port = await new Promise(resolve => {
    server.once('listening', () => resolve(server.address().port));
  });
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function invokeRoute() {
  return withServer(async base => {
    const response = await nativeFetch(`${base}/admin/web-search/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return {
      status: response.status,
      json: await response.json(),
    };
  });
}

async function invokeRoutePair() {
  return withServer(async base => Promise.all([1, 2].map(async () => {
    const response = await nativeFetch(`${base}/admin/web-search/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return {
      status: response.status,
      json: await response.json(),
    };
  })));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function directSearchCandidates() {
  return Array.from({ length: 8 }, (_unused, index) => ({
    title: `餐饮食品安全公开材料${index + 1}`,
    url: `https://tinyfish-${index + 1}.example/official-material`,
    snippet: `市场监管总局餐饮服务食品安全操作规范公开摘要${index + 1}`,
  }));
}

function bodyFor(index, { sufficient }) {
  if (!sufficient) {
    return '餐饮食品安全公开信息短材料。'.repeat(7);
  }
  return [
    `第${index + 1}份市场监管总局餐饮服务食品安全操作规范官方公开信息。`,
    '材料涵盖进货查验、人员健康、加工制作、交叉污染防控、温度控制和清洁消毒。'.repeat(6),
    `本页独立核验编号为${index + 1}，用于证明正文来自不同公开材料。`,
  ].join('');
}

function tinyfishStub({ searchResults, sufficientBodies }) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const suppliedKey = init.headers?.['X-API-Key'];
    assert.equal(suppliedKey, process.env.TINYFISH_API_KEY);
    if (url.hostname === 'api.search.tinyfish.ai') {
      return jsonResponse({
        query: url.searchParams.get('query'),
        results: searchResults,
        total_results: searchResults.length,
        page: 1,
      });
    }
    if (url.hostname === 'api.fetch.tinyfish.ai') {
      const payload = JSON.parse(String(init.body || '{}'));
      const urls = Array.isArray(payload.urls) ? payload.urls : [];
      return jsonResponse({
        results: urls.map((requestedUrl, index) => ({
          url: requestedUrl,
          final_url: requestedUrl,
          title: `受控餐饮公开正文${index + 1}`,
          text: `${bodyFor(index, { sufficient: sufficientBodies })} URL_BODY_SENTINEL_MUST_NOT_LEAK`,
        })),
        errors: [],
      });
    }
    throw new Error(`unexpected offline fetch target: ${url.hostname}`);
  };
}

function assertNoSensitiveMaterial(payload, candidateUrls) {
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /URL_BODY_SENTINEL_MUST_NOT_LEAK/u);
  assert.doesNotMatch(serialized, /admin-route-must-never-leak/u);
  assert.doesNotMatch(serialized, /(?:tinyfish|claude)-admin-route-must-never-leak/u);
  for (const url of candidateUrls) assert.equal(serialized.includes(url), false);
}

beforeEach(() => {
  clearRuntimeReadinessChecks();
  clearTinyfishRuntimeState();
  fs.rmSync(claudeCapturePath, { force: true });
  globalThis.fetch = nativeFetch;
});

test('TinyFish 路由即使自报成功，正文质量门未通过也不得直达验收', { concurrency: false }, async () => {
  let controlledCalls = 0;
  const candidates = directSearchCandidates();
  const result = await evaluateAdminWebSearchResult({
    ok: true,
    candidateReady: true,
    provider: 'TinyFish Search + Fetch',
    results: candidates,
    evidence: {
      providerRoute: ['tinyfish'],
      tinyfish: {
        fetchedPageCount: 8,
        qualityGate: { passed: false },
      },
    },
  }, {
    controlledFetchFn: async () => {
      controlledCalls += 1;
      return { results: [] };
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.providerRoute, ['tinyfish']);
  assert.equal(result.materialQualityPassed, false);
  assert.equal(controlledCalls, 0, 'TinyFish 直达失败不能误走 Claude 正文判定分支');
});

test('旧 schema Claude 结果没有 providerRoute 时仍须受控抓取并过正文门', { concurrency: false }, async () => {
  let controlledCalls = 0;
  const candidates = claudeUrls.map((url, index) => ({
    title: `旧版 Claude 候选${index + 1}`,
    url,
    snippet: '餐饮食品安全公开信息',
  }));
  const result = await evaluateAdminWebSearchResult({
    ok: true,
    candidateReady: true,
    results: candidates,
    evidence: {
      schemaVersion: 'nanowork.agentic-web-research/1',
    },
  }, {
    controlledFetchFn: async received => {
      controlledCalls += 1;
      assert.equal(received.length, 5);
      return {
        results: candidates.map((candidate, index) => ({
          ...candidate,
          body: bodyFor(index, { sufficient: true }),
        })),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.providerRoute, ['claude_websearch']);
  assert.equal(result.providerId, 'claude_websearch');
  assert.equal(result.fallbackTriggered, true);
  assert.equal(result.materialQualityPassed, true);
  assert.equal(controlledCalls, 1);
});

test('任何含 Claude 的路径都不能依赖 fallback 标志绕过受控正文门', { concurrency: false }, async () => {
  let controlledCalls = 0;
  const candidates = claudeUrls.map((url, index) => ({
    title: `混合路径候选${index + 1}`,
    url,
    snippet: '餐饮食品安全公开信息',
  }));
  const result = await evaluateAdminWebSearchResult({
    ok: true,
    candidateReady: true,
    provider: 'TinyFish Search + Fetch',
    results: candidates,
    evidence: {
      providerRoute: ['tinyfish', 'claude_websearch'],
      fallback: { triggered: false },
      tinyfish: { qualityGate: { passed: true } },
    },
  }, {
    controlledFetchFn: async () => {
      controlledCalls += 1;
      return {
        results: candidates.map((candidate, index) => ({
          ...candidate,
          body: bodyFor(index, { sufficient: false }),
        })),
      };
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.providerRoute, ['tinyfish', 'claude_websearch']);
  assert.equal(result.fallbackTriggered, true);
  assert.equal(result.materialQualityPassed, false);
  assert.equal(controlledCalls, 1);
});

test('TinyFish 直达只有 Search+Fetch 正文质量门通过才记录 passed', { concurrency: false }, async () => {
  const candidates = directSearchCandidates();
  globalThis.fetch = tinyfishStub({
    searchResults: candidates,
    sufficientBodies: true,
  });

  const result = await invokeRoute();

  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.provider, 'TinyFish Search + Fetch');
  assert.deepEqual(result.json.providerRoute, ['tinyfish']);
  assert.equal(result.json.candidateCount, 8);
  assert.equal(result.json.fallbackTriggered, false);
  assert.equal(result.json.verifiedPageCount, 8);
  assert.equal(result.json.readiness.verification, 'passed');
  assert.equal(result.json.readiness.connected, true);
  assert.equal(result.json.readiness.lastCheck.outcome, 'passed');
  assert.equal(result.json.readiness.lastCheck.evidence.materialQualityPassed, true);
  assert.equal(fs.existsSync(claudeCapturePath), false, 'TinyFish 正文门通过后不应调用付费回退');
  assertNoSensitiveMaterial(result.json, candidates.map(item => item.url));
});

test('Claude 回退只有 candidateReady、受控正文不足时不得记录 passed 或 connected', { concurrency: false }, async () => {
  globalThis.fetch = tinyfishStub({
    searchResults: [],
    sufficientBodies: false,
  });

  const result = await invokeRoute();

  assert.equal(result.status, 200);
  assert.equal(result.json.ok, false);
  assert.deepEqual(result.json.providerRoute, ['tinyfish', 'claude_websearch']);
  assert.equal(result.json.candidateCount, 5);
  assert.equal(result.json.fallbackTriggered, true);
  assert.equal(result.json.verifiedPageCount, 5);
  assert.equal(result.json.readiness.verification, 'failed');
  assert.equal(result.json.readiness.verified, false);
  assert.equal(result.json.readiness.connected, false);
  assert.notEqual(result.json.readiness.effective, 'connected');
  assert.equal(result.json.readiness.lastCheck.outcome, 'failed');
  assert.equal(result.json.readiness.lastCheck.evidence.materialQualityPassed, false);
  assert.equal(fs.readFileSync(claudeCapturePath, 'utf8').trim(), 'called');
  assertNoSensitiveMaterial(result.json, claudeUrls);
});

test('Claude 回退候选经受控正文质量门达标后才可记录 passed', { concurrency: false }, async () => {
  globalThis.fetch = tinyfishStub({
    searchResults: [],
    sufficientBodies: true,
  });

  const result = await invokeRoute();

  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.provider, 'Yunwu Claude WebSearch gateway');
  assert.deepEqual(result.json.providerRoute, ['tinyfish', 'claude_websearch']);
  assert.equal(result.json.candidateCount, 5);
  assert.equal(result.json.fallbackTriggered, true);
  assert.equal(result.json.verifiedPageCount, 5);
  assert.equal(result.json.readiness.verification, 'passed');
  assert.equal(result.json.readiness.verified, true);
  assert.equal(result.json.readiness.connected, true);
  assert.equal(result.json.readiness.lastCheck.outcome, 'passed');
  assert.equal(result.json.readiness.lastCheck.evidence.materialQualityPassed, true);
  assert.equal(fs.readFileSync(claudeCapturePath, 'utf8').trim(), 'called');
  assertNoSensitiveMaterial(result.json, claudeUrls);
  assertNoSensitiveMaterial(result.json.readiness.lastCheck.evidence, claudeUrls);
});

test('同一用户并发点击联网验收只触发一次昂贵主备链调用', { concurrency: false }, async () => {
  const candidates = directSearchCandidates();
  const stub = tinyfishStub({
    searchResults: candidates,
    sufficientBodies: true,
  });
  let searchCalls = 0;
  let fetchCalls = 0;
  globalThis.fetch = async (input, init) => {
    const hostname = new URL(String(input)).hostname;
    if (hostname === 'api.search.tinyfish.ai') searchCalls += 1;
    if (hostname === 'api.fetch.tinyfish.ai') fetchCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 30));
    return stub(input, init);
  };

  const results = await invokeRoutePair();

  assert.deepEqual(results.map(item => item.status), [200, 200]);
  assert.deepEqual(results.map(item => item.json.ok), [true, true]);
  assert.equal(searchCalls, 1);
  assert.equal(fetchCalls, 1);
});

after(() => {
  globalThis.fetch = nativeFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(testRoot, { recursive: true, force: true });
});

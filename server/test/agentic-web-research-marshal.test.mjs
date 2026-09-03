import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(
  os.tmpdir(),
  `nanowork-agentic-marshal-${process.pid}.db`,
);
for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}
process.env.NANOWORK_DB = dbPath;
process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

const { initSchema, migrateV2 } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { buildEmployeeExecutionProfile } =
  await import("../src/employee-workbench.js");
const { buildRestaurantOutputDeliverableFixture } =
  await import("../src/engines/restaurant-output-contract.js");
const { marshalWork } = await import("../src/engines/ai.js");

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const testMarshal = {
  code: "M-01",
  name: "市场与选址分部",
  title: "内部调度容器",
  duty: "仅负责调度",
  skills: "",
  prompt: "",
  kb_deps: "",
};

function clone(value) {
  return structuredClone(value);
}

function employeeExecution(idx) {
  return buildEmployeeExecutionProfile(idx, {
    tenantId: 1,
    user: { id: 1, role: "boss", tenant_id: 1 },
  });
}

function taskFor(idx) {
  return {
    title: idx === 102 ? "毛血旺 太原吾悦广场竞品" : "毛血旺 太原吾悦广场",
    type: "分析",
    requirement:
      "核验公开位置与周边餐饮供给，形成可追溯的内部证据包；不执行任何外部动作。",
  };
}

function directRestaurantSource(idx) {
  return {
    title: `大众点评·毛血旺 太原吾悦广场门店${idx}`,
    url: `https://www.dianping.com/shop/maoxuewang-wuyue-${idx}`,
    snippet: `毛血旺 太原吾悦广场餐厅菜单、菜品、价格、营业状态、评价与外卖信息公开页面。`,
  };
}

function locationSource(idx) {
  return {
    title: `OpenStreetMap定位·太原吾悦广场${idx}`,
    url: `https://www.openstreetmap.org/way/${7000 + Number(idx)}`,
    snippet: `OpenStreetMap真实路网与吾悦广场周边餐饮POI位置证据-${idx}`,
  };
}

function pointExecutionEvidenceAtSource(fixture, source) {
  for (const item of Object.values(fixture.input_audit || {})) {
    item.evidence_refs = [source];
  }
  for (const item of Object.values(fixture.method_execution || {})) {
    item.evidence_refs = [source];
  }
}

function validGenerate(idx, execution, task, generationCalls) {
  const fixture = clone(
    buildRestaurantOutputDeliverableFixture(idx, {
      title: task.title,
      type: task.type,
      requirement: task.requirement,
    }),
  );
  fixture.decision_context.problem = `${task.title}：${fixture.decision_context.problem}`;
  // 完整联网链路启用来源白名单；模拟模型必须逐字回指本轮正文核验来源。
  const direct = directRestaurantSource(idx);
  fixture.decision_context.sources[0].source = `${direct.title}｜${direct.url}`;
  pointExecutionEvidenceAtSource(
    fixture,
    fixture.decision_context.sources[0].source,
  );
  return async (args) => {
    generationCalls.push({ idx, args });
    return {
      text: JSON.stringify(fixture),
      mode: "api",
      model: "agentic-marshal-test-model",
      usage: { inputTokens: 17, outputTokens: 31 },
    };
  };
}

function agenticEvidence(idx) {
  const results = Array.from({ length: 5 }, (_unused, offset) => ({
    title: `太原吾悦广场毛血旺餐厅竞品公开页面${idx}-${offset + 1}`,
    url: `https://agentic.test/${idx}/${offset + 1}`,
    snippet: `太原吾悦广场毛血旺餐厅菜单、价格、营业状态、评价与竞品公开证据-${idx}-${offset + 1}`,
    publishedAt: "2026-08-08",
  }));
  return {
    attempted: true,
    ok: true,
    provider: "isolated-agentic-claude",
    results,
    evidence: {
      schemaVersion: "nanowork.agentic-web-research/1",
      executionMode: "isolated_claude_cli",
      toolCalls: 5,
      toolAttempts: 5,
      toolResults: results.map((_result, offset) => ({
        toolUseId: `web-search-${idx}-${offset + 1}`,
        success: true,
        isError: false,
        permissionDenied: false,
        urlCount: 1,
      })),
      qualityGate: {
        requiredSearches: 5,
        requiredSources: 5,
        observedSearches: 5,
        observedSuccessfulToolResults: 5,
        observedToolResultUrls: 5,
        observedSources: 5,
        passed: true,
      },
      queries: Array.from(
        { length: 5 },
        (_unused, offset) => `agentic-query-${idx}-${offset + 1}`,
      ),
      facts: [{ claim: `agentic-fact-${idx}`, sourceUrls: [results[0].url] }],
      gaps: [],
      usage: { inputTokens: 101, outputTokens: 202, cacheReadInputTokens: 3 },
      costUsd: 0.17,
      externalCall: true,
      localLoginInherited: false,
    },
  };
}

function candidateAgenticEvidence(idx) {
  const exactResult = {
    title: `Agentic精确结果${idx}`,
    url: `https://agentic.test/${idx}/exact`,
    snippet: `tool_result URL-${idx}`,
  };
  const unverifiedCandidates = Array.from({ length: 5 }, (_unused, offset) => ({
    title: `Agentic候选待核验${idx}-${offset + 1}`,
    url: `https://forged.example/${idx}/candidate-${offset + 1}`,
    snippet: `候选网页-${idx}-${offset + 1}`,
  }));
  const response = {
    attempted: true,
    ok: true,
    candidateReady: true,
    provider: "isolated-agentic-claude",
    results: [exactResult],
    evidence: {
      schemaVersion: "nanowork.agentic-web-research/1",
      executionMode: "isolated_claude_cli",
      toolCalls: 5,
      toolAttempts: 5,
      toolResults: Array.from({ length: 5 }, (_unused, offset) => ({
        toolUseId: `candidate-web-search-${idx}-${offset + 1}`,
        success: true,
        isError: false,
        permissionDenied: false,
        urlCount: 1,
      })),
      qualityGate: {
        requiredSearches: 5,
        requiredSources: 5,
        observedSearches: 5,
        observedSuccessfulToolResults: 5,
        observedToolResultUrls: 5,
        observedSources: 1,
        passed: true,
      },
      candidateGate: {
        requiredSearches: 5,
        requiredSuccessfulToolResults: 5,
        requiredToolResultUrls: 5,
        requiredCandidates: 5,
        observedSearches: 5,
        observedSuccessfulToolResults: 5,
        observedToolResultUrls: 5,
        observedCandidates: 5,
        passed: true,
        requiresControlledWebFetch: true,
      },
      queries: Array.from(
        { length: 5 },
        (_unused, offset) => `candidate-query-${idx}-${offset + 1}`,
      ),
      facts: [
        { claim: `agentic精确事实-${idx}`, sourceUrls: [exactResult.url] },
      ],
      gaps: [],
      usage: { inputTokens: 101, outputTokens: 202, cacheReadInputTokens: 3 },
      costUsd: 0.17,
      externalCall: true,
      localLoginInherited: false,
    },
  };
  // 受控抓取前的候选刻意不可枚举，模拟生产 agentic 返回的同栈句柄。
  Object.defineProperty(response, "fetchCandidates", {
    value: unverifiedCandidates,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return response;
}

test(
  "required餐饮岗位把agentic、通用web和101/102地图证据同时送入模型与执行快照",
  { concurrency: false },
  async () => {
    const agenticCalls = [];
    const genericCalls = [];
    const mapCalls = [];
    const controlledCalls = [];
    const generationCalls = [];

    for (const idx of [101, 102, 103]) {
      const execution = employeeExecution(idx);
      const task = taskFor(idx);
      const output = await marshalWork(testMarshal, task, "boss", {
        employeeExecution: execution,
        signal: new AbortController().signal,
        agenticWebResearchFn: async (query, options = {}) => {
          agenticCalls.push({ idx, query, options });
          return agenticEvidence(idx);
        },
        requireAgenticResearch: true,
        controlledWebFetchFn: async (sources, options = {}) => {
          controlledCalls.push({ idx, sources, options });
          const direct = directRestaurantSource(idx);
          return {
            attempted: true,
            ok: true,
            provider: "mock-controlled-web-evidence",
            results: [
              {
                ...direct,
                body: `受控网页正文完整段落-${idx}：太原吾悦广场毛血旺餐厅菜单、菜品、价格、营业状态、评价、外卖与竞品公开正文已抽取，供隔离岗位按核验日逐项复核；未知字段保留补证动作，不构成外部执行授权。`,
              },
              ...sources.map((source) => ({
                ...source,
                body: `受控网页正文补充段落-${idx}：${source.title}对应的公开页面正文已抽取并净化，作为本轮隔离证据保留；未知字段按核验日复核。`,
              })),
            ],
            evidence: {
              schemaVersion: "nanowork.controlled-web-evidence/1",
              requested: sources.length,
              fetched: sources.length + 1,
              failures: [],
              externalCall: true,
              ssrfProtected: true,
              redirectsRevalidated: true,
              responseBytesStored: false,
            },
          };
        },
        webSearchFn: async (query, options = {}) => {
          genericCalls.push({ idx, query, options });
          return {
            attempted: true,
            ok: true,
            provider: "generic-web-search",
            results: [
              {
                title: `毛血旺 太原吾悦广场公开商户补充${idx}`,
                url: `https://generic.test/${idx}`,
                snippet: `太原吾悦广场毛血旺餐厅菜单、价格、营业状态、评价与外卖公开商户补充-${idx}`,
              },
              {
                title: `毛血旺 太原吾悦广场公开商户补充重复${idx}`,
                url: `https://generic.test/${idx}`,
                snippet: `太原吾悦广场毛血旺餐厅重复公开商户补充-${idx}`,
              },
            ],
            evidence: { externalCall: true, query },
          };
        },
        locationIntelligenceFn: async (query, options = {}) => {
          mapCalls.push({ idx, query, options });
          return {
            attempted: true,
            ok: true,
            provider: "mock-map-intelligence",
            results: [
              {
                ...locationSource(idx),
              },
            ],
            evidence: {
              externalCall: true,
              query,
              center: { lat: 37.81, lon: 112.55 },
            },
          };
        },
        generateFn: validGenerate(idx, execution, task, generationCalls),
      });

      assert.equal(
        output.employeeContract.valid,
        true,
        `员工${idx}契约必须通过`,
      );
      assert.equal(output.web.attempted, true);
      assert.equal(output.web.ok, true);
      const serializedWeb = JSON.stringify(output.web);
      assert.match(
        serializedWeb,
        new RegExp(`https://agentic\\.test/${idx}`, "u"),
      );
      assert.match(
        serializedWeb,
        new RegExp(`https://generic\\.test/${idx}`, "u"),
      );
      if ([101, 102].includes(idx)) {
        assert.match(
          serializedWeb,
          /https:\/\/www\.openstreetmap\.org\/way\//u,
        );
      } else {
        assert.doesNotMatch(
          serializedWeb,
          /https:\/\/www\.openstreetmap\.org\/way\//u,
        );
      }

      const generation = generationCalls.at(-1);
      assert.deepEqual(
        output.web.channels.map((channel) => channel.kind),
        [
          "controlled_web_fetch",
          "agentic_web_research",
          "web_search",
          ...([101, 102].includes(idx) ? ["location_intelligence"] : []),
        ],
        `员工${idx}的联网通道必须先正文核验，再调研、通用搜索和地图`,
      );
      assert.equal(output.web.channels[0].ok, true);
      assert.equal(
        output.web.channels[0].evidence.fetched,
        output.web.channels[0].evidence.requested + 1,
      );
      assert.equal(output.web.channels[1].evidence.qualityGate.passed, true);
      assert.equal(output.web.channels[1].evidence.toolAttempts, 5);
      assert.equal(output.web.channels[1].evidence.toolCalls, 5);
      assert.equal(output.web.channels[1].evidence.toolResults.length, 5);
      assert.match(
        generation.args.userMsg,
        new RegExp(`https://agentic\\.test/${idx}`, "u"),
      );
      assert.match(
        generation.args.userMsg,
        new RegExp(`https://generic\\.test/${idx}`, "u"),
      );
      assert.match(
        generation.args.userMsg,
        new RegExp(`受控网页正文完整段落-${idx}`, "u"),
        `员工${idx}的受控网页正文必须进入最终模型prompt`,
      );
      if ([101, 102].includes(idx)) {
        assert.match(
          generation.args.userMsg,
          /https:\/\/www\.openstreetmap\.org\/way\//u,
        );
      }
      const enabledSkill = execution.workbench.skillLibrary.enabled[0]?.title;
      assert.ok(enabledSkill, `员工${idx}必须有启用技能`);
      assert.match(
        generation.args.system,
        new RegExp(enabledSkill.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
        `员工${idx}的skillsBlock必须真正进入最终模型system消息`,
      );
    }

    assert.deepEqual(
      agenticCalls.map((call) => call.idx),
      [101, 102, 103],
    );
    assert.ok(
      genericCalls.every((call) => call.options.fallbackOrder === "web_first"),
    );
    const locationGenericCalls = genericCalls.filter((call) =>
      [101, 102].includes(call.idx),
    );
    assert.ok(
      locationGenericCalls.filter((call) => call.idx === 101).length >= 4,
      "101必须并发执行它自己的技能取证计划",
    );
    assert.ok(
      locationGenericCalls.filter((call) => call.idx === 102).length >= 5,
      "102必须并发执行高德/点评/美团/窄门/等时圈取证计划",
    );
    assert.equal(
      genericCalls.filter((call) => call.idx === 103).length,
      1,
      "非地点岗位保持原有通用检索辅助链",
    );
    assert.ok(
      locationGenericCalls.every((call) => call.query.length <= 120),
      "通用检索query必须保持短，避免HTTP 414",
    );
    assert.ok(
      locationGenericCalls.some((call) =>
        /官方\s+商场\s+餐饮\s+品牌\s+门店列表/u.test(call.query),
      ),
    );
    assert.ok(
      locationGenericCalls.some(
        (call) => call.idx === 102 && /site:dianping\.com/u.test(call.query),
      ),
    );
    assert.ok(
      locationGenericCalls.some(
        (call) => call.idx === 102 && /site:meituan\.com/u.test(call.query),
      ),
    );
    assert.ok(
      locationGenericCalls.some(
        (call) => call.idx === 102 && /site:canyandata\.com/u.test(call.query),
      ),
    );
    assert.ok(
      locationGenericCalls.some(
        (call) => call.idx === 102 && /高德地图\s+扫街榜/u.test(call.query),
      ),
    );
    assert.deepEqual(
      mapCalls.map((call) => call.idx),
      [101, 102],
    );
    assert.deepEqual(
      controlledCalls.map((call) => call.idx),
      [101, 102, 103],
    );
    assert.ok(controlledCalls.every((call) => call.options.limit === 8));
    assert.ok(controlledCalls.every((call) => call.sources.length <= 8));
    for (const call of controlledCalls) {
      const urls = call.sources.map((source) => source.url);
      assert.equal(new Set(urls).size, urls.length, "controlled候选必须去重");
      assert.match(
        urls[0],
        /generic\.test\//u,
        "generic结果必须先于agentic候选",
      );
      assert.deepEqual(urls.slice(0, 6), [
        `https://generic.test/${call.idx}`,
        ...Array.from(
          { length: 5 },
          (_unused, offset) => `https://agentic.test/${call.idx}/${offset + 1}`,
        ),
      ]);
    }
    assert.ok(
      agenticCalls.every(
        (call) => call.options && call.options.signal !== undefined,
      ),
    );
  },
);

test(
  "未核验候选只交给controlled WebFetch，成功正文和最终URL进入prompt与allowedSources",
  { concurrency: false },
  async () => {
    const idx = 103;
    const execution = employeeExecution(idx);
    const task = taskFor(idx);
    const generationCalls = [];
    const controlledCalls = [];
    const fixture = clone(
      buildRestaurantOutputDeliverableFixture(idx, {
        title: task.title,
        type: task.type,
        requirement: task.requirement,
      }),
    );
    fixture.decision_context.problem = `${task.title}：${fixture.decision_context.problem}`;
    fixture.decision_context.sources[0].source =
      "受控最终来源103｜https://controlled.test/103";
    pointExecutionEvidenceAtSource(
      fixture,
      fixture.decision_context.sources[0].source,
    );

    const output = await marshalWork(testMarshal, task, "boss", {
      employeeExecution: execution,
      signal: new AbortController().signal,
      requireAgenticResearch: true,
      agenticWebResearchFn: async () => candidateAgenticEvidence(idx),
      controlledWebFetchFn: async (sources, options = {}) => {
        controlledCalls.push({ sources, options });
        return {
          attempted: true,
          ok: true,
          provider: "mock-controlled-web-evidence",
          results: [
            {
              title: "受控最终来源103",
              url: "https://controlled.test/103",
              snippet: "受控网页摘要103",
              body: "受控网页正文103：候选URL已通过正文核验，可供本轮内部任务引用。",
            },
          ],
          evidence: {
            schemaVersion: "nanowork.controlled-web-evidence/1",
            requested: sources.length,
            fetched: 1,
            failures: [],
            externalCall: true,
            ssrfProtected: true,
            redirectsRevalidated: true,
            responseBytesStored: false,
          },
        };
      },
      webSearchFn: async () => ({
        attempted: true,
        ok: true,
        provider: "generic-web-search",
        results: [
          {
            title: "通用来源103",
            url: "https://generic.test/103",
            snippet: "通用公开来源103",
          },
        ],
      }),
      generateFn: async (args) => {
        generationCalls.push(args);
        return {
          text: JSON.stringify(fixture),
          mode: "api",
          model: "candidate-marshal-test-model",
          usage: { inputTokens: 19, outputTokens: 29 },
        };
      },
    });

    assert.equal(output.employeeContract.valid, true);
    assert.equal(generationCalls.length, 1);
    assert.equal(controlledCalls.length, 1);
    assert.ok(controlledCalls[0].sources.length >= 6);
    assert.ok(controlledCalls[0].sources.length <= 8);
    assert.match(controlledCalls[0].sources[0].url, /generic\.test\/103/u);
    assert.ok(
      controlledCalls[0].sources
        .slice(1)
        .every((source) => /forged\.example/u.test(source.url)),
    );
    assert.ok(controlledCalls[0].options.signal);
    assert.equal(output.web.channels[1].candidateReady, true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        output.web.channels[1],
        "fetchCandidates",
      ),
      false,
    );
    const serializedWeb = JSON.stringify(output.web);
    assert.doesNotMatch(
      serializedWeb,
      /forged\.example/u,
      "未核验候选不得进入最终web快照",
    );
    assert.match(serializedWeb, /https:\/\/controlled\.test\/103/u);
    assert.match(
      generationCalls[0].userMsg,
      /https:\/\/controlled\.test\/103/u,
    );
    assert.match(generationCalls[0].userMsg, /受控网页正文103/u);
    assert.equal(
      output.employeeContract.parsed.decision_context.sources[0].source,
      "受控最终来源103｜https://controlled.test/103",
    );
  },
);

test(
  "agentic失败仍完整保留证据，required岗位不得模板化成成功",
  { concurrency: false },
  async () => {
    const execution = employeeExecution(101);
    const task = taskFor(101);
    const failureEvidence = agenticEvidence(101);
    failureEvidence.ok = false;
    failureEvidence.note = "agentic Claude WebSearch timeout";
    failureEvidence.evidence.error = {
      code: "AGENTIC_RESEARCH_TIMEOUT",
      phase: "tool_use",
    };
    let publicResearchFailure;
    let generateCalled = false;
    try {
      await marshalWork(testMarshal, task, "boss", {
        employeeExecution: execution,
        requireAgenticResearch: true,
        agenticWebResearchFn: async () => failureEvidence,
        webSearchFn: async () => ({
          attempted: true,
          ok: false,
          provider: "generic-web-search",
          results: [],
          note: "generic unavailable",
        }),
        locationIntelligenceFn: async () => ({
          attempted: true,
          ok: true,
          provider: "mock-map-intelligence",
          results: [
            {
              title: "地图兜底来源",
              ...locationSource(101),
            },
          ],
          evidence: { externalCall: true },
        }),
        generateFn: async () => {
          generateCalled = true;
          return {
            text: '{"contract_id":"must-not-run"}',
            mode: "api",
            model: "agentic-marshal-test-model",
            usage: { inputTokens: 11, outputTokens: 7 },
          };
        },
      });
    } catch (error) {
      publicResearchFailure = error;
    }
    assert.ok(publicResearchFailure, "agentic公开调研失败必须收敛为失败");
    assert.equal(
      publicResearchFailure.code,
      "EMPLOYEE_PUBLIC_RESEARCH_INCOMPLETE",
    );
    assert.equal(generateCalled, false, "公开调研失败不得调用模型底稿兜底");
    assert.doesNotMatch(
      JSON.stringify(publicResearchFailure.web),
      /agentic\.test\/101/u,
      "未通过controlled正文的agentic URL不得进入失败快照",
    );
    assert.ok(
      publicResearchFailure.web.sourceQuality.rejected.some(
        (item) =>
          item.host === "agentic.test" &&
          item.reason === "not_controlled_page_evidence",
      ),
    );
    assert.match(
      JSON.stringify(publicResearchFailure.web),
      /AGENTIC_RESEARCH_TIMEOUT/u,
    );
    assert.equal(publicResearchFailure.web.attempted, true);

    const template = await marshalWork(testMarshal, task, "boss", {
      employeeExecution: execution,
      agenticWebResearchFn: async () => failureEvidence,
      webSearchFn: async () => ({
        attempted: true,
        ok: true,
        results: [
          {
            title: "大众点评·毛血旺 太原吾悦广场商户页面",
            url: "https://www.dianping.com/shop/agentic-failure-101",
            snippet:
              "太原吾悦广场毛血旺餐厅菜单、价格、营业状态与评价公开商户正文。",
          },
        ],
        note: "offline",
      }),
      controlledWebFetchFn: async () => ({
        attempted: true,
        ok: true,
        provider: "mock-controlled-web-evidence",
        results: [
          {
            title: "大众点评·毛血旺 太原吾悦广场商户页面",
            url: "https://www.dianping.com/shop/agentic-failure-101",
            snippet:
              "太原吾悦广场毛血旺餐厅菜单、价格、营业状态与评价公开商户正文。",
            body: "受控网页正文：太原吾悦广场毛血旺餐厅菜单、菜品、价格、营业状态、评价与竞品商户正文可回看；本段仅作隔离链路验收，未知字段保留复核动作，不构成外部执行授权，也不代表真实市场结论。",
          },
        ],
        evidence: {
          schemaVersion: "nanowork.controlled-web-evidence/1",
          requested: 1,
          fetched: 1,
          failures: [],
          externalCall: true,
          ssrfProtected: true,
          redirectsRevalidated: true,
          responseBytesStored: false,
        },
      }),
      locationIntelligenceFn: async () => ({
        attempted: true,
        ok: true,
        provider: "mock-map-intelligence",
        results: [locationSource(101)],
      }),
      generateFn: async (args) => ({
        text: args.fallback(),
        mode: "template",
        model: "template",
        usage: { inputTokens: 0, outputTokens: 0 },
        providerFailure: { code: "provider_unavailable", retryable: false },
      }),
    });
    assert.equal(template.mode, "template");
    assert.equal(template.transparentFallback, true);
    assert.equal(template.employeeContract.valid, false);
    assert.equal(template.employeeContract.skipped, "template_mode");
    assert.match(JSON.stringify(template.web), /AGENTIC_RESEARCH_TIMEOUT/u);
  },
);

test(
  "分层候选受控正文全失败后才启动旧检索灾备，并用新候选重新完成正文核验",
  { concurrency: false },
  async () => {
    const idx = 103;
    const execution = employeeExecution(idx);
    const task = taskFor(idx);
    const fallbackSource = {
      title: "餐饮经营公开规范灾备来源103",
      url: "https://legacy-recovery.test/103",
      snippet: "餐饮门店经营与食品安全公开规范，可供本轮任务核验。",
    };
    const fixture = clone(
      buildRestaurantOutputDeliverableFixture(idx, {
        title: task.title,
        type: task.type,
        requirement: task.requirement,
      }),
    );
    fixture.decision_context.problem = `${task.title}：${fixture.decision_context.problem}`;
    fixture.decision_context.sources[0].source =
      `${fallbackSource.title}｜${fallbackSource.url}`;
    pointExecutionEvidenceAtSource(
      fixture,
      fixture.decision_context.sources[0].source,
    );

    let legacyCalls = 0;
    const controlledCalls = [];
    const generationCalls = [];
    const output = await marshalWork(testMarshal, task, "boss", {
      employeeExecution: execution,
      requireAgenticResearch: true,
      parallelInjectedWebSearch: false,
      agenticWebResearchFn: async () => candidateAgenticEvidence(idx),
      webSearchFn: async () => {
        legacyCalls += 1;
        return {
          attempted: true,
          ok: true,
          provider: "legacy-recovery-search",
          results: [fallbackSource],
          evidence: { externalCall: true },
        };
      },
      controlledWebFetchFn: async (sources) => {
        controlledCalls.push(sources);
        if (controlledCalls.length === 1) {
          assert.equal(legacyCalls, 0, "首批候选核验前不得提前启动旧检索");
          return {
            attempted: true,
            ok: false,
            provider: "mock-controlled-web-evidence",
            results: [],
            note: "首批正文均未取得",
            evidence: {
              schemaVersion: "nanowork.controlled-web-evidence/1",
              requested: sources.length,
              fetched: 0,
              failures: [
                { host: "forged.example", code: "CONTROLLED_WEB_FETCH_FAILED" },
              ],
              externalCall: true,
              ssrfProtected: true,
              redirectsRevalidated: true,
            },
          };
        }
        assert.equal(legacyCalls, 1, "首批正文失败后必须只启动一次旧检索灾备");
        assert.equal(sources[0].url, fallbackSource.url);
        return {
          attempted: true,
          ok: true,
          provider: "mock-controlled-web-evidence",
          results: [
            {
              ...fallbackSource,
              body: "受控网页正文灾备103：餐饮门店经营与食品安全公开规范已经读取并净化，包含适用范围、执行责任、复核动作和证据边界；本段仅用于验证首批候选失败后更换来源的灾备闭环，未知事实继续标注待核验。",
            },
          ],
          evidence: {
            schemaVersion: "nanowork.controlled-web-evidence/1",
            requested: sources.length,
            fetched: 1,
            failures: [],
            externalCall: true,
            ssrfProtected: true,
            redirectsRevalidated: true,
          },
        };
      },
      generateFn: async (args) => {
        generationCalls.push(args);
        return {
          text: JSON.stringify(fixture),
          mode: "api",
          model: "legacy-recovery-test-model",
          usage: { inputTokens: 23, outputTokens: 37 },
        };
      },
    });

    assert.equal(legacyCalls, 1);
    assert.equal(controlledCalls.length, 2);
    assert.equal(generationCalls.length, 1);
    assert.equal(output.web.ok, true);
    assert.match(JSON.stringify(output.web), /legacy-recovery\.test\/103/u);
    assert.doesNotMatch(
      JSON.stringify(output.web),
      /https:\/\/forged\.example\/103\/candidate/u,
      "未核验候选完整URL不得进入最终快照；失败审计只保留host与错误码",
    );
    assert.equal(
      output.web.channels.find(
        (channel) => channel.kind === "controlled_web_fetch",
      )?.evidence?.legacyRecoveryTriggered,
      true,
    );
  },
);

test(
  "受控网页正文或101/102地图失败时保留全部web证据且不得调用最终生成",
  { concurrency: false },
  async () => {
    const cases = [
      {
        label: "controlled-web-fetch",
        idx: 103,
        controlledWebFetchFn: async () => ({
          attempted: true,
          ok: false,
          provider: "mock-controlled-web-evidence",
          results: [],
          note: "受控正文核验失败",
          evidence: {
            schemaVersion: "nanowork.controlled-web-evidence/1",
            requested: 5,
            fetched: 0,
            failures: [
              { host: "agentic.test", code: "CONTROLLED_WEB_MIME_INVALID" },
            ],
            externalCall: true,
            ssrfProtected: true,
            redirectsRevalidated: true,
            responseBytesStored: false,
          },
        }),
        expectedChannel: "controlled_web_fetch",
        expectedCode: "CONTROLLED_WEB_MIME_INVALID",
      },
      {
        label: "location-intelligence",
        idx: 101,
        controlledWebFetchFn: async (sources) => ({
          attempted: true,
          ok: true,
          provider: "mock-controlled-web-evidence",
          results: [
            {
              title: "受控正文来源",
              url: sources[0].url,
              snippet: "正文摘要",
              body: "受控正文：太原吾悦广场毛血旺目标餐饮门店菜单、价格、营业状态、评价与竞品公开正文仅作隔离链路验收，未知字段保留复核动作。",
            },
          ],
          evidence: {
            schemaVersion: "nanowork.controlled-web-evidence/1",
            requested: sources.length,
            fetched: 1,
            failures: [],
            externalCall: true,
            ssrfProtected: true,
            redirectsRevalidated: true,
            responseBytesStored: false,
          },
        }),
        locationIntelligenceFn: async () => ({
          attempted: true,
          ok: false,
          provider: "mock-map-intelligence",
          results: [],
          note: "地图定位失败",
          evidence: {
            externalCall: true,
            failureCode: "LOCATION_INTELLIGENCE_FAILED",
          },
        }),
        expectedChannel: "location_intelligence",
        expectedCode: "LOCATION_INTELLIGENCE_FAILED",
      },
    ];

    for (const testCase of cases) {
      const execution = employeeExecution(testCase.idx);
      const task = taskFor(testCase.idx);
      let generateCalled = false;
      let failure;
      try {
        await marshalWork(testMarshal, task, "boss", {
          employeeExecution: execution,
          requireAgenticResearch: true,
          agenticWebResearchFn: async () =>
            testCase.label === "controlled-web-fetch"
              ? candidateAgenticEvidence(testCase.idx)
              : agenticEvidence(testCase.idx),
          webSearchFn: async () => ({
            attempted: true,
            ok: true,
            provider: "generic-web-search",
            results: [
              {
                title: "大众点评·毛血旺 太原吾悦广场商户页面",
                url: `https://generic.test/${testCase.idx}`,
                snippet:
                  "太原吾悦广场毛血旺餐厅菜单、价格、营业状态与评价公开商户正文。",
              },
            ],
          }),
          controlledWebFetchFn: testCase.controlledWebFetchFn,
          locationIntelligenceFn:
            testCase.locationIntelligenceFn ||
            (async () => ({
              attempted: true,
              ok: true,
              provider: "mock-map-intelligence",
              results: [
                {
                  title: "地图来源",
                  ...locationSource(testCase.idx),
                },
              ],
              evidence: { externalCall: true },
            })),
          generateFn: async () => {
            generateCalled = true;
            return {
              text: "{}",
              mode: "api",
              model: "must-not-run",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        });
      } catch (error) {
        failure = error;
      }
      assert.ok(failure, `${testCase.label}失败必须抛出错误`);
      assert.equal(failure.code, "EMPLOYEE_PUBLIC_RESEARCH_INCOMPLETE");
      assert.equal(
        generateCalled,
        false,
        `${testCase.label}失败不得调用最终生成`,
      );
      assert.ok(failure.web, `${testCase.label}失败必须保留web证据`);
      const failedChannel = failure.web.channels.find(
        (channel) => channel.kind === testCase.expectedChannel,
      );
      assert.ok(failedChannel, `${testCase.label}失败通道必须落库`);
      assert.equal(failedChannel.ok, false);
      assert.match(
        JSON.stringify(failedChannel),
        new RegExp(testCase.expectedCode, "u"),
      );
      if (testCase.label === "controlled-web-fetch") {
        assert.ok(
          failedChannel.evidence.failures.every(
            (item) => item.host && !Object.hasOwn(item, "url"),
          ),
        );
      }
      if (testCase.label === "controlled-web-fetch") {
        assert.doesNotMatch(
          JSON.stringify(failure.web),
          new RegExp(`agentic\\.test/${testCase.idx}`, "u"),
        );
        assert.doesNotMatch(
          JSON.stringify(failure.web),
          new RegExp(`generic\\.test/${testCase.idx}`, "u"),
        );
        assert.ok(
          failure.web.sourceQuality.rejected.some(
            (item) => item.reason === "not_controlled_page_evidence",
          ),
        );
      } else {
        assert.match(
          JSON.stringify(failure.web),
          new RegExp(`generic\\.test/${testCase.idx}`, "u"),
        );
        assert.doesNotMatch(
          JSON.stringify(failure.web),
          new RegExp(`agentic\\.test/${testCase.idx}`, "u"),
        );
      }
      assert.doesNotMatch(
        JSON.stringify(failure.web),
        /forged\.example/u,
        "候选URL不得进入失败快照",
      );
    }
  },
);

after(() => {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
});

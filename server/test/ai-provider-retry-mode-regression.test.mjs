/**
 * ai.js provider retry-mode regression probe.
 *
 * This is deliberately offline: all Web/地图/生成器 dependencies are injected,
 * and the generated response is a zero-token provider_timeout. It models the
 * T1315 ledger (gpt-5.5, first SSE attempt times out before a candidate) and
 * asserts the intended retry boundary: keep the locked requested model in the
 * audit, but retry the second acquire with the controlled gpt-5.5 failover and
 * non-stream chat so a flaky primary gateway cannot consume the entire wall
 * clock through the identical transport/model path.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NANOWORK_DB = ":memory:";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.ENABLE_SCHEDULER = "false";

const { initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { buildEmployeeExecutionProfile } =
  await import("../src/employee-workbench.js");
const {
  employeeTextModelFailoverPlan,
  marshalWork,
  runEmployeeProviderAttemptWithHardTimeout,
} = await import("../src/engines/ai.js");

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();
q.run(
  `INSERT INTO tenants(id,name,status,plan,credits)
   VALUES(1,'retry-mode-isolated','已开通','标准版',1000000)
   ON CONFLICT(id) DO UPDATE SET status='已开通',credits=1000000`,
);

const TASK = Object.freeze({
  title: "毛血旺 太原吾悦广场·重试传输探针",
  type: "商圈画像",
  requirement: "请核验竞品、商圈与交通可达性，并给出下一步可执行的业务结论。",
});

function source(prefix, index) {
  return {
    title: `${prefix}公开来源${index}`,
    url: `https://${prefix}.test/source-${index}`,
    snippet: `${prefix}隔离公开证据摘要${index}`,
  };
}

function restaurantSource(index) {
  return {
    title: `太原吾悦广场毛血旺商户菜单与评价来源${index}`,
    url: `https://www.dianping.com/shop/wuyue-maoxuewang-${index}`,
    snippet: `太原吾悦广场目标商户毛血旺的公开菜单、营业信息、价格和顾客评价候选${index}`,
  };
}

function fakeAgenticResearch() {
  const results = Array.from({ length: 5 }, (_unused, index) =>
    restaurantSource(index + 1),
  );
  return {
    attempted: true,
    ok: true,
    candidateReady: true,
    provider: "isolated-agentic",
    results,
    fetchCandidates: results,
    evidence: {
      schemaVersion: "nanowork.agentic-web-research/1",
      externalCall: true,
      qualityGate: {
        requiredSearches: 5,
        requiredSources: 5,
        observedSearches: 5,
        observedSuccessfulToolResults: 5,
        observedToolResultUrls: 5,
        observedSources: 5,
        passed: true,
      },
      usage: { inputTokens: 12, outputTokens: 24 },
    },
  };
}

function fakeWebSearch() {
  return {
    attempted: true,
    ok: true,
    provider: "isolated-web",
    results: [source("generic", 1)],
  };
}

function fakeControlledFetch(candidates = []) {
  const selected = (
    candidates.length ? candidates : [restaurantSource(1)]
  ).slice(0, 5);
  return {
    attempted: true,
    ok: true,
    provider: "isolated-controlled",
    results: selected.map((candidate, index) => ({
      ...candidate,
      body: `这是离线测试注入的受控正文${index + 1}，仅用于验证太原吾悦广场毛血旺商户的菜单、菜品、营业状态、价格、评价与竞品分析链路。正文长度超过八十个字符，不代表真实公网数据，也不提供任何未经核验的经营结论；实际运行必须重新抓取对应公开页面。`,
    })),
    evidence: {
      schemaVersion: "nanowork.controlled-web-evidence/1",
      externalCall: true,
      ssrfProtected: true,
      fetched: selected.length,
    },
  };
}

function fakeLocation() {
  return {
    attempted: true,
    ok: true,
    provider: "isolated-location",
    results: [
      {
        title: "OpenStreetMap定位·太原吾悦广场",
        url: "https://www.openstreetmap.org/way/1126952639",
        snippet: "太原吾悦广场目标地点与周边路网的离线地图锚点",
      },
    ],
    evidence: {
      schemaVersion: "nanowork.location-intelligence/1",
      externalCall: true,
      center: { displayName: "太原市小店区吾悦广场", lat: 37.81, lon: 112.55 },
    },
  };
}

function employeeExecution() {
  return runWithTenant(1, () =>
    buildEmployeeExecutionProfile(102, {
      tenantId: 1,
      user: { id: 1, role: "boss", tenant_id: 1 },
    }),
  );
}

test("模型故障切换计划是纯确定性上界，gpt-5.5自身不会再配置备用", () => {
  assert.deepEqual(employeeTextModelFailoverPlan("deepseek-v4-flash"), {
    version: 1,
    requestedModel: "deepseek-v4-flash",
    models: ["deepseek-v4-flash", "gpt-5.5"],
    backupModel: "gpt-5.5",
  });
  assert.deepEqual(employeeTextModelFailoverPlan("gpt-5.5"), {
    version: 1,
    requestedModel: "gpt-5.5",
    models: ["gpt-5.5"],
    backupModel: null,
  });
});

test("供应商忽略AbortSignal时，单轮调用仍由硬超时结束并释放后续重试机会", async () => {
  let receivedAbort = false;
  const startedAt = Date.now();
  await assert.rejects(
    runEmployeeProviderAttemptWithHardTimeout(
      async ({ signal }) =>
        new Promise(() => {
          signal.addEventListener(
            "abort",
            () => {
              receivedAbort = true;
            },
            { once: true },
          );
        }),
      { timeoutMs: 25 },
    ),
    (error) =>
      error?.code === "provider_timeout" &&
      error?.status === 504 &&
      error?.retryable === true,
  );
  assert.equal(receivedAbort, true);
  assert.ok(
    Date.now() - startedAt < 500,
    "硬超时不得继续等待无正文的供应商连接",
  );
});

test(
  "回归：首轮SSE provider_timeout/0 token后，第二次acquire才切换gpt-5.5并改用非流式",
  { concurrency: false },
  async () => {
    const execution = employeeExecution();
    const calls = [];
    const approvalsBefore = Number(
      q.get("SELECT COUNT(*) AS count FROM approvals WHERE tenant_id=1")
        ?.count || 0,
    );
    const result = await runWithTenant(1, () =>
      marshalWork(
        { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度" },
        TASK,
        "boss",
        {
          employeeExecution: execution,
          requireAgenticResearch: true,
          agenticWebResearchFn: async () => fakeAgenticResearch(),
          webSearchFn: async () => fakeWebSearch(),
          controlledWebFetchFn: async (candidates) =>
            fakeControlledFetch(candidates),
          locationIntelligenceFn: async () => fakeLocation(),
          // Every attempt is an immediate local zero-token transport failure;
          // no network call, credentials or payment is involved.
          generateFn: async (args) => {
            calls.push({
              model: args.model,
              preferStream: args.preferStream,
              providerPolicy: args.providerPolicy,
              timeoutMs: args.timeoutMs,
              firstByteTimeoutMs: args.firstByteTimeoutMs,
            });
            return {
              text: "",
              mode: "template",
              model: "template",
              usage: { inputTokens: 0, outputTokens: 0 },
              providerFailure: {
                code: "provider_timeout",
                status: 504,
                timedOut: true,
                retryable: true,
                summary: "供应商响应超时",
              },
            };
          },
        },
      ),
    );
    const approvalsAfter = Number(
      q.get("SELECT COUNT(*) AS count FROM approvals WHERE tenant_id=1")
        ?.count || 0,
    );

    // The failure must remain a zero-token transport run under one budget;
    // this probe must never create an approval or a fake business output.
    assert.equal(approvalsAfter - approvalsBefore, 0);
    assert.equal(result.mode, "template");
    assert.equal(result.employeeContract?.valid, false);
    assert.equal(result.employeeContract?.providerBudget?.transportFailures, 3);
    assert.equal(result.employeeContract?.providerBudget?.totalAttempts, 3);
    assert.equal(result.employeeContract?.providerAttempts?.length, 3);
    assert.deepEqual(
      calls.map((call) => call.model),
      [
        "deepseek-v4-flash",
        "gpt-5.5",
        "gpt-5.5",
      ],
    );
    assert.ok(calls.every((call) => call.providerPolicy === "yunwu_only"));
    assert.ok(calls.every((call) => call.timeoutMs === 300_000));

    // 首轮失败事实仍归属于锁定模型；模型切换只从下一轮开始，且账本不得
    // 用供应商错误正文作为reason。
    assert.deepEqual(
      result.employeeContract.providerAttempts.map((attempt) => ({
        requestedModel: attempt.requestedModel,
        effectiveModel: attempt.effectiveModel,
        modelFailover: attempt.modelFailover,
      })),
      [
        {
          requestedModel: "deepseek-v4-flash",
          effectiveModel: "deepseek-v4-flash",
          modelFailover: null,
        },
        {
          requestedModel: "deepseek-v4-flash",
          effectiveModel: "gpt-5.5",
          modelFailover: {
            from: "deepseek-v4-flash",
            to: "gpt-5.5",
            reason: "retryable_zero_usage_transport_failure",
            attempt: 2,
          },
        },
        {
          requestedModel: "deepseek-v4-flash",
          effectiveModel: "gpt-5.5",
          modelFailover: {
            from: "deepseek-v4-flash",
            to: "gpt-5.5",
            reason: "retryable_zero_usage_transport_failure",
            attempt: 2,
          },
        },
      ],
    );
    assert.equal(result.employeeContract.requestedModel, "deepseek-v4-flash");
    assert.equal(result.employeeContract.effectiveModel, "gpt-5.5");
    assert.deepEqual(result.employeeContract.modelFailover, {
      from: "deepseek-v4-flash",
      to: "gpt-5.5",
      reason: "retryable_zero_usage_transport_failure",
      attempt: 2,
    });
    assert.equal(
      result.employeeContract.providerBudget.requestedModel,
      "deepseek-v4-flash",
    );
    assert.equal(
      result.employeeContract.providerBudget.effectiveModel,
      "gpt-5.5",
    );
    assert.equal(calls[0].preferStream, true);
    assert.equal(calls[1].preferStream, false);

    // 供应商一个字节都不回时，流式尝试必须带首包窗口提前收口，而不是把
    // 单轮上限整段等满（真实样本里三次零产出尝试合计干等约1000秒）。
    // 首包窗口严格小于单轮上限，且只作用于流式；非流式重试没有分片信号，
    // 必须沿用整段窗口，否则会误杀慢速但健康的生成。
    assert.ok(
      calls[0].firstByteTimeoutMs > 0 &&
        calls[0].firstByteTimeoutMs < calls[0].timeoutMs,
      `流式首轮应带首包窗口，实际=${calls[0].firstByteTimeoutMs}`,
    );
    assert.equal(calls[1].firstByteTimeoutMs, undefined);
    assert.equal(calls[2].firstByteTimeoutMs, undefined);
  },
);

test(
  "回归：429、503、鉴权和互相矛盾的错误分类不得触发模型切换",
  { concurrency: false },
  async () => {
    const scenarios = [
      {
        code: "provider_rate_limited",
        status: 429,
        retryable: true,
        attempts: 3,
      },
      {
        code: "provider_upstream_error",
        status: 503,
        retryable: true,
        attempts: 3,
      },
      {
        code: "provider_auth_failed",
        status: 401,
        retryable: false,
        attempts: 1,
      },
      {
        code: "provider_request_failed",
        status: 502,
        retryable: true,
        attempts: 3,
      },
      {
        code: "provider_timeout",
        status: 502,
        timedOut: true,
        retryable: true,
        attempts: 3,
      },
      {
        code: "provider_upstream_error",
        status: 504,
        timedOut: false,
        retryable: true,
        attempts: 3,
      },
    ];
    for (const scenario of scenarios) {
      const calls = [];
      const result = await runWithTenant(1, () =>
        marshalWork(
          { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度" },
          TASK,
          "boss",
          {
            employeeExecution: employeeExecution(),
            requireAgenticResearch: true,
            agenticWebResearchFn: async () => fakeAgenticResearch(),
            webSearchFn: async () => fakeWebSearch(),
            controlledWebFetchFn: async (candidates) =>
              fakeControlledFetch(candidates),
            locationIntelligenceFn: async () => fakeLocation(),
            generateFn: async (args) => {
              calls.push(args.model);
              return {
                text: "",
                mode: "template",
                model: "template",
                usage: { inputTokens: 0, outputTokens: 0 },
                providerFailure: {
                  ...scenario,
                  summary: "SECRET-UPSTREAM-ERROR-BODY",
                },
              };
            },
          },
        ),
      );
      assert.equal(calls.length, scenario.attempts);
      assert.ok(calls.every((model) => model === "deepseek-v4-flash"));
      assert.equal(result.employeeContract.modelFailover, null);
      assert.ok(
        result.employeeContract.providerAttempts.every(
          (attempt) =>
            attempt.requestedModel === "deepseek-v4-flash" &&
            attempt.effectiveModel === "deepseek-v4-flash" &&
            attempt.modelFailover === null,
        ),
      );
      assert.doesNotMatch(
        JSON.stringify(result.employeeContract.providerAttempts),
        /SECRET-UPSTREAM-ERROR-BODY/u,
      );
    }
  },
);

test(
  "回归：SSE已收到正文delta后即使504且usage为0，也不得跨模型重试",
  { concurrency: false },
  async () => {
    const calls = [];
    const result = await runWithTenant(1, () =>
      marshalWork(
        { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度" },
        TASK,
        "boss",
        {
          employeeExecution: employeeExecution(),
          requireAgenticResearch: true,
          agenticWebResearchFn: async () => fakeAgenticResearch(),
          webSearchFn: async () => fakeWebSearch(),
          controlledWebFetchFn: async (candidates) =>
            fakeControlledFetch(candidates),
          locationIntelligenceFn: async () => fakeLocation(),
          generateFn: async (args) => {
            calls.push({ model: args.model, preferStream: args.preferStream });
            args.onDelta?.('{"partial":"供应商已经返回正文');
            throw Object.assign(new Error("stream ended with gateway timeout"), {
              status: 504,
              providerReason: "timeout",
              providerStatus: 504,
              providerUsage: { inputTokens: 0, outputTokens: 0 },
            });
          },
        },
      ),
    );
    assert.deepEqual(
      calls.map((call) => call.model),
      ["deepseek-v4-flash", "deepseek-v4-flash", "deepseek-v4-flash"],
    );
    assert.equal(result.employeeContract.modelFailover, null);
    assert.ok(
      result.employeeContract.providerAttempts[0].receivedChars > 0,
      "首轮账本必须保存已收到正文字符的事实",
    );
    assert.ok(
      result.employeeContract.providerAttempts.every(
        (attempt) => attempt.modelFailover === null,
      ),
    );
  },
);

test(
  "回归：早期零用量503不切模型，后续自洽upstream+502才允许下一轮切换",
  { concurrency: false },
  async () => {
    const calls = [];
    const result = await runWithTenant(1, () =>
      marshalWork(
        { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度" },
        TASK,
        "boss",
        {
          employeeExecution: employeeExecution(),
          requireAgenticResearch: true,
          agenticWebResearchFn: async () => fakeAgenticResearch(),
          webSearchFn: async () => fakeWebSearch(),
          controlledWebFetchFn: async (candidates) =>
            fakeControlledFetch(candidates),
          locationIntelligenceFn: async () => fakeLocation(),
          generateFn: async (args) => {
            calls.push(args.model);
            const status = calls.length === 1 ? 503 : 502;
            return {
              text: "",
              mode: "template",
              model: "template",
              usage: { inputTokens: 0, outputTokens: 0 },
              providerFailure: {
                code: "provider_upstream_error",
                status,
                timedOut: false,
                retryable: true,
              },
            };
          },
        },
      ),
    );
    assert.deepEqual(calls, [
      "deepseek-v4-flash",
      "deepseek-v4-flash",
      "gpt-5.5",
    ]);
    assert.deepEqual(result.employeeContract.modelFailover, {
      from: "deepseek-v4-flash",
      to: "gpt-5.5",
      reason: "retryable_zero_usage_transport_failure",
      attempt: 3,
    });
  },
);

test(
  "回归：零Token 500 upstream故障可安全切到备用模型",
  { concurrency: false },
  async () => {
    const calls = [];
    const result = await runWithTenant(1, () =>
      marshalWork(
        { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度" },
        TASK,
        "boss",
        {
          employeeExecution: employeeExecution(),
          requireAgenticResearch: true,
          agenticWebResearchFn: async () => fakeAgenticResearch(),
          webSearchFn: async () => fakeWebSearch(),
          controlledWebFetchFn: async (candidates) => fakeControlledFetch(candidates),
          locationIntelligenceFn: async () => fakeLocation(),
          generateFn: async (args) => {
            calls.push(args.model);
            return {
              text: "",
              mode: "template",
              model: "template",
              usage: { inputTokens: 0, outputTokens: 0 },
              providerFailure: {
                code: "provider_upstream_error",
                status: 500,
                timedOut: false,
                retryable: true,
              },
            };
          },
        },
      ),
    );
    assert.deepEqual(calls, ["deepseek-v4-flash", "gpt-5.5", "gpt-5.5"]);
    assert.equal(result.employeeContract.modelFailover?.to, "gpt-5.5");
  },
);

test(
  "回归：正token API候选的JSON/契约失败只允许同模型repair，不得借质检切模型",
  { concurrency: false },
  async () => {
    const calls = [];
    let caught = null;
    try {
      await runWithTenant(1, () =>
        marshalWork(
          { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度" },
          TASK,
          "boss",
          {
            employeeExecution: employeeExecution(),
            requireAgenticResearch: true,
            agenticWebResearchFn: async () => fakeAgenticResearch(),
            webSearchFn: async () => fakeWebSearch(),
            controlledWebFetchFn: async (candidates) =>
              fakeControlledFetch(candidates),
            locationIntelligenceFn: async () => fakeLocation(),
            generateFn: async (args) => {
              calls.push({ model: args.model, kind: args.kind });
              return {
                text: "{}",
                mode: "api",
                model: args.model,
                finishReason: "stop",
                usage: { inputTokens: 120, outputTokens: 8 },
              };
            },
          },
        ),
      );
    } catch (error) {
      caught = error;
    }
    assert.equal(caught?.code, "RESTAURANT_OUTPUT_CONTRACT_INVALID");
    assert.equal(calls.length, 3);
    assert.equal(calls[0].kind, "M-01");
    assert.match(calls[1].kind, /contract-repair/u);
    assert.ok(calls.every((call) => call.model === "deepseek-v4-flash"));
    assert.equal(caught.providerRequestedModel, "deepseek-v4-flash");
    assert.equal(caught.providerEffectiveModel, "deepseek-v4-flash");
    assert.equal(caught.providerModelFailover, null);
    assert.ok(
      caught.providerAttempts.every(
        (attempt) =>
          attempt.requestedModel === "deepseek-v4-flash" &&
          attempt.effectiveModel === "deepseek-v4-flash" &&
          attempt.modelFailover === null,
      ),
    );
  },
);

test(
  "回归：备用模型取得候选后，后续repair必须固定使用该备用模型",
  { concurrency: false },
  async () => {
    const calls = [];
    let caught = null;
    try {
      await runWithTenant(1, () =>
        marshalWork(
          { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度" },
          TASK,
          "boss",
          {
            employeeExecution: employeeExecution(),
            requireAgenticResearch: true,
            agenticWebResearchFn: async () => fakeAgenticResearch(),
            webSearchFn: async () => fakeWebSearch(),
            controlledWebFetchFn: async (candidates) =>
              fakeControlledFetch(candidates),
            locationIntelligenceFn: async () => fakeLocation(),
            generateFn: async (args) => {
              calls.push({ model: args.model, kind: args.kind });
              if (calls.length === 1) {
                return {
                  text: "",
                  mode: "template",
                  model: "template",
                  usage: { inputTokens: 0, outputTokens: 0 },
                  providerFailure: {
                    code: "provider_timeout",
                    status: 504,
                    timedOut: true,
                    retryable: true,
                  },
                };
              }
              return {
                text: "{}",
                mode: "api",
                model: args.model,
                finishReason: "stop",
                usage: { inputTokens: 120, outputTokens: 8 },
              };
            },
          },
        ),
      );
    } catch (error) {
      caught = error;
    }
    assert.equal(caught?.code, "RESTAURANT_OUTPUT_CONTRACT_INVALID");
    assert.deepEqual(
      calls.map((call) => call.model),
      ["deepseek-v4-flash", "gpt-5.5", "gpt-5.5", "gpt-5.5"],
    );
    assert.match(calls[2].kind, /contract-repair/u);
    assert.ok(
      caught.providerAttempts.slice(1).every(
        (attempt) =>
          attempt.effectiveModel === "gpt-5.5" &&
          attempt.modelFailover?.attempt === 2,
      ),
    );
    assert.equal(caught.providerEffectiveModel, "gpt-5.5");
    assert.deepEqual(caught.providerModelFailover, {
      from: "deepseek-v4-flash",
      to: "gpt-5.5",
      reason: "retryable_zero_usage_transport_failure",
      attempt: 2,
    });
  },
);

test(
  "回归：备用模型返回空白API候选后，empty-response-retry不得跳回首选模型",
  { concurrency: false },
  async () => {
    const calls = [];
    let caught = null;
    try {
      await runWithTenant(1, () =>
        marshalWork(
          { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度" },
          TASK,
          "boss",
          {
            employeeExecution: employeeExecution(),
            requireAgenticResearch: true,
            agenticWebResearchFn: async () => fakeAgenticResearch(),
            webSearchFn: async () => fakeWebSearch(),
            controlledWebFetchFn: async (candidates) =>
              fakeControlledFetch(candidates),
            locationIntelligenceFn: async () => fakeLocation(),
            generateFn: async (args) => {
              calls.push({ model: args.model, kind: args.kind });
              if (calls.length === 1) {
                return {
                  text: "",
                  mode: "template",
                  model: "template",
                  usage: { inputTokens: 0, outputTokens: 0 },
                  providerFailure: {
                    code: "provider_timeout",
                    status: 504,
                    timedOut: true,
                    retryable: true,
                  },
                };
              }
              return {
                text: calls.length === 2 ? "" : "{}",
                mode: "api",
                model: args.model,
                finishReason: "stop",
                usage: { inputTokens: 120, outputTokens: 8 },
              };
            },
          },
        ),
      );
    } catch (error) {
      caught = error;
    }
    assert.equal(caught?.code, "RESTAURANT_OUTPUT_CONTRACT_INVALID");
    assert.deepEqual(
      calls.map((call) => call.model),
      ["deepseek-v4-flash", "gpt-5.5", "gpt-5.5", "gpt-5.5"],
    );
    assert.match(calls[2].kind, /empty-response-retry/u);
    assert.ok(
      caught.providerAttempts.slice(1).every(
        (attempt) => attempt.effectiveModel === "gpt-5.5",
      ),
    );
  },
);

test(
  "回归：供应商计入用量但正文为空仍属于acquire失败，不得伪装成岗位质检返工",
  { concurrency: false },
  async () => {
    const execution = employeeExecution();
    const calls = [];
    const result = await runWithTenant(1, () =>
      marshalWork(
        { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度" },
        TASK,
        "boss",
        {
          employeeExecution: execution,
          requireAgenticResearch: true,
          agenticWebResearchFn: async () => fakeAgenticResearch(),
          webSearchFn: async () => fakeWebSearch(),
          controlledWebFetchFn: async (candidates) =>
            fakeControlledFetch(candidates),
          locationIntelligenceFn: async () => fakeLocation(),
          generateFn: async (args) => {
            calls.push({
              model: args.model,
              preferStream: args.preferStream,
              kind: args.kind,
            });
            return {
              text: "",
              mode: "template",
              model: "template",
              usage: { inputTokens: 75_897, outputTokens: 531 },
              providerFailure: {
                code: "provider_empty_output",
                status: 502,
                timedOut: false,
                retryable: true,
                summary: "供应商计入了用量但没有返回业务正文",
              },
            };
          },
        },
      ),
    );

    assert.equal(result.mode, "template");
    assert.equal(result.employeeContract?.valid, false);
    assert.equal(result.employeeContract?.providerBudget?.candidateAttempts, 3);
    assert.equal(result.employeeContract?.providerBudget?.transportFailures, 0);
    assert.equal(
      result.employeeContract?.providerBudget?.stoppedReason,
      "candidate_budget_exhausted",
    );
    assert.deepEqual(
      result.employeeContract?.providerAttempts?.map((attempt) => ({
        phase: attempt.phase,
        code: attempt.failure?.code,
        budgetClass: attempt.budgetClass,
      })),
      Array.from({ length: 3 }, () => ({
        phase: "acquire",
        code: "provider_empty_output",
        budgetClass: "candidate",
      })),
    );
    assert.ok(calls.every((call) => !/repair/u.test(call.kind)));
    assert.ok(
      calls.every((call) => call.model === "deepseek-v4-flash"),
      "只要任一供应商失败携带正token，就不得切换备用模型",
    );
    assert.equal(result.employeeContract.modelFailover, null);
  },
);

test(
  "回归：任一早期尝试已有正token后，后续零token 502也不得再切模型",
  { concurrency: false },
  async () => {
    const calls = [];
    const result = await runWithTenant(1, () =>
      marshalWork(
        { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度" },
        TASK,
        "boss",
        {
          employeeExecution: employeeExecution(),
          requireAgenticResearch: true,
          agenticWebResearchFn: async () => fakeAgenticResearch(),
          webSearchFn: async () => fakeWebSearch(),
          controlledWebFetchFn: async (candidates) =>
            fakeControlledFetch(candidates),
          locationIntelligenceFn: async () => fakeLocation(),
          generateFn: async (args) => {
            calls.push(args.model);
            if (calls.length === 1) {
              return {
                text: "",
                mode: "template",
                model: "template",
                usage: { inputTokens: 80, outputTokens: 1 },
                providerFailure: {
                  code: "provider_empty_output",
                  status: 502,
                  retryable: true,
                },
              };
            }
            return {
              text: "",
              mode: "template",
              model: "template",
              usage: { inputTokens: 0, outputTokens: 0 },
              providerFailure: {
                code: "provider_upstream_error",
                status: 502,
                retryable: true,
              },
            };
          },
        },
      ),
    );
    assert.deepEqual(calls, [
      "deepseek-v4-flash",
      "deepseek-v4-flash",
      "deepseek-v4-flash",
      "deepseek-v4-flash",
    ]);
    assert.equal(result.employeeContract.modelFailover, null);
    assert.ok(
      result.employeeContract.providerAttempts.every(
        (attempt) => attempt.modelFailover === null,
      ),
    );
  },
);

test(
  "回归：流式已收到部分正文后再504，不得冒充零Token切换模型",
  { concurrency: false },
  async () => {
    const calls = [];
    const result = await runWithTenant(1, () =>
      marshalWork(
        { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度" },
        TASK,
        "boss",
        {
          employeeExecution: employeeExecution(),
          requireAgenticResearch: true,
          agenticWebResearchFn: async () => fakeAgenticResearch(),
          webSearchFn: async () => fakeWebSearch(),
          controlledWebFetchFn: async (candidates) =>
            fakeControlledFetch(candidates),
          locationIntelligenceFn: async () => fakeLocation(),
          generateFn: async (args) => {
            calls.push(args.model);
            args.onDelta?.("供应商已经返回部分真实正文");
            throw Object.assign(new Error("流式连接随后超时"), {
              status: 504,
              providerReason: "timeout",
              retryable: true,
            });
          },
        },
      ),
    );
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((model) => model === "deepseek-v4-flash"));
    assert.equal(result.employeeContract.modelFailover, null);
  },
);

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

import { validContentEmployeeOutput } from "./helpers/content-output-fixtures.mjs";

// This file intentionally owns a fresh database. It is a narrow regression test
// for the optional-web trigger and must not consume IDs or state from the main
// workbench route suites.
const dbPath = path.join(
  os.tmpdir(),
  `nanowork-content-web-trigger-${process.pid}.db`,
);
for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  try {
    fs.rmSync(target, { force: true });
  } catch {
    /* best effort */
  }
}
process.env.NANOWORK_DB = dbPath;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

const { db, initSchema, migrateV2, q, runWithTenant, setTenantConfig } =
  await import("../src/db.js");
const { createContentEmployeeWorkbenchRouter } =
  await import("../src/routes/content-employee-workbench.js");

initSchema();
migrateV2();

const APPROVAL_ROUTING_POLICY_KEY = "approval_routing_policy";
const scheduled = [];
const generationCalls = [];
const agenticCalls = [];
const controlledFetchCalls = [];
const legacySnippetSearchCalls = [];
let holdId = 0;

function agenticSources(prefix = "optional") {
  return Array.from({ length: 5 }, (_unused, index) => ({
    title: `官方竞品研究快照${index + 1}`,
    url: `https://evidence.test/${prefix}/official-competitor-${index + 1}`,
    snippet: `本次隔离WebSearch第${index + 1}次工具结果，仅能作为受控抓取候选。`,
  }));
}

function successfulAgenticResearch(query) {
  const sources = agenticSources();
  agenticCalls.push(String(query));
  return {
    attempted: true,
    ok: true,
    candidateReady: true,
    provider: "isolated-agentic-websearch",
    results: sources,
    fetchCandidates: sources,
    evidence: {
      schemaVersion: "nanowork.agentic-web-research/1",
      toolCalls: 5,
      toolAttempts: 5,
      qualityGate: {
        observedSearches: 5,
        observedSuccessfulToolResults: 5,
        observedToolResultUrls: 5,
        passed: true,
      },
      candidateGate: {
        observedSearches: 5,
        observedSuccessfulToolResults: 5,
        observedToolResultUrls: 5,
        observedCandidates: 5,
        passed: true,
        requiresControlledWebFetch: true,
      },
      externalCall: true,
    },
  };
}

function controlledEvidence(sources) {
  controlledFetchCalls.push(sources.map((source) => source.url));
  const source = sources[0];
  return {
    attempted: true,
    ok: true,
    provider: "isolated-controlled-webfetch",
    results: [
      {
        ...source,
        body: "受控网页正文已经由应用网关读取、净化并核验：该官方竞品案例记录了公开发布时间、内容定位、用户反馈与平台规则边界；未在正文出现的销量、价格和经营效果继续标记为未核验，不得猜测。",
      },
    ],
    evidence: {
      requested: sources.length,
      fetched: 1,
      failures: [],
      externalCall: true,
      rawResponseStored: false,
      extractedTextStored: true,
    },
  };
}

function setManagerReviewPolicy(tenantId) {
  setTenantConfig(
    APPROVAL_ROUTING_POLICY_KEY,
    {
      employeeOutput: { mode: "manager" },
    },
    tenantId,
  );
}

function ensureIdentity(tenantId, role = "boss") {
  db.prepare(
    `INSERT OR IGNORE INTO tenants(id,name,status,credits)
    VALUES(?,?,'启用',1000000000)`,
  ).run(tenantId, `${tenantId}号联网触发专项企业`);
  const id = tenantId * 1_000 + 1;
  db.prepare(
    `INSERT OR IGNORE INTO users(
    id,username,password_hash,name,role,status,tenant_id
  ) VALUES(?,?,?,?,?,'启用',?)`,
  ).run(
    id,
    `content-web-trigger-${tenantId}`,
    "x",
    `${tenantId}号专项老板`,
    role,
    tenantId,
  );
  db.prepare(
    "UPDATE users SET role=?,status='启用',tenant_id=? WHERE id=?",
  ).run(role, tenantId, id);
  return id;
}

const router = createContentEmployeeWorkbenchRouter({
  generateFn: async (args) => {
    generationCalls.push(args);
    return {
      text: JSON.stringify(validContentEmployeeOutput(3)),
      mode: "api",
      model: "isolated-web-trigger-model",
      usage: { inputTokens: 120, outputTokens: 80 },
    };
  },
  agenticWebResearchFn: async (query) => successfulAgenticResearch(query),
  controlledWebFetchFn: async (sources) => controlledEvidence(sources),
  // 回归毒丸：普通snippet搜索不应再是单派路由的可调用依赖。
  webSearchFn: async (query) => {
    legacySnippetSearchCalls.push(String(query));
    throw new Error("legacy snippet search must remain unreachable");
  },
  scheduleFn: (task) => scheduled.push(task),
  precheckByRoleFn: () => 1000,
  estimateCallCreditsFn: () => 24,
  holdCreditsFn: (args) => ({
    holdId: ++holdId,
    credits: Number(args.credits),
    balance: 999_976,
    model: args.model,
  }),
  settleHoldFn: (hold, args) => ({
    holdId: hold.holdId,
    credits: 7,
    balance: 999_993,
    model: args.model,
  }),
  releaseHoldFn: (hold) => ({
    holdId: hold.holdId,
    credits: 0,
    balance: 1_000_000,
  }),
  buildHandlerContextFn: async () => ({
    context: {},
    snapshot: { schemaVersion: "isolated-web-trigger-context/1" },
  }),
  notifyFn: () => {},
  logOpFn: () => {},
});

function makeApp() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    const tenantId = Number(req.get("x-test-tenant") || 1);
    const role = req.get("x-test-role") || "boss";
    const userId = ensureIdentity(tenantId, role);
    runWithTenant(tenantId, () => {
      req.user = {
        id: userId,
        name: `${tenantId}号专项老板`,
        role,
        tenant_id: tenantId,
      };
      req.requestSignal = new AbortController().signal;
      req.aiGuard = { defer: () => () => {} };
      next();
    });
  });
  app.use("/employee-workbench/content", router);
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0, "127.0.0.1");
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function jsonCall(base, route, { method = "GET", tenant, body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      "x-test-tenant": String(tenant),
      "x-test-role": "boss",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function drainScheduled() {
  while (scheduled.length) await scheduled.shift()();
}

function storedSnapshot(tenantId, runId) {
  const row = q.get(
    "SELECT status,result_md,snapshot_json,prompt_hash FROM content_employee_runs WHERE tenant_id=? AND id=?",
    tenantId,
    runId,
  );
  assert.ok(row, `run ${tenantId}/${runId} must be persisted`);
  return { row, snapshot: JSON.parse(row.snapshot_json) };
}

test("普通内容员工命中最新/官方/竞品信号时只走隔离Agentic→受控正文→最终模型", async () => {
  await withServer(async (base) => {
    const tenant = 741;
    setManagerReviewPolicy(tenant);
    const beforeAgentic = agenticCalls.length;
    const beforeControlled = controlledFetchCalls.length;
    const beforeLegacy = legacySnippetSearchCalls.length;
    const { response, payload } = await jsonCall(
      base,
      "/employee-workbench/content/3/dispatch",
      {
        method: "POST",
        tenant,
        body: {
          title: "竞品内容专项联网触发",
          type: "文案初稿",
          requirement: "请基于最新官方竞品案例，整理可验证的差异化内容切入点。",
        },
      },
    );
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(agenticCalls.length, beforeAgentic + 1);
    assert.equal(controlledFetchCalls.length, beforeControlled + 1);
    assert.equal(legacySnippetSearchCalls.length, beforeLegacy);
    assert.match(agenticCalls.at(-1), /最新|官方|竞品/u);

    const queued = storedSnapshot(tenant, payload.runId);
    assert.equal(queued.snapshot.web.required, false);
    assert.equal(queued.snapshot.web.triggered, true);
    assert.equal(queued.snapshot.web.attempted, true);
    assert.equal(queued.snapshot.web.verified, true);
    assert.equal(
      queued.snapshot.web.provider,
      "isolated-agentic-websearch,NanoWork controlled WebFetch",
    );
    assert.equal(queued.snapshot.web.results.length, 1);
    assert.equal(
      queued.snapshot.web.results[0].url,
      "https://evidence.test/optional/official-competitor-1",
    );
    assert.ok(queued.snapshot.web.results[0].body.length >= 80);
    assert.equal(
      queued.snapshot.web.queryPlan.agenticCandidateGatePassed,
      true,
    );
    assert.equal(queued.snapshot.web.queryPlan.observedToolAttempts, 5);
    assert.equal(
      queued.snapshot.web.queryPlan.observedSuccessfulToolResults,
      5,
    );
    assert.equal(queued.snapshot.web.queryPlan.observedToolResultUrls, 5);
    assert.equal(Object.hasOwn(queued.snapshot.web, "channelCalls"), false);
    assert.doesNotMatch(
      JSON.stringify(queued.snapshot),
      /official-competitor-[2-5]/u,
      "未经受控抓取的候选URL不得落库",
    );

    await drainScheduled();
    assert.equal(generationCalls.length > 0, true);
    const modelCall = generationCalls.at(-1);
    assert.match(modelCall.userMsg, /【联网参考资料】/u);
    assert.match(modelCall.userMsg, /官方竞品研究快照1/u);
    assert.match(
      modelCall.userMsg,
      /https:\/\/evidence\.test\/optional\/official-competitor-1/u,
    );
    assert.doesNotMatch(modelCall.userMsg, /official-competitor-[2-5]/u);

    const completed = storedSnapshot(tenant, payload.runId);
    assert.equal(completed.snapshot.web.triggered, true);
    assert.equal(completed.snapshot.web.attempted, true);
    assert.equal(completed.snapshot.web.verified, true);
    assert.equal(
      completed.snapshot.promptCompilation.effectivePromptHash,
      completed.row.prompt_hash,
    );
    assert.equal(completed.row.status, "待审阅");
  });
});

test("普通内部改写不命中联网信号，不调用Agentic/WebFetch且快照保持未尝试", async () => {
  await withServer(async (base) => {
    const tenant = 742;
    setManagerReviewPolicy(tenant);
    const beforeAgentic = agenticCalls.length;
    const beforeControlled = controlledFetchCalls.length;
    const { response, payload } = await jsonCall(
      base,
      "/employee-workbench/content/3/dispatch",
      {
        method: "POST",
        tenant,
        body: {
          title: "既有品牌文案改写",
          type: "文案初稿",
          requirement:
            "根据已提供的品牌手册改写一篇小红书文案，保持原有口吻，不增加新事实。",
        },
      },
    );
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(agenticCalls.length, beforeAgentic);
    assert.equal(controlledFetchCalls.length, beforeControlled);
    const queued = storedSnapshot(tenant, payload.runId);
    assert.equal(queued.snapshot.web.required, false);
    assert.equal(queued.snapshot.web.triggered, false);
    assert.equal(queued.snapshot.web.attempted, false);
    assert.equal(queued.snapshot.web.verified, false);
    await drainScheduled();
    const completed = storedSnapshot(tenant, payload.runId);
    assert.equal(completed.snapshot.web.triggered, false);
    assert.equal(completed.snapshot.web.attempted, false);
    assert.equal(completed.snapshot.web.verified, false);
    assert.doesNotMatch(generationCalls.at(-1).userMsg, /【联网参考资料】/u);
  });
});

test("0-2联网必需岗位没有可验证证据时预检失败关闭，不进入模型调度", async () => {
  // 单独注入一个“自报ok但只调用4次工具”的伪成功结果，
  // 验证路由层不信任ok布尔值，必须因五次真实工具门未过而关闭。
  const failedAgenticCalls = [];
  const failedControlledCalls = [];
  const failedLegacySnippetCalls = [];
  const failedScheduled = [];
  const requiredRouter = createContentEmployeeWorkbenchRouter({
    generateFn: async () => {
      throw new Error("required-web fail-closed must not call model");
    },
    agenticWebResearchFn: async (query) => {
      failedAgenticCalls.push(String(query));
      const sources = agenticSources("under-gate");
      return {
        attempted: true,
        ok: true,
        candidateReady: true,
        provider: "under-gate-agentic",
        results: sources,
        fetchCandidates: sources,
        note: "仅完成4次WebSearch工具调用",
        evidence: {
          toolCalls: 4,
          toolAttempts: 4,
          qualityGate: {
            observedSearches: 4,
            observedSuccessfulToolResults: 4,
            observedToolResultUrls: 5,
            passed: false,
          },
          candidateGate: {
            observedSearches: 4,
            observedSuccessfulToolResults: 4,
            observedToolResultUrls: 5,
            observedCandidates: 5,
            passed: false,
          },
          externalCall: true,
        },
      };
    },
    controlledWebFetchFn: async (sources) => {
      failedControlledCalls.push(sources);
      throw new Error("candidate gate failure must stop before WebFetch");
    },
    webSearchFn: async (query) => {
      failedLegacySnippetCalls.push(String(query));
      throw new Error("legacy snippet search must remain unreachable");
    },
    scheduleFn: (task) => failedScheduled.push(task),
    precheckByRoleFn: () => 1000,
    estimateCallCreditsFn: () => 24,
    holdCreditsFn: (args) => ({
      holdId: ++holdId,
      credits: args.credits,
      balance: 999_976,
      model: args.model,
    }),
    releaseHoldFn: (hold) => ({
      holdId: hold.holdId,
      credits: 0,
      balance: 1_000_000,
    }),
    buildHandlerContextFn: async () => ({ context: {}, snapshot: {} }),
    notifyFn: () => {},
    logOpFn: () => {},
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const tenantId = Number(req.get("x-test-tenant") || 1);
    const userId = ensureIdentity(tenantId, "boss");
    runWithTenant(tenantId, () => {
      req.user = {
        id: userId,
        name: `${tenantId}号专项老板`,
        role: "boss",
        tenant_id: tenantId,
      };
      req.requestSignal = new AbortController().signal;
      req.aiGuard = { defer: () => () => {} };
      next();
    });
  });
  app.use("/employee-workbench/content", requiredRouter);
  const server = app.listen(0, "127.0.0.1");
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    for (const [offset, idx] of [0, 1, 2].entries()) {
      const tenant = 750 + offset;
      setManagerReviewPolicy(tenant);
      const { response, payload } = await jsonCall(
        `http://127.0.0.1:${port}`,
        `/employee-workbench/content/${idx}/dispatch`,
        {
          method: "POST",
          tenant,
          body: {
            title: `必需联网无证据关闭-${idx}`,
            type: "岗位交付",
            requirement: "请根据本次专项任务完成必须联网的事实研究。",
          },
        },
      );
      assert.equal(response.status, 502, `${idx}: ${JSON.stringify(payload)}`);
      assert.equal(payload.status, "失败");
      assert.equal(
        failedScheduled.length,
        0,
        `employee ${idx} must not be scheduled`,
      );
      const failed = storedSnapshot(tenant, payload.runId);
      assert.equal(failed.row.status, "失败");
      assert.equal(failed.snapshot.web.required, true);
      assert.equal(failed.snapshot.web.triggered, true);
      assert.equal(failed.snapshot.web.attempted, true);
      assert.equal(failed.snapshot.web.verified, false);
      assert.equal(
        failed.snapshot.web.queryPlan.agenticCandidateGatePassed,
        false,
      );
      assert.equal(failed.snapshot.web.queryPlan.observedToolAttempts, 4);
      const controlledChannel = failed.snapshot.web.channels.find(
        (channel) => channel.kind === "controlled_web_fetch",
      );
      assert.equal(controlledChannel.attempted, false);
      assert.equal(controlledChannel.evidence.externalCall, false);
      assert.equal(controlledChannel.evidence.requested, 0);
      assert.equal(failed.snapshot.billing.state, "released");
    }
    assert.equal(failedAgenticCalls.length, 3);
    assert.equal(failedControlledCalls.length, 0);
    assert.equal(failedLegacySnippetCalls.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

after(() => {
  for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* best effort */
    }
  }
});

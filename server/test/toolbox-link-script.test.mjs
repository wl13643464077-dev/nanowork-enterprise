import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const DBP = path.join(
  os.tmpdir(),
  `nanowork-toolbox-link-script-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"]) {
  fs.rmSync(`${DBP}${suffix}`, { force: true });
}
process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = "test";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";

const { db, initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { hashPassword } = await import("../src/util.js");
const {
  TOOL_DEFINITIONS,
  assertLinkScriptPublicUrl,
  collectLinkScriptSourceEvidence,
  generateToolboxRun,
  normalizeLinkScriptUrl,
} = await import("../src/engines/toolbox.js");
const toolboxRoutes = (await import("../src/routes/toolbox.js")).default;
const taskCenterRoutes = (await import("../src/routes/task-center.js")).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();
q.run("UPDATE tenants SET credits=100000 WHERE id=1");
const ownerId = Number(
  q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?,?,?,?,?,1)`,
    "toolbox-link-owner",
    hashPassword("Secret123!"),
    "链接工具老板",
    "boss",
    "启用",
  ).lastInsertRowid,
);
const owner = {
  id: ownerId,
  name: "链接工具老板",
  role: "boss",
  tenant_id: 1,
};

const VALID_INPUTS = {
  url: "https://www.douyin.com/video/123456",
  duration: 30,
  style: "真实克制、少用营销腔",
  persona: "做了十年餐饮的店主，说话直接",
  goal: "让附近顾客理解产品适用场景并愿意留言",
};
const SOURCE_TEXT =
  "这段公开内容讲的是餐饮老板如何先核对当天食材、可售数量和顾客真正关心的问题，再用现场过程解释产品差异。原文强调不要虚构最低价、销量或顾客评价，发布前要确认价格、库存、过敏原和素材授权，并在发布后记录真实咨询与到店反馈。";
const STRUCTURED_OUTPUT = {
  hook: "别急着把产品夸上天，顾客真正想听的是这三件实在事。",
  script:
    "做餐饮这些年，我越来越确定，内容不是把话说满。先把当天食材和可售数量核对清楚，再拍真实制作过程，把顾客最关心的选择场景讲明白。价格、库存和过敏原都以当天确认的信息为准，也别拿未经授权的顾客画面做证明。发布以后，我们只看真实咨询和到店反馈，再决定下一条怎么改。",
  core_points: [
    "发布前核对食材、可售数量、价格与过敏原",
    "用真实制作过程说明产品差异，不虚构销量和评价",
    "发布后记录真实咨询与到店反馈",
  ],
  cta: "你最想先了解哪一项？留言告诉我，我们核实后认真回复。",
};

function apiResult(overrides = {}) {
  return {
    mode: "api",
    model: "gpt-5.5",
    usage: { inputTokens: 260, outputTokens: 140 },
    text: JSON.stringify(STRUCTURED_OUTPUT),
    ...overrides,
  };
}

test("链接静态校验与DNS公网门在任何计费动作前 fail-closed", async () => {
  assert.equal(
    normalizeLinkScriptUrl(
      "复制这条分享 https://www.douyin.com/video/123456?from=share 。",
    ),
    "https://www.douyin.com/video/123456?from=share",
  );
  for (const unsafe of [
    "http://127.0.0.1/admin",
    "http://[::1]/admin",
    "http://localhost/admin",
    "https://user:pass@example.com/article",
    "https://example.com/article?access_token=secret",
    "https://example.com/%E0%A4%A",
    "https://example.com:8443/article",
  ]) {
    assert.throws(() => normalizeLinkScriptUrl(unsafe));
  }
  assert.equal(
    await assertLinkScriptPublicUrl("https://example.com/article", {
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
    }),
    "https://example.com/article",
  );
  await assert.rejects(
    assertLinkScriptPublicUrl("https://internal.example/article", {
      lookupFn: async () => [{ address: "10.10.0.8", family: 4 }],
    }),
    /未解析到纯公网地址/u,
  );
});

test("公开视频ASR成功后直接生成结构化口播，不再抓页面或搜索", async () => {
  let pageCalls = 0;
  let researchCalls = 0;
  const result = await generateToolboxRun(
    TOOL_DEFINITIONS["link-script"],
    VALID_INPUTS,
    {
      aiAvailableFn: () => true,
      transcribeLinkFn: async (url) => ({
        title: "公开视频转录",
        text: SOURCE_TEXT,
        url,
      }),
      fetchPublicPageEvidenceFn: async () => {
        pageCalls += 1;
        throw new Error("ASR成功后不应抓页面");
      },
      agenticWebResearchFn: async () => {
        researchCalls += 1;
        throw new Error("ASR成功后不应搜索");
      },
      generateFn: async () => apiResult(),
    },
  );
  assert.equal(pageCalls, 0);
  assert.equal(researchCalls, 0);
  assert.equal(result.provenance.mode, "api");
  assert.equal(result.provenance.inputModality, "url");
  assert.equal(
    result.provenance.publicResearch.acquisitionMode,
    "link_asr_transcript",
  );
  assert.equal(result.provenance.publicResearch.originalUrl, VALID_INPUTS.url);
  assert.equal(result.provenance.publicResearch.sources[0].bodyVerified, true);
  assert.match(
    result.provenance.publicResearch.sources[0].snapshotHash,
    /^[a-f0-9]{64}$/u,
  );
  assert.deepEqual(result.provenance.structuredOutput, STRUCTURED_OUTPUT);
  assert.deepEqual(result.provenance.usage, {
    inputTokens: 260,
    outputTokens: 140,
  });
  assert.match(result.resultMd, /开头3秒钩子/u);
  assert.match(result.resultMd, /完整口播稿/u);
});

test("ASR失败回退安全页面；页面不足才允许隔离搜索后受控取证", async () => {
  let researchCalls = 0;
  const direct = await collectLinkScriptSourceEvidence(VALID_INPUTS, {
    transcribeLinkFn: async () => {
      throw Object.assign(new Error("ASR不可用"), { code: "ASR_UNAVAILABLE" });
    },
    fetchPublicPageEvidenceFn: async (url) => ({
      title: "公开文章正文",
      url,
      body: SOURCE_TEXT,
    }),
    agenticWebResearchFn: async () => {
      researchCalls += 1;
      throw new Error("页面正文充足时不应搜索");
    },
  });
  assert.equal(researchCalls, 0);
  assert.equal(direct.snapshot.acquisitionMode, "controlled_web_page");
  assert.equal(direct.snapshot.asr.failureCode, "ASR_UNAVAILABLE");

  const searched = await collectLinkScriptSourceEvidence(VALID_INPUTS, {
    transcribeLinkFn: async () => "",
    fetchPublicPageEvidenceFn: async () => ({
      title: "只有标题",
      url: VALID_INPUTS.url,
      body: "太短",
    }),
    agenticWebResearchFn: async () => ({
      candidateReady: true,
      provider: "offline-agentic-search",
      fetchCandidates: [
        {
          title: "同一内容公开转载",
          url: "https://example.com/public-copy",
          snippet: "只作为候选",
        },
      ],
      evidence: { externalCall: false, toolCalls: 1 },
    }),
    controlledWebFetchFn: async (candidates) => ({
      attempted: true,
      results: candidates.map((item) => ({
        ...item,
        body: SOURCE_TEXT,
      })),
      evidence: { failures: [], ssrfProtected: true },
    }),
  });
  assert.equal(searched.snapshot.acquisitionMode, "controlled_search_page");
  assert.equal(searched.snapshot.search.status, "verified");
  assert.equal(
    searched.snapshot.sources[0].url,
    "https://example.com/public-copy",
  );
});

test("无正文时不调用模型；模型非API或缺usage时保留来源快照并失败", async () => {
  let modelCalls = 0;
  await assert.rejects(
    generateToolboxRun(TOOL_DEFINITIONS["link-script"], VALID_INPUTS, {
      aiAvailableFn: () => true,
      transcribeLinkFn: async () => "",
      fetchPublicPageEvidenceFn: async () => {
        throw Object.assign(new Error("正文为空"), {
          code: "CONTROLLED_WEB_BODY_EMPTY",
        });
      },
      agenticWebResearchFn: async () => ({
        candidateReady: false,
        results: [],
        evidence: { externalCall: false },
      }),
      generateFn: async () => {
        modelCalls += 1;
        return apiResult();
      },
    }),
    (error) =>
      error?.code === "TOOLBOX_LINK_SOURCE_EMPTY" &&
      error?.researchEvidence?.originalUrl === VALID_INPUTS.url,
  );
  assert.equal(modelCalls, 0);

  await assert.rejects(
    generateToolboxRun(TOOL_DEFINITIONS["link-script"], VALID_INPUTS, {
      aiAvailableFn: () => true,
      transcribeLinkFn: async () => ({ text: SOURCE_TEXT }),
      generateFn: async () => ({
        mode: "template",
        model: "template",
        usage: { inputTokens: 0, outputTokens: 0 },
        text: "本地替代稿",
      }),
    }),
    (error) =>
      error?.code === "TOOLBOX_LINK_PROVIDER_NO_DELIVERY" &&
      error?.providerEvidence?.attempts?.length === 2 &&
      error?.researchEvidence?.sources?.length === 1,
  );
});

function appFor(state) {
  const app = express();
  app.locals.toolboxAiAvailable = () => true;
  app.locals.toolboxLinkLookup = async () => [
    { address: state.privateDns ? "10.20.0.9" : "93.184.216.34", family: 4 },
  ];
  app.locals.toolboxTranscribeLink = async () => {
    throw Object.assign(new Error("离线ASR不可用，验证页面回退"), {
      code: "OFFLINE_ASR_UNAVAILABLE",
    });
  };
  app.locals.toolboxFetchPublicPageEvidence = async (url) => ({
    title: "离线公开正文",
    url,
    body: SOURCE_TEXT,
  });
  app.locals.toolboxGenerate = async () =>
    state.providerFails
      ? {
          mode: "template",
          model: "template",
          usage: { inputTokens: 0, outputTokens: 0 },
          text: "本地底稿禁止交付",
        }
      : apiResult();
  app.use(express.json({ limit: "64kb" }));
  app.use((req, _res, next) =>
    runWithTenant(owner.tenant_id, () => {
      req.user = owner;
      next();
    }),
  );
  app.use("/toolbox", toolboxRoutes);
  app.use("/task-center", taskCenterRoutes);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code || null,
    }),
  );
  return app;
}

async function withServer(state, fn) {
  const server = appFor(state).listen(0, "127.0.0.1");
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(base, url, method = "GET", body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

async function waitForRun(base, id) {
  const deadline = Date.now() + 10_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await request(base, `/toolbox/runs/${id}`);
    if (["done", "failed"].includes(last.body?.run?.status))
      return last.body.run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`链接工具任务未完成：${JSON.stringify(last?.body || {})}`);
}

function routePayload(title, url = VALID_INPUTS.url) {
  return {
    toolKey: "link-script",
    employeeIdx: 140,
    title,
    inputs: { ...VALID_INPUTS, url },
  };
}

function creditHoldCount() {
  const exists = q.get(
    "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='credit_holds'",
  );
  return exists
    ? q.get("SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=1").n
    : 0;
}

test("路由在hold前拒绝SSRF；成功任务202轮询、usage结算、TaskCenter与免费retry完整闭环", async () => {
  const state = { privateDns: true, providerFails: false };
  await withServer(state, async (base) => {
    const runsBefore = q.get(
      "SELECT COUNT(*) n FROM tool_runs WHERE tenant_id=1",
    ).n;
    const holdsBefore = creditHoldCount();
    const blocked = await request(
      base,
      "/toolbox/runs",
      "POST",
      routePayload("DNS内网应在计费前拒绝", "https://internal.example/article"),
    );
    assert.equal(blocked.status, 400, JSON.stringify(blocked.body));
    assert.equal(
      q.get("SELECT COUNT(*) n FROM tool_runs WHERE tenant_id=1").n,
      runsBefore,
    );
    assert.equal(creditHoldCount(), holdsBefore);

    state.privateDns = false;
    const creditsBeforeSuccess = q.get(
      "SELECT credits FROM tenants WHERE id=1",
    ).credits;
    const queued = await request(
      base,
      "/toolbox/runs",
      "POST",
      routePayload("公开链接口播成功交付"),
    );
    assert.equal(queued.status, 202, JSON.stringify(queued.body));
    assert.equal(queued.body.queued, true);
    assert.equal(
      queued.body.deepLink,
      `/tasks?kind=tool&id=${queued.body.run.id}`,
    );
    const completed = await waitForRun(base, queued.body.run.id);
    assert.equal(completed.status, "done", JSON.stringify(completed));
    assert.equal(completed.canUse, true);
    assert.equal(completed.provenance.billing.state, "settled");
    assert.deepEqual(completed.provenance.usage, {
      inputTokens: 260,
      outputTokens: 140,
    });
    assert.equal(
      completed.provenance.publicResearch.originalUrl,
      VALID_INPUTS.url,
    );
    assert.equal(completed.evidence[0].bodyVerified, true);
    assert.match(completed.evidence[0].snapshotHash, /^[a-f0-9]{64}$/u);
    assert.ok(
      q.get("SELECT credits FROM tenants WHERE id=1").credits <
        creditsBeforeSuccess,
    );

    const taskDetail = await request(base, `/task-center/tool/${completed.id}`);
    assert.equal(taskDetail.status, 200, JSON.stringify(taskDetail.body));
    assert.equal(taskDetail.body.sourceKey, `tool:${completed.id}`);
    assert.match(taskDetail.body.output, /完整口播稿/u);
    assert.equal(
      taskDetail.body.tool.publicResearch.originalUrl,
      VALID_INPUTS.url,
    );

    state.providerFails = true;
    const creditsBeforeFailure = q.get(
      "SELECT credits FROM tenants WHERE id=1",
    ).credits;
    const failedQueued = await request(
      base,
      "/toolbox/runs",
      "POST",
      routePayload("模型失败后免费重试"),
    );
    assert.equal(failedQueued.status, 202, JSON.stringify(failedQueued.body));
    const failed = await waitForRun(base, failedQueued.body.run.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.canUse, false);
    assert.equal(failed.provenance.billing.state, "released");
    assert.equal(failed.retryable, true);
    assert.equal(
      q.get("SELECT credits FROM tenants WHERE id=1").credits,
      creditsBeforeFailure,
    );
    const failedHold = q.get(
      `SELECT status,settled_credits FROM credit_holds
      WHERE tenant_id=1 AND ref_type='tool_run' AND ref_id=? ORDER BY id DESC LIMIT 1`,
      failed.id,
    );
    assert.equal(failedHold.status, "settled");
    assert.equal(failedHold.settled_credits, 0);

    state.providerFails = false;
    const retry = await request(
      base,
      `/toolbox/runs/${failed.id}/retry`,
      "POST",
      {},
    );
    assert.equal(retry.status, 202, JSON.stringify(retry.body));
    assert.equal(retry.body.freeRetry, true);
    const retried = await waitForRun(base, failed.id);
    assert.equal(retried.status, "done", JSON.stringify(retried));
    assert.equal(retried.retryCount, 1);
    assert.equal(retried.canUse, true);
    assert.equal(retried.provenance.billing.state, "settled");
    assert.equal(
      retried.provenance.publicResearch.originalUrl,
      VALID_INPUTS.url,
    );
  });
});

test("旧库与新库CHECK均接受link-script并继续拒绝未知工具键", () => {
  const runSql = q.get(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_runs'",
  ).sql;
  const eventSql = q.get(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_run_events'",
  ).sql;
  assert.match(runSql, /'link-script'/u);
  assert.match(eventSql, /'link-script'/u);
  assert.throws(
    () =>
      q.run(
        `INSERT INTO tool_runs(
          tool_key,tool_title,title,status,employee_idx,employee_name,created_by,
          input_json,input_summary,result_md,provenance_json,execution_state
        ) VALUES('unknown-tool','未知工具','CHECK拒绝未知工具','failed',140,'章文案',?,
          '{}','测试','','{}','failed')`,
        ownerId,
      ),
    /CHECK constraint failed/u,
  );
});

after(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${DBP}${suffix}`, { force: true });
  }
});

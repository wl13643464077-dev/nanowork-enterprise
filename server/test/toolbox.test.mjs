import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import express from "express";

const DBP = path.join(os.tmpdir(), `nanowork-toolbox-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = "test";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";

const { db, initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { hashPassword } = await import("../src/util.js");
const { estimateCallCredits, holdCredits, releaseHold, settleHold } =
  await import("../src/engines/credits.js");
const { textModelFor } = await import("../src/engines/yunwu.js");
const {
  TOOLBOX_AI_MAX_ATTEMPTS,
  TOOLBOX_AI_RETRY_INSTRUCTION,
  TOOL_DEFINITIONS,
  generateToolboxRun,
} = await import("../src/engines/toolbox.js");
const toolboxRoutes = (await import("../src/routes/toolbox.js")).default;
const taskCenterRoutes = (await import("../src/routes/task-center.js")).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();

q.run(`INSERT INTO tenants(id,name,status) VALUES(2,'工具箱租户二','已开通')
  ON CONFLICT(id) DO UPDATE SET status=excluded.status`);
const userOneId = q.run(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`,
  "toolbox-one",
  hashPassword("Secret123!"),
  "租户一老板",
  "boss",
  "启用",
  1,
).lastInsertRowid;
const userTwoId = q.run(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`,
  "toolbox-two",
  hashPassword("Secret123!"),
  "租户二老板",
  "boss",
  "启用",
  2,
).lastInsertRowid;
const userPeerId = q.run(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`,
  "toolbox-peer",
  hashPassword("Secret123!"),
  "租户一销售",
  "sales",
  "启用",
  1,
).lastInsertRowid;
const userOpsId = q.run(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`,
  "toolbox-ops",
  hashPassword("Secret123!"),
  "租户一运营负责人",
  "ops_director",
  "启用",
  1,
).lastInsertRowid;
const userManagerId = q.run(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id,manager_id)
  VALUES(?,?,?,?,?,?,?)`,
  "toolbox-manager",
  hashPassword("Secret123!"),
  "租户一直属经理",
  "manager",
  "启用",
  1,
  userOpsId,
).lastInsertRowid;
const userSubordinateId = q.run(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id,manager_id)
  VALUES(?,?,?,?,?,?,?)`,
  "toolbox-subordinate",
  hashPassword("Secret123!"),
  "租户一下属员工",
  "sales",
  "启用",
  1,
  userManagerId,
).lastInsertRowid;
const userOutsideId = q.run(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`,
  "toolbox-outside",
  hashPassword("Secret123!"),
  "租户一链外员工",
  "sales",
  "启用",
  1,
).lastInsertRowid;
const userOne = {
  id: Number(userOneId),
  name: "租户一老板",
  role: "boss",
  tenant_id: 1,
};
const userTwo = {
  id: Number(userTwoId),
  name: "租户二老板",
  role: "boss",
  tenant_id: 2,
};
const userPeer = {
  id: Number(userPeerId),
  name: "租户一销售",
  role: "sales",
  tenant_id: 1,
};
const userOps = {
  id: Number(userOpsId),
  name: "租户一运营负责人",
  role: "ops_director",
  tenant_id: 1,
};
const userManager = {
  id: Number(userManagerId),
  name: "租户一直属经理",
  role: "manager",
  tenant_id: 1,
};
const userSubordinate = {
  id: Number(userSubordinateId),
  name: "租户一下属员工",
  role: "sales",
  tenant_id: 1,
};
const userOutside = {
  id: Number(userOutsideId),
  name: "租户一链外员工",
  role: "sales",
  tenant_id: 1,
};

function appFor(user, options = {}) {
  const app = express();
  // Offline golden fixtures for the Paihuo-style agentic -> controlled
  // evidence chain.  These are injected loopback results; no external
  // network is touched by this test file.
  app.locals.employeeAgenticWebResearch = async (query) => ({
    attempted: true,
    ok: true,
    candidateReady: true,
    provider: "toolbox-loopback-agentic-search",
    fetchCandidates: Array.from({ length: 5 }, (_, index) => ({
      title: `餐饮公开验收来源${index + 1}`,
      url: `https://www.dianping.com/shop/nanowork-toolbox-${index + 1}`,
      snippet: `菜单、营业、价格、评价公开正文候选：${String(query).slice(0, 100)}`,
    })),
    evidence: {
      schemaVersion: "nanowork.agentic-web-research/1",
      externalCall: false,
      toolCalls: 1,
    },
  });
  app.locals.employeeControlledWebFetch = async (candidates) => ({
    attempted: true,
    ok: true,
    provider: "toolbox-loopback-controlled-fetch",
    results: (Array.isArray(candidates) ? candidates : []).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet || "餐饮公开正文受控核验",
      body: `受控网页正文证据：${item.title}。菜单、菜品、营业时间、价格、人均、评价与门店状态均来自本次离线夹具，不能外推真实经营结果。来源任务输入仅用于测试工具研究链。`,
    })),
    evidence: {
      schemaVersion: "nanowork.controlled-web-evidence/1",
      externalCall: false,
      ssrfProtected: true,
    },
  });
  if (typeof options.toolboxMediaAvailable === "function") {
    app.locals.toolboxMediaAvailable = options.toolboxMediaAvailable;
  }
  if (typeof options.toolboxVisionAvailable === "function") {
    app.locals.toolboxVisionAvailable = options.toolboxVisionAvailable;
  }
  if (typeof options.toolboxVisionChat === "function") {
    app.locals.toolboxVisionChat = options.toolboxVisionChat;
  }
  if (typeof options.toolboxGenerateImage === "function") {
    app.locals.toolboxGenerateImage = options.toolboxGenerateImage;
  }
  if (typeof options.toolboxGenerateVideo === "function") {
    app.locals.toolboxGenerateVideo = options.toolboxGenerateVideo;
  }
  if (typeof options.toolboxFetchVideoTask === "function") {
    app.locals.toolboxFetchVideoTask = options.toolboxFetchVideoTask;
  }
  if (options.toolboxVideoPollMs !== undefined)
    app.locals.toolboxVideoPollMs = options.toolboxVideoPollMs;
  if (options.toolboxVideoPollLimit !== undefined)
    app.locals.toolboxVideoPollLimit = options.toolboxVideoPollLimit;
  app.use(express.json({ limit: "64kb" }));
  app.use((req, _res, next) =>
    runWithTenant(user.tenant_id, () => {
      req.user = user;
      next();
    }),
  );
  app.use("/toolbox", toolboxRoutes);
  app.use("/api/task-center", taskCenterRoutes);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  return app;
}

async function withServer(user, fn, options = {}) {
  const server = appFor(user, options).listen(0, "127.0.0.1");
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
  const response = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json().catch(() => ({})) };
}

// Toolbox POST now enqueues a background worker and returns 202.  Tests must
// observe the same contract as TaskCenter: poll the run detail until the
// persisted status is terminal, then assert the settled/released evidence.
async function waitForToolRun(
  base,
  runId,
  { timeoutMs = 10_000, intervalMs = 25 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await request(base, `/toolbox/runs/${runId}`);
    const run = last.body?.run;
    if (
      last.response.status === 200 &&
      ["done", "failed"].includes(run?.status)
    ) {
      return {
        ...last,
        body: {
          ...last.body,
          // Preserve the old assertion surface while making the source of
          // truth the terminal run's persisted provenance billing snapshot.
          billing: run.provenance?.billing || last.body.billing,
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `工具后台任务未在${timeoutMs}ms内完成：${JSON.stringify(last?.body || {})}`,
  );
}

async function enqueueAndWait(base, body, options) {
  const queued = await request(base, "/toolbox/runs", "POST", body);
  assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
  return waitForToolRun(base, queued.body.run.id, options);
}

function cleanupToolboxRuns(runIds) {
  const ids = [
    ...new Set(
      runIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0),
    ),
  ];
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  runWithTenant(1, () => {
    // These are isolated dynamic fixtures; remove their audit rows and
    // matching billing rows so later tests retain their own tenant counts.
    q.run(
      `DELETE FROM credit_logs WHERE id IN (
      SELECT log_id FROM credit_holds WHERE tenant_id=1 AND ref_type='tool_run' AND ref_id IN (${placeholders})
    )`,
      ...ids,
    );
    q.run(
      `DELETE FROM credit_holds WHERE tenant_id=1 AND ref_type='tool_run' AND ref_id IN (${placeholders})`,
      ...ids,
    );
    q.run(
      `DELETE FROM tool_run_events WHERE tenant_id=1 AND run_id IN (${placeholders})`,
      ...ids,
    );
    q.run(
      `DELETE FROM tool_runs WHERE tenant_id=1 AND id IN (${placeholders})`,
      ...ids,
    );
  });
}

const VALID_PAYLOADS = {
  hot: {
    employeeIdx: 141,
    inputs: {
      store: "太原万象城川味小馆",
      channels: ["朋友圈", "视频号"],
      focus: "提升工作日晚市到店，不做虚假限量",
    },
  },
  remix: {
    employeeIdx: 140,
    inputs: {
      materials: "后厨出锅3段、门头夜景1段，每段约5秒",
      platform: "视频号",
      goal: "让附近顾客了解招牌菜",
    },
  },
  pcal: {
    employeeIdx: 141,
    inputs: {
      month: "2026-08",
      channels: ["朋友圈", "社群"],
      focus: "新菜单上线与老会员回店",
    },
  },
  bench: {
    employeeIdx: 102,
    inputs: {
      targets: "对标门店A / 公开页面\n对标门店B / 地址",
      period: "近7天",
      focus: "套餐与晚市活动",
    },
  },
  warm: {
    employeeIdx: 142,
    inputs: {
      platform: "视频号",
      positioning: "社区型云南米线，午餐为主",
      persona: "认真研究汤底的店主",
      goal: "验证3个稳定选题方向",
    },
  },
  leads: {
    employeeIdx: 143,
    inputs: {
      city: "太原长风街3公里",
      product: "粤菜家庭聚餐",
      audience: "周末家庭聚餐",
      constraints: "只使用公开信号并由人工核验",
    },
  },
  shot: {
    employeeIdx: 140,
    inputs: {
      product: "双人酸汤鱼套餐",
      facts: "门店称重记录与当天食材可供负责人核验",
      channels: ["朋友圈", "门店桌卡"],
    },
  },
  vars: {
    employeeIdx: 140,
    inputs: {
      script:
        "我们每天先核对当天食材和可售数量，再向顾客说明真实情况，具体价格请到店确认。",
      variants: 4,
      platform: "视频号",
    },
  },
};

const VALID_HOT_AI_RESULT = `# 真实工具交付

## 今日内容安排

门店锚点为太原万象城川味小馆，围绕工作日晚市到店准备三条内容，不新增优惠或库存事实。

1. 选题一：拍摄门头与晚市准备过程，发布前核验当天营业和接待能力。
2. 选题二：拍摄真实出品细节，用现场素材说明顾客可核验的信息。
3. 选题三：由员工回答一个高频问题，在朋友圈或视频号发布并记录真实咨询。

## 素材与审核

- 素材包括门头、出品过程和真实环境，人物画面必须取得授权。
- 负责人审核价格、可售、营业时间与渠道文案后再发布。
- 24小时后复盘曝光、咨询和到店反馈，不把自然波动写成确定效果。

## 执行责任表

| 负责人 | 时点 | 具体动作 | 可核验产出 |
|---|---|---|---|
| 运营负责人 | 今日10:00 | 核验当天可售信息并记录 | 核验清单与现场截图 |
| 拍摄员工 | 今日14:00 | 拍摄门头与真实出品画面 | 三组授权素材文件 |
| 审核主管 | 发布前 | 审核文案并记录修改意见 | 审核记录与最终文案 |`;

const EMPTY_SHELL_HOT_AI_RESULT = `# 今日必发占位方案

## 今日内容安排

门店为太原万象城川味小馆，关键词包括选题、内容、发布、素材、镜头、画面、核验、审核和确认。

1. 选题一：认真思考，具体内容以后再说。
2. 选题二：持续优化，暂时没有明确动作。
3. 选题三：加强管理，后续再补具体口径。

## 素材与审核

以上文字只是占位内容，暂无负责人、暂无时间、暂无明细，也没有可核验产出；后续做好工作并提升水平。

## 执行责任表

| 负责人 | 时点 | 具体动作 | 可核验产出 |
|---|---|---|---|
| 无负责人 | 无时间 | 认真思考并持续优化 | 无明细 |
| 暂无负责人 | 暂无时点 | 加强管理并做好工作 | 暂无口径 |
| 没有责任人 | 具体以后再说 | 持续优化并提升水平 | 占位文本 |`;

const STRUCTURED_SHELL_HOT_AI_RESULT = `# 今日必发结构化方案

## 今日内容安排

门店是太原万象城川味小馆，围绕工作日晚市到店，通过朋友圈和视频号安排内容、发布、素材、镜头、画面、核验、审核和确认。

1. 选题一：门店内容方案一，按渠道安排内容并形成资料。
2. 选题二：门店内容方案二，由各岗位推进工作并形成资料。
3. 选题三：门店内容方案三，按安排完成并留下工作记录。

## 执行责任表

| 负责人 | 时点 | 具体动作 | 可核验产出 |
|---|---|---|---|
| 运营负责人 | 今日10:00 | 整理选题内容并记录 | 选题记录 |
| 文案员工 | 今日14:00 | 推进内容工作并记录 | 内容记录 |
| 审核主管 | 发布前 | 按安排完成审核工作 | 审核记录 |`;

function insertToolboxRunFixture({
  title,
  mode = "api",
  billingState = "settled",
  provenance = {},
  resultMd = `# ${title}\n\n## 今日内容安排\n\n门店锚点是太原万象城川味小馆，围绕工作日晚市到店设计三个选题。\n\n1. 选题一：发布前核验当天可售、价格与接待能力。\n2. 选题二：拍摄门头、真实出品过程和现场环境素材。\n3. 选题三：在朋友圈或视频号发布，记录真实咨询和到店反馈。\n\n## 素材与审核\n\n素材只使用已授权现场画面；负责人审核事实后再发布，不承诺未确认优惠、库存或经营效果。\n\n## 执行责任表\n\n| 负责人 | 时点 | 具体动作 | 可核验产出 |\n|---|---|---|---|\n| 运营负责人 | 今日10:00 | 核验当天可售信息并记录 | 核验清单与现场截图 |\n| 拍摄员工 | 今日14:00 | 拍摄门头与真实出品画面 | 三组授权素材文件 |\n| 审核主管 | 发布前 | 审核文案并记录修改意见 | 审核记录与最终文案 |`,
  authoritativeBilling = true,
}) {
  return runWithTenant(1, () => {
    const id = Number(
      q.run(
        `INSERT INTO tool_runs(
    tool_key,tool_title,title,status,employee_idx,employee_name,created_by,
    input_json,input_summary,result_md,provenance_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        "hot",
        "今日必发",
        title,
        "done",
        141,
        "云营销",
        userOne.id,
        JSON.stringify(VALID_PAYLOADS.hot.inputs),
        "用于验证工具箱交付状态",
        resultMd,
        JSON.stringify({
          mode,
          model: "gpt-5.5",
          usage: { inputTokens: 100, outputTokens: 50 },
          attempts: [
            {
              mode: "api",
              model: "gpt-5.5",
              outcome: "accepted",
              reason: "accepted",
              usage: { inputTokens: 100, outputTokens: 50 },
            },
          ],
          completionState: "completed",
          contract: {
            validator: "toolbox-delivery-contract",
            status: "valid",
            valid: true,
            errors: [],
          },
          persisted: true,
          internalProfileLeakage: {
            detected: false,
            status: "clear",
            outputHash: createHash("sha256")
              .update(resultMd, "utf8")
              .digest("hex"),
          },
          billing: {
            state: billingState,
            chargedCredits: billingState === "settled" ? 5 : null,
          },
          ...provenance,
        }),
      ).lastInsertRowid,
    );
    if (!authoritativeBilling) return id;
    const hold = holdCredits({
      userId: userOne.id,
      feature: "经营工具箱·今日必发",
      kind: "text",
      model: "gpt-5.5",
      credits: 5,
      refType: "tool_run",
      refId: id,
      note: "工具箱历史读取权威账务测试",
    });
    let chargedCredits = null;
    if (billingState === "settled") {
      chargedCredits = settleHold(hold, {
        usage: { inputTokens: 100, outputTokens: 50 },
        model: "gpt-5.5",
        aiMode: "api",
        credits: 5,
        note: "工具箱测试结算",
      }).credits;
    } else if (billingState === "released") {
      releaseHold(hold, "工具箱测试释放");
      chargedCredits = 0;
    }
    const stored = JSON.parse(
      q.get(
        "SELECT provenance_json FROM tool_runs WHERE tenant_id=1 AND id=?",
        id,
      ).provenance_json,
    );
    stored.billing = {
      state: billingState,
      holdId: Number(hold.holdId),
      logId: Number(hold.logId),
      requestedModel: "gpt-5.5",
      chargedCredits,
      pendingReconciliation: !["settled", "released"].includes(billingState),
    };
    q.run(
      "UPDATE tool_runs SET provenance_json=? WHERE tenant_id=1 AND id=?",
      JSON.stringify(stored),
      id,
    );
    return id;
  });
}

test("媒体工具 shot 通过注入的真实图片 handler 形成可预览 artifact（离线）", async () => {
  let captured;
  const result = await generateToolboxRun(
    TOOL_DEFINITIONS.shot,
    VALID_PAYLOADS.shot.inputs,
    {
      role: "boss",
      mediaAvailableFn: () => true,
      generateImageFn: async (args) => {
        captured = args;
        return {
          model: "offline-image-model",
          url: "https://cdn.example.test/nanowork-shot.png",
          mimeType: "image/png",
        };
      },
    },
  );
  assert.match(captured.prompt, /双人酸汤鱼套餐/u);
  assert.equal(captured.size, "1024x1024");
  assert.equal(captured.model, "gpt-image-2");
  assert.equal(result.provenance.mode, "api");
  assert.equal(result.provenance.executionKind, "image");
  assert.equal(result.provenance.mediaArtifact.kind, "image");
  assert.equal(result.provenance.mediaArtifact.status, "ready");
  assert.equal(result.provenance.mediaArtifact.mimeType, "image/png");
  assert.equal(
    result.provenance.mediaArtifact.url,
    "https://cdn.example.test/nanowork-shot.png",
  );
  assert.equal(result.provenance.mediaArtifact.model, "offline-image-model");
  assert.match(result.resultMd, /真实媒体交付/u);
  assert.match(
    result.resultMd,
    /https:\/\/cdn\.example\.test\/nanowork-shot\.png/u,
  );
  assert.equal(result.resultMd.includes("shotTemplate"), false);
});

test("媒体工具 remix 先创建视频任务再轮询至 ready artifact（离线）", async () => {
  const calls = [];
  const result = await generateToolboxRun(
    TOOL_DEFINITIONS.remix,
    VALID_PAYLOADS.remix.inputs,
    {
      role: "boss",
      mediaAvailableFn: () => true,
      videoPollMs: 10,
      videoPollLimit: 3,
      generateVideoFn: async (args) => {
        calls.push({ type: "create", args });
        return {
          taskId: "offline-video-task-1",
          status: "submitted",
          model: "offline-video-model",
        };
      },
      fetchVideoTaskFn: async (args) => {
        calls.push({ type: "poll", args });
        return calls.filter((item) => item.type === "poll").length === 1
          ? { taskId: args.taskId, status: "processing" }
          : {
              taskId: args.taskId,
              status: "completed",
              ready: true,
              url: "https://cdn.example.test/nanowork-remix.mp4",
              mimeType: "video/mp4",
              model: "offline-video-model",
            };
      },
    },
  );
  assert.equal(calls[0].type, "create");
  assert.equal(calls[0].args.model, "happyhorse-1.0-t2v:floor");
  assert.deepEqual(
    calls.slice(1).map((item) => item.type),
    ["poll", "poll"],
  );
  assert.deepEqual(
    calls.slice(1).map((item) => item.args.taskId),
    ["offline-video-task-1", "offline-video-task-1"],
  );
  assert.equal(result.provenance.mode, "api");
  assert.equal(result.provenance.executionKind, "video");
  assert.equal(result.provenance.mediaArtifact.kind, "video");
  assert.equal(result.provenance.mediaArtifact.status, "ready");
  assert.equal(result.provenance.mediaArtifact.mimeType, "video/mp4");
  assert.equal(
    result.provenance.mediaArtifact.url,
    "https://cdn.example.test/nanowork-remix.mp4",
  );
  assert.equal(
    result.provenance.mediaArtifact.providerTaskId,
    "offline-video-task-1",
  );
  assert.match(result.resultMd, /真实视频成片/u);
  assert.match(
    result.resultMd,
    /https:\/\/cdn\.example\.test\/nanowork-remix\.mp4/u,
  );
  assert.equal(result.resultMd.includes("remixTemplate"), false);
});

test("媒体工具路由返回202并在TaskCenter/Toolbox可用，图片视频按kind/model结算（离线）", async () => {
  q.run("UPDATE tenants SET credits=100000 WHERE id=?", 1);
  let videoPolls = 0;
  const mediaOptions = {
    toolboxMediaAvailable: () => true,
    toolboxGenerateImage: async () => ({
      model: "gpt-image-2",
      url: "https://cdn.example.test/route-shot.png",
      mimeType: "image/png",
    }),
    toolboxGenerateVideo: async () => ({
      taskId: "offline-route-video-task",
      status: "submitted",
      model: "happyhorse-1.0-t2v:floor",
    }),
    toolboxFetchVideoTask: async ({ taskId }) => {
      videoPolls += 1;
      return videoPolls === 1
        ? { taskId, status: "processing" }
        : {
            taskId,
            status: "completed",
            ready: true,
            url: "https://cdn.example.test/route-remix.mp4",
            mimeType: "video/mp4",
            model: "happyhorse-1.0-t2v:floor",
          };
    },
    toolboxVideoPollMs: 10,
    toolboxVideoPollLimit: 3,
  };
  const completed = {};
  const mediaRunIds = [];
  try {
    await withServer(
      userOne,
      async (base) => {
        for (const [toolKey, payload] of [
          ["shot", VALID_PAYLOADS.shot],
          ["remix", VALID_PAYLOADS.remix],
        ]) {
          const queued = await request(base, "/toolbox/runs", "POST", {
            toolKey,
            employeeIdx: payload.employeeIdx,
            title: `离线媒体${toolKey}`,
            inputs: payload.inputs,
          });
          mediaRunIds.push(queued.body.run.id);
          assert.equal(
            queued.response.status,
            202,
            JSON.stringify(queued.body),
          );
          assert.equal(queued.body.queued, true);
          assert.equal(queued.body.run.executionState, "queued");
          assert.equal(
            queued.body.run.provenance.executionKind,
            toolKey === "shot" ? "image" : "video",
          );
          assert.equal(
            queued.body.deepLink,
            `/tasks?kind=tool&id=${queued.body.run.id}`,
          );
          assert.equal(
            queued.body.pollUrl,
            `/toolbox/runs/${queued.body.run.id}`,
          );
          completed[toolKey] = await waitForToolRun(base, queued.body.run.id, {
            intervalMs: 10,
          });
          const run = completed[toolKey].body.run;
          assert.equal(completed[toolKey].response.status, 200);
          assert.equal(
            run.status,
            "done",
            JSON.stringify(completed[toolKey].body),
          );
          assert.equal(run.executionState, "done");
          assert.equal(run.verified, true);
          assert.equal(run.canUse, true);
          assert.equal(run.deepLink, `/tasks?kind=tool&id=${run.id}`);
          assert.equal(
            run.provenance.executionKind,
            toolKey === "shot" ? "image" : "video",
          );
          assert.equal(run.provenance.mediaArtifact.status, "ready");
          assert.match(
            run.provenance.mediaArtifact.url,
            /^https:\/\/cdn\.example\.test\//u,
          );
          assert.equal(run.provenance.billing.state, "settled");
          const hold = q.get(
            `SELECT * FROM credit_holds WHERE tenant_id=1 AND ref_type='tool_run' AND ref_id=?`,
            run.id,
          );
          assert.ok(hold, `${toolKey}必须创建媒体预授权`);
          assert.equal(hold.kind, toolKey === "shot" ? "image" : "video");
          assert.equal(hold.model, run.provenance.model);
          assert.equal(hold.status, "settled");
          assert.ok(Number(hold.settled_credits) > 0);

          const task = await request(base, `/api/task-center/tool/${run.id}`);
          assert.equal(task.response.status, 200, `${toolKey} TaskCenter`);
          assert.equal(task.body.kind, "tool");
          assert.equal(task.body.id, run.id);
          assert.equal(task.body.deepLink, `/tasks?kind=tool&id=${run.id}`);
          assert.equal(task.body.businessUsable, true);
          assert.equal(task.body.billing.state, "settled");
          assert.equal(
            task.body.output.includes(run.provenance.mediaArtifact.url),
            true,
          );
        }
      },
      mediaOptions,
    );
  } finally {
    cleanupToolboxRuns(mediaRunIds);
  }
  assert.equal(videoPolls, 2);
});

test("媒体供应商失败后台闭环全额退款且不产生artifact（离线）", async () => {
  q.run("UPDATE tenants SET credits=100000 WHERE id=?", 1);
  let providerCalls = 0;
  const failureRunIds = [];
  try {
    await withServer(
      userOne,
      async (base) => {
        const queued = await request(base, "/toolbox/runs", "POST", {
          toolKey: "shot",
          employeeIdx: 140,
          title: "离线媒体供应商失败",
          inputs: VALID_PAYLOADS.shot.inputs,
        });
        failureRunIds.push(queued.body.run.id);
        assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
        const terminal = await waitForToolRun(base, queued.body.run.id, {
          intervalMs: 10,
        });
        assert.equal(terminal.response.status, 200);
        assert.equal(terminal.body.run.status, "failed");
        assert.equal(terminal.body.run.executionState, "failed");
        assert.equal(terminal.body.run.verified, false);
        assert.equal(terminal.body.run.canUse, false);
        assert.equal(terminal.body.run.resultMd, "");
        assert.equal(terminal.body.run.provenance.mediaArtifact, undefined);
        assert.equal(
          terminal.body.run.error.code,
          "TOOLBOX_MEDIA_PROVIDER_NO_DELIVERY",
        );
        assert.equal(terminal.body.run.provenance.billing.state, "released");
        assert.equal(terminal.body.run.provenance.billing.chargedCredits, 0);
        const hold = q.get(
          `SELECT * FROM credit_holds WHERE tenant_id=1 AND ref_type='tool_run' AND ref_id=?`,
          queued.body.run.id,
        );
        assert.equal(hold.kind, "image");
        assert.equal(hold.status, "settled");
        assert.equal(Number(hold.settled_credits), 0);
        const task = await request(
          base,
          `/api/task-center/tool/${queued.body.run.id}`,
        );
        assert.equal(task.response.status, 200);
        assert.equal(task.body.businessUsable, false);
        assert.equal(task.body.billing.state, "released");
      },
      {
        toolboxMediaAvailable: () => true,
        toolboxGenerateImage: async () => {
          providerCalls += 1;
          throw Object.assign(
            new Error("offline image provider returned no artifact"),
            {
              status: 502,
              code: "TOOLBOX_MEDIA_PROVIDER_NO_DELIVERY",
            },
          );
        },
      },
    );
  } finally {
    cleanupToolboxRuns(failureRunIds);
  }
  assert.equal(providerCalls, 1, "仅调用一次离线图片供应商，不触发外网");
});

const MENU_COPY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const MENU_COPY_STRUCTURED = {
  item: "酸汤鱼",
  selling_point: "酸香汤底包裹嫩滑鱼片，一口开胃",
  desc: "酸香汤底配上嫩滑鱼片，适合与亲友分享。图片可见内容仅供选择参考，具体配料、份量和当天可售状态请向门店核验。",
  xhs: "这一口酸香把食欲叫醒，开吃前先向门店确认当天菜品信息。",
  price_note:
    "建议结合当天份量与门店菜单说明售价，具体价格以门店实时公示为准。",
};

function cleanupMenuCopyImage(fileId) {
  if (!fileId) return;
  runWithTenant(1, () => {
    const row = q.get(
      "SELECT file_path FROM uploaded_files WHERE tenant_id=1 AND id=?",
      fileId,
    );
    if (row?.file_path) {
      try {
        fs.rmSync(row.file_path, { force: true });
      } catch {}
    }
    q.run("DELETE FROM uploaded_files WHERE tenant_id=1 AND id=?", fileId);
  });
}

test("看图写卖点接受安全data URL，202后台交付五字段并且不持久化base64（离线）", async () => {
  q.run("UPDATE tenants SET credits=100000 WHERE id=?", 1);
  const runIds = [];
  let imageFileId = null;
  let captured = null;
  try {
    await withServer(
      userOne,
      async (base) => {
        const queued = await request(base, "/toolbox/runs", "POST", {
          toolKey: "menu-copy",
          employeeIdx: 140,
          title: "离线看图写卖点",
          inputs: {
            imageDataUrl: MENU_COPY_PNG_DATA_URL,
            want: "写外卖平台菜品描述，同时给出小红书文案",
          },
        });
        assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
        assert.equal(queued.body.queued, true);
        assert.equal(queued.body.run.executionState, "queued");
        assert.equal(queued.body.run.provenance.executionKind, "text");
        assert.equal(
          queued.body.deepLink,
          `/tasks?kind=tool&id=${queued.body.run.id}`,
        );
        runIds.push(queued.body.run.id);

        const terminal = await waitForToolRun(base, queued.body.run.id, {
          intervalMs: 10,
        });
        const run = terminal.body.run;
        assert.equal(run.status, "done", JSON.stringify(terminal.body));
        assert.equal(run.executionState, "done");
        assert.equal(run.canUse, true);
        assert.equal(run.verified, true);
        assert.equal(run.provenance.mode, "api");
        assert.equal(run.provenance.inputModality, "image");
        assert.deepEqual(run.provenance.structuredOutput, MENU_COPY_STRUCTURED);
        assert.equal(run.provenance.billing.state, "settled");
        assert.ok(Number(run.provenance.billing.chargedCredits) > 0);
        assert.ok(
          run.progress.some((item) => item.phase === "vision_provider"),
        );
        for (const value of Object.values(MENU_COPY_STRUCTURED)) {
          assert.equal(run.resultMd.includes(value), true);
        }
        assert.match(run.resultMd, /执行责任表/u);

        const stored = q.get(
          "SELECT input_json,progress_json,provenance_json,error_json FROM tool_runs WHERE tenant_id=1 AND id=?",
          run.id,
        );
        const storedInput = JSON.parse(stored.input_json);
        imageFileId = storedInput.imageFileId;
        assert.ok(Number.isInteger(imageFileId) && imageFileId > 0);
        assert.deepEqual(Object.keys(storedInput).sort(), [
          "imageFileId",
          "want",
        ]);
        const persisted = JSON.stringify(stored);
        assert.equal(persisted.includes("data:image/"), false);
        assert.equal(persisted.includes("iVBORw0KGgo"), false);

        assert.ok(captured);
        assert.equal(captured.model, "gemini-3.1-flash-lite");
        const imageBlock = captured.messages[0].content.find(
          (item) => item.type === "image_url",
        );
        assert.equal(imageBlock.image_url.url, MENU_COPY_PNG_DATA_URL);
        assert.match(
          captured.messages[0].content[0].text,
          /item.*selling_point.*price_note/u,
        );

        const hold = q.get(
          `SELECT * FROM credit_holds WHERE tenant_id=1 AND ref_type='tool_run' AND ref_id=?`,
          run.id,
        );
        assert.equal(hold.kind, "text");
        assert.equal(hold.model, "gemini-3.1-flash-lite");
        assert.equal(hold.status, "settled");
        assert.ok(Number(hold.settled_credits) > 0);
        const ledger = q.get(
          "SELECT * FROM credit_logs WHERE tenant_id=1 AND id=?",
          hold.log_id,
        );
        assert.ok(Number(ledger.input_tokens) > 0);
        assert.ok(Number(ledger.output_tokens) > 0);

        const task = await request(base, `/api/task-center/tool/${run.id}`);
        assert.equal(task.response.status, 200);
        assert.equal(task.body.businessUsable, true);
        assert.equal(task.body.deepLink, `/tasks?kind=tool&id=${run.id}`);
        assert.match(task.body.output, /看图写卖点/u);
      },
      {
        toolboxVisionAvailable: () => true,
        toolboxVisionChat: async (args) => {
          captured = args;
          return {
            mode: "api",
            model: "gemini-3.1-flash-lite",
            inputTokens: 240,
            outputTokens: 120,
            text: JSON.stringify(MENU_COPY_STRUCTURED),
          };
        },
      },
    );
  } finally {
    cleanupToolboxRuns(runIds);
    cleanupMenuCopyImage(imageFileId);
  }
});

test("看图写卖点不完整结果全额退回，同一文件ID可免费重试并成功结算（离线）", async () => {
  q.run("UPDATE tenants SET credits=100000 WHERE id=?", 1);
  const before = q.get("SELECT credits FROM tenants WHERE id=?", 1).credits;
  const runIds = [];
  let imageFileId = null;
  let providerCalls = 0;
  try {
    await withServer(
      userOne,
      async (base) => {
        const queued = await request(base, "/toolbox/runs", "POST", {
          toolKey: "menu-copy",
          employeeIdx: 140,
          title: "看图文案失败后重试",
          inputs: { imageDataUrl: MENU_COPY_PNG_DATA_URL, want: "写菜品卖点" },
        });
        assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
        runIds.push(queued.body.run.id);
        const failed = await waitForToolRun(base, queued.body.run.id, {
          intervalMs: 10,
        });
        assert.equal(failed.body.run.status, "failed");
        assert.equal(failed.body.run.resultMd, "");
        assert.equal(failed.body.run.canUse, false);
        assert.equal(
          failed.body.run.error.code,
          "TOOLBOX_VISION_INCOMPLETE_OUTPUT",
        );
        assert.equal(failed.body.run.provenance.billing.state, "released");
        assert.equal(failed.body.run.provenance.billing.chargedCredits, 0);
        imageFileId = JSON.parse(
          q.get(
            "SELECT input_json FROM tool_runs WHERE tenant_id=1 AND id=?",
            queued.body.run.id,
          ).input_json,
        ).imageFileId;
        assert.ok(imageFileId > 0);
        assert.equal(
          q.get("SELECT credits FROM tenants WHERE id=?", 1).credits,
          before,
        );

        const retry = await request(
          base,
          `/toolbox/runs/${queued.body.run.id}/retry`,
          "POST",
          {},
        );
        assert.equal(retry.response.status, 202, JSON.stringify(retry.body));
        assert.equal(retry.body.freeRetry, true);
        assert.equal(retry.body.run.retryCount, 1);
        const completed = await waitForToolRun(base, queued.body.run.id, {
          intervalMs: 10,
        });
        assert.equal(
          completed.body.run.status,
          "done",
          JSON.stringify(completed.body),
        );
        assert.equal(completed.body.run.canUse, true);
        assert.equal(completed.body.run.verified, true);
        assert.equal(completed.body.run.retryCount, 1);
        assert.equal(completed.body.run.provenance.billing.state, "settled");
        assert.deepEqual(
          completed.body.run.provenance.structuredOutput,
          MENU_COPY_STRUCTURED,
        );

        const holds = q.all(
          `SELECT * FROM credit_holds WHERE tenant_id=1 AND ref_type='tool_run' AND ref_id=? ORDER BY id`,
          queued.body.run.id,
        );
        assert.equal(holds.length, 2);
        assert.equal(Number(holds[0].settled_credits), 0);
        assert.ok(Number(holds[1].settled_credits) > 0);
        assert.ok(
          q.get("SELECT credits FROM tenants WHERE id=?", 1).credits < before,
          "只有成功重试轮次实扣",
        );
      },
      {
        toolboxVisionAvailable: () => true,
        toolboxVisionChat: async () => {
          providerCalls += 1;
          return {
            mode: "api",
            model: "gemini-3.1-flash-lite",
            inputTokens: 180,
            outputTokens: 90,
            text: JSON.stringify(
              providerCalls === 1 ? { item: "酸汤鱼" } : MENU_COPY_STRUCTURED,
            ),
          };
        },
      },
    );
  } finally {
    cleanupToolboxRuns(runIds);
    cleanupMenuCopyImage(imageFileId);
  }
  assert.equal(providerCalls, 2);
});

test("看图写卖点严格拒绝非图片data URL、超过8MB文件与无provider底稿（离线）", async () => {
  await assert.rejects(
    generateToolboxRun(
      TOOL_DEFINITIONS["menu-copy"],
      { imageFileId: 1, want: "写菜品卖点" },
      {
        visionAvailableFn: () => false,
        visionImageDataUrl: MENU_COPY_PNG_DATA_URL,
      },
    ),
    (error) =>
      error.code === "TOOLBOX_VISION_PROVIDER_UNAVAILABLE" &&
      /\u4e0d会生成本地底稿/u.test(error.message),
  );

  await withServer(userOne, async (base) => {
    const invalidMime = await request(base, "/toolbox/runs", "POST", {
      toolKey: "menu-copy",
      employeeIdx: 140,
      title: "不支持的图片",
      inputs: {
        imageDataUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==",
        want: "写卖点",
      },
    });
    assert.equal(invalidMime.response.status, 400);
    assert.match(invalidMime.body.error, /PNG.*JPEG.*WebP/u);

    const oversized = Number(
      q.run(
        `INSERT INTO uploaded_files(
      user_id,name,stored_name,ext,mime,size,purpose,file_path,file_url
    ) VALUES(?,?,?,?,?,?,?,?,?)`,
        userOne.id,
        "oversized.png",
        "oversized.png",
        "png",
        "image/png",
        8 * 1024 * 1024 + 1,
        "toolbox-menu-copy",
        "/missing/oversized.png",
        "/uploads/missing/oversized.png",
      ).lastInsertRowid,
    );
    try {
      const tooLarge = await request(base, "/toolbox/runs", "POST", {
        toolKey: "menu-copy",
        employeeIdx: 140,
        title: "超大图片",
        inputs: { imageFileId: oversized, want: "写卖点" },
      });
      assert.equal(tooLarge.response.status, 400);
      assert.match(tooLarge.body.error, /8MB/u);
    } finally {
      q.run("DELETE FROM uploaded_files WHERE tenant_id=1 AND id=?", oversized);
    }
  });
});

let tenantOneRunId;

test("8个通用文本工具键无AI时全部 fail-closed，不返回模板底稿也不产生费用", async () => {
  await withServer(userOne, async (base) => {
    for (const [toolKey, payload] of Object.entries(VALID_PAYLOADS)) {
      const result = await request(base, "/toolbox/runs", "POST", {
        toolKey,
        employeeIdx: payload.employeeIdx,
        title: `${toolKey}验收运行`,
        inputs: payload.inputs,
      });
      assert.equal(
        result.response.status,
        202,
        `${toolKey}: ${JSON.stringify(result.body)}`,
      );
      assert.equal(result.body.queued, true);
      assert.equal(result.body.run.executionState, "queued");
      await waitForToolRun(base, result.body.run.id);
    }

    const list = await request(base, "/toolbox/runs?limit=20");
    assert.equal(list.response.status, 200);
    assert.equal(list.body.runs.length, 8);
    assert.deepEqual(
      new Set(list.body.runs.map((item) => item.toolKey)),
      new Set(Object.keys(VALID_PAYLOADS)),
    );
    for (const [toolKey, payload] of Object.entries(VALID_PAYLOADS)) {
      const run = list.body.runs.find((item) => item.toolKey === toolKey);
      assert.ok(run, toolKey);
      assert.equal(run.employeeIdx, payload.employeeIdx);
      assert.equal(run.status, "failed");
      assert.equal(run.displayStatus, "失败需返工（质检未通过）");
      assert.equal(run.verified, false);
      assert.equal(run.canUse, false);
      assert.equal(run.provenance.mode, "template");
      assert.equal(run.provenance.completionState, "failed");
      assert.equal(run.resultMd, "", `${toolKey}失败任务不能返回模板底稿`);
      assert.ok(run.progress.some((item) => item.phase === "queued"));
      assert.ok(run.progress.some((item) => item.phase === "running"));
      assert.ok(run.progress.some((item) => item.phase === "failed"));
      tenantOneRunId ||= run.id;
    }
  });

  const persisted = db
    .prepare(`SELECT * FROM tool_runs WHERE tenant_id=1 AND id=?`)
    .get(tenantOneRunId);
  assert.equal(JSON.parse(persisted.input_json).store, "太原万象城川味小馆");
  assert.equal(persisted.result_md, "");
  assert.equal(JSON.parse(persisted.provenance_json).sourceSystem, "nanowork");
  assert.ok(persisted.specialist_id, "运行记录应关联餐饮数字员工目录");
  assert.equal(
    db.prepare(`SELECT COUNT(*) n FROM tool_run_events WHERE tenant_id=1`).get()
      .n,
    8,
  );
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(DISTINCT run_id) n FROM tool_run_events WHERE tenant_id=1`,
      )
      .get().n,
    8,
  );
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(*) n FROM tool_run_events WHERE tenant_id=1 AND status='failed'`,
      )
      .get().n,
    8,
  );
});

test("工具键、员工绑定、标题、字段长度和数组数量均由服务端严格校验", async () => {
  await withServer(userOne, async (base) => {
    const cases = [
      {
        body: {
          toolKey: "unknown",
          employeeIdx: 141,
          title: "未知工具",
          inputs: {},
        },
        error: /toolKey仅支持/,
      },
      {
        body: {
          toolKey: "hot",
          employeeIdx: 140,
          title: "冒用员工",
          inputs: VALID_PAYLOADS.hot.inputs,
        },
        error: /#141/,
      },
      {
        body: {
          toolKey: "hot",
          employeeIdx: 141,
          title: "超长".repeat(61),
          inputs: VALID_PAYLOADS.hot.inputs,
        },
        error: /title长度/,
      },
      {
        body: {
          toolKey: "hot",
          employeeIdx: 141,
          title: "数组过多",
          inputs: {
            ...VALID_PAYLOADS.hot.inputs,
            channels: Array.from(
              { length: 11 },
              (_, index) => `渠道${index + 1}`,
            ),
          },
        },
        error: /1-10项/,
      },
      {
        body: {
          toolKey: "hot",
          employeeIdx: 141,
          title: "文本过长",
          inputs: { ...VALID_PAYLOADS.hot.inputs, focus: "长".repeat(2_001) },
        },
        error: /1-2000字/,
      },
      {
        body: {
          toolKey: "bench",
          employeeIdx: 102,
          title: "对标过多",
          inputs: {
            targets: Array.from({ length: 9 }, (_, i) => `门店${i}`).join("\n"),
          },
        },
        error: /最多填写8个/,
      },
      {
        body: {
          toolKey: "vars",
          employeeIdx: 140,
          title: "嵌套对象",
          inputs: {
            script: VALID_PAYLOADS.vars.inputs.script,
            variants: { value: 3 },
          },
        },
        error: /必须是整数/,
      },
    ];
    for (const item of cases) {
      const result = await request(base, "/toolbox/runs", "POST", item.body);
      assert.equal(result.response.status, 400, JSON.stringify(result.body));
      assert.match(result.body.error, item.error);
    }
    const badLimit = await request(base, "/toolbox/runs?limit=500");
    assert.equal(badLimit.response.status, 400);
  });
});

test("列表与详情均按当前租户隔离，跨租户ID直查返回404", async () => {
  let tenantTwoRunId;
  await withServer(userTwo, async (base) => {
    const created = await request(base, "/toolbox/runs", "POST", {
      toolKey: "hot",
      employeeIdx: 141,
      title: "租户二专属运行",
      inputs: VALID_PAYLOADS.hot.inputs,
    });
    assert.equal(created.response.status, 202);
    await waitForToolRun(base, created.body.run.id);

    const ownList = await request(base, "/toolbox/runs?limit=20");
    assert.deepEqual(
      ownList.body.runs.map((item) => item.title),
      ["租户二专属运行"],
    );
    tenantTwoRunId = ownList.body.runs[0].id;
    const crossDetail = await request(base, `/toolbox/runs/${tenantOneRunId}`);
    assert.equal(crossDetail.response.status, 404);
  });

  await withServer(userOne, async (base) => {
    const ownList = await request(base, "/toolbox/runs?limit=20");
    assert.equal(ownList.body.runs.length, 8);
    assert.ok(
      ownList.body.runs.every((item) => item.title !== "租户二专属运行"),
    );
    const crossDetail = await request(base, `/toolbox/runs/${tenantTwoRunId}`);
    assert.equal(crossDetail.response.status, 404);
    const ownDetail = await request(base, `/toolbox/runs/${tenantOneRunId}`);
    assert.equal(ownDetail.response.status, 200);
    assert.equal(ownDetail.body.run.id, tenantOneRunId);
  });

  assert.equal(
    db.prepare(`SELECT tenant_id FROM tool_runs WHERE id=?`).get(tenantTwoRunId)
      .tenant_id,
    2,
  );
  assert.equal(
    db
      .prepare(`SELECT tenant_id FROM tool_run_events WHERE run_id=?`)
      .get(tenantTwoRunId).tenant_id,
    2,
  );
});

test("工具运行按角色投影：老板/管理员可看完整档案，其余角色只看业务结果与公开来源", async () => {
  let restrictedRunId;
  await withServer(userPeer, async (base) => {
    const before = await request(base, "/toolbox/runs?limit=20");
    assert.equal(before.response.status, 200);
    assert.equal(
      before.body.runs.length,
      0,
      "同租户其他员工创建的运行不得暴露给普通员工",
    );

    const cross = await request(base, `/toolbox/runs/${tenantOneRunId}`);
    assert.equal(cross.response.status, 404);

    const created = await request(base, "/toolbox/runs", "POST", {
      toolKey: "hot",
      employeeIdx: 141,
      title: "销售自己的运行",
      inputs: VALID_PAYLOADS.hot.inputs,
    });
    assert.equal(created.response.status, 202);
    await waitForToolRun(base, created.body.run.id);

    const own = await request(base, "/toolbox/runs?limit=20");
    assert.deepEqual(
      own.body.runs.map((item) => item.title),
      ["销售自己的运行"],
    );
    restrictedRunId = own.body.runs[0].id;
    assert.equal(own.body.runs[0].provenance.mode, "template");
    assert.equal(own.body.runs[0].provenance.employeeSnapshot, undefined);
    assert.equal(own.body.runs[0].provenance.promptVersion, undefined);
    assert.equal(own.body.runs[0].provenance.employeeSnapshot, undefined);
  });

  const persisted = JSON.parse(
    db
      .prepare("SELECT provenance_json FROM tool_runs WHERE id=?")
      .get(restrictedRunId).provenance_json,
  );
  assert.ok(
    persisted.employeeSnapshot.capabilities.length > 0,
    "服务端执行快照仍须完整持久化",
  );
  assert.ok(
    persisted.employeeSnapshot.skills.length > 0,
    "响应脱敏不能破坏执行快照",
  );

  const restrictedUsers = [
    { ...userPeer, role: "staff" },
    { ...userPeer, role: "sales" },
    { ...userPeer, role: "partner" },
    { ...userPeer, role: "manager" },
  ];
  for (const user of restrictedUsers) {
    await withServer(user, async (base) => {
      const detail = await request(base, `/toolbox/runs/${restrictedRunId}`);
      assert.equal(detail.response.status, 200, user.role);
      assert.equal(detail.body.run.resultMd, "", user.role);
      assert.equal(
        detail.body.run.provenance.employeeSnapshot,
        undefined,
        user.role,
      );
      assert.equal(
        detail.body.run.provenance.promptVersion,
        undefined,
        user.role,
      );
      assert.equal(
        JSON.stringify(detail.body).includes("完整岗位手册"),
        false,
        user.role,
      );
    });
  }

  await withServer(userOps, async (base) => {
    const outsideChain = await request(
      base,
      `/toolbox/runs/${restrictedRunId}`,
    );
    assert.equal(
      outsideChain.response.status,
      404,
      "运营负责人不能查看管理链之外的同租户员工运行",
    );
  });

  for (const role of ["boss", "admin", "platform_super"]) {
    await withServer({ ...userOne, role }, async (base) => {
      const detail = await request(base, `/toolbox/runs/${restrictedRunId}`);
      assert.equal(detail.response.status, 200, role);
      assert.ok(
        detail.body.run.provenance.employeeSnapshot.capabilities.length > 0,
        role,
      );
      assert.ok(
        detail.body.run.provenance.employeeSnapshot.skills.length > 0,
        role,
      );
      assert.match(
        detail.body.run.provenance.employeeSnapshot.systemContext,
        /完整岗位手册/u,
        role,
      );
    });
  }
});

test("列表与详情统一使用本人加下属管理链，ops和manager都不能穿透链外员工", async () => {
  let subordinateRunId;
  let outsideRunId;
  await withServer(userSubordinate, async (base) => {
    const created = await request(base, "/toolbox/runs", "POST", {
      toolKey: "hot",
      employeeIdx: 141,
      title: "直属下属运行",
      inputs: VALID_PAYLOADS.hot.inputs,
    });
    assert.equal(created.response.status, 202);
    await waitForToolRun(base, created.body.run.id);
    const own = await request(base, "/toolbox/runs?limit=20");
    subordinateRunId = own.body.runs.find(
      (run) => run.title === "直属下属运行",
    )?.id;
    assert.ok(subordinateRunId);
  });
  await withServer(userOutside, async (base) => {
    const created = await request(base, "/toolbox/runs", "POST", {
      toolKey: "hot",
      employeeIdx: 141,
      title: "管理链外运行",
      inputs: VALID_PAYLOADS.hot.inputs,
    });
    assert.equal(created.response.status, 202);
    await waitForToolRun(base, created.body.run.id);
    const own = await request(base, "/toolbox/runs?limit=20");
    outsideRunId = own.body.runs.find(
      (run) => run.title === "管理链外运行",
    )?.id;
    assert.ok(outsideRunId);
  });

  await withServer(userManager, async (base) => {
    const list = await request(base, "/toolbox/runs?limit=50");
    assert.ok(list.body.runs.some((run) => run.id === subordinateRunId));
    assert.ok(list.body.runs.every((run) => run.id !== outsideRunId));
    assert.equal(
      (await request(base, `/toolbox/runs/${subordinateRunId}`)).response
        .status,
      200,
    );
    assert.equal(
      (await request(base, `/toolbox/runs/${outsideRunId}`)).response.status,
      404,
    );
  });
  await withServer(userOps, async (base) => {
    const list = await request(base, "/toolbox/runs?limit=50");
    assert.ok(list.body.runs.some((run) => run.id === subordinateRunId));
    assert.ok(list.body.runs.every((run) => run.id !== outsideRunId));
    assert.equal(
      (await request(base, `/toolbox/runs/${subordinateRunId}`)).response
        .status,
      200,
    );
    assert.equal(
      (await request(base, `/toolbox/runs/${outsideRunId}`)).response.status,
      404,
    );
  });
  await withServer(userOne, async (base) => {
    assert.equal(
      (await request(base, `/toolbox/runs/${subordinateRunId}`)).response
        .status,
      200,
    );
    assert.equal(
      (await request(base, `/toolbox/runs/${outsideRunId}`)).response.status,
      200,
    );
  });
});

test("历史done记录只有api、有效契约、已落库且已结算才允许使用", async () => {
  q.run("UPDATE tenants SET credits=10000 WHERE id=?", 1);
  const blockedModes = [
    "template",
    "fallback",
    "failed",
    "error",
    "mock",
    "demo",
    "degraded",
    "unknown",
  ];
  const blockedCases = [
    ...blockedModes.map((mode) => ({
      label: `mode=${mode}`,
      id: insertToolboxRunFixture({ title: `历史伪成功-${mode}`, mode }),
    })),
    {
      label: "contract invalid",
      id: insertToolboxRunFixture({
        title: "历史伪成功-契约无效",
        provenance: {
          contract: {
            validator: "toolbox-delivery-contract",
            status: "invalid",
            valid: false,
            errors: ["测试契约失败"],
          },
        },
      }),
    },
    {
      label: "persisted false",
      id: insertToolboxRunFixture({
        title: "历史伪成功-未确认落库",
        provenance: { persisted: false },
      }),
    },
    {
      label: "completion incomplete",
      id: insertToolboxRunFixture({
        title: "历史伪成功-生成未完成",
        provenance: { completionState: "draft" },
      }),
    },
    {
      label: "billing released",
      id: insertToolboxRunFixture({
        title: "历史伪成功-账务已释放",
        billingState: "released",
      }),
    },
    {
      label: "model missing",
      reconciliation: true,
      id: insertToolboxRunFixture({
        title: "历史伪成功-模型缺失",
        provenance: { model: "" },
      }),
    },
    {
      label: "usage missing",
      reconciliation: true,
      id: insertToolboxRunFixture({
        title: "历史伪成功-用量缺失",
        provenance: { usage: { inputTokens: 0, outputTokens: 0 } },
      }),
    },
    {
      label: "accepted attempt missing",
      id: insertToolboxRunFixture({
        title: "历史伪成功-采纳尝试缺失",
        provenance: { attempts: [] },
      }),
    },
    {
      label: "leakage clear evidence mismatch",
      id: insertToolboxRunFixture({
        title: "历史伪成功-泄漏审计哈希错配",
        provenance: {
          internalProfileLeakage: {
            detected: false,
            status: "clear",
            outputHash: "mismatch",
          },
        },
      }),
    },
    {
      label: "provenance伪造settled但没有权威账本",
      reconciliation: true,
      id: insertToolboxRunFixture({
        title: "历史伪成功-没有权威账本",
        authoritativeBilling: false,
      }),
    },
    {
      label: "非空但没有完整工作成果",
      id: insertToolboxRunFixture({
        title: "历史伪成功-正文过短",
        resultMd: "# 有内容\n\n这不是完整工作成果。",
      }),
    },
  ];
  const validId = insertToolboxRunFixture({ title: "四道门槛全部通过" });
  const duplicateBillingId = insertToolboxRunFixture({
    title: "历史伪成功-重复实扣账本",
  });
  const creatorMismatchId = insertToolboxRunFixture({
    title: "历史伪成功-账本用户错配",
  });
  const usageMismatchId = insertToolboxRunFixture({
    title: "历史伪成功-账本用量错配",
  });
  const modelMismatchId = insertToolboxRunFixture({
    title: "历史伪成功-账本模型错配",
  });
  const chargedCreditsMismatchId = insertToolboxRunFixture({
    title: "历史伪成功-自报实扣错配",
  });
  const wrongBindingId = insertToolboxRunFixture({
    title: "历史伪成功-错绑其他业务账本",
  });
  runWithTenant(1, () => {
    const duplicateHold = holdCredits({
      userId: userOne.id,
      feature: "经营工具箱·今日必发",
      kind: "text",
      model: "gpt-5.5",
      credits: 5,
      refType: "tool_run",
      refId: duplicateBillingId,
      note: "重复账本测试",
    });
    settleHold(duplicateHold, {
      usage: { inputTokens: 100, outputTokens: 50 },
      model: "gpt-5.5",
      aiMode: "api",
      credits: 5,
    });
    q.run(
      "UPDATE tool_runs SET created_by=? WHERE id=?",
      userPeer.id,
      creatorMismatchId,
    );
    q.run(
      `UPDATE credit_logs SET input_tokens=99 WHERE id=(
      SELECT log_id FROM credit_holds WHERE ref_type='tool_run' AND ref_id=?
    )`,
      usageMismatchId,
    );
    q.run(
      `UPDATE credit_logs SET model='other-real-model' WHERE id=(
      SELECT log_id FROM credit_holds WHERE ref_type='tool_run' AND ref_id=?
    )`,
      modelMismatchId,
    );
    const charged = JSON.parse(
      q.get(
        "SELECT provenance_json FROM tool_runs WHERE id=?",
        chargedCreditsMismatchId,
      ).provenance_json,
    );
    charged.billing.chargedCredits = 4;
    q.run(
      "UPDATE tool_runs SET provenance_json=? WHERE id=?",
      JSON.stringify(charged),
      chargedCreditsMismatchId,
    );
    const wrongHold = q.get(
      `SELECT id,log_id FROM credit_holds
      WHERE ref_type='tool_run' AND ref_id=?`,
      wrongBindingId,
    );
    q.run(
      `UPDATE credit_holds SET feature='完全无关的图片生成业务',kind='image',model='hold-only-wrong-model'
      WHERE id=?`,
      wrongHold.id,
    );
    q.run(
      `UPDATE credit_logs SET feature='完全无关的图片生成业务',kind='image'
      WHERE id=?`,
      wrongHold.log_id,
    );
    const wrongBinding = JSON.parse(
      q.get("SELECT provenance_json FROM tool_runs WHERE id=?", wrongBindingId)
        .provenance_json,
    );
    wrongBinding.attempts[0].model = "totally-different-real-model";
    wrongBinding.attempts[0].usage = { inputTokens: 999, outputTokens: 888 };
    q.run(
      "UPDATE tool_runs SET provenance_json=? WHERE id=?",
      JSON.stringify(wrongBinding),
      wrongBindingId,
    );
  });
  blockedCases.push({
    label: "同一运行存在重复实扣账本",
    id: duplicateBillingId,
    reconciliation: true,
  });
  blockedCases.push({
    label: "账本用户与运行创建人不一致",
    id: creatorMismatchId,
    reconciliation: true,
  });
  blockedCases.push({
    label: "账本token与产物溯源不一致",
    id: usageMismatchId,
    reconciliation: true,
  });
  blockedCases.push({
    label: "账本模型与产物溯源不一致",
    id: modelMismatchId,
    reconciliation: true,
  });
  blockedCases.push({
    label: "自报实扣与权威账本不一致",
    id: chargedCreditsMismatchId,
    reconciliation: true,
  });
  blockedCases.push({
    label: "错绑其他业务账本且accepted attempt错配",
    id: wrongBindingId,
    reconciliation: true,
  });

  await withServer(userOne, async (base) => {
    for (const item of blockedCases) {
      const detail = await request(base, `/toolbox/runs/${item.id}`);
      assert.equal(detail.response.status, 200);
      assert.equal(detail.body.run.status, "done", item.label);
      assert.equal(detail.body.run.verified, false, item.label);
      assert.equal(detail.body.run.canUse, false, item.label);
      assert.equal(
        detail.body.run.displayStatus,
        item.reconciliation
          ? "业务暂不可采用（待账务对账）"
          : "失败需返工（质检未通过）",
        item.label,
      );
      assert.equal(
        detail.body.run.nextAction,
        item.reconciliation
          ? "等待管理员完成账务对账；对账完成前该产物业务暂不可采用"
          : "补充或调整输入后重新运行；当前正文只作为审计记录",
        item.label,
      );
    }

    const valid = await request(base, `/toolbox/runs/${validId}`);
    assert.equal(valid.response.status, 200);
    assert.equal(valid.body.run.verified, true);
    assert.equal(valid.body.run.canUse, true);
    assert.equal(valid.body.run.displayStatus, "已完成");
    assert.equal(valid.body.run.nextAction, "查看并核对工具结果");
  });
});

test("真实产物账务未结算时保留审计结果，但统一显示业务暂不可采用", async () => {
  q.run("UPDATE tenants SET credits=10000 WHERE id=?", 1);
  const pendingStates = ["pending_reconciliation", "held", "unsettled"];
  const ids = pendingStates.map((state) =>
    insertToolboxRunFixture({
      title: `账务状态-${state}`,
      billingState: state,
    }),
  );
  const invalidPendingId = insertToolboxRunFixture({
    title: "质检失败且退款释放待对账",
    billingState: "pending_reconciliation",
    provenance: {
      contract: {
        validator: "toolbox-delivery-contract",
        status: "invalid",
        valid: false,
        errors: ["产物证据不足"],
      },
    },
  });

  await withServer(userOne, async (base) => {
    for (const [index, id] of ids.entries()) {
      const detail = await request(base, `/toolbox/runs/${id}`);
      assert.equal(detail.response.status, 200);
      assert.equal(detail.body.run.status, "done", pendingStates[index]);
      assert.equal(detail.body.run.verified, false, pendingStates[index]);
      assert.equal(detail.body.run.canUse, false, pendingStates[index]);
      assert.equal(
        detail.body.run.displayStatus,
        "业务暂不可采用（待账务对账）",
        pendingStates[index],
      );
      assert.equal(
        detail.body.run.nextAction,
        "等待管理员完成账务对账；对账完成前该产物业务暂不可采用",
        pendingStates[index],
      );
      assert.match(
        detail.body.run.resultMd,
        /今日内容安排/u,
        pendingStates[index],
      );
    }
    const invalidPending = await request(
      base,
      `/toolbox/runs/${invalidPendingId}`,
    );
    assert.equal(invalidPending.response.status, 200);
    assert.equal(invalidPending.body.run.verified, false);
    assert.equal(invalidPending.body.run.canUse, false);
    assert.equal(
      invalidPending.body.run.displayStatus,
      "业务暂不可采用（待账务对账）",
    );
    assert.equal(
      invalidPending.body.run.nextAction,
      "等待管理员完成账务对账；对账完成前该产物业务暂不可采用",
    );
  });
  for (const id of [...ids, invalidPendingId]) {
    const held = q.get(
      `SELECT id FROM credit_holds
      WHERE tenant_id=1 AND ref_type='tool_run' AND ref_id=? AND status='held'`,
      id,
    );
    if (held)
      runWithTenant(1, () =>
        releaseHold({ holdId: held.id }, "工具箱待对账读取测试清理"),
      );
  }
});

test("工具箱真实AI调用必须先占扣，余额不足不触发上游，成功后按用量结算且不留悬挂占扣", async () => {
  let upstreamCalls = 0;
  let capturedBody = null;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    upstreamCalls += 1;
    const serializedBody = JSON.stringify(capturedBody);
    const echoInternalProfile = serializedBody.includes("工具箱内部档案回显");
    const lowQuality = serializedBody.includes("非空废话产物");
    const semanticShell = serializedBody.includes("语义空壳产物");
    const structuredShell = serializedBody.includes("结构化空壳产物");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: echoInternalProfile
                ? capturedBody.messages?.[0]?.content
                : structuredShell
                  ? STRUCTURED_SHELL_HOT_AI_RESULT
                  : semanticShell
                    ? EMPTY_SHELL_HOT_AI_RESULT
                    : lowQuality
                      ? "# 今日建议\n\n建议认真运营并持续优化。"
                      : VALID_HOT_AI_RESULT,
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  process.env.YUNWU_API_KEY = "test-toolbox-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstreamPort}`;

  try {
    q.run("UPDATE tenants SET credits=0 WHERE id=?", 1);
    await withServer(userOne, async (base) => {
      const denied = await request(base, "/toolbox/runs", "POST", {
        toolKey: "hot",
        employeeIdx: 141,
        title: "余额不足不得调用",
        inputs: VALID_PAYLOADS.hot.inputs,
      });
      assert.equal(denied.response.status, 402);
    });
    assert.equal(upstreamCalls, 0, "预授权失败后不得发送上游请求");

    q.run("UPDATE tenants SET credits=10000 WHERE id=?", 1);
    const before = q.get("SELECT credits FROM tenants WHERE id=?", 1).credits;
    let created;
    await withServer(userOne, async (base) => {
      created = await enqueueAndWait(base, {
        toolKey: "hot",
        employeeIdx: 141,
        title: "真实计费运行",
        inputs: VALID_PAYLOADS.hot.inputs,
      });
    });
    assert.equal(created.response.status, 200, JSON.stringify(created.body));
    assert.equal(upstreamCalls, 1);
    assert.equal(created.body.run.status, "done");
    assert.equal(created.body.run.displayStatus, "已完成");
    assert.equal(created.body.run.verified, true);
    assert.equal(created.body.run.canUse, true);
    assert.equal(created.body.run.provenance.mode, "api");
    assert.equal(created.body.run.provenance.contract.status, "valid");
    assert.equal(created.body.run.provenance.contract.valid, true);
    assert.equal(created.body.run.provenance.persisted, true);
    assert.equal(
      created.body.run.provenance.internalProfileLeakage.status,
      "clear",
    );
    assert.equal(
      created.body.run.provenance.internalProfileLeakage.detected,
      false,
    );
    assert.match(
      created.body.run.provenance.internalProfileLeakage.outputHash,
      /^[a-f0-9]{64}$/u,
    );
    assert.equal(created.body.billing.state, "settled");
    assert.ok(created.body.billing.chargedCredits > 0);
    assert.match(capturedBody.messages[0].content, /完整岗位手册/);
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=1 AND status='held'`,
      ).n,
      0,
    );
    assert.equal(
      q.get("SELECT credits FROM tenants WHERE id=?", 1).credits,
      before - created.body.billing.chargedCredits,
    );
    const successfulHold = q.get(
      "SELECT * FROM credit_holds WHERE id=?",
      created.body.billing.holdId,
    );
    assert.equal(successfulHold.ref_type, "tool_run");
    assert.equal(successfulHold.ref_id, created.body.run.id);
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM credit_logs
      WHERE tenant_id=1 AND id=? AND feature='经营工具箱·今日必发' AND ai_mode='api'`,
        successfulHold.log_id,
      ).n,
      1,
    );

    const beforeLowQuality = q.get(
      "SELECT credits FROM tenants WHERE id=?",
      1,
    ).credits;
    let lowQuality;
    await withServer(userOne, async (base) => {
      lowQuality = await enqueueAndWait(base, {
        toolKey: "hot",
        employeeIdx: 141,
        title: "非空废话产物",
        inputs: { ...VALID_PAYLOADS.hot.inputs, focus: "非空废话产物" },
      });
    });
    assert.equal(
      lowQuality.response.status,
      200,
      JSON.stringify(lowQuality.body),
    );
    assert.equal(lowQuality.body.run.status, "failed");
    assert.equal(lowQuality.body.run.canUse, false);
    assert.match(
      lowQuality.body.run.provenance.contract.errors.join("；"),
      /不足180字|清晰章节|可执行动作/u,
    );
    assert.equal(lowQuality.body.billing.state, "released");
    assert.equal(lowQuality.body.billing.chargedCredits, 0);
    assert.equal(
      q.get("SELECT credits FROM tenants WHERE id=?", 1).credits,
      beforeLowQuality,
    );

    const beforeSemanticShell = q.get(
      "SELECT credits FROM tenants WHERE id=?",
      1,
    ).credits;
    let semanticShell;
    await withServer(userOne, async (base) => {
      semanticShell = await enqueueAndWait(base, {
        toolKey: "hot",
        employeeIdx: 141,
        title: "语义空壳产物",
        inputs: { ...VALID_PAYLOADS.hot.inputs, focus: "语义空壳产物" },
      });
    });
    assert.equal(
      semanticShell.response.status,
      200,
      JSON.stringify(semanticShell.body),
    );
    assert.equal(semanticShell.body.run.status, "failed");
    assert.equal(semanticShell.body.run.canUse, false);
    assert.match(
      semanticShell.body.run.provenance.contract.errors.join("；"),
      /占位|空话|执行责任表/u,
    );
    assert.equal(semanticShell.body.billing.state, "released");
    assert.equal(semanticShell.body.billing.chargedCredits, 0);
    assert.equal(
      q.get("SELECT credits FROM tenants WHERE id=?", 1).credits,
      beforeSemanticShell,
    );

    const beforeStructuredShell = q.get(
      "SELECT credits FROM tenants WHERE id=?",
      1,
    ).credits;
    let structuredShell;
    await withServer(userOne, async (base) => {
      structuredShell = await enqueueAndWait(base, {
        toolKey: "hot",
        employeeIdx: 141,
        title: "结构化空壳产物",
        inputs: {
          ...VALID_PAYLOADS.hot.inputs,
          focus: "提升工作日晚市到店；结构化空壳产物",
        },
      });
    });
    assert.equal(
      structuredShell.response.status,
      200,
      JSON.stringify(structuredShell.body),
    );
    assert.equal(structuredShell.body.run.status, "failed");
    assert.equal(structuredShell.body.run.canUse, false);
    assert.match(
      structuredShell.body.run.provenance.contract.errors.join("；"),
      /具体选题|执行责任表/u,
    );
    assert.equal(structuredShell.body.billing.state, "released");
    assert.equal(structuredShell.body.billing.chargedCredits, 0);
    assert.equal(
      q.get("SELECT credits FROM tenants WHERE id=?", 1).credits,
      beforeStructuredShell,
    );

    const runCountBeforeLinkFailure = q.get(
      "SELECT COUNT(*) n FROM tool_runs WHERE tenant_id=1",
    ).n;
    db.exec(`DROP TRIGGER IF EXISTS injected_toolbox_hold_link_failure`);
    db.exec(`CREATE TRIGGER injected_toolbox_hold_link_failure
      BEFORE UPDATE OF ref_type,ref_id ON credit_holds
      WHEN NEW.ref_type='tool_run' AND OLD.status='held'
      BEGIN
        SELECT RAISE(ABORT, 'injected toolbox hold link failure');
      END`);
    let linkFailure;
    try {
      await withServer(userOne, async (base) => {
        linkFailure = await request(base, "/toolbox/runs", "POST", {
          toolKey: "hot",
          employeeIdx: 141,
          title: "占扣引用绑定失败",
          inputs: VALID_PAYLOADS.hot.inputs,
        });
      });
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS injected_toolbox_hold_link_failure`);
    }
    assert.equal(linkFailure.response.status, 500);
    assert.equal(
      q.get("SELECT COUNT(*) n FROM tool_runs WHERE tenant_id=1").n,
      runCountBeforeLinkFailure,
      "预授权引用绑定失败时运行与事件必须整单回滚",
    );
    assert.equal(
      q.get(`SELECT COUNT(*) n FROM credit_holds
      WHERE tenant_id=1 AND feature='经营工具箱·今日必发' AND status='held'`).n,
      0,
    );
    const releasedUnlinked = q.get(`SELECT * FROM credit_holds
      WHERE tenant_id=1 AND feature='经营工具箱·今日必发'
        AND ref_type IS NULL AND ref_id IS NULL
      ORDER BY id DESC LIMIT 1`);
    assert.equal(releasedUnlinked.settled_credits, 0);

    db.exec(`DROP TRIGGER IF EXISTS injected_toolbox_settlement_failure`);
    db.exec(`CREATE TRIGGER injected_toolbox_settlement_failure
      BEFORE UPDATE OF status ON credit_holds
      WHEN OLD.feature='经营工具箱·今日必发'
        AND OLD.status='held'
        AND NEW.status='settled'
      BEGIN
        SELECT RAISE(ABORT, 'injected toolbox settlement failure');
      END`);
    let awaitingReconciliation;
    try {
      await withServer(userOne, async (base) => {
        awaitingReconciliation = await enqueueAndWait(base, {
          toolKey: "hot",
          employeeIdx: 141,
          title: "真实产物等待对账",
          inputs: VALID_PAYLOADS.hot.inputs,
        });
      });
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS injected_toolbox_settlement_failure`);
    }
    assert.equal(
      awaitingReconciliation.response.status,
      200,
      JSON.stringify(awaitingReconciliation.body),
    );
    assert.equal(awaitingReconciliation.body.run.status, "done");
    assert.equal(awaitingReconciliation.body.run.verified, false);
    assert.equal(awaitingReconciliation.body.run.canUse, false);
    assert.equal(
      awaitingReconciliation.body.run.displayStatus,
      "业务暂不可采用（待账务对账）",
    );
    assert.equal(
      awaitingReconciliation.body.run.nextAction,
      "等待管理员完成账务对账；对账完成前该产物业务暂不可采用",
    );
    assert.equal(
      awaitingReconciliation.body.billing.state,
      "pending_reconciliation",
    );
    assert.match(awaitingReconciliation.body.run.resultMd, /真实工具交付/u);
    const pendingStored = q.get(
      "SELECT result_md,provenance_json FROM tool_runs WHERE tenant_id=1 AND id=?",
      awaitingReconciliation.body.run.id,
    );
    const pendingProvenance = JSON.parse(pendingStored.provenance_json);
    assert.match(pendingStored.result_md, /真实工具交付/u);
    assert.equal(pendingProvenance.contract.valid, true);
    assert.equal(pendingProvenance.persisted, true);
    assert.equal(pendingProvenance.billing.state, "pending_reconciliation");
    const pendingHold = q.get(`SELECT * FROM credit_holds
      WHERE tenant_id=1 AND feature='经营工具箱·今日必发' AND status='held'
      ORDER BY id DESC LIMIT 1`);
    assert.ok(pendingHold, "结算失败时必须保留占扣供管理员对账");
    assert.equal(pendingHold.ref_type, "tool_run");
    assert.equal(pendingHold.ref_id, awaitingReconciliation.body.run.id);
    runWithTenant(1, () =>
      releaseHold({ holdId: pendingHold.id }, "工具箱待对账测试清理"),
    );

    db.exec(
      `DROP TRIGGER IF EXISTS injected_toolbox_final_billing_snapshot_failure`,
    );
    db.exec(`CREATE TRIGGER injected_toolbox_final_billing_snapshot_failure
      BEFORE UPDATE OF provenance_json ON tool_runs
      WHEN OLD.title='结算后快照写回失败'
        AND OLD.status='done'
        AND json_extract(OLD.provenance_json,'$.billing.state')='held'
        AND json_extract(NEW.provenance_json,'$.billing.state')='settled'
      BEGIN
        SELECT RAISE(ABORT, 'injected toolbox final billing snapshot failure');
      END`);
    let finalSnapshotFailure;
    try {
      await withServer(userOne, async (base) => {
        // Keep the injected trigger installed until the background worker has
        // reached its terminal state; POST itself is only the 202 enqueue ack.
        finalSnapshotFailure = await enqueueAndWait(base, {
          toolKey: "hot",
          employeeIdx: 141,
          title: "结算后快照写回失败",
          inputs: VALID_PAYLOADS.hot.inputs,
        });
      });
    } finally {
      db.exec(
        `DROP TRIGGER IF EXISTS injected_toolbox_final_billing_snapshot_failure`,
      );
    }
    assert.equal(
      finalSnapshotFailure.response.status,
      200,
      JSON.stringify(finalSnapshotFailure.body),
    );
    const paidRow = q.get(`SELECT * FROM tool_runs
      WHERE tenant_id=1 AND title='结算后快照写回失败'`);
    assert.equal(
      paidRow.status,
      "done",
      "已落库并实扣的合格产物不得被异常处理覆盖成失败",
    );
    assert.match(paidRow.result_md, /真实工具交付/u);
    assert.equal(JSON.parse(paidRow.provenance_json).contract.valid, true);
    const paidHold = q.get(
      `SELECT * FROM credit_holds
      WHERE tenant_id=1 AND ref_type='tool_run' AND ref_id=?`,
      paidRow.id,
    );
    assert.equal(paidHold.status, "settled");
    assert.ok(Number(paidHold.settled_credits) > 0);
    await withServer(userOne, async (base) => {
      const visible = await request(base, `/toolbox/runs/${paidRow.id}`);
      assert.equal(visible.response.status, 200);
      assert.equal(
        visible.body.run.displayStatus,
        "业务暂不可采用（待账务对账）",
      );
      assert.equal(visible.body.run.canUse, false);
      assert.match(visible.body.run.resultMd, /真实工具交付/u);
    });

    let leakedRunId;
    let leakedHoldId;
    await withServer(userPeer, async (base) => {
      const blocked = await enqueueAndWait(base, {
        toolKey: "hot",
        employeeIdx: 141,
        title: "工具箱内部档案回显",
        inputs: { ...VALID_PAYLOADS.hot.inputs, focus: "工具箱内部档案回显" },
      });
      assert.equal(blocked.response.status, 200, JSON.stringify(blocked.body));
      leakedRunId = blocked.body.run.id;
      leakedHoldId = blocked.body.billing.holdId;
      assert.match(blocked.body.run.resultMd, /结果已进入内部档案泄漏复核/u);
      assert.equal(blocked.body.run.resultMd.includes("NW-IPG-"), false);
      assert.equal(blocked.body.run.internalProfileLeakage.detected, true);
      assert.equal(blocked.body.run.status, "failed");
      assert.equal(blocked.body.run.displayStatus, "失败需返工（质检未通过）");
      assert.equal(blocked.body.run.canUse, false);
      assert.equal(blocked.body.billing.state, "released");
      assert.equal(blocked.body.billing.chargedCredits, 0);
    });
    // 4 个坏产物场景（低质、语义空壳、结构化空壳、档案回显）各触发一次
    // 环内定向返工（同样的坏响应第二轮仍失败），因此 7 次业务调用变 11 次。
    assert.equal(
      upstreamCalls,
      11,
      "预授权尚未绑定可见运行时不得调用外部模型",
    );
    const storedLeak = q.get(
      "SELECT result_md,provenance_json FROM tool_runs WHERE tenant_id=1 AND id=?",
      leakedRunId,
    );
    assert.match(storedLeak.result_md, /结果已进入内部档案泄漏复核/u);
    assert.equal(storedLeak.result_md.includes("NW-IPG-"), false);
    assert.equal(
      JSON.parse(storedLeak.provenance_json).internalProfileLeakage.detected,
      true,
    );
    const leakedHold = q.get(
      "SELECT * FROM credit_holds WHERE id=?",
      leakedHoldId,
    );
    assert.equal(leakedHold?.ref_type, "tool_run");
    assert.equal(leakedHold?.ref_id, leakedRunId);
    await withServer(userOne, async (base) => {
      const controlled = await request(base, `/toolbox/runs/${leakedRunId}`);
      assert.equal(controlled.response.status, 200);
      assert.match(controlled.body.run.resultMd, /结果已进入内部档案泄漏复核/u);
      assert.equal(controlled.body.run.resultMd.includes("NW-IPG-"), false);
      assert.equal(controlled.body.run.internalProfileLeakage.detected, true);
    });

    db.exec(`DROP TRIGGER IF EXISTS injected_toolbox_finish_failure`);
    db.exec(`DROP TRIGGER IF EXISTS injected_toolbox_release_failure`);
    db.exec(`CREATE TRIGGER injected_toolbox_finish_failure
      BEFORE UPDATE OF result_md ON tool_runs
      WHEN OLD.title='外部调用后落库异常' AND NEW.result_md LIKE '%真实工具交付%'
      BEGIN
        SELECT RAISE(ABORT, 'injected toolbox finish failure');
      END`);
    db.exec(`CREATE TRIGGER injected_toolbox_release_failure
      BEFORE UPDATE OF status ON credit_holds
      WHEN OLD.feature='经营工具箱·今日必发' AND OLD.status='held' AND NEW.status='settled'
      BEGIN
        SELECT RAISE(ABORT, 'injected toolbox release failure');
      END`);
    let failedAfterProvider;
    try {
      await withServer(userOne, async (base) => {
        failedAfterProvider = await enqueueAndWait(base, {
          toolKey: "hot",
          employeeIdx: 141,
          title: "外部调用后落库异常",
          inputs: VALID_PAYLOADS.hot.inputs,
        });
      });
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS injected_toolbox_finish_failure`);
      db.exec(`DROP TRIGGER IF EXISTS injected_toolbox_release_failure`);
    }
    assert.equal(
      failedAfterProvider.response.status,
      200,
      JSON.stringify(failedAfterProvider.body),
    );
    assert.equal(upstreamCalls, 12, "运行记录和预授权完成绑定后才允许外部调用");
    const failedRow = q.get(
      `SELECT * FROM tool_runs WHERE tenant_id=1 AND title='外部调用后落库异常'`,
    );
    assert.ok(failedRow, "外部调用后的异常必须保留可见运行记录");
    assert.equal(failedRow.status, "failed");
    const failedHold = q.get(
      `SELECT * FROM credit_holds
      WHERE tenant_id=1 AND ref_type='tool_run' AND ref_id=?`,
      failedRow.id,
    );
    assert.ok(failedHold, "异常运行必须关联本次预授权");
    assert.equal(failedHold.status, "held", "退款失败必须保留待对账占扣");
    await withServer(userOne, async (base) => {
      const visible = await request(base, `/toolbox/runs/${failedRow.id}`);
      assert.equal(visible.response.status, 200);
      assert.equal(
        visible.body.run.displayStatus,
        "业务暂不可采用（待账务对账）",
      );
      assert.equal(visible.body.run.canUse, false);
      assert.equal(
        visible.body.run.nextAction,
        "等待管理员完成账务对账；对账完成前该产物业务暂不可采用",
      );
    });
    runWithTenant(1, () =>
      releaseHold({ holdId: failedHold.id }, "工具箱异常待对账测试清理"),
    );
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("上游返回正文但没有正token证据时不得交付，运行、失败事件与退款账本仍完整关联", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume request */
    }
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "# 缺少用量的真实返回\n\n有正文不等于有可结算的真实调用证据。",
            },
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.YUNWU_API_KEY = "test-toolbox-zero-usage-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;

  try {
    q.run("UPDATE tenants SET credits=10000 WHERE id=?", 1);
    const before = q.get("SELECT credits FROM tenants WHERE id=?", 1).credits;
    let created;
    await withServer(userOne, async (base) => {
      created = await enqueueAndWait(base, {
        toolKey: "hot",
        employeeIdx: 141,
        title: "缺少token证据",
        inputs: VALID_PAYLOADS.hot.inputs,
      });
    });

    assert.equal(created.response.status, 200, JSON.stringify(created.body));
    assert.equal(upstreamCalls, 1);
    assert.equal(created.body.run.status, "failed");
    assert.equal(created.body.run.canUse, false);
    assert.equal(created.body.run.verified, false);
    assert.equal(created.body.run.displayStatus, "失败需返工（质检未通过）");
    assert.equal(created.body.run.provenance.mode, "api");
    assert.equal(created.body.run.provenance.contract.valid, false);
    assert.match(
      created.body.run.provenance.contract.errors.join("；"),
      /输入 token|输出 token|正 token/u,
    );
    assert.equal(
      created.body.run.provenance.internalProfileLeakage.status,
      "clear",
    );
    assert.equal(created.body.billing.state, "released");
    assert.equal(created.body.billing.chargedCredits, 0);
    assert.equal(
      q.get("SELECT credits FROM tenants WHERE id=?", 1).credits,
      before,
    );

    const hold = q.get(
      "SELECT * FROM credit_holds WHERE id=?",
      created.body.billing.holdId,
    );
    assert.equal(hold.status, "settled");
    assert.equal(hold.settled_credits, 0);
    assert.equal(hold.ref_type, "tool_run");
    assert.equal(hold.ref_id, created.body.run.id);
    const event = q.get(
      "SELECT * FROM tool_run_events WHERE tenant_id=1 AND run_id=?",
      created.body.run.id,
    );
    assert.equal(event.status, "failed");
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("首轮真实产出缺质检项时按缺项定向返工，第二轮达标后正常交付结算", async () => {
  // 首轮：完整正文但缺执行责任表（历史上这会整单判失败并退款）。
  const firstDraftMissingTable = VALID_HOT_AI_RESULT.split("## 执行责任表")[0].trim();
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    upstreamRequests.push(raw);
    const body =
      upstreamRequests.length === 1 ? firstDraftMissingTable : VALID_HOT_AI_RESULT;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: body } }],
        usage: { prompt_tokens: 600, completion_tokens: 700 },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.YUNWU_API_KEY = "test-toolbox-quality-rework-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;

  try {
    q.run("UPDATE tenants SET credits=10000 WHERE id=?", 1);
    let created;
    await withServer(userOne, async (base) => {
      created = await enqueueAndWait(base, {
        toolKey: "hot",
        employeeIdx: 141,
        title: "质检缺项定向返工",
        inputs: VALID_PAYLOADS.hot.inputs,
      });
    });

    assert.equal(created.response.status, 200, JSON.stringify(created.body));
    assert.equal(upstreamRequests.length, 2, "缺质检项必须触发第二轮返工");
    assert.match(
      upstreamRequests[1],
      /定向返工·质检缺项/u,
      "第二轮提示词必须携带定向返工块",
    );
    assert.match(
      upstreamRequests[1],
      /执行责任表/u,
      "第二轮提示词必须点名缺失的执行责任表",
    );
    assert.doesNotMatch(
      upstreamRequests[0],
      /定向返工·质检缺项/u,
      "首轮不携带返工指令",
    );

    assert.equal(created.body.run.status, "done");
    assert.equal(created.body.run.canUse, true);
    assert.equal(created.body.run.verified, true);
    assert.equal(created.body.run.displayStatus, "已完成");
    const attempts = created.body.run.provenance.attempts;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].outcome, "retryable_failure");
    assert.equal(attempts[0].reason, "quality_gate");
    assert.equal(attempts[1].outcome, "accepted");
    // 两轮真实用量累计计入同一账本。
    assert.deepEqual(created.body.run.provenance.usage, {
      inputTokens: 1200,
      outputTokens: 1400,
    });
    assert.equal(created.body.billing.state, "settled");
    assert.ok(created.body.billing.chargedCredits > 0);
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("工具箱真实AI最多两轮：首轮模板可重试、双轮预授权、usage累计，双轮失败全额退回", async () => {
  const calls = new Map();
  const captured = new Map();
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const serialized = JSON.stringify(body);
    const scenario = serialized.includes("首轮降级模板")
      ? "fallback_then_success"
      : serialized.includes("双轮模板失败")
        ? "both_fallback"
        : serialized.includes("累计真实用量")
          ? "usage_accumulation"
          : "unknown";
    const attempt = (calls.get(scenario) || 0) + 1;
    calls.set(scenario, attempt);
    captured.set(`${scenario}:${attempt}`, body);

    if (
      (scenario === "fallback_then_success" && attempt === 1) ||
      scenario === "both_fallback"
    ) {
      res.writeHead(504, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "模拟上游超时原文-不得持久化" } }),
      );
      return;
    }
    if (scenario === "usage_accumulation" && attempt === 1) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "" } }],
          usage: { prompt_tokens: 31, completion_tokens: 7 },
        }),
      );
      return;
    }

    const usage =
      scenario === "usage_accumulation"
        ? { prompt_tokens: 67, completion_tokens: 19 }
        : { prompt_tokens: 71, completion_tokens: 29 };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: VALID_HOT_AI_RESULT } }],
        usage,
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.YUNWU_API_KEY = "test-toolbox-retry-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;

  try {
    q.run("UPDATE tenants SET credits=10000 WHERE id=?", 1);

    let recovered;
    await withServer(userOne, async (base) => {
      recovered = await enqueueAndWait(base, {
        toolKey: "hot",
        employeeIdx: 141,
        title: "首轮降级模板",
        inputs: {
          ...VALID_PAYLOADS.hot.inputs,
          focus: "提升工作日晚市到店，不做虚假限量；首轮降级模板",
        },
      });
    });
    assert.equal(
      recovered.response.status,
      200,
      JSON.stringify(recovered.body),
    );
    assert.equal(calls.get("fallback_then_success"), 2);
    assert.equal(recovered.body.run.status, "done");
    assert.equal(
      recovered.body.run.provenance.attempts.length,
      TOOLBOX_AI_MAX_ATTEMPTS,
    );
    assert.deepEqual(
      recovered.body.run.provenance.attempts.map((item) => [
        item.mode,
        item.outcome,
        item.reason,
      ]),
      [
        ["template", "retryable_failure", "template_fallback"],
        ["api", "accepted", "accepted"],
      ],
    );
    assert.match(
      captured.get("fallback_then_success:2").messages.at(-1).content,
      /从头重新生成一份完整/u,
    );
    assert.match(
      captured.get("fallback_then_success:2").messages.at(-1).content,
      /不得为了补全结果而新增/u,
    );
    assert.equal(
      JSON.stringify(recovered.body.run.provenance).includes(
        "模拟上游超时原文",
      ),
      false,
      "溯源只能保存脱敏尝试摘要",
    );

    const snapshot = recovered.body.run.provenance.employeeSnapshot;
    const model = snapshot.workConfig.textModel || textModelFor(userOne.role);
    const perAttemptEstimate = {
      kind: "text",
      model,
      outputTokens: snapshot.workConfig.outputLength === "full" ? 5000 : 2500,
      texts: [
        snapshot.systemContext,
        JSON.stringify({
          ...VALID_PAYLOADS.hot.inputs,
          focus: "提升工作日晚市到店，不做虚假限量；首轮降级模板",
        }),
      ],
    };
    const expectedHold =
      estimateCallCredits(perAttemptEstimate) +
      estimateCallCredits({
        ...perAttemptEstimate,
        texts: [...perAttemptEstimate.texts, TOOLBOX_AI_RETRY_INSTRUCTION],
      });
    assert.equal(
      recovered.body.billing.estimatedCredits,
      expectedHold,
      "首轮调用前必须一次性占扣两轮输入与输出上限",
    );
    const recoveredHold = q.get(
      "SELECT * FROM credit_holds WHERE id=?",
      recovered.body.billing.holdId,
    );
    assert.equal(recoveredHold.held_credits, expectedHold);
    assert.equal(recoveredHold.status, "settled");
    assert.equal(recoveredHold.ref_type, "tool_run");
    assert.equal(recoveredHold.ref_id, recovered.body.run.id);
    assert.equal(
      q.get(
        "SELECT COUNT(*) n FROM credit_logs WHERE id=?",
        recoveredHold.log_id,
      ).n,
      1,
      "两轮供应商尝试只能结算一条账务流水",
    );

    let accumulated;
    await withServer(userOne, async (base) => {
      accumulated = await enqueueAndWait(base, {
        toolKey: "hot",
        employeeIdx: 141,
        title: "累计真实用量",
        inputs: {
          ...VALID_PAYLOADS.hot.inputs,
          focus: "提升工作日晚市到店，不做虚假限量；累计真实用量",
        },
      });
    });
    assert.equal(
      accumulated.response.status,
      200,
      JSON.stringify(accumulated.body),
    );
    assert.equal(calls.get("usage_accumulation"), 2);
    assert.deepEqual(accumulated.body.run.provenance.usage, {
      inputTokens: 98,
      outputTokens: 26,
    });
    assert.deepEqual(
      accumulated.body.run.provenance.attempts.map((item) => item.reason),
      ["empty_output", "accepted"],
    );
    const accumulatedHold = q.get(
      "SELECT * FROM credit_holds WHERE id=?",
      accumulated.body.billing.holdId,
    );
    const accumulatedLog = q.get(
      "SELECT * FROM credit_logs WHERE id=?",
      accumulatedHold.log_id,
    );
    assert.equal(accumulatedLog.input_tokens, 98);
    assert.equal(accumulatedLog.output_tokens, 26);
    assert.equal(
      q.get(
        "SELECT COUNT(*) n FROM credit_logs WHERE id=?",
        accumulatedHold.log_id,
      ).n,
      1,
    );

    const beforeFailure = q.get(
      "SELECT credits FROM tenants WHERE id=?",
      1,
    ).credits;
    let failed;
    let failedRun;
    await withServer(userOne, async (base) => {
      failed = await enqueueAndWait(base, {
        toolKey: "hot",
        employeeIdx: 141,
        title: "双轮模板失败",
        inputs: {
          ...VALID_PAYLOADS.hot.inputs,
          focus: "提升工作日晚市到店，不做虚假限量；双轮模板失败",
        },
      });
      failedRun = failed.body.run;
    });
    assert.equal(failed.response.status, 200, JSON.stringify(failed.body));
    assert.equal(failed.body.run.executionState, "failed");
    assert.equal(failed.body.run.error?.code, "TOOLBOX_PROVIDER_NO_DELIVERY");
    assert.equal(calls.get("both_fallback"), TOOLBOX_AI_MAX_ATTEMPTS);
    assert.ok(failedRun);
    assert.equal(failedRun.status, "failed");
    assert.equal(failedRun.canUse, false);
    assert.equal(failedRun.provenance.mode, "pending");
    assert.equal(
      failedRun.provenance.providerAttempt.attempts.length,
      TOOLBOX_AI_MAX_ATTEMPTS,
    );
    assert.ok(
      failedRun.provenance.providerAttempt.attempts.every(
        (item) => item.reason === "template_fallback",
      ),
    );
    assert.equal(failedRun.resultMd, "");
    assert.equal(failedRun.resultMd.includes("模拟上游超时原文"), false);
    assert.equal(failedRun.provenance.billing.state, "released");
    assert.equal(failedRun.provenance.billing.chargedCredits, 0);
    assert.equal(
      q.get("SELECT credits FROM tenants WHERE id=?", 1).credits,
      beforeFailure,
    );
    const failedHold = q.get(
      "SELECT * FROM credit_holds WHERE tenant_id=? AND ref_type=? AND ref_id=?",
      1,
      "tool_run",
      failedRun.id,
    );
    assert.equal(failedHold.status, "settled");
    assert.equal(failedHold.settled_credits, 0);
    assert.equal(failedHold.ref_type, "tool_run");
    assert.equal(failedHold.ref_id, failedRun.id);
    assert.equal(
      q.get("SELECT COUNT(*) n FROM credit_logs WHERE id=?", failedHold.log_id)
        .n,
      1,
    );
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("数据库CHECK约束拒绝第9种工具键", () => {
  assert.throws(
    () =>
      runWithTenant(1, () =>
        q.run(
          `INSERT INTO tool_runs(
    tool_key,tool_title,title,status,employee_idx,employee_name,created_by,input_json,input_summary,result_md,provenance_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          "ninth",
          "第九工具",
          "非法",
          "done",
          141,
          "云营销",
          userOne.id,
          "{}",
          "非法",
          "# 非法",
          "{}",
        ),
      ),
    /CHECK constraint failed/,
  );
});

test("cleanup", () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
});

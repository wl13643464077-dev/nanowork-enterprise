import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-review-dataset-marshal-${process.pid}.db`,
);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}
process.env.NANOWORK_DB = DB_PATH;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";

const { initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { buildEmployeeExecutionProfile } =
  await import("../src/employee-workbench.js");
const { marshalWork } = await import("../src/engines/ai.js");
const { importReviewDataset } =
  await import("../src/engines/review-dataset-import.js");
const { saveUploadedFile } = await import("../src/engines/filehub.js");
const marshalRoutes = (await import("../src/routes/marshals.js")).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const marshal = {
  code: "M-06",
  name: "品牌与增长部",
  title: "内部调度容器",
  duty: "仅负责调度与归档",
  skills: "",
  prompt: "",
  kb_deps: "",
};
const task = {
  title: "分析本轮授权评价并形成口碑改进清单",
  type: "分析",
  requirement: "依据本轮上传数据做样本限制明确的内部分析，不发布回复。",
};
const controlledSource = {
  title: "评价平台规则隔离来源",
  url: "https://reviews.test/platform-policy",
  snippet: "评价回复规则隔离摘要。",
  body: "受控网页正文：评价平台公开规则已在离线夹具中完成净化，仅用于验证岗位联网证据链；不得把夹具内容当作真实外部事实或发布授权。",
};

function offlineSearch() {
  return {
    attempted: true,
    ok: true,
    provider: "offline-review-search",
    results: [controlledSource],
    evidence: { externalCall: false },
  };
}

function offlineFetch() {
  return {
    attempted: true,
    ok: true,
    provider: "offline-review-controlled-fetch",
    results: [controlledSource],
    evidence: {
      requested: 1,
      fetched: 1,
      externalCall: false,
      ssrfProtected: true,
      redirectsRevalidated: true,
    },
  };
}

function fixtureFor(profile) {
  const fixture = structuredClone(profile.outputContract.validFixture);
  fixture.decision_context.problem = `${task.title}：${fixture.decision_context.problem}`;
  fixture.decision_context.sources[0].source = `${controlledSource.title}｜${controlledSource.url}`;
  return fixture;
}

test("员工143只把去标识化结构摘要交给最终模型，原始评价与PII不进入提示词", async () => {
  const profile = buildEmployeeExecutionProfile(143, {
    tenantId: 1,
    user: { id: 1, role: "boss", tenant_id: 1 },
  });
  const csv = Buffer.from(
    [
      "platform,rating,date,review,phone",
      "大众点评,1,2026-08-01,服务很慢请联系13800138000,13800138000",
      "美团,5,2026-08-02,口味不错环境干净,",
    ].join("\n"),
  );
  const attachment = {
    id: 701,
    name: "评价数据.csv",
    ext: "csv",
    url: "/uploads/files/1/review/评价数据.csv",
    readable: true,
    content:
      "platform,rating,date,review,phone\n大众点评,1,2026-08-01,服务很慢请联系13800138000,13800138000",
  };
  let generationArgs = null;
  let importCallback = null;
  const output = await marshalWork(marshal, task, "boss", {
    employeeExecution: profile,
    attachments: [attachment],
    webSearchFn: async () => offlineSearch(),
    controlledWebFetchFn: async () => offlineFetch(),
    reviewDatasetImportFn: (args) =>
      importReviewDataset({
        ...args,
        readFile: async () => ({ fileId: 701, bytes: csv }),
      }),
    onReviewDatasetImportComplete: (evidence) => {
      importCallback = evidence;
    },
    generateFn: async (args) => {
      generationArgs = args;
      return {
        text: JSON.stringify(fixtureFor(profile)),
        mode: "api",
        model: "yunwu-review-test-model",
        usage: { inputTokens: 41, outputTokens: 29 },
      };
    },
  });

  assert.equal(output.employeeContract.valid, true);
  assert.equal(output.reviewDatasetImport.parseStatus, "completed");
  assert.deepEqual(output.reviewDatasetImport.acceptedFileIds, [701]);
  assert.equal(importCallback.parseStatus, "completed");
  assert.ok(generationArgs);
  assert.match(generationArgs.userMsg, /用户授权上传·评价数据结构化摘要/u);
  assert.match(generationArgs.userMsg, /untrusted_user_uploaded_data/u);
  assert.match(generationArgs.userMsg, /\[PHONE_REDACTED\]/u);
  assert.match(generationArgs.userMsg, /"rowCount":2/u);
  assert.doesNotMatch(generationArgs.userMsg, /13800138000/u);
  assert.doesNotMatch(
    generationArgs.userMsg,
    /本次统一文件中心普通附件[\s\S]*platform,rating,date,review/u,
  );
  const persisted = JSON.stringify(output.reviewDatasetImport);
  assert.doesNotMatch(persisted, /服务很慢|口味不错|13800138000/u);
  assert.equal(output.reviewDatasetImport.privacy.rawReviewTextStored, false);
});

test("员工143无附件时optional且如实not_invoked，仍可执行普通岗位任务", async () => {
  const profile = buildEmployeeExecutionProfile(143, {
    tenantId: 1,
    user: { id: 1, role: "boss", tenant_id: 1 },
  });
  let callback = null;
  const output = await marshalWork(marshal, task, "boss", {
    employeeExecution: profile,
    webSearchFn: async () => offlineSearch(),
    controlledWebFetchFn: async () => offlineFetch(),
    onReviewDatasetImportComplete: (evidence) => {
      callback = evidence;
    },
    generateFn: async () => ({
      text: JSON.stringify(fixtureFor(profile)),
      mode: "api",
      model: "yunwu-review-test-model",
      usage: { inputTokens: 31, outputTokens: 19 },
    }),
  });

  assert.equal(output.employeeContract.valid, true);
  assert.equal(output.reviewDatasetImport.invoked, false);
  assert.equal(output.reviewDatasetImport.parseStatus, "not_invoked");
  assert.equal(output.reviewDatasetImport.reason, "no_authorized_uploads");
  assert.equal(callback.parseStatus, "not_invoked");
});

test("员工143附件全部拒绝时在任何联网或模型调用前fail closed并携带脱敏证据", async () => {
  const profile = buildEmployeeExecutionProfile(143, {
    tenantId: 1,
    user: { id: 1, role: "boss", tenant_id: 1 },
  });
  let webCalls = 0;
  let modelCalls = 0;
  let failure;
  try {
    await marshalWork(marshal, task, "boss", {
      employeeExecution: profile,
      attachments: [
        {
          id: 702,
          name: "reviews.csv",
          ext: "csv",
          url: "/uploads/files/1/review/reviews.csv",
          readable: true,
          content: "review\n=HYPERLINK(SECRET)",
        },
      ],
      reviewDatasetImportFn: (args) =>
        importReviewDataset({
          ...args,
          readFile: async () => ({
            fileId: 702,
            bytes: Buffer.from("review\n=HYPERLINK(SECRET)"),
          }),
        }),
      webSearchFn: async () => {
        webCalls += 1;
        return offlineSearch();
      },
      generateFn: async () => {
        modelCalls += 1;
        throw new Error("must not generate");
      },
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, "REVIEW_DATASET_IMPORT_REJECTED");
  assert.equal(webCalls, 0);
  assert.equal(modelCalls, 0);
  assert.equal(failure.reviewDatasetImport.parseStatus, "rejected");
  assert.equal(
    failure.reviewDatasetImport.rejected[0].reasonCode,
    "formula_injection",
  );
  assert.doesNotMatch(JSON.stringify(failure.reviewDatasetImport), /SECRET/u);
});

test("HTTP派活由FileHub先做租户隔离，成功后employee_web_snapshot只落脱敏导入证据", async () => {
  const tenantId = 71_143;
  const otherTenantId = 71_144;
  for (const [id, name] of [
    [tenantId, "评价导入租户"],
    [otherTenantId, "隔离对照租户"],
  ]) {
    q.run(
      `INSERT INTO tenants(id,name,status,plan,credits)
       VALUES(?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status='已开通',credits=100000`,
      id,
      name,
      "已开通",
      "标准版",
      100_000,
    );
    runWithTenant(id, () => ensureBaselineCatalogs());
  }
  const userId = Number(
    q.run(
      `INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits)
       VALUES(?,?,?,?,?,?,?)`,
      `review-import-owner-${process.pid}`,
      "x",
      "评价导入老板",
      "boss",
      "启用",
      tenantId,
      100_000,
    ).lastInsertRowid,
  );
  const otherUserId = Number(
    q.run(
      `INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits)
       VALUES(?,?,?,?,?,?,?)`,
      `review-import-other-${process.pid}`,
      "x",
      "隔离租户老板",
      "boss",
      "启用",
      otherTenantId,
      100_000,
    ).lastInsertRowid,
  );
  const specialist = q.get(
    `SELECT id,marshal_id FROM specialists
     WHERE employee_idx=143 LIMIT 1`,
  );
  assert.ok(specialist?.id, "基线目录必须包含员工143");
  const csv = Buffer.from(
    "platform,rating,date,review,phone\n大众点评,2,2026-08-03,服务太慢请联系13900139000,13900139000\n美团,5,2026-08-04,口味很好环境干净,",
  );
  const otherCsv = Buffer.from(
    "platform,rating,review\n美团,1,另一个租户的私有评价",
  );
  const unsafeCsv = Buffer.from(
    "platform,rating,review\n美团,1,=HYPERLINK(ROUTE_SECRET)",
  );
  const uploaded = runWithTenant(tenantId, () =>
    saveUploadedFile({
      name: "张三-13900139000-授权评价.csv",
      b64: csv.toString("base64"),
      mime: "text/csv",
      purpose: "review_dataset",
      userId,
    }),
  );
  const otherUploaded = runWithTenant(otherTenantId, () =>
    saveUploadedFile({
      name: "其他租户评价.csv",
      b64: otherCsv.toString("base64"),
      mime: "text/csv",
      purpose: "review_dataset",
      userId: otherUserId,
    }),
  );
  const unsafeUploaded = runWithTenant(tenantId, () =>
    saveUploadedFile({
      name: "不安全评价.csv",
      b64: unsafeCsv.toString("base64"),
      mime: "text/csv",
      purpose: "review_dataset",
      userId,
    }),
  );

  const profile = buildEmployeeExecutionProfile(143, {
    tenantId,
    user: { id: userId, role: "boss", tenant_id: tenantId },
  });
  const app = express();
  const generated = [];
  let agenticCalls = 0;
  app.locals.employeeEstimateCallCredits = () => 100;
  app.locals.employeeWebSearch = async () => offlineSearch();
  app.locals.employeeAgenticWebResearch = async () => {
    agenticCalls += 1;
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      title: `评价规则隔离来源${index + 1}`,
      url: `https://reviews.test/source-${index + 1}`,
      snippet: `离线评价规则摘要${index + 1}`,
    }));
    return {
      attempted: true,
      ok: true,
      candidateReady: true,
      provider: "offline-agentic-review-search",
      results: candidates,
      fetchCandidates: candidates,
      evidence: {
        schemaVersion: "nanowork.agentic-web-research/1",
        toolCalls: 5,
        toolAttempts: 5,
        qualityGate: {
          requiredSearches: 5,
          requiredSources: 5,
          observedSearches: 5,
          observedSuccessfulToolResults: 5,
          observedToolResultUrls: 5,
          observedSources: 5,
          passed: true,
        },
        externalCall: false,
      },
    };
  };
  app.locals.employeeControlledWebFetch = async (sources) => ({
    attempted: true,
    ok: true,
    provider: "offline-review-controlled-fetch",
    results: [
      controlledSource,
      ...sources.map((source) => ({
        ...source,
        body: `受控网页正文：${source.title}仅为评价岗位离线链路夹具；未知事项保留补证，不代表发布授权。`,
      })),
    ],
    evidence: {
      requested: sources.length,
      fetched: sources.length + 1,
      externalCall: false,
      ssrfProtected: true,
      redirectsRevalidated: true,
    },
  });
  app.locals.employeeGenerate = async (args) => {
    generated.push(args);
    return {
      text: JSON.stringify(fixtureFor(profile)),
      mode: "api",
      model: args.model,
      usage: { inputTokens: 51, outputTokens: 33 },
    };
  };
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = {
      id: userId,
      name: "评价导入老板",
      role: "boss",
      tenant_id: tenantId,
    };
    runWithTenant(tenantId, () => next());
  });
  app.use("/marshals", marshalRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let taskId = null;
  let unsafeTaskId = null;
  try {
    const isolatedResponse = await fetch(
      `${base}/marshals/${specialist.marshal_id}/tasks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          specialistId: specialist.id,
          title: task.title,
          type: task.type,
          requirement: task.requirement,
          fileIds: [otherUploaded.row.id],
        }),
      },
    );
    assert.equal(isolatedResponse.status, 404);
    assert.match(
      JSON.stringify(await isolatedResponse.json()),
      /文件不存在或无权访问/u,
    );
    assert.equal(
      agenticCalls,
      0,
      "跨租户文件必须在导入器、联网和模型前被FileHub阻断",
    );
    assert.equal(generated.length, 0);

    const unsafeResponse = await fetch(
      `${base}/marshals/${specialist.marshal_id}/tasks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          specialistId: specialist.id,
          title: task.title,
          type: task.type,
          requirement: task.requirement,
          fileIds: [unsafeUploaded.row.id],
        }),
      },
    );
    const unsafePayload = await unsafeResponse.json();
    assert.equal(unsafeResponse.status, 200, JSON.stringify(unsafePayload));
    unsafeTaskId = Number(unsafePayload.taskId);
    let unsafeRow = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      unsafeRow = runWithTenant(tenantId, () =>
        q.get(
          `SELECT status,employee_web_snapshot FROM agent_tasks
           WHERE tenant_id=? AND id=?`,
          tenantId,
          unsafeTaskId,
        ),
      );
      if (unsafeRow?.status === "失败") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(unsafeRow?.status, "失败");
    const unsafeSnapshot = JSON.parse(unsafeRow.employee_web_snapshot);
    assert.equal(unsafeSnapshot.failure.code, "REVIEW_DATASET_IMPORT_REJECTED");
    assert.equal(unsafeSnapshot.reviewDatasetImport.parseStatus, "rejected");
    assert.equal(
      unsafeSnapshot.reviewDatasetImport.rejected[0].reasonCode,
      "formula_injection",
    );
    assert.doesNotMatch(JSON.stringify(unsafeSnapshot), /ROUTE_SECRET/u);
    assert.equal(agenticCalls, 0, "坏数据必须在联网前失败关闭");
    assert.equal(generated.length, 0, "坏数据必须在模型前失败关闭");

    const response = await fetch(
      `${base}/marshals/${specialist.marshal_id}/tasks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          specialistId: specialist.id,
          title: task.title,
          type: task.type,
          requirement: task.requirement,
          fileIds: [uploaded.row.id],
        }),
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    taskId = Number(payload.taskId);
    assert.ok(taskId > 0);

    let row = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      row = runWithTenant(tenantId, () =>
        q.get(
          `SELECT status,employee_input_snapshot,employee_web_snapshot FROM agent_tasks
           WHERE tenant_id=? AND id=?`,
          tenantId,
          taskId,
        ),
      );
      if (row?.status && row.status !== "生成中") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(row?.employee_web_snapshot, `任务未形成执行证据：${row?.status}`);
    const snapshot = JSON.parse(row.employee_web_snapshot);
    assert.equal(snapshot.kind, "restaurant_employee_execution_evidence");
    assert.equal(snapshot.reviewDatasetImport.parseStatus, "completed");
    assert.deepEqual(snapshot.reviewDatasetImport.acceptedFileIds, [
      uploaded.row.id,
    ]);
    assert.equal(snapshot.reviewDatasetImport.accepted[0].rowCount, 2);
    assert.equal(snapshot.reviewDatasetImport.accepted[0].sha256.length, 64);
    assert.equal(snapshot.reviewDatasetImport.privacy.rawRowsStored, false);
    assert.equal(
      snapshot.reviewDatasetImport.privacy.rawReviewTextStored,
      false,
    );
    const serializedSnapshot = JSON.stringify(snapshot);
    assert.doesNotMatch(serializedSnapshot, /13900139000|服务太慢|口味很好/u);
    assert.doesNotMatch(
      String(row.employee_input_snapshot || ""),
      /13900139000|张三|uploads\/files/u,
    );
    assert.match(
      String(row.employee_input_snapshot || ""),
      /评价数据附件1\.csv/u,
    );
    assert.equal(generated.length, 1);
    assert.match(generated[0].userMsg, /\[PHONE_REDACTED\]/u);
    assert.doesNotMatch(generated[0].userMsg, /13900139000/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const saved of [uploaded, otherUploaded, unsafeUploaded]) {
      try {
        fs.rmSync(saved.row.file_path, { force: true });
      } catch {}
    }
    if (taskId) {
      runWithTenant(tenantId, () =>
        q.run(
          "DELETE FROM agent_tasks WHERE tenant_id=? AND id=?",
          tenantId,
          taskId,
        ),
      );
    }
    if (unsafeTaskId) {
      runWithTenant(tenantId, () =>
        q.run(
          "DELETE FROM agent_tasks WHERE tenant_id=? AND id=?",
          tenantId,
          unsafeTaskId,
        ),
      );
    }
  }
});

after(() => {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
});

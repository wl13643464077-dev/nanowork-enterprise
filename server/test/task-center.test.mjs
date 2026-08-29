import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import express from "express";

const dbPath = path.join(os.tmpdir(), `nanowork-task-center-${process.pid}.db`);
const artifactDir = path.join(
  os.tmpdir(),
  `nanowork-task-center-artifacts-${process.pid}`,
);
for (const suffix of ["", "-wal", "-shm"])
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
fs.rmSync(artifactDir, { recursive: true, force: true });
process.env.NANOWORK_DB = dbPath;
process.env.NANOWORK_ARTIFACT_DIR = artifactDir;

const { initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const taskCenterRoutes = (await import("../src/routes/task-center.js")).default;
const { taskCenterPublicErrorResponse } = await import(
  "../src/engines/task-center.js"
);
initSchema();
migrateV2();

q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id,manager_id)
  VALUES('task_owner','x','执行员工','sales','运营部',1,NULL)`);
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id,manager_id)
  VALUES('task_other','x','其他员工','sales','运营部',1,NULL)`);
const owner = q.get(
  "SELECT id,name,role,tenant_id FROM users WHERE username='task_owner'",
);
q.run(
  "UPDATE users SET modules=? WHERE id=?",
  JSON.stringify(["execution", "marshals", "content"]),
  owner.id,
);
const other = q.get(
  "SELECT id,name,role,tenant_id FROM users WHERE username='task_other'",
);
const boss = { id: 9999, name: "老板", role: "boss", tenant_id: 1 };

const manualId = Number(
  q.run(
    `INSERT INTO tasks(tenant_id,title,detail,status,assignee_id,created_at)
  VALUES(1,'门店巡检跟进','检查三项整改','待执行',?,datetime('now','localtime'))`,
    owner.id,
  ).lastInsertRowid,
);
q.run(
  `INSERT INTO marshals(code,name,title) VALUES('TASK-CENTER-M','运营元帅','运营')`,
);
const marshalId = Number(
  q.get("SELECT id FROM marshals WHERE code='TASK-CENTER-M'").id,
);
q.run(
  `INSERT INTO specialists(tenant_id,marshal_id,name,employee_idx) VALUES(1,?,'餐饮执行员工',777)`,
  marshalId,
);
const specialistId = Number(
  q.get("SELECT id FROM specialists WHERE tenant_id=1 AND employee_idx=777").id,
);
const contentOutputId = Number(
  q.run(
    `INSERT INTO contents(tenant_id,type,title,body,status,creator_id,created_at)
  VALUES(1,'报告','餐饮任务产出','餐饮员工执行结果','待审核',?,datetime('now','localtime'))`,
    owner.id,
  ).lastInsertRowid,
);
const restaurantId = Number(
  q.run(
    `INSERT INTO agent_tasks(
    tenant_id,marshal_id,specialist_id,title,requirement,status,output_id,created_by,created_at,employee_web_snapshot)
  VALUES(1,?,?,'餐饮运营分析','分析今日门店经营','生成中',?,?,datetime('now','localtime'),?)`,
    marshalId,
    specialistId,
    contentOutputId,
    owner.id,
    JSON.stringify({
      kind: "restaurant_employee_generation_progress",
      progress: {
        receivedChars: 860,
        attemptNumber: 1,
        phase: "acquire",
        lastActivityAt: new Date().toISOString(),
      },
    }),
  ).lastInsertRowid,
);

const contentRunId = Number(
  q.run(
    `INSERT INTO content_employee_runs(
    tenant_id,employee_idx,employee_key,employee_name,employee_group,title,type,requirement,status,result_md,
    profile_version,prompt_hash,snapshot_json,created_by,created_at,updated_at)
  VALUES(1,0,'writer','内容策划','内容组','新品推文','推文','写一篇新品推文','已完成','推文结果',
    'v1','hash','{}',?,datetime('now','localtime'),datetime('now','localtime'))`,
    owner.id,
  ).lastInsertRowid,
);

function reportHash(value) {
  return createHash("sha256").update(String(value).trim()).digest("hex");
}

const tenantArtifactDir = path.join(artifactDir, "1");
fs.mkdirSync(tenantArtifactDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(tenantArtifactDir, "restaurant.pdf"),
  "real pdf fixture",
  {
    mode: 0o600,
  },
);
fs.writeFileSync(
  path.join(tenantArtifactDir, "content.docx"),
  "real docx fixture",
  {
    mode: 0o600,
  },
);
fs.symlinkSync(
  path.join(tenantArtifactDir, "restaurant.pdf"),
  path.join(tenantArtifactDir, "restaurant-link.pdf"),
);

const restaurantArtifactId = Number(
  q.run(
    `INSERT INTO generated_artifacts(
      tenant_id,user_id,source_type,source_id,title,format,file_url,file_name,status,metadata
    ) VALUES(1,?,'agent_task',?,'餐饮任务产出','pdf','/uploads/artifacts/1/restaurant.pdf',
      'restaurant.pdf','可用',?)`,
    owner.id,
    restaurantId,
    JSON.stringify({ sourceHash: reportHash("餐饮员工执行结果") }),
  ).lastInsertRowid,
);
q.run(
  `INSERT INTO generated_artifacts(
    tenant_id,user_id,source_type,source_id,title,format,file_url,file_name,status,metadata
  ) VALUES(1,?,'content_employee_run',?,'新品推文','docx','/uploads/artifacts/1/content.docx',
    'content.docx','可用',?)`,
  owner.id,
  contentRunId,
  JSON.stringify({ sourceHash: reportHash("推文结果") }),
);
const missingArtifactId = Number(
  q.run(
    `INSERT INTO generated_artifacts(
      tenant_id,user_id,source_type,source_id,title,format,file_url,file_name,status,metadata
    ) VALUES(1,?,'agent_task',?,'餐饮任务丢失文件','xlsx','/uploads/artifacts/1/missing.xlsx',
      'missing.xlsx','可用',?)`,
    owner.id,
    restaurantId,
    JSON.stringify({ sourceHash: reportHash("餐饮员工执行结果") }),
  ).lastInsertRowid,
);
const symlinkArtifactId = Number(
  q.run(
    `INSERT INTO generated_artifacts(
      tenant_id,user_id,source_type,source_id,title,format,file_url,file_name,status,metadata
    ) VALUES(1,?,'agent_task',?,'餐饮任务软链接','pdf','/uploads/artifacts/1/restaurant-link.pdf',
      'restaurant-link.pdf','可用',?)`,
    owner.id,
    restaurantId,
    JSON.stringify({ sourceHash: reportHash("餐饮员工执行结果") }),
  ).lastInsertRowid,
);

const mediaId = Number(
  q.run(
    `INSERT INTO media_jobs(
    tenant_id,user_id,kind,prompt,status,url,content_employee_name,created_at)
  VALUES(1,?,'video','生成新品带货视频','成功','https://example.com/result.mp4','AI带货员',datetime('now','localtime'))`,
    owner.id,
  ).lastInsertRowid,
);

const ruleId = Number(
  q.run(
    `INSERT INTO content_automation_rules(
    tenant_id,name,enabled,employee_idx,topic,requirement,brief_json,content_type,content_count,frequency,
    run_time,approval_mode,created_by,created_at,updated_at)
  VALUES(1,'每日内容',1,0,'今日菜品','生成日更','{}','推文',1,'daily','09:00','always',?,datetime('now','localtime'),datetime('now','localtime'))`,
    owner.id,
  ).lastInsertRowid,
);
const automationId = Number(
  q.run(
    `INSERT INTO content_automation_runs(
    tenant_id,rule_id,trigger,claim_key,status,initiated_by,snapshot_json,started_at)
  VALUES(1,?,'immediate','task-center-claim','运行中',?,'{}',datetime('now','localtime'))`,
    ruleId,
    owner.id,
  ).lastInsertRowid,
);

const toolId = Number(
  q.run(
    `INSERT INTO tool_runs(
    tenant_id,tool_key,tool_title,title,status,employee_idx,employee_name,specialist_id,created_by,
    input_json,input_summary,result_md,assumptions_json,evidence_json,provenance_json,created_at,updated_at)
  VALUES(1,'hot','热点助手','热点分析','failed',0,'内容策划',NULL,?,
    '{}','分析本周热点','工具执行失败','[]','[]','{}',datetime('now','localtime'),datetime('now','localtime'))`,
    owner.id,
  ).lastInsertRowid,
);

function appFor(user) {
  const app = express();
  app.use((req, _res, next) =>
    runWithTenant(1, () => {
      req.user = user;
      next();
    }),
  );
  app.use("/task-center", taskCenterRoutes);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0);
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function get(base, url) {
  const response = await fetch(`${base}${url}`);
  return { status: response.status, body: await response.json() };
}

test("fresh DB 尚无 credit_holds 时列表安全降级，六类 sourceKey 唯一且员工范围收口", async () => {
  assert.equal(
    q.get(
      "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='credit_holds'",
    ),
    undefined,
  );
  await withServer(owner, async (base) => {
    const response = await get(base, "/task-center?pageSize=100");
    assert.equal(response.status, 200);
    assert.equal(response.body.items.length, 6);
    assert.equal(
      new Set(response.body.items.map((row) => row.sourceKey)).size,
      6,
    );
    assert.deepEqual(
      new Set(response.body.items.map((row) => row.kind)),
      new Set([
        "manual",
        "restaurant",
        "content",
        "media",
        "automation",
        "tool",
      ]),
    );
    assert.equal(
      response.body.items.find((row) => row.kind === "manual").billing.state,
      "not_required",
    );
    assert.ok(
      response.body.items
        .filter((row) => row.kind !== "manual")
        .every((row) => row.billing.state === "unavailable"),
    );
    assert.equal(response.body.window.scanned, 6);
    assert.equal(response.body.summary.scope, "filtered_scan_window");
  });
  await withServer(other, async (base) => {
    const response = await get(base, "/task-center?pageSize=100");
    assert.equal(response.status, 200);
    assert.equal(response.body.items.length, 0);
  });
});

test("六类详情均在任务中心内可读，跨员工详情返回404", async () => {
  const ids = {
    manual: manualId,
    restaurant: restaurantId,
    content: contentRunId,
    media: mediaId,
    automation: automationId,
    tool: toolId,
  };
  await withServer(owner, async (base) => {
    for (const [kind, id] of Object.entries(ids)) {
      const response = await get(base, `/task-center/${kind}/${id}`);
      assert.equal(response.status, 200, `${kind} detail`);
      assert.equal(response.body.sourceKey, `${kind}:${id}`);
      assert.equal(typeof response.body.input, "string");
      assert.equal(typeof response.body.output, "string");
      assert.ok(response.body.stepIndex >= 1);
      assert.ok(response.body.stepTotal >= response.body.stepIndex);
      assert.ok(response.body.billing?.ledger);
      if (kind === "restaurant") {
        assert.equal(
          response.body.conversationDeepLink,
          `/employees?employee=777&task=${restaurantId}`,
        );
        assert.equal(response.body.report.format, "markdown");
        assert.match(response.body.report.markdown, /餐饮员工执行结果/u);
        assert.equal(response.body.deliverables[0].label, "PDF");
        assert.equal(response.body.deliverables[0].downloadAvailable, true);
        assert.equal(response.body.deliverables.length, 1);
        assert.equal(
          response.body.deliverables.some(
            (artifact) =>
              artifact.id === missingArtifactId ||
              artifact.id === symlinkArtifactId,
          ),
          false,
          "磁盘文件丢失或软链接的数据库行不得投影为ready",
        );
        assert.equal(
          response.body.deliverables[0].downloadUrl,
          `/api/files/artifacts/${restaurantArtifactId}/download`,
        );
      }
      if (kind === "content") {
        assert.equal(
          response.body.conversationDeepLink,
          `/content?employee=0&runId=${contentRunId}`,
        );
        assert.match(response.body.report.markdown, /推文结果/u);
        assert.equal(response.body.deliverables[0].label, "Word");
      }
    }
  });
  await withServer(other, async (base) => {
    const response = await get(base, `/task-center/content/${contentRunId}`);
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      error: "任务不存在或无权查看",
      code: "TASK_NOT_ACCESSIBLE",
    });
  });
  await withServer(owner, async (base) => {
    const response = await get(base, "/task-center/manual/999999999");
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      error: "任务不存在或无权查看",
      code: "TASK_NOT_ACCESSIBLE",
    });
  });
});

test("非法任务来源和编号返回可行动的安全领域错误", async () => {
  await withServer(owner, async (base) => {
    const invalidKind = await get(base, "/task-center/overview/1");
    assert.equal(invalidKind.status, 400);
    assert.deepEqual(invalidKind.body, {
      error: "不支持的任务来源，请从 allowedKinds 中选择",
      code: "INVALID_TASK_KIND",
      allowedKinds: [
        "manual",
        "restaurant",
        "content",
        "content_pipeline",
        "skill_learning",
        "advisor",
        "avatar",
        "text_video",
        "wechat",
        "media",
        "automation",
        "tool",
      ],
    });

    for (const invalidId of ["abc", "0", "-1", "1.5"]) {
      const response = await get(
        base,
        `/task-center/manual/${encodeURIComponent(invalidId)}`,
      );
      assert.equal(response.status, 400, invalidId);
      assert.deepEqual(response.body, {
        error: "任务编号不正确，必须是大于 0 的整数",
        code: "INVALID_TASK_ID",
      });
    }
  });
});

test("任务中心只公开白名单领域错误，不泄露任意内部异常", () => {
  assert.equal(
    taskCenterPublicErrorResponse({
      status: 400,
      code: "DATABASE_PARSE_FAILED",
      message: "secret table and SQL",
    }),
    null,
  );
  assert.equal(
    taskCenterPublicErrorResponse({
      status: 500,
      code: "INVALID_TASK_KIND",
      message: "internal stack detail",
    }),
    null,
  );
});

test("权威账本区分 held/settled/released/null待对账，状态与服务端筛选一致", async () => {
  q.run(`CREATE TABLE credit_holds(
    id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id INTEGER NOT NULL,user_id INTEGER,log_id INTEGER NOT NULL,
    feature TEXT,kind TEXT,model TEXT,held_credits INTEGER NOT NULL,settled_credits INTEGER,status TEXT,
    ref_type TEXT,ref_id INTEGER,created_at TEXT,settled_at TEXT)`);
  const ledger = (credits, cost) =>
    Number(
      q.run(
        `INSERT INTO credit_logs(
      tenant_id,user_id,feature,kind,model,cost_yuan,credits,balance_after,ai_mode,created_at)
    VALUES(1,?,'任务中心测试','text','test-model',?,?,100,'api',datetime('now','localtime'))`,
        owner.id,
        cost,
        credits,
      ).lastInsertRowid,
    );
  const insertHold = (
    refType,
    refId,
    status,
    held,
    settled,
    logCredits = settled ?? held,
    cost = 0,
  ) => {
    const logId = ledger(logCredits, cost);
    q.run(
      `INSERT INTO credit_holds(tenant_id,user_id,log_id,feature,kind,model,held_credits,settled_credits,status,ref_type,ref_id)
      VALUES(1,?,?,'任务中心测试','text','test-model',?,?,?,?,?)`,
      owner.id,
      logId,
      held,
      settled,
      status,
      refType,
      refId,
    );
  };
  insertHold("agent_task", restaurantId, "held", 20, null, 20);
  insertHold("content_employee_run", contentRunId, "settled", 30, null, 30);
  insertHold("media_job", mediaId, "settled", 15, 12, 12, 0.125);
  insertHold("tool_run", toolId, "settled", 9, 0, 0);

  await withServer(boss, async (base) => {
    const response = await get(base, "/task-center?pageSize=100");
    assert.equal(response.status, 200);
    const byKind = Object.fromEntries(
      response.body.items.map((row) => [row.kind, row]),
    );
    assert.equal(byKind.restaurant.billing.state, "held");
    assert.match(
      byKind.restaurant.currentStep,
      /已接收 860 个响应字符（非质检阈值）/u,
    );
    assert.equal(byKind.content.billing.state, "pending_reconciliation");
    assert.equal(byKind.content.state, "blocked");
    assert.equal(byKind.content.businessUsable, false);
    assert.equal(byKind.media.billing.state, "settled");
    assert.equal(byKind.media.billing.costYuan, 0.125);
    // 技术交付+结算仍需管理层人工验收；列表不能绕过媒体业务采用门禁。
    assert.equal(byKind.media.businessUsable, false);
    assert.equal(byKind.tool.billing.state, "released");
    assert.equal(byKind.manual.state, "pending");

    // 媒体原始导出地址必须继续遵守 media-review 的账务 + 人工验收门禁。
    // 当前 fixture 的 media hold 已结算，因此先改成 held 再读取详情，确保
    // 任务中心不会绕过现有媒体门禁向未验收用户泄露 URL。
    q.run(
      "UPDATE credit_holds SET status='held', settled_credits=NULL WHERE ref_type='media_job' AND ref_id=?",
      mediaId,
    );
    const heldDetail = await get(base, `/task-center/media/${mediaId}`);
    assert.equal(heldDetail.status, 200);
    assert.equal(heldDetail.body.businessUsable, false);
    assert.equal(
      heldDetail.body.output,
      "",
      "未验收媒体不得在任务详情返回原始 URL",
    );

    const pending = await get(base, "/task-center?state=pending&pageSize=100");
    assert.equal(pending.status, 200);
    assert.ok(pending.body.items.length > 0);
    assert.ok(pending.body.items.every((row) => row.state === "pending"));
    assert.equal(pending.body.summary.total, pending.body.items.length);
  });
});

after(() => {
  for (const suffix of ["", "-wal", "-shm"])
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.rmSync(artifactDir, { recursive: true, force: true });
});

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { removeTempDbSafely } from "./helpers/temp-db.mjs";

const dbPath = path.join(
  os.tmpdir(),
  `nanowork-task-center-advisor-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"])
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
process.env.NANOWORK_DB = dbPath;

const { initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const taskCenterRoutes = (await import("../src/routes/task-center.js")).default;
initSchema();
migrateV2();

const userId = Number(
  q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id)
    VALUES('advisor_owner','x','会诊发起人','sales','运营部',1)`)
    .lastInsertRowid,
);
const otherId = Number(
  q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id)
    VALUES('advisor_other','x','其他员工','sales','运营部',1)`).lastInsertRowid,
);
const conversationId = Number(
  q.run(
    `INSERT INTO ai_conversations(tenant_id,user_id,title,diag_type,created_at,updated_at)
    VALUES(1,?,'晚市增长会诊','经营诊断',datetime('now','localtime'),datetime('now','localtime'))`,
    userId,
  ).lastInsertRowid,
);
q.run(
  `INSERT INTO ai_messages(tenant_id,conversation_id,role,content,created_at)
  VALUES(1,?,'user','如何提升工作日晚市到店，同时不做虚假折扣？',datetime('now','localtime'))`,
  conversationId,
);
const assistantMessageId = Number(
  q.run(
    `INSERT INTO ai_messages(tenant_id,conversation_id,role,content,created_at)
    VALUES(1,?,'assistant','先核验晚市时段、现有套餐和到店来源，再用两周小样本验证内容与套餐承接。',datetime('now','localtime'))`,
    conversationId,
  ).lastInsertRowid,
);
const convertedTaskId = Number(
  q.run(
    `INSERT INTO tasks(tenant_id,title,detail,status,assignee_id,source_ref_type,source_ref_id,created_at)
    VALUES(1,'核验晚市到店来源','导出近两周晚市记录','待执行',?,'advisor_message',?,datetime('now','localtime'))`,
    userId,
    assistantMessageId,
  ).lastInsertRowid,
);

q.run(`CREATE TABLE credit_holds(
  id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id INTEGER NOT NULL,user_id INTEGER,log_id INTEGER NOT NULL,
  feature TEXT,kind TEXT,model TEXT,held_credits INTEGER NOT NULL,settled_credits INTEGER,status TEXT,
  ref_type TEXT,ref_id INTEGER,created_at TEXT,settled_at TEXT)`);
const logId = Number(
  q.run(
    `INSERT INTO credit_logs(
    tenant_id,user_id,feature,kind,model,input_tokens,output_tokens,cost_yuan,credits,balance_after,ai_mode,created_at)
    VALUES(1,?,'老板参谋会诊','text','advisor-test',120,80,0.08,6,100,'api',datetime('now','localtime'))`,
    userId,
  ).lastInsertRowid,
);
q.run(
  `INSERT INTO credit_holds(
  tenant_id,user_id,log_id,feature,kind,model,held_credits,settled_credits,status,ref_type,ref_id,created_at,settled_at)
  VALUES(1,?,?,'老板参谋会诊','text','advisor-test',8,6,'settled','ai_message',?,datetime('now','localtime'),datetime('now','localtime'))`,
  userId,
  logId,
  assistantMessageId,
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

test("老板参谋助手消息进入统一任务中心并保留会诊与转任务关系", async () => {
  const owner = { id: userId, name: "会诊发起人", role: "sales", tenant_id: 1 };
  await withServer(owner, async (base) => {
    const listed = await get(base, "/task-center?kind=advisor&pageSize=100");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 1);
    const row = listed.body.items[0];
    assert.equal(row.kind, "advisor");
    assert.equal(row.sourceKey, `advisor:${assistantMessageId}`);
    assert.equal(row.category, "老板参谋会诊");
    assert.equal(row.businessUsable, true);
    assert.equal(row.billing.state, "settled");
    assert.equal(row.billing.credits, 6);
    assert.equal(row.deepLink, `/tasks?kind=advisor&id=${assistantMessageId}`);

    const detail = await get(
      base,
      `/task-center/advisor/${assistantMessageId}`,
    );
    assert.equal(detail.status, 200);
    assert.match(detail.body.input, /工作日晚市/);
    assert.match(detail.body.output, /两周小样本/);
    assert.equal(detail.body.advisor.conversationId, conversationId);
    assert.equal(
      detail.body.advisor.sourceDeepLink,
      `/advisor?conversationId=${conversationId}`,
    );
    assert.deepEqual(
      detail.body.advisor.convertedTasks.map((item) => item.id),
      [convertedTaskId],
    );
    assert.equal(
      detail.body.advisor.convertedTasks[0].deepLink,
      `/tasks?kind=manual&id=${convertedTaskId}`,
    );
  });
});

test("参谋会诊任务继续按用户/管理链隔离", async () => {
  const other = { id: otherId, name: "其他员工", role: "sales", tenant_id: 1 };
  await withServer(other, async (base) => {
    const listed = await get(base, "/task-center?kind=advisor&pageSize=100");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 0);
    const detail = await get(
      base,
      `/task-center/advisor/${assistantMessageId}`,
    );
    assert.equal(detail.status, 404);
  });
});

after(async () => {
  await removeTempDbSafely(dbPath);
});

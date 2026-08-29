import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import { fileURLToPath } from "node:url";

const DBP = path.join(
  os.tmpdir(),
  `shanmei-execution-permissions-${process.pid}.db`,
);
const SERVER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const writtenFiles = [];
for (const f of [DBP, DBP + "-wal", DBP + "-shm"]) {
  try {
    fs.rmSync(f, { force: true });
  } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";

const { initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const { hashPassword } = await import("../src/util.js");
const { BATTLE_PLAN_VERSION } = await import("../src/engines/plans.js");
const executionRoutes = (await import("../src/routes/execution.js")).default;

initSchema();
migrateV2();

q.run(
  `INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`,
  "boss",
  hashPassword("123456"),
  "老板",
  "boss",
  "决策层",
);
q.run(
  `INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`,
  "ops",
  hashPassword("123456"),
  "运营总监",
  "ops_director",
  "运营中心",
);
q.run(
  `INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`,
  "manager",
  hashPassword("123456"),
  "部门经理",
  "manager",
  "销售部",
);
q.run(
  `INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`,
  "admin",
  hashPassword("123456"),
  "企业管理员",
  "admin",
  "管理部",
);
q.run(
  `INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`,
  "sales_a",
  hashPassword("123456"),
  "王强",
  "sales",
  "销售部",
);
q.run(
  `INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`,
  "sales_b",
  hashPassword("123456"),
  "李娜",
  "sales",
  "销售部",
);

const boss = q.get(
  `SELECT id,name,role,tenant_id FROM users WHERE username='boss'`,
);
const ops = q.get(
  `SELECT id,name,role,tenant_id FROM users WHERE username='ops'`,
);
const manager = q.get(
  `SELECT id,name,role,tenant_id FROM users WHERE username='manager'`,
);
const admin = q.get(
  `SELECT id,name,role,tenant_id FROM users WHERE username='admin'`,
);
const salesA = q.get(
  `SELECT id,name,role,tenant_id FROM users WHERE username='sales_a'`,
);
const salesB = q.get(
  `SELECT id,name,role,tenant_id FROM users WHERE username='sales_b'`,
);
q.run(
  "UPDATE users SET manager_id=? WHERE id IN (?,?)",
  ops.id,
  manager.id,
  salesA.id,
);
q.run("UPDATE users SET manager_id=? WHERE id=?", manager.id, salesB.id);

function makeApp(user) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) =>
    runWithTenant(1, () => {
      req.user = user;
      next();
    }),
  );
  app.use("/execution", executionRoutes);
  return app;
}

async function withServer(user, fn) {
  const server = makeApp(user).listen(0);
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function call(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test("可派活人员：仅管理层可读，按组织范围过滤启用账号并返回最小公开字段", async () => {
  const disabledId = q.run(
    `INSERT INTO users(
    username,password_hash,name,role,dept,status,tenant_id,manager_id
  ) VALUES(?,?,?,?,?,'停用',1,?)`,
    "disabled_assignee",
    hashPassword("123456"),
    "已停用员工",
    "sales",
    "销售部",
    ops.id,
  ).lastInsertRowid;
  const platformSuperId = q.run(
    `INSERT INTO users(
    username,password_hash,name,role,dept,status,tenant_id
  ) VALUES(?,?,?,?,?,'启用',1)`,
    "tenant_platform_super",
    hashPassword("123456"),
    "平台超管",
    "platform_super",
    "平台",
  ).lastInsertRowid;

  await withServer(salesA, async (base) => {
    const denied = await call(base, "/execution/assignees");
    assert.equal(denied.status, 403);
  });

  await withServer(ops, async (base) => {
    const scoped = await call(base, "/execution/assignees");
    assert.equal(scoped.status, 200);
    assert.deepEqual(
      scoped.json.map((row) => row.id).sort((a, b) => a - b),
      [ops.id, manager.id, salesA.id, salesB.id].sort((a, b) => a - b),
    );
    for (const row of scoped.json) {
      assert.deepEqual(Object.keys(row).sort(), [
        "dept",
        "id",
        "name",
        "role",
        "status",
      ]);
      assert.equal(row.status, "启用");
    }
  });

  await withServer(boss, async (base) => {
    const all = await call(base, "/execution/assignees");
    assert.equal(all.status, 200);
    const ids = all.json.map((row) => row.id);
    assert.ok(ids.includes(boss.id));
    assert.ok(ids.includes(ops.id));
    assert.ok(ids.includes(salesA.id));
    assert.ok(ids.includes(salesB.id));
    assert.ok(!ids.includes(Number(disabledId)));
    assert.ok(!ids.includes(Number(platformSuperId)));
    assert.ok(
      all.json.every(
        (row) =>
          Object.keys(row).sort().join(",") === "dept,id,name,role,status",
      ),
    );
  });
});

test("经营执行任务权限：员工只能看和提交自己负责的任务，管理层可审核", async () => {
  let ownTaskId;
  let otherTaskId;

  await withServer(boss, async (base) => {
    let r = await call(base, "/execution/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "王强自己的任务",
        type: "跟进",
        assignee_id: salesA.id,
        due_at: "2026-06-21 18:00",
      }),
    });
    assert.equal(r.status, 200);
    ownTaskId = r.json.id;

    r = await call(base, "/execution/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "李娜的任务",
        type: "邀约",
        assignee_id: salesB.id,
        due_at: "2026-06-21 18:00",
      }),
    });
    assert.equal(r.status, 200);
    otherTaskId = r.json.id;
  });

  await withServer(salesA, async (base) => {
    const list = await call(base, "/execution/tasks");
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.json.map((x) => x.id),
      [ownTaskId],
    );

    let blocked = await call(base, `/execution/tasks/${otherTaskId}`, {
      method: "PUT",
      body: JSON.stringify({ status: "进行中" }),
    });
    assert.equal(blocked.status, 403);

    blocked = await call(base, `/execution/tasks/${otherTaskId}/submit`, {
      method: "POST",
      body: JSON.stringify({ content: "尝试提交别人的任务" }),
    });
    assert.equal(blocked.status, 403);

    const submitBeforeStart = await call(
      base,
      `/execution/tasks/${ownTaskId}/submit`,
      {
        method: "POST",
        body: JSON.stringify({ content: "不应跳过开始状态" }),
      },
    );
    assert.equal(submitBeforeStart.status, 409);

    const bypassReview = await call(base, `/execution/tasks/${ownTaskId}`, {
      method: "PUT",
      body: JSON.stringify({ status: "待审核" }),
    });
    assert.equal(bypassReview.status, 409);

    const started = await call(base, `/execution/tasks/${ownTaskId}`, {
      method: "PUT",
      body: JSON.stringify({ status: "进行中" }),
    });
    assert.equal(started.status, 200);

    const bypassComplete = await call(base, `/execution/tasks/${ownTaskId}`, {
      method: "PUT",
      body: JSON.stringify({ status: "已完成" }),
    });
    assert.equal(bypassComplete.status, 409);

    const edited = await call(base, `/execution/tasks/${ownTaskId}`, {
      method: "PUT",
      body: JSON.stringify({
        title: "王强自己的任务-已补要求",
        detail: "需要上传邀约名单",
        type: "邀约",
        priority: "高",
      }),
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.json.title, "王强自己的任务-已补要求");
    assert.equal(edited.json.detail, "需要上传邀约名单");

    const submitted = await call(base, `/execution/tasks/${ownTaskId}/submit`, {
      method: "POST",
      body: JSON.stringify({
        content: "已邀约8人，确认到店5人",
        attachments: [
          {
            name: "邀约名单.csv",
            b64: Buffer.from("姓名,电话\n张三,13900000000").toString("base64"),
          },
        ],
      }),
    });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.json.attachments.length, 1);
    writtenFiles.push(
      path.join(
        SERVER_ROOT,
        "data",
        decodeURIComponent(submitted.json.attachments[0].url),
      ),
    );

    const duplicateSubmit = await call(
      base,
      `/execution/tasks/${ownTaskId}/submit`,
      {
        method: "POST",
        body: JSON.stringify({ content: "不应重复提交" }),
      },
    );
    assert.equal(duplicateSubmit.status, 409);

    const subs = await call(base, `/execution/submissions?taskId=${ownTaskId}`);
    assert.equal(subs.status, 200);
    assert.equal(subs.json.length, 1);
    assert.equal(subs.json[0].user_name, "王强");
    const submitBody = JSON.parse(subs.json[0].content);
    assert.equal(submitBody.kind, "task_submit_v2");
    assert.equal(submitBody.attachments[0].name, "邀约名单.csv");
  });

  await withServer(salesB, async (base) => {
    const started = await call(base, `/execution/tasks/${otherTaskId}`, {
      method: "PUT",
      body: JSON.stringify({ status: "进行中" }),
    });
    assert.equal(started.status, 200);
    const submitted = await call(
      base,
      `/execution/tasks/${otherTaskId}/submit`,
      {
        method: "POST",
        body: JSON.stringify({ content: "李娜已确认3位客户本周到店" }),
      },
    );
    assert.equal(submitted.status, 200);
  });

  await withServer(salesA, async (base) => {
    const subs = await call(base, "/execution/submissions");
    assert.equal(subs.status, 200);
    assert.ok(subs.json.some((x) => x.user_name === "王强"));
    assert.ok(!subs.json.some((x) => x.user_name === "李娜"));

    const monthRank = await call(base, "/execution/ranking?period=month");
    assert.equal(monthRank.status, 200);
    assert.deepEqual(
      monthRank.json.map((x) => x.name),
      ["王强"],
    );
    assert.equal(monthRank.json[0].id, salesA.id);

    const quarterRank = await call(base, "/execution/ranking?period=quarter");
    assert.equal(quarterRank.status, 200);
    assert.deepEqual(
      quarterRank.json.map((x) => x.name),
      ["王强"],
    );
  });

  await withServer(manager, async (base) => {
    const teamRank = await call(base, "/execution/ranking?period=month");
    assert.equal(teamRank.status, 200);
    assert.deepEqual(
      teamRank.json.map((x) => x.name),
      ["李娜"],
    );
    assert.equal(teamRank.json[0].id, salesB.id);
  });

  await withServer(ops, async (base) => {
    const teamRank = await call(base, "/execution/ranking?period=month");
    assert.equal(teamRank.status, 200);
    assert.deepEqual(
      new Set(teamRank.json.map((x) => x.name)),
      new Set(["王强", "李娜"]),
    );
  });

  await withServer(boss, async (base) => {
    const companyRank = await call(base, "/execution/ranking?period=month");
    assert.equal(companyRank.status, 200);
    assert.deepEqual(
      new Set(companyRank.json.map((x) => x.name)),
      new Set(["王强", "李娜"]),
    );
  });

  await withServer(boss, async (base) => {
    const missingDecision = await call(
      base,
      `/execution/tasks/${ownTaskId}/review`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    assert.equal(missingDecision.status, 400);

    const reviewed = await call(base, `/execution/tasks/${ownTaskId}/review`, {
      method: "POST",
      body: JSON.stringify({
        pass: true,
        reason: "客户名单与到店确认记录完整",
      }),
    });
    assert.equal(reviewed.status, 200);

    const repeatedReview = await call(
      base,
      `/execution/tasks/${ownTaskId}/review`,
      {
        method: "POST",
        body: JSON.stringify({ pass: true }),
      },
    );
    assert.equal(repeatedReview.status, 409);
  });

  assert.equal(
    q.get(`SELECT status FROM tasks WHERE id=?`, ownTaskId).status,
    "已完成",
  );
  const reviewedSubmission = q.get(
    `SELECT result,reviewer_id,reviewed_at,review_reason
    FROM task_submissions WHERE task_id=?`,
    ownTaskId,
  );
  assert.equal(reviewedSubmission.result, "通过");
  assert.equal(reviewedSubmission.reviewer_id, boss.id);
  assert.ok(reviewedSubmission.reviewed_at);
  assert.equal(reviewedSubmission.review_reason, "客户名单与到店确认记录完整");
});

test("已完成任务只能由管理层说明原因后重开，重提与驳回保留结构化审计", async () => {
  let taskId;
  await withServer(boss, async (base) => {
    const created = await call(base, "/execution/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "重开审计任务", assignee_id: salesA.id }),
    });
    taskId = created.json.id;
  });
  await withServer(salesA, async (base) => {
    assert.equal(
      (
        await call(base, `/execution/tasks/${taskId}`, {
          method: "PUT",
          body: JSON.stringify({ status: "进行中" }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(base, `/execution/tasks/${taskId}/submit`, {
          method: "POST",
          body: JSON.stringify({ content: "首轮交付" }),
        })
      ).status,
      200,
    );
  });
  await withServer(boss, async (base) => {
    assert.equal(
      (
        await call(base, `/execution/tasks/${taskId}/review`, {
          method: "POST",
          body: JSON.stringify({ pass: true, reason: "首轮通过" }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(base, `/execution/tasks/${taskId}`, {
          method: "PUT",
          body: JSON.stringify({ status: "进行中" }),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call(base, `/execution/tasks/${taskId}/reopen`, {
          method: "POST",
          body: JSON.stringify({}),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(base, `/execution/tasks/${taskId}/reopen`, {
          method: "POST",
          body: JSON.stringify({ reason: "客户新增了补充材料要求" }),
        })
      ).status,
      200,
    );
  });
  assert.equal(
    q.get(`SELECT status,done_at FROM tasks WHERE id=?`, taskId).status,
    "进行中",
  );
  assert.equal(
    q.get(`SELECT status,done_at FROM tasks WHERE id=?`, taskId).done_at,
    null,
  );

  await withServer(salesA, async (base) => {
    assert.equal(
      (
        await call(base, `/execution/tasks/${taskId}/submit`, {
          method: "POST",
          body: JSON.stringify({ content: "补充交付" }),
        })
      ).status,
      200,
    );
  });
  await withServer(boss, async (base) => {
    assert.equal(
      (
        await call(base, `/execution/tasks/${taskId}/review`, {
          method: "POST",
          body: JSON.stringify({ pass: false, reason: "仍缺客户签字页" }),
        })
      ).status,
      200,
    );
  });
  const latest = q.get(
    `SELECT result,reviewer_id,reviewed_at,review_reason
    FROM task_submissions WHERE task_id=? ORDER BY id DESC LIMIT 1`,
    taskId,
  );
  assert.deepEqual(
    {
      result: latest.result,
      reviewerId: latest.reviewer_id,
      reason: latest.review_reason,
    },
    {
      result: "驳回",
      reviewerId: boss.id,
      reason: "仍缺客户签字页",
    },
  );
  assert.ok(latest.reviewed_at);
  assert.equal(
    q.get(`SELECT status FROM tasks WHERE id=?`, taskId).status,
    "进行中",
  );

  await withServer(salesA, async (base) => {
    const listed = await call(base, "/execution/tasks");
    const returnedTask = listed.json.find((task) => Number(task.id) === Number(taskId));
    assert.equal(returnedTask.workflow_state, "rework");
    assert.equal(returnedTask.display_status, "返工中（人工验收退回）");
    assert.equal(returnedTask.last_submission_result, "驳回");
    assert.equal(returnedTask.last_review_reason, "仍缺客户签字页");
    assert.equal(returnedTask.next_action.code, "resubmit_task");

    const beforeResubmit = await call(base, "/execution/summary");
    assert.equal(beforeResubmit.json.actionableReviewTasks, 0);
    assert.equal(beforeResubmit.json.mySubmittedWaitingReview, 0);

    const resubmitted = await call(base, `/execution/tasks/${taskId}/submit`, {
      method: "POST",
      body: JSON.stringify({ content: "已补齐客户签字页" }),
    });
    assert.equal(resubmitted.status, 200);

    const waiting = await call(base, "/execution/tasks");
    const waitingTask = waiting.json.find((task) => Number(task.id) === Number(taskId));
    assert.equal(waitingTask.workflow_state, "review_pending");
    assert.equal(waitingTask.display_status, "待人工验收");
    assert.equal(waitingTask.last_submission_result, "待审核");
    assert.equal(waitingTask.can_review, false);
    const projectedSubmissions = await call(
      base,
      `/execution/submissions?taskId=${taskId}`,
    );
    assert.equal(projectedSubmissions.json[0].display_result, "待人工验收");
    assert.equal(
      projectedSubmissions.json.find((submission) => submission.result === "驳回")
        .display_result,
      "人工验收退回",
    );

    const afterResubmit = await call(base, "/execution/summary");
    assert.equal(afterResubmit.json.pendingReview, 0);
    assert.equal(afterResubmit.json.mySubmittedWaitingReview, 1);
  });

  await withServer(boss, async (base) => {
    const summary = await call(base, "/execution/summary");
    assert.equal(summary.json.actionableReviewTasks >= 1, true);
    const drill = await call(base, "/execution/drill/pending");
    const reviewable = drill.json.rows.find((task) => Number(task.id) === Number(taskId));
    assert.equal(reviewable.can_review, true);
    assert.equal(reviewable.display_status, "待人工验收");
    assert.equal(
      (
        await call(base, `/execution/tasks/${taskId}/review`, {
          method: "POST",
          body: JSON.stringify({ pass: true, reason: "签字页已补齐" }),
        })
      ).status,
      200,
    );
  });
});

test("分层任务：仅管理层可拆解本人进行中任务，上级须等待下级完成且不能留下孤儿任务", async () => {
  let parentTaskId;
  let childTaskId;

  await withServer(boss, async (base) => {
    const created = await call(base, "/execution/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "老板下达经营目标",
        assignee_id: ops.id,
        type: "经营目标",
      }),
    });
    assert.equal(created.status, 200);
    parentTaskId = created.json.id;

    const cannotStartForOps = await call(
      base,
      `/execution/tasks/${parentTaskId}`,
      {
        method: "PUT",
        body: JSON.stringify({ status: "进行中" }),
      },
    );
    assert.equal(cannotStartForOps.status, 403);
  });

  await withServer(ops, async (base) => {
    const beforeStart = await call(base, "/execution/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "不应提前拆解",
        assignee_id: salesA.id,
        parent_task_id: parentTaskId,
      }),
    });
    assert.equal(beforeStart.status, 409);

    const started = await call(base, `/execution/tasks/${parentTaskId}`, {
      method: "PUT",
      body: JSON.stringify({ status: "进行中" }),
    });
    assert.equal(started.status, 200);
  });

  await withServer(salesA, async (base) => {
    const employeeCannotDecompose = await call(base, "/execution/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "员工越权拆解",
        parent_task_id: parentTaskId,
      }),
    });
    assert.equal(employeeCannotDecompose.status, 403);
  });

  await withServer(ops, async (base) => {
    const selfAssigned = await call(base, "/execution/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "无意义同人拆解",
        assignee_id: ops.id,
        parent_task_id: parentTaskId,
      }),
    });
    assert.equal(selfAssigned.status, 409);
    assert.match(selfAssigned.json.error, /其他执行人/u);

    const created = await call(base, "/execution/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "员工执行门店数据核验",
        detail: "完成门店经营数据核验并回传结论",
        assignee_id: salesA.id,
        parent_task_id: parentTaskId,
      }),
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.parentTaskId, parentTaskId);
    childTaskId = created.json.id;

    const parentCannotFinishEarly = await call(
      base,
      `/execution/tasks/${parentTaskId}/submit`,
      {
        method: "POST",
        body: JSON.stringify({ content: "不应绕过下级任务" }),
      },
    );
    assert.equal(parentCannotFinishEarly.status, 409);
    assert.match(parentCannotFinishEarly.json.error, /下级任务未完成/u);

    const cannotStartForEmployee = await call(
      base,
      `/execution/tasks/${childTaskId}`,
      {
        method: "PUT",
        body: JSON.stringify({ status: "进行中" }),
      },
    );
    assert.equal(cannotStartForEmployee.status, 403);
  });

  const persistedChild = {
    ...q.get(
      `SELECT parent_task_id,assigned_by,assignee_id,source,status
    FROM tasks WHERE id=?`,
      childTaskId,
    ),
  };
  assert.deepEqual(persistedChild, {
    parent_task_id: parentTaskId,
    assigned_by: ops.id,
    assignee_id: salesA.id,
    source: "任务拆解",
    status: "待执行",
  });

  await withServer(boss, async (base) => {
    const cannotOrphan = await call(base, `/execution/tasks/${parentTaskId}`, {
      method: "DELETE",
    });
    assert.equal(cannotOrphan.status, 409);
    assert.match(cannotOrphan.json.error, /下级任务/u);
  });

  await withServer(salesB, async (base) => {
    const peerCannotStart = await call(
      base,
      `/execution/tasks/${childTaskId}`,
      {
        method: "PUT",
        body: JSON.stringify({ status: "进行中" }),
      },
    );
    assert.equal(peerCannotStart.status, 403);
  });

  await withServer(salesA, async (base) => {
    assert.equal(
      (
        await call(base, `/execution/tasks/${childTaskId}`, {
          method: "PUT",
          body: JSON.stringify({ status: "进行中" }),
        })
      ).status,
      200,
    );
  });
  await withServer(ops, async (base) => {
    assert.equal(
      (
        await call(base, `/execution/tasks/${parentTaskId}/submit`, {
          method: "POST",
          body: JSON.stringify({ content: "下级进行中时不应提交" }),
        })
      ).status,
      409,
    );
  });
  await withServer(salesA, async (base) => {
    assert.equal(
      (
        await call(base, `/execution/tasks/${childTaskId}/submit`, {
          method: "POST",
          body: JSON.stringify({ content: "首轮核验结果" }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(base, `/execution/tasks/${childTaskId}/review`, {
          method: "POST",
          body: JSON.stringify({ pass: true }),
        })
      ).status,
      403,
    );
  });

  await withServer(ops, async (base) => {
    assert.equal(
      (
        await call(base, `/execution/tasks/${parentTaskId}/submit`, {
          method: "POST",
          body: JSON.stringify({ content: "下级待审核时不应提交" }),
        })
      ).status,
      409,
    );
  });

  await withServer(ops, async (base) => {
    assert.equal(
      (
        await call(base, `/execution/tasks/${childTaskId}/review`, {
          method: "POST",
          body: JSON.stringify({ pass: false, reason: "缺少原始凭证" }),
        })
      ).status,
      200,
    );
  });
  assert.equal(
    q.get("SELECT status FROM tasks WHERE id=?", childTaskId).status,
    "进行中",
  );

  await withServer(salesA, async (base) => {
    assert.equal(
      (
        await call(base, `/execution/tasks/${childTaskId}/submit`, {
          method: "POST",
          body: JSON.stringify({ content: "已补齐原始凭证" }),
        })
      ).status,
      200,
    );
  });
  await withServer(ops, async (base) => {
    assert.equal(
      (
        await call(base, `/execution/tasks/${childTaskId}/review`, {
          method: "POST",
          body: JSON.stringify({ pass: true, reason: "证据完整" }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(base, `/execution/tasks/${parentTaskId}/submit`, {
          method: "POST",
          body: JSON.stringify({ content: "管理层汇总员工结论" }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(base, `/execution/tasks/${parentTaskId}/review`, {
          method: "POST",
          body: JSON.stringify({ pass: true, reason: "运营总监不可自审" }),
        })
      ).status,
      403,
    );
  });
  await withServer(ops, async (base) => {
    assert.equal(
      (
        await call(base, `/execution/tasks/${childTaskId}/reopen`, {
          method: "POST",
          body: JSON.stringify({ reason: "老板终审前发现需补签" }),
        })
      ).status,
      200,
    );
  });
  await withServer(boss, async (base) => {
    const cannotApproveWhileChildReopened = await call(
      base,
      `/execution/tasks/${parentTaskId}/review`,
      {
        method: "POST",
        body: JSON.stringify({ pass: true, reason: "不应通过" }),
      },
    );
    assert.equal(cannotApproveWhileChildReopened.status, 409);
    assert.match(cannotApproveWhileChildReopened.json.error, /不能验收通过/u);
  });
  await withServer(salesA, async (base) => {
    assert.equal(
      (
        await call(base, `/execution/tasks/${childTaskId}/submit`, {
          method: "POST",
          body: JSON.stringify({ content: "已补齐终审前签字页" }),
        })
      ).status,
      200,
    );
  });
  await withServer(ops, async (base) => {
    assert.equal(
      (
        await call(base, `/execution/tasks/${childTaskId}/review`, {
          method: "POST",
          body: JSON.stringify({ pass: true, reason: "补签完成" }),
        })
      ).status,
      200,
    );
  });
  await withServer(boss, async (base) => {
    assert.equal(
      (
        await call(base, `/execution/tasks/${parentTaskId}/review`, {
          method: "POST",
          body: JSON.stringify({ pass: true, reason: "经营目标闭环" }),
        })
      ).status,
      200,
    );
  });

  assert.equal(
    q.get("SELECT status FROM tasks WHERE id=?", childTaskId).status,
    "已完成",
  );
  assert.equal(
    q.get("SELECT status FROM tasks WHERE id=?", parentTaskId).status,
    "已完成",
  );
  await withServer(ops, async (base) => {
    const childReopenDenied = await call(
      base,
      `/execution/tasks/${childTaskId}/reopen`,
      {
        method: "POST",
        body: JSON.stringify({ reason: "不应制造父完成子进行中" }),
      },
    );
    assert.equal(childReopenDenied.status, 409);
    assert.match(childReopenDenied.json.error, /先重开上级任务/u);
  });
  assert.deepEqual(
    q
      .all(
        `SELECT result,reviewer_id,review_reason FROM task_submissions
    WHERE task_id=? ORDER BY id`,
        childTaskId,
      )
      .map((row) => ({ ...row })),
    [
      { result: "驳回", reviewer_id: ops.id, review_reason: "缺少原始凭证" },
      { result: "通过", reviewer_id: ops.id, review_reason: "证据完整" },
      { result: "通过", reviewer_id: ops.id, review_reason: "补签完成" },
    ],
  );
});

test("合伙人经营数据：员工无权读取或录入，管理层可录入并查看", async () => {
  const partnerId = q.run(
    `INSERT INTO partners(name,level,region,status) VALUES('魏红','馆主','天津','活跃')`,
  ).lastInsertRowid;

  await withServer(salesA, async (base) => {
    const list = await call(base, "/execution/partners");
    assert.equal(list.status, 403);

    const checkin = await call(base, "/execution/partner-actions", {
      method: "POST",
      body: JSON.stringify({
        partner_id: partnerId,
        date: "2026-06-20",
        studied: true,
        invite_count: 1,
      }),
    });
    assert.equal(checkin.status, 403);
  });

  await withServer(boss, async (base) => {
    const checkin = await call(base, "/execution/partner-actions", {
      method: "POST",
      body: JSON.stringify({
        partner_id: partnerId,
        date: "2026-06-20",
        studied: true,
        invite_count: 1,
        arrive_count: 1,
      }),
    });
    assert.equal(checkin.status, 200);
    assert.ok(checkin.json.score > 0);

    const tiers = await call(base, "/execution/partners/tiers");
    assert.equal(tiers.status, 200);
    assert.equal(tiers.json.total, 1);
  });
});

test("经营目标缺失或为0时不伪造完成率，并返回可解释状态", async () => {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = `${year}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const quarter = `${year}-Q${Math.ceil((now.getMonth() + 1) / 3)}`;
  q.run(
    `DELETE FROM goals WHERE tenant_id=1 AND period IN (?,?,?)`,
    year,
    quarter,
    month,
  );

  await withServer(boss, async (base) => {
    const missing = await call(base, "/execution/goals");
    assert.equal(missing.status, 200);
    assert.equal(missing.json.length, 3);
    for (const goal of missing.json) {
      assert.equal(goal.target, 0);
      assert.equal(goal.rate, null);
      assert.equal(goal.risk, null);
      assert.equal(goal.status, "missing");
      assert.match(goal.statusText, /尚未设置/);
    }

    const summary = await call(base, "/execution/summary");
    assert.equal(summary.status, 200);
    assert.equal(summary.json.goalRate, null);
    assert.equal(summary.json.goalStatus, "missing");
    assert.match(summary.json.goalStatusText, /尚未设置月度经营目标/);
  });

  q.run(
    `INSERT INTO goals(period,revenue_target,tenant_id) VALUES(?,?,1)`,
    month,
    0,
  );
  q.run(`INSERT INTO sys_config(key,value) VALUES('month_revenue_target:1','0')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  await withServer(boss, async (base) => {
    const zero = await call(base, "/execution/goals");
    assert.equal(zero.status, 200);
    const monthGoal = zero.json.find((item) => item.period === month);
    assert.equal(monthGoal.target, 0);
    assert.equal(monthGoal.rate, null);
    assert.equal(monthGoal.risk, null);
    assert.equal(monthGoal.status, "zero");
    assert.match(monthGoal.statusText, /目标为0/);

    const summary = await call(base, "/execution/summary");
    assert.equal(summary.json.goalRate, null);
    assert.equal(summary.json.goalStatus, "zero");
    assert.match(summary.json.goalStatusText, /目标为0/);

    const drill = await call(base, "/execution/goals-drill");
    assert.equal(drill.json.month.rate, null);
    assert.equal(drill.json.month.status, "zero");
    assert.equal(drill.json.month.gap, null);
    assert.equal(drill.json.month.needDealsPerDay, null);
    assert.equal(drill.json.month.inviteTarget, null);
  });

  q.run(`DELETE FROM sys_config WHERE key='month_revenue_target:1'`);
  q.run(
    `DELETE FROM goals WHERE tenant_id=1 AND period IN (?,?,?)`,
    year,
    quarter,
    month,
  );
});

test("公司目标与今日作战计划：仅管理层可查看和确认，员工只保留本人任务汇总", async () => {
  q.run(
    `INSERT OR REPLACE INTO sys_config(key,value) VALUES('month_revenue_target','500000')`,
  );
  q.run(
    `INSERT INTO goals(period,revenue_target,tenant_id) VALUES(?,?,1)`,
    "2026-06",
    500000,
  );
  q.run(`INSERT OR IGNORE INTO daily_ops(date,content_count,new_leads,invited,arrived,deals,deal_amount,tenant_id)
    VALUES('2026-06-20',8,9,6,3,1,12000,1)`);
  q.run(
    `INSERT INTO leads(name,phone,source,identity_tag,budget_level,stage,score,grade,owner_id,next_follow_at,tenant_id)
    VALUES('赵玲','13900000001','品鉴会','企业主','高','已邀约',88,'A',?,datetime('now','-1 day'),1)`,
    salesA.id,
  );
  q.run(
    `INSERT INTO leads(name,phone,source,identity_tag,budget_level,stage,score,grade,owner_id,next_follow_at,tenant_id)
    VALUES('罗明','13900000002','转介绍','企业主','高','已沟通',82,'A',?,datetime('now','+1 day'),1)`,
    salesA.id,
  );
  q.run(
    `INSERT INTO partners(name,level,region,status,tenant_id) VALUES('魏红','馆主','天津','活跃',1)`,
  );

  const beforeDeniedConfirm = q.get(
    `SELECT COUNT(*) n FROM tasks WHERE tenant_id=1 AND assignee_id=? AND source=?`,
    salesA.id,
    "作战计划",
  ).n;
  await withServer(salesA, async (base) => {
    const summary = await call(base, "/execution/summary");
    assert.equal(summary.status, 200);
    assert.equal(Object.hasOwn(summary.json, "goalRate"), false);
    assert.equal(Object.hasOwn(summary.json, "goalTarget"), false);
    assert.equal(Object.hasOwn(summary.json, "goalStatus"), false);

    for (const path of [
      "/execution/goals",
      "/execution/goals-drill",
      "/execution/battle-plan/today",
    ]) {
      const denied = await call(base, path);
      assert.equal(
        denied.status,
        403,
        `${path} must not expose company strategy to staff`,
      );
    }
    const deniedConfirm = await call(base, "/execution/battle-plan/confirm", {
      method: "POST",
      body: JSON.stringify({ index: 0 }),
    });
    assert.equal(deniedConfirm.status, 403);
    const deniedGenerate = await call(base, "/execution/battle-plan/generate", {
      method: "POST",
      body: "{}",
    });
    assert.equal(deniedGenerate.status, 403);

    // 员工仍可读取严格按本人任务投影的历史闭环，但前端不展示公司作战计划区。
    const rollup = await call(base, "/execution/battle-plan/rollup");
    assert.equal(rollup.status, 200);
    assert.match(rollup.json.scope, /员工视角/);
    assert.ok(
      rollup.json.today.rows.every((row) => row.assignee_id === salesA.id),
    );
  });
  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM tasks WHERE tenant_id=1 AND assignee_id=? AND source=?`,
      salesA.id,
      "作战计划",
    ).n,
    beforeDeniedConfirm,
  );

  let plan;
  for (const actor of [boss, ops, manager, admin]) {
    await withServer(actor, async (base) => {
      const visible = await call(base, "/execution/battle-plan/today");
      assert.equal(
        visible.status,
        200,
        `${actor.role} should be allowed by isManager`,
      );
      assert.equal(visible.json.planVersion, BATTLE_PLAN_VERSION);
      plan ||= visible.json;
    });
  }

  const byType = Object.fromEntries(plan.tasks.map((t) => [t.type, t]));
  assert.match(byType["内容"].basis.source, /不直接按销售回款额/);
  assert.match(byType["邀约"].basis.formula, /邀约到店率/);
  assert.match(byType["跟进"].basis.formula, /A类客户/);
  assert.match(byType["培训"].basis.source, /协作伙伴活跃分层/);

  await withServer(boss, async (base) => {
    const confirmed = await call(base, "/execution/battle-plan/confirm", {
      method: "POST",
      body: JSON.stringify({ index: 0 }),
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.json.created, 1);
    assert.equal(confirmed.json.confirmation.items[0].confirmed, true);
    assert.equal(confirmed.json.confirmation.confirmed, false);

    const repeated = await call(base, "/execution/battle-plan/confirm", {
      method: "POST",
      body: JSON.stringify({ index: 0 }),
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.json.created, 0);
    assert.equal(repeated.json.existing, 1);

    const confirmedAll = await call(base, "/execution/battle-plan/confirm", {
      method: "POST",
      body: "{}",
    });
    assert.equal(confirmedAll.status, 200);
    assert.equal(confirmedAll.json.created, plan.tasks.length - 1);
    assert.equal(confirmedAll.json.confirmation.confirmed, true);

    const list = await call(base, "/execution/tasks");
    assert.equal(list.status, 200);
    const planTaskTitles = new Set(plan.tasks.map((t) => t.action));
    const pendingPlanTasks = list.json.filter(
      (t) => planTaskTitles.has(t.title) && t.status === "待执行",
    );
    assert.equal(pendingPlanTasks.length, plan.tasks.length);

    const rollup = await call(base, "/execution/battle-plan/rollup");
    assert.equal(rollup.status, 200);
    assert.match(rollup.json.scope, /管理层视角/);
    assert.ok(rollup.json.today.total >= plan.tasks.length);
    assert.ok(rollup.json.today.rows.length >= plan.tasks.length);
    assert.ok(rollup.json.week.total >= plan.tasks.length);
    assert.ok(rollup.json.month.total >= plan.tasks.length);

    const score = await call(base, "/execution/drill/exec-score");
    assert.equal(score.status, 200);
    assert.equal(score.json.formula.steps.length, 4);
    assert.ok(score.json.formula.steps.some((x) => x.key === "submit"));
    assert.ok(Array.isArray(score.json.processRows));

    const regen = await call(base, "/execution/battle-plan/generate", {
      method: "POST",
      body: "{}",
    });
    assert.equal(regen.status, 200);
  });
});

test("cleanup", () => {
  for (const file of writtenFiles) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
  for (const f of [DBP, DBP + "-wal", DBP + "-shm"]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {}
  }
});

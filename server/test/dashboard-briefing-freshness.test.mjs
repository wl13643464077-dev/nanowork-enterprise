import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import express from "express";

const DBP = path.join(
  os.tmpdir(),
  `nanowork-dashboard-briefing-freshness-${process.pid}.db`,
);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";

const { initSchema, migrateV2, q, runWithTenant } = await import(
  "../src/db.js"
);
const { hashPassword, today, daysAgo } = await import("../src/util.js");
const { BATTLE_PLAN_VERSION, generateBattlePlan } = await import(
  "../src/engines/plans.js"
);
const dashboardRoutes = (await import("../src/routes/dashboard.js")).default;
const executionRoutes = (await import("../src/routes/execution.js")).default;

initSchema();
migrateV2();

q.run(
  `INSERT INTO users(username,password_hash,name,role,dept,tenant_id)
   VALUES(?,?,?,?,?,1)`,
  "briefing-boss",
  hashPassword("123456"),
  "简报测试老板",
  "boss",
  "决策层",
);
const boss = q.get(
  `SELECT id,name,role,tenant_id FROM users WHERE username='briefing-boss'`,
);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) =>
    runWithTenant(1, () => {
      req.user = boss;
      next();
    }),
  );
  app.use("/dashboard", dashboardRoutes);
  app.use("/execution", executionRoutes);
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0);
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("经营简报实时反映当前审批和老板介入线索，GET 不改写已生成作战计划", async () => {
  const approvalIds = [];
  for (let index = 1; index <= 8; index += 1) {
    approvalIds.push(
      Number(
        q.run(
          `INSERT INTO approvals(
             target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id
           ) VALUES('ai_message',?,?,?,?,?,'待审核',?)`,
          index,
          `历史待审${index}`,
          "历史摘要",
          "high",
          "[]",
          boss.id,
        ).lastInsertRowid,
      ),
    );
  }
  const oldLeadId = Number(
    q.run(
      `INSERT INTO leads(name,stage,score,boss_alert,owner_id)
       VALUES('旧的老板介入客户','已沟通',88,1,?)`,
      boss.id,
    ).lastInsertRowid,
  );

  // 先落一份当时真实、但随后会变陈旧的作战计划。
  generateBattlePlan(today());
  const initiallyGenerated = q.get(
    `SELECT plan FROM battle_plans WHERE tenant_id=1 AND date=?`,
    today(),
  );
  const stalePlan = JSON.parse(initiallyGenerated.plan);
  stalePlan.bossItems = [
    "8 条高风险内容待终审（含价格/收益类表达）",
    "建议亲自跟进大客户「旧的老板介入客户」（成交概率 88 分）",
  ];
  stalePlan.yesterday = {
    newLeads: 0,
    invited: 0,
    arrived: 0,
    deals: 0,
    amount: 0,
  };
  q.run(
    `UPDATE battle_plans SET plan=? WHERE tenant_id=1 AND date=?`,
    JSON.stringify(stalePlan),
    today(),
  );
  const storedBefore = q.get(
    `SELECT plan,created_at FROM battle_plans WHERE tenant_id=1 AND date=?`,
    today(),
  );
  assert.match(storedBefore.plan, /8 条高风险内容待终审/);

  // 业务状态在计划生成后变化：只剩1条待审，老线索结案，并产生新的老板介入线索/昨日经营数据。
  q.run(
    `UPDATE approvals SET status='已通过',decided_at=datetime('now','localtime')
     WHERE tenant_id=1 AND id<>?`,
    approvalIds.at(-1),
  );
  q.run(`UPDATE leads SET stage='已成交' WHERE tenant_id=1 AND id=?`, oldLeadId);
  q.run(
    `INSERT INTO leads(name,stage,score,boss_alert,owner_id)
     VALUES('新的老板介入客户','已邀约',93,1,?)`,
    boss.id,
  );
  q.run(
    `INSERT INTO daily_ops(date,new_leads,invited,arrived,deals,deal_amount)
     VALUES(?,?,?,?,?,?)`,
    daysAgo(1),
    9,
    7,
    4,
    2,
    6800,
  );

  await withServer(async (base) => {
    const endpoints = [
      "/dashboard/briefing",
      "/execution/battle-plan/today",
    ];
    for (const endpoint of endpoints) {
      const response = await fetch(`${base}${endpoint}`);
      const briefing = await response.json();
      assert.equal(response.status, 200, endpoint);
      assert.deepEqual(
        briefing.yesterday,
        {
          newLeads: 9,
          invited: 7,
          arrived: 4,
          deals: 2,
          amount: 6800,
        },
        endpoint,
      );
      assert.equal(
        briefing.bossItems.filter((item) => item.includes("待审")).length,
        1,
        endpoint,
      );
      assert.match(briefing.bossItems.join("\n"), /1 条.*待审/, endpoint);
      assert.doesNotMatch(briefing.bossItems.join("\n"), /8 条/, endpoint);
      assert.match(
        briefing.bossItems.join("\n"),
        /新的老板介入客户/,
        endpoint,
      );
      assert.doesNotMatch(
        briefing.bossItems.join("\n"),
        /旧的老板介入客户/,
        endpoint,
      );
    }
  });

  const storedAfter = q.get(
    `SELECT plan,created_at FROM battle_plans WHERE tenant_id=1 AND date=?`,
    today(),
  );
  assert.deepEqual(
    storedAfter,
    storedBefore,
    "读取经营简报不应暗中改写今日作战计划",
  );
});

test("旧 v2 计划只升级一次，并替换与状态机冲突的完成口径", async () => {
  const current = q.get(
    `SELECT plan FROM battle_plans WHERE tenant_id=1 AND date=?`,
    today(),
  );
  const legacy = JSON.parse(current.plan);
  legacy.planVersion = 2;
  legacy.tasks[0].check = "素材全部进入待审核/可使用状态";
  legacy.tasks[0].basis.rules[2] =
    "检查标准看素材是否进入待审核/可使用状态。";
  q.run(
    `UPDATE battle_plans SET plan=? WHERE tenant_id=1 AND date=?`,
    JSON.stringify(legacy),
    today(),
  );

  await withServer(async (base) => {
    const dashboard = await fetch(`${base}/dashboard/briefing`).then((response) =>
      response.json(),
    );
    assert.equal(dashboard.planVersion, BATTLE_PLAN_VERSION);
    assert.match(dashboard.tasks[0].check, /质检通过/);
    assert.doesNotMatch(dashboard.tasks[0].check, /待审核\/可使用/);
    assert.equal(
      JSON.parse(
        q.get(
          `SELECT plan FROM battle_plans WHERE tenant_id=1 AND date=?`,
          today(),
        ).plan,
      ).planVersion,
      2,
      "简报 GET 只读升级，不暗中写库",
    );

    const executionResponse = await fetch(
      `${base}/execution/battle-plan/today`,
    );
    const execution = await executionResponse.json();
    assert.equal(executionResponse.status, 200);
    assert.equal(execution.planVersion, BATTLE_PLAN_VERSION);
    assert.match(execution.tasks[0].check, /质检通过/);
    assert.doesNotMatch(execution.tasks[0].check, /待审核\/可使用/);

    const upgraded = q.get(
      `SELECT plan,created_at FROM battle_plans WHERE tenant_id=1 AND date=?`,
      today(),
    );
    assert.equal(JSON.parse(upgraded.plan).planVersion, BATTLE_PLAN_VERSION);
    await fetch(`${base}/execution/battle-plan/today`);
    assert.deepEqual(
      q.get(
        `SELECT plan,created_at FROM battle_plans WHERE tenant_id=1 AND date=?`,
        today(),
      ),
      upgraded,
      "v3 已升级后的每次 GET 不应重写计划",
    );
  });
});

test("cleanup", () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import express from "express";

process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
const DBP = path.join(
  os.tmpdir(),
  `nw-team-match-${process.pid}-${Date.now()}.db`,
);
process.env.NANOWORK_DB = DBP;

const { db, q, initSchema, migrateV2, runWithTenant } = await import(
  "../src/db.js"
);
const { default: employeesRouter } = await import(
  "../src/routes/employees.js"
);

initSchema();
migrateV2();

q.run(`INSERT INTO tenants(id,name,status,credits)
  VALUES(1,'一句话找人验收企业','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET credits=excluded.credits`);
const bossId = Number(
  q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('team-match-boss','x','找人老板','boss','启用',1)`,
  ).lastInsertRowid,
);
const marshalId = Number(
  q.run(
    `INSERT INTO marshals(code,name,title,emoji,online,sort)
  VALUES('M-01','战略与开店筹备部','元帅','🧭',1,1)`,
  ).lastInsertRowid,
);
const ROSTER = [
  [101, "market", "研市场", "餐饮市场机会研究", "评估商圈与开店机会"],
  [102, "compete", "钱商圈", "商圈与竞品洞察", "盯竞品价格产品口碑变化"],
  [103, "plan", "唐筹备", "开店筹备计划", "把开店筹备拆成可执行清单"],
];
for (const [idx, key, person, name, duty] of ROSTER) {
  q.run(
    `INSERT INTO specialists(
    marshal_id,name,duty,employee_idx,key,person,emoji,description,profile_json,group_name,sort
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    marshalId,
    name,
    duty,
    idx,
    key,
    person,
    "🧑‍💼",
    duty,
    JSON.stringify({ color: "#3b74d1" }),
    "战略与开店筹备部",
    idx - 100,
  );
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    runWithTenant(1, () => {
      req.user = { id: bossId, name: "找人老板", role: "boss", tenant_id: 1 };
      next();
    });
  });
  app.use("/employees", employeesRouter);
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

async function postMatch(base, body) {
  const response = await fetch(`${base}/employees/match-team`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

after(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
});

test("空输入直接400，未配置真实AI通道时503且不冒充规则匹配", async () => {
  delete process.env.YUNWU_API_KEY;
  delete process.env.YUNWU_BASE_URL;
  await withServer(async (base) => {
    const empty = await postMatch(base, { text: "  " });
    assert.equal(empty.response.status, 400);
    const noProvider = await postMatch(base, { text: "帮我做周年庆活动" });
    assert.equal(noProvider.response.status, 503);
    assert.match(noProvider.payload.error, /不会用规则结果冒充/u);
  });
  const holdTable = q.get(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='credit_holds'`,
  );
  assert.equal(
    holdTable
      ? q.get(`SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=1`).n
      : 0,
    0,
    "未进入模型生成不得产生任何占扣",
  );
});

test("真实模型返回合法小队：目录字段回填、恰好一名队长、非法idx被剔除、计费结算闭环", async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                teamName: "周年庆引流小队",
                summary: "先研判商圈再出筹备与竞品对策，最后合并成引流方案。",
                members: [
                  {
                    idx: 101,
                    roleInTeam: "队长",
                    task: "统筹周年庆整体目标与预算，收敛两位成员的产出",
                    why: "负责市场机会研究，适合定盘子",
                    dependsOn: [102, 103],
                  },
                  {
                    idx: 102,
                    roleInTeam: "成员",
                    task: "盘点周边竞品近期活动与价格动作",
                    why: "岗位职责就是盯竞品变化",
                    dependsOn: [],
                  },
                  {
                    idx: 103,
                    roleInTeam: "成员",
                    task: "把活动拆成可执行的筹备清单",
                    why: "开店筹备计划岗位擅长拆解落地",
                    dependsOn: [102],
                  },
                  {
                    idx: 9999,
                    roleInTeam: "成员",
                    task: "不存在的岗位必须被服务端剔除",
                    why: "越权虚构",
                    dependsOn: [],
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 800, completion_tokens: 260 },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.YUNWU_API_KEY = "test-team-match-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  try {
    await withServer(async (base) => {
      const { response, payload } = await postMatch(base, {
        text: "我想给门店做一场周年庆活动，怎么策划引流",
      });
      assert.equal(response.status, 200, JSON.stringify(payload));
      const team = payload.team;
      assert.equal(team.teamName, "周年庆引流小队");
      assert.equal(team.members.length, 3, "花名册外的9999必须被剔除");
      const lead = team.members.filter((m) => m.roleInTeam === "队长");
      assert.equal(lead.length, 1);
      assert.equal(lead[0].idx, 101);
      assert.equal(lead[0].person, "研市场");
      assert.equal(lead[0].group, "战略与开店筹备部");
      assert.ok(String(lead[0].avatar || "").includes("emp-01"));
      const planner = team.members.find((m) => m.idx === 103);
      assert.deepEqual(planner.dependsOn, [102]);
      assert.equal(payload.billing.state, "settled");
      assert.ok(payload.billing.chargedCredits > 0);
      assert.match(payload.boundary, /未创建任务、未派活/u);
    });
    const hold = q.get(
      `SELECT h.*, l.input_tokens, l.output_tokens FROM credit_holds h
      JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
      WHERE h.tenant_id=1 ORDER BY h.id DESC LIMIT 1`,
    );
    assert.equal(hold.status, "settled");
    assert.ok(Number(hold.settled_credits) > 0);
    assert.equal(Number(hold.input_tokens), 800);
    assert.equal(Number(hold.output_tokens), 260);
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("队长拆解：专业档带全员能力清单，briefs覆盖全员并真实结算", async () => {
  let capturedSystem = "";
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      capturedSystem = JSON.parse(body).messages?.find((m) => m.role === "system")?.content || "";
    } catch {
      /* keep empty */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                briefs: [
                  {
                    idx: 101,
                    title: "统筹周年庆目标与预算",
                    directive: "①定盘子②收敛两位成员产出③输出决策方案④【输出标准】老板摘要在前。",
                    deliverables: "一份老板能直接拍板的周年庆方案",
                  },
                  {
                    idx: 102,
                    title: "竞品动作盘点",
                    directive: "①盘点周边竞品近30天活动②给101供料③清单交付④【输出标准】要点清单。",
                    deliverables: "竞品活动与价格动作清单",
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 900, completion_tokens: 400 },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.YUNWU_API_KEY = "test-team-plan-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/employees/team-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "帮门店做周年庆活动",
          depth: "pro",
          members: [
            { idx: 101, roleInTeam: "队长", task: "统筹", dependsOn: [102] },
            { idx: 102, roleInTeam: "成员", task: "盯竞品", dependsOn: [] },
            { idx: 9999, roleInTeam: "成员", task: "越权虚构", dependsOn: [] },
          ],
        }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      assert.equal(payload.plan.depth, "pro");
      assert.equal(payload.plan.leadIdx, 101);
      assert.equal(payload.plan.briefs.length, 2, "9999不在花名册，不得进入拆解");
      const leadBrief = payload.plan.briefs.find((b) => b.idx === 101);
      assert.equal(leadBrief.person, "研市场");
      assert.equal(leadBrief.roleInTeam, "队长");
      assert.match(leadBrief.directive, /输出标准/u);
      assert.equal(payload.billing.state, "settled");
      assert.ok(payload.billing.chargedCredits > 0);
      assert.match(payload.boundary, /尚未创建任何任务/u);
      // 专业档必须把成员的全部能力清单交给队长逐项运用
      assert.match(capturedSystem, /全部能力\(/u);
      assert.match(capturedSystem, /深度挖掘/u);
    });
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("语音意图整理：真实模型纠错并结算，空结果422退款", async () => {
  let served = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume */
    }
    served += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: served === 1 ? "我想把外卖评分做到4.8，帮我把差评压下去。" : "",
            },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 40 },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.YUNWU_API_KEY = "test-voice-intent-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  const balanceBefore = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  try {
    await withServer(async (base) => {
      const ok = await fetch(`${base}/employees/voice-intent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "嗯那个外卖平分做到四点八差评帮我压一压" }),
      });
      const okPayload = await ok.json();
      assert.equal(ok.status, 200, JSON.stringify(okPayload));
      assert.equal(okPayload.text, "我想把外卖评分做到4.8，帮我把差评压下去。");
      assert.equal(okPayload.billing.state, "settled");
      assert.ok(okPayload.billing.chargedCredits > 0);

      const empty = await fetch(`${base}/employees/voice-intent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "嗯那个再来一句" }),
      });
      const emptyPayload = await empty.json();
      assert.equal(empty.status, 502, JSON.stringify(emptyPayload));
    });
    const settledDelta =
      balanceBefore - q.get("SELECT credits FROM tenants WHERE id=1").credits;
    assert.ok(settledDelta > 0, "成功那次真实扣费");
    const lastHold = q.get(
      "SELECT * FROM credit_holds WHERE tenant_id=1 ORDER BY id DESC LIMIT 1",
    );
    assert.equal(Number(lastHold.settled_credits), 0, "空结果那次全额退款");
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("队长拆解缺成员时422失败并全额退款，不交付残缺分工", async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                briefs: [
                  {
                    idx: 101,
                    title: "只拆了队长自己",
                    directive: "遗漏了102的分工。【输出标准】略。",
                    deliverables: "残缺方案",
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 500, completion_tokens: 120 },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.YUNWU_API_KEY = "test-team-plan-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  const balanceBefore = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/employees/team-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "帮门店做周年庆活动",
          depth: "simple",
          members: [
            { idx: 101, roleInTeam: "队长", task: "统筹", dependsOn: [] },
            { idx: 102, roleInTeam: "成员", task: "盯竞品", dependsOn: [] },
          ],
        }),
      });
      const payload = await response.json();
      assert.equal(response.status, 422, JSON.stringify(payload));
      assert.match(payload.error, /缺少成员/u);
    });
    assert.equal(
      q.get("SELECT credits FROM tenants WHERE id=1").credits,
      balanceBefore,
      "拆解失败后余额不变",
    );
    const invalidDepth = await withServer(async (base) => {
      const response = await fetch(`${base}/employees/team-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "随便", depth: "extreme", members: [{ idx: 101 }] }),
      });
      return response.status;
    });
    assert.equal(invalidDepth, 400);
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("队长收尾汇总：读取真实任务产出，未交付成员如实标注", async () => {
  // 造两个真实任务：101 已完成有产出，102 仍在生成
  const contentId = Number(
    q.run(
      `INSERT INTO contents(type,title,body,status,ai_mode,creator_id,tenant_id)
       VALUES('作战计划','周年庆统筹方案','结论：预算2万，主打两人套餐；第一周先做私域预热。','可使用','api',?,1)`,
      bossId,
    ).lastInsertRowid,
  );
  const specialist101 = q.get(
    'SELECT id FROM specialists WHERE employee_idx=101',
  );
  const specialist102 = q.get(
    'SELECT id FROM specialists WHERE employee_idx=102',
  );
  const doneTask = Number(
    q.run(
      `INSERT INTO agent_tasks(marshal_id,specialist_id,title,status,output_id,created_by,tenant_id)
       VALUES(?,?,'统筹周年庆','已完成',?,?,1)`,
      marshalId,
      specialist101.id,
      contentId,
      bossId,
    ).lastInsertRowid,
  );
  const runningTask = Number(
    q.run(
      `INSERT INTO agent_tasks(marshal_id,specialist_id,title,status,created_by,tenant_id)
       VALUES(?,?,'竞品盘点','生成中',?,1)`,
      marshalId,
      specialist102.id,
      bossId,
    ).lastInsertRowid,
  );
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const system = (() => {
      try {
        return JSON.parse(body).messages?.find((m) => m.role === "system")?.content || "";
      } catch {
        return "";
      }
    })();
    assert.match(system, /预算2万/u, "汇总必须能看到真实产出正文");
    assert.match(system, /尚无产出，如实标注/u);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary:
                  "统筹方案已经定盘：周年庆总预算2万元，主打两人套餐引流，第一周先做私域预热再开公域投放。研市场给出了预算分配与套餐主打方向，可以直接进入执行；竞品盘点仍在执行中，折扣力度要等盘点结论再定，避免和对手同期硬碰。整体离4.8分目标还差竞品应对与执行验证两步。",
                keyNumbers: [
                  { label: "活动总预算", value: "2万元", source: "研市场" },
                  { label: "预热周期", value: "第一周", source: "研市场" },
                ],
                progress: [
                  { idx: 101, highlight: "已定预算2万元与主打两人套餐方向，第一周私域预热的节奏也排好了" },
                  { idx: 102, highlight: "竞品盘点仍在执行" },
                ],
                nextActions: [
                  { action: "确认2万预算", owner: "老板", timing: "今天" },
                  { action: "等竞品盘点后定折扣", owner: "钱商圈", timing: "本周" },
                ],
                risks: "竞品若同期做活动，折扣力度需要重新核",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 700, completion_tokens: 260 },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.YUNWU_API_KEY = "test-team-summary-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/employees/team-summary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "帮门店做周年庆活动",
          items: [
            { idx: 101, taskId: doneTask },
            { idx: 102, taskId: runningTask },
          ],
        }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      const summary = payload.teamSummary;
      assert.match(summary.summary, /预算2万/u);
      assert.ok(summary.summary.length >= 60, "汇报必须有实质篇幅");
      assert.equal(summary.keyNumbers.length, 2);
      assert.equal(summary.keyNumbers[0].value, "2万元");
      assert.equal(summary.keyNumbers[0].source, "研市场");
      assert.equal(summary.progress.length, 2);
      const running = summary.progress.find((row) => row.idx === 102);
      assert.equal(running.hasOutput, false);
      assert.equal(running.statusLabel, "仍在执行");
      assert.ok(summary.nextActions.length >= 2);
      assert.equal(payload.billing.state, "settled");
      assert.match(payload.boundary, /不代替执行/u);
    });
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise((resolve) => upstream.close(resolve));
    q.run("DELETE FROM agent_tasks WHERE id IN (?,?)", doneTask, runningTask);
    q.run("DELETE FROM contents WHERE id=?", contentId);
  }
});

test("模型只挑了花名册外的人时422失败并全额退款，不交付伪小队", async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                teamName: "越权小队",
                summary: "全部成员都不在花名册内。",
                members: [
                  {
                    idx: 8888,
                    roleInTeam: "队长",
                    task: "虚构岗位",
                    why: "不存在",
                    dependsOn: [],
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 500, completion_tokens: 90 },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.YUNWU_API_KEY = "test-team-match-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  const balanceBefore = q.get(
    "SELECT credits FROM tenants WHERE id=1",
  ).credits;
  try {
    await withServer(async (base) => {
      const { response, payload } = await postMatch(base, {
        text: "随便什么活",
      });
      assert.equal(response.status, 422, JSON.stringify(payload));
      assert.match(payload.error, /未匹配到花名册内的员工/u);
    });
    const hold = q.get(
      `SELECT * FROM credit_holds WHERE tenant_id=1 ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(hold.status, "settled");
    assert.equal(Number(hold.settled_credits), 0, "失败必须全额退款");
    assert.equal(
      q.get("SELECT credits FROM tenants WHERE id=1").credits,
      balanceBefore,
      "失败后余额不变",
    );
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise((resolve) => upstream.close(resolve));
  }
});

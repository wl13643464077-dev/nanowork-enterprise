import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import express from "express";

process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
const DBP = path.join(os.tmpdir(), `nw-evolution-${process.pid}-${Date.now()}.db`);
process.env.NANOWORK_DB = DBP;

const { db, q, initSchema, migrateV2, runWithTenant } = await import("../src/db.js");
const { default: employeesRouter } = await import("../src/routes/employees.js");
const {
  activeEvolutionNotes,
  collectEvolutionSignals,
  evolutionNotesPromptLines,
  parseEvolutionProposal,
} = await import("../src/engines/employee-evolution.js");

initSchema();
migrateV2();

q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'进化验收企业','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET credits=excluded.credits`);
const bossId = Number(
  q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
     VALUES('evo-boss','x','进化老板','boss','启用',1)`,
  ).lastInsertRowid,
);
const staffId = Number(
  q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
     VALUES('evo-staff','x','进化员工','sales','启用',1)`,
  ).lastInsertRowid,
);
const marshalId = Number(
  q.run(`INSERT INTO marshals(code,name,title,emoji,online,sort) VALUES('M-01','增长部','元帅','🧭',1,1)`)
    .lastInsertRowid,
);
const specialistId = Number(
  q.run(
    `INSERT INTO specialists(marshal_id,name,duty,employee_idx,key,person,emoji,description,profile_json,group_name,sort)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    marshalId,
    "内容策划",
    "策划门店营销内容",
    101,
    "content",
    "文小策",
    "🧑‍💼",
    "策划门店营销内容",
    JSON.stringify({ color: "#3b74d1" }),
    "增长部",
    1,
  ).lastInsertRowid,
);

// 造验收信号：3 条已完成 + 3 条已驳回（带理由，理由是进化的核心养料）
function seedTask(title, status, reason) {
  const contentId = Number(
    q.run(
      `INSERT INTO contents(tenant_id,type,title,body,status) VALUES(1,'朋友圈文案',?,?,?)`,
      title,
      `${title}正文`,
      status === "已完成" ? "可使用" : "已驳回",
    ).lastInsertRowid,
  );
  q.run(
    `INSERT INTO agent_tasks(tenant_id,marshal_id,specialist_id,title,type,requirement,status,output_id)
     VALUES(1,?,?,?,?,?,?,?)`,
    marshalId,
    specialistId,
    title,
    "内容",
    `${title}的要求`,
    status,
    contentId,
  );
  q.run(
    `INSERT INTO approvals(tenant_id,target_type,target_id,title,status,submitter_id,reviewer_id,reason,decided_at)
     VALUES(1,'content',?,?,?,?,?,?,datetime('now','localtime'))`,
    contentId,
    title,
    status === "已完成" ? "已通过" : "已驳回",
    bossId,
    bossId,
    reason || null,
  );
}
seedTask("五一活动海报文案", "已完成", null);
seedTask("周年庆推文", "已完成", null);
seedTask("新品上市短视频脚本", "已完成", null);
seedTask("会员日朋友圈文案", "已驳回", "太多专业术语，老板要口语化、像老板娘发的朋友圈");
seedTask("店庆抖音文案", "已驳回", "又是术语堆砌，完全不口语化，顾客看不懂");
seedTask("外卖满减推广文案", "已驳回", "文案里编造了「全城第一」这种没依据的说法");

function makeApp(role = "boss") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    runWithTenant(1, () => {
      req.user =
        role === "boss"
          ? { id: bossId, name: "进化老板", role: "boss", tenant_id: 1 }
          : { id: staffId, name: "进化员工", role: "sales", tenant_id: 1 };
      next();
    });
  });
  app.use("/employees", employeesRouter);
  return app;
}

async function withServer(role, fn) {
  const server = makeApp(role).listen(0, "127.0.0.1");
  const port = await new Promise((resolve) => server.once("listening", () => resolve(server.address().port)));
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const jsonCall = async (base, method, pathName, body) => {
  const response = await fetch(`${base}${pathName}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, payload: await response.json() };
};

after(() => {
  try {
    db.close();
  } catch {
    /* closed */
  }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
});

test("信号采集：任务验收记录与驳回理由完整入统计", () => {
  runWithTenant(1, () => {
    const { signals, stats } = collectEvolutionSignals(specialistId);
    assert.equal(stats.total, 6);
    assert.equal(stats.adopted, 3);
    assert.equal(stats.rejected, 3);
    assert.equal(stats.rejectReasons.length, 3, "驳回理由是进化的核心养料，必须全部带上");
    assert.ok(stats.rejectReasons.some((reason) => reason.includes("口语化")));
    const rejected = signals.find((item) => item.title === "会员日朋友圈文案");
    assert.equal(rejected.outcome, "已驳回");
    assert.match(rejected.reason, /口语化/u);
  });
});

test("提案解析：合法JSON通过、围栏剥离、非法输出fail-closed", () => {
  const parsed = parseEvolutionProposal(
    '```json\n{"verdict":"ok","summary":"口语化是主要短板","additions":[{"note":"文案先读一遍，像老板娘口头说的才算过","rationale":"老板连续驳回术语堆砌","evidence":"任务#4/#5"}],"retireNoteIds":[]}\n```',
  );
  assert.equal(parsed.verdict, "ok");
  assert.equal(parsed.additions.length, 1);
  assert.match(parsed.additions[0].note, /老板娘/u);
  assert.throws(() => parseEvolutionProposal("这不是JSON"), /JSON/u);
  assert.throws(
    () => parseEvolutionProposal('{"verdict":"ok","additions":[],"retireNoteIds":[]}'),
    /有效心得/u,
    "verdict=ok 却啥都没提议应拒收",
  );
  const insufficient = parseEvolutionProposal('{"verdict":"insufficient","summary":"样本不足"}');
  assert.equal(insufficient.additions.length, 0);
});

test("进化端点权限：员工403，管理层可读", async () => {
  await withServer("staff", async (base) => {
    const denied = await jsonCall(base, "GET", `/employees/evolution/${specialistId}`);
    assert.equal(denied.status, 403);
  });
  await withServer("boss", async (base) => {
    const ok = await jsonCall(base, "GET", `/employees/evolution/${specialistId}`);
    assert.equal(ok.status, 200, JSON.stringify(ok.payload));
    assert.equal(ok.payload.specialist.name, "内容策划");
    assert.equal(ok.payload.stats.rejected, 3);
  });
});

test("提案生成→人工采纳→心得生效→注入行→退役 全闭环（真实计费）", async () => {
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
                verdict: "ok",
                summary: "口语化与事实依据是两大短板",
                additions: [
                  {
                    note: "写文案前先口头念一遍，像店主本人说话才算过关",
                    rationale: "老板连续驳回术语堆砌的产出，顾客读不懂等于白写",
                    evidence: "会员日朋友圈文案、店庆抖音文案被驳回",
                  },
                  {
                    note: "没有数据依据的最高级表述（全城第一等）一律不写",
                    rationale: "虚假宣传有平台处罚与法律风险，老板明确驳回过",
                    evidence: "外卖满减推广文案被驳回",
                  },
                ],
                retireNoteIds: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 900, completion_tokens: 300 },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.YUNWU_API_KEY = "test-evolution-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  try {
    await withServer("boss", async (base) => {
      const proposed = await jsonCall(base, "POST", `/employees/evolution/${specialistId}/propose`, {});
      assert.equal(proposed.status, 200, JSON.stringify(proposed.payload));
      assert.equal(proposed.payload.proposal.additions.length, 2);
      assert.equal(proposed.payload.billing.state, "settled");
      assert.ok(proposed.payload.billing.chargedCredits > 0, "真实AI调用必须计费");
      assert.match(proposed.payload.boundary, /采纳后才会/u);
      const proposalId = proposed.payload.proposal.id;

      // 已有待审提案时不允许重复生成（防连点重复扣费）
      const dup = await jsonCall(base, "POST", `/employees/evolution/${specialistId}/propose`, {});
      assert.equal(dup.status, 409);

      // 采纳前：无生效心得
      runWithTenant(1, () => {
        assert.equal(activeEvolutionNotes(specialistId).length, 0, "提案未采纳不得影响员工行为");
      });

      const adopted = await jsonCall(base, "POST", `/employees/evolution/proposals/${proposalId}/decide`, {
        decision: "adopt",
      });
      assert.equal(adopted.status, 200, JSON.stringify(adopted.payload));
      assert.equal(adopted.payload.adoptedNotes, 2);

      // 重复处理同一提案 409
      const again = await jsonCall(base, "POST", `/employees/evolution/proposals/${proposalId}/decide`, {
        decision: "reject",
      });
      assert.equal(again.status, 409);

      // 采纳后：心得生效且注入行格式正确（带「为什么」）
      runWithTenant(1, () => {
        const notes = activeEvolutionNotes(specialistId);
        assert.equal(notes.length, 2);
        const lines = evolutionNotesPromptLines(notes);
        assert.match(lines[0], /实战心得/u);
        assert.ok(lines.some((line) => line.includes("口头念一遍") && line.includes("为什么")));
      });

      // 退役一条后不再注入
      const detail = await jsonCall(base, "GET", `/employees/evolution/${specialistId}`);
      const firstNote = detail.payload.notes.find((item) => item.status === "active");
      const retired = await jsonCall(base, "PUT", `/employees/evolution/notes/${firstNote.id}/retire`);
      assert.equal(retired.status, 200);
      runWithTenant(1, () => {
        assert.equal(activeEvolutionNotes(specialistId).length, 1);
      });
    });
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("样本不足时拒绝生成提案（不硬编也不扣费）", async () => {
  const lonelyId = Number(
    q.run(
      `INSERT INTO specialists(marshal_id,name,duty,employee_idx,key,person,emoji,description,profile_json,group_name,sort)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      marshalId,
      "新岗位",
      "还没干过活",
      102,
      "fresh",
      "新小新",
      "🧑‍💼",
      "还没干过活",
      JSON.stringify({ color: "#3b74d1" }),
      "增长部",
      2,
    ).lastInsertRowid,
  );
  process.env.YUNWU_API_KEY = "test-evolution-key";
  process.env.YUNWU_BASE_URL = "http://127.0.0.1:9";
  try {
    await withServer("boss", async (base) => {
      const blocked = await jsonCall(base, "POST", `/employees/evolution/${lonelyId}/propose`, {});
      assert.equal(blocked.status, 400);
      assert.match(blocked.payload.error, /至少需要/u);
    });
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
  }
});

test('餐饮域列表与退役路由不能读取或停用相同编号的内容域心得', async () => {
  const id = Number(db.prepare("INSERT INTO employee_evolution_notes(tenant_id,domain,specialist_id,note,status) VALUES(1,'content',?,'仅供内容域的心得','active')").run(specialistId).lastInsertRowid);
  await withServer('boss', async base => {
    const detail = await jsonCall(base, 'GET', `/employees/evolution/${specialistId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.payload.notes.some(note => note.id === id), false);
    const stopped = await jsonCall(base, 'PUT', `/employees/evolution/notes/${id}/retire`);
    assert.equal(stopped.status, 404);
    assert.equal(db.prepare('SELECT status FROM employee_evolution_notes WHERE id=?').get(id).status, 'active');
  });
});

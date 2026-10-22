import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import express from "express";

process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
// 生产即时问答可收紧为20秒；本文件把全局交互窗压到最小值，验证
// 队长拆解显式使用自己的长任务窗口，而不是意外继承该配置。
process.env.AI_INTERACTIVE_CHAT_TIMEOUT_MS = "500";
const DBP = path.join(
  os.tmpdir(),
  `nw-team-match-${process.pid}-${Date.now()}.db`,
);
process.env.NANOWORK_DB = DBP;

const { db, q, initSchema, migrateV2, runWithTenant, setConfig } = await import(
  "../src/db.js"
);
const {
  default: employeesRouter,
  shouldRetryTeamMatchOutput,
  shouldFailoverTeamPlanModel,
  shouldRetryTeamPlanOutput,
  normalizeTeamPlanDateText,
  TEAM_PLAN_PROVIDER_TIMEOUT_MS,
  TEAM_SUMMARY_PROVIDER_TIMEOUT_MS,
  TEAM_MAX_MEMBERS,
} = await import("../src/routes/employees.js");

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
  [104, "site", "李选址", "选址评分与租约测算", "评估铺位、租金与租约风险"],
  [105, "format", "周店型", "店型与服务模式设计", "设计店型、动线与服务模式"],
  [106, "economics", "吴盈亏", "单店商业模型与盈亏平衡", "测算保本营业额与成本边界"],
  [136, "roster", "喻排班", "需求驱动排班", "制定招聘到岗与排班框架"],
  [160, "campaign", "店小满", "超级店长·活动策划", "制定开业活动与落地计划"],
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

test("队长拆解只在受控预算内重试四类瞬时上游故障", () => {
  for (const code of [
    "provider_upstream_error",
    "provider_timeout",
    "provider_rate_limited",
    "provider_empty_output",
  ]) {
    const output = {
      mode: "template",
      providerFailure: { code, retryable: true },
    };
    assert.equal(shouldRetryTeamPlanOutput(output, 1), true, `${code}首轮应重试`);
    assert.equal(shouldRetryTeamPlanOutput(output, 2), false, `${code}达到上限应停止`);
  }
  assert.equal(
    shouldRetryTeamPlanOutput({
      mode: "template",
      providerFailure: { code: "provider_auth_failed", retryable: false },
    }, 1),
    false,
    "鉴权等非瞬时故障不应空跑重试",
  );
  assert.equal(
    shouldRetryTeamPlanOutput({
      mode: "template",
      providerFailure: { code: "provider_upstream_error", retryable: false },
    }, 1),
    false,
    "供应商明确标记不可重试时必须尊重该约束",
  );
  assert.equal(
    shouldRetryTeamPlanOutput({ mode: "api" }, 1),
    false,
    "真实API已成功时不得重复请求",
  );
  assert.equal(
    shouldRetryTeamPlanOutput({
      mode: "template",
      text: "",
      usage: { inputTokens: 100, outputTokens: 20 },
      providerFailure: { code: "provider_empty_output", retryable: true },
    }, 1),
    false,
    "已产生真实token的空正文不得宽泛重试造成漏记成本",
  );
  assert.equal(
    shouldRetryTeamPlanOutput({
      mode: "template",
      text: "",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        supplierCosts: [{ status: "known", costYuanOverride: 0.002 }],
      },
      providerFailure: { code: "provider_timeout", retryable: true },
    }, 1),
    false,
    "已有供应商正额成本回执时不得重复付费请求",
  );
  assert.equal(
    shouldRetryTeamPlanOutput({
      mode: "template",
      text: "",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        supplierCosts: [{ status: "pending", requestId: "pending-team-plan" }],
      },
      providerFailure: { code: "provider_timeout", retryable: true },
    }, 1),
    false,
    "已有待核费用身份也不得二次请求造成重复成本",
  );
  assert.equal(
    shouldFailoverTeamPlanModel({
      mode: "template",
      text: "",
      usage: { inputTokens: 0, outputTokens: 0 },
      providerFailure: {
        code: "provider_upstream_error",
        status: 502,
        timedOut: false,
        retryable: true,
      },
    }),
    true,
  );
  assert.equal(
    shouldFailoverTeamPlanModel({
      mode: "template",
      text: "",
      usage: { inputTokens: 0, outputTokens: 0 },
      providerFailure: {
        code: "provider_timeout",
        status: 504,
        timedOut: true,
        retryable: true,
      },
    }),
    true,
  );
  assert.equal(
    shouldFailoverTeamPlanModel({
      mode: "template",
      text: "",
      usage: { inputTokens: 0, outputTokens: 0 },
      providerFailure: {
        code: "provider_rate_limited",
        status: 429,
        timedOut: false,
        retryable: true,
      },
    }),
    false,
    "限流可原模型补试，但不构成切备模型的授权事实",
  );
});

test("队长拆解只删除模型为用户无年份月日擅加的年份", () => {
  assert.equal(
    normalizeTeamPlanDateText(
      "请在2025年12月1日前完成，并保留2025年11月20日的测算节点",
      "12月1日要开业",
    ),
    "请在12月1日前完成，并保留2025年11月20日的测算节点",
  );
  assert.equal(
    normalizeTeamPlanDateText("请在2025年12月1日前完成", "2025年12月1日要开业"),
    "请在2025年12月1日前完成",
    "老板明确年份时必须原样保留",
  );
  assert.equal(
    normalizeTeamPlanDateText("请在2025年12月1日前完成", "今年12月1日要开业"),
    "请在2025年12月1日前完成",
    "相对年份是明确时间锚点，不得擅自删除模型解析结果",
  );
  assert.equal(
    normalizeTeamPlanDateText("2025年12月1日与2025年12月2日", "12月1日与2025年12月1日"),
    "2025年12月1日与2025年12月2日",
    "同一月日既有明确年份又有无年份表达时保守保留",
  );
  assert.equal(
    normalizeTeamPlanDateText("请在2027年12月1日前完成", "2027年开新店，12月1日开业"),
    "请在2027年12月1日前完成",
    "年份与月日分句出现时仍视为老板明确年份",
  );
  assert.equal(
    normalizeTeamPlanDateText("请在2027年12月1日前完成", "明年开业，12月1日办活动"),
    "请在2027年12月1日前完成",
    "相对年份与月日分句出现时保守保留",
  );
  assert.equal(
    normalizeTeamPlanDateText("请在2027年12月1日前完成", "开业节点是2027-12-01，活动另定"),
    "请在2027年12月1日前完成",
    "ISO日期也是明确年份锚点",
  );
  assert.equal(
    normalizeTeamPlanDateText("请在2026年12月1日前完成", "二〇二六年开业，12月1日办活动"),
    "请在2026年12月1日前完成",
    "中文数字年份必须保守保留",
  );
  assert.equal(
    normalizeTeamPlanDateText("请在2026年12月1日前完成", "2026 年开业，12月1日办活动"),
    "请在2026年12月1日前完成",
    "带空格的年份仍由年字锚定",
  );
});

test("360队长拆解：动态五人骨架、日期校正、受控接力与失败成本审计", async () => {
  assert.equal(TEAM_PLAN_PROVIDER_TIMEOUT_MS, 60_000);
  assert.ok(
    TEAM_PLAN_PROVIDER_TIMEOUT_MS * 2 + 2500 < 150_000,
    "两轮供应商预算与退避必须落在前端150秒请求预算内",
  );
  const nativeFetch = globalThis.fetch;
  const requestBodies = [];
  let providerCalls = 0;
  let scenario = "retry-then-success";
  let scenarioCalls = 0;
  const memberIds = [104, 105, 106, 136, 160];
  const requestBody = {
    text: "罗二火锅要在成都太古里开店，请队长拆解选址、租金、招聘和12月1日开业活动",
    depth: "full",
    members: [
      { idx: 104, roleInTeam: "队长", task: "统筹选址与租金", dependsOn: [] },
      { idx: 105, roleInTeam: "成员", task: "设计店型", dependsOn: [104] },
      { idx: 106, roleInTeam: "成员", task: "测算盈亏", dependsOn: [104, 105] },
      { idx: 136, roleInTeam: "成员", task: "制定招聘排班", dependsOn: [105, 106] },
      { idx: 160, roleInTeam: "成员", task: "策划12月1日开业活动", dependsOn: [104, 105, 106, 136] },
    ],
  };
  process.env.AI360_API_KEY = "test-team-plan-360-key";
  setConfig("ai_provider_default", "360");
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith("https://api.360.cn/")) return nativeFetch(url, options);
    providerCalls += 1;
    scenarioCalls += 1;
    const body = JSON.parse(options.body);
    requestBodies.push(body);
    if (scenario === "retry-then-success" && scenarioCalls === 1) {
      throw Object.assign(new Error("simulated transport timeout before response"), {
        name: "AbortError",
      });
    }
    if (scenario === "incomplete") {
      return new Response(JSON.stringify({
        id: "team-plan-360-incomplete",
        choices: [{
          message: {
            content: JSON.stringify({
              briefs: [
                {
                  idx: 105,
                  title: "店型设计",
                  directive: "完成店型设计。【输出标准】给老板可执行清单。",
                  deliverables: "店型方案",
                },
                { idx: 104, title: "", directive: "完成选址。", deliverables: "选址表" },
                { idx: 136, title: "招聘排班", directive: "", deliverables: "排班表" },
                { idx: 999, title: "虚构成员", directive: "无效", deliverables: "无效" },
                { idx: 105, title: "重复成员", directive: "重复", deliverables: "重复" },
              ],
            }),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 700, completion_tokens: 100, amount: "0.004" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: "team-plan-360-success",
      choices: [{
        message: {
          content: JSON.stringify({
            briefs: memberIds.map((idx) => ({
              idx,
              title: idx === 160 ? "2025年12月1日开业活动" : `成员${idx}任务`,
              directive: idx === 160
                ? "完成2025年12月1日开业活动并与上下游衔接。【输出标准】先给老板摘要，再给行动清单。"
                : idx === 106
                  ? "在2025年11月20日完成测算并与上下游衔接。【输出标准】先给老板摘要，再给行动清单。"
                  : `完成成员${idx}的分工并与上下游衔接。【输出标准】先给老板摘要，再给行动清单。`,
              deliverables: idx === 160 ? "2025年12月1日开业执行表" : `成员${idx}的可审核交付物`,
            })),
          }),
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 900, completion_tokens: 500, amount: "0.006" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/employees/team-plan`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "team-plan-five-success" },
        body: JSON.stringify(requestBody),
      });
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      assert.equal(payload.plan.leadIdx, 104);
      assert.equal(payload.plan.briefs.length, 5, "五名成员必须全部形成拆解");
      assert.equal(payload.billing.state, "settled");
      const activity = payload.plan.briefs.find((brief) => brief.idx === 160);
      assert.equal(activity.title, "12月1日开业活动");
      assert.match(activity.directive, /12月1日开业活动/u);
      assert.doesNotMatch(activity.directive, /2025年12月1日/u);
      assert.equal(activity.deliverables, "12月1日开业执行表");
      assert.match(
        payload.plan.briefs.find((brief) => brief.idx === 106).directive,
        /2025年11月20日/u,
        "用户没提到的其他月日不在狭窄校正范围内",
      );

      const balanceBeforeFailure = q.get("SELECT credits FROM tenants WHERE id=1").credits;
      scenario = "incomplete";
      scenarioCalls = 0;
      const callsBeforeFailure = providerCalls;
      const failed = await fetch(`${base}/employees/team-plan`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "team-plan-five-incomplete" },
        body: JSON.stringify(requestBody),
      });
      const failurePayload = await failed.json();
      assert.equal(failed.status, 422, JSON.stringify(failurePayload));
      assert.equal(failurePayload.code, "TEAM_PLAN_INCOMPLETE");
      assert.equal(providerCalls - callsBeforeFailure, 1, "已有API正文与成本后不应再次付费重调");
      assert.equal(failurePayload.billing.state, "released");
      assert.equal(failurePayload.billing.chargedCredits, 0);
      assert.ok(failurePayload.billing.refundedCredits > 0);
      assert.equal(q.get("SELECT credits FROM tenants WHERE id=1").credits, balanceBeforeFailure);
      assert.doesNotMatch(JSON.stringify(failurePayload), /rawBriefCount|returnedIdx|test-team-plan-360-key/u);

      const failedHold = q.get(
        `SELECT * FROM credit_holds WHERE tenant_id=1 ORDER BY id DESC LIMIT 1`,
      );
      assert.equal(failedHold.status, "settled");
      assert.equal(failedHold.settled_credits, 0);
      const expense = q.get(
        `SELECT * FROM credit_supplier_expenses WHERE tenant_id=1 AND hold_id=?`,
        failedHold.id,
      );
      assert.equal(expense.status, "known");
      assert.ok(Math.abs(Number(expense.cost_yuan) - 0.004) < 1e-12);
      assert.equal(Number(expense.refunded_credits), Number(failedHold.held_credits));
      const failedLog = q.get(
        `SELECT * FROM credit_logs WHERE tenant_id=1 AND id=?`,
        failedHold.log_id,
      );
      assert.equal(failedLog.credits, 0);
      assert.match(failedLog.note, /usage=700\/100/u);
      assert.match(failedLog.note, /supplierCost=known/u);
      assert.match(failedLog.note, /raw=5/u);
      assert.match(failedLog.note, /returned=105,104,136,999/u);
      assert.match(failedLog.note, /missing=104,106,136,160/u);
      assert.match(failedLog.note, /emptyTitle=104/u);
      assert.match(failedLog.note, /emptyDirective=136/u);
      assert.match(failedLog.note, /duplicate=105/u);
      assert.match(failedLog.note, /unexpected=999/u);
      assert.match(failedLog.note, /rid=team-plan-five-incomplete/u);
    });
    assert.deepEqual(
      requestBodies.slice(0, 2).map((body) => body.model),
      ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
    );
    for (const body of requestBodies) {
      assert.deepEqual(body.thinking, { type: "disabled" });
      // 输出预算随成员数放大：5000 + 5×1400 = 12000，保证多人小队不被截断成漏拆。
      assert.equal(body.max_tokens, 12000);
      assert.deepEqual(body.response_format, { type: "json_object" });
    }
    const expectedSkeleton = JSON.stringify({
      briefs: memberIds.map((idx) => ({ idx, title: "", directive: "", deliverables: "" })),
    });
    const systemPrompt = requestBodies[0].messages.find((message) => message.role === "system")?.content || "";
    assert.match(systemPrompt, /idx 按此顺序逐一为：104、105、106、136、160/u);
    assert.ok(systemPrompt.includes(expectedSkeleton), "提示词必须携带本次真实五人的完整JSON骨架");
    assert.doesNotMatch(systemPrompt, /"idx":101/u, "不得继续用无关101硬编码示例诱导模型");
  } finally {
    globalThis.fetch = nativeFetch;
    delete process.env.AI360_API_KEY;
    q.run("DELETE FROM sys_config WHERE key='ai_provider_default'");
  }
});

test("一句话找人只重试零用量瞬时失败，不重复提交已有成本证据的空回复", () => {
  const zeroUsage = {
    mode: "template",
    text: "",
    usage: { inputTokens: 0, outputTokens: 0 },
    providerFailure: { code: "provider_empty_output", retryable: true },
  };
  assert.equal(shouldRetryTeamMatchOutput(zeroUsage, 1), true);
  assert.equal(shouldRetryTeamMatchOutput(zeroUsage, 2), false);
  assert.equal(shouldRetryTeamMatchOutput({
    ...zeroUsage,
    usage: { inputTokens: 120, outputTokens: 40 },
  }, 1), false);
  assert.equal(shouldRetryTeamMatchOutput({
    ...zeroUsage,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      supplierCosts: [{ status: "known", costYuanOverride: 0.002 }],
    },
  }, 1), false);
});

test("360一句话找人关闭思考并交付；有用量空正文只请求一次、全退且返回安全分类", async () => {
  const nativeFetch = globalThis.fetch;
  const balanceBefore = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  let mode = "success";
  let providerCalls = 0;
  const requestBodies = [];
  process.env.AI360_API_KEY = "test-team-match-360-key";
  setConfig("ai_provider_default", "360");
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith("https://api.360.cn/")) return nativeFetch(url, options);
    providerCalls += 1;
    const body = JSON.parse(options.body);
    requestBodies.push(body);
    const content = mode === "success"
      ? JSON.stringify({
          teamName: "360开店筹备小队",
          summary: "先看市场，再拆筹备计划。",
          members: [{
            idx: 101,
            roleInTeam: "队长",
            task: "判断开店机会并统筹后续工作",
            why: "岗位负责餐饮市场机会研究",
            dependsOn: [],
          }],
        })
      : "";
    return new Response(JSON.stringify({
      id: `safe-test-${providerCalls}`,
      choices: [{ message: { content }, finish_reason: mode === "success" ? "stop" : "length" }],
      usage: { prompt_tokens: 120, completion_tokens: mode === "success" ? 40 : 80, amount: "0.002" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await withServer(async (base) => {
      const succeeded = await postMatch(base, { text: "帮我筹备一家火锅店" });
      assert.equal(succeeded.response.status, 200, JSON.stringify(succeeded.payload));
      assert.equal(succeeded.payload.team.members[0].idx, 101);
      assert.equal(succeeded.payload.billing.state, "settled");
      assert.equal(requestBodies[0].model, "deepseek/deepseek-v4-flash");
      assert.deepEqual(requestBodies[0].thinking, { type: "disabled" });
      assert.equal(requestBodies[0].max_tokens, 8000);

      mode = "empty";
      const callsBeforeFailure = providerCalls;
      const failed = await postMatch(base, { text: "再帮我挑一个开店小队" });
      assert.equal(failed.response.status, 502, JSON.stringify(failed.payload));
      assert.equal(providerCalls - callsBeforeFailure, 1, "已有用量证据的空正文不得重复付费请求");
      assert.equal(failed.payload.code, "provider_empty_output");
      assert.equal(failed.payload.retryable, true);
      assert.equal(failed.payload.providerFailure.summary, "供应商计入了用量但没有返回业务正文");
      assert.equal(failed.payload.providerAttempts, 1);
      assert.equal(failed.payload.billing.state, "released");
      assert.equal(failed.payload.billing.chargedCredits, 0);
      assert.match(failed.payload.retryHint, /未重复提交/u);
      assert.doesNotMatch(JSON.stringify(failed.payload), /test-team-match-360-key/u);
    });
    const lastCharged = Number(q.get(
      `SELECT settled_credits FROM credit_holds
       WHERE tenant_id=1 AND status='settled' AND settled_credits>0
       ORDER BY id DESC LIMIT 1`,
    ).settled_credits);
    assert.equal(
      q.get("SELECT credits FROM tenants WHERE id=1").credits,
      balanceBefore - lastCharged,
      "成功请求实扣，随后失败请求全退",
    );
  } finally {
    globalThis.fetch = nativeFetch;
    delete process.env.AI360_API_KEY;
    q.run("DELETE FROM sys_config WHERE key='ai_provider_default'");
  }
});

test("8人小队全员派活：选人上限与队长拆解/汇总上限一致，超员截断保留队长", async () => {
  assert.equal(TEAM_MAX_MEMBERS, 8);
  const nativeFetch = globalThis.fetch;
  const allIdx = ROSTER.map(([idx]) => idx); // 8 人
  let planPrompt = "";
  process.env.AI360_API_KEY = "test-team-eight-360-key";
  setConfig("ai_provider_default", "360");
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith("https://api.360.cn/")) return nativeFetch(url, options);
    const body = JSON.parse(options.body);
    const systemText = String(body.messages?.[0]?.content || "");
    if (/派单调度台/u.test(systemText)) {
      // 模型多选出 9 个（含 1 个花名册外 + 全部 8 人），队长排在中间：截断后必须保留队长且恰好 8 人。
      return new Response(JSON.stringify({
        id: "team-match-nine",
        choices: [{
          message: {
            content: JSON.stringify({
              teamName: "五线并进开业小队",
              summary: "市场→选址→店型→菜单→外卖→盈亏→开业→排班。",
              members: [
                ...allIdx.slice(0, 4).map((idx) => ({ idx, roleInTeam: "成员", task: `分工${idx}`, why: "岗位匹配", dependsOn: [] })),
                { idx: 9999, roleInTeam: "成员", task: "虚构", why: "越权", dependsOn: [] },
                { idx: allIdx[4], roleInTeam: "队长", task: "统筹", why: "统筹", dependsOn: [] },
                ...allIdx.slice(5).map((idx) => ({ idx, roleInTeam: "成员", task: `分工${idx}`, why: "岗位匹配", dependsOn: [] })),
              ],
            }),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 600, completion_tokens: 300, amount: "0.003" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    planPrompt = systemText;
    return new Response(JSON.stringify({
      id: "team-plan-eight",
      choices: [{
        message: {
          content: JSON.stringify({
            briefs: allIdx.map((idx) => ({
              idx,
              title: `成员${idx}任务`,
              directive: `完成成员${idx}的分工并与上下游衔接。【输出标准】先给老板摘要。`,
              deliverables: `成员${idx}交付物`,
            })),
          }),
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1200, completion_tokens: 900, amount: "0.008" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await withServer(async (base) => {
      const matched = await postMatch(base, {
        text: "深圳大运地铁站甜品店五线并进冲刺12月1日开业",
      });
      assert.equal(matched.response.status, 200, JSON.stringify(matched.payload));
      const team = matched.payload.team;
      assert.equal(team.members.length, 8, "超出上限的成员被截断，花名册外的被剔除");
      const leads = team.members.filter((member) => member.roleInTeam === "队长");
      assert.equal(leads.length, 1);
      assert.equal(leads[0].idx, allIdx[4], "截断时必须保住模型指定的队长");

      const planned = await fetch(`${base}/employees/team-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "深圳大运地铁站甜品店五线并进冲刺12月1日开业",
          depth: "pro",
          members: team.members.map((member) => ({
            idx: member.idx,
            roleInTeam: member.roleInTeam,
            task: member.task,
            dependsOn: member.dependsOn,
          })),
        }),
      });
      const payload = await planned.json();
      assert.equal(planned.status, 200, JSON.stringify(payload));
      assert.equal(payload.plan.briefs.length, 8, "8 人小队必须 8 人都拿到任务，不能只派 5 人");
      assert.deepEqual(
        payload.plan.briefs.map((brief) => brief.idx).sort((a, b) => a - b),
        [...allIdx].sort((a, b) => a - b),
      );
      assert.match(planPrompt, /briefs 必须恰好返回 8 条/u);
    });
  } finally {
    globalThis.fetch = nativeFetch;
    delete process.env.AI360_API_KEY;
    q.run("DELETE FROM sys_config WHERE key='ai_provider_default'");
  }
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

test("队长拆解：首选模型零用量502后仅接力一次gpt-5.5并按实际模型结算", async () => {
  let served = 0;
  const requestedModels = [];
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requestedModels.push(JSON.parse(body).model);
    served += 1;
    if (served === 1) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "primary upstream unavailable" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            briefs: [
              {
                idx: 101,
                title: "统筹周年庆目标",
                directive: "统筹目标、预算和两位成员交付。【输出标准】先给老板摘要。",
                deliverables: "一份可拍板的周年庆统筹方案",
              },
              {
                idx: 102,
                title: "盘点竞品活动",
                directive: "盘点周边竞品并给队长供料。【输出标准】列出可核验来源。",
                deliverables: "竞品活动与价格动作清单",
              },
            ],
          }),
        },
      }],
      usage: { prompt_tokens: 720, completion_tokens: 260 },
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.YUNWU_API_KEY = "test-team-plan-retry-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  const balanceBefore = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/employees/team-plan`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "team-plan-retry-success",
        },
        body: JSON.stringify({
          text: "帮门店做周年庆活动",
          depth: "full",
          members: [
            { idx: 101, roleInTeam: "队长", task: "统筹", dependsOn: [102] },
            { idx: 102, roleInTeam: "成员", task: "盯竞品", dependsOn: [] },
          ],
        }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      assert.equal(served, 2, "零用量502后只允许一次受控模型接力");
      assert.deepEqual(requestedModels, ["deepseek-v4-flash", "gpt-5.5"]);
      assert.equal(payload.plan.briefs.length, 2);
      assert.equal(payload.billing.state, "settled");
      assert.ok(payload.billing.chargedCredits > 0);
    });
    assert.ok(
      q.get("SELECT credits FROM tenants WHERE id=1").credits < balanceBefore,
      "备模型真实交付后按实际用量结算",
    );
    const hold = q.get(
      `SELECT h.*, l.input_tokens, l.output_tokens, l.model ledger_model, l.note
       FROM credit_holds h
       JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
       WHERE h.tenant_id=1 AND h.feature LIKE '协同小队·队长拆解派活%'
       ORDER BY h.id DESC LIMIT 1`,
    );
    assert.equal(Number(hold.input_tokens), 720);
    assert.equal(Number(hold.output_tokens), 260);
    assert.equal(hold.ledger_model, "gpt-5.5", "流水必须写最终实际模型");
    assert.match(hold.note, /deepseek-v4-flash→gpt-5\.5/u);
    assert.match(hold.note, /reason=retryable_zero_usage_transport_failure/u);
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("队长拆解：瞬时上游故障耗尽重试后失败关闭、全额退回并返回脱敏错误契约", async () => {
  let served = 0;
  const upstreamSecret = "private-upstream-cluster-secret";
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume */
    }
    served += 1;
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: upstreamSecret } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.YUNWU_API_KEY = "test-team-plan-failure-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  const balanceBefore = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/employees/team-plan`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "team-plan-upstream-failed-001",
        },
        body: JSON.stringify({
          text: "帮门店做周年庆活动",
          depth: "full",
          members: [
            { idx: 101, roleInTeam: "队长", task: "统筹", dependsOn: [102] },
            { idx: 102, roleInTeam: "成员", task: "盯竞品", dependsOn: [] },
          ],
        }),
      });
      const payload = await response.json();
      assert.equal(response.status, 502, JSON.stringify(payload));
      assert.equal(served, 2, "受控预算仅允许两次上游请求");
      assert.equal(payload.code, "provider_upstream_error");
      assert.equal(payload.retryable, true);
      assert.equal(payload.requestId, "team-plan-upstream-failed-001");
      assert.equal(payload.failurePhase, "generate");
      assert.equal(payload.providerAttempts, 2);
      assert.deepEqual(payload.providerFailure, {
        code: "provider_upstream_error",
        status: 502,
        timedOut: false,
        retryable: true,
        summary: "供应商服务暂时异常",
      });
      assert.equal(payload.billing.state, "released");
      assert.equal(payload.billing.chargedCredits, 0);
      assert.equal(payload.billing.heldCredits, 0);
      assert.equal(payload.billing.pendingReconciliation, false);
      assert.equal(Object.hasOwn(payload, "plan"), false, "不得用模板冒充拆解结果");
      assert.doesNotMatch(JSON.stringify(payload), new RegExp(upstreamSecret));
    });
    assert.equal(
      q.get("SELECT credits FROM tenants WHERE id=1").credits,
      balanceBefore,
      "两轮上游都失败后预授权必须全额退回",
    );
    const hold = q.get(
      `SELECT h.*, l.input_tokens, l.output_tokens, l.credits log_credits, l.ai_mode
       FROM credit_holds h
       JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
       WHERE h.tenant_id=1 AND h.feature LIKE '协同小队·队长拆解派活%'
       ORDER BY h.id DESC LIMIT 1`,
    );
    assert.equal(Number(hold.settled_credits), 0);
    assert.equal(Number(hold.log_credits), 0);
    assert.equal(Number(hold.input_tokens), 0);
    assert.equal(Number(hold.output_tokens), 0);
    assert.equal(hold.ai_mode, "failed", "未交付流水不得冒充真实API成功");
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("队长拆解：账务未结清时不返回可派发plan", async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            briefs: [{
              idx: 101,
              title: "统筹周年庆",
              directive: "统筹方案。【输出标准】先给老板摘要。",
              deliverables: "一份统筹方案",
            }],
          }),
        },
      }],
      // 故意构造超过预授权上限的供应商用量，验证待对账门禁。
      usage: { prompt_tokens: 10_000_000, completion_tokens: 10_000_000 },
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.YUNWU_API_KEY = "test-team-plan-billing-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/employees/team-plan`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "team-plan-billing-unsettled-001",
        },
        body: JSON.stringify({
          text: "帮门店做周年庆活动",
          depth: "full",
          members: [{ idx: 101, roleInTeam: "队长", task: "统筹", dependsOn: [] }],
        }),
      });
      const payload = await response.json();
      assert.equal(response.status, 409, JSON.stringify(payload));
      assert.equal(payload.code, "TEAM_PLAN_BILLING_NOT_SETTLED");
      assert.equal(payload.retryable, false);
      assert.equal(payload.requestId, "team-plan-billing-unsettled-001");
      assert.equal(payload.billing.state, "pending_reconciliation");
      assert.equal(payload.billing.pendingReconciliation, true);
      assert.equal(Object.hasOwn(payload, "plan"), false);
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

    assert.equal(TEAM_SUMMARY_PROVIDER_TIMEOUT_MS, 60_000);
    assert.ok(
      TEAM_SUMMARY_PROVIDER_TIMEOUT_MS * 2 + 2500 < 150_000,
      "汇总两轮供应商预算与退避必须落在前端150秒请求预算内",
    );
    const nativeFetch = globalThis.fetch;
    const requestBodies = [];
    let mode = "success";
    let providerCalls = 0;
    process.env.AI360_API_KEY = "test-team-summary-360-key";
    setConfig("ai_provider_default", "360");
    globalThis.fetch = async (url, options) => {
      if (!String(url).startsWith("https://api.360.cn/")) return nativeFetch(url, options);
      providerCalls += 1;
      requestBodies.push(JSON.parse(options.body));
      if (mode === "success") {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 650);
          options.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          }, { once: true });
        });
      }
      const result = mode === "success"
        ? {
            summary:
              "统筹方案已经定盘：周年庆总预算2万元，主打两人套餐引流，第一周先做私域预热再开公域投放。研市场给出了预算分配与套餐方向；竞品盘点仍在执行，折扣要等盘点结论后再定。整体还需要老板确认预算并补齐竞品应对。",
            keyNumbers: [{ label: "活动总预算", value: "2万元", source: "研市场" }],
            progress: [
              { idx: 101, highlight: "已交付预算、套餐与预热节奏" },
              { idx: 102, highlight: "竞品盘点仍在执行" },
            ],
            nextActions: [{ action: "确认2万预算", owner: "老板", timing: "今天" }],
            risks: "竞品若同期活动，需要重新核对折扣力度",
          }
        : {
            summary: "太短，不能交付",
            keyNumbers: [],
            progress: [],
            nextActions: [],
            risks: "",
          };
      return new Response(JSON.stringify({
        id: `team-summary-360-${mode}`,
        choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: mode === "success" ? 600 : 500,
          completion_tokens: mode === "success" ? 300 : 20,
          amount: mode === "success" ? "0.004" : "0.002",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await withServer(async (base) => {
        const body = {
          text: "帮门店做周年庆活动",
          items: [
            { idx: 101, taskId: doneTask },
            { idx: 102, taskId: runningTask },
          ],
        };
        const succeeded = await fetch(`${base}/employees/team-summary`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-id": "team-summary-success" },
          body: JSON.stringify(body),
        });
        const successPayload = await succeeded.json();
        assert.equal(succeeded.status, 200, JSON.stringify(successPayload));
        assert.equal(successPayload.billing.state, "settled");
        assert.equal(successPayload.teamSummary.progress.length, 2);

        const balanceBeforeFailure = q.get("SELECT credits FROM tenants WHERE id=1").credits;
        mode = "short";
        const callsBeforeFailure = providerCalls;
        const failed = await fetch(`${base}/employees/team-summary`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-id": "team-summary-too-short" },
          body: JSON.stringify(body),
        });
        const failurePayload = await failed.json();
        assert.equal(failed.status, 422, JSON.stringify(failurePayload));
        assert.equal(failurePayload.code, "TEAM_SUMMARY_TOO_SHORT");
        assert.equal(failurePayload.requestId, "team-summary-too-short");
        assert.equal(failurePayload.billing.state, "released");
        assert.equal(failurePayload.billing.chargedCredits, 0);
        assert.equal(providerCalls - callsBeforeFailure, 1, "已有正文与费用回执后不得重复调用");
        assert.equal(q.get("SELECT credits FROM tenants WHERE id=1").credits, balanceBeforeFailure);
        assert.doesNotMatch(JSON.stringify(failurePayload), /test-team-summary-360-key/u);

        const failedHold = q.get(
          `SELECT * FROM credit_holds WHERE tenant_id=1 ORDER BY id DESC LIMIT 1`,
        );
        const expense = q.get(
          `SELECT * FROM credit_supplier_expenses WHERE tenant_id=1 AND hold_id=?`,
          failedHold.id,
        );
        assert.equal(failedHold.status, "settled");
        assert.equal(failedHold.settled_credits, 0);
        assert.equal(expense.status, "known");
        assert.ok(Math.abs(Number(expense.cost_yuan) - 0.002) < 1e-12);
      });
      for (const body of requestBodies) {
        assert.deepEqual(body.thinking, { type: "disabled" });
        assert.deepEqual(body.response_format, { type: "json_object" });
        assert.equal(body.max_tokens, 10000);
      }
      const system = requestBodies[0].messages.find((message) => message.role === "system")?.content || "";
      assert.match(system, /idx 按此顺序逐一为：101、102/u);
    } finally {
      globalThis.fetch = nativeFetch;
      delete process.env.AI360_API_KEY;
      q.run("DELETE FROM sys_config WHERE key='ai_provider_default'");
    }
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

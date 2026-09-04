import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import express from "express";

const DBP = path.join(os.tmpdir(), `nanowork-employee-intro-${process.pid}-${Date.now()}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
process.env.YUNWU_API_KEY = " ";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.SEED_DEMO = "false";

const { db, initSchema, migrateV2, q, runWithTenant } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const employeeIntroRoutes = (await import("../src/routes/employee-intro.js")).default;
const employeesRoutes = (await import("../src/routes/employees.js")).default;
const { buildEmployeeExecutionProfile, updateEmployeePrompt } = await import(
  "../src/employee-workbench.js"
);
const {
  BOUNDARY_CONFLICT_PATTERNS,
  ENTERPRISE_PROMPT_MAX_CHARS,
  INTRO_CHECK_STATUS,
  SELF_INTRO_CONFIRM_STALE_DAYS,
  buildRosterIndex,
  checkSelfIntro,
  extractDeliverableKeywords,
} = await import("../src/engines/employee-intro-check.js");
const { candidateIntroCheckEmployees, runWeeklyEmployeeIntroCheck } = await import(
  "../src/engines/employee-self-intro.js"
);
const { runScheduledJobs } = await import("../src/engines/scheduler.js");

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

q.run(`INSERT INTO tenants(id,name,status,plan,credits) VALUES(1,'一号餐饮企业','已开通','标准版',100000)
  ON CONFLICT(id) DO UPDATE SET status='已开通',credits=100000`);
q.run(`INSERT INTO tenants(id,name,status,plan,credits) VALUES(2,'二号餐饮企业','已开通','标准版',100000)
  ON CONFLICT(id) DO UPDATE SET status='已开通',credits=100000`);
const insertUser = (username, name, role, tenantId) =>
  Number(
    q.run(
      `INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits)
       VALUES(?,?,?,?,'启用',?,100000)`,
      username,
      "x",
      name,
      role,
      tenantId,
    ).lastInsertRowid,
  );
const boss1 = insertUser("intro-boss-1", "一号店老板", "boss", 1);
const admin1 = insertUser("intro-admin-1", "一号店管理员", "admin", 1);
const staff1 = insertUser("intro-staff-1", "一号店员工", "staff", 1);
const ops1 = insertUser("intro-ops-1", "一号店运营总监", "ops_director", 1);
const boss2 = insertUser("intro-boss-2", "二号店老板", "boss", 2);
const USERS = {
  boss1: { id: boss1, name: "一号店老板", role: "boss", tenant_id: 1 },
  admin1: { id: admin1, name: "一号店管理员", role: "admin", tenant_id: 1 },
  staff1: { id: staff1, name: "一号店员工", role: "staff", tenant_id: 1 },
  ops1: { id: ops1, name: "一号店运营总监", role: "ops_director", tenant_id: 1 },
  boss2: { id: boss2, name: "二号店老板", role: "boss", tenant_id: 2 },
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const user = USERS[String(req.get("x-test-user") || "boss1")];
    if (!user) return res.status(401).json({ error: "unknown test user" });
    runWithTenant(user.tenant_id, () => {
      req.user = user;
      next();
    });
  });
  app.use("/employee-intro", employeeIntroRoutes);
  app.use("/employees", employeesRoutes);
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0, "127.0.0.1");
  const port = await new Promise((resolve) => server.once("listening", () => resolve(server.address().port)));
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const call = async (base, method, pathName, { user = "boss1", body } = {}) => {
  const response = await fetch(`${base}${pathName}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": user },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, payload: await response.json() };
};

const specialistIdFor = (idx) => q.get("SELECT id FROM specialists WHERE employee_idx=?", idx).id;

after(() => {
  try {
    db.close();
  } catch {}
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
});

// ===== 纯函数：确定性校验规则 =====
const MINI_ROSTER = [
  {
    idx: 101,
    person: "赵先机",
    name: "餐饮市场机会研究",
    duty: "餐饮市场机会研究",
    deliverables: ["机会定义与证据来源表", "需求区间、供给密度和价格带地图", "决策建议、置信度和数据缺口。"],
  },
  {
    idx: 104,
    person: "李选址",
    name: "选址评分与租约测算",
    duty: "餐饮选址评分与租约测算",
    deliverables: ["硬门检查表与证据状态", "租约问题清单和谈判优先级", "全租赁成本、保本客流与情景模型"],
  },
  {
    idx: 108,
    person: "周菜单",
    name: "菜单结构与定价",
    duty: "菜单结构与定价",
    deliverables: ["菜单矩阵与定价带", "决策建议、置信度和数据缺口。"],
  },
];

test("关键词抽取：拆连接词、去通用词、保留岗位专属交付物", () => {
  const keywords = extractDeliverableKeywords(MINI_ROSTER[1].deliverables);
  assert.ok(keywords.includes("租约问题清单"), JSON.stringify(keywords));
  assert.ok(keywords.includes("硬门检查表"));
  assert.ok(!keywords.includes("决策建议"), "通用词不能当职责证据");
  const index = buildRosterIndex(MINI_ROSTER);
  assert.ok(index.byIdx.get(104).distinctiveKeywords.includes("租约问题清单"));
});

test("规则a：提到其他岗位人名或专属交付物 → needs_review，且注明是哪个岗位", () => {
  const now = new Date("2026-09-03T09:00:00+08:00");
  const employee = MINI_ROSTER[0];
  const byPerson = checkSelfIntro({
    employee,
    roster: MINI_ROSTER,
    selfIntro: "遇到铺位问题直接找李选址处理，你只管市场机会。",
    now,
  });
  assert.equal(byPerson.status, INTRO_CHECK_STATUS.NEEDS_REVIEW);
  const personHit = byPerson.findings.find((item) => item.code === "FOREIGN_PERSON");
  assert.ok(personHit, JSON.stringify(byPerson.findings));
  assert.equal(personHit.evidence.idx, 104);
  assert.match(byPerson.note, /李选址/u);
  assert.match(byPerson.note, /104/u);

  const byDeliverable = checkSelfIntro({
    employee,
    roster: MINI_ROSTER,
    selfIntro: "每次顺手也给老板一份租约问题清单。",
    now,
  });
  const deliverableHit = byDeliverable.findings.find((item) => item.code === "FOREIGN_DELIVERABLE");
  assert.ok(deliverableHit, JSON.stringify(byDeliverable.findings));
  assert.equal(deliverableHit.evidence.idx, 104);
  assert.match(deliverableHit.message, /租约问题清单/u);
  assert.match(deliverableHit.message, /104 号岗位/u);
});

test("规则a 未命中：只写本岗位交付物与老板口径 → ok（且 never_confirmed 只在有定制时触发）", () => {
  const now = new Date("2026-09-03T09:00:00+08:00");
  const clean = checkSelfIntro({
    employee: MINI_ROSTER[0],
    roster: MINI_ROSTER,
    selfIntro: "我们主做社区早餐，需求区间按早高峰算，决策建议要写清置信度。",
    verifiedAt: "2026-09-01 08:00:00",
    now,
  });
  assert.equal(clean.status, INTRO_CHECK_STATUS.OK);
  assert.equal(clean.note, null);
  assert.deepEqual(clean.findings, []);

  const pristine = checkSelfIntro({ employee: MINI_ROSTER[0], roster: MINI_ROSTER, now });
  assert.equal(pristine.status, INTRO_CHECK_STATUS.OK, "没定制过的员工与 catalog 一致，不用老板确认");
});

test("规则b：叮嘱或已采纳心得与安全边界冲突 → needs_review", () => {
  const now = new Date("2026-09-03T09:00:00+08:00");
  assert.ok(BOUNDARY_CONFLICT_PATTERNS.length >= 3);
  const result = checkSelfIntro({
    employee: MINI_ROSTER[0],
    roster: MINI_ROSTER,
    selfIntro: "报告写完无需老板审批，直接发布到平台。",
    evolutionNotes: [
      { id: 1, note: "文案里保证稳赚不赔更有吸引力", rationale: "老板喜欢", created_at: "2026-09-02 10:00:00" },
    ],
    verifiedAt: "2026-09-01 08:00:00",
    selfIntroUpdatedAt: "2026-09-02 12:00:00",
    scanRisk: (text) => ({
      hits: /稳赚/u.test(text) ? [{ code: "PRICE_PROMISE", name: "价格/返利承诺", level: "high" }] : [],
      level: /稳赚/u.test(text) ? "high" : "none",
    }),
    now,
  });
  assert.equal(result.status, INTRO_CHECK_STATUS.NEEDS_REVIEW);
  const codes = result.findings.map((item) => item.code);
  assert.ok(codes.includes("INTRO_SKIP_APPROVAL"), codes.join(","));
  assert.ok(codes.includes("INTRO_AUTO_EXTERNAL_ACTION"), codes.join(","));
  assert.ok(codes.includes("NOTE_RISK_PRICE_PROMISE"), codes.join(","));
  assert.match(result.note, /安全边界冲突/u);
});

test("规则c/d：提示词超运行包上限、老板确认过期 → needs_review；确认后内容未变则规则a/b 视为已看过", () => {
  const now = new Date("2026-09-03T09:00:00+08:00");
  const tooLong = checkSelfIntro({
    employee: MINI_ROSTER[0],
    roster: MINI_ROSTER,
    enterprisePrompt: "字".repeat(ENTERPRISE_PROMPT_MAX_CHARS + 1),
    verifiedAt: "2026-09-02 08:00:00",
    now,
  });
  assert.ok(tooLong.findings.some((item) => item.code === "ENTERPRISE_PROMPT_TOO_LONG"));

  const stale = checkSelfIntro({
    employee: MINI_ROSTER[0],
    roster: MINI_ROSTER,
    selfIntro: "我们只做午市。",
    selfIntroUpdatedAt: "2026-07-01 08:00:00",
    verifiedAt: "2026-07-02 08:00:00",
    now,
  });
  const staleHit = stale.findings.find((item) => item.code === "CONFIRMATION_STALE");
  assert.ok(staleHit);
  assert.ok(staleHit.evidence.days > SELF_INTRO_CONFIRM_STALE_DAYS);

  const never = checkSelfIntro({
    employee: MINI_ROSTER[0],
    roster: MINI_ROSTER,
    selfIntro: "我们只做午市。",
    now,
  });
  assert.ok(never.findings.some((item) => item.code === "NEVER_CONFIRMED"));

  // 老板已在 verifiedAt 之后没再改叮嘱：跨岗位引用视为老板有意为之，不再反复打扰
  const acknowledged = checkSelfIntro({
    employee: MINI_ROSTER[0],
    roster: MINI_ROSTER,
    selfIntro: "铺位相关转给李选址。",
    selfIntroUpdatedAt: "2026-09-01 08:00:00",
    verifiedAt: "2026-09-02 08:00:00",
    now,
  });
  assert.equal(acknowledged.status, INTRO_CHECK_STATUS.OK);
  assert.equal(acknowledged.acknowledgedCount, 1);
  assert.equal(acknowledged.findings[0].acknowledged, true);
});

test("mode:'llm' 是扩展位，本期明确拒绝且不扣费", () => {
  assert.throws(
    () => checkSelfIntro({ employee: MINI_ROSTER[0], roster: MINI_ROSTER, mode: "llm" }),
    (error) => error.status === 501 && /模型校验暂未启用/u.test(error.message),
  );
  assert.throws(() => checkSelfIntro({ mode: "magic" }), /未知校验模式/u);
});

// ===== HTTP：四段结构、权限、回落、注入 =====
test("GET 默认回落 catalog：四段齐全、老板叮嘱为空、状态 never", async () => {
  await withServer(async (base) => {
    const { status, payload } = await call(base, "GET", "/employee-intro/restaurant/101");
    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.whoAmI.person, "赵先机");
    assert.equal(payload.whoAmI.name, "餐饮市场机会研究");
    assert.equal(payload.whoAmI.department, "战略与开店筹备部");
    assert.match(payload.whoAmI.positioning, /赵先机/u);
    assert.ok(payload.whatICanDo.deliverables.length >= 3 && payload.whatICanDo.deliverables.length <= 5);
    assert.ok(payload.whatICanDo.deliverables.every((item) => !item.includes("**")));
    assert.equal(payload.whatIRemember.enterprisePrompt.present, false);
    assert.deepEqual(payload.whatIRemember.evolutionNotes, []);
    assert.ok(payload.whatIRemember.enabledSkillCount >= 1);
    assert.equal(payload.ownerNotes.text, null);
    assert.equal(payload.ownerNotes.source, "catalog");
    assert.match(payload.ownerNotes.fallback, /赵先机/u);
    assert.equal(payload.ownerNotes.maxChars, 1500);
    assert.equal(payload.check.status, "never");
    assert.equal(payload.permissions.canEdit, true);

    const badDomain = await call(base, "GET", "/employee-intro/wine/101");
    assert.equal(badDomain.status, 404);
    const content = await call(base, "GET", "/employee-intro/content/1");
    assert.equal(content.status, 501);
    const missing = await call(base, "GET", "/employee-intro/restaurant/999");
    assert.equal(missing.status, 404);
  });
});

test("PUT 老板叮嘱后 GET 生效，并注入两种派活 system prompt；租户隔离", async () => {
  await withServer(async (base) => {
    const ownerText = "我们是社区早餐店，所有结论先按 6-9 点早高峰算；报告开头先给一句话结论。";
    const saved = await call(base, "PUT", "/employee-intro/restaurant/101", { body: { text: ownerText } });
    assert.equal(saved.status, 200, JSON.stringify(saved.payload));
    assert.equal(saved.payload.ownerNotes.text, ownerText);
    assert.equal(saved.payload.ownerNotes.source, "owner_edited");
    assert.ok(saved.payload.ownerNotes.updatedAt);
    assert.equal(saved.payload.ownerNotes.injected, true);

    const fetched = await call(base, "GET", "/employee-intro/restaurant/101", { user: "staff1" });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.payload.ownerNotes.text, ownerText, "一线员工也能读到老板叮嘱");
    assert.equal(fetched.payload.permissions.canEdit, false);

    const opLog = q.get(
      "SELECT action,target FROM op_logs WHERE tenant_id=1 AND action='更新老板叮嘱' ORDER BY id DESC LIMIT 1",
    );
    assert.ok(opLog);
    assert.match(opLog.target, /赵先机#101/u);

    runWithTenant(1, () => {
      const paihuo = buildEmployeeExecutionProfile(101, {
        tenantId: 1,
        user: USERS.boss1,
        outputMode: "paihuo_markdown",
      });
      assert.ok(paihuo.systemContext.includes("【老板叮嘱"), "派活 Markdown 模式必须注入老板叮嘱");
      assert.ok(paihuo.systemContext.includes(ownerText));
      const introIndex = paihuo.systemContext.indexOf("【老板叮嘱");
      const overrideAnchor = paihuo.systemContext.indexOf("【输出语言】");
      assert.ok(introIndex > overrideAnchor, "叮嘱紧跟企业补充提示词位置，在输出语言之后");
      assert.ok(introIndex < paihuo.systemContext.indexOf("【业务结果不可披露约束】"));
      assert.equal(paihuo.workbench.prompts.ownerNotes, ownerText);

      const contract = buildEmployeeExecutionProfile(101, { tenantId: 1, user: USERS.boss1 });
      assert.ok(contract.systemContext.includes(ownerText), "契约模式同样注入");
    });
    runWithTenant(2, () => {
      const other = buildEmployeeExecutionProfile(101, { tenantId: 2, user: USERS.boss2 });
      assert.ok(!other.systemContext.includes(ownerText), "别的企业不能读到本企业老板叮嘱");
      assert.equal(other.workbench.prompts.ownerNotes, null);
    });

    // 清空 → 回落 catalog，且不再注入
    const cleared = await call(base, "PUT", "/employee-intro/restaurant/101", { body: { text: "" } });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.payload.ownerNotes.text, null);
    assert.equal(cleared.payload.ownerNotes.source, "catalog");
    runWithTenant(1, () => {
      const profile = buildEmployeeExecutionProfile(101, { tenantId: 1, user: USERS.boss1, outputMode: "paihuo_markdown" });
      assert.ok(!profile.systemContext.includes("【老板叮嘱"));
    });

    const missingField = await call(base, "PUT", "/employee-intro/restaurant/101", { body: {} });
    assert.equal(missingField.status, 400);
    const tooLong = await call(base, "PUT", "/employee-intro/restaurant/101", { body: { text: "字".repeat(1501) } });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.payload.error, /1500/u);
  });
});

test("非管理层：可读四段但拿不到企业补充提示词原文；不能改、不能校验、不能确认", async () => {
  runWithTenant(1, () => {
    updateEmployeePrompt(101, "本企业所有报告先给早餐时段结论。", USERS.boss1);
  });
  await withServer(async (base) => {
    for (const user of ["staff1", "ops1"]) {
      const view = await call(base, "GET", "/employee-intro/restaurant/101", { user });
      assert.equal(view.status, 200, user);
      assert.equal(view.payload.whatIRemember.enterprisePrompt.present, true, user);
      assert.ok(view.payload.whatIRemember.enterprisePrompt.chars > 0, user);
      assert.equal(view.payload.whatIRemember.enterprisePrompt.text, null, `${user} 不得拿到提示词原文`);
      assert.equal(view.payload.whatIRemember.enterprisePrompt.redacted, true, user);
      assert.equal(view.payload.permissions.canViewEnterprisePrompt, false, user);
      const denied = await call(base, "PUT", "/employee-intro/restaurant/101", { user, body: { text: "x" } });
      assert.equal(denied.status, 403, user);
      const verifyDenied = await call(base, "POST", "/employee-intro/restaurant/101/verify", { user, body: {} });
      assert.equal(verifyDenied.status, 403, user);
      const confirmDenied = await call(base, "POST", "/employee-intro/restaurant/101/confirm", { user, body: {} });
      assert.equal(confirmDenied.status, 403, user);
    }
    for (const user of ["boss1", "admin1"]) {
      const view = await call(base, "GET", "/employee-intro/restaurant/101", { user });
      assert.equal(view.payload.whatIRemember.enterprisePrompt.text, "本企业所有报告先给早餐时段结论。", user);
      assert.equal(view.payload.whatIRemember.enterprisePrompt.redacted, false, user);
    }
  });
  runWithTenant(1, () => {
    updateEmployeePrompt(101, "", USERS.boss1);
  });
});

test("verify 命中规则a → needs_review 并写可读 note；员工目录带 introCheckStatus；confirm 清状态；过期后再次提醒", async () => {
  await withServer(async (base) => {
    await call(base, "PUT", "/employee-intro/restaurant/101", {
      body: { text: "铺位评估交给李选址，顺便把租约问题清单也一起交。" },
    });
    const verified = await call(base, "POST", "/employee-intro/restaurant/101/verify", { body: {} });
    assert.equal(verified.status, 200, JSON.stringify(verified.payload));
    assert.equal(verified.payload.result.status, "needs_review");
    assert.equal(verified.payload.result.mode, "deterministic");
    assert.equal(verified.payload.billing.charged, false);
    assert.match(verified.payload.result.note, /李选址/u);
    assert.match(verified.payload.result.note, /104 号岗位/u);
    assert.ok(verified.payload.result.findings.some((item) => item.code === "FOREIGN_PERSON" && item.evidence.idx === 104));
    assert.equal(verified.payload.intro.check.status, "needs_review");

    const catalog = await call(base, "GET", "/employees", { user: "staff1" });
    assert.equal(catalog.status, 200);
    const card = catalog.payload.employees.find((item) => item.idx === 101);
    assert.equal(card.introCheckStatus, "needs_review");
    assert.equal(catalog.payload.employees.find((item) => item.idx === 102).introCheckStatus, "never");

    const llm = await call(base, "POST", "/employee-intro/restaurant/101/verify", { body: { mode: "llm" } });
    assert.equal(llm.status, 501);

    const confirmed = await call(base, "POST", "/employee-intro/restaurant/101/confirm", { body: {} });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.payload));
    assert.equal(confirmed.payload.check.status, "ok");
    assert.equal(confirmed.payload.check.note, null);
    assert.ok(confirmed.payload.check.verifiedAt);
    assert.equal(confirmed.payload.check.verifiedDaysAgo, 0);

    // 确认后内容没变：再校验仍是 ok（跨岗位引用视为老板有意保留）
    const again = await call(base, "POST", "/employee-intro/restaurant/101/verify", { body: {} });
    assert.equal(again.payload.result.status, "ok", JSON.stringify(again.payload.result));
    assert.ok(again.payload.result.acknowledgedCount >= 1);

    // 老板确认已超 30 天 → 规则 d 提醒
    q.run(
      `UPDATE tenant_specialist_overrides SET self_intro_verified_at=datetime('now','localtime','-40 days')
       WHERE tenant_id=1 AND specialist_id=?`,
      specialistIdFor(101),
    );
    const stale = await call(base, "POST", "/employee-intro/restaurant/101/verify", { body: {} });
    assert.equal(stale.payload.result.status, "needs_review");
    assert.ok(stale.payload.result.findings.some((item) => item.code === "CONFIRMATION_STALE"));
    assert.match(stale.payload.result.note, /超过 30 天/u);
    const afterStale = await call(base, "GET", "/employee-intro/restaurant/101");
    assert.equal(afterStale.payload.check.status, "needs_review");
    assert.ok(afterStale.payload.check.verifiedDaysAgo >= 39);
  });
});

test("verify 未命中：叮嘱只讲本岗位口径 → ok", async () => {
  await withServer(async (base) => {
    await call(base, "PUT", "/employee-intro/restaurant/102", {
      body: { text: "商圈边界按步行 10 分钟等时圈画，竞品矩阵至少列 8 家。" },
    });
    const verified = await call(base, "POST", "/employee-intro/restaurant/102/verify", { body: {} });
    assert.equal(verified.status, 200);
    // 首次定制、老板从未确认 → 只应有规则 d 的 never_confirmed，不应有规则 a/b 命中
    const codes = verified.payload.result.findings.map((item) => item.code);
    assert.deepEqual(codes, ["NEVER_CONFIRMED"], codes.join(","));
    const confirmed = await call(base, "POST", "/employee-intro/restaurant/102/confirm", { body: {} });
    assert.equal(confirmed.payload.check.status, "ok");
    const clean = await call(base, "POST", "/employee-intro/restaurant/102/verify", { body: {} });
    assert.equal(clean.payload.result.status, "ok");
    assert.deepEqual(clean.payload.result.findings, []);
  });
});

test("周任务：只扫有定制的员工，汇总一条通知给 boss/admin，runOnce 幂等，租户隔离", async () => {
  // 此时租户 1：101（needs_review：叮嘱含李选址 + 确认过期）、102（ok）；租户 2 无定制
  runWithTenant(1, () => {
    assert.deepEqual(candidateIntroCheckEmployees(1), [101, 102]);
  });
  runWithTenant(2, () => {
    assert.deepEqual(candidateIntroCheckEmployees(2), []);
    const empty = runWeeklyEmployeeIntroCheck({ tenantId: 2 });
    assert.equal(empty.checked, 0);
    assert.equal(empty.notified, 0);
  });

  const monday0900 = new Date("2026-09-07T01:00:10.000Z"); // 上海 2026-09-07（周一）09:00
  const first = runScheduledJobs(monday0900);
  await first.pending;
  const tenantOne = first.results.find((item) => item.tenantId === 1);
  assert.equal(tenantOne.weeklyEmployeeIntroCheck, true, JSON.stringify(tenantOne));
  const countIntroNotices = (userId) =>
    q.get(
      "SELECT COUNT(*) n FROM notifications WHERE user_id=? AND type='employee-intro-check'",
      userId,
    ).n;
  assert.equal(countIntroNotices(boss1), 1);
  assert.equal(countIntroNotices(admin1), 1);
  assert.equal(countIntroNotices(staff1), 0);
  assert.equal(countIntroNotices(ops1), 0);
  assert.equal(countIntroNotices(boss2), 0);
  const notice = q.get(
    "SELECT title,body,link FROM notifications WHERE user_id=? AND type='employee-intro-check'",
    boss1,
  );
  assert.equal(notice.title, "本周有 1 位数字员工的自我介绍需要你确认");
  assert.match(notice.body, /赵先机/u);
  assert.equal(notice.link, "/employees/restaurant/101/intro");

  const second = runScheduledJobs(monday0900);
  await second.pending;
  assert.equal(second.results.find((item) => item.tenantId === 1).weeklyEmployeeIntroCheck, false);
  assert.equal(countIntroNotices(boss1), 1, "同一周重复 tick 不得重复通知");
  assert.equal(
    q.get(
      "SELECT COUNT(*) n FROM scheduled_runs WHERE tenant_id=1 AND job_key='weekly_employee_intro_check:2026-09-07'",
    ).n,
    1,
  );

  // 非周一 09:00 不触发
  const tuesday = runScheduledJobs(new Date("2026-09-08T01:00:10.000Z"));
  await tuesday.pending;
  assert.equal(tuesday.results.find((item) => item.tenantId === 1).weeklyEmployeeIntroCheck, false);
});

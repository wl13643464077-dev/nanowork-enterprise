// PRD v2.2 FR-6 技能补充包：只追加、原卡零改动、确认后才注入；FR-1/FR-3 题型进入派活提示词。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DBP = path.join(os.tmpdir(), `nanowork-skill-supplement-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = " ";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.SEED_DEMO = "false";

const { initSchema, migrateV2, q, runWithTenant } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const supplement = await import("../src/engines/employee-skill-supplement.js");
const {
  buildEmployeeExecutionProfile,
  employeeSkillSupplementView,
  reviewEmployeeSkillSupplement,
} = await import("../src/employee-workbench.js");
const { classifyEmployeeIntent } = await import("../src/engines/employee-intent-router.js");
const { closeSharedDb, removeDbFiles } = await import("./helpers/temp-db.mjs").catch(() => ({}));

initSchema();
migrateV2();
ensureBaselineCatalogs();

after(async () => {
  if (closeSharedDb) await closeSharedDb(DBP);
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

const CATALOG = new URL("../catalog/", import.meta.url);
const BOSS = { id: 1, role: "boss", tenant_id: 1 };
const STAFF = { id: 2, role: "staff", tenant_id: 1 };

test("原 409 张技能卡字节不变，补充包基线指纹一致", () => {
  const original = fs.readFileSync(new URL("employee-skills.json", CATALOG));
  const sha = crypto.createHash("sha256").update(original).digest("hex");
  const pack = JSON.parse(fs.readFileSync(new URL("employee-skills-supplement.json", CATALOG), "utf8"));
  assert.equal(pack.policy.originalCatalogSha256, sha);
  assert.equal(pack.policy.appendOnly, true);
  const cards = JSON.parse(original).profiles.reduce((sum, profile) => sum + profile.skills.length, 0);
  assert.equal(cards, 409);
  const loaded = supplement.loadEmployeeSkillSupplement({ force: true });
  assert.equal(loaded.ok, true, loaded.error);
});

test("原卡被改动时补充包拒绝加载（原卡不受影响）", () => {
  const tmp = path.join(os.tmpdir(), `skills-tampered-${process.pid}.json`);
  fs.writeFileSync(tmp, fs.readFileSync(new URL("employee-skills.json", CATALOG), "utf8") + " ");
  const loaded = supplement.loadEmployeeSkillSupplement({ originalPath: tmp, force: true });
  assert.equal(loaded.ok, false);
  assert.match(loaded.error, /指纹/);
  fs.rmSync(tmp, { force: true });
  supplement.resetEmployeeSkillSupplementCache();
});

test("61 位餐饮员工每人至少 1 张补充卡，查巡巡补 8 张，另有 4 张通用卡", () => {
  for (let idx = 101; idx <= 161; idx += 1) {
    const own = supplement.supplementCardsForEmployee(idx, { includeCommon: false });
    assert.ok(own.length >= 1, `员工${idx}没有补充卡`);
  }
  assert.equal(supplement.supplementCardsForEmployee(161, { includeCommon: false }).length, 8);
  const loaded = supplement.loadEmployeeSkillSupplement();
  assert.equal(loaded.common.length, 4);
});

test("补充技能提示词不含任何 URL（交付硬门会拦截未核验链接）", () => {
  const cards = supplement.withReviewStatus(supplement.supplementCardsForEmployee(146)).map((card) => ({
    ...card,
    status: supplement.SUPPLEMENT_STATUS_ENABLED,
  }));
  const text = supplement.supplementSkillPromptLines(cards).join("\n");
  assert.match(text, /补充技能（中国门店以此为准/);
  assert.doesNotMatch(text, /https?:\/\//);
});

test("默认全部待确认：派活提示词与改造前一致，不注入补充卡", () => {
  runWithTenant(1, () => {
    const view = employeeSkillSupplementView(116);
    assert.equal(view.available, true);
    assert.equal(view.summary.enabled, 0);
    assert.ok(view.summary.pending >= 5);
    const execution = buildEmployeeExecutionProfile(116, { outputMode: "paihuo_markdown" });
    assert.doesNotMatch(execution.systemContext, /补充技能（中国门店以此为准/);
    assert.equal(execution.snapshot.skillSupplement, undefined);
    assert.equal(execution.snapshot.intent, undefined);
    assert.match(execution.systemContext, /必须按其中的必要输入\/工作流\/交付物执行/);
  });
});

test("老板确认启用后，补充卡追加在原技能库之后进入派活提示词；暂不启用的不注入", () => {
  runWithTenant(1, () => {
    const own = employeeSkillSupplementView(116).cards.filter((card) => card.scope === "employee");
    const [first, second] = own;
    assert.throws(() => reviewEmployeeSkillSupplement(116, [{ cardId: first.id, status: "owner_verified_enabled" }], STAFF), /仅老板或管理员/);
    assert.throws(() => reviewEmployeeSkillSupplement(116, [{ cardId: "supp-2026-11:102:01", status: "owner_verified_enabled" }], BOSS), /不属于该员工/);
    const view = reviewEmployeeSkillSupplement(116, [
      { cardId: first.id, status: "owner_verified_enabled" },
      { cardId: second.id, status: "owner_declined" },
    ], BOSS);
    assert.equal(view.summary.enabled, 1);
    assert.equal(view.summary.declined, 1);
    for (const mode of ["paihuo_markdown", undefined]) {
      const execution = buildEmployeeExecutionProfile(116, { outputMode: mode });
      const context = execution.systemContext;
      const originalPos = context.indexOf(execution.snapshot.skills[0].title);
      const supplementPos = context.indexOf("补充技能（中国门店以此为准");
      assert.ok(originalPos >= 0 && supplementPos > originalPos, "补充卡必须排在原卡之后");
      assert.ok(context.includes(first.title));
      assert.ok(!context.includes(second.title));
      assert.deepEqual(execution.snapshot.skillSupplement.cardIds, [first.id]);
      // 原技能库快照不含补充卡
      assert.ok(execution.snapshot.skills.every((skill) => !String(skill.id || "").startsWith("supp-")));
    }
    // 租户隔离：其他企业仍是待确认
    runWithTenant(2, () => assert.equal(employeeSkillSupplementView(116).summary.enabled, 0));
  });
});

test("派活带题型时注入答题形态，短题型把手册改为方法参考", () => {
  runWithTenant(1, () => {
    const intent = classifyEmployeeIntent({ employeeIdx: 102, title: "北京望京商圈餐饮的客单价是什么范围，有哪些代表的店，再具体看下火锅及火锅相似竞品" });
    const execution = buildEmployeeExecutionProfile(102, { outputMode: "paihuo_markdown", intent });
    assert.match(execution.systemContext, /【本次题型·最高优先级】快查/);
    assert.match(execution.systemContext, /方法参考：本次按下方“本次题型”的形态交付/);
    assert.equal(execution.snapshot.intent.type, "lookup");
    assert.equal(execution.intent.answer_shape, "lookup.market_scan");
    const report = buildEmployeeExecutionProfile(102, {
      outputMode: "paihuo_markdown",
      intent: classifyEmployeeIntent({ employeeIdx: 102, title: "帮我出一份望京开店完整商圈报告给合伙人看" }),
    });
    assert.match(report.systemContext, /必须按其中的必要输入\/工作流\/交付物执行/);
  });
});

test("审核表在数据库中按租户存储", () => {
  const rows = q.all("SELECT tenant_id,card_id,status FROM employee_skill_supplement_reviews ORDER BY card_id");
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((row) => row.tenant_id === 1));
});

import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-employee-research-plan-matrix-${process.pid}.db`,
);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  fs.rmSync(file, { force: true });
}
process.env.NANOWORK_DB = DB_PATH;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.BOCHA_API_KEY = "";
process.env.TAVILY_API_KEY = "";
process.env.SERPER_API_KEY = "";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.SEED_DEMO = "false";

const { initSchema, migrateV2 } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { buildEmployeeExecutionProfile } =
  await import("../src/employee-workbench.js");
const { compileEmployeePublicResearchPlan } =
  await import("../src/engines/employee-public-research-plan.js");

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

after(() => {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    fs.rmSync(file, { force: true });
  }
});

test("101–160每个餐饮数字员工都把自己的启用技能编译成专属取证计划", () => {
  for (let idx = 101; idx <= 160; idx += 1) {
    const employeeExecution = buildEmployeeExecutionProfile(idx, {
      tenantId: 1,
      user: { id: 1, role: "boss", tenant_id: 1 },
    });
    const plan = compileEmployeePublicResearchPlan(employeeExecution, {
      title: `员工${idx}线上业务任务`,
      requirement: "按岗位职责核验当前公开信息",
    });
    assert.equal(plan.employeeIdx, idx);
    assert.ok(plan.skillCount > 1, `员工${idx}应载入完整技能库`);
    assert.ok(plan.queries.length >= 2, `员工${idx}应有技能取证计划`);
    assert.ok(
      plan.lanes.some(
        (lane) =>
          lane.key === "employee_skill_topics" &&
          lane.sourceSkillIds.length > 0,
      ),
      `员工${idx}应将自己的技能ID绑定到取证车道`,
    );
    assert.equal(plan.lanes.at(-1)?.key, "official_business");
    assert.ok(
      plan.queries.every((query) => query.includes(`员工${idx}线上业务任务`)),
    );
    assert.deepEqual(plan.apiClaims, []);
  }
});

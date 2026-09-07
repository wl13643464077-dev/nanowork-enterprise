import assert from "node:assert/strict";
import fs from "node:fs";
import test, { after } from "node:test";

Object.assign(process.env, {
  NODE_ENV: "test",
  NANOWORK_DB: ":memory:",
  YUNWU_API_KEY: " ",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  ENABLE_BACKGROUND_EMBEDDINGS: "false",
  ENABLE_SCHEDULER: "false",
  SEED_DEMO: "false",
});

const { db, initSchema, migrateV2 } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { buildEmployeeWorkbench } = await import("../src/employee-workbench.js");
const { CONTENT_EMPLOYEE_ROSTER } =
  await import("../src/catalog/content-crew.js");
const { buildContentEmployeeWorkbenchProfile } =
  await import("../src/engines/content-employee-workbench.js");

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

after(() => db.close());

const manager = { id: 1, role: "boss" };

function firstUsageExample(profile) {
  return String(profile?.dispatch?.guidance?.taskExamples?.[0] || "").trim();
}

test("73名数字员工都有简短、逐岗不同的一句话示例", () => {
  const rows = [];
  for (let idx = 101; idx <= 161; idx += 1) {
    const profile = buildEmployeeWorkbench(idx, { user: manager });
    rows.push({
      domain: "restaurant",
      idx,
      name: profile.identity.name,
      example: firstUsageExample(profile),
    });
  }
  for (const employee of CONTENT_EMPLOYEE_ROSTER) {
    const profile = buildContentEmployeeWorkbenchProfile(employee.idx);
    rows.push({
      domain: "content",
      idx: employee.idx,
      name: profile.identity.name,
      example: firstUsageExample(profile),
    });
  }

  assert.equal(rows.length, 73);
  assert.equal(rows.filter((row) => row.domain === "restaurant").length, 61);
  assert.equal(rows.filter((row) => row.domain === "content").length, 12);
  assert.deepEqual(
    rows.filter((row) => !row.example),
    [],
  );
  assert.ok(
    rows.every((row) => row.example.length >= 12 && row.example.length <= 80),
  );
  assert.equal(new Set(rows.map((row) => row.example)).size, 73);
  assert.ok(
    rows.every((row) => !/通用占位|请输入|待配置|示例任务/u.test(row.example)),
  );
});

test("普通71岗与原生专岗10/11分别走对应的一句话示例页面", () => {
  const workbench = fs.readFileSync(
    new URL("../../web/src/components/EmployeeWorkbench.tsx", import.meta.url),
    "utf8",
  );
  const nativeChat = fs.readFileSync(
    new URL("../../web/src/components/NativeEmployeeChat.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    workbench,
    /const dedicatedContentTask = domain === 'content' && \(idx === 10 \|\| idx === 11\)/u,
  );
  assert.match(
    workbench,
    /const oneLineExample = !dedicatedContentTask \? stringList\(profile\.dispatch\.guidance\?\.taskExamples\)\[0\] : ''/u,
  );
  assert.match(
    workbench,
    /<span>一句话使用我<\/span>[\s\S]*?\{oneLineExample\}/u,
  );
  assert.match(
    workbench,
    /dispatchForm\.setFieldValue\('question', oneLineExample\)/u,
  );

  assert.match(nativeChat, /const examples = \{\s*10:\s*\[[\s\S]*?11:\s*\[/u);
  assert.match(nativeChat, /<h4>一句话使用我<\/h4>/u);
  assert.match(nativeChat, /<summary>一句话使用我<\/summary>/u);
  assert.match(nativeChat, /setText\(example\.text\)/u);
  assert.match(nativeChat, /disabled=\{blocked\}/u);
});

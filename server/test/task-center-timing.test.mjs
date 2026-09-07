import assert from "node:assert/strict";
import { after, test } from "node:test";

Object.assign(process.env, {
  NANOWORK_DB: ":memory:",
  NODE_ENV: "test",
  NANOWORK_TEST_TEMPLATE_AI: "1",
  ENABLE_SCHEDULER: "false",
  YUNWU_API_KEY: "",
  OPENAI_API_KEY: "",
});
const { db, q, initSchema, migrateV2, runWithTenant } =
  await import("../src/db.js");
const { getUnifiedTaskDetail, listUnifiedTasks } =
  await import("../src/engines/task-center.js");
initSchema();
migrateV2();
assert.equal(db.prepare("PRAGMA database_list").get().file, "");
q.run(
  "INSERT INTO tenants(id,name,status,credits) VALUES(411,'任务计时隔离','已开通',10000)",
);
const ownerId = Number(
  q.run(
    "INSERT INTO users(tenant_id,username,password_hash,name,role,status) VALUES(411,'task-timer','x','老板','boss','启用')",
  ).lastInsertRowid,
);
const user = { id: ownerId, tenant_id: 411, role: "boss", name: "老板" };
const start = "2026-09-05T10:00:00.000Z";
const end = "2026-09-05T10:01:00.000Z";
let now = Date.parse(start) + 120000;
const originalNow = Date.now;
Date.now = () => now;
after(() => {
  Date.now = originalNow;
  db.close();
});
const makeContent = (status, snapshot = {}) =>
  Number(
    q.run(
      `INSERT INTO contents(tenant_id,creator_id,type,title,body,status,ai_mode,content_employee_idx,source_type,snapshot_json,created_at)
  VALUES(411,?,'小红书图文','已收到正文','完整已生成结果',?,'api',11,'ai_xhs_note',?,?)`,
      ownerId,
      status,
      JSON.stringify(snapshot),
      start,
    ).lastInsertRowid,
  );
const noEnd = makeContent("草稿", {
  status: "success",
  input: {
    brandName: "罗二火锅",
    brief: "一句自然需求",
    requestKey: "technical-request",
    fileIds: [987654],
    model: "technical-model",
    audioMode: "technical-mode",
  },
});
const knownEnd = makeContent("草稿", { status: "success", completedAt: end });
const active = makeContent("生成中", { status: "running" });
const blocked = Number(
  q.run(
    `INSERT INTO media_jobs(tenant_id,user_id,kind,model,prompt,status,snapshot_json,created_at)
  VALUES(411,?,'video','wan2.6','被阻塞的媒体','阻塞','{}',?)`,
    ownerId,
    start,
  ).lastInsertRowid,
);
const activeWithHeartbeat = Number(
  q.run(
    `INSERT INTO content_employee_runs(tenant_id,created_by,employee_idx,employee_key,employee_name,employee_group,title,type,requirement,status,result_md,profile_version,prompt_hash,snapshot_json,created_at,updated_at)
  VALUES(411,?,3,'writer','撰稿人','内容','进行中','图文','继续生成','生成中','','v1','hash','{}',?,?)`,
    ownerId,
    start,
    end,
  ).lastInsertRowid,
);
const snapshot = (kind, id) =>
  runWithTenant(411, () => ({
    detail: getUnifiedTaskDetail(user, kind, id),
    list: listUnifiedTasks(user).items.find(
      (row) => row.kind === kind && row.id === id,
    ),
  }));

test("已生成待采纳/待账务对账与受阻任务无可信结束时间时为空，不随当前时间增长", () => {
  for (const [kind, id] of [
    ["generated_content", noEnd],
    ["media", blocked],
  ]) {
    const before = snapshot(kind, id);
    now += 7 * 24 * 3600 * 1000;
    const later = snapshot(kind, id);
    assert.equal(before.detail.elapsedMs, null);
    assert.equal(before.list.elapsedMs, null);
    assert.equal(later.detail.elapsedMs, null);
    assert.equal(later.list.elapsedMs, null);
    if (kind === "media") {
      assert.equal(later.detail.state, "blocked");
      assert.equal(later.list.state, "blocked");
      assert.match(later.detail.displayStatus, /受阻/);
    } else
      assert.equal(
        later.detail.state,
        "blocked",
        "已收正文但无账本，仍保留真实待对账状态",
      );
  }
});

test("有明确完成时间的未采纳结果固定耗时；真正生成中才计时且不把心跳当终点", () => {
  now = Date.parse(start) + 120000;
  const done = snapshot("generated_content", knownEnd);
  assert.equal(done.detail.elapsedMs, 60000);
  assert.equal(done.list.elapsedMs, 60000);
  for (const [kind, id] of [
    ["generated_content", active],
    ["content", activeWithHeartbeat],
  ]) {
    now = Date.parse(start) + 120000;
    const before = snapshot(kind, id);
    assert.equal(before.detail.elapsedMs, 120000);
    assert.equal(before.list.elapsedMs, 120000);
    now += 30000;
    const later = snapshot(kind, id);
    assert.equal(later.detail.elapsedMs - before.detail.elapsedMs, 30000);
    assert.equal(later.list.elapsedMs - before.list.elapsedMs, 30000);
  }
  now += 30 * 24 * 3600 * 1000;
  assert.equal(snapshot("generated_content", knownEnd).detail.elapsedMs, 60000);
});

test("业务输入中文展示，技术参数和原始输入完整保留且不改变反馈绑定的输入版本", () => {
  const result = snapshot("generated_content", noEnd).detail;
  assert.match(result.inputDisplay, /品牌.*罗二火锅/u);
  assert.match(result.inputDisplay, /需求.*一句自然需求/u);
  assert.doesNotMatch(
    result.inputDisplay,
    /RequestKey|FileIds|technical-|987654/u,
  );
  assert.match(result.input, /technical-request/);
  assert.match(result.input, /987654/);
  const before = result.resultVersion.inputHash;
  now += 1000;
  assert.equal(
    snapshot("generated_content", noEnd).detail.resultVersion.inputHash,
    before,
  );
});

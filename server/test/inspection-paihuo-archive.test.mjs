/**
 * 巡店链路回归（离线）：派活模式下巡店督导（#161）必须
 * 1) 在提示词里收到版本化巡店标准清单（派活AI-R7标准库移植）与
 *    “文末机读归档块”要求（不被“只输出Markdown”交付规则压掉）；
 * 2) 产出文末的 ```nanowork-inspection JSON 在任务完成时自动落
 *    store_inspections 并冻结 standards_version；
 * 3) 老板视图与导出正文剥掉机读块，数据库原文保持不变。
 *
 * 真实故障：任务#58 巡店报告2935字质量合格，但派活交付规则禁了代码围栏，
 * 归档块消失、巡店统计颗粒无数据。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-inspection-paihuo-${process.pid}.db`,
);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}
process.env.NANOWORK_DB = DB_PATH;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
delete process.env.NANOWORK_EMPLOYEE_OUTPUT_STYLE;

const { initSchema, migrateV2, q, runWithTenant } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { inspectionStandardsVersion } = await import(
  "../src/engines/store-inspections.js"
);
const { prepareRestaurantOutputForExport } = await import(
  "../src/engines/restaurant-output-export.js"
);
const marshalRoutes = (await import("../src/routes/marshals.js")).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const TENANT_ID = 82_161;
q.run(
  `INSERT INTO tenants(id,name,status,plan,credits)
   VALUES(?,?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET status='已开通',credits=200000`,
  TENANT_ID,
  "巡店回归租户",
  "已开通",
  "旗舰版",
  200_000,
);
runWithTenant(TENANT_ID, () => ensureBaselineCatalogs());
const userId = Number(
  q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits)
     VALUES(?,?,?,?,?,?,?)`,
    `inspect-boss-${process.pid}`,
    "x",
    "巡店老板",
    "boss",
    "启用",
    TENANT_ID,
    200_000,
  ).lastInsertRowid,
);
const specialist = runWithTenant(TENANT_ID, () =>
  q.get(`SELECT id,marshal_id FROM specialists WHERE employee_idx=161 LIMIT 1`),
);
assert.ok(specialist?.id, "基线目录必须包含员工161（巡店督导）");

const ARCHIVE_BLOCK = [
  "```nanowork-inspection",
  JSON.stringify({
    store: "粤菜馆·太原吾悦广场店",
    inspectionType: "例行巡店",
    score: 80,
    subScores: { foodSafety: 15, product: 15, service: 19, hygiene: 14, display: 17 },
    issues: [
      {
        board: "食品安全",
        severity: "高",
        problem: "1名帮厨健康证已过期",
        evidence: "检查记录：健康证到期日为上月",
        action: "当日停止上岗并补办健康证",
        deadline: "当日",
      },
      {
        board: "环境卫生",
        severity: "中",
        problem: "卫生间洗手液缺失",
        evidence: "检查记录：卫生间洗手液缺失",
        action: "当日补充并纳入每日点检",
        deadline: "当日",
      },
      {
        board: "环境卫生",
        severity: "中",
        problem: "疏散通道堆放3个纸箱，堵塞安全出口",
        evidence: "检查记录：疏散通道堆放纸箱",
        action: "立即清空并当日复核",
        deadline: "当日",
      },
    ],
    rectified: null,
  }),
  "```",
].join("\n");

const INSPECTION_MARKDOWN = `# 粤菜馆·太原吾悦广场店 例行巡店记录

**门店**：粤菜馆·太原吾悦广场店；**类型**：例行巡店；**总分**：80/100

## 五大板块评分

| 板块 | 得分 | 依据 |
| --- | --- | --- |
| 食品安全 | 15/20 | 温控合格；健康证过期扣分 |
| 服务规范 | 19/20 | 迎宾与客诉响应到位 |

## 问题清单

1. 【高】帮厨健康证过期——当日停岗补办。
2. 【中】卫生间洗手液缺失——当日补齐。

## 下一步建议

1. 当日整改两项红线/耗材问题并回传照片（负责人：店长）。
2. 三个工作日内建立健康证到期预警台账（负责人：门店HR对接人）。
3. 两周内复查一次，验证整改闭环（负责人：巡店督导）。

${ARCHIVE_BLOCK}
`;

test("派活模式巡店：标准清单入提示词、归档块落表、老板视图剥净机读块", async () => {
  const app = express();
  const generated = [];
  const inspectionSource = (index) => ({
    title: `餐饮门店巡查规范公开来源${index}`,
    url: `https://standards.test/inspection-${index}`,
    snippet: `餐饮巡店检查要点公开摘要${index}`,
  });
  app.locals.employeeEstimateCallCredits = () => 100;
  app.locals.employeeWebSearch = async () => ({
    attempted: true,
    ok: true,
    provider: "offline-search",
    results: [inspectionSource(1)],
    evidence: { externalCall: false },
  });
  app.locals.employeeAgenticWebResearch = async () => {
    const candidates = Array.from({ length: 5 }, (_, index) =>
      inspectionSource(index + 1),
    );
    return {
      attempted: true,
      ok: true,
      candidateReady: true,
      provider: "offline-agentic",
      results: candidates,
      fetchCandidates: candidates,
      evidence: {
        schemaVersion: "nanowork.agentic-web-research/1",
        toolCalls: 5,
        toolAttempts: 5,
        qualityGate: {
          requiredSearches: 5,
          requiredSources: 5,
          observedSearches: 5,
          observedSuccessfulToolResults: 5,
          observedToolResultUrls: 5,
          observedSources: 5,
          passed: true,
        },
        externalCall: false,
      },
    };
  };
  app.locals.employeeControlledWebFetch = async (sources) => {
    const selected = (sources.length ? sources : [inspectionSource(1)]).slice(0, 5);
    return {
      attempted: true,
      ok: true,
      provider: "offline-controlled-fetch",
      results: selected.map((source, index) => ({
        ...source,
        body: `受控网页正文${index + 1}：餐饮门店巡店检查公开规范离线夹具，覆盖食品安全、出品、服务、卫生与陈列检查要点，正文长度超过八十个字符，仅用于验证巡店归档链路，不作为真实公网事实。`,
      })),
      evidence: {
        schemaVersion: "nanowork.controlled-web-evidence/1",
        requested: selected.length,
        fetched: selected.length,
        externalCall: true,
        ssrfProtected: true,
        redirectsRevalidated: true,
      },
    };
  };
  app.locals.employeeGenerate = async (args) => {
    generated.push(args);
    return {
      text: INSPECTION_MARKDOWN,
      mode: "api",
      model: args.model,
      usage: { inputTokens: 900, outputTokens: 700 },
      finishReason: "stop",
    };
  };
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = { id: userId, name: "巡店老板", role: "boss", tenant_id: TENANT_ID };
    runWithTenant(TENANT_ID, () => next());
  });
  app.use("/marshals", marshalRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/marshals/${specialist.marshal_id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        specialistId: specialist.id,
        title: "粤菜馆 太原吾悦广场店 例行巡店评分",
        type: "检查清单",
        requirement:
          "依据现场检查记录完成例行巡店评分与整改清单：健康证1人过期、卫生间洗手液缺失、迎宾与客诉响应到位。",
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    const taskId = Number(payload.taskId);

    let row = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      row = runWithTenant(TENANT_ID, () =>
        q.get(
          `SELECT t.status,t.employee_web_snapshot,c.body
             FROM agent_tasks t LEFT JOIN contents c ON c.id=t.output_id
            WHERE t.tenant_id=? AND t.id=?`,
          TENANT_ID,
          taskId,
        ),
      );
      if (row?.status === "已完成" || row?.status === "失败") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const snapshot = JSON.parse(row?.employee_web_snapshot || "{}");
    assert.equal(
      row?.status,
      "已完成",
      `巡店任务应完成；failure=${JSON.stringify(snapshot.failure || null)}；errors=${JSON.stringify(snapshot.outputContract?.errors || null)}`,
    );

    // 1) 提示词：标准清单 + 归档块豁免都在
    assert.equal(generated.length, 1);
    const args = generated[0];
    assert.match(args.system, /【本企业巡店标准·冻结快照/u);
    assert.match(args.system, /common\.fire_exit/u);
    assert.match(args.system, /nanowork-inspection/u);
    assert.doesNotMatch(args.system, /【机器输出契约·直接派活必须执行】/u);

    // 2) 归档：store_inspections 落表并冻结标准版本
    const record = runWithTenant(TENANT_ID, () =>
      q.get(
        `SELECT store_name,score,issue_count,high_issues,standards_version
           FROM store_inspections WHERE tenant_id=? AND task_id=?`,
        TENANT_ID,
        taskId,
      ),
    );
    assert.ok(record, "巡店归档记录必须存在");
    assert.equal(record.store_name, "粤菜馆·太原吾悦广场店");
    assert.equal(Number(record.score), 80);
    assert.equal(Number(record.issue_count), 3);
    // 疏散通道堵塞是法定红线：模型标“中”也必须被确定性升级为“高”。
    assert.equal(Number(record.high_issues), 2);
    assert.equal(record.standards_version, inspectionStandardsVersion());
    const archivedIssues = JSON.parse(
      runWithTenant(TENANT_ID, () =>
        q.get(
          `SELECT issues_json FROM store_inspections WHERE tenant_id=? AND task_id=?`,
          TENANT_ID,
          taskId,
        ),
      ).issues_json,
    );
    const raised = archivedIssues.find((item) => /疏散通道/u.test(item.problem));
    assert.equal(raised.severity, "高");
    assert.equal(raised.severityRaised, "mandatory_red_line");

    // 3) 数据库原文保留机读块；导出正文剥净
    assert.match(row.body, /nanowork-inspection/u);
    const exportReady = prepareRestaurantOutputForExport(row.body, {
      title: "巡店", requirement: "",
    });
    assert.doesNotMatch(exportReady.body, /nanowork-inspection/u);
    assert.match(exportReady.body, /五大板块评分/u);
  } finally {
    server.close();
  }
});

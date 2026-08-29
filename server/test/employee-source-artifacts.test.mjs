import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import os from "node:os";
import path from "node:path";
import { DOCX_RENDER_VERSION } from "../src/engines/docx-report-renderer.js";
import { PDF_RENDER_VERSION, XLSX_RENDER_VERSION } from "../src/engines/skillrun.js";

const ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "nanowork-source-artifacts-"),
);
const DBP = path.join(ROOT, "test.db");
const ARTIFACT_DIR = path.join(ROOT, "artifacts");

process.env.NANOWORK_DB = DBP;
process.env.NANOWORK_ARTIFACT_DIR = ARTIFACT_DIR;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.SEED_DEMO = "false";

const { initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const {
  default: fileRoutes,
  prepareAuthoritativeSourceBody,
  SOURCE_ARTIFACT_RENDER_VERSION,
} = await import("../src/routes/files.js");

initSchema();
migrateV2();

q.run(`INSERT INTO tenants(id,name,status,plan,credits)
  VALUES(1,'交付文件测试企业','已开通','标准版',100000)
  ON CONFLICT(id) DO UPDATE SET status='已开通'`);
q.run(`INSERT INTO tenants(id,name,status,plan,credits)
  VALUES(2,'隔离企业','已开通','标准版',100000)
  ON CONFLICT(id) DO UPDATE SET status='已开通'`);

function addUser(username, role, tenantId, managerId = null) {
  return Number(
    q.run(
      `INSERT INTO users(
    username,password_hash,name,role,status,tenant_id,manager_id,credits
  ) VALUES(?, 'x', ?, ?, '启用', ?, ?, 100000)`,
      username,
      username,
      role,
      tenantId,
      managerId,
    ).lastInsertRowid,
  );
}

const managerId = addUser("artifact-manager", "manager", 1);
const ownerId = addUser("artifact-owner", "staff", 1, managerId);
const peerId = addUser("artifact-peer", "staff", 1);
const otherTenantBossId = addUser("artifact-other-boss", "boss", 2);

function actor(id) {
  return q.get("SELECT id,name,role,tenant_id FROM users WHERE id=?", id);
}

const actors = {
  manager: actor(managerId),
  owner: actor(ownerId),
  peer: actor(peerId),
  otherBoss: actor(otherTenantBossId),
};

const restaurantFixture = {
  contract_id: "urn:nanowork:restaurant-output:102:test:v3",
  role: {
    employee_idx: 102,
    role_key: "02-trade-area-competitor-profile",
    role_title: "竞品与商圈画像",
  },
  decision_context: {
    problem: "太原迎泽商圈毛血旺开店判断",
    period: "2026年8月",
    scope: "覆盖三公里商圈、直接竞品、价格带与家庭客群。",
    assumptions: [
      {
        assumption: "晚市家庭客群占比仍需线下核验。",
        impact: "影响套餐结构与备货量。",
        verification: "商圈研究员于开业前完成晚市客流抽样。",
      },
    ],
    sources: [
      {
        source: "高德公开榜单",
        period: "2026年8月",
        fact: "公开页面显示商圈内存在毛血旺直接竞品。",
      },
    ],
  },
  deliverables: {
    deliverable_01: {
      deliverable_name: "商圈与竞品判断表",
      summary: "整理竞品存在性、价格缺口与家庭客群验证路径。",
      work_product: {
        artifact_type: "structured_table",
        sections: [
          {
            section_name: "核心判断",
            items: [
              {
                label: "直接竞品",
                result: "陶然居公开门店页构成直接竞品存在性证据。",
                status: "verified",
                evidence_ref: "高德公开榜单",
              },
              {
                label: "价格带",
                result: "当前缺少菜单价与团购价，不能确定主价格带。",
                status: "gap",
                evidence_ref: "竞品菜单公开页",
              },
            ],
          },
        ],
      },
      evidence: [
        {
          source: "竞品菜单公开页",
          period: "2026年8月",
          finding: "当前页面只支持竞品存在性，尚不支持精确定价。",
        },
      ],
      actions: [
        {
          action: "采集吾悦广场同层竞品菜单与团购价格",
          owner: "竞品分析员",
          deadline: "1个工作日内",
          success_metric: "形成含单品价、套餐价和客单价的核验表。",
        },
      ],
      acceptance_checks: [
        {
          criterion: "结论有来源且缺口已披露",
          result: "pass",
          evidence: "核心判断分别标记已核验事实与证据缺口。",
        },
      ],
    },
  },
  quality_review: {
    overall_status: "pass",
    review_note: "当前正文保留事实边界与补证动作。",
    checks: {
      quality_01: {
        criterion: "线上热度与真实交易不混用",
        evidence: "正文未把公开榜单写成真实交易数据。",
        status: "pass",
      },
    },
  },
  safety_review: {
    overall_status: "needs_review",
    escalation_note: "补证前不得外发为最终定案。",
    checks: {
      safety_01: {
        boundary: "价格需来源与核验日",
        handling: "补齐菜单与团购页后再定价。",
        status: "needs_review",
      },
    },
  },
  approval: {
    status: "routed_by_task_policy",
    reviewer_roles: ["任务快照策略"],
    external_action_allowed: false,
    financial_or_regulatory_commitment_allowed: false,
    review_note: "外发、付款和调价需另行授权。",
  },
};
const restaurantBody = JSON.stringify(restaurantFixture);
const restaurantRequirement =
  "输出完整商圈报告，并覆盖竞品、客群、证据缺口与30天验证动作";

const contentBody = `# 公众号选题交付报告

## 推荐选题

1. 山姆落地后，本地餐饮怎么接住新客流
2. 从一顿饭到一座城的消费新变化

| 渠道 | 标题方向 | 优先级 |
| --- | --- | --- |
| 公众号 | 深度解读 | 高 |
| 小红书 | 场景清单 | 中 |`;

let restaurantTaskId;
let restaurantOutputId;
let contentRunId;
let emptyTaskId;
let legacyRawArtifactId;
let legacyXlsxArtifactId;

runWithTenant(1, () => {
  restaurantOutputId = Number(
    q.run(
      `INSERT INTO contents(
    type,title,body,status,risk_level,ai_mode,creator_id
  ) VALUES('员工产出','太原迎泽商圈报告',?,'待审核','none','api',?)`,
      restaurantBody,
      ownerId,
    ).lastInsertRowid,
  );
  restaurantTaskId = Number(
    q.run(
      `INSERT INTO agent_tasks(
    marshal_id,title,type,requirement,status,output_id,created_by
  ) VALUES(1,'太原迎泽商圈','研究',?,'待审阅',?,?)`,
      restaurantRequirement,
      restaurantOutputId,
      ownerId,
    ).lastInsertRowid,
  );
  contentRunId = Number(
    q.run(
      `INSERT INTO content_employee_runs(
    employee_idx,employee_key,employee_name,employee_group,title,type,requirement,status,
    result_md,ai_mode,model,profile_version,prompt_hash,snapshot_json,created_by
  ) VALUES(0,'topic_scout','赵今麦','选题与策略部','公众号选题报告','选题研究','提供可执行选题',
    '待审阅',?,'api','test-model','v1',?,'{}',?)`,
      contentBody,
      crypto.createHash("sha256").update("profile").digest("hex"),
      ownerId,
    ).lastInsertRowid,
  );
  emptyTaskId = Number(
    q.run(
      `INSERT INTO agent_tasks(
    marshal_id,title,type,requirement,status,created_by
  ) VALUES(1,'尚未产出的任务','研究','稍后生成','执行中',?)`,
      ownerId,
    ).lastInsertRowid,
  );
});

const legacyFileName = "legacy-raw-restaurant.docx";
const legacyFileBody = Buffer.from("legacy raw JSON export", "utf8");
fs.mkdirSync(path.join(ARTIFACT_DIR, "1"), { recursive: true });
fs.writeFileSync(path.join(ARTIFACT_DIR, "1", legacyFileName), legacyFileBody);
legacyRawArtifactId = runWithTenant(1, () =>
  Number(
    q.run(
      `INSERT INTO generated_artifacts(
  user_id,source_type,source_id,title,format,content,file_url,file_name,status,metadata
) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ownerId,
      "agent_task",
      restaurantTaskId,
      "太原迎泽商圈报告",
      "docx",
      restaurantBody,
      `/uploads/artifacts/1/${legacyFileName}`,
      legacyFileName,
      "可用",
      JSON.stringify({
        schemaVersion: "nanowork.source-artifact/1",
        size: legacyFileBody.length,
        sourceHash: crypto
          .createHash("sha256")
          .update(restaurantBody)
          .digest("hex"),
      }),
    ).lastInsertRowid,
  ),
);

const legacyPrepared = prepareAuthoritativeSourceBody(
  "agent_task",
  restaurantBody,
  "太原迎泽商圈报告",
);
const legacyWorkbook = new ExcelJS.Workbook();
const legacySheet = legacyWorkbook.addWorksheet("旧版报告");
legacySheet.addRow(["项目", "内容", "状态", "证据"]);
legacySheet.addRow(["商圈", "旧版统一列宽且不换行", "待复核", "高德公开榜单"]);
for (let column = 1; column <= 4; column += 1)
  legacySheet.getColumn(column).width = 22;
const legacyXlsxBody = Buffer.from(await legacyWorkbook.xlsx.writeBuffer());
const legacyXlsxName = "legacy-layout-restaurant.xlsx";
fs.writeFileSync(path.join(ARTIFACT_DIR, "1", legacyXlsxName), legacyXlsxBody);
legacyXlsxArtifactId = runWithTenant(1, () =>
  Number(
    q.run(
      `INSERT INTO generated_artifacts(
  user_id,source_type,source_id,title,format,content,file_url,file_name,status,metadata
) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ownerId,
      "agent_task",
      restaurantTaskId,
      "太原迎泽商圈报告",
      "xlsx",
      legacyPrepared.body,
      `/uploads/artifacts/1/${legacyXlsxName}`,
      legacyXlsxName,
      "可用",
      JSON.stringify({
        schemaVersion: "nanowork.source-artifact/2",
        size: legacyXlsxBody.length,
        sourceHash: legacyPrepared.sourceHash,
        rawSourceHash: legacyPrepared.rawSourceHash,
        renderVersion: legacyPrepared.renderVersion,
        artifactRenderVersion: "xlsx-layout/0",
      }),
    ).lastInsertRowid,
  ),
);

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) =>
    runWithTenant(user.tenant_id, () => {
      req.user = user;
      next();
    }),
  );
  app.use("/files", fileRoutes);
  return app;
}

async function withServer(user, operation) {
  const server = appFor(user).listen(0, "127.0.0.1");
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    return await operation(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function jsonRequest(base, route, { method = "GET", body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test("服务端从待审阅餐饮任务真实正文自动交付 PDF、Word、Excel，并按正文哈希幂等", async () => {
  const prepared = prepareAuthoritativeSourceBody(
    "agent_task",
    restaurantBody,
    "太原迎泽商圈报告",
    restaurantRequirement,
  );
  assert.equal(prepared.transformed, true);
  assert.equal(prepared.sourceBodyKind, "restaurant_structured_json");
  assert.equal(prepared.renderVersion, SOURCE_ARTIFACT_RENDER_VERSION);
  assert.notEqual(prepared.sourceHash, prepared.rawSourceHash);
  assert.match(prepared.body, /^# 竞品与商圈画像｜太原迎泽商圈/mu);
  assert.match(prepared.body, /## 交付成果/u);
  assert.match(prepared.body, /陶然居公开门店页构成直接竞品存在性证据/u);
  assert.match(prepared.body, /高德公开榜单/u);
  assert.match(prepared.body, /外发、付款和调价需另行授权/u);
  assert.match(prepared.body, /## 任务范围/u);
  assert.match(prepared.body, new RegExp(restaurantRequirement, "u"));
  assert.doesNotMatch(prepared.body, /"contract_id"\s*:/u);

  await withServer(actors.owner, async (base) => {
    const first = await jsonRequest(base, "/files/artifacts/source", {
      method: "POST",
      body: { sourceType: "agent_task", sourceId: restaurantTaskId },
    });
    assert.equal(first.response.status, 200, JSON.stringify(first.payload));
    assert.equal(first.payload.source.sourceType, "agent_task");
    assert.equal(first.payload.source.sourceId, restaurantTaskId);
    assert.equal(first.payload.source.requirement, restaurantRequirement);
    assert.equal(first.payload.source.status, "待审核");
    assert.equal(first.payload.source.sourceHash, prepared.sourceHash);
    assert.equal(first.payload.source.rawSourceHash, prepared.rawSourceHash);
    assert.equal(
      first.payload.source.renderVersion,
      SOURCE_ARTIFACT_RENDER_VERSION,
    );
    assert.equal(
      first.payload.source.sourceBodyKind,
      "restaurant_structured_json",
    );
    assert.deepEqual(
      first.payload.deliverables.map((item) => item.format),
      ["pdf", "docx", "xlsx"],
    );
    for (const item of first.payload.deliverables) {
      assert.equal(item.status, "ready");
      assert.equal(item.draft, true);
      assert.equal(item.reused, false);
      assert.ok(item.size > 100);
      assert.match(item.sha256, /^[a-f0-9]{64}$/u);
      assert.equal(item.sourceHash, first.payload.source.sourceHash);
      assert.equal(item.rawSourceHash, prepared.rawSourceHash);
      assert.equal(item.renderVersion, SOURCE_ARTIFACT_RENDER_VERSION);
      assert.equal(
        item.artifactRenderVersion,
        item.format === "xlsx"
          ? XLSX_RENDER_VERSION
          : item.format === "docx"
            ? DOCX_RENDER_VERSION
            : PDF_RENDER_VERSION,
      );
      assert.equal(item.sourceBodyKind, "restaurant_structured_json");
      assert.notEqual(item.id, legacyRawArtifactId);
      if (item.format === "xlsx")
        assert.notEqual(item.id, legacyXlsxArtifactId);
      assert.equal(
        item.downloadUrl,
        `/api/files/artifacts/${item.id}/download`,
      );
    }

    const stored = runWithTenant(1, () =>
      q.all(
        `SELECT * FROM generated_artifacts
      WHERE tenant_id=? AND source_type='agent_task' AND source_id=?
        AND id NOT IN (?,?) ORDER BY id`,
        1,
        restaurantTaskId,
        legacyRawArtifactId,
        legacyXlsxArtifactId,
      ),
    );
    assert.equal(stored.length, 3);
    assert.equal(
      stored.every((row) => row.content === prepared.body),
      true,
    );
    assert.equal(
      stored.every((row) => !row.content.includes('"contract_id":')),
      true,
    );
    assert.equal(
      stored.every(
        (row) =>
          JSON.parse(row.metadata).schemaVersion ===
          "nanowork.source-artifact/2",
      ),
      true,
    );

    const docxRow = stored.find((row) => row.format === "docx");
    const docx = await JSZip.loadAsync(
      fs.readFileSync(path.join(ARTIFACT_DIR, "1", docxRow.file_name)),
    );
    const documentXml = await docx.file("word/document.xml").async("string");
    assert.match(documentXml, /竞品与商圈画像｜太原迎泽商圈/u);
    assert.match(documentXml, /陶然居公开门店页构成直接竞品存在性证据/u);
    assert.doesNotMatch(documentXml, /&quot;contract_id&quot;/u);

    const xlsxRow = stored.find((row) => row.format === "xlsx");
    assert.equal(
      JSON.parse(xlsxRow.metadata).artifactRenderVersion,
      XLSX_RENDER_VERSION,
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(
      path.join(ARTIFACT_DIR, "1", xlsxRow.file_name),
    );
    const sheetText = [];
    workbook.worksheets.forEach((sheet) =>
      sheet.eachRow((row) => {
        row.eachCell((cell) =>
          sheetText.push(String(cell.text || cell.value || "")),
        );
      }),
    );
    assert.match(
      sheetText.join("\n"),
      /陶然居公开门店页构成直接竞品存在性证据/u,
    );
    assert.match(sheetText.join("\n"), /高德公开榜单/u);
    assert.match(sheetText.join("\n"), /补证前不得外发为最终定案/u);
    assert.match(sheetText.join("\n"), /外发、付款和调价需另行授权/u);
    assert.doesNotMatch(sheetText.join("\n"), /"contract_id"\s*:/u);

    const pdfRow = stored.find((row) => row.format === "pdf");
    const pdfBuffer = fs.readFileSync(
      path.join(ARTIFACT_DIR, "1", pdfRow.file_name),
    );
    assert.equal(pdfBuffer.subarray(0, 5).toString("ascii"), "%PDF-");

    const again = await jsonRequest(base, "/files/artifacts/from-source", {
      method: "POST",
      body: { sourceType: "agent_task", sourceId: restaurantTaskId },
    });
    assert.equal(again.response.status, 200, JSON.stringify(again.payload));
    assert.deepEqual(
      again.payload.deliverables.map((item) => item.id),
      first.payload.deliverables.map((item) => item.id),
    );
    assert.equal(
      again.payload.deliverables.every((item) => item.reused === true),
      true,
    );

    const filtered = await jsonRequest(
      base,
      `/files/artifacts?sourceType=agent_task&sourceId=${restaurantTaskId}`,
    );
    assert.equal(
      filtered.response.status,
      200,
      JSON.stringify(filtered.payload),
    );
    assert.equal(filtered.payload.length, 5);
    assert.equal(
      filtered.payload.every((row) => row.source_type === "agent_task"),
      true,
    );
    assert.equal(
      filtered.payload.every(
        (row) => Number(row.source_id) === restaurantTaskId,
      ),
      true,
    );
    assert.equal(
      filtered.payload.every((row) => row.deliverable?.downloadUrl),
      true,
    );

    const current = await jsonRequest(
      base,
      `/files/artifacts/source/agent_task/${restaurantTaskId}`,
    );
    assert.equal(current.response.status, 200, JSON.stringify(current.payload));
    assert.equal(current.payload.deliverables.length, 3);

    const pdf = first.payload.deliverables.find(
      (item) => item.format === "pdf",
    );
    const download = await fetch(`${base}/files/artifacts/${pdf.id}/download`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/pdf");
    assert.match(
      download.headers.get("content-disposition") || "",
      /^attachment;/u,
    );
    assert.match(download.headers.get("cache-control") || "", /no-store/u);
    const downloaded = Buffer.from(await download.arrayBuffer());
    assert.equal(downloaded.length, pdf.size);
    assert.equal(
      crypto.createHash("sha256").update(downloaded).digest("hex"),
      pdf.sha256,
    );

    const updatedRestaurantBody = JSON.stringify({
      ...restaurantFixture,
      decision_context: {
        ...restaurantFixture.decision_context,
        scope: `${restaurantFixture.decision_context.scope} 将工作日午市作为第二轮验证。`,
      },
    });
    runWithTenant(1, () =>
      q.run(
        `UPDATE contents SET body=? WHERE tenant_id=? AND id=?`,
        updatedRestaurantBody,
        1,
        restaurantOutputId,
      ),
    );
    const changed = await jsonRequest(base, "/files/artifacts/source", {
      method: "POST",
      body: {
        sourceType: "agent_task",
        sourceId: restaurantTaskId,
        formats: ["pdf"],
      },
    });
    assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
    assert.equal(changed.payload.deliverables.length, 1);
    assert.notEqual(changed.payload.deliverables[0].id, pdf.id);
    assert.notEqual(
      changed.payload.source.sourceHash,
      first.payload.source.sourceHash,
    );
  });

  assert.equal(
    runWithTenant(
      1,
      () =>
        q.get(
          `SELECT COUNT(*) n FROM generated_artifacts
    WHERE tenant_id=? AND source_type='agent_task' AND source_id=?`,
          1,
          restaurantTaskId,
        ).n,
    ),
    6,
  );
});

test("纯 Markdown 原样进入渲染器，餐饮 JSON 转换异常则原正文安全回退且使用新版哈希", () => {
  const markdown = "# 已有商圈报告\n\n- 保留原排版\n";
  const unchanged = prepareAuthoritativeSourceBody(
    "agent_task",
    markdown,
    "备用标题",
  );
  assert.equal(unchanged.body, markdown);
  assert.equal(unchanged.transformed, false);
  assert.equal(unchanged.renderVersion, null);
  assert.equal(unchanged.sourceBodyKind, "markdown_or_text");
  assert.equal(
    unchanged.sourceHash,
    crypto.createHash("sha256").update(markdown).digest("hex"),
  );

  const malformed =
    '{"contract_id":"urn:nanowork:restaurant-output:102:test:v3","deliverables":';
  const fallback = prepareAuthoritativeSourceBody(
    "agent_task",
    malformed,
    "备用标题",
  );
  assert.equal(fallback.body, malformed);
  assert.equal(fallback.transformed, false);
  assert.equal(fallback.renderVersion, SOURCE_ARTIFACT_RENDER_VERSION);
  assert.equal(fallback.sourceBodyKind, "restaurant_structured_json_fallback");
  assert.notEqual(fallback.sourceHash, fallback.rawSourceHash);

  const partial = JSON.stringify({
    contract_id: "urn:nanowork:restaurant-output:102:test:v3",
    unexpected_result: "不得在排版时丢失",
  });
  const partialFallback = prepareAuthoritativeSourceBody(
    "agent_task",
    partial,
    "备用标题",
  );
  assert.equal(partialFallback.body, partial);
  assert.equal(
    partialFallback.sourceBodyKind,
    "restaurant_structured_json_fallback",
  );
  assert.match(partialFallback.body, /不得在排版时丢失/u);

  const unrelatedJson = '{"name":"普通数据","items":[1,2]}';
  const unrelated = prepareAuthoritativeSourceBody(
    "agent_task",
    unrelatedJson,
    "备用标题",
  );
  assert.equal(unrelated.body, unrelatedJson);
  assert.equal(unrelated.sourceHash, unrelated.rawSourceHash);
  assert.equal(unrelated.renderVersion, null);
});

test("内容数字员工 result_md 可在待审阅状态直接下载草稿，不以审核或采纳为前提", async () => {
  await withServer(actors.owner, async (base) => {
    const generated = await jsonRequest(
      base,
      `/files/artifacts/source/content_employee_run/${contentRunId}`,
      {
        method: "POST",
        body: { formats: ["docx", "xlsx"] },
      },
    );
    assert.equal(
      generated.response.status,
      200,
      JSON.stringify(generated.payload),
    );
    assert.equal(generated.payload.source.status, "待审阅");
    assert.deepEqual(
      generated.payload.deliverables.map((item) => item.format),
      ["docx", "xlsx"],
    );
    assert.equal(
      generated.payload.deliverables.every((item) => item.draft === true),
      true,
    );
    assert.equal(
      generated.payload.source.sourceHash,
      crypto.createHash("sha256").update(contentBody).digest("hex"),
    );
    assert.equal(generated.payload.source.renderVersion, null);
    assert.equal(generated.payload.source.sourceBodyKind, "markdown_or_text");
    const rows = runWithTenant(1, () =>
      q.all(
        `SELECT content FROM generated_artifacts
      WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?`,
        1,
        contentRunId,
      ),
    );
    assert.equal(rows.length, 2);
    assert.equal(
      rows.every((row) => row.content === contentBody),
      true,
    );
    assert.equal(
      runWithTenant(
        1,
        () =>
          q.get(
            `SELECT COUNT(*) n FROM approvals
      WHERE tenant_id=? AND target_id=?`,
            1,
            contentRunId,
          ).n,
      ),
      0,
    );
  });
});

test("交付文件保持来源 owner 管理链和租户隔离，空正文不会生成模板假产物", async () => {
  const pdfId = runWithTenant(1, () =>
    Number(
      q.get(
        `SELECT id FROM generated_artifacts
    WHERE tenant_id=? AND source_type='agent_task' AND source_id=? AND format='pdf' ORDER BY id LIMIT 1`,
        1,
        restaurantTaskId,
      ).id,
    ),
  );

  await withServer(actors.manager, async (base) => {
    const source = await jsonRequest(
      base,
      `/files/artifacts/source/agent_task/${restaurantTaskId}`,
    );
    assert.equal(source.response.status, 200, JSON.stringify(source.payload));
    assert.ok(source.payload.deliverables.length >= 1);
    assert.equal(
      (await fetch(`${base}/files/artifacts/${pdfId}/download`)).status,
      200,
    );
  });

  await withServer(actors.peer, async (base) => {
    const source = await jsonRequest(
      base,
      `/files/artifacts/source/agent_task/${restaurantTaskId}`,
    );
    assert.equal(source.response.status, 404);
    const download = await jsonRequest(
      base,
      `/files/artifacts/${pdfId}/download`,
    );
    assert.equal(download.response.status, 404);
  });

  await withServer(actors.otherBoss, async (base) => {
    const source = await jsonRequest(
      base,
      `/files/artifacts/source/agent_task/${restaurantTaskId}`,
    );
    assert.equal(source.response.status, 404);
    const download = await jsonRequest(
      base,
      `/files/artifacts/${pdfId}/download`,
    );
    assert.equal(download.response.status, 404);
  });

  await withServer(actors.owner, async (base) => {
    const empty = await jsonRequest(base, "/files/artifacts/source", {
      method: "POST",
      body: {
        sourceType: "agent_task",
        sourceId: emptyTaskId,
        formats: ["pdf"],
      },
    });
    assert.equal(empty.response.status, 409);
    assert.match(empty.payload.error, /尚未生成.*真实报告/u);
  });
  assert.equal(
    runWithTenant(
      1,
      () =>
        q.get(
          `SELECT COUNT(*) n FROM generated_artifacts
    WHERE tenant_id=? AND source_type='agent_task' AND source_id=?`,
          1,
          emptyTaskId,
        ).n,
    ),
    0,
  );
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

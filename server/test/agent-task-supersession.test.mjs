import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "nanowork-agent-task-supersession-"),
);
const DBP = path.join(ROOT, "test.db");
const ARTIFACT_DIR = path.join(ROOT, "artifacts");

process.env.NANOWORK_DB = DBP;
process.env.NANOWORK_ARTIFACT_DIR = ARTIFACT_DIR;
process.env.YUNWU_API_KEY = " ";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.SEED_DEMO = "false";

const { db, initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const {
  buildRestaurantOutputDeliverableFixture,
  getRestaurantOutputContract,
  renderRestaurantOutputMarkdown,
  validateRestaurantEmployeeOutputContract,
} = await import("../src/engines/restaurant-output-contract.js");
const {
  createAgentTaskSupersession,
  loadAgentTaskSupersession,
  loadContentDeliveryState,
} = await import("../src/engines/delivery-state.js");
const {
  autoAdoptContentOutput,
  decideContentOutput,
} = await import("../src/engines/restaurant-output-review.js");
const { createApproval } = await import("../src/engines/risk.js");
const marshalRoutes = (await import("../src/routes/marshals.js")).default;
const fileRoutes = (await import("../src/routes/files.js")).default;
const contentRoutes = (await import("../src/routes/content.js")).default;
const employeeOutputRoutes = (await import("../src/routes/employee-outputs.js")).default;
const assetRoutes = (await import("../src/routes/assets.js")).default;
const taskCenterRoutes = (await import("../src/routes/task-center.js")).default;
const systemRoutes = (await import("../src/routes/system.js")).default;
const dataIntakeRoutes = (await import("../src/routes/dataintake.js")).default;
const { uploadAccessGuard } = await import("../src/engines/upload-access.js");
const { resolveWechatDraftSource } = await import(
  "../src/engines/wechat-draft.js"
);

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();
db.exec(`CREATE TABLE IF NOT EXISTS credit_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER,
  log_id INTEGER NOT NULL,
  feature TEXT,
  kind TEXT,
  model TEXT,
  held_credits INTEGER NOT NULL,
  settled_credits INTEGER,
  status TEXT DEFAULT 'held',
  ref_type TEXT,
  ref_id INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  settled_at TEXT
);`);

q.run(`INSERT INTO tenants(id,name,status,plan,credits,data_mode)
  VALUES(1,'安全修订测试企业','已开通','标准版',100000,'demo')
  ON CONFLICT(id) DO UPDATE SET status='已开通',credits=100000,data_mode='demo'`);
q.run(`INSERT INTO tenants(id,name,status,plan,credits,data_mode)
  VALUES(2,'隔离企业','已开通','标准版',100000,'demo')
  ON CONFLICT(id) DO UPDATE SET status='已开通',credits=100000,data_mode='demo'`);

const ownerId = Number(
  q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits)
    VALUES('supersession-owner','x','安全修订负责人','boss','启用',1,100000)`)
    .lastInsertRowid,
);
const otherOwnerId = Number(
  q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits)
    VALUES('supersession-other-owner','x','另一位负责人','boss','启用',1,100000)`)
    .lastInsertRowid,
);
const tenantTwoOwnerId = runWithTenant(2, () =>
  Number(
    q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits)
      VALUES('supersession-tenant-two','x','二号企业负责人','boss','启用',2,100000)`)
      .lastInsertRowid,
  ),
);

const owner = q.get(
  "SELECT id,name,role,tenant_id FROM users WHERE id=?",
  ownerId,
);
const specialist102 = q.get(`SELECT s.id,s.marshal_id,s.employee_idx,m.name marshal_name
  FROM specialists s JOIN marshals m ON m.id=s.marshal_id
  WHERE s.employee_idx=102`);
const specialist101 = q.get(`SELECT s.id,s.marshal_id,s.employee_idx,m.name marshal_name
  FROM specialists s JOIN marshals m ON m.id=s.marshal_id
  WHERE s.employee_idx=101`);
assert.ok(specialist102?.id);
assert.ok(specialist101?.id);

const MODEL = "supersession-api-model";
const TASK_REQUIREMENT = "评估太原吾悦广场周边粤菜餐厅机会并形成内部报告。";
const AUTO_ROUTING = {
  schemaVersion: "nanowork.approval-workflow-snapshot/1",
  policySchemaVersion: "nanowork.approval-routing-policy/2",
  targetType: "content",
  policyMode: "auto",
  policyReason: "auto_internal_output",
  reason: "auto_internal_output",
  requiresReview: false,
  autoAdopt: true,
  decisionKind: "auto_adopt",
  steps: [],
  currentStep: 0,
};

function reportFirstEvidence(body) {
  const digest = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  return {
    kind: "restaurant_employee_execution_evidence",
    generationProgress: {
      receivedChars: body.length,
      lastActivityAt: "2026-08-13T10:00:00.000Z",
      attemptNumber: 1,
      phase: "persist",
      currentStage: "persist",
      currentLabel: "正在保存报告",
      percent: 90,
      steps: [{
        stage: "persist",
        kind: "persist",
        label: "正在保存报告",
        status: "active",
        at: "2026-08-13T10:00:00.000Z",
      }],
    },
    web: {
      provider: "test-web",
      results: [{
        title: "太原市公开信息受控检索快照",
        url: "https://www.taiyuan.gov.cn/verified-source",
        fetchedAt: "2026-08-13T10:00:00.000Z",
      }],
    },
    internalProfileLeakage: { detected: false },
    providerAttempt: {
      mode: "api",
      model: MODEL,
      usage: { inputTokens: 31, outputTokens: 47 },
    },
    outputContract: {
      valid: true,
      qualityMode: "report_first",
      structuredReportFirst: true,
      reportFirstMarkdown: true,
      primaryArtifact: "markdown",
      parsedOutput: null,
      providerResponseSha256: digest,
      renderedBodySha256: digest,
      hardDelivery: {
        valid: true,
        errors: [],
        provider: {
          mode: "api",
          model: MODEL,
          usage: { inputTokens: 31, outputTokens: 47 },
        },
      },
      artifacts: [{
        kind: "markdown",
        primary: true,
        contentSha256: digest,
      }],
    },
  };
}

function convertToReportFirst(record, body, {
  contentStatus = "草稿",
  taskStatus = "生成中",
} = {}) {
  const normalizedBody = String(body || "").trim();
  const evidence = reportFirstEvidence(normalizedBody);
  q.run("DELETE FROM approvals WHERE tenant_id=? AND target_type='content' AND target_id=?", 1, record.contentId);
  q.run(`UPDATE contents SET body=?,status=?,snapshot_json=?
    WHERE tenant_id=? AND id=?`,
  normalizedBody, contentStatus, JSON.stringify({
    contract: { valid: true },
    internalProfileLeakage: { detected: false },
    approvalRouting: AUTO_ROUTING,
  }), 1, record.contentId);
  q.run(`UPDATE agent_tasks SET status=?,employee_web_snapshot=?
    WHERE tenant_id=? AND id=?`,
  taskStatus, JSON.stringify(evidence), 1, record.taskId);
  record.reportFirstEvidence = evidence;
  record.reportFirstBody = normalizedBody;
  return record;
}

function deliveryFixture(employeeIdx, title) {
  const parsed = buildRestaurantOutputDeliverableFixture(employeeIdx, {
    title,
    requirement: TASK_REQUIREMENT,
  });
  const contract = getRestaurantOutputContract(employeeIdx);
  const checked = validateRestaurantEmployeeOutputContract(employeeIdx, parsed, {
    task: { title, requirement: TASK_REQUIREMENT },
  });
  assert.equal(checked.valid, true, checked.errors?.join("\n"));
  const body = renderRestaurantOutputMarkdown(employeeIdx, parsed, {
    task: { title, requirement: TASK_REQUIREMENT },
  });
  const artifactSha = crypto
    .createHash("sha256")
    .update(checked.artifacts[0].content, "utf8")
    .digest("hex");
  return {
    body,
    evidence: {
      kind: "restaurant_employee_execution_evidence",
      generationProgress: {
        receivedChars: 2048,
        lastActivityAt: "2026-08-13T10:00:00.000Z",
        attemptNumber: 1,
        phase: "acquire",
        currentStage: "persist",
        currentLabel: "质量检查已通过，正在保存交付物",
        percent: 90,
        steps: [
          {
            stage: "persist",
            kind: "persist",
            label: "质量检查已通过，正在保存交付物",
            status: "active",
            at: "2026-08-13T10:00:00.000Z",
          },
        ],
      },
      web: { provider: "test-web", results: [] },
      providerAttempt: {
        mode: "api",
        model: MODEL,
        usage: { inputTokens: 31, outputTokens: 47 },
      },
      outputContract: {
        valid: true,
        contractId: contract.contractId,
        schemaVersion: contract.schemaVersion,
        primaryArtifact: contract.primaryArtifact,
        parsedOutput: parsed,
        providerResponseSha256: artifactSha,
        renderedBodySha256: crypto
          .createHash("sha256")
          .update(body, "utf8")
          .digest("hex"),
        artifacts: [
          {
            primary: true,
            kind: contract.primaryArtifact,
            contractId: contract.contractId,
            schemaVersion: contract.schemaVersion,
            contentSha256: artifactSha,
          },
        ],
        hardDelivery: {
          valid: true,
          errors: [],
          provider: {
            mode: "api",
            model: MODEL,
            usage: { inputTokens: 31, outputTokens: 47 },
          },
        },
      },
      internalProfileLeakage: { detected: false, matches: [] },
    },
  };
}

function insertCompletedTask({
  title,
  owner = ownerId,
  specialist = specialist102,
  tenantId = 1,
  aiMode = "api",
  hardDeliveryValid = true,
} = {}) {
  const fixture = deliveryFixture(Number(specialist.employee_idx), title);
  fixture.evidence.outputContract.hardDelivery.valid = hardDeliveryValid;
  const contentId = Number(
    db.prepare(`INSERT INTO contents(
      tenant_id,type,title,body,status,ai_mode,creator_id,marshal_id,snapshot_json
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      tenantId,
      "员工产出",
      title,
      fixture.body,
      "可使用",
      aiMode,
      owner,
      specialist.marshal_id,
      JSON.stringify({
        contract: { valid: true },
        internalProfileLeakage: { detected: false },
      }),
    ).lastInsertRowid,
  );
  const taskId = Number(
    db.prepare(`INSERT INTO agent_tasks(
      tenant_id,marshal_id,specialist_id,title,type,requirement,status,output_id,created_by,
      employee_profile_version,employee_web_snapshot
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      tenantId,
      specialist.marshal_id,
      specialist.id,
      title,
      "分析",
      TASK_REQUIREMENT,
      "已完成",
      contentId,
      owner,
      "supersession-profile-v1",
      JSON.stringify(fixture.evidence),
    ).lastInsertRowid,
  );
  db.prepare(`INSERT INTO approvals(
    tenant_id,target_type,target_id,title,summary,status,submitter_id,reviewer_id,decided_at
  ) VALUES(?,'content',?,?,?,'已通过',?,?,datetime('now','localtime'))`).run(
    tenantId,
    contentId,
    `${title}验收`,
    "测试验收",
    owner,
    owner,
  );
  const feature = `员工任务·${specialist.marshal_name}`;
  const logId = Number(
    db.prepare(`INSERT INTO credit_logs(
      tenant_id,user_id,feature,kind,model,ai_mode,input_tokens,output_tokens,cost_yuan,credits,balance_after
    ) VALUES(?,?,?,?,?,'api',31,47,0.01,3,99997)`).run(
      tenantId,
      owner,
      feature,
      "text",
      MODEL,
    ).lastInsertRowid,
  );
  db.prepare(`INSERT INTO credit_holds(
    tenant_id,user_id,log_id,feature,kind,model,held_credits,settled_credits,status,ref_type,ref_id,settled_at
  ) VALUES(?,?,?,?,?,?,5,3,'settled','agent_task',?,datetime('now','localtime'))`).run(
    tenantId,
    owner,
    logId,
    feature,
    "text",
    MODEL,
    taskId,
  );
  return { taskId, contentId, fixture };
}

const oldTask = insertCompletedTask({ title: "旧版粤菜商圈报告" });
const replacementTask = insertCompletedTask({ title: "安全修订版粤菜商圈报告" });

const oldKbId = Number(
  q.run(`INSERT INTO kb_docs(
    category,title,body,source_type,source_id,enabled
  ) VALUES('员工产出','旧版粤菜商圈报告','旧版粤菜商圈报告机密正文','content',?,1)`, oldTask.contentId)
    .lastInsertRowid,
);
const oldContentAssetId = Number(q.run(`INSERT INTO biz_assets(
  name,category,status,owner,source_type,source_id,creator_id,note
) VALUES('旧版报告资产','内容资产','使用中','内容生产仓','content',?,?, '旧版')`,
oldTask.contentId, ownerId).lastInsertRowid);
const oldKnowledgeAssetId = Number(q.run(`INSERT INTO biz_assets(
  name,category,status,owner,source_type,source_id,creator_id,note
) VALUES('旧版知识资产','知识资产','使用中','知识库','kb',?,?, '旧版')`,
oldKbId, ownerId).lastInsertRowid);
const oldMaterialId = Number(q.run(`INSERT INTO materials(
  name,type,tags,url,source_type,source_id,creator_id,note,
  body_snapshot,artifact_snapshot_json,snapshot_hash
) VALUES('旧版报告素材','文档','商圈',NULL,'content',?,?,
  '旧报告入库素材',?,'{}',?)`,
oldTask.contentId, ownerId, oldTask.fixture.body,
crypto.createHash("sha256").update(oldTask.fixture.body).digest("hex"))
  .lastInsertRowid);

const oldArtifactName = "old-report.pdf";
const oldArtifactDir = path.join(ARTIFACT_DIR, "1");
fs.mkdirSync(oldArtifactDir, { recursive: true });
const oldArtifactBody = Buffer.from("%PDF-1.4 old report", "utf8");
fs.writeFileSync(path.join(oldArtifactDir, oldArtifactName), oldArtifactBody);
const oldArtifactId = Number(
  q.run(`INSERT INTO generated_artifacts(
    user_id,source_type,source_id,title,format,content,file_url,file_name,status,kb_doc_id,metadata
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ownerId,
  "agent_task",
  oldTask.taskId,
  "旧版粤菜商圈报告",
  "pdf",
  oldTask.fixture.body,
  `/uploads/artifacts/1/${oldArtifactName}`,
  oldArtifactName,
  "已入档",
  oldKbId,
  JSON.stringify({ size: oldArtifactBody.length, sha256: "test" })).lastInsertRowid,
);
q.run(
  "UPDATE kb_docs SET file_path=? WHERE tenant_id=1 AND id=?",
  `/uploads/artifacts/1/${oldArtifactName}`,
  oldKbId,
);
const pendingOldApprovalId = Number(
  q.run(`INSERT INTO approvals(
    target_type,target_id,title,summary,status,submitter_id,approval_level
  ) VALUES('content',?,'旧版报告待审','旧版秘密审批摘要','待审核',?,'boss')`,
  oldTask.contentId, ownerId).lastInsertRowid,
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
  app.use("/marshals", marshalRoutes);
  app.use("/files", fileRoutes);
  app.use("/content", contentRoutes);
  app.use("/employee-outputs", employeeOutputRoutes);
  app.use("/assets", assetRoutes);
  app.use("/task-center", taskCenterRoutes);
  app.use("/system", systemRoutes);
  app.use("/data-intake", dataIntakeRoutes);
  app.use("/uploads", uploadAccessGuard, express.static(ROOT));
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

test("迁移建立只追加的任务安全修订账本", () => {
  const table = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_task_supersessions'",
  ).get();
  assert.match(table?.sql || "", /superseded_task_id/u);
  assert.match(table?.sql || "", /replacement_task_id/u);
  assert.match(
    table?.sql || "",
    /superseded_output_id\s*<>\s*replacement_output_id/u,
  );
  const triggers = db.prepare(`SELECT name FROM sqlite_master
    WHERE type='trigger' AND tbl_name='agent_task_supersessions' ORDER BY name`).all();
  assert.deepEqual(
    triggers.map((row) => row.name),
    [
      "trg_agent_task_supersessions_no_delete",
      "trg_agent_task_supersessions_no_update",
    ],
  );
});

test("只有同租户、同员工、同负责人且真实交付通过的完成任务能作为安全修订版", () => {
  const otherOwner = insertCompletedTask({
    title: "另一负责人报告",
    owner: otherOwnerId,
  });
  const otherEmployee = insertCompletedTask({
    title: "另一数字员工报告",
    specialist: specialist101,
  });
  const invalidHardDelivery = insertCompletedTask({
    title: "硬交付未通过报告",
    hardDeliveryValid: false,
  });
  const foreign = insertCompletedTask({
    title: "二号企业报告",
    owner: tenantTwoOwnerId,
    tenantId: 2,
  });
  const sharedOutputOld = insertCompletedTask({
    title: "不得共享正文的旧报告",
  });
  const sharedOutputReplacement = insertCompletedTask({
    title: "错误复用旧正文的修订任务",
  });
  const missingOutputReplacement = insertCompletedTask({
    title: "缺少新正文的修订任务",
  });
  const arithmeticInvalidReplacement = convertToReportFirst(
    insertCompletedTask({ title: "历史快照声称通过但正文错算的报告" }),
    [
      "# 商圈错算报告",
      "自上而下：太原常住人口约530万，按人均年餐饮消费3000元，粤菜渗透率5%，可达79.5亿元。",
      "自下而上：商圈覆盖人口假设20万，渗透率3%，频次1次/月，客单80元，年需求5760万元。",
    ].join("\n"),
    { contentStatus: "可使用", taskStatus: "已完成" },
  );
  q.run(
    "UPDATE agent_tasks SET output_id=? WHERE tenant_id=1 AND id=?",
    sharedOutputOld.contentId,
    sharedOutputReplacement.taskId,
  );
  q.run(
    "UPDATE agent_tasks SET output_id=NULL WHERE tenant_id=1 AND id=?",
    missingOutputReplacement.taskId,
  );

  runWithTenant(1, () => {
    assert.throws(
      () => createAgentTaskSupersession({
        tenantId: 1,
        supersededTaskId: oldTask.taskId,
        replacementTaskId: otherOwner.taskId,
        actor: owner,
        reason: "验证不同负责人不能建立安全修订关系",
      }),
      /负责人/u,
    );
    assert.throws(
      () => createAgentTaskSupersession({
        tenantId: 1,
        supersededTaskId: oldTask.taskId,
        replacementTaskId: otherEmployee.taskId,
        actor: owner,
        reason: "验证不同数字员工不能建立安全修订关系",
      }),
      /数字员工/u,
    );
    assert.throws(
      () => createAgentTaskSupersession({
        tenantId: 1,
        supersededTaskId: oldTask.taskId,
        replacementTaskId: invalidHardDelivery.taskId,
        actor: owner,
        reason: "验证硬交付未通过不能取代旧报告",
      }),
      /硬交付|hardDelivery/u,
    );
    assert.throws(
      () => createAgentTaskSupersession({
        tenantId: 1,
        supersededTaskId: oldTask.taskId,
        replacementTaskId: foreign.taskId,
        actor: owner,
        reason: "验证跨租户任务不能建立安全修订关系",
      }),
      /不存在|租户/u,
    );
    assert.throws(
      () => createAgentTaskSupersession({
        tenantId: 1,
        supersededTaskId: sharedOutputOld.taskId,
        replacementTaskId: sharedOutputReplacement.taskId,
        actor: owner,
        reason: "验证安全修订任务不能继续复用旧任务的同一正文",
      }),
      /新的业务产物|不能复用/u,
    );
    assert.throws(
      () => createAgentTaskSupersession({
        tenantId: 1,
        supersededTaskId: sharedOutputOld.taskId,
        replacementTaskId: missingOutputReplacement.taskId,
        actor: owner,
        reason: "验证没有形成新业务产物的任务不能取代旧报告",
      }),
      /尚未形成新的业务产物/u,
    );
    assert.throws(
      () => createAgentTaskSupersession({
        tenantId: 1,
        supersededTaskId: oldTask.taskId,
        replacementTaskId: arithmeticInvalidReplacement.taskId,
        actor: owner,
        reason: "验证不能仅信历史快照而放行当前正文错算",
      }),
      /算术|换算|当前规则|重新校验/u,
    );
    assert.equal(
      q.get("SELECT COUNT(*) n FROM agent_task_supersessions WHERE tenant_id=1").n,
      0,
    );
    assert.equal(
      q.get("SELECT enabled FROM kb_docs WHERE tenant_id=1 AND id=?", oldKbId).enabled,
      1,
    );
  });
});

test("修订关系写入失败时，旧知识、资产与产物状态全部回滚", () => {
  const rollbackOld = insertCompletedTask({ title: "事务回滚旧报告" });
  const rollbackReplacement = insertCompletedTask({ title: "事务回滚修订报告" });
  const kbId = Number(
    q.run(`INSERT INTO kb_docs(
      category,title,body,source_type,source_id,enabled
    ) VALUES('员工产出','事务回滚旧报告','旧报告正文','content',?,1)`, rollbackOld.contentId)
      .lastInsertRowid,
  );
  q.run(`INSERT INTO biz_assets(
    name,category,status,owner,source_type,source_id,creator_id,note
  ) VALUES('事务回滚资产','内容资产','使用中','内容生产仓','content',?,?, '回滚验证')`,
  rollbackOld.contentId, ownerId);
  const artifactId = Number(
    q.run(`INSERT INTO generated_artifacts(
      user_id,source_type,source_id,title,format,content,file_url,file_name,status,kb_doc_id,metadata
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ownerId,
    "agent_task",
    rollbackOld.taskId,
    "事务回滚旧报告",
    "pdf",
    rollbackOld.fixture.body,
    "/uploads/artifacts/1/rollback-old.pdf",
    "rollback-old.pdf",
    "已入档",
    kbId,
    "{}").lastInsertRowid,
  );

  db.exec(`CREATE TRIGGER test_agent_task_supersession_abort
    BEFORE INSERT ON agent_task_supersessions
    WHEN NEW.superseded_task_id=${rollbackOld.taskId}
    BEGIN
      SELECT RAISE(ABORT,'test supersession rollback');
    END;`);
  try {
    runWithTenant(1, () => {
      assert.throws(
        () => createAgentTaskSupersession({
          tenantId: 1,
          supersededTaskId: rollbackOld.taskId,
          replacementTaskId: rollbackReplacement.taskId,
          actor: owner,
          reason: "验证关系写入失败时所有业务失效操作一起回滚",
        }),
        /test supersession rollback/u,
      );
      assert.equal(
        q.get(`SELECT COUNT(*) n FROM agent_task_supersessions
          WHERE tenant_id=? AND superseded_task_id=?`, 1, rollbackOld.taskId).n,
        0,
      );
      assert.equal(
        q.get("SELECT enabled FROM kb_docs WHERE tenant_id=1 AND id=?", kbId).enabled,
        1,
      );
      assert.equal(
        q.get(`SELECT status FROM biz_assets
          WHERE tenant_id=1 AND source_type='content' AND source_id=?`, rollbackOld.contentId).status,
        "使用中",
      );
      assert.equal(
        q.get("SELECT status FROM generated_artifacts WHERE tenant_id=1 AND id=?", artifactId).status,
        "已入档",
      );
    });
  } finally {
    db.exec("DROP TRIGGER IF EXISTS test_agent_task_supersession_abort");
  }
});

test("自动与人工采纳都把权威执行进度收敛为 done/100，且人工采纳后的旧文件原样复用为非草稿", async () => {
  const autoTask = insertCompletedTask({ title: "自动采纳终态进度报告" });
  runWithTenant(1, () => {
    q.run("DELETE FROM approvals WHERE tenant_id=1 AND target_type='content' AND target_id=?", autoTask.contentId);
    q.run("UPDATE contents SET status='草稿' WHERE tenant_id=1 AND id=?", autoTask.contentId);
    q.run("UPDATE agent_tasks SET status='生成中' WHERE tenant_id=1 AND id=?", autoTask.taskId);
    autoAdoptContentOutput({
      outputId: autoTask.contentId,
      taskId: autoTask.taskId,
      tenantId: 1,
      policyReason: "测试自动采用成功终态",
      actorRole: owner.role,
      actorUserId: owner.id,
    });
    const stored = JSON.parse(
      q.get("SELECT employee_web_snapshot FROM agent_tasks WHERE tenant_id=1 AND id=?", autoTask.taskId)
        .employee_web_snapshot,
    );
    assert.equal(stored.generationProgress.currentStage, "done");
    assert.equal(stored.generationProgress.percent, 100);
    assert.deepEqual(stored.web, autoTask.fixture.evidence.web);
    assert.deepEqual(
      stored.outputContract,
      autoTask.fixture.evidence.outputContract,
    );
    assert.deepEqual(
      stored.providerAttempt,
      autoTask.fixture.evidence.providerAttempt,
    );
  });

  const reportFirstBody = deliveryFixture(
    102,
    "结构化报告优先终态与文件复用",
  ).body.trim();
  const reportFirstTask = convertToReportFirst(
    insertCompletedTask({ title: "结构化报告优先终态与文件复用" }),
    reportFirstBody,
  );
  let reportFirstDraftArtifact;
  await withServer(owner, async (base) => {
    const generated = await jsonRequest(base, "/files/artifacts/source", {
      method: "POST",
      body: {
        sourceType: "agent_task",
        sourceId: reportFirstTask.taskId,
        formats: ["docx"],
      },
    });
    assert.equal(generated.response.status, 200, JSON.stringify(generated.payload));
    assert.equal(generated.payload.source.draft, true);
    assert.equal(generated.payload.deliverables[0].draft, true);
    reportFirstDraftArtifact = generated.payload.deliverables[0];
  });
  const reportFirstBefore = fs.readFileSync(
    path.join(oldArtifactDir, reportFirstDraftArtifact.fileName),
  );
  runWithTenant(1, () => {
    autoAdoptContentOutput({
      outputId: reportFirstTask.contentId,
      taskId: reportFirstTask.taskId,
      tenantId: 1,
      policyReason: "测试结构化报告优先自动采用",
      actorRole: owner.role,
      actorUserId: owner.id,
    });
    const delivery = loadContentDeliveryState(reportFirstTask.contentId, {
      tenantId: 1,
    });
    assert.equal(delivery.eligible, true, JSON.stringify(delivery));
    assert.equal(delivery.code, "DELIVERY_USABLE");
    assert.equal(delivery.contract.reportFirst, true);
    const stored = JSON.parse(q.get(
      "SELECT employee_web_snapshot FROM agent_tasks WHERE tenant_id=1 AND id=?",
      reportFirstTask.taskId,
    ).employee_web_snapshot);
    assert.equal(stored.generationProgress.currentStage, "done");
    assert.equal(stored.generationProgress.percent, 100);
  });
  await withServer(owner, async (base) => {
    const reused = await jsonRequest(base, "/files/artifacts/source", {
      method: "POST",
      body: {
        sourceType: "agent_task",
        sourceId: reportFirstTask.taskId,
        formats: ["docx", "pdf"],
      },
    });
    assert.equal(reused.response.status, 200, JSON.stringify(reused.payload));
    assert.equal(reused.payload.source.draft, false);
    assert.equal(reused.payload.deliverables[0].id, reportFirstDraftArtifact.id);
    assert.equal(reused.payload.deliverables[0].reused, true);
    assert.equal(reused.payload.deliverables[0].draft, false);
    const freshPdf = reused.payload.deliverables.find((item) => item.format === "pdf");
    assert.ok(freshPdf);
    assert.equal(freshPdf.reused, false);
    assert.equal(freshPdf.draft, false);
  });
  assert.deepEqual(
    fs.readFileSync(path.join(oldArtifactDir, reportFirstDraftArtifact.fileName)),
    reportFirstBefore,
  );

  const humanTask = insertCompletedTask({ title: "人工采纳文件终态报告" });
  const approvalId = runWithTenant(1, () => {
    q.run("DELETE FROM approvals WHERE tenant_id=1 AND target_type='content' AND target_id=?", humanTask.contentId);
    q.run("UPDATE contents SET status='待审核' WHERE tenant_id=1 AND id=?", humanTask.contentId);
    q.run("UPDATE agent_tasks SET status='待审阅' WHERE tenant_id=1 AND id=?", humanTask.taskId);
    return Number(createApproval({
      targetType: "content",
      targetId: humanTask.contentId,
      title: "人工采纳文件终态报告验收",
      summary: "验证待审草稿转正式交付",
      riskLevel: "none",
      rulesHit: ["employee_output_review", "employee_approval:owner_review"],
      submitterId: ownerId,
      approvalLevel: "boss",
    }));
  });

  let draftArtifact;
  await withServer(owner, async (base) => {
    const generated = await jsonRequest(base, "/files/artifacts/source", {
      method: "POST",
      body: {
        sourceType: "agent_task",
        sourceId: humanTask.taskId,
        formats: ["docx"],
      },
    });
    assert.equal(generated.response.status, 200, JSON.stringify(generated.payload));
    assert.equal(generated.payload.source.draft, true);
    assert.equal(generated.payload.deliverables.length, 1);
    assert.equal(generated.payload.deliverables[0].draft, true);
    draftArtifact = generated.payload.deliverables[0];
  });
  const beforeFile = fs.readFileSync(
    path.join(oldArtifactDir, draftArtifact.fileName),
  );

  runWithTenant(1, () => {
    decideContentOutput({
      outputId: humanTask.contentId,
      approvalId,
      actor: owner,
      decision: "adopt",
      reason: "已核验报告正文、来源、岗位契约和交付文件。",
      tenantId: 1,
    });
    const stored = JSON.parse(
      q.get("SELECT employee_web_snapshot FROM agent_tasks WHERE tenant_id=1 AND id=?", humanTask.taskId)
        .employee_web_snapshot,
    );
    assert.equal(stored.generationProgress.currentStage, "done");
    assert.equal(stored.generationProgress.percent, 100);
    assert.deepEqual(stored.web, humanTask.fixture.evidence.web);
    assert.deepEqual(
      stored.outputContract,
      humanTask.fixture.evidence.outputContract,
    );
    assert.deepEqual(
      stored.providerAttempt,
      humanTask.fixture.evidence.providerAttempt,
    );
  });

  await withServer(owner, async (base) => {
    const reused = await jsonRequest(base, "/files/artifacts/source", {
      method: "POST",
      body: {
        sourceType: "agent_task",
        sourceId: humanTask.taskId,
        formats: ["docx"],
      },
    });
    assert.equal(reused.response.status, 200, JSON.stringify(reused.payload));
    assert.equal(reused.payload.source.draft, false);
    assert.equal(reused.payload.deliverables.length, 1);
    assert.equal(reused.payload.deliverables[0].id, draftArtifact.id);
    assert.equal(reused.payload.deliverables[0].reused, true);
    assert.equal(reused.payload.deliverables[0].draft, false);
    assert.equal(reused.payload.deliverables[0].sha256, draftArtifact.sha256);
  });

  const afterFile = fs.readFileSync(
    path.join(oldArtifactDir, draftArtifact.fileName),
  );
  assert.deepEqual(afterFile, beforeFile);
  runWithTenant(1, () => {
    const artifacts = q.all(`SELECT metadata FROM generated_artifacts
      WHERE tenant_id=1 AND source_type='agent_task' AND source_id=? AND format='docx'`,
    humanTask.taskId);
    assert.equal(artifacts.length, 1);
    const metadata = JSON.parse(artifacts[0].metadata);
    assert.equal(metadata.draft, false);
    assert.equal(metadata.sha256, draftArtifact.sha256);
  });
});

test("安全修订写入后旧正文进入 DELIVERY_SUPERSEDED，旧知识与资产在同一事务失效", async () => {
  assert.equal(
    runWithTenant(1, () => loadContentDeliveryState(oldTask.contentId, { tenantId: 1 }).code),
    "DELIVERY_REVIEW_PENDING",
  );
  assert.equal(
    runWithTenant(1, () =>
      loadContentDeliveryState(replacementTask.contentId, { tenantId: 1 }).code,
    ),
    "DELIVERY_USABLE",
  );

  await withServer(owner, async (base) => {
    const trackedOldKb = await jsonRequest(base, "/data-intake/commit", {
      method: "POST",
      body: {
        idempotencyKey: "supersession-old-kb-track-001",
        batches: [{
          sheet: "旧版知识跟踪",
          target: "knowledge",
          rows: [{
            rowNumber: 2,
            data: {
              category: "员工产出",
              title: "旧版粤菜商圈报告",
              body: "旧版粤菜商圈报告机密正文",
            },
          }],
        }],
      },
    });
    assert.equal(trackedOldKb.response.status, 200, JSON.stringify(trackedOldKb.payload));
    const trackedOldKbItemId = trackedOldKb.payload.results[0].items[0].id;

    const created = await jsonRequest(
      base,
      `/marshals/tasks/${oldTask.taskId}/supersede`,
      {
        method: "POST",
        body: {
          replacementTaskId: replacementTask.taskId,
          reason: "旧版报告含不合规平台动作，改由安全修订版取代",
        },
      },
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    assert.equal(created.payload.supersession.replacementTaskId, replacementTask.taskId);
    assert.equal(created.payload.supersession.created, true);

    const repeated = await jsonRequest(
      base,
      `/marshals/tasks/${oldTask.taskId}/supersede`,
      {
        method: "POST",
        body: { replacementTaskId: replacementTask.taskId },
      },
    );
    assert.equal(repeated.response.status, 200);
    assert.equal(repeated.payload.supersession.created, false);

    const kbList = await jsonRequest(base, "/system/kb");
    assert.equal(kbList.response.status, 200);
    const oldKb = kbList.payload.find((row) => row.id === oldKbId);
    assert.ok(oldKb);
    assert.equal(oldKb.body, "");
    assert.equal(oldKb.file_path, null);
    assert.equal(oldKb.enabled, 0);
    assert.equal(oldKb.bodyAvailability, "superseded");
    assert.equal(oldKb.deliveryState, "DELIVERY_SUPERSEDED");
    assert.equal(oldKb.businessUsable, false);
    assert.equal(oldKb.supersededBy.taskId, replacementTask.taskId);
    assert.doesNotMatch(
      JSON.stringify(kbList.payload),
      /旧版粤菜商圈报告机密正文/u,
    );

    const intakeHistory = await jsonRequest(base, "/data-intake/history");
    assert.equal(intakeHistory.response.status, 200);
    const trackedOldKnowledge = intakeHistory.payload.find(
      (item) => item.id === trackedOldKbItemId,
    );
    assert.ok(trackedOldKnowledge);
    assert.equal(trackedOldKnowledge.data.body, "");
    assert.equal(trackedOldKnowledge.deliveryState, "DELIVERY_SUPERSEDED");
    assert.equal(trackedOldKnowledge.businessUsable, false);
    assert.equal(
      trackedOldKnowledge.supersededBy.taskId,
      replacementTask.taskId,
    );

    const reimportOldKnowledge = await jsonRequest(
      base,
      "/data-intake/commit",
      {
        method: "POST",
        body: {
          idempotencyKey: "supersession-old-kb-reimport-001",
          batches: [{
            sheet: "企图复活旧知识",
            target: "knowledge",
            rows: [{ data: {
              category: "员工产出",
              title: "旧版粤菜商圈报告",
              body: "不得重新进入RAG",
            } }],
          }],
        },
      },
    );
    assert.equal(reimportOldKnowledge.response.status, 409);
    assert.equal(reimportOldKnowledge.payload.code, "DELIVERY_SUPERSEDED");
    assert.equal(
      reimportOldKnowledge.payload.supersededBy.taskId,
      replacementTask.taskId,
    );

    for (const [method, body] of [
      ["PUT", { data: { body: "修改旧正文" } }],
      ["DELETE", { reason: "企图恢复旧快照" }],
    ]) {
      const blocked = await jsonRequest(
        base,
        `/data-intake/items/${trackedOldKbItemId}`,
        { method, body },
      );
      assert.equal(blocked.response.status, 409);
      assert.equal(blocked.payload.code, "DELIVERY_SUPERSEDED");
      assert.equal(blocked.payload.supersededBy.taskId, replacementTask.taskId);
    }

    const reconcileIntake = await jsonRequest(base, "/data-intake/reconcile", {
      method: "POST",
      body: {},
    });
    assert.equal(reconcileIntake.response.status, 200);
    assert.equal(
      runWithTenant(1, () => q.get(
        "SELECT status FROM biz_assets WHERE tenant_id=1 AND id=?",
        oldKnowledgeAssetId,
      ).status),
      "已归档",
    );

    const reenableKb = await jsonRequest(base, `/system/kb/${oldKbId}`, {
      method: "PUT",
      body: {
        title: "企图重启旧知识",
        body: "不得重新进入RAG",
        category: "员工产出",
        enabled: true,
      },
    });
    assert.equal(reenableKb.response.status, 409);
    assert.equal(reenableKb.payload.code, "DELIVERY_SUPERSEDED");
    assert.equal(
      reenableKb.payload.supersededBy.taskId,
      replacementTask.taskId,
    );

    const deleteKb = await jsonRequest(base, `/system/kb/${oldKbId}`, {
      method: "DELETE",
      body: { reason: "旧版仅保留审计" },
    });
    assert.equal(deleteKb.response.status, 409);
    assert.equal(deleteKb.payload.code, "DELIVERY_SUPERSEDED");

    const approvalQueue = await jsonRequest(
      base,
      `/system/approvals?status=${encodeURIComponent("待审核")}`,
    );
    assert.equal(approvalQueue.response.status, 200);
    const oldApproval = approvalQueue.payload.find(
      (row) => row.id === pendingOldApprovalId,
    );
    assert.ok(oldApproval);
    assert.equal(oldApproval.summary, "");
    assert.equal(oldApproval.payload, null);
    assert.equal(oldApproval.canPass, false);
    assert.equal(oldApproval.canReject, false);
    assert.equal(oldApproval.bodyAvailability, "superseded");
    assert.equal(oldApproval.deliveryState, "DELIVERY_SUPERSEDED");
    assert.equal(oldApproval.businessUsable, false);
    assert.equal(
      oldApproval.supersededBy.taskId,
      replacementTask.taskId,
    );
    assert.doesNotMatch(
      JSON.stringify(approvalQueue.payload),
      /旧版秘密审批摘要/u,
    );

    const rejectOldApproval = await jsonRequest(
      base,
      `/system/approvals/${pendingOldApprovalId}/decide`,
      {
        method: "POST",
        body: { pass: false, reason: "不应改写已取代审批" },
      },
    );
    assert.equal(rejectOldApproval.response.status, 409);
    assert.equal(
      rejectOldApproval.payload.code,
      "DELIVERY_SUPERSEDED",
    );
    assert.equal(
      rejectOldApproval.payload.supersededBy.taskId,
      replacementTask.taskId,
    );

    const resubmitOldContent = await jsonRequest(
      base,
      `/content/${oldTask.contentId}/submit-approval`,
      { method: "POST", body: {} },
    );
    assert.equal(resubmitOldContent.response.status, 409);
    assert.equal(resubmitOldContent.payload.code, "DELIVERY_SUPERSEDED");
    assert.equal(
      resubmitOldContent.payload.supersededBy.taskId,
      replacementTask.taskId,
    );

    const deleteOldContent = await jsonRequest(
      base,
      `/content/${oldTask.contentId}`,
      { method: "DELETE", body: { reason: "旧版仅保留审计" } },
    );
    assert.equal(deleteOldContent.response.status, 409);
    assert.equal(deleteOldContent.payload.code, "DELIVERY_SUPERSEDED");
    assert.equal(
      deleteOldContent.payload.supersededBy.taskId,
      replacementTask.taskId,
    );

    const status = await jsonRequest(
      base,
      `/marshals/tasks/${oldTask.taskId}/status`,
    );
    assert.equal(status.response.status, 200);
    assert.equal(status.payload.deliveryState, "DELIVERY_SUPERSEDED");
    assert.equal(status.payload.presentationKey, "superseded");
    assert.equal(status.payload.supersededBy.taskId, replacementTask.taskId);
    assert.equal(status.payload.output_body, undefined);
    assert.equal(status.payload.employee_web_snapshot, undefined);
    assert.equal(status.payload.executionSnapshot, null);

    const contentDetail = await jsonRequest(
      base,
      `/content/detail/${oldTask.contentId}`,
    );
    assert.equal(contentDetail.response.status, 200);
    assert.equal(contentDetail.payload.body, "");
    assert.equal(contentDetail.payload.bodyAvailability, "superseded");
    assert.equal(contentDetail.payload.snapshot_json, undefined);
    assert.equal(
      contentDetail.payload.delivery.deliveryState,
      "DELIVERY_SUPERSEDED",
    );
    assert.equal(
      contentDetail.payload.supersededBy.taskId,
      replacementTask.taskId,
    );

    const materials = await jsonRequest(base, "/content/materials");
    assert.equal(materials.response.status, 200);
    const oldMaterial = materials.payload.find(
      (item) => item.id === oldMaterialId,
    );
    assert.ok(oldMaterial);
    assert.equal(oldMaterial.bodyPreview, null);
    assert.equal(oldMaterial.hasBodySnapshot, false);
    assert.equal(oldMaterial.hasArtifactSnapshot, false);
    assert.equal(oldMaterial.url, null);
    assert.equal(oldMaterial.bodyAvailability, "superseded");
    assert.equal(oldMaterial.businessUsable, false);
    assert.equal(oldMaterial.deliveryState, "DELIVERY_SUPERSEDED");
    assert.equal(
      oldMaterial.supersededBy.taskId,
      replacementTask.taskId,
    );

    const selectOldMaterial = await jsonRequest(
      base,
      `/content/materials/${oldMaterialId}/use`,
      { method: "POST", body: {} },
    );
    assert.equal(selectOldMaterial.response.status, 409);
    assert.equal(selectOldMaterial.payload.code, "DELIVERY_SUPERSEDED");
    assert.equal(
      selectOldMaterial.payload.supersededBy.taskId,
      replacementTask.taskId,
    );

    const reuseOldMaterial = await jsonRequest(base, "/content/generate", {
      method: "POST",
      body: {
        type: "朋友圈文案",
        topic: "测试旧报告素材门禁",
        materialIds: [oldMaterialId],
      },
    });
    assert.equal(reuseOldMaterial.response.status, 409);
    assert.match(reuseOldMaterial.payload.error, /安全修订版取代/u);

    const assetTrace = await jsonRequest(
      base,
      `/assets/${oldContentAssetId}/trace`,
    );
    assert.equal(assetTrace.response.status, 200);
    assert.equal(assetTrace.payload.status, "已归档");
    assert.equal(assetTrace.payload.source.preview, null);
    assert.equal(assetTrace.payload.source.bodyAvailability, "superseded");
    assert.equal(
      assetTrace.payload.source.deliveryState,
      "DELIVERY_SUPERSEDED",
    );
    assert.equal(
      assetTrace.payload.source.supersededBy.taskId,
      replacementTask.taskId,
    );
    assert.equal(
      assetTrace.payload.source.link,
      `/employees?employee=102&task=${replacementTask.taskId}`,
    );

    const knowledgeAssetTrace = await jsonRequest(
      base,
      `/assets/${oldKnowledgeAssetId}/trace`,
    );
    assert.equal(knowledgeAssetTrace.response.status, 200);
    assert.equal(knowledgeAssetTrace.payload.status, "已归档");
    assert.equal(knowledgeAssetTrace.payload.source.preview, null);
    assert.equal(
      knowledgeAssetTrace.payload.source.bodyAvailability,
      "superseded",
    );
    assert.equal(
      knowledgeAssetTrace.payload.source.deliveryState,
      "DELIVERY_SUPERSEDED",
    );
    assert.equal(
      knowledgeAssetTrace.payload.source.supersededBy.taskId,
      replacementTask.taskId,
    );

    const taskCenterList = await jsonRequest(
      base,
      "/task-center?kind=restaurant&pageSize=100",
    );
    assert.equal(taskCenterList.response.status, 200);
    const supersededListItem = taskCenterList.payload.items.find(
      (row) => row.sourceKey === `restaurant:${oldTask.taskId}`,
    );
    assert.ok(supersededListItem);
    assert.equal(supersededListItem.state, "superseded");
    assert.equal(supersededListItem.businessUsable, false);
    assert.equal(supersededListItem.reviewReady, false);
    assert.equal(supersededListItem.deliveryState, "DELIVERY_SUPERSEDED");
    assert.equal(
      supersededListItem.deepLink,
      `/employees?employee=102&task=${replacementTask.taskId}`,
    );

    const taskCenterDetail = await jsonRequest(
      base,
      `/task-center/restaurant/${oldTask.taskId}`,
    );
    assert.equal(taskCenterDetail.response.status, 200);
    assert.equal(taskCenterDetail.payload.state, "superseded");
    assert.equal(taskCenterDetail.payload.output, "");
    assert.equal(taskCenterDetail.payload.report, null);
    assert.deepEqual(taskCenterDetail.payload.deliverables, []);
    assert.equal(taskCenterDetail.payload.businessUsable, false);
    assert.equal(taskCenterDetail.payload.reviewReady, false);
    assert.equal(
      taskCenterDetail.payload.supersededBy.taskId,
      replacementTask.taskId,
    );
    assert.equal(
      taskCenterDetail.payload.conversationDeepLink,
      `/employees?employee=102&task=${replacementTask.taskId}`,
    );
    assert.doesNotMatch(
      JSON.stringify({ assetTrace: assetTrace.payload, taskCenterDetail: taskCenterDetail.payload }),
      new RegExp(oldTask.fixture.body.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"),
    );

    const outputDrill = await jsonRequest(
      base,
      `/employee-outputs/drill/task/${oldTask.taskId}`,
    );
    assert.equal(outputDrill.response.status, 200);
    assert.equal(outputDrill.payload.record.canReview, false);
    assert.equal(
      outputDrill.payload.record.deliveryState,
      "DELIVERY_SUPERSEDED",
    );
    assert.equal(
      outputDrill.payload.record.supersededBy.taskId,
      replacementTask.taskId,
    );
    assert.equal(outputDrill.payload.output.body, "");
    assert.equal(outputDrill.payload.output.bodyAvailability, "superseded");
    assert.equal(outputDrill.payload.execution, null);

    const outputList = await jsonRequest(
      base,
      "/employee-outputs?source=task&pageSize=100",
    );
    assert.equal(outputList.response.status, 200);
    const oldRun = outputList.payload.rows.find(
      (row) => row.ref === `task:${oldTask.taskId}`,
    );
    assert.ok(oldRun);
    assert.equal(oldRun.hasOutput, false);
    assert.equal(oldRun.canReview, false);
    assert.equal(oldRun.deliveryState, "DELIVERY_SUPERSEDED");
    assert.equal(oldRun.supersededBy.taskId, replacementTask.taskId);

    const download = await jsonRequest(
      base,
      `/files/artifacts/${oldArtifactId}/download`,
    );
    assert.equal(download.response.status, 409);
    assert.equal(download.payload.code, "DELIVERY_SUPERSEDED");

    const source = await jsonRequest(
      base,
      `/files/artifacts/source/agent_task/${oldTask.taskId}`,
    );
    assert.equal(source.response.status, 409);
    assert.equal(source.payload.code, "DELIVERY_SUPERSEDED");

    const staticDownload = await jsonRequest(
      base,
      `/uploads/artifacts/1/${oldArtifactName}`,
    );
    assert.equal(staticDownload.response.status, 409);
    assert.equal(staticDownload.payload.code, "DELIVERY_SUPERSEDED");

    const listed = await jsonRequest(base, "/files/artifacts");
    assert.equal(listed.response.status, 200);
    const oldArtifact = listed.payload.find((row) => row.id === oldArtifactId);
    assert.ok(oldArtifact);
    assert.equal(oldArtifact.file_url, undefined);
    assert.equal(oldArtifact.deliverable.status, "superseded");
    assert.equal(oldArtifact.deliverable.downloadUrl, null);
    assert.equal(oldArtifact.deliverable.supersededBy.taskId, replacementTask.taskId);
  });

  runWithTenant(1, () => {
    for (const decision of ["adopt", "reject"]) {
      assert.throws(
        () =>
          decideContentOutput({
            outputId: oldTask.contentId,
            approvalId: pendingOldApprovalId,
            actor: owner,
            decision,
            reason: "直接调用也不能改写已取代旧版",
            tenantId: 1,
          }),
        (error) =>
          error?.status === 409 &&
          error?.code === "DELIVERY_SUPERSEDED" &&
          error?.supersededBy?.taskId === replacementTask.taskId,
      );
    }
    assert.throws(
      () =>
        resolveWechatDraftSource({
          tenantId: 1,
          sourceType: "content",
          sourceId: oldTask.contentId,
        }),
      (error) =>
        error?.status === 409 &&
        error?.code === "DELIVERY_SUPERSEDED" &&
        error?.deliveryState?.supersededBy?.taskId === replacementTask.taskId,
    );
    assert.equal(
      q.get("SELECT status FROM approvals WHERE tenant_id=1 AND id=?", pendingOldApprovalId)
        .status,
      "待审核",
    );
  });

  runWithTenant(1, () => {
    const projection = loadAgentTaskSupersession(oldTask.taskId, { tenantId: 1 });
    assert.equal(projection.replacementTaskId, replacementTask.taskId);
    assert.equal(
      loadContentDeliveryState(oldTask.contentId, { tenantId: 1 }).code,
      "DELIVERY_SUPERSEDED",
    );
    assert.equal(
      loadContentDeliveryState(replacementTask.contentId, { tenantId: 1 }).code,
      "DELIVERY_USABLE",
    );
    assert.equal(
      q.get("SELECT enabled FROM kb_docs WHERE tenant_id=1 AND id=?", oldKbId).enabled,
      0,
    );
    assert.deepEqual(
      q.all(`SELECT status FROM biz_assets
        WHERE tenant_id=1 AND (
          (source_type='content' AND source_id=?)
          OR (source_type='kb' AND source_id=?)
        ) ORDER BY id`, oldTask.contentId, oldKbId)
        .map((row) => row.status),
      ["已归档", "已归档"],
    );
    assert.equal(
      q.get("SELECT status FROM generated_artifacts WHERE tenant_id=1 AND id=?", oldArtifactId).status,
      "已取代",
    );
    assert.throws(
      () => q.run(`UPDATE agent_task_supersessions SET reason='篡改'
        WHERE tenant_id=? AND superseded_task_id=?`, 1, oldTask.taskId),
      /append-only/u,
    );
    assert.throws(
      () => q.run(`DELETE FROM agent_task_supersessions
        WHERE tenant_id=? AND superseded_task_id=?`, 1, oldTask.taskId),
      /append-only/u,
    );
  });
});

after(() => {
  try {
    db.close();
  } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
});

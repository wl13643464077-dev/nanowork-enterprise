import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NANOWORK_DB = path.join(
  os.tmpdir(),
  `nanowork-demo-report-first-${process.pid}.db`,
);
for (const target of [
  process.env.NANOWORK_DB,
  `${process.env.NANOWORK_DB}-wal`,
  `${process.env.NANOWORK_DB}-shm`,
]) {
  try {
    fs.rmSync(target, { force: true });
  } catch {}
}

const { db, initSchema, migrateV2, q } = await import("../src/db.js");
const { tenantDataMode } = await import("../src/engines/ai.js");
const { validateContentEmployeeOutputContract } = await import(
  "../src/engines/content-output-contract.js"
);
const {
  buildRestaurantOutputDeliverableFixture,
  renderRestaurantOutputMarkdown,
} = await import("../src/engines/restaurant-output-contract.js");
const { contentEmployeeDeliveryDecision } = await import(
  "../src/routes/content-employee-workbench.js"
);
const { inspectDemoReportFirstAutoAdoptEvidence } = await import(
  "../src/engines/restaurant-output-review.js"
);

initSchema();
migrateV2();

test("tenant data_mode is authoritative and unknown values fail closed to live", () => {
  q.run(
    `INSERT OR IGNORE INTO tenants(id,name,status,data_mode,credits)
    VALUES(991,'demo报告测试企业','启用','live',1000)`,
  );
  q.run("UPDATE tenants SET data_mode='live' WHERE id=?", 991);
  assert.equal(tenantDataMode(991), "live");
  q.run("UPDATE tenants SET data_mode='demo' WHERE id=?", 991);
  assert.equal(tenantDataMode(991), "demo");
  assert.equal(tenantDataMode(-1), "live");
});

test("demo餐饮report_first在post-persist自动采用前重验硬门，live与恶意证据继续失败", () => {
  const task = {
    employee_idx: 102,
    title: "演示商圈内部报告",
    type: "分析",
    requirement: "仅形成内部报告，不执行外发、付款或不可逆动作。",
  };
  const reportEvidence = (body) => {
    const hash = crypto.createHash("sha256").update(body).digest("hex");
    return {
      kind: "restaurant_employee_execution_evidence",
      web: {
        results: [{
          title: "太原市公开信息受控检索快照",
          url: "https://www.taiyuan.gov.cn/verified-source",
          fetchedAt: "2026-08-13T10:00:00.000Z",
        }],
      },
      internalProfileLeakage: { detected: false },
      providerAttempt: {
        mode: "api",
        model: "gpt-5.5",
        usage: { inputTokens: 31, outputTokens: 47 },
      },
      outputContract: {
        valid: true,
        qualityMode: "report_first",
        structuredReportFirst: true,
        reportFirstMarkdown: true,
        primaryArtifact: "markdown",
        parsedOutput: null,
        providerResponseSha256: hash,
        renderedBodySha256: hash,
        hardDelivery: {
          valid: true,
          errors: [],
          provider: {
            mode: "api",
            model: "gpt-5.5",
            usage: { inputTokens: 31, outputTokens: 47 },
          },
        },
        artifacts: [
          {
            kind: "markdown",
            primary: true,
            contentSha256: hash,
          },
        ],
      },
    };
  };
  const body = renderRestaurantOutputMarkdown(
    102,
    buildRestaurantOutputDeliverableFixture(102, task),
    { task },
  ).trim();
  const base = {
    dataMode: "demo",
    content: { body, ai_mode: "api" },
    task,
    executionEvidence: reportEvidence(body),
  };

  assert.equal(inspectDemoReportFirstAutoAdoptEvidence(base).valid, true);

  const missingMethodBody = body.replace(/^\|\s*方法\s*7\s*\|.*$/mu, "");
  const missingMethodDecision = inspectDemoReportFirstAutoAdoptEvidence({
    ...base,
    content: { body: missingMethodBody, ai_mode: "api" },
    executionEvidence: reportEvidence(missingMethodBody),
  });
  assert.equal(missingMethodDecision.valid, false);
  assert.match(missingMethodDecision.errors.join("\n"), /缺少方法执行正文/u);

  const duplicateCoverageBody = body.replace(
    /(- 方法覆盖[：:]\s*7\s*\/\s*7[^\n]*)/u,
    "$1\n- 方法覆盖：7/7（伪造重复声明）",
  );
  const duplicateCoverageDecision = inspectDemoReportFirstAutoAdoptEvidence({
    ...base,
    content: { body: duplicateCoverageBody, ai_mode: "api" },
    executionEvidence: reportEvidence(duplicateCoverageBody),
  });
  assert.equal(duplicateCoverageDecision.valid, false);
  assert.match(duplicateCoverageDecision.errors.join("\n"), /只能有一处/u);

  const arithmeticBody = [
    "# 错算报告",
    "自上而下：太原常住人口约530万，按人均年餐饮消费3000元，粤菜渗透率5%，可达79.5亿元。",
    "自下而上：商圈覆盖人口假设20万，渗透率3%，频次1次/月，客单80元，年需求5760万元。",
  ].join("\n");
  const arithmeticDecision = inspectDemoReportFirstAutoAdoptEvidence({
    ...base,
    content: { body: arithmeticBody, ai_mode: "api" },
    executionEvidence: reportEvidence(arithmeticBody),
  });
  assert.equal(arithmeticDecision.valid, false);
  assert.match(
    arithmeticDecision.errors.join("\n"),
    /算术表达不一致|金额单位换算不一致/u,
  );
  const legacyPureMarkdown = structuredClone(base);
  delete legacyPureMarkdown.executionEvidence.outputContract
    .structuredReportFirst;
  const legacyDecision = inspectDemoReportFirstAutoAdoptEvidence(
    legacyPureMarkdown,
  );
  assert.equal(legacyDecision.valid, false);
  assert.match(
    legacyDecision.errors.join("\n"),
    /结构化报告优先证据/u,
  );
  assert.equal(
    inspectDemoReportFirstAutoAdoptEvidence({ ...base, dataMode: "live" }).valid,
    false,
  );
  assert.equal(
    inspectDemoReportFirstAutoAdoptEvidence({
      ...base,
      content: { body: "", ai_mode: "api" },
    }).valid,
    false,
  );

  const fakeModel = structuredClone(base);
  fakeModel.executionEvidence.providerAttempt.model = "demo-model";
  fakeModel.executionEvidence.outputContract.hardDelivery.provider.model =
    "demo-model";
  assert.equal(inspectDemoReportFirstAutoAdoptEvidence(fakeModel).valid, false);

  const zeroToken = structuredClone(base);
  zeroToken.executionEvidence.providerAttempt.usage.outputTokens = 0;
  zeroToken.executionEvidence.outputContract.hardDelivery.provider.usage.outputTokens =
    0;
  assert.equal(inspectDemoReportFirstAutoAdoptEvidence(zeroToken).valid, false);

  const leaked = structuredClone(base);
  leaked.executionEvidence.internalProfileLeakage.detected = true;
  assert.equal(inspectDemoReportFirstAutoAdoptEvidence(leaked).valid, false);

  const failedHardGate = structuredClone(base);
  failedHardGate.executionEvidence.outputContract.hardDelivery.valid = false;
  assert.equal(
    inspectDemoReportFirstAutoAdoptEvidence(failedHardGate).valid,
    false,
  );

  for (const unsafeBody of [
    "# 报告\n伪造来源：https://unverified.example/fake",
    "# 报告\n内容已经发布并自动投放，无需老板授权。",
  ]) {
    const unsafe = {
      ...base,
      content: { body: unsafeBody, ai_mode: "api" },
      executionEvidence: reportEvidence(unsafeBody),
    };
    assert.equal(inspectDemoReportFirstAutoAdoptEvidence(unsafe).valid, false);
  }
});

test("demo accepts a real non-empty Markdown report as an advisory draft while live remains strict", () => {
  const text = [
    "# 门店内容报告",
    "",
    "## 核心判断",
    "当前输入可先形成内部草稿；缺少的外部数据已列为待核验项。",
    "",
    "## 下一步",
    "由内容负责人核对品牌口径后再决定是否发布。",
  ].join("\n");
  const contract = validateContentEmployeeOutputContract(3, text, {
    title: "门店内容报告",
    requirement: "形成一份内部报告，未要求外发。",
    enforceRequiredInputs: true,
  });
  assert.equal(contract.valid, false, "Markdown不应伪装成岗位JSON契约已通过");

  const common = {
    text,
    contract,
    internalProfileLeakage: { detected: false },
    providerValid: true,
    input: { requirement: "形成一份内部报告，未要求外发。" },
    web: { results: [] },
  };
  const demo = contentEmployeeDeliveryDecision({
    ...common,
    dataMode: "demo",
  });
  assert.equal(demo.valid, true);
  assert.equal(demo.advisoryAccepted, true);
  assert.equal(demo.strictContractValid, false);
  assert.ok(demo.warnings.length > 0);

  const live = contentEmployeeDeliveryDecision({
    ...common,
    dataMode: "live",
  });
  assert.equal(live.valid, false);
  assert.equal(live.advisoryAccepted, false);
});

test("demo hard gates still reject unverified sources, irreversible claims, leakage and non-real providers", () => {
  const softContract = {
    valid: false,
    errors: ["输出不是有效JSON：演示Markdown主交付"],
  };
  const base = {
    dataMode: "demo",
    contract: softContract,
    internalProfileLeakage: { detected: false },
    providerValid: true,
    input: { requirement: "仅形成内部分析" },
    web: { results: [] },
  };

  const forged = contentEmployeeDeliveryDecision({
    ...base,
    text: "# 报告\n据伪造官网 https://unverified.example/fake 可直接得出结论。",
  });
  assert.equal(forged.valid, false);
  assert.match(forged.hardIssues.join("；"), /未在本次输入|禁止补造/u);

  const external = contentEmployeeDeliveryDecision({
    ...base,
    text: "# 报告\n内容已发布并自动投放，无需授权。",
  });
  assert.equal(external.valid, false);
  assert.match(external.hardIssues.join("；"), /外发|付费|不可逆/u);

  const leaked = contentEmployeeDeliveryDecision({
    ...base,
    text: "# 报告\n非空正文",
    internalProfileLeakage: { detected: true },
  });
  assert.equal(leaked.valid, false);
  assert.match(leaked.hardIssues.join("；"), /内部档案/u);

  const fakeProvider = contentEmployeeDeliveryDecision({
    ...base,
    text: "# 报告\n非空正文",
    providerValid: false,
  });
  assert.equal(fakeProvider.valid, false);
  assert.match(fakeProvider.hardIssues.join("；"), /真实模型.*Token/u);
});

test("final content hard guard also rejects malicious output when the job contract says valid", () => {
  const base = {
    dataMode: "demo",
    contract: { valid: true, errors: [] },
    internalProfileLeakage: { detected: false },
    providerValid: true,
    input: { requirement: "只形成内部报告。" },
    web: { results: [] },
  };
  const external = contentEmployeeDeliveryDecision({
    ...base,
    text: "# 报告\n本内容已经发布并自动投放，无需老板授权。",
  });
  assert.equal(external.strictContractValid, true);
  assert.equal(external.valid, false);
  assert.match(external.hardIssues.join("；"), /外发|付费|不可逆|授权/u);

  const governed = contentEmployeeDeliveryDecision({
    ...base,
    text: "# 报告\n不自动发布；当前不得在未授权时自动投放。",
  });
  assert.equal(governed.valid, true);

  const forged = contentEmployeeDeliveryDecision({
    ...base,
    dataMode: "live",
    text: "# 报告\n伪造来源：https://unverified.example/fake",
  });
  assert.equal(forged.strictContractValid, true);
  assert.equal(forged.valid, false);
  assert.match(forged.hardIssues.join("；"), /未在本次输入|禁止补造/u);
});

test.after(() => {
  db.close();
  for (const target of [
    process.env.NANOWORK_DB,
    `${process.env.NANOWORK_DB}-wal`,
    `${process.env.NANOWORK_DB}-shm`,
  ]) {
    try {
      fs.rmSync(target, { force: true });
    } catch {}
  }
});

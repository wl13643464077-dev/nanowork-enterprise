/**
 * 回归：经营工具箱的员工执行档案必须用 Markdown 草案指令替换派活 JSON 契约。
 *
 * 真实故障（preview 库 tool_runs#3）：今日必发由员工141执行，systemContext
 * 里“【机器输出契约·直接派活必须执行】必须输出JSON”压过了工具箱后置的
 * “输出Markdown”，模型回了整段 contract JSON，被 Markdown 质检判
 * quality_failed，预授权白扣、老板拿不到结果。
 *
 * 本文件离线锁两层防线：
 * 1) outputMode=markdown_draft 时 system prompt 不得再带 JSON 契约强制指令；
 * 2) 即使模型仍回契约 JSON，工具箱交付前必须转换成老板可读 Markdown。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const DBP = path.join(os.tmpdir(), `nanowork-toolbox-mdmode-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}
process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = "test";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";

const { initSchema, migrateV2, runWithTenant } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { buildEmployeeExecutionProfile } = await import(
  "../src/employee-workbench.js"
);
const { TOOL_DEFINITIONS, generateToolboxRun } = await import(
  "../src/engines/toolbox.js"
);
const { buildRestaurantOutputDeliverableFixture } = await import(
  "../src/engines/restaurant-output-contract.js"
);

initSchema();
migrateV2();
ensureBaselineCatalogs();

const bossUser = { id: 1, role: "boss", tenant_id: 1 };

test("outputMode=markdown_draft 用Markdown草案指令替换派活JSON契约", () => {
  runWithTenant(1, () => {
    const contractMode = buildEmployeeExecutionProfile(141, {
      tenantId: 1,
      user: bossUser,
    });
    assert.match(
      contractMode.systemContext,
      /【机器输出契约·直接派活必须执行】/u,
      "直接派活默认保持JSON机器契约",
    );

    const markdownMode = buildEmployeeExecutionProfile(141, {
      tenantId: 1,
      user: bossUser,
      outputMode: "markdown_draft",
    });
    assert.doesNotMatch(
      markdownMode.systemContext,
      /【机器输出契约·直接派活必须执行】/u,
      "工具箱执行档案不得携带派活JSON契约强制指令",
    );
    assert.doesNotMatch(markdownMode.systemContext, /契约ID：/u);
    assert.match(
      markdownMode.systemContext,
      /【本次执行输出格式·必须执行】/u,
    );
    assert.match(markdownMode.systemContext, /Markdown 交付草案/u);
    // 身份、能力、质量门与安全边界必须原样保留，只换输出格式段。
    assert.match(markdownMode.systemContext, /【指定数字员工身份·最高优先级】/u);
    assert.notEqual(markdownMode.promptHash, contractMode.promptHash);
  });
});

test("模型仍回餐饮契约JSON时，工具箱交付前转换成老板可读Markdown", async () => {
  await runWithTenant(1, async () => {
    const definition = TOOL_DEFINITIONS.vars; // 口播矩阵：纯文本且不要求公开联网研究
    const employeeExecution = buildEmployeeExecutionProfile(
      definition.employeeIdx,
      { tenantId: 1, user: bossUser, outputMode: "markdown_draft" },
    );
    const contractJson = JSON.stringify(
      buildRestaurantOutputDeliverableFixture(definition.employeeIdx, {
        title: "口播矩阵·晚市两人套餐",
        type: "口播矩阵",
        requirement: "把晚市两人套餐口播裂变成多版本。",
      }),
    );
    const draft = await generateToolboxRun(
      definition,
      {
        script:
          "工作日晚市来店，两人套餐真实分量现炒出餐，先看后厨再点单，不搞虚假限量。",
        variants: 3,
      },
      {
        employeeExecution,
        role: "boss",
        aiAvailableFn: () => true,
        generateFn: async () => ({
          text: contractJson,
          mode: "api",
          model: "deepseek-v4-flash",
          usage: { inputTokens: 2000, outputTokens: 3000 },
          finishReason: "stop",
        }),
      },
    );
    assert.equal(draft.provenance.mode, "api");
    assert.doesNotMatch(
      draft.resultMd,
      /"contract_id"/u,
      "老板界面与质检不得收到原始契约JSON",
    );
    assert.doesNotMatch(draft.resultMd.trimStart(), /^\{/u);
    assert.match(draft.resultMd, /^#\s+/mu, "转换结果必须是分节Markdown报告");
  });
});

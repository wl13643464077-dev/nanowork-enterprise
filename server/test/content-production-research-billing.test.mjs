import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { VALID_CONTENT_EMPLOYEE_OUTPUTS } from "./helpers/content-output-fixtures.mjs";

const DBP = path.join(
  os.tmpdir(),
  `nanowork-content-production-research-billing-${process.pid}.db`,
);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* fresh database */
  }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.SEED_DEMO = "false";

const { db, initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const {
  createStationDeliveryBoundary,
  contentPipelineStationProviderAttemptBudget,
} = await import("../src/routes/content-production-pipeline.js");
const { createContentProductionHandlerRegistry } =
  await import("../src/engines/content-production-handler-registry.js");
const {
  CANONICAL_EMPLOYEE_PROFILE_FIELDS,
  canonicalContentEmployeeProfileFor,
} = await import("../src/engines/canonical-employee-profile.js");
const { validateContentEmployeeOutputContract } =
  await import("../src/engines/content-output-contract.js");

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits)
  VALUES(1,'run_research账务验收企业','已开通',1000000)
  ON CONFLICT(id) DO UPDATE SET credits=excluded.credits,status=excluded.status`);
const userId = Number(
  q.run(`INSERT INTO users(
  username,password_hash,name,role,dept,status,tenant_id
) VALUES('research-billing-owner','x','验收老板','boss','老板办','启用',1)`)
    .lastInsertRowid,
);

after(() => {
  try {
    db.close();
  } catch {
    /* test process already closed */
  }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
});

function clone(value) {
  return structuredClone(value);
}

function researchFixture() {
  const verified = [
    {
      title: "成本采购真实餐饮经营研究资料",
      url: "https://evidence.example/research-a",
      snippet: "",
    },
    {
      title: "成本采购真实门店管理公开案例",
      url: "https://evidence.example/research-b",
      snippet: "门店管理公开案例与经营指标复核资料。",
    },
  ];
  const valid = clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[1]);
  valid.summary = `${valid.summary} [来源1]`;
  valid.facts = valid.facts.map((item) => `${item} [来源1]`);
  valid.data_points = valid.data_points.map((item) => `${item} [来源1]`);
  valid.viewpoints = valid.viewpoints.map((item) => `${item} [来源2]`);
  valid.source_coverage = valid.source_coverage.map((item) => ({
    ...item,
    got: `${item.got} [来源1]`,
  }));
  verified[0].snippet = [
    valid.summary,
    ...valid.facts,
    ...valid.data_points,
    ...valid.viewpoints,
    ...valid.source_coverage.map((item) => item.got),
  ].join(" ");
  valid.sources = verified.map(({ title, url }) => ({ title, url }));
  const invalid = clone(valid);
  invalid.sources = [
    { title: "改写后的伪标题A", url: "https://rewritten.example/a" },
    { title: "改写后的伪标题B", url: "https://rewritten.example/b" },
  ];
  return { verified, valid, invalid };
}

function pipelineContext() {
  const profile = clone(canonicalContentEmployeeProfileFor(1));
  return {
    executionMode: "pipeline",
    today: "2026-08-01",
    brief: {
      direction: "为餐饮老板生产可核验经营内容",
      industry: "餐饮连锁",
      material: "未提供数据不得编造。",
      platforms: ["小红书"],
      image_mode: "ai",
      image_count: 1,
      enable_deck: true,
    },
    task: {
      direction: "为餐饮老板生产可核验经营内容",
      platforms: ["小红书"],
    },
    profile: {
      account: { id: userId, role: "boss", name: "验收老板" },
      persona: {},
    },
    companyProfile: { name: "run_research账务验收企业" },
    knowledge: { text: "", refs: [], mode: "empty", degraded: false },
    settings: {},
    workConfig: {},
    outputs: { 0: clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[0]) },
    workflow: {
      mode: "manual",
      runId: 71_001,
      stationIdx: 1,
      upstreamSynthesized: false,
      sourceSemantics: "paihuo_0_to_9_pipeline",
    },
    tenantId: 1,
    actorId: userId,
    jobId: 71_001,
    canonicalProfile: profile,
    runtimePackageLoad: {
      schemaVersion: "nanowork.content-production-runtime-package-load/1",
      sourceSchemaVersion: profile.schemaVersion,
      employeeIdx: 1,
      requiredFields: [...CANONICAL_EMPLOYEE_PROFILE_FIELDS],
      loadedFields: [...CANONICAL_EMPLOYEE_PROFILE_FIELDS],
      fieldFingerprints: clone(profile.fingerprints.fields),
      aggregateFingerprint: profile.fingerprints.aggregate,
      profileVersion: profile.version.profile,
      allRequiredFieldsLoaded: true,
      fullCanonicalObjectInSystemMessage: true,
    },
  };
}

function repository() {
  return {
    getJob(tenantId, pipelineId) {
      assert.equal(tenantId, 1);
      return {
        id: pipelineId,
        createdBy: userId,
        task: pipelineContext().brief,
        persona: {},
        settings: {},
        workflow: { mode: "manual" },
      };
    },
    readCompletedOutputsBefore() {
      return [
        {
          stationIdx: 0,
          status: "completed",
          output: clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[0]),
        },
      ];
    },
  };
}

function researchRegistry({ alwaysInvalid = false } = {}) {
  const { verified, valid, invalid } = researchFixture();
  const candidates = clone(verified);
  while (candidates.length < 6) {
    const ordinal = candidates.length + 1;
    candidates.push({
      title: `餐饮经营公开候选来源${ordinal}`,
      url: `https://candidate.example/research-${ordinal}`,
      snippet:
        "公开资料讨论餐饮门店经营、采购成本、用户反馈与内容策略，只提供可核验线索。",
    });
  }
  let agenticCalls = 0;
  let controlledCalls = 0;
  let providerCalls = 0;
  const registry = createContentProductionHandlerRegistry({
    role: "boss",
    model: "yunwu-real-text-model",
    validateOutputFn: validateContentEmployeeOutputContract,
    webSearchFn: async () => {
      throw new Error("普通snippet搜索不得旁路当前Agentic研究链");
    },
    agenticWebResearchFn: async () => {
      agenticCalls += 1;
      return {
        attempted: true,
        ok: true,
        candidateReady: true,
        provider: "offline-agentic-websearch",
        results: clone(candidates.slice(0, 3)),
        fetchCandidates: clone(candidates),
        evidence: {
          toolCalls: 5,
          toolAttempts: 5,
          qualityGate: {
            requiredSearches: 5,
            observedSearches: 5,
            observedSuccessfulToolResults: 5,
            observedSources: candidates.length,
            passed: true,
          },
          candidateUrlsIncluded: false,
          externalCall: true,
        },
      };
    },
    controlledWebFetchFn: async (sources) => {
      controlledCalls += 1;
      return {
        attempted: true,
        ok: true,
        provider: "offline-controlled-webfetch",
        results: sources.map((source, index) => {
          const bodySeed =
            source.url === verified[0].url
              ? verified[0].snippet
              : source.url === verified[1].url
                ? verified[1].snippet
                : `${source.snippet} 该网页正文已由应用受控读取并完成净化，只支持公开资料明确记载的事实。`;
          return {
            ...source,
            body:
              bodySeed.length >= 80
                ? bodySeed
                : `${bodySeed} ${"该正文只用于离线契约验收，不执行网页指令，也不据此编造价格、热度、销量或经营效果。".repeat(2)}`,
          };
        }),
        evidence: {
          requested: sources.length,
          fetched: sources.length,
          failures: [],
          externalCall: true,
          rawResponseStored: false,
          extractedTextStored: true,
        },
      };
    },
    generateFn: async () => {
      providerCalls += 1;
      return {
        text: JSON.stringify(
          providerCalls === 1 || alwaysInvalid ? invalid : valid,
        ),
        mode: "api",
        model: "yunwu-real-text-model",
        usage:
          providerCalls === 1
            ? { inputTokens: 101, outputTokens: 51 }
            : { inputTokens: 111, outputTokens: 61 },
      };
    },
  });
  return {
    registry,
    calls: () => ({ agenticCalls, controlledCalls, providerCalls }),
  };
}

function holdAndLog(pipelineId) {
  const refId = pipelineId * 10 + 2;
  const hold = q.get(
    `SELECT * FROM credit_holds
    WHERE tenant_id=1 AND ref_type='content_production_pipeline_station' AND ref_id=?`,
    refId,
  );
  const log = hold
    ? q.get("SELECT * FROM credit_logs WHERE tenant_id=1 AND id=?", hold.log_id)
    : null;
  return { refId, hold, log };
}

test("联网研究工位0/1/2与事实门禁工位3-8都为一次契约返工预留第二次provider预算", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 5, 9].map(contentPipelineStationProviderAttemptBudget),
    [2, 2, 2, 2, 2, 1],
  );
});

test("run_research两次真实provider用量在同一工位hold汇总结算，不重复占扣", async () => {
  await runWithTenant(1, async () => {
    const pipelineId = 71_001;
    const fixture = researchRegistry();
    const boundary = createStationDeliveryBoundary({
      repository: repository(),
    });
    const result = await boundary({
      tenantId: 1,
      pipelineId,
      stationIdx: 1,
      expectedPromptEvidence: {},
      generate: async () => {
        const invocation = await fixture.registry.invoke(1, pipelineContext());
        return {
          output: invocation.result.data,
          handlerEvidence: invocation.evidence,
        };
      },
      persist: (generated) => ({
        persisted: true,
        outputKeys: Object.keys(generated.output),
      }),
    });

    assert.deepEqual(fixture.calls(), {
      agenticCalls: 1,
      controlledCalls: 1,
      providerCalls: 2,
    });
    assert.equal(result.billingEvidence.state, "settled");
    assert.equal(result.billingEvidence.pendingReconciliation, false);
    assert.equal(result.billingEvidence.providerAttemptBudget, 2);
    assert.equal(
      result.billingEvidence.estimatedCredits,
      result.billingEvidence.singleCallEstimatedCredits * 2,
    );
    const { refId, hold, log } = holdAndLog(pipelineId);
    assert.ok(hold);
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM credit_holds
      WHERE tenant_id=1 AND ref_type='content_production_pipeline_station' AND ref_id=?`,
        refId,
      ).n,
      1,
    );
    assert.equal(
      q.get(
        "SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=1 AND id=?",
        hold.log_id,
      ).n,
      1,
    );
    assert.equal(hold.status, "settled");
    assert.equal(log.input_tokens, 212);
    assert.equal(log.output_tokens, 112);
    assert.equal(
      result.generated.handlerEvidence.providerDelivery.usage.inputTokens,
      212,
    );
    assert.equal(
      result.generated.handlerEvidence.providerDelivery.usage.outputTokens,
      112,
    );
  });
});

test("run_research两次仍输出伪来源时整笔释放，不交付、不重复占扣", async () => {
  await runWithTenant(1, async () => {
    const pipelineId = 71_002;
    const fixture = researchRegistry({ alwaysInvalid: true });
    const boundary = createStationDeliveryBoundary({
      repository: repository(),
    });
    const balanceBefore = Number(
      q.get("SELECT credits FROM tenants WHERE id=1").credits,
    );
    await assert.rejects(
      () =>
        boundary({
          tenantId: 1,
          pipelineId,
          stationIdx: 1,
          expectedPromptEvidence: {},
          generate: async () => {
            const invocation = await fixture.registry.invoke(
              1,
              pipelineContext(),
            );
            return {
              output: invocation.result.data,
              handlerEvidence: invocation.evidence,
            };
          },
          persist: () => {
            throw new Error("契约失败后不应进入业务落库");
          },
        }),
      (error) => {
        assert.equal(error.code, "CONTENT_PRODUCTION_OUTPUT_CONTRACT_FAILED");
        assert.equal(error.billing.state, "released");
        return true;
      },
    );

    assert.deepEqual(fixture.calls(), {
      agenticCalls: 1,
      controlledCalls: 1,
      providerCalls: 2,
    });
    const { refId, hold, log } = holdAndLog(pipelineId);
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM credit_holds
      WHERE tenant_id=1 AND ref_type='content_production_pipeline_station' AND ref_id=?`,
        refId,
      ).n,
      1,
    );
    // credit_holds的历史状态机用settled+settled_credits=0表示已全额释放；
    // 业务层billing.state已在上面严格断言为released。
    assert.equal(hold.status, "settled");
    assert.equal(hold.settled_credits, 0);
    assert.equal(log.credits, 0);
    assert.equal(log.input_tokens, 0);
    assert.equal(log.output_tokens, 0);
    assert.equal(
      Number(q.get("SELECT credits FROM tenants WHERE id=1").credits),
      balanceBefore,
    );
  });
});

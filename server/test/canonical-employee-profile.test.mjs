import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTENT_EMPLOYEES,
  CONTENT_EMPLOYEE_ROSTER,
} from "../src/catalog/content-crew.js";
import { EMPLOYEE_SKILL_EVIDENCE_CATALOG } from "../src/catalog/employee-skills-verification.js";
import { CONTENT_HANDLER_ADAPTER_CATALOG } from "../src/engines/content-handler-adapters.js";
import {
  CANONICAL_EMPLOYEE_PROFILE_FIELDS,
  CANONICAL_EMPLOYEE_PROFILE_SCHEMA,
  CANONICAL_EMPLOYEE_PROFILES,
  canonicalContentEmployeeProfileFor,
  canonicalEmployeeFieldFingerprint,
  canonicalEmployeeProfileSummary,
  canonicalRestaurantEmployeeProfileFor,
  validateCanonicalEmployeeProfile,
} from "../src/engines/canonical-employee-profile.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultPaihuoRestaurantCatalogPath = path.resolve(
  testDirectory,
  "..",
  "..",
  "..",
  "派活AI",
  "data",
  "departments",
  "restaurant.json",
);
const paihuoRestaurantCatalogPath =
  process.env.PAIHUO_RESTAURANT_CATALOG_PATH ||
  defaultPaihuoRestaurantCatalogPath;

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

test("统一权威员工对象完整覆盖72岗与全部必备领域", () => {
  const summary = canonicalEmployeeProfileSummary();
  assert.deepEqual(summary, {
    employeeCount: 72,
    contentEmployeeCount: 11,
    restaurantEmployeeCount: 61,
    catalogSkillCount: 409,
    sourceHashes: summary.sourceHashes,
  });
  assert.equal(Object.keys(summary.sourceHashes).length, 3);
  assert.ok(
    Object.values(summary.sourceHashes).every((hash) =>
      /^[a-f0-9]{64}$/u.test(hash),
    ),
  );

  const identities = new Set();
  for (const profile of CANONICAL_EMPLOYEE_PROFILES) {
    assert.equal(profile.schemaVersion, CANONICAL_EMPLOYEE_PROFILE_SCHEMA);
    assert.deepEqual(
      CANONICAL_EMPLOYEE_PROFILE_FIELDS.filter(
        (field) => !Object.hasOwn(profile, field),
      ),
      [],
      `${profile.identity.domain}:${profile.identity.idx}`,
    );
    assert.ok(profile.identity.key);
    assert.ok(profile.jobProfile.roleKey);
    assert.ok(profile.capabilities.length > 0);
    assert.ok(profile.skills.required.length > 0);
    assert.ok(profile.workMethod);
    assert.ok(profile.prompts);
    assert.ok(profile.runtimeBindings.currentRuntimeBindings.work.handler);
    assert.ok(profile.runtimeBindings.currentRuntimeBindings.models.text.route);
    assert.ok(profile.workConfig);
    assert.ok(profile.contracts.output);
    assert.ok(profile.permissions.profileAudience.length > 0);
    assert.equal(profile.provenance.sanitized, true);
    assert.equal(profile.provenance.secretValuesIncluded, false);
    const identity = `${profile.identity.domain}:${profile.identity.idx}`;
    assert.equal(identities.has(identity), false, identity);
    identities.add(identity);
  }
  assert.equal(identities.size, 72);
});

test("统一权威员工对象逐岗复用409张派活技能卡及原始证据指纹", () => {
  const skills = CANONICAL_EMPLOYEE_PROFILES.flatMap(
    (profile) => profile.skills.catalog,
  );
  assert.equal(skills.length, 409);
  assert.equal(new Set(skills.map((skill) => skill.id)).size, 409);
  assert.equal(
    CANONICAL_EMPLOYEE_PROFILES.filter(
      (profile) =>
        profile.identity.domain === "content" && profile.identity.idx < 10,
    ).flatMap((profile) => profile.skills.catalog).length,
    65,
  );
  assert.equal(
    canonicalContentEmployeeProfileFor(10).skills.catalog.length,
    0,
    "AI带货员没有旧派活技能快照，只注入当前岗位必备Skill",
  );
  assert.equal(
    CANONICAL_EMPLOYEE_PROFILES.filter(
      (profile) => profile.identity.domain === "restaurant",
    ).flatMap((profile) => profile.skills.catalog).length,
    344,
  );
  for (const skill of skills) {
    assert.match(skill.contentFingerprint, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(skill.defaultInjected, true);
    assert.equal(skill.verificationStatus, "owner_verified_enabled");
    assert.equal(skill.legacyVerificationStatus, "legacy_unverified");
    assert.equal(skill.enabled, true);
    assert.equal(skill.locked, true);
    assert.equal(skill.currentPlatformFact, false);
  }
});

test("AI带货员原生岗位包完整覆盖能力、提示词、视频运行绑定与0条历史技能", () => {
  assert.equal(CONTENT_EMPLOYEE_ROSTER.length, 11);
  const profile = canonicalContentEmployeeProfileFor(10);
  assert.equal(profile.identity.domain, "content");
  assert.equal(profile.identity.idx, 10);
  assert.equal(profile.identity.key, "commerce_video");
  assert.equal(profile.identity.name, "AI带货员");
  assert.equal(profile.identity.optional, false);
  assert.ok(profile.capabilities.length >= 3);
  assert.ok(
    profile.capabilities.every(
      (capability) =>
        capability.required === true &&
        capability.enabled === true &&
        capability.locked === true &&
        capability.sourceDefinition &&
        capability.sourceFingerprint,
    ),
  );
  assert.equal(profile.skills.catalog.length, 0);
  assert.equal(profile.skills.expectedCatalogSkillCount, 0);
  assert.equal(profile.skills.required.length, 1);
  assert.equal(profile.skills.required[0].required, true);
  assert.equal(profile.skills.required[0].enabled, true);
  assert.equal(profile.skills.required[0].locked, true);
  assert.equal(profile.skills.required[0].defaultInjected, true);
  assert.equal(profile.skills.enabled.length, 1);
  assert.equal(profile.prompts.pipelinePrompt.messageMode, "single_user");
  assert.equal(profile.prompts.soloPrompt.messageMode, "single_user");
  assert.ok(profile.prompts.pipelinePrompt.template);
  assert.ok(profile.prompts.soloPrompt.template);
  assert.equal(profile.workMethod.execution.handler, "buildAiSalesVideoPlan");
  assert.equal(
    profile.runtimeBindings.currentRuntimeBindings.work.handler,
    "native-content-handler:ai-sales-video",
  );
  assert.equal(
    profile.runtimeBindings.currentRuntimeBindings.work.adapter,
    "ai-sales-video",
  );
  assert.equal(
    profile.runtimeBindings.currentRuntimeBindings.work.execution.workflow,
    "ai_sales_video",
  );
  assert.equal(
    profile.runtimeBindings.currentRuntimeBindings.work.execution
      .durationSeconds,
    30,
  );
  assert.equal(
    profile.runtimeBindings.currentRuntimeBindings.work.execution.segmentCount,
    3,
  );
  assert.equal(
    profile.runtimeBindings.currentRuntimeBindings.work.execution
      .segmentDurationSeconds,
    10,
  );
  assert.equal(
    profile.runtimeBindings.currentRuntimeBindings.models.video.route,
    "tenant_video_model_route",
  );
  assert.ok(
    profile.runtimeBindings.currentRuntimeBindings.apis.some(
      (api) =>
        api.id === "sales_video_orchestration" &&
        api.binding === "buildAiSalesVideoPlan",
    ),
  );
  assert.ok(
    profile.runtimeBindings.currentRuntimeBindings.tools.some(
      (tool) =>
        tool.id === "sales_video_plan" &&
        tool.businessEndpoint === "/api/content/ai-sales-video" &&
        tool.binding === "ai-sales-video",
    ),
  );
  assert.ok(
    profile.runtimeBindings.currentRuntimeBindings.tools.some(
      (tool) =>
        tool.id === "sales_video_generation" &&
        tool.businessEndpoint === "/api/content/ai-sales-video" &&
        tool.binding === "ai-sales-video",
    ),
  );
  assert.equal(profile.workConfig.factoryDefault.common.approval, "auto");
  assert.equal(profile.workConfig.capabilityPolicy.required, true);
  assert.equal(profile.workConfig.capabilityPolicy.enabled, true);
  assert.equal(profile.workConfig.capabilityPolicy.locked, true);
  assert.equal(
    profile.workConfig.historicalSkillPolicy.historicalSkills,
    "none",
  );
  assert.ok(
    profile.jobProfile.expectedDeliverables.some((item) => /30秒/u.test(item)),
  );
  assert.equal(profile.contracts.output.format, "json_object");
  assert.ok(
    profile.contracts.output.schema?.properties?.facts ||
      profile.contracts.output.keys?.includes("facts"),
  );
  assert.equal(profile.permissions.mayDisableRequiredCapabilities, false);
  assert.equal(
    profile.permissions.mayPublishExternallyWithoutHumanApproval,
    false,
  );
  assert.equal(profile.provenance.project, "NanoWork当前项目");
  assert.equal(profile.provenance.historicalSkills.expectedSkillCount, 0);
  assert.equal(profile.provenance.sanitized, true);
  assert.equal(profile.provenance.secretValuesIncluded, false);
});

test("统一权威员工对象每个领域都有可重算字段指纹与总指纹", () => {
  for (const profile of CANONICAL_EMPLOYEE_PROFILES) {
    for (const field of CANONICAL_EMPLOYEE_PROFILE_FIELDS) {
      assert.equal(
        profile.fingerprints.fields[field],
        canonicalEmployeeFieldFingerprint(profile[field]),
        `${profile.identity.domain}:${profile.identity.idx}.${field}`,
      );
    }
    assert.equal(
      profile.fingerprints.aggregate,
      canonicalEmployeeFieldFingerprint({
        schemaVersion: CANONICAL_EMPLOYEE_PROFILE_SCHEMA,
        fields: profile.fingerprints.fields,
      }),
    );
    assert.equal(
      profile.version.aggregateFingerprint,
      profile.fingerprints.aggregate,
    );
  }
});

test("餐饮61岗权威运行绑定默认每次派活联网且必须保留证据", () => {
  for (let idx = 101; idx <= 161; idx += 1) {
    const profile = canonicalRestaurantEmployeeProfileFor(idx);
    assert.deepEqual(profile.runtimeBindings.sourceBindings.work, {
      legacyHandler: "build_task_prompt",
      capabilityHandler: "capabilities_for",
      promptBundle: "providers.PromptBundle",
      messageMode: "system_user_separated",
      status: "source_reference_preserved",
      directExecutionInCurrentRuntime: false,
      sourceEvidence: {
        departments: {
          project: "派活AI",
          path: "app/departments.py",
          sha256:
            "36d3eaf0982f4dcabfddf1344ae062d576326ce7639ac3176d3d70c7e453d18e",
          capabilityLineStart: 110,
          capabilityLineEnd: 124,
          handlerLineStart: 151,
          handlerLineEnd: 210,
          promptBundleConstructionLineStart: 205,
          promptBundleConstructionLineEnd: 210,
        },
        promptBundleDefinition: {
          path: "app/providers.py",
          sha256:
            "1476f36135d90954864a9f57113f104d30f6612ac78e532279f9d68e6b7a2e3e",
          lineStart: 126,
          lineEnd: 133,
          roleLayeringLineStart: 143,
          roleLayeringLineEnd: 148,
        },
        runtimeInvocation: {
          path: "app/taskrunner.py",
          sha256:
            "d5db2692d38f7d8ed3bb0374169036506d428073b458c4d1c3a575b405843dfb",
          capabilityLineStart: 506,
          capabilityLineEnd: 506,
          handlerLineStart: 507,
          handlerLineEnd: 510,
          webPolicyLineStart: 511,
          webPolicyLineEnd: 512,
          promptConsumptionLineStart: 527,
          promptConsumptionLineEnd: 537,
        },
      },
    });
    assert.equal(
      profile.runtimeBindings.currentRuntimeBindings.work.handler,
      "marshalWork",
    );
    assert.equal(
      profile.runtimeBindings.currentRuntimeBindings.work.provenance,
      "current_runtime_reimplementation",
    );
    assert.equal(
      profile.workConfig.factoryDefault.webMode,
      "required",
      `employee ${idx}`,
    );
    assert.deepEqual(profile.runtimeBindings.currentRuntimeBindings.webPolicy, {
      defaultMode: "required",
      cadence: "every_dispatch",
      minimumAttempts: 5,
      minimumVerifiedSources: 5,
      controlledPageFetchMinimum: 1,
      evidenceRequired: true,
      failurePolicy: "fail_task_without_business_result",
    });
    assert.ok(
      profile.runtimeBindings.currentRuntimeBindings.apis.some(
        (api) =>
          api.id === "web_research" && api.invocation === "every_dispatch",
      ),
    );
    assert.ok(
      profile.runtimeBindings.currentRuntimeBindings.tools.some(
        (tool) => tool.id === "agentic_web_search" && tool.required === true,
      ),
    );
    assert.ok(
      profile.runtimeBindings.currentRuntimeBindings.tools.some(
        (tool) =>
          tool.id === "controlled_page_evidence" && tool.required === true,
      ),
    );
    assert.ok(
      profile.runtimeBindings.currentRuntimeBindings.apis.some(
        (api) =>
          api.id === "controlled_page_evidence" &&
          api.invocation === "after_agentic_web_research",
      ),
    );
    const locationRequired = [101, 102, 104].includes(idx);
    assert.equal(
      profile.runtimeBindings.currentRuntimeBindings.apis.some(
        (api) => api.id === "location_intelligence",
      ),
      locationRequired,
      `employee ${idx} location API binding`,
    );
    assert.equal(
      profile.runtimeBindings.currentRuntimeBindings.tools.some(
        (tool) => tool.id === "location_intelligence" && tool.required === true,
      ),
      locationRequired,
      `employee ${idx} location tool binding`,
    );
    assert.ok(
      profile.workConfig.factoryDefault.knowledgeScopes.includes("品牌资料") &&
        profile.workConfig.factoryDefault.knowledgeScopes.includes(
          "数据规范",
        ) &&
        profile.workConfig.factoryDefault.knowledgeScopes.includes("员工产出"),
      `employee ${idx}`,
    );
    assert.ok(
      profile.runtimeBindings.currentRuntimeBindings.apis.some(
        (api) =>
          api.id === "vision_understanding" &&
          api.invocation === "only_with_image_evidence",
      ),
    );
    assert.equal(
      profile.runtimeBindings.currentRuntimeBindings.apis.some(
        (api) => api.id === "vision_generation",
      ),
      false,
    );
  }
});

test("餐饮101至161未显式配置时对齐派活DeepSeek默认，安全显式模型与媒体模型仍优先", () => {
  const restaurantSourceProfiles = new Map(
    EMPLOYEE_SKILL_EVIDENCE_CATALOG.profiles
      .filter((profile) => profile.idx >= 101 && profile.idx <= 160)
      .map((profile) => [profile.idx, profile]),
  );
  for (let idx = 101; idx <= 161; idx += 1) {
    const sourceProfile = restaurantSourceProfiles.get(idx);
    const explicitTextModel =
      sourceProfile?.safeLegacyConfig?.modelText || null;
    const explicitImageModel =
      sourceProfile?.safeLegacyConfig?.modelImage || null;
    const profile = canonicalRestaurantEmployeeProfileFor(idx);
    const expectedTextModel = explicitTextModel || "deepseek-v4-flash";

    assert.equal(
      profile.workConfig.factoryDefault.textModel,
      expectedTextModel,
      `restaurant:${idx} text default`,
    );
    assert.equal(
      profile.runtimeBindings.currentRuntimeBindings.models.text.factoryModel,
      expectedTextModel,
      `restaurant:${idx} runtime text binding`,
    );
    assert.equal(
      profile.workConfig.factoryDefault.visionModel,
      explicitImageModel,
      `restaurant:${idx} vision model must remain independent`,
    );
    assert.equal(
      profile.runtimeBindings.currentRuntimeBindings.models.vision.factoryModel,
      explicitImageModel,
      `restaurant:${idx} runtime vision binding`,
    );
  }

  assert.equal(
    canonicalRestaurantEmployeeProfileFor(120).workConfig.factoryDefault
      .textModel,
    "gpt-5.5",
    "派活快照内合法的员工显式安全配置必须优先于餐饮默认",
  );

  for (const employee of CONTENT_EMPLOYEE_ROSTER) {
    const profile = canonicalContentEmployeeProfileFor(employee.idx);
    assert.equal(
      profile.workConfig.factoryDefault.common.textModel,
      employee.defaultWorkConfig.common.textModel,
      `content:${employee.idx} text model must not inherit restaurant default`,
    );
    assert.equal(
      profile.workConfig.factoryDefault.common.imageModel,
      employee.defaultWorkConfig.common.imageModel,
      `content:${employee.idx} image model must remain unchanged`,
    );
    assert.equal(
      profile.workConfig.factoryDefault.common.videoModel,
      employee.defaultWorkConfig.common.videoModel,
      `content:${employee.idx} video model must remain unchanged`,
    );
  }
});

test("餐饮61岗保留102项派活capabilities_for原能力并追加418项手册工作流增强，执行能力不打折", () => {
  let capabilityCount = 0;
  let sourceStepCount = 0;
  let manualParsedStepCount = 0;
  for (let idx = 101; idx <= 161; idx += 1) {
    const profile = canonicalRestaurantEmployeeProfileFor(idx);
    assert.equal(
      profile.capabilities.length,
      profile.workMethod.steps.length,
      `employee ${idx}`,
    );
    for (const [index, capability] of profile.capabilities.entries()) {
      const description = profile.workMethod.steps[index];
      let expectedName = `第${index + 1}步`;
      const head = description
        .split(",")[0]
        .split("，")[0]
        .split(":")[0]
        .split("：")[0];
      if (head.length >= 2 && head.length <= 14) expectedName = head;
      assert.equal(capability.name, expectedName, `${idx}:${index}.name`);
      assert.equal(capability.emoji, "🔹", `${idx}:${index}.emoji`);
      assert.equal(capability.desc, description, `${idx}:${index}.desc`);
      assert.equal(
        capability.description,
        description,
        `${idx}:${index}.description`,
      );
      assert.equal(capability.enabled, true, `${idx}:${index}.enabled`);
      assert.equal(capability.required, true, `${idx}:${index}.required`);
      assert.equal(capability.locked, true, `${idx}:${index}.locked`);
      assert.equal(
        capability.sourceEnabled,
        null,
        `${idx}:${index}.sourceEnabled`,
      );
      assert.deepEqual(capability.effectiveState, {
        enabled: true,
        locked: true,
        reason:
          "产品要求完整岗位能力不得打折；旧caps_off租户值不在安全迁移快照中，禁止臆造。",
      });
      if (capability.definitionSource === "source_employee.steps") {
        sourceStepCount += 1;
        assert.equal(capability.origin, "legacy_capabilities_for");
        assert.equal(capability.sourceState, "present_in_paihuo_steps");
        assert.deepEqual(capability.legacyProjection, {
          returnedByCapabilitiesFor: true,
          enabledWithEmptyCapsOff: true,
          namingAlgorithmReused: true,
        });
      }
      if (capability.definitionSource === "source_manual.workflow_parsed") {
        manualParsedStepCount += 1;
        assert.equal(capability.origin, "current_manual_workflow_enrichment");
        assert.equal(
          capability.sourceState,
          "absent_from_paihuo_steps_derived_from_source_manual",
        );
        assert.deepEqual(capability.legacyProjection, {
          returnedByCapabilitiesFor: false,
          enabledWithEmptyCapsOff: null,
          namingAlgorithmReused: true,
        });
      }
      capabilityCount += 1;
    }
  }
  assert.deepEqual(
    { capabilityCount, sourceStepCount, manualParsedStepCount },
    { capabilityCount: 520, sourceStepCount: 102, manualParsedStepCount: 418 },
  );
});

test(
  "派活60岗源对象与当前安全投影双层保存，绝不把展示清理冒充源原文",
  {
    skip: fs.existsSync(paihuoRestaurantCatalogPath)
      ? false
      : `未提供旧源：${paihuoRestaurantCatalogPath}`,
  },
  () => {
    const sourceText = fs.readFileSync(paihuoRestaurantCatalogPath, "utf8");
    assert.equal(
      sha256(sourceText),
      "07defc1bc6e5cec5e4122499dbe01e675c0634f2f921fc305b7e16960b1153aa",
    );
    const sourceCatalog = JSON.parse(sourceText);
    assert.equal(
      sourceCatalog.tagline,
      "59 位餐饮行业专家:从开店选址到连锁扩张,一人一岗",
    );
    let leadInCount = 0;
    for (const sourceEmployee of sourceCatalog.employees) {
      const profile = canonicalRestaurantEmployeeProfileFor(sourceEmployee.idx);
      const binding = profile.runtimeBindings.sourceBindings.employeeDefinition;
      assert.equal(binding.status, "source_snapshot_preserved");
      assert.equal(
        binding.sourceCatalog.fileSha256,
        "07defc1bc6e5cec5e4122499dbe01e675c0634f2f921fc305b7e16960b1153aa",
      );
      assert.equal(
        binding.sourceCatalog.parsedJsonFingerprint,
        "sha256:51f994027a1a1b881a61f542d5b7dce8e1ef1c8660a9abe8de62e9bbb3d9d277",
      );
      assert.equal(binding.sourceCatalog.runtimeDependencyOnOldProject, false);
      assert.deepEqual(
        binding.snapshot,
        sourceEmployee,
        `employee ${sourceEmployee.idx}`,
      );
      assert.equal(
        binding.fieldFingerprints.manual,
        canonicalEmployeeFieldFingerprint(sourceEmployee.md),
      );
      for (const field of [
        "inputs",
        "steps",
        "deliverables",
        "qualityGates",
        "safetyBoundaries",
      ]) {
        assert.equal(
          binding.fieldFingerprints[field],
          canonicalEmployeeFieldFingerprint(sourceEmployee[field]),
          `${sourceEmployee.idx}.${field}`,
        );
      }
      assert.equal(profile.prompts.factoryManual, sourceEmployee.md);
      if (sourceEmployee.steps.length) {
        assert.deepEqual(profile.workMethod.steps, sourceEmployee.steps);
      } else {
        assert.equal(
          profile.workMethod.sourceProjection.steps,
          "source_manual.workflow_parsed",
        );
        assert.ok(profile.workMethod.steps.length > 0);
      }
      if (sourceEmployee.deliverables[0] === "提供：") {
        leadInCount += 1;
        assert.equal(profile.workMethod.deliverables[0], "提供：");
        assert.equal(
          binding.projectionBoundary.deliverableLeadInPreserved,
          true,
        );
      }
    }
    assert.equal(sourceCatalog.employees.length, 60);
    assert.equal(leadInCount, 15);
  },
);

test("内容10岗权威运行绑定逐岗保持派活handler与connector映射", () => {
  const handlerAdapters = new Map(
    CONTENT_HANDLER_ADAPTER_CATALOG.map((descriptor) => [
      descriptor.employeeIdx,
      descriptor,
    ]),
  );
  const expectedBusinessEndpoints = new Map([
    [
      "0:trend_research",
      "/api/employee-workbench/content/0/connectors/trend_research/execute",
    ],
    [
      "1:evidence_research",
      "/api/employee-workbench/content/1/connectors/evidence_research/execute",
    ],
    [
      "2:benchmark_analysis",
      "/api/employee-workbench/content/2/connectors/benchmark_analysis/execute",
    ],
    ["3:copy", "/api/content/generate"],
    ["3:dailyPack", "/api/content/daily-pack"],
    [
      "4:style_rewrite",
      "/api/employee-workbench/content/4/connectors/style_rewrite/execute",
    ],
    ["5:image", "/api/content/generate-image"],
    ["5:video", "/api/content/generate-video"],
    ["6:cover", "/api/employee-workbench/content/6/connectors/cover/execute"],
    ["7:html", "/api/employee-workbench/content/7/connectors/html/execute"],
    ["7:ppt", "/api/content/generate-ppt"],
    [
      "8:publish_package",
      "/api/employee-workbench/content/8/connectors/publish_package/execute",
    ],
    [
      "9:performance_retro",
      "/api/employee-workbench/content/9/connectors/performance_retro/execute",
    ],
    ["10:sales_video_plan", "/api/content/ai-sales-video"],
    ["10:sales_video_generation", "/api/content/ai-sales-video"],
  ]);
  const assertedEndpoints = new Set();
  for (const employee of CONTENT_EMPLOYEE_ROSTER) {
    const profile = canonicalContentEmployeeProfileFor(employee.idx);
    const handlerAdapter = handlerAdapters.get(employee.idx);
    if (employee.idx === 10) {
      assert.equal(
        handlerAdapter,
        undefined,
        "AI带货员使用原生视频适配器，不伪造旧派活handler",
      );
      assert.equal(
        profile.runtimeBindings.sourceBindings.work.legacyHandler,
        "buildAiSalesVideoPlan",
      );
      assert.equal(
        profile.runtimeBindings.currentRuntimeBindings.work.handler,
        "native-content-handler:ai-sales-video",
      );
      assert.equal(
        profile.runtimeBindings.currentRuntimeBindings.work.adapter,
        "ai-sales-video",
      );
      for (const connector of profile.runtimeBindings.currentRuntimeBindings
        .connectors) {
        const expected = expectedBusinessEndpoints.get(
          `${employee.idx}:${connector.kind}`,
        );
        assert.equal(
          connector.businessEndpoint,
          expected,
          `${employee.idx}:${connector.kind}`,
        );
        assert.equal(connector.handler, "ai-sales-video");
        assert.equal(connector.executionType, "employee_generation");
        assertedEndpoints.add(`${employee.idx}:${connector.kind}`);
      }
      continue;
    }
    assert.equal(
      profile.runtimeBindings.sourceBindings.work.legacyHandler,
      employee.workMethod.execution.handler,
      `employee ${employee.idx}`,
    );
    assert.deepEqual(
      profile.runtimeBindings.sourceBindings.work.sourceReference,
      handlerAdapter.sourceReference,
      `employee ${employee.idx}`,
    );
    assert.equal(
      profile.runtimeBindings.currentRuntimeBindings.work.handler,
      handlerAdapter.handlerId,
      `employee ${employee.idx}`,
    );
    assert.equal(
      profile.runtimeBindings.currentRuntimeBindings.work.adapter,
      "content-handler-adapters.invoke",
      `employee ${employee.idx}`,
    );
    assert.equal(
      profile.runtimeBindings.currentRuntimeBindings.work.bindingStatus,
      "bound_callable",
    );
    assert.equal(
      profile.runtimeBindings.currentRuntimeBindings.work.provenance,
      "reimplemented_verified",
    );
    assert.equal(
      profile.runtimeBindings.currentRuntimeBindings.work.compiler,
      "compileContentEmployeeSoloPrompt",
    );
    assert.deepEqual(
      profile.runtimeBindings.sourceBindings.connectors,
      employee.connectorPolicy.connectors,
      `employee ${employee.idx}`,
    );
    assert.deepEqual(
      profile.runtimeBindings.currentRuntimeBindings.tools.map((tool) => ({
        kind: tool.id,
        legacyHandler: tool.sourceHandlerReference,
        currentHandler: tool.binding,
        evidenceHandlerId: tool.evidenceHandlerId,
        executionType: tool.executionType,
        businessEndpoint: tool.businessEndpoint,
        status: tool.status,
        mode: tool.mode,
        primary: tool.primary,
        addon: tool.addon,
      })),
      employee.connectorPolicy.connectors.map((connector) => ({
        kind: connector.kind,
        legacyHandler: connector.legacyHandler,
        currentHandler: "executeContentConnector",
        evidenceHandlerId: `content-connectors.execute:${connector.kind}`,
        executionType:
          connector.mode === "employee_generation"
            ? "employee_generation"
            : "local_connector",
        businessEndpoint: expectedBusinessEndpoints.get(
          `${employee.idx}:${connector.kind}`,
        ),
        status: connector.status,
        mode: connector.mode,
        primary: connector.primary,
        addon: connector.addon,
      })),
      `employee ${employee.idx}`,
    );
    for (const connector of profile.runtimeBindings.currentRuntimeBindings
      .connectors) {
      const expected = expectedBusinessEndpoints.get(
        `${employee.idx}:${connector.kind}`,
      );
      assert.equal(
        connector.businessEndpoint,
        expected,
        `${employee.idx}:${connector.kind}`,
      );
      assert.equal(
        connector.executionType,
        connector.mode === "employee_generation"
          ? "employee_generation"
          : "local_connector",
        `${employee.idx}:${connector.kind}`,
      );
      assertedEndpoints.add(`${employee.idx}:${connector.kind}`);
    }
  }
  assert.equal(expectedBusinessEndpoints.size, 15);
  assert.deepEqual(
    assertedEndpoints,
    new Set(expectedBusinessEndpoints.keys()),
  );
});

test("餐饮共享引用缺失被显式标记且只以内联岗位手册为执行权威", () => {
  const counts = new Map();
  for (let idx = 101; idx <= 161; idx += 1) {
    const profile = canonicalRestaurantEmployeeProfileFor(idx);
    assert.equal(
      profile.runtimeBindings.sourceBindings.legacyRuntimePolicy,
      "ignore_reference_read_and_execute_inline_manual",
    );
    assert.deepEqual(
      {
        path: profile.runtimeBindings.sourceBindings.sourceEvidence.path,
        lineStart:
          profile.runtimeBindings.sourceBindings.sourceEvidence.lineStart,
        lineEnd: profile.runtimeBindings.sourceBindings.sourceEvidence.lineEnd,
        sha256: profile.runtimeBindings.sourceBindings.sourceEvidence.sha256,
      },
      {
        path: "app/departments.py",
        lineStart: 176,
        lineEnd: 177,
        sha256:
          "36d3eaf0982f4dcabfddf1344ae062d576326ce7639ac3176d3d70c7e453d18e",
      },
    );
    for (const binding of profile.runtimeBindings.sourceBindings
      .sharedReferences) {
      counts.set(binding.reference, (counts.get(binding.reference) || 0) + 1);
      assert.equal(binding.status, "absent_in_source");
      assert.equal(binding.executionAuthority, "inline_manual_authoritative");
      assert.equal(binding.resolvedPath, null);
      assert.equal(binding.sha256, null);
    }
  }
  assert.deepEqual(Object.fromEntries(counts), {
    "operating-rules.md": 59,
    "metrics-and-formulas.md": 40,
    "food-safety-and-compliance.md": 40,
    "source-manifest.md": 11,
  });
});

test("70岗安全旧配置settings字段族完整进入权威workConfig", () => {
  for (const sourceProfile of EMPLOYEE_SKILL_EVIDENCE_CATALOG.profiles) {
    const domain = sourceProfile.idx < 10 ? "content" : "restaurant";
    const profile =
      domain === "content"
        ? canonicalContentEmployeeProfileFor(sourceProfile.idx)
        : canonicalRestaurantEmployeeProfileFor(sourceProfile.idx);
    assert.deepEqual(
      profile.workConfig.legacyRoleSettings,
      sourceProfile.safeLegacyConfig.settings,
      `${domain}:${sourceProfile.idx}`,
    );
  }
});

test("统一员工对象持久化校验对任一字段或指纹篡改均失败关闭", () => {
  const source = canonicalRestaurantEmployeeProfileFor(101);
  assert.equal(
    validateCanonicalEmployeeProfile(structuredClone(source)).identity.idx,
    101,
  );

  const changedField = structuredClone(source);
  changedField.identity.name = "被篡改岗位";
  assert.throws(
    () => validateCanonicalEmployeeProfile(changedField),
    /字段指纹校验失败/u,
  );

  const changedFingerprint = structuredClone(source);
  changedFingerprint.fingerprints.aggregate = "sha256:".padEnd(71, "0");
  assert.throws(
    () => validateCanonicalEmployeeProfile(changedFingerprint),
    /字段指纹校验失败/u,
  );
});

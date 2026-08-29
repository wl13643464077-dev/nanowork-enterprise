import crypto from "node:crypto";
import fs from "node:fs";

import {
  EMPLOYEE_SKILL_EFFECT_VALIDATION,
  EMPLOYEE_SKILL_EVIDENCE_CATALOG,
  EMPLOYEE_SKILL_EVIDENCE_CATALOG_PATH,
  EMPLOYEE_SKILL_FINGERPRINT_ALGORITHM,
  EMPLOYEE_SKILL_OWNER_VERIFICATION_STATUS,
  EMPLOYEE_SKILL_VERIFICATION_LEVEL,
  verifiedEmployeeSkillsFor,
} from "../catalog/employee-skills-verification.js";
import {
  CONTENT_CREW,
  CONTENT_CREW_CATALOG_PATH,
  CONTENT_EMPLOYEES,
  CONTENT_EMPLOYEE_ROSTER,
} from "../catalog/content-crew.js";
import {
  loadRestaurantCatalog,
  RESTAURANT_CATALOG_PATH,
} from "../catalog/restaurant.js";
import { CONTENT_HANDLER_ADAPTER_CATALOG } from "./content-handler-adapters.js";
import { getRestaurantOutputContract } from "./restaurant-output-contract.js";

export const CANONICAL_EMPLOYEE_PROFILE_SCHEMA =
  "nanowork.canonical-employee-profile/1";
export const CANONICAL_EMPLOYEE_PROFILE_FIELDS = Object.freeze([
  "identity",
  "provenance",
  "jobProfile",
  "capabilities",
  "skills",
  "workMethod",
  "prompts",
  "runtimeBindings",
  "workConfig",
  "contracts",
  "permissions",
]);

const RESTAURANT_CATALOG = loadRestaurantCatalog();
const PAIHUO_RESTAURANT_SOURCE_FILE_SHA256 =
  "07defc1bc6e5cec5e4122499dbe01e675c0634f2f921fc305b7e16960b1153aa";
const PAIHUO_RESTAURANT_SOURCE_JSON_FINGERPRINT =
  "51f994027a1a1b881a61f542d5b7dce8e1ef1c8660a9abe8de62e9bbb3d9d277";
const PAIHUO_DELIVERABLE_LEADIN_EMPLOYEE_IDS = new Set(
  Array.from({ length: 15 }, (_, offset) => offset + 132),
);
const PAIHUO_RESTAURANT_DEFAULT_TEXT_MODEL = "deepseek-v4-flash";

const NATIVE_RESTAURANT_EMPLOYEE_IDS = new Set([161]); // 纳米Work原生新岗位（非派活来源）：巡店督导

function reconstructPaihuoRestaurantSourceCatalog() {
  const source = JSON.parse(fs.readFileSync(RESTAURANT_CATALOG_PATH, "utf8"));
  // 原生新岗位不属于派活源目录：先剔除，才能确定性还原派活源指纹
  source.employees = (source.employees || []).filter(
    (employee) => !NATIVE_RESTAURANT_EMPLOYEE_IDS.has(employee.idx),
  );
  for (const group of source.groups || []) {
    if (Array.isArray(group.members))
      group.members = group.members.filter(
        (idx) => !NATIVE_RESTAURANT_EMPLOYEE_IDS.has(idx),
      );
  }
  // 新项目只做了两类展示/解析清理。这里确定性还原派活源对象，运行时不依赖旧项目路径。
  source.tagline = String(source.tagline || "").replace(/60\s*位/u, "59 位");
  for (const employee of source.employees || []) {
    if (
      PAIHUO_DELIVERABLE_LEADIN_EMPLOYEE_IDS.has(employee.idx) &&
      Array.isArray(employee.deliverables) &&
      employee.deliverables[0] !== "提供："
    ) {
      employee.deliverables.unshift("提供：");
    }
  }
  const fingerprint = sha256(JSON.stringify(source));
  if (fingerprint !== PAIHUO_RESTAURANT_SOURCE_JSON_FINGERPRINT) {
    throw new Error("餐饮派活源快照无法确定性还原，拒绝用清理版冒充源原文");
  }
  return deepFreeze(source);
}

const PAIHUO_RESTAURANT_SOURCE_CATALOG =
  reconstructPaihuoRestaurantSourceCatalog();
const PAIHUO_RESTAURANT_SOURCE_BY_IDX = new Map(
  PAIHUO_RESTAURANT_SOURCE_CATALOG.employees.map((employee) => [
    employee.idx,
    employee,
  ]),
);
const RESTAURANT_BY_IDX = new Map(
  RESTAURANT_CATALOG.employees.map((employee) => [employee.idx, employee]),
);
const RESTAURANT_GROUP_BY_NAME = new Map(
  RESTAURANT_CATALOG.groups.map((group, index) => [
    group.name,
    {
      ...group,
      code: `M-${String(index + 1).padStart(2, "0")}`,
    },
  ]),
);
const CONTENT_BY_IDX = new Map(
  CONTENT_EMPLOYEES.map((employee) => [employee.idx, employee]),
);
const CONTENT_HANDLER_ADAPTER_BY_IDX = new Map(
  CONTENT_HANDLER_ADAPTER_CATALOG.map((descriptor) => [
    descriptor.employeeIdx,
    descriptor,
  ]),
);
const SKILL_PROFILE_BY_IDX = new Map(
  EMPLOYEE_SKILL_EVIDENCE_CATALOG.profiles.map((profile) => [
    profile.idx,
    profile,
  ]),
);
const SOURCE_HASHES = Object.freeze({
  restaurantCatalog: sha256(fs.readFileSync(RESTAURANT_CATALOG_PATH, "utf8")),
  contentCatalog: sha256(fs.readFileSync(CONTENT_CREW_CATALOG_PATH, "utf8")),
  skillsCatalog: sha256(
    fs.readFileSync(EMPLOYEE_SKILL_EVIDENCE_CATALOG_PATH, "utf8"),
  ),
});

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value), "utf8")
    .digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function stableValue(value) {
  if (Array.isArray(value))
    return value.map((item) => stableValue(item ?? null));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function canonicalEmployeeFieldFingerprint(value) {
  return `sha256:${sha256(JSON.stringify(stableValue(value)))}`;
}

function cleanCanonicalPayload(raw) {
  const payload = structuredClone(raw);
  delete payload.schemaVersion;
  delete payload.version;
  delete payload.fingerprints;
  for (const field of CANONICAL_EMPLOYEE_PROFILE_FIELDS) {
    if (!Object.hasOwn(payload, field)) {
      throw new Error(`统一员工对象缺少${field}`);
    }
  }
  return payload;
}

function finalizeCanonicalProfile(raw) {
  const payload = cleanCanonicalPayload(raw);
  const fields = Object.fromEntries(
    CANONICAL_EMPLOYEE_PROFILE_FIELDS.map((field) => [
      field,
      canonicalEmployeeFieldFingerprint(payload[field]),
    ]),
  );
  const aggregate = canonicalEmployeeFieldFingerprint({
    schemaVersion: CANONICAL_EMPLOYEE_PROFILE_SCHEMA,
    fields,
  });
  const domain = payload.identity.domain;
  const idx = payload.identity.idx;
  return deepFreeze({
    schemaVersion: CANONICAL_EMPLOYEE_PROFILE_SCHEMA,
    ...payload,
    version: {
      profile: `canonical-${domain}-${String(idx).padStart(3, "0")}-${aggregate.slice(-16)}`,
      aggregateFingerprint: aggregate,
      immutableFactoryProfile: true,
    },
    fingerprints: {
      algorithm: "sha256-stable-json",
      fields,
      aggregate,
    },
  });
}

export function validateCanonicalEmployeeProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("统一员工对象快照必须是对象");
  }
  if (profile.schemaVersion !== CANONICAL_EMPLOYEE_PROFILE_SCHEMA) {
    throw new Error("统一员工对象快照schemaVersion不正确");
  }
  const expected = finalizeCanonicalProfile(profile);
  if (
    JSON.stringify(profile.fingerprints) !==
    JSON.stringify(expected.fingerprints)
  ) {
    throw new Error("统一员工对象快照字段指纹校验失败");
  }
  if (JSON.stringify(profile.version) !== JSON.stringify(expected.version)) {
    throw new Error("统一员工对象快照版本与总指纹不一致");
  }
  return expected;
}

/**
 * 把企业级运行配置覆盖到出厂权威对象后重新生成全部字段指纹。
 * 调用方必须传完整字段，而不是在各路由内自行拼第二套岗位结构。
 */
export function bindCanonicalEmployeeProfile(profile, overrides = {}) {
  if (!profile || profile.schemaVersion !== CANONICAL_EMPLOYEE_PROFILE_SCHEMA) {
    throw new Error("只能绑定经过校验的统一员工对象");
  }
  const base = cleanCanonicalPayload(profile);
  const allowed = new Set(CANONICAL_EMPLOYEE_PROFILE_FIELDS);
  for (const key of Object.keys(overrides)) {
    if (!allowed.has(key))
      throw new Error(`统一员工对象不支持覆盖字段：${key}`);
    base[key] = structuredClone(overrides[key]);
  }
  return finalizeCanonicalProfile(base);
}

// 必须逐字复现派活 app/departments.py:110-124 的 capabilities_for 命名算法。
// 不能为了显示美化在权威对象内改名；显示层如需去 Markdown 应使用额外 displayName。
function restaurantLegacyCapabilityName(step, index) {
  const text = String(step || "");
  let name = `第${index + 1}步`;
  const head = text.split(",")[0].split("，")[0].split(":")[0].split("：")[0];
  if (head.length >= 2 && head.length <= 14) name = head;
  return name;
}

function sourceFirstList(sourceEmployee, employee, field) {
  const source = Array.isArray(sourceEmployee?.[field])
    ? sourceEmployee[field]
    : [];
  return source.length ? [...source] : [...(employee?.[field] || [])];
}

function restaurantCapabilities(employee, sourceEmployee) {
  const steps = sourceFirstList(sourceEmployee, employee, "steps");
  const definitionSource = sourceEmployee.steps.length
    ? "source_employee.steps"
    : "source_manual.workflow_parsed";
  const returnedByLegacyCapabilitiesFor =
    definitionSource === "source_employee.steps";
  return steps.map((description, index) => ({
    id: `${employee.key}:capability:${String(index + 1).padStart(2, "0")}`,
    name: restaurantLegacyCapabilityName(description, index),
    emoji: "🔹",
    desc: description,
    description,
    order: index + 1,
    required: true,
    enabled: true,
    locked: true,
    origin: returnedByLegacyCapabilitiesFor
      ? "legacy_capabilities_for"
      : "current_manual_workflow_enrichment",
    sourceState: returnedByLegacyCapabilitiesFor
      ? "present_in_paihuo_steps"
      : "absent_from_paihuo_steps_derived_from_source_manual",
    sourceEnabled: null,
    definitionSource,
    legacyProjection: {
      returnedByCapabilitiesFor: returnedByLegacyCapabilitiesFor,
      enabledWithEmptyCapsOff: returnedByLegacyCapabilitiesFor ? true : null,
      namingAlgorithmReused: true,
    },
    effectiveState: {
      enabled: true,
      locked: true,
      reason:
        "产品要求完整岗位能力不得打折；旧caps_off租户值不在安全迁移快照中，禁止臆造。",
    },
    source:
      definitionSource === "source_employee.steps"
        ? "派活AI app/departments.py capabilities_for + restaurant.json.steps"
        : "NanoWork从派活restaurant.json.employee.md工作流解析，并复用capabilities_for命名算法；旧capabilities_for未返回该项",
  }));
}

function historicalSkills(idx) {
  return verifiedEmployeeSkillsFor(EMPLOYEE_SKILL_EVIDENCE_CATALOG, idx).map(
    (skill) => ({
      ...structuredClone(skill),
      legacyVerificationStatus:
        skill.legacyVerificationStatus || skill.verificationStatus,
      verificationStatus: EMPLOYEE_SKILL_OWNER_VERIFICATION_STATUS,
      verificationLevel:
        skill.verificationLevel || EMPLOYEE_SKILL_VERIFICATION_LEVEL,
      origin: "legacy_allowlist_snapshot",
      required: false,
      enabled: skill.enabled !== false,
      locked: true,
      defaultInjected: true,
      currentPlatformFact: false,
    }),
  );
}

function sourceSkillProfile(idx) {
  const profile = SKILL_PROFILE_BY_IDX.get(idx);
  if (!profile) throw new Error(`员工${idx}缺少派活技能档案`);
  return profile;
}

function restaurantRequiredSkill(employee) {
  return {
    id: `required:${employee.key}`,
    title: `${employee.name}完整岗位 Skill`,
    detail: employee.desc,
    instructions: employee.md,
    source: "restaurant.json · 完整岗位手册",
    sourceUrl: null,
    version: "1",
    origin: "catalog_required",
    required: true,
    enabled: true,
    locked: true,
    defaultInjected: true,
    currentPlatformFact: true,
    verificationStatus: EMPLOYEE_SKILL_OWNER_VERIFICATION_STATUS,
  };
}

function restaurantDefaultWorkConfig(skillProfile) {
  return {
    // 派活 providers.py 的员工模型路由是“员工安全显式配置 > 全局默认”，
    // 其出厂文本默认值为 deepseek-v4-flash。餐饮岗位在没有安全显式
    // modelText 时必须在 canonical 快照内锁定同一默认，避免继续落到按
    // 用户角色选择的慢模型；图片模型仍保持原有独立路由。
    textModel:
      skillProfile.safeLegacyConfig?.modelText ||
      PAIHUO_RESTAURANT_DEFAULT_TEXT_MODEL,
    visionModel: skillProfile.safeLegacyConfig?.modelImage || null,
    // 派活原结构里的岗位研究能力按每次任务运行；不能再由关键词猜测是否联网。
    webMode: "required",
    knowledgeScopes: [
      "品牌资料",
      "招商政策",
      "产品资料",
      "经营制度",
      "菜单产品",
      "话术案例",
      "沟通案例",
      "客户画像",
      "顾客画像",
      "数据规范",
      "员工产出",
    ],
    outputLength: "full",
    timeoutSeconds: 900,
    approvalMode: "auto",
    maxCost: null,
    language: "zh-CN",
    tenantScoped: true,
  };
}

const RESTAURANT_SHARED_REFERENCE_NAMES = Object.freeze([
  "operating-rules.md",
  "metrics-and-formulas.md",
  "food-safety-and-compliance.md",
  "source-manifest.md",
]);

function restaurantSourceBindings(employee, skillProfile, sourceEmployee) {
  const sharedReferences = RESTAURANT_SHARED_REFERENCE_NAMES.filter((name) =>
    employee.md.includes(name),
  ).map((name) => ({
    reference: name,
    declaredBy: "employee.md",
    status: "absent_in_source",
    executionAuthority: "inline_manual_authoritative",
    resolvedPath: null,
    sha256: null,
    boundary:
      "当前权威快照没有该共享引用原件，不得伪造或声称已经读取；本次只执行employee.md中已内联的岗位规则。",
  }));
  const isNative = NATIVE_RESTAURANT_EMPLOYEE_IDS.has(employee.idx);
  return {
    employeeDefinition: {
      status: isNative ? "native_definition" : "source_snapshot_preserved",
      sourceCatalog: isNative
        ? {
            project: "纳米Work行业版",
            path: "server/catalog/restaurant.json",
            fileSha256: null,
            parsedJsonFingerprint: null,
            runtimeDependencyOnOldProject: false,
          }
        : {
            project: "派活AI",
            path: "data/departments/restaurant.json",
            fileSha256: PAIHUO_RESTAURANT_SOURCE_FILE_SHA256,
            parsedJsonFingerprint: `sha256:${PAIHUO_RESTAURANT_SOURCE_JSON_FINGERPRINT}`,
            runtimeDependencyOnOldProject: false,
          },
      snapshot: structuredClone(sourceEmployee),
      fieldFingerprints: {
        manual: canonicalEmployeeFieldFingerprint(sourceEmployee.md),
        inputs: canonicalEmployeeFieldFingerprint(sourceEmployee.inputs),
        steps: canonicalEmployeeFieldFingerprint(sourceEmployee.steps),
        deliverables: canonicalEmployeeFieldFingerprint(
          sourceEmployee.deliverables,
        ),
        qualityGates: canonicalEmployeeFieldFingerprint(
          sourceEmployee.qualityGates,
        ),
        safetyBoundaries: canonicalEmployeeFieldFingerprint(
          sourceEmployee.safetyBoundaries,
        ),
      },
      projectionBoundary: {
        sourceTagline: PAIHUO_RESTAURANT_SOURCE_CATALOG.tagline,
        currentDisplayTagline: RESTAURANT_CATALOG.tagline,
        currentCatalogDisplayFix: "59位修正为60位",
        deliverableLeadInPreserved: sourceEmployee.deliverables[0] === "提供：",
        effectiveMissingArrays:
          "只允许从同一份sourceEmployee.md解析后追加，不得覆盖或冒充源数组原值。",
        legacyCapabilitiesForCount: sourceEmployee.steps.length,
        currentManualParsedCapabilityCount: sourceEmployee.steps.length
          ? 0
          : employee.steps.length,
        capabilityBoundary:
          "旧capabilities_for只读取restaurant.json.steps；源steps为空时，当前从同一源employee.md解析的工作流属于增强投影，不得冒充旧handler返回值。",
      },
    },
    work: {
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
    },
    employeeManual: {
      binding: "restaurant.json.employee.md",
      status: "snapshot_bound",
      sha256: sha256(employee.md),
      executionAuthority: "inline_manual_authoritative",
    },
    legacySafeConfig: {
      binding: "employee-skills.json.safeLegacyConfig",
      status: "allowlist_snapshot_bound",
      modelText: skillProfile.safeLegacyConfig?.modelText || null,
      modelImage: skillProfile.safeLegacyConfig?.modelImage || null,
      settings: structuredClone(skillProfile.safeLegacyConfig?.settings || {}),
    },
    legacyRuntimePolicy: "ignore_reference_read_and_execute_inline_manual",
    sourceEvidence: {
      project: "派活AI",
      path: "app/departments.py",
      lineStart: 176,
      lineEnd: 177,
      sha256:
        "36d3eaf0982f4dcabfddf1344ae062d576326ce7639ac3176d3d70c7e453d18e",
      finding:
        "旧运行时明确声明references文件不存在，忽略读取并直接执行已内联岗位手册。",
    },
    sharedReferences,
  };
}

function restaurantCurrentRuntimeBindings(employee, skillProfile) {
  const defaults = restaurantDefaultWorkConfig(skillProfile);
  const locationIntelligenceRequired = [101, 102, 104].includes(
    Number(employee.idx),
  );
  const authorizedReviewImportRequired = Number(employee.idx) === 143;
  return {
    work: {
      mode: "single_employee_dispatch",
      handler: "marshalWork",
      provenance: "current_runtime_reimplementation",
      async: true,
      outputValidation: "restaurant_output_contract",
    },
    models: {
      text: {
        route: "tenant_text_model_route",
        factoryModel: defaults.textModel,
        credentials: "server_runtime_only",
        provenance: "current_runtime_reimplementation",
      },
      vision: {
        route: "tenant_vision_model_route",
        factoryModel: defaults.visionModel,
        invocation: "only_with_image_evidence",
        credentials: "server_runtime_only",
        provenance: "current_runtime_reimplementation",
      },
    },
    webPolicy: {
      defaultMode: "required",
      cadence: "every_dispatch",
      minimumAttempts: 5,
      minimumVerifiedSources: 5,
      controlledPageFetchMinimum: 1,
      evidenceRequired: true,
      failurePolicy: "fail_task_without_business_result",
    },
    apis: [
      {
        id: "text_generation",
        binding: "tenant_text_model_route",
        credentialPolicy: "server_runtime_only",
        provenance: "current_runtime_reimplementation",
      },
      {
        id: "web_research",
        binding: "employeeAgenticWebResearch",
        invocation: "every_dispatch",
        credentialPolicy: "server_runtime_only",
        provenance: "current_runtime_reimplementation",
      },
      {
        id: "controlled_page_evidence",
        binding: "employeeControlledWebFetch",
        invocation: "after_agentic_web_research",
        credentialPolicy: "no_client_credentials",
        provenance: "current_runtime_reimplementation",
      },
      ...(locationIntelligenceRequired
        ? [
            {
              id: "location_intelligence",
              binding: "employeeLocationIntelligence",
              invocation: "every_dispatch",
              credentialPolicy: "server_runtime_only",
              provenance: "current_runtime_reimplementation",
            },
          ]
        : []),
      ...(authorizedReviewImportRequired
        ? [
            {
              id: "review_dataset_import",
              binding: "unified_file_center",
              invocation: "only_with_authorized_user_upload",
              credentialPolicy: "tenant_owner_scoped",
              provenance: "current_runtime_reimplementation",
            },
          ]
        : []),
      {
        id: "vision_understanding",
        binding: "tenant_vision_model_route",
        invocation: "only_with_image_evidence",
        credentialPolicy: "server_runtime_only",
        provenance: "current_runtime_reimplementation",
      },
    ],
    tools: [
      {
        id: "agentic_web_search",
        binding: "employeeAgenticWebResearch",
        required: true,
      },
      {
        id: "controlled_page_evidence",
        binding: "employeeControlledWebFetch",
        required: true,
      },
      {
        id: "web_search_redundancy",
        binding: "employeeWebSearch",
        required: false,
      },
      ...(locationIntelligenceRequired
        ? [
            {
              id: "location_intelligence",
              binding: "employeeLocationIntelligence",
              required: true,
            },
          ]
        : []),
      ...(authorizedReviewImportRequired
        ? [
            {
              id: "review_dataset_import",
              binding: "unified_file_center",
              required: false,
            },
          ]
        : []),
      {
        id: "knowledge_retrieval",
        binding: "tenant_kb_search",
        required: true,
      },
      {
        id: "structured_output",
        binding: "restaurant_output_contract",
        required: true,
      },
      {
        id: "internal_profile_leak_guard",
        binding: "internal_profile_leakage",
        required: true,
      },
    ],
    connectors: [
      {
        kind: "model_generation",
        status: "runtime_bound",
        handler: "marshalWork",
      },
      {
        kind: "web_research",
        status: "required_at_dispatch",
        handler: "employeeAgenticWebResearch",
      },
      {
        kind: "controlled_page_evidence",
        status: "required_after_search",
        handler: "employeeControlledWebFetch",
      },
      ...(locationIntelligenceRequired
        ? [
            {
              kind: "location_intelligence",
              status: "required_at_dispatch",
              handler: "employeeLocationIntelligence",
            },
          ]
        : []),
      ...(authorizedReviewImportRequired
        ? [
            {
              kind: "review_dataset_import",
              status: "optional_when_authorized_upload_present",
              handler: "importReviewDataset",
            },
          ]
        : []),
      {
        kind: "tenant_knowledge",
        status: "runtime_bound",
        handler: "kbSearch",
      },
    ],
  };
}

function restaurantRuntimeBindings(employee, skillProfile, sourceEmployee) {
  return {
    sourceBindings: restaurantSourceBindings(
      employee,
      skillProfile,
      sourceEmployee,
    ),
    currentRuntimeBindings: restaurantCurrentRuntimeBindings(
      employee,
      skillProfile,
    ),
    parityBoundary:
      "sourceBindings记录派活快照真正带来的岗位/模型/settings声明；currentRuntimeBindings记录新项目已经重建并验证的执行接线。两者不得混称。",
  };
}

function nativeSkillProfile(employee) {
  // 原生岗位没有派活历史技能：档案如实为空，不冒充旧快照
  return Object.freeze({
    idx: employee.idx,
    key: employee.key,
    name: employee.name,
    group: employee.group,
    department: employee.group,
    learnedAt: null,
    safeLegacyConfig: null,
    expectedSkillCount: 0,
    skills: Object.freeze([]),
  });
}

function restaurantProfile(employee) {
  const isNative = NATIVE_RESTAURANT_EMPLOYEE_IDS.has(employee.idx);
  const skillProfile = isNative
    ? nativeSkillProfile(employee)
    : sourceSkillProfile(employee.idx);
  const sourceEmployee = isNative
    ? employee
    : PAIHUO_RESTAURANT_SOURCE_BY_IDX.get(employee.idx);
  if (
    skillProfile.key !== employee.key ||
    skillProfile.name !== employee.name
  ) {
    throw new Error(`餐饮员工${employee.idx}岗位与派活技能档案错位`);
  }
  if (
    !sourceEmployee ||
    sourceEmployee.key !== employee.key ||
    sourceEmployee.name !== employee.name
  ) {
    throw new Error(`餐饮员工${employee.idx}缺少派活源员工快照`);
  }
  const group = RESTAURANT_GROUP_BY_NAME.get(employee.group);
  if (!group) throw new Error(`餐饮员工${employee.idx}分部不存在`);
  const outputContract = getRestaurantOutputContract(employee.idx);
  const capabilities = restaurantCapabilities(employee, sourceEmployee);
  const factoryDefault = restaurantDefaultWorkConfig(skillProfile);
  const requiredSkill = restaurantRequiredSkill(employee);
  const catalogSkills = historicalSkills(employee.idx);
  const requiredInputs = sourceFirstList(sourceEmployee, employee, "inputs");
  const workflowSteps = sourceFirstList(sourceEmployee, employee, "steps");
  const expectedDeliverables = sourceFirstList(
    sourceEmployee,
    employee,
    "deliverables",
  );
  const qualityStandards = sourceFirstList(
    sourceEmployee,
    employee,
    "qualityGates",
  );
  const sourceSafetyBoundaries = sourceFirstList(
    sourceEmployee,
    employee,
    "safetyBoundaries",
  );
  const safetyBoundaries = [
    ...new Set([...sourceSafetyBoundaries, ...employee.safetyBoundaries]),
  ];
  return finalizeCanonicalProfile({
    identity: {
      domain: "restaurant",
      idx: employee.idx,
      key: employee.key,
      number: employee.num,
      person: employee.person,
      name: employee.name,
      position: employee.role || employee.name,
      duty: employee.duty,
      description: employee.desc,
      intro: employee.intro,
      emoji: employee.emoji,
      color: employee.color,
      extension: employee.idx === 160,
      department: {
        code: group.code,
        name: group.name,
        emoji: group.emoji,
        color: group.color,
      },
    },
    provenance: {
      authority: "派活AI岗位与技能快照 + NanoWork当前运行重建接线",
      project: "派活AI",
      employeeCatalog: {
        path: "server/catalog/restaurant.json",
        sha256: SOURCE_HASHES.restaurantCatalog,
        manualSha256: sha256(sourceEmployee.md),
        role: "current_display_and_safe_projection",
      },
      paihuoSourceCatalog: {
        path: "data/departments/restaurant.json",
        sha256: PAIHUO_RESTAURANT_SOURCE_FILE_SHA256,
        parsedJsonFingerprint: `sha256:${PAIHUO_RESTAURANT_SOURCE_JSON_FINGERPRINT}`,
        employeeSourceFingerprint:
          canonicalEmployeeFieldFingerprint(sourceEmployee),
        runtimeDependencyOnOldProject: false,
      },
      skillCatalog: {
        path: "server/catalog/employee-skills.json",
        sha256: SOURCE_HASHES.skillsCatalog,
        sourceSnapshot: structuredClone(
          EMPLOYEE_SKILL_EVIDENCE_CATALOG.source.snapshot,
        ),
        fingerprintAlgorithm: EMPLOYEE_SKILL_FINGERPRINT_ALGORITHM,
        verificationLevel: EMPLOYEE_SKILL_VERIFICATION_LEVEL,
        effectValidation: EMPLOYEE_SKILL_EFFECT_VALIDATION,
        expectedSkillCount: skillProfile.expectedSkillCount,
      },
      noSilentFallback: true,
      sanitized: true,
      secretValuesIncluded: false,
      parity: {
        employeeDefinition:
          "source_snapshot_preserved_then_safe_projection_appended",
        employeeManual: "source_exact",
        sourceArrays:
          "source_exact_with_manual_parse_only_when_source_array_empty",
        capabilities:
          "96_legacy_capabilities_for_exact_plus_418_current_manual_workflow_enrichment",
        historicalSkills: "allowlist_snapshot",
        runtimeBindings: "current_runtime_reimplementation",
        legacyApiToolConfigurationExported: false,
      },
    },
    jobProfile: {
      employeeNumber: employee.idx,
      roleKey: employee.key,
      roleTitle: employee.role || employee.name,
      department: group.name,
      moduleGroup: group.name,
      positionSkill: requiredSkill.title,
      duty: employee.duty,
      intro: employee.intro,
      scope: "restaurant_single_employee",
      responsibilities: [employee.duty],
      useCases: [employee.desc],
      nonGoals: safetyBoundaries,
      requiredInputs,
      expectedDeliverables,
      qualityStandards,
      safetyBoundaries,
      kpis: qualityStandards.map((item) => `按岗位质量门验收：${item}`),
      authority: {
        mayDraft: true,
        mayReadTenantKnowledge: true,
        mayPublishExternally: false,
        mayCommitFinancialOrRegulatoryDecision: false,
        finalApproval: factoryDefault.approvalMode,
      },
      serviceLevel: {
        timeoutSeconds: factoryDefault.timeoutSeconds,
        outputLength: factoryDefault.outputLength,
      },
      collaborators: RESTAURANT_CATALOG.groups
        .filter((item) => item.name !== group.name)
        .map((item) => item.name),
    },
    capabilities,
    skills: {
      required: [requiredSkill],
      catalog: catalogSkills,
      learned: [],
      enabled: [requiredSkill, ...catalogSkills],
      expectedCatalogSkillCount: skillProfile.expectedSkillCount,
      injectionPolicy: {
        requiredPositionSkill: "always",
        historicalSkills: "default_on",
        historicalFactPolicy:
          "技能已完成目录与默认注入验证并锁定启用；源快照中的第三方说法、平台时效和真实业务效果仍须按当前来源与样本复核。",
      },
    },
    workMethod: {
      requiredInputs,
      steps: workflowSteps,
      deliverables: expectedDeliverables,
      qualityGates: qualityStandards,
      safetyBoundaries,
      safetyBoundarySource: employee.safetyBoundarySource,
      manualMarkdown: sourceEmployee.md,
      sourceProjection: {
        inputs: sourceEmployee.inputs.length
          ? "source_employee.inputs"
          : "source_manual.inputs_parsed",
        steps: sourceEmployee.steps.length
          ? "source_employee.steps"
          : "source_manual.workflow_parsed",
        deliverables: sourceEmployee.deliverables.length
          ? "source_employee.deliverables"
          : "source_manual.deliverables_parsed",
        safetyAdjustments: "append_only",
      },
    },
    prompts: {
      factoryManual: sourceEmployee.md,
      enterpriseOverrideMode: "append_only",
      effectiveAssembly: ["factoryManual", "enterpriseOverride"],
      outputContractInstruction: outputContract.instruction,
    },
    runtimeBindings: restaurantRuntimeBindings(
      employee,
      skillProfile,
      sourceEmployee,
    ),
    workConfig: {
      factoryDefault,
      safeLegacyConfig: structuredClone(skillProfile.safeLegacyConfig),
      legacyRoleSettings: structuredClone(
        skillProfile.safeLegacyConfig?.settings || {},
      ),
      capabilityPolicy: { required: true, enabled: true, locked: true },
      historicalSkillPolicy: {
        defaultInjected: true,
        effectValidation: EMPLOYEE_SKILL_EFFECT_VALIDATION,
      },
      editableKeys: [
        "textModel",
        "visionModel",
        "webMode",
        "knowledgeScopes",
        "outputLength",
        "timeoutSeconds",
        "approvalMode",
        "maxCost",
        "language",
      ],
    },
    contracts: {
      input: {
        required: requiredInputs,
        tenantScoped: true,
      },
      output: outputContract,
      quality: qualityStandards,
      safety: safetyBoundaries,
      approval: {
        defaultMode: factoryDefault.approvalMode,
        externalPublishRequiresHuman: true,
      },
    },
    permissions: {
      profileAudience: ["boss", "admin", "platform_super"],
      dispatchAudience: "authenticated_tenant_user",
      mayEditFactoryProfile: false,
      mayAppendEnterprisePrompt: ["boss", "admin", "platform_super"],
      mayConfigureOptionalSkills: ["boss", "admin", "platform_super"],
      mayDisableRequiredCapabilities: false,
      mayPublishExternallyWithoutHumanApproval: false,
    },
  });
}

function contentRequiredSkill(employee) {
  return {
    title: employee.skill,
    detail: `与${employee.name}岗位绑定的出厂必备 Skill；不得停用、删除或由历史技能替代。`,
    source: "content-crew.employee.skill",
    origin: "factory_position_skill",
    verificationStatus: EMPLOYEE_SKILL_OWNER_VERIFICATION_STATUS,
    required: true,
    enabled: true,
    locked: true,
    defaultInjected: true,
    currentPlatformFact: true,
  };
}

function nativeContentRequiredSkill(employee) {
  return {
    id: `required:${employee.key}`,
    title: `${employee.name}完整岗位 Skill`,
    detail: employee.workMethod.execution.skills,
    source: employee.sourceProvenance.referencePath,
    sourceUrl: null,
    version: employee.sourceProvenance.snapshotDate,
    origin: "native_factory_position_skill",
    required: true,
    enabled: true,
    locked: true,
    defaultInjected: true,
    currentPlatformFact: true,
    verificationStatus: EMPLOYEE_SKILL_OWNER_VERIFICATION_STATUS,
  };
}

function nativeContentRuntimeBindings(employee, safeLegacyConfig) {
  const connectors = structuredClone(employee.connectorPolicy.connectors).map(
    (connector) => ({
      ...connector,
      executionType: "employee_generation",
      businessEndpoint: "/api/content/ai-sales-video",
    }),
  );
  return {
    sourceBindings: {
      work: {
        legacyHandler: employee.workMethod.execution.handler,
        legacyPipelineBuilder: employee.pipelinePrompt.legacyBuilder,
        legacyMessageMode: employee.soloPrompt.messageMode,
        sourceReference: {
          project: employee.sourceProvenance.project,
          path: employee.sourceProvenance.referencePath,
          sha256: employee.sourceProvenance.referenceSha256,
          runtimeDependencyOnOldProject: false,
        },
      },
      connectors: structuredClone(employee.connectorPolicy.connectors),
      safeLegacyConfig: structuredClone(safeLegacyConfig),
    },
    currentRuntimeBindings: {
      work: {
        mode: "single_station",
        handler: "native-content-handler:ai-sales-video",
        adapter: "ai-sales-video",
        compiler: "compileContentEmployeeSoloPrompt",
        sourceHandlerReference: employee.workMethod.execution.handler,
        bindingStatus: "native_runtime_bound",
        soloMessageMode: "system_user_separated",
        provenance: "NanoWork native content employee runtime",
        execution: {
          workflow: "ai_sales_video",
          durationSeconds: 30,
          segmentDurationSeconds: 10,
          segmentCount: 3,
          defaultComposerStatus: "blocked_without_authorization",
        },
      },
      models: {
        text: {
          route: "tenant_text_model_route",
          factoryModel: safeLegacyConfig.modelText,
          credentials: "server_runtime_only",
          provenance: "current_runtime_reimplementation",
        },
        video: {
          route: "tenant_video_model_route",
          factoryModel: safeLegacyConfig.modelVideo,
          credentials: "server_runtime_only",
          provenance: "current_runtime_reimplementation",
        },
      },
      webPolicy: {
        defaultMode: "allowed",
        cadence: "when_task_requires",
        realtimeSteps: true,
        evidenceRequired: false,
      },
      apis: [
        {
          id: "text_generation",
          binding: "tenant_text_model_route",
          credentialPolicy: "server_runtime_only",
          provenance: "current_runtime_reimplementation",
        },
        {
          id: "sales_video_orchestration",
          binding: "buildAiSalesVideoPlan",
          credentialPolicy: "server_runtime_only",
          invocation: "plan_only_until_authorized",
          provenance: "native_ai_sales_video_api",
        },
      ],
      tools: connectors.map((connector) => ({
        id: connector.kind,
        binding: "ai-sales-video",
        evidenceHandlerId: `ai-sales-video.execute:${connector.kind}`,
        executionType: connector.executionType,
        businessEndpoint: connector.businessEndpoint,
        status: connector.status,
        mode: connector.mode,
        primary: connector.primary,
        addon: connector.addon,
        provenance: "native_runtime_reimplementation",
      })),
      connectors: connectors.map((connector) => ({
        kind: connector.kind,
        handler: "ai-sales-video",
        evidenceHandlerId: `ai-sales-video.execute:${connector.kind}`,
        executionType: connector.executionType,
        businessEndpoint: connector.businessEndpoint,
        status: connector.status,
        mode: connector.mode,
      })),
    },
    parityBoundary:
      "AI带货员是NanoWork原生扩展；ai-sales-video运行时负责30秒脚本、三段10秒视频与合成证据。没有供应商成功、账务结算和成片证据时必须失败或阻断，不能把计划冒充成片。",
  };
}

function nativeContentProfile(employee) {
  const requiredSkill = nativeContentRequiredSkill(employee);
  const factoryDefault = structuredClone(employee.defaultWorkConfig);
  const safeLegacyConfig = {
    modelText: factoryDefault.common.textModel || null,
    modelImage: factoryDefault.common.imageModel || null,
    modelVideo: factoryDefault.common.videoModel || null,
    settings: structuredClone(factoryDefault.roleSpecific),
  };
  const runtimeBindings = nativeContentRuntimeBindings(
    employee,
    safeLegacyConfig,
  );
  const safetyBoundaries = [
    "公开可查的门店、商品与平台信息由联网工具自动补齐，不得要求老板重复提供；企业私有价格、库存与授权事实必须按本次证据处理。",
    "脚本、字幕和三段分镜计划不等于真实视频已经生成；没有供应商成功、下载与合成证据不得返回视频URL。",
    "真实视频供应商调用、付费、下载、合成和对外发布必须写入任务、模型、用量、费用与产物证据；Boss测试会话不生成二次审批。",
    "外部发布、真实付费和不可逆动作仍受服务端执行授权边界控制；内部合格成片按中央auto策略采用但不自动发布。",
  ];
  const outputSchema = structuredClone(employee.outputSchema);
  const jobProfile = {
    employeeNumber: employee.idx,
    roleKey: employee.key,
    roleTitle: employee.name,
    department: employee.group,
    moduleGroup: employee.moduleGroup,
    positionSkill: employee.skill,
    duty: employee.duty,
    intro: employee.intro,
    responsibilities: [employee.duty],
    useCases: [
      "一句带货目标 + 真实图片 → 事实白名单、30秒脚本、字幕、三段分镜与成片状态",
    ],
    scope: "native_single_station",
    requiredInputs: ["一句带货目标", "至少一张人物、菜品/商品或门店参考图片"],
    expectedDeliverables: [
      "事实白名单与企业私有事实缺口",
      "30秒口播稿与字幕",
      "三段10秒分镜计划",
      "视频供应商、模型、用量、费用、下载和合成证据或明确失败原因",
    ],
    qualityStandards: [
      employee.workMethod.execution.capabilities,
      employee.workMethod.execution.skills,
      `输出必须符合${outputSchema.format}契约并覆盖全部原生字段`,
      "内部合格产物按中央auto策略采用；不得自动发布",
    ],
    safetyBoundaries,
    boundaries: safetyBoundaries,
    nonGoals: [
      "不把脚本、分镜或阻断计划描述成真实视频成片",
      "不把公开视频资料重新变成老板必填项",
      "不自动发布、发送、投放或操作外部账号",
    ],
    collaborators: [employee.workMethod.handoff.target].filter(Boolean),
    outputKeys: structuredClone(employee.outputKeys),
    outputSchema,
    connectorPolicy: structuredClone(employee.connectorPolicy),
    serviceLevel: {
      webRequired: employee.workMethod.execution.webRequired,
      realtimeSteps: employee.workMethod.execution.realtimeSteps,
      approval: structuredClone(employee.workMethod.approval),
      handoff: structuredClone(employee.workMethod.handoff),
    },
    authority: {
      mayDraft: false,
      mayUseDefaultInjectedSkills: true,
      mayTreatNativePlanAsCompletedVideo: false,
      mayPublishExternallyWithoutHumanApproval: false,
      mayTriggerPaidActionWithoutHumanApproval: false,
      approvalCode: "central_auto",
      approvalDescription: "质量门与账务门通过后内部自动采用；不自动发布。",
    },
  };
  return finalizeCanonicalProfile({
    identity: {
      domain: "content",
      idx: employee.idx,
      key: employee.key,
      person: employee.person,
      name: employee.name,
      group: employee.group,
      moduleGroup: employee.moduleGroup,
      positionSkill: employee.skill,
      emoji: employee.emoji,
      color: employee.color,
      duty: employee.duty,
      intro: employee.intro,
      optional: employee.optional,
      department: {
        key: "content",
        name: "内容生产部",
        group: employee.group,
        moduleGroup: employee.moduleGroup,
      },
    },
    provenance: {
      authority: "NanoWork原生AI带货员岗位 + 当前ai-sales-video安全编排接线",
      project: "NanoWork当前项目",
      employee: structuredClone(employee.sourceProvenance),
      contentCatalog: {
        schemaVersion: "nanowork.native-content-employee/1",
        referencePath: employee.sourceProvenance.referencePath,
        referenceSha256: employee.sourceProvenance.referenceSha256,
        sourceBoundary: employee.sourceProvenance.sourceBoundary,
      },
      historicalSkills: {
        schemaVersion: "native-content-skills/1",
        expectedSkillCount: 0,
        snapshot: null,
        note: "原生岗位没有Paihuo历史技能快照；当前岗位必备Skill已锁定注入。",
      },
      noDatabaseDependency: true,
      noSilentFallback: true,
      sanitized: true,
      secretValuesIncluded: false,
      parity: {
        employeeDefinition: "native_project_extension",
        historicalSkills: "none",
        legacyHandlers: "source_reference_only",
        runtimeBindings: "native_runtime_reimplementation",
        aiSalesVideoApi:
          "buildAiSalesVideoPlan + executeAiSalesVideoPlan contract",
      },
    },
    jobProfile,
    capabilities: structuredClone(employee.capabilities),
    skills: {
      required: [requiredSkill],
      catalog: [],
      learned: [],
      enabled: [requiredSkill],
      expectedCatalogSkillCount: 0,
      injectionPolicy: {
        requiredPositionSkill: "always",
        historicalSkills: "none",
        historicalFactPolicy:
          "原生岗位只注入当前岗位必备Skill；外部平台规则、价格、效果和业务事实必须按本次证据核验。",
      },
    },
    workMethod: structuredClone(employee.workMethod),
    prompts: {
      systemPrompt: structuredClone(employee.systemPrompt),
      pipelinePrompt: structuredClone(employee.pipelinePrompt),
      soloPrompt: structuredClone(employee.soloPrompt),
      placeholders: structuredClone(employee.placeholders),
      interpolationPolicy: {
        mode: "no_static_expansion",
        reason:
          "原生岗位保留模板占位符原文；租户事实、附件和授权配置只能由运行层显式提供。",
        sensitivePlaceholdersExpanded: false,
      },
    },
    runtimeBindings,
    workConfig: {
      factoryDefault,
      safeLegacyConfig,
      legacyRoleSettings: structuredClone(factoryDefault.roleSpecific),
      capabilityPolicy: { required: true, enabled: true, locked: true },
      historicalSkillPolicy: {
        requiredPositionSkill: "always",
        historicalSkills: "none",
        historicalVerificationStatus: "native_verified",
      },
      editableKeys: [
        "textModel",
        "videoModel",
        "outputLength",
        "approvalMode",
        "timeoutSeconds",
        "language",
      ],
    },
    contracts: {
      input: structuredClone(employee.dispatchForm),
      output: outputSchema,
      quality: {
        capabilities: employee.workMethod.execution.capabilities,
        skills: employee.workMethod.execution.skills,
      },
      approval: {
        code: "central_auto",
        mode: "auto",
        description: "质量门与账务门通过后内部自动采用；不自动发布。",
        executionAuthorization:
          "外部发布、真实付费和不可逆动作仍须老板执行授权。",
      },
      handoff: structuredClone(employee.workMethod.handoff),
      connectors: structuredClone(employee.connectorPolicy),
    },
    permissions: structuredClone(employee.permissions),
  });
}

const CONTENT_INTERNAL_ADOPTION_POLICY = Object.freeze({
  code: "central_auto",
  mode: "auto",
  description:
    "普通内部产出通过岗位质量门与账务结算后按企业中央策略自动采用；不创建内容审核，也不代表已对外执行。",
  executionAuthorization:
    "对外发布、真实付费和不可逆动作须先取得老板执行授权；该节点不是内容审核。",
});

function currentContentWorkMethod(employee) {
  return {
    ...structuredClone(employee.workMethod),
    approval: structuredClone(CONTENT_INTERNAL_ADOPTION_POLICY),
  };
}

function currentContentConnectorPolicy(employee) {
  const source = structuredClone(employee.connectorPolicy);
  return {
    ...source,
    executionBoundary:
      "连接器只执行已接线的内部生成或辅助能力；普通内部产出依中央策略自动采用。对外发布、真实付费和不可逆动作仍需老板执行授权。",
    connectors: source.connectors.map((connector) => {
      const { humanApproval: _legacyHumanApproval, ...requirements } =
        connector.requirements;
      return {
        ...connector,
        requirements: {
          ...requirements,
          adoptionPolicy: "central_auto_internal",
          executionAuthorization: "external_paid_irreversible_only",
        },
        executeBoundary: String(connector.executeBoundary || "")
          .replaceAll("人工复核", "岗位质量门")
          .replaceAll("人工审核", "中央采用策略")
          .replaceAll("老板审批", "中央采用策略")
          .replaceAll("人类审批", "老板执行授权"),
      };
    }),
  };
}

function contentJobProfile(employee) {
  const effectiveApproval = structuredClone(CONTENT_INTERNAL_ADOPTION_POLICY);
  const connectorPolicy = currentContentConnectorPolicy(employee);
  const requiredInputs = [
    ...new Set(
      [
        employee.workMethod.input.upstream,
        ...(employee.workMethod.input.context || []),
      ].filter(Boolean),
    ),
  ];
  const expectedDeliverables = [
    employee.workMethod.output.duty,
    ...(employee.workMethod.output.keys || []).map((key) => `输出字段：${key}`),
  ].filter(Boolean);
  const safetyBoundaries = [
    "单独派活只代表当前岗位运行，不冒充十工位流水线已经自动执行。",
    "不得声称已经完成实际未发生的联网、发布、账号操作或其他外部执行。",
    "对外发布、账号操作、真实付费、采购、合同、监管判断及其他不可逆动作必须先取得老板执行授权；该节点不是内容审核。",
    "已验证并默认启用的技能可直接作为执行方法；涉及时效、规则、价格、政策或外部数据时仍必须按当前来源重新核验。",
  ];
  return {
    employeeNumber: employee.idx,
    roleKey: employee.key,
    roleTitle: employee.name,
    department: employee.group,
    moduleGroup: employee.moduleGroup,
    positionSkill: employee.skill,
    duty: employee.duty,
    intro: employee.intro,
    responsibilities: [employee.duty],
    useCases: [`以${employee.name}身份执行单工位专项交付`],
    scope: "single_station",
    requiredInputs,
    expectedDeliverables,
    qualityStandards: [
      employee.workMethod.execution.capabilities,
      employee.workMethod.execution.skills,
      `输出必须符合${employee.outputSchema.format}契约并覆盖全部原生字段`,
      effectiveApproval.description,
    ],
    safetyBoundaries,
    boundaries: safetyBoundaries,
    nonGoals: [
      "不把本岗位一次派活描述成完整内容流水线已自动完成",
      "不绕过老板执行授权对外发布、真实付费或执行不可逆动作",
      "不把目录中的连接器说明冒充实际已经发生的外部调用",
    ],
    collaborators: [employee.workMethod.handoff.target].filter(Boolean),
    outputKeys: structuredClone(employee.outputKeys),
    outputSchema: structuredClone(employee.outputSchema),
    connectorPolicy,
    serviceLevel: {
      webRequired: employee.workMethod.execution.webRequired,
      realtimeSteps: employee.workMethod.execution.realtimeSteps,
      approval: effectiveApproval,
      handoff: structuredClone(employee.workMethod.handoff),
    },
    authority: {
      mayDraft: true,
      mayUseDefaultInjectedSkills: true,
      mayTreatLegacySkillAsCurrentFact: false,
      mayPublishExternallyWithoutHumanApproval: false,
      mayTriggerIrreversibleActionWithoutHumanApproval: false,
      approvalCode: effectiveApproval.code,
      approvalDescription: effectiveApproval.description,
      executionAuthorization: effectiveApproval.executionAuthorization,
    },
  };
}

function contentWorkConfig(employee, skillProfile) {
  const requiredSkill = contentRequiredSkill(employee);
  const factoryDefault = structuredClone(employee.defaultWorkConfig);
  factoryDefault.common = {
    ...factoryDefault.common,
    skillVerificationStatus: EMPLOYEE_SKILL_OWNER_VERIFICATION_STATUS,
    approvalMode: "auto",
  };
  return {
    factoryDefault,
    safeLegacyConfig: structuredClone(skillProfile.safeLegacyConfig),
    legacyRoleSettings: structuredClone(
      skillProfile.safeLegacyConfig?.settings || {},
    ),
    capabilityPolicy: {
      required: true,
      enabled: true,
      locked: true,
    },
    historicalSkillPolicy: {
      requiredPositionSkill: "always",
      historicalSkills: "default_on",
      historicalVerificationStatus: EMPLOYEE_SKILL_OWNER_VERIFICATION_STATUS,
      historicalFactPolicy:
        "技能已完成目录与默认注入验证并锁定启用；源快照中的第三方说法、平台时效和真实业务效果仍须用当前来源与业务样本复核。",
      requiredSkill: requiredSkill.title,
    },
  };
}

function contentPrompts(employee) {
  return {
    systemPrompt: structuredClone(employee.systemPrompt),
    pipelinePrompt: structuredClone(employee.pipelinePrompt),
    soloPrompt: structuredClone(employee.soloPrompt),
    placeholders: structuredClone(employee.placeholders),
    interpolationPolicy: {
      mode: "no_static_expansion",
      reason:
        "静态编译层保留旧模板占位符原文；租户知识、运行时材料和敏感配置只能由授权运行层显式提供。",
      sensitivePlaceholdersExpanded: false,
    },
  };
}

// 该映射必须与生产内容路由保持一致，但不能反向 import content-connectors：
// content-connectors -> content-employee-workbench -> canonical 会形成循环依赖。
const CONTENT_EMPLOYEE_GENERATION_ENDPOINTS = Object.freeze({
  copy: "/api/content/generate",
  dailyPack: "/api/content/daily-pack",
  image: "/api/content/generate-image",
  video: "/api/content/generate-video",
  ppt: "/api/content/generate-ppt",
});

function contentConnectorBusinessEndpoint(employeeIdx, connector) {
  if (connector.mode === "employee_generation") {
    const endpoint = CONTENT_EMPLOYEE_GENERATION_ENDPOINTS[connector.kind];
    if (!endpoint) {
      throw new Error(
        `内容员工${employeeIdx}连接器${connector.kind}缺少生产生成入口`,
      );
    }
    return endpoint;
  }
  return `/api/employee-workbench/content/${employeeIdx}/connectors/${connector.kind}/execute`;
}

function contentRuntimeBindings(employee, workConfig) {
  const connectors = structuredClone(employee.connectorPolicy.connectors);
  const safe = workConfig.safeLegacyConfig;
  const handlerAdapter = CONTENT_HANDLER_ADAPTER_BY_IDX.get(employee.idx);
  if (
    !handlerAdapter ||
    handlerAdapter.legacyHandler !== employee.workMethod.execution.handler
  ) {
    throw new Error(`内容员工${employee.idx}缺少与派活handler一致的当前适配器`);
  }
  const connectorRuntimeBindings = connectors.map((connector) => ({
    ...connector,
    executionType:
      connector.mode === "employee_generation"
        ? "employee_generation"
        : "local_connector",
    businessEndpoint: contentConnectorBusinessEndpoint(employee.idx, connector),
  }));
  return {
    sourceBindings: {
      work: {
        legacyHandler: employee.workMethod.execution.handler,
        legacyPipelineBuilder: employee.pipelinePrompt.legacyBuilder,
        legacyMessageMode: employee.soloPrompt.messageMode,
        sourceReference: structuredClone(handlerAdapter.sourceReference),
      },
      connectors,
      safeLegacyConfig: structuredClone(safe),
    },
    currentRuntimeBindings: {
      work: {
        mode: "single_station",
        handler: handlerAdapter.handlerId,
        adapter: handlerAdapter.currentAdapter,
        compiler: "compileContentEmployeeSoloPrompt",
        sourceHandlerReference: handlerAdapter.legacyHandler,
        bindingStatus: handlerAdapter.bindingStatus,
        soloMessageMode: "system_user_separated",
        provenance: handlerAdapter.provenance,
        execution: structuredClone(handlerAdapter.execution),
      },
      models: {
        text: {
          route: "tenant_text_model_route",
          factoryModel: safe.modelText,
          credentials: "server_runtime_only",
          provenance: "current_runtime_reimplementation",
        },
        image: {
          route: "tenant_image_model_route",
          factoryModel: safe.modelImage,
          credentials: "server_runtime_only",
          provenance: "current_runtime_reimplementation",
        },
      },
      webPolicy: {
        defaultMode: employee.workMethod.execution.webRequired
          ? "required"
          : "allowed",
        cadence: employee.workMethod.execution.webRequired
          ? "every_dispatch"
          : "when_task_requires",
        realtimeSteps: employee.workMethod.execution.realtimeSteps,
        evidenceRequired: employee.workMethod.execution.webRequired,
      },
      apis: [
        {
          id: "text_generation",
          binding: "tenant_text_model_route",
          credentialPolicy: "server_runtime_only",
          provenance: "current_runtime_reimplementation",
        },
        ...(safe.modelImage || employee.idx === 5 || employee.idx === 6
          ? [
              {
                id: "image_generation",
                binding: "tenant_image_model_route",
                credentialPolicy: "server_runtime_only",
                provenance: "current_runtime_reimplementation",
              },
            ]
          : []),
      ],
      tools: connectorRuntimeBindings.map((connector) => ({
        id: connector.kind,
        binding: "executeContentConnector",
        evidenceHandlerId: `content-connectors.execute:${connector.kind}`,
        sourceHandlerReference: connector.legacyHandler,
        executionType: connector.executionType,
        businessEndpoint: connector.businessEndpoint,
        status: connector.status,
        mode: connector.mode,
        primary: connector.primary,
        addon: connector.addon,
        provenance: "current_runtime_reimplementation",
      })),
      connectors: connectorRuntimeBindings.map((connector) => ({
        kind: connector.kind,
        handler: "executeContentConnector",
        evidenceHandlerId: `content-connectors.execute:${connector.kind}`,
        executionType: connector.executionType,
        businessEndpoint: connector.businessEndpoint,
        status: connector.status,
        mode: connector.mode,
      })),
    },
    parityBoundary:
      "legacyHandler只作为派活源代码引用保留；当前handler由content-handler-adapters.invoke适配并由compileContentEmployeeSoloPrompt编译，connector由executeContentConnector执行，不能宣称旧Python handler被直接调用。",
  };
}

function contentProfile(employee) {
  const skillProfile = sourceSkillProfile(employee.idx);
  if (
    skillProfile.key !== employee.key ||
    skillProfile.name !== employee.name
  ) {
    throw new Error(`内容员工${employee.idx}岗位与派活技能档案错位`);
  }
  const requiredSkill = contentRequiredSkill(employee);
  const catalogSkills = historicalSkills(employee.idx).map((skill) => ({
    ...skill,
    locked: true,
  }));
  const workConfig = contentWorkConfig(employee, skillProfile);
  const outputSchema = structuredClone(employee.outputSchema);
  return finalizeCanonicalProfile({
    identity: {
      domain: "content",
      idx: employee.idx,
      key: employee.key,
      person: employee.person,
      name: employee.name,
      group: employee.group,
      moduleGroup: employee.moduleGroup,
      positionSkill: employee.skill,
      emoji: employee.emoji,
      color: employee.color,
      duty: employee.duty,
      intro: employee.intro,
      optional: employee.optional,
      department: {
        key: CONTENT_CREW.department.key,
        name: CONTENT_CREW.department.name,
        group: employee.group,
        moduleGroup: employee.moduleGroup,
      },
    },
    provenance: {
      authority: "派活AI内容工位与技能快照 + NanoWork当前运行重建接线",
      project: "派活AI",
      employee: structuredClone(employee.sourceProvenance),
      contentCatalog: {
        schemaVersion: CONTENT_CREW.schemaVersion,
        referencePath: CONTENT_CREW.source.referencePath,
        referenceSha256: CONTENT_CREW.source.referenceSha256,
      },
      historicalSkills: {
        schemaVersion: EMPLOYEE_SKILL_EVIDENCE_CATALOG.schemaVersion,
        evidenceSchemaVersion:
          EMPLOYEE_SKILL_EVIDENCE_CATALOG.verificationEvidence.schemaVersion,
        verificationLevel: EMPLOYEE_SKILL_VERIFICATION_LEVEL,
        proves: structuredClone(
          EMPLOYEE_SKILL_EVIDENCE_CATALOG.verificationEvidence.policy.proves,
        ),
        doesNotProve: structuredClone(
          EMPLOYEE_SKILL_EVIDENCE_CATALOG.verificationEvidence.policy
            .doesNotProve,
        ),
        profileIdx: skillProfile.idx,
        expectedSkillCount: skillProfile.expectedSkillCount,
        snapshot: structuredClone(
          EMPLOYEE_SKILL_EVIDENCE_CATALOG.source.snapshot,
        ),
      },
      noDatabaseDependency: true,
      noSilentFallback: true,
      employeeCatalog: {
        path: "server/catalog/content-crew.json",
        sha256: SOURCE_HASHES.contentCatalog,
        legacyReferenceSha256: employee.sourceProvenance.referenceSha256,
      },
      skillCatalog: {
        path: "server/catalog/employee-skills.json",
        sha256: SOURCE_HASHES.skillsCatalog,
        expectedSkillCount: catalogSkills.length,
      },
      sanitized: true,
      secretValuesIncluded: false,
      parity: {
        employeeDefinition: "imported_snapshot",
        historicalSkills: "allowlist_snapshot",
        legacyHandlers: "source_reference_only",
        runtimeBindings: "current_runtime_reimplementation",
      },
    },
    jobProfile: contentJobProfile(employee),
    capabilities: structuredClone(employee.capabilities),
    skills: {
      required: [requiredSkill],
      catalog: structuredClone(catalogSkills),
      learned: [],
      enabled: [requiredSkill, ...structuredClone(catalogSkills)],
      expectedCatalogSkillCount: catalogSkills.length,
      injectionPolicy: structuredClone(workConfig.historicalSkillPolicy),
    },
    workMethod: currentContentWorkMethod(employee),
    prompts: contentPrompts(employee),
    runtimeBindings: contentRuntimeBindings(employee, workConfig),
    workConfig,
    contracts: {
      input: structuredClone(employee.dispatchForm),
      output: outputSchema,
      quality: {
        capabilities: employee.workMethod.execution.capabilities,
        skills: employee.workMethod.execution.skills,
      },
      approval: structuredClone(CONTENT_INTERNAL_ADOPTION_POLICY),
      handoff: structuredClone(employee.workMethod.handoff),
      connectors: structuredClone(employee.connectorPolicy),
    },
    permissions: {
      profileAudience: ["boss", "admin", "platform_super"],
      dispatchAudience: "authenticated_tenant_user",
      mayEditFactoryProfile: false,
      mayDisableRequiredCapabilities: false,
      mayTreatHistoricalSkillAsCurrentFact: false,
      mayPublishExternallyWithoutHumanApproval: false,
      approvalCode: CONTENT_INTERNAL_ADOPTION_POLICY.code,
    },
  });
}

const CONTENT_CANONICAL_PROFILES = CONTENT_EMPLOYEE_ROSTER.map((employee) =>
  employee.idx === 10
    ? nativeContentProfile(employee)
    : contentProfile(employee),
);
const RESTAURANT_CANONICAL_PROFILES =
  RESTAURANT_CATALOG.employees.map(restaurantProfile);

export const CANONICAL_EMPLOYEE_PROFILES = deepFreeze([
  ...CONTENT_CANONICAL_PROFILES,
  ...RESTAURANT_CANONICAL_PROFILES,
]);

const CANONICAL_BY_KEY = new Map(
  CANONICAL_EMPLOYEE_PROFILES.map((profile) => [
    `${profile.identity.domain}:${profile.identity.idx}`,
    profile,
  ]),
);

export function canonicalEmployeeProfileFor(domain, idx) {
  const key = `${domain}:${Number(idx)}`;
  const profile = CANONICAL_BY_KEY.get(key);
  if (!profile)
    throw Object.assign(new Error(`统一员工对象不存在：${key}`), {
      status: 404,
    });
  return profile;
}

export function canonicalRestaurantEmployeeProfileFor(idx) {
  return canonicalEmployeeProfileFor("restaurant", idx);
}

export function canonicalContentEmployeeProfileFor(idx) {
  return canonicalEmployeeProfileFor("content", idx);
}

export function canonicalEmployeeProfileSummary() {
  return deepFreeze({
    employeeCount: CANONICAL_EMPLOYEE_PROFILES.length,
    contentEmployeeCount: CONTENT_CANONICAL_PROFILES.length,
    restaurantEmployeeCount: RESTAURANT_CANONICAL_PROFILES.length,
    catalogSkillCount: CANONICAL_EMPLOYEE_PROFILES.reduce(
      (total, profile) => total + profile.skills.catalog.length,
      0,
    ),
    sourceHashes: structuredClone(SOURCE_HASHES),
  });
}

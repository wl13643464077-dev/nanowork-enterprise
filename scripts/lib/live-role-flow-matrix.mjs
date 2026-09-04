import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createPrivateArtifact, windowsAclFingerprints } from "../../server/src/engines/private-artifact.js";

export const LIVE_ROLE_FLOW_MATRIX_SCHEMA = "nanowork.live-role-flow-matrix.v2";
export const LIVE_ROLE_FLOW_ISOLATION_MARKER =
  "LIVE_ROLE_FLOW_MATRIX_ISOLATED_V2";
export const LIVE_ROLE_FLOW_CHECKPOINT_SCHEMA =
  "nanowork.live-role-flow-matrix-checkpoint.v1";

const ROLE_LANES = Object.freeze({
  boss: Object.freeze(["boss"]),
  management: Object.freeze(["ops_director", "manager"]),
  employee: Object.freeze(["staff", "sales"]),
});

const CREDENTIAL_ROLES = Object.freeze(["boss", "management", "employee"]);
const SECRET_KEY_RE =
  /(?:authorization|cookie|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session|credential|private[_-]?key)/iu;
const SECRET_VALUE_RE =
  /(?:\bsk-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/giu;

export const LIVE_ROLE_FLOW_PLAN = Object.freeze([
  Object.freeze({
    id: "human_task_hierarchy",
    label: "普通人工任务：老板→管理层→员工拆解、驳回、重提、验收",
    actors: Object.freeze(["boss", "management", "employee"]),
    requiresCloudAi: false,
    positiveFlow: Object.freeze([
      "boss_dispatch_parent",
      "management_accept_parent",
      "management_split_child",
      "employee_accept_child",
      "employee_submit_child",
      "management_reject_child",
      "employee_resubmit_child",
      "management_accept_child",
      "management_submit_parent",
      "boss_accept_parent",
    ]),
    forbiddenFlow: Object.freeze([
      "employee_dispatch_to_management",
      "management_execute_for_employee",
      "employee_review_own_submission",
      "management_review_own_parent",
    ]),
    evidence: Object.freeze([
      "tasks",
      "task_submissions",
      "notifications",
      "op_logs",
    ]),
  }),
  Object.freeze({
    id: "restaurant_employee",
    label: "餐饮数字员工：真实派活、轮询、权限拒绝、人工采纳",
    actors: Object.freeze(["management", "employee", "boss"]),
    requiresCloudAi: true,
    positiveFlow: Object.freeze([
      "management_dispatch",
      "management_poll_status",
      "boss_adopt",
    ]),
    forbiddenFlow: Object.freeze(["employee_review"]),
    evidence: Object.freeze([
      "agent_tasks",
      "credit_holds",
      "credit_logs",
      "contents",
      "approvals",
      "biz_assets",
      "kb_docs",
      "notifications",
      "op_logs",
    ]),
  }),
  Object.freeze({
    id: "content_employee",
    label: "Paihuo 内容员工：真实派活、轮询、权限拒绝、人工采纳",
    actors: Object.freeze(["employee", "boss"]),
    requiresCloudAi: true,
    positiveFlow: Object.freeze([
      "employee_dispatch",
      "employee_poll_status",
      "boss_adopt",
    ]),
    forbiddenFlow: Object.freeze(["employee_self_review"]),
    evidence: Object.freeze([
      "content_employee_runs",
      "credit_holds",
      "credit_logs",
      "materials",
      "contents",
      "approvals",
      "biz_assets",
      "notifications",
      "op_logs",
    ]),
  }),
]);

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanCredentialPart(value, label, max, { trim = true } = {}) {
  if (typeof value !== "string") throw new Error(`${label}必须是字符串`);
  const cleaned = trim ? value.trim() : value;
  if (!(trim ? cleaned : cleaned.trim())) throw new Error(`${label}不能为空`);
  if (cleaned.length > max) throw new Error(`${label}长度超过限制`);
  if (/[\u0000\r\n]/u.test(cleaned)) throw new Error(`${label}包含非法字符`);
  return cleaned;
}

export function parseCredentialsFromStdin(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 16_384) {
    throw new Error("stdin 凭据必须是不超过16KB的JSON文本");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("stdin 凭据不是合法JSON");
  }
  if (!plainObject(parsed)) throw new Error("stdin 凭据必须是JSON对象");
  const extras = Object.keys(parsed).filter(
    (key) => !CREDENTIAL_ROLES.includes(key),
  );
  if (extras.length)
    throw new Error(`stdin 凭据包含未知角色：${extras.join("、")}`);
  const output = {};
  for (const role of CREDENTIAL_ROLES) {
    const credential = parsed[role];
    if (!plainObject(credential)) throw new Error(`${role}凭据必须是对象`);
    const credentialExtras = Object.keys(credential).filter(
      (key) => !["username", "password"].includes(key),
    );
    if (credentialExtras.length) {
      throw new Error(
        `${role}凭据包含未知字段：${credentialExtras.join("、")}`,
      );
    }
    output[role] = {
      username: cleanCredentialPart(
        credential.username,
        `${role}.username`,
        100,
      ),
      password: cleanCredentialPart(
        credential.password,
        `${role}.password`,
        512,
        { trim: false },
      ),
    };
  }
  const usernames = Object.values(output).map((item) =>
    item.username.toLocaleLowerCase("en-US"),
  );
  if (new Set(usernames).size !== CREDENTIAL_ROLES.length) {
    throw new Error("老板、管理层和普通员工必须使用三个不同账号");
  }
  return output;
}

export function roleMatchesLiveLane(lane, actualRole) {
  return ROLE_LANES[lane]?.includes(String(actualRole || "")) === true;
}

const WORKBENCH_KEYS = Object.freeze([
  "capabilities",
  "dispatch",
  "identity",
  "jobProfile",
  "permissions",
  "prompts",
  "provenance",
  "runtime",
  "runtimeBindings",
  "skillLibrary",
  "workConfig",
  "workMethod",
]);

function assertWorkbenchTopLevel(profile, label) {
  assert.ok(plainObject(profile), `${label}工作台响应不是对象`);
  assert.deepEqual(
    Object.keys(profile).sort(),
    [...WORKBENCH_KEYS].sort(),
    `${label}工作台顶层契约不一致`,
  );
}

const PROFILE_VIEW_PERMISSIONS = Object.freeze([
  "canViewInternalProfile",
  "canViewCapabilities",
  "canViewSkills",
  "canViewPrompt",
  "canViewWorkMethod",
  "canViewWorkConfig",
  "canViewJobProfile",
  "canViewRuntimeBindings",
]);
const PROFILE_EDIT_PERMISSIONS = Object.freeze([
  "canEditPrompt",
  "canEditConfig",
  "canEditSkills",
]);

function assertExactKeys(value, expected, label) {
  assert.ok(plainObject(value), `${label}必须是对象`);
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label}字段不符合脱敏契约`,
  );
}

function assertNonEmptyText(value, label) {
  assert.ok(String(value || "").trim().length > 0, `${label}不能为空`);
}

function assertNonEmptyArray(value, label) {
  assert.ok(Array.isArray(value) && value.length > 0, `${label}必须是非空数组`);
}

function assertSha256(value, label) {
  assert.match(String(value || ""), /^[a-f0-9]{64}$/u, `${label}不是SHA-256`);
}

function assertCompleteRestaurantProfile(profile) {
  assertExactKeys(
    profile.identity,
    [
      "idx",
      "key",
      "person",
      "name",
      "position",
      "duty",
      "description",
      "intro",
      "emoji",
      "extension",
      "specialistId",
      "department",
    ],
    "restaurant.identity",
  );
  assertExactKeys(
    profile.workMethod,
    [
      "requiredInputs",
      "steps",
      "deliverables",
      "qualityGates",
      "safetyBoundaries",
      "safetyBoundarySource",
      "manualMarkdown",
    ],
    "restaurant.workMethod",
  );
  assertExactKeys(
    profile.skillLibrary,
    ["required", "optional", "learned", "enabled", "catalogStatus", "catalogHash"],
    "restaurant.skillLibrary",
  );
  assertExactKeys(
    profile.prompts,
    [
      "defaultTemplate",
      "override",
      "overrideTemplate",
      "effectiveTemplate",
      "hash",
      "effectiveHash",
      "revision",
      "overrideMode",
      "redacted",
      "boundary",
    ],
    "restaurant.prompts",
  );
  assertExactKeys(
    profile.workConfig,
    [
      "textModel",
      "visionModel",
      "webMode",
      "knowledgeScopes",
      "outputLength",
      "timeoutSeconds",
      "approvalMode",
      "maxCost",
      "language",
      "tenantScoped",
      "fields",
      "values",
      "version",
      "boundary",
    ],
    "restaurant.workConfig",
  );
  assertExactKeys(
    profile.runtime,
    [
      "status",
      "runs",
      "completedRuns",
      "reviewPendingRuns",
      "reconciliationPendingRuns",
      "runningTasks",
      "recentTasks",
      "taskPage",
      "lastTask",
    ],
    "restaurant.runtime",
  );
  assertExactKeys(
    profile.dispatch,
    [
      "endpoint",
      "taskTypes",
      "types",
      "defaultTaskType",
      "defaultType",
      "requirementMaxChars",
      "selectedSpecialistId",
      "requiredInputs",
      "guidance",
      "available",
      "enabled",
      "lockedCapabilityCount",
      "snapshotNotice",
    ],
    "restaurant.dispatch",
  );
  for (const [field, value] of [
    ["identity.name", profile.identity?.name],
    ["identity.duty", profile.identity?.duty],
    ["identity.description", profile.identity?.description],
    ["workMethod.manualMarkdown", profile.workMethod?.manualMarkdown],
    ["workConfig.version", profile.workConfig?.version],
    ["workConfig.boundary", profile.workConfig?.boundary],
    ["jobProfile.roleKey", profile.jobProfile?.roleKey],
    ["jobProfile.roleTitle", profile.jobProfile?.roleTitle],
    ["jobProfile.duty", profile.jobProfile?.duty],
    ["jobProfile.profileVersion", profile.jobProfile?.profileVersion],
    ["jobProfile.source", profile.jobProfile?.source],
    ["provenance.profileVersion", profile.provenance?.profileVersion],
    ["provenance.catalogHash", profile.provenance?.catalogHash],
  ]) {
    assertNonEmptyText(value, `restaurant.${field}`);
  }
  for (const [field, value] of [
    ["workMethod.requiredInputs", profile.workMethod?.requiredInputs],
    ["workMethod.steps", profile.workMethod?.steps],
    ["workMethod.deliverables", profile.workMethod?.deliverables],
    ["workMethod.qualityGates", profile.workMethod?.qualityGates],
    ["workMethod.safetyBoundaries", profile.workMethod?.safetyBoundaries],
    ["skillLibrary.required", profile.skillLibrary?.required],
    ["skillLibrary.enabled", profile.skillLibrary?.enabled],
    ["workConfig.fields", profile.workConfig?.fields],
    ["jobProfile.responsibilities", profile.jobProfile?.responsibilities],
    ["jobProfile.requiredInputs", profile.jobProfile?.requiredInputs],
    ["jobProfile.expectedDeliverables", profile.jobProfile?.expectedDeliverables],
    ["jobProfile.qualityStandards", profile.jobProfile?.qualityStandards],
    ["jobProfile.safetyBoundaries", profile.jobProfile?.safetyBoundaries],
  ]) {
    assertNonEmptyArray(value, `restaurant.${field}`);
  }
  assert.ok(plainObject(profile.workConfig?.values), "restaurant.workConfig.values缺失");
  assert.ok(Object.keys(profile.workConfig.values).length > 0, "restaurant.workConfig.values为空");
  assert.ok(plainObject(profile.jobProfile?.authority), "restaurant.jobProfile.authority缺失");
  assert.ok(plainObject(profile.jobProfile?.outputContract), "restaurant.jobProfile.outputContract缺失");
  assert.ok(plainObject(profile.jobProfile?.outputSchema), "restaurant.jobProfile.outputSchema缺失");
  assert.equal(profile.skillLibrary.catalogStatus, "loaded");
  assert.equal(profile.skillLibrary.required.length, 1);
  for (const capability of profile.capabilities) {
    assertNonEmptyText(capability?.id, "restaurant.capability.id");
    assertNonEmptyText(capability?.name, "restaurant.capability.name");
    assertNonEmptyText(capability?.description, "restaurant.capability.description");
    assertNonEmptyText(capability?.source, "restaurant.capability.source");
    assert.ok(Number(capability?.order) > 0, "restaurant.capability.order无效");
  }
  const requiredSkill = profile.skillLibrary.required[0];
  for (const key of ["id", "title", "detail", "instructions", "source", "version", "origin"]) {
    assertNonEmptyText(requiredSkill?.[key], `restaurant.requiredSkill.${key}`);
  }
  assert.equal(requiredSkill.required, true);
  assert.equal(requiredSkill.enabled, true);
  assert.equal(requiredSkill.locked, true);
  assertSha256(profile.skillLibrary.catalogHash, "restaurant.skillLibrary.catalogHash");
  assertSha256(profile.prompts.hash, "restaurant.prompts.hash");
  assertSha256(profile.prompts.effectiveHash, "restaurant.prompts.effectiveHash");
  assert.equal(profile.prompts.overrideMode, "append_only");
  assert.ok(Number.isSafeInteger(Number(profile.prompts.revision)) && Number(profile.prompts.revision) >= 0);
  assert.equal(Number(profile.identity.specialistId) > 0, true);
  assert.equal(Number(profile.dispatch.selectedSpecialistId), Number(profile.identity.specialistId));
  assert.equal(Number(profile.dispatch.lockedCapabilityCount), profile.capabilities.length);
  assert.deepEqual(profile.prompts.override, profile.prompts.overrideTemplate);
  assert.equal(Number(profile.jobProfile.employeeNumber), Number(profile.identity.idx));
  assert.equal(profile.jobProfile.roleKey, profile.identity.key);
  assert.equal(profile.jobProfile.profileVersion, profile.provenance?.profileVersion);
  assert.equal(profile.provenance?.noSilentFallback, true);
}

function assertCompleteContentProfile(profile) {
  assertExactKeys(
    profile.identity,
    [
      "idx",
      "key",
      "person",
      "name",
      "group",
      "moduleGroup",
      "positionSkill",
      "emoji",
      "color",
      "duty",
      "intro",
      "optional",
      "title",
      "department",
      "status",
    ],
    "content.identity",
  );
  assertExactKeys(
    profile.workMethod,
    [
      "inputs",
      "steps",
      "deliverables",
      "approval",
      "qualityGate",
      "handoff",
      "executionBoundary",
      "raw",
    ],
    "content.workMethod",
  );
  assertExactKeys(
    profile.skillLibrary,
    ["required", "historical", "custom", "customSkills", "boundary"],
    "content.skillLibrary",
  );
  assertExactKeys(
    profile.prompts,
    [
      "defaultTemplate",
      "overrideTemplate",
      "effectiveSummary",
      "effectiveTemplate",
      "systemPrompt",
      "pipelinePrompt",
      "soloPrompt",
      "placeholders",
      "interpolationPolicy",
      "finalOutputContract",
      "hash",
      "effectiveHash",
      "revision",
      "version",
      "redacted",
      "boundary",
    ],
    "content.prompts",
  );
  assertExactKeys(
    profile.workConfig,
    [
      "fields",
      "values",
      "factoryDefault",
      "safeLegacyConfig",
      "enterpriseOverrides",
      "version",
      "mode",
      "summary",
      "boundary",
    ],
    "content.workConfig",
  );
  assertExactKeys(
    profile.runtime,
    [
      "status",
      "runs",
      "completedRuns",
      "reviewPendingRuns",
      "reconciliationPendingRuns",
      "runningTasks",
      "failedRuns",
      "remediatedRuns",
      "lastRunAt",
      "lastTask",
      "recentTasks",
    ],
    "content.runtime",
  );
  assertExactKeys(
    profile.dispatch,
    [
      "endpoint",
      "taskTypes",
      "types",
      "defaultTaskType",
      "defaultType",
      "available",
      "enabled",
      "lockedCapabilityCount",
      "snapshotNotice",
      "form",
      "guidance",
      "approval",
      "handoff",
    ],
    "content.dispatch",
  );
  for (const [field, value] of [
    ["identity.name", profile.identity?.name],
    ["identity.duty", profile.identity?.duty],
    ["identity.positionSkill", profile.identity?.positionSkill],
    ["workMethod.approval", profile.workMethod?.approval],
    ["workMethod.qualityGate", profile.workMethod?.qualityGate],
    ["workMethod.executionBoundary", profile.workMethod?.executionBoundary],
    ["workConfig.version", profile.workConfig?.version],
    ["workConfig.mode", profile.workConfig?.mode],
    ["jobProfile.roleKey", profile.jobProfile?.roleKey],
    ["jobProfile.roleTitle", profile.jobProfile?.roleTitle],
    ["jobProfile.duty", profile.jobProfile?.duty],
    ["jobProfile.profileVersion", profile.jobProfile?.profileVersion],
    ["jobProfile.source", profile.jobProfile?.source],
    ["provenance.profileVersion", profile.provenance?.profileVersion],
    ["provenance.referenceSha256", profile.provenance?.referenceSha256],
  ]) {
    assertNonEmptyText(value, `content.${field}`);
  }
  for (const [field, value] of [
    ["workMethod.inputs", profile.workMethod?.inputs],
    ["workMethod.steps", profile.workMethod?.steps],
    ["workMethod.deliverables", profile.workMethod?.deliverables],
    ["skillLibrary.required", profile.skillLibrary?.required],
    ["workConfig.fields", profile.workConfig?.fields],
    ["jobProfile.responsibilities", profile.jobProfile?.responsibilities],
    ["jobProfile.requiredInputs", profile.jobProfile?.requiredInputs],
    ["jobProfile.expectedDeliverables", profile.jobProfile?.expectedDeliverables],
    ["jobProfile.qualityStandards", profile.jobProfile?.qualityStandards],
    ["jobProfile.safetyBoundaries", profile.jobProfile?.safetyBoundaries],
    ["jobProfile.outputKeys", profile.jobProfile?.outputKeys],
  ]) {
    assertNonEmptyArray(value, `content.${field}`);
  }
  assert.ok(plainObject(profile.workMethod?.raw), "content.workMethod.raw缺失");
  assert.ok(plainObject(profile.workConfig?.values), "content.workConfig.values缺失");
  assert.ok(plainObject(profile.workConfig?.factoryDefault), "content.workConfig.factoryDefault缺失");
  assert.ok(plainObject(profile.jobProfile?.outputSchema), "content.jobProfile.outputSchema缺失");
  assert.ok(plainObject(profile.jobProfile?.connectorPolicy), "content.jobProfile.connectorPolicy缺失");
  assert.ok(plainObject(profile.jobProfile?.authority), "content.jobProfile.authority缺失");
  assert.deepEqual(profile.skillLibrary.custom, profile.skillLibrary.customSkills);
  assert.equal(profile.skillLibrary.required.length, 1);
  assertNonEmptyArray(profile.skillLibrary.historical, "content.skillLibrary.historical");
  for (const capability of profile.capabilities) {
    assertNonEmptyText(capability?.name, "content.capability.name");
    assertNonEmptyText(capability?.emoji, "content.capability.emoji");
    assertNonEmptyText(capability?.desc, "content.capability.desc");
  }
  const contentRequiredSkill = profile.skillLibrary.required[0];
  for (const key of ["title", "detail", "source"]) {
    assertNonEmptyText(contentRequiredSkill?.[key], `content.requiredSkill.${key}`);
  }
  assert.equal(contentRequiredSkill.required, true);
  assert.equal(contentRequiredSkill.enabled, true);
  assert.equal(contentRequiredSkill.locked, true);
  assertSha256(profile.prompts.hash, "content.prompts.hash");
  assertSha256(profile.prompts.effectiveHash, "content.prompts.effectiveHash");
  assertSha256(profile.provenance.referenceSha256, "content.provenance.referenceSha256");
  assert.equal(profile.identity.title, profile.identity.name);
  assert.equal(profile.identity.department, profile.identity.group);
  assert.equal(profile.identity.status, "可派活");
  assert.equal(Number(profile.dispatch.lockedCapabilityCount), profile.capabilities.length);
  assert.equal(Number(profile.jobProfile.employeeNumber), Number(profile.identity.idx));
  assert.equal(profile.jobProfile.roleKey, profile.identity.key);
  assert.equal(profile.jobProfile.profileVersion, profile.prompts.version);
  assert.equal(profile.jobProfile.profileVersion, profile.provenance.profileVersion);
  assert.equal(profile.provenance?.noSilentFallback, true);
}

function assertPrivilegedProfile(domain, profile) {
  assertWorkbenchTopLevel(profile, `${domain}.boss`);
  assertExactKeys(
    profile.permissions,
    [
      "canDispatch",
      "canReviewRuns",
      ...PROFILE_VIEW_PERMISSIONS,
      ...PROFILE_EDIT_PERMISSIONS,
      ...(domain === "content" ? ["canViewFullPrompt"] : []),
    ],
    `${domain}.boss.permissions`,
  );
  assert.ok(profile.capabilities.length > 0, `${domain}老板看不到完整能力`);
  assert.ok(
    profile.capabilities.every(
      (item) => item?.required === true && item?.enabled === true && item?.locked === true,
    ),
    `${domain}必备能力未全部启用并锁定`,
  );
  assert.notEqual(profile.workMethod?.redacted, true, `${domain}老板工作方式被隐藏`);
  assert.notEqual(profile.skillLibrary?.redacted, true, `${domain}老板技能库被隐藏`);
  assert.equal(profile.prompts?.redacted, false, `${domain}老板提示词被隐藏`);
  assert.ok(String(profile.prompts?.defaultTemplate || "").length > 0, `${domain}老板缺少出厂提示词`);
  assert.ok(String(profile.prompts?.effectiveTemplate || "").length > 0, `${domain}老板缺少有效提示词`);
  if (domain === "restaurant") assertCompleteRestaurantProfile(profile);
  else assertCompleteContentProfile(profile);
  for (const key of [...PROFILE_VIEW_PERMISSIONS, ...PROFILE_EDIT_PERMISSIONS]) {
    assert.equal(profile.permissions?.[key], true, `${domain}老板权限${key}不是true`);
  }
  if (domain === "content") {
    assert.equal(profile.permissions?.canViewFullPrompt, true);
  }
  assert.equal(profile.permissions?.canDispatch, true);
  assert.equal(profile.permissions?.canReviewRuns, true);
  assert.ok(Number(profile.dispatch?.lockedCapabilityCount) > 0);
  assert.notEqual(profile.workConfig?.redacted, true);
  assert.notEqual(profile.jobProfile?.redacted, true);
  assert.notEqual(profile.provenance?.redacted, true);
}

function assertRestrictedProfile(domain, lane, profile, bossProfile) {
  assertWorkbenchTopLevel(profile, `${domain}.${lane}`);
  assertExactKeys(
    profile.permissions,
    [
      "canDispatch",
      "canReviewRuns",
      ...PROFILE_VIEW_PERMISSIONS,
      ...PROFILE_EDIT_PERMISSIONS,
      ...(domain === "content" ? ["canViewFullPrompt"] : []),
    ],
    `${domain}.${lane}.permissions`,
  );
  assert.deepEqual(profile.capabilities, [], `${domain}.${lane}不得读取能力明细`);
  for (const key of PROFILE_VIEW_PERMISSIONS) {
    assert.equal(profile.permissions?.[key], false, `${domain}.${lane}.${key}应为false`);
  }
  if (domain === "content") {
    assert.equal(profile.permissions?.canViewFullPrompt, false);
  }
  for (const key of PROFILE_EDIT_PERMISSIONS) {
    assert.equal(profile.permissions?.[key], false, `${domain}.${lane}.${key}应为false`);
  }
  assert.equal(profile.permissions?.canDispatch, true);
  assert.equal(profile.permissions?.canReviewRuns, lane === "management");
  for (const field of ["workMethod", "skillLibrary", "prompts", "workConfig", "jobProfile", "provenance"]) {
    assert.equal(profile[field]?.redacted, true, `${domain}.${lane}.${field}必须服务端脱敏`);
  }
  assert.equal(profile.prompts?.defaultTemplate, null);
  assert.equal(profile.prompts?.effectiveTemplate, null);
  assert.equal(profile.prompts?.overrideTemplate, null);
  assert.equal(Object.hasOwn(profile.dispatch || {}, "lockedCapabilityCount"), false);
  if (domain === "restaurant") {
    assertExactKeys(
      profile.dispatch,
      [
        "endpoint",
        "taskTypes",
        "types",
        "defaultTaskType",
        "defaultType",
        "requirementMaxChars",
        "selectedSpecialistId",
        "requiredInputs",
        "guidance",
        "available",
        "enabled",
        "snapshotNotice",
      ],
      `${domain}.${lane}.dispatch`,
    );
    assertExactKeys(profile.workMethod, ["redacted", "boundary"], `${domain}.${lane}.workMethod`);
    assertExactKeys(
      profile.skillLibrary,
      ["required", "optional", "learned", "enabled", "redacted", "boundary"],
      `${domain}.${lane}.skillLibrary`,
    );
    assertExactKeys(
      profile.prompts,
      [
        "defaultTemplate",
        "override",
        "overrideTemplate",
        "effectiveTemplate",
        "overrideMode",
        "redacted",
        "boundary",
      ],
      `${domain}.${lane}.prompts`,
    );
    assert.deepEqual(profile.skillLibrary?.required, []);
    assert.deepEqual(profile.skillLibrary?.optional, []);
    assert.deepEqual(profile.skillLibrary?.learned, []);
    assert.deepEqual(profile.skillLibrary?.enabled, []);
  } else {
    assertExactKeys(
      profile.dispatch,
      [
        "endpoint",
        "taskTypes",
        "types",
        "defaultTaskType",
        "defaultType",
        "available",
        "enabled",
        "snapshotNotice",
        "form",
        "guidance",
        "approval",
        "handoff",
      ],
      `${domain}.${lane}.dispatch`,
    );
    assertExactKeys(profile.workMethod, ["redacted", "boundary"], `${domain}.${lane}.workMethod`);
    assertExactKeys(
      profile.skillLibrary,
      ["required", "historical", "custom", "customSkills", "redacted", "boundary"],
      `${domain}.${lane}.skillLibrary`,
    );
    assertExactKeys(
      profile.prompts,
      [
        "defaultTemplate",
        "effectiveTemplate",
        "overrideTemplate",
        "systemPrompt",
        "pipelinePrompt",
        "soloPrompt",
        "redacted",
        "boundary",
      ],
      `${domain}.${lane}.prompts`,
    );
    assert.equal(profile.identity?.positionSkill, null);
    assert.deepEqual(profile.skillLibrary?.required, []);
    assert.deepEqual(profile.skillLibrary?.historical, []);
    assert.deepEqual(profile.skillLibrary?.custom, []);
    assert.deepEqual(profile.skillLibrary?.customSkills, []);
    assert.equal(profile.prompts?.systemPrompt?.template, null);
    assert.deepEqual(profile.prompts?.pipelinePrompt, {});
    assert.deepEqual(profile.prompts?.soloPrompt, {});
  }
  for (const field of ["workConfig", "jobProfile", "provenance"]) {
    assertExactKeys(profile[field], ["redacted", "boundary"], `${domain}.${lane}.${field}`);
  }
  for (const sensitive of [
    bossProfile?.prompts?.defaultTemplate,
    bossProfile?.prompts?.effectiveTemplate,
    bossProfile?.prompts?.overrideTemplate,
  ]) {
    if (typeof sensitive === "string" && sensitive.length >= 16) {
      assert.equal(
        JSON.stringify(profile).includes(sensitive),
        false,
        `${domain}.${lane}泄露完整提示词`,
      );
    }
  }
}

export function assertProfileAccessMatrix({ domain, boss, management, employee }) {
  if (!['restaurant', 'content'].includes(domain)) throw new Error('未知工作台领域');
  assertPrivilegedProfile(domain, boss);
  assertRestrictedProfile(domain, "management", management, boss);
  assertRestrictedProfile(domain, "employee", employee, boss);
  return {
    domain,
    samples: [
      { lane: "boss", fullProfileVisible: true, canEdit: true, canReviewRuns: true },
      { lane: "management", fullProfileVisible: false, canEdit: false, canReviewRuns: true },
      { lane: "employee", fullProfileVisible: false, canEdit: false, canReviewRuns: false },
    ],
  };
}

export function assertContentDispatchSnapshotMatchesAuthority(snapshot, row) {
  assert.ok(plainObject(snapshot), "内容员工运行快照必须是对象");
  assert.ok(plainObject(snapshot.dispatch), "内容员工运行快照缺少dispatch");
  assert.equal(
    String(snapshot.dispatch.title || ""),
    String(row?.title || ""),
    "内容员工快照title与权威运行记录不一致",
  );
  assert.equal(
    String(snapshot.dispatch.requirement || ""),
    String(row?.requirement || ""),
    "内容员工快照requirement与权威运行记录不一致",
  );
  return {
    title: String(row?.title || ""),
    requirement: String(row?.requirement || ""),
    feedback: String(snapshot.dispatch.feedback || ""),
  };
}

export function isLoopbackBaseUrl(raw) {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname.replace(/\/+$/u, "") === ""
    );
  } catch {
    return false;
  }
}

export function buildSameOriginRequestUrl(baseUrl, route) {
  const base = new URL(String(baseUrl || ""));
  if (!isLoopbackBaseUrl(base.href)) {
    throw new Error("请求基地址不是受信loopback根地址");
  }
  if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//")) {
    throw new Error("请求路径必须是单斜杠开头的站内绝对路径");
  }
  const url = new URL(route, base);
  if (url.origin !== base.origin || url.username || url.password) {
    throw new Error("请求路径不得跳出当前loopback origin");
  }
  return url;
}

export async function fetchSameOriginNoRedirect(baseUrl, route, init = {}) {
  const requestUrl = buildSameOriginRequestUrl(baseUrl, route);
  const response = await fetch(requestUrl, {
    ...init,
    redirect: "error",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  const responseUrl = new URL(response.url || requestUrl.href);
  if (responseUrl.origin !== requestUrl.origin) {
    throw new Error("响应跳出受信loopback origin");
  }
  return response;
}

function realParentPath(targetPath) {
  const absolute = path.resolve(targetPath);
  let cursor = path.dirname(absolute);
  const missing = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`无法解析输出路径：${absolute}`);
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...missing, path.basename(absolute));
}

function sameInode(leftPath, rightPath) {
  try {
    const left = fs.statSync(leftPath);
    const right = fs.statSync(rightPath);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

export function protectedDatabasePaths(databasePath) {
  const canonical = fs.realpathSync(databasePath);
  return Object.freeze([
    canonical,
    `${canonical}-wal`,
    `${canonical}-shm`,
    `${canonical}-journal`,
  ]);
}

export function assertSafeArtifactPath({ databasePath, artifactPath, label = "证据输出" }) {
  if (!databasePath || !fs.existsSync(databasePath)) {
    throw new Error("无法校验输出路径：数据库不存在");
  }
  if (!artifactPath) throw new Error(`${label}路径不能为空`);
  const candidate = realParentPath(artifactPath);
  const protectedPaths = protectedDatabasePaths(databasePath).map((item) =>
    realParentPath(item),
  );
  if (protectedPaths.includes(candidate)) {
    throw new Error(`${label}不得覆盖数据库或SQLite sidecar`);
  }
  if (
    fs.existsSync(candidate) &&
    protectedPaths.some((item) => fs.existsSync(item) && sameInode(candidate, item))
  ) {
    throw new Error(`${label}不得指向数据库文件的硬链接`);
  }
  return candidate;
}

export function reserveExclusiveArtifactPath({
  databasePath,
  artifactPath,
  label = "证据输出",
}) {
  const candidate = assertSafeArtifactPath({ databasePath, artifactPath, label });
  if (fs.existsSync(candidate)) {
    throw new Error(`${label}已存在，拒绝覆盖`);
  }
  return candidate;
}

export function syncArtifactPublication(outputPath, {
  platform = process.platform,
  fileSystem = fs,
} = {}) {
  // Windows FlushFileBuffers requires a writable file handle; a read-only
  // directory descriptor is not the POSIX directory-fsync facility. Reopen the
  // published file and flush it explicitly. This guarantees a file flush, not a
  // portable power-loss guarantee for the containing directory's link metadata.
  const windows = platform === "win32";
  const descriptor = fileSystem.openSync(
    windows ? outputPath : path.dirname(outputPath), windows ? "r+" : "r",
  );
  try {
    fileSystem.fsyncSync(descriptor);
  } finally {
    fileSystem.closeSync(descriptor);
  }
  return windows ? "published_file_flushed" : "parent_directory_flushed";
}

export function writeJsonExclusive0600(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`;
  let descriptor;
  let created = false;
  try {
    if (process.platform === "win32") {
      createPrivateArtifact(temporary);
      created = true;
      descriptor = fs.openSync(temporary, "r+");
    } else {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      created = true;
    }
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, outputPath);
    fs.chmodSync(outputPath, 0o600);
    syncArtifactPublication(outputPath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      if (created) fs.unlinkSync(temporary);
    } catch {
      // A pre-existing destination is intentionally preserved.
    }
  }
}

export function isOfficialYunwuEndpoint(value) {
  try {
    const url = new URL(String(value || "").trim());
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!url.port || url.port === "443") &&
      (hostname === "yunwu.ai" || hostname.endsWith(".yunwu.ai")) &&
      (url.pathname === "/v1" || url.pathname.startsWith("/v1/"))
    );
  } catch {
    return false;
  }
}

export function assertFreshOfficialYunwuReadiness(
  payload,
  { now = Date.now(), maximumAgeMs = 15 * 60 * 1000 } = {},
) {
  const generatedAt = Date.parse(String(payload?.generatedAt || ""));
  const ai = (Array.isArray(payload?.channels) ? payload.channels : []).find(
    (item) => item?.key === "ai",
  );
  assert.ok(ai, "运行就绪矩阵缺少AI通道");
  assert.equal(ai.details?.provider, "yunwu", "AI provider不是云雾");
  assert.equal(
    ai.details?.keySource,
    "environment",
    "云雾密钥必须来自服务进程环境",
  );
  assert.equal(
    ai.details?.executionMode,
    "external_provider",
    "AI通道未进入外部供应商模式",
  );
  assert.ok(
    isOfficialYunwuEndpoint(ai.details?.baseUrl),
    "AI Base URL不是官方云雾HTTPS /v1端点",
  );
  assert.match(
    String(ai.details?.configFingerprint || ""),
    /^[a-f0-9]{64}$/u,
    "AI服务端配置指纹缺失",
  );
  assert.equal(ai.verification, "passed", "AI通道缺少最近显式验证");
  assert.equal(ai.verified, true, "AI通道verified不是true");
  assert.equal(ai.effective, "connected", "AI通道当前不是connected");
  assert.equal(ai.lastCheck?.outcome, "passed", "AI最近连接测试未通过");
  const checkedAt = Date.parse(String(ai.lastCheck?.checkedAt || ""));
  const expiresAt = Date.parse(String(ai.lastCheck?.expiresAt || ""));
  assert.ok(Number.isFinite(generatedAt), "readiness.generatedAt无效");
  assert.ok(Number.isFinite(checkedAt), "AI lastCheck.checkedAt无效");
  assert.ok(Number.isFinite(expiresAt), "AI lastCheck.expiresAt无效");
  assert.ok(generatedAt <= Number(now) + 30_000, "readiness生成时间在未来");
  assert.ok(Number(now) - generatedAt <= 60_000, "readiness响应不是本次新鲜读取");
  assert.ok(checkedAt <= generatedAt, "AI验证时间晚于readiness生成时间");
  assert.ok(generatedAt - checkedAt <= maximumAgeMs, "AI验证证据已过旧");
  assert.ok(expiresAt > generatedAt && expiresAt > Number(now), "AI验证证据已过期");
  const providerFacts = {
    provider: ai.details.provider,
    keySource: ai.details.keySource,
    baseUrl: ai.details.baseUrl,
    executionMode: ai.details.executionMode,
    configFingerprint: ai.details.configFingerprint,
  };
  const verificationFacts = {
    ...providerFacts,
    verification: ai.verification,
    checkedAt: ai.lastCheck.checkedAt,
    expiresAt: ai.lastCheck.expiresAt,
  };
  return {
    provider: "yunwu",
    keySource: "environment",
    officialEndpoint: true,
    verification: "passed",
    configFingerprint: ai.details.configFingerprint,
    checkedAt: ai.lastCheck.checkedAt,
    expiresAt: ai.lastCheck.expiresAt,
    fingerprint: hashValue(providerFacts),
    verificationFingerprint: hashValue(verificationFacts),
  };
}

export function parsePositiveInteger(value, fallback, { min, max }) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`参数必须是${min}-${max}之间的整数`);
  }
  return parsed;
}

export function redactDiagnostic(value, max = 300) {
  return String(value || "")
    .replace(SECRET_VALUE_RE, "[REDACTED]")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/giu, "$1[REDACTED]")
    .slice(0, max);
}

function selectKeys(value, keys) {
  if (!plainObject(value)) return {};
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
  );
}

export function projectIdentityEvidence(value) {
  return selectKeys(value, ["id", "name", "role", "tenantId", "moduleCount"]);
}

export function projectHttpEvidence(value) {
  const projected = selectKeys(value, [
    "label",
    "actor",
    "method",
    "path",
    "status",
    "ok",
    "entityId",
    "businessStatus",
    "displayStatus",
    "presentationKey",
    "durationMs",
  ]);
  if (Object.hasOwn(projected, "path")) {
    projected.path = String(projected.path).replace(/\?.*$/u, "");
  }
  return projected;
}

export function positiveWhitelistEvidence(value) {
  if (
    value === null ||
    ["string", "number", "boolean"].includes(typeof value)
  ) {
    return typeof value === "string" ? redactDiagnostic(value, 500) : value;
  }
  if (Array.isArray(value)) return value.map(positiveWhitelistEvidence);
  if (!plainObject(value)) return null;
  const safe = {};
  const allowed = new Set([
    "schema",
    "ok",
    "startedAt",
    "finishedAt",
    "durationMs",
    "baseUrl",
    "database",
    "tenant",
    "actors",
    "cloudAiOptIn",
    "validationScope",
    "samplesValidated",
    "sampleCount",
    "scenarios",
    "checks",
    "summary",
    "error",
    "label",
    "actor",
    "method",
    "path",
    "status",
    "entityId",
    "businessStatus",
    "displayStatus",
    "presentationKey",
    "before",
    "after",
    "unchanged",
    "digest",
    "tableCounts",
    "markerKey",
    "id",
    "name",
    "role",
    "tenantId",
    "moduleCount",
    "manualTask",
    "restaurantEmployee",
    "contentEmployee",
    "boss",
    "management",
    "employee",
    "billing",
    "approvals",
    "assets",
    "knowledge",
    "materials",
    "notifications",
    "operations",
    "tasks",
    "submissions",
    "contents",
    "runs",
    "holds",
    "logs",
    "balanceBefore",
    "balanceAfter",
    "balanceDelta",
    "heldCount",
    "chargedCredits",
    "inputTokens",
    "outputTokens",
    "aiMode",
    "model",
    "refType",
    "refId",
    "targetType",
    "targetId",
    "sourceType",
    "sourceId",
    "parentTaskId",
    "assigneeId",
    "assignedBy",
    "createdBy",
    "reviewerId",
    "result",
    "type",
    "action",
    "module",
    "createdAt",
    "decidedAt",
    "settledAt",
    "count",
    "passed",
    "failed",
    "forbiddenChecks",
    "providerCalls",
    "provider",
    "providerTokens",
    "customerCredits",
    "parentTaskId",
    "childTaskId",
    "restaurantTaskId",
    "contentRunId",
    "restaurantOutputId",
    "restaurantKnowledgeId",
    "restaurantAssetId",
    "restaurantSpecialistId",
    "contentMaterialId",
    "contentId",
    "contentEmployeeIdx",
    "dataMode",
    "username",
    "title",
    "businessStatus",
    "created_at",
    "updated_at",
    "done_at",
    "settled_at",
    "decided_at",
    "user_id",
    "log_id",
    "feature",
    "kind",
    "held_credits",
    "settled_credits",
    "ref_type",
    "ref_id",
    "input_tokens",
    "output_tokens",
    "cost_yuan",
    "credits",
    "balance_after",
    "ai_mode",
    "task_id",
    "source_ref_type",
    "source_ref_id",
    "reviewer_id",
    "marshal_id",
    "specialist_id",
    "output_id",
    "created_by",
    "employee_idx",
    "employeeIdx",
    "employee_key",
    "employee_name",
    "employee_group",
    "target_type",
    "target_id",
    "submitter_id",
    "approval_level",
    "parent_id",
    "category",
    "source_type",
    "source_id",
    "creator_id",
    "enabled",
    "version",
    "content_employee_idx",
    "link",
    "read",
    "target",
    "assignee_id",
    "assigned_by",
    "parent_task_id",
    "errors",
    "fingerprints",
    "code",
    "scenario",
    "databaseIdentity",
    "providerReadiness",
    "providerFingerprint",
    "configFingerprint",
    "sha256",
    "schemaSha256",
    "databaseId",
    "batchNonceSha256",
    "keySource",
    "officialEndpoint",
    "verification",
    "verificationFingerprint",
    "fingerprint",
    "checkedAt",
    "expiresAt",
    "profileAccess",
    "samples",
    "lane",
    "domain",
    "fullProfileVisible",
    "canEdit",
    "canReviewRuns",
    "outputContract",
    "semanticGate",
    "placeholders",
    "knownFactsChecked",
    "factConflicts",
    "marketingClaimsChecked",
    "unsupportedMarketing",
    "externalActionClaims",
    "valid",
    "bodySha256",
    "artifactSha256",
    "proofType",
    "fileCount",
    "coverage",
    "externalServices",
    "filesystem",
    "externalSideEffectsCoverage",
    "reconciled",
    "submitted",
    "recoveredAfterUnknownOutcome",
    "checkpoint",
    "stage",
    "status",
  ]);
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key) || !allowed.has(key)) continue;
    if (key === "tableCounts" && plainObject(item)) {
      safe[key] = Object.fromEntries(
        Object.entries(item)
          .filter(([, count]) => Number.isSafeInteger(Number(count)))
          .map(([table, count]) => [String(table), Number(count)]),
      );
      continue;
    }
    safe[key] = positiveWhitelistEvidence(item);
  }
  return safe;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableExists(db, table) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table),
  );
}

function tableColumns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((column) => String(column.name));
}

function canonicalSqliteValue(value) {
  if (Buffer.isBuffer(value)) {
    return { kind: "blob", sha256: hashValue(value), bytes: value.length };
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function canonicalRow(row) {
  return Object.fromEntries(
    Object.keys(row)
      .sort()
      .map((key) => [key, canonicalSqliteValue(row[key])]),
  );
}

export function hashValue(value) {
  return crypto
    .createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
}

export function captureFullTenantSnapshot(db, tenantId) {
  const id = Number(tenantId);
  assert.ok(Number.isSafeInteger(id) && id > 0, "tenantId必须是正整数");
  const tables = {};
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name));
  for (const name of names) {
    const columns = tableColumns(db, name);
    if (!columns.includes("tenant_id")) continue;
    const rows = db
      .prepare(`SELECT * FROM ${quoteIdentifier(name)} WHERE tenant_id=?`)
      .all(id)
      .map(canonicalRow)
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
    tables[name] = rows;
  }
  const tenant = tableExists(db, "tenants")
    ? canonicalRow(db.prepare("SELECT * FROM tenants WHERE id=?").get(id) || {})
    : null;
  const tenantConfig = tableExists(db, "sys_config")
    ? db
        .prepare(
          "SELECT key,value FROM sys_config WHERE key LIKE ? ORDER BY key",
        )
        .all(`%:${id}`)
        .map(canonicalRow)
    : [];
  return { tenantId: id, tenant, tenantConfig, tables };
}

export function summarizeFullTenantSnapshot(snapshot) {
  const tableCounts = Object.fromEntries(
    Object.entries(snapshot?.tables || {}).map(([name, rows]) => [
      name,
      Array.isArray(rows) ? rows.length : 0,
    ]),
  );
  return {
    digest: hashValue(snapshot),
    tableCounts,
  };
}

export function assertForbiddenFullDatabaseNoSideEffects({
  label,
  status,
  before,
  after,
}) {
  assert.equal(status, 403, `${label}: expected HTTP 403 but got ${status}`);
  assert.deepEqual(
    after,
    before,
    `${label}: 403 request changed tenant database state`,
  );
  return {
    label,
    status,
    before: summarizeFullTenantSnapshot(before),
    after: summarizeFullTenantSnapshot(after),
    unchanged: true,
  };
}

function captureAllPersistentTables(db) {
  const tables = {};
  const names = db
    .prepare(
      `SELECT name FROM sqlite_master
      WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence')
      ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  for (const name of names) {
    const rows = db
      .prepare(`SELECT * FROM ${quoteIdentifier(name)}`)
      .all()
      .map(canonicalRow)
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
    tables[name] = rows;
  }
  return tables;
}

function capturePersistentDatabaseStructure(db) {
  const schema = db
    .prepare(
      `SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`,
    )
    .all()
    .map(canonicalRow);
  return {
    schema,
    pragmas: {
      applicationId: Number(
        db.prepare("PRAGMA application_id").get()?.application_id || 0,
      ),
      userVersion: Number(
        db.prepare("PRAGMA user_version").get()?.user_version || 0,
      ),
    },
    tables: captureAllPersistentTables(db),
  };
}

function persistentStat(value) {
  return {
    mode: Number(value.mode & 0o7777),
    mtimeMs: Number(value.mtimeMs),
  };
}

function captureFileTree(rootPath, ignoredAbsolutePaths = []) {
  if (!rootPath || !fs.existsSync(rootPath)) return {};
  const root = fs.realpathSync(rootPath);
  const ignored = new Set(
    ignoredAbsolutePaths.map((item) => realParentPath(item)),
  );
  const files = {
    ".": { kind: "directory", ...persistentStat(fs.statSync(root)) },
  };
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const canonical = realParentPath(absolute);
      if (ignored.has(canonical)) continue;
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        files[`${relative}/`] = {
          kind: "directory",
          ...persistentStat(fs.statSync(absolute)),
        };
        visit(absolute);
      } else if (entry.isSymbolicLink()) {
        const stat = fs.lstatSync(absolute);
        files[relative] = {
          kind: "symlink",
          targetSha256: hashValue(fs.readlinkSync(absolute)),
          ...persistentStat(stat),
        };
      } else if (entry.isFile()) {
        const content = fs.readFileSync(absolute);
        const stat = fs.statSync(absolute);
        files[relative] = {
          kind: "file",
          bytes: content.length,
          sha256: hashValue(content),
          ...persistentStat(stat),
        };
      } else {
        files[relative] = {
          kind: "other",
          ...persistentStat(fs.lstatSync(absolute)),
        };
      }
    }
  };
  visit(root);
  if (process.platform === "win32") {
    // stat.mode cannot detect DACL-only changes on Windows. Inspect real
    // non-reparse entries in one batch; no permissions are changed here.
    const keys = Object.keys(files).filter(key => ["directory", "file"].includes(files[key].kind));
    const fingerprints = windowsAclFingerprints(keys.map(key => path.resolve(root, key)));
    keys.forEach((key, index) => { files[key].aclSha256 = fingerprints[index]; });
  }
  return files;
}

export function capturePersistentSideEffectBoundary({
  db,
  databasePath,
  dataRoot,
  dataRoots,
  ignoredPaths = [],
}) {
  const databasePaths = databasePath ? protectedDatabasePaths(databasePath) : [];
  const requestedRoots = [
    ...(Array.isArray(dataRoots) ? dataRoots : []),
    ...(dataRoot ? [dataRoot] : []),
  ];
  const roots = [...new Set(
    requestedRoots
      .filter((item) => item && fs.existsSync(item))
      .map((item) => fs.realpathSync(item)),
  )].sort();
  return {
    coverage: {
      database:
        "all_persistent_tables_including_global_rows_sqlite_sequence_schema_and_persistent_pragmas",
      filesystem: roots.length
        ? "recursive_explicit_application_data_roots_with_metadata_except_live_sqlite_files"
        : "not_configured",
      externalServices: "not_instrumented",
    },
    database: capturePersistentDatabaseStructure(db),
    filesystem: Object.fromEntries(
      roots.map((root, index) => [
        `root${index + 1}`,
        captureFileTree(root, [...databasePaths, ...ignoredPaths]),
      ]),
    ),
  };
}

export function summarizePersistentSideEffectBoundary(snapshot) {
  return {
    digest: hashValue(snapshot),
    tableCounts: Object.fromEntries(
      Object.entries(snapshot?.database || {}).map(([name, rows]) => [
        name,
        name === "tables" && plainObject(rows)
          ? Object.values(rows).reduce(
              (total, tableRows) => total + (Array.isArray(tableRows) ? tableRows.length : 0),
              0,
            )
          : Array.isArray(rows)
            ? rows.length
            : 0,
      ]),
    ),
    fileCount: Object.values(snapshot?.filesystem || {}).reduce(
      (total, tree) => total + Object.keys(tree || {}).length,
      0,
    ),
    coverage: snapshot?.coverage || null,
  };
}

export function assertForbiddenPersistentBoundaryUnchanged({
  label,
  status,
  before,
  after,
}) {
  assert.equal(status, 403, `${label}: expected HTTP 403 but got ${status}`);
  assert.deepEqual(
    after,
    before,
    `${label}: 403 request changed the measured local persistent boundary`,
  );
  return {
    label,
    status,
    proofType: "403_persistent_local_boundary",
    before: summarizePersistentSideEffectBoundary(before),
    after: summarizePersistentSideEffectBoundary(after),
    unchanged: true,
    externalSideEffectsCoverage: "not_instrumented",
  };
}

export function normalizeBatchNonce(value) {
  const nonce = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/u.test(nonce)) {
    throw new Error("--batch-nonce必须是16-128位安全字符");
  }
  return nonce;
}

export function findUniqueNonceBoundAiState(
  db,
  {
    domain,
    tenantId,
    actorId,
    requirementMarker,
    employeeIdx,
    minimumIdExclusive = 0,
  } = {},
) {
  const tenant = Number(tenantId);
  const actor = Number(actorId);
  const marker = String(requirementMarker || "");
  const requirementPrefix = `${marker}\n`;
  const minimumId = Number(minimumIdExclusive);
  assert.ok(Number.isSafeInteger(tenant) && tenant > 0, "AI恢复tenantId无效");
  assert.ok(Number.isSafeInteger(actor) && actor > 0, "AI恢复actorId无效");
  assert.ok(marker.length >= 16 && marker.length <= 256, "AI恢复nonce marker无效");
  assert.ok(Number.isSafeInteger(minimumId) && minimumId >= 0, "AI恢复watermark无效");
  let rows;
  if (domain === "restaurant") {
    rows = db
      .prepare(
        `SELECT id,requirement,created_by,specialist_id,status
        FROM agent_tasks
        WHERE tenant_id=? AND created_by=? AND id>?
          AND substr(requirement,1,length(?))=?
        ORDER BY id`,
      )
      .all(tenant, actor, minimumId, requirementPrefix, requirementPrefix);
  } else if (domain === "content") {
    const idx = Number(employeeIdx);
    assert.ok(Number.isSafeInteger(idx) && idx >= 0 && idx <= 9, "内容员工编号无效");
    rows = db
      .prepare(
        `SELECT id,requirement,created_by,employee_idx,status
        FROM content_employee_runs
        WHERE tenant_id=? AND created_by=? AND employee_idx=? AND id>?
          AND substr(requirement,1,length(?))=?
        ORDER BY id`,
      )
      .all(
        tenant,
        actor,
        idx,
        minimumId,
        requirementPrefix,
        requirementPrefix,
      );
  } else {
    throw new Error("AI恢复领域必须是restaurant或content");
  }
  if (rows.length > 1) {
    throw new Error(`checkpoint nonce匹配到多条${domain}任务`);
  }
  const row = rows[0] || null;
  if (row) {
    assert.equal(Number(row.created_by), actor, `${domain}恢复记录创建人不匹配`);
    assert.ok(
      String(row.requirement || "").startsWith(requirementPrefix),
      `${domain}恢复记录nonce不匹配`,
    );
    if (domain === "content") {
      assert.equal(Number(row.employee_idx), Number(employeeIdx), "内容恢复员工编号不匹配");
    }
  }
  return row;
}

export function computeDatabaseIdentityFingerprint(db, databasePath, databaseId) {
  const canonical = fs.realpathSync(databasePath);
  const stat = fs.statSync(canonical);
  const schema = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all()
    .map(canonicalRow);
  const facts = {
    device: Number(stat.dev),
    inode: Number(stat.ino),
    applicationId: Number(db.prepare("PRAGMA application_id").get()?.application_id || 0),
    userVersion: Number(db.prepare("PRAGMA user_version").get()?.user_version || 0),
    pageSize: Number(db.prepare("PRAGMA page_size").get()?.page_size || 0),
    databaseId: String(databaseId || ""),
    schemaSha256: hashValue(schema),
  };
  return { ...facts, sha256: hashValue(facts) };
}

function assertDedicatedTenantRows(db, tenantId) {
  const tenants = db.prepare("SELECT id FROM tenants ORDER BY id").all();
  if (tenants.length !== 1 || Number(tenants[0]?.id) !== Number(tenantId)) {
    throw new Error("隔离库必须只包含本次唯一测试租户");
  }
  const violations = [];
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name));
  for (const name of names) {
    if (!tableColumns(db, name).includes("tenant_id")) continue;
    const rows = db
      .prepare(
        `SELECT tenant_id,COUNT(*) count FROM ${quoteIdentifier(name)} GROUP BY tenant_id ORDER BY tenant_id`,
      )
      .all();
    if (
      rows.some(
        (row) => row.tenant_id == null || Number(row.tenant_id) !== Number(tenantId),
      )
    ) {
      violations.push(name);
    }
  }
  if (violations.length) {
    throw new Error(`隔离库含有其他租户或空租户数据：${violations.join("、")}`);
  }
}

export function assertIsolationMarker(
  db,
  tenantId,
  { batchNonce, databasePath, now = Date.now() } = {},
) {
  const nonce = normalizeBatchNonce(batchNonce);
  const markerKey = `live_role_matrix_isolated:${Number(tenantId)}`;
  const row = db
    .prepare("SELECT value FROM sys_config WHERE key=?")
    .get(markerKey);
  let marker;
  try {
    marker = JSON.parse(String(row?.value || ""));
  } catch {
    throw new Error(`隔离租户标记 ${markerKey} 必须是严格JSON对象`);
  }
  if (!plainObject(marker)) throw new Error("隔离标记必须是JSON对象");
  const allowed = new Set([
    "marker",
    "testOnly",
    "purpose",
    "tenantId",
    "databaseId",
    "allowedBatchNonceSha256",
    "issuedAt",
    "expiresAt",
  ]);
  const extras = Object.keys(marker).filter((key) => !allowed.has(key));
  if (extras.length) throw new Error(`隔离标记含未知字段：${extras.join("、")}`);
  const issuedAt = Date.parse(String(marker.issuedAt || ""));
  const expiresAt = Date.parse(String(marker.expiresAt || ""));
  const expectedNonceHash = hashValue(nonce);
  const valid = marker.marker === LIVE_ROLE_FLOW_ISOLATION_MARKER
    && marker.testOnly === true
    && marker.purpose === "live-role-flow-matrix"
    && Number(marker.tenantId) === Number(tenantId)
    && typeof marker.databaseId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(marker.databaseId)
    && marker.allowedBatchNonceSha256 === expectedNonceHash
    && Number.isFinite(issuedAt)
    && Number.isFinite(expiresAt)
    && issuedAt <= Number(now)
    && expiresAt > Number(now)
    && expiresAt - issuedAt <= 24 * 60 * 60 * 1000;
  if (!valid) {
    throw new Error(
      `隔离租户标记 ${markerKey} 与本次租户、库或batch nonce不匹配，拒绝写入`,
    );
  }
  assertDedicatedTenantRows(db, tenantId);
  if (!databasePath) throw new Error("隔离校验缺少数据库路径");
  return {
    markerKey,
    databaseId: marker.databaseId,
    batchNonceSha256: expectedNonceHash,
    expiresAt: new Date(expiresAt).toISOString(),
    databaseIdentity: computeDatabaseIdentityFingerprint(
      db,
      databasePath,
      marker.databaseId,
    ),
  };
}

export function captureWatermarks(db, tenantId) {
  const id = Number(tenantId);
  const tracked = [
    "tasks",
    "task_submissions",
    "agent_tasks",
    "content_employee_runs",
    "credit_holds",
    "credit_logs",
    "contents",
    "approvals",
    "materials",
    "biz_assets",
    "kb_docs",
    "notifications",
    "op_logs",
  ];
  const ids = {};
  for (const table of tracked) {
    ids[table] = tableExists(db, table)
      ? Number(
          db
            .prepare(
              `SELECT COALESCE(MAX(id),0) id FROM ${quoteIdentifier(table)} WHERE tenant_id=?`,
            )
            .get(id)?.id || 0,
        )
      : 0;
  }
  const tenant = db.prepare("SELECT credits FROM tenants WHERE id=?").get(id);
  return { ids, balance: Number(tenant?.credits || 0) };
}

function safeSelect(db, table, fields, tenantId, afterId) {
  if (!tableExists(db, table)) return [];
  const columns = new Set(tableColumns(db, table));
  const selected = fields.filter((field) => columns.has(field));
  if (!selected.length) return [];
  return db
    .prepare(
      `SELECT ${selected.map(quoteIdentifier).join(",")} FROM ${quoteIdentifier(table)} WHERE tenant_id=? AND id>? ORDER BY id`,
    )
    .all(Number(tenantId), Number(afterId || 0))
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          canonicalSqliteValue(value),
        ]),
      ),
    );
}

export function collectFlowEvidence(db, tenantId, watermarks) {
  const ids = watermarks?.ids || {};
  const table = (name, fields) =>
    safeSelect(db, name, fields, tenantId, ids[name]);
  const holds = table("credit_holds", [
    "id",
    "user_id",
    "log_id",
    "feature",
    "kind",
    "model",
    "held_credits",
    "settled_credits",
    "status",
    "ref_type",
    "ref_id",
    "created_at",
    "settled_at",
  ]);
  const logs = table("credit_logs", [
    "id",
    "user_id",
    "feature",
    "kind",
    "model",
    "input_tokens",
    "output_tokens",
    "cost_yuan",
    "credits",
    "balance_after",
    "ai_mode",
    "created_at",
  ]);
  const balanceAfter = Number(
    db.prepare("SELECT credits FROM tenants WHERE id=?").get(Number(tenantId))
      ?.credits || 0,
  );
  return {
    manualTask: {
      tasks: table("tasks", [
        "id",
        "title",
        "type",
        "status",
        "assignee_id",
        "assigned_by",
        "parent_task_id",
        "source",
        "created_at",
        "done_at",
      ]),
      submissions: table("task_submissions", [
        "id",
        "task_id",
        "user_id",
        "result",
        "source_ref_type",
        "source_ref_id",
        "reviewer_id",
        "reviewed_at",
        "created_at",
      ]),
    },
    restaurantEmployee: {
      tasks: table("agent_tasks", [
        "id",
        "marshal_id",
        "specialist_id",
        "title",
        "type",
        "status",
        "output_id",
        "created_by",
        "created_at",
      ]),
    },
    contentEmployee: {
      runs: table("content_employee_runs", [
        "id",
        "employee_idx",
        "employee_key",
        "employee_name",
        "employee_group",
        "title",
        "type",
        "status",
        "ai_mode",
        "model",
        "created_by",
        "created_at",
        "updated_at",
      ]),
    },
    billing: {
      balanceBefore: Number(watermarks?.balance || 0),
      balanceAfter,
      balanceDelta: balanceAfter - Number(watermarks?.balance || 0),
      chargedCredits: holds.reduce(
        (sum, row) => sum + Number(row.settled_credits || 0),
        0,
      ),
      inputTokens: logs.reduce(
        (sum, row) => sum + Number(row.input_tokens || 0),
        0,
      ),
      outputTokens: logs.reduce(
        (sum, row) => sum + Number(row.output_tokens || 0),
        0,
      ),
      heldCount: holds.filter((row) => row.status === "held").length,
      holds,
      logs,
    },
    approvals: table("approvals", [
      "id",
      "target_type",
      "target_id",
      "status",
      "submitter_id",
      "reviewer_id",
      "approval_level",
      "parent_id",
      "created_at",
      "decided_at",
    ]),
    assets: table("biz_assets", [
      "id",
      "name",
      "category",
      "status",
      "source_type",
      "source_id",
      "creator_id",
      "created_at",
    ]),
    knowledge: table("kb_docs", [
      "id",
      "category",
      "title",
      "source_type",
      "source_id",
      "enabled",
      "version",
      "updated_at",
    ]),
    materials: table("materials", [
      "id",
      "name",
      "type",
      "source_type",
      "source_id",
      "creator_id",
      "created_at",
    ]),
    contents: table("contents", [
      "id",
      "type",
      "title",
      "status",
      "ai_mode",
      "creator_id",
      "marshal_id",
      "content_employee_idx",
      "source_type",
      "source_id",
      "created_at",
    ]),
    notifications: table("notifications", [
      "id",
      "user_id",
      "type",
      "title",
      "body",
      "link",
      "read",
      "created_at",
    ]).map(({ body, ...row }) => ({
      ...row,
      bodySha256: hashValue(String(body || "")),
    })),
    operations: table("op_logs", [
      "id",
      "user_id",
      "username",
      "module",
      "action",
      "target",
      "created_at",
    ]),
  };
}

export function validateFinalFlowEvidence(evidence, ids) {
  const errors = [];
  const taskRows = evidence?.manualTask?.tasks || [];
  const submissionRows = evidence?.manualTask?.submissions || [];
  const parent = taskRows.find(
    (row) => Number(row.id) === Number(ids.parentTaskId),
  );
  const child = taskRows.find(
    (row) => Number(row.id) === Number(ids.childTaskId),
  );
  if (parent?.status !== "已完成") errors.push("上级人工任务未完成");
  if (child?.status !== "已完成") errors.push("下级人工任务未完成");
  if (Number(child?.parent_task_id) !== Number(parent?.id)) {
    errors.push("下级人工任务未绑定上级任务");
  }
  const childSubmissions = submissionRows.filter(
    (row) => Number(row.task_id) === Number(ids.childTaskId),
  );
  if (!childSubmissions.some((row) => row.result === "驳回")) {
    errors.push("下级人工任务缺少驳回记录");
  }
  if (!childSubmissions.some((row) => row.result === "通过")) {
    errors.push("下级人工任务缺少重提后通过记录");
  }
  const restaurantTask = (evidence?.restaurantEmployee?.tasks || []).find(
    (row) => Number(row.id) === Number(ids.restaurantTaskId),
  );
  if (restaurantTask?.status !== "已完成") {
    errors.push("餐饮数字员工任务未被人工采纳");
  }
  const contentRun = (evidence?.contentEmployee?.runs || []).find(
    (row) => Number(row.id) === Number(ids.contentRunId),
  );
  if (contentRun?.status !== "已完成") {
    errors.push("内容员工任务未被人工采纳");
  }
  const holds = evidence?.billing?.holds || [];
  const relevantRefs = new Set([
    `agent_task:${Number(ids.restaurantTaskId)}`,
    `content_employee_run:${Number(ids.contentRunId)}`,
  ]);
  const relevantHolds = holds.filter((row) =>
    relevantRefs.has(`${row.ref_type}:${Number(row.ref_id)}`),
  );
  if (relevantHolds.length !== 2)
    errors.push("两条AI任务未各自形成唯一计费占扣");
  if (relevantHolds.some((row) => row.status !== "settled")) {
    errors.push("AI任务存在未结算占扣");
  }
  if (relevantHolds.some((row) => Number(row.settled_credits || 0) <= 0)) {
    errors.push("AI任务缺少正数真实用量结算");
  }
  if (Number(evidence?.billing?.inputTokens || 0) <= 0) {
    errors.push("真实AI输入token证据缺失");
  }
  if (Number(evidence?.billing?.outputTokens || 0) <= 0) {
    errors.push("真实AI输出token证据缺失");
  }
  if (Number(evidence?.billing?.heldCount || 0) !== 0) {
    errors.push("仍有本轮悬挂占扣");
  }
  if (!(evidence?.approvals || []).some((row) => row.status === "已通过")) {
    errors.push("缺少人工审批通过记录");
  }
  if (!(evidence?.assets || []).length) errors.push("缺少业务资产沉淀");
  if (!(evidence?.knowledge || []).length) errors.push("缺少知识库沉淀");
  if (!(evidence?.materials || []).length) errors.push("缺少内容素材沉淀");
  if (!(evidence?.notifications || []).length) errors.push("缺少通知流向证据");
  if (!(evidence?.operations || []).length) errors.push("缺少操作日志证据");
  return { ok: errors.length === 0, errors };
}

function idEquals(value, expected) {
  return Number(value) === Number(expected);
}

function findExact(rows, predicate) {
  return (Array.isArray(rows) ? rows : []).filter(predicate);
}

export function validateBoundFlowEvidence(evidence, ids, actors) {
  const errors = [...validateFinalFlowEvidence(evidence, ids).errors];
  const tasks = evidence?.manualTask?.tasks || [];
  const submissions = evidence?.manualTask?.submissions || [];
  const parent = tasks.find((row) => idEquals(row.id, ids.parentTaskId));
  const child = tasks.find((row) => idEquals(row.id, ids.childTaskId));
  if (!parent || !idEquals(parent.assigned_by, actors?.boss?.id) || !idEquals(parent.assignee_id, actors?.management?.id)) {
    errors.push("上级人工任务未绑定本次老板和管理层账号");
  }
  if (!child || !idEquals(child.assigned_by, actors?.management?.id) || !idEquals(child.assignee_id, actors?.employee?.id)) {
    errors.push("下级人工任务未绑定本次管理层和员工账号");
  }
  const childSubmissions = findExact(submissions, (row) => idEquals(row.task_id, ids.childTaskId));
  if (
    childSubmissions.length !== 2 ||
    childSubmissions[0]?.result !== "驳回" ||
    childSubmissions[1]?.result !== "通过" ||
    childSubmissions.some(
      (row) => !idEquals(row.user_id, actors?.employee?.id) || !idEquals(row.reviewer_id, actors?.management?.id),
    )
  ) {
    errors.push("下级任务驳回/重提未精确绑定本次员工与管理层");
  }
  const parentSubmissions = findExact(submissions, (row) => idEquals(row.task_id, ids.parentTaskId));
  if (
    parentSubmissions.length !== 1 ||
    parentSubmissions[0]?.result !== "通过" ||
    !idEquals(parentSubmissions[0]?.user_id, actors?.management?.id) ||
    !idEquals(parentSubmissions[0]?.reviewer_id, actors?.boss?.id)
  ) {
    errors.push("上级任务提交/审核未精确绑定本次管理层与老板");
  }

  const restaurantTask = (evidence?.restaurantEmployee?.tasks || []).find(
    (row) => idEquals(row.id, ids.restaurantTaskId),
  );
  if (
    !restaurantTask ||
    !idEquals(restaurantTask.created_by, actors?.management?.id) ||
    !idEquals(restaurantTask.specialist_id, ids.restaurantSpecialistId) ||
    !idEquals(restaurantTask.output_id, ids.restaurantOutputId)
  ) {
    errors.push("餐饮任务未绑定本次管理层、岗位和产出");
  }
  const restaurantContent = (evidence?.contents || []).find(
    (row) => idEquals(row.id, ids.restaurantOutputId),
  );
  if (
    !restaurantContent ||
    restaurantContent.status !== "可使用" ||
    restaurantContent.ai_mode !== "api" ||
    !idEquals(restaurantContent.creator_id, actors?.management?.id) ||
    !idEquals(restaurantContent.marshal_id, restaurantTask?.marshal_id)
  ) {
    errors.push("餐饮产出终态或创建人/部门血缘不正确");
  }
  const restaurantApprovals = findExact(
    evidence?.approvals,
    (row) => row.target_type === "content" && idEquals(row.target_id, ids.restaurantOutputId),
  );
  if (
    restaurantApprovals.length !== 1 ||
    restaurantApprovals[0]?.status !== "已通过" ||
    !idEquals(restaurantApprovals[0]?.submitter_id, actors?.management?.id) ||
    !idEquals(restaurantApprovals[0]?.reviewer_id, actors?.boss?.id)
  ) {
    errors.push("餐饮审批未精确绑定本次产出、提交人和老板");
  }
  const restaurantAssets = findExact(
    evidence?.assets,
    (row) => row.source_type === "content" && idEquals(row.source_id, ids.restaurantOutputId),
  );
  if (
    restaurantAssets.length !== 1 ||
    !idEquals(restaurantAssets[0]?.id, ids.restaurantAssetId) ||
    !idEquals(restaurantAssets[0]?.creator_id, actors?.management?.id)
  ) {
    errors.push("餐饮业务资产未精确绑定本次产出与创建人");
  }
  const restaurantKnowledge = findExact(
    evidence?.knowledge,
    (row) => row.source_type === "content" && idEquals(row.source_id, ids.restaurantOutputId),
  );
  if (
    restaurantKnowledge.length !== 1 ||
    !idEquals(restaurantKnowledge[0]?.id, ids.restaurantKnowledgeId) ||
    Number(restaurantKnowledge[0]?.enabled) !== 1
  ) {
    errors.push("餐饮知识沉淀未精确绑定本次产出");
  }

  const contentRun = (evidence?.contentEmployee?.runs || []).find(
    (row) => idEquals(row.id, ids.contentRunId),
  );
  if (
    !contentRun ||
    !idEquals(contentRun.created_by, actors?.employee?.id) ||
    !idEquals(contentRun.employee_idx, ids.contentEmployeeIdx)
  ) {
    errors.push("内容员工运行未绑定本次员工账号与岗位");
  }
  const contentRow = (evidence?.contents || []).find((row) => idEquals(row.id, ids.contentId));
  if (
    !contentRow ||
    contentRow.source_type !== "content_employee_run" ||
    !idEquals(contentRow.source_id, ids.contentRunId) ||
    contentRow.status !== "可使用" ||
    contentRow.ai_mode !== "api" ||
    !idEquals(contentRow.creator_id, actors?.employee?.id)
  ) {
    errors.push("内容产出终态或运行/创建人血缘不正确");
  }
  const contentMaterials = findExact(
    evidence?.materials,
    (row) => row.source_type === "content_employee_run" && idEquals(row.source_id, ids.contentRunId),
  );
  if (
    contentMaterials.length !== 1 ||
    !idEquals(contentMaterials[0]?.id, ids.contentMaterialId) ||
    !idEquals(contentMaterials[0]?.creator_id, actors?.employee?.id)
  ) {
    errors.push("内容素材未精确绑定本次运行与员工");
  }
  const contentApprovals = findExact(
    evidence?.approvals,
    (row) => row.target_type === "content" && idEquals(row.target_id, ids.contentId),
  );
  if (
    contentApprovals.length !== 1 ||
    contentApprovals[0]?.status !== "已通过" ||
    !idEquals(contentApprovals[0]?.submitter_id, actors?.employee?.id) ||
    !idEquals(contentApprovals[0]?.reviewer_id, actors?.boss?.id)
  ) {
    errors.push("内容审批未精确绑定本次内容、员工和老板");
  }
  const contentAssets = findExact(
    evidence?.assets,
    (row) => row.source_type === "content" && idEquals(row.source_id, ids.contentId),
  );
  if (
    contentAssets.length !== 1 ||
    !idEquals(contentAssets[0]?.creator_id, actors?.employee?.id)
  ) {
    errors.push("内容业务资产未绑定本次可使用内容与员工");
  }

  const notifications = evidence?.notifications || [];
  if (!notifications.some((row) =>
    idEquals(row.user_id, actors?.management?.id)
      && row.bodySha256 === hashValue(String(parent?.title || "")))) {
    errors.push("上级任务通知未绑定本次管理层与任务标题");
  }
  if (!notifications.some((row) =>
    idEquals(row.user_id, actors?.employee?.id)
      && row.bodySha256 === hashValue(String(child?.title || "")))) {
    errors.push("下级任务通知未绑定本次员工与任务标题");
  }
  if (!notifications.some((row) =>
    idEquals(row.user_id, actors?.management?.id)
      && String(row.title || "").includes(String(restaurantTask?.title || ""))
      && String(row.link || "").includes(`task=${ids.restaurantTaskId}`))) {
    errors.push("餐饮完成通知未绑定本次管理层与任务ID");
  }
  if (!notifications.some((row) =>
    idEquals(row.user_id, actors?.employee?.id)
      && String(row.title || "").includes(String(contentRun?.title || "")))) {
    errors.push("内容完成/采纳通知未绑定本次员工与运行标题");
  }
  const operations = evidence?.operations || [];
  if (!operations.some((row) =>
    idEquals(row.user_id, actors?.boss?.id)
      && row.action === "新建任务"
      && row.target === parent?.title)) {
    errors.push("上级任务日志未绑定本次老板与任务");
  }
  if (!operations.some((row) =>
    idEquals(row.user_id, actors?.management?.id)
      && row.action === "拆解下级任务"
      && row.target === `${child?.title} / parent#${ids.parentTaskId}`)) {
    errors.push("下级任务日志未绑定本次管理层、任务与上级ID");
  }
  if (!operations.some((row) =>
    idEquals(row.user_id, actors?.management?.id)
      && row.action === "人工验收通过"
      && String(row.target || "").startsWith(`task#${ids.childTaskId}`))) {
    errors.push("下级验收日志未绑定本次管理层与任务ID");
  }
  if (!operations.some((row) =>
    idEquals(row.user_id, actors?.boss?.id)
      && row.action === "人工验收通过"
      && String(row.target || "").startsWith(`task#${ids.parentTaskId}`))) {
    errors.push("上级验收日志未绑定本次老板与任务ID");
  }
  if (!operations.some((row) =>
    idEquals(row.user_id, actors?.management?.id)
      && row.action === "派发任务"
      && String(row.target || "").includes(String(restaurantTask?.title || "")))) {
    errors.push("餐饮派活日志未绑定本次管理层与任务");
  }
  if (!operations.some((row) =>
    idEquals(row.user_id, actors?.employee?.id)
      && row.action === "派发内容员工任务"
      && String(row.target || "").includes(`run#${ids.contentRunId}:`))) {
    errors.push("内容派活日志未绑定本次员工与运行ID");
  }
  if (
    !operations.some(
      (row) => idEquals(row.user_id, actors?.boss?.id) && row.action === "采纳产出" && row.target === `content#${ids.restaurantOutputId}`,
    )
  ) {
    errors.push("餐饮采纳操作日志未绑定本次老板与产出");
  }
  const contentTarget = `run#${ids.contentRunId}/material#${ids.contentMaterialId}/content#${ids.contentId}；未执行外发`;
  if (
    !operations.some(
      (row) => idEquals(row.user_id, actors?.boss?.id)
        && row.action === "采纳内容员工产出并入素材库"
        && row.target === contentTarget,
    )
  ) {
    errors.push("内容采纳操作日志未绑定本次老板、运行、素材与内容");
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function summarizeRunChecks(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const passed = list.filter((item) => item?.ok === true).length;
  return {
    count: list.length,
    passed,
    failed: list.length - passed,
    forbiddenChecks: list.filter((item) => item?.status === 403).length,
  };
}

export function computeFilesFingerprint(filePaths) {
  const entries = [...new Set(filePaths.map((item) => fs.realpathSync(item)))]
    .sort()
    .map((file) => ({
      name: path.basename(file),
      sha256: hashValue(fs.readFileSync(file)),
    }));
  return { files: entries, sha256: hashValue(entries) };
}

export function computeScenarioFingerprint(value) {
  return hashValue({ schema: LIVE_ROLE_FLOW_MATRIX_SCHEMA, scenario: value });
}

function assertNoCheckpointSecrets(value, trace = "checkpoint") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCheckpointSecrets(item, `${trace}[${index}]`));
    return;
  }
  if (!plainObject(value)) {
    if (typeof value === "string" && SECRET_VALUE_RE.test(value)) {
      SECRET_VALUE_RE.lastIndex = 0;
      throw new Error(`${trace}包含敏感值`);
    }
    SECRET_VALUE_RE.lastIndex = 0;
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) throw new Error(`${trace}.${key}是禁止的敏感字段`);
    assertNoCheckpointSecrets(item, `${trace}.${key}`);
  }
}

export function validateCheckpoint(
  checkpoint,
  {
    batchNonceSha256,
    databaseIdentitySha256,
    codeFingerprint,
    scenarioFingerprint,
    outputPath,
  } = {},
) {
  assert.ok(plainObject(checkpoint), "checkpoint必须是JSON对象");
  assertNoCheckpointSecrets(checkpoint);
  assert.equal(checkpoint.schema, LIVE_ROLE_FLOW_CHECKPOINT_SCHEMA, "checkpoint schema不兼容");
  assert.ok(["running", "interrupted", "failed"].includes(checkpoint.status), "checkpoint状态不可恢复");
  assert.equal(checkpoint.batchNonceSha256, batchNonceSha256, "checkpoint batch nonce不匹配");
  assert.equal(checkpoint.databaseIdentitySha256, databaseIdentitySha256, "checkpoint数据库身份不匹配");
  assert.equal(checkpoint.codeFingerprint, codeFingerprint, "checkpoint代码指纹已变更");
  assert.equal(checkpoint.scenarioFingerprint, scenarioFingerprint, "checkpoint场景指纹已变更");
  assert.equal(path.resolve(checkpoint.outputPath), path.resolve(outputPath), "checkpoint输出目标不匹配");
  assert.ok(plainObject(checkpoint.stages), "checkpoint缺少stages");
  assert.ok(plainObject(checkpoint.ids), "checkpoint缺少ids");
  assert.ok(plainObject(checkpoint.actorIds), "checkpoint缺少actorIds");
  assert.deepEqual(
    Object.keys(checkpoint.actorIds).sort(),
    [...CREDENTIAL_ROLES].sort(),
    "checkpoint actorIds角色集合不完整",
  );
  const actorIds = CREDENTIAL_ROLES.map((lane) => Number(checkpoint.actorIds[lane]));
  assert.ok(
    actorIds.every((id) => Number.isSafeInteger(id) && id > 0),
    "checkpoint actorIds必须是正整数",
  );
  assert.equal(new Set(actorIds).size, actorIds.length, "checkpoint actorIds必须互不相同");
  assert.ok(
    checkpoint.providerFingerprint == null || /^[a-f0-9]{64}$/u.test(checkpoint.providerFingerprint),
    "checkpoint providerFingerprint无效",
  );
  return checkpoint;
}

export function writeJsonAtomic0600(outputPath, value) {
  assertNoCheckpointSecrets(value);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`;
  let descriptor;
  let created = false;
  try {
    if (process.platform === "win32") {
      createPrivateArtifact(temporary);
      created = true;
      descriptor = fs.openSync(temporary, "r+");
    } else {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      created = true;
    }
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, outputPath);
    fs.chmodSync(outputPath, 0o600);
    syncArtifactPublication(outputPath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      if (created) fs.unlinkSync(temporary);
    } catch {
      // Rename already consumed the temporary file on success.
    }
  }
}

function normalizeLookupRows(value, label) {
  const rows = value == null ? [] : Array.isArray(value) ? value : [value];
  if (rows.length > 1) throw new Error(`${label}: nonce匹配到多条记录，拒绝继续`);
  return rows;
}

export async function reconcileNonceMutation({ label, lookup, mutate, validate }) {
  const before = normalizeLookupRows(await lookup(), label);
  if (before.length === 1) {
    if (validate) await validate(before[0]);
    return { row: before[0], reconciled: true, submitted: false };
  }
  let response;
  try {
    response = await mutate();
  } catch (error) {
    const afterUnknown = normalizeLookupRows(await lookup(), label);
    if (afterUnknown.length === 1) {
      if (validate) await validate(afterUnknown[0], response);
      return {
        row: afterUnknown[0],
        reconciled: true,
        submitted: true,
        recoveredAfterUnknownOutcome: true,
      };
    }
    error.unknownMutationOutcomeReconciled = true;
    throw error;
  }
  const after = normalizeLookupRows(await lookup(), label);
  if (after.length !== 1) {
    throw new Error(`${label}: 请求成功后未能按nonce回读唯一业务记录`);
  }
  if (validate) await validate(after[0], response);
  return { row: after[0], response, reconciled: false, submitted: true };
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const EMPLOYEE_SKILLS_VERIFICATION_CATALOG_PATH = path.join(
  __dirname,
  "..",
  "..",
  "catalog",
  "employee-skills.json",
);
export const EMPLOYEE_SKILL_EVIDENCE_CATALOG_PATH =
  EMPLOYEE_SKILLS_VERIFICATION_CATALOG_PATH;
export const EMPLOYEE_SKILLS_VERIFICATION_SCHEMA =
  "paihuo-employee-skills-verification.v1";
export const EMPLOYEE_SKILL_VERIFICATION_LEVEL = "catalog_contract_verified";
// 产品执行态：目录中的 409 张技能卡默认启用并由岗位锁定加载。
// 保留源目录的 legacy_unverified 作为审计 provenance，不把旧来源状态冒充为产品执行状态。
export const EMPLOYEE_SKILL_OWNER_VERIFICATION_STATUS = "owner_verified_enabled";
export const EMPLOYEE_SKILL_EFFECT_VALIDATION = "requires_live_business_sample";
export const EMPLOYEE_SKILL_FINGERPRINT_ALGORITHM =
  "sha256-canonical-skill-payload-v1";
export const EMPLOYEE_SKILL_ID_ALGORITHM = "employee-ordinal-v1";

const PROVEN_CLAIMS = Object.freeze([
  "catalog_integrity",
  "execution_injection_contract",
]);
const EXCLUDED_CLAIMS = Object.freeze([
  "third_party_source_truth",
  "third_party_algorithm_validity",
  "business_outcome",
  "real_time_effectiveness",
]);
const EXPECTED_EMPLOYEE_INDEXES = Object.freeze([
  ...Array.from({ length: 10 }, (_, index) => index),
  ...Array.from({ length: 60 }, (_, index) => index + 101),
]);
const EXPECTED_SOURCE_SNAPSHOT = Object.freeze({
  date: "2026-07-18",
  sha256: "614631670ec39a8b32f2a511053ad27e1e06af4a260bcb819edf4e88984793e0",
  kind: "legacy_database_allowlist_export",
});
const ENTRY_KEYS = Object.freeze([
  "id",
  "employeeIdx",
  "roleBinding",
  "version",
  "sourceSnapshot",
  "contentFingerprint",
  "offlineAcceptanceFixture",
  "verificationLevel",
  "effectValidation",
]);

function fail(message) {
  throw new Error(`员工技能验证证据无效：${message}`);
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label}必须是对象`);
  }
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label}不能为空`);
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label}字段必须为${wanted.join("、")}`);
  }
}

function sameValue(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}不一致`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalSkillPayload(profile, skill) {
  return {
    employeeIdx: profile.idx,
    roleKey: profile.key,
    title: skill.title,
    detail: skill.detail,
    source: skill.source,
    enabled: skill.enabled,
    learnedAt: skill.learnedAt,
    verificationStatus: skill.verificationStatus,
    sourceSnapshot: {
      date: skill.sourceSnapshot?.date,
      sha256: skill.sourceSnapshot?.sha256,
      kind: skill.sourceSnapshot?.kind,
    },
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function employeeSkillContentFingerprint(profile, skill) {
  return `sha256:${sha256(JSON.stringify(canonicalSkillPayload(profile, skill)))}`;
}

export function employeeSkillStableId(employeeIdx, skillOrdinal) {
  if (
    !Number.isInteger(employeeIdx) ||
    !Number.isInteger(skillOrdinal) ||
    skillOrdinal < 1
  ) {
    fail("稳定ID参数不正确");
  }
  return `legacy-skill:v1:e${String(employeeIdx).padStart(3, "0")}:s${String(skillOrdinal).padStart(3, "0")}`;
}

function expectedRoleBinding(profile) {
  return {
    key: profile.key,
    name: profile.name,
    group: profile.group,
    department: profile.department,
  };
}

function expectedFixture(entry, profile) {
  return {
    sampleTask: `离线验收：将“${entry.id}”注入“${profile.name}”执行上下文，仅核对目录字段与岗位绑定。`,
    expectedInjection: {
      skillId: entry.id,
      employeeIdx: profile.idx,
      roleKey: profile.key,
      contentFingerprint: entry.contentFingerprint,
      verificationLevel: EMPLOYEE_SKILL_VERIFICATION_LEVEL,
      effectValidation: EMPLOYEE_SKILL_EFFECT_VALIDATION,
    },
  };
}

function validateRootCatalog(value) {
  objectValue(value, "根节点");
  if (value.schemaVersion !== "paihuo-employee-skills.v1") {
    fail("技能目录schemaVersion不正确");
  }
  objectValue(value.source, "source");
  objectValue(value.source.snapshot, "source.snapshot");
  sameValue(value.source.snapshot, EXPECTED_SOURCE_SNAPSHOT, "source.snapshot");
  if (
    value.employeeCount !== 70 ||
    value.skillCount !== 409 ||
    value.contentSkillCount !== 65 ||
    value.restaurantSkillCount !== 344
  ) {
    fail("技能目录声明数量不正确");
  }
  if (!Array.isArray(value.profiles) || value.profiles.length !== 70) {
    fail("必须恰好包含70个岗位档案");
  }
}

function validateEvidenceHeader(evidence) {
  objectValue(evidence, "verificationEvidence");
  if (evidence.schemaVersion !== EMPLOYEE_SKILLS_VERIFICATION_SCHEMA) {
    fail("verificationEvidence.schemaVersion不正确");
  }
  if (evidence.idAlgorithm !== EMPLOYEE_SKILL_ID_ALGORITHM) {
    fail("verificationEvidence.idAlgorithm不正确");
  }
  if (
    evidence.contentFingerprintAlgorithm !==
    EMPLOYEE_SKILL_FINGERPRINT_ALGORITHM
  ) {
    fail("verificationEvidence.contentFingerprintAlgorithm不正确");
  }
  objectValue(evidence.policy, "verificationEvidence.policy");
  exactKeys(
    evidence.policy,
    ["verificationLevel", "proves", "doesNotProve"],
    "verificationEvidence.policy",
  );
  if (evidence.policy.verificationLevel !== EMPLOYEE_SKILL_VERIFICATION_LEVEL) {
    fail("verificationEvidence.policy.verificationLevel不正确");
  }
  sameValue(
    evidence.policy.proves,
    PROVEN_CLAIMS,
    "verificationEvidence.policy.proves",
  );
  sameValue(
    evidence.policy.doesNotProve,
    EXCLUDED_CLAIMS,
    "verificationEvidence.policy.doesNotProve",
  );
  if (!Array.isArray(evidence.entries) || evidence.entries.length !== 409) {
    fail("verificationEvidence.entries必须恰好包含409项");
  }
}

function validateOriginalSkill(profile, skill, skillOrdinal) {
  objectValue(skill, `员工${profile.idx}技能${skillOrdinal}`);
  for (const field of ["title", "detail", "source"]) {
    nonEmpty(skill[field], `员工${profile.idx}技能${skillOrdinal}.${field}`);
  }
  if (
    skill.enabled !== true ||
    skill.verificationStatus !== "legacy_unverified"
  ) {
    fail(`员工${profile.idx}技能${skillOrdinal}必须保持legacy_unverified`);
  }
  objectValue(
    skill.sourceSnapshot,
    `员工${profile.idx}技能${skillOrdinal}.sourceSnapshot`,
  );
  sameValue(
    skill.sourceSnapshot,
    EXPECTED_SOURCE_SNAPSHOT,
    `员工${profile.idx}技能${skillOrdinal}.sourceSnapshot`,
  );
}

function validateEvidenceEntry(entry, profile, skill, skillOrdinal) {
  const label = `员工${profile.idx}技能${skillOrdinal}证据`;
  objectValue(entry, label);
  exactKeys(entry, ENTRY_KEYS, label);
  const expectedId = employeeSkillStableId(profile.idx, skillOrdinal);
  if (entry.id !== expectedId) fail(`${label}.id不稳定或顺序错位`);
  if (entry.employeeIdx !== profile.idx) fail(`${label}.employeeIdx错岗`);
  sameValue(
    entry.roleBinding,
    expectedRoleBinding(profile),
    `${label}.roleBinding岗位绑定`,
  );
  if (entry.version !== "1.0.0") fail(`${label}.version不正确`);
  sameValue(
    entry.sourceSnapshot,
    skill.sourceSnapshot,
    `${label}.sourceSnapshot`,
  );
  const expectedFingerprint = employeeSkillContentFingerprint(profile, skill);
  if (entry.contentFingerprint !== expectedFingerprint) {
    fail(`${label}.contentFingerprint与目录内容不匹配`);
  }
  if (entry.verificationLevel !== EMPLOYEE_SKILL_VERIFICATION_LEVEL) {
    fail(`${label}.verificationLevel越界`);
  }
  if (entry.effectValidation !== EMPLOYEE_SKILL_EFFECT_VALIDATION) {
    fail(`${label}.effectValidation不得声称业务效果已验证`);
  }
  objectValue(
    entry.offlineAcceptanceFixture,
    `${label}.offlineAcceptanceFixture`,
  );
  exactKeys(
    entry.offlineAcceptanceFixture,
    ["sampleTask", "expectedInjection"],
    `${label}.offlineAcceptanceFixture`,
  );
  nonEmpty(
    entry.offlineAcceptanceFixture.sampleTask,
    `${label}.offlineAcceptanceFixture.sampleTask`,
  );
  objectValue(
    entry.offlineAcceptanceFixture.expectedInjection,
    `${label}.offlineAcceptanceFixture.expectedInjection`,
  );
  sameValue(
    entry.offlineAcceptanceFixture,
    expectedFixture(entry, profile),
    `${label}.offlineAcceptanceFixture`,
  );
}

export function validateEmployeeSkillsVerificationCatalog(value) {
  validateRootCatalog(value);
  const evidence = value.verificationEvidence;
  validateEvidenceHeader(evidence);

  const seenEmployeeIndexes = new Set();
  const seenIds = new Set();
  let evidenceCursor = 0;
  let contentSkillCount = 0;
  let restaurantSkillCount = 0;

  value.profiles.forEach((profile, profileOrder) => {
    objectValue(profile, `岗位${profileOrder}`);
    const expectedEmployeeIdx = EXPECTED_EMPLOYEE_INDEXES[profileOrder];
    if (profile.idx !== expectedEmployeeIdx) {
      fail(
        `岗位顺序不正确，位置${profileOrder}必须为员工${expectedEmployeeIdx}`,
      );
    }
    if (seenEmployeeIndexes.has(profile.idx))
      fail(`员工${profile.idx}岗位重复`);
    seenEmployeeIndexes.add(profile.idx);
    for (const field of ["key", "name", "group", "department"]) {
      nonEmpty(profile[field], `员工${profile.idx}.${field}`);
    }
    if (
      !Array.isArray(profile.skills) ||
      profile.skills.length !== profile.expectedSkillCount
    ) {
      fail(`员工${profile.idx}技能数量与expectedSkillCount不一致`);
    }

    profile.skills.forEach((skill, skillIndex) => {
      const skillOrdinal = skillIndex + 1;
      validateOriginalSkill(profile, skill, skillOrdinal);
      const entry = evidence.entries[evidenceCursor];
      validateEvidenceEntry(entry, profile, skill, skillOrdinal);
      if (seenIds.has(entry.id)) fail(`证据ID重复：${entry.id}`);
      seenIds.add(entry.id);
      evidenceCursor += 1;
    });

    if (profile.idx < 10) contentSkillCount += profile.skills.length;
    else restaurantSkillCount += profile.skills.length;
  });

  if (
    seenEmployeeIndexes.size !== 70 ||
    evidenceCursor !== 409 ||
    seenIds.size !== 409
  ) {
    fail("岗位或证据覆盖数量不完整");
  }
  if (contentSkillCount !== 65 || restaurantSkillCount !== 344) {
    fail(
      `技能分层数量不正确：内容${contentSkillCount}/餐饮${restaurantSkillCount}`,
    );
  }

  return deepFreeze(value);
}

export function loadEmployeeSkillsVerificationCatalog(
  catalogPath = EMPLOYEE_SKILLS_VERIFICATION_CATALOG_PATH,
) {
  try {
    const source = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    return validateEmployeeSkillsVerificationCatalog(source);
  } catch (error) {
    if (String(error?.message || "").startsWith("员工技能验证证据无效："))
      throw error;
    throw new Error(
      `员工技能验证证据读取失败（${catalogPath}）：${error.message}`,
    );
  }
}

export const validateEmployeeSkillEvidenceCatalog =
  validateEmployeeSkillsVerificationCatalog;
export const loadEmployeeSkillEvidenceCatalog =
  loadEmployeeSkillsVerificationCatalog;

function evidenceById(catalog) {
  return new Map(
    catalog.verificationEvidence.entries.map((entry) => [entry.id, entry]),
  );
}

export function verifiedEmployeeSkillsFor(catalogValue, employeeIdx) {
  const catalog = validateEmployeeSkillsVerificationCatalog(catalogValue);
  const profile = catalog.profiles.find(
    (candidate) => candidate.idx === employeeIdx,
  );
  if (!profile) return Object.freeze([]);
  const evidenceIndex = evidenceById(catalog);
  const skills = profile.skills.map((skill, skillIndex) => {
    const id = employeeSkillStableId(profile.idx, skillIndex + 1);
    const evidence = evidenceIndex.get(id);
    return deepFreeze({
      id,
      employeeIdx: profile.idx,
      roleKey: profile.key,
      title: skill.title,
      detail: skill.detail,
      source: skill.source,
      enabled: skill.enabled,
      learnedAt: skill.learnedAt,
      // 对外执行态已经完成目录完整性与默认注入校验；原始来源状态继续保留，供审计与追溯。
      verificationStatus: EMPLOYEE_SKILL_OWNER_VERIFICATION_STATUS,
      legacyVerificationStatus: skill.verificationStatus,
      version: evidence.version,
      sourceSnapshot: evidence.sourceSnapshot,
      contentFingerprint: evidence.contentFingerprint,
      offlineAcceptanceFixture: evidence.offlineAcceptanceFixture,
      verificationLevel: evidence.verificationLevel,
      effectValidation: evidence.effectValidation,
    });
  });
  return Object.freeze(skills);
}

export const EMPLOYEE_SKILLS_VERIFIED_CATALOG =
  loadEmployeeSkillsVerificationCatalog();
export const EMPLOYEE_SKILL_EVIDENCE_CATALOG = EMPLOYEE_SKILLS_VERIFIED_CATALOG;

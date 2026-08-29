import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPLOYEE_SKILL_EFFECT_VALIDATION,
  EMPLOYEE_SKILL_EVIDENCE_CATALOG,
  EMPLOYEE_SKILL_EVIDENCE_CATALOG_PATH,
  EMPLOYEE_SKILL_FINGERPRINT_ALGORITHM,
  EMPLOYEE_SKILL_ID_ALGORITHM,
  EMPLOYEE_SKILL_OWNER_VERIFICATION_STATUS,
  EMPLOYEE_SKILL_VERIFICATION_LEVEL,
  EMPLOYEE_SKILLS_VERIFICATION_SCHEMA,
  employeeSkillContentFingerprint,
  employeeSkillStableId,
  loadEmployeeSkillEvidenceCatalog,
  validateEmployeeSkillEvidenceCatalog,
  verifiedEmployeeSkillsFor,
} from "../src/catalog/employee-skills-verification.js";

const SOURCE_SNAPSHOT = {
  date: "2026-07-18",
  sha256: "614631670ec39a8b32f2a511053ad27e1e06af4a260bcb819edf4e88984793e0",
  kind: "legacy_database_allowlist_export",
};

function mutableCatalog() {
  return structuredClone(EMPLOYEE_SKILL_EVIDENCE_CATALOG);
}

test("409项历史技能证据完整覆盖70个岗位并保持确定性标识", () => {
  const catalog = loadEmployeeSkillEvidenceCatalog(
    EMPLOYEE_SKILL_EVIDENCE_CATALOG_PATH,
  );
  const evidence = catalog.verificationEvidence;
  assert.equal(evidence.schemaVersion, EMPLOYEE_SKILLS_VERIFICATION_SCHEMA);
  assert.equal(evidence.idAlgorithm, EMPLOYEE_SKILL_ID_ALGORITHM);
  assert.equal(
    evidence.contentFingerprintAlgorithm,
    EMPLOYEE_SKILL_FINGERPRINT_ALGORITHM,
  );
  assert.equal(catalog.profiles.length, 70);
  assert.equal(evidence.entries.length, 409);
  assert.equal(
    new Set(catalog.profiles.map((profile) => profile.idx)).size,
    70,
  );
  assert.equal(new Set(evidence.entries.map((entry) => entry.id)).size, 409);

  let cursor = 0;
  let materializedCount = 0;
  for (const profile of catalog.profiles) {
    assert.equal(profile.expectedSkillCount, profile.skills.length);
    const materialized = verifiedEmployeeSkillsFor(catalog, profile.idx);
    assert.equal(materialized.length, profile.skills.length);
    materializedCount += materialized.length;

    profile.skills.forEach((skill, skillIndex) => {
      const entry = evidence.entries[cursor];
      const expectedId = employeeSkillStableId(profile.idx, skillIndex + 1);
      assert.equal(entry.id, expectedId);
      assert.equal(entry.employeeIdx, profile.idx);
      assert.deepEqual(entry.roleBinding, {
        key: profile.key,
        name: profile.name,
        group: profile.group,
        department: profile.department,
      });
      assert.equal(entry.version, "1.0.0");
      assert.deepEqual(entry.sourceSnapshot, SOURCE_SNAPSHOT);
      assert.equal(
        entry.contentFingerprint,
        employeeSkillContentFingerprint(profile, skill),
      );
      assert.match(entry.contentFingerprint, /^sha256:[a-f0-9]{64}$/);
      assert.ok(entry.offlineAcceptanceFixture.sampleTask.trim());
      assert.equal(entry.verificationLevel, EMPLOYEE_SKILL_VERIFICATION_LEVEL);
      assert.equal(entry.effectValidation, EMPLOYEE_SKILL_EFFECT_VALIDATION);
      cursor += 1;
    });
  }

  assert.equal(cursor, 409);
  assert.equal(materializedCount, 409);
  assert.equal(verifiedEmployeeSkillsFor(catalog, 999).length, 0);
});

test("证据只证明目录完整与执行注入契约，不把历史资料冒充实时效果", () => {
  const catalog = EMPLOYEE_SKILL_EVIDENCE_CATALOG;
  assert.deepEqual(catalog.verificationEvidence.policy, {
    verificationLevel: "catalog_contract_verified",
    proves: ["catalog_integrity", "execution_injection_contract"],
    doesNotProve: [
      "third_party_source_truth",
      "third_party_algorithm_validity",
      "business_outcome",
      "real_time_effectiveness",
    ],
  });

  let projectionCount = 0;
  for (const profile of catalog.profiles) {
    const projection = verifiedEmployeeSkillsFor(catalog, profile.idx);
    projection.forEach((injected, skillIndex) => {
      const original = profile.skills[skillIndex];
      const fixture = injected.offlineAcceptanceFixture.expectedInjection;
      assert.equal(injected.title, original.title);
      assert.equal(injected.detail, original.detail);
      assert.equal(injected.source, original.source);
      assert.equal(injected.verificationStatus, EMPLOYEE_SKILL_OWNER_VERIFICATION_STATUS);
      assert.equal(injected.legacyVerificationStatus, "legacy_unverified");
      assert.equal(fixture.skillId, injected.id);
      assert.equal(fixture.employeeIdx, injected.employeeIdx);
      assert.equal(fixture.roleKey, injected.roleKey);
      assert.equal(fixture.contentFingerprint, injected.contentFingerprint);
      assert.equal(fixture.verificationLevel, "catalog_contract_verified");
      assert.equal(fixture.effectValidation, "requires_live_business_sample");
      assert.ok(Object.isFrozen(injected));
      projectionCount += 1;
    });
  }
  assert.equal(projectionCount, 409);
});

test("错岗、内容篡改、空样本、来源快照和数量异常均拒绝加载", async (t) => {
  await t.test("拒绝错岗绑定", () => {
    const invalid = mutableCatalog();
    invalid.verificationEvidence.entries[0].roleBinding.key =
      invalid.profiles[1].key;
    assert.throws(
      () => validateEmployeeSkillEvidenceCatalog(invalid),
      /roleBinding岗位绑定不一致/,
    );
  });

  await t.test("拒绝内容篡改导致的指纹不匹配", () => {
    const invalid = mutableCatalog();
    invalid.profiles[0].skills[0].detail += "篡改";
    assert.throws(
      () => validateEmployeeSkillEvidenceCatalog(invalid),
      /contentFingerprint与目录内容不匹配/,
    );
  });

  await t.test("拒绝空离线验收样本", () => {
    const invalid = mutableCatalog();
    invalid.verificationEvidence.entries[0].offlineAcceptanceFixture.sampleTask =
      "  ";
    assert.throws(
      () => validateEmployeeSkillEvidenceCatalog(invalid),
      /sampleTask不能为空/,
    );
  });

  await t.test("拒绝来源快照错配", () => {
    const invalid = mutableCatalog();
    invalid.verificationEvidence.entries[0].sourceSnapshot.sha256 = "0".repeat(
      64,
    );
    assert.throws(
      () => validateEmployeeSkillEvidenceCatalog(invalid),
      /sourceSnapshot不一致/,
    );
  });

  await t.test("拒绝缺失证据", () => {
    const invalid = mutableCatalog();
    invalid.verificationEvidence.entries.pop();
    assert.throws(
      () => validateEmployeeSkillEvidenceCatalog(invalid),
      /必须恰好包含409项/,
    );
  });

  await t.test("拒绝岗位缺失", () => {
    const invalid = mutableCatalog();
    invalid.profiles.pop();
    assert.throws(
      () => validateEmployeeSkillEvidenceCatalog(invalid),
      /必须恰好包含70个岗位档案/,
    );
  });
});

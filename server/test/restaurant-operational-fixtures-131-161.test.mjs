import assert from "node:assert/strict";
import test from "node:test";
import {
  assessRestaurantTaskCompleteness,
} from "../../scripts/lib/restaurant-required-input-facts.mjs";
import {
  buildRestaurantDispatch,
  buildRestaurantRequiredInputEvidence,
  validateRestaurantDispatchEvidence,
} from "../../scripts/lib/real-employee-matrix.mjs";
import { loadRestaurantCatalog } from "../../server/src/catalog/restaurant.js";
import {
  RESTAURANT_OPERATIONAL_FIXTURE_FACTS_131_161,
  RESTAURANT_OPERATIONAL_FIXTURE_INDEXES_131_161,
  RESTAURANT_REGULATION_QA_ORIGINAL_BLOCKERS_131_161,
  RESTAURANT_REGULATION_QA_READY_INDEXES_131_161,
  augmentRestaurantOperationalMaterialEvidence,
} from "../../scripts/lib/restaurant-operational-fixtures-131-161.mjs";

function baseEvidence(idx) {
  // Use the same deterministic input evidence shape as the restaurant matrix,
  // while keeping this test independent of a cloud provider or server calls.
  return [
    buildRestaurantRequiredInputEvidence({
      input: `QA岗位${idx}的业务范围、期间、数据明细和负责人`,
      idx,
      inputIndex: 0,
    }),
  ];
}

test("131-161 operational augmentation is pure, deterministic and task-complete", () => {
  const firstIds = [];
  for (const idx of RESTAURANT_OPERATIONAL_FIXTURE_INDEXES_131_161) {
    const original = baseEvidence(idx);
    const snapshot = structuredClone(original);
    const augmented = augmentRestaurantOperationalMaterialEvidence({
      idx,
      materialEvidence: original,
    });
    const repeated = augmentRestaurantOperationalMaterialEvidence({
      idx,
      materialEvidence: original,
    });

    assert.deepEqual(original, snapshot, `${idx} mutated input evidence`);
    assert.deepEqual(augmented, repeated, `${idx} is not deterministic`);
    assert.equal(Array.isArray(augmented), true);

    const result = assessRestaurantTaskCompleteness({
      idx,
      materialEvidence: augmented,
    });
    assert.equal(result.operationalReady, true, `${idx}: ${result.operationalErrors}`);
    assert.deepEqual(result.operationalBlockReasons, [], `${idx} has blockers`);

    const target = augmented.find((row) => row.qaOperationalFacts === true);
    assert.ok(target, `${idx} missing QA augmentation marker`);
    assert.equal(target.qaEvidence?.qa, true);
    assert.equal(target.qaEvidence?.qaTag, "QA");
    assert.equal(target.qaEvidence?.evidenceDate, "2026-07-31");
    assert.match(target.qaEvidence?.evidenceId || "", new RegExp(`^QA-REST-${idx}-001$`, "u"));
    assert.deepEqual(
      target.qaEvidence?.objects,
      RESTAURANT_OPERATIONAL_FIXTURE_FACTS_131_161[idx].qaEvidence.objects,
    );
    firstIds.push(target.qaEvidence.evidenceId);

    // Every dimension's payload carries a QA marker and date, so no opaque
    // generic "there is data" row can accidentally satisfy a task gate.
    for (const [dimensionId, facts] of Object.entries(target.fields.facts)) {
      if (!facts?.QA标签) continue;
      assert.equal(facts.QA标签, "ISOLATED_QA", `${idx}/${dimensionId}`);
      assert.equal(facts.QA证据日期, "2026-07-31", `${idx}/${dimensionId}`);
      assert.match(facts.QA证据编号, new RegExp(`^QA-REST-${idx}-001$`, "u"));
    }
  }
  assert.equal(new Set(firstIds).size, 31);
});

test("empty evidence gets an isolated QA record and unknown indexes are unchanged", () => {
  for (const idx of RESTAURANT_OPERATIONAL_FIXTURE_INDEXES_131_161) {
    const augmented = augmentRestaurantOperationalMaterialEvidence({
      idx,
      materialEvidence: [],
    });
    assert.equal(augmented.length, 1);
    assert.equal(augmented[0].recordId, `QA-REST-${idx}-001-R1`);
    assert.equal(augmented[0].fields.rid, augmented[0].recordId);
    assert.equal(
      assessRestaurantTaskCompleteness({ idx, materialEvidence: augmented }).operationalReady,
      true,
    );
  }

  const unknown = [{ recordId: "KEEP-1", fields: { facts: { scope: { value: 1 } } } }];
  const copy = augmentRestaurantOperationalMaterialEvidence({
    idx: 130,
    materialEvidence: unknown,
  });
  assert.deepEqual(copy, unknown);
  assert.notEqual(copy, unknown);
});

test("listed regulation/private-scope rows are QA-only ready with adoption and external execution blocked", () => {
  const catalog = loadRestaurantCatalog();
  assert.deepEqual(RESTAURANT_REGULATION_QA_READY_INDEXES_131_161, [
    133, 135, 137, 138, 139, 140, 141, 142, 145, 149, 155, 157, 159,
  ]);
  for (const idx of RESTAURANT_REGULATION_QA_READY_INDEXES_131_161) {
    const employee = catalog.employees.find((row) => row.idx === idx);
    assert.ok(employee, `missing catalog employee ${idx}`);
    const base = employee.inputs.map((input, inputIndex) =>
      buildRestaurantRequiredInputEvidence({ input, idx, inputIndex }),
    );
    const augmented = augmentRestaurantOperationalMaterialEvidence({
      idx,
      materialEvidence: base,
    });
    const repeated = augmentRestaurantOperationalMaterialEvidence({
      idx,
      materialEvidence: base,
    });
    assert.deepEqual(augmented, repeated, `${idx} regulation QA scope is not deterministic`);

    const regulationRows = augmented.filter((row) => row?.fields?.facts?.regulation);
    assert.ok(regulationRows.length > 0, `${idx} has no regulation row`);
    for (const row of regulationRows) {
      const regulation = row.fields.facts.regulation;
      assert.equal(row.operationalReady, true, `${idx} fixture QA generation should be ready`);
      assert.deepEqual(row.regulationBlockers, [], `${idx} has dispatch blockers`);
      assert.equal(regulation.QA状态, "QA_ONLY");
      assert.equal(regulation.数据性质, "QA_ONLY_SYNTHETIC");
      assert.equal(regulation.业务执行资格, "READY");
      assert.equal(regulation.业务采纳资格, "BLOCKED");
      assert.equal(regulation.外部执行资格, "BLOCKED");
      assert.equal(regulation.法律结论, "未形成");
      const originalBlockers = RESTAURANT_REGULATION_QA_ORIGINAL_BLOCKERS_131_161[idx];
      assert.deepEqual(regulation.realWorldBlockers, originalBlockers);
      assert.equal(regulation.QA核验日期, "2026-07-31");
      assert.match(regulation.QA证据编号, new RegExp(`^QA-REG-${idx}-001$`, "u"));
      assert.match(regulation.QA禁止事项, /禁止/u);
      assert.equal(row.qaOnlyRegulatoryProof, true);
      assert.deepEqual(row.realWorldBlockers, originalBlockers);
      assert.equal(row.qaEvidence?.qaOnlyRegulatoryProof, true);
      assert.deepEqual(row.qaEvidence?.originalOperationalBlockers, originalBlockers);
      assert.equal(row.qaEvidence?.businessAdoption, "BLOCKED");
      assert.equal(row.qaEvidence?.externalExecution, "BLOCKED");
      assert.equal(row.qaEvidence?.legalConclusion, "未形成");
    }
  }
});

test("listed indexes are operationalReady in zero-cloud dispatch preflight", () => {
  const catalog = loadRestaurantCatalog();
  for (const idx of RESTAURANT_REGULATION_QA_READY_INDEXES_131_161) {
    const employee = catalog.employees.find((row) => row.idx === idx);
    const profile = {
      identity: {
        idx: employee.idx,
        key: employee.key,
        name: employee.name,
        duty: employee.duty,
      },
      dispatch: {
        defaultTaskType: "执行方案",
        requiredInputs: employee.inputs,
        guidance: {
          taskExamples: [employee.duty],
          deliverableChecklist: employee.deliverables,
        },
      },
    };
    const dispatch = buildRestaurantDispatch(profile, `qa-regulation-${idx}`);
    const validation = validateRestaurantDispatchEvidence(dispatch, profile);
    assert.equal(dispatch.operationalReady, true, `${idx} dispatch is blocked`);
    assert.deepEqual(dispatch.operationalBlockReasons, [], `${idx} dispatch blockers`);
    assert.equal(validation.valid, true, `${idx}: ${validation.errors.join("；")}`);
    assert.equal(validation.operationalReady, true, `${idx} validation is blocked`);
  }
});

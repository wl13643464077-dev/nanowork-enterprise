import assert from "node:assert/strict";
import test from "node:test";
import {
  RESTAURANT_OPERATIONAL_FIXTURE_DATE,
  RESTAURANT_OPERATIONAL_FIXTURE_FACTS_101_130,
  RESTAURANT_OPERATIONAL_FIXTURE_INDEXES,
  RESTAURANT_OPERATIONAL_FIXTURE_SCHEMA,
  RESTAURANT_OPERATIONAL_QA_ONLY_NO_GENERATION_BLOCKER,
  RESTAURANT_OPERATIONAL_QA_ONLY_REGULATORY_BLOCKERS,
  RESTAURANT_OPERATIONAL_QA_ONLY_REGULATORY_INDEXES,
  augmentRestaurantOperationalFixtures101To130,
  restaurantOperationalFixtureRecordId,
} from "../../scripts/lib/restaurant-operational-fixtures-101-130.mjs";
import {
  assessRestaurantTaskCompleteness,
} from "../../scripts/lib/restaurant-required-input-facts.mjs";
import {
  buildRestaurantDispatch,
  buildRestaurantRequiredInputEvidence,
  validateRestaurantDispatchEvidence,
} from "../../scripts/lib/real-employee-matrix.mjs";
import { loadRestaurantCatalog } from "../../server/src/catalog/restaurant.js";

test("101-130 operational QA augmentation satisfies each task completeness gate", () => {
  assert.deepEqual(RESTAURANT_OPERATIONAL_FIXTURE_INDEXES, Array.from({ length: 30 }, (_, offset) => offset + 101));
  assert.deepEqual(
    Object.keys(RESTAURANT_OPERATIONAL_FIXTURE_FACTS_101_130).map(Number),
    RESTAURANT_OPERATIONAL_FIXTURE_INDEXES,
  );

  for (const idx of RESTAURANT_OPERATIONAL_FIXTURE_INDEXES) {
    const existing = [
      {
        schema: "rri-evidence.v3",
        recordId: `E-${idx}-existing-R1`,
        fields: { rid: `E-${idx}-existing-R1`, facts: { scope: { 期间: "2026-07" } } },
      },
    ];
    const before = structuredClone(existing);
    const first = augmentRestaurantOperationalFixtures101To130({
      idx,
      materialEvidence: existing,
    });
    const second = augmentRestaurantOperationalFixtures101To130({
      idx,
      materialEvidence: existing,
    });

    assert.deepEqual(existing, before, `${idx} must not mutate input evidence`);
    assert.deepEqual(first, second, `${idx} evidence must be deterministic`);
    assert.equal(first.length, existing.length + 1, `${idx} must append one QA record`);

    const fixture = first.at(-1);
    assert.equal(fixture.recordId, `QA-RRI-${idx}-01`);
    assert.equal(fixture.recordId, restaurantOperationalFixtureRecordId(idx));
    assert.equal(fixture.schema, RESTAURANT_OPERATIONAL_FIXTURE_SCHEMA);
    assert.equal(fixture.evidenceId, fixture.recordId);
    assert.equal(fixture.evidenceDate, RESTAURANT_OPERATIONAL_FIXTURE_DATE);
    assert.equal(fixture.source, "isolated_qa_material");
    assert.equal(fixture.sourceKind, "synthetic_qa");
    assert.equal(fixture.externalCall, false);
    assert.equal(fixture.qaFixture, true);
    assert.equal(fixture.verifiedResults.length, 1);
    assert.equal(fixture.verifiedResults[0].resultId, `QA-RESULT-${idx}-01`);
    assert.equal(fixture.verifiedResults[0].verificationStatus, "verified_qa");
    assert.equal(fixture.verifiedActualResult.status, "verified_qa");
    assert.equal(fixture.qaCapabilityRunnable, true);
    assert.equal(fixture.operationalReady, true);
    assert.deepEqual(fixture.fields.rid, fixture.recordId);
    assert.ok(fixture.tags.includes("QA"));
    assert.ok(fixture.tags.includes("isolated_qa"));
    assert.ok(fixture.tags.includes("operational_fixture"));
    assert.ok(fixture.objects.length > 0);
    for (const object of fixture.objects) {
      assert.match(object.objectId, new RegExp(`^QA-OBJ-${idx}-\\d{2}$`, "u"));
      assert.equal(object.evidenceId, fixture.recordId);
      assert.equal(object.observedAt, `${RESTAURANT_OPERATIONAL_FIXTURE_DATE}T10:00:00+08:00`);
      assert.equal(object.dataClass, "synthetic_aggregate_no_customer_data");
    }

    const completeness = assessRestaurantTaskCompleteness({
      idx,
      materialEvidence: first,
    });
    assert.equal(completeness.operationalReady, true, `${idx}: ${completeness.operationalErrors.join("；")}`);
    assert.deepEqual(completeness.operationalBlockReasons, []);
  }
});

test("operational QA augmentation leaves unknown indices unchanged and clones evidence", () => {
  const existing = [{ fields: { facts: { address: { 地址: "QA-unknown" } } } }];
  const augmented = augmentRestaurantOperationalFixtures101To130({
    idx: 999,
    materialEvidence: existing,
  });
  assert.deepEqual(augmented, existing);
  assert.notStrictEqual(augmented, existing);
  assert.notStrictEqual(augmented[0], existing[0]);
  assert.equal(restaurantOperationalFixtureRecordId(999), null);

  const positional = augmentRestaurantOperationalFixtures101To130(101, existing);
  const reversePositional = augmentRestaurantOperationalFixtures101To130(existing, 101);
  assert.deepEqual(positional, reversePositional);
});

test("target regulation records are QA-only ready while real-world and external execution remain blocked", () => {
  const catalog = loadRestaurantCatalog();
  assert.deepEqual(
    RESTAURANT_OPERATIONAL_QA_ONLY_REGULATORY_INDEXES,
    [109, 114, 115, 116, 117, 118, 120, 122, 123, 124],
  );

  for (const idx of RESTAURANT_OPERATIONAL_QA_ONLY_REGULATORY_INDEXES) {
    const employee = catalog.employees.find((item) => item.idx === idx);
    const original = employee.inputs.map((input, inputIndex) =>
      buildRestaurantRequiredInputEvidence({ input, idx, inputIndex }),
    );
    const snapshot = structuredClone(original);
    const augmented = augmentRestaurantOperationalFixtures101To130({
      idx,
      materialEvidence: original,
    });
    assert.deepEqual(original, snapshot, `${idx} mutated the original evidence`);

    const regulatoryRows = augmented.filter(
      (row) => row?.fields?.facts?.regulation,
    );
    assert.ok(regulatoryRows.length > 0, `${idx} missing regulation evidence`);
    for (const row of regulatoryRows) {
      const regulation = row.fields.facts.regulation;
      const originalBlockers = RESTAURANT_OPERATIONAL_QA_ONLY_REGULATORY_BLOCKERS[idx];
      assert.equal(regulation.QA_ONLY, true);
      assert.equal(regulation.QA_ONLY_MARKER, "QA_ONLY_SYNTHETIC");
      assert.equal(regulation.数据性质, "QA_ONLY_SYNTHETIC");
      assert.equal(regulation.外部调用, false);
      assert.equal(regulation.业务执行资格, "READY");
      assert.equal(regulation.业务采纳资格, "BLOCKED");
      assert.equal(regulation.外部执行资格, "BLOCKED");
      assert.equal(regulation.法律结论, "未形成");
      assert.match(regulation.禁止用途, /不得.*法律结论.*外部执行/u);
      assert.deepEqual(regulation.阻塞原因, [
        RESTAURANT_OPERATIONAL_QA_ONLY_NO_GENERATION_BLOCKER,
      ]);
      assert.deepEqual(regulation.realWorldBlockers, originalBlockers);
      assert.deepEqual(row.regulationBlockers, []);
      assert.deepEqual(row.realWorldBlockers, originalBlockers);
      assert.equal(row.qaOnlyRegulatoryProof, true);
      assert.equal(row.qaEvidence.qaOnlyRegulatoryProof, true);
      assert.equal(row.qaEvidence.externalCall, false);
      assert.deepEqual(row.qaEvidence.originalOperationalBlockers, originalBlockers);
      assert.equal(row.qaEvidence.businessAdoption, "BLOCKED");
      assert.equal(row.qaEvidence.externalExecution, "BLOCKED");
      assert.equal(row.qaEvidence.legalConclusion, "未形成");
    }

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
    const dispatch = buildRestaurantDispatch(profile, `qa-only-${idx}`);
    assert.equal(dispatch.qaCapabilityRunnable, true, `${idx} QA capability blocked`);
    assert.equal(dispatch.operationalReady, true, `${idx} QA task generation blocked`);
    assert.deepEqual(dispatch.operationalBlockReasons, []);
    const checked = validateRestaurantDispatchEvidence(dispatch, profile);
    assert.equal(checked.valid, true, `${idx}: ${checked.errors.join("；")}`);
    assert.equal(checked.operationalReady, true);

    const empty = augmentRestaurantOperationalFixtures101To130({
      idx,
      materialEvidence: [],
    });
    const standaloneRegulation = empty.at(-1)?.fields?.facts?.regulation;
    assert.equal(standaloneRegulation?.QA_ONLY, true, `${idx} empty evidence lacks QA-only regulation proof`);
    assert.equal(standaloneRegulation?.业务采纳资格, "BLOCKED");
    assert.equal(standaloneRegulation?.外部执行资格, "BLOCKED");
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRestaurantOutputDeliverableFixture,
  canonicalizeRestaurantEmployeeOutputCandidate,
  validateRestaurantEmployeeOutputContract,
} from "../src/engines/restaurant-output-contract.js";

const TASK = Object.freeze({
  title: "毛血旺 太原吾悦广场",
  type: "商圈画像",
  requirement:
    "请围绕毛血旺 太原吾悦广场核验竞品与商圈画像，给出下一步可执行的业务结论。",
  dueAt: "2026-08-07T18:00:00",
});

const VERIFIED_SOURCES = Object.freeze([
  {
    title: "吾悦广场公开菜单与营业状态",
    url: "https://evidence.example/wuyue/menu",
    snippet: "公开菜单、价格带与营业状态快照。",
  },
  {
    title: "OpenStreetMap定位·太原吾悦广场",
    url: "https://www.openstreetmap.org/way/7001",
    snippet: "目标商场、公交站和餐饮POI定位快照。",
  },
]);

function fixture() {
  return buildRestaurantOutputDeliverableFixture(102, TASK);
}

function sourceLine(source) {
  return `${source.title}｜${source.url}`;
}

function validationContext() {
  return {
    task: TASK,
    allowedSources: VERIFIED_SOURCES,
    requireWebSources: true,
  };
}

function withDecisionSources(source) {
  const output = fixture();
  output.decision_context.sources = [
    {
      source,
      period: "2026-08-08",
      fact: "公开菜单快照支持价格带与营业状态核验，未知字段保留后续实地证伪动作。",
    },
    {
      source: sourceLine(VERIFIED_SOURCES[1]),
      period: "2026-08-08",
      fact: "地图快照定位目标商场、公交站和周边餐饮POI，可用于商圈边界核验。",
    },
    {
      source: "本次任务材料·门店A验收数据表",
      period: "2026-07-01至2026-07-31",
      fact: "内部材料记录营业额、订单、食材成本和人工成本，用于经营口径对照。",
    },
  ];
  return output;
}

test("T1215来源回归：同一已验证URL恢复权威title并通过餐饮契约", () => {
  const output = withDecisionSources(
    `【来源4】吾悦广场菜单（模型归纳）｜${VERIFIED_SOURCES[0].url}?utm_source=model#snapshot`,
  );
  const canonicalized = canonicalizeRestaurantEmployeeOutputCandidate(
    102,
    output,
    validationContext(),
  );

  assert.equal(canonicalized.changed, true);
  assert.equal(
    canonicalized.parsed.decision_context.sources[0].source,
    sourceLine(VERIFIED_SOURCES[0]),
  );
  assert.equal(
    canonicalized.parsed.decision_context.sources[0].source.includes(
      "attacker",
    ),
    false,
  );

  const checked = validateRestaurantEmployeeOutputContract(
    102,
    canonicalized.text,
    validationContext(),
  );
  assert.equal(checked.valid, true, checked.errors.join("；"));
});

test("T1709来源回归：恢复权威source时同步修复输入、方法和正文证据引用，并保守降级矛盾supplied", () => {
  const rawSource = `【来源4】吾悦广场菜单（模型归纳）｜${VERIFIED_SOURCES[0].url}?utm_source=model#snapshot`;
  const canonicalSource = sourceLine(VERIFIED_SOURCES[0]);
  const output = withDecisionSources(rawSource);
  const inputs = Object.values(output.input_audit);
  const methods = Object.values(output.method_execution);
  const workItems = Object.values(output.deliverables).flatMap((deliverable) =>
    deliverable.work_product.sections.flatMap((section) => section.items),
  );

  inputs[0].evidence_refs = [rawSource];
  inputs[1].evidence_refs = ["【来源4】"];
  inputs[2].evidence_refs = [
    `${VERIFIED_SOURCES[0].url}?utm_source=model#snapshot`,
  ];
  inputs[2].status = "supplied";
  inputs[2].finding =
    "当前缺少该项输入的商户原始明细，只能登记具体缺口并等待门店运营岗位补采。";
  methods[0].evidence_refs = [rawSource];
  methods[1].evidence_refs = ["【来源4】"];
  workItems[0].evidence_ref = rawSource;
  workItems[1].evidence_ref = "【来源4】";
  workItems[2].evidence_ref = VERIFIED_SOURCES[0].url;

  const canonicalized = canonicalizeRestaurantEmployeeOutputCandidate(
    102,
    output,
    validationContext(),
  );

  assert.equal(canonicalized.changed, true);
  assert.equal(
    canonicalized.parsed.decision_context.sources[0].source,
    canonicalSource,
  );
  assert.deepEqual(inputs.slice(0, 3).map((_, index) =>
    canonicalized.parsed.input_audit[Object.keys(output.input_audit)[index]]
      .evidence_refs,
  ), [[canonicalSource], [canonicalSource], [canonicalSource]]);
  assert.deepEqual(methods.slice(0, 2).map((_, index) =>
    canonicalized.parsed.method_execution[
      Object.keys(output.method_execution)[index]
    ].evidence_refs,
  ), [[canonicalSource], [canonicalSource]]);
  assert.deepEqual(
    Object.values(canonicalized.parsed.deliverables)
      .flatMap((deliverable) =>
        deliverable.work_product.sections.flatMap((section) => section.items),
      )
      .slice(0, 3)
      .map((item) => item.evidence_ref),
    [canonicalSource, canonicalSource, canonicalSource],
  );
  assert.equal(
    canonicalized.parsed.input_audit[Object.keys(output.input_audit)[2]].status,
    "missing",
  );
  assert.ok(
    canonicalized.changes.some(
      (change) => change.reason === "verified_source_reference_restored",
    ),
  );
  assert.ok(
    canonicalized.changes.some(
      (change) => change.reason === "supplied_input_explicitly_unresolved",
    ),
  );
});

test("T1709来源回归：重复【来源N】标签没有唯一归属时不得猜测改写", () => {
  const output = withDecisionSources(
    `【来源4】吾悦广场菜单（模型归纳）｜${VERIFIED_SOURCES[0].url}`,
  );
  output.decision_context.sources[1].source =
    `【来源4】OpenStreetMap定位｜${VERIFIED_SOURCES[1].url}`;
  const firstInput = Object.values(output.input_audit)[0];
  firstInput.evidence_refs = ["【来源4】"];

  const canonicalized = canonicalizeRestaurantEmployeeOutputCandidate(
    102,
    output,
    validationContext(),
  );

  assert.equal(canonicalized.changed, true);
  assert.equal(
    canonicalized.parsed.input_audit[Object.keys(output.input_audit)[0]]
      .evidence_refs[0],
    "【来源4】",
  );
  assert.equal(
    canonicalized.changes.some(
      (change) =>
        change.reason === "verified_source_reference_restored" &&
        change.from === "【来源4】",
    ),
    false,
  );
});

test("T1830 #46来源回归：剔除无效decision source与悬空数组引用，单值悬空只降级不猜来源", () => {
  const canonicalSource = sourceLine(VERIFIED_SOURCES[0]);
  const output = withDecisionSources(canonicalSource);
  output.decision_context.sources.splice(1, 0, {
    source: "【来源404】某平台商户页（未取得本轮允许快照）",
    period: "2026-08-08",
    fact: "该来源无法由本轮允许来源快照验证，只能作为待补证线索。",
  });
  output.decision_context.sources.push({
    source: "门店运营系统导出记录｜OPS-46-A",
    period: "2026-08-08",
    fact: "规范证据编号OPS-46-A记录本次门店运营输入的导出批次。",
  });

  const inputs = Object.values(output.input_audit);
  inputs[0].evidence_refs = [canonicalSource, "【来源404】"];
  inputs[1].status = "supplied";
  inputs[1].finding =
    "当前缺少顾客调研与站内订单明细，只能登记缺口并由门店运营岗位补采。";
  inputs[2].evidence_refs = ["OPS-46-A"];

  const methods = Object.values(output.method_execution);
  methods[0].evidence_refs = [VERIFIED_SOURCES[0].url, "悬空来源标签"];

  const workItems = Object.values(output.deliverables).flatMap((deliverable) =>
    deliverable.work_product.sections.flatMap((section) => section.items),
  );
  workItems[0].evidence_ref = "【来源404】";
  workItems[0].status = "verified";
  workItems[1].evidence_ref = VERIFIED_SOURCES[0].url;

  const canonicalized = canonicalizeRestaurantEmployeeOutputCandidate(
    102,
    output,
    validationContext(),
  );

  assert.equal(
    canonicalized.parsed.decision_context.sources.some((source) =>
      source.source.includes("来源404"),
    ),
    false,
  );
  assert.deepEqual(
    canonicalized.parsed.input_audit[Object.keys(output.input_audit)[0]]
      .evidence_refs,
    [canonicalSource],
  );
  assert.deepEqual(
    canonicalized.parsed.input_audit[Object.keys(output.input_audit)[2]]
      .evidence_refs,
    ["OPS-46-A"],
  );
  assert.deepEqual(
    canonicalized.parsed.method_execution[
      Object.keys(output.method_execution)[0]
    ].evidence_refs,
    [canonicalSource],
  );
  assert.equal(
    canonicalized.parsed.input_audit[Object.keys(output.input_audit)[1]].status,
    "missing",
  );
  assert.equal(workItems[0].status, "verified", "原始fixture不得被变异");
  const canonicalWorkItems = Object.values(canonicalized.parsed.deliverables)
    .flatMap((deliverable) => deliverable.work_product.sections)
    .flatMap((section) => section.items);
  assert.equal(canonicalWorkItems[0].status, "gap");
  assert.equal(
    canonicalWorkItems[0].evidence_ref,
    "【来源404】",
    "单值引用没有安全映射时必须保留硬门，不能猜成任一允许来源",
  );
  assert.equal(canonicalWorkItems[1].evidence_ref, canonicalSource);
  assert.ok(
    canonicalized.changes.some(
      (change) => change.reason === "unresolved_evidence_reference_removed",
    ),
  );
  assert.ok(
    canonicalized.changes.some(
      (change) =>
        change.reason === "unresolved_evidence_reference_downgraded" &&
        change.to === "gap",
    ),
  );

  const checked = validateRestaurantEmployeeOutputContract(
    102,
    canonicalized.text,
    validationContext(),
  );
  assert.equal(checked.valid, false);
  assert.match(
    checked.errors.join("；"),
    /evidence_ref.*未回指本次来源/u,
    "无法验证的单值引用仍必须被安全硬门拒绝",
  );
});

test("T1910 #47来源回归：ASCII与全角来源序号按decision原顺序映射，连写只保留已验证项", () => {
  const firstSource = sourceLine(VERIFIED_SOURCES[1]);
  const secondSource = sourceLine(VERIFIED_SOURCES[0]);
  const output = withDecisionSources(secondSource);
  output.decision_context.sources = [
    {
      source: firstSource,
      period: "2026-08-08",
      fact: "地图快照定位目标商场、公交站和周边餐饮POI。",
    },
    {
      source: "某平台商户页（没有本轮已验证URL）",
      period: "2026-08-08",
      fact: "该项没有本轮允许来源快照，只能等待补证。",
    },
    {
      source: secondSource,
      period: "2026-08-08",
      fact: "公开菜单快照支持价格带与营业状态核验。",
    },
  ];
  const inputs = Object.values(output.input_audit);
  inputs[0].evidence_refs = ["[来源1][来源2][来源3]"];
  inputs[1].evidence_refs = ["［来源3］"];
  inputs[2].evidence_refs = ["【来源1】"];
  inputs[3].evidence_refs = ["[任务要求]"];
  const methods = Object.values(output.method_execution);
  methods[0].evidence_refs = ["[来源1][来源3]"];
  methods[1].evidence_refs = ["deliverable_04"];
  const workItem = Object.values(output.deliverables)[0].work_product.sections[0]
    .items[0];
  workItem.evidence_ref = "[来源1][来源2][来源3]";

  const canonicalized = canonicalizeRestaurantEmployeeOutputCandidate(
    102,
    output,
    validationContext(),
  );

  const canonicalInputs = Object.values(canonicalized.parsed.input_audit);
  assert.deepEqual(canonicalInputs[0].evidence_refs, [
    `${firstSource}；${secondSource}`,
  ]);
  assert.deepEqual(canonicalInputs[1].evidence_refs, [secondSource]);
  assert.deepEqual(canonicalInputs[2].evidence_refs, [firstSource]);
  assert.deepEqual(
    canonicalInputs[3].evidence_refs,
    ["[任务要求]"],
    "任务标签不得猜成来源，也不应被误当作伪造公网来源删除",
  );
  const canonicalMethods = Object.values(canonicalized.parsed.method_execution);
  assert.deepEqual(canonicalMethods[0].evidence_refs, [
    `${firstSource}；${secondSource}`,
  ]);
  assert.deepEqual(
    canonicalMethods[1].evidence_refs,
    ["deliverable_04"],
    "deliverable别名不是公网来源，需保留给上层advisory展示",
  );
  assert.equal(
    Object.values(canonicalized.parsed.deliverables)[0].work_product.sections[0]
      .items[0].evidence_ref,
    `${firstSource}；${secondSource}`,
  );
  assert.equal(
    canonicalized.parsed.decision_context.sources.some((source) =>
      source.source.includes("某平台商户页"),
    ),
    false,
  );
  assert.ok(
    canonicalized.changes.some(
      (change) =>
        change.reason === "verified_source_reference_restored" &&
        change.from === "[来源1][来源2][来源3]",
    ),
  );
});

test("T1910 #47来源回归：同一decision source含多个允许URL时拆成规范来源并保留序号引用", () => {
  const firstSource = sourceLine(VERIFIED_SOURCES[0]);
  const secondSource = sourceLine(VERIFIED_SOURCES[1]);
  const output = withDecisionSources(firstSource);
  output.decision_context.sources = [
    {
      source: `菜单快照：${VERIFIED_SOURCES[0].url}；地图快照：${VERIFIED_SOURCES[1].url}`,
      period: "2026-08-08",
      fact: "两个URL均来自本轮允许快照，分别支持菜单状态与地图定位。",
    },
  ];
  Object.values(output.input_audit)[0].evidence_refs = ["[来源1]"];

  const canonicalized = canonicalizeRestaurantEmployeeOutputCandidate(
    102,
    output,
    validationContext(),
  );

  assert.deepEqual(
    canonicalized.parsed.decision_context.sources.map((item) => item.source),
    [firstSource, secondSource],
  );
  assert.deepEqual(
    Object.values(canonicalized.parsed.input_audit)[0].evidence_refs,
    [`${firstSource}；${secondSource}`],
  );
  assert.ok(
    canonicalized.changes.some(
      (change) => change.reason === "verified_multi_source_snapshot_split",
    ),
  );
});

test("T1400来源回归：中文分隔符连接多个已验证来源时逐条识别，不能吞成伪造长URL", () => {
  const output = withDecisionSources(sourceLine(VERIFIED_SOURCES[0]));
  const firstDeliverable = Object.values(output.deliverables)[0];
  const firstItem = firstDeliverable.work_product.sections[0].items[0];
  firstItem.evidence_ref = [
    sourceLine(VERIFIED_SOURCES[0]),
    sourceLine(VERIFIED_SOURCES[1]),
  ].join("；");
  firstItem.result += `；来源核对：${VERIFIED_SOURCES[0].url}，并参照${VERIFIED_SOURCES[1].url}。`;

  const checked = validateRestaurantEmployeeOutputContract(
    102,
    output,
    validationContext(),
  );
  assert.equal(checked.valid, true, checked.errors.join("；"));
  assert.doesNotMatch(
    checked.errors.join("；"),
    /%EF%BC%9B|%E5%B9%B6%E5%8F%82%E7%85%A7/u,
  );
});

test("T1400交付回归：部分交付物如实列缺口可交付，但整份全gap仍拒绝", () => {
  const partial = fixture();
  const firstDeliverable = Object.values(partial.deliverables)[0];
  for (const section of firstDeliverable.work_product.sections) {
    for (const item of section.items) {
      item.status = "gap";
      item.result = `待核验：当前缺少现场复核证据；本次材料已记录的基线为：${item.result}`;
    }
  }
  const partialChecked = validateRestaurantEmployeeOutputContract(
    102,
    partial,
    {
      task: TASK,
      allowedSources: [],
      requireWebSources: false,
    },
  );
  assert.equal(partialChecked.valid, true, partialChecked.errors.join("；"));

  const allGap = fixture();
  for (const deliverable of Object.values(allGap.deliverables)) {
    for (const section of deliverable.work_product.sections) {
      for (const item of section.items) {
        item.status = "gap";
        item.result = `待核验：当前缺少现场复核证据；本次材料已记录的基线为：${item.result}`;
      }
    }
  }
  const allGapChecked = validateRestaurantEmployeeOutputContract(102, allGap, {
    task: TASK,
    allowedSources: [],
    requireWebSources: false,
  });
  assert.equal(allGapChecked.valid, false);
  assert.match(
    allGapChecked.errors.join("；"),
    /整份产出至少需要1项verified实际结果/u,
  );
});

test("T1215来源回归：错误/伪造URL在存在合法来源时被剔除并留下审计", () => {
  const output = withDecisionSources(
    `吾悦广场公开菜单与营业状态｜https://attacker.example/wuyue/menu`,
  );
  const canonicalized = canonicalizeRestaurantEmployeeOutputCandidate(
    102,
    output,
    validationContext(),
  );

  assert.equal(canonicalized.changed, true);
  assert.equal(
    canonicalized.parsed.decision_context.sources[0].source,
    sourceLine(VERIFIED_SOURCES[1]),
  );
  assert.equal(
    canonicalized.parsed.decision_context.sources.some(({ source }) =>
      source.includes("attacker.example"),
    ),
    false,
  );
  assert.doesNotMatch(canonicalized.text, /attacker\.example/u);
  assert.ok(
    canonicalized.changes.some(
      (change) =>
        change.path === "$.decision_context.sources[0]" &&
        change.reason === "unverified_source_pruned",
    ),
  );
  const checked = validateRestaurantEmployeeOutputContract(
    102,
    canonicalized.text,
    validationContext(),
  );
  assert.equal(checked.valid, true, checked.errors.join("；"));
});

test("T1215来源回归：唯一来源是错误URL时不得凭空补源，仍拒绝", () => {
  const output = fixture();
  output.decision_context.sources = [
    {
      source: "吾悦广场公开菜单与营业状态｜https://attacker.example/wuyue/menu",
      period: "2026-08-08",
      fact: "仅有未核验来源，不得当作联网事实。",
    },
  ];
  const canonicalized = canonicalizeRestaurantEmployeeOutputCandidate(
    102,
    output,
    validationContext(),
  );

  assert.equal(canonicalized.changed, false);
  assert.equal(
    canonicalized.parsed.decision_context.sources[0].source,
    "吾悦广场公开菜单与营业状态｜https://attacker.example/wuyue/menu",
  );
  const checked = validateRestaurantEmployeeOutputContract(
    102,
    canonicalized.text,
    validationContext(),
  );
  assert.equal(checked.valid, false);
  assert.match(
    checked.errors.join("；"),
    /decision_context\.sources\[0\].*不是本次已验证联网来源/u,
  );
});

test("T1215质量回归：quality pass无业务锚点时降级，剩余合法pass保持overall一致", () => {
  const output = fixture();
  output.quality_review.checks.quality_02_cd4ac10f32.evidence =
    "营业额100000元、订单2000单、食材成本35000元、人工成本22000元，已完成机器检查。";

  const canonicalized = canonicalizeRestaurantEmployeeOutputCandidate(
    102,
    output,
    { task: TASK },
  );
  assert.equal(canonicalized.changed, true);
  assert.equal(
    canonicalized.parsed.quality_review.checks.quality_02_cd4ac10f32.status,
    "needs_review",
  );
  assert.equal(canonicalized.parsed.quality_review.overall_status, "pass");
  for (const [key, check] of Object.entries(
    canonicalized.parsed.quality_review.checks,
  )) {
    if (key === "quality_02_cd4ac10f32") continue;
    assert.equal(check.status, "pass", `${key} should remain a legal pass`);
  }

  const checked = validateRestaurantEmployeeOutputContract(
    102,
    canonicalized.text,
    {
      task: TASK,
      allowedSources: [],
      requireWebSources: false,
    },
  );
  assert.equal(checked.valid, true, checked.errors.join("；"));
});

test("T1215质量回归：所有quality pass均无业务锚点时overall必须降为needs_review", () => {
  const output = fixture();
  for (const check of Object.values(output.quality_review.checks)) {
    check.evidence =
      "营业额100000元、订单2000单、食材成本35000元、人工成本22000元，已完成机器检查。";
  }

  const canonicalized = canonicalizeRestaurantEmployeeOutputCandidate(
    102,
    output,
    { task: TASK },
  );
  assert.equal(canonicalized.changed, true);
  assert.equal(
    canonicalized.parsed.quality_review.overall_status,
    "needs_review",
  );
  assert.ok(
    Object.values(canonicalized.parsed.quality_review.checks).every(
      (check) => check.status === "needs_review",
    ),
  );
});

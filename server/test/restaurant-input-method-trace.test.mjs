import assert from "node:assert/strict";
import test from "node:test";

import { loadRestaurantCatalog } from "../src/catalog/restaurant.js";
import {
  getRestaurantOutputContract,
  renderRestaurantOutputMarkdown,
  validateRestaurantEmployeeOutputContract,
} from "../src/engines/restaurant-output-contract.js";

const clone = (value) => structuredClone(value);

test("61个餐饮岗位逐项编译全部输入和方法步骤", () => {
  const employees = loadRestaurantCatalog().employees;
  assert.equal(employees.length, 61);

  for (const employee of employees) {
    const contract = getRestaurantOutputContract(employee.idx);
    const inputProperties =
      contract.schema.properties.input_audit.properties;
    const methodProperties =
      contract.schema.properties.method_execution.properties;
    const inputItems = Object.values(contract.validFixture.input_audit);
    const methodItems = Object.values(contract.validFixture.method_execution);

    assert.equal(Object.keys(inputProperties).length, employee.inputs.length);
    assert.equal(Object.keys(methodProperties).length, employee.steps.length);
    assert.deepEqual(
      inputItems.map((item) => item.input_name),
      employee.inputs,
    );
    assert.deepEqual(
      methodItems.map((item) => item.step_name),
      employee.steps,
    );
    for (const input of employee.inputs) assert.match(contract.instruction, new RegExp(input.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    for (const step of employee.steps) assert.match(contract.instruction, new RegExp(step.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

    const validation = validateRestaurantEmployeeOutputContract(
      employee.idx,
      contract.validFixture,
    );
    assert.equal(validation.valid, true, `${employee.idx}: ${validation.errors.join("；")}`);
  }
});

test("61岗provider schema保留全部强结构但不重复传输描述注解", () => {
  const employees = loadRestaurantCatalog().employees;
  let largest = { employeeIdx: 0, bytes: 0 };
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    assert.equal(Object.hasOwn(value, "description"), false);
    assert.equal(Object.hasOwn(value, "title"), false);
    Object.values(value).forEach(visit);
  };

  for (const employee of employees) {
    const contract = getRestaurantOutputContract(employee.idx);
    const provider = contract.providerSchema;
    const bytes = Buffer.byteLength(JSON.stringify(provider));
    if (bytes > largest.bytes) largest = { employeeIdx: employee.idx, bytes };
    assert.ok(
      bytes < 32 * 1024,
      `员工${employee.idx} provider schema ${bytes} bytes应低于32KiB网关安全线`,
    );
    visit(provider);
    assert.deepEqual(
      Object.keys(provider.properties.input_audit.properties),
      contract.inputKeys,
    );
    assert.deepEqual(
      Object.keys(provider.properties.method_execution.properties),
      contract.methodKeys,
    );
    assert.deepEqual(
      Object.keys(provider.properties.deliverables.properties),
      contract.deliverableKeys,
    );
    assert.equal(provider.properties.input_audit.additionalProperties, false);
    assert.equal(provider.properties.method_execution.additionalProperties, false);
    assert.equal(provider.properties.deliverables.additionalProperties, false);
  }
  assert.ok(largest.bytes > 0);
});

test("input_audit和method_execution缺项在demo advisory也不能省略", () => {
  const contract = getRestaurantOutputContract(101);
  const missingInput = clone(contract.validFixture);
  delete missingInput.input_audit[Object.keys(missingInput.input_audit)[0]];
  const inputResult = validateRestaurantEmployeeOutputContract(
    101,
    missingInput,
    { qualityMode: "advisory" },
  );
  assert.equal(inputResult.valid, false);
  assert.match(inputResult.errors.join("\n"), /input_audit/u);

  const missingStep = clone(contract.validFixture);
  delete missingStep.method_execution[
    Object.keys(missingStep.method_execution)[0]
  ];
  const methodResult = validateRestaurantEmployeeOutputContract(
    101,
    missingStep,
    { qualityMode: "advisory" },
  );
  assert.equal(methodResult.valid, false);
  assert.match(methodResult.errors.join("\n"), /method_execution/u);
});

test("输入审计和方法执行禁止复制泛化内容，并要求证据回指", () => {
  const contract = getRestaurantOutputContract(101);
  const duplicated = clone(contract.validFixture);
  const inputValues = Object.values(duplicated.input_audit);
  inputValues[1].finding = inputValues[0].finding;
  inputValues[1].impact = inputValues[0].impact;
  inputValues[1].verification = clone(inputValues[0].verification);
  let result = validateRestaurantEmployeeOutputContract(101, duplicated);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /输入审计.*复制|input_audit.*重复/u);

  const duplicatedMethod = clone(contract.validFixture);
  const methodValues = Object.values(duplicatedMethod.method_execution);
  methodValues[1].actual_execution = methodValues[0].actual_execution;
  methodValues[1].missing = methodValues[0].missing;
  methodValues[1].next_action = methodValues[0].next_action;
  result = validateRestaurantEmployeeOutputContract(101, duplicatedMethod);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /方法执行.*复制|method_execution.*重复/u);

  const forgedEvidence = clone(contract.validFixture);
  Object.values(forgedEvidence.method_execution)[0].evidence_refs = [
    "不存在于本次来源的凭空证据",
  ];
  result = validateRestaurantEmployeeOutputContract(101, forgedEvidence);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /evidence_refs.*未回指/u);
});

test("不得把未提供或待核验的输入伪装成supplied", () => {
  const fixture = clone(getRestaurantOutputContract(101).validFixture);
  const first = Object.values(fixture.input_audit)[0];
  first.status = "supplied";
  first.finding = "当前缺少该项原始材料，关键口径仍待门店负责人核验后补充。";
  const result = validateRestaurantEmployeeOutputContract(101, fixture);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /supplied.*缺失|supplied.*待核验/u);
});

test("报告首屏聚焦决策，并完整呈现输入、方法、成果和短标题链接", () => {
  const contract = getRestaurantOutputContract(101);
  const fixture = clone(contract.validFixture);
  fixture.decision_context.problem =
    "这是一个非常长的老板派活标题，原文应该进入任务范围而不是直接撑满报告主标题";
  fixture.decision_context.sources[0].source =
    "太原市公开商业统计｜https://example.com/report";
  for (const item of Object.values(fixture.input_audit)) {
    item.evidence_refs = [fixture.decision_context.sources[0].source];
  }
  for (const item of Object.values(fixture.method_execution)) {
    item.evidence_refs = [fixture.decision_context.sources[0].source];
  }
  for (const item of Object.values(fixture.deliverables)) {
    for (const evidence of item.evidence) {
      evidence.source = fixture.decision_context.sources[0].source;
    }
    for (const section of item.work_product.sections) {
      for (const workItem of section.items) {
        workItem.evidence_ref = fixture.decision_context.sources[0].source;
      }
    }
  }

  const markdown = renderRestaurantOutputMarkdown(101, fixture, {
    allowedSources: [
      { title: "太原市公开商业统计", url: "https://example.com/report" },
    ],
  });
  assert.match(markdown, /^# 餐饮市场机会研究｜门店A$/mu);
  assert.ok(markdown.indexOf("## 决策建议与置信度") < markdown.indexOf("## 任务范围"));
  assert.ok(markdown.indexOf("## 核心证据") < markdown.indexOf("## 任务范围"));
  assert.ok(markdown.indexOf("## 主要风险") < markdown.indexOf("## 任务范围"));
  assert.ok(markdown.indexOf("## 下一步") < markdown.indexOf("## 任务范围"));
  assert.match(markdown, /## 附录 A · 输入与方法执行记录/u);
  assert.match(markdown, /### 输入覆盖结果/u);
  assert.match(markdown, /### 方法执行结果/u);
  assert.match(markdown, /## 交付成果（岗位完整正文）/u);
  assert.match(
    markdown,
    /\[太原市公开商业统计\]\(https:\/\/example\.com\/report\)/u,
  );
  assert.doesNotMatch(
    markdown,
    /\[太原市公开商业统计｜https:\/\/example\.com\/report/u,
  );
  assert.match(markdown, /## 附录 B · 质量与授权记录/u);
});

test("实时公开来源必须使用本轮权威采集日期，内部材料期间不受误伤", () => {
  const contract = getRestaurantOutputContract(101);
  const fixture = clone(contract.validFixture);
  const source = "太原市公开商业统计｜https://example.com/report";
  fixture.decision_context.sources[0] = {
    source,
    period: "2025-07-18",
    fact: "该公开商业统计记录了本次任务可用于判断的商圈业务事实。",
  };
  for (const item of Object.values(fixture.input_audit)) {
    item.evidence_refs = [source];
  }
  for (const item of Object.values(fixture.method_execution)) {
    item.evidence_refs = [source];
  }
  for (const deliverable of Object.values(fixture.deliverables)) {
    deliverable.evidence[0].source = source;
    deliverable.evidence[0].period = "2025-07-18";
    for (const section of deliverable.work_product.sections) {
      for (const item of section.items) item.evidence_ref = source;
    }
  }
  const context = {
    allowedSources: [
      {
        title: "太原市公开商业统计",
        url: "https://example.com/report",
        fetchedAt: "2026-08-12T01:02:03.000Z",
      },
    ],
  };
  let result = validateRestaurantEmployeeOutputContract(101, fixture, context);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /权威采集日期2026-08-12/u);

  fixture.decision_context.sources[0].period = "采集于2026-08-12";
  for (const deliverable of Object.values(fixture.deliverables)) {
    deliverable.evidence[0].period = "2026-08-12";
  }
  result = validateRestaurantEmployeeOutputContract(101, fixture, context);
  assert.equal(result.valid, true, result.errors.join("；"));

  const internal = clone(contract.validFixture);
  internal.decision_context.sources[0].period = "2025-07-18";
  result = validateRestaurantEmployeeOutputContract(101, internal, context);
  assert.equal(result.valid, true, result.errors.join("；"));
});

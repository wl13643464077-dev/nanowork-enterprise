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

const VERIFIED_SOURCE = Object.freeze({
  title: "吾悦广场公开菜单与营业状态",
  url: "https://evidence.example/wuyue/menu",
});

function sourceLine(source) {
  return `${source.title}｜${source.url}`;
}

function fixture() {
  return buildRestaurantOutputDeliverableFixture(102, TASK);
}

function validationContext() {
  return {
    task: TASK,
    allowedSources: [VERIFIED_SOURCE],
    requireWebSources: true,
  };
}

test("T1305来源门禁：保留至少一条核验来源时应剔除额外未核验公共来源并留下审计", () => {
  const output = fixture();
  const originalBusinessText = output.deliverables[
    Object.keys(output.deliverables)[0]
  ].summary;
  output.decision_context.sources = [
    {
      source: `【来源A】菜单快照（模型归纳）｜${VERIFIED_SOURCE.url}?utm_source=model#snapshot`,
      period: "2026-08-08",
      fact: "公开菜单快照支持价格带与营业状态核验。",
    },
    {
      source: "公开竞品榜单（待核验，未提供URL）",
      period: "2026-08-08",
      fact: "该条仅作为待补证线索，不应被当作已验证来源。",
    },
  ];

  const canonicalized = canonicalizeRestaurantEmployeeOutputCandidate(
    102,
    JSON.stringify(output),
    validationContext(),
  );

  assert.equal(canonicalized.changed, true);
  assert.equal(
    canonicalized.parsed.decision_context.sources[0].source,
    sourceLine(VERIFIED_SOURCE),
  );
  assert.equal(
    canonicalized.parsed.decision_context.sources.length,
    1,
    "至少一条来源已核验时，未核验的额外公共来源应被剔除",
  );
  assert.ok(
    canonicalized.changes.some(
      (change) =>
        change.path === "$.decision_context.sources[1]" &&
        change.reason === "unverified_source_pruned",
    ),
    "剔除来源必须写入可审计的canonicalization change",
  );
  assert.equal(
    canonicalized.parsed.deliverables[Object.keys(output.deliverables)[0]].summary,
    originalBusinessText,
    "来源canonicalization不得改写业务正文",
  );
  const checked = validateRestaurantEmployeeOutputContract(
    102,
    canonicalized.text,
    validationContext(),
  );
  assert.equal(checked.valid, true, checked.errors.join("；"));
});

test("T1305来源门禁：唯一来源无效时仍必须拒绝，不能凭空补造来源", () => {
  const output = fixture();
  output.decision_context.sources = [
    {
      source: "公开竞品榜单（待核验，未提供URL）",
      period: "2026-08-08",
      fact: "只有待补证线索，没有已验证URL。",
    },
  ];

  const canonicalized = canonicalizeRestaurantEmployeeOutputCandidate(
    102,
    JSON.stringify(output),
    validationContext(),
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

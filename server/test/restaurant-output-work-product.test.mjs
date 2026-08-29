import assert from "node:assert/strict";
import { test } from "node:test";

import { loadRestaurantCatalog } from "../src/catalog/restaurant.js";
import {
  buildRestaurantOutputDeliverableFixture,
  getRestaurantOutputContract,
  validateRestaurantEmployeeOutputContract,
} from "../src/engines/restaurant-output-contract.js";

const WORK_PRODUCT_STATUSES = new Set(["verified", "assumption", "gap"]);
const MINIMUM_BODY_ITEMS = 2;
const PURE_ARTIFACT_CLAIM_PATTERN =
  /^(?:(?:现已|已经|已|将)(?:完成|形成|生成|制作|绘制|编制|建立|产出|输出)(?:了)?)[^\n。；]{1,120}(?:表|图|卡|清单|矩阵|地图|模型|方案|记录|报告|台账|正文)(?:，|,)?(?:共[^，,。；]{1,30})?(?:，|,)?(?:详见|见)附件[。！!]?$/u;
const PURE_METADATA_PATTERN =
  /^(?:共\s*\d+\s*项|(?:详见|见)附件|后续补充|待补材料后(?:形成|生成|制作|输出)).{0,20}$/u;
const FUTURE_OR_MATERIAL_ONLY_PATTERN =
  /^(?:待|后续|将|计划|需|需要|请)(?:补充|补齐|补证|收集|采集|获取|提供|形成|生成|制作|输出|核验|安排)/u;
const CANONICAL_EVIDENCE_ID_PATTERN =
  /\b(?:E-\d+-\d+(?:-R\d+)?|(?:FIN|PO|POS|CS|HR|SAFE|MKT|OPS)-[A-Z0-9-]+)\b/gu;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalize(value) {
  return String(value || "")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function isClaimOnly(value) {
  const text = String(value || "").trim();
  return (
    PURE_ARTIFACT_CLAIM_PATTERN.test(text) || PURE_METADATA_PATTERN.test(text)
  );
}

function declaredEvidenceReferences(output, deliverable) {
  const sources = [
    ...(output?.decision_context?.sources || []).map(
      (source) => source?.source,
    ),
    ...(deliverable?.evidence || []).map((evidence) => evidence?.source),
  ]
    .map((value) => String(value || "").trim())
    .filter((value) => value.length >= 6);
  const references = new Set(sources);
  for (const source of sources) {
    for (const evidenceId of source.matchAll(CANONICAL_EVIDENCE_ID_PATTERN)) {
      references.add(evidenceId[0]);
    }
  }
  return references;
}

function proposedWorkProductAudit(employeeIdx, output, contract) {
  const errors = [];

  for (const deliverableKey of contract.deliverableKeys) {
    const deliverable = output?.deliverables?.[deliverableKey];
    const base = `员工${employeeIdx}·$.deliverables.${deliverableKey}`;
    const requirement = contract.workProductRequirements?.[deliverableKey];
    const minimumItems = Number.isSafeInteger(requirement?.minimumItems)
      ? Math.max(MINIMUM_BODY_ITEMS, requirement.minimumItems)
      : MINIMUM_BODY_ITEMS;
    const coverageLabels = Array.isArray(requirement?.coverageLabels)
      ? requirement.coverageLabels
          .map((label) => String(label).trim())
          .filter(Boolean)
      : [];
    if (!isPlainObject(requirement) || coverageLabels.length === 0) {
      errors.push(`${base}缺少权威workProductRequirements`);
    }
    if (!isPlainObject(deliverable)) {
      errors.push(`${base}缺少目录规定的deliverable`);
      continue;
    }

    const workProduct = deliverable.work_product;
    if (!isPlainObject(workProduct)) {
      errors.push(`${base}.work_product正文少于${minimumItems}项（实际为0项）`);
      if (isClaimOnly(deliverable.summary)) {
        errors.push(`${base}正文只声明制品存在而未交付内容`);
      }
      continue;
    }

    if (
      typeof workProduct.artifact_type !== "string" ||
      !workProduct.artifact_type.trim()
    ) {
      errors.push(`${base}.work_product.artifact_type必须标明实际制品类型`);
    }
    if (
      !Array.isArray(workProduct.sections) ||
      workProduct.sections.length === 0
    ) {
      errors.push(
        `${base}.work_product正文少于${minimumItems}项（sections为空）`,
      );
      continue;
    }

    const items = [];
    for (const [sectionIndex, section] of workProduct.sections.entries()) {
      const sectionBase = `${base}.work_product.sections[${sectionIndex}]`;
      if (
        !isPlainObject(section) ||
        typeof section.section_name !== "string" ||
        !section.section_name.trim()
      ) {
        errors.push(`${sectionBase}.section_name必须说明正文分区`);
      }
      if (!Array.isArray(section?.items) || section.items.length === 0) {
        errors.push(`${sectionBase}.items必须包含实际正文项`);
        continue;
      }
      section.items.forEach((item, itemIndex) => {
        items.push({
          sectionName: String(section?.section_name || ""),
          item,
          path: `${sectionBase}.items[${itemIndex}]`,
        });
      });
    }

    const distinctBodies = new Set();
    const evidenceReferences = declaredEvidenceReferences(output, deliverable);
    let verifiedBodyCount = 0;

    for (const { item, path } of items) {
      if (!isPlainObject(item)) {
        errors.push(
          `${path}必须是含label/result/evidence_ref/status的正文对象`,
        );
        continue;
      }
      const label = String(item.label || "").trim();
      const result = String(item.result || "").trim();
      const evidenceRef = String(item.evidence_ref || "").trim();
      const status = String(item.status || "").trim();

      if (label.length < 2 || result.length < 12) {
        errors.push(`${path}必须给出具体label和不少于12字的result正文`);
      }
      if (!WORK_PRODUCT_STATUSES.has(status)) {
        errors.push(`${path}.status只能是verified/assumption/gap`);
      }
      if (!evidenceReferences.has(evidenceRef)) {
        errors.push(`${path}.evidence_ref未回指本次来源`);
      }
      if (isClaimOnly(result)) {
        errors.push(`${path}正文只声明制品存在而未交付内容`);
      }
      if (label && result)
        distinctBodies.add(`${normalize(label)}|${normalize(result)}`);
      if (
        status === "verified" &&
        !isClaimOnly(result) &&
        !FUTURE_OR_MATERIAL_ONLY_PATTERN.test(result)
      ) {
        verifiedBodyCount += 1;
      }
    }

    if (distinctBodies.size < minimumItems) {
      errors.push(
        `${base}.work_product正文少于${minimumItems}项（互异正文为${distinctBodies.size}项）`,
      );
    }
    if (verifiedBodyCount === 0) {
      errors.push(
        `${base}.work_product所有正文项均为补材料或未来动作，至少需要1项verified实际结果`,
      );
    }

    const bodyText = normalize(
      items
        .map(
          ({ sectionName, item }) =>
            `${sectionName} ${item?.label || ""} ${item?.result || ""}`,
        )
        .join(" "),
    );
    const missingDimensions = coverageLabels.filter(
      (dimension) => !bodyText.includes(normalize(dimension)),
    );
    if (missingDimensions.length) {
      errors.push(
        `${base}.work_product未覆盖交付物核心维度：${missingDimensions.join("、")}`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

function artifactTypeFor(deliverableName) {
  if (/(?:地图|蓝图|龙卷风图|差距图|热图)/u.test(deliverableName))
    return "visual_model";
  if (/(?:评分卡|实验卡)/u.test(deliverableName)) return "decision_card";
  if (/(?:表|矩阵|清单|台账|登记册)/u.test(deliverableName))
    return "structured_table";
  if (/(?:模型|测算)/u.test(deliverableName)) return "calculation_model";
  if (/(?:计划|方案|脚本)/u.test(deliverableName)) return "execution_plan";
  return "structured_document";
}

function attachConcreteWorkProducts(output, contract) {
  for (const deliverableKey of contract.deliverableKeys) {
    const deliverable = output.deliverables[deliverableKey];
    const source = deliverable.evidence[0].source;
    const name = deliverable.deliverable_name;
    const requirement = contract.workProductRequirements[deliverableKey];
    const labels = [...requirement.coverageLabels];
    while (labels.length < requirement.minimumItems) {
      labels.push(`${name}正文项${labels.length + 1}`);
    }
    deliverable.work_product = {
      artifact_type: artifactTypeFor(name),
      sections: [
        {
          section_name: `${name}实际正文`,
          items: labels.map((label, index) => ({
            label,
            result:
              index === 0
                ? `${name}中的${label}已核验：门店A营业额100000元、订单2000单，并保留统计期间。`
                : `${name}中的${label}当前缺少第二统计期同口径记录，该项明确标记为证据缺口。`,
            evidence_ref: source,
            status: index === 0 ? "verified" : "gap",
          })),
        },
      ],
    };
  }
  return output;
}

test("提案验收器：101-161的346个目录交付物在提供具体正文、来源和状态后全部通过", () => {
  const catalog = loadRestaurantCatalog();
  const failures = [];
  let deliverableCount = 0;

  assert.deepEqual(
    catalog.employees.map((employee) => employee.idx),
    Array.from({ length: 61 }, (_, index) => index + 101),
  );

  for (const employee of catalog.employees) {
    const contract = getRestaurantOutputContract(employee.idx);
    const output = attachConcreteWorkProducts(
      buildRestaurantOutputDeliverableFixture(employee.idx),
      contract,
    );
    deliverableCount += contract.deliverableKeys.length;
    failures.push(
      ...proposedWorkProductAudit(employee.idx, output, contract).errors,
    );
  }

  assert.equal(deliverableCount, 346);
  assert.equal(failures.length, 0, failures.join("\n"));

  const idContract = getRestaurantOutputContract(103);
  const idOutput = buildRestaurantOutputDeliverableFixture(103);
  const firstDeliverable = idOutput.deliverables[idContract.deliverableKeys[0]];
  firstDeliverable.evidence[0].source = "【材料 E-103-1】证据编号 E-103-1-R1";
  attachConcreteWorkProducts(idOutput, idContract);
  firstDeliverable.work_product.sections[0].items[0].evidence_ref =
    "E-103-1-R1";
  const canonicalIdReference = proposedWorkProductAudit(
    103,
    idOutput,
    idContract,
  );
  assert.equal(
    canonicalIdReference.valid,
    true,
    `规范证据ID应能回指包含该ID的完整source：${canonicalIdReference.errors.join("；")}`,
  );
});

test("提案验收器：拒绝全gap/未来动作、错误来源回指和未覆盖核心维度的伪正文", () => {
  const contract = getRestaurantOutputContract(101);
  const base = attachConcreteWorkProducts(
    buildRestaurantOutputDeliverableFixture(101),
    contract,
  );
  const first = base.deliverables[contract.deliverableKeys[0]];

  for (const item of first.work_product.sections[0].items) {
    item.status = "gap";
    item.result = "后续补充材料后形成正式表格，当前仅记录未来收集动作。";
  }
  first.work_product.sections[0].items[0].evidence_ref = "不存在的外部附件";
  const allGap = proposedWorkProductAudit(101, base, contract);
  assert.equal(allGap.valid, false);
  assert.match(allGap.errors.join("；"), /所有正文项均为补材料或未来动作/u);
  assert.match(allGap.errors.join("；"), /evidence_ref未回指本次来源/u);

  const generic = attachConcreteWorkProducts(
    buildRestaurantOutputDeliverableFixture(101),
    contract,
  );
  const genericFirst = generic.deliverables[contract.deliverableKeys[0]];
  genericFirst.work_product.sections[0].section_name = "经营指标正文";
  genericFirst.work_product.sections[0].items[0].label = "经营指标一";
  genericFirst.work_product.sections[0].items[0].result =
    "门店A营业额为100000元，订单数量为2000单。";
  genericFirst.work_product.sections[0].items[1].label = "经营指标二";
  genericFirst.work_product.sections[0].items[1].result =
    "门店A食材成本为35000元，人工成本为22000元。";
  const missingDimensions = proposedWorkProductAudit(101, generic, contract);
  assert.equal(missingDimensions.valid, false);
  assert.match(missingDimensions.errors.join("；"), /未覆盖交付物核心维度/u);
});

test("核心接入门：103只声称已形成表、图、实验卡和附件时必须拒绝", () => {
  const task = {
    title: "品牌概念验证专项",
    requirement: "仅使用本次任务材料形成交付正文。",
  };
  const contract = getRestaurantOutputContract(103);
  const output = buildRestaurantOutputDeliverableFixture(103, task);
  const claims = [
    "已形成定位陈述、目标场景和非目标客群清单，共3项，详见附件。",
    "已形成品牌母题与产品/服务承诺表，共3项，详见附件。",
    "已形成概念一致性与能力差距图，共3项，详见附件。",
    "已形成风险假设清单及验证实验卡，共8项风险与4项实验，详见附件。",
    "已形成概念版本决策记录与下一步清单，共3项，详见附件。",
  ];

  contract.deliverableKeys.forEach((key, index) => {
    output.deliverables[key].summary = claims[index];
    delete output.deliverables[key].work_product;
  });

  const preflight = proposedWorkProductAudit(103, output, contract);
  assert.equal(preflight.valid, false);
  assert.equal(
    preflight.errors.filter((error) => error.includes("work_product正文少于"))
      .length,
    5,
  );
  assert.equal(
    preflight.errors.filter((error) => error.includes("只声明制品存在")).length,
    5,
  );

  const coreResult = validateRestaurantEmployeeOutputContract(103, output, {
    task,
  });
  assert.equal(
    coreResult.valid,
    false,
    `当前核心仍会接受103声明式空壳产物；v2必须将其拒绝。当前错误：${coreResult.errors.join("；") || "无"}`,
  );
});

test("核心接入门：101-161每个目录deliverable都必须带可验收work_product正文", () => {
  const catalog = loadRestaurantCatalog();
  const failures = [];
  let deliverableCount = 0;

  for (const employee of catalog.employees) {
    const contract = getRestaurantOutputContract(employee.idx);
    const output = buildRestaurantOutputDeliverableFixture(employee.idx);
    deliverableCount += contract.deliverableKeys.length;
    failures.push(
      ...proposedWorkProductAudit(employee.idx, output, contract).errors,
    );
  }

  assert.equal(deliverableCount, 346);
  assert.equal(
    failures.length,
    0,
    `核心v2尚未落地：101-161共有${failures.length}个work_product验收错误。\n${failures.slice(0, 16).join("\n")}`,
  );
});

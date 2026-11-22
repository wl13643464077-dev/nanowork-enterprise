import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canonicalRestaurantEmployeeProfileFor } from "../src/engines/canonical-employee-profile.js";
import {
  HUMAN_ORIGIN_TAG,
  buildEmployeeKernelDetail,
  buildEmployeeKernelSummary,
  redactEmployeeKernelDetail,
} from "../src/engines/employee-expert-kernel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = path.join(__dirname, "..", "catalog");
const EXPECTED_SKILLS_SHA256 =
  "74318ac3adef67c5f44ff92d353b429c72f131e6379fd3550bacc71e54b05c09";

function fileSha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("全部 61 位餐饮数字员工均具备完整真人专家内核（技能/步骤/交付/真实工具链）", () => {
  const skillsPath = path.join(CATALOG_DIR, "employee-skills.json");
  const restaurantPath = path.join(CATALOG_DIR, "restaurant.json");
  const beforeSkillsSha = fileSha256(skillsPath);
  const beforeRestaurantSha = fileSha256(restaurantPath);

  assert.equal(beforeSkillsSha, EXPECTED_SKILLS_SHA256);

  for (let idx = 101; idx <= 161; idx += 1) {
    const profile = canonicalRestaurantEmployeeProfileFor(idx);
    const detail = buildEmployeeKernelDetail(profile);
    const summary = buildEmployeeKernelSummary(profile.identity, profile);

    assert.ok(detail.skillCount > 0, `employee ${idx} skillCount must be > 0`);
    assert.ok(detail.coreSkills.length > 0, `employee ${idx} coreSkills must be non-empty`);
    assert.ok(detail.stepCount > 0, `employee ${idx} stepCount must be > 0`);
    assert.equal(detail.workflowSteps.length, detail.stepCount, `employee ${idx} stepCount mismatch`);
    assert.ok(detail.deliverables.length > 0, `employee ${idx} deliverables must be non-empty`);
    assert.ok(detail.tools.length >= 2, `employee ${idx} tools must have >= 2 items`);
    assert.equal(detail.humanOriginTag, HUMAN_ORIGIN_TAG);

    for (const step of detail.workflowSteps) {
      assert.ok(step.index >= 1, `employee ${idx} step index`);
      assert.ok(step.title.length > 0, `employee ${idx} step title`);
      assert.ok(step.summary.length > 0, `employee ${idx} step summary`);
      assert.ok(!step.title.includes("**"), `employee ${idx} step title must strip markdown`);
    }

    for (const deliverable of detail.deliverables) {
      assert.notEqual(deliverable, "提供：", `employee ${idx} should not include lead-in word`);
    }

    const toolKeys = new Set(detail.tools.map((tool) => tool.key));
    assert.ok(toolKeys.has("brand_kb"), `employee ${idx} must include brand_kb`);
    assert.ok(toolKeys.has("team_handoff"), `employee ${idx} must include team_handoff`);
    assert.ok(toolKeys.has("web_evidence"), `employee ${idx} must include web_evidence`);

    assert.equal(summary.skillCount, detail.skillCount);
    assert.equal(summary.stepCount, detail.stepCount);
    assert.ok(summary.topSkills.length > 0 && summary.topSkills.length <= 3);
    assert.ok(summary.topDeliverables.length > 0 && summary.topDeliverables.length <= 2);
    assert.equal(summary.tools.length, detail.tools.length);
    for (const tool of summary.tools) {
      assert.ok(tool.key && tool.shortLabel, `employee ${idx} summary tool key/shortLabel`);
    }
  }

  assert.equal(fileSha256(skillsPath), EXPECTED_SKILLS_SHA256);
  assert.equal(fileSha256(restaurantPath), beforeRestaurantSha);
});

test("关键专岗真实工具绑定精准无误（101/102 高德POI、161 巡店标准库、160 物料生图）", () => {
  for (const idx of [101, 102, 104]) {
    const detail = buildEmployeeKernelDetail({ idx });
    const keys = detail.tools.map((tool) => tool.key);
    assert.ok(keys.includes("amap_poi"), `employee ${idx} must bind amap_poi`);
    assert.equal(keys[0], "amap_poi", `employee ${idx} should highlight amap_poi first`);
  }

  const supervisor = buildEmployeeKernelDetail({ idx: 161 });
  const supervisorKeys = supervisor.tools.map((tool) => tool.key);
  assert.ok(supervisorKeys.includes("inspection_standards"));
  assert.equal(supervisorKeys[0], "inspection_standards");
  assert.ok(!supervisorKeys.includes("amap_poi"));

  const superManager = buildEmployeeKernelDetail({ idx: 160 });
  const superManagerKeys = superManager.tools.map((tool) => tool.key);
  assert.ok(superManagerKeys.includes("campaign_materials"));
  assert.equal(superManagerKeys[0], "campaign_materials");
  assert.ok(superManagerKeys.includes("assumption_refine"));
  assert.ok(superManagerKeys.includes("store_data_pack"));

  const menu = buildEmployeeKernelDetail({ idx: 108 });
  assert.ok(menu.tools.some((tool) => tool.key === "store_data_pack"));
  assert.ok(menu.tools.some((tool) => tool.key === "assumption_refine"));
  assert.ok(!menu.tools.some((tool) => tool.key === "amap_poi"));

  const reviewOps = buildEmployeeKernelDetail({ idx: 143 });
  assert.ok(reviewOps.tools.some((tool) => tool.key === "review_dataset_import"));

  const copywriter = buildEmployeeKernelDetail({ idx: 140 });
  assert.ok(copywriter.tools.some((tool) => tool.key === "poster_text_overlay"));

  const offlineDetail = buildEmployeeKernelDetail({ idx: 108 }, { webMode: "off" });
  assert.ok(!offlineDetail.tools.some((tool) => tool.key === "web_evidence"));
});

test("已启用补充技能叠加计入 skillCount 与 coreSkills，且掩码版本不泄露内部步骤与技能标题", () => {
  const withSupplement = buildEmployeeKernelDetail(
    { idx: 161 },
    {
      enabledSupplements: [
        { title: "连锁三级巡查节奏" },
        { title: "照片巡店的取证规范" },
      ],
    },
  );
  assert.equal(withSupplement.skillCount, 3);
  assert.ok(withSupplement.coreSkills.some((item) => item.title === "连锁三级巡查节奏"));

  const full101 = buildEmployeeKernelDetail({ idx: 101 });
  const redacted101 = redactEmployeeKernelDetail(full101);
  assert.equal(redacted101.redacted, true);
  assert.equal(redacted101.skillCount, full101.skillCount);
  assert.equal(redacted101.stepCount, full101.stepCount);
  assert.deepEqual(redacted101.coreSkills, []);
  assert.deepEqual(redacted101.workflowSteps, []);
  assert.deepEqual(redacted101.tools, full101.tools);
  assert.deepEqual(redacted101.deliverables, full101.deliverables);
});

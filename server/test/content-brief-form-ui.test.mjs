import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildPaihuoContentBrief } from "../../web/src/components/contentBriefForm.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("content dispatch projects the existing fields into the exact Paihuo Brief contract", () => {
  const brief = buildPaihuoContentBrief({
    title: "  写一篇新品上市种草文  ",
    type: "产品软文",
    industry: "餐饮连锁",
    requirement: "已确认的产品资料与价格表",
    refLink: "https://example.com/reference",
    platforms: ["小红书", "抖音", "小红书"],
    imageMode: "mix",
    imageCount: 4,
    enableDeck: true,
    xhsStyle: { name: "真实测评", desc: "先结论后证据" },
    dyStyle: { name: "老板口播", desc: "前3秒说明问题" },
  });

  assert.deepEqual(brief, {
    direction: "写一篇新品上市种草文",
    template: "产品软文",
    industry: "餐饮连锁",
    material: "已确认的产品资料与价格表",
    ref_link: "https://example.com/reference",
    platforms: ["小红书", "抖音"],
    image_mode: "mix",
    image_count: 4,
    enable_deck: true,
    xhs_style: { name: "真实测评", desc: "先结论后证据" },
    dy_style: { name: "老板口播", desc: "前3秒说明问题" },
  });
  assert.deepEqual(Object.keys(brief), [
    "direction",
    "template",
    "industry",
    "material",
    "ref_link",
    "platforms",
    "image_mode",
    "image_count",
    "enable_deck",
    "xhs_style",
    "dy_style",
  ]);
});

test("image_count null and zero both retain automatic semantics without inventing a count", () => {
  const base = {
    title: "任务目标",
    type: "日更选题",
    requirement: "真实业务素材",
    platforms: ["公众号"],
    imageMode: "real",
  };
  assert.equal(
    buildPaihuoContentBrief({ ...base, imageCount: null }).image_count,
    null,
  );
  assert.equal(
    buildPaihuoContentBrief({ ...base, imageCount: 0 }).image_count,
    0,
  );
  assert.equal(buildPaihuoContentBrief(base).image_count, null);
});

test('minimal dispatch brief only needs question and fills safe role defaults', () => {
  assert.deepEqual(buildPaihuoContentBrief({ question: '判断新品上市后的主要风险' }), {
    direction: '判断新品上市后的主要风险',
    template: '',
    industry: '',
    material: '',
    ref_link: '',
    platforms: ['小红书'],
    image_mode: 'ai',
    image_count: null,
    enable_deck: false,
    xhs_style: null,
    dy_style: null,
  });
  assert.throws(() => buildPaihuoContentBrief({}), /问题或任务目标/u);
});

test("styles are null unless their target platform is selected", () => {
  const brief = buildPaihuoContentBrief({
    title: "任务目标",
    type: "观点输出",
    requirement: "真实业务素材",
    platforms: ["公众号"],
    imageMode: "ai",
    xhsStyle: { name: "不应提交", desc: "未选中小红书" },
  });
  assert.equal(brief.xhs_style, null);
  assert.equal(brief.dy_style, null);
  assert.throws(
    () =>
      buildPaihuoContentBrief({
        title: "任务目标",
        type: "观点输出",
        requirement: "真实材料",
        platforms: [],
        imageMode: "ai",
      }),
    /至少选择/,
  );
});

test("content profile editor is manager-only and uses the dedicated GET/PUT endpoints", () => {
  const workbench = read("web/src/components/EmployeeWorkbench.tsx");
  const editor = read("web/src/components/ContentBrandPersonaEditor.tsx");
  assert.match(
    workbench,
    /question: values\.question[\s\S]*title: values\.title[\s\S]*type: values\.type[\s\S]*requirement: values\.requirement/u,
  );
  assert.match(workbench, /name="question"[\s\S]*问题至少2个字/u);
  assert.match(workbench, /已验证并默认启用/u);
  assert.doesNotMatch(workbench, /历史技能\s*[·:：].*待核验/u);
  assert.doesNotMatch(workbench, /业务效果待实测/u);
  assert.match(workbench, /brief: buildPaihuoContentBrief\([\s\S]*values\.question/u);
  assert.match(
    workbench,
    /\['boss', 'admin', 'platform_super'\]\.includes\(currentUser\?\.role \|\| ''\)/u,
  );
  assert.match(workbench, /canManageContentProfile &&/u);
  assert.match(editor, /api\.get\('\/employee-workbench\/content\/profile'\)/u);
  assert.match(editor, /api\.put\('\/employee-workbench\/content\/profile'/u);
  assert.match(editor, /expectedRevision: revision/u);
});

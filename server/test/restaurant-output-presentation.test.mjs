import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isRestaurantStructuredOutput,
  restaurantOutputMarkdown,
  restaurantOutputPresentation,
} from "../../web/src/components/restaurantOutputPresentation.js";
import {
  prepareRestaurantOutputForExport,
  renderRestaurantOutputForExport,
} from "../src/engines/restaurant-output-export.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function restaurantFixture() {
  return {
    contract_id: "urn:nanowork:restaurant-output:102:test:v3",
    role: {
      employee_idx: 102,
      role_key: "trade-area-profile",
      role_title: "竞品与商圈画像",
    },
    decision_context: {
      problem: "请完整评估在太原吾悦广场周边开一家毛血旺店的市场机会、证据边界和90天验证方案",
      period: "2026年8月",
      scope: "覆盖商圈、竞品、客群和经营机会。",
      sources: [
        {
          source: "高德公开榜单｜https://example.com/amap-rank",
          period: "2026年8月",
          fact: "样本中存在毛血旺直接竞品。",
        },
      ],
      assumptions: [
        {
          assumption: "主入口坐标暂按地图锚点处理。",
          impact: "入口偏差会影响等时圈判断。",
          verification: "商圈研究员在1个工作日内到店核验。",
        },
      ],
    },
    input_audit: {
      input_01: {
        input_name: "岗位手册内部输入原文（不得在老板报告展示）",
        status: "supplied",
        finding: "已取得目标商场公开业态和周边餐饮样本。",
        evidence_refs: ["高德公开榜单｜https://example.com/amap-rank"],
        impact: "可以初步判断直接竞品存在性，但不能代替线下客流核验。",
        verification: {
          owner: "商圈研究员",
          action: "核验商场楼层与入口客流",
          deadline: "1个工作日内",
        },
      },
      input_02: {
        input_name: "内部提示词中的第二项输入（不得展示原文）",
        status: "missing",
        finding: "尚缺同层竞品菜单价与团购成交价。",
        evidence_refs: ["高德公开榜单｜https://example.com/amap-rank"],
        impact: "暂不能锁定主价格带与毛利空间。",
        verification: {
          owner: "竞品分析员",
          action: "采集竞品菜单与团购页",
          deadline: "1个工作日内",
        },
      },
    },
    method_execution: {
      method_01: {
        step_name: "岗位技能内部步骤原文（不得在老板报告展示）",
        status: "completed",
        actual_execution: "已完成公开商户样本去重，确认两家直接竞品。",
        evidence_refs: ["高德公开榜单｜https://example.com/amap-rank"],
        missing: "当前无阻断，仍需线下复核营业状态。",
        next_action: "商圈研究员在1个工作日内复核营业状态。",
      },
      method_02: {
        step_name: "内部方法第二步（不得展示原文）",
        status: "partial",
        actual_execution: "已形成价格采集字段表，尚未拿到成交价样本。",
        evidence_refs: ["高德公开榜单｜https://example.com/amap-rank"],
        missing: "缺少菜单价和团购成交价。",
        next_action: "竞品分析员在1个工作日内补齐价格样本。",
      },
    },
    deliverables: {
      deliverable_01: {
        deliverable_name: "商圈与竞品判断表",
        summary: "形成可供老板判断的商圈与竞品初稿。",
        work_product: {
          artifact_type: "structured_table",
          sections: [
            {
              section_name: "核心判断",
              items: [
                {
                  label: "直接竞品",
                  result: "陶然居的毛血旺口碑构成直接竞争。",
                  evidence_ref: "高德公开榜单",
                  status: "verified",
                },
                {
                  label: "价格带",
                  result: "当前缺少菜单价与团购价，不能确定主价格带。",
                  evidence_ref: "高德公开榜单",
                  status: "gap",
                },
                {
                  label: "风险1：直接竞品强",
                  result: "直接竞品已经占据毛血旺口味心智。",
                  evidence_ref: "高德公开榜单",
                  status: "verified",
                },
              ],
            },
          ],
        },
        evidence: [
          {
            source: "竞品菜单公开页",
            period: "2026年8月",
            finding: "当前页面只支持竞品存在性，尚不支持精确定价。",
          },
        ],
        actions: [
          {
            action: "采集吾悦广场同层竞品菜单与团购价格",
            owner: "竞品分析员",
            deadline: "1个工作日内",
            success_metric: "形成含单品价、套餐价和客单价的核验表。",
          },
        ],
        acceptance_checks: [
          {
            criterion: "结论有来源且缺口已披露",
            result: "pass",
            evidence: "正文分别标记已核验事实与证据缺口。",
          },
        ],
      },
      deliverable_02: {
        deliverable_name: "三公里客群分层图",
        summary: "保留商圈画像岗位独有的分时客群判断。",
        work_product: {
          artifact_type: "visual_model",
          sections: [
            {
              section_name: "午晚餐客群迁徙判断",
              items: [
                {
                  label: "办公客群晚餐转化窗口",
                  result: "工作日晚餐需要继续核验写字楼下班后的真实到店路径。",
                  evidence_ref: "urn:nanowork:evidence:test:office-dinner",
                  status: "assumption",
                },
              ],
            },
          ],
        },
        evidence: [
          {
            source: "商场公开业态图",
            period: "2026年8月",
            finding: "周边存在办公与家庭客群并存的初步信号。",
          },
        ],
        actions: [],
        acceptance_checks: [],
      },
    },
    quality_review: {
      checks: {
        quality_01: {
          criterion: "线上热度与真实交易不混用",
          status: "pass",
          evidence: "正文已分开表述。",
        },
      },
      overall_status: "pass",
      review_note: "结构化岗位正文已通过当前质量检查。",
    },
    safety_review: {
      checks: {
        safety_01: {
          boundary: "价格需来源与核验日",
          status: "needs_review",
          handling: "补齐菜单与团购页后再定价。",
        },
      },
      overall_status: "needs_review",
      escalation_note: "补证前不得外发为最终定案。",
    },
    approval: {
      status: "routed_by_task_policy",
      reviewer_roles: ["任务快照策略"],
      external_action_allowed: false,
      financial_or_regulatory_commitment_allowed: false,
      review_note: "外发、付款和调价需另行授权。",
    },
    provider: { name: "云端模型服务", model: "report-model-v3" },
    usage: { inputTokens: 1234, outputTokens: 2345 },
    provider_response_sha256: "abc123def456",
  };
}

test("餐饮结构化报告使用短标题与一页老板速览，岗位专属栏目完整保留", () => {
  const raw = JSON.stringify(restaurantFixture());
  const view = restaurantOutputPresentation(raw, "备用标题");
  const markdown = view.fullMarkdown;

  assert.equal(isRestaurantStructuredOutput(raw), true);
  assert.equal(view.structured, true);
  assert.equal(view.deliverableCount, 2);
  for (const heading of [
    "# 竞品与商圈画像｜太原吾悦广场",
    "## 决策建议与置信度",
    "## 核心证据",
    "## 主要风险",
    "## 下一步",
    "## 交付成果（岗位完整正文）",
    "## 输入与方法执行记录",
    "## 质量与授权记录",
    "## 技术附录（内部追溯）",
  ]) {
    assert.match(
      markdown,
      new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
  }
  assert.doesNotMatch(
    view.overviewMarkdown.split("\n")[0],
    /请完整评估|90天验证方案/u,
  );
  assert.match(
    view.overviewMarkdown,
    /\[高德公开榜单\]\(https:\/\/example\.com\/amap-rank\).*样本中存在毛血旺直接竞品/u,
  );
  assert.doesNotMatch(
    view.overviewMarkdown,
    /\[高德公开榜单｜https:\/\/example\.com\/amap-rank/u,
  );
  for (const fact of [
    "陶然居的毛血旺口碑构成直接竞争",
    "当前缺少菜单价与团购价",
    "高德公开榜单",
    "入口偏差会影响等时圈判断",
    "采集吾悦广场同层竞品菜单与团购价格",
    "竞品分析员",
    "补证前不得外发为最终定案",
    "外发、付款和调价需另行授权",
    "午晚餐客群迁徙判断",
    "办公客群晚餐转化窗口",
  ]) {
    assert.match(markdown, new RegExp(fact, "u"));
  }
  assert.match(markdown, /直接竞品.*已核验事实/u);
  assert.match(markdown, /价格带.*证据缺口/u);
  assert.match(markdown, /自动对外执行.*未允许，需另行授权/u);
  const riskSection = markdown.slice(
    markdown.indexOf("## 主要风险"),
    markdown.indexOf("## 下一步"),
  );
  assert.match(
    riskSection,
    /风险1：直接竞品强.*直接竞品已经占据毛血旺口味心智/u,
  );
  assert.equal((riskSection.match(/风险1：直接竞品强/gu) || []).length, 1);
  assert.doesNotMatch(
    view.overviewMarkdown,
    /contract_id|输出契约|report-model-v3|abc123def456/u,
  );
  assert.doesNotMatch(view.overviewMarkdown, /午晚餐客群迁徙判断/u);
  assert.doesNotMatch(view.overviewMarkdown, /input_audit|method_execution|岗位手册内部输入原文/u);
  assert.match(view.deliverablesMarkdown, /午晚餐客群迁徙判断/u);
  assert.match(view.deliverablesMarkdown, /办公客群晚餐转化窗口/u);
  assert.match(view.inputMethodMarkdown, /输入覆盖：2\/2/u);
  assert.match(view.inputMethodMarkdown, /方法覆盖：2\/2/u);
  assert.match(view.inputMethodMarkdown, /已取得目标商场公开业态和周边餐饮样本/u);
  assert.match(view.inputMethodMarkdown, /尚缺同层竞品菜单价与团购成交价/u);
  assert.match(view.inputMethodMarkdown, /已完成公开商户样本去重/u);
  assert.match(view.inputMethodMarkdown, /缺少菜单价和团购成交价/u);
  assert.doesNotMatch(
    view.inputMethodMarkdown,
    /岗位手册内部输入原文|内部提示词|岗位技能内部步骤原文|Token|哈希|report-model-v3/u,
  );
  assert.match(
    view.technicalAppendixMarkdown,
    /urn:nanowork:restaurant-output:102:test:v3/u,
  );
  assert.match(view.technicalAppendixMarkdown, /report-model-v3/u);
  assert.match(view.technicalAppendixMarkdown, /输入 Token.*1234/u);
  assert.match(view.technicalAppendixMarkdown, /abc123def456/u);
  assert.match(
    view.technicalAppendixMarkdown,
    /urn:nanowork:evidence:test:office-dinner/u,
  );
  assert.doesNotMatch(markdown, /\{"|"contract_id"\s*:|"work_product"\s*:/u);
});

test("前端历史结构化报告的任务范围优先使用完整 requirement，不展示截断标题", () => {
  const fixture = restaurantFixture();
  fixture.decision_context.problem = "太原吾悦广场商圈画像";
  const requirement =
    "请完整评估太原吾悦广场周边毛血旺开店机会，核验商圈边界、竞品密度、客群时段、价格带和证据缺口，并给出负责人、截止时间与90天验证动作；本段用于验证历史任务标题截断时仍展示完整原始要求。";
  const view = restaurantOutputPresentation(JSON.stringify(fixture), {
    title: "太原吾悦广场商圈画像",
    requirement,
  });
  assert.match(view.inputMethodMarkdown, new RegExp(requirement, "u"));
  assert.doesNotMatch(view.inputMethodMarkdown, /完整任务\*\*：太原吾悦广场商圈画像$/mu);
  assert.doesNotMatch(view.inputMethodMarkdown, /contract_id|input_audit|岗位手册内部输入原文/u);
});

test("服务端所有导出格式共用短标题、老板速览和输入方法附录", () => {
  const fixture = restaurantFixture();
  const fullRequirement =
    "请围绕太原吾悦广场周边的毛血旺开店机会，完整核验商圈边界、竞品密度、客群时段、价格带、证据来源和90天验证动作；报告需说明每项判断的依据、缺口、负责人、截止时间与可执行验收标准，不能把短标题当作完整任务。";
  const taskContext = { title: "任务原始长标题", requirement: fullRequirement };
  const markdown = renderRestaurantOutputForExport(fixture, taskContext);
  const prepared = prepareRestaurantOutputForExport(JSON.stringify(fixture), taskContext);

  assert.equal(prepared.transformed, true);
  assert.equal(prepared.body, markdown);
  assert.match(markdown, /^# 竞品与商圈画像｜太原吾悦广场$/mu);
  const taskRange = markdown.slice(
    markdown.indexOf("## 任务范围"),
    markdown.indexOf("## 附录 A · 输入与方法执行记录"),
  );
  assert.match(taskRange, new RegExp(`\\| 完整任务 \\| ${fullRequirement} \\|`, "u"));
  assert.ok(fullRequirement.length > 100, "回归要求必须覆盖真实长任务正文");
  assert.doesNotMatch(taskRange, /contract_id|input_audit|method_execution|岗位手册内部输入原文/u);
  for (const heading of [
    "## 决策建议与置信度",
    "## 核心证据",
    "## 主要风险",
    "## 下一步",
    "## 附录 A · 输入与方法执行记录",
    "## 交付成果（岗位完整正文）",
    "## 附录 B · 质量与授权记录",
    "## 附录 C · 来源追溯",
  ]) {
    assert.match(markdown, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(
    markdown,
    /\[高德公开榜单\]\(https:\/\/example\.com\/amap-rank\).*样本中存在毛血旺直接竞品/u,
  );
  assert.doesNotMatch(markdown, /岗位手册内部输入原文|岗位技能内部步骤原文/u);
  assert.match(markdown, /已取得目标商场公开业态和周边餐饮样本/u);
  assert.match(markdown, /已完成公开商户样本去重/u);
  assert.match(markdown, /午晚餐客群迁徙判断/u);
  assert.doesNotMatch(markdown, /Token|响应哈希|report-model-v3|abc123def456/u);
});

test("普通 Markdown 与无法识别的 JSON 必须原样返回，双层 JSON 包装仍可识别", () => {
  const markdown = "# 已有报告\n\n- 保持原样\n";
  const unrelatedJson = '{"name":"普通数据","items":[1,2]}';
  assert.equal(restaurantOutputMarkdown(markdown), markdown);
  assert.equal(restaurantOutputMarkdown(unrelatedJson), unrelatedJson);

  const wrapped = JSON.stringify({
    contents: { body: JSON.stringify(restaurantFixture()) },
  });
  const rendered = restaurantOutputMarkdown(wrapped);
  assert.equal(isRestaurantStructuredOutput(wrapped), true);
  assert.match(rendered, /# 竞品与商圈画像｜太原吾悦广场/u);
  assert.match(rendered, /#### 核心判断/u);
});

test("员工工作台用分层报告驱动老板速览、折叠全文与完整下载，不再展示 raw JSON", () => {
  const workbench = fs.readFileSync(
    path.join(repoRoot, "web/src/components/EmployeeWorkbench.tsx"),
    "utf8",
  );
  assert.match(
    workbench,
    /restaurantOutputPresentation\(restaurantOutputBody, \{[\s\S]*title: restaurantTask\?\.title,[\s\S]*requirement: restaurantTask\?\.requirement,[\s\S]*\}\)/u,
  );
  assert.match(
    workbench,
    /content=\{localizeOperationalStatus\(restaurantOutputReport\)\}/u,
  );
  assert.match(workbench, /restaurantReportView\.overviewMarkdown/u);
  assert.match(workbench, /restaurantReportView\.deliverablesMarkdown/u);
  assert.match(workbench, /restaurantReportView\.inputMethodMarkdown/u);
  assert.match(workbench, /restaurantReportView\.governanceMarkdown/u);
  assert.match(workbench, /restaurantReportView\.technicalAppendixMarkdown/u);
  assert.match(workbench, /<strong>岗位完整成果<\/strong>/u);
  assert.match(workbench, /<strong>输入与方法执行记录<\/strong>/u);
  assert.match(workbench, /<strong>技术附录<\/strong>/u);
  assert.match(workbench, /<strong>运行与交付记录<\/strong>/u);
  assert.doesNotMatch(
    workbench,
    /<Markdown content=\{localizeOperationalStatus\(restaurantOutputBody\)\}/u,
  );
});

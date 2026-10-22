import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const requireWeb = createRequire(path.join(root, "web/package.json"));
const ts = requireWeb("typescript");
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
function loadComponent(file) {
  const source = fs
    .readFileSync(path.join(root, file), "utf8")
    .replace(/^import ['"].*\.css['"];?$/gm, "");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    requireWeb,
    module,
    module.exports,
  );
  return module.exports;
}
const { default: Timeline, executionStageLabel } = loadComponent(
  "web/src/components/EmployeeExecutionTimeline.tsx",
);
const { default: Research } = loadComponent(
  "web/src/components/EmployeeResearchPlan.tsx",
);
const progress = {
  currentStage: "generate",
  currentLabel: "模型返回岗位交付",
  percent: 68,
  receivedChars: 9200,
  attemptNumber: 2,
  phase: "acquire",
  lastActivityAt: "2026-09-05T10:00:00Z",
  steps: [
    {
      stage: "search",
      kind: "search",
      label: "核对公开资料",
      at: "2026-09-05T09:59:00Z",
      status: "done",
      count: 8,
      attemptNumber: 2,
    },
  ],
};

test("阶段取自服务端事实：已知阶段简明化，未知阶段保留原文，未收到进度不编造阶段", () => {
  assert.equal(executionStageLabel(progress), "正在生成内容");
  assert.equal(executionStageLabel({ currentStage: "settle" }), "正在核对费用");
  assert.equal(
    executionStageLabel({
      currentStage: "new_stage",
      currentLabel: "正在核对店名",
    }),
    "正在核对店名",
  );
  assert.equal(executionStageLabel(null), "正在等待任务进度");
});

test("普通视图只显示阶段与无百分比忙碌条，步骤保留在默认关闭详情", () => {
  const html = renderToStaticMarkup(
    React.createElement(Timeline, { progress }),
  );
  assert.match(html, /正在生成内容/);
  assert.match(html, /role="progressbar"/);
  assert.doesNotMatch(html, /aria-valuenow|68%|9,200|第 2 次生成|响应字符/);
  assert.match(
    html,
    /<details class="employee-execution-details"><summary>查看详情<\/summary>/,
  );
  assert.match(html, /核对公开资料/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|>)/);
});

test("完成或异常后不保留忙碌条，诊断明确启用才渲染响应计数且仍默认折叠", () => {
  for (const currentStage of ["done", "error"]) {
    const html = renderToStaticMarkup(
      React.createElement(Timeline, {
        progress: { ...progress, currentStage },
      }),
    );
    assert.doesNotMatch(html, /role="progressbar"|可稍后回来/);
  }
  const html = renderToStaticMarkup(
    React.createElement(Timeline, { progress, diagnostics: true }),
  );
  assert.match(html, /9,200 个响应字符/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|>)/);
});

test("来源检索记录默认关闭但保留真实步骤和核验统计，无资料时不生成空卡", () => {
  assert.equal(renderToStaticMarkup(React.createElement(Research, {})), "");
  const html = renderToStaticMarkup(
    React.createElement(Research, {
      evidence: {
        skillResearchPlan: { lanes: [{ key: "a", label: "核对门店地址" }] },
        sourceQuality: {
          locationAnchorCount: 3,
          directRestaurantSourceCount: 2,
          acceptedCount: 5,
          rejectedCount: 1,
          passed: true,
        },
      },
    }),
  );
  assert.match(
    html,
    /<details class="employee-research-plan"><summary>来源资料与检索详情<\/summary>/,
  );
  assert.match(html, /核对门店地址/);
  assert.match(html, /地点\/路网 3/);
  assert.doesNotMatch(html, /\bopen=|SKILLS → TOOLS/);
});

test("任务页正文优先：完整报告不折叠，费用和异常在正文前，输入与来源默认折叠", () => {
  const task = fs.readFileSync(
    path.join(root, "web/src/pages/TaskCenter.tsx"),
    "utf8",
  );
  const workbench = fs.readFileSync(
    path.join(root, "web/src/components/EmployeeWorkbench.tsx"),
    "utf8",
  );
  assert.ok(
    task.indexOf("task-center-result") <
      task.indexOf("<summary>任务输入</summary>"),
  );
  assert.ok(
    task.indexOf('message="执行异常"') <
      task.indexOf("task-center-result"),
  );
  assert.match(
    task,
    /navigator\.clipboard\.writeText\(resultView\.markdown\)/,
  );
  assert.match(task, /canViewDiagnostics &&/);
  assert.doesNotMatch(task, /<Progress|percent=\{row\.progress\}/);
  assert.match(
    workbench,
    /<section className="ewb-run-output ewb-report-full" aria-label="完整报告">/,
  );
  assert.match(
    workbench,
    /<Markdown content=\{localizeOperationalStatus\(restaurantReportView\.deliverablesMarkdown\)\} \/>/,
  );
  assert.doesNotMatch(workbench, /<strong>完整报告<\/strong>/);
});

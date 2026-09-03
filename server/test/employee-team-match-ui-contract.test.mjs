import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("API 错误保留 team-plan 失败的状态、可重试性、请求编号和账务证据", () => {
  const client = read("web/src/api/client.ts");

  assert.match(client, /export type ApiRequestError/);
  assert.match(client, /status\?: number/);
  assert.match(client, /code\?: string/);
  assert.match(client, /retryable\?: boolean/);
  assert.match(client, /requestId\?: string/);
  assert.match(client, /billing\?: Record<string, unknown>/);
  assert.match(client, /res\.headers\.get\('x-request-id'\) \|\| requestId/);
  assert.match(
    client,
    /billing: data\.billing && typeof data\.billing === 'object'/,
  );
  assert.match(client, /code: aborted \? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR'/);
  assert.match(
    client,
    /data\.requestId = responseRequestId/,
    "2xx 账务门禁也必须拿到请求编号",
  );
});

test("team-plan 失败只展示真实失败、退款与请求证据，不把模板当产出", () => {
  const component = read("web/src/components/EmployeeTeamMatch.tsx");
  const runPlan = component.slice(
    component.indexOf("const runPlan = async"),
    component.indexOf("const runSummary = async"),
  );
  const failureCatch = runPlan.slice(runPlan.indexOf("} catch"));

  assert.match(
    runPlan,
    /api\.post\([\s\S]*'\/employees\/team-plan'[\s\S]*\{ silent: true \}/,
  );
  assert.match(runPlan, /TEAM_PLAN_INVALID_RESPONSE/);
  assert.match(runPlan, /不会用模板冒充产出/);
  assert.match(failureCatch, /setPlanError\(teamPlanFailure/);
  assert.doesNotMatch(
    failureCatch,
    /setStored\(/,
    "失败分支不得写入任何拆解产出",
  );

  assert.match(component, /真实上游暂时异常，队长拆解未完成/);
  assert.match(component, /预授权已全额退回（已退款），本次拆解未扣费/);
  assert.match(component, /本次没有生成拆解产出，系统未使用模板或降级底稿代替/);
  assert.match(component, /请求编号：/);
  assert.match(component, /重新尝试拆解/);
  assert.match(component, /服务未返回退款状态，请以积分流水为准/);
  assert.match(
    component,
    /billingState === 'released' \|\| billing\.refunded === true/,
  );
});

test("team-plan 仅在账务 settled 后保存或自动派活", () => {
  const component = read("web/src/components/EmployeeTeamMatch.tsx");
  const runPlan = component.slice(
    component.indexOf("const runPlan = async"),
    component.indexOf("const runSummary = async"),
  );
  const billingGate = runPlan.indexOf("billingState !== 'settled'");
  const persistPlan = runPlan.indexOf("setStored(current =>");
  const autoDispatch = runPlan.indexOf("if (mode === 'auto')");

  assert.ok(billingGate >= 0, "必须检查成功响应的 billing.state");
  assert.ok(persistPlan > billingGate, "只有账务 settled 后才能保存拆解结果");
  assert.ok(autoDispatch > billingGate, "只有账务 settled 后才能进入自动派活");
  assert.match(runPlan, /TEAM_PLAN_BILLING_NOT_SETTLED/);
  assert.match(runPlan, /账务尚未确认结算；为避免误派活，本次结果已拦截/);
  assert.match(component, /账务待核对，本次拆解已停止派活/);
  assert.match(component, /系统未保存、未展示、未自动派活/);
  assert.match(
    component,
    /\['TEAM_PLAN_BILLING_NOT_SETTLED', 'TEAM_PLAN_BILLING_UNSETTLED'\]\.includes\(code\)/,
    "兼容正式后端错误码与旧前端草案错误码",
  );
});

test("队长收尾是可扫读、无孤卡且不拆日期数字的响应式老板视图", () => {
  const component = read("web/src/components/EmployeeTeamMatch.tsx");
  const css = read("web/src/components/EmployeeTeamMatch.css");
  const metrics = component.slice(
    component.indexOf('className="team-summary-metrics"'),
    component.indexOf('className="team-summary-progress"'),
  );

  assert.match(component, /function splitSummaryStatements/);
  assert.ok(
    component.includes("text.match(/[^。！？!?；;\\n]+[。！？!?；;]?/gu)"),
    "汇报必须按中文句子拆分",
  );
  assert.match(
    component,
    /Array\.from\(statements\[0\]\)\.length <= 220/,
    "无标点长汇报也必须拆分",
  );
  assert.match(
    component,
    /className="team-summary-lead"/,
    "首句必须提升为老板先读的结论",
  );
  assert.match(
    component,
    /<details className="team-summary-disclosure">/,
    "长汇报必须可展开而非整屏堆叠",
  );
  assert.match(
    component,
    /className="team-summary-detail-list"/,
    "其余句子必须分段呈现",
  );
  assert.match(
    component,
    /summaryDetails\.slice\(0, 2\)\.join\(' '\)/,
    "预览必须保留完整句子",
  );
  assert.doesNotMatch(
    component,
    /summaryDetailsText\.slice\(/,
    "预览不得按字符硬切日期或英文",
  );

  assert.match(
    metrics,
    /data-count=\{teamSummary\.keyNumbers\?\.length \|\| 0\}/,
  );
  assert.ok(
    metrics.indexOf("{item.label}") < metrics.indexOf("{item.value}"),
    "指标内必须先显示名称再显示数值",
  );
  assert.match(metrics, /team-summary-number-source/);
  assert.match(component, /className="team-summary-number-token"/);
  assert.match(component, /renderMetricValue\(item\.value\)/);
  assert.match(metrics, /来自本次成员汇总/);
  assert.match(component, /<time dateTime=\{teamSummary\.summarizedAt\}>/);

  assert.match(css, /container-type: inline-size/);
  assert.match(css, /@container \(min-width: 1120px\)/);
  assert.match(
    css,
    /data-count='5'[\s\S]*nth-child\(4\)[\s\S]*grid-column: 2 \/ span 2/,
  );
  assert.match(
    css,
    /data-count='7'[\s\S]*nth-child\(5\)[\s\S]*grid-column: 2 \/ span 2/,
  );
  assert.match(
    css,
    /@container \(min-width: 600px\) and \(max-width: 1119px\)/,
  );
  assert.match(
    css,
    /last-child:nth-child\(odd\)[\s\S]*grid-column: 2 \/ span 2/,
  );
  assert.doesNotMatch(css, /grid-auto-flow: dense/);
  assert.doesNotMatch(
    css,
    /team-summary-number\.is-wide[\s\S]{0,160}grid-column/,
  );
  assert.match(
    css,
    /team-summary-number strong\.is-atomic[\s\S]*white-space: nowrap/,
  );
  assert.match(css, /team-summary-number-token[\s\S]*white-space: nowrap/);
  assert.doesNotMatch(
    css,
    /team-summary-number strong[\s\S]{0,300}word-break: break-all/,
  );
  assert.doesNotMatch(css, /team-summary-numbers[\s\S]{0,180}auto-fill/);
});

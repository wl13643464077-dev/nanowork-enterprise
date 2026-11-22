import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("登录落地页宣传权威73位口径，普通内部产出不再被写成一刀切待审", () => {
  const login = read("web/src/pages/Login.tsx");

  assert.match(
    login,
    /<em>73 位数字员工<\/em>/u,
    "总数应为61餐饮（60核心+1扩展）+10 Paihuo+1 AI带货员+1 AI小红书种草员",
  );
  assert.match(login, /\{ value: '61', label: '餐饮数字员工 · 8 大分部' \}/u);
  assert.match(login, /\{ value: '12', label: '内容生产与种草带货数字员工' \}/u);
  assert.match(login, /title: '61 位懂餐饮的数字员工'/u);
  assert.match(login, /title: '内容生产仓 · 10 工位流水线'/u);

  // 只有外发、付费和不可逆动作需要老板执行授权；“所有产出先进待审阅”
  // 会误导普通内部 auto 产出，不能继续出现在登录承诺里。
  assert.doesNotMatch(login, /严格输出契约 \+ 人工审核/u);
  assert.doesNotMatch(login, /所有产出先进待审阅/u);
  assert.match(login, /普通内部产出|自动采用|人工确认|外发/u);

  // 落地页的功能卡只使用图片/Ant 图标，不能把旧 emoji 当产品图标契约。
  assert.doesNotMatch(login, /emoji\s*:/u);
  assert.doesNotMatch(login, /[\u{1F300}-\u{1FAFF}]/u);
});

test("内容员工工作台 UI 只按 API 权限显示内部档案，三类特权角色均在白名单", () => {
  const workbench = read("web/src/components/EmployeeWorkbench.tsx");
  const factory = read("web/src/pages/ContentFactory.tsx");

  assert.match(
    workbench,
    /domain === 'content' && \['boss', 'admin', 'platform_super'\]\.includes\(currentUser\?\.role \|\| ''\)/u,
  );
  assert.match(
    workbench,
    /const canViewInternalProfile = profile\?\.permissions\.canViewInternalProfile === true/u,
  );
  for (const permission of [
    "canViewCapabilities",
    "canViewWorkMethod",
    "canViewSkills",
    "canViewPrompt",
    "canViewWorkConfig",
    "canViewRuntimeBindings",
    "canViewJobProfile",
  ]) {
    assert.match(
      workbench,
      new RegExp(`profile\\.permissions\\.${permission} === true`),
      `${permission} must be an API permission gate`,
    );
  }
  assert.match(
    factory,
    /const canViewCrewInternals = \['boss', 'admin', 'platform_super'\]\.includes/u,
  );
  assert.doesNotMatch(
    factory,
    /\/content\/prompt-guides/u,
    "内部资料在授权员工档案按需读取",
  );
});

test("内容员工当前工作台以对话和报告为主，不把已确认技能标成待核验，不重复岗位名", () => {
  const workbench = read("web/src/components/EmployeeWorkbench.tsx");
  const overview = read("web/src/components/EmployeeVisualOverview.tsx");
  const factory = read("web/src/pages/ContentFactory.tsx");
  const crewCard = read("web/src/components/ContentFactoryRecentCard.tsx");

  assert.doesNotMatch(workbench, /历史技能默认注入但必须重新核验/u);
  // 普通员工工作台已改成 Paihuo 风格的对话主界面。运行状态由对话任务卡和
  // 报告区呈现，能力/技能等内部资料收进“后台档案”，不再依赖旧 runtimeItems。
  assert.match(workbench, /ewb-conversation/u);
  assert.match(workbench, /岗位交付报告/u);
  assert.match(workbench, /SourceDeliverables/u);
  assert.match(workbench, /后台档案/u);
  assert.doesNotMatch(workbench, /历史技能默认注入但必须重新核验/u);

  assert.doesNotMatch(
    overview,
    /<h2>\s*\{identity\.person \|\| identity\.name\}\s*<small>\{identity\.name\}<\/small>/su,
  );
  assert.doesNotMatch(overview, /[\u{1F300}-\u{1FAFF}]/u);
  // “待审阅”可作为历史状态映射保留，但总览默认 KPI 必须表达当前待处理，
  // 不得让普通 auto 产出看起来像默认进入内容审核。
  assert.doesNotMatch(overview, /\{ label: '待审阅', value: pending \}/u);
  assert.match(overview, /\{ label: '待处理', value: pending \}/u);

  assert.doesNotMatch(factory, /ContentEmployeeTaskCenter|待人工处理区/u);
  assert.match(factory, /全部历史 · 任务中心/u);

  // 首页只呈现岗位和任务入口，策略由后台保持，不向老板铺内部采用说明。
  assert.doesNotMatch(
    factory,
    /content-crew-card-approval|crewAdoptionLabel|普通内部结果直接采用|通过门禁后自动采用/u,
  );
  assert.doesNotMatch(factory, /content-crew-emoji[\s\S]*\{station\.emoji\}/u);
  assert.doesNotMatch(crewCard, /提交人工审阅/u);
  assert.doesNotMatch(factory, /人工审阅队列/u);
});

test("ContentFactory删除重复待处理区域，统一任务中心保留历史状态筛选", () => {
  const factory = read("web/src/pages/ContentFactory.tsx");
  const task = read("web/src/pages/TaskCenter.tsx");
  assert.doesNotMatch(
    factory,
    /ContentEmployeeTaskCenter|待人工处理区|pending-reviews/u,
  );
  assert.match(factory, /全部历史 · 任务中心/u);
  assert.match(task, /value: 'rejected'/u);
  assert.match(task, /value: 'failed'/u);
});

test("内容专岗与标准岗位统一进入员工工作台，技能摘要与深链保留", () => {
  const factory = read("web/src/pages/ContentFactory.tsx");
  const gridStart = factory.indexOf('className="content-crew-grid"');
  const gridEnd = factory.indexOf("</section>", gridStart);
  assert.ok(
    gridStart >= 0 && gridEnd > gridStart,
    "内容员工卡片阵列必须可定位",
  );
  const grid = factory.slice(gridStart, gridEnd);
  assert.match(grid, /打开工作台 · 派活/u);
  assert.match(grid, /setCrewWorkbenchIdx\(station\.employeeIdx\)/u);
  for (const field of ["capabilityCount", "skillCount", "capabilityNames"]) {
    assert.match(grid, new RegExp(`station\\.${field}`));
    assert.match(factory, new RegExp(`${field}:.*remote\\.${field}`));
  }
  assert.doesNotMatch(
    factory,
    /setSalesVideoOpen|setXhsNoteOpen|<AiSalesVideoPanel|<AiXhsNotePanel/u,
  );
  assert.match(factory, /requestedTask === 'ai-sales-video'/u);
  assert.match(factory, /requestedTask === 'ai-xhs-note'/u);
  assert.match(
    factory,
    /initialMediaJobId=\{crewWorkbenchIdx === 10 \? crewMediaJobId : null\}/u,
  );
  assert.match(
    factory,
    /initialSalesVideoBrief=\{crewWorkbenchIdx === 10 \? salesVideoPreset : null\}/u,
  );
});

test("小红书和带货专岗从能力档案返回派活时进入专用面板，长任务正文允许32000字", () => {
  const workbench = read("web/src/components/EmployeeWorkbench.tsx");
  const specialist = read("web/src/components/ContentSpecialistDispatch.tsx");
  assert.match(
    workbench,
    /domain === 'content' && \(idx === 10 \|\| idx === 11\)/u,
  );
  assert.match(workbench, /return\s*\(?\s*<ContentSpecialistDispatch/u);
  assert.match(workbench, /maxLength=\{32000\}/u);
  assert.match(workbench, /if \(!open \|\| domain !== 'content' \|\| idx === null \|\| dedicatedContentTask\) return;/u);
  assert.match(workbench, /domain === 'content' && !dedicatedContentTask/u);
  assert.match(workbench, /loadRunDetail\(Number\(initialRunId\)\)/u);
  assert.doesNotMatch(workbench, /maxLength=\{8000\}/u);
  assert.match(specialist, /<AiXhsNotePanel/u);
  assert.match(specialist, /<AiSalesVideoPanel/u);
  assert.match(specialist, /canDispatch=\{available\}/u);
  assert.match(specialist, /embedded/u);
  assert.match(specialist, /open=\{active\}/u);
  assert.doesNotMatch(
    specialist,
    /打开小红书图文任务|打开30秒带货视频任务|setOpen/u,
  );
  assert.doesNotMatch(specialist, /submitDispatch|\/dispatch/u);
});

test("内容员工任务卡按钮按权威presentationKey展示，不把无摘要任务误报为失败", () => {
  const taskCenter = read("web/src/components/ContentEmployeeTaskCenter.tsx");

  for (const [presentationKey, actionLabel] of [
    ["generating", "查看实时进度"],
    ["review_pending", "打开结果并处理"],
    ["adopted", "打开完整结果与费用"],
    ["business_blocked", "查看对账状态与处理建议"],
    ["rework_required", "查看返工原因与处理建议"],
    ["rejected", "查看未采纳结果"],
    ["execution_failed", "查看执行错误与处理建议"],
    ["historical", "查看历史失败与修复记录"],
  ]) {
    assert.match(
      taskCenter,
      new RegExp(`${presentationKey}: '${actionLabel}'`, "u"),
      `${presentationKey} 必须有独立操作文案`,
    );
  }

  assert.match(taskCenter, /contentEmployeeRunActionLabel\(run\)/u);
  assert.doesNotMatch(
    taskCenter,
    /run\.resultPreview \? '打开完整结果与费用' : '查看失败原因与处理建议'/u,
  );
  assert.doesNotMatch(
    taskCenter,
    /已驳回: \{ label: '失败需返工（人工审阅未通过）'/u,
  );
});

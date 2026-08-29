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

test("登录落地页宣传权威72位口径，普通内部产出不再被写成一刀切待审", () => {
  const login = read("web/src/pages/Login.tsx");

  assert.match(
    login,
    /<em>72 位数字员工<\/em>/u,
    "总数应为61餐饮（60核心+1扩展）+10 Paihuo+1 AI带货员",
  );
  assert.match(login, /\{ value: '61', label: '餐饮数字员工 · 8 大分部' \}/u);
  assert.match(login, /\{ value: '10', label: '内容生产数字员工' \}/u);
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
  assert.match(
    factory,
    /if \(canViewCrewInternals\) \{[\s\S]*\/content\/prompt-guides/u,
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

  // 右侧面板是当前待处理入口，不应以旧的人工审阅队列作为默认承诺；
  // 历史记录/详情状态仍由其它投影负责，这里只约束面板静态文案。
  const pendingPanelStart = factory.indexOf("{/* 待人工处理区");
  const pendingPanelEnd = factory.indexOf("{/* 高频模板", pendingPanelStart);
  assert.ok(
    pendingPanelStart >= 0 && pendingPanelEnd > pendingPanelStart,
    "待处理面板边界必须可定位",
  );
  const pendingPanel = factory.slice(pendingPanelStart, pendingPanelEnd);
  assert.doesNotMatch(pendingPanel, /进入人工审阅|待人工审阅/u);
  assert.match(pendingPanel, /待人工处理|策略确认/u);

  // 采用策略现由内容员工卡片上的标签呈现（仅管理角色可见）
  const adoptionSummary =
    factory.match(/content-crew-card-approval[\s\S]{0,220}/u)?.[0] || "";
  assert.notEqual(
    adoptionSummary,
    "",
    "员工卡片必须展示采用策略，而不是把普通内部结果写成审批",
  );
  assert.match(
    factory,
    /if \(role === 'boss' \|\| role === 'platform_super'\) return '当前账号普通内部结果直接采用'/u,
  );
  assert.doesNotMatch(adoptionSummary, /策略指定任务人工确认/u);
  assert.doesNotMatch(factory, /策略指定任务人工确认/u);
  assert.doesNotMatch(adoptionSummary, /进入人工审阅|人工审阅/u);
  assert.doesNotMatch(factory, /content-crew-emoji[\s\S]*\{station\.emoji\}/u);
  assert.doesNotMatch(crewCard, /提交人工审阅/u);
  assert.doesNotMatch(factory, /人工审阅队列/u);
});

test("ContentFactory右侧待处理面板不默认承诺人工审阅队列（历史状态映射仍可保留）", () => {
  const factory = read("web/src/pages/ContentFactory.tsx");
  const pendingPanelStart = factory.indexOf("{/* 待人工处理区");
  const pendingPanelEnd = factory.indexOf("{/* 高频模板", pendingPanelStart);
  assert.ok(
    pendingPanelStart >= 0 && pendingPanelEnd > pendingPanelStart,
    "待处理面板边界必须可定位",
  );
  const pendingPanel = factory.slice(pendingPanelStart, pendingPanelEnd);
  assert.doesNotMatch(pendingPanel, /进入人工审阅|待人工审阅/u);
  assert.match(pendingPanel, /待人工处理|策略确认/u);
});

test("内容员工卡片同时提供单独派活和AI带货员30秒视频入口", () => {
  const factory = read("web/src/pages/ContentFactory.tsx");
  const gridStart = factory.indexOf('className="content-crew-grid"');
  const gridEnd = factory.indexOf("<ContentEmployeeTaskCenter", gridStart);
  assert.ok(gridStart >= 0 && gridEnd > gridStart, "内容员工卡片阵列必须可定位");
  const grid = factory.slice(gridStart, gridEnd);

  // 每张卡片可单独派活（打开工作台），能力/技能摘要可点击查看完整能力
  assert.match(grid, /单独派活/u);
  assert.match(grid, /setCrewWorkbenchIdx\(station\.employeeIdx\)/u);
  assert.match(grid, /station\.capabilityCount/u);
  assert.match(grid, /station\.skillCount/u);
  assert.match(grid, /station\.capabilityNames/u);
  // AI带货员卡片保留30秒视频生成入口
  assert.match(
    grid,
    /station\.key === 'commerce_video'[\s\S]*30秒带货视频/u,
  );
  assert.match(grid, /onClick=\{\(\) => setSalesVideoOpen\(true\)\}/u);
});

test("内容员工任务卡按钮按权威presentationKey展示，不把无摘要任务误报为失败", () => {
  const taskCenter = read("web/src/components/ContentEmployeeTaskCenter.tsx");

  for (const [presentationKey, actionLabel] of [
    ["generating", "查看实时进度"],
    ["review_pending", "打开结果并处理"],
    ["adopted", "打开完整结果与费用"],
    ["business_blocked", "查看对账状态与处理建议"],
    ["rework_required", "查看返工原因与处理建议"],
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

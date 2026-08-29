import { test } from "node:test";
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

test("平台超管前端只保留平台控制台入口，不进入企业后台或充值页", () => {
  const app = read("web/src/App.tsx");
  const recharge = read("web/src/pages/Recharge.tsx");

  assert.match(app, /function EnterpriseOnly/);
  assert.match(app, /role === 'platform_super'.*Navigate to="\/platform"/s);
  assert.match(app, /path="\/admin".*roles=\{\['boss', 'admin'\]\}/s);
  assert.match(app, /path="\/m".*EnterpriseOnly/s);
  assert.match(app, /<EnterpriseOnly>\s*<MainLayout \/>\s*<\/EnterpriseOnly>/);
  assert.doesNotMatch(recharge, /role !== 'boss' && role !== 'platform_super'/);
});

test("管理后台账号停用值与服务端状态契约一致", () => {
  const adminPage = read("web/src/pages/Admin.tsx");
  const adminRoute = read("server/src/routes/admin.js");

  assert.match(adminPage, /\{ value: '停用', label: '停用' \}/);
  assert.doesNotMatch(adminPage, /\{ value: '禁用', label: '禁用' \}/);
  assert.match(
    adminRoute,
    /const USER_STATUSES = new Set\(\['启用', '停用'\]\)/,
  );
});

test("移动端核心工作台按模块和角色过滤，销售不发起管理层简报请求", () => {
  const mobile = read("web/src/pages/Mobile.tsx");
  const dashboard = read("web/src/pages/Dashboard.tsx");

  assert.match(
    mobile,
    /CORE_WORKSPACES\.filter\(item => mods\.includes\(item\.mod\) && item\.roles\.includes\(user\.role\)\)/,
  );
  assert.match(
    mobile,
    /useQuery<DashboardBriefing>\('\/dashboard\/briefing'.*enabled: canViewManagementBriefing/s,
  );
  assert.match(
    dashboard,
    /if \(canViewManagementBriefing\).*\/dashboard\/daily-digest/s,
  );
  assert.match(mobile, /\.filter\(item => item\.delivery\?\.canUse === true\)/);
  assert.match(mobile, /disabled=\{r\.delivery\?\.canUse !== true\}/);
});

test("内容提交审核后立即清除过期可用态并刷新权威列表", () => {
  const contentFactory = read("web/src/pages/ContentFactory.tsx");

  assert.match(
    contentFactory,
    /const pendingApprovalContent = \(record: any\)/,
  );
  assert.match(
    contentFactory,
    /canUse: false[\s\S]*canImport: false[\s\S]*canPublish: false/,
  );
  assert.match(
    contentFactory,
    /setRows\(prev => prev\.map\(x => \(x\.id === rec\.id \? pendingApprovalContent\(x\) : x\)\)\)/,
  );
  assert.match(
    contentFactory,
    /setResults\(prev => prev\.map\(x => \(x\.id === rec\.id \? pendingApprovalContent\(x\) : x\)\)\)/,
  );
  assert.match(contentFactory, /refreshList\(\);[\s\S]*loadPending\(\);/);
});

test("桌面内容复制与PPT导出严格跟随权威交付门禁", () => {
  const contentFactory = read("web/src/pages/ContentFactory.tsx");
  const constants = read("web/src/data/contentFactoryConstants.tsx");

  assert.match(
    constants,
    /rec\?\.delivery\?\.canUse === true && CONTENT_FLOW_STATUSES/,
  );
  assert.match(constants, /rec\?\.ai_mode \?\? rec\?\.mode/);
  for (const mode of [
    "fallback",
    "failed",
    "error",
    "mock",
    "demo",
    "degraded",
  ]) {
    assert.doesNotMatch(
      constants,
      new RegExp(`USABLE_CONTENT_MODES[^\\n]*['\"]${mode}['\"]`),
    );
  }
  assert.match(
    constants,
    /内容缺少可验证的产出来源，暂不能用于复制、导出、导入或发布/,
  );
  assert.match(constants, /可使用: '可使用状态待权威核验'/);
  assert.match(
    constants,
    /String\(rec\?\.status \|\| ''\) === '可使用' && !rec\?\.delivery/,
  );
  assert.match(
    contentFactory,
    /<ContentUseActions record=\{r\}>[\s\S]*?<CopyOutlined \/>[\s\S]*?disabled=\{!contentFlowReady\(r\)\}/,
  );
  assert.match(
    contentFactory,
    /disabled=\{!contentFlowReady\(r\)\}[\s\S]*?exportDeckHtml\(r\)/,
  );
  assert.match(
    contentFactory,
    /disabled=\{!contentFlowReady\(r\)\}[\s\S]*?exportDeckDoc\(r\)/,
  );
  assert.match(
    contentFactory,
    /<ContentUseActions key="copy" record=\{viewRec\}>[\s\S]*?disabled=\{!contentFlowReady\(viewRec\)\}/,
  );
  assert.equal(
    (
      contentFactory.match(/api\.get\(`\/content\/detail\/\$\{res\.id\}`\)/g) ||
      []
    ).length,
    2,
  );
});

test("自动化失败或未完成时卡片和桌面表格都直接显示原因", () => {
  const contentFactory = read("web/src/pages/ContentFactory.tsx");
  const failureReason = read("web/src/components/AutomationFailureReason.tsx");

  assert.match(
    contentFactory,
    /const automationVisibleFailure = \(rule: ContentAutomationRule\)/,
  );
  assert.match(
    contentFactory,
    /\['失败', '未完成', '已停用'\]\.includes\(rule\.lastStatus \|\| ''\)/,
  );
  assert.equal(
    (
      contentFactory.match(
        /<AutomationFailureReason reason=\{automationVisibleFailure\(rule\)\}/g,
      ) || []
    ).length,
    2,
  );
  assert.match(failureReason, /aria-label="自动化失败原因"/);
  assert.match(failureReason, /WebkitLineClamp: 2/);
  assert.match(failureReason, /<Tooltip title=\{reason\}>/);
});

test("桌面驾驶舱名称和每日指引按老板、管理层、管理员与员工角色分流", () => {
  const dashboard = read("web/src/pages/Dashboard.tsx");
  const roleHeader = read("web/src/components/DashboardRoleHeader.tsx");
  const layout = read("web/src/layouts/MainLayout.tsx");

  assert.match(
    roleHeader,
    /role === 'ops_director' \|\| role === 'manager'[\s\S]*'经营协同台'/,
  );
  assert.match(roleHeader, /role === 'admin'[\s\S]*'经营管理台'/);
  assert.match(
    roleHeader,
    /const summary =[\s\S]*所有客户与任务只展示你的授权范围/,
  );
  assert.doesNotMatch(roleHeader, /: '老板驾驶舱已汇总当前可用的企业经营记录/);
  assert.match(dashboard, /<DashboardRoleHeader/);
  assert.match(
    layout,
    /user\?\.role === 'ops_director' \|\| user\?\.role === 'manager'/,
  );
  assert.match(layout, /user\?\.role === 'admin'\) return '经营管理台'/);
  assert.match(layout, /user\?\.role === 'boss'\) return '老板驾驶舱'/);
  assert.match(layout, /return '我的工作台'/);
  assert.match(layout, /title: '管理层每日协同'/);
  assert.match(layout, /title: '我的每日执行'/);
  assert.match(layout, /\{dailyGuide\.title\}/);
  assert.match(layout, /\{dailyGuide\.body\}/);
  assert.match(
    layout,
    /user\?\.role === 'boss'[\s\S]*title: '老板经营助手', entry: '问老板参谋', todo: '老板待办'/,
  );
  assert.match(
    layout,
    /user\?\.role === 'ops_director' \|\| user\?\.role === 'manager'[\s\S]*title: '经营协同助手', entry: '问经营参谋', todo: '管理层待办'/,
  );
  assert.match(
    layout,
    /title: '我的工作助手', entry: '问工作参谋', todo: '我的待办'/,
  );
  assert.match(layout, /<Tooltip title=\{assistantCopy\.entry\}>/);
  assert.match(layout, /aria-label=\{`打开\$\{assistantCopy\.title\}`\}/);
  assert.match(layout, /<RobotOutlined \/> \{assistantCopy\.title\}/);
  assert.match(
    layout,
    /modules\.includes\('analysis'\)[\s\S]*path: '\/analysis'[\s\S]*modules\.includes\('execution'\)[\s\S]*path: '\/execution'[\s\S]*path: '\/advisor'/,
  );
  assert.match(layout, /nav\(assistantSuggestion\.path\)/);
  assert.match(layout, /manager: '管理层'/);
  assert.match(layout, /partner: '合作伙伴'/);
});

test("命令面板以当前角色真实可见导航为最终搜索和快捷动作门禁", () => {
  const palette = read("web/src/components/CommandPalette.tsx");

  assert.match(
    palette,
    /modules\.includes\('growth'\) && allowedRecentByPath\.has\('\/growth'\)/,
  );
  assert.match(
    palette,
    /modules\.includes\('content'\) && allowedRecentByPath\.has\('\/content'\)/,
  );
  assert.match(
    palette,
    /modules\.includes\('activities'\) && allowedRecentByPath\.has\('\/activities'\)/,
  );
  assert.match(
    palette,
    /const destination = allowedRecentByPath\.get\(basePath\(a\.to\)\);[\s\S]*if \(!modules\.includes\(a\.mod\) \|\| !destination\) continue;/,
  );
  assert.match(
    palette,
    /a\.id === 'act-advisor' \? `打开\$\{destination\.label\}` : a\.label/,
  );
});

test("移动端无驾驶舱权限也能进入已授权工作台，客户详情失败可重试", () => {
  const mobile = read("web/src/pages/Mobile.tsx");

  assert.match(
    mobile,
    /const hasHomeAccess =[\s\S]*mods\.includes\('dashboard'\)[\s\S]*CORE_WORKSPACES\.some/,
  );
  assert.match(
    mobile,
    /t\.key === 'home' \? hasHomeAccess : !t\.mod \|\| mods\.includes\(t\.mod\)/,
  );
  assert.match(
    mobile,
    /key: 'employees'[\s\S]*roles: \['boss', 'ops_director', 'manager', 'sales'\]/,
  );
  assert.match(mobile, /key: 'execution'[\s\S]*path: '\/execution'/);
  assert.match(
    mobile,
    /useQuery<DashboardSummary>\('\/dashboard\/summary', \[\], \{ enabled: hasDashboard \}\)/,
  );
  assert.match(
    mobile,
    /const \[detailError, setDetailError\] = useState\(''\)/,
  );
  assert.match(
    mobile,
    /\.get\(`\/growth\/leads\/\$\{lead\.id\}`, \{ silent: true \}\)/,
  );
  assert.match(mobile, /description=\{detailError\}[\s\S]*重新加载/);
  assert.match(mobile, /客户详情证据未返回/);
});

test("活动日历和工作分配仅对管理角色显示，日历失败不会永久转圈", () => {
  const activities = read("web/src/pages/Activities.tsx");

  assert.match(
    activities,
    /const canManageActivityAssignments = \['boss', 'ops_director', 'manager', 'admin'\]\.includes/,
  );
  assert.match(activities, /只有老板或管理层可以分配活动工作/);
  assert.equal(
    (activities.match(/\{canManageActivityAssignments && \(/g) || []).length,
    2,
  );
  assert.match(
    activities,
    /\.get\('\/activities\/calendar-sync', \{ silent: true \}\)/,
  );
  assert.match(
    activities,
    /calSync\.error \? \([\s\S]*企业日历关联状态加载失败/,
  );
  assert.match(
    activities,
    /action=\{<Button onClick=\{openCalSync\}>重新加载<\/Button>\}/,
  );
});

test("员工驾驶舱只请求和展示已授权模块，全部范围按本人或团队标注", () => {
  const dashboard = read("web/src/pages/Dashboard.tsx");
  const roleHeader = read("web/src/components/DashboardRoleHeader.tsx");
  const layout = read("web/src/layouts/MainLayout.tsx");
  const app = read("web/src/App.tsx");

  for (const [widget, module] of [
    ["follow", "growth"],
    ["trend", "analysis"],
    ["funnel", "growth"],
    ["channels", "analysis"],
    ["customers", "growth"],
    ["marshals", "marshals"],
    ["activities", "activities"],
  ]) {
    assert.match(dashboard, new RegExp(`${widget}: '${module}'`));
  }
  assert.match(
    dashboard,
    /if \(canViewMarshals\) api\.get\('\/dashboard\/marshal-shortcuts'\)/,
  );
  assert.match(
    dashboard,
    /if \(canViewAnalysis\) \{[\s\S]*\/dashboard\/trend[\s\S]*\/dashboard\/channels/,
  );
  assert.match(
    dashboard,
    /if \(canViewActivities\) \{[\s\S]*\/dashboard\/week-activities/,
  );
  assert.match(
    dashboard,
    /if \(canViewGrowth\) \{[\s\S]*\/dashboard\/follow-overview/,
  );
  assert.match(
    dashboard,
    /canViewAnalysis && \['boss', 'ops_director', 'manager', 'admin'\]/,
  );
  assert.match(dashboard, /\? '全部'[\s\S]*\? '团队'[\s\S]*: '我的'/);
  assert.match(roleHeader, /if \(hasModule\('execution'\)\)/);
  assert.match(roleHeader, /if \(hasModule\('content'\)\)/);
  assert.match(dashboard, /hasModule\('system'\) \? \(/);
  assert.match(
    dashboard,
    /const canViewEmployeeDetail = \['boss', 'ops_director', 'manager', 'admin'\]/,
  );
  assert.match(dashboard, /\{hasModule\('execution'\) && \([\s\S]*任务完成率/);
  assert.match(
    dashboard,
    /onRow=\{canViewGrowth \? \(r: any\) => interactiveRow\(\(\) => openChannel\(r\.channel\)\) : undefined\}/,
  );
  assert.match(layout, /key: '\/store-data'[\s\S]*managerOnly: true/);
  assert.match(
    app,
    /path="\/store-data"[\s\S]*roles=\{\['boss', 'ops_director', 'manager', 'admin'\]\}/,
  );
});

test("任务表现按角色命名，员工端不渲染竞赛名次或跨员工榜单", () => {
  const execution = read("web/src/pages/Execution.tsx");

  assert.match(
    execution,
    /title=\{isManager \? '员工任务竞赛榜' : '我的任务表现'\}/,
  );
  assert.match(execution, /\{isManager && \([\s\S]*\{i \+ 1\}[\s\S]*\)\}/);
  assert.match(execution, /\{isManager \? r\.name : '我的任务'/);
});

test("数字员工公开工作台是对话，技能、工具和配置收入次级后台档案", () => {
  const workbench = read("web/src/components/EmployeeWorkbench.tsx");

  assert.match(workbench, /className="ewb-section ewb-conversation"/u);
  assert.match(workbench, /className="ewb-content ewb-public-conversation"[\s\S]*\{dispatchTab\}/u);
  assert.match(workbench, /className="ewb-chat-composer/u);
  assert.match(workbench, /<UnifiedFilePicker/u);
  assert.match(workbench, />\s*后台档案\s*</u);
  assert.match(workbench, /open=\{open && backendProfileOpen\}/u);

  for (const key of [
    "capabilities",
    "method",
    "skills",
    "prompts",
    "config",
    "profile",
  ]) {
    assert.match(workbench, new RegExp(`key: '${key}'`));
  }
  assert.doesNotMatch(workbench, /key: 'dispatch'/u);
});

test("餐饮与内容工作台用一句话派活，公开信息由联网补齐且内部材料可选", () => {
  const workbench = read("web/src/components/EmployeeWorkbench.tsx");
  const layout = read("web/src/layouts/MainLayout.tsx");
  const dispatchCopy = `${workbench}\n${layout}`;

  // 用户只描述问题即可开始；地点、竞品、地图、评价、规则等公开信息由系统自行检索。
  assert.match(dispatchCopy, /一句话即可派活/u);
  assert.match(
    dispatchCopy,
    /(?:地点、竞品、地图、评价|公开的地点、竞品、地图、评价)/u,
  );
  assert.match(dispatchCopy, /(?:平台规则|公开规则)/u);
  assert.match(dispatchCopy, /(?:自行联网|联网补齐)/u);
  assert.match(
    dispatchCopy,
    /内部资料(?:有则按需补充|只是可选补充)|内部材料只是可选补充/u,
  );

  // 派活步骤必须把「输入少、进度可追、结果可看」说清楚。
  assert.match(
    workbench,
    /<Steps[\s\S]*title: '一句话派活', description: '内部材料可选'[\s\S]*title: '看进度'[\s\S]*title: '看结果'/u,
  );
  assert.match(workbench, /数字员工和 AI 任务统一进入「任务中心」/u);
  assert.match(workbench, /<a href="\/tasks">打开任务中心<\/a>/u);
  assert.match(layout, /key: '\/tasks',[\s\S]*label: '任务中心'/u);

  // 这些文案是产品契约：不得把公开资料或内部资料清单倒逼给客户准备。
  assert.doesNotMatch(
    dispatchCopy,
    /开工前请准备|请准备(?:候选地址|坐标|竞品|公开资料)/u,
  );
  assert.doesNotMatch(
    dispatchCopy,
    /普通内部产出[^。\n]*(?:提交|进入)人工审阅/u,
  );
  assert.doesNotMatch(workbench, /去审批|打开审批中心|打开任务看板/u);
  const helpCard =
    layout.match(/餐饮数字员工怎么用[\s\S]*?积分规则/u)?.[0] || "";
  assert.doesNotMatch(helpCard, /去审批|打开审批中心|打开任务看板/u);
  assert.match(workbench, /普通内部产出通过门禁后自动采用/u);
});

test("内容仓固定创作模板不冒充实时AI建议，也不会在缺少业务简报时填入虚构主题", () => {
  const contentFactory = [
    read("web/src/pages/ContentFactory.tsx"),
    read("web/src/components/ContentReferencePanel.tsx"),
  ].join("\n");

  assert.match(contentFactory, /创作参考模板/);
  assert.match(contentFactory, /固定示例，不是实时 AI 判断/);
  assert.match(
    contentFactory,
    /系统没有为这些模板读取实时热点、经营表现或活动排期/,
  );
  assert.match(contentFactory, /暂无带业务记录的今日主题/);
  assert.doesNotMatch(contentFactory, /AI创作建议/);
  assert.doesNotMatch(
    contentFactory,
    /briefing\?\.theme \|\| '夏季招牌菜主题周'/,
  );
  assert.doesNotMatch(contentFactory, /<b>数据来源：<\/b>/);
});

test("内容生产仓把十一名数字员工真实运行纳入中央任务与风险审阅入口", () => {
  const contentFactory = read("web/src/pages/ContentFactory.tsx");
  const taskCenter = read("web/src/components/ContentEmployeeTaskCenter.tsx");
  const taskCenterCss = read(
    "web/src/components/ContentEmployeeTaskCenter.css",
  );
  const workbench = read("web/src/components/EmployeeWorkbench.tsx");

  assert.match(contentFactory, /<ContentEmployeeTaskCenter/);
  assert.match(
    contentFactory,
    /当前 auto 下，none \/ low \/ medium \/ high 普通内部结果通过质量和账务门后直接进入业务可用状态/u,
  );
  assert.match(
    contentFactory,
    /employeeTaskQueue\?\.statusCounts\?\.\['待审阅'\]/,
  );
  assert.match(
    contentFactory,
    /只有显式配置的策略确认才会进入待处理。系统绝不会自动发布/u,
  );
  assert.match(contentFactory, /initialRunId=\{crewWorkbenchRunId\}/);
  assert.match(taskCenter, /employee-workbench\/content\/runs/);
  assert.match(taskCenter, /内容数字员工任务中心/);
  assert.match(
    taskCenter,
    /生成中、已完成、策略要求人工确认、业务暂不可采用和失败任务/,
  );
  assert.match(taskCenter, /失败待处理统计只包含当前仍需查因或返工的任务/);
  assert.match(taskCenter, /data\.presentationCounts\?\.\[key\]/);
  assert.match(taskCenter, /historical: \{ label: '历史失败（后续已修复）'/);
  assert.match(taskCenter, /run\.remediatedByRunId/);
  assert.match(taskCenter, /onOpenRun\(run\)/);
  assert.match(taskCenterCss, /data-status='review_pending'/);
  assert.match(taskCenterCss, /data-status='execution_failed'/);
  assert.doesNotMatch(taskCenterCss, /data-status='待审阅'/);
  assert.match(
    taskCenter,
    /能力、技能、提示词、配置及岗位档案仅老板或管理员可查看/,
  );
  assert.match(
    taskCenter,
    /const maxPage = Math\.max\(1, Math\.ceil\(next\.total \/ PAGE_SIZE\)\)/,
  );
  assert.match(
    taskCenter,
    /if \(page > maxPage\) \{\s*setPage\(maxPage\);\s*return;/s,
  );
  assert.match(workbench, /initialRunId\?: number \| null/);
  assert.match(workbench, /loadRunDetail\(Number\(initialRunId\)\)/);
  assert.match(
    workbench,
    /<ContentEmployeeResult\s+raw=\{localizeOperationalStatus\(selectedRun\.resultMd\)\}/s,
  );
  assert.match(workbench, /run\.remediated === true/);
  assert.match(workbench, /历史失败（后续已修复）/);
});

test("内容生产仓普通内部结果不默认伪装成审批或人工审阅任务", () => {
  const contentFactory = read("web/src/pages/ContentFactory.tsx");
  const recentCard = read("web/src/components/ContentFactoryRecentCard.tsx");
  const workbench = read("web/src/components/EmployeeWorkbench.tsx");
  const visualOverview = read("web/src/components/EmployeeVisualOverview.tsx");

  // 普通内容默认 auto：快捷动作和生成反馈不得把用户引向人工审阅。
  assert.doesNotMatch(contentFactory, /生成后可预览并提交人工审阅/u);
  assert.doesNotMatch(contentFactory, /可验收（待提交人工审阅）/u);

  // 未提供权威餐饮状态时不能默认返回“待人工审阅”；该状态只能来自真实历史/策略状态。
  assert.doesNotMatch(workbench, /return '待人工审阅';/u);

  // 最近内容卡只有命中显式确认门时才显示“提交策略确认”，普通自动采用结果不应出现禁用审阅按钮。
  assert.match(recentCard, /\{canSubmitApproval\(record\)\s*&&\s*\(/u);
  assert.match(recentCard, /approvalActionLabel/u);
  assert.doesNotMatch(recentCard, /disabled=\{!canSubmitApproval\(record\)\}/u);

  // 总览只展示真实运行 KPI，不应新增审批/审阅状态入口。
  assert.doesNotMatch(visualOverview, /审批|人工审阅|待审阅|提交审阅/u);

  // 历史或显式策略状态仍可展示，但必须在文案中标明来源边界。
  assert.match(
    contentFactory,
    /历史待审任务和显式策略任务仍在这里展示；系统不会自动发布/u,
  );
  assert.match(workbench, /旧策略留下的历史状态，仅作审计留档/u);
});

test("系统页仅老板、管理员和平台超管请求并展示提示词中枢", () => {
  const system = read("web/src/pages/System.tsx");

  assert.match(
    system,
    /const canEditPrompt = \['boss', 'admin', 'platform_super'\]\.includes\(user\.role\)/,
  );
  assert.match(system, /requested === 'prompts' && !canEditPrompt/);
  assert.match(
    system,
    /\.\.\.\(canEditPrompt\s*\?\s*\[\s*api\.get\('\/sys\/prompts'\)[\s\S]*api\.get\('\/sys\/marshal-prompts\/status'\)/,
  );
  assert.match(system, /canEditPrompt \|\| item\.tab !== 'prompts'/);
  assert.match(system, /isAdminish \|\| item\.tab !== 'billing'/);
  assert.match(
    system,
    /\.\.\.\(canEditPrompt \? \[\{ key: 'prompts', label: '提示词模板', children: promptsTab \}\] : \[\]\)/,
  );
});

test("企业审批规则由平台超管配置，老板、管理员和管理层只读且员工不请求", () => {
  const system = [
    read("web/src/pages/System.tsx"),
    read("web/src/components/SystemApprovalRuleEditor.tsx"),
  ].join("\n");

  assert.match(
    system,
    /const canViewApprovalPolicy = \['boss', 'ops_director', 'manager', 'admin', 'platform_super'\]\.includes\(user\.role\)/,
  );
  assert.match(
    system,
    /const canEditApprovalPolicy = \['platform_super'\]\.includes\(user\.role\)/,
  );
  assert.match(
    system,
    /if \(!canViewApprovalPolicy\) return Promise\.resolve\(\);[\s\S]*\.get\('\/sys\/approval-policy', \{ silent: true \}\)/,
  );
  assert.match(
    system,
    /if \(!canEditApprovalPolicy \|\| !approvalPolicyServerCanEdit \|\| !approvalPolicyDraft\) return;/,
  );
  assert.match(
    system,
    /\.put\('\/sys\/approval-policy', \{ policy: approvalPolicyPayload\(approvalPolicyDraft\) \}, \{ silent: true \}\)/,
  );
  for (const routeKey of [
    "employeeOutput",
    "activityPlan",
    "activityChecklist",
  ]) {
    assert.match(system, new RegExp(`${routeKey}: \\{`));
  }
  assert.match(system, /value: 'risk_based'/);
  assert.match(system, /value: 'amount_threshold'/);
  assert.match(system, /ownerAmountThreshold/);
  assert.match(system, /reviewerUserId/);
  assert.match(system, /规则仅对保存后的新提交生效/);
  assert.match(system, /在途的审批会继续使用提交时锁定的不可变规则快照/);
  assert.match(system, /不可关闭的交付安全底线/);
  assert.match(system, /<Switch size="small" checked disabled/);
  assert.match(
    system,
    /r\.assignedReviewerName \|\|[\s\S]*r\.assigned_reviewer/,
  );
  assert.match(system, /\{approvalPolicySection\}/);
});

test("审批中心按接口门禁分别控制通过与驳回，待对账不进入人工审核", () => {
  const system = read("web/src/pages/System.tsx");

  assert.match(
    system,
    /const canDecide = \['boss', 'ops_director', 'manager', 'admin'\]\.includes\(user\.role\)/,
  );
  assert.equal(
    (
      system.match(
        /disabled=\{!rowHasAuthority \|\| r\.canPass === false\}/g,
      ) || []
    ).length,
    2,
  );
  assert.match(
    system,
    /disabled=\{!rowHasAuthority \|\| r\.canReject === false\}/,
  );
  assert.match(system, /r\.passBlockedReason \|\| '当前状态暂不能通过'/);
  assert.match(system, /r\.rejectBlockedReason \|\| r\.reviewBlockedReason/);
  assert.match(system, /<Tooltip title=\{rejectBlockedReason\}>/);
});

test("直属经理和企业管理员可按后端团队范围验收人工任务", () => {
  const execution = read("web/src/pages/Execution.tsx");
  const taskCard = read("web/src/components/ExecutionTaskCard.tsx");
  const dashboard = read("web/src/pages/Dashboard.tsx");

  assert.match(
    execution,
    /const canApprove = \['boss', 'ops_director', 'manager', 'admin'\]\.includes\(user\.role\)/,
  );
  assert.match(taskCard, /等待有权限的管理层在本任务卡处理/);
  assert.match(taskCard, /status === '待审核' \? '待人工验收'/);
  assert.match(taskCard, /返工中（人工验收退回）/);
  assert.match(taskCard, /按验收意见修改后重新提交人工验收/);
  assert.match(execution, /label="待我人工验收"/);
  assert.match(execution, /label="我的提交待人工验收"/);
  assert.doesNotMatch(execution, /label="待审任务"/);
  assert.match(dashboard, /'待审批事项'/);
  assert.match(dashboard, /'待我人工验收任务'/);
  assert.match(dashboard, /'我的提交待人工验收'/);
  assert.doesNotMatch(dashboard, /'待人工审阅任务'/);
  assert.doesNotMatch(taskCard, /status === '待审核' \? '待人工审阅'/);
  assert.doesNotMatch(taskCard, /等待总监或老板在本任务卡处理/);
});

test("餐饮员工任务动态、通知深链和任务分页都能落到对应工作台", () => {
  const employees = read("web/src/pages/Employees.tsx");
  const workbench = read("web/src/components/EmployeeWorkbench.tsx");
  const layout = read("web/src/layouts/MainLayout.tsx");

  assert.match(employees, /api\.get\('\/marshals\/drill\/tasks'\)/);
  assert.match(
    employees,
    /className="employee-pulse-item"[\s\S]*openEmployee\(employee, item\.id\)/,
  );
  assert.match(employees, /initialTaskId=\{requestedTaskId\}/);
  assert.match(
    workbench,
    /\/restaurant\/\$\{idx\}\/tasks\?offset=\$\{page\.nextOffset\}&limit=8/,
  );
  assert.match(workbench, /加载更多（已显示/);
  assert.match(workbench, /:\$\{tenantId\}:\$\{userId\}:restaurant`/);
  assert.match(
    layout,
    /const explicit =\s*typeof notification\?\.link === 'string'/,
  );
  assert.match(layout, /const t = notificationTarget\(n\)/);
});

test("内容员工仅在真实来源、账务结算和契约均通过后开放审阅，采纳后才下载", () => {
  const workbench = read("web/src/components/EmployeeWorkbench.tsx");

  assert.match(
    workbench,
    /const provided = canonicalDisplayStatus\(run\.displayStatus\);\s*if \(provided\) return provided;\s*if \(run\.status === '失败'/,
  );

  assert.match(
    workbench,
    /const selectedRunReviewReady = selectedRun\?\.canReview === true/,
  );
  assert.match(
    workbench,
    /profile\.permissions\.canReviewRuns && selectedRunReviewReady && \(/,
  );
  assert.match(
    workbench,
    /selectedRun\.canAdopt === true && \(\s*<Button type="primary"/,
  );
  assert.match(
    workbench,
    /selectedRun\.canReject === true && \(\s*<Button\s+danger/,
  );
  assert.match(workbench, /selectedRunDownloadReady && artifact\.downloadUrl/);
  assert.match(
    workbench,
    /账务确认前不进入人工审阅，也不能采纳、下载或进入内容生产仓/,
  );
});

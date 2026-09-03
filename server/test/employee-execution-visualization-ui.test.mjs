import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (relativePath) =>
  fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

test("餐饮与内容员工工作台共享真实执行时间线，任务中心运行详情持续刷新同一证据", () => {
  const workbench = read("web/src/components/EmployeeWorkbench.tsx");
  const taskCenter = read("web/src/pages/TaskCenter.tsx");
  const timeline = read("web/src/components/EmployeeExecutionTimeline.tsx");

  assert.match(workbench, /selectedRun\.executionProgress/);
  assert.match(workbench, /restaurantTask\.generationProgress/);
  assert.match(taskCenter, /detail\.executionProgress/);
  assert.match(taskCenter, /EmployeeExecutionTimeline/);
  assert.match(taskCenter, /DETAIL_RUNNING_REFRESH_MS\s*=\s*2_000/u);
  assert.match(timeline, /progress\.steps/);
  assert.match(timeline, /progress\?\.currentLabel/);
  assert.match(timeline, /receivedChars === 0 && isModelResponseStage/);
  assert.match(timeline, /模型正在推理，等待首字返回/u);
  assert.match(timeline, /第 \$\{attemptNumber\} 次/u);
  assert.match(timeline, /当前阶段：\$\{currentLabel\}/u);
  assert.match(timeline, /已用时约/u);
  assert.match(timeline, /响应字符（流式进度，不是质检阈值）/u);
  assert.match(workbench, /isWaitingForFirstModelCharacter/);
  assert.match(workbench, /模型正在推理，等待首字返回/u);
  assert.match(workbench, /质检不是字数或字节门槛/u);
  assert.match(workbench, /「工作方式」查看本岗位质量关卡/u);
  assert.match(workbench, /「岗位档案」查看质量标准与输出契约/u);
  assert.doesNotMatch(
    timeline,
    /progress\??\.(?:prompt|query|url)|JSON\.stringify\(progress\)/u,
  );
  assert.doesNotMatch(timeline, /Math\.random|setInterval|fake|模拟进度/u);
});

test("侧栏 dashboard 模块角色化改名只作用于首页，门店日常/评价中心保留本名", () => {
  const layout = read("web/src/layouts/MainLayout.tsx");
  // 回归背景：曾把所有 mod==='dashboard' 的菜单项统一改名成「老板驾驶舱」，
  // 导致门店日常、评价中心在侧栏显示为三个重复的驾驶舱入口。
  assert.match(layout, /m\.mod !== 'dashboard' \|\| m\.key !== '\/'/u);
  assert.match(layout, /label: '门店日常', mod: 'dashboard'/u);
  assert.match(layout, /label: '评价中心', mod: 'dashboard'/u);
});

test("数字员工卡片分层规整：身份卡头+介绍+能力技能摘要+执行状态", () => {
  const page = read("web/src/pages/Employees.tsx");
  const styles = read("web/src/pages/Employees.css");

  // 卡头一处集中身份与状态（不再单开房间栏），介绍走清洗后的纯文本
  assert.match(page, /employee-card-head/);
  assert.match(page, /employee-current-action/);
  assert.match(page, /plainCatalogText\(employee\.business\?\.intro/);
  // 能力/技能摘要行：数量 + 前两项能力名，点击进工作台看完整能力
  assert.match(page, /employee-powers/);
  assert.match(page, /employee\.capabilityCount/);
  assert.match(page, /employee\.skillCount/);
  assert.match(page, /employee\.capabilityNames/);
  assert.match(styles, /\.employee-card-head/);
  assert.match(styles, /\.employee-powers/);
  // 旧的输入→执行→交付三联链已按“卡片降噪”撤下
  assert.doesNotMatch(page, /employee-card-chain/);
});

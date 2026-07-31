import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('平台超管前端只保留平台控制台入口，不进入企业后台或充值页', () => {
  const app = read('web/src/App.tsx');
  const recharge = read('web/src/pages/Recharge.tsx');

  assert.match(app, /function EnterpriseOnly/);
  assert.match(app, /role === 'platform_super'.*Navigate to="\/platform"/s);
  assert.match(app, /path="\/admin".*roles=\{\['boss', 'admin'\]\}/s);
  assert.match(app, /path="\/m".*EnterpriseOnly/s);
  assert.match(app, /<EnterpriseOnly>\s*<MainLayout \/>\s*<\/EnterpriseOnly>/);
  assert.doesNotMatch(recharge, /role !== 'boss' && role !== 'platform_super'/);
});

test('移动端核心工作台按模块和角色过滤，销售不发起管理层简报请求', () => {
  const mobile = read('web/src/pages/Mobile.tsx');
  const dashboard = read('web/src/pages/Dashboard.tsx');

  assert.match(mobile, /CORE_WORKSPACES\.filter\(item => mods\.includes\(item\.mod\) && item\.roles\.includes\(user\.role\)\)/);
  assert.match(mobile, /useQuery<DashboardBriefing>\('\/dashboard\/briefing'.*enabled: canViewManagementBriefing/s);
  assert.match(dashboard, /if \(canViewManagementBriefing\).*\/dashboard\/daily-digest/s);
});

test('数字员工完整工作台直接展示七个岗位面板，不把技能、提示词和配置藏进高级设置', () => {
  const workbench = read('web/src/components/EmployeeWorkbench.tsx');

  for (const key of ['dispatch', 'capabilities', 'method', 'skills', 'prompts', 'config', 'profile']) {
    assert.match(workbench, new RegExp(`key: '${key}'`));
  }
  assert.doesNotMatch(workbench, /showAdvanced|高级设置|tabBarExtraContent/);
});

test('内容仓固定创作模板不冒充实时AI建议，也不会在缺少业务简报时填入虚构主题', () => {
  const contentFactory = read('web/src/pages/ContentFactory.tsx');

  assert.match(contentFactory, /创作参考模板/);
  assert.match(contentFactory, /固定示例，不是实时 AI 判断/);
  assert.match(contentFactory, /系统没有为这些模板读取实时热点、经营表现或活动排期/);
  assert.match(contentFactory, /暂无带业务记录的今日主题/);
  assert.doesNotMatch(contentFactory, /AI创作建议/);
  assert.doesNotMatch(contentFactory, /briefing\?\.theme \|\| '夏季招牌菜主题周'/);
  assert.doesNotMatch(contentFactory, /<b>数据来源：<\/b>/);
});

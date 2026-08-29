import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('餐饮员工工作台的公开输入必须由系统自行补齐，不能回退到客户必填指导语', () => {
  const workbenchSource = read('server/src/employee-workbench.js');
  const start = workbenchSource.indexOf('function dispatchGuidance');
  const end = workbenchSource.indexOf('\nfunction profileVersion', start);
  assert.ok(start >= 0 && end > start, '必须能定位餐饮派活指导生成器');
  const guidance = workbenchSource.slice(start, end);

  // This is the old Paihuo-style bypass: it is returned by the backend DTO even
  // when the React page happens to override the label. Any other client can
  // still render it, so the contract must be fixed at the source.
  assert.doesNotMatch(guidance, /requirementLabel:\s*`请提供/u);
  assert.doesNotMatch(guidance, /先给真实材料和决策边界/u);
  assert.doesNotMatch(guidance, /缺失项请明确写/u);
  assert.doesNotMatch(guidance, /没有数据时应标假设/u);
  assert.match(guidance, /公开信息|联网|可选/u);
});

test('工作方式与派活页面持续锁定“公开信息自动联网、内部材料可选”语义', () => {
  const ui = read('web/src/components/EmployeeWorkbench.tsx');
  assert.match(ui, /系统自行补齐与核验（内部资料缺失不阻塞开工）/u);
  assert.match(ui, /公开的地点、竞品、地图、评价、平台规则与实时信息由系统自行联网获取/u);
  assert.match(ui, /<UnifiedFilePicker/u);
  assert.match(ui, /附件/u);
  assert.doesNotMatch(ui, /开始前必须补齐|AI通道不可用|仅生成(?:可审阅的)?岗位执行底稿/u);
});

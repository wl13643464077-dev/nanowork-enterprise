import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = requireWeb('typescript');
const jsx = (type, props) => ({ type, props });
function load(file) {
  const source = fs.readFileSync(new URL(`../../web/src/pages/${file}`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} }; const updates = [];
  const mocks = { 'react/jsx-runtime': { jsx, jsxs: jsx }, react: { useState: value => [value, next => updates.push(next)], useMemo: fn => fn(), useCallback: fn => fn, useEffect() {} }, antd: new Proxy({}, { get: (_target, key) => key }) };
  new Function('require', 'module', 'exports', output)(name => mocks[name] || {}, module, module.exports);
  return { ...module.exports, updates, source };
}
const picker = load('TrialEmployeePicker.tsx');
const analytics = load('TrialAnalyticsPanel.tsx');
const rows = [
  { id: 'restaurant-101', name: '选址顾问', description: '商圈门店选址', department: '开店选址部', domain: 'restaurant', example: '分析商圈' },
  { id: 'restaurant-142', name: '餐饮种草', description: '顾客UGC运营', department: '营销增长部', domain: 'restaurant', example: '门店宣传' },
  { id: 'content-10', name: 'AI带货员', description: '带货视频脚本', group: '内容生产部', domain: 'content', example: '帮我写15秒视频脚本' },
  { id: 'content-11', name: 'AI小红书种草员', description: '美食标题、正文与配图方案', group: '内容生产部', domain: 'content', example: '写9图种草方案', capabilities: ['小红书'] },
];
function all(tree, predicate, result = []) {
  if (Array.isArray(tree)) { tree.forEach(child => all(child, predicate, result)); return result; }
  if (!tree || typeof tree !== 'object') return result;
  if (predicate(tree)) result.push(tree);
  all(tree.props?.children, predicate, result); return result;
}
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : Array.isArray(tree) ? tree.map(text).join(' ') : tree?.props ? text(tree.props.children) : '';

test('全员选择按部门与需求搜索，不硬编码三个体验岗位', () => {
  assert.equal(picker.filterTrialEmployees(rows, '').length, 4);
  assert.deepEqual(picker.filterTrialEmployees(rows, '', '内容生产部').map(row => row.id), ['content-10', 'content-11']);
  assert.deepEqual(picker.filterTrialEmployees(rows, '  ugc  ').map(row => row.id), ['restaurant-142']);
  assert.deepEqual(picker.filterTrialEmployees(rows, '小红书 9图').map(row => row.id), ['content-11']);
  assert.equal(picker.filterTrialEmployees(rows, '不存在的岗位').length, 0);
});

test('多岗位列表默认在关闭的选择弹窗中，选择只回传岗位不自动发送对话', () => {
  const selected = [];
  const tree = picker.default({ employees: rows, value: rows[0].id, onChange: id => selected.push(id) });
  assert.equal(all(tree, node => node.type === 'Modal')[0].props.open, false);
  const options = all(tree, node => node.type === 'button');
  assert.equal(options.length, 4);
  options[3].props.onClick();
  assert.deepEqual(selected, ['content-11']);
  assert.doesNotMatch(picker.source, /trialRequest|api\.(post|get)/);
  assert.match(picker.source, /trial-picker-results/);
});

test('带货和小红书在H5明确只提供文字方案，示例点击仅填入', () => {
  const values = [];
  const video = picker.TrialEmployeeGuide({ employee: rows[2], onExample: value => values.push(value) });
  const xhs = picker.TrialEmployeeGuide({ employee: rows[3], onExample: value => values.push(value) });
  assert.match(text(video), /不生成视频文件/);
  assert.match(text(xhs), /不生成图片文件/);
  all(video, node => node.type === 'button')[0].props.onClick();
  assert.deepEqual(values, [picker.trialEmployeeExample(rows[2])]);
  assert.match(picker.trialEmployeeDescription({ ...rows[2], description: '立即生成15秒视频文件' }), /脚本|分镜/);
  assert.match(picker.trialEmployeeDescription({ ...rows[3], description: '自动生成9张图片' }), /配图方案/);
  assert.doesNotMatch(text(video), /立即生成|上传真实照片/);
});

test('客户看板固定客户口径，只有Super筛选销售，不混入本人消费', () => {
  assert.equal(analytics.trialAnalyticsPath(false, '30', 99), '/tester/analytics?days=30&scope=customers');
  assert.equal(analytics.trialAnalyticsPath(true, '7', 99), '/tester/admin/analytics?days=7&scope=customers&ownerUserId=99');
  assert.equal(analytics.trialAnalyticsPath(true, 'all'), '/tester/admin/analytics?days=all&scope=customers');
  assert.match(analytics.source, /测试员本人的记录与成本单独保留/);
  assert.match(analytics.source, /待核实调用不视为免费/);
  const portalSource = load('TesterPortal.tsx').source;
  assert.match(portalSource, /analytics\.personalSummary/);
  assert.doesNotMatch(portalSource, /conversations\.reduce/);
  assert.match(analytics.source, /2 次已用完/);
  assert.deepEqual(analytics.actuallyUsedEmployees([
    { id: 'selected-only', totalCalls: 0, successfulConversations: 0 },
    { id: 'failed-call', totalCalls: 1, successfulConversations: 0 },
    { id: 'legacy-success', totalCalls: 0, successfulConversations: 1 },
  ]).map(row => row.id), ['failed-call', 'legacy-success']);
});

test('兴趣以主动选择和真实使用标示，旧用户兴趣记账失败不会阻塞对话', () => {
  const source = load('TrialExperience.tsx').source;
  const start = source.indexOf('const chooseEmployee =');
  const end = source.indexOf('return (', start);
  const action = source.slice(start, end);
  assert.match(action, /lead\?\.status === 'approved'/);
  assert.match(action, /\/interest/);
  assert.match(action, /\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(action, /setError|send\(/);
  assert.match(analytics.source, /不是购买意向预测/);
  assert.match(analytics.source, /主动选择过/);
  assert.match(analytics.source, /实际成功用过/);
});

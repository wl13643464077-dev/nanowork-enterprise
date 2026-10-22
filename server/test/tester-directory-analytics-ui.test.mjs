import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = requireWeb('typescript');
const jsx = (type, props) => ({ type, props });
function load(file, mockOverrides = {}) {
  const source = fs.readFileSync(new URL(`../../web/src/pages/${file}`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} }; const updates = [];
  const mocks = { 'react/jsx-runtime': { jsx, jsxs: jsx }, react: { useState: value => [value, next => updates.push(next)], useMemo: fn => fn(), useCallback: fn => fn, useEffect() {} }, antd: new Proxy({}, { get: (_target, key) => key }) };
  new Function('require', 'module', 'exports', output)(name => mockOverrides[name] || mocks[name] || {}, module, module.exports);
  return { ...module.exports, updates, source };
}
const picker = load('TrialEmployeePicker.tsx');
const analytics = load('TrialAnalyticsPanel.tsx');
const shared = load('TrialShared.tsx');
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

test('客户五员工展示既有肖像与员工身份，名单由服务器控制且不包含搜索弹窗', () => {
  const featured = [
    { ...rows[0], id: 'restaurant-104', name: '李选址', displayName: '选址' },
    { ...rows[0], id: 'restaurant-160', name: '超级店长经营中枢', displayName: '超级店长' },
    { ...rows[0], id: 'restaurant-161', name: '巡店流程管理', displayName: '巡店' },
    { ...rows[3], displayName: '小红书种草' },
    { ...rows[2], displayName: 'AI带货' },
  ];
  const selected = [];
  const tree = picker.default({ employees: featured, value: featured[0].id, onChange: id => selected.push(id), variant: 'featured' });
  const options = all(tree, node => node.type === 'button');
  assert.equal(options.length, 5);
  assert.equal(all(tree, node => ['Modal', 'Input', 'Select'].includes(node.type)).length, 0);
  assert.equal(options[0].props['aria-pressed'], true);
  assert.deepEqual(options.map(option => text(all(option, node => node.type === 'strong')[0])), ['李选址', '店小满', '查巡巡', '小红书种草员', 'AI带货员']);
  assert.match(options[0].props['aria-label'], /李选址，选址顾问，已选择/);
  assert.match(options[3].props['aria-label'], /小红书种草员.*选择体验/);
  for (const employee of featured) {
    const profile = picker.trialEmployeeProfile(employee);
    assert.match(profile.portrait, /^\/avatars\/employees\/[a-z]+-\d+\.jpg$/);
    assert.ok(fs.existsSync(new URL(`../../web/public${profile.portrait}`, import.meta.url)));
    assert.ok(profile.summary.length < 35);
  }
  assert.equal(new Set(featured.map(employee => picker.trialEmployeeProfile(employee).portrait)).size, 5);
  assert.doesNotMatch(picker.source, /trial-featured-number|padStart\(2/);
  options[3].props.onClick();
  assert.deepEqual(selected, ['content-11']);
  assert.doesNotMatch(text(tree), /部门|搜索/);
  // 卡片内容和数量由服务端名单决定，前端没有另一套岗位ID白名单。
  const serverEntry = { ...rows[0], id: 'server-selected-role', displayName: '服务端场景' };
  const serverTree = picker.default({ employees: [serverEntry], onChange() {}, variant: 'featured' });
  assert.equal(all(serverTree, node => node.type === 'button').length, 1);
  assert.match(text(serverTree), /服务端场景/);
});

test('生成期间五场景和全员选择器都禁止切岗，避免把结果归到另一位员工', () => {
  for (const variant of ['directory', 'featured']) {
    const chosen = [];
    const tree = picker.default({ employees: rows, value: rows[0].id, disabled: true, variant, onChange: id => chosen.push(id) });
    const options = all(tree, node => node.type === 'button');
    assert.ok(options.every(option => option.props.disabled));
    options[1].props.onClick();
    assert.deepEqual(chosen, []);
  }
});

test('刷新名单时保留仍开放的选岗，失效岗位重置到服务端首项', () => {
  assert.equal(picker.validTrialEmployeeId(rows, 'content-11'), 'content-11');
  assert.equal(picker.validTrialEmployeeId(rows, 'old-hidden-role'), rows[0].id);
  assert.equal(picker.validTrialEmployeeId(rows), rows[0].id);
  assert.equal(picker.validTrialEmployeeId([], 'old-hidden-role'), undefined);
  const customer = load('TrialExperience.tsx').source;
  assert.match(customer, /setEmployeeId\(current => validTrialEmployeeId/);
  assert.match(customer, /employees=\{landing\.employees\}/);
  assert.match(customer, /variant="featured"/);
  assert.match(customer, /disabled=\{busy\}/);
  assert.match(customer, /五个场景合计/);
  assert.doesNotMatch(customer, /差评如何回复/);
});

test('测试员管理页引导进入正式全员产品，二维码说明客户使用五个满血岗位', () => {
  const portal = load('TesterPortal.tsx').source;
  assert.match(portal, /setTrialEmployees\(result\.trialEmployees \|\| \[\]\)/);
  assert.match(portal, /trialEmployees\.map\(employee/);
  assert.doesNotMatch(portal, /employees=\{employees\}|trialRequest\('\/tester\/chat'/);
  assert.match(portal, /nav\('\/employees'\)/);
  assert.match(portal, /历史文字测试/);
  assert.match(portal, /nav\('\/tasks'\)/);
  assert.doesNotMatch(portal, /variant="featured"/);
  assert.match(portal, /五个员工共用总次数/);
  assert.match(portal, /不假装图片或视频已经生成/);
  assert.match(portal, /Key。之后切换供应商不会改变已经分享的二维码/);
});

test('带货和小红书在H5标明满血岗位，示例点击仅填入', () => {
  const values = [];
  const video = picker.TrialEmployeeGuide({ employee: rows[2], onExample: value => values.push(value) });
  const xhs = picker.TrialEmployeeGuide({ employee: rows[3], onExample: value => values.push(value) });
  assert.match(text(video), /满血岗位/);
  assert.match(text(xhs), /不假装文件已经生成/);
  all(video, node => node.type === 'button')[0].props.onClick();
  assert.deepEqual(values, [picker.trialEmployeeExample(rows[2])]);
  assert.equal(picker.trialEmployeeDescription({ ...rows[2], description: '立即生成15秒视频文件' }), '立即生成15秒视频文件');
  assert.equal(picker.trialEmployeeDescription({ ...rows[3], description: '自动生成9张图片' }), '自动生成9张图片');
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
  assert.match(analytics.source, /体验额度已用完/);
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

test('客户个人额度优先，旧数据兼容两次，列表按个人额度判断使用阶段', () => {
  assert.equal(shared.trialTurnLimit(9, 5), 9);
  assert.equal(shared.trialTurnLimit(undefined, 5), 5);
  assert.equal(shared.trialTurnLimit(undefined), 2);
  assert.equal(shared.trialTurnLimit(0, 7), 7);
  assert.equal(shared.trialTurnLimit(1.5, 101, NaN), 2);
  assert.equal(shared.trialUsageState({ usedTurns: 0, turnLimit: 9 }), 'unused');
  assert.equal(shared.trialUsageState({ usedTurns: 2, turnLimit: 9 }), 'active');
  assert.equal(shared.trialUsageState({ usedTurns: 9, turnLimit: 9 }), 'exhausted');
  assert.equal(shared.trialUsageState({ usedTurns: 1, turnLimit: 1 }), 'exhausted');
  assert.equal(shared.trialUsageState({ usedTurns: 2 }), 'exhausted');
});

function renderCustomer(landingLimit, lead = null) {
  const states = [
    { title: '额度验收', salesPhone: '', employees: rows, turnLimit: landingLimit },
    lead ? 'session' : '', false, lead, [], rows[0].id, '测试需求', false, false, '', '',
  ];
  const component = load('TrialExperience.tsx', {
    react: {
      useState: () => [states.shift(), () => {}], useRef: value => ({ current: value }),
      useCallback: fn => fn, useEffect() {},
    },
    'react-router-dom': { Link: 'Link', useParams: () => ({ token: 'test' }) },
    './TrialShared': shared,
    './TrialEmployeePicker': picker,
  });
  return component.default();
}

test('H5申请入口使用二维码额度，已有客户文案和进度使用个人额度', () => {
  const application = renderCustomer(7);
  assert.match(text(application), /申请\s+7\s+次体验/);
  assert.match(text(application), /五个场景共用\s+7\s+次成功体验/);
  const active = renderCustomer(5, { id: 1, status: 'approved', usedTurns: 4, remainingTurns: 5, turnLimit: 9 });
  assert.match(text(active), /五个场景共用\s+9\s+次成功体验/);
  assert.match(text(active), /还可以体验 5 次/);
  assert.equal(all(active, node => node.type === 'Progress')[0].props.percent, (4 / 9) * 100);
  const complete = renderCustomer(5, { id: 1, status: 'approved', usedTurns: 1, remainingTurns: 0, turnLimit: 1 });
  assert.match(text(complete), /1 次体验已用完/);
  assert.equal(all(complete, node => node.type === 'Progress')[0].props.percent, 100);
  assert.doesNotMatch(text(complete), /开始这次问答|两次体验/);
});

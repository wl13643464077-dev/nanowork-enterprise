import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = requireWeb('typescript');
const read = file => readFileSync(new URL(`../../web/src/components/mobile/${file}`, import.meta.url), 'utf8');
const jsx = (type, props) => ({ type, props });
const compile = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const routes = { exports: {} };
new Function('module', 'exports', compile(read('mobileRoutes.ts')))(routes, routes.exports);

function fixture(file, { user = {}, states = [], queryData = {}, extra = '' } = {}) {
  let stateIndex = 0;
  const requests = [];
  const effects = [];
  const mocks = {
    react: {
      useState(initial) {
        const index = stateIndex++;
        return [Object.hasOwn(states, index) ? states[index] : typeof initial === 'function' ? initial() : initial, () => {}];
      },
      useEffect: callback => effects.push(callback), useCallback: callback => callback, useMemo: callback => callback(),
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    antd: new Proxy({ message: { success() {}, warning() {}, error() {} }, Input: { TextArea: 'TextArea' } }, {
      get: (target, key) => key in target ? target[key] : key,
    }),
    '@ant-design/icons': new Proxy({}, { get: (_target, key) => key }),
    '../../api/client': {
      getUser: () => user, clearAuth() {}, fmtMoney: value => String(value || 0),
      api: { get: url => { requests.push(url); return Promise.resolve([]); }, post: async () => ({}) },
    },
    '../../hooks/useRealtimeEvents': { REALTIME_EVENTS: {}, useRealtimeEvent() {} },
    '../../hooks/useQuery': { useQuery: () => ({ data: queryData }), QueryStatus: 'QueryStatus' },
    './mobileRoutes': routes.exports,
    './employeeCatalog': { employeeDisplayName: employee => employee?.name || '', deptToneIndex: () => 1 },
    '../EmployeeAvatar': { default: 'EmployeeAvatar' },
    '../UnifiedFilePicker': { UnifiedFilePicker: 'UnifiedFilePicker' },
    './mobile.css': {},
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', compile(`${read(file)}\n${extra}`))(
    name => {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency ${name}`);
      return mocks[name];
    }, module, module.exports, { sessionStorage: { getItem: () => null } },
  );
  return { ...module.exports, requests, effects };
}

function all(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(node => all(node, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...all(tree.props?.children, predicate)];
}
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree)
  : Array.isArray(tree) ? tree.map(text).join(' ') : tree?.props ? text(tree.props.children) : '';
const tester = { accountType: 'tester', role: 'sales', name: '测试伙伴', tenant: { name: '独立测试空间' } };

test('手机我的可进入个人Key/客户体验管理，测试员不请求或展示企业充值余额', () => {
  // 角色变化或旧余额仍在组件状态中时，仍以tester身份阻断企业余额显示。
  const user = { ...tester, role: 'boss' };
  const me = fixture('MobileMe.tsx', { user, states: [{ credits: 999, totalRecharged: 888 }] });
  const destinations = [];
  const tree = me.default({ user, nav: path => destinations.push(path) });
  me.effects.forEach(effect => effect());
  assert.ok(!me.requests.includes('/recharge/balance'));
  assert.doesNotMatch(text(tree), /企业积分|累计充值|已消耗/);
  assert.match(text(tree), /测试员 \/ 销售伙伴/);
  assert.match(text(tree), /个人供应商账户付费/);
  const button = all(tree, node => node.type === 'Button' && text(node) === '管理个人 Key 与客户体验')[0];
  assert.ok(button);
  button.props.onClick();
  assert.deepEqual(destinations, ['/tester']);
  all(tree, node => node.type === 'Button' && text(node) === '打开完整产品工作台')[0].props.onClick();
  assert.deepEqual(destinations, ['/tester', '/']);
});

test('普通企业老板手机我的保留原企业余额与切电脑版入口', () => {
  const user = { role: 'boss', accountType: 'primary' };
  const me = fixture('MobileMe.tsx', { user, states: [{ credits: 999 }] });
  const tree = me.default({ user, nav() {} });
  me.effects.forEach(effect => effect());
  assert.ok(me.requests.includes('/recharge/balance'));
  assert.match(text(tree), /企业积分/);
  assert.match(text(tree), /切换到电脑版/);
  assert.doesNotMatch(text(tree), /管理个人 Key 与客户体验/);
});

test('测试员手机首页按模块展示完整业务入口，内容生产不误跳素材列表', () => {
  const home = fixture('MobileHome.tsx');
  const destinations = [];
  const mods = ['content', 'advisor', 'analysis', 'assets', 'system'];
  const tree = home.default({ user: tester, mods, inboxCount: 0, nav: path => destinations.push(path) });
  const entries = all(tree, node => node.type === 'button' && node.props.className === 'm-workspace-item');
  for (const title of ['内容生产仓', '经营工具箱', '老板参谋', '经营分析', '知识资产']) {
    const entry = entries.find(node => node.props['aria-label'] === `进入${title}`);
    assert.ok(entry, title);
    entry.props.onClick();
  }
  assert.deepEqual(destinations, ['/content', '/toolbox', '/advisor', '/analysis', '/assets']);
  assert.ok(home.testerMobileWorkspaces(['advisor']).length > 0);
  assert.deepEqual(home.testerMobileWorkspaces([]), []);
  assert.deepEqual(home.testerMobileWorkspaces(['system']), []);
  assert.equal(entries.some(node => /系统|充值|管理员/.test(text(node))), false);
});

test('普通销售手机首页保留原角色范围和移动内容映射', () => {
  const home = fixture('MobileHome.tsx');
  const destinations = [];
  const tree = home.default({ user: { role: 'sales' }, mods: ['content', 'analysis'], inboxCount: 0, nav: path => destinations.push(path) });
  const entries = all(tree, node => node.type === 'button' && node.props.className === 'm-workspace-item');
  assert.equal(entries.some(node => node.props['aria-label'] === '进入经营分析'), false);
  entries.find(node => node.props['aria-label'] === '进入内容生产仓').props.onClick();
  assert.deepEqual(destinations, ['/m/content']);
});

test('数字员工目录和派活表单对测试员显示个人Key费用，企业保留积分估价', () => {
  const employee = { idx: 104, name: '选址', group: '开店', business: { cost: { typicalCredits: 45 } } };
  const extra = 'export const dispatchScreens = { DispatchList, DispatchForm };';
  for (const user of [tester, { role: 'sales' }]) {
    const list = fixture('MobileDispatch.tsx', { user, states: [{ employees: [employee] }, false], extra });
    const listTree = list.dispatchScreens.DispatchList({ nav() {} });
    const profile = { identity: { name: '选址' }, permissions: { canDispatch: true } };
    const form = fixture('MobileDispatch.tsx', { user, states: [null, profile, employee, null, false], extra });
    const formTree = form.dispatchScreens.DispatchForm({ idx: 104, nav() {} });
    for (const tree of [listTree, formTree]) {
      if (user.accountType === 'tester') {
        assert.match(text(tree), /个人 Key 计费/);
        assert.doesNotMatch(text(tree), /积分/);
      } else {
        assert.match(text(tree), /45.*积分/);
        assert.doesNotMatch(text(tree), /个人 Key 计费/);
      }
    }
  }
  const source = read('MobileDispatch.tsx');
  assert.match(source, /半自动 · 逐个确认/);
  assert.match(source, /全自动 · 同时开工/);
  assert.match(source, /让队长拆解分工/);
  assert.match(source, /\/employees\/team-plan/);
  assert.match(source, /\/employees\/team-summary/);
});

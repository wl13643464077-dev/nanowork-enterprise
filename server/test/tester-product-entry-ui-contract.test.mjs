import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = requireWeb('typescript');
const read = file => readFileSync(new URL(`../../web/src/${file}`, import.meta.url), 'utf8');
const jsx = (type, props) => ({ type, props });
const compile = source => ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;

function appFixture(initialUser = null) {
  let user = initialUser;
  const session = new Map();
  const module = { exports: {} };
  const mocks = {
    react: { lazy: () => Symbol('lazy-page'), Suspense: 'Suspense', useState() {}, useEffect() {} },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    antd: { Spin: 'Spin' },
    'react-router-dom': { BrowserRouter: 'BrowserRouter', Routes: 'Routes', Route: 'Route', Navigate: 'Navigate' },
    './api/client': { getUser: () => user, bootstrapSession: async () => user },
    './layouts/MainLayout': { default: 'MainLayout' },
    './pages/Login': { default: 'Login' },
  };
  const source = `${read('App.tsx')}\nexport const entryGuards = { EnterpriseOnly, TesterOnly, PlatformOnly, ModuleOnly, RoleOnly, OnboardingEntry };`;
  new Function('require', 'module', 'exports', 'sessionStorage', compile(source))(
    name => {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency ${name}`);
      return mocks[name];
    },
    module,
    module.exports,
    { getItem: key => session.get(key), setItem: (key, value) => session.set(key, value) },
  );
  return { ...module.exports, setUser: value => { user = value; }, session };
}

function descendants(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(node => descendants(node, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...descendants(tree.props?.children, predicate)];
}

const tester = {
  id: 22,
  accountType: 'tester',
  role: 'sales',
  name: '测试伙伴',
  modules: ['dashboard', 'marshals', 'content', 'execution'],
  tenant: { id: 222, status: '已开通', onboardingStatus: 'pending' },
};
const content = { page: 'authorized-product' };

test('测试员进入产品壳层但每页仍使用服务端模块授权', () => {
  const app = appFixture(tester);
  assert.equal(app.entryGuards.EnterpriseOnly({ children: content }), content);
  assert.equal(app.entryGuards.ModuleOnly({ moduleKey: 'marshals', children: content }), content);
  assert.equal(app.entryGuards.ModuleOnly({ moduleKey: 'content', children: content }), content);
  assert.equal(app.entryGuards.ModuleOnly({ moduleKey: 'analysis', children: content }).props.to, '/');

  app.setUser({ ...tester, modules: ['execution'] });
  assert.equal(app.entryGuards.ModuleOnly({ moduleKey: 'marshals', children: content }).props.to, '/execution');
  app.setUser({ ...tester, modules: [] });
  assert.equal(app.entryGuards.ModuleOnly({ moduleKey: 'marshals', children: content }).props.to, '/login');
});

test('测试员系统配置和角色管理页保持关闭，不自动进入开店向导', () => {
  const app = appFixture({ ...tester, modules: ['dashboard', 'system'] });
  assert.equal(app.entryGuards.ModuleOnly({ moduleKey: 'system', children: content }).props.to, '/');
  assert.equal(app.entryGuards.RoleOnly({ roles: ['boss', 'admin'], children: content }).props.to, '/');
  assert.equal(app.entryGuards.PlatformOnly({ children: content }).props.to, '/');
  assert.equal(app.entryGuards.OnboardingEntry({ children: content }), content);
  assert.equal(app.session.size, 0);

  // 即使未来测试员的展示角色变化，也不能获得企业账号/付费管理权限。
  app.setUser({ ...tester, role: 'boss' });
  assert.equal(app.entryGuards.RoleOnly({ roles: ['boss'], children: content }).props.to, '/');
  assert.equal(app.entryGuards.OnboardingEntry({ children: content }), content);
});

test('测试员后台独立于产品业务壳层，仍需测试员身份，申请和H5保持公开', () => {
  const app = appFixture(tester);
  const routes = descendants(app.default(), node => node.type === 'Route');
  const shell = routes.find(route => route.props.element?.props?.children?.type === 'MainLayout');
  assert.ok(shell);
  assert.equal(shell.props.element.type.name, 'EnterpriseOnly');
  assert.equal(descendants(shell, node => node.type === 'Route' && node.props.path === '/tester').length, 0);
  const management = routes.filter(node => node.props.path === '/tester');
  assert.equal(management.length, 1);
  assert.equal(management[0].props.element.type.name, 'TesterOnly');
  assert.equal(management[0].props.element.props.children.props.embedded, undefined);
  assert.equal(routes.filter(route => route.props.path === '/tester').length, 1);
  for (const publicPath of ['/tester/apply', '/try/:token']) {
    assert.ok(routes.some(route => route.props.path === publicPath));
    assert.equal(descendants(shell, node => node.props?.path === publicPath).length, 0);
  }
});

test('普通企业与Super原有路由权限和向导分流不变', () => {
  const app = appFixture();
  assert.equal(app.entryGuards.EnterpriseOnly({ children: content }).props.to, '/login');
  assert.equal(app.entryGuards.TesterOnly({ children: content }).props.to, '/login');

  app.setUser({ role: 'platform_super', accountType: 'platform' });
  assert.equal(app.entryGuards.EnterpriseOnly({ children: content }).props.to, '/platform');
  assert.equal(app.entryGuards.TesterOnly({ children: content }).props.to, '/platform');
  assert.equal(app.entryGuards.PlatformOnly({ children: content }), content);

  app.setUser({ role: 'boss', accountType: 'primary', modules: ['system'], tenant: { onboardingStatus: 'pending' } });
  assert.equal(app.entryGuards.EnterpriseOnly({ children: content }), content);
  assert.equal(app.entryGuards.TesterOnly({ children: content }).props.to, '/');
  assert.equal(app.entryGuards.ModuleOnly({ moduleKey: 'system', children: content }), content);
  assert.equal(app.entryGuards.RoleOnly({ roles: ['boss', 'admin'], children: content }), content);
  assert.equal(app.entryGuards.OnboardingEntry({ children: content }).props.to, '/onboarding');
  assert.equal(app.entryGuards.OnboardingEntry({ children: content }), content);
});

async function loginDestination(user, userAgent) {
  // Exercise the real submit callback with only IO/UI boundaries substituted.
  const source = ts.createSourceFile('Login.tsx', read('pages/Login.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let submit;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'submit') submit = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(submit, 'Login must have a submit callback');
  const module = { exports: {} };
  const destinations = [];
  const deps = {
    setLoading() {}, setLoginError(error) { if (error) assert.fail(error); },
    sound: { press() {}, success() {} },
    api: { post: async () => ({ token: 'fixture-cookie', user }) },
    setAuth(_token, actualUser) { assert.equal(actualUser, user); },
    localStorage: { setItem() {}, removeItem() {} }, REMEMBER_KEY: 'fixture-remember',
    message: { success() {}, warning() {} }, nav: destination => destinations.push(destination),
    navigator: { userAgent },
  };
  new Function('module', 'exports', ...Object.keys(deps), compile(`export const submit = ${submit.getText(source)};`))(
    module, module.exports, ...Object.values(deps),
  );
  await module.exports.submit({ username: 'fixture', password: 'fixture' });
  return destinations;
}

test('测试员默认进入桌面或移动产品首页，不强制打开体验管理', async () => {
  assert.deepEqual(await loginDestination(tester, 'Mozilla Desktop'), ['/']);
  assert.deepEqual(await loginDestination(tester, 'Mozilla iPhone Mobile'), ['/m']);
});

test('Super和普通企业登录目的地保持原合同', async () => {
  assert.deepEqual(await loginDestination({ role: 'platform_super' }, 'Mozilla iPhone Mobile'), ['/platform']);
  assert.deepEqual(await loginDestination({ role: 'boss', tenant: { status: '已开通' } }, 'Mozilla Desktop'), ['/']);
  assert.deepEqual(await loginDestination({ role: 'sales', tenant: { status: '已开通' } }, 'Mozilla Mobile'), ['/m']);
  assert.deepEqual(await loginDestination({ role: 'boss', tenant: { status: '待审核' } }, 'Mozilla Desktop'), ['/pending']);
});

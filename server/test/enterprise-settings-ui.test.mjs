import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = requireWeb('typescript');
const read = file => readFileSync(new URL(`../../web/src/${file}`, import.meta.url), 'utf8');
function harness(file, { role = 'boss', states = [], reply } = {}) {
  const exported = {};
  let cursor = 0;
  const calls = [];
  const effects = [];
  const component = new Proxy({}, { get: (_, key) => String(key) });
  const client = {
    getUser: () => ({ role }),
    api: new Proxy({}, { get: (_, method) => (...args) => { calls.push({ method, args }); return reply ? reply(method, args) : Promise.resolve(states[0]); } }),
  };
  vm.runInNewContext(ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports: exported,
    require(name) {
      if (name === 'react') return {
        useEffect(fn) { effects.push(fn); }, useMemo: fn => fn(), useCallback: fn => fn,
        useRef: value => ({ current: value }),
        useState(initial) { const idx = cursor++; if (!(idx in states)) states[idx] = typeof initial === 'function' ? initial() : initial;
          return [states[idx], value => { states[idx] = typeof value === 'function' ? value(states[idx]) : value; }]; },
      };
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
      if (name.includes('/api/client')) return client;
      if (name === 'antd') return { ...Object.fromEntries(['Alert','Button','Select','Space','Tag','Badge','Col','Row','Input','InputNumber','Table','Modal'].map(k => [k,k])), message: { success() {} } };
      if (name.endsWith('.css')) return {};
      if (name.endsWith('/RuntimeReadiness')) return { RuntimeReadinessMatrix: 'RuntimeReadinessMatrix', readinessMeta: () => ({ badge: 'default', label: '未验证' }) };
      return component;
    },
  });
  return { exported, states, calls, effects, invoke(fn, props) { cursor = 0; return fn(props); }, render(name = 'default', props) { cursor = 0; return exported[name](props); } };
}
function nodes(node, predicate, found = []) {
  if (Array.isArray(node)) node.forEach(child => nodes(child, predicate, found));
  else if (node && typeof node === 'object') {
    if (predicate(node)) found.push(node);
    nodes(node.props?.children, predicate, found);
    nodes(node.props?.extra, predicate, found);
  }
  return found;
}

for (const file of ['PlatformApiConfig.tsx', 'PlatformOperations.tsx']) {
  test(`${file}: 企业所有角色和未登录不会挂载平台配置或发起接口请求`, () => {
    for (const role of ['boss','admin','manager','ops_director','sales','partner',null]) {
      const h = harness(`components/${file}`, { role });
      assert.equal(h.render('default', { tenants: [] }), null);
      assert.deepEqual(h.calls, []);
    }
    assert.ok(harness(`components/${file}`, { role: 'platform_super' }).render('default', { tenants: [] }));
  });
}

test('店长和管理层模型独立保存，其他岗位的原配置完整保留', async () => {
  const routing = { text: { boss: 'model-a', manager: 'model-b', ops_director: 'model-c', sales: 'model-b', admin: 'model-c', partner: 'model-a' }, image: 'image', vision: 'vision', video: ['video'], videoDefault: 'video' };
  const providers = [{ id: 'openlux', label: 'OpenLux', available: true }, { id: '360', label: '360 智脑', available: true }];
  const data = { providerId: 'openlux', effectiveProvider: 'openlux', providerOverride: null, defaultProvider: 'openlux', providers,
    effective: routing, override: { text: { ...routing.text } }, roles: [], sources: { text: {}, hasTenantOverride: true }, catalog: { text: ['model-a','model-b','model-c'].map(id => ({ id, label: id })), image: [], vision: [], video: [] } };
  // 状态顺序：data、draft、previewProvider、saving、switching、loadError
  const h = harness('components/AdminModelRoutingPanel.tsx', { states: [data, { text: { ...routing.text } }, 'openlux', false, false, ''] });
  let tree = h.render('AdminModelRoutingPanel');
  const fields = nodes(tree, n => n.type === 'Select');
  assert.equal(fields.length, 10, '9 个模型下拉 + 1 个供应商下拉');
  assert.equal(fields.find(n => n.props['aria-label'] === '文本模型 · 店长').props.value, 'model-b');
  assert.equal(fields.find(n => n.props['aria-label'] === '文本模型 · 管理层').props.value, 'model-c');
  fields.find(n => n.props['aria-label'] === '文本模型 · 店长').props.onChange('model-a');
  assert.equal(h.states[1].text.manager, 'model-a');
  assert.equal(h.states[1].text.ops_director, 'model-c');
  assert.equal(h.states[1].text.boss, 'model-a');
  assert.equal(h.calls.length, 0, '选择不自动保存或运行任务');
  tree = h.render('AdminModelRoutingPanel');
  const save = nodes(tree, n => n.type === 'Button' && n.props.children === '保存设置')[0];
  assert.equal(save.props.disabled, false);
  save.props.onClick();
  await Promise.resolve();
  assert.equal(h.calls[0].method, 'put');
  assert.equal(h.calls[0].args[0], '/admin/model-routing');
  assert.equal(h.calls[0].args[1].provider, 'openlux', '保存时携带当前预览的供应商');
  assert.equal(h.calls[0].args[1].routing.text.manager, 'model-a');
  assert.equal(h.calls[0].args[1].routing.text.ops_director, 'model-c');
});

test('企业管理页不再挂载平台配置，企业系统页不再请求整库备份', () => {
  const admin = read('pages/Admin.tsx');
  const routing = read('components/AdminModelRoutingPanel.tsx');
  const system = read('pages/System.tsx');
  assert.doesNotMatch(admin, /PlatformApiConfig|<ApiConfig|\/admin\/api-config|API Key|Base URL|credits\/adjust|同步增发|调整共享池/);
  assert.doesNotMatch(routing, /platformConfig|\/api-config|mode="tags"/);
  assert.doesNotMatch(system, /\/sys\/backup|CPU使用率|内存使用率|安全策略全部生效/);
  assert.match(read('pages/Platform.tsx'), /模型与接口/);
  assert.match(read('pages/Platform.tsx'), /<PlatformOperations tenants=\{tenants\}/);
});


test('平台测试连接只刷新服务状态，不覆盖未保存的网关、模型和价格', async () => {
  const cfg = { channel: { baseUrl: 'https://api.360.cn/v1', provider: 'test', providerId: '360' }, selectedProvider: '360', defaultProvider: '360',
    providers: [{ id: 'openlux', label: 'OpenLux', available: false }, { id: '360', label: '360 智脑', available: true }], billing: {}, routing: {}, h3: {}, usage: {} };
  const draftRouting = { text: { boss: 'draft-model' }, video: [] };
  const draftBilling = { creditYuan: 0.12, text: {}, image: {}, video: {} };
  // 状态顺序：cfg、selectedProvider、h3、testing、switching、saving、settingDefault、testResult、rt、bl、loadError
  const h = harness('components/PlatformApiConfig.tsx', { role: 'platform_super', states: [cfg, '360', { pricePer15s768p: 12 }, false, false, false, false, null, draftRouting, draftBilling, ''] });
  const editor = h.render().type;
  const tree = h.invoke(editor);
  nodes(tree, node => node.type === 'Button' && node.props.children === '测试已保存的连接')[0].props.onClick();
  for (let step = 0; step < 6; step += 1) await Promise.resolve();
  assert.equal(h.states[1], '360', '测试连接不切换正在查看的供应商');
  assert.equal(h.states[8], draftRouting);
  assert.equal(h.states[9], draftBilling);
  assert.equal(h.states[2].pricePer15s768p, 12);
  assert.deepEqual(h.calls.map(call => call.method), ['post', 'get']);
  assert.equal(JSON.stringify(h.calls[0].args), JSON.stringify(['/admin/api-config/test', { provider: '360' }]));
  assert.equal(h.calls[1].args[0], '/admin/api-config?provider=360');
});

test('平台配置首次读取失败呈现错误和重试，不永久显示加载中', async () => {
  const h = harness('components/PlatformApiConfig.tsx', { role: 'platform_super', reply: () => Promise.reject(new Error('fixture offline')) });
  const editor = h.render().type;
  h.invoke(editor);
  h.effects[0]();
  for (let step = 0; step < 4; step += 1) await Promise.resolve();
  const tree = h.invoke(editor);
  assert.equal(tree.type, 'Alert');
  assert.equal(tree.props.message, '平台配置读取失败');
  assert.equal(tree.props.description, 'fixture offline');
  assert.equal(tree.props.action.props.children, '重试');
});

test('尚未取得积分数据不显示已核对为零的绿色结论', () => {
  const h = harness('components/SystemBillingPanel.tsx');
  for (const loading of [true, false]) {
    const tree = h.render('SystemBillingPanel', { billingLoading: loading, billingReconciliation: null, canResolveBilling: false, loadBillingReconciliation() {} });
    assert.doesNotMatch(JSON.stringify(tree), /没有需要处理|success/);
    assert.match(JSON.stringify(tree), loading ? /正在读取/ : /重新读取/);
  }
});

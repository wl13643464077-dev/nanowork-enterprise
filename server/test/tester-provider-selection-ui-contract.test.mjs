import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = requireWeb('typescript');
const page = file => fs.readFileSync(new URL(`../../web/src/pages/${file}`, import.meta.url), 'utf8');
const component = file => fs.readFileSync(new URL(`../../web/src/components/${file}`, import.meta.url), 'utf8');

function loadPortal() {
  const source = page('TesterPortal.tsx');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  const mocks = {
    'react/jsx-runtime': {},
    react: {},
    antd: {},
    'react-router-dom': {},
    '../api/client': {},
    './TrialShared': {
      trialProviderLabel: provider => (provider === 'openlux' ? 'OpenLux' : provider === '360' ? '360 智脑' : '供应商'),
    },
    './TrialEmployeePicker': {},
    './TrialAnalyticsPanel': {},
    './Trial.css': {},
  };
  new Function('require', 'module', 'exports', output)(name => mocks[name] || {}, module, module.exports);
  return { ...module.exports, source };
}

test('测试员供应商状态兼容后端字段和旧单Key响应', () => {
  const portal = loadPortal();
  const current = portal.testerProviderStates(
    [
      { id: 'openlux', label: 'OpenLux', configured: true, maskedKey: 'sk-op••••1234' },
      { id: '360', label: '360智脑', configured: false, maskedKey: '' },
    ],
    'openlux',
  );
  assert.deepEqual(current, [
    { id: 'openlux', label: 'OpenLux', available: true, keyConfigured: true, keyMasked: 'sk-op••••1234' },
    { id: '360', label: '360智脑', available: true, keyConfigured: false, keyMasked: undefined },
  ]);
  assert.deepEqual(portal.testerProviderStates(undefined, '360', { keyConfigured: true, keyMasked: 'old••••key' }), [
    { id: '360', label: '360 智脑', available: true, keyConfigured: true, keyMasked: 'old••••key' },
  ]);
});

test('测试员先切供应商，保存和删除Key都明确携带供应商', () => {
  const source = loadPortal().source;
  assert.match(source, /trialRequest\('\/tester\/provider',[\s\S]{0,140}method: 'PUT',[\s\S]{0,140}provider: nextProvider/);
  assert.match(source, /trialRequest\('\/tester\/key',[\s\S]{0,180}method: 'PUT',[\s\S]{0,180}provider: activeProvider/);
  assert.match(source, /trialRequest\('\/tester\/key',[\s\S]{0,180}method: 'DELETE',[\s\S]{0,180}provider: activeProvider/);
  assert.match(source, /value=\{activeProvider\}/);
  assert.match(source, /options=\{providers\.map/);
});

test('邀请、客户、对话和平台记录显示各自供应商', () => {
  const portal = page('TesterPortal.tsx');
  const shared = page('TrialShared.tsx');
  const experience = page('TrialExperience.tsx');
  const analytics = page('TrialAnalyticsPanel.tsx');
  const platform = component('PlatformTesters.tsx');
  assert.match(portal, /体验供应商：\{trialProviderLabel\(item\.provider \|\| '360'\)\}/);
  assert.match(portal, /dataIndex: 'provider'/);
  assert.match(shared, /trialProviderLabel\(item\.provider \|\| '360'\).*成本：/s);
  // 旧记录没有 provider 字段：逐次调用回退到对话供应商，再回退到当时唯一的 360。
  assert.match(shared, /trialProviderLabel\(attempt\.provider \|\| item\.provider \|\| '360'\)/);
  assert.match(experience, /landing\.providerLabel/);
  assert.match(analytics, /dataIndex: 'provider'/);
  assert.match(platform, /title: '当前供应商'/);
  assert.match(platform, /testerProviderRows\(row\)/);
  assert.match(platform, /title: '供应商成本'/);
});

test('测试员费用和Key文案不再把所有记录写死为360', () => {
  const sources = [
    page('TesterPortal.tsx'),
    page('TesterApply.tsx'),
    page('TrialShared.tsx'),
    page('TrialAnalyticsPanel.tsx'),
    component('PlatformTesters.tsx'),
  ].join('\n');
  assert.doesNotMatch(sources, /自带 360 Key|我的 360 Key|360 成本|费用直接记在你的 360 账户|360 Key 已保存|解除 360 Key/);
  assert.match(page('TesterApply.tsx'), /OpenLux 或 360 智脑/);
  assert.match(page('TrialAnalyticsPanel.tsx'), /已核实供应商成本/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = requireWeb('typescript');
const jsx = (type, props) => ({ type, props });
const ant = new Proxy({}, { get: (_target, name) => name });
function loadComponent(file) {
  const source = fs.readFileSync(new URL(`../../web/src/components/${file}`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  const require = name => name === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : name === 'antd' ? ant : {};
  new Function('require', 'module', 'exports', output)(require, module, module.exports);
  return module.exports;
}
const media = loadComponent('MediaJobCard.tsx');
const sales = loadComponent('AiSalesVideoPanel.tsx');
function all(tree, predicate, result = []) {
  if (Array.isArray(tree)) { tree.forEach(child => all(child, predicate, result)); return result; }
  if (!tree || typeof tree !== 'object') return result;
  if (predicate(tree)) result.push(tree);
  all(tree.props?.children, predicate, result);
  return result;
}
const render = job => media.default({ job, selected: false, importing: false, onToggle() {}, onDelete() {}, onImport() {} });
const links = tree => all(tree, node => node.type === 'a').map(node => node.props.href);
const pending = { kind: 'video', technicalStatus: '成功', businessUsable: false, canImport: false, billing: { state: 'pending_reconciliation' }, previewUrl: '/api/content/media-jobs/7/preview', downloadUrl: '/api/content/media-jobs/7/download', downloadAvailable: true, canExport: true };

test('待核费用的真实产物，服务器明确授权后可预览及下载', () => {
  const tree = render(pending);
  assert.deepEqual(links(tree), ['/api/content/media-jobs/7/download']);
  assert.equal(all(tree, node => node.type === 'video')[0].props.src, '/api/content/media-jobs/7/preview');
});

test('下载必须同时具备两项服务器授权，不能借旧url绕过', () => {
  for (const overrides of [{ downloadAvailable: false }, { downloadAvailable: undefined }, { canExport: false }, { canExport: undefined }, { downloadUrl: null }]) {
    assert.deepEqual(links(render({ ...pending, url: 'https://provider.test/private.mp4', ...overrides })), []);
  }
});

test('授权下载仍拒绝脚本协议及协议相对URL', () => {
  for (const downloadUrl of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '//untrusted.test/video.mp4']) {
    assert.deepEqual(links(render({ ...pending, downloadUrl })), []);
  }
});

test('已验收旧任务仍可打开原文件，明确禁止导出的旧任务保持禁用', () => {
  const legacy = { businessUsable: true, url: 'https://provider.test/accepted.mp4' };
  assert.deepEqual(links(render(legacy)), [legacy.url]);
  assert.deepEqual(links(render({ ...legacy, canExport: false })), []);
});

test('单独下载授权不会开放人工验收入库或改变业务采用状态', () => {
  const job = structuredClone(pending);
  const tree = media.MediaImportAction({ job, onImport() {} });
  assert.equal(all(tree, node => node.type === 'Button')[0].props.disabled, true);
  assert.equal(job.businessUsable, false);
  assert.equal(job.billing.state, 'pending_reconciliation');
});

test('原生声音模型标签按当前任务实际模型展示，旧任务保留自己的版本', () => {
  assert.equal(sales.salesVideoNativeModelLabel({ model: 'alibaba/wan3.0-video' }), '万相 3.0');
  assert.equal(sales.salesVideoNativeModelLabel({ model: 'wan2.6-i2v' }), '万相 2.6');
  assert.equal(sales.salesVideoNativeModelLabel({ salesVideo: { model: 'wan2.6-i2v' } }), '万相 2.6');
  assert.equal(sales.salesVideoNativeModelLabel({}), '万相原生有声模型');
  assert.equal(sales.salesVideoNativeModelLabel({ model: 'another-native-video' }), 'another-native-video');
});

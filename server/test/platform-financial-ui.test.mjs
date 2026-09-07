import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';
const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = requireWeb('typescript');
function nodes(node, predicate, found = []) {
  if (Array.isArray(node)) node.forEach(child => nodes(child, predicate, found));
  else if (node && typeof node === 'object') {
    if (predicate(node)) found.push(node);
    nodes(node.props?.children, predicate, found);
  }
  return found;
}
function harness() {
  const states = [], refs = [], calls = [], dialogs = [];
  let stateCursor = 0, refCursor = 0;
  let post = () => Promise.reject(new Error('response lost'));
  const component = new Proxy({}, { get: (_, key) => key });
  const Form = Object.assign(() => {}, { Item: 'Form.Item', useForm: () => [{ resetFields() {}, setFieldsValue() {} }], useWatch: () => 'credits' });
  const Modal = Object.assign(() => {}, { confirm: options => { dialogs.push(options); return options; } });
  const exported = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../web/src/pages/Platform.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports: exported, crypto: { randomUUID }, require(name) {
    if (name === 'react') return {
      useState(initial) { const i = stateCursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
      useRef(initial) { const i = refCursor++; return refs[i] ||= { current: initial }; },
      useEffect() {}, useCallback: fn => fn,
    };
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
    if (name === 'react-router-dom') return { useNavigate: () => () => {} };
    if (name === 'antd') return new Proxy({ Form, Modal, message: { success() {}, warning() {} } }, { get: (target, key) => target[key] || key });
    if (name.includes('/api/client')) return { api: { get: url => Promise.resolve(url === '/platform/tenants' ? states[3] : url === '/platform/packages' ? states[5] : []), post: (url, body) => { calls.push({ url, body }); return post(url, body); } } };
    if (name.includes('/seatRequestModel')) return { planSeatDescription: () => '1主4副' };
    return component;
  } });
  const render = () => { stateCursor = 0; refCursor = 0; return exported.default(); };
  render();
  states[0] = '客户企业';
  states[3] = [{ id: 2, name: '隔离企业', status: '已开通' }];
  states[5] = [{ id: 7, name: '套餐', kind: 'plan', enabled: 1 }];
  return { calls, dialogs, states, render, setPost: fn => { post = fn; }, rowButtons() {
    const table = nodes(render(), node => node.type === 'Table')[0];
    return nodes(table.props.columns.find(column => column.title === '操作').render(null, states[3][0]), node => node.type === 'Button');
  }, planDialog() { return nodes(render(), node => node.type === Modal && node.props.okText === '确认开通')[0]; } };
}

test('直充确认实际返回pending；双击不重复POST，失败重试复用操作编号', async () => {
  const h = harness();
  h.rowButtons().find(button => button.props.children === '直充').props.onClick();
  const dialog = h.dialogs[0];
  dialog.content.props.onChange(100);
  let reject;
  h.setPost(() => new Promise((_resolve, fail) => { reject = fail; }));
  const pending = dialog.onOk();
  assert.equal(dialog.onOk(), pending);
  assert.equal(h.calls.length, 1);
  reject(new Error('response lost'));
  await assert.rejects(pending);
  h.setPost(() => Promise.reject(new Error('retry response lost')));
  await assert.rejects(dialog.onOk());
  assert.equal(h.calls[0].body.requestKey, h.calls[1].body.requestKey);
  dialog.content.props.onChange(200);
  await assert.rejects(dialog.onOk());
  assert.notEqual(h.calls[2].body.requestKey, h.calls[1].body.requestKey);
});

test('年度开通同套餐失败重试复用编号，改套餐形成新操作，成功后明确新开通才换编号', async () => {
  const h = harness();
  h.rowButtons().find(button => button.props.children === '开通年度套餐').props.onClick();
  await h.planDialog().props.onOk();
  await h.planDialog().props.onOk();
  assert.equal(h.calls[0].body.requestKey, h.calls[1].body.requestKey);
  const select = nodes(h.planDialog(), node => node.type === 'Select')[0];
  select.props.onChange(8);
  await h.planDialog().props.onOk();
  assert.notEqual(h.calls[2].body.requestKey, h.calls[1].body.requestKey);
  h.setPost(() => Promise.resolve({ name: '套餐', expiresAt: '2027-09-06' }));
  await h.planDialog().props.onOk();
  assert.equal(h.calls[3].body.requestKey, h.calls[2].body.requestKey);
  h.rowButtons().find(button => button.props.children === '开通年度套餐').props.onClick();
  await h.planDialog().props.onOk();
  assert.notEqual(h.calls[4].body.requestKey, h.calls[3].body.requestKey);
});

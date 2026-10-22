import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as copy from '../../web/src/components/personalApiBilling.js';
const ts = createRequire(new URL('../../web/package.json', import.meta.url))('typescript');
const source = fs.readFileSync(new URL('../../web/src/components/MediaJobCard.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', code)(name => name === './personalApiBilling.js' ? copy : {}, module, module.exports);
const { mediaBillingPresentation } = module.exports;
test('个人媒体账单只显示供应商费用，失败和未知费用不承诺退款或免费', () => {
  for (const state of ['held', 'settled', 'released', 'pending_reconciliation', 'missing']) {
    const billing = mediaBillingPresentation({ state, chargedCredits: 0, heldCredits: 800, note: '原平台预授权已退回，未扣费' }, true);
    assert.match(billing.label, /个人API/);
    assert.doesNotMatch(billing.label + billing.detail, /积分|预授权|未扣费|免费|800/);
  }
  assert.match(mediaBillingPresentation({ state: 'settled', costYuan: 0.5 }, true).label, /¥0\.5000/);
});
test('企业媒体账单保留原预授权和实扣文案，人工上传无需AI计费行为不变', () => {
  assert.match(mediaBillingPresentation({ state: 'held', heldCredits: 800 }).label, /预授权 800 分/);
  assert.match(mediaBillingPresentation({ state: 'settled', chargedCredits: 25 }).label, /已实扣 25 分/);
  assert.match(mediaBillingPresentation({ state: 'not_required', exempt: true, authoritative: true }, true).label, /人工上传/);
});

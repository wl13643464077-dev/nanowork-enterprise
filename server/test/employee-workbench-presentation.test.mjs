import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from '../../web/node_modules/typescript/lib/typescript.js';

const source = fs.readFileSync(new URL('../../web/src/components/EmployeeWorkbench.tsx', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function text(value:'), source.indexOf('const OPERATIONAL_STATUS_LABELS'));
const compiled = ts.transpileModule(helpers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const { runStatus, restaurantStatus, colors } = new Function(`${compiled}; return {runStatus, restaurantStatus, colors: RUN_STATUS_COLOR}`)();

test('工作台把人工不采纳与执行、质检失败区分，兼容权威key和历史标签', () => {
  const rejected = '未采纳（原稿已保留）';
  for (const status of [runStatus, restaurantStatus]) {
    assert.equal(status({ status: '已驳回', presentationKey: 'rejected' }), rejected);
    assert.equal(status({ displayStatus: '失败需返工（人工审阅未通过）' }), rejected);
    assert.equal(status({ status: '已驳回', contract: { valid: true } }), rejected);
    assert.equal(status({ status: '失败', aiMode: 'api' }), '失败需处理（执行异常）');
  }
  assert.equal(runStatus({ status: '失败', contract: { valid: false } }), '失败需返工（质检未通过）');
  assert.equal(restaurantStatus({ status: '失败', executionSnapshot: { outputContract: { valid: false } } }), '失败需返工（质检未通过）');
  assert.equal(colors[rejected], 'orange');
});

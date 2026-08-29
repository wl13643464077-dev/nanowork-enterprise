import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRestaurantTaskPollWarning,
  RESTAURANT_TASK_POLL_INTERVAL_MS,
  RESTAURANT_TASK_POLL_MAX_DELAY_MS,
  restaurantTaskPollRetryDelay,
} from '../../web/src/components/restaurantTaskPolling.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('餐饮长任务轮询失败按上限退避，恢复前不伪造终态', () => {
  assert.equal(RESTAURANT_TASK_POLL_INTERVAL_MS, 5_000);
  assert.equal(RESTAURANT_TASK_POLL_MAX_DELAY_MS, 30_000);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 99].map(restaurantTaskPollRetryDelay),
    [5_000, 10_000, 20_000, 30_000, 30_000, 30_000],
  );

  const warning = buildRestaurantTaskPollWarning(3);
  assert.equal(warning.kind, 'transport_warning');
  assert.equal(warning.terminal, false);
  assert.equal(warning.retryDelayMs, 20_000);
  assert.match(warning.detail, /保留上次确认的“生成中”状态/);
  assert.match(warning.detail, /不代表任务失败/);
  assert.match(warning.detail, /20 秒后自动重试/);
  assert.equal(Object.hasOwn(warning, 'status'), false);
  assert.equal(Object.hasOwn(warning, 'failed'), false);
});

test('餐饮长任务轮询UI明示同步异常并保持安全自动重试', () => {
  const source = read('web/src/components/EmployeeWorkbench.tsx');
  assert.match(source, /buildRestaurantTaskPollWarning/);
  assert.match(source, /restaurantPollWarning\.terminal === false/);
  assert.match(source, /role="status"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /schedulePoll\(warning\.retryDelayMs\)/);
  assert.doesNotMatch(
    source,
    /\/marshals\/tasks\/\$\{taskId\}\/status[\s\S]{0,500}\.catch\(\(\) => \{\}\)/,
  );
});

test('餐饮历史任务卡可直接打开并展示完整结果正文', () => {
  const source = read('web/src/components/EmployeeWorkbench.tsx');
  const types = read('web/src/api/employeeWorkbenchTypes.ts');
  assert.match(source, /查看完整结果/u);
  assert.match(source, /scrollToResult: true/u);
  assert.match(source, /id=\{restaurantResultId\}/u);
  assert.match(source, /岗位交付报告/u);
  // 正文由 output_body 经统一呈现层拆分：概览直接可读，其余分节可展开，
  // 导出仍使用同一份 fullMarkdown，避免页面与交付文件出现两套正文。
  assert.match(
    source,
    /restaurantOutputPresentation\(restaurantOutputBody, \{[\s\S]{0,160}\}\)/u,
  );
  assert.match(source, /restaurantOutputReport = restaurantReportView\.fullMarkdown/u);
  assert.match(
    source,
    /<Markdown content=\{localizeOperationalStatus\(restaurantReportView\.overviewMarkdown\)\} \/>/u,
  );
  assert.match(
    source,
    /content=\{localizeOperationalStatus\(restaurantReportView\.deliverablesMarkdown\)\}/u,
  );
  assert.match(source, /content=\{localizeOperationalStatus\(restaurantOutputReport\)\}/u);
  assert.match(types, /output_body\?: string \| null/u);
});

test('老板工作台从同一员工对象展示API、工具、handler与派活原绑定', () => {
  const source = read('web/src/components/EmployeeWorkbench.tsx');
  const types = read('web/src/api/employeeWorkbenchTypes.ts');
  assert.match(types, /runtimeBindings: EmployeeRuntimeBindings/u);
  assert.match(types, /currentRuntimeBindings\?: EmployeeRuntimeBindings/u);
  assert.match(types, /canViewRuntimeBindings\?: boolean/u);
  assert.match(source, /runtimeBindings: objectOrEmpty\(raw\.runtimeBindings\)/u);
  assert.match(source, /<ApiOutlined \/> API 与工具/u);
  assert.match(source, /实际执行 Handler/u);
  assert.match(source, /派活原 Handler/u);
  assert.match(source, /bindings\.currentRuntimeBindings \|\| bindings/u);
  assert.match(
    source,
    /profile\.permissions\.canViewRuntimeBindings === true \|\| profile\.permissions\.canViewJobProfile === true/u,
  );
  assert.match(source, /不会向前端下发 API Key、Token 或密码/u);
});

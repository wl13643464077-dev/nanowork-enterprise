import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { isPersonalApiUser, personalApiBillingLabel, PERSONAL_API_PRICING_NOTE } from '../../web/src/components/personalApiBilling.js';

const source = name => fs.readFileSync(new URL(`../../web/src/${name}`, import.meta.url), 'utf8');

test('个人计费依据账户类型，平台积分及未知金额不会变成供应商费用或退款承诺', () => {
  assert.equal(isPersonalApiUser({ role: 'sales', accountType: 'tester' }), true);
  assert.equal(isPersonalApiUser({ role: 'sales' }), false);
  assert.equal(isPersonalApiUser({ role: 'platform_super' }), false);
  assert.equal(isPersonalApiUser(null), false);
  for (const state of ['held', 'released', 'failed', 'cancelled', 'settled', 'pending_reconciliation']) {
    const copy = personalApiBillingLabel({ state, chargedCredits: 0, heldCredits: 999, costYuan: 0 });
    assert.match(copy, /个人API/);
    assert.doesNotMatch(copy, /积分|999|免费|退款|全退|未扣费|¥0\.0000/);
  }
  assert.match(personalApiBillingLabel({ state: 'settled', supplierCostCny: 0.26 }), /¥0\.2600/);
  assert.match(personalApiBillingLabel({ costYuan: 1.25 }), /¥1\.2500/);
  assert.match(personalApiBillingLabel({ state: 'pending_reconciliation', costYuan: 10 }), /待核对/);
  assert.doesNotMatch(personalApiBillingLabel({ costYuan: '0.26' }), /¥/);
  assert.match(PERSONAL_API_PRICING_NOTE, /你填写的 API Key/);
});

test('正式员工目录和工作台区分个人供应商计费与企业积分', () => {
  const employees = source('pages/Employees.tsx');
  assert.match(employees, /personalApi\s*\?\s*'个人API计费'\s*:/);
  assert.match(employees, /typicalCredits/);
  const overview = source('components/EmployeeVisualOverview.tsx');
  assert.match(overview, /personalApi\s*\?\s*PERSONAL_API_PRICING_NOTE/);
  const workbench = source('components/EmployeeWorkbench.tsx');
  assert.ok(workbench.includes('if (isPersonalApiUser(getUser())) return personalApiBillingLabel(billing)'));
  assert.match(workbench, /!personalApi && selectedRun\.billing\.chargedCredits/);
});

test('个人任务中心不挂载不支持的数字人服务，账单和流水线保留正确的个人文案', () => {
  const tasks = source('pages/TaskCenter.tsx');
  assert.match(tasks, /personalApi\s*\?\s*\(\s*<Alert[^>]*当前个人API暂不支持[^>]*\/?>\s*\)\s*:\s*\(?\s*<AvatarStudio/s);
  assert.match(tasks, /personalApi\s*\?\s*personalApiBillingLabel\(detail\.billing\)\s*:\s*detail\.billing\.label/);
  assert.match(tasks, /!personalApi \|\| !\/credits\/i\.test\(key\)/);
  const pipeline = source('components/ContentPipelineWorkbench.tsx');
  assert.match(pipeline, /canManage = personalApi \|\| MANAGE_ROLES\.has\(role\)/);
  assert.match(pipeline, /canConfigureApproval = personalApi \|\| contentPipelineCanConfigureApproval\(role\)/);
  assert.match(pipeline, /personalApi\s*\?\s*'配图与封面使用个人API计费'/);
});

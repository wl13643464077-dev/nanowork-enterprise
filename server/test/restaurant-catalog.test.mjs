import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRestaurantCatalog, parseEmployeeMarkdown, validateRestaurantCatalog } from '../src/catalog/restaurant.js';

test('餐饮员工目录包含8个分部与101-161共61名员工', () => {
  const catalog = loadRestaurantCatalog();
  assert.equal(catalog.groups.length, 8);
  assert.equal(catalog.employees.length, 61);
  assert.deepEqual(catalog.employees.map(employee => employee.idx), Array.from({ length: 61 }, (_, index) => 101 + index));
  assert.equal(new Set(catalog.employees.map(employee => employee.key)).size, 61);
  assert.ok(catalog.employees.every(employee => employee.inputs.length > 0));
  assert.ok(catalog.employees.every(employee => employee.steps.length > 0));
  assert.ok(catalog.employees.every(employee => employee.deliverables.length > 0));
});

test('历史 employee.md 标题别名可以修复缺失结构字段', () => {
  const parsed = parseEmployeeMarkdown(`
## 必须输入
- 门店名称
- 当前问题

## 分步工作流
1. 核对输入
2. 输出建议

## 交付成果
- 行动清单

## 外部动作与劳动边界
- 排班草案必须由有权限的管理者批准
`);
  assert.deepEqual(parsed, {
    inputs: ['门店名称', '当前问题'],
    steps: ['核对输入', '输出建议'],
    deliverables: ['行动清单'],
    qualityGates: [],
    safetyBoundaries: ['排班草案必须由有权限的管理者批准'],
  });
});

test('32-46号岗位不把手册引导语冒充必要输入或交付物', () => {
  const catalog = loadRestaurantCatalog();
  for (let idx = 132; idx <= 146; idx += 1) {
    const employee = catalog.employees.find(item => item.idx === idx);
    assert.ok(employee, `缺少员工${idx}`);
    assert.ok(employee.inputs.length >= 3, `员工${idx}必要输入过少`);
    assert.ok(employee.deliverables.length >= 3, `员工${idx}交付物过少`);
    assert.equal(
      employee.inputs.some(item => /^收集并标注缺失项[：:]?$/u.test(item)),
      false,
      `员工${idx}把“收集并标注缺失项”当成了输入`,
    );
    assert.equal(
      employee.deliverables.some(item => /^提供[：:]?$/u.test(item)),
      false,
      `员工${idx}把“提供”当成了交付物`,
    );
  }
});

test('目录结构缺员会被拒绝，不静默降级', () => {
  const catalog = loadRestaurantCatalog();
  assert.throws(
    () => validateRestaurantCatalog({ ...catalog, employees: catalog.employees.slice(0, -1) }),
    /必须包含61名员工/,
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DBP = path.join(os.tmpdir(), `nanowork-dispatch-policy-${process.pid}.db`);
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* 不存在 */ }
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
const {
  dispatchPolicy, saveDispatchPolicy, canDispatchEmployee, DISPATCHABLE_ROLES,
} = await import('../src/engines/employee-dispatch-policy.js');

initSchema();
migrateV2();

const boss = { id: 1, role: 'boss' };
const admin = { id: 2, role: 'admin' };
const sales = { id: 3, role: 'sales' };
const opsDirector = { id: 4, role: 'ops_director' };
const partner = { id: 5, role: 'partner' };
const foodSafety = { kind: 'restaurant', idx: 117, group: '食安与合规部' };
const marketing = { kind: 'restaurant', idx: 141, group: '品牌与增长部' };
const crewWriter = { kind: 'crew', idx: 3, group: '内容生产部' };

test('默认策略：全员可派活，与历史行为一致', () => {
  runWithTenant(1, () => {
    const policy = dispatchPolicy();
    assert.equal(policy.defaultAllow, true);
    assert.deepEqual(policy.groups, {});
    for (const user of [boss, admin, sales, opsDirector, partner]) {
      assert.equal(canDispatchEmployee(user, foodSafety), true, `${user.role} 默认应可派活`);
      assert.equal(canDispatchEmployee(user, crewWriter), true, `${user.role} 默认应可派内容员工`);
    }
    assert.equal(canDispatchEmployee(null, foodSafety), false, '未登录永远不可派活');
  });
});

test('分部级规则：排除的角色被拒，boss/admin 永不锁死', () => {
  runWithTenant(1, () => {
    saveDispatchPolicy({
      defaultAllow: true,
      groups: { '食安与合规部': { roles: ['boss', 'admin', 'ops_director'] } },
      employees: {},
    });
    assert.equal(canDispatchEmployee(sales, foodSafety), false, 'sales 被分部规则排除');
    assert.equal(canDispatchEmployee(partner, foodSafety), false, 'partner 被分部规则排除');
    assert.equal(canDispatchEmployee(opsDirector, foodSafety), true, 'ops_director 在白名单内');
    assert.equal(canDispatchEmployee(boss, foodSafety), true, 'boss 永远可派活');
    assert.equal(canDispatchEmployee(admin, foodSafety), true, 'admin 永远可派活');
    // 未配置的分部不受影响
    assert.equal(canDispatchEmployee(sales, marketing), true, '其他分部保持默认放行');
  });
});

test('员工级覆盖优先于分部级规则', () => {
  runWithTenant(1, () => {
    saveDispatchPolicy({
      defaultAllow: true,
      groups: { '品牌与增长部': { roles: ['boss', 'admin'] } },
      employees: { 'emp:141': { roles: ['boss', 'admin', 'sales'] } },
    });
    assert.equal(canDispatchEmployee(sales, marketing), true, '员工级白名单放行 sales');
    assert.equal(canDispatchEmployee(sales, { kind: 'restaurant', idx: 142, group: '品牌与增长部' }), false,
      '同分部其他员工仍按分部规则拒绝');
  });
});

test('内容员工 crew:idx 规则独立生效', () => {
  runWithTenant(1, () => {
    saveDispatchPolicy({
      defaultAllow: true,
      groups: {},
      employees: { 'crew:3': { roles: ['boss', 'admin', 'ops_director'] } },
    });
    assert.equal(canDispatchEmployee(sales, crewWriter), false, 'sales 不能给撰稿人派活');
    assert.equal(canDispatchEmployee(opsDirector, crewWriter), true);
    assert.equal(canDispatchEmployee(sales, { kind: 'crew', idx: 0, group: '内容生产部' }), true, '其余内容员工默认放行');
  });
});

test('策略校验：拒绝非法角色、非法员工标识与非法结构', () => {
  runWithTenant(1, () => {
    assert.throws(() => saveDispatchPolicy(null), /必须是对象/);
    assert.throws(() => saveDispatchPolicy({ employees: { 'emp:999': { roles: ['boss'] } } }), /不合法/);
    assert.throws(() => saveDispatchPolicy({ employees: { 'crew:12': { roles: ['boss'] } } }), /不合法/);
    assert.throws(() => saveDispatchPolicy({ groups: { '': { roles: ['boss'] } } }), /不合法/);
    // 未知角色被静默过滤而不是入库
    const saved = saveDispatchPolicy({ groups: { '门店运营部': { roles: ['boss', 'hacker'] } } });
    assert.deepEqual(saved.groups['门店运营部'].roles, ['boss']);
    assert.ok(DISPATCHABLE_ROLES.includes('sales'));
  });
});

test('租户隔离：A 租户的策略不影响 B 租户', () => {
  runWithTenant(1, () => {
    saveDispatchPolicy({ defaultAllow: true, groups: { '食安与合规部': { roles: ['boss'] } }, employees: {} });
  });
  runWithTenant(2, () => {
    assert.equal(canDispatchEmployee(sales, foodSafety), true, 'B 租户不受 A 租户策略影响');
  });
  runWithTenant(1, () => {
    assert.equal(canDispatchEmployee(sales, foodSafety), false, 'A 租户策略仍然生效');
  });
});

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DBP = path.join(os.tmpdir(), `nanowork-role-module-fallback-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}

process.env.NANOWORK_DB = DBP;

const {
  getConfig,
  initSchema,
  migrateV2,
  modulesFor,
  q,
  setTenantConfig,
} = await import('../src/db.js');

initSchema();
migrateV2();

q.run(`INSERT INTO users(username,password_hash,name,role,tenant_id)
  VALUES('module_ops','x','运营总监','ops_director',1)`);
q.run(`INSERT INTO users(username,password_hash,name,role,tenant_id)
  VALUES('module_manager','x','部门经理','manager',1)`);
for (const [username, name, dept] of [
  ['module_front_staff', '前厅员工', '前厅服务'],
  ['module_member_staff', '会员员工', '会员运营'],
  ['module_catering_staff', '团餐员工', '团餐销售'],
  ['module_content_staff', '内容员工', '内容生产部'],
  ['module_legacy_sales', '旧销售员工', '销售部'],
]) {
  q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id)
    VALUES(?,?,?,'sales',?,1)`, username, 'x', name, dept);
}

const ops = q.get(`SELECT id,role,tenant_id FROM users WHERE username='module_ops'`);
const manager = q.get(`SELECT id,role,tenant_id FROM users WHERE username='module_manager'`);
const frontStaff = q.get(`SELECT id,role,dept,tenant_id FROM users WHERE username='module_front_staff'`);

test('餐饮现用一线部门得到职责所需模块，默认不开放老板参谋或系统管理', () => {
  const byUsername = Object.fromEntries([
    'module_front_staff',
    'module_member_staff',
    'module_catering_staff',
    'module_content_staff',
    'module_legacy_sales',
  ].map(username => {
    const user = q.get('SELECT id,role,dept,tenant_id FROM users WHERE username=?', username);
    return [username, modulesFor(user)];
  }));

  for (const username of ['module_front_staff', 'module_member_staff', 'module_catering_staff', 'module_legacy_sales']) {
    assert.ok(byUsername[username].includes('growth'), `${username} 应能进入会员增长`);
    assert.ok(!byUsername[username].includes('advisor'), `${username} 不应进入老板参谋`);
    assert.ok(!byUsername[username].includes('system'), `${username} 不应进入系统管理`);
  }
  assert.ok(!byUsername.module_front_staff.includes('activities'), '前厅服务不默认承担活动策划权限');
  assert.ok(byUsername.module_member_staff.includes('activities'), '会员运营需要承接会员活动');
  assert.ok(byUsername.module_catering_staff.includes('activities'), '团餐销售需要承接团餐沙龙等活动');
  assert.ok(byUsername.module_content_staff.includes('content'), '内容生产部应能进入内容生产仓');
  assert.ok(!byUsername.module_content_staff.includes('advisor'));
  assert.ok(!byUsername.module_content_staff.includes('system'));
});

test('用户显式 modules 仍完整覆盖角色与部门结果，可收窄也可按授权扩展', () => {
  try {
    q.run('UPDATE users SET modules=? WHERE id=?', JSON.stringify(['execution']), frontStaff.id);
    assert.deepEqual(modulesFor(frontStaff), ['execution']);

    q.run('UPDATE users SET modules=? WHERE id=?',
      JSON.stringify(['dashboard', 'execution', 'growth', 'content']), frontStaff.id);
    assert.deepEqual(modulesFor(frontStaff), ['dashboard', 'execution', 'growth', 'content']);
  } finally {
    q.run('UPDATE users SET modules=NULL WHERE id=?', frontStaff.id);
  }
  assert.ok(modulesFor(frontStaff).includes('growth'), '清除用户覆盖后应恢复部门继承');
});

test('V5 迁移只补平台缺省部门，不覆盖既有键或租户显式部门矩阵', () => {
  const keys = ['dept_modules', 'dept_modules:1', 'role_modules_version'];
  const before = new Map(keys.map(key => [key, q.get('SELECT value FROM sys_config WHERE key=?', key)?.value]));
  try {
    q.run(`INSERT INTO sys_config(key,value) VALUES('dept_modules',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`, JSON.stringify({
      '销售部': ['growth'],
      '前厅服务': ['execution'],
      '自定义部门': ['assets'],
    }));
    q.run(`INSERT INTO sys_config(key,value) VALUES('dept_modules:1',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`, JSON.stringify({
      '前厅服务': ['content'],
    }));
    q.run(`INSERT INTO sys_config(key,value) VALUES('role_modules_version','4')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`);

    migrateV2();

    const platform = getConfig('dept_modules', {});
    assert.deepEqual(platform['前厅服务'], ['execution'], '平台已有同名键不得被迁移改写');
    assert.deepEqual(platform['自定义部门'], ['assets'], '平台自定义部门不得丢失');
    assert.deepEqual(platform['会员运营'], ['growth', 'activities']);
    assert.deepEqual(platform['团餐销售'], ['growth', 'activities']);
    assert.deepEqual(platform['内容生产部'], ['content']);
    assert.equal(getConfig('role_modules_version', 0), 5);

    const tenantExplicit = getConfig('dept_modules:1', {});
    assert.deepEqual(tenantExplicit, { '前厅服务': ['content'] }, '租户显式矩阵必须保持原样');
    assert.deepEqual(modulesFor(frontStaff), ['dashboard', 'execution', 'content'],
      '租户显式矩阵优先，不能暗中合并平台新增 growth');
  } finally {
    for (const key of keys) {
      const value = before.get(key);
      if (value === undefined) q.run('DELETE FROM sys_config WHERE key=?', key);
      else q.run(`INSERT INTO sys_config(key,value) VALUES(?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value);
    }
  }
});

test('manager 缺少独立角色模块配置时继承 ops_director', () => {
  assert.deepEqual(modulesFor(manager), modulesFor(ops));
  assert.ok(modulesFor(manager).includes('execution'));
  assert.ok(modulesFor(manager).includes('marshals'));
});

test('manager 的显式角色模块配置优先，不被 ops_director 回退覆盖', () => {
  setTenantConfig('role_modules', {
    ops_director: ['dashboard', 'execution', 'marshals'],
    manager: ['dashboard'],
  }, 1);
  assert.deepEqual(modulesFor(manager), ['dashboard']);

  setTenantConfig('role_modules', {
    ops_director: ['dashboard', 'execution', 'marshals'],
    manager: [],
  }, 1);
  assert.deepEqual(modulesFor(manager), []);
});

after(() => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

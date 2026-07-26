import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-marshal-customization-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const adminRoutes = (await import('../src/routes/admin.js')).default;
const marshalRoutes = (await import('../src/routes/marshals.js')).default;
const advisorRoutes = (await import('../src/routes/advisor.js')).default;
const dashboardRoutes = (await import('../src/routes/dashboard.js')).default;
const systemRoutes = (await import('../src/routes/system.js')).default;
const employeeRoutes = (await import('../src/routes/employees.js')).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,plan,credits) VALUES(1,'企业一','已开通','标准版',100000)
  ON CONFLICT(id) DO UPDATE SET status=excluded.status`);
q.run(`INSERT INTO tenants(id,name,status,plan,credits) VALUES(2,'企业二','已开通','标准版',100000)
  ON CONFLICT(id) DO UPDATE SET status=excluded.status`);

const boss1 = { id: 1, name: '老板一', role: 'boss', tenant_id: 1 };
const boss2 = { id: 2, name: '老板二', role: 'boss', tenant_id: 2 };
const target = q.get(`SELECT id,code,name FROM marshals WHERE code='M-03'`);
const currentCodes = Array.from({ length: 8 }, (_, index) => `M-${String(index + 1).padStart(2, '0')}`);
const baselineEmployees = q.all(`SELECT employee_idx,name,duty FROM specialists
  WHERE marshal_id=? AND employee_idx BETWEEN 101 AND 160 ORDER BY employee_idx`, target.id);
const baselineSpecialistNames = baselineEmployees.map(item => item.name);
const legacyEmployeeId = q.run(`INSERT INTO specialists(marshal_id,name,duty,status)
  VALUES(?,?,?,'空闲')`, target.id, '历史旧专员（不得暴露）', '旧目录遗留记录').lastInsertRowid;

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => { req.user = user; next(); }));
  app.use('/admin', adminRoutes);
  app.use('/marshals', marshalRoutes);
  app.use('/advisor', advisorRoutes);
  app.use('/dashboard', dashboardRoutes);
  app.use('/system', systemRoutes);
  app.use('/employees', employeeRoutes);
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('restaurant目录忽略旧版员工重匹配参数，但保留分部级租户覆盖', async () => {
  await withServer(boss1, async base => {
    const [current, permissions] = await Promise.all([
      fetch(`${base}/admin/marshals`).then(response => response.json()),
      fetch(`${base}/admin/permissions`).then(response => response.json()),
    ]);
    assert.deepEqual(current.map(item => item.code), currentCodes);
    assert.equal(permissions.modules.find(item => item.key === 'advisor').name, '老板参谋');
    assert.equal(permissions.modules.find(item => item.key === 'content').name, '内容生产仓');
    const before = current.find(item => item.id === target.id);
    assert.deepEqual(before.specialists.map(item => item.employee_idx), [116, 117, 118, 119, 120, 121, 122, 123, 124]);
    assert.deepEqual(before.specialists.map(item => item.name), baselineSpecialistNames);

    const saved = await fetch(`${base}/admin/marshals/${target.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '本地品牌增长部',
        title: '门店品牌与获客',
        duty: '负责本地品牌表达、门店活动、获客渠道与真实转化复盘',
        skills: '品牌内容,门店活动,渠道分析,增长实验',
        specialists: before.specialists.map(item => ({ ...item, name: `不应写入-${item.employee_idx}`, duty: '不应覆盖权威职责' })),
        rematch_specialists: true,
      }),
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.catalogManaged, true);
    assert.equal(savedBody.ignoredLegacySpecialistParameters, true);
    assert.match(savedBody.hint, /权威60人目录/);

    const [list, detail, capability, shortcuts] = await Promise.all([
      fetch(`${base}/marshals`).then(response => response.json()),
      fetch(`${base}/marshals/${target.id}`).then(response => response.json()),
      fetch(`${base}/advisor/capability`).then(response => response.json()),
      fetch(`${base}/dashboard/marshal-shortcuts`).then(response => response.json()),
    ]);

    for (const row of [
      list.find(item => item.code === 'M-03'), detail,
      capability.networkStatus.find(item => item.code === 'M-03'),
      shortcuts.find(item => item.code === 'M-03'),
    ]) assert.equal(row.name, '本地品牌增长部');

    assert.deepEqual(detail.specialists.map(item => item.name), baselineSpecialistNames);
    assert.deepEqual(detail.specialists.map(item => item.duty), baselineEmployees.map(item => item.duty));
    assert.equal(q.get(`SELECT COUNT(*) n FROM tenant_marshal_overrides WHERE tenant_id=1 AND marshal_code='M-03'`).n, 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM tenant_specialist_overrides WHERE tenant_id=1`).n, 0);
  });
});

test('保存restaurant分部覆盖后再次迁移仍可安全启动且不会生成旧版员工覆盖', () => {
  assert.doesNotThrow(() => migrateV2());
  assert.equal(q.get(`SELECT COUNT(*) n FROM tenant_marshal_overrides WHERE tenant_id=1 AND marshal_code='M-03'`).n, 1);
  assert.equal(q.get(`SELECT COUNT(*) n FROM tenant_specialist_overrides WHERE tenant_id=1`).n, 0);
});

test('/employees只读取当前8分部101-160权威目录并忽略历史员工覆盖', async () => {
  const authority = q.get(`SELECT id,marshal_id,name,duty FROM specialists WHERE employee_idx=101`);
  const moved = q.get(`SELECT id,marshal_id FROM specialists WHERE employee_idx=160`);
  const legacyDepartmentId = q.run(`INSERT INTO marshals(code,name,title,online,sort)
    VALUES('M-09','历史分部','不得对外展示',1,99)`).lastInsertRowid;
  const outOfRangeId = q.run(`INSERT INTO specialists(marshal_id,name,duty,status,employee_idx,key,person,group_name,sort)
    VALUES(?,?,?,'空闲',999,'legacy-999','旧员工','历史分部',999)`, target.id, '越界员工', '不得对外展示').lastInsertRowid;
  q.run(`INSERT INTO tenant_specialist_overrides(tenant_id,specialist_id,name,duty,active)
    VALUES(1,?,?,?,1)`, authority.id, '租户伪造员工名', '不得覆盖权威职责');
  q.run(`UPDATE specialists SET marshal_id=? WHERE id=?`, legacyDepartmentId, moved.id);

  try {
    await withServer(boss1, async base => {
      const directory = await fetch(`${base}/employees`).then(response => response.json());
      assert.equal(directory.total, 59);
      assert.ok(directory.employees.every(employee => employee.idx >= 101 && employee.idx <= 160));
      assert.ok(!directory.employees.some(employee => employee.idx === 160 || employee.idx === 999));
      const employee101 = directory.employees.find(employee => employee.idx === 101);
      assert.equal(employee101.name, authority.name);
      assert.equal(employee101.duty, authority.duty);
      assert.equal((await fetch(`${base}/employees/160`)).status, 404);
      assert.equal((await fetch(`${base}/employees/999`)).status, 404);
    });
  } finally {
    q.run(`UPDATE specialists SET marshal_id=? WHERE id=?`, moved.marshal_id, moved.id);
    q.run(`DELETE FROM tenant_specialist_overrides WHERE tenant_id=? AND specialist_id=?`, 1, authority.id);
    q.run(`DELETE FROM specialists WHERE id=?`, outOfRangeId);
    q.run(`DELETE FROM marshals WHERE id=?`, legacyDepartmentId);
  }

  await withServer(boss1, async base => {
    const restored = await fetch(`${base}/employees`).then(response => response.json());
    assert.equal(restored.total, 60);
    assert.deepEqual(restored.employees.map(employee => employee.idx).sort((a, b) => a - b),
      Array.from({ length: 60 }, (_, index) => index + 101));
  });
});

test('系统命名入口只允许权威8分部，并可恢复目录名称', async () => {
  await withServer(boss1, async base => {
    const naming = await fetch(`${base}/system/marshal-naming`).then(response => response.json());
    assert.deepEqual(naming.map(item => item.code), currentCodes);
    assert.equal(naming.find(item => item.code === 'M-03').current, '本地品牌增长部');
    assert.ok(naming.every(item => /权威餐饮目录分部/.test(item.reason)));

    const rejected = await fetch(`${base}/system/marshal-naming/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codes: ['M-09'] }),
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /8个分部/);

    const applied = await fetch(`${base}/system/marshal-naming/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codes: ['M-03'] }),
    }).then(response => response.json());
    assert.deepEqual(applied.applied, [{ code: 'M-03', name: '食安与合规部' }]);
  });
});

test('对外员工接口只暴露当前在线8分部、60名数字员工与3个核心分部', async () => {
  await withServer(boss1, async base => {
    const [list, overview, core, departments, employees] = await Promise.all([
      fetch(`${base}/marshals`).then(response => response.json()),
      fetch(`${base}/marshals/overview`).then(response => response.json()),
      fetch(`${base}/marshals/drill/core`).then(response => response.json()),
      fetch(`${base}/marshals/drill/marshals`).then(response => response.json()),
      fetch(`${base}/marshals/drill/specialists`).then(response => response.json()),
    ]);
    assert.deepEqual(list.map(item => item.code), currentCodes);
    assert.deepEqual({ marshals: overview.marshals, specialists: overview.specialists, core: overview.core },
      { marshals: 8, specialists: 60, core: 3 });
    assert.deepEqual(core.rows.map(item => item.code), ['M-01', 'M-02', 'M-06']);
    assert.doesNotMatch(JSON.stringify(core), /元帅|专员|M-10/);
    assert.equal(departments.rows.reduce((total, item) => total + item.specialists, 0), 60);
    assert.equal(employees.rows.length, 60);
    assert.ok(!JSON.stringify(employees).includes('历史旧专员'));

    const legacyEmployee = await fetch(`${base}/marshals/${target.id}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '旧员工边界验证', specialistId: legacyEmployeeId }),
    });
    assert.equal(legacyEmployee.status, 400);
    assert.match((await legacyEmployee.json()).error, /指定数字员工/);

    const tooMany = await fetch(`${base}/marshals/${target.id}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '协同上限验证', collabMarshals: ['M-01', 'M-02', 'M-04', 'M-05', 'M-06', 'M-07', 'M-08', 'M-09'] }),
    });
    assert.equal(tooMany.status, 400);
    assert.match((await tooMany.json()).error, /不能超过7个/);

    const m08 = q.get(`SELECT id FROM marshals WHERE code='M-08'`);
    const disabled = await fetch(`${base}/admin/marshals/${m08.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ online: false }),
    });
    assert.equal(disabled.status, 200);
    const onlineList = await fetch(`${base}/marshals`).then(response => response.json());
    assert.deepEqual(onlineList.map(item => item.code), currentCodes.slice(0, 7));
    assert.equal((await fetch(`${base}/marshals/${m08.id}`)).status, 404);
    const offlineCollaborator = await fetch(`${base}/marshals/${target.id}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '下线分部验证', collabMarshals: ['M-08'] }),
    });
    assert.equal(offlineCollaborator.status, 400);
    assert.match((await offlineCollaborator.json()).error, /已下线/);

    const restored = await fetch(`${base}/admin/marshals/${m08.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ online: true }),
    });
    assert.equal(restored.status, 200);
  });
});

test('分部与数字员工覆盖仅影响当前企业', async () => {
  await withServer(boss2, async base => {
    const detail = await fetch(`${base}/marshals/${target.id}`).then(response => response.json());
    assert.equal(detail.name, target.name);
    assert.deepEqual(detail.specialists.map(item => item.name), baselineSpecialistNames);
  });
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

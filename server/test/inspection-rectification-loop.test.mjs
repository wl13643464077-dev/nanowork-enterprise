import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-inspection-rectification-${process.pid}.db`);
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const {
  INSPECTION_EMPLOYEE_IDX,
  recordInspectionFromTask,
  inspectionSummary,
  createInspectionRectification,
  recheckInspectionRectification,
} = await import('../src/engines/store-inspections.js');
const executionRoutes = (await import('../src/routes/execution.js')).default;

initSchema();
migrateV2();

// 创建两个独立租户及用户，验证完整闭环与跨租户隔离
q.run(`INSERT OR IGNORE INTO tenants(id, name, status) VALUES(1, '食安测试餐饮A', '启用')`);
q.run(`INSERT OR IGNORE INTO tenants(id, name, status) VALUES(2, '跨租户餐饮B', '启用')`);
q.run(`INSERT INTO stores(tenant_id, name, is_default, biz_type, status) VALUES(1, '中山路店', 1, '快餐', '营业中')`);
const store1 = q.get(`SELECT id FROM stores WHERE tenant_id=1 AND name='中山路店'`);

const bossRes = q.run(
  `INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`,
  'boss_insp',
  hashPassword('12345678'),
  '张老板',
  'boss',
  '决策层',
);
const managerRes = q.run(
  `INSERT INTO users(username,password_hash,name,role,dept,store_id,tenant_id) VALUES(?,?,?,?,?,?,1)`,
  'mgr_insp',
  hashPassword('12345678'),
  '李店长',
  'manager',
  '门店运营',
  store1.id,
);
const salesRes = q.run(
  `INSERT INTO users(username,password_hash,name,role,dept,store_id,tenant_id) VALUES(?,?,?,?,?,?,1)`,
  'staff_insp',
  hashPassword('12345678'),
  '王店员',
  'sales',
  '前厅',
  store1.id,
);
const tenant2BossRes = q.run(
  `INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,2)`,
  'boss_t2',
  hashPassword('12345678'),
  'B租户老板',
  'boss',
  '决策层',
);

const BOSS_T1 = { id: Number(bossRes.lastInsertRowid), name: '张老板', role: 'boss', tenant_id: 1 };
const MANAGER_T1 = { id: Number(managerRes.lastInsertRowid), name: '李店长', role: 'manager', store_id: store1.id, tenant_id: 1 };
const SALES_T1 = { id: Number(salesRes.lastInsertRowid), name: '王店员', role: 'sales', store_id: store1.id, tenant_id: 1 };
const BOSS_T2 = { id: Number(tenant2BossRes.lastInsertRowid), name: 'B租户老板', role: 'boss', tenant_id: 2 };

const INSPECTION_REPORT = [
  '# 中山路店巡店报告',
  '',
  '```nanowork-inspection',
  JSON.stringify({
    store: '中山路店',
    inspectionType: '飞行检查',
    score: 76.5,
    subScores: { foodSafety: 13, product: 17, service: 16, hygiene: 14, display: 16.5 },
    issues: [
      {
        board: '食品安全',
        severity: '高',
        problem: '凉菜档口生熟砧板混放且温度计缺失',
        evidence: '后厨照片 #1',
        action: '立即色标分砧板并补装食品温度计',
        deadline: '当日完成',
      },
      {
        board: '环境卫生',
        severity: '中',
        problem: '明档玻璃门有油渍未及时擦拭',
        evidence: '前厅照片 #2',
        action: '建立餐后 30 分钟擦拭打卡',
        deadline: '2日内',
      },
    ],
    rectified: null,
  }),
  '```',
].join('\n');

function seedAgentTask(taskId, tenantId, createdBy) {
  q.run(`INSERT INTO marshals(code,name,online,sort) VALUES('M-05','门店运营部',1,5) ON CONFLICT(code) DO NOTHING`);
  const marshalId = q.get(`SELECT id FROM marshals WHERE code='M-05'`).id;
  q.run(
    `INSERT OR IGNORE INTO specialists(marshal_id,name,duty,status,employee_idx,key,person,group_name,sort)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    marshalId,
    '巡店督导',
    '巡店',
    '空闲',
    INSPECTION_EMPLOYEE_IDX,
    '61-store-inspection-supervisor',
    '查巡巡',
    '门店运营部',
    60,
  );
  const specialistId = q.get(`SELECT id FROM specialists WHERE employee_idx=?`, INSPECTION_EMPLOYEE_IDX).id;
  q.run(
    `INSERT INTO agent_tasks(id,marshal_id,specialist_id,title,type,status,tenant_id,created_by)
     VALUES(?,?,?,?,?,?,?,?)`,
    taskId,
    marshalId,
    specialistId,
    `巡店任务#${taskId}`,
    '检查清单',
    '待审阅',
    tenantId,
    createdBy,
  );
}

function makeApp(user, tenantId) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) =>
    runWithTenant(tenantId, () => {
      req.user = user;
      next();
    }),
  );
  app.use('/api/execution', executionRoutes);
  return app;
}

async function withServer(user, tenantId, fn) {
  const server = makeApp(user, tenantId).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('R-02 督导巡店「查 → 改 → 复检」完整台账闭环与跨租户隔离', async () => {
  let inspectionId;
  let rect1Id;
  let rect1TaskId;
  let rect2Id;

  // 1. 归档 #161 巡店记录
  runWithTenant(1, () => {
    seedAgentTask(8101, 1, BOSS_T1.id);
    const archived = recordInspectionFromTask({
      tenantId: 1,
      taskId: 8101,
      userId: BOSS_T1.id,
      userName: '督导查巡巡',
      text: INSPECTION_REPORT,
    });
    assert.equal(archived.recorded, true);
    assert.equal(archived.issues, 2);

    const summaryBefore = inspectionSummary(1, { months: 3 });
    assert.deepEqual(summaryBefore.rectificationStats, {
      totalIssues: 2,
      created: 0,
      closed: 0,
      pending: 2,
      closureRate: 0,
    });
  });

  // 2. 列出巡店记录与问题项（店长也可看到本店巡店）
  await withServer(MANAGER_T1, 1, async base => {
    const res = await fetch(`${base}/api/execution/inspections`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.items.length, 1);
    assert.equal(data.stats.totalInspections, 1);
    assert.equal(data.stats.totalIssues, 2);
    assert.equal(data.stats.highIssues, 1);
    assert.equal(data.stats.highPending, 1);
    assert.equal(data.stats.closureRate, 0);
    inspectionId = data.items[0].id;
    assert.equal(data.items[0].issues.length, 2);
    assert.equal(data.items[0].issues[0].rectification, null);
  });

  // 3. 普通员工无权发起整改单
  await withServer(SALES_T1, 1, async base => {
    const forbidden = await fetch(`${base}/api/execution/inspections/${inspectionId}/rectify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueIndex: 0 }),
    });
    assert.equal(forbidden.status, 403);
  });

  // 4. 老板一键将高危问题转为整改任务，核对 tasks 表真实建单与幂等防重
  await withServer(BOSS_T1, 1, async base => {
    const res = await fetch(`${base}/api/execution/inspections/${inspectionId}/rectify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        issueIndex: 0,
        assigneeId: MANAGER_T1.id,
        dueDate: '2026-12-01',
        actionPlan: '立即更换色标砧板并加装数显温度计拍照回传',
      }),
    });
    assert.equal(res.status, 201);
    const rect = await res.json();
    rect1Id = rect.id;
    rect1TaskId = rect.taskId;
    assert.equal(rect.status, 'in_progress');
    assert.equal(rect.assigneeId, MANAGER_T1.id);
    assert.equal(rect.assigneeName, '李店长');
    assert.ok(rect1TaskId > 0);

    // 核对 tasks 表真实写入
    const taskRow = q.get(`SELECT * FROM tasks WHERE tenant_id = 1 AND id = ?`, rect1TaskId);
    assert.ok(taskRow, 'tasks 表必须真实生成整改任务');
    assert.ok(taskRow.title.startsWith('【巡店整改·中山路店】'));
    assert.equal(taskRow.priority, '高');
    assert.equal(taskRow.status, '进行中');
    assert.equal(Number(taskRow.assignee_id), MANAGER_T1.id);
    assert.equal(Number(taskRow.store_id), store1.id);
    assert.equal(taskRow.due_at, '2026-12-01');
    assert.equal(taskRow.source, '巡店整改');

    // 重复派发同一问题 -> 409 幂等拦截
    const dup = await fetch(`${base}/api/execution/inspections/${inspectionId}/rectify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueIndex: 0, assigneeId: MANAGER_T1.id }),
    });
    assert.equal(dup.status, 409);
    const dupBody = await dup.json();
    assert.equal(dupBody.rectification?.id, rect1Id);
  });

  // 5. 复检退回重改 -> 保持 in_progress，tasks 保持进行中；再提交复检通过 -> closed + tasks 变已完成
  await withServer(BOSS_T1, 1, async base => {
    const rejectRes = await fetch(`${base}/api/execution/inspections/rectifications/${rect1Id}/recheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passed: false, recheckNote: '温度计未见校准标签，请补拍' }),
    });
    assert.equal(rejectRes.status, 200);
    const rejected = await rejectRes.json();
    assert.equal(rejected.status, 'in_progress');
    assert.equal(rejected.recheckNote, '温度计未见校准标签，请补拍');
    assert.equal(q.get(`SELECT status FROM tasks WHERE tenant_id=1 AND id=?`, rect1TaskId).status, '进行中');

    const passRes = await fetch(`${base}/api/execution/inspections/rectifications/${rect1Id}/recheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passed: true, recheckNote: '现场复检合格，色标砧板与温度计已到位' }),
    });
    assert.equal(passRes.status, 200);
    const closed = await passRes.json();
    assert.equal(closed.status, 'closed');
    assert.equal(closed.recheckBy, '张老板');
    assert.ok(closed.recheckAt);

    const taskAfter = q.get(`SELECT status, done_at FROM tasks WHERE tenant_id=1 AND id=?`, rect1TaskId);
    assert.equal(taskAfter.status, '已完成');
    assert.ok(taskAfter.done_at);
  });

  // 6. 验证 inspectionSummary().rectificationStats 真实提升至 50%
  runWithTenant(1, () => {
    const summaryMid = inspectionSummary(1, { months: 3 });
    assert.deepEqual(summaryMid.rectificationStats, {
      totalIssues: 2,
      created: 1,
      closed: 1,
      pending: 1,
      closureRate: 50,
    });
  });

  // 7. 第二条中危问题派发并复检闭环 -> 闭环率提升至 100%
  await withServer(BOSS_T1, 1, async base => {
    const res2 = await fetch(`${base}/api/execution/inspections/${inspectionId}/rectify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueIndex: 1, assigneeId: SALES_T1.id, dueDate: '2026-12-03' }),
    });
    assert.equal(res2.status, 201);
    const rect2 = await res2.json();
    rect2Id = rect2.id;
    const task2 = q.get(`SELECT priority, status FROM tasks WHERE tenant_id=1 AND id=?`, rect2.taskId);
    assert.equal(task2.priority, '中');
    assert.equal(task2.status, '进行中');

    const close2 = await fetch(`${base}/api/execution/inspections/rectifications/${rect2Id}/recheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passed: true, recheckNote: '明档玻璃洁净' }),
    });
    assert.equal(close2.status, 200);
  });

  runWithTenant(1, () => {
    const summaryDone = inspectionSummary(1, { months: 3 });
    assert.deepEqual(summaryDone.rectificationStats, {
      totalIssues: 2,
      created: 2,
      closed: 2,
      pending: 0,
      closureRate: 100,
    });
  });

  // 8. 跨租户访问严密拒绝（路由层 + 引擎层双重验证）
  await withServer(BOSS_T2, 2, async base => {
    const listT2 = await fetch(`${base}/api/execution/inspections`).then(r => r.json());
    assert.equal(listT2.items.length, 0);
    assert.equal(listT2.stats.totalInspections, 0);

    const crossRectify = await fetch(`${base}/api/execution/inspections/${inspectionId}/rectify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueIndex: 0 }),
    });
    assert.equal(crossRectify.status, 404);

    const crossRecheck = await fetch(`${base}/api/execution/inspections/rectifications/${rect1Id}/recheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passed: false, recheckNote: '越权篡改' }),
    });
    assert.equal(crossRecheck.status, 404);
  });

  assert.throws(
    () => createInspectionRectification({ tenantId: 2, inspectionId, issueIndex: 0, actor: BOSS_T2 }),
    err => err.status === 404,
  );
  assert.throws(
    () => recheckInspectionRectification({ tenantId: 2, rectId: rect1Id, passed: false, actor: BOSS_T2 }),
    err => err.status === 404,
  );
});

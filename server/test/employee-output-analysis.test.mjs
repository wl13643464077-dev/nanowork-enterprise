import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-output-analysis-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.SEED_DEMO = 'false';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const outputRoutes = (await import('../src/routes/employee-outputs.js')).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();

// 与经营工具模块的正式迁移字段保持一致；IF NOT EXISTS 兼容两组测试的加载顺序。
db.exec(`CREATE TABLE IF NOT EXISTS tool_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  tool_key TEXT NOT NULL,
  tool_title TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  employee_idx INTEGER,
  employee_name TEXT,
  specialist_id INTEGER,
  created_by INTEGER NOT NULL,
  input_json TEXT DEFAULT '{}',
  input_summary TEXT,
  result_md TEXT,
  assumptions_json TEXT DEFAULT '[]',
  evidence_json TEXT DEFAULT '[]',
  provenance_json TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
);`);

q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,?)`, 'output-boss-a', 'x', 'A店老板', 'boss', '老板办', 1);
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,?)`, 'output-boss-b', 'x', 'B店老板', 'boss', '老板办', 2);
const bossA = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='output-boss-a'`);
const bossB = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='output-boss-b'`);
const employee = q.get(`SELECT id,marshal_id,employee_idx,name,group_name FROM specialists WHERE employee_idx=101`);
assert.ok(employee);

let taskA;
let taskB;
runWithTenant(1, () => {
  const output = q.run(`INSERT INTO contents(type,title,body,status,creator_id,marshal_id,created_at) VALUES(?,?,?,?,?,?,?)`,
    '员工产出', 'A店任务产出', '这是A店可追溯的运行产出。', '待审核', bossA.id, employee.marshal_id, '2026-07-20 10:01:00').lastInsertRowid;
  taskA = q.run(`INSERT INTO agent_tasks(marshal_id,specialist_id,title,type,requirement,status,output_id,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`, employee.marshal_id, employee.id, 'A店菜单复盘', '常规', '核对菜单表现', '待审阅', output, bossA.id, '2026-07-20 10:00:00').lastInsertRowid;
});
runWithTenant(2, () => {
  taskB = q.run(`INSERT INTO agent_tasks(marshal_id,specialist_id,title,type,requirement,status,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?)`, employee.marshal_id, employee.id, 'B店私有任务', '常规', '不得跨租户看到', '执行中', bossB.id, '2026-07-20 11:00:00').lastInsertRowid;
});

db.prepare(`INSERT INTO tool_runs(
  tenant_id,tool_key,tool_title,title,status,employee_idx,employee_name,specialist_id,created_by,
  input_json,input_summary,result_md,assumptions_json,evidence_json,provenance_json,created_at,updated_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  1, 'hot', '今日必发', '午市上新内容', 'done', 101, employee.name, employee.id, bossA.id,
  JSON.stringify({ topic: '午市新品' }), '主题：午市新品', '## 工具结果\n\n待老板确认后发布。',
  JSON.stringify(['未接入真实平台曝光']), JSON.stringify([]), JSON.stringify({ engine: 'template', persisted: true }),
  '2026-07-21 09:00:00', '2026-07-21 09:00:01',
);

const soloSnapshotA = {
  schemaVersion: 'content-employee-run-snapshot.v1',
  profileVersion: 'content-0-r3',
  promptHash: 'prompt-hash-a',
  messageMode: 'single_user',
  employee: { idx: 0, key: 'trend', name: '趋势官', group: '热点雷达部' },
  capabilities: [
    { name: '热榜扫描', desc: '扫描授权渠道热点', required: true, enabled: true, locked: true },
  ],
  coreSkill: [
    { title: '热点判断', source: 'Paihuo内容员工出厂岗位 Skill', required: true, locked: true },
  ],
  historicalSkills: [
    { title: '旧平台趋势卡', source: 'Paihuo历史技能快照', verificationStatus: 'legacy_unverified' },
  ],
  customSkills: [
    { title: 'A店节气菜品', source: 'A店自定义', enabled: true },
  ],
  workMethod: {
    approval: { code: 'boss_review', description: '老板审核后才能发布' },
    handoff: { target: '文案部' },
  },
  workConfig: {
    factory: { common: { outputLength: 'std' } },
    effective: { outputLength: 'full', approvalMode: '老板审核' },
  },
  jobProfile: {
    duty: '提供热点候选，不直接对外发布',
    boundaries: ['对外发布必须由有权限的人类审批。'],
  },
  dispatch: { title: 'A店夏日菜单趋势', type: '分析建议', requirement: '结合门店素材给出候选选题' },
  provenance: {
    contentCatalog: { referencePath: 'server/catalog/restaurant-content.json', schemaVersion: 'v1' },
    historicalSkills: { snapshot: { sha256: 'skills-hash-a' } },
  },
};

function insertSoloRun({
  tenantId,
  employeeIdx,
  employeeKey,
  employeeName,
  employeeGroup,
  title,
  status,
  resultMd,
  createdBy,
  createdAt,
  snapshot,
}) {
  return Number(db.prepare(`INSERT INTO content_employee_runs(
    tenant_id,employee_idx,employee_key,employee_name,employee_group,
    title,type,requirement,due_at,status,result_md,ai_mode,model,
    profile_version,prompt_hash,snapshot_json,created_by,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    tenantId, employeeIdx, employeeKey, employeeName, employeeGroup,
    title, '分析建议', `输入：${title}`, '2026-07-31 18:00:00', status, resultMd,
    resultMd ? 'template' : (status === '失败' ? 'failed' : null),
    resultMd ? 'template' : null,
    snapshot.profileVersion, snapshot.promptHash, JSON.stringify(snapshot),
    createdBy, createdAt, createdAt,
  ).lastInsertRowid);
}

const soloReadyA = insertSoloRun({
  tenantId: 1,
  employeeIdx: 0,
  employeeKey: 'trend',
  employeeName: '趋势官',
  employeeGroup: '热点雷达部',
  title: 'A店夏日菜单趋势',
  status: '待审阅',
  resultMd: '# 待审阅结果\n\n三个候选选题，发布前由老板审核。',
  createdBy: bossA.id,
  createdAt: '2026-07-22 09:00:00',
  snapshot: soloSnapshotA,
});
const soloRunningA = insertSoloRun({
  tenantId: 1,
  employeeIdx: 1,
  employeeKey: 'research',
  employeeName: '资料官',
  employeeGroup: '热点雷达部',
  title: 'A店平台规则核验',
  status: '生成中',
  resultMd: null,
  createdBy: bossA.id,
  createdAt: '2026-07-23 09:00:00',
  snapshot: { ...soloSnapshotA, profileVersion: 'content-1-r0', promptHash: 'prompt-hash-running' },
});
const soloFailedA = insertSoloRun({
  tenantId: 1,
  employeeIdx: 2,
  employeeKey: 'planner',
  employeeName: '策划官',
  employeeGroup: '内容策划部',
  title: 'A店月度选题规划',
  status: '失败',
  resultMd: null,
  createdBy: bossA.id,
  createdAt: '2026-07-24 09:00:00',
  snapshot: { ...soloSnapshotA, profileVersion: 'content-2-r0', promptHash: 'prompt-hash-failed' },
});
const soloPrivateB = insertSoloRun({
  tenantId: 2,
  employeeIdx: 0,
  employeeKey: 'trend',
  employeeName: '趋势官',
  employeeGroup: 'B店私有内容部',
  title: 'B店私有趋势任务',
  status: '待审阅',
  resultMd: '# B店私有结果\n\nA店不得读取。',
  createdBy: bossB.id,
  createdAt: '2026-07-22 10:00:00',
  snapshot: { ...soloSnapshotA, profileVersion: 'content-0-r8', promptHash: 'prompt-hash-b-secret' },
});

function appFor(user) {
  const app = express();
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => { req.user = user; next(); }));
  app.use('/employee-outputs', outputRoutes);
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('统一聚合数字员工任务、经营工具与内容员工单独派活，并按来源透视', async () => {
  await withServer(bossA, async base => {
    const response = await fetch(`${base}/employee-outputs?start=2026-07-01&end=2026-07-31&dimension=source`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.summary.total, 5);
    assert.equal(data.summary.withOutput, 3);
    assert.deepEqual(data.pivot.map(row => row.label).sort(), ['内容员工单独派活', '数字员工任务', '经营工具']);
    assert.deepEqual(data.rows.map(row => row.ref).sort(), [
      `content_solo:${soloFailedA}`,
      `content_solo:${soloReadyA}`,
      `content_solo:${soloRunningA}`,
      `task:${taskA}`,
      'tool:1',
    ].sort());
    assert.match(data.dataset.disclaimer, /不代表营业额/);
    assert.equal(data.dataset.store.id, 1);
    assert.ok(data.dataset.store.name);
    assert.equal(data.calculation.unit, '一条持久化运行记录');
  });
});

test('内容员工运行支持来源、分部、员工、日期、状态筛选与多维透视', async () => {
  await withServer(bossA, async base => {
    const sourceQuery = new URLSearchParams({
      start: '2026-07-01', end: '2026-07-31', source: 'content_solo', dimension: 'status',
    });
    const sourceData = await fetch(`${base}/employee-outputs?${sourceQuery}`).then(response => response.json());
    assert.equal(sourceData.summary.total, 3);
    assert.equal(sourceData.summary.withOutput, 1);
    assert.equal(sourceData.summary.pending, 2);
    assert.equal(sourceData.summary.failed, 1);
    assert.deepEqual(sourceData.pivot.map(row => row.label).sort(), ['失败', '待审阅', '生成中']);
    assert.ok(sourceData.rows.every(row => row.source === 'content_solo'));
    assert.equal(sourceData.rows.find(row => row.status === '生成中').hasOutput, false);
    assert.equal(sourceData.rows.find(row => row.status === '失败').hasOutput, false);

    const groupPivot = await fetch(`${base}/employee-outputs?start=2026-07-01&end=2026-07-31&source=content_solo&dimension=group`)
      .then(response => response.json());
    assert.deepEqual(groupPivot.pivot.map(row => [row.label, row.total]), [
      ['热点雷达部', 2],
      ['内容策划部', 1],
    ]);
    const domainPivot = await fetch(`${base}/employee-outputs?start=2026-07-01&end=2026-07-31&source=content_solo&dimension=domain`)
      .then(response => response.json());
    assert.deepEqual(domainPivot.pivot.map(row => [row.label, row.total]), [['Paihuo内容生产部', 3]]);

    const combined = new URLSearchParams({
      start: '2026-07-22',
      end: '2026-07-22',
      domain: 'content',
      source: 'content_solo',
      group: '热点雷达部',
      employee: '0',
      status: '待审阅',
      dimension: 'employee',
    });
    const filtered = await fetch(`${base}/employee-outputs?${combined}`).then(response => response.json());
    assert.equal(filtered.summary.total, 1);
    assert.equal(filtered.rows[0].ref, `content_solo:${soloReadyA}`);
    assert.equal(filtered.rows[0].abilityDomain, 'content');
    assert.equal(filtered.rows[0].abilityDomainLabel, 'Paihuo内容生产部');
    assert.equal(filtered.rows[0].group, '热点雷达部');
    assert.equal(filtered.pivot[0].label, '0 · 趋势官');
  });
});

test('能力域筛选与透视生效，来源和能力域保持独立口径', async () => {
  await withServer(bossA, async base => {
    const query = new URLSearchParams({
      start: '2026-07-01', end: '2026-07-31', domain: 'tool', source: 'all', dimension: 'domain',
    });
    const response = await fetch(`${base}/employee-outputs?${query}`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.summary.total, 1);
    assert.equal(data.rows[0].abilityDomain, 'tool');
    assert.deepEqual(data.pivot.map(row => row.label), ['餐饮经营工具']);
    assert.ok(data.options.domains.some(item => item.value === 'restaurant'));
    assert.ok(data.options.domains.some(item => item.value === 'tool'));
  });
});

test('待核验数据集标记来自数据库持久状态，并使用中性真实表述', async () => {
  q.run(`UPDATE tenants SET data_mode='demo' WHERE id=1`);
  try {
    await withServer(bossA, async base => {
      const data = await fetch(`${base}/employee-outputs?start=2026-07-01&end=2026-07-31`).then(response => response.json());
      assert.equal(process.env.SEED_DEMO, 'false');
      assert.equal(data.dataset.isDemoEnvironment, true);
      assert.equal(data.dataset.kind, '当前环境待核验运行记录');
      assert.equal(data.dataset.kind.includes('演示'), false);
    });
  } finally {
    q.run(`UPDATE tenants SET data_mode='live' WHERE id=1`);
  }
});

test('员工、来源、状态筛选共同生效', async () => {
  await withServer(bossA, async base => {
    const query = new URLSearchParams({
      start: '2026-07-01', end: '2026-07-31', employee: '101', source: 'tool', status: '已完成', dimension: 'employee',
    });
    const data = await fetch(`${base}/employee-outputs?${query}`).then(response => response.json());
    assert.equal(data.summary.total, 1);
    assert.equal(data.rows[0].source, 'tool');
    assert.equal(data.rows[0].employeeIdx, 101);
  });
});

test('穿透返回运行输入、输出、假设与来源', async () => {
  await withServer(bossA, async base => {
    const task = await fetch(`${base}/employee-outputs/drill/task/${taskA}`).then(response => response.json());
    assert.equal(task.record.employeeIdx, 101);
    assert.match(task.output.body, /A店可追溯/);

    const tool = await fetch(`${base}/employee-outputs/drill/tool/1`).then(response => response.json());
    assert.equal(tool.record.inputs.topic, '午市新品');
    assert.equal(tool.output.provenance.persisted, true);
    assert.match(tool.disclaimer, /不等同于真实经营成效/);
  });
});

test('内容员工单独派活穿透返回任务、结果、能力配置技能来源与人工审批边界', async () => {
  await withServer(bossA, async base => {
    const response = await fetch(`${base}/employee-outputs/drill/content_solo/${soloReadyA}`);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.source, 'content_solo');
    assert.equal(detail.record.employeeIdx, 0);
    assert.equal(detail.record.inputs.requirement, '输入：A店夏日菜单趋势');
    assert.match(detail.output.body, /三个候选选题/);
    assert.equal(detail.execution.profileVersion, 'content-0-r3');
    assert.equal(detail.execution.promptHash, 'prompt-hash-a');
    assert.equal(detail.execution.snapshot.capabilities[0].name, '热榜扫描');
    assert.equal(detail.execution.snapshot.workConfig.effective.outputLength, 'full');
    assert.equal(detail.execution.snapshot.skills.core[0].title, '热点判断');
    assert.equal(detail.execution.snapshot.skills.historical[0].verificationStatus, 'legacy_unverified');
    assert.equal(detail.execution.snapshot.skills.custom[0].source, 'A店自定义');
    assert.equal(detail.execution.snapshot.skillSources.historical.snapshot.sha256, 'skills-hash-a');
    assert.match(JSON.stringify(detail.execution.snapshot.approvalBoundary), /老板审核后才能发布/);
    assert.match(JSON.stringify(detail.execution.snapshot.approvalBoundary), /对外发布必须由有权限的人类审批/);
    assert.match(detail.disclaimer, /不归因/);

    const running = await fetch(`${base}/employee-outputs/drill/content_solo/${soloRunningA}`).then(result => result.json());
    const failed = await fetch(`${base}/employee-outputs/drill/content_solo/${soloFailedA}`).then(result => result.json());
    assert.equal(running.record.status, '生成中');
    assert.equal(running.output, null);
    assert.equal(running.evidenceKind, '内容员工运行状态');
    assert.equal(failed.record.status, '失败');
    assert.equal(failed.output, null);
    assert.equal(failed.evidenceKind, '内容员工运行失败');
  });
});

test('租户隔离覆盖聚合与穿透端点', async () => {
  await withServer(bossB, async base => {
    const data = await fetch(`${base}/employee-outputs?start=2026-07-01&end=2026-07-31`).then(response => response.json());
    assert.equal(data.summary.total, 2);
    assert.deepEqual(data.rows.map(row => row.ref).sort(), [`content_solo:${soloPrivateB}`, `task:${taskB}`].sort());

    const taskResponse = await fetch(`${base}/employee-outputs/drill/task/${taskA}`);
    const toolResponse = await fetch(`${base}/employee-outputs/drill/tool/1`);
    const soloResponse = await fetch(`${base}/employee-outputs/drill/content_solo/${soloReadyA}`);
    assert.equal(taskResponse.status, 404);
    assert.equal(toolResponse.status, 404);
    assert.equal(soloResponse.status, 404);
  });
  await withServer(bossA, async base => {
    assert.equal((await fetch(`${base}/employee-outputs/drill/content_solo/${soloPrivateB}`)).status, 404);
  });
});

test('拒绝非法时间范围与透视维度', async () => {
  await withServer(bossA, async base => {
    assert.equal((await fetch(`${base}/employee-outputs?start=2026-08-01&end=2026-07-01`)).status, 400);
    assert.equal((await fetch(`${base}/employee-outputs?dimension=sql`)).status, 400);
  });
});

test('旧库没有内容员工运行表时聚合降级且穿透返回404', async () => {
  db.exec('DROP TABLE content_employee_runs');
  await withServer(bossA, async base => {
    const response = await fetch(`${base}/employee-outputs?start=2026-07-01&end=2026-07-31&dimension=source`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.summary.total, 2);
    assert.ok(data.rows.every(row => row.source !== 'content_solo'));
    assert.equal((await fetch(`${base}/employee-outputs/drill/content_solo/${soloReadyA}`)).status, 404);
  });
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DBP = path.join(os.tmpdir(), `nanowork-inspections-${process.pid}.db`);
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* 不存在 */ }
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const {
  parseInspectionBlock, recordInspectionFromTask, inspectionSummary, INSPECTION_EMPLOYEE_IDX,
} = await import('../src/engines/store-inspections.js');

initSchema();
migrateV2();

const VALID_BLOCK = [
  '# 巡店记录……正文略',
  '',
  '```nanowork-inspection',
  JSON.stringify({
    store: '中山路店',
    inspectionType: '例行巡店',
    score: 82.5,
    subScores: { foodSafety: 15, product: 18, service: 17, hygiene: 14, display: null },
    issues: [
      { board: '食品安全', severity: '高', problem: '凉菜档口温度计缺失', evidence: '照片1', action: '当日补装并记录', deadline: '当日' },
      { board: '环境卫生', severity: '低', problem: '前厅地面有水渍', evidence: '照片3', action: '增加巡检频次', deadline: '3日内' },
    ],
    rectified: null,
  }),
  '```',
].join('\n');

function seedTask(id) {
  q.run(`INSERT INTO marshals(code,name,online,sort) VALUES('M-05','门店运营部',1,5) ON CONFLICT(code) DO NOTHING`);
  const marshalId = q.get(`SELECT id FROM marshals WHERE code='M-05'`).id;
  q.run(`INSERT OR IGNORE INTO specialists(marshal_id,name,duty,status,employee_idx,key,person,group_name,sort)
    VALUES(?,?,?,?,?,?,?,?,?)`, marshalId, '巡店督导', '巡店', '空闲', INSPECTION_EMPLOYEE_IDX, '61-store-inspection-supervisor', '查巡巡', '门店运营部', 60);
  const specialistId = q.get(`SELECT id FROM specialists WHERE employee_idx=?`, INSPECTION_EMPLOYEE_IDX).id;
  q.run(`INSERT INTO agent_tasks(id,marshal_id,specialist_id,title,type,status,tenant_id,created_by)
    VALUES(?,?,?,?,?,?,1,7)`, id, marshalId, specialistId, `巡店任务${id}`, '检查清单', '待审阅');
}

test('归档块解析：合法块通过，缺块/坏JSON/越界评分被拒绝且不入库', () => {
  const ok = parseInspectionBlock(VALID_BLOCK);
  assert.equal(ok.ok, true);
  assert.equal(ok.data.store, '中山路店');
  assert.equal(ok.data.highIssues, 1);
  assert.equal(ok.data.subScores.display, null);

  assert.equal(parseInspectionBlock('没有归档块的普通文本').ok, false);
  assert.equal(parseInspectionBlock('```nanowork-inspection\n{bad json}\n```').ok, false);
  assert.equal(parseInspectionBlock('```nanowork-inspection\n{"store":"a","score":120}\n```').ok, false);
  assert.equal(parseInspectionBlock('```nanowork-inspection\n{"score":90}\n```').ok, false, '缺门店名必须拒绝');
});

test('归档写入幂等：同一 task_id 重复写入不产生重复记录', () => {
  runWithTenant(1, () => {
    seedTask(9001);
    const first = recordInspectionFromTask({ tenantId: 1, taskId: 9001, userId: 7, userName: '督导小王', text: VALID_BLOCK });
    assert.equal(first.recorded, true);
    const again = recordInspectionFromTask({ tenantId: 1, taskId: 9001, userId: 7, userName: '督导小王', text: VALID_BLOCK });
    assert.equal(again.recorded, true, 'ON CONFLICT DO NOTHING 静默幂等');
    assert.equal(q.get('SELECT COUNT(*) n FROM store_inspections WHERE task_id=9001').n, 1);
  });
});

test('解析失败不入库且给出原因', () => {
  runWithTenant(1, () => {
    seedTask(9002);
    const result = recordInspectionFromTask({ tenantId: 1, taskId: 9002, userId: 7, userName: '督导小王', text: '无归档块' });
    assert.equal(result.recorded, false);
    assert.match(result.reason, /归档块/);
    assert.equal(q.get('SELECT COUNT(*) n FROM store_inspections WHERE task_id=9002').n, 0);
  });
});

test('统计：督导×月、门店×月与明细口径一致，含任务实时状态', () => {
  runWithTenant(1, () => {
    seedTask(9003);
    const second = VALID_BLOCK.replace('中山路店', '解放碑店').replace('82.5', '61');
    recordInspectionFromTask({ tenantId: 1, taskId: 9003, userId: 7, userName: '督导小王', text: second });
    const summary = inspectionSummary(1, { months: 3 });
    assert.equal(summary.totals.inspections, 2);
    assert.equal(summary.totals.stores, 2);
    const supervisor = summary.bySupervisor.find(row => row.supervisor === '督导小王');
    assert.ok(supervisor && supervisor.inspections === 2);
    const worst = summary.byStore[0];
    assert.equal(worst.store, '解放碑店', '按均分升序，问题店排最前');
    assert.equal(summary.recent.length, 2);
    assert.equal(summary.recent[0].taskStatus, '待审阅');
  });
});

test('租户隔离：B 租户看不到 A 租户的巡店记录', () => {
  runWithTenant(2, () => {
    const summary = inspectionSummary(2, { months: 3 });
    assert.equal(summary.totals.inspections, 0);
  });
});

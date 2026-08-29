import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-activity-approval-${process.pid}.db`);
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant, setTenantConfig } = await import('../src/db.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const { hashPassword } = await import('../src/util.js');
const activitiesRoutes = (await import('../src/routes/activities.js')).default;
const systemRoutes = (await import('../src/routes/system.js')).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`, 'boss', hashPassword('123456'), '老板', 'boss', '决策层');
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`, 'ops', hashPassword('123456'), '运营总监', 'ops_director', '运营中心');
q.run(`INSERT INTO users(username,password_hash,name,role,dept,manager_id,tenant_id) VALUES(?,?,?,?,?,?,1)`, 'sales', hashPassword('12345678'), '销售员工', 'sales', '销售部', 2);
q.run(`UPDATE tenants SET credits=100000 WHERE id=1`);

function makeApp(user) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => runWithTenant(1, () => { req.user = user; next(); }));
  app.use('/activities', activitiesRoutes);
  app.use('/sys', systemRoutes);
  return app;
}

async function withServer(user, fn) {
  const server = makeApp(user).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('活动策划审批：草稿提交 -> 总监初审 -> 老板终审后才标记已通过', async () => {
  let activityId;
  const plan = {
    theme: '审批测试品鉴会',
    flow: [{ time: '19:00-19:15', item: '签到' }],
    materials: ['签到台', '品鉴杯'],
    invites: 'A类客户',
    sop: ['提前3天邀约', '会前1天确认'],
    kpi: { inviteSign: 50, signArrive: 70, arriveDeal: 25, roi: 2 },
    budgetNote: '预算控制在1-3万',
  };

  await withServer({ id: 2, name: '运营总监', role: 'ops_director' }, async base => {
    const created = await fetch(`${base}/activities`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '审批测试活动', date: '2026-07-01', type: '品鉴会' }),
    }).then(r => r.json());
    activityId = created.id;
    const draft = await fetch(`${base}/activities/${activityId}/plan/draft`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }),
    }).then(r => r.json());
    assert.equal(draft.planStatus, '草稿');
    const submitted = await fetch(`${base}/activities/${activityId}/plan/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }),
    }).then(r => r.json());
    assert.equal(submitted.planStatus, '待审批');
    const row = q.get(`SELECT plan_status FROM activities WHERE id=?`, activityId);
    assert.equal(row.plan_status, '待审批');
    const pending = q.get(`SELECT * FROM approvals WHERE target_type='activity_plan' AND target_id=? AND status='待审核'`, activityId);
    assert.equal(pending.approval_level, 'ops_director');

    const decided = await fetch(`${base}/sys/approvals/${pending.id}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass: true }),
    }).then(r => r.json());
    assert.equal(decided.message, '初审已通过，已转老板终审');
  });

  const bossApproval = q.get(`SELECT * FROM approvals WHERE target_type='activity_plan' AND target_id=? AND status='待审核'`, activityId);
  assert.equal(bossApproval.approval_level, 'boss');
  assert.equal(q.get(`SELECT plan_status FROM activities WHERE id=?`, activityId).plan_status, '总审中');

  await withServer({ id: 1, name: '老板', role: 'boss' }, async base => {
    const final = await fetch(`${base}/sys/approvals/${bossApproval.id}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass: true }),
    }).then(r => r.json());
    assert.equal(final.message, '终审已通过，已开始同步飞书日历和管理层提醒');
  });

  const done = q.get(`SELECT plan_status, plan_approved_at FROM activities WHERE id=?`, activityId);
  assert.equal(done.plan_status, '已通过');
  assert.ok(done.plan_approved_at);
});

test('待确认事项审批：提交 -> 总监初审 -> 老板终审后自动标记完成', async () => {
  let activityId;

  await withServer({ id: 2, name: '运营总监', role: 'ops_director' }, async base => {
    const created = await fetch(`${base}/activities`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '事项审批测试活动', date: '2026-07-02', type: '品鉴会' }),
    }).then(r => r.json());
    activityId = created.id;

    const submitted = await fetch(`${base}/activities/${activityId}/checklist/0/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }).then(r => r.json());
    assert.equal(submitted.message, '已提交审批，终审通过后会自动标记完成并同步管理层');
    assert.equal(submitted.checklist[0].approvalStatus, '待审批');
    assert.equal(submitted.checklist[0].done, false);

    const pending = q.get(`SELECT * FROM approvals WHERE target_type='activity_checklist' AND target_id=? AND status='待审核'`, activityId);
    assert.equal(pending.approval_level, 'ops_director');
    const decided = await fetch(`${base}/sys/approvals/${pending.id}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass: true }),
    }).then(r => r.json());
    assert.equal(decided.message, '初审已通过，已转老板终审');
  });

  let row = q.get(`SELECT checklist FROM activities WHERE id=?`, activityId);
  let checklist = JSON.parse(row.checklist);
  assert.equal(checklist[0].approvalStatus, '总审中');
  assert.equal(checklist[0].done, false);

  const bossApproval = q.get(`SELECT * FROM approvals WHERE target_type='activity_checklist' AND target_id=? AND status='待审核'`, activityId);
  assert.equal(bossApproval.approval_level, 'boss');

  await withServer({ id: 1, name: '老板', role: 'boss' }, async base => {
    const final = await fetch(`${base}/sys/approvals/${bossApproval.id}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass: true }),
    }).then(r => r.json());
    assert.equal(final.message, '终审已通过，事项已完成并同步管理层提醒');
  });

  row = q.get(`SELECT checklist FROM activities WHERE id=?`, activityId);
  checklist = JSON.parse(row.checklist);
  assert.equal(checklist[0].approvalStatus, '已通过');
  assert.equal(checklist[0].done, true);
  assert.equal(checklist[0].approvedBy.name, '老板');
});

test('Boss/platform_super会话提交活动方案与清单不创建审批；普通角色仍按策略且body伪造role不能绕过', async () => {
  const plan = {
    theme: 'Boss自授权测试活动',
    flow: [{ time: '19:00-19:15', item: '签到' }],
    materials: ['签到台'],
    invites: '企业客户',
    sop: ['会前确认'],
    kpi: { inviteSign: '50%', signArrive: '70%', arriveDeal: '25%', roi: '2.0', inviteRate: '80%' },
    budgetNote: '仅用于隔离测试，不产生真实活动',
  };

  // The request body is untrusted. A manager claiming role=boss must still
  // receive the configured approval route and create exactly one approval.
  await withServer({ id: 2, name: '运营总监', role: 'ops_director' }, async base => {
    const created = await fetch(`${base}/activities`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '会话角色优先-普通角色', date: '2026-10-01', type: '品鉴会' }),
    }).then(r => r.json());
    const submitted = await fetch(`${base}/activities/${created.id}/plan/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'boss', plan }),
    }).then(r => r.json());
    assert.equal(submitted.planStatus, '待审批');
    assert.notEqual(submitted.approvalId, null);
    assert.equal(q.get(
      `SELECT COUNT(*) n FROM approvals WHERE tenant_id=1 AND target_type='activity_plan' AND target_id=?`,
      created.id,
    ).n, 1);
  });

  for (const actorRole of ['boss', 'platform_super']) {
    const actor = { id: 1, name: actorRole === 'boss' ? '老板' : '平台超级管理员', role: actorRole };
    await withServer(actor, async base => {
      const created = await fetch(`${base}/activities`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `会话自授权-${actorRole}`, date: '2026-10-02', type: '品鉴会' }),
      }).then(r => r.json());
      const submitted = await fetch(`${base}/activities/${created.id}/plan/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // A conflicting body role must not downgrade the authenticated actor.
        body: JSON.stringify({ role: 'ops_director', plan }),
      }).then(r => r.json());
      assert.equal(submitted.planStatus, '已通过', actorRole);
      assert.equal(submitted.approvalId, null, actorRole);
      assert.equal(q.get(
        `SELECT COUNT(*) n FROM approvals WHERE tenant_id=1 AND target_type='activity_plan' AND target_id=?`,
        created.id,
      ).n, 0, actorRole);

      const checklist = await fetch(`${base}/activities/${created.id}/checklist/0/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'ops_director' }),
      }).then(r => r.json());
      assert.equal(checklist.approvalId, null, actorRole);
      assert.equal(checklist.checklist[0].approvalStatus, '已通过', actorRole);
      assert.equal(checklist.checklist[0].done, true, actorRole);
      assert.equal(q.get(
        `SELECT COUNT(*) n FROM approvals WHERE tenant_id=1 AND target_type='activity_checklist' AND target_id=?`,
        created.id,
      ).n, 0, actorRole);
    });
  }
});

test('活动策划工作分配：同步员工任务、幂等更新并向已绑定员工发送飞书提醒', async () => {
  setTenantConfig('feishu', {
    enabled: true,
    appId: 'activity_app',
    appSecret: 'activity_secret',
    receiveId: 'ou_boss',
    receiveIdType: 'open_id',
    userReceivers: [
      { userId: 3, userName: '销售员工', role: 'sales', receiveId: 'ou_sales', receiveIdType: 'open_id', receiverName: '销售员工' },
    ],
  }, 1);
  const oldFetch = globalThis.fetch;
  const messageBodies = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'activity-token', expire: 7200 });
    }
    if (target.includes('/im/v1/messages')) {
      const body = JSON.parse(options.body);
      messageBodies.push(body);
      return Response.json({ code: 0, data: {} });
    }
    if (target.startsWith('http://127.0.0.1:')) return oldFetch(url, options);
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await withServer({ id: 2, name: '运营总监', role: 'ops_director' }, async base => {
      const created = await fetch(`${base}/activities`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '员工分工品鉴会', date: '2026-07-20', type: '品鉴会' }),
      }).then(r => r.json());
      await fetch(`${base}/activities/${created.id}/plan/draft`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: {
          theme: '员工分工品鉴会', flow: [{ time: '19:00', item: '签到' }], materials: ['签到表'],
          invites: '企业客户', sop: ['会前确认'], kpi: {}, budgetNote: '按预算执行',
        } }),
      });
      const payload = { assignments: [{
        key: 'invite', title: '客户邀约与到场确认', detail: '完成名单确认并回传结果', assigneeId: 3,
        dueAt: '2026-07-19 18:00:00', priority: '高',
      }] };
      const first = await fetch(`${base}/activities/${created.id}/assignments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }).then(r => r.json());
      assert.equal(first.created, 1);
      assert.equal(first.feishuQueued, 1);
      assert.equal(first.tasks[0].assignee_id, 3);

      const second = await fetch(`${base}/activities/${created.id}/assignments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }).then(r => r.json());
      assert.equal(second.created, 0);
      assert.equal(second.updated, 0);
      assert.equal(second.unchanged, 1);
      assert.equal(q.get(`SELECT COUNT(*) n FROM tasks WHERE activity_id=? AND activity_plan_item='invite'`, created.id).n, 1);
      assert.equal(q.get(`SELECT source FROM tasks WHERE activity_id=?`, created.id).source, '活动策划');
      assert.equal(q.get(`SELECT COUNT(*) n FROM notifications WHERE user_id=3 AND type='task'`).n, 1);
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(messageBodies.length, 1);
    assert.equal(messageBodies[0].receive_id, 'ou_sales');
    assert.match(messageBodies[0].content, /客户邀约与到场确认/);
    assert.equal(q.get(`SELECT feishu_notified FROM tasks WHERE activity_plan_item='invite'`).feishu_notified, 1);
  } finally {
    globalThis.fetch = oldFetch;
    setTenantConfig('feishu', {}, 1);
  }
});

test('餐饮活动复盘无真实AI时明确失败，不冒充M-07完成且不写知识库', async () => {
  let activityId;
  await withServer({ id: 2, name: '运营总监', role: 'ops_director' }, async base => {
    const created = await fetch(`${base}/activities`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '复盘入库测试渠道合作活动', date: '2026-07-03', type: '渠道合作活动', target_join: 20, target_deal: 3 }),
    }).then(r => r.json());
    activityId = created.id;
    q.run(`UPDATE activities SET invited=20,signed_up=8,arrived=5,converted=1,revenue=30000,cost=12000,satisfaction=4.5 WHERE id=?`, activityId);

    const response = await fetch(`${base}/activities/${activityId}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: ['邀约名单质量较高'], bad: ['现场转化动作要加强'] }),
    });
    const failed = await response.json();
    assert.equal(response.status, 502, JSON.stringify(failed));
    assert.equal(failed.code, 'AI_REAL_OUTPUT_REQUIRED');
    assert.equal(failed.aiStatus, 'failed');
    assert.equal(failed.retryable, true);
    assert.equal(failed.billing.state, 'released');
  });

  const doc = q.get(`SELECT * FROM kb_docs WHERE title=?`, '活动复盘：复盘入库测试渠道合作活动');
  assert.equal(doc, undefined);
  const activity = q.get(`SELECT review,status FROM activities WHERE tenant_id=1 AND id=?`, activityId);
  assert.equal(activity.review, null);
  assert.notEqual(activity.status, '已复盘');
});

test('活动策划草稿严格按组织树隔离，运营总监不能访问平级团队', async () => {
  const otherOpsId = q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`,
    'ops_other', hashPassword('12345678'), '平级运营总监', 'ops_director', '异地运营中心').lastInsertRowid;
  const otherStaffId = q.run(`INSERT INTO users(username,password_hash,name,role,dept,manager_id,tenant_id) VALUES(?,?,?,?,?,?,1)`,
    'sales_other', hashPassword('12345678'), '平级团队员工', 'sales', '异地销售部', otherOpsId).lastInsertRowid;
  const ownDraftId = q.run(`INSERT INTO activity_plan_drafts(user_id,title,target_join,plan,status) VALUES(?,?,?,?,?)`,
    3, '本团队员工草稿', 20, JSON.stringify({ theme: '本团队草稿', flow: [], materials: [], sop: [] }), '草稿').lastInsertRowid;
  const otherDraftId = q.run(`INSERT INTO activity_plan_drafts(user_id,title,target_join,plan,status) VALUES(?,?,?,?,?)`,
    otherStaffId, '平级团队私有草稿', 20, JSON.stringify({ theme: '不可越权', flow: [], materials: [], sop: [] }), '草稿').lastInsertRowid;

  await withServer({ id: 2, name: '运营总监', role: 'ops_director' }, async base => {
    const listResponse = await fetch(`${base}/activities/plan-drafts/list`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.ok(list.some(row => Number(row.id) === Number(ownDraftId)));
    assert.ok(!list.some(row => Number(row.id) === Number(otherDraftId)));

    const ownUpdate = await fetch(`${base}/activities/plan-drafts/${ownDraftId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: { theme: '本团队已审核', flow: [], materials: [], sop: [] }, targetJoin: 21 }),
    });
    assert.equal(ownUpdate.status, 200);

    const hidden = await fetch(`${base}/activities/plan-drafts/${otherDraftId}`);
    assert.equal(hidden.status, 404);
    const deniedUpdate = await fetch(`${base}/activities/plan-drafts/${otherDraftId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: { theme: '越权改写', flow: [], materials: [], sop: [] }, targetJoin: 99 }),
    });
    assert.equal(deniedUpdate.status, 404);
    const deniedConversion = await fetch(`${base}/activities/plan-drafts/${otherDraftId}/create-activity`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-10-01' }),
    });
    assert.equal(deniedConversion.status, 404);
  });

  const untouched = q.get(`SELECT activity_id,target_join,plan FROM activity_plan_drafts WHERE tenant_id=1 AND id=?`, otherDraftId);
  assert.equal(untouched.activity_id, null);
  assert.equal(untouched.target_join, 20);
  assert.match(untouched.plan, /不可越权/);
});

test('正式活动新增和修改拒绝非法日期、人数与金额', async () => {
  await withServer({ id: 2, name: '运营总监', role: 'ops_director' }, async base => {
    const invalidCreate = await fetch(`${base}/activities`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '非法人数活动', date: '2026-08-01', target_join: -7 }),
    });
    assert.equal(invalidCreate.status, 400);
    assert.equal(q.get(`SELECT COUNT(*) n FROM activities WHERE tenant_id=1 AND title='非法人数活动'`).n, 0);

    const invalidDate = await fetch(`${base}/activities`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '非法日期活动', date: '2026-02-31', target_join: 12 }),
    });
    assert.equal(invalidDate.status, 400);

    const createdResponse = await fetch(`${base}/activities`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '活动输入校验样本', date: '2026-08-02', target_join: 20, budget: 3000 }),
    });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    const invalidUpdate = await fetch(`${base}/activities/${created.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_join: 'not-a-number', revenue: -1 }),
    });
    assert.equal(invalidUpdate.status, 400);
    assert.deepEqual({ ...q.get(`SELECT target_join,revenue FROM activities WHERE tenant_id=1 AND id=?`, created.id) },
      { target_join: 20, revenue: 0 });
  });
});

test('无真实AI的活动策划不落草稿，释放预授权且仅保留0分审计流水', async () => {
  await withServer({ id: 2, name: '运营总监', role: 'ops_director' }, async base => {
    const before = q.get(`SELECT credits FROM tenants WHERE id=1`).credits;
    const logsBefore = q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=1`).n;
    const response = await fetch(`${base}/activities/plan-drafts/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '无真实AI策划', date: '2026-09-01', targetJoin: 20 }),
    });
    const failed = await response.json();
    assert.equal(response.status, 502);
    assert.equal(failed.code, 'AI_REAL_OUTPUT_REQUIRED');
    assert.equal(failed.retryable, true);
    assert.equal(failed.billing.state, 'released');
    assert.equal(q.get(`SELECT credits FROM tenants WHERE id=1`).credits, before);
    assert.equal(q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=1`).n, logsBefore + 1);
    const releasedLog = q.get(`SELECT credits,ai_mode,note FROM credit_logs
      WHERE tenant_id=1 AND feature='活动策划室·AI策划' ORDER BY id DESC LIMIT 1`);
    assert.equal(releasedLog.credits, 0);
    assert.match(releasedLog.note, /预授权.*实扣0分/);
    const releasedHold = q.get(`SELECT status,settled_credits FROM credit_holds
      WHERE tenant_id=1 AND feature='活动策划室·AI策划' ORDER BY id DESC LIMIT 1`);
    assert.deepEqual({ ...releasedHold }, { status: 'settled', settled_credits: 0 });
    assert.equal(q.get(`SELECT COUNT(*) n FROM activity_plan_drafts WHERE tenant_id=1 AND title='无真实AI策划'`).n, 0);
  });
});

test('活动策划提交与审批记录原子，审批插入失败不会留下半提交状态', async () => {
  await withServer({ id: 2, name: '运营总监', role: 'ops_director' }, async base => {
    const created = await fetch(`${base}/activities`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '审批原子性样本', date: '2026-09-05', target_join: 16 }),
    }).then(response => response.json());
    const plan = { theme: '审批原子性样本', flow: [], materials: [], invites: '', sop: [], kpi: {}, budgetNote: '' };
    const draftResponse = await fetch(`${base}/activities/${created.id}/plan/draft`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }),
    });
    assert.equal(draftResponse.status, 200);
    q.run(`CREATE TRIGGER fail_atomic_approval BEFORE INSERT ON approvals
      WHEN NEW.target_type='activity_plan' AND NEW.target_id=${Number(created.id)}
      BEGIN SELECT RAISE(ABORT,'forced approval failure'); END`);
    try {
      const response = await fetch(`${base}/activities/${created.id}/plan/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }),
      });
      assert.equal(response.status, 500);
    } finally {
      q.run(`DROP TRIGGER IF EXISTS fail_atomic_approval`);
    }
    const activity = q.get(`SELECT plan_status,plan_approval_id FROM activities WHERE tenant_id=1 AND id=?`, created.id);
    assert.equal(activity.plan_status, '草稿');
    assert.equal(activity.plan_approval_id, null);
    assert.equal(q.get(`SELECT COUNT(*) n FROM approvals WHERE tenant_id=1 AND target_type='activity_plan' AND target_id=?`, created.id).n, 0);
  });
});

test('cleanup', () => {
  for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
});

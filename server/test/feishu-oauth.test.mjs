import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DBP = path.join(os.tmpdir(), `shanmei-feishu-${process.pid}.db`);
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;
process.env.FEISHU_APP_ID = '';
process.env.FEISHU_APP_SECRET = '';

const { initSchema, migrateV2, getTenantConfig, setTenantConfig, runWithTenant, q } = await import('../src/db.js');
initSchema();
migrateV2();
q.run(`UPDATE tenants SET name='Nano Work 测试总部' WHERE id=1`);
for (const [id, name] of [[2, '日历测试餐饮企业'], [3, '员工通知测试企业'], [4, '停用通知测试企业'], [5, '账号状态测试企业']]) {
  q.run(`INSERT INTO tenants(id,name,status) VALUES(?,?,'已开通') ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status`, id, name);
}
q.run(`INSERT INTO users(id,username,password_hash,name,role,status,tenant_id) VALUES(?,?,?,?,?,?,?)`, 1, 'boss_feishu', 'x', '关老师', 'boss', '启用', 1);
q.run(`INSERT INTO users(id,username,password_hash,name,role,status,tenant_id) VALUES(?,?,?,?,?,?,?)`, 9, 'sales_feishu', 'x', '销售员工', 'sales', '启用', 1);
q.run(`INSERT INTO users(id,username,password_hash,name,role,status,tenant_id) VALUES(?,?,?,?,?,?,?)`, 20, 'boss_calendar', 'x', '日历老板', 'boss', '启用', 2);
q.run(`INSERT INTO users(id,username,password_hash,name,role,status,tenant_id) VALUES(?,?,?,?,?,?,?)`, 21, 'ops_calendar', 'x', '李娜', 'ops_director', '启用', 2);
q.run(`INSERT INTO users(id,username,password_hash,name,role,status,tenant_id) VALUES(?,?,?,?,?,?,?)`, 77, 'employee_only', 'x', '首位员工', 'sales', '启用', 3);
q.run(`INSERT INTO users(id,username,password_hash,name,role,status,tenant_id) VALUES(?,?,?,?,?,?,?)`, 88, 'employee_disabled_enterprise', 'x', '独立通知员工', 'sales', '启用', 4);
q.run(`INSERT INTO users(id,username,password_hash,name,role,status,tenant_id) VALUES(?,?,?,?,?,?,?)`, 89, 'employee_disabled_during_oauth', 'x', '待停用员工', 'sales', '启用', 5);
setTenantConfig('feishu', { appId: 'cli_test_app', appSecret: 'test_secret' }, 1);

const feishu = await import('../src/engines/feishu.js');

test('飞书扫码回调：授权后自动绑定 open_id 为应用机器人单人接收人', async () => {
  const oldFetch = globalThis.fetch;
  const calls = [];
  const cards = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    if (String(url).includes('/authen/v2/oauth/token')) {
      const body = JSON.parse(options.body);
      assert.equal(body.grant_type, 'authorization_code');
      assert.equal(body.client_id, 'cli_test_app');
      assert.equal(body.client_secret, 'test_secret');
      assert.equal(body.code, 'auth-code');
      assert.match(body.redirect_uri, /\/api\/public\/feishu\/oauth\/callback$/);
      return Response.json({ code: 0, data: { access_token: 'u-test-token' } });
    }
    if (String(url).includes('/authen/v1/user_info')) {
      assert.equal(options.headers.Authorization, 'Bearer u-test-token');
      return Response.json({ code: 0, data: { open_id: 'ou_real_user', name: '关老师' } });
    }
    if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
    }
    if (String(url).includes('/im/v1/messages')) {
      const body = JSON.parse(options.body);
      assert.equal(body.receive_id, 'ou_real_user');
      cards.push(JSON.parse(body.content));
      return Response.json({ code: 0, data: {} });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const start = await runWithTenant(1, () => feishu.createOAuthBinding({
      tid: 1,
      user: { id: 1, name: '关老师', role: 'boss' },
      baseUrl: 'http://localhost:3007',
    }));
    assert.ok(start.state);
    assert.match(start.authorizeUrl, /open-apis\/authen\/v1\/index/);
    assert.match(start.qrDataUrl, /^data:image\/png;base64,/);

    const bound = await feishu.handleFeishuOAuthCallback({ code: 'auth-code', state: start.state });
    assert.deepEqual(bound, { ok: true, receiverName: '关老师', receiveIdType: 'open_id' });
    const cfg = feishu.feishuConfig(1);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.receiveId, '');
    assert.equal(cfg.receiveIdType, 'open_id');
    assert.equal(cfg.receiverName, '');
    const managers = feishu.feishuManagerSummary(1);
    assert.equal(managers.count, 1);
    assert.equal(managers.calendarCount, 1);
    assert.equal(managers.recipients[0].role, 'boss');
    assert.equal(managers.recipients[0].calendarReady, true);
    assert.equal(feishu.feishuUserSummary(1, 1).bound, true);
    assert.equal(feishu.oauthBindingStatus(start.state, 1).status, 'bound');
    assert.ok(calls.some(u => u.includes('/im/v1/messages')));
    assert.match(cards[0].header.title.content, /^Nano Work · Nano Work 测试总部｜绑定成功$/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('员工扫码绑定：记录到个人接收人且不覆盖企业主接收人', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/authen/v2/oauth/token')) return Response.json({ code: 0, data: { access_token: 'employee-user-token' } });
    if (target.includes('/authen/v1/user_info')) return Response.json({ code: 0, data: { open_id: 'ou_employee', name: '销售员工' } });
    if (target.includes('/auth/v3/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'employee-tenant-token', expire: 7200 });
    if (target.includes('/im/v1/messages')) {
      assert.equal(JSON.parse(options.body).receive_id, 'ou_employee');
      return Response.json({ code: 0, data: {} });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const start = await runWithTenant(1, () => feishu.createOAuthBinding({
      tid: 1,
      user: { id: 9, name: '销售员工', role: 'sales' },
      baseUrl: 'http://localhost:3007',
    }));
    await feishu.handleFeishuOAuthCallback({ code: 'employee-auth-code', state: start.state });
    assert.equal(feishu.feishuConfig(1).receiveId, '');
    const employee = feishu.feishuUserSummary(9, 1);
    assert.equal(employee.bound, true);
    assert.equal(employee.receiverName, '销售员工');
    assert.equal(feishu.feishuManagerSummary(1).count, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('企业尚未设置主接收人时，员工扫码也只绑定个人通知', async () => {
  setTenantConfig('feishu', { appId: 'employee_only_app', appSecret: 'employee_only_secret' }, 3);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/authen/v2/oauth/token')) return Response.json({ code: 0, data: { access_token: 'employee-only-token' } });
    if (target.includes('/authen/v1/user_info')) return Response.json({ code: 0, data: { open_id: 'ou_employee_only', name: '首位员工' } });
    if (target.includes('/auth/v3/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'employee-only-tenant-token', expire: 7200 });
    if (target.includes('/im/v1/messages')) {
      assert.equal(JSON.parse(options.body).receive_id, 'ou_employee_only');
      return Response.json({ code: 0, data: {} });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const start = await runWithTenant(3, () => feishu.createOAuthBinding({
      tid: 3,
      user: { id: 77, name: '首位员工', role: 'sales' },
      baseUrl: 'http://localhost:3007',
    }));
    await feishu.handleFeishuOAuthCallback({ code: 'employee-only-code', state: start.state });
    assert.equal(feishu.feishuConfig(3).receiveId, '');
    assert.equal(feishu.feishuConfig(3).enabled, false);
    assert.equal(feishu.feishuUserSummary(77, 3).bound, true);
    assert.equal(feishu.feishuManagerSummary(3).count, 0);
    const personalPush = await feishu.pushFeishuToUser({ title: '个人任务', lines: ['只发给本人'] }, 77, 3);
    assert.equal(personalPush.ok, true);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('员工个人绑定不会重新开启已停用的企业管理层通知', async () => {
  setTenantConfig('feishu', {
    enabled: false,
    appId: 'disabled_enterprise_app',
    appSecret: 'disabled_enterprise_secret',
    receiveId: 'ou_enterprise_primary',
    receiveIdType: 'open_id',
  }, 4);
  const oldFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/authen/v2/oauth/token')) return Response.json({ code: 0, data: { access_token: 'disabled-enterprise-user-token' } });
    if (target.includes('/authen/v1/user_info')) return Response.json({ code: 0, data: { open_id: 'ou_personal_only', name: '独立通知员工' } });
    if (target.includes('/auth/v3/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'disabled-enterprise-token', expire: 7200 });
    if (target.includes('/im/v1/messages')) {
      sent.push(JSON.parse(options.body).receive_id);
      return Response.json({ code: 0, data: {} });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const start = await runWithTenant(4, () => feishu.createOAuthBinding({
      tid: 4, user: { id: 88, name: '独立通知员工', role: 'sales' }, baseUrl: 'http://localhost:3007',
    }));
    await feishu.handleFeishuOAuthCallback({ code: 'personal-only-code', state: start.state });
    assert.equal(feishu.feishuConfig(4).enabled, false);
    const managerPush = await feishu.pushFeishuToManagers({ title: '企业通知', lines: ['不应发送'] }, 4);
    assert.equal(managerPush.skipped, true);
    const personalPush = await feishu.pushFeishuToUser({ title: '个人任务', lines: ['应发送'] }, 88, 4);
    assert.equal(personalPush.ok, true);
    assert.deepEqual(sent, ['ou_personal_only', 'ou_personal_only']);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('扫码期间账号被停用后，OAuth 回调不得留下个人绑定', async () => {
  setTenantConfig('feishu', { enabled: false, appId: 'disable_during_app', appSecret: 'disable_during_secret' }, 5);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const target = String(url);
    if (target.includes('/authen/v2/oauth/token')) return Response.json({ code: 0, data: { access_token: 'disable-during-token' } });
    if (target.includes('/authen/v1/user_info')) return Response.json({ code: 0, data: { open_id: 'ou_should_not_bind', name: '待停用员工' } });
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const start = await runWithTenant(5, () => feishu.createOAuthBinding({
      tid: 5, user: { id: 89, name: '待停用员工', role: 'sales' }, baseUrl: 'http://localhost:3007',
    }));
    q.run(`UPDATE users SET status='停用' WHERE tenant_id=5 AND id=89`);
    await assert.rejects(() => feishu.handleFeishuOAuthCallback({ code: 'disable-during-code', state: start.state }), /已停用或不存在/);
    assert.equal(feishu.feishuUserSummary(89, 5).bound, false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('活动同步飞书：创建日程提醒并添加管理层日历参与人', async () => {
  setTenantConfig('feishu', {
    enabled: true,
    appId: 'calendar_app',
    appSecret: 'calendar_secret',
    receiveId: 'ou_boss',
    receiveIdType: 'open_id',
    managerReceivers: [
      { userId: 20, userName: '日历老板', role: 'boss', roleLabel: '老板', receiveId: 'ou_boss', receiveIdType: 'open_id', calendarUserId: 'ou_boss', calendarUserIdType: 'open_id' },
      { userId: 21, userName: '李娜', role: 'ops_director', roleLabel: '运营总监', receiveId: 'ou_ops', receiveIdType: 'open_id', calendarUserId: 'ou_ops', calendarUserIdType: 'open_id' },
    ],
  }, 2);
  const oldFetch = globalThis.fetch;
  const calendarBodies = [];
  const eventBodies = [];
  const attendeeBodies = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'tenant-calendar-token', expire: 7200 });
    }
    if (u.endsWith('/calendar/v4/calendars')) {
      calendarBodies.push(JSON.parse(options.body));
      return Response.json({ code: 0, data: { calendar: { calendar_id: 'cal_manager' } } });
    }
    if (u.endsWith('/calendar/v4/calendars/cal_manager/events')) {
      const body = JSON.parse(options.body);
      eventBodies.push(body);
      assert.deepEqual(body.reminders, [{ minutes: 1440 }, { minutes: 120 }]);
      assert.equal(body.need_notification, true);
      return Response.json({ code: 0, data: { event: { event_id: `evt_${eventBodies.length}` } } });
    }
    if (/\/calendar\/v4\/calendars\/cal_manager\/events\/evt_\d+\/attendees/.test(u)) {
      const body = JSON.parse(options.body);
      attendeeBodies.push(body);
      assert.equal(body.need_notification, true);
      assert.deepEqual(body.attendees.map(x => x.user_id).sort(), ['ou_boss', 'ou_ops']);
      return Response.json({ code: 0, data: {} });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const out = await runWithTenant(2, () => feishu.syncActivityToFeishuCalendar({
      id: 7,
      title: '企业客户品鉴交流会',
      type: '品鉴会',
      status: '策划中',
      date: '2026-06-30',
      location: '上海市浦东新区测试门店',
      target_join: 30,
    }, 2));
    assert.equal(out.ok, true);
    assert.equal(out.attendee.ok, true);
    assert.equal(calendarBodies[0].summary, '日历测试餐饮企业 · Nano Work 经营活动');
    assert.match(calendarBodies[0].description, /Nano Work.*日历测试餐饮企业/);
    assert.equal(eventBodies.length, 1);
    assert.equal(eventBodies[0].location.name, '上海市浦东新区测试门店');
    assert.match(eventBodies[0].description, /企业：日历测试餐饮企业.*来自 Nano Work/);
    assert.equal(attendeeBodies.length, 1);

    const pendingLocation = await runWithTenant(2, () => feishu.syncActivityToFeishuCalendar({
      id: 8, title: '地点待定活动', type: '沙龙会', status: '策划中', date: '2026-07-01', location: '   ', target_join: 12,
    }, 2));
    assert.equal(pendingLocation.ok, true);
    assert.equal(eventBodies[1].location.name, '待确认');
    assert.match(eventBodies[1].description, /地点：待确认/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('ICS 对外标识使用 Nano Work、真实租户名与待确认地点', () => {
  const ics = runWithTenant(2, () => feishu.buildIcs([{
    id: 19, tenant_id: 2, title: '季度经营交流会', type: '沙龙会', status: '筹备中', date: '2026-07-18', location: '', owner: '李娜', target_join: 20,
  }], 2));
  assert.match(ics, /PRODID:-\/\/Nano Work\/\/日历测试餐饮企业 Activities\/\/CN/);
  assert.match(ics, /X-WR-CALNAME:日历测试餐饮企业 · Nano Work 经营活动/);
  assert.match(ics, /UID:nanowork-act-2-19@nano-work/);
  assert.match(ics, /LOCATION:待确认/);
  assert.match(ics, /DESCRIPTION:企业：日历测试餐饮企业.*来自 Nano Work/);
  assert.doesNotMatch(ics, /Shanmei|JiuDaoGuan|jiudaoguan|酒道馆|纳米Work/);
});

test('已有 calendarId 与 eventId 原位复用，改显示名称不更换映射', async () => {
  setTenantConfig('feishu', {
    enabled: true,
    appId: 'calendar_app',
    appSecret: 'calendar_secret',
    receiveId: 'ou_boss',
    receiveIdType: 'open_id',
    calendarId: 'cal_legacy',
    calendarIdentityVersion: 0,
    managerReceivers: [
      { userId: 20, userName: '日历老板', role: 'boss', receiveId: 'ou_boss', receiveIdType: 'open_id', calendarUserId: 'ou_boss', calendarUserIdType: 'open_id' },
    ],
  }, 2);
  setTenantConfig('feishu_event_map', { 42: 'evt_legacy' }, 2);
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push(`${options.method || 'GET'} ${target}`);
    if (target.includes('/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'tenant-calendar-token', expire: 7200 });
    }
    if (target.endsWith('/calendar/v4/calendars/cal_legacy')) {
      assert.equal(options.method, 'PATCH');
      assert.equal(JSON.parse(options.body).summary, '日历测试餐饮企业 · Nano Work 经营活动');
      return Response.json({ code: 0, data: {} });
    }
    if (target.endsWith('/calendar/v4/calendars/cal_legacy/events/evt_legacy')) {
      assert.equal(options.method, 'PATCH');
      return Response.json({ code: 0, data: { event: { event_id: 'evt_legacy' } } });
    }
    if (target.includes('/calendar/v4/calendars/cal_legacy/events/evt_legacy/attendees')) {
      return Response.json({ code: 0, data: {} });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const result = await runWithTenant(2, () => feishu.syncActivityToFeishuCalendar({
      id: 42, title: '已有关联活动', type: '会员日', status: '筹备中', date: '2026-07-20', location: '南京路门店', target_join: 18,
    }, 2));
    assert.equal(result.ok, true);
    assert.ok(calls.some(call => call.includes('/cal_legacy/events/evt_legacy')));
    assert.equal(getTenantConfig('feishu', {}, 2).calendarId, 'cal_legacy');
    assert.equal(getTenantConfig('feishu_event_map', {}, 2)['42'], 'evt_legacy');
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('cleanup', () => {
  for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
});

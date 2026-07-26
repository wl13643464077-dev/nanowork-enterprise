import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DBP = path.join(os.tmpdir(), `shanmei-feishu-recipients-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* file does not exist */ }
}
process.env.NANOWORK_DB = DBP;
process.env.FEISHU_APP_ID = '';
process.env.FEISHU_APP_SECRET = '';

const { initSchema, migrateV2, q, setTenantConfig } = await import('../src/db.js');
initSchema();
migrateV2();
const bossId = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES(?,?,?,?,?,?)`,
  'active_boss', 'x', '在职老板', 'boss', '启用', 1).lastInsertRowid;
const disabledManagerId = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES(?,?,?,?,?,?)`,
  'disabled_ops', 'x', '离职总监', 'ops_director', '停用', 1).lastInsertRowid;
const demotedManagerId = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES(?,?,?,?,?,?)`,
  'demoted_ops', 'x', '已转岗员工', 'sales', '启用', 1).lastInsertRowid;
const disabledEmployeeId = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES(?,?,?,?,?,?)`,
  'disabled_sales', 'x', '离职员工', 'sales', '停用', 1).lastInsertRowid;

setTenantConfig('feishu', {
  enabled: true,
  appId: 'recipient_app',
  appSecret: 'recipient_secret',
  managerReceivers: [
    { userId: bossId, userName: '在职老板', role: 'boss', receiveId: 'ou_active_boss', receiveIdType: 'open_id' },
    { userId: disabledManagerId, userName: '离职总监', role: 'ops_director', receiveId: 'ou_disabled_ops', receiveIdType: 'open_id' },
    { userId: demotedManagerId, userName: '已转岗员工', role: 'ops_director', receiveId: 'ou_demoted_ops', receiveIdType: 'open_id' },
  ],
  userReceivers: [
    { userId: disabledEmployeeId, userName: '离职员工', role: 'sales', receiveId: 'ou_disabled_sales', receiveIdType: 'open_id' },
  ],
}, 1);

const feishu = await import('../src/engines/feishu.js');

test('飞书通知实时排除停用账号与已失去管理角色的旧绑定', async () => {
  assert.equal(feishu.feishuManagerSummary(1).count, 1);
  assert.equal(feishu.feishuUserSummary(disabledEmployeeId, 1).bound, false);

  const oldFetch = globalThis.fetch;
  const recipients = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'recipient-token', expire: 7200 });
    }
    if (target.includes('/im/v1/messages')) {
      recipients.push(JSON.parse(options.body).receive_id);
      return Response.json({ code: 0, data: {} });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const result = await feishu.pushFeishuToManagers({ title: '经营提醒', lines: ['仅在职管理层可见'] }, 1);
    assert.equal(result.sent, 1);
    assert.deepEqual(recipients, ['ou_active_boss']);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* file does not exist */ }
  }
});

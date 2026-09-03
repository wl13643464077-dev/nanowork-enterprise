import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const DB_PATH = path.join(os.tmpdir(), `nanowork-onboarding-${process.pid}.db`);
const DATABASE_FILES = [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`];
for (const file of DATABASE_FILES) fs.rmSync(file, { force: true });

process.env.NANOWORK_DB = DB_PATH;
process.env.JWT_SECRET = 'Onboarding-Test#2026!server-owned';

const { db, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
const { authMiddleware, hashPassword, signToken } = await import('../src/util.js');
const { default: metaRoutes, ONBOARDING_VERSION } = await import('../src/routes/meta.js');

initSchema();
migrateV2();

const insertTenant = db.prepare(
  `INSERT INTO tenants(id,name,status) VALUES(?,?,'已开通')`,
);
insertTenant.run(901, '指引测试企业一');
insertTenant.run(902, '指引测试企业二');

const passwordHash = hashPassword('Guide-Test#2026');
const insertUser = db.prepare(`
  INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,'启用',?)
`);
const bossOneId = Number(insertUser.run(
  'guide_boss_one', passwordHash, '企业一老板', 'boss', 901,
).lastInsertRowid);
const staffOneId = Number(insertUser.run(
  'guide_staff_one', passwordHash, '企业一员工', 'sales', 901,
).lastInsertRowid);
const bossTwoId = Number(insertUser.run(
  'guide_boss_two', passwordHash, '企业二老板', 'boss', 902,
).lastInsertRowid);

function tokenFor(id, tenantId, role) {
  return signToken({
    id,
    username: `guide-${id}`,
    name: `测试账号${id}`,
    tenant_id: tenantId,
    role,
    auth_version: 0,
  });
}

const tokens = {
  bossOne: tokenFor(bossOneId, 901, 'boss'),
  staffOne: tokenFor(staffOneId, 901, 'sales'),
  bossTwo: tokenFor(bossTwoId, 902, 'boss'),
};

const app = express();
app.use(express.json());
app.use(
  '/api/meta',
  authMiddleware,
  (req, _res, next) => runWithTenant(req.user.tenant_id, () => next()),
  metaRoutes,
);
const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => {
  server.once('listening', () => resolve(server.address().port));
});
const base = `http://127.0.0.1:${port}`;

async function request(token, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}/api/meta/onboarding`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    payload: await response.json(),
  };
}

function stored(userId) {
  return db.prepare(`
    SELECT tenant_id,role,onboarding_version,onboarding_role,onboarding_completed_at,onboarding_outcome
    FROM users WHERE id=?
  `).get(userId);
}

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  for (const file of DATABASE_FILES) fs.rmSync(file, { force: true });
});

test('新手指引完成态由服务端按用户、租户、岗位和版本权威管理', async t => {
  await t.test('新账号默认未完成', async () => {
    const result = await request(tokens.bossOne);
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload, {
      currentVersion: ONBOARDING_VERSION,
      completedVersion: 0,
      completedRole: null,
      completedAt: null,
      outcome: null,
      complete: false,
    });
  });

  let firstCompletedAt;
  await t.test('完成提交忽略伪造的用户、租户、岗位和版本字段', async () => {
    const result = await request(tokens.bossOne, {
      method: 'PUT',
      body: {
        outcome: 'completed',
        userId: bossTwoId,
        tenantId: 902,
        role: 'platform_super',
        version: ONBOARDING_VERSION + 999,
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.payload.complete, true);
    assert.equal(result.payload.completedVersion, ONBOARDING_VERSION);
    assert.equal(result.payload.completedRole, 'boss');
    assert.equal(result.payload.outcome, 'completed');
    assert.ok(result.payload.completedAt);
    firstCompletedAt = result.payload.completedAt;

    const own = stored(bossOneId);
    assert.equal(Number(own.tenant_id), 901);
    assert.equal(own.role, 'boss');
    assert.equal(Number(own.onboarding_version), ONBOARDING_VERSION);
    assert.equal(own.onboarding_role, 'boss');
    assert.equal(own.onboarding_outcome, 'completed');

    for (const untouchedId of [staffOneId, bossTwoId]) {
      const untouched = stored(untouchedId);
      assert.equal(Number(untouched.onboarding_version), 0);
      assert.equal(untouched.onboarding_role, null);
      assert.equal(untouched.onboarding_outcome, null);
    }
  });

  await t.test('相同结果重复提交幂等且不刷新完成时间', async () => {
    const again = await request(tokens.bossOne, {
      method: 'PUT',
      body: { outcome: 'completed' },
    });
    assert.equal(again.status, 200);
    assert.equal(again.payload.complete, true);
    assert.equal(again.payload.completedAt, firstCompletedAt);
  });

  await t.test('跳过也是可重新打开的本版本终态，且不影响其他用户和租户', async () => {
    const dismissed = await request(tokens.staffOne, {
      method: 'PUT',
      body: { outcome: 'dismissed' },
    });
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.payload.complete, true);
    assert.equal(dismissed.payload.completedRole, 'sales');
    assert.equal(dismissed.payload.outcome, 'dismissed');

    const otherTenant = await request(tokens.bossTwo);
    assert.equal(otherTenant.status, 200);
    assert.equal(otherTenant.payload.complete, false);
    assert.equal(otherTenant.payload.completedVersion, 0);
    assert.equal(otherTenant.payload.outcome, null);
  });

  await t.test('非法 outcome 返回 400 且不改写原状态', async () => {
    const before = stored(bossTwoId);
    const invalid = await request(tokens.bossTwo, {
      method: 'PUT',
      body: { outcome: 'skipped', userId: bossOneId },
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.payload.error, /completed|dismissed/u);
    assert.deepEqual(stored(bossTwoId), before);
  });

  await t.test('岗位变化或记录版本不匹配时自动判定未完成', async () => {
    db.prepare(`UPDATE users SET role='sales' WHERE id=? AND tenant_id=?`).run(bossOneId, 901);
    const changedRole = await request(tokens.bossOne);
    assert.equal(changedRole.status, 200);
    assert.equal(changedRole.payload.completedRole, 'boss');
    assert.equal(changedRole.payload.complete, false);

    db.prepare(`
      UPDATE users SET role='boss', onboarding_version=? WHERE id=? AND tenant_id=?
    `).run(ONBOARDING_VERSION + 1, bossOneId, 901);
    const changedVersion = await request(tokens.bossOne);
    assert.equal(changedVersion.status, 200);
    assert.equal(changedVersion.payload.completedVersion, ONBOARDING_VERSION + 1);
    assert.equal(changedVersion.payload.complete, false);
  });
});

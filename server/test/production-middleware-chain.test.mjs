import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(os.tmpdir(), `nanowork-production-chain-${process.pid}.db`);
const DATABASE_FILES = [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`];
for (const file of DATABASE_FILES) fs.rmSync(file, { force: true });

process.env.NANOWORK_DB = DB_PATH;
process.env.NODE_ENV = 'test';
process.env.SEED_DEMO = 'false';
process.env.JWT_SECRET = 'Production-Chain-Test#2026!9xQ';
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { db, initSchema, migrateV2 } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const { createApp } = await import('../src/app.js');

initSchema();
migrateV2();

const password = 'Chain-Test#2026';
const passwordHash = hashPassword(password);
const insertTenant = db.prepare(
  'INSERT INTO tenants(id,name,status,modules,credits) VALUES(?,?,?,?,?)',
);
const insertUser = db.prepare(`
  INSERT INTO users(username,password_hash,name,role,status,tenant_id,modules)
  VALUES(?,?,?,?,?,?,?)
`);

insertTenant.run(101, '完整链企业', '已开通', JSON.stringify(['content']), 1000);
insertTenant.run(102, '稍后停用企业', '已开通', JSON.stringify(['content']), 1000);
insertTenant.run(103, '隔离对照企业', '已开通', JSON.stringify(['content']), 1000);

const allowedUserId = Number(insertUser.run(
  'chain_allowed', passwordHash, '完整链老板', 'boss', '启用', 101, JSON.stringify(['content']),
).lastInsertRowid);
const scopedUserId = Number(insertUser.run(
  'chain_scoped', passwordHash, '范围内员工', 'sales', '启用', 101, JSON.stringify(['content']),
).lastInsertRowid);
insertUser.run(
  'chain_no_module', passwordHash, '无内容模块老板', 'boss', '启用', 101, JSON.stringify([]),
);
const disabledUserId = Number(insertUser.run(
  'chain_disabled', passwordHash, '稍后停用账号', 'boss', '启用', 101, JSON.stringify(['content']),
).lastInsertRowid);
insertUser.run(
  'chain_stopped_tenant', passwordHash, '停用企业老板', 'boss', '启用', 102, JSON.stringify(['content']),
);
const otherUserId = Number(insertUser.run(
  'chain_other_tenant', passwordHash, '隔离企业老板', 'boss', '启用', 103, JSON.stringify(['content']),
).lastInsertRowid);

db.prepare(`
  INSERT INTO contents(type,title,body,topic,status,creator_id,tenant_id)
  VALUES(?,?,?,?,?,?,?)
`).run('朋友圈文案', '本企业内容', '只允许企业101读取', '隔离验收', '待审核', allowedUserId, 101);
db.prepare(`
  INSERT INTO contents(type,title,body,topic,status,creator_id,tenant_id)
  VALUES(?,?,?,?,?,?,?)
`).run('朋友圈文案', '其他企业内容', '不得向企业101泄露', '隔离验收', '待审核', otherUserId, 103);
db.prepare(`
  INSERT INTO contents(type,title,body,topic,status,creator_id,tenant_id)
  VALUES(?,?,?,?,?,?,?)
`).run('朋友圈文案', '权限搜索·本人内容', '员工本人可见', '范围搜索', '待审核', scopedUserId, 101);
db.prepare(`
  INSERT INTO contents(type,title,body,topic,status,creator_id,tenant_id)
  VALUES(?,?,?,?,?,?,?)
`).run('朋友圈文案', '权限搜索·老板内容', '同租户但非员工范围', '范围搜索', '待审核', allowedUserId, 101);
db.prepare(`
  INSERT INTO contents(type,title,body,topic,status,creator_id,tenant_id)
  VALUES(?,?,?,?,?,?,?)
`).run('朋友圈文案', '权限搜索·外租户内容', '不得跨租户返回', '范围搜索', '待审核', otherUserId, 103);

const app = createApp({
  serveStatic: false,
  aiGuardOptions: {
    ratePerMinute: 1,
    burst: 1,
    maxConcurrent: 2,
  },
});
const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => {
  server.once('listening', () => resolve(server.address().port));
});
const base = `http://127.0.0.1:${port}`;

async function request(pathname, {
  token,
  method = 'GET',
  body,
} = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    response,
    payload: await response.json().catch(() => null),
  };
}

async function login(username) {
  const result = await request('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.ok(result.payload?.token);
  return result.payload.token;
}

function tableCount(table) {
  const exists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table);
  return exists ? db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n : 0;
}

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  for (const file of DATABASE_FILES) fs.rmSync(file, { force: true });
});

test('生产装配按 auth→tenantScope→tenantGate→moduleGuard→aiGuard→Router 顺序拒绝并隔离', async () => {
  const allowedToken = await login('chain_allowed');
  const scopedToken = await login('chain_scoped');
  const noModuleToken = await login('chain_no_module');
  const disabledToken = await login('chain_disabled');
  const stoppedTenantToken = await login('chain_stopped_tenant');

  db.prepare("UPDATE users SET status='停用' WHERE id=?").run(disabledUserId);
  db.prepare("UPDATE tenants SET status='已停用' WHERE id=102").run();

  const contentsBefore = db.prepare('SELECT COUNT(*) n FROM contents').get().n;
  const holdsBefore = tableCount('credit_holds');

  const anonymous = await request('/api/content/generate', {
    method: 'POST',
    body: {},
  });
  assert.equal(anonymous.response.status, 401);
  assert.match(anonymous.payload.error, /未登录|登录已过期/u);

  const disabledAccount = await request('/api/content/generate', {
    token: disabledToken,
    method: 'POST',
    body: {},
  });
  assert.equal(disabledAccount.response.status, 401);
  assert.match(disabledAccount.payload.error, /停用|不存在/u);

  const stoppedTenant = await request('/api/content/generate', {
    token: stoppedTenantToken,
    method: 'POST',
    body: {},
  });
  assert.equal(stoppedTenant.response.status, 403);
  assert.equal(stoppedTenant.payload.tenantStatus, '已停用');

  const missingModule = await request('/api/content/generate', {
    token: noModuleToken,
    method: 'POST',
    body: {},
  });
  assert.equal(missingModule.response.status, 403);
  assert.match(missingModule.payload.error, /模块权限/u);

  const dataIntakeWithoutSystem = await request('/api/data-intake/schema', {
    token: allowedToken,
  });
  assert.equal(dataIntakeWithoutSystem.response.status, 403);
  assert.match(dataIntakeWithoutSystem.payload.error, /模块权限/u);

  const ownContents = await request('/api/content/list', { token: allowedToken });
  assert.equal(ownContents.response.status, 200);
  assert.equal(ownContents.payload.total, 3);
  assert.deepEqual(
    ownContents.payload.rows.map(item => item.title).sort(),
    ['本企业内容', '权限搜索·本人内容', '权限搜索·老板内容'].sort(),
  );
  assert.doesNotMatch(JSON.stringify(ownContents.payload), /其他企业内容|权限搜索·外租户内容|不得向企业101泄露/u);

  const scopedSearch = await request(
    `/api/content/list?kw=${encodeURIComponent('权限搜索')}&page=1&size=4`,
    { token: scopedToken },
  );
  assert.equal(scopedSearch.response.status, 200);
  assert.equal(scopedSearch.payload.total, 1);
  assert.deepEqual(scopedSearch.payload.rows.map(item => item.title), ['权限搜索·本人内容']);
  assert.doesNotMatch(JSON.stringify(scopedSearch.payload), /老板内容|外租户内容/u);

  const managerSearch = await request(
    `/api/content/list?kw=${encodeURIComponent('权限搜索')}&page=1&size=4`,
    { token: allowedToken },
  );
  assert.equal(managerSearch.response.status, 200);
  assert.equal(managerSearch.payload.total, 2);
  assert.deepEqual(
    managerSearch.payload.rows.map(item => item.title).sort(),
    ['权限搜索·本人内容', '权限搜索·老板内容'].sort(),
  );
  assert.doesNotMatch(JSON.stringify(managerSearch.payload), /外租户内容/u);

  const literalWildcard = await request(
    `/api/content/list?kw=${encodeURIComponent('%')}&page=1&size=4`,
    { token: scopedToken },
  );
  assert.equal(literalWildcard.response.status, 200);
  assert.equal(literalWildcard.payload.total, 0);

  const oversizedKeyword = await request(
    `/api/content/list?kw=${encodeURIComponent('超'.repeat(101))}&page=1&size=4`,
    { token: scopedToken },
  );
  assert.equal(oversizedKeyword.response.status, 400);
  assert.match(oversizedKeyword.payload.error, /不能超过100字/u);

  const reachesRouter = await request('/api/content/generate', {
    token: allowedToken,
    method: 'POST',
    body: {},
  });
  assert.equal(reachesRouter.response.status, 400);
  assert.match(reachesRouter.payload.error, /创作类型与主题必填/u);

  const rateLimited = await request('/api/content/generate', {
    token: allowedToken,
    method: 'POST',
    body: {},
  });
  assert.equal(rateLimited.response.status, 429);
  assert.ok(Number(rateLimited.response.headers.get('retry-after')) >= 1);
  assert.match(rateLimited.payload.error, /过于频繁/u);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM contents').get().n, contentsBefore);
  assert.equal(tableCount('credit_holds'), holdsBefore);
});

// 认证安全测试：密码 scrypt 加盐、JWT 签发/校验、篡改与过期一律拒绝、签名绑定密钥。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// util.js 在 import 时读取 JWT_SECRET，且会连带 import db.js —— 两个环境变量都须在 import 前设好
const DBP = path.join(os.tmpdir(), `nanowork-auth-${process.pid}.db`);
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;
process.env.JWT_SECRET = '8xQ!2vZ#7mL@4pR$9cT%6kN&3wF*5sH?';

const {
  hashPassword, verifyPassword, signToken, verifyToken, authMiddleware, csrfOriginGuard, maskPhone,
  safeJsonArray, safeJsonParse, tokenFromRequest, SESSION_COOKIE,
} = await import('../src/util.js');
const { initSchema, migrateV2, q } = await import('../src/db.js');

initSchema();
migrateV2();

test('密码哈希：正确密码通过、错误密码拒绝、同密码两次哈希不同（加盐防彩虹表）', async () => {
  const h = hashPassword('Secret123!');
  assert.equal(await verifyPassword('Secret123!', h), true, '正确密码应通过');
  assert.equal(await verifyPassword('wrong', h), false, '错误密码应拒绝');
  assert.notEqual(hashPassword('Secret123!'), hashPassword('Secret123!'), '随机盐应使两次哈希不同');
  assert.match(h, /^[0-9a-f]{32}:[0-9a-f]{64}$/, 'salt:hash 格式');
  assert.equal(await verifyPassword('Secret123!', 'bad-record'), false, '损坏的历史哈希应安全拒绝而不是抛错');
  assert.equal(await verifyPassword('Secret123!', 'abcd:00'), false, '错误长度哈希应安全拒绝');
});

test('JSON容错：损坏或类型错误的历史字段返回明确默认值', () => {
  assert.deepEqual(safeJsonParse('{"ok":true}', {}), { ok: true });
  assert.deepEqual(safeJsonParse('{bad json', {}), {});
  assert.deepEqual(safeJsonArray('[1,2]'), [1, 2]);
  assert.deepEqual(safeJsonArray('{"not":"array"}'), []);
});

test('JWT 签发/校验往返：payload 完整还原', () => {
  const tok = signToken({ id: 7, role: 'boss', tenant_id: 3 });
  const p = verifyToken(tok);
  assert.equal(p.id, 7);
  assert.equal(p.role, 'boss');
  assert.equal(p.tenant_id, 3);
});

test('会话 Cookie 边界：只读取 Nano Work 自有名称', () => {
  const foreignOnly = tokenFromRequest({ headers: { cookie: 'other_project_session=foreign-token' } });
  const both = tokenFromRequest({ headers: { cookie: `other_project_session=foreign-token; ${SESSION_COOKIE}=nano-token` } });
  assert.equal(SESSION_COOKIE, 'nanowork_session');
  assert.equal(foreignOnly, '');
  assert.equal(both, 'nano-token');
});

test('JWT 防伪：篡改签名 / 篡改 payload / 过期 / 畸形 一律拒绝', () => {
  const tok = signToken({ id: 7, role: 'sales' });
  const [data, sig] = tok.split('.');
  // 篡改签名
  assert.equal(verifyToken(`${data}.deadbeef`), null, '签名不符应拒绝');
  // 篡改 payload（想把自己提权成 boss），但签名是旧的 → 不匹配
  const evil = Buffer.from(JSON.stringify({ id: 7, role: 'boss', exp: Date.now() + 1e7 })).toString('base64url');
  assert.equal(verifyToken(`${evil}.${sig}`), null, '改 payload 后签名失配应拒绝');
  // 过期
  assert.equal(verifyToken(signToken({ id: 7 }, -10)), null, '过期 token 应拒绝');
  // 畸形 / 空
  assert.equal(verifyToken(''), null);
  assert.equal(verifyToken('garbage'), null);
  assert.equal(verifyToken('a.b.c'), null);
});

test('JWT 签名绑定密钥：用别的密钥签的 token 无法通过本服务校验', () => {
  const data = Buffer.from(JSON.stringify({ id: 1, role: 'boss', exp: Date.now() + 1e7 })).toString('base64url');
  const foreignSig = crypto.createHmac('sha256', 'attacker-guessed-key').update(data).digest('base64url');
  assert.equal(verifyToken(`${data}.${foreignSig}`), null, '异密钥签发的 token 必须拒绝');
});

test('认证中间件：角色变更立即生效，停用账号的旧令牌立即失效', () => {
  const inserted = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?,?,?,?,?,?)`, 'live-auth-user', hashPassword('Secret123!'), '权限测试用户', 'boss', '启用', 1);
  const token = signToken({ id: inserted.lastInsertRowid, name: '权限测试用户', role: 'boss', tenant_id: 1 });

  q.run(`UPDATE users SET role='sales' WHERE id=?`, inserted.lastInsertRowid);
  const req = { headers: { authorization: `Bearer ${token}` } };
  let nextCalled = false;
  authMiddleware(req, { status: () => { throw new Error('不应拒绝启用账号'); } }, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.user.role, 'sales', '应使用数据库中的实时角色，不信任令牌旧角色');

  q.run(`UPDATE users SET status='停用' WHERE id=?`, inserted.lastInsertRowid);
  let statusCode = 0; let body = null;
  authMiddleware({ headers: { authorization: `Bearer ${token}` } }, {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
  }, () => { throw new Error('停用账号不应继续请求'); });
  assert.equal(statusCode, 401);
  assert.match(body.error, /停用|不存在/);
});

test('认证中间件：密码重置递增认证版本后，旧令牌立即失效', () => {
  const inserted = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?,?,?,?,?,?)`, 'password-reset-user', hashPassword('Before123!'), '改密测试用户', 'sales', '启用', 1);
  const token = signToken({ id: inserted.lastInsertRowid, role: 'sales', tenant_id: 1, auth_version: 0 });
  q.run(`UPDATE users SET password_hash=?,auth_version=COALESCE(auth_version,0)+1 WHERE id=?`,
    hashPassword('After456!'), inserted.lastInsertRowid);

  let statusCode = 0; let body = null;
  authMiddleware({ headers: { authorization: `Bearer ${token}` } }, {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
  }, () => { throw new Error('改密前签发的令牌不应继续通过'); });
  assert.equal(statusCode, 401);
  assert.match(body.error, /失效|重新登录/);
});

test('CSRF来源守卫：同源和受信来源通过，跨站与伪造来源拒绝', () => {
  const guard = csrfOriginGuard({ allowedOrigins: new Set(['https://console.example.com']), production: true });
  const invoke = ({ method = 'POST', origin = '', fetchSite = '', host = 'industry.nanowork.example', protocol = 'https' }) => {
    let statusCode = 0; let nextCalled = false;
    const headers = { ...(origin ? { origin } : {}), ...(fetchSite ? { 'sec-fetch-site': fetchSite } : {}) };
    const req = {
      method, headers, protocol,
      get(name) { return name.toLowerCase() === 'host' ? host : (headers[name.toLowerCase()] || ''); },
    };
    guard(req, { status(code) { statusCode = code; return this; }, json() { return this; } }, () => { nextCalled = true; });
    return { statusCode, nextCalled };
  };
  assert.equal(invoke({ origin: 'https://industry.nanowork.example' }).nextCalled, true);
  assert.equal(invoke({ origin: 'https://console.example.com' }).nextCalled, true);
  assert.equal(invoke({ method: 'GET', origin: 'https://evil.example' }).nextCalled, true);
  assert.equal(invoke({ origin: 'https://evil.example' }).statusCode, 403);
  assert.equal(invoke({ fetchSite: 'cross-site' }).statusCode, 403);
  assert.equal(invoke({ origin: 'not a url' }).statusCode, 403);
});

test('手机号脱敏：员工看打码、老板/管理层看全号', () => {
  assert.equal(maskPhone('13812345678', 'sales'), '138****5678', '员工应打码');
  assert.equal(maskPhone('13812345678', 'boss'), '13812345678', '老板看全号');
  assert.equal(maskPhone('13812345678', 'ops_director'), '13812345678', '管理层看全号');
});

test('cleanup', () => {
  for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
});

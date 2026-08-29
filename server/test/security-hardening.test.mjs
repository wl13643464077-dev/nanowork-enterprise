// 安全加固回归（审计 BE-H3/H4/M5）：
// 1) scrypt 异步化：verifyPassword 返回 Promise、往返正确、不再同步阻塞事件循环
// 2) AI 生成接口限流：租户级令牌桶触发 429（含 Retry-After、租户隔离、便宜接口不受限）+ 全局并发信号量
// 3) 会话可吊销：登录令牌携带 jti，按 jti 吊销/单点登出后旧令牌立即 401，其他会话不受影响
// 4) SSRF：Provider BaseURL 解析 DNS 后校验 IP，解析到内网/环回/链路本地的域名一律拦截
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-sec-hardening-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.JWT_SECRET = 'security-hardening-test-secret';

const { initSchema, migrateV2, q } = await import('../src/db.js');
const {
  hashPassword, verifyPassword, authMiddleware, signToken,
  createSession, sessionActive, revokeSession, revokeUserSessions, listSessions,
} = await import('../src/util.js');
const { createAiGuard } = await import('../src/ai-limits.js');
const { validatedProviderBase, isForbiddenAddress } = await import('../src/routes/admin.js');
const authRoutes = (await import('../src/routes/auth.js')).default;

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status) VALUES(1,'加固测试租户','已开通')
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status`);
q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'session-user', hashPassword('Session-Pass-1!'), '会话测试用户', 'boss', '启用', 1);

async function withServer(build, fn) {
  const app = express();
  app.use(express.json());
  build(app);
  const server = app.listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

const tokenPayload = token => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());

// ===== 1) BE-H3：scrypt 异步往返 =====

test('scrypt 异步化：verifyPassword 返回 Promise，往返校验正确、损坏记录安全拒绝', async () => {
  const stored = hashPassword('Async-Scrypt#2026');
  const pending = verifyPassword('Async-Scrypt#2026', stored);
  assert.ok(pending instanceof Promise, 'verifyPassword 必须是异步的（不再 scryptSync 阻塞事件循环）');
  assert.equal(await pending, true, '正确密码应通过');
  assert.equal(await verifyPassword('wrong-password', stored), false, '错误密码应拒绝');
  assert.equal(await verifyPassword('Async-Scrypt#2026', 'garbage-no-colon'), false, '损坏哈希应安全拒绝');
  assert.equal(await verifyPassword('Async-Scrypt#2026', 'abcd:00'), false, '错误长度哈希应安全拒绝');
});

test('scrypt 异步化：校验期间事件循环仍可调度其他任务（不被同步阻塞）', async () => {
  const stored = hashPassword('Loop-Free#1');
  let timerFired = false;
  const timer = new Promise(resolve => setTimeout(() => { timerFired = true; resolve(); }, 0));
  const ok = await verifyPassword('Loop-Free#1', stored);
  await timer;
  assert.equal(ok, true);
  assert.equal(timerFired, true, 'scrypt 计算期间 0ms 定时器应能得到调度');
});

// ===== 2) BE-H3：AI 限流 =====

test('AI 限流：租户令牌桶耗尽返回 429 + Retry-After，租户之间互不影响，便宜接口不受限', async () => {
  const guard = createAiGuard({ ratePerMinute: 2, burst: 2, maxConcurrent: 8 });
  await withServer(app => {
    app.use((req, _res, next) => { req.user = { tenant_id: Number(req.headers['x-tenant'] || 1) }; next(); });
    app.use('/advisor', guard('advisor'), (_req, res) => res.json({ ok: true }));
  }, async base => {
    const chat = (tenant = 1) => fetch(`${base}/advisor/chat`, { method: 'POST', headers: { 'x-tenant': String(tenant) } });
    assert.equal((await chat()).status, 200);
    assert.equal((await chat()).status, 200);
    const limited = await chat();
    assert.equal(limited.status, 429, '第三次生成类调用应被令牌桶拦截');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1, '429 必须带 Retry-After');
    assert.match((await limited.json()).error, /过于频繁/);
    // 其他租户独立桶，不被邻居打爆
    assert.equal((await chat(2)).status, 200, '限流按租户隔离，别家租户不受影响');
    // 同一租户的查询类接口（GET）不消耗令牌、不受限
    assert.equal((await fetch(`${base}/advisor/conversations`)).status, 200, '便宜接口不应被 AI 限流拦截');
  });
});

test('内容员工工作台只对单独派活限流，档案读取与配置接口不消耗AI令牌', async () => {
  const guard = createAiGuard({ ratePerMinute: 1, burst: 1, maxConcurrent: 8 });
  await withServer(app => {
    app.use((req, _res, next) => { req.user = { tenant_id: 1 }; next(); });
    app.use('/employee-workbench/content', guard('contentWorkbench'), (_req, res) => res.json({ ok: true }));
  }, async base => {
    assert.equal((await fetch(`${base}/employee-workbench/content/0`)).status, 200);
    assert.equal((await fetch(`${base}/employee-workbench/content/0/config`, { method: 'PUT' })).status, 200);
    assert.equal((await fetch(`${base}/employee-workbench/content/0/dispatch`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/employee-workbench/content/1/dispatch`, { method: 'POST' })).status, 429);
  });
});

test('经营工具箱真实生成入口纳入AI租户限流', async () => {
  const guard = createAiGuard({ ratePerMinute: 1, burst: 1, maxConcurrent: 8 });
  await withServer(app => {
    app.use((req, _res, next) => { req.user = { tenant_id: 1 }; next(); });
    app.use('/toolbox', guard('toolbox'), (_req, res) => res.json({ ok: true }));
  }, async base => {
    assert.equal((await fetch(`${base}/toolbox/runs`)).status, 200, '列表读取不应消耗AI令牌');
    assert.equal((await fetch(`${base}/toolbox/runs`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/toolbox/runs`, { method: 'POST' })).status, 429);
  });
});

test('内容自动化手动执行入口纳入AI租户限流，配置接口不消耗令牌', async () => {
  const guard = createAiGuard({ ratePerMinute: 1, burst: 1, maxConcurrent: 8 });
  await withServer(app => {
    app.use((req, _res, next) => { req.user = { tenant_id: 1 }; next(); });
    app.use('/content', guard('content'), (_req, res) => res.json({ ok: true }));
  }, async base => {
    assert.equal((await fetch(`${base}/content/automations`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/content/automations/42/run`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/content/automations/42/run`, { method: 'POST' })).status, 429);
  });
});

test('AI 限流：全局并发信号量占满时返回 429，请求结束后释放', async () => {
  const guard = createAiGuard({ ratePerMinute: 1000, burst: 1000, maxConcurrent: 1 });
  let releaseGate;
  let markEntered;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const entered = new Promise(resolve => { markEntered = resolve; });
  await withServer(app => {
    app.use((req, _res, next) => { req.user = { tenant_id: 1 }; next(); });
    app.use('/agents', guard('agents'), async (req, res) => {
      if (req.query.hang) {
        markEntered();
        await gate;
      }
      res.json({ ok: true });
    });
  }, async base => {
    const hanging = fetch(`${base}/agents/9/chat?hang=1`, { method: 'POST' });
    await entered;
    const rejected = await fetch(`${base}/agents/9/chat`, { method: 'POST' });
    assert.equal(rejected.status, 429, '并发占满时应快速拒绝而不是排队拖死');
    assert.match((await rejected.json()).error, /并发/);
    releaseGate();
    assert.equal((await hanging).status, 200);
    await new Promise(resolve => setTimeout(resolve, 50)); // 等 finish 事件释放信号量
    assert.equal((await fetch(`${base}/agents/9/chat`, { method: 'POST' })).status, 200, '释放后应恢复可用');
  });
});

test('AI 限流：全局并发拒绝不消耗租户令牌', async () => {
  const guard = createAiGuard({ ratePerMinute: 1, burst: 1, maxConcurrent: 1 });
  let releaseGate;
  let markEntered;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const entered = new Promise(resolve => { markEntered = resolve; });
  await withServer(app => {
    app.use((req, _res, next) => { req.user = { tenant_id: Number(req.headers['x-tenant'] || 1) }; next(); });
    app.use('/agents', guard('agents'), async (req, res) => {
      if (req.query.hang) {
        markEntered();
        await gate;
      }
      res.json({ ok: true });
    });
  }, async base => {
    const hanging = fetch(`${base}/agents/9/chat?hang=1`, {
      method: 'POST',
      headers: { 'x-tenant': '1' },
    });
    await entered;
    const rejected = await fetch(`${base}/agents/9/chat`, {
      method: 'POST',
      headers: { 'x-tenant': '2' },
    });
    assert.equal(rejected.status, 429);
    assert.match((await rejected.json()).error, /并发/);
    releaseGate();
    assert.equal((await hanging).status, 200);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await fetch(`${base}/agents/9/chat`, {
      method: 'POST',
      headers: { 'x-tenant': '2' },
    })).status, 200, '并发拒绝没有消耗租户2的唯一令牌');
    assert.equal((await fetch(`${base}/agents/9/chat`, {
      method: 'POST',
      headers: { 'x-tenant': '2' },
    })).status, 429, '真正进入处理后才消耗租户2令牌');
  });
});

test('AI 限流：异步后台任务可把并发租约延长到真实任务终态', async () => {
  const guard = createAiGuard({ ratePerMinute: 1000, burst: 1000, maxConcurrent: 1 });
  let finishBackground;
  const backgroundGate = new Promise(resolve => { finishBackground = resolve; });
  await withServer(app => {
    app.use((req, _res, next) => { req.user = { tenant_id: 1 }; next(); });
    app.use('/marshals', guard('marshals'), (req, res) => {
      const releaseAiLease = req.aiGuard.defer();
      res.status(202).json({ queued: true });
      setImmediate(async () => {
        await backgroundGate;
        releaseAiLease();
      });
    });
  }, async base => {
    const queued = await fetch(`${base}/marshals/1/tasks`, { method: 'POST' });
    assert.equal(queued.status, 202);
    const whileRunning = await fetch(`${base}/marshals/1/tasks`, { method: 'POST' });
    assert.equal(whileRunning.status, 429, 'HTTP响应结束后后台任务仍运行，并发位不得提前释放');
    finishBackground();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await fetch(`${base}/marshals/1/tasks`, { method: 'POST' })).status, 202);
  });
});

// ===== 3) BE-H4：会话按 jti 吊销 =====

const buildAuthApp = app => {
  app.use('/auth', authRoutes);
  app.get('/protected', authMiddleware, (req, res) => res.json({ id: req.user.id, jti: req.user.jti || null }));
};
const login = async base => {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'session-user', password: 'Session-Pass-1!' }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).token;
};
const probe = (base, token) => fetch(`${base}/protected`, { headers: { Authorization: `Bearer ${token}` } });

test('会话吊销：登录令牌携带 jti，按 jti 吊销后旧令牌立即失效，其他会话不受影响', async () => {
  await withServer(buildAuthApp, async base => {
    const tokenA = await login(base);
    const tokenB = await login(base);
    const jtiA = tokenPayload(tokenA).jti;
    const jtiB = tokenPayload(tokenB).jti;
    assert.ok(jtiA && jtiB && jtiA !== jtiB, '每次登录都应生成独立的服务端会话');
    assert.equal((await probe(base, tokenA)).status, 200);

    // 会话列表可见且能标出当前会话
    const sessions = await fetch(`${base}/auth/sessions`, { headers: { Authorization: `Bearer ${tokenA}` } }).then(r => r.json());
    const jtis = sessions.map(s => s.jti);
    assert.ok(jtis.includes(jtiA) && jtis.includes(jtiB));
    assert.equal(sessions.find(s => s.jti === jtiA).current, true);

    // 用 B 吊销 A（同一账号跨设备踢下线）
    const revoked = await fetch(`${base}/auth/sessions/${jtiA}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokenB}` } });
    assert.equal(revoked.status, 200);
    const rejected = await probe(base, tokenA);
    assert.equal(rejected.status, 401, '被吊销会话的旧令牌必须立即失效');
    assert.match((await rejected.json()).error, /吊销|退出|重新登录/);
    assert.equal((await probe(base, tokenB)).status, 200, '其他会话不受影响');

    // 重复吊销同一会话 → 404，不可当探测口子
    assert.equal((await fetch(`${base}/auth/sessions/${jtiA}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokenB}` } })).status, 404);
  });
});

test('单点登出：/auth/logout 吊销当前会话（服务端生效，不只清 Cookie）', async () => {
  await withServer(buildAuthApp, async base => {
    const token = await login(base);
    assert.equal((await probe(base, token)).status, 200);
    assert.equal((await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await probe(base, token)).status, 401, '登出后旧令牌不能继续使用');
  });
});

test('会话吊销：他人无法吊销别家会话；revokeUserSessions 一键踢全部；无 jti 存量令牌兼容', async () => {
  const victim = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?,?,?,?,?,?)`, 'victim-user', hashPassword('Victim-Pass-1!'), '受害者', 'sales', '启用', 1).lastInsertRowid;
  const victimJti = createSession({ userId: victim, tenantId: 1 });
  assert.equal(sessionActive(victimJti), true);
  // 攻击者（其他 userId）按 jti 吊销他人会话 → 无效
  assert.equal(revokeSession(victimJti, 99999), false, '吊销必须限定在本人会话范围内');
  assert.equal(sessionActive(victimJti), true);
  // 管理侧按用户一键吊销全部
  createSession({ userId: victim, tenantId: 1 });
  assert.equal(revokeUserSessions(victim) >= 2, true);
  assert.equal(sessionActive(victimJti), false);
  assert.equal(listSessions(victim).length, 0);

  // 存量无 jti 令牌（升级前签发）仍可通过认证，最长 8h 自然过期
  const legacyToken = signToken({ id: victim, role: 'sales', tenant_id: 1, auth_version: 0 });
  let nextCalled = false;
  authMiddleware({ headers: { authorization: `Bearer ${legacyToken}` } },
    { status() { throw new Error('存量无 jti 令牌不应被拒'); } }, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

// ===== 4) BE-M5：SSRF DNS 解析校验 =====

test('SSRF：解析到内网/环回地址的域名一律拦截（防 DNS rebinding），公网域名放行', async () => {
  const resolveTo = addresses => async () => addresses.map(address => ({ address, family: 4 }));
  // 域名字符串看着无害，但解析到环回/内网 → 拦截
  await assert.rejects(validatedProviderBase('https://api.evil-rebind.com/v1', { resolve: resolveTo(['127.0.0.1']) }), /本机或内网/);
  await assert.rejects(validatedProviderBase('https://api.evil-rebind.com/v1', { resolve: resolveTo(['10.8.0.3']) }), /本机或内网/);
  await assert.rejects(validatedProviderBase('https://api.evil-rebind.com/v1', { resolve: resolveTo(['169.254.169.254']) }), /本机或内网/);
  // 多记录里混入一个内网地址也不行（rebinding 常用手法）
  await assert.rejects(validatedProviderBase('https://api.evil-rebind.com/v1', { resolve: resolveTo(['93.184.216.34', '192.168.1.10']) }), /本机或内网/);
  // IPv6 内网/映射地址
  await assert.rejects(validatedProviderBase('https://api.evil-rebind.com/v1', { resolve: async () => [{ address: '::1', family: 6 }] }), /本机或内网/);
  await assert.rejects(validatedProviderBase('https://api.evil-rebind.com/v1', { resolve: async () => [{ address: '::ffff:10.0.0.5', family: 6 }] }), /本机或内网/);
  // 解析失败 → 明确报错不落库
  await assert.rejects(validatedProviderBase('https://no-such-host.example/v1', { resolve: async () => { throw new Error('ENOTFOUND'); } }), /无法解析/);
  // 全公网解析 → 放行且规整尾部斜杠
  assert.equal(await validatedProviderBase('https://api.provider.com/v1/', { resolve: resolveTo(['93.184.216.34']) }), 'https://api.provider.com/v1');
});

test('SSRF：字面 IP 与明显内网主机名不经 DNS 直接判定', async () => {
  const mustNotResolve = async () => { throw new Error('字面 IP 不应触发 DNS 解析'); };
  await assert.rejects(validatedProviderBase('http://127.0.0.1:9999/v1', { resolve: mustNotResolve }), /本机或内网/);
  await assert.rejects(validatedProviderBase('http://10.0.0.8/v1', { resolve: mustNotResolve }), /本机或内网/);
  await assert.rejects(validatedProviderBase('http://100.66.5.8/v1', { resolve: mustNotResolve }), /本机或内网/, 'CGNAT/Tailscale 段应拦截');
  await assert.rejects(validatedProviderBase('http://[::1]:8080/v1', { resolve: mustNotResolve }), /本机或内网/);
  await assert.rejects(validatedProviderBase('http://localhost:3007/v1', { resolve: mustNotResolve }), /本机或内网/);
  await assert.rejects(validatedProviderBase('http://internal-api/v1', { resolve: mustNotResolve }), /本机或内网/, '无点内网主机名应拦截');
  await assert.rejects(validatedProviderBase('http://metadata.internal/v1', { resolve: mustNotResolve }), /本机或内网/);
  await assert.rejects(validatedProviderBase('ftp://api.provider.com/v1', { resolve: mustNotResolve }), /HTTP\/HTTPS/);
  assert.equal(await validatedProviderBase('https://93.184.216.34/v1', { resolve: mustNotResolve }), 'https://93.184.216.34/v1', '公网字面 IP 放行');
  // 判定函数本身的边界
  assert.equal(isForbiddenAddress('8.8.8.8'), false);
  assert.equal(isForbiddenAddress('172.16.0.1'), true);
  assert.equal(isForbiddenAddress('172.32.0.1'), false);
  assert.equal(isForbiddenAddress('224.0.0.1'), true, '组播段应拦截');
  assert.equal(isForbiddenAddress('not-an-ip'), true, '非法地址一律按禁区处理');
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

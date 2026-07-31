import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const nativeFetch = globalThis.fetch;
const DBP = path.join(os.tmpdir(), `nanowork-release-safety-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
delete process.env.ENABLE_SCHEDULER;

const {
  initSchema,
  migrateV2,
  q,
  getConfig,
  setConfig,
  runWithTenant,
} = await import('../src/db.js');
const {
  schedulerEnabled,
  schedulerMaxConcurrent,
  settleScheduledTasks,
  startSchedulerIfEnabled,
} = await import('../src/engines/scheduler.js');
const { chat } = await import('../src/engines/yunwu.js');
const { webSearch } = await import('../src/engines/websearch.js');
const adminRoutes = (await import('../src/routes/admin.js')).default;

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits)
  VALUES(1,'发布安全测试企业','已开通',10000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status`);
const bossId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('release-safety-boss','unused','发布安全负责人','boss','启用',1)`).lastInsertRowid);
const boss = q.get('SELECT id,name,username,role,tenant_id FROM users WHERE id=?', bossId);

function makeAdminApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(1, () => {
    req.user = { ...boss, ip: '127.0.0.1' };
    next();
  }));
  app.use('/admin', adminRoutes);
  return app;
}

async function withAdminServer(fn) {
  const server = makeAdminApp().listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function jsonRequest(base, pathname, method = 'GET', body) {
  const response = await nativeFetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, json: await response.json().catch(() => ({})) };
}

test('Scheduler 必须显式开启且默认关闭，关闭时既不首跑也不注册定时器', () => {
  assert.equal(schedulerEnabled({}), false);
  assert.equal(schedulerEnabled({ ENABLE_SCHEDULER: '' }), false);
  assert.equal(schedulerEnabled({ ENABLE_SCHEDULER: 'false' }), false);
  assert.equal(schedulerEnabled({ ENABLE_SCHEDULER: 'true' }), true);
  assert.equal(schedulerEnabled({ ENABLE_SCHEDULER: '1' }), true);

  let ticks = 0;
  let intervals = 0;
  const disabled = startSchedulerIfEnabled({
    env: {},
    runTick: () => { ticks += 1; },
    setIntervalFn: () => {
      intervals += 1;
      return { unref() {} };
    },
    logger: { info() {} },
  });
  assert.deepEqual(disabled, { enabled: false, interval: null });
  assert.equal(ticks, 0);
  assert.equal(intervals, 0);

  const enabled = startSchedulerIfEnabled({
    env: { ENABLE_SCHEDULER: 'true' },
    runTick: () => { ticks += 1; },
    setIntervalFn: (_fn, delay) => {
      intervals += 1;
      assert.equal(delay, 30_000);
      return { unref() {} };
    },
    logger: { info() {} },
  });
  assert.equal(enabled.enabled, true);
  assert.equal(ticks, 1);
  assert.equal(intervals, 1);
});

test('Scheduler 跨 tick 不叠加执行，上一轮完成后才允许下一轮进入', async () => {
  let scheduledTick;
  let runs = 0;
  let finishFirst;
  const first = new Promise(resolve => { finishFirst = resolve; });
  const scheduler = startSchedulerIfEnabled({
    env: { ENABLE_SCHEDULER: 'true' },
    runTick: () => {
      runs += 1;
      return runs === 1 ? first : Promise.resolve();
    },
    setIntervalFn: fn => {
      scheduledTick = fn;
      return { unref() {} };
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(runs, 1);
  assert.equal(scheduledTick(), false);
  assert.equal(runs, 1);
  finishFirst();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  await scheduler.tick();
  assert.equal(runs, 2);
});

test('Scheduler 自动任务使用全局并发池，默认最大在途为2且可显式调小或调大', async () => {
  assert.equal(schedulerMaxConcurrent({}), 2);
  assert.equal(schedulerMaxConcurrent({ SCHEDULER_MAX_CONCURRENT: '1' }), 1);
  assert.equal(schedulerMaxConcurrent({ SCHEDULER_MAX_CONCURRENT: '4' }), 4);
  assert.equal(schedulerMaxConcurrent({ SCHEDULER_MAX_CONCURRENT: 'not-a-number' }), 2);

  let inFlight = 0;
  let maxInFlight = 0;
  const tasks = Array.from({ length: 7 }, (_, index) => async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight -= 1;
    if (index === 3) throw new Error('预期内的单任务失败');
    return index;
  });
  const outcomes = await settleScheduledTasks(tasks, 2);
  assert.equal(maxInFlight, 2);
  assert.equal(outcomes.length, tasks.length);
  assert.equal(outcomes[3].status, 'rejected');
  assert.deepEqual(
    outcomes.filter(item => item.status === 'fulfilled').map(item => item.value),
    [0, 1, 2, 4, 5, 6],
  );
});

test('管理员不能再把新 API Key 写入 sys_config，环境变量优先但旧库值仍可兼容读取', async () => {
  const legacyKey = 'sk-legacy-storage-123456789';
  const attemptedKey = 'sk-new-plaintext-must-not-persist';
  setConfig('yunwu_api_key', legacyKey);

  await withAdminServer(async base => {
    let result = await jsonRequest(base, '/admin/api-config');
    assert.equal(result.response.status, 200);
    assert.equal(result.json.channel.key, 'sk-legac****6789');
    assert.equal(result.json.channel.keySource, 'legacy_db');

    process.env.YUNWU_API_KEY = 'sk-env-preferred-987654321';
    result = await jsonRequest(base, '/admin/api-config');
    assert.equal(result.response.status, 200);
    assert.equal(result.json.channel.key, 'sk-env-p****4321');
    assert.equal(result.json.channel.keySource, 'environment');

    result = await jsonRequest(base, '/admin/api-config', 'PUT', { apiKey: attemptedKey });
    assert.equal(result.response.status, 400);
    assert.match(result.json.error, /YUNWU_API_KEY|环境变量/);
    assert.equal(getConfig('yunwu_api_key', null), legacyKey);

    process.env.YUNWU_API_KEY = '';
    result = await jsonRequest(base, '/admin/api-config/legacy-key', 'DELETE', {
      confirm: 'DELETE_LEGACY_YUNWU_KEY',
    });
    assert.equal(result.response.status, 409);
    assert.equal(getConfig('yunwu_api_key', null), legacyKey);

    process.env.YUNWU_API_KEY = 'sk-env-preferred-987654321';
    result = await jsonRequest(base, '/admin/api-config/legacy-key', 'DELETE', {
      confirm: 'wrong-confirmation',
    });
    assert.equal(result.response.status, 400);
    assert.equal(getConfig('yunwu_api_key', null), legacyKey);

    result = await jsonRequest(base, '/admin/api-config/legacy-key', 'DELETE', {
      confirm: 'DELETE_LEGACY_YUNWU_KEY',
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.json.keySource, 'environment');
  });

  assert.equal(getConfig('yunwu_api_key', null), null);
});

test('Yunwu 错误响应被脱敏，Canary 不进入错误消息、堆栈、序列化属性或持久化值', async () => {
  const canary = 'CANARY_PROVIDER_SECRET_sk-never-log-123';
  const originalFetch = globalThis.fetch;
  process.env.YUNWU_API_KEY = 'sk-fake-release-safety';
  setConfig('yunwu_base_url', 'https://93.184.216.34/v1');
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: `invalid token ${canary}`, internal_debug: canary },
  }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
  try {
    await assert.rejects(
      chat({ role: 'boss', messages: [{ role: 'user', content: '本地脱敏测试' }] }),
      error => {
        const observable = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
        assert.doesNotMatch(observable, new RegExp(canary));
        assert.match(error.message, /鉴权|服务/);
        assert.equal(error.status, 502);
        setConfig('release_safety_last_provider_error', {
          message: error.message,
          diagnostic: JSON.stringify(error),
        });
        assert.doesNotMatch(
          JSON.stringify(getConfig('release_safety_last_provider_error', {})),
          new RegExp(canary),
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('管理员连接测试不会把上游 Canary 通过 HTTP 返回', async () => {
  const canary = 'CANARY_ADMIN_HTTP_SECRET_sk-never-return-456';
  const originalFetch = globalThis.fetch;
  process.env.YUNWU_API_KEY = 'sk-fake-admin-connection-test';
  setConfig('yunwu_base_url', 'https://93.184.216.34/v1');
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: `account diagnostic ${canary}` },
  }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
  try {
    await withAdminServer(async base => {
      const result = await jsonRequest(base, '/admin/api-config/test', 'POST', {});
      assert.equal(result.response.status, 200);
      assert.equal(result.json.ok, false);
      assert.doesNotMatch(JSON.stringify(result.json), new RegExp(canary));
      assert.match(result.json.error, /外部|AI|服务/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('外部检索失败不会把 Canary 写入日志或返回说明', async () => {
  const canary = 'CANARY_SEARCH_LOG_SECRET_sk-never-log-789';
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings = [];
  process.env.BOCHA_API_KEY = 'fake-search-key';
  globalThis.fetch = async () => { throw new Error(canary); };
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    const result = await webSearch('本地安全测试', { timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(canary));
    assert.doesNotMatch(warnings.join('\n'), new RegExp(canary));
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    delete process.env.BOCHA_API_KEY;
  }
});

after(() => {
  delete process.env.ENABLE_SCHEDULER;
  process.env.YUNWU_API_KEY = '';
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });
});

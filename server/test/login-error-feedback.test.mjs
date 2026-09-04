import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = requireWeb('typescript');
const source = readFileSync(new URL('../../web/src/api/client.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Run the real client with browser/dependency boundaries mocked: no network or database access.
function clientFixture({ status = 401, data = { error: '用户名或密码错误' }, pathname = '/login', networkError } = {}) {
  const requests = [];
  const notices = [];
  const tenants = [];
  const exports = {};
  const location = { pathname, href: pathname };
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === 'antd') return { message: {
        error: text => notices.push(text),
        warning: text => notices.push(text),
      } };
      if (name === './store-context') return {
        bindStoreContextTenant: tenant => tenants.push(tenant),
        storeHeaders: () => ({}),
      };
      throw new Error(`Unexpected import: ${name}`);
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/auth/logout') return new Response('{}', { status: 200 });
      if (networkError) throw new TypeError('Synthetic network failure');
      return new Response(JSON.stringify(data), { status, headers: { 'x-request-id': 'login-fixture' } });
    },
    window: { setTimeout, clearTimeout },
    location,
    crypto,
    AbortController,
    DOMException,
  });
  return { ...exports, requests, notices, tenants, location };
}

test('login 401 preserves the server error and request metadata without logging out', async () => {
  const client = clientFixture();
  const previousUser = { id: 42, tenant: { id: 7 } };
  client.setAuth('', previousUser);
  await assert.rejects(client.api.post('/auth/login', { username: 'fixture', password: 'fixture-only' }), error => {
    assert.equal(error.message, '用户名或密码错误');
    assert.equal(error.name, 'ApiRequestError');
    assert.equal(error.status, 401);
    assert.equal(error.requestId, 'login-fixture');
    return true;
  });
  assert.deepEqual(client.notices, ['用户名或密码错误']);
  assert.equal(client.getUser(), previousUser);
  assert.deepEqual(client.tenants, [7]);
  assert.deepEqual(client.requests.map(request => request.url), ['/api/auth/login']);
  assert.equal(client.location.href, '/login');
});

test('silent login 401 is returned to the form without a duplicate global toast or redirect', async () => {
  const client = clientFixture({ pathname: '/somewhere' });
  await assert.rejects(client.api.post('/auth/login', {}, { silent: true }), { message: '用户名或密码错误' });
  assert.deepEqual(client.notices, []);
  assert.equal(client.location.href, '/somewhere');
  assert.equal(client.requests.length, 1);
});

for (const pathname of ['/login', '/platform']) {
  test(`protected endpoint 401 still clears auth and redirects from ${pathname}`, async () => {
    const client = clientFixture({ pathname });
    client.setAuth('', { id: 42, tenant: { id: 7 } });
    await assert.rejects(client.api.get('/platform/stats'), { message: '登录已过期' });
    assert.equal(client.getUser(), null);
    assert.deepEqual(client.tenants, [7, null]);
    assert.equal(client.location.href, '/login');
    assert.deepEqual(client.requests.map(request => request.url), ['/api/platform/stats', '/api/auth/logout']);
  });
}

test('login success still returns the user, token and request metadata', async () => {
  const client = clientFixture({ status: 200, data: { token: 'synthetic', user: { id: 42, role: 'platform_super' } } });
  const result = await client.api.post('/auth/login', {}, { silent: true });
  assert.equal(result.user.role, 'platform_super');
  assert.equal(result.token, 'synthetic');
  assert.equal(result.requestId, 'login-fixture');
  assert.deepEqual(client.notices, []);
  assert.equal(client.requests.length, 1);
});

test('rate-limit feedback remains available to the login form', async () => {
  const client = clientFixture({ status: 429, data: { error: '登录尝试过于频繁，请稍后再试' } });
  await assert.rejects(client.api.post('/auth/login', {}, { silent: true }), error => {
    assert.equal(error.message, '登录尝试过于频繁，请稍后再试');
    assert.equal(error.status, 429);
    return true;
  });
  assert.deepEqual(client.notices, []);
  assert.equal(client.requests.length, 1);
});

test('network feedback remains available to the login form', async () => {
  const client = clientFixture({ networkError: true });
  await assert.rejects(client.api.post('/auth/login', {}, { silent: true }), error => {
    assert.equal(error.message, '网络连接失败，请检查网络后重试');
    assert.equal(error.code, 'NETWORK_ERROR');
    return true;
  });
  assert.deepEqual(client.notices, []);
});

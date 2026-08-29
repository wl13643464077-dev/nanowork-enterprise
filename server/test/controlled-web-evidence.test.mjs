import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';

const {
  fetchControlledWebEvidence,
  fetchPublicPageEvidence,
  isPublicWebAddress,
} = await import('../src/engines/controlled-web-evidence.js');

function restoreHttpRequest(original) {
  http.request = original;
  syncBuiltinESMExports();
}

test('受控网页证据拒绝本机/私网地址并保留SSRF边界', { concurrency: false }, async () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://localhost/',
    'http://192.168.1.12/',
    'http://[::1]/',
  ]) {
    await assert.rejects(
      fetchPublicPageEvidence(url, { timeoutMs: 25 }),
      error => error.code === 'CONTROLLED_WEB_URL_UNSAFE',
      `必须拒绝不安全来源：${url}`,
    );
  }
  assert.equal(isPublicWebAddress('127.0.0.1'), false);
  assert.equal(isPublicWebAddress('192.168.1.12'), false);
  assert.equal(isPublicWebAddress('::1'), false);
  assert.equal(isPublicWebAddress('93.184.216.34'), true);
  assert.equal(isPublicWebAddress('198.18.0.38'), false);
  assert.equal(isPublicWebAddress('::ffff:198.18.0.38'), false);
  assert.equal(isPublicWebAddress('::ffff:0:c612:26'), false);
  await assert.rejects(
    fetchPublicPageEvidence('http://198.18.0.38/', { timeoutMs: 25 }),
    error => error.code === 'CONTROLLED_WEB_URL_UNSAFE',
  );
});

test('FQDN只解析到Clash fake-ip时仍可钉住该地址抓取，混有局域网则拒绝', { concurrency: false }, async () => {
  const originalRequest = http.request;
  const pinned = [];
  http.request = (options, onResponse) => {
    pinned.push(options.hostname);
    options.lookup(options.hostname, { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: '198.18.0.38', family: 4 }]);
    });
    const request = new EventEmitter();
    request.end = () => {};
    request.destroy = (error) => {
      if (error) process.nextTick(() => request.emit('error', error));
    };
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/html; charset=utf-8' };
      onResponse(response);
      response.emit('data', Buffer.from(
        `<html><title>代理抓取正文</title><p>${'经透明代理读取的公开网页正文。'.repeat(12)}</p></html>`,
      ));
      response.emit('end');
    });
    return request;
  };
  syncBuiltinESMExports();
  try {
    const isolated = await import(`../src/engines/controlled-web-evidence.js?fake-ip=${process.pid}-${Date.now()}`);
    const result = await isolated.fetchPublicPageEvidence('http://public.example/', {
      timeoutMs: 250,
      lookupFn: async () => [
        { address: '198.18.0.38', family: 4 },
        { address: '::ffff:0:c612:26', family: 6 },
      ],
    });
    assert.equal(result.title, '代理抓取正文');
    assert.match(result.body, /经透明代理读取的公开网页正文/u);
    assert.deepEqual(pinned, ['public.example']);
    await assert.rejects(
      isolated.fetchPublicPageEvidence('http://mixed.example/', {
        timeoutMs: 25,
        lookupFn: async () => [
          { address: '10.10.0.8', family: 4 },
          { address: '198.18.0.38', family: 4 },
        ],
      }),
      error => error.code === 'CONTROLLED_WEB_SSRF_BLOCKED',
    );
    const publicPinned = [];
    http.request = (options, onResponse) => {
      options.lookup(options.hostname, { all: true }, (error, addresses) => {
        assert.equal(error, null);
        publicPinned.push(addresses[0].address);
      });
      const request = new EventEmitter();
      request.end = () => {};
      request.destroy = (error) => {
        if (error) process.nextTick(() => request.emit('error', error));
      };
      process.nextTick(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { 'content-type': 'text/html; charset=utf-8' };
        onResponse(response);
        response.emit('data', Buffer.from(
          `<html><title>公网优先</title><p>${'优先使用真实公网地址抓取正文。'.repeat(12)}</p></html>`,
        ));
        response.emit('end');
      });
      return request;
    };
    syncBuiltinESMExports();
    await isolated.fetchPublicPageEvidence('http://dual.example/', {
      timeoutMs: 250,
      lookupFn: async () => [
        { address: '198.18.0.38', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ],
    });
    assert.deepEqual(publicPinned, ['93.184.216.34']);
  } finally {
    restoreHttpRequest(originalRequest);
  }
});

test('受控网页证据在解析前拒绝敏感query参数，且不触发DNS或HTTP调用', { concurrency: false }, async () => {
  const sensitiveKeys = [
    'api_key',
    'access_token',
    'authorization',
    'auth',
    'signature',
    'secret',
    'token',
    'password',
    'passwd',
    'credential',
    '%61ccess_token',
    '%2561ccess_token',
    '%2574oken',
  ];
  let lookupCalls = 0;
  for (const key of sensitiveKeys) {
    await assert.rejects(
      fetchPublicPageEvidence(`https://public.example/menu?${key}=redacted`, {
        timeoutMs: 25,
        lookupFn: async () => {
          lookupCalls += 1;
          throw new Error('敏感query不得进入DNS解析');
        },
      }),
      error => error.code === 'CONTROLLED_WEB_URL_UNSAFE',
      `必须拒绝敏感query参数：${key}`,
    );
  }
  assert.equal(lookupCalls, 0, '敏感query必须在解析URL阶段fail closed');
});

test('固定公网DNS在http请求端all:true lookup回调下仍可完成正文抓取', { concurrency: false }, async () => {
  const originalRequest = http.request;
  const pinnedLookupCalls = [];
  const requestHosts = [];
  let requestLookupUsedAll = false;
  http.request = (options, onResponse) => {
    requestHosts.push(options.hostname);
    options.lookup(options.hostname, { all: true, verbatim: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
      requestLookupUsedAll = true;
    });
    const request = new EventEmitter();
    request.end = () => {};
    request.destroy = (error) => {
      if (error) process.nextTick(() => request.emit('error', error));
    };
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/html; charset=utf-8' };
      onResponse(response);
      response.emit('data', Buffer.from(
        `<html><title>固定DNS正文</title><p>${'公网固定DNS正文证据。'.repeat(20)}</p></html>`,
      ));
      response.emit('end');
    });
    return request;
  };
  syncBuiltinESMExports();
  try {
    const isolated = await import(`../src/engines/controlled-web-evidence.js?all-lookup=${process.pid}-${Date.now()}`);
    const result = await isolated.fetchPublicPageEvidence('http://public.example/', {
      timeoutMs: 250,
      lookupFn: async (hostname, options) => {
        pinnedLookupCalls.push({ hostname, options });
        return [{ address: '93.184.216.34', family: 4 }];
      },
    });
    assert.equal(result.title, '固定DNS正文');
    assert.equal(result.url, 'http://public.example/');
    assert.match(result.body, /公网固定DNS正文证据/u);
    assert.deepEqual(requestHosts, ['public.example']);
    assert.equal(requestLookupUsedAll, true);
    assert.deepEqual(pinnedLookupCalls, [{
      hostname: 'public.example',
      options: { all: true, verbatim: true },
    }]);
  } finally {
    restoreHttpRequest(originalRequest);
  }
});

test('受控重定向逐跳重新解析公网DNS，并兼容每跳all:true lookup回调', { concurrency: false }, async () => {
  const originalRequest = http.request;
  const pinnedLookupCalls = [];
  const requestHosts = [];
  const requestLookupOptions = [];
  let requestCount = 0;
  http.request = (options, onResponse) => {
    requestCount += 1;
    requestHosts.push(options.hostname);
    requestLookupOptions.push({ ...options });
    const address = options.hostname === 'public.example' ? '93.184.216.34' : '151.101.1.69';
    options.lookup(options.hostname, { all: true, verbatim: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address, family: 4 }]);
    });
    const request = new EventEmitter();
    request.end = () => {};
    request.destroy = (error) => {
      if (error) process.nextTick(() => request.emit('error', error));
    };
    process.nextTick(() => {
      const response = new EventEmitter();
      if (requestCount === 1) {
        response.statusCode = 302;
        response.headers = { location: 'http://redirect.example/final' };
        response.resume = () => {};
      } else {
        response.statusCode = 200;
        response.headers = { 'content-type': 'text/html; charset=utf-8' };
      }
      onResponse(response);
      if (requestCount > 1) {
        response.emit('data', Buffer.from(`<p>${'逐跳重解析正文。'.repeat(20)}</p>`));
        response.emit('end');
      }
    });
    return request;
  };
  syncBuiltinESMExports();
  try {
    const isolated = await import(`../src/engines/controlled-web-evidence.js?redirect-lookup=${process.pid}-${Date.now()}`);
    const result = await isolated.fetchPublicPageEvidence('http://public.example/start', {
      timeoutMs: 250,
      lookupFn: async (hostname, options) => {
        pinnedLookupCalls.push({ hostname, options });
        return [{
          address: hostname === 'public.example' ? '93.184.216.34' : '151.101.1.69',
          family: 4,
        }];
      },
    });
    assert.equal(result.url, 'http://redirect.example/final');
    assert.match(result.body, /逐跳重解析正文/u);
    assert.deepEqual(requestHosts, ['public.example', 'redirect.example']);
    assert.equal(requestLookupOptions.length, 2);
    assert.deepEqual(pinnedLookupCalls.map(call => call.hostname), ['public.example', 'redirect.example']);
    assert.ok(pinnedLookupCalls.every(call => call.options.all === true));
  } finally {
    restoreHttpRequest(originalRequest);
  }
});

test('response主动aborted或提前close时批量抓取仍收敛，其他成功来源保留', { concurrency: false }, async () => {
  const originalRequest = http.request;
  const requestHosts = [];
  http.request = (options, onResponse) => {
    requestHosts.push(options.hostname);
    const address = options.hostname === 'ok.example' ? '93.184.216.34' : '151.101.1.69';
    options.lookup(options.hostname, { all: true, verbatim: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address, family: 4 }]);
    });
    const request = new EventEmitter();
    request.end = () => {};
    request.destroy = (error) => {
      if (error) process.nextTick(() => request.emit('error', error));
    };
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/html; charset=utf-8' };
      onResponse(response);
      if (options.hostname === 'abort.example') {
        response.complete = false;
        response.emit('data', Buffer.from('部分正文'));
        response.emit('aborted');
      } else if (options.hostname === 'close.example') {
        response.complete = false;
        response.emit('data', Buffer.from('提前关闭正文'));
        response.emit('close');
      } else {
        response.complete = true;
        response.emit('data', Buffer.from(`<p>${'完整成功正文。'.repeat(20)}</p>`));
        response.emit('end');
      }
    });
    return request;
  };
  syncBuiltinESMExports();
  try {
    const isolated = await import(`../src/engines/controlled-web-evidence.js?response-abort=${process.pid}-${Date.now()}`);
    const result = await fetchControlledWebEvidence([
      { title: '主动中断', url: 'http://abort.example/' },
      { title: '提前关闭', url: 'http://close.example/' },
      { title: '成功来源', url: 'http://ok.example/' },
    ], {
      limit: 3,
      timeoutMs: 250,
      fetchPageFn: async (url, options = {}) => isolated.fetchPublicPageEvidence(url, {
        ...options,
        lookupFn: async (hostname, lookupOptions) => [{
          address: hostname === 'ok.example' ? '93.184.216.34' : '151.101.1.69',
          family: 4,
          lookupOptions,
        }],
      }),
    });
    assert.equal(result.attempted, true);
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].url, 'http://ok.example/');
    assert.match(result.results[0].body, /完整成功正文/u);
    assert.deepEqual(
      result.evidence.failures.map(item => ({ host: item.host, code: item.code })),
      [
        { host: 'abort.example', code: 'CONTROLLED_WEB_RESPONSE_ABORTED' },
        { host: 'close.example', code: 'CONTROLLED_WEB_RESPONSE_ABORTED' },
      ],
    );
    assert.ok(result.evidence.failures.every(item => !Object.hasOwn(item, 'url')));
    assert.deepEqual(requestHosts.sort(), ['abort.example', 'close.example', 'ok.example']);
  } finally {
    restoreHttpRequest(originalRequest);
  }
});

test('受控WebFetch limit=8时最多抓取8条并保持候选去重顺序', { concurrency: false }, async () => {
  const sources = Array.from({ length: 10 }, (_unused, index) => ({
    title: `候选${index + 1}`,
    url: `https://candidate.example/${index + 1}`,
  }));
  sources.push({ title: '候选重复1', url: 'https://candidate.example/1' });
  const calls = [];
  const result = await fetchControlledWebEvidence(sources, {
    limit: 8,
    timeoutMs: 250,
    fetchPageFn: async (url) => {
      calls.push(url);
      return {
        title: '受控正文',
        url,
        snippet: '受控摘要',
        body: '受控正文满足最小核验长度，允许进入内部提示词。'.repeat(4),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.requested, 8);
  assert.equal(result.evidence.fetched, 8);
  assert.equal(calls.length, 8);
  assert.deepEqual(calls, sources.slice(0, 8).map(source => source.url));
  assert.equal(new Set(calls).size, 8);
});

test('受控网页正文核验会重新记录重定向、MIME和大小失败，并保留成功正文', { concurrency: false }, async () => {
  const calls = [];
  const result = await fetchControlledWebEvidence([
    { title: '正文来源', url: 'https://public.example/body' },
    { title: '重定向来源', url: 'https://public.example/redirect' },
    { title: 'MIME来源', url: 'https://public.example/mime' },
    { title: '超大来源', url: 'https://public.example/oversize' },
    // 去重后仍不得超过受控上限
    { title: '重复正文来源', url: 'https://public.example/body' },
  ], {
    limit: 6,
    timeoutMs: 250,
    fetchPageFn: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/redirect')) {
        throw Object.assign(new Error('重定向目标重新校验失败'), {
          code: 'CONTROLLED_WEB_REDIRECT_FAILED',
        });
      }
      if (url.endsWith('/mime')) {
        throw Object.assign(new Error('响应不是文本类型'), {
          code: 'CONTROLLED_WEB_MIME_INVALID',
        });
      }
      if (url.endsWith('/oversize')) {
        throw Object.assign(new Error('响应超过大小上限'), {
          code: 'CONTROLLED_WEB_TOO_LARGE',
        });
      }
      return {
        title: '正文来源标题',
        url,
        snippet: '正文来源摘要',
        body: '公开网页正文已抽取并净化；该正文可供岗位逐字核验，但不构成业务采纳授权。',
      };
    },
  });

  assert.equal(result.attempted, true);
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].body.includes('公开网页正文已抽取并净化'), true);
  assert.equal(result.evidence.requested, 4);
  assert.equal(result.evidence.fetched, 1);
  assert.deepEqual(
    result.evidence.failures.map(item => item.code),
    [
      'CONTROLLED_WEB_REDIRECT_FAILED',
      'CONTROLLED_WEB_MIME_INVALID',
      'CONTROLLED_WEB_TOO_LARGE',
    ],
  );
  assert.ok(calls.every(call => call.options.timeoutMs === 250));
  assert.ok(calls.every(call => call.options.signal === null));
});

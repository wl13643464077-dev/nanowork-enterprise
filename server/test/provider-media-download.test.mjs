import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NODE_ENV = 'test';
process.env.NANOWORK_DB = ':memory:';
const { fetchProviderMediaBytes, parseProviderMediaUrl } = await import('../src/engines/provider-media-download.js');

test('媒体URL拒绝私网、带凭据、非HTTPS、非标准端口，包括IPv6和尾点', () => {
  for (const url of ['http://cdn.example/a', 'https://u:p@cdn.example/a', 'https://127.0.0.1/a', 'https://localhost./a', 'https://a.local./a', 'https://[::1]/a', 'https://[::ffff:127.0.0.1]/a', 'https://2130706433/a', 'https://cdn.example:8080/a', 'file:///secret']) {
    assert.throws(() => parseProviderMediaUrl(url));
  }
  assert.equal(parseProviderMediaUrl('https://cdn.example/a?signature=temporary#x').hash, '');
});

test('生产请求绑定已校验DNS地址并保留TLS域名，拒绝混合私网解析', async () => {
  const requests = [];
  const requestFactory = (options, callback) => {
    requests.push(options);
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const body = Readable.from([Buffer.from('sound')]);
      body.statusCode = 200;
      body.headers = { 'content-type': 'audio/mpeg' };
      callback(body);
    });
    return req;
  };
  const result = await fetchProviderMediaBytes('https://cdn.example/audio', {
    kind: 'audio', requestFactory, lookupFn: async () => [{ address: '8.8.8.8' }],
  });
  assert.equal(result.bytes.toString(), 'sound');
  const options = requests[0];
  assert.equal(options.servername, 'cdn.example');
  assert.equal(options.agent, false);
  options.lookup('cdn.example', { all: true }, (err, records) => { assert.equal(err, null); assert.deepEqual(records, [{ address: '8.8.8.8', family: 4 }]); });
  await assert.rejects(fetchProviderMediaBytes('https://cdn.example/audio', {
    kind: 'audio', requestFactory, lookupFn: async () => [{ address: '8.8.8.8' }, { address: '192.168.1.1' }],
  }), /纯公网/u);
  assert.equal(requests.length, 1);
});

test('重定向逐跳复验，私网不会进入第二次请求', async () => {
  let calls = 0;
  await assert.rejects(fetchProviderMediaBytes('https://cdn.example/a?signature=secret', {
    kind: 'audio', fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
    },
  }), error => !error.message.includes('secret') && /公网/u.test(error.message));
  assert.equal(calls, 1);
});

test('流式未知长度在超限时取消读取，不分配整个响应', async () => {
  let canceled = false, reads = 0;
  const body = new ReadableStream({
    pull(controller) { reads += 1; controller.enqueue(new Uint8Array(8)); },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 });
  await assert.rejects(fetchProviderMediaBytes('https://cdn.example/a', {
    maxBytes: 10, fetchImpl: async () => new Response(body, { headers: { 'content-type': 'video/mp4' } }),
  }), error => error.code === 'PROVIDER_MEDIA_TOO_LARGE');
  assert.equal(canceled, true);
  assert.equal(reads, 2);
});

test('MIME/声明长度/跳数/预取消和错误脱敏', async () => {
  for (const response of [
    new Response('html', { headers: { 'content-type': 'text/html' } }),
    new Response('large', { headers: { 'content-length': '2000' } }),
    new Response('zip', { headers: { 'content-encoding': 'gzip' } }),
  ]) await assert.rejects(fetchProviderMediaBytes('https://cdn.example/a', { maxBytes: 100, fetchImpl: async () => response }));
  let calls = 0;
  await assert.rejects(fetchProviderMediaBytes('https://cdn.example/a', { fetchImpl: async () => { calls += 1; return new Response(null, { status: 302, headers: { location: '/again' } }); } }), /重定向/u);
  assert.equal(calls, 4);
  await assert.rejects(fetchProviderMediaBytes('https://cdn.example/a', { signal: AbortSignal.abort(), fetchImpl: async () => { throw new Error('not reached'); } }), /取消/u);
  await assert.rejects(fetchProviderMediaBytes('https://cdn.example/a?token=secret', { fetchImpl: async () => { throw new Error('https://cdn.example/a?token=secret'); } }), error => !error.message.includes('secret'));
});

async function withProxyConfig(env, callback) {
  const keys = ['PROVIDER_MEDIA_TRUSTED_PROXY', 'PROVIDER_MEDIA_TRUSTED_PROXY_HOSTS', 'NANOWORK_ACCEPTANCE_PROVIDER_PROXY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const fetch = globalThis.fetch;
  try {
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    await callback();
  } finally {
    globalThis.fetch = fetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('正式可信系统代理仅限精确CDN名单，兼容fake-IP且逐跳限制HTTPS下载', async () => {
  await withProxyConfig({ PROVIDER_MEDIA_TRUSTED_PROXY: '1', PROVIDER_MEDIA_TRUSTED_PROXY_HOSTS: 'a.cdn.example,b.cdn.example' }, async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push(url.hostname);
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers['Accept-Encoding'], 'identity');
      return url.hostname === 'a.cdn.example'
        ? new Response(null, { status: 302, headers: { location: 'https://b.cdn.example/final?signature=private' } })
        : new Response('real-media', { headers: { 'content-type': 'video/mp4' } });
    };
    const result = await fetchProviderMediaBytes('https://a.cdn.example/start', {
      lookupFn: async () => assert.fail('可信系统代理自行解析域名，不能预先钉住fake-IP'),
      requestFactory: () => assert.fail('已授权代理不使用默认钉住连接'),
    });
    assert.equal(result.bytes.toString(), 'real-media');
    assert.deepEqual(calls, ['a.cdn.example', 'b.cdn.example']);
    globalThis.fetch = async () => new Response('too large', { headers: { 'content-type': 'video/mp4' } });
    await assert.rejects(fetchProviderMediaBytes('https://a.cdn.example/a', { maxBytes: 3 }), error => error.code === 'PROVIDER_MEDIA_TOO_LARGE');
  });
});

test('代理CDN的任意跨域/降级/私网跳转均在请求前拒绝，非名单域名仍检查公网DNS', async () => {
  await withProxyConfig({ PROVIDER_MEDIA_TRUSTED_PROXY: '1', PROVIDER_MEDIA_TRUSTED_PROXY_HOSTS: 'a.cdn.example' }, async () => {
    for (const destination of ['https://b.cdn.example/a', 'https://a.cdn.example.evil.test/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'http://a.cdn.example/a', 'https://a.cdn.example:8443/a', 'https://user:pass@a.cdn.example/a']) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: destination } }); };
      await assert.rejects(fetchProviderMediaBytes('https://a.cdn.example/start?token=private'), error => error.code === 'PROVIDER_MEDIA_URL_UNSAFE' && !error.message.includes('private'));
      assert.equal(calls, 1, destination);
    }
    globalThis.fetch = async () => assert.fail('不在名单内不能走代理');
    for (const host of ['other.example', 'sub.a.cdn.example', 'a.cdn.example.evil.test']) {
      await assert.rejects(fetchProviderMediaBytes(`https://${host}/a`, {
        lookupFn: async () => [{ address: '198.18.0.1' }], requestFactory: () => assert.fail('保留地址不能发起连接'),
      }), error => error.code === 'PROVIDER_MEDIA_URL_UNSAFE');
    }
  });
});

test('代理必须显式开启和配置有效精确域名，旧验收开关不能绕过默认公网防护', async () => {
  for (const hosts of ['', '*.aliyuncs.com', 'https://cdn.example', '127.0.0.1', 'cdn.example:443', 'cdn.example,', 'cdn.local', 'cdn.example/path']) {
    await withProxyConfig({ PROVIDER_MEDIA_TRUSTED_PROXY: '1', PROVIDER_MEDIA_TRUSTED_PROXY_HOSTS: hosts }, async () => {
      globalThis.fetch = async () => assert.fail('无效配置不能联网');
      await assert.rejects(fetchProviderMediaBytes('https://cdn.example/a'), error => error.code === 'PROVIDER_MEDIA_PROXY_CONFIG_INVALID');
    });
  }
  await withProxyConfig({ PROVIDER_MEDIA_TRUSTED_PROXY_HOSTS: 'a.aliyuncs.com', NANOWORK_ACCEPTANCE_PROVIDER_PROXY: '1' }, async () => {
    globalThis.fetch = async () => assert.fail('旧验收标志不是生产下载授权');
    await assert.rejects(fetchProviderMediaBytes('https://a.aliyuncs.com/a', {
      lookupFn: async () => [{ address: '198.18.0.1' }], requestFactory: () => assert.fail('默认拒绝保留地址'),
    }), error => error.code === 'PROVIDER_MEDIA_URL_UNSAFE');
  });
});

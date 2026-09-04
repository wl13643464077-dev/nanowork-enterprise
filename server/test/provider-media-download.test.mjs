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

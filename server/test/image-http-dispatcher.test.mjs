import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Agent } from 'undici';
import { imageHttpDispatcher } from '../src/engines/image-http-dispatcher.js';

test('image transport overrides fetch parser deadlines and preserves request options', () => {
  const seen = [];
  const handler = {};
  const dispatcher = imageHttpDispatcher(900000, { dispatch: (options, h) => { seen.push({ options, h }); return true; } });
  assert.equal(dispatcher.dispatch({ path: '/v1/images/edits', headersTimeout: 300000, bodyTimeout: 300000 }, handler), true);
  assert.equal(seen[0].options.headersTimeout, 900000);
  assert.equal(seen[0].options.bodyTimeout, 900000);
  assert.equal(seen[0].options.path, '/v1/images/edits');
  assert.equal(seen[0].h, handler);
  const bounded = imageHttpDispatcher(Infinity, { dispatch: options => options.headersTimeout });
  assert.equal(bounded.dispatch({}, handler), 900000);
});

test('real fetch receives delayed image headers and remains cancellable', async t => {
  const server = http.createServer((req, res) => {
    const timer = setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"url":"test"}]}'); }, 150);
    res.once('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new Agent({ headersTimeout: 20, bodyTimeout: 20 });
  t.after(async () => { await agent.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/v1/images/edits`;
  const response = await fetch(url, { dispatcher: imageHttpDispatcher(1000, agent), signal: AbortSignal.timeout(1000) });
  assert.equal((await response.json()).data[0].url, 'test');
  await assert.rejects(fetch(url, { dispatcher: imageHttpDispatcher(900000, agent), signal: AbortSignal.timeout(25) }), { name: 'TimeoutError' });
});

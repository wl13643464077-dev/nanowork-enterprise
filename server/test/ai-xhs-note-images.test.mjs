import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import express from 'express';
import { once } from 'node:events';

Object.assign(process.env, { NANOWORK_DB: ':memory:', NANOWORK_TEST_TEMPLATE_AI: '1', NODE_ENV: 'test',
  ENABLE_SCHEDULER: 'false', ENABLE_BACKGROUND_EMBEDDINGS: 'false', YUNWU_API_KEY: 'test-only-xhs-image-key',
  YUNWU_BASE_URL: 'https://xhs-image.test/v1', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' });
const { db, q, initSchema, migrateV2, runWithTenant, setTenantConfig } = await import('../src/db.js');
const { editImage } = await import('../src/engines/yunwu.js');
const { estimateMaxCredits, holdCredits, settleHold, getSupplierExpense } = await import('../src/engines/credits.js');
const { saveUploadedFile } = await import('../src/engines/filehub.js');
const { renderSvgToPng, detectImageFormat } = await import('../src/engines/poster-text-overlay.js');
const { XHS_NOTE_SYSTEM, normalizeXhsNoteInput, xhsImagePrompt, xhsImageLayoutSvg, renderXhsImage, XHS_STYLES, XHS_IMAGE_TIMEOUT_MS, parseXhsNoteOutput } = await import('../src/engines/ai-xhs-note.js');
const { default: routes, executeXhsImageJob, createXhsNoteFromConfirmedChat, startXhsNoteImages } = await import('../src/routes/ai-xhs-note.js');
initSchema(); migrateV2();
assert.equal(db.prepare('PRAGMA database_list').get().file, '');
const tenantId = 9_600_000 + process.pid * 2;
const tenantOther = tenantId + 1;
for (const id of [tenantId, tenantOther]) q.run("INSERT INTO tenants(id,name,status,credits) VALUES(?,'配图隔离测试','已开通',1000000)", id);
const userId = Number(q.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES(?,'not-login','测试老板','boss','启用',?)", `xhs-images-${process.pid}`, tenantId).lastInsertRowid);
const otherId = Number(q.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES(?,'not-login','其他老板','boss','启用',?)", `xhs-images-other-${process.pid}`, tenantOther).lastInsertRowid);
const png = await renderSvgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#804a2b"/><circle cx="64" cy="64" r="40" fill="#ce7333"/></svg>', { width: 128, height: 128 });
const actor = { id: userId, tenant_id: tenantId, role: 'boss' };
const inputFile = runWithTenant(tenantId, () => saveUploadedFile({ name: '合成锅型参考.png', mime: 'image/png', b64: png.toString('base64'), userId, purpose: 'xhs-image-test' })).row;
const originalFetch = globalThis.fetch;
const allowed = new Set();
globalThis.fetch = (url, init) => {
  assert.ok(allowed.has(new URL(typeof url === 'string' ? url : url.url || url).origin), '不允许真实供应商联网');
  return originalFetch(url, init);
};
let mode = 'success';
let imageGate = null;
let textCalls = 0;
const imageCalls = [];
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const runtime = {
  available: () => true, imageAvailable: () => true, estimate: () => 500,
  generate: async args => {
    textCalls++;
    assert.match(args.system, /火锅与水煮牛肉不能混淆/);
    assert.ok(args.messages[0].content.some(part => part.image_url?.url === `data:image/png;base64,${png.toString('base64')}`));
    return { mode: 'api', model: args.model, usage: { inputTokens: 100, outputTokens: 100 },
      text: JSON.stringify({ title: '红汤清汤同桌，今晚怎么涮', body: '照片里的圆锅分成红汤和清汤，配菜围着锅摆开。罗二火锅这一桌，先从看得见的锅型与摆盘说起。',
        tags: ['罗二火锅', '火锅'], firstComment: '你会先选红汤还是清汤？', coverText: '红汤清汤，同桌开涮',
        visualSummary: '圆形分区锅，外圈红色汤底、中心浅色汤底；桌上肉片和不明丝状配菜。', imagePlan: [{ fileId: inputFile.id, caption: '锅型参考' }] }) };
  },
  editImage: params => editImage({ ...params, fetchFn: async (url, options) => {
    const prompt = options.body.get('prompt');
    const role = prompt.includes('唯一拍摄任务：菜品近景') ? 'detail' : /唯一拍摄任务：(用餐|桌面用餐)场景/.test(prompt) ? 'scene' : 'cover';
    const references = [...options.body.entries()].filter(([key]) => key === 'image' || key === 'image[]');
    imageCalls.push({ role, prompt, url, key: new Headers(options.headers).get('idempotency-key'), references,
      model: options.body.get('model'), size: options.body.get('size'), timeoutMs: params.timeoutMs });
    if (imageGate) await imageGate;
    if (role === 'detail' && mode === 'rejected') return response({ error: { message: 'rate limit' } }, 429);
    if (role === 'detail' && mode === 'unknown') throw new TypeError('network private-provider-detail');
    if (mode === 'empty') return response({ data: [] });
    if (mode === 'model-unavailable') return response({ error: { code: '1001', message: '参数错误:model参数对应模型不存在或未授权' } }, 400);
    return response({ data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 17, output_tokens: 29 } });
  } }),
};
const app = express();
app.use(express.json());
app.locals.aiXhsNoteRuntime = runtime;
app.use((req, _res, next) => {
  const other = req.headers['x-other'] === '1';
  req.user = other ? { id: otherId, tenant_id: tenantOther, role: 'boss' } : actor;
  runWithTenant(req.user.tenant_id, next);
});
app.use('/content', routes);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
allowed.add(base);
const request = async (route, body, headers = {}) => {
  const res = await fetch(`${base}/content${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
};
let sequence = 0;
const input = extra => ({ imageCount: 3, brandName: '罗二火锅', brief: '仅测试。照片为合成锅型参考，不把丝状配菜猜为鸭肠或毛肚。', fileIds: [inputFile.id], requestKey: `image-regression-${++sequence}`, ...extra });
const wait = async (id, condition = job => job.status !== 'running' && !['pending', 'running'].includes(job.imageGeneration.status)) => {
  for (let i = 0; i < 500; i++) {
    const job = (await request(`/ai-xhs-note/jobs/${id}`)).body;
    if (condition(job)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('本地任务未及时结束');
};
const holds = id => q.all("SELECT h.* FROM credit_holds h JOIN media_jobs m ON m.id=h.ref_id AND m.tenant_id=h.tenant_id WHERE h.tenant_id=? AND h.ref_type='media_job' AND json_extract(m.snapshot_json,'$.contentId')=?", tenantId, id);
after(async () => {
  await new Promise(resolve => server.close(resolve));
  for (const file of q.all('SELECT file_path FROM uploaded_files WHERE tenant_id=?', tenantId)) fs.rmSync(file.file_path, { force: true });
  db.close(); globalThis.fetch = originalFetch;
});

test('Image2 multipart参考图、幂等键、用量与空响应契约；正文建议不裁原文', async () => {
  let calls = 0;
  await assert.rejects(editImage({ prompt: 'test', images: [`data:image/png;base64,${png.toString('base64')}`],
    idempotencyKey: 'bad\nkey', fetchFn: async () => { calls++; return response({}); } }));
  assert.equal(calls, 0);
  await assert.rejects(editImage({ prompt: 'test', images: [`data:image/png;base64,${png.toString('base64')}`],
    fetchFn: async () => response({ data: [] }) }), error => error.providerReason === 'upstream' && error.responseStatus === 200 && error.responseEmpty);
  assert.match(XHS_NOTE_SYSTEM, /150–250字/);
  assert.match(XHS_NOTE_SYSTEM, /视觉构思/);
  assert.throws(() => normalizeXhsNoteInput(input({ includeDiner: 'yes' })), { status: 400 });
  const photographic = xhsImagePrompt({ input: input({ brief: 'GENERATE_THREE_AND_WRITE_250_WORDS' }), output: { visualSummary: '红汤清汤分区圆锅' },
    role: 'detail', skillMethods: 'COPYWRITING_SKILL_SHOULD_NOT_REACH_IMAGE' });
  assert.match(photographic, /Single photographic frame/);
  assert.match(photographic, /NO text, NO collage, NO panels/);
  assert.match(photographic, /红汤清汤分区圆锅/);
  assert.doesNotMatch(photographic, /GENERATE_THREE_AND_WRITE_250_WORDS|COPYWRITING_SKILL_SHOULD_NOT_REACH_IMAGE/);
});

test('后台Image2显式360秒预算允许106秒返回，不受前台105秒上限截断', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let capturedSignal;
    const pending = editImage({ prompt: '本地虚拟时间验收', images: [`data:image/png;base64,${png.toString('base64')}`],
      timeoutMs: 360000, fetchFn: async (_url, { signal }) => {
        capturedSignal = signal;
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          setTimeout(() => resolve(response({ data: [{ b64_json: png.toString('base64') }] })), 106000);
        });
      } });
    t.mock.timers.tick(106000);
    const result = await pending;
    assert.equal(capturedSignal.aborted, false);
    assert.equal(result.b64, png.toString('base64'));
  } finally { t.mock.timers.reset(); }
});

test('兼容3图真正图生图，文案先到、选择不被覆盖、逐图文件可读与独立结算，同请求不重跑', async () => {
  let release;
  imageGate = new Promise(resolve => { release = resolve; });
  const payload = input();
  const start = await request('/ai-xhs-note', payload);
  assert.equal(start.status, 202, JSON.stringify(start.body));
  const early = await wait(start.body.id, job => job.status === 'success' && job.imageGeneration.status === 'running');
  assert.ok(early.output.body);
  assert.equal(early.generateImages, true);
  assert.equal(early.includeDiner, false);
  const edit = { title: '老板保留标题', body: '老板已经编辑的完整正文', tags: ['自选话题'], firstComment: '先涮什么？' };
  await request(`/ai-xhs-note/jobs/${early.id}/decision`, { decision: 'adopted', output: edit });
  release(); imageGate = null;
  const result = await wait(early.id);
  assert.equal(result.imageGeneration.status, 'success', JSON.stringify(result));
  assert.equal(result.imageGeneration.items.length, 3);
  assert.equal(result.decision, 'adopted');
  assert.equal(result.output.body, edit.body);
  assert.notEqual(result.originalOutput.body, edit.body);
  const calls = imageCalls.slice(-3);
  for (const call of calls) {
    assert.equal(call.url, 'https://xhs-image.test/v1/images/edits');
    assert.equal(call.model, 'gpt-image-2');
    assert.equal(call.size, '1024x1536');
    assert.equal(call.timeoutMs, 900000, '正式后台图片请求总预算有界15分钟');
    assert.ok(call.key.startsWith(`xhs-image:${tenantId}:`));
    assert.equal(call.references.length, 1);
    assert.deepEqual(Buffer.from(await call.references[0][1].arrayBuffer()), png);
    assert.match(call.prompt, /罗二火锅/);
    assert.ok(call.prompt.length <= 1000);
  }
  assert.match(calls.find(call => call.role === 'scene').prompt, /不新增人物/);
  const price = estimateMaxCredits('image', 'gpt-image-2');
  const ledger = holds(result.id);
  assert.equal(ledger.length, 3);
  assert.ok(ledger.every(hold => hold.kind === 'image' && hold.status === 'settled' && hold.settled_credits === price));
  for (const item of result.imageGeneration.items) {
    assert.equal(item.status, 'success');
    assert.equal(item.billing.state, 'settled');
    assert.equal(item.canRetry, false);
    const file = q.get('SELECT * FROM uploaded_files WHERE tenant_id=? AND id=?', tenantId, item.fileId);
    assert.equal(file.file_url, item.url);
    const format = detectImageFormat(fs.readFileSync(file.file_path));
    assert.equal(format.width, 768); assert.equal(format.height, 1024);
  }
  assert.equal(result.billing.balance, q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits);
  const count = imageCalls.length;
  await request('/ai-xhs-note', payload);
  assert.equal(imageCalls.length, count); assert.equal(textCalls, 1);
  assert.equal((await request(`/ai-xhs-note/jobs/${result.id}/retry-images`, { imageIds: ['cover'] })).status, 409);
  assert.equal((await request(`/ai-xhs-note/jobs/${result.id}`, undefined, { 'x-other': '1' })).status, 404);
  assert.equal((await request(`/ai-xhs-note/jobs/${result.id}/retry-images`, { imageIds: ['detail'] }, { 'x-other': '1' })).status, 404);
});

test('单图明确拒绝只退该次，重试仅失败图且并发不重复；可选成年AI人物不冒充顾客', async () => {
  mode = 'rejected';
  const start = await request('/ai-xhs-note', input({ includeDiner: true }));
  const partial = await wait(start.body.id);
  assert.equal(partial.status, 'success');
  assert.equal(partial.imageGeneration.status, 'partial');
  const failed = partial.imageGeneration.items.find(item => item.id === 'detail');
  assert.equal(failed.canRetry, true);
  assert.equal(failed.billing.state, 'released');
  assert.equal(failed.billing.chargedCredits, 0);
  const scene = imageCalls.slice(-3).find(call => call.role === 'scene');
  assert.match(scene.prompt, /明确成年的AI女性/);
  assert.match(scene.prompt, /不是实际顾客/);
  const succeeded = partial.imageGeneration.items.filter(item => item.status === 'success').map(item => item.url);
  const before = imageCalls.length;
  mode = 'success';
  let release; imageGate = new Promise(resolve => { release = resolve; });
  try {
    const first = await request(`/ai-xhs-note/jobs/${partial.id}/retry-images`, { imageIds: ['detail'] });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    const concurrent = await request(`/ai-xhs-note/jobs/${partial.id}/retry-images`, { imageIds: ['detail'] });
    assert.equal(concurrent.status, 409);
  } finally { release(); imageGate = null; }
  const done = await wait(partial.id);
  assert.equal(done.imageGeneration.status, 'success');
  assert.equal(imageCalls.length, before + 1);
  assert.deepEqual(done.imageGeneration.items.filter(item => item.id !== 'detail').map(item => item.url), succeeded);
  assert.equal(textCalls, 2, '重试图片不重复文案调用');
  const records = holds(done.id);
  assert.equal(records.length, 4);
  assert.equal(records.filter(row => row.settled_credits === 0).length, 1);
  assert.equal(records.filter(row => row.settled_credits > 0).length, 3);
});

test('超时或空响应无图全退且不自动重跑；成功图和正文保留，用户明确重试才新建占扣', async () => {
  mode = 'unknown';
  const start = await request('/ai-xhs-note', input());
  const partial = await wait(start.body.id);
  assert.equal(partial.status, 'success');
  assert.equal(partial.imageGeneration.status, 'partial');
  const failed = partial.imageGeneration.items.find(item => item.id === 'detail');
  assert.equal(failed.billing.state, 'released');
  assert.equal(failed.billing.chargedCredits, 0);
  assert.equal(failed.canRetry, true);
  assert.equal(failed.canRecover, false);
  const refundedHold = holds(partial.id).find(hold => hold.ref_id === failed.mediaJobId);
  const expense = getSupplierExpense(refundedHold.id, tenantId);
  assert.ok(expense.refundedAt);
  assert.equal(expense.refundedCredits, refundedHold.held_credits);
  assert.equal(expense.status, 'pending', '供应商结果未知仍由平台独立对账，不占用户积分');
  assert.equal(failed.url, null);
  assert.doesNotMatch(JSON.stringify(partial), /private-provider-detail/);
  const diagnostic = JSON.parse(q.get('SELECT snapshot_json FROM media_jobs WHERE tenant_id=? AND id=?', tenantId, failed.mediaJobId).snapshot_json).providerFailure;
  assert.equal(diagnostic.reason, 'network');
  assert.equal(diagnostic.httpStatus, null);
  assert.equal(diagnostic.timeoutMs, 900000);
  assert.ok(diagnostic.elapsedMs >= 0);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-provider-detail/);
  const before = imageCalls.length;
  assert.equal((await request(`/ai-xhs-note/jobs/${partial.id}/retry-images`, { imageIds: ['cover'] })).status, 409);
  await request(`/ai-xhs-note/jobs/${partial.id}`);
  assert.equal(imageCalls.length, before);
  // A caller cannot reset an already attempted row to an unstarted queued job.
  // Refunded failed work requires the explicit retry route and a new hold.
  for (const item of partial.imageGeneration.items.filter(item => ['detail', 'cover'].includes(item.id))) {
    const original = q.get('SELECT snapshot_json FROM media_jobs WHERE tenant_id=? AND id=?', tenantId, item.mediaJobId).snapshot_json;
    try {
      q.run('UPDATE media_jobs SET snapshot_json=? WHERE tenant_id=? AND id=?', JSON.stringify({ ...JSON.parse(original), status: 'pending', billing: { state: 'not_held' } }), tenantId, item.mediaJobId);
      await assert.rejects(runWithTenant(tenantId, () => executeXhsImageJob({ id: item.mediaJobId }, { id: partial.id }, null, runtime)), error => error.status === 409);
      assert.equal(imageCalls.length, before);
    } finally { q.run('UPDATE media_jobs SET snapshot_json=? WHERE tenant_id=? AND id=?', original, tenantId, item.mediaJobId); }
  }
  mode = 'success';
  assert.equal((await request(`/ai-xhs-note/jobs/${partial.id}/retry-images`, { imageIds: ['detail'] })).status, 202);
  const retried = await wait(partial.id);
  assert.equal(retried.imageGeneration.status, 'success');
  assert.equal(imageCalls.length, before + 1);
  assert.equal(holds(partial.id).length, 4);
  assert.equal(getSupplierExpense(refundedHold.id, tenantId).refundedAt, expense.refundedAt);
  mode = 'empty';
  const emptyStart = await request('/ai-xhs-note', input());
  const empty = await wait(emptyStart.body.id);
  assert.equal(empty.status, 'success');
  assert.equal(empty.imageGeneration.status, 'failed');
  assert.ok(empty.imageGeneration.items.every(item => item.status === 'failed' && item.billing.state === 'released' && item.canRetry && !item.url));
  const count = imageCalls.length;
  const textOnly = await request('/ai-xhs-note', input({ generateImages: false }));
  assert.equal((await wait(textOnly.body.id)).imageGeneration.status, 'disabled');
  assert.equal(imageCalls.length, count);
  const quote = (await request('/ai-xhs-note/options')).body;
  assert.equal(quote.imageTotalCredits, 6 * quote.creditsPerImage);
  assert.equal(quote.imageCount, 6);
});

test('360拒绝Image2模型时保留正文、退回图片预授权，明确路由异常且不自动反复请求', async () => {
  mode = 'model-unavailable';
  const before = imageCalls.length;
  try {
    const started = await request('/ai-xhs-note', input());
    const result = await wait(started.body.id);
    assert.equal(result.status, 'success');
    assert.ok(result.output.body);
    assert.equal(result.imageGeneration.status, 'failed');
    assert.equal(imageCalls.length, before + 3);
    for (const image of result.imageGeneration.items) {
      assert.equal(image.billing.state, 'released');
      const saved = JSON.parse(q.get('SELECT snapshot_json FROM media_jobs WHERE tenant_id=? AND id=?', tenantId, image.mediaJobId).snapshot_json);
      assert.equal(saved.providerFailure.reason, 'model_unavailable');
      assert.match(image.error, /模型路由.*预授权已退回.*文案/u);
      assert.doesNotMatch(image.error, /开通.*权限|修改.*输入/u);
    }
    assert.ok(holds(result.id).every(hold => hold.status !== 'held' && hold.settled_credits === 0));
  } finally { mode = 'success'; }
});

test('本地排版失败仍交付已经付费的Image2原图，明确AI创意警告，不重跑模型', async () => {
  mode = 'success';
  runtime.renderImage = async () => { throw new Error('local-renderer-unavailable'); };
  const before = imageCalls.length;
  try {
    const start = await request('/ai-xhs-note', input());
    const result = await wait(start.body.id);
    assert.equal(result.status, 'success');
    assert.equal(result.imageGeneration.status, 'success');
    assert.equal(imageCalls.length, before + 3);
    for (const item of result.imageGeneration.items) {
      assert.equal(item.status, 'success');
      assert.equal(item.billing.state, 'settled');
      assert.equal(item.url, item.originalUrl);
      assert.match(item.warning, /Image2原图.*排版未完成/);
      assert.match(item.warning, /AI创意/);
      const stored = q.get('SELECT file_path FROM uploaded_files WHERE tenant_id=? AND id=?', tenantId, item.fileId);
      assert.deepEqual(fs.readFileSync(stored.file_path), png, '付费原始图字节完整保留');
      assert.equal(item.canRetry, false, '本地排版失败不能再次收费生成');
    }
    assert.equal(holds(result.id).filter(hold => hold.status === 'settled').length, 3);
  } finally { delete runtime.renderImage; }
});

test('无图片权限的报价不可用且创建前拒绝不收费；关闭配图仍可生成文案', async () => {
  setTenantConfig('feature_flags', { 'content.image': [] }, tenantId);
  const beforeImages = imageCalls.length;
  const beforeText = textCalls;
  const balance = q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits;
  try {
    const quote = (await request('/ai-xhs-note/options')).body;
    assert.equal(quote.available, false);
    assert.match(quote.reason, /未开通图片生成/);
    const denied = await request('/ai-xhs-note', input());
    assert.equal(denied.status, 403);
    assert.equal(imageCalls.length, beforeImages);
    assert.equal(textCalls, beforeText);
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, balance);
    const onlyText = await request('/ai-xhs-note', input({ generateImages: false }));
    assert.equal(onlyText.status, 202);
    assert.equal((await wait(onlyText.body.id)).imageGeneration.status, 'disabled');
    assert.equal(imageCalls.length, beforeImages);
    assert.equal(textCalls, beforeText + 1);
  } finally { setTenantConfig('feature_flags', {}, tenantId); }
});

test('默认六图，九/十二图逐张不同职责、按数量报价，排队不误判中断', async () => {
  mode = 'success';
  for (const count of [undefined, 9, 12]) {
    const expected = count ?? 6;
    const quote = (await request(`/ai-xhs-note/options${count ? `?imageCount=${count}` : ''}`)).body;
    assert.equal(quote.imageCount, expected);
    assert.equal(quote.imageTotalCredits, expected * quote.creditsPerImage);
    assert.deepEqual(quote.imageCounts, [6, 9, 12]);
    assert.equal(quote.styles.length, 6); assert.equal(quote.coverLayouts.length, 3);
    let release;
    imageGate = new Promise(resolve => { release = resolve; });
    const before = imageCalls.length;
    const started = await request('/ai-xhs-note', input({ imageCount: count, style: 'review', coverLayout: 'headline' }));
    const early = await wait(started.body.id, job => job.status === 'success' && job.imageGeneration.status === 'running');
    assert.equal(early.imageCount, expected);
    assert.equal(early.output.generatedImagePlan.length, expected);
    assert.equal(new Set(early.output.generatedImagePlan.map(item => item.purpose)).size, expected);
    assert.equal(imageCalls.length - before, 3, '每任务最多三个Image2请求同时发起');
    assert.equal(early.imageGeneration.items.filter(item => item.status === 'pending').length, expected - 3);
    assert.equal(early.imageGeneration.failedCount, 0);
    release(); imageGate = null;
    const result = await wait(started.body.id);
    assert.equal(result.imageGeneration.status, 'success');
    assert.equal(result.imageGeneration.items.length, expected);
    assert.equal(imageCalls.length - before, expected);
    assert.equal(holds(result.id).length, expected);
    assert.ok(holds(result.id).every(hold => hold.status === 'settled' && hold.settled_credits === quote.creditsPerImage));
    assert.equal(result.downloadUrl, `/api/content/native-deliverables/xhs/${result.id}/download`);
  }
  for (const style of XHS_STYLES) assert.equal(normalizeXhsNoteInput(input({ style: style.id })).style, style.id);
  for (const extra of [{ imageCount: 0 }, { imageCount: 8 }, { imageCount: '12' }, { style: 'fake_review' }, { coverLayout: 'anything' }]) {
    assert.equal((await request('/ai-xhs-note', input(extra))).status, 400);
  }
  assert.match(XHS_NOTE_SYSTEM, /不能冒称亲自吃过.*排名或优惠/);
});

test('已有文案确认后只出图，冻结当前稿及选项，同键幂等、旧稿/跨租户拒绝', async () => {
  const beforeText = textCalls;
  const textOnly = await request('/ai-xhs-note', input({ imageCount: 6, style: 'guide', generateImages: false }));
  const draft = await wait(textOnly.body.id);
  assert.ok(draft.outputHash); assert.ok(draft.downloadUrl);
  const edit = { ...draft.output, title: '老板确认的点单顺序', body: '先看锅型，再选已经确认的菜品。保持这份稿件，不重新生稿。', tags: ['点单'], firstComment: '先选哪边？' };
  const changed = (await request(`/ai-xhs-note/jobs/${draft.id}/decision`, { decision: 'adopted', output: edit })).body;
  const body = { requestKey: 'confirmed-image-only', outputHash: changed.outputHash, imageCount: 9, coverLayout: 'photo', includeDiner: true };
  assert.equal((await request(`/ai-xhs-note/jobs/${draft.id}/images`, { ...body, outputHash: draft.outputHash })).status, 409);
  assert.equal((await request(`/ai-xhs-note/jobs/${draft.id}/images`, body, { 'x-other': '1' })).status, 404);
  let release;
  imageGate = new Promise(resolve => { release = resolve; });
  const started = await request(`/ai-xhs-note/jobs/${draft.id}/images`, body);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal((await request(`/ai-xhs-note/jobs/${draft.id}/images`, body)).status, 202);
  assert.equal((await request(`/ai-xhs-note/jobs/${draft.id}/images`, { ...body, requestKey: 'other-request-key' })).status, 409);
  release(); imageGate = null;
  const done = await wait(draft.id);
  assert.equal(done.output.body, edit.body); assert.equal(done.imageGeneration.items.length, 9);
  assert.equal(textCalls, beforeText + 1, '确认图片没有调用第二次文字生成');
  const stored = JSON.parse(q.get('SELECT snapshot_json FROM contents WHERE id=?', draft.id).snapshot_json);
  assert.equal(stored.input.generateImages, false, '原创建输入及inputHash保持不变');
  assert.equal(stored.imageGeneration.input.generateImages, true);
  assert.equal(stored.imageGeneration.outputSnapshot.body, edit.body);
  assert.equal(stored.imageGeneration.outputHash, changed.outputHash);
  assert.equal(holds(done.id).length, 9);
  const imagesBefore = imageCalls.length;
  await request(`/ai-xhs-note/jobs/${draft.id}/images`, body);
  assert.equal(imageCalls.length, imagesBefore);
});

test('四宫格使用四个不同原图真实2x2，重复素材不拼；大字报中文由本地层绘制', async () => {
  const colors = ['#cc1111', '#11cc11', '#1111cc', '#ccee11'];
  const samples = await Promise.all(colors.map(color => renderSvgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="${color}"/></svg>`, { width: 128, height: 128 })));
  const options = { role: 'cover', input: input({ coverLayout: 'collage4' }), output: { coverText: '今晚这一锅一起开涮' }, collageImages: samples };
  const svg = xhsImageLayoutSvg(samples[0], options);
  assert.equal((svg.match(/<image /g) || []).length, 4);
  for (const sample of samples) assert.ok(svg.includes(sample.toString('base64')));
  assert.match(svg, /x="24" y="164"/); assert.match(svg, /x="394" y="572"/);
  assert.throws(() => xhsImageLayoutSvg(png, { ...options, collageImages: [png, png, png, png] }), { code: 'XHS_COLLAGE_NEEDS_FOUR_IMAGES' });
  const composed = await renderXhsImage(samples[0], options);
  assert.deepEqual([detectImageFormat(composed).width, detectImageFormat(composed).height], [768, 1024]);
  const headline = xhsImageLayoutSvg(png, { role: 'cover', input: input({ coverLayout: 'headline' }), output: { coverText: '今晚这一锅一起开涮' } });
  assert.match(headline, /font-size="76"/); assert.match(headline, /今晚这一锅一起开/); assert.match(headline, />涮<\/text>/);
  const originalEdit = runtime.editImage;
  let index = 0;
  runtime.editImage = async () => ({ model: 'gpt-image-2', b64: samples[index++ % 4].toString('base64'), usage: { inputTokens: 1, outputTokens: 1 } });
  try {
    const start = await request('/ai-xhs-note', input({ imageCount: 6, coverLayout: 'collage4' }));
    await wait(start.body.id);
    let cover;
    for (let i = 0; i < 100; i++) {
      cover = (await request(`/ai-xhs-note/jobs/${start.body.id}`)).body.imageGeneration.items[0];
      if (cover.layoutStatus === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(cover.layoutStatus, 'ready'); assert.equal(cover.warning, null);
    const state = JSON.parse(q.get('SELECT snapshot_json FROM media_jobs WHERE id=?', cover.mediaJobId).snapshot_json);
    assert.equal(new Set(state.collageSourceFileIds).size, 4); assert.equal(new Set(state.collageSourceHashes).size, 4);
    assert.equal(holds(start.body.id).length, 6, '四宫格不增加Image2收费次数');
    assert.equal(index, 6);
    assert.ok(cover.originalUrl); assert.notEqual(cover.url, cover.originalUrl);
  } finally { runtime.editImage = originalEdit; }
  const repeated = await request('/ai-xhs-note', input({ imageCount: 6, coverLayout: 'collage4' }));
  const result = await wait(repeated.body.id);
  assert.equal(result.imageGeneration.items[0].layoutStatus, 'waiting_for_images');
  assert.ok(result.imageGeneration.items[0].url); assert.ok(result.downloadUrl);
  assert.equal(holds(repeated.body.id).length, 6);
});

test('已结算聊天计划原样存稿并原子绑定，忽略调用者伪造输入，后续只调用图片', async () => {
  const { nativeChatHash } = await import('../src/engines/native-creative-chat-store.js');
  const { twoPhaseBillingSummary } = await import('../src/engines/two-phase-delivery.js');
  const sessionId = Number(q.run('INSERT INTO native_chat_sessions(tenant_id,user_id,employee_idx) VALUES(?,?,11)', tenantId, userId).lastInsertRowid);
  const messageId = Number(q.run("INSERT INTO native_chat_messages(tenant_id,user_id,session_id,role,request_key,input_hash,status,result_json) VALUES(?,?,?,'assistant','approved-test','test','success',?)", tenantId, userId, sessionId, JSON.stringify({ mode: 'api', model: 'gpt-5.5', usage: { inputTokens: 10, outputTokens: 10 } })).lastInsertRowid);
  const output = parseXhsNoteOutput({ mode: 'api', text: JSON.stringify({ title: '已聊定的门店分享', body: '老板已经与数字员工逐轮确认的完整稿。'.repeat(50), tags: ['火锅'], firstComment: '先涮哪一边？', generatedImagePlan: [{ id: 'pairing', purpose: '自定义搭配观察', visualTask: '用户确认保持蓝色餐垫作为前景，右侧俯拍 CUSTOM_CONFIRMED_PAGE' }] }) }, { brandName: '罗二火锅', files: [{ id: inputFile.id, name: '参考.png' }], input: { imageCount: 6 } });
  const plan = { ready: true, brandName: '罗二火锅', brief: '用户已确认需求', fileIds: [inputFile.id], options: { imageCount: 6, style: 'seed', coverLayout: 'photo', includeDiner: false }, output };
  const hold = runWithTenant(tenantId, () => holdCredits({ userId, tenantId, feature: '聊天测试', kind: 'text', model: 'gpt-5.5', credits: 100, refType: 'native_chat_message', refId: messageId }));
  const settled = runWithTenant(tenantId, () => settleHold(hold, { model: 'gpt-5.5', usage: { inputTokens: 10, outputTokens: 10 }, aiMode: 'api' }));
  const billing = twoPhaseBillingSummary({ state: 'settled', hold, settled });
  q.run('UPDATE native_chat_messages SET billing_json=? WHERE id=?', JSON.stringify(billing), messageId);
  q.run("INSERT INTO native_chat_plans(tenant_id,user_id,session_id,version,message_id,plan_json,plan_hash,state) VALUES(?,?,?,1,?,?,?,'confirmed')", tenantId, userId, sessionId, messageId, JSON.stringify(plan), nativeChatHash(plan));
  const beforeText = textCalls, beforeHolds = q.get("SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=? AND kind='text'", tenantId).n;
  const args = { actor, input: { brandName: '伪造品牌' }, output: { body: '伪造正文' }, chatEvidence: { sessionId, planVersion: 1 } };
  const job = runWithTenant(tenantId, () => createXhsNoteFromConfirmedChat(args));
  assert.deepEqual(job.output, output); assert.equal(job.brandName, plan.brandName);
  const saved = JSON.parse(q.get('SELECT snapshot_json FROM contents WHERE id=?', job.id).snapshot_json);
  assert.deepEqual(saved.billingReference, { refType: 'native_chat_message', refId: messageId });
  assert.equal(JSON.parse(q.get('SELECT generation_json FROM native_chat_plans WHERE session_id=?', sessionId).generation_json).jobId, job.id);
  assert.equal(runWithTenant(tenantId, () => createXhsNoteFromConfirmedChat(args)).id, job.id);
  assert.throws(() => runWithTenant(tenantOther, () => createXhsNoteFromConfirmedChat({ ...args, actor: { ...actor, id: otherId, tenant_id: tenantOther } })), { status: 404 });
  runWithTenant(tenantId, () => startXhsNoteImages({ actor, jobId: job.id, outputHash: job.outputHash, requestKey: 'chat-image-confirmed', runtime }));
  const result = await wait(job.id);
  assert.equal(result.imageGeneration.status, 'success'); assert.deepEqual(result.output, output);
  assert.equal(textCalls, beforeText); assert.equal(q.get("SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=? AND kind='text'", tenantId).n, beforeHolds);
  assert.equal(holds(job.id).length, 6);
  assert.ok(imageCalls.slice(-6).some(call => call.prompt.includes('CUSTOM_CONFIRMED_PAGE')), '已确认逐页视觉改动进入实际图片请求');
});

test('历史未存数量和风格的三图任务按原三图读取，不追加配图或更改已保存稿', async () => {
  const { nativeChatHash } = await import('../src/engines/native-creative-chat-store.js');
  const created = await request('/ai-xhs-note', input({ imageCount: 3 }));
  await wait(created.body.id);
  const row = q.get('SELECT * FROM contents WHERE tenant_id=? AND id=?', tenantId, created.body.id);
  const snapshot = JSON.parse(row.snapshot_json);
  delete snapshot.input.imageCount; delete snapshot.input.style; delete snapshot.input.coverLayout;
  delete snapshot.output.generatedImagePlan;
  snapshot.inputHash = nativeChatHash(snapshot.input);
  q.run('UPDATE contents SET snapshot_json=? WHERE tenant_id=? AND id=?', JSON.stringify(snapshot), tenantId, row.id);
  const before = imageCalls.length, body = row.body;
  const historical = (await request(`/ai-xhs-note/jobs/${row.id}`)).body;
  assert.equal(historical.imageCount, 3);
  assert.equal(historical.imageGeneration.items.length, 3);
  assert.equal(historical.imageGeneration.status, 'success');
  assert.equal(historical.imageGeneration.plan.length, 3);
  assert.equal(imageCalls.length, before);
  assert.equal(q.get('SELECT body FROM contents WHERE id=?', row.id).body, body);
});

test('HTTP200响应头后读取正文超时准确保留阶段，不伪装空成功回执', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let bodyStarted = false, headers = null, receipts = 0;
  try {
    const pending = editImage({ prompt: '仅本地模拟响应体挂起', images: [`data:image/png;base64,${png.toString('base64')}`], timeoutMs: 360000,
      onResponse: value => { headers = value; }, onReceipt: () => { receipts++; },
      fetchFn: async (_url, { signal }) => ({ ok: true, status: 200, headers: new Headers({ 'x-request-id': 'test-body-receipt' }),
        json: () => { bodyStarted = true; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })); } }) });
    for (let i = 0; i < 6 && !bodyStarted; i++) await Promise.resolve();
    assert.equal(bodyStarted, true); assert.equal(headers.status, 200); assert.equal(headers.requestId, 'test-body-receipt');
    t.mock.timers.tick(360000);
    await assert.rejects(pending, error => error.providerReason === 'timeout' && error.responseStatus === 200 && error.providerResponsePhase === 'response_body' && error.responseEmpty !== true);
    assert.equal(receipts, 0, '只有响应头，不能创建图片结果回执');
  } finally { t.mock.timers.reset(); }
});

test('结果URL先持久再下载，下载失败退款后免费取回同图，不重新生成/占扣/结算', async () => {
  const savedEdit = runtime.editImage, savedFetch = runtime.fetchImage, savedSettle = runtime.settleImage;
  let generated = 0, downloads = 0, canDownload = false, downloadGate = null;
  const providerUrl = 'https://image-receipt.test/generated/detail.png?signature=test-private-receipt';
  runtime.editImage = params => editImage({ ...params, fetchFn: async (_url, options) => {
    generated++;
    return response({ data: [options.body.get('prompt').includes('唯一拍摄任务：菜品近景') ? { url: providerUrl } : { b64_json: png.toString('base64') }], usage: { input_tokens: 10, output_tokens: 20 } });
  } });
  runtime.fetchImage = async url => {
    downloads++; assert.equal(url, providerUrl);
    const durable = q.get("SELECT snapshot_json FROM media_jobs WHERE tenant_id=? AND json_extract(snapshot_json,'$.providerReceipt.url')=? ORDER BY id DESC LIMIT 1", tenantId, providerUrl);
    assert.ok(durable, '网络下载之前必须已经落库供应商结果URL');
    if (downloadGate) await downloadGate;
    if (!canDownload) throw new TypeError('local mocked CDN outage');
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  try {
    const start = await request('/ai-xhs-note', input({ imageCount: 3 }));
    const partial = await wait(start.body.id);
    assert.equal(partial.imageGeneration.status, 'partial');
    const detail = partial.imageGeneration.items.find(item => item.id === 'detail');
    assert.equal(detail.canRecover, true); assert.equal(detail.canRetry, false);
    assert.equal(detail.billing.state, 'released');
    assert.equal(detail.billing.chargedCredits, 0);
    const originalHold = holds(start.body.id).find(hold => hold.ref_id === detail.mediaJobId);
    assert.ok(getSupplierExpense(originalHold.id, tenantId).refundedAt);
    assert.equal(generated, 3); assert.equal(downloads, 1); assert.equal(holds(start.body.id).length, 3);
    assert.ok(!JSON.stringify(partial).includes(providerUrl), '私有供应商回执URL不下发浏览器');
    assert.equal((await request(`/ai-xhs-note/jobs/${start.body.id}/recover-images`, { imageIds: ['detail'] }, { 'x-other': '1' })).status, 404);
    const originalState = q.get('SELECT snapshot_json FROM media_jobs WHERE id=?', detail.mediaJobId).snapshot_json;
    const tampered = JSON.parse(originalState); tampered.providerReceipt.mediaJobId++;
    q.run('UPDATE media_jobs SET snapshot_json=? WHERE id=?', JSON.stringify(tampered), detail.mediaJobId);
    assert.equal((await request(`/ai-xhs-note/jobs/${start.body.id}/recover-images`, { imageIds: ['detail'] })).status, 409);
    q.run('UPDATE media_jobs SET snapshot_json=? WHERE id=?', originalState, detail.mediaJobId);
    const beforeBalance = q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits;
    runtime.settleImage = () => assert.fail('已退回用户积分后，免费取回不得再次结算');
    canDownload = true;
    let release; downloadGate = new Promise(resolve => { release = resolve; });
    const recovered = await request(`/ai-xhs-note/jobs/${start.body.id}/recover-images`, { imageIds: ['detail'] });
    assert.equal(recovered.status, 202, JSON.stringify(recovered.body));
    assert.equal((await request(`/ai-xhs-note/jobs/${start.body.id}/recover-images`, { imageIds: ['detail'] })).status, 409);
    release(); downloadGate = null;
    const final = await wait(start.body.id);
    assert.equal(final.imageGeneration.status, 'success');
    const complete = final.imageGeneration.items.find(item => item.id === 'detail');
    assert.equal(complete.billing.state, 'released'); assert.equal(complete.canRecover, false); assert.equal(complete.canRetry, false);
    assert.equal(complete.billing.chargedCredits, 0);
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, beforeBalance);
    assert.ok(complete.originalUrl); assert.equal(generated, 3); assert.equal(downloads, 2);
    assert.equal(holds(start.body.id).length, 3);
    assert.ok(holds(start.body.id).every(hold => hold.status === 'settled'));
  } finally { runtime.editImage = savedEdit; runtime.fetchImage = savedFetch; runtime.settleImage = savedSettle; }
});

test('15分钟流式总预算允许第7分钟完整结果，保存收字节进度且不重复POST', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1800000000000 });
  let posts = 0, receipt = null;
  const progress = [];
  try {
    const pending = editImage({ prompt: '本地虚拟时间流式响应', images: [`data:image/png;base64,${png.toString('base64')}`], timeoutMs: XHS_IMAGE_TIMEOUT_MS,
      onBodyProgress: value => progress.push(value), onReceipt: value => { receipt = value; },
      fetchFn: async (_url, { signal }) => {
        posts++;
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(encoder.encode('{"data":[{"url":'));
          signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
          setTimeout(() => { controller.enqueue(encoder.encode('"https://image-receipt.test/completed.png"}]}')); controller.close(); }, 420000);
        } }), { status: 200 });
      } });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.ok(progress.some(item => item.bodyBytes > 0 && !item.bodyComplete));
    t.mock.timers.tick(420000);
    const out = await pending;
    assert.equal(out.url, 'https://image-receipt.test/completed.png');
    assert.equal(receipt.url, out.url); assert.equal(posts, 1);
    assert.equal(progress.at(-1).bodyComplete, true);
    assert.ok(progress.at(-1).bodyBytes > progress[0].bodyBytes);
    assert.equal(Date.parse(progress.at(-1).lastByteAt) - Date.parse(progress[0].firstByteAt), 420000);
  } finally { t.mock.timers.reset(); }
});

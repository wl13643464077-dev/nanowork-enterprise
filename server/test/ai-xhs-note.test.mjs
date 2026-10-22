import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';

process.env.NANOWORK_DB = ':memory:';
process.env.ENABLE_SCHEDULER = 'false';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
const { initSchema, migrateV2, db, q, runWithTenant } = await import('../src/db.js');
const { holdCredits } = await import('../src/engines/credits.js');
const { createAiGuard, createAiConcurrencyPool } = await import('../src/ai-limits.js');
const { saveUploadedFile } = await import('../src/engines/filehub.js');
const { parseXhsNoteOutput } = await import('../src/engines/ai-xhs-note.js');
const { dispatchPolicy, saveDispatchPolicy } = await import('../src/engines/employee-dispatch-policy.js');
const routes = (await import('../src/routes/ai-xhs-note.js')).default;
const workbenchRoutes = (await import('../src/routes/content-employee-workbench.js')).default;
initSchema(); migrateV2();
const tenantId = 903_511;
q.run("INSERT INTO tenants(id,name,status,plan,credits) VALUES(?,'种草专项','已开通','旗舰版',500000)", tenantId);
const actorId = Number(q.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits) VALUES(?,'x','老板','boss','启用',?,500000)", `xhs-test-${process.pid}`, tenantId).lastInsertRowid);
const otherId = Number(q.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits) VALUES(?,'x','员工','sales','启用',?,500000)", `xhs-other-${process.pid}`, tenantId).lastInsertRowid);
const foreignTenantId = tenantId + 1;
q.run("INSERT INTO tenants(id,name,status,plan,credits) VALUES(?,'另一租户','已开通','旗舰版',500000)", foreignTenantId);
const foreignActorId = Number(q.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits) VALUES(?,'x','另一老板','boss','启用',?,500000)", `xhs-foreign-${process.pid}`, foreignTenantId).lastInsertRowid);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/dYQAAAAASUVORK5CYII=';
const file = runWithTenant(tenantId, () => saveUploadedFile({ name: '菜品.png', mime: 'image/png', b64: png, userId: actorId, purpose: 'xhs-regression' })).row;
const filePath = q.get('SELECT file_path FROM uploaded_files WHERE id=?', file.id).file_path;
const otherFile = runWithTenant(tenantId, () => saveUploadedFile({ name: '员工菜品.png', mime: 'image/png', b64: png, userId: otherId, purpose: 'xhs-regression' })).row;
const otherFilePath = q.get('SELECT file_path FROM uploaded_files WHERE id=?', otherFile.id).file_path;
after(() => { fs.rmSync(filePath, { force: true }); fs.rmSync(otherFilePath, { force: true }); });

test('超长与截断结果完整保存为可编辑建议，不截字也不丢失供应商原文', () => {
  const body = '这是完整菜品介绍。'.repeat(1200);
  const result = parseXhsNoteOutput({ text: JSON.stringify({ title: '标题', body, tags: [], imagePlan: [{ fileId: 999 }] }), mode: 'api', finishReason: 'length' }, { brandName: '三石餐馆', files: [{ id: 1, name: '菜品.png' }] });
  assert.equal(result.body, body);
  assert.equal(result.imagePlan[0].fileId, 1);
  assert.ok(result.warnings.some(warning => /上限/.test(warning)));
  const malformed = '{"body":"已经收到的照片说明';
  assert.equal(parseXhsNoteOutput({ text: malformed, mode: 'api' }, { brandName: '品牌', files: [] }).body, malformed);
  const exactRaw = `\n  ${malformed}  \n`;
  assert.equal(parseXhsNoteOutput({ text: exactRaw, mode: 'api' }, { brandName: '品牌', files: [] }).rawText, exactRaw);
});

test('完整 JSON 没有业务正文时不把空壳交付为成功结果', () => {
  for (const text of ['{}', '{"body":""}', '{"body":"  "}', '[]', 'null', '```json\n{}\n```']) {
    assert.throws(() => parseXhsNoteOutput({ text, mode: 'api' }, { brandName: '品牌', files: [] }), { code: 'XHS_NO_OUTPUT' });
  }
  for (const text of ['{"content":"真实文稿"}', '"真实文稿"', '["真实文稿第一段","第二段"]', '{"body":"","content":"真实文稿"}']) {
    const output = parseXhsNoteOutput({ text, mode: 'api' }, { brandName: '品牌', files: [] });
    assert.equal(output.body, text, '字段不匹配但已有实际文本时完整交付原文');
    assert.equal(output.rawText, text);
    assert.ok(output.warnings.some(warning => /已保留完整原文/.test(warning)));
  }
});

test('照片不能证明的牛油和脆嫩口感提示核对，说明书式文案提示改写但保留全文', () => {
  const body = '牛油锅底搭配爽脆土豆片，处理得当，整体铺陈带来直接满足感。';
  const raw = JSON.stringify({ title: '品牌｜锅底与肉片的鲜香组合', body, tags: [], firstComment: '' });
  const result = parseXhsNoteOutput({ text: raw, mode: 'api' }, { brandName: '品牌', files: [] });
  assert.equal(result.body, body);
  assert.equal(result.rawText, raw);
  assert.ok(result.warnings.some(warning => /牛油/.test(warning)));
  assert.ok(result.warnings.some(warning => /爽脆|脆嫩/.test(warning)));
  assert.ok(result.warnings.some(warning => /说明书式/.test(warning)));
});

test('照片到发布包、幂等提交、费用、选择和权限隔离', async () => {
  let calls = 0;
  let outputMode = 'normal';
  let generationGate = null;
  const app = express();
  app.use(express.json({ strict: false }));
  app.use((req, _res, next) => {
    const foreign = !!req.headers['x-foreign'];
    const requestTenant = foreign ? foreignTenantId : tenantId;
    req.user = { id: foreign ? foreignActorId : req.headers['x-other'] ? otherId : actorId, role: req.headers['x-other'] ? 'sales' : 'boss', tenant_id: requestTenant };
    runWithTenant(requestTenant, next);
  });
  const concurrencyPool = createAiConcurrencyPool(32);
  app.use(createAiGuard({ concurrencyPool, burst: 1000, ratePerMinute: 1000 })('content'));
  app.locals.aiXhsNoteRuntime = { available: () => true, estimate: () => 500,
    generate: async args => {
      calls++;
      if (generationGate) await generationGate;
      assert.ok(args.messages[0].content.some(item => item.type === 'image_url' && item.image_url.url.startsWith('data:image/png;base64,')), '实际图片必须交给视觉模型');
      assert.equal(args.providerPolicy, 'yunwu_only');
      if (outputMode === 'timeout') throw Object.assign(new Error('upstream timeout with secret sk-test-private'), { code: 'ETIMEDOUT' });
      if (outputMode === 'empty') return { text: '', mode: 'api', model: args.model, usage: { inputTokens: 100, outputTokens: 0 } };
      return { text: JSON.stringify({ title: '三石餐馆的招牌菜', body: '门店今天的菜品分享。', tags: ['三石餐馆'], firstComment: '你更想了解哪道菜？', imagePlan: [{ fileId: file.id, caption: '首图' }] }), mode: 'api', model: args.model,
        usage: outputMode === 'usage_missing' ? {} : { inputTokens: 100, outputTokens: 100,
          supplierCosts: [{ status: 'known', costYuanOverride: 0.0002,
            costSource: { type: 'provider_receipt', provider: 'openlux', basis: 'upstream_debit',
              requestId: `xhs-test-${calls}`, currency: 'USD', amount: 0.0002, exchangeRate: 1,
              quota: 100, quotaPerUnit: 500000, exchangeRateSource: 'https://api.openlux.ai/api/status',
              statusRetrievedAt: '2026-09-07T00:00:00.000Z' } }] } };
    } };
  app.use('/workbench', workbenchRoutes);
  app.use(routes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, headers = {}) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const input = { brandName: '三石餐馆', fileIds: [file.id], requestKey: 'test-request-01', generateImages: false };
  async function wait(id) {
    for (let i = 0; i < 100; i++) {
      const job = await fetch(`${base}/ai-xhs-note/jobs/${id}`).then(r => r.json());
      if (job.status !== 'running') return job;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('任务未完成');
  }
  try {
    const response = await post('/ai-xhs-note', input);
    const created = await response.json();
    assert.equal(response.status, 202, JSON.stringify(created));
    const job = await wait(created.id);
    assert.equal(job.status, 'success', JSON.stringify(job));
    assert.equal(job.decision, 'pending');
    assert.equal(job.billing.state, 'settled');
    assert.equal(job.files[0].id, file.id);
    const duplicate = await post('/ai-xhs-note', input).then(r => r.json());
    assert.equal(duplicate.id, created.id);
    assert.equal(calls, 1, '相同提交不会重复生成收费');
    assert.equal((await post('/ai-xhs-note', { ...input, brandName: '不同品牌' })).status, 409);
    assert.equal((await post('/ai-xhs-note', { ...input, requestKey: 'other-user-01' }, { 'x-other': '1' })).status, 404);
    assert.equal((await fetch(`${base}/ai-xhs-note/jobs/${job.id}`, { headers: { 'x-other': '1' } })).status, 404);
    const editedOutput = { title: '老板修改的标题', body: '修改后的完整正文。'.repeat(1100), tags: ['本地品牌', '门店分享'], firstComment: '老板补充的首评' };
    const adopted = await post(`/ai-xhs-note/jobs/${job.id}/decision`, { decision: 'adopted', output: editedOutput }).then(r => r.json());
    assert.equal(adopted.decision, 'adopted');
    for (const field of ['title', 'body', 'tags', 'firstComment']) assert.deepEqual(adopted.output[field], editedOutput[field]);
    assert.equal(adopted.originalOutput.body, job.output.body, '采纳编辑稿仍保留最初正文');
    assert.equal(adopted.originalOutput.rawText, job.originalOutput.rawText, '供应商原文保留用于核对');
    assert.equal(adopted.output.imagePlan[0].fileId, file.id, '编辑正文不能改掉真实照片');
    const savedEdited = await fetch(`${base}/ai-xhs-note/jobs/${job.id}`).then(r => r.json());
    assert.equal(savedEdited.output.body, editedOutput.body, '重新打开仍返回编辑稿');
    assert.equal(q.get('SELECT body FROM contents WHERE id=?', job.id).body.includes(editedOutput.body), true);
    assert.equal((await post(`/ai-xhs-note/jobs/${job.id}/decision`, { decision: 'adopted', output: { ...editedOutput, tags: [3] } })).status, 400);
    const rejected = await post(`/ai-xhs-note/jobs/${job.id}/decision`, { decision: 'rejected' }).then(r => r.json());
    assert.equal(rejected.decision, 'rejected');
    assert.equal(rejected.output.body, editedOutput.body, '不采纳仍保留编辑后的内容');
    assert.equal(rejected.originalOutput.body, job.output.body, '不采纳仍保留原始内容');
    assert.equal(calls, 1);
    outputMode = 'usage_missing';
    const pendingCreated = await post('/ai-xhs-note', { ...input, requestKey: 'usage-missing-01' }).then(r => r.json());
    const pending = await wait(pendingCreated.id);
    assert.equal(pending.status, 'success');
    assert.equal(pending.billing.state, 'pending_reconciliation');
    assert.ok(pending.output.body, '账务待核对不能抹掉已收到文案');
    assert.equal(pending.billing.chargedCredits, null);
    outputMode = 'empty';
    const emptyCreated = await post('/ai-xhs-note', { ...input, requestKey: 'empty-response-01' }).then(r => r.json());
    const empty = await wait(emptyCreated.id);
    assert.equal(empty.status, 'failed');
    assert.equal(empty.output, null);
    assert.equal(calls, 3, '空结果不自动重复付费调用');
    const otherJobs = await fetch(`${base}/ai-xhs-note/jobs`, { headers: { 'x-other': '1' } }).then(r => r.json());
    assert.equal(otherJobs.jobs.length, 0);

    assert.equal((await fetch(`${base}/ai-xhs-note/jobs/${job.id}`, { headers: { 'x-foreign': '1' } })).status, 404);
    assert.equal((await post(`/ai-xhs-note/jobs/${job.id}/decision`, { decision: 'adopted', output: editedOutput }, { 'x-foreign': '1' })).status, 404);
    assert.equal((await post('/ai-xhs-note', { ...input, requestKey: 'foreign-file-01' }, { 'x-foreign': '1' })).status, 404);
    assert.equal((await fetch(`${base}/ai-xhs-note/jobs`, { headers: { 'x-foreign': '1' } }).then(r => r.json())).jobs.length, 0);
    assert.equal((await post('/ai-xhs-note', null)).status, 400);
    assert.equal((await fetch(`${base}/ai-xhs-note/jobs/not-a-number`)).status, 404);
    assert.equal(calls, 3, '越权请求或坏输入不能触发付费模型');

    outputMode = 'normal';
    const parallelResponses = await Promise.all(Array.from({ length: 8 }, () => post('/ai-xhs-note', { ...input, requestKey: 'parallel-request-01' })));
    assert.ok(parallelResponses.every(response => [200, 202].includes(response.status)));
    const parallelJobs = await Promise.all(parallelResponses.map(response => response.json()));
    assert.equal(new Set(parallelJobs.map(item => item.id)).size, 1);
    await wait(parallelJobs[0].id);
    assert.equal(calls, 4, '并发同requestKey只调用一次模型');
    assert.equal(q.get("SELECT COUNT(*) AS n FROM credit_holds WHERE tenant_id=? AND ref_type='content' AND ref_id=?", tenantId, parallelJobs[0].id).n, 1, '并发同requestKey只占扣一次');

    // SQLite rejects the final settlement snapshot write while allowing the
    // original response to persist. The scoped ledger must recover it without
    // a second model call, even while the write remains unavailable.
    db.exec(`CREATE TEMP TRIGGER fail_xhs_final_write BEFORE UPDATE OF snapshot_json ON contents
      WHEN NEW.tenant_id=${tenantId} AND json_extract(NEW.snapshot_json,'$.input.requestKey')='final-write-fail'
        AND json_extract(NEW.snapshot_json,'$.status')='success'
      BEGIN SELECT RAISE(FAIL,'simulated final write failure'); END`);
    let recoveredId;
    try {
      const received = await post('/ai-xhs-note', { ...input, requestKey: 'final-write-fail' }).then(r => r.json());
      recoveredId = received.id;
      const recovered = await wait(received.id);
      assert.equal(recovered.status, 'success');
      assert.equal(recovered.billing.state, 'settled');
      assert.equal(recovered.output.body, job.output.body);
      assert.equal(recovered.canRetry, true);
      assert.equal(JSON.parse(q.get('SELECT snapshot_json FROM contents WHERE id=?', received.id).snapshot_json).status, 'running', '持续写故障时读取仍返回已保存正文');
      assert.equal(calls, 5);
    } finally { db.exec('DROP TRIGGER fail_xhs_final_write'); }
    assert.equal((await fetch(`${base}/ai-xhs-note/jobs/${recoveredId}`).then(r => r.json())).billing.state, 'settled');
    assert.equal(JSON.parse(q.get('SELECT snapshot_json FROM contents WHERE id=?', recoveredId).snapshot_json).status, 'success', '写入恢复后回填终态');

    const seedInterrupted = ({ output = null, deadline = Date.now() - 1, withHold = true } = {}) => runWithTenant(tenantId, () => {
      const snapshot = { status: 'running', instanceId: 'earlier-process', deadline, input: { ...input, requestKey: `interrupted-${Date.now()}` }, output };
      const id = Number(q.run("INSERT INTO contents(tenant_id,type,title,brand,body,status,creator_id,source_type,snapshot_json) VALUES(?,'小红书种草图文','中断任务','三石餐馆',?,'生成中',?,'ai_xhs_note',?)", tenantId, output?.body || '', actorId, JSON.stringify(snapshot)).lastInsertRowid);
      if (withHold) {
        const held = holdCredits({ userId: actorId, tenantId, feature: 'XHS恢复测试', kind: 'text', credits: 10, refType: 'content', refId: id });
        snapshot.billing = { state: 'held', holdId: held.holdId, heldCredits: held.credits };
      }
      q.run('UPDATE contents SET snapshot_json=? WHERE id=?', JSON.stringify(snapshot), id);
      return id;
    });
    const interruptedDeliveredId = seedInterrupted({ output: job.output });
    const interruptedDelivered = await fetch(`${base}/ai-xhs-note/jobs/${interruptedDeliveredId}`).then(r => r.json());
    assert.equal(interruptedDelivered.status, 'success');
    assert.equal(interruptedDelivered.output.body, job.output.body);
    assert.equal(interruptedDelivered.billing.state, 'pending_reconciliation');
    assert.equal(interruptedDelivered.billing.chargedCredits, null);
    assert.equal(interruptedDelivered.canRetry, false);
    const interruptedEmptyId = seedInterrupted();
    const interruptedEmpty = await fetch(`${base}/ai-xhs-note/jobs/${interruptedEmptyId}`).then(r => r.json());
    assert.equal(interruptedEmpty.status, 'failed');
    assert.equal(interruptedEmpty.output, null);
    assert.equal(interruptedEmpty.billing.state, 'pending_reconciliation');
    const beforeHoldId = seedInterrupted({ withHold: false });
    const beforeHold = await fetch(`${base}/ai-xhs-note/jobs/${beforeHoldId}`).then(r => r.json());
    assert.equal(beforeHold.status, 'failed');
    assert.equal(beforeHold.billing.state, 'released');
    assert.equal(beforeHold.billing.chargedCredits, 0);
    assert.equal(beforeHold.billing.heldCredits, 0);
    assert.equal(beforeHold.canRetry, true);
    assert.match(beforeHold.error, /尚未开始.*未扣费.*可重新生成/);
    assert.equal((await fetch(`${base}/ai-xhs-note/jobs/${beforeHoldId}`).then(r => r.json())).billing.state, 'released');
    const missingLogId = seedInterrupted();
    q.run("UPDATE credit_holds SET log_id=-1 WHERE tenant_id=? AND user_id=? AND ref_type='content' AND ref_id=?", tenantId, actorId, missingLogId);
    const missingLog = await fetch(`${base}/ai-xhs-note/jobs/${missingLogId}`).then(r => r.json());
    assert.equal(missingLog.billing.state, 'pending_reconciliation', '有 hold 但流水缺失不能冒充未扣费');
    assert.equal(missingLog.billing.chargedCredits, null);
    assert.equal(missingLog.billing.heldCredits, 10);
    assert.equal(missingLog.canRetry, false);
    const anotherLiveWorker = seedInterrupted({ deadline: Date.now() + 300000 });
    assert.equal((await fetch(`${base}/ai-xhs-note/jobs/${anotherLiveWorker}`).then(r => r.json())).status, 'running', '另一执行实例的有效执行时间不能被误判为进程中断');
    assert.equal(calls, 5, '恢复任务只读已存内容和账本，不发新云调用');

    db.exec(`CREATE TEMP TRIGGER fail_xhs_receipt BEFORE UPDATE OF snapshot_json ON contents
      WHEN NEW.tenant_id=${tenantId} AND json_extract(NEW.snapshot_json,'$.input.requestKey')='receipt-write-fail'
        AND json_extract(NEW.snapshot_json,'$.billing.state')='held'
      BEGIN SELECT RAISE(FAIL,'simulated receipt write failure'); END`);
    try {
      assert.equal((await post('/ai-xhs-note', { ...input, requestKey: 'receipt-write-fail' })).status, 503);
      const receiptRow = q.get("SELECT id FROM contents WHERE tenant_id=? AND json_extract(snapshot_json,'$.input.requestKey')='receipt-write-fail'", tenantId);
      const receiptJob = await fetch(`${base}/ai-xhs-note/jobs/${receiptRow.id}`).then(r => r.json());
      assert.equal(receiptJob.status, 'failed');
      assert.equal(receiptJob.billing.state, 'released');
      assert.equal(receiptJob.billing.chargedCredits, 0);
      assert.equal(calls, 5, '回执失败发生在外调前，释放占扣且不调用模型');
    } finally { db.exec('DROP TRIGGER fail_xhs_receipt'); }

    const heldSlots = Array.from({ length: 31 }, () => concurrencyPool.tryAcquire({ kind: 'test' }));
    let releaseGeneration;
    generationGate = new Promise(resolve => { releaseGeneration = resolve; });
    try {
      const queuedResponse = await post('/ai-xhs-note', { ...input, requestKey: 'background-lease-01' });
      assert.equal(queuedResponse.status, 202);
      const queued = await queuedResponse.json();
      assert.equal(concurrencyPool.stats().inFlight, 32, '202响应结束后生成任务仍持有并发租约');
      const blocked = await post('/ai-xhs-note', { ...input, requestKey: 'background-lease-02' });
      assert.equal(blocked.status, 429);
      assert.equal((await fetch(`${base}/ai-xhs-note/jobs/${queued.id}`)).status, 200, '任务查询不占生成并发');
      releaseGeneration();
      generationGate = null;
      assert.equal((await wait(queued.id)).status, 'success');
      assert.equal(concurrencyPool.stats().inFlight, 31, '后台结束释放生成租约');
      assert.equal(calls, 6, '并发被拒请求没有触发模型');
    } finally {
      releaseGeneration();
      generationGate = null;
      heldSlots.forEach(lease => lease.release());
    }
    outputMode = 'timeout';
    const timedOutReceipt = await post('/ai-xhs-note', { ...input, requestKey: 'timeout-reason-01' }).then(r => r.json());
    const timedOut = await wait(timedOutReceipt.id);
    assert.equal(timedOut.status, 'failed');
    assert.equal(timedOut.failure.code, 'XHS_UPSTREAM_TIMEOUT');
    assert.equal(timedOut.failure.phase, 'generate');
    assert.match(timedOut.error, /响应超时.*预授权已退回/);
    assert.doesNotMatch(JSON.stringify(timedOut), /sk-test-private/);
    assert.equal(empty.failure.code, 'XHS_EMPTY_RESULT');
    assert.equal(calls, 7, '上游超时不自动发起第二次付费调用');

    outputMode = 'normal';
    const salesInput = { ...input, fileIds: [otherFile.id], requestKey: 'sales-owned-history' };
    const salesCreatedResponse = await post('/ai-xhs-note', salesInput, { 'x-other': '1' });
    assert.equal(salesCreatedResponse.status, 202, '未受派活限制的普通员工可以使用自己的照片生成');
    const salesCreated = await salesCreatedResponse.json();
    await wait(salesCreated.id);
    assert.equal(calls, 8);
    const originalPolicy = runWithTenant(tenantId, () => dispatchPolicy());
    const holdsBeforeDenied = q.get('SELECT COUNT(*) AS count FROM credit_holds WHERE tenant_id=?', tenantId).count;
    try {
      runWithTenant(tenantId, () => saveDispatchPolicy({
        defaultAllow: true,
        groups: { '内容生产部': { roles: ['sales', 'ops_director'] } },
        employees: { 'crew:11': { roles: ['ops_director'] } },
      }));
      const employeeDenied = await post('/ai-xhs-note', { ...salesInput, requestKey: 'sales-denied-employee' }, { 'x-other': '1' });
      assert.equal(employeeDenied.status, 403, '部门允许不能绕过crew:11员工级禁派活');
      assert.match((await employeeDenied.json()).error, /未被授权.*派活/);
      assert.equal((await fetch(`${base}/ai-xhs-note/jobs/${salesCreated.id}`, { headers: { 'x-other': '1' } })).status, 200, '禁派活后仍可读取自己的已授权历史图文');
      const salesHistory = await fetch(`${base}/ai-xhs-note/jobs`, { headers: { 'x-other': '1' } }).then(r => r.json());
      assert.ok(salesHistory.jobs.some(item => item.id === salesCreated.id), '禁派活不清空自己的历史任务列表');
      runWithTenant(tenantId, () => saveDispatchPolicy({ defaultAllow: true, groups: { '内容生产部': { roles: ['ops_director'] } }, employees: {} }));
      assert.equal((await post('/ai-xhs-note', { ...salesInput, requestKey: 'sales-denied-group' }, { 'x-other': '1' })).status, 403, '专用入口遵守内容部分部派活策略');
      assert.equal(calls, 8, '派活拒绝没有调用供应商');
      assert.equal(q.get('SELECT COUNT(*) AS count FROM credit_holds WHERE tenant_id=?', tenantId).count, holdsBeforeDenied, '派活拒绝没有占扣积分');
    } finally { runWithTenant(tenantId, () => saveDispatchPolicy(originalPolicy)); }
    const profileResponse = await fetch(`${base}/workbench/11`);
    const profileBody = await profileResponse.json();
    assert.equal(profileResponse.status, 200, JSON.stringify(profileBody));
    const profile = profileBody.profile || profileBody;
    assert.equal(profile.permissions.canDispatch, true, '专用任务入口继续可用');
    for (const permission of ['canEditPrompt', 'canEditConfig']) {
      assert.equal(profile.permissions[permission], false, `${permission}不展示无效通用编辑`);
    }
    assert.equal(profile.permissions.canEditSkills, true, '种草员复用统一技能库');
    assert.equal(profile.permissions.canLearn, true, '种草员可发起真实全网进修');
    const configRowsBefore = q.get('SELECT COUNT(*) AS count FROM content_employee_workbench_configs WHERE tenant_id=?', tenantId).count;
    const configResponse = await fetch(`${base}/workbench/11/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { outputLength: 'full' } }) });
    assert.equal(configResponse.status, 409);
    assert.equal(q.get('SELECT COUNT(*) AS count FROM content_employee_workbench_configs WHERE tenant_id=?', tenantId).count, configRowsBefore, '不生成专岗无法消费的配置记录');
    assert.equal(calls, 8, '查看档案和拒绝无效配置不调用模型');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('真实验收暴露的几秒变色、够劲与顾客首评提示修改，保留完整稿且否定不当确认', () => {
  const body = '忙完这一周，最想干的事就是和朋友坐下来烫顿火锅。肉片下锅几秒就变色，吸满红油吃起来很够劲。土豆片吸饱了汤汁最合适。';
  const raw = JSON.stringify({ title: '下班约朋友来吃火锅', body, tags: ['火锅'], firstComment: '大家去罗二火锅必点哪道菜？求推荐！' });
  const result = parseXhsNoteOutput({ mode: 'api', text: raw }, { brandName: '罗二火锅', files: [], confirmedDetails: '别编造亲测口感，不要写够劲' });
  assert.equal(result.body, body); assert.equal(result.rawText, raw);
  assert.ok(result.warnings.some(item => /涮煮时间.*安全食用/.test(item)));
  assert.ok(result.warnings.some(item => /够劲.*静态照片/.test(item)));
  assert.ok(result.warnings.some(item => /门店官方.*顾客/.test(item)));
  const negative = parseXhsNoteOutput({ mode: 'api', text: JSON.stringify({ title: '标题', body: '牛油锅底', tags: [] }) }, { brandName: '品牌', files: [], confirmedDetails: '牛油尚未确认，不要写牛油' });
  assert.ok(negative.warnings.some(item => /牛油/.test(item)));
  const { body: preserved, warnings } = parseXhsNoteOutput({ mode: 'api', text: JSON.stringify({ title: '下班一起坐坐', body: '约上朋友来我们店坐坐。红汤和清汤，你先选哪边？', tags: ['火锅'], firstComment: '你更想选红汤还是清汤？' }) }, { brandName: '罗二火锅', files: [] });
  assert.match(preserved, /我们店/); assert.ok(!warnings.some(item => /顾客或探店口吻|安全食用/.test(item)));
});

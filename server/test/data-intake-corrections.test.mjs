import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const DBP = path.join(os.tmpdir(), `shanmei-data-intake-corrections-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { seed } = await import('../src/seed.js');
const dataIntakeRoutes = (await import('../src/routes/dataintake.js')).default;
const systemRoutes = (await import('../src/routes/system.js')).default;

initSchema();
migrateV2();
seed();
const boss = q.get("SELECT id,name,username,role,tenant_id FROM users WHERE tenant_id=1 AND role='boss' ORDER BY id LIMIT 1");

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => runWithTenant(1, () => {
    req.user = { ...boss, ip: '127.0.0.1' };
    next();
  }));
  app.use('/data-intake', dataIntakeRoutes);
  app.use('/sys', systemRoutes);
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function request(base, url, method = 'GET', body, expectedStatus = 200) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  assert.equal(response.status, expectedStatus, `${method} ${url}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

test('数据录入支持逐行修改、撤回、删除、恢复及关联保护', async () => {
  await withServer(async base => {
    const firstPayload = {
      idempotencyKey: 'correction-lead-create-001',
      batches: [{ sheet: '纠错客户', target: 'leads', rows: [{ rowNumber: 2, data: {
        name: '导入纠错专用客户', phone: '13870000001', source: '表格导入', stage: '新线索',
      } }] }],
    };
    const created = await request(base, '/data-intake/commit', 'POST', firstPayload);
    const createItem = created.results[0].items[0];
    assert.equal(createItem.action, '新增');
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1 AND source_type='lead' AND source_id=?`, createItem.recordId).n, 1);
    q.run(`DELETE FROM biz_assets WHERE tenant_id=1 AND source_type='lead' AND source_id=?`, createItem.recordId);
    const reconciled = await request(base, '/data-intake/reconcile', 'POST', {});
    assert.ok(reconciled.assets >= 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1 AND source_type='lead' AND source_id=?`, createItem.recordId).n, 1);

    await request(base, `/data-intake/items/${createItem.id}`, 'PUT', { data: { source: '现场活动', stage: '已沟通' } });
    assert.deepEqual(
      { ...q.get('SELECT source,stage FROM leads WHERE tenant_id=1 AND id=?', createItem.recordId) },
      { source: '现场活动', stage: '已沟通' },
    );

    await request(base, '/data-intake/commit', 'POST', {
      ...firstPayload,
      batches: [{ sheet: '纠错客户', target: 'leads', rows: [{ data: { name: '另一条数据', phone: '13870000002' } }] }],
    }, 409);

    const updated = await request(base, '/data-intake/commit', 'POST', {
      idempotencyKey: 'correction-lead-update-001',
      batches: [{ sheet: '纠错客户更新', target: 'leads', rows: [{ rowNumber: 3, data: {
        name: '导入纠错专用客户', phone: '13870000001', next_action: '电话回访',
      } }] }],
    });
    const updateItem = updated.results[0].items[0];
    assert.equal(updateItem.action, '更新');
    await request(base, `/data-intake/items/${createItem.id}`, 'PUT', { data: { source: '不应覆盖' } }, 409);

    const reverted = await request(base, `/data-intake/items/${updateItem.id}`, 'DELETE');
    assert.equal(reverted.action, 'reverted');
    const restoredOriginal = q.get('SELECT source,stage,next_action FROM leads WHERE tenant_id=1 AND id=?', createItem.recordId);
    assert.deepEqual({ ...restoredOriginal }, { source: '现场活动', stage: '已沟通', next_action: null });

    const deleted = await request(base, `/data-intake/items/${createItem.id}`, 'DELETE');
    assert.equal(deleted.action, 'deleted');
    assert.equal(q.get('SELECT COUNT(*) AS n FROM leads WHERE tenant_id=1 AND id=?', createItem.recordId).n, 0);
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1 AND source_type='lead' AND source_id=?`, createItem.recordId).n, 0);
    assert.equal(q.get('SELECT status FROM data_import_items WHERE tenant_id=1 AND id=?', createItem.id).status, 'deleted');
    assert.equal(q.get('SELECT entity_type FROM deleted_records WHERE tenant_id=1 AND id=?', deleted.archiveId).entity_type, 'lead');

    await request(base, `/sys/deletions/${deleted.archiveId}/restore`, 'POST');
    assert.equal(q.get('SELECT name FROM leads WHERE tenant_id=1 AND id=?', createItem.recordId).name, '导入纠错专用客户');
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1 AND source_type='lead' AND source_id=?`, createItem.recordId).n, 1);
    assert.equal(q.get('SELECT status FROM data_import_items WHERE tenant_id=1 AND id=?', createItem.id).status, 'active');

    const linked = await request(base, '/data-intake/commit', 'POST', {
      idempotencyKey: 'correction-linked-lead-001',
      batches: [{ sheet: '有关联客户', target: 'leads', rows: [{ data: { name: '已有订单客户', phone: '13870000003' } }] }],
    });
    const linkedItem = linked.results[0].items[0];
    q.run('INSERT INTO orders(lead_id,product,amount,type) VALUES(?,?,?,?)', linkedItem.recordId, '测试商品', 100, '零售');
    const denied = await request(base, `/data-intake/items/${linkedItem.id}`, 'DELETE', undefined, 409);
    assert.match(denied.error, /订单1条/);
    assert.equal(q.get('SELECT COUNT(*) AS n FROM leads WHERE tenant_id=1 AND id=?', linkedItem.recordId).n, 1);

    const history = await request(base, '/data-intake/history');
    assert.ok(history.some(item => item.id === createItem.id && item.status === 'active' && item.recordExists));
    assert.ok(history.some(item => item.id === updateItem.id && item.status === 'reverted'));
    const jobs = await request(base, '/data-intake/jobs');
    assert.ok(jobs.some(job => job.sheet === '纠错客户' && job.status === 'success'));
  });
});

after(async () => {
  await removeTempDbSafely(DBP);
});

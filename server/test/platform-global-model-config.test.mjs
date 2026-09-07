import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const databasePath = path.join(os.tmpdir(), `platform-global-model-config-${process.pid}.db`);
process.env.NANOWORK_DB = databasePath;
process.env.YUNWU_API_KEY = '';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
const { initSchema, migrateV2, qRaw, runWithTenant, setConfig } = await import('../src/db.js');
initSchema(); migrateV2();
const admin = (await import('../src/routes/admin.js')).default;
const { routing } = await import('../src/engines/yunwu.js');
qRaw.run("INSERT OR IGNORE INTO tenants(id,name,status,credits) VALUES(1,'平台账号所在企业','已开通',1000)");
const tenant2 = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('其他企业','已开通',1000)").lastInsertRowid);
const superId = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('global_config_super','x','平台管理员','platform_super',1)").lastInsertRowid);

test('平台读取和保存默认模型不吸收当前企业覆盖，也不改变其他企业的实际路由', async () => {
  setConfig('model_routing', { text: { boss: 'gpt-5.5', manager: 'gpt-5.5' } });
  qRaw.run('INSERT INTO tenant_model_routing(tenant_id,routing_json) VALUES(1,?)', JSON.stringify({ text: { boss: 'deepseek-v4-flash', manager: 'gemini-3.1-flash-lite' }, vision: 'gpt-5.5' }));
  const otherBefore = routing(tenant2);
  const ownBefore = routing(1);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => runWithTenant(1, () => { req.user = { id: superId, role: 'platform_super', tenant_id: 1 }; next(); }));
  app.use('/admin', admin);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const read = await fetch(`${base}/admin/api-config`);
    assert.equal(read.status, 200);
    const config = await read.json();
    assert.equal(config.routing.text.boss, 'gpt-5.5');
    assert.equal(config.routing.text.manager, 'gpt-5.5');
    const saved = await fetch(`${base}/admin/api-config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ routing: config.routing }) });
    assert.equal(saved.status, 200, await saved.text());
    assert.deepEqual(routing(tenant2), otherBefore);
    assert.deepEqual(routing(1), ownBefore);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

after(() => removeTempDbSafely(databasePath));

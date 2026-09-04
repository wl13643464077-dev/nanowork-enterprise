// 拍照/截图识别报表：mock vision → 结构化行与置信度、低置信标记、失败释放 hold、schema 严格、权限、租户隔离。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const DBP = path.join(os.tmpdir(), `nanowork-data-intake-vision-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });
process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = 'test';
process.env.YUNWU_API_KEY = 'sk-local-data-intake-vision-test';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
delete process.env.ENABLE_BACKGROUND_EMBEDDINGS;

const { db, q, qRaw, initSchema, migrateV2, runWithTenant, setConfig } = await import('../src/db.js');
const { balanceOfTenant } = await import('../src/engines/credits.js');
const { saveUploadedFile } = await import('../src/engines/filehub.js');
const { VISION_SCHEMAS, parseVisionOutput, LOW_CONFIDENCE } = await import('../src/engines/data-intake-vision.js');
const dataIntakeRoutes = (await import('../src/routes/dataintake.js')).default;

initSchema();
migrateV2();

const CHAIN = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('识别企业','已开通',5000)").lastInsertRowid);
const OTHER = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('隔壁识别企业','已开通',5000)").lastInsertRowid);
const insertUser = (username, name, role, tenantId) => Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES(?,?,?,?,'启用',?)`, username, 'x', name, role, tenantId,
).lastInsertRowid);
const users = {
  boss: { id: insertUser('vis_boss', '识别老板', 'boss', CHAIN), name: '识别老板', username: 'vis_boss', role: 'boss', tenant_id: CHAIN },
  sales: { id: insertUser('vis_sales', '识别员工', 'sales', CHAIN), name: '识别员工', username: 'vis_sales', role: 'sales', tenant_id: CHAIN },
  otherBoss: { id: insertUser('vis_other', '隔壁老板', 'boss', OTHER), name: '隔壁老板', username: 'vis_other', role: 'boss', tenant_id: OTHER },
};
const storeWanda = Number(qRaw.run(`INSERT INTO stores(tenant_id,name,code,biz_type,status,is_default) VALUES(?,?,?,'快餐','营业中',1)`, CHAIN, '万达店', 'WD001').lastInsertRowid);
qRaw.run(`INSERT INTO stores(tenant_id,name,code,biz_type,status,is_default) VALUES(?,?,?,'快餐','营业中',1)`, OTHER, '隔壁店', null);

// ===== mock 云雾：按文件名决定返回内容 =====
const providerRequests = [];
const providerApp = express();
providerApp.use(express.json({ limit: '8mb' }));
providerApp.post('/v1/chat/completions', (req, res) => {
  providerRequests.push(req.body);
  const text = JSON.stringify(req.body?.messages || []);
  const reply = (content, usage = { prompt_tokens: 900, completion_tokens: 180 }) =>
    res.json({ choices: [{ message: { content } }], usage });
  if (text.includes('日结单.png')) {
    return reply(JSON.stringify({
      date: '2026-09-01', storeName: '万达店', revenue: 8650.5, orders: 312, avgTicket: null, deliveryRevenue: 3120, refunds: null,
      confidence: 0.86,
      fieldConfidence: { date: 0.95, storeName: 0.9, revenue: 0.93, orders: 0.55, avgTicket: 0, deliveryRevenue: 0.8, refunds: 0 },
      fieldsUnreadable: ['avgTicket', 'refunds'],
    }));
  }
  if (text.includes('菜单.jpg')) {
    return reply(JSON.stringify({
      storeName: null,
      items: [
        { name: '招牌牛肉面', price: 28, category: '主食', unit: '碗', confidence: 0.9, fieldConfidence: { name: 0.95, price: 0.9, category: 0.8, unit: 0.9 }, fieldsUnreadable: [] },
        { name: '凉拌黄瓜', price: null, category: '小菜', unit: null, confidence: 0.6, fieldConfidence: { name: 0.9, price: 0, category: 0.7, unit: 0 }, fieldsUnreadable: ['price', 'unit'] },
      ],
      confidence: 0.8, fieldsUnreadable: [],
    }));
  }
  if (text.includes('坏JSON.png')) return reply('识别到营收 8650 元，但我不想输出 JSON');
  if (text.includes('零用量.png')) {
    return reply(JSON.stringify({
      date: '2026-09-01', storeName: '万达店', revenue: 1, orders: 1, avgTicket: 1, deliveryRevenue: 0, refunds: 0, confidence: 1,
      fieldConfidence: { date: 1, storeName: 1, revenue: 1, orders: 1, avgTicket: 1, deliveryRevenue: 1, refunds: 1 }, fieldsUnreadable: [],
    }), { prompt_tokens: 0, completion_tokens: 0 });
  }
  if (text.includes('看不出.png')) {
    return reply(JSON.stringify({ kind: 'unknown', daily_summary: null, menu: null, cost_receipt: null, delivery_report: null }));
  }
  if (text.includes('超时.png')) {
    return; // 不响应，让调用方超时
  }
  return res.status(500).json({ error: { message: 'unexpected test file' } });
});
const providerServer = providerApp.listen(0, '127.0.0.1');
const providerPort = await new Promise(resolve => providerServer.once('listening', () => resolve(providerServer.address().port)));
setConfig('yunwu_base_url', `http://127.0.0.1:${providerPort}/v1`);

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use((req, _res, next) => {
  const user = users[String(req.get('X-Test-User') || 'boss')] || users.boss;
  runWithTenant(user.tenant_id, () => {
    req.user = { ...user, ip: '127.0.0.1' };
    next();
  });
});
app.use('/data-intake', dataIntakeRoutes);
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

async function call(url, { method = 'GET', body, user = 'boss' } = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Test-User': user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=';
const writtenPaths = [];
function upload(name, user = users.boss) {
  return runWithTenant(user.tenant_id, () => {
    const saved = saveUploadedFile({ name, b64: PNG_B64, mime: 'image/png', purpose: 'data-intake', userId: user.id });
    writtenPaths.push(saved.row.file_path);
    return saved.row;
  });
}
const heldRows = tenantId => db.prepare(`SELECT * FROM credit_holds WHERE tenant_id=? AND status='held' ORDER BY id`).all(tenantId);
let importSeq = 0;
const key = () => `vision-import-${process.pid}-${++importSeq}`;

test('json_schema 严格：每类 schema 都禁止额外字段且字段全必填；解析器拒绝非法输出与静默补零', () => {
  for (const [kind, schema] of Object.entries(VISION_SCHEMAS)) {
    assert.equal(schema.additionalProperties, false, kind);
    assert.deepEqual(schema.required, Object.keys(schema.properties), kind);
  }
  assert.ok(VISION_SCHEMAS.daily_summary.properties.fieldConfidence.properties.revenue);
  assert.throws(() => parseVisionOutput('daily_summary', '不是 JSON'), /不是合法 JSON/);
  const parsed = parseVisionOutput('daily_summary', JSON.stringify({
    date: '2026/9/1', storeName: '万达店', revenue: 100, orders: 5, avgTicket: 20, deliveryRevenue: null, refunds: 3, confidence: 0.9,
    fieldConfidence: { date: 0.9, storeName: 0.9, revenue: 0.9, orders: 0.9, avgTicket: 0.9, deliveryRevenue: 0.9, refunds: 0.9 },
    fieldsUnreadable: ['refunds'],
  }));
  const row = parsed.rows[0];
  assert.equal(row.values.date, '2026-09-01');
  assert.equal(row.values.deliveryRevenue, null, 'null 不会变 0');
  assert.equal(row.values.refunds, null, '声明不可读的字段即便有值也置空');
  assert.equal(row.confidences.refunds, 0);
  assert.ok(row.unreadable.includes('deliveryRevenue'));
});

test('日结单识别：两阶段计费结算、结构化行进入预览、低置信标黄、未识别为空、门店解析', async () => {
  const file = upload('日结单.png');
  const before = balanceOfTenant(CHAIN);
  const estimate = await call('/data-intake/vision-estimate', { method: 'POST', body: { fileIds: [file.id], kind: 'daily_summary' } });
  assert.equal(estimate.status, 200, JSON.stringify(estimate.payload));
  assert.ok(estimate.payload.estimatedCredits > 0);
  assert.equal(estimate.payload.files[0].cached, false);
  assert.equal(estimate.payload.balance, before);

  const out = await call('/data-intake/vision-preview', { method: 'POST', body: { fileIds: [file.id], kind: 'daily_summary' } });
  assert.equal(out.status, 200, JSON.stringify(out.payload));
  assert.equal(out.payload.ok, true);
  assert.equal(out.payload.files[0].status, 'ok');
  assert.equal(out.payload.files[0].billing.state, 'settled');
  assert.ok(out.payload.files[0].billing.chargedCredits > 0);
  assert.equal(heldRows(CHAIN).length, 0);
  assert.equal(balanceOfTenant(CHAIN), before - out.payload.files[0].billing.chargedCredits);

  const request = providerRequests.at(-1);
  assert.equal(request.response_format.type, 'json_schema');
  assert.equal(request.response_format.json_schema.strict, true);
  assert.equal(request.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(request.messages.at(-1).content[1].type, 'image_url');

  const batch = out.payload.batches[0];
  assert.equal(batch.target, 'store_daily');
  assert.equal(batch.source.type, 'vision');
  assert.equal(batch.source.fileId, file.id);
  assert.equal(batch.lowConfidenceThreshold, LOW_CONFIDENCE);
  const row = batch.rows[0];
  assert.equal(row.valid, true);
  assert.equal(row.data.revenue, 8650.5);
  assert.equal(row.data.orders, 312);
  assert.equal(Object.prototype.hasOwnProperty.call(row.data, 'avg_ticket'), false, '未识别字段为空，不是 0');
  assert.equal(Object.prototype.hasOwnProperty.call(row.data, 'refunds'), false);
  assert.deepEqual(row.lowConfidenceFields, ['订单数']);
  assert.deepEqual(row.unreadableFields.sort(), ['客单价', '退款']);
  assert.equal(row.fieldConfidence['营收'], 0.93);
  assert.equal(row.store.id, storeWanda);

  // 同一文件再识别：沿用已落库的结构化结果，不再计费
  const cached = await call('/data-intake/vision-preview', { method: 'POST', body: { fileIds: [file.id], kind: 'daily_summary' } });
  assert.equal(cached.payload.files[0].status, 'cached');
  assert.equal(cached.payload.billing.chargedCredits, 0);
  assert.equal(balanceOfTenant(CHAIN), before - out.payload.files[0].billing.chargedCredits);
  const stored = q.get('SELECT extract_mode FROM uploaded_files WHERE tenant_id=? AND id=?', CHAIN, file.id);
  assert.match(stored.extract_mode, /AI识图·结构化/);

  // 识别结果直接走现有提交链路 → store_daily_ops，来源标记 vision_import
  const committed = await call('/data-intake/commit', { method: 'POST', body: { idempotencyKey: key(), batches: [batch] } });
  assert.equal(committed.status, 200, JSON.stringify(committed.payload));
  assert.equal(committed.payload.imported, 1);
  const saved = q.get('SELECT * FROM store_daily_ops WHERE tenant_id=? AND store_id=? AND date=?', CHAIN, storeWanda, '2026-09-01');
  assert.equal(saved.revenue, 8650.5);
  assert.equal(saved.orders, 312);
  assert.equal(saved.avg_ticket, Number((8650.5 / 312).toFixed(2)));
  assert.equal(saved.refunds, null);
  assert.equal(saved.source, 'vision_import');
  assert.equal(q.get('SELECT file_id FROM data_import_jobs WHERE tenant_id=? ORDER BY id DESC LIMIT 1', CHAIN).file_id, file.id);
});

test('菜单照片识别 → 菜品预览：缺价格的菜标为待补，门店留空归默认店', async () => {
  const file = upload('菜单.jpg');
  const out = await call('/data-intake/vision-preview', { method: 'POST', body: { fileIds: [file.id], kind: 'menu' } });
  assert.equal(out.status, 200, JSON.stringify(out.payload));
  const batch = out.payload.batches[0];
  assert.equal(batch.target, 'dishes');
  assert.equal(batch.rows.length, 2);
  assert.equal(batch.rows[0].valid, true);
  assert.equal(batch.rows[0].data.name, '招牌牛肉面');
  assert.equal(batch.rows[0].store.defaulted, true);
  assert.equal(batch.rows[0].store.id, storeWanda);
  assert.equal(batch.rows[1].valid, false, '价格未识别必须人工填或删行');
  assert.match(batch.rows[1].error, /售价/);
  assert.ok(batch.rows[1].unreadableFields.includes('售价'));
});

test('识别失败释放 hold：非法 JSON、零用量、auto 无法判定、超时都不扣分', async () => {
  const bad = upload('坏JSON.png');
  const zero = upload('零用量.png');
  const unknown = upload('看不出.png');
  const before = balanceOfTenant(CHAIN);
  const out = await call('/data-intake/vision-preview', { method: 'POST', body: { fileIds: [bad.id, zero.id, unknown.id], kind: 'auto' } });
  assert.equal(out.status, 200, JSON.stringify(out.payload));
  assert.equal(out.payload.ok, false);
  assert.equal(out.payload.batches.length, 0);
  const byId = Object.fromEntries(out.payload.files.map(item => [item.fileId, item]));
  assert.equal(byId[bad.id].status, 'failed');
  assert.match(byId[bad.id].error, /不是合法 JSON/);
  assert.equal(byId[bad.id].billing.state, 'released');
  assert.equal(byId[zero.id].status, 'failed');
  assert.equal(byId[zero.id].billing.state, 'released');
  assert.equal(byId[unknown.id].status, 'failed');
  assert.equal(byId[unknown.id].code, 'VISION_KIND_UNKNOWN');
  assert.equal(byId[unknown.id].billing.state, 'released');
  assert.equal(heldRows(CHAIN).length, 0);
  assert.equal(balanceOfTenant(CHAIN), before);
  assert.equal(out.payload.billing.chargedCredits, 0);
  // 失败的文件不会留下可复用的"结构化结果"
  assert.doesNotMatch(String(q.get('SELECT extract_mode FROM uploaded_files WHERE tenant_id=? AND id=?', CHAIN, bad.id).extract_mode), /结构化/);
});

test('超时释放 hold', { timeout: 20000 }, async () => {
  const previousTimeout = process.env.DATA_INTAKE_VISION_TIMEOUT_MS;
  process.env.DATA_INTAKE_VISION_TIMEOUT_MS = '1500';
  try {
    const slow = upload('超时.png');
    const before = balanceOfTenant(CHAIN);
    const out = await call('/data-intake/vision-preview', { method: 'POST', body: { fileIds: [slow.id], kind: 'daily_summary' } });
    assert.equal(out.status, 200, JSON.stringify(out.payload));
    assert.equal(out.payload.files[0].status, 'failed');
    assert.equal(out.payload.files[0].billing?.state, 'released');
    assert.equal(heldRows(CHAIN).length, 0);
    assert.equal(balanceOfTenant(CHAIN), before);
  } finally {
    if (previousTimeout === undefined) delete process.env.DATA_INTAKE_VISION_TIMEOUT_MS;
    else process.env.DATA_INTAKE_VISION_TIMEOUT_MS = previousTimeout;
  }
});

test('权限、租户隔离与数量/类型限制', async () => {
  const file = upload('日结单.png');
  const denied = await call('/data-intake/vision-preview', { method: 'POST', user: 'sales', body: { fileIds: [file.id], kind: 'daily_summary' } });
  assert.equal(denied.status, 403);
  const foreign = await call('/data-intake/vision-preview', { method: 'POST', user: 'otherBoss', body: { fileIds: [file.id], kind: 'daily_summary' } });
  assert.equal(foreign.status, 404, JSON.stringify(foreign.payload));
  assert.equal(balanceOfTenant(OTHER), 5000);
  const tooMany = await call('/data-intake/vision-preview', { method: 'POST', body: { fileIds: Array.from({ length: 11 }, (_, i) => i + 1), kind: 'daily_summary' } });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.payload.error, /最多识别 10 张/);
  const badKind = await call('/data-intake/vision-preview', { method: 'POST', body: { fileIds: [file.id], kind: 'receipt' } });
  assert.equal(badKind.status, 400);
  const empty = await call('/data-intake/vision-preview', { method: 'POST', body: { fileIds: [], kind: 'auto' } });
  assert.equal(empty.status, 400);
  const notImage = runWithTenant(CHAIN, () => {
    const saved = saveUploadedFile({ name: '说明.txt', b64: Buffer.from('hello').toString('base64'), mime: 'text/plain', purpose: 'data-intake', userId: users.boss.id });
    writtenPaths.push(saved.row.file_path);
    return saved.row;
  });
  const wrongType = await call('/data-intake/vision-preview', { method: 'POST', body: { fileIds: [notImage.id], kind: 'auto' } });
  assert.equal(wrongType.status, 400);
  assert.match(wrongType.payload.error, /只支持图片/);
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  providerServer.closeAllConnections?.();
  await new Promise(resolve => providerServer.close(resolve));
  delete process.env.YUNWU_API_KEY;
  for (const filePath of writtenPaths) {
    try { fs.rmSync(filePath, { force: true }); } catch { /* clean uploaded test file */ }
  }
  try { db.close(); } catch { /* already closed */ }
  await removeTempDbSafely(DBP, { closeDb: false });
});

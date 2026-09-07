// Explicit paid-cloud smoke: isolated data, one synthetic image, one generation.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
if (!process.argv.includes('--run')) {
  console.log('Use --run to invoke the configured vision API once in an isolated test database.');
  process.exit(0);
}
const require = createRequire(new URL('../server/package.json', import.meta.url));
const express = require('express');
const { Resvg } = require('@resvg/resvg-js');
const outputDir = path.resolve('artifacts/acceptance-2026-09-05');
fs.mkdirSync(outputDir, { recursive: true });
process.env.NANOWORK_DB = path.join(outputDir, `xhs-live-${Date.now()}.db`);
process.env.ENABLE_SCHEDULER = 'false';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';
process.env.NANOWORK_TEST_TEMPLATE_AI = '0';
const { initSchema, migrateV2, q, runWithTenant } = await import('../server/src/db.js');
const { saveUploadedFile } = await import('../server/src/engines/filehub.js');
const router = (await import('../server/src/routes/ai-xhs-note.js')).default;
initSchema(); migrateV2();
const tenantId = 905511;
q.run("INSERT INTO tenants(id,name,status,plan,credits) VALUES(?,'图文视觉隔离验收','已开通','旗舰版',100000)", tenantId);
const actorId = Number(q.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits) VALUES(?,'not-login-enabled','验收老板','boss','启用',?,100000)", `xhs-live-${Date.now()}`, tenantId).lastInsertRowid);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960"><rect width="720" height="960" fill="#fff3de"/><rect x="40" y="50" width="640" height="100" fill="#304332"/><text x="360" y="113" text-anchor="middle" font-size="38" fill="white">三石餐馆 · 合成验收图</text><circle cx="360" cy="430" r="230" fill="#fcfcfc" stroke="#ddd" stroke-width="8"/><ellipse cx="360" cy="430" rx="175" ry="145" fill="#b56236"/><circle cx="300" cy="370" r="34" fill="#407841"/><circle cx="445" cy="460" r="29" fill="#d62e22"/><text x="360" y="750" text-anchor="middle" font-size="27">本图仅测试图文生成，不是真实菜品照片</text></svg>';
const png = new Resvg(svg).render().asPng();
const imagePath = path.join(outputDir, 'xhs-synthetic-input.png');
fs.writeFileSync(imagePath, png);
const file = runWithTenant(tenantId, () => saveUploadedFile({ name: '合成验收图.png', mime: 'image/png', b64: png.toString('base64'), purpose: 'xhs-live', userId: actorId })).row;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: actorId, role: 'boss', tenant_id: tenantId }; runWithTenant(tenantId, next); });
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const response = await fetch(`${base}/ai-xhs-note`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brandName: '三石餐馆', brief: '这是一张明确标注的合成验收图。仅测试接口识图与门店官方图文创作，请如实说明图片用途，不编造菜名、口味、地址、价格、销量。', fileIds: [file.id], requestKey: `live-xhs-${Date.now()}` }) });
  const created = await response.json();
  if (!response.ok) throw new Error(created.error || `HTTP ${response.status}`);
  let job = created;
  const deadline = Date.now() + 365000;
  while (job.status === 'running' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    job = await fetch(`${base}/ai-xhs-note/jobs/${job.id}`).then(r => r.json());
  }
  const row = runWithTenant(tenantId, () => q.get('SELECT body,snapshot_json FROM contents WHERE tenant_id=? AND id=?', tenantId, job.id));
  const snapshot = JSON.parse(row.snapshot_json);
  const report = { executedAt: new Date().toISOString(), evidence: 'real_configured_vision_api_synthetic_input',
    inputImage: imagePath, jobId: job.id, status: job.status, output: job.output, error: job.error,
    billing: job.billing, model: snapshot.model, usage: snapshot.usage, decision: job.decision,
    limitation: '合成验收图用于验证视觉接口和图文交付；不替代实际门店照片内容质量验收。' };
  fs.writeFileSync(path.join(outputDir, 'xhs-live-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outputDir, 'xhs-live-output.md'), row.body || '本次无输出');
  console.log(JSON.stringify({ status: job.status, billing: job.billing?.state, model: snapshot.model, usage: snapshot.usage, report: path.join(outputDir, 'xhs-live-report.json') }));
  if (job.status !== 'success' || job.billing?.state !== 'settled') process.exitCode = 1;
} finally { await new Promise(resolve => server.close(resolve)); }

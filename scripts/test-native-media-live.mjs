// Explicit paid acceptance only; uses the app's real routes/providers against a
// SQLite backup. Never alters live users, credit balances, or task rows.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const kind = process.argv.find(arg => ['sales', 'xhs'].includes(arg));
const textOnly = kind === 'xhs' && process.argv.includes('--text-only');
const voiceTransitionCase = kind === 'sales' && process.argv.includes('--voice-transition-case');
if (!process.argv.includes('--run') || !kind) throw new Error('Use --run sales|xhs to authorize one real paid acceptance task.');
const out = path.join(root, 'artifacts/native-live-test-2026-09-05/升级实测', voiceTransitionCase ? 'sales-voice-transition' : textOnly ? 'xhs-text-refinement' : kind);
fs.mkdirSync(out, { recursive: true });
const receipt = path.join(out, 'execution.json');
if (fs.existsSync(receipt)) throw new Error('Execution already recorded. Inspect existing task; do not repeat paid generation.');
const privateDir = fs.mkdtempSync('/private/tmp/nanowork-native-upgrade-');
fs.chmodSync(privateDir, 0o700);
const dbPath = path.join(privateDir, 'test.db');
execFileSync('python3', ['-c', 'import sqlite3,sys; a=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); b=sqlite3.connect(sys.argv[2]); a.backup(b); b.close(); a.close()', path.join(root, 'server/data/nanowork-preview.db'), dbPath]);
Object.assign(process.env, { NANOWORK_DB: dbPath, NANOWORK_TEST_TEMPLATE_AI: '0', SEED_DEMO: 'false', ENABLE_SCHEDULER: 'false', ENABLE_BACKGROUND_EMBEDDINGS: 'false', PROVIDER_MEDIA_TRUSTED_PROXY: '1', PROVIDER_MEDIA_TRUSTED_PROXY_HOSTS: 'dashscope-a717.oss-accelerate.aliyuncs.com,public-cdn-video-data-algeng.oss-cn-wulanchabu.aliyuncs.com' });
const mod = relative => import(pathToFileURL(path.join(root, relative)).href);
const require = createRequire(path.join(root, 'server/package.json'));
const { db, q, DB_PATH, initSchema, migrateV2, runWithTenant } = await mod('server/src/db.js');
if (DB_PATH !== dbPath) throw new Error('Database isolation mismatch');
initSchema(); migrateV2();
const tenantId = 1;
const actor = q.get("SELECT id,role,tenant_id,name FROM users WHERE tenant_id=? AND role='boss' AND status='启用' ORDER BY id LIMIT 1", tenantId);
if (!actor) throw new Error('Missing existing authorized tenant owner');
const files = q.all('SELECT id,name,file_path,mime FROM uploaded_files WHERE tenant_id=? AND id IN(2,3) ORDER BY id', tenantId);
if (files.length !== 2) throw new Error('Missing user uploaded restaurant reference photos');
const before = { credits: q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, contents: q.get('SELECT COUNT(*) AS n FROM contents').n, mediaJobs: q.get('SELECT COUNT(*) AS n FROM media_jobs').n };
const scrub = (value, key = '') => {
  if (/(?:api.?key|authorization|password|cookie|secret)/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (key.endsWith('_json')) { try { return scrub(JSON.parse(value)); } catch { return value; } }
    if (value.startsWith('data:')) return '[reference image bytes saved in input folder]';
    return value.replace(/https?:\/\/[^\s"<>]+/g, url => { try { const parsed = new URL(url); parsed.search = ''; parsed.hash = ''; parsed.username = ''; parsed.password = ''; return parsed.href; } catch { return '[invalid URL]'; } });
  }
  if (Array.isArray(value)) return value.map(item => scrub(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item, name)]));
  return value;
};
const write = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(scrub(data), null, 2) + '\n');
for (const file of files) fs.copyFileSync(file.file_path, path.join(out, `input-${file.id}.jpg`));
const brief = kind === 'sales'
  ? '为罗二火锅制作30秒竖屏带货视频。依据上传的门头和火锅桌面照片，先展示红油火锅及围桌配菜，再呈现门店灯牌。保持品牌字样、锅具和菜品外观。声音由Wan2.6直接生成，两段使用一致、自然、有食欲感的普通话女声旁白，保留轻微锅底咕嘟声，生成后加中文字幕。每段旁白简练，不堆砌“人间烟火气、匠心、味蕾盛宴”等套话。以品牌自身的菜品分享口吻，不能伪装顾客亲测。地址、价格、优惠、食材产地和营业状态未提供，不要添加；不引用其他门店资料。重点是火锅桌面与食物，不放大照片中的陌生人，不生成他们的发言。'
  : '根据两张照片为罗二火锅生成一篇有食欲、有具体画面的小红书笔记，并用Image2生成3张统一风格的竖版配图：食物封面、菜品近景、用餐氛围。第三张加入一位自然、好看的成年女性用餐，人物由AI创作，不复制原照片中的顾客。封面突出红油火锅和品牌，别做成传单。正文150–250字短段，写清红油/中间清汤锅格、肉片、土豆片与蘸碟等能看见的特点，不能替不确定的配菜编造品名。口吻是品牌分享，不虚构探店经历。不要“围炉而坐、人间烟火气、大家好我是主理人、视觉构思、黄金搭档”的套话。品牌自然出现，首评提出一个具体吃法问题。价格、优惠、地址、食材产地没有提供，不要添加。生成图注明AI创意，供用户选择后发布。';
const body = kind === 'sales'
  ? { model: 'wan2.6-i2v', mode: 'voiced', audioMode: 'provider_native', brief, fileIds: [3, 2] }
  : { brandName: '罗二火锅', brief: textOnly ? '配图已完成，本次只优化罗二火锅的小红书文字。主标题18字以内，让食客想到一个具体用餐时刻或吃法，不写目录式介绍。正文150–220字，品牌自然出现一次，2–3个短段；用邀约和吃法建议写，不伪装顾客体验。已知照片是外圈红油、中间清汤的圆锅，桌面有肉片、土豆片、蘸碟；可围绕先涮什么、红汤清汤怎么选组织内容。不能把可见肉片叫成具体肉类，不能推断锅底是牛油、土豆脆嫩或菜的加工工艺。不编造价格、地址、优惠和营业事实，不写“整体铺陈、处理得当、层次感分明、直接满足感、人间烟火气”。首评提出一个具体吃法偏好问题。输出标题、正文、标签和首评，保留自然说话的节奏。' : brief, fileIds: [2, 3], requestKey: `live-image2-${Date.now()}`, generateImages: !textOnly, imageCount: 3, includeDiner: true };
const state = { kind, startedAt: new Date().toISOString(), environment: 'Real configured APIs, isolated SQLite copy, original user uploads', productionDatabaseMutated: false, before, body };
write('execution.json', state);
fs.writeFileSync(path.join(privateDir, 'state.json'), JSON.stringify({ dbPath, out, pid: process.pid, kind }));
console.log(JSON.stringify({ event: 'ready', kind, privateDir, out }));
const app = require('express')();
app.use(require('express').json({ limit: '40mb' }));
app.use((req, res, next) => { req.user = { ...actor }; runWithTenant(tenantId, next); });
app.use((await mod(kind === 'sales' ? 'server/src/routes/content.js' : 'server/src/routes/ai-xhs-note.js')).default);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(route, input) {
  const res = await fetch(base + route, { method: input ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
  return { http: res.status, data: await res.json() };
}
try {
  if (kind === 'sales') {
    const options = await request('/ai-sales-video/options');
    write('options.json', options);
    if (!options.data.ready) throw new Error(`Generation not ready: ${JSON.stringify(options.data.blockers)}`);
    body.quoteFingerprint = options.data.quoteFingerprint;
  }
  write('request.json', { body, files: files.map(({ file_path, ...file }) => file) });
  const submitted = await request(kind === 'sales' ? '/ai-sales-video' : '/ai-xhs-note', body);
  write('submitted.json', submitted);
  const id = submitted.data.jobId || submitted.data.id;
  state.id = id; state.submittedHttp = submitted.http; write('execution.json', state);
  fs.writeFileSync(path.join(privateDir, 'state.json'), JSON.stringify({ dbPath, out, pid: process.pid, kind, id }));
  console.log(JSON.stringify({ event: 'submitted', kind, id, http: submitted.http }));
  if (submitted.http >= 400) throw new Error(submitted.data.error || 'Submission rejected');
  let latest;
  for (;;) {
    latest = (await request(kind === 'sales' ? `/media-jobs/${id}` : `/ai-xhs-note/jobs/${id}`)).data;
    write('progress.json', latest);
    const row = q.get(`SELECT * FROM ${kind === 'sales' ? 'media_jobs' : 'contents'} WHERE id=? AND tenant_id=?`, id, tenantId);
    const snapshot = JSON.parse(row.snapshot_json || '{}');
    write('snapshot.json', snapshot);
    const running = ['running', 'processing', 'queued', '生成中', '处理中'].includes(latest.technicalStatus || latest.status);
    const imagesRunning = ['pending', 'queued', 'running', 'processing'].includes(latest.imageGeneration?.status);
    console.log(JSON.stringify({ event: 'progress', kind, id, status: latest.technicalStatus || latest.status, stage: latest.salesVideo?.stage, imageStatus: latest.imageGeneration?.status }));
    if (!running && !imagesRunning) break;
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  const row = q.get(`SELECT * FROM ${kind === 'sales' ? 'media_jobs' : 'contents'} WHERE id=? AND tenant_id=?`, id, tenantId);
  const snapshot = JSON.parse(row.snapshot_json || '{}');
  write('final.json', { result: latest, row, snapshot });
  write('ledger.json', q.all('SELECT h.*,l.credits,l.cost_yuan,l.note FROM credit_holds h LEFT JOIN credit_logs l ON l.id=h.log_id WHERE h.tenant_id=? AND h.ref_id=? ORDER BY h.id', tenantId, id));
  if (row.body) fs.writeFileSync(path.join(out, 'output.md'), row.body);
  state.endedAt = new Date().toISOString(); state.status = latest.status;
  write('execution.json', state);
} catch (error) {
  write('harness-error.json', { message: error.message, code: error.code });
  console.log(JSON.stringify({ event: 'error', kind, message: error.message }));
  process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve)); db.close();
  console.log(JSON.stringify({ event: 'done', kind, privateDir }));
}

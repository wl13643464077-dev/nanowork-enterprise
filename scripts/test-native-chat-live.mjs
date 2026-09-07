// Explicit paid acceptance, using real routes/providers and an isolated SQLite
// backup. One run per output folder; it never retries a paid request by itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';

const root = path.resolve(import.meta.dirname, '..');
const kind = process.argv.find(arg => ['xhs', 'sales'].includes(arg));
const resumeDir = process.argv.find(arg => arg.startsWith('--resume='))?.slice('--resume='.length);
const caseName = process.argv.find(arg => arg.startsWith('--case='))?.slice('--case='.length) || '';
const duration15Case = kind === 'sales' && caseName === 'duration15';
const nativeVoiceCase = kind === 'sales' && (caseName === 'native-voice' || duration15Case);
const expectedVideoDuration = duration15Case ? 15 : 30;
if (caseName && !/^[a-zA-Z0-9_-]{1,40}$/.test(caseName)) throw new Error('Invalid acceptance case name');
if (!process.argv.includes('--run') || !kind) throw new Error('Use --run xhs|sales for one authorized real paid acceptance.');
const out = path.join(root, 'artifacts/native-chat-live-2026-09-06', caseName, kind);
fs.mkdirSync(out, { recursive: true });
if (fs.existsSync(path.join(out, 'execution.json')) && !resumeDir) throw new Error('A run already exists. Inspect its receipt; never repeat a paid call automatically.');
if (resumeDir && !/^\/private\/tmp\/nanowork-chat-live-[a-zA-Z0-9]+$/.test(resumeDir)) throw new Error('Invalid private receipt directory');
const privateDir = resumeDir || fs.mkdtempSync('/private/tmp/nanowork-chat-live-');
fs.chmodSync(privateDir, 0o700);
const dbPath = path.join(privateDir, 'test.db');
if (resumeDir) {
  const previous = JSON.parse(fs.readFileSync(path.join(privateDir, 'state.json'), 'utf8'));
  assert.equal(previous.dbPath, dbPath); assert.equal(previous.kind, kind); assert.equal(previous.out, out);
} else execFileSync('python3', ['-c', 'import sqlite3,sys; a=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); b=sqlite3.connect(sys.argv[2]); a.backup(b); b.close(); a.close()', path.join(root, 'server/data/nanowork-preview.db'), dbPath]);
Object.assign(process.env, { NANOWORK_DB: dbPath, NANOWORK_TEST_TEMPLATE_AI: '0', SEED_DEMO: 'false', ENABLE_SCHEDULER: 'false', ENABLE_BACKGROUND_EMBEDDINGS: 'false', PROVIDER_MEDIA_TRUSTED_PROXY: '1', PROVIDER_MEDIA_TRUSTED_PROXY_HOSTS: 'dashscope-a717.oss-accelerate.aliyuncs.com,public-cdn-video-data-algeng.oss-cn-wulanchabu.aliyuncs.com' });
const mod = relative => import(pathToFileURL(path.join(root, relative)).href);
const require = createRequire(path.join(root, 'server/package.json'));
const { db, q, DB_PATH, initSchema, migrateV2, runWithTenant } = await mod('server/src/db.js');
assert.equal(DB_PATH, dbPath);
initSchema(); migrateV2();
const tenantId = 1;
const actor = q.get("SELECT id,role,tenant_id,name FROM users WHERE tenant_id=? AND role='boss' AND status='启用' ORDER BY id LIMIT 1", tenantId);
assert.ok(actor, 'Existing authorized owner required');
const files = q.all('SELECT id,name,file_path,mime FROM uploaded_files WHERE tenant_id=? AND user_id=? AND id IN(2,3) ORDER BY id', tenantId, actor.id);
assert.equal(files.length, 2, 'Use the original restaurant photos');
const oldState = resumeDir ? JSON.parse(fs.readFileSync(path.join(out, 'execution.json'), 'utf8')) : null;
const before = oldState?.before || { credits: q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits, lastHold: q.get('SELECT COALESCE(MAX(id),0) AS id FROM credit_holds').id, contents: q.get('SELECT COUNT(*) AS n FROM contents').n, media: q.get('SELECT COUNT(*) AS n FROM media_jobs').n };
function scrub(value, key = '') {
  if (/(?:api.?key|authorization|password|cookie|secret)/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (key.endsWith('_json')) { try { return scrub(JSON.parse(value)); } catch { /* keep text */ } }
    if (value.startsWith('data:')) return '[reference image bytes in input files]';
    return value.replace(/https?:\/\/[^\s"<>]+/g, url => { try { const parsed = new URL(url); parsed.search = ''; parsed.hash = ''; parsed.username = ''; parsed.password = ''; return parsed.href; } catch { return '[URL]'; } });
  }
  if (Array.isArray(value)) return value.map(item => scrub(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item, name)]));
  return value;
}
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(scrub(value), null, 2) + '\n');
for (const file of files) fs.copyFileSync(file.file_path, path.join(out, `输入照片-${file.id}.jpg`));
const state = oldState || { kind, startedAt: new Date().toISOString(), environment: '真实配置API、隔离数据库副本、用户原始实拍', productionDatabaseMutated: false, before };
if (oldState) { state.resumedAt = new Date().toISOString(); state.initialFailure = state.error; delete state.error; }
write('execution.json', state);
fs.writeFileSync(path.join(privateDir, 'state.json'), JSON.stringify({ dbPath, out, pid: process.pid, kind }));
const eventFile = path.join(out, 'provider-http-evidence.json');
const providerEvents = resumeDir && fs.existsSync(eventFile) ? JSON.parse(fs.readFileSync(eventFile, 'utf8')) : [], originalFetch = globalThis.fetch;
globalThis.fetch = async (resource, init) => {
  const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
  const method = init?.method || resource?.method || 'GET';
  const external = !['127.0.0.1', 'localhost'].includes(url.hostname);
  const start = Date.now();
  let requestEvidence;
  if (nativeVoiceCase && external && method === 'POST') {
    assert.ok(!/\/audio\/speech|\/tts(?:\/|$)|text.to.speech/iu.test(url.pathname), 'Native voice acceptance must never call external TTS');
    if (url.pathname.endsWith('/video-synthesis')) {
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'wan2.6-i2v');
      assert.equal(Object.hasOwn(body.input, 'audio_url'), false, 'Wan must generate its own voice');
      requestEvidence = { model: body.model, prompt: body.input.prompt, parameters: body.parameters, externalAudioSupplied: false };
    }
  }
  try {
    const response = await originalFetch(resource, init);
    if (external && method !== 'GET') {
      providerEvents.push({ at: new Date().toISOString(), endpoint: url.origin + url.pathname, method, status: response.status, elapsedMs: Date.now() - start, ...(requestEvidence ? { request: requestEvidence } : {}) });
      write('provider-http-evidence.json', providerEvents);
    }
    return response;
  } catch (error) {
    if (external) { providerEvents.push({ at: new Date().toISOString(), endpoint: url.origin + url.pathname, method, error: error.name, ...(requestEvidence ? { request: requestEvidence } : {}) }); write('provider-http-evidence.json', providerEvents); }
    throw error;
  }
};
const app = require('express')();
app.use(require('express').json({ limit: '40mb' }));
app.use((req, res, next) => { req.user = { ...actor }; runWithTenant(tenantId, next); });
app.use('/api/content/native-deliverables', (await mod('server/src/routes/native-deliverables.js')).default);
app.use('/api/content', (await mod('server/src/routes/media-review.js')).default, (await mod('server/src/routes/native-creative-chat.js')).default, (await mod('server/src/routes/ai-xhs-note.js')).default, (await mod('server/src/routes/content.js')).default);
app.use('/api/task-center', (await mod('server/src/routes/task-center.js')).default);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
async function request(route, body) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${value.error || 'Request failed'}`);
  return value;
}
const table = kind === 'xhs' ? 'contents' : 'media_jobs';
try {
  const created = state.sessionId ? await request(`/api/content/native-chat/sessions/${state.sessionId}`) : await request('/api/content/native-chat/sessions', { employeeIdx: kind === 'xhs' ? 11 : 10 });
  const sessionId = created.session.id;
  state.sessionId = sessionId; write('execution.json', state);
  let message = kind === 'xhs'
    ? '这是罗二火锅的门头和菜品照片。帮我做一套六图的小红书种草，主题是下班约朋友来吃火锅，封面用四宫格拼图。文案你来写，像店里招呼朋友一样自然，不要“人间烟火气、味蕾盛宴”这些套话。照片里确定是红油与清汤分区火锅、肉片、土豆片和蘸碟，不确定的菜不猜品名。别编造价格、优惠、地址、食材来源或亲测口感。配图保留真实锅型，突出菜品食欲，不要生成照片里顾客的脸。'
    : '这是罗二火锅的门头和菜品照片。帮我做一条30秒竖版带货视频，主题是下班和朋友来吃一锅，脚本你来写。配自然的普通话女声和中文字幕，中间过渡柔和。照片里确定是红油与清汤分区火锅、肉片、土豆片和蘸碟，不确定的菜不猜品名。保持菜品和门头品牌，不复制顾客的脸，不编造价格、优惠、地址、食材来源或亲测口感。';
  if (caseName) message += kind === 'xhs'
    ? '请用品牌招呼顾客的口吻写，不能冒充已经吃过的顾客；不写几秒涮熟、颜色判断熟度或口感断言。首评问红汤清汤的偏好，不写求网友推荐店铺。六张分别看完整锅、局部食物、门头、侧面、配菜、俯拍，不要六张都照搬同一构图。'
    : '第一段重点拍菜品，第二段衔接门头照片，让人记住店名；每段只安排一个自然缓慢的镜头动作。每段女声旁白25到40字，结尾自然邀请来坐坐，不喊口号。';
  if (nativeVoiceCase) message = '这是罗二火锅的门头和菜品照片。主题是下班约朋友吃火锅，帮我写脚本并做一条30秒竖版视频，第一段菜品、第二段门头，保留真实品牌。声音必须由万相2.6和视频一起生成，不要另外配音。女声像跟朋友聊天，说话轻松自然，有停顿和轻重，不要念广告稿，不要压低嗓音，也不要每个字一样快。每段一两句，话少一点，不必说满15秒，不铺背景音乐。只根据照片和我给的信息写，不编价格、优惠、地址、食材来源和亲测口感，不写几秒涮熟或简单烫一下就能吃。照片中确认有红油与清汤分区火锅、肉片、土豆片和蘸碟。结尾顺口约朋友来罗二火锅吃饭，不用欢迎光临那种播报。中文字幕，保留自然原声。';
  if (duration15Case) message = '这是罗二火锅的门头和菜品照片。主题是下班约朋友吃火锅，帮我做一条简短的竖版视频，脚本你来写。像朋友聊天一样自然地约大家来吃饭，只用万相2.6原生声音，加中文字幕。照片确认是红油与清汤分区火锅、肉片、土豆片和蘸碟，不猜其他品名，不编价格、优惠、地址、食材来源或亲测口感，不写烫几秒就能吃。一两句就好，留点自然环境音，不铺背景音乐。';
  const input = { message, fileIds: [3, 2], requestKey: `live_chat_${kind}_first` };
  if (duration15Case) assert.equal(created.session.options.durationSeconds, 15, 'New chat defaults to 15 seconds without a UI option or duration in the theme');
  write('01-用户输入.json', input);
  console.log(JSON.stringify({ event: 'chat', kind, out, privateDir, sessionId }));
  let draft = created.session.messages.length ? created : await request(`/api/content/native-chat/sessions/${sessionId}/messages`, input);
  if (!resumeDir) write('02-首次回复与方案.json', draft);
  if (resumeDir && !caseName && !draft.session.currentPlan?.ready && !draft.session.generation) {
    const holdsBefore = q.get('SELECT COUNT(*) AS n FROM credit_holds').n;
    draft = await request(`/api/content/native-chat/sessions/${sessionId}/revalidate`, { planVersion: draft.session.currentPlan.version });
    assert.equal(q.get('SELECT COUNT(*) AS n FROM credit_holds').n, holdsBefore, 'Local revalidation must not charge');
    write('02b-原稿免费重新检查.json', draft);
  }
  if (kind === 'sales') {
    assert.ok(draft.session.currentPlan?.script?.shots?.length, 'A readable script should be delivered before refinement');
    const revision = { message: nativeVoiceCase
      ? `保留可读脚本，把阻碍生成的问题改好；只写照片可见和我已确认的信息，去掉新鲜、治愈、太香等未经证实的描述，不编事实编号。${duration15Case ? '保持默认15秒一段短话。' : '每段一两句短话。'}像朋友顺口约吃饭，声音只用万相原生生成，其他要求不变。`
      : '结尾改成温和的到店邀请，不要强促销。两段用同一种自然女声，每段旁白25到40字，菜品到门头不要硬切。去掉“新鲜”“太香”“治愈”等照片无法证实的描述，只用照片可见内容和我的已确认信息，别编造facts_used事实编号。其他要求保持。', requestKey: 'live_chat_sales_revision' };
    if (!nativeVoiceCase || !draft.session.currentPlan?.ready) {
      write('03-用户修改意见.json', revision);
      if (!draft.session.messages.some(item => item.role === 'user' && item.content === revision.message)) draft = await request(`/api/content/native-chat/sessions/${sessionId}/messages`, revision);
    }
    write('04-修改后方案.json', draft);
    assert.equal(draft.session.currentPlan?.ready, true, `Revised plan not ready: ${draft.session.status}`);
    assert.equal(draft.session.currentPlan.options.durationSeconds, expectedVideoDuration);
    assert.equal(draft.session.currentPlan.script.shots.length, expectedVideoDuration / 15);
  } else {
    assert.equal(draft.session.currentPlan?.ready, true, `Real draft is not ready: ${draft.session.status}`);
    assert.equal(draft.session.currentPlan.options.imageCount, 6);
    assert.equal(draft.session.currentPlan.options.coverLayout, 'collage4');
  }
  const restored = await request(`/api/content/native-chat/sessions/${sessionId}`);
  assert.deepEqual(restored.session.currentPlan, draft.session.currentPlan);
  const approved = draft.session.currentPlan;
  const confirm = { planVersion: approved.version, requestKey: `live_chat_confirm_${kind}` };
  const confirmed = await request(`/api/content/native-chat/sessions/${sessionId}/confirm`, confirm);
  write('05-确认生成回执.json', confirmed);
  const generation = confirmed.generation;
  assert.ok(generation?.jobId);
  state.jobId = generation.jobId; write('execution.json', state);
  fs.writeFileSync(path.join(privateDir, 'state.json'), JSON.stringify({ dbPath, out, pid: process.pid, kind, id: generation.jobId, sessionId }));
  const repeated = await request(`/api/content/native-chat/sessions/${sessionId}/confirm`, confirm);
  assert.equal(repeated.generation.jobId, generation.jobId);
  let final;
  const deadline = Date.now() + 35 * 60 * 1000;
  while (Date.now() < deadline) {
    final = await request('/api' + generation.pollUrl);
    write('progress.json', final);
    const status = final.technicalStatus || final.status;
    const imageStatus = final.imageGeneration?.status;
    console.log(JSON.stringify({ event: 'progress', kind, jobId: generation.jobId, status, imageStatus, stage: final.salesVideo?.stage }));
    if (!['running', 'pending', 'processing', 'queued', '生成中', '处理中'].includes(status) && !['pending', 'queued', 'running', 'processing'].includes(imageStatus)) break;
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  const row = q.get(`SELECT * FROM ${table} WHERE tenant_id=? AND id=?`, tenantId, generation.jobId);
  const snapshot = JSON.parse(row.snapshot_json || '{}');
  write('06-最终结果.json', { final, row, snapshot });
  assert.deepEqual(kind === 'xhs' ? snapshot.output : snapshot.script, kind === 'xhs' ? approved.output : approved.script, 'Exact confirmed copy/script must be reused');
  const detail = await request(`/api/task-center/${kind === 'xhs' ? 'generated_content' : 'media'}/${generation.jobId}`);
  write('07-统一任务中心.json', detail);
  assert.ok(detail.output, 'History retains actual output');
  const bundleResponse = await fetch(base + final.downloadUrl);
  assert.equal(bundleResponse.status, 200);
  assert.match(bundleResponse.headers.get('content-type'), /application\/zip/);
  const zip = Buffer.from(await bundleResponse.arrayBuffer());
  const zipFile = path.join(out, kind === 'xhs' ? '小红书六图与文案.zip' : '带货视频与脚本.zip');
  fs.writeFileSync(zipFile, zip);
  const archive = new (require('adm-zip'))(zip);
  const deliverables = path.join(out, '成品'); fs.mkdirSync(deliverables, { recursive: true });
  archive.extractAllTo(deliverables, false);
  const entries = archive.getEntries().filter(entry => !entry.isDirectory).map(entry => ({ name: entry.entryName, bytes: entry.header.size }));
  write('08-打包下载核验.json', { zipBytes: zip.length, entries, confirmationReused: true, exactApprovedPlanReused: true });
  if (kind === 'xhs') {
    assert.equal(final.imageGeneration.status, 'success', 'Inspect partial successes without reissuing paid calls');
    assert.equal(entries.filter(entry => entry.name.startsWith('图片/')).length, 6);
  } else {
    assert.equal(final.technicalStatus, '成功');
    assert.ok(entries.some(entry => entry.name.endsWith('.mp4')));
    assert.equal(snapshot.audioMode, 'provider_native');
    if (nativeVoiceCase) {
      assert.equal(snapshot.result.audioSource, 'provider_native');
      assert.equal(snapshot.voiceTracks, undefined);
      assert.equal(snapshot.paidExecution.filter(event => event.kind === 'tts').length, 0);
      assert.equal(snapshot.durationSeconds, expectedVideoDuration);
      assert.equal(snapshot.segmentCount, expectedVideoDuration / 15);
      assert.equal(snapshot.result.durationSeconds, expectedVideoDuration);
      assert.equal(providerEvents.filter(event => event.request?.model === 'wan2.6-i2v').length, expectedVideoDuration / 15);
      if (duration15Case) assert.equal(snapshot.result.transition, undefined, 'Single native clip must not splice in a second shot');
    }
  }
  state.success = true;
} catch (error) {
  state.success = false; state.error = error.message;
  write('harness-error.json', { name: error.name, message: error.message });
  console.log(JSON.stringify({ event: 'error', kind, message: error.message }));
  process.exitCode = 1;
} finally {
  const holds = q.all('SELECT h.*,l.model AS ledger_model,l.credits AS ledger_credits,l.cost_yuan,l.input_tokens,l.output_tokens,l.note FROM credit_holds h LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id WHERE h.tenant_id=? AND h.id>? ORDER BY h.id', tenantId, before.lastHold);
  write('09-真实API账本.json', holds);
  state.endedAt = new Date().toISOString(); state.creditDelta = before.credits - q.get('SELECT credits FROM tenants WHERE id=?', tenantId).credits;
  write('execution.json', state);
  await new Promise(resolve => server.close(resolve));
  globalThis.fetch = originalFetch; db.close();
  console.log(JSON.stringify({ event: 'done', kind, success: state.success, out, privateDir }));
}

import '../server/src/env.js';

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { q } from '../server/src/db.js';
import { FEATURED_TRIAL_EMPLOYEE_IDS, TESTER_EMPLOYEES } from '../server/src/engines/tester-employee-catalog.js';
import { signToken } from '../server/src/util.js';

const BASE_URL = String(process.env.RETEST_BASE_URL || 'http://127.0.0.1:3107').replace(/\/$/, '');
const BASE_ORIGIN = new URL(BASE_URL).origin;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const STAGE_CATALOG = Object.freeze([
  { id: 'tester', label: '测试员申请、Super审核、360个人Key与真实调用', paid: true },
  { id: 'employee-133', label: '随机数字员工#133 前厅服务SOP', paid: true },
  { id: 'employee-144', label: '随机数字员工#144 CRM生命周期', paid: true },
  { id: 'upload', label: '真实菜品图片上传（媒体任务的免费依赖）', paid: false },
  { id: 'xhs', label: 'AI小红书种草员：对话、完整6图、预览与打包', paid: true },
  { id: 'video', label: 'AI视频带货官：15秒原生有声、预览与打包', paid: true },
]);
const ALL_STAGE_IDS = STAGE_CATALOG.map(item => item.id);

function selectedStageIds(value) {
  const entries = String(value || '').split(/[\s,]+/u).map(item => item.trim()).filter(Boolean);
  if (!entries.length || entries.includes('all')) return new Set(ALL_STAGE_IDS);
  const unknown = entries.filter(item => !ALL_STAGE_IDS.includes(item));
  if (unknown.length) {
    throw new Error(`RETEST_STAGES包含未知阶段：${unknown.join('、')}；可选值：${ALL_STAGE_IDS.join(',')}`);
  }
  return new Set(entries);
}

const REQUESTED_STAGES = selectedStageIds(process.env.RETEST_STAGES);
const EFFECTIVE_STAGES = new Set(REQUESTED_STAGES);
if (REQUESTED_STAGES.has('xhs') || REQUESTED_STAGES.has('video')) EFFECTIVE_STAGES.add('upload');
if (process.argv.includes('--list-stages')) {
  process.stdout.write(`${JSON.stringify({
    stages: STAGE_CATALOG,
    selection: {
      requested: ALL_STAGE_IDS.filter(id => REQUESTED_STAGES.has(id)),
      effective: ALL_STAGE_IDS.filter(id => EFFECTIVE_STAGES.has(id)),
    },
  }, null, 2)}\n`);
  process.exit(0);
}
const outputFlag = process.argv.indexOf('--out');
const OUT_DIR = path.resolve(outputFlag >= 0 && process.argv[outputFlag + 1]
  ? process.argv[outputFlag + 1]
  : path.join(process.cwd(), 'artifacts', `upgrade-real-retest-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const RESULT_FILE = path.join(OUT_DIR, '真实复测结果.json');
const IO_DIR = path.join(OUT_DIR, '真实输入输出');
const SCREENSHOT_DIR = path.join(OUT_DIR, '截图');
const startedAt = new Date().toISOString();

const result = {
  schemaVersion: 'nanowork.upgrade-real-retest/2',
  startedAt,
  completedAt: null,
  baseUrl: BASE_URL,
  code: {},
  selection: {
    requestedStages: [...REQUESTED_STAGES],
    effectiveStages: ALL_STAGE_IDS.filter(id => EFFECTIVE_STAGES.has(id)),
    seed: 'nanowork-retest-2026-09-07-v1',
    employees: [
      { idx: 133, name: '前厅服务 SOP', person: '戚前厅', group: '门店运营部', rank: '02725915f7ed6327d516f1956a215b3339f2eba86691ddd9e6a9225a9d25d7d4' },
      { idx: 144, name: 'CRM、忠诚度与生命周期', person: '葛会员', group: '品牌与增长部', rank: '04fb2a9a57cffb69611cb0e5a5c939ba7a5c968d1b19f985aeede4c2a206794e' },
    ],
  },
  stages: {},
};

function now() { return new Date().toISOString(); }
function progress(message, data = undefined) {
  const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`;
  process.stdout.write(`[${now()}] ${message}${suffix}\n`);
}
function truncate(value, max = 12000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n……（报告截取，完整结果见产品历史记录）`;
}
function sanitizeString(value, max = 50000) {
  const text = truncate(value, max)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|authorization|access[_-]?token|secret)\s*[:=]\s*)[^\s,;"']+/giu, '$1[REDACTED]');
  if (!/^https?:\/\//iu.test(text)) return text;
  try {
    const url = new URL(text);
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|key|sign(?:ature)?|credential|authorization|policy|secret)/iu.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch {
    return text;
  }
}
function sanitize(value, seen = new WeakSet()) {
  if (typeof value === 'string') return sanitizeString(value, 50000);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item, seen));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:^|_)(?:api_?key|authorization|cookie|password|secret|access_?token|refresh_?token|token_cipher|api_key_cipher)(?:$|_)/iu.test(key)) {
      out[key] = '[REDACTED]';
    } else if (key === 'qrDataUrl' && typeof item === 'string') {
      out[key] = `[data-url omitted: ${item.length} chars]`;
    } else if (typeof item === 'string') {
      out[key] = sanitizeString(item, 50000);
    } else {
      out[key] = sanitize(item, seen);
    }
  }
  return out;
}

async function optionalText(filePath, maxBytes = 64 * 1024) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return String(await fs.readFile(filePath, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

function releaseManifestSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sources = [value, value.release, value.build].filter(item => item && typeof item === 'object');
  const aliases = {
    version: ['version', 'releaseVersion', 'buildVersion'],
    gitSha: ['gitSha', 'gitCommit', 'commit', 'sha', 'revision'],
    releaseTs: ['releaseTs', 'releaseTimestamp', 'builtAt', 'buildTime'],
  };
  const summary = {};
  for (const [target, keys] of Object.entries(aliases)) {
    for (const source of sources) {
      const key = keys.find(candidate => source[candidate] != null && String(source[candidate]).trim());
      if (!key) continue;
      summary[target] = truncate(source[key], 200);
      break;
    }
  }
  return Object.keys(summary).length ? summary : null;
}

async function codeIdentity() {
  const root = PROJECT_ROOT;
  let gitSha = null;
  let gitDirty = null;
  try {
    await fs.stat(path.join(root, '.git'));
    const resolved = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 5000 });
    const candidate = String(resolved.stdout || '').trim();
    if (/^[a-f0-9]{40}$/iu.test(candidate)) gitSha = candidate;
    const status = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, timeout: 5000 });
    gitDirty = Boolean(String(status.stdout || '').trim());
  } catch {
    // Production releases deliberately exclude .git; packaged metadata below
    // remains available without invoking a shell or guessing a branch name.
  }

  const packagedGitCommit = await optionalText(path.join(root, 'GIT_COMMIT'), 1024);
  const releaseTsFile = await optionalText(path.join(root, 'RELEASE_TS'), 1024);
  const manifestCandidates = [
    process.env.RETEST_RELEASE_MANIFEST,
    path.join(root, 'RELEASE_MANIFEST.json'),
    path.join(root, 'release-manifest.json'),
    path.join(root, 'manifest.json'),
    path.join(root, 'package.json'),
  ].filter(Boolean).map(file => path.resolve(file));
  let manifest = null;
  for (const file of [...new Set(manifestCandidates)]) {
    const raw = await optionalText(file);
    if (!raw) continue;
    try {
      const summary = releaseManifestSummary(JSON.parse(raw));
      if (!summary) continue;
      manifest = { file: path.basename(file), ...summary };
      break;
    } catch {
      // Ignore malformed optional metadata; the remaining sources still apply.
    }
  }
  const environment = Object.fromEntries([
    'RETEST_CODE_VERSION',
    'RELEASE_SHA',
    'GIT_COMMIT',
    'GIT_SHA',
    'COMMIT_SHA',
    'SOURCE_VERSION',
    'BUILD_VERSION',
    'RELEASE_TS',
    'BUILD_ID',
  ].flatMap(key => String(process.env[key] || '').trim() ? [[key, truncate(process.env[key], 200)]] : []));
  const envVersion = environment.RETEST_CODE_VERSION || environment.RELEASE_SHA
    || environment.GIT_COMMIT || environment.GIT_SHA || environment.COMMIT_SHA
    || environment.SOURCE_VERSION || environment.BUILD_VERSION || null;
  const packagedSha = /^[a-f0-9]{7,64}$/iu.test(String(packagedGitCommit || ''))
    ? packagedGitCommit
    : null;
  return {
    version: gitSha || packagedSha || manifest?.gitSha || envVersion
      || releaseTsFile || environment.RELEASE_TS || manifest?.releaseTs || 'unknown',
    source: gitSha ? 'git' : packagedSha ? 'GIT_COMMIT' : manifest?.gitSha
      ? 'manifest' : envVersion ? 'environment' : releaseTsFile
        ? 'RELEASE_TS' : manifest ? 'manifest' : 'unknown',
    gitSha,
    gitDirty,
    packagedGitCommit: packagedGitCommit ? truncate(packagedGitCommit, 200) : null,
    releaseTs: releaseTsFile || environment.RELEASE_TS || manifest?.releaseTs || null,
    manifest,
    environment,
  };
}
async function checkpoint() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(RESULT_FILE, `${JSON.stringify(sanitize(result), null, 2)}\n`);
}
class HttpError extends Error {
  constructor(message, response, payload) {
    super(message);
    this.name = 'HttpError';
    this.status = response.status;
    this.payload = payload;
    this.requestId = response.headers.get('x-request-id') || null;
  }
}
async function request(urlPath, { method = 'GET', token, body, timeoutMs = 180000, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE_URL}${urlPath}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json().catch(() => ({}))
      : await response.text();
    if (!response.ok) throw new HttpError(
      typeof payload === 'object' && payload?.error ? payload.error : `HTTP ${response.status}`,
      response,
      payload,
    );
    return { status: response.status, requestId: response.headers.get('x-request-id') || null, payload, headers: response.headers };
  } finally {
    clearTimeout(timeout);
  }
}
async function download(urlPath, token, destination) {
  const target = new URL(String(urlPath || ''), `${BASE_URL}/`);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error(`下载地址协议不受支持：${target.protocol}`);
  const authenticated = Boolean(token) && target.origin === BASE_ORIGIN;
  const response = await fetch(target, { headers: authenticated ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}：${target.origin}${target.pathname}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);
  return { path: destination, bytes: bytes.length, contentType: response.headers.get('content-type') || '',
    sourceOrigin: target.origin, authenticated };
}
function tokenFor(user) {
  return signToken({
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    tenant_id: user.tenant_id || 1,
    auth_version: Number(user.auth_version) || 0,
  });
}
async function stage(id, action) {
  if (!EFFECTIVE_STAGES.has(id)) return null;
  const definition = STAGE_CATALOG.find(item => item.id === id);
  if (!definition) throw new Error(`未登记的复测阶段：${id}`);
  const row = { label: definition.label, paid: definition.paid, status: 'running', startedAt: now() };
  result.stages[id] = row;
  await checkpoint();
  progress(`开始：${definition.label}`);
  try {
    row.evidence = sanitize(await action());
    row.status = 'passed';
    progress(`通过：${definition.label}`);
  } catch (error) {
    row.status = 'failed';
    row.error = {
      name: error?.name || 'Error',
      message: sanitizeString(error?.message || error, 1200),
      status: error?.status || null,
      code: error?.payload?.code || error?.code || null,
      requestId: error?.requestId || error?.payload?.requestId || null,
      response: sanitize(error?.payload || null),
      ...(error?.plan !== undefined ? { plan: sanitize(error.plan) } : {}),
      ...(error?.final !== undefined ? { final: sanitize(error.final) } : {}),
      ...(error?.latest !== undefined ? { latest: sanitize(error.latest) } : {}),
      ...(error?.partialEvidence !== undefined ? { partialEvidence: sanitize(error.partialEvidence) } : {}),
    };
    progress(`失败：${definition.label}`, { message: row.error.message, code: row.error.code, requestId: row.error.requestId });
  } finally {
    row.completedAt = now();
    await checkpoint();
  }
  return row;
}
async function poll(label, load, done, { timeoutMs = 20 * 60_000, intervalMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  let lastStatus = '';
  while (Date.now() < deadline) {
    latest = await load();
    const status = JSON.stringify({
      status: latest?.status,
      displayStatus: latest?.displayStatus,
      images: latest?.imageGeneration?.status,
      completed: latest?.imageGeneration?.completedCount,
      failed: latest?.imageGeneration?.failedCount,
    });
    if (status !== lastStatus) {
      progress(`${label}进度`, JSON.parse(status));
      lastStatus = status;
    }
    if (done(latest)) return latest;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw Object.assign(new Error(`${label}在${Math.round(timeoutMs / 60000)}分钟内未结束；没有重复提交`), { code: 'POLL_TIMEOUT', latest });
}

function analyticsUsageSnapshot(payload = {}) {
  const metric = value => ({
    totalCalls: Number(value?.totalCalls || 0),
    successfulCalls: Number(value?.successfulCalls || 0),
    failedCalls: Number(value?.failedCalls || 0),
    runningCalls: Number(value?.runningCalls || 0),
    knownCostCny: Number(value?.knownCostCny || 0),
    unverifiedCostCount: Number(value?.unverifiedCostCount || 0),
  });
  return {
    summary: {
      ...metric(payload.summary),
      successfulConversations: Number(payload.summary?.successfulConversations || 0),
      failedConversations: Number(payload.summary?.failedConversations || 0),
    },
    models: (payload.models || []).map(item => ({ provider: item.provider, model: item.model, ...metric(item) }))
      .sort((a, b) => `${a.provider}:${a.model}`.localeCompare(`${b.provider}:${b.model}`)),
    employees: (payload.employees || []).map(item => ({ employeeId: item.employeeId, ...metric(item) }))
      .sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId))),
  };
}

function leadUsageSnapshot(payload = {}) {
  return {
    usedTurns: Number(payload.lead?.usedTurns || 0),
    remainingTurns: Number(payload.lead?.remainingTurns || 0),
    conversations: (payload.conversations || []).map(conversation => ({
      id: conversation.id,
      requestId: conversation.requestId,
      status: conversation.status,
      usage: conversation.usage,
      supplierCostCny: conversation.supplierCostCny,
      costStatus: conversation.costStatus,
      attempts: (conversation.callAttempts || []).map(attempt => ({
        id: attempt.id,
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        provider: attempt.provider,
        model: attempt.model,
        usage: attempt.usage,
        supplierCostCny: attempt.supplierCostCny,
        costStatus: attempt.costStatus,
      })),
    })).sort((a, b) => Number(a.id) - Number(b.id)),
  };
}

function assertUnchanged(label, before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  throw Object.assign(new Error(`${label}在第三轮被拒绝后发生变化`), {
    code: 'TRIAL_THIRD_TURN_SIDE_EFFECT',
    final: { before, after },
  });
}

await fs.mkdir(IO_DIR, { recursive: true });
await fs.mkdir(SCREENSHOT_DIR, { recursive: true });

const health = await request('/api/health');
const needsBoss = ['employee-133', 'employee-144', 'upload', 'xhs', 'video'].some(id => EFFECTIVE_STAGES.has(id));
const needsSuper = EFFECTIVE_STAGES.has('tester');
const boss = needsBoss ? q.get("SELECT * FROM users WHERE username='guan' AND status='启用'") : null;
const superUser = needsSuper ? q.get("SELECT * FROM users WHERE username='super' AND role='platform_super' AND status='启用'") : null;
if (needsBoss && !boss) throw new Error('复测所需 guan 账号不存在或未启用');
if (needsSuper && !superUser) throw new Error('测试员复测所需 super 账号不存在或未启用');
const testerApiKey = String(process.env.RETEST_TESTER_API_KEY || process.env.AI360_API_KEY || '').trim();
if (needsSuper && !testerApiKey) throw new Error('测试员复测需要 RETEST_TESTER_API_KEY 或 AI360_API_KEY');
const bossToken = boss ? tokenFor(boss) : null;
const superToken = superUser ? tokenFor(superUser) : null;
result.code = {
  ...(await codeIdentity()),
  health: health.payload,
  testedTenantId: boss?.tenant_id || null,
};
await checkpoint();

await stage('tester', async () => {
  const suffix = Date.now().toString(36).slice(-8);
  const username = `retest_${suffix}`;
  const password = `Nw!${crypto.randomBytes(14).toString('base64url')}`;
  const phoneDigits = String(crypto.randomInt(0, 100000000)).padStart(8, '0');
  const phone = `199${phoneDigits}`;
  const input = { username, name: '升级复测测试员', phone, password, consent: true };
  const applied = await request('/api/tester/apply', { method: 'POST', body: input });
  const user = q.get('SELECT * FROM users WHERE username=?', username);
  if (!user) throw new Error('测试员申请成功但账号未落库');
  const approved = await request(`/api/tester/admin/applications/${user.id}`, {
    method: 'PATCH', token: superToken, body: { status: 'approved' },
  });
  const loggedIn = await request('/api/auth/login', { method: 'POST', body: { username, password } });
  const testerToken = loggedIn.payload?.token;
  if (!testerToken || loggedIn.payload?.user?.accountType !== 'tester') throw new Error('测试员真实登录没有返回专用账号会话');
  const selected = await request('/api/tester/provider', { method: 'PUT', token: testerToken, body: { provider: '360' } });
  const keyed = await request('/api/tester/key', {
    method: 'PUT', token: testerToken, body: { provider: '360', apiKey: testerApiKey },
  });
  if (!keyed.payload?.keyConfigured || keyed.payload?.activeProvider !== '360') throw new Error('360个人Key保存后状态未生效');
  const profile = await request('/api/tester/me', { token: testerToken });
  if (profile.payload?.employees?.length !== TESTER_EMPLOYEES.length) {
    throw Object.assign(new Error('测试员工作台没有列出完整数字员工'), {
      code: 'TESTER_EMPLOYEE_CATALOG_INCOMPLETE',
      final: { expected: TESTER_EMPLOYEES.length, actual: profile.payload?.employees?.length },
    });
  }
  const testerRequest = {
    employeeId: 'content-11',
    message: '已确认信息：门店品牌是纳米火锅，招牌菜名称是鲜切牛肉，主题是周末朋友聚餐。请以门店官方口吻写一篇自然的小红书标题、正文、标签和首评，不编造价格、口感或顾客经历。',
    requestId: `tester-own-${suffix}`,
  };
  const chat = await request('/api/tester/chat', { method: 'POST', token: testerToken, body: testerRequest, timeoutMs: 14 * 60_000 });
  if (chat.payload?.status !== 'succeeded' || !String(chat.payload?.output || '').trim()) throw new Error('测试员360个人Key调用未得到可用正文');
  const invitation = await request('/api/tester/invitations', {
    method: 'POST', token: testerToken, body: { title: '升级复测 · 餐饮老板体验', salesPhone: phone },
  });
  const dataUrl = String(invitation.payload?.qrDataUrl || '');
  const qrMatch = dataUrl.match(/^data:image\/png;base64,(.+)$/u);
  if (!qrMatch) throw new Error('体验二维码未生成PNG数据');
  const qrPath = path.join(SCREENSHOT_DIR, '测试员体验二维码.png');
  await fs.writeFile(qrPath, Buffer.from(qrMatch[1], 'base64'));
  const publicLanding = await request(`/api/trial/${encodeURIComponent(invitation.payload.token)}`);
  const publicIds = (publicLanding.payload?.employees || []).map(item => item.id);
  if (publicIds.length !== FEATURED_TRIAL_EMPLOYEE_IDS.length || FEATURED_TRIAL_EMPLOYEE_IDS.some(id => !publicIds.includes(id))) {
    throw Object.assign(new Error('公开体验页没有列出五个满血体验岗'), {
      code: 'TRIAL_EMPLOYEE_CATALOG_INCOMPLETE',
      final: { expected: [...FEATURED_TRIAL_EMPLOYEE_IDS], actual: publicIds },
    });
  }
  const customerPhone = `198${String(crypto.randomInt(0, 100000000)).padStart(8, '0')}`;
  const leadApplied = await request(`/api/trial/${encodeURIComponent(invitation.payload.token)}/apply`, {
    method: 'POST', body: { name: '复测体验客户', phone: customerPhone, storeName: '复测门店', consent: true },
  });
  await request(`/api/tester/leads/${leadApplied.payload.lead.id}`, {
    method: 'PATCH', token: testerToken, body: { status: 'approved' },
  });
  const trialRequest = {
    employeeId: 'restaurant-161',
    message: '今天巡店发现迎宾交接漏项、冷藏标签不清。请按巡店督导整理评分、问题清单和整改安排。',
    requestId: `trial-customer-${suffix}`,
  };
  const trialChat = await request(`/api/trial/${encodeURIComponent(invitation.payload.token)}/chat`, {
    method: 'POST', headers: { 'X-Trial-Token': leadApplied.payload.accessToken }, body: trialRequest, timeoutMs: 14 * 60_000,
  });
  if (trialChat.payload?.lead?.usedTurns !== 1 || trialChat.payload?.conversation?.status !== 'succeeded') {
    throw Object.assign(new Error('客户第一轮没有成功计为1次'), { code: 'TRIAL_FIRST_TURN_INVALID', final: trialChat.payload });
  }
  const secondTrialRequest = {
    employeeId: 'restaurant-161',
    message: '请再补充3条班前会必须确认的前厅检查重点，只写简短清单。',
    requestId: `trial-customer-2-${suffix}`,
  };
  const secondTrialChat = await request(`/api/trial/${encodeURIComponent(invitation.payload.token)}/chat`, {
    method: 'POST', headers: { 'X-Trial-Token': leadApplied.payload.accessToken }, body: secondTrialRequest, timeoutMs: 14 * 60_000,
  });
  if (secondTrialChat.payload?.lead?.usedTurns !== 2 || secondTrialChat.payload?.conversation?.status !== 'succeeded') {
    throw Object.assign(new Error('客户第二轮没有成功计为2次'), { code: 'TRIAL_SECOND_TURN_INVALID', final: secondTrialChat.payload });
  }
  const analyticsBeforeThirdResponse = await request('/api/tester/analytics?days=all&scope=customers', { token: testerToken });
  const leadBeforeThirdResponse = await request(`/api/tester/leads/${leadApplied.payload.lead.id}`, { token: testerToken });
  const analyticsBeforeThird = analyticsUsageSnapshot(analyticsBeforeThirdResponse.payload);
  const leadBeforeThird = leadUsageSnapshot(leadBeforeThirdResponse.payload);
  const thirdTrialRequest = {
    employeeId: 'restaurant-161',
    message: '这是第三轮测试：请继续补充清单。',
    requestId: `trial-customer-3-${suffix}`,
  };
  let thirdTurnRejection = null;
  try {
    await request(`/api/trial/${encodeURIComponent(invitation.payload.token)}/chat`, {
      method: 'POST', headers: { 'X-Trial-Token': leadApplied.payload.accessToken }, body: thirdTrialRequest, timeoutMs: 180000,
    });
    throw Object.assign(new Error('客户第三轮未被两轮限制拒绝'), { code: 'TRIAL_THIRD_TURN_ACCEPTED' });
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409 || error.payload?.code !== 'TRIAL_TURNS_EXHAUSTED') throw error;
    thirdTurnRejection = { status: error.status, code: error.payload.code, message: sanitizeString(error.message, 300) };
  }
  const analyticsAfterThirdResponse = await request('/api/tester/analytics?days=all&scope=customers', { token: testerToken });
  const leadAfterThirdResponse = await request(`/api/tester/leads/${leadApplied.payload.lead.id}`, { token: testerToken });
  const analyticsAfterThird = analyticsUsageSnapshot(analyticsAfterThirdResponse.payload);
  const leadAfterThird = leadUsageSnapshot(leadAfterThirdResponse.payload);
  assertUnchanged('客户看板调用与费用指标', analyticsBeforeThird, analyticsAfterThird);
  assertUnchanged('客户对话和上游用量', leadBeforeThird, leadAfterThird);
  const credentialPath = path.join(OUT_DIR, '真实复测测试员账号.txt');
  await fs.writeFile(credentialPath, [
    '仅用于本次验收，请勿对外发送。',
    `登录地址：${BASE_URL}/login`,
    `账号：${username}`,
    `密码：${password}`,
    `手机号：${phone}`,
    '360 API Key：已加密保存在服务端，本文件不保存明文。',
    '',
  ].join('\n'), { mode: 0o600 });
  await fs.chmod(credentialPath, 0o600);
  return {
    application: applied.payload,
    approved: approved.payload?.tester,
    login: { accountType: loggedIn.payload?.user?.accountType, redirect: '/tester', username },
    provider: { selected: selected.payload?.activeProvider, keyConfigured: keyed.payload?.keyConfigured, keyMasked: keyed.payload?.keyMasked },
    employeeCount: profile.payload?.employees?.length,
    personalKeyCall: { request: testerRequest, response: chat.payload },
    invitation: { id: invitation.payload?.id, title: invitation.payload?.title, provider: invitation.payload?.provider,
      url: invitation.payload?.url, qrPath, keyConfiguredOnLanding: publicLanding.payload?.keyConfigured,
      landingEmployeeCount: publicLanding.payload?.employees?.length },
    customerTrial: {
      first: { request: trialRequest, lead: trialChat.payload?.lead, conversation: trialChat.payload?.conversation },
      second: { request: secondTrialRequest, lead: secondTrialChat.payload?.lead, conversation: secondTrialChat.payload?.conversation },
      third: { request: thirdTrialRequest, rejection: thirdTurnRejection },
      noThirdTurnSideEffect: true,
      usageBeforeThird: { analytics: analyticsBeforeThird, lead: leadBeforeThird },
      usageAfterThird: { analytics: analyticsAfterThird, lead: leadAfterThird },
    },
    analytics: analyticsAfterThirdResponse.payload,
    credentialPath,
  };
});

async function runRestaurantEmployee(idx, prompt) {
  const profileResult = await request(`/api/employee-workbench/restaurant/${idx}`, { token: bossToken });
  const profile = profileResult.payload;
  const body = {
    title: `[升级真实复测] ${profile.identity.name}`,
    type: profile.dispatch?.defaultTaskType || '执行方案',
    question: prompt.question,
    materials: prompt.materials,
    dueAt: '2026-09-10T18:00:00',
  };
  const dispatched = await request(`/api/employee-workbench/restaurant/${idx}/dispatch`, {
    method: 'POST', token: bossToken, body, timeoutMs: 180000,
  });
  const taskId = Number(dispatched.payload?.taskId);
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw new Error(`员工#${idx}派活未返回taskId`);
  const final = await poll(`员工#${idx}`, async () => (await request(`/api/marshals/tasks/${taskId}/status`, { token: bossToken })).payload,
    payload => payload?.status !== '生成中', { timeoutMs: 35 * 60_000, intervalMs: 8000 });
  if (!String(final?.output_body || '').trim()) throw Object.assign(new Error(`员工#${idx}终态${final?.status}但没有正文`), { code: 'EMPLOYEE_NO_OUTPUT', final });
  const ioPath = path.join(IO_DIR, `数字员工-${idx}-${profile.identity.name}.md`);
  await fs.writeFile(ioPath, [
    `# ${profile.identity.name}真实复测`, '', '## 输入', '', body.question, '', '### 已确认材料', '', body.materials,
    '', '## 输出', '', final.output_body, '', '## 状态与计费', '', '```json',
    JSON.stringify(sanitize({ taskId, status: final.status, displayStatus: final.displayStatus, reviewReady: final.reviewReady,
      billing: final.billing, model: final.ai_mode, outputId: final.output_id }), null, 2), '```', '',
  ].join('\n'));
  return { employee: profile.identity, request: body, dispatch: dispatched.payload, final: sanitize(final), ioPath };
}

await stage('employee-133', () => runRestaurantEmployee(133, {
  question: '请为纳米火锅门店形成一份可直接用于班前会和现场检查的前厅服务SOP，覆盖迎客、等位、点单确认、上菜、巡台、结账、客诉补救和闭店交接。',
  materials: '已确认事实：门店16桌、64座；高峰时段11:30—13:00；无障碍桌位编号QA-TABLE-03；退款需负责人审批后原路退回；仅形成内部培训和检查稿，不执行退款或发布。',
}));

await stage('employee-144', () => runRestaurantEmployee(144, {
  question: '请为纳米火锅门店形成一份合规的会员CRM与生命周期运营方案，包含分层、触达节奏、退订、数据权限、指标和复盘动作。',
  materials: '已确认事实：CRM版本QA-CRM-144-01；营销必须取得同意；退订渠道为QA退订入口；数据保存期限12个月；去标识化规则QA-HASH-144-01；只使用脱敏测试资料，不发送消息、不改系统。',
}));

let uploadedFileId = null;
await stage('upload', async () => {
  const sourcePath = path.resolve(process.env.RETEST_IMAGE_PATH
    || path.join(PROJECT_ROOT, 'artifacts/chengdu-0909/revision-assets/03-sichuan-food.png'));
  const sourceExtension = path.extname(sourcePath).toLowerCase();
  const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' })[sourceExtension];
  if (!mime) throw Object.assign(new Error('复测图片只支持 PNG、JPG 或 WebP'), { code: 'RETEST_IMAGE_TYPE_UNSUPPORTED' });
  const bytes = await fs.readFile(sourcePath);
  const uploaded = await request('/api/files/upload', {
    method: 'POST', token: bossToken,
    body: { name: `纳米火锅升级复测菜品图${sourceExtension}`, mime, purpose: 'upgrade-real-retest', recognize: false, b64: bytes.toString('base64') },
  });
  uploadedFileId = Number(uploaded.payload?.file?.id);
  if (!Number.isSafeInteger(uploadedFileId) || uploadedFileId < 1) throw new Error('图片上传未返回fileId');
  const copyPath = path.join(IO_DIR, `共同输入-菜品参考图${sourceExtension}`);
  await fs.copyFile(sourcePath, copyPath);
  return { sourcePath, copyPath, file: uploaded.payload.file, billing: uploaded.payload.billing };
});

await stage('xhs', async () => {
  if (!uploadedFileId) throw new Error('缺少当前账号上传的菜品图片');
  const options = await request('/api/content/ai-xhs-note/options?imageCount=6', { token: bossToken });
  if (!options.payload?.available) throw new Error(options.payload?.reason || '小红书配图通道不可用');
  const created = await request('/api/content/native-chat/sessions', { method: 'POST', token: bossToken, body: { employeeIdx: 11 } });
  const sessionId = created.payload?.session?.id;
  const requestBody = {
    message: '已确认事实：品牌名是纳米火锅，招牌菜名称是鲜切牛肉；本次主题是周末朋友聚餐。请用门店官方口吻做一套6图小红书种草内容：自然标题、短段正文、标签、首评和逐图方案。不得编造价格、口感、食材来源或顾客经历。信息已经齐全，请给出可确认生成的完整方案。',
    fileIds: [uploadedFileId],
    options: { imageCount: 6, style: 'seed', coverLayout: 'collage4', includeDiner: false },
    requestKey: `xhs-msg-${crypto.randomUUID()}`,
  };
  const drafted = await request(`/api/content/native-chat/sessions/${sessionId}/messages`, {
    method: 'POST', token: bossToken, body: requestBody, timeoutMs: 360000,
  });
  const plan = drafted.payload?.session?.currentPlan;
  if (!plan?.ready) throw Object.assign(new Error('小红书对话已返回，但方案未达到可确认状态'), { code: 'XHS_PLAN_NOT_READY', plan });
  const confirmed = await request(`/api/content/native-chat/sessions/${sessionId}/confirm`, {
    method: 'POST', token: bossToken,
    body: { planVersion: plan.version, requestKey: `xhs-confirm-${crypto.randomUUID()}` }, timeoutMs: 360000,
  });
  const jobId = Number(confirmed.payload?.generation?.jobId);
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new Error('小红书确认后未返回jobId');
  const final = await poll('小红书6图', async () => (await request(`/api/content/ai-xhs-note/jobs/${jobId}`, { token: bossToken })).payload,
    payload => ['success', 'partial', 'failed'].includes(payload?.imageGeneration?.status)
      && payload?.status !== 'running', { timeoutMs: 28 * 60_000, intervalMs: 10000 });
  const xhsDir = path.join(IO_DIR, `小红书种草-${jobId}`);
  await fs.mkdir(xhsDir, { recursive: true });
  const downloadedImages = [];
  for (const [index, item] of (final.imageGeneration?.items || []).entries()) {
    if (!item.url) continue;
    const ext = /\.jpe?g(?:\?|$)/iu.test(item.url) ? 'jpg' : 'png';
    try {
      downloadedImages.push({ index: index + 1, role: item.role || 'image',
        ...(await download(item.url, bossToken, path.join(xhsDir, `${String(index + 1).padStart(2, '0')}-${item.role || 'image'}.${ext}`))) });
    } catch (error) {
      downloadedImages.push({ index: index + 1, role: item.role || 'image', error: sanitizeString(error.message, 500) });
    }
  }
  let bundle = null;
  if (final.downloadUrl) {
    try {
      bundle = await download(final.downloadUrl, bossToken, path.join(xhsDir, final.downloadName || '小红书图文包.zip'));
    } catch (error) {
      bundle = { error: sanitizeString(error.message, 500) };
    }
  } else {
    bundle = { error: '任务未返回一键打包下载地址' };
  }
  const contentPath = path.join(xhsDir, '输入与正文.md');
  await fs.writeFile(contentPath, [
    '# AI小红书种草员真实复测', '', '## 输入', '', requestBody.message, '', '## 输出', '',
    `# ${final.output?.title || ''}`, '', final.output?.body || '', '',
    `标签：${(final.output?.tags || []).map(tag => `#${tag}`).join(' ')}`, '',
    `首评：${final.output?.firstComment || ''}`, '', '## 配图结果', '',
    `状态：${final.imageGeneration?.status}；成功 ${final.imageGeneration?.completedCount || 0}/${final.imageGeneration?.imageCount || 6}；失败 ${final.imageGeneration?.failedCount || 0}`, '',
  ].join('\n'));
  const expectedImageCount = 6;
  const completedImageCount = Number(final.imageGeneration?.completedCount || 0);
  const downloadedImageCount = downloadedImages.filter(item => !item.error && Number(item.bytes) > 0).length;
  const partialEvidence = { xhsDir, contentPath, downloadedImages, bundle,
    expectedImageCount, completedImageCount, downloadedImageCount };
  if (!final.output?.body) throw Object.assign(new Error('小红书任务终态没有正文'), { code: 'XHS_NO_BODY', final, partialEvidence });
  if (completedImageCount !== expectedImageCount || downloadedImageCount !== expectedImageCount) {
    throw Object.assign(new Error(`小红书6图未完整交付：上游成功${completedImageCount}张，本地可预览${downloadedImageCount}张`), {
      code: 'XHS_IMAGE_SET_INCOMPLETE', final, partialEvidence,
    });
  }
  if (bundle?.error || !Number(bundle?.bytes)) {
    throw Object.assign(new Error('小红书6图已完成，但一键打包下载未通过'), {
      code: 'XHS_BUNDLE_UNAVAILABLE', final, partialEvidence,
    });
  }
  return { options: options.payload, sessionId, request: requestBody, draft: drafted.payload.session,
    generation: confirmed.payload.generation, final, downloadedImages, bundle, contentPath };
});

await stage('video', async () => {
  if (!uploadedFileId) throw new Error('缺少当前账号上传的菜品图片');
  const options = await request('/api/content/ai-sales-video/options?durationSeconds=15', { token: bossToken, timeoutMs: 180000 });
  const created = await request('/api/content/native-chat/sessions', { method: 'POST', token: bossToken, body: { employeeIdx: 10 } });
  const sessionId = created.payload?.session?.id;
  const requestBody = {
    message: process.env.RETEST_VIDEO_BRIEF || '已确认事实：品牌名是纳米火锅，招牌菜名称是鲜切牛肉；本次主题是邀请附近顾客周末到店聚餐。请写15秒中文自然口播、镜头和顺滑转场，声音由Wan视频模型原生生成，不外接配音；不得编造价格、口感、优惠或顾客经历。信息已经齐全，请给出可确认生成的完整方案。',
    fileIds: [uploadedFileId],
    options: { durationSeconds: 15 },
    requestKey: `sales-msg-${crypto.randomUUID()}`,
  };
  const drafted = await request(`/api/content/native-chat/sessions/${sessionId}/messages`, {
    method: 'POST', token: bossToken, body: requestBody, timeoutMs: 360000,
  });
  const plan = drafted.payload?.session?.currentPlan;
  if (!plan?.ready) throw Object.assign(new Error('带货视频对话已返回，但脚本未达到可确认状态'), { code: 'VIDEO_PLAN_NOT_READY', plan });
  const confirmed = await request(`/api/content/native-chat/sessions/${sessionId}/confirm`, {
    method: 'POST', token: bossToken,
    body: { planVersion: plan.version, requestKey: `sales-confirm-${crypto.randomUUID()}` }, timeoutMs: 360000,
  });
  const jobId = Number(confirmed.payload?.generation?.jobId);
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new Error('视频确认后未返回jobId');
  const final = await poll('15秒带货视频', async () => (await request(`/api/content/media-jobs/${jobId}`, { token: bossToken })).payload,
    payload => ['成功', '失败'].includes(payload?.status), { timeoutMs: 28 * 60_000, intervalMs: 10000 });
  const videoDir = path.join(IO_DIR, `AI带货视频-${jobId}`);
  await fs.mkdir(videoDir, { recursive: true });
  const detailsPath = path.join(videoDir, '输入与脚本.md');
  await fs.writeFile(detailsPath, [
    '# AI视频带货官真实复测', '', '## 输入', '', requestBody.message, '', '## 已确认脚本', '',
    '```json', JSON.stringify(sanitize(plan.script), null, 2), '```', '', '## 生成结果', '',
    '```json', JSON.stringify(sanitize({ jobId, status: final.status, model: final.model,
      previewUrl: final.previewUrl, url: final.url, downloadUrl: final.downloadUrl,
      error: final.error, billing: final.billing, snapshot: final.snapshot }), null, 2), '```', '',
  ].join('\n'));
  const videoUrl = final.previewUrl || final.url;
  let video = null;
  if (videoUrl) {
    const ext = /\.mov(?:\?|$)/iu.test(videoUrl) ? 'mov' : 'mp4';
    try {
      video = await download(videoUrl, bossToken, path.join(videoDir, `带货视频-${jobId}.${ext}`));
    } catch (error) {
      video = { error: sanitizeString(error.message, 500) };
    }
  }
  let bundle = null;
  if (final.status === '成功' && final.downloadUrl) {
    try {
      bundle = await download(final.downloadUrl, bossToken, path.join(videoDir, `AI带货视频交付包-${jobId}.zip`));
    } catch (error) {
      bundle = { error: sanitizeString(error.message, 500) };
    }
  } else if (final.status === '成功') {
    bundle = { error: '视频任务未返回一键打包下载地址' };
  }
  const partialEvidence = { videoDir, detailsPath, videoUrl, video, bundle };
  if (final.status !== '成功' || !videoUrl) throw Object.assign(new Error(final.error || '带货视频没有可下载成片'), {
    code: 'VIDEO_GENERATION_FAILED', final, partialEvidence,
  });
  if (video?.error || !Number(video?.bytes)) throw Object.assign(new Error('带货视频成片无法预览下载'), {
    code: 'VIDEO_DOWNLOAD_FAILED', final, partialEvidence,
  });
  if (bundle?.error || !Number(bundle?.bytes)) throw Object.assign(new Error('带货视频一键交付包无法下载'), {
    code: 'VIDEO_BUNDLE_UNAVAILABLE', final, partialEvidence,
  });
  return { options: options.payload, sessionId, request: requestBody, draft: drafted.payload.session,
    generation: confirmed.payload.generation, final, video, bundle, detailsPath };
});

result.completedAt = now();
result.summary = {
  total: Object.keys(result.stages).length,
  passed: Object.values(result.stages).filter(item => item.status === 'passed').length,
  failed: Object.values(result.stages).filter(item => item.status === 'failed').length,
};
await checkpoint();
progress('真实复测结束', { out: OUT_DIR, ...result.summary });
process.stdout.write(`${OUT_DIR}\n`);
if (result.summary.failed > 0) process.exitCode = 1;

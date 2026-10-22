#!/usr/bin/env node
/**
 * 本任务工具 v2：正式 API 发码、注册、幂等直充、逐户登录/余额/席位/期限验收。
 * 方式 A：环境变量超管凭据；方式 B：0600 邀请码 JSON 导入，注册后按选定的超管方式直充再验证。
 * --initial-credits 必填；线上须提供老板确认、积分数字和已验证备份名的 approval-file。
 * --dry-run 只发健康 GET 和只读 SQLite SELECT，不创建状态/密码，不登录。
 * 所有失败立即停止、不自动重试；不确定发码/入账需回执核对，不补建已有企业。
 * 默认 5 席、10 模块、无套餐期限。不改业务代码、配置，不重置密码、不直接写线上库。
 * 状态及账号文件 0600；凭据不输出。使用 Codex 捆绑 artifact-tool 导出 XLSX。
 * 持续复用同一批次目录；接口无企业名唯一约束，不能保证外部并发下全局幂等。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

process.umask(0o077);
const MODULES = ['dashboard','advisor','marshals','growth','activities','content','execution','analysis','assets','system'];
let stage = '参数校验', ordinal = 0, state, lock, lockOwned = false, superToken, superId, artifact;
class SafeError extends Error {}
const fail = message => { throw new SafeError(message); };
const options = { count: 50, 'name-prefix': '纳米Work企业', 'username-prefix': 'nmwork', 'dry-run': false, verify: false, 'auth-mode': 'password' };
let base, local, output, stateFile;

function parse() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('必填：--base-url <源站> --out-dir <私密目录> --initial-credits <每家积分>。可选：--count 50 --verify --dry-run。方式 A：--auth-mode password，超管凭据仅由环境变量提供。方式 B：--auth-mode invitations --invite-file <0600 JSON文件> --register-only，按老板选定方式加积分后 --verify-only。邀请码文件：独立码用 JSON 数组（username、code）；共享码用 {type:new_tenant,maxUses:批次数量,code:完整码}。非回环执行必须 --approval-file <老板确认及已验证备份的JSON记录>。任何失败立即停止，不自动重试。');
    process.exit(0);
  }
  for (let i = 0; i < args.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(args[i]);
    if (!match) fail('参数格式错误');
    const [, key, inline] = match;
    if (['dry-run','verify','register-only','verify-only','precheck-login'].includes(key)) {
      if (inline !== undefined) fail('开关参数不能带值');
      options[key] = true;
    } else if (['base-url','count','name-prefix','username-prefix','out-dir','initial-credits','auth-mode','invite-file','approval-file'].includes(key)) {
      options[key] = inline ?? args[++i];
      if (!options[key] || String(options[key]).startsWith('--')) fail('参数缺少值');
    } else fail('未知参数（为避免泄密，不回显原始参数）');
  }
  if (!options['base-url'] || !options['out-dir']) fail('必须指定 --base-url 和 --out-dir');
  try { base = new URL(options['base-url']); } catch { fail('站点 URL 无效'); }
  local = ['localhost','127.0.0.1','[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') fail('站点 URL 只接受无凭据的源地址');
  if (base.protocol !== 'https:' && !(local && base.protocol === 'http:')) fail('非回环站点必须使用 HTTPS');
  base = base.origin;
  options.count = Number(options.count);
  options['initial-credits'] = Number(options['initial-credits']);
  if (!Number.isSafeInteger(options['initial-credits']) || options['initial-credits'] < 1 || options['initial-credits'] > 1_000_000_000) fail('必须明确指定有效的每家初始积分');
  if (!['password','invitations'].includes(options['auth-mode'])) fail('auth-mode 必须为 password 或 invitations');
  if (options['register-only'] && (options['verify-only'] || options.verify)) fail('register-only 不可与验证开关合用');
  if (options['auth-mode'] === 'invitations' && !options['register-only'] && !options['verify-only'] && !options['precheck-login'] && !options['dry-run']) fail('方式 B 必须先 register-only，按老板选定方式加积分后 verify-only');
  if (options['precheck-login']) { options['verify-only'] = true; }
  if (options['verify-only']) options.verify = true;
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 50) fail('count 必须为 1 至 50');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,110}$/u.test(options['name-prefix'])) fail('企业前缀格式无效');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,35}$/.test(options['username-prefix'])) fail('账号前缀格式无效');
  output = path.resolve(options['out-dir']);
  stateFile = path.join(output, '开通状态.json');
  if (!local && !options['dry-run']) {
    const approval = privateJson(options['approval-file'], '缺少老板确认和备份验收记录');
    if (approval.approvedBy !== '王磊' || approval.confirmed !== true || approval.base !== base || approval.count !== options.count ||
        approval.initialCredits !== options['initial-credits'] || approval.authMode !== options['auth-mode'] || approval.backupVerified !== true ||
        !/^\d{14}-pre-provision-50$/.test(approval.backupName || '')) fail('老板确认记录或开通前备份验收不完整，禁止线上操作');
  }
}

function privateJson(file, message) {
  if (!file) fail(message);
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600) fail('敏感输入文件必须是权限 0600 的普通文件');
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { if (e instanceof SafeError) throw e; fail(message); }
}

function importInvitations() {
  if (!options['invite-file']) return;
  const input = privateJson(options['invite-file'], '邀请码输入文件无效');
  const shared = !Array.isArray(input) && input?.type === 'new_tenant' && input?.maxUses === options.count;
  if (!Array.isArray(input) && !shared) fail('共享邀请码必须明确为 new_tenant，且 maxUses 等于本批次数量');
  const rows = shared ? state.items.map(item => ({username:item.username,code:input.code})) : input;
  if (!Array.isArray(rows) || rows.length !== state.items.length) fail('邀请码行数与本批次不一致');
  const usernames = new Set(), codes = new Set();
  for (const row of rows) {
    const item = state.items.find(x => x.username === row.username);
    if (!item || usernames.has(row.username) || typeof row.code !== 'string' || !/^NW-[A-Za-z0-9_-]{32}$/.test(row.code) || (!shared && codes.has(row.code))) fail('邀请码映射、格式或唯一性无效');
    if (item.inviteCode && item.inviteCode !== row.code) fail('邀请码与已有状态不一致，禁止覆盖');
    usernames.add(row.username); codes.add(row.code);
  }
  if (state.sharedInviteMaxUses && (!shared || state.sharedInviteMaxUses !== input.maxUses)) fail('共享邀请码模式与已有状态不一致');
  if (shared) state.sharedInviteMaxUses = input.maxUses;
  for (const row of rows) {
    const item = state.items.find(x => x.username === row.username);
    if (!item.inviteCode) { item.inviteCode = row.code; item.phase = 'invited'; }
  }
  if (!options['dry-run']) save();
}

function validateInvitation(item, inventory, needed = 1) {
  if (!item.inviteCode) fail('缺少导入的邀请码');
  const hash = crypto.createHash('sha256').update(item.inviteCode).digest('hex');
  const rows = inventory.invitations.filter(x => x.hash === hash);
  if (rows.length !== 1) fail('邀请码在目标库不存在或不唯一');
  const invite = rows[0];
  if (invite.type !== 'new_tenant' || invite.tenantId !== null || invite.role !== 'boss' || invite.creatorScope !== 'platform' ||
      invite.issuerRole !== 'platform_super' || invite.issuerStatus !== '启用' || invite.revokedAt || !(Date.parse(invite.expiresAt) > Date.now()) ||
      invite.maxUses !== (state.sharedInviteMaxUses || 1) || invite.maxUses-invite.usedCount < needed) fail('邀请码用途、发行权限、次数或有效期不符；禁止误加入已有企业');
}

function atomic(name, bytes) {
  const target = path.join(output, name);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) fail('输出文件不能是符号链接');
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, target);
  const dir = fs.openSync(output, 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function save() { atomic('开通状态.json', JSON.stringify(state, null, 2) + '\n'); }
function password(used) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ','abcdefghijkmnpqrstuvwxyz','23456789','!#%*'];
  const pick = set => set[crypto.randomInt(set.length)];
  for (;;) {
    const chars = sets.map(pick);
    while (chars.length < 14) chars.push(pick(sets.join('')));
    for (let i = 13; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i],chars[j]] = [chars[j],chars[i]]; }
    const value = chars.join('');
    if (/^[A-Za-z]/.test(value) && !used.has(value)) return value;
  }
}
function acquireLock() {
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(output).isSymbolicLink()) fail('输出目录不能是符号链接');
  fs.chmodSync(output, 0o700);
  lock = path.join(output, '.batch.lock');
  try {
    const fd = fs.openSync(lock, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname() })); fs.closeSync(fd);
    lockOwned = true;
  } catch {
    // 不自动删除锁：跨主机共享盘、PID 复用或人工操作均可能造成错误接管。
    fail('批次已锁定；确认旧进程已结束后才能人工删除 out-dir/.batch.lock 再续跑');
  }
}
function load() {
  const config = { base, count: options.count, namePrefix: options['name-prefix'], usernamePrefix: options['username-prefix'], initialCredits: options['initial-credits'], authMode: options['auth-mode'] };
  if (fs.existsSync(stateFile)) {
    if (fs.lstatSync(stateFile).isSymbolicLink() || (fs.statSync(stateFile).mode & 0o077)) fail('状态文件必须为普通文件且权限 0600');
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { fail('状态文件损坏，禁止重新创建批次'); }
    if (state.version !== 2 || JSON.stringify(state.config) !== JSON.stringify(config)) fail('版本或参数与已有批次不同，禁止复用此目录');
    if (!Array.isArray(state.items) || state.items.length !== options.count) fail('状态文件条数不完整');
    const seen = new Set();
    for (let i = 0; i < state.items.length; i++) {
      const item = state.items[i], suffix = String(i + 1).padStart(2, '0');
      if (item.index !== i + 1 || item.company !== config.namePrefix + suffix || item.username !== config.usernamePrefix + suffix ||
          typeof item.password !== 'string' || !/^[A-Za-z][A-Za-z2-9!#%*]{13}$/.test(item.password) || /[0Oo1lI]/.test(item.password) ||
          ![/[A-Z]/,/[a-z]/,/[2-9]/,/[!#%*]/].every(re => re.test(item.password)) || seen.has(item.password)) fail('状态清单校验失败');
      seen.add(item.password);
    }
  } else {
    if (fs.existsSync(output) && fs.readdirSync(output).some(x => /账号列表|验证结果/.test(x))) fail('发现旧交付物但无状态文件，禁止重新开通');
    if (options['verify-only']) fail('仅验证模式要求已有批次状态');
    state = { version: 2, config, createdAt: new Date().toISOString(), items: [] };
    for (let i = 1; i <= options.count; i++) {
      const suffix = String(i).padStart(2, '0');
      const item = { index: i, company: config.namePrefix + suffix, username: config.usernamePrefix + suffix, phase: 'planned', verification: '未验证' };
      if (!options['dry-run']) item.password = password(new Set(state.items.map(x => x.password)));
      state.items.push(item);
    }
    if (!options['dry-run']) save();
  }
}

async function request(method, endpoint, body, token) {
  if (options['dry-run'] && method !== 'GET') fail('dry-run 禁止写请求');
  let response;
  try {
    response = await fetch(base + endpoint, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { fail('网络请求失败或响应不确定；状态已保留，重跑前将查重'); }
  if (response.status === 429) {
    fail('HTTP 429 限流；已停止且不会自动重试，须核对状态后再续跑');
  }
  if (!response.ok) fail(`HTTP ${response.status}，停止；不回显可能含敏感内容的服务端响应`);
  try { return { data: await response.json() }; } catch { fail('响应不是 JSON'); }
}
async function call(method, endpoint, body, token) {
  return (await request(method, endpoint, body, token)).data;
}

// 无密码哈希、无密钥、无会话；只返回本批次相关的企业和账号最小字段。
function readOnlyInventory() {
  const prod = new URL(base).hostname === 'xn--work-9r3ko5i.cn';
  const database = process.env.NANOWORK_READONLY_DB || (prod ? '/var/lib/nanowork/data/nanowork-industry.db' : '');
  const host = process.env.NANOWORK_READONLY_SSH_HOST || (prod ? 'root@8.210.177.200' : '');
  if (!database || (!local && !host)) fail('没有只读查重连接；需配置 NANOWORK_READONLY_DB 与远端 SSH 身份');
  const payload = Buffer.from(JSON.stringify({ database, names: state.items.map(x => x.company), users: state.items.map(x => x.username.toLowerCase()), keys: state.items.map(x => x.creditRequestKey).filter(Boolean), invitationHashes: [...new Set(state.items.filter(x => x.inviteCode).map(x => crypto.createHash('sha256').update(x.inviteCode).digest('hex')))] })).toString('base64');
  const program = `import sqlite3,json,base64,sys\nfrom urllib.parse import quote\np=json.loads(base64.b64decode(sys.argv[1]))\nc=sqlite3.connect('file:'+quote(p['database'],safe='/')+'?mode=ro',uri=True)\nc.execute('PRAGMA query_only=ON')\nc.execute('BEGIN')\nusers=[dict(zip(['id','username','tenantId','role','status'],r)) for r in c.execute('SELECT id,username,tenant_id,role,status FROM users') if r[1].lower() in p['users']]\nnames=set(p['names']); ids={u['tenantId'] for u in users}\ntenants=[dict(zip(['id','name','status','primaryUserId','createdAt','credits','totalRecharged','seatLimit','expiresAt'],r)) for r in c.execute('SELECT id,name,status,primary_user_id,created_at,credits,total_recharged,seat_limit,plan_expires_at FROM tenants') if r[1] in names or r[0] in ids]\nreceipts=[]\nif c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_financial_requests'").fetchone():\n receipts=[dict(zip(['actorId','requestKey','operation','tenantId','fingerprint','response'],r)) for r in c.execute('SELECT actor_id,request_key,operation,tenant_id,fingerprint,response_json FROM platform_financial_requests') if r[1] in p['keys']]\ninvitations=[dict(zip(['hash','type','tenantId','role','creatorScope','maxUses','usedCount','expiresAt','revokedAt','issuerRole','issuerStatus'],r)) for r in c.execute('SELECT i.code_hash,i.type,i.tenant_id,i.role,i.creator_scope,i.max_uses,i.used_count,i.expires_at,i.revoked_at,u.role,u.status FROM invitations i LEFT JOIN users u ON u.id=i.created_by') if r[0] in p['invitationHashes']]\nprint(json.dumps({'users':users,'tenants':tenants,'receipts':receipts,'invitations':invitations},ensure_ascii=False))\nc.close()\n`;
  let raw;
  try {
    if (local) raw = execFileSync('python3', ['-c', program, payload], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore','pipe','pipe'] });
    else {
      const key = process.env.NANOWORK_READONLY_SSH_KEY || path.join(os.homedir(), '.ssh/namiwork-hk-20260906');
      if (!/^[A-Za-z0-9_.@:-]+$/.test(host) || host.startsWith('-')) fail('SSH 主机格式无效');
      const control = process.env.NANOWORK_READONLY_SSH_CONTROL;
      if (control && !/^\/private\/tmp\/nmwork50-[A-Za-z0-9_-]+\/ssh$/.test(control)) fail('SSH复用路径不属于本任务');
      raw = execFileSync('ssh', [...(control ? ['-S',control] : []),'-i',key,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15',host,`python3 - ${payload}`], { input: program, encoding: 'utf8', timeout: 45_000, stdio: ['pipe','pipe','pipe'] });
    }
    const data = JSON.parse(raw);
    if (!Array.isArray(data.users) || !Array.isArray(data.tenants)) fail('查重响应格式错误');
    return data;
  } catch (error) {
    if (error?.code === 'ETIMEDOUT' || error?.signal === 'SIGTERM') fail('只读数据库查重超时，已停止且不自动重试');
    if (error?.status === 255) fail('SSH只读连接中断或握手失败，已停止且不自动重试');
    fail('只读数据库查重失败，未回显连接或数据库错误内容');
  }
}
function match(item, inventory) {
  const users = inventory.users.filter(u => u.username.toLowerCase() === item.username.toLowerCase());
  const tenants = inventory.tenants.filter(t => t.name === item.company);
  if (!users.length && !tenants.length) {
    if (item.tenantId) fail('已记录企业在目标站点不存在，禁止补建');
    return null;
  }
  if (users.length !== 1 || tenants.length !== 1 || users[0].username !== item.username || users[0].tenantId !== tenants[0].id ||
      users[0].role !== 'boss' || users[0].status !== '启用' || tenants[0].status !== '已开通' || tenants[0].primaryUserId !== users[0].id ||
      (item.tenantId && item.tenantId !== tenants[0].id)) fail('账号/企业名冲突或归属不一致，停止且不重置密码');
  if (!item.tenantId && item.phase !== 'registering') fail('发现非本批次已确认的同名账号/企业，停止');
  return tenants[0];
}
async function inspect(item, tenantId, verifyCredits = true) {
  let token;
  try {
    const login = await call('POST','/api/auth/login',{ username: item.username, password: item.password });
    token = login.token;
    if (!token) fail('登录响应缺少会话');
    const me = await call('GET','/api/auth/me',null,token);
    if (me.username !== item.username || me.role !== 'boss' || me.accountType !== 'primary' ||
        me.tenant?.name !== item.company || Number(me.tenant_id) !== tenantId || Number(me.tenant?.id) !== tenantId ||
        me.tenant?.status !== '已开通' || !Array.isArray(me.modules) || me.modules.length !== MODULES.length || MODULES.some(m => !me.modules.includes(m))) fail('身份、企业、主账号、状态或模块核验失败');
    const balance = await call('GET','/api/recharge/balance',null,token);
    if (balance.tenantName !== item.company || balance.seatSummary?.seatLimit !== 5 || balance.seatSummary?.seatsUsed !== 1 ||
        balance.seatSummary?.subSeatLimit !== 4 || balance.plan?.expiresAt !== null || me.tenant?.planSummary?.expiresAt !== null) fail('席位或无期限权益核验失败');
    if (verifyCredits && (me.credits !== options['initial-credits'] || balance.credits !== options['initial-credits'] ||
        balance.totalRecharged !== options['initial-credits'] || balance.totalSpent !== 0 ||
        !Array.isArray(balance.logs) || balance.logs.filter(x => x.feature === '平台直充' && x.credits === -options['initial-credits']).length !== 1)) fail('初始积分余额、累计到账、消费或充值流水核验失败');
    const inventory = readOnlyInventory();
    const owner = match({ ...item, tenantId }, inventory);
    if (!owner) fail('账号启用状态复核失败');
    return { username: item.username, company: item.company, tenantId, role: me.role, accountType: me.accountType, status: '启用', tenantStatus: me.tenant.status, modules: me.modules, credits: balance.credits, seatLimit: 5, expiresAt: null, result: '通过', checkedAt: new Date().toISOString() };
  } finally {
    if (token) {
      const result = await call('POST','/api/auth/logout',{},token);
      if (!result.ok) fail('退出登录失败');
    }
  }
}

async function fund(item) {
  stage = '初始积分入账';
  const inventory = readOnlyInventory(), tenant = match(item, inventory);
  if (!tenant) fail('入账前租户不存在');
  if (item.creditPhase === 'credited') {
    if (tenant.credits !== options['initial-credits'] || tenant.totalRecharged !== options['initial-credits']) fail('已入账企业余额变化，停止核对');
    return;
  }
  if (item.creditPhase === 'crediting') {
    const receipt = inventory.receipts.filter(x => x.requestKey === item.creditRequestKey && x.actorId === item.creditActorId);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({operation:'adjust_credits',tenantId:item.tenantId,payload:{amount:options['initial-credits'],note:item.creditNote}})).digest('hex');
    if (receipt.length !== 1 || receipt[0].operation !== 'adjust_credits' || receipt[0].tenantId !== item.tenantId || receipt[0].fingerprint !== fingerprint ||
        JSON.parse(receipt[0].response).balance !== options['initial-credits'] || tenant.credits !== options['initial-credits'] || tenant.totalRecharged !== options['initial-credits']) fail('前次入账结果不确定且无匹配完整回执，停止人工核对；不重复加分');
    item.creditPhase = 'credited'; save();
    console.log(`第 ${ordinal} 个：已从只读财务回执恢复入账结果，未再次加分`);
    return;
  }
  if (tenant.credits !== 0 || tenant.totalRecharged !== 0) fail('新企业初始余额非零，禁止重复加分');
  item.creditRequestKey = crypto.randomUUID(); item.creditActorId = superId;
  item.creditNote = '甲方50企业开通初始积分'; item.creditPhase = 'crediting'; save();
  const result = await call('POST',`/api/platform/tenants/${item.tenantId}/credits`,{delta:options['initial-credits'],note:item.creditNote,requestKey:item.creditRequestKey},superToken);
  if (result.balance !== options['initial-credits']) fail('积分调整回执余额不符，停止核对');
  const updated = match(item, readOnlyInventory());
  if (!updated || updated.credits !== options['initial-credits'] || updated.totalRecharged !== options['initial-credits']) fail('积分调整后只读余额复核失败');
  item.creditPhase = 'credited'; item.creditedAt = new Date().toISOString(); save();
  console.log(`第 ${ordinal} 个：已入账 ${options['initial-credits']} 积分`);
}
async function exports() {
  const headers = ['序号','企业名称','登录账号','初始密码','角色','登录网址','初始积分','创建时间','登录验证结果'];
  const rows = state.items.filter(x => x.tenantId).map(x => [x.index,x.company,x.username,x.password,'主账号（boss）',base+'/login',x.creditPhase === 'credited' || x.verification === '通过' ? options['initial-credits'] : 0,x.createdAt,x.verification]);
  const quote = value => '"' + String(value ?? '').replaceAll('"','""') + '"';
  atomic('账号列表.csv', '\uFEFF' + [headers,...rows].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n');
  const { Workbook, SpreadsheetFile } = artifact;
  const book = Workbook.create(), sheet = book.worksheets.add('账号列表');
  sheet.showGridLines = false;
  const end = rows.length + 1;
  // artifact-tool 保存时会额外输出检查文件；该库始终只接收遮蔽后的密码。
  // 最终在内存中填入 XLSX 密码单元格，避免明文进入检查文件/日志/预览。
  const maskedRows = rows.map(row => row.map((value,i) => i === 3 ? '（已隐藏）' : value));
  sheet.getRange(`A1:I${end}`).values = [headers,...maskedRows];
  sheet.getRange(`A1:I${end}`).format.font = { name:'Arial', size:11 };
  sheet.getRange(`A1:I${end}`).format.rowHeight = 26;
  sheet.getRange('A1:I1').format = { fill:'#243746',font:{name:'Arial',size:11,bold:true,color:'#FFFFFF'},horizontalAlignment:'center' };
  [8,30,22,24,20,46,16,26,25].forEach((width,i) => { sheet.getRangeByIndexes(0,i,end,1).format.columnWidth = width; });
  if (rows.length) {
    sheet.getRange(`C2:F${end}`).format.numberFormat = '@';
    sheet.getRange(`G2:G${end}`).format.numberFormat = '#,##0';
    // 数据库时间按服务端本地文本保留，避免把未带时区的值擅自换算。
    sheet.getRange(`H2:H${end}`).format.numberFormat = '@';
    sheet.tables.add(`A1:I${end}`,true,'CustomerAccounts');
  }
  sheet.freezePanes.freezeRows(1);
  book.recalculate();
  if (JSON.stringify(sheet.getRange(`A1:I${end}`).values) !== JSON.stringify([headers,...maskedRows])) fail('账号表导出前内容核对失败');
  const xlsx = await SpreadsheetFile.exportXlsx(book);
  const draft = path.join(output, `账号列表.${process.pid}.tmp.xlsx`);
  if (fs.existsSync(draft)) fail('发现未清理的表格临时文件，停止核对');
  try {
    await xlsx.save(draft);
    fs.chmodSync(draft,0o600);
    const program = `import sys,json,base64,zipfile,io,xml.etree.ElementTree as E\np=json.load(sys.stdin)\nns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'\nsource=zipfile.ZipFile(io.BytesIO(base64.b64decode(p['xlsx'])))\nout=io.BytesIO()\nwith zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as dest:\n for f in source.infolist():\n  data=source.read(f.filename)\n  if f.filename=='xl/worksheets/sheet1.xml':\n   root=E.fromstring(data)\n   for index,password in enumerate(p['passwords'],2):\n    cell=root.find('.//{'+ns+'}c[@r="D'+str(index)+'"]')\n    if cell is None: raise ValueError('missing cell')\n    for child in list(cell): cell.remove(child)\n    cell.set('t','inlineStr')\n    E.SubElement(E.SubElement(cell,'{'+ns+'}is'),'{'+ns+'}t').text=password\n   data=E.tostring(root,encoding='utf-8',xml_declaration=True)\n  dest.writestr(f,data)\nsys.stdout.buffer.write(out.getvalue())\n`;
    const python = path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
    const bytes = execFileSync(python,['-c',program],{input:JSON.stringify({xlsx:fs.readFileSync(draft).toString('base64'),passwords:rows.map(r=>r[3])}),stdio:['pipe','pipe','pipe'],maxBuffer:8*1024*1024});
    atomic('账号列表.xlsx',bytes);
  } finally {
    fs.rmSync(draft,{force:true});
    fs.rmSync(draft+'.inspect.ndjson',{force:true});
  }
  atomic('验证结果.json', JSON.stringify({ complete: state.items.every(x => x.verification === '通过'), items: state.items.map(x => ({ index: x.index, username: x.username, company: x.company, tenantId: x.tenantId ?? null, result: x.verification, ...(x.checked ? { checked: x.checked } : {}) })) }, null, 2));
}

async function main() {
  parse();
  if (!options['dry-run']) {
    const runtime = process.env.NANOWORK_ARTIFACT_MODULES || path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
    const runtimeRequire = createRequire(path.join(runtime,'__loader__.cjs'));
    artifact = await import(pathToFileURL(runtimeRequire.resolve('@oai/artifact-tool')).href);
    acquireLock();
  }
  load();
  importInvitations();
  stage = '健康检查';
  const health = await call('GET','/api/health');
  if (health.ok !== true || health.db !== 'up') fail('目标站点健康检查失败');
  console.log('目标站点健康检查通过');
  stage = '全量只读查重';
  const inventory = readOnlyInventory();
  let conflicts = 0;
  for (const item of state.items) {
    ordinal = item.index;
    try {
      const existing = match(item, inventory);
      console.log(`${String(item.index).padStart(2,'0')} | ${item.company} | ${item.username} | ${existing ? '复用已有' : '待创建'} | 1 主账号 / 5 席 / 目标 ${options['initial-credits']} 积分 / 无套餐期限`);
    } catch (error) {
      if (!options['dry-run']) throw error;
      conflicts++; console.log(`${String(item.index).padStart(2,'0')} | ${item.company} | ${item.username} | 冲突或归属异常`);
    }
  }
  if (options['dry-run']) {
    stage = '注册限流余量'; ordinal = 0;
    console.log(`已检查 ${state.items.length} 组名称，冲突 ${conflicts}；未登录、未发码、未注册。`);
    if (conflicts) fail('发现冲突，不能开通');
    console.log('只读检查通过；注册限流剩余额度无法只读查询，正式执行遇到限流即停止。');
    return;
  }
  if (options['auth-mode'] === 'invitations' && !options['verify-only']) {
    stage = '导入邀请码用途及容量预检';
    const pending = state.items.filter(item => !match(item,inventory));
    for (const item of pending) {
      ordinal = item.index;
      validateInvitation(item,inventory,pending.filter(x => x.inviteCode === item.inviteCode).length);
    }
  }
  if (options['auth-mode'] === 'password' && !options['verify-only']) {
    stage = '平台登录'; ordinal = 0;
    const username = process.env.NANOWORK_SUPER_USERNAME, password = process.env.NANOWORK_SUPER_PASSWORD;
    if (!username || !password) fail('缺少超管环境变量（不接受命令行凭据）');
    const login = await call('POST','/api/auth/login',{username,password});
    superToken = login.token; superId = login.user?.id;
    if (!superToken || login.user?.role !== 'platform_super' || !Number.isSafeInteger(superId)) fail('超管身份核验失败');
  }
  for (const item of state.items) {
    ordinal = item.index; stage = '重试前查重';
    const existing = match(item, readOnlyInventory());
    if (existing) {
      if (!item.tenantId) {
        stage = '恢复注册回执';
        await inspect(item, existing.id, false);
        item.tenantId = existing.id; item.createdAt = existing.createdAt; item.phase = 'created'; save();
      }
      console.log(`第 ${ordinal} 个：已创建，复用并跳过注册`);
    } else {
      if (options['verify-only']) fail('仅验证模式发现企业未创建，禁止补建');
      if (item.phase === 'inviting' && !item.inviteCode) fail('前次发码结果不确定；接口无幂等键，须人工核对，禁止自动重复发码');
      if (!item.inviteCode) {
        if (!superToken) fail('本账号缺少导入的邀请码，停止');
        stage = '创建新企业邀请码';
        item.phase = 'inviting'; save();
        const invitation = await call('POST','/api/platform/invitations',{type:'new_tenant',role:'boss',maxUses:1},superToken);
        if (!invitation.ok || !invitation.code || !invitation.invitation?.id) fail('发码响应不完整，禁止盲目重试');
        item.inviteCode = invitation.code; item.invitationId = invitation.invitation.id; item.phase = 'invited'; save();
      }
      stage = '邀请码注册前只读校验';
      validateInvitation(item,readOnlyInventory());
      stage = '邀请码注册';
      let created = false;
      {
        const before = match(item, readOnlyInventory());
        if (before) {
          await inspect(item, before.id, false);
          item.tenantId = before.id; item.createdAt = before.createdAt; created = true;
        } else {
        item.phase = 'registering'; save();
        const result = await request('POST','/api/auth/register',{company:item.company,contactName:item.username,username:item.username,password:item.password,inviteCode:item.inviteCode});
        const data = result.data;
        if (!data.ok || !Number.isSafeInteger(data.tenantId) || data.tenantId < 1 || data.registrationType !== 'new_tenant' || data.canLogin !== true) fail('注册回执不完整，需查重后恢复');
        item.tenantId = data.tenantId; item.createdAt = new Date().toISOString(); created = true;
        }
      }
      if (!created) fail('注册未完成，停止');
      item.phase = 'created'; save();
      const confirmed = match(item, readOnlyInventory());
      if (!confirmed) fail('注册后归属查重失败');
      item.createdAt = confirmed.createdAt; save();
      console.log(`第 ${ordinal} 个：创建成功`);
    }
    if (!options['register-only'] && !options['verify-only']) await fund(item);
    if (options.verify) {
      if (options['precheck-login'] && item.verification === '登录通过，积分待验收' && item.checked?.tenantId === item.tenantId && item.checked?.username === item.username) { console.log(`第 ${ordinal} 个：复用本批已完成的公网登录检查记录`); continue; }
      stage = '登录验证';
      item.verification = '验证中'; save();
      try { item.checked = await inspect(item, item.tenantId, !options['precheck-login']); item.verification = options['precheck-login'] ? '登录通过，积分待验收' : '通过'; save(); }
      catch (error) { item.verification = '失败'; save(); throw error; }
      console.log(options['precheck-login'] ? `第 ${ordinal} 个：公网登录、身份、10 模块、5 席、无期限和退出通过；实际余额 ${item.checked.credits}，积分待验收` : `第 ${ordinal} 个：登录、身份、状态、10 模块、5 席、无期限、${options['initial-credits']} 积分和退出均通过`);
    }
  }
  stage = '租户唯一性验收';
  if (new Set(state.items.map(x => x.tenantId)).size !== state.items.length) fail('tenantId 存在重复');
  if (options.verify && state.items.some(x => x.verification !== (options['precheck-login'] ? '登录通过，积分待验收' : '通过'))) fail('登录验证未全部通过');
  stage = '导出交付文件'; await exports();
}

let failed = false;
try { await main(); }
catch (error) {
  failed = true;
  // 仅我们明确构造的业务错误可回显；底层异常不含在日志中。
  const safe = error instanceof SafeError ? error.message : '底层操作失败，敏感诊断已隐藏';
  console.error(`失败：第 ${ordinal} 个，步骤【${stage}】：${safe}`);
  process.exitCode = options['dry-run'] ? 2 : 1;
  if (state && lockOwned) {
    try { save(); await exports(); } catch { console.error('状态/部分交付文件导出失败；本次不算成功'); }
  }
} finally {
  if (superToken) {
    try { const result = await call('POST','/api/auth/logout',{},superToken); if (!result.ok) throw new Error(); }
    catch { failed = true; process.exitCode = 1; console.error('失败：平台会话退出未确认，本次不算成功'); }
  }
  if (lockOwned) { try { fs.unlinkSync(lock); } catch { failed = true; process.exitCode = 1; console.error('失败：批次锁清理失败'); } }
}
if (failed && !process.exitCode) process.exitCode = 1;
if (!failed && !options['dry-run']) console.log(`完成 ${state.items.length}/${state.items.length} 家独立企业；登录验证：${options['precheck-login'] ? '登录通过，积分待验收' : options.verify ? '全部通过' : '未执行'}。${options['register-only'] ? '仅注册完成，尚需按老板选定方式加积分后单独验收。' : options['precheck-login'] ? '尚未完成积分验收。' : `每家初始积分 ${options['initial-credits']}，不设套餐期限。`}`);

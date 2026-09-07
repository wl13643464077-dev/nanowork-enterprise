import crypto from 'node:crypto';
import { db, q } from '../db.js';
import { hashPassword, verifyPassword, revokeUserSessions } from '../util.js';
import { TESTER_EMPLOYEES, testerEmployeePrompt } from './tester-employee-catalog.js';
import { chat } from './yunwu.js';
import { runWithProviderContext } from './tester-provider-context.js';
import { testerCostEvidence, testerEvidenceTotals, loadTesterCallEvidence, testerReceipts } from './tester-cost-evidence.js';
import { factGroundingAdvice } from './fact-grounding-advice.js';
import { ensureTesterSchema, testerError, tokenHash, encryptTesterSecret, decryptTesterSecret,
  testerAccount, requireActiveTester, testerPublicProfile, testerProvider, testerProviderKey } from './tester-access.js';

export const TRIAL_DISCLOSURE = '提交即申请两轮免费文字对话体验。您填写的姓名、手机号、门店信息，以及选择的数字员工/功能、对话输入、输出、使用时间和调用费用，将提供给邀请您的销售/测试员及纳米Work平台管理员，用于审批、产品演示和服务跟进。功能兴趣仅指您主动选择或实际使用的岗位，不推测个人心理。AI调用使用邀请人配置的供应商个人 API Key，供应商在本体验页显示，您无需充值。请勿提交与体验无关的个人敏感信息。';
export const TRIAL_CONSENT_VERSION = '2026-09-tester-v3';
export const TRIAL_EMPLOYEES = TESTER_EMPLOYEES;
const textModel = provider => testerProvider(provider || '360').model;

const now = () => new Date().toISOString();
const positiveId = value => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw testerError('记录不存在', 404, 'NOT_FOUND');
  return id;
};
const phoneValue = value => {
  const phone = String(value || '').trim();
  if (!/^1\d{10}$/.test(phone)) throw testerError('请填写11位中国大陆手机号');
  return phone;
};
function textValue(value, label, maximum = 80) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maximum) throw testerError(`${label}须为1至${maximum}个字符`);
  return text;
}
function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function audit(actorId, type, id, action) {
  q.run('INSERT INTO tester_audit(actor_user_id,target_type,target_id,action) VALUES(?,?,?,?)', actorId || null, type, id, action);
}
function superActor(actor) {
  const row = q.get('SELECT * FROM users WHERE id=?', Number(actor?.id));
  if (!row || row.role !== 'platform_super' || row.status !== '启用') throw testerError('仅平台超级管理员可执行此操作', 403, 'SUPER_REQUIRED');
  return row;
}
function scopeActor(actor, admin) {
  return admin ? superActor(actor) : requireActiveTester(actor?.id);
}
function ownerScope(actor, admin) {
  scopeActor(actor, admin);
  return admin ? { sql: '', values: [] } : { sql: ' AND owner_user_id=?', values: [Number(actor.id)] };
}

export function applyTester(input = {}) {
  ensureTesterSchema();
  const username = textValue(input.username, '登录账号', 40);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{3,39}$/.test(username)) throw testerError('登录账号须为4至40位字母、数字、点、横线或下划线');
  const name = textValue(input.name, '姓名', 40);
  const phone = phoneValue(input.phone);
  if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) throw testerError('密码须为8至128位');
  if (input.consent !== true) throw testerError('请先阅读并同意测试员申请说明');
  const passwordHash = hashPassword(input.password);
  return transaction(() => {
    if (q.get('SELECT id FROM users WHERE lower(username)=lower(?)', username)) throw testerError('登录账号已被使用', 409, 'USERNAME_TAKEN');
    if (q.get('SELECT user_id FROM tester_accounts WHERE phone=?', phone)) throw testerError('该手机号已提交申请，请使用原账号登录或联系管理员', 409, 'PHONE_ALREADY_APPLIED');
    const tenantId = Number(q.run(`INSERT INTO tenants(name,contact_name,phone,status,modules,credits,seat_limit,note)
      VALUES(?,?,?,'待审核','[]',0,1,'测试员独立空间，仅可通过专用体验工作台访问')`, `${name}的测试员空间`, name, phone).lastInsertRowid);
    const userId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,dept,phone,status,tenant_id,modules)
      VALUES(?,?,?,'sales','测试员',?,'停用',?,'[]')`, username, passwordHash, name, phone, tenantId).lastInsertRowid);
    q.run('UPDATE tenants SET primary_user_id=? WHERE id=?', userId, tenantId);
    q.run('INSERT INTO tester_accounts(user_id,phone,consent_at,active_provider) VALUES(?,?,?,?)', userId, phone, now(), 'openlux');
    audit(userId, 'tester', userId, 'applied');
    return { ok: true, status: 'pending', message: '申请已提交，Super审核通过后即可用此账号登录测试员工作台。' };
  });
}

export function updateTesterStatus(actor, id, status) {
  ensureTesterSchema(); superActor(actor);
  if (!['approved', 'rejected', 'paused'].includes(status)) throw testerError('审核状态无效');
  const userId = positiveId(id);
  return transaction(() => {
    const account = testerAccount(userId);
    if (!account) throw testerError('测试员申请不存在', 404);
    if (account.status !== status) {
      q.run('UPDATE tester_accounts SET status=?,reviewed_by=?,reviewed_at=? WHERE user_id=?', status, actor.id, now(), userId);
      q.run('UPDATE users SET status=?,auth_version=auth_version+1 WHERE id=?', status === 'approved' ? '启用' : '停用', userId);
      q.run('UPDATE tenants SET status=? WHERE id=?', status === 'approved' ? '已开通' : '已停用', account.tenant_id);
      revokeUserSessions(userId);
      audit(actor.id, 'tester', userId, status);
    }
    return { ok: true, tester: testerPublicProfile(testerAccount(userId)) };
  });
}

export function listTesters(actor) {
  ensureTesterSchema(); superActor(actor);
  return q.all('SELECT user_id FROM tester_accounts ORDER BY created_at DESC,user_id DESC LIMIT 1000').map(({ user_id: id }) => {
    const costs = { conversationCount: q.get('SELECT COUNT(*) n FROM tester_conversations WHERE owner_user_id=?', id).n,
      ...testerEvidenceTotals(loadTesterCallEvidence(id)) };
    return { ...testerPublicProfile(testerAccount(id)), invitationCount: q.get('SELECT COUNT(*) n FROM tester_invitations WHERE owner_user_id=?', id).n,
      leadCount: q.get('SELECT COUNT(*) n FROM tester_leads WHERE owner_user_id=?', id).n,
      usedTurns: q.get('SELECT COALESCE(SUM(used_turns),0) n FROM tester_leads WHERE owner_user_id=?', id).n, ...costs };
  });
}

export function testerMe(actor) {
  const profile = testerPublicProfile(requireActiveTester(actor.id));
  return { ...profile, profile, employees: TRIAL_EMPLOYEES, billingMode: 'personal',
    billingNotice: '自己及所邀请客户的调用费用由绑定的个人供应商账户直接支付，不另扣纳米Work算力余额。旧二维码继续使用创建时绑定的供应商；未返回实际金额的调用会标为待核实。' };
}

export function setTesterProvider(actor, value) {
  requireActiveTester(actor.id);
  const provider = testerProvider(value).id;
  q.run('UPDATE tester_accounts SET active_provider=? WHERE user_id=?', provider, actor.id);
  audit(actor.id, 'tester', actor.id, `provider_selected:${provider}`);
  return testerPublicProfile(testerAccount(actor.id));
}
export function setTesterKey(actor, value, requestedProvider) {
  const account = requireActiveTester(actor.id);
  const provider = testerProvider(requestedProvider ?? account.active_provider).id;
  if (typeof value !== 'string' || value.trim().length < 12 || value.trim().length > 512 || /\s/.test(value.trim())) throw testerError('请填写有效的个人 API Key');
  const encrypted = encryptTesterSecret(value.trim());
  q.run(`INSERT INTO tester_provider_keys(owner_user_id,provider,api_key_cipher,key_updated_at) VALUES(?,?,?,?)
    ON CONFLICT(owner_user_id,provider) DO UPDATE SET api_key_cipher=excluded.api_key_cipher,key_updated_at=excluded.key_updated_at`, actor.id, provider, encrypted, now());
  audit(actor.id, 'tester', actor.id, `key_updated:${provider}`);
  return testerPublicProfile(testerAccount(actor.id));
}
export function clearTesterKey(actor, requestedProvider) {
  const account = requireActiveTester(actor.id);
  const provider = testerProvider(requestedProvider ?? account.active_provider).id;
  q.run('DELETE FROM tester_provider_keys WHERE owner_user_id=? AND provider=?', actor.id, provider);
  audit(actor.id, 'tester', actor.id, `key_removed:${provider}`);
  return testerPublicProfile(testerAccount(actor.id));
}
export async function changeTesterPassword(actor, input) {
  requireActiveTester(actor.id);
  if (typeof input?.password !== 'string' || input.password.length < 8 || input.password.length > 128) throw testerError('新密码须为8至128位');
  const user = q.get('SELECT password_hash FROM users WHERE id=?', actor.id);
  if (typeof input.currentPassword !== 'string' || !(await verifyPassword(input.currentPassword, user.password_hash))) throw testerError('当前密码不正确', 403);
  q.run('UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=?', hashPassword(input.password), actor.id);
  revokeUserSessions(actor.id); audit(actor.id, 'tester', actor.id, 'password_changed');
  return { ok: true, message: '密码已修改，请重新登录' };
}

function ownerCredentials(userId, requestedProvider) {
  const account = requireActiveTester(userId);
  const provider = testerProvider(requestedProvider ?? account.active_provider);
  const stored = testerProviderKey(userId, provider.id);
  if (!stored?.api_key_cipher) throw testerError(`尚未配置${provider.label}个人 API Key，请邀请人填写对应 Key`, 409, 'PERSONAL_KEY_REQUIRED');
  return { provider: provider.id, baseUrl: provider.baseUrl, ownerUserId: Number(userId),
    apiKey: decryptTesterSecret(stored.api_key_cipher), billingMode: 'personal' };
}
function publicOrigin(origin) {
  let parsed;
  try { parsed = new URL(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_APP_URL || process.env.APP_PUBLIC_URL || origin); } catch { throw testerError('平台尚未配置公开体验地址', 503); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw testerError('体验地址配置无效', 503);
  return parsed.origin;
}
function invitationView(row, origin) {
  const token = decryptTesterSecret(row.token_cipher);
  return { id: row.id, ownerUserId: row.owner_user_id, token, title: row.title, salesPhone: row.sales_phone, provider: row.provider || '360',
    status: row.status, createdAt: row.created_at, url: `${publicOrigin(origin)}/try/${token}` };
}
export function createTesterInvitation(actor, input = {}, origin) {
  const account = requireActiveTester(actor.id); const credentials = ownerCredentials(actor.id, account.active_provider);
  const salesPhone = input.salesPhone ? phoneValue(input.salesPhone) : account.phone;
  const title = input.title ? textValue(input.title, '体验页标题', 60) : '纳米Work · 餐饮数字员工体验';
  const token = crypto.randomBytes(32).toString('base64url');
  if (q.get('SELECT COUNT(*) n FROM tester_invitations WHERE owner_user_id=? AND status=?', actor.id, 'active').n >= 50) throw testerError('启用中的体验邀请已达50个，请停用旧邀请后再创建', 409);
  const id = Number(q.run('INSERT INTO tester_invitations(owner_user_id,token_hash,token_cipher,title,sales_phone,provider) VALUES(?,?,?,?,?,?)',
    actor.id, tokenHash(token), encryptTesterSecret(token), title, salesPhone, credentials.provider).lastInsertRowid);
  audit(actor.id, 'invitation', id, 'created');
  return invitationView(q.get('SELECT * FROM tester_invitations WHERE id=?', id), origin);
}
export function listTesterInvitations(actor, origin, admin = false) {
  const scope = ownerScope(actor, admin);
  return q.all(`SELECT * FROM tester_invitations WHERE 1=1${scope.sql} ORDER BY id DESC LIMIT 1000`, ...scope.values).map(row => ({
    ...invitationView(row, origin), ownerName: q.get('SELECT name FROM users WHERE id=?', row.owner_user_id)?.name,
    leadCount: q.get('SELECT COUNT(*) n FROM tester_leads WHERE invitation_id=?', row.id).n }));
}
export function pauseTesterInvitation(actor, id, admin = false) {
  const scope = ownerScope(actor, admin);
  const row = q.get(`SELECT id FROM tester_invitations WHERE id=?${scope.sql}`, positiveId(id), ...scope.values);
  if (!row) throw testerError('体验邀请不存在', 404);
  q.run("UPDATE tester_invitations SET status='paused' WHERE id=?", row.id);
  audit(actor.id, 'invitation', row.id, 'paused');
  return { ok: true, status: 'paused' };
}
function activeInvitation(token) {
  ensureTesterSchema();
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(token || ''))) throw testerError('体验邀请不存在或已暂停', 404, 'TRIAL_UNAVAILABLE');
  const invitation = q.get("SELECT * FROM tester_invitations WHERE token_hash=? AND status='active'", tokenHash(token));
  if (!invitation) throw testerError('体验邀请不存在或已暂停', 404, 'TRIAL_UNAVAILABLE');
  requireActiveTester(invitation.owner_user_id);
  return invitation;
}
export function publicTrial(token) {
  const invitation = activeInvitation(token);
  const provider = testerProvider(invitation.provider || '360');
  return { title: invitation.title, salesPhone: invitation.sales_phone, employees: TRIAL_EMPLOYEES, provider: provider.id, providerLabel: provider.label,
    disclosure: TRIAL_DISCLOSURE, turnLimit: 2, keyConfigured: Boolean(testerProviderKey(invitation.owner_user_id, provider.id)?.api_key_cipher) };
}
function leadView(row) {
  const invitation = q.get('SELECT title,sales_phone,provider FROM tester_invitations WHERE id=?', row.invitation_id);
  return { id: row.id, ownerUserId: row.owner_user_id, invitationId: row.invitation_id, name: row.name,
    ownerName: q.get('SELECT name FROM users WHERE id=?', row.owner_user_id)?.name || '',
    salesPhone: invitation?.sales_phone || '', invitationTitle: invitation?.title || '', provider: invitation?.provider || '360',
    phone: row.phone, storeName: row.store_name, status: row.status, usedTurns: row.used_turns,
    remainingTurns: Math.max(0, 2 - row.used_turns), createdAt: row.created_at, lastUsedAt: row.last_used_at,
    consentAt: row.consent_at, consentVersion: row.consent_version };
}
export function applyTrial(token, input = {}) {
  const invitation = activeInvitation(token); ownerCredentials(invitation.owner_user_id, invitation.provider || '360');
  const phone = phoneValue(input.phone); const name = textValue(input.name, '姓名', 40);
  const storeName = input.storeName ? textValue(input.storeName, '门店名称', 100) : '';
  if (input.consent !== true) throw testerError('请先阅读并同意体验说明');
  return transaction(() => {
    // Phone is globally unique, not merely per invite: switching sales links
    // cannot reset two turns or take over an existing customer's session.
    if (q.get('SELECT id FROM tester_leads WHERE phone=?', phone)) throw testerError('该手机号已申请体验，请回到原体验链接和原设备继续使用，或联系邀请人', 409, 'TRIAL_ALREADY_APPLIED');
    const accessToken = crypto.randomBytes(32).toString('base64url');
    const id = Number(q.run('INSERT INTO tester_leads(owner_user_id,invitation_id,phone,name,store_name,access_hash,consent_at,consent_version) VALUES(?,?,?,?,?,?,?,?)',
      invitation.owner_user_id, invitation.id, phone, name, storeName, tokenHash(accessToken), now(), TRIAL_CONSENT_VERSION).lastInsertRowid);
    audit(null, 'lead', id, 'applied');
    return { lead: leadView(q.get('SELECT * FROM tester_leads WHERE id=?', id)), accessToken };
  });
}
function authenticateTrial(token, accessToken) {
  const invitation = activeInvitation(token);
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(accessToken || ''))) throw testerError('请先申请体验', 401, 'TRIAL_SESSION_REQUIRED');
  const lead = q.get('SELECT * FROM tester_leads WHERE invitation_id=? AND access_hash=?', invitation.id, tokenHash(accessToken));
  if (!lead) throw testerError('体验登录状态无效，请使用原体验链接和原设备', 401, 'TRIAL_SESSION_REQUIRED');
  return { invitation, lead };
}
function conversationView(row) {
  let usage = {}; let supplierCosts = [];
  try { usage = JSON.parse(row.usage_json); supplierCosts = JSON.parse(row.supplier_costs_json); } catch { /* legacy row */ }
  const callAttempts = q.all('SELECT * FROM tester_call_attempts WHERE conversation_id=? ORDER BY attempt_number', row.id).map(attempt => ({
    id: attempt.id, attemptNumber: attempt.attempt_number, status: attempt.status, model: attempt.model, provider: attempt.provider || '360',
    usage: JSON.parse(attempt.usage_json), supplierCosts: JSON.parse(attempt.supplier_costs_json),
    supplierCostCny: attempt.supplier_cost_cny, costStatus: attempt.cost_status, errorCode: attempt.error_code,
    createdAt: attempt.created_at, completedAt: attempt.completed_at,
  }));
  // Everything the customer typed in this thread counts as confirmed fact; the
  // advice only flags concrete claims the model added on its own.
  const confirmed = row.output ? q.all(`SELECT input FROM tester_conversations WHERE owner_user_id=? AND COALESCE(lead_id,0)=? AND id<=?`,
    row.owner_user_id, row.lead_id || 0, row.id).map(item => item.input) : [];
  return { id: row.id, requestId: row.request_id, ownerUserId: row.owner_user_id, leadId: row.lead_id,
    employeeId: row.employee_id, employeeName: TRIAL_EMPLOYEES.find(item => item.id === row.employee_id)?.name,
    input: row.input, output: row.output, status: row.status, model: row.model, provider: row.provider || '360', usage, supplierCosts,
    supplierCostCny: row.supplier_cost_cny, costStatus: row.cost_status, usedCredits: 0,
    callAttempts, unverifiedCostCount: callAttempts.filter(attempt => attempt.costStatus !== 'verified').length,
    factAdvice: row.output ? factGroundingAdvice(row.output, confirmed) : [],
    errorCode: row.error_code, createdAt: row.created_at, completedAt: row.completed_at };
}
export function trialSession(token, accessToken) {
  const { lead } = authenticateTrial(token, accessToken);
  return { lead: leadView(lead), conversations: q.all('SELECT * FROM tester_conversations WHERE lead_id=? ORDER BY id', lead.id).map(conversationView) };
}

export function recordTrialInterest(token, accessToken, input = {}) {
  const { lead } = authenticateTrial(token, accessToken);
  if (!['pending', 'approved'].includes(lead.status)) throw testerError('当前体验资格不可记录选岗', 403, 'TRIAL_UNAVAILABLE');
  if (!['2026-09-tester-v2', TRIAL_CONSENT_VERSION].includes(lead.consent_version)) throw testerError('本申请未包含选岗记录授权，可继续正常对话', 409, 'INTEREST_CONSENT_REQUIRED');
  const employee = TRIAL_EMPLOYEES.find(item => item.id === input.employeeId);
  if (!employee) throw testerError('请选择体验页提供的数字员工', 400, 'EMPLOYEE_NOT_ALLOWED');
  const inserted = q.run('INSERT OR IGNORE INTO tester_interests(owner_user_id,lead_id,employee_id,created_at) VALUES(?,?,?,?)',
    lead.owner_user_id, lead.id, employee.id, now());
  return { ok: true, created: inserted.changes === 1 };
}
export function listTesterLeads(actor, admin = false) {
  const scope = ownerScope(actor, admin);
  const calls = loadTesterCallEvidence(admin ? null : actor.id);
  const costs = testerCostEvidence(calls);
  return q.all(`SELECT * FROM tester_leads WHERE 1=1${scope.sql} ORDER BY id DESC LIMIT 1000`, ...scope.values).map(row => ({
    ...leadView(row), invitationTitle: q.get('SELECT title FROM tester_invitations WHERE id=?', row.invitation_id)?.title,
    ownerName: q.get('SELECT name FROM users WHERE id=?', row.owner_user_id)?.name,
    ...testerEvidenceTotals(calls.filter(call => call.lead_id === row.id), costs) }));
}
export function testerLeadDetail(actor, id, admin = false) {
  const scope = ownerScope(actor, admin);
  const row = q.get(`SELECT * FROM tester_leads WHERE id=?${scope.sql}`, positiveId(id), ...scope.values);
  if (!row) throw testerError('客户申请不存在', 404);
  return { lead: leadView(row), conversations: q.all('SELECT * FROM tester_conversations WHERE lead_id=? ORDER BY id', row.id).map(conversationView) };
}
export function updateLeadStatus(actor, id, status, admin = false) {
  if (!['approved', 'rejected', 'paused'].includes(status)) throw testerError('审核状态无效');
  const { lead } = testerLeadDetail(actor, id, admin);
  q.run('UPDATE tester_leads SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?', status, actor.id, now(), lead.id);
  audit(actor.id, 'lead', lead.id, status);
  return { ok: true, lead: leadView(q.get('SELECT * FROM tester_leads WHERE id=?', lead.id)) };
}
export function ownConversations(actor) {
  requireActiveTester(actor.id);
  return q.all('SELECT * FROM tester_conversations WHERE owner_user_id=? AND lead_id IS NULL ORDER BY id DESC LIMIT 100', actor.id).map(conversationView);
}

function expireAbandonedCalls() {
  q.run(`UPDATE tester_call_attempts SET status='failed',error_code='INTERRUPTED',completed_at=?
    WHERE status='running' AND conversation_id IN
      (SELECT id FROM tester_conversations WHERE status='running' AND lease_expires<?)`, now(), Date.now());
  q.run(`UPDATE tester_conversations SET status='failed',error_code='INTERRUPTED',completed_at=?
    WHERE status='running' AND lease_expires<?`, now(), Date.now());
}
function chatInput(input) {
  const employee = TRIAL_EMPLOYEES.find(item => item.id === input?.employeeId);
  if (!employee) throw testerError('请选择体验页提供的数字员工', 400, 'EMPLOYEE_NOT_ALLOWED');
  const message = textValue(input.message, '对话内容', 8000);
  const requestId = String(input.requestId || '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) throw testerError('请求标识无效，请刷新页面重试', 400, 'REQUEST_ID_REQUIRED');
  return { employee, message, requestId };
}
function resultCost(result, provider) {
  const costs = Array.isArray(result?.supplierCosts) ? result.supplierCosts : [];
  const totals = testerEvidenceTotals([{ id: 'result', owner_user_id: 0, provider, cost_status: 'verified', supplier_costs_json: costs }]);
  return { supplierCosts: costs, cost: totals.supplierCostCny, status: totals.unverifiedCostCount ? 'unverified' : 'verified' };
}

function reserveCallAttempt(conversation) {
  // Prior versions did not have attempt rows. Keep any existing evidence as
  // its own historical attempt before a retry, without inventing missing fees.
  if (conversation.attempts > 1 && !q.get('SELECT id FROM tester_call_attempts WHERE conversation_id=? LIMIT 1', conversation.id)) {
    q.run(`INSERT INTO tester_call_attempts(conversation_id,attempt_number,status,model,usage_json,
      supplier_costs_json,supplier_cost_cny,cost_status,created_at,completed_at,provider)
      VALUES(?,?,'failed',?,?,?,?,?,?,?,?)`, conversation.id, conversation.attempts - 1, conversation.model,
    conversation.usage_json, conversation.supplier_costs_json, conversation.supplier_cost_cny,
    conversation.cost_status, conversation.created_at, conversation.completed_at || now(), conversation.provider || '360');
  }
  q.run('INSERT INTO tester_call_attempts(conversation_id,attempt_number,model,provider) VALUES(?,?,?,?)', conversation.id, conversation.attempts, textModel(conversation.provider), conversation.provider || '360');
  q.run('UPDATE tester_conversations SET model=? WHERE id=?', textModel(conversation.provider), conversation.id);
  return conversation;
}

function summarizeCallAttempts(conversationId) {
  const attempts = q.all('SELECT * FROM tester_call_attempts WHERE conversation_id=? ORDER BY attempt_number', conversationId);
  const ownerId = q.get('SELECT owner_user_id FROM tester_conversations WHERE id=?', conversationId).owner_user_id;
  const totals = testerEvidenceTotals(attempts.map(attempt => ({ ...attempt, owner_user_id: ownerId })));
  const usage = attempts.map(attempt => JSON.parse(attempt.usage_json));
  const supplierCosts = attempts.flatMap(attempt => JSON.parse(attempt.supplier_costs_json));
  const tokens = key => usage.reduce((sum, item) => sum + (Number.isSafeInteger(item[key]) && item[key] >= 0 ? item[key] : 0), 0);
  q.run('UPDATE tester_conversations SET usage_json=?,supplier_costs_json=?,supplier_cost_cny=?,cost_status=? WHERE id=?',
    JSON.stringify({ inputTokens: tokens('inputTokens'), outputTokens: tokens('outputTokens') }), JSON.stringify(supplierCosts),
    totals.supplierCostCny, totals.unverifiedCostCount ? 'unverified' : 'verified', conversationId);
}

function saveCallEvidence(conversation, result) {
  const existing = q.get('SELECT supplier_costs_json,usage_json FROM tester_call_attempts WHERE conversation_id=? AND attempt_number=?', conversation.id, conversation.attempts);
  const oldCosts = testerReceipts(existing?.supplier_costs_json);
  const incoming = Array.isArray(result?.supplierCosts) ? result.supplierCosts : [];
  const identity = receipt => `${receipt?.costSource?.provider || conversation.provider}:${receipt?.costSource?.requestId || receipt?.requestId || ''}`;
  // A late usage-only/error callback must not erase an already received debit.
  // Conflicting known amounts remain as separate evidence for pending review.
  const costs = [...oldCosts];
  for (const receipt of incoming) {
    const same = costs.findIndex(old => identity(old) === identity(receipt));
    if (same < 0) costs.push(receipt);
    else if (costs[same].status !== 'known' && receipt.status === 'known') costs[same] = receipt;
    else if (costs[same].status === 'known' && receipt.status === 'known' && costs[same].costYuanOverride !== receipt.costYuanOverride) costs.push(receipt);
  }
  const cost = resultCost({ supplierCosts: costs }, conversation.provider || '360');
  const usage = result?.providerUsage || result?.usage || result || {};
  const priorUsage = JSON.parse(existing?.usage_json || '{}');
  const tokens = key => Number.isSafeInteger(usage[key]) && usage[key] >= 0 ? usage[key] : priorUsage[key] || 0;
  q.run(`UPDATE tester_call_attempts SET model=?,usage_json=?,supplier_costs_json=?,supplier_cost_cny=?,cost_status=?
    WHERE conversation_id=? AND attempt_number=?`, result?.model || textModel(conversation.provider),
  JSON.stringify({ inputTokens: tokens('inputTokens'), outputTokens: tokens('outputTokens') }),
  JSON.stringify(cost.supplierCosts), cost.cost, cost.status, conversation.id, conversation.attempts);
  q.run('UPDATE tester_conversations SET model=? WHERE id=? AND attempts=?', result?.model || textModel(conversation.provider), conversation.id, conversation.attempts);
  summarizeCallAttempts(conversation.id);
}

function finishCallAttempt(conversation, status, errorCode = null) {
  q.run(`UPDATE tester_call_attempts SET status=?,error_code=?,completed_at=?
    WHERE conversation_id=? AND attempt_number=?`, status, errorCode, now(), conversation.id, conversation.attempts);
  summarizeCallAttempts(conversation.id);
}

async function runConversation({ ownerUserId, leadId = null, provider, input, stillAllowed, chatFn = chat, signal }) {
  const { employee, message, requestId } = chatInput(input);
  let credentials;
  let previous;
  const conversation = transaction(() => {
    stillAllowed(); expireAbandonedCalls();
    previous = q.get('SELECT * FROM tester_conversations WHERE owner_user_id=? AND COALESCE(lead_id,0)=? AND request_id=?', ownerUserId, leadId || 0, requestId);
    if (previous && (previous.input !== message || previous.employee_id !== employee.id)) throw testerError('同一请求标识不能用于不同内容', 409, 'IDEMPOTENCY_CONFLICT');
    if (previous?.status === 'succeeded') return previous;
    if (previous?.status === 'running') throw testerError('这条内容正在生成，请稍候查看历史', 409, 'REQUEST_RUNNING');
    credentials = ownerCredentials(ownerUserId, previous ? previous.provider || '360' : provider);
    const running = q.get("SELECT COUNT(*) n FROM tester_conversations WHERE owner_user_id=? AND status='running'", ownerUserId).n;
    if (running >= 3) throw testerError('当前正在处理的体验较多，请稍后重试', 429, 'TESTER_BUSY');
    if (leadId) {
      const lead = q.get('SELECT used_turns FROM tester_leads WHERE id=?', leadId);
      const pending = q.get("SELECT COUNT(*) n FROM tester_conversations WHERE lead_id=? AND status='running'", leadId).n;
      if (lead.used_turns + pending >= 2) throw testerError('两轮体验已用完或正在生成中', 409, 'TRIAL_TURNS_EXHAUSTED');
      if (pending) throw testerError('上一轮正在生成，请等结果出来后继续', 409, 'REQUEST_RUNNING');
    } else if (q.get("SELECT 1 ok FROM tester_conversations WHERE owner_user_id=? AND lead_id IS NULL AND status='running'", ownerUserId)) {
      throw testerError('上一轮正在生成，请稍候', 409, 'REQUEST_RUNNING');
    }
    if (previous) {
      q.run("UPDATE tester_conversations SET status='running',error_code=NULL,lease_expires=?,attempts=attempts+1,completed_at=NULL WHERE id=?", Date.now() + 210000, previous.id);
      return reserveCallAttempt(q.get('SELECT * FROM tester_conversations WHERE id=?', previous.id));
    }
    const id = Number(q.run('INSERT INTO tester_conversations(owner_user_id,lead_id,request_id,employee_id,input,lease_expires,provider) VALUES(?,?,?,?,?,?,?)',
      ownerUserId, leadId, requestId, employee.id, message, Date.now() + 210000, credentials.provider).lastInsertRowid);
    return reserveCallAttempt(q.get('SELECT * FROM tester_conversations WHERE id=?', id));
  });
  if (conversation.status === 'succeeded') return conversationView(conversation);
  try {
    const recent = q.all(`SELECT input,output FROM tester_conversations WHERE owner_user_id=?
      AND COALESCE(lead_id,0)=? AND employee_id=? AND provider=? AND status='succeeded' ORDER BY id DESC LIMIT 3`, ownerUserId, leadId || 0, employee.id, credentials.provider).reverse();
    const result = await runWithProviderContext(credentials, () => chatFn({
      role: 'sales', model: textModel(credentials.provider), thinking: false, timeoutMs: 150000, maxTokens: 2400, signal,
      system: testerEmployeePrompt(employee.id),
      messages: [...recent.flatMap(row => [{ role: 'user', content: row.input }, { role: 'assistant', content: row.output }]), { role: 'user', content: message }],
    }));
    // Cost is retained even when an admin pauses the owner during the call.
    saveCallEvidence(conversation, result);
    if (!String(result?.text || '').trim()) throw testerError('本次没有生成正文，请重试，不消耗体验次数', 502, 'EMPTY_OUTPUT');
    transaction(() => {
      stillAllowed();
      const updated = q.run("UPDATE tester_conversations SET status='succeeded',output=?,completed_at=?,lease_expires=0 WHERE id=? AND attempts=? AND status='running'", result.text, now(), conversation.id, conversation.attempts);
      if (updated.changes !== 1) throw testerError('本次请求已中断，请重新提交', 409, 'REQUEST_INTERRUPTED');
      if (leadId) {
        const count = q.run("UPDATE tester_leads SET used_turns=used_turns+1,last_used_at=? WHERE id=? AND used_turns<2 AND status='approved'", now(), leadId);
        if (count.changes !== 1) throw testerError('体验资格已变化，请刷新页面', 409, 'TRIAL_UNAVAILABLE');
      }
      finishCallAttempt(conversation, 'succeeded');
    });
    return conversationView(q.get('SELECT * FROM tester_conversations WHERE id=?', conversation.id));
  } catch (error) {
    const publicCode = error?.code && /^[A-Z0-9_]+$/i.test(error.code) ? error.code : 'PROVIDER_FAILED';
    if (Array.isArray(error?.supplierCosts) || error?.providerUsage) saveCallEvidence(conversation, error);
    finishCallAttempt(conversation, 'failed', publicCode);
    q.run("UPDATE tester_conversations SET status='failed',error_code=?,completed_at=?,lease_expires=0 WHERE id=? AND attempts=? AND status='running'", publicCode, now(), conversation.id, conversation.attempts);
    if (error?.status && ['TESTER_INACTIVE', 'TRIAL_UNAVAILABLE', 'REQUEST_INTERRUPTED'].includes(error.code)) throw error;
    throw testerError('本次生成未完成，不消耗体验次数；请稍后重试，或请邀请人检查所绑定供应商的 Key余额与模型配置', 502, publicCode);
  }
}
export function testerChat(actor, input, options = {}) {
  requireActiveTester(actor.id);
  return runConversation({ ownerUserId: Number(actor.id), input,
    stillAllowed: () => requireActiveTester(actor.id), ...options });
}
export async function trialChat(token, accessToken, input, options = {}) {
  const { lead, invitation } = authenticateTrial(token, accessToken);
  const stillAllowed = () => {
    const current = authenticateTrial(token, accessToken).lead;
    if (current.status !== 'approved') throw testerError('请等待邀请人审核，或联系邀请人重新开通', 403, 'TRIAL_UNAVAILABLE');
  };
  const conversation = await runConversation({ ownerUserId: lead.owner_user_id, leadId: lead.id, input, stillAllowed, ...options, provider: invitation.provider || '360' });
  return { conversation, lead: leadView(q.get('SELECT * FROM tester_leads WHERE id=?', lead.id)) };
}

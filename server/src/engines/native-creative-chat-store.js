import crypto from 'node:crypto';
import { q, curTenant } from '../db.js';

export const nativeChatHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const nativeChatJson = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
export const nativeChatError = (message, status = 409, code = 'NATIVE_CHAT_CONFLICT') => Object.assign(new Error(message), { status, code });

export function nativeChatSession(actor, id) {
  const row = q.get('SELECT * FROM native_chat_sessions WHERE tenant_id=? AND user_id=? AND id=?', curTenant(), actor.id, Number(id));
  if (!row || Number(actor.tenant_id) !== Number(curTenant())) throw nativeChatError('对话不存在或无权访问', 404);
  return row;
}

export function settledNativeChatMessage({ actor, sessionId, messageId }) {
  const session = nativeChatSession(actor, sessionId);
  const message = q.get("SELECT * FROM native_chat_messages WHERE tenant_id=? AND user_id=? AND session_id=? AND id=? AND role='assistant'", curTenant(), actor.id, session.id, Number(messageId));
  const result = nativeChatJson(message?.result_json), billing = nativeChatJson(message?.billing_json);
  const hold = q.get("SELECT * FROM credit_holds WHERE tenant_id=? AND user_id=? AND id=? AND ref_type='native_chat_message' AND ref_id=?", curTenant(), actor.id, Number(billing.holdId) || 0, Number(messageId));
  const ledger = hold && q.get('SELECT * FROM credit_logs WHERE tenant_id=? AND user_id=? AND id=?', curTenant(), actor.id, hold.log_id);
  if (result.mode !== 'api' || hold?.status !== 'settled' || billing.state !== 'settled'
    || hold.kind !== 'text' || ledger?.kind !== 'text' || ledger?.ai_mode !== 'api' || !(Number(ledger.credits) > 0)
    || Number(ledger.credits) !== Number(hold.settled_credits) || !(Number(ledger.input_tokens) + Number(ledger.output_tokens) > 0)
    || Number(ledger.input_tokens) !== Number(result.usage?.inputTokens) || Number(ledger.output_tokens) !== Number(result.usage?.outputTokens)
    || String(ledger.model).toLowerCase() !== String(result.model).toLowerCase()
    || String(hold.model).toLowerCase() !== String(result.model).toLowerCase()) throw nativeChatError('方案或真实文字费用尚未核验，请先保留当前稿件');
  return { message, result, billing };
}

// Media engines accept a database-backed approval, never a client-supplied script
// or a caller's assertion that the preceding model call has been paid.
export function approvedNativeChatPlan({ actor, sessionId, planVersion, employeeIdx }) {
  const session = nativeChatSession(actor, sessionId);
  const row = q.get('SELECT * FROM native_chat_plans WHERE tenant_id=? AND user_id=? AND session_id=? AND version=?', curTenant(), actor.id, session.id, Number(planVersion));
  if (session.employee_idx !== Number(employeeIdx) || !row || row.state !== 'confirmed') throw nativeChatError('请先确认本次对话的有效方案');
  const plan = nativeChatJson(row.plan_json);
  if (!plan.ready || nativeChatHash(plan) !== row.plan_hash) throw nativeChatError('方案或真实文字费用尚未核验，请先保留当前稿件');
  const { billing } = settledNativeChatMessage({ actor, sessionId: session.id, messageId: row.message_id });
  return { plan, outputHash: nativeChatHash(plan.output || plan.script), messageId: row.message_id, billing,
    provenance: { tenantId: curTenant(), userId: actor.id, sessionId: session.id, planVersion: row.version, messageId: row.message_id, planHash: row.plan_hash, outputHash: nativeChatHash(plan.output || plan.script) } };
}

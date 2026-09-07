import { q } from '../db.js';

export const testerMoney = value => Math.round(value * 1e12) / 1e12;
export function testerReceipts(value) {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
export function validTesterReceipt(cost) {
  const source = cost?.costSource;
  if (cost?.status !== 'known' || source?.basis !== 'upstream_debit'
    || typeof source.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(source.requestId)
    || !Number.isFinite(cost.costYuanOverride) || cost.costYuanOverride < 0) return false;
  if (source.provider === '360') return source.currency === 'CNY' && source.exchangeRate === 1 && source.amount === cost.costYuanOverride;
  return source.provider === 'openlux' && source.type === 'provider_receipt' && source.currency === 'USD'
    && Number.isSafeInteger(source.quota) && source.quota >= 0
    && Number.isSafeInteger(source.quotaPerUnit) && source.quotaPerUnit > 0 && source.quotaPerUnit <= 1e12
    && Number.isFinite(source.amount) && source.amount >= 0 && Math.abs(source.amount - source.quota / source.quotaPerUnit) <= 1e-12
    && Number.isFinite(source.exchangeRate) && source.exchangeRate >= 0.01 && source.exchangeRate <= 1000
    && source.exchangeRateSource === 'https://api.openlux.ai/api/status' && Number.isFinite(Date.parse(source.statusRetrievedAt))
    && Math.abs(cost.costYuanOverride - source.amount * source.exchangeRate) <= Math.max(1e-9, cost.costYuanOverride * 1e-9);
}

// Rows must be in observation order. A debit belongs to its first observed
// receipt, including failures; a conflicting replay makes that amount unknown.
export function testerCostEvidence(rows) {
  const byCall = new Map(); const seen = new Map();
  for (const row of rows) {
    const receipts = testerReceipts(row.supplier_costs_json);
    const provider = row.provider || '360';
    const known = receipts.filter(receipt => validTesterReceipt(receipt) && receipt.costSource.provider === provider);
    const cost = { knownCostCny: 0, knownReceiptCount: 0,
      unverified: row.cost_status !== 'verified' || !known.length || known.length !== receipts.length };
    byCall.set(row.id, cost);
    for (const receipt of known) {
      const key = `${row.owner_user_id}:${provider}:${receipt.costSource.requestId}`;
      const previous = seen.get(key);
      if (previous) {
        if (previous.conflict || previous.amount !== receipt.costYuanOverride) {
          cost.unverified = true;
          if (!previous.conflict) {
            const original = byCall.get(previous.callId);
            original.knownCostCny = testerMoney(original.knownCostCny - previous.amount);
            original.knownReceiptCount--;
            original.unverified = true;
            previous.conflict = true;
          }
        }
      } else {
        seen.set(key, { amount: receipt.costYuanOverride, callId: row.id, conflict: false });
        cost.knownCostCny = testerMoney(cost.knownCostCny + receipt.costYuanOverride);
        cost.knownReceiptCount++;
      }
    }
  }
  return byCall;
}

export function testerEvidenceTotals(rows, byCall = testerCostEvidence(rows)) {
  let knownCostCny = 0; let knownReceiptCount = 0; let unverifiedCostCount = 0;
  for (const row of rows) {
    const cost = byCall.get(row.id);
    knownCostCny = testerMoney(knownCostCny + cost.knownCostCny);
    knownReceiptCount += cost.knownReceiptCount;
    if (cost.unverified) unverifiedCostCount++;
  }
  return { supplierCostCny: knownReceiptCount || !unverifiedCostCount ? knownCostCny : null, unverifiedCostCount };
}

// Read-only compatibility for pre-ledger conversations; no invented attempts.
export function loadTesterCallEvidence(ownerUserId = null) {
  const scope = ownerUserId === null ? '' : ' AND c.owner_user_id=?';
  const args = ownerUserId === null ? [] : [ownerUserId];
  const epoch = expression => `CASE WHEN instr(${expression},'T')>0 OR ${expression} LIKE '%Z'
    THEN unixepoch(${expression}) ELSE unixepoch(${expression},'utc') END`;
  const rows = q.all(`SELECT 'attempt-'||a.id id,a.conversation_id,a.status,a.model,a.cost_status,a.provider,
    a.supplier_cost_cny,a.supplier_costs_json,c.owner_user_id,c.lead_id,c.employee_id,
    ${epoch('a.created_at')} event_at FROM tester_call_attempts a
    JOIN tester_conversations c ON c.id=a.conversation_id WHERE 1=1${scope}`, ...args);
  rows.push(...q.all(`SELECT 'legacy-'||c.id id,c.id conversation_id,c.status,c.model,c.cost_status,c.provider,
    c.supplier_cost_cny,c.supplier_costs_json,c.owner_user_id,c.lead_id,c.employee_id,
    ${epoch('c.created_at')} event_at,1 legacy_record FROM tester_conversations c
    WHERE NOT EXISTS(SELECT 1 FROM tester_call_attempts a WHERE a.conversation_id=c.id)${scope}`, ...args));
  return rows.sort((a, b) => a.event_at - b.event_at || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

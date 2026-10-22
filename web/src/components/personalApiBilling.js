export const PERSONAL_API_PRICING_NOTE = '使用你填写的 API Key，费用由所选供应商账户扣除，金额以实际调用为准。';

export const isPersonalApiUser = user => user?.accountType === 'tester';

// This copy never converts platform credits into a personal supplier price.
// Only an explicit recorded supplier amount can be displayed as money.
export function personalApiBillingLabel(billing = {}) {
  const state = String(billing?.state || billing?.status || '');
  if (['pending_reconciliation', 'pending', 'unknown'].includes(state)) return '个人API计费 · 费用待核对';
  const amount = [billing?.supplierCostCny, billing?.costYuan].find(value => typeof value === 'number' && Number.isFinite(value) && value > 0);
  if (amount !== undefined) return `个人API计费 · 供应商费用 ¥${amount.toFixed(4)}`;
  if (['released', 'refunded', 'failed', 'cancelled'].includes(state)) return '个人API计费 · 上游费用以供应商账单为准';
  if (state === 'held') return '个人API调用中 · 由供应商账户扣费';
  return '个人API计费 · 由供应商账户扣费';
}

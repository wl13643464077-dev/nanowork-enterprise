// Charge from the upstream wallet's actual per-request debit, not the price
// paid to recharge that wallet. Its public status supplies the quota unit and
// CNY display conversion; neither value is inferred from a purchase discount.
import { getConfig } from '../db.js';
import { selectedProviderId, providerForModel } from './ai-provider-selection.js';
import { is360Base, valid360Receipt } from './provider-360-cost.js';

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const OPENLUX_ORIGIN = 'https://api.openlux.ai';
const STATUS_URL = `${OPENLUX_ORIGIN}/api/status`;
const statusCache = new WeakMap();
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const OPENLUX_COST_CONFIG = 'supplier_cost_openlux';

export function validateSupplierCostConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean')
    throw new Error('请明确是否启用上游实际扣费计价');
  if (value.basis !== undefined && value.basis !== 'upstream_debit') throw new Error('仅支持按上游钱包实际扣费计价');
  // Old recharge fields are deliberately not copied or used as an exchange rate.
  return { enabled: value.enabled, basis: 'upstream_debit' };
}

// Before initSchema() (first boot, isolated workers) there is no sys_config
// table: that means "not configured", never a crash inside cost reading.
function storedCostConfig() {
  try { return getConfig(OPENLUX_COST_CONFIG, null); }
  catch (error) {
    if (/no such table:\s*(?:main\.)?sys_config$/iu.test(String(error?.message || ''))) return null;
    throw error;
  }
}

export function supplierCostSettings() {
  if (provider360CostApplies()) return { enabled: true, basis: 'upstream_debit', ready: true, provider: '360', locked: true, currency: 'CNY' };
  const config = storedCostConfig();
  if (!config?.enabled) return { enabled: false, basis: 'upstream_debit', ready: false };
  try { return { ...validateSupplierCostConfig(config), ready: true }; }
  catch { return { enabled: true, ready: false }; }
}

export function openLuxCostApplies(model) {
  if (String(model || '').toLowerCase() === 'minimax-h3') return false;
  return (providerForModel(model) || selectedProviderId()) === 'openlux' && supplierCostSettings().enabled === true;
}

export function provider360CostApplies() {
  return selectedProviderId() === '360';
}

export function upstreamDebitCostApplies(model) {
  return provider360CostApplies() || openLuxCostApplies(model);
}

function locateQuotaReceipt(rows, { requestId, model, quotaPerUnit }) {
  if (!Array.isArray(rows) || !REQUEST_ID.test(String(requestId || '')) || !model ||
    !Number.isSafeInteger(quotaPerUnit) || quotaPerUnit < 1 || quotaPerUnit > 1e12) return { state: 'invalid' };
  const matches = rows.flatMap(row => {
    if (!row || typeof row !== 'object' || row.model_name !== model) return [];
    let other = row.other;
    let invalid = false;
    if (typeof other === 'string') { try { other = JSON.parse(other); } catch { invalid = true; other = null; } }
    const nestedId = other?.request_id;
    const directId = row.request_id;
    if (nestedId !== requestId && directId !== requestId) return [];
    if (nestedId && directId && nestedId !== directId) invalid = true;
    if ((row.currency !== undefined && row.currency !== 'USD') ||
      (other?.currency !== undefined && other.currency !== 'USD')) invalid = true;
    return [{ row, invalid }];
  });
  if (!matches.length) return { state: 'missing' };
  if (matches.some(match => match.invalid)) return { state: 'invalid' };
  // 异步视频任务（如 Seedance）先按预估“预扣”，完成后再记一条“多退少补”：
  // 补扣为 type 2 正数，退回为 type 6 负数。只认恰好一条主扣费，外加明确标注
  // 多退少补的调整行，净额才是真实成本；其他重复/退款仍保持待核。
  const adjustment = row => /多退少补/u.test(String(row.content || ''));
  const primary = matches.filter(({ row }) => row.type === 2 && !adjustment(row));
  const adjustments = matches.filter(({ row }) => adjustment(row));
  if (primary.length !== 1 || primary.length + adjustments.length !== matches.length) return { state: 'invalid' };
  const main = primary[0].row;
  if (!Number.isSafeInteger(main.quota) || main.quota < 0) return { state: 'invalid' };
  let quota = main.quota;
  for (const { row } of adjustments) {
    if (!Number.isSafeInteger(row.quota)) return { state: 'invalid' };
    if (row.type === 2 && row.quota >= 0) quota += row.quota;
    else if (row.type === 6) quota -= Math.abs(row.quota);
    else return { state: 'invalid' };
  }
  if (!Number.isSafeInteger(quota) || quota < 0) return { state: 'invalid' };
  const usd = quota / quotaPerUnit;
  if (!Number.isFinite(usd) || usd > 1e8) return { state: 'invalid' };
  return { state: 'known', receipt: { requestId, model, quota, usd, ...(adjustments.length ? { adjustedRows: adjustments.length } : {}) } };
}

export function matchingQuotaReceipt(rows, options) {
  return locateQuotaReceipt(rows, options).receipt || null;
}

async function fetchOpenLuxJson(endpoint, fetchFn) {
  try {
    const response = await fetchFn(endpoint, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (response.status !== 200 || response.redirected ||
      (response.url && new URL(response.url).origin !== OPENLUX_ORIGIN)) return null;
    const body = await response.json();
    return body?.success === true ? body.data : null;
  } catch { return null; } // Never log errors: the log endpoint URL contains the key.
}

async function openLuxStatus(fetchFn, cacheTtlMs) {
  const cached = statusCache.get(fetchFn);
  if (cacheTtlMs > 0 && cached?.expiresAt > Date.now()) return cached.value;
  const data = await fetchOpenLuxJson(new URL(STATUS_URL), fetchFn);
  const quotaPerUnit = data?.quota_per_unit;
  const exchangeRate = data?.usd_exchange_rate;
  // currency_type controls display, not the wallet unit. USD and CNY both use
  // USD-backed quota; custom currencies must be verified by a separate adapter.
  if (!Number.isSafeInteger(quotaPerUnit) || quotaPerUnit < 1 || quotaPerUnit > 1e12 ||
    typeof exchangeRate !== 'number' || !Number.isFinite(exchangeRate) || exchangeRate < 0.01 || exchangeRate > 1000 ||
    !['USD', 'CNY'].includes(data?.currency_type)) return null;
  const value = { quotaPerUnit, exchangeRate, displayCurrency: data.currency_type, retrievedAt: new Date().toISOString() };
  if (cacheTtlMs > 0) statusCache.set(fetchFn, { value, expiresAt: Date.now() + cacheTtlMs });
  return value;
}

export async function readOpenLuxCost({ requestId, model, baseUrl, apiKey, settings = supplierCostSettings(),
  fetchFn = globalThis.fetch, sleepFn = defaultSleep, retryDelaysMs = [250, 750], statusCacheTtlMs = 60000 }) {
  if (!settings?.enabled) return null;
  const pending = { status: 'pending', requestId: REQUEST_ID.test(String(requestId || '')) ? requestId : null, model };
  if (settings.ready === false || !pending.requestId || typeof model !== 'string' || !model.trim() ||
    typeof apiKey !== 'string' || !apiKey.trim()) return pending;
  let endpoint;
  try {
    validateSupplierCostConfig(settings);
    const base = new URL(baseUrl);
    if (base.origin !== OPENLUX_ORIGIN || base.username || base.password) return pending;
    endpoint = new URL('/api/log/token', OPENLUX_ORIGIN);
    endpoint.searchParams.set('key', apiKey);
  } catch { return pending; }
  const cacheTtlMs = typeof statusCacheTtlMs === 'number' && Number.isFinite(statusCacheTtlMs)
    ? Math.max(0, Math.min(statusCacheTtlMs, 300000)) : 60000;
  const status = await openLuxStatus(fetchFn, cacheTtlMs);
  if (!status) return pending;
  const delays = Array.isArray(retryDelaysMs)
    ? retryDelaysMs.slice(0, 2).filter(ms => Number.isFinite(ms) && ms >= 0 && ms <= 2000) : [];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      try { await sleepFn(delays[attempt - 1]); } catch { return pending; }
    }
    const data = await fetchOpenLuxJson(endpoint, fetchFn);
    const rows = Array.isArray(data) ? data : data?.items;
    if (!Array.isArray(rows)) continue;
    const match = locateQuotaReceipt(rows, { requestId, model, quotaPerUnit: status.quotaPerUnit });
    if (match.state === 'invalid') return pending;
    if (match.state !== 'known') continue;
    const receipt = match.receipt;
    return { status: 'known', requestId, model,
      costYuanOverride: receipt.usd * status.exchangeRate,
      costSource: { type: 'provider_receipt', provider: 'openlux', basis: 'upstream_debit', requestId, currency: 'USD',
        amount: receipt.usd, exchangeRate: status.exchangeRate, quota: receipt.quota, quotaPerUnit: status.quotaPerUnit,
        exchangeRateSource: STATUS_URL, statusRetrievedAt: status.retrievedAt, statusDisplayCurrency: status.displayCurrency } };
  }
  return pending;
}

export function aggregateSupplierCosts(costs) {
  if (!Array.isArray(costs) || !costs.length) return null;
  if (costs.some(cost => cost?.status !== 'known' || !Number.isFinite(cost.costYuanOverride) || cost.costYuanOverride < 0)) return { status: 'pending' };
  const sources = costs.map(cost => cost.costSource);
  const first = sources[0];
  if (!first || sources.some((source, index) => !source || source.provider !== first.provider || source.basis !== first.basis ||
    !REQUEST_ID.test(String(source.requestId || '')) || !Number.isFinite(source.amount) || source.amount < 0 ||
    !Number.isFinite(source.exchangeRate) || source.exchangeRate <= 0 ||
    Math.abs(costs[index].costYuanOverride - source.amount * source.exchangeRate) > Math.max(1e-9, costs[index].costYuanOverride * 1e-9))
    || new Set(sources.map(source => source.requestId)).size !== costs.length) return { status: 'pending' };
  const totalYuan = costs.reduce((sum, cost) => sum + cost.costYuanOverride, 0);
  if (!Number.isFinite(totalYuan)) return { status: 'pending' };
  if (first.basis === 'upstream_debit') {
    if (first.provider === '360') {
      if (!sources.every(valid360Receipt)) return { status: 'pending' };
      return { status: 'known', costYuanOverride: totalYuan, costSource: {
        type: 'provider_receipt', provider: '360', basis: 'upstream_debit', currency: 'CNY',
        amount: totalYuan, exchangeRate: 1, requestIds: sources.map(source => source.requestId),
        receipts: sources.map(source => ({ ...source })),
      } };
    }
    if (sources.some(source => source.type !== 'provider_receipt' || source.provider !== 'openlux' || source.currency !== 'USD' ||
      !Number.isSafeInteger(source.quota) || source.quota < 0 || !Number.isSafeInteger(source.quotaPerUnit) ||
      source.quotaPerUnit < 1 || source.quotaPerUnit > 1e12 ||
      Math.abs(source.amount - source.quota / source.quotaPerUnit) > 1e-12 || source.exchangeRateSource !== STATUS_URL ||
      !Number.isFinite(Date.parse(source.statusRetrievedAt)))) return { status: 'pending' };
    // Every call keeps its own verified conversion. A long job may span a
    // provider rate change; sum those CNY amounts instead of inventing one rate.
    return { status: 'known', costYuanOverride: totalYuan, costSource: {
      type: 'provider_receipt', provider: 'openlux', basis: 'upstream_debit', currency: 'CNY', amount: totalYuan, exchangeRate: 1,
      requestIds: sources.map(source => source.requestId), receipts: sources.map(source => ({ ...source })),
    } };
  }
  if (sources.some(source => source.currency !== first.currency || source.exchangeRate !== first.exchangeRate)) return { status: 'pending' };
  const amount = sources.reduce((sum, source) => sum + source.amount, 0);
  if (!Number.isFinite(amount)) return { status: 'pending' };
  return { status: 'known', costYuanOverride: totalYuan,
    costSource: { ...first, requestId: undefined, requestIds: sources.map(source => source.requestId), amount } };
}

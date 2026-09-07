import { createHash } from 'node:crypto';

export const PROVIDER_360_ORIGIN = 'https://api.360.cn';
export const PROVIDER_360_AMOUNT_FIELD = 'usage.amount';
const RAW_ID = /^[A-Za-z0-9._:^|/-]{1,500}$/;
const MONEY = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,12})?$/;
// 360's verified Wan response includes its downstream qwen routing namespace.
const RESPONSE_MODEL_ALIASES = { 'alibaba/wan3.0-video': ['alibaba/qwen/wan3.0-video'] };
function receiptModelMatches(requested, actual) {
  return typeof actual === 'string' && [requested, ...(RESPONSE_MODEL_ALIASES[requested] || [])]
    .some(model => actual === model || actual.endsWith(`/${model}`));
}

export function is360Base(base) {
  try {
    const url = new URL(base);
    return url.origin === PROVIDER_360_ORIGIN && !url.username && !url.password;
  } catch { return false; }
}

export function normalize360ReceiptId(rawId) {
  if (typeof rawId !== 'string' || !RAW_ID.test(rawId)) return null;
  return `360-${createHash('sha256').update(rawId).digest('hex')}`;
}

function amountValue(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw);
  if (!MONEY.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value < 1e8 ? value : null;
}

// 360 returns the billed RMB amount in usage.amount. Preserve that response
// field and its original request ID; token price estimates never become receipts.
export function read360Cost({ response, requestId, model, baseUrl = `${PROVIDER_360_ORIGIN}/v1` } = {}) {
  const rawId = response?.id || response?.data?.id || requestId;
  const id = normalize360ReceiptId(rawId);
  const pending = { status: 'pending', requestId: id, model, provider: '360' };
  if (!is360Base(baseUrl) || !response || response.error || !id || typeof model !== 'string' || !model) return pending;
  const actualModel = response.model || response.data?.model || model;
  if (!receiptModelMatches(model, actualModel)) return pending;
  const usage = response.usage || response.data?.usage;
  const amount = amountValue(usage?.amount);
  if (amount === null || (usage.currency !== undefined && usage.currency !== 'CNY')) return pending;
  return {
    status: 'known', requestId: id, model, costYuanOverride: amount,
    costSource: {
      type: 'provider_receipt', provider: '360', basis: 'upstream_debit',
      requestId: id, currency: 'CNY', amount, exchangeRate: 1,
      rawRequestId: rawId, model, actualModel,
      amountField: PROVIDER_360_AMOUNT_FIELD, reportedAmount: String(usage.amount),
      responseOrigin: PROVIDER_360_ORIGIN,
    },
  };
}

export function valid360Receipt(source) {
  return source?.type === 'provider_receipt' && source.provider === '360'
    && source.basis === 'upstream_debit' && source.currency === 'CNY' && source.exchangeRate === 1
    && source.amountField === PROVIDER_360_AMOUNT_FIELD && source.responseOrigin === PROVIDER_360_ORIGIN
    && source.requestId === normalize360ReceiptId(source.rawRequestId)
    && typeof source.model === 'string' && source.model.length > 0
    && typeof source.actualModel === 'string'
    && receiptModelMatches(source.model, source.actualModel)
    && amountValue(source.reportedAmount) !== null
    && amountValue(source.reportedAmount) === source.amount;
}

// Only reservation estimates. Settlement always requires usage.amount.
// Official CNY rates retrieved 2026-09-06 from ai.360.com/open/zh/models.
export const PROVIDER_360_RESERVATION_RATES = Object.freeze({
  text: {
    'deepseek/deepseek-v4-flash': { in: 3, out: 9 },
    'deepseek/deepseek-v4-pro': { in: 9, out: 27 },
    'deepseek/deepseek-v4-flash-vision-exp': { in: 3, out: 9 },
    'qwen/qwen3.8-flash': { in: 1, out: 3 },
    'qwen/qwen3.8-max': { in: 12, out: 36 },
    default: { in: 12, out: 36 },
  },
  // Image2 currently needs explicit authorization. This is a reserve limit,
  // not an advertised supplier unit price or an alternative settlement basis.
  image: { 'openai/gpt-image-2': 2, default: 2 },
  // Live 360 receipt: 15s / 720P / native audio billed CNY 9.
  // The public "from 0.3/s" price is not this output configuration's price.
  video: { 'alibaba/wan3.0-video': 9, default: 9 },
  tts: { default: 0 },
});

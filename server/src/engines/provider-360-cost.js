import { createHash } from 'node:crypto';

export const PROVIDER_360_ORIGIN = 'https://api.360.cn';
export const PROVIDER_360_AMOUNT_FIELD = 'usage.amount';
const RAW_ID = /^[A-Za-z0-9._:^|/-]{1,500}$/;
const MONEY = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,12})?$/;
const IMAGE_RESPONSE_IDENTITY_VERSION = '360-image-response.v1';
const IMAGE_RESPONSE_IDENTITY_BASIS = 'created+actual_model+ordered_output_url_digests';
const RESPONSE_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const RESPONSE_OUTPUT_DIGEST = /^\d+:url-sha256:[a-f0-9]{64}$/;
const DERIVED_RESPONSE_ID = /^360-response-[a-f0-9]{64}$/;
const IMAGE_MODELS_WITH_RESPONSE_IDENTITY = new Set(['openai/gpt-image-2']);
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validCreated(value) {
  return Number.isSafeInteger(value) && value > 0 && value < 1e12;
}

function outputUrlDigest(value, index) {
  if (typeof value !== 'string' || !value || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
  } catch { return null; }
  return `${index}:url-sha256:${sha256(value)}`;
}

function responseFingerprint({ created, actualModel, outputDigests }) {
  if (!validCreated(created) || typeof actualModel !== 'string' || !actualModel
    || !Array.isArray(outputDigests) || outputDigests.length < 1 || outputDigests.length > 12
    || outputDigests.some((value, index) => !RESPONSE_OUTPUT_DIGEST.test(value) || !value.startsWith(`${index}:`))) return null;
  const material = JSON.stringify({
    version: IMAGE_RESPONSE_IDENTITY_VERSION,
    created,
    actualModel,
    outputDigests,
  });
  return sha256(material);
}

// Some successful 360 Image2 responses have no response/header request ID.
// In that narrow case, derive a stable response identity from non-secret,
// provider-returned fields. This is explicitly not an upstream request ID.
function imageResponseIdentity(response, requestedModel, actualModel) {
  if (!IMAGE_MODELS_WITH_RESPONSE_IDENTITY.has(requestedModel) || !Array.isArray(response?.data)
    || response.data.length < 1 || response.data.length > 12) return null;
  const outputDigests = response.data.map((item, index) => outputUrlDigest(item?.url, index));
  if (outputDigests.some(value => !value)) return null;
  const fingerprint = responseFingerprint({ created: response.created, actualModel, outputDigests });
  if (!fingerprint) return null;
  return {
    requestId: `360-response-${fingerprint}`,
    identityType: 'response_fingerprint',
    identityVersion: IMAGE_RESPONSE_IDENTITY_VERSION,
    identityBasis: IMAGE_RESPONSE_IDENTITY_BASIS,
    responseFingerprint: `sha256:${fingerprint}`,
    responseCreated: response.created,
    responseOutputCount: response.data.length,
    responseOutputDigests: outputDigests,
  };
}

function amountValue(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw);
  if (!MONEY.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value < 1e8 ? value : null;
}

// 360 returns the billed RMB amount in usage.amount. Preserve that response
// field and either its upstream request ID or an explicitly labelled Image2
// response fingerprint; token price estimates never become receipts.
export function read360Cost({ response, requestId, model, baseUrl = `${PROVIDER_360_ORIGIN}/v1` } = {}) {
  const rawId = response?.id ?? response?.data?.id ?? requestId;
  const normalizedRawId = rawId === null || rawId === undefined ? null : normalize360ReceiptId(rawId);
  const pending = { status: 'pending', requestId: normalizedRawId, model, provider: '360' };
  if (!is360Base(baseUrl) || !response || response.error || typeof model !== 'string' || !model) return pending;
  const reportedModel = response.model || response.data?.model;
  const actualModel = reportedModel || model;
  if (!receiptModelMatches(model, actualModel)) return pending;
  // If the provider supplied an authoritative identifier, malformed values
  // remain pending instead of falling through to a derived identity.
  if (rawId !== null && rawId !== undefined && !normalizedRawId) return pending;
  const derivedIdentity = normalizedRawId || !reportedModel ? null : imageResponseIdentity(response, model, actualModel);
  const id = normalizedRawId || derivedIdentity?.requestId;
  if (!id) return pending;
  const usage = response.usage || response.data?.usage;
  const amount = amountValue(usage?.amount);
  if (amount === null || (usage.currency !== undefined && usage.currency !== 'CNY')) return pending;
  return {
    status: 'known', requestId: id, model, costYuanOverride: amount,
    costSource: {
      type: 'provider_receipt', provider: '360', basis: 'upstream_debit',
      requestId: id, currency: 'CNY', amount, exchangeRate: 1,
      rawRequestId: normalizedRawId ? rawId : null,
      identityType: normalizedRawId ? 'upstream_request_id' : derivedIdentity.identityType,
      ...(derivedIdentity || {}),
      model, actualModel,
      amountField: PROVIDER_360_AMOUNT_FIELD, reportedAmount: String(usage.amount),
      responseOrigin: PROVIDER_360_ORIGIN,
    },
  };
}

export function valid360Receipt(source) {
  const common = source?.type === 'provider_receipt' && source.provider === '360'
    && source.basis === 'upstream_debit' && source.currency === 'CNY' && source.exchangeRate === 1
    && source.amountField === PROVIDER_360_AMOUNT_FIELD && source.responseOrigin === PROVIDER_360_ORIGIN
    && typeof source.model === 'string' && source.model.length > 0
    && typeof source.actualModel === 'string'
    && receiptModelMatches(source.model, source.actualModel)
    && amountValue(source.reportedAmount) !== null
    && amountValue(source.reportedAmount) === source.amount;
  if (!common) return false;
  if (source.identityType === 'response_fingerprint') {
    if (source.rawRequestId !== null || source.identityVersion !== IMAGE_RESPONSE_IDENTITY_VERSION
      || source.identityBasis !== IMAGE_RESPONSE_IDENTITY_BASIS
      || !IMAGE_MODELS_WITH_RESPONSE_IDENTITY.has(source.model)
      || !validCreated(source.responseCreated)
      || !Number.isSafeInteger(source.responseOutputCount)
      || source.responseOutputCount !== source.responseOutputDigests?.length
      || !RESPONSE_FINGERPRINT.test(source.responseFingerprint || '')) return false;
    const fingerprint = responseFingerprint({
      created: source.responseCreated,
      actualModel: source.actualModel,
      outputDigests: source.responseOutputDigests,
    });
    return Boolean(fingerprint)
      && source.responseFingerprint === `sha256:${fingerprint}`
      && DERIVED_RESPONSE_ID.test(source.requestId || '')
      && source.requestId === `360-response-${fingerprint}`;
  }
  // identityType is optional for receipts persisted before this distinction.
  return (source.identityType === undefined || source.identityType === 'upstream_request_id')
    && source.requestId === normalize360ReceiptId(source.rawRequestId);
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
  // The image directory may omit Image2. This is a reserve limit,
  // not an advertised supplier unit price or an alternative settlement basis.
  image: { 'openai/gpt-image-2': 2, default: 2 },
  // Live 360 receipt: 15s / 720P / native audio billed CNY 9.
  // The public "from 0.3/s" price is not this output configuration's price.
  video: { 'alibaba/wan3.0-video': 9, default: 9 },
  tts: { default: 0 },
});

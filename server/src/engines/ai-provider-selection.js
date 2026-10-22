import { AsyncLocalStorage } from 'node:async_hooks';
import { getConfig, curTenant } from '../db.js';
import { providerContext, runWithTesterIdentity } from './tester-provider-context.js';
import { testerExecutionIdentity, testerExecutionCredentials } from './tester-access.js';

const platformContext = new AsyncLocalStorage();
const definitions = Object.freeze({
  openlux: Object.freeze({ id: 'openlux', name: 'OpenLux', baseUrl: 'https://api.openlux.ai/v1' }),
  '360': Object.freeze({ id: '360', name: '360 智脑', baseUrl: 'https://api.360.cn/v1' }),
});
const knownId = value => Object.hasOwn(definitions, value) ? value : null;
const clean = value => String(value || '').trim().replace(/^(['"])(.*)\1$/, '$2');
function config(key, fallback = null) {
  try { return getConfig(key, fallback); }
  catch (error) {
    if (/no such table:\s*(?:main\.)?sys_config$/iu.test(String(error?.message || ''))) return fallback;
    throw error;
  }
}
function origin(value) { try { return new URL(value).origin; } catch { return ''; } }
function legacyBase() { return clean(process.env.YUNWU_BASE_URL) || clean(config('yunwu_base_url')); }
function legacyProvider() {
  const explicit = knownId(process.env.NANOWORK_AI_PROVIDER);
  if (explicit) return explicit;
  const base = origin(legacyBase());
  if (base === 'https://api.360.cn') return '360';
  if (base === 'https://api.openlux.ai') return 'openlux';
  // Retain isolated legacy installs/tests. Public selection only exposes the two definitions.
  return 'yunwu';
}

export function selectedProviderId(tenantId) {
  const personal = providerContext();
  if (personal) return personal.provider;
  const tester = testerExecutionIdentity({ tenantId, requireActive: false });
  if (tester) return tester.provider;
  return platformContext.getStore()?.providerId
    || knownId(config(`ai_provider_tenant_${Number(tenantId ?? curTenant())}`))
    || knownId(config('ai_provider_default')) || legacyProvider();
}
export function platformDefaultProviderId() { return knownId(config('ai_provider_default')) || legacyProvider(); }
export function providerDefinition(id) {
  if (definitions[id]) return definitions[id];
  if (id === 'yunwu') return { id: 'yunwu', name: '兼容通道', baseUrl: legacyBase() || 'https://yunwu.ai/v1' };
  throw Object.assign(new Error('不支持的 AI 供应商'), { status: 400, code: 'AI_PROVIDER_INVALID' });
}
export function withPlatformProvider(providerId, action) {
  providerDefinition(providerId);
  return platformContext.run(Object.freeze({ providerId, billingMode: 'platform' }), action);
}
function platformCredentials(providerId) {
  const definition = providerDefinition(providerId);
  const environmentMatches = origin(clean(process.env.YUNWU_BASE_URL)) === origin(definition.baseUrl);
  const storedMatches = origin(clean(config('yunwu_base_url'))) === origin(definition.baseUrl);
  const keyName = providerId === '360' ? 'AI360_API_KEY' : providerId === 'openlux' ? 'OPENLUX_API_KEY' : 'YUNWU_API_KEY';
  const direct = clean(process.env[keyName]);
  const oldEnvironmentKey = environmentMatches || providerId === 'yunwu' ? clean(process.env.YUNWU_API_KEY) : '';
  const oldStoredKey = storedMatches || providerId === 'yunwu' ? clean(config('yunwu_api_key')) : '';
  return { ...definition, apiKey: direct || oldEnvironmentKey || oldStoredKey,
    keySource: direct || oldEnvironmentKey ? 'environment' : oldStoredKey ? 'legacy_db' : 'none', billingMode: 'platform' };
}
export function selectedProviderCredentials() {
  const personal = providerContext();
  if (personal?.testerManaged) {
    const owned = testerExecutionCredentials({ userId: personal.ownerUserId, tenantId: personal.tenantId, provider: personal.provider,
      requireActive: personal.accountingOnly !== true });
    if (!owned) throw Object.assign(new Error('个人调用身份已失效'), { status: 403, code: 'TESTER_INACTIVE' });
    return { ...providerDefinition(owned.provider), apiKey: owned.apiKey, keySource: 'personal', billingMode: 'personal', ownerUserId: owned.ownerUserId };
  }
  if (!personal) {
    const owned = testerExecutionCredentials();
    if (owned) return { ...providerDefinition(owned.provider), apiKey: owned.apiKey, keySource: 'personal', billingMode: 'personal', ownerUserId: owned.ownerUserId };
    return platformCredentials(selectedProviderId());
  }
  const definition = providerDefinition(personal.provider);
  if (personal.baseUrl !== definition.baseUrl || !clean(personal.apiKey))
    throw Object.assign(new Error('请配置所选供应商的个人 API Key'), { status: 403, code: 'PERSONAL_KEY_REQUIRED' });
  return { ...definition, apiKey: personal.apiKey, keySource: 'personal', billingMode: 'personal', ownerUserId: personal.ownerUserId };
}
export function platformProviderAvailability() {
  return Object.keys(definitions).map(id => {
    const credentials = platformCredentials(id);
    return { ...definitions[id], label: definitions[id].name, available: Boolean(credentials.apiKey), configured: Boolean(credentials.apiKey), keySource: credentials.keySource };
  });
}

const provider360Models = new Set(['openai/gpt-image-2', 'alibaba/wan3.0-video', 'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro', 'qwen/qwen3.8-flash', 'qwen/qwen3.8-max']);
const openluxModels = new Set(['gpt-image-2', 'gpt-5.5', 'deepseek-v4-flash', 'gemini-3.1-flash-lite',
  'wan2.6-i2v', 'wan2.5-i2v-preview', 'MiniMax-Hailuo-2.3-Fast', 'MiniMax-Hailuo-2.3',
  'minimax-h3', 'happyhorse-1.0-t2v:floor', 'happyhorse-1.0-t2v:nitro', 'happyhorse-1.0-t2v:stable',
  'happyhorse-1.0-i2v', 'happyhorse-1.0-r2v', 'happyhorse-1.0-video-edit', 'veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview',
  'gpt-image-2.5-flare-c', 'doubao-seedance-2-5-260628', 'kling-video']);
export function providerForModel(model) {
  if (provider360Models.has(model)) return '360';
  if (openluxModels.has(model)) return 'openlux';
  return null;
}
export function taskProviderId({ providerId, provider, model } = {}) {
  const explicit = knownId(providerId || provider), inferred = providerForModel(model);
  if (explicit && inferred && explicit !== inferred)
    throw Object.assign(new Error('任务供应商与模型不一致，未向供应商发出请求'), { status: 409, code: 'TASK_PROVIDER_MISMATCH' });
  if (explicit || inferred) return explicit || inferred;
  throw Object.assign(new Error('任务缺少可核验的原供应商信息，请先核对历史任务'), { status: 409, code: 'TASK_PROVIDER_UNKNOWN' });
}
export function withTaskProvider(binding, action) { return taskProviderContext(binding, action); }
// Only receipt lookup uses this internal scope. It permits recording the cost
// of an already-issued call after Super pauses its owner; never a new job.
export function withTaskProviderCost(binding, action) { return taskProviderContext(binding, action, true); }
function taskProviderContext(binding, action, accountingOnly = false) {
  const context = providerContext();
  const tester = testerExecutionIdentity({
    ...(context?.testerManaged ? { userId: context.ownerUserId, tenantId: context.tenantId } : {}),
    requireActive: !accountingOnly,
  });
  if (tester) {
    const provider = taskProviderId(binding);
    return runWithTesterIdentity({ ...testerExecutionIdentity({ userId: tester.ownerUserId, tenantId: tester.tenantId, provider,
      requireActive: !accountingOnly }), ...(accountingOnly ? { accountingOnly: true } : {}) }, action);
  }
  if (binding?.providerId === 'yunwu' || binding?.provider === 'yunwu') {
    if (selectedProviderId() !== 'yunwu')
      throw Object.assign(new Error('旧兼容通道任务需先核对原供应商'), { status: 409, code: 'TASK_PROVIDER_UNKNOWN' });
    return withPlatformProvider('yunwu', action);
  }
  let providerId = taskProviderId(binding);
  const personal = providerContext();
  if (personal && personal.provider !== providerId)
    throw Object.assign(new Error('请切回此任务原供应商的个人 Key 后查询'), { status: 409, code: 'TASK_PERSONAL_PROVIDER_MISMATCH' });
  if (!binding?.providerId && !binding?.provider && providerId === 'openlux' && selectedProviderId() === 'yunwu') providerId = 'yunwu';
  return withPlatformProvider(providerId, action);
}

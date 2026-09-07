import { AsyncLocalStorage } from 'node:async_hooks';

const credentials = new AsyncLocalStorage();

export const providerContext = () => credentials.getStore() || null;

export function runWithProviderContext(context, action) {
  const bases = { '360': 'https://api.360.cn/v1', openlux: 'https://api.openlux.ai/v1' };
  if (!Object.hasOwn(bases, context?.provider || '') || context.baseUrl !== bases[context.provider]
    || typeof context?.apiKey !== 'string' || !context.apiKey.trim()
    || !Number.isSafeInteger(context.ownerUserId) || context.ownerUserId <= 0) {
    throw Object.assign(new Error('请先配置所选供应商的个人 API Key'), { status: 409, code: 'PERSONAL_KEY_REQUIRED' });
  }
  return credentials.run(Object.freeze({ ...context, billingMode: 'personal' }), action);
}

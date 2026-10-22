import { AsyncLocalStorage } from 'node:async_hooks';
import { testerExecutionIdentity } from './tester-access.js';
import { activeTenantId } from '../db.js';

const credentials = new AsyncLocalStorage();

export const providerContext = () => {
  const stored = credentials.getStore();
  const tenantId = activeTenantId();
  if (stored?.testerManaged && tenantId != null && Number(stored.tenantId) !== Number(tenantId))
    throw Object.assign(new Error('个人调用身份与当前任务空间不一致'), { status: 403, code: 'TESTER_OWNER_MISMATCH' });
  return stored || testerExecutionIdentity({ requireActive: false });
};

// Browsing a product module does not require a Key. The real provider adapter
// resolves this trusted identity immediately before making a paid request.
export function runWithTesterIdentity(identity, action) {
  if (!identity?.testerManaged || identity.billingMode !== 'personal'
    || !Number.isSafeInteger(identity.ownerUserId) || !Number.isSafeInteger(identity.tenantId))
    throw Object.assign(new Error('个人调用身份无效'), { status: 403, code: 'TESTER_OWNER_MISMATCH' });
  return credentials.run(Object.freeze({ ...identity }), action);
}

export function runWithProviderContext(context, action) {
  const bases = { '360': 'https://api.360.cn/v1', openlux: 'https://api.openlux.ai/v1' };
  if (!Object.hasOwn(bases, context?.provider || '') || context.baseUrl !== bases[context.provider]
    || typeof context?.apiKey !== 'string' || !context.apiKey.trim()
    || !Number.isSafeInteger(context.ownerUserId) || context.ownerUserId <= 0) {
    throw Object.assign(new Error('请先配置所选供应商的个人 API Key'), { status: 409, code: 'PERSONAL_KEY_REQUIRED' });
  }
  return credentials.run(Object.freeze({ ...context, billingMode: 'personal' }), action);
}

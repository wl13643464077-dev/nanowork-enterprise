import { useEffect, useState } from 'react';

// 多门店「当前门店」上下文（连锁客户）。
// - 选中值按租户存 localStorage；api/client.ts 统一在请求头加 X-Store-Id。
// - 不选 / 单店客户 = 不带头 = 服务端不过滤（一切照旧）。
// - 切换后派发全局事件 'store-changed'（与 'credits-updated' 同款模式），当前页据此重新拉数据。

export const STORE_CHANGED_EVENT = 'store-changed';
const STORAGE_PREFIX = 'nanowork_store_ctx_v1';

export type StoreOption = { id: number; name: string; code?: string | null; isDefault?: boolean };

let activeTenantId: number | null = null;

const storageKey = (tenantId: number) => `${STORAGE_PREFIX}:${tenantId}`;

function readStored(tenantId: number): number | null {
  try {
    const raw = localStorage.getItem(storageKey(tenantId));
    const id = Number(raw);
    return raw && Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

// 登录态就位时由 client.ts 调用：记住当前租户，切换器与请求头都按该租户取值
export function bindStoreContextTenant(tenantId: number | null | undefined) {
  const next = Number(tenantId);
  activeTenantId = Number.isInteger(next) && next > 0 ? next : null;
}

export function getCurrentStoreId(): number | null {
  if (activeTenantId == null) return null;
  return readStored(activeTenantId);
}

export function setCurrentStoreId(storeId: number | null) {
  if (activeTenantId == null) return;
  const previous = readStored(activeTenantId);
  try {
    if (storeId == null) localStorage.removeItem(storageKey(activeTenantId));
    else localStorage.setItem(storageKey(activeTenantId), String(storeId));
  } catch {
    /* 隐私模式下不可写：本次会话仍以内存事件驱动刷新 */
  }
  if (previous !== storeId) {
    window.dispatchEvent(new CustomEvent(STORE_CHANGED_EVENT, { detail: { storeId } }));
  }
}

// 供 fetch 直调处（未走 api 封装的地方）追加请求头
export function storeHeaders(): Record<string, string> {
  const id = getCurrentStoreId();
  return id ? { 'X-Store-Id': String(id) } : {};
}

// 已保存的门店不在当前可选清单里（被删/换租户）时自动清掉，避免请求一直 403
export function reconcileStoreSelection(stores: StoreOption[]) {
  const current = getCurrentStoreId();
  if (current != null && !stores.some(s => s.id === current)) setCurrentStoreId(null);
}

// 订阅门店切换；返回取消订阅函数（可直接作为 useEffect 的清理函数）
export function onStoreChanged(handler: (storeId: number | null) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent).detail?.storeId ?? null);
  window.addEventListener(STORE_CHANGED_EVENT, listener);
  return () => window.removeEventListener(STORE_CHANGED_EVENT, listener);
}

// 每次切换门店 +1 的版本号；页面把它放进依赖数组/ key 即可重新拉数据
export function useStoreVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => onStoreChanged(() => setVersion(v => v + 1)), []);
  return version;
}

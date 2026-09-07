import { useEffect, useState } from 'react';
import { api } from '../api/client';

// 系统菜单可见不等于能读取企业飞书配置；与 GET /sys/feishu 的角色边界保持一致。
export function canReadDashboardFeishu(role: string | undefined, modules: string[]) {
  return (
    ['boss', 'ops_director', 'admin'].includes(role || '') &&
    modules.includes('activities') &&
    modules.includes('system')
  );
}

export function useDashboardFeishu(role: string | undefined, modules: string[]) {
  const enabled = canReadDashboardFeishu(role, modules);
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    api
      .get('/sys/feishu')
      .then(result => {
        if (active) setData(result);
      })
      .catch(() => {
        if (active) setData(null);
      });
    return () => {
      active = false;
    };
  }, [enabled]);
  return { enabled, data: enabled ? data : null };
}

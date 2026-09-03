import { useState } from 'react';
import { Badge, Button, Space, Tag } from 'antd';
import { api } from '../api/client';
import { Panel } from './Kit';
import { readinessMeta } from './RuntimeReadiness';

export function AdminWebSearchPanel({ readiness, onRefresh }: { readiness: any; onRefresh: () => Promise<unknown> }) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const state = readinessMeta(readiness);
  const routes = Array.isArray(readiness?.details?.providerRoute)
    ? readiness.details.providerRoute
    : Array.isArray(readiness?.details?.routes)
      ? readiness.details.routes
      : [];

  const testSearch = () => {
    setTesting(true);
    setTestResult(null);
    api
      .post('/admin/web-search/test', {})
      .then((result: any) => {
        setTestResult(result);
        return onRefresh();
      })
      .catch((error: unknown) => {
        setTestResult({
          ok: false,
          error: error instanceof Error ? error.message : '联网主备链测试失败，请稍后重试',
        });
      })
      .finally(() => setTesting(false));
  };

  return (
    <Panel
      title="C · 联网检索分层"
      extra={<Badge status={state.badge} text={<span className="admin-search-readiness-badge">{state.label}</span>} />}
    >
      <div className="admin-search-description">
        TinyFish 先完成搜索、网页抓取与材料质量检查；无结果、抓取失败或材料不足时，自动切换 Claude WebSearch。
      </div>
      <Space className="admin-search-route-list" wrap size={[8, 8]}>
        {routes.map((route: any) => (
          <Tag key={route.key || route.id || route.label} color={route.ready ? 'green' : 'default'}>
            {route.role === 'primary' ? '首选' : '回退'} · {route.label} · {route.ready ? '已配置' : '未就绪'}
          </Tag>
        ))}
      </Space>
      <div className="admin-search-actions">
        <Button size="small" loading={testing} onClick={testSearch}>
          🔎 测试主备链
        </Button>
        {testResult && (
          <Tag className="admin-search-result" color={testResult.ok ? 'green' : 'red'}>
            {testResult.ok
              ? `✓ ${testResult.provider} · ${testResult.candidateCount}条候选${testResult.fallbackTriggered ? ' · 已自动回退' : ' · 未触发回退'}`
              : `✗ ${testResult.error}`}
          </Tag>
        )}
      </div>
      <div className="admin-search-security-note">
        密钥只从服务端环境变量读取，页面和日志不回显；测试只使用固定的公开餐饮规范查询。
      </div>
    </Panel>
  );
}

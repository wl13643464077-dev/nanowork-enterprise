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
          error: error instanceof Error ? error.message : '联网主备链诊断失败，请稍后重试',
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
        {readiness?.description ||
          'TinyFish 先完成搜索、网页抓取与材料质量检查；无结果、抓取失败或材料不足时，自动切换 Claude WebSearch。'}
      </div>
      <Space className="admin-search-route-list" wrap size={[8, 8]}>
        {routes.map((route: any) => (
          <Tag key={route.key || route.id || route.label} color={route.ready ? 'green' : 'default'}>
            {route.role === 'primary' ? '首选' : '回退'} · {route.label} · {route.ready ? '已配置' : '未就绪'}
          </Tag>
        ))}
      </Space>
      <div className="admin-search-actions">
        <Button size="small" loading={testing} onClick={testSearch} title="可选排障操作：会实际调用已配置的联网供应商">
          🔎 可选诊断主备链（会实际调用）
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
        密钥只从服务端读取，页面和日志不回显；可选诊断使用固定公开餐饮规范查询并实际调用联网供应商，可能产生调用用量。不运行诊断不影响配置完整通道正常使用。
      </div>
    </Panel>
  );
}

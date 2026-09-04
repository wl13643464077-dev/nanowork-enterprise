import { useState } from 'react';
import { Badge, Button, Col, Tag } from 'antd';
import { api } from '../api/client';
import { Panel } from './Kit';
import { readinessMeta } from './RuntimeReadiness';

type AmapTestResult = {
  ok: boolean;
  configured?: boolean;
  blocked?: boolean;
  quotaExceeded?: boolean;
  infocode?: string | null;
  adcode?: string | null;
  formattedAddress?: string | null;
  error?: string;
};

/** 高德常见 infocode 的人话提示；服务端已给出 error 文案，这里只补“下一步怎么办”。 */
export const AMAP_INFOCODE_HINTS: Record<string, string> = {
  '10001': 'Key 无效或已过期：到高德开放平台确认 Key 状态，更新服务器 .env 的 AMAP_WEB_KEY 后重启。',
  '10003': '当日配额已用尽：等次日额度恢复或到高德控制台提升配额；期间选址岗位自动回落 OSM 与公开检索。',
  '10009': '平台类型选错：该 Key 不是“Web服务”类型，请在高德控制台新建应用时选择「Web服务」平台。',
  '10044': '账号维度日调用量超限：检查同账号下其他应用的用量，或申请提升配额。',
};

export function amapTestSummary(result: AmapTestResult | null): string {
  if (!result) return '';
  if (result.ok) {
    return `✓ 连接正常 · adcode=${result.adcode || '-'}${result.formattedAddress ? ` · ${result.formattedAddress}` : ''}`;
  }
  if (result.configured === false) return `✗ ${result.error || '未配置 AMAP_WEB_KEY'}`;
  return `✗ ${result.error || '高德连接测试失败'}${result.infocode ? ` · infocode ${result.infocode}` : ''}`;
}

export function amapTestHint(result: AmapTestResult | null): string {
  if (!result || result.ok) return '';
  const code = String(result.infocode || '');
  if (code && AMAP_INFOCODE_HINTS[code]) return AMAP_INFOCODE_HINTS[code];
  if (result.configured === false)
    return '在服务器 .env 配置 AMAP_WEB_KEY（高德开放平台「Web服务」类型 Key）后重启服务，再回到这里测试连接。';
  if (result.quotaExceeded) return AMAP_INFOCODE_HINTS['10003'];
  if (result.blocked) return '凭证或配额受阻：检查高德控制台的 Key 状态与当日配额，恢复后重新测试。';
  return '';
}

export function AdminAmapPanel({ readiness, onRefresh }: { readiness: any; onRefresh: () => Promise<unknown> }) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AmapTestResult | null>(null);
  const state = readinessMeta(readiness);
  const configured = readiness?.configuration === 'ready';
  const baseUrl = readiness?.details?.baseUrl || '';
  const lastCheckedAt = readiness?.lastCheck?.checkedAt || readiness?.details?.persistedVerifiedAt || '';

  const testConnection = () => {
    setTesting(true);
    setTestResult(null);
    api
      .post('/admin/api-config/amap/test', {})
      .then((result: AmapTestResult) => {
        setTestResult(result);
        return onRefresh();
      })
      .catch((error: unknown) => {
        setTestResult({
          ok: false,
          error: error instanceof Error ? error.message : '高德连接测试失败，请稍后重试',
        });
      })
      .finally(() => setTesting(false));
  };

  const hint = amapTestHint(testResult);

  return (
    <Col xs={24}>
      <Panel
        title="E · 高德地图 Web 服务"
        extra={
          <Badge status={state.badge} text={<span className="admin-search-readiness-badge">{state.label}</span>} />
        }
      >
        <div className="admin-search-description">
          {readiness?.description ||
            '选址 / 商圈岗位优先取高德地理编码与周边 POI，并逐字段标注来源；未配置或受阻时自动回落 OSM 与公开检索。'}
        </div>
        <div className="admin-search-route-list admin-amap-facts">
          <Tag color={configured ? 'green' : 'default'}>
            {configured ? 'AMAP_WEB_KEY 已配置' : 'AMAP_WEB_KEY 未配置'}
          </Tag>
          {baseUrl ? <Tag>Base URL · {baseUrl}</Tag> : null}
          {lastCheckedAt ? <Tag>最近测试 · {String(lastCheckedAt).replace('T', ' ').slice(0, 19)}</Tag> : null}
        </div>
        <div className="admin-search-actions">
          <Button size="small" loading={testing} disabled={!configured} onClick={testConnection}>
            📍 测试连接
          </Button>
          {testResult && (
            <Tag className="admin-search-result" color={testResult.ok ? 'green' : 'red'}>
              {amapTestSummary(testResult)}
            </Tag>
          )}
        </div>
        {hint ? <div className="admin-amap-hint">{hint}</div> : null}
        {!testResult && readiness?.nextAction ? <div className="admin-amap-hint">{readiness.nextAction}</div> : null}
        <div className="admin-search-security-note">
          Key 只在服务器 <code>.env</code> 配置 <code>AMAP_WEB_KEY</code>
          （高德开放平台选「Web服务」平台）后重启生效；页面不提供输入框、不回显密钥。
          测试只用固定的公开地标做一次地理编码，不接受任意地址。常见错误码：10001 Key 无效 / 10003 日配额超限 / 10009
          平台类型选错（要选“Web服务”）。
        </div>
      </Panel>
    </Col>
  );
}

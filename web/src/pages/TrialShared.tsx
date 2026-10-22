import { useEffect, useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Empty, Spin, Tag, message } from 'antd';
import { Markdown } from '../components/Markdown';
import CampaignMaterialsGallery, { parseCampaignMaterials } from '../components/CampaignMaterialsGallery';

export type TrialEmployee = {
  id: string;
  name: string;
  displayName?: string;
  description: string;
  example: string;
  employeeIdx?: number;
  domain?: 'restaurant' | 'content';
  group?: string;
  department?: string;
  capabilities?: string[];
  experienceMode?: 'text' | 'full';
  experienceNote?: string;
};
export type TrialProviderId = 'openlux' | '360';
export const TRIAL_PROVIDER_LABELS: Record<TrialProviderId, string> = {
  openlux: 'OpenLux',
  '360': '360 智脑',
};
export function trialProviderLabel(provider?: string, fallback?: string) {
  return (provider && TRIAL_PROVIDER_LABELS[provider as TrialProviderId]) || fallback || provider || '供应商';
}
type TrialCallAttempt = {
  id: number;
  attemptNumber: number;
  status: string;
  provider?: TrialProviderId | string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  supplierCostCny?: number | null;
  costStatus?: string;
  errorCode?: string;
  createdAt?: string;
  completedAt?: string;
};
export type TrialConversation = {
  id: number;
  employeeId?: string;
  employeeName?: string;
  input: string;
  output: string;
  status: string;
  provider?: TrialProviderId | string;
  supplierCostCny?: number | null;
  costStatus?: string;
  unverifiedCostCount?: number;
  callAttempts?: TrialCallAttempt[];
  // 服务端按客户自己输入过的内容比对正文，列出模型自行添加、需要老板核对的具体说法
  factAdvice?: string[];
  campaignMaterials?: Array<{
    id: string;
    title: string;
    kind?: string;
    variant?: string;
    groupTitle?: string;
    status?: string;
    note?: string;
    url?: string;
  }>;
  createdAt?: string;
};
export type TrialLead = {
  id: number;
  name: string;
  phone: string;
  storeName?: string;
  status: string;
  provider?: TrialProviderId | string;
  turnLimit?: number;
  usedTurns: number;
  remainingTurns: number;
  invitationTitle?: string;
  testerName?: string;
  ownerName?: string;
  ownerUserId?: number;
  salesPhone?: string;
  createdAt?: string;
  lastUsedAt?: string;
};

// 旧版本响应没有个人额度时兼容 2 次；登录客户以个人额度优先。
export function trialTurnLimit(...values: Array<number | undefined>): number {
  return values.find(value => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 100) ?? 2;
}

export function trialUsageState(lead: Pick<TrialLead, 'usedTurns' | 'turnLimit'>): 'unused' | 'active' | 'exhausted' {
  if (lead.usedTurns <= 0) return 'unused';
  return lead.usedTurns >= trialTurnLimit(lead.turnLimit) ? 'exhausted' : 'active';
}

export const TRIAL_STATUS: Record<string, string> = {
  pending: '待审核',
  approved: '已开通',
  rejected: '未通过',
  paused: '已暂停',
  active: '生效中',
  disabled: '已停用',
  revoked: '已停用',
  completed: '已完成',
  succeeded: '已完成',
  failed: '未完成',
  running: '生成中',
};
export function TrialStatus({ status }: { status: string }) {
  return (
    <Tag
      color={
        ['approved', 'active', 'completed', 'succeeded'].includes(status)
          ? 'green'
          : status === 'pending'
            ? 'gold'
            : undefined
      }
    >
      {TRIAL_STATUS[status] || status}
    </Tag>
  );
}

// 体验链接使用独立短令牌，不携带销售的 Key，也不依赖企业登录状态。
export async function trialRequest<T = any>(
  path: string,
  options: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 14 * 60 * 1000);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(`/api${path}`, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(options.token ? { 'X-Trial-Token': options.token } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Object.assign(new Error(data.error || `请求未完成（${response.status}）`), {
        status: response.status,
        code: data.code,
      });
    return data as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw Object.assign(new Error('生成仍可能在处理中，请刷新记录查看结果后重试。'), { cause: error });
    throw error;
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

export const trialError = (error: unknown) => (error instanceof Error ? error.message : '请求未完成，请稍后重试');
export const newTrialRequestId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const formatTrialTime = (value?: string) => {
  if (!value) return '—';
  // 无时区的历史字段已是服务器北京时间，不能再当作 UTC 加八小时。
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) return value.replace('T', ' ');
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
};
export function trialCost(value?: number | null, status?: string) {
  if (value != null && Number.isFinite(Number(value)))
    return `¥${Number(value).toFixed(6)}${status === 'estimated' ? '（估算）' : status === 'unverified' ? '（仅已核实部分）' : ''}`;
  return status === 'not_incurred' ? '未产生费用' : '待供应商核实';
}

export function TrialHistory({
  conversations,
  showCost = false,
  invitationToken,
  accessToken,
}: {
  conversations: TrialConversation[];
  showCost?: boolean;
  invitationToken?: string;
  accessToken?: string;
}) {
  if (!conversations.length)
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="发一句需求，数字员工就开始工作" />;
  return (
    <div className="trial-history">
      {[...conversations]
        .sort((a, b) => a.id - b.id)
        .map((item, index) => (
          <details className="trial-result" key={item.id} open={index === conversations.length - 1}>
            <summary>
              <span>
                {item.employeeName || '数字员工'} · {item.input?.slice(0, 45) || '对话记录'}
              </span>
              <span className="trial-muted">{formatTrialTime(item.createdAt)}</span>
            </summary>
            <div className="trial-request">{item.input}</div>
            {item.output ? (
              <>
                <Markdown content={item.output.replace(/```nanowork-campaign-materials[\s\S]*?```\s*/gu, '').trimEnd()} />
                <CampaignMaterialsGallery
                  items={item.campaignMaterials?.length ? item.campaignMaterials : parseCampaignMaterials(item.output)}
                  invitationToken={invitationToken}
                  accessToken={accessToken}
                  conversationId={item.id}
                />
                {!!item.factAdvice?.length && (
                  <Alert
                    type="warning"
                    showIcon
                    className="trial-fact-advice"
                    message="发布前请核对这些说法"
                    description={
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {item.factAdvice.map(line => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    }
                  />
                )}
              </>
            ) : (
              <Alert
                type={item.status === 'failed' ? 'warning' : 'info'}
                message={item.status === 'failed' ? '这次没有生成可用结果，可以重试。' : '正在处理，请稍后刷新记录。'}
              />
            )}
            <div className="trial-result-footer">
              <TrialStatus status={item.status || 'completed'} />
              <Tag>{trialProviderLabel(item.provider || '360')}</Tag>
              {showCost && (
                <span>
                  {trialProviderLabel(item.provider || '360')}成本：{trialCost(item.supplierCostCny, item.costStatus)}
                  {item.unverifiedCostCount ? ` · 另 ${item.unverifiedCostCount} 次待核实` : ''}
                </span>
              )}
              {item.output && (
                <Button
                  size="small"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(item.output)
                      .then(() => message.success('正文已复制'))
                      .catch(() => message.error('复制失败，请选中正文复制'))
                  }
                >
                  复制正文
                </Button>
              )}
            </div>
            {showCost && !!item.callAttempts?.length && (
              <details className="trial-call-attempts">
                <summary>查看逐次调用与重试费用（{item.callAttempts.length} 次）</summary>
                {item.callAttempts.map(attempt => (
                  <div className="trial-call-row" key={attempt.id}>
                    <div>
                      <strong>第 {attempt.attemptNumber} 次调用</strong> <TrialStatus status={attempt.status} />
                    </div>
                    <div>
                      {trialProviderLabel(attempt.provider || item.provider || '360')} · {attempt.model || '模型待记录'}{' '}
                      · {trialCost(attempt.supplierCostCny, attempt.costStatus)}
                    </div>
                    <div className="trial-muted">
                      输入 {attempt.usage?.inputTokens ?? '—'} / 输出 {attempt.usage?.outputTokens ?? '—'} token ·{' '}
                      {formatTrialTime(attempt.createdAt)}
                    </div>
                    {attempt.errorCode && <div className="trial-muted">处理状态：{attempt.errorCode}</div>}
                  </div>
                ))}
              </details>
            )}
          </details>
        ))}
    </div>
  );
}

export function TrialLeadDrawer({
  id,
  admin = false,
  onClose,
}: {
  id: number | null;
  admin?: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<{ lead: TrialLead; conversations: TrialConversation[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!id) return;
    let active = true;
    const frame = requestAnimationFrame(() => {
      setData(null);
      setError('');
      trialRequest(`/tester/${admin ? 'admin/' : ''}leads/${id}`)
        .then(result => {
          if (active) setData(result);
        })
        .catch(error => {
          if (active) setError(trialError(error));
        });
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  }, [id, admin]);
  return (
    <Drawer open={id !== null} title="客户体验详情" onClose={onClose} width={760}>
      {error && <Alert type="error" message={error} />}
      {!error && !data && <Spin />}
      {data && (
        <>
          <Descriptions
            column={1}
            size="small"
            bordered
            items={[
              { key: 'name', label: '客户', children: `${data.lead.name} · ${data.lead.phone}` },
              { key: 'store', label: '门店', children: data.lead.storeName || '未填写' },
              {
                key: 'sales',
                label: '邀请人',
                children:
                  [data.lead.testerName || data.lead.ownerName, data.lead.salesPhone].filter(Boolean).join(' · ') ||
                  '当前测试员',
              },
              { key: 'status', label: '状态', children: <TrialStatus status={data.lead.status} /> },
              {
                key: 'provider',
                label: '体验供应商',
                children: trialProviderLabel(data.lead.provider || '360'),
              },
              {
                key: 'turns',
                label: '使用情况',
                children: `已使用 ${data.lead.usedTurns} / ${trialTurnLimit(data.lead.turnLimit)} 次，还可用 ${data.lead.remainingTurns} 次`,
              },
            ]}
          />
          <div style={{ marginTop: 24 }}>
            <TrialHistory conversations={data.conversations || []} showCost />
          </div>
        </>
      )}
    </Drawer>
  );
}

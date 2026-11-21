// 技能页“本轮补充技能（待你确认）”（PRD v2.2 FR-6）。
// 原岗位技能卡区域不变；这里只展示追加的中国本土补充卡，老板逐张确认启用或暂不启用。
// 确认启用的卡才会追加到派活提示词（排在原技能之后）。
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Empty, Space, Tag, Typography, message } from 'antd';
import { api } from '../api/client';

type SupplementCard = {
  id: string;
  title: string;
  detail: string;
  source: string;
  sourceUrl?: string | null;
  sourceDate?: string | null;
  gapNote?: string;
  scope: 'employee' | 'common';
  status: 'supplement_pending_owner_review' | 'owner_verified_enabled' | 'owner_declined';
  needsRecheck?: boolean;
};

type SupplementView = {
  available: boolean;
  error?: string;
  cards: SupplementCard[];
  summary: { total: number; enabled: number; pending: number; declined: number };
  canReview?: boolean;
};

const STATUS_TAG: Record<SupplementCard['status'], { color: string; label: string }> = {
  supplement_pending_owner_review: { color: 'gold', label: '待确认' },
  owner_verified_enabled: { color: 'green', label: '已启用' },
  owner_declined: { color: 'default', label: '暂不启用' },
};

export default function EmployeeSkillSupplement({ idx }: { idx: number }) {
  const [view, setView] = useState<SupplementView | null>(null);
  const [saving, setSaving] = useState('');

  const load = useCallback(() => {
    api
      .get(`/employee-workbench/restaurant/${idx}/skill-supplement`, { silent: true })
      .then((payload: any) => setView(payload as SupplementView))
      .catch(() => setView(null));
  }, [idx]);

  useEffect(load, [load]);

  const decide = async (cards: SupplementCard[], status: SupplementCard['status']) => {
    if (!cards.length) return;
    const key = cards.length === 1 ? cards[0].id : `all-${status}`;
    setSaving(key);
    try {
      const payload: any = await api.put(`/employee-workbench/restaurant/${idx}/skill-supplement`, {
        decisions: cards.map(card => ({ cardId: card.id, status })),
      });
      setView(current => ({ ...(payload as SupplementView), canReview: current?.canReview }));
      message.success(status === 'owner_verified_enabled' ? '已启用，下次派活生效' : '已设为暂不启用');
    } catch (error: any) {
      message.error(error?.message || '保存失败');
    } finally {
      setSaving('');
    }
  };

  if (!view) return null;
  if (!view.available) {
    return <Alert type="warning" showIcon message="补充技能暂不可用" description={view.error} />;
  }
  if (!view.cards.length) return <Empty description="暂无补充技能" />;
  const pending = view.cards.filter(card => card.status === 'supplement_pending_owner_review');

  return (
    <section className="ewb-skill-supplement">
      <Space align="center" wrap style={{ marginBottom: 8 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          本轮补充技能（待你确认）
        </Typography.Title>
        <Typography.Text type="secondary">
          已启用 {view.summary.enabled} · 待确认 {view.summary.pending} · 暂不启用 {view.summary.declined}
        </Typography.Text>
        {view.canReview && pending.length > 0 && (
          <Button
            size="small"
            loading={saving === 'all-owner_verified_enabled'}
            onClick={() => decide(pending, 'owner_verified_enabled')}
          >
            全部启用待确认的 {pending.length} 张
          </Button>
        )}
      </Space>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        原来的岗位技能一张没动；下面是按中国法规、平台新规和门店实际补充的技能，启用后追加在原技能之后。
      </Typography.Paragraph>
      <div className="ewb-skill-supplement-list">
        {view.cards.map(card => (
          <article key={card.id} className="ewb-skill-supplement-card">
            <Space wrap size={6}>
              <Typography.Text strong>{card.title}</Typography.Text>
              <Tag color={STATUS_TAG[card.status].color}>{STATUS_TAG[card.status].label}</Tag>
              {card.scope === 'common' && <Tag>全员通用</Tag>}
              {card.gapNote && <Tag color="blue">{card.gapNote}</Tag>}
              {card.needsRecheck && <Tag color="red">平台规则需复核</Tag>}
            </Space>
            <Typography.Paragraph style={{ margin: '6px 0' }}>{card.detail}</Typography.Paragraph>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              来源：
              {card.sourceUrl ? (
                <a href={card.sourceUrl} target="_blank" rel="noreferrer noopener">
                  {card.source}
                </a>
              ) : (
                card.source
              )}
              {card.sourceDate ? `（${card.sourceDate}）` : ''}
            </Typography.Text>
            {view.canReview && (
              <Space style={{ marginTop: 6 }}>
                <Button
                  size="small"
                  type={card.status === 'owner_verified_enabled' ? 'primary' : 'default'}
                  loading={saving === card.id}
                  onClick={() => decide([card], 'owner_verified_enabled')}
                >
                  确认启用
                </Button>
                <Button size="small" disabled={saving === card.id} onClick={() => decide([card], 'owner_declined')}>
                  暂不启用
                </Button>
              </Space>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

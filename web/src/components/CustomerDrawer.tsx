// 通用客户档案抽屉：任意模块点到「客户」即可打开（多层钻取的终点站）
// 内容：档案 + 11节点生命周期 + 订单溯源 + 评分构成 + 跟进时间线 + 去增长中心
import { useEffect, useRef, useState } from 'react';
import { Drawer, Tag, Space, Spin, Empty, Timeline, Table, Button } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api, fmtMoney } from '../api/client';
import { Panel, StageTag, GradeTag } from './Kit';

type CustomerDrawerProps = { leadId: number | null; open: boolean; onClose: () => void };

export default function CustomerDrawer(props: CustomerDrawerProps) {
  const instanceKey = props.open && props.leadId ? `lead-${props.leadId}` : 'closed';
  return <CustomerDrawerInstance key={instanceKey} {...props} />;
}

function CustomerDrawerInstance({ leadId, open, onClose }: CustomerDrawerProps) {
  const nav = useNavigate();
  const [detail, setDetail] = useState<any>(null);
  const [journey, setJourney] = useState<any>(null);
  const [denied, setDenied] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    // 请求版本号守卫：快速切换 leadId 时丢弃过期响应，避免 A 客户数据覆盖 B 客户抽屉
    const requestId = ++requestRef.current;
    if (!open || !leadId) return;
    api.get(`/growth/leads/${leadId}`).then(d => { if (requestId === requestRef.current) setDetail(d); })
      .catch(() => { if (requestId === requestRef.current) setDenied(true); });
    api.get(`/growth/leads/${leadId}/journey`).then(d => { if (requestId === requestRef.current) setJourney(d); })
      .catch(() => {});
    return () => { requestRef.current += 1; };
  }, [open, leadId]);

  return (
    <Drawer open={open} width={540} onClose={onClose}
      title={detail?.name
        ? <Space>{detail.name}<GradeTag grade={detail.grade} /><StageTag stage={detail.stage} />{detail.identity_tag && <Tag>{detail.identity_tag}</Tag>}</Space>
        : '客户档案'}>
      {denied ? <Empty description="您没有增长中心数据权限，请联系管理员开通" /> :
      !detail ? <div style={{ textAlign: 'center', padding: 48 }}><Spin tip="档案加载中…"><div style={{ height: 32 }} /></Spin></div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--ui-text-2)', background: 'var(--ui-surface-2)', borderRadius: 8, padding: '10px 12px' }}>
            <span>成交概率 <b style={{ color: '#f25b6b', fontSize: 16 }}>{detail.score}</b> 分</span>
            <span>预算 <b>{detail.budget_level || '-'}</b></span>
            <span>来源 {detail.source || '-'}</span>
            <span>负责人 {detail.owner_name || '-'}</span>
            {detail.company && <span>公司 {detail.company}</span>}
          </div>

          {journey && (
            <Panel title={`生命周期 · 当前「${journey.current}」（${(journey.journey || []).filter((j: any) => j.reached).length}/11节点 · ${journey.totalDays}天）`}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {(journey.journey || []).map((j: any) => (
                  <Tag key={j.node} color={j.node === journey.current ? 'blue' : j.reached ? 'green' : 'default'}
                    style={{ margin: 0, fontSize: 11, opacity: j.reached ? 1 : 0.55 }}
                    title={j.at ? `${j.at}${j.note ? ' · ' + j.note : ''}` : '未到达'}>
                    {j.reached ? '✓' : '·'} {j.node}{j.stayDays != null && j.stayDays > 0 && j.node !== journey.current ? ` ${j.stayDays}d` : ''}
                  </Tag>
                ))}
              </div>
              {journey.nextHint && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ui-accent)' }}>💡 下一步：{journey.nextHint}</div>}
            </Panel>
          )}

          {(detail.orders || []).length > 0 && (
            <Panel title={`订单溯源（${detail.orders.length}笔 · 累计 ${fmtMoney(detail.orders.reduce((a: number, o: any) => a + (o.amount || 0), 0))}）`}>
              <Table size="small" rowKey="id" dataSource={detail.orders} pagination={false}
                columns={[
                  { title: '产品', dataIndex: 'product', ellipsis: true },
                  { title: '金额', dataIndex: 'amount', align: 'right', width: 88, render: (v: any) => <b>{fmtMoney(v || 0)}</b> },
                  { title: '类型', dataIndex: 'type', width: 62, render: (v: any) => <Tag color={v === '复购' ? 'purple' : 'blue'} style={{ margin: 0, fontSize: 10.5 }}>{v}</Tag> },
                  { title: '时间', dataIndex: 'created_at', width: 92, render: (v: any) => (v || '').slice(5, 16) },
                ]} />
            </Panel>
          )}

          {Object.keys(detail.score_detail || {}).length > 0 && (
            <Panel title={`评分构成（共${detail.score}分，可解释）`}>
              {Object.entries(detail.score_detail).map(([k, v]: any) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '3px 0', color: 'var(--ui-text-2)' }}>
                  <span>{k}</span><b style={{ color: Number(v) >= 0 ? '#16a34a' : '#ef4444' }}>{Number(v) >= 0 ? '+' : ''}{v}</b>
                </div>
              ))}
            </Panel>
          )}

          <Panel title={`跟进记录（${(detail.follows || []).length}）`}>
            {(detail.follows || []).length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无跟进" /> :
              <Timeline items={(detail.follows || []).slice(0, 8).map((f: any) => ({
                children: <div style={{ fontSize: 12.5 }}><b>{f.user_name || '系统'}</b> <span style={{ color: 'var(--ui-muted)', fontSize: 11 }}>{(f.created_at || '').slice(5, 16)}</span>
                  {f.stage_after && <Tag style={{ marginLeft: 6, fontSize: 10 }}>{f.stage_after}</Tag>}
                  <div style={{ color: 'var(--ui-text-2)' }}>{f.content}</div></div>,
              }))} />}
          </Panel>

          <Button type="primary" block onClick={() => { onClose(); nav('/growth'); }}>到增长中心跟进此客户 ›</Button>
        </div>
      )}
    </Drawer>
  );
}

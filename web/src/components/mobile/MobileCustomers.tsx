import { useRef, useState } from 'react';
import { Button, Drawer, Empty, Input, List, Spin, Tag, message } from 'antd';
import { CopyOutlined, MessageOutlined } from '@ant-design/icons';
import { api, notifyCredits } from '../../api/client';
import { stageColor, gradeColor } from '../Kit';
import { Markdown } from '../Markdown';
import { useQuery, QueryStatus } from '../../hooks/useQuery';
import type { Lead } from '../../api/types';
import './mobile.css';

// 客户（首页二级页）：待跟进客户列表 + 底部抽屉看详情、AI 话术、记跟进。
export default function MobileCustomers() {
  const leadsQ = useQuery<{ rows: Lead[] }>('/growth/leads?size=30&sort=follow');
  const rows = leadsQ.data?.rows || [];
  const [cur, setCur] = useState<Lead | null>(null);
  const [detail, setDetail] = useState<Lead | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const detailRequestRef = useRef(0);
  const [note, setNote] = useState('');
  const [ai, setAi] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const loadDetail = (lead: Lead) => {
    const serial = ++detailRequestRef.current;
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    api
      .get(`/growth/leads/${lead.id}`, { silent: true })
      .then(data => {
        if (serial === detailRequestRef.current) setDetail(data);
      })
      .catch((error: any) => {
        if (serial === detailRequestRef.current) setDetailError(error?.message || '客户详情加载失败');
      })
      .finally(() => {
        if (serial === detailRequestRef.current) setDetailLoading(false);
      });
  };
  const open = (r: Lead) => {
    setCur(r);
    setNote('');
    setAi('');
    loadDetail(r);
  };
  const addFollow = () => {
    if (!note.trim() || saving || !cur) return; // 防连点重复提交
    setSaving(true);
    api
      .post(`/growth/leads/${cur.id}/follow`, { content: note })
      .then(() => {
        message.success('已记录跟进');
        setNote('');
        return api.get(`/growth/leads/${cur.id}`).then(setDetail);
      })
      .finally(() => setSaving(false));
  };
  const genReply = () => {
    if (!cur) return;
    setAiLoading(true);
    api
      .post('/growth/suggest-reply', { leadId: cur.id, context: cur.interest || '客户咨询' })
      .then(r => {
        setAi(r.suggestions || '');
        if (!r.suggestions) message.info('暂无话术建议，可补充客户兴趣点后重试');
        notifyCredits(r.billing?.balance);
      })
      .finally(() => setAiLoading(false));
  };
  if (leadsQ.loading || leadsQ.error) return <QueryStatus q={leadsQ} height={200} />;
  return (
    <>
      <List
        dataSource={rows}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无客户" /> }}
        renderItem={(r: Lead) => (
          <button
            type="button"
            className="m-row-button m-lead-card"
            aria-label={`查看客户 ${r.name}`}
            onClick={() => open(r)}
          >
            <span className="m-row-main">
              <span className="m-lead-head">
                <span>
                  <span className="m-lead-name">{r.name}</span>{' '}
                  <Tag color={gradeColor[r.grade] || 'default'}>{r.grade}类</Tag>
                </span>
                <Tag color={stageColor[r.stage] || 'default'}>{r.stage}</Tag>
              </span>
              <span className="m-lead-meta">
                {r.identity_tag || '—'} · {r.interest || '暂无兴趣点'} · 评分{r.score}
              </span>
            </span>
          </button>
        )}
      />
      <Drawer
        open={!!cur}
        placement="bottom"
        height="86%"
        onClose={() => {
          detailRequestRef.current += 1;
          setCur(null);
          setDetail(null);
          setDetailError('');
          setDetailLoading(false);
        }}
        title={cur ? `${cur.name}（${cur.grade}类 · ${cur.stage}）` : ''}
      >
        {detailLoading ? (
          <Spin />
        ) : detailError ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={detailError}>
            <Button type="primary" disabled={!cur} onClick={() => cur && loadDetail(cur)}>
              重新加载
            </Button>
          </Empty>
        ) : !detail ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="客户详情证据未返回" />
        ) : (
          <div className="m-stack">
            <div className="m-card m-detail-facts">
              <div>
                电话 {detail.phone || '—'} ｜ 来源：{detail.source || '—'}
              </div>
              <div>
                预算：{detail.budget_level} ｜ 成交概率：{detail.score}分
              </div>
              {detail.next_action && <div>下一步：{detail.next_action}</div>}
            </div>
            <div>
              <Button type="primary" block icon={<MessageOutlined />} loading={aiLoading} onClick={genReply}>
                AI 生成跟进话术
              </Button>
              {ai && (
                <div className="m-ai-card">
                  <Markdown content={ai} />
                  <Button
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={() => {
                      navigator.clipboard?.writeText(ai);
                      message.success('已复制');
                    }}
                  >
                    复制
                  </Button>
                </div>
              )}
            </div>
            <div>
              <div className="m-field-label">记一笔跟进</div>
              <Input.TextArea
                rows={2}
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="今天和客户聊了什么…"
              />
              <Button type="primary" block loading={saving} className="m-block-gap" onClick={addFollow}>
                保存跟进
              </Button>
            </div>
            <div>
              <div className="m-field-label">跟进记录（{(detail.follows || []).length}）</div>
              {(detail.follows || []).slice(0, 6).map((f: any, i: number) => (
                <div key={i} className="m-follow-line">
                  <span className="m-follow-time">{(f.created_at || '').slice(5, 16)}</span>
                  {f.content}
                </div>
              ))}
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}

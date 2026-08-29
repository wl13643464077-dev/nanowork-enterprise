import { useEffect, useState } from 'react';
import { Button, Tag } from 'antd';
import { CheckCircleOutlined, PhoneOutlined, RightOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import './GrowthTodayFocus.css';

// 会员增长「今日必跟」工作面：打开页面第一眼是今天该跟谁，而不是一堆报表。
// 口径：下次跟进时间 ≤ 今天且未成交/未流失，按到期时间升序（最急的在前）。

type DueLead = {
  id: number;
  name: string;
  stage: string;
  grade?: string;
  score?: number;
  next_follow_at?: string;
  next_action?: string;
  owner_name?: string;
};

function dueLabel(nextFollowAt?: string) {
  if (!nextFollowAt) return '';
  const due = new Date(`${String(nextFollowAt).slice(0, 10)}T00:00:00`);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((startOfToday.getTime() - due.getTime()) / 86400000);
  if (diffDays <= 0) return '今天到期';
  return `超期 ${diffDays} 天`;
}

export default function GrowthTodayFocus({ onOpenLead }: { onOpenLead: (id: number) => void }) {
  const [leads, setLeads] = useState<DueLead[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let active = true;
    api
      .get('/growth/leads?followStatus=due&sort=follow&size=6')
      .then((data: any) => {
        if (active) {
          setLoadFailed(false);
          setLeads(Array.isArray(data?.rows) ? data.rows : []);
        }
      })
      .catch(() => {
        // 网络抖动时「今日必跟」整块蒸发会让员工漏跟客户：失败态要可见、可重试
        if (active) {
          setLeads(null);
          setLoadFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, [reloadTick]);

  if (loadFailed) {
    return (
      <section className="gtf" aria-label="今日必跟客户">
        <header className="gtf-head">
          <strong>今日必跟</strong>
          <span>名单加载失败，到期客户可能被遗漏</span>
          <Button size="small" onClick={() => setReloadTick(tick => tick + 1)}>
            重试
          </Button>
        </header>
      </section>
    );
  }

  if (leads === null) return null;

  return (
    <section className="gtf" aria-label="今日必跟客户">
      <header className="gtf-head">
        <strong>今日必跟</strong>
        <span>{leads.length ? `${leads.length} 位客户到期或超期，按急迫度排序` : '今天没有到期客户'}</span>
      </header>
      {leads.length ? (
        <div className="gtf-list">
          {leads.map(lead => {
            const overdue = dueLabel(lead.next_follow_at);
            return (
              <button type="button" className="gtf-card" key={lead.id} onClick={() => onOpenLead(lead.id)}>
                <div className="gtf-card-head">
                  <strong>{lead.name}</strong>
                  <Tag color={overdue === '今天到期' ? 'gold' : 'error'}>{overdue}</Tag>
                </div>
                <div className="gtf-card-meta">
                  <span>{lead.stage}</span>
                  {lead.grade && <span>{lead.grade} 类</span>}
                  {lead.owner_name && <span>负责：{lead.owner_name}</span>}
                </div>
                {lead.next_action && <p className="gtf-card-action">约定动作：{lead.next_action}</p>}
                <span className="gtf-card-cta">
                  <PhoneOutlined /> 去跟进 <RightOutlined />
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="gtf-empty">
          <CheckCircleOutlined /> 到期客户都跟完了；可以从「待跟进客户」里提前安排明天的联系。
          <Button size="small" type="link" onClick={() => onOpenLead(-1)}>
            看全部待跟进
          </Button>
        </div>
      )}
    </section>
  );
}

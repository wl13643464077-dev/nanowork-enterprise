import { useEffect, useState } from 'react';
import { Button, Modal, Tag, message } from 'antd';
import { GiftOutlined, RobotOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import './BirthdayCare.css';

// 会员生日关怀：未来 7 天内过生日的客户 + AI 生日祝福话术（真实计费）。
// 没有生日客户时整块隐藏，不占版面；生日字段在客户资料中维护。

type BirthdayCustomer = {
  id: number;
  name: string;
  stage: string;
  grade?: string;
  dateLabel: string;
  inDays: number;
  owner_name?: string;
  wechat?: string;
};

export default function BirthdayCare() {
  const [customers, setCustomers] = useState<BirthdayCustomer[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [wishFor, setWishFor] = useState<BirthdayCustomer | null>(null);
  const [wish, setWish] = useState('');
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .get('/growth/birthdays?days=7')
      .then((data: any) => {
        if (active) {
          setLoadFailed(false);
          setCustomers(data?.customers || []);
        }
      })
      .catch(() => {
        // 加载失败与「没有生日客户」必须可区分：失败时留一条轻量提示可重试
        if (active) {
          setCustomers(null);
          setLoadFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, [reloadTick]);

  if (loadFailed) {
    return (
      <section className="bc-card" aria-label="近期生日客户">
        <header className="bc-head">
          <strong>
            <GiftOutlined /> 近 7 天生日
          </strong>
          <span>生日名单加载失败</span>
          <Button size="small" onClick={() => setReloadTick(tick => tick + 1)}>
            重试
          </Button>
        </header>
      </section>
    );
  }

  if (!customers?.length) return null;

  const generate = async (customer: BirthdayCustomer) => {
    // 真实计费调用：生成期间锁整组按钮（generating 判断），并校验响应归属，
    // 防止连点两个客户时 A 的祝福套上 B 的名字（话术串人）
    if (generating) return;
    setWishFor(customer);
    setWish('');
    setGenerating(true);
    try {
      const out = await api.post(`/growth/birthdays/${customer.id}/wish`, {});
      setWishFor(current => {
        if (current?.id !== customer.id) return current;
        setWish(out.wish || '');
        return current;
      });
      if (out.billing?.chargedCredits != null) {
        message.success(`祝福话术已生成（${out.billing.chargedCredits} 积分）`);
      }
    } catch (err: any) {
      message.error(err?.message || '祝福生成失败');
      setWishFor(current => (current?.id === customer.id ? null : current));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <section className="bc-card" aria-label="近期生日客户">
      <header className="bc-head">
        <strong>
          <GiftOutlined /> 近 7 天生日
        </strong>
        <span>生日当天发句祝福＋到店邀请，是成本最低的复购动作</span>
      </header>
      <div className="bc-list">
        {customers.map(customer => (
          <div className="bc-item" key={customer.id}>
            <div className="bc-item-copy">
              <strong>{customer.name}</strong>
              <Tag color={customer.inDays === 0 ? 'volcano' : 'gold'}>
                {customer.inDays === 0 ? '今天生日' : `${customer.dateLabel} · ${customer.inDays} 天后`}
              </Tag>
              <span>
                {customer.stage}
                {customer.owner_name ? ` · ${customer.owner_name}` : ''}
              </span>
            </div>
            <Button
              size="small"
              type="primary"
              icon={<RobotOutlined />}
              loading={generating && wishFor?.id === customer.id}
              disabled={generating && wishFor?.id !== customer.id}
              onClick={() => void generate(customer)}
            >
              AI 写祝福
            </Button>
          </div>
        ))}
      </div>
      <Modal
        title={wishFor ? `给「${wishFor.name}」的生日祝福` : ''}
        open={Boolean(wishFor) && !generating}
        okText="复制话术"
        cancelText="关闭"
        onOk={() => {
          void navigator.clipboard?.writeText(wish).catch(() => {});
          message.success('已复制，去微信发给客户吧');
          setWishFor(null);
        }}
        onCancel={() => setWishFor(null)}
      >
        <p className="bc-wish">{wish}</p>
        <small className="bc-boundary">话术仅生成草稿；请复制到微信发送，系统不代替对外发送。</small>
      </Modal>
    </section>
  );
}

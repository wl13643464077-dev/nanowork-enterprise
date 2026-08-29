import { useEffect, useState } from 'react';
import { Button, InputNumber, Tag, message } from 'antd';
import { CheckCircleFilled, FireFilled, LineChartOutlined, SendOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import './StaffDailyGuide.css';

// 员工每日数据填报引导卡（驾驶舱数据链的员工侧入口）。
// 设计目标：员工登录第一眼就知道「今天该填什么、为什么填、填了老板那边亮什么」。
// 成交/复购金额由客户阶段推进自动归集（防双计），这里只报四项无明细来源数据。

type StaffDailyState = {
  date: string;
  reportedToday: boolean;
  todayValues: Record<string, number>;
  autoCollected: { deals: number; dealAmount: number; orders: number };
  streakDays: number;
  fields: { key: string; label: string }[];
};

const FIELD_HINTS: Record<string, string> = {
  new_leads: '今天新加到的客户',
  invited: '约到店的客户数',
  arrived: '实际到店人数',
  content_count: '发出的内容条数',
};

export default function StaffDailyGuide() {
  const [state, setState] = useState<StaffDailyState | null>(null);
  const [draft, setDraft] = useState<Record<string, number | null>>({});
  const [submitting, setSubmitting] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = () =>
    api
      .get('/dashboard/staff-daily')
      .then((data: StaffDailyState) => {
        setState(data);
        setLoadFailed(false);
      })
      .catch(() => setLoadFailed(true));

  useEffect(() => {
    void load();
  }, []);

  if (loadFailed) {
    return (
      <section className="sdg" aria-label="今日经营数据填报">
        <header className="sdg-head">
          <div className="sdg-title">
            <strong>今日经营数据</strong>
            <span>填报入口加载失败</span>
          </div>
          <Button size="small" onClick={() => void load()}>
            重试
          </Button>
        </header>
      </section>
    );
  }

  if (!state) return null;

  const submit = async () => {
    const payload = Object.fromEntries(Object.entries(draft).filter(([, value]) => Number(value) > 0));
    if (!Object.keys(payload).length) {
      message.warning('先填至少一项今天的数字');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.post('/dashboard/staff-daily', payload);
      message.success(result?.msg || '已上报');
      setDraft({});
      await load();
    } catch {
      /* client 已 toast */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="sdg" aria-label="今日经营数据填报">
      <header className="sdg-head">
        <div className="sdg-title">
          <strong>今日经营数据</strong>
          <span>你填的数会直接进老板驾驶舱</span>
        </div>
        <div className="sdg-badges">
          {state.streakDays > 1 && (
            <Tag icon={<FireFilled />} color="volcano">
              连续 {state.streakDays} 天有数
            </Tag>
          )}
          {state.reportedToday ? (
            <Tag icon={<CheckCircleFilled />} color="success">
              今日已有数据
            </Tag>
          ) : (
            <Tag color="warning">今日待填报</Tag>
          )}
        </div>
      </header>

      <div className="sdg-fields">
        {state.fields.map(field => (
          <div className="sdg-field" key={field.key}>
            <span className="sdg-field-label" id={`staff-daily-label-${field.key}`}>
              {field.label}
            </span>
            <InputNumber
              id={`staff-daily-${field.key}`}
              aria-labelledby={`staff-daily-label-${field.key}`}
              min={0}
              max={999}
              placeholder="0"
              value={draft[field.key] ?? null}
              onChange={value => setDraft(current => ({ ...current, [field.key]: value as number | null }))}
            />
            <small>{FIELD_HINTS[field.key]}</small>
            {state.todayValues[field.key] > 0 && <em>今日累计 {state.todayValues[field.key]}</em>}
          </div>
        ))}
        <div className="sdg-submit">
          <Button type="primary" icon={<SendOutlined />} loading={submitting} onClick={() => void submit()}>
            一键上报
          </Button>
          <small>按累加计入，可分多次报</small>
        </div>
      </div>

      <footer className="sdg-foot">
        <span className="sdg-foot-link">
          <LineChartOutlined /> 填报后点亮老板驾驶舱：经营日报 · 销售趋势 · 转化漏斗
        </span>
        <span className="sdg-foot-auto">
          成交 {state.autoCollected.deals} 单 / ¥{Math.round(state.autoCollected.dealAmount).toLocaleString()}
          ：由客户阶段推进自动归集，不用手填、也不能重复报
        </span>
      </footer>
    </section>
  );
}

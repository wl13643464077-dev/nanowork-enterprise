import { useEffect, useState } from 'react';
import { Button, Table, Tag, Tooltip } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { dispatchToEmployee } from '../utils/dispatchEmployee';
import { Panel } from './Kit';
import './DashboardInspectionCard.css';

/**
 * 驾驶舱 · 巡店看板（#161 巡店督导归档统计）。
 * 老板一屏看清：每个督导每月查了多少店、每个店多少分、有多少问题。
 * 没有任何巡店记录时整卡隐藏（不用空框占位）；读取失败静默隐藏。
 */

type SupervisorRow = {
  month: string;
  supervisor: string;
  inspections: number;
  stores: number;
  avgScore: number | null;
  issues: number;
  highIssues: number;
};

type StoreRow = {
  store: string;
  inspections: number;
  avgScore: number | null;
  minScore: number | null;
  issues: number;
  highIssues: number;
  lastAt: string;
};

type RectificationStats = {
  totalIssues: number;
  created: number;
  closed: number;
  pending: number;
  closureRate: number;
};

type Summary = {
  bySupervisor: SupervisorRow[];
  byStore: StoreRow[];
  totals: { inspections: number; stores: number; avgScore: number | null; highIssues: number };
  rectificationStats?: RectificationStats;
};

function scoreTone(score: number | null) {
  if (score === null || score === undefined) return 'default';
  if (score >= 85) return 'green';
  if (score >= 70) return 'gold';
  return 'red';
}

function closureTone(rate: number) {
  if (rate >= 80) return 'green';
  if (rate >= 40) return 'gold';
  return 'red';
}

export default function DashboardInspectionCard() {
  const nav = useNavigate();
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    let active = true;
    api
      .get('/marshals/inspections/summary?months=3')
      .then((data: Summary) => {
        if (active && data?.totals?.inspections > 0) setSummary(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (!summary) return null;

  const rectStats = summary.rectificationStats;

  return (
    <Panel
      title="巡店看板 · 近3个月"
      extra={
        <span className="dic-totals">
          {summary.totals.inspections} 次巡店 · {summary.totals.stores} 家门店 · 均分 {summary.totals.avgScore ?? '—'}
          {summary.totals.highIssues > 0 && <Tag color="red">高危问题 {summary.totals.highIssues}</Tag>}
          {rectStats && (
            <Tooltip
              title={`累计问题 ${rectStats.totalIssues} 项 · 已派整改 ${rectStats.created} 项 · 已复检闭环 ${rectStats.closed} 项`}
            >
              <Tag color={rectStats.totalIssues > 0 ? closureTone(rectStats.closureRate) : 'default'}>
                整改闭环率 {rectStats.closureRate}%
              </Tag>
            </Tooltip>
          )}
          <Button size="small" type="link" onClick={() => nav('/execution#inspections')}>
            巡店整改台账 →
          </Button>
        </span>
      }
    >
      <div className="dic-grid">
        <div>
          <h4 className="dic-subtitle">督导 × 月</h4>
          <Table
            size="small"
            rowKey={row => `${row.month}-${row.supervisor}`}
            pagination={false}
            dataSource={summary.bySupervisor}
            columns={[
              { title: '月份', dataIndex: 'month', width: 90 },
              { title: '督导', dataIndex: 'supervisor', width: 110 },
              { title: '巡店', dataIndex: 'inspections', align: 'right', width: 60 },
              { title: '门店数', dataIndex: 'stores', align: 'right', width: 68 },
              {
                title: '均分',
                dataIndex: 'avgScore',
                align: 'right',
                width: 70,
                render: (value: number | null) => <Tag color={scoreTone(value)}>{value ?? '—'}</Tag>,
              },
              { title: '问题', dataIndex: 'issues', align: 'right', width: 60 },
              {
                title: '高危',
                dataIndex: 'highIssues',
                align: 'right',
                width: 60,
                render: (value: number) => (value > 0 ? <Tag color="red">{value}</Tag> : '0'),
              },
            ]}
          />
        </div>
        <div>
          <h4 className="dic-subtitle">门店表现（均分升序，问题店在前）</h4>
          <Table
            size="small"
            rowKey="store"
            pagination={false}
            dataSource={summary.byStore}
            columns={[
              { title: '门店', dataIndex: 'store' },
              { title: '巡店', dataIndex: 'inspections', align: 'right', width: 60 },
              {
                title: '均分',
                dataIndex: 'avgScore',
                align: 'right',
                width: 70,
                render: (value: number | null) => <Tag color={scoreTone(value)}>{value ?? '—'}</Tag>,
              },
              { title: '最低', dataIndex: 'minScore', align: 'right', width: 60 },
              { title: '问题', dataIndex: 'issues', align: 'right', width: 60 },
              {
                title: '最近巡店',
                dataIndex: 'lastAt',
                width: 110,
                render: (value: string) => (
                  <Tooltip title={value}>
                    <span className="dic-time">{String(value || '').slice(5, 16)}</span>
                  </Tooltip>
                ),
              },
              {
                title: '闭环复检',
                key: 'recheck',
                width: 132,
                render: (_: unknown, row: StoreRow) => (
                  <Tooltip title="派给巡店督导（#161 查巡巡）生成复检清单与整改验收方案">
                    <Button
                      size="small"
                      type="link"
                      icon={<ThunderboltOutlined />}
                      onClick={() =>
                        dispatchToEmployee(
                          nav,
                          161,
                          `请对门店「${row.store}」发起巡店复检：近 3 个月已巡店 ${row.inspections} 次、均分 ${row.avgScore ?? '—'}、最低分 ${row.minScore ?? '—'}、累计问题 ${row.issues} 项${row.highIssues > 0 ? `（含高危 ${row.highIssues} 项）` : ''}。请给出针对性复检清单、食安与卫生红线核查项及限期整改验收表。`,
                        )
                      }
                    >
                      派督导复检
                    </Button>
                  </Tooltip>
                ),
              },
            ]}
          />
        </div>
      </div>
      <div className="dic-note">数据来自巡店督导（#161）的归档记录；产出经人工审阅后才代表企业结论。</div>
    </Panel>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Col, DatePicker, InputNumber, Progress, Row, Space, Statistic, Tag, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { api } from '../api/client';
import { Panel } from './Kit';
import { Chart, CHART_COLORS, axisStyle, baseGrid, chartAnimation } from './Charts';

// 企业月度 AI 积分预算 + 用量报表（2026-09 宣讲会承诺：为企业设置月度 token 积分上限，用完需申请补充）。
// 数据全部来自 /admin/credit-budget 与 /admin/credits/usage；消耗口径已在服务端排除充值/赠送流水。

export type BudgetSummary = {
  month: string;
  budget: number | null;
  alertRatio: number;
  used: number;
  settled: number;
  held: number;
  calls: number;
  remaining: number | null;
  forecast: number;
  ratioUsed: number | null;
  state: 'unlimited' | 'ok' | 'alert' | 'exceeded';
  daysInMonth: number;
  dayOfMonth: number;
};
type BudgetPayload = {
  monthlyCreditBudget: number | null;
  budgetAlertRatio: number;
  balance: number;
  summary: BudgetSummary;
};
type UsageRow = {
  key: string;
  label: string;
  calls: number;
  credits: number;
  heldCredits: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  costYuan: number;
  spendYuan: number;
};
type UsageReport = { from: string; to: string; groupBy: string; rows: UsageRow[]; total: UsageRow };

export const BUDGET_STATE_META: Record<BudgetSummary['state'], { label: string; color: string; tag: string }> = {
  unlimited: { label: '未设预算', color: 'var(--ui-muted)', tag: 'default' },
  ok: { label: '正常', color: 'var(--ok)', tag: 'success' },
  alert: { label: '接近预算', color: 'var(--warn)', tag: 'warning' },
  exceeded: { label: '已超预算', color: 'var(--danger)', tag: 'error' },
};

export function budgetPercent(summary: BudgetSummary | null | undefined) {
  if (!summary || summary.budget == null) return 0;
  if (summary.budget === 0) return 100;
  return Math.min(100, Math.round((summary.used / summary.budget) * 100));
}

const fmt = (n: number | null | undefined) => Number(n || 0).toLocaleString('zh-CN');

// ledger：同页签下方的积分池 / 流水区（Admin.tsx 的 CreditsAdmin），由本面板托管渲染，
// 让 Admin.tsx 的挂载保持一行、不再增长。
export function AdminCreditBudgetPanel({ ledger }: { ledger?: ReactNode } = {}) {
  const [data, setData] = useState<BudgetPayload | null>(null);
  const [budgetInput, setBudgetInput] = useState<number | null>(null);
  const [ratioInput, setRatioInput] = useState<number>(80);
  const [saving, setSaving] = useState(false);
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf('month'), dayjs().endOf('month')]);
  const [byDay, setByDay] = useState<UsageReport | null>(null);
  const [byUser, setByUser] = useState<UsageReport | null>(null);
  const [byFeature, setByFeature] = useState<UsageReport | null>(null);

  const loadBudget = () =>
    api.get('/admin/credit-budget').then((d: BudgetPayload) => {
      setData(d);
      setBudgetInput(d.monthlyCreditBudget);
      setRatioInput(Math.round(Number(d.budgetAlertRatio || 0.8) * 100));
    });
  useEffect(() => {
    loadBudget();
  }, []);

  useEffect(() => {
    const qs = `from=${range[0].format('YYYY-MM-DD')}&to=${range[1].format('YYYY-MM-DD')}`;
    Promise.all([
      api.get(`/admin/credits/usage?groupBy=day&${qs}`),
      api.get(`/admin/credits/usage?groupBy=user&${qs}`),
      api.get(`/admin/credits/usage?groupBy=feature&${qs}`),
    ])
      .then(([d, u, f]) => {
        setByDay(d);
        setByUser(u);
        setByFeature(f);
      })
      .catch(() => {});
  }, [range]);

  const save = () => {
    setSaving(true);
    api
      .put('/admin/credit-budget', { monthlyCreditBudget: budgetInput, budgetAlertRatio: ratioInput / 100 })
      .then((d: BudgetPayload) => {
        message.success(
          d.monthlyCreditBudget == null ? '已取消月度预算限制' : `月度预算已设为 ${fmt(d.monthlyCreditBudget)} 积分`,
        );
        setData(d);
        setBudgetInput(d.monthlyCreditBudget);
        setRatioInput(Math.round(Number(d.budgetAlertRatio || 0.8) * 100));
        window.dispatchEvent(new CustomEvent('budget-updated', { detail: d.summary }));
      })
      .finally(() => setSaving(false));
  };

  const dayOption = useMemo(
    () => ({
      ...chartAnimation,
      color: [CHART_COLORS[0]],
      tooltip: { trigger: 'axis' },
      grid: baseGrid,
      xAxis: { type: 'category', data: (byDay?.rows || []).map(r => r.key.slice(5)), ...axisStyle },
      yAxis: { type: 'value', name: '积分', ...axisStyle },
      series: [
        {
          name: '消耗积分',
          type: 'line',
          smooth: true,
          areaStyle: { opacity: 0.12 },
          data: (byDay?.rows || []).map(r => r.credits),
        },
      ],
    }),
    [byDay],
  );
  const userOption = useMemo(() => {
    const rows = (byUser?.rows || []).slice(0, 10);
    return {
      ...chartAnimation,
      color: [CHART_COLORS[1]],
      tooltip: { trigger: 'axis' },
      grid: { ...baseGrid, left: 12 },
      xAxis: { type: 'value', name: '积分', ...axisStyle },
      yAxis: { type: 'category', data: rows.map(r => r.label).reverse(), ...axisStyle },
      series: [{ name: '消耗积分', type: 'bar', data: rows.map(r => r.credits).reverse(), barMaxWidth: 18 }],
    };
  }, [byUser]);
  const featureOption = useMemo(() => {
    const rows = byFeature?.rows || [];
    const top = rows.slice(0, 7);
    const rest = rows.slice(7).reduce((n, r) => n + r.credits, 0);
    const data = top.map(r => ({ name: r.label, value: r.credits }));
    if (rest > 0) data.push({ name: '其他', value: rest });
    return {
      ...chartAnimation,
      color: CHART_COLORS,
      tooltip: { trigger: 'item', formatter: '{b}: {c} 积分 ({d}%)' },
      legend: { bottom: 0, type: 'scroll', textStyle: { color: 'var(--ui-text-2)' } },
      series: [
        {
          name: '按功能',
          type: 'pie',
          radius: ['38%', '68%'],
          center: ['50%', '44%'],
          label: { show: false },
          data,
        },
      ],
    };
  }, [byFeature]);

  if (!data)
    return (
      <>
        <div className="admin-panel-hint">加载中…</div>
        {ledger}
      </>
    );
  const s = data.summary;
  const meta = BUDGET_STATE_META[s.state] || BUDGET_STATE_META.unlimited;
  const percent = budgetPercent(s);
  const dirty =
    (budgetInput ?? null) !== (data.monthlyCreditBudget ?? null) ||
    ratioInput !== Math.round(Number(data.budgetAlertRatio || 0.8) * 100);

  return (
    <div className="admin-budget-stack">
      <Panel title={`月度 AI 预算 · ${s.month}`} extra={<Tag color={meta.tag}>{meta.label}</Tag>}>
        <Row gutter={[12, 12]}>
          <Col xs={24} lg={10}>
            <div className="admin-budget-form">
              <div className="admin-budget-field">
                <span id="admin-budget-amount-label">每月 AI 预算（积分）</span>
                <InputNumber
                  className="admin-budget-input"
                  min={0}
                  max={1_000_000_000}
                  step={1000}
                  precision={0}
                  value={budgetInput}
                  placeholder="留空 = 不限"
                  onChange={v => setBudgetInput(v == null ? null : Number(v))}
                  aria-labelledby="admin-budget-amount-label"
                />
              </div>
              <div className="admin-budget-field">
                <span id="admin-budget-ratio-label">用到多少比例提醒老板（%）</span>
                <InputNumber
                  className="admin-budget-input"
                  min={1}
                  max={100}
                  precision={0}
                  value={ratioInput}
                  onChange={v => setRatioInput(v == null ? 80 : Number(v))}
                  aria-labelledby="admin-budget-ratio-label"
                />
              </div>
              <Space size={8} wrap>
                <Button type="primary" size="small" loading={saving} disabled={!dirty} onClick={save}>
                  保存预算
                </Button>
                <Button size="small" disabled={saving || budgetInput == null} onClick={() => setBudgetInput(null)}>
                  设为不限
                </Button>
              </Space>
              <div className="admin-panel-hint">
                达到预算后 AI 员工的新任务会被拒绝并提示"请老板在后台调整预算"；充值余额不受影响，下月自动恢复。
                按人配额将在后续版本提供。
              </div>
            </div>
          </Col>
          <Col xs={24} lg={14}>
            <div className="admin-budget-progress">
              <Progress
                percent={percent}
                strokeColor={meta.color}
                status={s.state === 'exceeded' ? 'exception' : 'normal'}
                format={() => (s.budget == null ? `已用 ${fmt(s.used)}` : `${percent}%`)}
              />
              <div className="admin-budget-progress-note">
                {s.budget == null
                  ? `未设预算 · 本月已消耗 ${fmt(s.used)} 积分（含在途 ${fmt(s.held)}）`
                  : `已用 ${fmt(s.used)} / ${fmt(s.budget)} 积分 · 预警线 ${Math.round(s.alertRatio * 100)}%`}
              </div>
            </div>
            <Row gutter={[12, 12]} className="admin-budget-stats">
              <Col xs={12} md={6}>
                <Statistic title="本月已用" value={s.used} suffix="分" />
              </Col>
              <Col xs={12} md={6}>
                <Statistic
                  title="剩余额度"
                  value={s.remaining == null ? '不限' : s.remaining}
                  suffix={s.remaining == null ? '' : '分'}
                />
              </Col>
              <Col xs={12} md={6}>
                <Statistic title="预测到月底" value={s.forecast} suffix="分" />
              </Col>
              <Col xs={12} md={6}>
                <Statistic title="本月调用" value={s.calls} suffix="次" />
              </Col>
            </Row>
            {s.state === 'exceeded' && (
              <Alert
                type="error"
                showIcon
                className="admin-budget-alert"
                message="本月预算已用完"
                description="员工发起的 AI 任务会被拒绝。可调高预算后保存，立即恢复。"
              />
            )}
            {s.state === 'alert' && (
              <Alert
                type="warning"
                showIcon
                className="admin-budget-alert"
                message="本月消耗已接近预算"
                description={`按当前速度月底约需 ${fmt(s.forecast)} 积分，${
                  s.budget != null && s.forecast > s.budget ? '预计会超出预算' : '仍在预算内'
                }。`}
              />
            )}
          </Col>
        </Row>
      </Panel>

      <Panel
        title="AI 用量报表"
        extra={
          <Space size={8} wrap>
            <DatePicker.RangePicker
              size="small"
              allowClear={false}
              value={range}
              onChange={d => {
                if (d && d[0] && d[1]) setRange([d[0], d[1]]);
              }}
            />
            <span className="admin-panel-hint admin-budget-total">
              合计 {fmt(byDay?.total.credits)} 积分 · {fmt(byDay?.total.tokens)} tokens · {fmt(byDay?.total.calls)} 次
            </span>
          </Space>
        }
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} lg={12}>
            <div className="admin-budget-chart-title">按天消耗</div>
            <Chart option={dayOption} height={240} ariaLabel="按天消耗积分折线图" />
          </Col>
          <Col xs={24} lg={6}>
            <div className="admin-budget-chart-title">按员工 Top10</div>
            <Chart option={userOption} height={240} ariaLabel="按员工消耗积分排行" />
          </Col>
          <Col xs={24} lg={6}>
            <div className="admin-budget-chart-title">按功能占比</div>
            <Chart option={featureOption} height={240} ariaLabel="按功能消耗积分占比" />
          </Col>
        </Row>
        <div className="admin-search-security-note">
          口径：AI 消耗流水（已结算实扣 + 在途预授权），不含充值、套餐赠送与管理员调整；tokens
          为供应商回传的输入+输出量。
        </div>
      </Panel>
      {ledger}
    </div>
  );
}

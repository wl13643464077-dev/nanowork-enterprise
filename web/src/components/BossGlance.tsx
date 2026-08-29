import { RightOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { fmtMoney } from '../api/client';
import './BossGlance.css';

// 老板「今日一眼」：驾驶舱首屏锚点。
// 设计目标：打开 3 秒内看完——4 个关键数 + 最要紧的一件事 + 堵着的待办。
// 数据全部来自 Dashboard 已有请求（summary/todos/diagnosis），本组件不发新请求。

type GlanceTodos = {
  approvals?: number;
  overdueLeads?: number;
  silentPartners?: number;
  actionableReviewTasks?: number;
  reviewTasks?: number;
  contentEmployeeReviews?: number;
  pendingBadReviews?: number;
  slaOverdueReviews?: number;
  checklistGapYesterday?: number;
};

export default function BossGlance({
  summary,
  todos,
  diagnosis,
  scopeLabel,
  canViewGrowth,
  canViewExecution,
  onNavigate,
}: {
  summary: any;
  todos: GlanceTodos;
  diagnosis: { dimension?: string; issue?: string; suggestion?: string }[] | null;
  scopeLabel: string;
  canViewGrowth: boolean;
  canViewExecution: boolean;
  onNavigate: (path: string) => void;
}) {
  const topIssue = diagnosis?.[0] || null;
  const slaOverdue = Number(todos.slaOverdueReviews) || 0;
  const todoChips = [
    // 超24小时未回的差评单列（行业黄金线），比普通待回复更紧急
    { label: '差评超24h未回', value: slaOverdue, path: '/reviews' },
    { label: '差评待回复', value: Math.max(0, (Number(todos.pendingBadReviews) || 0) - slaOverdue), path: '/reviews' },
    { label: '昨日日清漏检', value: Number(todos.checklistGapYesterday) || 0, path: '/store-ops' },
    { label: '待审批', value: Number(todos.approvals) || 0, path: '/system?tab=approvals' },
    { label: '超期未跟进', value: Number(todos.overdueLeads) || 0, path: '/growth' },
    {
      label: '待处理结果',
      value: Number(todos.actionableReviewTasks ?? todos.reviewTasks) || 0,
      path: '/tasks',
    },
    { label: '内容待确认', value: Number(todos.contentEmployeeReviews) || 0, path: '/content' },
  ].filter(chip => chip.value > 0);

  const metrics = [
    {
      key: 'sales',
      label: `${scopeLabel}销售额`,
      value: fmtMoney(summary.todaySales),
      trend: summary.salesWow,
      path: '/analysis',
      show: true,
    },
    {
      key: 'leads',
      label: `${scopeLabel}新增客户`,
      value: summary.monthLeads ?? '—',
      trend: summary.leadsWow,
      path: '/growth',
      show: canViewGrowth,
    },
    {
      key: 'follow',
      label: '待跟进客户',
      value: summary.pendingFollow ?? '—',
      alert: Number(summary.overdue) > 0 ? `${summary.overdue} 人超期` : '',
      path: '/growth',
      show: canViewGrowth,
    },
    {
      key: 'task',
      label: `${scopeLabel}任务完成率`,
      value: summary.taskRate != null ? `${summary.taskRate}%` : '—',
      path: '/execution',
      show: canViewExecution,
    },
  ].filter(metric => metric.show);

  return (
    <section className="bg-glance" aria-label="今日经营一眼">
      <div className="bg-glance-metrics">
        {metrics.map(metric => (
          <button type="button" key={metric.key} className="bg-glance-metric" onClick={() => onNavigate(metric.path)}>
            <span className="bg-glance-metric-label">{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>
              {metric.alert ? (
                <em className="bg-glance-alert">{metric.alert}</em>
              ) : typeof metric.trend === 'number' ? (
                <em className={metric.trend >= 0 ? 'bg-glance-up' : 'bg-glance-down'}>
                  {metric.trend >= 0 ? '↑' : '↓'} {Math.abs(metric.trend)}%
                </em>
              ) : (
                ' '
              )}
            </small>
          </button>
        ))}
      </div>

      <div className="bg-glance-side">
        {topIssue?.issue ? (
          <button type="button" className="bg-glance-issue" onClick={() => onNavigate('/advisor')}>
            <span className="bg-glance-issue-kicker">最要紧的一件事</span>
            <strong>{topIssue.issue}</strong>
            {topIssue.suggestion && <p>{topIssue.suggestion}</p>}
            <span className="bg-glance-issue-cta">
              问参谋怎么办 <RightOutlined />
            </span>
          </button>
        ) : (
          <div className="bg-glance-issue bg-glance-issue-calm">
            <span className="bg-glance-issue-kicker">经营诊断</span>
            <strong>暂无突出异常</strong>
            <p>数据没有报警；想主动找机会，可以让数字员工做一轮体检。</p>
          </div>
        )}
        <div className="bg-glance-todos">
          {todoChips.length ? (
            todoChips.map(chip => (
              <button type="button" key={chip.label} onClick={() => onNavigate(chip.path)}>
                {chip.label} <b>{chip.value}</b>
              </button>
            ))
          ) : (
            <button type="button" className="bg-glance-dispatch" onClick={() => onNavigate('/employees')}>
              <ThunderboltOutlined /> 今天没有堵着的事 · 去派个活
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

import { Col, Row } from 'antd';

export type DashboardGuideStep = {
  icon: string;
  title: string;
  desc: string;
  to: string;
};

export const DASHBOARD_ROLE_NAMES: Record<string, string> = {
  boss: '老板',
  ops_director: '运营总监',
  manager: '管理层',
  sales: '员工',
  partner: '合伙人',
  admin: '管理员',
};

export function dashboardRoleView(role?: string) {
  const name =
    role === 'boss'
      ? '老板驾驶舱'
      : role === 'ops_director' || role === 'manager'
        ? '经营协同台'
        : role === 'admin'
          ? '经营管理台'
          : role === 'partner'
            ? '合伙人工作台'
            : '我的工作台';
  const summary =
    role === 'sales'
      ? '系统已为你整理客户跟进、任务提交和已开通的 AI 功能入口；所有客户与任务只展示你的授权范围。'
      : role === 'partner'
        ? '合伙人工作台已整理你参与的客户、任务与内容协作，所有数据只展示你的授权范围。'
        : `${name}已汇总当前授权范围内的企业经营记录；请先核对数据范围，再处理风险与增长机会。`;
  return { name, summary };
}

export function buildDashboardGuide(role: string | undefined, modules: string[]): DashboardGuideStep[] {
  const steps: DashboardGuideStep[] = [];
  const hasModule = (module: string) => modules.includes(module);
  const isManagement = ['boss', 'ops_director', 'manager', 'admin'].includes(role || '');
  if (role === 'boss') {
    steps.push({ icon: '💳', title: '充值积分', desc: '统一管理企业AI调用额度和充值记录', to: '/recharge' });
  }
  if (hasModule('execution')) {
    steps.push({
      icon: '✅',
      title: isManagement ? '处理团队任务' : '处理我的任务',
      desc: isManagement
        ? '查看待执行、进行中和待人工验收的经营任务，跟到结果回流'
        : '接单、执行并提交结果，随后查看验收状态',
      to: '/execution',
    });
  }
  if (hasModule('growth')) {
    steps.push({
      icon: '👥',
      title: isManagement ? '跟进客户经营' : '跟进我的客户',
      desc: isManagement ? '查看授权团队的客户、跟进与成交进度' : '维护本人负责客户并记录下一步动作',
      to: '/growth',
    });
  }
  if (hasModule('marshals')) {
    steps.push({
      icon: '🧑‍💼',
      title: '给数字员工派活',
      desc: '按经营问题选择岗位，提交真实材料并跟进审阅',
      to: '/employees',
    });
  }
  if (hasModule('activities')) {
    steps.push({
      icon: '📅',
      title: isManagement ? '推进营销活动' : '处理我的活动',
      desc: '查看本人授权范围内的筹备、邀约、执行与复盘进度',
      to: '/activities',
    });
  }
  if (hasModule('content')) {
    steps.push({
      icon: '✍️',
      title: isManagement ? '管理内容生产' : '处理我的内容任务',
      desc: '进入内容生产仓查看生成、待人工审阅、业务暂不可采用、人工采纳与发布决策状态',
      to: '/content',
    });
  }
  if (hasModule('analysis')) {
    steps.push({
      icon: '📊',
      title: '查看经营复盘',
      desc: '从真实经营记录穿刺到问题、原因和下一步动作',
      to: '/analysis',
    });
  }
  if (hasModule('system') && ['boss', 'admin'].includes(role || '')) {
    steps.push({ icon: '📚', title: '维护企业配置', desc: '管理知识库、权限、提示词和外部集成配置', to: '/system' });
  }
  return steps.map((step, index) => ({ ...step, title: `${index + 1}. ${step.title}` }));
}

export default function DashboardRoleHeader({
  role,
  userName,
  summary,
  isEmpty,
  guide,
  onNavigate,
}: {
  role?: string;
  userName?: string;
  summary: string;
  isEmpty: boolean;
  guide: DashboardGuideStep[];
  onNavigate: (to: string) => void;
}) {
  const hour = new Date().getHours();
  const greeting = hour < 11 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  return (
    <>
      <div
        style={{
          background: 'linear-gradient(100deg, rgba(218,179,105,.14), rgba(218,179,105,.03) 55%, transparent)',
          border: '1px solid rgba(218,179,105,.22)',
          borderRadius: 14,
          padding: '15px 20px',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ui-text)', letterSpacing: 0.5 }}>
          {greeting}，{userName || DASHBOARD_ROLE_NAMES[role || ''] || '伙伴'}　
          <span style={{ color: 'var(--ui-primary)' }}>欢迎回来</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--ui-text-2)', marginTop: 5 }}>{summary}</div>
      </div>
      {isEmpty && (
        <div
          style={{
            background: 'var(--ui-surface)',
            border: '1px solid var(--ui-border-strong)',
            borderRadius: 14,
            padding: '16px 18px',
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ui-text)', marginBottom: 4 }}>
            欢迎使用纳米Work行业版！按下面 {guide.length} 步快速上手
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--ui-muted)', marginBottom: 14 }}>
            系统已按当前账号权限整理可执行入口，跟着引导完成第一轮经营闭环
          </div>
          <Row gutter={[12, 12]}>
            {guide.map(step => (
              <Col xs={12} md={role === 'boss' ? 8 : 6} key={step.title}>
                <button
                  type="button"
                  onClick={() => onNavigate(step.to)}
                  aria-label={`${step.title}：${step.desc}`}
                  style={{
                    appearance: 'none',
                    display: 'block',
                    width: '100%',
                    cursor: 'pointer',
                    background: 'var(--ui-surface)',
                    border: '1px solid var(--ui-border)',
                    borderRadius: 10,
                    padding: '12px 14px',
                    height: '100%',
                    textAlign: 'left',
                    font: 'inherit',
                    color: 'inherit',
                  }}
                >
                  <div style={{ fontSize: 22, marginBottom: 6 }}>{step.icon}</div>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ui-accent)' }}>{step.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', marginTop: 4, lineHeight: 1.6 }}>
                    {step.desc}
                  </div>
                </button>
              </Col>
            ))}
          </Row>
        </div>
      )}
    </>
  );
}

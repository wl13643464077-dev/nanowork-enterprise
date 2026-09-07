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
  if (!['boss', 'ops_director', 'manager', 'sales', 'partner', 'admin'].includes(role || '')) return [];
  return [
    {
      icon: '💡',
      title: '获得经营建议',
      desc: '说清门店遇到的问题，先拿到一份可执行的建议。',
      to: '/advisor',
      module: 'advisor',
    },
    {
      icon: '🎬',
      title: '生成带货视频',
      desc: '上传菜品或门店照片，说一句卖点，制作带货成片。',
      to: '/content?task=ai-sales-video',
      module: 'content',
    },
    {
      icon: '📸',
      title: '生成小红书图文',
      desc: '上传照片和品牌名，生成标题、正文、标签与评论区文案。',
      to: '/content?task=ai-xhs-note',
      module: 'content',
    },
  ].filter(item => modules.includes(item.module));
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
      {isEmpty && guide.length > 0 && (
        <div
          style={{
            background: 'var(--ui-surface)',
            border: '1px solid var(--ui-border-strong)',
            borderRadius: 14,
            padding: '16px 18px',
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ui-text)', marginBottom: 4 }}>先完成一件事</div>
          <div style={{ fontSize: 12.5, color: 'var(--ui-muted)', marginBottom: 14 }}>
            选择这次要拿到的结果，准备好问题或照片就可以开始。
          </div>
          <Row gutter={[12, 12]}>
            {guide.map(step => (
              <Col xs={24} md={8} key={step.title}>
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

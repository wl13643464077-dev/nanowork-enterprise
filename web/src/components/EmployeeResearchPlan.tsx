import './EmployeeResearchPlan.css';

type Props = {
  evidence?: any;
  compact?: boolean;
};

export default function EmployeeResearchPlan({ evidence, compact = false }: Props) {
  const plan = evidence?.skillResearchPlan;
  const quality = evidence?.sourceQuality;
  const lanes = Array.isArray(plan?.lanes) ? plan.lanes : [];
  if (!lanes.length && !quality) return null;
  return (
    <details className={`employee-research-plan${compact ? ' is-compact' : ''}`}>
      <summary>来源资料与检索详情</summary>
      {lanes.length > 0 && (
        <div className="employee-research-lanes">
          {lanes.map((lane: any, index: number) => (
            <div className="employee-research-lane" key={`${lane?.key || 'lane'}-${index}`}>
              <i>{String(index + 1).padStart(2, '0')}</i>
              <span>{lane?.label || '岗位专属取证'}</span>
            </div>
          ))}
        </div>
      )}
      {quality && (
        <footer>
          <span>地点/路网 {Number(quality.locationAnchorCount || 0)}</span>
          <span>直接餐饮证据 {Number(quality.directRestaurantSourceCount || 0)}</span>
          <span>已接受 {Number(quality.acceptedCount || 0)}</span>
          <span>已拒绝 {Number(quality.rejectedCount || 0)}</span>
          <b className={quality.passed === true ? 'is-pass' : 'is-wait'}>
            {quality.passed === true ? '取证门已通过' : '正在取证/未通过'}
          </b>
        </footer>
      )}
    </details>
  );
}

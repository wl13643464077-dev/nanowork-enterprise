import { useMemo } from 'react';
import { Tag, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  ExportOutlined,
  InboxOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { EmployeeWorkbenchBusiness, EmployeeWorkbenchProfile } from '../api/employeeWorkbenchTypes';
import { Chart, axisStyle, chartAnimation } from './Charts';
import { employeePortraitUrl } from './EmployeeAvatar';
import './EmployeeVisualOverview.css';

/**
 * 员工工作台「总览」—— 全可视化首屏（v1）。
 * 目标：打开工作台第一眼是"一位员工的主页"，不是一份技术文档：
 * 大画像 + 投入产出对比 + 真实任务活跃度图表 + 能力星环 + 工作管道图 + 技能徽章墙。
 * 诚实原则：图表只用真实运行数据；没有数据的图表如实显示"还没有记录"，不编数字。
 */

type Props = {
  profile: EmployeeWorkbenchProfile;
  business?: EmployeeWorkbenchBusiness | null;
  deptColor: string;
};

const fmtYuan = (value: number) =>
  value >= 10000 ? `${(value / 10000).toFixed(value % 10000 === 0 ? 0 : 1)}万` : value.toLocaleString();

/** 从步骤文本提取短标题：**定义机会单元**：xxx → 定义机会单元 */
function stepTitle(step: string, index: number) {
  const match = /\*\*(.+?)\*\*/u.exec(step);
  if (match) return match[1].replace(/[：:]$/u, '');
  const plain = step.replace(/[*_`]/gu, '').trim();
  return plain.length > 8 ? `${plain.slice(0, 8)}…` : plain || `步骤${index + 1}`;
}

export default function EmployeeVisualOverview({ profile, business, deptColor }: Props) {
  const identity = profile.identity;
  const runtime = profile.runtime || {};
  const portrait = typeof identity.idx === 'number' ? employeePortraitUrl(identity.idx) : null;
  const capabilities = Array.isArray(profile.capabilities) ? profile.capabilities : [];
  const method = profile.workMethod || {};
  const inputs = Array.isArray(method.inputs || method.requiredInputs) ? (method.inputs || method.requiredInputs)! : [];
  const steps = Array.isArray(method.steps) ? method.steps : [];
  const deliverables = Array.isArray(method.deliverables) ? method.deliverables : [];
  const skills = profile.skillLibrary || {};
  const requiredSkills = Array.isArray(skills.required) ? skills.required : [];
  const optionalSkills = Array.isArray((skills as { optional?: unknown[] }).optional)
    ? ((skills as { optional?: { title?: string; name?: string }[] }).optional as { title?: string; name?: string }[])
    : [];
  const learnedSkills = Array.isArray((skills as { learned?: unknown[] }).learned)
    ? ((skills as { learned?: { title?: string; name?: string }[] }).learned as { title?: string; name?: string }[])
    : [];
  const displayName = identity.person || identity.name;
  const roleName = identity.name && identity.name !== displayName ? identity.name : '';

  // 近14天任务活跃度（真实 recentTasks 聚合；不足则如实展示空态）
  const activity = useMemo(() => {
    const tasks = Array.isArray(runtime.recentTasks) ? runtime.recentTasks : [];
    const byDay = new Map<string, number>();
    for (const task of tasks) {
      const raw = String(task.created_at || task.createdAt || '').slice(0, 10);
      if (raw) byDay.set(raw, (byDay.get(raw) || 0) + 1);
    }
    const days: string[] = [];
    const counts: number[] = [];
    const now = new Date();
    for (let offset = 13; offset >= 0; offset -= 1) {
      const day = new Date(now.getTime() - offset * 86400000);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      days.push(key.slice(5));
      counts.push(byDay.get(key) || 0);
    }
    return { days, counts, total: tasks.length, has: counts.some(count => count > 0) };
  }, [runtime.recentTasks]);

  const activityOption = useMemo(
    () => ({
      grid: { left: 4, right: 4, top: 8, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category',
        data: activity.days,
        ...axisStyle,
        axisLabel: { fontSize: 9, interval: 3 },
      },
      yAxis: { type: 'value', minInterval: 1, ...axisStyle, axisLabel: { fontSize: 9 } },
      series: [
        {
          type: 'bar',
          data: activity.counts,
          barMaxWidth: 14,
          itemStyle: { color: deptColor, borderRadius: [4, 4, 0, 0] },
        },
      ],
      tooltip: { trigger: 'axis' },
      ...chartAnimation,
    }),
    [activity, deptColor],
  );

  const done = Number(runtime.completedRuns || 0);
  const pending = Number(runtime.reviewPendingRuns || 0);
  const running = Number(runtime.runningTasks || 0);
  const totalTasks = Number(runtime.tasks || 0);

  const roiRatio = business
    ? Math.max(1, Math.round(business.typicalValue / Math.max(0.01, business.cost.typicalYuan)))
    : null;

  return (
    <div className="evo" style={{ ['--evo-color' as string]: deptColor }}>
      {/* ===== 画像主页区 ===== */}
      <section className="evo-hero">
        <div className="evo-portrait">
          {portrait ? (
            <img src={portrait} alt="" onError={event => (event.currentTarget.style.display = 'none')} />
          ) : (
            <span aria-hidden="true">
              <UserOutlined />
            </span>
          )}
          <i className={`evo-status ${identity.status === '执行中' ? 'busy' : ''}`} aria-hidden="true" />
        </div>
        <div className="evo-id">
          <h2>
            {displayName}
            {roleName && <small>{roleName}</small>}
          </h2>
          <div className="evo-id-tags">
            <Tag color="blue">
              {typeof identity.department === 'object' ? identity.department?.name : identity.group}
            </Tag>
            <Tag>{identity.status || '在岗'}</Tag>
            {identity.extension && <Tag color="purple">扩展岗</Tag>}
          </div>
          <p>{business?.intro || identity.intro || identity.duty}</p>
        </div>
        {business && (
          <Tooltip title={`${business.basis} ${business.reference}`}>
            <div className="evo-roi" aria-label="投入产出对比">
              <div className="evo-roi-side">
                <span>单次投入</span>
                <strong>{business.cost.typicalCredits} 积分</strong>
                <em>¥{business.cost.typicalYuan}</em>
              </div>
              <div className="evo-roi-flow" aria-hidden="true">
                <i />
                <b>≈1 : {roiRatio?.toLocaleString()}</b>
                <i />
              </div>
              <div className="evo-roi-side evo-roi-gain">
                <span>参考价值</span>
                <strong>¥{fmtYuan(business.typicalValue)}</strong>
                <em>{business.unit.replace('元', '')}</em>
              </div>
            </div>
          </Tooltip>
        )}
      </section>

      {/* ===== KPI + 活跃度图 ===== */}
      <section className="evo-row">
        <div className="evo-kpis">
          {[
            { label: '累计任务', value: totalTasks },
            { label: '已完成', value: done },
            { label: '待处理', value: pending },
            { label: '执行中', value: running },
          ].map(item => (
            <div className="evo-kpi" key={item.label}>
              <strong>{item.value}</strong>
              <span>{item.label}</span>
            </div>
          ))}
        </div>
        <div className="evo-chart-card">
          <h3>近 14 天任务活跃度</h3>
          {activity.has ? (
            <Chart option={activityOption} height={130} ariaLabel="近14天任务活跃度柱状图" />
          ) : (
            <div className="evo-empty">这名员工近 14 天还没有任务记录——派第一单活就有曲线了</div>
          )}
        </div>
      </section>

      {/* ===== 能力星环 ===== */}
      {capabilities.length > 0 && (
        <section className="evo-card">
          <h3>必备能力星环 · {capabilities.length} 项全锁定</h3>
          <div className="evo-orbit" style={{ ['--n' as string]: capabilities.length }}>
            <div className="evo-orbit-center">
              {portrait ? (
                <img src={portrait} alt="" />
              ) : (
                <span aria-hidden="true">
                  <UserOutlined />
                </span>
              )}
            </div>
            {capabilities.map((capability, index) => (
              <Tooltip
                key={capability.id || capability.name || index}
                title={capability.description || capability.desc || ''}
              >
                <div className="evo-orbit-node" style={{ ['--i' as string]: index }}>
                  <i aria-hidden="true">
                    <ThunderboltOutlined />
                  </i>
                  <span>{String(capability.name || '').slice(0, 6)}</span>
                </div>
              </Tooltip>
            ))}
          </div>
        </section>
      )}

      {/* ===== 工作管道图 ===== */}
      {(inputs.length > 0 || steps.length > 0 || deliverables.length > 0) && (
        <section className="evo-card">
          <h3>工作管道 · 从输入到交付</h3>
          <div className="evo-pipe">
            <div className="evo-pipe-node evo-pipe-in">
              <i aria-hidden="true">
                <InboxOutlined />
              </i>
              <strong>{inputs.length}</strong>
              <span>项输入</span>
            </div>
            <div className="evo-pipe-link" aria-hidden="true" />
            <div className="evo-pipe-steps">
              {steps.slice(0, 7).map((step, index) => (
                <Tooltip key={index} title={step.replace(/[*_`]/gu, '')}>
                  <div className="evo-pipe-step">
                    <i>{index + 1}</i>
                    <span>{stepTitle(step, index)}</span>
                  </div>
                </Tooltip>
              ))}
              {steps.length > 7 && <div className="evo-pipe-step evo-pipe-more">+{steps.length - 7}</div>}
            </div>
            <div className="evo-pipe-link" aria-hidden="true" />
            <div className="evo-pipe-node evo-pipe-out">
              <i aria-hidden="true">
                <ExportOutlined />
              </i>
              <strong>{deliverables.length}</strong>
              <span>类交付物</span>
            </div>
          </div>
          <div className="evo-pipe-deliverables">
            {deliverables.slice(0, 4).map((item, index) => (
              <span key={index}>
                <CheckCircleOutlined aria-hidden="true" /> {String(item).replace(/。$/u, '').slice(0, 24)}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* ===== 技能徽章墙 ===== */}
      {(requiredSkills.length > 0 || optionalSkills.length > 0 || learnedSkills.length > 0) && (
        <section className="evo-card">
          <h3>技能徽章墙</h3>
          <div className="evo-badges">
            {requiredSkills.map((skill, index) => (
              <span className="evo-badge evo-badge-core" key={`r${index}`}>
                <SafetyCertificateOutlined aria-hidden="true" />{' '}
                {String(
                  (skill as { title?: string; name?: string }).title ||
                    (skill as { name?: string }).name ||
                    '岗位 Skill',
                )}
              </span>
            ))}
            {learnedSkills.slice(0, 10).map((skill, index) => (
              <span className="evo-badge" key={`l${index}`}>
                <CheckCircleOutlined aria-hidden="true" /> {String(skill.title || skill.name || '').slice(0, 14)}
              </span>
            ))}
            {learnedSkills.length > 10 && (
              <span className="evo-badge evo-badge-more">+{learnedSkills.length - 10} 张历史技能</span>
            )}
            {optionalSkills.slice(0, 6).map((skill, index) => (
              <span className="evo-badge evo-badge-opt" key={`o${index}`}>
                <ToolOutlined aria-hidden="true" /> {String(skill.title || skill.name || '').slice(0, 14)}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

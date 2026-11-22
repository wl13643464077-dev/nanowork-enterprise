import { useState, type ReactNode } from 'react';
import { Tooltip } from 'antd';
import {
  ApiOutlined,
  BookOutlined,
  CalculatorOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  DownOutlined,
  EnvironmentOutlined,
  FileDoneOutlined,
  GlobalOutlined,
  PictureOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  ToolOutlined,
  UpOutlined,
} from '@ant-design/icons';
import type { EmployeeExpertKernelDetail, EmployeeKernelTool } from '../api/employeeWorkbenchTypes';
import './EmployeeKernelBlueprint.css';

type BlueprintProps = {
  kernel: EmployeeExpertKernelDetail;
  employeeName: string;
  compact: boolean;
  canOpenSkillLibrary?: boolean;
  onOpenSkillLibrary?: () => void;
};

type DeliveryBarProps = {
  person: string;
  kernel: EmployeeExpertKernelDetail;
  webEvidence?: Record<string, unknown> | null;
  hasCampaignMaterials?: boolean;
};

function toolCategoryIcon(category?: string): ReactNode {
  switch (category) {
    case 'location':
      return <EnvironmentOutlined aria-hidden="true" />;
    case 'compliance':
      return <SafetyCertificateOutlined aria-hidden="true" />;
    case 'creative':
      return <PictureOutlined aria-hidden="true" />;
    case 'data':
      return <DatabaseOutlined aria-hidden="true" />;
    case 'research':
      return <GlobalOutlined aria-hidden="true" />;
    case 'knowledge':
      return <BookOutlined aria-hidden="true" />;
    case 'analysis':
      return <CalculatorOutlined aria-hidden="true" />;
    case 'collaboration':
      return <TeamOutlined aria-hidden="true" />;
    default:
      return <ToolOutlined aria-hidden="true" />;
  }
}

function toolCategoryClass(category?: string): string {
  switch (category) {
    case 'location':
    case 'compliance':
    case 'creative':
      return 'is-signature';
    case 'data':
    case 'research':
      return 'is-evidence';
    default:
      return 'is-core';
  }
}

export default function EmployeeKernelBlueprint({
  kernel,
  employeeName,
  compact,
  canOpenSkillLibrary = false,
  onOpenSkillLibrary,
}: BlueprintProps) {
  const [userExpanded, setUserExpanded] = useState(false);
  const expanded = !compact || userExpanded;

  const tools = Array.isArray(kernel.tools) ? kernel.tools : [];
  const steps = Array.isArray(kernel.workflowSteps) ? kernel.workflowSteps : [];
  const skills = Array.isArray(kernel.coreSkills) ? kernel.coreSkills : [];
  const deliverables = Array.isArray(kernel.deliverables) ? kernel.deliverables : [];

  const summaryTools = tools.slice(0, 3);
  const extraToolCount = Math.max(0, tools.length - summaryTools.length);

  if (!expanded) {
    return (
      <section className="ekb-compact-bar" aria-label={`${employeeName}专家内核摘要`}>
        <div className="ekb-compact-main">
          <span className="ekb-compact-badge">
            <SafetyCertificateOutlined aria-hidden="true" />
            专家内核
          </span>
          <span className="ekb-compact-meta">
            <strong>{kernel.skillCount}</strong> 项真人技能 · <strong>{kernel.stepCount}</strong> 步工作流 · 调用工具：
          </span>
          <span className="ekb-compact-tools">
            {summaryTools.map(tool => (
              <span key={tool.key} className={`ekb-tool-pill ${toolCategoryClass(tool.category)}`}>
                {toolCategoryIcon(tool.category)}
                <span>{tool.shortLabel}</span>
              </span>
            ))}
            {extraToolCount > 0 && <span className="ekb-tool-pill is-more">+{extraToolCount}</span>}
          </span>
        </div>
        <div className="ekb-compact-actions">
          <button type="button" className="ekb-action-btn" aria-expanded={false} onClick={() => setUserExpanded(true)}>
            展开专家流程
            <DownOutlined aria-hidden="true" />
          </button>
          {canOpenSkillLibrary && onOpenSkillLibrary && (
            <button type="button" className="ekb-action-btn is-link" onClick={onOpenSkillLibrary}>
              完整技能库
            </button>
          )}
        </div>
      </section>
    );
  }

  const visibleSkills = skills.slice(0, 6);
  const hiddenSkillCount = Math.max(0, skills.length - visibleSkills.length);

  return (
    <section className="ekb-panel" aria-label={`${employeeName}真人专家内核与工具链`}>
      <header className="ekb-header">
        <div className="ekb-header-copy">
          <div className="ekb-title-row">
            <span className="ekb-title-icon" aria-hidden="true">
              <ApiOutlined />
            </span>
            <h3>真人专家内核 · 技能流程与调用工具</h3>
            <span className="ekb-origin-tag">{kernel.humanOriginTag}</span>
          </div>
          <p className="ekb-stats">
            {employeeName}沉淀 <strong>{kernel.skillCount}</strong> 项真人实战技能、
            <strong>{kernel.stepCount}</strong> 步专家工作流，开工自动调用 <strong>{tools.length}</strong> 项真实工具链
          </p>
        </div>
        <div className="ekb-header-actions">
          {canOpenSkillLibrary && onOpenSkillLibrary && (
            <button type="button" className="ekb-action-btn is-link" onClick={onOpenSkillLibrary}>
              <BookOutlined aria-hidden="true" />
              完整技能库
            </button>
          )}
          {compact && (
            <button
              type="button"
              className="ekb-action-btn"
              aria-expanded={true}
              onClick={() => setUserExpanded(false)}
            >
              收起
              <UpOutlined aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      {/* ① 真人专家工作流步骤流 */}
      <div className="ekb-block">
        <div className="ekb-block-head">
          <span className="ekb-block-index">01</span>
          <h4>真人专家工作流</h4>
          <small>按行业专家真实作业顺序执行，不跳步、不凑字</small>
        </div>
        {steps.length > 0 ? (
          <div className="ekb-workflow" role="list" aria-label="专家工作流步骤">
            {steps.map(step => (
              <Tooltip key={step.index} title={step.summary}>
                <div className="ekb-step-card" role="listitem">
                  <span className="ekb-step-num">Step {step.index}</span>
                  <strong className="ekb-step-title">{step.title}</strong>
                  <span className="ekb-step-summary">{step.summary}</span>
                </div>
              </Tooltip>
            ))}
            <div className="ekb-step-card is-deliverable" role="listitem">
              <span className="ekb-step-num">
                <FileDoneOutlined aria-hidden="true" /> 成品交付
              </span>
              <strong className="ekb-step-title">{deliverables[0] || '标准化岗位交付报告'}</strong>
              <span className="ekb-step-summary">
                {deliverables.length > 1 ? `含 ${deliverables.slice(0, 3).join(' · ')}` : '附带来源证据与下一步行动项'}
              </span>
            </div>
          </div>
        ) : (
          <div className="ekb-redacted-note">
            已锁定 {kernel.stepCount} 步真人专家工作流与 {kernel.skillCount}{' '}
            项实战技能；派活后由服务端自动按完整流程执行。
            {deliverables.length > 0 && (
              <span className="ekb-redacted-deliverables">标准成品：{deliverables.join(' · ')}</span>
            )}
          </div>
        )}
      </div>

      {/* ② 自动调用的真实工具链 */}
      {tools.length > 0 && (
        <div className="ekb-block">
          <div className="ekb-block-head">
            <span className="ekb-block-index">02</span>
            <h4>自动调用的真实工具链</h4>
            <small>与通用聊天模型不同，开工自动接入企业数据与外部真工具</small>
          </div>
          <div className="ekb-tools-grid">
            {tools.map((tool: EmployeeKernelTool) => (
              <article key={tool.key} className={`ekb-tool-card ${toolCategoryClass(tool.category)}`}>
                <div className="ekb-tool-card-top">
                  <span className="ekb-tool-icon">{toolCategoryIcon(tool.category)}</span>
                  <strong>{tool.label}</strong>
                  <span className="ekb-tool-short">{tool.shortLabel}</span>
                </div>
                {tool.desc && <p>{tool.desc}</p>}
              </article>
            ))}
          </div>
        </div>
      )}

      {/* ③ 核心真人技能徽章 */}
      {visibleSkills.length > 0 && (
        <div className="ekb-block">
          <div className="ekb-block-head">
            <span className="ekb-block-index">03</span>
            <h4>核心真人技能</h4>
            <small>
              {canOpenSkillLibrary && onOpenSkillLibrary
                ? '点击任一技能徽章可直达完整技能手册'
                : '每次派活自动注入执行上下文'}
            </small>
          </div>
          <div className="ekb-skill-badges">
            {visibleSkills.map(skill =>
              canOpenSkillLibrary && onOpenSkillLibrary ? (
                <button
                  key={skill.title}
                  type="button"
                  className="ekb-skill-chip is-clickable"
                  onClick={onOpenSkillLibrary}
                >
                  <CheckCircleOutlined aria-hidden="true" />
                  <span>{skill.title}</span>
                </button>
              ) : (
                <span key={skill.title} className="ekb-skill-chip">
                  <CheckCircleOutlined aria-hidden="true" />
                  <span>{skill.title}</span>
                </span>
              ),
            )}
            {hiddenSkillCount > 0 &&
              (canOpenSkillLibrary && onOpenSkillLibrary ? (
                <button type="button" className="ekb-skill-chip is-more is-clickable" onClick={onOpenSkillLibrary}>
                  +{hiddenSkillCount} 项真人技能 · 查看全部
                </button>
              ) : (
                <span className="ekb-skill-chip is-more">+{hiddenSkillCount} 项真人技能</span>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function EmployeeDeliveryKernelBar({
  person,
  kernel,
  webEvidence,
  hasCampaignMaterials = false,
}: DeliveryBarProps) {
  const tools = Array.isArray(kernel.tools) ? kernel.tools : [];
  const sourceQuality =
    webEvidence && typeof webEvidence.sourceQuality === 'object' && webEvidence.sourceQuality
      ? (webEvidence.sourceQuality as Record<string, unknown>)
      : null;
  const acceptedSources = Number(sourceQuality?.acceptedCount || 0);
  const locationAnchors = Number(sourceQuality?.locationAnchorCount || 0);

  return (
    <div className="ekb-delivery-bar" role="status" aria-label="本次实调工具与专家流程核验">
      <div className="ekb-delivery-lead">
        <CheckCircleOutlined className="ekb-delivery-check" aria-hidden="true" />
        <strong>
          已按 {person} {kernel.stepCount} 步专家流程执行
        </strong>
        {acceptedSources > 0 && <span className="ekb-delivery-fact">核验公开来源 {acceptedSources} 条</span>}
        {locationAnchors > 0 && <span className="ekb-delivery-fact">地图定位 {locationAnchors} 处</span>}
        {hasCampaignMaterials && <span className="ekb-delivery-fact">已生成活动物料成图</span>}
      </div>
      {tools.length > 0 && (
        <div className="ekb-delivery-tools" aria-label="本次启用的真实工具链">
          <span className="ekb-delivery-tools-label">已接入工具：</span>
          {tools.map(tool => (
            <Tooltip key={tool.key} title={tool.desc || tool.label}>
              <span className={`ekb-tool-pill ${toolCategoryClass(tool.category)}`}>
                {toolCategoryIcon(tool.category)}
                <span>{tool.shortLabel}</span>
              </span>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
}

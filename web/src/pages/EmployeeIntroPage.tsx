import { useEffect, useMemo, useState } from 'react';
import { Button } from 'antd';
import { ArrowLeftOutlined, IdcardOutlined, ToolOutlined } from '@ant-design/icons';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import EmployeeKernelBlueprint from '../components/EmployeeKernelBlueprint';
import EmployeeSelfIntro from '../components/EmployeeSelfIntro';
import type {
  EmployeeExpertKernelDetail,
  EmployeeWorkbenchDomain,
  EmployeeWorkbenchProfile,
} from '../api/employeeWorkbenchTypes';
import './Employees.css';
import './EmployeeIntroPage.css';

type IntroKernelSummary = {
  employeeName: string;
  expertKernel: EmployeeExpertKernelDetail | null;
  workflowSteps: string[];
  toolNames: string[];
};

function parseWorkbenchKernel(data: unknown): IntroKernelSummary | null {
  if (!data || typeof data !== 'object') return null;
  const wrapped = data as Record<string, unknown>;
  const profile = (
    wrapped.profile && typeof wrapped.profile === 'object' ? wrapped.profile : wrapped
  ) as Partial<EmployeeWorkbenchProfile>;
  const identity = profile.identity;
  const employeeName =
    (typeof identity?.person === 'string' && identity.person.trim()) ||
    (typeof identity?.name === 'string' && identity.name.trim()) ||
    '这位数字员工';
  const expertKernel = profile.expertKernel || null;
  const workflowSteps = Array.isArray(profile.workMethod?.steps)
    ? profile.workMethod.steps.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  const runtimeTools = Array.isArray(profile.runtimeBindings?.tools) ? profile.runtimeBindings.tools : [];
  const toolNames = runtimeTools.map(item => String(item?.id || item?.kind || '').trim()).filter(Boolean);
  if (!expertKernel && !workflowSteps.length && !toolNames.length) return null;
  return { employeeName, expertKernel, workflowSteps, toolNames };
}

// 数字员工自我介绍独立页：/employees/:domain/:idx/intro
// 给周校验通知直达用；页面壳负责导航与专家内核补充展示，内容与工作台抽屉共用同一组件。
export default function EmployeeIntroPage() {
  const params = useParams<{ domain: string; idx: string }>();
  const nav = useNavigate();
  const target = useMemo(() => {
    const domain = params.domain === 'restaurant' || params.domain === 'content' ? params.domain : null;
    const idx = /^\d+$/u.test(params.idx || '') ? Number(params.idx) : NaN;
    if (!domain || !Number.isSafeInteger(idx)) return null;
    return { domain: domain as EmployeeWorkbenchDomain, idx };
  }, [params.domain, params.idx]);

  const [kernelState, setKernelState] = useState<{ key: string; summary: IntroKernelSummary | null }>({
    key: '',
    summary: null,
  });
  const targetKey = target ? `${target.domain}:${target.idx}` : '';

  useEffect(() => {
    if (!target) return;
    let active = true;
    const reqKey = `${target.domain}:${target.idx}`;
    api
      .get(`/employee-workbench/${target.domain}/${target.idx}`, { silent: true })
      .then((payload: unknown) => {
        if (!active) return;
        setKernelState({ key: reqKey, summary: parseWorkbenchKernel(payload) });
      })
      .catch(() => {
        if (!active) return;
        setKernelState({ key: reqKey, summary: null });
      });
    return () => {
      active = false;
    };
  }, [target]);

  if (!target) return <Navigate to="/employees" replace />;

  const kernelSummary = kernelState.key === targetKey ? kernelState.summary : null;
  const workbenchUrl =
    target.domain === 'restaurant' ? `/employees?employee=${target.idx}` : `/content?employee=${target.idx}`;

  return (
    <div className="employee-page employee-intro-page">
      <section className="employee-directory-head" aria-labelledby="employee-intro-title">
        <div className="employee-directory-copy">
          <div className="employee-kicker">
            <IdcardOutlined /> 数字员工 · 自我介绍
          </div>
          <h1 id="employee-intro-title">TA 现在认为自己是谁</h1>
          <p>
            四段内容全部来自服务端：岗位目录、交付物、本企业已生效的提示词与心得、老板叮嘱。每周一自动校验，发现漂移就提醒你确认。
          </p>
        </div>
        <div className="employee-intro-nav">
          <Button icon={<ArrowLeftOutlined />} onClick={() => nav(-1)}>
            返回
          </Button>
          <Link to={workbenchUrl}>
            <Button type="primary">
              {target.domain === 'restaurant' ? '去工作台直接派活 →' : '打开工作台 · 派活'}
            </Button>
          </Link>
        </div>
      </section>
      <EmployeeSelfIntro domain={target.domain} idx={target.idx} />
      {kernelSummary && (
        <div className="employee-intro-kernel">
          {kernelSummary.expertKernel ? (
            <EmployeeKernelBlueprint
              kernel={kernelSummary.expertKernel}
              employeeName={kernelSummary.employeeName}
              compact={false}
            />
          ) : (
            <section className="employee-intro-kernel-fallback" aria-label="真人专家流程步骤与真实工具链">
              <header className="employee-intro-kernel-head">
                <h3>真人专家流程步骤与工具链</h3>
                <small>来自岗位工作方式与生产运行绑定</small>
              </header>
              {kernelSummary.workflowSteps.length > 0 && (
                <ol className="employee-intro-steps">
                  {kernelSummary.workflowSteps.map((step, index) => (
                    <li key={`${index}-${step}`}>
                      <span className="employee-intro-step-index">Step {index + 1}</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              )}
              {kernelSummary.toolNames.length > 0 && (
                <div className="employee-intro-tools" aria-label="真实工具链">
                  {kernelSummary.toolNames.map(tool => (
                    <span key={tool} className="employee-intro-tool-pill">
                      <ToolOutlined aria-hidden="true" />
                      <span>{tool}</span>
                    </span>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}
      {target.domain === 'restaurant' && (
        <section className="employee-intro-cta" aria-label="前往工作台派活">
          <div className="employee-intro-cta-copy">
            <strong>准备好让 {kernelSummary?.employeeName || '这位数字员工'} 开工了吗？</strong>
            <span>进入工作台即可一句话派活，自动按上方真人专家流程与工具链交付。</span>
          </div>
          <Link to={workbenchUrl}>
            <Button type="primary" size="middle">
              去工作台直接派活 →
            </Button>
          </Link>
        </section>
      )}
    </div>
  );
}

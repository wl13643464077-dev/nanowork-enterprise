import { useMemo } from 'react';
import { Button } from 'antd';
import { ArrowLeftOutlined, IdcardOutlined } from '@ant-design/icons';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import EmployeeSelfIntro from '../components/EmployeeSelfIntro';
import type { EmployeeWorkbenchDomain } from '../api/employeeWorkbenchTypes';
import './Employees.css';
import './EmployeeIntroPage.css';

// 数字员工自我介绍独立页：/employees/:domain/:idx/intro
// 给周校验通知直达用；页面壳只负责导航，内容与工作台抽屉共用同一组件。
export default function EmployeeIntroPage() {
  const params = useParams<{ domain: string; idx: string }>();
  const nav = useNavigate();
  const target = useMemo(() => {
    const domain = params.domain === 'restaurant' || params.domain === 'content' ? params.domain : null;
    const idx = /^\d+$/u.test(params.idx || '') ? Number(params.idx) : NaN;
    if (!domain || !Number.isSafeInteger(idx)) return null;
    return { domain: domain as EmployeeWorkbenchDomain, idx };
  }, [params.domain, params.idx]);

  if (!target) return <Navigate to="/employees" replace />;

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
          <Link to={`/employees?employee=${target.idx}`}>
            <Button type="primary">打开工作台 · 派活</Button>
          </Link>
        </div>
      </section>
      <EmployeeSelfIntro domain={target.domain} idx={target.idx} />
    </div>
  );
}

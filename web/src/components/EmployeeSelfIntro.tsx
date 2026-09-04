import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Input, Skeleton, Tag, Tooltip, message } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { ErrorState } from './Kit';
import type { EmployeeWorkbenchDomain } from '../api/employeeWorkbenchTypes';
import './EmployeeSelfIntro.css';

// 数字员工「自我介绍」：老板一眼看到 TA 现在认为自己是谁 / 会什么 / 为公司记住了什么，
// 并能随时矫正（老板叮嘱）。校验是零积分的确定性对照，不调模型。

type IntroCheckStatus = 'ok' | 'needs_review' | 'never';

type EmployeeSelfIntroData = {
  domain: string;
  idx: number;
  specialistId: number;
  whoAmI: {
    person: string;
    name: string;
    duty: string;
    positioning: string;
    department: string;
    departmentEmoji?: string;
    emoji?: string;
  };
  whatICanDo: { deliverables: string[]; totalDeliverables: number };
  whatIRemember: {
    enterprisePrompt: {
      present: boolean;
      chars: number;
      text: string | null;
      redacted: boolean;
      boundary: string | null;
    };
    evolutionNotes: { id: number; note: string; rationale: string | null; createdAt: string }[];
    enabledSkillCount: number;
    learnedSkillCount: number;
  };
  ownerNotes: {
    text: string | null;
    source: string;
    updatedAt: string | null;
    maxChars: number;
    injected: boolean;
    fallback: string | null;
  };
  check: {
    status: IntroCheckStatus;
    note: string | null;
    verifiedAt: string | null;
    verifiedDaysAgo: number | null;
  };
  permissions: { canEdit: boolean; canVerify: boolean; canViewEnterprisePrompt: boolean };
};

type VerifyResponse = {
  result: { status: IntroCheckStatus; note: string | null; findings: { message: string }[] };
  intro: EmployeeSelfIntroData;
};

type Props = {
  domain: EmployeeWorkbenchDomain;
  idx: number;
  /** 抽屉里嵌入时给一个「在独立页打开」的入口；独立页自身不需要 */
  showStandaloneLink?: boolean;
  onChanged?: (data: EmployeeSelfIntroData) => void;
};

const STATUS_COPY: Record<IntroCheckStatus, { label: string; hint: string }> = {
  ok: { label: '介绍已确认', hint: '与岗位目录、安全边界一致' },
  needs_review: { label: '需要你确认', hint: '每周自动校验发现了需要老板看一眼的地方' },
  never: { label: '尚未校验', hint: '还没有做过自我介绍校验；点「现在检查一次」立即对照岗位目录' },
};

function StatusIcon({ status }: { status: IntroCheckStatus }) {
  if (status === 'ok') return <CheckCircleOutlined />;
  if (status === 'needs_review') return <ExclamationCircleOutlined />;
  return <ClockCircleOutlined />;
}

export default function EmployeeSelfIntro({ domain, idx, showStandaloneLink = false, onChanged }: Props) {
  const [data, setData] = useState<EmployeeSelfIntroData | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const apply = useCallback(
    (next: EmployeeSelfIntroData) => {
      setData(next);
      setDraft(next.ownerNotes.text || '');
      setError('');
      onChanged?.(next);
    },
    [onChanged],
  );

  const load = useCallback(
    () =>
      api
        .get(`/employee-intro/${domain}/${idx}`)
        .then((payload: EmployeeSelfIntroData) => apply(payload))
        .catch((err: any) => setError(err?.message || '自我介绍读取失败')),
    [apply, domain, idx],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState description={error} onRetry={() => void load()} />;
  // 切换员工时旧数据先隐藏，等新员工的介绍回来再渲染，避免把上一位的叮嘱短暂显示在这一位名下
  if (!data || data.idx !== idx || data.domain !== domain) return <Skeleton active paragraph={{ rows: 8 }} />;

  const { whoAmI, whatICanDo, whatIRemember, ownerNotes, check, permissions } = data;
  const dirty = draft.trim() !== (ownerNotes.text || '');
  const overLimit = draft.length > ownerNotes.maxChars;

  const save = async () => {
    if (overLimit) return;
    setSaving(true);
    try {
      const next = await api.put(`/employee-intro/${domain}/${idx}`, { text: draft.trim() });
      apply(next);
      message.success(draft.trim() ? '老板叮嘱已保存，下次派活生效' : '已清空老板叮嘱，回落到岗位默认介绍');
    } catch {
      /* client 已 toast */
    } finally {
      setSaving(false);
    }
  };

  const verify = async () => {
    setVerifying(true);
    try {
      const out: VerifyResponse = await api.post(`/employee-intro/${domain}/${idx}/verify`, {});
      apply(out.intro);
      message[out.result.status === 'ok' ? 'success' : 'warning'](
        out.result.status === 'ok' ? '检查完成：与岗位目录一致，没有发现问题' : '检查完成：有需要你确认的地方',
      );
    } catch {
      /* client 已 toast */
    } finally {
      setVerifying(false);
    }
  };

  const confirm = async () => {
    setConfirming(true);
    try {
      const next = await api.post(`/employee-intro/${domain}/${idx}/confirm`, {});
      apply(next);
      message.success('已记录你的确认，30 天内不再提醒');
    } catch {
      /* client 已 toast */
    } finally {
      setConfirming(false);
    }
  };

  const statusCopy = STATUS_COPY[check.status] || STATUS_COPY.never;
  const verifiedText =
    check.verifiedAt && check.verifiedDaysAgo !== null
      ? check.verifiedDaysAgo === 0
        ? '今天确认过'
        : `上次确认于 ${check.verifiedDaysAgo} 天前`
      : '老板还没有确认过';

  return (
    <div className="esi" aria-label={`${whoAmI.person}的自我介绍`}>
      <div className="esi-status" data-status={check.status} role="status">
        <span className="esi-status-icon" aria-hidden="true">
          <StatusIcon status={check.status} />
        </span>
        <div className="esi-status-copy">
          <strong>{statusCopy.label}</strong>
          <span>
            {check.status === 'ok' ? verifiedText : statusCopy.hint}
            {check.status !== 'ok' && check.verifiedAt ? `（${verifiedText}）` : ''}
          </span>
          {check.status === 'needs_review' && check.note && <em className="esi-status-note">{check.note}</em>}
        </div>
        {permissions.canVerify && (
          <div className="esi-status-actions">
            {check.status === 'needs_review' && (
              <Button
                type="primary"
                size="small"
                icon={<CheckCircleOutlined />}
                loading={confirming}
                onClick={() => void confirm()}
              >
                我看过了，没问题
              </Button>
            )}
            <Button size="small" icon={<ReloadOutlined />} loading={verifying} onClick={() => void verify()}>
              现在检查一次
            </Button>
          </div>
        )}
        {showStandaloneLink && (
          <Link className="esi-standalone" to={`/employees/${domain}/${idx}/intro`}>
            在独立页打开
          </Link>
        )}
      </div>

      <section className="esi-card" aria-label="我是谁">
        <header>
          <span className="esi-card-step">①</span>
          <h4>我是谁</h4>
          <small>来自岗位目录，不可改</small>
        </header>
        <p className="esi-who">
          <strong>{whoAmI.person}</strong>
          <span>
            {whoAmI.departmentEmoji ? `${whoAmI.departmentEmoji} ` : ''}
            {whoAmI.department} · {whoAmI.name} · #{idx}
          </span>
        </p>
        <p className="esi-positioning">{whoAmI.positioning || whoAmI.duty}</p>
      </section>

      <section className="esi-card" aria-label="我能为你做什么">
        <header>
          <span className="esi-card-step">②</span>
          <h4>我能为你做什么</h4>
          <small>
            核心交付物 {whatICanDo.deliverables.length} / {whatICanDo.totalDeliverables}
          </small>
        </header>
        {whatICanDo.deliverables.length ? (
          <ul className="esi-list">
            {whatICanDo.deliverables.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="岗位目录未登记交付物" />
        )}
      </section>

      <section className="esi-card" aria-label="我为贵公司记住了什么">
        <header>
          <span className="esi-card-step">③</span>
          <h4>我为贵公司记住了什么</h4>
          <small>只读汇总，来自企业提示词 / 进化心得 / 技能库</small>
        </header>
        <div className="esi-memory">
          <div className="esi-memory-item">
            <span className="esi-memory-label">企业补充提示词</span>
            {whatIRemember.enterprisePrompt.present ? (
              <>
                <Tag color="processing">{whatIRemember.enterprisePrompt.chars} 字</Tag>
                {whatIRemember.enterprisePrompt.text ? (
                  <details className="esi-prompt">
                    <summary>查看原文</summary>
                    <pre>{whatIRemember.enterprisePrompt.text}</pre>
                  </details>
                ) : (
                  <Tooltip title={whatIRemember.enterprisePrompt.boundary || ''}>
                    <span className="esi-muted">原文仅管理层可见</span>
                  </Tooltip>
                )}
              </>
            ) : (
              <span className="esi-muted">未设置，按出厂岗位手册工作</span>
            )}
          </div>
          <div className="esi-memory-item">
            <span className="esi-memory-label">已采纳的实战心得</span>
            {whatIRemember.evolutionNotes.length ? (
              <ul className="esi-list esi-notes">
                {whatIRemember.evolutionNotes.map(note => (
                  <li key={note.id}>
                    <strong>{note.note}</strong>
                    {note.rationale && <span>为什么：{note.rationale}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="esi-muted">还没有生效心得（在工作台「进化」里采纳提案后出现）</span>
            )}
          </div>
          <div className="esi-memory-item">
            <span className="esi-memory-label">启用技能</span>
            <span>
              <Tag>{whatIRemember.enabledSkillCount} 项启用</Tag>
              {whatIRemember.learnedSkillCount > 0 && (
                <Tag color="success">{whatIRemember.learnedSkillCount} 项进修</Tag>
              )}
            </span>
          </div>
        </div>
      </section>

      <section className="esi-card esi-owner" aria-label="老板叮嘱">
        <header>
          <span className="esi-card-step">④</span>
          <h4>老板叮嘱</h4>
          <small>
            {ownerNotes.injected ? (
              <>
                <SafetyCertificateOutlined /> 派活时注入，只能补充不能覆盖岗位手册
              </>
            ) : (
              '空着时按岗位默认介绍工作'
            )}
          </small>
        </header>
        {permissions.canEdit ? (
          <>
            <Input.TextArea
              className="esi-owner-editor"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              autoSize={{ minRows: 4, maxRows: 14 }}
              placeholder={`例如：我们是社区早餐店，所有结论先按早高峰算；报告开头先给一句话结论。\n（留空即回落到岗位默认介绍：${ownerNotes.fallback || whoAmI.positioning}）`}
              maxLength={ownerNotes.maxChars + 200}
            />
            <div className="esi-owner-actions">
              <span className={`esi-owner-count${overLimit ? ' over' : ''}`}>
                {draft.length} / {ownerNotes.maxChars}
              </span>
              {ownerNotes.updatedAt && <span className="esi-muted">上次修改 {ownerNotes.updatedAt.slice(0, 16)}</span>}
              <Button
                type="primary"
                size="small"
                loading={saving}
                disabled={!dirty || overLimit}
                onClick={() => void save()}
              >
                保存叮嘱
              </Button>
            </div>
          </>
        ) : ownerNotes.text ? (
          <p className="esi-owner-readonly">{ownerNotes.text}</p>
        ) : (
          <p className="esi-owner-readonly esi-muted">{ownerNotes.fallback || '老板还没有给这位员工写叮嘱。'}</p>
        )}
      </section>
    </div>
  );
}

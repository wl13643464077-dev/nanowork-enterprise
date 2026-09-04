import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, InputNumber, Radio, Select, Tag, message } from 'antd';
import {
  DeleteOutlined,
  LockOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  SoundOutlined,
} from '@ant-design/icons';
import { api } from '../api/client';
import { ROLE_MAP } from './SystemPrimitives';
import './ApprovalPolicyPanel.css';

/**
 * 企业审批规则面板（B9 审批策略下放企业老板）。
 * 自包含：加载 / 保存 / 300ms 防抖预览全部在本组件内完成；System.tsx 只挂引用。
 * 三块：① 数字员工产出（四选一 + 按分部/员工例外）② 营销活动（模式 + 金额阈值）③ 三条底线（只读）。
 * 底部“用大白话说就是…”直接调服务端 preview，前端不复制文案，保证前后端同口径。
 */

type ExceptionScope = 'department' | 'employee';
type EmployeeMode = 'auto' | 'risk_based' | 'manager' | 'boss';

interface PolicyException {
  scope: ExceptionScope;
  id: string | number;
  mode: EmployeeMode;
}

interface PolicyDraft {
  employeeOutput: { mode: string; reviewerUserId: number | null; exceptions: PolicyException[] };
  activityPlan: { mode: string; reviewerUserId: number | null; ownerAmountThreshold: number };
  activityChecklist: { mode: string; reviewerUserId: number | null };
}

interface CatalogDepartment {
  code: string;
  name: string;
}

interface CatalogEmployee {
  idx: number;
  name: string;
  departmentCode: string;
}

interface ReviewerCandidate {
  id: number;
  name: string;
  role: string;
  dept?: string;
}

interface PreviewLine {
  key: string;
  text: string;
}

const EMPLOYEE_MODES: { value: EmployeeMode; label: string; hint: string }[] = [
  { value: 'auto', label: '自动采用', hint: '日常产出通过质量门与账务门后直接可用，不用你审。' },
  { value: 'risk_based', label: '按风险分流', hint: '低风险自动采用；中风险店长审；高风险你亲自审。' },
  { value: 'manager', label: '店长审', hint: '每一份产出先由店长（负责人）审过才算数。' },
  { value: 'boss', label: '老板审', hint: '每一份产出都进入你的待办。' },
];

const PLAN_MODES = [
  { value: 'two_step', label: '店长初审 → 老板终审' },
  { value: 'manager', label: '店长审过即可' },
  { value: 'boss', label: '一律老板签字' },
  { value: 'amount_threshold', label: '按金额分流（超阈值找老板）' },
];

const CHECKLIST_MODES = [
  { value: 'two_step', label: '店长确认 → 老板终审' },
  { value: 'manager', label: '店长确认即可' },
  { value: 'boss', label: '一律老板确认' },
];

const EXCEPTION_MODE_LABEL: Record<EmployeeMode, string> = {
  auto: '自动采用',
  risk_based: '按风险分流',
  manager: '店长审',
  boss: '老板审',
};

const FALLBACK_SAFEGUARDS = [
  '对外发布/发送始终需要老板执行授权',
  '真实付费动作始终需要老板执行授权',
  '不可逆动作（删除、账号操作等）始终需要老板执行授权',
];

function toDraft(policy: any): PolicyDraft {
  return {
    employeeOutput: {
      mode: policy?.employeeOutput?.mode || 'auto',
      reviewerUserId: policy?.employeeOutput?.reviewerUserId ?? null,
      exceptions: Array.isArray(policy?.employeeOutput?.exceptions)
        ? policy.employeeOutput.exceptions.map((item: any) => ({ scope: item.scope, id: item.id, mode: item.mode }))
        : [],
    },
    activityPlan: {
      mode: policy?.activityPlan?.mode || 'two_step',
      reviewerUserId: policy?.activityPlan?.reviewerUserId ?? null,
      ownerAmountThreshold: Number(policy?.activityPlan?.ownerAmountThreshold ?? 10000),
    },
    activityChecklist: {
      mode: policy?.activityChecklist?.mode || 'two_step',
      reviewerUserId: policy?.activityChecklist?.reviewerUserId ?? null,
    },
  };
}

function toPayload(draft: PolicyDraft) {
  return {
    employeeOutput: {
      mode: draft.employeeOutput.mode,
      reviewerUserId: draft.employeeOutput.reviewerUserId,
      exceptions: draft.employeeOutput.exceptions.filter(item => item.id !== '' && item.id !== null),
    },
    activityPlan: {
      mode: draft.activityPlan.mode,
      reviewerUserId: draft.activityPlan.mode === 'boss' ? null : draft.activityPlan.reviewerUserId,
      ownerAmountThreshold: draft.activityPlan.ownerAmountThreshold,
    },
    activityChecklist: {
      mode: draft.activityChecklist.mode,
      reviewerUserId: draft.activityChecklist.mode === 'boss' ? null : draft.activityChecklist.reviewerUserId,
    },
  };
}

function reviewerLabel(candidate: ReviewerCandidate) {
  return `${candidate.name}·${ROLE_MAP[candidate.role]?.label || candidate.role}${candidate.dept ? `·${candidate.dept}` : ''}`;
}

export default function ApprovalPolicyPanel() {
  const [policy, setPolicy] = useState<any>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [catalog, setCatalog] = useState<{ departments: CatalogDepartment[]; employees: CatalogEmployee[] }>({
    departments: [],
    employees: [],
  });
  const [reviewers, setReviewers] = useState<ReviewerCandidate[]>([]);
  const [safeguards, setSafeguards] = useState<string[]>(FALLBACK_SAFEGUARDS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ key: string; lines: PreviewLine[] } | null>(null);
  const [previewError, setPreviewError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    return api
      .get('/sys/approval-policy', { silent: true })
      .then((payload: any) => {
        const next = payload?.policy || null;
        setPolicy(next);
        setDraft(next ? toDraft(next) : null);
        setCanEdit(payload?.canEdit === true);
        setCatalog({
          departments: Array.isArray(payload?.catalog?.departments) ? payload.catalog.departments : [],
          employees: Array.isArray(payload?.catalog?.employees) ? payload.catalog.employees : [],
        });
        setReviewers(Array.isArray(payload?.reviewerCandidates) ? payload.reviewerCandidates : []);
        if (Array.isArray(payload?.immutableSafeguards) && payload.immutableSafeguards.length) {
          setSafeguards(payload.immutableSafeguards.map(String));
        }
      })
      .catch((err: any) => setError(err?.message || '审批规则加载失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const draftKey = useMemo(() => (draft ? JSON.stringify(toPayload(draft)) : ''), [draft]);
  const savedKey = useMemo(() => (policy ? JSON.stringify(toPayload(toDraft(policy))) : ''), [policy]);
  const dirty = !!draft && !!policy && draftKey !== savedKey;
  const incompleteException = !!draft && draft.employeeOutput.exceptions.some(item => item.id === '');
  const previewStale = !!preview && preview.key !== draftKey;

  // 300ms 防抖：草稿一变就请求服务端渲染大白话；只读用户也能看到当前规则的预览。
  useEffect(() => {
    if (!draft) return undefined;
    const key = draftKey;
    const timer = window.setTimeout(() => {
      api
        .post('/sys/approval-policy/preview', { policy: JSON.parse(key) }, { silent: true })
        .then((payload: any) => {
          setPreview({ key, lines: Array.isArray(payload?.lines) ? payload.lines : [] });
          setPreviewError('');
        })
        .catch((err: any) => setPreviewError(err?.message || '预览暂不可用'));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, draftKey]);

  const patch = (updater: (current: PolicyDraft) => PolicyDraft) => {
    if (!canEdit) return;
    setDraft(current => (current ? updater(current) : current));
  };

  const updateExceptions = (updater: (list: PolicyException[]) => PolicyException[]) =>
    patch(current => ({
      ...current,
      employeeOutput: { ...current.employeeOutput, exceptions: updater(current.employeeOutput.exceptions) },
    }));

  const save = () => {
    if (!canEdit || !draft) return;
    setSaving(true);
    setError('');
    api
      .put('/sys/approval-policy', { policy: toPayload(draft) }, { silent: true })
      .then((payload: any) => {
        const next = payload?.policy || null;
        if (next) {
          setPolicy(next);
          setDraft(toDraft(next));
        }
        message.success(payload?.message || '审批规则已保存');
      })
      .catch((err: any) => setError(err?.message || '审批规则保存失败'))
      .finally(() => setSaving(false));
  };

  const employeeReviewers = reviewers;
  const activityReviewers = reviewers.filter(candidate => candidate.role !== 'manager');
  const departmentOptions: { value: string | number; label: string }[] = catalog.departments.map(item => ({
    value: item.code,
    label: `${item.name}（${item.code}）`,
  }));
  const employeeOptions: { value: string | number; label: string }[] = catalog.employees.map(item => ({
    value: item.idx,
    label: `${item.name}（#${item.idx} · ${catalog.departments.find(d => d.code === item.departmentCode)?.name || item.departmentCode}）`,
  }));
  const exceptionTargetLabel = (item: PolicyException) =>
    item.scope === 'department'
      ? catalog.departments.find(d => d.code === item.id)?.name || String(item.id)
      : catalog.employees.find(e => e.idx === Number(item.id))?.name || `员工#${item.id}`;

  const renderReviewerSelect = (
    value: number | null,
    onChange: (next: number | null) => void,
    candidates: ReviewerCandidate[],
    disabled: boolean,
  ) =>
    canEdit ? (
      <Select
        allowClear
        disabled={disabled}
        className="approval-policy__control"
        placeholder={disabled ? '老板审无需指定负责人' : '不指定，按管理职责范围匹配'}
        value={disabled ? undefined : (value ?? undefined)}
        options={candidates.map(candidate => ({ value: candidate.id, label: reviewerLabel(candidate) }))}
        onChange={next => onChange(next ?? null)}
      />
    ) : (
      <div className="approval-policy__card-desc">
        {disabled
          ? '老板审，无需指定负责人'
          : value
            ? `指定负责人：${reviewers.find(candidate => Number(candidate.id) === Number(value))?.name || '已由老板指定'}`
            : '按管理职责范围匹配负责人'}
      </div>
    );

  return (
    <section className="approval-policy" aria-label="企业审批规则">
      <div className="approval-policy__head">
        <div>
          <div className="approval-policy__title">
            <SafetyCertificateOutlined className="approval-policy__title-icon" />
            企业审批规则
            {canEdit ? <Tag color="green">你可以修改</Tag> : <Tag>只读</Tag>}
          </div>
          <div className="approval-policy__subtitle">
            由老板自己决定哪些事要审、谁来审。规则只对保存后新发起的任务生效；在途任务继续用发起时锁定的规则。
          </div>
        </div>
        {policy?.updatedAt && (
          <div className="approval-policy__meta">
            最后更新：{String(policy.updatedAt).slice(0, 19).replace('T', ' ')}
            <br />
            {policy.configuredBy?.name ? `操作人：${policy.configuredBy.name}` : ''}
          </div>
        )}
      </div>

      {error && (
        <Alert
          className="approval-policy__alert"
          type="error"
          showIcon
          message="审批规则未能完成同步"
          description={error}
          action={<Button onClick={load}>重新加载</Button>}
        />
      )}
      {!canEdit && !loading && !error && draft && (
        <Alert
          className="approval-policy__alert"
          type="info"
          showIcon
          message="当前为只读视图"
          description="店长与经理可以查看企业规则；修改请找老板或系统管理员。"
        />
      )}

      {loading && !draft ? (
        <div className="approval-policy__loading">正在读取企业审批规则…</div>
      ) : draft ? (
        <>
          <div className="approval-policy__grid">
            <div className="approval-policy__card">
              <div className="approval-policy__card-title">① 数字员工的日常产出</div>
              <div className="approval-policy__card-desc">
                餐饮与内容数字员工交出的报告、文案等内部产出，要不要有人审？
              </div>
              {canEdit ? (
                <Radio.Group
                  className="approval-policy__radio-group"
                  value={draft.employeeOutput.mode}
                  onChange={event =>
                    patch(current => ({
                      ...current,
                      employeeOutput: {
                        ...current.employeeOutput,
                        mode: event.target.value,
                        reviewerUserId: event.target.value === 'boss' ? null : current.employeeOutput.reviewerUserId,
                      },
                    }))
                  }
                >
                  {EMPLOYEE_MODES.map(option => (
                    <Radio key={option.value} value={option.value}>
                      {option.label}
                      <span className="approval-policy__radio-hint">{option.hint}</span>
                    </Radio>
                  ))}
                </Radio.Group>
              ) : (
                <Tag color="blue">
                  {EMPLOYEE_MODES.find(option => option.value === draft.employeeOutput.mode)?.label ||
                    draft.employeeOutput.mode}
                </Tag>
              )}
              <div className="approval-policy__label">指定店长（负责人）</div>
              {renderReviewerSelect(
                draft.employeeOutput.reviewerUserId,
                next =>
                  patch(current => ({
                    ...current,
                    employeeOutput: { ...current.employeeOutput, reviewerUserId: next },
                  })),
                employeeReviewers,
                draft.employeeOutput.mode === 'boss' || draft.employeeOutput.mode === 'auto',
              )}

              <div className="approval-policy__label">
                按分部 / 岗位例外 <Tag>员工例外 &gt; 分部例外 &gt; 上面的默认</Tag>
              </div>
              <div className="approval-policy__exceptions">
                {draft.employeeOutput.exceptions.length === 0 && (
                  <div className="approval-policy__exception-empty">
                    暂无例外。例如：“财务与数据部的产出一律老板审”。
                  </div>
                )}
                {canEdit
                  ? draft.employeeOutput.exceptions.map((item, index) => (
                      <div className="approval-policy__exception-row" key={`${item.scope}-${index}`}>
                        <Select
                          value={item.scope}
                          options={[
                            { value: 'department', label: '按分部' },
                            { value: 'employee', label: '按员工' },
                          ]}
                          onChange={scope =>
                            updateExceptions(list =>
                              list.map((row, i) => (i === index ? { ...row, scope, id: '' } : row)),
                            )
                          }
                        />
                        <Select
                          showSearch
                          optionFilterProp="label"
                          placeholder={item.scope === 'department' ? '选择分部' : '选择数字员工'}
                          value={item.id === '' ? undefined : item.id}
                          options={item.scope === 'department' ? departmentOptions : employeeOptions}
                          onChange={id =>
                            updateExceptions(list => list.map((row, i) => (i === index ? { ...row, id } : row)))
                          }
                        />
                        <Select
                          value={item.mode}
                          options={EMPLOYEE_MODES.map(option => ({
                            value: option.value,
                            label: EXCEPTION_MODE_LABEL[option.value],
                          }))}
                          onChange={mode =>
                            updateExceptions(list => list.map((row, i) => (i === index ? { ...row, mode } : row)))
                          }
                        />
                        <Button
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          aria-label="删除这条例外"
                          onClick={() => updateExceptions(list => list.filter((_, i) => i !== index))}
                        />
                      </div>
                    ))
                  : draft.employeeOutput.exceptions.map((item, index) => (
                      <div className="approval-policy__exception-readonly" key={`${item.scope}-${index}`}>
                        <Tag>{item.scope === 'department' ? '分部' : '员工'}</Tag>
                        {exceptionTargetLabel(item)} → <b>{EXCEPTION_MODE_LABEL[item.mode] || item.mode}</b>
                      </div>
                    ))}
                {canEdit && (
                  <div>
                    <Button
                      size="small"
                      icon={<PlusOutlined />}
                      onClick={() => updateExceptions(list => [...list, { scope: 'department', id: '', mode: 'boss' }])}
                    >
                      按分部加一行
                    </Button>{' '}
                    <Button
                      size="small"
                      icon={<PlusOutlined />}
                      onClick={() => updateExceptions(list => [...list, { scope: 'employee', id: '', mode: 'boss' }])}
                    >
                      按员工加一行
                    </Button>
                  </div>
                )}
              </div>
            </div>

            <div className="approval-policy__card">
              <div className="approval-policy__card-title">② 营销活动</div>
              <div className="approval-policy__card-desc">活动方案（含预算）与活动执行清单要经过谁。</div>
              <div className="approval-policy__label">活动方案</div>
              {canEdit ? (
                <Select
                  className="approval-policy__control"
                  value={draft.activityPlan.mode}
                  options={PLAN_MODES}
                  onChange={mode => patch(current => ({ ...current, activityPlan: { ...current.activityPlan, mode } }))}
                />
              ) : (
                <Tag color="blue">
                  {PLAN_MODES.find(option => option.value === draft.activityPlan.mode)?.label ||
                    draft.activityPlan.mode}
                </Tag>
              )}
              {draft.activityPlan.mode === 'amount_threshold' && (
                <div className="approval-policy__threshold">
                  <span className="approval-policy__label">金额达到</span>
                  {canEdit ? (
                    <InputNumber
                      min={0}
                      max={1_000_000_000_000}
                      precision={2}
                      step={1000}
                      value={draft.activityPlan.ownerAmountThreshold}
                      onChange={value =>
                        patch(current => ({
                          ...current,
                          activityPlan: { ...current.activityPlan, ownerAmountThreshold: Number(value ?? 0) },
                        }))
                      }
                    />
                  ) : (
                    <Tag color="gold">{Number(draft.activityPlan.ownerAmountThreshold || 0).toLocaleString()}</Tag>
                  )}
                  <span className="approval-policy__label">元需要老板签字</span>
                </div>
              )}
              <div className="approval-policy__label">活动方案的店长（负责人）</div>
              {renderReviewerSelect(
                draft.activityPlan.reviewerUserId,
                next =>
                  patch(current => ({ ...current, activityPlan: { ...current.activityPlan, reviewerUserId: next } })),
                activityReviewers,
                draft.activityPlan.mode === 'boss',
              )}
              <div className="approval-policy__label">活动执行清单（物料、食安、人员分工）</div>
              {canEdit ? (
                <Select
                  className="approval-policy__control"
                  value={draft.activityChecklist.mode}
                  options={CHECKLIST_MODES}
                  onChange={mode =>
                    patch(current => ({ ...current, activityChecklist: { ...current.activityChecklist, mode } }))
                  }
                />
              ) : (
                <Tag color="blue">
                  {CHECKLIST_MODES.find(option => option.value === draft.activityChecklist.mode)?.label ||
                    draft.activityChecklist.mode}
                </Tag>
              )}
            </div>

            <div className="approval-policy__card approval-policy__card--locked">
              <div className="approval-policy__card-title">
                <LockOutlined className="approval-policy__safeguard-icon" /> ③ 三条底线（不可关闭）
              </div>
              <div className="approval-policy__card-desc">
                不管上面怎么选，下面三类动作都必须先经过你的“执行授权”才会真正发生。这是服务端硬编码，任何角色都改不了，也不会因为改规则被绕过。
              </div>
              <div className="approval-policy__safeguards">
                {safeguards.map(item => (
                  <div className="approval-policy__safeguard" key={item}>
                    <LockOutlined className="approval-policy__safeguard-icon" />
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="approval-policy__preview" aria-live="polite">
            <div className="approval-policy__preview-title">
              <SoundOutlined /> 用大白话说就是…
              {previewStale && <Tag>正在更新</Tag>}
            </div>
            {previewError && !preview ? (
              <div className="approval-policy__card-desc">{previewError}</div>
            ) : preview ? (
              <ol
                className={`approval-policy__preview-lines${previewStale ? ' approval-policy__preview-lines--stale' : ''}`}
              >
                {preview.lines.map(line => (
                  <li
                    key={line.key}
                    className={line.key === 'safeguards' ? 'approval-policy__preview-line--safeguards' : undefined}
                  >
                    {line.text}
                  </li>
                ))}
              </ol>
            ) : (
              <div className="approval-policy__card-desc">正在生成预览…</div>
            )}
          </div>

          {canEdit && (
            <div className="approval-policy__actions">
              {incompleteException && <Tag color="warning">有例外行还没选分部/员工</Tag>}
              <Button disabled={!dirty || saving} onClick={() => setDraft(policy ? toDraft(policy) : null)}>
                撤销未保存修改
              </Button>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={saving}
                disabled={!dirty || incompleteException}
                onClick={save}
              >
                保存审批规则
              </Button>
            </div>
          )}
        </>
      ) : (
        !error &&
        !loading && (
          <div className="approval-policy__loading">
            审批规则未返回 <Button onClick={load}>重新加载</Button>
          </div>
        )
      )}
    </section>
  );
}

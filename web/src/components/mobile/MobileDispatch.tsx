import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Input, Segmented, Select, Skeleton, Tag, message } from 'antd';
import {
  AimOutlined,
  ArrowLeftOutlined,
  CloseOutlined,
  RightOutlined,
  RocketOutlined,
  SendOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { api, getUser } from '../../api/client';
import RestaurantDispatchAssist from '../RestaurantDispatchAssist';
import type { EmployeeWorkbenchProfile } from '../../api/employeeWorkbenchTypes';
import EmployeeAvatar from '../EmployeeAvatar';
import type { MatchedTeam, MatchedTeamMember } from '../EmployeeTeamMatch';
import { UnifiedFilePicker, type UploadedFileRef } from '../UnifiedFilePicker';
import {
  deptToneIndex,
  employeeDisplayName,
  findEmployeeByIdx,
  loadEmployeeCatalog,
  type MobileEmployee,
  type MobileEmployeeCatalog,
} from './employeeCatalog';
import { mobilePath, pushRecentDispatch } from './mobileRoutes';
import './mobile.css';

// 派活 Tab：一句话找人（POST /employees/match-team）+ 按分部折叠的员工目录（GET /employees）
// → 全屏派活页（POST /employee-workbench/restaurant/:idx/dispatch，与桌面同一端点与入参）
// → 成功后跳到该任务的进度页（/m/tasks?task=ID）。

const TEAM_MATCH_KEY = 'nw-mobile-team-match.v2';
const PREFILL_KEY = 'nw-mobile-dispatch-prefill.v1';

type MemberBrief = {
  idx: number;
  person: string;
  name: string;
  roleInTeam: string;
  title: string;
  directive: string;
  deliverables?: string;
};
type TeamPlan = { depth: string; depthLabel: string; briefs: MemberBrief[] };
type TeamSummary = {
  summary: string;
  progress: { idx: number; person: string; name: string; statusLabel: string; highlight?: string }[];
  nextActions?: { action: string; owner: string; timing?: string }[];
  summarizedAt: string;
};
type StoredTeam = {
  query: string;
  team: MatchedTeam;
  matchedAt: string;
  plan?: TeamPlan | null;
  dispatched?: Record<string, { taskId: number; at: string }>;
  teamSummary?: TeamSummary | null;
};
export type DispatchPrefill = {
  idx: number;
  question?: string;
  requirement?: string;
  type?: string;
  fromTaskId?: number;
};

function readStoredTeam(): StoredTeam | null {
  try {
    const raw = window.sessionStorage.getItem(TEAM_MATCH_KEY);
    const parsed = raw ? (JSON.parse(raw) as StoredTeam) : null;
    return parsed?.team?.members?.length ? parsed : null;
  } catch {
    return null;
  }
}

function persistTeam(value: StoredTeam | null) {
  try {
    if (value) window.sessionStorage.setItem(TEAM_MATCH_KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(TEAM_MATCH_KEY);
  } catch {
    /* 隐私模式不可写 */
  }
}

// 「带原话派给TA」「带原要求重新派活」都通过这里预填派活框；表单读一次即清除。
export function writeDispatchPrefill(prefill: DispatchPrefill) {
  try {
    window.sessionStorage.setItem(PREFILL_KEY, JSON.stringify(prefill));
  } catch {
    /* 隐私模式不可写：本次直接进入空表单 */
  }
}

function takeDispatchPrefill(idx: number): DispatchPrefill | null {
  try {
    const raw = window.sessionStorage.getItem(PREFILL_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(PREFILL_KEY);
    const parsed = JSON.parse(raw) as DispatchPrefill;
    return Number(parsed?.idx) === idx ? parsed : null;
  } catch {
    return null;
  }
}

function deptTone(catalog: MobileEmployeeCatalog | null, group: string) {
  return `var(--chart-${deptToneIndex(catalog, group) + 1})`;
}

function typicalCredits(employee: MobileEmployee | null | undefined) {
  const value = Number(employee?.business?.cost?.typicalCredits);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function statusTag(status?: string) {
  if (status === '执行中') return <Tag color="processing">忙碌中</Tag>;
  if (status === '空闲') return <Tag color="success">在岗</Tag>;
  return null;
}

function dispatchTypeOptions(profile: EmployeeWorkbenchProfile | null) {
  const raw = profile?.dispatch?.types || profile?.dispatch?.taskTypes || [];
  return raw
    .map(option => (typeof option === 'string' ? { label: option, value: option } : option))
    .filter(option => option && String(option.label || '').trim() && String(option.value || '').trim());
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.map(item => String(item ?? '').trim()).filter(Boolean) : [];
}

export default function MobileDispatch({ nav, params }: { nav: (path: string) => void; params: URLSearchParams }) {
  const employeeParam = params.get('employee') || '';
  const employeeIdx = /^\d+$/u.test(employeeParam) ? Number(employeeParam) : null;
  if (employeeIdx !== null) return <DispatchForm key={employeeIdx} idx={employeeIdx} nav={nav} />;
  return <DispatchList nav={nav} />;
}

function DispatchList({ nav }: { nav: (path: string) => void }) {
  const personalBilling = getUser()?.accountType === 'tester';
  const [catalog, setCatalog] = useState<MobileEmployeeCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [text, setText] = useState('');
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState('');
  const [stored, setStored] = useState<StoredTeam | null>(() => readStoredTeam());
  const [depth, setDepth] = useState<'simple' | 'full' | 'pro'>('full');
  const [mode, setMode] = useState<'semi' | 'auto'>('semi');
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState('');
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [dispatchingIdxs, setDispatchingIdxs] = useState<Set<number>>(new Set());
  const [bulkDispatching, setBulkDispatching] = useState(false);

  useEffect(() => {
    let active = true;
    loadEmployeeCatalog()
      .then(data => {
        if (!active) return;
        setCatalog(data);
        setError('');
      })
      .catch((err: any) => {
        if (active) setError(err?.message || '数字员工目录读取失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    persistTeam(stored);
  }, [stored]);

  const runMatch = async () => {
    const query = text.trim();
    if (!query) {
      message.warning('先用一句话说说要办什么事');
      return;
    }
    setMatching(true);
    setMatchError('');
    try {
      const payload = await api.post('/employees/match-team', { text: query }, { silent: true });
      const team = payload?.team as MatchedTeam | undefined;
      if (!team?.members?.length) throw new Error('没有匹配到合适的员工，换个说法再试试');
      setStored({ query, team, matchedAt: new Date().toISOString(), plan: null, dispatched: {}, teamSummary: null });
      setPlanError('');
      setSummaryError('');
    } catch (err: any) {
      setMatchError(err?.message || '匹配失败，请稍后再试');
    } finally {
      setMatching(false);
    }
  };

  const dispatchTo = (member: MatchedTeamMember) => {
    writeDispatchPrefill({ idx: member.idx, question: stored?.query || '' });
    nav(mobilePath('dispatch', { employee: member.idx }));
  };

  const dispatchBrief = async (brief: MemberBrief) => {
    if (!stored || stored.dispatched?.[String(brief.idx)]) return true;
    setDispatchingIdxs(current => new Set(current).add(brief.idx));
    try {
      const result = await api.post(
        `/employee-workbench/restaurant/${brief.idx}/dispatch`,
        { question: brief.directive, title: brief.title },
        { silent: true },
      );
      const taskId = Number((result as Record<string, unknown>)?.runId ?? (result as Record<string, unknown>)?.taskId);
      if (!Number.isSafeInteger(taskId) || taskId <= 0) throw new Error('任务已提交但未返回任务编号');
      const record = { taskId, at: new Date().toISOString() };
      setStored(current =>
        current ? { ...current, dispatched: { ...(current.dispatched || {}), [String(brief.idx)]: record } } : current,
      );
      return true;
    } catch (err: any) {
      message.error(`${brief.person}：${err?.message || '派出失败'}`);
      return false;
    } finally {
      setDispatchingIdxs(current => {
        const next = new Set(current);
        next.delete(brief.idx);
        return next;
      });
    }
  };

  const dispatchAll = async (briefs: MemberBrief[], { reset = false } = {}) => {
    const already = reset ? {} : stored?.dispatched || {};
    const pending = briefs.filter(brief => !already[String(brief.idx)]);
    if (!pending.length) return;
    setBulkDispatching(true);
    try {
      const results = await Promise.allSettled(pending.map(brief => dispatchBrief(brief)));
      const ok = results.filter(result => result.status === 'fulfilled' && result.value).length;
      if (ok === pending.length) message.success(`已同时派出 ${ok} 名成员`);
      else if (ok > 0) message.warning(`已派出 ${ok}/${pending.length}，其余可单独重试`);
    } finally {
      setBulkDispatching(false);
    }
  };

  const runPlan = async () => {
    if (!stored?.team?.members?.length) return;
    setPlanning(true);
    setPlanError('');
    try {
      const payload = await api.post(
        '/employees/team-plan',
        {
          text: stored.query,
          depth,
          members: stored.team.members.map(member => ({
            idx: member.idx,
            roleInTeam: member.roleInTeam,
            task: member.task,
            dependsOn: member.dependsOn,
          })),
        },
        { silent: true },
      );
      const nextPlan = payload?.plan as TeamPlan | undefined;
      if (!nextPlan?.briefs?.length) throw new Error('队长没有返回有效拆解');
      if (String(payload?.billing?.state || '').toLowerCase() !== 'settled') {
        throw new Error('拆解已返回，但账务尚未确认结算，本次不派活');
      }
      setStored(current => (current ? { ...current, plan: nextPlan, dispatched: {}, teamSummary: null } : current));
      if (mode === 'auto') {
        message.info('队长拆解完成，全队同时开工…');
        await dispatchAll(nextPlan.briefs, { reset: true });
      }
    } catch (err: any) {
      setPlanError(err?.message || '队长拆解失败');
    } finally {
      setPlanning(false);
    }
  };

  const runSummary = async () => {
    if (!stored) return;
    const items = Object.entries(stored.dispatched || {}).map(([idx, record]) => ({
      idx: Number(idx),
      taskId: record.taskId,
    }));
    if (!items.length) {
      message.warning('先派出至少一单，再让队长汇总');
      return;
    }
    setSummarizing(true);
    setSummaryError('');
    try {
      const payload = await api.post('/employees/team-summary', { text: stored.query, items }, { silent: true });
      const summary = payload?.teamSummary as TeamSummary | undefined;
      if (!summary?.summary) throw new Error('队长没有给出有效汇总');
      if (payload?.billing?.state !== 'settled') throw new Error('汇总已生成，费用尚未完成结算');
      setStored(current => (current ? { ...current, teamSummary: summary } : current));
    } catch (err: any) {
      setSummaryError(err?.message || '队长汇总失败');
    } finally {
      setSummarizing(false);
    }
  };

  const grouped = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    const map = new Map<string, MobileEmployee[]>();
    for (const employee of catalog?.employees || []) {
      if (
        q &&
        ![employee.person, employee.name, employee.duty, employee.desc, employee.group].some(value =>
          String(value || '')
            .toLowerCase()
            .includes(q),
        )
      )
        continue;
      const group = employee.group || '其他';
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(employee);
    }
    return [...map.entries()];
  }, [catalog, keyword]);

  return (
    <div className="m-stack">
      <section className="m-card m-match-box" aria-label="一句话找人">
        <div className="m-card-title">
          <span>
            <AimOutlined /> 不知道找谁？一句话说事
          </span>
          <small>AI 读花名册挑人</small>
        </div>
        <Input.TextArea
          value={text}
          onChange={event => setText(event.target.value)}
          placeholder="例：周年庆想做一场引流活动，怎么策划"
          autoSize={{ minRows: 2, maxRows: 4 }}
          maxLength={300}
        />
        <div className="m-match-actions">
          <Button type="primary" icon={<AimOutlined />} loading={matching} onClick={() => void runMatch()}>
            {matching ? 'AI 挑人中，通常 20~60 秒…' : '帮我选'}
          </Button>
        </div>
        {matchError && <Alert type="error" showIcon message={matchError} className="m-block-gap" />}
        {stored && (
          <div className="m-team-list" aria-label={`${stored.team.teamName}协同小队`}>
            <div className="m-card-title">
              <span>
                {stored.team.teamName} · {stored.team.members.length} 人
              </span>
              <Button
                size="small"
                type="text"
                icon={<CloseOutlined />}
                aria-label="关闭小队结果"
                onClick={() => setStored(null)}
              >
                关闭
              </Button>
            </div>
            {stored.team.summary && <p className="m-text-2">{stored.team.summary}</p>}
            {stored.team.members.map(member => (
              <button
                key={member.idx}
                type="button"
                className="m-row-button"
                onClick={() => dispatchTo(member)}
                aria-label={`带原话派给${member.person || member.name}`}
              >
                <EmployeeAvatar
                  idx={member.idx}
                  name={member.person || member.name}
                  color={deptTone(catalog, member.group)}
                  size={40}
                />
                <span className="m-row-main">
                  <span className="m-row-title">
                    {member.person || member.name}
                    <Tag color={member.roleInTeam === '队长' ? 'gold' : 'default'}>{member.roleInTeam}</Tag>
                    <span className="m-muted">{member.name}</span>
                  </span>
                  {member.task && <span className="m-team-task">分工：{member.task}</span>}
                </span>
                <SendOutlined className="m-row-arrow" />
              </button>
            ))}
            <p className="m-muted">点任一成员单独派活；也可以让队长拆解后半自动确认或全自动同时开工。</p>
            <div className="m-team-orchestrate" aria-label="队长拆解派活">
              <div className="m-card-title">
                <span>
                  <ThunderboltOutlined /> 让队长拆解分工
                </span>
              </div>
              <Segmented
                size="small"
                value={mode}
                onChange={value => setMode(value as 'semi' | 'auto')}
                options={[
                  { value: 'semi', label: '半自动 · 逐个确认' },
                  { value: 'auto', label: '全自动 · 同时开工' },
                ]}
                block
              />
              <Segmented
                size="small"
                value={depth}
                onChange={value => setDepth(value as 'simple' | 'full' | 'pro')}
                options={[
                  { value: 'simple', label: '简单' },
                  { value: 'full', label: '全面' },
                  { value: 'pro', label: '专业' },
                ]}
                block
              />
              <Button
                type="primary"
                icon={<RocketOutlined />}
                loading={planning}
                disabled={matching || summarizing || bulkDispatching}
                onClick={() => void runPlan()}
                block
              >
                {planning ? '队长拆解中…' : stored.plan ? '重新拆解' : '让队长拆解分工'}
              </Button>
              {planError && <Alert type="error" showIcon message={planError} className="m-block-gap" />}
              {stored.plan?.briefs?.length ? (
                <div className="m-team-briefs">
                  {mode === 'semi' && stored.plan.briefs.some(brief => !stored.dispatched?.[String(brief.idx)]) && (
                    <Button
                      size="small"
                      type="primary"
                      loading={bulkDispatching}
                      onClick={() => void dispatchAll(stored.plan!.briefs)}
                      block
                    >
                      全队同时开工（{stored.plan.briefs.filter(brief => !stored.dispatched?.[String(brief.idx)]).length}
                      ）
                    </Button>
                  )}
                  {stored.plan.briefs.map(brief => {
                    const record = stored.dispatched?.[String(brief.idx)];
                    return (
                      <article className="m-team-brief" key={brief.idx}>
                        <strong>
                          {brief.person}
                          {brief.roleInTeam === '队长' ? ' · 队长' : ''}
                        </strong>
                        <p>{brief.title}</p>
                        {record ? (
                          <Button size="small" onClick={() => nav(mobilePath('tasks', { task: record.taskId }))}>
                            看任务进度
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            type="primary"
                            loading={dispatchingIdxs.has(brief.idx)}
                            disabled={bulkDispatching}
                            onClick={() => void dispatchBrief(brief)}
                          >
                            派出这单
                          </Button>
                        )}
                      </article>
                    );
                  })}
                </div>
              ) : null}
              <Button
                loading={summarizing}
                disabled={!Object.keys(stored.dispatched || {}).length}
                onClick={() => void runSummary()}
                block
              >
                {summarizing ? '队长汇总中…' : stored.teamSummary ? '刷新队长总结' : '让队长收尾汇总'}
              </Button>
              {summaryError && <Alert type="error" showIcon message={summaryError} className="m-block-gap" />}
              {stored.teamSummary && (
                <div className="m-team-summary">
                  <p className="m-text-2">{stored.teamSummary.summary}</p>
                  {(stored.teamSummary.progress || []).map(row => (
                    <p key={row.idx} className="m-muted">
                      {row.person} · {row.statusLabel} · {row.highlight || '—'}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      <section aria-label="按分部选员工" className="m-stack">
        <Input.Search
          allowClear
          value={keyword}
          onChange={event => setKeyword(event.target.value)}
          placeholder="搜姓名、岗位或分部"
          aria-label="搜索数字员工"
        />
        {loading ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : error ? (
          <Alert
            type="error"
            showIcon
            message="数字员工目录读取失败"
            description={error}
            action={
              <Button
                size="small"
                onClick={() => {
                  setLoading(true);
                  loadEmployeeCatalog({ force: true })
                    .then(data => {
                      setCatalog(data);
                      setError('');
                    })
                    .catch((err: any) => setError(err?.message || '数字员工目录读取失败'))
                    .finally(() => setLoading(false));
                }}
              >
                重试
              </Button>
            }
          />
        ) : !grouped.length ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={keyword ? '没有匹配的员工' : '目录里还没有可用的数字员工'}
          />
        ) : (
          grouped.map(([group, employees], index) => (
            <details key={group} className="m-group" open={index === 0 || Boolean(keyword.trim())}>
              <summary>
                <span>{group}</span>
                <small>{employees.length} 人</small>
              </summary>
              <div className="m-group-body">
                {employees.map(employee => {
                  const credits = typicalCredits(employee);
                  return (
                    <button
                      key={employee.idx}
                      type="button"
                      className="m-row-button"
                      onClick={() => nav(mobilePath('dispatch', { employee: employee.idx }))}
                      aria-label={`给${employeeDisplayName(employee)}派活`}
                    >
                      <EmployeeAvatar
                        idx={employee.idx}
                        name={employeeDisplayName(employee)}
                        color={deptTone(catalog, employee.group)}
                        size={44}
                      />
                      <span className="m-row-main">
                        <span className="m-row-title">{employeeDisplayName(employee)}</span>
                        <span className="m-row-sub">{employee.duty || employee.name}</span>
                      </span>
                      <span className="m-emp-status">
                        {statusTag(employee.status)}
                        {personalBilling ? (
                          <small>个人 Key 计费</small>
                        ) : (
                          credits !== null && <small>约 {credits} 积分/次</small>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </details>
          ))
        )}
      </section>
    </div>
  );
}

function DispatchForm({ idx, nav }: { idx: number; nav: (path: string) => void }) {
  const personalBilling = getUser()?.accountType === 'tester';
  const [prefill] = useState(() => takeDispatchPrefill(idx));
  const [profile, setProfile] = useState<EmployeeWorkbenchProfile | null>(null);
  const [employee, setEmployee] = useState<MobileEmployee | null>(null);
  const [catalog, setCatalog] = useState<MobileEmployeeCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [question, setQuestion] = useState(prefill?.question || '');
  const [requirement, setRequirement] = useState(prefill?.requirement || '');
  const [type, setType] = useState<string | undefined>(prefill?.type || undefined);
  const [files, setFiles] = useState<UploadedFileRef[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // PRD v2.2：手机端与桌面同一套常用问法、题型预判与追问（FR-13 / FR-1 / FR-2）
  const [intentType, setIntentType] = useState<string | null>(null);
  const [followupAnswers, setFollowupAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    Promise.all([
      api.get(`/employee-workbench/restaurant/${idx}`, { silent: true }) as Promise<EmployeeWorkbenchProfile>,
      loadEmployeeCatalog().catch(() => null),
    ])
      .then(([data, list]) => {
        if (!active) return;
        setProfile(data);
        setCatalog(list);
        setEmployee(findEmployeeByIdx(list, idx));
        setError('');
      })
      .catch((err: any) => {
        if (active) setError(err?.message || '员工资料读取失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [idx]);

  const types = useMemo(() => dispatchTypeOptions(profile), [profile]);
  const identity = profile?.identity;
  const displayName = String(identity?.person || identity?.name || employeeDisplayName(employee) || `员工 ${idx}`);
  const credits = typicalCredits(employee);
  const guidance = profile?.dispatch?.guidance || {};
  const materials = stringList(guidance.materialChecklist).length
    ? stringList(guidance.materialChecklist)
    : stringList(profile?.workMethod?.requiredInputs || profile?.workMethod?.inputs);
  const deliverables = stringList(guidance.deliverableChecklist).length
    ? stringList(guidance.deliverableChecklist)
    : stringList(profile?.workMethod?.deliverables);
  const examples = stringList(guidance.taskExamples);
  const canDispatch = profile?.permissions?.canDispatch !== false;

  const submit = async () => {
    const goal = question.trim();
    if (!goal) {
      message.warning('先说一句要TA做什么');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.post(`/employee-workbench/restaurant/${idx}/dispatch`, {
        question: goal,
        ...(type ? { type } : {}),
        ...(requirement.trim() ? { requirement: requirement.trim() } : {}),
        ...(files.length ? { fileIds: files.map(file => file.id) } : {}),
        ...(intentType ? { intentType } : {}),
        ...(Object.keys(followupAnswers).length ? { followupAnswers } : {}),
      });
      const payload = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
      const taskId = Number(payload.runId ?? payload.taskId);
      if (!Number.isSafeInteger(taskId) || taskId <= 0) {
        message.success('任务已派发，可在「任务」里查看进度');
        nav(mobilePath('tasks'));
        return;
      }
      pushRecentDispatch({ id: taskId, title: goal.slice(0, 60), employee: displayName, at: new Date().toISOString() });
      message.success(`已派给${displayName}，正在生成`);
      nav(mobilePath('tasks', { task: taskId }));
    } catch {
      // api 客户端已提示服务端错误（含预算/积分拦截）；保留表单便于修正后重试
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="m-stack m-has-action-bar">
      <div className="m-page-head">
        <button
          type="button"
          className="m-page-back"
          aria-label="返回员工列表"
          onClick={() => nav(mobilePath('dispatch'))}
        >
          <ArrowLeftOutlined />
        </button>
        <h2>给 {displayName} 派活</h2>
      </div>
      {loading ? (
        <Skeleton active avatar paragraph={{ rows: 5 }} />
      ) : error ? (
        <Alert type="error" showIcon message="员工资料读取失败" description={error} />
      ) : (
        <>
          <div className="m-card m-dispatch-emp">
            <EmployeeAvatar
              idx={idx}
              name={displayName}
              color={deptTone(catalog, String(identity?.group || employee?.group || ''))}
              size={52}
            />
            <div className="m-row-main">
              <strong>{displayName}</strong>
              <span>
                {identity?.name || employee?.name}
                {identity?.status || employee?.status ? ` · ${identity?.status || employee?.status}` : ''}
              </span>
            </div>
            {statusTag(String(identity?.status || employee?.status || ''))}
          </div>
          {!canDispatch && <Alert type="warning" showIcon message="当前账号无权给这位员工派活" />}
          {prefill?.fromTaskId && (
            <Alert
              type="info"
              showIcon
              message={`已把任务 #${prefill.fromTaskId} 的原要求填回，确认后再提交；这次会重新生成，不复用草稿正文。`}
            />
          )}
          <div className="m-card m-dispatch-form">
            <div>
              <div className="m-field-label">一句话说清目标</div>
              <Input.TextArea
                value={question}
                onChange={event => setQuestion(event.target.value)}
                placeholder={
                  String(guidance.titlePlaceholder || '').trim() ||
                  (examples[0] ? `例：${examples[0]}` : '例：帮我做一份本周的会员复购提升方案')
                }
                autoSize={{ minRows: 3, maxRows: 8 }}
                maxLength={8000}
                disabled={!canDispatch}
              />
              <RestaurantDispatchAssist
                idx={idx}
                question={question}
                intentType={intentType}
                disabled={!canDispatch}
                onPickTemplate={text => setQuestion(text)}
                onIntentTypeChange={setIntentType}
                followupAnswers={followupAnswers}
                onFollowupAnswersChange={setFollowupAnswers}
                canEditPreferences={profile?.permissions?.canEditSkills === true}
              />
            </div>
            {types.length > 0 && (
              <div>
                <div className="m-field-label">任务类型（可选）</div>
                <Select
                  allowClear
                  value={type}
                  onChange={value => setType(value || undefined)}
                  options={types.map(option => ({ label: option.label, value: option.value }))}
                  placeholder="不选则按常规处理"
                  className="m-full"
                  disabled={!canDispatch}
                />
              </div>
            )}
            <details className="m-guide">
              <summary>补充材料与说明（可选）</summary>
              <div className="m-guide-body m-stack">
                <Input.TextArea
                  value={requirement}
                  onChange={event => setRequirement(event.target.value)}
                  placeholder={
                    String(guidance.requirementPlaceholder || '').trim() || '把已有数据、口径、限制条件贴在这里'
                  }
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  maxLength={8000}
                  disabled={!canDispatch}
                />
                <UnifiedFilePicker
                  files={files}
                  onChange={setFiles}
                  purpose="employee-workbench-restaurant"
                  compact
                  label="传附件"
                />
              </div>
            </details>
            {personalBilling ? (
              <div className="m-dispatch-cost">
                <span>费用归属</span>
                <strong>个人 Key 计费</strong>
              </div>
            ) : (
              credits !== null && (
                <div className="m-dispatch-cost">
                  <span>预计消耗</span>
                  <strong>约 {credits} 积分</strong>
                </div>
              )
            )}
          </div>
          {(identity?.intro || materials.length > 0 || deliverables.length > 0 || examples.length > 0) && (
            <details className="m-guide">
              <summary>岗位说明：TA 擅长什么、需要什么材料</summary>
              <div className="m-guide-body">
                {(identity?.intro || identity?.duty) && <p>{identity?.intro || identity?.duty}</p>}
                {materials.length > 0 && (
                  <>
                    <h4>需要你提供</h4>
                    <ul>
                      {materials.slice(0, 6).map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  </>
                )}
                {deliverables.length > 0 && (
                  <>
                    <h4>TA 会交付</h4>
                    <ul>
                      {deliverables.slice(0, 6).map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  </>
                )}
                {examples.length > 0 && (
                  <>
                    <h4>可以这样说</h4>
                    <ul>
                      {examples.slice(0, 4).map((item, index) => (
                        <li key={index}>
                          <button type="button" className="m-link-button" onClick={() => setQuestion(item)}>
                            {item}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </details>
          )}
          <div className="m-action-bar">
            <Button
              type="primary"
              size="large"
              icon={<SendOutlined />}
              loading={submitting}
              disabled={!canDispatch || !question.trim()}
              onClick={() => void submit()}
            >
              {submitting ? '派发中…' : '派给TA'}
            </Button>
            <Button size="large" icon={<RightOutlined />} onClick={() => nav(mobilePath('tasks'))}>
              看任务
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

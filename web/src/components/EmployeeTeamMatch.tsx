import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, Segmented, Tag, Tooltip, message } from 'antd';
import {
  AimOutlined,
  AudioOutlined,
  CloseOutlined,
  RocketOutlined,
  SendOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { api } from '../api/client';
import EmployeeAvatar from './EmployeeAvatar';
import { refineVoiceIntent, useVoiceInput } from './useVoiceInput';
import './EmployeeTeamMatch.css';

// 老板一句话 → AI 读花名册组协同小队 → 队长拆解分工（简单/全面/专业三档输出标准）
// → 自动或半自动派活。面板固化：小队、拆解结果和派出进度都存 sessionStorage，
// 派活、切换员工、开关工作台都不清空，只有用户点「关闭」才移除。

export type MatchedTeamMember = {
  idx: number;
  person: string;
  name: string;
  duty: string;
  group: string;
  color: string;
  status?: string;
  typicalCredits?: number | null;
  roleInTeam: '队长' | '成员';
  task: string;
  why: string;
  dependsOn: number[];
};

export type MatchedTeam = {
  teamName: string;
  summary: string;
  members: MatchedTeamMember[];
};

type PlanDepth = 'simple' | 'full' | 'pro';
type DispatchMode = 'semi' | 'auto';

type MemberBrief = {
  idx: number;
  person: string;
  name: string;
  roleInTeam: '队长' | '成员';
  dependsOn: number[];
  title: string;
  directive: string;
  deliverables: string;
};

type TeamPlan = {
  depth: PlanDepth;
  depthLabel: string;
  leadIdx: number;
  briefs: MemberBrief[];
};

type DispatchedRecord = Record<string, { taskId: number; at: string }>;

type TeamSummary = {
  summary: string;
  keyNumbers?: { label: string; value: string; source: string }[];
  progress: {
    idx: number;
    person: string;
    name: string;
    taskId: number;
    status: string;
    statusLabel: string;
    hasOutput: boolean;
    highlight: string;
  }[];
  nextActions: { action: string; owner: string; timing: string }[];
  risks: string;
  summarizedAt: string;
};

type StoredMatch = {
  query: string;
  team: MatchedTeam;
  matchedAt: string;
  plan?: TeamPlan | null;
  dispatched?: DispatchedRecord;
  teamSummary?: TeamSummary | null;
};

const STORAGE_KEY = 'nw-employee-team-match.v2';

function randomScanAvatarIdxs() {
  const pool = Array.from({ length: 61 }, (_, index) => 101 + index);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 8);
}

const DEPTH_OPTIONS: { value: PlanDepth; label: string; hint: string }[] = [
  { value: 'simple', label: '简单', hint: '一句话结论 + 行动清单，全文不超 400 字，没有专业术语' },
  { value: 'full', label: '全面', hint: '先 3 句大白话摘要，再给完整方案，专业词带解释' },
  { value: 'pro', label: '专业', hint: '深度挖掘：逐项用上每名员工的全部岗位能力，分层展开' },
];

function readStoredMatch(): StoredMatch | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredMatch;
    if (!parsed?.team?.members?.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistMatch(value: StoredMatch | null) {
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 隐私模式下无法持久化，仅保留内存态 */
  }
}

// AI 工作过程可视化：阶段按真实经过时间逐个点亮（这些阶段确实在服务端发生，
// 只是没有逐段事件推送；最终以真实返回结果为准）。头像扫描行传达“正在逐个
// 评估员工”的真实语义，缓解老板等待焦虑。
function AiWorkingSteps({
  phases,
  avatarIdxs,
  deptColorOf,
  expectText,
}: {
  phases: string[];
  avatarIdxs: number[];
  deptColorOf: (member: { group: string; color?: string }) => string;
  expectText: string;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const activeIndex = Math.min(phases.length - 1, Math.floor(elapsed / 7));
  return (
    <div className="team-working" role="status" aria-live="polite">
      {avatarIdxs.length > 0 && (
        <div className="team-working-scan" aria-hidden="true">
          {avatarIdxs.map((idx, index) => (
            <span key={idx} style={{ animationDelay: `${index * 0.22}s` }}>
              <EmployeeAvatar idx={idx} color={deptColorOf({ group: '' })} size={30} />
            </span>
          ))}
          <i className="team-working-beam" />
        </div>
      )}
      <ol className="team-working-phases">
        {phases.map((phase, index) => (
          <li key={phase} data-state={index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'todo'}>
            <i aria-hidden="true" />
            <span>{phase}</span>
          </li>
        ))}
      </ol>
      <small className="team-working-meta">
        已进行 {elapsed} 秒 · {expectText} · 真实 AI 生成中，结果以实际返回为准
      </small>
    </div>
  );
}

// 按 dependsOn 分层：无依赖在第 0 列，其余取依赖最大深度 +1（成环按 0 处理）。
function dagStages(members: MatchedTeamMember[]) {
  const byIdx = new Map(members.map(member => [member.idx, member]));
  const depthOf = (member: MatchedTeamMember, seen = new Set<number>()): number => {
    if (seen.has(member.idx)) return 0;
    seen.add(member.idx);
    const deps = member.dependsOn.map(idx => byIdx.get(idx)).filter(Boolean) as MatchedTeamMember[];
    if (!deps.length) return 0;
    return 1 + Math.max(...deps.map(dep => depthOf(dep, seen)));
  };
  const stages = new Map<number, MatchedTeamMember[]>();
  for (const member of members) {
    const depth = depthOf(member);
    if (!stages.has(depth)) stages.set(depth, []);
    stages.get(depth)!.push(member);
  }
  return [...stages.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
}

export default function EmployeeTeamMatch({
  deptColorOf,
  onDispatch,
  onOpenTask,
}: {
  deptColorOf: (member: { group: string; color?: string }) => string;
  onDispatch: (member: MatchedTeamMember, query: string) => void;
  onOpenTask: (memberIdx: number, taskId: number) => void;
}) {
  const [text, setText] = useState('');
  const [matching, setMatching] = useState(false);
  const [scanAvatarIdxs, setScanAvatarIdxs] = useState<number[]>(() =>
    Array.from({ length: 8 }, (_, index) => 101 + index),
  );
  const [error, setError] = useState('');
  // 语音输入：识别在本机浏览器完成；说完后交给 AI 按经营语境整理意图（轻量真实调用）
  const [voiceRefining, setVoiceRefining] = useState(false);
  const { listening, toggleVoice } = useVoiceInput(
    () => text,
    next => setText(next),
    {
      onFinish: finalText => {
        setVoiceRefining(true);
        void refineVoiceIntent(finalText)
          .then(refined => {
            if (refined && refined !== finalText) {
              setText(refined);
              message.success('已按你的意思整理好这句话，可修改后再「帮我选」');
            }
          })
          .finally(() => setVoiceRefining(false));
      },
    },
  );
  const [stored, setStored] = useState<StoredMatch | null>(() => readStoredMatch());
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const [depth, setDepth] = useState<PlanDepth>('full');
  const [mode, setMode] = useState<DispatchMode>('semi');
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState('');
  // 正在派出的成员 idx 集合；auto 模式按顺序推进
  const [dispatchingIdx, setDispatchingIdx] = useState<number | null>(null);
  const [bulkDispatching, setBulkDispatching] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState('');

  const team = stored?.team || null;
  const plan = stored?.plan || null;
  const teamSummary = stored?.teamSummary || null;
  const dispatched = useMemo<DispatchedRecord>(() => stored?.dispatched || {}, [stored]);
  const dispatchedCount = Object.keys(dispatched).length;
  const focus = useMemo(() => {
    if (!team) return null;
    return (
      team.members.find(member => member.idx === focusIdx) ||
      team.members.find(member => member.roleInTeam === '队长') ||
      team.members[0] ||
      null
    );
  }, [team, focusIdx]);
  const lead = team?.members.find(member => member.roleInTeam === '队长') || null;
  const stages = useMemo(() => (team ? dagStages(team.members) : []), [team]);
  const depthHint = DEPTH_OPTIONS.find(option => option.value === depth)?.hint || '';
  const pendingBriefs = useMemo(
    () => (plan ? plan.briefs.filter(brief => !dispatched[String(brief.idx)]) : []),
    [plan, dispatched],
  );
  const teamMemberIdxs = useMemo(() => (team ? team.members.map(member => member.idx) : []), [team]);

  useEffect(() => {
    persistMatch(stored);
  }, [stored]);

  const runMatch = async () => {
    const query = text.trim();
    if (!query) {
      message.warning('先用一句话说说要办什么事');
      return;
    }
    // 在用户触发匹配时抽样，避免在渲染阶段调用不纯的随机函数。
    setScanAvatarIdxs(randomScanAvatarIdxs());
    setMatching(true);
    setError('');
    try {
      const payload = await api.post('/employees/match-team', { text: query });
      const matched = payload?.team as MatchedTeam | undefined;
      if (!matched?.members?.length) throw new Error('没有匹配到合适的员工，换个说法再试试');
      setStored({ query, team: matched, matchedAt: new Date().toISOString(), plan: null, dispatched: {} });
      setPlanError('');
      setFocusIdx(matched.members.find(member => member.roleInTeam === '队长')?.idx ?? matched.members[0].idx);
    } catch (err: any) {
      setError(err?.message || '匹配失败，请稍后再试');
    } finally {
      setMatching(false);
    }
  };

  const dispatchBrief = async (brief: MemberBrief): Promise<boolean> => {
    setDispatchingIdx(brief.idx);
    try {
      const result = await api.post(`/employee-workbench/restaurant/${brief.idx}/dispatch`, {
        question: brief.directive,
        title: brief.title,
      });
      const taskId = Number((result as Record<string, unknown>)?.runId ?? (result as Record<string, unknown>)?.taskId);
      if (!Number.isSafeInteger(taskId) || taskId <= 0) throw new Error('任务已提交但未返回任务编号');
      setStored(current =>
        current
          ? {
              ...current,
              dispatched: {
                ...(current.dispatched || {}),
                [String(brief.idx)]: { taskId, at: new Date().toISOString() },
              },
            }
          : current,
      );
      return true;
    } catch (err: any) {
      message.error(`${brief.person}：${err?.message || '派出失败'}`);
      return false;
    } finally {
      setDispatchingIdx(null);
    }
  };

  const dispatchAll = async (briefs: MemberBrief[]) => {
    setBulkDispatching(true);
    try {
      let ok = 0;
      for (const brief of briefs) {
        // 顺序派出：不给后端瞬时并发压力，失败即停，老板可修完再继续
        const success = await dispatchBrief(brief);
        if (!success) break;
        ok += 1;
      }
      if (ok === briefs.length && ok > 0) message.success(`已全部派出 ${ok} 名成员的任务`);
      else if (ok > 0) message.warning(`已派出 ${ok}/${briefs.length}，其余可修正后继续`);
    } finally {
      setBulkDispatching(false);
    }
  };

  const runPlan = async () => {
    if (!stored || !team) return;
    setPlanning(true);
    setPlanError('');
    try {
      const payload = await api.post('/employees/team-plan', {
        text: stored.query,
        depth,
        members: team.members.map(member => ({
          idx: member.idx,
          roleInTeam: member.roleInTeam,
          task: member.task,
          dependsOn: member.dependsOn,
        })),
      });
      const nextPlan = payload?.plan as TeamPlan | undefined;
      if (!nextPlan?.briefs?.length) throw new Error('队长没有给出有效拆解，请重试');
      setStored(current => (current ? { ...current, plan: nextPlan, dispatched: {} } : current));
      if (mode === 'auto') {
        message.info('队长拆解完成，自动派出中…');
        await dispatchAll(nextPlan.briefs);
      }
    } catch (err: any) {
      setPlanError(err?.message || '队长拆解失败，请稍后再试');
    } finally {
      setPlanning(false);
    }
  };

  const runSummary = async () => {
    if (!stored) return;
    const dispatchedItems = Object.entries(dispatched).map(([idx, record]) => ({
      idx: Number(idx),
      taskId: record.taskId,
    }));
    if (!dispatchedItems.length) return;
    setSummarizing(true);
    setSummaryError('');
    try {
      const payload = await api.post('/employees/team-summary', {
        text: stored.query,
        items: dispatchedItems,
      });
      const summary = payload?.teamSummary as TeamSummary | undefined;
      if (!summary?.summary) throw new Error('队长没有给出有效汇总，请重试');
      setStored(current => (current ? { ...current, teamSummary: summary } : current));
    } catch (err: any) {
      setSummaryError(err?.message || '队长汇总失败，请稍后再试');
    } finally {
      setSummarizing(false);
    }
  };

  const closeBoard = () => {
    setStored(null);
    setFocusIdx(null);
    setPlanError('');
    setSummaryError('');
  };

  return (
    <section className="team-match" aria-label="老板一句话找人">
      <div className="team-match-input">
        <div className="team-match-kicker">
          <AimOutlined /> 不知道找谁？
        </div>
        <p className="team-match-sub">
          一句话描述要办的事，AI 读完 61 位数字员工的花名册后按协同小队展示；结果会留在这里，只有你点关闭才收起。
        </p>
        <div className="team-match-form">
          <Input.TextArea
            value={text}
            onChange={event => setText(event.target.value)}
            placeholder={
              listening
                ? '正在听你说，说完点「停止」…'
                : voiceRefining
                  ? '正在按你的意思整理这句话…'
                  : '例：我想给门店做一场周年庆活动，怎么策划引流。也可以点右侧麦克风直接说'
            }
            autoSize={{ minRows: 2, maxRows: 4 }}
            maxLength={300}
            onPressEnter={event => {
              if (event.shiftKey) return;
              event.preventDefault();
              if (!matching) void runMatch();
            }}
          />
          <div className="team-match-form-actions">
            <Tooltip title={listening ? '点击停止聆听' : '用说的：点击后直接说需求，识别在本机浏览器完成，不扣积分'}>
              <Button
                className={listening ? 'nw-voice-listening' : undefined}
                icon={<AudioOutlined />}
                danger={listening}
                loading={voiceRefining}
                aria-pressed={listening}
                aria-label={listening ? '停止语音输入' : '开始语音输入'}
                onClick={toggleVoice}
              >
                {listening ? '聆听中·点击停止' : voiceRefining ? '整理意图中…' : '语音说需求'}
              </Button>
            </Tooltip>
            <Button type="primary" icon={<AimOutlined />} loading={matching} onClick={() => void runMatch()}>
              {matching ? 'AI 读花名册挑人中…' : '帮我选'}
            </Button>
          </div>
        </div>
        {error && <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} />}
        {matching && (
          <AiWorkingSteps
            phases={[
              '理解你的需求与经营语境',
              '通读 61 位数字员工花名册',
              '逐个评估岗位匹配度',
              '组建协同小队与任务接力关系',
            ]}
            avatarIdxs={scanAvatarIdxs}
            deptColorOf={deptColorOf}
            expectText="通常 20~60 秒"
          />
        )}
      </div>

      {team && (
        <div className="team-match-board" aria-label={`${team.teamName}协同小队`}>
          <header className="team-match-head">
            {lead && (
              <EmployeeAvatar idx={lead.idx} name={lead.person || lead.name} color={deptColorOf(lead)} size={44} />
            )}
            <div className="team-match-title">
              <strong>
                <TeamOutlined /> {team.teamName}
              </strong>
              <small>
                {team.members.length} 名成员协同 · 依据你的原话「{stored?.query}」
              </small>
            </div>
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              aria-label="关闭协同小队面板"
              onClick={closeBoard}
            >
              关闭
            </Button>
          </header>
          {team.summary && <p className="team-match-summary">{team.summary}</p>}

          <div className="team-match-chips" role="tablist" aria-label="小队成员">
            {team.members.map(member => (
              <button
                type="button"
                key={member.idx}
                role="tab"
                aria-selected={focus?.idx === member.idx}
                className={`team-match-chip${member.roleInTeam === '队长' ? ' lead' : ''}${focus?.idx === member.idx ? ' active' : ''}`}
                onClick={() => setFocusIdx(member.idx)}
                title={`${member.person} · ${member.name}`}
              >
                <EmployeeAvatar
                  idx={member.idx}
                  name={member.person || member.name}
                  color={deptColorOf(member)}
                  size={34}
                />
                <span>
                  <b>{member.person || member.name}</b>
                  <i>{member.roleInTeam === '队长' ? '队长 · 统筹' : member.name}</i>
                </span>
              </button>
            ))}
          </div>

          {stages.length > 1 && (
            <>
              <div className="team-match-dag-label">任务接力顺序</div>
              <div className="team-match-dag">
                {stages.map((column, columnIndex) => (
                  <div className="team-match-dag-step" key={columnIndex}>
                    <div className="team-match-dag-col">
                      {column.map(member => (
                        <button
                          type="button"
                          key={member.idx}
                          className="team-match-node"
                          onClick={() => setFocusIdx(member.idx)}
                        >
                          <EmployeeAvatar
                            idx={member.idx}
                            name={member.person || member.name}
                            color={deptColorOf(member)}
                            size={36}
                          />
                          <span>
                            <b>{member.person || member.name}</b>
                            <i>{member.task || member.name}</i>
                          </span>
                        </button>
                      ))}
                    </div>
                    {columnIndex < stages.length - 1 && (
                      <div className="team-match-arrow" aria-hidden="true">
                        →
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {focus && !plan && (
            <div className="team-match-focus">
              <EmployeeAvatar idx={focus.idx} name={focus.person || focus.name} color={deptColorOf(focus)} size={64} />
              <div className="team-match-focus-copy">
                <div>
                  <strong>{focus.person || focus.name}</strong>
                  <span>
                    {focus.name} · {focus.group} · {focus.roleInTeam}
                  </span>
                  {focus.status === '执行中' && <Tag color="processing">正在工作</Tag>}
                </div>
                {focus.task && <p>分工：{focus.task}</p>}
                {focus.why && <p className="team-match-why">为什么是TA：{focus.why}</p>}
                <small>想单独派给TA：点右侧按钮打开工作台，你这句话会填进派活框。</small>
              </div>
              <Button icon={<SendOutlined />} onClick={() => onDispatch(focus, stored?.query || '')}>
                带原话派给TA
              </Button>
            </div>
          )}

          {/* —— 队长拆解派活编排区 —— */}
          <div className="team-plan" aria-label="队长拆解派活">
            <div className="team-plan-head">
              <strong>
                <ThunderboltOutlined /> 让队长拆解分工，一键派给全队
              </strong>
              <small>
                队长「{lead?.person || '—'}
                」会把这单活拆成每人的任务指令和输出要求；派出后每人任务按其岗位现行标准计费执行。
              </small>
            </div>
            <div className="team-plan-controls">
              <div className="team-plan-control">
                <span className="team-plan-control-label">输出标准</span>
                <Segmented
                  size="small"
                  value={depth}
                  onChange={value => setDepth(value as PlanDepth)}
                  options={DEPTH_OPTIONS.map(option => ({ value: option.value, label: option.label }))}
                />
              </div>
              <div className="team-plan-control">
                <span className="team-plan-control-label">派活方式</span>
                <Segmented
                  size="small"
                  value={mode}
                  onChange={value => setMode(value as DispatchMode)}
                  options={[
                    { value: 'semi', label: '半自动 · 逐个确认' },
                    { value: 'auto', label: '全自动 · 拆完就派' },
                  ]}
                />
              </div>
              <Button
                type="primary"
                icon={<RocketOutlined />}
                loading={planning}
                disabled={bulkDispatching}
                onClick={() => void runPlan()}
              >
                {planning ? '队长拆解中…' : plan ? '重新拆解' : '让队长拆解分工'}
              </Button>
            </div>
            <p className="team-plan-hint">{depthHint}</p>
            {planError && <Alert type="error" showIcon message={planError} />}
            {planning && (
              <AiWorkingSteps
                phases={[
                  `队长「${lead?.person || '统筹人'}」通读你的原话与小队分工`,
                  '为每名成员起草任务指令',
                  '写清上下游衔接与交付物',
                  `按「${DEPTH_OPTIONS.find(option => option.value === depth)?.label || '全面'}」档核对输出标准`,
                ]}
                avatarIdxs={teamMemberIdxs}
                deptColorOf={deptColorOf}
                expectText="通常 15~45 秒"
              />
            )}

            {plan && (
              <div className="team-plan-briefs">
                <div className="team-plan-briefs-head">
                  <span>
                    队长按「{plan.depthLabel}」档拆出 {plan.briefs.length} 单任务
                    {Object.keys(dispatched).length > 0 && ` · 已派出 ${Object.keys(dispatched).length} 单`}
                  </span>
                  {pendingBriefs.length > 0 && (
                    <Button
                      size="small"
                      type="primary"
                      loading={bulkDispatching}
                      disabled={dispatchingIdx !== null}
                      onClick={() => void dispatchAll(pendingBriefs)}
                    >
                      全部派出（{pendingBriefs.length}）
                    </Button>
                  )}
                </div>
                {plan.briefs.map(brief => {
                  const record = dispatched[String(brief.idx)];
                  const member = team.members.find(item => item.idx === brief.idx);
                  return (
                    <article className="team-plan-brief" key={brief.idx} data-dispatched={record ? 'true' : undefined}>
                      <EmployeeAvatar
                        idx={brief.idx}
                        name={brief.person || brief.name}
                        color={member ? deptColorOf(member) : '#2c76dc'}
                        size={40}
                      />
                      <div className="team-plan-brief-copy">
                        <div className="team-plan-brief-title">
                          <strong>{brief.person}</strong>
                          <span>
                            {brief.name}
                            {brief.roleInTeam === '队长' ? ' · 队长' : ''}
                          </span>
                          {record && <Tag color="success">已派出 · 任务 #{record.taskId}</Tag>}
                        </div>
                        <p className="team-plan-brief-task">{brief.title}</p>
                        {brief.deliverables && (
                          <p className="team-plan-brief-deliverable">交付：{brief.deliverables}</p>
                        )}
                        <details>
                          <summary>查看队长给TA的完整任务指令</summary>
                          <pre>{brief.directive}</pre>
                        </details>
                      </div>
                      <div className="team-plan-brief-actions">
                        {record ? (
                          <Button size="small" onClick={() => onOpenTask(brief.idx, record.taskId)}>
                            看任务进度
                          </Button>
                        ) : (
                          <Tooltip title={bulkDispatching ? '正在按顺序派出' : ''}>
                            <Button
                              size="small"
                              type="primary"
                              loading={dispatchingIdx === brief.idx}
                              disabled={bulkDispatching && dispatchingIdx !== brief.idx}
                              onClick={() => void dispatchBrief(brief)}
                            >
                              派出这单
                            </Button>
                          </Tooltip>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {dispatchedCount > 0 && (
              <div className="team-summary" aria-label="队长收尾汇总">
                <div className="team-summary-head">
                  <strong>队长收尾：干完活，给老板一个交代</strong>
                  <Button
                    type={teamSummary ? 'default' : 'primary'}
                    size="small"
                    loading={summarizing}
                    onClick={() => void runSummary()}
                  >
                    {summarizing ? '队长汇总中…' : teamSummary ? '刷新汇总（拉最新进度）' : '让队长收尾汇总'}
                  </Button>
                </div>
                <p className="team-summary-hint">
                  队长会读取每名成员任务的真实产出，给出整体结论、各人要点和下一步行动计划；成员还没交付时如实标注，不编内容。
                </p>
                {summaryError && <Alert type="warning" showIcon message={summaryError} />}
                {summarizing && (
                  <AiWorkingSteps
                    phases={['读取每名成员任务的真实产出', '提炼关键结论与进度', '制定下一步行动计划', '核对风险提醒']}
                    avatarIdxs={Object.keys(dispatched).map(Number)}
                    deptColorOf={deptColorOf}
                    expectText="通常 15~40 秒"
                  />
                )}
                {teamSummary && (
                  <div className="team-summary-body">
                    <div className="team-summary-conclusion">
                      <span className="team-summary-label">整体收尾汇报</span>
                      {teamSummary.summary
                        .split(/\n+/u)
                        .filter(Boolean)
                        .map((paragraph, index) => (
                          <p key={index}>{paragraph}</p>
                        ))}
                    </div>
                    {(teamSummary.keyNumbers || []).length > 0 && (
                      <div className="team-summary-numbers" aria-label="关键数据">
                        {(teamSummary.keyNumbers || []).map((item, index) => (
                          <div className="team-summary-number" key={index}>
                            <strong>{item.value}</strong>
                            <span>{item.label}</span>
                            {item.source && <small>出自 {item.source}</small>}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="team-summary-progress">
                      <span className="team-summary-label">各成员交付情况</span>
                      {teamSummary.progress.map(row => (
                        <div
                          className="team-summary-row"
                          key={row.idx}
                          data-delivered={row.hasOutput ? 'true' : undefined}
                        >
                          <div className="team-summary-row-head">
                            <strong>{row.person}</strong>
                            <Tag color={row.hasOutput ? 'success' : row.status === '失败' ? 'error' : 'processing'}>
                              {row.statusLabel}
                            </Tag>
                            <Button type="link" size="small" onClick={() => onOpenTask(row.idx, row.taskId)}>
                              看完整产出
                            </Button>
                          </div>
                          <p className="team-summary-highlight">{row.highlight || '—'}</p>
                        </div>
                      ))}
                    </div>
                    {teamSummary.nextActions.length > 0 && (
                      <div className="team-summary-actions-list">
                        <span className="team-summary-label">下一步行动计划</span>
                        <ol>
                          {teamSummary.nextActions.map((action, index) => (
                            <li key={index}>
                              <span>{action.action}</span>
                              <small>{[action.owner, action.timing].filter(Boolean).join(' · ')}</small>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {teamSummary.risks && <Alert type="warning" showIcon message={`风险提醒：${teamSummary.risks}`} />}
                    <small className="team-summary-time">
                      汇总时间：{new Date(teamSummary.summarizedAt).toLocaleString('zh-CN')} ·
                      汇总只读真实产出，重新汇总会拉取最新进度
                    </small>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

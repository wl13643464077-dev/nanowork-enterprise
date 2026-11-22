import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, DatePicker, Form, Input, Modal, Progress, Radio, Select, Spin, Tag, Tooltip, message } from 'antd';
import {
  CheckCircleOutlined,
  FormOutlined,
  ReloadOutlined,
  RightOutlined,
  SendOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useNavigate } from 'react-router-dom';
import { api, getUser } from '../api/client';
import { dispatchToEmployee } from '../utils/dispatchEmployee';
import { Panel } from './Kit';
import './InspectionRectificationPanel.css';

export interface InspectionAssignee {
  id: number;
  name: string;
  role?: string;
  dept?: string;
  status?: string;
}

interface RectificationRecord {
  id: number;
  inspectionId: number;
  issueIndex: number;
  storeName: string;
  storeId: number | null;
  board: string;
  severity: string;
  problem: string;
  actionPlan: string;
  assigneeId: number | null;
  assigneeName: string;
  taskId: number | null;
  taskStatus: string | null;
  status: 'in_progress' | 'rechecked' | 'closed' | string;
  dueDate: string | null;
  recheckNote: string;
  recheckBy: string;
  recheckAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface InspectionIssue {
  index: number;
  board: string;
  severity: string;
  severityRaised?: string;
  problem: string;
  evidence: string;
  action: string;
  deadline: string;
  rectification: RectificationRecord | null;
}

interface InspectionItem {
  id: number;
  taskId: number;
  store: string;
  storeId: number | null;
  type: string;
  score: number;
  highIssues: number;
  issueCount: number;
  rectifiedCount: number;
  closedCount: number;
  supervisor: string;
  taskStatus: string;
  createdAt: string;
  issues: InspectionIssue[];
}

interface InspectionStats {
  totalInspections: number;
  totalIssues: number;
  highIssues: number;
  highPending: number;
  created: number;
  closed: number;
  pending: number;
  closureRate: number;
}

interface InspectionsResponse {
  items: InspectionItem[];
  stats: InspectionStats;
}

interface RectifyFormValues {
  assigneeId?: number;
  dueDate?: Dayjs | null;
  actionPlan?: string;
}

interface RecheckFormValues {
  passed: boolean;
  recheckNote?: string;
}

interface Props {
  assignees?: InspectionAssignee[];
  onChanged?: () => void;
}

const EMPTY_STATS: InspectionStats = {
  totalInspections: 0,
  totalIssues: 0,
  highIssues: 0,
  highPending: 0,
  created: 0,
  closed: 0,
  pending: 0,
  closureRate: 0,
};

function scoreClass(score: number): string {
  if (score >= 85) return 'irp-score-pill irp-score-pill--ok';
  if (score >= 70) return 'irp-score-pill irp-score-pill--warn';
  return 'irp-score-pill irp-score-pill--danger';
}

function severityBadge(issue: InspectionIssue): { label: string; color: string } {
  if (issue.severityRaised === 'mandatory_red_line') {
    return { label: '红线', color: 'red' };
  }
  if (issue.severity === '高') return { label: '高危', color: 'red' };
  if (issue.severity === '中') return { label: '中', color: 'orange' };
  return { label: '低', color: 'blue' };
}

export default function InspectionRectificationPanel({ assignees, onChanged }: Props) {
  const nav = useNavigate();
  const user = getUser() || {};
  const isManager = ['boss', 'ops_director', 'manager', 'admin'].includes(String(user.role || ''));

  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<InspectionItem[]>([]);
  const [stats, setStats] = useState<InspectionStats>(EMPTY_STATS);
  const [expandedIds, setExpandedIds] = useState<number[]>([]);
  const [loadedAssignees, setLoadedAssignees] = useState<InspectionAssignee[]>([]);

  const [rectifyTarget, setRectifyTarget] = useState<{
    inspection: InspectionItem;
    issue: InspectionIssue;
  } | null>(null);
  const [recheckTarget, setRecheckTarget] = useState<{
    inspection: InspectionItem;
    issue: InspectionIssue;
    rect: RectificationRecord;
  } | null>(null);
  const [submittingRectify, setSubmittingRectify] = useState(false);
  const [submittingRecheck, setSubmittingRecheck] = useState(false);

  const [rectifyForm] = Form.useForm<RectifyFormValues>();
  const [recheckForm] = Form.useForm<RecheckFormValues>();

  const loadInspections = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const data = (await api.get('/execution/inspections?limit=30', { silent: true })) as InspectionsResponse;
      const list = Array.isArray(data?.items) ? data.items : [];
      setItems(list);
      setStats(data?.stats || EMPTY_STATS);
      setExpandedIds(prev => {
        if (prev.length > 0) return prev;
        const firstOpen = list.find(item => item.issueCount > item.closedCount) || list[0];
        return firstOpen ? [firstOpen.id] : [];
      });
    } catch {
      setItems([]);
      setStats(EMPTY_STATS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadInspections(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadInspections]);

  useEffect(() => {
    if (!isManager || (assignees && assignees.length > 0)) return;
    let cancelled = false;
    void api
      .get('/execution/assignees', { silent: true })
      .then((payload: InspectionAssignee[] | { users?: InspectionAssignee[] }) => {
        if (cancelled) return;
        const list = Array.isArray(payload) ? payload : Array.isArray(payload?.users) ? payload.users : [];
        setLoadedAssignees(list.filter(member => member?.status !== '停用'));
      })
      .catch(() => {
        if (!cancelled) setLoadedAssignees([]);
      });
    return () => {
      cancelled = true;
    };
  }, [assignees, isManager]);

  useEffect(() => {
    const scrollIfHashMatches = () => {
      if (window.location.hash !== '#inspections') return;
      const anchor = document.getElementById('inspections');
      anchor?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    scrollIfHashMatches();
    window.addEventListener('hashchange', scrollIfHashMatches);
    return () => window.removeEventListener('hashchange', scrollIfHashMatches);
  }, []);

  const assigneeOptions = useMemo(() => {
    const source = assignees && assignees.length > 0 ? assignees : loadedAssignees;
    const map = new Map<number, InspectionAssignee>();
    for (const member of source) {
      const id = Number(member?.id);
      if (Number.isSafeInteger(id) && id > 0) {
        map.set(id, { ...member, id });
      }
    }
    const selfId = Number(user.id);
    if (Number.isSafeInteger(selfId) && selfId > 0 && !map.has(selfId)) {
      map.set(selfId, { id: selfId, name: String(user.name || '本人'), role: user.role });
    }
    return [...map.values()];
  }, [assignees, loadedAssignees, user.id, user.name, user.role]);

  const toggleExpand = (id: number) => {
    setExpandedIds(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]));
  };

  const openRectifyModal = (inspection: InspectionItem, issue: InspectionIssue) => {
    setRectifyTarget({ inspection, issue });
    rectifyForm.setFieldsValue({
      assigneeId: assigneeOptions[0]?.id,
      dueDate: dayjs().add(issue.severity === '高' ? 1 : 3, 'day'),
      actionPlan: issue.action || '',
    });
  };

  const handleRectifySubmit = async () => {
    if (!rectifyTarget) return;
    const values = await rectifyForm.validateFields();
    const chosen = assigneeOptions.find(member => member.id === Number(values.assigneeId));
    setSubmittingRectify(true);
    try {
      const created = (await api.post(`/execution/inspections/${rectifyTarget.inspection.id}/rectify`, {
        issueIndex: rectifyTarget.issue.index,
        assigneeId: values.assigneeId || null,
        assigneeName: chosen?.name || '',
        dueDate: values.dueDate ? values.dueDate.format('YYYY-MM-DD') : null,
        actionPlan: values.actionPlan || '',
      })) as RectificationRecord;
      message.success(`已转为整改任务 #${created.taskId}，并同步到任务看板`);
      setRectifyTarget(null);
      rectifyForm.resetFields();
      await loadInspections();
      onChanged?.();
    } finally {
      setSubmittingRectify(false);
    }
  };

  const openRecheckModal = (inspection: InspectionItem, issue: InspectionIssue, rect: RectificationRecord) => {
    setRecheckTarget({ inspection, issue, rect });
    recheckForm.setFieldsValue({
      passed: true,
      recheckNote: '',
    });
  };

  const handleRecheckSubmit = async () => {
    if (!recheckTarget) return;
    const values = await recheckForm.validateFields();
    setSubmittingRecheck(true);
    try {
      await api.post(`/execution/inspections/rectifications/${recheckTarget.rect.id}/recheck`, {
        passed: values.passed,
        recheckNote: values.recheckNote || '',
      });
      message.success(values.passed ? '复检通过，整改单与关联任务已同步闭环' : '已退回重新整改，关联任务保持进行中');
      setRecheckTarget(null);
      recheckForm.resetFields();
      await loadInspections();
      onChanged?.();
    } finally {
      setSubmittingRecheck(false);
    }
  };

  const dispatchFirstInspection = () => {
    dispatchToEmployee(
      nav,
      161,
      '请帮我发起一次门店巡店检查：围绕食品安全、出品质量、服务流程、环境卫生与陈列标准逐项打分，列出问题清单、现场证据与限期整改建议，并在报告末尾输出标准巡店归档块。',
    );
  };

  const dispatchSecondRecheck = (inspection: InspectionItem, issue: InspectionIssue, rect: RectificationRecord) => {
    dispatchToEmployee(
      nav,
      161,
      `请对门店「${inspection.store}」发起巡店二次复检（关联原巡店记录 #${inspection.id}）：待复检问题为「${issue.problem}」（板块：${issue.board || '综合'}，严重度：${issue.severity}），整改动作：「${rect.actionPlan || issue.action || '按标准整改'}」，负责人：${rect.assigneeName || '未指定'}，截止：${rect.dueDate || '尽快'}。请生成二次复检核查清单、现场验收标准与是否闭环结论，并在文末输出整改复查归档块。`,
    );
  };

  const closureCardTone =
    stats.totalIssues === 0
      ? 'irp-kpi-card'
      : stats.closureRate >= 80
        ? 'irp-kpi-card irp-kpi-card--ok'
        : 'irp-kpi-card irp-kpi-card--warn';
  const closureValueTone =
    stats.totalIssues === 0
      ? 'irp-kpi-value'
      : stats.closureRate >= 80
        ? 'irp-kpi-value irp-kpi-value--ok'
        : 'irp-kpi-value irp-kpi-value--warn';

  return (
    <section id="inspections" className="irp-anchor" aria-label="督导巡店整改台账闭环">
      <Panel
        title="督导巡店整改台账 · 查 → 改 → 复检闭环"
        extra={
          <div className="irp-header-actions">
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadInspections(true)} loading={loading}>
              刷新
            </Button>
            <Button size="small" type="primary" ghost icon={<ThunderboltOutlined />} onClick={dispatchFirstInspection}>
              派查巡巡(#161)巡店
            </Button>
          </div>
        }
      >
        <div className="irp-kpi-grid">
          <div className="irp-kpi-card">
            <span className="irp-kpi-label">累计巡店</span>
            <strong className="irp-kpi-value">{stats.totalInspections}</strong>
            <span className="irp-kpi-sub">累计发现问题 {stats.totalIssues} 项</span>
          </div>
          <div className={stats.highPending > 0 ? 'irp-kpi-card irp-kpi-card--danger' : 'irp-kpi-card'}>
            <span className="irp-kpi-label">高危待改</span>
            <strong className={stats.highPending > 0 ? 'irp-kpi-value irp-kpi-value--danger' : 'irp-kpi-value'}>
              {stats.highPending}
            </strong>
            <span className="irp-kpi-sub">累计高危问题 {stats.highIssues} 项</span>
          </div>
          <div className={stats.closed > 0 ? 'irp-kpi-card irp-kpi-card--ok' : 'irp-kpi-card'}>
            <span className="irp-kpi-label">已复检闭环</span>
            <strong className={stats.closed > 0 ? 'irp-kpi-value irp-kpi-value--ok' : 'irp-kpi-value'}>
              {stats.closed}
            </strong>
            <span className="irp-kpi-sub">已派整改任务 {stats.created} 项</span>
          </div>
          <div className={closureCardTone}>
            <span className="irp-kpi-label">整改闭环率</span>
            <strong className={closureValueTone}>{stats.closureRate}%</strong>
            <span className="irp-kpi-sub">待闭环问题 {stats.pending} 项</span>
          </div>
        </div>

        {loading ? (
          <div className="irp-loading">
            <Spin />
          </div>
        ) : items.length === 0 ? (
          <div className="irp-empty">
            <p className="irp-empty-title">还没有巡店归档记录</p>
            <p className="irp-empty-desc">
              完成巡店后，#161 查巡巡会自动归档评分与问题清单，并在此一键转整改任务、跟踪复检闭环。
            </p>
            <Button type="primary" icon={<SendOutlined />} onClick={dispatchFirstInspection}>
              立即派给查巡巡(#161)开始首次门店巡检 →
            </Button>
          </div>
        ) : (
          <div className="irp-list">
            {items.map(inspection => {
              const isOpen = expandedIds.includes(inspection.id);
              const progressPct =
                inspection.issueCount > 0 ? Math.round((inspection.closedCount / inspection.issueCount) * 100) : 100;
              return (
                <div className="irp-record" key={inspection.id}>
                  <button
                    type="button"
                    className="irp-record-head"
                    onClick={() => toggleExpand(inspection.id)}
                    aria-expanded={isOpen}
                  >
                    <div className="irp-record-main">
                      <RightOutlined
                        className={isOpen ? 'irp-record-caret irp-record-caret--open' : 'irp-record-caret'}
                      />
                      <span className="irp-store-name">{inspection.store}</span>
                      <span className={scoreClass(inspection.score)}>{inspection.score} 分</span>
                      <Tag>{inspection.type}</Tag>
                      {inspection.highIssues > 0 && <Tag color="red">高危 {inspection.highIssues}</Tag>}
                      <span className="irp-meta-text">
                        督导：{inspection.supervisor} · {String(inspection.createdAt || '').slice(0, 16)}
                      </span>
                    </div>
                    <div className="irp-record-right">
                      <div className="irp-progress-wrap">
                        <div className="irp-progress-bar">
                          <Progress
                            percent={progressPct}
                            size="small"
                            showInfo={false}
                            status={progressPct === 100 ? 'success' : 'active'}
                          />
                        </div>
                        <span className="irp-progress-label">
                          闭环 {inspection.closedCount}/{inspection.issueCount}
                        </span>
                      </div>
                    </div>
                  </button>

                  {isOpen && (
                    <div className="irp-issues">
                      {inspection.issues.length === 0 ? (
                        <div className="irp-no-issues">本次巡店未检出待整改问题。</div>
                      ) : (
                        inspection.issues.map(issue => {
                          const sev = severityBadge(issue);
                          const rect = issue.rectification;
                          const isClosed = rect?.status === 'closed';
                          return (
                            <div
                              key={`${inspection.id}-${issue.index}`}
                              className={isClosed ? 'irp-issue-row irp-issue-row--closed' : 'irp-issue-row'}
                            >
                              <div className="irp-issue-body">
                                <div className="irp-issue-title-line">
                                  <span className="irp-issue-index">#{issue.index + 1}</span>
                                  <Tag color={sev.color}>{sev.label}</Tag>
                                  {issue.board && <Tag>{issue.board}</Tag>}
                                  {!rect ? (
                                    <Tag color="default">待派整改</Tag>
                                  ) : isClosed ? (
                                    <Tag color="green" icon={<CheckCircleOutlined />}>
                                      已复检闭环
                                    </Tag>
                                  ) : (
                                    <Tag color="processing">整改进行中</Tag>
                                  )}
                                  <span className="irp-issue-problem">{issue.problem}</span>
                                </div>

                                {(issue.evidence || issue.action || issue.deadline) && (
                                  <div className="irp-issue-detail">
                                    {issue.evidence && <span>现场证据：{issue.evidence}</span>}
                                    {issue.action && <span>建议整改：{issue.action}</span>}
                                    {issue.deadline && <span>建议期限：{issue.deadline}</span>}
                                  </div>
                                )}

                                {rect && (
                                  <div className="irp-rect-trail">
                                    <span>负责人：{rect.assigneeName || '未指定'}</span>
                                    {rect.dueDate && <span>截止：{rect.dueDate}</span>}
                                    {rect.taskId && (
                                      <span>
                                        关联任务 #{rect.taskId}（{rect.taskStatus || '进行中'}）
                                      </span>
                                    )}
                                    {rect.actionPlan && <span>整改动作：{rect.actionPlan}</span>}
                                    {rect.recheckAt && (
                                      <span className="irp-rect-note">
                                        {isClosed ? '复检闭环说明' : '复检退回意见'}（{rect.recheckBy || '复检员'} ·{' '}
                                        {String(rect.recheckAt).slice(0, 16)}）：
                                        {rect.recheckNote || (isClosed ? '复检合格' : '请按要求继续整改')}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>

                              <div className="irp-issue-actions">
                                {!rect ? (
                                  isManager ? (
                                    <Button
                                      type="primary"
                                      size="small"
                                      icon={<FormOutlined />}
                                      onClick={() => openRectifyModal(inspection, issue)}
                                    >
                                      一键转整改任务
                                    </Button>
                                  ) : (
                                    <Tag>待管理层派单</Tag>
                                  )
                                ) : (
                                  <>
                                    {isManager && !isClosed && (
                                      <Button
                                        type="primary"
                                        size="small"
                                        icon={<CheckCircleOutlined />}
                                        onClick={() => openRecheckModal(inspection, issue, rect)}
                                      >
                                        提交复检闭环
                                      </Button>
                                    )}
                                    <Tooltip title="直达 #161 查巡巡工作台并预填二次复检指令">
                                      <Button
                                        size="small"
                                        type="link"
                                        icon={<ThunderboltOutlined />}
                                        onClick={() => dispatchSecondRecheck(inspection, issue, rect)}
                                      >
                                        派查巡巡(#161)二次复检
                                      </Button>
                                    </Tooltip>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Modal
        open={!!rectifyTarget}
        title="一键转整改任务"
        okText="创建整改任务"
        cancelText="取消"
        confirmLoading={submittingRectify}
        onCancel={() => {
          setRectifyTarget(null);
          rectifyForm.resetFields();
        }}
        onOk={() => void handleRectifySubmit()}
      >
        {rectifyTarget && (
          <div className="irp-modal-context">
            <span className="irp-modal-context-store">
              {rectifyTarget.inspection.store} · {rectifyTarget.issue.board || '巡店问题'} · 严重度「
              {rectifyTarget.issue.severity}」
            </span>
            <span className="irp-modal-context-problem">{rectifyTarget.issue.problem}</span>
          </div>
        )}
        <Form form={rectifyForm} layout="vertical">
          <Form.Item name="assigneeId" label="整改负责人" rules={[{ required: true, message: '请选择整改负责人' }]}>
            <Select
              placeholder="选择整改负责人"
              options={assigneeOptions.map(member => ({
                value: member.id,
                label: `${member.name}${member.dept ? ` · ${member.dept}` : ''}`,
              }))}
            />
          </Form.Item>
          <Form.Item name="dueDate" label="整改截止日期" rules={[{ required: true, message: '请选择截止日期' }]}>
            <DatePicker className="irp-full-control" format="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item
            name="actionPlan"
            label="整改动作与验收标准"
            rules={[{ required: true, message: '请填写具体整改动作' }]}
          >
            <Input.TextArea rows={3} maxLength={500} showCount placeholder="明确具体整改动作与拍照回传标准" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={!!recheckTarget}
        title="提交巡店复检结果"
        okText="确认提交"
        cancelText="取消"
        confirmLoading={submittingRecheck}
        onCancel={() => {
          setRecheckTarget(null);
          recheckForm.resetFields();
        }}
        onOk={() => void handleRecheckSubmit()}
      >
        {recheckTarget && (
          <div className="irp-modal-context">
            <span className="irp-modal-context-store">
              {recheckTarget.inspection.store} · 负责人：{recheckTarget.rect.assigneeName || '未指定'}
            </span>
            <span className="irp-modal-context-problem">{recheckTarget.issue.problem}</span>
          </div>
        )}
        <Form form={recheckForm} layout="vertical">
          <Form.Item name="passed" label="复检结论" rules={[{ required: true }]}>
            <Radio.Group className="irp-recheck-radio-group">
              <Radio value={true}>复检通过 · 同步闭环整改任务</Radio>
              <Radio value={false}>未达标 · 退回重新整改</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item
            name="recheckNote"
            label="复检说明"
            rules={[{ required: true, message: '请填写复检核查情况或退回原因' }]}
          >
            <Input.TextArea
              rows={3}
              maxLength={500}
              showCount
              placeholder="记录现场复检结果、照片留痕情况或退回重改的具体要求"
            />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  );
}

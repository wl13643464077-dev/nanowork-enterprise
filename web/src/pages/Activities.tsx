import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Row,
  Col,
  Calendar,
  Badge,
  Tag,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  DatePicker,
  Drawer,
  Table,
  Checkbox,
  Progress,
  Empty,
  Alert,
  message,
  Space,
  Spin,
  Avatar,
  Popconfirm,
  Tooltip,
} from 'antd';
import {
  CalendarOutlined,
  TeamOutlined,
  CheckCircleOutlined,
  DollarOutlined,
  RiseOutlined,
  SmileOutlined,
  BulbOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  PlusOutlined,
  EditOutlined,
  FileDoneOutlined,
  EnvironmentOutlined,
  UserOutlined,
  HistoryOutlined,
  RightOutlined,
  AimOutlined,
  UploadOutlined,
  InboxOutlined,
  BookOutlined,
  CopyOutlined,
  DownloadOutlined,
  SyncOutlined,
  CheckSquareOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { api, fmtMoney, fmtWan, getUser } from '../api/client';
import { loadXlsx } from '../utils/xlsx';
import { StatCard, Panel, StageTag, GradeTag } from '../components/Kit';
import {
  asList,
  assignmentDrafts,
  cloneJson,
  displayText,
  listText,
  normalizePlanView,
  textList,
} from '../components/ActivitiesPlanHelpers';
import { activityCalendarSyncPresentation } from '../components/statusPresentation.js';

// 后端沿用既有活动类型值，前端只替换用户可见名称，避免影响历史数据与日历联动。
const ACT_TYPES = [
  { value: '品鉴会', label: '主题试吃' },
  { value: '沙龙会', label: '门店沙龙' },
  { value: '招商说明会', label: '合作说明会' },
  { value: '回厂游', label: '后厨开放日' },
  { value: '封坛仪式', label: '新品发布' },
  { value: '企业团购沙龙', label: '企业团餐洽谈' },
  { value: '会员日', label: '会员活动' },
];
const DEFAULT_ACTIVITY_TYPE = ACT_TYPES[0].value;
const ACT_TYPE_LABEL = Object.fromEntries(ACT_TYPES.map(item => [item.value, item.label])) as Record<string, string>;
const activityTypeLabel = (type?: string) => ACT_TYPE_LABEL[type || ''] || type || '-';
const TYPE_COLOR: Record<string, string> = {
  品鉴会: 'var(--ui-accent)',
  沙龙会: '#13c2c2',
  回厂游: '#d4380d',
  封坛仪式: 'var(--chart-3)',
  企业团购沙龙: 'var(--warn)',
  招商说明会: '#52c41a',
  会员日: 'var(--chart-2)',
};
const TYPE_TAG: Record<string, string> = {
  品鉴会: 'blue',
  沙龙会: 'cyan',
  回厂游: 'volcano',
  封坛仪式: 'purple',
  企业团购沙龙: 'orange',
  招商说明会: 'green',
  会员日: 'cyan',
};
const TYPE_EMOJI: Record<string, string> = {
  品鉴会: '🍽️',
  沙龙会: '💬',
  回厂游: '👨‍🍳',
  封坛仪式: '✨',
  企业团购沙龙: '🧾',
  招商说明会: '🤝',
  会员日: '🎁',
};
const STATUS_BADGE: Record<string, any> = {
  策划中: 'default',
  筹备中: 'warning',
  报名中: 'processing',
  进行中: 'processing',
  已结束: 'default',
  已复盘: 'success',
};
const INVITE_STATUS = ['待邀约', '已邀约', '已报名', '已到场', '已转化', '爽约'];
const RATE_LABEL: Record<string, string> = {
  inviteSign: '邀约→报名',
  signArrive: '报名→到场',
  arriveDeal: '到场→成交',
  referral: '转介绍率',
  roi: 'ROI',
};
const KEY_ZH: Record<string, string> = {
  invited: '邀约人数',
  signed_up: '报名人数',
  arrived: '到场人数',
  converted: '成交数',
  revenue: '收入',
  cost: '成本',
  budget: '预算',
  satisfaction: '满意度',
  join: '报名人数',
  deal: '成交数',
  target_join: '目标报名',
  target_deal: '目标成交',
  ...RATE_LABEL,
};
const KANBAN_COLS = [
  { title: '筹备中', sts: ['策划中', '筹备中'], color: 'var(--warn)' },
  { title: '进行中', sts: ['报名中', '进行中'], color: 'var(--ui-accent)' },
  { title: '已复盘', sts: ['已结束', '已复盘'], color: 'var(--chart-2)' },
];

const PLAN_STATUS_COLOR: Record<string, string> = {
  未提交: 'default',
  草稿: 'default',
  待审批: 'orange',
  总审中: 'purple',
  已通过: 'green',
  已驳回: 'red',
};
const CHECK_STATUS_COLOR: Record<string, string> = {
  待审批: 'orange',
  总审中: 'purple',
  已通过: 'green',
  已驳回: 'red',
};
const buttonResetStyle = {
  appearance: 'none',
  border: 0,
  padding: 0,
  margin: 0,
  width: '100%',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'inherit',
} as const;

function Sect({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ui-text)', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

export default function Activities() {
  const user = getUser();
  const canManageActivityAssignments = ['boss', 'ops_director', 'manager', 'admin'].includes(user?.role || '');
  const [stats, setStats] = useState<any>({});
  const [acts, setActs] = useState<any[]>([]);
  const [selDate, setSelDate] = useState<Dayjs>(dayjs());
  const [selected, setSelected] = useState<any>(null);

  // 新建活动
  const [createOpen, setCreateOpen] = useState(false);
  // 飞书日历关联（FR-ACT-07）
  const [calSync, setCalSync] = useState<{ open: boolean; info: any; error: string }>({
    open: false,
    info: null,
    error: '',
  });
  const openCalSync = () => {
    if (!canManageActivityAssignments) {
      message.warning('只有老板或管理层可以查看企业日历关联');
      return;
    }
    setCalSync({ open: true, info: null, error: '' });
    api
      .get('/activities/calendar-sync', { silent: true })
      .then(info => setCalSync({ open: true, info, error: '' }))
      .catch((error: any) =>
        setCalSync({ open: true, info: null, error: error?.message || '企业日历关联状态加载失败' }),
      );
  };
  const [creating, setCreating] = useState(false);
  const [createForm] = Form.useForm();
  // 录入战果
  const [resultOpen, setResultOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resultForm] = Form.useForm();
  // 邀约名单
  const [invOpen, setInvOpen] = useState(false);
  const [invites, setInvites] = useState<any[]>([]);
  const [invLoading, setInvLoading] = useState(false);
  const [circling, setCircling] = useState(false);
  const [circleOpen, setCircleOpen] = useState(false);
  const [circlePreview, setCirclePreview] = useState<any>(null);
  const [circleSelected, setCircleSelected] = useState<number[]>([]);
  const circleRequestRef = useRef(0);
  // AI策划
  const [planGoal, setPlanGoal] = useState('提升到店与服务转化');
  const [planAudience, setPlanAudience] = useState('已授权触达的目标顾客');
  const [planBudget, setPlanBudget] = useState('待确认');
  const [planLoading, setPlanLoading] = useState(false);
  const [planData, setPlanData] = useState<any>(null);
  const [planDraft, setPlanDraft] = useState<any>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [planSaving, setPlanSaving] = useState(false);
  const [planSubmitting, setPlanSubmitting] = useState(false);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [assignmentLoading, setAssignmentLoading] = useState(false);
  const [assignmentSaving, setAssignmentSaving] = useState(false);
  const [assignmentUsers, setAssignmentUsers] = useState<any[]>([]);
  const [assignmentRows, setAssignmentRows] = useState<any[]>([]);
  // 独立AI活动策划室：不依赖先创建活动，草稿服务端持久化。
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioLoading, setStudioLoading] = useState(false);
  const [studioSaving, setStudioSaving] = useState(false);
  const [studioDraftId, setStudioDraftId] = useState<number | null>(null);
  const [studioPlan, setStudioPlan] = useState<any>(null);
  const [studioDrafts, setStudioDrafts] = useState<any[]>([]);
  const [studioForm] = Form.useForm();
  // 复盘
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewAct, setReviewAct] = useState<any>(null);
  const [reviewData, setReviewData] = useState<any>(null);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [okText, setOkText] = useState('');
  const [badText, setBadText] = useState('');
  const [reviewSyncing, setReviewSyncing] = useState(false);
  const [checkSubmitting, setCheckSubmitting] = useState<number | null>(null);
  // 批量战果导入（FR-ACT-08）：xlsx/csv 文件 或 Excel 直接粘贴
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchRows, setBatchRows] = useState<any[]>([]);
  const [batchPaste, setBatchPaste] = useState('');
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchResult, setBatchResult] = useState<any>(null);
  // 顶部统计卡钻取
  const [statsDrill, setStatsDrill] = useState<{ open: boolean; kind: string; data: any }>({
    open: false,
    kind: '',
    data: null,
  });
  const openStatsDrill = (kind: string) => {
    setStatsDrill({ open: true, kind, data: null });
    api
      .get('/activities/stats-drill')
      .then(d => setStatsDrill({ open: true, kind, data: d }))
      .catch(() => {});
  };
  const HEADER_MAP: Record<string, string> = {
    活动名称: 'title',
    名称: 'title',
    活动: 'title',
    标题: 'title',
    邀约: 'invited',
    邀约人数: 'invited',
    报名: 'signed_up',
    报名人数: 'signed_up',
    到场: 'arrived',
    到场人数: 'arrived',
    到会: 'arrived',
    到店: 'arrived',
    成交: 'converted',
    成交人数: 'converted',
    成交数: 'converted',
    收入: 'revenue',
    金额: 'revenue',
    回款: 'revenue',
    成交金额: 'revenue',
    成本: 'cost',
    费用: 'cost',
    满意度: 'satisfaction',
  };
  const mapRows = (aoa: any[][]) => {
    if (!aoa.length) return [];
    const headers = (aoa[0] || []).map((h: any) => HEADER_MAP[String(h || '').trim()] || null);
    if (!headers.includes('title')) {
      message.warning('表头需包含「活动名称」列（支持：邀约/报名/到场/成交/收入/成本/满意度）');
      return [];
    }
    return aoa
      .slice(1)
      .map(row => {
        const o: any = {};
        headers.forEach((f, i) => {
          if (f && row[i] !== undefined && row[i] !== '') o[f] = row[i];
        });
        return o;
      })
      .filter(o => o.title);
  };
  const parseFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const XLSX = await loadXlsx();
        const wb = XLSX.read(reader.result, { type: 'array' });
        const aoa: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
        const rows = mapRows(aoa);
        setBatchRows(rows);
        setBatchResult(null);
        if (rows.length) message.success(`已解析 ${rows.length} 行，请核对预览后导入`);
      } catch {
        message.error('文件解析失败：请使用 .xlsx / .csv 格式');
      }
    };
    reader.readAsArrayBuffer(file);
    return false;
  };
  const parsePaste = (text: string) => {
    setBatchPaste(text);
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
      setBatchRows([]);
      return;
    }
    const sep = lines[0].includes('\t') ? '\t' : /,|，/.test(lines[0]) ? /,|，/ : /\s{2,}/;
    const aoa = lines.map(l => l.split(sep as any).map(s => String(s).trim()));
    setBatchRows(mapRows(aoa));
    setBatchResult(null);
  };
  const submitBatch = () => {
    if (!batchRows.length) {
      message.warning('没有可导入的数据');
      return;
    }
    setBatchSubmitting(true);
    api
      .post('/activities/batch-results', { rows: batchRows })
      .then((r: any) => {
        setBatchResult(r);
        const issueCount = (r.unmatched?.length || 0) + (r.invalid?.length || 0);
        const summary = `导入完成：成功 ${r.updated.length} 条${issueCount ? `，待修正 ${issueCount} 条` : ''}`;
        if (issueCount) message.warning(summary);
        else message.success(summary);
        load();
        loadStats();
      })
      .finally(() => setBatchSubmitting(false));
  };

  // 导出当前活动列表（含战果与ROI）
  const [exportingActs, setExportingActs] = useState(false);
  const exportActs = async () => {
    if (!acts.length) {
      message.warning('暂无可导出的活动');
      return;
    }
    setExportingActs(true);
    try {
      const XLSX = await loadXlsx();
      const sheetRows = acts.map((a: any) => ({
        活动名: a.title || '',
        类型: activityTypeLabel(a.type),
        状态: a.status || '',
        日期: a.date || '',
        地点: a.location || '',
        负责人: a.owner || '',
        邀约: a.invited ?? 0,
        报名: a.signed_up ?? 0,
        到场: a.arrived ?? 0,
        成交: a.converted ?? 0,
        成交额: a.revenue ?? 0,
        成本: a.cost ?? 0,
        ROI: Number(a.cost) > 0 ? Math.round(((a.revenue || 0) / a.cost) * 10) / 10 : '',
        满意度: a.satisfaction || '',
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows), '活动列表');
      XLSX.writeFile(wb, `活动列表-${dayjs().format('YYYY-MM-DD')}.xlsx`);
      message.success(`已导出 ${acts.length} 场活动`);
    } catch {
      message.error('活动列表导出失败，请稍后重试');
    } finally {
      setExportingActs(false);
    }
  };

  const loadStats = () => api.get('/activities/stats').then(setStats);
  const load = () =>
    api.get('/activities').then((list: any[]) => {
      setActs(list || []);
      setSelected((prev: any) => {
        if (prev) return (list || []).find(a => a.id === prev.id) || prev;
        const today = dayjs().format('YYYY-MM-DD');
        return (
          (list || []).find(a => a.date === today) || (list || []).find(a => a.date >= today) || (list || [])[0] || null
        );
      });
    });

  useEffect(() => {
    load();
    loadStats();
  }, []);

  const resetCircleState = () => {
    circleRequestRef.current += 1;
    setCircling(false);
    setCircleOpen(false);
    setCirclePreview(null);
    setCircleSelected([]);
  };

  const selectAct = (a: any) => {
    setSelected(a);
    setPlanData(null);
    setPlanDraft(null);
    setPlanOpen(false);
    if (a?.date) setSelDate(dayjs(a.date));
  };

  // ===== 日历 =====
  const cellRender = (d: Dayjs, info: any) => {
    if (info.type !== 'date') return info.originNode;
    const key = d.format('YYYY-MM-DD');
    const list = acts.filter(a => a.date === key);
    if (!list.length) return null;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {list.slice(0, 3).map(a => (
          <div key={a.id} style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            <Badge
              color={TYPE_COLOR[a.type] || 'var(--ui-accent)'}
              text={
                <span
                  style={{
                    fontSize: 11,
                    color: selected?.id === a.id ? 'var(--ui-accent)' : 'var(--ui-text-2)',
                    fontWeight: selected?.id === a.id ? 600 : 400,
                  }}
                >
                  {a.title}
                </span>
              }
            />
          </div>
        ))}
        {list.length > 3 && <span style={{ fontSize: 10.5, color: 'var(--ui-muted)' }}>+{list.length - 3} 场</span>}
      </div>
    );
  };
  const onCalSelect = (d: Dayjs, info: any) => {
    setSelDate(d);
    if (info?.source === 'date') {
      const hit = acts.find(a => a.date === d.format('YYYY-MM-DD'));
      if (hit) {
        resetCircleState();
        selectAct(hit);
      }
    }
  };

  // ===== 新建活动 =====
  const onCreate = (vals: any) => {
    setCreating(true);
    api
      .post('/activities', { ...vals, date: vals.date.format('YYYY-MM-DD') })
      .then(() => {
        message.success('活动创建成功');
        setCreateOpen(false);
        createForm.resetFields();
        load();
        loadStats();
      })
      .finally(() => setCreating(false));
  };

  // ===== 录入战果 =====
  const saveResult = (vals: any) => {
    setSaving(true);
    api
      .put(`/activities/${selected.id}`, vals)
      .then((a: any) => {
        message.success('战果已录入');
        setResultOpen(false);
        setActs(prev => prev.map(x => (x.id === a.id ? a : x)));
        setSelected(a);
        loadStats();
      })
      .finally(() => setSaving(false));
  };
  const deleteActivity = (act: any) => {
    api
      .del(`/activities/${act.id}`)
      .then(() => {
        message.success('活动已删除并进入回收站');
        resetCircleState();
        setSelected(null);
        load();
        loadStats();
      })
      .catch(() => {});
  };

  // ===== 邀约名单 =====
  const fetchInvites = (actId: any) => {
    setInvLoading(true);
    api
      .get(`/activities/${actId}/invites`)
      .then(setInvites)
      .finally(() => setInvLoading(false));
  };
  const openInvites = () => {
    if (!selected) return;
    setInvOpen(true);
    fetchInvites(selected.id);
  };
  const closeInvites = () => {
    circleRequestRef.current += 1;
    setInvOpen(false);
    setCircleOpen(false);
    setCirclePreview(null);
    setCircleSelected([]);
    setCircling(false);
  };
  const previewCircle = () => {
    if (!selected) return;
    const activityId = Number(selected.id);
    const requestId = ++circleRequestRef.current;
    setCircling(true);
    api
      .get(`/activities/${activityId}/invite-candidates?limit=10`)
      .then((preview: any) => {
        if (circleRequestRef.current !== requestId || Number(preview?.activity?.id) !== activityId) return;
        setCirclePreview(preview);
        setCircleSelected(preview.candidates.map((item: any) => Number(item.id)));
        setCircleOpen(true);
      })
      .finally(() => {
        if (circleRequestRef.current === requestId) setCircling(false);
      });
  };
  const confirmCircle = () => {
    const activityId = Number(circlePreview?.activity?.id);
    if (!Number.isSafeInteger(activityId) || circleSelected.length === 0) return;
    const requestId = ++circleRequestRef.current;
    setCircling(true);
    api
      .post(`/activities/${activityId}/invites`, { leadIds: circleSelected, selectionMode: 'smart' })
      .then((result: any) => {
        if (circleRequestRef.current !== requestId) return;
        message.success(`已复核并加入 ${result.added} 位顾客${result.skipped ? `，跳过 ${result.skipped} 位` : ''}`);
        setCircleOpen(false);
        setCirclePreview(null);
        setCircleSelected([]);
        if (Number(selected?.id) === activityId) fetchInvites(activityId);
        load();
      })
      .finally(() => {
        if (circleRequestRef.current === requestId) setCircling(false);
      });
  };
  const changeInviteStatus = (inv: any, status: string) => {
    api.put(`/activities/invites/${inv.id}`, { status }).then(() => {
      message.success(`「${inv.name}」状态已更新为 ${status}`);
      setInvites(prev => prev.map(x => (x.id === inv.id ? { ...x, status } : x)));
      load();
      loadStats();
    });
  };

  // ===== AI 策划 =====
  const genPlan = () => {
    if (!selected) {
      message.warning('请先在日历或看板中选择活动');
      return;
    }
    setPlanLoading(true);
    api
      .post(`/activities/${selected.id}/plan`, { goal: planGoal, audience: planAudience, budget: planBudget })
      .then((r: any) => {
        const safePlan = normalizePlanView(r.plan);
        setPlanData({ ...r, plan: safePlan });
        setPlanDraft(cloneJson(safePlan));
        setPlanOpen(true);
        message.success('策划案已生成');
        load();
      })
      .finally(() => setPlanLoading(false));
  };
  const onAiPlanClick = () => {
    if (selected?.plan) {
      const safePlan = normalizePlanView(selected.plan);
      setPlanData({ plan: safePlan, mode: 'saved' });
      setPlanDraft(cloneJson(safePlan));
      setPlanOpen(true);
    } else genPlan();
  };

  // ===== 复盘 =====
  const updatePlanDraft = (patch: any) => setPlanDraft((p: any) => ({ ...(p || {}), ...patch }));
  const updateFlow = (idx: number, patch: any) =>
    setPlanDraft((p: any) => {
      const flow = [...(p?.flow || [])];
      flow[idx] = { ...(flow[idx] || {}), ...patch };
      return { ...(p || {}), flow };
    });
  const savePlanDraft = () => {
    if (!selected || !planDraft) return;
    setPlanSaving(true);
    api
      .put(`/activities/${selected.id}/plan/draft`, { plan: planDraft })
      .then(() => {
        message.success('策划草稿已保存');
        load();
      })
      .finally(() => setPlanSaving(false));
  };
  const submitPlanApproval = () => {
    if (!selected || !planDraft) return;
    setPlanSubmitting(true);
    api
      .post(`/activities/${selected.id}/plan/submit`, { plan: planDraft })
      .then((r: any) => {
        message.success(r.message || '已提交审批');
        setPlanOpen(false);
        load();
      })
      .finally(() => setPlanSubmitting(false));
  };

  const storedAssignmentRows = (tasks: any[]) =>
    (tasks || []).map((task: any) => ({
      key: task.activity_plan_item || `task-${task.id}`,
      taskId: task.id,
      title: task.title,
      detail: task.detail || '',
      priority: task.priority || '中',
      assigneeId: task.assignee_id,
      assignee: task.assignee,
      dueAt: task.due_at ? dayjs(task.due_at) : null,
      status: task.status,
      feishuNotified: !!task.feishu_notified,
    }));

  const openAssignments = async () => {
    if (!canManageActivityAssignments) {
      message.warning('只有老板或管理层可以分配活动工作');
      return;
    }
    if (!selected || !planDraft) return message.warning('请先生成活动策划案');
    setAssignmentLoading(true);
    try {
      const planLocked = ['待审批', '总审中', '已通过'].includes(selected.plan_status);
      if (!planLocked) {
        await api.put(`/activities/${selected.id}/plan/draft`, { plan: planDraft });
      }
      const [users, tasks] = await Promise.all([
        api.get('/activities/assignees'),
        api.get(`/activities/${selected.id}/assignments`),
      ]);
      setAssignmentUsers(users || []);
      setAssignmentRows(tasks?.length ? storedAssignmentRows(tasks) : assignmentDrafts(planDraft, selected));
      setAssignmentOpen(true);
    } finally {
      setAssignmentLoading(false);
    }
  };

  const updateAssignment = (key: string, patch: any) => {
    setAssignmentRows(rows => rows.map(row => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addAssignment = () => {
    const key = `custom-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    setAssignmentRows(rows => [
      ...rows,
      {
        key,
        title: '',
        detail: '',
        priority: '中',
        assigneeId: undefined,
        dueAt: selected?.date
          ? dayjs(selected.date).hour(18).minute(0).second(0)
          : dayjs().add(1, 'day').hour(18).minute(0).second(0),
      },
    ]);
  };

  const saveAssignments = async () => {
    if (!selected || !assignmentRows.length) return message.warning('请至少保留一项工作');
    const invalidIndex = assignmentRows.findIndex(
      row => !String(row.title || '').trim() || !row.assigneeId || !row.dueAt?.isValid?.(),
    );
    if (invalidIndex >= 0) return message.warning(`请补全第${invalidIndex + 1}项的任务名称、负责人和截止时间`);
    setAssignmentSaving(true);
    try {
      const out = await api.post(`/activities/${selected.id}/assignments`, {
        assignments: assignmentRows.map(row => ({
          key: row.key,
          title: String(row.title).trim(),
          detail: String(row.detail || '').trim(),
          priority: row.priority,
          assigneeId: row.assigneeId,
          dueAt: row.dueAt.format('YYYY-MM-DD HH:mm:ss'),
        })),
      });
      setAssignmentRows(storedAssignmentRows(out.tasks || []));
      if (out.created || out.updated) {
        message.success(
          `已同步 ${out.created + out.updated} 项员工任务${out.feishuQueued ? `，已安排 ${out.feishuQueued} 条飞书提醒` : '；未绑定飞书的员工已收到站内通知'}`,
        );
      } else {
        message.info('工作分配没有变化，未重复创建任务或通知');
      }
    } finally {
      setAssignmentSaving(false);
    }
  };

  const loadStudioDrafts = () =>
    api
      .get('/activities/plan-drafts/list')
      .then((d: any[]) => setStudioDrafts(d || []))
      .catch(() => {});
  const openStudio = () => {
    setStudioOpen(true);
    loadStudioDrafts();
  };
  const generateStudioPlan = async () => {
    const values = await studioForm.validateFields();
    setStudioLoading(true);
    try {
      const out = await api.post('/activities/plan-drafts/generate', {
        ...values,
        date: values.date?.format('YYYY-MM-DD'),
      });
      setStudioDraftId(out.draftId);
      setStudioPlan(cloneJson(normalizePlanView(out.plan)));
      loadStudioDrafts();
      message.success('策划案已生成并自动保存，刷新页面也不会丢失');
    } finally {
      setStudioLoading(false);
    }
  };
  const openStudioDraft = async (id: number) => {
    const row = await api.get(`/activities/plan-drafts/${id}`);
    setStudioDraftId(id);
    setStudioPlan(cloneJson(normalizePlanView(row.plan)));
    studioForm.setFieldsValue({
      title: row.title,
      type: row.type,
      date: row.date ? dayjs(row.date) : null,
      goal: row.goal,
      audience: row.audience,
      budget: row.budget,
      targetJoin: row.target_join || 12,
    });
  };
  const saveStudioPlan = async () => {
    if (!studioDraftId || !studioPlan) return;
    setStudioSaving(true);
    try {
      await api.put(`/activities/plan-drafts/${studioDraftId}`, {
        plan: studioPlan,
        targetJoin: studioForm.getFieldValue('targetJoin'),
      });
      message.success('策划草稿已保存');
      loadStudioDrafts();
    } finally {
      setStudioSaving(false);
    }
  };
  const createActivityFromStudio = async () => {
    if (!studioDraftId || !studioPlan) return;
    const values = await studioForm.validateFields();
    await saveStudioPlan();
    const out = await api.post(`/activities/plan-drafts/${studioDraftId}/create-activity`, {
      date: values.date.format('YYYY-MM-DD'),
      targetJoin: values.targetJoin,
    });
    message.success('策划案已转为正式活动，可继续提交审批和执行');
    await load();
    const rows = await api.get('/activities');
    const activity = (rows || []).find((x: any) => x.id === out.activityId);
    if (activity) {
      resetCircleState();
      selectAct(activity);
    }
    setStudioOpen(false);
  };

  const openReviewFor = (a: any) => {
    setReviewAct(a);
    setReviewData(a?.review || null);
    setOkText('');
    setBadText('');
    setReviewOpen(true);
  };
  const submitReview = () => {
    setReviewSubmitting(true);
    api
      .post(`/activities/${reviewAct.id}/review`, {
        ok: okText
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean),
        bad: badText
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean),
      })
      .then((rv: any) => {
        setReviewData(rv);
        message.success('复盘完成，活动已标记为「已复盘」');
        load();
        loadStats();
      })
      .finally(() => setReviewSubmitting(false));
  };
  const reviewActionItems = (data = reviewData): string[] => {
    const items = [
      ...asList(data?.improvements),
      ...asList(data?.followup),
      ...asList(data?.gaps)
        .slice(0, 3)
        .map(s => String(s).split('：').slice(1).join('：') || String(s)),
    ]
      .map(s => String(s).trim())
      .filter(Boolean);
    return Array.from(new Set(items)).slice(0, 8);
  };
  const buildReviewText = (act = reviewAct, data = reviewData) => {
    const lines = [
      `活动复盘：${act?.title || ''}`,
      `日期：${act?.date || '-'}`,
      `类型：${activityTypeLabel(act?.type)}`,
      '',
      '目标 vs 实际',
      ...Object.entries(data?.target_vs_actual || {}).map(([k, v]: any) => `- ${KEY_ZH[k] || k}：${fmtTVA(v)}`),
      '',
      '转化率 vs 行业基准',
      ...['inviteSign', 'signArrive', 'arriveDeal', 'roi'].map(
        k => `- ${RATE_LABEL[k]}：${data?.rates?.[k] ?? '-'} / 基准 ${data?.baseline?.[k] ?? '-'}`,
      ),
      '',
      '改进项',
      ...asList(data?.improvements).map(s => `- ${s}`),
      '',
      '后续跟进',
      ...asList(data?.followup).map(s => `- ${s}`),
    ];
    if (data?.aiText) lines.push('', `${data?.aiMeta?.marshal || '数据复盘员工'}深度复盘`, String(data.aiText));
    if (data?.kbSync) lines.push('', `知识库：${data.kbSync.category} / ${data.kbSync.title}`);
    return lines.join('\n');
  };
  const copyReview = async () => {
    await navigator.clipboard?.writeText(buildReviewText());
    message.success('复盘内容已复制');
  };
  const exportReview = () => {
    const blob = new Blob([buildReviewText()], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${reviewAct?.title || '活动复盘'}-复盘.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const syncReviewKb = () => {
    if (!reviewAct?.id) return;
    setReviewSyncing(true);
    api
      .post(`/activities/${reviewAct.id}/review/sync-kb`, {})
      .then((r: any) => {
        setReviewData(r.review);
        setReviewAct((a: any) => ({ ...(a || {}), review: r.review, status: '已复盘' }));
        setActs(prev => prev.map(x => (x.id === reviewAct.id ? { ...x, review: r.review, status: '已复盘' } : x)));
        message.success('已同步知识库，并通知管理层');
      })
      .finally(() => setReviewSyncing(false));
  };
  const fmtTVA = (v: any): string => {
    if (v && typeof v === 'object') {
      const t = v.target ?? v.goal ?? v['目标'];
      const a = v.actual ?? v.real ?? v['实际'];
      if (t !== undefined || a !== undefined) return `目标 ${t ?? '-'} / 实际 ${a ?? '-'}`;
      return Object.entries(v)
        .map(([k2, v2]) => `${KEY_ZH[k2] || k2} ${v2}`)
        .join('，');
    }
    return String(v);
  };

  const reviewed = acts.filter(a => a.status === '已复盘');
  const checklist: any[] = selected?.checklist || [];
  const checkDone = checklist.filter(c => c.done).length;
  const toggleCheck = (idx: number, done: boolean) => {
    if (!selected) return;
    if (!done) {
      message.info('已审批完成的事项不能直接取消，请重新提交调整审批');
      return;
    }
    setCheckSubmitting(idx);
    api
      .post(`/activities/${selected.id}/checklist/${idx}/submit`, {})
      .then((r: any) => {
        message.success(r.message || '已提交审批');
        const next = { ...selected, checklist: r.checklist || checklist };
        setActs(prev => prev.map(x => (x.id === selected.id ? next : x)));
        setSelected(next);
        load();
      })
      .finally(() => setCheckSubmitting(null));
  };

  const coverColor = TYPE_COLOR[selected?.type] || 'var(--ui-accent)';
  const baseline = stats.baseline || {};
  const plan = normalizePlanView(planDraft || planData?.plan || {});
  const rv = reviewData || {};
  const rvBaseline = rv.baseline || baseline;
  const calendarSyncStatus = activityCalendarSyncPresentation(calSync.info);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ===== 顶部 KPI（逐卡可点钻取：近90天逐场对比+基准） ===== */}
      <Row gutter={[12, 12]}>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<CalendarOutlined />}
            color="var(--ui-accent)"
            label="本月活动"
            value={stats.monthCount ?? '-'}
            suffix="场"
            onClick={() => openStatsDrill('month')}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<TeamOutlined />}
            color="var(--chart-2)"
            label="报名人数"
            value={stats.signedUp ?? '-'}
            suffix="人"
            onClick={() => openStatsDrill('signed')}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<CheckCircleOutlined />}
            color="var(--warn)"
            label="到场率"
            value={stats.arriveRate != null ? `${stats.arriveRate}%` : '-'}
            onClick={() => openStatsDrill('arrive')}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<DollarOutlined />}
            color="var(--chart-3)"
            label="活动收入"
            value={fmtWan(stats.revenue || 0)}
            onClick={() => openStatsDrill('revenue')}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<RiseOutlined />}
            color="var(--ui-muted)"
            label="转化率"
            value={stats.convRate != null ? `${stats.convRate}%` : '-'}
            onClick={() => openStatsDrill('conv')}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<SmileOutlined />}
            color="var(--danger)"
            label="客户满意度"
            value={stats.satisfaction ?? '-'}
            suffix="分"
            onClick={() => openStatsDrill('sat')}
          />
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        {/* ===== 左侧大区 2/3 ===== */}
        <Col xs={24} lg={16}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* 活动日历 */}
            <Panel
              title="活动日历"
              extra={
                <Space>
                  <Button size="small" icon={<DownloadOutlined />} loading={exportingActs} onClick={exportActs}>
                    导出 Excel
                  </Button>
                  <Button size="small" icon={<RobotOutlined />} onClick={openStudio}>
                    AI活动策划室
                  </Button>
                  {canManageActivityAssignments && (
                    <Button size="small" onClick={openCalSync}>
                      📅 关联飞书日历
                    </Button>
                  )}
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                    新建活动
                  </Button>
                </Space>
              }
            >
              <div
                style={{
                  display: 'flex',
                  gap: 14,
                  flexWrap: 'wrap',
                  marginBottom: 4,
                  fontSize: 12,
                  color: 'var(--ui-text-2)',
                }}
              >
                {ACT_TYPES.map(t => (
                  <span key={t.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: TYPE_COLOR[t.value] }} />
                    {t.label}
                  </span>
                ))}
              </div>
              <Calendar value={selDate} onSelect={onCalSelect} cellRender={cellRender} />
            </Panel>

            {/* 选中活动详情 */}
            <Panel
              title="活动详情"
              extra={
                selected && (
                  <Badge
                    status={STATUS_BADGE[selected.status] || 'default'}
                    text={<span style={{ fontSize: 12, color: 'var(--ui-text-2)' }}>{selected.status}</span>}
                  />
                )
              }
            >
              {!selected ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="点击日历或看板选择活动" />
              ) : (
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {/* 封面色块 */}
                  <div
                    style={{
                      width: 150,
                      minHeight: 178,
                      borderRadius: 10,
                      padding: 14,
                      flexShrink: 0,
                      background: `linear-gradient(160deg, ${coverColor}c8, ${coverColor})`,
                      color: '#fff',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'flex-end',
                    }}
                  >
                    <div style={{ fontSize: 30, marginBottom: 8 }}>{TYPE_EMOJI[selected.type] || '🍽️'}</div>
                    <div style={{ fontWeight: 700, fontSize: 14.5, lineHeight: 1.5 }}>{selected.title}</div>
                    <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 4 }}>
                      {activityTypeLabel(selected.type)} · {selected.date}
                    </div>
                  </div>
                  {/* 信息区 */}
                  <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--ui-text)' }}>{selected.title}</span>
                      <Tag color={TYPE_TAG[selected.type] || 'blue'}>{activityTypeLabel(selected.type)}</Tag>
                      <Badge
                        status={STATUS_BADGE[selected.status] || 'default'}
                        text={<span style={{ fontSize: 12 }}>{selected.status}</span>}
                      />
                      <Tag color={PLAN_STATUS_COLOR[selected.plan_status || '未提交'] || 'default'}>
                        策划审批：{selected.plan_status || '未提交'}
                      </Tag>
                    </div>
                    <div
                      style={{ fontSize: 12.5, color: 'var(--ui-muted)', display: 'flex', gap: 16, flexWrap: 'wrap' }}
                    >
                      <span>
                        <CalendarOutlined /> {selected.date}
                      </span>
                      <span>
                        <EnvironmentOutlined /> {selected.location}
                      </span>
                      <span>
                        <UserOutlined /> 负责人：{selected.owner || '-'}
                      </span>
                      <span>
                        <DollarOutlined /> 预算 {fmtMoney(selected.budget || 0)}
                        {selected.cost ? ` / 实际 ${fmtMoney(selected.cost)}` : ''}
                      </span>
                    </div>
                    {/* 目标进度四格 + 收入 */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 8 }}>
                      {[
                        { label: '邀约', v: selected.invited ?? 0, sub: '人' },
                        { label: '报名', v: selected.signed_up ?? 0, sub: `/ 目标${selected.target_join ?? '-'}` },
                        { label: '到场', v: selected.arrived ?? 0, sub: '人' },
                        { label: '成交', v: selected.converted ?? 0, sub: `/ 目标${selected.target_deal ?? '-'}` },
                        { label: '收入', v: fmtWan(selected.revenue || 0), sub: '' },
                      ].map((c, i) => (
                        <div
                          key={c.label}
                          style={{
                            background: 'var(--ui-surface-2)',
                            borderRadius: 8,
                            padding: '10px 12px',
                            position: 'relative',
                          }}
                        >
                          <div style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}>
                            {c.label}
                            {i < 3 ? ' →' : ''}
                          </div>
                          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--ui-text)', whiteSpace: 'nowrap' }}>
                            {c.v}
                          </div>
                          {c.sub && <div style={{ fontSize: 10.5, color: 'var(--ui-muted)' }}>{c.sub}</div>}
                        </div>
                      ))}
                    </div>
                    <Progress
                      size="small"
                      percent={
                        selected.target_join > 0
                          ? Math.min(Math.round(((selected.signed_up || 0) / selected.target_join) * 100), 100)
                          : 0
                      }
                      format={p => (selected.target_join > 0 ? `报名达成 ${p}%` : '未设目标')}
                      strokeColor="var(--ui-accent)"
                    />
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <Button type="primary" icon={<BulbOutlined />} onClick={onAiPlanClick} loading={planLoading}>
                        AI策划
                      </Button>
                      <Button icon={<TeamOutlined />} onClick={openInvites}>
                        邀约名单
                      </Button>
                      <Button icon={<EditOutlined />} onClick={() => setResultOpen(true)}>
                        录入战果
                      </Button>
                      <Button icon={<FileDoneOutlined />} onClick={() => openReviewFor(selected)}>
                        活动复盘
                      </Button>
                      <Button icon={<UploadOutlined />} onClick={() => setBatchOpen(true)}>
                        批量战果导入
                      </Button>
                      <Popconfirm
                        title={`删除活动「${selected.title}」？`}
                        description="删除后进入回收站，老板/管理员可恢复。"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => deleteActivity(selected)}
                      >
                        <Button danger icon={<DeleteOutlined />}>
                          删除活动
                        </Button>
                      </Popconfirm>
                    </div>
                  </div>
                </div>
              )}
            </Panel>

            {/* 活动看板 */}
            <Panel title="活动看板">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
                {KANBAN_COLS.map(col => {
                  const list = acts.filter(a => col.sts.includes(a.status));
                  return (
                    <div
                      key={col.title}
                      style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: 10, minHeight: 140 }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 4, background: col.color }} />
                        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ui-text)' }}>{col.title}</span>
                        <span style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}>{list.length} 场</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {list.length === 0 && (
                          <div
                            style={{ fontSize: 12, color: 'var(--ui-muted)', textAlign: 'center', padding: '14px 0' }}
                          >
                            暂无活动
                          </div>
                        )}
                        {list.map(a => (
                          <button
                            type="button"
                            key={a.id}
                            onClick={() => {
                              resetCircleState();
                              selectAct(a);
                            }}
                            style={{
                              ...buttonResetStyle,
                              textAlign: 'left',
                              background: 'var(--ui-surface)',
                              borderRadius: 8,
                              padding: '10px 12px',
                              cursor: 'pointer',
                              border:
                                selected?.id === a.id ? '1.5px solid var(--ui-accent)' : '1px solid var(--ui-border)',
                              boxShadow: selected?.id === a.id ? '0 2px 8px rgba(43,109,239,.15)' : 'none',
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <Tag color={TYPE_TAG[a.type] || 'blue'} style={{ fontSize: 11, marginRight: 0 }}>
                                {activityTypeLabel(a.type)}
                              </Tag>
                              <Badge
                                status={STATUS_BADGE[a.status] || 'default'}
                                text={<span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{a.status}</span>}
                              />
                            </div>
                            <div
                              style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--ui-text)', margin: '6px 0 2px' }}
                            >
                              {a.title}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>
                              {a.date} · {a.location}
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color: 'var(--ui-text-2)',
                                marginTop: 4,
                                display: 'flex',
                                justifyContent: 'space-between',
                              }}
                            >
                              <span>
                                报名 {a.signed_up ?? 0}/{a.target_join ?? '-'}
                              </span>
                              {a.revenue > 0 && (
                                <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{fmtWan(a.revenue)}</span>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          </div>
        </Col>

        {/* ===== 右侧栏 1/3 ===== */}
        <Col xs={24} lg={8}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* AI 活动策划 */}
            <Panel
              title={
                <>
                  <RobotOutlined style={{ color: 'var(--ui-accent)' }} /> AI活动策划
                </>
              }
              extra={
                <Tag color="blue" style={{ fontSize: 11 }}>
                  智能体
                </Tag>
              }
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div
                  style={{
                    background: 'var(--ui-surface-2)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    fontSize: 12,
                    color: 'var(--ui-text-2)',
                  }}
                >
                  <AimOutlined style={{ color: 'var(--ui-accent)' }} /> 针对活动：
                  <b style={{ color: 'var(--ui-text)' }}>{selected ? selected.title : '请先选择活动'}</b>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginBottom: 4 }}>活动目标</div>
                  <Select
                    style={{ width: '100%' }}
                    value={planGoal}
                    onChange={setPlanGoal}
                    options={['提升到店与服务转化', '预订转化', '会员复购', '品牌传播'].map(v => ({
                      value: v,
                      label: v,
                    }))}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginBottom: 4 }}>目标人群</div>
                  <Input
                    value={planAudience}
                    onChange={e => setPlanAudience(e.target.value)}
                    placeholder="如：已授权老顾客、附近家庭、周边白领"
                  />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginBottom: 4 }}>预算档位</div>
                  <Select
                    style={{ width: '100%' }}
                    value={planBudget}
                    onChange={setPlanBudget}
                    options={['待确认', '1万以内', '1-3万', '3-5万', '5万以上'].map(v => ({ value: v, label: v }))}
                  />
                </div>
                <Button
                  block
                  icon={<ThunderboltOutlined />}
                  loading={planLoading}
                  onClick={genPlan}
                  style={{
                    background: 'linear-gradient(135deg,var(--ui-primary-strong),var(--chart-3))',
                    border: 'none',
                    color: '#fff',
                    fontWeight: 600,
                  }}
                >
                  生成策划案
                </Button>
                <div style={{ fontSize: 11, color: 'var(--ui-muted)', textAlign: 'center' }}>
                  仅使用当前账号可见的CRM与本店已配置基准；缺失项标记待确认，上游超时会切换本地策划引擎
                </div>
                <div style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ui-text)', marginBottom: 4 }}>
                    本店已配置转化基准
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 11,
                      color: 'var(--ui-text-2)',
                      flexWrap: 'wrap',
                      gap: 4,
                    }}
                  >
                    <span>邀约→报名 {baseline.inviteSign ?? '-'}%</span>
                    <span>报名→到场 {baseline.signArrive ?? '-'}%</span>
                    <span>到场→成交 {baseline.arriveDeal ?? '-'}%</span>
                    <span>ROI {baseline.roi ?? '-'}</span>
                  </div>
                </div>
              </div>
            </Panel>

            {/* 待确认事项 */}
            <Panel
              title="待确认事项"
              extra={
                checklist.length > 0 && (
                  <span
                    style={{ fontSize: 12, color: checkDone === checklist.length ? 'var(--ok)' : 'var(--ui-muted)' }}
                  >
                    {checkDone}/{checklist.length} 已完成
                  </span>
                )
              }
            >
              {!selected || checklist.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选中活动后显示筹备清单" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <Progress
                    size="small"
                    showInfo={false}
                    percent={Math.round((checkDone / checklist.length) * 100)}
                    strokeColor="var(--chart-2)"
                  />
                  {checklist.map((c: any, i: number) => {
                    const status = c.approvalStatus;
                    const locked = !!c.done || status === '待审批' || status === '总审中';
                    return (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          padding: '5px 0',
                          borderBottom: i < checklist.length - 1 ? '1px dashed var(--ui-border)' : 'none',
                        }}
                      >
                        <Checkbox
                          checked={!!c.done}
                          disabled={locked || checkSubmitting === i}
                          onChange={e => toggleCheck(i, e.target.checked)}
                        >
                          <span
                            style={{
                              fontSize: 12.5,
                              color: c.done ? 'var(--ui-muted)' : 'var(--ui-text-2)',
                              textDecoration: c.done ? 'line-through' : 'none',
                            }}
                          >
                            {c.item}
                          </span>
                        </Checkbox>
                        <Space size={4}>
                          {checkSubmitting === i && (
                            <Tag color="processing" style={{ marginRight: 0, fontSize: 11 }}>
                              提交中
                            </Tag>
                          )}
                          {status && (
                            <Tag
                              color={CHECK_STATUS_COLOR[status] || 'default'}
                              style={{ marginRight: 0, fontSize: 11 }}
                            >
                              {status}
                            </Tag>
                          )}
                        </Space>
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>

            {/* 历史活动复盘 */}
            <Panel
              title={
                <>
                  <HistoryOutlined style={{ color: 'var(--chart-3)' }} /> 历史活动复盘
                </>
              }
              extra={<span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{reviewed.length} 场</span>}
            >
              {reviewed.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已复盘活动" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {reviewed.map((a, i) => (
                    <button
                      type="button"
                      key={a.id}
                      onClick={() => openReviewFor(a)}
                      style={{
                        ...buttonResetStyle,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 0',
                        cursor: 'pointer',
                        borderBottom: i < reviewed.length - 1 ? '1px solid var(--ui-surface-2)' : 'none',
                      }}
                    >
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          background: TYPE_COLOR[a.type] || 'var(--ui-accent)',
                          flexShrink: 0,
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 12.5,
                            fontWeight: 600,
                            color: 'var(--ui-text)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {a.title}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>
                          {a.date} · 收入 {fmtWan(a.revenue || 0)}
                        </div>
                        <Space size={4} style={{ marginTop: 4 }}>
                          <Tag color={a.review?.kbSync ? 'green' : 'orange'} style={{ marginRight: 0, fontSize: 10.5 }}>
                            {a.review?.kbSync ? '已入库' : '待入库'}
                          </Tag>
                          <span style={{ fontSize: 10.5, color: 'var(--ui-accent)' }}>点击查看 / 处理</span>
                        </Space>
                      </div>
                      <RightOutlined style={{ fontSize: 10, color: '#c3cad6' }} />
                    </button>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </Col>
      </Row>

      {/* ===== 统计卡钻取 Modal ===== */}
      <Modal
        open={statsDrill.open}
        width={860}
        footer={null}
        onCancel={() => setStatsDrill({ open: false, kind: '', data: null })}
        title={
          <>
            {
              (
                {
                  month: '📅 本月及近90天活动明细',
                  signed: '👥 报名人数构成（逐场）',
                  arrive: '✅ 到场率逐场对比（基准70%）',
                  revenue: '💰 活动收入与ROI（逐场）',
                  conv: '📈 到场→成交转化对比（基准25%）',
                  sat: '😊 客户满意度逐场对比',
                } as Record<string, string>
              )[statsDrill.kind]
            }
          </>
        }
      >
        {!statsDrill.data ? (
          <div style={{ textAlign: 'center', padding: 30 }}>
            <Spin />
          </div>
        ) : (
          (() => {
            const k = statsDrill.kind;
            const base = statsDrill.data.baseline || {};
            const rows = [...statsDrill.data.rows].sort((a: any, b: any) =>
              k === 'signed'
                ? (b.signed_up || 0) - (a.signed_up || 0)
                : k === 'arrive'
                  ? (b.arriveRate || 0) - (a.arriveRate || 0)
                  : k === 'revenue'
                    ? (b.revenue || 0) - (a.revenue || 0)
                    : k === 'conv'
                      ? (b.convRate || 0) - (a.convRate || 0)
                      : k === 'sat'
                        ? (b.satisfaction || 0) - (a.satisfaction || 0)
                        : String(b.date).localeCompare(String(a.date)),
            );
            const hl = (cond: boolean) => (cond ? { color: 'var(--danger)', fontWeight: 700 } : { fontWeight: 600 });
            return (
              <>
                <Table
                  size="small"
                  rowKey="id"
                  dataSource={rows}
                  pagination={{ pageSize: 8, size: 'small' }}
                  onRow={(r: any) => ({
                    onClick: () => {
                      const a = acts.find(x => x.id === r.id);
                      if (!a) return;
                      circleRequestRef.current += 1;
                      setCircling(false);
                      setCircleOpen(false);
                      setCirclePreview(null);
                      setCircleSelected([]);
                      selectAct(a);
                      setStatsDrill({ open: false, kind: '', data: null });
                      message.success(`已定位活动「${r.title}」`, 1.4);
                    },
                    style: { cursor: 'pointer' },
                  })}
                  columns={[
                    {
                      title: '活动',
                      dataIndex: 'title',
                      ellipsis: true,
                      render: (v: any, r: any) => (
                        <span>
                          {TYPE_EMOJI[r.type] || '📌'} <b>{v}</b>
                        </span>
                      ),
                    },
                    { title: '日期', dataIndex: 'date', width: 96 },
                    {
                      title: '状态',
                      dataIndex: 'status',
                      width: 76,
                      render: (v: any) => (
                        <Badge status={STATUS_BADGE[v] || 'default'} text={<span style={{ fontSize: 12 }}>{v}</span>} />
                      ),
                    },
                    {
                      title: '报名',
                      dataIndex: 'signed_up',
                      width: 60,
                      align: 'right',
                      render: (v: any, r: any) => (
                        <span style={k === 'signed' ? { fontWeight: 700, color: 'var(--chart-2)' } : {}}>
                          {v ?? 0}/{r.target_join ?? '-'}
                        </span>
                      ),
                    },
                    {
                      title: '到场率',
                      dataIndex: 'arriveRate',
                      width: 76,
                      align: 'right',
                      render: (v: any) => (
                        <span style={k === 'arrive' ? hl(v < (base.signArrive ?? 70)) : {}}>
                          {v != null ? `${v}%` : '-'}
                        </span>
                      ),
                    },
                    {
                      title: '成交转化',
                      dataIndex: 'convRate',
                      width: 80,
                      align: 'right',
                      render: (v: any) => (
                        <span style={k === 'conv' ? hl(v < (base.arriveDeal ?? 25)) : {}}>
                          {v != null ? `${v}%` : '-'}
                        </span>
                      ),
                    },
                    {
                      title: '收入',
                      dataIndex: 'revenue',
                      width: 88,
                      align: 'right',
                      render: (v: any) => (
                        <span style={k === 'revenue' ? { fontWeight: 700, color: 'var(--chart-3)' } : {}}>
                          {fmtMoney(v || 0)}
                        </span>
                      ),
                    },
                    {
                      title: 'ROI',
                      dataIndex: 'roi',
                      width: 56,
                      align: 'right',
                      render: (v: any) =>
                        v == null ? '-' : <span style={k === 'revenue' ? hl(v < (base.roi ?? 2)) : {}}>{v}</span>,
                    },
                    {
                      title: '满意度',
                      dataIndex: 'satisfaction',
                      width: 66,
                      align: 'right',
                      render: (v: any) => (
                        <span style={k === 'sat' ? { fontWeight: 700, color: 'var(--danger)' } : {}}>{v || '-'}</span>
                      ),
                    },
                  ]}
                />
                <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--ui-muted)' }}>
                  口径：{statsDrill.data.range}全部活动；行业基准 报名→到场≥{base.signArrive ?? 70}%、到场→成交≥
                  {base.arriveDeal ?? 25}%、ROI≥{base.roi ?? 2.0}（低于基准标红）。点击任意一行定位该活动详情。
                </div>
              </>
            );
          })()
        )}
      </Modal>

      {/* ===== 批量战果导入 Modal ===== */}
      <Modal
        open={batchOpen}
        width={720}
        footer={null}
        onCancel={() => {
          setBatchOpen(false);
          setBatchRows([]);
          setBatchPaste('');
          setBatchResult(null);
        }}
        title={
          <>
            <UploadOutlined style={{ color: 'var(--ui-accent)' }} /> 批量战果导入（文件 / 粘贴）
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Alert
            type="info"
            showIcon
            message={
              <span>
                表头包含 <b>活动名称</b>（必须）+ 任意数值列：<b>邀约 / 报名 / 到场 / 成交 / 收入 / 成本 / 满意度</b>。
                按活动名称自动匹配（支持模糊），一次最多200行。
              </span>
            }
          />
          <label
            htmlFor="batch-file-input"
            style={{
              display: 'block',
              width: '100%',
              border: '1.5px dashed #d1d1d1',
              borderRadius: 10,
              padding: '18px 12px',
              textAlign: 'center',
              cursor: 'pointer',
              background: 'var(--ui-surface)',
            }}
          >
            <InboxOutlined style={{ fontSize: 30, color: 'var(--ui-accent)' }} />
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ui-text)', marginTop: 6 }}>
              点击选择 Excel(.xlsx) / CSV 文件
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', marginTop: 2 }}>自动识别表头并解析全部数据行</div>
            <input
              id="batch-file-input"
              type="file"
              accept=".xlsx,.xls,.csv"
              style={{ display: 'none' }}
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) parseFile(f);
                (e.target as HTMLInputElement).value = '';
              }}
            />
          </label>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ui-text)', marginBottom: 6 }}>
              或：从 Excel 直接复制粘贴（含表头）
            </div>
            <Input.TextArea
              rows={4}
              value={batchPaste}
              onChange={e => parsePaste(e.target.value)}
              placeholder={'活动名称\t邀约\t报名\t到场\t成交\t收入\n夏季招牌菜主题试吃\t40\t25\t18\t6\t96000'}
            />
          </div>
          {batchRows.length > 0 && (
            <>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ui-text)' }}>
                预览（{batchRows.length} 行）
              </div>
              <Table
                size="small"
                rowKey={(_, i) => String(i)}
                dataSource={batchRows}
                pagination={{ pageSize: 5, size: 'small' }}
                columns={[
                  { title: '活动名称', dataIndex: 'title', render: (v: any) => <b>{v}</b> },
                  { title: '邀约', dataIndex: 'invited', width: 60 },
                  { title: '报名', dataIndex: 'signed_up', width: 60 },
                  { title: '到场', dataIndex: 'arrived', width: 60 },
                  { title: '成交', dataIndex: 'converted', width: 60 },
                  { title: '收入', dataIndex: 'revenue', width: 90 },
                  { title: '成本', dataIndex: 'cost', width: 80 },
                  { title: '满意度', dataIndex: 'satisfaction', width: 70 },
                  {
                    title: '',
                    width: 46,
                    render: (_: any, __: any, i: number) => (
                      <button
                        type="button"
                        className="ui-link-button"
                        onClick={() => setBatchRows(prev => prev.filter((_x, j) => j !== i))}
                      >
                        删
                      </button>
                    ),
                  },
                ]}
              />
              <Button type="primary" block loading={batchSubmitting} onClick={submitBatch}>
                确认导入 {batchRows.length} 行（自动联动统计与复盘）
              </Button>
            </>
          )}
          {batchResult && (
            <Alert
              type={batchResult.unmatched?.length || batchResult.invalid?.length ? 'warning' : 'success'}
              showIcon
              message={`导入完成：成功更新 ${batchResult.updated.length} 场活动`}
              description={
                batchResult.unmatched?.length || batchResult.invalid?.length ? (
                  <div style={{ lineHeight: 1.7 }}>
                    {!!batchResult.unmatched?.length && <div>未匹配：{batchResult.unmatched.join('、')}</div>}
                    {!!batchResult.invalid?.length && <div>校验失败：{batchResult.invalid.join('、')}</div>}
                    <div>请修正后只重新导入失败行，已成功数据无需重复导入。</div>
                  </div>
                ) : (
                  '全部匹配成功，活动统计已实时刷新'
                )
              }
            />
          )}
        </div>
      </Modal>

      {/* ===== 飞书日历关联 Modal ===== */}
      <Modal
        open={calSync.open}
        width={560}
        footer={null}
        onCancel={() => setCalSync({ open: false, info: null, error: '' })}
        title={
          <Space>
            📅 关联飞书日历<Tag color="blue">{calSync.info?.eventCount ?? '-'} 个活动可同步</Tag>
          </Space>
        }
      >
        {calSync.error ? (
          <Alert
            type="error"
            showIcon
            message="企业日历关联状态加载失败"
            description={calSync.error}
            action={<Button onClick={openCalSync}>重新加载</Button>}
          />
        ) : !calSync.info ? (
          <div style={{ textAlign: 'center', padding: 30 }}>
            <Spin />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Alert
              type={calendarSyncStatus.ready ? 'success' : calendarSyncStatus.state === 'failed' ? 'error' : 'info'}
              showIcon
              message={calendarSyncStatus.label}
              description={calendarSyncStatus.message}
            />
            <div
              style={{
                background: 'var(--ui-surface)',
                border: '1px solid var(--ui-border-strong)',
                borderRadius: 10,
                padding: 14,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>自动同步 · 企业应用直写</div>
              <div style={{ fontSize: 12.5, color: 'var(--ui-text-2)', lineHeight: 1.8 }}>
                新建活动、改期、改状态、改地点/目标后，系统会自动创建或更新飞书「门店经营活动」日程，设置 24小时前 /
                2小时前提醒，并把门店老板、运营负责人、管理员加入日程参与人。
              </div>
              <Space wrap style={{ marginTop: 8 }}>
                <Tag color={calendarSyncStatus.color}>{calendarSyncStatus.label}</Tag>
                <Tag color={calendarSyncStatus.ready && calSync.info.appBotReady ? 'green' : 'default'}>
                  {calendarSyncStatus.ready && calSync.info.appBotReady
                    ? '机器人已验证就绪'
                    : calSync.info.appBotReady
                      ? '机器人配置已启用，需验证'
                      : '机器人待配置'}
                </Tag>
                <Tag color={(calSync.info.managers?.calendarCount || 0) > 0 ? 'green' : 'orange'}>
                  日历参与人 {calSync.info.managers?.calendarCount || 0}
                </Tag>
                <Tag color={(calSync.info.managers?.count || 0) > 0 ? 'blue' : 'orange'}>
                  消息接收人 {calSync.info.managers?.count || 0}
                </Tag>
              </Space>
              {(calSync.info.managers?.recipients || []).length > 0 && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(calSync.info.managers.recipients || []).map((r: any, i: number) => (
                    <div
                      key={`${r.receiveIdType}-${r.receiveId}-${i}`}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: 12,
                        background: 'var(--ui-surface)',
                        border: '1px solid var(--ui-surface)',
                        borderRadius: 8,
                        padding: '6px 8px',
                      }}
                    >
                      <span style={{ fontWeight: 600, color: 'var(--ui-text)' }}>
                        {r.receiverName || r.userName || '飞书用户'}{' '}
                        <Tag color="blue" style={{ marginLeft: 6 }}>
                          {r.roleLabel || '管理者'}
                        </Tag>
                      </span>
                      <Tag color={r.calendarReady ? 'green' : 'default'}>
                        {r.calendarReady ? '日历提醒' : '消息提醒'}
                      </Tag>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div
              style={{
                background: 'var(--ui-surface-2)',
                border: '1px solid var(--ui-border-strong)',
                borderRadius: 10,
                padding: 14,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>备用 · 下载导入（0配置）</div>
              <div style={{ fontSize: 12.5, color: 'var(--ui-text-2)', lineHeight: 1.8 }}>
                点击下载日历文件 → 打开飞书日历 → 左侧「＋」→「导入日历」→
                选择该文件，全部活动一次进飞书。企业应用未开通时可先用这个。
              </div>
              <Button
                type="primary"
                style={{ marginTop: 8 }}
                onClick={() => {
                  window.open(calSync.info.icsUrl, '_blank');
                  message.success('日历文件已开始下载（.ics）');
                }}
              >
                ⬇️ 下载日历文件（.ics）
              </Button>
            </div>
            <div
              style={{
                background: 'var(--ui-surface-2)',
                border: '1px solid var(--ui-border)',
                borderRadius: 10,
                padding: 14,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>
                备用 · 订阅地址（公网部署后持续同步）
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--ui-text-2)', lineHeight: 1.8 }}>
                飞书日历 →「＋」→「订阅日历」→ 粘贴下方地址。新建/改期活动自动出现，无需再操作。
                <b>需系统部署到公网后生效</b>（本地试用阶段请用方式一）。
              </div>
              <Input.Search
                readOnly
                value={calSync.info.icsUrl}
                enterButton="复制"
                style={{ marginTop: 8 }}
                onSearch={() => {
                  navigator.clipboard?.writeText(calSync.info.icsUrl);
                  message.success('订阅地址已复制');
                }}
              />
            </div>
          </div>
        )}
      </Modal>

      <Drawer
        open={studioOpen}
        width="min(820px, 100vw)"
        onClose={() => setStudioOpen(false)}
        title={
          <Space>
            <RobotOutlined style={{ color: 'var(--ui-accent)' }} />
            AI活动策划室<Tag color="blue">独立生成 · 自动保存</Tag>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="无需先建活动。先生成并修改策划草稿，确认后再转为正式活动，页面跳转或刷新不会丢失。"
        />
        {!!studioDrafts.length && (
          <div style={{ marginBottom: 12 }}>
            <Select
              allowClear
              placeholder="调取历史策划草稿"
              style={{ width: '100%' }}
              value={studioDraftId || undefined}
              onChange={v => v && openStudioDraft(v)}
              options={studioDrafts.map(d => ({
                value: d.id,
                label: `${d.title} · ${d.owner_name || '本人'} · ${d.status} · ${(d.updated_at || d.created_at || '').slice(0, 16)}`,
              }))}
            />
          </div>
        )}
        <Form
          form={studioForm}
          layout="vertical"
          initialValues={{
            type: DEFAULT_ACTIVITY_TYPE,
            date: dayjs().add(7, 'day'),
            targetJoin: 12,
            goal: '提升到店与服务转化',
            audience: '已授权触达的目标顾客',
            budget: '待确认',
          }}
        >
          <Row gutter={10}>
            <Col xs={24} md={12}>
              <Form.Item name="title" label="活动主题" rules={[{ required: true, message: '请填写活动主题' }]}>
                <Input placeholder="如：夏季招牌菜主题试吃" />
              </Form.Item>
            </Col>
            <Col xs={12} md={6}>
              <Form.Item name="type" label="活动类型">
                <Select options={ACT_TYPES} />
              </Form.Item>
            </Col>
            <Col xs={12} md={6}>
              <Form.Item name="date" label="拟举办日期" rules={[{ required: true, message: '请选择日期' }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={10}>
            <Col xs={24} md={6}>
              <Form.Item name="goal" label="活动目标">
                <Select
                  options={['提升到店与服务转化', '预订转化', '会员复购', '品牌传播'].map(v => ({
                    value: v,
                    label: v,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={9}>
              <Form.Item name="audience" label="目标人群">
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} md={5}>
              <Form.Item name="budget" label="预算档位">
                <Select
                  options={['待确认', '1万以内', '1-3万', '3-5万', '5万以上'].map(v => ({ value: v, label: v }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={4}>
              <Form.Item name="targetJoin" label="目标人数">
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Button
            type="primary"
            block
            icon={<ThunderboltOutlined />}
            loading={studioLoading}
            onClick={generateStudioPlan}
          >
            生成并保存策划案
          </Button>
        </Form>
        {studioPlan && (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Panel title="可编辑策划结果">
              <Input
                value={studioPlan.theme || ''}
                onChange={e => setStudioPlan((p: any) => ({ ...p, theme: e.target.value }))}
                placeholder="活动主题"
                style={{ marginBottom: 10 }}
              />
              <Table
                size="small"
                rowKey="_i"
                pagination={false}
                dataSource={normalizePlanView(studioPlan).flow.map((x: any, i: number) => ({ ...x, _i: i }))}
                columns={[
                  {
                    title: '时间',
                    dataIndex: 'time',
                    width: 140,
                    render: (v: string, _r: any, i: number) => (
                      <Input
                        size="small"
                        value={v}
                        onChange={e =>
                          setStudioPlan((p: any) => ({
                            ...p,
                            flow: p.flow.map((x: any, j: number) => (j === i ? { ...x, time: e.target.value } : x)),
                          }))
                        }
                      />
                    ),
                  },
                  {
                    title: '执行环节',
                    dataIndex: 'item',
                    render: (v: string, _r: any, i: number) => (
                      <Input
                        size="small"
                        value={v}
                        onChange={e =>
                          setStudioPlan((p: any) => ({
                            ...p,
                            flow: p.flow.map((x: any, j: number) => (j === i ? { ...x, item: e.target.value } : x)),
                          }))
                        }
                      />
                    ),
                  },
                ]}
              />
              <div style={{ marginTop: 10 }}>
                <Select
                  mode="tags"
                  style={{ width: '100%' }}
                  value={asList(studioPlan.materials)}
                  onChange={v => setStudioPlan((p: any) => ({ ...p, materials: v }))}
                  placeholder="物料清单"
                />
              </div>
              <Input.TextArea
                rows={4}
                style={{ marginTop: 10 }}
                value={listText(studioPlan.sop)}
                onChange={e => setStudioPlan((p: any) => ({ ...p, sop: textList(e.target.value) }))}
                placeholder="执行SOP，每行一条"
              />
            </Panel>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button loading={studioSaving} onClick={saveStudioPlan}>
                保存草稿
              </Button>
              <Button type="primary" onClick={createActivityFromStudio}>
                转为正式活动
              </Button>
            </div>
          </div>
        )}
      </Drawer>

      {/* ===== 新建活动 Modal ===== */}
      <Modal
        title="新建活动"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={creating}
        okText="创建"
        destroyOnClose
      >
        <Form
          form={createForm}
          layout="vertical"
          onFinish={onCreate}
          initialValues={{ type: DEFAULT_ACTIVITY_TYPE, target_join: 30, target_deal: 8, budget: 20000 }}
        >
          <Form.Item name="title" label="活动名称" rules={[{ required: true, message: '请输入活动名称' }]}>
            <Input placeholder="如：工作日午市招牌菜主题试吃" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="type" label="活动类型" rules={[{ required: true }]}>
                <Select options={ACT_TYPES} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="date" label="活动日期" rules={[{ required: true, message: '请选择日期' }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="location" label="活动地点" rules={[{ required: true, message: '请输入地点' }]}>
            <Input placeholder="如：品牌餐厅·中心店" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="target_join" label="目标报名(人)">
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="target_deal" label="目标成交(单)">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="budget" label="预算(元)">
                <InputNumber min={0} step={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* ===== 录入战果 Modal ===== */}
      <Modal
        title={`录入战果 · ${selected?.title || ''}`}
        open={resultOpen}
        onCancel={() => setResultOpen(false)}
        onOk={() => resultForm.submit()}
        confirmLoading={saving}
        okText="保存战果"
        destroyOnClose
      >
        <Form
          form={resultForm}
          layout="vertical"
          onFinish={saveResult}
          initialValues={{
            invited: selected?.invited,
            signed_up: selected?.signed_up,
            arrived: selected?.arrived,
            converted: selected?.converted,
            revenue: selected?.revenue,
            cost: selected?.cost,
            satisfaction: selected?.satisfaction,
          }}
        >
          <Row gutter={12}>
            <Col span={6}>
              <Form.Item name="invited" label="邀约人数">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="signed_up" label="报名人数">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="arrived" label="到场人数">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="converted" label="成交数">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="revenue" label="活动收入(元)">
                <InputNumber min={0} step={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="cost" label="实际成本(元)">
                <InputNumber min={0} step={500} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="satisfaction" label="客户满意度(0-5分)">
            <InputNumber min={0} max={5} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ===== 邀约名单 Drawer ===== */}
      <Drawer
        title={`邀约名单 · ${selected?.title || ''}`}
        width="min(780px, 100vw)"
        open={invOpen}
        onClose={closeInvites}
        extra={
          <Button type="primary" icon={<ThunderboltOutlined />} loading={circling} onClick={previewCircle}>
            预览智能圈选
          </Button>
        }
      >
        <div
          style={{
            background: 'var(--ui-surface-2)',
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: 12,
            color: 'var(--ui-text-2)',
            marginBottom: 12,
          }}
        >
          <BulbOutlined style={{ color: 'var(--ui-accent)' }} />{' '}
          「智能圈选」只生成当前账号权限内的候选预览；查看命中规则和排除原因、勾选复核后，才会加入名单。系统不会自动联系顾客。
        </div>
        <Table
          size="small"
          rowKey="id"
          loading={invLoading}
          dataSource={invites}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          columns={[
            { title: '客户', dataIndex: 'name', render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span> },
            { title: '等级', dataIndex: 'grade', width: 70, render: (v: string) => <GradeTag grade={v} /> },
            {
              title: '成交评分',
              dataIndex: 'score',
              width: 90,
              align: 'right',
              render: (v: number) => (
                <span style={{ color: v >= 70 ? 'var(--danger)' : 'var(--ui-text-2)', fontWeight: 600 }}>
                  {v ?? '-'}分
                </span>
              ),
            },
            { title: '阶段', dataIndex: 'stage', width: 90, render: (v: string) => <StageTag stage={v} /> },
            {
              title: '兴趣点',
              dataIndex: 'interest',
              ellipsis: true,
              render: (v: string) => <span style={{ fontSize: 12, color: 'var(--ui-text-2)' }}>{v || '-'}</span>,
            },
            {
              title: '邀约状态',
              dataIndex: 'status',
              width: 110,
              render: (v: string, r: any) => (
                <Select
                  size="small"
                  value={v}
                  style={{ width: 96 }}
                  options={INVITE_STATUS.map(s => ({ value: s, label: s }))}
                  onChange={s => changeInviteStatus(r, s)}
                />
              ),
            },
          ]}
        />
      </Drawer>

      {/* ===== 智能圈选复核 Modal ===== */}
      <Modal
        title={`智能圈选复核 · ${circlePreview?.activity?.title || selected?.title || ''}`}
        open={circleOpen}
        width={920}
        okText={`确认加入 ${circleSelected.length} 位`}
        confirmLoading={circling}
        okButtonProps={{ disabled: circleSelected.length === 0 }}
        onOk={confirmCircle}
        onCancel={() => {
          circleRequestRef.current += 1;
          setCircling(false);
          setCircleOpen(false);
          setCirclePreview(null);
          setCircleSelected([]);
        }}
      >
        {circlePreview && (
          <>
            <Alert type="info" showIcon style={{ marginBottom: 12 }} message={circlePreview.privacyNote} />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))',
                gap: 8,
                marginBottom: 12,
              }}
            >
              {[
                ['权限内顾客', circlePreview.counts.scopedTotal],
                ['符合规则', circlePreview.counts.eligible],
                ['本次候选', circlePreview.counts.selected],
                ['已排除', circlePreview.counts.excluded],
              ].map(([label, value]) => (
                <div
                  key={String(label)}
                  style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--ui-surface-2)' }}
                >
                  <div style={{ fontSize: 12, color: 'var(--ui-text-2)' }}>{label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--ui-text)' }}>{value}</div>
                </div>
              ))}
            </div>
            <Sect title="本次命中规则">
              <Space wrap>
                {circlePreview.rules.map((rule: any) => (
                  <Tag key={rule.id} color="blue">
                    {rule.label}
                  </Tag>
                ))}
              </Space>
            </Sect>
            <Sect title="候选顾客（由负责人勾选复核）">
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={circlePreview.candidates}
                locale={{
                  emptyText: (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有符合全部规则的候选顾客" />
                  ),
                }}
                rowSelection={{
                  selectedRowKeys: circleSelected,
                  onChange: keys => setCircleSelected(keys.map(Number)),
                }}
                scroll={{ x: 640 }}
                columns={[
                  { title: '顾客', dataIndex: 'name', width: 130 },
                  {
                    title: '等级',
                    dataIndex: 'grade',
                    width: 70,
                    render: (value: string) => <GradeTag grade={value} />,
                  },
                  { title: '评分', dataIndex: 'score', width: 70, align: 'right' },
                  {
                    title: '阶段',
                    dataIndex: 'stage',
                    width: 90,
                    render: (value: string) => <StageTag stage={value} />,
                  },
                  {
                    title: '可用联系渠道',
                    dataIndex: 'contactChannels',
                    width: 130,
                    render: (value: string[]) => value.join('、') || '-',
                  },
                  { title: '兴趣点', dataIndex: 'interest', ellipsis: true, render: (value: string) => value || '-' },
                ]}
              />
            </Sect>
            <Sect title="排除原因（同一顾客可能命中多项）">
              {circlePreview.exclusions.length ? (
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  {circlePreview.exclusions.map((item: any) => (
                    <div
                      key={item.reason}
                      style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}
                    >
                      <Tag>
                        {item.reason} · {item.count} 人
                      </Tag>
                      <span style={{ fontSize: 12, color: 'var(--ui-text-2)' }}>
                        示例：{item.samples.map((sample: any) => sample.name).join('、') || '-'}
                      </span>
                    </div>
                  ))}
                </Space>
              ) : (
                <span style={{ color: 'var(--ui-text-2)' }}>无排除项</span>
              )}
            </Sect>
          </>
        )}
      </Modal>

      {/* ===== AI 策划案 Modal ===== */}
      <Modal
        open={planOpen}
        onCancel={() => setPlanOpen(false)}
        footer={null}
        width={920}
        styles={{ body: { maxHeight: '74vh', overflowY: 'auto' } }}
        title={
          <>
            <BulbOutlined style={{ color: 'var(--ui-accent)' }} /> AI活动策划案
            {planData?.mode && (
              <Tag color="blue" style={{ marginLeft: 8, fontSize: 11 }}>
                {planData.mode === 'ai'
                  ? 'AI生成'
                  : planData.mode === 'fallback'
                    ? '规则模板'
                    : planData.mode === 'saved'
                      ? '已保存方案'
                      : String(planData.mode)}
              </Tag>
            )}
          </>
        }
      >
        <div
          style={{
            background:
              'linear-gradient(135deg,color-mix(in srgb, var(--ui-accent) 7%, transparent),color-mix(in srgb, var(--chart-3) 7%, transparent))',
            border: '1px solid var(--ui-surface)',
            borderRadius: 10,
            padding: '12px 14px',
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ui-text)' }}>{plan.theme || '活动策划案'}</div>
          <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginTop: 4 }}>
            目标：{planGoal} · 人群：{planAudience} · 预算：{planBudget}
          </div>
        </div>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="策划案可先修改为最终稿，再提交审批。运营总监初审、老板终审通过后，系统才会同步飞书日历并推送给管理层。"
        />
        <Sect title="编辑策划案">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Input
              value={plan.theme || ''}
              onChange={e => updatePlanDraft({ theme: e.target.value })}
              placeholder="活动主题"
            />
            <Table
              size="small"
              rowKey="_i"
              pagination={false}
              dataSource={(plan.flow || []).map((f: any, i: number) => ({ ...f, _i: i }))}
              columns={[
                {
                  title: '时间',
                  dataIndex: 'time',
                  width: 190,
                  render: (v: string, _r: any, i: number) => (
                    <Input size="small" value={v} onChange={e => updateFlow(i, { time: e.target.value })} />
                  ),
                },
                {
                  title: '环节',
                  dataIndex: 'item',
                  render: (v: string, _r: any, i: number) => (
                    <Input size="small" value={v} onChange={e => updateFlow(i, { item: e.target.value })} />
                  ),
                },
                {
                  title: '',
                  width: 46,
                  render: (_: any, __: any, i: number) => (
                    <button
                      type="button"
                      className="ui-link-button"
                      onClick={() =>
                        updatePlanDraft({ flow: (plan.flow || []).filter((_x: any, j: number) => j !== i) })
                      }
                    >
                      删除
                    </button>
                  ),
                },
              ]}
            />
            <Button
              size="small"
              onClick={() => updatePlanDraft({ flow: [...(plan.flow || []), { time: '', item: '' }] })}
            >
              新增流程环节
            </Button>
            <Select
              mode="tags"
              style={{ width: '100%' }}
              value={asList(plan.materials)}
              onChange={v => updatePlanDraft({ materials: v })}
              placeholder="物料清单，回车新增"
            />
            <Input.TextArea
              rows={2}
              value={Array.isArray(plan.invites) ? plan.invites.join('\n') : String(plan.invites || '')}
              onChange={e => updatePlanDraft({ invites: e.target.value })}
              placeholder="邀约安排"
            />
            <Input.TextArea
              rows={4}
              value={listText(plan.sop)}
              onChange={e => updatePlanDraft({ sop: textList(e.target.value) })}
              placeholder="邀约SOP，每行一条"
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
              {['inviteSign', 'signArrive', 'arriveDeal', 'roi'].map(k => (
                <Input
                  key={k}
                  value={plan.kpi?.[k] ?? ''}
                  addonBefore={KEY_ZH[k] || k}
                  onChange={e => updatePlanDraft({ kpi: { ...(plan.kpi || {}), [k]: e.target.value } })}
                />
              ))}
            </div>
            <Input.TextArea
              rows={2}
              value={plan.budgetNote || ''}
              onChange={e => updatePlanDraft({ budgetNote: e.target.value })}
              placeholder="预算建议"
            />
          </div>
        </Sect>
        <Sect title="活动流程">
          <Table
            size="small"
            rowKey="_i"
            pagination={false}
            dataSource={(plan.flow || []).map((f: any, i: number) => ({ ...f, _i: i }))}
            columns={[
              {
                title: '时间',
                dataIndex: 'time',
                width: 110,
                render: (v: string) => (
                  <Tag color="blue" style={{ fontSize: 11 }}>
                    {v}
                  </Tag>
                ),
              },
              { title: '环节', dataIndex: 'item', render: (v: string) => <span style={{ fontSize: 12.5 }}>{v}</span> },
            ]}
          />
        </Sect>
        <Sect title="物料清单">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(plan.materials || []).map((m: any, i: number) => (
              <Tag key={i} color="geekblue" style={{ marginRight: 0 }}>
                {typeof m === 'string' ? m : m?.name || m?.item || JSON.stringify(m)}
              </Tag>
            ))}
            {(plan.materials || []).length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>暂无</span>
            )}
          </div>
        </Sect>
        {plan.invites != null && (
          <Sect title="邀约安排">
            <div style={{ fontSize: 12.5, color: 'var(--ui-text-2)' }}>
              {Array.isArray(plan.invites)
                ? plan.invites.join('、')
                : typeof plan.invites === 'number'
                  ? `建议邀约 ${plan.invites} 人（按基准转化率倒推）`
                  : String(plan.invites)}
            </div>
          </Sect>
        )}
        <Sect title="邀约SOP">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {asList(plan.sop).map((s, i) => (
              <div
                key={i}
                style={{ display: 'flex', gap: 8, fontSize: 12.5, color: 'var(--ui-text-2)', lineHeight: 1.7 }}
              >
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 9,
                    background: 'var(--ui-surface-2)',
                    color: 'var(--ui-accent)',
                    fontSize: 11,
                    fontWeight: 600,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                >
                  {i + 1}
                </span>
                <span>{s}</span>
              </div>
            ))}
            {asList(plan.sop).length === 0 && <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>暂无</span>}
          </div>
        </Sect>
        <Sect title="KPI基准">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
            {Object.entries(plan.kpi || {}).map(([k, v]: any) => (
              <div key={k} style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{KEY_ZH[k] || k}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ui-accent)' }}>
                  {typeof v === 'number' && ['inviteSign', 'signArrive', 'arriveDeal', 'referral'].includes(k)
                    ? `${v}%`
                    : String(v)}
                </div>
              </div>
            ))}
          </div>
        </Sect>
        {plan.budgetNote && (
          <div
            style={{
              background: 'var(--ui-warning-surface)',
              borderRadius: 8,
              padding: '8px 12px',
              fontSize: 12,
              color: '#e0a253',
            }}
          >
            <DollarOutlined /> 预算建议：<span style={{ whiteSpace: 'pre-wrap' }}>{displayText(plan.budgetNote)}</span>
          </div>
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 14,
            paddingTop: 12,
            borderTop: '1px solid var(--ui-border)',
          }}
        >
          <Tag
            color={PLAN_STATUS_COLOR[selected?.plan_status || '未提交'] || 'default'}
            style={{ alignSelf: 'center' }}
          >
            当前：{selected?.plan_status || '未提交'}
          </Tag>
          {canManageActivityAssignments && (
            <Button icon={<TeamOutlined />} loading={assignmentLoading} onClick={openAssignments}>
              工作分配
            </Button>
          )}
          <Button loading={planSaving} onClick={savePlanDraft}>
            保存草稿
          </Button>
          <Button type="primary" loading={planSubmitting} onClick={submitPlanApproval}>
            提交审批
          </Button>
        </div>
      </Modal>

      {/* ===== 活动策划工作分配 Modal ===== */}
      <Modal
        open={assignmentOpen}
        onCancel={() => setAssignmentOpen(false)}
        width={1080}
        title={
          <>
            <TeamOutlined style={{ color: 'var(--ui-primary)' }} /> 工作分配 · {selected?.title || ''}
          </>
        }
        styles={{ body: { maxHeight: '70vh', overflowY: 'auto' } }}
        footer={[
          <Button key="cancel" onClick={() => setAssignmentOpen(false)}>
            关闭
          </Button>,
          <Button
            key="save"
            type="primary"
            icon={<TeamOutlined />}
            loading={assignmentSaving}
            onClick={saveAssignments}
          >
            同步到员工任务
          </Button>,
        ]}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="保存后立即写入员工的组织协同舱"
          description="员工会收到站内任务通知；已绑定个人飞书的员工还会收到单独提醒。相同分工项再次保存只更新原任务，不会重复创建。"
        />
        <Table
          size="small"
          pagination={false}
          rowKey="key"
          dataSource={assignmentRows}
          scroll={{ x: 980 }}
          columns={[
            {
              title: '任务与执行要求',
              dataIndex: 'title',
              width: 330,
              render: (_: any, row: any) => (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <Input
                    size="small"
                    value={row.title}
                    placeholder="任务名称"
                    onChange={e => updateAssignment(row.key, { title: e.target.value })}
                  />
                  <Input.TextArea
                    value={row.detail}
                    autoSize={{ minRows: 2, maxRows: 4 }}
                    placeholder="执行要求与验收标准"
                    onChange={e => updateAssignment(row.key, { detail: e.target.value })}
                  />
                </div>
              ),
            },
            {
              title: '负责人',
              dataIndex: 'assigneeId',
              width: 210,
              render: (_: any, row: any) => {
                const assignee = assignmentUsers.find(user => user.id === row.assigneeId);
                return (
                  <div>
                    <Select
                      size="small"
                      showSearch
                      optionFilterProp="searchText"
                      value={row.assigneeId}
                      placeholder="选择员工"
                      style={{ width: '100%' }}
                      onChange={value => updateAssignment(row.key, { assigneeId: value })}
                      options={assignmentUsers.map(user => ({
                        value: user.id,
                        searchText: `${user.name} ${user.dept || ''}`,
                        label: (
                          <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span>
                              {user.name}
                              {user.dept ? ` · ${user.dept}` : ''}
                            </span>
                            {user.feishuBound && (
                              <Tag color="purple" style={{ margin: 0, fontSize: 10 }}>
                                飞书
                              </Tag>
                            )}
                          </span>
                        ),
                      }))}
                    />
                    {assignee && (
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 10.5,
                          color: assignee.feishuBound ? '#6d5279' : 'var(--ui-muted)',
                        }}
                      >
                        {assignee.feishuBound ? '已绑定飞书，将同步提醒' : '未绑定飞书，仅站内通知'}
                      </div>
                    )}
                  </div>
                );
              },
            },
            {
              title: '截止时间',
              dataIndex: 'dueAt',
              width: 190,
              render: (_: any, row: any) => (
                <DatePicker
                  size="small"
                  showTime={{ format: 'HH:mm' }}
                  format="YYYY-MM-DD HH:mm"
                  value={row.dueAt}
                  onChange={value => updateAssignment(row.key, { dueAt: value })}
                  style={{ width: '100%' }}
                />
              ),
            },
            {
              title: '优先级',
              dataIndex: 'priority',
              width: 90,
              render: (_: any, row: any) => (
                <Select
                  size="small"
                  value={row.priority}
                  style={{ width: '100%' }}
                  options={['低', '中', '高', '紧急'].map(value => ({ value, label: value }))}
                  onChange={value => updateAssignment(row.key, { priority: value })}
                />
              ),
            },
            {
              title: '同步状态',
              dataIndex: 'status',
              width: 100,
              render: (_: any, row: any) =>
                row.taskId ? (
                  <div>
                    <Tag color="green" style={{ margin: 0 }}>
                      {row.status || '已同步'}
                    </Tag>
                    {row.feishuNotified && (
                      <div style={{ fontSize: 10, color: '#6d5279', marginTop: 4 }}>飞书已发送</div>
                    )}
                  </div>
                ) : (
                  <Tag style={{ margin: 0 }}>待同步</Tag>
                ),
            },
            {
              title: '',
              width: 60,
              render: (_: any, row: any) =>
                row.taskId ? (
                  <Tooltip title="已同步任务请到组织协同舱调整或删除">
                    <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>已入档</span>
                  </Tooltip>
                ) : (
                  <Button
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label="移除任务"
                    onClick={() => setAssignmentRows(rows => rows.filter(item => item.key !== row.key))}
                  />
                ),
            },
          ]}
        />
        <Button size="small" icon={<PlusOutlined />} onClick={addAssignment} style={{ marginTop: 10 }}>
          新增分工任务
        </Button>
      </Modal>

      {/* ===== 活动复盘 Modal ===== */}
      <Modal
        open={reviewOpen}
        onCancel={() => setReviewOpen(false)}
        footer={null}
        width={760}
        styles={{ body: { maxHeight: '72vh', overflow: 'auto' } }}
        title={
          <>
            <FileDoneOutlined style={{ color: 'var(--chart-3)' }} /> 活动复盘 · {reviewAct?.title || ''}
          </>
        }
      >
        {!reviewData ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Alert
              type="info"
              showIcon
              message="提交复盘后将自动对比目标达成与基准转化率，活动状态将变更为「已复盘」"
            />
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ui-text)', marginBottom: 6 }}>
                做得好的（每行一条）
              </div>
              <Input.TextArea
                rows={3}
                value={okText}
                onChange={e => setOkText(e.target.value)}
                placeholder={'如：现场试吃动线顺畅\n如：老客带新到场超预期'}
              />
            </div>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ui-text)', marginBottom: 6 }}>
                待改进的（每行一条）
              </div>
              <Input.TextArea
                rows={3}
                value={badText}
                onChange={e => setBadText(e.target.value)}
                placeholder={'如：邀约确认率偏低\n如：现场沟通环节缺少清晰的套餐与服务说明'}
              />
            </div>
            <Button type="primary" block icon={<FileDoneOutlined />} loading={reviewSubmitting} onClick={submitReview}>
              {reviewSubmitting ? '数据复盘员工分析中（约10-25秒）…' : '生成复盘报告（基准对比 + 数据员工深度复盘）'}
            </Button>
          </div>
        ) : (
          <div>
            <div
              style={{
                background: 'var(--ui-surface)',
                border: '1px solid var(--ui-surface)',
                borderRadius: 10,
                padding: 12,
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                  marginBottom: 10,
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, color: 'var(--ui-text)' }}>复盘动作台</div>
                  <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginTop: 2 }}>
                    {rv.kbSync ? `已入库：${rv.kbSync.category}` : '该复盘可一键沉淀到知识库，并同步给管理层'}
                  </div>
                </div>
                <Space wrap size={6}>
                  <Button
                    type="primary"
                    size="small"
                    icon={<SyncOutlined />}
                    loading={reviewSyncing}
                    onClick={syncReviewKb}
                  >
                    {rv.kbSync ? '重新入库并通知' : '入库并通知'}
                  </Button>
                  <Button size="small" icon={<CopyOutlined />} onClick={copyReview}>
                    复制复盘
                  </Button>
                  <Button size="small" icon={<DownloadOutlined />} onClick={exportReview}>
                    导出TXT
                  </Button>
                  <Button
                    size="small"
                    icon={<BookOutlined />}
                    onClick={() => {
                      window.location.href = '/system?tab=kb';
                    }}
                  >
                    知识库
                  </Button>
                  <Button
                    size="small"
                    icon={<CheckSquareOutlined />}
                    onClick={() => {
                      window.location.href = '/system?tab=approvals';
                    }}
                  >
                    审批中心
                  </Button>
                </Space>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                {[
                  ['入库状态', rv.kbSync ? '已沉淀' : '待入库'],
                  ['动作数量', `${reviewActionItems(rv).length} 条`],
                  ['管理同步', rv.kbSync ? '已通知/可重发' : '待通知'],
                ].map(([k, v]) => (
                  <div key={k} style={{ background: 'var(--ui-surface)', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{k}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ui-text)' }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
            {rv.aiText && (
              <Sect
                title={
                  <Space size={6}>
                    <Avatar size={20} src="/avatars/M-07.png" style={{ background: 'var(--ui-surface-2)' }} />
                    {rv.aiMeta?.marshal || '数据复盘员工'} · 深度复盘{' '}
                    {rv.aiMeta?.model && (
                      <Tag color="geekblue" style={{ fontSize: 10 }}>
                        {rv.aiMeta.model}
                      </Tag>
                    )}
                  </Space>
                }
              >
                <div
                  style={{
                    whiteSpace: 'pre-wrap',
                    fontSize: 12.5,
                    lineHeight: 1.85,
                    maxHeight: 260,
                    overflow: 'auto',
                    background: 'var(--ui-surface-2)',
                    border: '1px solid var(--ui-border-strong)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    color: 'var(--ui-text-2)',
                  }}
                >
                  {rv.aiText}
                </div>
              </Sect>
            )}
            {rv.aiMeta?.error && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 10 }}
                message={`数据复盘未生成（${rv.aiMeta.error}），以下为基准规则复盘`}
              />
            )}
            {rv.kbSync && (
              <Alert
                type="success"
                showIcon
                style={{ marginBottom: 10 }}
                message={`已沉淀到知识库：${rv.kbSync.category}`}
                description={rv.kbSync.title}
              />
            )}
            {reviewActionItems(rv).length > 0 && (
              <Sect
                title={
                  <Space size={6}>
                    待推进动作
                    <Tag color="blue" style={{ marginRight: 0 }}>
                      {reviewActionItems(rv).length}
                    </Tag>
                  </Space>
                }
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {reviewActionItems(rv).map((s, i) => (
                    <div
                      key={`${s}-${i}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        background: 'var(--ui-surface-2)',
                        borderRadius: 8,
                        padding: '7px 10px',
                      }}
                    >
                      <Checkbox>
                        <span style={{ fontSize: 12.5, color: 'var(--ui-text-2)' }}>{s}</span>
                      </Checkbox>
                      <Button
                        size="small"
                        type="link"
                        icon={<CopyOutlined />}
                        onClick={() => {
                          navigator.clipboard?.writeText(s);
                          message.success('动作已复制');
                        }}
                      >
                        复制
                      </Button>
                    </div>
                  ))}
                </div>
              </Sect>
            )}
            <Sect title="目标 vs 实际">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8 }}>
                {Object.entries(rv.target_vs_actual || {}).map(([k, v]: any) => (
                  <div key={k} style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{KEY_ZH[k] || k}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ui-text)' }}>{fmtTVA(v)}</div>
                  </div>
                ))}
              </div>
            </Sect>
            <Sect title="转化率 vs 行业基准">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {['inviteSign', 'signArrive', 'arriveDeal', 'roi'].map(k => {
                  const a = rv.rates?.[k];
                  const b = rvBaseline?.[k];
                  const below = typeof a === 'number' && typeof b === 'number' && a < b;
                  const sfx = k === 'roi' ? '' : '%';
                  return (
                    <div
                      key={k}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: 12.5,
                        background: 'var(--ui-surface-2)',
                        borderRadius: 8,
                        padding: '7px 12px',
                      }}
                    >
                      <span style={{ color: 'var(--ui-text-2)' }}>{RATE_LABEL[k]}</span>
                      <span>
                        <b style={{ color: below ? 'var(--danger)' : 'var(--ok)', fontSize: 14 }}>
                          {a ?? '-'}
                          {sfx}
                        </b>
                        <span style={{ color: 'var(--ui-muted)', marginLeft: 8, fontSize: 11.5 }}>
                          基准 {b ?? '-'}
                          {sfx}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </Sect>
            {asList(rv.gaps).length > 0 && (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 14 }}
                message="低于基准的差距项"
                description={
                  <div>
                    {asList(rv.gaps).map((g, i) => (
                      <div key={i} style={{ color: 'var(--danger)', fontSize: 12.5, lineHeight: 1.8 }}>
                        · {g}
                      </div>
                    ))}
                  </div>
                }
              />
            )}
            {asList(rv.improvements).length > 0 && (
              <Sect title="改进项">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {asList(rv.improvements).map((s, i) => (
                    <div
                      key={i}
                      style={{ display: 'flex', gap: 8, fontSize: 12.5, color: 'var(--ui-text-2)', lineHeight: 1.7 }}
                    >
                      <CheckCircleOutlined style={{ color: 'var(--chart-2)', marginTop: 3 }} />
                      <span>{s}</span>
                    </div>
                  ))}
                </div>
              </Sect>
            )}
            {asList(rv.followup).length > 0 && (
              <div
                style={{
                  background: 'var(--ui-surface-2)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  fontSize: 12.5,
                  color: 'var(--ui-text-2)',
                }}
              >
                <div style={{ fontWeight: 600, color: 'var(--ui-text)', marginBottom: 4 }}>
                  <RiseOutlined style={{ color: 'var(--ui-accent)' }} /> 后续跟进
                </div>
                {asList(rv.followup).map((s, i) => (
                  <div key={i} style={{ lineHeight: 1.8 }}>
                    · {s}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

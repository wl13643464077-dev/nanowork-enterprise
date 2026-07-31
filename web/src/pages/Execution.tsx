import { useEffect, useState } from 'react';
import {
  Row,
  Col,
  Table,
  Tag,
  Progress,
  Badge,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  DatePicker,
  Switch,
  Empty,
  Space,
  Tooltip,
  Segmented,
  message,
  Timeline,
  Alert,
  Popconfirm,
} from 'antd';
import {
  AimOutlined,
  CheckCircleOutlined,
  AuditOutlined,
  AlertOutlined,
  StarOutlined,
  ThunderboltOutlined,
  ReloadOutlined,
  SendOutlined,
  PlusOutlined,
  PlayCircleOutlined,
  CheckOutlined,
  CloseOutlined,
  TrophyOutlined,
  FormOutlined,
  TeamOutlined,
  LockOutlined,
  EditOutlined,
  UploadOutlined,
  PaperClipOutlined,
  DeleteOutlined,
  DownloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { api, fmtMoney, fmtWan, getUser } from '../api/client';
import { loadXlsx } from '../utils/xlsx';
import { StatCard, Panel } from '../components/Kit';
import CustomerDrawer from '../components/CustomerDrawer';
import { CHART_COLORS } from '../components/Charts';

const TASK_STATUSES = ['待执行', '进行中', '待审核', '已完成'];
const STATUS_COLOR: Record<string, string> = {
  待执行: 'var(--ui-muted)',
  进行中: 'var(--ui-accent)',
  待审核: '#f6a02d',
  已完成: '#22c4a8',
};
const PRIORITY_COLOR: Record<string, string> = { 高: '#f25b6b', 中: '#f6a02d', 低: '#22c4a8' };
const TYPE_COLOR: Record<string, string> = {
  跟进: 'blue',
  邀约: 'purple',
  内容: 'cyan',
  活动: 'orange',
  培训: 'green',
  督导: 'red',
  回访: 'magenta',
};
const typeColor = (t: string) => TYPE_COLOR[t] || 'geekblue';
const TASK_TYPES = ['跟进', '邀约', '内容', '活动', '培训', '督导', '其他'];
const LEVEL_COLOR: Record<string, string> = { 区域运营商: 'purple', 城市合伙人: 'blue', 馆主: 'cyan' };
const MEDAL = ['#f6a02d', 'var(--ui-muted)', '#cd8a4d'];
const resultColor = (v: string) =>
  (v || '').includes('驳') ? 'red' : /通过|合格|完成/.test(v || '') ? 'green' : 'orange';
const TASK_FILE_ACCEPT = '.doc,.docx,.xls,.xlsx,.csv,.pdf,.txt,.md,.json,.png,.jpg,.jpeg,.webp';
const fallbackTaskBasis = (t: any) => {
  const map: Record<string, any> = {
    内容: {
      shortSource: '战役主题 + 内容标准包',
      source: '来自今日战役主题、目标人群和内容生产仓标准包，不直接来自销售回款额。',
      target: '3条短视频脚本 + 5条朋友圈 + 3条社群话题',
      formula: '主推主题 × 多触点内容包 = 今日可分发素材。',
      evidence: ['用于种草、信任铺垫、合伙人转发和销售邀约前置触达。'],
      rules: ['内容任务看素材是否可用、是否带来线索和邀约反馈。'],
    },
    邀约: {
      shortSource: '月缺口 + 邀约转化率',
      source: '来自月度缺口、客单价、邀约到店率和到店成交率反推。',
      target: `今日邀约触达 ${t?.count ?? '-'} 人`,
      formula: '月缺口 ÷ 客单价 ÷ 剩余天数 → 日均成交单数 → ÷到店成交率 ÷邀约到店率。',
      evidence: ['优先从已沟通、已邀约、已到店和高分客户中筛选。'],
      rules: ['邀约结果必须回写CRM，包含拒绝原因和下次跟进时间。'],
      relatedDrill: 'goals',
    },
    跟进: {
      shortSource: '重点客户池 + 跟进超期',
      source: '来自A类客户、即将成交客户、超期未跟进客户和建议老板介入名单。',
      target: `跟进 ${t?.count ?? '-'} 位重点客户`,
      formula: 'A类/高分/超期/老板介入 → 按评分倒序 → 逐一推进下一步动作。',
      evidence: ['跟进完成后沉淀沟通内容、客户顾虑、AI建议和下次跟进时间。'],
      rules: ['高预算或需政策拍板客户进入老板介入或待确认事项。'],
    },
    培训: {
      shortSource: '合伙人活跃档案 + 每日动作闭环',
      source: '来自合伙人活跃分层、近7天打卡/邀约/到店数据和沉默名单。',
      target: '下发每日任务包，晚间回收打卡',
      formula: '学习卡 + 素材包 + 邀约目标2人/人 + 21:00回收打卡。',
      evidence: ['用于恢复学习、转发、邀约、到店、成交、反馈这条动作链。'],
      rules: ['低活跃/沉睡合伙人要给具体场景、素材和截止时间。'],
    },
  };
  return (
    map[t?.type] || {
      shortSource: '作战计划规则',
      source: '来自今日经营主题、任务优先级和执行检查标准。',
      target: t?.count ? `数量目标 ${t.count}` : '按任务检查标准完成',
      formula: '经营卡点 → 今日动作 → 负责人 → 截止时间 → 检查标准。',
      evidence: ['该任务由今日作战计划生成。'],
      rules: ['执行完成后需要回传数据或记录。'],
    }
  );
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

export default function Execution() {
  const user = getUser() || {};
  const isManager = ['boss', 'ops_director', 'manager', 'admin'].includes(user.role);
  const canApprove = user.role === 'boss' || user.role === 'ops_director';
  const canManagePartners = isManager;
  const canIssuePlan = canApprove;
  const canOperateTask = (t: any) => isManager || Number(t.assignee_id) === Number(user.id);

  const [summary, setSummary] = useState<any>({});
  const [goals, setGoals] = useState<any[]>([]);
  const [plan, setPlan] = useState<any>(null);
  const [tasks, setTasks] = useState<any[]>([]);
  const [planRollup, setPlanRollup] = useState<any>(null);
  const [submissions, setSubmissions] = useState<any[]>([]);
  const [ranking, setRanking] = useState<any[]>([]);
  const [partners, setPartners] = useState<any[]>([]);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [lbPeriod, setLbPeriod] = useState('week');
  const [rankPeriod, setRankPeriod] = useState('week');
  const [silent, setSilent] = useState<any[]>([]);
  const [supportList, setSupportList] = useState<any[]>([]);

  const [taskModal, setTaskModal] = useState(false);
  const [rejectTask, setRejectTask] = useState<any>(null);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [genLoading, setGenLoading] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [confirmPlanLoading, setConfirmPlanLoading] = useState<number | null>(null);
  const [savingTask, setSavingTask] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [savingCheckin, setSavingCheckin] = useState(false);
  const [superviseLoading, setSuperviseLoading] = useState(false);

  // 目标钻取 / 合伙人四档 / 提醒卡 / 合伙人明细（V1.2 表格业务逻辑）
  const [drill, setDrill] = useState<{ open: boolean; data: any }>({ open: false, data: null });
  const [tiers, setTiers] = useState<any>(null);
  const [pDetail, setPDetail] = useState<{ open: boolean; data: any }>({ open: false, data: null });
  const [remindCard, setRemindCard] = useState<any>(null);
  const [remindLoading, setRemindLoading] = useState<number | null>(null);
  const [planTask, setPlanTask] = useState<any>(null);
  const [rollupDetail, setRollupDetail] = useState<any>(null);
  const [execDrill, setExecDrill] = useState<{ open: boolean; kind: string; data: any }>({
    open: false,
    kind: '',
    data: null,
  });
  const [custId, setCustId] = useState<number | null>(null);
  const [workTask, setWorkTask] = useState<any>(null);
  const [workFiles, setWorkFiles] = useState<any[]>([]);
  const [savingWork, setSavingWork] = useState(false);
  // 二层：任务提交时间线
  const [taskTrace, setTaskTrace] = useState<{ open: boolean; task: any; subs: any[]; loading: boolean }>({
    open: false,
    task: null,
    subs: [],
    loading: false,
  });
  const openTaskTrace = (task: any) => {
    setTaskTrace({ open: true, task, subs: [], loading: true });
    api
      .get(`/execution/submissions?taskId=${task.id}`)
      .then(subs => setTaskTrace({ open: true, task, subs: subs || [], loading: false }));
  };
  const submitInlineReview = (taskId: number, pass: boolean, reason?: string) =>
    api.post(`/execution/tasks/${taskId}/review`, { pass, reason }).then(() => {
      message.success(pass ? '已通过' : '已驳回');
      openExecDrill('pending');
      loadAll();
    });
  const reviewInline = (taskId: number, pass: boolean) => {
    if (pass) {
      submitInlineReview(taskId, true);
      return;
    }
    let reason = '';
    Modal.confirm({
      title: '驳回任务',
      okText: '确认驳回',
      cancelText: '取消',
      okButtonProps: { danger: true },
      content: (
        <Input.TextArea
          rows={3}
          maxLength={180}
          showCount
          placeholder="请填写驳回原因，执行人会看到这条反馈"
          onChange={e => {
            reason = e.target.value;
          }}
        />
      ),
      onOk: () => {
        if (!reason.trim()) {
          message.warning('请填写驳回原因');
          return Promise.reject(new Error('reason required'));
        }
        return submitInlineReview(taskId, false, reason.trim());
      },
    });
  };
  const openExecDrill = (kind: string) => {
    setExecDrill({ open: true, kind, data: null });
    api
      .get(`/execution/drill/${kind}`)
      .then(d => setExecDrill({ open: true, kind, data: d }))
      .catch(() => {});
  };
  const openGoalsDrill = () => {
    setDrill({ open: true, data: null });
    api
      .get('/execution/goals-drill')
      .then(d => setDrill({ open: true, data: d }))
      .catch(() => {});
  };
  const openPartnerDetail = (id: number) => {
    if (!canManagePartners) {
      message.warning('合伙人明细仅管理层可查看');
      return;
    }
    setPDetail({ open: true, data: null });
    api
      .get(`/execution/partners/${id}/detail`)
      .then(d => setPDetail({ open: true, data: d }))
      .catch(() => {});
  };
  const sendRemind = (id: number) => {
    if (!canManagePartners) {
      message.warning('提醒卡仅管理层可生成');
      return;
    }
    setRemindLoading(id);
    api
      .post(`/execution/partners/${id}/remind`, {})
      .then(card => {
        setRemindCard(card);
        message.success('提醒已发送给老板与运营总监');
      })
      .finally(() => setRemindLoading(null));
  };

  const [taskForm] = Form.useForm();
  const [workForm] = Form.useForm();
  const [rejectForm] = Form.useForm();
  const [checkinForm] = Form.useForm();

  const loadSummary = () => api.get('/execution/summary').then(setSummary);
  const loadGoals = () => api.get('/execution/goals').then(d => setGoals(d || []));
  const loadPlan = () => api.get('/execution/battle-plan/today').then(setPlan);
  const loadPlanRollup = () =>
    api
      .get('/execution/battle-plan/rollup')
      .then(setPlanRollup)
      .catch(() => {});
  const loadTasks = () => api.get('/execution/tasks').then(d => setTasks(d || []));
  const loadSubmissions = () => api.get('/execution/submissions').then(d => setSubmissions(d || []));
  // 与总裁驾驶舱共用同一套员工综合评分数据，避免两个页面出现两份排名。
  const loadRanking = (p: string = rankPeriod) =>
    api.get(`/execution/ranking?period=${p}`).then(d => setRanking(d || []));
  const loadPartners = () =>
    canManagePartners
      ? api.get('/execution/partners').then(d => setPartners(d || []))
      : Promise.resolve(setPartners([]));
  const loadSilent = () =>
    canManagePartners
      ? api.get('/execution/partners/silent').then(d => setSilent(d || []))
      : Promise.resolve(setSilent([]));
  const loadSupport = () =>
    canManagePartners
      ? api.get('/execution/partners/support-list').then(d => setSupportList(d || []))
      : Promise.resolve(setSupportList([]));
  const loadLeaderboard = (p: string = lbPeriod) =>
    canManagePartners
      ? api.get(`/execution/partners/leaderboard?period=${p}`).then(d => setLeaderboard(d || []))
      : Promise.resolve(setLeaderboard([]));

  const loadAll = () => {
    loadSummary();
    loadGoals();
    loadPlan();
    loadTasks();
    loadSubmissions();
    loadPlanRollup();
    loadRanking();
    loadPartners();
    loadSilent();
    loadSupport();
  };
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      loadSummary();
      loadGoals();
      loadPlan();
      loadTasks();
      loadSubmissions();
      loadPlanRollup();
      if (canManagePartners) {
        api.get('/execution/partners').then(d => setPartners(d || []));
        api.get('/execution/partners/silent').then(d => setSilent(d || []));
        api.get('/execution/partners/support-list').then(d => setSupportList(d || []));
        api
          .get('/execution/partners/tiers')
          .then(setTiers)
          .catch(() => {});
      } else {
        setPartners([]);
        setSilent([]);
        setSupportList([]);
        setTiers({ total: 0, groups: [] });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [canManagePartners]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void api.get(`/execution/ranking?period=${rankPeriod}`).then(d => setRanking(d || []));
    });
    return () => {
      cancelled = true;
    };
  }, [rankPeriod]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (canManagePartners) {
        void api.get(`/execution/partners/leaderboard?period=${lbPeriod}`).then(d => setLeaderboard(d || []));
      } else {
        setLeaderboard([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [lbPeriod, canManagePartners]);

  /* ---------- 作战计划 ---------- */
  const regenPlan = () => {
    setGenLoading(true);
    api
      .post('/execution/battle-plan/generate')
      .then(p => {
        setPlan(p);
        message.success('今日作战计划已重新生成');
      })
      .finally(() => setGenLoading(false));
  };
  const applyPlan = () => {
    Modal.confirm({
      title: '确认管理层下发？',
      okText: '确认下发',
      cancelText: '取消',
      content: `系统会把今日作战计划批量创建到任务看板，执行人将看到对应任务；当前计划共 ${plan?.tasks?.length || 0} 项。`,
      onOk: () => {
        setApplyLoading(true);
        return api
          .post('/execution/battle-plan/apply')
          .then(r => {
            message.success(`已下发 ${r.created} 个任务`);
            loadTasks();
            loadSummary();
          })
          .finally(() => setApplyLoading(false));
      },
    });
  };
  const confirmPlanItem = (index: number) => {
    const item = plan?.tasks?.[index] || {};
    Modal.confirm({
      title: '确认同步这条作战任务？',
      okText: '确认同步',
      cancelText: '取消',
      content: `${item.type || '任务'}：${item.action || '未命名动作'}；负责人：${item.owner || '-'}；截止：${item.due || '-'}`,
      onOk: () => {
        setConfirmPlanLoading(index);
        return api
          .post('/execution/battle-plan/confirm', { index })
          .then(r => {
            message.success(r.created ? '已同步到任务看板「待执行」' : '这条作战任务已在看板中');
            loadPlan();
            loadPlanRollup();
            loadTasks();
            loadSummary();
          })
          .finally(() => setConfirmPlanLoading(null));
      },
    });
  };

  /* ---------- 任务流转 ---------- */
  const startTask = (t: any) =>
    api.put(`/execution/tasks/${t.id}`, { status: '进行中' }).then(() => {
      message.success(`「${t.title}」已开始执行`);
      loadTasks();
      loadSummary();
    });

  const openTaskWork = (t: any) => {
    setWorkTask(t);
    setWorkFiles([]);
    workForm.setFieldsValue({
      title: t.title,
      detail: t.detail || '',
      type: t.type || '跟进',
      priority: t.priority || '中',
      due_at: t.due_at ? dayjs(t.due_at) : null,
      content: '',
    });
  };
  const pickTaskFiles = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = TASK_FILE_ACCEPT;
    inp.multiple = true;
    inp.onchange = () => {
      const files = Array.from(inp.files || []).slice(0, 5);
      if (!files.length) return;
      const readers = files.map(
        file =>
          new Promise<any>((resolve, reject) => {
            if (file.size > 5 * 1024 * 1024) return reject(new Error(`${file.name} 超过5MB`));
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                name: file.name,
                type: file.type,
                size: file.size,
                b64: String(reader.result || '').split(',')[1] || '',
              });
            reader.onerror = () => reject(new Error(`${file.name} 读取失败`));
            reader.readAsDataURL(file);
          }),
      );
      Promise.all(readers)
        .then(list => {
          setWorkFiles(prev => [...prev, ...list].slice(0, 5));
          message.success(`已添加 ${list.length} 个文件`);
        })
        .catch(e => message.error(e.message));
    };
    inp.click();
  };
  const saveTaskWork = (submit = false) =>
    workForm.validateFields().then(async v => {
      if (!workTask) return;
      if (submit && !String(v.content || '').trim() && workFiles.length === 0) {
        message.warning('请填写执行说明，或上传执行数据/附件');
        return;
      }
      setSavingWork(true);
      try {
        await api.put(`/execution/tasks/${workTask.id}`, {
          title: v.title,
          detail: v.detail || '',
          type: v.type,
          priority: v.priority,
          due_at: v.due_at ? v.due_at.format('YYYY-MM-DD HH:mm') : null,
        });
        if (submit) {
          await api.post(`/execution/tasks/${workTask.id}/submit`, {
            content: v.content || '',
            attachments: workFiles,
          });
          message.success('执行数据已上传，任务已提交审核');
          setWorkTask(null);
          setWorkFiles([]);
          workForm.resetFields();
        } else {
          message.success('任务修改已保存');
        }
        loadTasks();
        loadSubmissions();
        loadSummary();
      } finally {
        setSavingWork(false);
      }
    });

  const approveTask = (t: any) =>
    Modal.confirm({
      title: `确认通过任务「${t.title}」？`,
      okText: '确认通过',
      cancelText: '取消',
      content: '通过后任务会进入已完成状态，并计入执行统计与员工荣誉评分。',
      onOk: () =>
        api.post(`/execution/tasks/${t.id}/review`, { pass: true }).then(() => {
          message.success(`「${t.title}」已通过审核`);
          loadTasks();
          loadSubmissions();
          loadSummary();
        }),
    });

  const doReject = () =>
    rejectForm.validateFields().then(v => {
      setRejecting(true);
      api
        .post(`/execution/tasks/${rejectTask.id}/review`, { pass: false, reason: v.reason })
        .then(() => {
          message.success('已驳回，任务退回执行人');
          setRejectTask(null);
          rejectForm.resetFields();
          loadTasks();
          loadSubmissions();
          loadSummary();
        })
        .finally(() => setRejecting(false));
    });

  const createTask = () =>
    taskForm.validateFields().then(v => {
      setSavingTask(true);
      api
        .post('/execution/tasks', {
          title: v.title,
          detail: v.detail || '',
          type: v.type,
          priority: v.priority,
          due_at: v.due_at.format('YYYY-MM-DD HH:mm'),
        })
        .then(() => {
          message.success('任务已创建');
          setTaskModal(false);
          taskForm.resetFields();
          loadTasks();
          loadSummary();
        })
        .finally(() => setSavingTask(false));
    });
  const deleteTask = (t: any) => {
    api
      .del(`/execution/tasks/${t.id}`)
      .then(() => {
        message.success('任务已删除并进入回收站');
        if (taskTrace.task?.id === t.id) setTaskTrace({ open: false, task: null, subs: [], loading: false });
        loadTasks();
        loadSubmissions();
        loadSummary();
        loadPlanRollup();
      })
      .catch(() => {});
  };

  /* ---------- 合伙人 ---------- */
  const genSupervise = () => {
    if (!canManagePartners) {
      message.warning('沉默合伙人督导任务仅管理层可生成');
      return;
    }
    if (!silent.length) {
      message.info('当前没有沉默合伙人');
      return;
    }
    setSuperviseLoading(true);
    api
      .post('/execution/tasks', {
        title: `督导激活沉默合伙人（共${silent.length}人）`,
        detail:
          '请逐一电话回访并激活：' + silent.map(s => `${s.name}（${s.level}，最后活跃 ${s.last_active}）`).join('；'),
        type: '督导',
        priority: '高',
        due_at: dayjs().add(1, 'day').format('YYYY-MM-DD 18:00'),
      })
      .then(() => {
        message.success('督导任务已生成，可在任务看板查看');
        loadTasks();
        loadSummary();
      })
      .finally(() => setSuperviseLoading(false));
  };

  const doCheckin = () =>
    checkinForm.validateFields().then(v => {
      if (!canManagePartners) {
        message.warning('合伙人打卡仅管理层可录入');
        return;
      }
      setSavingCheckin(true);
      api
        .post('/execution/partner-actions', {
          partner_id: v.partner_id,
          date: v.date.format('YYYY-MM-DD'),
          studied: !!v.studied,
          posted_moments: v.posted_moments || 0,
          posted_videos: v.posted_videos || 0,
          invited: !!v.invited,
          invite_count: v.invite_count || 0,
          intent_count: v.intent_count || 0,
          arrive_count: v.arrive_count || 0,
          deal_count: v.deal_count || 0,
          problem: v.problem || '',
        })
        .then(r => {
          message.success(`打卡成功，当日积分 ${r.score}`);
          setCheckinOpen(false);
          checkinForm.resetFields();
          loadLeaderboard();
          loadPartners();
          loadSilent();
          loadSupport();
        })
        .finally(() => setSavingCheckin(false));
    });

  // 导出任务看板全部任务（本页数据量最大、最有沉淀价值的一张表）
  const [exportingTasks, setExportingTasks] = useState(false);
  const exportTasks = async () => {
    if (!tasks.length) {
      message.warning('暂无可导出的任务');
      return;
    }
    setExportingTasks(true);
    try {
      const XLSX = await loadXlsx();
      const sheetRows = tasks.map((t: any) => ({
        任务名: t.title || '',
        类型: t.type || '',
        状态: t.status || '',
        优先级: t.priority || '',
        负责人: t.assignee || '未分配',
        截止时间: t.due_at || '',
        来源: t.source || '',
        风险: t.risk ? '是' : '否',
        创建时间: t.created_at || '',
        完成时间: t.done_at || '',
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows), '任务清单');
      XLSX.writeFile(wb, `任务清单-${dayjs().format('YYYY-MM-DD')}.xlsx`);
      message.success(`已导出 ${tasks.length} 项任务`);
    } catch {
      message.error('任务清单导出失败，请稍后重试');
    } finally {
      setExportingTasks(false);
    }
  };

  const yest = plan?.yesterday || {};
  const activeToday = partners.filter(p => p.active_today).length;
  const renderPlanRollupCard = (key: 'yesterday' | 'week' | 'month', title: string, color: string) => {
    const d = planRollup?.[key];
    if (!d) return null;
    const status = d.byStatus || {};
    return (
      <Col xs={24} md={8} key={key}>
        <button
          type="button"
          onClick={() => setRollupDetail({ key, title, color, data: d })}
          style={{
            ...buttonResetStyle,
            border: '1px solid var(--ui-surface)',
            borderRadius: 8,
            padding: '10px 12px',
            background: 'var(--ui-surface)',
            height: '100%',
            cursor: 'pointer',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <b style={{ color: 'var(--ui-text)', fontSize: 13 }}>{title}</b>
            <span style={{ color, fontWeight: 700 }}>{d.doneRate || 0}%</span>
          </div>
          <Progress percent={Math.min(d.doneRate || 0, 100)} showInfo={false} size="small" strokeColor={color} />
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              marginTop: 8,
              fontSize: 11.5,
              color: 'var(--ui-text-2)',
            }}
          >
            <span>总 {d.total || 0}</span>
            <span>待 {status['待执行'] || 0}</span>
            <span>进行 {status['进行中'] || 0}</span>
            <span>待审 {status['待审核'] || 0}</span>
            <span>完成 {status['已完成'] || 0}</span>
          </div>
          <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--ui-muted)' }}>
            提交 {d.submitted || 0} 次{isManager ? ` · 覆盖 ${d.people || 0} 人` : ''} · 查看记录
          </div>
        </button>
      </Col>
    );
  };

  const parseSubmitContent = (content: string) => {
    try {
      const o = JSON.parse(content || '{}');
      if (o && o.kind === 'task_submit_v2') return o;
    } catch {
      /* plain text */
    }
    return { note: content || '', attachments: [] };
  };

  /* ---------- 看板任务卡 ---------- */
  const taskCard = (t: any) => {
    const operable = canOperateTask(t);
    const lockedTip = operable ? '' : '只能操作本人负责的任务；管理层可操作全员任务';
    return (
      <div
        key={t.id}
        style={{
          background: 'var(--ui-surface)',
          border: '1px solid var(--ui-border)',
          borderRadius: 8,
          padding: '10px 12px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'flex-start' }}>
          <Tooltip title={t.detail}>
            <span style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--ui-text)', lineHeight: 1.5 }}>{t.title}</span>
          </Tooltip>
          <Tooltip title={`优先级：${t.priority}`}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: PRIORITY_COLOR[t.priority] || 'var(--ui-muted)',
                flexShrink: 0,
                marginTop: 5,
              }}
            />
          </Tooltip>
        </div>
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 0, flexWrap: 'wrap' }}>
          <Tag color={typeColor(t.type)} style={{ fontSize: 11, lineHeight: '18px' }}>
            {t.type}
          </Tag>
          {t.source && (
            <Tag color={t.source === '活动策划' ? 'purple' : 'default'} style={{ fontSize: 11, lineHeight: '18px' }}>
              {t.source}
            </Tag>
          )}
          {t.risk && (
            <Tag color="red" style={{ fontSize: 11, lineHeight: '18px' }}>
              风险
            </Tag>
          )}
          {!operable && (
            <Tag icon={<LockOutlined />} color="default" style={{ fontSize: 11, lineHeight: '18px' }}>
              只读
            </Tag>
          )}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--ui-muted)',
            marginTop: 6,
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span>{t.assignee || '未分配'}</span>
          <span>截止 {(t.due_at || '').slice(5, 16)}</span>
        </div>
        <Button
          size="small"
          block
          icon={<PaperClipOutlined />}
          style={{ marginTop: 8 }}
          onClick={() => openTaskTrace(t)}
        >
          查看执行记录
        </Button>
        {t.status === '待执行' && (
          <Tooltip title={lockedTip}>
            <Button
              size="small"
              type="primary"
              ghost
              block
              icon={<PlayCircleOutlined />}
              style={{ marginTop: 8 }}
              disabled={!operable}
              onClick={() => startTask(t)}
            >
              开始
            </Button>
          </Tooltip>
        )}
        {t.status === '进行中' && (
          <Tooltip title={lockedTip}>
            <Button
              size="small"
              type="primary"
              block
              icon={<EditOutlined />}
              style={{ marginTop: 8 }}
              disabled={!operable}
              onClick={() => openTaskWork(t)}
            >
              编辑/上传数据
            </Button>
          </Tooltip>
        )}
        {t.status === '待审核' &&
          (canApprove ? (
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                style={{ flex: 1 }}
                onClick={() => approveTask(t)}
              >
                通过
              </Button>
              <Button size="small" danger icon={<CloseOutlined />} style={{ flex: 1 }} onClick={() => setRejectTask(t)}>
                驳回
              </Button>
            </div>
          ) : (
            <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--ui-muted)', textAlign: 'center' }}>
              等待总监/老板审核
            </div>
          ))}
        <Popconfirm
          title={`删除任务「${t.title}」？`}
          description="删除后进入回收站，老板/管理员可恢复。"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => deleteTask(t)}
        >
          <Button size="small" danger ghost block icon={<DeleteOutlined />} style={{ marginTop: 8 }}>
            删除任务
          </Button>
        </Popconfirm>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 顶部 KPI（逐卡可点钻取） */}
      <Row gutter={[12, 12]}>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<AimOutlined />}
            color="var(--ui-accent)"
            label="本月目标完成率"
            value={summary.goalRate == null ? (summary.goalStatus === 'zero' ? '目标为0' : '未设置') : summary.goalRate}
            suffix={summary.goalRate == null ? '' : '%'}
            onClick={openGoalsDrill}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<CheckCircleOutlined />}
            color="#22c4a8"
            label="本周任务完成率"
            value={`${summary.weekTaskRate ?? '-'}%`}
            onClick={() => openExecDrill('week-tasks')}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<AuditOutlined />}
            color="#8a7450"
            label="待审任务"
            value={summary.pendingReview ?? '-'}
            suffix="个"
            onClick={() => openExecDrill('pending')}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<AlertOutlined />}
            color="#f25b6b"
            label="风险任务"
            value={summary.riskTasks ?? '-'}
            suffix="个"
            onClick={() => openExecDrill('risk')}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<StarOutlined />}
            color="#f6a02d"
            label="重点跟进"
            value={summary.keyFollows ?? '-'}
            suffix="人"
            onClick={() => openExecDrill('key-follows')}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<ThunderboltOutlined />}
            color="#70757a"
            label="执行力评分"
            value={summary.execScore ?? '-'}
            suffix="分"
            onClick={() => openExecDrill('exec-score')}
          />
        </Col>
      </Row>

      {/* 第二行：目标拆解 + 今日作战计划 */}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={8}>
          <Panel
            title="目标拆解"
            extra={
              <Space size={6}>
                <button type="button" className="ui-link-button" style={{ fontSize: 12 }} onClick={openGoalsDrill}>
                  三层拆解 ›
                </button>
              </Space>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {goals.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无目标数据" />}
              {goals.map((g, i) => (
                <button
                  type="button"
                  key={g.label}
                  onClick={openGoalsDrill}
                  style={{
                    ...buttonResetStyle,
                    background: 'var(--ui-surface-2)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 13, color: 'var(--ui-text)' }}>
                      <Badge color={CHART_COLORS[i % CHART_COLORS.length]} />
                      <b style={{ margin: '0 6px 0 4px' }}>{g.label}目标</b>
                      <span style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}>{g.period}</span>
                    </span>
                    <span>
                      {g.rate == null ? (
                        <Tag style={{ margin: 0 }}>{g.status === 'zero' ? '目标为0' : '未设置'}</Tag>
                      ) : (
                        <>
                          {g.risk && (
                            <Tag color="red" style={{ fontSize: 11 }}>
                              风险
                            </Tag>
                          )}
                          <b style={{ color: g.risk ? '#f25b6b' : 'var(--ui-accent)', fontSize: 14 }}>{g.rate}%</b>
                        </>
                      )}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ui-text-2)', margin: '6px 0 2px' }}>
                    目标 {g.status === 'missing' ? '未设置' : fmtWan(g.target)} · 实际{' '}
                    <b style={{ color: 'var(--ui-text)' }}>{fmtWan(g.actual)}</b>
                  </div>
                  {g.rate == null ? (
                    <div style={{ color: 'var(--ui-muted)', fontSize: 11.5, lineHeight: 1.6 }}>{g.statusText}</div>
                  ) : (
                    <Progress
                      percent={Math.min(g.rate, 100)}
                      showInfo={false}
                      size="small"
                      strokeColor={g.risk ? '#f25b6b' : 'var(--ui-accent)'}
                    />
                  )}
                </button>
              ))}
            </div>
          </Panel>
        </Col>
        <Col xs={24} lg={16}>
          <Panel
            title={
              <>
                <ThunderboltOutlined style={{ color: 'var(--ui-accent)' }} /> 今日作战计划
                {plan?.festival && (
                  <Tag color="orange" style={{ marginLeft: 8, fontSize: 11 }}>
                    {plan.festival.name}·{plan.festival.theme}
                  </Tag>
                )}
              </>
            }
            extra={
              <Space>
                <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{plan?.date}</span>
                {isManager && (
                  <Button size="small" icon={<ReloadOutlined />} loading={genLoading} onClick={regenPlan}>
                    重新生成
                  </Button>
                )}
                {canIssuePlan && (
                  <Button size="small" icon={<SendOutlined />} loading={applyLoading} onClick={applyPlan}>
                    管理层下发
                  </Button>
                )}
                <Tag color={plan?.confirmation?.confirmed ? 'green' : 'blue'} style={{ margin: 0 }}>
                  {plan?.confirmation?.confirmed ? `今日已同步${plan?.confirmation?.synced || 0}项` : '逐条确认同步'}
                </Tag>
              </Space>
            }
          >
            {!plan ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="作战计划生成中..." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--ui-text)' }}>{plan.theme}</span>
                  <Tag color="blue" style={{ fontSize: 11 }}>
                    主推人群：{plan.audience}
                  </Tag>
                  {plan.bottleneck && (
                    <Tag color="red" style={{ fontSize: 11 }}>
                      <AlertOutlined /> 卡点：{plan.bottleneck}
                    </Tag>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ui-muted)' }}>
                  昨日战果：新增线索 {yest.newLeads ?? 0} · 邀约 {yest.invited ?? 0} · 到店 {yest.arrived ?? 0} · 成交{' '}
                  {yest.deals ?? 0} 单 · 回款 {fmtMoney(yest.amount)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 252, overflow: 'auto' }}>
                  {(plan.tasks || []).map((t: any, i: number) => {
                    const itemState = (plan.confirmation?.items || []).find((x: any) => x.index === i);
                    const confirmed = !!itemState?.confirmed;
                    return (
                      <div
                        role="button"
                        tabIndex={0}
                        key={i}
                        onClick={e => {
                          if ((e.target as HTMLElement).closest('[data-plan-task-action]')) return;
                          setPlanTask(t);
                        }}
                        onKeyDown={e => {
                          if (
                            (e.target as HTMLElement).closest('[data-plan-task-action]') ||
                            (e.key !== 'Enter' && e.key !== ' ')
                          )
                            return;
                          e.preventDefault();
                          setPlanTask(t);
                        }}
                        style={{
                          display: 'flex',
                          gap: 8,
                          padding: '8px 10px',
                          background: 'var(--ui-surface-2)',
                          borderRadius: 8,
                          alignItems: 'flex-start',
                          cursor: 'pointer',
                        }}
                      >
                        <Tag color={typeColor(t.type)} style={{ flexShrink: 0, marginTop: 1 }}>
                          {t.type}
                        </Tag>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ui-text)' }}>
                            {t.action}
                            {t.count ? <span style={{ color: 'var(--ui-accent)' }}> ×{t.count}</span> : null}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', marginTop: 2 }}>
                            负责人：{t.owner} · 截止 {t.due} · 检查标准：{t.check}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--ui-text-2)', marginTop: 3 }}>
                            目标来源：{t.basis?.shortSource || fallbackTaskBasis(t).shortSource}
                          </div>
                        </div>
                        <div
                          data-plan-task-action
                          style={{ flexShrink: 0, display: 'flex', alignItems: 'center', minHeight: 28 }}
                        >
                          {confirmed ? (
                            <Tag color="green" style={{ margin: 0 }}>
                              已同步
                            </Tag>
                          ) : (
                            <Button
                              size="small"
                              type="primary"
                              ghost
                              icon={<CheckOutlined />}
                              loading={confirmPlanLoading === i}
                              onClick={() => confirmPlanItem(i)}
                            >
                              确认同步
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {plan.bossItems?.length > 0 && (
                  <div
                    style={{
                      background: 'var(--ui-warning-surface)',
                      borderRadius: 8,
                      padding: '8px 10px',
                      fontSize: 12,
                      color: '#e0a253',
                    }}
                  >
                    <b>待老板确认：</b>
                    {plan.bossItems.map((x: string, i: number) => (
                      <div key={i}>· {x}</div>
                    ))}
                  </div>
                )}
                {planRollup && (
                  <div style={{ background: 'var(--ui-surface-2)', borderRadius: 10, padding: 10 }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 8,
                      }}
                    >
                      <b style={{ fontSize: 13, color: 'var(--ui-text)' }}>作战计划闭环</b>
                      <span style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}>{planRollup.scope}</span>
                    </div>
                    <Row gutter={[8, 8]}>
                      {renderPlanRollupCard('yesterday', '昨日复盘', '#8a7450')}
                      {renderPlanRollupCard('week', '本周情况', 'var(--ui-accent)')}
                      {renderPlanRollupCard('month', '本月情况', '#22c4a8')}
                    </Row>
                  </div>
                )}
              </div>
            )}
          </Panel>
        </Col>
      </Row>

      {/* 第三行：任务看板 */}
      <Panel
        title="任务看板"
        extra={
          <Space size={6}>
            <Button size="small" icon={<DownloadOutlined />} loading={exportingTasks} onClick={exportTasks}>
              导出 Excel
            </Button>
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setTaskModal(true)}>
              新建任务
            </Button>
          </Space>
        }
      >
        <Row gutter={[12, 12]}>
          {TASK_STATUSES.map(s => {
            const list = tasks.filter(t => t.status === s);
            return (
              <Col xs={24} md={12} xl={6} key={s}>
                <div style={{ background: 'var(--ui-surface-2)', borderRadius: 10, padding: 10, height: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[s] }} />
                    <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ui-text)' }}>{s}</span>
                    <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{list.length}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 380, overflow: 'auto' }}>
                    {list.length === 0 ? (
                      <div style={{ textAlign: 'center', color: '#c1c9d4', fontSize: 12, padding: '20px 0' }}>
                        暂无任务
                      </div>
                    ) : (
                      list.map(taskCard)
                    )}
                  </div>
                </div>
              </Col>
            );
          })}
        </Row>
      </Panel>

      {canManagePartners ? (
        <>
          {/* 合伙人活跃四档（DASH-04 客户口径：本周检查项 → 高/中/低活跃/沉睡 + 激活策略） */}
          <Panel
            title={
              <>
                <TeamOutlined style={{ color: '#8a7450' }} /> 合伙人活跃四档（本周检查项自动分类）
              </>
            }
            extra={
              <Space size={6}>
                {tiers && (
                  <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>共 {tiers.total} 位 · 点成员看明细</span>
                )}
              </Space>
            }
          >
            {!tiers ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="分类计算中…" />
            ) : (
              <Row gutter={[12, 12]}>
                {tiers.groups.map((g: any) => (
                  <Col xs={24} md={12} xl={6} key={g.tier}>
                    <div
                      style={{
                        border: '1px solid var(--ui-border)',
                        borderRadius: 10,
                        height: '100%',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          padding: '8px 12px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          background: {
                            green: '#112018',
                            blue: 'var(--ui-surface)',
                            orange: 'var(--ui-warning-surface)',
                            red: 'var(--ui-surface)',
                          }[g.color as string],
                        }}
                      >
                        <b
                          style={{
                            fontSize: 13,
                            color: { green: '#16a34a', blue: 'var(--ui-accent)', orange: '#d97706', red: '#dc2626' }[
                              g.color as string
                            ],
                          }}
                        >
                          {g.tier}
                        </b>
                        <Tag color={g.color} style={{ margin: 0 }}>
                          {g.members.length} 人
                        </Tag>
                      </div>
                      <div style={{ padding: '8px 12px' }}>
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--ui-muted)',
                            lineHeight: 1.7,
                            marginBottom: 8,
                            minHeight: 56,
                          }}
                        >
                          {g.strategy}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 84, overflow: 'auto' }}>
                          {g.members.length === 0 && (
                            <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>暂无</span>
                          )}
                          {g.members.map((m: any) => (
                            <Tag
                              key={m.id}
                              style={{ cursor: 'pointer', margin: 0 }}
                              onClick={() => openPartnerDetail(m.id)}
                            >
                              {m.name} {m.hit}/7
                            </Tag>
                          ))}
                        </div>
                      </div>
                    </div>
                  </Col>
                ))}
              </Row>
            )}
          </Panel>

          {/* 第四行：合伙人体系 */}
          <Row gutter={[12, 12]}>
            <Col xs={24} lg={10}>
              <Panel
                title={
                  <>
                    <TrophyOutlined style={{ color: '#f6a02d' }} /> 合伙人排行榜
                  </>
                }
                extra={
                  <Segmented
                    size="small"
                    value={lbPeriod}
                    onChange={v => setLbPeriod(v as string)}
                    options={[
                      { label: '本周', value: 'week' },
                      { label: '本月', value: 'month' },
                    ]}
                  />
                }
              >
                <Table
                  size="small"
                  rowKey="id"
                  pagination={false}
                  dataSource={leaderboard.slice(0, 8)}
                  onRow={(r: any) => ({ onClick: () => openPartnerDetail(r.id), style: { cursor: 'pointer' } })}
                  columns={[
                    {
                      title: '排名',
                      width: 52,
                      align: 'center',
                      render: (_: any, __: any, i: number) =>
                        i < 3 ? (
                          <span
                            style={{
                              display: 'inline-flex',
                              width: 20,
                              height: 20,
                              borderRadius: '50%',
                              background: MEDAL[i],
                              color: '#fff',
                              fontSize: 11,
                              fontWeight: 700,
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            {i + 1}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--ui-muted)', fontWeight: 600 }}>{i + 1}</span>
                        ),
                    },
                    {
                      title: '姓名',
                      dataIndex: 'name',
                      render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span>,
                    },
                    {
                      title: '层级',
                      dataIndex: 'level',
                      render: (v: string) => (
                        <Tag color={LEVEL_COLOR[v] || 'default'} style={{ fontSize: 11 }}>
                          {v}
                        </Tag>
                      ),
                    },
                    { title: '区域', dataIndex: 'region', width: 64 },
                    {
                      title: '积分',
                      dataIndex: 'total',
                      align: 'right',
                      render: (v: number) => <b style={{ color: 'var(--ui-accent)' }}>{v}</b>,
                    },
                    { title: '邀约', dataIndex: 'invites', align: 'right', width: 48 },
                    { title: '到店', dataIndex: 'arrives', align: 'right', width: 48 },
                    {
                      title: '成交',
                      dataIndex: 'deals',
                      align: 'right',
                      width: 48,
                      render: (v: number) => <b style={{ color: v > 0 ? '#f25b6b' : 'var(--ui-text-2)' }}>{v}</b>,
                    },
                  ]}
                />
              </Panel>
            </Col>
            <Col xs={24} lg={8}>
              <Panel
                title="沉默合伙人名单"
                extra={
                  <Button
                    size="small"
                    danger
                    ghost
                    icon={<AlertOutlined />}
                    loading={superviseLoading}
                    onClick={genSupervise}
                  >
                    生成督导任务
                  </Button>
                }
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflow: 'auto' }}>
                  {silent.length === 0 && (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有沉默合伙人，状态良好" />
                  )}
                  {silent.map(s => (
                    <div
                      key={s.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background: 'var(--ui-surface-2)',
                        borderRadius: 8,
                        padding: '8px 12px',
                      }}
                    >
                      <span>
                        <b style={{ fontSize: 12.5, color: 'var(--ui-text)' }}>{s.name}</b>
                        <Tag color={LEVEL_COLOR[s.level] || 'default'} style={{ fontSize: 11, marginLeft: 6 }}>
                          {s.level}
                        </Tag>
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 11.5, color: '#f25b6b' }}>最后活跃 {s.last_active || '无记录'}</span>
                        <Button
                          size="small"
                          type="primary"
                          ghost
                          loading={remindLoading === s.id}
                          onClick={() => sendRemind(s.id)}
                        >
                          提醒卡
                        </Button>
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>
            </Col>
            <Col xs={24} lg={6}>
              <Panel title="总部支持清单">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflow: 'auto' }}>
                  {supportList.length === 0 && (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待支持问题" />
                  )}
                  {supportList.map((s, i) => (
                    <div
                      key={i}
                      style={{
                        borderBottom: i === supportList.length - 1 ? 'none' : '1px solid var(--ui-border)',
                        paddingBottom: 8,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <b style={{ fontSize: 12.5, color: 'var(--ui-text)' }}>{s.name}</b>
                        <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{s.date}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginTop: 2, lineHeight: 1.6 }}>
                        {s.problem}
                      </div>
                    </div>
                  ))}
                </div>
              </Panel>
            </Col>
          </Row>
        </>
      ) : (
        <Panel
          title={
            <>
              <LockOutlined style={{ color: 'var(--ui-muted)' }} /> 合伙人经营数据权限
            </>
          }
        >
          <Alert
            showIcon
            type="info"
            message="该模块仅管理层可见。"
            description="员工账号只展示本人任务、本人提交记录和本人负责客户。"
          />
        </Panel>
      )}

      {/* 底部：提交记录 + 执行排名 + 快捷操作 */}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={10}>
          <Panel title="员工提交记录">
            <Table
              size="small"
              rowKey="id"
              dataSource={submissions}
              pagination={{ pageSize: 5, size: 'small', showTotal: t => `共 ${t} 条` }}
              columns={[
                { title: '任务', dataIndex: 'task_title', ellipsis: true },
                { title: '提交人', dataIndex: 'user_name', width: 72 },
                {
                  title: '内容',
                  dataIndex: 'content',
                  ellipsis: true,
                  render: (v: string) => (
                    <Tooltip title={v}>
                      <span style={{ color: 'var(--ui-text-2)' }}>{v}</span>
                    </Tooltip>
                  ),
                },
                {
                  title: '结果',
                  dataIndex: 'result',
                  width: 76,
                  render: (v: string) => (
                    <Tag color={resultColor(v)} style={{ fontSize: 11 }}>
                      {v}
                    </Tag>
                  ),
                },
                {
                  title: '时间',
                  dataIndex: 'created_at',
                  width: 96,
                  render: (v: string) => (
                    <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{(v || '').slice(5, 16)}</span>
                  ),
                },
              ]}
            />
          </Panel>
        </Col>
        <Col xs={24} lg={8}>
          <Panel
            title="员工任务竞赛榜"
            extra={
              <Segmented
                size="small"
                value={rankPeriod}
                onChange={v => setRankPeriod(v as string)}
                options={[
                  { label: '本周', value: 'week' },
                  { label: '本月', value: 'month' },
                  { label: '本季度', value: 'quarter' },
                ]}
              />
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {ranking.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无排名数据" />}
              {ranking.map((r, i) => (
                <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 18,
                      textAlign: 'center',
                      fontWeight: 700,
                      fontSize: 12,
                      color: i < 3 ? MEDAL[i] : 'var(--ui-muted)',
                    }}
                  >
                    {i + 1}
                  </span>
                  <span
                    style={{
                      width: 64,
                      fontSize: 12.5,
                      color: 'var(--ui-text)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {r.name}
                  </span>
                  <Progress
                    percent={Math.min(100, Number(r.rate || 0))}
                    size="small"
                    style={{ flex: 1, margin: 0 }}
                    strokeColor={CHART_COLORS[i % CHART_COLORS.length]}
                  />
                  <Tooltip title={`完成 ${r.done || 0} / ${r.total || 0} 项任务，完成率 ${r.rate || 0}%`}>
                    <span style={{ fontSize: 11.5, color: 'var(--ui-muted)', width: 52, textAlign: 'right' }}>
                      {r.done || 0}/{r.total || 0}
                    </span>
                  </Tooltip>
                </div>
              ))}
            </div>
          </Panel>
        </Col>
        <Col xs={24} lg={6}>
          <Panel title="快捷操作">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Tooltip title={!canManagePartners ? '合伙人打卡仅管理层可录入' : ''}>
                <Button
                  type="primary"
                  block
                  icon={<FormOutlined />}
                  disabled={!canManagePartners}
                  onClick={() => setCheckinOpen(true)}
                >
                  合伙人打卡录入
                </Button>
              </Tooltip>
              <Button block icon={<PlusOutlined />} onClick={() => setTaskModal(true)}>
                新建任务
              </Button>
              <Button
                block
                icon={<ReloadOutlined />}
                onClick={() => {
                  loadAll();
                  loadLeaderboard();
                  message.success('数据已刷新');
                }}
              >
                刷新数据
              </Button>
              {canManagePartners ? (
                <div
                  style={{
                    background: 'var(--ui-surface-2)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    fontSize: 12,
                    color: 'var(--ui-text-2)',
                  }}
                >
                  <TeamOutlined style={{ color: 'var(--ui-accent)' }} /> 今日已打卡合伙人{' '}
                  <b style={{ color: 'var(--ui-accent)' }}>{activeToday}</b> / {partners.length} 人
                </div>
              ) : (
                <div
                  style={{
                    background: 'var(--ui-surface-2)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    fontSize: 12,
                    color: 'var(--ui-text-2)',
                  }}
                >
                  <LockOutlined style={{ color: 'var(--ui-muted)' }} /> 合伙人数据由管理层账号统一维护
                </div>
              )}
            </div>
          </Panel>
        </Col>
      </Row>

      {/* 新建任务 Modal */}
      <Modal
        title="新建任务"
        open={taskModal}
        onOk={createTask}
        confirmLoading={savingTask}
        okText="创建"
        onCancel={() => {
          setTaskModal(false);
          taskForm.resetFields();
        }}
      >
        <Form form={taskForm} layout="vertical" initialValues={{ type: '跟进', priority: '中' }}>
          <Form.Item name="title" label="任务标题" rules={[{ required: true, message: '请输入任务标题' }]}>
            <Input placeholder="如：邀约A级客户参加周五主题试吃" maxLength={60} />
          </Form.Item>
          <Form.Item name="detail" label="任务说明">
            <Input.TextArea rows={3} placeholder="补充执行要求、检查标准等" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="type" label="类型" rules={[{ required: true }]}>
                <Select options={TASK_TYPES.map(t => ({ value: t, label: t }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="priority" label="优先级" rules={[{ required: true }]}>
                <Select options={['高', '中', '低'].map(p => ({ value: p, label: p }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="due_at" label="截止时间" rules={[{ required: true, message: '请选择截止时间' }]}>
                <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title={`编辑执行任务：${workTask?.title || ''}`}
        open={!!workTask}
        width={640}
        confirmLoading={savingWork}
        onCancel={() => {
          setWorkTask(null);
          setWorkFiles([]);
          workForm.resetFields();
        }}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              setWorkTask(null);
              setWorkFiles([]);
              workForm.resetFields();
            }}
          >
            取消
          </Button>,
          <Button key="save" loading={savingWork} onClick={() => saveTaskWork(false)}>
            保存修改
          </Button>,
          <Button
            key="submit"
            type="primary"
            loading={savingWork}
            icon={<CheckOutlined />}
            onClick={() => saveTaskWork(true)}
          >
            提交审核
          </Button>,
        ]}
      >
        <Form form={workForm} layout="vertical">
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="进行中的任务可以先编辑要求、补充执行说明，也可以上传表格、文档、图片等执行资料后提交审核。"
          />
          <Form.Item name="title" label="任务标题" rules={[{ required: true, message: '请输入任务标题' }]}>
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name="detail" label="任务要求">
            <Input.TextArea rows={3} placeholder="补充执行要求、数据口径、上传材料说明等" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="type" label="类型" rules={[{ required: true }]}>
                <Select options={TASK_TYPES.map(t => ({ value: t, label: t }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="priority" label="优先级" rules={[{ required: true }]}>
                <Select options={['高', '中', '低'].map(p => ({ value: p, label: p }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="due_at" label="截止时间">
                <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="content" label="执行说明 / 数据结果">
            <Input.TextArea rows={4} placeholder="例如：已邀约8人，到店5人；上传名单表/截图/复盘文档作为附件。" />
          </Form.Item>
          <div
            style={{
              border: '1px dashed var(--ui-surface)',
              borderRadius: 8,
              padding: 12,
              background: 'var(--ui-surface)',
            }}
          >
            <Button icon={<UploadOutlined />} onClick={pickTaskFiles}>
              上传执行数据/附件
            </Button>
            <span style={{ marginLeft: 10, color: 'var(--ui-muted)', fontSize: 12 }}>
              支持 Excel、CSV、Word、PDF、图片等，单个文件≤5MB，最多5个。
            </span>
            {workFiles.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                {workFiles.map((f, i) => (
                  <div
                    key={`${f.name}-${i}`}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      background: 'var(--ui-surface)',
                      border: '1px solid var(--ui-border)',
                      borderRadius: 6,
                      padding: '6px 8px',
                      fontSize: 12,
                    }}
                  >
                    <span>
                      <PaperClipOutlined /> {f.name}{' '}
                      <span style={{ color: 'var(--ui-muted)' }}>{Math.ceil((f.size || 0) / 1024)}KB</span>
                    </span>
                    <Button
                      size="small"
                      type="link"
                      danger
                      onClick={() => setWorkFiles(prev => prev.filter((_, idx) => idx !== i))}
                    >
                      移除
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Form>
      </Modal>

      {/* 驳回 Modal */}
      <Modal
        title={`驳回任务：${rejectTask?.title || ''}`}
        open={!!rejectTask}
        onOk={doReject}
        confirmLoading={rejecting}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
        onCancel={() => {
          setRejectTask(null);
          rejectForm.resetFields();
        }}
      >
        <Form form={rejectForm} layout="vertical">
          <Form.Item name="reason" label="驳回原因" rules={[{ required: true, message: '请填写驳回原因' }]}>
            <Input.TextArea rows={3} placeholder="说明不通过的原因及整改要求" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 合伙人打卡 Modal */}
      <Modal
        title="合伙人打卡录入"
        open={checkinOpen}
        onOk={doCheckin}
        confirmLoading={savingCheckin}
        okText="提交打卡"
        width={560}
        onCancel={() => {
          setCheckinOpen(false);
          checkinForm.resetFields();
        }}
      >
        <Form
          form={checkinForm}
          layout="vertical"
          initialValues={{
            date: dayjs(),
            studied: true,
            invited: false,
            posted_moments: 0,
            posted_videos: 0,
            invite_count: 0,
            intent_count: 0,
            arrive_count: 0,
            deal_count: 0,
          }}
        >
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="partner_id" label="合伙人" rules={[{ required: true, message: '请选择合伙人' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="选择合伙人"
                  options={partners.map(p => ({ value: p.id, label: `${p.name}（${p.level}·${p.region}）` }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="date" label="打卡日期" rules={[{ required: true, message: '请选择日期' }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={6}>
              <Form.Item name="studied" label="是否学习" valuePropName="checked">
                <Switch checkedChildren="是" unCheckedChildren="否" />
              </Form.Item>
            </Col>
            <Col span={9}>
              <Form.Item name="posted_moments" label="朋友圈条数">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={9}>
              <Form.Item name="posted_videos" label="短视频条数">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={6}>
              <Form.Item name="invited" label="是否邀约" valuePropName="checked">
                <Switch checkedChildren="是" unCheckedChildren="否" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="invite_count" label="邀约人数">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="intent_count" label="意向数">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="arrive_count" label="到店数">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={6}>
              <Form.Item name="deal_count" label="成交数">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={18}>
              <Form.Item name="problem" label="今日问题（需总部支持）">
                <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} placeholder="如：客户嫌价格高，需要话术支持" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        open={!!rollupDetail}
        width={820}
        footer={null}
        onCancel={() => setRollupDetail(null)}
        title={rollupDetail ? `${rollupDetail.title}记录` : '作战记录'}
      >
        {rollupDetail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div
              style={{
                background: 'var(--ui-surface-2)',
                borderRadius: 10,
                padding: '10px 12px',
                display: 'flex',
                gap: 16,
                flexWrap: 'wrap',
                fontSize: 12.5,
                color: 'var(--ui-text-2)',
              }}
            >
              <span>
                周期：{rollupDetail.data.start} 至 {rollupDetail.data.end}
              </span>
              <span>
                总任务 <b>{rollupDetail.data.total || 0}</b>
              </span>
              <span>
                完成 <b style={{ color: rollupDetail.color }}>{rollupDetail.data.done || 0}</b>
              </span>
              <span>
                完成率 <b style={{ color: rollupDetail.color }}>{rollupDetail.data.doneRate || 0}%</b>
              </span>
              <span>提交 {rollupDetail.data.submitted || 0} 次</span>
            </div>
            <Table
              size="small"
              rowKey="id"
              dataSource={rollupDetail.data.rows || []}
              pagination={{ pageSize: 8, size: 'small' }}
              columns={[
                { title: '任务', dataIndex: 'title', ellipsis: true },
                {
                  title: '类型',
                  dataIndex: 'type',
                  width: 74,
                  render: (v: string) => (
                    <Tag color={typeColor(v)} style={{ fontSize: 11 }}>
                      {v}
                    </Tag>
                  ),
                },
                { title: '负责人', dataIndex: 'assignee', width: 88 },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 86,
                  render: (v: string) => (
                    <Tag color={resultColor(v)} style={{ fontSize: 11 }}>
                      {v}
                    </Tag>
                  ),
                },
                { title: '截止', dataIndex: 'due_at', width: 104, render: (v: string) => (v || '').slice(5, 16) },
                {
                  title: '完成',
                  dataIndex: 'done_at',
                  width: 104,
                  render: (v: string) => (v ? (v || '').slice(5, 16) : '-'),
                },
              ]}
            />
          </div>
        )}
      </Modal>

      {/* ===== 顶部统计卡钻取 Modal ===== */}
      <Modal
        open={execDrill.open}
        width={780}
        footer={null}
        onCancel={() => setExecDrill({ open: false, kind: '', data: null })}
        title={execDrill.data?.title || '加载中…'}
      >
        {!execDrill.data ? (
          <div style={{ textAlign: 'center', padding: 28 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载中…" />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {execDrill.kind === 'exec-score' && execDrill.data.formula && (
              <>
                <div style={{ background: 'var(--ui-surface-2)', borderRadius: 10, padding: '12px 14px' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      flexWrap: 'wrap',
                      marginBottom: 10,
                    }}
                  >
                    <b style={{ color: 'var(--ui-text)' }}>本月执行力评分过程</b>
                    <span>
                      总分 <b style={{ color: '#f25b6b', fontSize: 20 }}>{execDrill.data.formula.score}</b> 分
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
                    {(execDrill.data.formula.steps || []).map((s: any, i: number) => (
                      <div
                        key={s.key}
                        style={{
                          background: 'var(--ui-surface)',
                          border: '1px solid var(--ui-surface)',
                          borderRadius: 8,
                          padding: '8px 10px',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <b style={{ fontSize: 12.5 }}>{s.label}</b>
                          <span style={{ color: CHART_COLORS[i % CHART_COLORS.length], fontWeight: 700 }}>
                            {s.score}分
                          </span>
                        </div>
                        <Progress
                          percent={Math.min(s.rate || 0, 100)}
                          size="small"
                          strokeColor={CHART_COLORS[i % CHART_COLORS.length]}
                        />
                        <div style={{ fontSize: 11.5, color: 'var(--ui-text-2)' }}>
                          {s.numerator}/{s.denominator} · {s.rate}% × {s.weight}%
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--ui-muted)', marginTop: 3, lineHeight: 1.5 }}>
                          {s.rule}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', marginTop: 8 }}>
                    统计范围：{isManager ? '全员任务' : '本人任务'}；本月任务 {execDrill.data.formula.total || 0}{' '}
                    个，其中作战计划任务 {execDrill.data.formula.planTotal || 0} 个。
                  </div>
                </div>
                <Table
                  size="small"
                  rowKey="id"
                  dataSource={execDrill.data.processRows || []}
                  pagination={{ pageSize: 8, size: 'small' }}
                  columns={[
                    {
                      title: '任务过程',
                      dataIndex: 'title',
                      ellipsis: true,
                      render: (v: any, r: any) => (
                        <span>
                          <Tag color={typeColor(r.type)} style={{ fontSize: 10.5 }}>
                            {r.type}
                          </Tag>
                          {v}
                        </span>
                      ),
                    },
                    { title: '负责人', dataIndex: 'assignee', width: 86 },
                    {
                      title: '状态',
                      dataIndex: 'status',
                      width: 78,
                      render: (v: string) => (
                        <Tag color={resultColor(v)} style={{ fontSize: 11 }}>
                          {v}
                        </Tag>
                      ),
                    },
                    {
                      title: '提交/审核',
                      dataIndex: 'last_result',
                      width: 92,
                      render: (v: string) =>
                        v ? (
                          <Tag color={resultColor(v)} style={{ fontSize: 11 }}>
                            {v}
                          </Tag>
                        ) : (
                          '-'
                        ),
                    },
                    { title: '截止', dataIndex: 'due_at', width: 92, render: (v: any) => (v || '').slice(5, 16) },
                    {
                      title: '完成',
                      dataIndex: 'done_at',
                      width: 92,
                      render: (v: any, r: any) =>
                        v ? (
                          <span style={{ color: r.due_at && v > r.due_at ? '#f25b6b' : 'var(--ui-text-2)' }}>
                            {(v || '').slice(5, 16)}
                          </span>
                        ) : (
                          '-'
                        ),
                    },
                  ]}
                />
              </>
            )}
            {['week-tasks', 'pending', 'risk'].includes(execDrill.kind) &&
              ((execDrill.data.rows || []).length === 0 ? (
                <Empty description="暂无记录" />
              ) : (
                <Table
                  size="small"
                  rowKey="id"
                  dataSource={execDrill.data.rows}
                  pagination={{ pageSize: 8, size: 'small' }}
                  onRow={(r: any) => ({ onClick: () => openTaskTrace(r), style: { cursor: 'pointer' } })}
                  columns={[
                    {
                      title: '任务',
                      dataIndex: 'title',
                      ellipsis: true,
                      render: (v: any, r: any) => (
                        <span>
                          <Tag color={typeColor(r.type)} style={{ fontSize: 10.5 }}>
                            {r.type}
                          </Tag>
                          <b>{v}</b>
                        </span>
                      ),
                    },
                    { title: '负责人', dataIndex: 'assignee', width: 84 },
                    {
                      title: '优先级',
                      dataIndex: 'priority',
                      width: 70,
                      render: (v: any) => (
                        <Tag color={v === '高' ? 'red' : v === '中' ? 'orange' : 'default'} style={{ margin: 0 }}>
                          {v}
                        </Tag>
                      ),
                    },
                    {
                      title: '状态',
                      dataIndex: 'status',
                      width: 76,
                      render: (v: any) => (
                        <Tag
                          color={
                            { 待执行: 'default', 进行中: 'processing', 待审核: 'gold', 已完成: 'green' }[v as string]
                          }
                          style={{ margin: 0 }}
                        >
                          {v}
                        </Tag>
                      ),
                    },
                    { title: '截止', dataIndex: 'due_at', width: 96, render: (v: any) => (v || '').slice(5, 16) },
                    ...(execDrill.kind === 'pending'
                      ? [
                          { title: '最近提交', dataIndex: 'last_submit', ellipsis: true },
                          ...(canApprove
                            ? [
                                {
                                  title: '操作',
                                  width: 110,
                                  render: (r: any) => (
                                    <Space size={4} onClick={(e: any) => e.stopPropagation()}>
                                      <Button size="small" type="primary" onClick={() => reviewInline(r.id, true)}>
                                        通过
                                      </Button>
                                      <Button size="small" danger onClick={() => reviewInline(r.id, false)}>
                                        驳回
                                      </Button>
                                    </Space>
                                  ),
                                },
                              ]
                            : []),
                        ]
                      : []),
                  ]}
                />
              ))}
            {execDrill.kind === 'key-follows' && (
              <Table
                size="small"
                rowKey="id"
                dataSource={execDrill.data.rows}
                pagination={{ pageSize: 8, size: 'small' }}
                onRow={(r: any) => ({ onClick: () => setCustId(r.id), style: { cursor: 'pointer' } })}
                columns={[
                  {
                    title: '客户',
                    dataIndex: 'name',
                    render: (v: any, r: any) => (
                      <span>
                        <b>{v}</b> <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{r.identity_tag}</span>
                      </span>
                    ),
                  },
                  {
                    title: '评分',
                    dataIndex: 'score',
                    width: 64,
                    render: (v: any) => <b style={{ color: '#f25b6b' }}>{v}</b>,
                  },
                  { title: '阶段', dataIndex: 'stage', width: 76 },
                  { title: '预算', dataIndex: 'budget_level', width: 60 },
                  { title: '下一步', dataIndex: 'next_action', ellipsis: true },
                ]}
              />
            )}
            <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', lineHeight: 1.8 }}>
              {execDrill.data.note}
              {execDrill.kind === 'key-follows' ? '（点击行直接打开客户完整档案）' : ''}
            </div>
          </div>
        )}
      </Modal>

      {/* ===== 目标三层拆解 Modal ===== */}
      <Modal
        open={drill.open}
        width={760}
        footer={null}
        onCancel={() => setDrill({ open: false, data: null })}
        title={
          <>
            <AimOutlined style={{ color: 'var(--ui-accent)' }} /> 经营目标三层拆解
          </>
        }
      >
        {!drill.data ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载中…" />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ background: 'var(--ui-surface-2)', borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <b>L1 年度目标 {drill.data.year.period}</b>
                <span>
                  {drill.data.year.rate == null
                    ? drill.data.year.statusText
                    : `${fmtWan(drill.data.year.actual)} / ${fmtWan(drill.data.year.target)}（${drill.data.year.rate}%）`}
                </span>
              </div>
              {drill.data.year.rate != null && (
                <Progress percent={Math.min(drill.data.year.rate, 100)} strokeColor="var(--ui-accent)" />
              )}
              <div style={{ display: 'flex', gap: 4, marginTop: 8, alignItems: 'flex-end', height: 56 }}>
                {drill.data.year.byMonth.map((m: any) => {
                  const max = Math.max(...drill.data.year.byMonth.map((x: any) => x.amount || 0), 1);
                  return (
                    <Tooltip key={m.m} title={`${m.m}：${fmtMoney(m.amount)}（${m.deals || 0}单）`}>
                      <div
                        style={{
                          flex: 1,
                          background: '#d1d1d1',
                          borderRadius: 3,
                          height: Math.max(6, (m.amount / max) * 52),
                          cursor: 'pointer',
                        }}
                      />
                    </Tooltip>
                  );
                })}
              </div>
            </div>
            <div style={{ background: '#112018', borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <b>L2 团队月度 {drill.data.month.period}</b>
                <span>
                  {drill.data.month.rate == null
                    ? drill.data.month.statusText
                    : `${fmtWan(drill.data.month.actual)} / ${fmtWan(drill.data.month.target)}（${drill.data.month.rate}%）`}
                </span>
              </div>
              {drill.data.month.rate != null && (
                <Progress percent={Math.min(drill.data.month.rate, 100)} strokeColor="#22c4a8" />
              )}
              {drill.data.month.gap != null && (
                <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginTop: 6, lineHeight: 1.9 }}>
                  缺口 <b style={{ color: '#f25b6b' }}>{fmtMoney(drill.data.month.gap)}</b>÷ 客单价{' '}
                  {fmtMoney(drill.data.month.avgDeal)} ÷ 剩余 {drill.data.month.daysLeft} 天 = 日均需成交{' '}
                  <b>{drill.data.month.needDealsPerDay}</b> 单 → 反推今日邀约目标{' '}
                  <b style={{ color: 'var(--ui-accent)' }}>{drill.data.month.inviteTarget}</b> 人
                </div>
              )}
            </div>
            <div style={{ background: 'var(--ui-warning-surface)', borderRadius: 10, padding: '12px 14px' }}>
              <b>
                L3 个人月度（
                {drill.data.personal.target > 0
                  ? `基准 ${fmtWan(drill.data.personal.target)}/人`
                  : drill.data.personal.statusText}
                ）
              </b>
              <Table
                size="small"
                rowKey="id"
                style={{ marginTop: 8 }}
                pagination={false}
                dataSource={drill.data.personal.rows}
                columns={[
                  {
                    title: '成员',
                    dataIndex: 'name',
                    render: (v: string, r: any) => (
                      <span>
                        <b>{v}</b>
                        {r.id === user.id && (
                          <Tag color="blue" style={{ marginLeft: 4, fontSize: 10 }}>
                            我
                          </Tag>
                        )}{' '}
                        <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{r.dept || ''}</span>
                      </span>
                    ),
                  },
                  { title: '本月成交', dataIndex: 'actual', align: 'right', render: (v: number) => fmtMoney(v) },
                  {
                    title: '完成率',
                    dataIndex: 'rate',
                    width: 170,
                    render: (v: number | null) =>
                      v == null ? (
                        <span style={{ color: 'var(--ui-muted)' }}>未设置目标</span>
                      ) : (
                        <Progress
                          percent={Math.min(v, 100)}
                          size="small"
                          strokeColor={v >= 80 ? '#22c4a8' : v >= 40 ? '#f6a02d' : '#f25b6b'}
                          format={() => `${v}%`}
                        />
                      ),
                  },
                  {
                    title: '在手客户',
                    dataIndex: 'pipeline',
                    align: 'right',
                    width: 76,
                    render: (v: number) => `${v} 个`,
                  },
                ]}
              />
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', lineHeight: 1.9 }}>
              {drill.data.rules.map((x: string, i: number) => (
                <div key={i}>· {x}</div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {/* ===== 作战任务详情 Modal ===== */}
      <Modal
        open={!!planTask}
        width={520}
        footer={null}
        onCancel={() => setPlanTask(null)}
        title={
          <>
            <ThunderboltOutlined style={{ color: 'var(--ui-accent)' }} /> 作战任务详情
          </>
        }
      >
        {planTask &&
          (() => {
            const basis = planTask.basis || fallbackTaskBasis(planTask);
            const evidence = Array.isArray(basis.evidence) ? basis.evidence : [];
            const rules = Array.isArray(basis.rules) ? basis.rules : [];
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
                <div>
                  <Tag color={typeColor(planTask.type)}>{planTask.type}</Tag>
                  <b>{planTask.action}</b>
                </div>
                <div
                  style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '10px 12px', lineHeight: 2 }}
                >
                  <div>
                    负责人：<b>{planTask.owner}</b>
                  </div>
                  <div>
                    数量目标：{planTask.count ?? '-'}　截止：今日 {planTask.due}
                  </div>
                  <div>检查标准：{planTask.check}</div>
                </div>
                <div
                  style={{
                    border: '1px solid var(--ui-surface)',
                    borderRadius: 10,
                    padding: '12px 14px',
                    background: 'var(--ui-surface)',
                    lineHeight: 1.8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <AimOutlined style={{ color: 'var(--ui-accent)' }} />
                    <b>目标拆解依据</b>
                    <Tag color="blue" style={{ fontSize: 11 }}>
                      {basis.shortSource || planTask.type}
                    </Tag>
                  </div>
                  <div>
                    <b>目标来源：</b>
                    {basis.source}
                  </div>
                  <div>
                    <b>目标口径：</b>
                    {basis.target}
                  </div>
                  <div>
                    <b>拆解链路：</b>
                    {basis.formula}
                  </div>
                  {evidence.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      <b>关键数据：</b>
                      {evidence.map((x: string, i: number) => (
                        <div key={i} style={{ color: 'var(--ui-text-2)' }}>
                          · {x}
                        </div>
                      ))}
                    </div>
                  )}
                  {rules.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      <b>执行规则：</b>
                      {rules.map((x: string, i: number) => (
                        <div key={i} style={{ color: 'var(--ui-text-2)' }}>
                          · {x}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {basis.relatedDrill === 'goals' && (
                  <Button
                    type="primary"
                    block
                    onClick={() => {
                      setPlanTask(null);
                      openGoalsDrill();
                    }}
                  >
                    查看总业绩缺口三层拆解 ›
                  </Button>
                )}
              </div>
            );
          })()}
      </Modal>

      {/* ===== 合伙人明细 Modal ===== */}
      <Modal
        open={pDetail.open}
        width={640}
        footer={null}
        onCancel={() => setPDetail({ open: false, data: null })}
        title={
          pDetail.data ? (
            <Space>
              <TeamOutlined style={{ color: '#8a7450' }} />
              {pDetail.data.name}
              <Tag>{pDetail.data.level}</Tag>
              <Tag
                color={{ 高活跃: 'green', 中活跃: 'blue', 低活跃: 'orange', 沉睡: 'red' }[pDetail.data.tier as string]}
              >
                {pDetail.data.tier}（{pDetail.data.hit}/7项）
              </Tag>
            </Space>
          ) : (
            '合伙人明细'
          )
        }
      >
        {!pDetail.data ? (
          <div style={{ textAlign: 'center', padding: 28 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载中…" />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {pDetail.data.checks.map((c: any) => (
                <Tag key={c.item} color={c.ok ? 'green' : 'default'} style={{ margin: 0, opacity: c.ok ? 1 : 0.6 }}>
                  {c.ok ? '✓' : '·'} {c.item}
                </Tag>
              ))}
            </div>
            <div
              style={{
                display: 'flex',
                gap: 18,
                fontSize: 12.5,
                color: 'var(--ui-text-2)',
                background: 'var(--ui-surface-2)',
                borderRadius: 8,
                padding: '8px 12px',
              }}
            >
              <span>
                近30天积分 <b style={{ color: 'var(--ui-accent)' }}>{pDetail.data.month.score || 0}</b>
              </span>
              <span>
                邀约 <b>{pDetail.data.month.invites || 0}</b>
              </span>
              <span>
                到店 <b>{pDetail.data.month.arrives || 0}</b>
              </span>
              <span>
                成交 <b style={{ color: '#f25b6b' }}>{pDetail.data.month.deals || 0}</b>
              </span>
              <span>区域 {pDetail.data.region || '-'}</span>
            </div>
            <Table
              size="small"
              rowKey="id"
              dataSource={pDetail.data.actions}
              pagination={false}
              scroll={{ y: 220 }}
              columns={[
                { title: '日期', dataIndex: 'date', width: 92 },
                {
                  title: '学习',
                  dataIndex: 'studied',
                  width: 50,
                  align: 'center',
                  render: (v: number) => (v ? '✓' : '—'),
                },
                { title: '朋友圈', dataIndex: 'posted_moments', width: 64, align: 'center' },
                { title: '短视频', dataIndex: 'posted_videos', width: 64, align: 'center' },
                { title: '邀约', dataIndex: 'invite_count', width: 50, align: 'center' },
                { title: '到店', dataIndex: 'arrive_count', width: 50, align: 'center' },
                { title: '成交', dataIndex: 'deal_count', width: 50, align: 'center' },
                {
                  title: '积分',
                  dataIndex: 'score',
                  width: 56,
                  align: 'right',
                  render: (v: number) => <b style={{ color: 'var(--ui-accent)' }}>{v}</b>,
                },
                { title: '问题反馈', dataIndex: 'problem', ellipsis: true },
              ]}
            />
            <Button
              danger
              ghost
              block
              loading={remindLoading === pDetail.data.id}
              onClick={() => sendRemind(pDetail.data.id)}
            >
              生成 PAR-06 提醒卡并通知管理层
            </Button>
          </div>
        )}
      </Modal>

      {/* ===== PAR-06 提醒卡 Modal ===== */}
      <Modal
        open={!!remindCard}
        width={520}
        footer={null}
        onCancel={() => setRemindCard(null)}
        title={
          remindCard ? (
            <Space>
              <AlertOutlined style={{ color: '#f25b6b' }} />
              提醒卡 · {remindCard.partner}
              <Tag color={remindCard.priority === '高' ? 'red' : remindCard.priority === '中' ? 'orange' : 'default'}>
                {remindCard.priority}优先级
              </Tag>
            </Space>
          ) : (
            ''
          )
        }
      >
        {remindCard && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Tag color="purple">{remindCard.remindType}</Tag>
              <Tag>
                {remindCard.tier}（{remindCard.hit}/7项）
              </Tag>
              <Tag>最近动作 {remindCard.lastActive || '无记录'}</Tag>
            </div>
            <div style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '10px 12px', lineHeight: 2 }}>
              <div>
                📌 下一步动作：<b>{remindCard.nextAction}</b>
              </div>
              <div>
                👤 负责人：{remindCard.owner}　⏰ 截止：{remindCard.dueDate}
              </div>
            </div>
            <div
              style={{
                background: 'var(--ui-warning-surface)',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 12.5,
                color: '#92710c',
                lineHeight: 1.9,
              }}
            >
              <b>管理话术（可直接照做）：</b>
              <br />
              {remindCard.script}
            </div>
            <div style={{ fontSize: 11.5, color: '#22c4a8' }}>
              ✓ 已同步站内通知给老板与运营总监（口径：PAR-06 未行动提醒动作表）
            </div>
          </div>
        )}
      </Modal>

      {/* ===== 二层：任务执行提交时间线 ===== */}
      <Modal
        open={taskTrace.open}
        width={560}
        footer={null}
        onCancel={() => setTaskTrace({ open: false, task: null, subs: [], loading: false })}
        title={
          taskTrace.task ? (
            <span>
              执行记录 · {taskTrace.task.title}{' '}
              <Tag color="blue" style={{ fontSize: 10.5 }}>
                执行提交 › 审核
              </Tag>
            </span>
          ) : (
            ''
          )
        }
      >
        {taskTrace.loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载中…" />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {taskTrace.task && (
              <div
                style={{
                  background: 'var(--ui-surface-2)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  fontSize: 12.5,
                  lineHeight: 2,
                }}
              >
                <div>{taskTrace.task.detail || taskTrace.task.title}</div>
                <div style={{ color: 'var(--ui-muted)' }}>
                  负责人 {taskTrace.task.assignee || '-'} ｜ 截止 {(taskTrace.task.due_at || '').slice(5, 16)} ｜ 状态{' '}
                  {taskTrace.task.status || '-'}
                </div>
              </div>
            )}
            {taskTrace.subs.length === 0 ? (
              <Empty description="员工尚未提交执行结果" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Timeline
                items={taskTrace.subs.map((s: any) => ({
                  color: s.result === '通过' ? 'green' : s.result === '驳回' ? 'red' : 'blue',
                  children: (() => {
                    const body = parseSubmitContent(s.content);
                    return (
                      <div style={{ fontSize: 12.5 }}>
                        <b>{s.user_name || '员工'}</b>{' '}
                        <span style={{ color: 'var(--ui-muted)', fontSize: 11 }}>
                          {(s.created_at || '').slice(5, 16)}
                        </span>
                        {s.result && (
                          <Tag
                            color={s.result === '通过' ? 'green' : s.result === '驳回' ? 'red' : 'gold'}
                            style={{ marginLeft: 6, fontSize: 10 }}
                          >
                            {s.result}
                          </Tag>
                        )}
                        <div style={{ color: 'var(--ui-text-2)', whiteSpace: 'pre-wrap' }}>
                          {body.note || '已上传执行资料'}
                        </div>
                        {(body.attachments || []).length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                            {body.attachments.map((a: any, i: number) => (
                              <a
                                key={`${a.url}-${i}`}
                                href={a.url}
                                target="_blank"
                                rel="noreferrer"
                                onClick={e => e.stopPropagation()}
                              >
                                <Tag color="blue" icon={<PaperClipOutlined />} style={{ cursor: 'pointer', margin: 0 }}>
                                  {a.name}
                                </Tag>
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })(),
                }))}
              />
            )}
          </div>
        )}
      </Modal>

      <CustomerDrawer leadId={custId} open={!!custId} onClose={() => setCustId(null)} />
    </div>
  );
}

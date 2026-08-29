import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  message,
} from 'antd';
import {
  ClockCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type {
  ContentPipelineCreateFormValues,
  ContentPipelineSchedule,
  ContentPipelineScheduleKind,
} from '../api/contentPipelineTypes';
import { buildPaihuoContentBrief } from './contentBriefForm.js';
import {
  contentPipelinePresetStations,
  contentPipelineWorkflowModeForPreset,
  unwrapContentPipeline,
} from './contentPipelinePresentation.js';
import './ContentPipelineSchedulesPanel.css';

type Props = {
  active: boolean;
  role: string;
  canConfigureApproval: boolean;
  realMaterialProviderAvailable: boolean;
  onOpenPipeline: (pipelineId: number) => void;
};

type ScheduleForm = ContentPipelineCreateFormValues & {
  name: string;
  kind: ContentPipelineScheduleKind;
  atTime?: string;
  weekday?: number;
  everyHours?: number;
  enabled: boolean;
};

const PLATFORM_OPTIONS = ['小红书', '公众号', '抖音', '视频号', 'B站', '微博'].map(value => ({
  value,
  label: value,
}));
const TEMPLATE_OPTIONS = ['蹭热点', '日更选题', '产品软文', '观点输出', '教程干货', '二创改写'].map(value => ({
  value,
  label: value,
}));
const WORKFLOW_OPTIONS = [
  { value: 'fullauto', label: '全自动 · 定时到点就开跑' },
  { value: 'autopilot', label: '半自动 · 自动接力，发布包再确认' },
  { value: 'copilot', label: '半自动 · 关键工位停审' },
  { value: 'manual', label: '半自动 · 每个工位都停审' },
];
const APPROVAL_OPTIONS = [
  { value: 'internal_auto', label: '全自动（0→9 不停审）' },
  { value: 'efficient', label: '半自动（只审发布包）' },
  { value: 'key', label: '半自动（审选题、初稿、配图、封面、发布包）' },
  { value: 'custom', label: '自定义停审工位' },
];
const STATIONS = ['趋势官', '情报员', '拆解师', '撰稿人', '文风师', '多媒体师', '封面师', '演绎师', '分发官', '复盘官'];
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

const SCHEDULE_STATUS_META: Record<string, { label: string; color?: string }> = {
  pipeline_created: { label: '已创建流水线', color: 'blue' },
  claimed: { label: '已领取 · 准备开工', color: 'processing' },
  running: { label: '运行中', color: 'processing' },
  awaiting_approval: { label: '等待停站确认', color: 'gold' },
  awaiting_media_authorization: { label: '等待付费素材授权', color: 'gold' },
  awaiting_metrics: { label: '等待真实发布指标', color: 'cyan' },
  billing_pending: { label: '待账务确认', color: 'orange' },
  completed: { label: '已完成', color: 'green' },
  deferred: { label: '已顺延', color: 'gold' },
  failed: { label: '开工失败', color: 'red' },
  paused: { label: '已暂停', color: 'gold' },
  rejected: { label: '已退回', color: 'red' },
  cancelled: { label: '已取消', color: 'default' },
  成功: { label: '已完成', color: 'green' },
  失败: { label: '开工失败', color: 'red' },
  运行中: { label: '运行中', color: 'processing' },
};

function fmtTime(value: unknown) {
  if (!value) return '—';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

function scheduleStatusMeta(value: unknown) {
  const status = String(value || '').trim();
  if (!status) return { label: '尚未运行', color: 'default' };
  if (SCHEDULE_STATUS_META[status]) return SCHEDULE_STATUS_META[status];
  if (/\p{Script=Han}/u.test(status)) return { label: status, color: 'default' };
  return { label: '状态待确认', color: 'default' };
}

function scheduleWorkflowLabel(schedule: ContentPipelineSchedule) {
  const mode = String(schedule.workflow?.mode || '');
  return WORKFLOW_OPTIONS.find(option => option.value === mode)?.label || '工作方式待确认';
}

function scheduleApprovalMeta(schedule: ContentPipelineSchedule) {
  const policy = schedule.workflow?.approvalPolicy;
  if (policy?.mode === 'internal_auto') {
    return { label: '全自动 · 不停审', color: 'green' };
  }
  if (policy?.mode === 'custom') {
    const reviewStations = Array.isArray(policy.reviewStations) ? policy.reviewStations : [];
    return reviewStations.length === 0
      ? { label: '全自动 · 不停审', color: 'green' }
      : { label: `半自动 · 停审 ${reviewStations.length} 个工位`, color: 'gold' };
  }
  return { label: '按服务端默认停站规则', color: 'default' };
}

function scheduleRows(payload: any): ContentPipelineSchedule[] {
  return Array.isArray(payload?.schedules) ? payload.schedules : [];
}

function editValues(schedule: ContentPipelineSchedule): Partial<ScheduleForm> {
  const task = schedule.task || ({} as ContentPipelineSchedule['task']);
  const policy = schedule.workflow?.approvalPolicy;
  return {
    name: schedule.name,
    enabled: schedule.enabled,
    kind: schedule.kind,
    atTime: schedule.atTime || '09:00',
    weekday: schedule.weekday ?? 0,
    everyHours: schedule.everyHours ?? 24,
    title: String(task.direction || ''),
    type: String(task.template || '日更选题'),
    industry: String(task.industry || ''),
    requirement: String(task.material || ''),
    platforms: Array.isArray(task.platforms) ? task.platforms : ['小红书'],
    imageMode: (task.image_mode || 'ai') as ScheduleForm['imageMode'],
    imageCount: task.image_count == null ? null : Number(task.image_count),
    enableDeck: task.enable_deck === true,
    refLink: String(task.ref_link || ''),
    workflowMode: (schedule.workflow?.mode || 'fullauto') as ScheduleForm['workflowMode'],
    approvalPreset:
      policy?.mode === 'internal_auto'
        ? 'internal_auto'
        : policy?.mode === 'custom'
          ? Array.isArray(policy?.reviewStations) && policy.reviewStations.length === 0
            ? 'internal_auto'
            : 'custom'
          : ['fullauto', 'autopilot'].includes(String(schedule.workflow?.mode || ''))
            ? 'efficient'
            : 'key',
    approvalReviewStations: Array.isArray(policy?.reviewStations) ? policy.reviewStations : [],
    paidMediaAuthorized: schedule.workflow?.paidMediaAuthorized === true,
  };
}

export default function ContentPipelineSchedulesPanel({
  active,
  role,
  canConfigureApproval,
  realMaterialProviderAvailable,
  onOpenPipeline,
}: Props) {
  const [form] = Form.useForm<ScheduleForm>();
  const kind = Form.useWatch('kind', form);
  const approvalPreset = Form.useWatch('approvalPreset', form);
  const [rows, setRows] = useState<ContentPipelineSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ContentPipelineSchedule | null>(null);
  const [runningId, setRunningId] = useState<number | null>(null);

  const imageOptions = useMemo(
    () => [
      { value: 'ai', label: 'AI 生成' },
      {
        value: 'real',
        label: realMaterialProviderAvailable ? '真实素材' : '真实素材（未接通）',
        disabled: !realMaterialProviderAvailable,
      },
      {
        value: 'mix',
        label: realMaterialProviderAvailable ? '真实素材 + AI' : '真实素材 + AI（未接通）',
        disabled: !realMaterialProviderAvailable,
      },
    ],
    [realMaterialProviderAvailable],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(scheduleRows(await api.get('/content/pipeline-schedules')));
    } catch {
      // API客户端已经展示错误。
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [active, load]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      name: '',
      enabled: true,
      kind: 'daily',
      atTime: '09:00',
      weekday: 0,
      everyHours: 24,
      type: '日更选题',
      platforms: ['小红书'],
      imageMode: 'ai',
      imageCount: null,
      enableDeck: false,
      workflowMode: 'fullauto',
      approvalPreset: 'internal_auto',
      approvalReviewStations: [],
      paidMediaAuthorized: false,
    });
    setModalOpen(true);
  };

  const openEdit = (schedule: ContentPipelineSchedule) => {
    setEditing(schedule);
    form.setFieldsValue(editValues(schedule));
    setModalOpen(true);
  };

  const save = async () => {
    const values = await form.validateFields();
    if (['real', 'mix'].includes(String(values.imageMode)) && !realMaterialProviderAvailable) {
      message.error('真实素材 provider 尚未接通');
      return;
    }
    let brief;
    try {
      brief = buildPaihuoContentBrief(values);
    } catch (error: any) {
      message.error(error?.message || '内容 Brief 格式无效');
      return;
    }
    const reviewStations = contentPipelinePresetStations(values.approvalPreset, values.approvalReviewStations);
    const approvalPolicy =
      values.approvalPreset === 'internal_auto'
        ? { mode: 'internal_auto' as const }
        : canConfigureApproval
          ? { mode: 'custom' as const, reviewStations, configuredByRole: role }
          : { mode: 'internal_auto' as const };
    const payload = {
      name: values.name,
      enabled: values.enabled,
      kind: values.kind,
      atTime: values.atTime,
      weekday: values.kind === 'weekly' ? values.weekday : null,
      everyHours: values.kind === 'interval' ? values.everyHours : null,
      brief,
      workflow: {
        mode: contentPipelineWorkflowModeForPreset(values.approvalPreset),
        approvalPolicy,
        ...(canConfigureApproval ? { paidMediaAuthorized: values.paidMediaAuthorized === true } : {}),
      },
    };
    setSaving(true);
    try {
      if (editing) await api.put(`/content/pipeline-schedules/${editing.id}`, payload);
      else await api.post('/content/pipeline-schedules', payload);
      message.success(editing ? '定时流水线已更新' : '定时流水线已创建');
      setModalOpen(false);
      await load();
    } catch {
      // API客户端已经展示错误，保留表单供修正。
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (schedule: ContentPipelineSchedule, enabled: boolean) => {
    try {
      await api.put(`/content/pipeline-schedules/${schedule.id}`, { enabled });
      await load();
    } catch {
      // API客户端已经展示错误。
    }
  };

  const remove = async (schedule: ContentPipelineSchedule) => {
    try {
      await api.del(`/content/pipeline-schedules/${schedule.id}`);
      message.success('定时流水线已删除');
      await load();
    } catch {
      // API客户端已经展示错误。
    }
  };

  const runNow = async (schedule: ContentPipelineSchedule) => {
    setRunningId(schedule.id);
    try {
      const payload = await api.post(`/content/pipeline-schedules/${schedule.id}/run-now`, {});
      const pipeline = unwrapContentPipeline(payload);
      const pipelineId = Number(pipeline?.id || payload?.run?.pipelineId || payload?.pipelineId);
      if (!Number.isSafeInteger(pipelineId) || pipelineId <= 0) {
        throw new Error('立即开工响应没有返回有效流水线编号');
      }
      message.success(`完整团队流水线 #${pipelineId} 已开工`);
      onOpenPipeline(pipelineId);
      await load();
    } catch (error: any) {
      if (error?.message && !String(error.message).includes('请求')) message.error(error.message);
    } finally {
      setRunningId(null);
    }
  };

  return (
    <section className="cps-panel" aria-label="完整团队流水线定时计划">
      <header className="cps-head">
        <div>
          <Tag color="blue" icon={<ClockCircleOutlined />}>
            北京时间
          </Tag>
          <h3>定时运行 0→9 完整团队</h3>
          <p>到点创建的任务与手工流水线同构；同一触发时刻只会建立一条流水线。</p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建计划
          </Button>
        </Space>
      </header>
      <Alert
        type="info"
        showIcon
        message="每次开工重新做余额、Provider 与并行数预检"
        description="余额不足会暂停计划且不会创建 API 任务；计划保存的是完整 Brief、人设、企业设置与工作流，不是单个员工编号。"
      />
      {loading ? (
        <div className="cps-loading">
          <Spin />
        </div>
      ) : rows.length === 0 ? (
        <Empty description="还没有完整团队定时计划" />
      ) : (
        <div className="cps-grid">
          {rows.map(schedule => {
            const lastStatus = scheduleStatusMeta(schedule.lastStatus);
            const approvalMeta = scheduleApprovalMeta(schedule);
            return (
              <Card key={schedule.id} className="cps-card" size="small">
                <div className="cps-card-title">
                  <Switch
                    size="small"
                    checked={schedule.enabled}
                    onChange={enabled => void toggle(schedule, enabled)}
                    aria-label={`${schedule.name}启用状态`}
                  />
                  <strong>{schedule.name}</strong>
                  <Tag>{schedule.human || schedule.kind}</Tag>
                </div>
                <p>{String(schedule.task?.direction || '未保存内容方向')}</p>
                <Space size={[6, 6]} wrap>
                  {(schedule.task?.platforms || []).map(platform => (
                    <Tag key={platform}>{platform}</Tag>
                  ))}
                  <Tag color="purple">工作方式：{scheduleWorkflowLabel(schedule)}</Tag>
                  <Tag color={approvalMeta.color}>{approvalMeta.label}</Tag>
                </Space>
                <dl>
                  <div>
                    <dt>下次开工</dt>
                    <dd>{schedule.enabled ? fmtTime(schedule.nextRunAt) : '已停用'}</dd>
                  </div>
                  <div>
                    <dt>上次状态</dt>
                    <dd>
                      <Tag color={lastStatus.color} title={String(schedule.lastStatus || '')}>
                        {lastStatus.label}
                      </Tag>
                    </dd>
                  </div>
                </dl>
                {schedule.lastNote && <small className="cps-note">{schedule.lastNote}</small>}
                <Space wrap className="cps-actions">
                  <Button
                    type="primary"
                    icon={<PlayCircleOutlined />}
                    loading={runningId === schedule.id}
                    onClick={() => void runNow(schedule)}
                  >
                    立即来一单
                  </Button>
                  {schedule.lastPipelineId && (
                    <Button onClick={() => onOpenPipeline(Number(schedule.lastPipelineId))}>打开流水线</Button>
                  )}
                  <Button icon={<EditOutlined />} onClick={() => openEdit(schedule)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除这个定时计划？"
                    description="历史流水线仍会保留。"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => void remove(schedule)}
                  >
                    <Button danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        open={modalOpen}
        title={editing ? '编辑完整团队定时计划' : '新建完整团队定时计划'}
        okText={editing ? '保存修改' : '创建计划'}
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void save()}
        onCancel={() => !saving && setModalOpen(false)}
        width={760}
        destroyOnClose
      >
        <Form form={form} layout="vertical" requiredMark={false} className="cps-form">
          <div className="cps-form-grid">
            <Form.Item name="name" label="计划名称" rules={[{ required: true }, { max: 80 }]}>
              <Input placeholder="例如：每日行业选题" />
            </Form.Item>
            <Form.Item name="enabled" label="创建后启用" valuePropName="checked">
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>
            <Form.Item name="kind" label="频率" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'daily', label: '每天一次' },
                  { value: 'weekly', label: '每周一次' },
                  { value: 'interval', label: '每 N 小时' },
                ]}
              />
            </Form.Item>
            {kind === 'interval' ? (
              <Form.Item name="everyHours" label="间隔小时" rules={[{ required: true }]}>
                <InputNumber className="cps-wide-control" min={1} max={720} precision={0} />
              </Form.Item>
            ) : (
              <Form.Item name="atTime" label="执行时间（北京时间）" rules={[{ required: true }]}>
                <Input type="time" />
              </Form.Item>
            )}
            {kind === 'weekly' && (
              <Form.Item name="weekday" label="星期" rules={[{ required: true }]}>
                <Select options={WEEKDAYS.map((label, value) => ({ label, value }))} />
              </Form.Item>
            )}
          </div>
          <Form.Item name="title" label="内容方向" rules={[{ required: true }, { min: 4 }]}>
            <Input.TextArea rows={3} maxLength={2000} showCount />
          </Form.Item>
          <div className="cps-form-grid">
            <Form.Item name="type" label="内容类型" rules={[{ required: true }]}>
              <Select options={TEMPLATE_OPTIONS} />
            </Form.Item>
            <Form.Item name="industry" label="行业 / 赛道">
              <Input maxLength={120} />
            </Form.Item>
            <Form.Item name="platforms" label="目标平台" rules={[{ required: true, type: 'array', min: 1 }]}>
              <Select mode="multiple" options={PLATFORM_OPTIONS} />
            </Form.Item>
            <Form.Item name="imageMode" label="配图来源" rules={[{ required: true }]}>
              <Select options={imageOptions} />
            </Form.Item>
            <Form.Item name="imageCount" label="配图数量（留空为自动）">
              <InputNumber className="cps-wide-control" min={0} max={12} precision={0} />
            </Form.Item>
          </div>
          {canConfigureApproval && (
            <>
              <Form.Item name="approvalPreset" label="内部交接与停站规则" rules={[{ required: true }]}>
                <Select options={APPROVAL_OPTIONS} />
              </Form.Item>
              {approvalPreset === 'custom' && (
                <Form.Item name="approvalReviewStations" label="停审工位">
                  <Checkbox.Group options={STATIONS.map((name, value) => ({ value, label: `${value} · ${name}` }))} />
                </Form.Item>
              )}
              <Form.Item name="paidMediaAuthorized" valuePropName="checked">
                <Checkbox>每次到点由服务端按当时模型和价格重新签发付费媒体授权</Checkbox>
              </Form.Item>
            </>
          )}
          <Form.Item name="requirement" label="已确认素材与约束" rules={[{ max: 20000 }]}>
            <Input.TextArea rows={4} maxLength={20000} showCount />
          </Form.Item>
          <Space wrap>
            <Form.Item name="enableDeck" valuePropName="checked" noStyle>
              <Checkbox>生成 HTML 演绎稿</Checkbox>
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </section>
  );
}

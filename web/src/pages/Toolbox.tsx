import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Alert, Button, Drawer, Empty, Form, Input, List, message, Select, Skeleton, Switch, Tag } from 'antd';
import {
  CalendarOutlined,
  CameraOutlined,
  EyeOutlined,
  ExportOutlined,
  FileImageOutlined,
  FireOutlined,
  FolderOpenOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  RadarChartOutlined,
  RocketOutlined,
  SearchOutlined,
  SoundOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  UploadOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { ImageHuntPanel } from '../components/ImageHuntPanel';
import { Markdown } from '../components/Markdown';
import TextVideoStudio from '../components/TextVideoStudio';
import './Toolbox.css';

type ToolDefinition = {
  key: string;
  title: string;
  short: string;
  description: string;
  icon: ReactNode;
  accent: string;
  employee: string;
  employeeIdx: number;
  employeeDomain?: 'restaurant' | 'content';
  cost: string;
  inputs: string[];
  output: string;
};

type ToolRun = {
  id: number;
  toolKey: string;
  toolTitle?: string;
  title: string;
  status: string;
  displayStatus?: string;
  verified?: boolean;
  canUse?: boolean;
  nextAction?: string;
  employeeIdx?: number;
  employeeName?: string;
  inputSummary?: string;
  resultMd?: string;
  assumptions?: string[];
  evidence?: { label?: string; source?: string; url?: string }[];
  progress?: {
    phase?: string;
    message?: string;
    attempt?: number;
    batch?: number;
    requested?: number;
    at?: string;
  }[];
  error?: { code?: string; message?: string } | null;
  retryCount?: number;
  retryable?: boolean;
  freeRetriesRemaining?: number;
  executionState?: string;
  deepLink?: string;
  feishuExport?: {
    status?: 'syncing' | 'done' | 'failed';
    table?: string;
    tableId?: string;
    synced?: number;
    attemptCount?: number;
    calendarVersion?: number;
    exportVersion?: number;
    outdated?: boolean;
    error?: { code?: string; message?: string } | null;
    updatedAt?: string;
  } | null;
  pcalCalendar?: {
    month: string;
    days: Array<{
      date: string;
      weekday: string;
      festival?: string;
      moment: string;
      group: string;
    }>;
    tips?: string;
  } | null;
  pcalEditVersion?: number;
  pcalEditedAt?: string | null;
  provenance?: {
    mode?: string;
    sourceSystem?: string;
    promptVersion?: string;
    generatedAt?: string;
    confidence?: string;
    persisted?: boolean;
    executionKind?: string;
    mediaArtifact?: {
      kind?: string;
      url?: string;
      mimeType?: string;
      status?: string;
    } | null;
    contract?: {
      status?: string;
      valid?: boolean;
      errors?: string[];
    };
    billing?: {
      state?: string;
      chargedCredits?: number | null;
      note?: string;
    };
  };
  createdAt?: string;
  updatedAt?: string;
};

type MenuCopyImage = {
  id: number;
  name: string;
  ext?: string;
  size?: number;
};

type ToolboxAutomationKey = 'hot_daily' | 'bench_weekly';

type ToolboxAutomationTarget = {
  name: string;
  platform?: string;
  note?: string;
};

type ToolboxAutomationConfig = {
  key: ToolboxAutomationKey;
  label: string;
  enabled: boolean;
  industry?: string;
  channels?: string[];
  targets?: ToolboxAutomationTarget[];
  schedule: string;
  lastSuccessAt?: string | null;
  lastToolRunId?: number | null;
  note?: string;
};

const HOT_AUTOMATION_CHANNELS = [
  '微博热搜',
  '抖音热点',
  '小红书热门',
  '百度热搜',
  '知乎热榜',
  'B站热门',
  '今日头条',
  '36氪/虎嗅',
  '行业垂直媒体',
  'X(Twitter)',
] as const;

function automationKeyForTool(toolKey: string): ToolboxAutomationKey | null {
  if (toolKey === 'hot') return 'hot_daily';
  if (toolKey === 'bench') return 'bench_weekly';
  return null;
}

function targetDraft(targets: ToolboxAutomationTarget[] = []) {
  return targets
    .map(target => {
      const cells = [target.name, target.platform || '', target.note || ''];
      while (cells.length > 1 && !cells[cells.length - 1]) cells.pop();
      return cells.join(' | ');
    })
    .join('\n');
}

function parseTargetDraft(value: string): ToolboxAutomationTarget[] {
  return value
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [name = '', platform = '', ...notes] = line.split(/[|｜]/u).map(part => part.trim());
      return { name, platform, note: notes.join(' | ') };
    })
    .filter(target => target.name)
    .slice(0, 8);
}

function billingStateLabel(state?: string, chargedCredits?: number | null, runStatus?: string) {
  if (state === 'released') return '预授权已释放（已退款）';
  if (state === 'pending_reconciliation' || state === 'unsettled') {
    return '业务暂不可采用（待账务对账）';
  }
  if (state === 'held') return runStatus === 'running' ? '预授权占扣中' : '业务暂不可采用（待账务对账）';
  if (state === 'settled') {
    return chargedCredits == null ? '积分已结算' : `积分已结算（实扣 ${chargedCredits}）`;
  }
  if (state === 'not_applicable') return '未产生真实调用费用';
  return state || '';
}

function runNeedsReconciliation(run: ToolRun) {
  if (run.displayStatus) return run.displayStatus.includes('待账务对账') || run.displayStatus === '待对账';
  return ['pending_reconciliation', 'held', 'unsettled'].includes(run.provenance?.billing?.state || '');
}

function runDisplayStatus(run: ToolRun) {
  if (run.displayStatus) {
    if (run.displayStatus.includes('待账务对账')) return '业务暂不可采用（待账务对账）';
    if (run.displayStatus.includes('质检未通过')) return '失败需返工（质检未通过）';
    if (run.displayStatus.includes('执行失败')) return '失败需处理（执行异常）';
    return run.displayStatus;
  }
  if (run.canUse === true) return '已完成';
  if (runNeedsReconciliation(run)) return '业务暂不可采用（待账务对账）';
  if (run.executionState === 'queued') return '已排队';
  if (run.executionState === 'retrying') return '重试中';
  if (run.status === 'running') return '生成中';
  if (run.status === 'failed') return '失败需处理（执行异常）';
  return '失败需返工（质检未通过）';
}

function runStatusColor(run: ToolRun) {
  if (run.canUse === true) return 'green';
  if (runNeedsReconciliation(run)) return 'gold';
  return run.status === 'running' || ['queued', 'retrying'].includes(run.executionState || '') ? 'processing' : 'red';
}

function runIsActive(run: ToolRun) {
  return run.status === 'running' || ['queued', 'running', 'retrying'].includes(run.executionState || '');
}

type ToolRunMediaArtifact = { kind?: string; url?: string; mimeType?: string; status?: string } | null | undefined;

// 与后端媒体产物校验同口径：仅 https 或图片 data URL 可进预览。
function mediaArtifactPreviewUrl(artifact: ToolRunMediaArtifact) {
  const url = String(artifact?.url || '');
  if (/^https:\/\/[^\s]+$/iu.test(url)) return url;
  if (String(artifact?.kind || '') === 'image' && /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/iu.test(url)) {
    return url;
  }
  return '';
}

const TOOLS: ToolDefinition[] = [
  {
    key: 'hot',
    title: '今日必发',
    short: '今天发什么',
    description: '根据门店品类、客群和今天的经营重点，给出 3 个可立即发布的内容选题与承接动作。',
    icon: <FireOutlined />,
    accent: '#ef6d43',
    employee: '云营销',
    employeeIdx: 141,
    cost: '真实调用按量计费',
    inputs: ['门店品类', '发布渠道', '今天主推'],
    output: '3个选题 + 文案角度 + 到店承接动作',
  },
  {
    key: 'remix',
    title: '视频成片',
    short: '真实生成视频',
    description: '根据门店素材说明与成片目标，调用真实视频模型生成一条有开头、有卖点、有行动指令的竖屏短视频。',
    icon: <PlayCircleOutlined />,
    accent: '#4f77dd',
    employee: '章文案',
    employeeIdx: 140,
    cost: '真实调用按量计费',
    inputs: ['素材/现场说明', '目标平台', '成片目的'],
    output: '可预览视频文件 + 成片核验时间轴',
  },
  {
    key: 'pcal',
    title: '私域日历',
    short: '整月不愁发',
    description: '按月编排朋友圈与社群内容，让促销、口碑、会员维护和老板人设形成节奏。',
    icon: <CalendarOutlined />,
    accent: '#258f78',
    employee: '云营销',
    employeeIdx: 141,
    cost: '真实调用按量计费',
    inputs: ['月份', '经营重点', '渠道'],
    output: '月度日历 + 每日主题 + 推荐发布时间',
  },
  {
    key: 'bench',
    title: '竞品盯梢',
    short: '看懂对手动作',
    description: '记录最多 8 个对标门店，整理价格、产品、口碑和活动变化，标出可行动的空白。',
    icon: <EyeOutlined />,
    accent: '#755db9',
    employee: '钱商圈',
    employeeIdx: 102,
    cost: '真实调用按量计费',
    inputs: ['对标门店', '观察周期', '关注主题'],
    output: '变化清单 + 机会空白 + 不建议跟随项',
  },
  {
    key: 'warm',
    title: '起号军师',
    short: '30天冷启动',
    description: '把门店定位、老板人设和平台机制转成 30 天账号冷启动路线，而不是堆选题。',
    icon: <RocketOutlined />,
    accent: '#d98b2b',
    employee: '苏种草',
    employeeIdx: 142,
    cost: '真实调用按量计费',
    inputs: ['平台', '门店定位', '老板人设'],
    output: '30天节奏 + 内容支柱 + 每周验收指标',
  },
  {
    key: 'leads',
    title: '线索雷达',
    short: '发现本地需求',
    description: '从求推荐、吐槽、攻略和比价等公开信号中，整理值得人工核验的本地需求与承接话术。',
    icon: <RadarChartOutlined />,
    accent: '#cb4e72',
    employee: '潘口碑',
    employeeIdx: 143,
    cost: '真实调用按量计费',
    inputs: ['城市/商圈', '产品', '目标客群'],
    output: '信号清单 + 核验提示 + 评论/私信承接话术',
  },
  {
    key: 'shot',
    title: '产品图文',
    short: '真实产品主图',
    description:
      '围绕一道菜或一款套餐调用真实图片模型生成产品主图，菜名/价格/门店名由系统矢量叠字保证逐字准确，并形成多渠道可核验文案。',
    icon: <CameraOutlined />,
    accent: '#2784c7',
    employee: '章文案',
    employeeIdx: 140,
    cost: '真实调用按量计费（叠字不计费）',
    inputs: ['产品信息', '真实卖点', '使用渠道', '海报文字（可选）'],
    output: '可预览产品主图（含精确叠字） + 多平台文案 + 发布核验表',
  },
  {
    key: 'menu-copy',
    title: '看图写卖点',
    short: '识图生成五类文案',
    description: '选择文件中心图片或上传一张产品/菜品照，由真实视觉模型识别产品并生成多渠道文案。',
    icon: <FileImageOutlined />,
    accent: '#b45f3b',
    employee: '章文案',
    employeeIdx: 140,
    cost: '真实视觉调用按量计费',
    inputs: ['PNG/JPEG/WebP图片（≤8MB）', '文案诉求'],
    output: '识别结果 + 一句话卖点 + 详情描述 + 小红书文案 + 价格话术',
  },
  {
    key: 'imagehunt',
    title: '联网搜图',
    short: '搜候选、核版权、入素材库',
    description: '从多路公开图片搜索中找到候选，通过安全缩略图代理预览；只有人工确认授权后才进入内容素材库。',
    icon: <SearchOutlined />,
    accent: '#507c55',
    employee: '多媒体设计',
    employeeIdx: 5,
    employeeDomain: 'content',
    cost: '公开搜图与素材导入不扣积分',
    inputs: ['画面关键词', '授权或许可类型', '署名要求'],
    output: '安全预览候选 + 版权台账 + 租户素材记录',
  },
  {
    key: 'link-script',
    title: '链接转口播稿',
    short: '爆款链接变真人口播',
    description:
      '先从公开视频或公开网页取得可核验正文，正文不足时再隔离搜索并受控取证，最后由真实模型改写成可直接试读的结构化口播稿。',
    icon: <LinkOutlined />,
    accent: '#7a5d9b',
    employee: '章文案',
    employeeIdx: 140,
    cost: '真实转录/模型调用按量计费',
    inputs: ['公开链接', '目标时长', '表达风格与人设'],
    output: '3秒钩子 + 完整口播 + 核心信息点 + 来源快照',
  },
  {
    key: 'vars',
    title: '口播矩阵',
    short: '一稿裂变多版',
    description: '把一条老板口播改成不同开头、节奏和行动指令，保持事实一致但不机械换词。',
    icon: <SoundOutlined />,
    accent: '#247b9b',
    employee: '章文案',
    employeeIdx: 140,
    cost: '真实调用按量计费',
    inputs: ['原始口播', '裂变数量', '目标平台'],
    output: '2-6版口播 + 镜头建议 + 风险检查',
  },
];

const toolByKey = (key: string | null) => TOOLS.find(tool => tool.key === key) || TOOLS[0];

export default function Toolbox() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [activeKey, setActiveKey] = useState(() => toolByKey(params.get('tool')).key);
  const [runs, setRuns] = useState<ToolRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [running, setRunning] = useState(false);
  const [exportingFeishuRunId, setExportingFeishuRunId] = useState<number | null>(null);
  const [viewRun, setViewRun] = useState<ToolRun | null>(null);
  const [pcalEditing, setPcalEditing] = useState(false);
  const [pcalSaving, setPcalSaving] = useState(false);
  const [pcalDraft, setPcalDraft] = useState<NonNullable<ToolRun['pcalCalendar']>['days']>([]);
  const [menuCopyImages, setMenuCopyImages] = useState<MenuCopyImage[]>([]);
  const [menuCopyImagesLoading, setMenuCopyImagesLoading] = useState(false);
  const [menuCopyUploadName, setMenuCopyUploadName] = useState('');
  const [automationConfigs, setAutomationConfigs] = useState<
    Partial<Record<ToolboxAutomationKey, ToolboxAutomationConfig>>
  >({});
  const [automationLoading, setAutomationLoading] = useState(true);
  const [automationError, setAutomationError] = useState('');
  const [automationSavingKey, setAutomationSavingKey] = useState<ToolboxAutomationKey | null>(null);
  const [automationRunningKey, setAutomationRunningKey] = useState<ToolboxAutomationKey | null>(null);
  const [benchTargetsDraft, setBenchTargetsDraft] = useState('');
  const menuCopyFileRef = useRef<HTMLInputElement>(null);
  const [form] = Form.useForm();
  const active = useMemo(() => toolByKey(activeKey), [activeKey]);
  const requestedTool = params.get('tool');
  const textVideoStudioOpen = params.get('studio') === 'text-video';

  const loadAutomations = useCallback(async (quiet = false) => {
    if (!quiet) setAutomationLoading(true);
    try {
      const response = await api.get('/toolbox/automations', { silent: true });
      const configs = Array.isArray(response?.configs) ? response.configs : [];
      const next = Object.fromEntries(
        configs.map((config: ToolboxAutomationConfig) => [config.key, config]),
      ) as Partial<Record<ToolboxAutomationKey, ToolboxAutomationConfig>>;
      setAutomationConfigs(next);
      setBenchTargetsDraft(targetDraft(next.bench_weekly?.targets));
      setAutomationError('');
    } catch (error) {
      setAutomationError(error instanceof Error ? error.message : '自动化配置加载失败');
    } finally {
      if (!quiet) setAutomationLoading(false);
    }
  }, []);

  const loadRuns = useCallback(
    (quiet = false) => {
      if (!quiet) setLoadingRuns(true);
      api
        .get('/toolbox/runs?limit=20')
        .then((data: any) => {
          const nextRuns = Array.isArray(data) ? data : data.runs || [];
          setRuns(nextRuns);
          void loadAutomations(true);
          setViewRun(current => {
            if (!current) return null;
            return nextRuns.find((item: ToolRun) => item.id === current.id) || current;
          });
        })
        .catch(() => {
          // 读取失败保留已有列表，避免“像从没跑过一样”的空白闪断。
          if (!quiet) message.error('运行记录读取失败，可点“刷新”重试');
        })
        .finally(() => {
          if (!quiet) setLoadingRuns(false);
        });
    },
    [loadAutomations],
  );

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void loadRuns();
        void loadAutomations();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadAutomations, loadRuns]);

  const hasActiveRuns = runs.some(runIsActive);
  useEffect(() => {
    if (!hasActiveRuns) return undefined;
    const timer = window.setInterval(() => void loadRuns(true), 2_000);
    return () => window.clearInterval(timer);
  }, [hasActiveRuns, loadRuns]);

  useEffect(() => {
    const nextKey = toolByKey(requestedTool).key;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setActiveKey(current => (current === nextKey ? current : nextKey));
    });
    return () => {
      cancelled = true;
    };
  }, [requestedTool]);

  useEffect(() => {
    form.resetFields();
    const now = new Date();
    const localMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    form.setFieldsValue({
      channels: ['朋友圈'],
      platform: '视频号',
      variants: 3,
      ...(activeKey === 'pcal' ? { month: localMonth } : {}),
      ...(activeKey === 'bench' ? { period: '近7天' } : {}),
      ...(activeKey === 'link-script' ? { duration: 30 } : {}),
    });
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setMenuCopyUploadName('');
    });
    return () => {
      cancelled = true;
    };
  }, [activeKey, form]);

  const loadMenuCopyImages = useCallback(async () => {
    setMenuCopyImagesLoading(true);
    try {
      const rows = await api.get('/files?limit=100', { silent: true });
      const images = (Array.isArray(rows) ? rows : []).filter((file: MenuCopyImage) => {
        const ext = String(file.ext || '').toLowerCase();
        return (
          ['png', 'jpg', 'jpeg', 'webp'].includes(ext) &&
          Number(file.size || 0) > 0 &&
          Number(file.size) <= 8 * 1024 * 1024
        );
      });
      setMenuCopyImages(images);
    } catch {
      setMenuCopyImages([]);
    } finally {
      setMenuCopyImagesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeKey !== 'menu-copy') return undefined;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadMenuCopyImages();
    });
    return () => {
      cancelled = true;
    };
  }, [activeKey, loadMenuCopyImages]);

  const pickMenuCopyImage = (selected: FileList | null) => {
    const file = selected?.[0];
    if (!file) return;
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!allowed.has(file.type) || file.size <= 0 || file.size > 8 * 1024 * 1024) {
      message.error('仅支持 PNG、JPEG 或 WebP 图片，且文件不超过8MB');
      if (menuCopyFileRef.current) menuCopyFileRef.current.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => message.error('读取图片失败，请重新选择');
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      form.setFieldsValue({ imageFileId: undefined, imageDataUrl: dataUrl });
      setMenuCopyUploadName(file.name);
      if (menuCopyFileRef.current) menuCopyFileRef.current.value = '';
      void form.validateFields(['imageFileId']).catch(() => undefined);
    };
    reader.readAsDataURL(file);
  };

  const chooseTool = (key: string) => {
    setActiveKey(key);
    const next = new URLSearchParams(params);
    next.set('tool', key);
    next.delete('studio');
    next.delete('jobId');
    setParams(next, { replace: true });
  };

  const openTextVideoStudio = () => {
    setViewRun(null);
    const next = new URLSearchParams(params);
    next.set('studio', 'text-video');
    next.delete('tool');
    setParams(next, { replace: true });
  };

  const runTool = async () => {
    let values;
    try {
      values = await form.validateFields();
    } catch {
      message.warning('请先补全带提示的必填输入');
      return;
    }
    setRunning(true);
    try {
      const response = await api.post('/toolbox/runs', {
        toolKey: active.key,
        employeeIdx: active.employeeIdx,
        title: values.title || `${active.title} · ${new Date().toLocaleDateString('zh-CN')}`,
        inputs: values,
      });
      const run = response.run || response;
      setRuns(current => [run, ...current.filter(item => item.id !== run.id)]);
      setViewRun(run);
      const notice = response.message || `${active.title}已进入后台任务，可关闭页面后到任务中心查看进度`;
      if (runIsActive(run) || response.queued) message.info(notice);
      else if (run.canUse) message.success(notice);
      else message.warning(notice);
    } catch {
      // API 客户端已展示服务端错误；输入保留，方便修正后重跑。
    } finally {
      setRunning(false);
    }
  };

  const retryRun = async (run: ToolRun) => {
    setRunning(true);
    try {
      const response = await api.post(`/toolbox/runs/${run.id}/retry`, {});
      const nextRun = response.run || response;
      setRuns(current => [nextRun, ...current.filter(item => item.id !== nextRun.id)]);
      setViewRun(nextRun);
      message.info(response.message || '免费重试已进入后台，失败轮次不会实扣');
    } finally {
      setRunning(false);
    }
  };

  const exportPcalToFeishu = async (run: ToolRun) => {
    setExportingFeishuRunId(run.id);
    try {
      const response = await api.post(`/toolbox/runs/${run.id}/feishu`, {});
      const feishuExport = response.feishuExport;
      setRuns(current => current.map(item => (item.id === run.id ? { ...item, feishuExport } : item)));
      setViewRun(current => (current?.id === run.id ? { ...current, feishuExport } : current));
      message.success(
        response.idempotent
          ? `该日历已同步到${feishuExport?.table || '飞书多维表格'}`
          : `已同步 ${feishuExport?.synced || 0} 条到${feishuExport?.table || '飞书多维表格'}`,
      );
    } catch {
      await loadRuns(true);
    } finally {
      setExportingFeishuRunId(null);
    }
  };

  const openPcalEditor = (run: ToolRun) => {
    setPcalDraft((run.pcalCalendar?.days || []).map(day => ({ ...day })));
    setPcalEditing(true);
  };

  const patchPcalDraft = (date: string, field: 'moment' | 'group', value: string) => {
    setPcalDraft(current => current.map(day => (day.date === date ? { ...day, [field]: value } : day)));
  };

  const savePcalEdits = async (run: ToolRun) => {
    setPcalSaving(true);
    try {
      const response = await api.put(`/toolbox/runs/${run.id}/pcal`, {
        expectedVersion: run.pcalEditVersion || 0,
        days: pcalDraft.map(day => ({ date: day.date, moment: day.moment, group: day.group })),
      });
      const nextRun = response.run as ToolRun;
      setRuns(current => current.map(item => (item.id === nextRun.id ? nextRun : item)));
      setViewRun(nextRun);
      setPcalDraft((nextRun.pcalCalendar?.days || []).map(day => ({ ...day })));
      setPcalEditing(false);
      message.success(response.idempotent ? '日历内容没有变化' : '日历已保存；本次编辑不联网、不扣积分');
    } finally {
      setPcalSaving(false);
    }
  };

  const patchAutomationConfig = (key: ToolboxAutomationKey, patch: Partial<ToolboxAutomationConfig>) => {
    setAutomationConfigs(current => {
      const existing = current[key];
      if (!existing) return current;
      return { ...current, [key]: { ...existing, ...patch } };
    });
  };

  const persistAutomationConfig = async (
    key: ToolboxAutomationKey,
    draft: ToolboxAutomationConfig,
    announce = true,
  ) => {
    const targetLineCount = benchTargetsDraft
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(Boolean).length;
    if (key === 'bench_weekly' && targetLineCount > 8) {
      message.warning('对标账号最多保存8个，请删减后重试');
      return null;
    }
    const targets = key === 'bench_weekly' ? parseTargetDraft(benchTargetsDraft) : [];
    if (key === 'bench_weekly' && draft.enabled && targets.length === 0) {
      message.warning('先填写至少一个对标账号，再启用每周盯梢');
      return null;
    }
    const payload =
      key === 'hot_daily'
        ? {
            enabled: draft.enabled,
            industry: draft.industry || '通用',
            channels: draft.channels || [],
          }
        : {
            enabled: draft.enabled,
            targets,
          };
    setAutomationSavingKey(key);
    try {
      const response = await api.put(`/toolbox/automations/${key}`, payload);
      const saved = response.config as ToolboxAutomationConfig;
      setAutomationConfigs(current => ({ ...current, [key]: saved }));
      if (key === 'bench_weekly') setBenchTargetsDraft(targetDraft(saved.targets));
      setAutomationError('');
      if (announce) message.success(`${saved.label}自动化配置已保存`);
      return saved;
    } catch (error) {
      setAutomationError(error instanceof Error ? error.message : '自动化配置保存失败');
      return null;
    } finally {
      setAutomationSavingKey(null);
    }
  };

  const toggleAutomation = async (key: ToolboxAutomationKey, enabled: boolean) => {
    const current = automationConfigs[key];
    if (!current) return;
    const draft = { ...current, enabled };
    patchAutomationConfig(key, { enabled });
    const saved = await persistAutomationConfig(key, draft, false);
    if (!saved) {
      patchAutomationConfig(key, { enabled: current.enabled });
      return;
    }
    message.success(`${saved.label}${saved.enabled ? '已启用' : '已暂停'}`);
  };

  const runAutomationNow = async (key: ToolboxAutomationKey) => {
    const current = automationConfigs[key];
    if (!current) return;
    setAutomationRunningKey(key);
    try {
      const saved = await persistAutomationConfig(key, current, false);
      if (!saved) return;
      const response = await api.post(`/toolbox/automations/${key}/run-now`, {});
      message.info(response.message || `${saved.label}已进入真实工具后台链`);
      await Promise.all([loadRuns(true), loadAutomations(true)]);
    } catch {
      await loadAutomations(true);
    } finally {
      setAutomationRunningKey(null);
    }
  };

  const fields = (() => {
    if (active.key === 'hot')
      return (
        <>
          <Form.Item name="store" label="门店 / 品类" rules={[{ required: true, message: '请填写门店或品类' }]}>
            <Input placeholder="例：某商圈川味小馆" />
          </Form.Item>
          <Form.Item name="channels" label="发布渠道" rules={[{ required: true }]}>
            <Select
              mode="multiple"
              options={['朋友圈', '小红书', '抖音', '视频号', '社群'].map(value => ({ value, label: value }))}
            />
          </Form.Item>
          <Form.Item
            name="focus"
            label="今天最想推动什么"
            rules={[{ required: true, message: '请说明今天的经营重点' }]}
          >
            <Input.TextArea rows={4} placeholder="例：晚市工作日上座不足，想推两人套餐，但不能做虚假限量" />
          </Form.Item>
        </>
      );
    if (active.key === 'remix')
      return (
        <>
          <Form.Item name="materials" label="手机素材说明" rules={[{ required: true, message: '请说明现有素材' }]}>
            <Input.TextArea rows={4} placeholder="例：后厨出锅3段、顾客夹菜2段、门头夜景1段；每段约5秒" />
          </Form.Item>
          <Form.Item name="platform" label="目标平台">
            <Select options={['抖音', '视频号', '小红书', '快手'].map(value => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item name="goal" label="成片目的" rules={[{ required: true }]}>
            <Input placeholder="例：让附近3公里顾客周末来吃招牌菜" />
          </Form.Item>
        </>
      );
    if (active.key === 'pcal')
      return (
        <>
          <Form.Item name="month" label="计划月份" rules={[{ required: true }]}>
            <Input placeholder="例：2026-08" />
          </Form.Item>
          <Form.Item name="channels" label="经营渠道">
            <Select
              mode="multiple"
              options={['朋友圈', '社群', '视频号', '小红书'].map(value => ({ value, label: value }))}
            />
          </Form.Item>
          <Form.Item name="focus" label="本月经营重点" rules={[{ required: true }]}>
            <Input.TextArea rows={4} placeholder="例：新菜单上线、老会员回店、工作日午市提升" />
          </Form.Item>
        </>
      );
    if (active.key === 'bench')
      return (
        <>
          <Form.Item name="targets" label="对标门店（每行一个）" rules={[{ required: true }]}>
            <Input.TextArea rows={5} placeholder={'门店A / 账号链接\n门店B / 地址\n最多8个'} />
          </Form.Item>
          <Form.Item name="period" label="观察周期">
            <Select options={['近7天', '近30天', '本季度'].map(value => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item name="focus" label="最关心什么">
            <Input placeholder="例：套餐价格、差评变化、夜宵活动" />
          </Form.Item>
        </>
      );
    if (active.key === 'warm')
      return (
        <>
          <Form.Item name="platform" label="主阵地平台">
            <Select options={['视频号', '抖音', '小红书', '快手'].map(value => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item name="positioning" label="门店定位" rules={[{ required: true }]}>
            <Input placeholder="例：社区型云南米线，客单28元，午餐为主" />
          </Form.Item>
          <Form.Item name="persona" label="老板人设">
            <Input placeholder="例：认真研究汤底的80后店主，说话朴实" />
          </Form.Item>
          <Form.Item name="goal" label="30天目标">
            <Input placeholder="例：验证3个稳定选题方向，带来20个到店核销" />
          </Form.Item>
        </>
      );
    if (active.key === 'leads')
      return (
        <>
          <Form.Item name="city" label="城市 / 商圈" rules={[{ required: true }]}>
            <Input placeholder="例：门店周边3公里" />
          </Form.Item>
          <Form.Item name="product" label="门店产品" rules={[{ required: true }]}>
            <Input placeholder="例：粤菜家庭聚餐、客单120元" />
          </Form.Item>
          <Form.Item name="audience" label="目标客群">
            <Input placeholder="例：周末家庭聚餐、公司小型宴请" />
          </Form.Item>
          <Form.Item name="constraints" label="核验与合规约束">
            <Input.TextArea rows={3} placeholder="只使用公开信号；不抓取个人联系方式；最终由人工核验" />
          </Form.Item>
        </>
      );
    if (active.key === 'shot')
      return (
        <>
          <Form.Item name="product" label="产品 / 套餐" rules={[{ required: true }]}>
            <Input placeholder="例：双人酸汤鱼套餐 168元" />
          </Form.Item>
          <Form.Item name="facts" label="可核验的真实卖点" rules={[{ required: true }]}>
            <Input.TextArea rows={4} placeholder="食材、份量、工艺、适合场景；不要写未经证实的第一、最好、零添加" />
          </Form.Item>
          <Form.Item name="channels" label="使用渠道">
            <Select
              mode="multiple"
              options={['外卖平台', '朋友圈', '小红书', '门店桌卡'].map(value => ({ value, label: value }))}
            />
          </Form.Item>
          <Form.Item
            name="overlayTitle"
            label="海报菜名（精确叠字，可选）"
            tooltip="填写后由系统以矢量文字叠加到主图上，逐字与输入一致，不经图像模型，不额外计费"
            normalize={value => (typeof value === 'string' && !value.trim() ? undefined : value)}
            rules={[{ max: 60, message: '最多60字' }]}
          >
            <Input placeholder="例：招牌酸汤鱼双人套餐" />
          </Form.Item>
          <Form.Item
            name="overlayPrice"
            label="海报价格（精确叠字，可选）"
            normalize={value => (typeof value === 'string' && !value.trim() ? undefined : value)}
            rules={[{ max: 30, message: '最多30字' }]}
          >
            <Input placeholder="例：¥168 / 双人" />
          </Form.Item>
          <Form.Item
            name="overlayStore"
            label="海报门店名（精确叠字，可选）"
            normalize={value => (typeof value === 'string' && !value.trim() ? undefined : value)}
            rules={[{ max: 60, message: '最多60字' }]}
          >
            <Input placeholder="例：老王家酸汤鱼·朝阳大悦城店" />
          </Form.Item>
        </>
      );
    if (active.key === 'menu-copy')
      return (
        <>
          <Form.Item name="imageDataUrl" hidden>
            <Input />
          </Form.Item>
          <Form.Item
            name="imageFileId"
            label="产品 / 菜品图片"
            rules={[
              {
                validator: async (_, value) => {
                  if (value || form.getFieldValue('imageDataUrl')) return;
                  throw new Error('请从文件中心选择图片，或直接上传一张图片');
                },
              },
            ]}
          >
            <Select
              allowClear
              showSearch
              loading={menuCopyImagesLoading}
              placeholder="选择已上传的图片（显示文件ID）"
              optionFilterProp="label"
              options={menuCopyImages.map(file => ({
                value: file.id,
                label: `#${file.id} · ${file.name}`,
              }))}
              onChange={value => {
                if (value) {
                  form.setFieldValue('imageDataUrl', undefined);
                  setMenuCopyUploadName('');
                }
              }}
            />
          </Form.Item>
          <div className="toolbox-submit-row">
            <span>
              {menuCopyUploadName
                ? `已选本地图片：${menuCopyUploadName}`
                : '文件中心没有合适图片时，可直接上传；后台会安全转成文件ID'}
            </span>
            <div>
              <input
                ref={menuCopyFileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={event => pickMenuCopyImage(event.target.files)}
              />
              <Button icon={<FolderOpenOutlined />} onClick={() => void loadMenuCopyImages()}>
                刷新文件中心
              </Button>{' '}
              <Button icon={<UploadOutlined />} onClick={() => menuCopyFileRef.current?.click()}>
                直接上传
              </Button>
            </div>
          </div>
          <Form.Item name="want" label="文案诉求">
            <Input.TextArea
              rows={4}
              maxLength={500}
              showCount
              placeholder="例：写外卖平台菜品描述，口感写得有画面感，但不要编造配料、份量和功效"
            />
          </Form.Item>
        </>
      );
    if (active.key === 'link-script')
      return (
        <>
          <Form.Item
            name="url"
            label="公开视频 / 文章链接"
            rules={[
              { required: true, message: '请粘贴公开链接或含链接的分享文字' },
              { max: 4000, message: '分享文字最多4000个字符' },
            ]}
          >
            <Input.TextArea
              rows={3}
              placeholder="可粘贴抖音、快手、B站、小红书等公开分享链接，或含 http/https 链接的整段分享文字"
            />
          </Form.Item>
          <Form.Item name="duration" label="目标口播时长" rules={[{ required: true }]}>
            <Select options={[15, 30, 60, 90, 120].map(value => ({ value, label: `${value} 秒` }))} />
          </Form.Item>
          <Form.Item name="style" label="表达风格">
            <Input maxLength={200} showCount placeholder="例：真实克制、老板亲自分享、少用营销腔" />
          </Form.Item>
          <Form.Item name="persona" label="出镜人设">
            <Input.TextArea
              rows={3}
              maxLength={1000}
              showCount
              placeholder="例：做了十年餐饮的店主，说话直接、有经验，但不夸大"
            />
          </Form.Item>
          <Form.Item name="goal" label="这条口播要推动什么">
            <Input.TextArea
              rows={3}
              maxLength={1000}
              showCount
              placeholder="例：让附近顾客理解这道产品适合什么场景，并愿意留言咨询"
            />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            message="内网、本机、带账号凭据、敏感令牌或异常编码的链接会在预授权前拒绝；私密或无法取证的内容不会生成本地替代稿。"
          />
        </>
      );
    return (
      <>
        <Form.Item
          name="script"
          label="原始口播"
          rules={[{ required: true, min: 20, message: '请粘贴至少20个字的原稿' }]}
        >
          <Input.TextArea rows={7} placeholder="粘贴老板原话，系统只在事实不变的前提下改开头、节奏与行动指令" />
        </Form.Item>
        <Form.Item name="variants" label="裂变数量">
          <Select options={[2, 3, 4, 5, 6].map(value => ({ value, label: `${value} 版` }))} />
        </Form.Item>
        <Form.Item name="platform" label="目标平台">
          <Select options={['视频号', '抖音', '小红书', '快手'].map(value => ({ value, label: value }))} />
        </Form.Item>
      </>
    );
  })();

  const automationKey = automationKeyForTool(active.key);
  const automationConfig = automationKey ? automationConfigs[automationKey] : null;
  const automationPanel = automationKey ? (
    <section className="toolbox-automation" aria-labelledby="toolbox-automation-title">
      <div className="toolbox-automation-head">
        <div>
          <strong id="toolbox-automation-title">自动执行</strong>
          <span>{automationConfig?.schedule || '上海时区定时任务'}</span>
        </div>
        {automationConfig && (
          <div className="toolbox-automation-switch">
            <span>{automationConfig.enabled ? '已启用' : '已暂停'}</span>
            <Switch
              checked={automationConfig.enabled}
              loading={automationSavingKey === automationKey}
              disabled={automationRunningKey === automationKey}
              aria-label={`${automationConfig.label}自动执行开关`}
              onChange={enabled => void toggleAutomation(automationKey, enabled)}
            />
          </div>
        )}
      </div>

      {automationError && (
        <Alert
          type="error"
          showIcon
          message="自动化配置暂时不可用"
          description={automationError}
          action={
            <Button size="small" onClick={() => void loadAutomations()}>
              重新加载
            </Button>
          }
        />
      )}

      {automationLoading && !automationConfig ? (
        <Skeleton active paragraph={{ rows: 2 }} title={false} />
      ) : automationConfig ? (
        <>
          {automationKey === 'hot_daily' ? (
            <div className="toolbox-automation-fields">
              <div className="toolbox-automation-field">
                <span id="toolbox-automation-industry-label">行业 / 品类</span>
                <Input
                  id="toolbox-automation-industry"
                  aria-labelledby="toolbox-automation-industry-label"
                  value={automationConfig.industry || ''}
                  maxLength={20}
                  placeholder="例：餐饮·川湘菜"
                  onChange={event => patchAutomationConfig(automationKey, { industry: event.target.value })}
                />
              </div>
              <div className="toolbox-automation-field">
                <span id="toolbox-automation-channels-label">每日扫描渠道（最多10个）</span>
                <Select
                  id="toolbox-automation-channels"
                  aria-labelledby="toolbox-automation-channels-label"
                  mode="multiple"
                  value={automationConfig.channels || []}
                  maxTagCount="responsive"
                  options={HOT_AUTOMATION_CHANNELS.map(value => ({ value, label: value }))}
                  onChange={channels => patchAutomationConfig(automationKey, { channels: channels.slice(0, 10) })}
                />
              </div>
            </div>
          ) : (
            <div className="toolbox-automation-fields">
              <div className="toolbox-automation-field">
                <span id="toolbox-automation-targets-label">对标账号 / 品牌（每行一个，最多8个）</span>
                <Input.TextArea
                  id="toolbox-automation-targets"
                  aria-labelledby="toolbox-automation-targets-label"
                  rows={4}
                  value={benchTargetsDraft}
                  maxLength={1000}
                  placeholder={'品牌名 | 抖音 | 关注新品\n对标门店 | 小红书 | 关注活动'}
                  onChange={event => setBenchTargetsDraft(event.target.value)}
                />
              </div>
            </div>
          )}

          {automationConfig.note && <Alert type="warning" showIcon message={automationConfig.note} />}
          <div className="toolbox-automation-actions">
            <span>
              {automationConfig.lastSuccessAt
                ? `上次成功：${String(automationConfig.lastSuccessAt).replace('T', ' ').slice(0, 16)}`
                : '尚未自动产生过结果'}
            </span>
            <div>
              <Button
                loading={automationSavingKey === automationKey}
                disabled={automationRunningKey === automationKey}
                onClick={() => void persistAutomationConfig(automationKey, automationConfig)}
              >
                保存配置
              </Button>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={automationRunningKey === automationKey}
                disabled={automationSavingKey === automationKey}
                onClick={() => void runAutomationNow(automationKey)}
              >
                立即运行一次
              </Button>
            </div>
          </div>
          <small className="toolbox-automation-boundary">
            立即运行与定时运行共用同一条真实工具、检索、模型与计费链；失败会释放预授权，不会生成降级底稿。
          </small>
        </>
      ) : null}
    </section>
  ) : null;

  return (
    <div className="toolbox-page">
      <header className="toolbox-hero">
        <div>
          <div className="toolbox-kicker">
            <ToolOutlined /> 经营工具箱
          </div>
          <h1>老板常用的活，不必每次从空白开始</h1>
          <p>
            {TOOLS.length + 1} 个高频经营工具，把老板的输入变成可执行的结构化产物。已配置 AI
            与联网能力时由对应数字员工真实执行并按实际用量结算；真实通道不可用时任务会失败、释放预授权，不生成本地底稿冒充结果。
          </p>
        </div>
        <div className="toolbox-flow" aria-label="工具闭环">
          <span>经营问题</span>
          <b>→</b>
          <span>选择工具</span>
          <b>→</b>
          <span>员工执行</span>
          <b>→</b>
          <span>结果回流</span>
        </div>
      </header>

      <div className={`toolbox-layout${textVideoStudioOpen ? ' toolbox-layout--studio' : ''}`}>
        <nav className="toolbox-nav" aria-label="工具列表">
          <div className="toolbox-nav-title">
            全部工具 <span>{TOOLS.length + 1}</span>
          </div>
          <button className={textVideoStudioOpen ? 'active' : ''} onClick={openTextVideoStudio}>
            <i style={{ '--tool-color': 'var(--ui-primary)' } as CSSProperties}>
              <VideoCameraOutlined />
            </i>
            <span>
              <strong>图文素材成片</strong>
              <small>真实配音·竖屏MP4</small>
            </span>
            <em>›</em>
          </button>
          {TOOLS.map(tool => (
            <button
              key={tool.key}
              className={!textVideoStudioOpen && active.key === tool.key ? 'active' : ''}
              onClick={() => chooseTool(tool.key)}
            >
              <i style={{ '--tool-color': tool.accent } as CSSProperties}>{tool.icon}</i>
              <span>
                <strong>{tool.title}</strong>
                <small>{tool.short}</small>
              </span>
              <em>›</em>
            </button>
          ))}
        </nav>

        <main className={`toolbox-workbench${textVideoStudioOpen ? ' toolbox-workbench--studio' : ''}`}>
          {textVideoStudioOpen ? (
            <TextVideoStudio />
          ) : (
            <>
              <div className="toolbox-active-head">
                <div className="toolbox-active-icon" style={{ '--tool-color': active.accent } as CSSProperties}>
                  {active.icon}
                </div>
                <div>
                  <div className="toolbox-active-kicker">{active.short}</div>
                  <h2>{active.title}</h2>
                  <p>{active.description}</p>
                </div>
              </div>
              {active.key === 'imagehunt' ? (
                <ImageHuntPanel />
              ) : (
                <>
                  <div className="toolbox-contract">
                    <div>
                      <span>执行员工</span>
                      <strong>{active.employee}</strong>
                      <small>
                        {active.employeeDomain === 'content' ? '内容数字员工' : '餐饮数字员工'} #{active.employeeIdx}
                      </small>
                    </div>
                    <div>
                      <span>你需要准备</span>
                      <strong>{active.inputs.join(' · ')}</strong>
                      <small>公开信息由工具联网补齐；内部材料可选</small>
                    </div>
                    <div>
                      <span>最终交付</span>
                      <strong>{active.output}</strong>
                      <small>自动保存到工具运行记录</small>
                    </div>
                  </div>
                  {automationPanel}
                  <Form form={form} layout="vertical" requiredMark={false} className="toolbox-form">
                    {fields}
                    <Alert
                      type="warning"
                      showIcon
                      message="工具结果是经营建议，不会自动发布、改价、采购、排班或处罚员工；关键动作需要老板确认。"
                    />
                    <div className="toolbox-submit-row">
                      <span>{active.cost} · 真实通道失败会自动退款，不生成降级底稿</span>
                      <Button
                        type="primary"
                        size="large"
                        icon={<ThunderboltOutlined />}
                        loading={running}
                        onClick={runTool}
                      >
                        开始运行
                      </Button>
                    </div>
                  </Form>
                </>
              )}
            </>
          )}
        </main>

        {!textVideoStudioOpen && (
          <aside className="toolbox-runs">
            <div className="toolbox-runs-head">
              <div>
                <strong>最近运行</strong>
                <span>关页不丢，结果可回看</span>
              </div>
              <Button type="link" size="small" onClick={() => loadRuns()}>
                刷新
              </Button>
            </div>
            {loadingRuns ? (
              <Skeleton active paragraph={{ rows: 8 }} />
            ) : runs.length ? (
              <List
                dataSource={runs}
                renderItem={run => {
                  const tool = toolByKey(run.toolKey);
                  return (
                    <List.Item onClick={() => setViewRun(run)}>
                      <div className="tool-run-icon" style={{ '--tool-color': tool.accent } as CSSProperties}>
                        {tool.icon}
                      </div>
                      <div className="tool-run-main">
                        <strong>{run.title || tool.title}</strong>
                        <span>
                          {run.employeeName || tool.employee} ·{' '}
                          {String(run.createdAt || '')
                            .replace('T', ' ')
                            .slice(0, 16)}
                        </span>
                      </div>
                      <Tag color={runStatusColor(run)}>{runDisplayStatus(run)}</Tag>
                    </List.Item>
                  );
                }}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有运行记录" />
            )}
          </aside>
        )}
      </div>

      <Drawer
        width={720}
        open={!!viewRun}
        onClose={() => {
          setViewRun(null);
          setPcalEditing(false);
          setPcalDraft([]);
        }}
        title={
          viewRun ? (
            <div className="tool-result-title">
              <span>{toolByKey(viewRun.toolKey).icon}</span>
              <div>
                <strong>{viewRun.title}</strong>
                <small>
                  {viewRun.employeeName || toolByKey(viewRun.toolKey).employee} · 运行 #{viewRun.id}
                </small>
              </div>
            </div>
          ) : null
        }
      >
        {viewRun && (
          <div className="tool-result">
            <Alert
              type={viewRun.canUse ? 'success' : runIsActive(viewRun) ? 'info' : 'warning'}
              showIcon
              message={runDisplayStatus(viewRun)}
              description={
                viewRun.nextAction ||
                (viewRun.canUse ? '请继续核对证据和关键结论。' : '请补充材料或调整输入后重新运行。')
              }
            />
            <div className="toolbox-submit-row">
              <Button onClick={() => navigate(viewRun.deepLink || `/tasks?kind=tool&id=${viewRun.id}`)}>
                在任务中心查看
              </Button>
              {viewRun.toolKey === 'pcal' && viewRun.canUse && viewRun.pcalCalendar && (
                <Button onClick={() => (pcalEditing ? setPcalEditing(false) : openPcalEditor(viewRun))}>
                  {pcalEditing ? '收起日历编辑' : '编辑朋友圈/社群话术'}
                </Button>
              )}
              {viewRun.toolKey === 'pcal' && viewRun.canUse && (
                <Button
                  type={
                    viewRun.feishuExport?.status === 'done' && !viewRun.feishuExport?.outdated ? 'default' : 'primary'
                  }
                  icon={<ExportOutlined />}
                  loading={exportingFeishuRunId === viewRun.id || viewRun.feishuExport?.status === 'syncing'}
                  onClick={() => exportPcalToFeishu(viewRun)}
                >
                  {viewRun.feishuExport?.outdated
                    ? '日历已更新，重新同步飞书'
                    : viewRun.feishuExport?.status === 'done'
                      ? `已同步飞书（${viewRun.feishuExport.synced || 0}条）`
                      : viewRun.feishuExport?.status === 'failed'
                        ? '重试同步飞书多维表格'
                        : '同步到飞书多维表格'}
                </Button>
              )}
              {viewRun.retryable && (
                <Button type="primary" loading={running} onClick={() => retryRun(viewRun)}>
                  免费重试（剩余 {viewRun.freeRetriesRemaining ?? 0} 次）
                </Button>
              )}
            </div>
            {viewRun.toolKey === 'pcal' && pcalEditing && viewRun.pcalCalendar && (
              <section className="pcal-editor" aria-label="私域日历逐日编辑">
                <div className="pcal-editor-head">
                  <div>
                    <strong>{viewRun.pcalCalendar.month} 私域日历</strong>
                    <span>只允许修改朋友圈文案和社群话术；日期、星期、节日保持原始结构。</span>
                  </div>
                  <Button type="primary" loading={pcalSaving} onClick={() => void savePcalEdits(viewRun)}>
                    保存编辑
                  </Button>
                </div>
                <div className="pcal-editor-days">
                  {pcalDraft.map(day => (
                    <article className="pcal-editor-day" key={day.date}>
                      <header>
                        <strong>{day.date}</strong>
                        <span>
                          {day.weekday}
                          {day.festival ? ` · ${day.festival}` : ''}
                        </span>
                      </header>
                      <div className="pcal-editor-field">
                        <span>朋友圈文案</span>
                        <Input.TextArea
                          aria-label={`${day.date}朋友圈文案`}
                          value={day.moment}
                          maxLength={1000}
                          autoSize={{ minRows: 2, maxRows: 6 }}
                          onChange={event => patchPcalDraft(day.date, 'moment', event.target.value)}
                        />
                      </div>
                      <div className="pcal-editor-field">
                        <span>社群话术</span>
                        <Input.TextArea
                          aria-label={`${day.date}社群话术`}
                          value={day.group}
                          maxLength={1000}
                          autoSize={{ minRows: 2, maxRows: 6 }}
                          onChange={event => patchPcalDraft(day.date, 'group', event.target.value)}
                        />
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}
            {viewRun.toolKey === 'pcal' && viewRun.feishuExport?.outdated && (
              <Alert
                type="warning"
                showIcon
                message="日历已有新编辑版本"
                description={`当前为日历 v${viewRun.pcalEditVersion || 0}，飞书中仍是 v${viewRun.feishuExport.calendarVersion || 0}；点击重新同步后才会更新飞书。`}
              />
            )}
            {viewRun.toolKey === 'pcal' &&
              viewRun.feishuExport?.status === 'done' &&
              !viewRun.feishuExport?.outdated && (
                <Alert
                  type="success"
                  showIcon
                  message={`飞书同步完成：${viewRun.feishuExport.table || '私域日历'}`}
                  description={`已写入 ${viewRun.feishuExport.synced || 0} 条；同一运行记录重复点击不会重复写入。`}
                />
              )}
            {viewRun.toolKey === 'pcal' && viewRun.feishuExport?.status === 'failed' && (
              <Alert
                type="error"
                showIcon
                message="上次飞书同步失败，本次未产生额外积分扣款"
                description={
                  viewRun.feishuExport.error?.message || '请检查企业飞书应用凭据、多维表格链接和应用权限后重试。'
                }
              />
            )}
            {viewRun.error?.message && (
              <Alert type="error" showIcon message={viewRun.error.message} description={viewRun.error.code || ''} />
            )}
            {!viewRun.canUse && !runIsActive(viewRun) && (viewRun.provenance?.contract?.errors?.length ?? 0) > 0 && (
              <Alert
                type="warning"
                showIcon
                message="差这些没过验收（本轮已退款，可免费重试）"
                description={
                  <ul className="tool-result-quality-gaps">
                    {(viewRun.provenance?.contract?.errors || []).slice(0, 12).map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                }
              />
            )}
            {runIsActive(viewRun) && (
              <section aria-label="实时执行进度">
                <h3>正在执行 · 本页自动刷新</h3>
                {viewRun.progress?.length ? (
                  <List
                    size="small"
                    dataSource={viewRun.progress}
                    renderItem={item => (
                      <List.Item>
                        <span>{item.message || item.phase || '任务执行中'}</span>
                        <small>
                          {String(item.at || '')
                            .replace('T', ' ')
                            .slice(0, 19)}
                        </small>
                      </List.Item>
                    )}
                  />
                ) : (
                  <Skeleton active paragraph={{ rows: 2 }} title={false} />
                )}
              </section>
            )}
            {(() => {
              const artifact = viewRun.provenance?.mediaArtifact;
              const mediaUrl = mediaArtifactPreviewUrl(artifact);
              if (!mediaUrl) return null;
              const isVideo = String(artifact?.kind || '') === 'video';
              return (
                <section className="tool-result-media" aria-label="真实媒体产物预览">
                  <h3>{isVideo ? '成片预览' : '产品主图'}</h3>
                  {isVideo ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video controls preload="metadata" src={mediaUrl} />
                  ) : (
                    <a href={mediaUrl} target="_blank" rel="noopener noreferrer">
                      <img src={mediaUrl} alt={viewRun.title || '真实生成图片'} loading="lazy" />
                    </a>
                  )}
                  <small>真实模型产物，点开可看原始文件；不满意可免费重试后再采用。</small>
                </section>
              );
            })()}
            <section>
              <h3>
                {viewRun.canUse
                  ? '工具交付'
                  : runIsActive(viewRun)
                    ? '交付预览（生成中）'
                    : runNeedsReconciliation(viewRun)
                      ? '待账务对账产物（仅供审计，业务暂不可采用）'
                      : '失败记录（仅供审计，未形成正式交付）'}
              </h3>
              <div className="tool-result-body" aria-label={viewRun.canUse ? '正式工具交付' : '仅供审计的失败记录'}>
                <Markdown
                  content={
                    viewRun.resultMd ||
                    (runIsActive(viewRun) ? '正在后台执行，完成后这里直接展示交付内容。' : '本次没有形成可展示的正文。')
                  }
                />
              </div>
            </section>
            {!!viewRun.assumptions?.length && (
              <section>
                <h3>假设与数据缺口</h3>
                <ul>
                  {viewRun.assumptions.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </section>
            )}
            <details className="tool-result-fold">
              <summary>
                <strong>来源与证据</strong>
                <small>
                  {viewRun.evidence?.length
                    ? `${viewRun.evidence.length} 条 · 点击展开`
                    : runIsActive(viewRun)
                      ? '执行中'
                      : '无可验证来源'}
                </small>
              </summary>
              {viewRun.evidence?.length ? (
                <List
                  size="small"
                  dataSource={viewRun.evidence}
                  renderItem={item => {
                    const sourceUrl = item.url || (/^https?:\/\//i.test(item.source || '') ? item.source : '');
                    return (
                      <List.Item>
                        <span>{item.label || (sourceUrl ? '公开来源' : item.source)}</span>
                        {sourceUrl ? (
                          <a href={sourceUrl} target="_blank" rel="noreferrer">
                            查看来源
                          </a>
                        ) : (
                          <Tag>内部输入</Tag>
                        )}
                      </List.Item>
                    );
                  }}
                />
              ) : (
                <Alert
                  type={runIsActive(viewRun) ? 'info' : 'warning'}
                  showIcon
                  message={
                    runIsActive(viewRun)
                      ? '执行完成后这里会列出可点开核验的来源。'
                      : '本次没有形成可验证来源，不会作为正式业务交付。'
                  }
                />
              )}
            </details>
            <details className="tool-result-fold">
              <summary>
                <strong>过程与费用</strong>
                <small>执行模式、输入摘要、进度与计费 · 默认收起</small>
              </summary>
              <div className="tool-result-provenance">
                <div>
                  <span>执行模式</span>
                  <strong>
                    {viewRun.provenance?.mode || (runIsActive(viewRun) ? '后台执行中' : '未形成真实调用')}
                  </strong>
                </div>
                <div>
                  <span>提示词快照</span>
                  <strong>{viewRun.provenance?.promptVersion ? '已保存' : '系统默认'}</strong>
                </div>
                <div>
                  <span>置信度</span>
                  <strong>{viewRun.provenance?.confidence || '待老板核验'}</strong>
                </div>
                <div>
                  <span>生成时间</span>
                  <strong>
                    {String(viewRun.provenance?.generatedAt || viewRun.updatedAt || viewRun.createdAt || '')
                      .replace('T', ' ')
                      .slice(0, 16) || '-'}
                  </strong>
                </div>
                {viewRun.provenance?.billing?.state && (
                  <div>
                    <span>计费状态</span>
                    <strong>
                      {billingStateLabel(
                        viewRun.provenance.billing.state,
                        viewRun.provenance.billing.chargedCredits,
                        viewRun.status,
                      )}
                    </strong>
                  </div>
                )}
              </div>
              {viewRun.inputSummary && (
                <Alert type="info" showIcon message="本次输入摘要" description={viewRun.inputSummary} />
              )}
              {!runIsActive(viewRun) && !!viewRun.progress?.length && (
                <section>
                  <h3>真实执行进度</h3>
                  <List
                    size="small"
                    dataSource={viewRun.progress}
                    renderItem={item => (
                      <List.Item>
                        <span>{item.message || item.phase || '任务执行中'}</span>
                        <small>
                          {String(item.at || '')
                            .replace('T', ' ')
                            .slice(0, 19)}
                        </small>
                      </List.Item>
                    )}
                  />
                </section>
              )}
            </details>
          </div>
        )}
      </Drawer>
    </div>
  );
}

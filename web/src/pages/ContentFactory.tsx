import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  Row,
  Col,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Button,
  Tag,
  Tooltip,
  Modal,
  message,
  Alert,
  Empty,
  Spin,
  Table,
  Badge,
  Pagination,
  Avatar,
  Space,
  Popconfirm,
  Switch,
  Grid,
} from 'antd';
import {
  FileTextOutlined,
  VideoCameraOutlined,
  ThunderboltOutlined,
  BulbOutlined,
  RobotOutlined,
  CopyOutlined,
  SendOutlined,
  FolderOpenOutlined,
  AppstoreOutlined,
  CloudUploadOutlined,
  SaveOutlined,
  TeamOutlined,
  FireOutlined,
  ClockCircleOutlined,
  RightOutlined,
  DeleteOutlined,
  DownOutlined,
  UpOutlined,
  CalendarOutlined,
  BarChartOutlined,
  PictureOutlined,
  PlusOutlined,
  EditOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { notifyCredits, api, getUser } from '../api/client';
import { StatCard, Panel } from '../components/Kit';
import EmployeeAvatar from '../components/EmployeeAvatar';
import EmployeeWorkbench from '../components/EmployeeWorkbench';
import ContentPipelineWorkbench from '../components/ContentPipelineWorkbench';
import ContentEmployeeTaskCenter from '../components/ContentEmployeeTaskCenter';
import WechatDraftStudio from '../components/WechatDraftStudio';
import ContentReferencePanel from '../components/ContentReferencePanel';
import ContentFactoryRecentCard from '../components/ContentFactoryRecentCard';
import AiSalesVideoPanel from '../components/AiSalesVideoPanel';
import { useReferenceImages } from '../components/useReferenceImages';
import {
  CONTENT_EXECUTION_STATIONS,
  CONTENT_CREW_STATIONS,
  type ContentCrewKey,
  type ContentCrewStation,
} from '../components/contentCrewConfig';
import type { VideoModelOption } from '../components/contentMediaTypes';
import AutomationFailureReason from '../components/AutomationFailureReason';
import MediaJobCard, { MediaImportAction, MediaReviewTags, mediaBillingPresentation } from '../components/MediaJobCard';
import PromptGuideModal, { type PromptGuide } from '../components/PromptGuideModal';
import TaskProgress from '../components/TaskProgress';
import type { ContentEmployeeQueueResponse, EmployeeWorkbenchRun } from '../api/employeeWorkbenchTypes';
import './ContentFactory.css';
import {
  BRANDS,
  COPY_TYPES,
  GENERATE_STAGES,
  LIB_TABS,
  MEDIA_TABS,
  PUBLISH_LEADS_MAX,
  PUBLISH_VIEWS_MAX,
  STATUSES,
  TABS,
  TYPE_META,
  approvalBlockedReason,
  canSubmitApproval,
  contentFlowBlockedReason,
  contentFlowReady,
  contentStatusColor,
  contentStatusLabel,
  contentTypeLabel,
  ell,
  fmtNum,
  fmtTime,
  interactiveSurfaceStyle,
  sourceLabel,
  splitTags,
} from '../data/contentFactoryConstants';
import { templatesFor, MediaTemplate } from '../data/mediaTemplates';
import { useSearchParams } from 'react-router-dom';

type ProductionMode = 'manual' | 'immediate' | 'scheduled';
type ContentAutomationRule = {
  id: number;
  name: string;
  enabled: boolean;
  employeeIdx: number;
  employee?: { contentEmployeeName?: string; contentEmployeeGroup?: string };
  topic: string;
  requirement: string;
  contentType: string;
  contentCount: number;
  frequency: 'daily' | 'weekly';
  runTime: string;
  weekday: number | null;
  approvalMode: 'auto' | 'risk' | 'always';
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastContentId: number | null;
  allowedTaskTypes?: string[];
  taskTypeValid?: boolean;
};

// 自动化产物一律停在待人工审阅，人工采纳后才进业务资产；
// approvalMode 只保留历史配置的展示区分，不再有免审通道。
const automationApprovalModeLabel = (mode: ContentAutomationRule['approvalMode']) => {
  if (mode === 'always') return '生成后待人工审阅（强制复核）';
  if (mode === 'risk') return '生成后待人工审阅（旧“按风险”规则已升级为必审）';
  return '生成后待人工审阅（旧“自动采用”规则已升级为必审）';
};
type ContentAutomationRun = {
  id: number;
  status: '运行中' | '成功' | '失败';
  contentId: number | null;
  billing?: { state?: string; balance?: number; chargedCredits?: number } | null;
  error?: string | null;
};
type AcceptedAutomationRun = {
  runId: number;
  status: ContentAutomationRun['status'];
  queued: boolean;
  reused: boolean;
  pollAfterMs?: number;
  pollUrl: string;
};
type PipelinePendingReview = {
  pipelineId: number;
  pipelineTitle: string;
  stationIdx: number;
  stationName: string;
  creator: { id: number; name: string; role: string | null };
  approvalBoundary: { code: string | null; label: string };
  canReview: boolean;
  reviewBlockedReason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};
const normalizeVideoModel = (m: VideoModelOption | string): VideoModelOption =>
  typeof m === 'string' ? { id: m, name: m } : m;
const VIDEO_TIERS = [
  { key: 'quality', label: '高质量', color: 'purple', desc: '重点活动/发布级成片' },
  { key: 'standard', label: '标准', color: 'blue', desc: '常规内容生产' },
  { key: 'fast', label: '快速', color: 'green', desc: '低消耗批量试稿' },
];
// 前台生成预计耗时提示（与 client.ts 超时分级一致：生图125s/视频95s/PPT120s/文案60s）
const GEN_TIME_HINTS: Record<string, string> = {
  AI图片: '图片生成通常需要 1-2 分钟，可随时取消',
  AI视频: '视频生成通常需要 1-2 分钟，可随时取消',
  AIPPT: 'PPT 生成通常需要 1-2 分钟，可随时取消',
};
const genTimeHint = (tab: string) => GEN_TIME_HINTS[tab] || '文案生成通常需要 10-60 秒，可随时取消';
const WEEKDAY_LABELS = ['-', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const AUTOMATION_STATUS_COLOR: Record<string, string> = { 运行中: 'processing', 成功: 'success', 失败: 'error' };
const automationVisibleFailure = (rule: ContentAutomationRule) => {
  const error = String(rule.lastError || '').trim();
  return error && ['失败', '未完成', '已停用'].includes(rule.lastStatus || '') ? error : '';
};
const pendingApprovalContent = (record: any) => ({
  ...record,
  status: '待审核',
  delivery: {
    ...(record?.delivery || {}),
    displayStatus: '待人工审阅',
    canUse: false,
    canImport: false,
    canPublish: false,
    canSubmitApproval: false,
    reason: '内容已进入策略确认；确认前只能内部预览，不能导入正式素材或登记发布',
    nextAction: '由有权限的人员完成策略确认',
  },
});
const crewStationIcon = (key: ContentCrewKey): ReactNode =>
  ({
    trend: <BulbOutlined />,
    research: <SearchOutlined />,
    benchmark: <AppstoreOutlined />,
    draft: <EditOutlined />,
    style: <FileTextOutlined />,
    media: <VideoCameraOutlined />,
    cover: <PictureOutlined />,
    deck: <AppstoreOutlined />,
    publish: <SendOutlined />,
    retro: <BarChartOutlined />,
    commerce_video: <VideoCameraOutlined />,
  })[key];
const crewAdoptionLabel = (mode?: string, role?: string) => {
  if (role === 'boss' || role === 'platform_super') return '当前账号普通内部结果直接采用';
  if (!mode || mode === 'auto') return '普通内部结果通过门禁后自动采用';
  if (mode === 'force') return '内部结果按中央策略采用；外发、付费或不可逆执行另行授权';
  return '以当前中央策略为准（岗位旧配置仅作档案）';
};
const approvalActionText = (record: any) =>
  record?.delivery?.approvalActionLabel === '补建审阅单' ? '补建确认单' : '提交策略确认';
const ContentUseActions = ({ record, children }: { record: any; children: ReactNode }) => (
  <Tooltip title={contentFlowReady(record) ? '' : contentFlowBlockedReason(record)}>
    <span style={{ display: 'inline-flex', gap: 6 }}>{children}</span>
  </Tooltip>
);
export default function ContentFactory() {
  const canViewCrewInternals = ['boss', 'admin', 'platform_super'].includes(getUser()?.role || '');
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const pipelineIdFromQuery = Number(searchParams.get('pipelineId'));
  const mediaJobIdFromQuery = Number(searchParams.get('mediaJobId'));
  const requestedPipelineId =
    Number.isSafeInteger(pipelineIdFromQuery) && pipelineIdFromQuery > 0 ? pipelineIdFromQuery : null;
  const requestedMediaJobId =
    Number.isSafeInteger(mediaJobIdFromQuery) && mediaJobIdFromQuery > 0 ? mediaJobIdFromQuery : null;
  const [summary, setSummary] = useState<any>({});
  const [tab, setTab] = useState(
    requestedTab && [...LIB_TABS, 'AI文案'].includes(requestedTab) ? requestedTab : 'AI文案',
  );
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [templates, setTemplates] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<number[]>([]);
  const [pending, setPending] = useState<any[]>([]);
  const [pendingError, setPendingError] = useState('');
  const [pipelinePendingReviews, setPipelinePendingReviews] = useState<PipelinePendingReview[]>([]);
  const [pipelinePendingError, setPipelinePendingError] = useState('');
  const [employeeTaskQueue, setEmployeeTaskQueue] = useState<ContentEmployeeQueueResponse | null>(null);
  const [employeeTaskRefreshToken, setEmployeeTaskRefreshToken] = useState(0);
  const [effectTop, setEffectTop] = useState<any[]>([]);
  const [briefing, setBriefing] = useState<any>(null);
  const [results, setResults] = useState<any[]>([]);
  const [generating, setGenerating] = useState(false);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyPack, setDailyPack] = useState<any>(null);
  const [dailyOpen, setDailyOpen] = useState(false);
  const [salesVideoOpen, setSalesVideoOpen] = useState(Boolean(requestedMediaJobId));
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [pipelineFocusId, setPipelineFocusId] = useState<number | null>(requestedPipelineId);
  const [viewRec, setViewRec] = useState<any>(null);
  const [pubRec, setPubRec] = useState<any>(null);
  const [publishIdempotencyKey, setPublishIdempotencyKey] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [matOpen, setMatOpen] = useState(false);
  const [tplDetail, setTplDetail] = useState<any>(null);
  const [suggestionDetail, setSuggestionDetail] = useState<any>(null);
  const [flowDetail, setFlowDetail] = useState<any>(null);
  const [mediaPromptText, setMediaPromptText] = useState('');
  const [mediaTagFilter, setMediaTagFilter] = useState('');
  const [mediaSceneFilter, setMediaSceneFilter] = useState('');
  const [mediaTemplatesExpanded, setMediaTemplatesExpanded] = useState(false);
  const [promptGuides, setPromptGuides] = useState<PromptGuide[]>([]);
  const [promptGuideDetail, setPromptGuideDetail] = useState<PromptGuide | null>(null);
  const [importingKey, setImportingKey] = useState('');
  const [form] = Form.useForm();
  const [pubForm] = Form.useForm();
  const [tplForm] = Form.useForm();
  const [matForm] = Form.useForm();
  const [matDetail, setMatDetail] = useState<any>(null);
  const [mediaJobs, setMediaJobs] = useState<any[]>([]);
  const [mediaJobsRefreshing, setMediaJobsRefreshing] = useState(false);
  const [selectedMediaJobIds, setSelectedMediaJobIds] = useState<number[]>([]);
  const [videoModels, setVideoModels] = useState<{
    models: Array<VideoModelOption | string>;
    default: string;
    canViewPrice?: boolean;
  }>({ models: [], default: '' });
  const [marshals, setMarshals] = useState<any[]>([]);
  const [productionMode, setProductionMode] = useState<ProductionMode>('manual');
  const [automationRules, setAutomationRules] = useState<ContentAutomationRule[]>([]);
  const [automationLoading, setAutomationLoading] = useState(false);
  const [automationAccess, setAutomationAccess] = useState(true);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [editingAutomation, setEditingAutomation] = useState<ContentAutomationRule | null>(null);
  const [automationSaving, setAutomationSaving] = useState(false);
  const [automationRunningId, setAutomationRunningId] = useState<number | null>(null);
  const automationPollAbortRef = useRef<AbortController | null>(null);
  const [automationForm] = Form.useForm();
  const screens = Grid.useBreakpoint();
  const useAutomationCards = !screens.lg;
  const automationFrequency = Form.useWatch('frequency', automationForm);
  const automationEmployeeIdx = Form.useWatch('employeeIdx', automationForm);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && requestedTab && [...MEDIA_TABS, ...LIB_TABS, 'AI文案'].includes(requestedTab)) {
        // 旧媒体深链继续可读，但不再重新暴露独立的图片/视频/PPT创作入口。
        setTab(MEDIA_TABS.includes(requestedTab) ? '素材库' : requestedTab);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [requestedTab]);
  useEffect(() => () => automationPollAbortRef.current?.abort(), []);
  const openEffectDetail = (id: number) => {
    api
      .get(`/content/detail/${id}`)
      .then((row: any) => setViewRec(row))
      .catch(() => message.error('内容详情加载失败，请稍后重试'));
  };
  const openContentDetail = (rec: any) => {
    if (rec?.id) openEffectDetail(rec.id);
    else setViewRec(rec);
  };
  const applyMaterial = (m: any) => {
    const materialId = Number(m?.id);
    if (!Number.isInteger(materialId) || materialId <= 0) return;
    if (selectedMaterialIds.includes(materialId)) {
      message.info(`素材《${m.name || '未命名素材'}》已在本次创作引用中`);
      setMatDetail(null);
      return;
    }
    if (selectedMaterialIds.length >= 6) {
      message.warning('一次创作最多引用6个素材，请先移除一个');
      return;
    }
    api.post(`/content/materials/${m.id}/use`, {}).then((fresh: any) => {
      setSelectedMaterialIds(current =>
        current.includes(materialId) ? current : [...current, materialId].slice(0, 6),
      );
      message.success(`素材《${fresh.name}》已加入本次创作；只有生成成功后才计入引用次数`);
      setMatDetail(null);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };
  const regenSame = (rec: any) => {
    const type = COPY_TYPES.includes(rec.type) ? rec.type : '短视频脚本';
    switchTab(MEDIA_TABS.includes(rec.type) ? '素材库' : 'AI文案');
    form.setFieldsValue({ type, topic: rec.topic || rec.title?.split('·')[0] || '' });
    setViewRec(null);
    message.success('已按该爆款回填类型与主题，可直接生成同款');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const isMedia = MEDIA_TABS.includes(tab);
  const selectedMaterials = selectedMaterialIds
    .map(id => materials.find(material => Number(material.id) === id))
    .filter(Boolean);
  const watchedType = Form.useWatch('type', form);
  const currentCopyType = watchedType || form.getFieldValue('type') || '短视频脚本';
  const mediaTemplateList = ['AI图片', 'AI视频', 'AIPPT'].includes(tab) ? templatesFor(tab) : [];
  const mediaTagOptions = [...new Set(mediaTemplateList.flatMap(t => t.tags || []))].sort();
  const mediaSceneOptions = [...new Set(mediaTemplateList.map(t => t.scene).filter(Boolean))].sort();
  const filteredMediaTemplates = mediaTemplateList.filter(
    t =>
      (!mediaTagFilter || (t.tags || []).includes(mediaTagFilter)) &&
      (!mediaSceneFilter || t.scene === mediaSceneFilter),
  );
  const activePromptGuide = canViewCrewInternals
    ? promptGuides.find(g => g.type === (isMedia ? tab : currentCopyType))
    : undefined;
  const videoModelItems = videoModels.models
    .map(normalizeVideoModel)
    .sort(
      (a, b) =>
        (a.tierRank ?? 9) - (b.tierRank ?? 9) || (a.credits ?? 0) - (b.credits ?? 0) || a.id.localeCompare(b.id),
    );
  const videoTierSummary = VIDEO_TIERS.map(t => {
    const items = videoModelItems.filter(m => m.tier === t.key);
    if (!items.length) return null;
    const credits = items.map(m => Number(m.credits || 0)).filter(Boolean);
    const min = Math.min(...credits);
    const max = Math.max(...credits);
    return `${t.label}档${min === max ? ` ${min}` : ` ${min}-${max}`}积分`;
  })
    .filter(Boolean)
    .join(' / ');
  const videoModelLabel = (m: VideoModelOption, idx = 0) => (
    <Space size={6} wrap>
      <span>
        {videoModels.canViewPrice
          ? `${m.displayName || m.name || m.id}${m.shortName ? ` · ${m.shortName}` : ''}`
          : `${m.tierLabel || '标准'}档 · ${m.shortName || `方案${idx + 1}`}`}
      </span>
      {videoModels.canViewPrice && m.provider && <Tag style={{ margin: 0 }}>{m.provider}</Tag>}
      {videoModels.canViewPrice && m.tierLabel && (
        <Tag color="purple" style={{ margin: 0 }}>
          {m.tierLabel}
        </Tag>
      )}
      {m.supported === false ? (
        <Tag color="default" style={{ margin: 0 }}>
          待接入
        </Tag>
      ) : (
        <Tag color="green" style={{ margin: 0 }}>
          已接入
        </Tag>
      )}
      {m.requiresImage ? (
        <Tag color="orange" style={{ margin: 0 }}>
          需首帧图
        </Tag>
      ) : null}
      {m.credits ? (
        <Tag color="blue" style={{ margin: 0 }}>
          {m.credits}积分/次
        </Tag>
      ) : null}
      {videoModels.canViewPrice && m.costYuan !== undefined ? (
        <Tag color="gold" style={{ margin: 0 }}>
          成本¥{m.costYuan}
        </Tag>
      ) : null}
      {videoModels.canViewPrice && m.note ? (
        <span style={{ color: 'var(--ui-muted)', fontSize: 11 }}>{m.note}</span>
      ) : null}
    </Space>
  );
  const videoSelectOptions = VIDEO_TIERS.map(t => {
    const items = videoModelItems.filter(m => m.tier === t.key);
    if (!items.length) return null;
    const credits = items.map(m => Number(m.credits || 0)).filter(Boolean);
    const min = Math.min(...credits);
    const max = Math.max(...credits);
    return {
      label: (
        <Space size={6}>
          <Tag color={t.color} style={{ margin: 0 }}>
            {t.label}
          </Tag>
          <span>{t.desc}</span>
          <span style={{ color: 'var(--ui-muted)' }}>{min === max ? `${min}` : `${min}-${max}`}积分</span>
        </Space>
      ),
      options: items.map((m, idx) => ({
        value: m.id,
        label: videoModelLabel(m, idx),
        disabled: m.supported === false,
      })),
    };
  }).filter(Boolean) as any[];
  useEffect(() => {
    if (tab !== 'AI视频' || !videoModels.models.length) return;
    const usable = videoModels.models.map(normalizeVideoModel).filter(m => m.supported !== false);
    const current = form.getFieldValue('videoModel');
    if (!usable.some(m => m.id === current)) {
      form.setFieldsValue({ videoModel: videoModels.default || usable[0]?.id });
    }
  }, [tab, videoModels.default, videoModels.models, form]);

  const loadSummary = useCallback(
    () =>
      api
        .get('/content/summary')
        .then(setSummary)
        .catch(() => message.error('内容统计加载失败，可稍后刷新页面重试')),
    [],
  );
  const loadTemplates = () =>
    api
      .get('/content/templates')
      .then(r => setTemplates(r || []))
      .catch(() => message.error('模板列表加载失败，可稍后刷新页面重试'));
  const loadMaterials = useCallback(
    () =>
      api
        .get('/content/materials')
        .then(r => {
          const next = r || [];
          setMaterials(next);
          const available = new Set(next.map((material: any) => Number(material.id)));
          setSelectedMaterialIds(current => current.filter(id => available.has(id)));
        })
        .catch(() => message.error('素材列表加载失败，可稍后刷新页面重试')),
    [],
  );
  const loadEffectTop = () =>
    api
      .get('/content/effect-top')
      .then(r => setEffectTop(r || []))
      .catch(() => message.error('效果TOP榜加载失败，可稍后刷新页面重试'));
  const loadAutomations = () => {
    setAutomationLoading(true);
    api
      .get('/content/automations')
      .then((data: any) => {
        setAutomationRules(Array.isArray(data?.rules) ? data.rules : []);
        setAutomationAccess(true);
      })
      .catch((error: any) => {
        setAutomationRules([]);
        if (
          Number(error?.status || error?.response?.status) === 403 ||
          String(error?.message || '').includes('仅老板')
        ) {
          setAutomationAccess(false);
        }
      })
      .finally(() => setAutomationLoading(false));
  };
  const loadPending = () => {
    setPendingError('');
    api
      .get(`/content/list?type=&status=${encodeURIComponent('待审核')}&page=1&size=6`)
      .then(r => setPending(r.rows || []))
      .catch(e => {
        setPending([]);
        setPendingError(e?.message || '待处理列表加载失败');
      });
  };
  const loadPipelinePendingReviews = () => {
    setPipelinePendingError('');
    return api
      .get('/content/pipelines/pending-reviews')
      .then((data: any) => {
        setPipelinePendingReviews(Array.isArray(data?.reviews) ? data.reviews : []);
      })
      .catch((error: any) => {
        setPipelinePendingReviews([]);
        setPipelinePendingError(error?.message || '流水线待审列表加载失败');
      });
  };
  const loadList = useCallback(() => {
    const t = MEDIA_TABS.includes(tab) ? tab : '';
    api
      .get(
        `/content/list?type=${encodeURIComponent(t)}&status=${encodeURIComponent(statusFilter)}&page=${page}&size=12`,
      )
      .then(r => {
        setRows(r.rows || []);
        setTotal(r.total || 0);
      })
      .catch(() => message.error('内容列表加载失败，请刷新重试'));
  }, [page, statusFilter, tab]);
  const refreshList = () => {
    if (LIB_TABS.includes(tab)) return;
    if (page === 1) loadList();
    else setPage(1);
  };

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      loadSummary();
      loadTemplates();
      loadMaterials();
      loadPending();
      loadPipelinePendingReviews();
      loadEffectTop();
      loadAutomations();
      // 跨模块辅助简报：未开通 dashboard 模块的角色 403 属正常路径，缺失仅隐藏建议区，保留静默
      api
        .get('/dashboard/briefing')
        .then(setBriefing)
        .catch(() => {});
      if (canViewCrewInternals) {
        api
          .get('/content/prompt-guides')
          .then((r: PromptGuide[]) => setPromptGuides(r || []))
          .catch(() => message.error('提示词指南加载失败，可稍后刷新页面重试'));
      }
      // 跨模块可选数据：未开通 marshals 模块的角色属正常缺失，仅影响可选的"数字员工"下拉，保留静默
      api
        .get('/marshals')
        .then((rows: any[]) => setMarshals((rows || []).filter(m => m.online)))
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [canViewCrewInternals, loadMaterials, loadSummary]);
  useEffect(() => {
    if (!requestedPipelineId) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setPipelineFocusId(requestedPipelineId);
      setPipelineOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, [requestedPipelineId]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && !LIB_TABS.includes(tab)) void loadList();
    });
    return () => {
      cancelled = true;
    };
  }, [loadList, tab]);

  const loadMediaJobs = useCallback((kind: string, { silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setMediaJobsRefreshing(true);
    return api
      .get(`/content/media-jobs?kind=${kind}`)
      .then((rows: any[]) => {
        setMediaJobs(rows || []);
        setSelectedMediaJobIds(prev => prev.filter(id => (rows || []).some(j => j.id === id)));
      })
      .catch(() => {
        if (!silent) message.error('媒体任务列表加载失败，可点击刷新重试');
      })
      .finally(() => {
        if (!silent) setMediaJobsRefreshing(false);
      });
  }, []);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (tab === 'AI图片') void loadMediaJobs('image');
      if (tab === 'AI视频') {
        void loadMediaJobs('video');
        void api
          .get('/content/video-models')
          .then(setVideoModels)
          .catch(() => message.error('视频模型清单加载失败，请刷新重试'));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tab, loadMediaJobs]);
  const hasProcessingMediaJobs = mediaJobs.some(job => String(job?.technicalStatus || job?.status || '') === '处理中');
  useEffect(() => {
    if (!['AI图片', 'AI视频'].includes(tab) || !hasProcessingMediaJobs) return undefined;
    const kind = tab === 'AI视频' ? 'video' : 'image';
    const timer = window.setInterval(() => {
      void loadMediaJobs(kind, { silent: true });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [tab, hasProcessingMediaJobs, loadMediaJobs]);

  const openAutomationEditor = (rule?: ContentAutomationRule) => {
    const target = rule || null;
    setEditingAutomation(target);
    automationForm.setFieldsValue(
      target
        ? {
            name: target.name,
            enabled: target.enabled,
            employeeIdx: target.employeeIdx,
            topic: target.topic,
            requirement: target.requirement,
            contentType: target.contentType,
            contentCount: target.contentCount,
            frequency: target.frequency,
            runTime: target.runTime,
            weekday: target.weekday,
            approvalMode: target.approvalMode,
          }
        : {
            name: '每日门店内容',
            enabled: true,
            employeeIdx: 3,
            topic: form.getFieldValue('topic') || '',
            requirement:
              form.getFieldValue('requirement') ||
              '仅使用门店已确认信息，未知价格、库存、活动权益与成效必须标记待确认。',
            contentType: '文案初稿',
            contentCount: 3,
            frequency: 'daily',
            runTime: '09:00',
            weekday: null,
            approvalMode: 'auto',
          },
    );
    setAutomationOpen(true);
  };

  const saveAutomation = () => {
    automationForm.validateFields().then(values => {
      const payload = {
        ...values,
        weekday: values.frequency === 'weekly' ? values.weekday : null,
      };
      setAutomationSaving(true);
      const request = editingAutomation
        ? api.put(`/content/automations/${editingAutomation.id}`, payload)
        : api.post('/content/automations', payload);
      request
        .then(() => {
          message.success(editingAutomation ? '定时规则已更新' : '内容自动化规则已创建');
          setAutomationOpen(false);
          setEditingAutomation(null);
          loadAutomations();
        })
        .finally(() => setAutomationSaving(false));
    });
  };

  const toggleAutomation = (rule: ContentAutomationRule, enabled: boolean) => {
    api.post(`/content/automations/${rule.id}/toggle`, { enabled }).then(() => {
      message.success(enabled ? '定时任务已启用' : '定时任务已停用，不会继续自动运行');
      loadAutomations();
    });
  };

  const runAutomationNow = async (rule: ContentAutomationRule) => {
    if (automationRunningId !== null) return;
    setAutomationRunningId(rule.id);
    const pollController = new AbortController();
    automationPollAbortRef.current?.abort();
    automationPollAbortRef.current = pollController;
    try {
      const accepted = (await api.post(`/content/automations/${rule.id}/run`, {
        idempotencyKey: crypto.randomUUID(),
      })) as AcceptedAutomationRun;
      if (!Number.isSafeInteger(accepted.runId) || accepted.runId < 1 || !accepted.pollUrl) {
        throw new Error('自动化任务未返回有效运行编号');
      }
      message.info(
        accepted.reused
          ? `「${rule.name}」已有运行中的任务，已重新连接运行 #${accepted.runId}`
          : `「${rule.name}」已进入后台运行（#${accepted.runId}），页面将自动刷新结果`,
      );
      void loadAutomations();
      const pollDelay = Math.max(1000, Number(accepted.pollAfterMs) || 2000);
      let terminal: ContentAutomationRun | null = null;
      for (let attempt = 0; attempt < 180 && !pollController.signal.aborted; attempt += 1) {
        try {
          const history = (await api.get(accepted.pollUrl, {
            signal: pollController.signal,
          })) as { runs?: ContentAutomationRun[] };
          const current = history.runs?.find(run => run.id === accepted.runId) || null;
          if (current && current.status !== '运行中') {
            terminal = current;
            break;
          }
        } catch {
          if (pollController.signal.aborted) return;
        }
        await new Promise(resolve => window.setTimeout(resolve, attempt < 10 ? pollDelay : 5000));
      }
      if (pollController.signal.aborted) return;
      if (!terminal) {
        message.warning(`运行 #${accepted.runId} 仍在后台处理中，请稍后刷新自动任务记录；系统不会自动重复提交`);
        return;
      }
      if (terminal.billing) notifyCredits(terminal.billing.balance);
      if (terminal.status === '成功') {
        message.success(`「${rule.name}」已生成并进入内容仓，请按产物状态继续处理或做发布决策；未执行外发`);
      } else {
        message.error(`「${rule.name}」运行失败：${terminal.error || '请查看自动任务记录'}`);
      }
      await Promise.all([loadAutomations(), refreshList(), loadPending(), loadSummary()]);
    } finally {
      if (automationPollAbortRef.current === pollController) {
        automationPollAbortRef.current = null;
        setAutomationRunningId(null);
      }
    }
  };

  const deleteAutomation = (rule: ContentAutomationRule) => {
    api.del(`/content/automations/${rule.id}`).then(() => {
      message.success('自动化规则已删除，既有内容保留');
      loadAutomations();
    });
  };

  const switchTab = (k: string) => {
    setTab(MEDIA_TABS.includes(k) ? '素材库' : k);
    setPage(1);
    setSelTpl(null);
    setMediaPromptText('');
    setMediaTagFilter('');
    setMediaSceneFilter('');
    if (MEDIA_TABS.includes(k)) form.setFieldsValue({ type: k });
    else if (k === 'AI文案' && !COPY_TYPES.includes(form.getFieldValue('type')))
      form.setFieldsValue({ type: '短视频脚本' });
  };

  const [selTpl, setSelTpl] = useState<MediaTemplate | null>(null);
  const applyMediaTpl = (t: MediaTemplate) => {
    setSelTpl(t);
    setMediaPromptText(t.promptSkeleton);
    const curTopic = form.getFieldValue('topic');
    form.setFieldsValue({ topic: curTopic || t.topicHint });
    message.success(`已套用模板「${t.name}」：生成时按模板风格与结构执行`, 1.6);
  };

  const { refImgs, setRefImgs, onPickRef } = useReferenceImages();
  const [contentCrew, setContentCrew] = useState<ContentCrewStation[]>(CONTENT_CREW_STATIONS);
  const [crewLoading, setCrewLoading] = useState(true);
  const [crewConnected, setCrewConnected] = useState(false);
  const [crewWorkbenchIdx, setCrewWorkbenchIdx] = useState<number | null>(null);
  const [crewWorkbenchRunId, setCrewWorkbenchRunId] = useState<number | null>(null);
  const employeePendingReviewCount = employeeTaskQueue?.statusCounts?.['待审阅'] || 0;
  const pipelinePendingReviewCount = pipelinePendingReviews.length;
  const totalPendingReviewCount = pending.length + employeePendingReviewCount + pipelinePendingReviewCount;
  const openPipelineReview = useCallback((pipelineId: number) => {
    setPipelineFocusId(pipelineId);
    setPipelineOpen(true);
  }, []);
  const receiveEmployeeTaskQueue = useCallback((data: ContentEmployeeQueueResponse | null) => {
    setEmployeeTaskQueue(data);
  }, []);
  const openContentEmployeeRun = useCallback((run: EmployeeWorkbenchRun) => {
    setCrewWorkbenchRunId(run.id);
    setCrewWorkbenchIdx(run.employeeIdx);
  }, []);
  const automationStation = contentCrew.find(
    station => (station.employeeIdx ?? station.order) === Number(automationEmployeeIdx),
  );
  const automationTaskTypes = automationStation?.taskTypes?.length
    ? automationStation.taskTypes
    : editingAutomation?.employeeIdx === Number(automationEmployeeIdx)
      ? editingAutomation.allowedTaskTypes || []
      : [];
  useEffect(() => {
    api
      .get('/content/crew')
      .then((data: any) => {
        const rows = Array.isArray(data?.employees)
          ? data.employees
          : Array.isArray(data)
            ? data
            : data?.crew || data?.stations || [];
        if (!Array.isArray(rows) || !rows.length) return;
        setContentCrew(
          CONTENT_CREW_STATIONS.map(base => {
            const remote =
              rows.find((row: any) => Number(row?.idx) === base.order) ||
              rows.find((row: any) => row?.key === base.key) ||
              {};
            const rawIdx = remote.idx ?? remote.employeeIdx ?? remote.employee_idx;
            const employeeIdx = rawIdx == null || rawIdx === '' ? null : Number(rawIdx);
            return {
              ...base,
              key: remote.key || base.key,
              name: remote.name || base.name,
              group: remote.group || base.group,
              emoji: remote.emoji || base.emoji,
              person: null,
              optional: typeof remote.optional === 'boolean' ? remote.optional : base.optional,
              employeeIdx: Number.isInteger(employeeIdx) ? employeeIdx : null,
              moduleGroup: remote.moduleGroup,
              skill: remote.skill,
              color: remote.color,
              duty: remote.duty,
              intro: remote.intro,
              approval: remote.approval,
              capabilities: Array.isArray(remote.capabilities) ? remote.capabilities : [],
              outputKeys: Array.isArray(remote.outputKeys) ? remote.outputKeys : [],
              taskTypes:
                Array.isArray(remote.taskTypes) && remote.taskTypes.length
                  ? remote.taskTypes.map(String)
                  : base.taskTypes,
              runtime: remote.runtime && typeof remote.runtime === 'object' ? remote.runtime : undefined,
            };
          }),
        );
        setCrewConnected(true);
      })
      .catch(() => setCrewConnected(false))
      .finally(() => setCrewLoading(false));
  }, []);
  const bgTimersRef = useRef<Record<number, ReturnType<typeof setInterval>>>({});
  const genAbortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      Object.values(bgTimersRef.current).forEach(t => clearInterval(t));
    },
    [],
  );
  const pollBgJob = (jobId: number) => {
    bgTimersRef.current[jobId] = setInterval(async () => {
      try {
        const job = await api.get(`/content/media-jobs/${jobId}`);
        if (job.status === '成功' && job.content) {
          clearInterval(bgTimersRef.current[jobId]);
          delete bgTimersRef.current[jobId];
          setResults(prev =>
            prev.map(x =>
              x.jobId === jobId && x.pending
                ? {
                    id: job.content.id,
                    type: job.content.type,
                    topic: job.content.topic,
                    body: job.content.body,
                    status: job.content.status,
                    mode: job.content.ai_mode,
                  }
                : x,
            ),
          );
          message.success(`「${job.content.topic || ''}·${contentTypeLabel(job.content.type)}」后台生成完成`);
          refreshList();
          loadPending();
          loadSummary();
        } else if (job.status === '失败') {
          clearInterval(bgTimersRef.current[jobId]);
          delete bgTimersRef.current[jobId];
          setResults(prev =>
            prev.map(x =>
              x.jobId === jobId && x.pending ? { ...x, pending: false, failed: true, error: job.error } : x,
            ),
          );
        }
      } catch {
        /* 网络抖动：下一轮再查 */
      }
    }, 5000);
  };
  const onGenerateBackground = () => {
    form.validateFields().then(v => {
      const payload = {
        type: v.type,
        topic: v.topic,
        count: v.count,
        requirement: v.requirement,
        brand: v.brand,
        marshalId: v.marshalId,
        employeeIdx: CONTENT_EXECUTION_STATIONS.draft.employeeIdx,
        background: true,
        materialIds: selectedMaterialIds,
      };
      api.post('/content/generate', payload).then(res => {
        setResults(prev => [{ jobId: res.jobId, type: v.type, topic: v.topic, pending: true }, ...prev]);
        message.success('已转入后台生成，完成后铃铛通知，您可以先做别的');
        pollBgJob(res.jobId);
      });
    });
  };

  // 用户主动取消当前前台生成（图片125s/视频95s/PPT120s 的长任务不再只能干等）
  // 后端在请求中断时会立即终止上游供应商调用并全额退回预授权积分（见 server/src/index.js 请求取消中间件
  // 与 content.js executeHeldDelivery/releaseHold），因此「本次不计费」文案与后端语义一致。
  const cancelGenerate = () => genAbortRef.current?.abort();
  const onGenerate = () => {
    form.validateFields().then(v => {
      setGenerating(true);
      const aborter = new AbortController();
      genAbortRef.current = aborter;
      const genOptions = { signal: aborter.signal };
      const onGenFail = () => {
        // 用户主动取消：client.ts 不弹全局错误，这里给出明确反馈；其他错误请求层已统一提示
        if (aborter.signal.aborted) message.info('已取消，本次不计费');
      };
      const genDone = () => {
        if (genAbortRef.current === aborter) genAbortRef.current = null;
        setGenerating(false);
      };
      // 模板套用：以模板提示词骨架为底（{主题}替换），要求描述作补充
      const skeleton =
        selTpl && selTpl.tab === tab ? (mediaPromptText || selTpl.promptSkeleton).split('{主题}').join(v.topic) : '';
      const prompt = skeleton
        ? `${skeleton}${v.requirement ? `。补充要求：${v.requirement}` : ''}`
        : `${v.topic}${v.requirement ? '。' + v.requirement : ''}`;
      if (tab === 'AI图片') {
        api
          .post(
            '/content/generate-image',
            {
              prompt,
              images: refImgs.map(image => image.url),
              employeeIdx: CONTENT_EXECUTION_STATIONS.media.employeeIdx,
              materialIds: selectedMaterialIds,
            },
            genOptions,
          )
          .then(res => {
            if (res.billing) notifyCredits(res.billing.balance);
            const billingView = mediaBillingPresentation(res.billing);
            message.success(
              `图片技术生成成功${res.referencesUsed ? `，已参考${res.referencesUsed}张图` : ''}${billingView ? `；${billingView.label}` : ''}；需管理角色人工验收后才可作为业务素材`,
            );
            setResults(prev => [
              {
                ...res,
                type: 'AI图片',
                topic: v.topic,
                body: prompt,
                imageUrl: res.previewUrl || res.url,
                media: true,
                tpl: selTpl?.name,
                jobId: res.jobId,
                kind: res.kind || 'image',
                mediaType: res.mediaType || '图片',
              },
              ...prev,
            ]);
            loadMediaJobs('image');
            loadSummary();
          })
          .catch(onGenFail)
          .finally(genDone);
        return;
      }
      if (tab === 'AI视频') {
        api
          .post(
            '/content/generate-video',
            {
              prompt,
              model: v.videoModel || videoModels.default,
              images: refImgs.map(image => image.url),
              employeeIdx: CONTENT_EXECUTION_STATIONS.media.employeeIdx,
              materialIds: selectedMaterialIds,
            },
            genOptions,
          )
          .then(res => {
            if (res.billing) notifyCredits(res.billing.balance);
            const billingView = mediaBillingPresentation(res.billing);
            const technicalMessage =
              res.technicalStatus === '成功'
                ? '视频技术生成成功，当前待人工验收'
                : '视频任务已提交，当前仍在技术生成中';
            message.open({
              type: res.technicalStatus === '成功' ? 'success' : 'info',
              content: `${technicalMessage}${res.referencesUsed ? `，已参考${res.referencesUsed}张图` : ''}${billingView ? `；${billingView.label}` : ''}`,
            });
            setResults(prev => [
              {
                ...res,
                type: 'AI视频',
                topic: v.topic,
                body: `${prompt}\n\n${res.url ? `视频地址：${res.url}` : `任务状态：${res.technicalStatus || res.status || '处理中'}；${res.raw || '等待供应商返回视频地址'}`}`,
                videoUrl: res.previewUrl || res.url,
                media: true,
                tpl: selTpl?.name,
                jobId: res.jobId,
                kind: res.kind || 'video',
                mediaType: res.mediaType || '视频',
              },
              ...prev,
            ]);
            loadMediaJobs('video');
            loadSummary();
          })
          .catch(onGenFail)
          .finally(genDone);
        return;
      }
      if (tab === 'AIPPT') {
        api
          .post(
            '/content/generate-ppt',
            {
              topic: v.topic,
              pages: v.count || 8,
              template: selTpl?.tab === 'AIPPT' ? selTpl.name : '',
              structure: selTpl?.tab === 'AIPPT' ? selTpl.extra : v.requirement || '',
              employeeIdx: CONTENT_EXECUTION_STATIONS.deck.employeeIdx,
              materialIds: selectedMaterialIds,
            },
            genOptions,
          )
          .then(async res => {
            const fresh = res.id ? await api.get(`/content/detail/${res.id}`).catch(() => null) : null;
            if (res.billing) {
              notifyCredits(res.billing.balance);
              const billingView = mediaBillingPresentation(res.billing);
              const deliveryStatus =
                fresh?.delivery?.displayStatus ||
                res.delivery?.displayStatus ||
                (res.status === '待审核' ? '旧策略/显式策略待处理' : res.status || '状态待确认');
              message.open({
                type: res.billing.state === 'pending_reconciliation' ? 'warning' : 'success',
                content: `PPT结构已生成（${res.deck.pages.length + 1}页含封面），状态：${deliveryStatus}${billingView ? `；${billingView.label}` : ''}`,
              });
            }
            setResults(prev => [
              {
                ...(fresh || {}),
                id: res.id,
                type: 'AIPPT',
                topic: v.topic,
                deck: res.deck,
                media: true,
                billing: res.billing,
                mode: res.mode,
                status: res.status || '待审核',
                risk: res.risk,
                tpl: selTpl?.name,
                cover: selTpl?.cover,
                kbCat: res.kbCat,
              },
              ...prev,
            ]);
            refreshList();
            loadSummary();
          })
          .catch(onGenFail)
          .finally(genDone);
        return;
      }
      const media = MEDIA_TABS.includes(tab);
      const payload = {
        type: media ? tab : v.type,
        topic: v.topic,
        count: v.count,
        requirement: v.requirement,
        brand: v.brand,
        marshalId: v.marshalId,
        employeeIdx: CONTENT_EXECUTION_STATIONS.draft.employeeIdx,
        materialIds: selectedMaterialIds,
      };
      api
        .post('/content/generate', payload, genOptions)
        .then(async res => {
          const fresh = res.id ? await api.get(`/content/detail/${res.id}`).catch(() => null) : null;
          if (res.billing) notifyCredits(res.billing.balance);
          setResults(prev => [
            { ...res, ...(fresh || {}), type: payload.type, topic: v.topic, media, kbCat: res.kbCat },
            ...prev,
          ]);
          const billingView = mediaBillingPresentation(res.billing);
          message.open({
            type: res.billing?.state === 'pending_reconciliation' ? 'warning' : 'success',
            content: media
              ? `${tab}「提示词+大纲」已生成${billingView ? `；${billingView.label}` : ''}`
              : `内容生成成功${billingView ? `；${billingView.label}` : ''}${res.kbCat ? `；已自动沉淀知识库「${res.kbCat}」` : ''}`,
          });
          refreshList();
          loadPending();
          loadSummary();
        })
        .catch(onGenFail)
        .finally(genDone);
    });
  };

  // —— 一键日更包 ——
  const runDailyPack = () => {
    if (dailyLoading) return;
    setDailyLoading(true);
    const topic = form.getFieldValue('topic');
    api
      .post('/content/daily-pack', {
        ...(topic ? { topic } : {}),
        employeeIdx: CONTENT_EXECUTION_STATIONS.draft.employeeIdx,
        materialIds: selectedMaterialIds,
      })
      .then(res => {
        setDailyPack(res);
        setDailyOpen(true);
        if (res.billing) notifyCredits(res.billing.balance);
        const produced = Number(res.summary?.producedItems || 0);
        const failed = Number(res.summary?.failedParts || 0);
        const billingView = mediaBillingPresentation(res.billing);
        const billingText = billingView ? `（${billingView.label}）` : '';
        if (res.status === 'partial') {
          message.warning(`日更包部分完成：已产出 ${produced} 条，${failed} 个子任务失败${billingText}`);
        } else if (res.billing?.state === 'pending_reconciliation') {
          message.warning(`日更包已生成：${produced} 条内容${billingText}`);
        } else {
          message.success(`日更包已生成：${produced} 条内容${billingText}`);
        }
        refreshList();
        loadPending();
        loadSummary();
      })
      .finally(() => setDailyLoading(false));
  };

  // —— 模板 ——
  const openSaveTpl = () => {
    const v = form.getFieldsValue();
    const type = MEDIA_TABS.includes(tab) ? tab : v.type || '短视频脚本';
    const typeLabel = contentTypeLabel(type);
    tplForm.setFieldsValue({
      name: `${typeLabel}·${v.topic || '通用'}模板`,
      type,
      prompt: v.requirement || (v.topic ? `主题：${v.topic}；品牌：${v.brand || '门店品牌'}` : ''),
      tags: [typeLabel, v.brand || '门店品牌', v.topic || '通用'].filter(Boolean).join('，'),
      description: `从当前创作表单保存，适合${typeLabel}场景；调用后会回填到要求描述，可继续修改。`,
      source: '用户保存模板',
    });
    setTplOpen(true);
  };
  const submitTpl = () => {
    tplForm.validateFields().then(v =>
      api.post('/content/templates', v).then(() => {
        message.success('模板已保存');
        setTplOpen(false);
        loadTemplates();
      }),
    );
  };
  const applyTemplate = (t: any) => {
    const apply = (tpl: any) => {
      if (MEDIA_TABS.includes(tpl.type)) {
        setTab(tpl.type);
        setPage(1);
        form.setFieldsValue({ type: tpl.type, requirement: tpl.prompt });
      } else {
        setTab('AI文案');
        setPage(1);
        form.setFieldsValue({ type: COPY_TYPES.includes(tpl.type) ? tpl.type : '短视频脚本', requirement: tpl.prompt });
      }
      message.success(`已调用模板「${tpl.name}」，已回填创作表单`);
      setTplDetail(null);
    };
    if (t.id)
      api
        .post(`/content/templates/${t.id}/use`, {})
        .then((fresh: any) => {
          apply(fresh);
          loadTemplates();
        })
        .catch(() => apply(t));
    else apply(t);
  };

  // —— 素材 ——
  const submitMat = () => {
    matForm.validateFields().then(v =>
      api.post('/content/materials', v).then((m: any) => {
        message.success(`素材已导入${m?.tags ? `，自动标签：${m.tags}` : ''}`);
        setMatOpen(false);
        matForm.resetFields();
        loadMaterials();
      }),
    );
  };

  const importToMaterial = (rec: any) => {
    const key = rec?.jobId ? `job-${rec.jobId}` : `content-${rec?.id}`;
    if (!rec?.id && !rec?.jobId) {
      message.warning('该结果还没有可追溯的入库ID，请先在历史任务中刷新后再导入');
      return;
    }
    if (rec?.jobId) {
      if (rec.canImport === false) {
        message.warning(rec.canImportReason || '媒体技术生成成功不等于业务可用；请等待管理角色人工验收');
        return;
      }
      if (
        rec.canImport !== true &&
        ((rec.technicalStatus || rec.status) !== '成功' ||
          !(rec.previewUrl || rec.url) ||
          !['image', 'video'].includes(rec.kind))
      ) {
        message.warning('媒体任务尚未达到人工验收条件，不能导入素材库');
        return;
      }
    }
    if (!rec?.jobId && !contentFlowReady(rec)) {
      message.warning(contentFlowBlockedReason(rec));
      return;
    }
    setImportingKey(key);
    const url = rec.jobId ? `/content/media-jobs/${rec.jobId}/import-material` : `/content/${rec.id}/import-material`;
    api
      .post(url, {})
      .then((m: any) => {
        if (rec.jobId) {
          message.success(
            m?.reviewRecorded
              ? `已由管理角色人工验收并导入素材库：「${m.name}」`
              : `该媒体已完成人工验收，无需重复入库：「${m.name}」`,
          );
          setResults(current =>
            current.map(item =>
              item.jobId === rec.jobId
                ? {
                    ...item,
                    businessStatus: m.reviewStatus,
                    reviewStatus: m.reviewStatus,
                    businessUsable: m.businessUsable,
                    reviewedBy: m.reviewedBy,
                    reviewedAt: m.reviewedAt,
                    canImport: false,
                    canImportReason: '该媒体已由管理角色人工验收并导入素材库',
                    isImported: true,
                    importedMaterialId: m.id,
                  }
                : item,
            ),
          );
          loadMediaJobs(rec.kind === 'video' ? 'video' : 'image');
        } else {
          message.success(m?.existed ? `素材库已存在「${m.name}」` : `已导入素材库，并自动打标签：${m.tags || '-'}`);
        }
        loadMaterials();
        loadSummary();
      })
      .finally(() => setImportingKey(''));
  };
  const deleteContent = (rec: any) => {
    if (!rec?.id) {
      message.warning('该内容还没有内容ID');
      return;
    }
    api
      .del(`/content/${rec.id}`)
      .then(() => {
        message.success('内容已删除并进入回收站');
        setViewRec(null);
        setRows(prev => prev.filter(x => x.id !== rec.id));
        setResults(prev => prev.filter(x => x.id !== rec.id));
        loadSummary();
        loadPending();
        loadEffectTop();
        refreshList();
        // 删除失败时请求层已弹出服务端具体原因（权限/状态冲突等），此处仅吞掉 rejection 防止 unhandled
      })
      .catch(() => {});
  };
  const deleteTemplate = (tpl: any) => {
    api
      .del(`/content/templates/${tpl.id}`)
      .then(() => {
        message.success('模板已删除并进入回收站');
        setTplDetail(null);
        loadTemplates();
        // 删除失败时请求层已弹出服务端具体原因，此处仅吞掉 rejection 防止 unhandled
      })
      .catch(() => {});
  };
  const deleteMaterial = (mat: any) => {
    api
      .del(`/content/materials/${mat.id}`)
      .then(() => {
        message.success('素材已删除并进入回收站');
        setMatDetail(null);
        loadMaterials();
        loadSummary();
        // 删除失败时请求层已弹出服务端具体原因，此处仅吞掉 rejection 防止 unhandled
      })
      .catch(() => {});
  };

  const toggleMediaJob = (id: number, checked: boolean) => {
    setSelectedMediaJobIds(prev => (checked ? [...new Set([...prev, id])] : prev.filter(x => x !== id)));
  };

  const deleteMediaJobs = (ids: number[], label = '选中的历史任务') => {
    if (!ids.length) {
      message.info('请先选择要删除的历史任务');
      return;
    }
    Modal.confirm({
      title: `删除${label}`,
      content: '只删除已结束且尚未形成内容、素材或资产的历史记录；处理中、待结算或已入库任务会保留。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () =>
        api.post('/content/media-jobs/bulk-delete', { ids }).then((r: any) => {
          if (r.blockedCount) {
            message.warning(`已删除 ${r.deleted || 0} 条，另有 ${r.blockedCount} 条因处理中、待结算或已入库而保留`);
          } else {
            message.success(`已删除 ${r.deleted || 0} 条记录`);
          }
          setSelectedMediaJobIds([]);
          loadMediaJobs(tab === 'AI视频' ? 'video' : 'image');
        }),
    });
  };

  const deleteSingleMediaJob = (j: any) => {
    if (j.canDelete === false) {
      message.warning(j.deleteBlockedReason || '该任务当前不能删除');
      return;
    }
    Modal.confirm({
      title: '删除这条历史任务',
      content: j.prompt || `任务 #${j.id}`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () =>
        api.del(`/content/media-jobs/${j.id}`).then(() => {
          message.success('已删除历史任务');
          setSelectedMediaJobIds(prev => prev.filter(id => id !== j.id));
          loadMediaJobs(tab === 'AI视频' ? 'video' : 'image');
        }),
    });
  };

  const clearFailedMediaJobs = () => {
    const kind = tab === 'AI视频' ? 'video' : 'image';
    Modal.confirm({
      title: `清空失败的历史${tab === 'AI视频' ? '视频' : '生图'}任务`,
      content: '只会删除状态为“失败”的历史记录，成功记录和处理中任务会保留。',
      okText: '清空失败',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () =>
        api.post('/content/media-jobs/bulk-delete', { kind, status: '失败' }).then((r: any) => {
          message.success(`已清空 ${r.deleted || 0} 条失败记录`);
          setSelectedMediaJobIds([]);
          loadMediaJobs(kind);
        }),
    });
  };

  const submitApproval = (rec: any) => {
    if (!rec?.id) {
      message.warning('该内容还没有内容ID，不能提交策略确认');
      return;
    }
    if (!canSubmitApproval(rec)) {
      message.warning(approvalBlockedReason(rec));
      return;
    }
    api.post(`/content/${rec.id}/submit-approval`, {}).then((r: any) => {
      message.success(r.existed ? '该内容已在待确认区' : '已提交策略确认，右侧待确认区会同步显示');
      setViewRec((old: any) => (old?.id === rec.id ? pendingApprovalContent(old) : old));
      setRows(prev => prev.map(x => (x.id === rec.id ? pendingApprovalContent(x) : x)));
      setResults(prev => prev.map(x => (x.id === rec.id ? pendingApprovalContent(x) : x)));
      refreshList();
      loadPending();
    });
  };

  const applySuggestion = (s: any) => {
    const a = s.action || {};
    switchTab(a.tab || 'AI文案');
    form.setFieldsValue({
      type: a.type || '短视频脚本',
      topic: a.topic || briefing?.theme || '',
      requirement: a.requirement || '',
    });
    setSuggestionDetail(null);
    message.success('已把参考模板填入创作表单；请核对真实业务信息后再生成');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // —— 发布登记 ——
  const openPublish = (rec: any) => {
    if (!contentFlowReady(rec)) {
      message.warning(contentFlowBlockedReason(rec));
      return;
    }
    const key =
      globalThis.crypto?.randomUUID?.() ||
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, token => {
        const value = Math.floor(Math.random() * 16);
        return (token === 'x' ? value : (value & 0x3) | 0x8).toString(16);
      });
    setPublishIdempotencyKey(key);
    setPubRec(rec);
    pubForm.setFieldsValue({ channel: rec?.channel || '朋友圈', views: 0, leads: 0 });
  };
  const submitPublish = () => {
    if (!pubRec?.id || !publishIdempotencyKey || publishing) return;
    pubForm.validateFields().then(v => {
      setPublishing(true);
      return api
        .post(`/content/${pubRec.id}/publish-log`, {
          ...v,
          idempotencyKey: publishIdempotencyKey,
        })
        .then((result: any) => {
          message.success(result?.existed ? '该次发布已登记，无需重复累计' : '发布登记成功');
          setPubRec(null);
          setPublishIdempotencyKey('');
          refreshList();
          loadPending();
          loadEffectTop();
          loadSummary();
        })
        .finally(() => setPublishing(false));
    });
  };

  // —— AIPPT 导出：放映版HTML（方向键翻页可全屏）/ Word大纲 ——
  const dl = (blob: Blob, name: string) => {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  const escapeHtml = (value: unknown) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      char =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[char] as string,
    );
  const safeDownloadName = (value: unknown, fallback: string) =>
    Array.from(String(value ?? ''))
      .map(char => (char.charCodeAt(0) <= 31 || /[\\/:*?"<>|]/.test(char) ? '_' : char))
      .join('')
      .trim()
      .slice(0, 100) || fallback;
  const exportDeckHtml = (r: any) => {
    const d = r?.deck || {};
    const pages = Array.isArray(d.pages) ? d.pages : [];
    const slides = [
      `<section class="s cover"><h1>${escapeHtml(d.title)}</h1><p>${escapeHtml(d.subtitle)}</p><footer>纳米Work · 餐饮门店内容生产仓</footer></section>`,
      ...pages.map(
        (p: any, i: number) =>
          `<section class="s"><h2><i>${String(i + 2).padStart(2, '0')}</i>${escapeHtml(p?.title)}</h2><ul>${(Array.isArray(p?.bullets) ? p.bullets : []).map((b: unknown) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>${p?.note ? `<div class="note">💬 ${escapeHtml(p.note)}</div>` : ''}</section>`,
      ),
    ].join('');
    const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(d.title)}</title><style>
:root{--ui-surface-2:#1a1922;--ui-surface:#22212c;--ui-text:#f6f2ea;--ui-text-2:#d8d1c3;--ui-warning-surface:#241c0f}
*{box-sizing:border-box;margin:0}body{font-family:'PingFang SC','Microsoft YaHei',sans-serif;background:#111}
.s{display:none;width:100vw;height:100vh;padding:7vh 9vw;flex-direction:column;justify-content:center;background:linear-gradient(135deg,var(--ui-surface-2),var(--ui-surface));color:var(--ui-text)}
.s.active{display:flex}.cover{background:linear-gradient(135deg,#16264d,#202124);color:#fff;text-align:center;align-items:center}
.cover h1{font-size:5.2vh;letter-spacing:2px}.cover p{margin-top:2.4vh;font-size:2.4vh;opacity:.85}.cover footer{margin-top:8vh;font-size:1.6vh;opacity:.6}
h2{font-size:4vh;border-left:.8vh solid var(--ui-accent);padding-left:2vh;margin-bottom:4vh}h2 i{font-style:normal;color:#d1d1d1;margin-right:1.6vh;font-size:3vh}
ul{list-style:none}li{font-size:2.7vh;line-height:2.1;padding-left:3.4vh;position:relative;color:var(--ui-text-2)}
li:before{content:'';position:absolute;left:.6vh;top:2.4vh;width:1.1vh;height:1.1vh;border-radius:50%;background:#202124}
.note{margin-top:4vh;font-size:1.8vh;color:#cbb887;background:var(--ui-warning-surface);border-radius:1vh;padding:1.4vh 2vh;max-width:70%}
.hud{position:fixed;bottom:2vh;right:3vw;color:#fff;background:rgba(28,36,52,.55);border-radius:2vh;padding:.6vh 2vh;font-size:1.6vh;z-index:9}
</style></head><body>${slides}<div class="hud"></div><script>
let i=0;const ss=[...document.querySelectorAll('.s')],hud=document.querySelector('.hud');
function go(n){i=Math.max(0,Math.min(ss.length-1,n));ss.forEach((s,j)=>s.classList.toggle('active',j===i));hud.textContent=(i+1)+' / '+ss.length+'　←→翻页 F全屏'}
addEventListener('keydown',e=>{if(['ArrowRight','PageDown',' '].includes(e.key))go(i+1);if(['ArrowLeft','PageUp'].includes(e.key))go(i-1);if(e.key==='f'||e.key==='F')document.documentElement.requestFullscreen().catch(()=>{})});
addEventListener('click',()=>go(i+1));go(0);
</script></body></html>`;
    dl(new Blob([html], { type: 'text/html;charset=utf-8' }), `${safeDownloadName(d.title, 'AIPPT')}.html`);
    message.success('放映版已下载：双击打开，←→翻页，F 全屏');
  };
  const exportDeckDoc = (r: any) => {
    const d = r?.deck || {};
    const pages = Array.isArray(d.pages) ? d.pages : [];
    const html = `<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head><body style="font-family:'Microsoft YaHei';">
<h1 style="text-align:center">${escapeHtml(d.title)}</h1><p style="text-align:center;color:#666">${escapeHtml(d.subtitle)}</p><hr/>
${pages.map((p: any, i: number) => `<h2>第${i + 2}页 ${escapeHtml(p?.title)}</h2><ul>${(Array.isArray(p?.bullets) ? p.bullets : []).map((b: unknown) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>${p?.note ? `<p style="color:#996600">演讲备注：${escapeHtml(p.note)}</p>` : ''}`).join('')}
</body></html>`;
    dl(new Blob(['﻿' + html], { type: 'application/msword' }), `${safeDownloadName(d.title, 'AIPPT')}-大纲.doc`);
    message.success('Word大纲已导出');
  };

  const copyText = (text?: string) => {
    navigator.clipboard
      .writeText(text || '')
      .then(() => message.success('已复制到剪贴板'))
      .catch(() => message.warning('复制失败，请手动选择复制'));
  };

  const quicks = [
    {
      label: '一键日更包',
      desc: '生成3脚本+5朋友圈+3话题',
      icon: <ThunderboltOutlined />,
      color: 'var(--ui-accent)',
      run: runDailyPack,
      steps: [
        '读取今日作战主题或当前主题',
        '生成11条内容并做风控扫描',
        '当前 auto 下，所有普通内部内容通过质量与账务门后自动采用；只有显式策略才需人工确认',
        '任务中心与待确认区同步更新；系统不会自动发布',
      ],
    },
    {
      label: '导入素材',
      desc: '人工登记图片/视频/文档',
      icon: <CloudUploadOutlined />,
      color: 'var(--chart-2)',
      run: () => setMatOpen(true),
      steps: [
        '填写素材名称与类型',
        '系统根据名称和类型自动补标签',
        '进入素材调度列表',
        '创作时可选择引用，只有生成成功后引用次数才会增加',
      ],
    },
    {
      label: '调用品牌模板',
      desc: '套用高频提示词',
      icon: <AppstoreOutlined />,
      color: 'var(--chart-3)',
      run: () => {
        const t = [...templates].sort((a, b) => (b.use_count || 0) - (a.use_count || 0))[0];
        if (t) applyTemplate(t);
        else message.info('暂无可用模板，可先在创作区保存模板');
      },
      steps: ['选择使用次数最高的品牌模板', '回填到创作表单的要求描述', '模板使用次数+1', '可继续修改提示词后生成'],
    },
    {
      label: '生成短视频脚本',
      desc: '切到脚本创作表单',
      icon: <VideoCameraOutlined />,
      color: 'var(--warn)',
      run: () => {
        switchTab('AI文案');
        form.setFieldsValue({ type: '短视频脚本' });
        message.info('已选择短视频脚本，填写主题后点击「开始生成」');
      },
      steps: [
        '切换到AI文案频道',
        '创作类型设为短视频脚本',
        '填写主题和要求',
        '生成后可预览；普通内部结果通过门禁后自动采用',
      ],
    },
  ];

  const automationActions = (rule: ContentAutomationRule, compact = false) => (
    <div
      style={
        compact
          ? {
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 8,
              width: '100%',
            }
          : {
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 6,
            }
      }
    >
      {productionMode === 'scheduled' && (
        <Tooltip
          title={
            rule.taskTypeValid === false && !rule.enabled
              ? '当前交付形式不属于这名内容员工的岗位范围；请先编辑规则并选择可执行的交付形式'
              : rule.enabled
                ? '停用后不会继续定时运行'
                : '启用后重新计算下次运行时间'
          }
        >
          <div
            style={
              compact
                ? {
                    minHeight: 32,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    border: '1px solid var(--ui-border)',
                    borderRadius: 6,
                    background: 'var(--ui-surface)',
                  }
                : undefined
            }
          >
            <Switch
              size="small"
              checked={rule.enabled}
              checkedChildren="启用"
              unCheckedChildren="停用"
              disabled={rule.taskTypeValid === false && !rule.enabled}
              onChange={enabled => toggleAutomation(rule, enabled)}
            />
            {compact && (
              <span style={{ fontSize: 12, color: 'var(--ui-text-2)' }}>
                {rule.enabled ? '定时已启用' : '定时已停用'}
              </span>
            )}
          </div>
        </Tooltip>
      )}
      <Tooltip
        title={
          rule.taskTypeValid === false
            ? '当前交付形式不属于这名内容员工的岗位范围；请先编辑规则并选择可执行的交付形式'
            : automationRunningId !== null && automationRunningId !== rule.id
              ? '已有另一条自动任务正在运行，请等待它结束后再启动'
              : ''
        }
      >
        <span style={compact ? { width: '100%' } : undefined}>
          <Button
            size="small"
            type="primary"
            ghost
            icon={<ThunderboltOutlined />}
            style={compact ? { width: '100%' } : undefined}
            loading={automationRunningId === rule.id}
            disabled={rule.taskTypeValid === false || (automationRunningId !== null && automationRunningId !== rule.id)}
            onClick={() => runAutomationNow(rule)}
          >
            立即运行
          </Button>
        </span>
      </Tooltip>
      <Button
        size="small"
        icon={<EditOutlined />}
        style={compact ? { width: '100%' } : undefined}
        onClick={() => openAutomationEditor(rule)}
      >
        编辑
      </Button>
      {productionMode === 'scheduled' && (
        <Popconfirm
          title={`删除规则「${rule.name}」？`}
          description="规则和运行日志会删除，已经生成的内容会保留。"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => deleteAutomation(rule)}
        >
          <Button size="small" danger icon={<DeleteOutlined />} style={compact ? { width: '100%' } : undefined}>
            删除
          </Button>
        </Popconfirm>
      )}
    </div>
  );

  return (
    <div className="content-factory-page">
      <header className="content-command-head">
        <div>
          <span className="content-command-kicker">PAIHUO · CONTENT COMMAND</span>
          <h1>内容生产仓</h1>
          <p>选一个数字员工，说清这次要解决什么；岗位会自动调用技能、知识库和联网工具，普通结果完成后直接可用。</p>
        </div>
        <div className="content-command-side">
          <Button
            type="primary"
            size="large"
            icon={<TeamOutlined />}
            onClick={() => {
              setPipelineFocusId(null);
              setPipelineOpen(true);
            }}
          >
            完整团队流水线
          </Button>
          <dl className="content-command-metrics" aria-label="内容生产状态">
            <div>
              <dt>在岗员工</dt>
              <dd>{crewLoading ? '—' : contentCrew.length}</dd>
            </div>
            <div>
              <dt>自动规则</dt>
              <dd>{automationLoading ? '—' : automationRules.filter(rule => rule.enabled).length}</dd>
            </div>
            <div data-state={totalPendingReviewCount > 0 ? 'attention' : 'quiet'}>
              <dt>历史/策略待处理</dt>
              <dd>{totalPendingReviewCount}</dd>
            </div>
          </dl>
        </div>
      </header>

      <section className="content-crew-command" aria-labelledby="content-crew-title">
        <header className="content-crew-head">
          <div>
            <span>岗位目录 · 每位员工都可以单独派活</span>
            <h2 id="content-crew-title">内容数字员工</h2>
          </div>
          <span className={`content-crew-connection ${crewConnected ? 'connected' : ''}`}>
            <i aria-hidden="true" />
            {crewLoading ? '连接中' : crewConnected ? `${contentCrew.length} 位在岗` : '等待接口'}
          </span>
        </header>
        <div className="content-crew-grid" aria-label="内容数字员工">
          {contentCrew.map(station => {
            const outputs = Number(station.runtime?.outputs || 0) + Number(station.runtime?.mediaJobs || 0);
            return (
              <article
                className="content-crew-card"
                key={station.key}
                style={station.color ? ({ '--dept': station.color } as CSSProperties) : undefined}
              >
                <header className="content-crew-card-head">
                  {station.employeeIdx != null ? (
                    <EmployeeAvatar
                      idx={station.employeeIdx}
                      name={station.person || station.name}
                      color={station.color || '#7a5bd8'}
                      size={50}
                    />
                  ) : (
                    <span className="content-crew-icon" aria-hidden="true">
                      {crewStationIcon(station.key)}
                    </span>
                  )}
                  <div className="content-crew-card-identity">
                    <h3>{station.person || station.name}</h3>
                    <span>{station.name}</span>
                    <small>
                      {station.employeeIdx != null
                        ? `工位 ${String(station.order + 1).padStart(2, '0')}`
                        : '岗位待绑定'}{' '}
                      · {station.optional ? '按需岗位' : '核心岗位'}
                    </small>
                  </div>
                  <span className={`content-crew-card-state${outputs > 0 ? ' has-output' : ''}`}>
                    {outputs > 0 ? `${outputs} 份产出` : '待命'}
                  </span>
                </header>
                <p className="content-crew-card-duty">{station.intro || station.duty || '岗位职责正在同步。'}</p>
                {(station.capabilityCount || station.skillCount || null) && (
                  <button
                    type="button"
                    className="content-crew-card-powers"
                    title="点击打开工作台查看完整能力与技能"
                    aria-label={`查看${station.person || station.name}的完整能力与技能`}
                    disabled={station.employeeIdx == null}
                    onClick={() => {
                      setCrewWorkbenchRunId(null);
                      setCrewWorkbenchIdx(station.employeeIdx);
                    }}
                  >
                    <span>
                      能力 {station.capabilityCount || 0} · 技能 {station.skillCount || 0}
                    </span>
                    {(station.capabilityNames || []).slice(0, 2).map(name => (
                      <em key={name}>{name}</em>
                    ))}
                  </button>
                )}
                <div className="content-crew-card-deliverables" aria-label="常用交付">
                  {(station.taskTypes || []).slice(0, 3).map(taskType => (
                    <span key={taskType}>{taskType}</span>
                  ))}
                  {canViewCrewInternals && station.approval && (
                    <span className="content-crew-card-approval">
                      {crewAdoptionLabel(station.approval, getUser()?.role)}
                    </span>
                  )}
                </div>
                <div className="content-crew-card-actions">
                  <Tooltip title={station.employeeIdx == null ? '该岗位尚未同步数字员工编号，暂时不能打开工作台' : ''}>
                    <Button
                      type="primary"
                      block={station.key !== 'commerce_video'}
                      icon={<TeamOutlined />}
                      disabled={station.employeeIdx == null}
                      onClick={() => {
                        setCrewWorkbenchRunId(null);
                        setCrewWorkbenchIdx(station.employeeIdx);
                      }}
                    >
                      单独派活
                    </Button>
                  </Tooltip>
                  {station.key === 'commerce_video' && (
                    <Button icon={<VideoCameraOutlined />} onClick={() => setSalesVideoOpen(true)}>
                      30秒带货视频
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <ContentEmployeeTaskCenter
        refreshToken={employeeTaskRefreshToken}
        onData={receiveEmployeeTaskQueue}
        onOpenRun={openContentEmployeeRun}
      />

      <WechatDraftStudio />

      <AiSalesVideoPanel
        open={salesVideoOpen}
        onOpenChange={setSalesVideoOpen}
        initialJobId={requestedMediaJobId}
        refImgs={refImgs}
        setRefImgs={setRefImgs}
        onPickRef={onPickRef}
        loadMaterials={loadMaterials}
        loadSummary={loadSummary}
        loadMediaJobs={loadMediaJobs}
        onTaskSubmitted={() => setEmployeeTaskRefreshToken(value => value + 1)}
      />

      <EmployeeWorkbench
        open={crewWorkbenchIdx !== null}
        domain="content"
        idx={crewWorkbenchIdx}
        initialRunId={crewWorkbenchRunId}
        identityHint={(() => {
          const station = contentCrew.find(item => item.employeeIdx === crewWorkbenchIdx);
          return station
            ? {
                idx: station.employeeIdx ?? station.order,
                name: station.name,
                person: station.person,
                group: station.group,
                emoji: station.emoji,
                color: station.color,
                duty: station.duty,
                intro: station.intro,
              }
            : null;
        })()}
        onClose={() => {
          setCrewWorkbenchIdx(null);
          setCrewWorkbenchRunId(null);
          setEmployeeTaskRefreshToken(value => value + 1);
          loadMaterials();
          loadSummary();
          loadPending();
          loadPipelinePendingReviews();
          loadEffectTop();
          loadList();
        }}
      />

      <ContentPipelineWorkbench
        open={pipelineOpen}
        crew={contentCrew}
        initialPipelineId={pipelineFocusId}
        onClose={() => {
          setPipelineOpen(false);
          loadPipelinePendingReviews();
        }}
      />

      <Panel
        title={
          <>
            <ClockCircleOutlined style={{ color: 'var(--ui-accent)' }} /> 内容生产方式
          </>
        }
        extra={
          automationAccess && productionMode !== 'manual' ? (
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => openAutomationEditor()}>
              新建自动规则
            </Button>
          ) : null
        }
      >
        <Row gutter={[10, 10]}>
          {[
            {
              key: 'manual' as ProductionMode,
              icon: <EditOutlined />,
              title: '手动创作',
              desc: '人工填写主题与要求，确认后生成。',
            },
            {
              key: 'immediate' as ProductionMode,
              icon: <ThunderboltOutlined />,
              title: '立即自动',
              desc: '选择已保存规则，立即运行一次。',
            },
            {
              key: 'scheduled' as ProductionMode,
              icon: <CalendarOutlined />,
              title: '定时任务',
              desc: '按每日或每周计划自动生成。',
            },
          ].map(item => {
            const active = productionMode === item.key;
            return (
              <Col xs={24} md={8} key={item.key}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => setProductionMode(item.key)}
                  style={{
                    width: '100%',
                    minHeight: 82,
                    textAlign: 'left',
                    cursor: 'pointer',
                    borderRadius: 10,
                    padding: '12px 14px',
                    font: 'inherit',
                    border: active ? '1.5px solid var(--ui-accent)' : '1px solid var(--ui-border)',
                    background: active ? 'var(--ui-primary-soft)' : 'var(--ui-surface)',
                    color: 'var(--ui-text)',
                    boxShadow: 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 750 }}>
                    <span style={{ color: active ? 'var(--ui-accent)' : 'var(--ui-text-2)', fontSize: 16 }}>
                      {item.icon}
                    </span>
                    {item.title}
                    {active && (
                      <Tag color="blue" style={{ margin: 0 }}>
                        当前
                      </Tag>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginTop: 7, lineHeight: 1.6 }}>
                    {item.desc}
                  </div>
                </button>
              </Col>
            );
          })}
        </Row>
        <Alert
          showIcon
          type={productionMode === 'manual' ? 'info' : 'warning'}
          style={{ marginTop: 12 }}
          message={
            productionMode === 'manual'
              ? '手动创作：由当前操作人确认输入后生成'
              : productionMode === 'immediate'
                ? '立即自动：手动点击一次，系统按已保存规则完整运行'
                : '定时任务：系统按上海时区检查到期规则'
          }
          description={
            productionMode === 'manual'
              ? '下方保留原有文案、图片、视频、PPT、素材和模板工作台。'
              : '当前 auto 下，所有普通内部结果通过质量与账务门后自动采用；只有显式配置的策略确认才会进入待处理。系统绝不会自动发布、操作外部账号、真实付费或执行其他不可逆动作。'
          }
        />

        {productionMode !== 'manual' && (
          <div style={{ marginTop: 12 }}>
            {!automationAccess ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="只有老板或管理人员可以查看和管理内容自动化；普通员工仍可使用下方手动创作。"
              />
            ) : useAutomationCards ? (
              <Spin spinning={automationLoading}>
                {automationRules.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无自动规则，先新建一条" />
                ) : (
                  <div role="list" aria-label="内容自动化规则" style={{ display: 'grid', gap: 10 }}>
                    {automationRules.map(rule => (
                      <Card
                        key={rule.id}
                        role="listitem"
                        size="small"
                        style={{ borderRadius: 10, borderColor: 'var(--ui-border)' }}
                        styles={{ body: { padding: 14 } }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            justifyContent: 'space-between',
                            gap: 10,
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 700, color: 'var(--ui-text)', overflowWrap: 'anywhere' }}>
                              {rule.name}
                            </div>
                            <div
                              style={{
                                fontSize: 12,
                                color: 'var(--ui-text-2)',
                                marginTop: 4,
                                lineHeight: 1.6,
                                overflowWrap: 'anywhere',
                              }}
                            >
                              {contentTypeLabel(rule.contentType)} · {rule.topic} · {rule.contentCount}份
                            </div>
                          </div>
                          {rule.lastStatus ? (
                            <Tooltip
                              title={rule.lastError || (rule.lastContentId ? `内容 #${rule.lastContentId}` : '')}
                            >
                              <Tag
                                color={AUTOMATION_STATUS_COLOR[rule.lastStatus] || 'default'}
                                style={{ margin: 0, flexShrink: 0 }}
                              >
                                {rule.lastStatus}
                              </Tag>
                            </Tooltip>
                          ) : (
                            <Tag style={{ margin: 0, flexShrink: 0 }}>未运行</Tag>
                          )}
                        </div>
                        <AutomationFailureReason reason={automationVisibleFailure(rule)} prefix />
                        {rule.taskTypeValid === false && (
                          <Tag color="red" style={{ marginTop: 8 }}>
                            任务类型与员工岗位不匹配，需编辑
                          </Tag>
                        )}
                        <div
                          style={{
                            marginTop: 12,
                            padding: '10px 12px',
                            borderRadius: 8,
                            background: 'var(--ui-surface-2)',
                            display: 'grid',
                            gap: 7,
                            fontSize: 12,
                            color: 'var(--ui-text-2)',
                          }}
                        >
                          <div>
                            <span style={{ color: 'var(--ui-muted)' }}>内容员工：</span>#{rule.employeeIdx} ·{' '}
                            {rule.employee?.contentEmployeeName || '内容员工'}
                            {rule.employee?.contentEmployeeGroup ? `（${rule.employee.contentEmployeeGroup}）` : ''}
                          </div>
                          <div>
                            <span style={{ color: 'var(--ui-muted)' }}>执行计划：</span>
                            {rule.frequency === 'daily' ? '每天' : WEEKDAY_LABELS[rule.weekday || 0]} {rule.runTime}
                            {' · '}
                            {automationApprovalModeLabel(rule.approvalMode)}
                          </div>
                          <div>
                            <span style={{ color: 'var(--ui-muted)' }}>下次运行：</span>
                            {rule.enabled && rule.nextRunAt ? rule.nextRunAt.slice(0, 16) : '已停用'}
                          </div>
                          <div>
                            <span style={{ color: 'var(--ui-muted)' }}>最近运行：</span>
                            {rule.lastRunAt ? rule.lastRunAt.slice(0, 16) : '尚未运行'}
                          </div>
                        </div>
                        <div style={{ marginTop: 12 }}>{automationActions(rule, true)}</div>
                      </Card>
                    ))}
                  </div>
                )}
              </Spin>
            ) : (
              <Table<ContentAutomationRule>
                size="small"
                rowKey="id"
                loading={automationLoading}
                dataSource={automationRules}
                scroll={{ x: 1040 }}
                pagination={false}
                locale={{
                  emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无自动规则，先新建一条" />,
                }}
                columns={[
                  {
                    title: '规则 / 内容',
                    width: 230,
                    render: (_value, rule) => (
                      <div>
                        <div style={{ fontWeight: 700, color: 'var(--ui-text)' }}>{rule.name}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--ui-text-2)', marginTop: 3 }}>
                          {contentTypeLabel(rule.contentType)} · {rule.topic} · {rule.contentCount}份
                        </div>
                        {rule.taskTypeValid === false && (
                          <Tag color="red" style={{ marginTop: 5 }}>
                            任务类型与员工岗位不匹配，需编辑
                          </Tag>
                        )}
                      </div>
                    ),
                  },
                  {
                    title: '内容员工',
                    width: 150,
                    render: (_value, rule) => (
                      <Tooltip title={rule.employee?.contentEmployeeGroup || ''}>
                        <Tag color="purple">
                          #{rule.employeeIdx} · {rule.employee?.contentEmployeeName || '内容员工'}
                        </Tag>
                      </Tooltip>
                    ),
                  },
                  {
                    title: productionMode === 'scheduled' ? '计划' : '规则计划',
                    width: 145,
                    render: (_value, rule) => (
                      <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                        <div>
                          {rule.frequency === 'daily' ? '每天' : WEEKDAY_LABELS[rule.weekday || 0]} {rule.runTime}
                        </div>
                        <div style={{ color: 'var(--ui-muted)' }}>{automationApprovalModeLabel(rule.approvalMode)}</div>
                      </div>
                    ),
                  },
                  {
                    title: '下次 / 最近',
                    width: 200,
                    render: (_value, rule) => (
                      <div style={{ fontSize: 11.5, lineHeight: 1.7 }}>
                        <div>下次：{rule.enabled && rule.nextRunAt ? rule.nextRunAt.slice(0, 16) : '已停用'}</div>
                        <div style={{ color: 'var(--ui-muted)' }}>
                          最近：{rule.lastRunAt ? rule.lastRunAt.slice(0, 16) : '尚未运行'}
                        </div>
                      </div>
                    ),
                  },
                  {
                    title: '最近状态',
                    width: 220,
                    render: (_value, rule) => (
                      <div>
                        {rule.lastStatus ? (
                          <Tooltip title={rule.lastError || (rule.lastContentId ? `内容 #${rule.lastContentId}` : '')}>
                            <Tag color={AUTOMATION_STATUS_COLOR[rule.lastStatus] || 'default'}>{rule.lastStatus}</Tag>
                          </Tooltip>
                        ) : (
                          <Tag>未运行</Tag>
                        )}
                        <AutomationFailureReason reason={automationVisibleFailure(rule)} />
                      </div>
                    ),
                  },
                  {
                    title: '操作',
                    width: productionMode === 'scheduled' ? 270 : 190,
                    render: (_value, rule) => automationActions(rule),
                  },
                ]}
              />
            )}
          </div>
        )}
      </Panel>

      {/* 内容业务概览：媒体能力由数字员工调用，不再作为并列产品入口。 */}
      <Row gutter={[12, 12]}>
        <Col flex="1 1 176px" style={{ minWidth: 0 }}>
          <StatCard
            icon={<FileTextOutlined />}
            color="var(--ui-accent)"
            label="本月可用内容"
            value={summary.total ?? '-'}
            suffix="条"
            onClick={() => switchTab('AI文案')}
          />
        </Col>
        <Col flex="1 1 176px" style={{ minWidth: 0 }}>
          <StatCard
            icon={<TeamOutlined />}
            color="var(--chart-2)"
            label="数字员工任务"
            value={employeeTaskQueue?.visibleTotal ?? '-'}
            suffix="项"
            onClick={() =>
              document.getElementById('content-employee-task-center')?.scrollIntoView({ behavior: 'smooth' })
            }
          />
        </Col>
        <Col flex="1 1 176px" style={{ minWidth: 0 }}>
          <StatCard
            icon={<FolderOpenOutlined />}
            color="var(--chart-3)"
            label="素材资产"
            value={materials.length}
            suffix="份"
            onClick={() => switchTab('素材库')}
          />
        </Col>
        <Col flex="1 1 176px" style={{ minWidth: 0 }}>
          <StatCard
            icon={<ClockCircleOutlined />}
            color="var(--warn)"
            label="自动任务"
            value={automationRules.filter(rule => rule.enabled).length}
            suffix="条"
            onClick={() => setAutomationOpen(true)}
          />
        </Col>
      </Row>

      {/* 创作类型 Tabs */}
      <Card size="small" style={{ borderRadius: 10 }} styles={{ body: { padding: '10px 14px' } }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div
            role="group"
            aria-label="内容创作频道"
            style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
          >
            {TABS.map(t => {
              const selected = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => switchTab(t.key)}
                  style={{
                    padding: '6px 16px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    font: 'inherit',
                    fontSize: 13,
                    lineHeight: 1.5,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    border: `1px solid ${selected ? 'var(--ui-primary)' : 'var(--ui-border)'}`,
                    fontWeight: selected ? 600 : 400,
                    background: selected ? 'var(--ui-primary)' : 'var(--ui-surface-2)',
                    color: selected ? 'var(--ui-on-primary)' : 'var(--ui-text-2)',
                  }}
                >
                  {t.icon}
                  {t.key}
                </button>
              );
            })}
          </div>
          <div style={{ marginLeft: 'auto' }}>
            {summary.aiMode === 'api' ? (
              <Tag color="green" style={{ marginRight: 0 }}>
                <RobotOutlined /> AI引擎在线
              </Tag>
            ) : (
              <Tag color="orange" style={{ marginRight: 0 }}>
                <RobotOutlined /> 模板底稿模式
              </Tag>
            )}
          </div>
        </div>
      </Card>

      <Row gutter={[12, 12]}>
        {/* 主创作区（左 2/3） */}
        <Col xs={24} lg={16}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {tab === '素材库' ? (
              <Panel
                title={
                  <>
                    <FolderOpenOutlined style={{ color: 'var(--ui-accent)' }} /> 素材库
                  </>
                }
                extra={
                  <Button type="primary" size="small" icon={<CloudUploadOutlined />} onClick={() => setMatOpen(true)}>
                    导入素材
                  </Button>
                }
              >
                <Table
                  size="small"
                  rowKey="id"
                  dataSource={materials}
                  onRow={r => ({ onClick: () => setMatDetail(r) })}
                  pagination={{ pageSize: 10, size: 'small', hideOnSinglePage: true }}
                  columns={[
                    {
                      title: '素材名称',
                      dataIndex: 'name',
                      render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span>,
                    },
                    {
                      title: '类型',
                      dataIndex: 'type',
                      width: 90,
                      render: (v: string) => <Tag color="blue">{contentTypeLabel(v)}</Tag>,
                    },
                    {
                      title: '标签',
                      dataIndex: 'tags',
                      render: (v: any) => {
                        const arr = splitTags(v);
                        return arr.length ? (
                          arr.slice(0, 4).map((x: string) => <Tag key={x}>{x}</Tag>)
                        ) : (
                          <span style={{ color: 'var(--ui-muted)' }}>-</span>
                        );
                      },
                    },
                    {
                      title: '来源',
                      width: 110,
                      render: (_: any, r: any) => (
                        <Tag color={r.source_type === 'manual' ? 'default' : 'purple'}>
                          {sourceLabel(r.source_type)}
                        </Tag>
                      ),
                    },
                    {
                      title: '使用次数',
                      dataIndex: 'use_count',
                      align: 'right',
                      width: 90,
                      render: (v: number) => (
                        <span style={{ fontWeight: 600, color: 'var(--ui-accent)' }}>{v ?? 0}</span>
                      ),
                    },
                    {
                      title: '操作',
                      width: 132,
                      render: (_: any, r: any) => (
                        <Space size={4} onClick={e => e.stopPropagation()}>
                          <button type="button" className="ui-link-button" onClick={() => applyMaterial(r)}>
                            引用
                          </button>
                          <Popconfirm
                            title={`删除素材「${r.name}」？`}
                            description="删除后进入回收站，老板/管理员可恢复。"
                            okText="删除"
                            cancelText="取消"
                            okButtonProps={{ danger: true }}
                            onConfirm={() => deleteMaterial(r)}
                          >
                            <Button size="small" type="link" danger icon={<DeleteOutlined />} style={{ padding: 0 }}>
                              删除
                            </Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]}
                />
              </Panel>
            ) : tab === '模板库' ? (
              <Panel
                title={
                  <>
                    <AppstoreOutlined style={{ color: 'var(--ui-accent)' }} /> 模板库
                  </>
                }
                extra={
                  <Button type="primary" size="small" icon={<SaveOutlined />} onClick={openSaveTpl}>
                    保存当前为模板
                  </Button>
                }
              >
                <Table
                  size="small"
                  rowKey="id"
                  dataSource={templates}
                  onRow={r => ({ onClick: () => setTplDetail(r) })}
                  pagination={{ pageSize: 10, size: 'small', hideOnSinglePage: true }}
                  columns={[
                    {
                      title: '模板名称',
                      dataIndex: 'name',
                      render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span>,
                    },
                    {
                      title: '适用类型',
                      dataIndex: 'type',
                      width: 110,
                      render: (v: string) => <Tag color={TYPE_META[v]?.color || 'blue'}>{contentTypeLabel(v)}</Tag>,
                    },
                    {
                      title: '标签/来源',
                      width: 220,
                      render: (_: any, r: any) => (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {splitTags(r.tags)
                            .slice(0, 3)
                            .map((x: string) => (
                              <Tag key={x} style={{ margin: 0 }}>
                                {contentTypeLabel(x)}
                              </Tag>
                            ))}
                          {r.source && (
                            <Tag color="purple" style={{ margin: 0 }}>
                              {r.source}
                            </Tag>
                          )}
                        </div>
                      ),
                    },
                    {
                      title: '提示词',
                      dataIndex: 'prompt',
                      render: (v: string) => (
                        <Tooltip title={v}>
                          <span style={{ display: 'inline-block', maxWidth: 240, verticalAlign: 'bottom', ...ell }}>
                            {v}
                          </span>
                        </Tooltip>
                      ),
                    },
                    { title: '使用次数', dataIndex: 'use_count', align: 'right', width: 90 },
                    {
                      title: '操作',
                      width: 140,
                      render: (_: any, r: any) => (
                        <Space size={4} onClick={e => e.stopPropagation()}>
                          <button type="button" className="ui-link-button" onClick={() => applyTemplate(r)}>
                            使用
                          </button>
                          <Popconfirm
                            title={`删除模板「${r.name}」？`}
                            description="删除后进入回收站，老板/管理员可恢复。"
                            okText="删除"
                            cancelText="取消"
                            okButtonProps={{ danger: true }}
                            onConfirm={() => deleteTemplate(r)}
                          >
                            <Button size="small" type="link" danger icon={<DeleteOutlined />} style={{ padding: 0 }}>
                              删除
                            </Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]}
                />
              </Panel>
            ) : (
              <>
                {/* 媒体模板库：真实示意配图，点选套用（图/视频/PPT） */}
                {['AI图片', 'AI视频', 'AIPPT'].includes(tab) && (
                  <Panel
                    title={
                      <>
                        <AppstoreOutlined style={{ color: 'var(--chart-3)' }} /> {tab}模板库（点击套用，主题可改）
                      </>
                    }
                    extra={
                      <Space size={8}>
                        {selTpl ? (
                          <Tag
                            color="purple"
                            closable
                            onClose={() => {
                              setSelTpl(null);
                              setMediaPromptText('');
                            }}
                          >
                            已选：{selTpl.name}
                          </Tag>
                        ) : (
                          <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>
                            {mediaTemplateList.length} 个真实模板
                          </span>
                        )}
                        <Button
                          size="small"
                          type="text"
                          icon={mediaTemplatesExpanded ? <UpOutlined /> : <DownOutlined />}
                          onClick={() => setMediaTemplatesExpanded(v => !v)}
                        >
                          {mediaTemplatesExpanded ? '收起模板' : '展开模板'}
                        </Button>
                      </Space>
                    }
                  >
                    {mediaTemplatesExpanded && (
                      <>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                          <Select
                            size="small"
                            allowClear
                            placeholder="全部分类"
                            value={mediaTagFilter || undefined}
                            style={{ minWidth: 140 }}
                            onChange={v => setMediaTagFilter(v || '')}
                            options={mediaTagOptions.map(x => ({ value: x, label: x }))}
                          />
                          <Select
                            size="small"
                            allowClear
                            placeholder="全部场景"
                            value={mediaSceneFilter || undefined}
                            style={{ minWidth: 180 }}
                            onChange={v => setMediaSceneFilter(v || '')}
                            options={mediaSceneOptions.map(x => ({ value: x, label: x }))}
                          />
                          {(mediaTagFilter || mediaSceneFilter) && (
                            <Button
                              size="small"
                              onClick={() => {
                                setMediaTagFilter('');
                                setMediaSceneFilter('');
                              }}
                            >
                              重置筛选
                            </Button>
                          )}
                        </div>
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))',
                            gap: 10,
                          }}
                        >
                          {filteredMediaTemplates.map(t => (
                            <button
                              type="button"
                              key={t.id}
                              onClick={() => applyMediaTpl(t)}
                              style={{
                                ...interactiveSurfaceStyle,
                                cursor: 'pointer',
                                borderRadius: 10,
                                overflow: 'hidden',
                                position: 'relative',
                                border:
                                  selTpl?.id === t.id ? '2px solid var(--ui-accent)' : '1px solid var(--ui-border)',
                                boxShadow:
                                  selTpl?.id === t.id
                                    ? '0 4px 14px rgba(43,109,239,.22)'
                                    : '0 1px 4px rgba(28,36,52,.06)',
                                transition: 'all .2s',
                                background: 'var(--ui-surface)',
                              }}
                            >
                              <div
                                style={{ position: 'relative', paddingTop: '62%', background: 'var(--ui-surface-2)' }}
                              >
                                <img
                                  src={t.cover}
                                  alt={t.name}
                                  loading="lazy"
                                  style={{
                                    position: 'absolute',
                                    inset: 0,
                                    width: '100%',
                                    height: '100%',
                                    objectFit: 'cover',
                                  }}
                                  onError={e => {
                                    const img = e.currentTarget as HTMLImageElement & { dataset: DOMStringMap };
                                    if (!img.dataset.fallback && t.fallbackCover) {
                                      img.dataset.fallback = '1';
                                      img.src = t.fallbackCover;
                                    } else {
                                      img.style.display = 'none';
                                    }
                                  }}
                                />
                                {selTpl?.id === t.id && (
                                  <div
                                    style={{
                                      position: 'absolute',
                                      top: 6,
                                      right: 6,
                                      background: 'var(--ui-primary)',
                                      color: 'var(--ui-on-primary)',
                                      borderRadius: 10,
                                      fontSize: 10.5,
                                      padding: '1px 8px',
                                      fontWeight: 600,
                                    }}
                                  >
                                    ✓ 已套用
                                  </div>
                                )}
                              </div>
                              <div style={{ padding: '7px 9px 8px' }}>
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
                                  {t.name}
                                </div>
                                <div
                                  style={{
                                    fontSize: 10.5,
                                    color: 'var(--ui-muted)',
                                    marginTop: 2,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                  }}
                                >
                                  {t.scene}
                                </div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 5, minHeight: 18 }}>
                                  {t.tags.slice(0, 2).map(x => (
                                    <Tag key={x} style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>
                                      {x}
                                    </Tag>
                                  ))}
                                </div>
                              </div>
                            </button>
                          ))}
                          {filteredMediaTemplates.length === 0 && (
                            <div style={{ gridColumn: '1 / -1', padding: '18px 0' }}>
                              <Empty
                                image={Empty.PRESENTED_IMAGE_SIMPLE}
                                description="没有匹配的模板，换个分类或场景试试"
                              />
                            </div>
                          )}
                        </div>
                        {selTpl && (
                          <div
                            style={{
                              marginTop: 12,
                              background: 'var(--ui-surface-2)',
                              border: '1px solid var(--ui-border)',
                              borderRadius: 10,
                              padding: 12,
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                gap: 8,
                                flexWrap: 'wrap',
                                marginBottom: 8,
                              }}
                            >
                              <div>
                                <div style={{ fontWeight: 700, color: 'var(--ui-text)' }}>{selTpl.name}</div>
                                <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginTop: 2 }}>
                                  {selTpl.description || selTpl.scene}
                                </div>
                              </div>
                              <Button size="small" onClick={() => setTplDetail(selTpl)}>
                                查看完整模板
                              </Button>
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
                              {selTpl.tags.map(x => (
                                <Tag key={x} color="blue" style={{ margin: 0 }}>
                                  {x}
                                </Tag>
                              ))}
                              {selTpl.source && (
                                <Tag color="purple" style={{ margin: 0 }}>
                                  {selTpl.source}
                                </Tag>
                              )}
                            </div>
                            <Input.TextArea
                              value={mediaPromptText}
                              onChange={e => setMediaPromptText(e.target.value)}
                              rows={selTpl.tab === 'AIPPT' ? 5 : 4}
                              showCount
                              maxLength={1200}
                              placeholder="这里是模板提示词，生成前可直接修改。"
                            />
                            <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--ui-muted)', lineHeight: 1.7 }}>
                              {selTpl.parameters && <div>生成参数：{selTpl.parameters}</div>}
                              {selTpl.negativePrompt && <div>负向约束：{selTpl.negativePrompt}</div>}
                              {selTpl.extra && (
                                <div>
                                  {selTpl.tab === 'AIPPT' ? '结构说明' : '镜头节奏'}：{selTpl.extra}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                    {!mediaTemplatesExpanded && (
                      <div style={{ fontSize: 12, color: 'var(--ui-muted)' }}>
                        模板库已收起，不影响自由创作；需要套用时展开选择。
                      </div>
                    )}
                  </Panel>
                )}

                {/* 创作表单 */}
                <Panel
                  title={
                    <>
                      <RobotOutlined style={{ color: 'var(--ui-accent)' }} /> 手动创作工作台
                    </>
                  }
                  extra={<span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>当前频道：{tab}</span>}
                >
                  {tab === 'AI图片' && (
                    <Alert
                      showIcon
                      icon={<BulbOutlined />}
                      type="success"
                      style={{ marginBottom: 14 }}
                      message="真实生图通道（gpt-image-2 · 云雾API），按张计费扣积分；主题+要求描述合并为绘图提示词。上传参考图 = 图生图（按图改图）"
                    />
                  )}
                  {tab === 'AI视频' && (
                    <Alert
                      showIcon
                      icon={<BulbOutlined />}
                      type="success"
                      style={{ marginBottom: 14 }}
                      message={
                        videoModels.canViewPrice
                          ? `真实视频通道按积分分为三档：${videoTierSummary || '快速 / 标准 / 高质量'}；已接入模型可生成，待接入模型只展示缩写和成本，不可选择。上传首帧图 = 图生视频。`
                          : `请选择视频生成档次和模型缩写：${videoTierSummary || '快速 / 标准 / 高质量'}。灰色“待接入”模型不可选；视频生成需数分钟，请在下方列表刷新查看。`
                      }
                    />
                  )}
                  {tab === 'AIPPT' && (
                    <Alert
                      showIcon
                      icon={<BulbOutlined />}
                      type="success"
                      style={{ marginBottom: 14 }}
                      message="结构化PPT生成：选模板→AI逐页产出标题/要点/演讲备注→幻灯片预览→可下载放映版(HTML全屏翻页)或Word大纲；生成条数=页数"
                    />
                  )}
                  {isMedia && !['AI图片', 'AI视频', 'AIPPT'].includes(tab) && (
                    <Alert
                      showIcon
                      icon={<BulbOutlined />}
                      type="info"
                      style={{ marginBottom: 14 }}
                      message={`${tab} 生成结果将以「提示词 + 大纲」形式输出，可直接复制到${tab.replace('AI', '')}生产工具使用`}
                    />
                  )}
                  {activePromptGuide && (
                    <div
                      style={{
                        border: '1px solid var(--ui-border-strong)',
                        background: 'var(--ui-surface)',
                        borderRadius: 10,
                        padding: '10px 12px',
                        marginBottom: 14,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: 10,
                          flexWrap: 'wrap',
                          alignItems: 'center',
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, color: 'var(--ui-text)' }}>
                            {activePromptGuide.name}
                            <Tag
                              color="blue"
                              style={{ marginLeft: 8, fontFamily: 'Consolas,Menlo,monospace', fontSize: 11 }}
                            >
                              {activePromptGuide.code}
                            </Tag>
                            {activePromptGuide.overridden && <Tag color="green">本企业已覆盖</Tag>}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginTop: 4, ...ell }}>
                            生成逻辑：
                            {activePromptGuide.output_rule ||
                              activePromptGuide.role_card ||
                              '已纳入系统提示词，可点击查看完整逻辑'}
                          </div>
                        </div>
                        <Space size={8}>
                          <Button size="small" onClick={() => setPromptGuideDetail(activePromptGuide)}>
                            查看提示词逻辑
                          </Button>
                          {activePromptGuide.canEditPrompt && (
                            <Button
                              size="small"
                              type="primary"
                              ghost
                              onClick={() => {
                                window.location.href = activePromptGuide.editablePath || '/system?tab=prompts';
                              }}
                            >
                              去系统管理修改
                            </Button>
                          )}
                        </Space>
                      </div>
                    </div>
                  )}
                  <Form
                    form={form}
                    layout="vertical"
                    initialValues={{ type: '短视频脚本', brand: '门店品牌', count: 3 }}
                  >
                    <Row gutter={12}>
                      <Col xs={24} md={8}>
                        <Form.Item
                          label="创作类型"
                          name="type"
                          extra={isMedia ? '当前媒体入口已锁定对应创作类型，无需另外选择。' : undefined}
                          rules={[{ required: true, message: '请选择创作类型' }]}
                          style={{ marginBottom: 12 }}
                        >
                          <Select
                            disabled={isMedia}
                            options={(isMedia ? [tab] : COPY_TYPES).map(t => ({
                              value: t,
                              label: contentTypeLabel(t),
                            }))}
                          />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={16}>
                        <Form.Item
                          label="内容主题"
                          name="topic"
                          rules={[{ required: true, message: '请输入内容主题' }]}
                          style={{ marginBottom: 12 }}
                        >
                          <Input placeholder="如：夏季招牌菜上新·企业团餐菜单方案" allowClear maxLength={50} />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={12}>
                      <Col xs={24} md={8}>
                        <Form.Item label="品牌选择" name="brand" style={{ marginBottom: 12 }}>
                          <Select options={BRANDS.map(b => ({ value: b, label: b }))} />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={8}>
                        <Form.Item label="生成条数" name="count" style={{ marginBottom: 12 }}>
                          <InputNumber min={1} max={10} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={8}>
                        {tab === 'AI视频' ? (
                          <Form.Item label="视频模型" name="videoModel" style={{ marginBottom: 12 }}>
                            <Select
                              placeholder={videoModels.canViewPrice ? '选择已接入模型' : '选择档次与模型缩写'}
                              options={videoSelectOptions}
                              allowClear
                            />
                          </Form.Item>
                        ) : (
                          <Form.Item label="协同数字员工（可空）" name="marshalId" style={{ marginBottom: 12 }}>
                            <Select
                              allowClear
                              placeholder="选择协同数字员工"
                              options={marshals.map(m => ({
                                value: m.id,
                                label: (
                                  <Space size={6}>
                                    <Avatar size={20} src={m.avatar} style={{ background: 'var(--ui-surface-2)' }} />
                                    {m.name} {m.code}
                                  </Space>
                                ),
                              }))}
                            />
                          </Form.Item>
                        )}
                      </Col>
                    </Row>
                    <Form.Item label="要求描述" name="requirement" style={{ marginBottom: 14 }}>
                      <Input.TextArea
                        rows={3}
                        maxLength={300}
                        showCount
                        placeholder="如：突出招牌菜食材与制作过程，结尾说明预约到店方式，不使用未经确认的成效表述"
                      />
                    </Form.Item>
                    <Form.Item
                      label={`引用素材（可选 · 最多6个 · 已选${selectedMaterialIds.length}个）`}
                      style={{ marginBottom: 14 }}
                    >
                      {selectedMaterials.length ? (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {selectedMaterials.map((material: any) => (
                            <Tag
                              key={material.id}
                              color={material.hasBodySnapshot ? 'blue' : 'default'}
                              closable
                              onClose={() =>
                                setSelectedMaterialIds(current => current.filter(id => id !== Number(material.id)))
                              }
                            >
                              {material.name} · {material.hasBodySnapshot ? '正文会真实注入' : '仅文件/URL引用'}
                            </Tag>
                          ))}
                        </div>
                      ) : (
                        <div style={{ color: 'var(--ui-muted)', fontSize: 12 }}>
                          可从右侧“素材调度”或素材库选择。只有生成成功后才记录引用并增加使用次数；只有文件/URL的素材不会被宣称为已识别。
                        </div>
                      )}
                    </Form.Item>
                    {(tab === 'AI图片' || tab === 'AI视频') && (
                      <Form.Item
                        label={tab === 'AI图片' ? '多图参考（可选 · 最多6张）' : '多图参考（可选 · 首张作为首帧）'}
                        style={{ marginBottom: 4 }}
                      >
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 10 }}>
                          {refImgs.map((image, index) => (
                            <div key={image.id} style={{ position: 'relative', width: 88 }}>
                              <img
                                src={image.url}
                                alt={`参考图${index + 1}`}
                                style={{
                                  width: 88,
                                  height: 88,
                                  display: 'block',
                                  objectFit: 'cover',
                                  borderRadius: 6,
                                  border: '1px solid var(--ui-border)',
                                }}
                              />
                              <span
                                style={{
                                  position: 'absolute',
                                  left: 5,
                                  top: 5,
                                  minWidth: 20,
                                  height: 20,
                                  lineHeight: '20px',
                                  textAlign: 'center',
                                  borderRadius: 4,
                                  background: 'rgba(0,0,0,.72)',
                                  color: '#fff',
                                  fontSize: 11,
                                }}
                              >
                                {tab === 'AI视频' && index === 0 ? '首帧' : index + 1}
                              </span>
                              <Tooltip title={`移除${image.name}`}>
                                <Button
                                  aria-label={`移除参考图${index + 1}`}
                                  type="text"
                                  danger
                                  size="small"
                                  icon={<DeleteOutlined />}
                                  onClick={() => setRefImgs(current => current.filter(item => item.id !== image.id))}
                                  style={{
                                    position: 'absolute',
                                    right: 2,
                                    bottom: 2,
                                    width: 26,
                                    height: 26,
                                    background: 'rgba(255,255,255,.92)',
                                  }}
                                />
                              </Tooltip>
                            </div>
                          ))}
                          {refImgs.length < 6 && (
                            <label
                              htmlFor="content-reference-images"
                              style={{
                                width: 88,
                                height: 88,
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 6,
                                cursor: 'pointer',
                                border: '1px dashed var(--ui-border-strong)',
                                borderRadius: 6,
                                color: 'var(--ui-text-2)',
                                background: 'var(--ui-surface)',
                                fontSize: 12,
                              }}
                            >
                              <CloudUploadOutlined style={{ fontSize: 20 }} />
                              {refImgs.length ? '继续添加' : '上传图片'}
                              <input
                                id="content-reference-images"
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                multiple
                                style={{ display: 'none' }}
                                onChange={e => {
                                  void onPickRef(e.target.files).catch(error => message.error(error.message));
                                  e.currentTarget.value = '';
                                }}
                              />
                            </label>
                          )}
                        </div>
                        <div style={{ marginTop: 7, color: 'var(--ui-muted)', fontSize: 11.5 }}>
                          PNG / JPG / WebP，单张≤4MB，合计≤18MB
                        </div>
                      </Form.Item>
                    )}
                  </Form>
                  <div
                    style={{
                      display: 'flex',
                      gap: 12,
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      borderTop: '1px solid var(--ui-surface-2)',
                      paddingTop: 14,
                    }}
                  >
                    <Button
                      type="primary"
                      size="large"
                      icon={<SendOutlined />}
                      loading={generating}
                      onClick={onGenerate}
                      style={{
                        background: 'var(--ui-primary)',
                        border: 'none',
                        minWidth: 170,
                        fontWeight: 600,
                        boxShadow: 'none',
                      }}
                    >
                      {generating ? '内容生产中…' : '开始生成'}
                    </Button>
                    {generating && (
                      <>
                        <Button size="large" danger onClick={cancelGenerate}>
                          取消生成
                        </Button>
                        <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{genTimeHint(tab)}</span>
                      </>
                    )}
                    {!MEDIA_TABS.includes(tab) && (
                      <Tooltip title="立即返回，后台生成，完成后铃铛通知——不用盯着等">
                        <Button
                          size="large"
                          icon={<ClockCircleOutlined />}
                          onClick={onGenerateBackground}
                          style={{ color: 'var(--ui-accent)', borderColor: '#d1d1d1' }}
                        >
                          后台生成
                        </Button>
                      </Tooltip>
                    )}
                    <Tooltip title="3脚本+5朋友圈+3话题">
                      <Button
                        size="large"
                        icon={<ThunderboltOutlined />}
                        loading={dailyLoading}
                        onClick={runDailyPack}
                        style={{ color: 'var(--ui-accent)', borderColor: '#d1d1d1' }}
                      >
                        一键日更包
                      </Button>
                    </Tooltip>
                    <Button size="large" icon={<SaveOutlined />} onClick={openSaveTpl}>
                      保存模板
                    </Button>
                  </div>
                </Panel>

                {/* 生成结果区 */}
                {(generating || results.length > 0) && (
                  <Panel
                    title={
                      <>
                        <ThunderboltOutlined style={{ color: 'var(--ui-accent)' }} /> 生成结果
                      </>
                    }
                    extra={
                      results.length > 0 && (
                        <button
                          type="button"
                          className="ui-link-button"
                          style={{ fontSize: 12 }}
                          onClick={() => setResults([])}
                        >
                          清空
                        </button>
                      )
                    }
                  >
                    {/* 阶段化进度替代裸转圈：60-120 秒的请求里老板需要知道走到哪一步了 */}
                    <TaskProgress
                      running={generating}
                      stages={GENERATE_STAGES}
                      timings={[3000, 9000, 6000]}
                      skeletonRows={4}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {results.map((r, idx) => (
                        <div
                          key={r.id ?? idx}
                          style={{
                            border: '1px solid var(--ui-border-strong)',
                            background: 'var(--ui-surface-2)',
                            borderRadius: 10,
                            padding: 14,
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              flexWrap: 'wrap',
                              gap: 8,
                              marginBottom: 8,
                            }}
                          >
                            <div
                              style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', minWidth: 0 }}
                            >
                              <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ui-text)', marginRight: 4 }}>
                                {r.topic}
                              </span>
                              <Tag color={TYPE_META[r.type]?.color}>{contentTypeLabel(r.type)}</Tag>
                              {!r.jobId && r.status && <Tag color={contentStatusColor(r)}>{contentStatusLabel(r)}</Tag>}
                              {r.tpl && <Tag color="purple">模板：{r.tpl}</Tag>}
                              {r.kbCat && <Tag color="cyan">📚 已入知识库·{r.kbCat}</Tag>}
                              {!r.jobId && !r.pending && !r.failed && (
                                <Tag color={r.mode === 'template' ? 'orange' : 'geekblue'}>
                                  {r.mode === 'template'
                                    ? '模板兜底·建议稍后重试AI'
                                    : `⚡AI${r.model ? `·${r.model}` : ''}`}
                                </Tag>
                              )}
                              {r.pending && <Tag color="processing">后台生成中</Tag>}
                              {r.jobId ? <MediaReviewTags job={r} /> : r.media && <Tag color="purple">演绎附件</Tag>}
                            </div>
                            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                              <ContentUseActions record={r}>
                                <Button
                                  size="small"
                                  icon={<CopyOutlined />}
                                  disabled={!contentFlowReady(r)}
                                  onClick={() => copyText(r.body)}
                                >
                                  复制
                                </Button>
                              </ContentUseActions>
                              {(r.id || r.jobId) &&
                                (r.jobId ? (
                                  <MediaImportAction
                                    job={r}
                                    loading={importingKey === `job-${r.jobId}`}
                                    onImport={() => importToMaterial(r)}
                                  />
                                ) : (
                                  <Tooltip title={!contentFlowReady(r) ? contentFlowBlockedReason(r) : ''}>
                                    <span>
                                      <Button
                                        size="small"
                                        icon={<FolderOpenOutlined />}
                                        disabled={!contentFlowReady(r)}
                                        loading={importingKey === `content-${r.id}`}
                                        onClick={() => importToMaterial(r)}
                                      >
                                        导入素材库
                                      </Button>
                                    </span>
                                  </Tooltip>
                                ))}
                              {r.id && canSubmitApproval(r) && (
                                <Tooltip title={canSubmitApproval(r) ? '' : approvalBlockedReason(r)}>
                                  <span>
                                    <Button size="small" ghost onClick={() => submitApproval(r)}>
                                      {approvalActionText(r)}
                                    </Button>
                                  </span>
                                </Tooltip>
                              )}
                              {r.id && (
                                <Tooltip title={!contentFlowReady(r) ? contentFlowBlockedReason(r) : ''}>
                                  <span>
                                    <Button
                                      size="small"
                                      type="primary"
                                      ghost
                                      icon={<SendOutlined />}
                                      disabled={!contentFlowReady(r)}
                                      onClick={() => openPublish(r)}
                                    >
                                      发布登记
                                    </Button>
                                  </span>
                                </Tooltip>
                              )}
                            </div>
                          </div>
                          {r.risk?.hits?.length > 0 && (
                            <Alert
                              showIcon
                              style={{ marginBottom: 8 }}
                              type={
                                String(r.risk.level).includes('高') || r.risk.level === 'high' ? 'error' : 'warning'
                              }
                              message={`风控提示（${r.risk.level}）：命中规则 ${r.risk.hits.map((h: any) => h.name).join('、')}，建议人工复核后再发布`}
                            />
                          )}
                          {r.jobId && !r.technicalSuccess && (
                            <Alert
                              showIcon
                              style={{ marginBottom: 8 }}
                              type={r.technicalStatus === '失败' ? 'error' : 'info'}
                              message={
                                r.technicalStatus === '失败'
                                  ? `媒体技术生成失败：${r.error || '供应商未交付可用文件'}`
                                  : `媒体任务状态：${r.technicalStatus || r.status || '处理中'}；尚无可供业务验收的文件`
                              }
                            />
                          )}
                          {r.imageUrl && r.technicalSuccess && (
                            <div
                              style={{
                                marginBottom: 8,
                                textAlign: 'center',
                                background: 'var(--ui-surface)',
                                border: '1px solid var(--ui-border)',
                                borderRadius: 8,
                                padding: 8,
                              }}
                            >
                              <img
                                src={r.imageUrl}
                                alt={r.topic}
                                style={{ maxWidth: '100%', maxHeight: 360, borderRadius: 6 }}
                              />
                            </div>
                          )}
                          {r.videoUrl && r.technicalSuccess && (
                            <div style={{ marginBottom: 8 }}>
                              {/* eslint-disable-next-line jsx-a11y/media-has-caption -- The media API does not provide a verified caption track for generated videos. */}
                              <video
                                src={r.videoUrl}
                                controls
                                aria-label={`${r.topic || '生成结果'}视频预览`}
                                style={{ maxWidth: '100%', maxHeight: 360, borderRadius: 8 }}
                              />
                            </div>
                          )}
                          {r.deck && (
                            <div style={{ marginBottom: 8 }}>
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  marginBottom: 8,
                                  flexWrap: 'wrap',
                                  gap: 6,
                                }}
                              >
                                <span style={{ fontSize: 12, color: 'var(--ui-text-2)' }}>
                                  共 {r.deck.pages.length + 1} 页（含封面）{r.tpl ? ` · 模板：${r.tpl}` : ''}
                                </span>
                                <ContentUseActions record={r}>
                                  <Button
                                    size="small"
                                    disabled={!contentFlowReady(r)}
                                    onClick={() => exportDeckHtml(r)}
                                  >
                                    🖥️ 下载放映版(HTML)
                                  </Button>
                                  <Button size="small" disabled={!contentFlowReady(r)} onClick={() => exportDeckDoc(r)}>
                                    📄 导出大纲(Word)
                                  </Button>
                                </ContentUseActions>
                              </div>
                              <div
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))',
                                  gap: 8,
                                }}
                              >
                                <div
                                  style={{
                                    borderRadius: 8,
                                    overflow: 'hidden',
                                    border: '1px solid var(--ui-border-strong)',
                                    background: '#1c2d52',
                                    color: '#fff',
                                    minHeight: 120,
                                    position: 'relative',
                                  }}
                                >
                                  {r.cover && (
                                    <img
                                      src={r.cover}
                                      alt=""
                                      style={{
                                        position: 'absolute',
                                        inset: 0,
                                        width: '100%',
                                        height: '100%',
                                        objectFit: 'cover',
                                        opacity: 0.42,
                                      }}
                                    />
                                  )}
                                  <div style={{ position: 'relative', padding: '20px 12px', textAlign: 'center' }}>
                                    <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.4 }}>{r.deck.title}</div>
                                    <div style={{ fontSize: 10.5, opacity: 0.85, marginTop: 6 }}>{r.deck.subtitle}</div>
                                    <div style={{ fontSize: 9.5, opacity: 0.6, marginTop: 10 }}>封面</div>
                                  </div>
                                </div>
                                {r.deck.pages.map((p: any, i: number) => (
                                  <div
                                    key={i}
                                    style={{
                                      borderRadius: 8,
                                      border: '1px solid var(--ui-border)',
                                      background: 'var(--ui-surface)',
                                      padding: '10px 12px',
                                      minHeight: 120,
                                    }}
                                  >
                                    <div
                                      style={{
                                        fontSize: 12,
                                        fontWeight: 700,
                                        color: 'var(--ui-text)',
                                        borderLeft: '3px solid var(--ui-accent)',
                                        paddingLeft: 6,
                                        marginBottom: 6,
                                      }}
                                    >
                                      P{i + 2} {p.title}
                                    </div>
                                    <ul
                                      style={{
                                        margin: 0,
                                        paddingLeft: 16,
                                        fontSize: 11,
                                        color: 'var(--ui-text-2)',
                                        lineHeight: 1.75,
                                      }}
                                    >
                                      {(p.bullets || []).map((b: string, j: number) => (
                                        <li key={j}>{b}</li>
                                      ))}
                                    </ul>
                                    {p.note && (
                                      <div style={{ fontSize: 10, color: '#cbb887', marginTop: 5 }}>💬 {p.note}</div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {r.pending && (
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                                padding: '14px 12px',
                                background: 'var(--ui-surface)',
                                border: '1px dashed var(--ui-border-strong)',
                                borderRadius: 8,
                                fontSize: 12.5,
                                color: 'var(--ui-text-2)',
                              }}
                            >
                              <Spin size="small" /> 后台生成中…完成后自动出现在这里（也会铃铛通知），您可以先做别的
                            </div>
                          )}
                          {r.failed && (
                            <Alert
                              showIcon
                              type="error"
                              message={`后台生成失败：${r.error || '未知原因'}，可重新提交`}
                            />
                          )}
                          {r.body && (
                            <div
                              style={{
                                whiteSpace: 'pre-wrap',
                                fontSize: 12.5,
                                color: 'var(--ui-text-2)',
                                lineHeight: 1.8,
                                maxHeight: 280,
                                overflow: 'auto',
                                background: 'var(--ui-surface)',
                                border: '1px solid var(--ui-border)',
                                borderRadius: 8,
                                padding: '10px 12px',
                              }}
                            >
                              {r.body}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </Panel>
                )}

                {['AI图片', 'AI视频'].includes(tab) && mediaJobs.length > 0 && (
                  <Panel
                    title={`历史${tab === 'AI图片' ? '生图' : '视频'}任务`}
                    extra={
                      <Space size={8} wrap>
                        <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>近 {mediaJobs.length} 条</span>
                        <Button
                          size="small"
                          icon={<ClockCircleOutlined />}
                          loading={mediaJobsRefreshing}
                          onClick={() => loadMediaJobs(tab === 'AI视频' ? 'video' : 'image')}
                        >
                          刷新状态
                        </Button>
                        <Tooltip title={selectedMediaJobIds.length ? '' : '请先勾选可删除的媒体任务'}>
                          <span>
                            <Button
                              size="small"
                              danger
                              ghost
                              disabled={!selectedMediaJobIds.length}
                              onClick={() =>
                                deleteMediaJobs(selectedMediaJobIds, `选中的 ${selectedMediaJobIds.length} 条任务`)
                              }
                            >
                              删除选中
                            </Button>
                          </span>
                        </Tooltip>
                        <Button size="small" onClick={clearFailedMediaJobs}>
                          清空失败
                        </Button>
                      </Space>
                    }
                  >
                    <Row gutter={[12, 12]}>
                      {mediaJobs.map((j: any) => (
                        <Col xs={12} md={8} lg={6} key={j.id}>
                          <MediaJobCard
                            job={{ ...j, jobId: j.id }}
                            selected={selectedMediaJobIds.includes(j.id)}
                            importing={importingKey === `job-${j.id}`}
                            onToggle={checked => toggleMediaJob(j.id, checked)}
                            onDelete={() => deleteSingleMediaJob(j)}
                            onImport={() => importToMaterial({ ...j, jobId: j.id })}
                          />
                        </Col>
                      ))}
                    </Row>
                  </Panel>
                )}

                {/* 最近生成 */}
                <Panel
                  title="最近生成"
                  extra={
                    <Select
                      size="small"
                      value={statusFilter}
                      style={{ width: 110 }}
                      onChange={v => {
                        setStatusFilter(v);
                        setPage(1);
                      }}
                      options={[
                        { value: '', label: '全部状态' },
                        ...STATUSES.map(s => ({
                          value: s,
                          label:
                            s === '可使用'
                              ? '已采用（可用于业务）'
                              : s === '待审核'
                                ? '旧策略/显式策略待处理'
                                : s === '已驳回'
                                  ? '失败需返工'
                                  : s,
                        })),
                      ]}
                    />
                  }
                >
                  {rows.length === 0 ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无生成记录，去创作第一条内容吧" />
                  ) : (
                    <Row gutter={[12, 12]}>
                      {rows.map(r => (
                        <Col xs={24} sm={12} xl={8} key={r.id}>
                          <ContentFactoryRecentCard
                            record={r}
                            importing={importingKey === `content-${r.id}`}
                            onOpen={openContentDetail}
                            onImport={importToMaterial}
                            onSubmitApproval={submitApproval}
                            onOpenPublish={openPublish}
                            onDelete={deleteContent}
                          />
                        </Col>
                      ))}
                    </Row>
                  )}
                  {total > 12 && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                      <Pagination
                        size="small"
                        current={page}
                        pageSize={12}
                        total={total}
                        onChange={p => setPage(p)}
                        showSizeChanger={false}
                        showTotal={t => `共 ${t} 条`}
                      />
                    </div>
                  )}
                </Panel>
              </>
            )}
          </div>
        </Col>

        {/* 右侧栏（1/3） */}
        <Col xs={24} lg={8}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* 固定创作参考：不冒充实时经营或热点判断 */}
            <ContentReferencePanel
              briefingTheme={briefing?.theme}
              onSelectSuggestion={setSuggestionDetail}
              onUseBriefingTheme={theme => {
                form.setFieldsValue({ topic: theme });
                switchTab('AI文案');
                message.success('已将经营作战计划中记录的主题填入表单，请核对后再生成');
              }}
            />

            {/* 待人工处理区：流水线、单员工和普通内容统一可发现 */}
            <Panel
              title={
                <>
                  待人工处理 <Badge count={totalPendingReviewCount} size="small" />
                </>
              }
              extra={
                <button
                  type="button"
                  className="ui-link-button"
                  style={{ fontSize: 12 }}
                  onClick={() => {
                    switchTab('AI文案');
                    setStatusFilter('待审核');
                    loadPending();
                    loadPipelinePendingReviews();
                  }}
                >
                  全部 <RightOutlined />
                </button>
              }
            >
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 8 }}
                message="这里只列出待处理或需策略确认的任务"
                description="当前 auto 下，none / low / medium / high 普通内部结果通过质量和账务门后直接进入业务可用状态。历史待审任务和显式策略任务仍在这里展示；系统不会自动发布。"
              />
              {pipelinePendingError ? (
                <Alert
                  type="error"
                  showIcon
                  style={{ marginBottom: 8 }}
                  message="流水线待审列表加载失败"
                  description={
                    <span>
                      {pipelinePendingError}{' '}
                      <button type="button" className="ui-link-button" onClick={loadPipelinePendingReviews}>
                        重新加载
                      </button>
                    </span>
                  }
                />
              ) : (
                pipelinePendingReviews.map(review => (
                  <button
                    type="button"
                    className="content-pipeline-review-card"
                    key={`pipeline-${review.pipelineId}`}
                    data-pipeline-review-id={review.pipelineId}
                    onClick={() => openPipelineReview(review.pipelineId)}
                  >
                    <span className="content-pipeline-review-head">
                      <strong>{review.pipelineTitle || `内容流水线 #${review.pipelineId}`}</strong>
                      <Tag color={review.canReview ? 'gold' : 'default'}>
                        {review.canReview ? '可审阅' : '只可查看'}
                      </Tag>
                    </span>
                    <span className="content-pipeline-review-meta">
                      流水线 #{review.pipelineId} · 工位{review.stationIdx}·{review.stationName}
                    </span>
                    <span className="content-pipeline-review-meta">
                      创建人：{review.creator?.name || `用户 #${review.creator?.id || '-'}`} · 边界：
                      {review.approvalBoundary?.label || '待核验'}
                    </span>
                    {!review.canReview && review.reviewBlockedReason ? (
                      <span className="content-pipeline-review-blocked">{review.reviewBlockedReason}</span>
                    ) : null}
                  </button>
                ))
              )}
              {employeePendingReviewCount > 0 && (
                <button
                  type="button"
                  className="content-employee-review-link"
                  onClick={() =>
                    document.getElementById('content-employee-task-center')?.scrollIntoView({ behavior: 'smooth' })
                  }
                >
                  <span>
                    <b>{employeePendingReviewCount}</b>
                    <span>
                      <strong>内容数字员工产出待处理 / 需策略确认</strong>
                      <small>去任务中心打开对应员工与任务</small>
                    </span>
                  </span>
                  <RightOutlined />
                </button>
              )}
              {pendingError ? (
                <Alert
                  type="error"
                  showIcon
                  style={{ marginBottom: 8 }}
                  message="待确认列表加载失败"
                  description={
                    <span>
                      {pendingError}{' '}
                      <button type="button" className="ui-link-button" onClick={loadPending}>
                        重新加载
                      </button>
                    </span>
                  }
                />
              ) : pending.length === 0 && employeePendingReviewCount === 0 && pipelinePendingReviewCount === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无待人工处理内容"
                  style={{ margin: '8px 0' }}
                />
              ) : pending.length === 0 ? null : (
                pending.map(p => (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => openContentDetail(p)}
                    style={{
                      ...interactiveSurfaceStyle,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                      padding: '7px 0',
                      borderBottom: '1px solid var(--ui-surface-2)',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12.5, color: 'var(--ui-text)', fontWeight: 600, ...ell }}>
                        {p.title || p.topic || '未命名内容'}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>
                        {contentTypeLabel(p.type)} · {p.creator || '员工'} · {fmtTime(p.created_at)}
                      </div>
                    </div>
                    <Tag color="gold" style={{ marginRight: 0, flexShrink: 0 }}>
                      待处理
                    </Tag>
                  </button>
                ))
              )}
            </Panel>

            {/* 高频模板 */}
            <Panel
              title="高频模板"
              extra={
                <button
                  type="button"
                  className="ui-link-button"
                  style={{ fontSize: 12 }}
                  onClick={() => switchTab('模板库')}
                >
                  管理 <RightOutlined />
                </button>
              }
            >
              {templates.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无模板" style={{ margin: '8px 0' }} />
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {[...templates]
                    .sort((a, b) => (b.use_count || 0) - (a.use_count || 0))
                    .slice(0, 8)
                    .map(t => (
                      <Tooltip key={t.id} title={t.prompt}>
                        <Tag color="blue" style={{ cursor: 'pointer', margin: 0 }} onClick={() => setTplDetail(t)}>
                          {t.name} ·{t.use_count ?? 0}
                        </Tag>
                      </Tooltip>
                    ))}
                </div>
              )}
            </Panel>

            {/* 快捷操作 */}
            <Panel title="快捷操作">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {quicks.map(q => (
                  <button
                    type="button"
                    key={q.label}
                    onClick={() => setFlowDetail(q)}
                    style={{
                      ...interactiveSurfaceStyle,
                      background: 'var(--ui-surface-2)',
                      borderRadius: 8,
                      padding: '12px 8px',
                      textAlign: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    <div
                      style={{
                        width: 34,
                        height: 34,
                        margin: '0 auto 6px',
                        borderRadius: 8,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: `${q.color}1a`,
                        color: q.color,
                        fontSize: 16,
                      }}
                    >
                      {q.icon}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--ui-text-2)', fontWeight: 600 }}>{q.label}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--ui-muted)', marginTop: 3 }}>{q.desc}</div>
                  </button>
                ))}
              </div>
            </Panel>

            {/* 素材调度 */}
            <Panel
              title="素材调度"
              extra={
                <button
                  type="button"
                  className="ui-link-button"
                  style={{ fontSize: 12 }}
                  onClick={() => setMatOpen(true)}
                >
                  导入 <RightOutlined />
                </button>
              }
            >
              {materials.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无素材" style={{ margin: '8px 0' }} />
              ) : (
                [...materials]
                  .sort((a, b) => (b.use_count || 0) - (a.use_count || 0))
                  .slice(0, 6)
                  .map(m => (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => setMatDetail(m)}
                      style={{
                        ...interactiveSurfaceStyle,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        gap: 8,
                        padding: '7px 0',
                        borderBottom: '1px solid var(--ui-surface-2)',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <Tag color="cyan" style={{ margin: 0, flexShrink: 0 }}>
                            {contentTypeLabel(m.type)}
                          </Tag>
                          <span style={{ fontSize: 12.5, color: 'var(--ui-text-2)', ...ell }}>{m.name}</span>
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--ui-muted)', marginTop: 3, ...ell }}>
                          {sourceLabel(m.source_type)} · {splitTags(m.tags).slice(0, 3).join(' / ') || '未打标'}
                        </div>
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--ui-muted)', flexShrink: 0 }}>
                        用{m.use_count ?? 0}次
                      </span>
                    </button>
                  ))
              )}
            </Panel>

            {/* 内容效果 TOP */}
            <Panel
              title={
                <>
                  <FireOutlined style={{ color: 'var(--danger)' }} /> 内容效果TOP
                </>
              }
            >
              {effectTop.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无发布效果数据"
                  style={{ margin: '8px 0' }}
                />
              ) : (
                effectTop.slice(0, 5).map((e, i) => (
                  <button
                    type="button"
                    key={e.id}
                    onClick={() => openEffectDetail(e.id)}
                    style={{
                      ...interactiveSurfaceStyle,
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                      padding: '6px 0',
                      borderBottom: '1px solid var(--ui-surface-2)',
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 5,
                        flexShrink: 0,
                        textAlign: 'center',
                        lineHeight: '18px',
                        fontSize: 11,
                        fontWeight: 700,
                        color: '#fff',
                        marginTop: 2,
                        background: i < 3 ? ['var(--danger)', 'var(--warn)', 'var(--ui-muted)'][i] : 'var(--ui-muted)',
                      }}
                    >
                      {i + 1}
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ui-text)', ...ell }}>{e.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>
                        {contentTypeLabel(e.type)} · {e.channel || '未发布'} · {fmtNum(e.effect_views)}浏览 ·{' '}
                        {e.effect_leads ?? 0}线索
                      </div>
                      <div style={{ fontSize: 10.5, color: '#b0b8c8' }}>点击查看正文、发布效果、入库和策略确认操作</div>
                    </div>
                  </button>
                ))
              )}
            </Panel>
          </div>
        </Col>
      </Row>

      {/* 素材详情/引用 Modal */}
      <Modal
        open={!!matDetail}
        width={460}
        onCancel={() => setMatDetail(null)}
        title={<>📦 素材详情</>}
        footer={[
          <Button key="use" type="primary" icon={<ThunderboltOutlined />} onClick={() => applyMaterial(matDetail)}>
            加入本次创作引用
          </Button>,
          matDetail?.id && (
            <Popconfirm
              key="del"
              title={`删除素材「${matDetail.name}」？`}
              description="删除后进入回收站，老板/管理员可恢复。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => deleteMaterial(matDetail)}
            >
              <Button danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          ),
          <Button key="close" onClick={() => setMatDetail(null)}>
            关闭
          </Button>,
        ].filter(Boolean)}
      >
        {matDetail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
            <div>
              <Tag color="cyan">{contentTypeLabel(matDetail.type)}</Tag>
              <b>{matDetail.name}</b>
            </div>
            <div
              style={{
                background: 'var(--ui-surface-2)',
                borderRadius: 8,
                padding: '10px 12px',
                lineHeight: 2,
                fontSize: 12.5,
              }}
            >
              <div>🏷️ 标签：{matDetail.tags || '—'}</div>
              <div>
                🧭 来源：{sourceLabel(matDetail.source_type)}
                {matDetail.source_id ? ` #${matDetail.source_id}` : ''}
              </div>
              <div>
                📊 已被引用：<b style={{ color: 'var(--ui-accent)' }}>{matDetail.use_count ?? 0}</b> 次
              </div>
              <div>
                🧾 注入方式：
                {matDetail.hasBodySnapshot ? '持久化正文快照（按不可信资料隔离）' : '仅文件/URL与来源元数据'}
              </div>
              <div>🕐 入库时间：{(matDetail.created_at || '').slice(0, 16) || '—'}</div>
              {matDetail.url && (
                <div>
                  🔗{' '}
                  <a href={matDetail.url} target="_blank" rel="noreferrer">
                    查看源文件
                  </a>
                </div>
              )}
            </div>
            {matDetail.note && (
              <div
                style={{
                  background: 'var(--ui-surface)',
                  border: '1px solid var(--ui-surface)',
                  borderRadius: 8,
                  padding: '8px 10px',
                  fontSize: 12,
                  color: '#7a5d12',
                  lineHeight: 1.7,
                }}
              >
                {matDetail.note}
              </div>
            )}
            <div style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}>
              加入选择不会立刻计数。生成时，系统会真实注入已持久化正文；只有文件/URL的素材只声明引用，不会声称已识图。生成成功后才写引用记录并增加使用次数。
            </div>
          </div>
        )}
      </Modal>

      {/* 内容详情 Modal */}
      <Modal
        open={!!viewRec}
        width={640}
        onCancel={() => setViewRec(null)}
        title={viewRec?.title || viewRec?.topic || '内容详情'}
        footer={[
          <Button key="regen" icon={<ThunderboltOutlined />} onClick={() => regenSame(viewRec)}>
            再生成同款
          </Button>,
          viewRec?.id && (
            <Tooltip key="mat" title={!contentFlowReady(viewRec) ? contentFlowBlockedReason(viewRec) : ''}>
              <span>
                <Button
                  icon={<FolderOpenOutlined />}
                  disabled={!contentFlowReady(viewRec)}
                  loading={importingKey === `content-${viewRec.id}`}
                  onClick={() => importToMaterial(viewRec)}
                >
                  导入素材库
                </Button>
              </span>
            </Tooltip>
          ),
          viewRec?.id && canSubmitApproval(viewRec) && (
            <Tooltip key="audit" title={canSubmitApproval(viewRec) ? '' : approvalBlockedReason(viewRec)}>
              <span>
                <Button onClick={() => submitApproval(viewRec)}>{approvalActionText(viewRec)}</Button>
              </span>
            </Tooltip>
          ),
          <ContentUseActions key="copy" record={viewRec}>
            <Button
              icon={<CopyOutlined />}
              disabled={!contentFlowReady(viewRec)}
              onClick={() => copyText(viewRec?.body)}
            >
              复制
            </Button>
          </ContentUseActions>,
          viewRec?.id && (
            <Tooltip key="pub" title={!contentFlowReady(viewRec) ? contentFlowBlockedReason(viewRec) : ''}>
              <span>
                <Button
                  type="primary"
                  ghost
                  icon={<SendOutlined />}
                  disabled={!contentFlowReady(viewRec)}
                  onClick={() => {
                    openPublish(viewRec);
                    setViewRec(null);
                  }}
                >
                  发布登记
                </Button>
              </span>
            </Tooltip>
          ),
          viewRec?.id && (
            <Popconfirm
              key="del"
              title={`删除「${viewRec?.title || viewRec?.topic || '该内容'}」？`}
              description="删除后进入回收站，老板/管理员可恢复。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => deleteContent(viewRec)}
            >
              <Button danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          ),
          <Button key="close" onClick={() => setViewRec(null)}>
            关闭
          </Button>,
        ].filter(Boolean)}
      >
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
          <Tag color={TYPE_META[viewRec?.type]?.color || 'blue'}>{contentTypeLabel(viewRec?.type)}</Tag>
          <Tag color={contentStatusColor(viewRec)}>{contentStatusLabel(viewRec)}</Tag>
          {viewRec?.ai_mode && (
            <Tag color={viewRec.ai_mode === 'template' ? 'orange' : 'geekblue'}>
              {viewRec.ai_mode === 'template' ? '模板底稿' : '真实AI'}
            </Tag>
          )}
          {viewRec?.risk_level && viewRec.risk_level !== '无' && (
            <Tag color={String(viewRec.risk_level).includes('高') ? 'red' : 'orange'}>风险：{viewRec.risk_level}</Tag>
          )}
          {viewRec?.channel && <Tag>{viewRec.channel}</Tag>}
        </div>
        <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginBottom: 10 }}>
          {viewRec?.creator ? `创建人：${viewRec.creator} · ` : ''}
          {fmtTime(viewRec?.created_at)}
          {viewRec?.effect_views != null
            ? ` · ${fmtNum(viewRec.effect_views)}浏览 · ${viewRec?.effect_leads ?? 0}线索`
            : ''}
        </div>
        <div
          style={{
            whiteSpace: 'pre-wrap',
            background: 'var(--ui-surface-2)',
            border: '1px solid var(--ui-border)',
            borderRadius: 8,
            padding: '12px 14px',
            fontSize: 12.5,
            color: 'var(--ui-text-2)',
            lineHeight: 1.8,
            maxHeight: 380,
            overflow: 'auto',
          }}
        >
          {viewRec?.body || '（无正文）'}
        </div>
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ui-text)', marginBottom: 7 }}>逐次发布记录</div>
          {Array.isArray(viewRec?.publishLogs) && viewRec.publishLogs.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {viewRec.publishLogs.map((log: any) => (
                <div
                  key={log.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap',
                    background: 'var(--ui-surface-2)',
                    border: '1px solid var(--ui-border)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    fontSize: 11.5,
                    color: 'var(--ui-text-2)',
                  }}
                >
                  <span>
                    <Tag style={{ marginRight: 6 }}>{log.channel}</Tag>+{fmtNum(log.views)}浏览 · +{log.leads ?? 0}线索
                  </span>
                  <span style={{ color: 'var(--ui-muted)' }}>
                    {log.created_by_name || '系统登记'} · {fmtTime(log.created_at)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}>暂无逐次发布记录</div>
          )}
        </div>
      </Modal>

      {/* 模板详情 Modal */}
      <Modal
        open={!!tplDetail}
        width={680}
        onCancel={() => setTplDetail(null)}
        title={tplDetail?.name || '模板详情'}
        footer={[
          <Button
            key="copy"
            icon={<CopyOutlined />}
            onClick={() => copyText(tplDetail?.promptSkeleton || tplDetail?.prompt)}
          >
            复制提示词
          </Button>,
          <Button
            key="use"
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={() => {
              if (tplDetail?.promptSkeleton) {
                applyMediaTpl(tplDetail);
                setTplDetail(null);
              } else applyTemplate(tplDetail);
            }}
          >
            套用到创作
          </Button>,
          tplDetail?.id && (
            <Popconfirm
              key="del"
              title={`删除模板「${tplDetail.name}」？`}
              description="删除后进入回收站，老板/管理员可恢复。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => deleteTemplate(tplDetail)}
            >
              <Button danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          ),
          <Button key="close" onClick={() => setTplDetail(null)}>
            关闭
          </Button>,
        ].filter(Boolean)}
      >
        {tplDetail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <Tag color={TYPE_META[tplDetail.type || tplDetail.tab]?.color || 'blue'}>
                {contentTypeLabel(tplDetail.type || tplDetail.tab)}
              </Tag>
              {splitTags(tplDetail.tags).map((x: string) => (
                <Tag key={x}>{contentTypeLabel(x)}</Tag>
              ))}
              {tplDetail.source && <Tag color="purple">{tplDetail.source}</Tag>}
              {tplDetail.use_count != null && <Tag color="geekblue">已用 {tplDetail.use_count} 次</Tag>}
            </div>
            {tplDetail.description && <Alert type="info" showIcon message={tplDetail.description} />}
            <div
              style={{
                background: 'var(--ui-surface-2)',
                border: '1px solid var(--ui-border)',
                borderRadius: 8,
                padding: '10px 12px',
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginBottom: 6 }}>完整提示词 / 结构描述</div>
              <Input.TextArea value={tplDetail.promptSkeleton || tplDetail.prompt || ''} rows={7} readOnly />
            </div>
            {(tplDetail.parameters || tplDetail.negativePrompt || tplDetail.extra) && (
              <div style={{ fontSize: 12, color: 'var(--ui-text-2)', lineHeight: 1.8 }}>
                {tplDetail.parameters && <div>生成参数：{tplDetail.parameters}</div>}
                {tplDetail.negativePrompt && <div>负向约束：{tplDetail.negativePrompt}</div>}
                {tplDetail.extra && <div>补充说明：{tplDetail.extra}</div>}
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={automationOpen}
        width={720}
        forceRender
        title={editingAutomation ? `编辑自动规则 · ${editingAutomation.name}` : '新建内容自动化规则'}
        okText={editingAutomation ? '保存规则' : '创建规则'}
        confirmLoading={automationSaving}
        onCancel={() => {
          setAutomationOpen(false);
          setEditingAutomation(null);
        }}
        onOk={saveAutomation}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="自动生产不等于自动发布"
          description="新规则默认 auto：none / low / medium / high 普通内部结果通过质量和账务门后自动采用。risk / always 作为旧规则兼容选项保留。系统不会自动外发、操作账号、真实付费或执行不可逆动作。"
        />
        {editingAutomation?.taskTypeValid === false && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 14 }}
            message="这条旧规则的任务类型与当前员工岗位不匹配"
            description={`当前“${editingAutomation.contentType}”不能由 #${editingAutomation.employeeIdx} 执行；请选择下方岗位原生任务类型后再保存或启用。`}
          />
        )}
        <Form form={automationForm} layout="vertical">
          <Row gutter={12}>
            <Col xs={24} md={16}>
              <Form.Item
                name="name"
                label="规则名称"
                rules={[{ required: true, message: '请输入规则名称' }, { max: 60 }]}
              >
                <Input maxLength={60} placeholder="如：每天上午招牌菜朋友圈" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="enabled" label="定时状态" valuePropName="checked">
                <Switch checkedChildren="启用" unCheckedChildren="停用" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col xs={24} md={12}>
              <Form.Item
                name="employeeIdx"
                label="执行内容员工"
                rules={[{ required: true, message: '请选择内容员工' }]}
              >
                <Select
                  showSearch
                  optionFilterProp="label"
                  onChange={(value: number) => {
                    const station = contentCrew.find(item => (item.employeeIdx ?? item.order) === value);
                    const taskTypes = station?.taskTypes || [];
                    const current = automationForm.getFieldValue('contentType');
                    if (!taskTypes.includes(current)) {
                      automationForm.setFieldValue('contentType', taskTypes[0]);
                    }
                  }}
                  options={contentCrew.map(station => ({
                    value: station.employeeIdx ?? station.order,
                    label: `#${station.employeeIdx ?? station.order} · ${station.name} · ${station.group}`,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                name="contentType"
                label="岗位任务类型"
                extra={
                  automationStation
                    ? `只显示${automationStation.name}可完整执行的任务，不会跨岗套用通用文案类型。`
                    : '先选择执行员工。'
                }
                rules={[{ required: true, message: '请选择岗位任务类型' }]}
              >
                <Select
                  disabled={!automationTaskTypes.length}
                  options={automationTaskTypes.map(type => ({ value: type, label: type }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={4}>
              <Form.Item name="contentCount" label="交付份数" rules={[{ required: true, message: '请输入交付份数' }]}>
                <InputNumber min={1} max={10} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="topic"
            label="内容主题"
            rules={[{ required: true, message: '请输入内容主题' }, { max: 100 }]}
          >
            <Input maxLength={100} placeholder="如：夏季招牌菜、午市套餐或会员日" />
          </Form.Item>
          <Form.Item name="requirement" label="内容要求" rules={[{ max: 2000, message: '内容要求不能超过2000字' }]}>
            <Input.TextArea
              rows={3}
              maxLength={2000}
              showCount
              placeholder="只填写门店已经确认的事实；未知价格、库存、权益和经营效果标记待确认。"
            />
          </Form.Item>
          <Row gutter={12}>
            <Col xs={24} md={6}>
              <Form.Item name="frequency" label="频率" rules={[{ required: true, message: '请选择频率' }]}>
                <Select
                  options={[
                    { value: 'daily', label: '每天' },
                    { value: 'weekly', label: '每周' },
                  ]}
                />
              </Form.Item>
            </Col>
            {automationFrequency === 'weekly' && (
              <Col xs={24} md={6}>
                <Form.Item name="weekday" label="星期" rules={[{ required: true, message: '请选择星期' }]}>
                  <Select
                    options={WEEKDAY_LABELS.slice(1).map((label, index) => ({
                      value: index + 1,
                      label,
                    }))}
                  />
                </Form.Item>
              </Col>
            )}
            <Col xs={24} md={automationFrequency === 'weekly' ? 6 : 9}>
              <Form.Item
                name="runTime"
                label="运行时间（上海时区）"
                rules={[
                  { required: true, message: '请输入运行时间' },
                  { pattern: /^([01]\d|2[0-3]):[0-5]\d$/, message: '使用HH:mm格式，如09:00' },
                ]}
              >
                <Input maxLength={5} placeholder="09:00" />
              </Form.Item>
            </Col>
            <Col xs={24} md={automationFrequency === 'weekly' ? 6 : 9}>
              <Form.Item
                name="approvalMode"
                label="采用与确认策略"
                rules={[{ required: true, message: '请选择采用与确认策略' }]}
              >
                <Select
                  options={[
                    { value: 'auto', label: '默认：所有普通内部结果自动采用' },
                    { value: 'risk', label: '兼容旧规则：按风险分流' },
                    { value: 'always', label: '兼容旧规则：所有结果逐条确认' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* 固定创作参考详情 Modal */}
      <Modal
        open={!!suggestionDetail}
        width={560}
        onCancel={() => setSuggestionDetail(null)}
        title={suggestionDetail?.title || '创作参考模板'}
        footer={[
          <Button
            key="apply"
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={() => applySuggestion(suggestionDetail)}
          >
            填入表单并人工核对
          </Button>,
          <Button key="close" onClick={() => setSuggestionDetail(null)}>
            关闭
          </Button>,
        ]}
      >
        {suggestionDetail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, lineHeight: 1.8 }}>
            <Alert
              type="warning"
              showIcon
              message={suggestionDetail.summary}
              description="这是固定参考模板，不代表系统已读取实时经营、热点或活动数据。"
            />
            <div style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '10px 12px' }}>
              <b>示例适用场景：</b>
              {suggestionDetail.reason}
            </div>
            <div
              style={{
                background: 'var(--ui-surface)',
                border: '1px solid var(--ui-surface)',
                borderRadius: 8,
                padding: '10px 12px',
                color: '#7a5d12',
              }}
            >
              <b>使用前核对：</b>
              {suggestionDetail.verification}
            </div>
            <div>
              <Tag color="blue">{suggestionDetail.action?.tab}</Tag>
              <Tag color="purple">{contentTypeLabel(suggestionDetail.action?.type)}</Tag>
              <span style={{ color: 'var(--ui-text-2)' }}>
                点击确认后只会把示例主题和要求写入表单；人工核对真实信息后才能生成。
              </span>
            </div>
          </div>
        )}
      </Modal>

      {/* 快捷操作流程 Modal */}
      <Modal
        open={!!flowDetail}
        width={520}
        onCancel={() => setFlowDetail(null)}
        title={flowDetail?.label || '快捷操作'}
        okText="开始执行"
        onOk={() => {
          const f = flowDetail;
          setFlowDetail(null);
          f?.run?.();
        }}
      >
        {flowDetail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Alert type="info" showIcon message={flowDetail.desc} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(flowDetail.steps || []).map((s: string, i: number) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                  <span
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 10,
                      background: 'var(--ui-surface)',
                      color: 'var(--ui-accent)',
                      textAlign: 'center',
                      lineHeight: '20px',
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {i + 1}
                  </span>
                  <span style={{ color: 'var(--ui-text-2)', lineHeight: 1.6 }}>{s}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {/* 一键日更包 Modal */}
      <Modal
        open={dailyOpen}
        width={680}
        onCancel={() => setDailyOpen(false)}
        title={
          <>
            <ThunderboltOutlined style={{ color: 'var(--ui-accent)' }} /> 一键日更包 · {dailyPack?.topic}
          </>
        }
        footer={
          <Button type="primary" onClick={() => setDailyOpen(false)}>
            知道了
          </Button>
        }
      >
        <Alert
          type={dailyPack?.status === 'partial' ? 'warning' : 'success'}
          showIcon
          style={{ marginBottom: 12 }}
          message={
            dailyPack?.status === 'partial'
              ? `日更包部分完成：已产出 ${dailyPack?.summary?.producedItems || 0} 条，${dailyPack?.summary?.failedParts || 0} 个子任务失败`
              : `日更包已生成：${dailyPack?.summary?.producedItems || 0} 条内容，已进入内容队列`
          }
          description="当前 auto 下，普通内部合格结果通过质量与账务门后自动采用；历史 risk / always 规则仍按锁定策略处理。系统不会自动发布。"
        />
        {!!dailyPack?.failures?.length && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message="未完成的子任务"
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {dailyPack.failures.map((failure: any, index: number) => (
                  <li key={`${failure.type || '子任务'}-${index}`}>
                    {failure.type || '子任务'}：{failure.error || '执行失败，未返回原因'}
                  </li>
                ))}
              </ul>
            }
          />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 420, overflow: 'auto' }}>
          {(dailyPack?.results || []).map((r: any, i: number) => (
            <div
              key={r.id ?? i}
              style={{ border: '1px solid var(--ui-border)', borderRadius: 8, padding: '10px 12px' }}
            >
              <div style={{ marginBottom: 6 }}>
                <Tag color={TYPE_META[r.type]?.color || 'blue'}>{contentTypeLabel(r.type)}</Tag>
                <Tag color={contentStatusColor(r)}>{contentStatusLabel(r)}</Tag>
              </div>
              <div
                style={{
                  whiteSpace: 'pre-wrap',
                  fontSize: 12,
                  color: 'var(--ui-text-2)',
                  lineHeight: 1.7,
                  maxHeight: 130,
                  overflow: 'auto',
                }}
              >
                {r.body}
              </div>
            </div>
          ))}
        </div>
      </Modal>

      <PromptGuideModal
        open={canViewCrewInternals && !!promptGuideDetail}
        guide={canViewCrewInternals ? promptGuideDetail : null}
        onClose={() => setPromptGuideDetail(null)}
      />

      {/* 发布登记 Modal */}
      <Modal
        open={!!pubRec}
        title="发布登记"
        okText="提交登记"
        forceRender
        confirmLoading={publishing}
        onCancel={() => {
          if (publishing) return;
          setPubRec(null);
          setPublishIdempotencyKey('');
        }}
        onOk={submitPublish}
      >
        <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginBottom: 12 }}>
          登记内容：{pubRec?.title || pubRec?.topic || (pubRec ? `#${pubRec.id}` : '')}
        </div>
        <Form form={pubForm} layout="vertical">
          <Form.Item label="发布渠道" name="channel" rules={[{ required: true, message: '请选择发布渠道' }]}>
            <Select
              placeholder="选择发布渠道"
              options={['短视频', '朋友圈', '社群'].map(c => ({ value: c, label: c }))}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                label="本次新增浏览量"
                name="views"
                initialValue={0}
                rules={[
                  {
                    required: true,
                    type: 'integer',
                    min: 0,
                    max: PUBLISH_VIEWS_MAX,
                    message: `请输入0-${PUBLISH_VIEWS_MAX}之间的整数`,
                  },
                ]}
              >
                <InputNumber min={0} max={PUBLISH_VIEWS_MAX} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="本次新增线索数"
                name="leads"
                initialValue={0}
                rules={[
                  {
                    required: true,
                    type: 'integer',
                    min: 0,
                    max: PUBLISH_LEADS_MAX,
                    message: `请输入0-${PUBLISH_LEADS_MAX}之间的整数`,
                  },
                ]}
              >
                <InputNumber min={0} max={PUBLISH_LEADS_MAX} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* 保存模板 Modal */}
      <Modal
        open={tplOpen}
        title="保存为模板"
        okText="保存"
        forceRender
        onCancel={() => setTplOpen(false)}
        onOk={submitTpl}
      >
        <Form form={tplForm} layout="vertical">
          <Form.Item label="模板名称" name="name" rules={[{ required: true, message: '请输入模板名称' }]}>
            <Input maxLength={30} placeholder="如：企业团餐邀约话术模板" />
          </Form.Item>
          <Form.Item label="适用类型" name="type" rules={[{ required: true, message: '请选择适用类型' }]}>
            <Select options={[...COPY_TYPES, ...MEDIA_TABS].map(t => ({ value: t, label: contentTypeLabel(t) }))} />
          </Form.Item>
          <Form.Item label="提示词" name="prompt" rules={[{ required: true, message: '请输入提示词' }]}>
            <Input.TextArea rows={3} placeholder="模板提示词，调用时自动回填到「要求描述」" />
          </Form.Item>
          <Form.Item label="标签" name="tags">
            <Input placeholder="多个标签用逗号分隔，如：团餐,邀约,短视频" />
          </Form.Item>
          <Form.Item label="模板说明" name="description">
            <Input.TextArea rows={2} placeholder="说明这个模板适合什么场景，调用后怎么修改" />
          </Form.Item>
          <Form.Item label="模板来源/备注" name="source">
            <Input placeholder="如：用户保存模板 / 品牌案例 / 活动复盘 / 图片改写" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 导入素材 Modal */}
      <Modal
        open={matOpen}
        title="导入素材"
        okText="导入"
        forceRender
        onCancel={() => setMatOpen(false)}
        onOk={submitMat}
      >
        <Form form={matForm} layout="vertical">
          <Form.Item label="素材名称" name="name" rules={[{ required: true, message: '请输入素材名称' }]}>
            <Input maxLength={40} placeholder="如：夏季招牌菜主题活动主视觉" />
          </Form.Item>
          <Form.Item label="素材类型" name="type" rules={[{ required: true, message: '请选择素材类型' }]}>
            <Select
              placeholder="选择素材类型"
              options={['产品图', '海报', '视频', '音频', '文档', 'Logo'].map(t => ({ value: t, label: t }))}
            />
          </Form.Item>
          <Form.Item label="标签" name="tags">
            <Input placeholder="可不填；系统会自动打标。多个标签用逗号分隔，如：招牌菜,主题活动,海报" />
          </Form.Item>
          <Form.Item label="素材链接" name="url">
            <Input placeholder="可选：外部图片/视频/文档链接，便于负责人审阅追溯" />
          </Form.Item>
          <Form.Item label="来源备注" name="note">
            <Input.TextArea rows={2} placeholder="如：员工上传的主题试吃现场图；用于本月会员活动复盘" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

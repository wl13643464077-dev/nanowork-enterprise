import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Skeleton,
  Space,
  Switch,
  Tag,
  message,
} from 'antd';
import {
  CheckOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DownloadOutlined,
  EyeOutlined,
  FileTextOutlined,
  MessageOutlined,
  PictureOutlined,
  ReloadOutlined,
  RetweetOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getUser } from '../api/client';
import type {
  ContentPipeline,
  ContentPipelineCreateFormValues,
  ContentPipelineCrewMember,
  ContentPipelineStation,
  ContentPipelineWorkflowMode,
} from '../api/contentPipelineTypes';
import { buildPaihuoContentBrief } from './contentBriefForm.js';
import ContentPipelineSchedulesPanel from './ContentPipelineSchedulesPanel';
import { ArtifactActions } from './ArtifactActions';
import ContentEmployeeResult, { contentEmployeeResultDocument } from './ContentEmployeeResult';
import { Markdown } from './Markdown';
import {
  CONTENT_PIPELINE_APPROVAL_PRESETS,
  contentPipelineActualReviewStations,
  contentPipelineCanConfigureApproval,
  contentPipelineCanReview,
  contentPipelineCanViewRuntimePackageEvidence,
  contentPipelineHasAdvanced,
  contentPipelineLocalDateTimeValue,
  contentPipelineProgressSnapshot,
  contentPipelinePublicationMetricsProgress,
  contentPipelineQueuedReceipt,
  contentPipelinePresetStations,
  contentPipelineWorkflowModeForPreset,
  contentPipelineRuntimePackageEvidence,
  contentPipelineStatusMeta,
  pipelineCandidates,
  pipelineFailureText,
  pipelineStationRows,
  unwrapContentPipeline,
  unwrapContentPipelineList,
} from './contentPipelinePresentation.js';
import './ContentPipelineWorkbench.css';

type Props = {
  open: boolean;
  crew: ContentPipelineCrewMember[];
  onClose: () => void;
  initialPipelineId?: number | null;
};

const MANAGE_ROLES = new Set(['boss', 'ops_director', 'manager', 'admin', 'platform_super']);
const PAID_MEDIA_AUTHORIZATION_SCHEMA = 'nanowork.content-paid-media-authorization/3';
const PAID_MEDIA_REAUTHORIZATION_FAILURE_CODES = new Set([
  'CONTENT_PAID_MEDIA_AUTHORIZATION_REQUIRED',
  'CONTENT_PAID_MEDIA_REAUTHORIZATION_REQUIRED',
  'CONTENT_PAID_MEDIA_AUTHORIZATION_EXPIRED',
  'CONTENT_PAID_MEDIA_AUTHORIZATION_STALE',
  'CONTENT_PAID_MEDIA_AUTHORIZATION_LIMIT_EXCEEDED',
]);
const PLATFORM_OPTIONS = ['小红书', '公众号', '抖音', '视频号', 'B站', '微博'].map(value => ({
  value,
  label: value,
}));
const IMAGE_MODE_OPTIONS = [
  { value: 'ai', label: '仅 AI 生成' },
  { value: 'real', label: '仅已授权真实素材（不足即停）' },
  { value: 'mix', label: '已授权真实素材优先，不足由 GPT Image 2 补齐' },
];
const PIPELINE_STATION_NAMES = [
  '趋势官',
  '情报员',
  '拆解师',
  '撰稿人',
  '文风师',
  '多媒体师',
  '封面师',
  '演绎师',
  '分发官',
  '复盘官',
] as const;
const APPROVAL_STATION_OPTIONS = PIPELINE_STATION_NAMES.map((name, stationIdx) => ({
  value: stationIdx,
  label: `${stationIdx} · ${name}`,
}));
const REAL_MATERIAL_PROVIDER_UNAVAILABLE =
  '严格真实素材模式暂未取得服务端“已连接且已验证”的授权素材能力证据；可改用素材优先模式，缺图由 GPT Image 2 补齐。';
const VERIFIED_PROVIDER_STATUSES = new Set(['ready', 'available', 'connected', 'verified', 'passed']);
const WORKFLOW_OPTIONS: Array<{ value: ContentPipelineWorkflowMode; label: string }> = [
  { value: 'copilot', label: '关键节点审阅' },
  { value: 'fullauto', label: '内部自动接力' },
  { value: 'autopilot', label: '自动接力·最终工位人工审阅' },
  { value: 'manual', label: '逐工位审阅' },
];
const TEMPLATE_OPTIONS = ['蹭热点', '日更选题', '小红书带货笔记', '产品软文', '观点输出', '教程干货', '二创改写'].map(
  value => ({
    value,
    label: value,
  }),
);
const RUNTIME_EVIDENCE_MISSING = '证据未返回';
const PHASE_LABELS: Record<string, string> = {
  claim: '领取工位',
  context: '装载真实上游',
  agentic_search: '隔离 WebSearch',
  controlled_fetch: '受控 WebFetch',
  provider: '调用 Provider',
  validate: '岗位契约校验',
  persist: '产物入库',
  settle: '账务结算',
  failure: '失败留痕',
  retry: '重试排队',
  recover: '中断恢复',
};
const PHASE_STATE_META: Record<string, { label: string; tone: string }> = {
  started: { label: '进行中', tone: 'processing' },
  completed: { label: '已完成', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  skipped: { label: '未调用', tone: 'default' },
  waiting: { label: '等待处理', tone: 'gold' },
  recovered: { label: '已恢复', tone: 'cyan' },
  retrying: { label: '正在重试', tone: 'blue' },
};
const QUEUED_POLL_INTERVAL_MS = 2_000;
const QUEUED_POLL_TIMEOUT_MS = 60_000;
const QUEUED_ACTION_COPY = {
  retry: {
    badge: '重试已排队',
    message: '失败工位重试已排队',
    description: '服务端已接受重试，页面正在等待工位尝试次数、流水线版本或权威状态变化。',
  },
  recover: {
    badge: '恢复已排队',
    message: '中断工位恢复已排队',
    description: '服务端已接受恢复请求，页面正在读取权威运行进度。',
  },
  resume: {
    badge: '继续运行已排队',
    message: '流水线继续运行已排队',
    description: '服务端已接受继续运行请求，页面正在读取权威运行进度。',
  },
  approve: {
    badge: '审阅通过·继续已排队',
    message: '人工审阅已记录，后续工位已排队',
    description: '页面正在等待服务端权威详情返回新的状态、版本或尝试次数。',
  },
  metrics: {
    badge: '发布指标已回传',
    message: '真实发布指标已保存，复盘官已排队',
    description: '页面正在等待复盘官基于本次发布记录和数值指标生成新一轮复盘产物。',
  },
  authorize: {
    badge: '付费配图+封面已授权',
    message: '老板授权已保存，媒体工位已排队',
    description: '页面正在等待服务端继续配图或封面工位；授权不包含任何对外发布动作。',
  },
} as const;

type BossViewMode = 'simple' | 'standard' | 'pro';

const VIEW_MODE_STORAGE_KEY = 'nw-content-pipeline-view-mode';
const VIEW_MODE_META: Record<BossViewMode, { label: string; hint: string; brief: string }> = {
  simple: {
    label: '简洁',
    hint: '只看定稿、高清图和发布包，别的都不放',
    brief: '只保留可以直接拿去用的交付物',
  },
  standard: {
    label: '标准',
    hint: '交付物在前，每位员工一句话汇报',
    brief: '过程默认收起，只展开定稿、配图、发布包和复盘',
  },
  pro: {
    label: '专业',
    hint: '展开全部工位、过程、费用与执行证据',
    brief: '每个工位的过程、费用与证据全部可查',
  },
};

function initialBossViewMode(): BossViewMode {
  try {
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (stored === 'simple' || stored === 'standard' || stored === 'pro') return stored;
  } catch {
    /* 隐私模式等场景读取失败时使用默认档位 */
  }
  return 'standard';
}

type QueuedAction = keyof typeof QUEUED_ACTION_COPY;
type QueuedTransition = {
  token: number;
  pipelineId: number;
  action: QueuedAction;
  baseline: ReturnType<typeof contentPipelineProgressSnapshot>;
  startedAt: number;
  deadlineAt: number;
  phase: 'polling' | 'timed_out';
  lastCheckedAt: number | null;
  lastPollError: string;
};

type PublicationMetricsFormValues = {
  platform: string;
  url: string;
  publishedAt: string;
  externalId?: string;
  views?: number;
  impressions?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
  evidenceNote?: string;
};

type PaidMediaEstimate = {
  maximumContentImageCount: number;
  maximumCoverImageCount: number;
  maximumImageCount: number;
  estimatedUnitCredits: number;
  estimatedMaximumCredits: number;
  authorizationValidHours: number;
};

function boundaryCode(station: ContentPipelineStation | null | undefined) {
  const boundary = station?.approvalBoundary;
  return typeof boundary === 'string' ? boundary : String(boundary?.code || '');
}

function fmtTime(value: unknown) {
  if (!value) return '时间未返回';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString('zh-CN', { hour12: false }).replace(/\//gu, '-');
}

const PIPELINE_OUTPUT_LABELS: Record<string, string> = {
  briefing: '趋势简报',
  channel_scan: '平台观察',
  topics: '选题建议',
  summary: '结论摘要',
  facts: '事实依据',
  data_points: '关键数据',
  viewpoints: '可用观点',
  sources: '来源',
  benchmarks: '对标案例',
  comment_insights: '评论洞察',
  user_language: '用户原话',
  takeaways: '行动建议',
  title_candidates: '标题候选',
  body: '正文',
  tags: '标签',
  image_plan: '配图计划',
  consistency_note: '一致性说明',
  images: '图片交付',
  covers: '封面交付',
  html: '演绎稿',
  versions: '平台版本',
  strategy: '策略',
  cover_text: '封面文案',
  comment_prompt: '首评',
  framework_ref: '结构参考',
  facts_used: '登记事实',
  self_score: '模型自评（非发布效果）',
  xhsSelection: '老板已选版本',
  publish_plan: '发布计划',
  report: '复盘报告',
  next_topics: '下一轮选题',
  profile_updates: '人设建议',
};

function outputLabel(value: string) {
  return PIPELINE_OUTPUT_LABELS[value] || value.replace(/_/gu, ' ');
}

function outputValueMarkdown(value: unknown, depth = 0): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item, index) => {
        if (item && typeof item === 'object') {
          const nested = outputValueMarkdown(item, depth + 1);
          return nested ? `${index + 1}. ${nested.replace(/\n/gu, '\n   ')}` : '';
        }
        const plain = outputValueMarkdown(item, depth + 1);
        return plain ? `- ${plain}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => {
        const rendered = outputValueMarkdown(item, depth + 1);
        if (!rendered) return '';
        const heading = depth === 0 ? '###' : depth === 1 ? '####' : '- **';
        return depth <= 1
          ? `${heading} ${outputLabel(key)}\n\n${rendered}`
          : `${heading}${outputLabel(key)}：** ${rendered}`;
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return String(value);
}

function pipelineOutputMarkdown(value: unknown) {
  let reportValue = value;
  if (typeof value === 'string' && (value.trim().startsWith('{') || value.trim().startsWith('['))) {
    try {
      reportValue = JSON.parse(value);
    } catch {
      // 普通文本不做猜测；继续交给安全 Markdown 渲染。
    }
  }
  const markdown = outputValueMarkdown(reportValue).trim();
  return markdown || '产物已返回，但没有可展示的可读正文。';
}

function pipelineStationMarkdown(station: ContentPipelineStation, pipeline: ContentPipeline) {
  if (station.stationIdx === 8) {
    const fromDelivery = renderPublishDeliveryMarkdown(pipeline.delivery);
    if (fromDelivery) return fromDelivery;
    const fromVersions = renderPublishVersionsMarkdown(station.output);
    if (fromVersions) return fromVersions;
  }
  return pipelineOutputMarkdown(station.output);
}

function stationResultRaw(station: ContentPipelineStation, pipeline: ContentPipeline) {
  if (station.stationIdx === 8) {
    const delivery =
      pipeline.delivery && typeof pipeline.delivery === 'object'
        ? (pipeline.delivery as {
            publish_plan?: unknown;
            packs?: unknown;
            retro?: { report?: unknown };
            versions?: unknown;
          })
        : null;
    if (delivery?.packs || delivery?.versions || station.output) {
      const output =
        station.output && typeof station.output === 'object' ? (station.output as Record<string, unknown>) : {};
      return JSON.stringify({
        publish_plan: delivery?.publish_plan ?? output.publish_plan,
        versions: delivery?.packs || delivery?.versions || output.versions,
        report: delivery?.retro && typeof delivery.retro === 'object' ? delivery.retro.report : output.report,
      });
    }
  }
  if (station.output && typeof station.output === 'object') return JSON.stringify(station.output);
  return typeof station.output === 'string' ? station.output : '';
}

function pipelineDownloadMarkdown(pipeline: ContentPipeline, stations: ReturnType<typeof pipelineStationRows>) {
  const delivery = renderPublishDeliveryMarkdown(pipeline.delivery);
  if (delivery) return delivery;
  return stations
    .filter(station => station.output !== null && station.output !== undefined)
    .map(station => {
      const body =
        pipelineStationMarkdown(station, pipeline) ||
        contentEmployeeResultDocument(stationResultRaw(station, pipeline));
      return `# ${station.employeeName}\n\n${body}`.trim();
    })
    .filter(Boolean)
    .join('\n\n---\n\n');
}

function renderPublishDeliveryMarkdown(value: unknown) {
  if (!value || typeof value !== 'object') return '';
  const delivery = value as {
    title?: unknown;
    publish_plan?: unknown;
    packs?: unknown;
    retro?: { report?: unknown };
  };
  const packs = Array.isArray(delivery.packs) ? delivery.packs : [];
  if (!packs.length) return '';
  const sections = [
    delivery.title ? `**定稿标题**：${String(delivery.title)}` : '',
    delivery.publish_plan ? `**发布节奏**：${String(delivery.publish_plan)}` : '',
    '',
  ];
  for (const pack of packs) {
    if (!pack || typeof pack !== 'object') continue;
    const item = pack as Record<string, unknown>;
    const tags = Array.isArray(item.tags) ? item.tags.map(tag => `#${String(tag).trim()}`).join(' ') : '';
    const checklist = Array.isArray(item.checklist)
      ? item.checklist.map(entry => `- ${String(entry).trim()}`).join('\n')
      : '';
    sections.push(
      `## ${String(item.emoji || '📄')} ${String(item.platform || '平台')}发布包`,
      '',
      `**标题**：${String(item.title || '')}`,
      item.cover_text ? `**封面文案**：${String(item.cover_text)}` : '',
      item.strategy ? `**所选策略**：${String(item.strategy)}` : '',
      item.source_version_id ? `**源版本**：${String(item.source_version_id)}` : '',
      item.version_id ? `**定稿版本**：${String(item.version_id)}` : '',
      `**建议发布时间**：${String(item.best_time || '')}`,
      tags ? `**标签**：${tags}` : '',
      item.upload_url ? `**发布后台**：${String(item.upload_url)}` : '',
      item.note ? `**注意事项**：${String(item.note)}` : '',
      '',
      '### 适配正文',
      '',
      String(item.body || '').trim(),
      '',
      item.comment_prompt ? `**首评**：${String(item.comment_prompt)}` : '',
      checklist ? '### 后台操作清单' : '',
      checklist,
      '',
    );
  }
  const retro =
    delivery.retro && typeof delivery.retro === 'object'
      ? String((delivery.retro as { report?: unknown }).report || '').trim()
      : '';
  if (retro) sections.push('## 复盘报告', '', retro, '');
  return sections
    .filter((item, index, list) => item !== '' || list[index - 1] !== '')
    .join('\n')
    .trim();
}

function renderPublishVersionsMarkdown(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const parsed = value as { versions?: unknown; publish_plan?: unknown };
  if (!Array.isArray(parsed.versions) || !parsed.versions.length) return '';
  return renderPublishDeliveryMarkdown({
    publish_plan: parsed.publish_plan,
    packs: parsed.versions,
  });
}

function pipelineTaskMarkdown(pipeline: ContentPipeline) {
  const task = (pipeline.task || pipeline.brief || {}) as Record<string, unknown>;
  const direction = String(task.direction || pipeline.title || '未返回任务内容').trim();
  const material = String(task.material || '').trim();
  const platforms = Array.isArray(task.platforms)
    ? task.platforms.map(value => String(value || '').trim()).filter(Boolean)
    : [];
  const requirements = [
    material ? `**已给材料与约束**\n\n${material}` : '',
    platforms.length ? `**目标平台**：${platforms.join('、')}` : '',
    task.template ? `**内容类型**：${String(task.template)}` : '',
    task.industry ? `**行业 / 赛道**：${String(task.industry)}` : '',
  ].filter(Boolean);
  return [`## ${direction}`, ...requirements].join('\n\n');
}

function stationReportTitle(station: ContentPipelineStation & { employeeName?: string }) {
  if (station.stationIdx === 8) return '团队交付·平台发布包';
  if (station.stationIdx === 9) return '团队交付·发布复盘报告';
  return `${station.employeeName || `工位 ${station.stationIdx}`}的阶段报告`;
}

function evidenceText(value: string | null) {
  return value || RUNTIME_EVIDENCE_MISSING;
}

function evidenceCount(value: number | null) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? `${value} 项` : RUNTIME_EVIDENCE_MISSING;
}

function artifactUrl(value: unknown) {
  const url = String(value || '');
  return /^\/api\/content\/pipelines\/\d+\/stations\/[0-9]\/artifacts\/\d+\/(?:preview|download)$/u.test(url)
    ? url
    : '';
}

function providerAssetUrl(value: unknown) {
  const url = String(value || '');
  return /^\/api\/content\/pipelines\/\d+\/stations\/[0-9]\/provider-assets\/\d+\/(?:preview|download)$/u.test(url)
    ? url
    : '';
}

function formatArtifactSize(value: unknown) {
  if (value === null || value === undefined || value === '') return '大小未返回';
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未返回';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ArtifactBadgeMeta = { label: string; color?: string };

const ARTIFACT_AVAILABILITY_META: Record<string, ArtifactBadgeMeta> = {
  awaiting_approval: { label: '已保存 · 等待停站确认', color: 'gold' },
  awaiting_metrics: { label: '待真实指标 · 当前不是最终复盘', color: 'cyan' },
  billing_pending: { label: '已保存 · 待对账，不可业务采用', color: 'gold' },
  remote_reference: { label: '远程引用 · 尚未固化为最终素材', color: 'blue' },
  pending: { label: '等待处理', color: 'default' },
  running: { label: '处理中 · 尚未完成', color: 'processing' },
  paused: { label: '已暂停 · 尚未完成', color: 'gold' },
  failed: { label: '生成失败 · 不可使用', color: 'red' },
  rejected: { label: '已退回 · 需要重新生成', color: 'red' },
  cancelled: { label: '已取消 · 仅保留历史', color: 'default' },
  skipped: { label: '本次未生成', color: 'default' },
};

function artifactBadgeMeta(value: { availability?: string; finalUsable?: boolean } | null | undefined) {
  const availability = String(value?.availability || '').trim();
  if (availability === 'final' && value?.finalUsable === true) {
    return { label: '已完成 · 可预览下载', color: 'green' } satisfies ArtifactBadgeMeta;
  }
  if (ARTIFACT_AVAILABILITY_META[availability]) return ARTIFACT_AVAILABILITY_META[availability];
  if (value?.finalUsable === true) {
    return { label: '已固化 · 可预览下载', color: 'green' } satisfies ArtifactBadgeMeta;
  }
  return { label: '已保存 · 状态待确认', color: 'default' } satisfies ArtifactBadgeMeta;
}

function phaseEventSummary(event: NonNullable<ContentPipelineStation['phaseEvents']>[number]) {
  const detail = event.detail || {};
  const usage = event.usageRef || {};
  const fragments = [
    Number.isSafeInteger(Number(detail.candidateCount)) ? `候选 ${Number(detail.candidateCount)}` : '',
    Number.isSafeInteger(Number(detail.verifiedBodyCount)) ? `正文 ${Number(detail.verifiedBodyCount)}` : '',
    Number.isSafeInteger(Number(detail.artifactCount)) ? `产物 ${Number(detail.artifactCount)}` : '',
    Number.isFinite(Number(usage.totalTokens)) ? `Tokens ${Number(usage.totalTokens)}` : '',
    Number.isFinite(Number(usage.settledCredits ?? usage.chargedCredits))
      ? `结算 ${Number(usage.settledCredits ?? usage.chargedCredits)} 积分`
      : '',
    typeof detail.code === 'string' && detail.code ? detail.code : '',
  ].filter(Boolean);
  return fragments.join(' · ');
}

const BOSS_OPEN_STATIONS = new Set([4, 5, 6, 8, 9]);
const STATION_ATTENTION_STATUSES = new Set([
  'running',
  'failed',
  'awaiting_approval',
  'awaiting_media_authorization',
  'awaiting_metrics',
]);

function productionWeb(station: ContentPipelineStation) {
  const runtime = station.handlerEvidence?.productionRuntime;
  const web = runtime && typeof runtime === 'object' ? (runtime as { web?: Record<string, unknown> }).web : null;
  return web && typeof web === 'object' ? web : null;
}

function stationCaptureSummary(station: ContentPipelineStation) {
  const web = productionWeb(station);
  if (!web) return '';
  const resultCount = Number(web.resultCount ?? (Array.isArray(web.results) ? web.results.length : 0));
  const verified = web.verified === true;
  const attempted = web.attempted === true || web.webSearchCalled === true;
  if (!attempted && web.required === false) return '';
  if (verified && resultCount > 0) return `联网已回传 ${resultCount} 条来源`;
  if (attempted && resultCount > 0) return `已检索到 ${resultCount} 条，核验未完全通过`;
  if (attempted) return '已检索，但没有可核验来源回传';
  return '尚未完成联网抓取';
}

function specialRuntimeFallback(station: ContentPipelineStation) {
  const runtime = station.handlerEvidence?.productionRuntime;
  const special =
    runtime && typeof runtime === 'object'
      ? (
          runtime as {
            specialRuntime?: {
              fallback?: {
                used?: boolean;
                strategy?: string;
                from?: string;
                to?: string;
                reason?: string;
              };
            };
          }
        ).specialRuntime
      : null;
  return special?.fallback || null;
}

type ProviderAsset = NonNullable<ContentPipelineStation['providerAssets']>[number];

const BITMAP_MEDIA_TYPE = /^image\/(?:png|jpe?g|webp|gif)$/iu;
const BITMAP_FILENAME = /\.(?:png|jpe?g|webp|gif)$/iu;
const NON_BITMAP_ASSET = /(?:image\/svg|\.svg(?:$|[?#])|text\/html|\.html?(?:$|[?#])|placeholder|占位|示意图)/iu;

function isDeliverableBitmapProviderAsset(asset: ProviderAsset) {
  const identity = [asset.mediaType, asset.filename, asset.kind].map(value => String(value || '').trim()).join(' ');
  if (!identity || NON_BITMAP_ASSET.test(identity)) return false;
  return (
    BITMAP_MEDIA_TYPE.test(String(asset.mediaType || '').trim()) ||
    BITMAP_FILENAME.test(String(asset.filename || '').trim())
  );
}

type ProviderAssetWithProvenance = ProviderAsset & {
  sourceMaterialId?: number | null;
  rights?: {
    confirmed?: boolean;
    commercialUse?: boolean;
    license?: string | null;
  } | null;
};

function isLicensedMaterialAsset(asset: ProviderAssetWithProvenance) {
  const sourceMaterialId = Number(asset.sourceMaterialId);
  return (
    asset.kind === 'material' &&
    Number.isSafeInteger(sourceMaterialId) &&
    sourceMaterialId > 0 &&
    asset.rights?.confirmed === true &&
    asset.rights?.commercialUse === true &&
    Boolean(String(asset.rights?.license || '').trim())
  );
}

function imageModelLabel(value: unknown) {
  const model = String(value || '').trim();
  return /^gpt-image-2$/iu.test(model) ? 'GPT Image 2' : model;
}

function providerAssetSourceMeta(asset: ProviderAssetWithProvenance) {
  if (isLicensedMaterialAsset(asset)) return { label: '已授权真实素材', color: 'green' };
  if (asset.kind === 'image') {
    const model = imageModelLabel(asset.providerModel);
    return { label: model ? `AI 生成 · ${model}` : 'AI 生成', color: 'purple' };
  }
  return { label: '来源待核验', color: 'gold' };
}

function providerAssetSourceSummary(assets: ProviderAsset[]) {
  const licensed = assets.filter(asset => isLicensedMaterialAsset(asset)).length;
  const aiGenerated = assets.filter(asset => asset.kind === 'image').length;
  const pending = Math.max(0, assets.length - licensed - aiGenerated);
  return [
    licensed > 0 ? `已授权真实素材 ${licensed} 张` : '',
    aiGenerated > 0 ? `AI 生成 ${aiGenerated} 张` : '',
    pending > 0 ? `来源待核验 ${pending} 张` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function stationRetryRemainingText(station: ContentPipelineStation) {
  if (station.retry?.manualUnlimited === true) {
    return stationManualRetryAllowed(station) ? '可手动重试·不限次数' : '手动重试不限次数（仅失败工位）';
  }
  if (station.retry?.remaining == null) return '可手动重试';
  const remaining = Number(station.retry.remaining);
  return Number.isFinite(remaining) && remaining >= 0 ? `剩余 ${Math.floor(remaining)} 次` : '剩余次数未返回';
}

function stationManualRetryAllowed(station: ContentPipelineStation | null | undefined) {
  if (station?.retry?.manualAllowed !== undefined) return station.retry.manualAllowed === true;
  return station?.retry?.allowed === true;
}

function stationBossSummary(station: ContentPipelineStation & { failureText?: string }) {
  if (station.stationIdx === 0 || station.stationIdx === 1) {
    return stationCaptureSummary(station);
  }
  const fallback = specialRuntimeFallback(station);
  if (station.stationIdx === 5 && station.status === 'completed') {
    const images = Array.isArray(station.providerAssets)
      ? station.providerAssets.filter(isDeliverableBitmapProviderAsset)
      : [];
    if (images.length > 0) {
      const sourceSummary = providerAssetSourceSummary(images);
      const fillNote =
        fallback?.strategy === 'licensed_material_to_ai_image' ? '；授权素材不足，已由 GPT Image 2 补齐' : '';
      return `正文配图已交付 ${images.length} 张${sourceSummary ? `（${sourceSummary}）` : ''}${fillNote}`;
    }
    return fallback?.used ? '未取得可交付图片，示意图不作为产物' : '配图工位完成，但未返回可交付图片';
  }
  if (station.stationIdx === 6 && station.status === 'completed') {
    const covers = Array.isArray(station.providerAssets)
      ? station.providerAssets.filter(isDeliverableBitmapProviderAsset)
      : [];
    if (covers.length > 0) {
      const sourceSummary = providerAssetSourceSummary(covers);
      return `封面已交付 ${covers.length} 张${sourceSummary ? `（${sourceSummary}）` : ''}`;
    }
    return fallback?.used ? '未取得可交付封面，HTML 卡不作为产物' : '封面工位完成，但未返回可交付图片';
  }
  if (station.stationIdx === 8 && station.status === 'completed') {
    return Number(station.retry?.used || 0) > 0
      ? '发布包已出 · 第一次云雾未返回真实模型，已自动重试成功'
      : '发布包已出';
  }
  if (station.status === 'skipped') return '按任务设置跳过';
  if (station.status === 'failed') return '';
  if (station.status === 'completed') return '阶段报告已完成';
  return '';
}

function stationFoldOpen(station: ContentPipelineStation) {
  if (STATION_ATTENTION_STATUSES.has(String(station.status || ''))) return true;
  return BOSS_OPEN_STATIONS.has(station.stationIdx) && station.status === 'completed';
}

function bossVisiblePhaseEvents(events: NonNullable<ContentPipelineStation['phaseEvents']>) {
  return events.filter(event => {
    const code = String(event.detail?.code || '');
    return !(event.state === 'skipped' && code === 'CONTENT_PRODUCTION_WEB_NOT_REQUIRED');
  });
}

function numericEvidence(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function pipelineDirection(pipeline: ContentPipeline) {
  return String(pipeline.task?.direction || pipeline.brief?.direction || pipeline.title || `流水线 #${pipeline.id}`);
}

function mergePipelineList(current: ContentPipeline[], pipeline: ContentPipeline) {
  return [pipeline, ...current.filter(item => item.id !== pipeline.id)].sort((a, b) => b.id - a.id);
}

function hasVerifiedRealMaterialProvider(crew: ContentPipelineCrewMember[]) {
  const media = crew.find(item => item.key === 'media' || Number(item.employeeIdx ?? item.order) === 5);
  return (media?.capabilities || []).some(capability => {
    const providerIdentity = [capability.key, capability.kind].map(value => String(value || '').trim()).join(' ');
    const identity = [providerIdentity, capability.name, capability.description, capability.desc]
      .map(value => String(value || '').trim())
      .join(' ');
    const status = String(capability.status || '')
      .trim()
      .toLowerCase();
    const isRealMaterialProvider = /(real.?material|stock.?media|真实素材|全网素材|素材检索)/iu.test(identity);
    const isProviderCapability = /(provider|connector|供应商|连接器)/iu.test(providerIdentity);
    const available = capability.available === true || capability.enabled === true;
    const verified = capability.verified === true || VERIFIED_PROVIDER_STATUSES.has(status);
    return isRealMaterialProvider && isProviderCapability && available && verified;
  });
}

export default function ContentPipelineWorkbench({ open, crew, onClose, initialPipelineId = null }: Props) {
  const [form] = Form.useForm<ContentPipelineCreateFormValues>();
  const [metricsForm] = Form.useForm<PublicationMetricsFormValues>();
  const metricsPublishedAt = Form.useWatch('publishedAt', metricsForm);
  const watchedPlatforms = Form.useWatch('platforms', form);
  const selectedContentType = Form.useWatch('type', form);
  const selectedPlatforms = useMemo(
    () => (Array.isArray(watchedPlatforms) ? watchedPlatforms : []),
    [watchedPlatforms],
  );
  const selectedImageMode = Form.useWatch('imageMode', form);
  const selectedImageCount = Form.useWatch('imageCount', form);
  const approvalPreset = Form.useWatch('approvalPreset', form);
  const role = String(getUser()?.role || '');
  const canManage = MANAGE_ROLES.has(role);
  const canConfigureApproval = contentPipelineCanConfigureApproval(role);
  const canViewRuntimePackageEvidence = contentPipelineCanViewRuntimePackageEvidence(role);
  const canViewApprovalPolicy = canManage;
  const [pipelines, setPipelines] = useState<ContentPipeline[]>([]);
  const [activePipeline, setActivePipeline] = useState<ContentPipeline | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [creating, setCreating] = useState(false);
  const [mutation, setMutation] = useState('');
  const [paidMediaEstimate, setPaidMediaEstimate] = useState<PaidMediaEstimate | null>(null);
  const [paidMediaEstimateError, setPaidMediaEstimateError] = useState('');
  const [selectionByStation, setSelectionByStation] = useState<Record<number, number | undefined>>({});
  const [queuedTransition, setQueuedTransition] = useState<QueuedTransition | null>(null);
  const [viewMode, setViewMode] = useState<BossViewMode>(initialBossViewMode);
  const changeViewMode = useCallback((next: BossViewMode) => {
    setViewMode(next);
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, next);
    } catch {
      /* 存不进去也不影响本次会话的档位 */
    }
  }, []);
  const activeIdRef = useRef<number | null>(null);
  const detailSerial = useRef(0);
  const queueSerial = useRef(0);
  const queuedForActive = queuedTransition?.pipelineId === activePipeline?.id ? queuedTransition : null;

  const applyPipeline = useCallback((pipeline: ContentPipeline) => {
    activeIdRef.current = pipeline.id;
    setActivePipeline(pipeline);
    setPipelines(current => mergePipelineList(current, pipeline));
  }, []);

  const loadPipeline = useCallback(
    async (pipelineId: number, { quiet = false } = {}) => {
      const serial = ++detailSerial.current;
      if (!quiet) setDetailLoading(true);
      try {
        const payload = await api.get(`/content/pipelines/${pipelineId}`, { silent: quiet });
        const pipeline = unwrapContentPipeline(payload);
        if (!pipeline) throw new Error('流水线详情没有返回有效编号');
        if (serial === detailSerial.current) applyPipeline(pipeline);
        return pipeline;
      } catch (error: any) {
        if (!quiet) message.error(error?.message || '流水线详情读取失败');
        return null;
      } finally {
        if (!quiet && serial === detailSerial.current) setDetailLoading(false);
      }
    },
    [applyPipeline],
  );

  const beginQueuedTransition = useCallback(
    (pipelineId: number, action: QueuedAction, baselinePipeline: ContentPipeline) => {
      const startedAt = Date.now();
      setQueuedTransition({
        token: ++queueSerial.current,
        pipelineId,
        action,
        baseline: contentPipelineProgressSnapshot(baselinePipeline),
        startedAt,
        deadlineAt: startedAt + QUEUED_POLL_TIMEOUT_MS,
        phase: 'polling',
        lastCheckedAt: null,
        lastPollError: '',
      });
    },
    [],
  );

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError('');
    try {
      const payload = await api.get('/content/pipelines');
      const rows = unwrapContentPipelineList(payload);
      setPipelines(rows);
      const currentId = activeIdRef.current;
      const selected = rows.find(item => item.id === currentId) || rows[0] || null;
      if (selected) {
        await loadPipeline(selected.id, { quiet: true });
        setCreateOpen(false);
      } else {
        activeIdRef.current = null;
        setActivePipeline(null);
        if (canManage) setCreateOpen(true);
      }
    } catch (error: any) {
      setListError(error?.message || '流水线列表读取失败');
    } finally {
      setListLoading(false);
    }
  }, [canManage, loadPipeline]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const targetId = Number(initialPipelineId);
      if (Number.isSafeInteger(targetId) && targetId > 0) {
        void loadPipeline(targetId).then(target => {
          if (cancelled) return;
          if (target) setCreateOpen(false);
          else void loadList();
        });
      } else {
        void loadList();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialPipelineId, loadList, loadPipeline, open]);

  useEffect(() => {
    if (!open || !createOpen || !canConfigureApproval) return;
    let cancelled = false;
    const imageCount = Number(selectedImageCount);
    const queryValue = Number.isSafeInteger(imageCount) && imageCount > 0 ? String(imageCount) : 'auto';
    const platformCount = Math.max(
      1,
      Math.min(4, new Set(selectedPlatforms.map(item => String(item || '').trim()).filter(Boolean)).size || 1),
    );
    void api
      .get(`/content/pipelines/paid-media-estimate?imageCount=${queryValue}&platformCount=${platformCount}`, {
        silent: true,
      })
      .then(payload => {
        if (cancelled) return;
        const estimate = payload?.estimate;
        if (
          Number.isSafeInteger(Number(estimate?.maximumContentImageCount)) &&
          Number.isSafeInteger(Number(estimate?.maximumCoverImageCount)) &&
          Number.isSafeInteger(Number(estimate?.maximumImageCount)) &&
          Number.isSafeInteger(Number(estimate?.estimatedUnitCredits)) &&
          Number.isSafeInteger(Number(estimate?.estimatedMaximumCredits))
        ) {
          setPaidMediaEstimateError('');
          setPaidMediaEstimate({
            maximumContentImageCount: Number(estimate.maximumContentImageCount),
            maximumCoverImageCount: Number(estimate.maximumCoverImageCount),
            maximumImageCount: Number(estimate.maximumImageCount),
            estimatedUnitCredits: Number(estimate.estimatedUnitCredits),
            estimatedMaximumCredits: Number(estimate.estimatedMaximumCredits),
            authorizationValidHours: Number(estimate.authorizationValidHours || 24),
          });
        } else {
          setPaidMediaEstimate(null);
          setPaidMediaEstimateError('服务端未返回有效费用上限');
        }
      })
      .catch(() => {
        if (cancelled) return;
        setPaidMediaEstimate(null);
        setPaidMediaEstimateError('暂时无法读取费用上限；不影响先创建并在配图/封面工位等待老板授权。');
      });
    return () => {
      cancelled = true;
    };
  }, [canConfigureApproval, createOpen, open, selectedImageCount, selectedPlatforms]);

  useEffect(() => {
    if (!open || !queuedTransition || queuedTransition.phase !== 'polling') return;
    const transition = queuedTransition;
    let cancelled = false;
    let requestRunning = false;

    const markTimedOut = () => {
      setQueuedTransition(current =>
        current?.token === transition.token
          ? {
              ...current,
              phase: 'timed_out',
              lastPollError: current.lastPollError || '服务端在 60 秒内未返回新版本、新尝试次数或新状态。',
            }
          : current,
      );
    };

    const poll = async () => {
      if (cancelled || requestRunning) return;
      if (Date.now() >= transition.deadlineAt) {
        markTimedOut();
        return;
      }
      requestRunning = true;
      const pipeline = await loadPipeline(transition.pipelineId, { quiet: true });
      requestRunning = false;
      if (cancelled) return;
      if (!pipeline) {
        setQueuedTransition(current =>
          current?.token === transition.token
            ? {
                ...current,
                lastCheckedAt: Date.now(),
                lastPollError: '本次未取得服务端权威详情，页面会在超时前继续重试。',
              }
            : current,
        );
        return;
      }
      if (contentPipelineHasAdvanced(transition.baseline, pipeline)) {
        setQueuedTransition(current => (current?.token === transition.token ? null : current));
        message.success(`已取得服务端最新状态：${contentPipelineStatusMeta(pipeline.status).label}`);
        return;
      }
      setQueuedTransition(current =>
        current?.token === transition.token ? { ...current, lastCheckedAt: Date.now(), lastPollError: '' } : current,
      );
    };

    void poll();
    const interval = window.setInterval(() => void poll(), QUEUED_POLL_INTERVAL_MS);
    const timeout = window.setTimeout(markTimedOut, Math.max(0, transition.deadlineAt - Date.now()));
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
    // 轮询生命周期只跟随排队回执标识和阶段；“上次检查”文案变化不能重置定时器。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPipeline, open, queuedTransition?.phase, queuedTransition?.token]);

  useEffect(() => {
    if (
      !open ||
      !activePipeline?.id ||
      activePipeline.status !== 'running' ||
      queuedTransition?.pipelineId === activePipeline.id
    )
      return;
    const pipelineId = activePipeline.id;
    const timer = window.setInterval(() => {
      void loadPipeline(pipelineId, { quiet: true });
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [activePipeline?.id, activePipeline?.status, loadPipeline, open, queuedTransition?.pipelineId]);

  const refreshQueuedTransition = async () => {
    const transition = queuedTransition;
    if (!transition) return;
    const pipeline = await loadPipeline(transition.pipelineId);
    if (!pipeline) {
      setQueuedTransition(current =>
        current?.token === transition.token
          ? { ...current, lastPollError: '手动刷新仍未取得服务端权威详情。' }
          : current,
      );
      return;
    }
    if (contentPipelineHasAdvanced(transition.baseline, pipeline)) {
      setQueuedTransition(current => (current?.token === transition.token ? null : current));
      message.success(`已刷新为服务端最新状态：${contentPipelineStatusMeta(pipeline.status).label}`);
      return;
    }
    setQueuedTransition(current =>
      current?.token === transition.token
        ? {
            ...current,
            lastCheckedAt: Date.now(),
            lastPollError: '服务端仍返回排队前的状态、版本和尝试次数，尚不能判定新一轮已开始。',
          }
        : current,
    );
  };

  const stationRows = useMemo(() => pipelineStationRows(activePipeline, crew), [activePipeline, crew]);
  const pipelineDocument = useMemo(
    () => (activePipeline ? pipelineDownloadMarkdown(activePipeline, stationRows) : ''),
    [activePipeline, stationRows],
  );
  const publicationMetricsProgress = useMemo(
    () => contentPipelinePublicationMetricsProgress(activePipeline),
    [activePipeline],
  );
  const metricsPublishedAtIso = useMemo(() => {
    if (!metricsPublishedAt) return '';
    const parsed = new Date(metricsPublishedAt);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
  }, [metricsPublishedAt]);
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '本机时区';
  const realMaterialProviderAvailable = useMemo(() => hasVerifiedRealMaterialProvider(crew), [crew]);
  const imageModeOptions = useMemo(
    () =>
      IMAGE_MODE_OPTIONS.map(option =>
        option.value !== 'real'
          ? option
          : {
              ...option,
              disabled: !realMaterialProviderAvailable,
              label: realMaterialProviderAvailable ? option.label : `${option.label}（未接通）`,
            },
      ),
    [realMaterialProviderAvailable],
  );
  const actualReviewStations = contentPipelineActualReviewStations(activePipeline);
  const isInternalAuto = activePipeline?.workflow?.approvalPolicy?.mode === 'internal_auto';
  const currentStation = activePipeline
    ? stationRows.find(station => station.stationIdx === activePipeline.currentStation) || null
    : null;
  const failedStation = activePipeline
    ? stationRows.find(
        station => station.stationIdx === activePipeline.currentStation && station.status === 'failed',
      ) ||
      stationRows.find(station => station.status === 'failed') ||
      null
    : null;
  const failedMediaAuthorizationCode = String(failedStation?.failure?.code || activePipeline?.failure?.code || '');
  const paidMediaAuthorization = activePipeline?.workflow?.paidMediaAuthorization;
  const paidMediaAuthorizationNeedsUpgrade =
    Boolean(paidMediaAuthorization) &&
    String(paidMediaAuthorization?.schemaVersion || '') !== PAID_MEDIA_AUTHORIZATION_SCHEMA;
  const failedStationNeedsPaidMediaReauthorization =
    [5, 6].includes(Number(failedStation?.stationIdx)) &&
    (paidMediaAuthorizationNeedsUpgrade || PAID_MEDIA_REAUTHORIZATION_FAILURE_CODES.has(failedMediaAuthorizationCode));
  const canRetryFailedStation =
    canManage &&
    !queuedForActive &&
    activePipeline?.status === 'failed' &&
    stationManualRetryAllowed(failedStation) &&
    !failedStationNeedsPaidMediaReauthorization;
  const canReauthorizeFailedMedia =
    canConfigureApproval &&
    !queuedForActive &&
    activePipeline?.status === 'failed' &&
    failedStationNeedsPaidMediaReauthorization;
  const pendingStation = activePipeline
    ? stationRows.find(station => station.stationIdx === activePipeline.pendingStation) ||
      stationRows.find(station => station.status === 'awaiting_approval') ||
      null
    : null;
  const jobStatusMeta = contentPipelineStatusMeta(activePipeline?.status);
  const queuedActionCopy = queuedForActive ? QUEUED_ACTION_COPY[queuedForActive.action] : null;
  const bossAssets = useMemo(() => {
    const seen = new Set<number>();
    const list: Array<{
      asset: NonNullable<ContentPipelineStation['providerAssets']>[number];
      kindLabel: string;
    }> = [];
    for (const station of stationRows) {
      if (![5, 6].includes(station.stationIdx)) continue;
      for (const asset of station.providerAssets || []) {
        if (!isDeliverableBitmapProviderAsset(asset)) continue;
        if (seen.has(asset.id)) continue;
        seen.add(asset.id);
        list.push({ asset, kindLabel: asset.sourceStationIdx === 6 ? '封面' : '配图' });
      }
    }
    return list;
  }, [stationRows]);
  const bossAssetSourceSummary = useMemo(
    () => providerAssetSourceSummary(bossAssets.map(item => item.asset)),
    [bossAssets],
  );
  const deliveryPacks = useMemo(() => {
    const packs = activePipeline?.delivery?.packs;
    return Array.isArray(packs) ? packs.filter(pack => pack && typeof pack === 'object') : [];
  }, [activePipeline?.delivery?.packs]);
  const mediaFallbackNote = useMemo(() => {
    const licensedMaterialToAi = stationRows.some(
      station =>
        station.stationIdx === 5 &&
        station.status === 'completed' &&
        specialRuntimeFallback(station)?.strategy === 'licensed_material_to_ai_image',
    );
    if (licensedMaterialToAi) {
      return '已授权真实素材不足，剩余配图已由 GPT Image 2 补齐；AI 生成图片已单独标注。';
    }
    if (bossAssets.length > 0) return '';
    const usedFallback = stationRows.some(
      station =>
        [5, 6].includes(station.stationIdx) &&
        station.status === 'completed' &&
        specialRuntimeFallback(station)?.used === true,
    );
    return usedFallback ? '本轮没有取得可交付图片；SVG、HTML 卡片和占位图不会展示或计入交付。' : '';
  }, [bossAssets.length, stationRows]);
  const finishedStationCount = stationRows.filter(station =>
    ['completed', 'skipped'].includes(String(station.status || '')),
  ).length;
  const copyPack = useCallback((pack: Record<string, unknown>) => {
    const tags = Array.isArray(pack.tags) ? pack.tags.map(tag => `#${String(tag).trim()}`).join(' ') : '';
    const text = [String(pack.title || ''), '', String(pack.body || ''), '', tags]
      .join('\n')
      .replace(/\n{3,}/gu, '\n\n')
      .trim();
    void navigator.clipboard.writeText(text).then(() => message.success('该平台发布文案已复制'));
  }, []);

  const createPipeline = async () => {
    const values = await form.validateFields();
    if (String(values.imageMode || '') === 'real' && !realMaterialProviderAvailable) {
      message.error(REAL_MATERIAL_PROVIDER_UNAVAILABLE);
      return;
    }
    let brief;
    try {
      brief = buildPaihuoContentBrief(values);
    } catch (error: any) {
      message.error(error?.message || '内容 Brief 格式无效');
      return;
    }
    setCreating(true);
    try {
      const reviewStations = contentPipelinePresetStations(values.approvalPreset, values.approvalReviewStations);
      const approvalPolicy =
        values.approvalPreset === 'internal_auto'
          ? { mode: 'internal_auto' as const }
          : canConfigureApproval
            ? {
                mode: 'custom' as const,
                reviewStations,
                configuredByRole: role,
              }
            : { mode: 'internal_auto' as const };
      const payload = await api.post('/content/pipelines', {
        brief,
        workflow: {
          mode: contentPipelineWorkflowModeForPreset(values.approvalPreset),
          approvalPolicy,
          ...(canConfigureApproval ? { paidMediaAuthorized: values.paidMediaAuthorized === true } : {}),
        },
      });
      const pipeline = unwrapContentPipeline(payload);
      const pipelineId = Number(pipeline?.id || payload?.pipelineId || payload?.id);
      if (!Number.isSafeInteger(pipelineId) || pipelineId <= 0) {
        message.error('创建响应未返回有效流水线编号，请先刷新列表确认。');
        return;
      }
      if (pipeline) applyPipeline(pipeline);
      else await loadPipeline(pipelineId);
      setCreateOpen(false);
      message.success(
        values.approvalPreset === 'internal_auto'
          ? '完整团队流水线已建立；10 个工位会在后台自动接力，进度以服务端返回为准。'
          : '完整团队流水线已建立；进度与停站状态以服务端返回为准。',
      );
    } catch {
      // API 客户端已展示服务端错误；保留 Brief 方便修正后重试。
    } finally {
      setCreating(false);
    }
  };

  const authorizePaidMedia = async () => {
    if (!activePipeline || queuedForActive || !canConfigureApproval) return;
    const pipelineId = activePipeline.id;
    const beforeAction = activePipeline;
    setMutation('authorize');
    try {
      const payload = await api.post(`/content/pipelines/${pipelineId}/paid-media-authorization`, {
        authorized: true,
      });
      const pipeline = unwrapContentPipeline(payload);
      if (pipeline) applyPipeline(pipeline);
      if (contentPipelineQueuedReceipt(payload)) {
        beginQueuedTransition(pipelineId, 'authorize', pipeline || beforeAction);
      }
      message.success(
        contentPipelineQueuedReceipt(payload)
          ? QUEUED_ACTION_COPY.authorize.message
          : '老板已更新配图+封面付费上限，现在可重试失败工位。',
      );
    } catch {
      // API客户端已经展示权限、费用或状态错误。
    } finally {
      setMutation('');
    }
  };

  const runLifecycleAction = async (action: 'retry' | 'recover' | 'resume') => {
    if (!activePipeline) return;
    if (queuedForActive) {
      message.info('上一个操作已排队，请等待服务端返回新进度。');
      return;
    }
    const pipelineId = activePipeline.id;
    const beforeAction = activePipeline;
    setMutation(action);
    try {
      const payload = await api.post(`/content/pipelines/${pipelineId}/${action}`, {});
      const pipeline = unwrapContentPipeline(payload);
      if (contentPipelineQueuedReceipt(payload)) {
        beginQueuedTransition(pipelineId, action, pipeline || beforeAction);
        message.success(QUEUED_ACTION_COPY[action].message);
      } else {
        if (pipeline) applyPipeline(pipeline);
        else await loadPipeline(pipelineId);
        message.success('操作已完成，当前状态以服务端最新返回为准。');
      }
    } catch {
      // API 客户端已展示服务端拒绝原因。
    } finally {
      setMutation('');
    }
  };

  const runImmediateLifecycleAction = async (action: 'pause' | 'cancel') => {
    if (!activePipeline || queuedForActive) return;
    const pipelineId = activePipeline.id;
    setMutation(action);
    try {
      const payload = await api.post(`/content/pipelines/${pipelineId}/${action}`, {});
      const pipeline = unwrapContentPipeline(payload);
      if (pipeline) applyPipeline(pipeline);
      else await loadPipeline(pipelineId);
      message.success(
        action === 'pause' ? '流水线已暂停，当前工位不会继续领取。' : '流水线已取消，已交付与已结算历史已保留。',
      );
    } catch {
      // API客户端已展示服务端CAS/账务拒绝原因。
    } finally {
      setMutation('');
    }
  };

  const confirmCancel = () => {
    Modal.confirm({
      title: '确认取消这条内容流水线？',
      content: '未交付的预授权会先释放；已交付产物、已结算账务和审计历史保留。取消后不能继续。',
      okText: '确认取消',
      cancelText: '保留任务',
      okButtonProps: { danger: true },
      onOk: () => runImmediateLifecycleAction('cancel'),
    });
  };

  const reviewPipeline = async (
    request: { action: 'approve'; resumeAfterApproval: true } | { action: 'reject'; resumeAfterApproval: false },
  ) => {
    if (!activePipeline || !pendingStation) return;
    if (queuedForActive) {
      message.info('上一个操作已排队，请等待服务端返回新进度。');
      return;
    }
    const pipelineId = activePipeline.id;
    const beforeAction = activePipeline;
    const code = boundaryCode(pendingStation);
    if (pendingStation.approvalBoundary?.ownerSelectionRequired && !canConfigureApproval) {
      message.warning('小红书发布版本需由老板或管理员选择');
      return;
    }
    const candidates = pipelineCandidates(pendingStation);
    const selectedIndex = selectionByStation[pendingStation.stationIdx];
    if (
      request.action === 'approve' &&
      code === 'pick' &&
      !candidates.some(candidate => candidate.candidateIndex === selectedIndex)
    ) {
      message.warning('请先选择一个真实候选产物');
      return;
    }
    setMutation(`review-${request.action}`);
    try {
      const payload = await api.post(`/content/pipelines/${pipelineId}/review`, {
        action: request.action,
        ...(request.action === 'approve' && code === 'pick' ? { selection: { candidateIndex: selectedIndex } } : {}),
        resumeAfterApproval: request.resumeAfterApproval,
      });
      const pipeline = unwrapContentPipeline(payload);
      if (request.action === 'approve' && contentPipelineQueuedReceipt(payload)) {
        beginQueuedTransition(pipelineId, 'approve', pipeline || beforeAction);
        message.success(QUEUED_ACTION_COPY.approve.message);
      } else {
        if (pipeline) applyPipeline(pipeline);
        else await loadPipeline(pipelineId);
        if (request.action === 'approve') {
          message.success('已记录人工审阅，当前权威状态已刷新。');
        } else {
          message.success('已记录人工驳回，流水线不会对外发布。');
        }
      }
    } catch {
      // API 客户端已展示审阅门禁或状态冲突。
    } finally {
      setMutation('');
    }
  };

  const confirmReject = () => {
    Modal.confirm({
      title: `驳回工位 ${pendingStation?.stationIdx ?? '-'} 的产物？`,
      content: '驳回会保留当前工位产物与审阅记录，并停止后续内部交接。',
      okText: '确认驳回',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => reviewPipeline({ action: 'reject', resumeAfterApproval: false }),
    });
  };

  const confirmRecover = () => {
    Modal.confirm({
      title: '确认恢复中断工位？',
      content: '仅在页面长时停留于“运行中”、且已确认执行进程中断时使用；服务端会再次核验。',
      okText: '确认恢复',
      cancelText: '取消',
      onOk: () => runLifecycleAction('recover'),
    });
  };

  const openMetricsForm = () => {
    const platforms = publicationMetricsProgress.requiredPlatforms;
    metricsForm.setFieldsValue({
      platform: publicationMetricsProgress.missingPlatforms[0] || platforms[0] || '小红书',
      publishedAt: contentPipelineLocalDateTimeValue(new Date()),
    });
    setMetricsOpen(true);
  };

  const submitPublicationMetrics = async () => {
    if (!activePipeline || queuedForActive) return;
    const values = await metricsForm.validateFields();
    const metrics = Object.fromEntries(
      ['views', 'impressions', 'likes', 'comments', 'shares', 'saves', 'clicks']
        .map(key => [key, values[key as keyof PublicationMetricsFormValues]])
        .filter(([, value]) => typeof value === 'number' && Number.isFinite(value)),
    ) as Record<string, number>;
    if (!Object.keys(metrics).length || !Object.values(metrics).some(value => value > 0)) {
      message.warning('至少填写一项平台返回的真实数值指标');
      return;
    }
    const publishedAt = new Date(values.publishedAt);
    if (Number.isNaN(publishedAt.getTime())) {
      message.warning('请填写有效的实际发布时间');
      return;
    }
    const pipelineId = activePipeline.id;
    const beforeAction = activePipeline;
    setMutation('metrics');
    try {
      const payload = await api.post(`/content/pipelines/${pipelineId}/metrics`, {
        publication: {
          platform: values.platform,
          url: values.url,
          publishedAt: new Date(values.publishedAt).toISOString(),
          externalId: values.externalId || null,
        },
        metrics,
        evidenceNote: values.evidenceNote || null,
      });
      const pipeline = unwrapContentPipeline(payload);
      if (pipeline) applyPipeline(pipeline);
      if (contentPipelineQueuedReceipt(payload)) {
        beginQueuedTransition(pipelineId, 'metrics', beforeAction);
        message.success(QUEUED_ACTION_COPY.metrics.message);
      } else {
        const progress = contentPipelinePublicationMetricsProgress(pipeline || beforeAction);
        message.success(
          progress.missingPlatforms.length > 0
            ? `已记录${values.platform}，仍缺${progress.missingPlatforms.join('、')}`
            : `已记录${values.platform}`,
        );
      }
      metricsForm.resetFields();
      setMetricsOpen(false);
    } catch {
      // API 客户端已展示字段、权限或状态错误；保留表单方便修正。
    } finally {
      setMutation('');
    }
  };

  const createPanel = (
    <div className="cpw-create-panel cpw-conversation">
      <section className="cpw-message-row cpw-message-row--assistant" aria-label="完整内容团队欢迎语">
        <div className="cpw-message-avatar">
          <TeamOutlined />
        </div>
        <div className="cpw-message-bubble">
          <small>完整内容团队</small>
          <h3>告诉我你想做什么内容</h3>
          <p>你只需发一句话。趋势、情报、拆解、撰稿、配图、封面、演绎、分发包和复盘会在后台自动接力。</p>
        </div>
      </section>
      <Form
        name="content-pipeline-create"
        form={form}
        className="cpw-chat-composer"
        layout="vertical"
        requiredMark={false}
        initialValues={{
          type: '日更选题',
          platforms: ['小红书'],
          imageMode: 'mix',
          imageCount: null,
          enableDeck: false,
          workflowMode: 'fullauto',
          approvalPreset: 'internal_auto',
          approvalReviewStations: [],
          paidMediaAuthorized: false,
          xhsOptions: { versionCount: 3 },
        }}
        onFinish={() => void createPipeline()}
      >
        <div className="cpw-composer-card">
          <div className="cpw-composer-label">
            <MessageOutlined />
            <span>给完整内容团队发消息</span>
          </div>
          <Form.Item
            name="title"
            className="cpw-composer-question"
            rules={[{ required: true, message: '请写明这次要做的内容' }, { min: 4 }]}
          >
            <Input.TextArea
              rows={5}
              maxLength={2000}
              showCount
              placeholder="例如：帮我做一套“山姆落地迎泽后，太原餐饮怎么接住新客流”的多平台内容包"
            />
          </Form.Item>

          <details className="cpw-composer-settings">
            <summary>
              <span>
                <SettingOutlined /> 更多要求 / 后台设置
              </span>
              <small>平台、素材、风格、付费与停站规则</small>
            </summary>
            <div className="cpw-composer-settings-body">
              <Form.Item name="requirement" label="已确认素材与约束（可选）" rules={[{ max: 20000 }]}>
                <Input.TextArea
                  rows={5}
                  showCount
                  maxLength={20000}
                  placeholder="产品资料、已确认数据、必须保留的观点；未确认的不填"
                />
              </Form.Item>
              <div className="cpw-form-grid">
                <Form.Item name="type" label="内容类型" rules={[{ required: true }]}>
                  <Select options={TEMPLATE_OPTIONS} />
                </Form.Item>
                <Form.Item name="industry" label="行业 / 赛道（可选）" rules={[{ max: 120 }]}>
                  <Input placeholder="未确认可留空" />
                </Form.Item>
                <Form.Item name="platforms" label="目标平台" rules={[{ required: true, type: 'array', min: 1 }]}>
                  <Select mode="multiple" options={PLATFORM_OPTIONS} />
                </Form.Item>
                <Form.Item
                  name="imageMode"
                  label="配图来源"
                  rules={[{ required: true }]}
                  extra={
                    selectedImageMode === 'real'
                      ? realMaterialProviderAvailable
                        ? '严格模式只使用已核验授权素材；数量不足即停，不调用 AI 生图。'
                        : REAL_MATERIAL_PROVIDER_UNAVAILABLE
                      : selectedImageMode === 'ai'
                        ? '仅使用 GPT Image 2 生成，不会标注为已授权真实素材。'
                        : '素材优先模式会先检索已授权真实素材，缺口由 GPT Image 2 补齐。'
                  }
                >
                  <Select options={imageModeOptions} />
                </Form.Item>
                <Form.Item name="imageCount" label="配图数量" extra="留空或 0 代表自动">
                  <InputNumber min={0} max={12} precision={0} placeholder="自动" style={{ width: '100%' }} />
                </Form.Item>
              </div>

              <Form.Item name="refLink" label="参考链接" rules={[{ type: 'url' }, { max: 2000 }]}>
                <Input placeholder="https://" />
              </Form.Item>
              {selectedContentType === '小红书带货笔记' && (
                <>
                  <Alert
                    type="info"
                    showIcon
                    message="多策略笔记必须由老板选版，内部自动接力也会在撰稿人处停下。自评分仅供参考，后续只处理所选版本。"
                  />
                  <div className="cpw-form-grid">
                    <Form.Item name={['xhsOptions', 'versionCount']} label="策略版本数" rules={[{ required: true }]}>
                      <Select options={[2, 3, 4].map(value => ({ value, label: `${value} 版` }))} />
                    </Form.Item>
                    <Form.Item name={['xhsOptions', 'audience']} label="目标客群（可选）" rules={[{ max: 120 }]}>
                      <Input maxLength={120} placeholder="例如：附近上班族" />
                    </Form.Item>
                    <Form.Item name={['xhsOptions', 'scene']} label="消费场景（可选）" rules={[{ max: 120 }]}>
                      <Input maxLength={120} placeholder="例如：工作日午餐" />
                    </Form.Item>
                  </div>
                </>
              )}
              {selectedPlatforms.includes('小红书') && (
                <div className="cpw-style-fields">
                  <Form.Item name={['xhsStyle', 'name']} label="小红书风格名" rules={[{ max: 300 }]}>
                    <Input placeholder="留空则跟随账号人设" />
                  </Form.Item>
                  <Form.Item name={['xhsStyle', 'desc']} label="小红书风格要求" rules={[{ max: 300 }]}>
                    <Input />
                  </Form.Item>
                </div>
              )}
              {selectedPlatforms.includes('抖音') && (
                <div className="cpw-style-fields">
                  <Form.Item name={['dyStyle', 'name']} label="抖音风格名" rules={[{ max: 300 }]}>
                    <Input placeholder="留空则跟随账号人设" />
                  </Form.Item>
                  <Form.Item name={['dyStyle', 'desc']} label="抖音风格要求" rules={[{ max: 300 }]}>
                    <Input />
                  </Form.Item>
                </div>
              )}
              <Form.Item name="enableDeck" label="HTML 演绎稿" valuePropName="checked">
                <Switch checkedChildren="启用" unCheckedChildren="不生成" />
              </Form.Item>

              {canConfigureApproval && (
                <section className="cpw-approval-config" aria-label="付费媒体授权">
                  <header>
                    <div>
                      <strong>付费媒体授权</strong>
                      <small>只控制工位5的授权素材检索与 AI 生成服务，不会授权对外发布。</small>
                    </div>
                    <Tag color="gold">老板确认</Tag>
                  </header>
                  <Form.Item name="paidMediaAuthorized" valuePropName="checked">
                    <Checkbox>
                      {selectedImageMode === 'real'
                        ? '本次创建即授权正文使用已核验素材，并为各平台生成封面'
                        : selectedImageMode === 'ai'
                          ? '本次创建即授权由 GPT Image 2 生成配图'
                          : '本次创建即授权先检索已授权素材，数量不足时由 GPT Image 2 补齐'}
                      ；不勾选时先生产到工位4，工位5等待老板授权，同一授权也覆盖工位6封面
                    </Checkbox>
                  </Form.Item>
                  {paidMediaEstimate ? (
                    <Alert
                      type="warning"
                      showIcon
                      message={`最大费用上限（配图+封面）${paidMediaEstimate.estimatedMaximumCredits} 积分`}
                      description={
                        selectedImageMode === 'real'
                          ? `正文最多 ${paidMediaEstimate.maximumContentImageCount} 张已核验素材，封面最多 ${paidMediaEstimate.maximumCoverImageCount} 张，总计不超过 ${paidMediaEstimate.maximumImageCount} 张；授权 ${paidMediaEstimate.authorizationValidHours} 小时内有效。`
                          : `正文配图最多 ${paidMediaEstimate.maximumContentImageCount} 张，封面最多 ${paidMediaEstimate.maximumCoverImageCount} 张，总计不超过 ${paidMediaEstimate.maximumImageCount} 张；当前单张预估 ${paidMediaEstimate.estimatedUnitCredits} 积分，按实际调用结算。`
                      }
                    />
                  ) : (
                    <Alert
                      type={paidMediaEstimateError ? 'warning' : 'info'}
                      showIcon
                      message={paidMediaEstimateError || '正在读取服务端费用上限'}
                    />
                  )}
                </section>
              )}

              {canConfigureApproval ? (
                <section className="cpw-approval-config" aria-labelledby="cpw-approval-config-title">
                  <header>
                    <div>
                      <strong id="cpw-approval-config-title">运行方式</strong>
                      <small>全自动连续出内部稿；半自动在关键工位停下；定时任务在「定时」面板。</small>
                    </div>
                    <Tag color="blue">老板 / 管理员 / 平台超管可配置</Tag>
                  </header>
                  <Form.Item name="approvalPreset" label="本任务采用" rules={[{ required: true }]}>
                    <Select
                      options={CONTENT_PIPELINE_APPROVAL_PRESETS.map(item => ({
                        value: item.value,
                        label: item.label,
                      }))}
                    />
                  </Form.Item>
                  <p className="cpw-approval-description">
                    {CONTENT_PIPELINE_APPROVAL_PRESETS.find(item => item.value === approvalPreset)?.description ||
                      '选择本任务需要停下审阅的工位。'}
                  </p>
                  {approvalPreset === 'custom' && (
                    <Form.Item name="approvalReviewStations" label="自定义停审工位">
                      <Checkbox.Group className="cpw-station-checks" options={APPROVAL_STATION_OPTIONS} />
                    </Form.Item>
                  )}
                  <Alert
                    type="info"
                    showIcon
                    message="仅内部流转，不会自动对外发布"
                    description="内部工位默认自动接力；团队只生产内部产物和发布包，不会对外发送或发布。"
                  />
                </section>
              ) : canManage ? (
                <Alert
                  className="cpw-approval-readonly"
                  type="info"
                  showIcon
                  message="停站规则由企业负责人管理"
                  description="当前角色不可修改停站点；默认内部自动接力，创建后可在任务详情查看服务端保存的实际规则。"
                />
              ) : null}
            </div>
          </details>

          <div className="cpw-composer-footer">
            <span>默认内部自动接力；付费素材和对外动作仍需单独授权。</span>
            <Button type="primary" htmlType="submit" size="large" icon={<RocketOutlined />} loading={creating}>
              发送并开始生产
            </Button>
          </div>
        </div>
      </Form>
    </div>
  );

  const detailPanel = activePipeline && (
    <div className="cpw-detail">
      <header className="cpw-detail-head">
        <div>
          <Space size={6} wrap>
            {queuedForActive && queuedActionCopy ? (
              <>
                <Tag color="processing">{queuedActionCopy.badge}</Tag>
                <Tag>服务端最后状态：{jobStatusMeta.label}</Tag>
              </>
            ) : (
              <Tag color={jobStatusMeta.tone}>{jobStatusMeta.label}</Tag>
            )}
            {canViewApprovalPolicy && (
              <Tag>
                {WORKFLOW_OPTIONS.find(item => item.value === activePipeline.workflow?.mode)?.label ||
                  activePipeline.workflow?.mode ||
                  '模式未返回'}
              </Tag>
            )}
          </Space>
          <h3>{pipelineDirection(activePipeline)}</h3>
          <p>
            流水线 #{activePipeline.id} · 更新于 {fmtTime(activePipeline.updatedAt)}
          </p>
        </div>
        <Space wrap>
          {pipelineDocument && (
            <ArtifactActions
              title={pipelineDirection(activePipeline) || `内容流水线#${activePipeline.id}`}
              content={pipelineDocument}
              sourceType="content_pipeline"
              sourceId={activePipeline.id}
            />
          )}
          <Button
            icon={<ReloadOutlined />}
            loading={detailLoading}
            onClick={() => (queuedForActive ? void refreshQueuedTransition() : void loadPipeline(activePipeline.id))}
          >
            刷新
          </Button>
          {canRetryFailedStation && (
            <Button loading={mutation === 'retry'} onClick={() => void runLifecycleAction('retry')}>
              重试失败工位
            </Button>
          )}
          {canConfigureApproval && !queuedForActive && activePipeline.status === 'awaiting_media_authorization' && (
            <Button type="primary" loading={mutation === 'authorize'} onClick={() => void authorizePaidMedia()}>
              授权付费配图+封面并继续
            </Button>
          )}
          {canReauthorizeFailedMedia && (
            <Button type="primary" loading={mutation === 'authorize'} onClick={() => void authorizePaidMedia()}>
              重新授权配图+封面上限
            </Button>
          )}
          {canManage && !queuedForActive && activePipeline.status === 'running' && (
            <>
              <Button loading={mutation === 'pause'} onClick={() => void runImmediateLifecycleAction('pause')}>
                暂停流水线
              </Button>
              {currentStation?.status !== 'running' && (
                <Button loading={mutation === 'resume'} onClick={() => void runLifecycleAction('resume')}>
                  继续运行
                </Button>
              )}
              {currentStation?.status === 'running' && (
                <Button icon={<RetweetOutlined />} loading={mutation === 'recover'} onClick={confirmRecover}>
                  恢复中断工位
                </Button>
              )}
            </>
          )}
          {canManage && !queuedForActive && activePipeline.status === 'paused' && (
            <Button type="primary" loading={mutation === 'resume'} onClick={() => void runLifecycleAction('resume')}>
              继续当前工位
            </Button>
          )}
          {canManage &&
            !queuedForActive &&
            [
              'running',
              'paused',
              'awaiting_approval',
              'awaiting_media_authorization',
              'awaiting_metrics',
              'failed',
              'billing_pending',
            ].includes(String(activePipeline.status || '')) && (
              <Button danger loading={mutation === 'cancel'} onClick={confirmCancel}>
                取消流水线
              </Button>
            )}
          {canManage && !queuedForActive && activePipeline.status === 'awaiting_metrics' && (
            <Button type="primary" onClick={openMetricsForm}>
              回传真实发布数据
            </Button>
          )}
        </Space>
      </header>

      <section className="cpw-view-switch" aria-label="老板视图档位">
        <div>
          <strong>看结果的方式</strong>
          <small>{VIEW_MODE_META[viewMode].hint}</small>
        </div>
        <Segmented
          value={viewMode}
          onChange={value => changeViewMode(value as BossViewMode)}
          options={(['simple', 'standard', 'pro'] as const).map(mode => ({
            value: mode,
            label: VIEW_MODE_META[mode].label,
          }))}
        />
      </section>

      {viewMode !== 'simple' && (
        <section className="cpw-message-row cpw-message-row--user" aria-label="你下达的内容任务">
          <div className="cpw-message-bubble cpw-message-bubble--user">
            <small>你发给完整内容团队</small>
            <Markdown content={pipelineTaskMarkdown(activePipeline)} />
            <span className="cpw-message-time">创建于 {fmtTime(activePipeline.createdAt)}</span>
          </div>
          <div className="cpw-message-avatar cpw-message-avatar--user">
            <MessageOutlined />
          </div>
        </section>
      )}

      {queuedForActive && queuedActionCopy && (
        <Alert
          type={queuedForActive.phase === 'timed_out' ? 'warning' : 'info'}
          showIcon
          message={
            queuedForActive.phase === 'timed_out'
              ? `${queuedActionCopy.badge}，但等待权威进度已超时`
              : queuedActionCopy.message
          }
          description={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span>{queuedActionCopy.description}</span>
              <span>
                服务端最后状态：{jobStatusMeta.label}。
                {queuedForActive.phase === 'polling'
                  ? `页面每 ${QUEUED_POLL_INTERVAL_MS / 1000} 秒读取一次权威详情。`
                  : '自动读取已停止，请手动刷新；不会把旧失败快照当成新结果。'}
              </span>
              {queuedForActive.lastPollError && (
                <span style={{ color: 'var(--ui-warning)' }}>{queuedForActive.lastPollError}</span>
              )}
              {queuedForActive.lastCheckedAt && (
                <small>上次检查：{fmtTime(new Date(queuedForActive.lastCheckedAt).toISOString())}</small>
              )}
            </div>
          }
          action={
            <Button size="small" loading={detailLoading} onClick={() => void refreshQueuedTransition()}>
              立即刷新
            </Button>
          }
        />
      )}
      {!queuedForActive && activePipeline.failure ? (
        !['awaiting_media_authorization', 'paused', 'cancelled'].includes(String(activePipeline.status || '')) ? (
          <Alert
            type="error"
            showIcon
            message="流水线执行失败"
            description={pipelineFailureText(activePipeline.failure, '服务未返回失败原因')}
          />
        ) : null
      ) : null}
      {!queuedForActive && activePipeline.status === 'paused' && (
        <Alert
          type="warning"
          showIcon
          message="流水线已暂停"
          description="当前工位不会继续领取。继续前服务端会先复核未结算占扣与provider状态，有不确定态时不会重跑API。"
        />
      )}
      {!queuedForActive && activePipeline.status === 'cancelled' && (
        <Alert
          type="info"
          showIcon
          message="流水线已取消"
          description="未交付的占扣已按账本证据处理；已交付产物、已结算账务与phase审计历史原样保留。"
        />
      )}
      {!queuedForActive && activePipeline.status === 'awaiting_media_authorization' && (
        <Alert
          type="warning"
          showIcon
          message="已完成工位0—4，等待老板授权付费配图"
          description="当前没有调用工位5的文本、图片或素材服务，也没有新增该工位的积分预占。老板确认当前Brief和费用上限后，流水线才会继续。"
        />
      )}
      {!queuedForActive && activePipeline.status === 'awaiting_metrics' && (
        <Alert
          type="info"
          showIcon
          message="发布包已完成，复盘官正在等待真实数据"
          description={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span>请从目标平台逐个回传发布地址、发布时间和数值指标。全部齐备前不会调用复盘模型。</span>
              <Space size={[6, 6]} wrap>
                <span>已提交平台：</span>
                {publicationMetricsProgress.submittedPlatforms.length > 0 ? (
                  publicationMetricsProgress.submittedPlatforms.map(platform => (
                    <Tag color="green" key={`submitted-${platform}`}>
                      {platform}
                    </Tag>
                  ))
                ) : (
                  <Tag>暂无</Tag>
                )}
              </Space>
              <Space size={[6, 6]} wrap>
                <span>缺失平台：</span>
                {publicationMetricsProgress.missingPlatforms.map(platform => (
                  <Tag color="gold" key={`missing-${platform}`}>
                    {platform}
                  </Tag>
                ))}
              </Space>
              <small>已提交数据均标记为人工录入·未经平台自动核验。</small>
            </div>
          }
        />
      )}
      {canViewApprovalPolicy && viewMode !== 'simple' && (
        <details className="cpw-background-settings">
          <summary>
            <span>
              <SettingOutlined /> 后台设置与授权记录
            </span>
            <small>日常产出不需要打开</small>
          </summary>
          <section className="cpw-policy-summary" aria-label="当前企业与本任务内部交接规则">
            <header>
              <div>
                <strong>当前企业 / 本任务内部交接规则</strong>
                <small>以下只展示服务端保存的实际策略，不根据工作模式推测。</small>
              </div>
              <Tag>只读</Tag>
            </header>
            {actualReviewStations === null ? (
              <Alert type="warning" showIcon message="服务端未返回实际停审工位" />
            ) : actualReviewStations.length > 0 ? (
              <div className="cpw-policy-stations">
                <span>实际停审工位</span>
                <Space size={[6, 6]} wrap>
                  {actualReviewStations.map(stationIdx => {
                    const station = stationRows.find(item => item.stationIdx === stationIdx);
                    return (
                      <Tag color="gold" key={stationIdx}>
                        {stationIdx} ·{' '}
                        {station?.employeeName || PIPELINE_STATION_NAMES[stationIdx] || `工位 ${stationIdx}`}
                      </Tag>
                    );
                  })}
                </Space>
              </div>
            ) : (
              <Alert type="success" showIcon message="内部全自动流转：不设停审工位" />
            )}
            <p>仅内部流转，不会自动对外发布；工位 8 只形成发布包，系统仍禁止未经明确授权的对外发布。</p>
            <p>
              {isInternalAuto
                ? '当前任务不设停审工位；分发工位只生成平台发布包。'
                : '分发工位只生成平台发布包，不会执行对外发布。'}
            </p>
          </section>
        </details>
      )}

      {(viewMode === 'simple' ||
        stationRows.some(station => station.stationIdx <= 1 && station.status === 'completed') ||
        activePipeline.status === 'completed') && (
        <section className="cpw-boss-brief" aria-label="给老板看的结果">
          <header>
            <div>
              <strong>给老板看的结果</strong>
              <small>{VIEW_MODE_META[viewMode].brief}</small>
            </div>
          </header>
          {viewMode === 'simple' && activePipeline.status !== 'completed' && (
            <p className="cpw-boss-progress">
              进度 {finishedStationCount}/10 · {jobStatusMeta.label}
              {currentStation?.employeeName && activePipeline.status === 'running'
                ? ` · 当前：${currentStation.employeeName}`
                : ''}
            </p>
          )}
          {activePipeline.delivery?.title && <h3>{String(activePipeline.delivery.title)}</h3>}
          {activePipeline.delivery?.publish_plan && (
            <p className="cpw-boss-brief__plan">{String(activePipeline.delivery.publish_plan)}</p>
          )}
          {bossAssets.length > 0 && (
            <div className="cpw-boss-gallery" aria-label="高清配图与封面">
              <header>
                <strong>
                  <PictureOutlined /> 高清配图与封面
                </strong>
                <small>
                  {bossAssets.length} 张可交付图片
                  {bossAssetSourceSummary ? ` · ${bossAssetSourceSummary}` : ''} · 点开预览，可直接下载
                </small>
              </header>
              <div className="cpw-boss-gallery-grid">
                {bossAssets.map(({ asset, kindLabel }) => {
                  const previewUrl = providerAssetUrl(asset.previewUrl);
                  const downloadUrl = providerAssetUrl(asset.downloadUrl);
                  const sourceMeta = providerAssetSourceMeta(asset);
                  return (
                    <figure key={`boss-asset-${asset.id}`}>
                      {previewUrl ? (
                        <a href={previewUrl} target="_blank" rel="noopener noreferrer">
                          <img src={previewUrl} alt={`${kindLabel}·${asset.filename || asset.id}`} loading="lazy" />
                        </a>
                      ) : (
                        <div className="cpw-provider-asset-unavailable">图片地址未通过安全校验</div>
                      )}
                      <figcaption>
                        <span>
                          {kindLabel}
                          {asset.platform ? ` · ${asset.platform}` : ''}
                          <Tag color={sourceMeta.color}>{sourceMeta.label}</Tag>
                        </span>
                        {downloadUrl && (
                          <Button size="small" type="text" icon={<DownloadOutlined />} href={downloadUrl}>
                            下载
                          </Button>
                        )}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </div>
          )}
          {mediaFallbackNote && viewMode !== 'pro' && <Alert type="warning" showIcon message={mediaFallbackNote} />}
          {viewMode === 'simple' && deliveryPacks.length > 0 && (
            <div className="cpw-boss-packs" aria-label="平台发布包">
              {deliveryPacks.map((pack, index) => {
                const platform = String(pack.platform || `平台 ${index + 1}`);
                const tags = Array.isArray(pack.tags) ? pack.tags.map(tag => `#${String(tag).trim()}`).join(' ') : '';
                return (
                  <article key={`pack-${platform}-${index}`}>
                    <header>
                      <strong>
                        {String(pack.emoji || '📄')} {platform} 发布包
                      </strong>
                      <Button size="small" icon={<CopyOutlined />} onClick={() => copyPack(pack)}>
                        复制文案
                      </Button>
                    </header>
                    <h4>{String(pack.title || '')}</h4>
                    <small>
                      建议发布：{String(pack.best_time || '待定')}
                      {tags ? ` · ${tags}` : ''}
                    </small>
                    <div className="cpw-boss-pack-body">
                      <Markdown content={String(pack.body || '')} />
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {viewMode !== 'simple' && (
            <ul>
              {stationRows
                .filter(station => [0, 1, 5, 6, 8].includes(station.stationIdx) && station.status !== 'pending')
                .map(station => {
                  const summary = stationBossSummary(station);
                  return summary ? (
                    <li key={`brief-${station.stationIdx}`}>
                      <span>{station.employeeName}</span>
                      <strong>{summary}</strong>
                    </li>
                  ) : null;
                })}
            </ul>
          )}
        </section>
      )}

      <ol className="cpw-stations" aria-label="0到9内容生产工位">
        {(viewMode === 'simple'
          ? stationRows.filter(station => STATION_ATTENTION_STATUSES.has(String(station.status || '')))
          : stationRows
        ).map(station => {
          const candidates = pipelineCandidates(station);
          const code = boundaryCode(station);
          const canReview =
            !queuedForActive &&
            station.status === 'awaiting_approval' &&
            contentPipelineCanReview(role, code) &&
            (!station.approvalBoundary?.ownerSelectionRequired || canConfigureApproval);
          const hasOutput = station.output !== null && station.output !== undefined;
          const artifacts = Array.isArray(station.artifacts) ? station.artifacts : [];
          const providerAssets = Array.isArray(station.providerAssets)
            ? station.providerAssets.filter(isDeliverableBitmapProviderAsset)
            : [];
          const primaryArtifact = artifacts.find(artifact => artifact.primary) || artifacts[0] || null;
          const primaryArtifactBadge = artifactBadgeMeta(primaryArtifact);
          const previewUrl = artifactUrl(primaryArtifact?.previewUrl);
          const downloadUrl = artifactUrl(primaryArtifact?.downloadUrl);
          const packageEvidence = contentPipelineRuntimePackageEvidence(station);
          const providerDelivery =
            station.handlerEvidence?.providerDelivery ||
            station.handlerEvidence?.productionRuntime?.providerDelivery ||
            null;
          const inputTokens = numericEvidence(providerDelivery?.usage?.inputTokens);
          const outputTokens = numericEvidence(providerDelivery?.usage?.outputTokens);
          const totalTokens =
            numericEvidence(providerDelivery?.usage?.totalTokens) ??
            (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
          const billingEvidence = station.billingEvidence || null;
          const phaseEvents = Array.isArray(station.phaseEvents) ? station.phaseEvents : [];
          const visiblePhaseEvents = bossVisiblePhaseEvents(phaseEvents);
          const bossSummary = stationBossSummary(station);
          const foldOpen = viewMode === 'pro' ? true : stationFoldOpen(station);
          const heldCredits = numericEvidence(billingEvidence?.heldCredits);
          const settledCredits = numericEvidence(billingEvidence?.settledCredits ?? billingEvidence?.chargedCredits);
          const costYuan = numericEvidence(billingEvidence?.costYuan ?? providerDelivery?.costYuan);
          const retryRemainingText = stationRetryRemainingText(station);
          const manualRetryAllowed = stationManualRetryAllowed(station);
          const canRetryStation =
            canManage &&
            activePipeline.status === 'failed' &&
            station.status === 'failed' &&
            manualRetryAllowed &&
            !failedStationNeedsPaidMediaReauthorization;
          const stationRetryHint =
            station.status !== 'failed'
              ? ''
              : failedStationNeedsPaidMediaReauthorization
                ? '当前正文配图与封面预算授权需要更新，请先由老板重新确认总上限。'
                : !canManage
                  ? '当前账号没有失败工位重试权限'
                  : !manualRetryAllowed
                    ? `服务端未允许重试 · ${retryRemainingText}`
                    : activePipeline.status !== 'failed'
                      ? `流水线当前状态不可重试 · ${retryRemainingText}`
                      : `${retryRemainingText}；每次都会重新校验授权与账务状态`;
          const packageLoadLabel =
            packageEvidence.allRequiredFieldsLoaded === true
              ? '11/11 已全量装载'
              : packageEvidence.allRequiredFieldsLoaded === false
                ? '未完整装载'
                : RUNTIME_EVIDENCE_MISSING;
          return (
            <li
              key={station.stationIdx}
              className={`cpw-station${station.stationIdx >= 8 && hasOutput ? ' cpw-station--delivery' : ''}`}
              data-status={station.status}
            >
              <div className="cpw-station-order">{station.stationIdx}</div>
              <article>
                {/* React 18 不支持 details 的 defaultOpen；open 只在档位或工位状态变化时重新应用 */}
                <details className="cpw-station-fold" key={`fold-${viewMode}`} open={foldOpen || undefined}>
                  <summary className="cpw-station-fold__summary">
                    <header>
                      <div>
                        <span className="cpw-station-employee">
                          <img
                            className="cpw-station-portrait"
                            src={`/avatars/employees/crew-${String(station.stationIdx).padStart(2, '0')}.jpg`}
                            alt=""
                            loading="lazy"
                            onError={event => {
                              event.currentTarget.style.display = 'none';
                            }}
                          />
                          {station.employeeEmoji || <TeamOutlined />} {station.employeeName}
                        </span>
                        {station.employeeGroup && <small>{station.employeeGroup}</small>}
                      </div>
                      <Tag color={station.statusMeta.tone}>{station.statusMeta.label}</Tag>
                    </header>
                    {bossSummary ? <p className="cpw-station-outcome">{bossSummary}</p> : null}
                  </summary>
                  <div className="cpw-station-body">
                    {viewMode === 'pro' && (
                      <div className="cpw-station-meta">
                        {Number(station.attempt || 0) > 0 && <span>尝试 {station.attempt} 次</span>}
                        {station.retry && (
                          <span>
                            重试 {station.retry.used ?? 0} 次 · {stationRetryRemainingText(station)}
                            {Number.isFinite(Number(station.retry.automaticRemaining)) && (
                              <>
                                {' '}
                                · 自动恢复剩余 {Math.max(0, Math.floor(Number(station.retry.automaticRemaining)))} 次
                              </>
                            )}
                          </span>
                        )}
                        {station.startedAt && (
                          <span>
                            <ClockCircleOutlined /> {fmtTime(station.startedAt)}
                          </span>
                        )}
                      </div>
                    )}
                    {viewMode === 'pro' &&
                      (visiblePhaseEvents.length > 0 ||
                        providerDelivery ||
                        billingEvidence ||
                        canViewRuntimePackageEvidence) && (
                        <details className="cpw-tech-fold" aria-label={`${station.employeeName}过程与费用`}>
                          <summary>
                            <strong>过程与费用</strong>
                            <small>
                              {visiblePhaseEvents.length} 步 · 尝试 {station.attempt || 0} 次 · 默认收起
                            </small>
                          </summary>
                          {visiblePhaseEvents.length > 0 && (
                            <details className="cpw-phase-events" aria-label={`${station.employeeName}真实执行进度`}>
                              <summary>
                                <strong>真实执行进度</strong>
                                <small>
                                  {visiblePhaseEvents.length} 步 · 当前尝试 {station.attempt || 0} · 点击展开或收起
                                </small>
                              </summary>
                              <ol>
                                {visiblePhaseEvents.map(event => {
                                  const stateMeta = PHASE_STATE_META[event.state] || {
                                    label: event.state || '状态未返回',
                                    tone: 'default',
                                  };
                                  const summary = phaseEventSummary(event);
                                  return (
                                    <li key={event.id} data-state={event.state}>
                                      <span className="cpw-phase-events__dot" aria-hidden="true" />
                                      <div>
                                        <strong>{PHASE_LABELS[event.phase] || event.phase}</strong>
                                        <small>
                                          Attempt {event.attempt} · {fmtTime(event.occurredAt)}
                                        </small>
                                        {summary && <p>{summary}</p>}
                                      </div>
                                      <Tag color={stateMeta.tone}>{stateMeta.label}</Tag>
                                    </li>
                                  );
                                })}
                              </ol>
                            </details>
                          )}
                          {(providerDelivery || billingEvidence) && (
                            <details className="cpw-runtime-evidence cpw-cost-evidence">
                              <summary>模型 usage 与费用明细</summary>
                              <dl>
                                <div>
                                  <dt>模型</dt>
                                  <dd>{providerDelivery?.model || '未返回'}</dd>
                                </div>
                                <div>
                                  <dt>inputTokens</dt>
                                  <dd>{inputTokens ?? '未返回'}</dd>
                                </div>
                                <div>
                                  <dt>outputTokens</dt>
                                  <dd>{outputTokens ?? '未返回'}</dd>
                                </div>
                                <div>
                                  <dt>totalTokens</dt>
                                  <dd>{totalTokens ?? '未返回'}</dd>
                                </div>
                                <div>
                                  <dt>heldCredits</dt>
                                  <dd>{heldCredits ?? '未预授权'}</dd>
                                </div>
                                <div>
                                  <dt>settledCredits</dt>
                                  <dd>{settledCredits ?? '未结算'}</dd>
                                </div>
                                <div>
                                  <dt>costYuan</dt>
                                  <dd>{costYuan === null ? '未返回' : `¥${costYuan.toFixed(4)}`}</dd>
                                </div>
                              </dl>
                            </details>
                          )}
                          {canViewRuntimePackageEvidence && (
                            <details className="cpw-runtime-evidence">
                              <summary>
                                <span>
                                  <SafetyCertificateOutlined />
                                  {packageEvidence.allRequiredFieldsLoaded === true
                                    ? '完整员工运行包已装载'
                                    : '员工运行包装载证据'}
                                </span>
                                <Tag
                                  color={
                                    packageEvidence.allRequiredFieldsLoaded === true
                                      ? 'green'
                                      : packageEvidence.allRequiredFieldsLoaded === false
                                        ? 'red'
                                        : 'default'
                                  }
                                >
                                  {packageLoadLabel}
                                </Tag>
                              </summary>
                              <div className="cpw-runtime-evidence-body">
                                <p>
                                  仅展示服务端已持久化的白名单执行证据；不展示提示词正文、API Key、Token
                                  或配置正文，也不会回传这些字段。
                                </p>
                                <dl>
                                  <div>
                                    <dt>岗位档案版本</dt>
                                    <dd>
                                      <code>{evidenceText(packageEvidence.profileVersion)}</code>
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>统一包总指纹</dt>
                                    <dd>
                                      <code>{evidenceText(packageEvidence.aggregateFingerprint)}</code>
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>11 字段完整装载</dt>
                                    <dd>{packageLoadLabel}</dd>
                                  </div>
                                  <div>
                                    <dt>完整能力</dt>
                                    <dd>{evidenceCount(packageEvidence.capabilityCount)}</dd>
                                  </div>
                                  <div>
                                    <dt>出厂必备技能</dt>
                                    <dd>{evidenceCount(packageEvidence.requiredSkillCount)}</dd>
                                  </div>
                                  <div>
                                    <dt>历史技能</dt>
                                    <dd>{evidenceCount(packageEvidence.historicalSkillCount)}</dd>
                                  </div>
                                  <div>
                                    <dt>API 绑定</dt>
                                    <dd>{evidenceCount(packageEvidence.apiBindingCount)}</dd>
                                  </div>
                                  <div>
                                    <dt>Tool 绑定</dt>
                                    <dd>{evidenceCount(packageEvidence.toolBindingCount)}</dd>
                                  </div>
                                  <div>
                                    <dt>Connector 绑定</dt>
                                    <dd>{evidenceCount(packageEvidence.connectorBindingCount)}</dd>
                                  </div>
                                  <div>
                                    <dt>实际 Handler</dt>
                                    <dd>
                                      <code>{evidenceText(packageEvidence.handlerId)}</code>
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>实际模型</dt>
                                    <dd>
                                      <code>{evidenceText(packageEvidence.model)}</code>
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>源提示词指纹</dt>
                                    <dd>
                                      <code>{evidenceText(packageEvidence.sourcePromptFingerprint)}</code>
                                    </dd>
                                  </div>
                                </dl>
                              </div>
                            </details>
                          )}
                        </details>
                      )}
                    {!queuedForActive && station.failureText && station.status !== 'awaiting_media_authorization' && (
                      <Alert
                        type="error"
                        showIcon
                        message={station.failureText}
                        description={stationRetryHint || undefined}
                        action={
                          canRetryStation ? (
                            <Button
                              size="small"
                              danger
                              icon={<ReloadOutlined />}
                              loading={mutation === 'retry'}
                              onClick={() => void runLifecycleAction('retry')}
                            >
                              重试本工位
                            </Button>
                          ) : undefined
                        }
                      />
                    )}
                    {providerAssets.length > 0 && (
                      <section className="cpw-provider-assets" aria-label={`${station.employeeName}生成图片与交付素材`}>
                        <header>
                          <div>
                            <strong>
                              <PictureOutlined /> 真实图片产物（{providerAssets.length} 张）
                            </strong>
                            <small>
                              {station.stationIdx === 8
                                ? '来自多媒体工位，已投影到发布包；不会自动外发。'
                                : '这里展示的是已固化到租户素材库的真实位图，可点开查看原图或直接下载。'}
                            </small>
                          </div>
                          <Space size={6} wrap>
                            <Tag color="green">可预览下载</Tag>
                            {providerAssetSourceSummary(providerAssets) && (
                              <Tag color="purple">{providerAssetSourceSummary(providerAssets)}</Tag>
                            )}
                          </Space>
                        </header>
                        <div className="cpw-provider-assets-grid">
                          {providerAssets.map(asset => {
                            const assetPreviewUrl = providerAssetUrl(asset.previewUrl);
                            const assetDownloadUrl = providerAssetUrl(asset.downloadUrl);
                            const assetBadge = artifactBadgeMeta(asset);
                            const sourceMeta = providerAssetSourceMeta(asset);
                            return (
                              <article key={`${station.stationIdx}-${asset.id}`}>
                                {assetPreviewUrl ? (
                                  <a href={assetPreviewUrl} target="_blank" rel="noopener noreferrer">
                                    <img
                                      src={assetPreviewUrl}
                                      alt={asset.filename || `素材 ${asset.id}`}
                                      loading="lazy"
                                    />
                                  </a>
                                ) : (
                                  <div className="cpw-provider-asset-unavailable">图片地址未通过安全校验</div>
                                )}
                                <div className="cpw-provider-asset-meta">
                                  <strong>{asset.filename || `素材 ${asset.id}`}</strong>
                                  <small>
                                    工位 {asset.sourceStationIdx} · {formatArtifactSize(asset.byteSize)}
                                  </small>
                                  <Space size={[4, 4]} wrap>
                                    <Tag color={assetBadge.color}>{assetBadge.label}</Tag>
                                    <Tag color={sourceMeta.color}>{sourceMeta.label}</Tag>
                                  </Space>
                                  <Space size={4} wrap>
                                    {assetPreviewUrl && (
                                      <Button
                                        size="small"
                                        href={assetPreviewUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        查看原图
                                      </Button>
                                    )}
                                    {assetDownloadUrl && (
                                      <Button size="small" icon={<DownloadOutlined />} href={assetDownloadUrl}>
                                        下载
                                      </Button>
                                    )}
                                  </Space>
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      </section>
                    )}
                    {hasOutput && (
                      <section className="cpw-output cpw-assistant-report" aria-label={stationReportTitle(station)}>
                        <ContentEmployeeResult
                          raw={stationResultRaw(station, activePipeline)}
                          title={stationReportTitle(station)}
                          kicker="排版成稿"
                          sourceType="content_pipeline"
                          runId={activePipeline.id}
                        />
                      </section>
                    )}
                    {viewMode === 'pro' && primaryArtifact && (
                      <section className="cpw-artifact" aria-label={`${station.employeeName}主产物`}>
                        <div className="cpw-artifact-copy">
                          <FileTextOutlined />
                          <span>
                            <strong>{primaryArtifact.filename || '工位主产物'}</strong>
                            <small>
                              {primaryArtifact.kind} · {formatArtifactSize(primaryArtifact.byteSize)}
                            </small>
                          </span>
                          <Tag color={primaryArtifactBadge.color}>{primaryArtifactBadge.label}</Tag>
                        </div>
                        <Space size={6} wrap>
                          {previewUrl && (
                            <Button
                              size="small"
                              icon={<EyeOutlined />}
                              href={previewUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              查看主产物
                            </Button>
                          )}
                          {downloadUrl && (
                            <Button size="small" icon={<DownloadOutlined />} href={downloadUrl}>
                              下载
                            </Button>
                          )}
                        </Space>
                      </section>
                    )}
                    {station.status === 'awaiting_approval' && (
                      <div className="cpw-review">
                        {station.approvalBoundary?.ownerSelectionRequired === true && (
                          <Alert
                            type="info"
                            showIcon
                            message="请核对下方各策略全文后明确选版。推荐分数不是发布效果，也不会替你做选择。"
                          />
                        )}
                        {code === 'pick' && candidates.length > 0 && canReview && (
                          <Select
                            value={selectionByStation[station.stationIdx]}
                            placeholder="选择一个候选产物"
                            options={candidates.map(candidate => ({
                              value: candidate.candidateIndex,
                              label: `${candidate.candidateIndex + 1}. ${candidate.label}`,
                            }))}
                            onChange={value =>
                              setSelectionByStation(current => ({ ...current, [station.stationIdx]: value }))
                            }
                          />
                        )}
                        {queuedForActive ? (
                          <span className="cpw-review-blocked">审阅操作已排队，正在等待服务端权威进度</span>
                        ) : canReview ? (
                          <Space wrap>
                            <Button
                              type="primary"
                              icon={<CheckOutlined />}
                              disabled={code === 'pick' && !Number.isInteger(selectionByStation[station.stationIdx])}
                              loading={mutation === 'review-approve'}
                              onClick={() => void reviewPipeline({ action: 'approve', resumeAfterApproval: true })}
                            >
                              {code === 'pick' ? '选择并通过' : '通过并继续'}
                            </Button>
                            <Button danger disabled={!!mutation} onClick={confirmReject}>
                              驳回并停止
                            </Button>
                          </Space>
                        ) : (
                          <span className="cpw-review-blocked">
                            {station.approvalBoundary?.ownerSelectionRequired
                              ? '等待老板或管理员选择小红书版本'
                              : code === 'force'
                                ? '等待老板或管理员终审'
                                : '等待有权限的管理人员审阅'}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </details>
              </article>
            </li>
          );
        })}
      </ol>
    </div>
  );

  return (
    <>
      <Modal
        title="回传真实发布数据"
        open={metricsOpen}
        okText="保存该平台数据"
        cancelText="取消"
        confirmLoading={mutation === 'metrics'}
        onOk={() => void submitPublicationMetrics()}
        onCancel={() => {
          if (mutation === 'metrics') return;
          setMetricsOpen(false);
        }}
        destroyOnClose
      >
        <Alert
          type="warning"
          showIcon
          message="人工录入 · 未经平台自动核验"
          description="只填平台实际返回的数据。没有数据就先不生成复盘；系统不会用演示值、推测值或审批动作代替真实指标。"
        />
        <Form form={metricsForm} layout="vertical" requiredMark={false} className="cpw-metrics-form">
          <div className="cpw-form-grid">
            <Form.Item name="platform" label="发布平台" rules={[{ required: true }]}>
              <Select
                options={(publicationMetricsProgress.requiredPlatforms.length > 0
                  ? publicationMetricsProgress.requiredPlatforms
                  : ['小红书']
                ).map(value => ({
                  value,
                  label: `${value}${publicationMetricsProgress.submittedPlatforms.includes(value) ? '（已提交，可更新）' : '（待提交）'}`,
                }))}
              />
            </Form.Item>
            <Form.Item
              name="publishedAt"
              label="实际发布时间"
              rules={[{ required: true }]}
              extra={
                metricsPublishedAtIso
                  ? `按本机时区 ${localTimezone} 解析；提交值 ISO：${metricsPublishedAtIso}`
                  : `按本机时区 ${localTimezone} 解析`
              }
            >
              <Input type="datetime-local" />
            </Form.Item>
          </div>
          <Form.Item name="url" label="平台发布地址" rules={[{ required: true }, { type: 'url' }]}>
            <Input placeholder="https://" />
          </Form.Item>
          <Form.Item name="externalId" label="平台内容 ID（可选）">
            <Input maxLength={240} />
          </Form.Item>
          <div className="cpw-metrics-grid">
            {[
              ['views', '播放 / 阅读'],
              ['impressions', '曝光'],
              ['likes', '点赞'],
              ['comments', '评论'],
              ['shares', '分享'],
              ['saves', '收藏'],
              ['clicks', '点击'],
            ].map(([name, label]) => (
              <Form.Item key={name} name={name} label={label}>
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            ))}
          </div>
          <Form.Item name="evidenceNote" label="人工来源说明（可选）" rules={[{ max: 1000 }]}>
            <Input.TextArea rows={2} placeholder="例如：人工抄录自平台创作者中心截图" />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        rootClassName="content-pipeline-drawer-root"
        className="content-pipeline-drawer"
        width="min(1180px, 100vw)"
        open={open}
        destroyOnClose
        onClose={onClose}
        title={
          <div className="cpw-title">
            <span>
              <TeamOutlined />
            </span>
            <div>
              <strong>完整团队流水线</strong>
              <small>0→9 真实工位接力</small>
            </div>
          </div>
        }
      >
        <div className="cpw-shell">
          <aside className="cpw-list">
            <header>
              <strong>流水线记录</strong>
              <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => void loadList()}>
                刷新
              </Button>
            </header>
            {canManage && (
              <Button
                className="cpw-new"
                type={createOpen ? 'primary' : 'default'}
                icon={<RocketOutlined />}
                onClick={() => {
                  setQueuedTransition(null);
                  setScheduleOpen(false);
                  setCreateOpen(true);
                }}
              >
                新建完整流水线
              </Button>
            )}
            {canManage && (
              <Button
                className="cpw-new"
                type={scheduleOpen ? 'primary' : 'default'}
                icon={<ClockCircleOutlined />}
                onClick={() => {
                  setQueuedTransition(null);
                  setCreateOpen(false);
                  setScheduleOpen(true);
                }}
              >
                定时运行完整团队
              </Button>
            )}
            {listLoading && <Skeleton active paragraph={{ rows: 4 }} />}
            {!listLoading && listError && <Alert type="error" showIcon message={listError} />}
            {!listLoading && !listError && (
              <div className="cpw-list-items">
                {pipelines.map(pipeline => {
                  const status = contentPipelineStatusMeta(pipeline.status);
                  return (
                    <button
                      type="button"
                      key={pipeline.id}
                      className={!createOpen && !scheduleOpen && activePipeline?.id === pipeline.id ? 'active' : ''}
                      onClick={() => {
                        setQueuedTransition(null);
                        setCreateOpen(false);
                        setScheduleOpen(false);
                        void loadPipeline(pipeline.id);
                      }}
                    >
                      <span>
                        <Tag color={status.tone}>{status.label}</Tag>
                        <small>#{pipeline.id}</small>
                      </span>
                      <strong>{pipelineDirection(pipeline)}</strong>
                      <small>{fmtTime(pipeline.updatedAt || pipeline.createdAt)}</small>
                    </button>
                  );
                })}
                {!pipelines.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有团队流水线" />}
              </div>
            )}
          </aside>
          <main className="cpw-main">
            {scheduleOpen && canManage ? (
              <ContentPipelineSchedulesPanel
                active={open && scheduleOpen}
                role={role}
                canConfigureApproval={canConfigureApproval}
                realMaterialProviderAvailable={realMaterialProviderAvailable}
                onOpenPipeline={pipelineId => {
                  setScheduleOpen(false);
                  setCreateOpen(false);
                  void loadPipeline(pipelineId);
                }}
              />
            ) : createOpen && canManage ? (
              createPanel
            ) : detailLoading && !activePipeline ? (
              <Skeleton active />
            ) : (
              detailPanel
            )}
            {!createOpen && !scheduleOpen && !activePipeline && !detailLoading && (
              <Empty description={canManage ? '选择一条记录，或新建完整流水线' : '当前没有可查看的流水线'} />
            )}
          </main>
        </div>
      </Drawer>
    </>
  );
}

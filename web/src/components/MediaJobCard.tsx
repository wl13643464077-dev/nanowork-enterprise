import { Button, Checkbox, Tag, Tooltip } from 'antd';
import { DeleteOutlined, FolderOpenOutlined, LinkOutlined } from '@ant-design/icons';

export type MediaBilling = {
  state?: 'held' | 'settled' | 'released' | 'pending_reconciliation' | 'missing' | 'not_required' | string;
  estimatedCredits?: number | null;
  heldCredits?: number | null;
  chargedCredits?: number | null;
  credits?: number | null;
  pendingReconciliation?: boolean;
  exempt?: boolean;
  authoritative?: boolean;
  evidenceSource?: string | null;
  note?: string | null;
};

export type MediaJobView = {
  id?: number;
  jobId?: number;
  kind?: 'image' | 'video' | string;
  mediaType?: string;
  mimeType?: string | null;
  prompt?: string;
  model?: string;
  status?: string;
  technicalStatus?: string;
  technicalSuccess?: boolean;
  businessStatus?: string;
  reviewStatus?: string;
  reviewRequired?: boolean;
  businessUsable?: boolean;
  canExport?: boolean;
  isImported?: boolean;
  importedMaterialId?: number | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  canImport?: boolean;
  canImportReason?: string | null;
  canDelete?: boolean;
  deleteBlockedReason?: string | null;
  url?: string | null;
  previewUrl?: string | null;
  urlAvailable?: boolean;
  credits?: number | null;
  billing?: MediaBilling | null;
};

const formatReviewTime = (value?: string | null) =>
  String(value || '')
    .replace('T', ' ')
    .slice(0, 16);

function safeMediaUrl(value?: string | null) {
  const url = String(value || '').trim();
  return /^(https?:\/\/|\/(?!\/)|data:(image|video)\/)/i.test(url) ? url : '';
}

function safePreviewUrl(job: MediaJobView) {
  return safeMediaUrl(job.previewUrl || (job.businessUsable ? job.url : null));
}

function safeExportUrl(job: MediaJobView) {
  if (!job.businessUsable || job.canExport === false) return '';
  return safeMediaUrl(job.url);
}

export function mediaBillingPresentation(billing?: MediaBilling | null) {
  if (!billing?.state) return null;
  const estimated = Number(billing.estimatedCredits || billing.heldCredits || 0);
  const charged = Number(billing.chargedCredits ?? billing.credits ?? 0);
  if (billing.state === 'held') {
    return {
      color: 'processing',
      label: `预授权 ${estimated} 分（未实扣）`,
      detail: billing.note || '任务仍在处理中，当前只是预授权占扣。',
    };
  }
  if (billing.state === 'pending_reconciliation') {
    return {
      color: 'warning',
      label: `业务暂不可采用（待账务对账，预授权 ${estimated} 分未结清）`,
      detail: billing.note || '媒体技术产物已有记录，但账务尚未确认，因此不能进入人工验收或业务使用。',
    };
  }
  if (billing.state === 'released') {
    return {
      color: 'default',
      label: '预授权已退回',
      detail: billing.note || '任务未交付，没有产生实扣。',
    };
  }
  if (billing.state === 'missing') {
    return {
      color: 'error',
      label: '缺少权威结算凭证',
      detail: billing.note || '没有数据库权威正向结算记录，不能进入人工验收或导出。',
    };
  }
  if (billing.state === 'not_required' && billing.exempt && billing.authoritative) {
    return {
      color: 'default',
      label: '人工上传 · 无需AI计费',
      detail: billing.note || '权威来源字段已确认这是人工上传素材。',
    };
  }
  if (billing.state === 'settled') {
    return {
      color: 'success',
      label: `已实扣 ${charged} 分`,
      detail: billing.note || '媒体技术交付完成，账务已结算。',
    };
  }
  return {
    color: 'default',
    label: '业务暂不可采用（账务状态待确认）',
    detail: billing.note || '账务状态无法确认，请查看任务详情并完成对账。',
  };
}

export function MediaReviewTags({ job }: { job: MediaJobView }) {
  const technical = job.technicalStatus || job.status || '未知';
  const business =
    job.businessStatus || job.reviewStatus || (technical === '成功' ? '可验收（待管理层审阅）' : '尚未形成可验收产物');
  const billing = mediaBillingPresentation(job.billing);
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      <Tag color={technical === '成功' ? 'blue' : technical === '失败' ? 'error' : 'processing'} style={{ margin: 0 }}>
        技术：{technical}
      </Tag>
      <Tag
        color={job.businessUsable ? 'success' : job.reviewRequired || technical === '成功' ? 'gold' : 'default'}
        style={{ margin: 0 }}
      >
        业务：{business}
      </Tag>
      {job.mediaType && (
        <Tag color="purple" style={{ margin: 0 }}>
          {job.mediaType}
          {job.mimeType ? ` · ${job.mimeType}` : ''}
        </Tag>
      )}
      {billing && (
        <Tooltip title={billing.detail}>
          <Tag color={billing.color} style={{ margin: 0 }}>
            {billing.label}
          </Tag>
        </Tooltip>
      )}
    </div>
  );
}

export function MediaImportAction({
  job,
  loading = false,
  block = false,
  size = 'small',
  onImport,
}: {
  job: MediaJobView;
  loading?: boolean;
  block?: boolean;
  size?: 'small' | 'middle' | 'large';
  onImport: () => void;
}) {
  const technical = job.technicalStatus || job.status || '未知';
  const billingReady =
    job.billing?.state === 'settled' ||
    (job.billing?.state === 'not_required' && job.billing.exempt === true && job.billing.authoritative === true);
  const label = job.businessUsable
    ? '已人工验收（可用于业务）'
    : job.canImport
      ? job.isImported
        ? '补记人工验收'
        : '人工验收并入库'
      : technical === '成功' && !billingReady
        ? '业务暂不可采用（待账务对账）'
        : job.reviewRequired || technical === '成功'
          ? '可验收（待管理层审阅）'
          : technical === '失败'
            ? '失败需处理（生成异常）'
            : ['处理中', '生成中'].includes(technical)
              ? '生成中，完成后验收'
              : '尚无可验收产物';
  const reason = job.canImport
    ? '请管理角色预览媒体并确认事实、品牌、版权和外发风险；确认后才会成为可用素材。'
    : job.canImportReason || (job.businessUsable ? '该媒体已完成人工验收并入库' : '当前任务尚不满足人工验收条件');
  return (
    <Tooltip title={reason}>
      <span style={{ display: block ? 'block' : 'inline-block', width: block ? '100%' : undefined }}>
        <Button
          size={size}
          block={block}
          icon={<FolderOpenOutlined />}
          disabled={!job.canImport}
          loading={loading}
          onClick={onImport}
        >
          {label}
        </Button>
      </span>
    </Tooltip>
  );
}

export default function MediaJobCard({
  job,
  selected,
  importing,
  onToggle,
  onDelete,
  onImport,
}: {
  job: MediaJobView;
  selected: boolean;
  importing: boolean;
  onToggle: (checked: boolean) => void;
  onDelete: () => void;
  onImport: () => void;
}) {
  const previewUrl = safePreviewUrl(job);
  const exportUrl = safeExportUrl(job);
  const kind = job.kind;
  return (
    <div
      style={{
        border: selected ? '1px solid var(--ui-accent)' : '1px solid var(--ui-border)',
        borderRadius: 10,
        padding: 10,
        position: 'relative',
        background: selected ? 'var(--ui-surface-2)' : 'var(--ui-surface)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <Tooltip
          title={
            job.canDelete === false
              ? job.deleteBlockedReason || '该任务仍在运行或已进入受保护业务流程，当前不能批量选择删除'
              : ''
          }
        >
          <span>
            <Checkbox
              disabled={job.canDelete === false}
              checked={selected}
              onChange={event => onToggle(event.target.checked)}
            >
              选择
            </Checkbox>
          </span>
        </Tooltip>
        <Tooltip title={job.canDelete === false ? job.deleteBlockedReason || '该任务当前不能删除' : '删除这条历史记录'}>
          <Button
            size="small"
            danger
            type="text"
            icon={<DeleteOutlined />}
            disabled={job.canDelete === false}
            onClick={onDelete}
          />
        </Tooltip>
      </div>

      {kind === 'image' && previewUrl ? (
        <img
          src={previewUrl}
          alt={job.prompt || '生成图片预览'}
          style={{ width: '100%', height: 110, objectFit: 'cover', borderRadius: 6 }}
        />
      ) : kind === 'video' && previewUrl ? (
        // Generated provider videos do not include a verified captions asset; do not attach a fake track.
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={previewUrl}
          controls
          preload="metadata"
          style={{ width: '100%', height: 110, objectFit: 'cover', borderRadius: 6, background: '#000' }}
        />
      ) : (
        <div
          style={{
            height: 110,
            background: 'var(--ui-surface-2)',
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: 5,
            color: 'var(--ui-muted)',
            fontSize: 11,
          }}
        >
          <span style={{ fontSize: 24 }}>{kind === 'video' ? '🎬' : '🖼️'}</span>
          {job.urlAvailable
            ? job.billing?.state !== 'settled' && job.billing?.state !== 'not_required'
              ? '账务确认后开放审核预览'
              : '人工验收后开放业务使用'
            : '尚无可用媒体地址'}
        </div>
      )}

      <div
        style={{
          fontSize: 11.5,
          color: 'var(--ui-text-2)',
          marginTop: 7,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {job.prompt || '未填写提示词'}
      </div>
      <div style={{ marginTop: 6 }}>
        <MediaReviewTags job={job} />
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--ui-muted)', marginTop: 6, lineHeight: 1.6 }}>
        {job.model || '未记录模型'}
        {job.reviewedBy ? ` · ${job.reviewedBy} 验收于 ${formatReviewTime(job.reviewedAt)}` : ''}
      </div>
      {exportUrl && (
        <a
          href={exportUrl}
          target="_blank"
          rel="noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, marginTop: 5 }}
        >
          <LinkOutlined /> 打开源文件
        </a>
      )}
      <div style={{ marginTop: 8 }}>
        <MediaImportAction job={job} loading={importing} block onImport={onImport} />
      </div>
    </div>
  );
}

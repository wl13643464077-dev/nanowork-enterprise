import { Button, Checkbox, Tag, Tooltip } from 'antd';
import { DeleteOutlined, FolderOpenOutlined, LinkOutlined } from '@ant-design/icons';

export type MediaBilling = {
  state?: 'held' | 'settled' | 'released' | 'pending_reconciliation' | string;
  estimatedCredits?: number | null;
  heldCredits?: number | null;
  chargedCredits?: number | null;
  credits?: number | null;
  pendingReconciliation?: boolean;
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

function safePreviewUrl(job: MediaJobView) {
  const url = String(job.previewUrl || job.url || '').trim();
  return /^(https?:\/\/|\/(?!\/)|data:(image|video)\/)/i.test(url) ? url : '';
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
      label: `${estimated} 分待对账`,
      detail: billing.note || '媒体已交付，但尚未确认实扣。',
    };
  }
  if (billing.state === 'released') {
    return {
      color: 'default',
      label: '预授权已退回',
      detail: billing.note || '任务未交付，没有产生实扣。',
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
    label: '账务状态待确认',
    detail: billing.note || '未识别的账务状态，请查看任务详情。',
  };
}

export function MediaReviewTags({ job }: { job: MediaJobView }) {
  const technical = job.technicalStatus || job.status || '未知';
  const business = job.businessStatus || job.reviewStatus || (technical === '成功' ? '待人工验收' : '未进入人工验收');
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
  const label = job.businessUsable
    ? '已验收并入库'
    : job.canImport
      ? job.isImported
        ? '补记人工验收'
        : '人工验收并入库'
      : job.reviewRequired || (job.technicalStatus || job.status) === '成功'
        ? '等待管理层验收'
        : '暂不可验收';
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
  const url = safePreviewUrl(job);
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
        <Checkbox
          disabled={job.canDelete === false}
          checked={selected}
          onChange={event => onToggle(event.target.checked)}
        >
          选择
        </Checkbox>
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

      {kind === 'image' && url ? (
        <img
          src={url}
          alt={job.prompt || '生成图片预览'}
          style={{ width: '100%', height: 110, objectFit: 'cover', borderRadius: 6 }}
        />
      ) : kind === 'video' && url ? (
        // Generated provider videos do not include a verified captions asset; do not attach a fake track.
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={url}
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
          {job.urlAvailable ? '媒体地址不可安全预览' : '尚无可用媒体地址'}
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
      {url && (
        <a
          href={url}
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

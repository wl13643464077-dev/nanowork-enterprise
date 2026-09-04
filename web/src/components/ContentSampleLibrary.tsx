import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Drawer, Empty, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { PictureOutlined, PlayCircleOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { api, safeUrl } from '../api/client';
import './ContentSampleLibrary.css';

export type ContentSample = {
  id: number;
  name: string;
  type: 'video' | 'image';
  url: string;
  mimeType: string;
  tags: string[];
  note: string;
  scope: 'platform' | 'tenant';
  ownTenant: boolean;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  createdAt: string | null;
};

type SampleListResponse = {
  items: ContentSample[];
  tags: { tag: string; count: number }[];
  canImport?: boolean;
  canImportPlatform?: boolean;
};

type ContentSampleLibraryProps = {
  open: boolean;
  onClose: () => void;
  /** “照这个风格做一条”：把样片的标签与讲解词交给带货视频表单预填 */
  onUseSample?: (sample: ContentSample) => void;
};

export const SAMPLE_EMPTY_TEXT = '还没有样片，平台上线后会陆续添加';

export function sampleBriefFromSample(sample: ContentSample): string {
  const tags = sample.tags.length ? `业态/场景：${sample.tags.join('、')}。` : '';
  const note = sample.note ? `参考讲解：${sample.note}` : '';
  return [`照样片「${sample.name}」的风格做一条30秒带货视频。`, tags, note].filter(Boolean).join('\n');
}

function formatDuration(seconds: number | null) {
  if (!seconds || !Number.isFinite(seconds)) return '';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes ? `${minutes}分${String(rest).padStart(2, '0')}秒` : `${rest}秒`;
}

/**
 * 样片库抽屉：销售在宣讲会现场可直接点开播放的视频/图片样板。
 * 平台级样片全租户共享；租户自有样片只对本企业可见——过滤由服务端完成，这里只负责展示。
 */
export default function ContentSampleLibrary({ open, onClose, onUseSample }: ContentSampleLibraryProps) {
  const [type, setType] = useState<'video' | 'image'>('video');
  const [tag, setTag] = useState<string>('');
  const [data, setData] = useState<SampleListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeId, setActiveId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ type });
      const response = (await api.get(`/content/samples?${query.toString()}`, { silent: true })) as SampleListResponse;
      setData({
        items: Array.isArray(response?.items) ? response.items : [],
        tags: Array.isArray(response?.tags) ? response.tags : [],
        canImport: Boolean(response?.canImport),
        canImportPlatform: Boolean(response?.canImportPlatform),
      });
    } catch (e: any) {
      setError(e?.message || '样片库加载失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, [type]);

  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [open, load]);

  const items = useMemo(() => {
    const list = data?.items || [];
    return tag ? list.filter(item => item.tags.includes(tag)) : list;
  }, [data, tag]);

  const tags = data?.tags || [];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={880}
      title={
        <span className="content-sample-library__title">
          <PlayCircleOutlined /> 样片库
          <small>宣讲会现场可直接点开的视频 / 图片样板</small>
        </span>
      }
      extra={
        <Space>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        </Space>
      }
      className="content-sample-library"
    >
      <div className="content-sample-library__toolbar">
        <Segmented
          value={type}
          onChange={value => {
            setType(value as 'video' | 'image');
            setTag('');
            setActiveId(null);
          }}
          options={[
            { value: 'video', label: '视频样片', icon: <PlayCircleOutlined /> },
            { value: 'image', label: '图片样片', icon: <PictureOutlined /> },
          ]}
        />
        {tags.length > 0 && (
          <div className="content-sample-library__tags" aria-label="按业态/场景筛选">
            <Tag.CheckableTag checked={!tag} onChange={() => setTag('')}>
              全部
            </Tag.CheckableTag>
            {tags.map(item => (
              <Tag.CheckableTag
                key={item.tag}
                checked={tag === item.tag}
                onChange={() => setTag(tag === item.tag ? '' : item.tag)}
              >
                {item.tag} · {item.count}
              </Tag.CheckableTag>
            ))}
          </div>
        )}
      </div>

      {error && <Alert type="error" showIcon message={error} className="content-sample-library__alert" />}

      {loading && !data ? (
        <div className="content-sample-library__loading">
          <Spin />
        </div>
      ) : items.length === 0 ? (
        <Empty
          className="content-sample-library__empty"
          description={
            <span>
              {SAMPLE_EMPTY_TEXT}
              {data?.canImport ? (
                <>
                  <br />
                  <small>
                    {data.canImportPlatform
                      ? '平台超管可用 scripts/import-video-samples.mjs 批量导入，或调用 POST /api/content/samples/import。'
                      : '老板可把已验收的成片通过 POST /api/content/samples/import 标记为本企业样片。'}
                  </small>
                </>
              ) : null}
            </span>
          }
        />
      ) : (
        <div className="content-sample-library__grid">
          {items.map(sample => {
            const src = safeUrl(sample.url);
            const active = activeId === sample.id;
            return (
              <article key={sample.id} className={`content-sample-card${active ? ' is-active' : ''}`}>
                <div className="content-sample-card__media">
                  {sample.type === 'video' ? (
                    <video
                      controls
                      preload="metadata"
                      playsInline
                      src={src}
                      onPlay={() => setActiveId(sample.id)}
                      aria-label={`播放样片 ${sample.name}`}
                    >
                      <track kind="captions" srcLang="zh" label="字幕" />
                    </video>
                  ) : (
                    <img src={src} alt={sample.name} loading="lazy" />
                  )}
                  <span className={`content-sample-card__scope is-${sample.scope}`}>
                    {sample.scope === 'platform' ? '平台样片' : '本企业样片'}
                  </span>
                </div>
                <header className="content-sample-card__head">
                  <Typography.Text strong ellipsis={{ tooltip: sample.name }}>
                    {sample.name}
                  </Typography.Text>
                  {sample.durationSeconds ? <small>{formatDuration(sample.durationSeconds)}</small> : null}
                </header>
                {sample.tags.length > 0 && (
                  <div className="content-sample-card__tags">
                    {sample.tags.map(item => (
                      <Tag key={item} bordered={false}>
                        {item}
                      </Tag>
                    ))}
                  </div>
                )}
                {sample.note ? (
                  <Typography.Paragraph
                    className="content-sample-card__note"
                    ellipsis={{ rows: active ? 12 : 3, expandable: true, symbol: '展开讲解词' }}
                  >
                    {sample.note}
                  </Typography.Paragraph>
                ) : (
                  <p className="content-sample-card__note is-muted">暂无讲解词</p>
                )}
                {onUseSample && sample.type === 'video' && (
                  <Button
                    type="primary"
                    ghost
                    block
                    icon={<ThunderboltOutlined />}
                    onClick={() => onUseSample(sample)}
                    className="content-sample-card__use"
                  >
                    照这个风格做一条
                  </Button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </Drawer>
  );
}

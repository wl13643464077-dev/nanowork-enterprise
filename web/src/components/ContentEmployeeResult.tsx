import { Button, message, Space, Tag } from 'antd';
import { CopyOutlined, LinkOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';
import { safeUrl } from '../api/client';
import { ArtifactActions } from './ArtifactActions';
import { Markdown } from './Markdown';
import './ContentEmployeeResult.css';

type StructuredResult = Record<string, unknown>;

const FIELD_LABELS: Record<string, string> = {
  briefing: '核心结论',
  summary: '执行摘要',
  body: '完整正文',
  report: '复盘报告',
  publish_plan: '发布计划',
  consistency_note: '风格一致性说明',
  channel_scan: '渠道扫描',
  source_coverage: '来源覆盖',
  facts: '关键事实',
  data_points: '数据要点',
  viewpoints: '观点与判断',
  takeaways: '可执行启示',
  comment_insights: '评论洞察',
  user_language: '用户原话',
  title_candidates: '标题备选',
  next_topics: '下一轮选题',
  profile_updates: '人设与策略更新',
  topics: '选题机会',
  benchmarks: '竞品样本',
  sources: '核验来源',
  versions: '平台发布版本',
  images: '图片产物',
  covers: '封面产物',
};

const PRIMARY_TEXT_FIELDS = ['briefing', 'summary', 'body', 'report', 'publish_plan', 'consistency_note'];
const LIST_FIELDS = [
  'facts',
  'data_points',
  'viewpoints',
  'takeaways',
  'comment_insights',
  'user_language',
  'title_candidates',
  'next_topics',
  'profile_updates',
];
const HANDLED_FIELDS = new Set([
  ...PRIMARY_TEXT_FIELDS,
  ...LIST_FIELDS,
  'channel_scan',
  'source_coverage',
  'topics',
  'benchmarks',
  'sources',
  'versions',
  'images',
  'covers',
]);

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function restoreReadableMarkdown(value: unknown) {
  const source = text(value);
  if (!source) return '';
  if (source.includes('\n')) return source;
  return source
    .replace(/\s*——\s*/gu, '\n\n')
    .replace(/\s+(#{1,6}\s+)/gu, '\n\n$1')
    .replace(/\s+(\*\*[^*\n]{1,48}\*\*)\s*/gu, '\n\n$1 ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function stripJsonFence(raw: string) {
  const value = raw.trim();
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return match ? match[1].trim() : value;
}

export function parseContentEmployeeResult(raw: string): StructuredResult | null {
  const candidate = stripJsonFence(raw);
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join('、');
  if (value && typeof value === 'object') {
    return Object.entries(value as StructuredResult)
      .map(([key, item]) => `${FIELD_LABELS[key] || key}：${displayValue(item)}`)
      .filter(item => !item.endsWith('：'))
      .join('；');
  }
  return '';
}

export function contentEmployeeResultDocument(raw: string) {
  const structured = parseContentEmployeeResult(raw);
  if (!structured) return raw;
  const lines: string[] = [];
  for (const [key, value] of Object.entries(structured)) {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue;
    lines.push(`## ${FIELD_LABELS[key] || key}`);
    if (typeof value === 'string') {
      lines.push(restoreReadableMarkdown(value) || value);
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const object = item as StructuredResult;
          const heading = text(object.title) || text(object.topic) || text(object.name) || `${index + 1}`;
          lines.push(`### ${heading}`);
          Object.entries(object).forEach(([field, fieldValue]) => {
            if (!['title', 'topic', 'name'].includes(field) && displayValue(fieldValue)) {
              lines.push(`- ${FIELD_LABELS[field] || field}：${displayValue(fieldValue)}`);
            }
          });
        } else if (displayValue(item)) {
          lines.push(`- ${displayValue(item)}`);
        }
      });
      continue;
    }
    if (typeof value === 'object') {
      Object.entries(value as StructuredResult).forEach(([field, fieldValue]) => {
        if (!displayValue(fieldValue)) return;
        if (fieldValue && typeof fieldValue === 'object' && !Array.isArray(fieldValue)) {
          lines.push(`### ${field}`);
          Object.entries(fieldValue as StructuredResult).forEach(([nestedKey, nestedValue]) => {
            if (displayValue(nestedValue))
              lines.push(`- ${FIELD_LABELS[nestedKey] || nestedKey}：${displayValue(nestedValue)}`);
          });
        } else {
          lines.push(`- ${FIELD_LABELS[field] || field}：${displayValue(fieldValue)}`);
        }
      });
    }
  }
  return lines.join('\n\n');
}

function stringItems(value: unknown) {
  return Array.isArray(value) ? value.map(displayValue).filter(Boolean) : [];
}

function objectItems(value: unknown) {
  return Array.isArray(value)
    ? (value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as StructuredResult[])
    : [];
}

function ResultSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="content-result-section">
      <h5>{title}</h5>
      {children}
    </section>
  );
}

function ResultFold({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <details className="content-result-fold">
      <summary>
        <strong>{title}</strong>
        {count != null ? <small>{count} 项 · 默认收起</small> : <small>默认收起</small>}
      </summary>
      {children}
    </details>
  );
}

const DEAD_SLOT = /无可验证事实|检索快照未覆盖|无明显信号/;

function partitionLiveText(value: unknown) {
  const items = stringItems(value);
  return {
    live: items.filter(item => !DEAD_SLOT.test(item)),
    dead: items.filter(item => DEAD_SLOT.test(item)),
  };
}

function ObjectTiles({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return (
    <dl className="content-result-tiles">
      {Object.entries(value as StructuredResult).map(([key, item]) => (
        <div key={key}>
          <dt>{FIELD_LABELS[key] || key}</dt>
          <dd>{displayValue(item) || '未记录'}</dd>
        </div>
      ))}
    </dl>
  );
}

function ResultCards({ title, value }: { title: string; value: unknown }) {
  const items = objectItems(value);
  if (!items.length) return null;
  return (
    <ResultSection title={title}>
      <div className="content-result-cards">
        {items.map((item, index) => {
          const cardTitle =
            text(item.title) ||
            text(item.topic) ||
            text(item.name) ||
            text(item.channel) ||
            text(item.account) ||
            `${title} ${index + 1}`;
          return (
            <article key={`${cardTitle}-${index}`}>
              <strong>{cardTitle}</strong>
              <dl>
                {Object.entries(item)
                  .filter(([key, field]) => key !== 'title' && key !== 'topic' && key !== 'name' && displayValue(field))
                  .map(([key, field]) => (
                    <div key={key}>
                      <dt>{FIELD_LABELS[key] || key.replace(/_/g, ' ')}</dt>
                      <dd>{displayValue(field)}</dd>
                    </div>
                  ))}
              </dl>
            </article>
          );
        })}
      </div>
    </ResultSection>
  );
}

function SourceList({ value }: { value: unknown }) {
  if (!Array.isArray(value) || !value.length) return null;
  return (
    <ResultSection title={FIELD_LABELS.sources}>
      <p className="content-result-capture">联网核验已回传 {value.length} 条来源</p>
      <ol className="content-result-sources">
        {value.map((source, index) => {
          const sourceObject = source && typeof source === 'object' ? (source as StructuredResult) : null;
          const raw = text(sourceObject?.url) || text(sourceObject?.source_url) || text(sourceObject?.sourceUrl);
          const label =
            text(sourceObject?.title) ||
            text(sourceObject?.name) ||
            (typeof source === 'string' ? source : `来源 ${index + 1}`);
          const href = raw ? safeUrl(raw) : '#';
          return (
            <li key={`${label}-${index}`}>
              {href !== '#' ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  <LinkOutlined /> {label}
                </a>
              ) : (
                <span>{label}</span>
              )}
              {sourceObject?.note ? <small>{displayValue(sourceObject.note)}</small> : null}
            </li>
          );
        })}
      </ol>
    </ResultSection>
  );
}

function PlatformVersions({ value }: { value: unknown }) {
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index + 1), item] as const)
    : value && typeof value === 'object'
      ? Object.entries(value as StructuredResult)
      : [];
  if (!entries.length) return null;
  return (
    <ResultSection title={FIELD_LABELS.versions}>
      <div className="content-result-versions">
        {entries.map(([key, raw]) => {
          const version: StructuredResult = raw && typeof raw === 'object' ? (raw as StructuredResult) : { body: raw };
          const platform = text(version.platform) || key;
          const body = text(version.body) || text(version.content) || text(version.copy);
          const tags = stringItems(version.tags);
          const checklist = stringItems(version.checklist);
          return (
            <article key={key}>
              <header>
                <Tag color="blue">{platform}</Tag>
                <strong>{text(version.title) || text(version.headline) || `${platform}发布版`}</strong>
                {text(version.best_time) && <small>建议时间：{String(version.best_time)}</small>}
              </header>
              {body && <Markdown content={restoreReadableMarkdown(body)} />}
              {!!tags.length && (
                <p className="content-result-tags">
                  {tags.map(tag => (
                    <Tag key={tag}>#{tag}</Tag>
                  ))}
                </p>
              )}
              {!!checklist.length && (
                <ul>
                  {checklist.map(item => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
              {text(version.note) && <p className="content-result-note">{String(version.note)}</p>}
              {body && (
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() =>
                    void navigator.clipboard.writeText(body).then(() => message.success(`${platform}文案已复制`))
                  }
                >
                  复制这一版
                </Button>
              )}
            </article>
          );
        })}
      </div>
    </ResultSection>
  );
}

function MediaArtifacts({ title, value }: { title: string; value: unknown }) {
  if (!Array.isArray(value) || !value.length) return null;
  return (
    <ResultSection title={title}>
      <div className="content-result-media">
        {value.map((raw, index) => {
          const item: StructuredResult = raw && typeof raw === 'object' ? (raw as StructuredResult) : { url: raw };
          const url = safeUrl(text(item.url) || text(item.fileUrl) || text(item.downloadUrl));
          const label = text(item.title) || text(item.filename) || text(item.platform) || `${title} ${index + 1}`;
          return (
            <article key={`${label}-${index}`}>
              <strong>{label}</strong>
              {text(item.desc) && <p>{String(item.desc)}</p>}
              {url !== '#' && (
                <Button size="small" href={url} target="_blank">
                  打开产物
                </Button>
              )}
            </article>
          );
        })}
      </div>
    </ResultSection>
  );
}

export default function ContentEmployeeResult({
  raw,
  title,
  runId,
  sourceType = 'content_employee_run',
  kicker = '内容数字员工岗位报告',
}: {
  raw: string;
  title: string;
  runId?: number | null;
  sourceType?: string;
  kicker?: string;
}) {
  const structured = parseContentEmployeeResult(raw);
  const documentContent = contentEmployeeResultDocument(raw);
  const copyAll = () =>
    void navigator.clipboard.writeText(documentContent).then(() => message.success('完整结果已复制'));

  return (
    <div className="content-result">
      <header className="content-result-head">
        <div>
          <span>{kicker}</span>
          <strong>{title}</strong>
        </div>
        <Space size={4} wrap>
          <Button size="small" type="text" icon={<CopyOutlined />} onClick={copyAll}>
            复制全文
          </Button>
          <ArtifactActions title={title} content={documentContent} sourceType={sourceType} sourceId={runId} />
        </Space>
      </header>

      {!structured ? (
        <div className="content-result-markdown">
          <Markdown content={restoreReadableMarkdown(raw) || raw} />
        </div>
      ) : (
        <div className="content-result-body">
          {PRIMARY_TEXT_FIELDS.map(
            key =>
              text(structured[key]) && (
                <ResultSection key={key} title={FIELD_LABELS[key]}>
                  <Markdown content={restoreReadableMarkdown(structured[key])} />
                </ResultSection>
              ),
          )}
          {structured.channel_scan &&
            (Array.isArray(structured.channel_scan) ? (
              <ResultFold title={FIELD_LABELS.channel_scan} count={structured.channel_scan.length}>
                <ResultCards title={FIELD_LABELS.channel_scan} value={structured.channel_scan} />
              </ResultFold>
            ) : (
              <ResultFold title={FIELD_LABELS.channel_scan}>
                <ResultSection title={FIELD_LABELS.channel_scan}>
                  <ObjectTiles value={structured.channel_scan} />
                </ResultSection>
              </ResultFold>
            ))}
          {structured.source_coverage && (
            <ResultFold
              title={FIELD_LABELS.source_coverage}
              count={Array.isArray(structured.source_coverage) ? structured.source_coverage.length : undefined}
            >
              <ResultSection title={FIELD_LABELS.source_coverage}>
                <ObjectTiles value={structured.source_coverage} />
              </ResultSection>
            </ResultFold>
          )}
          {LIST_FIELDS.map(key => {
            const { live, dead } = partitionLiveText(structured[key]);
            const objectList = objectItems(structured[key]);
            if (objectList.length) {
              return <ResultCards key={key} title={FIELD_LABELS[key]} value={structured[key]} />;
            }
            if (!live.length && !dead.length) return null;
            return (
              <div key={key}>
                {live.length ? (
                  <ResultSection title={FIELD_LABELS[key]}>
                    <ul className="content-result-list">
                      {live.map(item => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </ResultSection>
                ) : null}
                {dead.length ? (
                  <ResultFold title={`${FIELD_LABELS[key]}里未覆盖的项`} count={dead.length}>
                    <ul className="content-result-list">
                      {dead.map(item => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </ResultFold>
                ) : null}
              </div>
            );
          })}
          {(() => {
            const topics = objectItems(structured.topics);
            if (!topics.length) return null;
            const [first, ...rest] = topics;
            return (
              <div key="topics">
                <ResultCards title={FIELD_LABELS.topics} value={[first]} />
                {rest.length ? (
                  <ResultFold title="其余选题机会" count={rest.length}>
                    <ResultCards title={FIELD_LABELS.topics} value={rest} />
                  </ResultFold>
                ) : null}
              </div>
            );
          })()}
          <ResultCards title={FIELD_LABELS.benchmarks} value={structured.benchmarks} />
          <SourceList value={structured.sources} />
          <PlatformVersions value={structured.versions} />
          <MediaArtifacts title={FIELD_LABELS.images} value={structured.images} />
          <MediaArtifacts title={FIELD_LABELS.covers} value={structured.covers} />
          {Object.entries(structured).some(([key, value]) => !HANDLED_FIELDS.has(key) && displayValue(value)) && (
            <details className="content-result-more">
              <summary>其他结构化交付字段</summary>
              <dl>
                {Object.entries(structured)
                  .filter(([key, value]) => !HANDLED_FIELDS.has(key) && displayValue(value))
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt>{FIELD_LABELS[key] || key}</dt>
                      <dd>{displayValue(value)}</dd>
                    </div>
                  ))}
              </dl>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

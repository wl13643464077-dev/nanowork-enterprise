import { useState } from 'react';
import {
  CheckCircleFilled,
  ExclamationCircleFilled,
  CloseCircleFilled,
  HeartOutlined,
  StarOutlined,
  MessageOutlined,
} from '@ant-design/icons';
import { xhsFoldedBody, xhsPublishChecklist } from './xhsPublishChecklist.js';
import './XhsPhonePreview.css';

type PreviewDraft = {
  title: string;
  body: string;
  tags: string[];
  firstComment: string;
  compliance?: { blocked?: boolean; hits?: Array<{ severity: string }> };
};

/**
 * 小红书真机预览 + 发布前自查。只展示当前编辑稿，不发布、不改写。
 */
export default function XhsPhonePreview({
  draft,
  brandName,
  images,
  aiImageCount = 0,
}: {
  draft: PreviewDraft;
  brandName?: string;
  images: string[];
  aiImageCount?: number;
}) {
  const [index, setIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const check = xhsPublishChecklist(draft, { imageCount: images.length, aiImageCount });
  const folded = xhsFoldedBody(draft.body);
  const current = images[Math.min(index, Math.max(images.length - 1, 0))];
  const author = (brandName || '门店官方号').slice(0, 16);

  return (
    <section className="xhs-preview" aria-label="小红书真机预览与发布自查">
      <div className="xhs-preview-phone" aria-label="手机预览">
        <div className="xhs-preview-notch" />
        <header className="xhs-preview-author">
          <span className="xhs-preview-avatar">{author.slice(0, 1)}</span>
          <strong>{author}</strong>
          <span className="xhs-preview-follow">关注</span>
        </header>
        <div className="xhs-preview-cover">
          {current ? (
            <img src={current} alt={`第 ${index + 1} 张配图`} />
          ) : (
            <div className="xhs-preview-empty">配图生成后显示在这里</div>
          )}
          {images.length > 1 && (
            <div className="xhs-preview-dots" role="tablist" aria-label="切换配图">
              {images.map((url, i) => (
                <button
                  key={url}
                  type="button"
                  role="tab"
                  aria-selected={i === index}
                  aria-label={`第 ${i + 1} 张`}
                  className={i === index ? 'is-active' : ''}
                  onClick={() => setIndex(i)}
                />
              ))}
            </div>
          )}
        </div>
        <div className="xhs-preview-content">
          <h4>{draft.title || '（标题）'}</h4>
          <p className="xhs-preview-body">
            {expanded || !folded.folded ? draft.body : `${folded.text}…`}
            {folded.folded && (
              <button type="button" className="xhs-preview-more" onClick={() => setExpanded(value => !value)}>
                {expanded ? '收起' : '展开'}
              </button>
            )}
          </p>
          <p className="xhs-preview-tags">
            {draft.tags.map(tag => (
              <span key={tag}>#{String(tag).replace(/^#+/, '')}</span>
            ))}
          </p>
          {draft.firstComment && (
            <div className="xhs-preview-comment">
              <span className="xhs-preview-avatar is-small">{author.slice(0, 1)}</span>
              <div>
                <em>作者 · 置顶</em>
                <p>{draft.firstComment}</p>
              </div>
            </div>
          )}
        </div>
        <footer className="xhs-preview-bar" aria-hidden="true">
          <span className="xhs-preview-input">说点什么…</span>
          <HeartOutlined />
          <StarOutlined />
          <MessageOutlined />
        </footer>
      </div>

      <div className="xhs-preview-check" aria-label="发布前自查">
        <header>
          <strong>发布前自查</strong>
          <span className={check.ready ? 'is-ready' : 'is-blocked'}>
            {check.passed}/{check.total} 项达标{check.ready ? '' : ' · 有必改项'}
          </span>
        </header>
        <ul>
          {check.items.map(entry => (
            <li key={entry.key} className={`is-${entry.level}`}>
              {entry.level === 'pass' ? (
                <CheckCircleFilled />
              ) : entry.level === 'block' ? (
                <CloseCircleFilled />
              ) : (
                <ExclamationCircleFilled />
              )}
              <span>{entry.label}</span>
              <em>{entry.detail}</em>
            </li>
          ))}
        </ul>
        <p className="xhs-preview-note">
          预览按小红书信息流样式排版，修改左侧文案会实时刷新。系统不会代你发布，复制或下载后由你在小红书 App 里发出。
        </p>
      </div>
    </section>
  );
}

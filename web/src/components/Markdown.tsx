import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { safeUrl } from '../api/client';

// AI 输出统一 Markdown 渲染（##/**/表格/列表/代码块），安全策略三层：
// 1. 不挂 rehype-raw —— 原文中的 HTML 一律按纯文本展示，不进 DOM；
// 2. rehype-sanitize（GitHub schema）兜底过滤所有生成节点的标签/属性；
// 3. 链接经 safeUrl 协议白名单（仅 http/https/站内路径），新窗口 + noopener。
const schema = {
  ...defaultSchema,
  // 收紧：AI 文本不需要内嵌图片/脚本类标签，避免外链图钓鱼与追踪
  tagNames: (defaultSchema.tagNames || []).filter(t => t !== 'img'),
};

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  if (!content) return null;
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, schema]]}
        components={{
          a: ({ href, children }) => (
            <a href={safeUrl(href)} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

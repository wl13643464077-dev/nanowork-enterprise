import { Alert, Badge, Tag } from 'antd';
import { BulbOutlined, RightOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Panel } from './Kit';
import { DOT_COLORS, REFERENCE_SUGGESTIONS } from '../data/contentFactoryConstants';
import './ContentFactoryCards.css';

type ContentReferenceSuggestion = (typeof REFERENCE_SUGGESTIONS)[number];

type ContentReferencePanelProps = {
  briefingTheme?: string | null;
  onSelectSuggestion: (suggestion: ContentReferenceSuggestion) => void;
  onUseBriefingTheme: (theme: string) => void;
};

export default function ContentReferencePanel({
  briefingTheme,
  onSelectSuggestion,
  onUseBriefingTheme,
}: ContentReferencePanelProps) {
  return (
    <Panel
      title={
        <>
          <BulbOutlined className="content-reference-title-icon" /> 创作参考模板
        </>
      }
      extra={
        briefingTheme && (
          <Tag color="blue" className="content-reference-theme-tag">
            已记录主题：{briefingTheme}
          </Tag>
        )
      }
    >
      <div className="content-reference-list">
        <Alert
          type="info"
          showIcon
          message="以下是固定示例，不是实时 AI 判断"
          description="系统没有为这些模板读取实时热点、经营表现或活动排期；使用前必须核对门店真实信息。"
        />
        {REFERENCE_SUGGESTIONS.map((suggestion, index) => (
          <button
            type="button"
            key={index}
            onClick={() => onSelectSuggestion(suggestion)}
            className="content-reference-suggestion"
          >
            <Badge color={DOT_COLORS[index % DOT_COLORS.length]} />
            <span className="content-reference-suggestion-copy">
              <b>{suggestion.title}</b>
              <br />
              {suggestion.summary}
            </span>
            <RightOutlined className="content-reference-arrow" />
          </button>
        ))}
        {briefingTheme ? (
          <button
            type="button"
            onClick={() => onUseBriefingTheme(briefingTheme)}
            className="content-reference-use-theme"
          >
            <ThunderboltOutlined /> 使用已记录主题 <RightOutlined />
          </button>
        ) : (
          <div className="content-reference-empty">暂无带业务记录的今日主题，请先在创作表单中填写真实主题。</div>
        )}
      </div>
    </Panel>
  );
}

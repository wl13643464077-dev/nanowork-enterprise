import { Tooltip } from 'antd';

export default function AutomationFailureReason({ reason, prefix = false }: { reason?: string; prefix?: boolean }) {
  if (!reason) return null;
  return (
    <Tooltip title={reason}>
      <div
        aria-label="自动化失败原因"
        style={{
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 2,
          overflow: 'hidden',
          marginTop: prefix ? 8 : 5,
          color: 'var(--danger)',
          fontSize: prefix ? 12 : 11.5,
          lineHeight: prefix ? 1.55 : 1.45,
          overflowWrap: 'anywhere',
        }}
      >
        {prefix ? '失败原因：' : ''}
        {reason}
      </div>
    </Tooltip>
  );
}

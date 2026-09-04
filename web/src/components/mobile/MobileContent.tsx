import { Button, Empty, List, Tag, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { useQuery, QueryStatus } from '../../hooks/useQuery';
import type { ContentItem } from '../../api/types';
import './mobile.css';

// 内容（首页二级页）：只列已人工采纳、可直接使用的素材，一键复制去微信发布。
export default function MobileContent() {
  const contentQ = useQuery<{ rows: ContentItem[] }>(
    '/content/list?status=' + encodeURIComponent('可使用') + '&size=30',
  );
  if (contentQ.loading || contentQ.error) return <QueryStatus q={contentQ} height={200} />;
  const usableRows = (contentQ.data?.rows || []).filter(item => item.delivery?.canUse === true);
  return (
    <List
      dataSource={usableRows}
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无已人工采纳内容，请先到内容生产仓生成并完成审阅"
          />
        ),
      }}
      renderItem={(r: ContentItem) => (
        <article className="m-card m-lead-card">
          <div className="m-lead-head m-block-gap-b">
            <Tag color="blue">{r.type}</Tag>
            <Button
              size="small"
              icon={<CopyOutlined />}
              disabled={r.delivery?.canUse !== true}
              onClick={() => {
                navigator.clipboard?.writeText(r.body || '');
                message.success('已复制，去微信粘贴发布');
              }}
            >
              复制发圈
            </Button>
          </div>
          <div className="m-content-body">{r.body}</div>
        </article>
      )}
    />
  );
}

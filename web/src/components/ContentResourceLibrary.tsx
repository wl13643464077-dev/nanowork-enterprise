import { useEffect, useState } from 'react';
import { Alert, Button, Card, Drawer, Empty, Input, Segmented, Space, Spin, message } from 'antd';
import { api } from '../api/client';
import { Markdown } from './Markdown';
import { templatesFor } from '../data/mediaTemplates';

export default function ContentResourceLibrary({
  initialTab,
  onClose,
}: {
  initialTab: '素材库' | '模板库';
  onClose: () => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState('');
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setLoading(true);
        setError('');
      }
    });
    api
      .get(tab === '素材库' ? '/content/materials' : '/content/templates', { silent: true })
      .then(data => {
        if (!cancelled) setRows(Array.isArray(data) ? data : []);
      })
      .catch(error => {
        if (!cancelled) setError(error.message || '资料加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, retry]);
  const displayed = (
    tab === '模板库' ? [...rows, ...['AI图片', 'AI视频', 'AIPPT'].flatMap(templatesFor)] : rows
  ).filter(item => `${item.name} ${item.type || ''} ${item.tags || ''}`.includes(search));
  return (
    <Drawer title="素材与模板" open onClose={onClose} width="min(780px, 100vw)">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Segmented options={['素材库', '模板库']} value={tab} onChange={value => setTab(value as typeof tab)} />
        <Input.Search
          placeholder="搜索名称、类型或标签"
          allowClear
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        <p>这里保留已有资料。复制需要的内容后，交给对应数字员工；派活和结果统一通过员工工作台与任务中心处理。</p>
        {error ? (
          <Alert
            type="error"
            showIcon
            message={error}
            action={<Button onClick={() => setRetry(value => value + 1)}>重新加载</Button>}
          />
        ) : loading ? (
          <Spin />
        ) : !displayed.length ? (
          <Empty description="暂无匹配资料" />
        ) : (
          displayed.map((item, index) => {
            const text = item.promptSkeleton || item.prompt || item.body || item.note || item.description || '';
            return (
              <Card key={`${item.id || item.name}-${index}`} title={item.name} size="small">
                <p>
                  {item.type || item.tab} {Array.isArray(item.tags) ? item.tags.join(' · ') : item.tags}
                </p>
                {text && (
                  <details>
                    <summary>查看完整内容</summary>
                    <Markdown content={text} />
                  </details>
                )}
                <Space wrap style={{ marginTop: 12 }}>
                  {text && (
                    <Button
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(text);
                          message.success('内容已复制');
                        } catch {
                          message.error('复制失败，请展开内容后手动复制');
                        }
                      }}
                    >
                      复制内容
                    </Button>
                  )}
                  {item.url && /^(https?:\/\/|\/uploads\/)/i.test(item.url) && (
                    <Button href={item.url} target="_blank" rel="noreferrer">
                      打开原始素材
                    </Button>
                  )}
                </Space>
              </Card>
            );
          })
        )}
      </Space>
    </Drawer>
  );
}

import { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { api, safeUrl } from '../api/client';

type BenchmarkCard = {
  id: number;
  employeeRunId: number | null;
  verified: number;
  secondhand: boolean;
  sourceUrl: string | null;
  sourceType: string;
  platform: string;
  card: {
    hook_type: string;
    opening_3s: string;
    structure: string[];
    reusable_pattern: string;
    risk_flags: string[];
  } | null;
};

export default function ContentBenchmarkLibrary({ canManage, runId }: { canManage: boolean; runId?: number }) {
  const [cards, setCards] = useState<BenchmarkCard[]>([]);
  const [platform, setPlatform] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const endpoint = '/employee-workbench/content/benchmark-cards';
  const reload = () => {
    setLoading(true);
    setError('');
    setRefreshKey(value => value + 1);
  };
  useEffect(() => {
    let active = true;
    api
      .get(`${endpoint}?${new URLSearchParams({ platform })}`, { silent: true })
      .then(result => {
        if (active) setCards((result as { cards: BenchmarkCard[] }).cards);
      })
      .catch(cause => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : '结构卡读取失败，请重试');
        setCards([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [platform, refreshKey]);
  const mutate = async (path: string, action: 'post' | 'del', success: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (action === 'post') await api.post(path, {});
      else await api.del(path);
      reload();
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ewb-benchmark-library" aria-label="爆款结构学习库">
      <Typography.Title level={5}>爆款结构学习库</Typography.Title>
      <Typography.Paragraph type="secondary">
        给拆解师派“爆款学习”，提供链接、截图或原文；采纳产出后沉淀结构卡。老板确认后，撰稿人和带货员才会在下一稿借鉴结构，不沿用样本的门店事实。
      </Typography.Paragraph>
      <Space wrap>
        <Select
          aria-label="结构卡平台"
          value={platform}
          onChange={value => {
            setPlatform(value);
            reload();
          }}
          options={[
            { value: '', label: '全部平台' },
            { value: '小红书', label: '小红书' },
            { value: '抖音', label: '抖音' },
            { value: '视频号', label: '视频号' },
          ]}
        />
        <Button loading={loading} disabled={busy} onClick={reload}>
          刷新结构卡
        </Button>
        {canManage && runId && (
          <Button
            loading={busy}
            onClick={() =>
              void mutate(
                `/employee-workbench/content/2/runs/${runId}/benchmark-cards`,
                'post',
                '已沉淀待确认结构卡；确认后才会用于下一稿。',
              )
            }
          >
            将本次拆解沉淀为结构卡
          </Button>
        )}
      </Space>
      {error && <Alert type="error" showIcon message={error} />}
      {notice && <Alert type="success" showIcon message={notice} />}
      {!loading && !error && !cards.length && <Empty description="还没有可用结构卡，请先派拆解师学习并确认产出" />}
      {cards.map(item => (
        <Card key={item.id} size="small" title={`${item.platform} · ${item.card?.hook_type || '结构卡'} #${item.id}`}>
          <Space wrap>
            <Tag color={item.verified === 1 ? 'green' : 'gold'}>
              {item.verified === 1 ? '已确认可借鉴' : '待人工确认'}
            </Tag>
            <Tag>{item.secondhand ? '二手/手工来源' : '平台原站链接'}</Tag>
            <Typography.Text type="secondary">平台热度未核验 · 拆解任务 #{item.employeeRunId}</Typography.Text>
          </Space>
          <Typography.Paragraph>{item.card?.opening_3s}</Typography.Paragraph>
          <Typography.Paragraph>{item.card?.structure.join(' → ')}</Typography.Paragraph>
          <Typography.Paragraph>{item.card?.reusable_pattern}</Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            风险：{item.card?.risk_flags.join('；') || '需人工核验适用范围'}
          </Typography.Paragraph>
          {item.sourceUrl && safeUrl(item.sourceUrl) && (
            <Typography.Link href={safeUrl(item.sourceUrl)} target="_blank" rel="noopener noreferrer">
              查看样本来源
            </Typography.Link>
          )}
          {canManage && (
            <Space wrap>
              {item.verified !== 1 && (
                <Button
                  disabled={busy}
                  onClick={() => void mutate(`${endpoint}/${item.id}/verify`, 'post', '结构卡已确认，后续写作可借鉴。')}
                >
                  确认可借鉴
                </Button>
              )}
              <Popconfirm
                title="停用这张结构卡？"
                description="同时停止知识库召回，历史记录保留。"
                okText="确认停用"
                cancelText="取消"
                onConfirm={() => mutate(`${endpoint}/${item.id}`, 'del', '已停用结构卡及其知识引用。')}
              >
                <Button danger disabled={busy}>
                  停用
                </Button>
              </Popconfirm>
            </Space>
          )}
        </Card>
      ))}
    </section>
  );
}

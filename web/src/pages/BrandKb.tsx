import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tag,
  message,
} from 'antd';
import {
  BookOutlined,
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { api } from '../api/client';
import { Panel } from '../components/Kit';
import './BrandKb.css';

type Dimension = {
  id: number;
  key: string;
  title: string;
  body: string;
  status: string;
  included: boolean;
  sources: { title?: string; url?: string }[];
  sortOrder: number;
};

type Pack = {
  id: number;
  brandName: string;
  status: string;
  version: number;
  windowDays: number;
  summary: string;
  lastError?: string;
  filledCount: number;
  selectedCount?: number;
  dimensionCount: number;
  published?: boolean;
  collectedAt?: string;
  dimensions: Dimension[];
};

type Overview = {
  windowDays: number;
  windowLabel: string;
  uploaded: { count: number };
  pack: Pack | null;
  dimensionCatalog: { key: string; title: string }[];
};

const STATUS: Record<string, { color: string; label: string }> = {
  ready: { color: 'success', label: '已确认入库' },
  review: { color: 'warning', label: '待确认，数字员工还不会用' },
  collecting: { color: 'processing', label: '采集中' },
  failed: { color: 'error', label: '采集失败' },
};

function imageUrlsFrom(item: Dimension) {
  const blob = `${item.body || ''}\n${(item.sources || []).map(source => source.url || '').join('\n')}`;
  return [...new Set([...blob.matchAll(/https?:\/\/[^\s)）"'<>]+?\.(?:png|jpe?g|gif|svg|webp)/giu)].map(match => match[0]))].slice(0, 3);
}

export default function BrandKb() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [brandName, setBrandName] = useState('');
  const [feedback, setFeedback] = useState('');
  const [wrongKeys, setWrongKeys] = useState<string[]>([]);
  const [editing, setEditing] = useState<Dimension | null>(null);
  const [draft, setDraft] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    return api
      .get('/brand-kb')
      .then((data: Overview) => {
        setOverview(data);
        setBrandName(current => current || data.pack?.brandName || '');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const applyPack = (pack: Pack) => {
    setOverview(current => (current ? { ...current, pack } : current));
    setWrongKeys([]);
  };

  const collect = (upgrade: boolean) => {
    const name = brandName.trim() || overview?.pack?.brandName || '';
    if (name.length < 2) {
      message.warning('请先输入至少 2 个字的品牌名');
      return;
    }
    setSaving(true);
    api
      .post(upgrade ? '/brand-kb/upgrade' : '/brand-kb/collect', { brandName: name })
      .then((pack: Pack) => {
        applyPack(pack);
        if (pack.status === 'failed' || Number(pack.filledCount || 0) === 0) {
          message.error(pack.lastError || '这次没有抓到可核对的品牌资料，请核对品牌名后重试，不要把空卡片当成已采集');
        } else if (pack.lastError) {
          message.warning(`公开网页已检索。模型没写全正文：${pack.lastError}。可在本页改、挑或重抓后再确认入库。`);
        } else {
          message.success('已抓回公开资料，先在本页核对，确认后才进入知识库');
        }
      })
      .finally(() => setSaving(false));
  };

  const saveDimension = () => {
    if (!editing) return;
    const body = draft.trim();
    if (!body) {
      message.warning('维度内容不能为空');
      return;
    }
    setSaving(true);
    api
      .put(`/brand-kb/dimensions/${editing.id}`, { body, title: editing.title })
      .then((pack: Pack) => {
        applyPack(pack);
        setEditing(null);
        message.success('已改好，还要点「确认入库」数字员工才会用这版');
      })
      .finally(() => setSaving(false));
  };

  const toggleIncluded = (item: Dimension, included: boolean) => {
    api.put(`/brand-kb/dimensions/${item.id}/include`, { included }).then((pack: Pack) => applyPack(pack));
  };

  const recollect = () => {
    if (!wrongKeys.length && !feedback.trim()) {
      message.warning('先勾选错的维度，或写下哪里不对');
      return;
    }
    setSaving(true);
    api
      .post('/brand-kb/recollect', { keys: wrongKeys, feedback: feedback.trim() })
      .then((pack: Pack) => {
        applyPack(pack);
        setFeedback('');
        message.success('已按你的纠正重新抓取，请再核对后确认入库');
      })
      .finally(() => setSaving(false));
  };

  const confirm = () => {
    setSaving(true);
    api
      .post('/brand-kb/confirm')
      .then((pack: Pack) => {
        applyPack(pack);
        message.success('这版已放进知识库，之后数字员工会先按产品匹配它');
      })
      .finally(() => setSaving(false));
  };

  const pack = overview?.pack || null;
  const uploadedCount = overview?.uploaded?.count || 0;
  const selectedCount = pack?.selectedCount ?? pack?.dimensions?.filter(item => item.included !== false).length ?? 0;
  const awaitingConfirm = pack && pack.status === 'review';
  const wrongSet = useMemo(() => new Set(wrongKeys), [wrongKeys]);

  return (
    <div className="brand-kb-page">
      <div className="brand-kb-hero">
        <p className="brand-kb-kicker">就在这一页看、改、确认</p>
        <h1>品牌知识包</h1>
        <p>
          抓回来的资料不会立刻给数字员工用。你在本页看完全部分量，改错的、去掉不要的，或告诉系统哪里不对让它重抓，最后点「确认入库」。确认前，系统管理 → 知识库里也看不到这版。
        </p>
      </div>

      {uploadedCount > 0 && (
        <Alert
          type="success"
          showIcon
          message={`本企业已有 ${uploadedCount} 条上传知识，数字员工会继续调用。`}
          description="品牌知识包是另外一份公开画像。确认入库后才会和上传资料一起被数字员工使用，不会覆盖你上传的原文。"
        />
      )}

      <Panel
        title={
          <>
            <SearchOutlined /> {pack ? '重新采集公开资料' : '输入品牌，抓近三个月公开资料'}
          </>
        }
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      >
        <div className="brand-kb-collect">
          <Input
            size="large"
            maxLength={40}
            placeholder="例如：北京大鸭梨烤鸭"
            value={brandName}
            onChange={event => setBrandName(event.target.value)}
            disabled={saving}
          />
          <Space wrap>
            <Button type="primary" size="large" loading={saving} onClick={() => collect(false)}>
              {pack ? '按这个品牌名重新抓' : '开始抓取'}
            </Button>
            {pack && (
              <Button size="large" loading={saving} onClick={() => collect(true)}>
                升级近三个月资料
              </Button>
            )}
            {pack && (
              <Popconfirm
                title="删除后数字员工不再调用这份品牌知识包，已上传的其他知识库仍保留。"
                okText="确认删除"
                cancelText="取消"
                onConfirm={() => {
                  setSaving(true);
                  api
                    .del('/brand-kb')
                    .then(() => {
                      message.success('品牌知识包已删除');
                      setBrandName('');
                      void load();
                    })
                    .finally(() => setSaving(false));
                }}
              >
                <Button danger size="large" icon={<DeleteOutlined />}>
                  删除知识包
                </Button>
              </Popconfirm>
            )}
          </Space>
          <div className="brand-kb-hint">
            采集窗口：{overview?.windowLabel || '近 90 天'}。抓回来先审阅，确认入库后才进知识库。
          </div>
        </div>
      </Panel>

      {loading && !pack ? (
        <div className="brand-kb-loading">
          <Spin /> 正在读取品牌知识包
        </div>
      ) : pack ? (
        <Panel
          title={
            <>
              <BookOutlined /> {pack.brandName} · 审阅区
            </>
          }
          extra={
            <Space>
              <Tag color={STATUS[pack.status]?.color || 'default'}>{STATUS[pack.status]?.label || pack.status}</Tag>
              <Tag>
                采用 {selectedCount}/{pack.dimensionCount || 24}
              </Tag>
            </Space>
          }
        >
          {pack.status === 'failed' && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message="这次没有抓到可核验资料，不能把空卡片交给数字员工"
              description={pack.lastError || '请核对品牌名、换官网常用称呼后再采集。'}
            />
          )}
          {pack.status === 'failed' ? (
            <Empty description="没有可核验的公开资料。核对品牌名后再抓，不要把空卡片当成已采集。" />
          ) : (
            <>
          {awaitingConfirm && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="这是待确认稿，还没进知识库"
              description="勾选要留下的维度，点「修改」改正文，或勾选错的维度写下哪里不对后点「按纠正重抓」。核对完再点确认入库。"
            />
          )}
          {pack.status === 'ready' && (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 12 }}
              message="当前这版已在知识库里，数字员工会先调用它"
              description="再改或重抓会回到待确认。确认前，员工仍使用上一版已入库内容。"
            />
          )}
          {pack.summary && <p className="brand-kb-summary">{pack.summary}</p>}

          <div className="brand-kb-review-actions">
            <Input.TextArea
              rows={3}
              maxLength={800}
              placeholder="哪些是错的？直接说，例如：价格不是这个、没有加盟、Logo 不是这个链接、招牌菜漏了果木烤鸭。"
              value={feedback}
              onChange={event => setFeedback(event.target.value)}
              disabled={saving}
            />
            <Space wrap>
              <Button loading={saving} onClick={recollect}>
                按纠正重抓勾选的维度
              </Button>
              <Button type="primary" size="large" icon={<CheckOutlined />} loading={saving} onClick={confirm}>
                确认这版入库
              </Button>
            </Space>
          </div>

          <div className="brand-kb-grid">
            {(pack.dimensions || []).map(item => (
              <article
                key={item.id}
                className={`brand-kb-card is-${item.status} ${item.included === false ? 'is-dropped' : ''} ${wrongSet.has(item.key) ? 'is-wrong' : ''}`}
              >
                <header>
                  <Checkbox checked={item.included !== false} onChange={event => toggleIncluded(item, event.target.checked)}>
                    <b>
                      {item.sortOrder}. {item.title}
                    </b>
                  </Checkbox>
                  <Tag color={item.status === 'edited' ? 'gold' : item.status === 'filled' ? 'green' : 'default'}>
                    {item.included === false ? '不入库' : item.status === 'edited' ? '已改' : item.status === 'filled' ? '已采集' : '待核验'}
                  </Tag>
                </header>
                <p>{item.body}</p>
                {item.key === 'logo' && imageUrlsFrom(item).map(url => (
                  <img key={url} className="brand-kb-logo" src={url} alt="品牌Logo公开图" />
                ))}
                {!!item.sources?.length && (
                  <ul>
                    {item.sources.slice(0, 3).map(source => (
                      <li key={source.url}>
                        <a href={source.url} target="_blank" rel="noreferrer">
                          {source.title || source.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                <Space wrap>
                  <Checkbox
                    checked={wrongSet.has(item.key)}
                    onChange={event => {
                      setWrongKeys(current => (
                        event.target.checked ? [...new Set([...current, item.key])] : current.filter(key => key !== item.key)
                      ));
                    }}
                  >
                    这条有错，重抓
                  </Checkbox>
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => {
                      setEditing(item);
                      setDraft(item.body);
                    }}
                  >
                    修改
                  </Button>
                </Space>
              </article>
            ))}
          </div>
            </>
          )}
        </Panel>
      ) : (
        <Empty description={uploadedCount ? '上传知识库已可调用。若要自动补品牌画像，输入品牌名即可。' : '还没有品牌知识包。输入品牌名后开始采集。'} />
      )}

      <Modal
        title={editing ? `修改「${editing.title}」` : '修改维度'}
        open={Boolean(editing)}
        onOk={saveDimension}
        onCancel={() => setEditing(null)}
        okText="保存到审阅稿"
        confirmLoading={saving}
        destroyOnClose
      >
        <Input.TextArea rows={8} value={draft} onChange={event => setDraft(event.target.value)} maxLength={4000} />
      </Modal>
    </div>
  );
}

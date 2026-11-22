import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, Modal, Popconfirm, Segmented, Space, Spin, Tag, message } from 'antd';
import {
  AimOutlined,
  ArrowRightOutlined,
  BookOutlined,
  CheckCircleOutlined,
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  LoadingOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Panel } from '../components/Kit';
import { dispatchToEmployee } from '../utils/dispatchEmployee';
import './BrandKb.css';

type PackRole = 'own' | 'competitor';
type ViewMode = 'own' | 'competitors' | 'compare';

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
  packRole?: PackRole;
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
  competitors?: Pack[];
  competitorLimit?: number;
  dimensionCatalog: { key: string; title: string }[];
};

type ReviewFilter = 'all' | 'filled' | 'pending' | 'wrong';
type CollectMode = 'collect' | 'upgrade' | 'recollect' | null;

const STATUS: Record<string, { color: string; label: string }> = {
  ready: { color: 'success', label: '已确认入库' },
  review: { color: 'warning', label: '待确认，数字员工还不会用' },
  collecting: { color: 'processing', label: '采集中' },
  failed: { color: 'error', label: '采集失败' },
};

const COMPACT_STATUS: Record<string, { color: string; label: string }> = {
  ready: { color: 'success', label: '已入库' },
  review: { color: 'warning', label: '待确认' },
  collecting: { color: 'processing', label: '采集中' },
  failed: { color: 'error', label: '失败' },
};

const COLLECT_STAGES = [
  { title: '检索近 90 天公开信息', detail: '正在抓取官网、评价平台、媒体报道与公开门店信息' },
  { title: '提炼菜品 / 价格 / 口碑结构', detail: '正在交叉核验招牌菜品、人均客单、门店分布与口碑关键词' },
  { title: '填装 24 维档案', detail: '正在按 24 维标准结构落盘，并保留可追溯来源链接' },
];

const COMPARE_DIMENSIONS = [
  { key: 'price', title: '价格带', hint: '人均客单与定价区间' },
  { key: 'products', title: '招牌产品与SKU', hint: '核心爆品与菜品结构' },
  { key: 'audience', title: '目标客群', hint: '主力消费人群画像' },
  { key: 'channels', title: '门店与渠道布局', hint: '门店规模与选址分布' },
  { key: 'reviews', title: '用户口碑关键词', hint: '顾客高频好评与槽点' },
  { key: 'campaigns', title: '近三个月活动', hint: '近期促销与团购动作' },
] as const;

const DEFAULT_COMPETITOR_LIMIT = 3;

function imageUrlsFrom(item: Dimension) {
  const blob = `${item.body || ''}\n${(item.sources || []).map(source => source.url || '').join('\n')}`;
  return [
    ...new Set([...blob.matchAll(/https?:\/\/[^\s)）"'<>]+?\.(?:png|jpe?g|gif|svg|webp)/giu)].map(match => match[0])),
  ].slice(0, 3);
}

function findDimension(pack: Pack | null | undefined, key: string): Dimension | undefined {
  return pack?.dimensions?.find(item => item.key === key);
}

function isPendingDimension(dim?: Dimension): boolean {
  if (!dim) return true;
  const body = String(dim.body || '').trim();
  return !body || dim.status === 'pending' || /^待核验/u.test(body);
}

function briefExcerpt(dim?: Dimension, max = 90): string {
  if (!dim || isPendingDimension(dim)) return '待核验';
  const cleaned = String(dim.body || '')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function buildCompareDirective(target: 'qian' | 'wang', ownPack: Pack, competitors: Pack[]): string {
  const compNames = competitors.map(item => `「${item.brandName}」`).join('、');
  const focusKeys =
    target === 'qian'
      ? (['price', 'audience', 'channels', 'reviews', 'campaigns'] as const)
      : (['price', 'products', 'audience', 'reviews', 'campaigns'] as const);

  const summaryLines = focusKeys.map(key => {
    const meta = COMPARE_DIMENSIONS.find(item => item.key === key);
    const ownText = briefExcerpt(findDimension(ownPack, key), 72);
    const compTexts = competitors.map(comp => `${comp.brandName}：${briefExcerpt(findDimension(comp, key), 60)}`);
    return `- ${meta?.title || key}｜本品牌(${ownPack.brandName})：${ownText}；竞品对照：${compTexts.join(' ｜ ')}`;
  });

  if (target === 'qian') {
    return [
      `请结合知识库中的本品牌「${ownPack.brandName}」品牌知识包与竞品档案（${compNames}），做一份竞争突围分析报告。`,
      '重点拆解：1）价格带与客群错位机会；2）门店渠道与近期活动攻防；3）从双方口碑差距中提炼 3 条本周即可执行的差异化抢客打法。',
      '',
      '【对照核心维度摘要】',
      ...summaryLines,
    ].join('\n');
  }

  return [
    `请结合知识库中的本品牌「${ownPack.brandName}」品牌知识包与竞品档案（${compNames}），做一份菜单差异化定价与菜品结构优化方案。`,
    '重点输出：1）对比竞品价格带后的核心价格锚点与阶梯建议；2）招牌菜与引流/利润款组合差异化；3）基于顾客口碑关键词的新品或高毛利套餐提案。',
    '',
    '【对照核心维度摘要】',
    ...summaryLines,
  ].join('\n');
}

export default function BrandKb() {
  const nav = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [collectMode, setCollectMode] = useState<CollectMode>(null);
  const [progressStage, setProgressStage] = useState(0);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('own');
  const [brandName, setBrandName] = useState('');
  const [competitorName, setCompetitorName] = useState('');
  const [activeCompetitorId, setActiveCompetitorId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');
  const [wrongKeys, setWrongKeys] = useState<string[]>([]);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [editing, setEditing] = useState<Dimension | null>(null);
  const [draft, setDraft] = useState('');

  const load = useCallback(() => {
    return api
      .get('/brand-kb')
      .then((data: Overview) => {
        setOverview(data);
        setBrandName(current => current || data.pack?.brandName || '');
        const comps = data.competitors || [];
        setActiveCompetitorId(current => {
          if (current && comps.some(item => item.id === current)) return current;
          return comps[0]?.id ?? null;
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 采集/升级/重抓进行中时，按真实耗时节奏推进三阶段提示，消除黑盒等待焦虑
  useEffect(() => {
    if (!saving || !collectMode) return undefined;
    const t1 = window.setTimeout(() => setProgressStage(1), 5000);
    const t2 = window.setTimeout(() => setProgressStage(2), 14000);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [saving, collectMode]);

  const reload = () => {
    setLoading(true);
    void load();
  };

  const resetReviewState = () => {
    setWrongKeys([]);
    setFeedback('');
    setReviewFilter('all');
  };

  const applyPack = (updated: Pack) => {
    setOverview(current => {
      if (!current) return current;
      if (updated.packRole === 'competitor') {
        const list = current.competitors || [];
        const exists = list.some(item => item.id === updated.id);
        const nextList = exists ? list.map(item => (item.id === updated.id ? updated : item)) : [updated, ...list];
        return { ...current, competitors: nextList };
      }
      return { ...current, pack: updated };
    });
    if (updated.packRole === 'competitor') {
      setActiveCompetitorId(updated.id);
    }
    setWrongKeys([]);
  };

  const ownPack = overview?.pack || null;
  const competitors = useMemo(() => overview?.competitors || [], [overview?.competitors]);
  const competitorLimit = overview?.competitorLimit || DEFAULT_COMPETITOR_LIMIT;
  const canCompare = Boolean(ownPack && competitors.length > 0);

  const activeCompetitor = useMemo(
    () => competitors.find(item => item.id === activeCompetitorId) || competitors[0] || null,
    [competitors, activeCompetitorId],
  );

  // 如果当前在对照视图但条件不再满足（如删光了竞品），自动派生回退到可用视图
  const effectiveMode: ViewMode =
    viewMode === 'compare' && !canCompare ? (competitors.length > 0 ? 'competitors' : 'own') : viewMode;

  const activePack = effectiveMode === 'competitors' ? activeCompetitor : ownPack;

  const handleModeChange = (next: ViewMode) => {
    setViewMode(next);
    resetReviewState();
  };

  const collectOwn = (upgrade: boolean) => {
    const name = brandName.trim() || ownPack?.brandName || '';
    if (name.length < 2) {
      message.warning('请先输入至少 2 个字的品牌名');
      return;
    }
    setSaving(true);
    setProgressStage(0);
    setCollectMode(upgrade ? 'upgrade' : 'collect');
    api
      .post(upgrade ? '/brand-kb/upgrade' : '/brand-kb/collect', { brandName: name, packRole: 'own' })
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
      .catch((error: any) => {
        message.error(error?.message || '品牌公开资料采集失败，请稍后重试');
      })
      .finally(() => {
        setSaving(false);
        setCollectMode(null);
      });
  };

  const collectCompetitor = (options: { upgrade?: boolean; targetPack?: Pack } = {}) => {
    const { upgrade = false, targetPack } = options;
    const name = targetPack ? targetPack.brandName : competitorName.trim();
    if (name.length < 2) {
      message.warning('请先输入至少 2 个字的竞品品牌名');
      return;
    }
    if (!targetPack && competitors.length >= competitorLimit) {
      message.warning(`最多同时维护 ${competitorLimit} 个竞品品牌档案，请先删除旧竞品后再采集`);
      return;
    }
    setSaving(true);
    setProgressStage(0);
    setCollectMode(upgrade ? 'upgrade' : 'collect');
    api
      .post(upgrade ? '/brand-kb/upgrade' : '/brand-kb/collect', {
        brandName: name,
        packRole: 'competitor',
        packId: targetPack?.id,
      })
      .then((pack: Pack) => {
        applyPack(pack);
        if (!targetPack) setCompetitorName('');
        if (pack.status === 'failed' || Number(pack.filledCount || 0) === 0) {
          message.error(pack.lastError || '这次没有抓到可核对的竞品资料，请核对品牌名后重试，不要把空卡片当成已采集');
        } else if (pack.lastError) {
          message.warning(`竞品公开网页已检索。部分维度未写全：${pack.lastError}。核对后可确认入库。`);
        } else {
          message.success(`竞品「${pack.brandName}」24 维档案已抓回，审阅确认后即写入「竞品档案」`);
        }
      })
      .catch((error: any) => {
        message.error(error?.message || '竞品档案采集失败，请稍后重试');
      })
      .finally(() => {
        setSaving(false);
        setCollectMode(null);
      });
  };

  const deletePackById = (target: Pack) => {
    const isCompetitor = target.packRole === 'competitor';
    setSaving(true);
    api
      .del(isCompetitor ? `/brand-kb/${target.id}` : '/brand-kb')
      .then(() => {
        message.success(isCompetitor ? `竞品档案「${target.brandName}」已删除` : '品牌知识包已删除');
        if (!isCompetitor) setBrandName('');
        resetReviewState();
        reload();
      })
      .catch((error: any) => {
        message.error(error?.message || '删除知识包失败');
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
        message.success('已改好，还要点「确认这版入库」数字员工才会用这版');
      })
      .catch((error: any) => {
        message.error(error?.message || '保存维度修改失败');
      })
      .finally(() => setSaving(false));
  };

  const toggleIncluded = (item: Dimension, included: boolean) => {
    api
      .put(`/brand-kb/dimensions/${item.id}/include`, { included })
      .then((pack: Pack) => applyPack(pack))
      .catch((error: any) => {
        message.error(error?.message || '更新采用状态失败');
      });
  };

  const toggleWrongKey = (key: string) => {
    setWrongKeys(current => (current.includes(key) ? current.filter(item => item !== key) : [...current, key]));
  };

  const recollect = (targetPack: Pack) => {
    if (!wrongKeys.length && !feedback.trim()) {
      message.warning('先标记有偏差的维度，或写下哪里不对');
      return;
    }
    setSaving(true);
    setProgressStage(0);
    setCollectMode('recollect');
    api
      .post('/brand-kb/recollect', {
        packId: targetPack.packRole === 'competitor' ? targetPack.id : undefined,
        keys: wrongKeys,
        feedback: feedback.trim(),
      })
      .then((pack: Pack) => {
        applyPack(pack);
        setFeedback('');
        message.success('已按你的纠正重新抓取，请再核对后确认入库');
      })
      .catch((error: any) => {
        message.error(error?.message || '按纠正重抓失败，请稍后重试');
      })
      .finally(() => {
        setSaving(false);
        setCollectMode(null);
      });
  };

  const confirm = (targetPack: Pack) => {
    const isCompetitor = targetPack.packRole === 'competitor';
    setSaving(true);
    api
      .post('/brand-kb/confirm', isCompetitor ? { packId: targetPack.id } : undefined)
      .then((pack: Pack) => {
        applyPack(pack);
        message.success(
          isCompetitor
            ? `竞品「${pack.brandName}」已入库至「竞品档案」，钱商圈/王菜单/店小满将自动引用对照`
            : '这版已入库，73 位数字员工将自动优先引用你的品牌档案',
        );
      })
      .catch((error: any) => {
        message.error(error?.message || '确认入库失败，请稍后重试');
      })
      .finally(() => setSaving(false));
  };

  const uploadedCount = overview?.uploaded?.count || 0;
  const dimensions = useMemo(() => activePack?.dimensions || [], [activePack?.dimensions]);
  const selectedCount = activePack?.selectedCount ?? dimensions.filter(item => item.included !== false).length;
  const awaitingConfirm = Boolean(activePack && activePack.status === 'review');
  const wrongSet = useMemo(() => new Set(wrongKeys), [wrongKeys]);
  const dimensionCatalog = overview?.dimensionCatalog || [];

  const filterCounts = useMemo(() => {
    let filled = 0;
    let pending = 0;
    for (const item of dimensions) {
      if (item.status === 'filled' || item.status === 'edited') filled += 1;
      else pending += 1;
    }
    return { all: dimensions.length, filled, pending, wrong: wrongKeys.length };
  }, [dimensions, wrongKeys.length]);

  const visibleDimensions = useMemo(() => {
    if (reviewFilter === 'all') return dimensions;
    if (reviewFilter === 'filled')
      return dimensions.filter(item => item.status === 'filled' || item.status === 'edited');
    if (reviewFilter === 'pending')
      return dimensions.filter(item => item.status !== 'filled' && item.status !== 'edited');
    return dimensions.filter(item => wrongSet.has(item.key));
  }, [dimensions, reviewFilter, wrongSet]);

  const renderProgressCard = () => {
    if (!saving || !collectMode) return null;
    return (
      <div className="brand-kb-progress-card" role="status" aria-live="polite">
        <div className="brand-kb-progress-head">
          <LoadingOutlined spin aria-hidden="true" />
          <strong>
            {collectMode === 'recollect'
              ? '正在按你的纠正重新核验并更新对应维度…'
              : collectMode === 'upgrade'
                ? '正在抓取近 90 天最新动态并升级品牌档案…'
                : '正在为品牌构建 24 维公开档案（通常需 30–60 秒）…'}
          </strong>
        </div>
        <ol className="brand-kb-progress-stages">
          {COLLECT_STAGES.map((stage, index) => {
            const stateClass = index < progressStage ? 'is-done' : index === progressStage ? 'is-active' : 'is-wait';
            return (
              <li key={stage.title} className={stateClass}>
                <span className="brand-kb-progress-icon" aria-hidden="true">
                  {index < progressStage ? (
                    <CheckCircleOutlined />
                  ) : index === progressStage ? (
                    <LoadingOutlined spin />
                  ) : (
                    index + 1
                  )}
                </span>
                <div>
                  <strong>{stage.title}</strong>
                  <small>{stage.detail}</small>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    );
  };

  const renderReviewPanel = (targetPack: Pack) => {
    const isCompetitor = targetPack.packRole === 'competitor';
    return (
      <Panel
        title={
          <span className="brand-kb-panel-title">
            <BookOutlined /> {targetPack.brandName} · 24 维审阅区
            {isCompetitor && <Tag color="orange">竞品档案</Tag>}
          </span>
        }
        extra={
          <Space wrap>
            <Tag color={STATUS[targetPack.status]?.color || 'default'}>
              {STATUS[targetPack.status]?.label || targetPack.status}
            </Tag>
            <Tag>
              采用 {selectedCount}/{targetPack.dimensionCount || 24}
            </Tag>
            {targetPack.status === 'ready' && !isCompetitor && (
              <Button type="primary" size="small" icon={<ArrowRightOutlined />} onClick={() => nav('/employees')}>
                带着品牌知识包立刻去派活
              </Button>
            )}
            {isCompetitor && canCompare && (
              <Button type="primary" size="small" icon={<SwapOutlined />} onClick={() => handleModeChange('compare')}>
                去一键对照
              </Button>
            )}
          </Space>
        }
      >
        {targetPack.status === 'failed' && (
          <Alert
            type="error"
            showIcon
            className="brand-kb-alert"
            message="这次没有抓到可核验资料，不能把空卡片交给数字员工"
            description={targetPack.lastError || '请核对品牌名、换官网常用称呼后再采集。'}
          />
        )}
        {targetPack.status === 'failed' ? (
          <Empty description="没有可核验的公开资料。核对品牌名后再抓，不要把空卡片当成已采集。" />
        ) : (
          <>
            {awaitingConfirm && (
              <Alert
                type="warning"
                showIcon
                className="brand-kb-alert"
                message={isCompetitor ? '这是竞品待确认稿，还没进「竞品档案」知识库' : '这是待确认稿，还没进知识库'}
                description={
                  isCompetitor
                    ? '勾选要留下的维度，点「修改」改正文或标纠错重抓。确认入库后会以【竞品档案】标题存入知识库，不会覆盖本品牌画像。'
                    : '勾选要留下的维度，点「修改」改正文，或点「标记纠错」并写下哪里不对后按纠正重抓。核对完点确认入库。'
                }
              />
            )}
            {targetPack.status === 'ready' && (
              <Alert
                type="success"
                showIcon
                className="brand-kb-alert"
                message={
                  isCompetitor
                    ? `竞品「${targetPack.brandName}」已入库至「竞品档案」，钱商圈/王菜单/店小满将准确引用对照`
                    : '当前这版已在知识库里，73 位数字员工派活时将自动优先引用'
                }
                description="再改或重抓会回到待确认。确认前，员工仍使用上一版已入库内容。"
                action={
                  isCompetitor && canCompare ? (
                    <Button type="primary" size="small" onClick={() => handleModeChange('compare')}>
                      本品牌 vs 竞品一键对照 →
                    </Button>
                  ) : (
                    <Button type="primary" size="small" onClick={() => nav('/employees')}>
                      带着品牌知识包立刻去派活 →
                    </Button>
                  )
                }
              />
            )}
            {targetPack.summary && <p className="brand-kb-summary">{targetPack.summary}</p>}

            <div className="brand-kb-review-actions">
              <Input.TextArea
                rows={2}
                maxLength={800}
                placeholder="哪些维度有偏差？直接写明，例如：人均客单价有变动、目前未开放加盟、招牌菜需补充当季主推菜等。"
                value={feedback}
                onChange={event => setFeedback(event.target.value)}
                disabled={saving}
              />
              <div className="brand-kb-filter-bar" role="tablist" aria-label="按审阅状态筛选维度">
                {(
                  [
                    { key: 'all', label: '全部', count: filterCounts.all },
                    { key: 'filled', label: '已采集', count: filterCounts.filled },
                    { key: 'pending', label: '待核验', count: filterCounts.pending },
                    { key: 'wrong', label: '已标纠错', count: filterCounts.wrong },
                  ] as const
                ).map(tab => (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={reviewFilter === tab.key}
                    className={`brand-kb-filter-pill${reviewFilter === tab.key ? ' is-active' : ''}`}
                    onClick={() => setReviewFilter(tab.key)}
                  >
                    {tab.label} <span>{tab.count}</span>
                  </button>
                ))}
              </div>
            </div>

            {visibleDimensions.length ? (
              <div className="brand-kb-grid">
                {visibleDimensions.map(item => {
                  const markedWrong = wrongSet.has(item.key);
                  return (
                    <article
                      key={item.id}
                      className={`brand-kb-card is-${item.status} ${item.included === false ? 'is-dropped' : ''} ${markedWrong ? 'is-wrong' : ''}`}
                    >
                      <header>
                        <Checkbox
                          checked={item.included !== false}
                          onChange={event => toggleIncluded(item, event.target.checked)}
                        >
                          <b>
                            {item.sortOrder}. {item.title}
                          </b>
                        </Checkbox>
                        <Tag color={item.status === 'edited' ? 'gold' : item.status === 'filled' ? 'green' : 'default'}>
                          {item.included === false
                            ? '不入库'
                            : item.status === 'edited'
                              ? '已改'
                              : item.status === 'filled'
                                ? '已采集'
                                : '待核验'}
                        </Tag>
                      </header>
                      <p>{item.body}</p>
                      {item.key === 'logo' &&
                        imageUrlsFrom(item).map(url => (
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
                      <div className="brand-kb-card-actions">
                        <Button
                          size="small"
                          type={markedWrong ? 'primary' : 'default'}
                          danger={markedWrong}
                          icon={<ExclamationCircleOutlined />}
                          disabled={saving}
                          onClick={() => toggleWrongKey(item.key)}
                        >
                          {markedWrong ? '已标纠错（点此取消）' : '标记纠错'}
                        </Button>
                        <Button
                          size="small"
                          icon={<EditOutlined />}
                          disabled={saving}
                          onClick={() => {
                            setEditing(item);
                            setDraft(item.body);
                          }}
                        >
                          修改
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <Empty description="当前筛选条件下暂无维度，点击「全部」查看完整 24 维档案" />
            )}

            <div className="brand-kb-sticky-bar" aria-label="确认入库操作栏">
              <div className="brand-kb-sticky-summary">
                <strong>
                  已采用 {selectedCount}/{targetPack.dimensionCount || 24} · 已标纠错 {wrongKeys.length} 项
                </strong>
                <span>
                  {targetPack.status === 'ready'
                    ? isCompetitor
                      ? '当前竞品档案已入库生效，可用于一键对照与专家派活'
                      : '当前版本已生效，可直接去数字员工派活'
                    : isCompetitor
                      ? '核对无误后点击右侧确认入库，归档至「竞品档案」知识库'
                      : '核对无误后点击右侧确认入库，73 位数字员工即刻生效'}
                </span>
              </div>
              <Space wrap>
                <Button
                  loading={saving && collectMode === 'recollect'}
                  disabled={saving || (!wrongKeys.length && !feedback.trim())}
                  onClick={() => recollect(targetPack)}
                >
                  按纠正重抓{wrongKeys.length ? `（${wrongKeys.length} 项）` : ''}
                </Button>
                <Button
                  type="primary"
                  size="large"
                  icon={<CheckOutlined />}
                  loading={saving && !collectMode}
                  disabled={saving}
                  onClick={() => confirm(targetPack)}
                >
                  确认这版入库
                </Button>
              </Space>
            </div>
          </>
        )}
      </Panel>
    );
  };

  return (
    <div className="brand-kb-page">
      <header className="brand-kb-hero">
        <p className="brand-kb-kicker">24 维品牌微型知识库 · 竞品对照与全员自动引用</p>
        <h1>品牌知识包</h1>
        <p>
          只需输入一次品牌名，系统自动采集近 90 天公开情报并构建 24 维结构化品牌档案，同时支持建立最多 {competitorLimit}{' '}
          个竞品品牌档案并一键对照，派活给数字员工直接做竞争突围与差异化定价。
        </p>
        <ol className="brand-kb-steps" aria-label="三步完成品牌建档">
          <li>
            <span>1</span>
            <div>
              <strong>输入品牌名一键采集</strong>
              <small>自动检索近 90 天 24 维公开情报</small>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>审阅勾选 + 竞品对照</strong>
              <small>逐维核验并建档最多 {competitorLimit} 个竞品</small>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>确认入库全员派活</strong>
              <small>本品牌与竞品档案分库沉淀、专家直调</small>
            </div>
          </li>
        </ol>
      </header>

      <div className="brand-kb-mode-bar" role="region" aria-label="品牌知识包模式切换">
        <Segmented
          size="large"
          value={effectiveMode}
          onChange={value => handleModeChange(value as ViewMode)}
          options={[
            {
              value: 'own',
              label: ownPack ? `本品牌知识包 · ${ownPack.brandName}` : '本品牌知识包',
              icon: <BookOutlined />,
            },
            {
              value: 'competitors',
              label: `竞品档案（${competitors.length}/${competitorLimit}）`,
              icon: <AimOutlined />,
            },
            {
              value: 'compare',
              label: '本品牌 vs 竞品一键对照',
              icon: <SwapOutlined />,
              disabled: !canCompare,
            },
          ]}
        />
        <span className="brand-kb-mode-note">
          {canCompare
            ? `已就绪：${ownPack?.brandName} vs ${competitors.map(item => item.brandName).join(' / ')}`
            : ownPack
              ? '再添加至少 1 个竞品档案即可开启「本品牌 vs 竞品一键对照」'
              : '先建好本品牌知识包并添加至少 1 个竞品，即可开启一键对照'}
        </span>
      </div>

      {uploadedCount > 0 && effectiveMode === 'own' && (
        <Alert
          type="success"
          showIcon
          message={`本企业已有 ${uploadedCount} 条上传知识，数字员工会继续调用。`}
          description="品牌知识包是另外一份公开画像。确认入库后才会和上传资料一起被数字员工使用，不会覆盖你上传的原文。"
        />
      )}

      {effectiveMode === 'own' && (
        <>
          <Panel
            title={
              <>
                <SearchOutlined /> {ownPack ? '重新采集或升级本品牌公开资料' : '输入品牌名，一键采集 24 维公开情报'}
              </>
            }
            extra={
              <Button size="small" icon={<ReloadOutlined />} onClick={reload} loading={loading}>
                刷新
              </Button>
            }
          >
            <div className="brand-kb-collect">
              <Input
                size="large"
                maxLength={40}
                placeholder="例如：输入您的餐饮品牌全称或点评常用名"
                value={brandName}
                onChange={event => setBrandName(event.target.value)}
                onPressEnter={() => collectOwn(false)}
                disabled={saving}
              />
              <Space wrap>
                <Button
                  type="primary"
                  size="large"
                  loading={saving && collectMode === 'collect'}
                  disabled={saving}
                  onClick={() => collectOwn(false)}
                >
                  {ownPack ? '按这个品牌名重新抓' : '一键采集 24 维档案'}
                </Button>
                {ownPack && (
                  <Button
                    size="large"
                    loading={saving && collectMode === 'upgrade'}
                    disabled={saving}
                    onClick={() => collectOwn(true)}
                  >
                    升级近三个月资料
                  </Button>
                )}
                {ownPack && (
                  <Popconfirm
                    title="删除后数字员工不再调用这份品牌知识包，竞品档案和已上传的其他知识库仍保留。"
                    okText="确认删除"
                    cancelText="取消"
                    onConfirm={() => deletePackById(ownPack)}
                  >
                    <Button danger size="large" disabled={saving} icon={<DeleteOutlined />}>
                      删除知识包
                    </Button>
                  </Popconfirm>
                )}
              </Space>
              <div className="brand-kb-hint">
                采集窗口：{overview?.windowLabel || '近 90 天'}
                。抓回来先在本页审阅核验，确认入库前不会对数字员工生效。
              </div>
              {renderProgressCard()}
            </div>
          </Panel>

          {loading && !ownPack ? (
            <div className="brand-kb-loading">
              <Spin /> 正在读取品牌知识包
            </div>
          ) : ownPack ? (
            renderReviewPanel(ownPack)
          ) : dimensionCatalog.length > 0 ? (
            <Panel
              title={
                <>
                  <BookOutlined /> 24 维品牌微型知识库全景预览
                </>
              }
              extra={<Tag color="blue">共 {dimensionCatalog.length} 个核心商业维度</Tag>}
            >
              <p className="brand-kb-catalog-lead">
                在上方输入你的餐饮品牌名并点击「一键采集 24 维档案」，系统将自动填装以下 {dimensionCatalog.length}{' '}
                维公开画像，经你审阅入库后供全部数字员工随时调用：
              </p>
              <div className="brand-kb-catalog-grid">
                {dimensionCatalog.map((dim, index) => (
                  <div key={dim.key} className="brand-kb-catalog-item">
                    <span className="brand-kb-catalog-num">{String(index + 1).padStart(2, '0')}</span>
                    <strong>{dim.title}</strong>
                  </div>
                ))}
              </div>
            </Panel>
          ) : (
            <Empty
              description={
                uploadedCount
                  ? '上传知识库已可调用。若要自动补品牌画像，输入品牌名即可。'
                  : '还没有品牌知识包。输入品牌名后开始采集。'
              }
            />
          )}
        </>
      )}

      {effectiveMode === 'competitors' && (
        <>
          <Panel
            title={
              <>
                <AimOutlined /> 竞品档案库（已建 {competitors.length}/{competitorLimit}）
              </>
            }
            extra={
              <Space wrap>
                {canCompare && (
                  <Button
                    type="primary"
                    size="small"
                    icon={<SwapOutlined />}
                    onClick={() => handleModeChange('compare')}
                  >
                    本品牌 vs 竞品一键对照
                  </Button>
                )}
                <Button size="small" icon={<ReloadOutlined />} onClick={reload} loading={loading}>
                  刷新
                </Button>
              </Space>
            }
          >
            <div className="brand-kb-collect">
              <div className="brand-kb-comp-input-row">
                <Input
                  size="large"
                  maxLength={40}
                  placeholder="输入同商圈或同品类竞品品牌名，例如：海底捞、费大厨、太二酸菜鱼"
                  value={competitorName}
                  onChange={event => setCompetitorName(event.target.value)}
                  onPressEnter={() => collectCompetitor()}
                  disabled={saving || competitors.length >= competitorLimit}
                />
                <Button
                  type="primary"
                  size="large"
                  icon={<PlusOutlined />}
                  loading={saving && collectMode === 'collect'}
                  disabled={saving || competitors.length >= competitorLimit}
                  onClick={() => collectCompetitor()}
                >
                  采集竞品 24 维档案
                </Button>
              </div>
              {competitors.length >= competitorLimit ? (
                <Alert
                  type="info"
                  showIcon
                  message={`已达 ${competitorLimit} 个竞品档案上限`}
                  description="如需替换为新的竞品，请先在下方竞品卡片中删除不再关注的旧竞品，再重新采集。"
                />
              ) : (
                <div className="brand-kb-hint">
                  竞品档案独立存储，绝不覆盖本品牌知识包；确认入库后归入「竞品档案」分类，便于钱商圈、王菜单、店小满做竞争分析与差异化定价。
                </div>
              )}

              {renderProgressCard()}

              <div className="brand-kb-comp-slots" aria-label="竞品品牌档案列表">
                {competitors.map((comp, index) => {
                  const selected = activeCompetitor?.id === comp.id;
                  const priceDim = findDimension(comp, 'price');
                  return (
                    <article key={comp.id} className={`brand-kb-comp-card${selected ? ' is-selected' : ''}`}>
                      <header className="brand-kb-comp-card-head">
                        <button
                          type="button"
                          className="brand-kb-comp-card-title"
                          onClick={() => {
                            setActiveCompetitorId(comp.id);
                            resetReviewState();
                          }}
                        >
                          <span className="brand-kb-comp-index">竞品 {index + 1}</span>
                          <strong>{comp.brandName}</strong>
                        </button>
                        <Tag color={COMPACT_STATUS[comp.status]?.color || 'default'}>
                          {COMPACT_STATUS[comp.status]?.label || comp.status}
                        </Tag>
                      </header>
                      <p className="brand-kb-comp-card-snippet">
                        {isPendingDimension(priceDim)
                          ? comp.summary || '点击审阅 24 维档案并确认入库'
                          : `价格带：${briefExcerpt(priceDim, 68)}`}
                      </p>
                      <div className="brand-kb-comp-card-meta">
                        <span>
                          已采集 {comp.filledCount}/{comp.dimensionCount || 24} 维
                        </span>
                        <span>v{comp.version || 1}</span>
                      </div>
                      <div className="brand-kb-comp-card-actions">
                        <Button
                          size="small"
                          type={selected ? 'primary' : 'default'}
                          onClick={() => {
                            setActiveCompetitorId(comp.id);
                            resetReviewState();
                          }}
                        >
                          {selected ? '正在审阅' : '审阅 24 维'}
                        </Button>
                        <Button
                          size="small"
                          disabled={saving}
                          loading={saving && collectMode === 'upgrade' && activeCompetitor?.id === comp.id}
                          onClick={() => collectCompetitor({ upgrade: true, targetPack: comp })}
                        >
                          升级近 90 天
                        </Button>
                        <Popconfirm
                          title={`确认删除竞品「${comp.brandName}」档案？本品牌知识包不受影响。`}
                          okText="确认删除"
                          cancelText="取消"
                          onConfirm={() => deletePackById(comp)}
                        >
                          <Button size="small" danger disabled={saving} icon={<DeleteOutlined />}>
                            删除
                          </Button>
                        </Popconfirm>
                      </div>
                    </article>
                  );
                })}
                {Array.from({ length: Math.max(0, competitorLimit - competitors.length) }).map((_, idx) => (
                  <div key={`slot-empty-${idx}`} className="brand-kb-comp-slot-empty">
                    <span>竞品位 {competitors.length + idx + 1} · 空闲</span>
                    <small>在上方输入竞品品牌名即可一键抓取 24 维公开档案</small>
                  </div>
                ))}
              </div>
            </div>
          </Panel>

          {activeCompetitor ? (
            renderReviewPanel(activeCompetitor)
          ) : (
            <Empty description="还没有竞品档案。在上方输入 1–3 个对标竞品名称即可开始建档并开启一键对照。" />
          )}
        </>
      )}

      {effectiveMode === 'compare' && ownPack && competitors.length > 0 && (
        <Panel
          title={
            <span className="brand-kb-panel-title">
              <SwapOutlined /> 本品牌 vs 竞品一键对照（6 大核心决策维度）
            </span>
          }
          extra={
            <Space wrap>
              <Tag color="blue">本品牌：{ownPack.brandName}</Tag>
              <Tag color="orange">对标竞品：{competitors.length} 个</Tag>
              <Button size="small" icon={<ReloadOutlined />} onClick={reload} loading={loading}>
                刷新
              </Button>
            </Space>
          }
        >
          {(ownPack.status !== 'ready' || competitors.some(item => item.status !== 'ready')) && (
            <Alert
              type="warning"
              showIcon
              className="brand-kb-alert"
              message="部分档案尚在待确认状态"
              description="当前对照表格已展示全部已抓回维度。建议在对应页签点击「确认这版入库」，这样派活给钱商圈或王菜单时，数字员工还能在知识库中检索其余 18 维完整细节。"
            />
          )}

          <div className="brand-kb-compare-wrap">
            <table className="brand-kb-compare-table">
              <thead>
                <tr>
                  <th className="is-dim-col">核心决策维度</th>
                  <th className="is-own-col" aria-label={`本品牌 ${ownPack.brandName}`}>
                    <div className="brand-kb-compare-th">
                      <Tag color="blue">本品牌</Tag>
                      <strong>{ownPack.brandName}</strong>
                      <small>
                        已采 {ownPack.filledCount}/{ownPack.dimensionCount || 24} 维 ·{' '}
                        {COMPACT_STATUS[ownPack.status]?.label || ownPack.status}
                      </small>
                    </div>
                  </th>
                  {competitors.map((comp, index) => (
                    <th key={comp.id} className="is-comp-col" aria-label={`竞品 ${index + 1} ${comp.brandName}`}>
                      <div className="brand-kb-compare-th">
                        <Tag color="orange">竞品 {index + 1}</Tag>
                        <strong>{comp.brandName}</strong>
                        <small>
                          已采 {comp.filledCount}/{comp.dimensionCount || 24} 维 ·{' '}
                          {COMPACT_STATUS[comp.status]?.label || comp.status}
                        </small>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARE_DIMENSIONS.map((dimMeta, rowIndex) => {
                  const ownDim = findDimension(ownPack, dimMeta.key);
                  const ownPending = isPendingDimension(ownDim);
                  return (
                    <tr key={dimMeta.key}>
                      <th scope="row" className="is-dim-col" aria-label={dimMeta.title}>
                        <div className="brand-kb-compare-dim">
                          <span className="brand-kb-compare-dim-num">{String(rowIndex + 1).padStart(2, '0')}</span>
                          <div>
                            <strong>{dimMeta.title}</strong>
                            <small>{dimMeta.hint}</small>
                          </div>
                        </div>
                      </th>
                      <td className={`is-own-col${ownPending ? ' is-pending-cell' : ''}`}>
                        <div className="brand-kb-compare-cell">
                          <p>{ownDim?.body || '待核验：公开检索未形成可引用事实。'}</p>
                          {ownDim?.status === 'edited' && <Tag color="gold">人工核验</Tag>}
                        </div>
                      </td>
                      {competitors.map(comp => {
                        const compDim = findDimension(comp, dimMeta.key);
                        const compPending = isPendingDimension(compDim);
                        return (
                          <td key={comp.id} className={compPending ? 'is-pending-cell' : ''}>
                            <div className="brand-kb-compare-cell">
                              <p>{compDim?.body || '待核验：公开检索未形成可引用事实。'}</p>
                              {compDim?.status === 'edited' && <Tag color="gold">人工核验</Tag>}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <section className="brand-kb-compare-dispatch" aria-label="带着对照档案一键派活">
            <div className="brand-kb-compare-dispatch-head">
              <strong>带着这份对照档案，一键派活给专家数字员工</strong>
              <span>
                已自动预填「{ownPack.brandName}」与 {competitors.map(item => `「${item.brandName}」`).join('、')}的 6
                维对照摘要，点击直达员工工作台开干。
              </span>
            </div>
            <div className="brand-kb-compare-dispatch-actions">
              <Button
                type="primary"
                size="large"
                icon={<ArrowRightOutlined />}
                onClick={() => dispatchToEmployee(nav, 102, buildCompareDirective('qian', ownPack, competitors))}
              >
                带着对照档案 → 派给钱商圈(#102)做竞争突围分析
              </Button>
              <Button
                size="large"
                icon={<ArrowRightOutlined />}
                onClick={() => dispatchToEmployee(nav, 108, buildCompareDirective('wang', ownPack, competitors))}
              >
                带着对照档案 → 派给王菜单(#108)做菜单差异化定价
              </Button>
            </div>
          </section>
        </Panel>
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

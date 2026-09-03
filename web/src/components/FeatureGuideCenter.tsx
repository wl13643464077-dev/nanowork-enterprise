import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppstoreOutlined,
  BarChartOutlined,
  CheckCircleOutlined,
  CompassOutlined,
  DatabaseOutlined,
  FileSearchOutlined,
  InfoCircleOutlined,
  PlayCircleOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SettingOutlined,
  ShopOutlined,
  TeamOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { Button, Drawer, Empty, Input, Segmented, Select, Tag } from 'antd';
import type { ReactNode } from 'react';
import {
  FEATURE_GUIDES,
  FEATURE_GUIDE_CATEGORIES,
  canAccessFeatureGuide,
  findFeatureGuide,
  normalizeGuidePath,
  resolveFeatureGuideContext,
  type FeatureGuide,
  type FeatureGuideCategory,
  type FeatureGuideContent,
} from './featureGuideCatalog';
import './FeatureGuideCenter.css';

export type FeatureGuideCenterProps = {
  open: boolean;
  onClose: () => void;
  currentPath: string;
  currentSearch?: string;
  modules: string[];
  role?: string;
  navigate: (path: string) => void;
  compact?: boolean;
  onOpenOnboarding?: () => void;
  contextKey?: string;
};

type ViewMode = 'current' | 'all';

const CATEGORY_ICONS: Record<FeatureGuideCategory, ReactNode> = {
  开始使用: <CompassOutlined />,
  经营决策: <BarChartOutlined />,
  派活执行: <TeamOutlined />,
  门店运营: <ShopOutlined />,
  增长营销: <AppstoreOutlined />,
  内容资产: <ToolOutlined />,
  数据分析: <DatabaseOutlined />,
  系统配置: <SettingOutlined />,
};

const SECTION_META: Array<{
  key: keyof FeatureGuideContent;
  title: string;
  icon: ReactNode;
  ordered?: boolean;
}> = [
  { key: 'whenToUse', title: '什么时候用', icon: <CompassOutlined /> },
  { key: 'preparation', title: '准备什么', icon: <FileSearchOutlined /> },
  { key: 'steps', title: '怎么操作', icon: <PlayCircleOutlined />, ordered: true },
  { key: 'resultLocation', title: '结果在哪里', icon: <DatabaseOutlined /> },
  { key: 'acceptance', title: '验收标准', icon: <CheckCircleOutlined /> },
  { key: 'cautions', title: '注意事项', icon: <SafetyCertificateOutlined /> },
];

function contextFromLocation(path: string, search: string, explicit?: string) {
  if (explicit) return explicit;
  if (normalizeGuidePath(path) === '/data-intake') return 'data-intake';
  try {
    const liveSearch =
      typeof window !== 'undefined' && normalizeGuidePath(window.location.pathname) === normalizeGuidePath(path)
        ? window.location.search
        : search;
    return new URLSearchParams(liveSearch).get('tab') || undefined;
  } catch {
    return undefined;
  }
}

function GuideDetail({ guide, contextKey, role }: { guide: FeatureGuide; contextKey?: string; role?: string }) {
  const content = resolveFeatureGuideContext(guide, contextKey, role);
  return (
    <article className="feature-guide-detail" aria-labelledby="feature-guide-detail-title">
      <header className="feature-guide-detail-head">
        <span className="feature-guide-detail-icon" aria-hidden="true">
          {CATEGORY_ICONS[guide.category]}
        </span>
        <div>
          <div className="feature-guide-detail-meta">
            <Tag>{guide.category}</Tag>
            <code>{guide.path}</code>
          </div>
          <h2 id="feature-guide-detail-title">{content.title}</h2>
          <p>{content.summary}</p>
        </div>
      </header>

      <div className="feature-guide-sections">
        {SECTION_META.map(section => {
          const items = content[section.key] as string[];
          const List = section.ordered ? 'ol' : 'ul';
          return (
            <section className={`feature-guide-section is-${section.key}`} key={section.key}>
              <h3>
                {section.icon}
                {section.title}
              </h3>
              <List>
                {items.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </List>
            </section>
          );
        })}
      </div>
    </article>
  );
}

export default function FeatureGuideCenter({
  open,
  onClose,
  currentPath,
  currentSearch = '',
  modules,
  role,
  navigate,
  compact = false,
  onOpenOnboarding,
  contextKey,
}: FeatureGuideCenterProps) {
  const currentGuide = useMemo(() => findFeatureGuide(currentPath), [currentPath]);
  const accessibleGuides = useMemo(
    () => FEATURE_GUIDES.filter(guide => canAccessFeatureGuide(guide, modules, role)),
    [modules, role],
  );
  const accessibleCurrent =
    currentGuide && accessibleGuides.some(guide => guide.id === currentGuide.id) ? currentGuide : null;
  const resolvedContext = contextFromLocation(currentPath, currentSearch, contextKey);
  const [mode, setMode] = useState<ViewMode>(accessibleCurrent ? 'current' : 'all');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | FeatureGuideCategory>('all');
  const [selectedId, setSelectedId] = useState(accessibleCurrent?.id || accessibleGuides[0]?.id || '');
  const [narrowViewport, setNarrowViewport] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches,
  );
  const [detailFocusRequest, setDetailFocusRequest] = useState(0);
  const detailRef = useRef<HTMLDivElement>(null);
  const shouldFocusDetail = useRef(false);
  const isCompact = compact || narrowViewport;

  useEffect(() => {
    const media = window.matchMedia('(max-width: 820px)');
    const onChange = (event: MediaQueryListEvent) => setNarrowViewport(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const filteredGuides = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase('zh-CN');
    return accessibleGuides.filter(guide => {
      if (category !== 'all' && guide.category !== category) return false;
      if (!keyword) return true;
      const haystack = [
        guide.title,
        guide.shortTitle,
        guide.summary,
        guide.category,
        guide.path,
        ...(guide.aliases || []),
        ...guide.keywords,
      ]
        .join(' ')
        .toLocaleLowerCase('zh-CN');
      return haystack.includes(keyword);
    });
  }, [accessibleGuides, category, query]);

  const selectedGuide = filteredGuides.find(guide => guide.id === selectedId) || filteredGuides[0] || null;
  const displayedGuide = mode === 'current' ? accessibleCurrent : selectedGuide;

  const openGuide = (guide: FeatureGuide) => {
    setSelectedId(guide.id);
    setMode('all');
    shouldFocusDetail.current = isCompact;
    if (isCompact) setDetailFocusRequest(value => value + 1);
  };

  const goToFeature = () => {
    if (!displayedGuide) return;
    onClose();
    navigate(displayedGuide.path);
  };

  useEffect(() => {
    if (!shouldFocusDetail.current || mode !== 'all' || !selectedGuide) return;
    shouldFocusDetail.current = false;
    const frame = window.requestAnimationFrame(() => {
      const detail = detailRef.current;
      if (!detail) return;
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      detail.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      detail.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detailFocusRequest, mode, selectedGuide]);

  return (
    <Drawer
      className="feature-guide-drawer"
      rootClassName={`feature-guide-drawer-root ${isCompact ? 'is-compact' : ''}`}
      placement={isCompact ? 'bottom' : 'right'}
      width={isCompact ? undefined : 760}
      height={isCompact ? '94%' : undefined}
      open={open}
      onClose={onClose}
      afterOpenChange={visible => {
        if (!visible) return;
        setSelectedId(accessibleCurrent?.id || accessibleGuides[0]?.id || '');
        setMode(accessibleCurrent ? 'current' : 'all');
        setQuery('');
        setCategory('all');
        shouldFocusDetail.current = false;
      }}
      destroyOnClose={false}
      title={
        <span className="feature-guide-title">
          <InfoCircleOutlined /> 功能使用指引
        </span>
      }
      extra={
        onOpenOnboarding ? (
          <Button
            type="link"
            size="small"
            onClick={() => {
              onClose();
              onOpenOnboarding();
            }}
          >
            新手总览
          </Button>
        ) : null
      }
      footer={
        displayedGuide ? (
          <div className="feature-guide-footer">
            <span>指引不会替你提交、审批、发布或产生费用。</span>
            {displayedGuide.id !== accessibleCurrent?.id && (
              <Button type="primary" onClick={goToFeature}>
                打开{displayedGuide.shortTitle}
              </Button>
            )}
          </div>
        ) : null
      }
    >
      <Segmented
        block
        value={mode}
        options={[
          { label: accessibleCurrent ? `当前功能 · ${accessibleCurrent.shortTitle}` : '当前功能', value: 'current' },
          { label: `全部功能 · ${accessibleGuides.length}`, value: 'all' },
        ]}
        onChange={value => {
          const nextMode = value as ViewMode;
          setMode(nextMode);
          if (nextMode === 'all') setSelectedId(accessibleCurrent?.id || filteredGuides[0]?.id || '');
        }}
      />

      {mode === 'current' ? (
        accessibleCurrent ? (
          <GuideDetail guide={accessibleCurrent} contextKey={resolvedContext} role={role} />
        ) : (
          <Empty className="feature-guide-empty" description="当前页面没有单独指引，请到“全部功能”查找">
            <Button type="primary" onClick={() => setMode('all')}>
              查看全部功能
            </Button>
          </Empty>
        )
      ) : (
        <div className="feature-guide-library">
          <div className="feature-guide-filters">
            <Input
              allowClear
              value={query}
              prefix={<SearchOutlined />}
              aria-label="搜索功能使用指引"
              placeholder="搜索功能、工作或结果，例如“差评”“任务失败”"
              onChange={event => {
                setQuery(event.target.value);
                setSelectedId('');
              }}
            />
            <Select
              value={category}
              aria-label="按功能分类筛选"
              onChange={value => {
                setCategory(value);
                setSelectedId('');
              }}
              options={[
                { value: 'all', label: '全部分类' },
                ...FEATURE_GUIDE_CATEGORIES.map(item => ({ value: item, label: item })),
              ]}
            />
          </div>

          <div className="feature-guide-library-grid">
            <nav className="feature-guide-list" aria-label="可使用功能指引">
              {filteredGuides.length ? (
                filteredGuides.map(guide => (
                  <button
                    type="button"
                    className={`feature-guide-list-item ${selectedGuide?.id === guide.id ? 'is-active' : ''}`}
                    key={guide.id}
                    aria-current={selectedGuide?.id === guide.id ? 'true' : undefined}
                    onClick={() => openGuide(guide)}
                  >
                    <span className="feature-guide-list-icon" aria-hidden="true">
                      {CATEGORY_ICONS[guide.category]}
                    </span>
                    <span>
                      <strong>{guide.shortTitle}</strong>
                      <small>{guide.category}</small>
                    </span>
                    <RightOutlined />
                  </button>
                ))
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的功能" />
              )}
            </nav>

            <div
              ref={detailRef}
              className="feature-guide-library-detail"
              tabIndex={-1}
              aria-live="polite"
              aria-label={selectedGuide ? `${selectedGuide.shortTitle}使用说明` : '功能使用说明'}
            >
              {selectedGuide ? (
                <GuideDetail
                  guide={selectedGuide}
                  contextKey={selectedGuide.id === accessibleCurrent?.id ? resolvedContext : undefined}
                  role={role}
                />
              ) : (
                <Empty description="当前账号暂无可用功能指引" />
              )}
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}

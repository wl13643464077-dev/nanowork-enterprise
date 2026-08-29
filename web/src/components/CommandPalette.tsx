import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Modal, Tag } from 'antd';
import {
  ArrowRightOutlined,
  ClockCircleOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  TeamOutlined,
  FileTextOutlined,
  CalendarOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { commandPaletteContentStatus } from './commandPaletteContentStatus.js';
import './CommandPalette.css';

/**
 * 全局命令面板（⌘K / Ctrl+K）。
 *
 * 为什么必要：系统有 13 个一级入口，System 页 8 个 Tab、内容生产仓 6 个 Tab，
 * 此前没有面包屑、没有全局搜索、没有命令面板，深层位置只能靠逐级点。
 *
 * 三种能力在同一个输入框里：
 * - 跳转：按名称直达任意模块
 * - 找东西：搜客户、活动、内容（走后端已有的列表接口，不新增端点）
 * - 直接干活：派活、生成内容这类高频动作
 *
 * 最近访问持久化在 localStorage，重开仍在。
 */

const RECENT_KEY = 'nanowork_cmdk_recent_v1';
const RECENT_MAX = 6;

export type PaletteNavItem = { key: string; label: string; group?: string };

type Entry = {
  id: string;
  label: string;
  hint?: string;
  section: string;
  icon: React.ReactNode;
  run: () => void;
};

type RemoteResults = {
  query: string;
  entries: Entry[];
};

/** 高频入口：带 query 的工具直达具体状态，其余进入对应业务模块 */
const ACTIONS: { id: string; label: string; hint: string; to: string; mod: string }[] = [
  { id: 'act-dispatch', label: '找员工派活', hint: '餐饮数字员工', to: '/employees', mod: 'marshals' },
  { id: 'act-content', label: '生成内容', hint: '内容生产仓', to: '/content', mod: 'content' },
  { id: 'act-hot', label: '今日必发', hint: '经营工具箱', to: '/toolbox?tool=hot', mod: 'content' },
  { id: 'act-poster', label: '做产品海报', hint: '经营工具箱', to: '/toolbox?tool=shot', mod: 'content' },
  { id: 'act-activity', label: '新建营销活动', hint: '营销活动', to: '/activities', mod: 'activities' },
  { id: 'act-lead', label: '录入客户线索', hint: '会员增长', to: '/growth', mod: 'growth' },
  { id: 'act-review', label: '看经营复盘', hint: '经营洞察', to: '/analysis', mod: 'analysis' },
  { id: 'act-advisor', label: '问老板参谋', hint: '老板参谋', to: '/advisor', mod: 'advisor' },
];

function loadRecent(): { path: string; label: string }[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(x => x && typeof x.path === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberRecent(path: string, label: string) {
  try {
    const next = [{ path, label }, ...loadRecent().filter(x => x.path !== path)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式下 localStorage 不可写，忽略即可 */
  }
}

function basePath(path: string) {
  const boundary = path.search(/[?#]/);
  return boundary < 0 ? path : path.slice(0, boundary);
}

/** 简单模糊匹配：连续子序列即命中，够用且无需引依赖 */
function fuzzy(text: string, query: string) {
  if (!query) return true;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t.includes(q)) return true;
  let i = 0;
  for (const ch of q) {
    i = t.indexOf(ch, i);
    if (i < 0) return false;
    i++;
  }
  return true;
}

export default function CommandPalette({
  open,
  onClose,
  navItems,
  modules,
}: {
  open: boolean;
  onClose: () => void;
  navItems: PaletteNavItem[];
  modules: string[];
}) {
  // 关闭时不挂载内部实例：下次打开即全新状态，无需在 effect 里手动清空
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={620}
      styles={{ body: { padding: 0 } }}
      className="cmdk-modal"
      title={<span className="cmdk-dialog-title">全局搜索与命令</span>}
      destroyOnHidden
    >
      {open && <PaletteBody onClose={onClose} navItems={navItems} modules={modules} />}
    </Modal>
  );
}

function PaletteBody({
  onClose,
  navItems,
  modules,
}: {
  onClose: () => void;
  navItems: PaletteNavItem[];
  modules: string[];
}) {
  const nav = useNavigate();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [remote, setRemote] = useState<RemoteResults>({ query: '', entries: [] });
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef(0);
  const ariaBaseId = useId();
  const listboxId = `${ariaBaseId}-listbox`;
  const allowedRecentByPath = useMemo(() => new Map(navItems.map(item => [item.key, item])), [navItems]);

  const go = useCallback(
    (path: string, label: string) => {
      rememberRecent(path, label);
      nav(path);
      onClose();
    },
    [nav, onClose],
  );

  // 实体搜索：复用已有列表接口的关键词参数，不新增端点。
  // 单次搜索失败不影响其他类别，也不弹全局错误（这里是辅助能力，不该打断主流程）。
  useEffect(() => {
    const kw = query.trim();
    // 关键词不足 2 字不发请求；输入事件已同步清空旧结果和搜索状态。
    if (kw.length < 2) {
      reqRef.current += 1;
      return;
    }
    const version = ++reqRef.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      const jobs: Promise<Entry[]>[] = [];
      if (modules.includes('growth') && allowedRecentByPath.has('/growth')) {
        jobs.push(
          api
            .get(`/growth/leads?kw=${encodeURIComponent(kw)}&page=1&size=4`, {
              signal: controller.signal,
              silent: true,
            })
            .then((res: any) => {
              const rows = Array.isArray(res) ? res : res?.rows || res?.items || [];
              return rows.slice(0, 4).map((r: any) => ({
                id: `lead-${r.id}`,
                label: String(r.name || r.contact || `客户#${r.id}`),
                hint: [r.stage, r.grade ? `${r.grade}级` : ''].filter(Boolean).join(' · ') || '客户线索',
                section: '客户',
                icon: <TeamOutlined />,
                run: () => go('/growth', '会员增长'),
              }));
            })
            .catch(() => []),
        );
      }
      if (modules.includes('content') && allowedRecentByPath.has('/content')) {
        jobs.push(
          api
            .get(`/content/list?kw=${encodeURIComponent(kw)}&page=1&size=4`, {
              signal: controller.signal,
              silent: true,
            })
            .then((res: any) => {
              const rows = Array.isArray(res) ? res : res?.rows || res?.items || [];
              return rows.slice(0, 4).map((r: any) => ({
                id: `content-${r.id}`,
                label: String(r.topic || r.title || `内容#${r.id}`),
                hint: [r.type, commandPaletteContentStatus(r)].filter(Boolean).join(' · ') || '内容记录',
                section: '内容',
                icon: <FileTextOutlined />,
                run: () => go('/content', '内容生产仓'),
              }));
            })
            .catch(() => []),
        );
      }
      if (modules.includes('activities') && allowedRecentByPath.has('/activities')) {
        jobs.push(
          api
            .get('/activities', { signal: controller.signal, silent: true })
            .then((res: any) => {
              const rows = Array.isArray(res) ? res : res?.rows || res?.items || [];
              return rows
                .filter((r: any) => fuzzy(String(r.name || r.title || ''), kw))
                .slice(0, 3)
                .map((r: any) => ({
                  id: `activity-${r.id}`,
                  label: String(r.name || r.title || `活动#${r.id}`),
                  hint: [r.type, r.status].filter(Boolean).join(' · ') || '营销活动',
                  section: '活动',
                  icon: <CalendarOutlined />,
                  run: () => go('/activities', '营销活动'),
                }));
            })
            .catch(() => []),
        );
      }
      void Promise.all(jobs).then(groups => {
        if (version !== reqRef.current) return;
        setRemote({ query: kw, entries: groups.flat() });
        setSearching(false);
      });
    }, 220); // 去抖：避免逐字敲击打爆后端
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (reqRef.current === version) reqRef.current += 1;
    };
  }, [query, modules, go, allowedRecentByPath]);

  const entries = useMemo<Entry[]>(() => {
    const kw = query.trim();
    const out: Entry[] = [];

    if (!kw) {
      for (const r of loadRecent()) {
        const allowed = allowedRecentByPath.get(basePath(r.path));
        if (!allowed) continue;
        out.push({
          id: `recent-${r.path}`,
          label: allowed.label,
          hint: r.path,
          section: '最近访问',
          icon: <ClockCircleOutlined />,
          run: () => go(r.path, allowed.label),
        });
      }
    }

    for (const item of navItems) {
      if (!fuzzy(item.label, kw)) continue;
      out.push({
        id: `nav-${item.key}`,
        label: item.label,
        hint: item.group,
        section: '前往',
        icon: <ArrowRightOutlined />,
        run: () => go(item.key, item.label),
      });
    }

    for (const a of ACTIONS) {
      const destination = allowedRecentByPath.get(basePath(a.to));
      if (!modules.includes(a.mod) || !destination) continue;
      const label = a.id === 'act-advisor' ? `打开${destination.label}` : a.label;
      if (!fuzzy(`${label} ${destination.label}`, kw)) continue;
      out.push({
        id: a.id,
        label,
        hint: destination.label,
        section: '快捷动作',
        icon: <ThunderboltOutlined />,
        run: () => go(a.to, a.hint),
      });
    }

    // 远端结果必须与当前规范化关键词完全一致，避免新请求完成前展示上一轮结果。
    const remoteEntries = kw.length >= 2 && remote.query === kw ? remote.entries : [];
    return [...out, ...remoteEntries];
  }, [query, navItems, modules, remote, go, allowedRecentByPath]);

  // 分组保持声明顺序，每组上限 6 条避免一类结果淹没其他类
  const sections = useMemo(() => {
    const order = ['最近访问', '前往', '快捷动作', '客户', '内容', '活动'];
    const map = new Map<string, Entry[]>();
    for (const e of entries) {
      if (!map.has(e.section)) map.set(e.section, []);
      const bucket = map.get(e.section)!;
      if (bucket.length < 6) bucket.push(e);
    }
    return order.filter(s => map.has(s)).map(s => ({ section: s, items: map.get(s)! }));
  }, [entries]);

  const flat = useMemo(() => sections.flatMap(s => s.items), [sections]);

  // 光标越界时收敛到末项（结果集变短时可能发生），在渲染期修正而非 effect 里 setState
  const safeCursor = flat.length ? Math.min(cursor, flat.length - 1) : 0;
  const activeOptionId = flat.length ? `${listboxId}-option-${safeCursor}` : undefined;

  useEffect(() => {
    // Modal 挂载后再聚焦，否则焦点会被 Modal 自身抢走
    const timer = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => window.clearTimeout(timer);
  }, []);

  // 键盘导航：上下选择、Enter 执行、Esc 由 Modal 处理
  const onKeyDown = (e: React.KeyboardEvent) => {
    // 中文等输入法组合输入期间，方向键和 Enter 属于候选词操作，不能触发命令。
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setCursor(flat.length ? (safeCursor + 1) % flat.length : 0);
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setCursor(flat.length ? (safeCursor - 1 + flat.length) % flat.length : 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      flat[safeCursor]?.run();
    }
  };

  const changeQuery = (value: string) => {
    reqRef.current += 1;
    setQuery(value);
    setCursor(0);
    setRemote({ query: '', entries: [] });
    setSearching(false);
  };

  // 键盘移动选中项时把它滚进视野
  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [safeCursor]);

  let index = -1;

  return (
    <div className="cmdk">
      <div className="cmdk-input-row">
        <SearchOutlined className="cmdk-input-icon" />
        <input
          ref={inputRef}
          className="cmdk-input"
          value={query}
          onChange={e => changeQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜模块、客户、内容、活动，或直接输入要做的事"
          maxLength={100}
          role="combobox"
          aria-label="全局搜索与命令"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded="true"
          aria-activedescendant={activeOptionId}
          autoComplete="off"
        />
        <span className="cmdk-searching" role="status" aria-live="polite">
          {searching && query.trim().length >= 2 ? '搜索中' : ''}
        </span>
      </div>

      <div
        id={listboxId}
        className="cmdk-list"
        ref={listRef}
        role="listbox"
        aria-label="搜索结果"
        aria-busy={searching}
      >
        {flat.length === 0 ? (
          <div className="cmdk-empty">
            {searching && query.trim().length >= 2
              ? '正在查找业务记录…'
              : query.trim().length === 1
                ? '再多输入一个字开始搜索'
                : '没有匹配项，换个说法试试'}
          </div>
        ) : (
          sections.map((sec, sectionIndex) => {
            const sectionId = `${listboxId}-section-${sectionIndex}`;
            return (
              <div key={sec.section} className="cmdk-section" role="group" aria-labelledby={sectionId}>
                <div id={sectionId} className="cmdk-section-title">
                  {sec.section}
                </div>
                {sec.items.map(item => {
                  index += 1;
                  const active = index === safeCursor;
                  const at = index;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      id={`${listboxId}-option-${at}`}
                      className={`cmdk-item ${active ? 'cmdk-item--active' : ''}`}
                      data-active={active}
                      role="option"
                      aria-selected={active}
                      onMouseEnter={() => setCursor(at)}
                      onClick={() => item.run()}
                    >
                      <span className="cmdk-item-icon">{item.icon}</span>
                      <span className="cmdk-item-label">{item.label}</span>
                      {item.hint && <span className="cmdk-item-hint">{item.hint}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      <div className="cmdk-foot">
        <Tag bordered={false}>↑↓ 选择</Tag>
        <Tag bordered={false}>Enter 打开</Tag>
        <Tag bordered={false}>Esc 关闭</Tag>
      </div>
    </div>
  );
}

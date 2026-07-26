import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Alert, Button, Empty, Input, Select, Skeleton, Tag, Tooltip } from 'antd';
import {
  AppstoreOutlined, DeploymentUnitOutlined, FileDoneOutlined, FilterOutlined, SearchOutlined,
} from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { AnimatedNumber } from '../components/Kit';
import EmployeeWorkbench from '../components/EmployeeWorkbench';

type Employee = {
  idx: number;
  key: string;
  person: string;
  name: string;
  duty: string;
  desc?: string;
  intro?: string;
  group: string;
  emoji?: string;
  color?: string;
  inputs?: string[];
  steps?: string[];
  deliverables?: string[];
  status?: string;
  marshalId: number;
  specialistId: number;
  extension?: boolean;
};

type EmployeeCatalog = {
  total: number;
  coreCount?: number;
  extensionCount?: number;
  groups: { name: string; emoji?: string; color?: string; count: number }[];
  employees: Employee[];
};

export default function Employees() {
  const [params, setParams] = useSearchParams();
  const [catalog, setCatalog] = useState<EmployeeCatalog>({ total: 0, groups: [], employees: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [keyword, setKeyword] = useState(params.get('q') || '');
  const [group, setGroup] = useState(params.get('group') || '全部分部');
  const [statusFilter, setStatusFilter] = useState(params.get('status') || '');
  const [selected, setSelected] = useState<Employee | null>(null);

  const loadCatalog = () => {
    setLoading(true);
    setLoadError('');
    api.get('/employees')
      .then((data: EmployeeCatalog | Employee[]) => {
        if (Array.isArray(data)) setCatalog({ total: data.length, groups: [], employees: data });
        else setCatalog({ total: data.total ?? data.employees?.length ?? 0, coreCount: data.coreCount, extensionCount: data.extensionCount, groups: data.groups || [], employees: data.employees || [] });
      })
      .catch((error: any) => {
        setCatalog({ total: 0, groups: [], employees: [] });
        setLoadError(error?.message || '餐饮数字员工目录读取失败');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let active = true;
    api.get('/employees')
      .then((data: EmployeeCatalog | Employee[]) => {
        if (!active) return;
        if (Array.isArray(data)) setCatalog({ total: data.length, groups: [], employees: data });
        else setCatalog({ total: data.total ?? data.employees?.length ?? 0, coreCount: data.coreCount, extensionCount: data.extensionCount, groups: data.groups || [], employees: data.employees || [] });
      })
      .catch((error: any) => {
        if (!active) return;
        setCatalog({ total: 0, groups: [], employees: [] });
        setLoadError(error?.message || '餐饮数字员工目录读取失败');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  // 实时脉搏：分部执行中任务数 + 最新任务动态（30 秒可见性门控轮询；失败静默隐藏，不用空框冒充）
  const [pulse, setPulse] = useState<{ depts: any[]; feed: any[] } | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => Promise.all([
      api.get('/marshals/drill/marshals').catch(() => null),
      api.get('/marshals/drill/outputs').catch(() => null),
    ]).then(([depts, outputs]: any[]) => {
      if (!active) return;
      const deptRows = Array.isArray(depts?.rows) ? depts.rows : [];
      const feedRows = Array.isArray(outputs?.rows) ? outputs.rows.slice(0, 7) : [];
      setPulse(deptRows.length || feedRows.length ? { depts: deptRows, feed: feedRows } : null);
    });
    load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  // 员工运行状态静默刷新（执行中/空闲实时变化，不打断浏览）
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      api.get('/employees').then((data: EmployeeCatalog | Employee[]) => {
        if (Array.isArray(data)) setCatalog(current => ({ ...current, employees: data }));
        else setCatalog({ total: data.total ?? data.employees?.length ?? 0, coreCount: data.coreCount, extensionCount: data.extensionCount, groups: data.groups || [], employees: data.employees || [] });
      }).catch(() => {});
    }, 30000);
    return () => window.clearInterval(timer);
  }, []);
  const runningByGroup = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of pulse?.depts || []) map.set(String(d.name || ''), Number(d.running) || 0);
    return map;
  }, [pulse]);

  // 搜索防抖 200ms：避免逐字符触发 70 张卡全量重算
  const [debouncedKeyword, setDebouncedKeyword] = useState(keyword);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedKeyword(keyword), 200);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const filtered = useMemo(() => {
    const q = debouncedKeyword.trim().toLowerCase();
    return catalog.employees.filter(employee => {
      if (group !== '全部分部' && employee.group !== group) return false;
      if (statusFilter && (employee.status || '状态未知') !== statusFilter) return false;
      if (!q) return true;
      return [employee.person, employee.name, employee.duty, employee.desc, employee.group]
        .some(value => String(value || '').toLowerCase().includes(q));
    });
  }, [catalog.employees, debouncedKeyword, group, statusFilter]);

  const statusOptions = useMemo(() => [...new Set(catalog.employees.map(employee => employee.status || '状态未知'))]
    .filter(Boolean).sort().map(value => ({ value, label: value })), [catalog.employees]);
  const coreCount = catalog.coreCount ?? catalog.employees.filter(employee => !employee.extension).length;
  const extensionCount = catalog.extensionCount ?? catalog.employees.filter(employee => employee.extension).length;
  const displayCount = (value: number) => loading || loadError ? '—' : <AnimatedNumber value={value} />;

  const selectGroup = (value: string) => {
    setGroup(value);
    const next = new URLSearchParams(params);
    if (value === '全部分部') next.delete('group'); else next.set('group', value);
    if (keyword.trim()) next.set('q', keyword.trim()); else next.delete('q');
    setParams(next, { replace: true });
  };

  const selectStatus = (value: string) => {
    setStatusFilter(value);
    const next = new URLSearchParams(params);
    if (value) next.set('status', value); else next.delete('status');
    if (keyword.trim()) next.set('q', keyword.trim()); else next.delete('q');
    setParams(next, { replace: true });
  };

  const openEmployee = (employee: Employee) => setSelected(employee);

  return (
    <div className="employee-page">
      <style>{STYLES}</style>

      <section className="employee-hero">
        <div className="employee-hero-copy">
          <div className="employee-kicker"><DeploymentUnitOutlined /> 纳米Work · 餐饮产业员工库</div>
          <h1>把经营问题，交给真正懂这一岗的人</h1>
          <p>从选址、菜单、食安到利润和连锁，核心岗位与超级店长扩展协同待命。先看清职责，再把任务派下去。</p>
        </div>
        <div className="employee-hero-stats">
          <div><strong>{displayCount(coreCount)}</strong><span>核心岗位</span></div>
          <div><strong>{displayCount(extensionCount)}</strong><span>店长扩展</span></div>
          <div><strong>{displayCount(catalog.groups.length)}</strong><span>专业分部</span></div>
          <div><strong>{displayCount(catalog.total)}</strong><span>数字员工</span></div>
        </div>
      </section>

      <section className="employee-toolbar" aria-label="筛选数字员工">
        <div className="employee-search">
          <SearchOutlined />
          <Input bordered={false} allowClear value={keyword} onChange={event => setKeyword(event.target.value)}
            onPressEnter={() => {
              const next = new URLSearchParams(params);
              if (keyword.trim()) next.set('q', keyword.trim()); else next.delete('q');
              setParams(next, { replace: true });
            }} placeholder="输入问题或岗位，例如：毛利、排班、外卖、选址" aria-label="搜索数字员工" />
        </div>
        <Select className="employee-status-filter" allowClear placeholder="全部状态" aria-label="按员工状态筛选"
          value={statusFilter || undefined} options={statusOptions} onChange={value => selectStatus(value || '')} />
        <div className="employee-filter-count"><FilterOutlined /> 已找到 <strong>{loading || loadError ? '—' : filtered.length}</strong> 位合适员工</div>
      </section>

      <nav className="employee-groups" aria-label="员工分部">
        <button className={group === '全部分部' ? 'active' : ''} onClick={() => selectGroup('全部分部')}>
          <AppstoreOutlined /> 全部分部 <span>{loading || loadError ? '—' : catalog.total}</span>
        </button>
        {catalog.groups.map(item => {
          const running = runningByGroup.get(item.name) || 0;
          return (
            <button key={item.name} className={group === item.name ? 'active' : ''} onClick={() => selectGroup(item.name)}
              title={running > 0 ? `${item.name}：${running} 个任务执行中` : undefined}>
              <i>{item.emoji || '•'}</i>{item.name.replace('部', '')}<span>{item.count}</span>
              {running > 0 && <em className="group-live" aria-label={`${running} 个任务执行中`}>{running}</em>}
            </button>
          );
        })}
      </nav>

      {pulse && pulse.feed.length > 0 && (
        <section className="employee-pulse nw-rise" aria-label="数字员工实时工作动态">
          <div className="employee-pulse-head">
            <strong>实时工作动态</strong>
            <span>来自真实任务记录 · 30 秒自动刷新</span>
          </div>
          <div className="employee-pulse-feed">
            {pulse.feed.map((item: any, index: number) => (
              <div className="employee-pulse-item" key={item.id} style={{ '--enter-delay': `${Math.min(index * 60, 360)}ms` } as CSSProperties}>
                <span className="employee-pulse-emoji" aria-hidden="true">{item.emoji || '🤖'}</span>
                <span className="employee-pulse-dept">{item.marshal}</span>
                <span className="employee-pulse-title">{item.title}</span>
                <span className={`employee-pulse-status s-${item.status === '生成中' ? 'run' : item.status === '待审阅' ? 'wait' : item.status === '已完成' ? 'done' : 'other'}`}>
                  {item.status === '生成中' ? <>生成中<span className="nw-typing"><i /><i /><i /></span></> : item.status}
                </span>
                <time>{String(item.created_at || '').slice(5, 16)}</time>
              </div>
            ))}
          </div>
        </section>
      )}

      <Alert className="employee-origin" type="info" showIcon
        message="员工定义来自派活餐饮产业部岗位手册；历史测试输出未作为经营事实或知识答案导入。" />

      {loadError && <Alert type="error" showIcon message="餐饮数字员工目录暂不可用"
        description={`${loadError}。页面不会用预设数字冒充实时目录。`}
        action={<Button size="small" onClick={loadCatalog}>重新读取</Button>} />}

      {loading ? (
        <div className="employee-grid">{Array.from({ length: 12 }, (_, index) => <div className="employee-card employee-card-loading" key={index}><Skeleton active paragraph={{ rows: 3 }} /></div>)}</div>
      ) : loadError ? null : filtered.length ? (
        <section className="employee-grid" aria-live="polite">
          {filtered.map((employee, index) => (
            <article className={`employee-card nw-rise${employee.status === '执行中' ? ' busy' : ''}`}
              style={{ '--enter-delay': `${Math.min(index * 35, 560)}ms` } as CSSProperties}
              key={employee.idx} onClick={() => openEmployee(employee)} tabIndex={0}
              role="button" aria-label={`打开${employee.person || employee.name}的完整员工工作台`}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openEmployee(employee);
                }
              }}>
              <div className="employee-card-top">
                <div className="employee-avatar" style={{ '--employee-color': employee.color || '#2c76dc' } as CSSProperties}>
                  <span>{employee.emoji || '🧑‍💼'}</span>
                </div>
                <div className="employee-identity">
                  <div><strong>{employee.person || employee.name}</strong>{employee.extension && <Tag color="blue">扩展</Tag>}</div>
                  <span>{employee.group}</span>
                </div>
                <Tooltip title={employee.status === '执行中'
                  ? '正在执行任务，完成后会进入待审阅'
                  : employee.status === '空闲'
                    ? '当前空闲，可以立即派活'
                    : employee.status || '运行状态尚未上报'}>
                  <span className={`employee-live ${employee.status === '执行中' ? 'busy' : employee.status === '空闲' ? 'idle' : 'unknown'}`}>
                    <i className="dot" aria-hidden="true" />
                    {employee.status === '执行中'
                      ? <>执行中<span className="nw-typing"><i /><i /><i /></span></>
                      : employee.status === '空闲' ? '空闲' : '未知'}
                  </span>
                </Tooltip>
              </div>
              <h2>{employee.name}</h2>
              <p>{employee.desc || employee.duty}</p>
              <div className="employee-card-foot">
                <span><FileDoneOutlined /> {(employee.deliverables || []).length
                  ? `${employee.deliverables!.length} 类交付`
                  : '交付清单待同步'}</span>
                <span className="employee-card-link">完整工作台 <span>→</span></span>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <Empty className="employee-empty" description="没有匹配的员工，换一个经营问题试试" />
      )}

      <EmployeeWorkbench open={!!selected} domain="restaurant" idx={selected?.idx ?? null}
        identityHint={selected ? {
          idx: selected.idx,
          name: selected.name,
          person: selected.person,
          group: selected.group,
          emoji: selected.emoji,
          color: selected.color,
          status: selected.status,
          duty: selected.duty,
          intro: selected.intro || selected.desc,
          extension: selected.extension,
        } : null}
        onClose={() => setSelected(null)} />
    </div>
  );
}

const STYLES = `
.employee-page{display:flex;flex-direction:column;gap:14px;color:var(--ui-text)}
.employee-hero{position:relative;overflow:hidden;display:grid;grid-template-columns:minmax(0,1.4fr) minmax(360px,.75fr);gap:28px;align-items:end;min-height:220px;padding:30px 34px;border-radius:18px;background:radial-gradient(circle at 84% 16%,rgba(83,157,245,.3),transparent 28%),linear-gradient(132deg,#071d36,#0b3a70 62%,#1769d2);box-shadow:0 18px 48px rgba(14,64,122,.16);color:#fff}.employee-hero:after{content:'';position:absolute;right:-70px;bottom:-125px;width:340px;height:340px;border:1px solid rgba(148,197,255,.22);border-radius:50%;box-shadow:0 0 0 50px rgba(128,184,248,.045),0 0 0 100px rgba(128,184,248,.025)}.employee-hero-copy,.employee-hero-stats{position:relative;z-index:1}.employee-kicker{display:flex;align-items:center;gap:7px;color:#9fc9f7;font-size:11px;letter-spacing:1.3px}.employee-hero h1{margin:17px 0 9px;font-size:clamp(27px,3vw,42px);line-height:1.15;letter-spacing:-1.8px;text-wrap:balance}.employee-hero p{max-width:720px;margin:0;color:#b8d3ee;font-size:13px;line-height:1.8}.employee-hero-stats{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;overflow:hidden;border:1px solid rgba(169,211,255,.17);border-radius:14px;background:rgba(4,24,47,.28);backdrop-filter:blur(10px)}.employee-hero-stats div{padding:17px 18px;background:rgba(255,255,255,.035)}.employee-hero-stats strong{display:block;font:680 26px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace}.employee-hero-stats span{display:block;margin-top:5px;color:#9dbddd;font-size:10.5px}
.employee-toolbar{display:flex;align-items:center;gap:12px;padding:12px 15px;border:1px solid var(--ui-border);border-radius:13px;background:var(--ui-surface)}.employee-search{flex:1;display:flex;align-items:center;gap:8px;max-width:700px;padding:0 12px;border-radius:9px;background:var(--ui-surface-2);color:var(--ui-muted)}.employee-search .ant-input{height:36px;background:transparent}.employee-status-filter{width:150px;flex:0 0 auto}.employee-filter-count{margin-left:auto;color:var(--ui-muted);font-size:11.5px;white-space:nowrap}.employee-filter-count strong{color:var(--ui-primary);font-size:14px}
.employee-groups{display:flex;gap:7px;overflow-x:auto;padding:2px 1px 4px}.employee-groups button{display:flex;align-items:center;gap:6px;flex:0 0 auto;height:34px;padding:0 11px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-surface);color:var(--ui-text-2);cursor:pointer;font-size:11.5px;transition:transform .18s,border-color .18s,background .18s,color .18s}.employee-groups button:hover{transform:translateY(-1px);border-color:#8bb6e9;color:var(--ui-primary)}.employee-groups button.active{border-color:#1769d2;background:#1769d2;color:#fff;box-shadow:0 7px 16px rgba(23,105,210,.17)}.employee-groups button i{font-style:normal}.employee-groups button span{min-width:17px;padding:1px 4px;border-radius:4px;background:rgba(127,151,180,.12);font:600 9px ui-monospace,SFMono-Regular,Menlo,monospace}.employee-groups button.active span{background:rgba(255,255,255,.17)}.employee-origin{border-radius:10px!important}
.employee-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.employee-card{position:relative;min-width:0;min-height:248px;content-visibility:auto;contain-intrinsic-size:auto 248px;padding:16px 15px 14px;border:1px solid var(--ui-border);border-radius:14px;background:var(--ui-surface);box-shadow:0 8px 22px rgba(21,55,93,.045);cursor:pointer;outline:none;transition:transform .22s,border-color .22s,box-shadow .22s}.employee-card:hover,.employee-card:focus-visible{transform:translateY(-3px);border-color:#8db7e8;box-shadow:0 16px 32px rgba(19,79,148,.11)}.employee-card:focus-visible{box-shadow:0 0 0 3px rgba(44,118,220,.18),0 16px 32px rgba(19,79,148,.11)}.employee-card-top{display:flex;align-items:center;gap:10px}.employee-avatar{width:43px;height:43px;display:grid;place-items:center;flex:0 0 auto;border-radius:12px;background:color-mix(in srgb,var(--employee-color) 12%,var(--ui-surface));border:1px solid color-mix(in srgb,var(--employee-color) 23%,transparent)}.employee-avatar span{font-size:21px;filter:drop-shadow(0 3px 6px rgba(20,54,90,.12))}.employee-identity{min-width:0;flex:1}.employee-identity>div{display:flex;align-items:center;gap:4px}.employee-identity strong{overflow:hidden;color:var(--ui-text);font-size:13.5px;text-overflow:ellipsis;white-space:nowrap}.employee-identity .ant-tag{margin:0;font-size:9px;line-height:17px}.employee-identity>span{display:block;margin-top:2px;overflow:hidden;color:var(--ui-muted);font-size:9.8px;text-overflow:ellipsis;white-space:nowrap}.employee-status{width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:#3ac28e;box-shadow:0 0 0 4px rgba(58,194,142,.1)}.employee-status.busy{background:#e6a23c;box-shadow:0 0 0 4px rgba(230,162,60,.1)}.employee-status.unknown{background:#94a3b8;box-shadow:0 0 0 4px rgba(148,163,184,.12)}.employee-card h2{margin:17px 0 7px;color:var(--ui-text);font-size:14px;line-height:1.45}.employee-card p{display:-webkit-box;min-height:62px;margin:0;overflow:hidden;color:var(--ui-text-2);font-size:11.5px;line-height:1.75;-webkit-box-orient:vertical;-webkit-line-clamp:3}.employee-card-foot{position:absolute;left:15px;right:15px;bottom:13px;display:flex;align-items:center;justify-content:space-between;padding-top:11px;border-top:1px solid var(--ui-border);color:var(--ui-muted);font-size:10px}.employee-card-foot span{display:flex;align-items:center;gap:4px}.employee-card-link{color:var(--ui-primary);font-size:10.5px;font-weight:600}.employee-card-link span{display:inline}.employee-card-loading{cursor:default}.employee-card-loading:hover{transform:none}.employee-empty{padding:80px 0}
.employee-drawer-title{display:flex;align-items:center;gap:10px}.employee-drawer-title>span{width:40px;height:40px;display:grid;place-items:center;border-radius:11px;background:#eaf2fc;font-size:21px}.employee-drawer-title strong,.employee-drawer-title small{display:block}.employee-drawer-title strong{font-size:15px}.employee-drawer-title small{margin-top:2px;color:var(--ui-muted);font-size:11px;font-weight:400}.employee-detail{display:flex;flex-direction:column;gap:22px}.employee-detail-banner{padding:18px;border:1px solid #dbe8f7;border-radius:14px;background:linear-gradient(135deg,#f3f8fe,#e9f2fd)}:root[data-theme='midnight'] .employee-detail-banner{border-color:var(--ui-border);background:var(--ui-surface-2)}.employee-detail-banner>div:first-child{color:var(--ui-primary);font-size:11px;font-weight:650}.employee-detail-banner p{margin:10px 0 12px;color:var(--ui-text-2);font-size:12.5px;line-height:1.8}.employee-detail-tags .ant-tag{font-size:10px}.employee-detail section{padding-top:2px}.employee-detail h3{margin:0 0 12px;color:var(--ui-text);font-size:14px}.employee-check-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0;padding:0;list-style:none}.employee-check-list li{display:flex;align-items:flex-start;gap:7px;padding:9px 10px;border-radius:8px;background:var(--ui-surface-2);color:var(--ui-text-2);font-size:11.5px;line-height:1.55}.employee-check-list .anticon{margin-top:2px;color:#36a879}.employee-detail .ant-timeline{margin-top:4px}.employee-detail .ant-timeline-item-content{color:var(--ui-text-2);font-size:11.5px;line-height:1.65}.employee-deliverables{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.employee-deliverables>div{display:flex;align-items:flex-start;gap:8px;padding:10px 11px;border:1px solid var(--ui-border);border-radius:9px;color:var(--ui-text-2);font-size:11.5px;line-height:1.55}.employee-deliverables .anticon{margin-top:2px;color:var(--ui-primary)}.employee-section-title{display:flex;align-items:center;justify-content:space-between}.employee-section-title span{color:var(--ui-muted);font-size:10px}.task-done{color:#32ad79}.task-running{color:#2780dc}
@media(max-width:1500px){.employee-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(max-width:1180px){.employee-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.employee-hero{grid-template-columns:1fr}.employee-hero-stats{max-width:520px}}@media(max-width:760px){.employee-hero{min-height:0;padding:24px 20px}.employee-hero-stats{grid-template-columns:repeat(4,1fr)}.employee-hero-stats div{padding:12px 8px}.employee-hero-stats strong{font-size:20px}.employee-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.employee-toolbar{align-items:stretch;flex-direction:column;gap:8px}.employee-status-filter{width:100%}.employee-filter-count{margin:0}.employee-check-list,.employee-deliverables{grid-template-columns:1fr}}@media(max-width:520px){.employee-grid{grid-template-columns:1fr}.employee-card{min-height:220px}.employee-hero-stats{grid-template-columns:repeat(2,1fr)}}

/* ===== 鲜活化（迭代六）：状态芯片 / 忙碌辉光 / 实时动态流 / 分部脉搏 ===== */
.employee-live{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;flex:0 0 auto;white-space:nowrap}
.employee-live.idle{color:#2f9e6e;background:rgba(58,194,142,.12)}
.employee-live.busy{color:#b97f1e;background:rgba(230,162,60,.14)}
.employee-live.unknown{color:var(--ui-muted);background:var(--ui-surface-2)}
.employee-live .dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}
.employee-live.idle .dot{animation:employee-breathe 3.2s ease-in-out infinite}
.employee-live.busy .dot{animation:employee-pulse 1.6s ease-out infinite}
@keyframes employee-breathe{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes employee-pulse{0%{box-shadow:0 0 0 0 rgba(230,162,60,.5)}75%{box-shadow:0 0 0 6px rgba(230,162,60,0)}100%{box-shadow:0 0 0 0 rgba(230,162,60,0)}}
.employee-card.busy .employee-avatar{animation:employee-glow 2.4s ease-in-out infinite}
@keyframes employee-glow{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--employee-color) 0%,transparent)}50%{box-shadow:0 0 0 5px color-mix(in srgb,var(--employee-color) 22%,transparent)}}
.employee-card .employee-avatar{transition:transform .25s var(--ease-out)}
.employee-card:hover .employee-avatar{transform:scale(1.08) rotate(-3deg)}
.group-live{display:inline-grid;place-items:center;min-width:17px;height:17px;padding:0 4px;margin-left:2px;border-radius:999px;background:#e6a23c;color:#fff;font-style:normal;font-size:10px;font-weight:700;animation:employee-pulse 1.6s ease-out infinite}
.employee-pulse{border:1px solid var(--ui-border);border-radius:var(--radius-lg);background:var(--ui-surface);padding:12px 16px}
.employee-pulse-head{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
.employee-pulse-head strong{font-size:13px;color:var(--ui-text)}
.employee-pulse-head span{font-size:11px;color:var(--ui-muted)}
.employee-pulse-feed{display:flex;flex-direction:column}
.employee-pulse-item{display:flex;align-items:center;gap:10px;padding:7px 2px;border-top:1px dashed var(--ui-border);font-size:12px;animation:nw-rise .5s var(--ease-out) both;animation-delay:var(--enter-delay,0ms)}
.employee-pulse-item:first-child{border-top:none}
.employee-pulse-emoji{font-size:15px;flex:0 0 auto}
.employee-pulse-dept{color:var(--ui-text-2);font-weight:600;flex:0 0 auto}
.employee-pulse-title{color:var(--ui-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}
.employee-pulse-status{flex:0 0 auto;display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600}
.employee-pulse-status.s-run{color:#b97f1e;background:rgba(230,162,60,.14)}
.employee-pulse-status.s-wait{color:#1769d2;background:rgba(23,105,210,.1)}
.employee-pulse-status.s-done{color:#2f9e6e;background:rgba(58,194,142,.12)}
.employee-pulse-status.s-other{color:var(--ui-muted);background:var(--ui-surface-2)}
.employee-pulse-item time{color:var(--ui-muted);font-size:11px;flex:0 0 auto;font-variant-numeric:tabular-nums}
@media(max-width:640px){.employee-pulse-dept{display:none}.employee-pulse-item time{display:none}}
@media(prefers-reduced-motion:reduce){.employee-live .dot,.employee-card.busy .employee-avatar,.group-live{animation:none}.employee-card:hover .employee-avatar{transform:none}}
`;

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Alert, Button, Empty, Input, Select, Skeleton, Tag, Tooltip } from 'antd';
import {
  AppstoreOutlined,
  DeploymentUnitOutlined,
  FileDoneOutlined,
  FilterOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { AnimatedNumber } from '../components/Kit';
import EmployeeAvatar from '../components/EmployeeAvatar';
import EmployeeWorkbench from '../components/EmployeeWorkbench';
import './Employees.css';

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
  currentTask?: string;
  monthTasks?: number;
  monthDone?: number;
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
    api
      .get('/employees')
      .then((data: EmployeeCatalog | Employee[]) => {
        if (Array.isArray(data)) setCatalog({ total: data.length, groups: [], employees: data });
        else
          setCatalog({
            total: data.total ?? data.employees?.length ?? 0,
            coreCount: data.coreCount,
            extensionCount: data.extensionCount,
            groups: data.groups || [],
            employees: data.employees || [],
          });
      })
      .catch((error: any) => {
        setCatalog({ total: 0, groups: [], employees: [] });
        setLoadError(error?.message || '餐饮数字员工目录读取失败');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let active = true;
    api
      .get('/employees')
      .then((data: EmployeeCatalog | Employee[]) => {
        if (!active) return;
        if (Array.isArray(data)) setCatalog({ total: data.length, groups: [], employees: data });
        else
          setCatalog({
            total: data.total ?? data.employees?.length ?? 0,
            coreCount: data.coreCount,
            extensionCount: data.extensionCount,
            groups: data.groups || [],
            employees: data.employees || [],
          });
      })
      .catch((error: any) => {
        if (!active) return;
        setCatalog({ total: 0, groups: [], employees: [] });
        setLoadError(error?.message || '餐饮数字员工目录读取失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // 实时脉搏：分部执行中任务数 + 最新任务动态（30 秒可见性门控轮询；失败静默隐藏，不用空框冒充）
  const [pulse, setPulse] = useState<{ depts: any[]; feed: any[] } | null>(null);
  useEffect(() => {
    let active = true;
    const load = () =>
      Promise.all([
        api.get('/marshals/drill/marshals').catch(() => null),
        api.get('/marshals/drill/outputs').catch(() => null),
      ]).then(([depts, outputs]: any[]) => {
        if (!active) return;
        const deptRows = Array.isArray(depts?.rows) ? depts.rows : [];
        const feedRows = Array.isArray(outputs?.rows) ? outputs.rows.slice(0, 7) : [];
        setPulse(deptRows.length || feedRows.length ? { depts: deptRows, feed: feedRows } : null);
      });
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 30000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  // 员工运行状态静默刷新（执行中/空闲实时变化，不打断浏览）
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      api
        .get('/employees')
        .then((data: EmployeeCatalog | Employee[]) => {
          if (Array.isArray(data)) setCatalog(current => ({ ...current, employees: data }));
          else
            setCatalog({
              total: data.total ?? data.employees?.length ?? 0,
              coreCount: data.coreCount,
              extensionCount: data.extensionCount,
              groups: data.groups || [],
              employees: data.employees || [],
            });
        })
        .catch(() => {});
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
      return [employee.person, employee.name, employee.duty, employee.desc, employee.group].some(value =>
        String(value || '')
          .toLowerCase()
          .includes(q),
      );
    });
  }, [catalog.employees, debouncedKeyword, group, statusFilter]);

  // 部门专属色系：8 个分部各占一个明确色相（低饱和专业调），按目录分部顺序分配；
  // 头像、工号、分组视觉随部门换色，扫一眼即可区分部门
  const DEPT_PALETTE = ['#3b74d1', '#0f9f89', '#d97f2b', '#7a5bd8', '#d1548c', '#4a9d4f', '#2a9dbf', '#8a6d3b'];
  const deptColorMap = useMemo(() => {
    const map = new Map<string, string>();
    catalog.groups.forEach((g, i) => map.set(g.name, DEPT_PALETTE[i % DEPT_PALETTE.length]));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog.groups]);
  const deptColor = (employee: Employee) => deptColorMap.get(employee.group) || employee.color || '#2c76dc';

  // 按部门分组展示（目录本身按分部排序，这里保序分桶）
  const groupedSections = useMemo(() => {
    const map = new Map<string, Employee[]>();
    for (const employee of filtered) {
      const g = employee.group || '其他';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(employee);
    }
    return [...map.entries()];
  }, [filtered]);

  const statusOptions = useMemo(
    () =>
      [...new Set(catalog.employees.map(employee => employee.status || '状态未知'))]
        .filter(Boolean)
        .sort()
        .map(value => ({ value, label: value })),
    [catalog.employees],
  );
  const coreCount = catalog.coreCount ?? catalog.employees.filter(employee => !employee.extension).length;
  const extensionCount = catalog.extensionCount ?? catalog.employees.filter(employee => employee.extension).length;
  const displayCount = (value: number) => (loading || loadError ? '—' : <AnimatedNumber value={value} />);

  const selectGroup = (value: string) => {
    setGroup(value);
    const next = new URLSearchParams(params);
    if (value === '全部分部') next.delete('group');
    else next.set('group', value);
    if (keyword.trim()) next.set('q', keyword.trim());
    else next.delete('q');
    setParams(next, { replace: true });
  };

  const selectStatus = (value: string) => {
    setStatusFilter(value);
    const next = new URLSearchParams(params);
    if (value) next.set('status', value);
    else next.delete('status');
    if (keyword.trim()) next.set('q', keyword.trim());
    else next.delete('q');
    setParams(next, { replace: true });
  };

  const openEmployee = (employee: Employee) => setSelected(employee);

  return (
    <div className="employee-page">
      <section className="employee-hero">
        <div className="employee-hero-copy">
          <div className="employee-kicker">
            <DeploymentUnitOutlined /> 纳米Work · 餐饮产业员工库
          </div>
          <h1>把经营问题，交给真正懂这一岗的人</h1>
          <p>从选址、菜单、食安到利润和连锁，核心岗位与超级店长扩展协同待命。先看清职责，再把任务派下去。</p>
        </div>
        <div className="employee-hero-stats">
          <div>
            <strong>{displayCount(coreCount)}</strong>
            <span>核心岗位</span>
          </div>
          <div>
            <strong>{displayCount(extensionCount)}</strong>
            <span>店长扩展</span>
          </div>
          <div>
            <strong>{displayCount(catalog.groups.length)}</strong>
            <span>专业分部</span>
          </div>
          <div>
            <strong>{displayCount(catalog.total)}</strong>
            <span>数字员工</span>
          </div>
        </div>
      </section>

      <section className="employee-toolbar" aria-label="筛选数字员工">
        <div className="employee-search">
          <SearchOutlined />
          <Input
            bordered={false}
            allowClear
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
            onPressEnter={() => {
              const next = new URLSearchParams(params);
              if (keyword.trim()) next.set('q', keyword.trim());
              else next.delete('q');
              setParams(next, { replace: true });
            }}
            placeholder="输入问题或岗位，例如：毛利、排班、外卖、选址"
            aria-label="搜索数字员工"
          />
        </div>
        <Select
          className="employee-status-filter"
          allowClear
          placeholder="全部状态"
          aria-label="按员工状态筛选"
          value={statusFilter || undefined}
          options={statusOptions}
          onChange={value => selectStatus(value || '')}
        />
        <div className="employee-filter-count">
          <FilterOutlined /> 已找到 <strong>{loading || loadError ? '—' : filtered.length}</strong> 位合适员工
        </div>
      </section>

      <nav className="employee-groups" aria-label="员工分部">
        <button className={group === '全部分部' ? 'active' : ''} onClick={() => selectGroup('全部分部')}>
          <AppstoreOutlined /> 全部分部 <span>{loading || loadError ? '—' : catalog.total}</span>
        </button>
        {catalog.groups.map(item => {
          const running = runningByGroup.get(item.name) || 0;
          return (
            <button
              key={item.name}
              className={group === item.name ? 'active' : ''}
              onClick={() => selectGroup(item.name)}
              title={running > 0 ? `${item.name}：${running} 个任务执行中` : undefined}
            >
              <i>{item.emoji || '•'}</i>
              {item.name.replace('部', '')}
              <span>{item.count}</span>
              {running > 0 && (
                <em className="group-live" aria-label={`${running} 个任务执行中`}>
                  {running}
                </em>
              )}
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
              <div
                className="employee-pulse-item"
                key={item.id}
                style={{ '--enter-delay': `${Math.min(index * 60, 360)}ms` } as CSSProperties}
              >
                <span className="employee-pulse-emoji" aria-hidden="true">
                  {item.emoji || '🤖'}
                </span>
                <span className="employee-pulse-dept">{item.marshal}</span>
                <span className="employee-pulse-title">{item.title}</span>
                <span
                  className={`employee-pulse-status s-${item.status === '生成中' ? 'run' : item.status === '待审阅' ? 'wait' : item.status === '已完成' ? 'done' : 'other'}`}
                >
                  {item.status === '生成中' ? (
                    <>
                      生成中
                      <span className="nw-typing">
                        <i />
                        <i />
                        <i />
                      </span>
                    </>
                  ) : (
                    item.status
                  )}
                </span>
                <time>{String(item.created_at || '').slice(5, 16)}</time>
              </div>
            ))}
          </div>
        </section>
      )}

      <Alert
        className="employee-origin"
        type="info"
        showIcon
        message="员工定义来自派活餐饮产业部岗位手册；历史测试输出未作为经营事实或知识答案导入。"
      />

      {loadError && (
        <Alert
          type="error"
          showIcon
          message="餐饮数字员工目录暂不可用"
          description={`${loadError}。页面不会用预设数字冒充实时目录。`}
          action={
            <Button size="small" onClick={loadCatalog}>
              重新读取
            </Button>
          }
        />
      )}

      {loading ? (
        <div className="employee-grid">
          {Array.from({ length: 12 }, (_, index) => (
            <div className="employee-card employee-card-loading" key={index}>
              <Skeleton active paragraph={{ rows: 3 }} />
            </div>
          ))}
        </div>
      ) : loadError ? null : filtered.length ? (
        <div aria-live="polite">
          {groupedSections.map(([groupName, members]) => (
            <section className="employee-dept-section" key={groupName} aria-label={groupName}>
              <header className="employee-dept-head">
                <strong>{groupName}</strong>
                <span className="employee-dept-count">{members.length} 位数字员工</span>
                {(runningByGroup.get(groupName) || 0) > 0 && (
                  <span className="employee-dept-running">
                    <i className="dot" aria-hidden="true" />
                    {runningByGroup.get(groupName)} 个任务执行中
                  </span>
                )}
                <i className="employee-dept-rule" aria-hidden="true" />
              </header>
              <div className="employee-grid">
                {members.map((employee, index) => (
                  <div
                    className={`employee-card nw-rise${employee.status === '执行中' ? ' busy' : ''}`}
                    style={{ '--enter-delay': `${Math.min(index * 35, 560)}ms` } as CSSProperties}
                    key={employee.idx}
                    onClick={() => openEmployee(employee)}
                    tabIndex={0}
                    role="button"
                    aria-label={`打开${employee.person || employee.name}的完整员工工作台`}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openEmployee(employee);
                      }
                    }}
                  >
                    {/* 工牌形制：挂绳孔 + 落款 + 工号 */}
                    <i className="badge-slot" aria-hidden="true" />
                    <div className="badge-brand" style={{ '--employee-color': deptColor(employee) } as CSSProperties}>
                      <span>纳米Work · 餐饮数字员工</span>
                      <b>№{String(employee.idx).padStart(3, '0')}</b>
                    </div>
                    <div className="employee-card-top">
                      <div
                        className={`employee-portrait${employee.status === '执行中' ? ' working' : ''}`}
                        style={{ '--employee-color': deptColor(employee) } as CSSProperties}
                      >
                        <EmployeeAvatar
                          idx={employee.idx}
                          name={employee.person || employee.name}
                          color={deptColor(employee)}
                          size={58}
                        />
                      </div>
                      <div className="employee-identity">
                        <div>
                          <strong>{employee.person || employee.name}</strong>
                          {employee.extension && <Tag color="blue">扩展</Tag>}
                        </div>
                        <span className="employee-title">{employee.name}</span>
                        <em className="employee-dept">{employee.group}</em>
                      </div>
                    </div>
                    <Tooltip
                      title={
                        employee.status === '执行中'
                          ? employee.currentTask
                            ? `正在执行：${employee.currentTask}`
                            : '正在执行任务，完成后会进入待审阅'
                          : employee.status === '空闲'
                            ? '在岗待命，可以立即派活'
                            : employee.status || '运行状态尚未上报'
                      }
                    >
                      <div
                        className={`employee-duty-line ${employee.status === '执行中' ? 'busy' : employee.status === '空闲' ? 'idle' : 'unknown'}`}
                      >
                        <i className="dot" aria-hidden="true" />
                        {employee.status === '执行中' ? (
                          <>
                            <span className="employee-duty-text">正在执行：{employee.currentTask || '任务生成中'}</span>
                            <span className="nw-typing">
                              <i />
                              <i />
                              <i />
                            </span>
                          </>
                        ) : employee.status === '空闲' ? (
                          <span className="employee-duty-text">在岗待命 · 24 小时可派活</span>
                        ) : (
                          <span className="employee-duty-text">运行状态待上报</span>
                        )}
                      </div>
                    </Tooltip>
                    <p>{employee.desc || employee.duty}</p>
                    <div className="employee-kpis">
                      {(employee.monthTasks || 0) > 0 ? (
                        <>
                          <b>{employee.monthTasks}</b> 单本月接活
                          <span className="employee-kpi-sep" />
                          <b>{employee.monthDone || 0}</b> 单已交付
                        </>
                      ) : (
                        <span className="employee-kpi-empty">本月还没接到活 · 派第一单给TA</span>
                      )}
                    </div>
                    <div className="employee-card-foot">
                      <span>
                        <FileDoneOutlined />{' '}
                        {(employee.deliverables || []).length
                          ? `${employee.deliverables!.length} 类交付`
                          : '交付清单待同步'}
                      </span>
                      <span className="employee-card-link">
                        查看档案 · 派活 <span>→</span>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Empty className="employee-empty" description="没有匹配的员工，换一个经营问题试试" />
      )}

      <EmployeeWorkbench
        open={!!selected}
        domain="restaurant"
        idx={selected?.idx ?? null}
        identityHint={
          selected
            ? {
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
              }
            : null
        }
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

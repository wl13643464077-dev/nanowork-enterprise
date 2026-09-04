import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Alert, Button, Empty, Input, Select, Skeleton, Tooltip } from 'antd';
import { AppstoreOutlined, FilterOutlined, SearchOutlined } from '@ant-design/icons';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { AnimatedNumber } from '../components/Kit';
import EmployeeAvatar from '../components/EmployeeAvatar';
import EmployeeTeamMatch, { type MatchedTeamMember } from '../components/EmployeeTeamMatch';
import EmployeeWorkbench from '../components/EmployeeWorkbench';
import './Employees.css';

type EmployeeBusiness = {
  intro: string;
  value: [number, number];
  typicalValue: number;
  unit: string;
  basis: string;
  reference: string;
  cost: {
    minCredits: number;
    maxCredits: number;
    minYuan: number;
    maxYuan: number;
    typicalCredits: number;
    typicalYuan: number;
    typicalBasis: string;
    note: string;
  };
};

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
  avatar?: string;
  business?: EmployeeBusiness | null;
  capabilityCount?: number;
  capabilityNames?: string[];
  skillCount?: number;
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
  // 自我介绍周校验状态：ok / needs_review / never（needs_review 时卡片显示角标）
  introCheckStatus?: 'ok' | 'needs_review' | 'never' | string;
};

// 目录数据里的输入/步骤/交付文案可能带Markdown记号（**加粗**、`代码`），
// 员工卡上必须显示纯文本，不能把星号原样露给老板。
const plainCatalogText = (value: unknown) =>
  String(value ?? '')
    .replace(/\*\*|__|[*`]/gu, '')
    .trim();

const fmtYuan = (value: number) =>
  value >= 10000 ? `${(value / 10000).toFixed(value % 10000 === 0 ? 0 : 1)}万` : value.toLocaleString();

type EmployeeCatalog = {
  total: number;
  coreCount?: number;
  extensionCount?: number;
  groups: { name: string; emoji?: string; color?: string; count: number }[];
  employees: Employee[];
};

function pulseDisplayStatus(item: any) {
  if (item?.displayStatus) return String(item.displayStatus);
  if (['生成中', '执行中'].includes(String(item?.status || ''))) return String(item.status);
  if (item?.status === '待审阅') return '待人工审阅';
  if (item?.status === '已完成') return '已自动采用（可用于业务）';
  if (item?.status === '已驳回') return '失败需返工（人工审阅未通过）';
  if (item?.status === '失败') return '失败需处理（执行异常）';
  return String(item?.status || '待处理');
}

function pulseStatusClass(item: any) {
  const status = pulseDisplayStatus(item);
  if (['生成中', '执行中'].includes(status)) return 'run';
  if (status.includes('待人工审阅')) return 'wait';
  if (status.includes('可用于业务')) return 'done';
  return 'other';
}

export default function Employees() {
  const [params, setParams] = useSearchParams();
  const [catalog, setCatalog] = useState<EmployeeCatalog>({ total: 0, groups: [], employees: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [keyword, setKeyword] = useState(params.get('q') || '');
  const [group, setGroup] = useState(params.get('group') || '全部分部');
  const [statusFilter, setStatusFilter] = useState(params.get('status') || '');
  const requestedEmployee = params.get('employee');
  const requestedTask = params.get('task');
  const requestedTaskId = /^\d+$/u.test(requestedTask || '') && Number(requestedTask) > 0 ? requestedTask : null;
  const selected = useMemo(() => {
    if (!/^\d+$/u.test(requestedEmployee || '')) return null;
    const employeeIdx = Number(requestedEmployee);
    if (!Number.isSafeInteger(employeeIdx) || employeeIdx < 101 || employeeIdx > 161) return null;
    return catalog.employees.find(item => item.idx === employeeIdx) || null;
  }, [catalog.employees, requestedEmployee]);

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
        api.get('/marshals/drill/tasks').catch(() => null),
      ]).then(([depts, tasks]: any[]) => {
        if (!active) return;
        const deptRows = Array.isArray(depts?.rows) ? depts.rows : [];
        const feedRows = Array.isArray(tasks?.rows) ? tasks.rows.slice(0, 7) : [];
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

  // 周校验通知深链 /employees?introCheck=needs_review：只看需要老板确认自我介绍的员工
  const introReviewOnly = params.get('introCheck') === 'needs_review';
  const filtered = useMemo(() => {
    const q = debouncedKeyword.trim().toLowerCase();
    return catalog.employees.filter(employee => {
      if (introReviewOnly && employee.introCheckStatus !== 'needs_review') return false;
      if (group !== '全部分部' && employee.group !== group) return false;
      if (statusFilter && (employee.status || '状态未知') !== statusFilter) return false;
      if (!q) return true;
      return [employee.person, employee.name, employee.duty, employee.desc, employee.group].some(value =>
        String(value || '')
          .toLowerCase()
          .includes(q),
      );
    });
  }, [catalog.employees, debouncedKeyword, group, introReviewOnly, statusFilter]);

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
  const runningCount = catalog.employees.filter(employee => employee.status === '执行中').length;
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

  // 「带原话派给TA」的一次性预填：打开工作台时把老板那句话填进派活框。
  const [dispatchPrefill, setDispatchPrefill] = useState<string | null>(null);

  const openEmployee = (employee: Employee, taskId?: string | number | null) => {
    setDispatchPrefill(null);
    const next = new URLSearchParams(params);
    next.set('employee', String(employee.idx));
    if (taskId == null || String(taskId).trim() === '') next.delete('task');
    else next.set('task', String(taskId));
    setParams(next, { replace: true });
  };

  const dispatchFromTeam = (member: MatchedTeamMember, query: string) => {
    setDispatchPrefill(query || null);
    const next = new URLSearchParams(params);
    next.set('employee', String(member.idx));
    next.delete('task');
    setParams(next, { replace: true });
  };

  const closeEmployee = () => {
    setDispatchPrefill(null);
    const next = new URLSearchParams(params);
    next.delete('employee');
    next.delete('task');
    setParams(next, { replace: true });
  };

  return (
    <div className="employee-page">
      <section className="employee-directory-head" aria-labelledby="employee-directory-title">
        <div className="employee-directory-copy">
          <div className="employee-kicker">
            <AppstoreOutlined /> 餐饮数字员工
          </div>
          <h1 id="employee-directory-title">选择数字员工</h1>
          <p>按经营问题找到对应岗位，一句话派活后即可查看进度、业务结果和真实费用。</p>
        </div>
        <dl className="employee-summary" aria-label="数字员工概况">
          <div>
            <dt>数字员工</dt>
            <dd>{displayCount(catalog.total)}</dd>
          </div>
          <div>
            <dt>专业分部</dt>
            <dd>{displayCount(catalog.groups.length)}</dd>
          </div>
          <div>
            <dt>执行中</dt>
            <dd>{displayCount(runningCount)}</dd>
          </div>
        </dl>
      </section>

      <EmployeeTeamMatch
        deptColorOf={member => deptColorMap.get(member.group) || member.color || '#2c76dc'}
        onDispatch={dispatchFromTeam}
        onOpenTask={(memberIdx, taskId) => {
          const employee = catalog.employees.find(item => item.idx === memberIdx);
          if (employee) openEmployee(employee, taskId);
        }}
      />

      <section className="employee-toolbar" aria-label="筛选数字员工">
        <div className="employee-search">
          <span className="employee-search-icon" aria-hidden="true">
            <SearchOutlined />
          </span>
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
            placeholder="搜经营问题或岗位：毛利、排班、外卖、选址…"
            aria-label="搜索数字员工"
          />
          <span className="employee-search-count" aria-live="polite">
            <FilterOutlined aria-hidden="true" />
            <strong>{loading || loadError ? '—' : filtered.length}</strong> 位匹配
          </span>
          <i className="employee-search-divider" aria-hidden="true" />
          <Select
            className="employee-status-filter"
            variant="borderless"
            allowClear
            placeholder="全部状态"
            aria-label="按员工状态筛选"
            value={statusFilter || undefined}
            options={statusOptions}
            onChange={value => selectStatus(value || '')}
          />
        </div>
      </section>

      <nav className="employee-groups" aria-label="员工分部">
        <button
          className={group === '全部分部' ? 'active' : ''}
          aria-pressed={group === '全部分部'}
          onClick={() => selectGroup('全部分部')}
        >
          <AppstoreOutlined /> 全部分部 <span>{loading || loadError ? '—' : catalog.total}</span>
        </button>
        {catalog.groups.map(item => {
          const running = runningByGroup.get(item.name) || 0;
          return (
            <button
              key={item.name}
              className={group === item.name ? 'active' : ''}
              aria-pressed={group === item.name}
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
        <details className="employee-disclosure employee-pulse">
          <summary>
            <span>任务动态</span>
            <small>{pulse.feed.length} 条更新 · 30 秒自动刷新</small>
          </summary>
          <div className="employee-pulse-feed">
            {pulse.feed.map((item: any) => (
              <button
                type="button"
                className="employee-pulse-item"
                key={item.id}
                aria-label={`打开${item.employee_name || item.marshal || '数字员工'}的任务「${item.title || item.id}」`}
                onClick={() => {
                  const employee = catalog.employees.find(row => row.idx === Number(item.employeeIdx));
                  if (employee) openEmployee(employee, item.id);
                }}
              >
                <span className="employee-pulse-emoji" aria-hidden="true">
                  {item.emoji || '🤖'}
                </span>
                <span className="employee-pulse-dept">{item.employee_name || item.marshal}</span>
                <span className="employee-pulse-title">{item.title}</span>
                <span className={`employee-pulse-status s-${pulseStatusClass(item)}`}>
                  {['生成中', '执行中'].includes(item.status) ? (
                    <>
                      {item.status}
                      <span className="nw-typing">
                        <i />
                        <i />
                        <i />
                      </span>
                    </>
                  ) : (
                    pulseDisplayStatus(item)
                  )}
                </span>
                <time>{String(item.created_at || '').slice(5, 16)}</time>
              </button>
            ))}
          </div>
        </details>
      )}

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
            <section
              className="employee-dept-section"
              key={groupName}
              aria-label={groupName}
              style={members[0] ? ({ '--dept': deptColor(members[0]) } as CSSProperties) : undefined}
            >
              <header className="employee-dept-head">
                <i className="employee-dept-mark" aria-hidden="true" />
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
                {members.map(employee => (
                  <article
                    className={`employee-card${employee.status === '执行中' ? ' busy' : ''}`}
                    key={employee.idx}
                    style={{ '--dept': deptColor(employee) } as CSSProperties}
                  >
                    <header className="employee-card-head">
                      <EmployeeAvatar
                        idx={employee.idx}
                        name={employee.person || employee.name}
                        color={deptColor(employee)}
                        size={52}
                      />
                      <div className="employee-identity">
                        <h2>{employee.person || employee.name}</h2>
                        <span>{employee.name}</span>
                        <small>
                          #{employee.idx} · {employee.group}
                        </small>
                        {employee.introCheckStatus === 'needs_review' && (
                          <Tooltip title="每周自我介绍校验发现需要老板确认的地方，点击查看">
                            <Link
                              className="employee-intro-flag"
                              to={`/employees/restaurant/${employee.idx}/intro`}
                              aria-label={`${employee.person || employee.name}的自我介绍需要确认`}
                            >
                              <i aria-hidden="true" />
                              介绍待确认
                            </Link>
                          </Tooltip>
                        )}
                      </div>
                      <Tooltip
                        title={
                          employee.status === '执行中'
                            ? employee.currentTask
                              ? `正在执行：${employee.currentTask}`
                              : '正在执行任务，完成后进入结果与费用页'
                            : employee.status === '空闲'
                              ? '在岗待命，可以立即派活'
                              : employee.status || '运行状态尚未上报'
                        }
                      >
                        <span
                          className={`employee-status ${employee.status === '执行中' ? 'busy' : employee.status === '空闲' ? 'idle' : 'unknown'}`}
                        >
                          <i aria-hidden="true" />
                          {employee.status === '执行中' ? '工作中' : employee.status || '状态未知'}
                        </span>
                      </Tooltip>
                    </header>
                    <p className="employee-duty">
                      {plainCatalogText(employee.business?.intro || employee.intro || employee.duty || employee.desc)}
                    </p>
                    {(employee.capabilityCount || employee.skillCount || null) && (
                      <button
                        type="button"
                        className="employee-powers"
                        aria-label={`查看${employee.person || employee.name}的完整能力与技能`}
                        title="点击打开工作台查看完整能力与技能"
                        onClick={() => openEmployee(employee)}
                      >
                        <span className="employee-powers-count">
                          能力 {employee.capabilityCount || 0} · 技能 {employee.skillCount || 0}
                        </span>
                        {(employee.capabilityNames || []).slice(0, 2).map(name => (
                          <em key={name}>{name}</em>
                        ))}
                      </button>
                    )}
                    {employee.status === '执行中' && (
                      <div className="employee-current-action" role="status">
                        <span className="employee-current-action-pulse" aria-hidden="true" />
                        <span>
                          {employee.currentTask
                            ? `当前：${employee.currentTask}`
                            : '当前：正在读取任务并执行岗位工作流'}
                        </span>
                      </div>
                    )}
                    {employee.business && (
                      <Tooltip
                        title={`${employee.business.basis} 参考区间 ¥${fmtYuan(employee.business.value[0])}–${fmtYuan(employee.business.value[1])}${employee.business.unit.replace('元', '')}。${employee.business.cost.typicalBasis}；${employee.business.cost.note} ${employee.business.reference}`}
                      >
                        <div className="employee-roi" aria-label="投入产出参考">
                          <span className="employee-roi-cost">约 {employee.business.cost.typicalCredits} 积分/次</span>
                          <span className="employee-roi-arrow" aria-hidden="true">
                            →
                          </span>
                          <span className="employee-roi-value">
                            参考价值 约¥{fmtYuan(employee.business.typicalValue)}
                            <i>{employee.business.unit.replace('元', '')}</i>
                          </span>
                        </div>
                      </Tooltip>
                    )}
                    <Button
                      type="primary"
                      block
                      onClick={() => openEmployee(employee)}
                      aria-label={`打开${employee.person || employee.name}的工作台`}
                    >
                      打开工作台 · 派活
                    </Button>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Empty className="employee-empty" description="没有匹配的员工，换一个经营问题试试" />
      )}

      <details className="employee-disclosure employee-origin">
        <summary>
          <span>员工档案说明</span>
          <small>查看来源与数据边界</small>
        </summary>
        <p>员工定义来自派活餐饮产业部岗位手册；历史测试输出未作为经营事实或知识答案导入。</p>
      </details>

      <EmployeeWorkbench
        open={!!selected}
        domain="restaurant"
        idx={selected?.idx ?? null}
        initialTaskId={requestedTaskId}
        initialDirective={selected ? dispatchPrefill : null}
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
                avatar: selected.avatar,
                business: selected.business,
              }
            : null
        }
        onClose={closeEmployee}
      />
    </div>
  );
}

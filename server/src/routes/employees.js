import { Router } from 'express';
import { curTenant, q } from '../db.js';
import { monthStart } from '../util.js';
import { userScopeClause } from '../engines/access.js';

const r = Router();
const ALLOWED_STATUS = new Set(['空闲', '执行中']);
const CURRENT_DEPARTMENT_CODES = Object.freeze(Array.from(
  { length: 8 }, (_, index) => `M-${String(index + 1).padStart(2, '0')}`,
));
const CURRENT_DEPARTMENT_SQL = CURRENT_DEPARTMENT_CODES.map(() => '?').join(',');

function parseProfile(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toEmployee(row) {
  const profile = parseProfile(row.profile_json);
  return {
    idx: row.employee_idx,
    key: row.key,
    person: row.person,
    name: row.name,
    duty: row.duty,
    desc: row.description,
    group: row.group_name,
    emoji: row.emoji,
    color: profile.color || '',
    inputs: Array.isArray(profile.inputs) ? profile.inputs : [],
    steps: Array.isArray(profile.steps) ? profile.steps : [],
    deliverables: Array.isArray(profile.deliverables) ? profile.deliverables : [],
    intro: typeof profile.intro === 'string' ? profile.intro : '',
    status: row.runtime_status,
    monthTasks: Number(row.month_tasks) || 0,
    monthDone: Number(row.month_done) || 0,
    marshalId: row.marshal_id,
    specialistId: row.id,
    groupEmoji: row.group_emoji || '',
    extension: profile.extension === true,
  };
}

function visibleEmployees(req) {
  const taskScope = userScopeClause(req.user, 't.created_by');
  return q.all(`SELECT s.*,
    CASE WHEN EXISTS(
      SELECT 1 FROM agent_tasks t
      WHERE t.tenant_id=? AND t.specialist_id=s.id
        AND t.status IN ('生成中','执行中')${taskScope.sql}
    ) THEN '执行中' ELSE '空闲' END runtime_status,
    (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id=? AND t.specialist_id=s.id AND t.created_at>=?${taskScope.sql}) month_tasks,
    (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id=? AND t.specialist_id=s.id AND t.created_at>=? AND t.status='已完成'${taskScope.sql}) month_done,
    m.sort group_sort,m.emoji group_emoji
    FROM specialists s
    JOIN marshals m ON m.id=s.marshal_id
    WHERE m.code IN (${CURRENT_DEPARTMENT_SQL})
      AND s.employee_idx BETWEEN 101 AND 160
    ORDER BY m.sort,s.sort,s.employee_idx`,
  curTenant(), ...taskScope.params,
  curTenant(), monthStart(), ...taskScope.params,
  curTenant(), monthStart(), ...taskScope.params,
  ...CURRENT_DEPARTMENT_CODES)
    .map(toEmployee);
}

function textFilter(employees, query) {
  if (!query) return employees;
  const needle = query.toLocaleLowerCase('zh-CN');
  return employees.filter(employee => [
    employee.idx, employee.key, employee.person, employee.name, employee.duty,
    employee.desc, employee.group, employee.intro,
  ].some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(needle)));
}

function filters(req, res) {
  const group = typeof req.query.group === 'string' ? req.query.group.trim() : '';
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  if (group.length > 80) {
    res.status(400).json({ error: '分部筛选条件不能超过80字' });
    return null;
  }
  if (query.length > 100) {
    res.status(400).json({ error: '搜索内容不能超过100字' });
    return null;
  }
  if (status && !ALLOWED_STATUS.has(status)) {
    res.status(400).json({ error: '状态筛选仅支持“空闲”或“执行中”' });
    return null;
  }
  return { group, query, status };
}

r.get('/', (req, res) => {
  const selected = filters(req, res);
  if (!selected) return;
  const all = visibleEmployees(req);
  const searched = textFilter(all, selected.query).filter(employee => !selected.status || employee.status === selected.status);
  const employees = searched.filter(employee => !selected.group || employee.group === selected.group);
  const groupMeta = new Map(all.map(employee => [employee.group, { emoji: employee.groupEmoji, color: employee.color }]));
  const groups = [...groupMeta.entries()].map(([name, meta]) => ({
    name,
    emoji: meta.emoji,
    color: meta.color,
    count: searched.filter(employee => employee.group === name).length,
  }));
  res.set('Cache-Control', 'private, no-store');
  res.json({
    total: employees.length,
    coreCount: employees.filter(employee => !employee.extension).length,
    extensionCount: employees.filter(employee => employee.extension).length,
    groups,
    employees: employees.map(({ groupEmoji: _groupEmoji, ...employee }) => employee),
  });
});

r.get('/:idx', (req, res) => {
  const identifier = String(req.params.idx || '').trim();
  if (!identifier || identifier.length > 100) return res.status(404).json({ error: '数字员工不存在' });
  const employee = visibleEmployees(req).find(item => String(item.idx) === identifier || item.key === identifier);
  if (!employee) return res.status(404).json({ error: '数字员工不存在' });
  const { groupEmoji: _groupEmoji, ...payload } = employee;
  res.set('Cache-Control', 'private, no-store');
  res.json(payload);
});

export default r;

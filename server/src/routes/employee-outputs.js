import { Router } from 'express';
import { curTenant, getTenant, q } from '../db.js';
import { userScopeClause } from '../engines/access.js';
import { daysAgo, safeJsonParse, today } from '../util.js';
import { contentEmployeeByIdx } from '../catalog/content-crew.js';

const r = Router();

const SOURCE_LABELS = {
  task: '数字员工任务',
  tool: '经营工具',
  content: '内容生产仓',
  content_solo: '内容员工单独派活',
};
const DOMAIN_LABELS = {
  restaurant: '餐饮数字员工',
  tool: '餐饮经营工具',
  content: 'Paihuo内容生产部',
};

const DIMENSIONS = new Set(['domain', 'group', 'employee', 'source', 'status']);
const SOURCES = new Set(['all', 'task', 'tool', 'content', 'content_solo']);
const DOMAINS = new Set(['all', 'restaurant', 'tool', 'content']);

function fail(res, message) {
  res.status(400).json({ error: message });
  return null;
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function parseQuery(req, res) {
  const start = String(req.query.start || daysAgo(29));
  const end = String(req.query.end || today());
  const group = String(req.query.group || '').trim();
  const employee = String(req.query.employee || '').trim();
  const domain = String(req.query.domain || 'all').trim();
  const source = String(req.query.source || 'all').trim();
  const status = String(req.query.status || '').trim();
  const dimension = String(req.query.dimension || 'employee').trim();
  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(5, Number.parseInt(String(req.query.pageSize || '20'), 10) || 20));

  if (!isIsoDate(start) || !isIsoDate(end) || start > end) {
    return fail(res, '时间范围不正确');
  }
  if (group.length > 80 || employee.length > 100 || status.length > 40) {
    return fail(res, '筛选条件过长');
  }
  if (!SOURCES.has(source)) return fail(res, '来源筛选不正确');
  if (!DOMAINS.has(domain)) return fail(res, '能力域筛选不正确');
  if (!DIMENSIONS.has(dimension)) return fail(res, '透视维度不正确');
  return { start, end, group, employee, domain, source, status, dimension, page, pageSize };
}

function isCompleted(status) {
  return ['已完成', '成功', '已采纳', '可使用', '已发布'].includes(String(status || ''));
}

function isFailed(status) {
  return ['失败', '已驳回'].includes(String(status || ''));
}

function toolStatusLabel(status) {
  return ({ done: '已完成', running: '执行中', failed: '失败' })[status] || String(status || '未知');
}

function taskRows(req, filters) {
  const scope = userScopeClause(req.user, 't.created_by');
  return q.all(`SELECT
      t.id, t.title, t.status, t.type, t.created_at, t.output_id,
      t.created_by, u.name operator_name,
      m.id marshal_id, m.name marshal_name,
      s.id specialist_id, s.employee_idx, s.key employee_key,
      s.name employee_name, s.person employee_person,
      COALESCE(s.group_name, m.name) group_name,
      c.status output_status,
      CASE WHEN c.id IS NULL THEN 0 ELSE 1 END has_output
    FROM agent_tasks t
    JOIN marshals m ON m.id=t.marshal_id
    LEFT JOIN specialists s ON s.id=t.specialist_id AND s.marshal_id=t.marshal_id
    LEFT JOIN contents c ON c.id=t.output_id AND c.tenant_id=t.tenant_id
    LEFT JOIN users u ON u.id=t.created_by AND u.tenant_id=t.tenant_id
    WHERE t.tenant_id=?
      AND t.created_at BETWEEN ? AND ? || ' 23:59:59'
      ${scope.sql}
    ORDER BY t.created_at DESC, t.id DESC`, curTenant(), filters.start, filters.end, ...scope.params)
    .map(row => ({
      id: Number(row.id),
      ref: `task:${row.id}`,
      source: 'task',
      sourceLabel: SOURCE_LABELS.task,
      abilityDomain: 'restaurant',
      abilityDomainLabel: DOMAIN_LABELS.restaurant,
      title: row.title || '未命名员工任务',
      status: row.status || '未知',
      outputStatus: row.output_status || '',
      hasOutput: Boolean(row.has_output),
      createdAt: row.created_at,
      group: row.group_name || row.marshal_name || '未分组',
      employeeIdx: row.employee_idx == null ? null : Number(row.employee_idx),
      employeeKey: row.employee_key || '',
      employee: row.employee_name || row.marshal_name || '分部协同',
      person: row.employee_person || '',
      operator: row.operator_name || '-',
      evidenceKind: row.has_output ? '运行产出' : '运行状态',
      evidenceLabel: row.has_output ? `内容记录 #${row.output_id}` : `任务记录 #${row.id}`,
      evidenceId: row.output_id || row.id,
      type: row.type || '常规',
    }));
}

function tableExists(name) {
  return Boolean(q.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
}

function toolRows(req, filters) {
  // tool_runs 由经营工具模块创建。并行升级或旧库尚未迁移时，分析页仍可安全展示员工任务。
  if (!tableExists('tool_runs')) return [];
  const scope = userScopeClause(req.user, 'tr.created_by');
  return q.all(`SELECT
      tr.id, tr.tool_key, tr.tool_title, tr.title, tr.status,
      tr.employee_idx, tr.employee_name, tr.specialist_id,
      tr.created_by, tr.result_md, tr.created_at,
      u.name operator_name,
      s.key employee_key, s.person employee_person,
      COALESCE(s.group_name,m.name,'经营工具协同') group_name,
      CASE WHEN length(trim(COALESCE(tr.result_md,''))) > 0 THEN 1 ELSE 0 END has_output
    FROM tool_runs tr
    LEFT JOIN specialists s ON s.id=tr.specialist_id
    LEFT JOIN marshals m ON m.id=s.marshal_id
    LEFT JOIN users u ON u.id=tr.created_by AND u.tenant_id=tr.tenant_id
    WHERE tr.tenant_id=?
      AND tr.created_at BETWEEN ? AND ? || ' 23:59:59'
      ${scope.sql}
    ORDER BY tr.created_at DESC, tr.id DESC`, curTenant(), filters.start, filters.end, ...scope.params)
    .map(row => ({
      id: Number(row.id),
      ref: `tool:${row.id}`,
      source: 'tool',
      sourceLabel: SOURCE_LABELS.tool,
      abilityDomain: 'tool',
      abilityDomainLabel: DOMAIN_LABELS.tool,
      title: row.title || row.tool_title || '未命名工具运行',
      status: toolStatusLabel(row.status),
      outputStatus: toolStatusLabel(row.status),
      hasOutput: Boolean(row.has_output),
      createdAt: row.created_at,
      group: row.group_name || '经营工具协同',
      employeeIdx: row.employee_idx == null ? null : Number(row.employee_idx),
      employeeKey: row.employee_key || '',
      employee: row.employee_name || '未指定数字员工',
      person: row.employee_person || '',
      operator: row.operator_name || '-',
      evidenceKind: row.has_output ? '工具运行结果' : '工具运行状态',
      evidenceLabel: `工具运行 #${row.id}`,
      evidenceId: row.id,
      type: row.tool_title || row.tool_key || '经营工具',
    }));
}

function contentRows(req, filters) {
  const contentScope = userScopeClause(req.user, 'c.creator_id');
  const mediaScope = userScopeClause(req.user, 'j.user_id');
  const outputs = q.all(`SELECT
      c.id, c.type, c.title, c.topic, c.status, c.body, c.ai_mode, c.created_at,
      c.content_employee_idx, c.content_employee_key, c.content_employee_name,
      c.content_employee_group, c.content_run_mode,
      u.name operator_name
    FROM contents c
    LEFT JOIN users u ON u.id=c.creator_id AND u.tenant_id=c.tenant_id
    WHERE c.tenant_id=? AND c.content_employee_idx IS NOT NULL
      AND c.created_at BETWEEN ? AND ? || ' 23:59:59'${contentScope.sql}
    ORDER BY c.created_at DESC,c.id DESC`, curTenant(), filters.start, filters.end, ...contentScope.params)
    .map(row => {
      const catalogEmployee = contentEmployeeByIdx(Number(row.content_employee_idx));
      return {
        id: `output-${row.id}`,
        ref: `content:output:${row.id}`,
        source: 'content',
        sourceLabel: SOURCE_LABELS.content,
        abilityDomain: 'content',
        abilityDomainLabel: DOMAIN_LABELS.content,
        domain: 'content_output',
        domainLabel: '内容成品',
        title: row.title || row.topic || `内容#${row.id}`,
        status: row.status || '未知',
        outputStatus: row.status || '',
        hasOutput: Boolean(String(row.body || '').trim()),
        createdAt: row.created_at,
        group: row.content_employee_group || catalogEmployee?.group || '内容生产部',
        employeeIdx: Number(row.content_employee_idx),
        employeeKey: row.content_employee_key || catalogEmployee?.key || '',
        employee: row.content_employee_name || catalogEmployee?.name || '内容员工',
        person: null,
        operator: row.operator_name || '-',
        evidenceKind: '单工位内容产出',
        evidenceLabel: `内容记录 #${row.id}`,
        evidenceId: row.id,
        type: row.type || '内容成品',
        executionMode: row.content_run_mode || 'single_station',
      };
    });

  const media = q.all(`SELECT
      j.id, j.kind, j.prompt, j.status, j.url, j.error, j.created_at,
      j.content_employee_idx, j.content_employee_key, j.content_employee_name,
      j.content_employee_group, j.content_run_mode,
      u.name operator_name
    FROM media_jobs j
    LEFT JOIN users u ON u.id=j.user_id AND u.tenant_id=j.tenant_id
    WHERE j.tenant_id=? AND j.content_employee_idx IS NOT NULL
      AND j.kind IN ('image','video')
      AND j.created_at BETWEEN ? AND ? || ' 23:59:59'${mediaScope.sql}
    ORDER BY j.created_at DESC,j.id DESC`, curTenant(), filters.start, filters.end, ...mediaScope.params)
    .map(row => {
      const catalogEmployee = contentEmployeeByIdx(Number(row.content_employee_idx));
      return {
        id: `media-${row.id}`,
        ref: `content:media:${row.id}`,
        source: 'content',
        sourceLabel: SOURCE_LABELS.content,
        abilityDomain: 'content',
        abilityDomainLabel: DOMAIN_LABELS.content,
        domain: 'content_media',
        domainLabel: row.kind === 'video' ? '视频任务' : '图片任务',
        title: String(row.prompt || '').slice(0, 80) || `${row.kind === 'video' ? '视频' : '图片'}任务#${row.id}`,
        status: row.status || '未知',
        outputStatus: row.status || '',
        hasOutput: row.status === '成功' && Boolean(row.url),
        createdAt: row.created_at,
        group: row.content_employee_group || catalogEmployee?.group || '内容生产部',
        employeeIdx: Number(row.content_employee_idx),
        employeeKey: row.content_employee_key || catalogEmployee?.key || '',
        employee: row.content_employee_name || catalogEmployee?.name || '内容员工',
        person: null,
        operator: row.operator_name || '-',
        evidenceKind: row.status === '成功' ? '单工位媒体产出' : '媒体运行状态',
        evidenceLabel: `媒体任务 #${row.id}`,
        evidenceId: row.id,
        type: row.kind === 'video' ? 'AI视频' : 'AI图片',
        executionMode: row.content_run_mode || 'single_station',
      };
    });
  return [...outputs, ...media];
}

function contentSoloEvidence(status, hasOutput) {
  if (hasOutput) return '内容员工单独派活产出';
  if (status === '失败') return '内容员工运行失败';
  return '内容员工运行状态';
}

function contentSoloRows(req, filters) {
  // 老版本数据库可能还没有该表；聚合页必须继续服务已有任务、工具与内容成品。
  if (!tableExists('content_employee_runs')) return [];
  const scope = userScopeClause(req.user, 'cer.created_by');
  return q.all(`SELECT
      cer.id,cer.employee_idx,cer.employee_key,cer.employee_name,cer.employee_group,
      cer.title,cer.type,cer.status,cer.result_md,cer.ai_mode,cer.model,
      cer.profile_version,cer.prompt_hash,cer.created_at,cer.updated_at,
      u.name operator_name,
      CASE WHEN length(trim(COALESCE(cer.result_md,''))) > 0 THEN 1 ELSE 0 END has_output
    FROM content_employee_runs cer
    LEFT JOIN users u ON u.id=cer.created_by AND u.tenant_id=cer.tenant_id
    WHERE cer.tenant_id=?
      AND cer.created_at BETWEEN ? AND ? || ' 23:59:59'
      ${scope.sql}
    ORDER BY cer.created_at DESC,cer.id DESC`,
  curTenant(), filters.start, filters.end, ...scope.params)
    .map(row => {
      const hasOutput = Boolean(row.has_output);
      return {
        id: Number(row.id),
        ref: `content_solo:${row.id}`,
        source: 'content_solo',
        sourceLabel: SOURCE_LABELS.content_solo,
        abilityDomain: 'content',
        abilityDomainLabel: DOMAIN_LABELS.content,
        domain: 'content_solo',
        domainLabel: '内容员工单独派活',
        title: row.title || `内容员工派活 #${row.id}`,
        status: row.status || '未知',
        outputStatus: hasOutput ? row.status || '' : '',
        hasOutput,
        createdAt: row.created_at,
        group: row.employee_group || 'Paihuo内容生产部',
        employeeIdx: row.employee_idx == null ? null : Number(row.employee_idx),
        employeeKey: row.employee_key || '',
        employee: row.employee_name || '内容员工',
        person: null,
        operator: row.operator_name || '-',
        evidenceKind: contentSoloEvidence(row.status, hasOutput),
        evidenceLabel: `内容员工运行 #${row.id}`,
        evidenceId: row.id,
        type: row.type || '岗位交付',
        executionMode: 'single_user',
        profileVersion: row.profile_version || '',
        promptHash: row.prompt_hash || '',
      };
    });
}

function matches(row, filters) {
  if (filters.domain !== 'all' && row.abilityDomain !== filters.domain) return false;
  if (filters.group && row.group !== filters.group) return false;
  if (filters.employee && ![row.employeeIdx, row.employeeKey, row.employee]
    .some(value => String(value ?? '') === filters.employee)) return false;
  if (filters.status && row.status !== filters.status) return false;
  return true;
}

function dimensionValue(row, dimension) {
  if (dimension === 'domain') return row.abilityDomainLabel || '未分类能力域';
  if (dimension === 'group') return row.group || '未分组';
  if (dimension === 'source') return row.sourceLabel;
  if (dimension === 'status') return row.status || '未知';
  return row.employeeIdx != null ? `${row.employeeIdx} · ${row.employee}` : row.employee;
}

function pivotRows(rows, dimension) {
  const buckets = new Map();
  for (const row of rows) {
    const label = dimensionValue(row, dimension);
    const item = buckets.get(label) || {
      key: label,
      label,
      total: 0,
      withOutput: 0,
      completed: 0,
      pending: 0,
      failed: 0,
    };
    item.total += 1;
    if (row.hasOutput) item.withOutput += 1;
    if (isCompleted(row.status)) item.completed += 1;
    else if (isFailed(row.status)) item.failed += 1;
    else item.pending += 1;
    buckets.set(label, item);
  }
  return [...buckets.values()]
    .map(item => ({
      ...item,
      outputRate: item.total ? Math.round((item.withOutput / item.total) * 1000) / 10 : 0,
      completionRate: item.total ? Math.round((item.completed / item.total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.total - a.total || String(a.label).localeCompare(String(b.label), 'zh-CN'));
}

function filterOptions(rows) {
  const uniq = values => [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
  const employees = new Map();
  for (const row of rows) {
    const value = row.employeeIdx != null ? String(row.employeeIdx) : (row.employeeKey || row.employee);
    const label = row.employeeIdx != null ? `${row.employeeIdx} · ${row.employee}` : row.employee;
    if (value && !employees.has(value)) employees.set(value, { value, label, group: row.group });
  }
  return {
    domains: Object.entries(DOMAIN_LABELS).map(([value, label]) => ({ value, label })),
    groups: uniq(rows.map(row => row.group)),
    employees: [...employees.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')),
    statuses: uniq(rows.map(row => row.status)),
    sources: Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label })),
  };
}

r.get('/', (req, res) => {
  const filters = parseQuery(req, res);
  if (!filters) return;

  let all = [];
  if (filters.source === 'all' || filters.source === 'task') all.push(...taskRows(req, filters));
  if (filters.source === 'all' || filters.source === 'tool') all.push(...toolRows(req, filters));
  if (filters.source === 'all' || filters.source === 'content') all.push(...contentRows(req, filters));
  if (filters.source === 'all' || filters.source === 'content_solo') all.push(...contentSoloRows(req, filters));
  all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.ref).localeCompare(String(a.ref)));
  const options = filterOptions(all);
  const rows = all.filter(row => matches(row, filters));
  const offset = (filters.page - 1) * filters.pageSize;
  const summary = {
    total: rows.length,
    withOutput: rows.filter(row => row.hasOutput).length,
    completed: rows.filter(row => isCompleted(row.status)).length,
    pending: rows.filter(row => !isCompleted(row.status) && !isFailed(row.status)).length,
    failed: rows.filter(row => isFailed(row.status)).length,
  };
  const tenant = getTenant(curTenant());
  const isDemoEnvironment = tenant?.data_mode === 'demo';

  res.set('Cache-Control', 'private, no-store');
  res.json({
    range: { start: filters.start, end: filters.end },
    dimension: filters.dimension,
    filters: {
      domain: filters.domain,
      group: filters.group,
      employee: filters.employee,
      source: filters.source,
      status: filters.status,
    },
    dataset: {
      kind: isDemoEnvironment ? '当前环境待核验运行记录' : '当前企业运行记录',
      isDemoEnvironment,
      store: { id: curTenant(), name: tenant?.name || `门店 ${curTenant()}`, fixedToCurrentTenant: true },
      disclaimer: '数字员工任务、经营工具、内容生产仓与内容员工单独派活记录只证明对应单次能力已运行，不代表十工位流水线已自动执行，也不代表营业额、利润或客户转化已经提升；经营成效需继续与订单、会员等事实表核验。',
    },
    calculation: {
      unit: '一条持久化运行记录',
      outputRate: '已有可查看产出的记录数 ÷ 当前筛选后的运行记录数',
      completionRate: '已完成、成功、已采纳、可使用或已发布的记录数 ÷ 当前筛选后的运行记录数',
      effectBoundary: '本透视不做营业额、利润、订单或顾客转化归因。',
    },
    summary,
    options,
    pivot: pivotRows(rows, filters.dimension),
    rows: rows.slice(offset, offset + filters.pageSize),
    pagination: { page: filters.page, pageSize: filters.pageSize, total: rows.length },
  });
});

r.get('/drill/task/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: '运行记录不存在' });
  const scope = userScopeClause(req.user, 't.created_by');
  const row = q.get(`SELECT
      t.id, t.title, t.type, t.requirement, t.status, t.created_at, t.due_at,
      t.is_collab, t.collab_marshals, t.output_id,
      t.employee_profile_version,t.employee_prompt_hash,
      t.employee_capabilities_snapshot,t.employee_config_snapshot,t.employee_skills_snapshot,
      t.employee_input_snapshot,t.employee_web_snapshot,
      m.name marshal_name,
      s.employee_idx, s.key employee_key, s.name employee_name,
      s.person employee_person, COALESCE(s.group_name,m.name) group_name,
      u.name operator_name,
      c.title output_title, c.body output_body, c.status output_status,
      c.risk_level, c.risk_flags, c.ai_mode
    FROM agent_tasks t
    JOIN marshals m ON m.id=t.marshal_id
    LEFT JOIN specialists s ON s.id=t.specialist_id AND s.marshal_id=t.marshal_id
    LEFT JOIN users u ON u.id=t.created_by AND u.tenant_id=t.tenant_id
    LEFT JOIN contents c ON c.id=t.output_id AND c.tenant_id=t.tenant_id
    WHERE t.tenant_id=? AND t.id=?${scope.sql}`, curTenant(), id, ...scope.params);
  if (!row) return res.status(404).json({ error: '运行记录不存在或无权查看' });
  const canViewPrompt = ['boss', 'admin', 'platform_super'].includes(req.user?.role);
  const skills = safeJsonParse(row.employee_skills_snapshot, []);
  const safeSkills = canViewPrompt
    ? skills
    : skills.map(({ instructions: _instructions, ...skill }) => skill);
  res.set('Cache-Control', 'private, no-store');
  res.json({
    source: 'task',
    sourceLabel: SOURCE_LABELS.task,
    evidenceKind: row.output_id ? '运行产出' : '运行状态',
    record: {
      id: row.id,
      title: row.title,
      type: row.type || '常规',
      status: row.status,
      createdAt: row.created_at,
      dueAt: row.due_at,
      group: row.group_name,
      employeeIdx: row.employee_idx,
      employeeKey: row.employee_key,
      employee: row.employee_name || row.marshal_name,
      person: row.employee_person || '',
      operator: row.operator_name || '-',
      requirement: row.requirement || '',
      collaboration: row.is_collab ? String(row.collab_marshals || '').split(',').filter(Boolean) : [],
    },
    output: row.output_id ? {
      id: row.output_id,
      title: row.output_title,
      body: row.output_body || '',
      status: row.output_status,
      aiMode: row.ai_mode,
      riskLevel: row.risk_level || 'none',
      riskFlags: safeJsonParse(row.risk_flags, []),
    } : null,
    execution: row.employee_profile_version ? {
      profileVersion: row.employee_profile_version,
      promptHash: row.employee_prompt_hash || '',
      snapshot: {
        capabilities: safeJsonParse(row.employee_capabilities_snapshot, []),
        workConfig: safeJsonParse(row.employee_config_snapshot, {}),
        skills: safeSkills,
        inputEvidence: safeJsonParse(row.employee_input_snapshot, null),
        webEvidence: safeJsonParse(row.employee_web_snapshot, null),
      },
    } : null,
    disclaimer: '本页是可追溯的系统运行证据，不把内容产出推断为真实经营成效。',
  });
});

r.get('/drill/tool/:id', (req, res) => {
  if (!tableExists('tool_runs')) return res.status(404).json({ error: '工具运行记录不存在' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: '工具运行记录不存在' });
  const scope = userScopeClause(req.user, 'tr.created_by');
  const row = q.get(`SELECT
      tr.id, tr.tool_key, tr.tool_title, tr.title, tr.status,
      tr.employee_idx, tr.employee_name, tr.specialist_id,
      tr.input_json, tr.input_summary, tr.result_md,
      tr.assumptions_json, tr.evidence_json, tr.provenance_json,
      tr.created_at, tr.updated_at,
      u.name operator_name,
      s.key employee_key, s.person employee_person,
      COALESCE(s.group_name,m.name,'经营工具协同') group_name
    FROM tool_runs tr
    LEFT JOIN specialists s ON s.id=tr.specialist_id
    LEFT JOIN marshals m ON m.id=s.marshal_id
    LEFT JOIN users u ON u.id=tr.created_by AND u.tenant_id=tr.tenant_id
    WHERE tr.tenant_id=? AND tr.id=?${scope.sql}`, curTenant(), id, ...scope.params);
  if (!row) return res.status(404).json({ error: '工具运行记录不存在或无权查看' });
  res.set('Cache-Control', 'private, no-store');
  res.json({
    source: 'tool',
    sourceLabel: SOURCE_LABELS.tool,
    evidenceKind: row.result_md ? '工具运行结果' : '工具运行状态',
    record: {
      id: row.id,
      title: row.title || row.tool_title,
      type: row.tool_title || row.tool_key,
      toolKey: row.tool_key,
      status: toolStatusLabel(row.status),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      group: row.group_name,
      employeeIdx: row.employee_idx,
      employeeKey: row.employee_key,
      employee: row.employee_name || '未指定数字员工',
      person: row.employee_person || '',
      operator: row.operator_name || '-',
      inputSummary: row.input_summary || '',
      inputs: safeJsonParse(row.input_json, {}),
    },
    output: row.result_md ? {
      body: row.result_md,
      assumptions: safeJsonParse(row.assumptions_json, []),
      evidence: safeJsonParse(row.evidence_json, []),
      provenance: safeJsonParse(row.provenance_json, {}),
    } : null,
    disclaimer: '本页是可追溯的系统运行证据；假设、输入与模板生成结果不等同于真实经营成效。',
  });
});

r.get('/drill/content_solo/:id', (req, res) => {
  if (!tableExists('content_employee_runs')) {
    return res.status(404).json({ error: '内容员工运行记录不存在' });
  }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(404).json({ error: '内容员工运行记录不存在' });
  }
  const scope = userScopeClause(req.user, 'cer.created_by');
  const row = q.get(`SELECT
      cer.id,cer.employee_idx,cer.employee_key,cer.employee_name,cer.employee_group,
      cer.title,cer.type,cer.requirement,cer.due_at,cer.status,cer.result_md,
      cer.ai_mode,cer.model,cer.profile_version,cer.prompt_hash,cer.snapshot_json,
      cer.created_at,cer.updated_at,u.name operator_name
    FROM content_employee_runs cer
    LEFT JOIN users u ON u.id=cer.created_by AND u.tenant_id=cer.tenant_id
    WHERE cer.tenant_id=? AND cer.id=?${scope.sql}`,
  curTenant(), id, ...scope.params);
  if (!row) return res.status(404).json({ error: '内容员工运行记录不存在或无权查看' });

  const snapshot = safeJsonParse(row.snapshot_json, {});
  const capabilities = Array.isArray(snapshot?.capabilities) ? snapshot.capabilities : [];
  const coreSkills = Array.isArray(snapshot?.coreSkill) ? snapshot.coreSkill : [];
  const historicalSkills = Array.isArray(snapshot?.historicalSkills) ? snapshot.historicalSkills : [];
  const customSkills = Array.isArray(snapshot?.customSkills) ? snapshot.customSkills : [];
  const result = String(row.result_md || '').trim();
  const hasOutput = Boolean(result);
  const approvalBoundary = {
    workMethod: snapshot?.workMethod?.approval || null,
    jobProfile: Array.isArray(snapshot?.jobProfile?.boundaries)
      ? snapshot.jobProfile.boundaries
      : [],
  };
  const skillSources = {
    core: [...new Set(coreSkills.map(item => item?.source).filter(Boolean))],
    historical: snapshot?.provenance?.historicalSkills || null,
    custom: [...new Set(customSkills.map(item => item?.source).filter(Boolean))],
  };

  res.set('Cache-Control', 'private, no-store');
  return res.json({
    source: 'content_solo',
    sourceLabel: SOURCE_LABELS.content_solo,
    domain: 'content_solo',
    evidenceKind: contentSoloEvidence(row.status, hasOutput),
    record: {
      id: Number(row.id),
      title: row.title || `内容员工派活 #${row.id}`,
      type: row.type || '岗位交付',
      status: row.status || '未知',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      dueAt: row.due_at,
      group: row.employee_group || 'Paihuo内容生产部',
      employeeIdx: Number(row.employee_idx),
      employeeKey: row.employee_key || '',
      employee: row.employee_name || '内容员工',
      person: null,
      operator: row.operator_name || '-',
      inputSummary: row.requirement || '',
      inputs: {
        title: row.title || '',
        type: row.type || '',
        requirement: row.requirement || '',
        dueAt: row.due_at || null,
      },
    },
    output: hasOutput ? {
      body: result,
      status: row.status || '未知',
      aiMode: row.ai_mode || null,
      model: row.model || null,
      provenance: {
        profileVersion: row.profile_version || '',
        promptHash: row.prompt_hash || '',
        persisted: true,
        reviewRequired: row.status === '待审阅',
      },
    } : null,
    execution: {
      profileVersion: row.profile_version || snapshot?.profileVersion || '',
      promptHash: row.prompt_hash || snapshot?.promptHash || '',
      snapshot: {
        schemaVersion: snapshot?.schemaVersion || null,
        messageMode: snapshot?.messageMode || null,
        employee: snapshot?.employee || null,
        capabilities,
        workMethod: snapshot?.workMethod || null,
        workConfig: snapshot?.workConfig || null,
        skills: {
          core: coreSkills,
          historical: historicalSkills,
          custom: customSkills,
        },
        skillSources,
        jobProfile: snapshot?.jobProfile || null,
        approvalBoundary,
        promptCompilation: snapshot?.promptCompilation || null,
        provenance: snapshot?.provenance || null,
      },
    },
    disclaimer: '这是当前门店内单个内容员工的一次可追溯运行记录；生成中或失败且无结果的记录不会算作产出，待审阅结果不代表已发布，本记录也不归因营业额、利润、订单或顾客转化。',
  });
});

r.get('/drill/content/:recordId', (req, res) => {
  const match = String(req.params.recordId || '').match(/^(output|media)-(\d{1,15})$/);
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1) {
    return res.status(404).json({ error: '内容生产仓记录不存在' });
  }
  const [, kind, rawId] = match;
  const id = Number(rawId);

  if (kind === 'output') {
    const scope = userScopeClause(req.user, 'c.creator_id');
    const row = q.get(`SELECT
        c.*,u.name operator_name
      FROM contents c
      LEFT JOIN users u ON u.id=c.creator_id AND u.tenant_id=c.tenant_id
      WHERE c.tenant_id=? AND c.id=? AND c.content_employee_idx IS NOT NULL${scope.sql}`,
    curTenant(), id, ...scope.params);
    if (!row) return res.status(404).json({ error: '内容生产仓记录不存在或无权查看' });
    const employee = contentEmployeeByIdx(Number(row.content_employee_idx));
    res.set('Cache-Control', 'private, no-store');
    return res.json({
      source: 'content',
      sourceLabel: SOURCE_LABELS.content,
      domain: 'content_output',
      evidenceKind: '单工位内容产出',
      record: {
        id: row.id,
        title: row.title || row.topic || `内容#${row.id}`,
        type: row.type || '内容成品',
        status: row.status || '未知',
        createdAt: row.created_at,
        group: row.content_employee_group || employee?.group || '内容生产部',
        employeeIdx: Number(row.content_employee_idx),
        employeeKey: row.content_employee_key || employee?.key || '',
        employee: row.content_employee_name || employee?.name || '内容员工',
        person: null,
        operator: row.operator_name || '-',
        inputSummary: [row.topic && `主题：${row.topic}`, row.brand && `品牌：${row.brand}`].filter(Boolean).join('；'),
        inputs: { topic: row.topic || '', brand: row.brand || '', contentType: row.type || '' },
      },
      output: {
        id: row.id,
        title: row.title,
        body: row.body || '',
        status: row.status,
        aiMode: row.ai_mode,
        riskLevel: row.risk_level || 'none',
        riskFlags: safeJsonParse(row.risk_flags, []),
        provenance: {
          executionMode: row.content_run_mode || 'single_station',
          employeeKey: row.content_employee_key || employee?.key || '',
          persisted: true,
        },
      },
      disclaimer: '这是单个内容员工名下的生成记录，不表示内容部十个工位已串行执行；发布效果仍需用真实平台与经营数据核验。',
    });
  }

  const scope = userScopeClause(req.user, 'j.user_id');
  const row = q.get(`SELECT j.*,u.name operator_name
    FROM media_jobs j
    LEFT JOIN users u ON u.id=j.user_id AND u.tenant_id=j.tenant_id
    WHERE j.tenant_id=? AND j.id=? AND j.content_employee_idx IS NOT NULL
      AND j.kind IN ('image','video')${scope.sql}`,
  curTenant(), id, ...scope.params);
  if (!row) return res.status(404).json({ error: '内容生产仓记录不存在或无权查看' });
  const employee = contentEmployeeByIdx(Number(row.content_employee_idx));
  res.set('Cache-Control', 'private, no-store');
  return res.json({
    source: 'content',
    sourceLabel: SOURCE_LABELS.content,
    domain: 'content_media',
    evidenceKind: row.status === '成功' ? '单工位媒体产出' : '媒体运行状态',
    record: {
      id: row.id,
      title: String(row.prompt || '').slice(0, 80) || `媒体任务#${row.id}`,
      type: row.kind === 'video' ? 'AI视频' : row.kind === 'image' ? 'AI图片' : row.kind || '媒体任务',
      status: row.status || '未知',
      createdAt: row.created_at,
      group: row.content_employee_group || employee?.group || '内容生产部',
      employeeIdx: Number(row.content_employee_idx),
      employeeKey: row.content_employee_key || employee?.key || '',
      employee: row.content_employee_name || employee?.name || '内容员工',
      person: null,
      operator: row.operator_name || '-',
      inputSummary: row.prompt || '',
      inputs: { prompt: row.prompt || '', model: row.model || '', kind: row.kind || '' },
    },
    output: {
      body: row.status === '成功' ? '媒体任务已完成，文件地址保存在运行记录中。' : (row.error || '媒体任务尚未完成。'),
      artifactUrl: row.url || null,
      error: row.error || null,
      provenance: {
        executionMode: row.content_run_mode || 'single_station',
        employeeKey: row.content_employee_key || employee?.key || '',
        model: row.model || '',
        persisted: true,
      },
    },
    disclaimer: '这是单个内容员工名下的媒体任务，不表示内容部十个工位已串行执行；成功状态也不代表已经发布或产生经营成效。',
  });
});

export default r;

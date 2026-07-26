import { Router } from 'express';
import { db, q, getTenantConfig, curTenant } from '../db.js';
import { logOp, notify, today, daysAgo, monthStart, pct } from '../util.js';
import { generateBattlePlan } from '../engines/plans.js';
import { accessibleUserExists, canAccessOwner, isManagerRole, userScopeClause } from '../engines/access.js';
import { archiveAndDelete, deleteList, deletionDenied, isBossLike, isManagerLike, tableRows } from '../engines/deletion.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ALLOWED_EXTS } from '../engines/extract.js';
import { decodeBase64File } from '../engines/filehub.js';

const r = Router();
const isManager = (u) => isManagerRole(u);
const canTouchTask = (task, user) => canAccessOwner(user, task?.assignee_id);
const PUBLIC_TASK_FIELDS = `t.id, t.title, t.detail, t.type, t.status, t.priority, t.assignee_id, t.due_at,
  t.source, t.activity_id, t.activity_plan_item, t.feishu_notified, t.risk, t.created_at, t.done_at, t.tenant_id`;
const PLAN_SOURCE = '作战计划';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASK_UPLOAD_ROOT = path.join(__dirname, '..', '..', 'data', 'uploads', 'tasks');

function requirePartnerManager(req, res) {
  if (isManager(req.user)) return true;
  res.status(403).json({ error: '合作伙伴经营数据仅老板/运营总监/管理员可查看或操作' });
  return false;
}

async function saveTaskAttachments(files = []) {
  if (files == null) return { files: [], paths: [] };
  if (!Array.isArray(files)) throw Object.assign(new Error('附件列表格式不正确'), { status: 400 });
  if (files.length > 5) throw Object.assign(new Error('单次最多上传5个附件'), { status: 400 });
  const dir = path.join(TASK_UPLOAD_ROOT, String(curTenant()));
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  const paths = [];
  try {
    for (const [index, f] of files.entries()) {
      if (!f || typeof f !== 'object' || Array.isArray(f) || typeof f.name !== 'string' || typeof f.b64 !== 'string') {
        throw Object.assign(new Error(`第${index + 1}个附件格式不正确`), { status: 400 });
      }
      const name = f.name.trim();
      const b64 = f.b64;
      if (!name || !b64) throw Object.assign(new Error(`第${index + 1}个附件缺少文件名或内容`), { status: 400 });
      if (name.length > 200) throw Object.assign(new Error(`第${index + 1}个附件名超过200字`), { status: 400 });
      const ext = String(name.split('.').pop() || '').toLowerCase();
      if (!ALLOWED_EXTS.includes(ext)) {
        throw Object.assign(new Error(`不支持的附件格式 .${ext}`), { status: 400 });
      }
      const buf = decodeBase64File(b64, 5 * 1024 * 1024);
      const safeName = path.basename(name).replace(/[^\w.\u4e00-\u9fa5-]/g, '_').slice(0, 140) || `attachment.${ext}`;
      const safe = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}-${safeName}`;
      const storedPath = path.join(dir, safe);
      fs.writeFileSync(storedPath, buf, { flag: 'wx' });
      paths.push(storedPath);
      saved.push({ name, type: ext, size: buf.length, url: `/uploads/tasks/${curTenant()}/${encodeURIComponent(safe)}` });
    }
    return { files: saved, paths };
  } catch (error) {
    for (const storedPath of paths) {
      try { fs.rmSync(storedPath, { force: true }); } catch { /* best-effort cleanup */ }
    }
    throw error;
  }
}

function taskDetailFromPlan(t) {
  const basis = t?.basis || {};
  return [
    `检查标准：${t.check || '按计划完成并回传结果'}`,
    basis.shortSource ? `目标来源：${basis.shortSource}` : '',
    basis.source ? `来源说明：${basis.source}` : '',
    basis.formula ? `拆解链路：${basis.formula}` : '',
  ].filter(Boolean).join('\n');
}

function taskDeletePolicy(req, task) {
  const submissionCount = q.get(`SELECT COUNT(*) n FROM task_submissions WHERE tenant_id=${curTenant()} AND task_id=?`, task.id)?.n || 0;
  const passedCount = q.get(`SELECT COUNT(*) n FROM task_submissions WHERE tenant_id=${curTenant()} AND task_id=? AND result='通过'`, task.id)?.n || 0;
  if (task.source === '活动策划' && task.status !== '已完成' && passedCount === 0) return {
    allowed: isManagerLike(req.user) && canTouchTask(task, req.user),
    requiredRole: 'manager',
    reason: '活动策划分配的任务由管理层统一调整，员工不能自行删除',
    submissionCount,
    passedCount,
  };
  const critical = task.status === '已完成' || passedCount > 0 || task.source === PLAN_SOURCE;
  if (critical) return {
    allowed: isBossLike(req.user),
    requiredRole: 'boss',
    reason: '已完成/作战计划任务属于执行事实，需老板/管理员删除',
    submissionCount,
    passedCount,
  };
  if (isBossLike(req.user)) return { allowed: true, requiredRole: 'boss', reason: '老板/管理员删除任务', submissionCount, passedCount };
  if (isManagerLike(req.user) && canTouchTask(task, req.user)) {
    return { allowed: true, requiredRole: 'manager', reason: '管理层删除团队任务', submissionCount, passedCount };
  }
  const ownEmpty = Number(task.assignee_id) === Number(req.user.id) && task.status === '待执行' && submissionCount === 0;
  return {
    allowed: ownEmpty,
    requiredRole: ownEmpty ? 'self' : 'manager',
    reason: ownEmpty ? '本人删除误建待执行任务' : '该任务已有提交或不属于本人，需管理层处理',
    submissionCount,
    passedCount,
  };
}

function getBattlePlanFor(date = today()) {
  let bp = q.get(`SELECT * FROM battle_plans WHERE tenant_id = ${curTenant()} AND date = ?`, date);
  if (!bp) return generateBattlePlan(date);
  try {
    const plan = JSON.parse(bp.plan);
    const hasTaskBasis = Array.isArray(plan.tasks) && plan.tasks.every(t => t?.basis?.source && t?.basis?.formula);
    if (!hasTaskBasis || (plan.planVersion || 1) < 2) return generateBattlePlan(date);
    return plan;
  } catch {
    return generateBattlePlan(date);
  }
}

function battlePlanConfirmation(user, plan, date = today()) {
  const items = Array.isArray(plan?.tasks) ? plan.tasks : [];
  if (!items.length) return { confirmed: false, total: 0, synced: 0, pending: 0, items: [] };
  const titles = items.map(t => String(t.action || '').trim()).filter(Boolean);
  if (!titles.length) return { confirmed: false, total: items.length, synced: 0, pending: items.length, items: [] };
  const rows = q.all(`SELECT id, title, status, due_at FROM tasks
    WHERE tenant_id = ${curTenant()} AND assignee_id = ? AND source = ? AND date(due_at) = ?`,
    user.id, PLAN_SOURCE, date);
  const itemStates = items.map((t, index) => {
    const title = String(t.action || '').trim();
    const hit = rows.find(r => r.title === title);
    return { index, title, type: t.type || '其他', confirmed: !!hit, task_id: hit?.id || null, status: hit?.status || null, due_at: hit?.due_at || null };
  });
  const synced = itemStates.filter(x => x.confirmed).length;
  return { confirmed: synced >= titles.length, total: titles.length, synced, pending: Math.max(0, titles.length - synced), items: itemStates };
}

function statusStats(rows) {
  const byStatus = { 待执行: 0, 进行中: 0, 待审核: 0, 已完成: 0 };
  const byType = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    byType[r.type || '其他'] = (byType[r.type || '其他'] || 0) + 1;
  }
  const total = rows.length;
  const done = byStatus['已完成'] || 0;
  return { total, done, doneRate: pct(done, total || 1), byStatus, byType };
}

function battleTaskRows(start, end, user) {
  const scope = userScopeClause(user, 't.assignee_id');
  return q.all(`SELECT ${PUBLIC_TASK_FIELDS}, u.name assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.tenant_id = ${curTenant()} AND t.source = ? AND date(t.due_at) >= ? AND date(t.due_at) <= ?${scope.sql}
    ORDER BY date(t.due_at) DESC, t.due_at, t.status`, PLAN_SOURCE, start, end, ...scope.params);
}

function battleRangeRollup(label, start, end, user) {
  const rows = battleTaskRows(start, end, user);
  const stats = statusStats(rows);
  const submitted = q.get(`SELECT COUNT(*) n FROM task_submissions s JOIN tasks t ON t.id = s.task_id
    WHERE s.tenant_id = ${curTenant()} AND t.source = ? AND date(t.due_at) >= ? AND date(t.due_at) <= ?
      ${userScopeClause(user, 't.assignee_id').sql}`,
    PLAN_SOURCE, start, end, ...userScopeClause(user, 't.assignee_id').params)?.n || 0;
  const people = new Set(rows.map(r => r.assignee).filter(Boolean)).size;
  return {
    label, start, end, ...stats, submitted, people,
    rows: rows.slice(0, 50),
  };
}

function rankPeriodStart(period = 'week') {
  const d = new Date();
  if (period === 'quarter') {
    const qMonth = Math.floor(d.getMonth() / 3) * 3;
    return `${d.getFullYear()}-${String(qMonth + 1).padStart(2, '0')}-01`;
  }
  if (period === 'month') return monthStart();
  return daysAgo(6);
}

function actualRevenueSince(start) {
  const orders = q.get(`SELECT COALESCE(SUM(amount),0) a FROM orders WHERE tenant_id=${curTenant()} AND created_at>=?`, start)?.a || 0;
  const daily = q.get(`SELECT COALESCE(SUM(deal_amount),0) a FROM daily_ops WHERE tenant_id=${curTenant()} AND date>=?`, start)?.a || 0;
  return orders || daily;
}

r.get('/summary', (req, res) => {
  const m = monthStart();
  const taskScope = userScopeClause(req.user, 'assignee_id');
  const joinedTaskScope = userScopeClause(req.user, 't.assignee_id');
  const leadScope = userScopeClause(req.user, 'owner_id');
  const goal = q.get(`SELECT * FROM goals WHERE tenant_id = ${curTenant()} AND period = ?`, m.slice(0, 7)) || {};
  const mAmount = actualRevenueSince(m);
  const weekTotal = q.get(`SELECT COUNT(*) n FROM tasks WHERE tenant_id = ${curTenant()} AND created_at >= date('now','-6 day')${taskScope.sql}`, ...taskScope.params)?.n || 1;
  const weekDone = q.get(`SELECT COUNT(*) n FROM tasks WHERE tenant_id = ${curTenant()} AND created_at >= date('now','-6 day') AND status='已完成'${taskScope.sql}`, ...taskScope.params)?.n || 0;
  const monthTotal = q.get(`SELECT COUNT(*) n FROM tasks WHERE tenant_id = ${curTenant()} AND created_at >= ?${taskScope.sql}`, m, ...taskScope.params)?.n || 0;
  const monthStarted = q.get(`SELECT COUNT(*) n FROM tasks WHERE tenant_id = ${curTenant()} AND created_at >= ?${taskScope.sql} AND status != '待执行'`, m, ...taskScope.params)?.n || 0;
  const monthOnTime = q.get(`SELECT COUNT(*) n FROM tasks WHERE tenant_id = ${curTenant()} AND status='已完成' AND created_at >= ?${taskScope.sql} AND (done_at <= due_at OR due_at IS NULL)`, m, ...taskScope.params)?.n || 0;
  const submittedTasks = q.get(`SELECT COUNT(DISTINCT s.task_id) n FROM task_submissions s JOIN tasks t ON t.id = s.task_id
    WHERE s.tenant_id = ${curTenant()} AND t.created_at >= ?${joinedTaskScope.sql}`, m, ...joinedTaskScope.params)?.n || 0;
  const passed = q.get(`SELECT COUNT(*) n FROM task_submissions s JOIN tasks t ON t.id = s.task_id
    WHERE s.tenant_id = ${curTenant()} AND s.result='通过' AND t.created_at >= ?${joinedTaskScope.sql}`, m, ...joinedTaskScope.params)?.n || 0;
  const subAll = q.get(`SELECT COUNT(*) n FROM task_submissions s JOIN tasks t ON t.id = s.task_id
    WHERE s.tenant_id = ${curTenant()} AND t.created_at >= ?${joinedTaskScope.sql}`, m, ...joinedTaskScope.params)?.n || 0;
  const execScore = Math.round(
    pct(monthStarted, monthTotal || 1) * 0.2
    + pct(submittedTasks, monthTotal || 1) * 0.25
    + pct(monthOnTime, monthTotal || 1) * 0.3
    + pct(passed, subAll || 1) * 0.25
  );
  res.json({
    goalRate: pct(mAmount, goal.revenue_target || 1500000),
    weekTaskRate: pct(weekDone, weekTotal),
    pendingReview: q.get(`SELECT COUNT(*) n FROM tasks WHERE tenant_id = ${curTenant()} AND status='待审核'${taskScope.sql}`, ...taskScope.params)?.n || 0,
    riskTasks: q.get(`SELECT COUNT(*) n FROM tasks WHERE tenant_id = ${curTenant()} AND risk=1 AND status NOT IN ('已完成')${taskScope.sql}`, ...taskScope.params)?.n || 0,
    keyFollows: q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND grade='A' AND stage NOT IN ('已成交','复购','已流失')${leadScope.sql}`, ...leadScope.params)?.n || 0,
    execScore,
  });
});

r.get('/goals', (req, res) => {
  const year = today().slice(0, 4);
  const month = today().slice(0, 7);
  const quarter = `${year}-Q${Math.ceil((+today().slice(5, 7)) / 3)}`;
  const rows = [['年度', year], ['季度', quarter], ['月度', month]].map(([label, period]) => {
    const g = q.get(`SELECT * FROM goals WHERE tenant_id = ${curTenant()} AND period = ?`, period) || {};
    let actual = 0;
    if (label === '年度') actual = actualRevenueSince(`${year}-01-01`);
    else if (label === '季度') {
      const qStart = `${year}-${String((Math.ceil((+today().slice(5, 7)) / 3) - 1) * 3 + 1).padStart(2, '0')}-01`;
      actual = actualRevenueSince(qStart);
    } else actual = actualRevenueSince(monthStart());
    const rate = pct(actual, g.revenue_target || 1);
    return { label, period, target: g.revenue_target || 0, actual, rate, risk: rate < 80 - 20 };
  });
  res.json(rows);
});

r.get('/tasks', (req, res) => {
  const { status, assignee } = req.query;
  let where = `WHERE t.tenant_id = ${curTenant()}`; const params = [];
  if (status) { where += ' AND t.status = ?'; params.push(status); }
  const scope = userScopeClause(req.user, 't.assignee_id');
  where += scope.sql; params.push(...scope.params);
  if (assignee) { where += ' AND t.assignee_id = ?'; params.push(assignee); }
  res.json(q.all(`SELECT ${PUBLIC_TASK_FIELDS}, u.name assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id ${where}
    ORDER BY CASE t.priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END, t.due_at LIMIT 100`, ...params));
});

r.post('/tasks', (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: '任务标题必填' });
  const assigneeId = b.assignee_id ? Number(b.assignee_id) : Number(req.user.id);
  if (assigneeId && !accessibleUserExists(req.user, assigneeId)) return res.status(403).json({ error: '只能给本人或下级团队成员创建任务' });
  const result = q.run('INSERT INTO tasks(title,detail,type,priority,assignee_id,due_at,source,risk) VALUES(?,?,?,?,?,?,?,?)',
    b.title, b.detail || '', b.type || '其他', b.priority || '中', assigneeId, b.due_at || null, b.source || '手动', b.risk ? 1 : 0);
  if (assigneeId && assigneeId !== Number(req.user.id)) notify(assigneeId, 'task', '新任务派发', b.title);
  logOp(req.user, '经营执行', '新建任务', b.title);
  res.json({ id: result.lastInsertRowid });
});

r.put('/tasks/:id', (req, res) => {
  // 租户归属守卫：杜绝按裸 id 改到别家企业的任务（IDOR）
  const task = q.get(`SELECT id, assignee_id FROM tasks WHERE tenant_id = ${curTenant()} AND id = ?`, req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (!canTouchTask(task, req.user)) return res.status(403).json({ error: '只能操作本人负责的任务' });
  const { status, title, detail, type, priority, due_at } = req.body || {};
  const valid = ['待执行', '进行中', '待审核', '已完成'];
  if (status && !valid.includes(status)) return res.status(400).json({ error: '无效状态' });
  if (title !== undefined) {
    if (!String(title).trim()) return res.status(400).json({ error: '任务标题必填' });
    q.run('UPDATE tasks SET title=? WHERE id=?', String(title).trim(), req.params.id);
  }
  if (detail !== undefined) q.run('UPDATE tasks SET detail=? WHERE id=?', detail || '', req.params.id);
  if (type !== undefined) q.run('UPDATE tasks SET type=? WHERE id=?', type || '其他', req.params.id);
  if (priority !== undefined) q.run('UPDATE tasks SET priority=? WHERE id=?', priority || '中', req.params.id);
  if (due_at !== undefined) q.run('UPDATE tasks SET due_at=? WHERE id=?', due_at || null, req.params.id);
  if (status === '已完成' && !['boss', 'ops_director'].includes(req.user.role)) {
    // 员工完成 → 进入待审核；总监/老板可直接完成（PRD §9.5 四态流转）
    q.run(`UPDATE tasks SET status = '待审核' WHERE id = ?`, req.params.id);
  } else if (status) {
    q.run(`UPDATE tasks SET status = ?, done_at = CASE WHEN ? = '已完成' THEN datetime('now','localtime') ELSE done_at END WHERE id = ?`,
      status, status, req.params.id);
  }
  res.json(q.get(`SELECT id, title, detail, type, status, priority, assignee_id, due_at, risk, created_at, done_at, tenant_id FROM tasks WHERE tenant_id = ${curTenant()} AND id = ?`, req.params.id));
});

r.delete('/tasks/:id', (req, res) => {
  const task = q.get(`SELECT * FROM tasks WHERE tenant_id = ${curTenant()} AND id = ?`, req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (!canTouchTask(task, req.user)) return res.status(403).json({ error: '无权删除该任务' });
  const policy = taskDeletePolicy(req, task);
  if (!policy.allowed) return deletionDenied(res, policy.requiredRole, policy.reason);
  const children = { task_submissions: tableRows('task_submissions', 'task_id=?', task.id) };
  const archiveId = archiveAndDelete(req, {
    entityType: 'task',
    entityId: task.id,
    table: 'tasks',
    row: task,
    children,
    module: '经营执行',
    title: task.title,
    summary: `${task.type || '-'}；状态=${task.status || '-'}；负责人#${task.assignee_id || '-'}；提交${policy.submissionCount}条`,
    requiredRole: policy.requiredRole,
    reason: req.body?.reason || policy.reason,
  }, () => {
    deleteList('task_submissions', 'task_id=?', task.id);
    deleteList('tasks', 'id=?', task.id);
  });
  logOp(req.user, '经营执行', '删除任务入回收站', `${task.title} / archive#${archiveId}`);
  res.json({ ok: true, archiveId, message: '已删除并进入回收站，老板/管理员可恢复' });
});

r.post('/tasks/:id/submit', async (req, res) => {
  const task = q.get(`SELECT id,assignee_id,status FROM tasks WHERE tenant_id = ${curTenant()} AND id = ?`, req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (!canTouchTask(task, req.user)) return res.status(403).json({ error: '只能提交本人负责的任务' });
  if (task.status === '待审核') return res.status(409).json({ error: '该任务已在审核中，请勿重复提交' });
  if (task.status === '已完成') return res.status(409).json({ error: '已完成任务不能重复提交' });
  let storedPaths = [];
  let transactionOpen = false;
  let persisted = false;
  try {
    const { content, attachments } = req.body || {};
    if (content != null && typeof content !== 'string') return res.status(400).json({ error: '提交说明必须是文本' });
    const note = String(content || '').trim();
    if (note.length > 12000) return res.status(400).json({ error: '提交说明最长12000字' });
    const saved = await saveTaskAttachments(attachments);
    storedPaths = saved.paths;
    if (!note && saved.files.length === 0) return res.status(400).json({ error: '提交说明或附件至少填写一项' });
    const body = saved.files.length
      ? JSON.stringify({ kind: 'task_submit_v2', note, attachments: saved.files })
      : note;
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const claimed = q.run(`UPDATE tasks SET status='待审核'
      WHERE tenant_id=? AND id=? AND status NOT IN ('待审核','已完成')`, curTenant(), req.params.id);
    if (!claimed.changes) throw Object.assign(new Error('任务状态已变化，请刷新后再提交'), { status: 409 });
    q.run('INSERT INTO task_submissions(task_id,user_id,content) VALUES(?,?,?)', req.params.id, req.user.id, body);
    db.exec('COMMIT');
    transactionOpen = false;
    persisted = true;
    res.json({ ok: true, attachments: saved.files });
  } catch (e) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    }
    if (!persisted) {
      for (const storedPath of storedPaths) {
        try { fs.rmSync(storedPath, { force: true }); } catch { /* best-effort cleanup */ }
      }
    }
    res.status(e.status || 500).json({ error: e.message });
  }
});

r.post('/tasks/:id/review', (req, res) => {
  if (!['boss', 'ops_director'].includes(req.user.role)) return res.status(403).json({ error: '需总监及以上权限' });
  const task = q.get(`SELECT id,assignee_id,status FROM tasks WHERE tenant_id = ${curTenant()} AND id = ?`, req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (!canTouchTask(task, req.user)) return res.status(403).json({ error: '只能审核本人团队范围内的任务' });
  const { pass, reason } = req.body || {};
  if (typeof pass !== 'boolean') return res.status(400).json({ error: '审核结果必须明确选择通过或驳回' });
  const reviewReason = typeof reason === 'string' ? reason.trim() : '';
  if (!pass && !reviewReason) return res.status(400).json({ error: '驳回必须填写原因' });
  if (reviewReason.length > 1000) return res.status(400).json({ error: '审核意见最长1000字' });
  if (task.status !== '待审核') return res.status(409).json({ error: '任务当前不在待审核状态' });
  const submission = q.get(`SELECT id FROM task_submissions WHERE tenant_id=? AND task_id=? AND result='待审核' ORDER BY id DESC LIMIT 1`, curTenant(), task.id);
  if (!submission) return res.status(409).json({ error: '未找到待审核的任务提交记录' });
  try {
    db.exec('BEGIN IMMEDIATE');
    const submissionChanged = q.run(`UPDATE task_submissions SET result=? WHERE tenant_id=? AND id=? AND result='待审核'`, pass ? '通过' : '驳回', curTenant(), submission.id);
    const taskChanged = q.run(`UPDATE tasks SET status=?,done_at=CASE WHEN ? THEN datetime('now','localtime') ELSE NULL END
      WHERE tenant_id=? AND id=? AND status='待审核'`,
      pass ? '已完成' : '进行中', pass ? 1 : 0, curTenant(), req.params.id);
    if (!submissionChanged.changes || !taskChanged.changes) throw Object.assign(new Error('任务已被其他审核人处理，请刷新列表'), { status: 409 });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw error;
  }
  logOp(req.user, '经营执行', pass ? '审核通过' : '审核驳回', `task#${req.params.id}${reviewReason ? ':' + reviewReason : ''}`);
  res.json({ ok: true });
});

r.get('/submissions', (req, res) => {
  const { taskId } = req.query;
  let where = `WHERE s.tenant_id = ${curTenant()} AND t.tenant_id = ${curTenant()}`; const params = [];
  const scope = userScopeClause(req.user, 't.assignee_id');
  where += scope.sql;
  params.push(...scope.params);
  if (taskId) {
    const task = q.get(`SELECT id, assignee_id FROM tasks WHERE tenant_id = ${curTenant()} AND id = ?`, taskId);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (!canTouchTask(task, req.user)) return res.status(403).json({ error: '无权查看该任务提交记录' });
    where += ' AND s.task_id = ?'; params.push(taskId);
  }
  res.json(q.all(`SELECT s.*, t.title task_title, u.name user_name FROM task_submissions s
    JOIN tasks t ON t.id = s.task_id LEFT JOIN users u ON u.id = s.user_id ${where} ORDER BY s.created_at DESC LIMIT 20`, ...params));
});

r.get('/ranking', (req, res) => {
  const period = ['week', 'month', 'quarter'].includes(req.query.period) ? req.query.period : 'week';
  const start = rankPeriodStart(period);
  // 排行榜只暴露全员聚合数据，用于激励；任务明细/提交记录仍由其他接口按层级隔离。
  res.json(q.all(`SELECT u.id, u.name, u.dept,
    COUNT(t.id) total, COALESCE(SUM(CASE WHEN t.status='已完成' THEN 1 ELSE 0 END),0) done
    FROM users u
    LEFT JOIN tasks t ON t.assignee_id = u.id AND t.tenant_id = ${curTenant()} AND t.created_at >= ?
    WHERE u.tenant_id = ${curTenant()}
      AND COALESCE(u.status,'启用') != '停用'
      AND u.role IN ('sales','ops_director','manager','partner')
    GROUP BY u.id HAVING COUNT(t.id) > 0 ORDER BY done DESC, total DESC, u.id`, start)
    .map(x => ({ ...x, period, start, rate: pct(x.done, x.total) })));
});

// ===== 作战计划（CTRL-02）=====
r.get('/battle-plan/today', (req, res) => {
  const plan = getBattlePlanFor(today());
  res.json({ ...plan, confirmation: battlePlanConfirmation(req.user, plan, today()) });
});
r.post('/battle-plan/generate', (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: '作战计划重新生成需管理层权限' });
  const plan = generateBattlePlan(today());
  // 计划任务落地为执行任务（半自动：人确认后执行 CTRL-04）
  logOp(req.user, '经营执行', '重新生成作战计划', today());
  res.json({ ...plan, confirmation: battlePlanConfirmation(req.user, plan, today()) });
});
r.post('/battle-plan/confirm', (req, res) => {
  const plan = getBattlePlanFor(today());
  const items = Array.isArray(plan.tasks) ? plan.tasks : [];
  if (!items.length) return res.status(400).json({ error: '今日作战计划暂无可同步任务' });
  const requestedIndex = Number.isInteger(req.body?.index) ? Number(req.body.index) : null;
  if (requestedIndex !== null && (requestedIndex < 0 || requestedIndex >= items.length)) {
    return res.status(400).json({ error: '作战计划条目不存在' });
  }
  const selected = requestedIndex === null ? items.map((item, index) => ({ item, index })) : [{ item: items[requestedIndex], index: requestedIndex }];
  let created = 0, existing = 0;
  const syncedItems = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { item: t, index } of selected) {
      const title = String(t.action || '').trim();
      if (!title) continue;
      const dueAt = `${today()} ${t.due || '18:00'}`;
      const hit = q.get(`SELECT id FROM tasks
        WHERE tenant_id = ${curTenant()} AND assignee_id = ? AND source = ? AND date(due_at) = ? AND title = ?`,
      req.user.id, PLAN_SOURCE, today(), title);
      if (hit) { existing++; syncedItems.push({ index, task_id: hit.id, created: false }); continue; }
      const result = q.run('INSERT INTO tasks(title,detail,type,priority,assignee_id,due_at,source,risk) VALUES(?,?,?,?,?,?,?,?)',
        title, taskDetailFromPlan(t), t.type || '其他', ['邀约', '跟进', '督导'].includes(t.type) ? '高' : '中',
        req.user.id, dueAt, PLAN_SOURCE, t.type === '督导' ? 1 : 0);
      syncedItems.push({ index, task_id: result.lastInsertRowid, created: true });
      created++;
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
  logOp(req.user, '经营执行', requestedIndex === null ? '确认今日作战计划' : '确认单条作战计划',
    `新增${created}个待执行任务，已有${existing}个${requestedIndex === null ? '' : `，条目#${requestedIndex + 1}`}`);
  res.json({ created, existing, total: selected.length, items: syncedItems, confirmation: battlePlanConfirmation(req.user, plan, today()) });
});
r.post('/battle-plan/apply', (req, res) => {
  if (!['boss', 'ops_director'].includes(req.user.role)) return res.status(403).json({ error: '作战计划下发需总监及以上确认' });
  const bp = q.get(`SELECT * FROM battle_plans WHERE tenant_id = ${curTenant()} AND date = ?`, today());
  if (!bp) return res.status(404).json({ error: '今日计划未生成' });
  let plan;
  try { plan = JSON.parse(bp.plan); } catch { return res.status(500).json({ error: '作战计划数据异常，请重新生成' }); }
  // 默认负责人：本企业运营总监优先、其次老板（杜绝硬编码 id=2 派给别家企业/不存在的账号）
  const owner = q.get(`SELECT id FROM users WHERE tenant_id = ${curTenant()} AND role IN ('ops_director','boss')
    ORDER BY CASE role WHEN 'ops_director' THEN 0 ELSE 1 END, id LIMIT 1`)?.id || req.user.id;
  let created = 0; let existing = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of (plan.tasks || [])) {
      const title = String(t.action || '').trim();
      if (!title) continue;
      const hit = q.get(`SELECT id FROM tasks WHERE tenant_id=? AND assignee_id=? AND source=? AND date(due_at)=? AND title=?`,
        curTenant(), owner, PLAN_SOURCE, today(), title);
      if (hit) { existing++; continue; }
      q.run('INSERT INTO tasks(title,detail,type,priority,assignee_id,due_at,source) VALUES(?,?,?,?,?,?,?)',
        title, `检查标准：${t.check}`, t.type, '高', owner, `${today()} ${t.due}`, PLAN_SOURCE);
      created++;
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
  logOp(req.user, '经营执行', '下发作战计划', `生成${created}个任务`);
  res.json({ created, existing });
});
r.get('/battle-plan/rollup', (req, res) => {
  const d = today();
  const yesterday = daysAgo(1);
  const scopeText = isManager(req.user) ? '管理层视角：全员作战任务' : '员工视角：本人作战任务';
  res.json({
    scope: scopeText,
    today: battleRangeRollup('今日作战', d, d, req.user),
    yesterday: battleRangeRollup('昨日复盘', yesterday, yesterday, req.user),
    week: battleRangeRollup('本周情况', daysAgo(6), d, req.user),
    month: battleRangeRollup('本月情况', monthStart(), d, req.user),
  });
});

// ===== 合作伙伴体系（内部表名 partners 保持接口兼容）=====
r.get('/partners', (req, res) => {
  if (!requirePartnerManager(req, res)) return;
  const rows = q.all(`SELECT p.*,
    (SELECT SUM(score) FROM partner_actions a WHERE a.partner_id = p.id AND a.date >= date('now','-6 day')) week_score,
    (SELECT COUNT(*) FROM partner_actions a WHERE a.partner_id = p.id AND a.date = date('now','localtime')
      AND (a.studied + (a.posted_moments>0) + (a.posted_videos>0) + a.invited) >= 2) active_today
    FROM partners p WHERE p.tenant_id = ${curTenant()} ORDER BY week_score DESC NULLS LAST`);
  res.json(rows);
});

r.post('/partner-actions', (req, res) => {
  if (!requirePartnerManager(req, res)) return;
  const b = req.body || {};
  if (!b.partner_id || !b.date) return res.status(400).json({ error: '合作伙伴与日期必填' });
  // 归属守卫：合作伙伴须属本企业，杜绝按 body 裸 partner_id 往别家记录写动作（写 IDOR）
  if (!q.get(`SELECT id FROM partners WHERE tenant_id = ${curTenant()} AND id = ?`, b.partner_id)) return res.status(404).json({ error: '合作伙伴不存在' });
  const score = (b.studied ? 10 : 0) + (b.posted_moments > 0 ? 10 : 0) + (b.posted_videos > 0 ? 15 : 0)
    + (b.invite_count || 0) * 5 + (b.arrive_count || 0) * 20 + (b.deal_count || 0) * 50;
  q.run(`INSERT INTO partner_actions(partner_id,date,studied,posted_moments,posted_videos,invited,invite_count,intent_count,arrive_count,deal_count,problem,score)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(partner_id,date) DO UPDATE SET studied=excluded.studied, posted_moments=excluded.posted_moments,
    posted_videos=excluded.posted_videos, invited=excluded.invited, invite_count=excluded.invite_count,
    intent_count=excluded.intent_count, arrive_count=excluded.arrive_count, deal_count=excluded.deal_count,
    problem=excluded.problem, score=excluded.score`,
    b.partner_id, b.date, b.studied ? 1 : 0, b.posted_moments || 0, b.posted_videos || 0,
    b.invited ? 1 : 0, b.invite_count || 0, b.intent_count || 0, b.arrive_count || 0, b.deal_count || 0, b.problem || null, score);
  res.json({ ok: true, score });
});

r.get('/partners/leaderboard', (req, res) => {
  if (!requirePartnerManager(req, res)) return;
  // 「本月」用自然月起始（与目标/营收口径一致），周榜用近 7 天；杜绝"本月"实为"近30天"跨上月
  const since = req.query.period === 'month' ? monthStart() : daysAgo(6);
  res.json(q.all(`SELECT p.id, p.name, p.level, p.region, SUM(a.score) total,
    SUM(a.invite_count) invites, SUM(a.arrive_count) arrives, SUM(a.deal_count) deals
    FROM partner_actions a JOIN partners p ON p.id = a.partner_id
    WHERE a.tenant_id = ${curTenant()} AND a.date >= ? GROUP BY p.id ORDER BY total DESC LIMIT 10`, since));
});

r.get('/partners/silent', (req, res) => {
  if (!requirePartnerManager(req, res)) return;
  res.json(q.all(`SELECT p.id, p.name, p.level, p.region,
    (SELECT MAX(date) FROM partner_actions a WHERE a.partner_id = p.id AND a.score > 0) last_active
    FROM partners p WHERE p.tenant_id = ${curTenant()} AND p.status != '退出' AND p.id NOT IN (
      SELECT partner_id FROM partner_actions WHERE tenant_id = ${curTenant()} AND date >= date('now','-2 day')
      AND (studied + (posted_moments>0) + (posted_videos>0) + invited) >= 2) ORDER BY last_active`));
});

r.get('/partners/support-list', (req, res) => {
  if (!requirePartnerManager(req, res)) return;
  res.json(q.all(`SELECT a.date, p.name, a.problem FROM partner_actions a JOIN partners p ON p.id = a.partner_id
    WHERE a.tenant_id = ${curTenant()} AND a.problem IS NOT NULL AND a.date >= date('now','-7 day') ORDER BY a.date DESC LIMIT 15`));
});

// ===== 顶部统计卡钻取（本周任务/待审/风险/重点跟进/执行力构成）=====
r.get('/drill/:kind', (req, res) => {
  const kind = req.params.kind;
  const manager = isManager(req.user);
  const taskScope = userScopeClause(req.user, 't.assignee_id');
  const taskParams = taskScope.params;
  if (kind === 'week-tasks') {
    const rows = q.all(`SELECT ${PUBLIC_TASK_FIELDS}, u.name assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.tenant_id = ${curTenant()} AND t.created_at >= date('now','-6 day')${taskScope.sql} ORDER BY t.status, t.due_at`, ...taskParams);
    return res.json({ title: '本周任务明细', rows,
      note: `本周共 ${rows.length} 项，已完成 ${rows.filter(x => x.status === '已完成').length} 项；完成率=已完成÷本周创建任务数。` });
  }
  if (kind === 'pending') {
    return res.json({ title: '待审核任务', rows: q.all(`SELECT ${PUBLIC_TASK_FIELDS}, u.name assignee,
      (SELECT content FROM task_submissions s WHERE s.task_id = t.id ORDER BY s.created_at DESC LIMIT 1) last_submit
      FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.tenant_id = ${curTenant()} AND t.status = '待审核'${taskScope.sql} ORDER BY t.due_at`, ...taskParams),
      note: '员工已提交执行结果待管理层审核；在下方任务看板「待审核」列可直接通过/驳回。' });
  }
  if (kind === 'risk') {
    return res.json({ title: '风险任务', rows: q.all(`SELECT ${PUBLIC_TASK_FIELDS}, u.name assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.tenant_id = ${curTenant()} AND t.risk = 1 AND t.status != '已完成'${taskScope.sql} ORDER BY t.due_at`, ...taskParams),
      note: '风险口径：超期未完成或被标记风险的任务；超期48小时自动升级提醒总监。' });
  }
  if (kind === 'key-follows') {
    // 数据权限（PRD §1.4）：员工仅见本人客户
    const leadScope = userScopeClause(req.user, 'owner_id');
    return res.json({ title: manager ? '重点跟进客户（A类未成交）' : '重点跟进客户（我负责的A类）',
      rows: q.all(`SELECT id, name, identity_tag, stage, score, budget_level, next_action, next_follow_at
      FROM leads WHERE tenant_id = ${curTenant()} AND grade = 'A' AND stage NOT IN ('已成交','复购','已流失')${leadScope.sql} ORDER BY score DESC LIMIT 50`, ...leadScope.params),
      note: 'A类=成交概率≥70分；按评分倒序逐一跟进，预算高者建议老板亲自出面（M-06口径）。' });
  }
  if (kind === 'exec-score') {
    const m = monthStart();
    const scope = userScopeClause(req.user, 't.assignee_id');
    const params = [m, ...scope.params];
    const total = q.get(`SELECT COUNT(*) n FROM tasks t WHERE t.tenant_id = ${curTenant()} AND t.created_at >= ?${scope.sql}`, ...params)?.n || 0;
    const planTotal = q.get(`SELECT COUNT(*) n FROM tasks t WHERE t.tenant_id = ${curTenant()} AND t.source = ? AND t.created_at >= ?${scope.sql}`,
      PLAN_SOURCE, m, ...scope.params)?.n || 0;
    const started = q.get(`SELECT COUNT(*) n FROM tasks t WHERE t.tenant_id = ${curTenant()} AND t.created_at >= ?${scope.sql} AND t.status != '待执行'`, ...params)?.n || 0;
    const doneAll = q.get(`SELECT COUNT(*) n FROM tasks t WHERE t.tenant_id = ${curTenant()} AND t.status='已完成' AND t.created_at >= ?${scope.sql}`, ...params)?.n || 0;
    const onTime = q.get(`SELECT COUNT(*) n FROM tasks t WHERE t.tenant_id = ${curTenant()} AND t.status='已完成' AND t.created_at >= ?${scope.sql} AND (t.done_at <= t.due_at OR t.due_at IS NULL)`, ...params)?.n || 0;
    const submittedTasks = q.get(`SELECT COUNT(DISTINCT s.task_id) n FROM task_submissions s JOIN tasks t ON t.id = s.task_id
      WHERE s.tenant_id = ${curTenant()} AND t.created_at >= ?${scope.sql}`, ...params)?.n || 0;
    const passed = q.get(`SELECT COUNT(*) n FROM task_submissions s JOIN tasks t ON t.id = s.task_id
      WHERE s.tenant_id = ${curTenant()} AND s.result='通过' AND t.created_at >= ?${scope.sql}`, ...params)?.n || 0;
    const subAll = q.get(`SELECT COUNT(*) n FROM task_submissions s JOIN tasks t ON t.id = s.task_id
      WHERE s.tenant_id = ${curTenant()} AND t.created_at >= ?${scope.sql}`, ...params)?.n || 0;
    const steps = [
      { key: 'start', label: '启动率', weight: 20, numerator: started, denominator: total || 1, rate: pct(started, total || 1), rule: '任务从待执行进入进行中/待审核/已完成，说明已被接住。' },
      { key: 'submit', label: '提交率', weight: 25, numerator: submittedTasks, denominator: total || 1, rate: pct(submittedTasks, total || 1), rule: '执行后有提交说明或附件，形成可审核记录。' },
      { key: 'ontime', label: '按时完成率', weight: 30, numerator: onTime, denominator: total || 1, rate: pct(onTime, total || 1), rule: '已完成且完成时间不晚于截止时间。' },
      { key: 'pass', label: '审核通过率', weight: 25, numerator: passed, denominator: subAll || 1, rate: pct(passed, subAll || 1), rule: '提交内容被管理层审核通过。' },
    ].map(s => ({ ...s, score: Math.round(s.rate * s.weight) / 100 }));
    const score = Math.round(steps.reduce((sum, s) => sum + s.score, 0));
    const processRows = q.all(`SELECT ${PUBLIC_TASK_FIELDS}, u.name assignee,
        (SELECT result FROM task_submissions s WHERE s.task_id = t.id ORDER BY s.created_at DESC LIMIT 1) last_result,
        (SELECT created_at FROM task_submissions s WHERE s.task_id = t.id ORDER BY s.created_at DESC LIMIT 1) last_submit_at
      FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.tenant_id = ${curTenant()} AND t.created_at >= ?${scope.sql}
      ORDER BY CASE t.status WHEN '已完成' THEN 0 WHEN '待审核' THEN 1 WHEN '进行中' THEN 2 ELSE 3 END, t.due_at LIMIT 30`, ...params);
    const late = processRows.filter(r => r.status === '已完成' && r.done_at && r.due_at && r.done_at > r.due_at).slice(0, 10);
    return res.json({ title: '执行力评分构成（本月）',
      formula: { total, planTotal, started, submittedTasks, doneAll, onTime, passed, subAll, steps, score },
      lateRows: late, processRows,
      note: '执行力评分 = 启动率×20% + 提交率×25% + 按时完成率×30% + 审核通过率×25%。员工看本人任务，管理层看全员任务。' });
  }
  res.status(400).json({ error: '未知钻取类型' });
});

// ===== 目标三层钻取（经营看板资料包口径：年600万/团队月50万/个人月20万）=====
r.get('/goals-drill', (req, res) => {
  const year = today().slice(0, 4);
  const manager = isManager(req.user);
  const yearTarget = getTenantConfig('year_revenue_target', 6000000);
  const monthTarget = getTenantConfig('month_revenue_target', 500000);
  const personalTarget = getTenantConfig('personal_month_target', 200000);
  const yearActual = actualRevenueSince(`${year}-01-01`);
  const monthActual = actualRevenueSince(monthStart());
  // 年度按月拆解构成
  const hasOrderFacts = q.get(`SELECT COUNT(*) n FROM orders WHERE tenant_id=${curTenant()} AND created_at>=?`, `${year}-01-01`)?.n || 0;
  const byMonth = hasOrderFacts
    ? q.all(`SELECT strftime('%Y-%m', created_at) m,SUM(amount) amount,COUNT(*) deals FROM orders
      WHERE tenant_id=${curTenant()} AND created_at>=? GROUP BY m ORDER BY m`, `${year}-01-01`)
    : q.all(`SELECT strftime('%Y-%m', date) m, SUM(deal_amount) amount, SUM(deals) deals
      FROM daily_ops WHERE tenant_id = ${curTenant()} AND date >= ? GROUP BY m ORDER BY m`, `${year}-01-01`);
  // 个人维度：本月成交额按客户负责人归集（订单→线索→负责人）
  const personalScope = userScopeClause(req.user, 'u.id');
  const personalParams = [monthStart(), ...personalScope.params];
  const personal = q.all(`SELECT u.id, u.name, u.dept,
      COALESCE((SELECT SUM(o.amount) FROM orders o JOIN leads l ON l.id = o.lead_id
        WHERE o.tenant_id = ${curTenant()} AND l.owner_id = u.id AND o.created_at >= ?), 0) actual,
      (SELECT COUNT(*) FROM leads l WHERE l.tenant_id = ${curTenant()} AND l.owner_id = u.id AND l.stage NOT IN ('已成交','复购','已流失')) pipeline
    FROM users u WHERE u.tenant_id = ${curTenant()} AND (u.role IN ('sales') OR u.dept LIKE '%销售%')${personalScope.sql} ORDER BY actual DESC`, ...personalParams);
  // 缺口反推（与作战计划引擎同口径）
  const gapAmount = Math.max(0, monthTarget - monthActual);
  const avgDeal = getTenantConfig('avg_deal_amount', 8000);
  const daysLeft = Math.max(1, 30 - new Date().getDate());
  const needDealsPerDay = Math.ceil(gapAmount / avgDeal / daysLeft);
  const inviteTarget = Math.max(3, Math.ceil(needDealsPerDay / 0.25 / 0.6));
  res.json({
    year: { period: year, target: yearTarget, actual: yearActual, rate: pct(yearActual, yearTarget), byMonth },
    month: { period: today().slice(0, 7), target: monthTarget, actual: monthActual, rate: pct(monthActual, monthTarget),
      gap: gapAmount, daysLeft, needDealsPerDay, inviteTarget, avgDeal },
    personal: { target: personalTarget, rows: personal.map(p => ({ ...p, rate: pct(p.actual, personalTarget) })) },
    rules: [
      `目标口径来自本企业当前配置：年度目标${yearTarget}、团队月度目标${monthTarget}、个人月度目标${personalTarget}；调整后需保留负责人和生效日期`,
      '人员编制与目标调整须结合门店产能、营业时段、历史订单和服务质量，不使用固定人均增量承诺',
      '缺口反推中的客单价和转化率必须来自本企业已确认配置或真实历史数据；缺失时仅作待确认估算',
      '门店主题、会员、社区或渠道合作活动均在活动中心逐场设置目标，并以真实报名、到场、订单、收入和成本复盘',
    ],
  });
});

// ===== 合作伙伴四档活跃分类（检查项 → 高/中/低活跃/沉睡）=====
const TIER_STRATEGY = {
  '高活跃': { color: 'green', strategy: '保持动作：复盘有效合作案例，在取得顾客授权后继续推荐适配客户，并评估更高合作层级' },
  '中活跃': { color: 'blue', strategy: '轻推一把：每日素材包定向触达，给一个本周小目标（1次邀约或1条转发），完成即公开表扬' },
  '低活跃': { color: 'orange', strategy: '重点跟进：负责人确认合作障碍，围绕团餐、顾客答谢或门店主题活动等真实需求制定下一步' },
  '沉睡': { color: 'red', strategy: '沉睡唤醒：由合作负责人沟通近况、合作意愿和适配场景；触达时间与方式按双方约定执行' },
};
function partnerWeekChecks(pid) {
  const a = q.get(`SELECT SUM(studied) studied, SUM(posted_moments) pm, SUM(posted_videos) pv, SUM(invited) inv,
    SUM(invite_count) ic, SUM(intent_count) tc, SUM(arrive_count) ac, SUM(deal_count) dc,
    SUM(CASE WHEN problem IS NOT NULL THEN 1 ELSE 0 END) fb, MAX(date) last
    FROM partner_actions WHERE tenant_id = ${curTenant()} AND partner_id = ? AND date >= date('now','-6 day')`, pid) || {};
  const checks = [
    { item: '本周转发内容', ok: (a.pm || 0) + (a.pv || 0) > 0 },
    { item: '推荐客户', ok: (a.tc || 0) > 0 },
    { item: '邀约到店', ok: (a.inv || 0) > 0 || (a.ic || 0) > 0 },
    { item: '带新客户到场', ok: (a.ac || 0) > 0 },
    { item: '产生成交', ok: (a.dc || 0) > 0 },
    { item: '完成学习', ok: (a.studied || 0) > 0 },
    { item: '提交反馈', ok: (a.fb || 0) > 0 },
  ];
  const hit = checks.filter(c => c.ok).length;
  const tier = hit >= 5 ? '高活跃' : hit >= 3 ? '中活跃' : hit >= 1 ? '低活跃' : '沉睡';
  return { checks, hit, tier, lastActive: a.last || null };
}
r.get('/partners/tiers', (req, res) => {
  if (!requirePartnerManager(req, res)) return;
  const partners = q.all(`SELECT id, name, level, region, status FROM partners WHERE tenant_id = ${curTenant()} AND status != '退出'`);
  const rows = partners.map(p => ({ ...p, ...partnerWeekChecks(p.id) }));
  const groups = {};
  for (const t of ['高活跃', '中活跃', '低活跃', '沉睡'])
    groups[t] = { tier: t, ...TIER_STRATEGY[t], members: rows.filter(x => x.tier === t) };
  res.json({ total: rows.length, groups: Object.values(groups) });
});

// 合作伙伴动作明细（排行榜/分档 行点击钻取）
r.get('/partners/:id/detail', (req, res) => {
  if (!requirePartnerManager(req, res)) return;
  const p = q.get(`SELECT * FROM partners WHERE tenant_id = ${curTenant()} AND id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: '合作伙伴不存在' });
  const acts = q.all(`SELECT * FROM partner_actions WHERE tenant_id = ${curTenant()} AND partner_id = ? ORDER BY date DESC LIMIT 14`, p.id);
  const agg = q.get(`SELECT SUM(score) score, SUM(invite_count) invites, SUM(arrive_count) arrives, SUM(deal_count) deals
    FROM partner_actions WHERE tenant_id = ${curTenant()} AND partner_id = ? AND date >= date('now','-29 day')`, p.id) || {};
  res.json({ ...p, ...partnerWeekChecks(p.id), actions: acts, month: agg });
});

// ===== 未行动提醒卡（PAR-06 口径：提醒类型/优先级/下一步动作/管理话术/截止）=====
r.post('/partners/:id/remind', (req, res) => {
  if (!requirePartnerManager(req, res)) return;
  const p = q.get(`SELECT * FROM partners WHERE tenant_id = ${curTenant()} AND id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: '合作伙伴不存在' });
  const { tier, lastActive, hit } = partnerWeekChecks(p.id);
  const CARD = {
    '高活跃': { remindType: '保持动作', priority: '低', due: 3,
      nextAction: '安排复购/转介绍动作，继续提交客户名单',
      script: `${p.name}近期动作积极，本周重点不是催，而是让其继续带1-2个新客户名单，并在排行榜公开表扬，同时评估是否升级更高合作层级。` },
    '中活跃': { remindType: '轻提醒', priority: '中', due: 2,
      nextAction: '提醒本周至少完成一次客户邀约或朋友圈转发',
      script: `${p.name}本周有部分动作，建议温和提醒：发一条今日素材包并附一句「这条很适合您的客户圈，发出去看看反馈」，给一个具体的小目标。` },
    '低活跃': { remindType: '重点跟进', priority: '高', due: 1,
      nextAction: '按双方约定方式回访，确认是否有团餐、顾客答谢或门店活动需求',
      script: `${p.name}近期动作较少，建议由负责人先确认近况和合作意愿，再基于已经核实的门店活动、菜单与接待能力讨论具体顾客场景；不得编造名额、价格或活动安排。` },
    '沉睡': { remindType: '沉睡唤醒', priority: '高', due: 1,
      nextAction: '由合作负责人确认继续合作意愿和适配场景',
      script: `${p.name}较长时间未见有效动作（最近动作 ${lastActive || '无记录'}）。建议按双方约定的联系权限与方式，由合作负责人确认近况、继续合作意愿和需要支持的真实事项。` },
  };
  const card = { partner: p.name, level: p.level, region: p.region, tier, hit, lastActive,
    owner: '店长/运营', dueDate: q.get(`SELECT date('now','+${CARD[tier].due} day') d`)?.d, ...CARD[tier] };
  const targets = q.all(`SELECT id FROM users WHERE tenant_id = ${curTenant()} AND role IN ('boss','ops_director')`);
  for (const u of targets)
    notify(u.id, '合作伙伴提醒', `【${card.remindType}】${p.name}`, `${card.nextAction}（${tier}·${card.priority}优先级，截止${card.dueDate}）`);
  logOp(req.user, '经营执行', '发出合作伙伴提醒', `${p.name}·${card.remindType}`);
  res.json(card);
});

export default r;

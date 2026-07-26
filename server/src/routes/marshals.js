import { Router } from 'express';
import { db, q, curTenant, mergeMarshal, runWithTenant } from '../db.js';
import { logOp, notify, pct, monthStart, today } from '../util.js';
import { marshalWork, marshalChat } from '../engines/ai.js';
import { applyRiskControl, applyChatRiskControl, createApproval } from '../engines/risk.js';
import { recordKbCitations } from '../engines/rag.js';
import { precheck, precheckByRole, estimateCallCredits, holdCredits, settleHold, releaseHold } from '../engines/credits.js';
import { textModelFor } from '../engines/yunwu.js';
import { directivesFor, skillByKey, skillsForClient } from '../engines/skills.js';
import { FILE_SKILLS } from '../engines/skillrun.js';
import { attachmentRefsForStorage, rehydrateMessageHistory, resolveRequestedAttachments } from '../engines/filehub.js';
import { canAccessOwner, userScopeClause } from '../engines/access.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { buildEmployeeExecutionProfile, EMPLOYEE_TASK_TYPES } from '../employee-workbench.js';

const r = Router();
const TASK_TYPES = new Set(EMPLOYEE_TASK_TYPES);
const MAX_MESSAGE_CHARS = 20000;
const MAX_INLINE_IMAGE_CHARS = 11_200_000;
const CURRENT_DEPARTMENT_CODES = Object.freeze(Array.from({ length: 8 }, (_, index) => `M-${String(index + 1).padStart(2, '0')}`));
const CURRENT_DEPARTMENT_CODE_SET = new Set(CURRENT_DEPARTMENT_CODES);
const CURRENT_DEPARTMENT_SQL = CURRENT_DEPARTMENT_CODES.map(() => '?').join(',');
const CORE_DEPARTMENT_CODES = Object.freeze(['M-01', 'M-02', 'M-06']);

function activeDepartment(base) {
  if (!base || !CURRENT_DEPARTMENT_CODE_SET.has(base.code)) return null;
  const merged = mergeMarshal({ ...base });
  return Number(merged.online) === 1 ? merged : null;
}

function activeDepartments(rows) {
  return rows.map(activeDepartment).filter(Boolean);
}

function activeDepartmentById(id) {
  return activeDepartment(q.get(`SELECT * FROM marshals WHERE id=? AND code IN (${CURRENT_DEPARTMENT_SQL})`, id, ...CURRENT_DEPARTMENT_CODES));
}

function digitalEmployee(row) {
  if (!row) return row;
  const idx = Number(row.employee_idx);
  // 101-160 是 restaurant.json 的权威员工，旧租户覆盖不得改写身份、职责或上下线状态。
  if (Number.isInteger(idx) && idx >= 101 && idx <= 160) return { ...row, active: 1 };
  return null;
}

function mergeJoinedMarshal(row, nameKey = 'marshal_name') {
  if (!row?.marshal_code) return row;
  const merged = activeDepartment({
    code: row.marshal_code,
    name: row[nameKey],
    emoji: row.marshal_emoji,
    avatar: row.marshal_avatar,
    online: row.marshal_online,
  });
  if (!merged) return null;
  return { ...row, [nameKey]: merged.name, marshal_emoji: merged.emoji, marshal_avatar: merged.avatar };
}

function validDateTime(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const values = [year, month, day, hour, minute, second].map(Number);
  const [y, m, d, h, min, sec] = values;
  const probe = new Date(Date.UTC(y, m - 1, d, h, min, sec));
  if (y < 1900 || y > 2999 || h > 23 || min > 59 || sec > 59
    || probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${year}-${month}-${day}${match[4] ? ` ${hour}:${minute}:${second}` : ''}`;
}

function validatedTaskImage(image, imageName) {
  if (image == null || image === '') return null;
  if (typeof image !== 'string') throw Object.assign(new Error('图片必须使用受支持的data URL'), { status: 400 });
  const match = image.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/u);
  if (!match) throw Object.assign(new Error('图片格式不支持，仅接受PNG、JPEG或WebP'), { status: 400 });
  if (image.length > MAX_INLINE_IMAGE_CHARS) throw Object.assign(new Error('图片超过8MB，请压缩后重试'), { status: 413 });
  const name = typeof imageName === 'string' && imageName.trim()
    ? imageName.trim().slice(0, 160)
    : `岗位证据.${match[1] === 'jpeg' || match[1] === 'jpg' ? 'jpg' : match[1]}`;
  return {
    dataUrl: image,
    metadata: {
      name,
      mime: `image/${match[1] === 'jpg' ? 'jpeg' : match[1]}`,
      bytes: Math.floor((match[2].replace(/=+$/u, '').length * 3) / 4),
      sha256: crypto.createHash('sha256').update(match[2]).digest('hex'),
      persistedRawImage: false,
    },
  };
}

function executionSnapshot(task, user = null) {
  if (!task?.employee_profile_version) return null;
  const parse = (value, label) => {
    try { return JSON.parse(value); }
    catch { throw new Error(`任务${task.id}的${label}执行快照损坏，拒绝静默降级`); }
  };
  const parseOptional = (value, label) => {
    if (value == null || value === '') return null;
    return parse(value, label);
  };
  const snapshot = {
    profileVersion: task.employee_profile_version,
    promptHash: task.employee_prompt_hash,
    capabilities: parse(task.employee_capabilities_snapshot, '能力'),
    config: parse(task.employee_config_snapshot, '工作配置'),
    skills: parse(task.employee_skills_snapshot, '技能'),
    inputEvidence: parseOptional(task.employee_input_snapshot, '输入证据'),
    webEvidence: parseOptional(task.employee_web_snapshot, '联网证据'),
  };
  if (!['boss', 'admin', 'platform_super'].includes(user?.role)) {
    snapshot.skills = snapshot.skills.map(({ instructions: _instructions, ...skill }) => skill);
  }
  return snapshot;
}

r.get('/overview', (req, res) => {
  const taskScope = userScopeClause(req.user, 'created_by');
  const departments = activeDepartments(q.all(`SELECT * FROM marshals WHERE code IN (${CURRENT_DEPARTMENT_SQL}) ORDER BY sort`, ...CURRENT_DEPARTMENT_CODES));
  const marshals = departments.length;
  const departmentIds = departments.map(department => department.id);
  const departmentScope = departmentIds.length ? ` AND marshal_id IN (${departmentIds.map(() => '?').join(',')})` : ' AND 1=0';
  const specialists = departments.reduce((total, department) => total + q.all(
    'SELECT id,employee_idx,name,duty FROM specialists WHERE marshal_id=? AND employee_idx BETWEEN 101 AND 160', department.id,
  ).map(digitalEmployee).filter(employee => employee?.active !== 0).length, 0);
  const collab = q.get(`SELECT COUNT(*) n FROM agent_tasks WHERE tenant_id = ${curTenant()} AND is_collab = 1 AND status != '已完成'${departmentScope}${taskScope.sql}`,
    ...departmentIds, ...taskScope.params)?.n || 0;
  const monthOut = q.get(`SELECT COUNT(*) n FROM agent_tasks WHERE tenant_id = ${curTenant()} AND created_at >= ?${departmentScope}${taskScope.sql}`,
    monthStart(), ...departmentIds, ...taskScope.params)?.n || 0;
  const done = q.get(`SELECT COUNT(*) n FROM agent_tasks WHERE tenant_id = ${curTenant()} AND created_at >= ? AND status = '已完成'${departmentScope}${taskScope.sql}`,
    monthStart(), ...departmentIds, ...taskScope.params)?.n || 0;
  res.json({ marshals, specialists, core: CORE_DEPARTMENT_CODES.length, collab, monthOutputs: monthOut, avgRate: pct(done, monthOut || 1) });
});

// ===== 顶部统计卡钻取（六张卡逐卡可点，全部可溯源到明细）=====
r.get('/drill/:kind', (req, res) => {
  const kind = req.params.kind;
  const taskScope = userScopeClause(req.user, 't.created_by');
  if (kind === 'marshals') {
    const rows = q.all(`SELECT m.code, m.name, m.title, m.emoji, m.avatar, m.online, m.duty,
      (SELECT COUNT(*) FROM specialists s WHERE s.marshal_id = m.id AND s.employee_idx BETWEEN 101 AND 160) specialists,
      (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.status = '生成中'${taskScope.sql}) running
      FROM marshals m WHERE m.code IN (${CURRENT_DEPARTMENT_SQL}) ORDER BY m.sort`, ...taskScope.params, ...CURRENT_DEPARTMENT_CODES);
    return res.json({ title: '餐饮数字员工编制总览', rows: activeDepartments(rows) });
  }
  if (kind === 'specialists') {
    const rows = q.all(`SELECT s.id,s.employee_idx,s.key,s.person,s.name,s.duty,m.code marshal_code,m.name marshal,m.emoji,m.avatar,m.online marshal_online,m.sort,
      CASE WHEN EXISTS(SELECT 1 FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.specialist_id=s.id AND t.status='生成中'${taskScope.sql})
        THEN '执行中' ELSE '空闲' END status
      FROM specialists s JOIN marshals m ON m.id=s.marshal_id
      WHERE m.code IN (${CURRENT_DEPARTMENT_SQL}) AND s.employee_idx BETWEEN 101 AND 160 ORDER BY m.sort,s.employee_idx`, ...taskScope.params, ...CURRENT_DEPARTMENT_CODES)
      .map(row => {
        const specialist = digitalEmployee(row);
        const department = activeDepartment({ code: row.marshal_code, name: row.marshal, emoji: row.emoji, avatar: row.avatar, online: row.marshal_online });
        return department && specialist && specialist.active !== 0
          ? { ...specialist, marshal: department.name, emoji: department.emoji, avatar: department.avatar }
          : null;
      }).filter(Boolean);
    return res.json({ title: '数字员工编制明细（按分部分组）', rows });
  }
  if (kind === 'core') {
    const rows = q.all(`SELECT m.code, m.name, m.title, m.emoji, m.avatar, m.duty,
      m.online,
      (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.created_at >= ?${taskScope.sql}) month_tasks
      FROM marshals m WHERE m.code IN (${CORE_DEPARTMENT_CODES.map(() => '?').join(',')}) ORDER BY m.sort`, monthStart(), ...taskScope.params, ...CORE_DEPARTMENT_CODES);
    return res.json({ title: '核心分部协作链', rows: activeDepartments(rows),
      note: '核心协作链用于缩短经营任务的决策与执行路径；所有结论仍需结合当前门店真实数据并由负责人确认。' });
  }
  if (kind === 'collab') {
    const rows = q.all(`SELECT t.id, t.title, t.type, t.status, t.collab_marshals, t.created_at,
      m.code marshal_code,m.name marshal_name,m.emoji marshal_emoji,m.avatar marshal_avatar,m.online marshal_online
      FROM agent_tasks t JOIN marshals m ON m.id = t.marshal_id WHERE t.tenant_id = ${curTenant()} AND t.is_collab = 1 AND t.status != '已完成'${taskScope.sql} ORDER BY t.created_at DESC LIMIT 50`, ...taskScope.params)
      .map(row => { const merged = mergeJoinedMarshal(row); return merged ? { ...merged, marshal: merged.marshal_name, emoji: merged.marshal_emoji, avatar: merged.marshal_avatar } : null; })
      .filter(Boolean);
    return res.json({ title: '进行中协同任务', rows });
  }
  if (kind === 'outputs') {
    const rows = q.all(`SELECT t.id, t.title, t.type, t.status, t.created_at,
      m.code marshal_code,m.name marshal_name,m.emoji marshal_emoji,m.avatar marshal_avatar,m.online marshal_online
      FROM agent_tasks t JOIN marshals m ON m.id = t.marshal_id WHERE t.tenant_id = ${curTenant()} AND t.created_at >= ?${taskScope.sql} ORDER BY t.created_at DESC LIMIT 80`, monthStart(), ...taskScope.params)
      .map(row => { const merged = mergeJoinedMarshal(row); return merged ? { ...merged, marshal: merged.marshal_name, emoji: merged.marshal_emoji, avatar: merged.marshal_avatar } : null; })
      .filter(Boolean);
    return res.json({ title: '本月任务产出明细', rows });
  }
  if (kind === 'rate') {
    const rows = q.all(`SELECT m.code, m.name, m.emoji, m.avatar,
      (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.created_at >= ?${taskScope.sql}) total,
      (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.created_at >= ? AND t.status = '已完成'${taskScope.sql}) done,
      (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.status = '待审阅'${taskScope.sql}) pending
      FROM marshals m WHERE m.code IN (${CURRENT_DEPARTMENT_SQL}) ORDER BY m.sort`, monthStart(), ...taskScope.params, monthStart(), ...taskScope.params, ...taskScope.params, ...CURRENT_DEPARTMENT_CODES);
    return res.json({ title: '各分部完成率（本月）', rows: activeDepartments(rows).map(x => ({ ...x, rate: pct(x.done, x.total || 1) })) });
  }
  res.status(400).json({ error: '未知钻取类型' });
});

r.get('/', (req, res) => {
  const taskScope = userScopeClause(req.user, 't.created_by');
  const rows = q.all(`SELECT m.*,
    (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id${taskScope.sql}) total_tasks,
    (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.status = '已完成'${taskScope.sql}) done_tasks,
    (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.is_collab = 1 AND t.status != '已完成'${taskScope.sql}) collab_tasks,
    (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.created_at >= date('now','start of month')${taskScope.sql}) month_outputs
    FROM marshals m WHERE m.code IN (${CURRENT_DEPARTMENT_SQL}) ORDER BY m.sort`, ...taskScope.params, ...taskScope.params, ...taskScope.params, ...taskScope.params, ...CURRENT_DEPARTMENT_CODES);
  res.json(activeDepartments(rows).map(m => ({ ...m, rate: pct(m.done_tasks, m.total_tasks || 1) })));
});

r.get('/:id', (req, res) => {
  const m = activeDepartmentById(req.params.id);
  if (!m) return res.status(404).json({ error: '分部不存在或未启用' });
  const taskScope = userScopeClause(req.user, 't.created_by');
  const contentScope = userScopeClause(req.user, 'c.creator_id');
  const specialists = q.all(`SELECT s.id,s.marshal_id,s.employee_idx,s.key,s.person,s.name,s.duty,
    CASE WHEN EXISTS(SELECT 1 FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.specialist_id=s.id AND t.status='生成中'${taskScope.sql})
      THEN '执行中' ELSE '空闲' END status,
    (SELECT t.title FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.specialist_id=s.id${taskScope.sql} ORDER BY t.created_at DESC LIMIT 1) last_task
    FROM specialists s WHERE s.marshal_id=? AND s.employee_idx BETWEEN 101 AND 160`, ...taskScope.params, ...taskScope.params, req.params.id)
    .map(digitalEmployee).filter(specialist => specialist?.active !== 0);
  const tasks = q.all(`SELECT t.* FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.marshal_id=?${taskScope.sql}
    ORDER BY t.created_at DESC LIMIT 15`, req.params.id, ...taskScope.params)
    .map(task => ({ ...task, executionSnapshot: executionSnapshot(task, req.user) }));
  const outputs = q.all(`SELECT c.id,c.type,c.title,c.status,c.created_at FROM contents c
    WHERE c.tenant_id=${curTenant()} AND c.marshal_id=?${contentScope.sql} ORDER BY c.created_at DESC LIMIT 8`, req.params.id, ...contentScope.params);
  const stats = {
    todayTasks: q.get(`SELECT COUNT(*) n FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.marshal_id=?
      AND date(t.created_at)=date('now','localtime')${taskScope.sql}`, req.params.id, ...taskScope.params)?.n || 0,
    rate: pct(q.get(`SELECT COUNT(*) n FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.marshal_id=? AND t.status='已完成'${taskScope.sql}`,
      req.params.id, ...taskScope.params)?.n || 0,
    q.get(`SELECT COUNT(*) n FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.marshal_id=?${taskScope.sql}`,
      req.params.id, ...taskScope.params)?.n || 1),
    collab: q.get(`SELECT COUNT(*) n FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.marshal_id=?
      AND t.is_collab=1 AND t.status!='已完成'${taskScope.sql}`, req.params.id, ...taskScope.params)?.n || 0,
    monthOutputs: q.get(`SELECT COUNT(*) n FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.marshal_id=?
      AND t.created_at>=?${taskScope.sql}`, req.params.id, monthStart(), ...taskScope.params)?.n || 0,
  };
  res.json({ ...m, specialists, tasks, outputs, stats });
});

// 派发任务（FR-MAR-02）：异步化——立即返回任务ID，后台AI生成，前端轮询流程状态
// 流程可视化状态机：已派发 → 生成中 → 待审阅 → 已完成/已驳回（失败可重试）
export async function dispatchMarshalTask(req, res) {
  let hold = null; // 两段式记账占扣句柄：派发前占扣，后台生成成功结算实扣、失败全额退回
  try {
    const m = activeDepartmentById(req.params.id);
    if (!m) return res.status(404).json({ error: '分部不存在或未启用' });
    const { title, type, requirement, dueAt, specialistId, collabMarshals, image, imageName } = req.body || {};
    const taskTitle = typeof title === 'string' ? title.trim() : '';
    const taskRequirement = requirement == null ? '' : typeof requirement === 'string' ? requirement.trim() : null;
    const taskType = type == null || type === '' ? '常规' : String(type).trim();
    const dueDate = dueAt == null || dueAt === '' ? null : validDateTime(dueAt);
    if (!taskTitle) return res.status(400).json({ error: '任务标题必填' });
    if (taskTitle.length > 100) return res.status(400).json({ error: '任务标题不能超过100字' });
    if (taskRequirement == null || taskRequirement.length > 8000) return res.status(400).json({ error: '任务要求必须是8000字以内的文本' });
    if (!TASK_TYPES.has(taskType)) return res.status(400).json({ error: '任务类型不正确' });
    if (dueAt && !dueDate) return res.status(400).json({ error: '截止时间不正确' });
    const taskImage = validatedTaskImage(image, imageName);
    const files = resolveRequestedAttachments(req.body?.fileIds, req.user, 6);
    const attachmentRefs = attachmentRefsForStorage(files);
    const specialist = specialistId == null || specialistId === '' ? null : Number(specialistId);
    const selectedSpecialist = specialist == null || !Number.isInteger(specialist) ? null
      : digitalEmployee(q.get('SELECT id,marshal_id,employee_idx,key,person,name,duty FROM specialists WHERE id = ? AND marshal_id = ? AND employee_idx BETWEEN 101 AND 160', specialist, m.id));
    if (specialist != null && (!Number.isInteger(specialist) || !selectedSpecialist || selectedSpecialist.active === 0)) {
      return res.status(400).json({ error: '指定数字员工不属于当前分部或未启用' });
    }
    const employeeExecution = selectedSpecialist
      ? buildEmployeeExecutionProfile(selectedSpecialist.employee_idx)
      : null;
    if (collabMarshals != null && !Array.isArray(collabMarshals)) return res.status(400).json({ error: '协同分部格式不正确' });
    const collaborators = [...new Set((collabMarshals || []).map(code => String(code).trim()).filter(Boolean))];
    if (collaborators.length > 7) return res.status(400).json({ error: '协同分部不能超过7个' });
    if (collaborators.length) {
      if (collaborators.includes(m.code)) return res.status(400).json({ error: '协同分部不能与牵头分部重复' });
      const selected = activeDepartments(q.all(`SELECT * FROM marshals WHERE code IN (${collaborators.map(() => '?').join(',')})`, ...collaborators));
      const validCodes = new Set(selected.map(row => row.code));
      if (validCodes.size !== collaborators.length) return res.status(400).json({ error: '协同分部不存在、已下线或不在当前8分部目录中' });
    }
    // 两段式记账：派发即按实际任务内容占扣（BE-C1 估算口径），异步生成不再出现"成功漏收费/失败仍收费"
    const employeeConfig = employeeExecution?.workbench?.workConfig || {};
    const estimateCreditsFn = req.app?.locals?.employeeEstimateCallCredits || estimateCallCredits;
    const holdModel = taskImage
      ? employeeConfig.visionModel || employeeConfig.textModel || textModelFor(req.user.role)
      : employeeConfig.textModel || textModelFor(req.user.role);
    precheck(req.user.id, 'text', holdModel);
    const expectedOutputTokens = employeeConfig.outputLength === 'full' ? 4500 : 2600;
    const estimatedCredits = estimateCreditsFn({
      model: holdModel,
      outputTokens: expectedOutputTokens,
      texts: [
        taskTitle,
        taskRequirement,
        employeeExecution?.systemContext || (selectedSpecialist ? `${selectedSpecialist.name}：${selectedSpecialist.duty}` : ''),
        taskImage ? '附带一张视觉证据，按多模态输入计入预授权' : '',
        ...files.map(file => file.readable && file.content
          ? `统一文件中心附件·${file.name}\n${file.content}`
          : `统一文件中心附件·${file.name}（未提取到可读正文，只记录文件证据）`),
      ],
    });
    if (employeeConfig.maxCost != null && estimatedCredits > Number(employeeConfig.maxCost)) {
      throw Object.assign(new Error(
        `本次预估需${estimatedCredits}积分，超过该员工配置的单次积分上限${employeeConfig.maxCost}分；请缩短任务或由管理员调整上限`,
      ), { status: 400 });
    }
    hold = holdCredits({
      userId: req.user.id, feature: `员工任务·${m.name}`, kind: 'text', model: holdModel,
      credits: estimatedCredits,
    });
    const taskResult = q.run(`INSERT INTO agent_tasks(
      marshal_id,specialist_id,title,type,requirement,status,is_collab,collab_marshals,due_at,created_by,
      employee_profile_version,employee_prompt_hash,employee_capabilities_snapshot,employee_config_snapshot,employee_skills_snapshot,
      employee_input_snapshot
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, m.id, specialist, taskTitle, taskType, taskRequirement,
      '生成中', collaborators.length ? 1 : 0, collaborators.join(','), dueDate, req.user.id,
      employeeExecution?.snapshot.profileVersion || null,
      employeeExecution?.snapshot.promptHash || null,
      employeeExecution ? JSON.stringify(employeeExecution.snapshot.capabilities) : null,
      employeeExecution ? JSON.stringify(employeeExecution.snapshot.config) : null,
      employeeExecution ? JSON.stringify(employeeExecution.snapshot.skills) : null,
      taskImage || attachmentRefs.length
        ? JSON.stringify({
          ...(taskImage?.metadata || {}),
          attachments: attachmentRefs,
        })
        : null);
    const taskId = taskResult.lastInsertRowid;

    // 立即返回，AI生成转后台执行——用户可继续做其他工作
    res.json({
      taskId,
      status: '生成中',
      async: true,
      msg: '任务已派发，数字员工正在生成，可在任务列表查看进度',
      snapshot: employeeExecution ? {
        profileVersion: employeeExecution.snapshot.profileVersion,
        promptHash: employeeExecution.snapshot.promptHash,
        capabilityCount: employeeExecution.snapshot.capabilities.length,
        configVersion: employeeExecution.workbench.workConfig.version,
        inputEvidence: taskImage || attachmentRefs.length
          ? {
            ...(taskImage?.metadata || {}),
            attachments: attachmentRefs,
          }
          : null,
      } : null,
    });

    const userId = req.user.id, userRole = req.user.role, userName = req.user.name, tenantId = curTenant();
    const employeeWebSearch = req.app?.locals?.employeeWebSearch;
    const employeeGenerate = req.app?.locals?.employeeGenerate;
    setImmediate(() => runWithTenant(tenantId, async () => {
      try {
        const out = await marshalWork(
          m,
          { title: taskTitle, type: taskType, requirement: taskRequirement },
          userRole,
          {
            employeeExecution,
            image: taskImage?.dataUrl || null,
            attachments: files,
            webSearchFn: employeeWebSearch,
            generateFn: employeeGenerate,
          },
        );
        // 结算：按真实用量多退少补；结算失败也按占扣额入账（产出已生成，绝不漏计费）
        let bill;
        try {
          bill = settleHold(hold, { usage: out.usage, model: out.model, aiMode: out.mode }) || { credits: hold.credits, balance: hold.balance };
        } catch (settleError) {
          console.error('[credits] 员工任务结算失败，保留预授权占扣待人工对账:', settleError?.message);
          bill = { credits: hold.credits, balance: hold.balance };
        }
        const risk = applyRiskControl({ type: taskType, title: taskTitle, body: out.text });
        const configuredApproval = employeeExecution?.workbench?.workConfig?.approvalMode || 'auto_draft';
        const configuredReviewRequired = ['owner_review', 'manager_review'].includes(configuredApproval);
        let contentId;
        // 不变量：只要内容状态是“待审核”，同一事务内就必须生成一张待审核审批单。
        // 这样 auto_draft 也只是“自动形成草稿”，不会变成无人可审、又无法提交的孤儿状态。
        db.exec('BEGIN IMMEDIATE');
        try {
          const contentResult = q.run(`INSERT INTO contents(type,title,body,topic,status,risk_flags,risk_level,ai_mode,creator_id,marshal_id)
            VALUES(?,?,?,?,?,?,?,?,?,?)`, '员工产出', `${m.name}：${taskTitle}`, out.text, taskTitle, '待审核',
          JSON.stringify(risk.hits), risk.level, out.mode, userId, m.id);
          contentId = Number(contentResult.lastInsertRowid);
          recordKbCitations({ targetType: 'content', targetId: contentId, kb: out.kb }); // AI-C2 引用溯源
          q.run(`UPDATE agent_tasks
            SET status = '待审阅', output_id = ?, employee_web_snapshot = ?
            WHERE id = ?`,
          contentId, JSON.stringify(out.web || null), taskId);
          createApproval({
            targetType: 'content',
            targetId: contentId,
            title: `${m.name}：${taskTitle}`,
            summary: out.text,
            riskLevel: risk.level,
            rulesHit: [
              ...risk.hits,
              'employee_output_review',
              ...(configuredReviewRequired ? [`employee_approval:${configuredApproval}`] : []),
            ],
            submitterId: userId,
          });
          db.exec('COMMIT');
        } catch (persistError) {
          try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
          throw persistError;
        }
        notify(userId, 'marshal', `${m.name}已完成「${taskTitle}」`, `产出已生成，等待您审阅（消耗${bill.credits}积分）`);
      } catch (e) {
        // 异步生成失败：全额退回占扣，客户不为失败产出付费
        try { releaseHold(hold, `员工任务生成失败（${String(e?.message || '').slice(0, 60)}），预授权全额退回`); } catch { /* 释放失败留待人工对账 */ }
        q.run(`UPDATE agent_tasks SET status = '失败' WHERE id = ?`, taskId);
        notify(userId, 'marshal', `${m.name}任务「${taskTitle}」生成失败`, `${String(e.message).slice(0, 100)}（预扣积分已退回）`);
      }
      try { logOp({ id: userId, name: userName }, '餐饮数字员工', '派发任务', `${m.name}:${taskTitle}`); } catch { /* task result is already durable */ }
    }));
  } catch (e) {
    // 派发在响应前失败（含占扣后建任务失败）：全额退回占扣；已进入后台的 hold 由后台结算，不会走到这里
    if (hold && !res.headersSent) { try { releaseHold(hold, `任务派发失败（${String(e?.message || '').slice(0, 60)}），预授权全额退回`); } catch { /* 释放失败留待人工对账 */ } }
    res.status(e.status || 500).json({ error: e.message });
  }
}

r.post('/:id/tasks', dispatchMarshalTask);

// 任务状态轮询（流程可视化）
r.get('/tasks/:taskId/status', (req, res) => {
  const raw = q.get(`SELECT t.*, m.code marshal_code,m.name marshal_name, m.emoji marshal_emoji, m.avatar marshal_avatar,m.online marshal_online, c.body output_body, c.risk_level, c.risk_flags, c.status output_status
    FROM agent_tasks t JOIN marshals m ON m.id = t.marshal_id
    LEFT JOIN contents c ON c.id=t.output_id AND c.tenant_id=t.tenant_id
    WHERE t.tenant_id=${curTenant()} AND t.id=?`, req.params.taskId);
  const t = mergeJoinedMarshal(raw);
  if (!t || !canAccessOwner(req.user, t.created_by)) return res.status(404).json({ error: '任务不存在或无权查看' });
  const stepIndex = t.status === '生成中' ? 0 : t.status === '待审阅' ? 1 : t.status === '已完成' ? 2 : t.status === '已驳回' ? 2 : t.status === '失败' ? 0 : 1;
  res.json({
    ...t,
    executionSnapshot: executionSnapshot(t, req.user),
    flow: ['已派发', 'AI生成中', '待审阅', t.status === '已驳回' ? '已驳回' : '已完成'],
    stepIndex: stepIndex + 1,
    failed: t.status === '失败',
  });
});

// 数字员工对话：会话持久化（左栏历史）+ 技能注入（右栏加载 20 办公技能库）+ 多模态
// 技能库见 engines/skills.js；前端拿结构化清单（key/name/分类/图标/描述）渲染勾选
r.get('/skills/common', (req, res) => res.json(skillsForClient()));

// 脚本技能：数字员工出 Markdown → 渲染成真实 Office 文件（可下载）
const SKILL_UPLOAD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'uploads', 'skills');
function fileSkillGuide(format, label, message) {
  const demand = `需求：${message}`;
  if (format === 'pptx') {
    return `请调用已加载的 PPT 演示技能，为以下需求输出可直接渲染成 PowerPoint 的 Markdown 源稿。
硬性规则：
1. 严格按用户要求的页数输出；用户要求5页就只能输出5页。
2. 每页之间必须用单独一行 --- 分隔。
3. 每页只允许一个 # 标题，标题下最多4条 - 要点；每条要点不超过24个汉字。
4. 不要输出“今日目标/具体动作/执行人/截止时间/检查标准”等过程说明。
5. 不要输出讲述逻辑、备注、内部解释；只输出观众能看到的PPT正文。
6. 表格最多4行3列；除非必要，优先用短要点。
${demand}`;
  }
  if (format === 'docx') {
    return `请调用已加载的 Word 文档撰写技能，为以下需求输出可直接渲染成 Word 的 Markdown 正文。
硬性规则：
1. 只输出最终文档正文，不要输出备注、解释、写作过程或“我将为你”。
2. 用 # 作为文档标题；用 ## / ### 组织章节。
3. 正式文档必须包含：摘要、正文章节、行动/清单或表格、结论。
4. 表格使用标准 Markdown 表格；每张表不超过6列。
5. 语气要像可交付给老板/团队的正式文件，不要闲聊。
${demand}`;
  }
  if (format === 'xlsx') {
    return `请调用已加载的 Excel 表格技能，为以下需求输出可直接渲染成 Excel 的 Markdown 表格源稿。
硬性规则：
1. 只输出表格、字段说明和公式，不要输出备注、解释、写作过程或“我将为你”。
2. 至少输出1张标准 Markdown 表格，第一行必须是字段名。
3. 字段要可落地录入；涉及计算时给出 Excel/WPS 可用公式。
4. 每张表不超过8列、12行；需要多表时用 ## 标出工作表名称。
5. 不要用空泛建议替代表格结果。
${demand}`;
  }
  if (format === 'pdf') {
    return `请调用已加载的 PDF 报告技能，为以下需求输出可直接排版成正式PDF的 Markdown 正文。
硬性规则：
1. 只输出最终报告正文，不要输出解释、写作过程或占位废话。
2. 用 # / ## / ### 组织标题层级，正文短段落，关键结论使用清单或表格。
3. 至少包含：摘要、关键判断、数据/事实依据、执行建议、风险边界、结论。
4. 所有事实必须优先引用用户上传资料与知识库，不得臆造数据。
5. 语言适合直接提交给老板、客户或团队。
${demand}`;
  }
  return `请调用已加载的 ${label} 技能，为以下需求输出可直接排版成【${label}】文件的 Markdown 正文。只输出正文，不要额外解释。
${demand}`;
}
r.post('/:id/skill-file', async (req, res) => {
  let hold = null; // 两段式记账占扣句柄：生成前占扣，完成后按真实用量结算多退少补
  try {
    const m = activeDepartmentById(req.params.id);
    if (!m) return res.status(404).json({ error: '分部不存在或未启用' });
    const { message, format, fileIds } = req.body || {};
    const fsk = FILE_SKILLS[format];
    if (!fsk) return res.status(400).json({ error: '不支持的文件类型' });
    const demand = typeof message === 'string' ? message.trim() : '';
    if (!demand) return res.status(400).json({ error: '请描述要生成的内容' });
    if (demand.length > MAX_MESSAGE_CHARS) return res.status(400).json({ error: '生成要求不能超过20000字' });
    precheckByRole(req.user.id, 'text', req.user.role);
    const files = resolveRequestedAttachments(fileIds, req.user, 6);
    const guide = fileSkillGuide(format, fsk.label, demand);
    // 两段式记账（BE-C1）：按实际要发送的指令+附件内容占扣，生成完成后结算多退少补
    const holdModel = textModelFor(req.user.role);
    hold = holdCredits({
      userId: req.user.id, feature: `生成${fsk.label}·${m.name}`, kind: 'text', model: holdModel,
      credits: estimateCallCredits({ model: holdModel, texts: [guide, ...files.map(a => String(a.content || '').slice(0, 5000))] }),
    });
    const out = await marshalChat(m, { message: guide, originalMessage: demand, history: [], role: req.user.role, skills: [format], attachments: files, signal: req.requestSignal });
    // 产出已生成：从此绝不释放占扣（结算失败也按占扣额入账，宁多勿漏）
    const settlingHold = hold; hold = null;
    let bill;
    try {
      bill = settleHold(settlingHold, { usage: out.usage, model: out.model, aiMode: out.mode }) || { credits: settlingHold.credits, balance: settlingHold.balance };
    } catch (settleError) {
      console.error('[credits] 技能文件结算失败，保留预授权占扣待人工对账:', settleError?.message);
      bill = { credits: settlingHold.credits, balance: settlingHold.balance };
    }
    const buf = await fsk.fn(out.text, demand.slice(0, 30));
    const tenantDir = path.join(SKILL_UPLOAD_DIR, String(curTenant()));
    fs.mkdirSync(tenantDir, { recursive: true });
    const fname = `${fsk.label}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}.${fsk.ext}`;
    const filePath = path.join(tenantDir, fname);
    const fileUrl = `/uploads/skills/${curTenant()}/${encodeURIComponent(fname)}`;
    let artifact;
    try {
      fs.writeFileSync(filePath, buf, { flag: 'wx' });
      artifact = q.run(`INSERT INTO generated_artifacts(user_id,source_type,source_id,title,format,content,file_url,file_name,metadata)
        VALUES(?,?,?,?,?,?,?,?,?)`, req.user.id, 'marshal_skill', m.id, demand.slice(0, 100), format, out.text, fileUrl, fname,
      JSON.stringify({ size: buf.length, marshalCode: m.code, marshalName: m.name }));
    } catch (error) {
      try { fs.rmSync(filePath, { force: true }); } catch { /* best-effort cleanup */ }
      throw error;
    }
    logOp(req.user, '餐饮数字员工', `生成${fsk.label}`, m.name);
    res.json({ reply: out.text, fileUrl, fileName: fname, size: buf.length, artifactId: artifact.lastInsertRowid, billing: bill });
  } catch (e) {
    // 生成前失败：全额退回占扣（产出已生成的路径 hold 已置空，不会误退）
    if (hold) { try { releaseHold(hold, `技能文件未生成（${String(e?.message || '').slice(0, 60)}），预授权全额退回`); } catch { /* 释放失败留待人工对账 */ } }
    res.status(e.status || 500).json({ error: e.message });
  }
});

r.get('/:id/chats', (req, res) => {
  if (!activeDepartmentById(req.params.id)) return res.status(404).json({ error: '分部不存在或未启用' });
  res.json(q.all(`SELECT s.*, (SELECT COUNT(*) FROM marshal_chat_msgs mm WHERE mm.tenant_id=s.tenant_id AND mm.session_id=s.id) msg_count
    FROM marshal_chat_sessions s WHERE s.tenant_id = ? AND s.marshal_id = ? AND s.user_id = ?
    ORDER BY COALESCE(s.pinned,0) DESC,COALESCE(s.updated_at,s.created_at) DESC LIMIT 30`,
    curTenant(), req.params.id, req.user.id));
});
r.get('/chats/:sid/messages', (req, res) => {
  const sess = q.get('SELECT * FROM marshal_chat_sessions WHERE tenant_id=? AND id = ? AND user_id = ?', curTenant(), req.params.sid, req.user.id);
  if (!sess || !activeDepartmentById(sess.marshal_id)) return res.status(404).json({ error: '会话不存在' });
  res.json(q.all('SELECT id, role, content, image, attachments_json, artifact_id, created_at FROM marshal_chat_msgs WHERE tenant_id=? AND session_id = ? ORDER BY id', curTenant(), req.params.sid));
});

r.put('/chats/:sid', (req, res) => {
  const sess = q.get('SELECT * FROM marshal_chat_sessions WHERE tenant_id=? AND id=? AND user_id=?', curTenant(), req.params.sid, req.user.id);
  if (!sess || !activeDepartmentById(sess.marshal_id)) return res.status(404).json({ error: '会话不存在' });
  const { title, pinned, memory } = req.body || {};
  if (title !== undefined) q.run(`UPDATE marshal_chat_sessions SET title=?,updated_at=datetime('now','localtime') WHERE id=?`, String(title).trim().slice(0, 60) || sess.title, sess.id);
  if (pinned !== undefined) q.run(`UPDATE marshal_chat_sessions SET pinned=?,updated_at=datetime('now','localtime') WHERE id=?`, pinned ? 1 : 0, sess.id);
  if (memory !== undefined) q.run(`UPDATE marshal_chat_sessions SET memory=?,updated_at=datetime('now','localtime') WHERE id=?`, String(memory).slice(0, 8000), sess.id);
  res.json(q.get(`SELECT * FROM marshal_chat_sessions WHERE tenant_id=? AND id=?`, curTenant(), sess.id));
});

r.post('/chats/:sid/memory', (req, res) => {
  const sess = q.get('SELECT * FROM marshal_chat_sessions WHERE tenant_id=? AND id=? AND user_id=?', curTenant(), req.params.sid, req.user.id);
  if (!sess || !activeDepartmentById(sess.marshal_id)) return res.status(404).json({ error: '会话不存在' });
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: '记忆内容不能为空' });
  const out = q.run(`INSERT INTO conversation_memories(user_id,scope,session_id,title,content,tags) VALUES(?,?,?,?,?,?)`,
    req.user.id, 'marshal', sess.id, String(req.body?.title || sess.title || '数字员工会话记忆').slice(0, 80), content.slice(0, 6000), JSON.stringify(req.body?.tags || []));
  const combined = [sess.memory, content].filter(Boolean).join('\n---\n').slice(-8000);
  q.run(`UPDATE marshal_chat_sessions SET memory=?,updated_at=datetime('now','localtime') WHERE id=?`, combined, sess.id);
  res.json({ id: out.lastInsertRowid, memory: combined });
});

r.post('/:id/chat', async (req, res) => {
  let hold = null; // 两段式记账占扣句柄：开流前占扣，流结束后结算多退少补，失败全额退回
  try {
    const m = activeDepartmentById(req.params.id);
    if (!m) return res.status(404).json({ error: '分部不存在或未启用' });
    const { message, image, sessionId, skills, fileIds } = req.body || {};
    const chatText = message == null ? '' : typeof message === 'string' ? message.trim() : null;
    if (chatText == null) return res.status(400).json({ error: '消息必须是文本' });
    if (chatText.length > MAX_MESSAGE_CHARS) return res.status(400).json({ error: '消息不能超过20000字' });
    if (image != null && typeof image !== 'string') return res.status(400).json({ error: '图片格式不支持' });
    if (image && !/^data:image\/(png|jpe?g|webp);base64,/.test(image)) return res.status(400).json({ error: '图片格式不支持' });
    if (image && image.length > MAX_INLINE_IMAGE_CHARS) return res.status(413).json({ error: '图片超过8MB，请压缩后重试' });
    if (skills != null && !Array.isArray(skills)) return res.status(400).json({ error: '技能参数格式不正确' });
    const safeSkills = [...new Set((skills || []).map(item => String(item).trim()).filter(Boolean))].slice(0, 20);
    if (safeSkills.some(key => !skillByKey(key))) return res.status(400).json({ error: '技能参数中包含未知技能' });
    const files = resolveRequestedAttachments(fileIds, req.user, 6);
    if (!chatText && !image && !files.length) return res.status(400).json({ error: '消息或附件不能为空' });
    precheckByRole(req.user.id, 'text', req.user.role);

    // 会话持久化：无 sessionId 则新建
    let sid = Number(sessionId || 0);
    if (sessionId && (!Number.isInteger(sid) || sid <= 0)) return res.status(400).json({ error: '会话标识不正确' });
    if (sid) {
      const existing = q.get(`SELECT id FROM marshal_chat_sessions WHERE tenant_id=? AND id=? AND user_id=? AND marshal_id=?`, curTenant(), sid, req.user.id, m.id);
      if (!existing) return res.status(404).json({ error: '会话不存在' });
    }
    if (!sid) {
      const r0 = q.run('INSERT INTO marshal_chat_sessions(marshal_id,user_id,title) VALUES(?,?,?)',
        m.id, req.user.id, (chatText || files[0]?.name || '图片分析').slice(0, 24));
      sid = r0.lastInsertRowid;
    }
    const storedImage = image && image.length <= 400000 ? image : null;
    q.run('INSERT INTO marshal_chat_msgs(session_id,role,content,image,attachments_json) VALUES(?,?,?,?,?)', sid, 'user', chatText, storedImage,
      files.length ? JSON.stringify(attachmentRefsForStorage(files)) : null);

    // 技能注入：选中的技能转为输出指令（来自 20 办公技能库）
    const finalMsg = chatText + directivesFor(safeSkills);
    const hist = rehydrateMessageHistory(q.all(`SELECT role,content,attachments_json FROM marshal_chat_msgs WHERE tenant_id=? AND session_id=?
      AND id < (SELECT MAX(id) FROM marshal_chat_msgs WHERE tenant_id=? AND session_id=?) ORDER BY id DESC LIMIT 12`, curTenant(), sid, curTenant(), sid).reverse(), req.user);
    const sess = q.get(`SELECT memory,summary FROM marshal_chat_sessions WHERE tenant_id=? AND id=?`, curTenant(), sid) || {};
    const sharedMemory = q.all(`SELECT content FROM conversation_memories WHERE tenant_id=? AND user_id=? AND scope='marshal' AND (session_id=? OR session_id IS NULL) AND pinned=1 ORDER BY id DESC LIMIT 8`,
      curTenant(), req.user.id, sid).map(x => x.content).reverse().join('\n');
    const memoryText = [sess.summary, sess.memory, sharedMemory].filter(Boolean).join('\n');
    // 两段式记账（BE-C1/BE-H2）：开流前按"实际将要发送"的消息+历史+记忆+附件占扣保守上限，
    // 余额不足在交付任何内容前 402；结算在流结束后按真实用量多退少补。发图时预留识图 token 余量。
    const holdModel = textModelFor(req.user.role);
    hold = holdCredits({
      userId: req.user.id, feature: `员工对话·${m.name}`, kind: 'text', model: holdModel,
      credits: estimateCallCredits({
        model: holdModel, overheadTokens: image ? 8000 : undefined,
        texts: [finalMsg, ...hist.map(h => h.content), memoryText.slice(0, 5000), ...files.map(a => String(a.content || '').slice(0, 5000))],
      }),
    });

    // 流式（SSE）：stream=true 时边生成边推 delta，通道切换推 reset，结束推 done+元数据
    const useStream = req.body?.stream === true;
    let sendEvent = null;
    if (useStream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      sendEvent = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    }
    const out = await marshalChat(m, { message: finalMsg || '', originalMessage: chatText, history: hist, role: req.user.role, image, skills: safeSkills,
      attachments: files, memory: memoryText, signal: req.requestSignal,
      onDelta: sendEvent ? (t => sendEvent({ delta: t })) : undefined,
      onReset: sendEvent ? (() => sendEvent({ reset: true })) : undefined });
    // 产出已生成：从此绝不释放占扣（结算失败也按占扣额入账，宁多勿漏），杜绝"答案已交付却不计费"
    const settlingHold = hold; hold = null;
    let bill;
    try {
      bill = settleHold(settlingHold, { usage: out.usage, model: out.model, aiMode: out.mode })
        || { credits: settlingHold.credits, balance: settlingHold.balance };
    } catch (settleError) {
      console.error('[credits] 员工对话结算失败，保留预授权占扣待人工对账:', settleError?.message);
      bill = { credits: settlingHold.credits, balance: settlingHold.balance };
    }
    const msg = q.run('INSERT INTO marshal_chat_msgs(session_id,role,content) VALUES(?,?,?)', sid, 'assistant', out.text);
    // AI-H1：员工对话输出与内容生产仓同口径过风控（标记+进审批）；AI-C2：引用的知识文档落库可溯源
    const risk = applyChatRiskControl({ targetType: 'marshal_chat_msg', targetId: msg.lastInsertRowid, title: `员工对话输出：${m.name}`, text: out.text, submitterId: req.user.id });
    recordKbCitations({ targetType: 'marshal_chat_msg', targetId: msg.lastInsertRowid, kb: out.kb });
    const latest = q.all(`SELECT role,content FROM marshal_chat_msgs WHERE tenant_id=? AND session_id=? ORDER BY id DESC LIMIT 8`, curTenant(), sid).reverse();
    const summary = latest.map(x => `${x.role === 'user' ? '用户' : '数字员工'}：${String(x.content || '').replace(/\s+/g, ' ').slice(0, 220)}`).join('\n').slice(0, 3500);
    q.run(`UPDATE marshal_chat_sessions SET summary=?,updated_at=datetime('now','localtime') WHERE id=?`, summary, sid);
    logOp(req.user, '餐饮数字员工', '员工对话', m.name);
    const payload = { sessionId: sid, assistantMessageId: msg.lastInsertRowid, reply: out.text, mode: out.mode, model: out.model, billing: bill, risk, kb: out.kb };
    if (sendEvent) { sendEvent({ done: true, ...payload }); res.end(); }
    else res.json(payload);
  } catch (e) {
    // 未交付任何产出即失败（含中途取消）：全额退回占扣；已结算的 hold 因幂等保护不会被二次退款
    if (hold) { try { releaseHold(hold, `员工对话未完成（${String(e?.message || '').slice(0, 60)}），预授权全额退回`); } catch { /* 释放失败留待人工对账 */ } }
    if (req.requestSignal?.aborted) { if (res.headersSent && !res.writableEnded) res.end(); return; }
    if (res.headersSent) { // SSE 已开始：错误以事件下发再关流
      if (!res.writableEnded) { res.write(`data: ${JSON.stringify({ error: e.message, requestId: req.requestId })}\n\n`); res.end(); }
      return;
    }
    res.status(e.status || 500).json({ error: e.message, requestId: req.requestId });
  }
});

// 产出审阅（FR-MAR-05）
r.post('/outputs/:outputId/review', (req, res) => {
  const { decision, reason } = req.body || {};
  const c = q.get(`SELECT * FROM contents WHERE tenant_id = ${curTenant()} AND id = ?`, req.params.outputId);
  if (!c || !activeDepartmentById(c.marshal_id) || !canAccessOwner(req.user, c.creator_id)) return res.status(404).json({ error: '产出不存在或无权审阅' });
  if (!['adopt', 'reject'].includes(decision)) return res.status(400).json({ error: '请选择采纳或驳回' });
  if (decision === 'adopt' && ['可使用', '已发布'].includes(c.status)) return res.json({ ok: true, alreadyReviewed: true });
  if (decision === 'reject' && c.status === '已驳回') return res.json({ ok: true, alreadyReviewed: true });
  if (decision === 'adopt') {
    if (c.risk_level === 'high' && !['boss', 'ops_director'].includes(req.user.role))
      return res.status(403).json({ error: '高风险产出需总监及以上审阅' });
    db.exec('BEGIN IMMEDIATE');
    try {
      q.run(`UPDATE contents SET status='可使用' WHERE tenant_id=? AND id=?`, curTenant(), c.id);
      q.run(`UPDATE agent_tasks SET status='已完成' WHERE tenant_id=? AND output_id=?`, curTenant(), c.id);
      q.run('INSERT INTO kb_docs(category,title,body,enabled) VALUES(?,?,?,1)', '员工产出', c.title, c.body);
      q.run(`INSERT INTO biz_assets(name,category,value,status,use_count,owner,source_type,source_id,creator_id,note)
             VALUES(?,?,?,?,?,?,?,?,?,?)`, c.title, '知识资产', 3000, '使用中', 0, '餐饮数字员工', 'kb_marshal', c.id, req.user.id,
        `员工产出被${req.user.name || '管理者'}采纳后自动沉淀为知识资产`);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  } else {
    if (!reason) return res.status(400).json({ error: '驳回必须填写理由' });
    db.exec('BEGIN IMMEDIATE');
    try {
      q.run(`UPDATE contents SET status='已驳回' WHERE tenant_id=? AND id=?`, curTenant(), c.id);
      q.run(`UPDATE agent_tasks SET status='已驳回' WHERE tenant_id=? AND output_id=?`, curTenant(), c.id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }
  logOp(req.user, '餐饮数字员工', decision === 'adopt' ? '采纳产出' : '驳回产出', `content#${c.id}`);
  res.json({ ok: true });
});

r.get('/collab/tasks', (req, res) => {
  const scope = userScopeClause(req.user, 't.created_by');
  res.json(q.all(`SELECT t.*,m.code marshal_code,m.name marshal_name,m.emoji marshal_emoji,m.avatar marshal_avatar,m.online marshal_online FROM agent_tasks t JOIN marshals m ON m.id = t.marshal_id
    WHERE t.tenant_id = ${curTenant()} AND t.is_collab = 1${scope.sql} ORDER BY t.created_at DESC LIMIT 10`, ...scope.params)
    .map(row => mergeJoinedMarshal(row)).filter(Boolean));
});

export default r;

import { Router } from 'express';
import { runWithTenant } from '../db.js';
import {
  assertWorkbenchManager,
  buildEmployeeWorkbench,
  updateEmployeePrompt,
  updateEmployeeSkills,
  updateEmployeeWorkConfig,
} from '../employee-workbench.js';
import {
  createSkillLearningRun,
  getSkillLearningRun,
  listSkillLearningRuns,
  startSkillLearningRun,
} from '../engines/employee-skill-learning.js';
import { dispatchMarshalTask } from './marshals.js';

const r = Router();
const TASK_PAGE_SIZE = 8;
const TASK_PAGE_MAX = 50;

function sendError(res, error) {
  res.status(error?.status || 400).json({ error: error?.message || '数字员工工作台操作失败' });
}

function taskPagination(req, res) {
  const offset = req.query.offset == null ? 0 : Number(req.query.offset);
  const limit = req.query.limit == null ? TASK_PAGE_SIZE : Number(req.query.limit);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    res.status(400).json({ error: '任务分页 offset 必须是非负整数' });
    return null;
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TASK_PAGE_MAX) {
    res.status(400).json({ error: `任务分页 limit 必须是 1-${TASK_PAGE_MAX} 的整数` });
    return null;
  }
  return { taskOffset: offset, taskLimit: limit };
}

r.get('/restaurant/:idx', (req, res) => {
  try {
    const pagination = taskPagination(req, res);
    if (!pagination) return;
    res.set('Cache-Control', 'private, no-store');
    res.json(buildEmployeeWorkbench(req.params.idx, {
      user: req.user,
      redactRestricted: true,
      ...pagination,
    }));
  } catch (error) {
    sendError(res, error);
  }
});

r.get('/restaurant/:idx/tasks', (req, res) => {
  try {
    const pagination = taskPagination(req, res);
    if (!pagination) return;
    const profile = buildEmployeeWorkbench(req.params.idx, {
      user: req.user,
      redactRestricted: true,
      ...pagination,
    });
    res.set('Cache-Control', 'private, no-store');
    res.json({
      tasks: profile.runtime.recentTasks || [],
      page: profile.runtime.taskPage,
      lastTask: profile.runtime.lastTask || null,
    });
  } catch (error) {
    sendError(res, error);
  }
});

r.put('/restaurant/:idx/prompt', (req, res) => {
  try {
    const hasTemplate = req.body && (Object.hasOwn(req.body, 'template') || Object.hasOwn(req.body, 'overrideTemplate'));
    if (!hasTemplate) {
      return res.status(400).json({ error: 'template或overrideTemplate字段必填；传空字符串表示恢复出厂提示词' });
    }
    res.json(updateEmployeePrompt(
      req.params.idx,
      Object.hasOwn(req.body, 'overrideTemplate') ? req.body.overrideTemplate : req.body.template,
      req.user,
    ));
  } catch (error) {
    sendError(res, error);
  }
});

r.put('/restaurant/:idx/config', (req, res) => {
  try {
    const config = req.body?.values ?? req.body?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return res.status(400).json({ error: 'config或values必须是对象' });
    }
    res.json(updateEmployeeWorkConfig(req.params.idx, config, req.user));
  } catch (error) {
    sendError(res, error);
  }
});

r.put('/restaurant/:idx/skills', (req, res) => {
  try {
    res.json(updateEmployeeSkills(req.params.idx, req.body, req.user));
  } catch (error) {
    sendError(res, error);
  }
});

function restaurantLearningEmployee(workbench) {
  return {
    domain: 'restaurant',
    idx: workbench.identity.idx,
    name: workbench.identity.name,
    department: workbench.identity.department?.name || '',
    duty: workbench.identity.duty || workbench.jobProfile?.duty || '',
    positionSkill: workbench.jobProfile?.positionSkill || '',
    existingSkills: workbench.skillLibrary.enabled || [],
    profileFingerprint: workbench.provenance?.canonicalFingerprint
      || workbench.provenance?.profileVersion
      || '',
  };
}

r.get('/restaurant/:idx/learning-runs', (req, res) => {
  try {
    assertWorkbenchManager(req.user);
    const workbench = buildEmployeeWorkbench(req.params.idx, { user: req.user });
    res.set('Cache-Control', 'private, no-store');
    res.json({
      runs: listSkillLearningRuns({
        tenantId: req.user.tenant_id,
        domain: 'restaurant',
        employeeIdx: workbench.identity.idx,
        limit: req.query.limit,
      }),
    });
  } catch (error) {
    sendError(res, error);
  }
});

r.get('/restaurant/:idx/learning-runs/:runId', (req, res) => {
  try {
    assertWorkbenchManager(req.user);
    const workbench = buildEmployeeWorkbench(req.params.idx, { user: req.user });
    const run = getSkillLearningRun({
      tenantId: req.user.tenant_id,
      runId: req.params.runId,
      domain: 'restaurant',
      employeeIdx: workbench.identity.idx,
    });
    if (!run) return res.status(404).json({ error: '员工进修记录不存在' });
    res.set('Cache-Control', 'private, no-store');
    res.json({ run });
  } catch (error) {
    sendError(res, error);
  }
});

r.post('/restaurant/:idx/learn', (req, res) => {
  try {
    assertWorkbenchManager(req.user);
    const workbench = buildEmployeeWorkbench(req.params.idx, { user: req.user });
    const employee = restaurantLearningEmployee(workbench);
    const tenantId = Number(req.user.tenant_id || 1);
    const run = createSkillLearningRun({
      tenantId,
      domain: 'restaurant',
      employeeIdx: employee.idx,
      employeeName: employee.name,
      profileFingerprint: employee.profileFingerprint,
      skillsBefore: workbench.skillLibrary.learned.length,
      createdBy: req.user.id,
    });
    const user = { ...req.user };
    setImmediate(() => {
      runWithTenant(tenantId, () => startSkillLearningRun({
        tenantId,
        runId: run.id,
        user,
        employee,
        model: workbench.workConfig?.textModel || null,
        persistSkills: (freshSkills) => {
          const current = buildEmployeeWorkbench(employee.idx, { user });
          const profile = updateEmployeeSkills(employee.idx, {
            skills: [
              ...current.skillLibrary.required,
              ...current.skillLibrary.optional,
              ...current.skillLibrary.learned,
              ...freshSkills,
            ],
          }, user);
          return { total: profile.skillLibrary.learned.length };
        },
      })).catch(error => {
        console.error('[employee-skill-learning] restaurant background failed:', error?.message || error);
      });
    });
    res.status(202).json({
      run,
      started: true,
      message: `${employee.name}已开始全网进修；系统会隔离执行WebSearch、受控读取原网页，并把有来源的新技能写回技能库。`,
    });
  } catch (error) {
    sendError(res, error);
  }
});

r.put('/restaurant/:idx/capabilities', (req, res) => {
  try {
    assertWorkbenchManager(req.user);
    buildEmployeeWorkbench(req.params.idx);
    res.status(400).json({ error: '岗位必备能力已锁定，不能停用、删除或降级' });
  } catch (error) {
    sendError(res, error);
  }
});

r.post('/restaurant/:idx/dispatch', async (req, res) => {
  try {
    const workbench = buildEmployeeWorkbench(req.params.idx, { user: req.user, redactRestricted: true });
    if (!workbench.permissions.canDispatch) return res.status(403).json({ error: '当前账号无权派活' });
    req.params.id = String(workbench.identity.department.id);
    req.body = {
      ...(req.body || {}),
      specialistId: workbench.identity.specialistId,
    };
    return await dispatchMarshalTask(req, res);
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
  }
});

export default r;

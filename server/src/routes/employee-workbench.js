import { Router } from 'express';
import { runWithTenant } from '../db.js';
import {
  assertWorkbenchManager,
  buildEmployeeWorkbench,
  employeeSkillSupplementView,
  reviewEmployeeSkillSupplement,
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
import { classifyEmployeeIntent, INTENT_LABELS } from '../engines/employee-intent-router.js';
import { fillQuestionTemplate, questionTemplatesForEmployee } from '../engines/employee-question-templates.js';
import {
  buildFollowupQuestions,
  getSlotPreferences,
  saveSlotPreferences,
  SLOT_PREFERENCE_KEYS,
} from '../engines/employee-dispatch-followups.js';
import { demoScriptsView, getDemoSample, saveDemoSampleFromTask } from '../engines/employee-demo-scripts.js';

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

// ===== PRD v2.2：技能补充包审核（FR-6）、常用问法（FR-13）、判题预览（FR-1）=====
r.get('/restaurant/:idx/skill-supplement', (req, res) => {
  try {
    const workbench = buildEmployeeWorkbench(req.params.idx, { user: req.user, redactRestricted: true });
    if (workbench.permissions?.canViewSkills !== true) {
      return res.status(403).json({ error: '仅老板或管理员可查看员工技能库' });
    }
    res.set('Cache-Control', 'private, no-store');
    res.json({
      ...employeeSkillSupplementView(workbench.identity.idx),
      canReview: workbench.permissions?.canEditSkills === true,
    });
  } catch (error) {
    sendError(res, error);
  }
});

r.put('/restaurant/:idx/skill-supplement', (req, res) => {
  try {
    const decisions = Array.isArray(req.body?.decisions)
      ? req.body.decisions
      : req.body?.cardId
        ? [req.body]
        : null;
    if (!decisions) return res.status(400).json({ error: 'decisions 必须是数组' });
    res.json(reviewEmployeeSkillSupplement(req.params.idx, decisions, req.user));
  } catch (error) {
    sendError(res, error);
  }
});

r.get('/restaurant/:idx/question-templates', (req, res) => {
  try {
    const workbench = buildEmployeeWorkbench(req.params.idx, { user: req.user, redactRestricted: true });
    const preferences = getSlotPreferences();
    const data = questionTemplatesForEmployee(workbench.identity.idx);
    res.set('Cache-Control', 'private, no-store');
    // FR-7.2：用“我的版本”保存的值预填模板；没填上的槽位前端高亮。
    res.json({
      ...data,
      items: data.items.map((item) => {
        const filled = fillQuestionTemplate(item.template, preferences.values);
        return {
          ...item,
          filled,
          unfilledSlots: [...filled.matchAll(/\{([^{}]{1,12})\}/gu)].map((match) => match[1]),
        };
      }),
      preferences: preferences.values,
    });
  } catch (error) {
    sendError(res, error);
  }
});

r.post('/restaurant/:idx/intent-preview', (req, res) => {
  try {
    const workbench = buildEmployeeWorkbench(req.params.idx, { user: req.user, redactRestricted: true });
    const title = String(req.body?.title || '').slice(0, 200);
    const requirement = String(req.body?.requirement || '').slice(0, 4000);
    if (!title.trim() && !requirement.trim()) return res.status(400).json({ error: '请输入问题后再预判题型' });
    const intent = classifyEmployeeIntent({
      employeeIdx: workbench.identity.idx,
      title,
      requirement,
      attachmentCount: Number(req.body?.attachmentCount) || 0,
      requestedType: req.body?.intentType || null,
    });
    // FR-2：缺关键业务参数时的追问（≤3，带默认值，可跳过；已保存的偏好不再问）。
    const questions = buildFollowupQuestions(intent, { preferences: getSlotPreferences() });
    res.set('Cache-Control', 'private, no-store');
    res.json({
      intent,
      questions,
      hint: `将按【${intent.label}】回答，约 ${Math.max(1, Math.round(intent.eta_seconds / 60))} 分钟`,
      switchable: Object.entries(INTENT_LABELS)
        .filter(([type]) => type !== 'team')
        .map(([type, label]) => ({ type, label })),
    });
  } catch (error) {
    sendError(res, error);
  }
});

// FR-7.2「我的版本」：企业级常用槽位（城市/商圈/店名/品类/人均…）与“不再追问”开关。
r.get('/restaurant-preferences/slots', (req, res) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    res.json({ ...getSlotPreferences(), keys: SLOT_PREFERENCE_KEYS });
  } catch (error) {
    sendError(res, error);
  }
});

r.put('/restaurant-preferences/slots', (req, res) => {
  try {
    assertWorkbenchManager(req.user);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.values !== undefined && (typeof body.values !== 'object' || Array.isArray(body.values) || body.values === null)) {
      return res.status(400).json({ error: 'values 必须是对象' });
    }
    res.json({ ...saveSlotPreferences(body, req.user), keys: SLOT_PREFERENCE_KEYS });
  } catch (error) {
    sendError(res, error);
  }
});

// PRD v2.2 FR-9：演示话术（A1–A8 各 2 条）与样例结果。字段默认取“我的版本”。
r.get('/restaurant-demo/scripts', (req, res) => {
  try {
    const saved = getSlotPreferences().values || {};
    const fields = {};
    for (const key of ['店名', '城市', '商圈', '品类']) {
      const value = req.query?.[key];
      fields[key] = typeof value === 'string' && value.trim() ? value : saved[key] || '';
    }
    res.set('Cache-Control', 'private, no-store');
    res.json(demoScriptsView(fields));
  } catch (error) {
    sendError(res, error);
  }
});

r.get('/restaurant-demo/samples/:scriptId', (req, res) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    res.json(getDemoSample(req.params.scriptId));
  } catch (error) {
    sendError(res, error);
  }
});

r.put('/restaurant-demo/samples/:scriptId', (req, res) => {
  try {
    assertWorkbenchManager(req.user);
    res.json(saveDemoSampleFromTask(req.params.scriptId, req.body?.taskId, req.user));
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

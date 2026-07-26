import { Router } from 'express';
import {
  assertWorkbenchManager,
  buildEmployeeWorkbench,
  updateEmployeePrompt,
  updateEmployeeSkills,
  updateEmployeeWorkConfig,
} from '../employee-workbench.js';
import { dispatchMarshalTask } from './marshals.js';

const r = Router();

function sendError(res, error) {
  res.status(error?.status || 400).json({ error: error?.message || '数字员工工作台操作失败' });
}

r.get('/restaurant/:idx', (req, res) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    res.json(buildEmployeeWorkbench(req.params.idx, { user: req.user, redactRestricted: true }));
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

// 数字员工自我介绍页：/api/employee-intro/:domain/:idx
// 读：所有登录用户（一线员工也该知道 TA 是谁）；企业补充提示词原文只回给管理层（D-033/D-035）。
// 写/校验/确认：boss、admin（平台超管同工作台编辑口径）。
import { Router } from 'express';
import { requireRole } from '../util.js';
import {
  assertSelfIntroDomain,
  buildEmployeeSelfIntro,
  confirmEmployeeSelfIntro,
  updateEmployeeSelfIntro,
  verifyEmployeeSelfIntro,
} from '../engines/employee-self-intro.js';

const r = Router();
const MANAGER_ROLES = ['boss', 'admin', 'platform_super'];

function sendError(res, error) {
  res.status(error?.status || 400).json({ error: error?.message || '数字员工自我介绍操作失败' });
}

function noStore(res) {
  res.set('Cache-Control', 'private, no-store');
}

r.get('/:domain/:idx', (req, res) => {
  try {
    assertSelfIntroDomain(req.params.domain);
    noStore(res);
    res.json(buildEmployeeSelfIntro(req.params.idx, { user: req.user }));
  } catch (error) {
    sendError(res, error);
  }
});

r.put('/:domain/:idx', requireRole(...MANAGER_ROLES), (req, res) => {
  try {
    assertSelfIntroDomain(req.params.domain);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const hasText = ['text', 'selfIntro', 'ownerNotes'].some(key => Object.hasOwn(body, key));
    if (!hasText) {
      return res.status(400).json({ error: 'text 字段必填；传空字符串表示清空老板叮嘱、回落 catalog 默认介绍' });
    }
    const text = body.text ?? body.selfIntro ?? body.ownerNotes;
    noStore(res);
    res.json(updateEmployeeSelfIntro(req.params.idx, text, req.user));
  } catch (error) {
    sendError(res, error);
  }
});

r.post('/:domain/:idx/verify', requireRole(...MANAGER_ROLES), (req, res) => {
  try {
    assertSelfIntroDomain(req.params.domain);
    const mode = typeof req.body?.mode === 'string' ? req.body.mode : 'deterministic';
    const result = verifyEmployeeSelfIntro(req.params.idx, { mode });
    noStore(res);
    res.json({
      result,
      intro: buildEmployeeSelfIntro(req.params.idx, { user: req.user }),
      billing: { charged: false, credits: 0, note: '确定性校验不调用模型，不扣积分' },
    });
  } catch (error) {
    sendError(res, error);
  }
});

r.post('/:domain/:idx/confirm', requireRole(...MANAGER_ROLES), (req, res) => {
  try {
    assertSelfIntroDomain(req.params.domain);
    noStore(res);
    res.json(confirmEmployeeSelfIntro(req.params.idx, req.user));
  } catch (error) {
    sendError(res, error);
  }
});

export default r;

import { Router } from 'express';
import { q, curTenant, getTenant } from '../db.js';
import { logOp } from '../util.js';
import {
  routing,
  routingSources,
  defaultRouting,
  tenantRoutingOverride,
  allowedModelCatalog,
  isAllowedModel,
  TEXT_ROUTING_ROLES,
} from '../engines/yunwu.js';
import {
  billing,
  budgetSummary,
  usageReport,
  USAGE_GROUP_BY,
  getUserMonthlyUsage,
  estimateMaxCredits,
  DEFAULT_BUDGET_ALERT_RATIO,
} from '../engines/credits.js';

// ===== 管理后台：租户级模型路由 + 月度 AI 积分预算 + 用量报表（2026-09-02 宣讲会承诺）=====
// 由 routes/admin.js 挂载（已套 requireRole('boss','admin')），所有读写只作用于 curTenant()。
// 与 /admin/api-config（平台总部改全局 sys_config.model_routing）分层：这里是企业自己的覆盖层。
const r = Router();

const TEXT_ROLE_LABELS = Object.freeze({
  boss: '老板',
  ops_director: '运营总监',
  manager: '管理层',
  admin: '系统管理员',
  sales: '员工',
  partner: '合伙人',
});

// 价目说明：文本按"约 N 积分/千 token（输入+输出各 500）"，图片/视频按"约 N 积分/张|条"，
// 全部由 credits.js 价目表反算，前端下拉不得自行写价。
function pricingHintFor(kind, id, b = billing()) {
  const toCredits = (yuan) => Math.max(1, Math.ceil((yuan * b.marginMultiplier) / b.creditYuan));
  if (kind === 'text' || kind === 'vision') {
    const p = b.text[id] || b.text.default;
    const yuanPerK = (500 * p.in + 500 * p.out) / 1e6;
    return { unit: '千 token', credits: toCredits(yuanPerK), label: `约 ${toCredits(yuanPerK)} 积分/千 token` };
  }
  if (kind === 'image') {
    const yuan = b.image[id] ?? b.image.default;
    return { unit: '张', credits: toCredits(yuan), label: `约 ${toCredits(yuan)} 积分/张` };
  }
  const yuan = b.video[id] ?? b.video.default;
  return { unit: '条', credits: toCredits(yuan), label: `约 ${toCredits(yuan)} 积分/条` };
}

function catalogWithPricing() {
  const b = billing();
  const catalog = allowedModelCatalog();
  const decorate = (kind) => catalog[kind].map((item) => ({
    ...item,
    pricing: pricingHintFor(kind, item.id, b),
    maxPerCall: estimateMaxCredits(kind === 'vision' ? 'text' : kind, item.id, b),
  }));
  return { text: decorate('text'), image: decorate('image'), vision: decorate('vision'), video: decorate('video') };
}

function routingPayload(tid) {
  const override = tenantRoutingOverride(tid);
  return {
    tenantId: tid,
    effective: routing(tid),
    sources: routingSources(tid),
    override: override ? override.routing : null,
    overrideUpdatedBy: override?.updatedBy ?? null,
    overrideUpdatedAt: override?.updatedAt ?? null,
    defaults: defaultRouting(),
    roles: TEXT_ROUTING_ROLES.map((role) => ({ role, label: TEXT_ROLE_LABELS[role] || role })),
    catalog: catalogWithPricing(),
  };
}

// 校验并规范化租户路由覆盖：只接受 text(按角色)/image/vision/video/videoDefault，值必须在白名单内。
function normalizeTenantRouting(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('路由配置格式不正确'), { status: 400 });
  }
  const allowedKeys = new Set(['text', 'image', 'vision', 'video', 'videoDefault']);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw Object.assign(new Error(`不支持的路由字段：${key}`), { status: 400 });
  }
  const out = {};
  if (input.text !== undefined) {
    if (!input.text || typeof input.text !== 'object' || Array.isArray(input.text)) {
      throw Object.assign(new Error('text 路由必须是按角色的对象'), { status: 400 });
    }
    const text = {};
    for (const [role, model] of Object.entries(input.text)) {
      if (!TEXT_ROUTING_ROLES.includes(role)) throw Object.assign(new Error(`未知角色：${role}`), { status: 400 });
      if (model === null || model === '' || model === undefined) continue; // 留空=不覆盖该角色
      if (!isAllowedModel('text', model)) {
        throw Object.assign(new Error(`${TEXT_ROLE_LABELS[role] || role} 的文本模型「${model}」不在允许清单内`), { status: 400 });
      }
      text[role] = String(model);
    }
    if (Object.keys(text).length) out.text = text;
  }
  for (const kind of ['image', 'vision']) {
    const value = input[kind];
    if (value === undefined || value === null || value === '') continue;
    if (!isAllowedModel(kind, value)) {
      throw Object.assign(new Error(`${kind === 'image' ? '图片' : '识图'}模型「${value}」不在允许清单内`), { status: 400 });
    }
    out[kind] = String(value);
  }
  if (input.video !== undefined && input.video !== null) {
    if (!Array.isArray(input.video)) throw Object.assign(new Error('video 必须是模型清单数组'), { status: 400 });
    const video = [];
    for (const id of input.video) {
      if (!isAllowedModel('video', id)) throw Object.assign(new Error(`视频模型「${id}」不在允许清单内`), { status: 400 });
      if (!video.includes(String(id))) video.push(String(id));
    }
    if (video.length) out.video = video;
  }
  if (input.videoDefault !== undefined && input.videoDefault !== null && input.videoDefault !== '') {
    if (!isAllowedModel('video', input.videoDefault)) {
      throw Object.assign(new Error(`默认视频模型「${input.videoDefault}」不在允许清单内`), { status: 400 });
    }
    out.videoDefault = String(input.videoDefault);
  }
  return out;
}

// —— 模型路由 ——
r.get('/model-routing', (req, res) => {
  res.json(routingPayload(curTenant()));
});

r.put('/model-routing', (req, res) => {
  const tid = curTenant();
  const body = req.body || {};
  if (body.reset === true) {
    q.run('DELETE FROM tenant_model_routing WHERE tenant_id = ?', tid);
    logOp(req.user, '管理后台', '恢复平台默认模型路由', `tenant#${tid}`);
    return res.json({ ok: true, ...routingPayload(tid) });
  }
  let normalized;
  try {
    normalized = normalizeTenantRouting(body.routing ?? body);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  if (!Object.keys(normalized).length) {
    q.run('DELETE FROM tenant_model_routing WHERE tenant_id = ?', tid);
    logOp(req.user, '管理后台', '清空企业模型路由覆盖', `tenant#${tid}`);
    return res.json({ ok: true, ...routingPayload(tid) });
  }
  q.run(`INSERT INTO tenant_model_routing(tenant_id,routing_json,updated_by,updated_at)
    VALUES(?,?,?,datetime('now','localtime'))
    ON CONFLICT(tenant_id) DO UPDATE SET routing_json=excluded.routing_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
  tid, JSON.stringify(normalized), req.user?.id ?? null);
  const parts = [
    normalized.text && `文本(${Object.keys(normalized.text).map((k) => TEXT_ROLE_LABELS[k] || k).join('/')})`,
    normalized.image && '图片',
    normalized.vision && '识图',
    (normalized.video || normalized.videoDefault) && '视频',
  ].filter(Boolean).join('+');
  logOp(req.user, '管理后台', '修改企业模型路由', parts || '（空）');
  res.json({ ok: true, ...routingPayload(tid) });
});

r.delete('/model-routing', (req, res) => {
  const tid = curTenant();
  q.run('DELETE FROM tenant_model_routing WHERE tenant_id = ?', tid);
  logOp(req.user, '管理后台', '恢复平台默认模型路由', `tenant#${tid}`);
  res.json({ ok: true, ...routingPayload(tid) });
});

// —— 月度预算 ——
function budgetPayload(tid) {
  const t = getTenant(tid);
  return {
    tenantId: tid,
    monthlyCreditBudget: t?.monthly_credit_budget ?? null,
    budgetAlertRatio: Number.isFinite(Number(t?.budget_alert_ratio)) && Number(t?.budget_alert_ratio) > 0
      ? Number(t.budget_alert_ratio)
      : DEFAULT_BUDGET_ALERT_RATIO,
    balance: t?.credits ?? 0,
    summary: budgetSummary(t),
  };
}

r.get('/credit-budget', (req, res) => {
  res.json(budgetPayload(curTenant()));
});

r.put('/credit-budget', (req, res) => {
  const tid = curTenant();
  const { monthlyCreditBudget, budgetAlertRatio } = req.body || {};
  const updates = [];
  const values = [];
  if (monthlyCreditBudget !== undefined) {
    if (monthlyCreditBudget === null || monthlyCreditBudget === '') {
      updates.push('monthly_credit_budget=NULL');
    } else {
      const n = Number(monthlyCreditBudget);
      if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000) {
        return res.status(400).json({ error: '月度预算必须是 0 ~ 10 亿之间的整数积分；留空表示不限' });
      }
      updates.push('monthly_credit_budget=?');
      values.push(n);
    }
  }
  if (budgetAlertRatio !== undefined) {
    const ratio = Number(budgetAlertRatio);
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
      return res.status(400).json({ error: '预警比例必须在 0 ~ 1 之间（如 0.8 表示用到 80% 提醒）' });
    }
    updates.push('budget_alert_ratio=?');
    values.push(Math.round(ratio * 100) / 100);
  }
  if (!updates.length) return res.status(400).json({ error: '没有需要修改的预算字段' });
  q.run(`UPDATE tenants SET ${updates.join(',')} WHERE id = ?`, ...values, tid);
  const payload = budgetPayload(tid);
  logOp(req.user, '管理后台', '修改月度AI预算',
    `预算=${payload.monthlyCreditBudget == null ? '不限' : payload.monthlyCreditBudget} 预警=${Math.round(payload.budgetAlertRatio * 100)}%`);
  res.json({ ok: true, ...payload });
});

// —— 用量报表：默认本月；groupBy=day|employee|user|model|feature；排除 recharge/bonus ——
r.get('/credits/usage', (req, res) => {
  const { from, to, groupBy } = req.query || {};
  try {
    const report = usageReport({
      tenantId: curTenant(),
      from: from ? String(from) : undefined,
      to: to ? String(to) : undefined,
      groupBy: groupBy ? String(groupBy) : 'day',
    });
    res.json({ ...report, groupByOptions: USAGE_GROUP_BY });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

// —— 按人月度配额（预留接口位：可写、可读，UI 与强制拦截为后续版本，见建议清单 B1）——
r.get('/users/:id/quota', (req, res) => {
  const tid = curTenant();
  if (!q.get('SELECT id FROM users WHERE tenant_id = ? AND id = ?', tid, req.params.id)) {
    return res.status(404).json({ error: '用户不存在' });
  }
  res.json(getUserMonthlyUsage(req.params.id));
});

r.put('/users/:id/quota', (req, res) => {
  const tid = curTenant();
  if (!q.get('SELECT id FROM users WHERE tenant_id = ? AND id = ?', tid, req.params.id)) {
    return res.status(404).json({ error: '用户不存在' });
  }
  const { monthlyCreditQuota } = req.body || {};
  let value = null;
  if (monthlyCreditQuota !== undefined && monthlyCreditQuota !== null && monthlyCreditQuota !== '') {
    const n = Number(monthlyCreditQuota);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000) {
      return res.status(400).json({ error: '按人月度配额必须是 0 ~ 10 亿之间的整数积分；留空表示不限' });
    }
    value = n;
  }
  q.run('UPDATE users SET monthly_credit_quota=? WHERE tenant_id=? AND id=?', value, tid, req.params.id);
  logOp(req.user, '管理后台', '修改按人月度配额', `user#${req.params.id} ${value == null ? '不限' : value}`);
  res.json({ ok: true, ...getUserMonthlyUsage(req.params.id) });
});

export default r;

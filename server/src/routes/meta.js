import { Router } from 'express';
import { q } from '../db.js';

const r = Router();

// 新手指引版本只能由服务端推进。前端通过 GET 读取，不得自行声明版本、岗位或用户。
export const ONBOARDING_VERSION = 1;
const ONBOARDING_OUTCOMES = new Set(['completed', 'dismissed']);

function onboardingState(user) {
  const tenantId = Number(user?.tenant_id);
  const userId = Number(user?.id);
  if (!Number.isInteger(tenantId) || tenantId <= 0 || !Number.isInteger(userId) || userId <= 0) {
    return null;
  }

  // 即使路由已经运行在 tenantScope 中，这里仍同时校验主键和 tenant_id，避免以后独立复用时
  // 因遗漏作用域而读到其他企业账号的完成态。
  const row = q.get(
    `SELECT onboarding_version,onboarding_role,onboarding_completed_at,onboarding_outcome
     FROM users WHERE id=? AND tenant_id=?`,
    userId,
    tenantId,
  );
  if (!row) return null;

  const completedVersion = Number(row.onboarding_version) || 0;
  const completedRole = row.onboarding_role || null;
  const completedAt = row.onboarding_completed_at || null;
  const outcome = ONBOARDING_OUTCOMES.has(row.onboarding_outcome)
    ? row.onboarding_outcome
    : null;
  return {
    currentVersion: ONBOARDING_VERSION,
    completedVersion,
    completedRole,
    completedAt,
    outcome,
    complete:
      completedVersion === ONBOARDING_VERSION &&
      completedRole === user.role &&
      Boolean(completedAt) &&
      Boolean(outcome),
  };
}

// 业务枚举单一事实来源（审计报告 P1）：前端各页面的硬编码副本统一从这里读取。
// 颜色值为 antd Tag 预设色名，与 web/src/components/Kit.tsx 的 stageColor/gradeColor 保持一致。
const ENUMS = Object.freeze({
  // 客户阶段（与 leads.stage 现行值一致，见 seed.js stagesDist / Kit.tsx stageColor）
  stages: [
    { value: '新线索', color: 'blue' },
    { value: '已沟通', color: 'cyan' },
    { value: '已邀约', color: 'purple' },
    { value: '已到店', color: 'orange' },
    { value: '已成交', color: 'green' },
    { value: '复购', color: 'magenta' },
    { value: '已流失', color: 'default' },
  ],
  // 客户等级（与评分引擎 A/B/C 分级、Kit.tsx gradeColor 一致）
  grades: [
    { value: 'A', color: 'red' },
    { value: 'B', color: 'orange' },
    { value: 'C', color: 'default' },
  ],
  // 身份标签：与 server/src/seed.js 写入 leads.identity_tag 的清单一致
  identities: ['企业客户', '家庭顾客', '周边白领', '普通消费者'],
  // 活动类型：routes/activities.js 归一化后的现行类型 + seed.js 演示数据类型
  activityTypes: ['门店主题活动', '新品试吃会', '节日主题活动', '企业团餐沙龙', '社区联名活动', '会员日', '渠道合作活动', '门店参访活动'],
  // 活动状态：与 routes/activities.js ACTIVITY_STATUSES 一致
  activityStatuses: ['策划中', '筹备中', '报名中', '进行中', '已结束', '已复盘'],
  // 成本科目（餐饮门店口径）
  costCategories: ['食材', '人力', '房租', '水电', '营销', '其他'],
  // 数字员工任务状态（agent_tasks.status）：含 P0-1 新增的“草稿待处理 / 草稿已接受”
  agentTaskStatuses: [
    { value: '生成中', color: 'processing' },
    { value: '待审阅', color: 'gold' },
    { value: '已完成', color: 'green' },
    { value: '已驳回', color: 'red' },
    { value: '失败', color: 'red' },
    { value: '草稿待处理', color: 'orange' },
    { value: '草稿已接受', color: 'orange' },
  ],
  // 产物状态（contents.status）：含 P0-1 新增的“未达标草稿”
  contentStatuses: [
    { value: '草稿', color: 'default' },
    { value: '待审核', color: 'gold' },
    { value: '可使用', color: 'green' },
    { value: '已发布', color: 'green' },
    { value: '已驳回', color: 'red' },
    { value: '未达标草稿', color: 'orange' },
  ],
});

r.get('/enums', (req, res) => res.json(ENUMS));

r.get('/onboarding', (req, res) => {
  const state = onboardingState(req.user);
  if (!state) return res.status(404).json({ error: '当前账号不存在或不属于该企业' });
  return res.json(state);
});

r.put('/onboarding', (req, res) => {
  const outcome = req.body?.outcome;
  if (!ONBOARDING_OUTCOMES.has(outcome)) {
    return res.status(400).json({ error: 'outcome 仅支持 completed 或 dismissed' });
  }

  const tenantId = Number(req.user?.tenant_id);
  const userId = Number(req.user?.id);
  if (!Number.isInteger(tenantId) || tenantId <= 0 || !Number.isInteger(userId) || userId <= 0) {
    return res.status(404).json({ error: '当前账号不存在或不属于该企业' });
  }

  // 同一个版本、岗位和结果重复提交时不刷新完成时间，确保请求真正幂等。
  // userId / tenantId / role / version 全部取自服务端登录态，请求体里的同名字段会被忽略。
  const updated = q.run(
    `UPDATE users
     SET onboarding_version=?, onboarding_role=?, onboarding_completed_at=datetime('now','localtime'), onboarding_outcome=?
     WHERE id=? AND tenant_id=?
       AND (
         onboarding_version != ?
         OR COALESCE(onboarding_role,'') != ?
         OR COALESCE(onboarding_outcome,'') != ?
         OR onboarding_completed_at IS NULL
       )`,
    ONBOARDING_VERSION,
    req.user.role,
    outcome,
    userId,
    tenantId,
    ONBOARDING_VERSION,
    req.user.role,
    outcome,
  );
  if (!updated.changes && !onboardingState(req.user)) {
    return res.status(404).json({ error: '当前账号不存在或不属于该企业' });
  }
  return res.json(onboardingState(req.user));
});

export default r;

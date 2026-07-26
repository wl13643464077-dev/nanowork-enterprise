import { Router } from 'express';

const r = Router();

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
});

r.get('/enums', (req, res) => res.json(ENUMS));

export default r;

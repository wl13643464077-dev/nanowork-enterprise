import assert from 'node:assert/strict';

const baseUrl = String(process.env.NANOWORK_ACCEPT_BASE_URL || 'http://127.0.0.1:3107').replace(/\/+$/u, '');
const username = String(process.env.NANOWORK_ACCEPT_USERNAME || '').trim();
const password = String(process.env.NANOWORK_ACCEPT_PASSWORD || '');

if (!username || !password) {
  throw new Error('运行态验收需要 NANOWORK_ACCEPT_USERNAME 与 NANOWORK_ACCEPT_PASSWORD');
}

async function request(pathname, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  assert.ok(response.ok, `${method} ${pathname} 返回 ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

const health = await request('/api/health');
assert.equal(health.ok, true);
assert.equal(health.db, 'up');

const login = await request('/api/auth/login', {
  method: 'POST',
  body: { username, password },
});
assert.equal(login.user?.username, username);
assert.ok(['boss', 'admin', 'platform_super'].includes(login.user?.role), '运行态验收账号必须具备管理权限');
assert.ok(login.token);
const token = login.token;

const requiredRestaurantKeys = [
  'identity',
  'capabilities',
  'workMethod',
  'skillLibrary',
  'prompts',
  'workConfig',
  'jobProfile',
  'runtime',
  'dispatch',
  'permissions',
  'provenance',
];
const requiredContentKeys = [
  'identity',
  'capabilities',
  'workMethod',
  'skillLibrary',
  'prompts',
  'workConfig',
  'jobProfile',
  'runtime',
  'dispatch',
  'permissions',
  'provenance',
];
const forbiddenGenericGuidance = [
  '找出本月食材成本上涨的主要原因',
  '本月食材成本上涨',
  '门店真实情况',
  '这次要解决什么问题',
];

function assertGuidance(profile, label) {
  const guidance = profile.dispatch?.guidance;
  assert.ok(guidance, `${label} 缺少派活指引`);
  assert.ok(String(guidance.intro || '').includes(profile.identity.name), `${label} 岗位介绍没有员工名称`);
  assert.ok(String(guidance.titlePlaceholder || '').length >= 8, `${label} 任务标题引导不完整`);
  assert.ok(String(guidance.requirementPlaceholder || '').length >= 12, `${label} 任务要求引导不完整`);
  assert.ok(guidance.materialChecklist?.length >= 2, `${label} 资料清单不完整`);
  assert.ok(guidance.deliverableChecklist?.length >= 2, `${label} 交付检查不完整`);
  assert.ok(guidance.taskExamples?.length >= 3, `${label} 任务示例不完整`);
  const serialized = JSON.stringify(guidance);
  for (const text of forbiddenGenericGuidance) {
    assert.equal(serialized.includes(text), false, `${label} 仍包含错位通用引导：${text}`);
  }
  return guidance;
}

const restaurantProfiles = await Promise.all(
  Array.from({ length: 60 }, (_, offset) => 101 + offset).map(async idx => {
    const profile = await request(`/api/employee-workbench/restaurant/${idx}`, { token });
    assert.deepEqual(Object.keys(profile).sort(), [...requiredRestaurantKeys].sort(), `餐饮员工 #${idx} 岗位域不完整`);
    assert.equal(profile.identity.idx, idx);
    assert.ok(profile.capabilities.length >= 5, `餐饮员工 #${idx} 核心能力不足`);
    assert.ok(
      profile.capabilities.every(item => item.required === true && item.enabled === true && item.locked === true),
      `餐饮员工 #${idx} 存在未锁定或未启用的岗位能力`,
    );
    assert.ok(profile.workMethod.requiredInputs.length > 0);
    assert.ok(profile.workMethod.steps.length > 0);
    assert.ok(profile.workMethod.deliverables.length > 0);
    assert.ok(profile.workMethod.qualityGates.length > 0);
    assert.ok(profile.workMethod.safetyBoundaries.length > 0);
    assert.equal(profile.skillLibrary.required[0]?.required, true);
    assert.equal(profile.skillLibrary.required[0]?.enabled, true);
    assert.ok(profile.prompts.effectiveHash);
    assert.ok(profile.workConfig.fields?.length > 0);
    assert.ok(profile.jobProfile.responsibilities?.length > 0);
    assertGuidance(profile, `餐饮员工 #${idx}`);
    return profile;
  }),
);

const contentProfiles = await Promise.all(
  Array.from({ length: 10 }, (_, idx) => idx).map(async idx => {
    const profile = await request(`/api/employee-workbench/content/${idx}`, { token });
    assert.deepEqual(Object.keys(profile).sort(), [...requiredContentKeys].sort(), `内容员工 #${idx} 岗位域不完整`);
    assert.equal(profile.identity.idx, idx);
    assert.ok(profile.capabilities.length > 0, `内容员工 #${idx} 缺少核心能力`);
    assert.ok(
      profile.capabilities.every(item => item.required === true && item.enabled === true && item.locked === true),
      `内容员工 #${idx} 存在未锁定或未启用的岗位能力`,
    );
    assert.ok(profile.workMethod.steps?.length > 0);
    assert.equal(profile.skillLibrary.required[0]?.required, true);
    assert.equal(profile.skillLibrary.required[0]?.enabled, true);
    assert.equal(profile.skillLibrary.required[0]?.locked, true);
    assert.ok(profile.prompts.effectiveHash);
    assert.ok(profile.workConfig.fields?.length > 0);
    assert.ok(profile.jobProfile.responsibilities?.length > 0);
    assertGuidance(profile, `内容员工 #${idx}`);
    return profile;
  }),
);

const allProfiles = [...restaurantProfiles, ...contentProfiles];
assert.equal(new Set(allProfiles.map(item => item.dispatch.guidance.titlePlaceholder)).size, 70);
assert.equal(new Set(allProfiles.map(item => item.dispatch.guidance.requirementPlaceholder)).size, 70);

const crew = await request('/api/content/crew', { token });
assert.equal(crew.employees?.length, 10);
assert.deepEqual(
  crew.employees.map(item => item.name),
  ['趋势官', '情报员', '拆解师', '撰稿人', '文风师', '多媒体师', '封面师', '演绎师', '分发官', '复盘官'],
);

const automations = await request('/api/content/automations', { token });
assert.equal(automations.timezone, 'Asia/Shanghai');
assert.match(automations.boundary, /绝不自动对外发布/u);
assert.ok(automations.rules.some(rule => rule.frequency === 'daily' && rule.enabled), '缺少启用中的每日自动任务');
assert.ok(automations.rules.some(rule => rule.frequency === 'weekly' && rule.enabled), '缺少启用中的每周自动任务');

const outputs = await request('/api/analysis/employee-outputs?page=1&pageSize=5', { token });
assert.notEqual(outputs.dataset?.kind, '演示环境运行记录');
assert.match(outputs.dataset?.disclaimer || '', /不代表营业额、利润或客户转化已经提升/u);

const effectTop = await request('/api/content/effect-top', { token });
assert.ok(Array.isArray(effectTop));
assert.ok(
  effectTop.every(item => !String(item.body || '').includes('正文示例')),
  '内容效果榜仍包含未经核验的初始化正文示例',
);

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  tenant: login.user?.tenant?.name || null,
  role: login.user?.role,
  employees: {
    restaurant: restaurantProfiles.length,
    content: contentProfiles.length,
    total: allProfiles.length,
    uniqueTitleGuidance: 70,
    uniqueRequirementGuidance: 70,
  },
  contentCrew: crew.employees.length,
  automations: {
    timezone: automations.timezone,
    dailyEnabled: automations.rules.filter(rule => rule.frequency === 'daily' && rule.enabled).length,
    weeklyEnabled: automations.rules.filter(rule => rule.frequency === 'weekly' && rule.enabled).length,
  },
  effectTopEntries: effectTop.length,
}, null, 2));

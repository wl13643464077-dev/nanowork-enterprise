import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { expectedContentEmployeeArtifactContent } from './helpers/content-output-fixtures.mjs';

const DBP = path.join(os.tmpdir(), `nanowork-content-crew-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';

// 本文件不访问付费/外部服务。需要验证“成功交付”语义的用例只在测试期间
// 注入一个本地、符合云雾 OpenAI 协议的响应；其它用例保持无 Key，继续验证
// template 产物被生产交付门拒绝、退款且不落库。
const nativeFetch = globalThis.fetch;
let fakeYunwuEnabled = false;
const fakeYunwuFetch = async (input, init = {}) => {
  const url = String(input?.url || input || '');
  if (!fakeYunwuEnabled || !url.startsWith('http://yunwu.local/v1/')) {
    return nativeFetch(input, init);
  }
  const body = JSON.parse(String(init.body || '{}'));
  const requestText = JSON.stringify(body.messages || []);
  const text = requestText.includes('只输出一个合法JSON对象')
    ? JSON.stringify({
        title: '门店经营复盘',
        subtitle: '本地 API 夹具',
        pages: [
          { title: '经营现状', bullets: ['仅使用已确认事实', '未知项标记待确认'], note: '先确认口径再行动' },
          { title: '行动计划', bullets: ['明确负责人', '设置复核节点'], note: '行动必须可追踪' },
        ],
      })
    : expectedContentEmployeeArtifactContent(3);
  return new Response(JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 180,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
globalThis.fetch = fakeYunwuFetch;

async function withFakeYunwu(fn) {
  const prevKey = process.env.YUNWU_API_KEY;
  const prevBase = process.env.YUNWU_BASE_URL;
  fakeYunwuEnabled = true;
  process.env.YUNWU_API_KEY = 'sk-local-content-crew-fixture';
  process.env.YUNWU_BASE_URL = 'http://yunwu.local/v1';
  try {
    return await fn();
  } finally {
    fakeYunwuEnabled = false;
    if (prevKey === undefined) delete process.env.YUNWU_API_KEY;
    else process.env.YUNWU_API_KEY = prevKey;
    if (prevBase === undefined) delete process.env.YUNWU_BASE_URL;
    else process.env.YUNWU_BASE_URL = prevBase;
  }
}

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { holdCredits, releaseHold, settleHold } = await import('../src/engines/credits.js');
const {
  CONTENT_CREW,
  CONTENT_EMPLOYEES,
  EMPLOYEE_SKILL_CATALOG,
  EMPLOYEE_SKILL_PROFILES,
  selectContentEmployee,
  validateContentCrewCatalog,
  validateEmployeeSkillCatalog,
} = await import('../src/catalog/content-crew.js');
const contentRoutes = (await import('../src/routes/content.js')).default;
const outputRoutes = (await import('../src/routes/employee-outputs.js')).default;

initSchema();
migrateV2();
const currentLocalTimestamp = db.prepare("SELECT datetime('now','localtime') value").get().value;

q.run(`UPDATE tenants SET name='A餐饮门店',status='已开通',credits=100000 WHERE id=1`);
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(2,'B餐饮门店','已开通',100000)`);
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,?)`,
  'content-boss-a', 'x', 'A店老板', 'boss', '老板办', 1);
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,?)`,
  'content-boss-b', 'x', 'B店老板', 'boss', '老板办', 2);
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,?)`,
  'content-staff-a', 'x', 'A店员工', 'staff', '内容部', 1);
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,?)`,
  'content-ops-a', 'x', 'A店运营负责人', 'ops_director', '运营部', 1);
const bossA = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='content-boss-a'`);
const bossB = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='content-boss-b'`);
const staffA = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='content-staff-a'`);
const opsA = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='content-ops-a'`);

for (const config of [
  {
    idx: 3,
    prompt: 'A店撰稿规范：只写已经有门店依据的信息。',
    work: { textModel: 'deepseek-v4-flash', outputLength: 'full', approvalMode: '老板审核', timeoutSeconds: 90 },
    skills: [{ title: 'A店文案事实核验', detail: '逐项检查菜名、价格、库存与活动时间', source: 'A店内容SOP', enabled: true }],
  },
  {
    idx: 5,
    prompt: 'A店视觉规范：不得生成未经确认的菜品文字。',
    work: { imageModel: 'gpt-image-2', outputLength: 'std', approvalMode: '老板审核', timeoutSeconds: 90 },
    skills: [{ title: 'A店视觉版权检查', detail: '核对图片来源、Logo与字体授权', source: 'A店视觉SOP', enabled: true }],
  },
  {
    idx: 7,
    prompt: 'A店演绎规范：PPT只作为HTML主产物的附加导出。',
    work: { textModel: 'deepseek-v4-flash', outputLength: 'std', approvalMode: '老板审核', timeoutSeconds: 90 },
    skills: [{ title: 'A店演绎结构检查', detail: '核对章节、图表来源与行动项', source: 'A店演绎SOP', enabled: true }],
  },
]) {
  runWithTenant(1, () => q.run(`INSERT INTO content_employee_workbench_configs(
    employee_idx,prompt_override,work_config_json,skills_json,revision,updated_by
  ) VALUES(?,?,?,?,?,?)`,
  config.idx, config.prompt, JSON.stringify(config.work), JSON.stringify(config.skills), config.idx + 2, bossA.id));
}
runWithTenant(2, () => q.run(`INSERT INTO content_employee_workbench_configs(
  employee_idx,prompt_override,work_config_json,skills_json,revision,updated_by
) VALUES(?,?,?,?,?,?)`,
3, 'B店秘密撰稿规范不得进入A店。',
JSON.stringify({ outputLength: 'lite' }),
JSON.stringify([{ title: 'B店私有撰稿技能', detail: '仅B店使用', source: 'B店', enabled: true }]),
11, bossB.id));

let contentA;
let mediaA;
let contentB;
runWithTenant(1, () => {
  contentA = q.run(`INSERT INTO contents(
    type,title,body,topic,status,ai_mode,creator_id,
    content_employee_idx,content_employee_key,content_employee_name,content_employee_group,content_run_mode,created_at
    ,snapshot_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  '朋友圈文案', 'A店单工位文案', 'A店真实留痕的测试文案。', '午市新品', '可使用', 'api', bossA.id,
  3, 'draft', '撰稿人', '文案创作部', 'single_station', '2026-07-20 10:00:00',
  JSON.stringify({ billing: { state: 'settled', chargedCredits: 2 } })).lastInsertRowid;
  mediaA = q.run(`INSERT INTO media_jobs(
    user_id,kind,model,prompt,status,url,
    content_employee_idx,content_employee_key,content_employee_name,content_employee_group,content_run_mode,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, bossA.id, 'image', 'test-image', 'A店新品主图', '成功', '/test/a.png',
  5, 'media', '多媒体师', '视觉工厂', 'single_station', '2026-07-21 10:00:00').lastInsertRowid;
  const mediaHold = holdCredits({
    userId: bossA.id,
    feature: '内容岗位徽标媒体',
    kind: 'image',
    model: 'test-image',
    credits: 2,
    refType: 'media_job',
    refId: Number(mediaA),
  });
  settleHold(mediaHold, { credits: 2, model: 'test-image', note: '岗位徽标正向媒体已结算' });
  q.run(`INSERT INTO materials(
    name,type,url,source_type,source_id,creator_id,artifact_snapshot_json
  ) VALUES('A店新品主图','图片','/test/a.png','media_job',?,?,?)`,
  Number(mediaA), bossA.id, JSON.stringify({
    manualReview: {
      decision: 'accepted',
      source: 'manager_manual_media_review',
      reviewedById: bossA.id,
      reviewedByName: bossA.name,
      reviewedByRole: bossA.role,
      reviewedAt: '2026-07-21 10:05:00',
    },
  }));
});
runWithTenant(2, () => {
  contentB = q.run(`INSERT INTO contents(
    type,title,body,topic,status,ai_mode,creator_id,
    content_employee_idx,content_employee_key,content_employee_name,content_employee_group,content_run_mode,created_at,snapshot_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  '朋友圈文案', 'B店私有文案', '不得跨租户读取。', 'B店主题', '可使用', 'api', bossB.id,
  3, 'draft', '撰稿人', '文案创作部', 'single_station', '2026-07-20 11:00:00',
  JSON.stringify({ billing: { state: 'settled', chargedCredits: 2 } })).lastInsertRowid;
});

function appFor(user) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => { req.user = user; next(); }));
  app.use('/content', contentRoutes);
  app.use('/analysis/employee-outputs', outputRoutes);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('静态目录锁定10名权威身份，person为空且审查官不计员工', () => {
  assert.equal(CONTENT_CREW.department.key, 'content');
  assert.equal(CONTENT_CREW.department.name, '内容生产部');
  assert.equal(CONTENT_EMPLOYEES.length, 10);
  assert.deepEqual(CONTENT_EMPLOYEES.map(employee => [employee.idx, employee.key, employee.person, employee.name, employee.group]), [
    [0, 'trend', null, '趋势官', '热点雷达部'], [1, 'research', null, '情报员', '情报检索部'],
    [2, 'benchmark', null, '拆解师', '爆款研究部'], [3, 'draft', null, '撰稿人', '文案创作部'],
    [4, 'style', null, '文风师', '风格工坊'], [5, 'media', null, '多媒体师', '视觉工厂'],
    [6, 'cover', null, '封面师', '封面设计部'], [7, 'deck', null, '演绎师', '互动演绎部'],
    [8, 'publish', null, '分发官', '发行调度部'], [9, 'retro', null, '复盘官', '数据复盘部'],
  ]);
  assert.equal(CONTENT_EMPLOYEES[7].optional, true);
  assert.equal(CONTENT_EMPLOYEES.filter(employee => employee.optional).length, 1);
  assert.equal(CONTENT_CREW.qualityGate.employee, false);
  assert.equal(CONTENT_CREW.qualityGate.countedInEmployeeTotal, false);
  assert.ok(CONTENT_EMPLOYEES.every(employee => employee.intro && employee.duty && employee.capabilities.length));

  const invalid = JSON.parse(JSON.stringify(CONTENT_CREW));
  invalid.employees[0].person = '虚构人物';
  assert.throws(() => validateContentCrewCatalog(invalid), /person必须为null/);
});

test('10名内容员工保留完整岗位档案、提示词、工作方式、配置、派活与输出契约', () => {
  assert.equal(CONTENT_EMPLOYEES.reduce((sum, employee) => sum + employee.capabilities.length, 0), 45);
  for (const employee of CONTENT_EMPLOYEES) {
    assert.ok(employee.capabilities.every(capability => (
      capability.required === true && capability.enabled === true && capability.locked === true
    )), `${employee.name}核心能力必须全部启用并锁定`);
    assert.deepEqual(
      { messageMode: employee.systemPrompt.messageMode, template: employee.systemPrompt.template },
      { messageMode: 'none', template: null },
    );
    assert.equal(employee.pipelinePrompt.messageMode, 'single_user');
    assert.ok(employee.pipelinePrompt.template.length > 150, `${employee.name}流水线提示词`);
    assert.equal(employee.soloPrompt.messageMode, 'single_user');
    assert.ok(employee.soloPrompt.template.includes(employee.name), `${employee.name}单独派活提示词`);
    assert.equal(typeof employee.placeholders, 'object');
    for (const field of ['input', 'execution', 'output', 'approval', 'handoff']) {
      assert.ok(employee.workMethod[field], `${employee.name}.workMethod.${field}`);
    }
    assert.ok(employee.defaultWorkConfig.common, `${employee.name}.defaultWorkConfig.common`);
    assert.ok(employee.defaultWorkConfig.roleSpecific, `${employee.name}.defaultWorkConfig.roleSpecific`);
    assert.ok(Array.isArray(employee.dispatchForm.fields) && employee.dispatchForm.fields.length >= 4);
    assert.ok(employee.dispatchForm.fields.some(field => field.key === 'direction' && field.required === true));
    assert.deepEqual(employee.outputSchema.keys, employee.outputKeys);
    assert.ok(employee.outputSchema.contract.includes('{'));
    assert.ok(Array.isArray(employee.connectorPolicy.connectors) && employee.connectorPolicy.connectors.length);
    assert.equal(employee.sourceProvenance.referenceSha256, CONTENT_CREW.source.referenceSha256);
  }

  const deck = CONTENT_EMPLOYEES[7];
  assert.equal(deck.outputSchema.primaryArtifact, 'html');
  assert.ok(deck.connectorPolicy.connectors.some(connector => connector.kind === 'html' && connector.primary === true));
  assert.ok(deck.connectorPolicy.connectors.some(connector => connector.kind === 'ppt' && connector.addon === true));

  const writer = CONTENT_EMPLOYEES[3];
  assert.equal(writer.key, 'draft');
  assert.equal(writer.defaultWorkConfig.common.textModel, 'gpt-5.5');

  const invalid = JSON.parse(JSON.stringify(CONTENT_CREW));
  invalid.employees[0].pipelinePrompt.template = '';
  assert.throws(() => validateContentCrewCatalog(invalid), /pipelinePrompt\.template不能为空/);
});

test('复盘官保留完整能力，但阈值、实际结果与预测按真实数据条件执行', () => {
  const retro = CONTENT_EMPLOYEES.find(employee => employee.idx === 9);
  assert.ok(retro);
  assert.deepEqual(retro.capabilities.map(capability => capability.name), [
    '指标计划', '预测性复盘', '选题回流', '经验沉淀',
  ]);
  assert.ok(retro.capabilities.every(capability => (
    capability.required === true && capability.enabled === true && capability.locked === true
  )));

  const completeUserFacingProfile = [
    retro.intro,
    ...retro.capabilities.map(capability => capability.desc),
    retro.pipelinePrompt.template,
    retro.soloPrompt.template,
    retro.outputSchema.contract,
    ...retro.connectorPolicy.connectors.map(connector => connector.executeBoundary),
  ].join('\n');

  for (const requiredBoundary of [
    '真实历史', '实际表现', '取数负责人', '观察窗口', '验证计划',
    '负责人明确授权', '待验证假设', '无则空数组',
  ]) assert.match(completeUserFacingProfile, new RegExp(requiredBoundary, 'u'));

  assert.doesNotMatch(completeUserFacingProfile, /达标线(?:是多少|定多少)|预判哪里会好|合理假设/u);
  assert.doesNotMatch(completeUserFacingProfile, /\bV1\b/u);
});

test('安全迁移技能库恰好覆盖70位员工与409张历史卡，其中内容部65张', () => {
  const expectedContentCounts = [12, 6, 6, 5, 6, 6, 6, 6, 6, 6];
  assert.equal(EMPLOYEE_SKILL_CATALOG.employeeCount, 70);
  assert.equal(EMPLOYEE_SKILL_CATALOG.skillCount, 409);
  assert.equal(EMPLOYEE_SKILL_CATALOG.contentSkillCount, 65);
  assert.equal(EMPLOYEE_SKILL_CATALOG.restaurantSkillCount, 344);
  assert.equal(EMPLOYEE_SKILL_PROFILES.length, 70);
  assert.deepEqual(
    EMPLOYEE_SKILL_PROFILES.filter(profile => profile.idx < 10).map(profile => profile.skills.length),
    expectedContentCounts,
  );
  assert.equal(
    EMPLOYEE_SKILL_PROFILES.filter(profile => profile.idx >= 101).reduce((sum, profile) => sum + profile.skills.length, 0),
    344,
  );
  for (const profile of EMPLOYEE_SKILL_PROFILES) {
    assert.ok((profile.idx >= 0 && profile.idx <= 9) || (profile.idx >= 101 && profile.idx <= 160));
    assert.equal(profile.expectedSkillCount, profile.skills.length);
    for (const skill of profile.skills) {
      assert.ok(skill.title && skill.detail && skill.source);
      assert.equal(skill.verificationStatus, 'owner_verified_enabled');
      assert.equal(skill.legacyVerificationStatus, 'legacy_unverified');
      assert.equal(skill.sourceSnapshot.date, '2026-07-18');
      assert.match(skill.sourceSnapshot.sha256, /^[a-f0-9]{64}$/);
    }
  }

  const invalid = JSON.parse(JSON.stringify(EMPLOYEE_SKILL_CATALOG));
  invalid.profiles[0].skills.pop();
  assert.throws(() => validateEmployeeSkillCatalog(invalid), /技能数量/);
});

test('生成类型采用安全默认工位并严格拒绝字符串、越权工位', () => {
  assert.equal(selectContentEmployee(undefined, 'copy').idx, 3);
  assert.equal(selectContentEmployee(undefined, 'ppt').idx, 7);
  assert.equal(selectContentEmployee(undefined, 'image').idx, 5);
  assert.equal(selectContentEmployee(undefined, 'video').idx, 5);
  assert.throws(() => selectContentEmployee('3', 'copy'), /必须是0-9之间的整数/);
  assert.throws(() => selectContentEmployee(4, 'copy'), /仅支持：3·撰稿人/);
  assert.throws(() => selectContentEmployee(6, 'image'), /仅支持：5·多媒体师/);
});

test('数据库迁移为contents与media_jobs增加完整内容员工元数据字段', () => {
  for (const table of ['contents', 'media_jobs']) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
    for (const name of [
      'content_employee_idx',
      'content_employee_key',
      'content_employee_name',
      'content_employee_group',
      'content_run_mode',
      'profile_version',
      'prompt_hash',
      'snapshot_json',
    ]) {
      assert.ok(columns.has(name), `${table}.${name}`);
    }
  }
});

test('GET /content/crew只把契约有效且业务可用的成品计入当前账号运行统计', async () => {
  const currentContentId = runWithTenant(1, () => Number(q.run(`INSERT INTO contents(
    type,title,body,topic,status,ai_mode,creator_id,
    content_employee_idx,content_employee_key,content_employee_name,content_employee_group,
    content_run_mode,snapshot_json,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  '朋友圈文案', '本月有效成品', '当前月份契约有效且业务可用的成品。', '统计验收', '可使用', 'api', bossA.id,
  3, 'draft', '撰稿人', '文案创作部', 'single_station',
  JSON.stringify({ contract: { status: 'valid', valid: true }, billing: { state: 'settled' } }),
  currentLocalTimestamp).lastInsertRowid));
  const templateDraftId = runWithTenant(1, () => Number(q.run(`INSERT INTO contents(
    type,title,body,topic,status,ai_mode,creator_id,
    content_employee_idx,content_employee_key,content_employee_name,content_employee_group,
    content_run_mode,snapshot_json,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  '朋友圈文案', '历史模板底稿', '只建立了模板，不是正式产出。', '模板验收', '待审核', 'template', bossA.id,
  3, 'draft', '撰稿人', '文案创作部', 'single_station',
  JSON.stringify({ contract: { status: 'incomplete', valid: false } }),
  '2026-07-20 10:05:00').lastInsertRowid));
  const pendingReviewMediaId = runWithTenant(1, () => {
    const id = Number(q.run(`INSERT INTO media_jobs(
      user_id,kind,model,prompt,status,url,
      content_employee_idx,content_employee_key,content_employee_name,content_employee_group,
      content_run_mode,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    bossA.id, 'image', 'test-image', '已结算但待人工验收', '成功', '/test/pending-review.png',
    5, 'media', '多媒体师', '视觉工厂', 'single_station', '2026-07-21 11:00:00').lastInsertRowid);
    const hold = holdCredits({
      userId: bossA.id,
      feature: '岗位徽标待审核媒体反例',
      kind: 'image',
      model: 'test-image',
      credits: 1,
      refType: 'media_job',
      refId: id,
    });
    settleHold(hold, { credits: 1, model: 'test-image', note: '待人工验收媒体已结算' });
    return id;
  });
  try {
    await withServer(bossA, async base => {
      const response = await fetch(`${base}/content/crew`);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.department.employeeTotal, 10);
      assert.equal(data.canViewInternalProfile, true);
      assert.equal(typeof data.schemaVersion, 'string');
      assert.ok(data.source);
      assert.ok(data.qualityGate);
      assert.match(data.executionBoundary, /不表示十个工位/);
      assert.equal(data.employees.find(employee => employee.idx === 3).runtime.outputs, 2);
      assert.equal(data.employees.find(employee => employee.idx === 5).runtime.mediaJobs, 1);
      assert.equal(data.employees.find(employee => employee.idx === 0).skill, CONTENT_EMPLOYEES[0].skill);
      assert.deepEqual(data.employees.find(employee => employee.idx === 0).capabilities, CONTENT_EMPLOYEES[0].capabilities);
      assert.deepEqual(data.employees.find(employee => employee.idx === 3).taskTypes, ['文案初稿', '标题方案', '配图建议']);
      assert.deepEqual(data.employees.find(employee => employee.idx === 7).taskTypes, ['HTML演绎稿', '网页演示方案', '交互演绎稿']);
      const summary = await fetch(`${base}/content/summary`).then(result => result.json());
      assert.equal(summary.total, 1);
    });
    await withServer(bossB, async base => {
      const data = await fetch(`${base}/content/crew`).then(response => response.json());
      assert.equal(data.employees.find(employee => employee.idx === 3).runtime.outputs, 1);
      assert.equal(data.employees.find(employee => employee.idx === 5).runtime.mediaJobs, 0);
    });
    for (const restrictedUser of [staffA, opsA]) {
      await withServer(restrictedUser, async base => {
        const data = await fetch(`${base}/content/crew`).then(response => response.json());
        assert.equal(data.canViewInternalProfile, false, restrictedUser.role);
        assert.equal(data.schemaVersion, undefined, restrictedUser.role);
        assert.equal(data.source, undefined, restrictedUser.role);
        assert.equal(data.moduleGroups, undefined, restrictedUser.role);
        assert.equal(data.qualityGate, undefined, restrictedUser.role);
        const employee = data.employees.find(item => item.idx === 0);
        assert.equal(employee.skill, undefined, restrictedUser.role);
        assert.equal(employee.capabilities, undefined, restrictedUser.role);
        assert.equal(employee.outputKeys, undefined, restrictedUser.role);
        assert.equal(employee.connectorPolicy, undefined, restrictedUser.role);
        assert.equal(employee.approval, undefined, restrictedUser.role);
        assert.equal(employee.name, CONTENT_EMPLOYEES[0].name);
        assert.equal(employee.duty, CONTENT_EMPLOYEES[0].duty);
        assert.deepEqual(employee.taskTypes, ['趋势简报', '候选选题', '热点扫描']);
        assert.ok(employee.runtime);
        assert.equal(JSON.stringify(data).includes(CONTENT_EMPLOYEES[0].skill), false, restrictedUser.role);
        assert.equal(JSON.stringify(data).includes(CONTENT_EMPLOYEES[0].capabilities[0].name), false, restrictedUser.role);
      });
    }
  } finally {
    runWithTenant(1, () => q.run('DELETE FROM contents WHERE id=?', currentContentId));
    runWithTenant(1, () => q.run('DELETE FROM contents WHERE id=?', templateDraftId));
    runWithTenant(1, () => q.run('DELETE FROM media_jobs WHERE id=?', pendingReviewMediaId));
  }
});

test('提示词指南仅老板、管理员和平台超管可读取正文，普通员工与运营负责人只拿公开标识', async () => {
  await withServer(bossA, async base => {
    const guides = await fetch(`${base}/content/prompt-guides`).then(response => response.json());
    assert.ok(guides.length > 0);
    assert.equal(guides[0].canViewPrompt, true);
    assert.equal(typeof guides[0].role_card, 'string');
    assert.equal(typeof guides[0].output_rule, 'string');
    assert.equal(typeof guides[0].style, 'string');
  });

  for (const restrictedUser of [staffA, opsA]) {
    await withServer(restrictedUser, async base => {
      const guides = await fetch(`${base}/content/prompt-guides`).then(response => response.json());
      assert.ok(guides.length > 0);
      assert.equal(guides[0].canViewPrompt, false, restrictedUser.role);
      assert.equal(guides[0].canEditPrompt, false, restrictedUser.role);
      assert.equal(guides[0].role_card, undefined, restrictedUser.role);
      assert.equal(guides[0].output_rule, undefined, restrictedUser.role);
      assert.equal(guides[0].style, undefined, restrictedUser.role);
      assert.equal(guides[0].editablePath, null, restrictedUser.role);
    });
  }
});

test('内容列表与详情对普通员工和运营负责人删除完整执行档案', async () => {
  const restrictedCases = [
    { user: staffA, marker: '__CONTENT_STAFF_INTERNAL_PROFILE_SECRET__' },
    { user: opsA, marker: '__CONTENT_OPS_INTERNAL_PROFILE_SECRET__' },
  ];
  const created = restrictedCases.map(({ user, marker }) => ({
    user,
    marker,
    contentId: runWithTenant(1, () => Number(q.run(`INSERT INTO contents(
      type,title,body,topic,status,ai_mode,creator_id,
      content_employee_idx,content_employee_key,content_employee_name,content_employee_group,
      content_run_mode,profile_version,prompt_hash,snapshot_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    '朋友圈文案', `${user.role}业务内容`, `${user.role}可读业务正文`, '权限回归', '可使用', 'api', user.id,
    3, 'draft', '撰稿人', '文案创作部', 'single_station',
    `${marker}-version`, `${marker}-hash`,
    JSON.stringify({ marker, effectiveConfig: { internal: marker } })).lastInsertRowid)),
  }));

  try {
    for (const { user, marker, contentId } of created) {
      await withServer(user, async base => {
        const listed = await fetch(`${base}/content/list`).then(async response => ({
          status: response.status,
          data: await response.json(),
        }));
        assert.equal(listed.status, 200);
        const listRow = listed.data.rows.find(row => row.id === contentId);
        assert.ok(listRow, user.role);
        assert.equal(listRow.body, `${user.role}可读业务正文`);
        assert.equal(listRow.content_employee_name, '撰稿人');
        for (const key of ['profile_version', 'prompt_hash', 'snapshot_json']) {
          assert.equal(Object.hasOwn(listRow, key), false, `${user.role}:${key}`);
        }
        assert.doesNotMatch(JSON.stringify(listRow), new RegExp(marker, 'u'));

        const detailResponse = await fetch(`${base}/content/detail/${contentId}`);
        assert.equal(detailResponse.status, 200);
        const detail = await detailResponse.json();
        assert.equal(detail.body, `${user.role}可读业务正文`);
        assert.equal(detail.status, '可使用');
        for (const key of ['profile_version', 'prompt_hash', 'snapshot_json']) {
          assert.equal(Object.hasOwn(detail, key), false, `${user.role}:${key}`);
        }
        assert.doesNotMatch(JSON.stringify(detail), new RegExp(marker, 'u'));
      });
    }

    await withServer(bossA, async base => {
      const detail = await fetch(`${base}/content/detail/${created[0].contentId}`).then(response => response.json());
      assert.equal(detail.profile_version, `${created[0].marker}-version`);
      assert.equal(detail.prompt_hash, `${created[0].marker}-hash`);
      assert.match(detail.snapshot_json, new RegExp(created[0].marker, 'u'));
    });
  } finally {
    for (const { contentId } of created) {
      runWithTenant(1, () => q.run('DELETE FROM contents WHERE tenant_id=1 AND id=?', contentId));
    }
  }
});

test('各内容生成响应统一按请求角色投影employeeExecution', async () => {
  const source = fs.readFileSync(new URL('../src/routes/content.js', import.meta.url), 'utf8');
  assert.equal((source.match(/employeeExecutionResponse\(execution, req\.user\)/gu) || []).length, 8);
  assert.doesNotMatch(source, /employeeExecutionResponse\(execution\)(?!\s*\{)/u);

  for (const user of [staffA, opsA]) {
    await withServer(user, async base => {
      const response = await withFakeYunwu(() => fetch(`${base}/content/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: '朋友圈文案',
          topic: `${user.role}业务生成权限验收`,
          brand: '可公开业务品牌',
          employeeIdx: 3,
        }),
      }));
      assert.equal(response.status, 200, user.role);
      const data = await response.json();
      assert.deepEqual(data.employeeExecution, { completeProfileApplied: true });
      assert.equal(data.contentEmployee.contentEmployeeName, '撰稿人');
      for (const key of ['profileVersion', 'promptHash', 'effectiveConfig', 'connector']) {
        assert.equal(Object.hasOwn(data.employeeExecution, key), false, `${user.role}:${key}`);
      }
      assert.doesNotMatch(JSON.stringify(data), /A店撰稿规范|A店文案事实核验/u);
      runWithTenant(1, () => q.run('DELETE FROM contents WHERE tenant_id=1 AND id=?', data.id));

      const imageResponse = await fetch(`${base}/content/generate-image`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: `${user.role}公开菜品图描述`, employeeIdx: 5 }),
      });
      assert.ok([403, 503].includes(imageResponse.status), user.role);
      const image = await imageResponse.json();
      if (imageResponse.status === 503) {
        assert.deepEqual(image.employeeExecution, { completeProfileApplied: true });
        for (const key of ['profileVersion', 'promptHash', 'effectiveConfig', 'connector']) {
          assert.equal(Object.hasOwn(image.employeeExecution, key), false, `${user.role}:image:${key}`);
        }
        runWithTenant(1, () => q.run('DELETE FROM media_jobs WHERE tenant_id=1 AND id=?', image.jobId));
      }
      assert.doesNotMatch(JSON.stringify(image), /A店视觉规范|A店视觉版权检查/u);
    });
  }
});

test('内容生成路由严格校验employeeIdx，不在校验失败时调用生成服务', async () => {
  await withServer(bossA, async base => {
    const cases = [
      ['/content/generate', { type: '朋友圈文案', topic: '主题', employeeIdx: '3' }],
      ['/content/generate-ppt', { topic: '经营复盘', employeeIdx: 3 }],
      ['/content/generate-image', { prompt: '菜品主图', employeeIdx: 6 }],
      ['/content/generate-video', { prompt: '门店短片', employeeIdx: 6 }],
      ['/content/daily-pack', { topic: '今日门店', employeeIdx: 4 }],
    ];
    for (const [route, body] of cases) {
      const response = await fetch(`${base}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, route);
      assert.match((await response.json()).error, /employeeIdx|仅支持/);
    }
  });
});

test('文案生成默认归属撰稿人，并持久化single_station边界', async () => {
  await withServer(bossA, async base => {
    const response = await withFakeYunwu(() => fetch(`${base}/content/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: '朋友圈文案', topic: '夏日午市新品', brand: '测试门店' }),
    }));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.contentEmployee.contentEmployeeIdx, 3);
    assert.equal(data.contentEmployee.contentRunMode, 'single_station');
    assert.match(data.contentEmployee.executionBoundary, /不表示十工位/);
    assert.equal(data.employeeExecution.completeProfileApplied, true);
    assert.equal(data.employeeExecution.connector.kind, 'copy');
    assert.equal(data.employeeExecution.connector.relationship, 'primary_connector');
    assert.match(data.employeeExecution.promptHash, /^[a-f0-9]{64}$/u);
    const persisted = db.prepare(`SELECT content_employee_idx,content_employee_key,content_employee_name,
      content_employee_group,content_run_mode,profile_version,prompt_hash,snapshot_json
      FROM contents WHERE tenant_id=1 AND id=?`).get(data.id);
    assert.deepEqual({
      content_employee_idx: persisted.content_employee_idx,
      content_employee_key: persisted.content_employee_key,
      content_employee_name: persisted.content_employee_name,
      content_employee_group: persisted.content_employee_group,
      content_run_mode: persisted.content_run_mode,
    }, {
      content_employee_idx: 3,
      content_employee_key: 'draft',
      content_employee_name: '撰稿人',
      content_employee_group: '文案创作部',
      content_run_mode: 'single_station',
    });
    assert.equal(persisted.profile_version, 'content-3-r5');
    assert.equal(persisted.prompt_hash, data.employeeExecution.promptHash);
    const snapshot = JSON.parse(persisted.snapshot_json);
    assert.equal(snapshot.identity.idx, 3);
    assert.equal(snapshot.connector.kind, 'copy');
    assert.equal(snapshot.capabilities.length, CONTENT_EMPLOYEES[3].capabilities.length);
    assert.equal(snapshot.enterpriseOverlay.enabledCustomSkillCount, 1);
    assert.equal(snapshot.enterpriseOverlay.customSkills[0].title, 'A店文案事实核验');
    assert.equal(snapshot.handlerExecution.executionState,
      'provider_specific_connector_runtime');
    assert.equal(snapshot.handlerExecution.legacyHandlerAdapterInvoked, false);
    assert.equal(snapshot.handlerExecution.invocationCount, 0);
    assert.deepEqual(snapshot.handlerExecution.handlerInvocations, []);
    assert.match(snapshot.handlerExecution.boundary,
      /没有content-handler-adapter调用证据.*不计为派活旧handler已实际调用/u);
    assert.doesNotMatch(persisted.snapshot_json, /B店秘密|B店私有/u);
    db.prepare('DELETE FROM contents WHERE tenant_id=1 AND id=?').run(data.id);
  });
});

test('分析接口聚合内容成品与媒体任务，支持筛选和穿透', async () => {
  const backgroundTextJob = runWithTenant(1, () => q.run(`INSERT INTO media_jobs(
    user_id,kind,prompt,status,content_employee_idx,content_employee_key,
    content_employee_name,content_employee_group,content_run_mode
  ) VALUES(?,?,?,?,?,?,?,?,?)`, bossA.id, 'text', '后台文案中间任务', '成功',
  3, 'draft', '撰稿人', '文案创作部', 'single_station').lastInsertRowid);
  await withServer(bossA, async base => {
    const query = new URLSearchParams({ start: '2026-07-01', end: '2026-07-31', source: 'content', dimension: 'employee' });
    const data = await fetch(`${base}/analysis/employee-outputs?${query}`).then(response => response.json());
    assert.equal(data.summary.total, 2);
    assert.deepEqual(data.rows.map(row => row.domain).sort(), ['content_media', 'content_output']);
    assert.ok(data.rows.every(row => row.executionMode === 'single_station'));
    const mediaRow = data.rows.find(row => row.domain === 'content_media');
    assert.equal(mediaRow.status, '已通过');
    assert.equal(mediaRow.displayStatus, '已人工采纳（可用于业务）');
    assert.equal(mediaRow.hasOutput, true);
    assert.equal(mediaRow.evidenceKind, '已人工验收媒体产出');
    assert.match(data.dataset.disclaimer, /不代表十工位流水线/);

    const output = await fetch(`${base}/analysis/employee-outputs/drill/content/output-${contentA}`).then(response => response.json());
    assert.equal(output.record.employeeIdx, 3);
    assert.match(output.output.body, /A店真实留痕/);
    assert.match(output.disclaimer, /不表示内容部十个工位/);

    const media = await fetch(`${base}/analysis/employee-outputs/drill/content/media-${mediaA}`).then(response => response.json());
    assert.equal(media.record.employeeIdx, 5);
    assert.equal(media.record.status, '已通过');
    assert.equal(media.evidenceKind, '已人工验收媒体产出');
    assert.equal(media.output.provenance.billingState, 'settled');
    assert.equal(media.output.provenance.reviewStatus, '已人工验收（可用于业务）');
    assert.equal(media.output.artifactUrl, '/test/a.png');
    assert.equal((await fetch(`${base}/analysis/employee-outputs/drill/content/media-${backgroundTextJob}`)).status, 404);
  });
  db.prepare('DELETE FROM media_jobs WHERE tenant_id=1 AND id=?').run(backgroundTextJob);
});

test('聚合与穿透把普通内容待对账显示为账务状态，不冒充质检失败或合格产出', async () => {
  const pendingContentId = runWithTenant(1, () => Number(q.run(`INSERT INTO contents(
    type,title,body,topic,status,ai_mode,creator_id,
    content_employee_idx,content_employee_key,content_employee_name,content_employee_group,
    content_run_mode,snapshot_json,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  '复盘报告', '待账务对账内容', '已生成但结算尚未确认。', '账务语义', '可使用', 'api', bossA.id,
  9, 'retro', '复盘官', '数据复盘部', 'automation_scheduled', JSON.stringify({
    contract: { status: 'valid', valid: true },
    billing: { state: 'pending_reconciliation', heldCredits: 9 },
  }), '2026-07-22 10:00:00').lastInsertRowid));
  try {
    await withServer(bossA, async base => {
      const query = new URLSearchParams({
        start: '2026-07-01',
        end: '2026-07-31',
        source: 'content',
        employee: '9',
      });
      const data = await fetch(`${base}/analysis/employee-outputs?${query}`).then(response => response.json());
      const row = data.rows.find(item => item.evidenceId === pendingContentId);
      assert.equal(row.status, '待账务对账');
      assert.equal(row.displayStatus, '业务暂不可采用（待账务对账）');
      assert.equal(row.hasOutput, false);
      assert.equal(row.evidenceKind, '待账务对账内容记录');
      assert.equal(data.summary.withOutput, 0);

      const detail = await fetch(`${base}/analysis/employee-outputs/drill/content/output-${pendingContentId}`)
        .then(response => response.json());
      assert.equal(detail.record.status, '待账务对账');
      assert.equal(detail.evidenceKind, '待账务对账内容记录');
      assert.equal(detail.output.status, '待账务对账');
    });
  } finally {
    runWithTenant(1, () => q.run('DELETE FROM contents WHERE id=?', pendingContentId));
  }
});

test('聚合媒体区分待对账、待审核与已人工验收终态', async () => {
  let pendingHold;
  const pendingMediaId = runWithTenant(1, () => {
    const id = Number(q.run(`INSERT INTO media_jobs(
      user_id,kind,model,prompt,status,url,
      content_employee_idx,content_employee_key,content_employee_name,content_employee_group,
      content_run_mode,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    bossA.id, 'image', 'test-image', '待对账聚合媒体', '成功', '/test/reconciliation.png',
    5, 'media', '多媒体师', '视觉工厂', 'single_station', '2026-07-23 10:00:00').lastInsertRowid);
    pendingHold = holdCredits({
      userId: bossA.id,
      feature: '聚合媒体待对账反例',
      kind: 'image',
      model: 'test-image',
      credits: 3,
      refType: 'media_job',
      refId: id,
    });
    return id;
  });
  try {
    await withServer(bossA, async base => {
      const query = new URLSearchParams({
        start: '2026-07-23',
        end: '2026-07-23',
        source: 'content',
        employee: '5',
      });
      const data = await fetch(`${base}/analysis/employee-outputs?${query}`).then(response => response.json());
      const row = data.rows.find(item => item.evidenceId === pendingMediaId);
      assert.equal(row.status, '待账务对账');
      assert.equal(row.displayStatus, '业务暂不可采用（待账务对账）');
      assert.equal(row.hasOutput, false);
      assert.equal(row.evidenceKind, '待账务对账媒体记录');

      const detail = await fetch(`${base}/analysis/employee-outputs/drill/content/media-${pendingMediaId}`)
        .then(response => response.json());
      assert.equal(detail.record.status, '待账务对账');
      assert.equal(detail.evidenceKind, '待账务对账媒体记录');
      assert.equal(detail.output.provenance.billingState, 'pending_reconciliation');
      assert.equal(detail.output.provenance.reviewStatus, '业务暂不可采用（待账务对账）');
    });
  } finally {
    runWithTenant(1, () => {
      releaseHold(pendingHold, '清理聚合媒体待对账反例');
      q.run('DELETE FROM media_jobs WHERE id=?', pendingMediaId);
    });
  }
});

test('内容生产仓目录、统计、聚合与穿透均保持租户隔离', async () => {
  await withServer(bossB, async base => {
    const query = new URLSearchParams({ start: '2026-07-01', end: '2026-07-31', source: 'content' });
    const data = await fetch(`${base}/analysis/employee-outputs?${query}`).then(response => response.json());
    assert.equal(data.summary.total, 1);
    assert.equal(data.rows[0].evidenceId, contentB);
    assert.equal((await fetch(`${base}/analysis/employee-outputs/drill/content/output-${contentA}`)).status, 404);
    assert.equal((await fetch(`${base}/analysis/employee-outputs/drill/content/media-${mediaA}`)).status, 404);
  });
});

test('文案后台、日更包、图片、视频与PPT专用入口都持久化完整员工执行快照', async () => {
  await withServer(bossA, async base => {
    // 后台成功路径必须有真实 API 形态、正 token 与合法岗位文案契约；
    // 保持 fake provider 开启直到 setImmediate worker 进入终态，避免竞态下又落回模板。
    await withFakeYunwu(async () => {
      const backgroundResponse = await fetch(`${base}/content/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: '社群话题',
          topic: '周末家庭聚餐',
          background: true,
          employeeIdx: 3,
        }),
      });
      assert.equal(backgroundResponse.status, 200);
      const background = await backgroundResponse.json();
      assert.equal(background.employeeExecution.connector.kind, 'copy');
      let backgroundJob;
      for (let i = 0; i < 100; i++) {
        backgroundJob = db.prepare(`SELECT profile_version,prompt_hash,snapshot_json,status
          FROM media_jobs WHERE tenant_id=1 AND id=?`).get(background.jobId);
        if (backgroundJob?.status !== '处理中') break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(backgroundJob.status, '成功');
      assert.equal(backgroundJob.profile_version, 'content-3-r5');
      assert.equal(backgroundJob.prompt_hash, background.employeeExecution.promptHash);
      assert.equal(JSON.parse(backgroundJob.snapshot_json).identity.idx, 3);
    });

    const pptResponse = await fetch(`${base}/content/generate-ppt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: '门店月度经营复盘',
        structure: '真实数据→问题判断→下月行动',
        pages: 5,
        employeeIdx: 7,
      }),
    });
    assert.equal(pptResponse.status, 409);
    const ppt = await pptResponse.json();
    assert.match(ppt.error, /模板|降级|不是真实可交付/u);
    assert.equal(
      db.prepare(`SELECT COUNT(*) count FROM contents
        WHERE tenant_id=1 AND type='AIPPT' AND title='门店月度经营复盘·AIPPT'`).get().count,
      0,
      '无真实API时不得把模板底稿落成PPT交付',
    );

    const dailyContentBefore = db.prepare(`SELECT COUNT(*) count FROM contents WHERE tenant_id=1`).get().count;
    const dailyResponse = await fetch(`${base}/content/daily-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: '周末家庭聚餐', employeeIdx: 3 }),
    });
    // 无 API 时三个子任务都不能把模板底稿冒充成成功；应统一失败、退款且零产物。
    assert.equal(dailyResponse.status, 502);
    const daily = await dailyResponse.json();
    assert.equal(daily.status, 'failed');
    assert.equal(daily.failures.length, 3);
    assert.equal(daily.summary.requestedParts, 3);
    assert.equal(daily.summary.succeededParts + daily.summary.failedParts, 3);
    assert.equal(daily.summary.producedItems, 0);
    assert.equal(daily.results.length, 0);
    assert.equal(daily.failures.length, daily.summary.failedParts);
    assert.ok(daily.failures.every(item => /模板|降级|不是真实可交付/u.test(item.error)));
    assert.equal(db.prepare(`SELECT COUNT(*) count FROM contents WHERE tenant_id=1`).get().count, dailyContentBefore);

    const imageResponse = await fetch(`${base}/content/generate-image`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '门店已确认新品的桌面主图，不出现价格文字', employeeIdx: 5 }),
    });
    assert.equal(imageResponse.status, 503);
    const image = await imageResponse.json();
    assert.equal(image.employeeExecution.connector.kind, 'image');
    const imageRow = db.prepare(`SELECT profile_version,prompt_hash,snapshot_json
      FROM media_jobs WHERE tenant_id=1 AND id=?`).get(image.jobId);
    const imageSnapshot = JSON.parse(imageRow.snapshot_json);
    assert.equal(imageRow.profile_version, 'content-5-r7');
    assert.equal(imageRow.prompt_hash, image.employeeExecution.promptHash);
    assert.equal(imageSnapshot.identity.idx, 5);
    assert.equal(imageSnapshot.connector.kind, 'image');
    assert.equal(imageSnapshot.handlerExecution.legacyHandlerAdapterInvoked, false);
    assert.equal(imageSnapshot.handlerExecution.invocationCount, 0);
    assert.match(JSON.stringify(imageSnapshot), /A店视觉版权检查/u);

    const videoResponse = await fetch(`${base}/content/generate-video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '新品从厨房到餐桌的六秒镜头，不出现价格文字', employeeIdx: 5 }),
    });
    assert.equal(videoResponse.status, 503);
    const video = await videoResponse.json();
    assert.equal(video.employeeExecution.connector.kind, 'video');
    const videoRow = db.prepare(`SELECT profile_version,prompt_hash,snapshot_json
      FROM media_jobs WHERE tenant_id=1 AND id=?`).get(video.jobId);
    const videoSnapshot = JSON.parse(videoRow.snapshot_json);
    assert.equal(videoRow.profile_version, 'content-5-r7');
    assert.equal(videoRow.prompt_hash, video.employeeExecution.promptHash);
    assert.equal(videoSnapshot.identity.idx, 5);
    assert.equal(videoSnapshot.connector.kind, 'video');
    assert.equal(videoSnapshot.handlerExecution.legacyHandlerAdapterInvoked, false);
    assert.equal(videoSnapshot.handlerExecution.invocationCount, 0);
  });
});

after(() => {
  globalThis.fetch = nativeFetch;
  fakeYunwuEnabled = false;
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
  }
});

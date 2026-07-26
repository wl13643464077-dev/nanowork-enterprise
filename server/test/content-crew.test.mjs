import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-content-crew-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
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

q.run(`UPDATE tenants SET name='A餐饮门店',status='已开通',credits=100000 WHERE id=1`);
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(2,'B餐饮门店','已开通',100000)`);
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,?)`,
  'content-boss-a', 'x', 'A店老板', 'boss', '老板办', 1);
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,?)`,
  'content-boss-b', 'x', 'B店老板', 'boss', '老板办', 2);
const bossA = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='content-boss-a'`);
const bossB = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='content-boss-b'`);

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
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  '朋友圈文案', 'A店单工位文案', 'A店真实留痕的测试文案。', '午市新品', '可使用', 'template', bossA.id,
  3, 'draft', '撰稿人', '文案创作部', 'single_station', '2026-07-20 10:00:00').lastInsertRowid;
  mediaA = q.run(`INSERT INTO media_jobs(
    user_id,kind,model,prompt,status,url,
    content_employee_idx,content_employee_key,content_employee_name,content_employee_group,content_run_mode,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, bossA.id, 'image', 'test-image', 'A店新品主图', '成功', '/test/a.png',
  5, 'media', '多媒体师', '视觉工厂', 'single_station', '2026-07-21 10:00:00').lastInsertRowid;
});
runWithTenant(2, () => {
  contentB = q.run(`INSERT INTO contents(
    type,title,body,topic,status,ai_mode,creator_id,
    content_employee_idx,content_employee_key,content_employee_name,content_employee_group,content_run_mode,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  '朋友圈文案', 'B店私有文案', '不得跨租户读取。', 'B店主题', '可使用', 'template', bossB.id,
  3, 'draft', '撰稿人', '文案创作部', 'single_station', '2026-07-20 11:00:00').lastInsertRowid;
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

  const invalid = JSON.parse(JSON.stringify(CONTENT_CREW));
  invalid.employees[0].pipelinePrompt.template = '';
  assert.throws(() => validateContentCrewCatalog(invalid), /pipelinePrompt\.template不能为空/);
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
      assert.equal(skill.verificationStatus, 'legacy_unverified');
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

test('GET /content/crew返回目录及当前账号范围内的运行统计', async () => {
  await withServer(bossA, async base => {
    const response = await fetch(`${base}/content/crew`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.department.employeeTotal, 10);
    assert.match(data.executionBoundary, /不表示十个工位/);
    assert.equal(data.employees.find(employee => employee.idx === 3).runtime.outputs, 1);
    assert.equal(data.employees.find(employee => employee.idx === 5).runtime.mediaJobs, 1);
    assert.deepEqual(data.employees.find(employee => employee.idx === 3).taskTypes, ['文案初稿', '标题方案', '配图建议']);
    assert.deepEqual(data.employees.find(employee => employee.idx === 7).taskTypes, ['HTML演绎稿', '网页演示方案', '交互演绎稿']);
  });
  await withServer(bossB, async base => {
    const data = await fetch(`${base}/content/crew`).then(response => response.json());
    assert.equal(data.employees.find(employee => employee.idx === 3).runtime.outputs, 1);
    assert.equal(data.employees.find(employee => employee.idx === 5).runtime.mediaJobs, 0);
  });
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
    const response = await fetch(`${base}/content/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: '朋友圈文案', topic: '夏日午市新品', brand: '测试门店' }),
    });
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
    assert.match(data.dataset.disclaimer, /不代表十工位流水线/);

    const output = await fetch(`${base}/analysis/employee-outputs/drill/content/output-${contentA}`).then(response => response.json());
    assert.equal(output.record.employeeIdx, 3);
    assert.match(output.output.body, /A店真实留痕/);
    assert.match(output.disclaimer, /不表示内容部十个工位/);

    const media = await fetch(`${base}/analysis/employee-outputs/drill/content/media-${mediaA}`).then(response => response.json());
    assert.equal(media.record.employeeIdx, 5);
    assert.equal(media.output.artifactUrl, '/test/a.png');
    assert.equal((await fetch(`${base}/analysis/employee-outputs/drill/content/media-${backgroundTextJob}`)).status, 404);
  });
  db.prepare('DELETE FROM media_jobs WHERE tenant_id=1 AND id=?').run(backgroundTextJob);
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
    const backgroundJob = db.prepare(`SELECT profile_version,prompt_hash,snapshot_json
      FROM media_jobs WHERE tenant_id=1 AND id=?`).get(background.jobId);
    assert.equal(backgroundJob.profile_version, 'content-3-r5');
    assert.equal(backgroundJob.prompt_hash, background.employeeExecution.promptHash);
    assert.equal(JSON.parse(backgroundJob.snapshot_json).identity.idx, 3);

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
    assert.equal(pptResponse.status, 200);
    const ppt = await pptResponse.json();
    assert.equal(ppt.employeeExecution.connector.kind, 'ppt');
    assert.equal(ppt.employeeExecution.connector.addon, true);
    assert.equal(ppt.employeeExecution.connector.nativePrimaryArtifact, 'html');
    const pptRow = db.prepare(`SELECT profile_version,prompt_hash,snapshot_json
      FROM contents WHERE tenant_id=1 AND id=?`).get(ppt.id);
    const pptSnapshot = JSON.parse(pptRow.snapshot_json);
    assert.equal(pptRow.profile_version, 'content-7-r9');
    assert.equal(pptRow.prompt_hash, ppt.employeeExecution.promptHash);
    assert.equal(pptSnapshot.identity.idx, 7);
    assert.equal(pptSnapshot.connector.kind, 'ppt');
    assert.equal(pptSnapshot.connector.relationship, 'addon');
    assert.equal(pptSnapshot.connector.nativePrimaryArtifact, 'html');
    assert.match(JSON.stringify(pptSnapshot), /A店演绎结构检查/u);

    const dailyResponse = await fetch(`${base}/content/daily-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: '周末家庭聚餐', employeeIdx: 3 }),
    });
    assert.equal(dailyResponse.status, 200);
    const daily = await dailyResponse.json();
    assert.equal(daily.status, 'success');
    assert.equal(daily.results.length, 3);
    assert.equal(daily.failures.length, 0);
    assert.deepEqual(daily.summary, {
      requestedParts: 3,
      succeededParts: 3,
      failedParts: 0,
      producedItems: 11,
    });
    for (const item of daily.results) {
      assert.equal(item.employeeExecution.connector.kind, 'dailyPack');
      assert.equal(item.employeeExecution.connector.relationship, 'addon');
      const row = db.prepare(`SELECT profile_version,prompt_hash,snapshot_json
        FROM contents WHERE tenant_id=1 AND id=?`).get(item.id);
      const snapshot = JSON.parse(row.snapshot_json);
      assert.equal(row.profile_version, 'content-3-r5');
      assert.equal(snapshot.identity.idx, 3);
      assert.equal(snapshot.connector.kind, 'dailyPack');
      assert.match(JSON.stringify(snapshot), /A店文案事实核验/u);
    }

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
  });
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
  }
});

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const databasePath = path.join(os.tmpdir(), `native-content-skill-learning-${process.pid}.db`);
process.env.NANOWORK_DB = databasePath;
process.env.NODE_ENV = 'test';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.ENABLE_SCHEDULER = 'false';
const { db, q, initSchema, migrateV2, migrateContentEmployeeSkillConfigs, runWithTenant } = await import('../src/db.js');
initSchema(); migrateV2();
const { createContentEmployeeWorkbenchRouter } = await import('../src/routes/content-employee-workbench.js');
const { startSkillLearningRun, buildSkillLearningPrompt } = await import('../src/engines/employee-skill-learning.js');
const { activeContentEvolutionNotes } = await import('../src/engines/employee-evolution.js');
const users = [];
for (const [name, role] of [['一', 'boss'], ['二', 'boss'], ['三', 'sales']]) {
  const tenantId = Number(q.run("INSERT INTO tenants(name,status,credits) VALUES(?,'已开通',1000000)", `原生进修企业${name}`).lastInsertRowid);
  const id = Number(q.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES(?,'unused',?,?,'启用',?)", `native_skill_${name}`, `负责人${name}`, role, tenantId).lastInsertRowid);
  users.push({ id, name: `负责人${name}`, role, tenant_id: tenantId });
}

test('仅配置表从0–9迁移到0–11：全部旧数据、修订号、自定义索引和触发器保留且幂等', () => {
  db.exec(`DROP TABLE content_employee_workbench_configs;
    CREATE TABLE content_employee_workbench_configs (
      tenant_id INTEGER NOT NULL, employee_idx INTEGER NOT NULL CHECK(employee_idx BETWEEN 0 AND 9),
      prompt_override TEXT, work_config_json TEXT NOT NULL DEFAULT '{}', skills_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1, updated_by INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      PRIMARY KEY(tenant_id,employee_idx));
    CREATE INDEX idx_content_employee_workbench_configs_tenant ON content_employee_workbench_configs(tenant_id,employee_idx);
    CREATE INDEX native_skill_config_revision ON content_employee_workbench_configs(tenant_id,revision);
    CREATE TABLE native_skill_migration_events(value INTEGER);
    CREATE TRIGGER native_skill_config_updated AFTER UPDATE ON content_employee_workbench_configs
      BEGIN INSERT INTO native_skill_migration_events(value) VALUES(NEW.revision); END;`);
  q.run(`INSERT INTO content_employee_workbench_configs(tenant_id,employee_idx,prompt_override,work_config_json,skills_json,revision,updated_by,updated_at)
    VALUES(?,3,'旧提示词','{"language":"zh"}','[]',7,?,'2026-01-01')`, users[0].tenant_id, users[0].id);
  const before = q.get('SELECT * FROM content_employee_workbench_configs WHERE tenant_id=? AND employee_idx=3', users[0].tenant_id);
  assert.equal(migrateContentEmployeeSkillConfigs(), true);
  assert.deepEqual(q.get('SELECT * FROM content_employee_workbench_configs WHERE tenant_id=? AND employee_idx=3', users[0].tenant_id), before);
  assert.equal(migrateContentEmployeeSkillConfigs(), false);
  assert.ok(q.get("SELECT name FROM sqlite_master WHERE type='index' AND name='native_skill_config_revision'"));
  q.run('UPDATE content_employee_workbench_configs SET revision=8 WHERE tenant_id=? AND employee_idx=3', users[0].tenant_id);
  assert.equal(q.get('SELECT value FROM native_skill_migration_events').value, 8);
  assert.match(q.get("SELECT sql FROM sqlite_master WHERE name='content_employee_runs'").sql, /BETWEEN 0 AND 9/u);
  assert.match(q.get("SELECT sql FROM sqlite_master WHERE name='content_connector_runs'").sql, /BETWEEN 0 AND 9/u);
});

function dependencies(idx, calls) {
  const sources = Array.from({ length: 5 }, (_, i) => ({ title: `公开平台方法${idx}-${i}`, url: `https://example.test/native-${idx}/${i}`,
    snippet: '公开平台方法摘要', body: '公开网页正文介绍具体创作方法、适用范围、核验步骤和注意事项。'.repeat(12) }));
  return {
    agenticWebResearchFn: async query => { calls.push({ kind: 'search', query }); return { attempted: true, candidateReady: true, fetchCandidates: sources, provider: 'fixture', evidence: { steps: [] } }; },
    controlledWebFetchFn: async candidates => { calls.push({ kind: 'fetch' }); return { attempted: true, ok: true, results: candidates, evidence: {} }; },
    generateFn: async payload => {
      calls.push({ kind: 'generate', system: payload.system });
      return { mode: 'api', model: payload.model, usage: { inputTokens: 500, outputTokens: 200 }, text: JSON.stringify({ skills: sources.slice(0, 3).map((source, i) => ({
        title: `实用方法${idx}-${i}`, detail: '依据可见真实素材安排表达顺序，并在发布前复核尚未确认的经营事实。', sourceTitle: source.title, sourceUrl: source.url,
      })) }) };
    },
  };
}
async function server(user, options, callback) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => { req.user = user; next(); }));
  app.use('/content', createContentEmployeeWorkbenchRouter(options));
  const listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/content${route}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try { await callback(request); } finally { await new Promise(resolve => listener.close(resolve)); }
}

test('10/11真实进修持久化→重新加载→启停→重复进修，租户隔离且未接入的prompt/config保持关闭', async () => {
  for (const idx of [10, 11]) {
    const pending = []; const calls = [];
    const options = { scheduleFn: task => pending.push(task),
      startSkillLearningRunFn: args => startSkillLearningRun({ ...args, dependencies: dependencies(idx, calls) }) };
    await server(users[0], options, async request => {
      const initial = await request(`/${idx}`);
      assert.equal(initial.body.permissions.canEditSkills, true); assert.equal(initial.body.permissions.canLearn, true);
      assert.equal(initial.body.permissions.canEditPrompt, false); assert.equal(initial.body.permissions.canEditConfig, false);
      const custom = await request(`/${idx}/skills`, 'PUT', { customSkills: [{ title: `企业内部技巧${idx}`, detail: `PRIVATE_NATIVE_MARKER_${idx}必须留在内部提示词，不能提交公开搜索。` }] });
      assert.equal(custom.status, 200, JSON.stringify(custom.body));
      assert.equal((await request(`/${idx}/prompt`, 'PUT', { overrideTemplate: '不应保存' })).status, 409);
      assert.equal((await request(`/${idx}/config`, 'PUT', { values: {} })).status, 409);
      assert.equal((await request(`/${idx}/skills`, 'PUT', { skills: [{ id: initial.body.skillLibrary.required[0].id, enabled: false }] })).status, 400);
      const queued = await request(`/${idx}/learn`, 'POST', {});
      assert.equal(queued.status, 202, JSON.stringify(queued.body));
      assert.equal(calls.length, 0);
      await pending.shift()();
      const run = await request(`/${idx}/learning-runs/${queued.body.run.id}`);
      assert.equal(run.body.run.status, 'completed', JSON.stringify(run.body));
      assert.equal(run.body.run.skillsAdded, 3);
      const profile = (await request(`/${idx}`)).body;
      assert.equal(profile.skillLibrary.learned.length, 3);
      assert.equal(profile.skillLibrary.summary.enabledCount, 5);
      assert.equal(profile.runtime.enabledSkillCount, 5);
      assert.ok(profile.skillLibrary.learned.every(skill => skill.id.startsWith(`content-learned:${idx}:`) && skill.sourceUrl && skill.origin === 'learned'));
      const changed = await request(`/${idx}/skills`, 'PUT', { skills: [{ id: profile.skillLibrary.learned[0].id, enabled: false }] });
      assert.equal(changed.status, 200); assert.equal(changed.body.profile.skillLibrary.summary.enabledCount, 4);
      const repeated = await request(`/${idx}/learn`, 'POST', {}); await pending.shift()();
      const secondRun = (await request(`/${idx}/learning-runs/${repeated.body.run.id}`)).body.run;
      assert.equal(secondRun.status, 'completed', JSON.stringify(secondRun)); assert.equal(secondRun.skillsAdded, 0);
      assert.equal((await request(`/${idx}`)).body.skillLibrary.learned.find(skill => skill.id === profile.skillLibrary.learned[0].id).enabled, false);
      for (const call of calls.filter(call => call.kind === 'search')) {
        assert.doesNotMatch(call.query, /PRIVATE_NATIVE_MARKER|AI带货员|AI小红书种草员|原生进修企业|负责人/u);
        assert.match(call.query, idx === 10 ? /短视频|图生视频/u : /小红书/u);
        assert.match(call.query, /官方/u);
      }
      assert.ok(calls.some(call => call.kind === 'generate' && call.system.includes(`PRIVATE_NATIVE_MARKER_${idx}`)));
    });
    // 全新路由实例读取数据库，无内存技能缓存依赖。
    await server(users[0], {}, async request => assert.equal((await request(`/${idx}`)).body.skillLibrary.learned.length, 3));
    await server(users[1], {}, async request => assert.equal((await request(`/${idx}`)).body.skillLibrary.learned.length, 0));
    await server(users[2], {}, async request => {
      assert.equal((await request(`/${idx}/learn`, 'POST', {})).status, 403);
      assert.equal((await request(`/${idx}/skills`, 'PUT', { customSkills: [] })).status, 403);
      assert.equal((await request(`/${idx}`)).body.skillLibrary.redacted, true);
    });
  }
});

test('公共搜索主题不接受内部昵称、职责或私有技能内容，小红书已采纳心得可按租户读取', () => {
  for (const idx of [10, 11]) {
    const prompt = buildSkillLearningPrompt({ domain: 'content', idx, name: 'PRIVATE_INTERNAL_NAME', duty: 'PRIVATE_DUTY', positionSkill: 'PRIVATE_POSITION', existingSkills: [{ title: 'PRIVATE_SKILL', detail: 'PRIVATE_SKILL_DETAIL' }] });
    assert.doesNotMatch(prompt.researchQuery, /PRIVATE_/u);
    assert.match(prompt.system, /PRIVATE_DUTY/u);
  }
  const id = Number(q.run("INSERT INTO employee_evolution_notes(tenant_id,domain,specialist_id,note,status) VALUES(?,'content',11,'经人工确认的小红书表达心得','active')", users[0].tenant_id).lastInsertRowid);
  assert.equal(activeContentEvolutionNotes(11, { tenantId: users[0].tenant_id })[0].id, id);
  assert.equal(activeContentEvolutionNotes(11, { tenantId: users[1].tenant_id }).length, 0);
});

test('原生进修聚焦当前餐饮制作流程和来源场景，不把工具营销或广告规则泛化，旧岗位提示保持原口径', () => {
  const employee = { domain: 'content', name: 'PRIVATE_EMPLOYEE', duty: 'PRIVATE_DUTY' };
  const video = buildSkillLearningPrompt({ ...employee, idx: 10 });
  const xhs = buildSkillLearningPrompt({ ...employee, idx: 11 });
  for (const prompt of [video, xhs]) {
    assert.match(prompt.researchQuery, /面向餐饮老板/u);
    assert.match(prompt.researchQuery, /不限最近三个月/u);
    assert.match(prompt.researchQuery, /仍须实际搜索并回读正文/u);
    assert.match(prompt.researchQuery, /第三方博客、工具评测或销售教程不能当作官方文档、官方API或平台政策证据/u);
    assert.doesNotMatch(prompt.researchQuery, /工具玩法|最近三个月的方法论|PRIVATE_/u);
    assert.match(prompt.system, /可移植的具体创作步骤、适用条件与检查方法/u);
    assert.match(prompt.system, /不增加自动发布、矩阵账号运营、CRM回流、声音克隆/u);
    assert.match(prompt.system, /不新增让已有内容直接失败的硬性验收门/u);
  }
  assert.match(video.researchQuery, /真实菜品参考图.*多镜头菜品外观和场景连续性/u);
  assert.match(video.researchQuery, /预设TTS配音.*字幕可读性.*剪辑衔接/u);
  assert.match(video.system, /不把声音克隆、口型驱动、未接入模型（如Veo）或其他产品专有能力写成当前能力/u);
  assert.match(xhs.researchQuery, /真实菜品、门头照片与已确认品牌信息/u);
  assert.match(xhs.researchQuery, /标题、正文、话题标签、首条评论/u);
  assert.match(xhs.researchQuery, /可复制后由用户自行发布/u);
  assert.match(xhs.researchQuery, /聚光资料属于广告场景，不能泛化为自然笔记规则/u);
  assert.match(xhs.system, /不学习开发API、抓取逆向、外部脚本装配、商业代理商政策或招商协作路线/u);
  for (const idx of Array.from({ length: 10 }, (_, i) => i)) {
    const original = buildSkillLearningPrompt({ ...employee, idx });
    assert.ok(original.researchQuery.startsWith('检索以下公开业务主题最近三个月的方法论、平台规则变化、工具玩法与案例：'));
    assert.equal(original.user, '请为「PRIVATE_EMPLOYEE」补充最近三个月公开出现的新方法论、平台规则变化、实用工具玩法和可执行技巧；只整理下方受控证据支持的新内容。');
    assert.doesNotMatch(original.system, /当前工作流|可移植的具体创作步骤/u);
    assert.deepEqual(original.responseSchema, video.responseSchema);
  }
  const restaurant = buildSkillLearningPrompt({ ...employee, domain: 'restaurant', idx: 10 });
  assert.ok(restaurant.researchQuery.startsWith('检索以下公开业务主题最近三个月的方法论、平台规则变化、工具玩法与案例：'));
  assert.doesNotMatch(restaurant.system, /当前工作流/u);
});

after(() => { db.close(); removeTempDbSafely(databasePath); });

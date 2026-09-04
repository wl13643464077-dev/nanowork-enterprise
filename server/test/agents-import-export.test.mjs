/**
 * B11 自定义智能体导出/导入：
 * - GET /agents/:id/export 结构；
 * - POST /agents/import 两种格式（本平台导出 JSON / 通用步骤式工作流 JSON）；
 * - 非法 JSON 与无法识别格式 → 400；
 * - 变量占位编译进系统提示词；
 * - 原始 JSON 存入 custom_agents.source_workflow；
 * - 租户隔离与既有权限（agentForUser）不放宽。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-agents-import-export-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const {
  AGENT_EXPORT_SCHEMA,
  compilePromptWorkflow,
  parseAgentImport,
  parseImportSource,
} = await import('../src/engines/agent-workflow-import.js');
const agentRoutes = (await import('../src/routes/agents.js')).default;

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status) VALUES(2,'导入租户二','已开通')
  ON CONFLICT(id) DO UPDATE SET status=excluded.status`);
const boss = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'import-boss', hashPassword('Secret123!'), '导入老板', 'boss', '启用', 1).lastInsertRowid;
const staffA = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'import-a', hashPassword('Secret123!'), '员工A', 'sales', '启用', 1).lastInsertRowid;
const staffB = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'import-b', hashPassword('Secret123!'), '员工B', 'sales', '启用', 1).lastInsertRowid;
const staffT2 = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'import-t2', hashPassword('Secret123!'), '租户二员工', 'sales', '启用', 2).lastInsertRowid;

let agentA;
runWithTenant(1, () => {
  agentA = q.run(`INSERT INTO custom_agents(name,emoji,tier,prompt,skills,persona,creator_id)
    VALUES('周报助手','📝','expert','请按门店周报模板整理数据','["docx"]','严谨的运营分析师',?)`, staffA).lastInsertRowid;
});

const actors = {
  boss: { id: boss, name: '导入老板', role: 'boss', tenant_id: 1 },
  staffA: { id: staffA, name: '员工A', role: 'sales', tenant_id: 1 },
  staffB: { id: staffB, name: '员工B', role: 'sales', tenant_id: 1 },
  staffT2: { id: staffT2, name: '租户二员工', role: 'sales', tenant_id: 2 },
};

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  const actor = actors[String(req.get('x-test-actor') || '')];
  if (!actor) return res.status(401).json({ error: '测试身份不存在' });
  return runWithTenant(actor.tenant_id, () => { req.user = actor; next(); });
});
app.use('/agents', agentRoutes);
const server = app.listen(0);
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

async function api(actor, route, { method = 'GET', body, rawBody } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-actor': actor },
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

const WORKFLOW = {
  name: '新店开业筹备流程',
  description: '把开业前 30 天的筹备事项按步骤推进。',
  variables: [{ key: 'store_name', label: '门店名称' }, { key: 'open_date', label: '开业日期' }],
  steps: [
    { title: '确认基础信息', prompt: '向用户确认 {{store_name}} 的开业日期 {{open_date}} 与目标客群。' },
    { title: '倒排筹备计划', prompt: '按 {{open_date}} 倒排 30 天筹备计划，每周一个里程碑，负责人写 {{owner}}。' },
    '输出开业当天检查清单，含食安与人员分工。',
  ],
};

test('导出结构：不含内部字段，可直接再导入', async () => {
  const exported = await api('staffA', `/agents/${agentA}/export`);
  assert.equal(exported.status, 200, JSON.stringify(exported.json));
  assert.equal(exported.json.schemaVersion, AGENT_EXPORT_SCHEMA);
  assert.ok(exported.json.exportedAt);
  assert.deepEqual(exported.json.agent, {
    name: '周报助手',
    emoji: '📝',
    tier: 'expert',
    prompt: '请按门店周报模板整理数据',
    skills: ['docx'],
    persona: '严谨的运营分析师',
  });
  assert.equal(exported.json.sourceWorkflow, null);
  assert.equal('tenant_id' in exported.json.agent, false);
  assert.equal('creator_id' in exported.json.agent, false);

  const reimported = await api('staffA', '/agents/import', { method: 'POST', body: { payload: exported.json, name: '周报助手（副本）' } });
  assert.equal(reimported.status, 200, JSON.stringify(reimported.json));
  assert.equal(reimported.json.kind, 'nanowork_export');
  assert.equal(reimported.json.agent.name, '周报助手（副本）');
  assert.equal(reimported.json.agent.tier, 'expert');
  assert.deepEqual(reimported.json.agent.skills, ['docx']);
  const row = runWithTenant(1, () => q.get(`SELECT * FROM custom_agents WHERE tenant_id=1 AND id=?`, reimported.json.id));
  assert.equal(row.persona, '严谨的运营分析师');
  const envelope = JSON.parse(row.source_workflow);
  assert.equal(envelope.kind, 'nanowork_export');
  assert.equal(envelope.importedBy, staffA);
  assert.equal(envelope.source.schemaVersion, AGENT_EXPORT_SCHEMA);
});

test('通用步骤式工作流：编译成带步骤编号与变量占位说明的系统提示词，原始 JSON 落 source_workflow', async () => {
  const preview = await api('boss', '/agents/import/preview', { method: 'POST', body: { payload: WORKFLOW } });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.kind, 'prompt_workflow');
  assert.equal(preview.json.workflow.steps.length, 3);
  assert.equal(preview.json.workflow.steps[2].title, '步骤 3');
  assert.deepEqual(preview.json.workflow.variables.map(item => item.key), ['store_name', 'open_date', 'owner']);
  assert.deepEqual(preview.json.workflow.undeclaredVariables, ['owner']);
  assert.equal(runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM custom_agents WHERE tenant_id=1 AND name=?`, WORKFLOW.name)).n, 0, '预览不落库');

  const imported = await api('boss', '/agents/import', { method: 'POST', body: { text: JSON.stringify(WORKFLOW) } });
  assert.equal(imported.status, 200, JSON.stringify(imported.json));
  assert.equal(imported.json.kind, 'prompt_workflow');
  assert.equal(imported.json.agent.tier, 'simple');
  assert.deepEqual(imported.json.agent.skills, []);
  const prompt = imported.json.agent.prompt;
  assert.match(prompt, /^【工作流：新店开业筹备流程】/u);
  assert.match(prompt, /把开业前 30 天的筹备事项按步骤推进。/u);
  assert.match(prompt, /【变量说明】/u);
  assert.match(prompt, /- \{\{store_name\}\}：门店名称/u);
  assert.match(prompt, /- \{\{open_date\}\}：开业日期/u);
  assert.match(prompt, /- \{\{owner\}\}：owner/u, '未声明的占位符自动补进变量说明');
  assert.match(prompt, /第 1 步 · 确认基础信息\n向用户确认 \{\{store_name\}\}/u);
  assert.match(prompt, /第 2 步 · 倒排筹备计划/u);
  assert.match(prompt, /第 3 步 · 步骤 3\n输出开业当天检查清单/u);
  assert.match(prompt, /【输出要求】/u);

  const row = runWithTenant(1, () => q.get(`SELECT * FROM custom_agents WHERE tenant_id=1 AND id=?`, imported.json.id));
  assert.equal(row.prompt, prompt);
  const envelope = JSON.parse(row.source_workflow);
  assert.equal(envelope.kind, 'prompt_workflow');
  assert.deepEqual(envelope.source, WORKFLOW, '原始 JSON 原样保留以便回溯');

  const exported = await api('boss', `/agents/${imported.json.id}/export`);
  assert.equal(exported.status, 200);
  assert.equal(exported.json.sourceWorkflow.kind, 'prompt_workflow');
  const list = await api('boss', '/agents');
  const listed = list.json.find(item => item.id === imported.json.id);
  assert.equal(listed.imported, true);
  assert.equal(listed.last_used_at, null);
});

test('非法 JSON、无法识别格式与超限工作流返回 400 且不落库', async () => {
  const before = runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM custom_agents WHERE tenant_id=1`)).n;
  const badJson = await api('boss', '/agents/import', { method: 'POST', body: { text: '{"name": "坏掉的", steps: [' } });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.code, 'AGENT_IMPORT_JSON_INVALID');

  const unknown = await api('boss', '/agents/import', { method: 'POST', body: { payload: { bot_id: 'coze-123', nodes: [] } } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.code, 'AGENT_IMPORT_FORMAT_UNSUPPORTED');
  assert.match(unknown.json.error, /扣子\/火山/u);

  const badSchema = await api('boss', '/agents/import', { method: 'POST', body: { payload: { schemaVersion: 'nanowork.custom-agent-export/9', agent: { name: 'x', prompt: 'y' } } } });
  assert.equal(badSchema.status, 400);
  assert.equal(badSchema.json.code, 'AGENT_IMPORT_SCHEMA_UNSUPPORTED');

  const emptySteps = await api('boss', '/agents/import', { method: 'POST', body: { payload: { name: '空流程', steps: [] } } });
  assert.equal(emptySteps.status, 400);
  assert.match(emptySteps.json.error, /steps 必须是非空数组/u);

  const badVariable = await api('boss', '/agents/import', { method: 'POST', body: { payload: { name: '变量错', steps: ['做点什么'], variables: [{ key: '门店-名' }] } } });
  assert.equal(badVariable.status, 400);
  assert.match(badVariable.json.error, /variables\[0\]\.key/u);

  const unknownSkill = await api('boss', '/agents/import', {
    method: 'POST',
    body: { payload: { schemaVersion: AGENT_EXPORT_SCHEMA, agent: { name: '坏技能', prompt: 'p', tier: 'normal', skills: ['shell-root'] } } },
  });
  assert.equal(unknownSkill.status, 400, '导入同样经过 normalizedAgent 的技能白名单');
  assert.match(unknownSkill.json.error, /未知技能/u);

  const tooManySteps = await api('boss', '/agents/import', {
    method: 'POST',
    body: { payload: { name: '超长', steps: Array.from({ length: 31 }, (_, index) => `第${index}步`) } },
  });
  assert.equal(tooManySteps.status, 400);
  assert.match(tooManySteps.json.error, /最多 30 步/u);

  const emptyPreview = await api('boss', '/agents/import/preview', { method: 'POST', body: { text: '   ' } });
  assert.equal(emptyPreview.status, 400);
  const after = runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM custom_agents WHERE tenant_id=1`)).n;
  assert.equal(after, before, '失败的导入不得落库');
});

test('租户隔离与既有权限：跨租户/同事的智能体不可导出，导入只落本租户', async () => {
  const crossTenant = await api('staffT2', `/agents/${agentA}/export`);
  assert.equal(crossTenant.status, 404);
  const colleague = await api('staffB', `/agents/${agentA}/export`);
  assert.equal(colleague.status, 404, 'agentForUser 权限不放宽：同事不能导出他人智能体');
  const bossExport = await api('boss', `/agents/${agentA}/export`);
  assert.equal(bossExport.status, 200, '老板可导出本企业智能体');

  const importedT2 = await api('staffT2', '/agents/import', { method: 'POST', body: { payload: WORKFLOW } });
  assert.equal(importedT2.status, 200, JSON.stringify(importedT2.json));
  const rowT2 = q.get(`SELECT tenant_id,creator_id FROM custom_agents WHERE id=?`, importedT2.json.id);
  assert.equal(rowT2.tenant_id, 2);
  assert.equal(rowT2.creator_id, staffT2);
  const tenantOneList = await api('boss', '/agents');
  assert.ok(!tenantOneList.json.some(item => item.id === importedT2.json.id), '租户一看不到租户二导入的智能体');
  const tenantTwoList = await api('staffT2', '/agents');
  assert.deepEqual(tenantTwoList.json.map(item => item.id), [importedT2.json.id]);
  const exportFromOne = await api('boss', `/agents/${importedT2.json.id}/export`);
  assert.equal(exportFromOne.status, 404, '租户一老板不能导出租户二智能体');
});

test('纯函数：parseImportSource/compilePromptWorkflow 的边界', () => {
  assert.throws(() => parseImportSource(''), /请上传或粘贴/u);
  assert.throws(() => parseImportSource('[1,2]'), /根节点必须是对象/u);
  assert.throws(() => parseImportSource('x'.repeat(200_001)), /200KB/u);
  assert.deepEqual(parseImportSource({ a: 1 }), { a: 1 });
  const compiled = compilePromptWorkflow({ name: '极简', steps: [{ prompt: '做 {{ thing }}' }] });
  assert.deepEqual(compiled.variables, [{ key: 'thing', label: 'thing' }]);
  assert.match(compiled.prompt, /第 1 步 · 步骤 1/u);
  assert.throws(() => compilePromptWorkflow({ steps: ['x'] }), /缺少 name/u);
  assert.throws(
    () => compilePromptWorkflow({ name: '太长', steps: Array.from({ length: 6 }, () => 'x'.repeat(4000)) }),
    /超过智能体 20000 字上限/u,
  );
  const parsed = parseAgentImport({ agent: { name: '无版本号导出', prompt: 'p' } });
  assert.equal(parsed.kind, 'nanowork_export', '缺 schemaVersion 但带 agent 字段仍按本平台导出处理');
});

test('cleanup', async () => {
  await new Promise(resolve => server.close(resolve));
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
});

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(os.tmpdir(), `nanowork-business-flow-${process.pid}-${Date.now()}.db`);
const DATABASE_FILES = [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`];
for (const file of DATABASE_FILES) fs.rmSync(file, { force: true });

process.env.NANOWORK_DB = DB_PATH;
process.env.NODE_ENV = 'test';
process.env.SEED_DEMO = 'false';
process.env.ENABLE_SCHEDULER = 'false';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';
process.env.JWT_SECRET = 'Business-Flow-Test#2026!local-only';
// A whitespace sentinel prevents the local .env loader from inheriting a paid key.
process.env.YUNWU_API_KEY = ' ';
process.env.ANTHROPIC_API_KEY = ' ';
process.env.OPENAI_API_KEY = ' ';
process.env.BOCHA_API_KEY = ' ';
process.env.TAVILY_API_KEY = ' ';
process.env.SERPER_API_KEY = ' ';

const nativeFetch = globalThis.fetch.bind(globalThis);
const externalNetworkAttempts = [];
globalThis.fetch = async (input, init) => {
  const raw = String(typeof input === 'string' || input instanceof URL ? input : input?.url || input);
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    externalNetworkAttempts.push(raw);
    throw new Error('business-flow acceptance forbids external network access');
  }
  return nativeFetch(input, init);
};

const { db, initSchema, migrateV2 } = await import('../src/db.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const { hashPassword } = await import('../src/util.js');
const { createApp } = await import('../src/app.js');
const { holdCredits, releaseHold, settleHold } = await import('../src/engines/credits.js');
const {
  buildRestaurantOutputDeliverableFixture,
  getRestaurantOutputContract,
  renderRestaurantOutputMarkdown,
  validateRestaurantEmployeeOutputContract,
} = await import('../src/engines/restaurant-output-contract.js');

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const password = 'Business-Flow#2026';
const passwordHash = hashPassword(password);
const allModules = JSON.stringify([
  'dashboard', 'advisor', 'marshals', 'content', 'execution', 'system', 'assets',
]);
const insertTenant = db.prepare(`INSERT INTO tenants(
  id,name,status,plan,modules,data_mode,credits,total_recharged
) VALUES(?,?,?,?,?,'live',?,0)`);
insertTenant.run(801, '业务穿刺验收企业', '已开通', '旗舰版', allModules, 100_000);
insertTenant.run(802, '跨租户对照企业', '已开通', '旗舰版', allModules, 100_000);

const insertUser = db.prepare(`INSERT INTO users(
  username,password_hash,name,role,status,tenant_id,modules,manager_id
) VALUES(?,?,?,?,?,?,?,?)`);
const bossId = Number(insertUser.run(
  'flow_boss', passwordHash, '业务穿刺老板', 'boss', '启用', 801, allModules, null,
).lastInsertRowid);
const opsId = Number(insertUser.run(
  'flow_ops', passwordHash, '业务穿刺运营', 'ops_director', '启用', 801, allModules, null,
).lastInsertRowid);
const managerId = Number(insertUser.run(
  'flow_manager', passwordHash, '业务穿刺经理', 'manager', '启用', 801, allModules, opsId,
).lastInsertRowid);
const salesId = Number(insertUser.run(
  'flow_sales', passwordHash, '业务穿刺员工', 'sales', '启用', 801,
  JSON.stringify(['dashboard', 'execution']), managerId,
).lastInsertRowid);
const peerSalesId = Number(insertUser.run(
  'flow_peer', passwordHash, '同级对照员工', 'sales', '启用', 801,
  JSON.stringify(['dashboard', 'execution']), opsId,
).lastInsertRowid);
const otherBossId = Number(insertUser.run(
  'flow_other', passwordHash, '跨租户老板', 'boss', '启用', 802, allModules, null,
).lastInsertRowid);

const marshalId = Number(db.prepare(
  "SELECT id FROM marshals WHERE code='M-07' ORDER BY id LIMIT 1",
).get().id);
const marshalName = db.prepare('SELECT name FROM marshals WHERE id=?').get(marshalId).name;
const restaurantEmployeeIdx = Number(db.prepare('SELECT employee_idx FROM specialists WHERE id=55').get().employee_idx);
const restaurantTaskTitle = '餐厅经营复盘';
const restaurantTaskRequirement = '公开要求';
const restaurantParsedOutput = buildRestaurantOutputDeliverableFixture(restaurantEmployeeIdx, {
  title: restaurantTaskTitle,
  requirement: restaurantTaskRequirement,
});
const restaurantContract = getRestaurantOutputContract(restaurantEmployeeIdx);
const restaurantValidated = validateRestaurantEmployeeOutputContract(
  restaurantEmployeeIdx,
  restaurantParsedOutput,
  { task: { title: restaurantTaskTitle, requirement: restaurantTaskRequirement } },
);
const restaurantBody = renderRestaurantOutputMarkdown(
  restaurantEmployeeIdx,
  restaurantParsedOutput,
  { task: { title: restaurantTaskTitle, requirement: restaurantTaskRequirement } },
);
const restaurantArtifactSha = crypto.createHash('sha256').update(restaurantValidated.artifacts[0].content).digest('hex');

const restaurantOutputId = Number(db.prepare(`INSERT INTO contents(
  tenant_id,type,title,body,status,ai_mode,creator_id,marshal_id,snapshot_json
) VALUES(801,'员工产出','经营复盘产出',?,'待审核','api',?,?,?)`).run(
  restaurantBody,
  salesId,
  marshalId,
  JSON.stringify({ secret: 'DO_NOT_LEAK_RESTAURANT_SNAPSHOT' }),
).lastInsertRowid);
const restaurantTaskId = Number(db.prepare(`INSERT INTO agent_tasks(
  tenant_id,marshal_id,specialist_id,title,type,requirement,status,output_id,created_by,
  employee_profile_version,employee_prompt_hash,employee_capabilities_snapshot,
  employee_config_snapshot,employee_skills_snapshot,employee_web_snapshot
) VALUES(801,?,55,'餐厅经营复盘','执行方案','公开要求','待审阅',?,?,?, ?,?,?,?,?)`).run(
  marshalId,
  restaurantOutputId,
  salesId,
  'DO_NOT_LEAK_PROFILE_VERSION',
  'DO_NOT_LEAK_PROMPT_HASH',
  '["DO_NOT_LEAK_CAPABILITY"]',
  '{"secret":"DO_NOT_LEAK_CONFIG"}',
  '["DO_NOT_LEAK_SKILL"]',
  JSON.stringify({
    kind: 'restaurant_employee_execution_evidence',
    secret: 'DO_NOT_LEAK_EXECUTION',
    outputContract: {
      valid: true,
      contractId: restaurantContract.contractId,
      schemaVersion: restaurantContract.schemaVersion,
      primaryArtifact: restaurantContract.primaryArtifact,
      parsedOutput: restaurantParsedOutput,
      providerResponseSha256: restaurantArtifactSha,
      renderedBodySha256: crypto.createHash('sha256').update(restaurantBody).digest('hex'),
      artifacts: [{
        primary: true,
        kind: restaurantContract.primaryArtifact,
        contractId: restaurantContract.contractId,
        schemaVersion: restaurantContract.schemaVersion,
        contentSha256: restaurantArtifactSha,
      }],
    },
    internalProfileLeakage: { detected: false, matches: [] },
  }),
).lastInsertRowid);
const restaurantApprovalId = Number(db.prepare(`INSERT INTO approvals(
  tenant_id,target_type,target_id,title,summary,status,submitter_id
) VALUES(801,'content',?,'经营复盘待审核','公开摘要','待审核',?)`).run(
  restaurantOutputId,
  salesId,
).lastInsertRowid);
const restaurantBilling = holdCredits({
  userId: salesId,
  feature: `员工任务·${marshalName}`,
  kind: 'text',
  model: 'test-model',
  credits: 5,
  refType: 'agent_task',
  refId: restaurantTaskId,
});
settleHold(restaurantBilling, {
  credits: 2,
  aiMode: 'api',
  model: 'test-model',
  usage: { inputTokens: 80, outputTokens: 20 },
  note: '测试：餐饮员工产出已完成真实结算',
});

const legacyAwaitingAssignmentTaskId = Number(db.prepare(`INSERT INTO agent_tasks(
  tenant_id,marshal_id,specialist_id,title,type,requirement,status,created_by
) VALUES(801,?,55,'旧任务未派给具体员工','执行方案','公开要求','执行中',?)`).run(
  marshalId,
  salesId,
).lastInsertRowid);
const templateOutputId = Number(db.prepare(`INSERT INTO contents(
  tenant_id,type,title,body,status,ai_mode,creator_id,marshal_id
) VALUES(801,'员工产出','模板底稿','只是模板正文','待审核','template',?,?)`).run(
  salesId,
  marshalId,
).lastInsertRowid);
const templateCompletedTaskId = Number(db.prepare(`INSERT INTO agent_tasks(
  tenant_id,marshal_id,specialist_id,title,type,requirement,status,output_id,created_by,
  employee_profile_version,employee_web_snapshot
) VALUES(801,?,55,'模板被误标完成','执行方案','公开要求','已完成',?,?,'template-profile','{}')`).run(
  marshalId,
  templateOutputId,
  salesId,
).lastInsertRowid);

const invalidContractRunId = Number(db.prepare(`INSERT INTO content_employee_runs(
  tenant_id,employee_idx,employee_key,employee_name,employee_group,title,type,requirement,
  status,result_md,ai_mode,model,profile_version,prompt_hash,snapshot_json,created_by
) VALUES(801,0,'trend','趋势官','热点雷达部','格式错误的趋势稿','趋势报告','公开任务要求',
  '待审阅','{"status":"blocked","review":"draft_pending_human_review"}','api','deepseek-v4-flash',?,?,?,?)`).run(
  'invalid-contract-profile',
  'invalid-contract-hash',
  JSON.stringify({ contractValid: false, contractErrors: ['缺少必填字段'] }),
  salesId,
).lastInsertRowid);

const releasedBilling = holdCredits({
  userId: salesId,
  feature: '业务流退款口径',
  kind: 'text',
  model: 'test-model',
  credits: 12,
  refType: 'agent_task',
  refId: templateCompletedTaskId,
});
releaseHold(releasedBilling, '测试：质检失败且预授权确已释放');
holdCredits({
  userId: salesId,
  feature: '业务流待对账口径',
  kind: 'text',
  model: 'test-model',
  credits: 12,
  refType: 'content_employee_run',
  refId: invalidContractRunId,
});

const contentRunId = Number(db.prepare(`INSERT INTO content_employee_runs(
  tenant_id,employee_idx,employee_key,employee_name,employee_group,title,type,requirement,
  status,result_md,ai_mode,model,profile_version,prompt_hash,snapshot_json,created_by
) VALUES(801,3,'draft','撰稿人','文案创作部','会员唤醒文案','文案初稿','公开任务要求',
  '已完成','公开产出','api','deepseek-v4-flash',?,?,?,?)`).run(
  'DO_NOT_LEAK_CONTENT_PROFILE',
  'DO_NOT_LEAK_CONTENT_PROMPT_HASH',
  JSON.stringify({
    secret: 'DO_NOT_LEAK_CONTENT_SNAPSHOT',
    contractValid: true,
    billing: {
      state: 'settled',
      chargedCredits: 5,
      pendingReconciliation: false,
    },
    providerAttempt: {
      mode: 'api',
      model: 'deepseek-v4-flash',
      usage: { inputTokens: 51, outputTokens: 37 },
    },
    internalProfileLeakage: { detected: false, matches: [] },
    review: { decision: 'adopt' },
  }),
  salesId,
).lastInsertRowid);
const contentRunBilling = holdCredits({
  userId: salesId,
  feature: '内容员工单派·撰稿人',
  kind: 'text',
  model: 'deepseek-v4-flash',
  credits: 8,
  refType: 'content_employee_run',
  refId: contentRunId,
});
settleHold(contentRunBilling, {
  credits: 5,
  aiMode: 'api',
  model: 'deepseek-v4-flash',
  usage: { inputTokens: 51, outputTokens: 37 },
  note: '测试：内容员工权威结算',
});
const contentRunOutputCreatedAt = '2026-07-31 09:10:11';
const contentRunOutputId = Number(db.prepare(`INSERT INTO contents(
  tenant_id,type,title,body,status,ai_mode,creator_id,source_type,source_id,snapshot_json,created_at
) VALUES(801,'朋友圈文案','会员唤醒文案','已经人工采纳的公开业务内容','可使用','api',?,
  'content_employee_run',?,?,?)`).run(
  salesId,
  contentRunId,
  JSON.stringify({ contract: { valid: true, status: 'valid' } }),
  contentRunOutputCreatedAt,
).lastInsertRowid);
const materialId = Number(db.prepare(`INSERT INTO materials(
  tenant_id,name,type,source_type,source_id,creator_id,body_snapshot,snapshot_hash
) VALUES(801,'会员唤醒文案','文案','content_employee_run',?,?,?,?)`).run(
  contentRunId,
  salesId,
  'DO_NOT_LEAK_MATERIAL_BODY',
  'DO_NOT_LEAK_MATERIAL_HASH',
).lastInsertRowid);

const fallbackRunId = Number(db.prepare(`INSERT INTO content_employee_runs(
  tenant_id,employee_idx,employee_key,employee_name,employee_group,title,type,requirement,
  status,result_md,ai_mode,model,profile_version,prompt_hash,snapshot_json,created_by
) VALUES(801,3,'draft','撰稿人','文案创作部','降级伪产出','文案初稿','公开任务要求',
  '待审阅','降级正文','fallback','fallback',?,?,?,?)`).run(
  'fallback-profile',
  'fallback-hash',
  JSON.stringify({ contractValid: true }),
  salesId,
).lastInsertRowid);

const fallbackDownstreamRunId = Number(db.prepare(`INSERT INTO content_employee_runs(
  tenant_id,employee_idx,employee_key,employee_name,employee_group,title,type,requirement,
  status,result_md,ai_mode,model,profile_version,prompt_hash,snapshot_json,created_by
) VALUES(801,3,'draft','撰稿人','文案创作部','降级下游伪采纳','文案初稿','公开任务要求',
  '已完成','公开产出','api','deepseek-v4-flash',?,?,?,?)`).run(
  'fallback-downstream-profile',
  'fallback-downstream-hash',
  JSON.stringify({ contractValid: true, review: { decision: 'adopt' } }),
  salesId,
).lastInsertRowid);
const fallbackDownstreamContentId = Number(db.prepare(`INSERT INTO contents(
  tenant_id,type,title,body,status,ai_mode,creator_id,source_type,source_id,snapshot_json
) VALUES(801,'朋友圈文案','降级下游内容','不应可使用的降级正文','可使用','fallback',?,
  'content_employee_run',?,?)`).run(
  salesId,
  fallbackDownstreamRunId,
  JSON.stringify({ contract: { valid: true, status: 'valid' } }),
).lastInsertRowid);

const customAgentId = Number(db.prepare(`INSERT INTO custom_agents(
  tenant_id,name,emoji,tier,prompt,skills,persona,creator_id
) VALUES(801,'门店数据核验助手','🤖','simple','只核验已提供数据','[]','',?)`).run(
  salesId,
).lastInsertRowid);
const customAgentSessionId = Number(db.prepare(`INSERT INTO custom_agent_chat_sessions(
  tenant_id,agent_id,user_id,title
) VALUES(801,?,?,'门店核验')`).run(customAgentId, salesId).lastInsertRowid);
const customAgentUserMessageId = Number(db.prepare(`INSERT INTO custom_agent_chat_msgs(
  tenant_id,session_id,role,content
) VALUES(801,?,'user','请核验门店数据')`).run(customAgentSessionId).lastInsertRowid);
const customAgentAssistantMessageId = Number(db.prepare(`INSERT INTO custom_agent_chat_msgs(
  tenant_id,session_id,role,content
) VALUES(801,?,'assistant','DO_NOT_LEAK_CUSTOM_AGENT_OUTPUT_CONTENT')`).run(customAgentSessionId).lastInsertRowid);
const peerAgentSessionId = Number(db.prepare(`INSERT INTO custom_agent_chat_sessions(
  tenant_id,agent_id,user_id,title
) VALUES(801,?,?,'同级智能体会话')`).run(customAgentId, peerSalesId).lastInsertRowid);
const peerAgentAssistantMessageId = Number(db.prepare(`INSERT INTO custom_agent_chat_msgs(
  tenant_id,session_id,role,content
) VALUES(801,?,'assistant','同级不可引用产出')`).run(peerAgentSessionId).lastInsertRowid);
const otherAgentSessionId = Number(db.prepare(`INSERT INTO custom_agent_chat_sessions(
  tenant_id,agent_id,user_id,title
) VALUES(802,999999,?,'跨租户会话')`).run(otherBossId).lastInsertRowid);
const otherAgentAssistantMessageId = Number(db.prepare(`INSERT INTO custom_agent_chat_msgs(
  tenant_id,session_id,role,content
) VALUES(802,?,'assistant','跨租户不可引用产出')`).run(otherAgentSessionId).lastInsertRowid);

const manualTaskId = Number(db.prepare(`INSERT INTO tasks(
  tenant_id,title,detail,type,status,priority,assignee_id,assigned_by,source
) VALUES(801,'完成门店复盘','公开任务详情','数据','待执行','中',?,?,'手动')`).run(
  salesId,
  opsId,
).lastInsertRowid);
const manualReviewTaskId = Number(db.prepare(`INSERT INTO tasks(
  tenant_id,title,detail,type,status,priority,assignee_id,assigned_by,source
) VALUES(801,'等待管理层审核的门店复盘','公开任务详情','数据','待审核','中',?,?,'手动')`).run(
  salesId,
  managerId,
).lastInsertRowid);
db.prepare(`INSERT INTO task_submissions(
  tenant_id,task_id,user_id,content,result
) VALUES(801,?,?,?,'待审核')`).run(
  manualReviewTaskId,
  salesId,
  '等待管理层审核的公开提交',
);
const peerTaskId = Number(db.prepare(`INSERT INTO tasks(
  tenant_id,title,detail,type,status,priority,assignee_id,assigned_by,source
) VALUES(801,'同级员工任务','不可见详情','其他','待执行','中',?,?,'手动')`).run(
  peerSalesId,
  opsId,
).lastInsertRowid);

const deepRootTaskId = Number(db.prepare(`INSERT INTO tasks(
  tenant_id,title,detail,type,status,priority,assignee_id,assigned_by,source
) VALUES(801,'三级经营穿刺根任务','根任务内部详情','数据','已完成','高',?,?,'手动')`).run(
  opsId,
  bossId,
).lastInsertRowid);
const deepMiddleTaskId = Number(db.prepare(`INSERT INTO tasks(
  tenant_id,title,detail,type,status,priority,assignee_id,assigned_by,parent_task_id,source
) VALUES(801,'三级经营穿刺中层任务','中层内部详情','数据','已完成','高',?,?,?,'任务拆解')`).run(
  managerId,
  opsId,
  deepRootTaskId,
).lastInsertRowid);
const deepLeafTaskId = Number(db.prepare(`INSERT INTO tasks(
  tenant_id,title,detail,type,status,priority,assignee_id,assigned_by,parent_task_id,source
) VALUES(801,'三级经营穿刺员工任务','员工公开执行项','数据','已完成','高',?,?,?,'任务拆解')`).run(
  salesId,
  managerId,
  deepMiddleTaskId,
).lastInsertRowid);
const deepRootSubmissionId = Number(db.prepare(`INSERT INTO task_submissions(
  tenant_id,task_id,user_id,content,result,reviewer_id,reviewed_at
) VALUES(801,?,?,?,'通过',?,datetime('now','localtime'))`).run(
  deepRootTaskId,
  opsId,
  '根任务汇总内部内容',
  bossId,
).lastInsertRowid);
const deepMiddleSubmissionId = Number(db.prepare(`INSERT INTO task_submissions(
  tenant_id,task_id,user_id,content,result,reviewer_id,reviewed_at
) VALUES(801,?,?,?,'通过',?,datetime('now','localtime'))`).run(
  deepMiddleTaskId,
  managerId,
  '中层任务汇总内部内容',
  opsId,
).lastInsertRowid);
const deepLeafSubmissionId = Number(db.prepare(`INSERT INTO task_submissions(
  tenant_id,task_id,user_id,content,result,reviewer_id,reviewed_at
) VALUES(801,?,?,?,'通过',?,datetime('now','localtime'))`).run(
  deepLeafTaskId,
  salesId,
  '员工交付内部内容',
  managerId,
).lastInsertRowid);

const conversationId = Number(db.prepare(`INSERT INTO ai_conversations(
  tenant_id,user_id,title,diag_type
) VALUES(801,?,'经营诊断','经营诊断')`).run(bossId).lastInsertRowid);
const advisorMessageId = Number(db.prepare(`INSERT INTO ai_messages(
  tenant_id,conversation_id,role,content
) VALUES(801,?,'assistant','公开会诊结论')`).run(conversationId).lastInsertRowid);
const advisorTaskId = Number(db.prepare(`INSERT INTO tasks(
  tenant_id,title,detail,type,status,priority,assignee_id,assigned_by,source,source_ref_type,source_ref_id
) VALUES(801,'会诊行动项',?,'其他','待执行','中',?,?,'会诊','advisor_message',?)`).run(
  `检查标准：完成\n来源：AI会诊 #${advisorMessageId}`,
  bossId,
  bossId,
  advisorMessageId,
).lastInsertRowid);
const legacyLookalikeAdvisorTaskId = Number(db.prepare(`INSERT INTO tasks(
  tenant_id,title,detail,type,status,priority,assignee_id,assigned_by,source
) VALUES(801,'伪造正文来源任务',?,'其他','待执行','中',?,?,'会诊')`).run(
  `来源：AI会诊 #${advisorMessageId}`,
  bossId,
  bossId,
).lastInsertRowid);

const otherTaskId = Number(db.prepare(`INSERT INTO tasks(
  tenant_id,title,detail,type,status,priority,assignee_id,assigned_by,source
) VALUES(802,'跨租户任务','不可见','其他','待执行','中',?,?,'手动')`).run(
  otherBossId,
  otherBossId,
).lastInsertRowid);

const app = createApp({ serveStatic: false });
const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

async function request(pathname, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    payload: await response.json().catch(() => null),
  };
}

async function login(username) {
  const result = await request('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  return result.payload.token;
}

function accountingSnapshot() {
  const tableCount = (name, tenantId) => {
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    ).get(name);
    return exists
      ? db.prepare(`SELECT COUNT(*) n FROM ${name} WHERE tenant_id=?`).get(tenantId).n
      : 0;
  };
  return {
    credits: db.prepare('SELECT credits FROM tenants WHERE id=801').get().credits,
    holds: tableCount('credit_holds', 801),
    logs: tableCount('credit_logs', 801),
  };
}

function assertPublicFlow(payload, sourceType, sourceId) {
  assert.equal(payload.schemaVersion, 'nanowork.business-flow.v1');
  assert.equal(payload.source.type, sourceType);
  assert.equal(payload.source.id, sourceId);
  assert.ok(Array.isArray(payload.nodes) && payload.nodes.length > 0);
  assert.ok(Array.isArray(payload.links));
  assert.ok(payload.status?.code);
  assert.ok(payload.nextAction?.code);
  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    'DO_NOT_LEAK_', 'promptHash', 'profileVersion', 'capabilities', 'skills',
    'snapshot', 'requirement', 'result_md', 'body_snapshot',
  ]) assert.equal(serialized.includes(forbidden), false, `flow leaked ${forbidden}`);
}

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  for (const file of DATABASE_FILES) fs.rmSync(file, { force: true });
});

test('三角色读取公开业务流且 GET 不联网、不计费、不泄露员工内部档案', async () => {
  const [bossToken, opsToken, salesToken] = await Promise.all([
    login('flow_boss'), login('flow_ops'), login('flow_sales'),
  ]);
  const before = accountingSnapshot();

  for (const [token, canReview] of [[bossToken, true], [opsToken, true], [salesToken, false]]) {
    const restaurant = await request(`/api/business-flow/restaurant_task/${restaurantTaskId}`, { token });
    assert.equal(restaurant.status, 200, JSON.stringify(restaurant.payload));
    assertPublicFlow(restaurant.payload, 'restaurant_task', restaurantTaskId);
    assert.equal(restaurant.payload.status.code, 'review_pending');
    assert.equal(restaurant.payload.status.label, '待人工审阅');
    assert.equal(restaurant.payload.nextAction.code, canReview ? 'review_output' : 'wait_for_review');
    assert.equal(restaurant.payload.nextAction.href, canReview ? '/system?tab=approvals' : null);
    assert.ok(restaurant.payload.nodes.some(node => node.id === `approval:${restaurantApprovalId}`));

    const content = await request(`/api/business-flow/content_run/${contentRunId}`, { token });
    assert.equal(content.status, 200, JSON.stringify(content.payload));
    assertPublicFlow(content.payload, 'content_run', contentRunId);
    assert.equal(content.payload.status.code, 'approved');
    assert.equal(content.payload.status.label, '已人工采纳（可用于业务）');
    assert.ok(content.payload.nodes.some(node => node.id === `material:${materialId}`));
    const outputNode = content.payload.nodes.find(node => node.id === `content:${contentRunOutputId}`);
    assert.equal(outputNode?.occurredAt, contentRunOutputCreatedAt);
    assert.equal(outputNode?.href, `/content?contentId=${contentRunOutputId}`);

    const manual = await request(`/api/business-flow/manual_task/${manualTaskId}`, { token });
    assert.equal(manual.status, 200, JSON.stringify(manual.payload));
    assertPublicFlow(manual.payload, 'manual_task', manualTaskId);
    assert.equal(manual.payload.nextAction.code, 'execute_task');
  }

  const advisor = await request(`/api/business-flow/advisor_message/${advisorMessageId}`, { token: bossToken });
  assert.equal(advisor.status, 200, JSON.stringify(advisor.payload));
  assertPublicFlow(advisor.payload, 'advisor_message', advisorMessageId);
  assert.ok(advisor.payload.nodes.some(node => node.id === `manual-task:${advisorTaskId}`));
  assert.equal(advisor.payload.nodes.some(node => (
    node.id === `manual-task:${legacyLookalikeAdvisorTaskId}`
  )), false, '不得靠任务正文中的伪造 ID 建立参谋消息关联');
  assert.equal(advisor.payload.hasDownstream, true);

  const after = accountingSnapshot();
  assert.deepEqual(after, before);
  assert.deepEqual(externalNetworkAttempts, []);
});

test('模板、契约失败和未派活旧任务不再显示为完成或无限运行', async () => {
  const token = await login('flow_boss');
  const awaiting = await request(`/api/business-flow/restaurant_task/${legacyAwaitingAssignmentTaskId}`, { token });
  assert.equal(awaiting.status, 200, JSON.stringify(awaiting.payload));
  assert.equal(awaiting.payload.status.code, 'awaiting_assignment');
  assert.equal(awaiting.payload.status.label, '待派活');
  assert.equal(awaiting.payload.status.terminal, false);

  const template = await request(`/api/business-flow/restaurant_task/${templateCompletedTaskId}`, { token });
  assert.equal(template.status, 200, JSON.stringify(template.payload));
  assert.equal(template.payload.status.code, 'quality_failed');
  assert.equal(template.payload.status.label, '失败需返工（质检未通过）');
  assert.equal(
    template.payload.nodes.find(node => node.kind === 'billing')?.status,
    '预授权已释放（已退款）',
  );
  assert.equal(template.payload.nodes.some(node => node.status === '已完成'), false);
  assert.equal(template.payload.nodes.some(node => node.status === '待人工审阅'), false);

  db.prepare(`UPDATE agent_tasks SET status='失败',employee_web_snapshot=?
    WHERE tenant_id=801 AND id=?`).run(
    JSON.stringify({
      kind: 'restaurant_employee_execution_evidence',
      web: { attempted: false, ok: false, results: [] },
      outputContract: { valid: false, skipped: 'template_mode', artifacts: [] },
      reconciliation: {
        code: 'DEMO_UNADOPTABLE_CONTENT_RECONCILED',
        retryable: true,
      },
    }),
    templateCompletedTaskId,
  );
  db.prepare(`UPDATE contents SET status='已驳回' WHERE tenant_id=801 AND id=?`)
    .run(templateOutputId);
  db.prepare(`INSERT INTO approvals(
    tenant_id,target_type,target_id,title,summary,status,submitter_id,reviewer_id,reason,decided_at
  ) VALUES(801,'content',?,'模板底稿系统收口','质检未通过','已驳回',?,NULL,
    '系统质量对账：未形成可采纳产物',datetime('now','localtime'))`)
    .run(templateOutputId, salesId);
  const reconciledTemplate = await request(
    `/api/business-flow/restaurant_task/${templateCompletedTaskId}`,
    { token },
  );
  assert.equal(reconciledTemplate.status, 200, JSON.stringify(reconciledTemplate.payload));
  assert.equal(reconciledTemplate.payload.status.code, 'quality_failed');
  assert.equal(reconciledTemplate.payload.status.label, '失败需返工（质检未通过）');
  assert.equal(JSON.stringify(reconciledTemplate.payload).includes('人工审阅未通过'), false);

  const invalid = await request(`/api/business-flow/content_run/${invalidContractRunId}`, { token });
  assert.equal(invalid.status, 200, JSON.stringify(invalid.payload));
  assert.equal(invalid.payload.status.code, 'billing_pending');
  assert.equal(invalid.payload.status.label, '业务暂不可采用（待账务对账）');
  assert.equal(invalid.payload.nextAction.code, 'reconcile_billing');
  assert.equal(
    invalid.payload.nodes.find(node => node.kind === 'billing')?.status,
    '业务暂不可采用（待账务对账）',
  );
  assert.equal(invalid.payload.nodes.some(node => node.status === '待人工审阅'), false);
  assert.equal(invalid.payload.nodes.some(node => node.kind === 'review'), false);
  assert.equal(JSON.stringify(invalid.payload).includes('draft_pending_human_review'), false);
  assert.equal(JSON.stringify(invalid.payload).includes('blocked'), false);

  const fallbackRun = await request(`/api/business-flow/content_run/${fallbackRunId}`, { token });
  assert.equal(fallbackRun.status, 200, JSON.stringify(fallbackRun.payload));
  assert.equal(fallbackRun.payload.status.code, 'billing_pending');
  assert.equal(fallbackRun.payload.status.label, '业务暂不可采用（待账务对账）');
  assert.equal(fallbackRun.payload.nodes.some(node => node.status === '待人工审阅'), false);

  const fallbackDownstream = await request(
    `/api/business-flow/content_run/${fallbackDownstreamRunId}`,
    { token },
  );
  assert.equal(fallbackDownstream.status, 200, JSON.stringify(fallbackDownstream.payload));
  assert.equal(fallbackDownstream.payload.status.code, 'billing_pending');
  assert.equal(fallbackDownstream.payload.status.label, '业务暂不可采用（待账务对账）');
  assert.equal(
    fallbackDownstream.payload.nodes.find(node => node.id === `content:${fallbackDownstreamContentId}`)?.status,
    '业务暂不可采用（待账务对账）',
  );
});

test('内容员工原始待审或已完成但账务未结算或缺失时，业务流统一停在待账务对账', async () => {
  const token = await login('flow_boss');
  const runIds = [];
  for (const [status, billingState] of [
    ['待审阅', 'pending_reconciliation'],
    ['已完成', 'pending_reconciliation'],
    ['待审阅', null],
  ]) {
    const snapshot = {
      contractValid: true,
      ...(billingState ? { billing: { state: billingState, chargedCredits: null } } : {}),
      providerAttempt: {
        mode: 'api',
        model: 'deepseek-v4-flash',
        usage: { inputTokens: 61, outputTokens: 43 },
      },
      ...(status === '已完成' ? { review: { decision: 'adopt' } } : {}),
    };
    runIds.push(Number(db.prepare(`INSERT INTO content_employee_runs(
      tenant_id,employee_idx,employee_key,employee_name,employee_group,title,type,requirement,
      status,result_md,ai_mode,model,profile_version,prompt_hash,snapshot_json,created_by
    ) VALUES(801,3,'draft','撰稿人','文案创作部',?,'文案初稿','公开任务要求',
      ?,'真实 API 产出','api','deepseek-v4-flash','billing-flow-profile','billing-flow-hash',?,?)`).run(
      `账务${billingState ? '未结算' : '缺失'}-${status}`,
      status,
      JSON.stringify(snapshot),
      salesId,
    ).lastInsertRowid));
  }

  for (const runId of runIds) {
    const flow = await request(`/api/business-flow/content_run/${runId}`, { token });
    assert.equal(flow.status, 200, JSON.stringify(flow.payload));
    assert.equal(flow.payload.status.code, 'billing_pending');
    assert.equal(flow.payload.status.label, '业务暂不可采用（待账务对账）');
    assert.equal(flow.payload.status.terminal, false);
    assert.equal(flow.payload.nextAction.code, 'reconcile_billing');
    assert.equal(flow.payload.nodes.some(item => item.kind === 'review'), false);
    assert.equal(flow.payload.nodes.some(item => item.status === '已人工采纳（可用于业务）'), false);
    assert.equal(flow.payload.nodes[0].status, '业务暂不可采用（待账务对账）');
  }
});

test('餐饮员工待对账不进入人工审核，驳回不得释放预授权', async () => {
  const bossToken = await login('flow_boss');
  const outputId = Number(db.prepare(`INSERT INTO contents(
    tenant_id,type,title,body,status,ai_mode,risk_level,creator_id,marshal_id
  ) VALUES(801,'员工产出','待驳回退款产出','公开待驳回内容','待审核','api','none',?,?)`).run(
    salesId,
    marshalId,
  ).lastInsertRowid);
  const taskId = Number(db.prepare(`INSERT INTO agent_tasks(
    tenant_id,marshal_id,specialist_id,title,type,requirement,status,output_id,created_by,
    employee_profile_version,employee_config_snapshot,employee_web_snapshot
  ) VALUES(801,?,55,'待驳回退款任务','执行方案','公开要求','待审阅',?,?,?, ?,?)`).run(
    marshalId,
    outputId,
    salesId,
    'refund-flow-profile',
    JSON.stringify({ approvalMode: 'manager_review' }),
    JSON.stringify({
      kind: 'restaurant_employee_execution_evidence',
      outputContract: {
        valid: true,
        contractId: 'refund-flow-contract',
        schemaVersion: 'refund-flow.v1',
        primaryArtifact: 'report',
        artifacts: [{
          primary: true,
          kind: 'report',
          contractId: 'refund-flow-contract',
          schemaVersion: 'refund-flow.v1',
          contentSha256: 'c'.repeat(64),
        }],
      },
    }),
  ).lastInsertRowid);
  const approvalId = Number(db.prepare(`INSERT INTO approvals(
    tenant_id,target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,approval_level
  ) VALUES(801,'content',?,'待驳回退款审批','公开摘要','none',?,'待审核',?,'ops_director')`).run(
    outputId,
    JSON.stringify(['employee_output_review', 'employee_approval:manager_review']),
    salesId,
  ).lastInsertRowid);
  const balanceBefore = Number(db.prepare('SELECT credits FROM tenants WHERE id=801').get().credits);
  const hold = holdCredits({
    userId: salesId,
    feature: '业务流驳回退款验收',
    kind: 'text',
    model: 'test-model',
    credits: 19,
    refType: 'agent_task',
    refId: taskId,
  });

  const rejected = await request(`/api/sys/approvals/${approvalId}/decide`, {
    token: bossToken,
    method: 'POST',
    body: { pass: false, reason: '证据不足，退回重新派活' },
  });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.payload));
  assert.match(rejected.payload.error, /待账务对账.*不进入人工审阅/u);
  const holdRow = db.prepare(`SELECT status,settled_credits FROM credit_holds
    WHERE tenant_id=801 AND id=?`).get(hold.holdId);
  assert.equal(holdRow.status, 'held');
  assert.equal(holdRow.settled_credits, null);
  assert.equal(Number(db.prepare('SELECT credits FROM tenants WHERE id=801').get().credits), balanceBefore - 19);

  const flow = await request(`/api/business-flow/restaurant_task/${taskId}`, { token: bossToken });
  assert.equal(flow.status, 200, JSON.stringify(flow.payload));
  assert.equal(flow.payload.status.code, 'billing_pending');
  assert.equal(flow.payload.status.label, '业务暂不可采用（待账务对账）');
  assert.equal(flow.payload.status.terminal, false);
  assert.equal(
    flow.payload.nodes.find(item => item.kind === 'billing')?.status,
    '业务暂不可采用（待账务对账）',
  );
  assert.equal(flow.payload.nodes.some(item => item.kind === 'approval'), false);
  assert.equal(JSON.stringify(flow.payload).includes('积分预授权处理中'), false);
});

test('人员范围、租户范围、来源类型和空下游状态均 fail closed', async () => {
  const [bossToken, opsToken, salesToken] = await Promise.all([
    login('flow_boss'), login('flow_ops'), login('flow_sales'),
  ]);

  const peerDenied = await request(`/api/business-flow/manual_task/${peerTaskId}`, { token: salesToken });
  assert.equal(peerDenied.status, 404);

  const managerCanSeeReport = await request(`/api/business-flow/manual_task/${peerTaskId}`, { token: opsToken });
  assert.equal(managerCanSeeReport.status, 200);

  const advisorDenied = await request(`/api/business-flow/advisor_message/${advisorMessageId}`, { token: opsToken });
  assert.equal(advisorDenied.status, 404);

  const otherTenantDenied = await request(`/api/business-flow/manual_task/${otherTaskId}`, { token: bossToken });
  assert.equal(otherTenantDenied.status, 404);

  const missing = await request('/api/business-flow/manual_task/999999', { token: bossToken });
  assert.equal(missing.status, 404);

  const invalidType = await request('/api/business-flow/employee_prompt/1', { token: bossToken });
  assert.equal(invalidType.status, 400);
  assert.match(invalidType.payload.error, /来源类型/u);

  const emptyConversation = Number(db.prepare(`INSERT INTO ai_conversations(
    tenant_id,user_id,title,diag_type
  ) VALUES(801,?,'无行动项会诊','经营诊断')`).run(bossId).lastInsertRowid);
  const emptyMessage = Number(db.prepare(`INSERT INTO ai_messages(
    tenant_id,conversation_id,role,content
  ) VALUES(801,?,'assistant','尚未转成任务')`).run(emptyConversation).lastInsertRowid);
  const empty = await request(`/api/business-flow/advisor_message/${emptyMessage}`, { token: bossToken });
  assert.equal(empty.status, 200);
  assert.equal(empty.payload.hasDownstream, false);
  assert.equal(empty.payload.emptyState.code, 'no_downstream');
  assert.equal(empty.payload.nextAction.code, 'convert_to_tasks');
});

test('人工任务待审核动作严格跟随真实审核权限，员工只能等待且正式经理可审核团队任务', async () => {
  const [bossToken, opsToken, managerToken, salesToken] = await Promise.all([
    login('flow_boss'), login('flow_ops'), login('flow_manager'), login('flow_sales'),
  ]);

  const employeeFlow = await request(`/api/business-flow/manual_task/${manualReviewTaskId}`, {
    token: salesToken,
  });
  assert.equal(employeeFlow.status, 200, JSON.stringify(employeeFlow.payload));
  assert.equal(employeeFlow.payload.status.code, 'review_pending');
  assert.equal(employeeFlow.payload.status.label, '待人工验收');
  assert.equal(employeeFlow.payload.nextAction.code, 'wait_for_review');
  assert.equal(employeeFlow.payload.nextAction.label, '等待有权限的管理人员验收');
  assert.equal(employeeFlow.payload.nextAction.href, null);

  for (const token of [bossToken, opsToken, managerToken]) {
    const reviewerFlow = await request(`/api/business-flow/manual_task/${manualReviewTaskId}`, { token });
    assert.equal(reviewerFlow.status, 200, JSON.stringify(reviewerFlow.payload));
    assert.equal(reviewerFlow.payload.status.label, '待人工验收');
    assert.equal(reviewerFlow.payload.nextAction.code, 'review_task');
    assert.equal(reviewerFlow.payload.nextAction.label, '前往任务看板完成人工验收');
    assert.equal(reviewerFlow.payload.nextAction.href, `/execution?taskId=${manualReviewTaskId}`);
  }

  const reviewed = await request(`/api/execution/tasks/${manualReviewTaskId}/review`, {
    token: managerToken,
    method: 'POST',
    body: { pass: true, reason: '直属经理验收通过' },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.payload));
  assert.equal(
    db.prepare('SELECT status FROM tasks WHERE tenant_id=801 AND id=?').get(manualReviewTaskId).status,
    '已完成',
  );
});

test('三级人工任务根追踪包含全部可见后代与提交，员工侧父链保持匿名', async () => {
  const [bossToken, opsToken, salesToken] = await Promise.all([
    login('flow_boss'), login('flow_ops'), login('flow_sales'),
  ]);

  for (const token of [bossToken, opsToken]) {
    const rootFlow = await request(`/api/business-flow/manual_task/${deepRootTaskId}`, { token });
    assert.equal(rootFlow.status, 200, JSON.stringify(rootFlow.payload));
    assertPublicFlow(rootFlow.payload, 'manual_task', deepRootTaskId);

    const nodeIds = new Set(rootFlow.payload.nodes.map(item => item.id));
    for (const expected of [
      `manual-task:${deepRootTaskId}`,
      `manual-task:${deepMiddleTaskId}`,
      `manual-task:${deepLeafTaskId}`,
      `task-submission:${deepRootSubmissionId}`,
      `task-submission:${deepMiddleSubmissionId}`,
      `task-submission:${deepLeafSubmissionId}`,
    ]) assert.equal(nodeIds.has(expected), true, `missing ${expected}`);

    for (const expected of [
      [`manual-task:${deepRootTaskId}`, `manual-task:${deepMiddleTaskId}`, 'decomposed_to'],
      [`manual-task:${deepMiddleTaskId}`, `manual-task:${deepLeafTaskId}`, 'decomposed_to'],
      [`manual-task:${deepRootTaskId}`, `task-submission:${deepRootSubmissionId}`, 'submitted_as'],
      [`manual-task:${deepMiddleTaskId}`, `task-submission:${deepMiddleSubmissionId}`, 'submitted_as'],
      [`manual-task:${deepLeafTaskId}`, `task-submission:${deepLeafSubmissionId}`, 'submitted_as'],
    ]) assert.ok(rootFlow.payload.links.some(item => (
      item.from === expected[0] && item.to === expected[1] && item.relation === expected[2]
    )), `missing link ${expected.join(' -> ')}`);

    for (const item of rootFlow.payload.links) {
      assert.equal(nodeIds.has(item.from), true, `dangling link source ${item.from}`);
      assert.equal(nodeIds.has(item.to), true, `dangling link target ${item.to}`);
    }
  }

  const staffRootDenied = await request(`/api/business-flow/manual_task/${deepRootTaskId}`, {
    token: salesToken,
  });
  assert.equal(staffRootDenied.status, 404);

  const staffLeafFlow = await request(`/api/business-flow/manual_task/${deepLeafTaskId}`, {
    token: salesToken,
  });
  assert.equal(staffLeafFlow.status, 200, JSON.stringify(staffLeafFlow.payload));
  assertPublicFlow(staffLeafFlow.payload, 'manual_task', deepLeafTaskId);
  const staffSerialized = JSON.stringify(staffLeafFlow.payload);
  for (const forbidden of [
    '三级经营穿刺根任务', '三级经营穿刺中层任务',
    '根任务内部详情', '中层内部详情',
  ]) assert.equal(staffSerialized.includes(forbidden), false, `staff flow leaked ${forbidden}`);
  for (const hiddenId of [
    `manual-task:${deepRootTaskId}`,
    `manual-task:${deepMiddleTaskId}`,
    `task-submission:${deepRootSubmissionId}`,
    `task-submission:${deepMiddleSubmissionId}`,
  ]) assert.equal(
    staffLeafFlow.payload.nodes.some(item => item.id === hiddenId),
    false,
    `staff flow exposed ${hiddenId}`,
  );
  assert.ok(staffLeafFlow.payload.nodes.some(item => (
    item.id === `management-parent:${deepLeafTaskId}`
    && item.label === '管理层拆解任务'
    && item.status === '已拆解'
    && item.occurredAt === null
    && item.href === null
  )));
  assert.ok(staffLeafFlow.payload.nodes.some(item => item.id === `task-submission:${deepLeafSubmissionId}`));
});

test('进行中父任务只在存在未完成的可见后代时标记下级进行中', async () => {
  const [bossToken, salesToken] = await Promise.all([
    login('flow_boss'), login('flow_sales'),
  ]);
  const insertTask = db.prepare(`INSERT INTO tasks(
    tenant_id,title,detail,type,status,priority,assignee_id,assigned_by,parent_task_id,source
  ) VALUES(801,?,?,?,?, 'middle',?,?,?,'任务拆解')`);

  const completedParentId = Number(insertTask.run(
    '待汇总的父任务', '父任务详情', '数据', '进行中', opsId, bossId, null,
  ).lastInsertRowid);
  const completedChildId = Number(insertTask.run(
    '已完成的中层任务', '中层任务详情', '数据', '已完成', managerId, opsId, completedParentId,
  ).lastInsertRowid);
  const completedLeafId = Number(insertTask.run(
    '已完成的员工任务', '员工任务详情', '数据', '已完成', salesId, managerId, completedChildId,
  ).lastInsertRowid);

  const ready = await request(`/api/business-flow/manual_task/${completedParentId}`, { token: bossToken });
  assert.equal(ready.status, 200, JSON.stringify(ready.payload));
  assert.equal(ready.payload.status.code, 'children_ready_to_aggregate');
  assert.equal(ready.payload.status.terminal, false);
  assert.equal(ready.payload.nextAction.code, 'aggregate_children');
  assert.equal(ready.payload.nextAction.href, `/execution?taskId=${completedParentId}`);

  db.prepare("UPDATE tasks SET status='进行中', done_at=NULL WHERE tenant_id=801 AND id=?")
    .run(completedLeafId);
  const running = await request(`/api/business-flow/manual_task/${completedParentId}`, { token: bossToken });
  assert.equal(running.status, 200, JSON.stringify(running.payload));
  assert.equal(running.payload.status.code, 'children_running');
  assert.equal(running.payload.nextAction.code, 'follow_children');

  const standaloneId = Number(insertTask.run(
    '无下级的进行中任务', '单任务详情', '数据', '进行中', opsId, bossId, null,
  ).lastInsertRowid);
  const standalone = await request(`/api/business-flow/manual_task/${standaloneId}`, { token: bossToken });
  assert.equal(standalone.status, 200, JSON.stringify(standalone.payload));
  assert.equal(standalone.payload.status.code, 'running');
  assert.equal(standalone.payload.nextAction.code, 'continue_task');

  const limitedParentId = Number(insertTask.run(
    '员工可见的父任务', '员工可见详情', '数据', '进行中', salesId, managerId, null,
  ).lastInsertRowid);
  const hiddenChildId = Number(insertTask.run(
    'DO_NOT_LEAK_HIDDEN_CHILD', 'DO_NOT_LEAK_HIDDEN_DETAIL', '数据', '进行中', peerSalesId, opsId, limitedParentId,
  ).lastInsertRowid);
  const limited = await request(`/api/business-flow/manual_task/${limitedParentId}`, { token: salesToken });
  assert.equal(limited.status, 200, JSON.stringify(limited.payload));
  assert.equal(limited.payload.status.code, 'running');
  assert.equal(limited.payload.nextAction.code, 'continue_task');
  assert.equal(limited.payload.nodes.some(item => item.id === `manual-task:${hiddenChildId}`), false);
  assert.equal(JSON.stringify(limited.payload).includes('DO_NOT_LEAK_HIDDEN'), false);
});

test('真实 HTTP 三角色闭环：老板派发、管理层拆解、员工交付、驳回重提及业务流节点贯通', async () => {
  const [bossToken, opsToken, salesToken, peerToken] = await Promise.all([
    login('flow_boss'), login('flow_ops'), login('flow_sales'), login('flow_peer'),
  ]);
  const before = accountingSnapshot();

  const parentCreated = await request('/api/execution/tasks', {
    token: bossToken,
    method: 'POST',
    body: { title: '提升本周门店经营质量', detail: '管理层汇总经营动作与证据', assignee_id: opsId },
  });
  assert.equal(parentCreated.status, 200, JSON.stringify(parentCreated.payload));
  const parentId = Number(parentCreated.payload.id);

  const bossCannotStartForOps = await request(`/api/execution/tasks/${parentId}`, {
    token: bossToken, method: 'PUT', body: { status: '进行中' },
  });
  assert.equal(bossCannotStartForOps.status, 403);

  const beforeStart = await request('/api/execution/tasks', {
    token: opsToken,
    method: 'POST',
    body: { title: '提前拆解应失败', assignee_id: salesId, parent_task_id: parentId },
  });
  assert.equal(beforeStart.status, 409);

  const parentStarted = await request(`/api/execution/tasks/${parentId}`, {
    token: opsToken, method: 'PUT', body: { status: '进行中' },
  });
  assert.equal(parentStarted.status, 200, JSON.stringify(parentStarted.payload));

  const employeeDecomposeDenied = await request('/api/execution/tasks', {
    token: salesToken,
    method: 'POST',
    body: { title: '员工不可越权拆解', parent_task_id: parentId },
  });
  assert.equal(employeeDecomposeDenied.status, 403);

  const crossTenantParentDenied = await request('/api/execution/tasks', {
    token: opsToken,
    method: 'POST',
    body: { title: '跨租户父任务不可引用', assignee_id: salesId, parent_task_id: otherTaskId },
  });
  assert.equal(crossTenantParentDenied.status, 404);

  const childCreated = await request('/api/execution/tasks', {
    token: opsToken,
    method: 'POST',
    body: {
      title: '核验三家门店经营数据',
      detail: '逐店核验客流、成交与成本凭证',
      assignee_id: salesId,
      parent_task_id: parentId,
    },
  });
  assert.equal(childCreated.status, 200, JSON.stringify(childCreated.payload));
  assert.equal(childCreated.payload.parentTaskId, parentId);
  const childId = Number(childCreated.payload.id);

  const opsCannotStartForEmployee = await request(`/api/execution/tasks/${childId}`, {
    token: opsToken, method: 'PUT', body: { status: '进行中' },
  });
  assert.equal(opsCannotStartForEmployee.status, 403);

  const selfAssignedChildDenied = await request('/api/execution/tasks', {
    token: opsToken,
    method: 'POST',
    body: { title: '同一负责人无意义拆解', assignee_id: opsId, parent_task_id: parentId },
  });
  assert.equal(selfAssignedChildDenied.status, 409);
  assert.match(selfAssignedChildDenied.payload.error, /其他执行人/u);

  assert.deepEqual({ ...db.prepare(`SELECT parent_task_id,assigned_by,assignee_id,source,status
    FROM tasks WHERE tenant_id=801 AND id=?`).get(childId) }, {
    parent_task_id: parentId,
    assigned_by: opsId,
    assignee_id: salesId,
    source: '任务拆解',
    status: '待执行',
  });

  const parentSubmitDenied = await request(`/api/execution/tasks/${parentId}/submit`, {
    token: opsToken, method: 'POST', body: { content: '不能绕过员工任务直接汇总' },
  });
  assert.equal(parentSubmitDenied.status, 409);
  assert.match(parentSubmitDenied.payload.error, /下级任务未完成/u);

  const parentDeleteDenied = await request(`/api/execution/tasks/${parentId}`, {
    token: bossToken, method: 'DELETE',
  });
  assert.equal(parentDeleteDenied.status, 409);
  assert.ok(db.prepare('SELECT 1 FROM tasks WHERE tenant_id=801 AND id=?').get(parentId));

  const peerStartDenied = await request(`/api/execution/tasks/${childId}`, {
    token: peerToken, method: 'PUT', body: { status: '进行中' },
  });
  assert.equal(peerStartDenied.status, 403);

  assert.equal((await request(`/api/execution/tasks/${childId}`, {
    token: salesToken, method: 'PUT', body: { status: '进行中' },
  })).status, 200);
  const malformedAiRef = await request(`/api/execution/tasks/${childId}/submit`, {
    token: salesToken,
    method: 'POST',
    body: { content: '不应提交', ai_output_ref: { type: 'custom_agent_msg', id: '01' } },
  });
  assert.equal(malformedAiRef.status, 400);
  const userMessageRefDenied = await request(`/api/execution/tasks/${childId}/submit`, {
    token: salesToken,
    method: 'POST',
    body: { content: '不应提交', ai_output_ref: { type: 'custom_agent_msg', id: customAgentUserMessageId } },
  });
  assert.equal(userMessageRefDenied.status, 404);
  const peerAiRefDenied = await request(`/api/execution/tasks/${childId}/submit`, {
    token: salesToken,
    method: 'POST',
    body: { content: '不应提交', ai_output_ref: { type: 'custom_agent_msg', id: peerAgentAssistantMessageId } },
  });
  assert.equal(peerAiRefDenied.status, 404);
  const crossTenantAiRefDenied = await request(`/api/execution/tasks/${childId}/submit`, {
    token: salesToken,
    method: 'POST',
    body: { content: '不应提交', ai_output_ref: { type: 'custom_agent_msg', id: otherAgentAssistantMessageId } },
  });
  assert.equal(crossTenantAiRefDenied.status, 404);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM task_submissions
    WHERE tenant_id=801 AND task_id=?`).get(childId).n, 0);
  assert.equal((await request(`/api/execution/tasks/${parentId}/submit`, {
    token: opsToken, method: 'POST', body: { content: '下级进行中时不可汇总' },
  })).status, 409);
  const aiBackedSubmit = await request(`/api/execution/tasks/${childId}/submit`, {
    token: salesToken,
    method: 'POST',
    body: {
      content: '首轮：已完成数据核验',
      ai_output_ref: { type: 'custom_agent_msg', id: customAgentAssistantMessageId },
    },
  });
  assert.equal(aiBackedSubmit.status, 200, JSON.stringify(aiBackedSubmit.payload));
  assert.deepEqual(aiBackedSubmit.payload.aiOutputRef, {
    type: 'custom_agent_msg', id: customAgentAssistantMessageId,
  });
  const aiBackedSubmission = db.prepare(`SELECT id,source_ref_type,source_ref_id
    FROM task_submissions WHERE tenant_id=801 AND task_id=? ORDER BY id LIMIT 1`).get(childId);
  assert.deepEqual({ ...aiBackedSubmission }, {
    id: aiBackedSubmission.id,
    source_ref_type: 'custom_agent_msg',
    source_ref_id: customAgentAssistantMessageId,
  });
  assert.equal((await request(`/api/execution/tasks/${parentId}/submit`, {
    token: opsToken, method: 'POST', body: { content: '下级待审核时不可汇总' },
  })).status, 409);

  const employeeReviewDenied = await request(`/api/execution/tasks/${childId}/review`, {
    token: salesToken, method: 'POST', body: { pass: true },
  });
  assert.equal(employeeReviewDenied.status, 403);

  assert.equal((await request(`/api/execution/tasks/${childId}/review`, {
    token: opsToken, method: 'POST', body: { pass: false, reason: '缺少成本原始凭证' },
  })).status, 200);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(childId).status, '进行中');

  const returnedFlow = await request(`/api/business-flow/manual_task/${childId}`, { token: salesToken });
  assert.equal(returnedFlow.status, 200, JSON.stringify(returnedFlow.payload));
  assert.equal(returnedFlow.payload.status.code, 'rework');
  assert.equal(returnedFlow.payload.status.label, '返工中（人工验收退回）');
  assert.equal(returnedFlow.payload.nextAction.code, 'resubmit_task');
  assert.match(returnedFlow.payload.nextAction.label, /缺少成本原始凭证.*重新提交人工验收/u);
  assert.ok(returnedFlow.payload.nodes.some(node => (
    node.id === `manual-task:${childId}` && node.status === '返工中（人工验收退回）'
  )));
  assert.ok(returnedFlow.payload.nodes.some(node => (
    node.kind === 'submission' && /人工验收退回：缺少成本原始凭证/u.test(node.status)
  )));

  assert.equal((await request(`/api/execution/tasks/${childId}/submit`, {
    token: salesToken, method: 'POST', body: { content: '二轮：已补充成本原始凭证' },
  })).status, 200);
  const resubmittedFlow = await request(`/api/business-flow/manual_task/${childId}`, { token: salesToken });
  assert.equal(resubmittedFlow.payload.status.code, 'review_pending');
  assert.equal(resubmittedFlow.payload.status.label, '待人工验收');
  assert.equal(resubmittedFlow.payload.nextAction.code, 'wait_for_review');
  assert.equal((await request(`/api/execution/tasks/${childId}/review`, {
    token: opsToken, method: 'POST', body: { pass: true, reason: '凭证与结论一致' },
  })).status, 200);

  assert.equal((await request(`/api/execution/tasks/${parentId}/submit`, {
    token: opsToken, method: 'POST', body: { content: '已汇总三家门店经营核验结论' },
  })).status, 200);
  assert.equal((await request(`/api/execution/tasks/${parentId}/review`, {
    token: opsToken, method: 'POST', body: { pass: true, reason: '运营总监不可自审' },
  })).status, 403);
  assert.equal((await request(`/api/execution/tasks/${parentId}/review`, {
    token: salesToken, method: 'POST', body: { pass: true },
  })).status, 403);
  assert.equal((await request(`/api/execution/tasks/${childId}/reopen`, {
    token: opsToken, method: 'POST', body: { reason: '老板终审前补充签字凭证' },
  })).status, 200);
  const parentApprovalWhileChildOpen = await request(`/api/execution/tasks/${parentId}/review`, {
    token: bossToken, method: 'POST', body: { pass: true, reason: '不应越过重开子任务' },
  });
  assert.equal(parentApprovalWhileChildOpen.status, 409);
  assert.match(parentApprovalWhileChildOpen.payload.error, /不能验收通过/u);
  assert.equal((await request(`/api/execution/tasks/${childId}/submit`, {
    token: salesToken, method: 'POST', body: { content: '三轮：已补齐签字凭证' },
  })).status, 200);
  assert.equal((await request(`/api/execution/tasks/${childId}/review`, {
    token: opsToken, method: 'POST', body: { pass: true, reason: '补签核验通过' },
  })).status, 200);
  assert.equal((await request(`/api/execution/tasks/${parentId}/review`, {
    token: bossToken, method: 'POST', body: { pass: true, reason: '分层经营任务闭环完成' },
  })).status, 200);

  const childAudits = db.prepare(`SELECT result,reviewer_id,review_reason FROM task_submissions
    WHERE tenant_id=801 AND task_id=? ORDER BY id`).all(childId).map(row => ({ ...row }));
  assert.deepEqual(childAudits, [
    { result: '驳回', reviewer_id: opsId, review_reason: '缺少成本原始凭证' },
    { result: '通过', reviewer_id: opsId, review_reason: '凭证与结论一致' },
    { result: '通过', reviewer_id: opsId, review_reason: '补签核验通过' },
  ]);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(parentId).status, '已完成');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(childId).status, '已完成');
  const childReopenAfterParentDone = await request(`/api/execution/tasks/${childId}/reopen`, {
    token: opsToken, method: 'POST', body: { reason: '不应制造父完成子进行中' },
  });
  assert.equal(childReopenAfterParentDone.status, 409);
  assert.match(childReopenAfterParentDone.payload.error, /先重开上级任务/u);

  for (const token of [bossToken, opsToken]) {
    const parentFlow = await request(`/api/business-flow/manual_task/${parentId}`, { token });
    assert.equal(parentFlow.status, 200, JSON.stringify(parentFlow.payload));
    assertPublicFlow(parentFlow.payload, 'manual_task', parentId);
    assert.ok(parentFlow.payload.nodes.some(node => node.id === `manual-task:${childId}`));
    assert.ok(parentFlow.payload.links.some(link => (
      link.from === `manual-task:${parentId}`
      && link.to === `manual-task:${childId}`
      && link.relation === 'decomposed_to'
    )));
    assert.ok(parentFlow.payload.nodes.some(node => (
      node.id === `custom-agent-msg:${customAgentAssistantMessageId}`
      && node.kind === 'custom_agent_msg'
      && node.label === '智能体产出：门店数据核验助手'
    )));
    assert.ok(parentFlow.payload.links.some(link => (
      link.from === `custom-agent-msg:${customAgentAssistantMessageId}`
      && link.to === `task-submission:${aiBackedSubmission.id}`
      && link.relation === 'referenced_by'
    )));
  }

  const employeeChildFlow = await request(`/api/business-flow/manual_task/${childId}`, { token: salesToken });
  assert.equal(employeeChildFlow.status, 200, JSON.stringify(employeeChildFlow.payload));
  assertPublicFlow(employeeChildFlow.payload, 'manual_task', childId);
  assert.ok(employeeChildFlow.payload.nodes.some(node => node.id === `management-parent:${childId}`));
  assert.ok(employeeChildFlow.payload.links.some(link => (
    link.from === `management-parent:${childId}`
    && link.to === `manual-task:${childId}`
    && link.relation === 'decomposed_to'
  )));
  assert.ok(employeeChildFlow.payload.nodes.some(node => (
    node.id === `custom-agent-msg:${customAgentAssistantMessageId}`
  )));
  assert.ok(employeeChildFlow.payload.links.some(link => (
    link.from === `custom-agent-msg:${customAgentAssistantMessageId}`
    && link.to === `task-submission:${aiBackedSubmission.id}`
    && link.relation === 'referenced_by'
  )));
  assert.equal(JSON.stringify(employeeChildFlow.payload).includes('提升本周门店经营质量'), false);

  const peerFlowDenied = await request(`/api/business-flow/manual_task/${childId}`, { token: peerToken });
  assert.equal(peerFlowDenied.status, 404);

  const after = accountingSnapshot();
  assert.deepEqual(after, before);
  assert.deepEqual(externalNetworkAttempts, []);
});

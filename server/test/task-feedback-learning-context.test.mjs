import assert from 'node:assert/strict';
import { after, test } from 'node:test';

Object.assign(process.env, {
  NANOWORK_DB: ':memory:', NODE_ENV: 'test', NANOWORK_TEST_TEMPLATE_AI: '1',
  YUNWU_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',
  ENABLE_BACKGROUND_EMBEDDINGS: 'false', ENABLE_SCHEDULER: 'false',
});
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Feedback learning tests must not call external services'); };
const { db, q, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
initSchema(); migrateV2();
const { buildTaskFeedbackContext } = await import('../src/engines/task-feedback.js');
const { buildNativeContentSkillContext } = await import('../src/engines/native-content-skill-context.js');
const { compileContentEmployeeSoloPrompt } = await import('../src/engines/content-employee-workbench.js');
const { generateToolboxRun, TOOL_DEFINITIONS } = await import('../src/engines/toolbox.js');
const { marshalWork } = await import('../src/engines/ai.js');

let sourceId = 800;
function record({ tenantId = 1, owner = 41, idx = 11, domain = 'content', toolKey = null, specialistId = null, decision = 'adopt', note }) {
  const id = ++sourceId;
  return Number(q.run(`INSERT INTO task_feedback(tenant_id,source_kind,source_id,owner_id,reviewer_id,
    employee_domain,employee_idx,specialist_id,tool_key,employee_name,decision,note,input_hash,output_hash,task_title,request_key)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, tenantId, domain, id, owner, owner, domain, idx, specialistId, toolKey,
    '测试岗位', decision, note, 'input-hash', 'output-hash', '原任务', `test-${id}`).lastInsertRowid);
}
const xhsAdopt = record({ note: 'ADOPT_SHORT_PARAGRAPHS：保留短段落，标题直接写吃法。' });
const xhsReject = record({ decision: 'reject', note: 'REJECT_AD_SLOGANS：不要空泛广告套话。' });
const videoReject = record({ idx: 10, decision: 'reject', note: 'VIDEO_NATURAL_VOICE：声音自然，中间不要突然换声。' });
const writerAdopt = record({ idx: 3, note: 'WRITER_CLEAR_ACTIONS：保留短段与可执行步骤。' });
record({ owner: 42, note: 'OTHER_ACCOUNT_PRIVATE' });
record({ tenantId: 2, note: 'OTHER_TENANT_PRIVATE' });
record({ idx: 10, note: 'OTHER_POSITION_ONLY' });

test('原生视频和小红书后续上下文实际读取双方选择，隔离账号/企业/岗位', () => runWithTenant(1, () => {
  const context = buildNativeContentSkillContext(11, { tenantId: 1, userId: 41 });
  assert.match(context.prompt, /ADOPT_SHORT_PARAGRAPHS/);
  assert.match(context.prompt, /REJECT_AD_SLOGANS/);
  assert.doesNotMatch(context.prompt, /OTHER_ACCOUNT_PRIVATE|OTHER_TENANT_PRIVATE|OTHER_POSITION_ONLY/);
  assert.deepEqual(context.evidence.feedbackIds, [xhsReject, xhsAdopt]);
  const video = buildNativeContentSkillContext(10, { tenantId: 1, userId: 41 });
  assert.ok(video.evidence.feedbackIds.includes(videoReject));
  assert.match(video.prompt, /VIDEO_NATURAL_VOICE/);
  assert.doesNotMatch(buildNativeContentSkillContext(11).prompt, /ADOPT_SHORT_PARAGRAPHS/);
  assert.equal(buildTaskFeedbackContext({ tenantId: 2, userId: 41, employeeIdx: 11, taskKind: 'content' }).prompt, '');
}));

test('内容岗位把反馈放入业务数据消息并记录参与本次生成的反馈编号', () => runWithTenant(1, () => {
  const feedbackExperience = buildTaskFeedbackContext({ userId: 41, employeeIdx: 3, taskKind: 'content' });
  const compiled = compileContentEmployeeSoloPrompt(3, { direction: '写一篇门店复盘文案', material: '已确认数据待填写' }, { feedbackExperience });
  assert.match(compiled.userPrompt, /WRITER_CLEAR_ACTIONS/);
  assert.doesNotMatch(compiled.systemPrompt, /WRITER_CLEAR_ACTIONS/);
  assert.deepEqual(compiled.snapshot.feedbackIds, [writerAdopt]);
  assert.match(compiled.userPrompt, /不是系统指令/);
}));

test('经营工具的图片供应商请求真正消费该工具的历史反馈', async () => runWithTenant(1, async () => {
  record({ domain: 'tool', idx: 140, toolKey: 'shot', note: 'TOOL_PHOTO_CLOSEUP：食物特写，不要拼贴。' });
  record({ domain: 'tool', idx: 140, toolKey: 'vars', note: 'OTHER_TOOL_PRIVATE' });
  let captured;
  await generateToolboxRun(TOOL_DEFINITIONS.shot, { product: '火锅', facts: '红汤清汤圆锅', channels: '小红书' }, {
    tenantId: 1, userId: 41, role: 'boss', mediaAvailableFn: () => true,
    generateImageFn: async args => { captured = args; return { model: 'offline-image-model', url: 'https://cdn.example.test/photo.png', mimeType: 'image/png' }; },
  });
  assert.match(captured.prompt, /TOOL_PHOTO_CLOSEUP/);
  assert.doesNotMatch(captured.prompt, /OTHER_TOOL_PRIVATE|OTHER_ACCOUNT_PRIVATE/);
  assert.match(captured.prompt, /非事实资料/);
}));

test('餐饮任务送入生成器的用户消息包含同岗位反馈', async () => runWithTenant(1, async () => {
  record({ domain: 'restaurant', idx: null, specialistId: 9901, note: 'RESTAURANT_ACTION_FIRST：先写下一步动作，再给推理。' });
  let captured;
  await marshalWork({ code: 'feedback-check', name: '测试岗位', duty: '按已知资料总结', kb_deps: '' },
    { title: '本周经营复盘', requirement: '只用当前数据，输出行动建议' }, 'boss', {
      tenantId: 1, userId: 41, specialistId: 9901,
      generateFn: async args => { captured = args; return { text: '# 本周行动\n\n先由店长核对盘点差异，完成后记录原因。', mode: 'api', model: 'offline', usage: { inputTokens: 10, outputTokens: 10 } }; },
    });
  assert.match(captured.userMsg, /RESTAURANT_ACTION_FIRST/);
  assert.doesNotMatch(captured.system, /RESTAURANT_ACTION_FIRST/);
}));

after(() => { globalThis.fetch = originalFetch; db.close(); });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-iteration6-${process.pid}.db`);
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.YUNWU_BASE_URL = 'http://127.0.0.1:9';
process.env.OPENAI_API_KEY = '';
process.env.AI_INTERACTIVE_EMBED_TIMEOUT_MS = '250';
process.env.AI_INTERACTIVE_CHAT_TIMEOUT_MS = '500';

const { initSchema, migrateV2, q, runWithTenant, setConfig } = await import('../src/db.js');
const { seed } = await import('../src/seed.js');
const fileRoutes = (await import('../src/routes/files.js')).default;
const dataIntakeRoutes = (await import('../src/routes/dataintake.js')).default;
const advisorRoutes = (await import('../src/routes/advisor.js')).default;
const dashboardRoutes = (await import('../src/routes/dashboard.js')).default;
const analysisRoutes = (await import('../src/routes/analysis.js')).default;
const executionRoutes = (await import('../src/routes/execution.js')).default;
const assetRoutes = (await import('../src/routes/assets.js')).default;
const activityRoutes = (await import('../src/routes/activities.js')).default;
const systemRoutes = (await import('../src/routes/system.js')).default;
const marshalRoutes = (await import('../src/routes/marshals.js')).default;
const { resolvePdfFontPath } = await import('../src/engines/skillrun.js');
const { kbContext } = await import('../src/engines/ai.js');
const { rehydrateMessageHistory } = await import('../src/engines/filehub.js');

initSchema();
migrateV2();
seed();
migrateV2();
q.run(`UPDATE tenants SET credits=100000 WHERE id=1`);
const boss = q.get(`SELECT id,name,role,tenant_id FROM users WHERE tenant_id=1 AND role='boss' ORDER BY id LIMIT 1`);
const writtenFiles = [];

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use((req, _res, next) => runWithTenant(1, () => { req.user = boss; next(); }));
  app.use('/files', fileRoutes);
  app.use('/data-intake', dataIntakeRoutes);
  app.use('/advisor', advisorRoutes);
  app.use('/dashboard', dashboardRoutes);
  app.use('/analysis', analysisRoutes);
  app.use('/execution', executionRoutes);
  app.use('/assets', assetRoutes);
  app.use('/activities', activityRoutes);
  app.use('/marshals', marshalRoutes);
  app.use('/sys', systemRoutes);
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function call(base, url, method = 'GET', body) {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${method} ${url}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

test('6.0迭代：文件读取、产出入档、记忆、数据导入、驾驶舱与活动策划形成闭环', async () => {
  await withServer(async base => {
    const upload = await call(base, '/files/upload', 'POST', {
      name: '经营说明.txt', mime: 'text/plain', purpose: 'test', recognize: false,
      b64: Buffer.from('客户姓名：张三\n当前阶段：已邀约\n预算等级：高').toString('base64'),
    });
    assert.equal(upload.file.readable, true);
    assert.match(upload.file.preview, /张三/);
    const stored = q.get('SELECT file_path FROM uploaded_files WHERE id=?', upload.file.id);
    writtenFiles.push(stored.file_path);

    const detail = await call(base, `/files/${upload.file.id}`);
    assert.match(detail.content, /已邀约/);
    const hydrated = rehydrateMessageHistory([{
      role: 'user', content: '继续分析这份资料', attachments_json: JSON.stringify([{ id: upload.file.id, name: upload.file.name }]),
    }], boss);
    assert.match(hydrated[0].content, /历史附件·经营说明\.txt/);
    assert.match(hydrated[0].content, /当前阶段：已邀约/);
    const crowdedHistory = Array.from({ length: 5 }, (_, round) => ({
      role: 'user',
      content: `第${round + 1}轮`,
      attachments_json: JSON.stringify(Array.from({ length: 3 }, (_, fileIndex) => ({
        name: `r${round + 1}-${fileIndex + 1}.txt`,
        content: `正文-r${round + 1}-${fileIndex + 1}`,
      }))),
    }));
    const recentFirst = rehydrateMessageHistory(crowdedHistory, boss, { maxFiles: 4, maxChars: 1000 });
    assert.doesNotMatch(recentFirst[0].content, /历史附件/);
    assert.match(recentFirst.at(-1).content, /正文-r5-1/);
    assert.match(recentFirst.at(-1).content, /正文-r5-3/);
    const uploadedArchive = await call(base, `/files/${upload.file.id}/archive`, 'POST', { category: '品牌资料' });
    assert.ok(uploadedArchive.kbDocId);
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1 AND source_type='kb' AND source_id=?`, uploadedArchive.kbDocId).n, 1);
    assert.match(await kbContext(['品牌资料'], boss.role, '张三 当前阶段'), /当前阶段：已邀约/);
    const longDocId = q.run(`INSERT INTO kb_docs(category,title,body,enabled,ref_count) VALUES(?,?,?,?,?)`,
      '品牌资料', '超长品牌资料', `超长文档关键标识-${'长'.repeat(3600)}`, 1, 999).lastInsertRowid;
    const longContext = await kbContext(['品牌资料'], boss.role, null);
    assert.match(longContext, /超长文档关键标识/);
    assert.ok(longContext.length <= 3000);
    q.run(`DELETE FROM kb_docs WHERE tenant_id=1 AND id=?`, longDocId);
    const failedVision = await call(base, '/files/upload', 'POST', {
      name: '识图失败样本.png', mime: 'image/png', purpose: 'test', recognize: true,
      b64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
    });
    const failedVisionRow = q.get('SELECT file_path,extracted_text FROM uploaded_files WHERE id=?', failedVision.file.id);
    writtenFiles.push(failedVisionRow.file_path);
    assert.equal(failedVision.file.readable, false);
    assert.equal(failedVisionRow.extracted_text, '');
    assert.match(failedVision.file.extract_mode, /识图待重试/);
    const artifact = await call(base, '/files/artifacts/generate', 'POST', {
      title: '经营诊断报告', format: 'pdf', sourceType: 'test', content: '# 结论\n\n- 优先跟进张三\n- 负责人：销售部',
    });
    const artifactPath = path.join(process.cwd(), 'data', decodeURIComponent(artifact.fileUrl));
    writtenFiles.push(artifactPath);
    assert.equal(artifact.format, 'pdf');
    assert.ok(artifact.size > 500);
    assert.match(resolvePdfFontPath().path, /@fontsource[/\\]noto-sans-sc/);
    const archived = await call(base, `/files/artifacts/${artifact.id}/archive`, 'POST', { category: '员工产出' });
    assert.ok(archived.kbDocId);
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1 AND source_type='kb' AND source_id=?`, archived.kbDocId).n, 1);
    assert.match(await kbContext(['员工产出'], boss.role, '经营诊断报告'), /优先跟进张三/);
    await call(base, `/sys/kb/${archived.kbDocId}`, 'DELETE');
    assert.equal(q.get(`SELECT kb_doc_id FROM generated_artifacts WHERE tenant_id=1 AND id=?`, artifact.id).kb_doc_id, null);
    const rearchived = await call(base, `/files/artifacts/${artifact.id}/archive`, 'POST', { category: '员工产出' });
    assert.notEqual(rearchived.kbDocId, archived.kbDocId);

    const preview = await call(base, '/data-intake/preview', 'POST', { sheets: [{ name: '客户表', rows: [
      ['客户姓名', '手机号', '来源', '阶段'], ['集中导入客户', '13900000000', '转介绍', '意向客户'],
    ] }] });
    assert.equal(preview.batches[0].target, 'leads');
    assert.equal(preview.batches[0].validRows, 1);
    const committed = await call(base, '/data-intake/commit', 'POST', { batches: preview.batches });
    assert.equal(committed.imported, 1);
    assert.equal(committed.sync.status, 'completed');
    assert.ok(committed.sync.destinations.some(item => item.key === 'growth'));
    assert.ok(committed.sync.destinations.some(item => item.key === 'assets'));
    assert.equal(q.get(`SELECT source FROM leads WHERE tenant_id=1 AND name='集中导入客户'`).source, '转介绍');
    assert.equal(q.get(`SELECT stage FROM leads WHERE tenant_id=1 AND name='集中导入客户'`).stage, '已沟通');
    const importedLeadId = q.get(`SELECT id FROM leads WHERE tenant_id=1 AND name='集中导入客户'`).id;
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1 AND source_type='lead' AND source_id=?`, importedLeadId).n, 1);
    const partialLeadUpdate = await call(base, '/data-intake/commit', 'POST', { batches: [{
      sheet: '客户增量更新', target: 'leads', rows: [{ data: { name: '集中导入客户', phone: '13900000000', next_action: '电话复访' } }],
    }] });
    assert.equal(partialLeadUpdate.imported, 1);
    const preservedLead = q.get(`SELECT source,stage,budget_level,next_action FROM leads WHERE tenant_id=1 AND name='集中导入客户'`);
    assert.deepEqual({ ...preservedLead }, { source: '转介绍', stage: '已沟通', budget_level: '未知', next_action: '电话复访' });
    const conflictingLeadId = q.run(`INSERT INTO leads(name,phone,wechat,owner_id) VALUES(?,?,?,?)`,
      '身份冲突客户', '13900000001', 'wx_identity_conflict', boss.id).lastInsertRowid;
    const conflictingIdentity = await call(base, '/data-intake/commit', 'POST', { batches: [{
      sheet: '冲突身份', target: 'leads', rows: [{ data: {
        name: '不应串档', phone: '13900000000', wechat: 'wx_identity_conflict', next_action: '不应写入',
      } }],
    }] });
    assert.equal(conflictingIdentity.imported, 0);
    assert.match(JSON.stringify(conflictingIdentity.results), /分别匹配到不同客户/);
    assert.equal(q.get(`SELECT wechat FROM leads WHERE tenant_id=1 AND phone='13900000000'`).wechat, null);
    assert.equal(q.get(`SELECT phone FROM leads WHERE tenant_id=1 AND id=?`, conflictingLeadId).phone, '13900000001');
    const duplicateKnowledgeIds = [
      q.run(`INSERT INTO kb_docs(category,title,body,enabled) VALUES(?,?,?,1)`, '品牌资料', '同名导入知识', '原文甲').lastInsertRowid,
      q.run(`INSERT INTO kb_docs(category,title,body,enabled) VALUES(?,?,?,1)`, '品牌资料', '同名导入知识', '原文乙').lastInsertRowid,
    ];
    const ambiguousKnowledge = await call(base, '/data-intake/commit', 'POST', { batches: [{
      sheet: '同名知识', target: 'knowledge', rows: [{ data: { category: '品牌资料', title: '同名导入知识', body: '不应覆盖' } }],
    }] });
    assert.equal(ambiguousKnowledge.imported, 0);
    assert.match(JSON.stringify(ambiguousKnowledge.results), /存在重名/);
    assert.deepEqual(q.all(`SELECT body FROM kb_docs WHERE tenant_id=1 AND id IN (?,?) ORDER BY id`, ...duplicateKnowledgeIds).map(row => row.body), ['原文甲', '原文乙']);
    const normalizedDates = await call(base, '/data-intake/commit', 'POST', { batches: [
      { sheet: '日报日期', target: 'daily_ops', rows: [{ data: { date: '2026年7月1日', new_leads: 3 } }] },
      { sheet: '跟进日期', target: 'leads', rows: [{ data: { name: '日期测试客户', next_follow_at: '2026/7/2 09:30' } }] },
      { sheet: '任务日期', target: 'tasks', rows: [{ data: { title: '日期测试任务', due_at: '7/3/2026 18:00' } }] },
      { sheet: 'Excel日期序列', target: 'daily_ops', rows: [{ data: { date: 46215, new_leads: 4 } }] },
      { sheet: '两位年份', target: 'tasks', rows: [{ data: { title: '两位年份任务', due_at: '7/12/26 08:15' } }] },
    ] });
    assert.equal(normalizedDates.imported, 5);
    assert.equal(q.get(`SELECT date FROM daily_ops WHERE tenant_id=1 AND date='2026-07-01'`).date, '2026-07-01');
    assert.equal(q.get(`SELECT next_follow_at FROM leads WHERE tenant_id=1 AND name='日期测试客户'`).next_follow_at, '2026-07-02 09:30:00');
    assert.equal(q.get(`SELECT due_at FROM tasks WHERE tenant_id=1 AND title='日期测试任务'`).due_at, '2026-07-03 18:00:00');
    assert.equal(q.get(`SELECT new_leads FROM daily_ops WHERE tenant_id=1 AND date='2026-07-12'`).new_leads, 4);
    assert.equal(q.get(`SELECT due_at FROM tasks WHERE tenant_id=1 AND title='两位年份任务'`).due_at, '2026-07-12 08:15:00');

    const normalizedActivity = await call(base, '/data-intake/commit', 'POST', { batches: [{
      sheet: '活动百分比满意度', target: 'activities', rows: [{ data: {
        title: '满意度兼容活动', date: '2026-07-13', status: '已完成', satisfaction: 95,
      } }],
    }] });
    assert.equal(normalizedActivity.imported, 1);
    assert.equal(q.get(`SELECT status,satisfaction FROM activities WHERE tenant_id=1 AND title='满意度兼容活动'`).status, '已结束');
    assert.equal(q.get(`SELECT status,satisfaction FROM activities WHERE tenant_id=1 AND title='满意度兼容活动'`).satisfaction, 4.75);

    const partialDailyUpdate = await call(base, '/data-intake/commit', 'POST', { batches: [{
      sheet: '日报增量更新', target: 'daily_ops', rows: [{ data: { date: '2026-07-01', marketing_cost: 88 } }],
    }] });
    assert.equal(partialDailyUpdate.imported, 1);
    assert.deepEqual({ ...q.get(`SELECT new_leads,marketing_cost FROM daily_ops WHERE tenant_id=1 AND date='2026-07-01'`) }, { new_leads: 3, marketing_cost: 88 });

    const unknownAssignee = await call(base, '/data-intake/commit', 'POST', { batches: [{
      sheet: '陌生负责人', target: 'tasks', rows: [{ data: { title: '不能错误分配的任务', assignee: '不存在的员工' } }],
    }] });
    assert.equal(unknownAssignee.imported, 0);
    assert.match(JSON.stringify(unknownAssignee.results), /未找到负责人/);
    assert.equal(q.get(`SELECT COUNT(*) n FROM tasks WHERE tenant_id=1 AND title='不能错误分配的任务'`).n, 0);

    const invalidPreview = await call(base, '/data-intake/preview', 'POST', { sheets: [{ name: '非法预览', rows: [
      ['活动名称', '日期', '邀约人数'], ['错误活动', '2026-02-31', '十二人'],
    ] }] });
    assert.equal(invalidPreview.batches[0].validRows, 0);
    assert.match(invalidPreview.batches[0].rows[0].error, /不是有效数字|无效日期/);

    const importPayload = {
      idempotencyKey: 'iteration6-order-import-001',
      batches: [{ sheet: '订单幂等', target: 'orders', rows: [{ data: {
        customer: '集中导入客户', product: '青花清', amount: 1999, created_at: '2026-07-04 12:30',
      } }] }],
    };
    const firstImport = await call(base, '/data-intake/commit', 'POST', importPayload);
    const replayedImport = await call(base, '/data-intake/commit', 'POST', importPayload);
    assert.equal(firstImport.imported, 1);
    assert.equal(replayedImport.replayed, true);
    assert.equal(q.get(`SELECT COUNT(*) n FROM orders WHERE tenant_id=1 AND product='青花清' AND amount=1999`).n, 1);
    const importedOrderId = q.get(`SELECT id FROM orders WHERE tenant_id=1 AND product='青花清' AND amount=1999`).id;
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1 AND source_type='order' AND source_id=?`, importedOrderId).n, 1);
    const automaticLeadOrder = await call(base, '/data-intake/commit', 'POST', { batches: [{
      sheet: '订单自动建档', target: 'orders', rows: [{ data: {
        customer: '订单自动建档客户', phone: '13900000999', product: '企业团购酒', amount: 3600, created_at: '2026-06-18',
      } }],
    }] });
    assert.equal(automaticLeadOrder.imported, 1);
    const automaticLead = q.get(`SELECT id,stage,source,created_at FROM leads WHERE tenant_id=1 AND phone='13900000999'`);
    assert.equal(automaticLead.stage, '已成交');
    assert.equal(automaticLead.source, '订单导入自动建档');
    assert.match(automaticLead.created_at, /^2026-06-18/);
    assert.equal(q.get(`SELECT COUNT(*) n FROM orders WHERE tenant_id=1 AND lead_id=?`, automaticLead.id).n, 1);
    const importedProducts = await call(base, '/analysis/products?start=2026-07-04&end=2026-07-04');
    assert.ok(importedProducts.some(row => row.product === '青花清' && row.amount >= 1999));
    const sourceMap = await call(base, '/assets/source-map');
    assert.ok(sourceMap.cards.find(card => card.key === 'operations').count >= 1);
    const executionSummary = await call(base, '/execution/summary');
    assert.equal(executionSummary.goalRate, null);
    assert.equal(executionSummary.goalStatus, 'missing');
    assert.match(executionSummary.goalStatusText, /尚未设置月度经营目标/);

    const invalidDates = await call(base, '/data-intake/commit', 'POST', { batches: [
      { sheet: '非法日期', target: 'daily_ops', rows: [{ data: { date: '2026-07-01garbage', new_leads: 9 } }] },
      { sheet: '超限序列', target: 'tasks', rows: [{ data: { title: '不应导入', due_at: 999999999 } }] },
    ] });
    assert.equal(invalidDates.imported, 0);
    assert.match(JSON.stringify(invalidDates.results), /无法识别日期|无效 Excel 日期序列值/);
    assert.equal(q.get(`SELECT COUNT(*) n FROM tasks WHERE tenant_id=1 AND title='不应导入'`).n, 0);

    const invalidNumbers = await call(base, '/data-intake/commit', 'POST', { batches: [{
      sheet: '数值校验', target: 'activities', rows: [
        { data: { title: '不应导入的活动', date: '2026-07-05', invited: '十二人' } },
        { data: { title: '满意度越界活动', date: '2026-07-06', satisfaction: 120 } },
      ],
    }] });
    assert.equal(invalidNumbers.imported, 0);
    assert.match(JSON.stringify(invalidNumbers.results), /不是有效数字|满意度支持/);
    assert.equal(q.get(`SELECT COUNT(*) n FROM activities WHERE tenant_id=1 AND title IN ('不应导入的活动','满意度越界活动')`).n, 0);
    const importJobs = await call(base, '/data-intake/jobs');
    const failedNumberJob = importJobs.find(job => job.id === invalidNumbers.results[0].jobId);
    assert.equal(failedNumberJob.sheet, '数值校验');
    assert.equal(failedNumberJob.status, 'failed');
    assert.equal(failedNumberJob.skipped, 2);

    q.run(`INSERT INTO kb_docs(category,title,body,enabled,embedding) VALUES('品牌资料','待刷新知识','旧内容',1,'[0.5]')`);
    const refreshedKnowledge = await call(base, '/data-intake/commit', 'POST', { batches: [{
      sheet: '知识更新', target: 'knowledge', rows: [{ data: { category: '品牌资料', title: '待刷新知识', body: '新内容需要重新生成向量' } }],
    }] });
    assert.equal(refreshedKnowledge.imported, 1);
    const refreshedRow = q.get(`SELECT body,embedding FROM kb_docs WHERE tenant_id=1 AND title='待刷新知识'`);
    assert.equal(refreshedRow.body, '新内容需要重新生成向量');
    assert.equal(refreshedRow.embedding, null);
    const excessiveSheets = await fetch(base + '/data-intake/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheets: Array.from({ length: 11 }, (_, i) => ({ name: `表${i + 1}`, rows: [['客户姓名'], [`客户${i + 1}`]] })) }),
    });
    assert.equal(excessiveSheets.status, 400);

    const first = await call(base, '/advisor/chat', 'POST', { question: '分析本月客户问题', fileIds: [upload.file.id] });
    await call(base, `/advisor/conversations/${first.conversationId}/memory`, 'POST', { content: '重点客户张三处于已邀约阶段' });
    await call(base, '/advisor/chat', 'POST', { conversationId: first.conversationId, question: '下一步怎么做' });
    const convo = q.get('SELECT summary,memory,updated_at FROM ai_conversations WHERE id=?', first.conversationId);
    assert.match(convo.memory, /张三/);
    assert.match(convo.summary, /下一步怎么做/);
    assert.ok(convo.updated_at);

    const prefs = await call(base, '/dashboard/widgets/preferences');
    assert.ok(prefs.selected.includes('follow'));
    const savedPrefs = await call(base, '/dashboard/widgets/preferences', 'PUT', { widgets: ['kpi', 'follow', 'activities'] });
    assert.deepEqual(savedPrefs.selected, ['kpi', 'follow', 'activities']);

    const draft = await call(base, '/activities/plan-drafts/generate', 'POST', {
      title: '中秋企业主品鉴会', type: '品鉴会', date: '2026-09-01', targetJoin: 37, goal: '现场成交', audience: '本地企业主', budget: '1-3万',
    });
    assert.ok(draft.draftId);
    assert.ok(Array.isArray(draft.plan.flow));
    const created = await call(base, `/activities/plan-drafts/${draft.draftId}/create-activity`, 'POST', { date: '2026-09-01' });
    const createdActivity = q.get(`SELECT id,target_join FROM activities WHERE tenant_id=1 AND id=? AND plan_status='草稿'`, created.activityId);
    assert.equal(createdActivity.target_join, 37);
    q.run(`UPDATE activities SET plan=? WHERE id=?`, JSON.stringify({
      theme: '复杂结构活动',
      flow: [{ time: '14:00', item: '签到' }],
      materials: [{ name: '签到表', quantity: 20 }],
      invites: { targetCount: 30, channels: ['老客转介绍', '商协会'] },
      sop: [{ step: 1, name: '定目标', action: '确认成交目标', owner: '活动负责人', output: '目标表' }],
      kpi: { roi: { target: '≥2.0', owner: '财务' } },
      budgetNote: { totalBudget: '1-3万元', allocation: [{ item: '场地', amount: '3000元' }], approvalNote: '采购前审批' },
    }), created.activityId);
    const activityRows = await call(base, '/activities');
    const normalizedPlan = activityRows.find(x => x.id === created.activityId).plan;
    assert.equal(typeof normalizedPlan.budgetNote, 'string');
    assert.match(normalizedPlan.budgetNote, /总预算：1-3万元/);
    assert.equal(normalizedPlan.materials[0], '签到表｜数量：20');
    assert.equal(typeof normalizedPlan.invites, 'string');
    assert.match(normalizedPlan.invites, /目标到场：30/);
    assert.equal(typeof normalizedPlan.sop[0], 'string');
    assert.match(normalizedPlan.sop[0], /定目标/);
    const updatedActivity = await call(base, `/activities/${created.activityId}`, 'PUT', { revenue: 1000 });
    assert.ok(Array.isArray(updatedActivity.checklist));
    assert.equal(typeof updatedActivity.plan.budgetNote, 'string');
    const invalidAssignmentDate = await fetch(`${base}/activities/${created.activityId}/assignments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignments: [{
        key: 'invalid-date', title: '无效日期任务', assigneeId: boss.id, dueAt: '2026-02-31 18:00', priority: '中',
      }] }),
    });
    assert.equal(invalidAssignmentDate.status, 400);
    assert.match((await invalidAssignmentDate.json()).error, /截止时间格式不正确/);

    const invalidBatch = await call(base, '/activities/batch-results', 'POST', { rows: [{
      id: created.activityId, title: '中秋企业主品鉴会', revenue: '不是数字', satisfaction: 8,
    }] });
    assert.equal(invalidBatch.updated.length, 0);
    assert.equal(invalidBatch.invalid.length, 1);
    assert.equal(q.get('SELECT revenue FROM activities WHERE tenant_id=1 AND id=?', created.activityId).revenue, 1000);

    q.run(`INSERT INTO activities(title,type,status,date,owner_id) VALUES(?,?,?,?,?)`, '中秋企业主品鉴会·第二场', '品鉴会', '策划中', '2026-09-02', boss.id);
    const ambiguousBatch = await call(base, '/activities/batch-results', 'POST', { rows: [{ title: '中秋企业主', revenue: 2000 }] });
    assert.equal(ambiguousBatch.updated.length, 0);
    assert.match(ambiguousBatch.unmatched[0], /匹配到多场/);

    const duplicateTitleId = q.run(`INSERT INTO activities(title,type,status,date,owner_id,revenue) VALUES(?,?,?,?,?,?)`,
      '中秋企业主品鉴会', '品鉴会', '策划中', '2026-09-03', boss.id, 500).lastInsertRowid;
    const duplicateTitleBatch = await call(base, '/activities/batch-results', 'POST', {
      rows: [{ title: '中秋企业主品鉴会', revenue: 3000 }],
    });
    assert.equal(duplicateTitleBatch.updated.length, 0);
    assert.match(duplicateTitleBatch.unmatched[0], /存在同名活动/);
    assert.equal(q.get('SELECT revenue FROM activities WHERE tenant_id=1 AND id=?', created.activityId).revenue, 1000);
    assert.equal(q.get('SELECT revenue FROM activities WHERE tenant_id=1 AND id=?', duplicateTitleId).revenue, 500);

    const subordinate = q.get(`SELECT id FROM users WHERE tenant_id=1 AND role='sales' ORDER BY id LIMIT 1`);
    const subordinateDraftId = q.run(`INSERT INTO activity_plan_drafts(user_id,title,type,date,goal,audience,budget,target_join,plan,status)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, subordinate.id, '员工提交的品鉴会', '品鉴会', '2026-10-01', '成交', '企业主', '1万以内', 22,
    JSON.stringify({ theme: '员工草稿', flow: [{ time: '14:00', item: '签到' }], materials: [], sop: [] }), '草稿').lastInsertRowid;
    await call(base, `/activities/plan-drafts/${subordinateDraftId}`, 'PUT', { plan: { theme: '管理层完善后的草稿', flow: [], materials: [], sop: [] }, targetJoin: 22 });
    const subordinateCreated = await call(base, `/activities/plan-drafts/${subordinateDraftId}/create-activity`, 'POST', { date: '2026-10-01' });
    const subordinateActivity = q.get(`SELECT owner_id,target_join FROM activities WHERE tenant_id=1 AND id=?`, subordinateCreated.activityId);
    assert.equal(subordinateActivity.owner_id, subordinate.id);
    assert.equal(subordinateActivity.target_join, 22);
    await call(base, `/activities/${subordinateCreated.activityId}`, 'DELETE');
    assert.equal(q.get(`SELECT activity_id,status FROM activity_plan_drafts WHERE tenant_id=1 AND id=?`, subordinateDraftId).activity_id, null);
    const recreatedFromDraft = await call(base, `/activities/plan-drafts/${subordinateDraftId}/create-activity`, 'POST', { date: '2026-10-02' });
    assert.notEqual(recreatedFromDraft.activityId, subordinateCreated.activityId);
    assert.equal(q.get(`SELECT COUNT(*) n FROM activities WHERE tenant_id=1 AND id=?`, recreatedFromDraft.activityId).n, 1);

    const stalledUpstream = http.createServer((_req, _res) => {});
    await new Promise(resolve => stalledUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = stalledUpstream.address().port;
    setConfig('yunwu_api_key', 'timeout-test-key');
    setConfig('yunwu_base_url', `http://127.0.0.1:${upstreamPort}/v1`);
    const timeoutStartedAt = Date.now();
    try {
      const degradedPlan = await call(base, `/activities/${created.activityId}/plan`, 'POST', {
        goal: '招商', audience: '本地企业主', budget: '1-3万',
      });
      assert.equal(degradedPlan.mode, 'template');
      assert.ok(degradedPlan.plan.flow.length > 0);
      assert.ok(Date.now() - timeoutStartedAt < 2500, '交互式AI超时后应快速降级，不能让页面长期卡住');
    } finally {
      setConfig('yunwu_api_key', '');
      setConfig('yunwu_base_url', 'http://127.0.0.1:9');
      stalledUpstream.closeAllConnections();
      await new Promise(resolve => stalledUpstream.close(resolve));
    }

    const skillFile = await call(base, '/marshals/4/skill-file', 'POST', { message: '生成一页经营摘要', format: 'pdf' });
    assert.match(skillFile.fileUrl, /^\/uploads\/skills\/1\/[^/]+_[0-9a-f]{10}\.pdf$/);
    const skillPath = path.join(process.cwd(), 'data', decodeURIComponent(skillFile.fileUrl));
    writtenFiles.push(skillPath);
    assert.ok(fs.existsSync(skillPath));

    const kbUpload = await call(base, '/sys/kb/upload', 'POST', {
      name: '企业制度.txt', category: '品牌资料', b64: Buffer.from('企业制度：重要客户方案必须由负责人复核。').toString('base64'),
    });
    assert.match(kbUpload.fileUrl, /^\/uploads\/kb\/1\/\d+-[0-9a-f]{10}-/);
    const kbUploadPath = path.join(process.cwd(), 'data', decodeURIComponent(kbUpload.fileUrl));
    writtenFiles.push(kbUploadPath);
    assert.ok(fs.existsSync(kbUploadPath));

    const kbDir = path.dirname(kbUploadPath);
    const filesBeforeRejectedUpload = new Set(fs.readdirSync(kbDir));
    const rejectedKbUpload = await fetch(base + '/sys/kb/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: '无效权限资料.txt', category: '品牌资料', visibleRoles: ['platform_super'],
        b64: Buffer.from('该文件不应留在磁盘。').toString('base64'),
      }),
    });
    assert.equal(rejectedKbUpload.status, 400);
    assert.deepEqual(new Set(fs.readdirSync(kbDir)), filesBeforeRejectedUpload);

    const manualKb = await call(base, '/sys/kb', 'POST', {
      category: '品牌资料', title: '手工录入交易测试', body: '知识文档和知识资产必须同时入库。',
    });
    assert.equal(q.get(`SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=1 AND id=?`, manualKb.id).n, 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1 AND source_type='kb' AND source_id=?`, manualKb.id).n, 1);
    const invalidKbCategory = await fetch(base + '/sys/kb', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        category: '越权分类', title: '不应入库', body: '不应入库',
      }),
    });
    assert.equal(invalidKbCategory.status, 400);
    const invalidKbRoles = await fetch(base + `/sys/kb/${manualKb.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visible_roles: ['platform_super'] }),
    });
    assert.equal(invalidKbRoles.status, 400);
    assert.equal(q.get(`SELECT visible_roles FROM kb_docs WHERE tenant_id=1 AND id=?`, manualKb.id).visible_roles, null);

    const init = await call(base, '/sys/kb/initialize', 'POST', {});
    assert.ok(init.created.length > 0);
    const readiness = await call(base, '/sys/kb/readiness');
    assert.equal(readiness.percent, 100);
    const promptStatus = await call(base, '/sys/marshal-prompts/status');
    assert.equal(promptStatus.length, 8);
    assert.deepEqual(promptStatus.map(item => item.code), ['M-01', 'M-02', 'M-03', 'M-04', 'M-05', 'M-06', 'M-07', 'M-08']);
    assert.ok(promptStatus.every(x => x.length >= 200), JSON.stringify(promptStatus));
  });
});

test('cleanup', () => {
  for (const file of writtenFiles) { try { fs.rmSync(file, { force: true }); } catch {} }
  for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
});

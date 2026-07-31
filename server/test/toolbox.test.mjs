import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-toolbox-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = 'test';
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const { hashPassword } = await import('../src/util.js');
const toolboxRoutes = (await import('../src/routes/toolbox.js')).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();

q.run(`INSERT INTO tenants(id,name,status) VALUES(2,'工具箱租户二','已开通')
  ON CONFLICT(id) DO UPDATE SET status=excluded.status`);
const userOneId = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'toolbox-one', hashPassword('Secret123!'), '租户一老板', 'boss', '启用', 1).lastInsertRowid;
const userTwoId = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'toolbox-two', hashPassword('Secret123!'), '租户二老板', 'boss', '启用', 2).lastInsertRowid;
const userPeerId = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'toolbox-peer', hashPassword('Secret123!'), '租户一销售', 'sales', '启用', 1).lastInsertRowid;
const userOne = { id: Number(userOneId), name: '租户一老板', role: 'boss', tenant_id: 1 };
const userTwo = { id: Number(userTwoId), name: '租户二老板', role: 'boss', tenant_id: 2 };
const userPeer = { id: Number(userPeerId), name: '租户一销售', role: 'sales', tenant_id: 1 };

function appFor(user) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => {
    req.user = user;
    next();
  }));
  app.use('/toolbox', toolboxRoutes);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function request(base, url, method = 'GET', body) {
  const response = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json().catch(() => ({})) };
}

const VALID_PAYLOADS = {
  hot: { employeeIdx: 141, inputs: { store: '太原万象城川味小馆', channels: ['朋友圈', '视频号'], focus: '提升工作日晚市到店，不做虚假限量' } },
  remix: { employeeIdx: 140, inputs: { materials: '后厨出锅3段、门头夜景1段，每段约5秒', platform: '视频号', goal: '让附近顾客了解招牌菜' } },
  pcal: { employeeIdx: 141, inputs: { month: '2026-08', channels: ['朋友圈', '社群'], focus: '新菜单上线与老会员回店' } },
  bench: { employeeIdx: 102, inputs: { targets: '对标门店A / 公开页面\n对标门店B / 地址', period: '近7天', focus: '套餐与晚市活动' } },
  warm: { employeeIdx: 142, inputs: { platform: '视频号', positioning: '社区型云南米线，午餐为主', persona: '认真研究汤底的店主', goal: '验证3个稳定选题方向' } },
  leads: { employeeIdx: 143, inputs: { city: '太原长风街3公里', product: '粤菜家庭聚餐', audience: '周末家庭聚餐', constraints: '只使用公开信号并由人工核验' } },
  shot: { employeeIdx: 140, inputs: { product: '双人酸汤鱼套餐', facts: '门店称重记录与当天食材可供负责人核验', channels: ['朋友圈', '门店桌卡'] } },
  vars: { employeeIdx: 140, inputs: { script: '我们每天先核对当天食材和可售数量，再向顾客说明真实情况，具体价格请到店确认。', variants: 4, platform: '视频号' } },
};

let tenantOneRunId;

test('8个工具键均可持久化，并保存安全模板、来源和一对一分析回流事件', async () => {
  await withServer(userOne, async base => {
    for (const [toolKey, payload] of Object.entries(VALID_PAYLOADS)) {
      const result = await request(base, '/toolbox/runs', 'POST', {
        toolKey,
        employeeIdx: payload.employeeIdx,
        title: `${toolKey}验收运行`,
        inputs: payload.inputs,
      });
      assert.equal(result.response.status, 201, `${toolKey}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.run.toolKey, toolKey);
      assert.equal(result.body.run.employeeIdx, payload.employeeIdx);
      assert.equal(result.body.run.status, 'done');
      assert.match(result.body.run.resultMd, /不会自动发布内容、下单采购、修改价格、安排排班或处罚员工/);
      assert.equal(result.body.run.provenance.mode, 'template');
      assert.equal(result.body.run.provenance.sourceSystem, 'nanowork');
      assert.equal(result.body.run.provenance.promptVersion, 'toolbox-template-v1');
      assert.equal(result.body.run.provenance.confidence, '待人工核验');
      assert.ok(result.body.run.provenance.employeeSnapshot, '每次工具运行必须锁定完整员工执行快照');
      assert.equal(result.body.run.provenance.employeeSnapshot.identity.idx, payload.employeeIdx);
      assert.ok(result.body.run.provenance.employeeSnapshot.capabilities.length > 0);
      assert.ok(result.body.run.provenance.employeeSnapshot.skills.length > 0);
      assert.ok(result.body.run.provenance.employeeSnapshot.workMethod.qualityGates.length > 0);
      assert.ok(result.body.run.provenance.employeeSnapshot.jobProfile.expectedDeliverables.length > 0);
      assert.match(result.body.run.provenance.employeeSnapshot.systemContext, /完整岗位手册/);
      assert.ok(result.body.run.assumptions.some(item => item.includes('未联网检索')));
      if (toolKey === 'bench' || toolKey === 'leads') {
        assert.match(result.body.run.resultMd, /未联网/);
      }
      tenantOneRunId ||= result.body.run.id;
    }

    const list = await request(base, '/toolbox/runs?limit=20');
    assert.equal(list.response.status, 200);
    assert.equal(list.body.runs.length, 8);
    assert.deepEqual(new Set(list.body.runs.map(item => item.toolKey)), new Set(Object.keys(VALID_PAYLOADS)));
  });

  const persisted = db.prepare(`SELECT * FROM tool_runs WHERE tenant_id=1 AND id=?`).get(tenantOneRunId);
  assert.equal(JSON.parse(persisted.input_json).store, '太原万象城川味小馆');
  assert.match(persisted.result_md, /^# 今日必发/);
  assert.equal(JSON.parse(persisted.provenance_json).sourceSystem, 'nanowork');
  assert.ok(persisted.specialist_id, '运行记录应关联餐饮数字员工目录');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM tool_run_events WHERE tenant_id=1`).get().n, 8);
  assert.equal(db.prepare(`SELECT COUNT(DISTINCT run_id) n FROM tool_run_events WHERE tenant_id=1`).get().n, 8);
});

test('工具键、员工绑定、标题、字段长度和数组数量均由服务端严格校验', async () => {
  await withServer(userOne, async base => {
    const cases = [
      { body: { toolKey: 'unknown', employeeIdx: 141, title: '未知工具', inputs: {} }, error: /toolKey仅支持/ },
      { body: { toolKey: 'hot', employeeIdx: 140, title: '冒用员工', inputs: VALID_PAYLOADS.hot.inputs }, error: /#141/ },
      { body: { toolKey: 'hot', employeeIdx: 141, title: '超长'.repeat(61), inputs: VALID_PAYLOADS.hot.inputs }, error: /title长度/ },
      { body: { toolKey: 'hot', employeeIdx: 141, title: '数组过多', inputs: { ...VALID_PAYLOADS.hot.inputs, channels: ['1', '2', '3', '4', '5', '6'] } }, error: /1-5项/ },
      { body: { toolKey: 'hot', employeeIdx: 141, title: '文本过长', inputs: { ...VALID_PAYLOADS.hot.inputs, focus: '长'.repeat(2_001) } }, error: /1-2000字/ },
      { body: { toolKey: 'bench', employeeIdx: 102, title: '对标过多', inputs: { targets: Array.from({ length: 9 }, (_, i) => `门店${i}`).join('\n') } }, error: /最多填写8个/ },
      { body: { toolKey: 'vars', employeeIdx: 140, title: '嵌套对象', inputs: { script: VALID_PAYLOADS.vars.inputs.script, variants: { value: 3 } } }, error: /必须是整数/ },
    ];
    for (const item of cases) {
      const result = await request(base, '/toolbox/runs', 'POST', item.body);
      assert.equal(result.response.status, 400, JSON.stringify(result.body));
      assert.match(result.body.error, item.error);
    }
    const badLimit = await request(base, '/toolbox/runs?limit=500');
    assert.equal(badLimit.response.status, 400);
  });
});

test('列表与详情均按当前租户隔离，跨租户ID直查返回404', async () => {
  let tenantTwoRunId;
  await withServer(userTwo, async base => {
    const created = await request(base, '/toolbox/runs', 'POST', {
      toolKey: 'hot', employeeIdx: 141, title: '租户二专属运行', inputs: VALID_PAYLOADS.hot.inputs,
    });
    assert.equal(created.response.status, 201);
    tenantTwoRunId = created.body.run.id;

    const ownList = await request(base, '/toolbox/runs?limit=20');
    assert.deepEqual(ownList.body.runs.map(item => item.title), ['租户二专属运行']);
    const crossDetail = await request(base, `/toolbox/runs/${tenantOneRunId}`);
    assert.equal(crossDetail.response.status, 404);
  });

  await withServer(userOne, async base => {
    const ownList = await request(base, '/toolbox/runs?limit=20');
    assert.equal(ownList.body.runs.length, 8);
    assert.ok(ownList.body.runs.every(item => item.title !== '租户二专属运行'));
    const crossDetail = await request(base, `/toolbox/runs/${tenantTwoRunId}`);
    assert.equal(crossDetail.response.status, 404);
    const ownDetail = await request(base, `/toolbox/runs/${tenantOneRunId}`);
    assert.equal(ownDetail.response.status, 200);
    assert.equal(ownDetail.body.run.id, tenantOneRunId);
  });

  assert.equal(db.prepare(`SELECT tenant_id FROM tool_runs WHERE id=?`).get(tenantTwoRunId).tenant_id, 2);
  assert.equal(db.prepare(`SELECT tenant_id FROM tool_run_events WHERE run_id=?`).get(tenantTwoRunId).tenant_id, 2);
});

test('同租户普通员工只能查看自己的工具运行，老板可审计全租户且普通员工看不到完整系统提示词', async () => {
  await withServer(userPeer, async base => {
    const before = await request(base, '/toolbox/runs?limit=20');
    assert.equal(before.response.status, 200);
    assert.equal(before.body.runs.length, 0, '同租户其他员工创建的运行不得暴露给普通员工');

    const cross = await request(base, `/toolbox/runs/${tenantOneRunId}`);
    assert.equal(cross.response.status, 404);

    const created = await request(base, '/toolbox/runs', 'POST', {
      toolKey: 'hot', employeeIdx: 141, title: '销售自己的运行', inputs: VALID_PAYLOADS.hot.inputs,
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.run.provenance.employeeSnapshot.identity.idx, 141);
    assert.equal(created.body.run.provenance.employeeSnapshot.systemContext, undefined,
      '普通员工响应不得回显完整系统提示词');

    const own = await request(base, '/toolbox/runs?limit=20');
    assert.deepEqual(own.body.runs.map(item => item.title), ['销售自己的运行']);
  });

  await withServer(userOne, async base => {
    const audited = await request(base, '/toolbox/runs?limit=20');
    assert.ok(audited.body.runs.some(item => item.title === '销售自己的运行'));
  });
});

test('工具箱真实AI调用必须先占扣，余额不足不触发上游，成功后按用量结算且不留悬挂占扣', async () => {
  let upstreamCalls = 0;
  let capturedBody = null;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    upstreamCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: '# 真实工具交付\\n已按完整岗位上下文生成。' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  process.env.YUNWU_API_KEY = 'test-toolbox-key';
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstreamPort}`;

  try {
    q.run('UPDATE tenants SET credits=0 WHERE id=?', 1);
    await withServer(userOne, async base => {
      const denied = await request(base, '/toolbox/runs', 'POST', {
        toolKey: 'hot', employeeIdx: 141, title: '余额不足不得调用', inputs: VALID_PAYLOADS.hot.inputs,
      });
      assert.equal(denied.response.status, 402);
    });
    assert.equal(upstreamCalls, 0, '预授权失败后不得发送上游请求');

    q.run('UPDATE tenants SET credits=1000 WHERE id=?', 1);
    const before = q.get('SELECT credits FROM tenants WHERE id=?', 1).credits;
    let created;
    await withServer(userOne, async base => {
      created = await request(base, '/toolbox/runs', 'POST', {
        toolKey: 'hot', employeeIdx: 141, title: '真实计费运行', inputs: VALID_PAYLOADS.hot.inputs,
      });
      assert.equal(created.response.status, 201, JSON.stringify(created.body));
    });
    assert.equal(upstreamCalls, 1);
    assert.equal(created.body.run.provenance.mode, 'api');
    assert.equal(created.body.billing.state, 'settled');
    assert.ok(created.body.billing.chargedCredits > 0);
    assert.match(capturedBody.messages[0].content, /完整岗位手册/);
    assert.equal(q.get(`SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=1 AND status='held'`).n, 0);
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=?', 1).credits, before - created.body.billing.chargedCredits);
    assert.equal(q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=1 AND feature='经营工具箱·今日必发' AND ai_mode='api'`).n, 1);
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('数据库CHECK约束拒绝第9种工具键', () => {
  assert.throws(() => runWithTenant(1, () => q.run(`INSERT INTO tool_runs(
    tool_key,tool_title,title,status,employee_idx,employee_name,created_by,input_json,input_summary,result_md,provenance_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, 'ninth', '第九工具', '非法', 'done', 141, '云营销', userOne.id, '{}', '非法', '# 非法', '{}')), /CHECK constraint failed/);
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

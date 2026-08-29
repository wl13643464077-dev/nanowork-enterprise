import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DBP = path.join(os.tmpdir(), `nanowork-content-template-route-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* fresh test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.SEED_DEMO = 'false';
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const contentRoutes = (await import('../src/routes/content.js')).default;

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'模板测试门店','已开通',1000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);
const userId = Number(q.run(`INSERT INTO users(
  username,password_hash,name,role,dept,status,tenant_id
) VALUES(?,?,?,?,?,'启用',?)`,
'template-route-user', 'x', '模板管理员', 'boss', '老板办', 1).lastInsertRowid);
const user = { id: userId, name: '模板管理员', role: 'boss', tenant_id: 1 };

function appFor() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(1, () => {
    req.user = user;
    next();
  }));
  app.use('/content', contentRoutes);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  return app;
}

async function withServer(fn) {
  const server = appFor().listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function postTemplate(base, body) {
  const response = await fetch(`${base}/content/templates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('POST /content/templates 在入库前拒绝隔离写探针的空值与额外字段', async () => {
  await withServer(async base => {
    const result = await postTemplate(base, {
      __qa_boundary__: true,
      id: 999999,
      name: '',
      title: '',
      required: '',
    });

    assert.equal(result.response.status, 400);
    assert.match(result.body.error, /(不支持字段|模板名称必填)/);
    assert.equal(q.get('SELECT COUNT(*) count FROM content_templates').count, 0);
  });
});

test('POST /content/templates 拒绝非字符串字段，不再暴露 SQLite 绑定异常', async () => {
  await withServer(async base => {
    const result = await postTemplate(base, {
      name: '测试模板',
      type: ['短视频脚本'],
      prompt: { text: '不应直接入库' },
    });

    assert.equal(result.response.status, 400);
    assert.match(result.body.error, /(适用类型|提示词).*必须是字符串/);
    assert.equal(q.get('SELECT COUNT(*) count FROM content_templates').count, 0);
  });
});

test('POST /content/templates 归一化合法字段并忽略空可选值', async () => {
  await withServer(async base => {
    const result = await postTemplate(base, {
      name: '  企业团餐邀约模板  ',
      type: '  短视频脚本  ',
      prompt: '  围绕已核验的门店信息生成邀约文案。  ',
      tags: '  团餐,邀约  ',
      description: '   ',
      source: '  用户保存模板  ',
    });

    assert.equal(result.response.status, 200);
    assert.equal(typeof result.body.id, 'number');
    const stored = q.get('SELECT name,type,prompt,tags,description,source FROM content_templates WHERE id=?', result.body.id);
    assert.deepEqual({ ...stored }, {
      name: '企业团餐邀约模板',
      type: '短视频脚本',
      prompt: '围绕已核验的门店信息生成邀约文案。',
      tags: '团餐,邀约',
      description: '',
      source: '用户保存模板',
    });
  });
});

after(() => {
  db.close();
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* cleanup */ }
  }
});

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { expectedContentEmployeeArtifactContent } from './helpers/content-output-fixtures.mjs';

const DBP = path.join(os.tmpdir(), `nanowork-content-publish-invariants-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* fresh test database */
  }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';

// 成功交付用例使用本地 OpenAI-compatible 夹具，提供正 token 与岗位合法文案/PPT
// 契约；未包裹的用例保持无 Key，继续覆盖模板失败、退款和零产物门禁。
const nativeFetch = globalThis.fetch;
let fakeYunwuEnabled = false;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url || input || '');
  if (!fakeYunwuEnabled || !url.startsWith('http://yunwu.local/v1/')) {
    return nativeFetch(input, init);
  }
  const body = JSON.parse(String(init.body || '{}'));
  const requestText = JSON.stringify(body.messages || []);
  const isPpt = requestText.includes('只输出一个合法JSON对象');
  let text = isPpt
    ? JSON.stringify({
        title: '门店经营复盘',
        subtitle: '本地 API 夹具',
        pages: [
          { title: '事实核对', bullets: ['只使用已确认信息', '未知项标记待确认'], note: '先统一统计口径' },
          { title: '行动安排', bullets: ['明确责任人', '设置复核节点'], note: '形成可追踪动作' },
        ],
      })
    : expectedContentEmployeeArtifactContent(3);
  // 风控用例的主题故意包含收益承诺；让 API 正向产物也保留风险词，
  // 由生产风险门触发待审阅，而不是靠 template 降级来“碰巧”通过。
  if (!isPpt && /保证稳赚|收益率|稳赚/u.test(requestText)) {
    text += '\n保证稳赚收益率承诺仅作为待核验风险示例。';
  }
  return new Response(JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 180 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

async function withFakeYunwu(fn) {
  const prevKey = process.env.YUNWU_API_KEY;
  const prevBase = process.env.YUNWU_BASE_URL;
  fakeYunwuEnabled = true;
  process.env.YUNWU_API_KEY = 'sk-local-content-publish-fixture';
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
const { holdCredits, settleHold } = await import('../src/engines/credits.js');
const contentModule = await import('../src/routes/content.js');
const contentRoutes = contentModule.default;
const { settleVideoJobSuccess } = contentModule;
const { materialReferencePrompt, materialSelectionResponse } = contentModule;

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'审批发布A店','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(2,'审批发布B店','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);

function insertUser(tenantId, username, name, role = 'boss') {
  return Number(
    q.run(
      `INSERT INTO users(
    username,password_hash,name,role,dept,status,tenant_id
  ) VALUES(?,?,?,?,?,'启用',?)`,
      username,
      'x',
      name,
      role,
      role === 'boss' ? '老板办' : '内容部',
      tenantId,
    ).lastInsertRowid,
  );
}

const bossA = {
  id: insertUser(1, 'publish-boss-a', 'A店老板'),
  name: 'A店老板',
  role: 'boss',
  tenant_id: 1,
};
const staffA = {
  id: insertUser(1, 'publish-staff-a', 'A店员工', 'sales'),
  name: 'A店员工',
  role: 'sales',
  tenant_id: 1,
};
const bossB = {
  id: insertUser(2, 'publish-boss-b', 'B店老板'),
  name: 'B店老板',
  role: 'boss',
  tenant_id: 2,
};

function insertContent(tenantId, creatorId, status, title, extras = {}) {
  return runWithTenant(tenantId, () =>
    Number(
      q.run(
        `INSERT INTO contents(
    type,title,body,topic,status,risk_flags,risk_level,ai_mode,creator_id,effect_views,effect_leads,snapshot_json,source_type
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        '朋友圈文案',
        title,
        `${title}正文`,
        '审批发布不变量',
        status,
        '[]',
        'none',
        extras.aiMode || 'manual',
        creatorId,
        extras.effectViews || 0,
        extras.effectLeads || 0,
        extras.snapshot ? JSON.stringify(extras.snapshot) : null,
        extras.sourceType || null,
      ).lastInsertRowid,
    ),
  );
}

function approveContent(tenantId, contentId, reviewerId) {
  return runWithTenant(tenantId, () => Number(q.run(`INSERT INTO approvals(
    target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,reviewer_id,decided_at
  ) VALUES('content',?,'测试人工采纳','测试人工采纳','none','[]','已通过',?,?,datetime('now','localtime'))`,
  contentId, reviewerId, reviewerId).lastInsertRowid));
}

function insertApprovedContent(tenantId, creatorId, status, title, extras = {}) {
  const contentId = insertContent(tenantId, creatorId, status, title, extras);
  approveContent(tenantId, contentId, creatorId);
  return contentId;
}

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) =>
    runWithTenant(user.tenant_id, () => {
      req.user = user;
      next();
    }),
  );
  app.use('/content', contentRoutes);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function request(base, route, body = {}) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

function publishKey(sequence) {
  return `00000000-0000-4000-8000-${Number(sequence).toString(16).padStart(12, '0')}`;
}

test('流水线provider图片不从素材接口泄露签名URL/base64，也不把图片字节注入文本模型', () => {
  const material = {
    id: 99_001,
    name: '流水线图片',
    type: '图片',
    source_type: 'content_pipeline_provider',
    source_id: 701,
    url: 'https://signed.example/image.png?token=must-not-leak',
    body_snapshot: 'data:image/png;base64,cHJvdmlkZXItaW1hZ2UtYnl0ZXM=',
    artifact_snapshot_json: JSON.stringify({ employeeIdx: 5 }),
    snapshot_hash: 'a'.repeat(64),
  };
  const selected = materialSelectionResponse(material);
  assert.equal(selected.url, null);
  assert.equal(selected.bodyPreview, null);
  assert.match(selected.providerAsset.previewUrl,
    /^\/api\/content\/pipelines\/701\/stations\/5\/provider-assets\/99001\/preview$/u);
  assert.doesNotMatch(JSON.stringify(selected), /must-not-leak|cHJvdmlkZXItaW1hZ2UtYnl0ZXM/u);

  const prompt = materialReferencePrompt([material]);
  assert.match(prompt, /未执行识图/u);
  assert.match(prompt, /不注入base64字节/u);
  assert.doesNotMatch(prompt, /must-not-leak|cHJvdmlkZXItaW1hZ2UtYnl0ZXM/u);
});

test('导入素材只接受可使用/已发布内容，拒绝待审核、已驳回和越权内容', async () => {
  const pendingId = insertContent(1, bossA.id, '待审核', '待审核不可入库');
  const rejectedId = insertContent(1, bossA.id, '已驳回', '已驳回不可入库');
  const usableId = insertApprovedContent(1, bossA.id, '可使用', '可使用可入库');
  const publishedId = insertApprovedContent(1, bossA.id, '已发布', '已发布可入库');
  const otherOwnerId = insertContent(1, bossA.id, '可使用', '员工不可越权入库');
  const tenantBId = insertContent(2, bossB.id, '可使用', 'B店私有内容');

  await withServer(bossA, async base => {
    for (const id of [pendingId, rejectedId]) {
      const blocked = await request(base, `/content/${id}/import-material`);
      assert.equal(blocked.response.status, 409);
      assert.deepEqual(blocked.data.allowedStatuses, ['可使用', '已发布']);
    }
    for (const id of [usableId, publishedId]) {
      const imported = await request(base, `/content/${id}/import-material`);
      assert.equal(imported.response.status, 200);
      assert.equal(imported.data.source_type, 'content');
      assert.equal(imported.data.source_id, id);
    }
    assert.equal((await request(base, `/content/${tenantBId}/import-material`)).response.status, 404);
  });

  await withServer(staffA, async base => {
    assert.equal((await request(base, `/content/${otherOwnerId}/import-material`)).response.status, 403);
  });

  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM materials WHERE tenant_id=1 AND source_type='content'
    AND source_id IN (?,?)`,
      pendingId,
      rejectedId,
    ).n,
    0,
  );
});

test('机器质检通过只允许内部预览，人工采纳前禁止正式入库和发布登记', async () => {
  const contentId = insertContent(1, bossA.id, '可使用', '待人工采纳内容', {
    aiMode: 'api',
    snapshot: {
      contract: { status: 'valid', valid: true },
      billing: { state: 'settled', chargedCredits: 3 },
    },
  });
  await withServer(bossA, async base => {
    const beforeList = await fetch(`${base}/content/list?kw=${encodeURIComponent('待人工采纳内容')}`);
    const beforeRow = (await beforeList.json()).rows.find(row => Number(row.id) === contentId);
    assert.equal(beforeRow.delivery.machineQualityPassed, true);
    assert.equal(beforeRow.delivery.canPreview, true);
    assert.equal(beforeRow.delivery.humanApproved, false);
    assert.equal(beforeRow.delivery.canImport, false);
    assert.equal(beforeRow.delivery.canPublish, false);

    const blockedImport = await request(base, `/content/${contentId}/import-material`);
    assert.equal(blockedImport.response.status, 409);
    assert.equal(blockedImport.data.code, 'DELIVERY_HUMAN_APPROVAL_REQUIRED');

    const blockedPublish = await request(base, `/content/${contentId}/publish-log`, {
      channel: '朋友圈', views: 1, leads: 0, idempotencyKey: publishKey(600),
    });
    assert.equal(blockedPublish.response.status, 409);
    assert.match(blockedPublish.data.error, /尚未人工采纳|内部预览/u);

    approveContent(1, contentId, bossA.id);
    const imported = await request(base, `/content/${contentId}/import-material`);
    assert.equal(imported.response.status, 200);
    const published = await request(base, `/content/${contentId}/publish-log`, {
      channel: '朋友圈', views: 1, leads: 0, idempotencyKey: publishKey(601),
    });
    assert.equal(published.response.status, 200);
  });
});

test('状态伪装成可使用也无法绕过来源与契约门禁', async () => {
  const blockedIds = [
    insertContent(1, bossA.id, '可使用', 'template伪可用', {
      aiMode: 'template',
    }),
    insertContent(1, bossA.id, '可使用', 'fallback伪可用', {
      aiMode: 'fallback',
    }),
    insertContent(1, bossA.id, '可使用', 'failed伪可用', { aiMode: 'failed' }),
    insertContent(1, bossA.id, '可使用', '契约无效伪可用', {
      aiMode: 'api',
      snapshot: {
        contract: {
          status: 'invalid',
          valid: false,
          errors: ['contract rejected'],
        },
      },
    }),
  ];

  await withServer(bossA, async base => {
    let sequence = 700;
    for (const id of blockedIds) {
      const imported = await request(base, `/content/${id}/import-material`);
      assert.equal(imported.response.status, 409);
      assert.match(imported.data.code, /^DELIVERY_/u);

      const published = await request(base, `/content/${id}/publish-log`, {
        channel: '朋友圈',
        views: 1,
        leads: 0,
        idempotencyKey: publishKey(sequence++),
      });
      assert.equal(published.response.status, 409);
    }
  });

  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM materials WHERE tenant_id=1
    AND source_type='content' AND source_id IN (${blockedIds.map(() => '?').join(',')})`,
      ...blockedIds,
    ).n,
    0,
  );
  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1
    AND source_type='content' AND source_id IN (${blockedIds.map(() => '?').join(',')})`,
      ...blockedIds,
    ).n,
    0,
  );
  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM content_publish_logs WHERE tenant_id=1
    AND content_id IN (${blockedIds.map(() => '?').join(',')})`,
      ...blockedIds,
    ).n,
    0,
  );
});

test('内容入素材库保持幂等，已自动登记的同源资产不会被重复创建', async () => {
  const contentId = insertApprovedContent(1, bossA.id, '可使用', '幂等入库内容');
  runWithTenant(1, () =>
    q.run(
      `INSERT INTO biz_assets(
    name,category,value,status,use_count,owner,source_type,source_id,creator_id,note
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      '既有内容资产',
      '内容资产',
      50,
      '使用中',
      0,
      '内容生产仓',
      'content',
      contentId,
      bossA.id,
      '自动登记资产',
    ),
  );

  await withServer(bossA, async base => {
    const first = await request(base, `/content/${contentId}/import-material`);
    assert.equal(first.response.status, 200);
    assert.equal(first.data.existed, undefined);
    const second = await request(base, `/content/${contentId}/import-material`);
    assert.equal(second.response.status, 200);
    assert.equal(second.data.existed, true);
  });

  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM materials
    WHERE tenant_id=1 AND source_type='content' AND source_id=?`,
      contentId,
    ).n,
    1,
  );
  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM biz_assets
    WHERE tenant_id=1 AND source_type='content' AND source_id=?`,
      contentId,
    ).n,
    1,
  );
  const material = q.get(
    `SELECT * FROM materials
    WHERE tenant_id=1 AND source_type='content' AND source_id=?`,
    contentId,
  );
  assert.equal(material.body_snapshot, '幂等入库内容正文');
  assert.equal(JSON.parse(material.artifact_snapshot_json).contentId, contentId);
  assert.match(material.snapshot_hash, /^[a-f0-9]{64}$/u);
  assert.throws(
    () =>
      runWithTenant(1, () =>
        q.run(
          `UPDATE materials SET body_snapshot='篡改正文'
      WHERE tenant_id=1 AND id=?`,
          material.id,
        ),
      ),
    /material body snapshot is immutable/u,
  );
  assert.throws(
    () =>
      runWithTenant(1, () =>
        q.run(
          `UPDATE materials SET artifact_snapshot_json='{}'
      WHERE tenant_id=1 AND id=?`,
          material.id,
        ),
      ),
    /material artifact snapshot is immutable/u,
  );
  assert.throws(
    () =>
      runWithTenant(1, () =>
        q.run(
          `UPDATE materials SET snapshot_hash='tampered'
      WHERE tenant_id=1 AND id=?`,
          material.id,
        ),
      ),
    /material snapshot hash is immutable/u,
  );
});

test('素材选择不提前计数，只有真实生成成功才幂等写引用；失败、越权和非法选择均不计数', async () => {
  const sourceContentId = insertApprovedContent(1, bossA.id, '可使用', '真实素材引用源');
  let materialId;
  await withServer(bossA, async base => {
    const imported = await request(base, `/content/${sourceContentId}/import-material`);
    assert.equal(imported.response.status, 200);
    materialId = Number(imported.data.id);

    const selected = await request(base, `/content/materials/${materialId}/use`);
    assert.equal(selected.response.status, 200);
    assert.equal(selected.data.use_count, 0);
    const selectedAgain = await request(base, `/content/materials/${materialId}/use`);
    assert.equal(selectedAgain.response.status, 200);
    assert.equal(selectedAgain.data.use_count, 0);
    assert.equal(q.get(`SELECT use_count FROM materials WHERE tenant_id=1 AND id=?`, materialId).use_count, 0);

    const duplicate = await request(base, '/content/generate', {
      type: '朋友圈文案',
      topic: '重复素材编号应拒绝',
      employeeIdx: 3,
      materialIds: [materialId, materialId],
    });
    assert.equal(duplicate.response.status, 400);

    const tooMany = await request(base, '/content/generate', {
      type: '朋友圈文案',
      topic: '素材数量上限',
      employeeIdx: 3,
      materialIds: Array(7).fill(materialId),
    });
    assert.equal(tooMany.response.status, 400);

    const failedMedia = await request(base, '/content/generate-image', {
      prompt: '当前没有媒体通道，本次必须失败且不能记录素材使用',
      employeeIdx: 5,
      materialIds: [materialId],
    });
    assert.equal(failedMedia.response.status, 503);
    assert.equal(q.get(`SELECT use_count FROM materials WHERE tenant_id=1 AND id=?`, materialId).use_count, 0);

    const generated = await withFakeYunwu(() => request(base, '/content/generate', {
      type: '朋友圈文案',
      topic: '真实素材引用验收',
      requirement: '只依据已持久化的素材正文形成待审阅稿。',
      employeeIdx: 3,
      materialIds: [materialId],
    }));
    assert.equal(generated.response.status, 200);
    assert.equal(generated.data.materialReferencesUsed, 1);
    assert.equal(q.get(`SELECT use_count FROM materials WHERE tenant_id=1 AND id=?`, materialId).use_count, 1);
    const ref = q.get(
      `SELECT * FROM content_material_refs
      WHERE tenant_id=1 AND target_type='content' AND target_id=? AND material_id=?`,
      generated.data.id,
      materialId,
    );
    assert.ok(ref);
    const generatedRow = q.get(
      `SELECT snapshot_json FROM contents
      WHERE tenant_id=1 AND id=?`,
      generated.data.id,
    );
    const snapshot = JSON.parse(generatedRow.snapshot_json);
    assert.deepEqual(
      snapshot.materialReferences.map(item => item.id),
      [materialId],
    );
    assert.equal(snapshot.materialReferences[0].hasBodySnapshot, true);
  });

  await withServer(bossB, async base => {
    const crossTenant = await request(base, '/content/generate', {
      type: '朋友圈文案',
      topic: '跨租户素材不可见',
      employeeIdx: 3,
      materialIds: [materialId],
    });
    assert.equal(crossTenant.response.status, 404);
  });
  assert.equal(q.get(`SELECT use_count FROM materials WHERE tenant_id=1 AND id=?`, materialId).use_count, 1);
});

test('PPT、日更各子内容和媒体终态分别保留真实素材引用链', async () => {
  const sourceContentId = insertApprovedContent(1, bossA.id, '可使用', '多入口素材引用源');
  let materialId;
  await withServer(bossA, async base => {
    const imported = await request(base, `/content/${sourceContentId}/import-material`);
    assert.equal(imported.response.status, 200);
    materialId = Number(imported.data.id);

    const ppt = await withFakeYunwu(() => request(base, '/content/generate-ppt', {
      topic: '保证稳赚的多入口引用PPT',
      pages: 3,
      employeeIdx: 7,
      materialIds: [materialId],
    }));
    assert.equal(ppt.response.status, 200);
    assert.equal(ppt.data.materialReferencesUsed, 1);
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM content_material_refs
      WHERE tenant_id=1 AND target_type='content' AND target_id=? AND material_id=?`,
        ppt.data.id,
        materialId,
      ).n,
      1,
    );

    const daily = await withFakeYunwu(() => request(base, '/content/daily-pack', {
      topic: '保证稳赚的多入口引用日更',
      requirement: '本次只用于验证高风险草稿的素材引用链，必须进入待审核。',
      employeeIdx: 3,
      materialIds: [materialId],
    }));
    assert.equal(daily.response.status, 200);
    assert.equal(daily.data.results.length, 3);
    for (const item of daily.data.results) {
      assert.equal(item.materialReferencesUsed, 1);
      assert.equal(
        q.get(
          `SELECT COUNT(*) n FROM content_material_refs
        WHERE tenant_id=1 AND target_type='content' AND target_id=? AND material_id=?`,
          item.id,
          materialId,
        ).n,
        1,
      );
    }
  });

  const jobId = runWithTenant(1, () =>
    Number(
      q.run(
        `INSERT INTO media_jobs(
    user_id,kind,model,prompt,status,snapshot_json
  ) VALUES(?,?,?,?,?,?)`,
        bossA.id,
        'video',
        'test-video',
        '多入口媒体引用',
        '处理中',
        JSON.stringify({ materialReferences: [{ id: materialId }] }),
      ).lastInsertRowid,
    ),
  );
  runWithTenant(1, () => {
    const job = q.get(`SELECT * FROM media_jobs WHERE tenant_id=1 AND id=?`, jobId);
    settleVideoJobSuccess(job, 'https://example.com/generated.mp4');
  });
  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM content_material_refs
    WHERE tenant_id=1 AND target_type='media_job' AND target_id=? AND material_id=?`,
      jobId,
      materialId,
    ).n,
    1,
  );
  assert.equal(q.get(`SELECT use_count FROM materials WHERE tenant_id=1 AND id=?`, materialId).use_count, 5);
});

test('失败、处理中、无文件地址或非图片视频的媒体任务不能导入素材库', async () => {
  const jobs = {};
  for (const [key, kind, status, url] of [
    ['failed', 'image', '失败', '/failed.png'],
    ['running', 'video', '处理中', '/running.mp4'],
    ['missingUrl', 'image', '成功', null],
    ['text', 'text', '成功', '/not-media.txt'],
    ['valid', 'image', '成功', '/valid.png'],
  ]) {
    jobs[key] = runWithTenant(1, () =>
      Number(
        q.run(
          `INSERT INTO media_jobs(
      user_id,kind,model,prompt,status,url
    ) VALUES(?,?,?,?,?,?)`,
          bossA.id,
          kind,
          'test-model',
          `${key}任务`,
          status,
          url,
        ).lastInsertRowid,
      ),
    );
  }
  runWithTenant(1, () => {
    const hold = holdCredits({
      userId: bossA.id,
      feature: '媒体导入正向门禁',
      kind: 'image',
      model: 'test-model',
      credits: 2,
      refType: 'media_job',
      refId: jobs.valid,
    });
    settleHold(hold, {
      credits: 2,
      model: 'test-model',
      note: '媒体导入正向用例完成权威结算',
    });
  });

  await withServer(bossA, async base => {
    for (const key of ['failed', 'running', 'missingUrl', 'text']) {
      const blocked = await request(base, `/content/media-jobs/${jobs[key]}/import-material`);
      assert.equal(blocked.response.status, 409, key);
    }
    const valid = await request(base, `/content/media-jobs/${jobs.valid}/import-material`);
    assert.equal(valid.response.status, 200);
    assert.equal(valid.data.source_type, 'media_job');
  });

  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM materials WHERE tenant_id=1
    AND source_type='media_job' AND source_id IN (?,?,?,?)`,
      jobs.failed,
      jobs.running,
      jobs.missingUrl,
      jobs.text,
    ).n,
    0,
  );
  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM materials WHERE tenant_id=1
    AND source_type='media_job' AND source_id=?`,
      jobs.valid,
    ).n,
    1,
  );
});

test('Boss测试期内容统一自动采用：命中风控也不创建人工审批节点', async () => {
  await withServer(bossA, async base => {
    const copy = await withFakeYunwu(() => request(base, '/content/generate', {
      type: '招商文案',
      topic: '保证稳赚的招商边界验收',
      count: 1,
      requirement: '只写待核验草稿，不要作收益承诺。',
      employeeIdx: 3,
    }));
    assert.equal(copy.response.status, 200);
    assert.equal(copy.data.status, '可使用');
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM biz_assets
      WHERE tenant_id=1 AND source_type='content' AND source_id=?`,
        copy.data.id,
      ).n,
      1,
    );
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM approvals
      WHERE tenant_id=1 AND target_type='content' AND target_id=?`,
        copy.data.id,
      ).n,
      0,
    );

    const ppt = await withFakeYunwu(() => request(base, '/content/generate-ppt', {
      topic: '保证稳赚的收益率方案',
      structure: '背景→方案→下一步',
      pages: 3,
      employeeIdx: 7,
    }));
    assert.equal(ppt.response.status, 200);
    assert.equal(ppt.data.status, '可使用');
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM biz_assets
      WHERE tenant_id=1 AND source_type='content' AND source_id=?`,
        ppt.data.id,
      ).n,
      1,
    );
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM approvals
      WHERE tenant_id=1 AND target_type='content' AND target_id=?`,
        ppt.data.id,
      ).n,
      0,
    );
  });
});

test('发布登记拒绝未获批状态以及NaN、负数、小数、超大值和非法渠道', async () => {
  const pendingId = insertContent(1, bossA.id, '待审核', '待审核不可发布');
  const rejectedId = insertContent(1, bossA.id, '已驳回', '已驳回不可发布');
  const usableId = insertContent(1, bossA.id, '可使用', '发布参数校验');
  const tenantBId = insertContent(2, bossB.id, '可使用', 'B店不可越权发布');

  await withServer(bossA, async base => {
    for (const id of [pendingId, rejectedId]) {
      assert.equal(
        (
          await request(base, `/content/${id}/publish-log`, {
            channel: '朋友圈',
            views: 1,
            leads: 1,
            idempotencyKey: publishKey(id),
          })
        ).response.status,
        409,
      );
    }
    assert.equal(
      (
        await request(base, `/content/${tenantBId}/publish-log`, {
          channel: '朋友圈',
          views: 1,
          leads: 1,
          idempotencyKey: publishKey(tenantBId),
        })
      ).response.status,
      404,
    );

    const invalidBodies = [
      { channel: '', views: 0, leads: 0, idempotencyKey: publishKey(101) },
      {
        channel: 'x'.repeat(41),
        views: 0,
        leads: 0,
        idempotencyKey: publishKey(102),
      },
      {
        channel: '朋友圈',
        views: Number.NaN,
        leads: 0,
        idempotencyKey: publishKey(103),
      },
      {
        channel: '朋友圈',
        views: -1,
        leads: 0,
        idempotencyKey: publishKey(104),
      },
      {
        channel: '朋友圈',
        views: 1.5,
        leads: 0,
        idempotencyKey: publishKey(105),
      },
      {
        channel: '朋友圈',
        views: 100_000_001,
        leads: 0,
        idempotencyKey: publishKey(106),
      },
      {
        channel: '朋友圈',
        views: 0,
        leads: -1,
        idempotencyKey: publishKey(107),
      },
      {
        channel: '朋友圈',
        views: 0,
        leads: 0.5,
        idempotencyKey: publishKey(108),
      },
      {
        channel: '朋友圈',
        views: 0,
        leads: 1_000_001,
        idempotencyKey: publishKey(109),
      },
      {
        channel: '朋友圈',
        views: '100',
        leads: 0,
        idempotencyKey: publishKey(110),
      },
      { channel: '朋友圈', views: 0, leads: 0 },
      { channel: '朋友圈', views: 0, leads: 0, idempotencyKey: 'not-a-uuid' },
    ];
    for (const body of invalidBodies) {
      const invalid = await request(base, `/content/${usableId}/publish-log`, body);
      assert.equal(invalid.response.status, 400, JSON.stringify(body));
    }
  });

  const unchanged = q.get(
    `SELECT status,channel,effect_views,effect_leads FROM contents
    WHERE tenant_id=1 AND id=?`,
    usableId,
  );
  assert.equal(unchanged.status, '可使用');
  assert.equal(unchanged.channel, null);
  assert.equal(unchanged.effect_views, 0);
  assert.equal(unchanged.effect_leads, 0);
});

test('待审核孤儿记录会补建真实审批单，已有待审审批保持幂等', async () => {
  const orphanId = insertContent(1, bossA.id, '待审核', '孤儿待审核');
  const existingId = insertContent(1, bossA.id, '可使用', '已有审批');
  const existingApprovalId = runWithTenant(1, () =>
    Number(
      q.run(
        `INSERT INTO approvals(
    target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id
  ) VALUES('content',?,?,?,?,?,'待审核',?)`,
        existingId,
        '已有审批',
        '幂等测试',
        'none',
        '[]',
        bossA.id,
      ).lastInsertRowid,
    ),
  );

  await withServer(bossA, async base => {
    const repaired = await request(base, `/content/${orphanId}/submit-approval`);
    assert.equal(repaired.response.status, 200);
    assert.equal(repaired.data.repaired, true);
    assert.ok(Number.isInteger(repaired.data.approvalId));
    assert.ok(repaired.data.approvalId > 0);

    const repeated = await request(base, `/content/${orphanId}/submit-approval`);
    assert.equal(repeated.response.status, 200);
    assert.equal(repeated.data.existed, true);
    assert.equal(repeated.data.approvalId, repaired.data.approvalId);
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM approvals WHERE tenant_id=1
      AND target_type='content' AND target_id=? AND status='待审核'`,
        orphanId,
      ).n,
      1,
    );

    const existing = await request(base, `/content/${existingId}/submit-approval`);
    assert.equal(existing.response.status, 200);
    assert.equal(existing.data.existed, true);
    assert.equal(existing.data.approvalId, existingApprovalId);
    assert.equal(q.get(`SELECT status FROM contents WHERE tenant_id=1 AND id=?`, existingId).status, '待审核');
  });
});

test('内容列表使用真实交付门禁决定状态、审核入口和发布权限', async () => {
  const templateId = insertContent(1, bossA.id, '可使用', '模板状态不得冒充可交付', { aiMode: 'template' });
  const qualityRejectedId = insertContent(1, bossA.id, '已驳回', '系统纠正的质检失败底稿', {
    aiMode: 'template',
  });
  const humanRejectedId = insertContent(1, bossA.id, '已驳回', '真实人工驳回内容');
  const draftId = insertContent(1, bossA.id, '草稿', '真实人工草稿');
  const usableId = insertContent(1, bossA.id, '可使用', '已过门禁可选人工复核', {
    aiMode: 'api',
    snapshot: {
      contract: { status: 'valid', valid: true },
      billing: { state: 'settled', chargedCredits: 3 },
    },
  });
  const adoptedId = insertContent(1, bossA.id, '可使用', '已完成人工采纳');
  runWithTenant(1, () => q.run(`INSERT INTO approvals(
    target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,reviewer_id,decided_at
  ) VALUES('content',?,?,?,?,?,'已通过',?,?,datetime('now','localtime'))`,
  adoptedId, '已完成人工采纳', '人工已审阅', 'none', '[]', bossA.id, bossA.id));
  runWithTenant(1, () => {
    q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,reason,decided_at
    ) VALUES('content',?,'系统纠正的质检失败底稿','旧演示占位底稿','none','[]','已驳回',?,
      '系统对账：模板底稿未通过交付门禁',datetime('now','localtime'))`,
    qualityRejectedId, bossA.id);
    q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,reviewer_id,reason,decided_at
    ) VALUES('content',?,'真实人工驳回内容','人工已审阅','none','[]','已驳回',?,?,
      '经营依据不足',datetime('now','localtime'))`,
    humanRejectedId, bossA.id, bossA.id);
  });
  const orphanId = insertContent(1, bossA.id, '待审核', '待审核但审核单缺失');

  await withServer(bossA, async base => {
    const response = await fetch(`${base}/content/list?size=100`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    const byId = new Map(payload.rows.map(row => [Number(row.id), row]));

    const template = byId.get(templateId);
    assert.equal(template.delivery.presentationKey, 'rework_required');
    assert.equal(template.delivery.displayStatus, '失败需返工（质检未通过）');
    assert.equal(template.delivery.canUse, false);
    assert.equal(template.delivery.canImport, false);
    assert.equal(template.delivery.canPublish, false);
    assert.equal(template.delivery.canSubmitApproval, false);
    assert.match(template.delivery.reason, /模板.*需要重新执行/u);

    const qualityRejected = byId.get(qualityRejectedId);
    assert.equal(qualityRejected.delivery.presentationKey, 'rework_required');
    assert.equal(qualityRejected.delivery.displayStatus, '失败需返工（质检未通过）');
    assert.equal(qualityRejected.delivery.canUse, false);
    assert.match(qualityRejected.delivery.reason, /模板|质检/u);

    const humanRejected = byId.get(humanRejectedId);
    assert.equal(humanRejected.delivery.presentationKey, 'rework_required');
    assert.equal(humanRejected.delivery.displayStatus, '失败需返工（人工审阅未通过）');
    assert.equal(humanRejected.delivery.canUse, false);
    assert.match(humanRejected.delivery.reason, /人工审阅未通过/u);

    const draft = byId.get(draftId);
    assert.equal(draft.delivery.presentationKey, 'draft');
    assert.equal(draft.delivery.displayStatus, '草稿（待提交人工审阅）');
    assert.equal(draft.delivery.canUse, false);
    assert.equal(draft.delivery.canSubmitApproval, true);
    assert.equal(draft.delivery.approvalActionLabel, '提交人工审阅');

    const usable = byId.get(usableId);
    assert.equal(usable.delivery.presentationKey, 'review_ready');
    assert.equal(usable.delivery.displayStatus, '可验收（待提交人工审阅）');
    assert.equal(usable.delivery.machineQualityPassed, true);
    assert.equal(usable.delivery.canPreview, true);
    assert.equal(usable.delivery.humanApproved, false);
    assert.equal(usable.delivery.canUse, false);
    assert.equal(usable.delivery.canImport, false);
    assert.equal(usable.delivery.canPublish, false);
    assert.equal(usable.delivery.canSubmitApproval, true);
    assert.equal(usable.delivery.approvalActionLabel, '提交人工审阅');
    assert.match(usable.delivery.reason, /机器质检|尚未人工采纳|内部预览/u);

    const adopted = byId.get(adoptedId);
    assert.equal(adopted.delivery.presentationKey, 'adopted');
    assert.equal(adopted.delivery.displayStatus, '已人工采纳（可用于业务）');
    assert.equal(adopted.delivery.humanApproved, true);
    assert.equal(adopted.delivery.canUse, true);
    assert.equal(adopted.delivery.canPublish, true);
    assert.equal(adopted.delivery.canSubmitApproval, false);
    assert.match(adopted.delivery.reason, /人工审阅已通过/u);

    const orphan = byId.get(orphanId);
    assert.equal(orphan.delivery.presentationKey, 'review_ready');
    assert.equal(orphan.delivery.displayStatus, '可验收（审阅单待补建）');
    assert.equal(orphan.delivery.canUse, false);
    assert.equal(orphan.delivery.canSubmitApproval, true);
    assert.equal(orphan.delivery.approvalActionLabel, '补建审阅单');

    for (const row of [template, qualityRejected, humanRejected, draft, usable, adopted, orphan]) {
      assert.equal(Object.hasOwn(row.delivery, 'code'), false);
      assert.equal(Object.hasOwn(row.delivery, 'state'), false);
    }
  });
});

test('“质检通过”筛选按 canonical delivery 过滤并在过滤后计算分页 total', async () => {
  const eligibleIds = [
    insertApprovedContent(1, bossA.id, '可使用', 'canonical分页·人工一'),
    insertApprovedContent(1, bossA.id, '可使用', 'canonical分页·人工二'),
  ];
  const blockedTemplateId = insertContent(1, bossA.id, '可使用', 'canonical分页·模板伪通过', {
    aiMode: 'template',
  });
  const blockedBillingId = insertContent(1, bossA.id, '可使用', 'canonical分页·待对账伪通过', {
    aiMode: 'api',
    snapshot: {
      contract: { status: 'valid', valid: true },
      billing: { state: 'pending_reconciliation', heldCredits: 8 },
    },
  });

  await withServer(bossA, async base => {
    const pages = [];
    for (const page of [1, 2]) {
      const response = await fetch(`${base}/content/list?status=${encodeURIComponent('可使用')}&kw=${encodeURIComponent('canonical分页')}&size=1&page=${page}`);
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.total, 2);
      assert.equal(payload.rows.length, 1);
      assert.equal(payload.rows[0].delivery.canUse, true);
      pages.push(Number(payload.rows[0].id));
    }
    assert.deepEqual(new Set(pages), new Set(eligibleIds));
    assert.equal(pages.includes(blockedTemplateId), false);
    assert.equal(pages.includes(blockedBillingId), false);

    const pendingPayload = await fetch(`${base}/content/list?kw=${encodeURIComponent('canonical分页·待对账伪通过')}&size=10`)
      .then(response => response.json());
    const pending = pendingPayload.rows.find(row => Number(row.id) === blockedBillingId);
    assert.equal(pending.delivery.presentationKey, 'business_blocked');
    assert.equal(pending.delivery.displayStatus, '业务暂不可采用（待账务对账）');
    assert.equal(pending.delivery.canUse, false);
    assert.equal(pending.delivery.canImport, false);
    assert.equal(pending.delivery.canPublish, false);
    assert.equal(pending.delivery.canSubmitApproval, false);
    assert.match(pending.delivery.reason, /待对账|尚未完成结算/u);
  });
});

test('已发布与已驳回内容禁止把原文直接重提审核', async () => {
  const publishedId = insertContent(1, bossA.id, '已发布', '已发布原文');
  const rejectedId = insertContent(1, bossA.id, '已驳回', '已驳回原文');
  await withServer(bossA, async base => {
    for (const id of [publishedId, rejectedId]) {
      const blocked = await request(base, `/content/${id}/submit-approval`);
      assert.equal(blocked.response.status, 409);
    }
  });
  assert.equal(q.get(`SELECT status FROM contents WHERE tenant_id=1 AND id=?`, publishedId).status, '已发布');
  assert.equal(q.get(`SELECT status FROM contents WHERE tenant_id=1 AND id=?`, rejectedId).status, '已驳回');
  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM approvals WHERE tenant_id=1
    AND target_type='content' AND target_id IN (?,?)`,
      publishedId,
      rejectedId,
    ).n,
    0,
  );
});

test('已通过的内容版本不能原地退回待审，必须新建修订版', async () => {
  const usableId = insertContent(1, bossA.id, '可使用', '已通过版本不可回退');
  const approvalId = runWithTenant(1, () =>
    Number(
      q.run(
        `INSERT INTO approvals(
    target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,reviewer_id,decided_at
  ) VALUES('content',?,?,?,?,?,'已通过',?,?,datetime('now','localtime'))`,
        usableId,
        '已通过版本',
        '已完成审批',
        'none',
        '[]',
        bossA.id,
        bossA.id,
      ).lastInsertRowid,
    ),
  );

  await withServer(bossA, async base => {
    const blocked = await request(base, `/content/${usableId}/submit-approval`);
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.data.code, 'APPROVED_VERSION_IMMUTABLE');
    assert.equal(blocked.data.approvalId, approvalId);
  });

  assert.equal(q.get(`SELECT status FROM contents WHERE tenant_id=1 AND id=?`, usableId).status, '可使用');
  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM approvals WHERE tenant_id=1
    AND target_type='content' AND target_id=? AND status='待审核'`,
      usableId,
    ).n,
    0,
  );
});

test('合法发布会累计效果、保留可追溯渠道并更新已入库内容资产', async () => {
  const contentId = insertApprovedContent(1, bossA.id, '可使用', '合法发布', {
    effectViews: 12,
    effectLeads: 1,
  });
  runWithTenant(1, () =>
    q.run(
      `INSERT INTO biz_assets(
    name,category,value,status,use_count,owner,source_type,source_id,creator_id,note
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      '合法发布资产',
      '内容资产',
      100,
      '使用中',
      0,
      '内容生产仓',
      'content',
      contentId,
      bossA.id,
      '测试资产',
    ),
  );

  await withServer(bossA, async base => {
    const published = await request(base, `/content/${contentId}/publish-log`, {
      channel: '  朋友圈  ',
      views: 88,
      leads: 2,
      idempotencyKey: publishKey(201),
    });
    assert.equal(published.response.status, 200);
    assert.equal(published.data.existed, false);
    assert.equal(published.data.status, '已发布');
    assert.equal(published.data.channel, '朋友圈');
    assert.equal(published.data.totalViews, 100);
    assert.equal(published.data.totalLeads, 3);
  });

  const content = q.get(
    `SELECT status,channel,effect_views,effect_leads FROM contents
    WHERE tenant_id=1 AND id=?`,
    contentId,
  );
  assert.equal(content.status, '已发布');
  assert.equal(content.channel, '朋友圈');
  assert.equal(content.effect_views, 100);
  assert.equal(content.effect_leads, 3);
  const asset = q.get(
    `SELECT value,use_count FROM biz_assets WHERE tenant_id=1
    AND source_type='content' AND source_id=?`,
    contentId,
  );
  assert.equal(asset.value, 120);
  assert.equal(asset.use_count, 1);
  const log = q.get(
    `SELECT channel,views,leads,created_by,idempotency_key
    FROM content_publish_logs WHERE tenant_id=1 AND content_id=?`,
    contentId,
  );
  assert.equal(log.channel, '朋友圈');
  assert.equal(log.views, 88);
  assert.equal(log.leads, 2);
  assert.equal(log.created_by, bossA.id);
  assert.equal(log.idempotency_key, publishKey(201));
});

test('同一幂等键重试不重复累计，不同键逐次累计且详情返回完整发布日志', async () => {
  const contentId = insertApprovedContent(1, bossA.id, '可使用', '幂等发布');
  runWithTenant(1, () =>
    q.run(
      `INSERT INTO biz_assets(
    name,category,value,status,use_count,owner,source_type,source_id,creator_id,note
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      '幂等发布资产',
      '内容资产',
      100,
      '使用中',
      0,
      '内容生产仓',
      'content',
      contentId,
      bossA.id,
      '测试资产',
    ),
  );
  const firstKey = publishKey(202);
  const secondKey = publishKey(203);

  await withServer(bossA, async base => {
    const first = await request(base, `/content/${contentId}/publish-log`, {
      channel: '朋友圈',
      views: 10,
      leads: 1,
      idempotencyKey: firstKey,
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.data.existed, false);

    const retry = await request(base, `/content/${contentId}/publish-log`, {
      channel: '朋友圈',
      views: 10,
      leads: 1,
      idempotencyKey: firstKey,
    });
    assert.equal(retry.response.status, 200);
    assert.equal(retry.data.existed, true);
    assert.equal(retry.data.logId, first.data.logId);
    assert.equal(retry.data.totalViews, 10);
    assert.equal(retry.data.totalLeads, 1);

    const keyReuseMismatch = await request(base, `/content/${contentId}/publish-log`, {
      channel: '社群',
      views: 99,
      leads: 9,
      idempotencyKey: firstKey,
    });
    assert.equal(keyReuseMismatch.response.status, 409);

    const second = await request(base, `/content/${contentId}/publish-log`, {
      channel: '社群',
      views: 20,
      leads: 2,
      idempotencyKey: secondKey,
    });
    assert.equal(second.response.status, 200);
    assert.equal(second.data.existed, false);
    assert.equal(second.data.totalViews, 30);
    assert.equal(second.data.totalLeads, 3);

    const detailResponse = await fetch(`${base}/content/detail/${contentId}`);
    const detail = await detailResponse.json();
    assert.equal(detailResponse.status, 200);
    assert.equal(detail.publishLogs.length, 2);
    assert.deepEqual(
      detail.publishLogs.map(item => item.idempotency_key),
      [secondKey, firstKey],
    );
    assert.equal(detail.publishLogs[0].created_by_name, bossA.name);
  });

  const content = q.get(
    `SELECT channel,effect_views,effect_leads FROM contents
    WHERE tenant_id=1 AND id=?`,
    contentId,
  );
  assert.equal(content.channel, '社群');
  assert.equal(content.effect_views, 30);
  assert.equal(content.effect_leads, 3);
  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM content_publish_logs
    WHERE tenant_id=1 AND content_id=?`,
      contentId,
    ).n,
    2,
  );
  const asset = q.get(
    `SELECT value,use_count FROM biz_assets WHERE tenant_id=1
    AND source_type='content' AND source_id=?`,
    contentId,
  );
  assert.equal(asset.value, 130);
  assert.equal(asset.use_count, 2);
});

test('发布登记任一步失败都会回滚日志、内容累计和资产更新', async () => {
  const contentId = insertApprovedContent(1, bossA.id, '可使用', '发布事务回滚');
  runWithTenant(1, () =>
    q.run(
      `INSERT INTO biz_assets(
    name,category,value,status,use_count,owner,source_type,source_id,creator_id,note
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      '事务回滚资产',
      '内容资产',
      100,
      '使用中',
      0,
      '内容生产仓',
      'content',
      contentId,
      bossA.id,
      '测试资产',
    ),
  );
  const triggerName = `test_fail_publish_asset_${contentId}`;
  db.exec(`CREATE TRIGGER ${triggerName}
    BEFORE UPDATE ON biz_assets
    WHEN OLD.tenant_id=1 AND OLD.source_type='content' AND OLD.source_id=${contentId}
    BEGIN SELECT RAISE(ABORT,'forced publish asset failure'); END`);
  try {
    await withServer(bossA, async base => {
      const failed = await request(base, `/content/${contentId}/publish-log`, {
        channel: '朋友圈',
        views: 50,
        leads: 2,
        idempotencyKey: publishKey(204),
      });
      assert.equal(failed.response.status, 500);
    });
  } finally {
    db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
  }

  const content = q.get(
    `SELECT status,channel,effect_views,effect_leads FROM contents
    WHERE tenant_id=1 AND id=?`,
    contentId,
  );
  assert.equal(content.status, '可使用');
  assert.equal(content.channel, null);
  assert.equal(content.effect_views, 0);
  assert.equal(content.effect_leads, 0);
  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM content_publish_logs
    WHERE tenant_id=1 AND content_id=?`,
      contentId,
    ).n,
    0,
  );
  const asset = q.get(
    `SELECT value,use_count FROM biz_assets WHERE tenant_id=1
    AND source_type='content' AND source_id=?`,
    contentId,
  );
  assert.equal(asset.value, 100);
  assert.equal(asset.use_count, 0);
});

test('删除已发布内容时发布日志一并进入回收站快照并从业务表移除', async () => {
  const contentId = insertApprovedContent(1, bossA.id, '可使用', '发布日志归档');
  await withServer(bossA, async base => {
    const published = await request(base, `/content/${contentId}/publish-log`, {
      channel: '短视频',
      views: 70,
      leads: 1,
      idempotencyKey: publishKey(205),
    });
    assert.equal(published.response.status, 200);
    const response = await fetch(`${base}/content/${contentId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: '测试发布日志归档' }),
    });
    assert.equal(response.status, 200);
  });

  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM content_publish_logs
    WHERE tenant_id=1 AND content_id=?`,
      contentId,
    ).n,
    0,
  );
  const archive = q.get(
    `SELECT child_snapshot FROM deleted_records
    WHERE tenant_id=1 AND entity_type='content' AND entity_id=? ORDER BY id DESC LIMIT 1`,
    contentId,
  );
  assert.ok(archive);
  const children = JSON.parse(archive.child_snapshot);
  assert.equal(children.content_publish_logs.length, 1);
  assert.equal(children.content_publish_logs[0].idempotency_key, publishKey(205));
});

after(() => {
  db.close();
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
});

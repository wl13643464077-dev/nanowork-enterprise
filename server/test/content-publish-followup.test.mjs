// 合规半自动分发（B6）：排期提醒幂等、publish-pack 结构、T+1/3/7 三次且回填后停止、
// metrics 写入与通知、权限、租户隔离。全程零外网、零自动发布。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';
import { xhsOutput } from './helpers/xhs-output-fixtures.mjs';

const DBP = path.join(os.tmpdir(), `nanowork-content-publish-followup-${process.pid}.db`);
await removeTempDbSafely(DBP, { closeDb: false });
process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = 'test';
process.env.SEED_DEMO = 'false';
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

globalThis.fetch = ((nativeFetch) => async (input, init) => {
  const url = String(input?.url || input || '');
  if (/^https?:\/\/127\.0\.0\.1(?::\d+)?\//u.test(url)) return nativeFetch(input, init);
  throw new Error(`测试环境禁止真实联网：${url}`);
})(globalThis.fetch);

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const contentRoutes = (await import('../src/routes/content.js')).default;
const followup = await import('../src/engines/content-publish-followup.js');
const { xhsVersionId } = await import('../src/engines/content-xhs-output.js');
const bus = await import('../src/engines/event-bus.js');

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'分发A店','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(2,'分发B店','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);

function insertUser(tenantId, username, name, role = 'boss') {
  const id = Number(
    q.run(
      `INSERT INTO users(username,password_hash,name,role,dept,status,tenant_id) VALUES(?,?,?,?,?,'启用',?)`,
      username,
      'x',
      name,
      role,
      role === 'boss' ? '老板办' : '内容部',
      tenantId,
    ).lastInsertRowid,
  );
  return { id, name, role, tenant_id: tenantId, username };
}

const bossA = insertUser(1, 'pf-boss-a', 'A店老板');
const staffA = insertUser(1, 'pf-staff-a', 'A店小编', 'sales');
const otherStaffA = insertUser(1, 'pf-staff-a2', 'A店别组小编', 'sales');
const bossB = insertUser(2, 'pf-boss-b', 'B店老板');

function insertContent(tenantId, creatorId, title, extras = {}) {
  return runWithTenant(tenantId, () =>
    Number(
      q.run(
        `INSERT INTO contents(
          type,title,body,topic,status,risk_flags,risk_level,ai_mode,creator_id,snapshot_json,source_type,channel,
          content_employee_idx
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        extras.type || '朋友圈文案',
        title,
        extras.body ?? `${title}正文 #探店 #火锅`,
        '分发助手',
        extras.status || '可使用',
        '[]',
        'none',
        extras.aiMode || 'manual',
        creatorId,
        extras.snapshot ? JSON.stringify(extras.snapshot) : null,
        extras.sourceType || null,
        extras.channel || null,
        extras.employeeIdx ?? null,
      ).lastInsertRowid,
    ),
  );
}

function approveContent(tenantId, contentId, reviewerId) {
  runWithTenant(tenantId, () =>
    q.run(
      `INSERT INTO approvals(
        target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,reviewer_id,decided_at
      ) VALUES('content',?,'人工采纳','人工采纳','none','[]','已通过',?,?,datetime('now','localtime'))`,
      contentId,
      reviewerId,
      reviewerId,
    ),
  );
}

function insertApprovedContent(tenantId, creatorId, title, extras = {}) {
  const id = insertContent(tenantId, creatorId, title, extras);
  approveContent(tenantId, id, creatorId);
  return id;
}

function insertPublishLog(tenantId, contentId, createdBy, { channel = '小红书', daysAgo = 0, publishedAt = null } = {}) {
  return runWithTenant(tenantId, () =>
    Number(
      q.run(
        `INSERT INTO content_publish_logs(content_id,channel,views,leads,idempotency_key,created_by,created_at)
        VALUES(?,?,0,0,?,?,COALESCE(?,datetime('now','localtime',?)))`,
        contentId,
        channel,
        `00000000-0000-4000-8000-${String(contentId).padStart(12, '0')}`,
        createdBy,
        publishedAt,
        `-${daysAgo} days`,
      ).lastInsertRowid,
    ),
  );
}

function notificationsFor(userId, pattern) {
  return q
    .all(`SELECT * FROM notifications WHERE user_id=? ORDER BY id`, userId)
    .filter(row => !pattern || pattern.test(`${row.title} ${row.body}`));
}

function followupRows(tenantId, contentId) {
  return q.all(
    `SELECT kind,day,notified_user_ids FROM content_publish_followups WHERE tenant_id=? AND content_id=? ORDER BY kind,day`,
    tenantId,
    contentId,
  );
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

async function call(base, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

const DAY_MS = 86_400_000;
const inHours = hours => new Date(Date.now() + hours * 3_600_000);

after(async () => {
  bus.resetEventBusForTests();
  await removeTempDbSafely(DBP);
});

test('排期：有权限者可设置/取消，非法时间与缺渠道被拒，越权 403，跨租户 404，未过交付门禁 409', async () => {
  const ownId = insertApprovedContent(1, staffA.id, '小编自己的排期内容');
  const bossOwnedId = insertApprovedContent(1, bossA.id, '老板的内容');
  const pendingId = insertContent(1, staffA.id, '待审核不能排期', { status: '待审核' });
  const tenantBId = insertApprovedContent(2, bossB.id, 'B店内容');
  const at = inHours(3).toISOString();

  await withServer(staffA, async base => {
    const ok = await call(base, 'PUT', `/content/${ownId}/schedule`, { scheduledAt: at, channel: ' 小红书 ' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.scheduledAt, at);
    assert.equal(ok.data.channel, '小红书');
    const row = q.get(`SELECT scheduled_publish_at,publish_channel FROM contents WHERE tenant_id=1 AND id=?`, ownId);
    assert.equal(row.scheduled_publish_at, at);
    assert.equal(row.publish_channel, '小红书');

    for (const body of [
      { scheduledAt: 'not-a-date', channel: '小红书' },
      { scheduledAt: new Date(Date.now() - DAY_MS).toISOString(), channel: '小红书' },
      { scheduledAt: new Date(Date.now() + 400 * DAY_MS).toISOString(), channel: '小红书' },
      { scheduledAt: at, channel: '' },
      { scheduledAt: at, channel: 'x'.repeat(41) },
      { scheduledAt: at },
    ]) {
      const bad = await call(base, 'PUT', `/content/${ownId}/schedule`, body);
      assert.equal(bad.status, 400, JSON.stringify(body));
    }
    assert.equal((await call(base, 'PUT', `/content/${bossOwnedId}/schedule`, { scheduledAt: at, channel: '小红书' })).status, 403);
    assert.equal((await call(base, 'PUT', `/content/${tenantBId}/schedule`, { scheduledAt: at, channel: '小红书' })).status, 404);
    const blocked = await call(base, 'PUT', `/content/${pendingId}/schedule`, { scheduledAt: at, channel: '小红书' });
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.code, /^DELIVERY_/u);

    const cleared = await call(base, 'PUT', `/content/${ownId}/schedule`, { scheduledAt: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.cleared, true);
    const after = q.get(`SELECT scheduled_publish_at,publish_channel FROM contents WHERE tenant_id=1 AND id=?`, ownId);
    assert.equal(after.scheduled_publish_at, null);
    assert.equal(after.publish_channel, null);
  });

  await withServer(bossA, async base => {
    const ok = await call(base, 'PUT', `/content/${ownId}/schedule`, { scheduledAt: at, channel: '抖音' });
    assert.equal(ok.status, 200, '老板对下属内容有编辑权限');
    assert.equal((await call(base, 'PUT', `/content/${ownId}/schedule`, { scheduledAt: null })).status, 200);
  });
});

const onlyIds = (list, ...ids) => list.filter(item => ids.includes(item.contentId));

test('排期到期提醒：给创建者发一次、幂等；重新排期后可再提醒；已登记发布不提醒；租户隔离', async () => {
  const contentId = insertApprovedContent(1, staffA.id, '周五探店小红书稿');
  const publishedId = insertApprovedContent(1, staffA.id, '已经发出去的稿');
  const tenantBId = insertApprovedContent(2, bossB.id, 'B店排期');
  const scheduledAt = inHours(1).toISOString();
  await withServer(staffA, async base => {
    assert.equal((await call(base, 'PUT', `/content/${contentId}/schedule`, { scheduledAt, channel: '小红书' })).status, 200);
    assert.equal((await call(base, 'PUT', `/content/${publishedId}/schedule`, { scheduledAt, channel: '小红书' })).status, 200);
  });
  await withServer(bossB, async base => {
    assert.equal((await call(base, 'PUT', `/content/${tenantBId}/schedule`, { scheduledAt, channel: '小红书' })).status, 200);
  });
  insertPublishLog(1, publishedId, staffA.id);

  const remind = now => onlyIds(
    runWithTenant(1, () => followup.runContentPublishScheduleReminders({ tenantId: 1, now })),
    contentId,
    publishedId,
  );
  assert.deepEqual(remind(new Date()), [], '未到期不提醒');

  const before = notificationsFor(staffA.id).length;
  const first = remind(inHours(2));
  assert.deepEqual(first.map(item => item.contentId), [contentId], '已登记发布的排期不再提醒');
  assert.deepEqual(first[0].recipients, [staffA.id]);
  const notices = notificationsFor(staffA.id, /该发到小红书了/u);
  assert.equal(notices.length, 1);
  assert.match(notices[0].title, /《周五探店小红书稿》该发到小红书了，点此复制文案/u);
  assert.equal(notices[0].link, `/content?publishAssistant=${contentId}&assistantTab=pack`);
  assert.equal(notices[0].type, 'content_publish');
  assert.equal(notificationsFor(staffA.id).length, before + 1);

  assert.deepEqual(remind(inHours(3)), [], '同一排期只提醒一次');
  assert.equal(notificationsFor(staffA.id, /该发到小红书了/u).length, 1);
  assert.deepEqual(
    followupRows(1, contentId).map(row => [row.kind, row.day]),
    [['schedule_due', 0]],
  );
  assert.deepEqual(followupRows(1, publishedId).map(row => row.kind), ['schedule_due'], '已发布的排期只记台账不发通知');
  assert.equal(notificationsFor(bossB.id).length, 0, 'A 店的 tick 不会碰 B 店');

  const tenantB = runWithTenant(2, () => followup.runContentPublishScheduleReminders({ tenantId: 2, now: inHours(2) }));
  assert.deepEqual(tenantB.map(item => item.contentId), [tenantBId]);
  assert.equal(notificationsFor(bossB.id, /该发到小红书了/u).length, 1);

  const rescheduled = inHours(5).toISOString();
  await withServer(staffA, async base => {
    assert.equal((await call(base, 'PUT', `/content/${contentId}/schedule`, { scheduledAt: rescheduled, channel: '抖音' })).status, 200);
  });
  assert.deepEqual(followupRows(1, contentId), [], '重新排期清掉旧台账');
  assert.deepEqual(remind(inHours(4)), []);
  const rerun = remind(inHours(6));
  assert.deepEqual(rerun.map(item => [item.contentId, item.channel]), [[contentId, '抖音']]);
  assert.equal(notificationsFor(staffA.id, /该发到抖音了/u).length, 1);
});

test('publish-pack：分发官产物按平台复用，正文兜底提取话题标签与素材图，取不到给 null；未采纳 409；跨租户 404', async () => {
  const distributorId = insertApprovedContent(1, staffA.id, '分发官发布包', {
    aiMode: 'api',
    employeeIdx: 8,
    body: '# 分发官岗位交付报告',
    snapshot: {
      contract: {
        status: 'valid',
        valid: true,
        parsedOutput: {
          publish_plan: '周五 18:00 小红书先发，周六抖音跟发。',
          versions: [
            {
              platform: '小红书',
              title: '这家火锅店的番茄锅底为什么排队',
              body: '正文A……',
              tags: ['探店', '#火锅', '番茄锅'],
              best_time: '待账号历史数据确认',
              checklist: ['封面用图1', '首评放地址'],
              note: '不要写“最好吃”。',
            },
            {
              platform: '抖音',
              title: '番茄锅底排队实录',
              body: '正文B……',
              tags: ['火锅'],
              best_time: '待账号历史数据确认',
              checklist: ['竖版封面', '挂门店 POI'],
              note: '口播避免绝对化用语。',
            },
          ],
        },
      },
      billing: { state: 'settled', chargedCredits: 3 },
    },
  });
  const plainId = insertApprovedContent(1, staffA.id, '手写朋友圈稿', {
    body: '今晚 7 点新品试吃，前 20 位到店送小菜。#新品试吃 #火锅 #探店，欢迎来玩 #火锅',
    channel: '朋友圈',
  });
  const materialId = runWithTenant(1, () =>
    Number(
      q.run(
        `INSERT INTO materials(name,type,tags,url,source_type,note) VALUES('门头图','产品图','[]','/uploads/1/door.png','manual','')`,
      ).lastInsertRowid,
    ),
  );
  const docMaterialId = runWithTenant(1, () =>
    Number(q.run(`INSERT INTO materials(name,type,tags,url,source_type,note) VALUES('菜单PDF','文档','[]','/uploads/1/menu.pdf','manual','')`).lastInsertRowid),
  );
  runWithTenant(1, () => {
    q.run(`INSERT INTO content_material_refs(target_type,target_id,material_id,created_by) VALUES('content',?,?,?)`, plainId, materialId, staffA.id);
    q.run(`INSERT INTO content_material_refs(target_type,target_id,material_id,created_by) VALUES('content',?,?,?)`, plainId, docMaterialId, staffA.id);
  });
  const pendingId = insertContent(1, staffA.id, '未采纳不能复制', { status: '待审核' });
  const tenantBId = insertApprovedContent(2, bossB.id, 'B店发布包');

  await withServer(staffA, async base => {
    const distributor = await call(base, 'GET', `/content/${distributorId}/publish-pack`);
    assert.equal(distributor.status, 200, JSON.stringify(distributor.data));
    assert.equal(distributor.data.source, 'distributor');
    assert.equal(distributor.data.packs.length, 2);
    const xhs = distributor.data.packs.find(pack => pack.platform === '小红书');
    assert.deepEqual(
      { platform: xhs.platform, title: xhs.title, body: xhs.body, hashtags: xhs.hashtags, firstComment: xhs.firstComment, images: xhs.images },
      {
        platform: '小红书',
        title: '这家火锅店的番茄锅底为什么排队',
        body: '正文A……',
        hashtags: ['探店', '火锅', '番茄锅'],
        firstComment: null,
        images: [],
      },
    );
    assert.deepEqual(xhs.checklist, ['封面用图1', '首评放地址']);
    assert.equal(xhs.bestTime, '待账号历史数据确认');
    assert.equal(xhs.copyText, '这家火锅店的番茄锅底为什么排队\n\n正文A……\n\n#探店 #火锅 #番茄锅');
    for (const pack of distributor.data.packs) {
      for (const key of ['platform', 'title', 'body', 'hashtags', 'firstComment', 'images']) {
        assert.ok(Object.hasOwn(pack, key), `发布包缺少 ${key}`);
      }
      assert.ok(Array.isArray(pack.hashtags) && Array.isArray(pack.images));
    }
    assert.match(distributor.data.disclaimer, /不代发/u);

    const plain = await call(base, 'GET', `/content/${plainId}/publish-pack`);
    assert.equal(plain.status, 200);
    assert.equal(plain.data.source, 'content');
    assert.equal(plain.data.packs.length, 1);
    const pack = plain.data.packs[0];
    assert.equal(pack.platform, '朋友圈', '无排期时用既有渠道');
    assert.equal(pack.title, '手写朋友圈稿');
    assert.deepEqual(pack.hashtags, ['新品试吃', '火锅', '探店'], '只提取正文里已有的标签并去重');
    assert.equal(pack.firstComment, null);
    assert.equal(pack.bestTime, null);
    assert.deepEqual(pack.images.map(image => [image.id, image.url]), [[materialId, '/uploads/1/door.png']], '文档素材不算配图');
    assert.match(pack.copyText, /^手写朋友圈稿\n\n今晚 7 点/u);

    const blocked = await call(base, 'GET', `/content/${pendingId}/publish-pack`);
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.code, /^DELIVERY_/u);
    assert.equal((await call(base, 'GET', `/content/${tenantBId}/publish-pack`)).status, 404);
  });
  await withServer(otherStaffA, async base => {
    assert.equal((await call(base, 'GET', `/content/${plainId}/publish-pack`)).status, 403, '同租户别组员工无权');
  });
  await withServer(bossA, async base => {
    const scheduled = await call(base, 'PUT', `/content/${plainId}/schedule`, { scheduledAt: inHours(2).toISOString(), channel: '小红书' });
    assert.equal(scheduled.status, 200);
    const pack = await call(base, 'GET', `/content/${plainId}/publish-pack`);
    assert.equal(pack.data.packs[0].platform, '小红书', '有排期时优先排期平台');
    assert.equal(pack.data.schedule.channel, '小红书');
  });
});

test('T+1/3/7 催复盘：各发一次给登记人与老板，幂等，停机补跑只发最高档，回填后停止，租户隔离', async () => {
  const contentId = insertApprovedContent(1, staffA.id, '发布后待复盘的稿');
  insertPublishLog(1, contentId, staffA.id, { channel: '小红书' });
  const publishedAt = Date.now();
  const at = days => new Date(publishedAt + days * DAY_MS + 60_000);
  const count = (userId, pattern) => notificationsFor(userId, pattern).length;
  // 前面用例留下的发布登记也会进入同一租户的催复盘；断言只看本用例的内容。
  const run = (now, ...ids) => onlyIds(runWithTenant(1, () => followup.runContentPublishFollowups({ tenantId: 1, now })), ...ids);

  assert.deepEqual(run(at(0.5), contentId), [], 'T+0.5 未到');

  const day1 = run(at(1), contentId);
  assert.deepEqual(day1.map(item => [item.contentId, item.day]), [[contentId, 1]]);
  assert.deepEqual(new Set(day1[0].recipients), new Set([staffA.id, bossA.id]), '登记人 + 老板');
  const staffNotice = notificationsFor(staffA.id, /《发布后待复盘的稿》发布已 1 天/u);
  assert.equal(staffNotice.length, 1);
  assert.match(staffNotice[0].title, /《发布后待复盘的稿》发布已 1 天，回填浏览\/点赞\/收藏数，复盘官才能帮你分析下一篇/u);
  assert.equal(staffNotice[0].link, `/content?publishAssistant=${contentId}&assistantTab=metrics`);
  assert.match(staffNotice[0].body, /不会自动扣费/u);
  assert.equal(count(bossA.id, /《发布后待复盘的稿》发布已 1 天/u), 1);

  assert.deepEqual(run(at(1.5), contentId), [], '同一档幂等');
  assert.deepEqual(run(at(2), contentId), [], 'T+2 无档');
  const day3 = run(at(3), contentId);
  assert.deepEqual(day3.map(item => item.day), [3]);
  assert.deepEqual(run(at(5), contentId), []);
  const day7 = run(at(7), contentId);
  assert.deepEqual(day7.map(item => item.day), [7]);
  assert.deepEqual(run(at(8), contentId), [], '三次都未回填则停止');
  assert.deepEqual(run(at(30), contentId), []);
  assert.deepEqual(followupRows(1, contentId).map(row => [row.kind, row.day]), [['followup', 1], ['followup', 3], ['followup', 7]]);
  assert.equal(count(staffA.id, /《发布后待复盘的稿》发布已 \d 天/u), 3);
  assert.equal(count(bossA.id, /《发布后待复盘的稿》发布已 \d 天/u), 3);

  // 停机补跑：3 天前发布、一次都没催过 → 只发 T+3 一条，T+1 只补台账
  const lateId = insertApprovedContent(1, staffA.id, '调度器停机期间发布的稿');
  insertPublishLog(1, lateId, staffA.id, { daysAgo: 3 });
  const catchUp = run(new Date(Date.now() + 60_000), lateId);
  assert.deepEqual(catchUp.map(item => [item.contentId, item.day]), [[lateId, 3]]);
  assert.deepEqual(followupRows(1, lateId).map(row => [row.day, JSON.parse(row.notified_user_ids).length > 0]), [[1, false], [3, true]]);
  assert.equal(count(staffA.id, /调度器停机期间发布的稿》发布已 3 天/u), 1);
  assert.equal(count(staffA.id, /调度器停机期间发布的稿》发布已 1 天/u), 0);

  // 回填后停止：T+1 催过一次，回填后 T+3/T+7 不再催
  const filledId = insertApprovedContent(1, staffA.id, '回填后停止的稿');
  insertPublishLog(1, filledId, staffA.id, { daysAgo: 1 });
  const filledDay1 = run(new Date(Date.now() + 60_000), filledId);
  assert.deepEqual(filledDay1.map(item => [item.contentId, item.day]), [[filledId, 1]]);
  await withServer(staffA, async base => {
    const filled = await call(base, 'POST', `/content/${filledId}/metrics`, { views: 1200, likes: 88, saves: 40 });
    assert.equal(filled.status, 200, JSON.stringify(filled.data));
  });
  assert.deepEqual(run(new Date(Date.now() + 8 * DAY_MS), filledId), [], '已回填的内容不再催');
  assert.deepEqual(followupRows(1, filledId).map(row => row.day), [1]);

  // 超过 14 天窗口的旧发布不补催（功能上线不给历史发布刷屏）
  const oldId = insertApprovedContent(1, staffA.id, '一个月前发布的旧稿');
  insertPublishLog(1, oldId, staffA.id, { daysAgo: 30 });
  assert.deepEqual(run(new Date(), oldId), []);
  assert.deepEqual(followupRows(1, oldId), []);

  // 租户隔离：B 店老板收不到 A 店催复盘；B 店 tick 只看 B 店
  assert.equal(count(bossB.id, /发布已/u), 0);
  const tenantBId = insertApprovedContent(2, bossB.id, 'B店已发布稿');
  insertPublishLog(2, tenantBId, bossB.id, { daysAgo: 1 });
  const tenantB = runWithTenant(2, () => followup.runContentPublishFollowups({ tenantId: 2, now: new Date(Date.now() + 60_000) }));
  assert.deepEqual(tenantB.map(item => [item.contentId, item.day]), [[tenantBId, 1]]);
  assert.deepEqual(tenantB[0].recipients, [bossB.id]);
  assert.equal(count(staffA.id, /B店已发布稿/u), 0);
  assert.equal(count(bossA.id, /B店已发布稿/u), 0);
});

test('metrics 回填：写入 content_publish_metrics（manual_unverified）并通知老板可派复盘官；校验、权限、租户隔离', async () => {
  const contentId = insertApprovedContent(1, staffA.id, '回填数据的稿');
  const unpublishedId = insertApprovedContent(1, staffA.id, '还没登记发布的稿');
  const bossOwnedId = insertApprovedContent(1, bossA.id, '老板自己的稿');
  const tenantBId = insertApprovedContent(2, bossB.id, 'B店的稿');
  const logId = insertPublishLog(1, contentId, staffA.id, { channel: '小红书' });
  insertPublishLog(1, bossOwnedId, bossA.id);
  const screenshotId = runWithTenant(1, () =>
    Number(
      q.run(
        `INSERT INTO uploaded_files(user_id,name,stored_name,ext,mime,size,purpose,file_path,file_url)
        VALUES(?,'数据截图.png','shot.png','png','image/png',10,'publish_metrics','/tmp/shot.png','/uploads/1/shot.png')`,
        staffA.id,
      ).lastInsertRowid,
    ),
  );
  const pdfId = runWithTenant(1, () =>
    Number(
      q.run(
        `INSERT INTO uploaded_files(user_id,name,stored_name,ext,mime,size,purpose,file_path,file_url)
        VALUES(?,'不是截图.pdf','x.pdf','pdf','application/pdf',10,'chat','/tmp/x.pdf','/uploads/1/x.pdf')`,
        staffA.id,
      ).lastInsertRowid,
    ),
  );

  await withServer(staffA, async base => {
    const noLog = await call(base, 'POST', `/content/${unpublishedId}/metrics`, { views: 10 });
    assert.equal(noLog.status, 409);
    assert.equal(noLog.data.code, 'CONTENT_PUBLISH_LOG_REQUIRED');

    for (const body of [
      {},
      { note: '只有备注' },
      { views: -1 },
      { views: 1.5 },
      { views: '100' },
      { likes: 1_000_000_001 },
      { views: 1, screenshotFileId: 'abc' },
      { views: 1, screenshotFileId: pdfId },
    ]) {
      const bad = await call(base, 'POST', `/content/${contentId}/metrics`, body);
      assert.equal(bad.status, 400, JSON.stringify(body));
    }
    assert.equal((await call(base, 'POST', `/content/${contentId}/metrics`, { views: 1, screenshotFileId: 999_999 })).status, 404);
    assert.equal((await call(base, 'POST', `/content/${bossOwnedId}/metrics`, { views: 1 })).status, 403);
    assert.equal((await call(base, 'POST', `/content/${tenantBId}/metrics`, { views: 1 })).status, 404);

    const bossBefore = notificationsFor(bossA.id, /可派复盘官分析/u).length;
    const staffBefore = notificationsFor(staffA.id, /可派复盘官分析/u).length;
    const ok = await call(base, 'POST', `/content/${contentId}/metrics`, {
      views: 3200,
      likes: 150,
      saves: 60,
      comments: 12,
      screenshotFileId: screenshotId,
      note: '  截图取自小红书创作中心  ',
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.verification, 'manual_unverified');
    assert.equal(ok.data.publishLogId, logId);
    assert.deepEqual(ok.data.recipients, [bossA.id], '通知老板，不给自己发');
    const row = q.get(`SELECT * FROM content_publish_metrics WHERE tenant_id=1 AND id=?`, ok.data.metricId);
    assert.equal(row.content_id, contentId);
    assert.equal(row.publish_log_id, logId);
    assert.equal(row.channel, '小红书');
    assert.deepEqual(
      [row.views, row.likes, row.saves, row.comments, row.orders],
      [3200, 150, 60, 12, null],
      '未填的 orders 保持 null，不补 0',
    );
    assert.equal(row.screenshot_file_id, screenshotId);
    assert.equal(row.note, '截图取自小红书创作中心');
    assert.equal(row.verification, 'manual_unverified');
    assert.equal(row.created_by, staffA.id);
    const notice = notificationsFor(bossA.id, /可派复盘官分析/u);
    assert.equal(notice.length, bossBefore + 1);
    assert.match(notice.at(-1).title, /《回填数据的稿》已回填发布数据，可派复盘官分析/u);
    assert.match(notice.at(-1).body, /views=3200，likes=150，saves=60，comments=12（附数据截图）/u);
    assert.match(notice.at(-1).body, /不会自动扣费/u);
    assert.equal(notice.at(-1).link, `/content?publishAssistant=${contentId}&assistantTab=timeline`);
    assert.equal(notificationsFor(staffA.id, /可派复盘官分析/u).length, staffBefore);
    assert.equal(
      q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=1`)?.n ?? 0,
      0,
      '回填不触发任何扣费',
    );

    const state = await call(base, 'GET', `/content/${contentId}/publish-assistant`);
    assert.equal(state.status, 200);
    assert.equal(state.data.metricsFilled, true);
    assert.equal(state.data.metrics.length, 1);
    assert.equal(state.data.publishLogs.length, 1);
    assert.ok(state.data.publishedAt);
    assert.deepEqual(state.data.followupTimeline.map(item => [item.day, item.status]), [[1, 'stopped'], [3, 'stopped'], [7, 'stopped']]);
    assert.ok(state.data.followupTimeline.every(item => typeof item.dueAt === 'string'));

    const notPublished = await call(base, 'GET', `/content/${unpublishedId}/publish-assistant`);
    assert.deepEqual(notPublished.data.followupTimeline.map(item => item.status), ['waiting_publish', 'waiting_publish', 'waiting_publish']);
    assert.equal(notPublished.data.publishedAt, null);
    assert.equal((await call(base, 'GET', `/content/${tenantBId}/publish-assistant`)).status, 404);
    assert.equal((await call(base, 'GET', `/content/${bossOwnedId}/publish-assistant`)).status, 403);
  });

  await withServer(bossA, async base => {
    const own = await call(base, 'POST', `/content/${bossOwnedId}/metrics`, { orders: 3 });
    assert.equal(own.status, 200);
    assert.deepEqual(own.data.recipients, [bossA.id], '只有自己时才通知自己');
  });
  assert.equal(q.get(`SELECT COUNT(*) n FROM content_publish_metrics WHERE tenant_id=2`).n, 0, 'B 店无回填记录');
});

test('已发布内容删除时，催复盘台账与回填数据一并进入回收站快照', async () => {
  const contentId = insertApprovedContent(1, bossA.id, '删除时归档的稿');
  insertPublishLog(1, contentId, bossA.id, { daysAgo: 1 });
  runWithTenant(1, () => followup.runContentPublishFollowups({ tenantId: 1, now: new Date(Date.now() + 60_000) }));
  await withServer(bossA, async base => {
    assert.equal((await call(base, 'POST', `/content/${contentId}/metrics`, { views: 5 })).status, 200);
    const removed = await call(base, 'DELETE', `/content/${contentId}`, { reason: '测试归档' });
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
  });
  assert.equal(q.get(`SELECT COUNT(*) n FROM content_publish_followups WHERE tenant_id=1 AND content_id=?`, contentId).n, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM content_publish_metrics WHERE tenant_id=1 AND content_id=?`, contentId).n, 0);
  const archive = q.get(
    `SELECT child_snapshot FROM deleted_records WHERE tenant_id=1 AND entity_type='content' AND entity_id=? ORDER BY id DESC LIMIT 1`,
    contentId,
  );
  const children = JSON.parse(archive.child_snapshot);
  assert.equal(children.content_publish_followups.length, 1);
  assert.equal(children.content_publish_metrics.length, 1);
});

test('调度器：每日 10:00 上海时钟 runOnce(publish_followup:<date>) 幂等；排期提醒每 tick 检查', async () => {
  const { runScheduledJobs } = await import('../src/engines/scheduler.js');
  const contentId = insertApprovedContent(1, bossA.id, '调度器催复盘的稿');
  insertPublishLog(1, contentId, bossA.id, { publishedAt: '2026-09-02 10:00:00' });
  const scheduledId = insertApprovedContent(1, bossA.id, '调度器排期提醒的稿');
  runWithTenant(1, () =>
    q.run(`UPDATE contents SET scheduled_publish_at=?,publish_channel='小红书' WHERE tenant_id=1 AND id=?`, '2026-09-10T01:59:00.000Z', scheduledId),
  );
  // 2026-09-10 10:00 上海 = 02:00Z；用未来日期确保 job_key 不与其他用例冲突
  const tenAm = new Date('2026-09-10T02:00:00Z');
  const first = runScheduledJobs(tenAm, { contentAutomationRunner: async () => null });
  await first.pending;
  assert.equal(first.clock.hour, '10');
  assert.equal(first.clock.minute, '00');
  const tenantA = first.results.find(item => item.tenantId === 1);
  assert.equal(tenantA.publishFollowup, true, JSON.stringify(tenantA));
  assert.ok(tenantA.publishScheduleReminders >= 1, '到期排期在 tick 内提醒');
  assert.ok(q.get(`SELECT 1 FROM scheduled_runs WHERE tenant_id=1 AND job_key='publish_followup:2026-09-10'`));
  assert.equal(notificationsFor(bossA.id, /《调度器催复盘的稿》发布已 7 天/u).length, 1, '2026-09-10 距发布已超 7 天，只发最高档');
  assert.equal(notificationsFor(bossA.id, /《调度器排期提醒的稿》该发到小红书了/u).length, 1);

  const second = runScheduledJobs(new Date('2026-09-10T02:00:30Z'), { contentAutomationRunner: async () => null });
  await second.pending;
  const tenantAgain = second.results.find(item => item.tenantId === 1);
  assert.equal(tenantAgain.publishFollowup, false, '同一天不重复跑');
  assert.equal(tenantAgain.publishScheduleReminders, 0, '排期提醒幂等');
  const offHour = runScheduledJobs(new Date('2026-09-11T03:00:00Z'), { contentAutomationRunner: async () => null });
  await offHour.pending;
  assert.equal(offHour.results.find(item => item.tenantId === 1).publishFollowup, false, '非 10:00 不触发');
});

test('催复盘窗口使用调度传入时钟，不引用电脑当前日期或未来发布', () => {
  const expired = insertApprovedContent(1, bossA.id, '固定时钟过期稿');
  const future = insertApprovedContent(1, bossA.id, '固定时钟未来稿');
  const due = insertApprovedContent(1, bossA.id, '固定时钟应提醒稿');
  insertPublishLog(1, expired, bossA.id, { publishedAt: '2031-01-01 10:00:00' });
  insertPublishLog(1, future, bossA.id, { publishedAt: '2031-01-21 10:00:00' });
  insertPublishLog(1, due, bossA.id, { publishedAt: '2031-01-12 10:00:00' });
  const sent = followup.runContentPublishFollowups({ tenantId: 1, now: new Date('2031-01-20T02:00:00Z') });
  assert.ok(sent.some(item => item.contentId === due && item.day === 7));
  assert.ok(!sent.some(item => item.contentId === expired || item.contentId === future));
});

test('纯函数：话题标签提取去重、到期档位计算', () => {
  assert.deepEqual(followup.extractHashtags('a #探店 b #火锅，c #探店 #新品试吃。'), ['探店', '火锅', '新品试吃']);
  assert.deepEqual(followup.extractHashtags(''), []);
  const base = new Date('2026-09-01T02:00:00Z');
  assert.deepEqual(followup.followupDaysDue(base, new Date('2026-09-01T20:00:00Z')), []);
  assert.deepEqual(followup.followupDaysDue(base, new Date('2026-09-02T02:00:00Z')), [1]);
  assert.deepEqual(followup.followupDaysDue(base, new Date('2026-09-04T03:00:00Z')), [1, 3]);
  assert.deepEqual(followup.followupDaysDue(base, new Date('2026-10-01T00:00:00Z')), [1, 3, 7]);
  assert.deepEqual(followup.followupDaysDue('bad', new Date()), []);
  assert.equal(followup.parseDbLocalTime('2026-09-01 10:00:00') instanceof Date, true);
  assert.equal(followup.parseDbLocalTime(null), null);
});

test('M5 发布冻结所选版本，回填绑定同渠道日志且不被后续快照改写', async () => {
  const output = xhsOutput();
  const selected = output.versions[1];
  const versionId = xhsVersionId(selected);
  const contentId = insertApprovedContent(1, staffA.id, '选版发布归因', {
    employeeIdx: 3,
    snapshot: { xhsOutput: output, xhsSelection: { versionId, strategy: selected.strategy } },
  });
  await withServer(staffA, async base => {
    const published = await call(base, 'POST', `/content/${contentId}/publish-log`, {
      channel: '小红书', views: 0, leads: 0, idempotencyKey: '00000000-0000-4000-8000-100000000001',
    });
    assert.equal(published.status, 200, JSON.stringify(published.data));
    const log = q.get('SELECT * FROM content_publish_logs WHERE tenant_id=1 AND id=?', published.data.logId);
    assert.equal(JSON.parse(log.attribution_json).versionId, versionId);
    assert.equal(JSON.parse(log.attribution_json).strategy, selected.strategy);
    assert.equal(JSON.parse(log.attribution_json).employeeIdx, 3);
    // 另一渠道有更晚的记录，不能拿它作为小红书回填的来源。
    const otherLog = insertPublishLog(1, contentId, staffA.id, { channel: '视频号' });
    assert.notEqual(otherLog, published.data.logId);
    const filled = await call(base, 'POST', `/content/${contentId}/metrics`, {
      channel: '小红书', views: 1000, likes: 20, saves: 50,
      attribution: { versionId: 'client-forged', strategy: 'client-forged' },
    });
    assert.equal(filled.status, 200, JSON.stringify(filled.data));
    assert.equal(filled.data.publishLogId, published.data.logId);
    const metric = q.get('SELECT * FROM content_publish_metrics WHERE tenant_id=1 AND id=?', filled.data.metricId);
    assert.equal(metric.attribution_json, log.attribution_json);
    assert.equal((await call(base, 'POST', `/content/${contentId}/metrics`, { channel: '抖音', views: 3 })).status, 409);
    // 冻结证据不受内容快照变更影响（此处模拟修复/导入工具修改，而非允许用户发布后换版）。
    q.run('UPDATE contents SET snapshot_json=?,content_employee_idx=4 WHERE tenant_id=1 AND id=?', JSON.stringify({ xhsOutput: output, xhsSelection: { versionId: xhsVersionId(output.versions[0]) } }), contentId);
    const second = await call(base, 'POST', `/content/${contentId}/metrics`, { channel: '小红书', views: 2000, saves: 80 });
    assert.equal(second.status, 200);
    const stats = followup.contentStrategyMetricsSummary(1, { employeeIdx: 3 });
    const row = stats.find(item => item.strategy === selected.strategy && item.channel === '小红书');
    assert.equal(row.contents, 1);
    assert.equal(row.avgSaveRate, 4);
    assert.deepEqual(row.versionIds, [versionId]);
    const state = await call(base, 'GET', `/content/${contentId}/publish-assistant`);
    assert.equal(state.data.metrics[0].attribution.versionId, versionId);
    assert.equal(state.data.publishLogs[0].attribution.versionId, versionId);
  });
});

test('M5 旧发布记录没有版本证据时保持未知，不能按现在的选版补归因', async () => {
  const output = xhsOutput();
  const id = insertApprovedContent(1, staffA.id, '旧发布未知版本', {
    employeeIdx: 3, snapshot: { xhsOutput: output, xhsSelection: { versionId: xhsVersionId(output.versions[0]) } },
  });
  insertPublishLog(1, id, staffA.id);
  await withServer(staffA, async base => {
    const filled = await call(base, 'POST', `/content/${id}/metrics`, { views: 100, saves: 99 });
    assert.equal(filled.status, 200);
    const state = await call(base, 'GET', `/content/${id}/publish-assistant`);
    assert.equal(state.data.metrics[0].attribution.versionId, null);
    assert.equal(state.data.metrics[0].attribution.source, 'legacy_unknown');
  });
});

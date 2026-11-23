import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import express from "express";

const DBP = path.join(
  os.tmpdir(),
  `nanowork-daily-digest-restaurant-${process.pid}.db`,
);
for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try {
    fs.rmSync(f, { force: true });
  } catch {
    /* ignore */
  }
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";

const { initSchema, migrateV2, q, qRaw, runWithTenant } = await import(
  "../src/db.js"
);
const { hashPassword, daysAgo } = await import("../src/util.js");
const { buildDailyDigest } = await import("../src/engines/daily-digest.js");
const { storeScope } = await import("../src/engines/store-scope.js");
const dashboardRoutes = (await import("../src/routes/dashboard.js")).default;

initSchema();
migrateV2();

// 创建三个独立租户用于验证严格多租户隔离
const tenantA = Number(
  qRaw.run(
    `INSERT INTO tenants(name,status) VALUES(?,?)`,
    "川味小馆A",
    "已开通",
  ).lastInsertRowid,
);
const tenantB = Number(
  qRaw.run(
    `INSERT INTO tenants(name,status) VALUES(?,?)`,
    "粤味茶楼B",
    "已开通",
  ).lastInsertRowid,
);
const tenantEmpty = Number(
  qRaw.run(
    `INSERT INTO tenants(name,status) VALUES(?,?)`,
    "空数据新店C",
    "已开通",
  ).lastInsertRowid,
);

function createUser(tenantId, username, name, role, storeId = null) {
  const id = Number(
    qRaw.run(
      `INSERT INTO users(username,password_hash,name,role,dept,status,tenant_id,store_id)
       VALUES(?,?,?,?,?,'启用',?,?)`,
      username,
      hashPassword("123456"),
      name,
      role,
      "门店",
      tenantId,
      storeId,
    ).lastInsertRowid,
  );
  return { id, username, name, role, tenant_id: tenantId, store_id: storeId };
}

function createStore(tenantId, name, isDefault = 0) {
  return Number(
    qRaw.run(
      `INSERT INTO stores(tenant_id,name,is_default,biz_type,status) VALUES(?,?,?,'正餐','营业中')`,
      tenantId,
      name,
      isDefault,
    ).lastInsertRowid,
  );
}

const storeA1 = createStore(tenantA, "A总店", 1);
const storeA2 = createStore(tenantA, "A分店", 0);
const storeB1 = createStore(tenantB, "B总店", 1);

const bossA = createUser(tenantA, "boss_a", "A店老板", "boss");
const opsA = createUser(tenantA, "ops_a", "A店运营", "ops_director");
const salesA = createUser(tenantA, "sales_a", "A店店员", "sales", storeA1);
const storeMgrA1 = createUser(tenantA, "mgr_a1", "A总店店长", "manager", storeA1);

const bossB = createUser(tenantB, "boss_b", "B店老板", "boss");
const bossEmpty = createUser(tenantEmpty, "boss_empty", "C店老板", "boss");

async function withUserServer(user, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    runWithTenant(user.tenant_id, () => storeScope(req, res, next));
  });
  app.use("/dashboard", dashboardRoutes);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const yesterday = daysAgo(1);
const prevDay2 = daysAgo(2);
const prevDay3 = daysAgo(3);

// === 为租户 A 造真实餐饮数据：营收下滑 + 待复差评 + 未闭环巡店整改 + 超期跟进 ===
runWithTenant(tenantA, () => {
  // 前 7 日高营收（avg7 = 10000），昨日低营收（4000 -> deltaPct = -60%）
  q.run(
    `INSERT INTO daily_ops(date,deal_amount,orders,new_leads,store_id) VALUES(?,?,?,?,?)`,
    prevDay2,
    10000,
    40,
    10,
    storeA1,
  );
  q.run(
    `INSERT INTO daily_ops(date,deal_amount,orders,new_leads,store_id) VALUES(?,?,?,?,?)`,
    prevDay3,
    10000,
    40,
    10,
    storeA1,
  );
  q.run(
    `INSERT INTO daily_ops(date,deal_amount,orders,new_leads,store_id) VALUES(?,?,?,?,?)`,
    yesterday,
    4000,
    18,
    4,
    storeA1,
  );

  // store_reviews：
  // 2 条近 7 日待复差评（rating <= 2, reply 为空/空白），分别属于 A总店 与 A分店
  q.run(
    `INSERT INTO store_reviews(tenant_id,platform,rating,content,store_name,store_id,status,reply,created_at)
     VALUES(?,?,?,?,?,?,?,?,datetime('now','localtime','-1 days'))`,
    tenantA,
    "美团",
    1,
    "上菜太慢了，等了四十分钟",
    "A总店",
    storeA1,
    "待回复",
    null,
  );
  q.run(
    `INSERT INTO store_reviews(tenant_id,platform,rating,content,store_name,store_id,status,reply,created_at)
     VALUES(?,?,?,?,?,?,?,?,datetime('now','localtime','-2 days'))`,
    tenantA,
    "大众点评",
    2,
    "汤底偏咸，体验一般",
    "A分店",
    storeA2,
    "待回复",
    "   ",
  );
  // 干扰项 1：已回复差评（不应计入）
  q.run(
    `INSERT INTO store_reviews(tenant_id,platform,rating,content,store_name,store_id,status,reply,created_at)
     VALUES(?,?,?,?,?,?,?,?,datetime('now','localtime','-1 days'))`,
    tenantA,
    "美团",
    1,
    "已妥善处理的差评",
    "A总店",
    storeA1,
    "已回复",
    "非常抱歉，已联系您补发优惠券",
  );
  // 干扰项 2：超过 7 天的旧差评（不应计入）
  q.run(
    `INSERT INTO store_reviews(tenant_id,platform,rating,content,store_name,store_id,status,reply,created_at)
     VALUES(?,?,?,?,?,?,?,?,datetime('now','localtime','-10 days'))`,
    tenantA,
    "美团",
    1,
    "十天前的旧差评",
    "A总店",
    storeA1,
    "待回复",
    null,
  );
  // 干扰项 3：4 星好评（不应计入）
  q.run(
    `INSERT INTO store_reviews(tenant_id,platform,rating,content,store_name,store_id,status,reply,created_at)
     VALUES(?,?,?,?,?,?,?,?,datetime('now','localtime','-1 days'))`,
    tenantA,
    "大众点评",
    4,
    "味道不错",
    "A总店",
    storeA1,
    "待回复",
    null,
  );

  // store_inspection_rectifications：
  // 2 条未闭环（in_progress / 待整改），分别在 A总店 与 A分店
  q.run(
    `INSERT INTO store_inspection_rectifications(
      tenant_id,inspection_id,issue_index,store_name,store_id,board,severity,problem,status
    ) VALUES(?,?,?,?,?,?,?,?,?)`,
    tenantA,
    101,
    0,
    "A总店",
    storeA1,
    "后厨食安",
    "高",
    "冷柜温度记录缺失",
    "in_progress",
  );
  q.run(
    `INSERT INTO store_inspection_rectifications(
      tenant_id,inspection_id,issue_index,store_name,store_id,board,severity,problem,status
    ) VALUES(?,?,?,?,?,?,?,?,?)`,
    tenantA,
    102,
    0,
    "A分店",
    storeA2,
    "前厅服务",
    "中",
    "明档台面清洁不到位",
    "待整改",
  );
  // 干扰项：已通过 / closed 的整改单（不应计入）
  q.run(
    `INSERT INTO store_inspection_rectifications(
      tenant_id,inspection_id,issue_index,store_name,store_id,board,severity,problem,status
    ) VALUES(?,?,?,?,?,?,?,?,?)`,
    tenantA,
    101,
    1,
    "A总店",
    storeA1,
    "后厨食安",
    "中",
    "已通过复检的项",
    "已通过",
  );
  q.run(
    `INSERT INTO store_inspection_rectifications(
      tenant_id,inspection_id,issue_index,store_name,store_id,board,severity,problem,status
    ) VALUES(?,?,?,?,?,?,?,?,?)`,
    tenantA,
    101,
    2,
    "A总店",
    storeA1,
    "后厨食安",
    "低",
    "已关闭的项",
    "closed",
  );

  // 超期跟进客户 1 位
  q.run(
    `INSERT INTO leads(name,source,stage,owner_id,next_follow_at)
     VALUES(?,?,?,?,datetime('now','localtime','-2 days'))`,
    "团餐老客户王先生",
    "大众点评",
    "已沟通",
    salesA.id,
  );
});

// === 为租户 B 造隔离数据：无昨日营收，但有 3 条待复差评 + 1 条未闭环巡店整改 ===
runWithTenant(tenantB, () => {
  for (let i = 0; i < 3; i += 1) {
    q.run(
      `INSERT INTO store_reviews(tenant_id,platform,rating,content,store_name,store_id,status,reply,created_at)
       VALUES(?,?,?,?,?,?,?,?,datetime('now','localtime','-1 days'))`,
      tenantB,
      "饿了么",
      2,
      `租户B差评${i + 1}`,
      "B总店",
      storeB1,
      "待回复",
      null,
    );
  }
  q.run(
    `INSERT INTO store_inspection_rectifications(
      tenant_id,inspection_id,issue_index,store_name,store_id,board,severity,problem,status
    ) VALUES(?,?,?,?,?,?,?,?,?)`,
    tenantB,
    201,
    0,
    "B总店",
    storeB1,
    "后厨食安",
    "高",
    "租户B整改项",
    "in_progress",
  );
});

after(() => {
  for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
});

test("餐饮每日简报正确汇总营收、待复差评、未闭环整改、超期跟进并推荐对应数字员工", () => {
  const digest = runWithTenant(tenantA, () => buildDailyDigest(yesterday));
  assert.ok(digest, "应生成每日经营简报");
  assert.equal(digest.date, yesterday);
  assert.equal(digest.amount, 4000);
  assert.equal(digest.orders, 18);
  assert.equal(digest.avg7, 10000);
  assert.equal(digest.deltaPct, -60);
  assert.equal(digest.source, "daily_ops");
  assert.equal(digest.pendingBadReviews, 2);
  assert.equal(digest.openRectifications, 2);
  assert.equal(digest.overdueFollows, 1);

  const empLabels = digest.recommendedEmployees.map((e) => e.label);
  assert.ok(empLabels.includes("#143 潘口碑"), "有待复差评应推荐 #143 潘口碑");
  assert.ok(empLabels.includes("#161 查巡巡"), "有未闭环巡店整改应推荐 #161 查巡巡");
  assert.ok(empLabels.includes("#144 葛会员"), "有超期跟进应推荐 #144 葛会员");
  assert.ok(empLabels.includes("#160 店小满"), "营收下滑应推荐 #160 店小满");

  assert.match(digest.text, /【昨日】/);
  assert.match(digest.text, /【门店异常】/);
  assert.match(digest.text, /【归因】/);
  assert.match(digest.text, /【建议】/);
  assert.match(digest.text, /待复差评 2 条/);
  assert.match(digest.text, /未闭环巡店整改 2 项/);
});

test("跨租户严格隔离不串数；无营收但存在差评或整改时允许生成简报；全空租户返回 null", () => {
  // 租户 B 无营收，但有 3 条待复差评与 1 条未闭环整改，且不受租户 A 数据干扰
  const digestB = runWithTenant(tenantB, () => buildDailyDigest(yesterday));
  assert.ok(digestB, "无营收但有门店异常时仍应生成简报");
  assert.equal(digestB.amount, 0);
  assert.equal(digestB.orders, 0);
  assert.equal(digestB.pendingBadReviews, 3);
  assert.equal(digestB.openRectifications, 1);
  assert.equal(digestB.overdueFollows, 0);
  const labelsB = digestB.recommendedEmployees.map((e) => e.label);
  assert.deepEqual(labelsB, ["#143 潘口碑", "#161 查巡巡"]);

  // 门店范围隔离：A总店店长仅统计 storeA1 的 1 条待复差评与 1 条未闭环整改
  const digestStoreA1 = runWithTenant(tenantA, () =>
    buildDailyDigest(yesterday, { user: storeMgrA1 }),
  );
  assert.ok(digestStoreA1);
  assert.equal(digestStoreA1.pendingBadReviews, 1);
  assert.equal(digestStoreA1.openRectifications, 1);

  // 完全空白租户 C：无营收、无历史、无差评、无整改 -> 返回 null
  const digestC = runWithTenant(tenantEmpty, () => buildDailyDigest(yesterday));
  assert.equal(digestC, null);
});

test("非管理层调用预览/立即推送返回 403；管理层预览与手动发送成功写入本租户通知且不跨租户", async () => {
  // 普通员工调用 /daily-digest/send 和 /daily-digest/preview 均返回 403
  await withUserServer(salesA, async (base) => {
    const sendRes = await fetch(`${base}/dashboard/daily-digest/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(sendRes.status, 403);

    const previewRes = await fetch(`${base}/dashboard/daily-digest/preview`);
    assert.equal(previewRes.status, 403);
  });

  // 店长 (manager) 不在 preview/send 放行名单内，返回 403
  await withUserServer(storeMgrA1, async (base) => {
    const sendRes = await fetch(`${base}/dashboard/daily-digest/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(sendRes.status, 403);
  });

  // 空数据租户老板预览返回 digest: null
  await withUserServer(bossEmpty, async (base) => {
    const res = await fetch(`${base}/dashboard/daily-digest/preview`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.digest, null);
    assert.equal(typeof data.feishuReady, "boolean");
  });

  // 租户 A 老板预览与手动发送
  await withUserServer(bossA, async (base) => {
    const previewRes = await fetch(
      `${base}/dashboard/daily-digest/preview?date=${yesterday}`,
    );
    assert.equal(previewRes.status, 200);
    const previewData = await previewRes.json();
    assert.ok(previewData.digest);
    assert.equal(previewData.digest.pendingBadReviews, 2);
    assert.equal(previewData.digest.openRectifications, 2);
    assert.equal(typeof previewData.feishuReady, "boolean");

    const sendRes = await fetch(`${base}/dashboard/daily-digest/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: yesterday }),
    });
    assert.equal(sendRes.status, 200);
    const sendData = await sendRes.json();
    assert.equal(sendData.ok, true);
    assert.equal(sendData.skipped, false);
    assert.equal(sendData.notified, 2); // bossA + opsA
    assert.equal(sendData.digest.pendingBadReviews, 2);
  });

  // 验证站内通知仅写入租户 A 管理层（bossA, opsA），未写入 salesA 或租户 B 的 bossB
  const notifsA = runWithTenant(tenantA, () =>
    q.all(
      `SELECT user_id, title, body FROM notifications WHERE tenant_id = ?`,
      tenantA,
    ),
  );
  const notifiedIdsA = notifsA.map((r) => Number(r.user_id)).sort((a, b) => a - b);
  assert.deepEqual(
    notifiedIdsA,
    [bossA.id, opsA.id].sort((a, b) => a - b),
  );
  assert.match(notifsA[0].title, new RegExp(`每日经营日报 · ${yesterday}`));
  assert.match(notifsA[0].body, /【门店异常】/);

  const notifsB = runWithTenant(tenantB, () =>
    q.all(`SELECT user_id FROM notifications WHERE tenant_id = ?`, tenantB),
  );
  assert.equal(notifsB.length, 0, "租户 A 发送简报绝不得写入租户 B 的通知表");
  assert.ok(bossB.id > 0);
});

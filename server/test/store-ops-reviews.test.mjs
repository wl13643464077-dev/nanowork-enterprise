import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import express from "express";

process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
const DBP = path.join(os.tmpdir(), `nw-store-ops-${process.pid}-${Date.now()}.db`);
process.env.NANOWORK_DB = DBP;

const { db, q, initSchema, migrateV2, runWithTenant } = await import("../src/db.js");
const { default: storeOpsRouter } = await import("../src/routes/store-ops.js");
const { default: reviewsRouter } = await import("../src/routes/reviews.js");

initSchema();
migrateV2();

q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'门店日常验收企业','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET credits=excluded.credits`);
const bossId = Number(
  q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
     VALUES('sop-boss','x','日常老板','boss','启用',1)`,
  ).lastInsertRowid,
);
const staffId = Number(
  q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
     VALUES('sop-staff','x','日常员工','sales','启用',1)`,
  ).lastInsertRowid,
);
const storeId = Number(
  q.run(`INSERT INTO stores(tenant_id,name,status) VALUES(1,'验收一号店','营业中')`).lastInsertRowid,
);
const dishId = Number(
  q.run(
    `INSERT INTO dishes(tenant_id,store_id,name,category,price,status)
     VALUES(1,?,'招牌烧鹅','热菜',68,'在售')`,
    storeId,
  ).lastInsertRowid,
);

function makeApp(role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    runWithTenant(1, () => {
      req.user =
        role === "boss"
          ? { id: bossId, name: "日常老板", role: "boss", tenant_id: 1 }
          : { id: staffId, name: "日常员工", role: "sales", tenant_id: 1 };
      next();
    });
  });
  app.use("/store-ops", storeOpsRouter);
  app.use("/reviews", reviewsRouter);
  return app;
}

async function withServer(role, fn) {
  const server = makeApp(role).listen(0, "127.0.0.1");
  const port = await new Promise((resolve) => server.once("listening", () => resolve(server.address().port)));
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const jsonCall = async (base, method, pathName, body) => {
  const response = await fetch(`${base}${pathName}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, payload: await response.json() };
};

after(() => {
  try {
    db.close();
  } catch {
    /* closed */
  }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
});

test("日清：勾选留痕（谁在几点勾的）、取消勾选、完成数统计", async () => {
  await withServer("staff", async (base) => {
    const before = await jsonCall(base, "GET", "/store-ops/checklists/today");
    assert.equal(before.status, 200);
    assert.equal(before.payload.checklists.length, 6, "六类日清清单");
    assert.equal(before.payload.done, 0);

    const toggled = await jsonCall(base, "POST", "/store-ops/checklists/opening/toggle", { itemKey: "power" });
    assert.equal(toggled.status, 200);
    assert.equal(toggled.payload.done, true);
    assert.equal(toggled.payload.doneBy, "日常员工");

    const afterMark = await jsonCall(base, "GET", "/store-ops/checklists/today");
    const opening = afterMark.payload.checklists.find((list) => list.key === "opening");
    const item = opening.items.find((entry) => entry.key === "power");
    assert.equal(item.done, true);
    assert.equal(item.doneBy, "日常员工");
    assert.equal(afterMark.payload.done, 1);

    const untoggled = await jsonCall(base, "POST", "/store-ops/checklists/opening/toggle", { itemKey: "power" });
    assert.equal(untoggled.payload.done, false);

    const bad = await jsonCall(base, "POST", "/store-ops/checklists/opening/toggle", { itemKey: "nope" });
    assert.equal(bad.status, 400);
  });
});

test("沽清板：标记沽清→列表可见→恢复供应", async () => {
  await withServer("staff", async (base) => {
    const first = await jsonCall(base, "POST", `/store-ops/soldout/${dishId}/toggle`);
    assert.equal(first.status, 200);
    assert.equal(first.payload.soldout, true);

    const board = await jsonCall(base, "GET", "/store-ops/soldout/today");
    const dish = board.payload.dishes.find((row) => row.id === dishId);
    assert.equal(dish.soldout, true);
    assert.equal(dish.markedBy, "日常员工");
    assert.equal(board.payload.soldoutCount, 1);

    const second = await jsonCall(base, "POST", `/store-ops/soldout/${dishId}/toggle`);
    assert.equal(second.payload.soldout, false);
  });
});

test("排班：店长可排班、员工越权403、周表带回班次", async () => {
  const monday = (() => {
    const now = new Date();
    const day = now.getDay() || 7;
    now.setDate(now.getDate() - day + 1);
    return now.toLocaleDateString("sv-SE"); // 本地时区口径，与后端 weekDates 一致
  })();
  await withServer("staff", async (base) => {
    const denied = await jsonCall(base, "PUT", "/store-ops/shifts/assign", {
      userId: staffId,
      date: monday,
      shiftKey: "morning",
    });
    assert.equal(denied.status, 403);
  });
  await withServer("boss", async (base) => {
    const ok = await jsonCall(base, "PUT", "/store-ops/shifts/assign", {
      userId: staffId,
      date: monday,
      shiftKey: "morning",
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.payload));
    const week = await jsonCall(base, "GET", "/store-ops/shifts/week");
    assert.equal(week.payload.canSchedule, true);
    const assignment = week.payload.assignments.find((row) => row.user_id === staffId && row.date === monday);
    assert.equal(assignment.shift_key, "morning");
  });
});

test("考勤：上班打卡→重复打卡409→下班打卡闭环→重复下班卡409", async () => {
  await withServer("staff", async (base) => {
    const clockIn = await jsonCall(base, "POST", "/store-ops/attendance/clock", { direction: "in" });
    assert.equal(clockIn.status, 200);
    const repeat = await jsonCall(base, "POST", "/store-ops/attendance/clock", { direction: "in" });
    assert.equal(repeat.status, 409);
    const clockOut = await jsonCall(base, "POST", "/store-ops/attendance/clock", { direction: "out" });
    assert.equal(clockOut.status, 200);
    // 考勤是工时依据：下班卡以第一次为准，重复打卡不允许无感覆盖
    const repeatOut = await jsonCall(base, "POST", "/store-ops/attendance/clock", { direction: "out" });
    assert.equal(repeatOut.status, 409);
    const mine = await jsonCall(base, "GET", "/store-ops/attendance/mine");
    assert.ok(mine.payload.today.clock_in);
    assert.ok(mine.payload.today.clock_out);
  });
});

test("库存台账：建档→出库超量拦截→盘点修正→订货建议按缺口", async () => {
  await withServer("staff", async (base) => {
    const created = await jsonCall(base, "POST", "/store-ops/inventory", {
      name: "烧鹅胚",
      category: "肉类",
      unit: "只",
      quantity: 10,
      safeLine: 8,
    });
    assert.equal(created.status, 200, JSON.stringify(created.payload));
    const itemId = created.payload.id;

    const overdraw = await jsonCall(base, "POST", `/store-ops/inventory/${itemId}/move`, {
      reason: "出库",
      value: 99,
    });
    assert.equal(overdraw.status, 400, "出库不能超过库存");

    const out = await jsonCall(base, "POST", `/store-ops/inventory/${itemId}/move`, {
      reason: "出库",
      value: 6,
    });
    assert.equal(out.payload.quantity, 4);

    const audit = await jsonCall(base, "POST", `/store-ops/inventory/${itemId}/move`, {
      reason: "盘点修正",
      value: 5,
    });
    assert.equal(audit.payload.quantity, 5);

    const list = await jsonCall(base, "GET", "/store-ops/inventory");
    assert.equal(list.payload.lowCount, 1, "5 只低于安全线 8 只");

    const reorder = await jsonCall(base, "GET", "/store-ops/inventory/reorder");
    assert.equal(reorder.payload.items[0].gap, 3, "缺口 = 安全线 - 现有");

    const moves = q.all("SELECT reason, delta FROM inventory_moves WHERE tenant_id=1 AND item_id=?", itemId);
    assert.equal(moves.length, 3, "入库+出库+盘点全留痕");
  });
});

test("外卖日报：按天按平台 upsert，近7天汇总正确", async () => {
  await withServer("staff", async (base) => {
    const todayStr = new Date().toLocaleDateString("sv-SE");
    const first = await jsonCall(base, "POST", "/store-ops/delivery-daily", {
      platform: "美团",
      date: todayStr,
      orders: 40,
      revenue: 2000,
      rating: 4.6,
      avgPrepMinutes: 22,
      badReviews: 1,
    });
    assert.equal(first.status, 200);
    // 同日同平台重录 = 覆盖更新，不重复计数
    await jsonCall(base, "POST", "/store-ops/delivery-daily", {
      platform: "美团",
      date: todayStr,
      orders: 45,
      revenue: 2300,
      rating: 4.7,
      badReviews: 0,
    });
    const board = await jsonCall(base, "GET", "/store-ops/delivery-daily");
    assert.equal(board.payload.summary.weekOrders, 45);
    assert.equal(board.payload.summary.weekRevenue, 2300);
    assert.equal(board.payload.summary.weekBadReviews, 0);
    assert.equal(board.payload.rows.length, 1);
  });
});

test("生日关怀：近7天生日客户命中，AI 祝福真实结算", async () => {
  const now = new Date();
  const inThreeDays = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3);
  const birthday = `${String(inThreeDays.getMonth() + 1).padStart(2, "0")}-${String(inThreeDays.getDate()).padStart(2, "0")}`;
  const farAway = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 60);
  const farBirthday = `${String(farAway.getMonth() + 1).padStart(2, "0")}-${String(farAway.getDate()).padStart(2, "0")}`;
  const leadId = Number(
    q.run(
      `INSERT INTO leads(tenant_id,name,stage,birthday,owner_id) VALUES(1,'寿星客户','已到店',?,?)`,
      birthday,
      bossId,
    ).lastInsertRowid,
  );
  q.run(
    `INSERT INTO leads(tenant_id,name,stage,birthday,owner_id) VALUES(1,'远期客户','已到店',?,?)`,
    farBirthday,
    bossId,
  );
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "寿星客户，生日快乐！记得您上次说想试我们的烧鹅，生日当月来店里，给您留只最靓的，再送碗长寿面，等您来。",
            },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 60 },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.YUNWU_API_KEY = "test-birthday-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  try {
    const { default: growthRouter } = await import("../src/routes/growth.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      runWithTenant(1, () => {
        req.user = { id: bossId, name: "日常老板", role: "boss", tenant_id: 1 };
        next();
      });
    });
    app.use("/growth", growthRouter);
    const server = app.listen(0, "127.0.0.1");
    const port = await new Promise((resolve) => server.once("listening", () => resolve(server.address().port)));
    const base = `http://127.0.0.1:${port}`;
    try {
      const list = await jsonCall(base, "GET", "/growth/birthdays?days=7");
      assert.equal(list.status, 200, JSON.stringify(list.payload));
      const names = list.payload.customers.map((row) => row.name);
      assert.ok(names.includes("寿星客户"), "3天后生日应命中");
      assert.ok(!names.includes("远期客户"), "60天后不应命中");
      const hit = list.payload.customers.find((row) => row.name === "寿星客户");
      assert.equal(hit.inDays, 3);

      const wish = await jsonCall(base, "POST", `/growth/birthdays/${leadId}/wish`, {});
      assert.equal(wish.status, 200, JSON.stringify(wish.payload));
      assert.match(wish.payload.wish, /生日快乐/u);
      assert.equal(wish.payload.billing.state, "settled");
      assert.match(wish.payload.boundary, /不代替对外发送/u);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("评价深化：自动归因/被点名菜品统计/超24小时SLA预警", async () => {
  await withServer("boss", async (base) => {
    // 自动归因：按关键词打主因标签
    const slow = await jsonCall(base, "POST", "/reviews", {
      platform: "美团",
      rating: 2,
      content: "等了一个小时都没上齐，催了三次",
    });
    assert.equal(slow.payload.category, "出餐慢");
    const taste = await jsonCall(base, "POST", "/reviews", {
      platform: "大众点评",
      rating: 3,
      content: "招牌烧鹅太咸了，分量也变少了",
    });
    assert.equal(taste.payload.category, "口味出品");

    // 被点名的菜：差评正文含菜品名「招牌烧鹅」
    const insights = await jsonCall(base, "GET", "/reviews/insights");
    assert.ok(insights.payload.categories.length >= 2);
    const mentioned = insights.payload.mentionedDishes.find((item) => item.name === "招牌烧鹅");
    assert.ok(mentioned && mentioned.count >= 1, "差评点名的菜要被统计");

    // 人工修正归因
    const recat = await jsonCall(base, "PUT", `/reviews/${taste.payload.id}/category`, { category: "服务态度" });
    assert.equal(recat.status, 200);

    // SLA：把一条差评的创建时间拨回 25 小时前 → 超时预警
    q.run(
      `UPDATE store_reviews SET created_at=datetime('now','localtime','-25 hours') WHERE tenant_id=1 AND id=?`,
      slow.payload.id,
    );
    const summary = await jsonCall(base, "GET", "/reviews/summary");
    assert.ok(summary.payload.slaOverdue >= 1, "超24小时未回差评必须进预警");
    const list = await jsonCall(base, "GET", "/reviews?bad=1");
    const slowRow = list.payload.rows.find((row) => row.id === slow.payload.id);
    assert.equal(slowRow.slaOverdue, true);
    assert.equal(list.payload.rows[0].id, slow.payload.id, "超时差评置顶");
    // 清理，避免影响后续统计断言
    q.run("DELETE FROM store_reviews WHERE tenant_id=1");
  });
});

test("评价中心：录入/导入去重/AI回复真实结算/确认回复/差评预警统计", async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "非常抱歉让您等了四十分钟，高峰期出餐调度确实没跟上。我们已经加派了晚市出餐口专人核对，本周内改排产顺序。欢迎您再来验证，这餐算我们请您。",
            },
          },
        ],
        usage: { prompt_tokens: 200, completion_tokens: 80 },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.YUNWU_API_KEY = "test-review-reply-key";
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  try {
    await withServer("boss", async (base) => {
      const created = await jsonCall(base, "POST", "/reviews", {
        platform: "美团",
        rating: 2,
        content: "等了四十分钟才上菜，烧鹅都凉了",
        author: "顾客A",
        reviewDate: "2026-08-27",
      });
      assert.equal(created.status, 200, JSON.stringify(created.payload));
      const reviewId = created.payload.id;

      const imported = await jsonCall(base, "POST", "/reviews/import", {
        rows: [
          { platform: "美团", rating: 2, content: "等了四十分钟才上菜，烧鹅都凉了", reviewDate: "2026-08-27" },
          { platform: "大众点评", rating: 5, content: "烧鹅皮脆肉嫩，值得二刷", author: "顾客B" },
          { platform: "美团", rating: 9, content: "非法评分行" },
        ],
      });
      assert.equal(imported.payload.imported, 1, "重复行与非法行都不写入");
      assert.equal(imported.payload.failures.length, 2);

      const summaryBefore = await jsonCall(base, "GET", "/reviews/summary");
      assert.equal(summaryBefore.payload.pendingBad, 1);
      assert.equal(summaryBefore.payload.total, 2);

      const ai = await jsonCall(base, "POST", `/reviews/${reviewId}/ai-reply`, {});
      assert.equal(ai.status, 200, JSON.stringify(ai.payload));
      assert.match(ai.payload.draft, /抱歉/u);
      assert.equal(ai.payload.billing.state, "settled");
      assert.ok(ai.payload.billing.chargedCredits > 0);
      assert.match(ai.payload.boundary, /不会代替你对外发布/u);

      const saved = await jsonCall(base, "PUT", `/reviews/${reviewId}/reply`, {
        reply: ai.payload.draft,
        status: "已回复",
      });
      assert.equal(saved.status, 200);

      const summaryAfter = await jsonCall(base, "GET", "/reviews/summary");
      assert.equal(summaryAfter.payload.pendingBad, 0, "回复后差评预警清零");

      const badList = await jsonCall(base, "GET", "/reviews?bad=1");
      assert.equal(badList.payload.rows[0].status, "已回复");
      assert.ok(badList.payload.rows[0].replied_at);
    });
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("多端幂等：toggle 带目标态时与现状一致则 no-op，不互相翻转", async () => {
  await withServer("staff", async (base) => {
    // 日清：两台设备都提交 done=true，第二次不应把第一次的勾翻掉
    const first = await jsonCall(base, "POST", "/store-ops/checklists/closing/toggle", { itemKey: "gas", done: true });
    assert.equal(first.payload.done, true);
    const second = await jsonCall(base, "POST", "/store-ops/checklists/closing/toggle", { itemKey: "gas", done: true });
    assert.equal(second.payload.done, true, "重复提交同一目标态不能变成取消");
    assert.equal(second.payload.unchanged, true);
    await jsonCall(base, "POST", "/store-ops/checklists/closing/toggle", { itemKey: "gas", done: false });

    // 沽清：重复提交 soldout=true 不追加日志行
    await jsonCall(base, "POST", `/store-ops/soldout/${dishId}/toggle`, { soldout: true });
    const marksBefore = q.get("SELECT COUNT(*) n FROM dish_soldout_marks WHERE tenant_id=1 AND dish_id=?", dishId).n;
    const dup = await jsonCall(base, "POST", `/store-ops/soldout/${dishId}/toggle`, { soldout: true });
    assert.equal(dup.payload.soldout, true);
    assert.equal(dup.payload.unchanged, true);
    const marksAfter = q.get("SELECT COUNT(*) n FROM dish_soldout_marks WHERE tenant_id=1 AND dish_id=?", dishId).n;
    assert.equal(marksAfter, marksBefore, "no-op 不追加标记行");
    await jsonCall(base, "POST", `/store-ops/soldout/${dishId}/toggle`, { soldout: false });
  });
});

test("台账删除权限：员工删库存/删评价403，管理层可删", async () => {
  const itemId = Number(
    q.run(
      `INSERT INTO inventory_items(tenant_id,name,unit,quantity,safe_line) VALUES(1,'权限验证物料','件',5,2)`,
    ).lastInsertRowid,
  );
  const reviewId = Number(
    q.run(
      `INSERT INTO store_reviews(tenant_id,platform,rating,content,created_by) VALUES(1,'美团',1,'权限验证差评',?)`,
      bossId,
    ).lastInsertRowid,
  );
  await withServer("staff", async (base) => {
    const delItem = await jsonCall(base, "DELETE", `/store-ops/inventory/${itemId}`);
    assert.equal(delItem.status, 403, "员工不能物理删除库存台账");
    const delReview = await jsonCall(base, "DELETE", `/reviews/${reviewId}`);
    assert.equal(delReview.status, 403, "员工不能无痕销毁差评");
  });
  await withServer("boss", async (base) => {
    const delItem = await jsonCall(base, "DELETE", `/store-ops/inventory/${itemId}`);
    assert.equal(delItem.status, 200);
    const delReview = await jsonCall(base, "DELETE", `/reviews/${reviewId}`);
    assert.equal(delReview.status, 200);
  });
});

test("评价录入防重：同平台同日期同内容二次录入409；宽松日期规范化", async () => {
  await withServer("boss", async (base) => {
    const first = await jsonCall(base, "POST", "/reviews", {
      platform: "抖音",
      rating: 4,
      content: "环境不错，烧鹅略咸",
      reviewDate: "2026/8/20",
    });
    assert.equal(first.status, 200);
    const stored = q.get("SELECT review_date FROM store_reviews WHERE tenant_id=1 AND id=?", first.payload.id);
    assert.equal(stored.review_date, "2026-08-20", "斜杠日期要规范化为 ISO");

    const dup = await jsonCall(base, "POST", "/reviews", {
      platform: "抖音",
      rating: 4,
      content: "环境不错，烧鹅略咸",
      reviewDate: "2026-08-20",
    });
    assert.equal(dup.status, 409, "双击提交/重复录入必须拦截");

    const oversized = await jsonCall(base, "POST", "/reviews/import", {
      rows: Array.from({ length: 501 }, (_, index) => ({ platform: "美团", rating: 5, content: `批量${index}` })),
    });
    assert.equal(oversized.status, 400, "超过 500 行拒绝而不是静默截断");
    assert.match(oversized.payload.error, /501/u);
    q.run("DELETE FROM store_reviews WHERE tenant_id=1 AND id=?", first.payload.id);
  });
});

test("SLA 起算：带评价日期的旧差评导入后立即报超时，不再宽限24小时", async () => {
  await withServer("boss", async (base) => {
    const yesterday = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 2);
      return d.toLocaleDateString("sv-SE");
    })();
    const imported = await jsonCall(base, "POST", "/reviews/import", {
      rows: [{ platform: "美团", rating: 1, content: "平台上挂了两天没人回的差评", reviewDate: yesterday }],
    });
    assert.equal(imported.payload.imported, 1);
    const summary = await jsonCall(base, "GET", "/reviews/summary");
    assert.ok(summary.payload.slaOverdue >= 1, "评价日期在昨天之前 → 刚导入也算超时");
    const list = await jsonCall(base, "GET", "/reviews?bad=1");
    const row = list.payload.rows.find((item) => item.content.includes("挂了两天"));
    assert.equal(row.slaOverdue, true);
    q.run("DELETE FROM store_reviews WHERE tenant_id=1 AND content LIKE '%挂了两天%'");
  });
});

test("沽清口径：中途恢复供应的日子不算沽清日（按当日最后一条判定）", async () => {
  const dish2 = Number(
    q.run(
      `INSERT INTO dishes(tenant_id,store_id,name,category,price,status) VALUES(1,?,'口径验证菜','热菜',30,'在售')`,
      storeId,
    ).lastInsertRowid,
  );
  const dayStr = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    return d.toLocaleDateString("sv-SE");
  };
  // 近 3 天每天：先标沽清、后恢复供应（最后一条 soldout=0）→ 不该算沽清日
  for (const offset of [1, 2, 3]) {
    q.run(
      `INSERT INTO dish_soldout_marks(tenant_id,date,dish_id,soldout,marked_by,marked_by_name) VALUES(1,?,?,1,?,'日常员工')`,
      dayStr(offset),
      dish2,
      staffId,
    );
    q.run(
      `INSERT INTO dish_soldout_marks(tenant_id,date,dish_id,soldout,marked_by,marked_by_name) VALUES(1,?,?,0,?,'日常员工')`,
      dayStr(offset),
      dish2,
      staffId,
    );
  }
  await withServer("staff", async (base) => {
    const board = await jsonCall(base, "GET", "/store-ops/soldout/today");
    const warned = (board.payload.frequentSoldout || []).find((item) => item.name === "口径验证菜");
    assert.equal(warned, undefined, "每天都恢复了供应，不该进备货预警");
  });
  // 改为收盘态沽清（最后一条 soldout=1）→ 应进预警
  for (const offset of [1, 2, 3]) {
    q.run(
      `INSERT INTO dish_soldout_marks(tenant_id,date,dish_id,soldout,marked_by,marked_by_name) VALUES(1,?,?,1,?,'日常员工')`,
      dayStr(offset),
      dish2,
      staffId,
    );
  }
  await withServer("staff", async (base) => {
    const board = await jsonCall(base, "GET", "/store-ops/soldout/today");
    const warned = (board.payload.frequentSoldout || []).find((item) => item.name === "口径验证菜");
    assert.ok(warned && warned.days >= 3, "收盘仍沽清的 3 天必须进备货预警");
  });
  q.run("DELETE FROM dish_soldout_marks WHERE tenant_id=1 AND dish_id=?", dish2);
  q.run("DELETE FROM dishes WHERE tenant_id=1 AND id=?", dish2);
});

test("下架菜不能标沽清；外卖日报非法日期400不再静默改写为今天", async () => {
  const retired = Number(
    q.run(
      `INSERT INTO dishes(tenant_id,store_id,name,category,price,status) VALUES(1,?,'已下架菜','热菜',20,'下架')`,
      storeId,
    ).lastInsertRowid,
  );
  await withServer("staff", async (base) => {
    const mark = await jsonCall(base, "POST", `/store-ops/soldout/${retired}/toggle`, { soldout: true });
    assert.equal(mark.status, 400, "下架菜标沽清会产生不可见脏数据，必须拒绝");

    const badDate = await jsonCall(base, "POST", "/store-ops/delivery-daily", {
      platform: "美团",
      date: "2026/8/27",
      orders: 10,
      revenue: 500,
    });
    assert.equal(badDate.status, 400, "非法日期静默回退今天会覆盖今天的真实数据");
    assert.match(badDate.payload.error, /YYYY-MM-DD/u);
  });
  q.run("DELETE FROM dishes WHERE tenant_id=1 AND id=?", retired);
});

test("生日规范化与上报校验：中文生日可被雷达命中，daily-report 夹紧到999整数", async () => {
  const { default: growthRouter } = await import("../src/routes/growth.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    runWithTenant(1, () => {
      req.user = { id: bossId, name: "日常老板", role: "boss", tenant_id: 1 };
      next();
    });
  });
  app.use("/growth", growthRouter);
  const server = app.listen(0, "127.0.0.1");
  const port = await new Promise((resolve) => server.once("listening", () => resolve(server.address().port)));
  const base = `http://127.0.0.1:${port}`;
  try {
    const soon = new Date();
    soon.setDate(soon.getDate() + 2);
    const created = await jsonCall(base, "POST", "/growth/leads", {
      name: "中文生日客户",
      birthday: `${soon.getMonth() + 1}月${soon.getDate()}日`,
    });
    assert.equal(created.status, 200, JSON.stringify(created.payload));
    const storedBirthday = q.get("SELECT birthday FROM leads WHERE tenant_id=1 AND name='中文生日客户'").birthday;
    assert.match(storedBirthday, /^\d{2}-\d{2}$/u, "「5月12日」要规范化成 MM-DD");
    const radar = await jsonCall(base, "GET", "/growth/birthdays?days=7");
    assert.ok(
      radar.payload.customers.some((row) => row.name === "中文生日客户"),
      "中文格式登记的生日必须能被雷达命中",
    );

    const report = await jsonCall(base, "POST", "/growth/daily-report", { new_leads: 999999.7 });
    assert.equal(report.status, 200);
    const ops = q.get("SELECT new_leads FROM daily_ops WHERE tenant_id=1 ORDER BY date DESC LIMIT 1");
    assert.equal(ops.new_leads, 999, "越界数字必须夹紧到 999 整数，不能污染驾驶舱");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    q.run("DELETE FROM leads WHERE tenant_id=1 AND name='中文生日客户'");
  }
});

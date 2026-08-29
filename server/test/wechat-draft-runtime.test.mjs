import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import test, { after, before } from "node:test";

const dbPath = path.join(
  os.tmpdir(),
  `nanowork-wechat-draft-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"])
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
process.env.NANOWORK_DB = dbPath;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

const { db, initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const {
  createWechatDraftService,
  createWechatDefaultCover,
  createWechatImageProcessor,
  listWechatDraftSources,
  listWechatDraftThemes,
  OfficialWechatDraftProvider,
  publicWechatConfig,
  renderWechatDraftHtml,
  saveWechatConfig,
  selectWechatDraftCover,
  WechatProviderError,
  WECHAT_DRAFT_MARKER_PREFIX,
} = await import("../src/engines/wechat-draft.js");
const { createWechatDraftRouter } =
  await import("../src/routes/wechat-draft.js");
const { findHoldByRef, holdCredits, releaseHold, settleHold } =
  await import("../src/engines/credits.js");
const { createSqliteContentProductionPipelineRepository } =
  await import("../src/engines/content-production-pipeline.js");
const { getUnifiedTaskDetail } = await import("../src/engines/task-center.js");

let tenantA;
let tenantB;
let userA;
let userB;
let imageA;
let imageB;
const createdPaths = [];
const uploadRoot = fileURLToPath(new URL("../data/uploads/", import.meta.url));

function unique(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

function createManualContent(user, title) {
  return runWithTenant(user.tenant_id, () =>
    Number(
      q.run(
        `INSERT INTO contents(
      type,title,body,status,ai_mode,creator_id,source_type,snapshot_json,created_at
    ) VALUES('公众号长文',?,?,'可使用','manual',?,'manual','{}',datetime('now','localtime'))`,
        title,
        `${title}正文。\n\n这是经过人工确认的租户内可交付内容，用于验证微信草稿投递闭环。`,
        user.id,
      ).lastInsertRowid,
    ),
  );
}

function createImage(user, name, suppliedBytes = null) {
  const directory = path.resolve(
    uploadRoot,
    String(user.tenant_id),
    "wechat-test",
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const storedName = `${unique("wechat")}.jpg`;
  const absolute = path.join(directory, storedName);
  const bytes =
    suppliedBytes ||
    Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from("JFIF\0nanowork-wechat-fixture"),
    ]);
  fs.writeFileSync(absolute, bytes, { mode: 0o600 });
  createdPaths.push(absolute);
  return runWithTenant(user.tenant_id, () =>
    Number(
      q.run(
        `INSERT INTO uploaded_files(
      tenant_id,user_id,name,stored_name,ext,mime,size,purpose,file_path,file_url
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        user.tenant_id,
        user.id,
        name,
        storedName,
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? "png"
          : "jpg",
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? "image/png"
          : "image/jpeg",
        bytes.length,
        "wechat-test",
        absolute,
        `/uploads/files/${user.tenant_id}/wechat-test/${storedName}`,
      ).lastInsertRowid,
    ),
  );
}

function settledPipelineBilling(user, pipelineId, stationIdx = 8) {
  const hold = holdCredits({
    userId: user.id,
    tenantId: user.tenant_id,
    feature: "内容团队流水线·分发官",
    kind: "text",
    model: "deepseek-v4-flash",
    credits: 10,
    refType: "content_production_pipeline_station",
    refId: pipelineId * 10 + stationIdx + 1,
    note: "微信草稿测试的真实流水线工位预授权",
  });
  const settled = settleHold(hold, {
    usage: { inputTokens: 800, outputTokens: 300 },
    model: "deepseek-v4-flash",
    aiMode: "api",
    note: "分发官真实 token 用量结算",
  });
  return {
    state: "settled",
    holdId: hold.holdId,
    estimatedCredits: hold.credits,
    heldCredits: 0,
    chargedCredits: settled.credits,
    credits: settled.credits,
    pendingReconciliation: false,
  };
}

function createPipelineProviderMaterial({
  user,
  pipelineId,
  stationIdx,
  name,
  bytes,
  billingRefType,
  billingRefId,
}) {
  const mimeType = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : "image/jpeg";
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  return runWithTenant(user.tenant_id, () =>
    Number(
      q.run(
        `INSERT INTO materials(
      tenant_id,name,type,tags,url,source_type,source_id,creator_id,note,
      body_snapshot,artifact_snapshot_json,snapshot_hash
    ) VALUES(?,?,'图片','[]',NULL,'content_pipeline_provider',?,?,?, ?,?,?)`,
        user.tenant_id,
        name,
        pipelineId,
        user.id,
        "公众号草稿测试的已固化 provider 图片",
        `data:${mimeType};base64,${bytes.toString("base64")}`,
        JSON.stringify({
          schemaVersion: "nanowork.content-pipeline-provider-artifact/2",
          kind: "image",
          employeeIdx: stationIdx,
          pipelineId,
          mimeType,
          byteSize: bytes.length,
          contentSha256: hash,
          billingRefType,
          billingRefId,
        }),
        hash,
      ).lastInsertRowid,
    ),
  );
}

function pipelineBillingWithProvider({
  user,
  pipelineId,
  stationIdx,
  materialId,
}) {
  const stationText = settledPipelineBilling(user, pipelineId, stationIdx);
  const refType = "content_special_provider";
  const refId = pipelineId * 100 + stationIdx + 1;
  const hold = holdCredits({
    userId: user.id,
    tenantId: user.tenant_id,
    feature: `内容团队流水线·工位${stationIdx} provider`,
    kind: "image",
    model: "offline-provider-double",
    credits: 3,
    refType,
    refId,
    note: "provider图片预授权",
  });
  const settled = settleHold(hold, {
    credits: 2,
    model: "offline-provider-double",
    aiMode: "api",
    note: "provider图片固定价结算",
  });
  const provider = {
    attemptId: `pipeline:${pipelineId}:station:${stationIdx}:provider:image`,
    kind: "image",
    status: "settled",
    refType,
    refId,
    holdId: hold.holdId,
    billing: {
      state: "settled",
      holdId: hold.holdId,
      estimatedCredits: hold.credits,
      heldCredits: 0,
      chargedCredits: settled.credits,
      credits: settled.credits,
      pendingReconciliation: false,
    },
    delivery: { persisted: true, artifactIds: [`material:${materialId}`] },
  };
  return {
    billingRefType: refType,
    billingRefId: refId,
    evidence: {
      ...stationText,
      chargedCredits: stationText.chargedCredits + settled.credits,
      credits: stationText.chargedCredits + settled.credits,
      components: { stationText, specialProviders: [provider] },
    },
  };
}

function decodeGeneratedPng(bytes) {
  assert.ok(
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  );
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return { width, height, raw: zlib.inflateSync(Buffer.concat(idat)) };
}

class ProviderDouble {
  constructor(mode = "success") {
    this.mode = mode;
    this.addCalls = 0;
    this.findCalls = 0;
    this.imageCalls = 0;
    this.coverCalls = 0;
    this.findMediaId = "";
    this.articles = [];
    this.imageBytes = [];
    this.coverBytes = [];
    this.credentialAppIds = [];
  }

  remember(credentials) {
    this.credentialAppIds.push(credentials.appId);
  }

  async testConnection({ credentials }) {
    this.remember(credentials);
    return { ok: true };
  }

  async uploadContentImage({ credentials, bytes }) {
    this.remember(credentials);
    this.imageCalls += 1;
    this.imageBytes.push(Buffer.from(bytes));
    return { url: `https://mmbiz.qpic.cn/test/content-${this.imageCalls}.jpg` };
  }

  async uploadCover({ credentials, bytes }) {
    this.remember(credentials);
    this.coverCalls += 1;
    this.coverBytes.push(Buffer.from(bytes));
    return { mediaId: `cover-${this.coverCalls}` };
  }

  async addDraft({ credentials, article }) {
    this.remember(credentials);
    this.addCalls += 1;
    this.articles.push(article);
    if (this.mode === "reject") {
      throw new WechatProviderError("该公众号没有草稿箱接口权限（48001）", {
        code: "WECHAT_48001",
        status: 400,
        definitive: true,
      });
    }
    if (this.mode === "timeout") {
      throw new WechatProviderError("微信 API 请求结果不确定", {
        code: "WECHAT_TIMEOUT",
        status: 503,
        definitive: false,
      });
    }
    return { mediaId: `draft-${this.addCalls}` };
  }

  async findDraftByMarker({ credentials }) {
    this.remember(credentials);
    this.findCalls += 1;
    return { mediaId: this.findMediaId };
  }
}

before(() => {
  initSchema();
  migrateV2();
  createSqliteContentProductionPipelineRepository({ db }).ensureSchema();
  tenantA = Number(
    q.run(
      `INSERT INTO tenants(name,status,plan,credits,total_recharged)
    VALUES(?,'已开通','旗舰版',1000,1000)`,
      unique("微信甲租户"),
    ).lastInsertRowid,
  );
  tenantB = Number(
    q.run(
      `INSERT INTO tenants(name,status,plan,credits,total_recharged)
    VALUES(?,'已开通','旗舰版',1000,1000)`,
      unique("微信乙租户"),
    ).lastInsertRowid,
  );
  const a = q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?,'x','甲老板','boss','启用',?)`,
    unique("wechat-a"),
    tenantA,
  );
  const b = q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?,'x','乙老板','boss','启用',?)`,
    unique("wechat-b"),
    tenantB,
  );
  userA = {
    id: Number(a.lastInsertRowid),
    tenant_id: tenantA,
    role: "boss",
    name: "甲老板",
  };
  userB = {
    id: Number(b.lastInsertRowid),
    tenant_id: tenantB,
    role: "boss",
    name: "乙老板",
  };
  imageA = createImage(userA, "甲企业正文图.jpg");
  imageB = createImage(userB, "乙企业私有图.jpg");
  runWithTenant(tenantA, () =>
    saveWechatConfig({
      tenantId: tenantA,
      appId: "wxTenantA123",
      appSecret: "secret-tenant-a-123456",
    }),
  );
  runWithTenant(tenantB, () =>
    saveWechatConfig({
      tenantId: tenantB,
      appId: "wxTenantB456",
      appSecret: "secret-tenant-b-654321",
    }),
  );
});

after(() => {
  for (const file of createdPaths) fs.rmSync(file, { force: true });
  try {
    db.close();
  } catch {
    /* already closed */
  }
  for (const suffix of ["", "-wal", "-shm"])
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
});

test("租户配置只回显是否已设置，不泄露 AppID/AppSecret", () => {
  const a = runWithTenant(tenantA, () => publicWechatConfig(tenantA));
  const b = runWithTenant(tenantB, () => publicWechatConfig(tenantB));
  assert.deepEqual(a, {
    configured: true,
    appIdSet: true,
    appSecretSet: true,
    credentialsReturned: false,
  });
  assert.equal(JSON.stringify([a, b]).includes("wxTenant"), false);
  assert.equal(JSON.stringify([a, b]).includes("secret-tenant"), false);
});

test("官方适配器只访问 api.weixin.qq.com，上游 errmsg 中的秘密不对外暴露", async () => {
  const urls = [];
  const credentials = {
    appId: "wxOfficial123",
    appSecret: "official-secret-123456",
  };
  const provider = new OfficialWechatDraftProvider({
    fetchFn: async (url) => {
      urls.push(String(url));
      if (url.pathname.endsWith("/stable_token")) {
        return {
          ok: true,
          async json() {
            return { access_token: "token-not-public", expires_in: 7200 };
          },
        };
      }
      if (url.pathname.endsWith("/media/uploadimg")) {
        return {
          ok: true,
          async json() {
            return { url: "https://mmbiz.qpic.cn/official/image.jpg" };
          },
        };
      }
      if (url.pathname.endsWith("/material/add_material")) {
        return {
          ok: true,
          async json() {
            return { media_id: "official-cover" };
          },
        };
      }
      if (url.pathname.endsWith("/draft/add")) {
        return {
          ok: true,
          async json() {
            return { media_id: "official-draft" };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            total_count: 1,
            item: [
              {
                media_id: "official-found",
                content: {
                  news_item: [
                    { content: `<!-- ${WECHAT_DRAFT_MARKER_PREFIX}abc -->` },
                  ],
                },
              },
            ],
          };
        },
      };
    },
  });
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from("fixture"),
  ]);
  assert.equal(
    (await provider.testConnection({ tenantId: tenantA, credentials })).ok,
    true,
  );
  assert.match(
    (
      await provider.uploadContentImage({
        tenantId: tenantA,
        credentials,
        bytes: jpeg,
      })
    ).url,
    /^https:\/\/mmbiz\.qpic\.cn\//u,
  );
  assert.equal(
    (
      await provider.uploadCover({
        tenantId: tenantA,
        credentials,
        bytes: jpeg,
      })
    ).mediaId,
    "official-cover",
  );
  assert.equal(
    (
      await provider.addDraft({
        tenantId: tenantA,
        credentials,
        article: { title: "x" },
      })
    ).mediaId,
    "official-draft",
  );
  assert.equal(
    (
      await provider.findDraftByMarker({
        tenantId: tenantA,
        credentials,
        marker: `${WECHAT_DRAFT_MARKER_PREFIX}abc`,
      })
    ).mediaId,
    "official-found",
  );
  assert.ok(
    urls.every(
      (value) => new URL(value).origin === "https://api.weixin.qq.com",
    ),
  );

  const secret = "UPSTREAM-WECHAT-SECRET-MUST-NOT-LEAK";
  const rejected = new OfficialWechatDraftProvider({
    fetchFn: async () => ({
      ok: true,
      async json() {
        return { errcode: 99999, errmsg: secret };
      },
    }),
  });
  await assert.rejects(
    rejected.testConnection({ tenantId: tenantA, credentials }),
    (error) =>
      error instanceof WechatProviderError && !error.message.includes(secret),
  );
});

test("黄金源 12 套主题在本地安全排版，图片穿插正文且首图可兜底封面", () => {
  const catalog = listWechatDraftThemes();
  assert.equal(catalog.default, "orange");
  assert.deepEqual(
    catalog.themes.map((item) => item.key),
    [
      "orange",
      "ink",
      "techblue",
      "jade",
      "violet",
      "scarlet",
      "aqua",
      "magazine",
      "sakura",
      "gold",
      "geek",
      "guochao",
    ],
  );
  for (const item of catalog.themes) {
    assert.match(
      renderWechatDraftHtml({
        title: "主题冒烟测试",
        body: "## 小节\n\n安全正文。",
        theme: item.key,
      }),
      new RegExp(`data-paihuo-theme="${item.key}"`),
    );
  }
  assert.throws(
    () => renderWechatDraftHtml({ body: "正文", theme: "not-a-theme" }),
    (error) => error.code === "WECHAT_DRAFT_THEME_INVALID",
  );

  const marker = `${WECHAT_DRAFT_MARKER_PREFIX}theme-safe-marker`;
  const html = renderWechatDraftHtml({
    title: "主题排版安全稿",
    theme: "techblue",
    marker,
    imageUrls: [
      "https://mmbiz.qpic.cn/test/theme-one.jpg",
      "https://mmbiz.qpic.cn/test/theme-two.jpg",
    ],
    body: `# 主题排版安全稿

## 第一节

第一段 **重点**。

第二段 [站外来源](https://example.com/source?a=1&b=2)。

<script onerror="steal()">不可信内容</script>

第四段。`,
  });
  assert.match(html, /data-paihuo-theme="techblue"/u);
  assert.match(html, />01<\/span>/u);
  assert.match(html, /<strong style="color:#1e6fff">重点<\/strong>/u);
  assert.match(html, /参考链接/u);
  assert.match(html, /https:\/\/example\.com\/source\?a=1&amp;b=2/u);
  assert.equal((html.match(/<img /gu) || []).length, 2);
  assert.ok(html.indexOf("theme-one.jpg") < html.indexOf("第四段"));
  assert.match(html, /&lt;script onerror=&quot;steal\(\)&quot;&gt;/u);
  assert.doesNotMatch(html, /<script|<style|href="https:\/\/example\.com/u);
  assert.match(html, new RegExp(marker));

  const station5 = {
    name: "station5.png",
    bytes: Buffer.from("station5-first-image"),
    format: { ext: "png", mime: "image/png" },
  };
  const fallback = selectWechatDraftCover({
    providerImages: [station5],
    title: "不应生成封面",
    theme: "orange",
  });
  assert.equal(fallback.origin, "pipeline_body_first");
  assert.equal(fallback.image, station5);
});

test("默认封面用租户内置字体真实绘制标题，大图处理器只输出受控 JPEG", async () => {
  const png = createWechatDefaultCover("真实数字员工公众号草稿");
  const decoded = decodeGeneratedPng(png);
  assert.deepEqual([decoded.width, decoded.height], [900, 383]);
  let whitePixels = 0;
  for (let y = 0; y < decoded.height; y += 1) {
    const row = y * (1 + decoded.width * 3);
    assert.equal(decoded.raw[row], 0);
    for (let x = 0; x < decoded.width; x += 1) {
      const pixel = row + 1 + x * 3;
      if (
        decoded.raw[pixel] > 248 &&
        decoded.raw[pixel + 1] > 248 &&
        decoded.raw[pixel + 2] > 248
      )
        whitePixels += 1;
    }
  }
  assert.ok(whitePixels > 500, "封面应包含白色标题字形，不能只是纯渐变");

  const calls = [];
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from("compressed-jpeg"),
  ]);
  const processor = createWechatImageProcessor({
    ffmpegPath: "offline-ffmpeg-double",
    runner: async (command, args, bytes) => {
      calls.push({ command, args, bytes: bytes.length });
      return jpeg;
    },
  });
  const converted = await processor.toJpegUnderLimit({
    bytes: Buffer.alloc(1_100_000, 7),
  });
  assert.equal(converted.mime, "image/jpeg");
  assert.deepEqual(converted.bytes, jpeg);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "offline-ffmpeg-double");
  assert.ok(calls[0].args.includes("mjpeg"));
});

test("成功投递上传租户图和封面、写入 marker，固定价结算且重复请求幂等", async () => {
  const contentId = createManualContent(userA, "甲企业微信投递成功稿");
  const provider = new ProviderDouble("success");
  const service = createWechatDraftService({
    provider,
    autoRun: false,
    confirmDelayMs: 0,
  });
  const beforeCredits = q.get(
    "SELECT credits FROM tenants WHERE id=?",
    tenantA,
  ).credits;
  const created = await runWithTenant(tenantA, () =>
    service.createDelivery({
      user: userA,
      sourceType: "content",
      sourceId: contentId,
      imageFileIds: [imageA],
      theme: "techblue",
    }),
  );
  assert.equal(created.created, true);
  assert.equal(created.delivery.status, "processing");
  assert.equal(created.delivery.theme, "techblue");
  assert.equal(created.delivery.billing.state, "held");
  assert.equal(JSON.stringify(created).includes("secret-tenant-a"), false);

  const restartedService = createWechatDraftService({
    provider,
    autoRun: false,
    confirmDelayMs: 0,
  });
  const done = await restartedService.run(created.delivery.id, tenantA);
  assert.equal(done.status, "done");
  assert.equal(done.billing.state, "settled");
  assert.equal(done.billing.credits, 1);
  assert.equal(provider.imageCalls, 1);
  assert.equal(provider.coverCalls, 1);
  assert.equal(provider.addCalls, 1);
  assert.match(
    provider.articles[0].content,
    new RegExp(WECHAT_DRAFT_MARKER_PREFIX),
  );
  assert.match(provider.articles[0].content, /data-paihuo-theme="techblue"/u);
  assert.match(provider.articles[0].content, /https:\/\/mmbiz\.qpic\.cn\//u);
  assert.equal(
    q.get("SELECT credits FROM tenants WHERE id=?", tenantA).credits,
    beforeCredits - 1,
  );

  const duplicate = await runWithTenant(tenantA, () =>
    service.createDelivery({
      user: userA,
      sourceType: "content",
      sourceId: contentId,
      imageFileIds: [imageA],
      theme: "techblue",
    }),
  );
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.delivery.id, done.id);
  assert.equal(provider.addCalls, 1);

  const detail = runWithTenant(tenantA, () =>
    getUnifiedTaskDetail(userA, "wechat", done.id),
  );
  assert.equal(detail.kind, "wechat");
  assert.equal(detail.businessUsable, true);
  assert.equal(detail.wechat.mediaId, done.mediaId);
  assert.equal(JSON.stringify(detail).includes("secret-tenant-a"), false);
});

test("正文图和封面超过 990KB 时本地自动压缩转 JPEG，不要求用户手工返工", async () => {
  const contentId = createManualContent(userA, "大图自动压缩草稿");
  const oversizedPng = Buffer.alloc(1_050_000, 11);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversizedPng);
  const largeImageId = createImage(userA, "超大原图.png", oversizedPng);
  const compressed = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from("offline-compressed-jpeg"),
  ]);
  const imageProcessor = {
    calls: 0,
    async toJpegUnderLimit() {
      this.calls += 1;
      return {
        bytes: compressed,
        mime: "image/jpeg",
        filenameExtension: "jpg",
      };
    },
  };
  const provider = new ProviderDouble("success");
  const service = createWechatDraftService({
    provider,
    imageProcessor,
    autoRun: false,
    confirmDelayMs: 0,
  });
  const created = await runWithTenant(tenantA, () =>
    service.createDelivery({
      user: userA,
      sourceType: "content",
      sourceId: contentId,
      coverFileId: largeImageId,
      imageFileIds: [largeImageId],
    }),
  );
  const done = await service.run(created.delivery.id, tenantA);
  assert.equal(done.status, "done");
  assert.equal(imageProcessor.calls, 2);
  assert.deepEqual(provider.imageBytes[0], compressed);
  assert.deepEqual(provider.coverBytes[0], compressed);
  assert.equal(provider.addCalls, 1);
});

test("微信明确拒绝 draft/add 时标记 failed 并全退，不会把上游秘密写入错误", async () => {
  const contentId = createManualContent(userA, "明确拒绝退款稿");
  const provider = new ProviderDouble("reject");
  const service = createWechatDraftService({
    provider,
    autoRun: false,
    confirmDelayMs: 0,
  });
  const beforeCredits = q.get(
    "SELECT credits FROM tenants WHERE id=?",
    tenantA,
  ).credits;
  const created = await runWithTenant(tenantA, () =>
    service.createDelivery({
      user: userA,
      sourceType: "content",
      sourceId: contentId,
    }),
  );
  const failed = await service.run(created.delivery.id, tenantA);
  assert.equal(failed.status, "failed");
  assert.equal(failed.billing.state, "released");
  assert.equal(provider.addCalls, 1);
  assert.equal(
    q.get("SELECT credits FROM tenants WHERE id=?", tenantA).credits,
    beforeCredits,
  );
  assert.equal(JSON.stringify(failed).includes("secret-tenant"), false);
});

test("超时不确定态保留 hold，再运行只查 marker 不重发，找到后收口", async () => {
  const contentId = createManualContent(userA, "超时不确定对账稿");
  const provider = new ProviderDouble("timeout");
  const service = createWechatDraftService({
    provider,
    autoRun: false,
    confirmDelayMs: 5_000,
  });
  const created = await runWithTenant(tenantA, () =>
    service.createDelivery({
      user: userA,
      sourceType: "content",
      sourceId: contentId,
    }),
  );
  const uncertain = await service.run(created.delivery.id, tenantA);
  assert.equal(uncertain.status, "submitting");
  assert.equal(uncertain.billing.state, "held");
  assert.equal(uncertain.needsReconciliation, true);
  assert.equal(provider.addCalls, 1);

  const stillUncertain = await service.run(created.delivery.id, tenantA);
  assert.equal(stillUncertain.status, "submitting");
  assert.equal(provider.addCalls, 1, "submitting 恢复不得再调 draft/add");
  assert.ok(provider.findCalls >= 2);

  const stored = q.get(
    "SELECT provider_attempt_json FROM wechat_draft_deliveries WHERE tenant_id=? AND id=?",
    tenantA,
    created.delivery.id,
  );
  const attempt = JSON.parse(stored.provider_attempt_json);
  attempt.attemptedAt = new Date(Date.now() - 6_000).toISOString();
  q.run(
    `UPDATE wechat_draft_deliveries SET provider_attempt_json=?,updated_at=?
    WHERE tenant_id=? AND id=?`,
    JSON.stringify(attempt),
    new Date().toISOString(),
    tenantA,
    created.delivery.id,
  );
  await assert.rejects(
    runWithTenant(tenantA, () => service.reconcile(userA, created.delivery.id)),
    (error) => error.code === "WECHAT_DRAFT_NOT_FOUND_BY_MARKER",
  );
  assert.equal(
    service.getDelivery(userA, created.delivery.id).canConfirmNotDelivered,
    true,
    "只读对账不得重置人工确认等待时间",
  );

  provider.findMediaId = "reconciled-media-001";
  const reconciled = await runWithTenant(tenantA, () =>
    service.reconcile(userA, created.delivery.id),
  );
  assert.equal(reconciled.status, "done");
  assert.equal(reconciled.billing.state, "settled");
  assert.equal(provider.addCalls, 1);
});

test("同一 processing 投递只有一个数据库占用者，并发运行不重传不退分", async () => {
  const contentId = createManualContent(userA, "并发单占用草稿");
  const provider = new ProviderDouble("success");
  let releaseCover;
  let signalCoverStarted;
  const coverStarted = new Promise((resolve) => {
    signalCoverStarted = resolve;
  });
  const coverGate = new Promise((resolve) => {
    releaseCover = resolve;
  });
  provider.uploadCover = async ({ credentials }) => {
    provider.remember(credentials);
    provider.coverCalls += 1;
    signalCoverStarted();
    await coverGate;
    return { mediaId: `cover-${provider.coverCalls}` };
  };
  const service = createWechatDraftService({
    provider,
    autoRun: false,
    confirmDelayMs: 0,
  });
  const beforeCredits = q.get(
    "SELECT credits FROM tenants WHERE id=?",
    tenantA,
  ).credits;
  const created = await runWithTenant(tenantA, () =>
    service.createDelivery({
      user: userA,
      sourceType: "content",
      sourceId: contentId,
    }),
  );
  const firstRun = service.run(created.delivery.id, tenantA);
  await coverStarted;
  const duplicateRun = await service.run(created.delivery.id, tenantA);
  assert.equal(duplicateRun.status, "processing");
  assert.equal(duplicateRun.billing.state, "held");
  assert.equal(provider.coverCalls, 1);
  assert.equal(provider.addCalls, 0);
  releaseCover();
  const done = await firstRun;
  assert.equal(done.status, "done");
  assert.equal(provider.coverCalls, 1);
  assert.equal(provider.addCalls, 1);
  assert.equal(
    q.get("SELECT credits FROM tenants WHERE id=?", tenantA).credits,
    beforeCredits - 1,
  );
});

test("人工确认未送达前必须再查 marker，确认后退分并解锁同来源", async () => {
  const contentId = createManualContent(userA, "人工解锁确认稿");
  const provider = new ProviderDouble("timeout");
  const service = createWechatDraftService({
    provider,
    autoRun: false,
    confirmDelayMs: 0,
  });
  const beforeCredits = q.get(
    "SELECT credits FROM tenants WHERE id=?",
    tenantA,
  ).credits;
  const created = await runWithTenant(tenantA, () =>
    service.createDelivery({
      user: userA,
      sourceType: "content",
      sourceId: contentId,
    }),
  );
  await service.run(created.delivery.id, tenantA);
  await assert.rejects(
    runWithTenant(tenantA, () =>
      service.confirmNotDelivered(userA, created.delivery.id, {
        confirmedNoDraft: true,
        titleConfirmation: "错误标题",
      }),
    ),
    (error) => error.code === "WECHAT_CONFIRMATION_INVALID",
  );
  const unlocked = await runWithTenant(tenantA, () =>
    service.confirmNotDelivered(userA, created.delivery.id, {
      confirmedNoDraft: true,
      titleConfirmation: created.delivery.title,
    }),
  );
  assert.equal(unlocked.status, "failed");
  assert.equal(unlocked.billing.state, "released");
  assert.equal(
    q.get("SELECT credits FROM tenants WHERE id=?", tenantA).credits,
    beforeCredits,
  );

  const retry = await runWithTenant(tenantA, () =>
    service.createDelivery({
      user: userA,
      sourceType: "content",
      sourceId: contentId,
    }),
  );
  assert.equal(retry.created, true);
  assert.notEqual(retry.delivery.id, created.delivery.id);
  await service.recoverAndSchedule();
});

test("启动恢复：processing 从未提交则退分，submitted 只做本地结算", async () => {
  const provider = new ProviderDouble("success");
  const service = createWechatDraftService({
    provider,
    autoRun: false,
    confirmDelayMs: 0,
  });
  const preSubmitId = createManualContent(userA, "重启前未提交稿");
  const preSubmit = await runWithTenant(tenantA, () =>
    service.createDelivery({
      user: userA,
      sourceType: "content",
      sourceId: preSubmitId,
    }),
  );
  const submittedId = createManualContent(userA, "重启前已送达稿");
  const submitted = await runWithTenant(tenantA, () =>
    service.createDelivery({
      user: userA,
      sourceType: "content",
      sourceId: submittedId,
    }),
  );
  q.run(
    `UPDATE wechat_draft_deliveries
    SET status='submitted',provider_media_id='restart-media',submitted_at=datetime('now','localtime')
    WHERE tenant_id=? AND id=?`,
    tenantA,
    submitted.delivery.id,
  );
  const uncertainProvider = new ProviderDouble("timeout");
  const uncertainService = createWechatDraftService({
    provider: uncertainProvider,
    autoRun: false,
    confirmDelayMs: 0,
  });
  const uncertainSourceId = createManualContent(
    userA,
    "重启前提交结果不确定稿",
  );
  const uncertain = await runWithTenant(tenantA, () =>
    uncertainService.createDelivery({
      user: userA,
      sourceType: "content",
      sourceId: uncertainSourceId,
    }),
  );
  await uncertainService.run(uncertain.delivery.id, tenantA);
  const findCallsBeforeRecovery = uncertainProvider.findCalls;
  const report = await service.recoverAndSchedule();
  assert.ok(
    report.some(
      (item) => item.id === preSubmit.delivery.id && item.action === "refunded",
    ),
  );
  assert.ok(
    report.some(
      (item) =>
        item.id === submitted.delivery.id && item.action === "finalized",
    ),
  );
  assert.ok(
    report.some(
      (item) =>
        item.id === uncertain.delivery.id &&
        item.action === "protected_uncertain",
    ),
  );
  assert.equal(
    service.getDelivery(userA, preSubmit.delivery.id).status,
    "failed",
  );
  assert.equal(
    service.getDelivery(userA, submitted.delivery.id).status,
    "done",
  );
  assert.equal(
    service.getDelivery(userA, uncertain.delivery.id).status,
    "submitting",
  );
  assert.equal(provider.addCalls, 0, "启动恢复不得重放 draft/add");
  assert.equal(
    uncertainProvider.findCalls,
    findCallsBeforeRecovery,
    "启动恢复不主动联网对账",
  );
});

test("权威账本已终结但业务状态未落库时，重启能幂等补记", async () => {
  const provider = new ProviderDouble("success");
  const service = createWechatDraftService({
    provider,
    autoRun: false,
    confirmDelayMs: 0,
  });

  const releasedSource = createManualContent(userA, "退分后落库中断草稿");
  const released = await runWithTenant(tenantA, () =>
    service.createDelivery({
      user: userA,
      sourceType: "content",
      sourceId: releasedSource,
    }),
  );
  const releasedHold = findHoldByRef(
    "wechat_draft_delivery",
    released.delivery.id,
    tenantA,
  );
  releaseHold(releasedHold, "模拟退分已成功但业务状态未落库");

  const settledSource = createManualContent(userA, "结算后落库中断草稿");
  const settled = await runWithTenant(tenantA, () =>
    service.createDelivery({
      user: userA,
      sourceType: "content",
      sourceId: settledSource,
    }),
  );
  q.run(
    `UPDATE wechat_draft_deliveries
    SET status='submitted',provider_media_id='ledger-first-media',submitted_at=?
    WHERE tenant_id=? AND id=?`,
    new Date().toISOString(),
    tenantA,
    settled.delivery.id,
  );
  const settledHold = findHoldByRef(
    "wechat_draft_delivery",
    settled.delivery.id,
    tenantA,
  );
  settleHold(settledHold, {
    credits: 1,
    model: "wechat-official-draft-api",
    note: "模拟结算已成功但业务状态未落库",
  });

  const report = await service.recoverAndSchedule();
  assert.ok(
    report.some(
      (item) => item.id === released.delivery.id && item.action === "refunded",
    ),
  );
  assert.ok(
    report.some(
      (item) => item.id === settled.delivery.id && item.action === "finalized",
    ),
  );
  const releasedResult = service.getDelivery(userA, released.delivery.id);
  const settledResult = service.getDelivery(userA, settled.delivery.id);
  assert.equal(releasedResult.status, "failed");
  assert.equal(releasedResult.billing.state, "released");
  assert.equal(releasedResult.billing.authoritative, true);
  assert.equal(settledResult.status, "done");
  assert.equal(settledResult.billing.state, "settled");
  assert.equal(settledResult.billing.authoritative, true);
  assert.equal(provider.addCalls, 0);
});

test("发布包来源必须是分发官已完成且已结算的真实输出", async () => {
  const pipelineId = 80_000 + Math.floor(Math.random() * 10_000);
  const at = new Date().toISOString();
  const pipelineBilling = settledPipelineBilling(userA, pipelineId);
  db.prepare(
    `INSERT INTO content_production_pipeline_jobs(
      id,tenant_id,created_by,title,status,current_station,pending_station,
      task_json,persona_json,settings_json,workflow_json,version,created_at,updated_at
    ) VALUES(?,?,?,'流水线微信发布包','running',9,9,'{}','{}','{}','{}',0,?,?)`,
  ).run(pipelineId, tenantA, userA.id, at, at);
  db.prepare(
    `INSERT INTO content_production_pipeline_stations(
      pipeline_id,tenant_id,station_idx,employee_key,handler_id,status,attempt,
      output_json,billing_evidence_json,updated_at,completed_at
    ) VALUES(?,?,8,'publish','publish-handler','completed',1,?,?,?,?)`,
  ).run(
    pipelineId,
    tenantA,
    JSON.stringify({
      versions: [
        {
          platform: "公众号",
          title: "分发官公众号主发布包",
          body: "这是分发官已结算的公众号正文。",
        },
      ],
    }),
    JSON.stringify(pipelineBilling),
    at,
    at,
  );
  const station5Bytes = createWechatDefaultCover("流水线工位5正文图");
  const station6Bytes = createWechatDefaultCover("流水线工位6封面图");
  const station5Ref = {
    type: "content_special_provider",
    id: pipelineId * 100 + 6,
  };
  const station6Ref = {
    type: "content_special_provider",
    id: pipelineId * 100 + 7,
  };
  const station5Material = createPipelineProviderMaterial({
    user: userA,
    pipelineId,
    stationIdx: 5,
    name: "工位5已固化正文图.png",
    bytes: station5Bytes,
    billingRefType: station5Ref.type,
    billingRefId: station5Ref.id,
  });
  const station6Material = createPipelineProviderMaterial({
    user: userA,
    pipelineId,
    stationIdx: 6,
    name: "工位6已固化封面图.png",
    bytes: station6Bytes,
    billingRefType: station6Ref.type,
    billingRefId: station6Ref.id,
  });
  const station5Billing = pipelineBillingWithProvider({
    user: userA,
    pipelineId,
    stationIdx: 5,
    materialId: station5Material,
  });
  const station6Billing = pipelineBillingWithProvider({
    user: userA,
    pipelineId,
    stationIdx: 6,
    materialId: station6Material,
  });
  assert.deepEqual(
    [station5Billing.billingRefType, station5Billing.billingRefId],
    [station5Ref.type, station5Ref.id],
  );
  assert.deepEqual(
    [station6Billing.billingRefType, station6Billing.billingRefId],
    [station6Ref.type, station6Ref.id],
  );
  for (const item of [
    {
      stationIdx: 5,
      materialId: station5Material,
      billing: station5Billing.evidence,
    },
    {
      stationIdx: 6,
      materialId: station6Material,
      billing: station6Billing.evidence,
    },
  ]) {
    db.prepare(
      `INSERT INTO content_production_pipeline_stations(
        pipeline_id,tenant_id,station_idx,employee_key,handler_id,status,attempt,
        output_json,handler_evidence_json,billing_evidence_json,updated_at,completed_at
      ) VALUES(?,?,?,?,'provider-handler','completed',1,'{}',?,?,?,?)`,
    ).run(
      pipelineId,
      tenantA,
      item.stationIdx,
      item.stationIdx === 5 ? "media" : "cover",
      JSON.stringify({
        productionRuntime: {
          specialRuntime: {
            bridge: {
              attempts: [
                {
                  delivery: {
                    persisted: true,
                    artifactIds: [`material:${item.materialId}`],
                  },
                },
              ],
            },
          },
        },
      }),
      JSON.stringify(item.billing),
      at,
      at,
    );
  }
  const sources = runWithTenant(tenantA, () =>
    listWechatDraftSources({ tenantId: tenantA, limit: 100 }),
  );
  const pipelineSource = sources.find(
    (item) => item.sourceType === "pipeline" && item.sourceId === pipelineId,
  );
  assert.ok(pipelineSource);
  assert.equal(pipelineSource.autoImageCount, 1);
  assert.equal(pipelineSource.autoCoverAvailable, true);
  const provider = new ProviderDouble("success");
  const service = createWechatDraftService({
    provider,
    autoRun: false,
    confirmDelayMs: 0,
  });
  const created = await runWithTenant(tenantA, () =>
    service.createDelivery({
      user: userA,
      sourceType: "pipeline",
      sourceId: pipelineId,
    }),
  );
  const done = await service.run(created.delivery.id, tenantA);
  assert.equal(done.status, "done");
  assert.equal(provider.articles[0].title, "分发官公众号主发布包");
  assert.equal(provider.imageCalls, 1);
  assert.equal(provider.coverCalls, 1);
  assert.deepEqual(provider.imageBytes[0], station5Bytes);
  assert.deepEqual(provider.coverBytes[0], station6Bytes);
  assert.match(provider.articles[0].content, /https:\/\/mmbiz\.qpic\.cn/u);

  db.prepare(
    `UPDATE content_production_pipeline_stations
    SET handler_evidence_json='{}',updated_at=?
    WHERE tenant_id=? AND pipeline_id=? AND station_idx=6`,
  ).run(new Date().toISOString(), tenantA, pipelineId);
  const fallbackProvider = new ProviderDouble("success");
  const fallbackService = createWechatDraftService({
    provider: fallbackProvider,
    autoRun: false,
    confirmDelayMs: 0,
  });
  const fallbackCreated = await runWithTenant(tenantA, () =>
    fallbackService.createDelivery({
      user: userA,
      sourceType: "pipeline",
      sourceId: pipelineId,
      theme: "jade",
    }),
  );
  const fallbackDone = await fallbackService.run(
    fallbackCreated.delivery.id,
    tenantA,
  );
  assert.equal(fallbackDone.status, "done");
  assert.equal(fallbackDone.providerAttempt.coverOrigin, "pipeline_body_first");
  assert.deepEqual(fallbackProvider.imageBytes[0], station5Bytes);
  assert.deepEqual(fallbackProvider.coverBytes[0], station5Bytes);
  assert.match(
    fallbackProvider.articles[0].content,
    /data-paihuo-theme="jade"/u,
  );

  const xhsOnlyPipelineId = pipelineId + 10_000;
  const xhsPipelineBilling = settledPipelineBilling(userA, xhsOnlyPipelineId);
  db.prepare(
    `INSERT INTO content_production_pipeline_jobs(
      id,tenant_id,created_by,title,status,current_station,pending_station,
      task_json,persona_json,settings_json,workflow_json,version,created_at,updated_at
    ) VALUES(?,?,?,'仅小红书发布包','running',9,9,'{}','{}','{}','{}',0,?,?)`,
  ).run(xhsOnlyPipelineId, tenantA, userA.id, at, at);
  db.prepare(
    `INSERT INTO content_production_pipeline_stations(
      pipeline_id,tenant_id,station_idx,employee_key,handler_id,status,attempt,
      output_json,billing_evidence_json,updated_at,completed_at
    ) VALUES(?,?,8,'publish','publish-handler','completed',1,?,?,?,?)`,
  ).run(
    xhsOnlyPipelineId,
    tenantA,
    JSON.stringify({
      versions: [
        { platform: "小红书", title: "小红书稿", body: "非公众号版本" },
      ],
    }),
    JSON.stringify(xhsPipelineBilling),
    at,
    at,
  );
  await assert.rejects(
    runWithTenant(tenantA, () =>
      service.createDelivery({
        user: userA,
        sourceType: "pipeline",
        sourceId: xhsOnlyPipelineId,
      }),
    ),
    (error) => error.code === "WECHAT_PIPELINE_VERSION_MISSING",
  );
});

test("跨租户产物、素材、投递和密钥全部隔离，路由响应不回显凭据", async () => {
  const contentA = createManualContent(userA, "甲租户私有草稿");
  const contentB = createManualContent(userB, "乙租户私有草稿");
  const providerA = new ProviderDouble("success");
  const serviceA = createWechatDraftService({
    provider: providerA,
    autoRun: false,
    confirmDelayMs: 0,
  });
  const createdA = await runWithTenant(tenantA, () =>
    serviceA.createDelivery({
      user: userA,
      sourceType: "content",
      sourceId: contentA,
    }),
  );
  await assert.rejects(
    runWithTenant(tenantB, () =>
      serviceA.createDelivery({
        user: userB,
        sourceType: "content",
        sourceId: contentA,
      }),
    ),
    (error) => error.code === "WECHAT_SOURCE_NOT_FOUND",
  );
  await assert.rejects(
    runWithTenant(tenantA, () =>
      serviceA.createDelivery({
        user: userA,
        sourceType: "content",
        sourceId: contentA,
        imageFileIds: [imageB],
      }),
    ),
    (error) => error.code === "WECHAT_IMAGE_NOT_FOUND",
  );
  assert.throws(
    () =>
      runWithTenant(tenantB, () =>
        serviceA.getDelivery(userB, createdA.delivery.id),
      ),
    (error) => error.code === "WECHAT_DELIVERY_NOT_FOUND",
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) =>
    runWithTenant(tenantA, () => {
      req.user = userA;
      next();
    }),
  );
  app.use("/wechat-draft", createWechatDraftRouter({ service: serviceA }));
  const server = app.listen(0);
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    const [response, themeResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/wechat-draft/config`),
      fetch(`http://127.0.0.1:${port}/wechat-draft/themes`),
    ]);
    const [payload, themePayload] = await Promise.all([
      response.json(),
      themeResponse.json(),
    ]);
    assert.equal(response.status, 200);
    assert.equal(themeResponse.status, 200);
    assert.equal(themePayload.default, "orange");
    assert.equal(themePayload.themes.length, 12);
    assert.equal(payload.config.configured, true);
    assert.equal(JSON.stringify(payload).includes("wxTenantA123"), false);
    assert.equal(JSON.stringify(payload).includes("secret-tenant-a"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  await serviceA.recoverAndSchedule();
  assert.ok(
    providerA.credentialAppIds.every((value) => value === "wxTenantA123"),
  );
  assert.equal(providerA.credentialAppIds.includes("wxTenantB456"), false);
  assert.equal(imageA > 0 && imageB > 0, true);
});

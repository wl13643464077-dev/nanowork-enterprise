import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(
  os.tmpdir(),
  `nanowork-licensed-material-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"])
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
process.env.NANOWORK_DB = dbPath;

const { initSchema, migrateV2, q } = await import("../src/db.js");
const { searchLicensedMaterials } =
  await import("../src/engines/licensed-material-search.js");
initSchema();
migrateV2();

function insertMaterial({
  tenantId = 1,
  name,
  tags = [],
  sourceType = "imagehunt",
  rowUrl,
  fileUrl = rowUrl,
  confirmed = true,
  license = "企业自有拍摄素材",
  attribution = "门店摄影师",
  mimeType = "image/webp",
  artifact = {},
}) {
  const snapshot = {
    schemaVersion: "nanowork.imagehunt-material/1",
    provider: "fixture",
    originalImageUrl: `https://images.example.com/${encodeURIComponent(name)}.webp`,
    sourceUrl: `https://source.example.com/${encodeURIComponent(name)}`,
    fileUrl,
    mimeType,
    rights: { confirmed, commercialUse: true, license, attribution },
    ...artifact,
  };
  return Number(
    q.run(
      `INSERT INTO materials(
        tenant_id,name,type,tags,url,source_type,note,body_snapshot,
        artifact_snapshot_json,snapshot_hash
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      tenantId,
      name,
      "图片",
      JSON.stringify(tags),
      rowUrl,
      sourceType,
      `已授权：${name}`,
      `已固化图片素材 file=${rowUrl}`,
      JSON.stringify(snapshot),
      `${tenantId}-${name}`,
    ).lastInsertRowid,
  );
}

const hotpotId = insertMaterial({
  name: "麻辣火锅新品门店实拍",
  tags: ["小红书", "火锅", "菜品近景"],
  rowUrl: "/uploads/files/1/imagehunt/hotpot.webp",
});
const teamId = insertMaterial({
  name: "厨师团队合影",
  tags: ["视频号", "团队"],
  rowUrl: "/uploads/files/1/imagehunt/team.webp",
});
const storefrontId = insertMaterial({
  name: "火锅门店夜景门头",
  tags: ["小红书", "门店", "夜景"],
  rowUrl: "/uploads/files/1/imagehunt/storefront.webp",
});

insertMaterial({
  name: "未确认授权",
  rowUrl: "/uploads/files/1/imagehunt/unconfirmed.webp",
  confirmed: false,
});
insertMaterial({
  name: "未确认商用授权",
  rowUrl: "/uploads/files/1/imagehunt/non-commercial.webp",
  artifact: {
    rights: {
      confirmed: true,
      commercialUse: false,
      license: "仅限个人使用",
      attribution: "第三方作者",
    },
  },
});
insertMaterial({
  name: "空授权类型",
  rowUrl: "/uploads/files/1/imagehunt/no-license.webp",
  license: "   ",
});
insertMaterial({
  name: "外部URL",
  rowUrl: "https://images.example.com/external.webp",
});
insertMaterial({
  name: "伪装成其他租户路径",
  rowUrl: "/uploads/files/2/imagehunt/wrong-tenant.webp",
});
insertMaterial({
  name: "行与快照URL不一致",
  rowUrl: "/uploads/files/1/imagehunt/row.webp",
  fileUrl: "/uploads/files/1/imagehunt/artifact.webp",
});
insertMaterial({
  name: "非ImageHunt来源",
  rowUrl: "/uploads/files/1/imagehunt/other-source.webp",
  sourceType: "manual",
});
const tenantTwoId = insertMaterial({
  tenantId: 2,
  name: "二号租户火锅素材",
  tags: ["火锅", "小红书"],
  rowUrl: "/uploads/files/2/imagehunt/tenant-two.webp",
});

test("只返回当前租户已确认授权的ImageHunt本地图片", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("本地授权素材检索不得访问网络");
  };
  try {
    const result = await searchLicensedMaterials({
      tenantId: 1,
      count: 12,
      request: { prompt: "火锅新品推广", platforms: ["小红书"] },
    });
    assert.deepEqual(
      new Set(result.assets.map((asset) => asset.materialId)),
      new Set([hotpotId, teamId, storefrontId]),
    );
    assert.ok(
      result.assets.every(
        (asset) =>
          asset.url.startsWith("/uploads/files/1/") &&
          asset.rights.confirmed === true &&
          asset.rights.commercialUse === true &&
          asset.rights.license,
      ),
    );
    assert.equal(result.provider.mode, "local");
    assert.equal(result.usage.networkRequests, 0);
    assert.equal(result.usage.tokenUsageApplicable, false);
    assert.equal(result.cost.credits, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("结合prompt、imagePlan与平台排序，并把上游槽位完整带回", async () => {
  const result = await searchLicensedMaterials({
    tenantId: 1,
    count: 2,
    request: {
      prompt: "麻辣火锅新品小红书推广",
      platforms: ["小红书"],
    },
    runtime: {
      imagePlan: [
        { slot: "首图", desc: "麻辣火锅菜品近景", platform: "小红书" },
        { slot: "结尾图", desc: "火锅门店夜景门头", platform: "小红书" },
      ],
    },
  });
  assert.deepEqual(
    result.assets.map((asset) => asset.materialId),
    [hotpotId, storefrontId],
  );
  assert.deepEqual(
    result.assets.map(({ slot, desc }) => ({ slot, desc })),
    [
      { slot: "首图", desc: "麻辣火锅菜品近景" },
      { slot: "结尾图", desc: "火锅门店夜景门头" },
    ],
  );
  assert.equal(result.assets[0].mimeType, "image/webp");
  assert.equal(result.assets[0].fileName, "hotpot.webp");
  assert.match(
    result.assets[0].sourceUrl,
    /^https:\/\/source\.example\.com\//u,
  );
});

test("库内数量不足时只返回实际素材，不复制、不伪造补齐", async () => {
  const result = await searchLicensedMaterials({
    tenantId: 1,
    count: 8,
    request: { prompt: "火锅", platforms: ["小红书"] },
  });
  assert.equal(result.assets.length, 3);
  assert.equal(new Set(result.assets.map((asset) => asset.materialId)).size, 3);
  assert.equal(result.usage.requestedCount, 8);
  assert.equal(result.usage.returnedCount, 3);
  assert.equal(result.usage.eligibleCount, 3);
});

test("显式tenantId查询严格隔离租户素材", async () => {
  const tenantOne = await searchLicensedMaterials({
    tenantId: 1,
    count: 12,
    request: { prompt: "火锅" },
  });
  assert.ok(
    tenantOne.assets.every((asset) => asset.materialId !== tenantTwoId),
  );

  const tenantTwo = await searchLicensedMaterials({
    tenantId: 2,
    count: 12,
    request: { prompt: "火锅" },
  });
  assert.deepEqual(
    tenantTwo.assets.map((asset) => asset.materialId),
    [tenantTwoId],
  );
  assert.equal(
    tenantTwo.assets[0].url,
    "/uploads/files/2/imagehunt/tenant-two.webp",
  );
});

after(() => {
  for (const suffix of ["", "-wal", "-shm"])
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
});

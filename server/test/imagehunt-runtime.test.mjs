import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { removeTempDbSafely } from "./helpers/temp-db.mjs";

const WORKSPACE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const dbPath = path.join(os.tmpdir(), `nanowork-imagehunt-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"])
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
process.env.NANOWORK_DB = dbPath;

const { initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const {
  fetchPublicImageBytes,
  parseBaiduImageResults,
  parseBingImageResults,
  parsePublicImageUrl,
  parseSoImageResults,
  searchImageHunt,
} = await import("../src/engines/imagehunt.js");
const { createImageHuntRouter } = await import("../src/routes/imagehunt.js");
const { readTenantUploadedFileByUrl, saveUploadedFile } =
  await import("../src/engines/filehub.js");
initSchema();
migrateV2();

const userId = Number(
  q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id)
    VALUES('imagehunt_owner','x','图片素材负责人','sales','内容部',1)`)
    .lastInsertRowid,
);
const user = {
  id: userId,
  name: "图片素材负责人",
  role: "sales",
  tenant_id: 1,
};
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

test("图片候选URL在DNS/HTTP前拒绝内网、凭据、非默认端口与异常编码", () => {
  assert.equal(
    parsePublicImageUrl("https://images.example.com/a.png#section").href,
    "https://images.example.com/a.png",
  );
  for (const url of [
    "http://127.0.0.1/admin.png",
    "http://localhost/a.png",
    "https://user:pass@images.example.com/a.png",
    "https://images.example.com:8443/a.png",
    "https://images.example.com/a.png?access_token=secret",
    "https://images.example.com/a.png?%F0%80%80%80=x",
  ]) {
    assert.throws(() => parsePublicImageUrl(url), /图片URL/u, url);
  }
});

test("Bing/Baidu/360 解析器归一为统一候选，搜索去重且不保留不安全URL", async () => {
  const bing = parseBingImageResults(
    '<a class="iusc" m="{&quot;t&quot;:&quot;门店菜品&quot;,&quot;murl&quot;:&quot;https://img.example.com/a.jpg&quot;,&quot;turl&quot;:&quot;https://thumb.example.com/a.jpg&quot;,&quot;purl&quot;:&quot;https://shop.example.com/menu&quot;}">',
  );
  const baidu = parseBaiduImageResults({
    data: [
      {
        fromPageTitleEnc: "菜品图",
        middleURL: "https://img.example.com/b.png",
        fromURL: "https://shop.example.com/b",
      },
    ],
  });
  const so = parseSoImageResults({
    list: [
      {
        title: "后厨图",
        img: "https://img.example.com/c.webp",
        link: "https://shop.example.com/c",
      },
    ],
  });
  assert.equal(bing.length, 1);
  assert.equal(baidu.length, 1);
  assert.equal(so.length, 1);

  const result = await searchImageHunt("毛血旺 门店实拍", {
    searchProvidersFn: async () => [
      ...bing,
      ...baidu,
      ...so,
      { ...bing[0], title: "重复" },
      { title: "内网", imageUrl: "http://127.0.0.1/a.png", provider: "bad" },
      {
        title: "凭据",
        imageUrl: "https://img.example.com/x.png?token=secret",
        provider: "bad",
      },
    ],
  });
  assert.equal(result.results.length, 3);
  assert.equal(result.providerCount, 3);
  assert.equal(result.rightsVerified, false);
  assert.ok(
    result.results.every((item) => item.rights.commercialUse === false),
  );
});

function fakeRequestFactory({ contentType = "image/png", body = png } = {}) {
  return (_options, callback) => {
    const request = new EventEmitter();
    request.end = () => {
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {
          "content-type": contentType,
          "content-length": String(body.length),
        };
        response.complete = true;
        callback(response);
        response.end(body);
      });
    };
    request.destroy = (error) => request.emit("error", error);
    return request;
  };
}

test("安全图片下载固定公网DNS并校验MIME与文件魔数", async () => {
  const delivered = await fetchPublicImageBytes(
    "https://img.example.com/a.png",
    {
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
      requestFactory: fakeRequestFactory(),
    },
  );
  assert.equal(delivered.mimeType, "image/png");
  assert.deepEqual(delivered.buffer, png);

  await assert.rejects(
    fetchPublicImageBytes("https://img.example.com/a.png", {
      lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
      requestFactory: fakeRequestFactory(),
    }),
    (error) => error.code === "IMAGEHUNT_SSRF_BLOCKED",
  );
  await assert.rejects(
    fetchPublicImageBytes("https://img.example.com/a.png", {
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
      requestFactory: fakeRequestFactory({ contentType: "image/jpeg" }),
    }),
    (error) => error.code === "IMAGEHUNT_MAGIC_INVALID",
  );
});

test("ImageHunt入库文件只能按当前租户URL读取并保持字节完整", async () => {
  let saved;
  try {
    saved = runWithTenant(1, () =>
      saveUploadedFile({
        name: "imagehunt-local.png",
        b64: png.toString("base64"),
        mime: "image/png",
        purpose: "imagehunt-test",
        userId,
      }),
    );
    const delivered = runWithTenant(1, () =>
      readTenantUploadedFileByUrl({
        tenantId: 1,
        fileUrl: saved.row.file_url,
        maxBytes: 1024,
      }),
    );
    assert.deepEqual(delivered.bytes, png);
    assert.equal(delivered.mimeType, "image/png");
    assert.equal(delivered.fileId, Number(saved.row.id));
    assert.throws(
      () =>
        runWithTenant(2, () =>
          readTenantUploadedFileByUrl({
            tenantId: 2,
            fileUrl: saved.row.file_url,
            maxBytes: 1024,
          }),
        ),
      (error) => error?.code === "UPLOADED_FILE_URL_INVALID",
    );
  } finally {
    if (saved?.row?.id)
      q.run(
        "DELETE FROM uploaded_files WHERE tenant_id=1 AND id=?",
        saved.row.id,
      );
    if (saved?.row?.file_path) {
      fs.rmSync(saved.row.file_path, { force: true });
      try {
        fs.rmdirSync(path.dirname(saved.row.file_path));
      } catch {
        // 共享测试进程中目录仍有文件时保留，避免删除其他夹具。
      }
    }
  }
});

function appFor() {
  const searchFn = async (query) => ({
    query: String(query),
    results: [
      {
        title: "授权候选图",
        imageUrl: "https://img.example.com/a.png",
        thumbnailUrl: "https://img.example.com/a.png",
        sourceUrl: "https://shop.example.com/menu",
        provider: "fixture",
        rights: { status: "unverified", commercialUse: false },
      },
    ],
    externalCall: true,
  });
  const fetchImageFn = async (url) => ({
    buffer: png,
    mimeType: "image/png",
    byteSize: png.length,
    finalUrl: parsePublicImageUrl(url).href,
  });
  const saveFileFn = ({ name, mime, userId }) => ({
    row: {
      id: 7001,
      name,
      mime,
      user_id: userId,
      file_url: "/uploads/files/1/imagehunt/imagehunt-fixture.png",
    },
  });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) =>
    runWithTenant(1, () => {
      req.user = user;
      next();
    }),
  );
  app.use(
    "/imagehunt",
    createImageHuntRouter({ searchFn, fetchImageFn, saveFileFn }),
  );
  return app;
}

async function withServer(fn) {
  const server = appFor().listen(0);
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("imagehunt 搜索/缩略图/版权确认导入形成租户素材且保持幂等", async () => {
  await withServer(async (base) => {
    const search = await fetch(
      `${base}/imagehunt?q=${encodeURIComponent("菜品实拍")}`,
    );
    assert.equal(search.status, 200);
    assert.equal((await search.json()).results.length, 1);

    const thumb = await fetch(
      `${base}/imagehunt/thumb?url=${encodeURIComponent("https://img.example.com/a.png")}`,
    );
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get("content-type"), "image/png");

    const rejected = await fetch(`${base}/imagehunt/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageUrl: "https://img.example.com/a.png",
        title: "菜品图",
      }),
    });
    assert.equal(rejected.status, 409);

    const payload = {
      imageUrl: "https://img.example.com/a.png",
      sourceUrl: "https://shop.example.com/menu",
      title: "已授权菜品图",
      provider: "fixture",
      rightsConfirmed: true,
      license: "企业自有拍摄素材",
      attribution: "门店摄影师",
    };
    const imported = await fetch(`${base}/imagehunt/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(imported.status, 201);
    const first = await imported.json();
    assert.equal(first.billing.state, "not_applicable");
    const row = q.get(
      "SELECT * FROM materials WHERE tenant_id=1 AND id=?",
      first.materialId,
    );
    assert.equal(row.source_type, "imagehunt");
    assert.match(row.body_snapshot, /sha256=[a-f0-9]{64}/u);
    assert.doesNotMatch(row.body_snapshot, /base64/u);
    assert.equal(row.url, "/uploads/files/1/imagehunt/imagehunt-fixture.png");
    const artifact = JSON.parse(row.artifact_snapshot_json);
    assert.equal(artifact.rights.confirmed, true);
    assert.equal(artifact.rights.commercialUse, true);
    assert.equal(artifact.fileId, 7001);
    assert.equal(artifact.fileUrl, row.url);

    const duplicate = await fetch(`${base}/imagehunt/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).alreadyImported, true);
  });
});

test("经营工具箱真实挂载搜图、缩略图代理与版权确认导入界面", () => {
  const toolboxSource = fs.readFileSync(
    path.join(WORKSPACE_ROOT, "web/src/pages/Toolbox.tsx"),
    "utf8",
  );
  const panelSource = fs.readFileSync(
    path.join(WORKSPACE_ROOT, "web/src/components/ImageHuntPanel.tsx"),
    "utf8",
  );
  assert.match(toolboxSource, /key:\s*'imagehunt'/u);
  assert.match(
    toolboxSource,
    /active\.key\s*===\s*'imagehunt'[\s\S]*<ImageHuntPanel\s*\/>/u,
  );
  assert.match(panelSource, /api\.get\(`\/imagehunt\?q=/u);
  assert.match(panelSource, /\/api\/imagehunt\/thumb\?url=/u);
  assert.match(panelSource, /api\.post\('\/imagehunt\/import'/u);
  assert.match(panelSource, /rightsConfirmed:\s*true/u);
  assert.match(panelSource, /我已核验该图片的使用权与署名要求/u);
});

after(async () => {
  await removeTempDbSafely(dbPath);
});

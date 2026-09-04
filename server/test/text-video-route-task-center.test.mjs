import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import test, { after } from "node:test";
import { removeTempDbSafely } from "./helpers/temp-db.mjs";

const WORKSPACE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const dbPath = path.join(
  os.tmpdir(),
  `nanowork-text-video-route-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"]) {
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.NANOWORK_DB = dbPath;
process.env.YUNWU_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

const { initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const { createTextVideoJobService } =
  await import("../src/engines/text-video.js");
const textVideoRoutes = (await import("../src/routes/text-video.js")).default;
const taskCenterRoutes = (await import("../src/routes/task-center.js")).default;

initSchema();
migrateV2();
q.run(
  "UPDATE tenants SET name='成片甲企业',status='已开通',credits=20000 WHERE id=1",
);
q.run(
  "INSERT INTO tenants(id,name,status,credits) VALUES(2,'成片乙企业','已开通',20000)",
);
q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('text-video-route-a','x','甲用户','boss','启用',1)`);
q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('text-video-route-b','x','乙用户','boss','启用',2)`);
const userA = q.get(
  "SELECT id,name,role,tenant_id FROM users WHERE username='text-video-route-a'",
);
const userB = q.get(
  "SELECT id,name,role,tenant_id FROM users WHERE username='text-video-route-b'",
);

const tempRoot = await fsp.mkdtemp(
  path.join(os.tmpdir(), "nanowork-text-video-route-output-"),
);

function mp4Bytes(label) {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom"),
    Buffer.from(label),
    Buffer.alloc(64, 4),
  ]);
}

const renderer = {
  async preflight() {
    return true;
  },
  async render({ tenantId, jobId, body, mode, onStep }) {
    onStep({ phase: "script", message: "整理真实口播稿" });
    onStep({ phase: "tts", message: "逐句真实TTS 1/1", current: 1, total: 1 });
    onStep({
      phase: "compose",
      message: "字幕与画面合成 1/1",
      current: 1,
      total: 1,
    });
    onStep({ phase: "finalize", message: "校验1080×1920/H264/AAC" });
    const directory = path.join(tempRoot, String(tenantId));
    await fsp.mkdir(directory, { recursive: true });
    const fileName = `route-${jobId}-${crypto.randomBytes(5).toString("hex")}.mp4`;
    const absolutePath = path.join(directory, fileName);
    const bytes = mp4Bytes(`route-${jobId}`);
    await fsp.writeFile(absolutePath, bytes);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    return {
      script: body,
      sentences: [body],
      absolutePath,
      fileName,
      fileUrl: `/uploads/files/${tenantId}/text-video-output/${fileName}`,
      mimeType: "video/mp4",
      byteSize: bytes.length,
      sha256,
      probe: {
        duration: 14.2,
        width: 1080,
        height: 1920,
        videoCodec: "h264",
        audioCodec: "aac",
      },
      evidence: {
        schemaVersion: "nanowork.text-video-render-evidence/1",
        realDelivery: true,
        template: false,
        mode,
        sentenceCount: 1,
        usage: {
          networkRequests: 1,
          inputTokens: 0,
          outputTokens: 0,
          ttsCharacters: Array.from(body).length,
          ffmpegSegments: 1,
        },
        cost: {
          amount: 12,
          currency: "CNY",
          pricingMode: "route_fixture_verified_output",
        },
        render: {
          width: 1080,
          height: 1920,
          videoCodec: "h264",
          audioCodec: "aac",
        },
      },
    };
  },
};

const service = createTextVideoJobService({ renderer });

function appFor(user) {
  const app = express();
  app.locals.textVideoJobService = service;
  app.use(express.json({ limit: "32mb" }));
  app.use((req, _res, next) =>
    runWithTenant(user.tenant_id, () => {
      req.user = user;
      next();
    }),
  );
  app.use("/text-video", textVideoRoutes);
  app.use("/task-center", taskCenterRoutes);
  app.use((error, _req, res, _next) => {
    res
      .status(Number(error?.status || 500))
      .json({ error: String(error?.message || "请求失败") });
  });
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0);
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(base, pathname, method = "GET", body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test("TextVideo API创建、轮询、下载证据与TaskCenter稳定deepLink形成同一闭环", async () => {
  let jobId;
  await withServer(userA, async (base) => {
    const invalid = await request(base, "/text-video/jobs", "POST", {
      title: "不允许静默纯色",
      body: "没有图片时，系统不能自行决定用纯色背景继续成片，必须由用户明确授权这个选择。",
      mode: "images",
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /显式允许纯色背景/u);

    const created = await request(base, "/text-video/jobs", "POST", {
      title: "真实成片路由测试",
      body: "这条内容会逐句完成真实配音，再合成标题、字幕和画面，最终只有通过编码与账务校验的MP4才能下载。",
      mode: "images",
      allowSolidBackground: true,
      voiceId: "presenter_female",
      bgm: "warm",
    });
    assert.equal(created.status, 202);
    assert.equal(created.body.queued, true);
    jobId = Number(created.body.job.id);

    let current;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      current = await request(base, `/text-video/jobs/${jobId}`);
      if (current.body.job.status === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(current.status, 200);
    assert.equal(current.body.job.status, "done");
    assert.equal(current.body.job.businessUsable, true);
    assert.equal(current.body.job.billing.state, "settled");
    assert.match(
      current.body.job.outputUrl,
      /^\/uploads\/files\/1\/text-video-output\//u,
    );

    const list = await request(base, "/task-center?pageSize=100");
    const task = list.body.items.find(
      (item) => item.sourceKey === `text_video:${jobId}`,
    );
    assert.equal(task.kind, "text_video");
    assert.equal(task.businessUsable, true);
    assert.equal(task.deepLink, `/tasks?kind=text_video&id=${jobId}`);
    assert.equal(task.billing.state, "settled");

    const detail = await request(base, `/task-center/text_video/${jobId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.businessUsable, true);
    assert.equal(detail.body.textVideo.artifactReady, true);
    assert.equal(detail.body.textVideo.renderEvidence.realDelivery, true);
    assert.match(
      detail.body.output,
      /^\/uploads\/files\/1\/text-video-output\//u,
    );
    assert.equal(detail.body.deepLink, `/tasks?kind=text_video&id=${jobId}`);
  });

  await withServer(userB, async (base) => {
    const direct = await request(base, `/text-video/jobs/${jobId}`);
    assert.equal(direct.status, 404);
    const detail = await request(base, `/task-center/text_video/${jobId}`);
    assert.equal(detail.status, 404);
    const list = await request(base, "/task-center?pageSize=100");
    assert.equal(
      list.body.items.some((item) => item.kind === "text_video"),
      false,
    );
  });
});

test("前端成片工作台静态契约包含创建、轮询、取消、重试、下载、费用与显式纯色授权", () => {
  const source = fs.readFileSync(
    path.join(WORKSPACE_ROOT, "web/src/components/TextVideoStudio.tsx"),
    "utf8",
  );
  for (const contract of [
    "/text-video/assets",
    "/text-video/materials",
    "/text-video/jobs",
    "/cancel",
    "/retry",
    "setInterval",
    "billing",
    "businessUsable",
    "allowSolidBackground",
    "download",
  ]) {
    assert.match(source, new RegExp(contract.replaceAll("/", "\\/"), "u"));
  }
});

after(async () => {
  for (const row of q.all(
    "SELECT file_path FROM uploaded_files WHERE purpose LIKE 'text-video-%'",
  )) {
    fs.rmSync(row.file_path, { force: true });
  }
  await fsp.rm(tempRoot, { recursive: true, force: true });
  await removeTempDbSafely(dbPath);
});

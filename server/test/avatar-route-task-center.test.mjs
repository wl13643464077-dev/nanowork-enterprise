import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import test, { after } from "node:test";

const WORKSPACE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const dbPath = path.join(
  os.tmpdir(),
  `nanowork-avatar-route-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"])
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
process.env.NANOWORK_DB = dbPath;
delete process.env.RUNNINGHUB_API_KEY;
delete process.env.YUNWU_API_KEY;

const { initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const { createAvatarJobService } = await import("../src/engines/avatar-job.js");
const { createAvatarRouter } = await import("../src/routes/avatar.js");
const taskCenterRoutes = (await import("../src/routes/task-center.js")).default;

initSchema();
migrateV2();
q.run(
  "UPDATE tenants SET name='路由甲企业',status='已开通',credits=20000 WHERE id=1",
);
q.run(
  "INSERT INTO tenants(id,name,status,credits) VALUES(2,'路由乙企业','已开通',20000)",
);
q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('avatar-route-a','x','甲用户','boss','启用',1)`);
q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('avatar-route-b','x','乙用户','boss','启用',2)`);
const userA = q.get(
  "SELECT id,name,role,tenant_id FROM users WHERE username='avatar-route-a'",
);
const userB = q.get(
  "SELECT id,name,role,tenant_id FROM users WHERE username='avatar-route-b'",
);

const image = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("route-image"),
]);
const audio = Buffer.from("ID3-route-audio");
const video = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom00000000"),
]);

const service = createAvatarJobService({
  provider: {
    ready: () => true,
    async synthesize({ onProgress }) {
      onProgress?.({ phase: "upload_image", message: "上传人物图片" });
      onProgress?.({
        phase: "polling",
        message: "工作流合成中",
        state: "RUNNING",
      });
      return {
        taskId: "route-task-1",
        videoUrl: "https://cdn.example.com/route-avatar.mp4",
        provider: { id: "runninghub", mode: "api" },
        model: "WanVideo InfiniteTalk",
        usage: { networkRequests: 6, inputTokens: 0, outputTokens: 0 },
        costEvidence: { amount: 12, currency: "CNY", source: "route-fixture" },
      };
    },
  },
  prepareAudioFn: async () => ({
    bytes: audio,
    fileName: "bounded.mp3",
    mimeType: "audio/mpeg",
  }),
  downloadVideoFn: async () => ({ bytes: video }),
  voiceClient: {
    async cloneVoice({ label }) {
      return {
        voice: { id: "bossroutevoice", label: `🧬 ${label}` },
        providerAttempt: {
          provider: "yunwu-minimax",
          model: "voice_clone",
          usage: { networkRequests: 2, inputBytes: audio.length },
        },
      };
    },
    async synthesize({ text, voiceId }) {
      return {
        audioUrl: "https://audio.example.com/route-script.mp3",
        providerAttempt: {
          provider: "yunwu-minimax",
          model: "speech-02-hd",
          mode: "api",
          usage: { networkRequests: 1, inputCharacters: text.length, voiceId },
        },
      };
    },
  },
  downloadTtsAudioFn: async () => ({
    bytes: audio,
    fileName: "route-script.mp3",
    mimeType: "audio/mpeg",
  }),
});

function appFor(user) {
  const app = express();
  app.use(express.json({ limit: "32mb" }));
  app.use((req, _res, next) =>
    runWithTenant(user.tenant_id, () => {
      req.user = user;
      next();
    }),
  );
  app.use("/avatar", createAvatarRouter({ service }));
  app.use("/task-center", taskCenterRoutes);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
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

test("Avatar API 上传、创建、轮询、声音克隆与 TaskCenter 投影形成同一闭环", async () => {
  let jobId;
  await withServer(userA, async (base) => {
    const meta = await request(base, "/avatar/meta");
    assert.equal(meta.status, 200);
    assert.equal(meta.body.ttsReady, true);
    assert.deepEqual(
      meta.body.engines.map((item) => item.key),
      ["auto", "runninghub", "heygen", "kling"],
    );
    assert.ok(meta.body.engines.every((item) => item.ready === true));
    assert.ok(
      meta.body.systemVoices.some(
        (item) => item.voiceId === "presenter_female" && item.usable,
      ),
    );

    const uploadedImage = await request(base, "/avatar/assets", "POST", {
      kind: "image",
      name: "老板.png",
      mime: "image/png",
      b64: image.toString("base64"),
    });
    assert.equal(uploadedImage.status, 201);
    const uploadedAudio = await request(base, "/avatar/assets", "POST", {
      kind: "audio",
      name: "老板.mp3",
      mime: "audio/mpeg",
      b64: audio.toString("base64"),
    });
    assert.equal(uploadedAudio.status, 201);

    const cloned = await request(base, "/avatar/voices/clone", "POST", {
      audioFileId: uploadedAudio.body.asset.id,
      label: " 老 板 声 音 ",
    });
    assert.equal(cloned.status, 201);
    assert.equal(cloned.body.voice.usable, true);
    assert.equal(cloned.body.voice.label, "🧬 老板声音");

    const created = await request(base, "/avatar/jobs", "POST", {
      title: "路由数字人工单",
      imageFileId: uploadedImage.body.asset.id,
      audioFileId: uploadedAudio.body.asset.id,
      durationSeconds: 30,
      engine: "runninghub",
      prompt: "自然微笑，正视镜头",
    });
    assert.equal(created.status, 202);
    jobId = Number(created.body.jobId);
    assert.equal(created.body.pollUrl, `/avatar/jobs/${jobId}`);

    let current;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      current = await request(base, `/avatar/jobs/${jobId}`);
      if (current.body.status === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(current.status, 200);
    assert.equal(current.body.status, "done");
    assert.equal(current.body.businessUsable, true);
    assert.equal(current.body.billing.state, "settled");
    assert.match(
      current.body.outputUrl,
      /^\/uploads\/files\/1\/avatar-output\//u,
    );

    const list = await request(base, "/task-center?pageSize=100");
    const avatar = list.body.items.find(
      (item) => item.sourceKey === `avatar:${jobId}`,
    );
    assert.equal(avatar.kind, "avatar");
    assert.equal(avatar.businessUsable, true);
    assert.equal(avatar.deepLink, `/tasks?kind=avatar&id=${jobId}`);
    assert.equal(avatar.billing.state, "settled");

    const detail = await request(base, `/task-center/avatar/${jobId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.businessUsable, true);
    assert.equal(detail.body.avatar.artifactReady, true);
    assert.equal(detail.body.avatar.requestedEngine, "runninghub");
    assert.equal(detail.body.avatar.provider, "runninghub");
    assert.equal(detail.body.avatar.inputMode, "audio");
    assert.equal(detail.body.avatar.usage.networkRequests, 6);
    assert.match(detail.body.output, /^\/uploads\/files\/1\/avatar-output\//u);

    const scriptCreated = await request(base, "/avatar/jobs", "POST", {
      title: "路由脚本数字人工单",
      imageFileId: uploadedImage.body.asset.id,
      audioFileId: null,
      durationSeconds: 15,
      engine: "runninghub",
      script: "这是一条由克隆音色生成的路由口播。",
      voiceId: cloned.body.voice.voiceId,
      prompt: "轻微手势",
    });
    assert.equal(scriptCreated.status, 202);
    const scriptJobId = Number(scriptCreated.body.jobId);
    let scriptCurrent;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      scriptCurrent = await request(base, `/avatar/jobs/${scriptJobId}`);
      if (scriptCurrent.body.status === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(scriptCurrent.body.status, "done");
    assert.equal(scriptCurrent.body.inputMode, "script");
    assert.equal(scriptCurrent.body.requestedEngine, "runninghub");
    assert.equal(scriptCurrent.body.provider, "runninghub");
    assert.equal(scriptCurrent.body.ttsAttempt.provider, "yunwu-minimax");
    const scriptDetail = await request(
      base,
      `/task-center/avatar/${scriptJobId}`,
    );
    assert.equal(scriptDetail.status, 200);
    assert.equal(scriptDetail.body.avatar.inputMode, "script");
    assert.equal(scriptDetail.body.avatar.requestedEngine, "runninghub");
    assert.equal(scriptDetail.body.avatar.provider, "runninghub");
    assert.equal(scriptDetail.body.avatar.ttsAttempt.provider, "yunwu-minimax");
    assert.equal(
      JSON.parse(scriptDetail.body.input).script,
      "这是一条由克隆音色生成的路由口播。",
    );
  });

  await withServer(userB, async (base) => {
    const direct = await request(base, `/avatar/jobs/${jobId}`);
    assert.equal(direct.status, 404);
    const detail = await request(base, `/task-center/avatar/${jobId}`);
    assert.equal(detail.status, 404);
    const list = await request(base, "/task-center?pageSize=100");
    assert.equal(
      list.body.items.some((item) => item.kind === "avatar"),
      false,
    );
  });
});

test("前端摄影棚静态契约包含创建、轮询、取消、重试、费用与声音克隆", () => {
  const source = fs.readFileSync(
    path.join(WORKSPACE_ROOT, "web/src/components/AvatarStudio.tsx"),
    "utf8",
  );
  for (const contract of [
    "/avatar/assets",
    "/avatar/jobs",
    "/avatar/meta",
    "/cancel",
    "/retry",
    "/avatar/voices/clone",
    "billing",
    "businessUsable",
    "setInterval",
    "requestedEngine",
    "inputMode",
    "script",
  ]) {
    assert.match(source, new RegExp(contract.replaceAll("/", "\\/"), "u"));
  }
});

after(() => {
  for (const row of q.all(
    "SELECT file_path FROM uploaded_files WHERE purpose LIKE 'avatar-%'",
  )) {
    fs.rmSync(row.file_path, { force: true });
  }
  for (const suffix of ["", "-wal", "-shm"])
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
});

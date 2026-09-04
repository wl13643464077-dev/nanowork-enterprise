import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dbPath = path.join(os.tmpdir(), `nanowork-avatar-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) {
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.NANOWORK_DB = dbPath;
delete process.env.RUNNINGHUB_API_KEY;
delete process.env.RUNNINGHUB_KEY;
delete process.env.YUNWU_API_KEY;

const { initSchema, migrateV2, q, runWithTenant } = await import(
  "../src/db.js"
);
const {
  createAutoAvatarProvider,
  createAvatarJobService,
  saveAvatarAsset,
  AVATAR_MAX_FREE_RETRIES,
} = await import("../src/engines/avatar-job.js");
const {
  createAvatarProviderAssetUrl,
  serveAvatarProviderAsset,
} = await import("../src/engines/avatar-provider-assets.js");
const { billing } = await import("../src/engines/credits.js");

initSchema();
migrateV2();

// 供应商成本证据 ¥12 → 积分 = ceil(12 × 毛利系数 ÷ creditYuan)；按价目表公式算（系数 1.5 时 1800 分，2.0 时 2400 分）
const creditsForCostYuan = (yuan) => {
  const b = billing();
  return Math.max(1, Math.ceil((yuan * b.marginMultiplier) / b.creditYuan));
};

q.run("UPDATE tenants SET name='甲企业',status='已开通',credits=20000 WHERE id=1");
q.run(
  "INSERT INTO tenants(id,name,status,credits) VALUES(2,'乙企业','已开通',20000)",
);
q.run(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('avatar-owner-a','x','甲老板','boss','启用',1)`,
);
q.run(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('avatar-owner-b','x','乙老板','boss','启用',2)`,
);
const userA = q.get(
  "SELECT id,name,role,tenant_id FROM users WHERE username='avatar-owner-a'",
);
const userB = q.get(
  "SELECT id,name,role,tenant_id FROM users WHERE username='avatar-owner-b'",
);

const IMAGE = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("avatar-image"),
]);
const AUDIO = Buffer.from("ID3-avatar-audio-sample");
const VIDEO = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftyp"),
  Buffer.from("isom"),
  Buffer.from("00000000"),
]);

async function assetsFor(user) {
  return runWithTenant(user.tenant_id, async () => {
    const image = await saveAvatarAsset({
      user,
      name: "portrait.png",
      mime: "image/png",
      b64: IMAGE.toString("base64"),
      kind: "image",
    });
    const audio = await saveAvatarAsset({
      user,
      name: "voice.mp3",
      mime: "audio/mpeg",
      b64: AUDIO.toString("base64"),
      kind: "audio",
    });
    return { image, audio };
  });
}

const assetsA = await assetsFor(userA);
const assetsB = await assetsFor(userB);

function successfulProvider(overrides = {}) {
  return {
    ready: () => true,
    async synthesize({ signal, onProgress }) {
      if (signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "RUNNINGHUB_CANCELLED" });
      onProgress?.({ phase: "upload_image", message: "upload image" });
      onProgress?.({ phase: "upload_audio", message: "upload audio" });
      onProgress?.({ phase: "accepted", message: "accepted" });
      return {
        taskId: "rh-avatar-001",
        videoUrl: "https://cdn.example.com/avatar/result.mp4",
        provider: { id: "runninghub", mode: "api" },
        model: "WanVideo InfiniteTalk",
        usage: {
          networkRequests: 6,
          inputTokens: 0,
          outputTokens: 0,
          tokenUsageApplicable: false,
        },
        costEvidence: {
          amount: 12,
          currency: "CNY",
          source: "test-price",
          ...overrides.costEvidence,
        },
      };
    },
    ...overrides,
  };
}

function serviceFor(provider, overrides = {}) {
  return createAvatarJobService({
    provider,
    prepareAudioFn: async ({ durationSeconds }) => ({
      bytes: AUDIO,
      fileName: `bounded-${durationSeconds}.mp3`,
      mimeType: "audio/mpeg",
    }),
    downloadVideoFn: async () => ({ bytes: VIDEO }),
    voiceClient: {
      async cloneVoice({ label }) {
        return {
          voice: { id: "bossfixturevoice", label: `🧬 ${label}` },
          providerAttempt: {
            provider: "yunwu-minimax",
            model: "voice_clone",
            usage: { networkRequests: 2, inputBytes: AUDIO.length },
          },
        };
      },
    },
    ...overrides,
  });
}

async function createJob(service, user = userA, assets = assetsA) {
  return runWithTenant(user.tenant_id, () =>
    service.createJob({
      user,
      title: "老板数字人口播",
      imageFileId: assets.image.id,
      audioFileId: assets.audio.id,
      durationSeconds: 30,
    }),
  );
}

test("真实基础版闭环只在成片落库且账务结算后可用", async () => {
  const service = serviceFor(successfulProvider());
  const before = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  const created = await createJob(service);
  assert.equal(created.status, "queued");
  assert.equal(created.billing.state, "held");
  const done = await service.runJob(created.id, 1);
  assert.equal(done.status, "done");
  assert.equal(done.billing.state, "settled");
  assert.equal(done.businessUsable, true);
  assert.match(done.outputUrl, /^\/uploads\/files\/1\/avatar-output\//u);
  assert.match(done.resultSha256, /^[a-f0-9]{64}$/u);
  assert.equal(done.usage.networkRequests, 6);
  assert.equal(done.cost.amount, 12);
  assert.equal(before - q.get("SELECT credits FROM tenants WHERE id=1").credits, creditsForCostYuan(12));
  const output = q.get(
    "SELECT purpose,size,file_path FROM uploaded_files WHERE tenant_id=1 AND id=?",
    q.get("SELECT output_file_id FROM avatar_jobs WHERE tenant_id=1 AND id=?", created.id).output_file_id,
  );
  assert.equal(output.purpose, "avatar-output");
  assert.equal(fs.readFileSync(output.file_path).equals(VIDEO), true);
});

test("上游失败全额退款，原工单最多三次免费重试且不重复扣费", async () => {
  let fail = true;
  const provider = successfulProvider({
    async synthesize(payload) {
      if (fail) {
        const error = new Error("RunningHub 工作流执行失败");
        error.name = "RunningHubError";
        error.code = "RUNNINGHUB_WORKFLOW_FAILED";
        throw error;
      }
      return successfulProvider().synthesize(payload);
    },
  });
  const service = serviceFor(provider);
  const before = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  const created = await createJob(service);
  const failed = await service.runJob(created.id, 1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.billing.state, "released");
  assert.equal(q.get("SELECT credits FROM tenants WHERE id=1").credits, before);
  fail = false;
  const retried = await runWithTenant(1, () => service.retryJob(userA, created.id));
  assert.equal(retried.billingStatus, "included");
  assert.equal(retried.retryCount, 1);
  const done = await service.runJob(created.id, 1);
  assert.equal(done.status, "done");
  assert.equal(done.billing.state, "not_required");
  assert.equal(done.businessUsable, true);
  assert.equal(q.get("SELECT credits FROM tenants WHERE id=1").credits, before);
  assert.equal(done.freeRetriesRemaining, AVATAR_MAX_FREE_RETRIES - 1);
});

test("取消 queued/running 工单均收口且全退", async () => {
  const service = serviceFor(successfulProvider());
  const before = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  const queued = await createJob(service);
  const cancelledQueued = runWithTenant(1, () => service.cancelJob(userA, queued.id));
  assert.equal(cancelledQueued.status, "cancelled");
  assert.equal(cancelledQueued.billing.state, "released");
  assert.equal(q.get("SELECT credits FROM tenants WHERE id=1").credits, before);

  let accepted;
  const blockingProvider = successfulProvider({
    async synthesize({ signal }) {
      accepted?.();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("RunningHub 数字人任务已取消");
          error.name = "RunningHubError";
          error.code = "RUNNINGHUB_CANCELLED";
          reject(error);
        }, { once: true });
        void resolve;
      });
    },
  });
  const runningService = serviceFor(blockingProvider);
  const running = await createJob(runningService);
  const started = new Promise(resolve => { accepted = resolve; });
  const work = runningService.runJob(running.id, 1);
  await started;
  const cancelledRunning = runWithTenant(1, () => runningService.cancelJob(userA, running.id));
  assert.equal(cancelledRunning.status, "cancelled");
  assert.equal(cancelledRunning.billing.state, "released");
  assert.equal((await work).status, "cancelled");
  assert.equal(q.get("SELECT credits FROM tenants WHERE id=1").credits, before);
});

test("启动恢复会退回中断 running 工单，并重新调度 queued 工单", async () => {
  const service = serviceFor(successfulProvider());
  const before = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  const interrupted = await createJob(service);
  q.run(
    "UPDATE avatar_jobs SET status='running' WHERE tenant_id=1 AND id=?",
    interrupted.id,
  );
  const report = service.recoverAndSchedule({ tenantId: 1 });
  assert.ok(report.some(item => item.id === interrupted.id && item.action === "released_interrupted"));
  const recovered = runWithTenant(1, () => service.getJob(userA, interrupted.id));
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.billing.state, "released");
  assert.equal(q.get("SELECT credits FROM tenants WHERE id=1").credits, before);

  const queued = await createJob(service);
  const queuedReport = service.recoverAndSchedule({ tenantId: 1 });
  assert.ok(queuedReport.some(item => item.id === queued.id && item.action === "rescheduled"));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = runWithTenant(1, () => service.getJob(userA, queued.id));
    if (current.status === "done") break;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(runWithTenant(1, () => service.getJob(userA, queued.id)).status, "done");
});

test("租户文件、工单与声音克隆都不可跨租户读取", async () => {
  const service = serviceFor(successfulProvider());
  await assert.rejects(
    runWithTenant(2, () =>
      service.createJob({
        user: userB,
        imageFileId: assetsA.image.id,
        audioFileId: assetsB.audio.id,
        durationSeconds: 15,
      }),
    ),
    /不存在或无权引用/u,
  );
  const job = await createJob(service);
  assert.throws(
    () => runWithTenant(2, () => service.getJob(userB, job.id)),
    /不存在或无权查看/u,
  );
  runWithTenant(1, () => service.cancelJob(userA, job.id));

  const before = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  const voice = await runWithTenant(1, () =>
    service.cloneVoice({
      user: userA,
      audioFileId: assetsA.audio.id,
      label: "  老板 的 声音 标签超长  ",
    }),
  );
  assert.equal(voice.usable, true);
  assert.equal(voice.label, "🧬 老板的声音标签超长");
  assert.equal(voice.billing.state, "settled");
  assert.equal(runWithTenant(2, () => service.listVoices(userB)).length, 0);
  assert.ok(q.get("SELECT credits FROM tenants WHERE id=1").credits < before);
});

test("缺 RunningHub 配置时在占扣和网络前失败关闭", async () => {
  let called = 0;
  const service = createAvatarJobService({
    provider: {
      ready: () => false,
      async synthesize() {
        called += 1;
      },
    },
  });
  const before = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  await assert.rejects(createJob(service), /未配置服务端凭据/u);
  assert.equal(called, 0);
  assert.equal(q.get("SELECT credits FROM tenants WHERE id=1").credits, before);
});

test("硬超时会主动结束不响应 abort 的上游并全额退款", async () => {
  const provider = successfulProvider({
    async synthesize() {
      await new Promise(() => {});
    },
  });
  const service = serviceFor(provider, { hardTimeoutMs: 10 });
  const before = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  const created = await createJob(service);
  const failed = await service.runJob(created.id, 1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "AVATAR_HARD_TIMEOUT");
  assert.equal(failed.billing.state, "released");
  assert.equal(failed.businessUsable, false);
  assert.equal(q.get("SELECT credits FROM tenants WHERE id=1").credits, before);
});

test("缺少真实费用证据时保留预授权并转待对账", async () => {
  const provider = successfulProvider({
    async synthesize(payload) {
      const result = await successfulProvider().synthesize(payload);
      return { ...result, costEvidence: { amount: null, currency: "CNY" } };
    },
  });
  const service = serviceFor(provider);
  const before = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  const created = await createJob(service);
  const heldBalance = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  assert.ok(heldBalance < before);
  const failed = await service.runJob(created.id, 1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "AVATAR_BILLING_EVIDENCE_MISSING");
  assert.equal(failed.billingStatus, "pending_reconciliation");
  assert.equal(failed.billing.state, "pending_reconciliation");
  assert.equal(failed.businessUsable, false);
  assert.equal(q.get("SELECT credits FROM tenants WHERE id=1").credits, heldBalance);
});

test("MiniMax 声音克隆失败会持久化失败态并全额退款", async () => {
  const service = serviceFor(successfulProvider(), {
    voiceClient: {
      async cloneVoice() {
        const error = new Error("MiniMax 声音克隆上游失败");
        error.name = "MiniMaxVoiceError";
        error.code = "MINIMAX_VOICE_CLONE_FAILED";
        throw error;
      },
    },
  });
  const before = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  await assert.rejects(
    runWithTenant(1, () =>
      service.cloneVoice({
        user: userA,
        audioFileId: assetsA.audio.id,
        label: "失败退款声纹",
      }),
    ),
    /预授权已全额退回/u,
  );
  assert.equal(q.get("SELECT credits FROM tenants WHERE id=1").credits, before);
  const failed = q.get(
    "SELECT status,billing_status,error_code FROM avatar_voices WHERE tenant_id=1 ORDER BY id DESC LIMIT 1",
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.billing_status, "released");
  assert.equal(failed.error_code, "MINIMAX_VOICE_CLONE_FAILED");
});

test("显式 HeyGen 工单可把系统音色口播稿先转成真实音频并记录双供应商证据", async () => {
  const providerContexts = [];
  let providerPayload;
  let ttsPayload;
  let downloadedUrl;
  const heygen = successfulProvider({
    providerName: "heygen",
    async synthesize(payload) {
      providerPayload = payload;
      const result = await successfulProvider().synthesize(payload);
      return {
        ...result,
        taskId: "heygen-script-001",
        providerName: "heygen",
        provider: { id: "heygen", mode: "api" },
        model: "Avatar IV",
      };
    },
  });
  const service = serviceFor(heygen, {
    providerFactory(context) {
      providerContexts.push({ ...context });
      return heygen;
    },
    voiceClient: {
      async synthesize(payload) {
        ttsPayload = payload;
        return {
          audioUrl: "https://audio.example.com/minimax-script.mp3",
          providerAttempt: {
            provider: "yunwu-minimax",
            model: "speech-02-hd",
            mode: "api",
            usage: { networkRequests: 1, inputCharacters: payload.text.length },
          },
        };
      },
    },
    async downloadTtsAudioFn({ url }) {
      downloadedUrl = url;
      return { bytes: AUDIO, fileName: "tts.mp3", mimeType: "audio/mpeg" };
    },
  });
  const before = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  const created = await runWithTenant(1, () =>
    service.createJob({
      user: userA,
      title: "HeyGen 稿件口播",
      imageFileId: assetsA.image.id,
      audioFileId: null,
      durationSeconds: 30,
      engine: "heygen",
      script: "这是系统音色生成的真实口播稿。",
      voiceId: "presenter_female",
      prompt: "  自然微笑\n正视镜头  ",
    }),
  );
  assert.equal(created.inputMode, "script");
  assert.equal(created.audioFileId, null);
  assert.equal(created.requestedEngine, "heygen");
  assert.equal(created.voiceId, "presenter_female");
  const done = await service.runJob(created.id, 1);
  assert.equal(done.status, "done");
  assert.equal(done.provider, "heygen");
  assert.equal(done.billing.state, "settled");
  assert.equal(done.ttsAttempt.provider, "yunwu-minimax");
  assert.equal(ttsPayload.text, "这是系统音色生成的真实口播稿。");
  assert.equal(ttsPayload.voiceId, "presenter_female");
  assert.equal(downloadedUrl, "https://audio.example.com/minimax-script.mp3");
  assert.equal(providerPayload.audio.bytes.equals(AUDIO), true);
  assert.equal(providerPayload.prompt, "自然微笑 正视镜头");
  assert.ok(providerContexts.length >= 2);
  assert.ok(providerContexts.every((item) => item.engineRequested === "heygen"));
  const stored = q.get(
    "SELECT input_mode,audio_file_id,script,voice_id,engine_requested,billing_model FROM avatar_jobs WHERE tenant_id=1 AND id=?",
    created.id,
  );
  assert.equal(stored.input_mode, "script");
  assert.equal(stored.audio_file_id, null);
  assert.equal(stored.engine_requested, "heygen");
  assert.equal(stored.billing_model, "heygen-avatar-30");
  assert.equal(before - q.get("SELECT credits FROM tenants WHERE id=1").credits, creditsForCostYuan(12));
});

test("脚本音色和显式引擎不可用都会在建单占扣前失败关闭", async () => {
  let providerCalls = 0;
  const unavailable = createAvatarJobService({
    providerFactory({ engineRequested }) {
      assert.equal(engineRequested, "kling");
      return {
        providerName: "kling",
        ready: () => false,
        async synthesize() {
          providerCalls += 1;
        },
      };
    },
    voiceClient: { async synthesize() {} },
  });
  const beforeCredits = q.get("SELECT credits FROM tenants WHERE id=1").credits;
  const beforeJobs = q.get("SELECT COUNT(*) total FROM avatar_jobs WHERE tenant_id=1").total;
  await assert.rejects(
    runWithTenant(1, () =>
      unavailable.createJob({
        user: userA,
        imageFileId: assetsA.image.id,
        audioFileId: assetsA.audio.id,
        durationSeconds: 15,
        engine: "kling",
      }),
    ),
    /未配置服务端凭据/u,
  );
  assert.equal(providerCalls, 0);
  assert.equal(q.get("SELECT credits FROM tenants WHERE id=1").credits, beforeCredits);
  assert.equal(
    q.get("SELECT COUNT(*) total FROM avatar_jobs WHERE tenant_id=1").total,
    beforeJobs,
  );

  const service = serviceFor(successfulProvider(), {
    voiceClient: { async synthesize() {} },
  });
  await assert.rejects(
    runWithTenant(1, () =>
      service.createJob({
        user: userA,
        imageFileId: assetsA.image.id,
        audioFileId: null,
        durationSeconds: 15,
        engine: "heygen",
        script: "无权音色不能调用配音。",
        voiceId: "missing-cloned-voice",
      }),
    ),
    /不存在、尚未结算或无权使用/u,
  );
  assert.equal(q.get("SELECT credits FROM tenants WHERE id=1").credits, beforeCredits);
  assert.equal(
    q.get("SELECT COUNT(*) total FROM avatar_jobs WHERE tenant_id=1").total,
    beforeJobs,
  );
});

test("默认可灵通道即使有 API key，缺少公网素材根地址也不会被标成可用或产生占扣", async () => {
  const keys = [
    "YUNWU_API_KEY",
    "AVATAR_PROVIDER_PUBLIC_BASE_URL",
    "PUBLIC_BASE_URL",
    "APP_PUBLIC_URL",
    "RUNNINGHUB_API_KEY",
    "RUNNINGHUB_KEY",
    "HEYGEN_API_KEY",
    "HEYGEN_KEY",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.YUNWU_API_KEY = "offline-kling-key";
    for (const key of keys.slice(1)) process.env[key] = "";
    const service = createAvatarJobService();
    const meta = await runWithTenant(1, () => service.getMeta(userA));
    assert.equal(
      meta.engines.find((item) => item.key === "kling").ready,
      false,
    );
    assert.equal(
      meta.engines.find((item) => item.key === "auto").ready,
      false,
    );
    const beforeCredits = q.get("SELECT credits FROM tenants WHERE id=1").credits;
    const beforeJobs = q.get(
      "SELECT COUNT(*) total FROM avatar_jobs WHERE tenant_id=1",
    ).total;
    await assert.rejects(
      runWithTenant(1, () =>
        service.createJob({
          user: userA,
          imageFileId: assetsA.image.id,
          audioFileId: assetsA.audio.id,
          durationSeconds: 15,
          engine: "kling",
        }),
      ),
      /未配置服务端凭据/u,
    );
    assert.equal(
      q.get("SELECT credits FROM tenants WHERE id=1").credits,
      beforeCredits,
    );
    assert.equal(
      q.get("SELECT COUNT(*) total FROM avatar_jobs WHERE tenant_id=1").total,
      beforeJobs,
    );
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("只有 auto 会按 HeyGen→可灵回退，且实际引擎与尝试链写入账务工单", async () => {
  const calls = [];
  const heygen = {
    providerName: "heygen",
    ready: () => true,
    async synthesize() {
      calls.push("heygen");
      throw Object.assign(new Error("HeyGen render failed"), {
        name: "HeyGenAvatarError",
        code: "HEYGEN_RENDER_FAILED",
        status: 502,
      });
    },
  };
  const kling = {
    providerName: "kling",
    ready: () => true,
    async synthesize(payload) {
      calls.push("kling");
      const result = await successfulProvider().synthesize(payload);
      return {
        ...result,
        taskId: "kling-fallback-001",
        providerName: "kling",
        provider: { id: "kling", mode: "api" },
        model: "kling-avatar-image2video",
        costEvidence: { amount: 16, currency: "CNY", source: "test-price" },
      };
    },
  };
  const autoProvider = createAutoAvatarProvider([
    { engine: "heygen", provider: heygen },
    { engine: "kling", provider: kling },
  ]);
  const service = serviceFor(autoProvider);
  const created = await runWithTenant(1, () =>
    service.createJob({
      user: userA,
      title: "自动回退数字人",
      imageFileId: assetsA.image.id,
      audioFileId: assetsA.audio.id,
      durationSeconds: 30,
      engine: "auto",
    }),
  );
  const done = await service.runJob(created.id, 1);
  assert.equal(done.status, "done");
  assert.equal(done.requestedEngine, "auto");
  assert.equal(done.provider, "kling");
  assert.deepEqual(calls, ["heygen", "kling"]);
  const evidence = JSON.parse(
    q.get(
      "SELECT provider_result_json FROM avatar_jobs WHERE tenant_id=1 AND id=?",
      created.id,
    ).provider_result_json,
  );
  assert.equal(evidence.requestedEngine, "auto");
  assert.equal(evidence.actualProvider, "kling");
  assert.deepEqual(evidence.fallbackAttempts, [
    { provider: "heygen", status: "failed", code: "HEYGEN_RENDER_FAILED" },
    { provider: "kling", status: "succeeded" },
  ]);

  calls.length = 0;
  const explicit = serviceFor(heygen, {
    providerFactory({ engineRequested }) {
      assert.equal(engineRequested, "heygen");
      return heygen;
    },
  });
  const explicitJob = await runWithTenant(1, () =>
    explicit.createJob({
      user: userA,
      imageFileId: assetsA.image.id,
      audioFileId: assetsA.audio.id,
      durationSeconds: 15,
      engine: "heygen",
    }),
  );
  const failed = await explicit.runJob(explicitJob.id, 1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.billing.state, "released");
  assert.deepEqual(calls, ["heygen"]);
});

test("可灵编排只发布短期签名 HTTPS 素材并在任务结束后清理临时音频", async () => {
  const published = [];
  let providerPayload;
  const kling = successfulProvider({
    providerName: "kling",
    requiresPublicAssetUrls: true,
    async synthesize(payload) {
      providerPayload = payload;
      const result = await successfulProvider().synthesize(payload);
      return {
        ...result,
        taskId: "kling-public-assets-001",
        providerName: "kling",
        provider: { id: "kling", mode: "api" },
        costEvidence: { amount: 16, currency: "CNY", source: "test-price" },
      };
    },
  });
  const service = serviceFor(kling, {
    publicAssetUrlFactory(file, context) {
      published.push({ file: { ...file }, context: { ...context } });
      return `https://assets.example.com/avatar/${file.id}`;
    },
  });
  const created = await runWithTenant(1, () =>
    service.createJob({
      user: userA,
      imageFileId: assetsA.image.id,
      audioFileId: assetsA.audio.id,
      durationSeconds: 30,
      engine: "kling",
    }),
  );
  const done = await service.runJob(created.id, 1);
  assert.equal(done.status, "done");
  assert.equal(done.provider, "kling");
  assert.equal(providerPayload.image.publicUrl, `https://assets.example.com/avatar/${assetsA.image.id}`);
  assert.match(providerPayload.audio.publicUrl, /^https:\/\/assets\.example\.com\/avatar\/\d+$/u);
  assert.equal(published.length, 2);
  assert.equal(published[0].file.purpose, "avatar-image");
  assert.equal(published[1].file.purpose, "avatar-provider-audio");
  assert.ok(published.every((item) => item.context.tenantId === 1));
  assert.equal(
    q.get(
      "SELECT COUNT(*) total FROM uploaded_files WHERE tenant_id=1 AND purpose='avatar-provider-audio'",
    ).total,
    0,
  );
  assert.equal(fs.existsSync(published[1].file.file_path), false);
});

test("供应商素材签名只服务绑定租户文件，且拒绝内网公开根地址与篡改令牌", () => {
  const imageRow = q.get(
    "SELECT * FROM uploaded_files WHERE tenant_id=1 AND id=?",
    assetsA.image.id,
  );
  assert.equal(
    createAvatarProviderAssetUrl(
      { tenantId: 1, fileId: imageRow.id, purpose: imageRow.purpose },
      { publicBaseUrl: "https://127.0.0.1" },
    ),
    null,
  );
  const signedUrl = createAvatarProviderAssetUrl(
    { tenantId: 1, fileId: imageRow.id, purpose: imageRow.purpose },
    { publicBaseUrl: "https://media.example.com" },
  );
  assert.match(signedUrl, /^https:\/\/media\.example\.com\/api\/avatar\/provider-assets\//u);
  const token = decodeURIComponent(new URL(signedUrl).pathname.split("/").at(-1));
  const served = { statusCode: 200, headers: {}, file: null, ended: false };
  const response = {
    status(code) {
      served.statusCode = code;
      return this;
    },
    end() {
      served.ended = true;
    },
    setHeader(name, value) {
      served.headers[name] = value;
    },
    sendFile(file, callback) {
      served.file = file;
      callback?.();
    },
    get headersSent() {
      return false;
    },
  };
  serveAvatarProviderAsset({ params: { token } }, response);
  assert.equal(served.statusCode, 200);
  assert.equal(served.file, fs.realpathSync(imageRow.file_path));
  assert.equal(served.headers["Content-Type"], "image/png");
  assert.equal(served.headers["Cache-Control"], "private, no-store, max-age=0");

  served.statusCode = 200;
  served.ended = false;
  serveAvatarProviderAsset({ params: { token: `${token}x` } }, response);
  assert.equal(served.statusCode, 404);
  assert.equal(served.ended, true);
});

after(() => {
  const files = q.all(
    "SELECT file_path FROM uploaded_files WHERE purpose LIKE 'avatar-%'",
  );
  for (const row of files) fs.rmSync(row.file_path, { force: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

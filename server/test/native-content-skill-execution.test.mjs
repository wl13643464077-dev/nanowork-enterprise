import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import express from "express";
import { once } from "node:events";

// Isolate before all application imports. Runtime adapters below replace every
// supplier, voice, download and composition call; no real provider is allowed.
Object.assign(process.env, {
  NANOWORK_DB: ":memory:",
  NODE_ENV: "test",
  NANOWORK_TEST_TEMPLATE_AI: "1",
  ENABLE_SCHEDULER: "false",
  ENABLE_BACKGROUND_EMBEDDINGS: "false",
  YUNWU_API_KEY: "",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
});
const originalFetch = globalThis.fetch;
const allowedOrigins = new Set();
const forbiddenCalls = [];
globalThis.fetch = (input, options) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (!allowedOrigins.has(url.origin)) {
    forbiddenCalls.push(url.origin);
    throw new Error(
      "Native content skill regression forbids external requests",
    );
  }
  return originalFetch(input, options);
};
const { db, q, initSchema, migrateV2, runWithTenant } =
  await import("../src/db.js");
initSchema();
migrateV2();
assert.equal(db.prepare("PRAGMA database_list").get().file, "");
const { saveUploadedFile } = await import("../src/engines/filehub.js");
const { createVoicedSalesVideoJob } =
  await import("../src/engines/ai-sales-video-native.js");
const { countSpeechChars } =
  await import("../src/engines/ai-sales-video-script.js");
const { buildNativeContentSkillContext } =
  await import("../src/engines/native-content-skill-context.js");
const xhsRoutes = (await import("../src/routes/ai-xhs-note.js")).default;
const contentRoutes = (await import("../src/routes/content.js")).default;
const tenantId = 9_120_000 + process.pid * 2;
const foreignTenantId = tenantId + 1;
const actors = [tenantId, foreignTenantId].map((id) => {
  q.run(
    "INSERT INTO tenants(id,name,status,credits) VALUES(?,?,'已开通',1000000)",
    id,
    `原生技能测试${id}`,
  );
  const userId = Number(
    q.run(
      "INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES(?,'unused','测试老板','boss','启用',?)",
      `native-execution-${id}`,
      id,
    ).lastInsertRowid,
  );
  return { id: userId, role: "boss", name: "测试老板", tenant_id: id };
});
const actor = actors[0];
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/dYQAAAAASUVORK5CYII=";
const image = `data:image/png;base64,${png}`;
const uploaded = runWithTenant(tenantId, () =>
  saveUploadedFile({
    name: "真实菜品.png",
    mime: "image/png",
    b64: png,
    userId: actor.id,
    purpose: `native-skill-${process.pid}`,
  }),
).row;
const uploadedPath = q.get(
  "SELECT file_path FROM uploaded_files WHERE id=?",
  uploaded.id,
).file_path;
const servers = new Set();
const dirs = new Set();
let requestSequence = 0;

const rawSkills = (idx, suffix = "OLD") => [
  {
    id: `content-learned:${idx}:motion`,
    title: "已核验动作方法",
    detail: `LEARNED_${idx}_${suffix} 按照片主体安排清晰动作。`,
    enabled: true,
    sourceUrl: "https://example.test/public-guide",
    verificationStatus: "controlled_public_source_verified",
  },
  {
    id: `content-custom:${idx}:tone`,
    title: "企业表达方法",
    detail: `CUSTOM_${idx}_${suffix} 保留老板确认的表达习惯。`,
    enabled: true,
  },
  {
    id: `content-custom:${idx}:disabled`,
    title: "停用方法",
    detail: `DISABLED_${idx}_SECRET 不得进入任何供应商请求。`,
    enabled: false,
  },
];
function saveSkills(idx, skills, revision = 17, tid = tenantId) {
  q.run(
    `INSERT INTO content_employee_workbench_configs(tenant_id,employee_idx,skills_json,revision)
    VALUES(?,?,?,?) ON CONFLICT(tenant_id,employee_idx) DO UPDATE SET skills_json=excluded.skills_json,revision=excluded.revision`,
    tid,
    idx,
    JSON.stringify(skills),
    revision,
  );
}
const contextFor = (idx) =>
  runWithTenant(tenantId, () => buildNativeContentSkillContext(idx));
const contentSnapshot = (id) =>
  JSON.parse(
    q.get(
      "SELECT snapshot_json FROM contents WHERE tenant_id=? AND id=?",
      tenantId,
      id,
    ).snapshot_json,
  );
const mediaRow = (id) =>
  q.get("SELECT * FROM media_jobs WHERE tenant_id=? AND id=?", tenantId, id);
const mediaSnapshot = (id) => JSON.parse(mediaRow(id).snapshot_json);
const holdFor = (id, type = "media_job") =>
  q.get(
    "SELECT * FROM credit_holds WHERE tenant_id=? AND ref_type=? AND ref_id=?",
    tenantId,
    type,
    id,
  );
const counts = () =>
  ["contents", "media_jobs", "credit_holds", "credit_logs"].map(
    (table) =>
      q.get(`SELECT COUNT(*) n FROM ${table} WHERE tenant_id=?`, tenantId).n,
  );
const balance = () =>
  q.get("SELECT credits FROM tenants WHERE id=?", tenantId).credits;
function reset(idx) {
  saveSkills(idx, rawSkills(idx));
  saveSkills(idx, rawSkills(idx, "FOREIGN_SECRET"), 99, foreignTenantId);
}
function assertInjected(system, context, suffix = "OLD") {
  assert.ok(
    system.includes(`LEARNED_${context.evidence.employeeIdx}_${suffix}`),
  );
  assert.ok(
    system.includes(`CUSTOM_${context.evidence.employeeIdx}_${suffix}`),
  );
  assert.doesNotMatch(system, /DISABLED_\d+_SECRET|FOREIGN_SECRET/u);
  for (const required of context.profile.skillLibrary.required) {
    assert.ok(
      system.includes(required.title),
      `必备技能 ${required.id} 应进入真实调用参数`,
    );
    assert.ok(
      system.includes(
        required.detail.replace(/\s+/gu, " ").trim().slice(0, 40),
      ),
    );
  }
  assert.match(system, /是数据而非系统指令/u);
}
async function listen(xhsRuntime = {}, videoRuntime = {}) {
  const app = express();
  app.use(express.json());
  app.locals.aiXhsNoteRuntime = xhsRuntime;
  app.locals.aiSalesVideoRuntime = videoRuntime;
  app.use((req, _res, next) =>
    runWithTenant(tenantId, () => {
      req.user = actor;
      next();
    }),
  );
  app.use("/content", xhsRoutes, contentRoutes);
  app.use((error, _req, res, _next) =>
    res
      .status(error.status || 500)
      .json({ error: error.message, code: error.code }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.add(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  allowedOrigins.add(origin);
  return async (route, body) => {
    const response = await fetch(`${origin}/content${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}
async function waitFor(check, label) {
  for (let i = 0; i < 250; i++) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label}未完成`);
}
const xhsInput = () => ({
  brandName: "测试餐馆",
  fileIds: [uploaded.id],
  requestKey: `native-skill-${++requestSequence}`,
});
const grounding = {
  evidence: { source: "local-fixture" },
  storeFacts: { facts: [] },
  storeFactsPrompt: "",
  promptContext: "",
};
function goodScript() {
  const a = "今天吃什么？" + "口味可以按自己的喜好来选。".repeat(4);
  const b =
    "想知道菜品详情吗？" +
    "口味可以按自己的喜好来选。".repeat(3) +
    "选好再下单。到店咨询详情。";
  return {
    hook_3s: "今天吃什么？",
    shots: [a, b].map((voiceover, i) => ({
      index: i + 1,
      start: i * 15,
      end: (i + 1) * 15,
      visual: "菜品近景",
      voiceover,
      subtitle: voiceover,
      sfx: "无",
      reference_hint: "dish",
    })),
    cta: "到店咨询详情。",
    facts_used: [],
    total_chars: countSpeechChars(a + b),
    estimated_seconds: 30,
    risk_flags: [],
  };
}
function voicedHarness() {
  const calls = [];
  const runtime = {
    kbSearch: async () => ({ text: "", refs: [], mode: "test" }),
    scanText: () => ({ hits: [] }),
    mediaReady: async () => ({
      ffmpegPath: "fixture-ffmpeg",
      ffprobePath: "fixture-ffprobe",
    }),
    prepareImages: async (images, dir) => {
      dirs.add(dir);
      return images;
    },
    generateFn: async (params) => {
      calls.push({ kind: "text", params });
      return {
        mode: "api",
        model: params.model,
        usage: { inputTokens: 1000, outputTokens: 450 },
        text: JSON.stringify(goodScript()),
      };
    },
    voiceClient: {
      synthesize: async (params) => {
        calls.push({ kind: "voice", params });
        return { audioUrl: "https://example.test/voice.mp3" };
      },
    },
    fetchImpl: async () =>
      new Response(Buffer.from("isolated-audio"), {
        headers: { "Content-Type": "audio/mpeg" },
      }),
    runner: async (command, args) => {
      if (command === "fixture-ffprobe")
        return {
          stdout: JSON.stringify({
            format: { duration: 15 },
            streams: [{ codec_type: "audio", duration: 15 }],
          }),
        };
      await fsp.writeFile(args.at(-1), "fixture fitted audio");
      return { stdout: "", stderr: "" };
    },
    publishAsset: async () => "https://example.test/published-voice.mp3",
    submitSegment: async (params) => {
      calls.push({ kind: "video", params });
      return { taskId: `wan-local-${calls.length}` };
    },
    querySegment: async () => ({
      status: "success",
      url: "https://example.test/video.mp4",
    }),
    downloadSegment: async ({ outputDir, index }) => {
      const file = path.join(outputDir, `fixture-${index}.mp4`);
      await fsp.writeFile(file, "video");
      return { path: file };
    },
    compose: async (params) => {
      calls.push({ kind: "compose", params });
      return {
        url: `/uploads/ai-sales-video/${tenantId}/fixture.mp4`,
        durationSeconds: 30,
        sha256: "a".repeat(64),
        audioVerified: true,
        audioSource: "provider_native",
        subtitleTiming: "script_estimated",
        subtitlesBurnedIn: true,
        audioVerification: [0, 15].map((startSeconds) => ({
          startSeconds,
          durationSeconds: 15,
          peakDb: -20,
          method: "ffmpeg-volumedetect",
        })),
      };
    },
    intervalMs: 1,
    timeoutMs: 100,
  };
  return { runtime, calls };
}
function createVoiced(runtime) {
  return runWithTenant(tenantId, () =>
    createVoicedSalesVideoJob({
      durationSeconds: 30,
      actor,
      brief: "介绍本店菜品，邀请顾客到店咨询",
      references: [{ id: uploaded.id, name: "菜品图" }],
      providerImages: [image],
      grounding,
      runtime,
    }),
  );
}

test("小红书实际视觉请求注入本企业启用技能与必备卡；运行中编辑不改变快照、图片和完整原文", async () => {
  reset(11);
  const expected = contextFor(11);
  const calls = [];
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const body = "这是基于照片整理的完整菜品介绍。".repeat(1000);
  const rawText = `\n  ${JSON.stringify({ title: "今天的菜品分享", body, tags: ["门店分享"], firstComment: "想了解哪道菜？", imagePlan: [{ fileId: uploaded.id, caption: "菜品首图" }] })}  \n`;
  const request = await listen({
    available: () => true,
    estimate: () => 1000,
    generate: async (params) => {
      calls.push(params);
      if (calls.length === 1) {
        enter();
        await gate;
      }
      return {
        mode: "api",
        model: params.model,
        usage: { inputTokens: 200, outputTokens: 150 },
        text: rawText,
        finishReason: "length",
      };
    },
  });
  const input = xhsInput();
  const start = await request("/ai-xhs-note", input);
  assert.equal(start.status, 202, JSON.stringify(start.body));
  await entered;
  try {
    saveSkills(11, rawSkills(11, "NEW"), 18);
  } finally {
    release();
  }
  const finished = await waitFor(async () => {
    const response = await request(`/ai-xhs-note/jobs/${start.body.id}`);
    return response.body.status !== "running" && response.body;
  }, "小红书");
  assert.equal(finished.status, "success", JSON.stringify(finished));
  assertInjected(calls[0].system, expected);
  assert.doesNotMatch(calls[0].system, /LEARNED_11_NEW|CUSTOM_11_NEW/u);
  assert.equal(calls[0].providerPolicy, "yunwu_only");
  assert.ok(
    calls[0].messages[0].content.some(
      (item) => item.type === "image_url" && item.image_url.url === image,
    ),
  );
  assert.equal(finished.originalOutput.rawText, rawText);
  assert.equal(finished.output.body, body);
  assert.equal(finished.files[0].id, uploaded.id);
  assert.equal(finished.decision, "pending");
  assert.equal(finished.billing.state, "settled");
  const frozen = contentSnapshot(start.body.id).employeeExecution.skills;
  assert.equal(frozen.revision, 17);
  assert.equal(frozen.promptHash, expected.evidence.promptHash);
  assert.deepEqual(frozen.requiredSkillIds, expected.evidence.requiredSkillIds);
  assert.deepEqual(frozen.learnedSkillIds, expected.evidence.learnedSkillIds);
  assert.deepEqual(frozen.customSkillIds, expected.evidence.customSkillIds);
  assert.equal(holdFor(start.body.id, "content").status, "settled");
  const beforeDecision = balance();
  const edit = {
    title: "老板修改的标题",
    body: `${body}补充末段。`,
    tags: ["本店菜品"],
    firstComment: "补充说明",
  };
  const adopted = await request(`/ai-xhs-note/jobs/${start.body.id}/decision`, {
    decision: "adopted",
    output: edit,
  });
  assert.equal(adopted.status, 200);
  assert.equal(adopted.body.output.body, edit.body);
  assert.equal(adopted.body.originalOutput.rawText, rawText);
  const rejected = await request(
    `/ai-xhs-note/jobs/${start.body.id}/decision`,
    { decision: "rejected" },
  );
  assert.equal(rejected.body.decision, "rejected");
  assert.equal(rejected.body.output.body, edit.body);
  assert.equal(rejected.body.originalOutput.rawText, rawText);
  assert.equal(balance(), beforeDecision);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    contentSnapshot(start.body.id).employeeExecution.skills,
    frozen,
  );
  assert.equal((await request("/ai-xhs-note", input)).body.id, start.body.id);
  assert.equal(calls.length, 1, "旧请求幂等重放不能消费新技能再次收费");
  const next = await request("/ai-xhs-note", xhsInput());
  await waitFor(
    async () =>
      (await request(`/ai-xhs-note/jobs/${next.body.id}`)).body.status ===
      "success",
    "新版本小红书",
  );
  assertInjected(calls[1].system, contextFor(11), "NEW");
  assert.equal(
    contentSnapshot(next.body.id).employeeExecution.skills.revision,
    18,
  );
});

test("Wan真实脚本调用采用创建时冻结的必备/进修/自定义技能，两段原生有声视频完成结算", async () => {
  reset(10);
  const expected = contextFor(10);
  const h = voicedHarness();
  const created = await createVoiced(h.runtime);
  assert.equal(
    created.response.status,
    "processing",
    JSON.stringify(created.response),
  );
  assert.equal(h.calls.length, 0, "创建任务时还未发起供应商调用");
  const id = created.response.jobId;
  saveSkills(10, rawSkills(10, "NEW"), 18);
  await created.run();
  const state = mediaSnapshot(id);
  assert.equal(mediaRow(id).status, "成功", mediaRow(id).error);
  assert.deepEqual(
    h.calls.map((call) => call.kind),
    ["text", "video", "video", "compose"],
  );
  const params = h.calls[0].params;
  assertInjected(params.system, expected);
  assert.doesNotMatch(params.system, /LEARNED_10_NEW|CUSTOM_10_NEW/u);
  assert.equal(params.providerPolicy, "yunwu_only");
  assert.equal(state.employeeExecution.appliedSkills.revision, 17);
  assert.equal(
    state.employeeExecution.appliedSkills.promptHash,
    expected.evidence.promptHash,
  );
  assert.equal(state.learning.skillPromptHash, expected.evidence.promptHash);
  assert.equal(state.learning.skillRevision, 17);
  assert.equal(state.billing.state, "settled");
  assert.equal(holdFor(id).status, "settled");
  assert.equal(state.durationSeconds, 30);
  assert.equal(state.segmentCount, 2);
  for (const call of h.calls.filter((call) => call.kind === "video")) {
    assert.equal(call.params.model, "wan2.6-i2v");
    assert.equal(call.params.duration, 15);
    assert.equal(call.params.promptExtend, false);
    assert.equal(call.params.audioUrl, undefined);
  }
  const composed = h.calls.find(call => call.kind === "compose").params;
  assert.equal(composed.targetDurationSeconds, 30);
  assert.equal(composed.audioMode, "provider_native");
  assert.equal(composed.requireAudio, true);
  assert.equal(composed.voiceTracks, undefined);
  assert.equal(
    state.employeeExecution.selectedRuntime.automaticPublishing,
    false,
  );
});

test("Hailuo实际单镜头请求最多900字，包含必备和最多3条可选技能摘要，完整知识库不外发且applied/omitted与哈希可核对", async () => {
  reset(10);
  const skills = [
    ...rawSkills(10),
    {
      id: "content-custom:10:third",
      title: "第三个方法",
      detail: "THIRD_APPLIED 以门头作为场景依据。",
      enabled: true,
    },
    {
      id: "content-custom:10:fourth",
      title: "未选中方法",
      detail: "FOURTH_OMITTED 不应伪装为已使用。",
      enabled: true,
    },
  ];
  saveSkills(10, skills, 27);
  const expected = contextFor(10);
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const runtime = {
    intervalMs: 1,
    timeoutMs: 100,
    kbSearch: async () => ({
      text: "FULL_KNOWLEDGE_SECRET 全库资料不应塞进单镜头。".repeat(100),
      refs: [],
      mode: "test",
    }),
    beforeProviderInvocation: async ({ segment }) => {
      if (segment.index === 1) {
        enter();
        await gate;
      }
    },
    submitSegment: async (params) => {
      calls.push(params);
      return { taskId: `hailuo-local-${calls.length}`, model: params.model };
    },
    querySegment: async () => ({
      status: "success",
      url: "https://example.test/clip.mp4",
    }),
    downloadSegment: async ({ outputDir, index }) => {
      const file = path.join(outputDir, `clip-${index}.mp4`);
      await fsp.writeFile(file, "local-clip");
      return { path: file, sha256: "b".repeat(64), bytes: 10 };
    },
    compose: async () => ({
      url: `/uploads/ai-sales-video/${tenantId}/hailuo-fixture.mp4`,
      durationSeconds: 30,
      segmentCount: 3,
      width: 1080,
      height: 1920,
      videoCodec: "h264",
      audioCodec: "aac",
      sha256: "c".repeat(64),
    }),
  };
  const request = await listen({}, runtime);
  const start = await request("/ai-sales-video", {
    brief: "展示本店菜品细节和门店场景。".repeat(150),
    model: "MiniMax-Hailuo-2.3",
    referenceImages: [image],
  });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  await entered;
  try {
    saveSkills(10, rawSkills(10, "NEW"), 28);
  } finally {
    release();
  }
  const id = start.body.jobId;
  await waitFor(() => mediaRow(id).status !== "处理中", "Hailuo");
  assert.equal(mediaRow(id).status, "成功", mediaRow(id).error);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(call.prompt.length <= 900, `实际请求为 ${call.prompt.length} 字`);
    for (const required of expected.skills.filter(
      (skill) => skill.origin === "factory_position_skill",
    )) {
      assert.ok(call.prompt.includes(required.title.slice(0, 20)));
      assert.ok(call.prompt.includes(required.detail.slice(0, 60)));
    }
    assert.match(call.prompt, /LEARNED_10_OLD/u);
    assert.match(call.prompt, /CUSTOM_10_OLD/u);
    assert.match(call.prompt, /THIRD_APPLIED/u);
    assert.doesNotMatch(
      call.prompt,
      /FOURTH_OMITTED|DISABLED_10_SECRET|FOREIGN_SECRET|FULL_KNOWLEDGE_SECRET|LEARNED_10_NEW/u,
    );
    assert.deepEqual(call.images, [image]);
    assert.equal(call.duration, 10);
  }
  const evidence = mediaSnapshot(id).employeeExecution.appliedSkills;
  assert.equal(evidence.revision, 27);
  assert.deepEqual(evidence.appliedSkillIds, [
    ...expected.evidence.requiredSkillIds,
    "content-learned:10:motion",
    "content-custom:10:tone",
    "content-custom:10:third",
  ]);
  assert.deepEqual(evidence.omittedSkillIds, ["content-custom:10:fourth"]);
  assert.equal(evidence.injectionMode, "compact_video_prompt");
  calls.forEach((call, index) =>
    assert.equal(
      evidence.providerPromptHashes[index + 1],
      createHash("sha256").update(call.prompt).digest("hex"),
    ),
  );
  assert.equal(mediaSnapshot(id).billing.state, "settled");
});

test("未核验进修或串岗位技能在三个生成入口均先拒绝，任务、占扣、余额与供应商调用数不变", async () => {
  const called = [];
  const h = voicedHarness();
  const request = await listen(
    {
      available: () => true,
      estimate: () => {
        called.push("estimate");
        return 100;
      },
      generate: async () => {
        called.push("xhs");
        throw new Error("Must not invoke");
      },
    },
    {
      ...h.runtime,
      submitSegment: async () => {
        called.push("video");
        throw new Error("Must not invoke");
      },
    },
  );
  for (const invalid of ["unverified", "wrong_employee"]) {
    for (const idx of [10, 11]) {
      const skills = rawSkills(idx);
      if (invalid === "unverified")
        skills[0].verificationStatus = "search_snippet_only";
      else skills[0].id = "content-learned:3:foreign-position";
      saveSkills(idx, skills, 31);
    }
    const before = counts(),
      credits = balance();
    assert.equal((await request("/ai-xhs-note", xhsInput())).status, 503);
    assert.equal(
      (
        await request("/ai-sales-video", {
          brief: "展示本店菜品",
          referenceImages: [image],
          model: "MiniMax-Hailuo-2.3",
        })
      ).status,
      503,
    );
    await assert.rejects(createVoiced(h.runtime), {
      code: "NATIVE_EMPLOYEE_SKILLS_UNAVAILABLE",
    });
    assert.deepEqual(
      counts(),
      before,
      "技能核验失败应在任务插入和任何占扣之前",
    );
    assert.equal(balance(), credits);
    assert.deepEqual(called, []);
    assert.deepEqual(h.calls, []);
  }
});

test("停用未核验卡不阻塞正常出稿，也不进入XHS供应商请求", async () => {
  const skills = rawSkills(11);
  skills[0].verificationStatus = "search_snippet_only";
  skills[0].enabled = false;
  saveSkills(11, skills, 41);
  const calls = [];
  const request = await listen({
    available: () => true,
    estimate: () => 100,
    generate: async (params) => {
      calls.push(params);
      return {
        mode: "api",
        model: params.model,
        usage: { inputTokens: 100, outputTokens: 100 },
        text: JSON.stringify({ title: "正常菜品", body: "完整可编辑内容。" }),
      };
    },
  });
  const start = await request("/ai-xhs-note", xhsInput());
  assert.equal(start.status, 202);
  await waitFor(
    async () =>
      (await request(`/ai-xhs-note/jobs/${start.body.id}`)).body.status ===
      "success",
    "停用未核验卡的正常出稿",
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /CUSTOM_11_OLD/u);
  assert.doesNotMatch(
    calls[0].system,
    /LEARNED_11_OLD|DISABLED_11_SECRET|FOREIGN_SECRET/u,
  );
  assert.deepEqual(
    contentSnapshot(start.body.id).employeeExecution.skills.learnedSkillIds,
    [],
  );
});

after(async () => {
  await Promise.all(
    [...servers].map(
      (server) => new Promise((resolve) => server.close(resolve)),
    ),
  );
  for (const dir of dirs) await fsp.rm(dir, { recursive: true, force: true });
  fs.rmSync(uploadedPath, { force: true });
  try {
    fs.rmdirSync(path.dirname(uploadedPath));
  } catch {
    /* leave nonempty directories untouched */
  }
  db.close();
  globalThis.fetch = originalFetch;
  assert.deepEqual(forbiddenCalls, [], "不能访问真实供应商或外部资料服务");
});

import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Offline export only: no API calls, database reads, environment reads, or remote downloads.
// node scripts/export-native-media-desktop.mjs [output-directory]
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const reportDirectory = path.join(
  repository,
  "artifacts/native-live-test-2026-09-05",
);
const sourceDirectory = path.join(reportDirectory, "升级实测");
const defaultDestination =
  "/Users/wanglei/Desktop/AI数字员工真实API测试-2026-09-05";
const uploadsDirectory = path.join(repository, "server/data/uploads");
const billingLabels = {
  settled: "已按配置计费结算",
  released: "预授权已释放",
  pending_reconciliation: "费用待核对",
  held: "预授权中",
};
const secretKeys =
  /(?:authorization|cookie|apikey|apisecret|secret|password|passwd|accesstoken|refreshtoken|idtoken|sessiontoken|bearertoken|credentials|privatekey|signingkey|signature)|^token$/i;

export function sanitizeReceipt(value, key = "") {
  if (secretKeys.test(key.replace(/[^a-z0-9]/gi, ""))) return "[已隐藏]";
  if (Array.isArray(value)) return value.map((entry) => sanitizeReceipt(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        name,
        sanitizeReceipt(entry, name),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  // Snapshots may themselves be JSON encoded inside *_json string fields.
  if (/^[{[]/.test(trimmed)) {
    try {
      return JSON.stringify(sanitizeReceipt(JSON.parse(trimmed)));
    } catch {
      // Malformed provider text is retained after string-level redaction.
    }
  }
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[已隐藏私钥]",
    )
    .replace(/\bsk-[a-z0-9_-]{12,}/gi, "[已隐藏密钥]")
    .replace(/\bBearer\s+[a-z0-9._~+\/-]+=*/gi, "Bearer [已隐藏]")
    .replace(
      /\b(api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*[:=]\s*["']?[^\s,"'<>}]+/gi,
      "$1=[已隐藏]",
    )
    .replace(/https?:\/\/[^\s<>"'\\]+|\/uploads\/[^\s<>"'\\]+/gi, (url) => {
      const clean = url.split(/[?#]/, 1)[0];
      if (!/^https?:\/\//i.test(clean)) return clean;
      try {
        const parsed = new URL(clean);
        parsed.username = "";
        parsed.password = "";
        return parsed.toString();
      } catch {
        return "[无法解析的链接已隐藏]";
      }
    });
}

async function exists(filename) {
  try {
    return (await stat(filename)).isFile();
  } catch {
    return false;
  }
}

async function readJson(filename) {
  if (!(await exists(filename))) return null;
  return JSON.parse(await readFile(filename, "utf8"));
}

function within(filename, directory) {
  const relative = path.relative(directory, filename);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function localUpload(url) {
  if (typeof url !== "string" || !url) return null;
  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(url, "http://local.invalid").pathname,
    );
  } catch {
    return null;
  }
  if (!pathname.startsWith("/uploads/")) return null;
  const filename = path.resolve(
    uploadsDirectory,
    pathname.slice("/uploads/".length),
  );
  if (!within(filename, uploadsDirectory) || !(await exists(filename)))
    return null;
  const resolved = await realpath(filename);
  if (!within(resolved, await realpath(uploadsDirectory))) return null;
  return resolved;
}

function billingText(billing) {
  if (!billing) return "未记录费用，不能视为免费";
  const state =
    billingLabels[billing.state] || billing.state || "费用状态未记录";
  const charged = Number.isFinite(billing.chargedCredits)
    ? `${billing.chargedCredits} 积分`
    : "实扣待核对";
  const cost = Number.isFinite(billing.costYuan)
    ? `；配置成本 ¥${billing.costYuan}`
    : "";
  const held =
    billing.pendingReconciliation && Number.isFinite(billing.heldCredits)
      ? `；预授权 ${billing.heldCredits} 积分待核对`
      : "";
  return `${state}：${charged}${cost}${held}`;
}

function elapsed(execution) {
  const start = Date.parse(execution?.startedAt);
  const end = Date.parse(execution?.endedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? `${((end - start) / 1000).toFixed(1)} 秒（提交至本轮回执）`
    : "未记录完整起止时间";
}

function skillText(snapshot) {
  const skills =
    snapshot?.employeeExecution?.appliedSkills ||
    snapshot?.employeeExecution?.skills;
  if (!skills) return "未记录技能注入证据";
  const count = (name) =>
    Array.isArray(skills[name]) ? skills[name].length : 0;
  return `必需技能 ${count("requiredSkillIds")} / 已进修 ${count("learnedSkillIds")} / 自定义 ${count("customSkillIds")}；修订 ${skills.revision ?? "未记录"}（以请求快照为准）`;
}

function outputMarkdown(output = {}) {
  return (
    [
      output.title,
      output.body || output.text,
      Array.isArray(output.tags) ? output.tags.join(" ") : output.tags,
      output.firstComment ? `评论区首评：${output.firstComment}` : "",
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}

function retestBillingText(retest, item) {
  const billing = item.billing || item.snapshot?.billing;
  if (billing) return billingText(billing);
  const holds =
    retest.ledger?.find(
      (entry) => Number(entry.mediaJobId) === Number(item.mediaJobId),
    )?.holds || [];
  if (!holds.length) return "未记录费用，不能视为免费";
  return holds
    .map((hold) =>
      billingText({
        state: hold.status,
        chargedCredits:
          hold.status === "settled"
            ? hold.settled_credits
            : hold.status === "released"
              ? 0
              : null,
        costYuan: hold.cost_yuan,
        heldCredits: hold.held_credits,
        pendingReconciliation: hold.status === "pending_reconciliation",
      }),
    )
    .join("；");
}

export async function exportNativeMedia(destination = defaultDestination) {
  const target = path.resolve(destination);
  // The export must never replace product files or source evidence.
  if (within(target, repository) || target === path.parse(target).root) {
    throw new Error("请使用项目之外的独立交付目录。");
  }
  await mkdir(target, { recursive: true });
  const manifest = [];
  const missing = [];
  async function save(relative, content) {
    const filename = path.join(target, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content, "utf8");
    manifest.push(relative);
    return relative;
  }
  async function json(relative, value) {
    return save(
      relative,
      `${JSON.stringify(sanitizeReceipt(value), null, 2)}\n`,
    );
  }
  async function media(source, relative) {
    if (!source || !(await exists(source))) return null;
    // Copy explicit media only; never recurse through uploads, databases or configuration.
    if (!/\.(?:png|jpe?g|webp|mp4|mp3|wav)$/i.test(source)) return null;
    const resolved = await realpath(source);
    if (
      !within(resolved, await realpath(sourceDirectory)) &&
      !within(resolved, await realpath(uploadsDirectory))
    )
      return null;
    const filename = path.join(target, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await copyFile(resolved, filename);
    manifest.push(relative);
    return relative;
  }
  async function bundle(name) {
    const directory = path.join(sourceDirectory, name);
    const final = await readJson(path.join(directory, "final.json"));
    if (!final) {
      missing.push(`${name}/final.json 尚未提供`);
      return null;
    }
    const request = await readJson(path.join(directory, "request.json"));
    const execution = await readJson(path.join(directory, "execution.json"));
    const rawFiles = [];
    // The ledger can contain unrelated historical records, so it is copied for audit only, never summed.
    for (const file of [
      "request.json",
      "execution.json",
      "submitted.json",
      "final.json",
      "ledger.json",
      "ffprobe.json",
      "subtitle-recompose.json",
      "audio-transcription.json",
      "audio-transcription-review.json",
      "formal-download-verification.json",
    ]) {
      const value =
        file === "final.json"
          ? final
          : await readJson(path.join(directory, file));
      if (value)
        rawFiles.push({
          label: `${name} / ${file}（已脱敏）`,
          path: await json(`API回执/${name}/${file}`, value),
        });
    }
    const reviewNote = path.join(directory, "原声自动验收说明.md");
    if (await exists(reviewNote))
      rawFiles.push({
        label: "原声自动验收说明（含识别限制）",
        path: await save(
          `API回执/${name}/原声自动验收说明.md`,
          sanitizeReceipt(await readFile(reviewNote, "utf8")),
        ),
      });
    const inputs = [];
    for (const file of request?.files || []) {
      const source = path.join(directory, `input-${Number(file.id)}.jpg`);
      const relative = await media(
        source,
        `输入照片/${name}/原图-${Number(file.id)}.jpg`,
      );
      if (relative)
        inputs.push({
          src: relative,
          caption: file.name || `输入照片 ${file.id}`,
        });
      else missing.push(`${name} 输入照片 ${file.id} 未找到`);
    }
    return {
      directory,
      final,
      result: final.result || {},
      snapshot: final.snapshot || final.row?.snapshot_json || {},
      request,
      execution,
      rawFiles,
      inputs,
    };
  }
  const [sales, first, refined] = await Promise.all([
    bundle("sales"),
    bundle("xhs"),
    bundle("xhs-text-refinement"),
  ]);
  const retestDirectory = path.join(sourceDirectory, "xhs-scene-retest");
  const retest = await readJson(path.join(retestDirectory, "result.json"));
  const retestStarted = await readJson(
    path.join(retestDirectory, "started.json"),
  );
  const retestImages = [];
  for (const item of retest?.items || []) {
    if (!["成功", "success"].includes(item.status)) continue;
    const source = await localUpload(item.url);
    const role =
      item.role === "scene"
        ? "scene"
        : item.role === "detail"
          ? "detail"
          : "image";
    const src = await media(
      source,
      `小红书配图/另次补测-${role}-${Number(item.mediaJobId)}${source ? path.extname(source) : ".png"}`,
    );
    if (src)
      retestImages.push({
        src,
        role,
        caption: `${role === "scene" ? "用餐场景" : "菜品特写"} · 另次 Image2 真实补测 · AI 创意`,
      });
    else missing.push(`另次补测 ${role} 回执成功，但本地图片未找到`);
  }
  const employees = [];
  if (sales) {
    const video = sales.result.salesVideo || {};
    const audioReview = await readJson(
      path.join(sales.directory, "audio-transcription-review.json"),
    );
    const originalAudio = await media(
      path.join(sales.directory, "成片原声.mp3"),
      "带货视频/成片原声.mp3",
    );
    if (originalAudio)
      sales.rawFiles.push({
        label: "自动识别所用的成片原声",
        path: originalAudio,
      });
    const clearFilename = "罗二火锅-Wan2.6-清晰字幕版.mp4";
    const originalFilename = "罗二火锅-Wan2.6-原生中文声音字幕.mp4";
    const clear = await exists(path.join(sales.directory, clearFilename));
    const filename = clear ? clearFilename : originalFilename;
    const src = await media(
      path.join(sales.directory, filename),
      `带货视频/${filename}`,
    );
    if (!src) missing.push("带货视频成片尚未找到");
    const shots = video.script?.shots || [];
    const script = shots
      .map(
        (shot) =>
          `${shot.start}–${shot.end} 秒\n画面：${shot.visual || ""}\n独白与字幕稿：${shot.voiceover || shot.subtitle || ""}`,
      )
      .join("\n\n");
    if (script)
      sales.rawFiles.push({
        label: "视频脚本与字幕稿",
        path: await save("带货视频/脚本与字幕稿.txt", sanitizeReceipt(script)),
      });
    const providerIds = (sales.snapshot.providerExecution?.segments || [])
      .map((segment) => `第 ${segment.index} 段：${segment.taskId || "未记录"}`)
      .join("；");
    employees.push({
      name: "AI 带货员 · 30 秒成片",
      employeeIdx: 10,
      status:
        src && ["成功", "success"].includes(sales.result.status)
          ? "success"
          : "partial",
      message: src
        ? `已导出${clear ? "清晰字幕版" : "现有字幕版"}；原生声音来自 Wan2.6，本地合成不新增生成调用。`
        : "已有任务回执，成片文件尚未导出。",
      output: {
        videos: src
          ? [
              {
                src,
                caption: "Wan2.6 原生音画 · 2 段各 15 秒 · 中文字幕按脚本估时",
              },
            ]
          : [],
        fields: [],
      },
      input: {
        text: sales.request?.body?.brief || sales.snapshot.brief,
        images: sales.inputs,
      },
      warnings: [
        "首轮口播混入‘先把镜头停稳’等拍摄指令；后续提示词已修正，本次成片未为此重新生成，原稿保留供对比。",
        audioReview?.language === "zh" && audioReview.examples?.length >= 2
          ? "本机自动识别检测到两段中文人声；尚未人工听辨或逐字核验，不能据此确认声音、品牌读音或字幕完全准确。"
          : "已检测到音轨不等于中文听检通过；本报告不将声音准确性标记为通过。",
        video.subtitleNotice ||
          "字幕按脚本分句估时，尚未做逐字语音对齐，请预览核对。",
        ...(!clear ? ["清晰字幕版文件尚未提供；当前展示现有字幕版。"] : []),
      ],
      metrics: {
        model: video.model || sales.snapshot.model,
        taskId: `sales 独立测试 / 视频任务 ${sales.result.id}；${providerIds}`,
        duration: elapsed(sales.execution),
        cost: billingText(sales.snapshot.billing),
        billingStatus: "供应商真实调用；隔离数据库配置计费，不扣正式企业余额",
        skillsUsed: skillText(sales.snapshot),
      },
      rawFiles: sales.rawFiles,
      rawJson: {
        execution: sales.execution,
        salesVideo: video,
        providerExecution: sales.snapshot.providerExecution,
        billing: sales.snapshot.billing,
        audioReview,
      },
    });
  }
  const firstImages = [];
  const imageNotes = [];
  for (const item of first?.result.imageGeneration?.items || []) {
    let src = null;
    if (item.status === "success") {
      const original = await localUpload(item.url);
      const candidate =
        original || path.join(first.directory, `${item.id}.png`);
      src = await media(
        candidate,
        `小红书配图/首轮-${item.id}${path.extname(candidate) || ".png"}`,
      );
      if (src)
        firstImages.push({
          src,
          role: item.id,
          caption: `${item.label} · 首轮 Image2 AI 创意配图${item.id === "detail" ? "（拼贴与文字问题，保留对比）" : ""}${item.warning ? `；${item.warning}` : ""}`,
        });
      else missing.push(`${item.label} 回执成功，但本地图片未找到`);
      const originalImage = await localUpload(item.originalUrl);
      if (originalImage) {
        const rawImage = await media(
          originalImage,
          `小红书配图/原始图/首轮-${item.id}-Image2原图${path.extname(originalImage)}`,
        );
        if (rawImage)
          first.rawFiles.push({
            label: `${item.label} / Image2 原始图`,
            path: rawImage,
          });
      }
    }
    imageNotes.push(
      `首轮${item.label}：${item.status === "success" ? (src ? "已交付" : "文件缺失") : item.status === "failed" ? "未交付" : "处理中"}；${billingText(item.billing)}${item.error ? `；${item.error}` : ""}`,
    );
  }
  const recommendedImages = [
    firstImages.find((image) => image.role === "cover"),
    retestImages.find((image) => image.role === "detail"),
    retestImages.find((image) => image.role === "scene"),
  ].filter(Boolean);
  const retestNotes = (retest?.items || []).map(
    (item) =>
      `另次补测${item.role === "scene" ? "用餐场景" : "菜品特写"}（任务 ${item.mediaJobId}）：${item.status}；${retestBillingText(retest, item)}`,
  );
  if (refined || first) {
    const chosen = refined || first;
    const output = chosen.result.output || {};
    const textPath = await save(
      "小红书文案/推荐稿.txt",
      sanitizeReceipt(outputMarkdown(output)),
    );
    chosen.rawFiles.push({
      label: "推荐稿：标题、正文、标签、首评",
      path: textPath,
    });
    employees.push({
      name: `AI 小红书种草员 · ${refined ? "优先查看第二稿" : "首稿"}`,
      employeeIdx: 11,
      status:
        chosen.result.status === "success"
          ? recommendedImages.length === 3
            ? "success"
            : "partial"
          : chosen.result.status || "pending",
      message: refined
        ? "第二次真实文字优化稿，本轮未生成图片。配图优先首轮封面与另次补测的菜品特写、用餐场景；旧拼贴图留在首稿对比。"
        : "目前仅有首稿；只展示实际已生成的文案和图片。",
      output: {
        title: output.title,
        body: output.body,
        tags: output.tags,
        firstComment: output.firstComment,
        images: recommendedImages,
      },
      input: { text: chosen.request?.body?.brief, images: chosen.inputs },
      warnings: [
        ...(output.warnings || []),
        ...imageNotes,
        ...retestNotes,
        ...(recommendedImages.length < 3
          ? ["推荐图组尚未齐备；只展示已有文件，不补占位图。"]
          : []),
        "配图为 AI 创意，使用前请核对品牌、菜品与人物；不是顾客实拍证明。",
      ],
      metrics: {
        model: `${chosen.snapshot.model || "未记录"}（文案） / ${first?.result.imageGeneration?.model || "未记录"}（配图）`,
        taskId: `${refined ? "xhs-text-refinement" : "xhs"} 独立测试 / 图文任务 ${chosen.result.id}`,
        duration: elapsed(chosen.execution),
        cost: `${refined ? "第二稿文案" : "首稿文案"}：${billingText(chosen.result.billing || chosen.snapshot.billing)}；配图费用逐张列于上方`,
        billingStatus:
          "供应商真实调用；两轮独立记录，任务编号可能相同；正式企业余额未扣",
        skillsUsed: skillText(chosen.snapshot),
      },
      rawFiles: chosen.rawFiles,
      rawJson: {
        execution: chosen.execution,
        output,
        billing: chosen.result.billing,
        imageGeneration: chosen.result.imageGeneration,
        usage: chosen.snapshot.usage,
      },
    });
  }
  if (first && refined) {
    const output = first.result.output || {};
    first.rawFiles.push({
      label: "首稿原文：保留对比",
      path: await save(
        "小红书文案/第一稿原文.txt",
        sanitizeReceipt(outputMarkdown(output)),
      ),
    });
    employees.push({
      name: "AI 小红书种草员 · 第一稿原样留档",
      employeeIdx: 11,
      status:
        first.result.imageGeneration?.status === "partial"
          ? "partial"
          : first.result.status,
      message:
        "保留第一次真实生成的文字，不用第二稿覆盖；首轮图片和费用亦单独保留。",
      output: {
        title: output.title,
        body: output.body,
        tags: output.tags,
        firstComment: output.firstComment,
        images: firstImages,
      },
      input: { text: first.request?.body?.brief, images: first.inputs },
      warnings: [...(output.warnings || []), ...imageNotes],
      metrics: {
        model: first.snapshot.model,
        taskId: `xhs 独立测试 / 图文任务 ${first.result.id}`,
        duration: elapsed(first.execution),
        cost: `首稿文案：${billingText(first.result.billing || first.snapshot.billing)}`,
        billingStatus: "首轮成功图片已结算；未完成图片保持原费用状态",
        skillsUsed: skillText(first.snapshot),
      },
      rawFiles: first.rawFiles,
      rawJson: {
        execution: first.execution,
        output,
        billing: first.result.billing,
        imageGeneration: first.result.imageGeneration,
        usage: first.snapshot.usage,
      },
    });
  }

  // Optional later supplement: retain its original structure and its own billing independently.
  if (retest) {
    const receipt = await json("API回执/xhs-scene-retest/result.json", retest);
    const rawFiles = [{ label: "另次补测回执（已脱敏）", path: receipt }];
    const request = await readJson(path.join(retestDirectory, "request.json"));
    for (const [name, value] of [
      ["request.json", request],
      ["started.json", retestStarted],
    ]) {
      if (value)
        rawFiles.push({
          label: `另次补测 / ${name}`,
          path: await json(`API回执/xhs-scene-retest/${name}`, value),
        });
    }
    employees.push({
      name: "AI 小红书种草员 · 两张图片另次补测",
      employeeIdx: 11,
      status:
        retestImages.length === (retest.items?.length || 0) &&
        retestImages.length
          ? "success"
          : "partial",
      message: `本次记录 ${retest.additionalPaidImageAttempts ?? "未记录数量的"} 次新单图调用，单独核对；不重做已有封面，不覆盖首轮超时记录。`,
      input: {
        text: request?.jobs
          ?.map(
            (job) =>
              `${job.role === "scene" ? "用餐场景" : "菜品特写"}任务 ${job.id}\n${job.prompt}`,
          )
          .join("\n\n"),
        images: first?.inputs || [],
      },
      output: { images: retestImages },
      warnings: [
        "首轮场景图超时费用仍待核对；补测是另外的供应商调用，费用分开记录。",
        ...retestNotes,
      ],
      metrics: {
        model: retest.providerModel || "未记录",
        taskId: (retest.items || [])
          .map((item) => `${item.role} / 媒体任务 ${item.mediaJobId}`)
          .join("；"),
        duration: elapsed({ ...retestStarted, ...retest }),
        cost: retestNotes.join("\n"),
        billingStatus: "见各图账单；旧超时预授权仍待核对",
      },
      rawFiles,
      rawJson: retest,
    });
  }

  const overallAttachments = [];
  for (const filename of [
    "live-after-restart.json",
    "live-ui-verification.json",
    "final-verification-summary.json",
  ]) {
    const value = await readJson(path.join(reportDirectory, filename));
    if (value)
      overallAttachments.push({
        label: `整体验收 / ${filename}（已脱敏）`,
        path: await json(`API回执/整体验收/${filename}`, value),
      });
  }
  const overallNote = path.join(reportDirectory, "联网学习与本轮改动.md");
  if (await exists(overallNote))
    overallAttachments.push({
      label: "联网学习、本轮改动与实测边界",
      path: await save(
        "API回执/整体验收/联网学习与本轮改动.md",
        sanitizeReceipt(await readFile(overallNote, "utf8")),
      ),
    });
  if (employees.length) employees[0].rawFiles.push(...overallAttachments);

  const data = sanitizeReceipt({
    title: "罗二火锅 · AI 数字员工真实 API 实测",
    generatedAt: new Date().toISOString(),
    description:
      "先看成片和推荐文案，再展开输入与原始回执。供应商为真实调用；积分与成本来自当时配置计费，记录于独立测试数据库，不扣正式企业余额。第三张图片的首轮超时费用保留待核对；另次补测如有结果将单列。",
    employees,
  });
  await json("report-data.json", data);
  execFileSync(
    process.execPath,
    [
      path.join(reportDirectory, "render-report.mjs"),
      path.join(target, "report-data.json"),
      path.join(target, "打开报告.html"),
    ],
    { stdio: "pipe" },
  );
  manifest.push("打开报告.html");
  await save(
    "请先阅读.txt",
    [
      "双击“打开报告.html”，可离线查看视频、图片、文案和脱敏 API 回执。",
      "视频：优先导出清晰字幕版。自动识别证据与限制见原声验收附件；尚未人工听辨或逐字核验。中文字幕仍按脚本估时。",
      "小红书：优先查看第二次文字优化稿。推荐配图为首轮封面（cover）+ 另次补测菜品特写（detail）+ 另次补测用餐场景（scene）；只导出实际存在的文件。文字优化没有重复出图；第一稿及旧拼贴图原样保留供对比。",
      "调用：供应商真实调用。费用是调用时平台配置计费；记录在隔离数据库，不扣正式企业余额，不代表供应商账单已核验。",
      "注意：不同测试使用独立数据库副本，任务 ID、预授权 ID 可能相同。按目录与开始时间区分，不能只凭数字合并账单。",
      "首轮场景图超时费用仍待核对；若有另次补测，图片与费用单独记录，不能据此认定旧费用释放。",
      "ledger.json 为历史审计证据，可能包含其他业务行，不应直接整表求和。以对应 final.json 内本次文案/图片账单为准。",
      "原始 JSON 已过滤密钥、凭据及 URL 签名参数；未复制数据库或环境配置。",
      ...(missing.length
        ? ["尚缺文件：", ...missing.map((entry) => `- ${entry}`)]
        : []),
    ].join("\n\n") + "\n",
  );
  await json("导出清单.json", {
    generatedAt: data.generatedAt,
    source: "artifacts/native-live-test-2026-09-05/升级实测",
    files: manifest.sort(),
    missing,
    makesApiCalls: false,
    productionDatabaseMutated: false,
  });
  return {
    destination: target,
    employees: employees.length,
    files: manifest.length,
    missing,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  exportNativeMedia(process.argv[2])
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(`导出失败：${sanitizeReceipt(error.message)}`);
      process.exitCode = 1;
    });
}

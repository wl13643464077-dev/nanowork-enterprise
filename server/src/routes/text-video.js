import { Router } from "express";

import {
  listTextVideoAssets,
  listTextVideoLicensedMaterials,
  saveTextVideoAsset,
  TextVideoError,
  textVideoJobService,
} from "../engines/text-video.js";
import { logOp } from "../util.js";

const router = Router();

function service(req) {
  return req.app.locals.textVideoJobService || textVideoJobService;
}

function sendError(res, error) {
  const status = Number(error?.status);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error:
      error instanceof TextVideoError || (status >= 400 && status < 500)
        ? error.message
        : "成片服务执行失败，请稍后重试；已产生的预授权会安全收口",
    code: String(error?.code || "TEXT_VIDEO_FAILED").slice(0, 80),
  });
}

router.get("/assets", (req, res) => {
  try {
    res.json({ assets: listTextVideoAssets(req.user, req.query.kind) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/assets", async (req, res) => {
  try {
    const asset = await saveTextVideoAsset({
      user: req.user,
      name: req.body?.name,
      mime: req.body?.mime,
      b64: req.body?.b64,
      kind: req.body?.kind,
    });
    logOp(
      req.user,
      "图文成片",
      "上传租户成片素材",
      `${asset.kind} / ${asset.name}`,
    );
    res.status(201).json({ asset });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/materials", (req, res) => {
  try {
    res.json({
      materials: listTextVideoLicensedMaterials(req.user, req.query.limit),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/jobs", (req, res) => {
  try {
    res.json({ jobs: service(req).listJobs(req.user, req.query) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/jobs/:id", (req, res) => {
  try {
    res.json({ job: service(req).getJob(req.user, req.params.id) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/jobs", async (req, res) => {
  try {
    const jobs = service(req);
    const job = await jobs.createJob({
      user: req.user,
      title: req.body?.title,
      body: req.body?.body,
      mode: req.body?.mode,
      imageFileIds: req.body?.imageFileIds,
      materialIds: req.body?.materialIds,
      clipFileIds: req.body?.clipFileIds,
      allowSolidBackground: req.body?.allowSolidBackground,
      voiceId: req.body?.voiceId,
      bgm: req.body?.bgm,
    });
    jobs.schedule(job.id, req.user.tenant_id);
    logOp(req.user, "图文成片", "创建真实成片任务", `#${job.id} ${job.title}`);
    res.status(202).json({
      queued: true,
      job,
      message: "任务已进入真实TTS与FFmpeg后台流水线，可在任务中心持续查看",
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/jobs/:id/cancel", async (req, res) => {
  try {
    const job = await service(req).cancelJob(req.user, req.params.id);
    logOp(req.user, "图文成片", "取消成片任务", `#${job.id}`);
    res.json({ job, message: "任务已取消，未交付部分的预授权已全额退回" });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/jobs/:id/retry", async (req, res) => {
  try {
    const jobs = service(req);
    const job = await jobs.retryJob(req.user, req.params.id);
    jobs.schedule(job.id, req.user.tenant_id);
    logOp(req.user, "图文成片", "免费重试成片任务", `#${job.id}`);
    res.status(202).json({
      queued: true,
      freeRetry: true,
      job,
      message: "免费重试已排队，本次不会重复扣费",
    });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;

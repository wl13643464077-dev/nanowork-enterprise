import { Router } from "express";
import {
  avatarJobService,
  AvatarJobError,
  saveAvatarAsset,
  listAvatarAssets,
} from "../engines/avatar-job.js";

function sendError(res, error) {
  const requested = Number(error?.status);
  const status =
    Number.isInteger(requested) && requested >= 400 && requested < 600
      ? requested
      : 500;
  const safeMessage =
    error instanceof AvatarJobError || status < 500
      ? String(error?.message || "数字人请求失败").slice(0, 500)
      : "数字人服务处理失败，请稍后重试";
  res.status(status).json({
    error: safeMessage,
    ...(error instanceof AvatarJobError && error.code
      ? { code: error.code }
      : {}),
    ...(error?.voice ? { voice: error.voice } : {}),
  });
}

export function createAvatarRouter({ service = avatarJobService } = {}) {
  const router = Router();

  router.get("/meta", async (req, res) => {
    try {
      res.json(await service.getMeta(req.user));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/assets", (req, res) => {
    try {
      res.json({ items: listAvatarAssets(req.user, req.query.kind) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/assets", async (req, res) => {
    try {
      const asset = await saveAvatarAsset({
        user: req.user,
        name: req.body?.name,
        mime: req.body?.mime,
        b64: req.body?.b64,
        kind: req.body?.kind,
      });
      res.status(201).json({ asset });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/voices", (req, res) => {
    try {
      res.json({ items: service.listVoices(req.user) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/voices/clone", async (req, res) => {
    try {
      const voice = await service.cloneVoice({
        user: req.user,
        audioFileId: req.body?.audioFileId,
        label: req.body?.label,
      });
      res.status(201).json({ voice, billing: voice.billing });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/jobs", (req, res) => {
    try {
      res.json({ items: service.listJobs(req.user, req.query) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/jobs", async (req, res) => {
    try {
      const job = await service.createJob({
        user: req.user,
        title: req.body?.title,
        imageFileId: req.body?.imageFileId,
        audioFileId: req.body?.audioFileId,
        durationSeconds: req.body?.durationSeconds,
        engine: req.body?.engine,
        script: req.body?.script,
        voiceId: req.body?.voiceId,
        prompt: req.body?.prompt,
      });
      service.schedule(job.id, req.user.tenant_id);
      res.status(202).json({
        job,
        jobId: job.id,
        pollUrl: `/avatar/jobs/${job.id}`,
        deepLink: job.deepLink,
        billing: job.billing,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/jobs/:id", (req, res) => {
    try {
      res.json(service.getJob(req.user, req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/jobs/:id/cancel", (req, res) => {
    try {
      const job = service.cancelJob(req.user, req.params.id);
      res.json({ ok: true, job, billing: job.billing });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/jobs/:id/retry", async (req, res) => {
    try {
      const job = await service.retryJob(req.user, req.params.id);
      service.schedule(job.id, req.user.tenant_id);
      res.status(202).json({
        ok: true,
        freeRetry: true,
        job,
        jobId: job.id,
        pollUrl: `/avatar/jobs/${job.id}`,
        billing: job.billing,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

export { avatarJobService };

export default createAvatarRouter();

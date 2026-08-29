import { Router } from "express";

import {
  curTenant,
  db,
  getTenantConfig,
  q,
  runWithTenant,
  setTenantConfig,
} from "../db.js";
import {
  canAccessOwner,
  hasFullDataAccess,
  isManagerRole,
} from "../engines/access.js";
import {
  ContentPipelineScheduleError,
  contentPipelineScheduleLaunchBlocker,
  createContentPipelineScheduleService,
  createSqliteContentPipelineScheduleRepository,
} from "../engines/content-pipeline-schedules.js";
import { precheckByRole, estimateMaxCredits } from "../engines/credits.js";
import { createContentPaidMediaAuthorization } from "../engines/content-paid-media-authorization.js";
import {
  createContentTenantProfileStore,
  resolveContentStructuredBrief,
} from "../engines/content-structured-brief.js";
import { routing, yunwuAvailable } from "../engines/yunwu.js";
import { logOp, notify } from "../util.js";
import { getDefaultContentProductionPipelineRuntime } from "./content-production-pipeline.js";

const FINAL_AUTH_ROLES = new Set(["boss", "admin", "platform_super"]);
const ACTIVE_PIPELINE_STATUSES = [
  "running",
  "paused",
  "awaiting_approval",
  "billing_pending",
];
const ACTIVE_PIPELINE_LIMIT = 3;
const RUN_LEASE_MS = 30 * 60 * 1_000;

function cleanText(value, max = 500) {
  return String(value ?? "")
    .replace(/\u0000/gu, "")
    .trim()
    .slice(0, max);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ContentPipelineScheduleError(`${field}必须是正整数`);
  }
  return number;
}

function requestWorkflow(body, user, fallback = {}) {
  const submitted = body?.workflow;
  if (submitted !== undefined && !isRecord(submitted)) {
    throw new ContentPipelineScheduleError("workflow必须是对象");
  }
  const base = isRecord(fallback) ? clone(fallback) : {};
  const raw = submitted === undefined ? base : { ...base, ...clone(submitted) };
  if (submitted?.paidMediaAuthorization !== undefined) {
    throw new ContentPipelineScheduleError(
      "客户端不能提交付费媒体签名",
      "CONTENT_PIPELINE_SCHEDULE_MEDIA_AUTHORIZATION_FORGED",
      400,
    );
  }
  const submittedApprovalMode = cleanText(submitted?.approvalPolicy?.mode, 40);
  if (
    submitted?.approvalPolicy !== undefined &&
    submittedApprovalMode !== "internal_auto" &&
    !hasFullDataAccess(user)
  ) {
    throw new ContentPipelineScheduleError(
      "只有老板或管理员可以自定义流水线审批点",
      "CONTENT_PIPELINE_APPROVAL_POLICY_ROLE_FORBIDDEN",
      403,
    );
  }
  if (
    submittedApprovalMode === "internal_auto" &&
    (submitted.approvalPolicy.reviewStations !== undefined ||
      submitted.approvalPolicy.externalPublishAllowed === true ||
      submitted.approvalPolicy.automaticBusinessAdoptionAllowed === true)
  ) {
    throw new ContentPipelineScheduleError(
      "internal_auto只允许内部连续生成报告，不能夹带审批点、外发或业务采纳授权",
      "CONTENT_PIPELINE_INTERNAL_AUTO_SCOPE_INVALID",
      400,
    );
  }
  if (
    submitted?.paidMediaAuthorized === true &&
    !FINAL_AUTH_ROLES.has(cleanText(user?.role, 64))
  ) {
    throw new ContentPipelineScheduleError(
      "只有老板、管理员或平台超管可以授权每次付费媒体provider",
      "CONTENT_PAID_MEDIA_AUTHORITY_REQUIRED",
      403,
    );
  }
  return {
    ...clone(raw),
    mode: cleanText(raw.mode || "copilot", 40),
    ...(submitted?.approvalPolicy
      ? {
          approvalPolicy: {
            ...(submittedApprovalMode === "internal_auto"
              ? { mode: "internal_auto" }
              : clone(submitted.approvalPolicy)),
            configuredBy: {
              id: Number(user.id),
              role: cleanText(user.role, 64),
            },
          },
        }
      : raw.approvalPolicy
        ? { approvalPolicy: clone(raw.approvalPolicy) }
        : {}),
  };
}

function defaultContentPipelineScheduleService() {
  const repository = createSqliteContentPipelineScheduleRepository({ db });
  repository.ensureSchema();
  return createContentPipelineScheduleService({
    repository,
    findExistingPipeline: ({ tenantId, idempotency }) =>
      getDefaultContentProductionPipelineRuntime().pipeline.findByIdempotency({
        tenantId,
        idempotency,
      }),
    preflight: ({ claim, schedule }) => {
      const user = q.get(
        `SELECT id,name,role,status,tenant_id FROM users
        WHERE tenant_id=? AND id=?`,
        claim.tenantId,
        schedule.createdBy,
      );
      if (!user || user.status !== "启用") {
        throw new ContentPipelineScheduleError(
          "计划创建账号已停用或不存在",
          "CONTENT_PIPELINE_SCHEDULE_CREATOR_UNAVAILABLE",
          409,
        );
      }
      if (!yunwuAvailable()) {
        throw new ContentPipelineScheduleError(
          "当前未连通云雾真实API，未创建流水线",
          "CONTENT_PIPELINE_YUNWU_REQUIRED",
          503,
        );
      }
      const placeholders = ACTIVE_PIPELINE_STATUSES.map(() => "?").join(",");
      const counts = q.get(
        `SELECT
          SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
          COUNT(*) AS active
        FROM content_production_pipeline_jobs
        WHERE tenant_id=? AND status IN (${placeholders})`,
        claim.tenantId,
        ...ACTIVE_PIPELINE_STATUSES,
      );
      const blocker = contentPipelineScheduleLaunchBlocker({
        running: Number(counts?.running || 0),
        active: Number(counts?.active || 0),
        limit: ACTIVE_PIPELINE_LIMIT,
      });
      if (blocker) {
        throw new ContentPipelineScheduleError(
          blocker.message,
          blocker.code,
          blocker.status,
        );
      }
      // 在pipeline.create之前做同一个文本模型上限预检；失败时不留API任务。
      precheckByRole(user.id, "text", user.role);
      const workflow = clone(schedule.workflow);
      const paidMediaAuthorized = workflow.paidMediaAuthorized === true;
      delete workflow.paidMediaAuthorized;
      if (paidMediaAuthorized) {
        const imageModel = cleanText(routing().image, 160);
        if (!imageModel) {
          throw new ContentPipelineScheduleError(
            "当前图片模型未配置",
            "CONTENT_PIPELINE_IMAGE_MODEL_UNAVAILABLE",
            503,
          );
        }
        workflow.paidMediaAuthorization = createContentPaidMediaAuthorization({
          task: schedule.task,
          actor: user,
          imageModel,
          estimatedUnitCredits: estimateMaxCredits("image", imageModel),
        });
      }
      return { workflow };
    },
    createPipeline: (input) =>
      getDefaultContentProductionPipelineRuntime().pipeline.create(input),
    resumePipeline: ({ tenantId, pipelineId }) =>
      getDefaultContentProductionPipelineRuntime().pipeline.resume({
        tenantId,
        pipelineId,
      }),
    notify: ({ schedule, pipeline }) =>
      notify(
        schedule.createdBy,
        "content",
        `定时内容流水线#${pipeline.id}已开工`,
        `${schedule.name}；0→9工位以服务端状态为准`,
        `/content?pipelineId=${pipeline.id}`,
      ),
  });
}

let defaultService = null;

export function getDefaultContentPipelineScheduleService() {
  if (!defaultService) defaultService = defaultContentPipelineScheduleService();
  return defaultService;
}

export async function contentPipelineScheduleTick({
  tenantId,
  now,
  source = "scheduler_tick",
} = {}) {
  const outcomes = await getDefaultContentPipelineScheduleService().tick({
    tenantId,
    now,
  });
  return outcomes.map((outcome) => ({ ...outcome, source }));
}

function sendError(res, error) {
  const status = Number(error?.status);
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    error: cleanText(error?.message || "内容流水线计划操作失败", 500),
    code: cleanText(
      error?.code || "CONTENT_PIPELINE_SCHEDULE_REQUEST_FAILED",
      160,
    ),
  });
}

export function createContentPipelineScheduleRouter(dependencies = {}) {
  const router = Router();
  const service =
    dependencies.service || getDefaultContentPipelineScheduleService();
  const profileStore =
    dependencies.profileStore ||
    createContentTenantProfileStore({
      getTenantConfigFn: getTenantConfig,
      setTenantConfigFn: setTenantConfig,
    });
  const resolveBrief =
    dependencies.resolveBrief || resolveContentStructuredBrief;
  const scheduleFn = dependencies.scheduleFn || ((task) => setImmediate(task));
  const runWithTenantFn = dependencies.runWithTenantFn || runWithTenant;
  const logOpFn = dependencies.logOpFn || logOp;

  const assertAccess = (req, scheduleId) => {
    const schedule = service.getSchedule(
      Number(req.user.tenant_id || curTenant()),
      scheduleId,
    );
    if (!schedule) {
      throw new ContentPipelineScheduleError(
        "内容流水线计划不存在",
        "CONTENT_PIPELINE_SCHEDULE_NOT_FOUND",
        404,
      );
    }
    if (!canAccessOwner(req.user, schedule.createdBy)) {
      throw new ContentPipelineScheduleError(
        "当前账号无权操作该计划",
        "CONTENT_PIPELINE_SCHEDULE_ACCESS_FORBIDDEN",
        403,
      );
    }
    return schedule;
  };

  const preparePackage = (
    req,
    brief,
    workflowFallback = {},
    snapshot = null,
  ) => {
    if (!isRecord(brief))
      throw new ContentPipelineScheduleError("brief必须是对象");
    const tenantId = Number(req.user.tenant_id || curTenant());
    const stored = profileStore.load(tenantId);
    const persistentProfile = snapshot
      ? {
          brief: clone(snapshot.task || {}),
          persona: clone(snapshot.persona || {}),
          enterprise: clone(snapshot.settings?.companyProfile || {}),
        }
      : stored?.profile || {};
    const resolved = resolveBrief({
      tenantId,
      persistentProfile,
      explicitInput: brief,
    });
    return {
      task: clone(resolved.paihuoBrief),
      persona: clone(resolved.handlerContext.profile.persona),
      settings: {
        ...clone(snapshot?.settings || {}),
        companyProfile: clone(resolved.handlerContext.companyProfile),
        structuredBriefEvidence: clone(resolved.evidence),
        contentProfileRevision: Number(
          snapshot?.settings?.contentProfileRevision ?? stored?.revision ?? 0,
        ),
      },
      workflow: requestWorkflow(req.body, req.user, workflowFallback),
    };
  };

  router.get("/pipeline-schedules", (req, res) => {
    try {
      const tenantId = Number(req.user.tenant_id || curTenant());
      const createdBy = isManagerRole(req.user) ? null : req.user.id;
      const schedules = service
        .list(tenantId, { createdBy })
        .filter((schedule) => canAccessOwner(req.user, schedule.createdBy));
      res.set("Cache-Control", "private, no-store");
      return res.json({
        schemaVersion: "nanowork.content-pipeline-schedule-list/1",
        schedules,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/pipeline-schedules", (req, res) => {
    try {
      if (!isRecord(req.body) || !isRecord(req.body.brief)) {
        throw new ContentPipelineScheduleError(
          "brief字段必填且必须是Paihuo Brief对象",
        );
      }
      const tenantId = Number(req.user.tenant_id || curTenant());
      const pkg = preparePackage(req, req.body.brief);
      const schedule = service.create({
        tenantId,
        createdBy: req.user.id,
        name: cleanText(req.body.name || pkg.task.direction, 80),
        enabled: req.body.enabled !== false,
        kind: req.body.kind,
        atTime: req.body.atTime,
        weekday: req.body.weekday,
        everyHours: req.body.everyHours,
        ...pkg,
      });
      logOpFn(
        req.user,
        "内容生产仓",
        "创建完整团队定时流水线",
        `schedule#${schedule.id}`,
      );
      return res.status(201).json({ schedule });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/pipeline-schedules/:id/runs", (req, res) => {
    try {
      const schedule = assertAccess(
        req,
        positiveInteger(req.params.id, "scheduleId"),
      );
      const runs = service.listRuns(schedule.tenantId, schedule.id, {
        limit: 30,
      });
      res.set("Cache-Control", "private, no-store");
      return res.json({ schedule, runs });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.put("/pipeline-schedules/:id", (req, res) => {
    try {
      if (!isRecord(req.body))
        throw new ContentPipelineScheduleError("请求体必须是对象");
      const scheduleId = positiveInteger(req.params.id, "scheduleId");
      const current = assertAccess(req, scheduleId);
      let pkg = {};
      if (req.body.brief !== undefined) {
        pkg = preparePackage(req, req.body.brief, current.workflow, current);
      } else if (req.body.workflow !== undefined) {
        pkg = {
          workflow: requestWorkflow(req.body, req.user, current.workflow),
        };
      }
      const schedule = service.update(current.tenantId, scheduleId, {
        ...(req.body.name !== undefined ? { name: req.body.name } : {}),
        ...(req.body.enabled !== undefined
          ? { enabled: req.body.enabled === true }
          : {}),
        ...(req.body.kind !== undefined ? { kind: req.body.kind } : {}),
        ...(req.body.atTime !== undefined ? { atTime: req.body.atTime } : {}),
        ...(req.body.weekday !== undefined
          ? { weekday: req.body.weekday }
          : {}),
        ...(req.body.everyHours !== undefined
          ? { everyHours: req.body.everyHours }
          : {}),
        ...pkg,
      });
      logOpFn(
        req.user,
        "内容生产仓",
        "更新完整团队定时流水线",
        `schedule#${schedule.id}`,
      );
      return res.json({ schedule });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.delete("/pipeline-schedules/:id", (req, res) => {
    try {
      const scheduleId = positiveInteger(req.params.id, "scheduleId");
      const schedule = assertAccess(req, scheduleId);
      service.remove(schedule.tenantId, scheduleId);
      logOpFn(
        req.user,
        "内容生产仓",
        "删除完整团队定时流水线",
        `schedule#${scheduleId}`,
      );
      return res.json({ ok: true });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/pipeline-schedules/:id/run-now", async (req, res) => {
    let releaseLease = null;
    try {
      const scheduleId = positiveInteger(req.params.id, "scheduleId");
      const schedule = assertAccess(req, scheduleId);
      if (typeof req.aiGuard?.defer !== "function") {
        throw new ContentPipelineScheduleError(
          "AI并发保护未生效，未创建流水线",
          "CONTENT_PIPELINE_AI_GUARD_REQUIRED",
          503,
        );
      }
      releaseLease = req.aiGuard.defer(RUN_LEASE_MS);
      if (typeof releaseLease !== "function") {
        throw new ContentPipelineScheduleError(
          "AI并发保护未返回有效租约",
          "CONTENT_PIPELINE_AI_GUARD_LEASE_INVALID",
          503,
        );
      }
      const claim = service.claimImmediate(
        schedule.tenantId,
        scheduleId,
        req.user.id,
      );
      const launched = await service.launch(claim);
      scheduleFn(async () => {
        try {
          await runWithTenantFn(schedule.tenantId, () =>
            service.resumeLaunched(launched),
          );
        } catch (error) {
          console.error(
            `[content-pipeline-schedule] pipeline#${launched.pipeline.id} failed:`,
            cleanText(error?.message || error, 300),
          );
        } finally {
          releaseLease();
        }
      });
      logOpFn(
        req.user,
        "内容生产仓",
        "立即触发完整团队计划",
        `schedule#${scheduleId};pipeline#${launched.pipeline.id}`,
      );
      res.set("Retry-After", "2");
      return res.status(202).json({
        queued: true,
        schedule: service.getSchedule(schedule.tenantId, scheduleId),
        run: launched.run,
        pipeline: launched.pipeline,
        pollUrl: `/content/pipelines/${launched.pipeline.id}`,
        deepLink: `/content?pipelineId=${launched.pipeline.id}`,
      });
    } catch (error) {
      releaseLease?.();
      return sendError(res, error);
    }
  });

  return router;
}

export default createContentPipelineScheduleRouter();

import { runWithTenant } from "../db.js";
import { generateToolboxRun } from "./toolbox.js";

export const TOOLBOX_JOB_TIMEOUT_MS = 12 * 60 * 1_000;
export const TOOLBOX_JOB_HEARTBEAT_MS = 15_000;

const activeJobs = new Map();

export async function executeToolboxJob(job) {
  const controller = new AbortController();
  const timeoutMs = Math.max(
    1_000,
    Math.min(15 * 60 * 1_000, Number(job.timeoutMs) || TOOLBOX_JOB_TIMEOUT_MS),
  );
  let rejectTimeout;
  const timeoutFailure = Object.assign(
    new Error("工具后台任务超过最大执行时限"),
    {
      code: "TOOLBOX_JOB_TIMEOUT",
      status: 504,
    },
  );
  const timeoutPromise = new Promise((resolve, reject) => {
    void resolve;
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    controller.abort(timeoutFailure);
    rejectTimeout(timeoutFailure);
  }, timeoutMs);
  timeout.unref?.();
  const heartbeat = setInterval(() => {
    job.onProgress?.({ phase: "heartbeat", message: "工具后台任务仍在执行" });
  }, TOOLBOX_JOB_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    job.onProgress?.({
      phase: job.retrying ? "retrying" : "running",
      message: "工具后台 worker 已开始执行",
    });
    const generation = generateToolboxRun(job.definition, job.inputs, {
      ...job.generationOptions,
      signal: controller.signal,
      onProgress: job.onProgress,
    });
    // 不能只依赖供应商实现主动响应 AbortSignal。Promise.race 保证即使某个
    // 注入/第三方实现忽略取消信号，后台状态与预授权也会在硬截止时间收敛，
    // 迟到结果绝不会再触发成功落库。
    const draft = await Promise.race([generation, timeoutPromise]);
    clearTimeout(timeout);
    await job.onSuccess(draft);
  } catch (error) {
    const failure =
      controller.signal.aborted && error?.code !== "TOOLBOX_JOB_TIMEOUT"
        ? Object.assign(new Error("工具后台任务超过最大执行时限"), {
            code: "TOOLBOX_JOB_TIMEOUT",
            status: 504,
            cause: error,
          })
        : error;
    await job.onFailure(failure);
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
  }
}

export function enqueueToolboxRun(job, { scheduleFn = setImmediate } = {}) {
  const key = `${Number(job.tenantId)}:${Number(job.runId)}`;
  if (activeJobs.has(key)) return { queued: false, alreadyRunning: true };
  activeJobs.set(key, true);
  scheduleFn(() => {
    Promise.resolve(runWithTenant(job.tenantId, () => executeToolboxJob(job)))
      .catch((error) => {
        console.error(
          `[toolbox worker] run#${job.runId} failure persistence error:`,
          error?.message,
        );
      })
      .finally(() => activeJobs.delete(key));
  });
  return { queued: true, alreadyRunning: false };
}

export function toolboxJobActive(tenantId, runId) {
  return activeJobs.has(`${Number(tenantId)}:${Number(runId)}`);
}

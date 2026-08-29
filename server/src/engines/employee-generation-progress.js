const PROGRESS_KIND = "restaurant_employee_generation_progress";
const PHASES = new Set(["acquire", "repair"]);
const STAGE_DEFINITIONS = Object.freeze({
  boot: { kind: "boot", label: "数字员工已上线，正在读取任务简报", percent: 6 },
  dataset: { kind: "tool", label: "正在安全解析已授权评价数据", percent: 12 },
  knowledge: {
    kind: "knowledge",
    label: "正在召回企业知识与岗位经验",
    percent: 18,
  },
  search: { kind: "search", label: "正在联网检索公开信息", percent: 30 },
  location: {
    kind: "location",
    label: "正在核验地点、路网与周边信息",
    percent: 40,
  },
  fetch: {
    kind: "fetch",
    label: "正在受控读取并核验公开网页正文",
    percent: 52,
  },
  tool: {
    kind: "tool",
    label: "正在调用岗位专用工具生成交付附件",
    percent: 74,
  },
  generate: {
    kind: "typing",
    label: "正在组织证据并生成岗位交付",
    percent: 68,
  },
  validate: { kind: "gate", label: "正在执行岗位契约与质量检查", percent: 82 },
  repair: { kind: "retry", label: "质检未通过，正在定向返工", percent: 76 },
  persist: {
    kind: "persist",
    label: "质量检查已通过，正在保存交付物",
    percent: 90,
  },
  settle: {
    kind: "billing",
    label: "正在核对真实用量并完成积分结算",
    percent: 96,
  },
  done: { kind: "done", label: "交付、证据与费用已完成归档", percent: 100 },
  error: {
    kind: "error",
    label: "执行已中断，正在收敛失败与退款状态",
    percent: 100,
  },
});
const STAGE_STATUSES = new Set(["pending", "active", "done", "error"]);
const MAX_STEPS = 30;

export const EMPLOYEE_GENERATION_PROGRESS_KIND = PROGRESS_KIND;
export const EMPLOYEE_GENERATION_PROGRESS_INTERVAL_MS = 2_000;
export const EMPLOYEE_GENERATION_PROGRESS_CHAR_DELTA = 500;

function safeInteger(value, { min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const integer = Math.trunc(number);
  return integer >= min && integer <= max ? integer : null;
}

function safeActivityTime(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    !Number.isFinite(Date.parse(value))
  )
    return null;
  return new Date(value).toISOString();
}

function parseSnapshot(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function safeStageStatus(value) {
  return STAGE_STATUSES.has(value) ? value : "active";
}

function safeProgressSteps(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-MAX_STEPS)
    .map((step) => {
      const definition = STAGE_DEFINITIONS[step?.stage];
      const at = safeActivityTime(step?.at);
      if (!definition || !at) return null;
      const count = safeInteger(step?.count, { min: 0, max: 100_000 });
      const attemptNumber = safeInteger(step?.attemptNumber, {
        min: 1,
        max: 99,
      });
      return {
        stage: step.stage,
        kind: definition.kind,
        label: definition.label,
        status: safeStageStatus(step.status),
        at,
        ...(count == null ? {} : { count }),
        ...(attemptNumber == null ? {} : { attemptNumber }),
      };
    })
    .filter(Boolean);
}

/**
 * Projects the temporary database snapshot to the only four fields that may be
 * returned to clients. The strict kind check prevents an authoritative success
 * or failure evidence object from ever being mistaken for live progress.
 */
export function generationProgressFromSnapshot(value) {
  const snapshot = parseSnapshot(value);
  const progress =
    snapshot?.kind === PROGRESS_KIND
      ? snapshot.progress
      : snapshot?.kind === "restaurant_employee_execution_evidence"
        ? snapshot.generationProgress
        : snapshot?.executionProgress || null;
  if (!progress || typeof progress !== "object" || Array.isArray(progress))
    return null;
  const receivedChars = safeInteger(progress.receivedChars, {
    min: 0,
    max: 100_000_000,
  });
  const attemptNumber = safeInteger(progress.attemptNumber, {
    min: 1,
    max: 99,
  });
  const phase = PHASES.has(progress.phase) ? progress.phase : null;
  const lastActivityAt = safeActivityTime(progress.lastActivityAt);
  if (
    receivedChars == null ||
    attemptNumber == null ||
    !phase ||
    !lastActivityAt
  )
    return null;
  const steps = safeProgressSteps(progress.steps);
  const currentStage = STAGE_DEFINITIONS[progress.currentStage]
    ? progress.currentStage
    : steps.at(-1)?.stage || null;
  const currentDefinition = currentStage
    ? STAGE_DEFINITIONS[currentStage]
    : null;
  return {
    receivedChars,
    lastActivityAt,
    attemptNumber,
    phase,
    ...(currentDefinition
      ? {
          currentStage,
          currentLabel: currentDefinition.label,
          percent: currentDefinition.percent,
          steps,
        }
      : {}),
  };
}

/**
 * Creates a throttled heartbeat. Callers pass counts only; streamed text,
 * prompts, URLs, credentials and provider errors are deliberately absent from
 * both the input contract and the persisted snapshot.
 */
export function createEmployeeGenerationProgressHeartbeat({
  write,
  now = () => Date.now(),
  minIntervalMs = EMPLOYEE_GENERATION_PROGRESS_INTERVAL_MS,
  minCharDelta = EMPLOYEE_GENERATION_PROGRESS_CHAR_DELTA,
} = {}) {
  if (typeof write !== "function")
    throw new TypeError("generation progress write callback is required");
  let lastAttempted = null;
  let latestProgress = null;
  let steps = [];

  const persist = (progress) => {
    latestProgress = progress;
    const snapshot = { kind: PROGRESS_KIND, progress };
    return write(snapshot, progress) !== false;
  };

  const heartbeat = (raw) => {
    const receivedChars = safeInteger(raw?.receivedChars, {
      min: 0,
      max: 100_000_000,
    });
    const attemptNumber = safeInteger(raw?.attemptNumber, { min: 1, max: 99 });
    const phase = PHASES.has(raw?.phase) ? raw.phase : null;
    if (receivedChars == null || attemptNumber == null || !phase) return false;

    const timestamp = Number(now());
    if (!Number.isFinite(timestamp)) return false;
    const attemptChanged =
      !lastAttempted ||
      lastAttempted.attemptNumber !== attemptNumber ||
      lastAttempted.phase !== phase;
    const enoughTime = lastAttempted
      ? timestamp - lastAttempted.attemptedAt >=
        Math.max(0, Number(minIntervalMs) || 0)
      : true;
    const enoughChars = lastAttempted
      ? receivedChars - lastAttempted.receivedChars >=
        Math.max(0, Number(minCharDelta) || 0)
      : true;
    if (!attemptChanged && !enoughTime && !enoughChars) return false;

    const currentStage =
      latestProgress?.currentStage ||
      (phase === "repair" ? "repair" : "generate");
    const progress = {
      receivedChars,
      lastActivityAt: new Date(timestamp).toISOString(),
      attemptNumber,
      phase,
      ...(steps.length
        ? {
            currentStage,
            currentLabel: STAGE_DEFINITIONS[currentStage].label,
            percent: STAGE_DEFINITIONS[currentStage].percent,
            steps,
          }
        : {}),
    };
    // DB锁竞争时仍从本次尝试起做最小退避，避免后续每个SSE分片都立即重试UPDATE。
    lastAttempted = { ...progress, attemptedAt: timestamp };
    if (!persist(progress)) return false;
    return true;
  };

  heartbeat.stage = (stage, raw = {}) => {
    const definition = STAGE_DEFINITIONS[stage];
    if (!definition) return false;
    const timestamp = Number(now());
    if (!Number.isFinite(timestamp)) return false;
    const at = new Date(timestamp).toISOString();
    const status = safeStageStatus(raw.status);
    const count = safeInteger(raw.count, { min: 0, max: 100_000 });
    const attemptNumber = safeInteger(raw.attemptNumber, { min: 1, max: 99 });
    const nextStep = {
      stage,
      kind: definition.kind,
      label: definition.label,
      status,
      at,
      ...(count == null ? {} : { count }),
      ...(attemptNumber == null ? {} : { attemptNumber }),
    };
    const previous = steps.at(-1);
    if (previous?.stage === stage && previous?.status === status) {
      steps = [...steps.slice(0, -1), nextStep];
    } else {
      steps = [...steps, nextStep].slice(-MAX_STEPS);
    }
    const phase =
      stage === "repair"
        ? "repair"
        : latestProgress?.phase || raw.phase || "acquire";
    const progress = {
      receivedChars: latestProgress?.receivedChars || 0,
      lastActivityAt: at,
      attemptNumber: attemptNumber || latestProgress?.attemptNumber || 1,
      phase: PHASES.has(phase) ? phase : "acquire",
      currentStage: stage,
      currentLabel: definition.label,
      percent: definition.percent,
      steps,
    };
    return persist(progress);
  };

  heartbeat.snapshot = () =>
    latestProgress ? structuredClone(latestProgress) : null;
  return heartbeat;
}

import { sanitizeProviderError } from "./provider-errors.js";

export const CONTENT_SPECIAL_HANDLER_RUNTIME_SCHEMA =
  "nanowork.content-special-handler-runtime/1";
export const CONTENT_SPECIAL_HANDLER_ARTIFACT_SCHEMA =
  "nanowork.content-special-handler-artifact/1";

export const CONTENT_SPECIAL_HANDLER_KINDS = Object.freeze([
  "text_json",
  "media_generation_with_svg_fallback",
  "cover_generation_with_html_fallback",
  "html_generation",
]);

const SECRET_KEY =
  /(?:^|_)(?:api_?key|authorization|cookie|credential|password|private_?key|secret|access_?token|refresh_?token)(?:$|_)/iu;
const SECRET_TEXT_PATTERNS = Object.freeze([
  Object.freeze({
    pattern: /\bsk-\s*[a-z0-9_-]{8,}\b/giu,
    replacement: "[REDACTED]",
  }),
  Object.freeze({
    pattern: /\bBearer\s+[a-z0-9._~+\/-]{8,}\b/giu,
    replacement: "[REDACTED]",
  }),
  Object.freeze({
    pattern:
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[:=]\s*)[^\s,;]+/giu,
    replacement: "$1[REDACTED]",
  }),
]);

const DEFAULT_MIME = Object.freeze({
  json: "application/json",
  html: "text/html",
  svg: "image/svg+xml",
  image: "image/png",
  material: "application/octet-stream",
});

const TERMINAL_PROVIDER_BILLING_STATES = new Set([
  "settled",
  "released",
  "not_held",
]);
const SAFE_CONTENT_PROVIDER_ERROR_CODE = /^CONTENT_[A-Z0-9_]{1,120}$/u;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactText(value) {
  let output = String(value ?? "");
  for (const { pattern, replacement } of SECRET_TEXT_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function sanitizeValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value);
  if (value === null || ["number", "boolean"].includes(typeof value))
    return value;
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[CIRCULAR_REMOVED]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => sanitizeValue(item, seen));
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    const sanitized = sanitizeValue(child, seen);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  seen.delete(value);
  return result;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function usageOf(response) {
  const usage = isRecord(response?.usage) ? response.usage : {};
  const inputTokens = positiveNumber(
    usage.inputTokens ?? usage.prompt_tokens ?? response?.inputTokens,
  );
  const outputTokens = positiveNumber(
    usage.outputTokens ?? usage.completion_tokens ?? response?.outputTokens,
  );
  const explicitTotal = positiveNumber(
    usage.totalTokens ?? usage.total_tokens ?? response?.tokens,
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens: explicitTotal || inputTokens + outputTokens,
  };
}

function costOf(response) {
  const source = isRecord(response?.cost) ? response.cost : {};
  return {
    amount: positiveNumber(
      source.amount ?? response?.costUsd ?? response?.cost_usd,
    ),
    currency: String(
      source.currency ||
        (response?.costUsd != null || response?.cost_usd != null ? "USD" : ""),
    ).toUpperCase(),
    credits: positiveNumber(source.credits ?? response?.credits),
  };
}

function providerOf(response, providerKind) {
  const provider = isRecord(response?.provider) ? response.provider : {};
  return {
    kind: providerKind,
    name: redactText(provider.name || response?.providerName || providerKind),
    model: redactText(provider.model || response?.model || ""),
    mode: redactText(provider.mode || response?.mode || "injected"),
  };
}

function providerBillingOf(invocation) {
  const responseBilling = isRecord(invocation?.response?.bridge?.billing)
    ? invocation.response.bridge.billing
    : null;
  const failureBilling = isRecord(invocation?.billing)
    ? invocation.billing
    : null;
  const billing = responseBilling || failureBilling;
  if (!billing) return null;
  const state = redactText(billing.state || billing.status || "")
    .trim()
    .toLowerCase();
  return {
    ...sanitizeValue(billing),
    state: state || "unknown",
    pendingReconciliation:
      billing.pendingReconciliation === true ||
      state === "pending_reconciliation",
  };
}

function providerBillingAllowsDependentCall(billing) {
  if (!billing) return true;
  return (
    billing.pendingReconciliation !== true &&
    TERMINAL_PROVIDER_BILLING_STATES.has(billing.state)
  );
}

function contentProviderErrorCode(error) {
  const code = String(error?.code || "").trim();
  return SAFE_CONTENT_PROVIDER_ERROR_CODE.test(code) ? code : null;
}

function providerFailureStatus(error) {
  const candidates = [error?.providerStatus, error?.status];
  for (const value of candidates) {
    const status = Number(value);
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      return status;
    }
  }
  return 502;
}

function safeId(value, label) {
  const id = String(value ?? "").trim();
  if (!id) throw Object.assign(new Error(`${label}不能为空`), { status: 400 });
  return redactText(id).slice(0, 160);
}

function safeSegment(value, fallback) {
  const segment = String(value ?? "")
    .normalize("NFKC")
    .replace(/[^a-z0-9_-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return segment || fallback;
}

function parseJsonText(value) {
  const text = String(value ?? "").trim();
  const fenced =
    text.match(/^```json(?:\s+)([\s\S]*?)(?:\s*)```$/iu)?.[1]?.trim() || text;
  if (!fenced) return null;
  try {
    return JSON.parse(fenced);
  } catch {
    return null;
  }
}

function dataOf(response) {
  if (isRecord(response?.data) || Array.isArray(response?.data))
    return sanitizeValue(response.data);
  const parsed = parseJsonText(response?.text);
  return parsed == null ? null : sanitizeValue(parsed);
}

function inferMime(value, fallback) {
  const explicit = String(value?.mimeType || value?.mime || "")
    .trim()
    .toLowerCase();
  if (explicit) return explicit;
  const source = String(value?.file || value?.url || "");
  if (/\.jpe?g(?:$|[?#])/iu.test(source)) return "image/jpeg";
  if (/\.webp(?:$|[?#])/iu.test(source)) return "image/webp";
  if (/\.svg(?:$|[?#])/iu.test(source)) return DEFAULT_MIME.svg;
  if (/\.html?(?:$|[?#])/iu.test(source)) return DEFAULT_MIME.html;
  return fallback;
}

function artifactFileName({ runId, invocationId, index, extension }) {
  return `content-${safeSegment(runId, "run")}-${safeSegment(invocationId, "invocation")}-${index + 1}.${extension}`;
}

function artifactBase({
  runId,
  invocationId,
  index,
  kind,
  mimeType,
  provider,
  fallback,
  fileName,
}) {
  return {
    schemaVersion: CONTENT_SPECIAL_HANDLER_ARTIFACT_SCHEMA,
    artifactId: `${invocationId}:${index + 1}`,
    runId,
    invocationId,
    kind,
    mimeType,
    fileName,
    provider,
    fallback,
  };
}

function normalizeMediaEntries(response) {
  const data = dataOf(response);
  const candidates = [
    ...(Array.isArray(response?.assets) ? response.assets : []),
    ...(Array.isArray(response?.images) ? response.images : []),
    ...(Array.isArray(data?.assets) ? data.assets : []),
    ...(Array.isArray(data?.images) ? data.images : []),
  ];
  if (!candidates.length && (response?.url || response?.b64 || response?.file))
    candidates.push(response);
  return candidates
    .map((item) => sanitizeValue(item))
    .filter((item) => isRecord(item));
}

function normalizeImagePlan(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 12)
    .map((item) => {
      if (!isRecord(item)) return null;
      const slot = redactText(item.slot || "")
        .trim()
        .slice(0, 160);
      const desc = redactText(item.desc || item.description || "")
        .trim()
        .slice(0, 2_000);
      return slot && desc ? { slot, desc } : null;
    })
    .filter(Boolean);
}

function normalizeCoverPlan(value, platforms) {
  const requestedPlatforms = Array.isArray(platforms)
    ? platforms
        .map((item) => redactText(item).trim())
        .filter(Boolean)
        .slice(0, 4)
    : [];
  const source = Array.isArray(value) ? value : [];
  return requestedPlatforms.map((platform, index) => {
    const item = isRecord(source[index]) ? source[index] : {};
    const size = String(item.size || "1024x1024").trim();
    const safeSize = /^\d{3,5}x\d{3,5}$/u.test(size) ? size : "1024x1024";
    return {
      slot:
        redactText(item.slot || `${platform}封面`)
          .trim()
          .slice(0, 160) || `${platform}封面`,
      desc: redactText(
        item.desc ||
          item.description ||
          `为${platform}生成一张独立的中文内容封面位图`,
      )
        .trim()
        .slice(0, 4_000),
      platform,
      size: safeSize,
      displaySize: redactText(item.displaySize || item.display_size || safeSize)
        .trim()
        .slice(0, 120),
      style:
        redactText(item.style || "AI封面")
          .trim()
          .slice(0, 120) || "AI封面",
    };
  });
}

function rasterMimeFromBytes(bytes) {
  if (!bytes || bytes.length < 3) return "";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  if (
    bytes.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)))
  )
    return "image/gif";
  return "";
}

function rasterMimeFromBase64(value) {
  const base64 = String(value || "").trim();
  if (!base64 || !/^[a-z0-9+/]+={0,2}$/iu.test(base64)) return "";
  try {
    return rasterMimeFromBytes(Uint8Array.from(Buffer.from(base64, "base64")));
  } catch {
    return "";
  }
}

function previewableRasterEntry(item) {
  if (!isRecord(item)) return false;
  const mimeType = inferMime(item, DEFAULT_MIME.image);
  if (!/^image\/(?:png|jpe?g|webp|gif)$/iu.test(mimeType)) return false;
  if (typeof item.url === "string" && /^https?:\/\//iu.test(item.url.trim())) {
    try {
      const pathname = new URL(item.url.trim()).pathname.toLowerCase();
      if (/\.(?:svg|html?|xml|json|txt)$/iu.test(pathname)) return false;
      return true;
    } catch {
      return false;
    }
  }
  if (typeof item.b64 === "string" && item.b64.trim()) {
    const detected = rasterMimeFromBase64(item.b64);
    return (
      detected === mimeType ||
      (detected === "image/jpeg" && mimeType === "image/jpg")
    );
  }
  if (typeof item.content !== "string") return false;
  const match = item.content
    .trim()
    .match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([a-z0-9+/=]+)$/iu);
  if (!match) return false;
  const detected = rasterMimeFromBase64(match[2]);
  const contentMime = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
  return (
    detected === contentMime &&
    detected === mimeType.replace("image/jpg", "image/jpeg")
  );
}

function mediaArtifact(
  item,
  context,
  provider,
  fallback,
  index,
  kind = "image",
) {
  const mimeType = inferMime(
    item,
    kind === "material" ? DEFAULT_MIME.material : DEFAULT_MIME.image,
  );
  const extension =
    mimeType === "image/jpeg"
      ? "jpg"
      : mimeType === "image/webp"
        ? "webp"
        : mimeType === DEFAULT_MIME.svg
          ? "svg"
          : "png";
  const artifact = artifactBase({
    ...context,
    index,
    kind,
    mimeType,
    provider,
    fallback,
    fileName:
      String(item.fileName || item.file || "").trim() ||
      artifactFileName({ ...context, index, extension }),
  });
  if (item.url) artifact.url = redactText(item.url);
  if (item.b64) artifact.base64 = redactText(item.b64);
  if (item.content) artifact.content = redactText(item.content);
  if (item.slot) artifact.slot = redactText(item.slot);
  if (item.desc) artifact.description = redactText(item.desc);
  if (item.sourceUrl) artifact.sourceUrl = redactText(item.sourceUrl);
  if (
    Number.isSafeInteger(Number(item.materialId)) &&
    Number(item.materialId) > 0
  ) {
    artifact.sourceMaterialId = Number(item.materialId);
  }
  if (isRecord(item.rights)) {
    artifact.rights = sanitizeValue({
      confirmed: item.rights.confirmed === true,
      commercialUse: item.rights.commercialUse === true,
      license: redactText(item.rights.license || ""),
      attribution: redactText(item.rights.attribution || "") || null,
    });
  }
  return artifact;
}

function htmlEntries(response, collectionKey, property = "html") {
  const data = dataOf(response);
  const collection = Array.isArray(data?.[collectionKey])
    ? data[collectionKey]
    : [];
  const entries = collection
    .map((item) => ({
      ...sanitizeValue(item),
      content: redactText(item?.[property] || ""),
    }))
    .filter((item) => item.content.trim());
  if (entries.length) return entries;
  const direct = response?.[property] || data?.[property];
  if (typeof direct === "string" && direct.trim())
    return [{ content: redactText(direct) }];
  const text = String(response?.text || "").trim();
  if (text.startsWith("<")) return [{ content: redactText(text) }];
  return [];
}

function svgEntries(response) {
  const data = dataOf(response);
  const images = Array.isArray(data?.images) ? data.images : [];
  const entries = images
    .map((item) => ({
      ...sanitizeValue(item),
      content: redactText(item?.svg || ""),
    }))
    .filter((item) => /^<svg(?:\s|>)/iu.test(item.content.trim()));
  const direct = response?.svg || data?.svg;
  if (
    !entries.length &&
    typeof direct === "string" &&
    /^<svg(?:\s|>)/iu.test(direct.trim())
  ) {
    entries.push({ content: redactText(direct) });
  }
  return entries;
}

function attemptRecord({
  attemptId,
  providerKind,
  purpose,
  response,
  status,
  error,
  providerErrorCode,
  billing,
  startedAt,
  completedAt,
}) {
  return {
    attemptId,
    providerKind,
    purpose,
    status,
    startedAt,
    completedAt,
    provider: providerOf(response, providerKind),
    usage: usageOf(response),
    cost: costOf(response),
    ...(error
      ? {
          error: error.message,
          providerReason: error.providerReason || "network",
          ...(providerErrorCode ? { providerErrorCode } : {}),
          ...(billing ? { billing: sanitizeValue(billing) } : {}),
        }
      : {}),
  };
}

function aggregateAttempts(attempts) {
  const usage = attempts.reduce(
    (total, attempt) => ({
      inputTokens: total.inputTokens + attempt.usage.inputTokens,
      outputTokens: total.outputTokens + attempt.usage.outputTokens,
      totalTokens: total.totalTokens + attempt.usage.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  const byCurrency = {};
  let credits = 0;
  for (const attempt of attempts) {
    if (attempt.cost.amount > 0 && attempt.cost.currency) {
      byCurrency[attempt.cost.currency] =
        (byCurrency[attempt.cost.currency] || 0) + attempt.cost.amount;
    }
    credits += attempt.cost.credits;
  }
  return { usage, cost: { byCurrency, credits } };
}

function runtimeFailure(message, evidence, status = 502, billing = null) {
  const error = new Error(message);
  const failedEvidence = {
    ...evidence,
    completed: false,
    ...(evidence?.deliveryClaim === "paihuo_real_image"
      ? {
          deliveryClaim: "paihuo_real_image_failed_closed",
          requestedDeliveryClaim: "paihuo_real_image",
          paihuoRealImage: false,
        }
      : {}),
  };
  Object.defineProperties(error, {
    name: { value: "ContentSpecialHandlerRuntimeError" },
    code: { value: "CONTENT_SPECIAL_HANDLER_RUNTIME_FAILED", enumerable: true },
    status: { value: status, enumerable: true },
    evidence: { value: failedEvidence, enumerable: true },
    ...(billing
      ? { billing: { value: sanitizeValue(billing), enumerable: true } }
      : {}),
  });
  return error;
}

function validateProvider(providers, key) {
  return typeof providers?.[key] === "function" ? providers[key] : null;
}

/**
 * Execute the provider-specific portion of a content handler. This module has no
 * network or filesystem imports: routes inject tenant-authorized providers and
 * persist the returned artifacts only after their own billing/approval checks.
 */
export async function executeContentSpecialHandlerRuntime({
  executionKind,
  runId: rawRunId,
  invocationId: rawInvocationId,
  prompt = {},
  variables = {},
  providers = {},
  signal,
  now = () => new Date(),
} = {}) {
  if (!CONTENT_SPECIAL_HANDLER_KINDS.includes(executionKind)) {
    throw Object.assign(
      new Error(`不支持的内容handler执行类型：${redactText(executionKind)}`),
      { status: 400 },
    );
  }
  const runId = safeId(rawRunId, "runId");
  const invocationId = safeId(rawInvocationId, "invocationId");
  const startedAt = now().toISOString();
  const safePrompt = sanitizeValue(prompt);
  const safeVariables = sanitizeValue(variables);
  const attempts = [];
  const context = { runId, invocationId };

  const invoke = async (providerKind, purpose, providerInput) => {
    const provider = validateProvider(providers, providerKind);
    if (!provider) return { skipped: true, response: null, error: null };
    const attemptId =
      `${invocationId}:provider:${safeSegment(providerKind, "provider")}` +
      `:purpose:${safeSegment(purpose, "call")}:attempt:1`;
    const attemptStartedAt = now().toISOString();
    try {
      const response = await provider({
        runId,
        invocationId,
        executionKind,
        purpose,
        prompt: safePrompt,
        variables: safeVariables,
        signal,
        ...sanitizeValue(providerInput),
      });
      attempts.push(
        attemptRecord({
          attemptId,
          providerKind,
          purpose,
          response,
          status: "succeeded",
          startedAt: attemptStartedAt,
          completedAt: now().toISOString(),
        }),
      );
      return { skipped: false, response, error: null };
    } catch (rawError) {
      const error = sanitizeProviderError(rawError, {
        service: `${providerKind}内容供应商`,
      });
      const providerErrorCode = contentProviderErrorCode(rawError);
      const billing = isRecord(rawError?.billing)
        ? sanitizeValue(rawError.billing)
        : null;
      attempts.push(
        attemptRecord({
          attemptId,
          providerKind,
          purpose,
          response: null,
          status: "failed",
          error,
          providerErrorCode,
          billing,
          startedAt: attemptStartedAt,
          completedAt: now().toISOString(),
        }),
      );
      return {
        skipped: false,
        response: null,
        error,
        providerErrorCode,
        billing,
      };
    }
  };

  let artifacts = [];
  let fallback = { used: false, from: null, to: null, reason: null };

  if (executionKind === "text_json") {
    const text = await invoke("text", "structured_json", {
      responseFormat: "json",
    });
    const data = dataOf(text.response);
    if (text.skipped || data == null) {
      const partialEvidence = buildEvidence({
        executionKind,
        runId,
        invocationId,
        startedAt,
        now,
        attempts,
        fallback,
        artifacts,
      });
      throw runtimeFailure(
        "文本内容供应商未返回可交付的JSON产物",
        partialEvidence,
      );
    }
    const provider = providerOf(text.response, "text");
    artifacts = [
      {
        ...artifactBase({
          ...context,
          index: 0,
          kind: "json",
          mimeType: DEFAULT_MIME.json,
          provider,
          fallback,
          fileName: artifactFileName({
            ...context,
            index: 0,
            extension: "json",
          }),
        }),
        data,
        content: JSON.stringify(data),
      },
    ];
  }

  if (executionKind === "media_generation_with_svg_fallback") {
    const request = isRecord(safeVariables?.media_request)
      ? safeVariables.media_request
      : {};
    const mode = ["real", "mix", "ai"].includes(request.mode)
      ? request.mode
      : "ai";
    const plan = normalizeImagePlan(request.plan);
    const rawImageCount = request.imageCount ?? request.image_count ?? null;
    const automaticCount =
      rawImageCount === null ||
      rawImageCount === undefined ||
      Number(rawImageCount) === 0;
    if (automaticCount && (plan.length < 2 || plan.length > 4)) {
      const partialEvidence = buildEvidence({
        executionKind,
        runId,
        invocationId,
        startedAt,
        now,
        attempts,
        fallback,
        artifacts,
      });
      throw runtimeFailure(
        "station5自动图片数量必须取上游image_plan的2-4个有效槽位",
        partialEvidence,
        422,
      );
    }
    const explicitCount = Number(rawImageCount);
    if (
      !automaticCount &&
      (!Number.isSafeInteger(explicitCount) ||
        explicitCount < 1 ||
        explicitCount > 12)
    ) {
      const partialEvidence = buildEvidence({
        executionKind,
        runId,
        invocationId,
        startedAt,
        now,
        attempts,
        fallback,
        artifacts,
      });
      throw runtimeFailure(
        "station5显式图片数量必须是1-12的整数",
        partialEvidence,
        422,
      );
    }
    const total = automaticCount ? plan.length : explicitCount;
    const platforms = Array.isArray(request.platforms)
      ? request.platforms
          .map((item) => redactText(item).trim())
          .filter(Boolean)
          .slice(0, 6)
      : [];
    const visualPolicyVersion = String(
      request.visual_policy_version || request.visualPolicyVersion || "legacy",
    )
      .trim()
      .toLowerCase();
    const materialCount =
      mode === "real"
        ? total
        : mode === "mix"
          ? visualPolicyVersion === "v2"
            ? total
            : Math.ceil(total / 2)
          : 0;
    let materialArtifacts = [];
    let materialBilling = null;
    let materialProviderFailed = false;
    let materialProviderErrorCode = null;
    if (materialCount > 0) {
      const material = await invoke("material", "licensed_material_search", {
        count: materialCount,
        mode,
        imagePlan: plan.slice(0, materialCount),
        platforms,
      });
      materialBilling = providerBillingOf(material);
      materialProviderFailed = Boolean(material.error);
      materialProviderErrorCode = material.providerErrorCode || null;
      if (material.error && mode === "real") {
        const partialEvidence = buildEvidence({
          executionKind,
          runId,
          invocationId,
          startedAt,
          now,
          attempts,
          fallback,
          artifacts: materialArtifacts,
        });
        throw runtimeFailure(
          "已授权真实素材供应商调用失败，已停止任务；不会把未取得的素材冒充为真实素材",
          partialEvidence,
          providerFailureStatus(material.error),
          material.billing,
        );
      }
      if (!material.error) {
        const entries = normalizeMediaEntries(material.response)
          .filter(previewableRasterEntry)
          .slice(0, materialCount);
        const provider = providerOf(material.response, "material");
        materialArtifacts = entries.map((item, index) =>
          mediaArtifact(item, context, provider, fallback, index, "material"),
        );
      }
    }
    if (mode === "real" && materialArtifacts.length !== total) {
      const partialEvidence = buildEvidence({
        executionKind,
        runId,
        invocationId,
        startedAt,
        now,
        attempts,
        fallback,
        artifacts: materialArtifacts,
      });
      throw runtimeFailure(
        "真实素材模式未取得足量的已授权素材，已停止任务；不会改用AI生图冒充",
        partialEvidence,
        422,
      );
    }
    if (
      mode === "mix" &&
      materialArtifacts.length < total &&
      !providerBillingAllowsDependentCall(materialBilling)
    ) {
      const partialEvidence = {
        ...buildEvidence({
          executionKind,
          runId,
          invocationId,
          startedAt,
          now,
          attempts,
          fallback,
          artifacts: materialArtifacts,
        }),
        billingGate: {
          providerKind: "material",
          state: materialBilling.state,
          pendingReconciliation: materialBilling.pendingReconciliation === true,
          allowedToCallImageProvider: false,
          action: "blocked_before_ai_image_fill",
        },
      };
      throw runtimeFailure(
        `授权素材账务尚未终结（state=${materialBilling.state}），已在GPT Image 2补图前停止；不会叠加新的图片预授权，请先完成当前素材占扣对账后重试`,
        partialEvidence,
        409,
        materialBilling,
      );
    }
    if (mode === "mix" && materialArtifacts.length < materialCount) {
      const materialFallbackReason = materialProviderFailed
        ? `已授权真实素材供应商调用失败${
            materialProviderErrorCode
              ? `（错误码${materialProviderErrorCode}）`
              : ""
          }；缺口自动交给GPT Image 2生成，AI生成图不会标记为实拍或授权素材`
        : `已授权真实素材只取得${materialArtifacts.length}/${materialCount}张；` +
          "缺口自动交给GPT Image 2生成，AI生成图不会标记为实拍或授权素材";
      fallback = {
        used: true,
        from: "licensed_material_search",
        to: "gpt-image-2",
        strategy: "licensed_material_to_ai_image",
        ...(materialProviderErrorCode
          ? { providerErrorCode: materialProviderErrorCode }
          : {}),
        reason: materialFallbackReason,
      };
    }
    if (mode === "real") {
      artifacts = materialArtifacts;
    } else {
      const imageCount = Math.max(0, total - materialArtifacts.length);
      const image =
        imageCount > 0
          ? await invoke("image", "content_images", {
              count: imageCount,
              materials: materialArtifacts,
              imagePlan: plan.slice(
                materialArtifacts.length,
                materialArtifacts.length + imageCount,
              ),
              platforms,
            })
          : { skipped: true, response: null, error: null };
      if (image.error) {
        const partialEvidence = buildEvidence({
          executionKind,
          runId,
          invocationId,
          startedAt,
          now,
          attempts,
          fallback,
          artifacts: materialArtifacts,
        });
        throw runtimeFailure(
          `${mode === "mix" ? "GPT Image 2补图" : "AI图片"}供应商调用失败，已停止任务；不会用SVG、HTML或不足张数冒充完整交付`,
          partialEvidence,
          providerFailureStatus(image.error),
          image.billing,
        );
      }
      const provider = providerOf(image.response, "image");
      if (
        fallback.used === true &&
        fallback.strategy === "licensed_material_to_ai_image" &&
        provider.model
      ) {
        fallback = { ...fallback, to: provider.model };
      }
      const imageArtifacts = normalizeMediaEntries(image.response)
        .filter(previewableRasterEntry)
        .slice(0, imageCount)
        .map((item, index) =>
          mediaArtifact(
            item,
            context,
            provider,
            fallback,
            materialArtifacts.length + index,
          ),
        );
      artifacts = [...materialArtifacts, ...imageArtifacts];
      if (imageCount > 0 && imageArtifacts.length !== imageCount) {
        const partialEvidence = buildEvidence({
          executionKind,
          runId,
          invocationId,
          startedAt,
          now,
          attempts,
          fallback,
          artifacts,
        });
        throw runtimeFailure(
          `${mode === "mix" ? "GPT Image 2补图" : "AI配图"}只取得${imageArtifacts.length}/${imageCount}张可预览位图，已停止任务；不会用SVG示意图冒充配图，也不会用HTML或不足张数冒充完整交付`,
          partialEvidence,
          502,
        );
      }
    }
  }

  if (executionKind === "cover_generation_with_html_fallback") {
    // Paihuo run_cover：先逐平台真实生图；失败再回退 HTML 封面卡。
    // HTML 回退不得标记为 Paihuo 真实生图。
    const request = isRecord(safeVariables?.cover_request)
      ? safeVariables.cover_request
      : {};
    const platforms = Array.isArray(request.platforms)
      ? request.platforms
          .map((item) => redactText(item).trim())
          .filter(Boolean)
          .slice(0, 4)
      : [];
    if (!platforms.length) {
      const partialEvidence = buildEvidence({
        executionKind,
        runId,
        invocationId,
        startedAt,
        now,
        attempts,
        fallback,
        artifacts,
        deliveryClaim: "paihuo_real_image",
      });
      throw runtimeFailure(
        "封面生成缺少目标平台，已在provider调用前fail closed",
        partialEvidence,
        422,
      );
    }
    const mode = String(request.mode || "image")
      .trim()
      .toLowerCase();
    if (mode === "html") {
      const html = await invoke("text", "html_cover_compatibility", {
        responseFormat: "json_with_html",
        platforms,
        paihuoRealImageClaim: false,
      });
      const provider = providerOf(html.response, "text");
      artifacts = htmlEntries(html.response, "covers").map((item, index) => ({
        ...artifactBase({
          ...context,
          index,
          kind: "html",
          mimeType: DEFAULT_MIME.html,
          provider,
          fallback,
          fileName: artifactFileName({ ...context, index, extension: "html" }),
        }),
        content: item.content,
        ...(item.platform ? { platform: redactText(item.platform) } : {}),
        paihuoRealImage: false,
      }));
    } else if (["image", "ai", "real_image"].includes(mode)) {
      const plan = normalizeCoverPlan(request.plan, platforms);
      const image = await invoke("image", "platform_covers", {
        count: plan.length,
        platforms,
        coverPlan: plan,
        imagePlan: plan,
        paihuoRealImageClaim: true,
      });
      const provider = providerOf(image.response, "image");
      const entries = normalizeMediaEntries(image.response)
        .filter(previewableRasterEntry)
        .slice(0, plan.length);
      artifacts = entries.map((item, index) => ({
        ...mediaArtifact(item, context, provider, fallback, index, "image"),
        platform: redactText(item.platform || plan[index]?.platform || ""),
        size: redactText(item.size || plan[index]?.size || ""),
        displaySize: redactText(
          item.displaySize ||
            item.display_size ||
            plan[index]?.displaySize ||
            "",
        ),
        style: redactText(item.style || plan[index]?.style || "AI封面"),
        paihuoRealImage: true,
      }));
      if (image.skipped || image.error || artifacts.length !== plan.length) {
        fallback = {
          used: true,
          from: image.skipped ? "image_provider_unavailable" : "image_provider",
          to: "text_provider_html",
          reason: image.error
            ? image.error.message
            : image.skipped
              ? "封面图片provider未配置，回退HTML封面卡"
              : "封面图片provider未返回全部可预览位图，回退HTML封面卡",
        };
        const html = await invoke("text", "html_cover_fallback", {
          responseFormat: "json_with_html",
          platforms,
          paihuoRealImageClaim: false,
        });
        const htmlProvider = providerOf(html.response, "text");
        artifacts = htmlEntries(html.response, "covers").map((item, index) => ({
          ...artifactBase({
            ...context,
            index,
            kind: "html",
            mimeType: DEFAULT_MIME.html,
            provider: htmlProvider,
            fallback,
            fileName: artifactFileName({
              ...context,
              index,
              extension: "html",
            }),
          }),
          content: item.content,
          ...(item.platform ? { platform: redactText(item.platform) } : {}),
          paihuoRealImage: false,
        }));
        if (html.skipped || html.error || !artifacts.length) {
          const partialEvidence = buildEvidence({
            executionKind,
            runId,
            invocationId,
            startedAt,
            now,
            attempts,
            fallback,
            artifacts,
            deliveryClaim: "paihuo_real_image",
          });
          throw runtimeFailure(
            html.skipped || html.error
              ? "封面图片失败后HTML回退也未交付，已按未完成处理"
              : "封面HTML回退未返回可交付产物",
            partialEvidence,
            image.skipped ? 503 : 502,
            image.billing || html.billing,
          );
        }
      }
    } else {
      const partialEvidence = buildEvidence({
        executionKind,
        runId,
        invocationId,
        startedAt,
        now,
        attempts,
        fallback,
        artifacts,
        deliveryClaim: "invalid_cover_mode",
      });
      throw runtimeFailure(
        "cover_request.mode必须是image或显式html",
        partialEvidence,
        422,
      );
    }
  }

  if (executionKind === "html_generation") {
    const html = await invoke("text", "standalone_html", {
      responseFormat: "html",
    });
    const provider = providerOf(html.response, "text");
    artifacts = htmlEntries(html.response, "items")
      .slice(0, 1)
      .map((item, index) => ({
        ...artifactBase({
          ...context,
          index,
          kind: "html",
          mimeType: DEFAULT_MIME.html,
          provider,
          fallback,
          fileName: artifactFileName({ ...context, index, extension: "html" }),
        }),
        content: item.content,
      }));
  }

  if (!artifacts.length) {
    const partialEvidence = buildEvidence({
      executionKind,
      runId,
      invocationId,
      startedAt,
      now,
      attempts,
      fallback,
      artifacts,
    });
    throw runtimeFailure("内容供应商未返回可交付产物", partialEvidence);
  }

  const evidence = buildEvidence({
    executionKind,
    runId,
    invocationId,
    startedAt,
    now,
    attempts,
    fallback,
    artifacts,
    deliveryClaim:
      executionKind === "cover_generation_with_html_fallback"
        ? artifacts.every((artifact) => artifact.paihuoRealImage === true)
          ? "paihuo_real_image"
          : "legacy_html_compatibility"
        : null,
  });
  return {
    ok: true,
    schemaVersion: CONTENT_SPECIAL_HANDLER_RUNTIME_SCHEMA,
    executionKind,
    runId,
    invocationId,
    artifacts,
    evidence,
  };
}

function buildEvidence({
  executionKind,
  runId,
  invocationId,
  startedAt,
  now,
  attempts,
  fallback,
  artifacts,
  deliveryClaim = null,
}) {
  const aggregate = aggregateAttempts(attempts);
  return {
    schemaVersion: CONTENT_SPECIAL_HANDLER_RUNTIME_SCHEMA,
    executionKind,
    runId,
    invocationId,
    startedAt,
    completedAt: now().toISOString(),
    completed: artifacts.length > 0,
    providerAttempts: attempts,
    providerKindsCalled: [
      ...new Set(attempts.map((attempt) => attempt.providerKind)),
    ],
    fallback,
    deliveryClaim,
    paihuoRealImage: deliveryClaim === "paihuo_real_image",
    artifactCount: artifacts.length,
    artifacts: artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      fileName: artifact.fileName,
      provider: artifact.provider,
      fallback: artifact.fallback,
    })),
    usage: aggregate.usage,
    cost: aggregate.cost,
    credentialsIncluded: false,
  };
}

import { createHash } from "node:crypto";

export const CONTENT_PAID_MEDIA_AUTHORIZATION_SCHEMA =
  "nanowork.content-paid-media-authorization/3";
export const CONTENT_PAID_MEDIA_PRICING_VERSION =
  "nanowork.image-credit-estimate/1";
export const CONTENT_PAID_MEDIA_AUTHORIZATION_USAGE_SCHEMA =
  "nanowork.content-paid-media-authorization-usage/1";

const AUTHORIZER_ROLES = new Set(["boss", "admin", "platform_super"]);
const IMAGE_MODES = new Set(["ai", "real", "mix"]);
const AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1000;

export class ContentPaidMediaAuthorizationError extends Error {
  constructor(
    message,
    code = "CONTENT_PAID_MEDIA_AUTHORIZATION_INVALID",
    status = 409,
  ) {
    super(message);
    this.name = "ContentPaidMediaAuthorizationError";
    this.code = code;
    this.status = status;
  }
}

function fail(message, code, status) {
  throw new ContentPaidMediaAuthorizationError(message, code, status);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail(`${field}必须是正整数`, undefined, 400);
  }
  return number;
}

function nonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail(`${field}必须是非负整数`, undefined, 400);
  }
  return number;
}

function cleanText(value, max = 160) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function fingerprint(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex")}`;
}

function normalizedImageMode(task) {
  const mode = cleanText(
    task?.image_mode || task?.imageMode || "ai",
    20,
  ).toLowerCase();
  if (!IMAGE_MODES.has(mode)) {
    fail("Brief.image_mode必须是ai、real或mix", undefined, 400);
  }
  return mode;
}

export function contentPaidMediaMaximumContentImageCount(task = {}) {
  const raw = task?.image_count ?? task?.imageCount ?? null;
  if (raw === null || raw === undefined || Number(raw) === 0) return 4;
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 1 || count > 12) {
    fail("Brief.image_count必须是1..12的整数、0或null", undefined, 400);
  }
  return count;
}

export function contentPaidMediaMaximumCoverImageCount(task = {}) {
  const platforms = Array.isArray(task?.platforms)
    ? [
        ...new Set(
          task.platforms.map((item) => cleanText(item, 40)).filter(Boolean),
        ),
      ]
    : [];
  // 封面工位按目标平台逐平台生成，运行时最多允许4个平台；未显式选择时
  // Paihuo Brief默认小红书，因此仍需为1张封面签入上限。
  return Math.max(1, Math.min(4, platforms.length || 1));
}

export function contentPaidMediaMaximumImageCount(task = {}) {
  return (
    contentPaidMediaMaximumContentImageCount(task) +
    contentPaidMediaMaximumCoverImageCount(task)
  );
}

export function contentPaidMediaTaskFingerprint(task = {}) {
  const mode = normalizedImageMode(task);
  const platforms = Array.isArray(task?.platforms)
    ? [
        ...new Set(
          task.platforms.map((item) => cleanText(item, 40)).filter(Boolean),
        ),
      ].sort()
    : [];
  return fingerprint({
    direction: cleanText(task?.direction || task?.title, 2_000),
    imageMode: mode,
    imageCount: task?.image_count ?? task?.imageCount ?? null,
    maximumContentImageCount: contentPaidMediaMaximumContentImageCount(task),
    maximumCoverImageCount: contentPaidMediaMaximumCoverImageCount(task),
    maximumImageCount: contentPaidMediaMaximumImageCount(task),
    platforms,
  });
}

function allowedProviderKinds(mode) {
  if (mode === "ai") return ["image"];
  // real只约束正文配图来源；封面工位6仍按产品契约调用图片provider。
  if (mode === "real") return ["image", "material"];
  return ["image", "material"];
}

export function contentPaidMediaPricingSnapshot({
  imageModel,
  estimatedUnitCredits,
  pricingVersion = CONTENT_PAID_MEDIA_PRICING_VERSION,
} = {}) {
  const normalizedImageModel = cleanText(imageModel, 160);
  if (!normalizedImageModel) {
    fail("付费媒体授权缺少实际图片模型", undefined, 400);
  }
  const normalizedPricingVersion = cleanText(pricingVersion, 160);
  if (!normalizedPricingVersion) {
    fail("付费媒体授权缺少计价版本", undefined, 400);
  }
  const unitCredits = positiveInteger(estimatedUnitCredits, "单张图片预估积分");
  const pricingPayload = {
    imageModel: normalizedImageModel,
    estimatedUnitCredits: unitCredits,
    pricingVersion: normalizedPricingVersion,
  };
  return Object.freeze({
    ...pricingPayload,
    pricingFingerprint: fingerprint(pricingPayload),
  });
}

function normalizedActor(actor) {
  const id = positiveInteger(actor?.id, "授权人id");
  const role = cleanText(actor?.role, 64);
  if (!AUTHORIZER_ROLES.has(role)) {
    fail(
      "付费媒体provider只能由老板、管理员或平台超管授权",
      "CONTENT_PAID_MEDIA_AUTHORITY_REQUIRED",
      403,
    );
  }
  return { id, role, name: cleanText(actor?.name, 120) || null };
}

function authorizationInstant(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) {
    fail("付费媒体授权时间无效", undefined, 500);
  }
  return date.toISOString();
}

export function createContentPaidMediaAuthorization({
  task,
  actor,
  imageModel,
  estimatedUnitCredits,
  pricingVersion = CONTENT_PAID_MEDIA_PRICING_VERSION,
  now = () => new Date(),
} = {}) {
  if (!isRecord(task)) fail("付费媒体授权缺少Brief", undefined, 400);
  const authorizedBy = normalizedActor(actor);
  const imageMode = normalizedImageMode(task);
  const maximumContentImageCount =
    contentPaidMediaMaximumContentImageCount(task);
  const maximumCoverImageCount = contentPaidMediaMaximumCoverImageCount(task);
  const maximumImageCount = contentPaidMediaMaximumImageCount(task);
  const pricing = contentPaidMediaPricingSnapshot({
    imageModel,
    estimatedUnitCredits,
    pricingVersion,
  });
  const authorizedAt = authorizationInstant(now);
  const expiresAt = new Date(
    new Date(authorizedAt).getTime() + AUTHORIZATION_TTL_MS,
  ).toISOString();
  const taskFingerprint = contentPaidMediaTaskFingerprint(task);
  const authorizationPayload = {
    schemaVersion: CONTENT_PAID_MEDIA_AUTHORIZATION_SCHEMA,
    authorized: true,
    taskFingerprint,
    imageMode,
    allowedProviderKinds: allowedProviderKinds(imageMode),
    maximumContentImageCount,
    maximumCoverImageCount,
    maximumImageCount,
    imageModel: pricing.imageModel,
    pricingVersion: pricing.pricingVersion,
    pricingFingerprint: pricing.pricingFingerprint,
    estimatedUnitCredits: pricing.estimatedUnitCredits,
    estimatedMaximumCredits: pricing.estimatedUnitCredits * maximumImageCount,
    authorizedBy,
    authorizedAt,
    expiresAt,
    externalPublishAllowed: false,
  };
  return Object.freeze({
    ...authorizationPayload,
    authorizationId: fingerprint(authorizationPayload),
  });
}

export function validateContentPaidMediaAuthorization(
  policy,
  {
    task,
    now = () => new Date(),
    actualImageModel,
    actualUnitCredits,
    actualMaximumImageCount,
    actualPricingVersion = CONTENT_PAID_MEDIA_PRICING_VERSION,
  } = {},
) {
  if (!isRecord(policy)) {
    fail(
      "当前任务尚未取得老板的付费媒体provider授权",
      "CONTENT_PAID_MEDIA_AUTHORIZATION_REQUIRED",
      409,
    );
  }
  if (policy.schemaVersion !== CONTENT_PAID_MEDIA_AUTHORIZATION_SCHEMA) {
    fail(
      "付费媒体授权未绑定当前图片模型与计价，需要老板重新授权",
      "CONTENT_PAID_MEDIA_REAUTHORIZATION_REQUIRED",
      409,
    );
  }
  if (policy.authorized !== true || policy.externalPublishAllowed !== false) {
    fail(
      "付费媒体授权已失效",
      "CONTENT_PAID_MEDIA_AUTHORIZATION_REQUIRED",
      409,
    );
  }
  const authorizedBy = normalizedActor(policy.authorizedBy);
  const authorizedAt = authorizationInstant(policy.authorizedAt);
  const expiresAt = authorizationInstant(policy.expiresAt);
  if (
    new Date(expiresAt).getTime() !==
    new Date(authorizedAt).getTime() + AUTHORIZATION_TTL_MS
  ) {
    fail(
      "付费媒体授权有效期不一致",
      "CONTENT_PAID_MEDIA_AUTHORIZATION_TAMPERED",
      409,
    );
  }
  if (
    new Date(authorizationInstant(now)).getTime() >=
    new Date(expiresAt).getTime()
  ) {
    fail(
      "付费媒体授权已过期，需要老板重新确认费用上限",
      "CONTENT_PAID_MEDIA_AUTHORIZATION_EXPIRED",
      409,
    );
  }
  const maximumImageCount = positiveInteger(
    policy.maximumImageCount,
    "授权最大图片数",
  );
  const maximumContentImageCount = positiveInteger(
    policy.maximumContentImageCount,
    "授权正文配图上限",
  );
  const maximumCoverImageCount = positiveInteger(
    policy.maximumCoverImageCount,
    "授权封面图上限",
  );
  if (
    maximumContentImageCount > 12 ||
    maximumCoverImageCount > 4 ||
    maximumImageCount !== maximumContentImageCount + maximumCoverImageCount
  ) {
    fail(
      "付费媒体授权的正文配图、封面与总数上限不一致",
      "CONTENT_PAID_MEDIA_AUTHORIZATION_TAMPERED",
      409,
    );
  }
  const authorizedPricing = contentPaidMediaPricingSnapshot({
    imageModel: policy.imageModel,
    estimatedUnitCredits: policy.estimatedUnitCredits,
    pricingVersion: policy.pricingVersion,
  });
  if (policy.pricingFingerprint !== authorizedPricing.pricingFingerprint) {
    fail(
      "付费媒体授权的计价指纹不匹配",
      "CONTENT_PAID_MEDIA_AUTHORIZATION_TAMPERED",
      409,
    );
  }
  const estimatedUnitCredits = authorizedPricing.estimatedUnitCredits;
  const expectedMaximumCredits = estimatedUnitCredits * maximumImageCount;
  if (Number(policy.estimatedMaximumCredits) !== expectedMaximumCredits) {
    fail("付费媒体授权的预估积分上限不一致", undefined, 400);
  }
  const imageMode = normalizedImageMode(
    task || { image_mode: policy.imageMode },
  );
  const taskFingerprint = task
    ? contentPaidMediaTaskFingerprint(task)
    : cleanText(policy.taskFingerprint, 100);
  if (
    policy.taskFingerprint !== taskFingerprint ||
    policy.imageMode !== imageMode
  ) {
    fail(
      "Brief已变更，旧的付费媒体授权不能继续使用",
      "CONTENT_PAID_MEDIA_AUTHORIZATION_STALE",
      409,
    );
  }
  const expectedKinds = allowedProviderKinds(imageMode);
  if (
    JSON.stringify(policy.allowedProviderKinds) !==
    JSON.stringify(expectedKinds)
  ) {
    fail("付费媒体授权的provider范围不一致", undefined, 400);
  }
  if (task && maximumImageCount < contentPaidMediaMaximumImageCount(task)) {
    fail(
      "付费媒体授权的图片数上限不足",
      "CONTENT_PAID_MEDIA_AUTHORIZATION_LIMIT_EXCEEDED",
      409,
    );
  }
  if (
    task &&
    (maximumContentImageCount !==
      contentPaidMediaMaximumContentImageCount(task) ||
      maximumCoverImageCount !== contentPaidMediaMaximumCoverImageCount(task))
  ) {
    fail(
      "付费媒体授权未完整覆盖当前正文配图与封面上限",
      "CONTENT_PAID_MEDIA_REAUTHORIZATION_REQUIRED",
      409,
    );
  }
  const hasActualPricing =
    actualImageModel !== undefined ||
    actualUnitCredits !== undefined ||
    actualMaximumImageCount !== undefined;
  if (hasActualPricing) {
    if (
      actualImageModel === undefined ||
      actualUnitCredits === undefined ||
      actualMaximumImageCount === undefined
    ) {
      fail(
        "工位5缺少完整的实际图片模型与计价快照",
        "CONTENT_PAID_MEDIA_REAUTHORIZATION_REQUIRED",
        409,
      );
    }
    const actualPricing = contentPaidMediaPricingSnapshot({
      imageModel: actualImageModel,
      estimatedUnitCredits: actualUnitCredits,
      pricingVersion: actualPricingVersion,
    });
    if (
      actualPricing.pricingFingerprint !== authorizedPricing.pricingFingerprint
    ) {
      fail(
        "图片模型或计价已变更，需要老板重新确认付费媒体上限",
        "CONTENT_PAID_MEDIA_REAUTHORIZATION_REQUIRED",
        409,
      );
    }
    const normalizedActualMaximumImageCount = positiveInteger(
      actualMaximumImageCount,
      "实际最大图片数",
    );
    if (normalizedActualMaximumImageCount > maximumImageCount) {
      fail(
        "实际图片数上限超过已授权上限，需要老板重新授权",
        "CONTENT_PAID_MEDIA_AUTHORIZATION_LIMIT_EXCEEDED",
        409,
      );
    }
  }
  const { authorizationId, ...payload } = policy;
  if (authorizationId !== fingerprint(payload)) {
    fail(
      "付费媒体授权指纹不匹配",
      "CONTENT_PAID_MEDIA_AUTHORIZATION_TAMPERED",
      409,
    );
  }
  return Object.freeze({
    ...payload,
    authorizedBy,
    authorizationId,
  });
}

/**
 * 把已签名的付费媒体授权缩成一次provider调用的可原子记账预留。
 * 此对象不代替DB事务；它只提供不可被业务调用方自行扩大的签名上限。
 */
export function contentPaidMediaAuthorizationReservation(
  policy,
  {
    providerKind,
    requestedImageCount,
    requestedCredits,
    now = () => new Date(),
  } = {},
) {
  const validated = validateContentPaidMediaAuthorization(policy, { now });
  const kind = cleanText(providerKind, 20).toLowerCase();
  if (!validated.allowedProviderKinds.includes(kind)) {
    fail(
      `当前付费媒体授权不允许${kind || "未知"} provider`,
      "CONTENT_PAID_MEDIA_AUTHORIZATION_PROVIDER_FORBIDDEN",
      409,
    );
  }
  const imageCount = positiveInteger(requestedImageCount, "本次预留图片数");
  const credits = positiveInteger(requestedCredits, "本次预留积分");
  const maximumImageCount = positiveInteger(
    validated.maximumImageCount,
    "授权累计最大图片数",
  );
  const maximumCredits = positiveInteger(
    validated.estimatedMaximumCredits,
    "授权累计最大积分",
  );
  if (imageCount > maximumImageCount || credits > maximumCredits) {
    fail(
      "本次付费媒体调用已超过老板授权上限",
      "CONTENT_PAID_MEDIA_AUTHORIZATION_LIMIT_EXCEEDED",
      409,
    );
  }
  return Object.freeze({
    schemaVersion: CONTENT_PAID_MEDIA_AUTHORIZATION_USAGE_SCHEMA,
    authorizationId: validated.authorizationId,
    providerKind: kind,
    maximumImageCount,
    maximumCredits,
    requestedImageCount: imageCount,
    requestedCredits: credits,
  });
}

/**
 * 在DB的BEGIN IMMEDIATE内调用：将已结算/已占扣用量与新预留一起校验。
 */
export function assertContentPaidMediaCumulativeBudget(
  reservation,
  { usedImageCount = 0, usedCredits = 0 } = {},
) {
  if (
    !isRecord(reservation) ||
    reservation.schemaVersion !==
      CONTENT_PAID_MEDIA_AUTHORIZATION_USAGE_SCHEMA ||
    !/^sha256:[a-f0-9]{64}$/u.test(cleanText(reservation.authorizationId, 100))
  ) {
    fail(
      "付费媒体累计额度预留不完整",
      "CONTENT_PAID_MEDIA_AUTHORIZATION_USAGE_INVALID",
      409,
    );
  }
  const maximumImageCount = positiveInteger(
    reservation.maximumImageCount,
    "授权累计最大图片数",
  );
  const maximumCredits = positiveInteger(
    reservation.maximumCredits,
    "授权累计最大积分",
  );
  const requestedImageCount = positiveInteger(
    reservation.requestedImageCount,
    "本次预留图片数",
  );
  const requestedCredits = positiveInteger(
    reservation.requestedCredits,
    "本次预留积分",
  );
  const consumedImageCount = nonNegativeInteger(
    usedImageCount,
    "授权已占用图片数",
  );
  const consumedCredits = nonNegativeInteger(usedCredits, "授权已占用积分");
  const nextImageCount = consumedImageCount + requestedImageCount;
  const nextCredits = consumedCredits + requestedCredits;
  if (nextImageCount > maximumImageCount || nextCredits > maximumCredits) {
    fail(
      `同一付费媒体授权的累计剩余额度不足（图片${consumedImageCount}/${maximumImageCount}，积分${consumedCredits}/${maximumCredits}），已拒绝新的provider调用`,
      "CONTENT_PAID_MEDIA_AUTHORIZATION_CUMULATIVE_LIMIT_EXCEEDED",
      409,
    );
  }
  return Object.freeze({
    authorizationId: reservation.authorizationId,
    usedImageCount: consumedImageCount,
    usedCredits: consumedCredits,
    reservedImageCount: requestedImageCount,
    reservedCredits: requestedCredits,
    remainingImageCount: maximumImageCount - nextImageCount,
    remainingCredits: maximumCredits - nextCredits,
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTENT_PAID_MEDIA_AUTHORIZATION_SCHEMA,
  CONTENT_PAID_MEDIA_PRICING_VERSION,
  assertContentPaidMediaCumulativeBudget,
  contentPaidMediaAuthorizationReservation,
  contentPaidMediaMaximumContentImageCount,
  contentPaidMediaMaximumCoverImageCount,
  contentPaidMediaMaximumImageCount,
  createContentPaidMediaAuthorization,
  validateContentPaidMediaAuthorization,
} from "../src/engines/content-paid-media-authorization.js";

const TASK = Object.freeze({
  direction: "太原餐饮老板内容",
  platforms: ["小红书"],
  image_mode: "ai",
  image_count: null,
});

const AUTHORIZED_AT = "2026-08-02T00:00:00.000Z";
const VALIDATION_NOW = "2026-08-02T12:00:00.000Z";

test("自动配图授权覆盖正文4张+单平台封面1张，并且只允许老板类角色", () => {
  assert.equal(contentPaidMediaMaximumContentImageCount(TASK), 4);
  assert.equal(contentPaidMediaMaximumCoverImageCount(TASK), 1);
  assert.equal(contentPaidMediaMaximumImageCount(TASK), 5);
  const policy = createContentPaidMediaAuthorization({
    task: TASK,
    actor: { id: 7, role: "boss", name: "验收老板" },
    imageModel: "gpt-image-2",
    estimatedUnitCredits: 75,
    now: () => new Date(AUTHORIZED_AT),
  });
  assert.equal(policy.maximumContentImageCount, 4);
  assert.equal(policy.maximumCoverImageCount, 1);
  assert.equal(policy.maximumImageCount, 5);
  assert.equal(policy.imageModel, "gpt-image-2");
  assert.equal(policy.pricingVersion, CONTENT_PAID_MEDIA_PRICING_VERSION);
  assert.match(policy.pricingFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(policy.estimatedMaximumCredits, 375);
  assert.deepEqual(policy.allowedProviderKinds, ["image"]);
  assert.deepEqual(
    validateContentPaidMediaAuthorization(policy, {
      task: TASK,
      now: () => new Date(VALIDATION_NOW),
    }),
    policy,
  );

  assert.throws(
    () =>
      createContentPaidMediaAuthorization({
        task: TASK,
        actor: { id: 8, role: "sales" },
        imageModel: "gpt-image-2",
        estimatedUnitCredits: 75,
      }),
    (error) => error.code === "CONTENT_PAID_MEDIA_AUTHORITY_REQUIRED",
  );
});

test("授权与Brief指纹和积分上限绑定，篡改或改图片数后必须重新授权", () => {
  const policy = createContentPaidMediaAuthorization({
    task: { ...TASK, image_count: 2 },
    actor: { id: 7, role: "admin" },
    imageModel: "gpt-image-2",
    estimatedUnitCredits: 75,
    now: () => new Date(AUTHORIZED_AT),
  });
  assert.equal(policy.maximumContentImageCount, 2);
  assert.equal(policy.maximumCoverImageCount, 1);
  assert.equal(policy.maximumImageCount, 3);
  assert.throws(
    () =>
      validateContentPaidMediaAuthorization(policy, {
        task: { ...TASK, image_count: 3 },
        now: () => new Date(VALIDATION_NOW),
      }),
    (error) => error.code === "CONTENT_PAID_MEDIA_AUTHORIZATION_STALE",
  );
  assert.throws(
    () =>
      validateContentPaidMediaAuthorization(
        {
          ...policy,
          estimatedMaximumCredits: 9_999,
        },
        {
          task: { ...TASK, image_count: 2 },
          now: () => new Date(VALIDATION_NOW),
        },
      ),
    /\u9884估积分上限/u,
  );
});

test("未授权时明确fail closed，real/mix精确绑定provider范围", () => {
  assert.throws(
    () => validateContentPaidMediaAuthorization(null, { task: TASK }),
    (error) => error.code === "CONTENT_PAID_MEDIA_AUTHORIZATION_REQUIRED",
  );
  const mix = createContentPaidMediaAuthorization({
    task: { ...TASK, image_mode: "mix", image_count: 3 },
    actor: { id: 7, role: "platform_super" },
    imageModel: "gpt-image-2",
    estimatedUnitCredits: 75,
  });
  assert.deepEqual(mix.allowedProviderKinds, ["image", "material"]);
  assert.equal(
    validateContentPaidMediaAuthorization(mix, {
      task: { ...TASK, image_mode: "mix", image_count: 3 },
    }).authorized,
    true,
  );
});

test("付费媒体授权24小时后失效，过期授权不得继续调用provider", () => {
  const policy = createContentPaidMediaAuthorization({
    task: TASK,
    actor: { id: 7, role: "boss" },
    imageModel: "gpt-image-2",
    estimatedUnitCredits: 75,
    now: () => new Date(AUTHORIZED_AT),
  });
  assert.equal(policy.expiresAt, "2026-08-03T00:00:00.000Z");
  assert.equal(
    validateContentPaidMediaAuthorization(policy, {
      task: TASK,
      now: () => new Date("2026-08-02T23:59:59.999Z"),
    }).authorized,
    true,
  );
  assert.throws(
    () =>
      validateContentPaidMediaAuthorization(policy, {
        task: TASK,
        now: () => new Date("2026-08-03T00:00:00.000Z"),
      }),
    (error) => error.code === "CONTENT_PAID_MEDIA_AUTHORIZATION_EXPIRED",
  );
});

test("工位5/6实际模型、计价和配图+封面总上限必须与授权一致", () => {
  const policy = createContentPaidMediaAuthorization({
    task: { ...TASK, image_count: 4 },
    actor: { id: 7, role: "boss" },
    imageModel: "gpt-image-2",
    estimatedUnitCredits: 75,
  });
  const validateActual = (overrides) =>
    validateContentPaidMediaAuthorization(policy, {
      task: { ...TASK, image_count: 4 },
      actualImageModel: "gpt-image-2",
      actualUnitCredits: 75,
      actualMaximumImageCount: 5,
      ...overrides,
    });
  assert.equal(validateActual({}).authorizationId, policy.authorizationId);
  assert.equal(
    validateActual({ actualMaximumImageCount: 4 }).authorizationId,
    policy.authorizationId,
  );
  for (const overrides of [
    { actualImageModel: "gpt-image-3" },
    { actualUnitCredits: 76 },
    { actualUnitCredits: 74 },
  ]) {
    assert.throws(
      () => validateActual(overrides),
      (error) => error.code === "CONTENT_PAID_MEDIA_REAUTHORIZATION_REQUIRED",
    );
  }
  assert.throws(
    () => validateActual({ actualMaximumImageCount: 6 }),
    (error) => error.code === "CONTENT_PAID_MEDIA_AUTHORIZATION_LIMIT_EXCEEDED",
  );
});

test("旧schema授权没有封面总上限，必须明确重新授权", () => {
  assert.equal(CONTENT_PAID_MEDIA_AUTHORIZATION_SCHEMA.endsWith("/3"), true);
  assert.throws(
    () =>
      validateContentPaidMediaAuthorization(
        {
          schemaVersion: "nanowork.content-paid-media-authorization/2",
          authorized: true,
        },
        { task: TASK },
      ),
    (error) => error.code === "CONTENT_PAID_MEDIA_REAUTHORIZATION_REQUIRED",
  );
});

test("同一授权的累计预留不能超过配图+封面签名上限", () => {
  const policy = createContentPaidMediaAuthorization({
    task: TASK,
    actor: { id: 7, role: "boss" },
    imageModel: "gpt-image-2",
    estimatedUnitCredits: 75,
    now: () => new Date(AUTHORIZED_AT),
  });
  const bodyReservation = contentPaidMediaAuthorizationReservation(policy, {
    providerKind: "image",
    requestedImageCount: 4,
    requestedCredits: 300,
    now: () => new Date(VALIDATION_NOW),
  });
  assert.equal(
    assertContentPaidMediaCumulativeBudget(bodyReservation, {
      usedImageCount: 0,
      usedCredits: 0,
    }).remainingImageCount,
    1,
  );
  const coverReservation = contentPaidMediaAuthorizationReservation(policy, {
    providerKind: "image",
    requestedImageCount: 1,
    requestedCredits: 75,
    now: () => new Date(VALIDATION_NOW),
  });
  assert.equal(
    assertContentPaidMediaCumulativeBudget(coverReservation, {
      usedImageCount: 4,
      usedCredits: 300,
    }).remainingCredits,
    0,
  );
  assert.throws(
    () =>
      assertContentPaidMediaCumulativeBudget(coverReservation, {
        usedImageCount: 5,
        usedCredits: 375,
      }),
    (error) =>
      error.code ===
      "CONTENT_PAID_MEDIA_AUTHORIZATION_CUMULATIVE_LIMIT_EXCEEDED",
  );
});

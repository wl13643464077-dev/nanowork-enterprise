import assert from "node:assert/strict";
import { test } from "node:test";

import {
  providerResponseError,
  sanitizeProviderError,
} from "../src/engines/provider-errors.js";

test("provider错误会安全区分图片提示词超长与尺寸不支持", () => {
  const promptError = providerResponseError(
    400,
    { error: { message: "prompt maximum length is 1000 characters: secret-body" } },
    { service: "图片服务" },
  );
  assert.equal(promptError.providerReason, "prompt_too_long");
  assert.match(promptError.message, /超过上游长度限制/u);
  assert.doesNotMatch(promptError.message, /secret-body/u);

  const sizeError = providerResponseError(
    400,
    { error: { message: "size is invalid; allowed values are 1024x1024" } },
    { service: "图片服务" },
  );
  assert.equal(sizeError.providerReason, "unsupported_size");
  assert.match(sizeError.message, /不支持当前图片尺寸/u);
});

test("已脱敏provider错误再次清洗时保留分类但不恢复上游正文", () => {
  const classified = providerResponseError(
    400,
    { error: { message: "prompt too long; internal request id abc-123" } },
    { service: "图片服务" },
  );
  const sanitized = sanitizeProviderError(classified, { service: "图片服务" });
  assert.equal(sanitized, classified);
  assert.equal(sanitized.providerReason, "prompt_too_long");
  assert.doesNotMatch(sanitized.message, /abc-123/u);
});

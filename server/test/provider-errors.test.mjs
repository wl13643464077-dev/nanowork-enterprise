import assert from "node:assert/strict";
import { test } from "node:test";

import {
  providerResponseError,
  sanitizeProviderError,
} from "../src/engines/provider-errors.js";

test('360模型1001不归因为账号鉴权或用户输入，仍脱敏且禁止自动换模型', () => {
  const error = providerResponseError(400, { error: {
    code: '1001', message: '参数错误:model参数对应模型不存在或未授权 secret-upstream-key',
  } }, { service: '360图片服务' });
  assert.equal(error.providerReason, 'model_unavailable');
  assert.equal(error.providerStatus, 400);
  assert.equal(error.status, 503);
  assert.match(error.message, /尚未向本账号开放/u);
  assert.match(error.message, /已生成的文字保留/u);
  assert.doesNotMatch(error.message, /secret|开通权限|检查.*输入/u);
  assert.equal(providerResponseError(400, { error: { code: '1001', message: '参数错误:size不正确' } }).providerReason, 'invalid_request');
});

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

const SAFE_PROVIDER_ERROR = Symbol('safe-provider-error');

function upstreamText(payload) {
  const values = [
    payload?.error?.message,
    payload?.error_description,
    payload?.base_resp?.status_msg,
    payload?.message,
    payload?.msg,
  ];
  return values.filter(value => typeof value === 'string').join(' ').slice(0, 4000);
}

function providerReason(status, payload) {
  const raw = upstreamText(payload);
  if (status === 401 || status === 403 || /invalid token|unauthori[sz]ed|authentication|鉴权/i.test(raw)) return 'auth';
  if (status === 429 || /rate.?limit|too many requests|quota|insufficient balance|额度不足/i.test(raw)) return 'rate_limit';
  if (/audio duration is invalid/i.test(raw)) return 'audio_duration';
  if (/prompt.{0,80}(?:too long|maximum length|max length|exceed|limit|1000)|(?:too long|maximum length|max length).{0,80}prompt/i.test(raw)) return 'prompt_too_long';
  if (/size.{0,80}(?:unsupported|not support|invalid|must be|allowed)|(?:unsupported|invalid).{0,80}size/i.test(raw)) return 'unsupported_size';
  if (/unsupported model|model.+not.+support|unknown model/i.test(raw)) return 'unsupported_model';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 409 || status === 422) return 'invalid_request';
  return status >= 500 ? 'upstream' : 'network';
}

function publicFailure(reason, service) {
  switch (reason) {
    case 'auth':
      return { status: 502, message: `${service}鉴权失败，请联系管理员检查服务端通道配置` };
    case 'rate_limit':
      return { status: 503, message: `${service}当前繁忙或额度受限，请稍后重试` };
    case 'audio_duration':
      return { status: 400, message: `${service}未接受当前音频时长参数，请调整素材后重试` };
    case 'prompt_too_long':
      return { status: 400, message: `${service}收到的图片描述超过上游长度限制，系统需压缩后重试` };
    case 'unsupported_size':
      return { status: 400, message: `${service}不支持当前图片尺寸，请改用已接入规格` };
    case 'unsupported_model':
      return { status: 400, message: `${service}暂不支持当前模型，请切换已接入模型` };
    case 'not_found':
      return { status: 502, message: `${service}任务接口暂不可用，请联系管理员检查通道配置` };
    case 'invalid_request':
      return { status: 400, message: `${service}未接受当前请求，请检查模型与输入后重试` };
    case 'timeout':
      return { status: 504, message: `${service}响应超时，请稍后重试` };
    default:
      return { status: 502, message: `${service}暂时不可用，请稍后重试` };
  }
}

function safeError(reason, service, providerStatus) {
  const failure = publicFailure(reason, service);
  const error = new Error(failure.message);
  Object.defineProperties(error, {
    status: { value: failure.status, enumerable: true },
    providerReason: { value: reason, enumerable: true },
    providerStatus: {
      value: Number.isInteger(Number(providerStatus)) ? Number(providerStatus) : null,
      enumerable: true,
    },
    [SAFE_PROVIDER_ERROR]: { value: true },
  });
  return error;
}

/**
 * Convert an upstream HTTP response into a user-safe error. The upstream body is
 * inspected only long enough to classify the failure; it is never attached to
 * the Error object, so logging/serializing the error cannot expose provider data.
 */
export function providerResponseError(status, payload, {
  service = '外部服务',
} = {}) {
  return safeError(providerReason(Number(status), payload), service, Number(status));
}

/**
 * Fail closed for transport/runtime errors from an external provider. Unknown
 * messages, causes and stacks are deliberately discarded.
 */
export function sanitizeProviderError(error, {
  service = '外部服务',
} = {}) {
  if (error?.[SAFE_PROVIDER_ERROR]) return error;
  if (error?.name === 'AbortError') return safeError('timeout', service, null);
  return safeError('network', service, Number(error?.status));
}

export function safeProviderErrorMessage(error, options) {
  return sanitizeProviderError(error, options).message;
}

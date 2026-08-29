import { settleHold } from './credits.js';

const safeTokenCount = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};

const safeText = (value, max = 240) => String(value ?? '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const normalizedErrorCode = error => {
  const explicit = safeText(error?.code, 80);
  const explicitUpper = explicit.toUpperCase();
  const nested = safeText(error?.cause?.code, 80).toUpperCase();
  const name = safeText(error?.name, 80).toUpperCase();
  const message = safeText(error?.message, 500).toUpperCase();
  if (
    name === 'ABORTERROR'
    || /TIMEOUT|TIMEDOUT|ETIMEDOUT|UND_ERR_.*TIMEOUT/.test(explicitUpper)
    || /TIMEOUT|TIMEDOUT|ETIMEDOUT|UND_ERR_.*TIMEOUT/.test(nested)
    || /TIMEOUT|超时/.test(message)
  ) return 'AI_PROVIDER_TIMEOUT';
  if (
    /ECONN|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|UND_ERR_CONNECT/.test(explicitUpper)
    || /ECONN|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|UND_ERR_CONNECT/.test(nested)
    || /FETCH FAILED|NETWORK|网络中断|连接失败/.test(message)
  ) return 'AI_PROVIDER_NETWORK_ERROR';
  if (explicit) return explicit;
  if (Number(error?.status) === 402) return 'INSUFFICIENT_CREDITS';
  return 'AI_DELIVERY_FAILED';
};

export function aiEvidence(output) {
  return {
    mode: safeText(output?.mode, 40) || 'unknown',
    model: safeText(output?.model, 120) || null,
    usage: {
      inputTokens: safeTokenCount(output?.usage?.inputTokens),
      outputTokens: safeTokenCount(output?.usage?.outputTokens),
    },
  };
}

export function realAiOutputViolations(output) {
  const evidence = aiEvidence(output);
  const violations = [];
  if (evidence.mode !== 'api') violations.push('mode_not_api');
  if (typeof output?.text !== 'string') violations.push('text_not_string');
  else if (!safeText(output.text, Number.MAX_SAFE_INTEGER)) violations.push('empty_output');
  if (!evidence.model) violations.push('model_missing');
  else if (/^(template|fallback)$/i.test(evidence.model)) violations.push('model_not_real');
  if (evidence.usage.inputTokens + evidence.usage.outputTokens <= 0) violations.push('usage_missing');
  return { evidence, violations };
}

export function assertRealAiOutput(output, {
  label = 'AI任务',
  noDelivery = '本次未保存正式产物',
  retryHint = '请检查云API配置或上游状态后在原任务重试。',
} = {}) {
  const { evidence, violations } = realAiOutputViolations(output);
  if (violations.length) {
    throw Object.assign(new Error(`${label}未取得可验证的真实AI产出，${noDelivery}。${retryHint}`), {
      status: 502,
      code: 'AI_REAL_OUTPUT_REQUIRED',
      retryable: true,
      retryHint,
      aiStatus: 'failed',
      ai: { ...evidence, violations },
    });
  }
  return evidence;
}

export function aiErrorRetryability(error) {
  if (typeof error?.retryable === 'boolean') return error.retryable;
  const status = Number(error?.status || 500);
  if ([400, 401, 402, 403, 404, 409, 413, 422].includes(status)) return false;
  return status === 429 || status === 499 || status >= 500;
}

export function aiRetryHint(error, retryable = aiErrorRetryability(error)) {
  if (error?.retryHint) return safeText(error.retryHint, 300);
  const status = Number(error?.status || 500);
  const code = normalizedErrorCode(error);
  if (status === 402) return '当前积分不足，请充值或由管理员分配额度后重新发起。';
  if (status === 429) return '请按 Retry-After 提示等待后重试，不要连续重复提交。';
  if (status === 499) return '本次请求已取消，需要结果时可在原任务重新发起。';
  if (code === 'AI_PROVIDER_TIMEOUT') return '上游超时且未交付产物，请稍后在原任务重试。';
  if (code === 'AI_PROVIDER_NETWORK_ERROR') return '上游网络连接失败且未交付产物，请检查连接后在原任务重试。';
  if (error?.code === 'AI_OUTPUT_CONTRACT_INVALID') return '模型已返回但格式质检未通过，可在原任务直接重试。';
  if (retryable) return '本次未交付正式产物，请核对上游状态后在原任务重试。';
  return '请先修正输入、权限或额度问题，直接重试不会成功。';
}

export function aiFailurePayload(error, {
  requestId = null,
  extra = {},
} = {}) {
  const retryable = aiErrorRetryability(error);
  const status = Number(error?.status || 500);
  return {
    error: safeText(error?.message, 500) || 'AI任务未完成',
    code: normalizedErrorCode(error),
    aiStatus: 'failed',
    deliveryState: 'failed',
    failurePhase: safeText(error?.deliveryPhase, 40) || (status === 402 ? 'preflight' : 'unknown'),
    retryable,
    retryHint: aiRetryHint(error, retryable),
    ...(requestId ? { requestId } : {}),
    ...(error?.ai ? { ai: error.ai } : {}),
    ...(error?.billing ? { billing: error.billing } : {}),
    ...extra,
  };
}

export function aiFailureReleaseNote(label) {
  return (error, phase) => {
    const code = normalizedErrorCode(error);
    const message = safeText(error?.message, 160) || '未知异常';
    return `${safeText(label, 80) || 'AI任务'}未交付；阶段=${safeText(phase, 30) || 'unknown'}；错误码=${code}；原因=${message}；预授权全额退回`;
  };
}

// 失败流水必须与成功 api 交付区分；积分为 0，但保留错误阶段和错误码供对账。
export function releaseFailedAiHold(hold, note) {
  return settleHold(hold, {
    credits: 0,
    aiMode: 'failed',
    note: safeText(note, 500) || 'AI任务未交付，预授权全额退回',
  });
}

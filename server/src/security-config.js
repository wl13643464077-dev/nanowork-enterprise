const PLACEHOLDER_PATTERN = /(change.?me|replace.?me|example|password|secret|please.?rotate|在此|请填写|占位)/i;

export function jwtSecretStrengthError(value) {
  const secret = String(value || '');
  if (Buffer.byteLength(secret, 'utf8') < 32) return '必须至少 32 字节';
  if (new Set([...secret]).size < 8) return '字符变化不足，请使用强随机串';
  if (PLACEHOLDER_PATTERN.test(secret)) return '不能使用示例或占位值';
  return '';
}

export function platformSuperPasswordStrengthError(value) {
  const password = String(value || '');
  if (password.length < 12) return '必须至少 12 位';
  if (password.length > 128) return '不能超过 128 位';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(password)).length;
  if (classes < 3) return '必须包含大写字母、小写字母、数字、特殊字符中的至少三类';
  if (PLACEHOLDER_PATTERN.test(password)) return '不能使用示例或占位值';
  return '';
}

// Presentation limits describe a preferred result, not whether the paid result exists.
// Keep this allowlist narrow: missing data, invalid structures, fabricated facts and
// authorization failures retain their original blocking semantics.
export function isOutputQualityAdvice(value) {
  const message = typeof value === 'object' && value !== null
    ? String(value.message || '') : String(value || '');
  return [
    /最多允许\d+个字符/u,
    /必须是分段 Markdown/u,
    /是纯文本标签，不得包含 # 或＃/u,
    /字段“(?:title_candidates|tags|versions\[\d+\]\.tags)[^”]*”的各项必须唯一/u,
    /字段“title_candidates”必须(?:恰好包含|包含\d+-\d+项|匹配老板)/u,
    /老板(?:明确)?要求.*标题.*岗位契约仅允许/u,
  ].some(pattern => pattern.test(message));
}

export function outputWarningText(value) {
  return typeof value === 'object' && value !== null
    ? String(value.message || value.label || '') : String(value || '');
}

export function splitOutputQualityIssues(issues = []) {
  const errors = [];
  const warnings = [];
  for (const issue of issues) {
    (isOutputQualityAdvice(issue) ? warnings : errors).push(outputWarningText(issue));
  }
  return { errors, warnings };
}

export function outputQualityReview(warnings = []) {
  const advice = [...new Set(warnings.map(outputWarningText).filter(Boolean))];
  return {
    status: advice.length ? 'needs_user_decision' : 'ready',
    requiresUserDecision: advice.length > 0,
    warnings: advice,
    message: advice.length
      ? '结果已生成并完整保存，可阅读、复制。以下为优化建议，请选择采纳或不采纳；继续优化由你决定。'
      : '结果已生成。',
    autoRetry: false,
  };
}

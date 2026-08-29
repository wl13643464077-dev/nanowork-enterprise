import crypto from 'node:crypto';

import {
  getRestaurantOutputContract,
  restaurantEmployeeHardDeliveryDecision,
  validateRestaurantArithmeticExpressions,
} from './restaurant-output-contract.js';

function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function reportFirstMethodErrors(body, task) {
  const errors = [];
  const employeeIdx = Number(task?.employee_idx ?? task?.employeeIdx);
  let expectedCount = 0;
  try {
    expectedCount = getRestaurantOutputContract(employeeIdx).methodKeys.length;
  } catch {
    errors.push('报告缺少可识别的餐饮岗位编号，无法按当前规则复核方法完整性。');
    return errors;
  }

  const coverageMatches = [...String(body || '').matchAll(
    /方法覆盖[：:]\s*(\d+)\s*\/\s*(\d+)/gu,
  )];
  const coverage = coverageMatches[0];
  if (
    coverageMatches.length !== 1
    || Number(coverage[1]) !== expectedCount
    || Number(coverage[2]) !== expectedCount
  ) {
    errors.push(`报告必须且只能有一处权威方法覆盖声明，并明确覆盖 ${expectedCount}/${expectedCount} 项方法。`);
  }

  const rows = [...String(body || '').matchAll(
    /^\|\s*方法\s*(\d+)\s*\|\s*([^|\n]+)\|\s*([^|\n]*)/gmu,
  )];
  const byIndex = new Map();
  for (const row of rows) {
    const index = Number(row[1]);
    if (byIndex.has(index)) {
      errors.push(`方法 ${index} 出现重复执行记录。`);
    } else {
      byIndex.set(index, row);
    }
  }
  const missing = [];
  for (let index = 1; index <= expectedCount; index += 1) {
    const row = byIndex.get(index);
    if (!row) {
      missing.push(index);
      continue;
    }
    const status = String(row[2] || '').trim();
    const actualExecution = String(row[3] || '').trim();
    if (!/^(?:已完成|部分完成)$/u.test(status)) {
      errors.push(`方法 ${index} 的当前执行状态不是“已完成”或“部分完成”。`);
    }
    if (
      actualExecution.length < 20
      || /(?:待补充|待生成|暂无|占位|TODO|N\/A|本轮(?:输出|响应|结果).*截断|(?:该|本|此)?步骤未(?:执行|放行)|未能执行|重新派活(?:执行)?)/iu.test(actualExecution)
    ) {
      errors.push(`方法 ${index} 缺少可复核的本轮实际执行结果。`);
    }
  }
  if (missing.length) {
    errors.push(`报告缺少方法执行正文：方法 ${missing.join('、')}。`);
  }
  return errors;
}

/**
 * Revalidate persisted structured report-first evidence against the current
 * report body.  The historical snapshot is only a claim: hashes, provider
 * evidence and current deterministic hard gates are recomputed on every read.
 * Legacy pure-Markdown snapshots lack structuredReportFirst and fail closed.
 */
export function inspectStructuredReportFirstEvidence({
  dataMode = 'live',
  content = null,
  task = null,
  executionEvidence = null,
} = {}) {
  const errors = [];
  const body = String(content?.body || '').trim();
  const evidence = object(executionEvidence);
  const audit = object(evidence?.outputContract);
  const provider = object(evidence?.providerAttempt);
  const storedHardDelivery = object(audit?.hardDelivery);
  const hardProvider = object(storedHardDelivery?.provider);
  const leakage = object(evidence?.internalProfileLeakage);
  const artifacts = Array.isArray(audit?.artifacts) ? audit.artifacts : [];
  const primaryArtifact = artifacts.find(
    artifact => artifact?.primary === true && artifact?.kind === 'markdown',
  );

  // 派活模式（paihuo_markdown）：员工按本地派活AI逻辑直接交付Markdown报告，
  // 这是产品主路径而非demo兜底。反造假硬门（真实API、正Token、无泄漏、
  // 哈希一致、来源白名单、算术门）全部保留；契约式的方法覆盖表不适用。
  const paihuoStyle =
    audit?.deliveryStyle === 'paihuo_markdown'
    || audit?.qualityMode === 'paihuo_markdown';

  if (!paihuoStyle && String(dataMode || '').trim().toLowerCase() !== 'demo') {
    errors.push('只有权威租户data_mode=demo才允许报告优先自动采用。');
  }
  if (!body) errors.push('报告正文为空。');
  if (String(content?.ai_mode || '').trim().toLowerCase() !== 'api') {
    errors.push('报告不是来自真实API通道。');
  }
  if (evidence?.kind !== 'restaurant_employee_execution_evidence') {
    errors.push('缺少餐饮数字员工执行证据。');
  }
  if (paihuoStyle) {
    if (
      audit?.valid !== true ||
      audit?.reportFirstMarkdown !== true ||
      audit?.primaryArtifact !== 'markdown' ||
      audit?.parsedOutput != null
    ) {
      errors.push('派活Markdown交付证据不完整或仍声称存在岗位JSON。');
    }
  } else if (
    audit?.valid !== true ||
    audit?.qualityMode !== 'report_first' ||
    audit?.structuredReportFirst !== true ||
    audit?.reportFirstMarkdown !== true ||
    audit?.primaryArtifact !== 'markdown' ||
    audit?.parsedOutput != null
  ) {
    errors.push('结构化报告优先证据不完整或仍声称存在岗位JSON。');
  }
  if (
    storedHardDelivery?.valid !== true ||
    (Array.isArray(storedHardDelivery?.errors) && storedHardDelivery.errors.length)
  ) {
    errors.push('报告没有通过最终交付硬门。');
  }
  if (leakage?.detected !== false) {
    errors.push('报告缺少明确的内部岗位档案无泄漏证据。');
  }

  const providerUsage = object(provider?.usage) || {};
  const hardUsage = object(hardProvider?.usage) || {};
  const providerModel = String(provider?.model || '').trim();
  if (
    String(provider?.mode || '').trim().toLowerCase() !== 'api' ||
    !providerModel ||
    Number(providerUsage.inputTokens) <= 0 ||
    Number(providerUsage.outputTokens) <= 0
  ) {
    errors.push('报告缺少真实API模型与正向Token用量证据。');
  }
  if (
    String(hardProvider?.mode || '').trim().toLowerCase() !== 'api' ||
    String(hardProvider?.model || '').trim() !== providerModel ||
    Number(hardUsage.inputTokens) !== Number(providerUsage.inputTokens) ||
    Number(hardUsage.outputTokens) !== Number(providerUsage.outputTokens) ||
    Number(hardUsage.inputTokens) <= 0 ||
    Number(hardUsage.outputTokens) <= 0
  ) {
    errors.push('最终交付硬门中的provider证据与运行证据不一致。');
  }

  if (body) {
    const bodySha256 = sha256(body);
    if (
      !primaryArtifact ||
      primaryArtifact.contentSha256 !== bodySha256 ||
      audit?.providerResponseSha256 !== bodySha256 ||
      audit?.renderedBodySha256 !== bodySha256
    ) {
      errors.push('报告正文与已验收Markdown制品哈希不一致。');
    }
  }

  const recomputedHardDelivery = restaurantEmployeeHardDeliveryDecision({
    text: body,
    mode: provider?.mode,
    model: providerModel,
    usage: providerUsage,
    internalProfileLeakage: leakage,
    task: {
      title: task?.title,
      type: task?.type,
      requirement: task?.requirement,
    },
    allowedSources: Array.isArray(evidence?.web?.results)
      ? evidence.web.results
      : [],
  });
  if (!recomputedHardDelivery.valid) {
    errors.push(...recomputedHardDelivery.errors);
  }
  for (const arithmeticError of validateRestaurantArithmeticExpressions(body)) {
    errors.push(arithmeticError.message);
  }
  if (!paihuoStyle) errors.push(...reportFirstMethodErrors(body, task));

  const uniqueErrors = [...new Set(errors)];
  return {
    applicable: audit?.qualityMode === 'report_first'
      || audit?.reportFirstMarkdown === true
      || audit?.structuredReportFirst === true,
    valid: uniqueErrors.length === 0,
    errors: uniqueErrors,
    hardDelivery: recomputedHardDelivery,
    audit,
  };
}

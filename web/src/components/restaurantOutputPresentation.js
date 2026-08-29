const REVIEW_STATUS_LABELS = Object.freeze({
  pass: '已通过',
  needs_review: '待复核',
  blocked: '未放行',
  pending_human_review: '待人工审阅',
  compliant: '符合边界',
  routed_by_task_policy: '按任务策略流转',
});

const WORK_ITEM_STATUS_LABELS = Object.freeze({
  verified: '已核验事实',
  assumption: '判断假设（待核验）',
  gap: '证据缺口',
  supplied: '已提供',
  missing: '缺失待补',
  completed: '已完成',
  partial: '部分完成',
  blocked: '执行受阻',
});

const ARTIFACT_TYPE_LABELS = Object.freeze({
  structured_table: '结构化表格',
  decision_card: '决策卡',
  calculation_model: '测算模型',
  execution_plan: '执行方案',
  structured_document: '结构化文档',
  visual_model: '可视化模型',
});

const OVERVIEW_ITEM_LIMIT = 4;

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function plainText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return '';
}

function normalizeMarkdownBreaks(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/br\s*>/giu, '\n');
}

function markdownText(value, fallback = '') {
  const normalized = (plainText(value) || fallback)
    .replace(/\r\n?/gu, '\n')
    .replace(/\s*\n+\s*/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  if (!normalized) return '';
  return normalized
    .replace(/\\/gu, '\\\\')
    .replace(/([`*_\[\]<>])/gu, '\\$1')
    .replace(/^([#>])/u, '\\$1')
    .replace(/^([-+])\s/u, '\\$1 ');
}

function statusLabel(value) {
  const status = plainText(value);
  return REVIEW_STATUS_LABELS[status] || WORK_ITEM_STATUS_LABELS[status] || status || '状态未说明';
}

function artifactTypeLabel(value) {
  const artifactType = plainText(value);
  return ARTIFACT_TYPE_LABELS[artifactType] || artifactType || '岗位交付正文';
}

function unwrapJsonFence(value) {
  const source = plainText(value);
  const match = source.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/iu);
  return match ? match[1].trim() : source;
}

function parsedJson(value) {
  let candidate = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof candidate !== 'string') return candidate;
    const source = unwrapJsonFence(candidate);
    if (!source || !['{', '[', '"'].includes(source[0])) return null;
    try {
      candidate = JSON.parse(source);
    } catch {
      return null;
    }
  }
  return candidate;
}

function restaurantDeliverables(value) {
  const source = record(record(value).deliverables);
  return Object.entries(source)
    .map(([key, raw]) => ({ key, value: record(raw) }))
    .filter(({ value: deliverable }) =>
      Boolean(plainText(deliverable.deliverable_name) || Object.keys(record(deliverable.work_product)).length),
    );
}

function isRestaurantOutput(value) {
  const source = record(value);
  const contractId = plainText(source.contract_id);
  if (contractId.startsWith('urn:nanowork:restaurant-output:')) return true;
  const role = record(source.role);
  const employeeIdx = Number(role.employee_idx);
  const restaurantRole =
    (Number.isInteger(employeeIdx) && employeeIdx >= 101 && employeeIdx <= 161) || Boolean(plainText(role.role_title));
  return (
    restaurantRole &&
    Object.keys(record(source.decision_context)).length > 0 &&
    restaurantDeliverables(source).length > 0
  );
}

function findRestaurantOutput(value) {
  const parsed = parsedJson(value);
  if (!parsed) return null;
  if (isRestaurantOutput(parsed)) return record(parsed);

  const source = record(parsed);
  const contents = record(source.contents);
  for (const candidate of [
    source.parsedOutput,
    source.output,
    source.result,
    source.data,
    source.body,
    source.output_body,
    contents.body,
  ]) {
    if (candidate == null || candidate === parsed) continue;
    const nested = parsedJson(candidate);
    if (nested && isRestaurantOutput(nested)) return record(nested);
  }
  return null;
}

function workProductItems(deliverable) {
  const workProduct = record(deliverable.work_product);
  return list(workProduct.sections).flatMap((rawSection, sectionIndex) => {
    const section = record(rawSection);
    const sectionName = plainText(section.section_name) || `正文分区 ${sectionIndex + 1}`;
    return list(section.items).map((rawItem, itemIndex) => ({
      sectionName,
      itemIndex,
      item: record(rawItem),
    }));
  });
}

function reviewChecks(review) {
  return Object.values(record(record(review).checks)).map(record);
}

function pushIf(lines, value = '') {
  if (value) lines.push(value);
}

function pushReviewChecks(lines, checks) {
  checks.forEach((check, index) => {
    const criterion = markdownText(check.criterion || check.boundary, `检查项 ${index + 1}`);
    const evidence = markdownText(check.evidence || check.handling);
    lines.push(`- **${criterion}** · ${markdownText(statusLabel(check.status || check.result))}`);
    pushIf(lines, evidence ? `  ${evidence}` : '');
  });
}

function markdownUrl(value) {
  const raw = plainText(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.href.replace(/\(/gu, '%28').replace(/\)/gu, '%29');
  } catch {
    return '';
  }
}

function splitSourceReference(value) {
  const raw = plainText(value);
  if (!raw) return { title: '', url: '', note: '' };
  const match = raw.match(/https?:\/\/[^\s<>"'，。；｜|]+/iu);
  if (!match || match.index == null) return { title: raw, url: '', note: '' };
  const rawUrl = match[0].replace(/[)\]】]+$/u, '');
  const url = markdownUrl(rawUrl);
  if (!url) return { title: raw, url: '', note: '' };
  const before = raw
    .slice(0, match.index)
    .replace(/[\s｜|:：·—-]+$/u, '')
    .trim();
  const after = raw
    .slice(match.index + match[0].length)
    .replace(/^[\s｜|:：·—-]+/u, '')
    .trim();
  return { title: before, url, note: after };
}

function sourceMarkdown(rawSource, fallback) {
  const source = record(rawSource);
  const rawName = plainText(source.source || source.title || source.name);
  const embedded = splitSourceReference(rawName);
  const url = markdownUrl(source.url || source.href) || embedded.url || markdownUrl(rawName);
  if (!url) return markdownText(rawName, fallback);
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    host = '';
  }
  const label = embedded.title || (rawName && !markdownUrl(rawName) ? rawName : '') || host || fallback;
  const note = markdownText(embedded.note);
  return `[${markdownText(label, fallback)}](${url})${note ? ` · ${note}` : ''}`;
}

function evidenceRefMarkdown(value) {
  const raw = plainText(value);
  if (!raw) return '';
  const reference = splitSourceReference(raw);
  const url = reference.url || markdownUrl(raw);
  if (!url) return markdownText(raw);
  const label = reference.title || '打开原始证据';
  const note = markdownText(reference.note);
  return `[${markdownText(label)}](${url})${note ? ` · ${note}` : ''}`;
}

// 任务标题只用于老板速览标题；“完整任务”必须优先使用持久化的
// requirement，避免历史任务标题被列表/数据库的短标题截断。保留字符串
// fallback 兼容旧调用方，同时接受 { title, requirement } 或 { task: ... }。
function normalizeTaskContext(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const nested = value.task && typeof value.task === 'object' && !Array.isArray(value.task) ? value.task : value;
    return {
      title: plainText(nested.title || value.taskTitle || value.fallbackTitle),
      requirement: plainText(nested.requirement),
    };
  }
  return { title: plainText(value), requirement: '' };
}

function completeTaskText(context, taskContext) {
  const task = normalizeTaskContext(taskContext);
  return task.requirement || task.title || plainText(context.problem);
}

function reportSubject(context, fallbackTitle = '') {
  const candidates = [context.problem, context.scope, fallbackTitle].map(plainText).filter(Boolean);
  const placeSuffix = '(?:广场|购物中心|商场|商圈|街区|产业园|园区|街|路|门店[A-Za-z0-9一二三四五六七八九十号]*)';
  for (const candidate of candidates) {
    const directed = candidate.match(
      new RegExp(`(?:位于|坐落于|在|围绕|针对)([\\p{Script=Han}A-Za-z0-9·]{2,26}?${placeSuffix})`, 'u'),
    );
    if (directed?.[1]) return directed[1].replace(/^纳米Work验收/u, '');
  }
  for (const candidate of candidates) {
    const place = candidate.match(new RegExp(`([\\p{Script=Han}A-Za-z0-9·]{2,20}?${placeSuffix})`, 'u'));
    if (place?.[1]) {
      return place[1].replace(/^(?:纳米Work验收|请|评估|分析|研究|围绕|针对|关于|目标|本次|项目)+/u, '');
    }
  }
  for (const candidate of candidates) {
    const business = candidate.match(/([\p{Script=Han}A-Za-z0-9·]{2,14}?(?:餐厅|餐馆|门店|项目|品类|品牌))/u);
    if (business?.[1]) return business[1];
  }
  const fallback = candidates[0] || '本次任务';
  return fallback
    .replace(/^(?:请|帮我|需要|本次|完整|评估|分析|研究|围绕|针对|关于)+/u, '')
    .split(/[，。；：:]/u)[0]
    .slice(0, 24);
}

function reportTitle(output, fallbackTitle = '') {
  const roleTitle = plainText(record(output.role).role_title) || '餐饮数字员工';
  const subject = reportSubject(record(output.decision_context), fallbackTitle) || '本次任务';
  return `${markdownText(roleTitle)}｜${markdownText(subject)}`;
}

function limited(values, limit = OVERVIEW_ITEM_LIMIT) {
  return {
    visible: values.slice(0, limit),
    remaining: Math.max(0, values.length - limit),
  };
}

function categorizedOutput(output, deliverables) {
  const context = record(output.decision_context);
  const decisionSources = list(context.sources).map(record);
  const deliverableEvidence = deliverables.flatMap(({ value: deliverable }) =>
    list(deliverable.evidence).map(rawEvidence => ({
      deliverableName: plainText(deliverable.deliverable_name),
      evidence: record(rawEvidence),
    })),
  );
  const items = deliverables.flatMap(({ value: deliverable }) =>
    workProductItems(deliverable).map(({ sectionName, itemIndex, item }) => ({
      deliverableName: plainText(deliverable.deliverable_name),
      sectionName,
      itemIndex,
      item,
    })),
  );
  const businessRisks = items.filter(({ item }) =>
    /风险|隐患|威胁|注意/u.test(`${plainText(item.label)} ${plainText(item.result)}`),
  );
  const businessRiskItems = new Set(businessRisks.map(({ item }) => item));
  const gaps = items.filter(({ item }) => plainText(item.status) === 'gap' && !businessRiskItems.has(item));
  const actions = deliverables.flatMap(({ value: deliverable }) =>
    list(deliverable.actions).map(rawAction => ({
      deliverableName: plainText(deliverable.deliverable_name),
      action: record(rawAction),
    })),
  );
  const references = items
    .map(({ deliverableName, sectionName, item }) => ({
      deliverableName,
      sectionName,
      label: plainText(item.label),
      value: plainText(item.evidence_ref),
    }))
    .filter(reference => reference.value);
  return { context, decisionSources, deliverableEvidence, items, businessRisks, gaps, actions, references };
}

function overviewMarkdown(output, deliverables, taskContext) {
  const role = record(output.role);
  const context = record(output.decision_context);
  const safety = record(output.safety_review);
  const roleTitle = markdownText(role.role_title, '餐饮数字员工');
  const task = normalizeTaskContext(taskContext);
  const title = reportTitle(output, task.title);
  const period = markdownText(context.period);
  const categorized = categorizedOutput(output, deliverables);
  const confidence = plainText(
    record(output.decision_summary).confidence ||
      record(output.decision).confidence ||
      output.confidence ||
      record(output.quality_review).confidence,
  );
  const lines = [`# ${title}`, '', `> ${roleTitle}${period ? ` · ${period}` : ''} · 老板决策版`, ''];

  lines.push('## 决策建议与置信度', '');
  const conclusions = deliverables.map(({ value: deliverable }, index) => {
    const name = markdownText(deliverable.deliverable_name, `交付成果 ${index + 1}`);
    const items = workProductItems(deliverable);
    const representative = items.find(({ item }) => plainText(item.status) === 'verified') || items[0];
    return {
      name,
      label: markdownText(representative?.item?.label),
      result: markdownText(representative?.item?.result || deliverable.summary, '正文中未提供可提炼结论'),
    };
  });
  conclusions.sort((left, right) => {
    const priority = value => (/决策建议|最终建议|结论/u.test(value.name) ? 0 : 1);
    return priority(left) - priority(right);
  });
  const visibleConclusions = limited(conclusions, 3);
  if (!visibleConclusions.visible.length) lines.push('- 本次结果未列出可提炼结论。');
  visibleConclusions.visible.forEach(({ name, label, result }) => {
    lines.push(`- **${name}${label ? ` · ${label}` : ''}**：${result}`);
  });
  lines.push(`- **置信度**：${markdownText(confidence, '未单独量化；以证据状态和缺口披露为准')}`);
  if (visibleConclusions.remaining)
    lines.push(`- 另有 ${visibleConclusions.remaining} 项岗位结论，见下方“岗位完整成果”。`);

  lines.push('', '## 核心证据', '');
  const evidenceRows = [
    ...categorized.decisionSources.map((source, index) => ({
      label: sourceMarkdown(source, `来源 ${index + 1}`),
      period: markdownText(source.period),
      finding: markdownText(source.fact),
    })),
    ...categorized.deliverableEvidence.map(({ deliverableName, evidence }, index) => ({
      label: `${markdownText(deliverableName, '岗位交付成果')} · ${sourceMarkdown(evidence, `来源 ${index + 1}`)}`,
      period: markdownText(evidence.period),
      finding: markdownText(evidence.finding),
    })),
  ];
  const visibleEvidence = limited(evidenceRows);
  if (!visibleEvidence.visible.length) lines.push('- 本次结果未列出可追溯证据。');
  visibleEvidence.visible.forEach(({ label, period: evidencePeriod, finding }) => {
    lines.push(`- **${label}**${evidencePeriod ? `（${evidencePeriod}）` : ''}${finding ? `：${finding}` : ''}`);
  });
  if (visibleEvidence.remaining) lines.push(`- 另有 ${visibleEvidence.remaining} 条来源，完整保留在岗位成果中。`);

  const assumptions = list(context.assumptions).map(record);
  const safetyChecks = reviewChecks(safety);
  const safetyRisks = safetyChecks.filter(check => !['compliant', 'pass'].includes(plainText(check.status)));
  const riskRows = [
    ...assumptions.map((assumption, index) => ({
      label: markdownText(assumption.assumption, `假设 ${index + 1}`),
      result: [
        markdownText(assumption.impact) ? `影响：${markdownText(assumption.impact)}` : '',
        markdownText(assumption.verification) ? `核验：${markdownText(assumption.verification)}` : '',
      ]
        .filter(Boolean)
        .join('；'),
    })),
    ...categorized.businessRisks.map(({ deliverableName, item }) => ({
      label: `${markdownText(deliverableName, '岗位交付成果')} · ${markdownText(item.label, '风险项')}`,
      result: markdownText(item.result, '未说明具体风险'),
    })),
    ...categorized.gaps.map(({ deliverableName, item }) => ({
      label: `${markdownText(deliverableName, '岗位交付成果')} · ${markdownText(item.label, '待补证项')}`,
      result: markdownText(item.result, '未说明具体缺口'),
    })),
    ...safetyRisks.map((check, index) => ({
      label: markdownText(check.boundary || check.criterion, `执行边界 ${index + 1}`),
      result: markdownText(check.handling || check.evidence),
    })),
  ];
  if (plainText(safety.escalation_note)) {
    riskRows.push({ label: '执行边界说明', result: markdownText(safety.escalation_note) });
  }
  const visibleRisks = limited(riskRows);
  lines.push('', '## 主要风险', '');
  if (!visibleRisks.visible.length) lines.push('- 本次结果未列出额外风险或待核验事项。');
  visibleRisks.visible.forEach(({ label, result }) => lines.push(`- **${label}**${result ? `：${result}` : ''}`));
  if (visibleRisks.remaining)
    lines.push(`- 另有 ${visibleRisks.remaining} 项风险或边界记录，见下方完整成果与质量记录。`);

  const visibleActions = limited(categorized.actions);
  lines.push('', '## 下一步', '');
  if (!visibleActions.visible.length) lines.push('- 本次结果未列出后续行动。');
  visibleActions.visible.forEach(({ deliverableName, action }, index) => {
    lines.push(`${index + 1}. **${markdownText(action.action, '执行动作')}**`);
    pushIf(lines, `   - 对应成果：${markdownText(deliverableName, '岗位交付成果')}`);
    pushIf(lines, markdownText(action.owner) ? `   - 负责人：${markdownText(action.owner)}` : '');
    pushIf(lines, markdownText(action.deadline) ? `   - 截止时间：${markdownText(action.deadline)}` : '');
    pushIf(lines, markdownText(action.success_metric) ? `   - 完成标准：${markdownText(action.success_metric)}` : '');
  });
  if (visibleActions.remaining)
    lines.push(`${visibleActions.visible.length + 1}. 另有 ${visibleActions.remaining} 项岗位动作，见下方完整成果。`);

  return lines.join('\n');
}

function inputMethodMarkdown(output, taskContext = '') {
  const inputs = Object.values(record(output.input_audit)).map(record);
  const methods = Object.values(record(output.method_execution)).map(record);
  if (!inputs.length && !methods.length) return '';

  const context = record(output.decision_context);
  const completeTask = completeTaskText(context, taskContext);
  const inputSupplied = inputs.filter(item => plainText(item.status) === 'supplied').length;
  const inputMissing = inputs.filter(item => plainText(item.status) === 'missing').length;
  const methodCompleted = methods.filter(item => plainText(item.status) === 'completed').length;
  const methodBlocked = methods.filter(item => plainText(item.status) === 'blocked').length;
  const lines = [
    '## 输入与方法执行记录',
    '',
    '> 只展示本轮取得的业务结果、缺口和闭环动作；内部配置与技术追溯信息不在这里展示。',
    '',
    `- **输入覆盖：${inputs.length}/${inputs.length}**（已取得 ${inputSupplied}，明确缺失 ${inputMissing}）`,
    `- **方法覆盖：${methods.length}/${methods.length}**（已完成 ${methodCompleted}，受阻 ${methodBlocked}）`,
  ];

  if (completeTask || plainText(context.scope) || plainText(context.period)) {
    lines.push('', '### 本次任务范围', '');
    pushIf(lines, markdownText(completeTask) ? `- **完整任务**：${markdownText(completeTask)}` : '');
    pushIf(lines, markdownText(context.scope) ? `- **业务范围**：${markdownText(context.scope)}` : '');
    pushIf(lines, markdownText(context.period) ? `- **分析期间**：${markdownText(context.period)}` : '');
  }

  if (inputs.length) {
    lines.push('', '### 输入覆盖结果', '');
    inputs.forEach((item, index) => {
      lines.push(`#### 输入 ${index + 1} · ${markdownText(statusLabel(item.status), '状态未说明')}`, '');
      pushIf(lines, markdownText(item.finding) ? `- **业务结果/缺口**：${markdownText(item.finding)}` : '');
      pushIf(lines, markdownText(item.impact) ? `- **对判断的影响**：${markdownText(item.impact)}` : '');
      const verification = record(item.verification);
      const verificationParts = [
        markdownText(verification.owner),
        markdownText(verification.action),
        markdownText(verification.deadline),
      ].filter(Boolean);
      pushIf(lines, verificationParts.length ? `- **闭环安排**：${verificationParts.join(' · ')}` : '');
    });
  }

  if (methods.length) {
    lines.push('', '### 方法执行结果', '');
    methods.forEach((item, index) => {
      lines.push(`#### 方法 ${index + 1} · ${markdownText(statusLabel(item.status), '状态未说明')}`, '');
      pushIf(
        lines,
        markdownText(item.actual_execution) ? `- **本轮业务结果**：${markdownText(item.actual_execution)}` : '',
      );
      pushIf(lines, markdownText(item.missing) ? `- **未完成/限制**：${markdownText(item.missing)}` : '');
      pushIf(lines, markdownText(item.next_action) ? `- **下一步**：${markdownText(item.next_action)}` : '');
    });
  }
  return lines.join('\n');
}

function deliverablesMarkdown(output, deliverables) {
  const lines = [
    '## 交付成果（岗位完整正文）',
    '',
    `以下 ${deliverables.length} 项内容按本岗位的 deliverables 与栏目原样保留，不套用统一报告模板。`,
  ];
  deliverables.forEach(({ value: deliverable }, deliverableIndex) => {
    const name = markdownText(deliverable.deliverable_name, `交付成果 ${deliverableIndex + 1}`);
    const workProduct = record(deliverable.work_product);
    lines.push('', `### ${deliverableIndex + 1}. ${name}`, '');
    pushIf(lines, markdownText(deliverable.summary));
    if (plainText(workProduct.artifact_type)) {
      lines.push('', `**交付形态**：${markdownText(artifactTypeLabel(workProduct.artifact_type))}`);
    }
    const sections = list(workProduct.sections).map(record);
    if (!sections.length) lines.push('', '- 本交付成果未提供岗位正文。');
    sections.forEach((section, sectionIndex) => {
      lines.push('', `#### ${markdownText(section.section_name, `正文分区 ${sectionIndex + 1}`)}`, '');
      const items = list(section.items).map(record);
      if (!items.length) lines.push('- 本分区未提供正文条目。');
      items.forEach((item, itemIndex) => {
        lines.push(
          `- **${markdownText(item.label, `正文条目 ${itemIndex + 1}`)}** · ${markdownText(statusLabel(item.status))}`,
        );
        pushIf(lines, markdownText(item.result) ? `  ${markdownText(item.result)}` : '');
      });
    });

    const evidence = list(deliverable.evidence).map(record);
    if (evidence.length) {
      lines.push('', '#### 来源与事实依据', '');
      evidence.forEach((item, index) => {
        const source = sourceMarkdown(item, `来源 ${index + 1}`);
        const period = markdownText(item.period);
        const finding = markdownText(item.finding);
        lines.push(`- **${source}**${period ? `（${period}）` : ''}${finding ? `：${finding}` : ''}`);
      });
    }

    const actions = list(deliverable.actions).map(record);
    if (actions.length) {
      lines.push('', '#### 岗位行动清单', '');
      actions.forEach((action, index) => {
        lines.push(`${index + 1}. **${markdownText(action.action, '执行动作')}**`);
        pushIf(lines, markdownText(action.owner) ? `   - 负责人：${markdownText(action.owner)}` : '');
        pushIf(lines, markdownText(action.deadline) ? `   - 截止时间：${markdownText(action.deadline)}` : '');
        pushIf(
          lines,
          markdownText(action.success_metric) ? `   - 完成标准：${markdownText(action.success_metric)}` : '',
        );
      });
    }

    const acceptanceChecks = list(deliverable.acceptance_checks).map(record);
    if (acceptanceChecks.length) {
      lines.push('', '#### 验收记录', '');
      pushReviewChecks(lines, acceptanceChecks);
    }
  });
  return lines.join('\n');
}

function governanceMarkdown(output) {
  const quality = record(output.quality_review);
  const safety = record(output.safety_review);
  const approval = record(output.approval);
  const qualityChecks = reviewChecks(quality);
  const safetyChecks = reviewChecks(safety);
  const lines = ['## 质量与授权记录', '', '> 这里保留完整质量、合规和授权边界，默认折叠，不打断老板阅读岗位成果。'];

  if (qualityChecks.length || plainText(quality.overall_status) || plainText(quality.review_note)) {
    lines.push('', `### 质量检查 · ${markdownText(statusLabel(quality.overall_status))}`, '');
    pushIf(lines, markdownText(quality.review_note));
    pushReviewChecks(lines, qualityChecks);
  }
  if (safetyChecks.length || plainText(safety.overall_status) || plainText(safety.escalation_note)) {
    lines.push('', `### 安全与执行边界 · ${markdownText(statusLabel(safety.overall_status))}`, '');
    pushReviewChecks(lines, safetyChecks);
    pushIf(
      lines,
      markdownText(safety.escalation_note) ? `- **升级说明**：${markdownText(safety.escalation_note)}` : '',
    );
  }
  if (Object.keys(approval).length) {
    lines.push('', `### 授权边界 · ${markdownText(statusLabel(approval.status))}`, '');
    const reviewerRoles = list(approval.reviewer_roles)
      .map(item => markdownText(item))
      .filter(Boolean);
    pushIf(lines, reviewerRoles.length ? `- **流转角色**：${reviewerRoles.join('、')}` : '');
    if (typeof approval.external_action_allowed === 'boolean') {
      lines.push(`- **自动对外执行**：${approval.external_action_allowed ? '已允许' : '未允许，需另行授权'}`);
    }
    if (typeof approval.financial_or_regulatory_commitment_allowed === 'boolean') {
      lines.push(
        `- **财务或监管承诺**：${approval.financial_or_regulatory_commitment_allowed ? '已允许' : '未允许，需另行授权'}`,
      );
    }
    pushIf(lines, markdownText(approval.review_note) ? `- **说明**：${markdownText(approval.review_note)}` : '');
    lines.push('', '> 外部动作、真实付费与不可逆操作仍须另行取得老板执行授权。');
  }
  if (lines.length === 3) lines.push('', '- 本次结果没有额外质量或授权记录。');
  return lines.join('\n');
}

function technicalAppendixMarkdown(output, deliverables) {
  const role = record(output.role);
  const categorized = categorizedOutput(output, deliverables);
  const usage = record(output.usage || output.provider_usage);
  const provider = record(output.provider || output.provider_attempt);
  const safeMetadata = [
    ['员工编号', role.employee_idx],
    ['岗位标识', role.role_key],
    ['输出契约', output.contract_id],
    ['供应商', provider.name || provider.provider || output.provider_name],
    ['模型', provider.model || output.model],
    ['输入 Token', usage.inputTokens || usage.input_tokens],
    ['输出 Token', usage.outputTokens || usage.output_tokens],
    ['响应哈希', output.provider_response_sha256 || output.output_sha256 || output.rendered_body_sha256],
  ].filter(([, value]) => plainText(value));
  const lines = [
    '## 技术附录（内部追溯）',
    '',
    '> 契约、运行标识、Token、哈希与证据回指只用于内部追溯，不作为老板正文。',
  ];
  safeMetadata.forEach(([label, value]) => lines.push(`- **${label}**：${markdownText(value)}`));
  if (categorized.references.length) {
    lines.push('', '### 证据回指索引', '');
    categorized.references.forEach((reference, index) => {
      lines.push(
        `${index + 1}. **${markdownText(reference.deliverableName, '岗位交付成果')} · ${markdownText(reference.sectionName)} · ${markdownText(reference.label, '正文条目')}**：${evidenceRefMarkdown(reference.value)}`,
      );
    });
  }
  if (!safeMetadata.length && !categorized.references.length) lines.push('', '- 本次结果没有额外技术追溯字段。');
  return lines.join('\n');
}

function normalizeMarkdown(parts) {
  return `${parts
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()}\n`;
}

/**
 * 派活Markdown报告的老板速览：确定性提取（不再调用模型）——
 * 标题 + 首段结论 + 「下一步建议」清单。与本地派活AI的老板侧信息架构一致：
 * 结论与行动显著在上，完整报告默认折叠。提不出速览时保持整篇直出。
 */
function markdownBossOverview(original) {
  const text = String(original || '').trim();
  if (!text) return null;
  const lines = text.split('\n');
  const titleIndex = lines.findIndex(line => /^#\s+\S/u.test(line.trim()));
  if (titleIndex < 0) return null;
  const title = lines[titleIndex].trim().replace(/^#+\s*/u, '');

  // 标题后的第一段正文（引言/结论摘要），最多取3行。
  const lead = [];
  for (let i = titleIndex + 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t) {
      if (lead.length) break;
      continue;
    }
    if (/^#{1,6}\s/u.test(t) || /^\|/u.test(t) || /^---+$/u.test(t)) break;
    lead.push(t.replace(/^>\s*/u, ''));
    if (lead.length >= 3) break;
  }

  const nextIndex = lines.findIndex(line =>
    /^#{2,6}\s*(?:[\d一二三四五六七八九十.、（）()\s]*)?(?:下一步建议|下一步动作|下一步|行动建议)/u.test(line.trim()),
  );
  const steps = [];
  if (nextIndex >= 0) {
    for (let i = nextIndex + 1; i < lines.length; i += 1) {
      const t = lines[i].trim();
      // 小节在分隔线、代码围栏或“**声明**：”式加粗段落处结束，
      // 别把附注或机读归档块吞进建议清单。
      if (
        /^#{1,6}\s/u.test(t) ||
        /^---+$/u.test(t) ||
        /^```/u.test(t) ||
        /^\*\*[^*]+\*\*[：:]/u.test(t)
      )
        break;
      const item = t.match(/^(?:\d+[.)、]\s*|[-*+]\s+)(.+)$/u);
      if (item) steps.push(item[1].trim());
    }
  }
  if (!steps.length) return null;

  return [
    `# ${title}`,
    '',
    ...(lead.length ? [lead.join('\n'), ''] : []),
    '## 下一步建议',
    '',
    ...steps.slice(0, 6).map((step, index) => `${index + 1}. ${step}`),
  ].join('\n');
}

/**
 * 将结构化餐饮岗位结果拆成“老板速览 / 岗位完整成果 / 质量记录 / 技术附录”四层。
 * 速览只改善阅读顺序；deliverables 里的岗位专属 section 与 item 会完整保留。
 */
export function restaurantOutputPresentation(raw, taskContext = '') {
  const original = typeof raw === 'string' ? raw : '';
  const output = findRestaurantOutput(raw);
  if (!output) {
    // 机读归档块（如巡店 nanowork-inspection JSON）只供系统入档；
    // 老板视图与导出文件里都不展示，原文仍原样留在数据库供审计。
    // 没有归档块时必须逐字节原样返回（含结尾换行）。
    const displayText = normalizeMarkdownBreaks(
      original.includes('```nanowork-inspection')
        ? original.replace(/```nanowork-inspection[\s\S]*?```\s*/gu, '').trimEnd()
        : original,
    );
    const bossOverview = markdownBossOverview(displayText);
    return {
      structured: false,
      markdownReport: Boolean(bossOverview),
      overviewMarkdown: bossOverview || displayText,
      inputMethodMarkdown: '',
      deliverablesMarkdown: bossOverview ? displayText : '',
      governanceMarkdown: '',
      technicalAppendixMarkdown: '',
      fullMarkdown: displayText,
      deliverableCount: 0,
      roleTitle: '',
    };
  }

  const deliverables = restaurantDeliverables(output);
  const normalizedTask = normalizeTaskContext(taskContext);
  const overview = overviewMarkdown(output, deliverables, normalizedTask);
  const inputMethod = inputMethodMarkdown(output, normalizedTask);
  const completeDeliverables = deliverablesMarkdown(output, deliverables);
  const governance = governanceMarkdown(output);
  const technical = technicalAppendixMarkdown(output, deliverables);
  return {
    structured: true,
    markdownReport: false,
    overviewMarkdown: normalizeMarkdown([overview]),
    inputMethodMarkdown: normalizeMarkdown([inputMethod]),
    deliverablesMarkdown: normalizeMarkdown([completeDeliverables]),
    governanceMarkdown: normalizeMarkdown([governance]),
    technicalAppendixMarkdown: normalizeMarkdown([technical]),
    fullMarkdown: normalizeMarkdown([overview, inputMethod, completeDeliverables, governance, technical]),
    deliverableCount: deliverables.length,
    roleTitle: plainText(record(output.role).role_title),
  };
}

/**
 * 兼容既有调用：下载与复制仍拿到完整报告，而不是只拿首屏摘要。
 */
export function restaurantOutputMarkdown(raw, taskContext = '') {
  return restaurantOutputPresentation(raw, taskContext).fullMarkdown;
}

export function isRestaurantStructuredOutput(raw) {
  return Boolean(findRestaurantOutput(raw));
}

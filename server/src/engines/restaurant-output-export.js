const RESTAURANT_OUTPUT_PREFIX = "urn:nanowork:restaurant-output:";

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  return "";
}

function normalizeMarkdownBreaks(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/br\s*>/giu, "\n");
}

function inline(value, fallback = "") {
  return (text(value) || fallback)
    .replace(/\r\n?/gu, "\n")
    .replace(/\s*\n+\s*/gu, " / ")
    .replace(/\|/gu, "｜")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

/**
 * Export callers historically supplied only a fallback title.  Keep that
 * contract backwards compatible while allowing the authoritative task
 * requirement to travel with the report.  The requirement is deliberately
 * kept separate from the short title used in the report heading.
 */
function normalizeTaskContext(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested =
      value.task && typeof value.task === "object" && !Array.isArray(value.task)
        ? value.task
        : value;
    return {
      title: text(nested.title || value.taskTitle || value.fallbackTitle),
      requirement: text(nested.requirement),
    };
  }
  return { title: text(value), requirement: "" };
}

function completeTaskText(context, taskContext) {
  const task = normalizeTaskContext(taskContext);
  // A task requirement is the user-visible source of truth.  Only when it is
  // genuinely absent do we fall back to the task title or the structured
  // output's decision_context.problem (legacy outputs).
  return task.requirement || task.title || text(context.problem);
}

function unwrapJsonFence(value) {
  const source = typeof value === "string" ? value.trim() : "";
  const match = source.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/iu);
  return match ? match[1].trim() : source;
}

function parsedJson(value) {
  let candidate = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (candidate && typeof candidate === "object") return candidate;
    if (typeof candidate !== "string") return null;
    const source = unwrapJsonFence(candidate);
    if (!source || !["{", "[", '"'].includes(source[0])) return null;
    try {
      candidate = JSON.parse(source);
    } catch {
      return null;
    }
  }
  return candidate && typeof candidate === "object" ? candidate : null;
}

function restaurantDeliverables(value) {
  return Object.entries(record(record(value).deliverables))
    .map(([key, raw]) => ({ key, value: record(raw) }))
    .filter(
      ({ value }) =>
        Boolean(text(value.deliverable_name)) ||
        Object.keys(record(value.work_product)).length > 0,
    );
}

function isRestaurantOutput(value) {
  const source = record(value);
  const role = record(source.role);
  const employeeIdx = Number(role.employee_idx);
  const restaurantRole =
    Number.isInteger(employeeIdx) && employeeIdx >= 101 && employeeIdx <= 161;
  const hasReadableContract =
    Object.keys(record(source.decision_context)).length > 0 &&
    restaurantDeliverables(source).length > 0;
  return (
    hasReadableContract &&
    (restaurantRole ||
      text(source.contract_id).startsWith(RESTAURANT_OUTPUT_PREFIX))
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

function statusLabel(value) {
  const raw = text(value);
  const labels = {
    pass: "已通过",
    needs_review: "待复核",
    blocked: "未放行",
    pending_human_review: "待人工审阅",
    compliant: "符合边界",
    routed_by_task_policy: "按任务策略流转",
    verified: "已核验事实",
    assumption: "判断假设（待核验）",
    gap: "证据缺口",
    supplied: "已提供",
    missing: "缺失待补",
    completed: "已完成",
    partial: "部分完成",
  };
  return labels[raw] || raw;
}

function artifactTypeLabel(value) {
  const raw = text(value);
  const labels = {
    structured_table: "结构化表格",
    decision_card: "决策卡",
    calculation_model: "测算模型",
    execution_plan: "执行方案",
    structured_document: "结构化文档",
    visual_model: "可视化模型",
  };
  return labels[raw] || raw;
}

function pushLine(lines, prefix, value) {
  const normalized = inline(value);
  if (normalized) lines.push(`${prefix}${normalized}`);
}

function table(lines, headers, rows) {
  const normalized = rows
    .map((row) => row.map((value) => inline(value)))
    .filter((row) => row.some(Boolean));
  if (!normalized.length) return;
  lines.push(
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...normalized.map((row) => `| ${row.join(" | ")} |`),
  );
}

function reviewRows(review) {
  return Object.values(record(record(review).checks)).map((raw) => {
    const item = record(raw);
    return [
      item.criterion || item.boundary,
      statusLabel(item.status),
      item.evidence || item.handling,
    ];
  });
}

function workProductItems(deliverable) {
  return list(record(deliverable.work_product).sections).flatMap(
    (rawSection, sectionIndex) => {
      const section = record(rawSection);
      const sectionName =
        text(section.section_name) || `正文分区 ${sectionIndex + 1}`;
      return list(section.items).map((rawItem) => ({
        sectionName,
        item: record(rawItem),
      }));
    },
  );
}

function publicUrl(value) {
  const raw = text(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.href.replace(/\(/gu, "%28").replace(/\)/gu, "%29");
  } catch {
    return "";
  }
}

function splitSourceReference(value) {
  const raw = text(value);
  if (!raw) return { title: "", url: "", note: "" };
  const match = raw.match(/https?:\/\/[^\s<>"'，。；｜|]+/iu);
  if (!match || match.index == null)
    return { title: raw, url: "", note: "" };
  const rawUrl = match[0].replace(/[)\]】]+$/u, "");
  const url = publicUrl(rawUrl);
  if (!url) return { title: raw, url: "", note: "" };
  return {
    title: raw
      .slice(0, match.index)
      .replace(/[\s｜|:：·—-]+$/u, "")
      .trim(),
    url,
    note: raw
      .slice(match.index + match[0].length)
      .replace(/^[\s｜|:：·—-]+/u, "")
      .trim(),
  };
}

function sourceValue(raw, fallback = "公开来源") {
  const source = record(raw);
  const name = text(source.source || source.title || source.name);
  const embedded = splitSourceReference(name);
  const url = publicUrl(source.url || source.href) || embedded.url || publicUrl(name);
  if (!url) return inline(name, fallback);
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    host = "";
  }
  const label = embedded.title || (name && !publicUrl(name) ? name : "") || host || fallback;
  return `[${inline(label, fallback)}](${url})${embedded.note ? ` · ${inline(embedded.note)}` : ""}`;
}

function reportSubject(context, fallbackTitle = "") {
  const candidates = [context.problem, context.scope, fallbackTitle]
    .map(text)
    .filter(Boolean);
  const placeSuffix =
    "(?:广场|购物中心|商场|商圈|街区|产业园|园区|街|路|门店[A-Za-z0-9一二三四五六七八九十号]*)";
  for (const candidate of candidates) {
    const directed = candidate.match(
      new RegExp(
        `(?:位于|坐落于|在|围绕|针对)([\\p{Script=Han}A-Za-z0-9·]{2,26}?${placeSuffix})`,
        "u",
      ),
    );
    if (directed?.[1])
      return directed[1].replace(/^纳米Work验收/u, "");
  }
  for (const candidate of candidates) {
    const place = candidate.match(
      new RegExp(`([\\p{Script=Han}A-Za-z0-9·]{2,20}?${placeSuffix})`, "u"),
    );
    if (place?.[1])
      return place[1].replace(
        /^(?:纳米Work验收|请|评估|分析|研究|围绕|针对|关于|目标|本次|项目)+/u,
        "",
      );
  }
  for (const candidate of candidates) {
    const business = candidate.match(
      /([\p{Script=Han}A-Za-z0-9·]{2,14}?(?:餐厅|餐馆|门店|项目|品类|品牌))/u,
    );
    if (business?.[1]) return business[1];
  }
  return (candidates[0] || "本次任务")
    .replace(/^(?:请|帮我|需要|本次|完整|评估|分析|研究|围绕|针对|关于)+/u, "")
    .split(/[，。；：:]/u)[0]
    .slice(0, 24);
}

function reportTitle(source, fallbackTitle = "") {
  const roleTitle = text(record(source.role).role_title) || "餐饮数字员工";
  return `${inline(roleTitle)}｜${inline(reportSubject(record(source.decision_context), fallbackTitle), "本次任务")}`;
}

function categorizedOutput(source, deliverables) {
  const context = record(source.decision_context);
  const decisionSources = list(context.sources).map(record);
  const deliverableEvidence = deliverables.flatMap(({ value: deliverable }) =>
    list(deliverable.evidence).map((rawEvidence) => ({
      deliverableName: text(deliverable.deliverable_name),
      evidence: record(rawEvidence),
    })),
  );
  const items = deliverables.flatMap(({ value: deliverable }) =>
    workProductItems(deliverable).map(({ sectionName, item }) => ({
      deliverableName: text(deliverable.deliverable_name),
      sectionName,
      item,
    })),
  );
  const businessRisks = items.filter(({ item }) =>
    /风险|隐患|威胁|注意/u.test(`${text(item.label)} ${text(item.result)}`),
  );
  const riskItems = new Set(businessRisks.map(({ item }) => item));
  const gaps = items.filter(
    ({ item }) => text(item.status) === "gap" && !riskItems.has(item),
  );
  const actions = deliverables.flatMap(({ value: deliverable }) =>
    list(deliverable.actions).map((rawAction) => ({
      deliverableName: text(deliverable.deliverable_name),
      action: record(rawAction),
    })),
  );
  const references = items
    .map(({ deliverableName, sectionName, item }) => ({
      deliverableName,
      sectionName,
      label: text(item.label),
      value: text(item.evidence_ref),
    }))
    .filter((item) => item.value);
  return {
    context,
    decisionSources,
    deliverableEvidence,
    items,
    businessRisks,
    gaps,
    actions,
    references,
  };
}

function limited(values, limit = 6) {
  return {
    visible: values.slice(0, limit),
    remaining: Math.max(0, values.length - limit),
  };
}

function inputMethodAppendix(source) {
  const inputs = Object.values(record(source.input_audit)).map(record);
  const methods = Object.values(record(source.method_execution)).map(record);
  if (!inputs.length && !methods.length) return [];
  const inputSupplied = inputs.filter(
    (item) => text(item.status) === "supplied",
  ).length;
  const inputMissing = inputs.filter(
    (item) => text(item.status) === "missing",
  ).length;
  const methodCompleted = methods.filter(
    (item) => text(item.status) === "completed",
  ).length;
  const methodBlocked = methods.filter(
    (item) => text(item.status) === "blocked",
  ).length;
  const lines = [
    "## 附录 A · 输入与方法执行记录",
    "",
    "> 只展示本轮业务结果、缺口与闭环动作；不包含内部配置与技术追溯信息。",
    "",
    `- 输入覆盖：${inputs.length}/${inputs.length}（已取得 ${inputSupplied}，明确缺失 ${inputMissing}）`,
    `- 方法覆盖：${methods.length}/${methods.length}（已完成 ${methodCompleted}，受阻 ${methodBlocked}）`,
  ];
  if (inputs.length) {
    lines.push("", "### 输入覆盖结果", "");
    table(
      lines,
      ["序号", "状态", "业务结果/缺口", "对判断的影响", "闭环安排"],
      inputs.map((item, index) => {
        const verification = record(item.verification);
        return [
          `输入 ${index + 1}`,
          statusLabel(item.status),
          item.finding,
          item.impact,
          [verification.owner, verification.action, verification.deadline]
            .map(text)
            .filter(Boolean)
            .join(" · "),
        ];
      }),
    );
  }
  if (methods.length) {
    lines.push("", "### 方法执行结果", "");
    table(
      lines,
      ["序号", "状态", "本轮业务结果", "未完成/限制", "下一步"],
      methods.map((item, index) => [
        `方法 ${index + 1}`,
        statusLabel(item.status),
        item.actual_execution,
        item.missing,
        item.next_action,
      ]),
    );
  }
  return lines;
}

/**
 * 将餐饮岗位的机器结构化输出转成只读、老板可读的 Markdown。
 * 这里只排版已有字段，不执行质检、不补写结论，也不创造来源。
 */
export function renderRestaurantOutputForExport(output, taskContext = "") {
  const source = record(output);
  if (!isRestaurantOutput(source))
    throw new Error("不是可识别的餐饮岗位结构化输出");

  const role = record(source.role);
  const context = record(source.decision_context);
  const quality = record(source.quality_review);
  const safety = record(source.safety_review);
  const approval = record(source.approval);
  const deliverables = restaurantDeliverables(source);
  const categorized = categorizedOutput(source, deliverables);
  const exportTask = normalizeTaskContext(taskContext);
  const title = reportTitle(source, exportTask.title);
  const lines = [`# ${title}`, ""];

  const identity = [
    inline(role.role_title),
    inline(context.period),
    inline(context.scope),
  ].filter(Boolean);
  if (identity.length) lines.push(`> ${identity.join(" · ")}`, "");

  lines.push("## 决策建议与置信度", "");
  const conclusions = deliverables.map(({ value: deliverable }, index) => {
    const items = workProductItems(deliverable);
    const representative =
      items.find(({ item }) => text(item.status) === "verified") || items[0];
    return [
      deliverable.deliverable_name || `交付成果 ${index + 1}`,
      representative?.item?.label,
      representative?.item?.result || deliverable.summary,
    ];
  });
  conclusions.sort((left, right) => {
    const priority = (row) => (/决策建议|最终建议|结论/u.test(text(row[0])) ? 0 : 1);
    return priority(left) - priority(right);
  });
  const visibleConclusions = limited(conclusions, 3);
  table(lines, ["岗位交付", "判断点", "当前结论"], visibleConclusions.visible);
  if (!visibleConclusions.visible.length)
    lines.push("- 本次结果未列出可提炼结论。");
  if (visibleConclusions.remaining) {
    lines.push(
      `- 另有 ${visibleConclusions.remaining} 项岗位结论，见“交付成果（岗位完整正文）”。`,
    );
  }
  const confidence = text(
    record(source.decision_summary).confidence ||
      record(source.decision).confidence ||
      source.confidence ||
      record(source.quality_review).confidence,
  );
  lines.push(
    `- **置信度**：${inline(confidence, "未单独量化；以证据状态和缺口披露为准")}`,
  );

  lines.push("", "## 核心证据", "");
  const evidenceRows = [
    ...categorized.decisionSources.map((item, index) => [
      sourceValue(item, `来源 ${index + 1}`),
      item.period,
      item.fact,
    ]),
    ...categorized.deliverableEvidence.map(
      ({ deliverableName, evidence }, index) => [
        deliverableName,
        sourceValue(evidence, `来源 ${index + 1}`),
        evidence.finding,
      ],
    ),
  ];
  const visibleEvidence = limited(evidenceRows);
  table(
    lines,
    ["来源/对应成果", "期间/来源", "支持事实"],
    visibleEvidence.visible,
  );
  if (!visibleEvidence.visible.length) {
    lines.push("- 本次结果未列出可追溯证据。");
  } else {
    lines.push("- 以上事实保留来源与证据回指，可追溯至本次任务记录。");
  }
  if (visibleEvidence.remaining) {
    lines.push(
      `- 另有 ${visibleEvidence.remaining} 条来源，完整保留在岗位成果中。`,
    );
  }

  const assumptions = list(context.assumptions).map(record);
  const safetyRisks = reviewRows(safety).filter(
    (row) => !["已通过", "符合边界"].includes(row[1]),
  );
  const riskRows = [
    ...assumptions.map((item) => [
      item.assumption,
      item.impact,
      item.verification,
    ]),
    ...categorized.businessRisks.map(({ deliverableName, item }) => [
      `${deliverableName} · ${text(item.label)}`,
      item.result,
      statusLabel(item.status),
    ]),
    ...categorized.gaps.map(({ deliverableName, item }) => [
      `${deliverableName} · ${text(item.label)}`,
      item.result,
      "补齐证据后复核",
    ]),
    ...safetyRisks,
  ];
  if (text(safety.escalation_note)) {
    riskRows.push(["执行边界说明", safety.escalation_note, "按边界处理"]);
  }
  const visibleRisks = limited(riskRows);
  lines.push("", "## 主要风险", "");
  table(lines, ["事项", "影响/说明", "核验或处理"], visibleRisks.visible);
  if (!visibleRisks.visible.length)
    lines.push("- 本次结果未列出额外风险或待核验事项。");
  if (visibleRisks.remaining) {
    lines.push(
      `- 另有 ${visibleRisks.remaining} 项风险或边界记录，见完整成果与质量记录。`,
    );
  }

  const visibleActions = limited(categorized.actions);
  lines.push("", "## 下一步", "");
  table(
    lines,
    ["动作", "对应成果", "负责人", "截止时间", "完成标准"],
    visibleActions.visible.map(({ deliverableName, action }) => [
      action.action,
      deliverableName,
      action.owner,
      action.deadline,
      action.success_metric,
    ]),
  );
  if (!visibleActions.visible.length) lines.push("- 本次结果未列出后续行动。");
  if (visibleActions.remaining) {
    lines.push(`- 另有 ${visibleActions.remaining} 项岗位动作，见完整成果。`);
  }

  lines.push("", "## 任务范围", "");
  table(lines, ["项目", "内容"], [
    ["完整任务", completeTaskText(context, exportTask)],
    ["期间", context.period],
    ["范围", context.scope],
  ]);

  lines.push("", ...inputMethodAppendix(source));

  lines.push(
    "",
    "## 交付成果（岗位完整正文）",
    "",
    `以下 ${deliverables.length} 项内容按本岗位的 deliverables 与栏目完整保留，不套用统一报告模板。`,
    "",
  );
  deliverables.forEach(({ value: deliverable }, deliverableIndex) => {
    const name = inline(
      deliverable.deliverable_name,
      `交付成果 ${deliverableIndex + 1}`,
    );
    const workProduct = record(deliverable.work_product);
    lines.push(`### ${deliverableIndex + 1}. ${name}`, "");
    pushLine(lines, "", deliverable.summary);
    if (text(workProduct.artifact_type)) {
      lines.push(
        "",
        `**交付形态**：${inline(artifactTypeLabel(workProduct.artifact_type))}`,
      );
    }

    for (const [sectionIndex, rawSection] of list(
      workProduct.sections,
    ).entries()) {
      const section = record(rawSection);
      lines.push(
        "",
        `#### ${inline(section.section_name, `正文分区 ${sectionIndex + 1}`)}`,
        "",
      );
      table(
        lines,
        ["岗位条目", "实际正文", "当前状态"],
        list(section.items).map((rawItem) => {
          const item = record(rawItem);
          return [item.label, item.result, statusLabel(item.status)];
        }),
      );
    }

    const evidence = list(deliverable.evidence).map(record);
    if (evidence.length) {
      lines.push("", "#### 来源与事实依据", "");
      table(
        lines,
        ["来源", "期间", "发现"],
        evidence.map((item, index) => [
          sourceValue(item, `来源 ${index + 1}`),
          item.period,
          item.finding,
        ]),
      );
    }

    const actions = list(deliverable.actions).map(record);
    if (actions.length) {
      lines.push("", "#### 执行动作", "");
      table(
        lines,
        ["动作", "负责人", "截止时间", "完成标准"],
        actions.map((item) => [
          item.action,
          item.owner,
          item.deadline,
          item.success_metric,
        ]),
      );
    }

    const acceptance = list(deliverable.acceptance_checks).map(record);
    if (acceptance.length) {
      lines.push("", "#### 验收记录", "");
      table(
        lines,
        ["验收标准", "结果", "证据"],
        acceptance.map((item) => [
          item.criterion,
          statusLabel(item.result),
          item.evidence,
        ]),
      );
    }
  });

  lines.push("", "## 附录 B · 质量与授权记录", "");
  if (Object.keys(quality).length) {
    lines.push(
      `### 质量复核${text(quality.overall_status) ? ` · ${inline(statusLabel(quality.overall_status))}` : ""}`,
      "",
    );
    table(
      lines,
      ["项目", "内容"],
      [
        ["质量状态", statusLabel(quality.overall_status)],
        ["复核说明", quality.review_note],
      ],
    );
    lines.push("");
    table(lines, ["检查项", "状态", "依据"], reviewRows(quality));
  }
  if (Object.keys(safety).length) {
    lines.push(
      "",
      `### 安全边界${text(safety.overall_status) ? ` · ${inline(statusLabel(safety.overall_status))}` : ""}`,
      "",
    );
    table(
      lines,
      ["项目", "内容"],
      [
        ["安全状态", statusLabel(safety.overall_status)],
        ["升级说明", safety.escalation_note],
      ],
    );
    lines.push("");
    table(lines, ["边界", "状态", "处理方式"], reviewRows(safety));
  }
  if (Object.keys(approval).length) {
    lines.push(
      "",
      `### 授权记录${text(approval.status) ? ` · ${inline(statusLabel(approval.status))}` : ""}`,
      "",
    );
    const reviewers = list(approval.reviewer_roles)
      .map((item) => inline(item))
      .filter(Boolean);
    table(
      lines,
      ["项目", "内容"],
      [
        ["流转状态", statusLabel(approval.status)],
        ["流转角色", reviewers.join("、")],
        [
          "外部动作授权字段",
          typeof approval.external_action_allowed === "boolean"
            ? approval.external_action_allowed
              ? "是"
              : "否"
            : "",
        ],
        [
          "财务或监管承诺授权字段",
          typeof approval.financial_or_regulatory_commitment_allowed ===
          "boolean"
            ? approval.financial_or_regulatory_commitment_allowed
              ? "是"
              : "否"
            : "",
        ],
        ["审批说明", approval.review_note],
      ],
    );
    lines.push(
      "",
      "> 外部动作、真实付费与不可逆操作仍须另行取得老板执行授权。",
    );
  }

  lines.push("", "## 附录 C · 来源追溯", "");
  lines.push(
    "> 仅保留老板或业务复核人需要打开的证据回指；内部运行参数不进入可下载报告。",
    "",
  );
  if (categorized.references.length) {
    table(
      lines,
      ["岗位交付", "栏目", "条目", "证据回指"],
      categorized.references.map((item) => [
        item.deliverableName,
        item.sectionName,
        item.label,
        publicUrl(item.value)
          ? `[打开原始证据](${publicUrl(item.value)})`
          : item.value,
      ]),
    );
  }

  return `${lines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()}\n`;
}

export function isRestaurantOutputCandidate(raw) {
  if (findRestaurantOutput(raw)) return true;
  const source = typeof raw === "string" ? raw : "";
  return /"contract_id"\s*:\s*"urn:nanowork:restaurant-output:/u.test(source);
}

/**
 * 无法识别或转换时原样返回。candidate=true 让调用方仍可使用新版哈希，
 * 防止复用旧的 raw JSON 导出文件。
 */
export function prepareRestaurantOutputForExport(raw, taskContext = "") {
  const original = typeof raw === "string" ? raw : String(raw ?? "");
  const output = findRestaurantOutput(original);
  const candidate = Boolean(output) || isRestaurantOutputCandidate(original);
  if (!output) {
    // 机读归档块（巡店 nanowork-inspection JSON）只供系统入档，
    // 老板下载的 Word/PDF 不需要；数据库原文保持不变。
    // 没有归档块的正文必须逐字节原样返回（含结尾换行），
    // transformed 仍专指“契约JSON→报告”转换，剥块不算。
    const body = normalizeMarkdownBreaks(
      original.includes("```nanowork-inspection")
        ? original.replace(/```nanowork-inspection[\s\S]*?```\s*/gu, "").trimEnd()
        : original,
    );
    return { body: body || original, transformed: false, candidate };
  }
  try {
    return {
      body: renderRestaurantOutputForExport(output, taskContext),
      transformed: true,
      candidate: true,
    };
  } catch {
    return { body: original, transformed: false, candidate: true };
  }
}

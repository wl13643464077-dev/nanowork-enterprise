import { createHash } from "node:crypto";

import { loadRestaurantCatalog } from "../catalog/restaurant.js";
import { renderRestaurantOutputForExport } from "./restaurant-output-export.js";
import {
  classifyContractRule,
  normalizeContractTier,
  ruleCategoryIsHard,
} from "./contract-tiers.js";

const SCHEMA_VERSION = "restaurant-role-output/4";
const TASK_POLICY_ROUTED_STATUS = "routed_by_task_policy";
const ASSUMPTION_VERIFICATION_DESCRIPTION = [
  "必须用同一句完整文本同时写明具体岗位责任角色、核验动作（或补证动作）和可核验截止时间。",
  "具体角色例如“商圈研究员”、“运营经理”或“商圈研究岗位负责人”；核验句例如“商圈研究员于2026-08-07 18:00前调取并核对商圈抽样记录”。",
  "禁止使用“项目组”、“团队”、“相关人员”、“有关人员”、“待定”等泛化或占位称谓，不得把角色、动作或截止时间拆到其他字段。",
].join("");
const TOP_LEVEL_KEYS = Object.freeze([
  "contract_id",
  "role",
  "decision_context",
  "input_audit",
  "method_execution",
  "deliverables",
  "quality_review",
  "safety_review",
  "approval",
]);

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const PROVIDER_UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  // Provider-side structured decoding only needs the machine shape.  The
  // complete field semantics are already delivered by the contract
  // instruction in the system/user prompts and are rechecked by our strict
  // validator.  Keeping the repeated prose descriptions in response_format
  // pushed employee 101's v4 schema from 32.6 KB (v3) to 47.5 KB and made the
  // DeepSeek-compatible gateway spend its entire upstream window compiling /
  // decoding the grammar (real task #43: 502, 504, 502 with zero tokens).
  // Removing only annotations keeps every required property, enum, stable
  // input/method/deliverable key and additionalProperties=false constraint.
  "title",
  "description",
  "minLength",
  "minItems",
  "maxItems",
]);

function toProviderSchema(value) {
  if (Array.isArray(value)) return value.map(toProviderSchema);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (PROVIDER_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "const") {
      result.enum = [toProviderSchema(child)];
      continue;
    }
    result[key] = toProviderSchema(child);
  }
  return result;
}

function nonEmptyString({ description, constant, values } = {}) {
  return {
    type: "string",
    minLength: 1,
    ...(description ? { description } : {}),
    ...(constant !== undefined ? { const: constant } : {}),
    ...(values ? { enum: values } : {}),
  };
}

function strictObject(
  properties,
  required = Object.keys(properties),
  extra = {},
) {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
    ...extra,
  };
}

function nonEmptyArray(items, extra = {}) {
  return {
    type: "array",
    minItems: 1,
    items,
    ...extra,
  };
}

function stableFieldKey(prefix, index, source) {
  return `${prefix}_${String(index + 1).padStart(2, "0")}_${sha256(source).slice(0, 10)}`;
}

function namedReviewObject(items, prefix, valueSchemaFactory) {
  const entries = items.map((item, index) => [
    stableFieldKey(prefix, index, item),
    valueSchemaFactory(item),
  ]);
  return {
    keys: entries.map(([key]) => key),
    schema: strictObject(Object.fromEntries(entries)),
  };
}

function inputAuditSchema(inputName) {
  return strictObject({
    input_name: nonEmptyString({
      constant: inputName,
      description: "岗位手册中的必要输入原文；仅用于机器逐项映射，展示层不得泄露内部提示词。",
    }),
    status: nonEmptyString({
      values: ["supplied", "missing", "assumption"],
      description: "supplied表示来源已提供；missing表示明确缺失；assumption表示基于已知事实的待验证假设。",
    }),
    finding: nonEmptyString({
      description: "本项输入实际取得的业务事实、具体缺口或待验证假设，不得复制通用说明。",
    }),
    evidence_refs: nonEmptyArray(
      nonEmptyString({
        description: "逐项回指decision_context.sources中的完整source或规范证据ID。",
      }),
    ),
    impact: nonEmptyString({
      description: "本项输入的充分或缺失会怎样影响本次判断，必须具体到业务结论。",
    }),
    verification: strictObject({
      owner: nonEmptyString({ description: "负责核验本项输入的具体岗位角色。" }),
      action: nonEmptyString({ description: "针对本项输入的具体核验或补证动作。" }),
      deadline: nonEmptyString({ description: "明确可核验的日历时限或工作日时限。" }),
    }),
  });
}

function methodExecutionSchema(stepName) {
  return strictObject({
    step_name: nonEmptyString({
      constant: stepName,
      description: "岗位手册中的方法步骤原文；仅用于机器逐项映射，展示层不得泄露完整内部方法。",
    }),
    status: nonEmptyString({
      values: ["completed", "partial", "blocked"],
      description: "本步骤真实完成状态；不得把未来计划冒充completed。",
    }),
    actual_execution: nonEmptyString({
      description: "本轮实际执行了什么以及形成了什么业务结果，不能只复述步骤或写已完成。",
    }),
    evidence_refs: nonEmptyArray(
      nonEmptyString({
        description: "回指decision_context.sources或本轮交付物证据中的完整source或规范证据ID。",
      }),
    ),
    missing: nonEmptyString({
      description: "未完成部分、限制或无阻断说明；partial/blocked必须写明具体缺失。",
    }),
    next_action: nonEmptyString({
      description: "用于闭环本步骤的下一动作；completed也要写明复核或持续监测动作。",
    }),
  });
}

function workProductSchema(deliverable, requirement) {
  const coverage = requirement.coverageLabels.join("、");
  const quantifiedCoverageRule = (requirement.quantifiedCoverage || [])
    .map(
      ({ label, count }) =>
        `数量型核心维度“${label}”必须按数量拆分为${count}个互异items，label原样保留“${label}”并分别标明第1至第${count}项。`,
    )
    .join("；");
  return strictObject({
    artifact_type: nonEmptyString({
      values: [
        "structured_table",
        "decision_card",
        "calculation_model",
        "execution_plan",
        "structured_document",
        "visual_model",
      ],
      description: `“${deliverable}”的实际制品类型，例如 structured_table、decision_card、calculation_model、execution_plan。`,
    }),
    sections: nonEmptyArray(
      strictObject({
        section_name: nonEmptyString({
          description: `正文分区名称；所有分区合计至少${requirement.minimumItems}个互异正文项。`,
        }),
        items: nonEmptyArray(
          strictObject({
            label: nonEmptyString({
              description: `实际业务条目名称；正文必须逐项覆盖：${coverage}。${quantifiedCoverageRule}`,
            }),
            result: nonEmptyString({
              description:
                "该条目的实际结论、值、关系、阈值或具体缺口；正文必须明确点名并分析本条label对应的业务维度，不能给所有label复制同一段通用营业额或任务复述；status=gap时必须交付含已知基线、缺失字段或样本、判断影响、采集对象与口径的缺口台账；数量型维度证据不足时须逐项交付互异的缺口调研卡，不得补造业务结论；不得只写“已形成一份表/详见附件”。",
            }),
            evidence_ref: nonEmptyString({
              description:
                "回指 decision_context.sources 或本交付物 evidence.source 的完整名称或规范证据ID。",
            }),
            status: nonEmptyString({
              values: ["verified", "assumption", "gap"],
              description:
                "verified仅用于可由明确来源直接支持的已知事实或已完成结果；assumption仅用于写清依据、推导关系与验证边界的假设；gap用于交付具体缺口台账，写明缺失字段或样本、判断影响及采集口径，不得靠改状态伪造完成。",
            }),
          }),
        ),
      }),
    ),
  });
}

function deliverableSchema(deliverable, requirement) {
  return strictObject({
    deliverable_name: nonEmptyString({
      constant: deliverable,
      description: "权威岗位手册中的交付物名称，必须原样保留。",
    }),
    summary: nonEmptyString({
      description: "基于真实输入形成的交付摘要；未知信息必须明确标为待核验。",
    }),
    work_product: workProductSchema(deliverable, requirement),
    evidence: nonEmptyArray(
      strictObject({
        source: nonEmptyString({
          description: "证据、业务材料或系统记录的可追溯来源。",
        }),
        period: nonEmptyString({
          description: "证据对应的统计期、资料有效日期或采集时间。",
        }),
        finding: nonEmptyString({
          description: "只记录该来源能够支持的事实或待核验项。",
        }),
      }),
    ),
    actions: nonEmptyArray(
      strictObject({
        action: nonEmptyString({
          description: `至少14字的具体执行动作，必须使用导出、核验、测算、绘制、编制、提交等明确动词，不得用空泛建议代替；发现材料缺口时，至少一条补证action必须原样包含“${deliverable}”，推荐写法：补齐“${deliverable}”：导出/访谈/采集/核验具体缺失字段。`,
        }),
        owner: nonEmptyString({
          description:
            "至少4字的具体岗位角色，例如“商圈研究岗位负责人”；禁止“负责人、责任人、相关人员、待指定”。",
        }),
        deadline: nonEmptyString({
          description:
            "明确可核验时限，例如“2026-08-07 18:00前”或“1个工作日内”；不得写尽快、后续、待定。",
        }),
        success_metric: nonEmptyString({
          description: `至少12字且原样锚定“${deliverable}”，并包含数量、比例、清单、台账、报告、准确率等可复核完成指标。`,
        }),
      }),
    ),
    acceptance_checks: nonEmptyArray(
      strictObject({
        criterion: nonEmptyString({
          description:
            "该交付物的逐项验收标准；至少一条应能由当前JSON自身检验缺口披露、事实边界或调研计划完整性。",
        }),
        result: nonEmptyString({
          values: ["pass", "needs_review", "blocked", "pending_human_review"],
          description:
            "pass仅用于当前JSON已能证明的criterion；criterion若明确验收缺口披露、事实边界、调研计划完整性，可由当前work_product/evidence/actions自证pass；依赖尚缺业务事实或业务结论的criterion必须保持needs_review/blocked，需人工判断时用pending_human_review。",
        }),
        evidence: nonEmptyString({
          description: "验收结论的证据或待补证据说明。",
        }),
      }),
    ),
  });
}

function qualityCheckSchema(criterion) {
  return strictObject({
    criterion: nonEmptyString({ constant: criterion }),
    status: nonEmptyString({
      values: ["pass", "needs_review", "blocked", "pending_human_review"],
    }),
    evidence: nonEmptyString({ description: "支持质量判断的证据或待补材料。" }),
  });
}

function safetyCheckSchema(boundary) {
  return strictObject({
    boundary: nonEmptyString({ constant: boundary }),
    status: nonEmptyString({
      values: ["compliant", "needs_review", "blocked", "pending_human_review"],
    }),
    handling: nonEmptyString({
      description: "遵守边界的处置动作或人工升级路径。",
    }),
  });
}

const WORK_PRODUCT_ARTIFACT_SUFFIX =
  /(?:数据)?(?:表|图|地图|热表|评分卡|卡|清单|报告|模型|记录|计划|矩阵|台账|方案|说明|草案|模板|日历|字典|手册|决策树|时间线|流程图|框架|摘要|材料|事项)$/u;
const CHINESE_COUNT = Object.freeze({
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
});

function artifactTypeForDeliverable(deliverable) {
  if (/(?:地图|蓝图|龙卷风图|差距图|热图|流程图)/u.test(deliverable))
    return "visual_model";
  if (/(?:评分卡|实验卡|岗位卡|操作卡)/u.test(deliverable))
    return "decision_card";
  if (/(?:模型|测算|公式|损益|现金流)/u.test(deliverable))
    return "calculation_model";
  if (/(?:计划|方案|脚本|SOP|手册|日历)/iu.test(deliverable))
    return "execution_plan";
  if (/(?:表|矩阵|清单|台账|登记册|字典)/u.test(deliverable))
    return "structured_table";
  return "structured_document";
}

function cleanCoverageLabel(value) {
  return String(value || "")
    .trim()
    .replace(/[。.]+$/u, "")
    .replace(WORK_PRODUCT_ARTIFACT_SUFFIX, "")
    .replace(/^(?:里程碑验证|验证里程碑验证)$/u, "验证里程碑")
    .trim();
}

function workProductCoverageLabels(deliverable) {
  let source = String(deliverable || "")
    .replace(/[。.]+$/u, "")
    .replace(/(?:\d+\s*[/／]\s*){2,}\d+\s*天/gu, "验证里程碑");
  const colon = source.split(/[：:]/u);
  if (colon.length > 1 && WORK_PRODUCT_ARTIFACT_SUFFIX.test(colon[0].trim())) {
    source = colon.slice(1).join("、");
  }
  const labels = source
    .split(/(?:[、，,；;：:()（）/／]|(?:与|及|和))/u)
    .map(cleanCoverageLabel)
    .filter((label) => label.length >= 2);
  return [
    ...new Set(
      labels.length
        ? labels
        : [cleanCoverageLabel(deliverable)].filter(Boolean),
    ),
  ];
}

function chineseCount(value) {
  const text = String(value || "");
  if (/^十[一二三四五六七八九]$/u.test(text))
    return 10 + CHINESE_COUNT[text[1]];
  if (/^[一二两三四五六七八九]十$/u.test(text))
    return CHINESE_COUNT[text[0]] * 10;
  return CHINESE_COUNT[text] || Number(text) || 0;
}

function quantifiedCoverageLabels(coverageLabels) {
  return (coverageLabels || []).flatMap((label) => {
    const match = String(label).match(
      /^(\d+|[一二两三四五六七八九十]{1,2})(?:个(?!月|日|天|小时)|项|类|条|张|家|套|份|种)(.+)$/u,
    );
    const count = match ? chineseCount(match[1]) : 0;
    return count >= 2 ? [{ label, count }] : [];
  });
}

function explicitMinimumItems(deliverable) {
  let total = 0;
  // “3个风险”是条目基数；“24个月/1个工作日”是时间单位，不能把正文
  // 最低条目数错误放大到24或1。重量、比例等单位同理不在基数分类词内。
  const cardinal =
    /(?<!第)(\d+|[一二两三四五六七八九十]{1,2})(?=(?:项|个(?!月|日|天|小时|工作日|百分点)|类|级|款|步|阶段|种|条|张|家|套|份|情景|机会|风险))/gu;
  for (const match of String(deliverable || "").matchAll(cardinal))
    total += chineseCount(match[1]);
  const milestone =
    String(deliverable || "").match(/(?:\d+\s*[/／]\s*){2,}\d+\s*天/u)?.[0] ||
    "";
  const milestoneCount = milestone
    ? (milestone.match(/\d+/gu) || []).length
    : 0;
  return Math.max(total, milestoneCount);
}

function specialWorkProductGroups(employeeIdx, deliverable) {
  if (Number(employeeIdx) !== 103 || deliverable !== "风险假设清单及验证实验卡")
    return [];
  return [
    {
      sectionLabel: "风险假设",
      minimumItems: 8,
      requiredLabels: [
        "需求",
        "支付意愿",
        "复购",
        "产能",
        "成本",
        "食安",
        "选址",
        "渠道",
      ],
      requiredResultTerms: [],
    },
    {
      sectionLabel: "验证实验",
      minimumItems: 4,
      requiredLabels: [
        "概念访谈",
        "菜单/落地页测试",
        "小样盲测",
        "限量试卖/快闪",
      ],
      requiredResultTerms: ["通过", "调整", "停止"],
    },
  ];
}

function buildWorkProductRequirement(employee, deliverable) {
  const coverageLabels = workProductCoverageLabels(deliverable);
  const groups = specialWorkProductGroups(employee.idx, deliverable);
  return {
    deliverableName: deliverable,
    coverageLabels,
    quantifiedCoverage: quantifiedCoverageLabels(coverageLabels),
    minimumItems: Math.max(
      2,
      coverageLabels.length,
      explicitMinimumItems(deliverable),
      groups.reduce((total, group) => total + group.minimumItems, 0),
    ),
    groups,
  };
}

function buildWorkProductFixture(
  employee,
  deliverable,
  evidenceSource,
  requirement,
) {
  if (requirement.groups.length) {
    return {
      artifact_type: artifactTypeForDeliverable(deliverable),
      sections: requirement.groups.map((group) => ({
        section_name: `${group.sectionLabel}实际正文`,
        items: group.requiredLabels.map((label, index) => ({
          label,
          result: group.requiredResultTerms.length
            ? `${label}以任务材料记录为依据；通过阈值为完成${index + 1}项行为验证，调整阈值为证据出现分歧，停止阈值为关键约束无法满足。`
            : `${label}被列为第${index + 1}项可证伪假设，依据门店A任务材料记录其影响、证伪条件和当前判断。`,
          evidence_ref: evidenceSource,
          status: group.requiredResultTerms.length ? "assumption" : "verified",
        })),
      })),
    };
  }
  const labels = [...requirement.coverageLabels];
  while (labels.length < requirement.minimumItems)
    labels.push(`${deliverable}正文项${labels.length + 1}`);
  return {
    artifact_type: artifactTypeForDeliverable(deliverable),
    sections: [
      {
        section_name: `${deliverable}实际正文`,
        items: labels.map((label, index) => ({
          label,
          result: `依据门店A本次任务材料，本分区第${index + 1}项记录营业额100000元、订单2000单及对应统计期间，并给出一项可复核的业务判断。`,
          evidence_ref: evidenceSource,
          status: "verified",
        })),
      },
    ],
  };
}

function buildSchemaExample(
  employee,
  {
    contractId,
    inputKeys,
    methodKeys,
    deliverableKeys,
    qualityKeys,
    safetyKeys,
    workProductRequirements,
  },
) {
  return {
    contract_id: contractId,
    role: {
      employee_idx: employee.idx,
      role_key: employee.key,
      role_title: employee.role || employee.name,
    },
    decision_context: {
      problem: `待填写：请${employee.name}解决的单一具体问题`,
      period: "待填写：本次分析或执行所覆盖的期间",
      scope: `待填写：${employee.duty || employee.name}任务的门店、渠道或业务范围`,
      sources: [
        {
          source: "待填写：真实业务材料、系统记录或可追溯外部来源",
          period: "待填写：来源对应期间或资料有效日期",
          fact: "待填写：该来源能够支持的事实，不把假设写成事实",
        },
      ],
      assumptions: [
        {
          assumption: "待填写：当前仍未核验的关键假设",
          impact: "待填写：假设不成立时对结论的影响",
          verification: "待填写：负责人如何、何时完成核验",
        },
      ],
    },
    input_audit: Object.fromEntries(
      employee.inputs.map((inputName, index) => [
        inputKeys[index],
        {
          input_name: inputName,
          status: "missing",
          finding: "待填写：本项输入的具体事实、缺口或待验证假设",
          evidence_refs: ["待填写：本次来源完整名称或规范证据ID"],
          impact: "待填写：本项输入对具体业务判断的影响",
          verification: {
            owner: "待指定：具体岗位责任角色",
            action: "待填写：针对本项输入的核验或补证动作",
            deadline: "待指定：明确截止时间",
          },
        },
      ]),
    ),
    method_execution: Object.fromEntries(
      employee.steps.map((stepName, index) => [
        methodKeys[index],
        {
          step_name: stepName,
          status: "blocked",
          actual_execution: "待填写：本轮对该步骤的实际执行与业务结果",
          evidence_refs: ["待填写：本次来源完整名称或规范证据ID"],
          missing: "待填写：具体未完成部分或无阻断说明",
          next_action: "待填写：用于闭环本步骤的具体下一动作",
        },
      ]),
    ),
    deliverables: Object.fromEntries(
      employee.deliverables.map((deliverable, index) => [
        deliverableKeys[index],
        {
          deliverable_name: deliverable,
          summary: `待填写：基于真实材料完成“${deliverable}”`,
          work_product: {
            // Schema 示例仍须满足枚举形状，运行时由其余占位字段明确拒绝。
            artifact_type: artifactTypeForDeliverable(deliverable),
            sections: [
              {
                section_name: "待填写：正文分区",
                items: [
                  {
                    label: `待填写：覆盖${workProductRequirements[deliverableKeys[index]].coverageLabels.join("、")}`,
                    result:
                      "待填写：实际结论、值、关系、阈值或具体缺口，不能只声明已形成制品",
                    evidence_ref: "待填写：本次来源完整名称或规范证据ID",
                    status: "gap",
                  },
                ],
              },
            ],
          },
          evidence: [
            {
              source: "待填写：支持本交付物的材料或系统记录",
              period: "待填写：证据期间或资料有效日期",
              finding: "待填写：已核验发现；未知部分明确标为待核验",
            },
          ],
          actions: [
            {
              action: `待填写：围绕“${deliverable}”执行的下一步动作`,
              owner: "待指定：有权限的责任人",
              deadline: "待指定：明确截止时间",
              success_metric: "待填写：可复核的完成标准",
            },
          ],
          acceptance_checks: [
            {
              criterion: `核验“${deliverable}”是否覆盖岗位手册要求并有证据支撑`,
              result: "needs_review",
              evidence: "待补充：按任务事实边界补齐证据并重新运行质量门",
            },
          ],
        },
      ]),
    ),
    quality_review: {
      checks: Object.fromEntries(
        employee.qualityGates.map((criterion, index) => [
          qualityKeys[index],
          {
            criterion,
            status: "needs_review",
            evidence: "待补充：按岗位质量门提供可追溯证据",
          },
        ]),
      ),
      overall_status: "needs_review",
      review_note:
        "当前质量证据尚未闭环；补齐证据并重新运行质量门后，内部产出按任务快照策略处理。",
    },
    safety_review: {
      checks: Object.fromEntries(
        employee.safetyBoundaries.map((boundary, index) => [
          safetyKeys[index],
          {
            boundary,
            status: "needs_review",
            handling:
              "待确认：涉及食安、价格、财务、监管、隐私或外部动作时，必须先取得相应执行授权。",
          },
        ]),
      ),
      overall_status: "needs_review",
      escalation_note:
        "机器产出不得替代食品安全、财务、法律、监管或管理层决策。",
    },
    approval: {
      status: TASK_POLICY_ROUTED_STATUS,
      reviewer_roles: ["任务快照策略"],
      external_action_allowed: false,
      financial_or_regulatory_commitment_allowed: false,
      review_note:
        "内部产出通过质量门与账务门后按任务快照策略处理；平台当前默认自动采用。发布、付款、调价、修改生产系统或形成监管承诺必须另行取得执行授权。",
    },
  };
}

function normalizedTask(task = {}) {
  const source = task?.task && typeof task.task === "object" ? task.task : task;
  return {
    title: String(source?.title || "").trim(),
    type: String(source?.type || "").trim(),
    requirement: String(source?.requirement || "").trim(),
    dueAt: String(source?.dueAt || source?.due_at || "").trim(),
  };
}

function fixtureDeadline(task) {
  const dueAt = String(task?.dueAt || "").trim();
  if (!dueAt) return "2026-08-02 18:00前";
  return `${dueAt.replace("T", " ").replace(/Z$/u, "")}前`;
}

function buildDeliverableFixture(employee, contractParts, taskInput = {}) {
  const task = normalizedTask(taskInput);
  const taskTitle = task.title || `${employee.name}门店经营专项核验`;
  const period = "2026-07-01至2026-07-31";
  const scope = `纳米Work验收门店A的${employee.duty || employee.name}业务范围`;
  const deadline = fixtureDeadline(task);
  return {
    contract_id: contractParts.contractId,
    role: {
      employee_idx: employee.idx,
      role_key: employee.key,
      role_title: employee.role || employee.name,
    },
    decision_context: {
      problem: `本次任务“${taskTitle}”需要由${employee.name}核验门店A现状并形成可追溯的结构化结论。`,
      period,
      scope,
      sources: [
        {
          source: "本次任务材料·门店A验收数据表",
          period,
          fact: "材料记录营业额100000元、订单2000单、食材成本35000元、人工成本22000元和顾客投诉12次。",
        },
      ],
      assumptions: [
        {
          assumption: `${employee.deliverables[0]}采用门店A在${period}的统一月结口径。`,
          impact:
            "若后续发现跨期冲销记录，本次月结差异和排序结论需要同步重算。",
          verification: `门店负责人于${deadline}复核业务系统月结锁定记录和跨期冲销台账。`,
        },
      ],
    },
    input_audit: Object.fromEntries(
      employee.inputs.map((inputName, index) => [
        contractParts.inputKeys[index],
        {
          input_name: inputName,
          status: "supplied",
          finding: `本次任务材料已提供第${index + 1}项岗位输入所需的门店A经营口径，已据此限定本轮业务判断范围。`,
          evidence_refs: ["本次任务材料·门店A验收数据表"],
          impact: `该输入用于约束${employee.deliverables[index % employee.deliverables.length]}的第${index + 1}项判断；口径变化时需同步重算相关结论。`,
          verification: {
            owner: `${employee.name}岗位负责人`,
            action: `从业务系统调取并核对第${index + 1}项岗位输入的来源记录、统计期间和适用范围。`,
            deadline,
          },
        },
      ]),
    ),
    method_execution: Object.fromEntries(
      employee.steps.map((stepName, index) => [
        contractParts.methodKeys[index],
        {
          step_name: stepName,
          status: "completed",
          actual_execution: `已按第${index + 1}项岗位方法处理门店A任务材料，并把对应口径、业务判断和复核边界写入${employee.deliverables[index % employee.deliverables.length]}。`,
          evidence_refs: ["本次任务材料·门店A验收数据表"],
          missing: `本步骤当前无阻断，相关口径与结果均已写入交付；后续持续监测第${index + 1}项方法所依赖的跨期变更记录。`,
          next_action: `${employee.name}岗位负责人于${deadline}复核第${index + 1}项方法结果与业务系统月结记录的一致性。`,
        },
      ]),
    ),
    deliverables: Object.fromEntries(
      employee.deliverables.map((deliverable, index) => [
        contractParts.deliverableKeys[index],
        {
          deliverable_name: deliverable,
          summary: `围绕任务“${taskTitle}”完成${deliverable}的门店A核验稿；经营指标、来源期间和复核责任均已写入交付记录。`,
          work_product: buildWorkProductFixture(
            employee,
            deliverable,
            `本次任务材料·${deliverable}核验清单`,
            contractParts.workProductRequirements[
              contractParts.deliverableKeys[index]
            ],
          ),
          evidence: [
            {
              source: `本次任务材料·${deliverable}核验清单`,
              period,
              finding: `门店A在${period}的营业额为100000元、订单为2000单；上述记录已用于${deliverable}的口径核验。`,
            },
          ],
          actions: [
            {
              action: `从业务系统导出门店A的${deliverable}逐笔明细，与任务材料逐项复核并把差异写入台账。`,
              owner: `${employee.name}岗位负责人`,
              deadline,
              success_metric: `形成1份含来源、期间、差异项和复核人的${deliverable}核验记录，未核验项数量归零或逐项升级。`,
            },
          ],
          acceptance_checks: [
            {
              criterion: `核验“${deliverable}”是否覆盖岗位手册要求并有证据支撑`,
              result: "pass",
              evidence: `已核对任务材料来源、统计期间和1项复核动作，${deliverable}满足当前草稿验收标准。`,
            },
          ],
        },
      ]),
    ),
    quality_review: {
      checks: Object.fromEntries(
        employee.qualityGates.map((criterion, index) => [
          contractParts.qualityKeys[index],
          {
            criterion,
            status: "pass",
            evidence: `已按“${criterion}”核对任务材料来源、统计期间、责任角色和复核记录。`,
          },
        ]),
      ),
      overall_status: "pass",
      review_note: `任务“${taskTitle}”已形成结构化核验稿；当前质量门已通过，内部产出按任务快照策略处理。`,
    },
    safety_review: {
      checks: Object.fromEntries(
        employee.safetyBoundaries.map((boundary, index) => [
          contractParts.safetyKeys[index],
          {
            boundary,
            status: "needs_review",
            handling: `涉及“${boundary}”时由门店负责人核对系统记录并取得相应执行授权，当前不执行外部动作。`,
          },
        ]),
      ),
      overall_status: "needs_review",
      escalation_note:
        "涉及食品安全、财务、法律、监管或生产系统变更时，必须提交对应负责人审批并保留系统记录。",
    },
    approval: {
      status: TASK_POLICY_ROUTED_STATUS,
      reviewer_roles: ["任务快照策略"],
      external_action_allowed: false,
      financial_or_regulatory_commitment_allowed: false,
      review_note:
        "内部产出通过质量门与账务门后按任务快照策略处理；发布、付款、调价或修改生产系统须另行取得老板执行授权。",
    },
  };
}

function buildContract(employee) {
  const contractId = `urn:nanowork:restaurant-output:${employee.idx}:${employee.key}:v4`;
  const primaryArtifact = `restaurant-${employee.idx}-${employee.key}-delivery-package`;
  const deliverableKeys = employee.deliverables.map((item, index) =>
    stableFieldKey("deliverable", index, item),
  );
  const inputKeys = employee.inputs.map((item, index) =>
    stableFieldKey("input", index, item),
  );
  const methodKeys = employee.steps.map((item, index) =>
    stableFieldKey("step", index, item),
  );
  const quality = namedReviewObject(
    employee.qualityGates,
    "quality",
    qualityCheckSchema,
  );
  const safety = namedReviewObject(
    employee.safetyBoundaries,
    "safety",
    safetyCheckSchema,
  );
  const workProductRequirements = Object.fromEntries(
    employee.deliverables.map((deliverable, index) => [
      deliverableKeys[index],
      buildWorkProductRequirement(employee, deliverable),
    ]),
  );

  if (new Set(deliverableKeys).size !== deliverableKeys.length) {
    throw new Error(`员工${employee.idx}交付物字段发生稳定键冲突`);
  }

  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: contractId,
    title: `${employee.idx}·${employee.name}机器输出契约`,
    ...strictObject({
      contract_id: nonEmptyString({ constant: contractId }),
      role: strictObject({
        employee_idx: { type: "integer", const: employee.idx },
        role_key: nonEmptyString({ constant: employee.key }),
        role_title: nonEmptyString({
          constant: employee.role || employee.name,
        }),
      }),
      decision_context: strictObject({
        problem: nonEmptyString(),
        period: nonEmptyString(),
        scope: nonEmptyString(),
        sources: nonEmptyArray(
          strictObject({
            source: nonEmptyString(),
            period: nonEmptyString(),
            fact: nonEmptyString(),
          }),
        ),
        assumptions: nonEmptyArray(
          strictObject({
            assumption: nonEmptyString(),
            impact: nonEmptyString(),
            verification: nonEmptyString({
              description: ASSUMPTION_VERIFICATION_DESCRIPTION,
            }),
          }),
        ),
      }),
      input_audit: strictObject(
        Object.fromEntries(
          employee.inputs.map((item, index) => [
            inputKeys[index],
            inputAuditSchema(item),
          ]),
        ),
      ),
      method_execution: strictObject(
        Object.fromEntries(
          employee.steps.map((item, index) => [
            methodKeys[index],
            methodExecutionSchema(item),
          ]),
        ),
      ),
      deliverables: strictObject(
        Object.fromEntries(
          employee.deliverables.map((item, index) => [
            deliverableKeys[index],
            deliverableSchema(
              item,
              workProductRequirements[deliverableKeys[index]],
            ),
          ]),
        ),
      ),
      quality_review: strictObject({
        checks: quality.schema,
        overall_status: nonEmptyString({
          values: ["pass", "needs_review", "blocked", "pending_human_review"],
        }),
        review_note: nonEmptyString(),
      }),
      safety_review: strictObject({
        checks: safety.schema,
        overall_status: nonEmptyString({
          values: [
            "compliant",
            "needs_review",
            "blocked",
            "pending_human_review",
          ],
        }),
        escalation_note: nonEmptyString(),
      }),
      approval: strictObject({
        status: nonEmptyString({ values: [TASK_POLICY_ROUTED_STATUS] }),
        reviewer_roles: nonEmptyArray(nonEmptyString()),
        external_action_allowed: { type: "boolean", const: false },
        financial_or_regulatory_commitment_allowed: {
          type: "boolean",
          const: false,
        },
        review_note: nonEmptyString(),
      }),
    }),
  };
  const contractParts = {
    contractId,
    inputKeys,
    methodKeys,
    deliverableKeys,
    qualityKeys: quality.keys,
    safetyKeys: safety.keys,
    workProductRequirements,
  };
  const schemaExample = buildSchemaExample(employee, contractParts);
  const validFixture = buildDeliverableFixture(employee, contractParts);
  // 云雾与 Claude 的 structured-output 仅接受受限 JSON Schema 子集。
  // 供应商层只负责生成合法形状；非空数组/非空文本等完整业务约束始终由内部 validator 复核。
  const providerSchema = toProviderSchema(schema);

  return deepFreeze({
    contractId,
    schemaVersion: SCHEMA_VERSION,
    employeeIdx: employee.idx,
    employeeKey: employee.key,
    format: "json_object",
    primaryArtifact,
    topLevelKeys: [...TOP_LEVEL_KEYS],
    inputKeys,
    methodKeys,
    deliverableKeys,
    instruction: [
      "只输出一个符合 JSON Schema 的 JSON 对象，不添加 Markdown 围栏或解释文字。",
      "不得遗漏、补造或改名任何字段；未知事实写成明确的待核验说明，不能使用 null、空文本或空数组。",
      "decision_context.problem 必须写出本次任务标题；来源、动作、负责人、时限和验收指标必须具体，禁止照抄待填写示例或用重复条目凑数。",
      "decision_context.assumptions的每个verification都必须在同一句中完整写出具体岗位责任角色、核验动作和截止时间；禁止项目组、团队、相关人员、待定等泛化称谓。",
      `input_audit必须逐项且仅逐项覆盖本岗位全部${employee.inputs.length}项必要输入，稳定字段不得遗漏或改名：`,
      ...employee.inputs.map(
        (input, index) =>
          `${index + 1}. 输入“${input}”：给出supplied/missing/assumption、实际finding、具体impact、来源回指及owner/action/deadline；不得复制同一段泛化说明。`,
      ),
      `method_execution必须逐项且仅逐项覆盖本岗位全部${employee.steps.length}个方法步骤，稳定字段不得遗漏或改名：`,
      ...employee.steps.map(
        (step, index) =>
          `${index + 1}. 方法“${step}”：给出completed/partial/blocked、actual_execution、evidence_refs、missing和next_action；写本轮实际执行，不得只复述方法。`,
      ),
      "每个deliverable.work_product必须直接交付可逐项审阅的完整业务正文；禁止用“已形成一份表、共N项、详见附件、后续补充”代替正文。",
      ...Object.values(workProductRequirements).map((requirement) =>
        [
          `“${requirement.deliverableName}”正文至少${requirement.minimumItems}项，并逐项覆盖${requirement.coverageLabels.join("、")}。`,
          ...(requirement.quantifiedCoverage || []).map(
            ({ label, count }) =>
              `“${label}”必须拆成${count}个互异items；无事实证据时逐项写具体缺口调研卡，不得补造业务结论。`,
          ),
        ].join(""),
      ),
      "work_product状态必须逐项一致：verified只写来源直接支持的事实，assumption写依据和验证边界，gap写缺失字段、判断影响与采集口径。",
      "每个交付物至少一条acceptance可由当前JSON自证；缺口披露、事实边界或调研计划完整性可据实pass，依赖缺失业务事实的标准保持needs_review/blocked。",
      `approval.status固定为${TASK_POLICY_ROUTED_STATUS}：内部产出通过质量门与账务门后按任务快照策略处理，平台当前默认自动采用；外部发布、真实付费、调价、生产系统修改、监管承诺或其他不可逆动作必须另行取得老板执行授权。`,
      "严禁建议伪造或冒用平台ID、账号、身份或商户资料，严禁绕过或规避平台规则；未经平台书面许可与老板执行授权，不得建议在美团、饿了么、大众点评、抖音等外部平台真实上架、上线、开店或投放。需要验证时，只能设计不触发外部发布、真实订单或付费的合规模拟与补证方案。",
    ].join("\n"),
    schema,
    providerSchema,
    schemaExample,
    validFixture,
    inputRequirements: employee.inputs.map((inputName, index) => ({
      key: inputKeys[index],
      inputName,
    })),
    methodRequirements: employee.steps.map((stepName, index) => ({
      key: methodKeys[index],
      stepName,
    })),
    workProductRequirements,
  });
}

const RESTAURANT_EMPLOYEES = new Map(
  loadRestaurantCatalog().employees.map((employee) => [employee.idx, employee]),
);
const RESTAURANT_CONTRACTS = new Map(
  [...RESTAURANT_EMPLOYEES.values()].map((employee) => [
    employee.idx,
    buildContract(employee),
  ]),
);

if (RESTAURANT_CONTRACTS.size !== 61) {
  throw new Error(
    `餐饮输出契约必须覆盖61岗，当前为${RESTAURANT_CONTRACTS.size}岗`,
  );
}

function contractFor(idx) {
  const employeeIdx = Number(idx);
  const contract = RESTAURANT_CONTRACTS.get(employeeIdx);
  if (!contract) {
    throw Object.assign(new Error("餐饮数字员工输出契约编号必须在101-161"), {
      status: 404,
    });
  }
  return contract;
}

export function getRestaurantOutputContract(idx) {
  return structuredClone(contractFor(idx));
}

// 供目录审计与回归测试复用同一套“正文维度/最少条目”推导，禁止脚本和
// 测试各自复制正则后产生与运行时 validator 不一致的第二套口径。
export function deriveRestaurantWorkProductRequirement(
  employeeIdx,
  deliverable,
) {
  return structuredClone(
    buildWorkProductRequirement(
      { idx: Number(employeeIdx) },
      String(deliverable || ""),
    ),
  );
}

export function buildRestaurantOutputDeliverableFixture(idx, taskContext = {}) {
  const contract = contractFor(idx);
  const employee = RESTAURANT_EMPLOYEES.get(Number(idx));
  return buildDeliverableFixture(
    employee,
    {
      contractId: contract.contractId,
      inputKeys: contract.inputKeys,
      methodKeys: contract.methodKeys,
      deliverableKeys: contract.deliverableKeys,
      qualityKeys: Object.keys(
        contract.schema.properties.quality_review.properties.checks.properties,
      ),
      safetyKeys: Object.keys(
        contract.schema.properties.safety_review.properties.checks.properties,
      ),
      workProductRequirements: contract.workProductRequirements,
    },
    taskContext,
  );
}

/**
 * 对供应商已经返回的结构化对象做最小、保守且可审计的事实状态收敛。
 *
 * 这里只做四类可由权威快照或当前 JSON 机械证明的收敛：
 * 1) 正文自己承认未闭环时，verified 只能降级为 gap；
 * 2) 输入 finding 明确承认缺失时，supplied 只能降级为 missing；
 * 3) 来源 URL 与本轮验证快照是同一条时，恢复快照的权威标题与规范 URL，
 *    并把唯一可判定的旧来源、来源标签或 URL 引用同步到该规范来源；
 *    已至少保留一条权威来源时，剔除额外的未核验公共来源并留下审计记录；
 * 4) quality pass 的证据与 criterion 不匹配时降为 needs_review，
 *    并只根据剩余合法 pass 同步 overall_status。
 * 不改业务正文、不补事实、不换 URL，也绝不把 gap/assumption 升级为 verified。
 * 调用方必须把 changes 写入执行证据。
 */
// 只做识别、不做改写：调用方拿它判断“这条回指是否为本次任务自带的材料”。
// 标签必须原样保留在产出里，改写会破坏模型与老板之间的可读对照。
// 允许带“·门店A验收数据表”这类后缀，因为岗位材料本来就按条命名；判定只看
// 开头的材料类前缀，任何带URL的写法都必须回到联网来源核验。
// 刻意不含“任务要求/老板派活”：那是本次要解决的问题本身，不是支撑结论的
// 证据，拿它当evidence_refs必须继续报错（回归用例 demo#47 锁定该行为）。
export function internalEvidenceRefLabel(value) {
  const text = String(value || "")
    .trim()
    .replace(/^[\s\[【［(（]+|[\s\]】］)）。.]+$/gu, "");
  if (!text) return null;
  if (/https?:\/\//iu.test(text)) return null;
  if (/^(?:本次|本轮)?(?:任务)?附件/u.test(text)) return "本次任务附件";
  if (/^(?:企业|内部)?知识库/u.test(text)) return "企业知识库材料";
  if (/^(?:企业|内部|本次|本轮)?(?:任务)?材料/u.test(text))
    return "本次任务材料";
  return null;
}

// 解析“【来源2】/[来源3、5]/来源8-14”等指向本轮联网参考资料编号的引用；
// 编号以提示词【联网参考资料】的[来源N]顺序为准。
function parseNumberedSourceReferences(value) {
  const text = String(value || "");
  const numbers = new Set();
  const consumeBody = (body) => {
    let rest = String(body || "");
    for (const range of rest.matchAll(/(\d+)\s*[-–—~～至]\s*(\d+)/gu)) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (
        Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start > 0 &&
        end >= start &&
        end - start <= 40
      ) {
        for (let n = start; n <= end; n += 1) numbers.add(n);
      }
    }
    rest = rest.replace(/(\d+)\s*[-–—~～至]\s*(\d+)/gu, " ");
    for (const single of rest.matchAll(/\d+/gu)) {
      const n = Number(single[0]);
      if (Number.isSafeInteger(n) && n > 0) numbers.add(n);
    }
  };
  for (const match of text.matchAll(
    /(?:【|\[|［)来源([\d\s、，,/和及\-–—~～至]+)(?:】|\]|］)/gu,
  )) {
    consumeBody(match[1]);
  }
  if (!numbers.size) {
    // 无括号简写（“来源3”“参见来源8-14”）只在短引用文本里识别，
    // 避免把长正文中的叙述数字误当来源编号。
    const bare = [...text.matchAll(/来源([\d\s、，,/和及\-–—~～至]*\d)/gu)];
    if (bare.length && text.trim().length <= 120) {
      for (const match of bare) consumeBody(match[1]);
    }
  }
  return [...numbers];
}

// 以本轮提示词顺序建立 [来源N] → “原始标题｜完整URL” 的确定性映射。
function promptNumberedCanonicalSources(allowedSourcesRaw) {
  const map = new Map();
  if (!Array.isArray(allowedSourcesRaw)) return map;
  allowedSourcesRaw.forEach((item, index) => {
    const url = canonicalRuntimeSourceUrl(item?.url);
    const title = String(item?.title || "").trim();
    if (url && title) map.set(index + 1, `${title}｜${url}`);
  });
  return map;
}

// 只在来源整段没有任何URL时按原始标题恢复。带URL的条目一律走URL核验：
// 标题正确而URL指向站外时必须判未验证，否则“正确标题＋敌手URL”会被恢复成
// 合法来源，等于给伪造来源开后门（见T1215来源回归）。
function titleOnlyMatchedAllowedSources(text, allowedSources) {
  const normalizedText = normalizedAnchor(text);
  if (normalizedText.length < 6) return [];
  const matched = allowedSources.filter((item) => {
    const titleAnchor = normalizedAnchor(item.title);
    return titleAnchor.length >= 6 && normalizedText.includes(titleAnchor);
  });
  // 多条允许来源的标题同时命中时归属不确定，宁可保持未验证也不猜。
  return matched.length === 1 ? matched : [];
}

// 模型抄写超长URL（尤其是percent-encoded查询串）时经常在尾部出错。若损坏URL
// 与唯一一条允许来源同源且共享足够长、占比足够高的前缀，则确定性恢复为该来源；
// 有第二个同长候选时放弃恢复，绝不猜测归属。
// 同源前置条件不可去掉：仅比前缀会把 https://evidence.example.attacker.com/...
// 这类同前缀异站URL认成允许来源。
function rescueAllowedSourceByUrlPrefix(url, allowedSources) {
  const raw = String(url || "");
  if (raw.length < 24) return null;
  const rawOrigin = safeUrlOrigin(raw);
  if (!rawOrigin) return null;
  let best = null;
  let bestLength = 0;
  let ambiguous = false;
  for (const item of allowedSources) {
    if (safeUrlOrigin(item.url) !== rawOrigin) continue;
    const limit = Math.min(raw.length, item.url.length);
    let common = 0;
    while (common < limit && raw[common] === item.url[common]) common += 1;
    if (common < 24 || common < Math.min(raw.length, item.url.length) * 0.8)
      continue;
    if (common > bestLength) {
      best = item;
      bestLength = common;
      ambiguous = false;
    } else if (common === bestLength && best && item.url !== best.url) {
      ambiguous = true;
    }
  }
  return ambiguous ? null : best;
}

function safeUrlOrigin(value) {
  try {
    const parsed = new URL(String(value || ""));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export function canonicalizeRestaurantEmployeeOutputCandidate(
  idx,
  rawOutput,
  taskContext = {},
) {
  contractFor(idx);
  const parsedResult = parseOutput(rawOutput);
  if (!parsedResult.parsed) {
    return {
      changed: false,
      parsed: null,
      text: typeof rawOutput === "string" ? rawOutput : "",
      changes: [],
      parseError: parsedResult.error,
    };
  }
  const parsed = structuredClone(parsedResult.parsed);
  const changes = [];

  const allowedSources = normalizedAllowedWebSources(
    taskContext?.allowedSources,
  );
  // [来源N]编号以本轮提示词【联网参考资料】顺序为准（web.results原始顺序），
  // 不是模型自身decision_context的排序。
  const promptEntriesByNumber = new Map();
  (Array.isArray(taskContext?.allowedSources)
    ? taskContext.allowedSources
    : []
  ).forEach((item, index) => {
    const url = canonicalRuntimeSourceUrl(item?.url);
    const title = String(item?.title || "").trim();
    if (url && title) promptEntriesByNumber.set(index + 1, { title, url });
  });
  const canonicalSourceString = (entry) => `${entry.title}｜${entry.url}`;
  const decisionSources = Array.isArray(parsed.decision_context?.sources)
    ? parsed.decision_context.sources
    : [];
  const verifiedSourceIndexes = new Set();
  const canonicalSourceByUrl = new Map();
  const canonicalSourceByAlias = new Map();
  const canonicalSourcesByDecisionNumber = new Map();
  const sourceMarkerOwners = new Map();
  const sourceMarkers = (value) => [
    ...new Set(
      String(value || "").match(
        /(?:【来源[^】]{1,24}】|\[来源[^\]]{1,24}\]|［来源[^］]{1,24}］)/gu,
      ) || [],
    ),
  ];
  const numberedSourceReferences = parseNumberedSourceReferences;
  const addCanonicalAlias = (alias, canonicalSource) => {
    const normalizedAlias = normalizedAnchor(alias);
    if (!normalizedAlias) return;
    const candidates = canonicalSourceByAlias.get(normalizedAlias) || new Set();
    candidates.add(canonicalSource);
    canonicalSourceByAlias.set(normalizedAlias, candidates);
  };
  for (const source of decisionSources) {
    const sourceName = String(source?.source || "").trim();
    for (const marker of sourceMarkers(sourceName)) {
      const owners = sourceMarkerOwners.get(marker) || new Set();
      owners.add(sourceName);
      sourceMarkerOwners.set(marker, owners);
    }
  }
  const canonicalDecisionSources = [];
  const seenCanonicalSourceKeys = new Set();
  const prunableUnverifiedEntries = [];
  const pushCanonicalDecisionSource = (entry, canonicalSource) => {
    const key = normalizedAnchor(canonicalSource);
    if (seenCanonicalSourceKeys.has(key)) return;
    seenCanonicalSourceKeys.add(key);
    canonicalDecisionSources.push({ ...entry, source: canonicalSource });
  };
  for (const [sourceIndex, source] of decisionSources.entries()) {
    const sourceName = String(source?.source || "").trim();
    const sourceUrls = extractRuntimeSourceUrls(sourceName, allowedSources);
    const uniqueUrls = [...new Set(sourceUrls)];
    const exactMatched = uniqueUrls
      .map((url) => allowedSources.find((item) => item.url === url))
      .filter(Boolean);
    const allExactVerified =
      uniqueUrls.length > 0 && exactMatched.length === uniqueUrls.length;
    let matchedEntries = null;
    let restoreReason = "verified_source_snapshot_restored";
    if (allExactVerified) {
      matchedEntries = exactMatched;
    } else {
      // 逐字URL未全部命中时，仍只用系统自身证据做确定性恢复：
      // 1) 来源文本中的[来源N]编号；2) 允许来源原始标题包含匹配；
      // 3) 模型抄坏的URL与唯一允许来源的长前缀救援。全部失败才保持未验证。
      const referenced = new Map();
      const addReferenced = (entry) => {
        if (entry && !referenced.has(entry.url))
          referenced.set(entry.url, entry);
      };
      for (const entry of exactMatched) addReferenced(entry);
      for (const number of numberedSourceReferences(sourceName)) {
        addReferenced(promptEntriesByNumber.get(number) || null);
      }
      if (!uniqueUrls.length) {
        for (const entry of titleOnlyMatchedAllowedSources(
          sourceName,
          allowedSources,
        )) {
          addReferenced(entry);
        }
      }
      for (const url of uniqueUrls) {
        if (allowedSources.some((item) => item.url === url)) continue;
        addReferenced(rescueAllowedSourceByUrlPrefix(url, allowedSources));
      }
      if (referenced.size) {
        matchedEntries = [...referenced.values()];
        restoreReason = "verified_source_reference_restored";
      }
    }
    if (!matchedEntries) {
      canonicalDecisionSources.push(source);
      if (uniqueUrls.length || PUBLIC_SOURCE_WORD_PATTERN.test(sourceName)) {
        prunableUnverifiedEntries.push({ entry: source, sourceIndex, sourceName });
      }
      continue;
    }
    verifiedSourceIndexes.add(sourceIndex);
    const canonicalSources = matchedEntries.map(canonicalSourceString);
    canonicalSourcesByDecisionNumber.set(sourceIndex + 1, canonicalSources);
    for (const [entryIndex, entry] of matchedEntries.entries()) {
      const canonicalSource = canonicalSources[entryIndex];
      canonicalSourceByUrl.set(entry.url, canonicalSource);
      addCanonicalAlias(canonicalSource, canonicalSource);
      pushCanonicalDecisionSource(source, canonicalSource);
    }
    if (canonicalSources.length === 1) {
      addCanonicalAlias(sourceName, canonicalSources[0]);
      for (const marker of sourceMarkers(sourceName)) {
        if (sourceMarkerOwners.get(marker)?.size === 1)
          addCanonicalAlias(marker, canonicalSources[0]);
      }
    }
    if (
      canonicalSources.length === 1 &&
      sourceName === canonicalSources[0]
    )
      continue;
    changes.push({
      path: `$.decision_context.sources[${sourceIndex}].source`,
      from: sourceName,
      to:
        canonicalSources.length === 1
          ? canonicalSources[0]
          : canonicalSources,
      reason:
        canonicalSources.length === 1
          ? restoreReason
          : restoreReason === "verified_source_snapshot_restored"
            ? "verified_multi_source_snapshot_split"
            : "verified_multi_source_reference_restored",
      verifiedUrls: matchedEntries.map((entry) => entry.url),
    });
  }
  if (isPlainObject(parsed.decision_context))
    parsed.decision_context.sources = canonicalDecisionSources;
  const unverifiedPublicSourceCount = prunableUnverifiedEntries.length;
  if (verifiedSourceIndexes.size && prunableUnverifiedEntries.length) {
    const pruned = new Set(
      prunableUnverifiedEntries.map((item) => item.entry),
    );
    parsed.decision_context.sources = parsed.decision_context.sources.filter(
      (source) => {
        if (!pruned.has(source)) return true;
        const meta = prunableUnverifiedEntries.find(
          (item) => item.entry === source,
        );
        changes.push({
          path: `$.decision_context.sources[${meta.sourceIndex}]`,
          from: meta.sourceName,
          to: null,
          reason: "unverified_source_pruned",
          verifiedSourceCount: verifiedSourceIndexes.size,
        });
        return false;
      },
    );
  }

  const resolveCanonicalEvidenceReference = (reference) => {
    const value = String(reference || "").trim();
    if (!value) return null;
    const numberedReferences = numberedSourceReferences(value);
    if (numberedReferences.length) {
      // [来源N]首先按模型自己声明的decision_context.sources顺序解析——那是
      // 本次输出内部自洽的编号。已声明但未通过核验的编号必须整条丢弃，不能
      // 改用提示词顺序另指一条来源，否则等于替模型猜来源。
      // 只有编号超出decision声明范围（模型直接引用提示词【联网参考资料】编号）
      // 时，才回退到提示词顺序。
      const canonicalSources = [
        ...new Set(
          numberedReferences.flatMap((number) => {
            const declared = canonicalSourcesByDecisionNumber.get(number);
            if (declared?.length) return declared;
            if (number <= decisionSources.length) return [];
            const promptEntry = promptEntriesByNumber.get(number);
            return promptEntry ? [canonicalSourceString(promptEntry)] : [];
          }),
        ),
      ];
      if (canonicalSources.length) {
        return { canonicalSource: canonicalSources.join("；") };
      }
    }
    const urlCandidates = new Set(
      extractRuntimeSourceUrls(value, allowedSources)
        .map((url) => canonicalSourceByUrl.get(url))
        .filter(Boolean),
    );
    if (urlCandidates.size === 1) {
      const canonicalSource = [...urlCandidates][0];
      return {
        canonicalSource,
        verifiedUrl: [...canonicalSourceByUrl.entries()].find(
          ([, source]) => source === canonicalSource,
        )?.[0],
      };
    }
    // 多个已核验 URL 指向不同规范来源时不猜；只有唯一原始来源别名或
    // 唯一【来源N】标签才允许同步，避免把模型复用的标签错误串到别处。
    if (urlCandidates.size > 1) return null;
    const aliasCandidates =
      canonicalSourceByAlias.get(normalizedAnchor(value)) || new Set();
    if (aliasCandidates.size !== 1) return null;
    return { canonicalSource: [...aliasCandidates][0] };
  };
  const restoreEvidenceReference = (reference, path) => {
    const original = String(reference || "").trim();
    const resolved = resolveCanonicalEvidenceReference(original);
    // 内部材料标签（任务要求、附件、知识库、假设、结构键）原样保留：
    // 它们是会话内真实存在的证据锚点，由 evidenceReferenceIsDeclared 直接放行，
    // 不需要也不应该被改写成统一措辞。
    if (!resolved) return original;
    if (original === resolved.canonicalSource) return original;
    changes.push({
      path,
      from: original,
      to: resolved.canonicalSource,
      reason: "verified_source_reference_restored",
      ...(resolved.verifiedUrl ? { verifiedUrl: resolved.verifiedUrl } : {}),
    });
    return resolved.canonicalSource;
  };
  const declaredEvidenceSources = () => [
    ...(parsed.decision_context?.sources || []).map((source) =>
      String(source?.source || "").trim(),
    ),
    ...Object.values(parsed.deliverables || {}).flatMap((deliverable) =>
      (deliverable?.evidence || []).map((evidence) =>
        String(evidence?.source || "").trim(),
      ),
    ),
  ].filter(Boolean);
  const restoreAndFilterEvidenceReferences = (
    references,
    path,
    allowUnresolvedRemoval,
  ) => {
    const restored = references.map((reference, refIndex) => ({
      original: String(reference || "").trim(),
      value: restoreEvidenceReference(
        reference,
        `${path}[${refIndex}]`,
      ),
      refIndex,
    }));
    const declaredSources = declaredEvidenceSources();
    const kept = [];
    const removed = [];
    for (const reference of restored) {
      if (
        !allowUnresolvedRemoval ||
        evidenceReferenceIsDeclared(reference.value, declaredSources) ||
        !/(?:来源|https?:\/\/)/iu.test(reference.value)
      ) {
        kept.push(reference.value);
        continue;
      }
      removed.push(reference);
    }
    for (const reference of removed) {
      changes.push({
        path: `${path}[${reference.refIndex}]`,
        from: reference.value,
        to: null,
        reason: "unresolved_evidence_reference_removed",
      });
    }
    return [...new Set(kept)];
  };
  for (const [inputKey, input] of Object.entries(parsed.input_audit || {})) {
    if (Array.isArray(input?.evidence_refs)) {
      input.evidence_refs = restoreAndFilterEvidenceReferences(
        input.evidence_refs,
        `$.input_audit.${inputKey}.evidence_refs`,
        verifiedSourceIndexes.size > 0 && unverifiedPublicSourceCount > 0,
      );
    }
    if (input?.status !== "supplied") continue;
    const contradictions = reviewPassContradictions(
      String(input?.finding || ""),
    );
    if (!contradictions.length) continue;
    input.status = "missing";
    changes.push({
      path: `$.input_audit.${inputKey}.status`,
      from: "supplied",
      to: "missing",
      reason: "supplied_input_explicitly_unresolved",
      contradictions,
    });
  }
  for (const [methodKey, method] of Object.entries(
    parsed.method_execution || {},
  )) {
    if (!Array.isArray(method?.evidence_refs)) continue;
    method.evidence_refs = restoreAndFilterEvidenceReferences(
      method.evidence_refs,
      `$.method_execution.${methodKey}.evidence_refs`,
      verifiedSourceIndexes.size > 0 && unverifiedPublicSourceCount > 0,
    );
  }

  for (const [deliverableKey, deliverable] of Object.entries(
    parsed.deliverables || {},
  )) {
    for (const [sectionIndex, section] of (
      deliverable?.work_product?.sections || []
    ).entries()) {
      for (const [itemIndex, item] of (section?.items || []).entries()) {
        if (typeof item?.evidence_ref === "string") {
          item.evidence_ref = restoreEvidenceReference(
            item.evidence_ref,
            `$.deliverables.${deliverableKey}.work_product.sections[${sectionIndex}].items[${itemIndex}].evidence_ref`,
          );
        }
        if (
          verifiedSourceIndexes.size > 0 &&
          unverifiedPublicSourceCount > 0 &&
          item?.status === "verified" &&
          !evidenceReferenceIsDeclared(
            item?.evidence_ref,
            [
              ...(parsed.decision_context?.sources || []).map((source) =>
                String(source?.source || "").trim(),
              ),
              ...(deliverable?.evidence || []).map((evidence) =>
                String(evidence?.source || "").trim(),
              ),
            ].filter(Boolean),
          )
        ) {
          item.status = "gap";
          changes.push({
            path: `$.deliverables.${deliverableKey}.work_product.sections[${sectionIndex}].items[${itemIndex}].status`,
            from: "verified",
            to: "gap",
            reason: "unresolved_evidence_reference_downgraded",
            evidenceRef: String(item?.evidence_ref || "").trim(),
          });
        }
        if (item?.status !== "verified") continue;
        const contradictions = reviewPassContradictions(
          String(item?.result || ""),
        );
        if (!contradictions.length) continue;
        item.status = "gap";
        changes.push({
          path: `$.deliverables.${deliverableKey}.work_product.sections[${sectionIndex}].items[${itemIndex}].status`,
          from: "verified",
          to: "gap",
          reason: "result_explicitly_unresolved",
          contradictions,
        });
      }
    }
  }

  const qualityChecks = isPlainObject(parsed.quality_review?.checks)
    ? parsed.quality_review.checks
    : {};
  for (const [qualityKey, check] of Object.entries(qualityChecks)) {
    if (check?.status !== "pass") continue;
    const criterion = String(check?.criterion || "").trim();
    const evidence = String(check?.evidence || "").trim();
    const contradictions = reviewPassContradictions(evidence, criterion);
    const anchored = evidenceAnchorsCriterion(evidence, criterion);
    if (!contradictions.length && anchored) continue;
    check.status = "needs_review";
    changes.push({
      path: `$.quality_review.checks.${qualityKey}.status`,
      from: "pass",
      to: "needs_review",
      reason: contradictions.length
        ? "quality_evidence_explicitly_unresolved"
        : "quality_evidence_not_business_anchored",
      ...(contradictions.length ? { contradictions } : {}),
    });
  }
  if (isPlainObject(parsed.quality_review)) {
    const hasValidPass = Object.values(qualityChecks).some(
      (check) => check?.status === "pass",
    );
    const currentOverall = String(
      parsed.quality_review.overall_status || "",
    ).trim();
    const nextOverall =
      !hasValidPass && currentOverall === "pass"
        ? "needs_review"
        : hasValidPass && currentOverall === "needs_review"
          ? "pass"
          : currentOverall;
    if (nextOverall && nextOverall !== currentOverall) {
      parsed.quality_review.overall_status = nextOverall;
      changes.push({
        path: "$.quality_review.overall_status",
        from: currentOverall,
        to: nextOverall,
        reason: "quality_overall_reconciled_from_checks",
      });
    }
  }
  return {
    changed: changes.length > 0,
    parsed,
    text: JSON.stringify(parsed),
    changes,
    parseError: null,
  };
}

function isPlainObject(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSchemaValue(value, schema, path, errors) {
  if (Object.hasOwn(schema, "const") && !sameJsonValue(value, schema.const)) {
    errors.push(`字段“${path}”必须等于岗位契约规定值。`);
    return;
  }
  if (schema.enum && !schema.enum.some((item) => sameJsonValue(value, item))) {
    errors.push(`字段“${path}”不在允许值范围内。`);
    return;
  }

  if (schema.type === "object") {
    if (!isPlainObject(value)) {
      errors.push(`字段“${path}”必须是JSON对象。`);
      return;
    }
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key))
        errors.push(`缺少必需字段：${path}.${key}。`);
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).filter(
        (key) => !Object.hasOwn(properties, key),
      );
      if (unknown.length)
        errors.push(`字段“${path}”包含未知字段：${unknown.join("、")}。`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key))
        validateSchemaValue(value[key], child, `${path}.${key}`, errors);
    }
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`字段“${path}”必须是数组。`);
      return;
    }
    if (value.length < Number(schema.minItems || 0)) {
      errors.push(`字段“${path}”不能为空数组，至少需要${schema.minItems}项。`);
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push(`字段“${path}”最多允许${schema.maxItems}项。`);
    }
    value.forEach((item, index) =>
      validateSchemaValue(item, schema.items, `${path}[${index}]`, errors),
    );
    return;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`字段“${path}”必须是字符串。`);
      return;
    }
    if (schema.minLength > 0 && !value.trim()) {
      errors.push(`字段“${path}”必须是非空文本。`);
    }
    return;
  }

  if (schema.type === "integer") {
    if (!Number.isInteger(value)) errors.push(`字段“${path}”必须是整数。`);
    return;
  }

  if (schema.type === "boolean" && typeof value !== "boolean") {
    errors.push(`字段“${path}”必须是布尔值。`);
  }
}

const RUNTIME_PLACEHOLDER_PATTERN =
  /(?:待填写|待指定|待补充|请填写|请替换|占位符|placeholder|lorem\s+ipsum|(?:^|[^A-Za-z])(?:TODO|TBD)(?:$|[^A-Za-z])|模板底稿|演示样例|示例内容|范例内容)/iu;
// 结构化报告优先候选不能把“输出被截断/未放行/重新派活”写进方法
// actual_execution 后仍宣称 7 步已交付。合法的“未执行外部动作”属于授权边界，
// 不在此模式内；这里只拦截把方法本身伪装成已执行结果的占位文案。
const METHOD_EXECUTION_PLACEHOLDER_PATTERN =
  /(?:本轮(?:输出|响应|结果)被截断|(?:该|本|此)(?:步骤|方法)未执行|(?:该|本|此)(?:步骤|方法)未放行|未放行(?:该|本|此)(?:步骤|方法)?|重新派活(?:执行)?(?:该|本|此)?(?:步骤|方法)?|未能执行(?:该|本|此)(?:步骤|方法))/u;
const PUBLIC_RESEARCH_DEFLECTION_PATTERN =
  /(?:AI通道不可用|仅生成(?:可审阅的)?岗位执行底稿|未完成联网核验|不得把本底稿当作已执行结果|开始前必须补齐|全部必备能力执行清单|第\d+项岗位能力|请(?:老板|客户|用户)?(?:补充|提供|上传|告知|确认).{0,36}(?:地址|坐标|交通方式|竞品|菜单|价格|营业时间|门店状态|评价|地图|客流|公开资料))/u;
const SOURCE_ANCHOR_PATTERN =
  /(?:任务|材料|附件|系统|记录|报表|台账|清单|合同|工单|日志|平台|现场|访谈|盘点|数据库|文件|官网|公开|地图|新闻|媒体|来源|https?:\/\/|\bE-\d+-\d+(?:-R\d+)?\b|\b(?:FIN|PO|POS|CS|HR|SAFE|MKT|OPS)-[A-Z0-9-]+\b)/iu;
const GENERIC_SOURCE_PATTERN =
  /^(?:本次|当前|相关|原始)?(?:任务|业务|系统|经营)?(?:材料|数据|记录|报表|清单|文件|附件|来源)$/u;
const VERIFICATION_ACTION_PATTERN =
  /(?:核验|核对|复核|补证|补齐|回填|收集|调取|调研|验证|导出|采集|获取|访谈|盘点|抽查|上传|比对|登记|检查)/u;
// 交付动作不能只识别“核验”类动词。绘制商圈图、测算损益、编制 SOP
// 等都是合法且可验收的业务动作；具体性仍由责任人、时限和指标共同把关。
const EXECUTION_ACTION_PATTERN =
  /(?:核验|核对|复核|复查|补证|补齐|回填|收集|调取|调研|验证|导出|采集|获取|访谈|盘点|抽查|上传|比对|登记|检查|绘制|编制|建立|形成|搭建|计算|测算|制作|整理|梳理|汇总|分析|评估|识别|筛选|配置|录入|标注|输出|制定|规划|提出|分配|安排|更新|测试|试制|演练|追踪|提交|审核|确认|完成|实施|执行)/u;
const MEASURABLE_METRIC_PATTERN =
  /(?:\d|记录|台账|清单|报告|签字|审批|差异|准确率|完成率|通过率|数量|比例|系统状态|验收)/u;
const CALENDAR_DEADLINE_PATTERN =
  /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:[ T]?\d{1,2}(?::\d{1,2}|时(?:\d{1,2}分?)?))?/u;
const DURATION_DEADLINE_PATTERN = /\d+个?(?:工作)?(?:日|天|小时)内/u;
const VAGUE_DEADLINE_PATTERN =
  /(?:尽快|后续|待定|另行通知|适时|近期|尽早|今日|当天|本周|下周|月底)/u;
const OWNER_PLACEHOLDER_PATTERN =
  /(?:待定|待指定|未指定|另行指定|待确认|未知|谁负责|相关人员|有关人员|项目组成员|团队成员|执行团队|责任主体待)/u;
const GENERIC_OWNER_PATTERN =
  /^(?:(?:本项目|项目|任务|业务|执行|相关|有关)(?:岗位|部门)?(?:负责人|责任人|人员|团队)|负责人|责任人|相关人员|有关部门|项目组|工作组)$/u;
const RESPONSIBLE_ROLE_PATTERN =
  /(?:经理|主管|负责人|专员|店长|总监|部门|岗位|审核人|管理员|班组长|厨师长|采购员|财务|法务|人事|运营|研究员)/u;
const METRIC_SCOPE_PATTERN =
  /(?:\d+(?:\.\d+)?%?|至少|不少于|不超过|最多|全部|逐项|每项|所有|归零|零遗漏|无遗漏|闭环|100%)/u;
const MATERIAL_GAP_PATTERN =
  /(?:未提供|缺少|缺失|尚缺|未齐|证据缺口|材料缺口|待核验|待确认|待回填|仅完成框架)/u;
const GAP_DISCLOSURE_OBJECT_PATTERN =
  /(?:缺口|缺失|缺少|未提供|未齐|待核验|待确认|限制|不确定性)/u;
const GAP_DISCLOSURE_VERB_PATTERN =
  /(?:标注|披露|列出|列为|登记|记录|说明|指出|识别|可见|清单|台账)/u;
const TECHNICAL_ACCEPTANCE_PATTERN =
  /(?:JSON|Schema|字段(?:结构|完整|齐全)?|格式|结构|机器契约|技术(?:校验|验收)|系统(?:校验|验收)|可解析|数据类型|枚举|语法)/iu;
const BUSINESS_ACCEPTANCE_PATTERN =
  /(?:来源|事实|证据|口径|期间|数值|指标|结论|假设|风险|差异|动作|责任|阈值|顾客|门店|商圈|成本|订单|价格|食安|供应|员工|产品|服务|渠道|合规)/u;
const BUSINESS_READY_CLAIM_PATTERN =
  /(?:无需(?:人工|负责人|管理层)?(?:审批|审阅|复核)|(?:业务)?(?:可|可以|已经|已)(?:直接|立即)?(?:使用|执行|采纳|上线|投入生产|对外发布))/gu;
const MATERIAL_ONLY_ACTION_PATTERN =
  /(?:补证|补齐|回填|收集|调取|采集|获取|上传|材料|证据|待核验|缺口)/u;
const CORE_DELIVERY_ACTION_PATTERN =
  /(?:绘制|编制|建立|搭建|计算|测算|制作|分析|评估|识别|筛选|设计|制定|规划|排序|推荐|决策|建模|拆解|预测|对标|写入|提交|更新|试制|演练|输出)/u;
const EVIDENCE_CENTRIC_DELIVERABLE_PATTERN =
  /(?:证据|来源表|缺口|数据质量|勾稽|审核|核验|审计|签核)/u;
const WORK_PRODUCT_META_ONLY_PATTERN =
  /(?:详见|参见|见)(?:附件|报告|台账|清单|后续)|(?:后续补充|内容从略|未展开)|^(?:(?:现已|已经|已|将|拟|计划|待)(?:完成|形成|生成|制作|绘制|编制|建立|产出|输出)(?:了)?).{1,120}(?:表|图|卡|清单|矩阵|地图|模型|方案|记录|报告|台账|正文)(?:，|,)?(?:共|包含)?.{0,30}$/u;
const WORK_PRODUCT_CONCRETE_PATTERN =
  /(?:：|=|依据|记录|显示|观察到|假设|阈值|通过|调整|停止|风险|差异|影响|来源|高于|低于|介于|若|则|选择|排除|未提供|缺少|\d+(?:\.\d+)?(?:万|千|百)?(?:%|元|人|单|次|分钟|小时|天|日|月|年|克|千克|公斤|毫升|升|米|公里|家)|\d+(?:\.\d+)?\s*[+\-×÷=]\s*\d+)/u;
const WORK_PRODUCT_FUTURE_ONLY_PATTERN =
  /^(?:待|后续|将|计划|需|需要|请)(?:补充|补齐|补证|收集|采集|获取|提供|形成|生成|制作|输出|核验|安排)/u;
const CANONICAL_EVIDENCE_ID_PATTERN =
  /\b(?:E-\d+-\d+(?:-R\d+)?|(?:FIN|PO|POS|CS|HR|SAFE|MKT|OPS)-[A-Z0-9-]+)\b/giu;

const UNRESOLVED_GAP_PATTERNS = Object.freeze([
  ["未提供", /未提供/gu],
  ["缺少/缺失", /(?:缺少|缺失|尚缺|未齐|不完整)/gu],
  [
    "证据或材料缺口",
    /(?:存在|仍有|尚有|发现|当前有).{0,6}(?:证据|材料|数据)?缺口|(?:证据|材料|数据)缺口(?:仍|尚|未|待|需要|需)/gu,
  ],
  ["待补证或待核验", /(?:有待|待)(?:补证|回填|核验|确认|复核|完善|收集)/gu],
  [
    "仍需补证或核验",
    /(?:仍|还|尚)?需(?:另行)?(?:补充|补证|回填|核验|确认|复核|验证|完善|收集)/gu,
  ],
  [
    "无法支撑标准",
    /(?:不足以|暂?无法|不能(?:形成|证明|支持|覆盖|完成|直接))/gu,
  ],
  [
    "尚未完成标准",
    /(?:尚未|仍未|还未|未)(?:明列|覆盖|完成|形成|满足|达到|闭环|核验|确认|补齐|回填|验证|解决)/gu,
  ],
  ["仅完成框架", /(?:仅|只)(?:完成|形成)(?:了)?(?:框架|草案|模板|结构)/gu],
  [
    "后续再补",
    /(?:后续|之后|另行)(?:补充|补证|回填|核验|确认|复核|完善|收集)/gu,
  ],
]);

function unresolvedMatchIsResolved(text, match) {
  const start = Number(match.index || 0);
  const before = text.slice(Math.max(0, start - 12), start);
  const after = text.slice(
    start + match[0].length,
    start + match[0].length + 20,
  );
  if (
    /(?:不存在|没有|无|未发现|未检出|未出现|不得|不能|避免|防止|禁止|不因)$/u.test(
      before,
    )
  )
    return true;
  if (/^(?:项|内容|数据|材料)?(?:数量)?(?:为|=|：|:)?\s*0(?:项)?/u.test(after))
    return true;
  if (
    /^(?:项|内容|数据|材料)?(?:已|均已|已经|现已)(?:全部|逐项)?(?:补齐|补全|关闭|完成|核验|确认|回填|解决|闭环)/u.test(
      after,
    )
  )
    return true;
  return false;
}

function reviewPassContradictions(evidence, criterion = "") {
  let text = String(evidence || "");
  const criterionText = String(criterion || "").trim();
  if (criterionText) {
    text = text
      .replaceAll(`“${criterionText}”`, "")
      .replaceAll(`「${criterionText}」`, "");
    for (const match of criterionText.matchAll(/“([^”]+)”/gu))
      text = text.replaceAll(match[1], "");
  }
  const labels = [];
  for (const [label, pattern] of UNRESOLVED_GAP_PATTERNS) {
    pattern.lastIndex = 0;
    if (
      [...text.matchAll(pattern)].some(
        (match) => !unresolvedMatchIsResolved(text, match),
      )
    )
      labels.push(label);
  }
  return [...new Set(labels)];
}

function criterionChecksGapDisclosure(criterion) {
  const text = String(criterion || "");
  return (
    GAP_DISCLOSURE_OBJECT_PATTERN.test(text) &&
    GAP_DISCLOSURE_VERB_PATTERN.test(text) &&
    !/(?:缺口|缺失).{0,8}(?:已)?(?:关闭|解决|消除|补齐)/u.test(text)
  );
}

function parseCalendarDeadline(value, endOfDayWhenMissingTime = false) {
  const text = String(value || "");
  const match = text.match(
    /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T]?(\d{1,2})(?::(\d{1,2})|时(?:(\d{1,2})分?)?))?/u,
  );
  if (!match) return null;
  const hasTime = match[4] != null;
  const hour = hasTime ? Number(match[4]) : endOfDayWhenMissingTime ? 23 : 0;
  const minute = hasTime
    ? Number(match[5] ?? match[6] ?? 0)
    : endOfDayWhenMissingTime
      ? 59
      : 0;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    hour,
    minute,
    0,
    0,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function deadlineProblems(deadline, taskDueAt) {
  const problems = [];
  const text = String(deadline || "").trim();
  const calendar = CALENDAR_DEADLINE_PATTERN.test(text);
  if (
    VAGUE_DEADLINE_PATTERN.test(text) ||
    (!calendar && !DURATION_DEADLINE_PATTERN.test(text))
  ) {
    problems.push(`deadline“${text || "空"}”不是明确日期或可核验时限`);
    return problems;
  }
  const taskDeadline = parseCalendarDeadline(taskDueAt);
  if (taskDeadline && !calendar) {
    problems.push(`deadline“${text}”未写出服从任务截止时间的具体日历日期`);
    return problems;
  }
  const actionDeadline = parseCalendarDeadline(text, true);
  if (
    taskDeadline &&
    actionDeadline &&
    actionDeadline.getTime() > taskDeadline.getTime()
  ) {
    problems.push(`deadline“${text}”晚于任务截止时间“${taskDueAt}”`);
  }
  return problems;
}

function metricAnchorsDeliverable(metric, deliverableName) {
  const normalized = normalizedAnchor(metric);
  return deliverableAnchorTokens(deliverableName).some((token) =>
    normalized.includes(token),
  );
}

function actionSemanticProblems(action, task, deliverableName) {
  const problems = [];
  const owner = String(action?.owner || "").trim();
  const actionText = String(action?.action || "").trim();
  const deadline = String(action?.deadline || "").trim();
  const metric = String(action?.success_metric || "").trim();
  if (actionText.length < 14) problems.push("action少于14字");
  if (!EXECUTION_ACTION_PATTERN.test(actionText))
    problems.push("action缺少明确执行动词");
  if (owner.length < 4) problems.push("owner少于4字");
  if (
    OWNER_PLACEHOLDER_PATTERN.test(owner) ||
    GENERIC_OWNER_PATTERN.test(owner)
  )
    problems.push(`owner“${owner}”过于笼统或仍是占位角色`);
  problems.push(...deadlineProblems(deadline, task?.dueAt));
  if (metric.length < 12) problems.push("success_metric少于12字");
  if (!MEASURABLE_METRIC_PATTERN.test(metric))
    problems.push("success_metric缺少数量或可复核制品");
  if (!METRIC_SCOPE_PATTERN.test(metric))
    problems.push("success_metric缺少数量、阈值或逐项闭环范围");
  if (deliverableName && !metricAnchorsDeliverable(metric, deliverableName))
    problems.push("success_metric没有锚定本交付物核心维度");
  return problems;
}

function normalizedAnchor(value) {
  return String(value || "")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function deliverableAnchorTokens(value) {
  const full = String(value || "").trim();
  const tokens = full
    .split(/(?:[\s、，,;；:：/()（）]+|(?:与|及|和))/gu)
    .map(normalizedAnchor)
    .filter((token) => token.length >= 2);
  return [
    ...new Set(
      tokens.length ? tokens : [normalizedAnchor(full)].filter(Boolean),
    ),
  ];
}

function anchorsDeliverable(text, deliverableName) {
  const normalizedText = normalizedAnchor(text);
  const fullAnchor = normalizedAnchor(deliverableName);
  if (fullAnchor && normalizedText.includes(fullAnchor)) return true;
  const tokens = deliverableAnchorTokens(deliverableName);
  if (!tokens.length) return false;
  const hits = tokens.filter((token) => normalizedText.includes(token));
  if (tokens.length === 1) return hits.length === 1;
  if (tokens.length === 2) return hits.length === 2;
  // 必须覆盖交付物的首要主题，并覆盖至少一半的并列维度。
  return (
    normalizedText.includes(tokens[0]) &&
    hits.length >= Math.min(3, Math.ceil(tokens.length / 2))
  );
}

function collectTextFields(value, path = "$", result = []) {
  if (typeof value === "string") {
    result.push({ path, value: value.trim() });
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectTextFields(item, `${path}[${index}]`, result),
    );
    return result;
  }
  if (isPlainObject(value)) {
    Object.entries(value).forEach(([key, child]) =>
      collectTextFields(child, `${path}.${key}`, result),
    );
  }
  return result;
}

function amountInYuan(value, unit = "") {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (unit === "万") return number * 10_000;
  if (unit === "亿") return number * 100_000_000;
  return number;
}

function formatAmountForAudit(value) {
  if (!Number.isFinite(value)) return "未知";
  const abs = Math.abs(value);
  if (abs >= 100_000_000)
    return `${Number((value / 100_000_000).toFixed(6))}亿元`;
  if (abs >= 10_000)
    return `${Number((value / 10_000).toFixed(6))}万元`;
  return `${Number(value.toFixed(2))}元`;
}

function arithmeticMismatch(observed, expected) {
  if (!Number.isFinite(observed) || !Number.isFinite(expected)) return false;
  const tolerance = Math.max(1, Math.abs(expected) * 0.01);
  return Math.abs(observed - expected) > tolerance;
}

/**
 * 对报告正文中常见的餐饮市场算式做确定性核对。
 *
 * 只识别同时出现完整输入与“可达/年需求”结果的表达，不推断缺失事实，
 * 不替模型改写数字；返回的错误会进入定向 repair，最终仍需重新通过完整
 * schema、来源与安全门。单位统一换算为元，覆盖百分比乘法与万元/亿元。
 */
export function validateRestaurantArithmeticExpressions(value, path = "$") {
  const errors = [];
  const text = String(value || "");
  const add = ({ kind, expression, expected, observed, unit, observedDisplay }) => {
    if (!arithmeticMismatch(observed, expected)) return;
    errors.push({
      kind,
      path,
      expression,
      observed: observedDisplay || `${observed}${unit || "元"}`,
      expected: formatAmountForAudit(expected),
      message:
        kind === "percentage_market_size"
          ? `算术表达不一致：${expression}；按百分比乘法应为${formatAmountForAudit(expected)}，正文写成${observedDisplay || `${observed}${unit || "元"}`}。`
          : `金额单位换算不一致：${expression}；按月频次折算年需求应为${formatAmountForAudit(expected)}，正文写成${observedDisplay || `${observed}${unit || "元"}`}。`,
    });
  };

  // 自上而下：人口（万）×人均年消费（元）×渗透率（%）→可达/市场规模。
  const topDown =
    /(\d+(?:\.\d+)?)\s*万[^。\n]{0,100}?(?:人均(?:年)?餐饮消费|人均年餐饮消费|餐饮消费)\s*(\d+(?:\.\d+)?)\s*元[^。\n]{0,100}?(?:渗透率|占比)\s*(\d+(?:\.\d+)?)\s*[%％][^。\n]{0,100}?(?:可达|可获得市场|市场规模|年需求|需求)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(亿|万)\s*元?/gu;
  for (const topMatch of text.matchAll(topDown)) {
    const population = Number(topMatch[1]) * 10_000;
    const spend = Number(topMatch[2]);
    const rate = Number(topMatch[3]) / 100;
    const expected = population * spend * rate;
    const observed = amountInYuan(topMatch[4], topMatch[5]);
    add({
      kind: "percentage_market_size",
      expression: `${topMatch[1]}万×${topMatch[2]}元×${topMatch[3]}%=${topMatch[4]}${topMatch[5]}元`,
      expected,
      observed,
      unit: `${topMatch[5]}元`,
      observedDisplay: `${topMatch[4]}${topMatch[5]}元`,
    });
  }

  // 自下而上：覆盖人口（万）×渗透率（%）×月频次×客单价（元）×12 →年需求。
  const bottomUp =
    /(?:商圈覆盖|覆盖)人口(?:假设|约|预计)?\s*(\d+(?:\.\d+)?)\s*万[^。\n]{0,60}?渗透率\s*(\d+(?:\.\d+)?)\s*[%％][^。\n]{0,60}?频次\s*(\d+(?:\.\d+)?)\s*次\s*\/\s*月[^。\n]{0,60}?客单(?:价)?\s*(\d+(?:\.\d+)?)\s*元[^。\n]{0,60}?(?:年需求|年销售额|年营收|年市场)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(亿|万)\s*元?/gu;
  for (const bottomMatch of text.matchAll(bottomUp)) {
    const population = Number(bottomMatch[1]) * 10_000;
    const rate = Number(bottomMatch[2]) / 100;
    const monthlyFrequency = Number(bottomMatch[3]);
    const ticket = Number(bottomMatch[4]);
    const expected = population * rate * monthlyFrequency * ticket * 12;
    const observed = amountInYuan(bottomMatch[5], bottomMatch[6]);
    add({
      kind: "monthly_frequency_unit_conversion",
      expression: `${bottomMatch[1]}万×${bottomMatch[2]}%×${bottomMatch[3]}次/月×${bottomMatch[4]}元×12=${bottomMatch[5]}${bottomMatch[6]}元`,
      expected,
      observed,
      unit: `${bottomMatch[6]}元`,
      observedDisplay: `${bottomMatch[5]}${bottomMatch[6]}元`,
    });
  }

  // 直接算式也必须可复算；模型经常在表格或摘要中省略文字标签，
  // 但仍会输出“530万×3000元×5%=7.95亿元”这类表达。只接受明确的
  // 乘法、百分比和结果单位，不从孤立数字猜测业务事实。
  const directPercent =
    /(\d+(?:\.\d+)?)\s*(万|亿)?人?\s*(?:×|x|\*)\s*(\d+(?:\.\d+)?)\s*(万|亿|元)?\s*(?:×|x|\*)\s*(\d+(?:\.\d+)?)\s*[%％]\s*=\s*(\d+(?:\.\d+)?)\s*(亿|万|元)?/giu;
  for (const directPercentMatch of text.matchAll(directPercent)) {
    const population = amountInYuan(
      directPercentMatch[1],
      directPercentMatch[2] || "",
    );
    const spend = amountInYuan(
      directPercentMatch[3],
      directPercentMatch[4] || "",
    );
    const rate = Number(directPercentMatch[5]) / 100;
    const expected = population * spend * rate;
    const observed = amountInYuan(
      directPercentMatch[6],
      directPercentMatch[7] || "",
    );
    add({
      kind: "percentage_market_size",
      expression: directPercentMatch[0],
      expected,
      observed,
      unit: directPercentMatch[7] || "元",
      observedDisplay: `${directPercentMatch[6]}${directPercentMatch[7] || "元"}`,
    });
  }

  const directBottomUp =
    /(\d+(?:\.\d+)?)\s*(万|亿)?人?\s*(?:×|x|\*)\s*(\d+(?:\.\d+)?)\s*[%％]\s*(?:×|x|\*)\s*(\d+(?:\.\d+)?)\s*次\s*\/\s*月\s*(?:×|x|\*)\s*(\d+(?:\.\d+)?)\s*(万|亿|元)?\s*(?:×|x|\*)\s*12\s*=\s*(\d+(?:\.\d+)?)\s*(亿|万|元)?/giu;
  for (const directBottomUpMatch of text.matchAll(directBottomUp)) {
    const population = amountInYuan(
      directBottomUpMatch[1],
      directBottomUpMatch[2] || "",
    );
    const rate = Number(directBottomUpMatch[3]) / 100;
    const monthlyFrequency = Number(directBottomUpMatch[4]);
    const ticket = amountInYuan(
      directBottomUpMatch[5],
      directBottomUpMatch[6] || "",
    );
    const expected = population * rate * monthlyFrequency * ticket * 12;
    const observed = amountInYuan(
      directBottomUpMatch[7],
      directBottomUpMatch[8] || "",
    );
    add({
      kind: "monthly_frequency_unit_conversion",
      expression: directBottomUpMatch[0],
      expected,
      observed,
      unit: directBottomUpMatch[8] || "元",
      observedDisplay: `${directBottomUpMatch[7]}${directBottomUpMatch[8] || "元"}`,
    });
  }

  // 同一类年需求测算也常被模型压缩成“覆盖人口×渗透率×年频次×客单价”
  // 的裸算式（例如 20万×3%×12×80=576万），没有写“次/月”或“元”。
  // 这里仅接受明确的四个因子和等号结果，不从孤立数字猜业务事实；有单位
  // 的表达仍由上面的 directBottomUp 负责，避免把两种语义混成一条规则。
  const directAnnualDemand =
    /(\d+(?:\.\d+)?)\s*(万|亿)?人?\s*(?:×|x|\*)\s*(\d+(?:\.\d+)?)\s*[%％]\s*(?:×|x|\*)\s*(\d+(?:\.\d+)?)\s*(?:次(?:\s*\/\s*年)?|年频次)?\s*(?:×|x|\*)\s*(\d+(?:\.\d+)?)\s*(万|亿|元)?\s*=\s*(\d+(?:\.\d+)?)\s*(亿|万|元)?/giu;
  for (const directAnnualMatch of text.matchAll(directAnnualDemand)) {
    const population = amountInYuan(
      directAnnualMatch[1],
      directAnnualMatch[2] || "",
    );
    const rate = Number(directAnnualMatch[3]) / 100;
    const annualFrequency = Number(directAnnualMatch[4]);
    const ticket = amountInYuan(
      directAnnualMatch[5],
      directAnnualMatch[6] || "",
    );
    const expected = population * rate * annualFrequency * ticket;
    const observed = amountInYuan(
      directAnnualMatch[7],
      directAnnualMatch[8] || "",
    );
    add({
      kind: "monthly_frequency_unit_conversion",
      expression: directAnnualMatch[0],
      expected,
      observed,
      unit: directAnnualMatch[8] || "元",
      observedDisplay: `${directAnnualMatch[7]}${directAnnualMatch[8] || "元"}`,
    });
  }
  return errors;
}

function semanticItemKey(value) {
  if (typeof value === "string") return normalizedAnchor(value);
  if (Array.isArray(value)) return value.map(semanticItemKey).join("|");
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .map((key) => `${key}:${semanticItemKey(value[key])}`)
      .join("|");
  }
  return String(value);
}

function validateUniqueArray(items, path, errors) {
  const seen = new Set();
  items.forEach((item, index) => {
    const key = semanticItemKey(item);
    if (seen.has(key))
      errors.push(
        `字段“${path}[${index}]”与同数组已有内容重复，禁止复制条目凑数。`,
      );
    seen.add(key);
  });
}

function validateUniqueMappedObjects(items, path, fields, label, errors) {
  const seen = new Set();
  items.forEach((item, index) => {
    const key = semanticItemKey(fields.map((field) => item?.[field]));
    if (seen.has(key)) {
      errors.push(
        `字段“${path}[${index}]”与已有${label}内容重复，禁止复制泛化文本凑逐项覆盖。`,
      );
    }
    seen.add(key);
  });
}

function canonicalEvidenceIds(value) {
  return new Set(
    (String(value || "").match(CANONICAL_EVIDENCE_ID_PATTERN) || []).map((id) =>
      id.toUpperCase(),
    ),
  );
}

function evidenceReferenceIsDeclared(reference, declaredSources) {
  const ref = String(reference || "").trim();
  // 任务要求、附件、知识库、待核验假设与input/step/deliverable等结构键是
  // 会话内真实证据锚点；接受它们不等于放行模型补造外部来源。
  if (internalEvidenceRefLabel(ref)) return true;
  const normalizedRef = normalizedAnchor(ref);
  const declaredIds = new Set(
    declaredSources.flatMap((source) => [...canonicalEvidenceIds(source)]),
  );
  const refIds = [...canonicalEvidenceIds(ref)];
  if (refIds.some((id) => declaredIds.has(id))) return true;
  return declaredSources.some((source) => {
    const normalizedSource = normalizedAnchor(source);
    return (
      normalizedRef === normalizedSource ||
      (normalizedRef.length >= 6 && normalizedSource.includes(normalizedRef)) ||
      (normalizedSource.length >= 6 && normalizedRef.includes(normalizedSource))
    );
  });
}

function validateEvidenceReferences(references, declaredSources, path, errors) {
  validateUniqueArray(references || [], path, errors);
  for (const [index, reference] of (references || []).entries()) {
    if (!evidenceReferenceIsDeclared(reference, declaredSources)) {
      errors.push(
        `字段“${path}[${index}]”未回指本次来源；必须使用完整source或其中规范证据ID。`,
      );
    }
  }
}

function validateInputAndMethodTrace(
  parsed,
  contract,
  task,
  errors,
  allowedCanonicalSources = [],
) {
  const contextSources = (parsed.decision_context?.sources || [])
    .map((source) => String(source?.source || "").trim())
    .filter(Boolean);
  const deliverableSources = contract.deliverableKeys.flatMap((key) =>
    (parsed.deliverables?.[key]?.evidence || []).map((item) =>
      String(item?.source || "").trim(),
    ),
  );
  // 允许快照中的“原始标题｜完整URL”是本轮系统自身核验过的证据；
  // 引用它们即使未逐条写进decision_context.sources也不算补造来源。
  const declaredSources = [
    ...new Set([
      ...contextSources,
      ...deliverableSources,
      ...allowedCanonicalSources,
    ]),
  ];
  const inputItems = contract.inputKeys.map((key) => parsed.input_audit?.[key]);
  validateUniqueMappedObjects(
    inputItems,
    "$.input_audit",
    ["finding", "impact", "verification"],
    "输入审计",
    errors,
  );
  for (const [index, item] of inputItems.entries()) {
    if (!item) continue;
    const base = `$.input_audit.${contract.inputKeys[index]}`;
    const finding = String(item.finding || "").trim();
    const impact = String(item.impact || "").trim();
    if (finding.length < 18 || impact.length < 14) {
      errors.push(
        `字段“${base}”必须逐项写明不少于18字的实际finding和不少于14字的具体业务impact。`,
      );
    }
    if (item.status === "supplied" && reviewPassContradictions(finding).length) {
      errors.push(
        `字段“${base}”标为supplied但finding仍承认输入缺失或待核验。`,
      );
    }
    if (
      (item.status === "missing" || item.status === "assumption") &&
      !reviewPassContradictions(`${finding} ${impact}`).length &&
      !/(?:假设|推定|代理指标|待验证)/u.test(`${finding} ${impact}`)
    ) {
      errors.push(
        `字段“${base}”标为${item.status}却没有写清具体缺失或待验证假设及影响。`,
      );
    }
    validateEvidenceReferences(
      item.evidence_refs,
      declaredSources,
      `${base}.evidence_refs`,
      errors,
    );
    const verification = item.verification || {};
    const verificationProblems = actionSemanticProblems(
      {
        action: verification.action,
        owner: verification.owner,
        deadline: verification.deadline,
        success_metric: `逐项核验${item.input_name}并形成1份输入记录，未核验项数量归零或逐项登记。`,
      },
      task,
      item.input_name,
    ).filter((problem) => !/success_metric/u.test(problem));
    if (verificationProblems.length) {
      errors.push(
        `字段“${base}.verification”不合格：${verificationProblems.join("、")}。必须写具体owner、核验action和明确deadline。`,
      );
    }
  }

  const methodItems = contract.methodKeys.map(
    (key) => parsed.method_execution?.[key],
  );
  validateUniqueMappedObjects(
    methodItems,
    "$.method_execution",
    ["actual_execution", "missing", "next_action"],
    "方法执行",
    errors,
  );
  for (const [index, item] of methodItems.entries()) {
    if (!item) continue;
    const base = `$.method_execution.${contract.methodKeys[index]}`;
    const execution = String(item.actual_execution || "").trim();
    const missing = String(item.missing || "").trim();
    const nextAction = String(item.next_action || "").trim();
    if (execution.length < 20 || nextAction.length < 14) {
      errors.push(
        `字段“${base}”必须写不少于20字的本轮actual_execution和不少于14字的next_action。`,
      );
    }
    if (
      normalizedAnchor(execution) === normalizedAnchor(item.step_name) ||
      /^(?:已)?(?:完成|执行)(?:了)?(?:本|该|此)?步骤[。.]?$/u.test(execution)
    ) {
      errors.push(
        `字段“${base}.actual_execution”只复述方法或声称已完成，没有本轮实际业务执行结果。`,
      );
    }
    if (METHOD_EXECUTION_PLACEHOLDER_PATTERN.test(execution)) {
      errors.push(
        `字段“${base}.actual_execution”把未执行、输出截断或重新派活说明冒充本轮业务结果；必须写已实际执行的动作、结果或据实的应用缺口。`,
      );
    }
    const executionForStatus = Object.values(parsed.deliverables || {}).reduce(
      (text, deliverable) =>
        text.replaceAll(String(deliverable?.deliverable_name || ""), ""),
      execution.replaceAll(String(item.step_name || ""), ""),
    );
    const unresolved = reviewPassContradictions(
      `${executionForStatus} ${missing}`,
    );
    if (item.status === "completed" && unresolved.length) {
      errors.push(
        `字段“${base}”标为completed但仍有未完成内容：${unresolved.join("、")}。`,
      );
    }
    if (
      (item.status === "partial" || item.status === "blocked") &&
      !unresolved.length
    ) {
      errors.push(
        `字段“${base}”标为${item.status}却没有在missing写清具体未完成项或阻断。`,
      );
    }
    if (!EXECUTION_ACTION_PATTERN.test(nextAction)) {
      errors.push(`字段“${base}.next_action”缺少明确执行动词。`);
    }
    validateEvidenceReferences(
      item.evidence_refs,
      declaredSources,
      `${base}.evidence_refs`,
      errors,
    );
  }
}

function validateWorkProduct(
  item,
  requirement,
  contextSources,
  base,
  errors,
  allowedCanonicalSources = [],
) {
  const workProduct = item.work_product;
  const sections = Array.isArray(workProduct?.sections)
    ? workProduct.sections
    : [];
  validateUniqueArray(sections, `${base}.work_product.sections`, errors);
  const entries = [];
  for (const [sectionIndex, section] of sections.entries()) {
    const sectionBase = `${base}.work_product.sections[${sectionIndex}]`;
    validateUniqueArray(section.items || [], `${sectionBase}.items`, errors);
    for (const [itemIndex, workItem] of (section.items || []).entries()) {
      entries.push({
        sectionName: String(section.section_name || ""),
        item: workItem,
        path: `${sectionBase}.items[${itemIndex}]`,
      });
    }
  }
  validateUniqueArray(
    entries.map((entry) => entry.item?.result),
    `${base}.work_product.results`,
    errors,
  );
  const distinct = new Set(entries.map((entry) => semanticItemKey(entry.item)));
  if (distinct.size < requirement.minimumItems) {
    errors.push(
      `字段“${base}.work_product”正文少于${requirement.minimumItems}项（互异正文为${distinct.size}项），不能只声明制品存在。`,
    );
  }

  const declaredSources = [
    ...contextSources.map((source) => String(source?.source || "").trim()),
    ...(item.evidence || []).map((evidence) =>
      String(evidence?.source || "").trim(),
    ),
    ...allowedCanonicalSources,
  ].filter(Boolean);
  let verifiedCount = 0;
  for (const entry of entries) {
    const label = String(entry.item?.label || "").trim();
    const result = String(entry.item?.result || "").trim();
    const status = String(entry.item?.status || "").trim();
    if (label.length < 2 || result.length < 12) {
      errors.push(
        `字段“${entry.path}”必须给出具体label和不少于12字的result正文。`,
      );
    }
    if (
      WORK_PRODUCT_META_ONLY_PATTERN.test(result) ||
      !WORK_PRODUCT_CONCRETE_PATTERN.test(result)
    ) {
      errors.push(
        `字段“${entry.path}.result”正文只声明制品存在而未交付实际内容。`,
      );
    }
    if (
      !evidenceReferenceIsDeclared(entry.item?.evidence_ref, declaredSources)
    ) {
      errors.push(
        `字段“${entry.path}.evidence_ref”未回指本次来源；必须使用完整source或其中规范证据ID。`,
      );
    }
    const contradictions = reviewPassContradictions(result);
    if (status === "verified" && contradictions.length) {
      errors.push(
        `字段“${entry.path}”标为verified但正文仍承认未闭环：${contradictions.join("、")}。`,
      );
    }
    if (status === "gap" && !contradictions.length) {
      errors.push(`字段“${entry.path}”标为gap却没有写清具体缺失或待核验内容。`);
    }
    if (
      status === "verified" &&
      !WORK_PRODUCT_META_ONLY_PATTERN.test(result) &&
      !WORK_PRODUCT_FUTURE_ONLY_PATTERN.test(result)
    )
      verifiedCount += 1;
  }
  const bodyText = normalizedAnchor(
    entries
      .map(
        (entry) =>
          `${entry.sectionName} ${entry.item?.label || ""} ${entry.item?.result || ""}`,
      )
      .join(" "),
  );
  const missingCoverage = requirement.coverageLabels.filter(
    (label) => !bodyText.includes(normalizedAnchor(label)),
  );
  if (missingCoverage.length) {
    errors.push(
      `字段“${base}.work_product”未覆盖交付物核心维度：${missingCoverage.join("、")}。`,
    );
  }

  for (const group of requirement.groups) {
    const groupEntries = entries.filter(
      (entry) =>
        normalizedAnchor(
          `${entry.sectionName} ${entry.item?.label || ""}`,
        ).includes(normalizedAnchor(group.sectionLabel)) ||
        group.requiredLabels.some((label) =>
          normalizedAnchor(entry.item?.label).includes(normalizedAnchor(label)),
        ),
    );
    if (groupEntries.length < group.minimumItems) {
      errors.push(
        `字段“${base}.work_product”中“${group.sectionLabel}”至少需要${group.minimumItems}个实际正文项。`,
      );
    }
    const groupText = normalizedAnchor(
      groupEntries
        .map((entry) => `${entry.item?.label} ${entry.item?.result}`)
        .join(" "),
    );
    const missingLabels = group.requiredLabels.filter(
      (label) => !groupText.includes(normalizedAnchor(label)),
    );
    if (missingLabels.length) {
      errors.push(
        `字段“${base}.work_product”中“${group.sectionLabel}”缺少：${missingLabels.join("、")}。`,
      );
    }
    if (group.requiredResultTerms.length) {
      for (const entry of groupEntries) {
        const missingTerms = group.requiredResultTerms.filter(
          (term) => !String(entry.item?.result || "").includes(term),
        );
        if (missingTerms.length) {
          errors.push(
            `字段“${entry.path}.result”必须逐卡写明${group.requiredResultTerms.join("、")}阈值。`,
          );
        }
      }
    }
  }
  return { verifiedCount, itemCount: entries.length };
}

function assumptionSemanticProblems(assumption, task) {
  const problems = [];
  const verification = String(assumption?.verification || "").trim();
  if (String(assumption?.assumption || "").trim().length < 10)
    problems.push("assumption少于10字");
  if (String(assumption?.impact || "").trim().length < 10)
    problems.push("impact少于10字");
  if (verification.length < 12) problems.push("verification少于12字");
  if (!VERIFICATION_ACTION_PATTERN.test(verification))
    problems.push("verification缺少明确补证或核验动作");
  if (
    !RESPONSIBLE_ROLE_PATTERN.test(verification) ||
    OWNER_PLACEHOLDER_PATTERN.test(verification)
  )
    problems.push("verification缺少具体岗位责任角色");
  const deadlineMatch =
    verification.match(CALENDAR_DEADLINE_PATTERN)?.[0] ||
    verification.match(DURATION_DEADLINE_PATTERN)?.[0] ||
    verification.match(VAGUE_DEADLINE_PATTERN)?.[0] ||
    "";
  problems.push(
    ...deadlineProblems(deadlineMatch, task?.dueAt).map((problem) =>
      problem.replace(/^deadline/u, "verification时限"),
    ),
  );
  return problems;
}

function criterionBigrams(value) {
  const normalized = normalizedAnchor(value);
  const ignored = new Set([
    "没有",
    "已经",
    "当前",
    "本次",
    "质量",
    "要求",
    "明确",
    "进行",
    "通过",
    "符合",
    "相关",
    "不得",
    "不能",
    "必须",
    "是否",
    "以及",
    "或者",
    "作为",
    "其中",
    "实际",
    "记录",
    "说明",
    "检查",
  ]);
  const grams = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const gram = normalized.slice(index, index + 2);
    if (!ignored.has(gram)) grams.push(gram);
  }
  return [...new Set(grams)];
}

function evidenceAnchorsCriterion(evidence, criterion) {
  const evidenceText = normalizedAnchor(evidence);
  const grams = criterionBigrams(criterion);
  if (!grams.length) return true;
  const matches = grams.filter((gram) => evidenceText.includes(gram));
  return matches.length >= Math.min(2, grams.length);
}

function acceptanceIsTechnicalOnly(acceptance) {
  const criterion = String(acceptance?.criterion || "");
  return (
    TECHNICAL_ACCEPTANCE_PATTERN.test(criterion) &&
    !BUSINESS_ACCEPTANCE_PATTERN.test(criterion)
  );
}

function hasUnapprovedBusinessReadyClaim(value) {
  const text = String(value || "");
  BUSINESS_READY_CLAIM_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(BUSINESS_READY_CLAIM_PATTERN)) {
    const before = text.slice(
      Math.max(0, Number(match.index || 0) - 18),
      Number(match.index || 0),
    );
    const after = text.slice(
      Number(match.index || 0) + match[0].length,
      Number(match.index || 0) + match[0].length + 4,
    );
    if (
      /(?:不等于|不代表|不意味着|不可|不能|不得|禁止|尚不|未经|未获|审批前|审阅前|经.{0,8}(?:批准|审批)后|审批后)$/u.test(
        before,
      )
    )
      continue;
    // “建立可执行的SSOP/形成可使用性报告”是在描述制品属性，不是宣称
    // 当前草稿已经获准执行。只有独立谓语式“业务可执行/可使用”才算越界。
    if (/^(?:的|性)/u.test(after)) continue;
    return true;
  }
  return false;
}

const OUTPUT_HTTP_URL_PATTERN =
  /[hH][tT][tT][pP][sS]?:\/\/[^\s"'<>|*`，。；！？、（）【】]+/gu;
const OUTPUT_HTTP_URL_START_PATTERN = /[hH][tT][tT][pP][sS]?:\/\//gu;
const PUBLIC_SOURCE_WORD_PATTERN =
  /(?:官网|地图|公开|平台|新闻|媒体|搜索|点评|美团|高德|百度|公众号|小红书|抖音|统计局|政府|商场|门店页)/u;
const PUBLIC_SOURCE_ASSERTION_PATTERN =
  /(?:据|根据|来自|来源于|页面显示|数据显示|官方显示|平台显示)[^。！？!?;；\n]{0,32}(?:官网|地图|公开|平台|新闻|媒体|搜索|点评|美团|高德|百度|公众号|小红书|抖音|统计局|政府|商场|门店页)/u;
const BLOCKED_DELIVERY_MODEL_PATTERN =
  /(?:^|[-_:/\s])(?:template|fallback|mock|fixture|offline|failed|unknown|error|demo|degraded|inherit)(?:$|[-_:/\s])/iu;
const UNAUTHORIZED_EXTERNAL_ACTION_CLAIM_PATTERN =
  /(?:已|已经)(?:完成)?(?:发布|上线|投放|付款|支付|采购|调价|删除|写入生产|发送)|(?:无需|不需)(?:人工|负责人|管理层|老板)?(?:审核|审阅|授权|确认|核验)|自动(?:发布|上线|投放|扣费|付款|支付|采购|调价|删除|写入生产|发送)/gu;
const UNAUTHORIZED_RESERVATION_ACTION_PATTERN =
  /(?:已|已经|自动|直接)(?:完成)?(?:订座|预订|预约|锁位|占桌|接单|分配桌台|改价|动态定价|收取定金|收款|接受订单)/gu;
const PLATFORM_IDENTITY_DECEPTION_PATTERN =
  /(?:使用|采用|创建|注册|改用|换用|冒用|伪造|用)[^，,。！？!?;；\n]{0,24}(?:伪(?:造)?(?:ID|账号|身份|商户|门店|店铺)|假(?:ID|账号|身份|商户|门店|店铺)|虚假(?:ID|账号|身份|商户|门店|店铺)|冒用(?:ID|账号|身份|商户|门店|店铺))/giu;
const PLATFORM_RULE_EVASION_PATTERN =
  /(?:绕过|规避|躲避|逃避|避开)[^，,。！？!?;；\n]{0,20}(?:平台|品类|审核|风控|规则|限制)|(?:平台|品类|审核|风控|规则|限制)[^，,。！？!?;；\n]{0,20}(?:绕过|规避|躲避|逃避|避开)/gu;
const UNAUTHORIZED_PLATFORM_LISTING_PATTERN =
  /(?:(?:建议|计划|安排|开展|进行|准备|启动|试行|可|可以|将|要|应|需要)?[^，,。！？!?;；\n]{0,10}(?:在|到|通过|用)(?:美团|饿了么|大众点评|抖音|外卖平台)[^，,。！？!?;；\n]{0,14}(?:真实|实际|直接)?(?:上架|上线|开店|投放)|(?:真实|实际|直接)(?:上架|上线|开店|投放))/gu;
const WEB_SOURCE_TRACKING_QUERY_KEY =
  /^(?:utm_.+|fbclid|gclid|dclid|msclkid|yclid|mc_cid|mc_eid)$/iu;

function canonicalRuntimeSourceUrl(value) {
  const raw = String(value || "").replace(
    /[)>\]}.;,!?，。；！？）】》]+$/gu,
    "",
  );
  try {
    const url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return "";
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    if (
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    )
      url.port = "";
    const query = [...url.searchParams.entries()]
      .filter(([key]) => !WEB_SOURCE_TRACKING_QUERY_KEY.test(key))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey === rightKey
          ? leftValue.localeCompare(rightValue)
          : leftKey.localeCompare(rightKey),
      );
    url.search = "";
    for (const [key, queryValue] of query)
      url.searchParams.append(key, queryValue);
    return url.href;
  } catch {
    return "";
  }
}

function extractRuntimeSourceUrls(value, allowedSources = []) {
  const text = String(value || "");
  const allowedUrls = allowedSources
    .map((item) =>
      canonicalRuntimeSourceUrl(typeof item === "string" ? item : item?.url),
    )
    .filter(Boolean);
  const output = [];
  for (const match of text.matchAll(OUTPUT_HTTP_URL_START_PATTERN)) {
    const tail = text.slice(match.index);
    let verifiedPrefix = "";
    for (const allowedUrl of allowedUrls) {
      const variants = [allowedUrl];
      try {
        variants.push(decodeURI(allowedUrl));
      } catch {
        // canonical URL stays available when a malformed escape cannot decode.
      }
      const matchedVariant = variants.find((variant) => {
        if (!tail.startsWith(variant)) return false;
        const next = tail.slice(variant.length, variant.length + 1);
        return (
          !next ||
          /[\s"'<>|*`，。；！？、（）【】\u0080-\u{10ffff}]/u.test(next)
        );
      });
      if (matchedVariant) {
        verifiedPrefix = allowedUrl;
        break;
      }
    }
    if (verifiedPrefix) {
      output.push(verifiedPrefix);
      continue;
    }
    const candidate = tail.match(OUTPUT_HTTP_URL_PATTERN)?.[0] || "";
    const canonical = canonicalRuntimeSourceUrl(candidate);
    if (canonical) output.push(canonical);
  }
  return [...new Set(output)];
}

function normalizedAllowedWebSources(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const output = [];
  for (const item of value) {
    const url = canonicalRuntimeSourceUrl(item?.url);
    if (!url) continue;
    const title = String(item?.title || "").trim();
    if (!title || seen.has(url)) continue;
    seen.add(url);
    const fetchedAt = String(item?.fetchedAt || item?.fetched_at || "").trim();
    output.push({ title, url, ...(fetchedAt ? { fetchedAt } : {}) });
  }
  return output;
}

function runtimeSourceDate(value) {
  const raw = String(value || "").trim();
  const direct = raw.match(/^(\d{4}-\d{2}-\d{2})/u)?.[1];
  if (!direct) return "";
  const date = new Date(`${direct}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? "" : direct;
}

function validateRuntimeSourcePeriods(parsed, allowedSources, errors) {
  const datedSources = normalizedAllowedWebSources(allowedSources)
    .map((source) => ({ ...source, fetchedDate: runtimeSourceDate(source.fetchedAt) }))
    .filter((source) => source.fetchedDate);
  if (!datedSources.length) return;
  const validateEntry = (entry, path) => {
    const sourceName = String(entry?.source || "").trim();
    const sourceUrls = extractRuntimeSourceUrls(sourceName, datedSources);
    const authoritative = datedSources.find((source) =>
      sourceUrls.includes(source.url),
    );
    if (!authoritative) return;
    const period = String(entry?.period || "").trim();
    if (
      period !== authoritative.fetchedDate &&
      !period.includes(`采集于${authoritative.fetchedDate}`)
    ) {
      errors.push(
        `字段“${path}.period”引用本轮实时公开来源时，必须等于权威采集日期${authoritative.fetchedDate}或明确写“采集于${authoritative.fetchedDate}”，禁止模型自填旧日期。`,
      );
    }
  };
  (parsed.decision_context?.sources || []).forEach((entry, index) =>
    validateEntry(entry, `$.decision_context.sources[${index}]`),
  );
  for (const [deliverableKey, deliverable] of Object.entries(
    parsed.deliverables || {},
  )) {
    (deliverable?.evidence || []).forEach((entry, index) =>
      validateEntry(
        entry,
        `$.deliverables.${deliverableKey}.evidence[${index}]`,
      ),
    );
  }
}

function cleanOutputUrl(value) {
  return canonicalRuntimeSourceUrl(value) || String(value || "").trim();
}

function positiveDeliveryTokenCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function isNegatedExternalActionClaim(text, index) {
  const before = String(text || "").slice(
    Math.max(0, Number(index || 0) - 48),
    Number(index || 0),
  );
  const clause = before.split(/[，,。！？!?;；\n]/u).at(-1)?.trim() || "";
  // Keep normal governance language such as “不自动发布” and
  // “不因单一指标自动调价” deliverable.  Only the current punctuation-delimited
  // clause is considered so “无需审核，内容已经发布” is still blocked.
  return (
    /(?:不因|不把|尚未|当前不|绝不|并未|从未|不得|禁止|不能|不会|不可|不应|不允许|未经|未获)[^，,。！？!?;；\n]{0,32}$/u.test(
      clause,
    ) || /(?:不|不要|不再|不直接|不主动|不实际)$/u.test(clause)
  );
}

function hasUnauthorizedExternalActionClaim(value) {
  const text = String(value || "");
  UNAUTHORIZED_EXTERNAL_ACTION_CLAIM_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(UNAUTHORIZED_EXTERNAL_ACTION_CLAIM_PATTERN)) {
    if (isNegatedExternalActionClaim(text, match.index)) {
      continue;
    }
    return true;
  }
  UNAUTHORIZED_RESERVATION_ACTION_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(UNAUTHORIZED_RESERVATION_ACTION_PATTERN)) {
    if (!isNegatedExternalActionClaim(text, match.index)) return true;
  }
  return false;
}

function platformActionIsProhibitedOrAuthorized(text, index, matchedText = "") {
  if (
    /^[^，,。！？!?;；\n]{0,6}(?:不得|禁止|严禁|切勿|不可|不能|不允许|不要|避免|拒绝|绝不|不应|不会|未经|未获)/u.test(
      String(matchedText || ""),
    )
  ) {
    return true;
  }
  const before = String(text || "").slice(
    Math.max(0, Number(index || 0) - 96),
    Number(index || 0),
  );
  if (
    /(?:(?<!未)经|取得|获得|确认)[^。！？!?;；\n]{0,48}(?:书面)?(?:审批|审核|授权|许可|批准|同意)(?:后|之后|方可|才可)[，,\s]{0,6}$/u.test(
      before,
    )
  ) {
    return true;
  }
  const clause = before.split(/[，,。！？!?;；\n]/u).at(-1)?.trim() || "";
  if (clause.endsWith("不")) return true;
  const negations = [
    ...clause.matchAll(
      /(?:不得|禁止|严禁|切勿|不可|不能|不允许|不要|避免|拒绝|绝不|不应|不会|未经|未获)/gu,
    ),
  ];
  const nearestNegation = negations.at(-1);
  if (nearestNegation) {
    const suffix = clause.slice(
      Number(nearestNegation.index || 0) + nearestNegation[0].length,
    );
    // “平台不允许改品类，则用伪ID”中的“不允许”描述的是平台限制，
    // 并没有否定后面的规避动作。转折/承接词之后必须重新出现否定词，
    // 才能被视为“不得使用伪ID”这类合规语境。
    if (
      !/(?:则|就|但|然而|却|仍|反而|改为|转而)/u.test(suffix) &&
      [...suffix].length <= 36
    ) {
      return true;
    }
  }
  return /(?:经|取得|获得|确认)[^，,。！？!?;；\n]{0,32}(?:书面)?(?:审批|审核|授权|许可|批准|同意)(?:后|之后|方可|才可)[^，,。！？!?;；\n]{0,16}$/u.test(
    clause,
  );
}

function unsafePlatformActionMatches(value) {
  const text = String(value || "");
  const matches = [];
  for (const [category, pattern] of [
    ["platform_identity_deception", PLATFORM_IDENTITY_DECEPTION_PATTERN],
    ["platform_rule_evasion", PLATFORM_RULE_EVASION_PATTERN],
    ["unauthorized_platform_listing", UNAUTHORIZED_PLATFORM_LISTING_PATTERN],
    ["unauthorized_reservation_action", UNAUTHORIZED_RESERVATION_ACTION_PATTERN],
  ]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (
        platformActionIsProhibitedOrAuthorized(text, match.index, match[0])
      ) {
        continue;
      }
      matches.push({
        start: Number(match.index || 0),
        end: Number(match.index || 0) + String(match[0] || "").length,
        category,
      });
    }
  }
  return matches.sort((left, right) => left.start - right.start || right.end - left.end);
}

function hasUnsafePlatformActionRecommendation(value) {
  return unsafePlatformActionMatches(value).length > 0;
}

const SAFE_PLATFORM_VALIDATION_REPLACEMENT =
  "仅可在平台提供的合规测试工具或沙盒中验证，并须先取得平台书面许可与老板执行授权；否则改用纯线下意向页或问卷验证，不产生真实订单或费用";

function rewriteUnsafePlatformActionText(value, path, changes) {
  const text = String(value || "");
  const unsafe = unsafePlatformActionMatches(text);
  if (!unsafe.length) return text;
  const ranges = [];
  for (const item of unsafe) {
    const previous = ranges.at(-1);
    if (previous && item.start <= previous.end) {
      previous.end = Math.max(previous.end, item.end);
      previous.categories.add(item.category);
      continue;
    }
    ranges.push({
      start: item.start,
      end: item.end,
      categories: new Set([item.category]),
    });
  }
  let rewritten = text;
  for (const range of ranges.reverse()) {
    const from = rewritten.slice(range.start, range.end);
    rewritten = `${rewritten.slice(0, range.start)}${SAFE_PLATFORM_VALIDATION_REPLACEMENT}${rewritten.slice(range.end)}`;
    changes.push({
      path,
      from,
      to: SAFE_PLATFORM_VALIDATION_REPLACEMENT,
      reason: "unsafe_platform_action_rewritten",
      categories: [...range.categories].sort(),
    });
  }
  return rewritten;
}

/**
 * 把模型建议中的平台身份伪造、规则规避和未授权真实上架，确定性收敛为
 * “获平台许可与老板授权的沙盒验证，否则线下验证”。不补事实、不执行动作；
 * 调用方必须把 changes 持久化到候选审计账本，改写后仍需重新跑 hard guard。
 */
export function rewriteUnsafeRestaurantPlatformActions(rawOutput) {
  const parsedResult = parseOutput(rawOutput);
  const changes = [];
  if (!parsedResult.parsed) {
    const text = rewriteUnsafePlatformActionText(rawOutput, "$", changes);
    return {
      changed: changes.length > 0,
      text,
      parsed: null,
      changes,
      parseError: parsedResult.error,
    };
  }
  const parsed = structuredClone(parsedResult.parsed);
  const walk = (value, path) => {
    if (typeof value === "string")
      return rewriteUnsafePlatformActionText(value, path, changes);
    if (Array.isArray(value))
      return value.map((item, index) => walk(item, `${path}[${index}]`));
    if (!value || typeof value !== "object") return value;
    for (const [key, child] of Object.entries(value)) {
      value[key] = walk(child, `${path}.${key}`);
    }
    return value;
  };
  walk(parsed, "$");
  return {
    changed: changes.length > 0,
    text: JSON.stringify(parsed),
    parsed,
    changes,
    parseError: null,
  };
}

/**
 * Final delivery guard shared by structured restaurant output and demo
 * report-first Markdown. Job JSON quality can be advisory in demo, but these
 * facts are never advisory: authentic provider identity/usage, non-empty
 * output, profile confidentiality, source provenance and execution authority.
 */
export function restaurantEmployeeHardDeliveryDecision({
  text = "",
  mode = "",
  model = "",
  usage = null,
  internalProfileLeakage = null,
  task = null,
  allowedSources = [],
} = {}) {
  const normalizedText = String(text || "").trim();
  const normalizedMode = String(mode || "").trim().toLowerCase();
  const normalizedModel = String(model || "").trim();
  const inputTokens = positiveDeliveryTokenCount(usage?.inputTokens);
  const outputTokens = positiveDeliveryTokenCount(usage?.outputTokens);
  const errors = [];

  if (!normalizedText) errors.push("餐饮数字员工没有返回可保存的报告正文。");
  if (normalizedMode !== "api") {
    errors.push("餐饮数字员工未取得真实API结果，模板或降级输出不得交付。");
  }
  if (
    !normalizedModel ||
    BLOCKED_DELIVERY_MODEL_PATTERN.test(normalizedModel)
  ) {
    errors.push("餐饮数字员工模型身份不是可验收的真实provider模型。");
  }
  if (inputTokens <= 0 || outputTokens <= 0) {
    errors.push("餐饮数字员工缺少正向输入与输出Token用量证据。");
  }
  if (internalProfileLeakage?.detected === true) {
    errors.push("餐饮数字员工输出包含内部岗位档案，已阻止交付。");
  }

  if (normalizedText) {
    if (hasUnauthorizedExternalActionClaim(normalizedText)) {
      errors.push(
        "餐饮数字员工不得声称已外发、付款或执行不可逆动作，也不得绕过授权。",
      );
    }
    if (hasUnsafePlatformActionRecommendation(normalizedText)) {
      errors.push(
        "餐饮数字员工不得建议伪造或冒用平台身份、规避平台规则，亦不得建议未经平台许可与老板执行授权进行真实上架。",
      );
    }

    const normalizedAllowed = normalizedAllowedWebSources(allowedSources);
    const allowedUrls = new Set(normalizedAllowed.map((item) => item.url));
    const taskText = [task?.title, task?.type, task?.requirement]
      .filter(Boolean)
      .join("\n");
    for (const url of extractRuntimeSourceUrls(taskText)) allowedUrls.add(url);

    const rawUrls = [...normalizedText.matchAll(OUTPUT_HTTP_URL_PATTERN)].map(
      (match) => String(match[0] || ""),
    );
    const malformedUrls = rawUrls.filter(
      (url) => !canonicalRuntimeSourceUrl(url),
    );
    if (malformedUrls.length) {
      errors.push(
        "餐饮数字员工输出包含无效URL或带用户名、密码凭据的URL，已阻止交付。",
      );
    }
    const unverifiedUrls = extractRuntimeSourceUrls(
      normalizedText,
      normalizedAllowed,
    ).filter((url) => !allowedUrls.has(url));
    if (unverifiedUrls.length) {
      errors.push(
        `餐饮数字员工输出包含未在本次输入或联网证据快照中的URL，禁止补造来源：${[
          ...new Set(unverifiedUrls),
        ]
          .slice(0, 5)
          .join("、")}`,
      );
    }
    if (
      allowedUrls.size === 0 &&
      PUBLIC_SOURCE_ASSERTION_PATTERN.test(normalizedText)
    ) {
      errors.push(
        "餐饮数字员工在没有已验证来源快照时声称公开、官方或平台事实，禁止补造来源。",
      );
    }
  }

  const uniqueErrors = [...new Set(errors)];
  return {
    valid: uniqueErrors.length === 0,
    errors: uniqueErrors,
    provider: {
      mode: normalizedMode || null,
      model: normalizedModel || null,
      usage: { inputTokens, outputTokens },
    },
  };
}

function validateRuntimeWebSources(parsed, taskInput, errors) {
  const allowed = normalizedAllowedWebSources(taskInput?.allowedSources);
  const requireWebSources = taskInput?.requireWebSources === true;
  if (!allowed.length) {
    if (requireWebSources && taskInput?.allowResearchWarning === true) {
      // demo 可以在调研工具超时后交付一份明确标注缺口的真实模型
      // 报告，但不能借此捏造任何公开URL或官方/平台来源。
      const outputUrls = collectTextFields(parsed).flatMap((item) =>
        extractRuntimeSourceUrls(item.value),
      );
      if (outputUrls.length) {
        errors.push(
          `本次联网调研没有权威允许来源快照，输出却包含URL，禁止补造来源：${[
            ...new Set(outputUrls),
          ]
            .slice(0, 5)
            .join("、")}`,
        );
      }
      for (const [index, source] of (
        parsed.decision_context?.sources || []
      ).entries()) {
        const sourceName = String(source?.source || "").trim();
        if (PUBLIC_SOURCE_WORD_PATTERN.test(sourceName)) {
          errors.push(
            `字段“$.decision_context.sources[${index}].source”在无已验证联网快照时声称公开/官方来源，禁止补造来源。`,
          );
        }
      }
      return;
    }
    if (requireWebSources)
      errors.push(
        "本次联网任务没有权威允许来源快照，禁止把模型自述来源当作真实检索证据。",
      );
    return;
  }
  const allowedUrls = new Set(allowed.map((item) => item.url));
  const textFields = collectTextFields(parsed);
  for (const item of textFields) {
    for (const url of extractRuntimeSourceUrls(item.value, allowed)) {
      if (!allowedUrls.has(url)) {
        errors.push(
          `字段“${item.path}”包含不在本次联网证据快照中的URL，禁止补造或改写来源：${url}`,
        );
      }
    }
  }

  let matched = 0;
  for (const [index, source] of (
    parsed.decision_context?.sources || []
  ).entries()) {
    const sourceName = String(source?.source || "").trim();
    const sourceUrls = extractRuntimeSourceUrls(sourceName, allowed);
    const exact = allowed.find(
      (item) =>
        sourceUrls.includes(item.url) &&
        normalizedAnchor(sourceName).includes(normalizedAnchor(item.title)),
    );
    if (exact) {
      matched += 1;
      continue;
    }
    if (sourceUrls.length || PUBLIC_SOURCE_WORD_PATTERN.test(sourceName)) {
      errors.push(
        `字段“$.decision_context.sources[${index}].source”不是本次已验证联网来源的“原始标题｜完整URL”，禁止补造来源。`,
      );
    }
  }
  if (requireWebSources && matched === 0) {
    errors.push(
      "联网任务至少必须在decision_context.sources中逐字引用1条本次已验证来源的原始标题和完整URL。",
    );
  }
  validateRuntimeSourcePeriods(parsed, taskInput?.allowedSources, errors);
}

function validateRuntimeSemantics(parsed, contract, taskInput, errors) {
  const task = normalizedTask(taskInput);
  const textFields = collectTextFields(parsed);
  for (const field of textFields) {
    for (const arithmeticError of validateRestaurantArithmeticExpressions(
      field.value,
      field.path,
    )) {
      errors.push(`字段“${field.path}”${arithmeticError.message}`);
    }
  }
  const placeholders = textFields.filter((item) =>
    RUNTIME_PLACEHOLDER_PATTERN.test(item.value),
  );
  if (placeholders.length) {
    errors.push(
      `运行时产出包含模板占位文本：${placeholders
        .slice(0, 5)
        .map((item) => item.path)
        .join("、")}。`,
    );
  }
  if (sameJsonValue(parsed, contract.schemaExample)) {
    errors.push("运行时产出不得原样返回岗位Schema示例。");
  }
  if (taskInput?.requireWebSources === true) {
    const deflections = textFields.filter((item) =>
      PUBLIC_RESEARCH_DEFLECTION_PATTERN.test(item.value),
    );
    if (deflections.length) {
      errors.push(
        `联网岗位把公开资料检索责任退回给老板，或用底稿/能力清单冒充业务结果：${deflections
          .slice(0, 5)
          .map((item) => item.path)
          .join(
            "、",
          )}。地址、竞品、菜单、价格、营业状态、公开评价等必须由岗位工具自行核验后形成结论。`,
      );
    }
  }

  if (task.title) {
    const taskTitle = normalizedAnchor(task.title);
    const problem = normalizedAnchor(parsed.decision_context?.problem);
    if (taskTitle.length >= 2 && !problem.includes(taskTitle)) {
      errors.push(
        "字段“$.decision_context.problem”必须明确写出本次任务标题，禁止返回与本次派活无关的通用稿。",
      );
    }
  }
  const suppliedEvidenceIds = [
    ...new Set(
      String(task.requirement || "").match(
        /\b(?:E-\d+-\d+|(?:FIN|PO|POS|CS|HR|SAFE|MKT|OPS)-[A-Z0-9-]+)\b/gu,
      ) || [],
    ),
  ];
  if (suppliedEvidenceIds.length) {
    const serialized = JSON.stringify(parsed);
    if (!suppliedEvidenceIds.some((id) => serialized.includes(id))) {
      errors.push(
        "产出未引用本次任务提供的任何证据编号，不能证明结论来自已知材料。",
      );
    }
  }

  const context = parsed.decision_context || {};
  const allowedCanonicalSources = normalizedAllowedWebSources(
    taskInput?.allowedSources,
  ).map((item) => `${item.title}｜${item.url}`);
  validateRuntimeWebSources(parsed, taskInput, errors);
  validateUniqueArray(
    context.sources || [],
    "$.decision_context.sources",
    errors,
  );
  validateUniqueArray(
    context.assumptions || [],
    "$.decision_context.assumptions",
    errors,
  );
  for (const [index, source] of (context.sources || []).entries()) {
    const sourceName = String(source.source || "").trim();
    if (
      sourceName.length < 6 ||
      !SOURCE_ANCHOR_PATTERN.test(sourceName) ||
      GENERIC_SOURCE_PATTERN.test(sourceName)
    ) {
      errors.push(
        `字段“$.decision_context.sources[${index}].source”必须写明可追溯的材料或系统来源。`,
      );
    }
    if (String(source.fact || "").trim().length < 12) {
      errors.push(
        `字段“$.decision_context.sources[${index}].fact”必须是可复核事实或具体证据缺口。`,
      );
    }
  }
  for (const [index, assumption] of (context.assumptions || []).entries()) {
    const problems = assumptionSemanticProblems(assumption, task);
    if (problems.length) {
      errors.push(
        `字段“$.decision_context.assumptions[${index}]”不合格：${problems.join("、")}。必须包含具体假设、影响、核验动作、岗位责任角色和明确时限。`,
      );
    }
  }

  validateInputAndMethodTrace(
    parsed,
    contract,
    task,
    errors,
    allowedCanonicalSources,
  );

  let verifiedWorkProductCount = 0;
  for (const key of contract.deliverableKeys) {
    const item = parsed.deliverables?.[key];
    if (!item) continue;
    const base = `$.deliverables.${key}`;
    if (
      String(item.summary || "").trim().length < 24 ||
      !anchorsDeliverable(item.summary, item.deliverable_name)
    ) {
      errors.push(
        `字段“${base}.summary”必须围绕本岗位交付物写出具体结论，不能使用空泛复读。`,
      );
    }
    validateUniqueArray(item.evidence || [], `${base}.evidence`, errors);
    validateUniqueArray(item.actions || [], `${base}.actions`, errors);
    validateUniqueArray(
      item.acceptance_checks || [],
      `${base}.acceptance_checks`,
      errors,
    );
    const workProductAudit = validateWorkProduct(
      item,
      contract.workProductRequirements[key],
      context.sources || [],
      base,
      errors,
      allowedCanonicalSources,
    );
    verifiedWorkProductCount += workProductAudit.verifiedCount;
    const evidenceText = (item.evidence || [])
      .map((entry) => `${entry.source} ${entry.finding}`)
      .join(" ");
    const actionText = (item.actions || [])
      .map((entry) => `${entry.action} ${entry.success_metric}`)
      .join(" ");
    if (
      !anchorsDeliverable(
        `${evidenceText} ${actionText}`,
        item.deliverable_name,
      )
    ) {
      errors.push(
        `字段“${base}”必须用证据或动作锚定交付物“${item.deliverable_name}”。`,
      );
    }
    for (const [index, evidence] of (item.evidence || []).entries()) {
      if (
        String(evidence.source || "").trim().length < 6 ||
        !SOURCE_ANCHOR_PATTERN.test(String(evidence.source || "")) ||
        String(evidence.finding || "").trim().length < 14
      ) {
        errors.push(
          `字段“${base}.evidence[${index}]”必须写明可追溯来源和具体发现或证据缺口。`,
        );
      }
    }
    for (const [index, action] of (item.actions || []).entries()) {
      const problems = actionSemanticProblems(
        action,
        task,
        item.deliverable_name,
      );
      if (problems.length) {
        errors.push(
          `字段“${base}.actions[${index}]”不合格：${problems.join("、")}。必须包含具体动作、责任角色、明确时限和可复核指标。`,
        );
      }
    }
    for (const [index, acceptance] of (
      item.acceptance_checks || []
    ).entries()) {
      if (String(acceptance.evidence || "").trim().length < 14) {
        errors.push(
          `字段“${base}.acceptance_checks[${index}].evidence”必须记录具体证据或补证进度。`,
        );
      }
      const criterion = String(acceptance.criterion || "").trim();
      const acceptanceEvidence = String(acceptance.evidence || "").trim();
      const contradictions = reviewPassContradictions(
        acceptanceEvidence,
        criterion,
      );
      if (
        acceptance.result === "pass" &&
        contradictions.length > 0 &&
        !criterionChecksGapDisclosure(criterion)
      ) {
        errors.push(
          `字段“${base}.acceptance_checks[${index}]”把未满足或待补证的实质标准标成pass（证据仍含：${contradictions.join("、")}）；应改为needs_review/blocked，或提供真正满足该标准的证据。`,
        );
      }
      if (
        acceptance.result === "pass" &&
        acceptanceIsTechnicalOnly(acceptance)
      ) {
        errors.push(
          `字段“${base}.acceptance_checks[${index}]”只通过JSON/字段/格式等技术检查，不能冒充业务交付验收。`,
        );
      }
    }
    if (
      MATERIAL_GAP_PATTERN.test(`${item.summary} ${evidenceText}`) &&
      !(item.actions || []).some(
        (action) =>
          VERIFICATION_ACTION_PATTERN.test(String(action.action || "")) &&
          String(action.action || "").includes(item.deliverable_name) &&
          actionSemanticProblems(action, task, item.deliverable_name).length ===
            0,
      )
    ) {
      errors.push(
        `字段“${base}”披露材料缺口时，至少一条action必须原样含deliverable_name，并包含补证动词、具体owner、明确deadline和可复核metric。`,
      );
    }
    if (
      !EVIDENCE_CENTRIC_DELIVERABLE_PATTERN.test(item.deliverable_name) &&
      (item.actions || []).every(
        (action) =>
          MATERIAL_ONLY_ACTION_PATTERN.test(String(action.action || "")) &&
          !CORE_DELIVERY_ACTION_PATTERN.test(String(action.action || "")),
      )
    ) {
      errors.push(
        `字段“${base}.actions”不能全部只是收集或补齐材料；至少一条必须实际生产本交付物正文。`,
      );
    }
    if (
      !(item.acceptance_checks || []).some(
        (checkItem) =>
          checkItem.result === "pass" && !acceptanceIsTechnicalOnly(checkItem),
      )
    ) {
      errors.push(
        `字段“${base}.acceptance_checks”至少一项必须有证据地通过；全待审或全阻断的底稿不能冒充已交付。`,
      );
    }
  }
  // Paihuo accepts an honest, source-backed gap register as part of a useful
  // delivery. Do not fail the entire task merely because one deliverable has
  // no supportable verified fact. The whole output must still contain at
  // least one verified business result, so an evidence-free draft cannot pass.
  if (verifiedWorkProductCount === 0) {
    errors.push(
      "所有岗位交付物均为补材料、未来动作或未核验项；整份产出至少需要1项verified实际结果。",
    );
  }
  const qualityChecks = Object.values(parsed.quality_review?.checks || {});
  for (const [key, qualityCheck] of Object.entries(
    parsed.quality_review?.checks || {},
  )) {
    const criterion = String(qualityCheck?.criterion || "").trim();
    const qualityEvidence = String(qualityCheck?.evidence || "").trim();
    const contradictions = reviewPassContradictions(qualityEvidence, criterion);
    if (
      qualityCheck?.status === "pass" &&
      contradictions.length > 0 &&
      !criterionChecksGapDisclosure(criterion)
    ) {
      errors.push(
        `字段“$.quality_review.checks.${key}”把未满足或待补证的质量门标成pass（证据仍含：${contradictions.join("、")}）；应改为needs_review/blocked，或提供真正满足该质量门的证据。`,
      );
    }
    if (
      qualityCheck?.status === "pass" &&
      !evidenceAnchorsCriterion(qualityEvidence, criterion)
    ) {
      errors.push(
        `字段“$.quality_review.checks.${key}”的pass证据没有锚定criterion关键业务词，不能用机器/技术检查凑pass。`,
      );
    }
  }
  if (
    parsed.quality_review?.overall_status !== "pass" ||
    !qualityChecks.some((checkItem) => checkItem?.status === "pass")
  ) {
    errors.push(
      "岗位质量门必须至少有一项基于证据通过且overall_status=pass；全pending/needs_review不能作为质量合格产物。",
    );
  }

  const approvalNote = String(parsed.approval?.review_note || "");
  if (hasUnapprovedBusinessReadyClaim(approvalNote)) {
    errors.push(
      "字段“$.approval.review_note”不得预先声称流程已采纳、已上线或已执行；内部采用状态必须由质量门、账务门与任务快照策略共同决定。",
    );
  }
  const allReviewText = [
    parsed.quality_review?.review_note,
    ...contract.deliverableKeys.flatMap((key) =>
      (parsed.deliverables?.[key]?.acceptance_checks || []).map(
        (check) => check.evidence,
      ),
    ),
  ];
  if (
    allReviewText.some(
      (value) =>
        TECHNICAL_ACCEPTANCE_PATTERN.test(String(value || "")) &&
        hasUnapprovedBusinessReadyClaim(value),
    )
  ) {
    errors.push(
      "机器契约、JSON结构或技术校验通过不等于任务流程已完成采用，更不代表外部动作已获授权。",
    );
  }
}

function parseOutput(rawOutput) {
  if (isPlainObject(rawOutput))
    return { parsed: structuredClone(rawOutput), error: null };
  if (typeof rawOutput !== "string") {
    return {
      parsed: null,
      error: "输出必须是JSON对象或包含单个JSON对象的字符串。",
    };
  }
  if (!rawOutput.trim())
    return { parsed: null, error: "输出为空，无法通过岗位契约。" };
  try {
    return { parsed: JSON.parse(rawOutput), error: null };
  } catch (error) {
    return { parsed: null, error: `输出不是有效JSON：${error.message}` };
  }
}

// 岗位契约分成两层：结构与来源安全属于不可绕过的硬门；正文覆盖度、措辞、
// 指标和验收完整度属于质量建议。生产派活使用 advisory 模式时，只要模型返回
// 可解析且结构完整、没有伪造来源或越权声明的真实结果，就保存交付；质量问题
// 随结果展示给用户，不再把整单判为失败。直接调用 validator 默认仍保持 strict，
// 便于审计与历史测试继续验证完整岗位规范。
function isHardRuntimeContractError(value, taskContext = {}) {
  const error = String(value || "");
  return [
    /运行时产出包含模板占位文本/u,
    /运行时产出不得原样返回岗位Schema示例/u,
    /联网岗位把公开资料检索责任退回给老板/u,
    /decision_context\.problem.*必须明确写出本次任务标题/u,
    // 输入审计与方法执行是岗位交付的可追溯骨架：责任人、核验动作、时限和
    // 证据回指缺任何一项，老板都无法据此追责。这些必须继续驱动定向返工，
    // advisory 只放行更外围的表述类建议，否则模型会稳定停在“看着完整但
    // 无法执行”的产出上（回归用例 #44 与 demo#47 锁定该行为）。
    /\$\.input_audit/u,
    /\$\.method_execution/u,
    /输入审计.*复制/u,
    /方法执行.*复制/u,
    /(?:算术表达不一致|金额单位换算不一致)/u,
    ...(taskContext?.allowResearchWarning === true
      ? []
      : [/本次联网任务没有权威允许来源快照/u]),
    /包含不在本次联网证据快照中的URL/u,
    /不是本次已验证联网来源/u,
    /必须等于权威采集日期/u,
    /无已验证联网快照时声称公开\/官方来源/u,
    ...(taskContext?.allowResearchWarning === true
      ? []
      : [/联网任务至少必须在decision_context\.sources中逐字引用/u]),
    /approval\.review_note.*不得预先声称/u,
    /机器契约、JSON结构或技术校验通过不等于任务流程已完成采用/u,
  ].some((pattern) => pattern.test(error));
}

// 契约分级映射层（P0-1）：不改规则本体，只决定某条运行时校验消息在指定档位下是
// 硬门（error）还是可见警告（warning）。
// - strict：全部硬门（等同历史 live 行为）；
// - lenient：与既有 demo advisory 完全一致（isHardRuntimeContractError 命中即硬门）；
// - standard：lenient 硬门 + “完整度”类规则升回硬门；数值阈值/可追溯/措辞类仍为警告。
// 安全、来源真实性、越权声明、结构与算术在任何档位都不会被降级。
const RESEARCH_WARNING_RELAXED_PATTERNS = Object.freeze([
  /本次联网任务没有权威允许来源快照/u,
  /联网任务至少必须在decision_context\.sources中逐字引用/u,
]);

export function severityFor(rule, tier, taskContext = {}) {
  const normalized = normalizeContractTier(tier);
  if (normalized === "strict") return "error";
  if (isHardRuntimeContractError(rule, taskContext)) return "error";
  // demo 调研工具超时（allowResearchWarning）时，这两条来源规则按既有 advisory
  // 口径放行为警告；补造 URL/伪称官方来源等其余来源规则仍是硬门。
  if (
    taskContext?.allowResearchWarning === true &&
    RESEARCH_WARNING_RELAXED_PATTERNS.some((pattern) => pattern.test(String(rule || "")))
  ) {
    return "warning";
  }
  return ruleCategoryIsHard(classifyContractRule(rule), normalized)
    ? "error"
    : "warning";
}

// 调用方可以显式传 contractTier；未传时沿用旧的 qualityMode 二值语义，
// 保证历史调用与既有测试行为不变。
function resolveValidationTier(taskContext = {}) {
  if (taskContext?.contractTier) {
    return normalizeContractTier(taskContext.contractTier);
  }
  return taskContext?.qualityMode === "advisory" ? "lenient" : "strict";
}

function safeFilenamePart(value) {
  return (
    String(value)
      .replace(/[^a-zA-Z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "employee"
  );
}

function buildArtifact(contract, parsed) {
  const content = JSON.stringify(parsed, null, 2);
  const digest = sha256(content).slice(0, 12);
  return {
    kind: contract.primaryArtifact,
    primary: true,
    filename: `${safeFilenamePart(contract.primaryArtifact)}-${digest}.json`,
    mediaType: "application/json",
    content,
    employeeIdx: contract.employeeIdx,
    employeeKey: contract.employeeKey,
    contractId: contract.contractId,
    schemaVersion: contract.schemaVersion,
  };
}

export function validateRestaurantEmployeeOutputContract(
  idx,
  rawOutput,
  taskContext = {},
) {
  const contract = contractFor(idx);
  const contractTier = resolveValidationTier(taskContext);
  const { parsed, error } = parseOutput(rawOutput);
  const errors = error ? [error] : [];
  let warnings = [];
  if (!error) {
    if (!isPlainObject(parsed)) {
      errors.push("输出顶层必须是JSON对象，不能是数组、null或其他JSON值。");
    } else {
      validateSchemaValue(parsed, contract.schema, "$", errors);
      if (!errors.length) {
        const runtimeErrors = [];
        validateRuntimeSemantics(parsed, contract, taskContext, runtimeErrors);
        if (contractTier !== "strict") {
          for (const runtimeError of runtimeErrors) {
            if (severityFor(runtimeError, contractTier, taskContext) === "error") {
              errors.push(runtimeError);
            } else {
              warnings.push(runtimeError);
            }
          }
        } else {
          errors.push(...runtimeErrors);
        }
      }
    }
  }

  if (errors.length) {
    return {
      valid: false,
      parsed,
      errors,
      warnings,
      contractTier,
      artifacts: [],
    };
  }

  return {
    valid: true,
    parsed,
    errors: [],
    warnings,
    // qualityMode 保留二值语义供旧调用方与审计快照使用；档位细节由 contractTier 表达。
    qualityMode: contractTier === "strict" ? "strict" : "advisory",
    contractTier,
    artifacts: [buildArtifact(contract, parsed)],
  };
}

export function inspectRestaurantOutputAudit({
  employeeProfileVersion,
  aiMode,
  executionEvidence,
  employeeIdx,
  taskTitle,
  taskRequirement,
  outputBody,
} = {}) {
  if (!employeeProfileVersion)
    return { applicable: false, valid: true, audit: null, error: null };
  if (aiMode !== "api") {
    return {
      applicable: true,
      valid: false,
      audit: null,
      error:
        "模板模式仅生成未完成底稿，不能采纳；请恢复AI通道并按岗位机器输出契约重新执行",
    };
  }
  let evidence = executionEvidence;
  if (typeof evidence === "string") {
    try {
      evidence = JSON.parse(evidence || "null");
    } catch {
      return {
        applicable: true,
        valid: false,
        audit: null,
        error: "岗位输出契约审计证据损坏，拒绝采纳",
      };
    }
  }
  const audit =
    evidence?.kind === "restaurant_employee_execution_evidence"
      ? evidence.outputContract
      : null;
  const artifact =
    Array.isArray(audit?.artifacts) && audit.artifacts.length === 1
      ? audit.artifacts[0]
      : null;
  const resolvedEmployeeIdx = Number(
    employeeIdx ?? audit?.parsedOutput?.role?.employee_idx,
  );
  const runtimeValidation =
    Number.isInteger(resolvedEmployeeIdx) && audit?.parsedOutput
      ? validateRestaurantEmployeeOutputContract(
          resolvedEmployeeIdx,
          audit.parsedOutput,
          {
            task: { title: taskTitle, requirement: taskRequirement },
            qualityMode:
              audit?.qualityMode === "advisory" ? "advisory" : "strict",
            // 生成时按 standard 放行的警告项，复核时必须按同一档位解释，
            // 否则 live 员工级模型的合格产出会在采纳门被误判为契约失败。
            ...(audit?.contractTier
              ? { contractTier: audit.contractTier }
              : {}),
          },
        )
      : {
          valid: false,
          artifacts: [],
          errors: ["缺少可复核的结构化运行时产出"],
        };
  const validatedArtifact = runtimeValidation.artifacts?.[0] || null;
  const validatedArtifactSha256 =
    typeof validatedArtifact?.content === "string"
      ? sha256(validatedArtifact.content)
      : null;
  const renderedBodySha256 =
    typeof outputBody === "string" ? sha256(outputBody) : null;
  const complete =
    audit?.valid === true &&
    typeof audit.contractId === "string" &&
    audit.contractId.trim() &&
    typeof audit.schemaVersion === "string" &&
    audit.schemaVersion.trim() &&
    typeof audit.primaryArtifact === "string" &&
    audit.primaryArtifact.trim() &&
    artifact?.primary === true &&
    artifact.kind === audit.primaryArtifact &&
    artifact.contractId === audit.contractId &&
    artifact.schemaVersion === audit.schemaVersion &&
    /^[a-f0-9]{64}$/u.test(String(artifact.contentSha256 || "")) &&
    runtimeValidation.valid === true &&
    artifact.contentSha256 === validatedArtifactSha256 &&
    audit.providerResponseSha256 === validatedArtifactSha256 &&
    /^[a-f0-9]{64}$/u.test(String(audit.renderedBodySha256 || "")) &&
    renderedBodySha256 === audit.renderedBodySha256;
  return complete
    ? { applicable: true, valid: true, audit, runtimeValidation, error: null }
    : {
        applicable: true,
        valid: false,
        audit,
        runtimeValidation,
        error:
          runtimeValidation.valid === false
            ? `岗位输出未通过运行时语义契约：${runtimeValidation.errors.slice(0, 5).join("；")}`
            : "岗位输出缺少完整且有效的机器契约审计证据，拒绝采纳",
      };
}

export function assertRestaurantOutputAdoptable(options = {}) {
  const result = inspectRestaurantOutputAudit(options);
  if (!result.valid) {
    throw Object.assign(new Error(result.error), {
      code: "RESTAURANT_OUTPUT_NOT_ADOPTABLE",
      status: 409,
    });
  }
  return result;
}

function markdownTable(rows) {
  return [
    "| 项目 | 内容 |",
    "| --- | --- |",
    ...rows.map(
      ([label, value]) =>
        `| ${String(label).replaceAll("|", "\\|")} | ${String(value).replaceAll("|", "\\|")} |`,
    ),
  ].join("\n");
}

function markdownSource(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(.+?)｜(https?:\/\/\S+)$/u);
  if (!match) return text;
  const title = match[1].trim().replace(/[\[\]]/gu, "");
  const url = cleanOutputUrl(match[2]);
  return url ? `[${title}](${url})` : title;
}

function markdownWorkProductTable(items) {
  const escape = (value) =>
    String(value).replaceAll("|", "\\|").replace(/\r?\n/gu, "<br>");
  const statusLabel = Object.freeze({
    verified: "已核验",
    assumption: "待验证假设",
    gap: "证据缺口",
  });
  return [
    "| 条目 | 实际正文 | 状态 | 证据回指 |",
    "| --- | --- | --- | --- |",
    ...items.map(
      (item) =>
        `| ${escape(item.label)} | ${escape(item.result)} | ${escape(statusLabel[item.status] || "需处理")} | ${escape(markdownSource(item.evidence_ref))} |`,
    ),
  ].join("\n");
}

/**
 * 将已通过契约校验的结构化产出渲染为审批页可读 Markdown。
 * 本函数不补字段、不修复非法输出；调用前必须使用同一 validator 验收。
 */
export function renderRestaurantOutputMarkdown(
  idx,
  parsedOutput,
  taskContext = {},
) {
  const validated = validateRestaurantEmployeeOutputContract(
    idx,
    parsedOutput,
    taskContext,
  );
  if (!validated.valid) {
    throw Object.assign(
      new Error(`餐饮岗位输出契约校验失败：${validated.errors.join("；")}`),
      {
        code: "RESTAURANT_OUTPUT_CONTRACT_INVALID",
        status: 422,
        contractErrors: validated.errors,
      },
    );
  }
  const output = validated.parsed;
  return renderRestaurantOutputForExport(
    output,
    {
      title: String(taskContext?.task?.title || taskContext?.taskTitle || ""),
      requirement: String(taskContext?.task?.requirement || ""),
    },
  );
  /* c8 ignore start -- unreachable legacy renderer retained for transition diffing */
  const artifactTypeLabel = Object.freeze({
    structured_table: "结构化表格",
    decision_card: "决策卡",
    calculation_model: "测算模型",
    execution_plan: "执行方案",
    structured_document: "结构化文档",
    visual_model: "可视化模型",
  });
  const reviewStatusLabel = Object.freeze({
    pass: "机器检查已满足",
    needs_review: "需要人工确认",
    blocked: "已阻断",
    pending_human_review: "待人工审阅",
    compliant: "机器检查符合边界",
  });
  const reportTitle = `${output.role.role_title}报告`;
  const nextActions = contract.deliverableKeys
    .flatMap((key) => output.deliverables[key]?.actions || [])
    .slice(0, 5);
  const executiveSummaries = contract.deliverableKeys
    .map((key) => output.deliverables[key])
    .filter(Boolean);
  const riskItems = [
    ...(output.decision_context.assumptions || []).map(
      (item) => `${item.assumption}｜影响：${item.impact}`,
    ),
    ...Object.values(output.input_audit || {})
      .filter((item) => item.status !== "supplied")
      .map((item) => `${item.finding}｜影响：${item.impact}`),
    ...contract.deliverableKeys.flatMap((key) =>
      (output.deliverables[key]?.work_product?.sections || []).flatMap(
        (section) =>
          (section.items || [])
            .filter((item) => item.status === "gap")
            .map((item) => `${item.label}：${item.result}`),
      ),
    ),
  ].slice(0, 6);
  const inputStatusLabel = Object.freeze({
    supplied: "已取得",
    assumption: "按假设推进",
    missing: "存在缺口",
  });
  const methodStatusLabel = Object.freeze({
    completed: "已完成",
    partial: "部分完成",
    blocked: "受阻",
  });
  const markdownSourceList = (refs) =>
    (refs || []).map(markdownSource).join("、");
  const sections = [
    `# ${reportTitle}`,
    "",
    `> ${output.role.role_title} · 老板决策版`,
    "",
    "## 老板结论",
    ...executiveSummaries.map(
      (item) => `- **${item.deliverable_name}**：${item.summary}`,
    ),
    "",
    "## 关键证据",
    ...output.decision_context.sources.map(
      (entry) =>
        `- **${markdownSource(entry.source)}**（${entry.period}）：${entry.fact}`,
    ),
    "",
    "## 风险与缺口",
    ...(riskItems.length
      ? riskItems.map((item) => `- ${item}`)
      : ["- 本轮没有发现阻断当前内部判断的新增缺口；易变事实仍按下方核验计划复查。"]),
    "",
    "## 下一步",
    ...nextActions.map(
      (entry, index) =>
        `${index + 1}. ${entry.action}（负责人：${entry.owner}；截止：${entry.deadline}；完成标准：${entry.success_metric}）`,
    ),
    "",
    "## 任务范围",
    markdownTable([
      ["任务", output.decision_context.problem],
      ["期间", output.decision_context.period],
      ["范围", output.decision_context.scope],
    ]),
    "",
    "### 关键假设",
    ...output.decision_context.assumptions.map(
      (entry) =>
        `- ${entry.assumption}｜影响：${entry.impact}｜核验：${entry.verification}`,
    ),
    "",
    "## 岗位执行完整性",
    "",
    "### 输入完整性",
    "| 编号 | 覆盖状态 | 本轮业务结果 | 影响与核验 | 证据 |",
    "| --- | --- | --- | --- | --- |",
    ...contract.inputKeys.map((key, index) => {
      const item = output.input_audit[key];
      const verification = item.verification || {};
      return `| 输入${index + 1} | ${inputStatusLabel[item.status] || "需处理"} | ${String(item.finding).replaceAll("|", "\\|")} | ${String(`${item.impact}；${verification.owner}${verification.deadline}${verification.action}`).replaceAll("|", "\\|")} | ${markdownSourceList(item.evidence_refs).replaceAll("|", "\\|")} |`;
    }),
    "",
    "### 方法执行记录",
    "| 编号 | 执行状态 | 本轮业务结果 | 缺口与下一步 | 证据 |",
    "| --- | --- | --- | --- | --- |",
    ...contract.methodKeys.map((key, index) => {
      const item = output.method_execution[key];
      return `| 步骤${index + 1} | ${methodStatusLabel[item.status] || "需处理"} | ${String(item.actual_execution).replaceAll("|", "\\|")} | ${String(`${item.missing}；${item.next_action}`).replaceAll("|", "\\|")} | ${markdownSourceList(item.evidence_refs).replaceAll("|", "\\|")} |`;
    }),
    "",
    "## 岗位完整成果",
  ];

  for (const key of contract.deliverableKeys) {
    const item = output.deliverables[key];
    sections.push(
      "",
      `## ${item.deliverable_name}`,
      "",
      item.summary,
      "",
      `### 报告正文（${artifactTypeLabel[item.work_product.artifact_type] || "业务成品"}）`,
      ...item.work_product.sections.flatMap((section) => [
        "",
        `#### ${section.section_name}`,
        markdownWorkProductTable(section.items),
      ]),
      "",
      "### 证据",
      ...item.evidence.map(
        (entry) =>
          `- **${markdownSource(entry.source)}**（${entry.period}）：${entry.finding}`,
      ),
      "",
      "### 动作",
      ...item.actions.map(
        (entry) =>
          `- ${entry.action}｜负责人：${entry.owner}｜截止：${entry.deadline}｜检查标准：${entry.success_metric}`,
      ),
      "",
      "### 验收",
      ...item.acceptance_checks.map(
        (entry) =>
          `- [${entry.result === "pass" ? "x" : " "}] ${entry.criterion}：${entry.evidence}`,
      ),
    );
  }

  sections.push(
    "",
    "## 附录：质量、安全与授权",
    "",
    "### 质量复核",
    `- 机器质检结论：${reviewStatusLabel[output.quality_review.overall_status] || "需要人工确认"}`,
    ...Object.values(output.quality_review.checks).map(
      (entry) =>
        `- **${entry.criterion}**｜${reviewStatusLabel[entry.status] || "需处理"}｜${entry.evidence}`,
    ),
    `- 复核说明：${output.quality_review.review_note}`,
    "",
    "",
    "### 安全边界",
    `- 机器边界检查：${reviewStatusLabel[output.safety_review.overall_status] || "需要人工确认"}`,
    ...Object.values(output.safety_review.checks).map(
      (entry) =>
        `- **${entry.boundary}**｜${reviewStatusLabel[entry.status] || "需处理"}｜${entry.handling}`,
    ),
    `- 升级说明：${output.safety_review.escalation_note}`,
    "",
    "",
    "### 采用与执行边界",
    "- 外部动作、真实付费与不可逆操作仍须另行取得老板执行授权。",
    "- 内部采用：质量门与账务门通过后按任务快照策略处理（平台当前默认自动采用）",
    `- 策略来源：${output.approval.reviewer_roles.join("、")}`,
    `- 外部动作授权：${output.approval.external_action_allowed ? "本次已授权" : "本次未授权（如需执行须另行授权）"}`,
    `- 财务或监管承诺授权：${output.approval.financial_or_regulatory_commitment_allowed ? "本次已授权" : "本次未授权（须由有权限人员另行审批）"}`,
    `- 策略说明：${output.approval.review_note}`,
  );
  return sections.join("\n");
  /* c8 ignore stop */
}

export const RESTAURANT_OUTPUT_SCHEMA_VERSION = SCHEMA_VERSION;

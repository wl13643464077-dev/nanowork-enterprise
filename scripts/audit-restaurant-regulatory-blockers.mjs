#!/usr/bin/env node

/**
 * Read-only classification of the restaurant jobs whose business execution
 * remains blocked by current regulation or private-scope evidence.  It does
 * not alter validators and never treats synthetic QA facts as legal evidence.
 */
import fs from "node:fs";
import path from "node:path";
import { loadRestaurantCatalog } from "../server/src/catalog/restaurant.js";
import {
  buildRestaurantDispatch,
  buildRestaurantRequiredInputEvidence,
} from "./lib/real-employee-matrix.mjs";
import { restaurantInputFactSpecs } from "./lib/restaurant-required-input-facts.mjs";

const OUT_DEFAULT = path.resolve(
  "artifacts/real-matrix-runtime/restaurant-regulatory-blocker-classification-2026-08-08.json",
);
const REGULATION_REQUIRED_FIELDS = Object.freeze([
  "验收司法辖区",
  "核验日期",
  "法规名称",
  "文号条款",
  "要求原文",
  "官方链接",
  "适用范围",
  "结论状态",
  "人工法务确认",
  "QA能力验收资格",
  "业务执行资格",
  "阻塞原因",
]);

const BLOCKER_GAPS = Object.freeze({
  BLOCKED_LOCAL_RULE_CONFIRMATION: "当地适用规则、版本/生效日与负责人确认记录",
  BLOCKED_PRODUCT_VALIDATION: "产品形态与温控/保存/冷却/复热/报废验证批次及结果",
  BLOCKED_FOOD_FORM_AND_LABEL_FORMAT: "食品形态、目标显示格式、法定单位与标签适用范围",
  BLOCKED_PRIVATE_NUTRITION_BASIS: "当前配方对应的营养数据库/供应商声明/实验室报告及版本",
  BLOCKED_LOCAL_ALLERGEN_DUTY: "属地受监管过敏原清单、食品形态与销售渠道义务",
  BLOCKED_PRIVATE_ALLERGEN_MATRIX: "门店菜品—复合配料—交叉接触—批次矩阵与批准记录",
  BLOCKED_PRIVATE_SOP_AND_INSPECTION_RECORDS: "现行门店SOP、检查、维修校准、投诉、检测和监管问题原始记录",
  BLOCKED_LICENSE_CONTRACT_CERTIFICATION_SCOPE: "许可证、客户合同、认证范围及授权/适用边界",
  BLOCKED_FOOD_CATEGORY_AND_CONSUMER_SCOPE: "食品分类、目标消费者和适用官方限值的属地确认",
  BLOCKED_LOCAL_LIMITS: "当地时间温度限值、适用产品类别和官方生效版本",
  BLOCKED_LOCAL_EMPLOYEE_RULES: "当地员工健康/传染病/劳动/隐私规则及监管联系方式",
  BLOCKED_PRIVATE_HEALTH_PRIVACY_POLICY: "员工健康证明、返岗/病假规则及最小访问权限的企业政策记录",
  BLOCKED_LOCAL_PROCUREMENT_RULES: "当地采购、许可范围和各类原料法定要求",
  BLOCKED_LICENSE_AND_PRODUCT_SCOPE: "门店许可证范围与产品/原料类别对应关系",
  BLOCKED_LOCAL_REPORTING_CONTACT: "当地追溯/报告义务、监管联系人和报告时限",
  BLOCKED_PRIVATE_TRACEABILITY_RECORDS: "供应、收货、批次、生产、使用、去向及系统/纸质追溯原始记录",
  BLOCKED_LOCAL_AUDIT_CRITERIA: "当地迎检/审核准则及生效版本",
  BLOCKED_PRIVATE_LICENSE_SOP_CERTIFICATION: "企业许可证、SOP、HACCP/PRP、认证与培训原始记录",
  BLOCKED_LOCAL_ACCESSIBILITY_REFUND_RULES: "当地无障碍、服务费/小费/退款规则及适用版本",
  BLOCKED_PLATFORM_TERMS_VERSION: "目标平台当前条款、社区规范及版本快照",
  BLOCKED_PRIVATE_SERVICE_POLICY: "门店服务标准、退款/补救授权及私有审批记录",
  BLOCKED_LOCAL_CONSUMER_ACCESSIBILITY_RULES: "当地消费者、隐私、反歧视和无障碍规则",
  BLOCKED_PRIVATE_BOOKING_POLICY: "门店订座、押金、取消、最低消费和退款政策原始批准记录",
  BLOCKED_ROLE_QUALIFICATION_SCOPE: "岗位法定资格适用范围、覆盖任务与授权边界",
  BLOCKED_LOCAL_TRAINING_RULES: "当地培训/复训规则、机构及有效期",
  BLOCKED_PRIVATE_CERTIFICATES: "员工资格证、培训、考核和证书原始记录",
  BLOCKED_LOCAL_REPORTING_DUTY: "平台/消费者/隐私监管报告义务与时限",
  BLOCKED_PRIVATE_INCIDENT_AUTHORITY: "真实事件授权、已采取动作、升级/赔付/保险法务边界",
  BLOCKED_ASSET_CATALOG_CLASSIFICATION: "设备资产目录分类、型号用途和是否特种设备的确认",
  BLOCKED_LOCAL_INSPECTION_RULES: "当地设备检验、许可和复检规则",
  BLOCKED_PRIVATE_MANUFACTURER_ACCEPTANCE_RECORDS: "厂家手册、保修、安装验收和维修原始记录",
  BLOCKED_LOCAL_LANGUAGE_ACCESSIBILITY_RULES: "当地语言、可读性与无障碍要求",
  BLOCKED_MENU_MEDIUM_SCOPE: "目标菜单媒介、字符/展示限制和适用场景",
  BLOCKED_LOCAL_AD_PROMOTION_RULES: "当地广告、抽奖、促销和短信/邮件规则",
  BLOCKED_PRIVATE_CONSENT_APPROVAL_RECORDS: "顾客/合作方同意、审批及素材授权原始记录",
  BLOCKED_PRIVATE_CONTENT_AUTHORIZATIONS: "图片、视频、音乐、商标、肖像与UGC授权链",
  BLOCKED_LOCAL_PRICE_PROMOTION_RULES: "当地价格、广告、优惠券、抽奖和消费者规则",
  BLOCKED_PRIVATE_EXPERIMENT_BASELINE: "企业批准的实验基线、识别字段和历史活动数据",
  BLOCKED_LOCAL_LABOR_RULES: "当地工时、休息、加班及劳动规则",
  BLOCKED_COLLECTIVE_AGREEMENT: "集体协议/特殊工时批复及适用范围",
  BLOCKED_PRIVATE_TIME_APPROVAL_RECORDS: "实际打卡、休息、加班和审批原始记录",
  BLOCKED_LOCAL_REGULATION_DIFFERENCES: "各门店属地法规差异与生效版本",
  BLOCKED_PRIVATE_SOP_EXCEPTION_APPROVALS: "SOP例外、培训、巡店及管理层批准记录",
  BLOCKED_LOCAL_DONATION_WASTE_TRANSPORT_RULES: "当地捐赠/饲料/堆肥/废弃物运输规则",
  BLOCKED_PRIVATE_DISPOSAL_DESTINATION: "实际处置去向、承运商与交接凭证",
  BLOCKED_LOCAL_REPORTING_INSURANCE_RULES: "当地食安/召回/报告/责任保险规则",
  BLOCKED_PRIVATE_POLICY_PLAN_CONTACTS: "企业保险、应急预案、联系人与恢复授权原始记录",
});

function formatRequiredField(value) {
  if (Array.isArray(value)) return value.map(formatRequiredField).join("|");
  return String(value);
}

function inputFields(catalogEmployee) {
  const result = new Set();
  for (const [inputIndex, input] of catalogEmployee.inputs.entries()) {
    const specs = restaurantInputFactSpecs(input);
    for (const spec of specs) {
      if (spec.id === "regulation") continue;
      for (const field of spec.required) {
        result.add(`E-${catalogEmployee.idx}-${inputIndex + 1}:${spec.id}.${formatRequiredField(field)}`);
      }
    }
  }
  return [...result].sort();
}

function catalogProfile(employee) {
  return {
    identity: {
      idx: employee.idx,
      key: employee.key,
      name: employee.name,
      duty: employee.duty,
    },
    dispatch: {
      defaultTaskType: "执行方案",
      requiredInputs: [...employee.inputs],
      guidance: {
        taskExamples: [],
        deliverableChecklist: [...employee.deliverables],
      },
    },
  };
}

function realWorldBlockerCodes(dispatch) {
  const codes = new Set();
  for (const line of String(dispatch?.requirement || "").split("\n")) {
    const bodyAt = line.indexOf("正文=");
    if (bodyAt < 0) continue;
    let evidence;
    try {
      evidence = JSON.parse(line.slice(bodyAt + "正文=".length));
    } catch {
      continue;
    }
    const regulation = evidence?.fields?.facts?.regulation;
    for (const source of [
      evidence?.realWorldBlockers,
      regulation?.realWorldBlockers,
      regulation?.QA_ONLY_PROOF?.originalOperationalBlockers,
      evidence?.qaEvidence?.originalOperationalBlockers,
    ]) {
      if (!Array.isArray(source)) continue;
      for (const code of source) codes.add(String(code));
    }
  }
  if (!codes.size) {
    for (const reason of dispatch?.operationalBlockReasons || []) {
      const code = String(reason).split("：", 1)[0];
      if (code.startsWith("BLOCKED_")) codes.add(code);
    }
  }
  return [...codes];
}

function classify(catalog = loadRestaurantCatalog()) {
  const blocked = [];
  for (const employee of catalog.employees) {
    const profile = catalogProfile(employee);
    const dispatch = buildRestaurantDispatch(profile, `regulatory-classification-${employee.idx}`);
    const blockerCodes = realWorldBlockerCodes(dispatch);
    if (dispatch.operationalReady === true && blockerCodes.length === 0) continue;
    const regulationInputs = employee.inputs
      .map((input, inputIndex) => ({ input, inputIndex, specs: restaurantInputFactSpecs(input) }))
      .filter((item) => item.specs.some((spec) => spec.id === "regulation"));
    const uniqueBlockerCodes = [...new Set(blockerCodes)];
    const safeQaFacts = inputFields(employee);
    blocked.push({
      idx: Number(employee.idx),
      employeeName: employee.name,
      classification: "可用隔离QA事实安全补齐（仅非法规事实）+必须保持真实业务阻断",
      qaSupplement: {
        safeToGenerate: true,
        clearsProductionGate: false,
        minimumInputFields: safeQaFacts,
        note: "这些字段可由隔离QA聚合事实覆盖任务可完成性；不得写入真实法规/私有记录，也不能解除业务执行阻断。",
      },
      realWorldBlock: {
        mustRemainBlocked: true,
        regulationInputs: regulationInputs.map((item) => ({
          inputIndex: item.inputIndex + 1,
          input: item.input,
          minimumRegulationFields: REGULATION_REQUIRED_FIELDS,
        })),
        blockers: uniqueBlockerCodes.map((code) => ({
          code,
          exactGap: BLOCKER_GAPS[code] || "需要与该阻塞码对应的真实属地/平台/私有原始证据",
        })),
        note: "未经负责人/法务/平台或记录所有者提供并核验的真实证据，不得把 QA_ONLY 记录当作合规结论、业务采纳或外部执行授权。",
      },
    });
  }
  return {
    schema: "nanowork.restaurant-regulatory-blocker-classification.v1",
    generatedAt: new Date().toISOString(),
    policy: {
      employees: 61,
      blockedEmployees: blocked.length,
      externalApiCalls: 0,
      writes: 0,
      qaOnlyCannotClearRealWorldBlock: true,
    },
    safeQaSupplementable: blocked.map((item) => item.idx),
    mustRemainRealBlocked: blocked.map((item) => item.idx),
    employees: blocked,
  };
}

function markdown(report) {
  const lines = [
    "# 餐饮法规/私有范围阻断分类（只读）",
    "",
    `- 生成时间：${report.generatedAt}`,
    `- 61 岗中当前业务阻断：${report.policy.blockedEmployees} 岗` ,
    `- 可用隔离 QA 事实补齐（不解除真实阻断）：${report.safeQaSupplementable.join("、")}`,
    `- 必须保持真实业务阻断：${report.mustRemainRealBlocked.join("、")}`,
    "",
    "> QA_ONLY 只证明隔离生成链路可运行；不得代替当地法规、平台条款、许可证、企业私有记录或外部授权。",
    "",
    "| idx | 岗位 | 阻塞码→精确缺口 | 最小法规字段 | 非法规QA字段（可补齐） |",
    "|---:|---|---|---|---|",
  ];
  for (const item of report.employees) {
    const gaps = item.realWorldBlock.blockers
      .map((blocker) => `${blocker.code}：${blocker.exactGap}`)
      .join("<br>");
    const regulationFields = [...new Set(
      item.realWorldBlock.regulationInputs.flatMap((input) => input.minimumRegulationFields),
    )].join("、");
    lines.push(`| ${item.idx} | ${item.employeeName} | ${gaps} | ${regulationFields} | ${item.qaSupplement.minimumInputFields.join("<br>")} |`);
  }
  return `${lines.join("\n")}\n`;
}

const report = classify();
const output = process.argv.includes("--markdown") ? markdown(report) : `${JSON.stringify(report, null, 2)}\n`;
const outIndex = process.argv.indexOf("--out");
const outputPath = path.resolve(outIndex >= 0 && process.argv[outIndex + 1] ? process.argv[outIndex + 1] : OUT_DEFAULT);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`REGULATORY_BLOCKERS blocked=${report.policy.blockedEmployees} qaSupplementable=${report.safeQaSupplementable.length} realBlocked=${report.mustRemainRealBlocked.length} out=${outputPath}\n`);

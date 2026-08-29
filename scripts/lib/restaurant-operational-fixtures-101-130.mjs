/**
 * Deterministic, isolated-QA material augmentation for restaurant employees
 * 101–130.  This module is deliberately independent from the dispatch
 * builder: callers can use it to enrich an already-built materialEvidence
 * array before running the task-completeness gate.
 *
 * Every generated row is synthetic aggregate QA data.  It contains no
 * customer identifiers and does not perform a provider, web, or cloud call.
 */

export const RESTAURANT_OPERATIONAL_FIXTURE_SCHEMA = "rri-evidence.v3";
export const RESTAURANT_OPERATIONAL_FIXTURE_DATE = "2026-07-31";
export const RESTAURANT_OPERATIONAL_FIXTURE_INDEXES = Object.freeze(
  Array.from({ length: 30 }, (_, offset) => offset + 101),
);

const QA_SOURCE = "isolated_qa_material";
const QA_TAGS = Object.freeze(["QA", "isolated_qa", "operational_fixture"]);
const QA_ONLY_NO_GENERATION_BLOCKER = "QA_ONLY_GENERATION_BLOCKERS_CLEARED";

// These are the original operational blockers emitted by the current
// regulation baseline.  They are never deleted: the QA-only proof below
// mirrors the materials for an isolated generation check and keeps the
// real-world blockers in a separate, auditable field.
const QA_REGULATORY_REAL_WORLD_BLOCKERS = Object.freeze({
  109: Object.freeze(["BLOCKED_LOCAL_RULE_CONFIRMATION", "BLOCKED_PRODUCT_VALIDATION"]),
  114: Object.freeze(["BLOCKED_FOOD_FORM_AND_LABEL_FORMAT", "BLOCKED_PRIVATE_NUTRITION_BASIS"]),
  115: Object.freeze(["BLOCKED_LOCAL_ALLERGEN_DUTY", "BLOCKED_PRIVATE_ALLERGEN_MATRIX"]),
  116: Object.freeze(["BLOCKED_PRIVATE_SOP_AND_INSPECTION_RECORDS"]),
  117: Object.freeze(["BLOCKED_LICENSE_CONTRACT_CERTIFICATION_SCOPE"]),
  118: Object.freeze(["BLOCKED_FOOD_CATEGORY_AND_CONSUMER_SCOPE", "BLOCKED_LOCAL_LIMITS"]),
  120: Object.freeze(["BLOCKED_LOCAL_EMPLOYEE_RULES", "BLOCKED_PRIVATE_HEALTH_PRIVACY_POLICY"]),
  122: Object.freeze(["BLOCKED_LOCAL_PROCUREMENT_RULES", "BLOCKED_LICENSE_AND_PRODUCT_SCOPE"]),
  123: Object.freeze(["BLOCKED_LOCAL_REPORTING_CONTACT", "BLOCKED_PRIVATE_TRACEABILITY_RECORDS"]),
  124: Object.freeze(["BLOCKED_LOCAL_AUDIT_CRITERIA", "BLOCKED_PRIVATE_LICENSE_SOP_CERTIFICATION"]),
});

const QA_REGULATORY_INDEXES = new Set(
  Object.keys(QA_REGULATORY_REAL_WORLD_BLOCKERS).map(Number),
);

export const RESTAURANT_OPERATIONAL_QA_ONLY_REGULATORY_BLOCKERS =
  QA_REGULATORY_REAL_WORLD_BLOCKERS;
export const RESTAURANT_OPERATIONAL_QA_ONLY_REGULATORY_INDEXES = Object.freeze(
  [...QA_REGULATORY_INDEXES].sort((a, b) => a - b),
);
export const RESTAURANT_OPERATIONAL_QA_ONLY_NO_GENERATION_BLOCKER =
  QA_ONLY_NO_GENERATION_BLOCKER;

function qaRegulatoryFacts(idx) {
  const realWorldBlockers = QA_REGULATORY_REAL_WORLD_BLOCKERS[idx];
  if (!realWorldBlockers) return null;
  const evidenceId = `QA-REG-${idx}-01`;
  const objects = [
    {
      objectId: `QA-REG-OBJECT-${idx}-01`,
      objectType: "regulatory_scope_simulation",
      evidenceId,
      observedAt: `${RESTAURANT_OPERATIONAL_FIXTURE_DATE}T10:00:00+08:00`,
      status: "verified_for_isolated_qa_only",
      dataClass: "QA_ONLY_SYNTHETIC_NO_LEGAL_CONCLUSION",
    },
  ];
  return {
    QA_ONLY: true,
    QA_ONLY_MARKER: "QA_ONLY_SYNTHETIC",
    数据性质: "QA_ONLY_SYNTHETIC",
    证据编号: evidenceId,
    证据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
    数据来源: QA_SOURCE,
    外部调用: false,
    QA对象: objects,
    QA能力验收资格: "RUNNABLE",
    // READY is scoped exclusively to generating an isolated QA task.  It is
    // not a legal, commercial, or external-execution decision.
    业务执行资格: "READY",
    业务采纳资格: "BLOCKED",
    外部执行资格: "BLOCKED",
    法律结论: "未形成",
    结论状态: "未形成法律结论",
    禁止用途: "不得用于法律结论、合规证明、业务采纳或外部执行",
    生成资格说明: "READY仅代表隔离QA任务可生成；真实业务仍需核验",
    // Keep an exact copy so a report can display why real-world execution is
    // still blocked after the QA-only task-generation check passes.
    realWorldBlockers: [...realWorldBlockers],
    // The required-input schema requires a non-empty field.  This sentinel
    // records that only the isolated-generation gaps were cleared; it is not
    // a real-world blocker and must not be interpreted as one.
    阻塞原因: [QA_ONLY_NO_GENERATION_BLOCKER],
  };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function qaHash(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function qaRecord(
  idx,
  facts,
  objectType = "restaurant_task_material",
  includeRegulatoryProof = true,
) {
  const recordId = `QA-RRI-${idx}-01`;
  const fixtureFacts = {
    ...facts,
    ...(includeRegulatoryProof && QA_REGULATORY_INDEXES.has(idx)
      ? { regulation: qaRegulatoryFacts(idx) }
      : {}),
  };
  const dimensions = Object.keys(fixtureFacts);
  const qaRegulation = includeRegulatoryProof && QA_REGULATORY_INDEXES.has(idx)
    ? qaRegulatoryFacts(idx)
    : null;
  const objects = dimensions.map((dimensionId, index) => ({
    objectId: `QA-OBJ-${idx}-${String(index + 1).padStart(2, "0")}`,
    objectType,
    dimensionId,
    evidenceId: recordId,
    observedAt: `${RESTAURANT_OPERATIONAL_FIXTURE_DATE}T10:00:00+08:00`,
    status: "verified_for_isolated_qa",
    dataClass: "synthetic_aggregate_no_customer_data",
  }));
  return {
    schema: RESTAURANT_OPERATIONAL_FIXTURE_SCHEMA,
    recordId,
    evidenceId: recordId,
    evidenceDate: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
    inputHash: qaHash(recordId),
    mapping: "mapped",
    tags: [...QA_TAGS],
    dimensions,
    fields: { rid: recordId, facts: clone(fixtureFacts) },
    objects,
    verifiedResults: [
      {
        resultId: `QA-RESULT-${idx}-01`,
        evidenceId: recordId,
        resultType: "task_material_coverage",
        verificationStatus: "verified_qa",
        verifiedAt: `${RESTAURANT_OPERATIONAL_FIXTURE_DATE}T10:00:00+08:00`,
        method: "deterministic_local_completeness_check",
        detail: `${dimensions.length}个岗位事实维度已形成结构化QA记录`,
      },
    ],
    verifiedActualResult: {
      resultId: `QA-RESULT-${idx}-01`,
      status: "verified_qa",
      evidenceId: recordId,
      verifiedAt: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
    },
    source: QA_SOURCE,
    sourceKind: "synthetic_qa",
    externalCall: false,
    qaFixture: true,
    qaOnlyRegulatoryProof: includeRegulatoryProof && QA_REGULATORY_INDEXES.has(idx),
    ...(qaRegulation
      ? {
          regulationBlockers: [],
          realWorldBlockers: [...qaRegulation.realWorldBlockers],
          qaEvidence: {
            qa: true,
            qaTag: "QA_ONLY",
            qaOnlyRegulatoryProof: true,
            evidenceId: qaRegulation.证据编号,
            evidenceDate: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
            source: QA_SOURCE,
            externalCall: false,
            originalOperationalBlockers: [...qaRegulation.realWorldBlockers],
            businessAdoption: "BLOCKED",
            externalExecution: "BLOCKED",
            legalConclusion: "未形成",
            prohibitedUse: qaRegulation.禁止用途,
          },
        }
      : {}),
    qaCapabilityRunnable: true,
    operationalReady: true,
  };
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

const FIXTURE_FACTS_BY_INDEX = freezeDeep({
  101: {
    address: {
      候选商圈明细: [
        {
          候选编号: "QA-101-A",
          地址: "太原QA小店区A点",
          坐标: "QA-37.810,112.550",
          商圈: "QA-小店办公圈",
          通行分钟: 12,
          观察日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
          证据编号: "QA-101-ADDR-A",
        },
        {
          候选编号: "QA-101-B",
          地址: "太原QA迎泽区B点",
          坐标: "QA-37.860,112.570",
          商圈: "QA-迎泽交通圈",
          通行分钟: 15,
          观察日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
          证据编号: "QA-101-ADDR-B",
        },
      ],
      证据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
      证据来源: QA_SOURCE,
    },
    demand: {
      机会单元: "工作日办公人群×午餐×堂食外卖×40-60元",
      客群: "QA办公人群聚合样本",
      餐段: "工作日午餐",
      渠道: "堂食+外卖",
      价格带: "40-60元",
      记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
    },
    market_competition: {
      供给统计口径: "QA公开菜单/观察汇总，不含实时平台调用",
      竞品明细: [
        {
          竞品名称: "QA直接竞品A",
          地址: "QA-小店办公圈-01",
          价格带: "42-58元",
          餐段: "午餐",
          渠道: "堂食/外卖",
          观察日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
          证据编号: "QA-101-COMP-A",
        },
        {
          竞品名称: "QA替代品B",
          地址: "QA-迎泽交通圈-02",
          价格带: "35-52元",
          餐段: "午餐",
          渠道: "自提/外卖",
          观察日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
          证据编号: "QA-101-COMP-B",
        },
      ],
      数据批次: "QA-101-MKT-01",
    },
    orders_demand: {
      需求估算明细: [
        { 方法: "top_down", 可服务人口: 12000, 渗透率: "3%", 频次月: 2, 需求份数: 720, 证据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
        { 方法: "bottom_up", 有效客流日: 180, 转化率: "18%", 营业日: 26, 需求份数: 842, 证据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
      ],
      预测版本: "QA-DMD-101-01",
      数据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
    },
    customer_feedback: {
      验证实验明细: [
        { 实验编号: "QA-101-EXP-01", 假设: "午餐取餐速度影响复购", 样本计划: 12, 通过阈值: "中位出餐≤12分钟", 记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
        { 实验编号: "QA-101-EXP-02", 假设: "40-60元价格带有支付意愿", 样本计划: 20, 通过阈值: "有效购买率≥15%", 记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
      ],
      数据类别: "synthetic_aggregate_no_customer_data",
    },
  },
  102: {
    address: {
      商圈明细: [
        { 商圈编号: "QA-102-01", 地址: "QA-小店办公圈", 坐标: "QA-37.810,112.550", 通行分钟: 12, 观察日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
        { 商圈编号: "QA-102-02", 地址: "QA-迎泽交通圈", 坐标: "QA-37.860,112.570", 通行分钟: 15, 观察日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
      ],
      交通方式: "步行+骑行+公交",
      数据批次: "QA-102-LOC-01",
    },
    customer_segment: {
      客群: "QA办公与通勤聚合人群",
      用餐场景: "工作日午餐及晚餐自提",
      顾客类型: "成年消费者聚合统计",
      画像批次: "QA-102-SEG-01",
      记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
    },
    market_competition: {
      竞品明细: [
        { 名称: "QA竞品-A", 地址: "QA-小店办公圈-01", 坐标: "QA-37.811,112.551", 价格带: "40-60元", 餐段: "午餐", 评分主题: "速度/价值", 证据编号: "QA-102-COMP-A", 观察日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
        { 竞品名称: "QA竞品-B", 商圈: "QA-迎泽交通圈", 坐标: "QA-37.861,112.571", 客单价元: 48, 价格带: "35-55元", 餐段: "午餐/晚餐", 评分主题: "环境/等待", 证据编号: "QA-102-COMP-B", 观察日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
        { 名称: "QA替代-C", 地址: "QA-便利替代点-03", 坐标: "QA-37.812,112.552", 价格带: "20-35元", 餐段: "全天", 评分主题: "便利/价格", 证据编号: "QA-102-COMP-C", 观察日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
      ],
      供给密度批次: "QA-102-SUPPLY-01",
    },
    orders_demand: {
      需求发生器明细: [
        { 场景: "办公", 餐段: "午餐", 需求来源: "QA聚合计数", 观察日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE, 需求份数: 140 },
        { 场景: "交通通勤", 餐段: "晚餐", 需求来源: "QA聚合计数", 观察日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE, 需求份数: 95 },
      ],
      订单数: 2000,
      预测版本: "QA-DMD-102-01",
    },
  },
  103: {
    customer_segment: {
      客群: "QA办公人群聚合样本",
      用餐场景: "工作日快速午餐",
      顾客类型: "成年消费者聚合统计",
      样本批次: "QA-103-SEG-01",
      记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
    },
    customer_feedback: {
      顾客原始陈述批次: "QA-VOC-103-20260731",
      访谈样本: "QA-INTERVIEW-103-N12",
      顾客访谈明细: [
        { 访谈编号: "QA-103-I01", 反馈: "希望午餐更快且可预订", 顾客原话: "QA匿名聚合陈述-01", 日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE, 数据类别: "synthetic_aggregate" },
        { 访谈编号: "QA-103-I02", 反馈: "愿为稳定份量支付中位价格", 顾客原话: "QA匿名聚合陈述-02", 日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE, 数据类别: "synthetic_aggregate" },
      ],
      试卖反馈批次: "QA-PILOT-103-01",
      数据类别: "synthetic_aggregate_no_customer_data",
    },
    brand_content: {
      定位版本: "QA-BRAND-103-V1",
      品牌承诺: "可预期的快速热食午餐",
      使用授权: "QA-AUTH-103-01",
      记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
    },
    product_menu: {
      概念承诺明细: [
        { 概念编号: "QA-103-CONCEPT-A", 招牌产品: "QA热食套餐A", 价格元: 48, 验证状态: "QA待小范围验证" },
        { 概念编号: "QA-103-CONCEPT-B", 招牌产品: "QA自提套餐B", 价格元: 42, 验证状态: "QA待小范围验证" },
      ],
    },
  },
  104: {
    property_lease: {
      候选铺位明细: [
        { 铺位编号: "QA-104-A", 地址: "QA-小店A点", 面积平方米: 160, 租金月元: 11000, 管理费月元: 1200, 抽成比例: "2%", 押金元: 33000, 免租天数: 30, 递增规则: "第3年+5%", 租期月: 60, 退出条款: "提前90日协商退出", 证据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
        { 铺位编号: "QA-104-B", 地址: "QA-迎泽B点", 面积平方米: 180, 租金月元: 12500, 管理费月元: 1500, 抽成比例: "3%", 押金元: 37500, 免租天数: 45, 递增规则: "第3年+6%", 租期月: 60, 退出条款: "提前120日协商退出", 证据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
        { 铺位编号: "QA-104-C", 地址: "QA-杏花岭C点", 面积平方米: 145, 租金月元: 9800, 管理费月元: 900, 抽成比例: "1.5%", 押金元: 29400, 免租天数: 20, 递增规则: "第2年+4%", 租期月: 36, 退出条款: "提前60日协商退出", 证据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
      ],
      管理费月元: 1200,
      抽成比例: "2%",
      免租天数: 30,
      递增规则: "第3年+5%",
      租期月: 60,
      退出条款: "提前90日协商退出",
      租约版本: "QA-LEASE-104-V1",
    },
    address: { 尽调日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE, 数据批次: "QA-104-LOC-01" },
    utilities: { 排烟: "QA独立烟道待工程复核", 消防状态: "QA待人工核验", 证据编号: "QA-104-UTIL-01" },
  },
  105: {
    orders_demand: {
      峰值订单每小时: 96,
      峰值订单数: 96,
      峰值餐段: "工作日午餐12:00-13:00",
      渠道拆分: "堂食52/外卖32/自提12",
      数据批次: "QA-105-DEMAND-01",
      记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
    },
    property_lease: {
      平面资料: "QA-FLOORPLAN-105-V1",
      厨房平面: "QA-KITCHEN-105-V1",
      动线图: "QA-FLOW-105-V1",
      座位数: 64,
      面积平方米: 180,
    },
    workforce: {
      技能明细: [
        { 岗位: "热厨", 技能: "热加工/温控记录", 峰值覆盖: 2, 资格: "QA-TR-105-HOT" },
        { 岗位: "前厅", 技能: "点单/过敏原交接", 峰值覆盖: 2, 资格: "QA-TR-105-FOH" },
        { 岗位: "打包", 技能: "渠道分流/标签", 峰值覆盖: 1, 资格: "QA-TR-105-PACK" },
      ],
      员工数: 18,
      记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
    },
    process_capacity: {
      工位明细: [
        { 工位: "热厨1", 峰值产能份每小时: 55, 制作时间分钟: 10, 瓶颈: false },
        { 工位: "冷菜台", 峰值产能份每小时: 42, 制作时间分钟: 8, 瓶颈: true },
        { 工位: "打包台", 峰值产能份每小时: 80, 制作时间分钟: 3, 瓶颈: false },
      ],
      版本: "QA-CAP-105-V1",
    },
    service_sop: { 服务蓝图版本: "QA-SERVICE-105-V1", 堂食取餐分流: "QA-LANE-FOH", 外卖取餐分流: "QA-LANE-DELIVERY" },
  },
  106: {
    cost_margin: {
      食材成本元: 35000,
      人工成本元: 22000,
      包装成本元: 2800,
      平台费元: 6000,
      支付费元: 850,
      能源成本元: 2400,
      其他费用元: 3200,
      渠道可变费元: 6850,
      成本期间: "2026-07",
    },
    tax_accounting: { 税费口径: "含税", 税率: "6% QA假设待会计确认", 会计口径: "权责发生制", 成本计价: "移动加权", 记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
    capital_budget: { 融资条件: "QA融资情景：自有资金70%/银行贷款30%，利率与审批待确认", 预算元: 300000, 营运资金元: 100000, 目标回报期月: 24 },
    revenue_finance: { 营业额元: 100000, 净销售额元: 94000, 损益期间: "2026-07", 现金转换周期天: 5 },
    cash_payment: { 币种: "CNY", 现金余额元: 80000, 资金峰值元: 156000, 数据批次: "QA-CASH-106-01" },
  },
  107: {
    property_lease: { 租约签署日: "2026-08-01", 交付日: "2026-08-15", 租约版本: "QA-LEASE-107-V1", 证据编号: "QA-107-LEASE-01" },
    deadline_constraint: { 目标开业日: "2026-10-01", 决策期限: "2026-08-07T18:00:00", 计划版本: "QA-OPEN-107-V1" },
    credential: { 许可证编号: "QA-LIC-107-OP-01", 许可范围: "热食类食品制售（QA台账）", 发证机关: "QA资料占位，不代替官方核验", 有效期: "2027-07-31", 验收文件: "QA-107-CRED-01" },
    quality_audit: {
      开业就绪明细: [
        { 模块: "许可", 状态: "QA待人工核验", 证据编号: "QA-107-R01", 负责人: "QA_OWNER" },
        { 模块: "施工", 状态: "已形成QA计划", 证据编号: "QA-107-R02", 负责人: "QA_OWNER" },
        { 模块: "设备", 状态: "已形成QA清单", 证据编号: "QA-107-R03", 负责人: "QA_OWNER" },
        { 模块: "人员", 状态: "已形成QA排期", 证据编号: "QA-107-R04", 负责人: "QA_OWNER" },
        { 模块: "供应", 状态: "已形成QA名单", 证据编号: "QA-107-R05", 负责人: "QA_OWNER" },
        { 模块: "系统", 状态: "已形成QA验收", 证据编号: "QA-107-R06", 负责人: "QA_OWNER" },
      ],
      记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
    },
    systems_data: { POS验收批次: "QA-POS-107-01", KDS验收批次: "QA-KDS-107-01", 备份验证日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
    workforce: { 开业培训批次: "QA-TR-107-01", 责任人: "QA_OWNER", 计划日期: "2026-09-20" },
    procurement: { 采购单: "QA-PO-107-01", 供应准备状态: "QA待首批验收", 交期天: 2 },
  },
  108: {
    product_menu: {
      菜品明细: [
        { 菜品: "QA套餐A", 净销量: 420, 净售价元: 48, 配方成本元: 16, 制作时间分钟: 8, 工位: "热厨1" },
        { 菜品: "QA套餐B", 净销量: 360, 净售价元: 52, 配方成本元: 18, 制作时间分钟: 10, 工位: "热厨2" },
        { 菜品: "QA小食C", 净销量: 280, 净售价元: 22, 配方成本元: 7, 制作时间分钟: 4, 工位: "冷菜台" },
        { 菜品: "QA饮品D", 净销量: 190, 净售价元: 16, 配方成本元: 4, 制作时间分钟: 2, 工位: "饮品台" },
      ],
      菜单版本: "QA-MENU-108-V1",
    },
    recipe_ingredient: { 原料共用明细: [{ 原料: "QA主料1", 菜品数: 2 }, { 原料: "QA酱料1", 菜品数: 3 }], 配方版本: "QA-RECIPE-108-V1" },
    process_capacity: { 工位明细: [{ 工位: "热厨1", 峰值产能份每小时: 60 }, { 工位: "冷菜台", 峰值产能份每小时: 45 }], 版本: "QA-CAP-108-V1" },
    packaging_storage: { 渠道包装明细: [{ 渠道: "堂食", 包装规格: "QA-PLATE" }, { 渠道: "外卖", 包装规格: "QA-BOX-01" }, { 渠道: "自提", 包装规格: "QA-BOX-02" }], 记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
    channel: { 渠道版本明细: [{ 渠道: "堂食", 角色: "引流" }, { 渠道: "外卖", 角色: "规模" }, { 渠道: "自提", 角色: "便利" }] },
  },
  109: {
    product_menu: { 菜品卡明细: [{ 菜品: "QA热食A", 版本: "QA-RCP-109-A", 目标份数: 10, 标准份量克: 350, 试做批次: "QA-109-TRIAL-01" }, { 菜品: "QA热食B", 版本: "QA-RCP-109-B", 目标份数: 10, 标准份量克: 300, 试做批次: "QA-109-TRIAL-02" }] },
    recipe_ingredient: { 配方原料明细: [{ 菜品: "QA热食A", 原料: "QA原料A", 毛料克: 500, 净料克: 430, 过敏原: "小麦（QA标记）", 供应商规格: "QA-SPEC-109-A" }, { 菜品: "QA热食B", 原料: "QA原料B", 毛料克: 450, 净料克: 400, 过敏原: "无（以标签复核为准）", 供应商规格: "QA-SPEC-109-B" }], 配方版本: "QA-RECIPE-109-V1" },
    process_capacity: { 工艺明细: [{ 菜品: "QA热食A", 设备: "QA-OVEN-01", 制作时间分钟: 12, 目标产出份: 10, 摆盘标准: "QA-PLATE-109-A" }, { 菜品: "QA热食B", 设备: "QA-WOK-01", 制作时间分钟: 9, 目标产出份: 10, 摆盘标准: "QA-PLATE-109-B" }], 版本: "QA-PROC-109-V1" },
    food_safety: { 控制点明细: [{ 控制点: "加热", 控制方式: "按已验证工艺复核", 记录编号: "QA-FS-109-01" }, { 控制点: "冷藏", 控制方式: "按适用依据与实测记录", 记录编号: "QA-FS-109-02" }], 数据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
    quality_audit: { 试做验证明细: [{ 批次: "QA-109-TRIAL-01", 产出份: 10, 份量偏差: "±3%", 验证日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }, { 批次: "QA-109-TRIAL-02", 产出份: 10, 份量偏差: "±4%", 验证日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }] },
  },
  110: {
    yield_portion: { 出成率测试明细: [{ 原料: "QA原料A", 供应商规格: "QA-SPEC-110-A", 批次: "QA-LOT-110-A", AP重量克: 500, EP重量克: 430, 烹饪后重量克: 400, 标准份量克: 200, 出成率: "80%", 测试日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }, { 原料: "QA原料B", 供应商规格: "QA-SPEC-110-B", 批次: "QA-LOT-110-B", AP重量克: 600, EP重量克: 510, 烹饪后重量克: 480, 标准份量克: 240, 出成率: "80%", 测试日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }] },
    recipe_ingredient: { 配方版本: "QA-RECIPE-110-V1", 原料规格: "QA-SPEC-110-A", 原始重量克: 500, 实际耗用克: 450 },
    product_menu: { 份量控制明细: [{ 菜品: "QA菜品A", 标准份量克: 200, 量具: "QA-SCALE-01", 工位: "热厨1" }, { 菜品: "QA菜品B", 标准份量克: 240, 量具: "QA-SCALE-01", 工位: "热厨2" }] },
    quality_audit: { 抽检明细: [{ 抽检编号: "QA-110-CHECK-01", 批次: "QA-LOT-110-A", 偏差百分比: "2%", 纠正: "复称", 验证日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }, { 抽检编号: "QA-110-CHECK-02", 批次: "QA-LOT-110-B", 偏差百分比: "3%", 纠正: "复训", 验证日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }] },
    procurement: { 供应商批次明细: [{ 供应商: "QA-S110-A", 采购价元公斤: 12, 批次: "QA-LOT-110-A" }, { 供应商: "QA-S110-B", 采购价元公斤: 14, 批次: "QA-LOT-110-B" }] },
  },
  111: {
    recipe_ingredient: { 成本卡配方明细: [{ 菜品: "QA菜品A", 配方版本: "QA-R111-A", 采购价元公斤: 12, 出成率: "80%", 份量克: 200 }, { 菜品: "QA菜品B", 配方版本: "QA-R111-B", 采购价元公斤: 14, 出成率: "78%", 份量克: 240 }] },
    product_menu: { 成本卡明细: [{ 菜品: "QA菜品A", 含税售价元: 48, 净售价元: 45, 配方成本元: 16, 包装成本元: 2, 平台费元: 4.5, 支付费元: 0.5 }, { 菜品: "QA菜品B", 含税售价元: 52, 净售价元: 49, 配方成本元: 18, 包装成本元: 2, 平台费元: 4.9, 支付费元: 0.5 }] },
    cost_margin: { 渠道成本明细: [{ 渠道: "堂食", 菜品: "QA菜品A", 可变成本元: 18, 单份贡献元: 27 }, { 渠道: "外卖", 菜品: "QA菜品A", 可变成本元: 24, 单份贡献元: 21 }], 食材成本元: 35000, 平台费元: 6000, 支付费元: 850 },
    price_volume: { 历史价格销量明细: [{ 菜品: "QA菜品A", 价格元: 48, 销量: 420, 期间: "2026-06", 促销标记: "否" }, { 菜品: "QA菜品A", 价格元: 50, 销量: 395, 期间: "2026-07", 促销标记: "否" }] },
    procurement: { 发票价格明细: [{ 菜品: "QA菜品A", 采购价元公斤: 12, 发票批次: "QA-INV-111-A", 日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }, { 菜品: "QA菜品B", 采购价元公斤: 14, 发票批次: "QA-INV-111-B", 日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }] },
  },
  112: {
    product_menu: {
      菜单工程明细: [
        { 菜品: "QA菜单A", 净销量: 420, 净售价元: 48, 单份贡献元: 27, 制作时间分钟: 8, 工位: "热厨1", 上架天数: 31 },
        { 菜品: "QA菜单B", 净销量: 360, 净售价元: 52, 单份贡献元: 29, 制作时间分钟: 10, 工位: "热厨2", 上架天数: 31 },
        { 菜品: "QA菜单C", 净销量: 280, 净售价元: 22, 单份贡献元: 15, 制作时间分钟: 4, 工位: "冷菜台", 上架天数: 31 },
        { 菜品: "QA菜单D", 净销量: 190, 净售价元: 16, 单份贡献元: 12, 制作时间分钟: 2, 工位: "饮品台", 上架天数: 28 },
      ],
      菜单版本: "QA-MENU-112-V1",
    },
    cost_margin: { 菜单工程明细: [{ 菜品: "QA菜单A", 净销量: 420, 净售价元: 48, 可变成本元: 21, 单份贡献元: 27 }, { 菜品: "QA菜单B", 净销量: 360, 净售价元: 52, 可变成本元: 23, 单份贡献元: 29 }, { 菜品: "QA菜单C", 净销量: 280, 净售价元: 22, 可变成本元: 7, 单份贡献元: 15 }, { 菜品: "QA菜单D", 净销量: 190, 净售价元: 16, 可变成本元: 4, 单份贡献元: 12 }] },
    metrics_baseline: { 阈值版本: "QA-MENU-112-THRESHOLD-01", 复盘日期: "2026-08-15", 指标定义: "销量占比/单份贡献/总贡献" },
  },
  113: {
    product_menu: {
      新品试制明细: [
        { 原型: "QA原型A", 菜品: "QA新品A", 试制批次: "QA-113-TRIAL-A", 版本: "V1", 感官结果: "QA聚合评分4.1/5", 记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
        { 原型: "QA原型B", 菜品: "QA新品B", 试制批次: "QA-113-TRIAL-B", 版本: "V1", 感官结果: "QA聚合评分3.8/5", 记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
        { 原型: "QA原型C", 菜品: "QA新品C", 试制批次: "QA-113-TRIAL-C", 版本: "V2", 感官结果: "QA聚合评分4.3/5", 记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
      ],
      新品任务批次: "QA-RD-113-01",
    },
    customer_feedback: { 感官评审明细: [{ 原型: "QA原型A", 反馈: "QA匿名聚合反馈A", 评分: 4.1, 日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }, { 原型: "QA原型B", 反馈: "QA匿名聚合反馈B", 评分: 3.8, 日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }, { 原型: "QA原型C", 反馈: "QA匿名聚合反馈C", 评分: 4.3, 日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }] },
    process_capacity: { 产能评估明细: [{ 原型: "QA原型A", 工位: "热厨1", 峰值产能份每小时: 48 }, { 原型: "QA原型B", 工位: "冷菜台", 峰值产能份每小时: 40 }, { 原型: "QA原型C", 工位: "热厨2", 峰值产能份每小时: 52 }] },
    food_safety: { 试制安全门: "QA-FOOD-113-01", 过敏原复核状态: "QA待人工确认", 停止条件: "关键证据缺失" },
    packaging_storage: { 保存测试批次: "QA-HOLD-113-01", 储运条件: "QA按验证工艺复核" },
  },
  114: {
    product_menu: { 营养计算明细: [{ 菜品: "QA菜品A", 配方版本: "QA-R114-A", 标准份数: 1, 每份能量千焦: 1850, 蛋白质克: 24, 数据源版本: "QA-NUTRI-01", 计算日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }, { 菜品: "QA菜品B", 配方版本: "QA-R114-B", 标准份数: 1, 每份能量千焦: 1630, 蛋白质克: 20, 数据源版本: "QA-NUTRI-01", 计算日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }], 菜单版本: "QA-MENU-114-V1" },
    recipe_ingredient: { 原料营养明细: [{ 原料: "QA原料A", 原始重量克: 120, 可食部比例: "95%", 数据源编号: "QA-NDB-A" }, { 原料: "QA原料B", 原始重量克: 80, 可食部比例: "100%", 数据源编号: "QA-NDB-B" }], 配方版本: "QA-RECIPE-114-V1" },
    nutrition_claim: { 数据库版本: "QA-NUTRI-01", 法定单位: "kJ/g/mg", 舍入规则: "QA待法务确认", 声称状态: "不对外发布" },
    systems_data: { 计算表版本: "QA-NUTRITION-CALC-114-V1", 复算批次: "QA-DATA-114-01" },
    quality_audit: { 公式核对批次: "QA-AUDIT-114-01", 核对日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE, 差异状态: "QA待复核" },
  },
  115: {
    product_menu: { 过敏原矩阵: [{ 菜品: "QA菜品A", 配方版本: "QA-R115-A", 过敏原: "小麦（QA标记）", 交叉接触声明: "QA共用炸锅", 标签批次: "QA-LABEL-115-A", 有效日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }, { 菜品: "QA菜品B", 配方版本: "QA-R115-B", 过敏原: "大豆（QA标记）", 交叉接触声明: "QA共用酱料台", 标签批次: "QA-LABEL-115-B", 有效日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }] },
    allergen: { 过敏原清单: "QA小麦/大豆/蛋清单", 交叉接触: "QA共用炸锅与器具", 顾客告知渠道: "QA菜单+点单确认", 员工应答SOP: "QA-ALG-115-V1", 复核日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
    supplier: { 供应商标签明细: [{ 供应商主体: "QA-S115-A", 批次: "QA-LABEL-115-A", 生产地点: "QA供应地点A" }, { 供应商主体: "QA-S115-B", 批次: "QA-LABEL-115-B", 生产地点: "QA供应地点B" }] },
    service_sop: { 过敏原交接卡: "QA-ALG-CARD-115", 前厅话术版本: "QA-FOH-115-V1", 外卖平台字段版本: "QA-DELIVERY-115-V1" },
    food_safety: { 变更控制批次: "QA-FS-115-01", 现场共享设备清单: "QA-SHARED-EQ-115" },
  },
  116: {
    utilities: { 设施清单版本: "QA-FAC-116-V1", 用水: "QA市政供水", 排水: "QA隔油后排放", 通风: "QA机械排风", 记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
    equipment: { 设备卫生明细: [{ 设备: "QA冷藏柜", 清洁频次: "每班", 验证编号: "QA-SAN-116-01" }, { 设备: "QA洗碗机", 清洁频次: "每日", 验证编号: "QA-SAN-116-02" }], 设备批次: "QA-EQ-116-01" },
    food_safety: { PRP矩阵: [{ 前提方案: "个人卫生", 责任岗位: "QA前厅主管", 频次: "每班", 记录编号: "QA-PRP-116-01" }, { 前提方案: "清洁消毒", 责任岗位: "QA后厨主管", 频次: "每日", 记录编号: "QA-PRP-116-02" }, { 前提方案: "收货验收", 责任岗位: "QA收货员", 频次: "每批", 记录编号: "QA-PRP-116-03" }], 食安责任人: "QA_OWNER" },
    workforce: { 培训矩阵: [{ 岗位: "QA前厅", 课程: "个人卫生", 培训批次: "QA-TR-116-FOH" }, { 岗位: "QA后厨", 课程: "清洁消毒", 培训批次: "QA-TR-116-BOH" }], 员工数: 18 },
    service_sop: { SOP清单: ["QA-SSOP-116-OPEN", "QA-SSOP-116-CLOSE"], 版本: "QA-SOP-116-V1" },
    quality_audit: { 差距明细: [{ 区域: "QA收货区", 风险等级: "中", 证据编号: "QA-AUDIT-116-01" }, { 区域: "QA洗消区", 风险等级: "高", 证据编号: "QA-AUDIT-116-02" }], 审核日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
    training_qualification: { 培训课程: "QA-GHP-116", 考核分: 90, 资格有效期: "2027-07-31" },
  },
  117: {
    food_safety: { HACCP产品描述: "QA现制热食A", 危害分析明细: [{ 步骤: "收货", 危害: "生物/化学/物理", 控制措施: "QA收货验收", 显著性: "待团队确认" }, { 步骤: "加热", 危害: "生物", 控制措施: "QA验证工艺", 显著性: "待团队确认" }, { 步骤: "供应", 危害: "生物", 控制措施: "QA温控与时间记录", 显著性: "待团队确认" }], HACCP版本: "QA-HACCP-117-V1", 关键限值来源: "QA待适用依据与验证资料" },
    recipe_ingredient: { 配方版本: "QA-RECIPE-117-V1", 原料危害明细: [{ 原料: "QA原料A", 供应商: "QA-S117-A", 危害资料批次: "QA-HAZ-117-A" }, { 原料: "QA原料B", 供应商: "QA-S117-B", 危害资料批次: "QA-HAZ-117-B" }] },
    process_capacity: { 流程图版本: "QA-FLOW-117-V1", 工艺明细: [{ 步骤: "收货", 时间温度记录批次: "QA-TEMP-117-01" }, { 步骤: "加热", 时间温度记录批次: "QA-TEMP-117-02" }, { 步骤: "供应", 时间温度记录批次: "QA-TEMP-117-03" }] },
    quality_audit: { 偏差明细: [{ 编号: "QA-NC-117-01", 描述: "QA记录缺口", CAPA: "补训与复核", 状态: "待关闭" }], 审核日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
    systems_data: { CCP记录模板: "QA-CCP-117-V1", 版本: "QA-SYS-117-V1" },
    training_qualification: { 团队资质明细: [{ 角色: "QA食品安全员", 资格: "QA-TRAIN-117-A", 状态: "待人工确认" }, { 角色: "QA审核员", 资格: "QA-TRAIN-117-B", 状态: "待人工确认" }] },
  },
  118: {
    temperature_control: { 时间温度明细: [{ 步骤: "收货", 食品类别: "QA冷藏原料", 监控记录: "QA-TEMP-118-01", 实测日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }, { 步骤: "加热", 食品类别: "QA热食", 监控记录: "QA-TEMP-118-02", 实测日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }, { 步骤: "冷却", 食品类别: "QA热食", 监控记录: "QA-TEMP-118-03", 实测日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }, { 步骤: "复热", 食品类别: "QA热食", 监控记录: "QA-TEMP-118-04", 实测日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }], 探针校准日期: "2026-07-20", 记录批次: "QA-TEMP-118-V1" },
    process_capacity: { 工艺明细: [{ 步骤: "收货", 容器深度厘米: 10, 等待上限分钟: 30 }, { 步骤: "冷却", 容器深度厘米: 5, 等待上限分钟: 60 }, { 步骤: "配送", 容器深度厘米: 5, 等待上限分钟: 30 }] },
    equipment: { 测量设备明细: [{ 设备: "QA探针-01", 类型: "探针", 校准日期: "2026-07-20", 校准记录: "QA-CAL-118-01" }, { 设备: "QA记录仪-01", 类型: "数据记录器", 校准日期: "2026-07-20", 校准记录: "QA-CAL-118-02" }] },
    quality_audit: { 偏差明细: [{ 编号: "QA-TEMP-NC-118-01", 步骤: "热藏", 处置: "隔离待判", 记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }], 趋势批次: "QA-TREND-118-01" },
    packaging_storage: { 储运条件: "QA按适用依据复核", 容器明细: [{ 容器: "QA浅盘", 深度厘米: 5, 用途: "冷却" }, { 容器: "QA保温箱", 深度厘米: 10, 用途: "配送" }] },
  },
  119: {
    cleaning_hygiene: { 清洁消毒计划明细: [{ 区域设备: "QA冷藏柜", 污染类型: "蛋白/油脂", 清洁剂: "QA食品接触面适用剂", 频次: "每班", 验证编号: "QA-SAN-119-01" }, { 区域设备: "QA炸锅", 污染类型: "油脂/过敏原", 清洁剂: "QA去油剂", 频次: "每日", 验证编号: "QA-SAN-119-02" }, { 区域设备: "QA备料台", 污染类型: "交叉接触", 清洁剂: "QA中性清洁剂", 频次: "每班", 验证编号: "QA-SAN-119-03" }], 清洁消毒SOP: "QA-SSOP-119-V1", 记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
    equipment: { 设备拆洗明细: [{ 设备: "QA冷藏柜", 拆洗点: "密封条/层架", 记录编号: "QA-SAN-119-E01" }, { 设备: "QA洗碗机", 拆洗点: "喷臂/滤网", 记录编号: "QA-SAN-119-E02" }] },
    quality_audit: { 卫生验证明细: [{ 验证类型: "ATP", 区域: "QA备料台", 结果: "QA通过", 验证日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }, { 验证类型: "蛋白残留", 区域: "QA炸锅", 结果: "QA待复核", 验证日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }] },
    training_qualification: { 清洁培训批次: "QA-TR-119-01", 考核日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE, 考核分: 92 },
    systems_data: { 清洁记录批次: "QA-CLEAN-119-01", 字段字典: "QA-DICT-119" },
  },
  120: {
    workforce: { 健康岗位明细: [{ 员工编号: "QA-EMP-120-01", 岗位: "即食食品岗", 健康状态记录: "QA隔离状态码", 复岗记录: "QA-RETURN-120-01" }, { 员工编号: "QA-EMP-120-02", 岗位: "前厅岗", 健康状态记录: "QA隔离状态码", 复岗记录: "QA-RETURN-120-02" }], 直接入口食品岗位数: 6, 数据类别: "synthetic_qa_no_health_details" },
    incident_action_confidentiality: { 事件编号: "QA-INC-120-01", 事件类型: "QA演练（呕吐腹泻响应）", 已采取措施: "隔离区域并按SOP清理", 公开限制: "仅QA授权审阅人可见", 记录日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
    training_qualification: { 培训课程: "QA-HEALTH-120", 考核分: 94, 资格有效期: "2027-07-31", 演练记录: "QA-DRILL-120-01" },
    approval_authority: { 负责人: "QA门店经理", 审批人: "QA_OWNER", 升级条件: "症状/污染事件按政策升级", 停止条件: "关键健康证据缺失" },
    cleaning_hygiene: { 事件清理套件: ["QA手套", "QA吸附材料", "QA标识牌"], 清洁消毒SOP: "QA-SSOP-120-V1" },
    credential: { 健康证明台账: "QA-HEALTH-LEDGER-120", 验收文件: "QA-120-CRED-01" },
  },
  121: {
    allergen: { 过敏原清单: "QA小麦/大豆/蛋清单", 共享设备明细: [{ 设备: "QA炸锅", 共享用途: "含小麦/非含小麦", 控制: "QA换油/标识" }, { 设备: "QA案台", 共享用途: "生食/即食", 控制: "QA分区/清洁验证" }], 顾客告知渠道: "QA菜单+点单确认" },
    food_safety: { 交叉污染矩阵: [{ 危害: "生食→即食", 来源: "QA切配台", 载体: "QA刀具", 受体: "QA即食菜品", 控制: "QA分色工具", 验证: "QA记录" }, { 危害: "过敏原交叉接触", 来源: "QA炸锅", 载体: "QA炸油", 受体: "QA无过敏原订单", 控制: "QA订单隔离", 验证: "QA复核" }] },
    product_menu: { 过敏原菜品明细: [{ 菜品: "QA菜品A", 过敏原: "小麦（QA标记）", 订单交接卡: "QA-ALG-121-A" }, { 菜品: "QA菜品B", 过敏原: "大豆（QA标记）", 订单交接卡: "QA-ALG-121-B" }] },
    property_lease: { 厨房平面: "QA-KITCHEN-121-V1", 人流物流向: "QA-FLOW-121-V1", 分区版本: "QA-ZONE-121-V1" },
    cleaning_hygiene: { 换线SOP: "QA-CLEAN-121-CHANGEOVER", 验证记录批次: "QA-VERIFY-121-01" },
    process_capacity: { 生产顺序明细: [{ 餐段: "午餐", 顺序: "生食→熟食→即食", 记录编号: "QA-SEQ-121-01" }, { 餐段: "晚餐", 顺序: "过敏原订单隔离→普通订单", 记录编号: "QA-SEQ-121-02" }] },
  },
  122: {
    supplier: { 候选供应商明细: [{ 供应商主体: "QA-S122-A", 生产地点: "QA供应地点A", 许可证台账: "QA-LIC-122-A", 供应风险: "中" }, { 供应商主体: "QA-S122-B", 生产地点: "QA供应地点B", 许可证台账: "QA-LIC-122-B", 供应风险: "中" }], 产品风险分级: "QA高风险原料需逐批验收" },
    procurement: { 采购证据明细: [{ 供应商主体: "QA-S122-A", 采购单: "QA-PO-122-A", 发票批次: "QA-INV-122-A", 采购价元公斤: 12, 批次: "QA-LOT-122-A" }, { 供应商主体: "QA-S122-B", 采购单: "QA-PO-122-B", 发票批次: "QA-INV-122-B", 采购价元公斤: 13, 批次: "QA-LOT-122-B" }] },
    inventory_batch: { 收货批次明细: [{ 批次: "QA-LOT-122-A", 收货日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE, 温度记录: "QA-TEMP-122-A", 去向: "QA库位A" }, { 批次: "QA-LOT-122-B", 收货日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE, 温度记录: "QA-TEMP-122-B", 去向: "QA库位B" }] },
    logistics: { 收货验收明细: [{ 供应商: "QA-S122-A", 收货区域: "QA后场收货区", 交接记录: "QA-LOG-122-A", 判定: "QA待授权放行" }, { 供应商: "QA-S122-B", 收货区域: "QA后场收货区", 交接记录: "QA-LOG-122-B", 判定: "QA待授权放行" }] },
    quality_audit: { 供应商偏差明细: [{ 编号: "QA-NC-122-01", 供应商: "QA-S122-A", 偏差: "QA文件缺项", CAPA: "限期补证" }], 审核日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
  },
  123: {
    traceability_recall: { 追溯演练明细: [{ 事件产品: "QA产品A", 追溯码: "QA-TRACE-123-A", 生产批: "QA-PROD-123-A", 使用记录: "QA-USE-123-A", 去向: "QA-TY-A", 已售数量: 42, 召回演练日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }, { 事件产品: "QA产品B", 追溯码: "QA-TRACE-123-B", 生产批: "QA-PROD-123-B", 使用记录: "QA-USE-123-B", 去向: "QA-TY-A", 已售数量: 38, 召回演练日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }], 事件编号: "QA-INC-123-01", 数据类别: "synthetic_qa" },
    inventory_batch: { 批次明细: [{ 批次: "QA-LOT-123-A", 追溯码: "QA-TRACE-123-A", 效期: "2026-08-15", 库位: "QA-COLD-A01" }, { 批次: "QA-LOT-123-B", 追溯码: "QA-TRACE-123-B", 效期: "2026-08-16", 库位: "QA-COLD-A02" }] },
    systems_data: { 追溯字段字典: "QA-TRACE-DICT-123", POS批次: "QA-POS-123", ERP批次: "QA-ERP-123", 导出批次: "QA-EXPORT-123" },
    customer_feedback: { 顾客通知模板: "QA-NOTICE-123", 联系方式: "仅使用QA联系树，不含顾客个人信息" },
    risk_incident: { 召回联系人树: "QA-CONTACT-123", 隔离动作卡: "QA-ISOLATE-123", RTO小时: 4 },
  },
  124: {
    quality_audit: { 审核计划明细: [{ 审核编号: "QA-AUDIT-124-01", 范围: "QA收货与储存", 审核员: "QA-AUDITOR-01", 抽样限制: "QA三批次", 审核日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }, { 审核编号: "QA-AUDIT-124-02", 范围: "QA热加工与温控", 审核员: "QA-AUDITOR-02", 抽样限制: "QA两餐段", 审核日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }], 不符合明细: [{ 编号: "QA-NC-124-01", 严重度: "中", 客观事实: "QA记录缺项", CAPA责任人: "QA_OWNER", 截止日期: "2026-08-07" }], CAPA台账: "QA-CAPA-124-V1" },
    systems_data: { 记录清单: "QA-RECORD-124-V1", 审核证据索引: "QA-INDEX-124-V1" },
    food_safety: { 审核准则版本: "QA-FOOD-124-V1", 抽样方案: "QA-SAMPLE-124-01" },
    workforce: { 审核员能力明细: [{ 员工编号: "QA-AUDITOR-01", 能力: "QA文件审核", 独立性: "与被审岗位分离" }, { 员工编号: "QA-AUDITOR-02", 能力: "QA现场观察", 独立性: "与被审岗位分离" }] },
    incident_action_confidentiality: { 审核记录编号: "QA-INC-124-01", 公开限制: "仅QA授权审阅人可见", 事件原文: "QA审核事实记录" },
  },
  125: {
    supplier: {
      候选供应商明细: [
        { 供应商主体: "QA-S125-A", 生产地点: "QA供应地点A", 产能吨月: 20, 分包商: "无", 证据编号: "QA-125-SUP-A", 证据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
        { 供应商主体: "QA-S125-B", 生产地点: "QA供应地点B", 产能吨月: 18, 分包商: "QA分包记录B", 证据编号: "QA-125-SUP-B", 证据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
      ],
      供应商主体: "QA-S125-A",
      生产地点: "QA供应地点A",
      供应风险: "中",
      评审批次: "QA-SUP-125-V1",
    },
    procurement: { 供应商评审明细: [{ 供应商主体: "QA-S125-A", 报价元公斤: 12, 交期天: 2, 质量得分: 88 }, { 供应商主体: "QA-S125-B", 报价元公斤: 13, 交期天: 3, 质量得分: 86 }] },
    quality_audit: { 尽调证据包: "QA-DD-125-V1", 审核日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE, 状态: "QA待授权准入" },
    approval_authority: { 审批人: "QA_OWNER", 审批权限: "仅准入草案", 复审触发器: "质量/交付/召回偏差" },
  },
  126: {
    procurement: {
      报价明细: [
        { 供应商主体: "QA-S126-A", 采购单: "QA-QUOTE-126-A", 报价元公斤: 12, 币种: "CNY", 税费: "含税", 运费元: 80, 交期天: 2, 起订量公斤: 50, 报价有效期: "2026-08-15", 证据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
        { 供应商主体: "QA-S126-B", 采购单: "QA-QUOTE-126-B", 报价元公斤: 12.5, 币种: "CNY", 税费: "含税", 运费元: 60, 交期天: 3, 起订量公斤: 40, 报价有效期: "2026-08-15", 证据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
        { 供应商主体: "QA-S126-C", 采购单: "QA-QUOTE-126-C", 报价元公斤: 13, 币种: "CNY", 税费: "含税", 运费元: 45, 交期天: 2, 起订量公斤: 60, 报价有效期: "2026-08-15", 证据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
      ],
      规格书版本: "QA-SPEC-126-V1",
      评标口径: "单位、税费、物流、出成率统一",
    },
    supplier: { 供应商主体: "QA-S126-A", 生产地点: "QA供应地点A", 供应风险: "中" },
    product_menu: { 采购规格明细: [{ 品类: "QA主料", 等级: "QA标准级", 包装: "QA食品接触包装", 储运条件: "QA冷藏" }] },
    quality_audit: { 样品验收明细: [{ 供应商主体: "QA-S126-A", 批次: "QA-SAMPLE-126-A", 结果: "QA待复核" }, { 供应商主体: "QA-S126-B", 批次: "QA-SAMPLE-126-B", 结果: "QA待复核" }, { 供应商主体: "QA-S126-C", 批次: "QA-SAMPLE-126-C", 结果: "QA待复核" }] },
  },
  127: {
    inventory_batch: {
      SKU补货明细: [
        { SKU: "QA-SKU-127-A", 净销量: 420, 可用库存: 110, 在途数量: 40, 单位耗用: 0.2, 交期天: 2, 包装倍数: 10, 安全库存: 60, 盘点日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
        { SKU: "QA-SKU-127-B", 净销量: 360, 可用库存: 90, 在途数量: 30, 单位耗用: 0.15, 交期天: 3, 包装倍数: 12, 安全库存: 45, 盘点日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
      ],
      批次: "QA-INV-127-V1",
      效期: "2026-08-15",
    },
    orders_demand: { SKU补货明细: [{ SKU: "QA-SKU-127-A", 净销量: 420, 需求期间: "2026-08-01/2026-08-07", 预测版本: "QA-DMD-127-A" }, { SKU: "QA-SKU-127-B", 净销量: 360, 需求期间: "2026-08-01/2026-08-07", 预测版本: "QA-DMD-127-B" }] },
    recipe_ingredient: { 单位耗用明细: [{ SKU: "QA-SKU-127-A", 单位耗用: 0.2, 配方版本: "QA-R127-A" }, { SKU: "QA-SKU-127-B", 单位耗用: 0.15, 配方版本: "QA-R127-B" }] },
    procurement: { 交期包装明细: [{ SKU: "QA-SKU-127-A", 交期天: 2, 包装倍数: 10, 配送日: "2026-08-01" }, { SKU: "QA-SKU-127-B", 交期天: 3, 包装倍数: 12, 配送日: "2026-08-02" }] },
  },
  128: {
    logistics: { 收货验收明细: [{ 收货批次: "QA-LOT-128-A", 收货日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE, 供应商: "QA-S128-A", 温度记录: "QA-TEMP-128-A", 判定: "QA待授权放行" }, { 收货批次: "QA-LOT-128-B", 收货日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE, 供应商: "QA-S128-B", 温度记录: "QA-TEMP-128-B", 判定: "QA隔离待判" }], 收货区域: "QA后场收货区" },
    inventory_batch: { FEFO库位明细: [{ 批次: "QA-LOT-128-A", 库位: "QA-COLD-A01", 效期: "2026-08-10", 开封日: "2026-07-31", 物料状态: "合格区" }, { 批次: "QA-LOT-128-B", 库位: "QA-HOLD-01", 效期: "2026-08-08", 开封日: "2026-07-31", 物料状态: "隔离区" }], 盘点日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
    equipment: { 检具明细: [{ 设备: "QA探针-128-01", 校准状态: "QA有效记录", 校准日期: "2026-07-20" }, { 设备: "QA秤-128-01", 校准状态: "QA有效记录", 校准日期: "2026-07-20" }] },
    quality_audit: { 收货抽查明细: [{ 批次: "QA-LOT-128-A", 抽查项目: "标签/批次/包装", 结果: "QA通过", 日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }, { 批次: "QA-LOT-128-B", 抽查项目: "温控/文件", 结果: "QA隔离", 日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }] },
    cleaning_hygiene: { 收货区清洁记录: "QA-CLEAN-128-01", 隔离区清洁记录: "QA-CLEAN-128-02" },
  },
  129: {
    inventory_batch: {
      期初实盘: 320,
      期末实盘: 290,
      采购数量: 180,
      调入数量: 20,
      调出数量: 10,
      领用数量: 170,
      理论耗用: 165,
      报损数量: 8,
      盘点日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
      批次: "QA-INV-129-V1",
      流水明细: [{ 类型: "采购", 数量: 180, 流水号: "QA-129-PO-01" }, { 类型: "调拨", 数量: 20, 流水号: "QA-129-MOVE-01" }, { 类型: "领用", 数量: 170, 流水号: "QA-129-USE-01" }, { 类型: "报损", 数量: 8, 流水号: "QA-129-WASTE-01" }],
    },
    orders_demand: { POS净销量: 820, 菜品耗用版本: "QA-RECIPE-129-V1", 期间: "2026-07-01/2026-07-31" },
    recipe_ingredient: { 理论耗用明细: [{ 原料: "QA原料A", 菜品净销量: 420, 标准耗用: 0.2, 版本: "QA-R129-A" }, { 原料: "QA原料B", 菜品净销量: 400, 标准耗用: 0.15, 版本: "QA-R129-B" }] },
    quality_audit: { 盘点质量明细: [{ 盘点人: "QA-COUNTER-01", 复核人: "QA-REVIEWER-01", 秤具: "QA-SCALE-129", 日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE }], 差异状态: "QA待授权调整" },
    systems_data: { 库存调整日志: "QA-ADJUST-129-01", 权限日志: "QA-PERM-129-01" },
  },
  130: {
    orders_demand: {
      小时需求明细: [
        { 时段: "11:00-12:00", 菜品: "QA菜品A", 需求份数: 42, 工位: "热厨1", 产能份每小时: 55, 数据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
        { 时段: "12:00-13:00", 菜品: "QA菜品A", 需求份数: 68, 工位: "热厨1", 产能份每小时: 55, 数据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
        { 时段: "12:00-13:00", 菜品: "QA菜品B", 需求份数: 44, 工位: "冷菜台", 产能份每小时: 48, 数据日期: RESTAURANT_OPERATIONAL_FIXTURE_DATE },
      ],
      分时需求明细: [
        { 时段: "13:00-14:00", SKU: "QA-SKU-130-A", 订单数: 36, 工位: "热厨1", 产能份每小时: 55 },
        { 时段: "18:00-19:00", SKU: "QA-SKU-130-B", 需求份数: 38, 工位: "冷菜台", 产能份每小时: 48 },
      ],
      预测版本: "QA-DMD-130-V1",
    },
    process_capacity: {
      分时需求明细: [
        { 时段: "11:00-12:00", 菜品: "QA菜品A", 需求份数: 42, 工位: "热厨1", 产能份每小时: 55 },
        { 时段: "12:00-13:00", 菜品: "QA菜品B", 需求份数: 44, 工位: "冷菜台", 产能份每小时: 48 },
      ],
      工位明细: [{ 工位: "热厨1", 产能份每小时: 55, 冷却容量份: 80 }, { 工位: "冷菜台", 产能份每小时: 48, 冷藏容量份: 60 }],
      计划版本: "QA-PROD-130-V1",
    },
    product_menu: { 配方版本明细: [{ 菜品: "QA菜品A", 配方版本: "QA-R130-A", 出成率: "80%" }, { 菜品: "QA菜品B", 配方版本: "QA-R130-B", 出成率: "78%" }] },
    inventory_batch: { 在库批次明细: [{ 批次: "QA-LOT-130-A", 可安全使用数量: 80, 效期: "2026-08-02", 库位: "QA-COLD-A01" }, { 批次: "QA-LOT-130-B", 可安全使用数量: 60, 效期: "2026-08-03", 库位: "QA-COLD-A02" }] },
    workforce: { 工位技能明细: [{ 工位: "热厨1", 班次: "午餐", 技能: "QA热加工", 员工编号: "QA-EMP-130-01" }, { 工位: "冷菜台", 班次: "午餐", 技能: "QA冷加工", 员工编号: "QA-EMP-130-02" }] },
  },
});

// Public read-only view for deterministic fixture tests and audit tooling.
export const RESTAURANT_OPERATIONAL_FIXTURE_FACTS_101_130 =
  FIXTURE_FACTS_BY_INDEX;

function mergeQaRegulatoryProof(materialEvidence, idx) {
  const qaFacts = qaRegulatoryFacts(idx);
  if (!qaFacts || !Array.isArray(materialEvidence)) return materialEvidence;
  const evidenceId = qaFacts.证据编号;
  return materialEvidence.map((record) => {
    const fields = record?.fields && typeof record.fields === "object" && !Array.isArray(record.fields)
      ? record.fields
      : null;
    const facts = fields?.facts && typeof fields.facts === "object" && !Array.isArray(fields.facts)
      ? fields.facts
      : record?.facts && typeof record.facts === "object" && !Array.isArray(record.facts)
        ? record.facts
        : null;
    const regulation = facts?.regulation;
    if (!regulation || typeof regulation !== "object" || Array.isArray(regulation)) return record;

    const originalBlockers = Array.isArray(record.regulationBlockers) && record.regulationBlockers.length
      ? [...record.regulationBlockers]
      : Array.isArray(regulation.阻塞原因)
        ? [...regulation.阻塞原因]
        : [...(QA_REGULATORY_REAL_WORLD_BLOCKERS[idx] || [])];
    const mergedRegulation = {
      ...clone(regulation),
      ...clone(qaFacts),
      realWorldBlockers: originalBlockers,
      阻塞原因: [QA_ONLY_NO_GENERATION_BLOCKER],
    };
    const qaEvidence = {
      qa: true,
      qaTag: "QA_ONLY",
      qaOnlyRegulatoryProof: true,
      evidenceId,
      evidenceDate: RESTAURANT_OPERATIONAL_FIXTURE_DATE,
      source: QA_SOURCE,
      externalCall: false,
      originalOperationalBlockers: originalBlockers,
      businessAdoption: "BLOCKED",
      externalExecution: "BLOCKED",
      legalConclusion: "未形成",
      prohibitedUse: mergedRegulation.禁止用途,
    };
    const mergedFields = fields
      ? { ...fields, facts: { ...facts, regulation: mergedRegulation }, qa: { ...(fields.qa || {}), ...qaEvidence } }
      : null;
    return {
      ...record,
      ...(mergedFields ? { fields: mergedFields } : { facts: { ...facts, regulation: mergedRegulation } }),
      qaOnlyRegulatoryProof: true,
      qaOperationalFacts: true,
      qaEvidence,
      // READY is meaningful only to the isolated QA task-generation gate.
      // Keep the real-world blockers visible for reports and human review.
      operationalReady: true,
      regulationBlockers: [],
      realWorldBlockers: originalBlockers,
      regulationEvidence: "QA_ONLY_SYNTHETIC_TASK_READY_EXTERNAL_BLOCKED",
    };
  });
}

/**
 * Return a new materialEvidence array with deterministic QA records for the
 * requested restaurant employee. Input evidence is cloned and never mutated.
 * Supports `{ idx, materialEvidence }`, `(idx, materialEvidence)`, and
 * `(materialEvidence, idx)` calls. Unknown indices simply receive a clone.
 */
function normalizeAugmentationArgs(first, second) {
  if (Array.isArray(first)) {
    return { idx: Number(second), materialEvidence: first };
  }
  if (typeof first === "number" || typeof first === "string") {
    return { idx: Number(first), materialEvidence: second };
  }
  if (first && typeof first === "object") {
    return { idx: Number(first.idx), materialEvidence: first.materialEvidence };
  }
  return { idx: Number.NaN, materialEvidence: second };
}

export function augmentRestaurantOperationalFixtures101To130(first, second) {
  const { idx, materialEvidence } = normalizeAugmentationArgs(first, second);
  const numericIdx = Number(idx);
  const existing = Array.isArray(materialEvidence)
    ? materialEvidence.map(clone)
    : [];
  const facts = FIXTURE_FACTS_BY_INDEX[numericIdx];
  if (!facts) return existing;
  const withRegulatoryProof = mergeQaRegulatoryProof(existing, numericIdx);
  const hasRegulatoryRecord = withRegulatoryProof.some(
    (record) => record?.fields?.facts?.regulation || record?.facts?.regulation,
  );
  return [
    ...withRegulatoryProof,
    // For the ten current-regulation employees, the existing regulation row
    // already receives the QA-only proof above.  Do not duplicate that large
    // payload into a non-regulation input, which would only bloat the prompt.
    qaRecord(
      numericIdx,
      facts,
      "restaurant_task_material",
      !QA_REGULATORY_INDEXES.has(numericIdx) || !hasRegulatoryRecord,
    ),
  ];
}

// Short aliases make the helper easy to integrate without coupling callers
// to the historical filename.
export const augmentRestaurantOperationalFixtures =
  augmentRestaurantOperationalFixtures101To130;
export const augmentRestaurantMaterialEvidence101To130 =
  augmentRestaurantOperationalFixtures101To130;

export function restaurantOperationalFixtureRecordId(idx) {
  const numericIdx = Number(idx);
  return FIXTURE_FACTS_BY_INDEX[numericIdx]
    ? `QA-RRI-${numericIdx}-01`
    : null;
}

export default augmentRestaurantOperationalFixtures101To130;

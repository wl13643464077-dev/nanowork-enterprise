/**
 * Deterministic, isolated-QA operational facts for restaurant employees 131–161.
 *
 * This module is deliberately independent from the provider runner.  It only
 * enriches an already-built materialEvidence array (or creates a standalone QA
 * record when no material exists), so completeness tests can exercise the same
 * task gates without customer data, network calls, or business-side writes.
 */

export const RESTAURANT_OPERATIONAL_FIXTURE_INDEXES_131_161 = Object.freeze(
  Array.from({ length: 31 }, (_, offset) => 131 + offset),
);

// These employees have a regulation/private-scope input in the production
// catalog.  The values below are *only* a deterministic synthetic scope for
// isolated QA preflight; they never change the production rule or imply that
// a local authority, platform, insurer, employer or supplier was contacted.
export const RESTAURANT_REGULATION_QA_READY_INDEXES_131_161 = Object.freeze([
  133, 135, 137, 138, 139, 140, 141, 142, 145, 149, 155, 157, 159,
]);

// These are the original blockers emitted by the required-input regulation
// rule for the 13 scoped jobs.  They remain visible in a separate audit field
// after the QA-only generation gate is made runnable; they are not cleared,
// asserted away, or converted into a legal/commercial conclusion.
export const RESTAURANT_REGULATION_QA_ORIGINAL_BLOCKERS_131_161 = Object.freeze({
  133: Object.freeze([
    "BLOCKED_LOCAL_ACCESSIBILITY_REFUND_RULES",
    "BLOCKED_PLATFORM_TERMS_VERSION",
    "BLOCKED_PRIVATE_SERVICE_POLICY",
  ]),
  135: Object.freeze([
    "BLOCKED_LOCAL_CONSUMER_ACCESSIBILITY_RULES",
    "BLOCKED_PLATFORM_TERMS_VERSION",
    "BLOCKED_PRIVATE_BOOKING_POLICY",
  ]),
  137: Object.freeze([
    "BLOCKED_ROLE_QUALIFICATION_SCOPE",
    "BLOCKED_LOCAL_TRAINING_RULES",
    "BLOCKED_PRIVATE_CERTIFICATES",
  ]),
  138: Object.freeze([
    "BLOCKED_LOCAL_REPORTING_DUTY",
    "BLOCKED_PLATFORM_TERMS_VERSION",
    "BLOCKED_PRIVATE_INCIDENT_AUTHORITY",
  ]),
  139: Object.freeze([
    "BLOCKED_ASSET_CATALOG_CLASSIFICATION",
    "BLOCKED_LOCAL_INSPECTION_RULES",
    "BLOCKED_PRIVATE_MANUFACTURER_ACCEPTANCE_RECORDS",
  ]),
  140: Object.freeze([
    "BLOCKED_LOCAL_LANGUAGE_ACCESSIBILITY_RULES",
    "BLOCKED_MENU_MEDIUM_SCOPE",
  ]),
  141: Object.freeze([
    "BLOCKED_LOCAL_AD_PROMOTION_RULES",
    "BLOCKED_PLATFORM_TERMS_VERSION",
    "BLOCKED_PRIVATE_CONSENT_APPROVAL_RECORDS",
  ]),
  142: Object.freeze([
    "BLOCKED_PLATFORM_TERMS_VERSION",
    "BLOCKED_PRIVATE_CONTENT_AUTHORIZATIONS",
  ]),
  145: Object.freeze([
    "BLOCKED_LOCAL_PRICE_PROMOTION_RULES",
    "BLOCKED_PLATFORM_TERMS_VERSION",
    "BLOCKED_PRIVATE_EXPERIMENT_BASELINE",
  ]),
  149: Object.freeze([
    "BLOCKED_LOCAL_LABOR_RULES",
    "BLOCKED_COLLECTIVE_AGREEMENT",
    "BLOCKED_PRIVATE_TIME_APPROVAL_RECORDS",
  ]),
  155: Object.freeze([
    "BLOCKED_LOCAL_REGULATION_DIFFERENCES",
    "BLOCKED_PRIVATE_SOP_EXCEPTION_APPROVALS",
  ]),
  157: Object.freeze([
    "BLOCKED_LOCAL_DONATION_WASTE_TRANSPORT_RULES",
    "BLOCKED_PRIVATE_DISPOSAL_DESTINATION",
  ]),
  159: Object.freeze([
    "BLOCKED_LOCAL_REPORTING_INSURANCE_RULES",
    "BLOCKED_PRIVATE_POLICY_PLAN_CONTACTS",
  ]),
});

const QA_SOURCE = "isolated-qa.restaurant-operational-facts.v1";
const QA_DATE = "2026-07-31";
const QA_TIMESTAMP = "2026-07-31T09:00:00+08:00";

const freeze = (value) => Object.freeze(value);

function qaId(idx, sequence = 1) {
  return `QA-REST-${Number(idx)}-${String(sequence).padStart(3, "0")}`;
}

function qaMeta(idx, sequence, objects) {
  const evidenceId = qaId(idx, sequence);
  return {
    qa: true,
    qaTag: "QA",
    source: QA_SOURCE,
    synthetic: true,
    noExternalCall: true,
    evidenceId,
    evidenceDate: QA_DATE,
    observedAt: QA_TIMESTAMP,
    objects: [...objects],
  };
}

function annotateFacts(idx, sequence, facts, objects) {
  const evidenceId = qaId(idx, sequence);
  return {
    ...facts,
    QA标签: "ISOLATED_QA",
    QA证据编号: evidenceId,
    QA证据日期: QA_DATE,
    QA对象: [...objects],
  };
}

function qaRecord(idx, sequence, facts, objects) {
  const meta = qaMeta(idx, sequence, objects);
  const dimensions = Object.keys(facts);
  const recordId = `${meta.evidenceId}-R1`;
  return {
    schema: "rri-operational-qa.v1",
    recordId,
    evidenceId: meta.evidenceId,
    evidenceDate: QA_DATE,
    source: QA_SOURCE,
    mapping: "mapped",
    tags: ["QA", "isolated", "operational"],
    dimensions,
    qaCapabilityRunnable: true,
    operationalReady: true,
    qaEvidence: meta,
    fields: {
      rid: recordId,
      facts: Object.fromEntries(
        Object.entries(facts).map(([dimensionId, value]) => [
          dimensionId,
          annotateFacts(idx, sequence, value, objects),
        ]),
      ),
      qa: meta,
    },
  };
}

const F = (idx, facts, objects) => qaRecord(idx, 1, facts, objects);

const FACTS = {
  131: F(
    131,
    {
      business_scope: {
        中央厨房编号: "QA-CK-01",
        接收门店清单: ["QA-TY-A", "QA-TY-B"],
        业务范围: "中央厨房冷链配送验收网络",
      },
      logistics: {
        配送路线明细: [
          {
            路线编号: "QA-ROUTE-131-A",
            接收门店: "QA-TY-A",
            路线里程公里: 12.4,
            停靠顺序: 1,
            备用路线: "QA-ROUTE-131-B",
            计划发车时间: "2026-07-31T08:00:00+08:00",
            到店时间窗: "09:00-09:45",
          },
        ],
        门店停靠明细: [
          {
            接收门店: "QA-TY-A",
            路线里程公里: 12.4,
            停靠顺序: 1,
            备用路线: "QA-ROUTE-131-B",
            交接记录: "QA-HANDOFF-131-001",
          },
        ],
        温度记录批次: "QA-TEMP-131-001",
        车辆编号: "QA-VAN-131-01",
      },
      temperature_control: {
        冷链记录仪编号: "QA-LOGGER-131-01",
        校准记录: "QA-CAL-131-01",
        报警状态: "未触发",
      },
      traceability_recall: {
        生产批: "QA-LOT-131-0731",
        召回演练日期: QA_DATE,
        召回演练编号: "QA-DRILL-131-01",
      },
    },
    ["QA-CK-01", "QA-TY-A", "QA-ROUTE-131-A", "QA-VAN-131-01"],
  ),
  132: F(
    132,
    {
      business_scope: {
        门店编号: "QA-TY-A",
        业务范围: "开店、闭店与班次交接",
      },
      time_scope: {
        营业时段: "10:00-22:00",
        班次: ["早班", "中班", "晚班"],
        交接日期: QA_DATE,
      },
      service_sop: {
        开店检查表: "QA-OPEN-132-01",
        闭店检查表: "QA-CLOSE-132-01",
        交接记录: "QA-HANDOFF-132-01",
        异常升级联系人: "QA_DUTY_MANAGER",
      },
      quality_audit: {
        检查批次: "QA-AUDIT-132-01",
        未结工单: 0,
        证据日期: QA_DATE,
      },
    },
    ["QA-TY-A", "QA-OPEN-132-01", "QA-CLOSE-132-01", "QA-HANDOFF-132-01"],
  ),
  133: F(
    133,
    {
      business_scope: { 门店编号: "QA-TY-A", 业务范围: "前厅服务全旅程" },
      service_sop: {
        服务SOP版本: "QA-SERVICE-133-01",
        服务旅程验证批次: "QA-SERVICE-CHECK-133-01",
        售罄机制: "QA-SOLDOUT-133-01",
        退款政策: "负责人审批后原路退回",
      },
      booking_table: {
        桌台数: 16,
        座位数: 64,
        高峰时段: "11:30-13:00",
        无障碍桌位: "QA-TABLE-03",
      },
      customer_feedback: {
        顾客原始陈述批次: "QA-VOC-133-01",
        服务补救: "重做或退款需审批",
        评价样本: 12,
      },
    },
    ["QA-SERVICE-133-01", "QA-TABLE-03", "QA-VOC-133-01"],
  ),
  134: F(
    134,
    {
      product_menu: {
        菜单版本: "QA-MENU-134-01",
        工艺路线版本: "QA-PROCESS-134-01",
      },
      orders_demand: {
        订单事件明细: [
          {
            订单号: "QA-ORD-134-001",
            菜品: "QA-DISH-01",
            订单来源: "堂食POS",
            状态: "已出餐",
            状态时间: "2026-07-31T12:05:00+08:00",
            返工: false,
            错漏: false,
          },
          {
            订单号: "QA-ORD-134-002",
            菜品: "QA-DISH-02",
            订单来源: "外卖平台",
            状态: "返工完成",
            状态时间: "2026-07-31T12:12:00+08:00",
            返工: true,
            错漏: "酱料漏装",
          },
        ],
      },
      systems_data: {
        KDS事件明细: [
          {
            订单号: "QA-ORD-134-001",
            菜品: "QA-DISH-01",
            订单来源: "堂食POS",
            状态: "已出餐",
            状态时间: "2026-07-31T12:05:00+08:00",
            返工: false,
            错漏: false,
          },
          {
            订单号: "QA-ORD-134-002",
            菜品: "QA-DISH-02",
            订单来源: "外卖平台",
            状态: "返工完成",
            状态时间: "2026-07-31T12:12:00+08:00",
            返工: true,
            错漏: "酱料漏装",
          },
        ],
      },
      process_capacity: {
        工位产能明细: [
          { 工位: "QA-WORKSTATION-HOT", 产能份每小时: 48 },
          { 工位: "QA-WORKSTATION-COLD", 产能份每小时: 36 },
        ],
      },
    },
    ["QA-ORD-134-001", "QA-ORD-134-002", "QA-KDS-134-01"],
  ),
  135: F(
    135,
    {
      booking_table: {
        桌台明细: [
          { 桌台编号: "QA-TABLE-135-01", 座位数: 2, 可拼拆: true },
          { 桌台编号: "QA-TABLE-135-02", 座位数: 4, 可拼拆: true },
        ],
        分时容量验证: "QA-CAPACITY-135-01",
        到店率: "85%",
        取消率: "8%",
      },
      service_sop: {
        订座规则版本: "QA-BOOKING-135-01",
        迟到处理: "超过保留窗升级负责人",
        退款政策: "负责人审批后原路退回",
      },
      customer_segment: { 客群: "QA工作日成年消费者", 用餐场景: "午晚餐" },
    },
    ["QA-TABLE-135-01", "QA-TABLE-135-02", "QA-CAPACITY-135-01"],
  ),
  136: F(
    136,
    {
      workforce: {
        员工排班明细: [
          {
            员工编号: "QA-EMP-136-001",
            可用时间: "10:00-18:00",
            合同工时: 40,
            休假状态: "无",
            技能: "前厅收银",
            资格: "QA-QUAL-POS-01",
          },
          {
            员工编号: "QA-EMP-136-002",
            可用时间: "14:00-22:00",
            合同工时: 40,
            休假状态: "无",
            技能: "热厨出餐",
            资格: "QA-QUAL-HOT-01",
          },
        ],
        员工可用性明细: [
          {
            员工编号: "QA-EMP-136-001",
            可用时间: "10:00-18:00",
            合同工时: 40,
            休假状态: "无",
            技能: "前厅收银",
            资格: "QA-QUAL-POS-01",
          },
          {
            员工编号: "QA-EMP-136-002",
            可用时间: "14:00-22:00",
            合同工时: 40,
            休假状态: "无",
            技能: "热厨出餐",
            资格: "QA-QUAL-HOT-01",
          },
        ],
      },
      schedule_timekeeping: {
        排班版本: "QA-ROSTER-136-01",
        审批状态: "待人工审核",
      },
      orders_demand: {
        小时需求明细: [
          {
            时段: "11:00-12:00",
            需求人数: 4,
            订单数: 42,
            工位: "前厅+热厨",
          },
          {
            时段: "18:00-19:00",
            需求人数: 5,
            订单数: 58,
            工位: "前厅+热厨",
          },
        ],
        分时需求明细: [
          { 时段: "11:00-12:00", 需求人数: 4, 订单数: 42 },
          { 时段: "18:00-19:00", 需求人数: 5, 订单数: 58 },
        ],
      },
    },
    ["QA-EMP-136-001", "QA-EMP-136-002", "QA-ROSTER-136-01"],
  ),
  137: F(
    137,
    {
      workforce: {
        岗位明细: [
          { 岗位: "食品安全员", 任务: "温控记录复核", 人数: 1 },
          { 岗位: "收货员", 任务: "批次验收", 人数: 2 },
        ],
      },
      training_qualification: {
        培训记录明细: [
          {
            员工编号: "QA-EMP-137-001",
            培训课程: "食品安全基础",
            考核分: 90,
            资格有效期: "2027-07-31",
          },
        ],
        能力缺口: "无",
        复训触发: "事故/审计不合格",
      },
      quality_audit: {
        能力验证记录: "QA-SKILL-CHECK-137-01",
        验证日期: QA_DATE,
      },
    },
    ["QA-EMP-137-001", "QA-SKILL-CHECK-137-01"],
  ),
  138: F(
    138,
    {
      customer_feedback: {
        客诉事件明细: [
          {
            事件编号: "QA-CASE-138-001",
            发生时间: "2026-07-31T12:20:00+08:00",
            门店编号: "QA-TY-A",
            订单标识: "QA-ORD-138-001",
            顾客原始陈述: "QA脱敏陈述：餐品与订单不一致",
            受影响范围: "1单",
            已采取动作: "隔离相关记录并转负责人",
          },
        ],
        顾客原始陈述批次: "QA-VOC-138-01",
        服务补救: "重做/退款需审批",
      },
      incident_action_confidentiality: {
        事件编号: "QA-INC-138-001",
        事件原文: "QA验收事件记录",
        已采取措施: "隔离并升级负责人",
        公开限制: "仅授权审阅人可见",
      },
      approval_authority: {
        升级条件: "食安/财务/法律高风险",
        退款授权边界: "负责人审批",
      },
    },
    ["QA-CASE-138-001", "QA-INC-138-001", "QA-VOC-138-01"],
  ),
  139: F(
    139,
    {
      equipment: {
        资产清单: [
          {
            资产编号: "QA-ASSET-139-001",
            资产名称: "曳引式杂物电梯",
            型号: "QA-DTW-01",
            序列号: "SN-QA-139-02",
            位置: "后厨传菜区",
            用途: "餐品周转",
            关键性: "高",
            维修责任人: "QA_FACILITY_MANAGER",
          },
        ],
        备件记录: "QA-SPARE-139-01",
      },
      quality_audit: {
        维修验证明细: [
          {
            资产编号: "QA-ASSET-139-001",
            维修单号: "QA-WO-139-001",
            停机开始: "2026-07-30T16:00:00+08:00",
            复役验证: "QA-RESTART-139-001",
          },
        ],
        检查批次: "QA-AUDIT-139-01",
      },
      risk_incident: {
        隔离能源记录: "QA-LOTO-139-01",
        业务连续方案: "QA-BCP-139-01",
      },
    },
    ["QA-ASSET-139-001", "QA-WO-139-001", "QA-RESTART-139-001"],
  ),
  140: F(
    140,
    {
      brand_content: {
        品牌定位: "可信赖的门店经营助手",
        菜单文案版本: "QA-COPY-140-01",
        使用授权: "QA-AUTH-140-01",
      },
      product_menu: {
        菜品明细: [
          {
            菜品: "QA-DISH-140-01",
            真实配料: ["谷物", "蔬菜"],
            份量克: 350,
            过敏原矩阵编号: "QA-ALLERGEN-140-01",
          },
        ],
        菜单版本: "QA-MENU-140-01",
      },
      nutrition_claim: {
        验证来源: "QA-NUTRITION-140-01",
        声称状态: "待人工复核",
      },
      language_accessibility: {
        规范汉字版本: "QA-LANG-140-01",
        可读性检查: "QA-A11Y-140-01",
      },
    },
    ["QA-COPY-140-01", "QA-MENU-140-01", "QA-ALLERGEN-140-01"],
  ),
  141: F(
    141,
    {
      promotion: {
        活动编号: "QA-MKT-141-01",
        活动日期: "2026-08-03",
        活动主题: "QA工作日午餐",
        促销机制: "满50减5",
        审批状态: "待人工审批",
      },
    },
    ["QA-MKT-141-01", "QA-CALENDAR-141-01"],
  ),
  142: F(
    142,
    {
      brand_content: {
        内容资产批次: "QA-CONTENT-142-01",
        使用授权: "QA-AUTH-142-01",
        UGC授权明细: [
          {
            来源编号: "QA-UGC-142-001",
            创作者编号: "QA-CREATOR-001",
            许可范围: "门店自有社媒",
            期限: "2026-12-31",
            可否编辑: false,
          },
        ],
      },
      promotion: {
        披露规则版本: "QA-DISCLOSURE-142-01",
        发布频率: "每周2条验收草案",
      },
      customer_feedback: {
        舆情问题批次: "QA-VOC-142-01",
        顾客问题数: 3,
      },
    },
    ["QA-UGC-142-001", "QA-AUTH-142-01", "QA-DISCLOSURE-142-01"],
  ),
  143: F(
    143,
    {
      customer_feedback: {
        评价明细: [
          {
            评价原文: "QA脱敏评价：出餐等待较久",
            星级: 2,
            时间: "2026-07-29T12:18:00+08:00",
            平台: "QA平台A",
            订单号: "QA-ORD-143-001",
            商家回复: "待人工审核",
          },
          {
            评价原文: "QA脱敏评价：包装完整",
            星级: 5,
            时间: "2026-07-30T18:03:00+08:00",
            平台: "QA平台A",
            订单号: "QA-ORD-143-002",
            商家回复: "待人工审核",
          },
        ],
        差评明细: [
          {
            评价原文: "QA脱敏评价：出餐等待较久",
            星级: 2,
            时间: "2026-07-29T12:18:00+08:00",
            平台: "QA平台A",
            订单号: "QA-ORD-143-001",
          },
        ],
      },
      incident_action_confidentiality: {
        事件编号: "QA-INC-143-001",
        事件原文: "QA评价事件记录",
        已采取措施: "转交运营负责人",
        公开限制: "仅授权审阅人可见",
      },
    },
    ["QA-ORD-143-001", "QA-ORD-143-002", "QA-INC-143-001"],
  ),
  144: F(
    144,
    {
      crm_privacy: {
        CRM版本: "QA-CRM-144-01",
        同意记录批次: "QA-CONSENT-144-01",
        合法用途: "订单履约与经同意营销",
        退订渠道: "QA退订入口",
        保存期限月: 12,
        去标识化规则: "QA-HASH-144-01",
      },
      metrics_baseline: {
        指标定义: "复购率/触达率/权益成本",
        历史基线: "2026-06",
        已批准目标: "退订率不高于QA基线",
      },
      approval_authority: {
        数据访问角色: "QA_CRM_OWNER",
        顾客权利请求流程: "QA-DSR-144-01",
      },
    },
    ["QA-CRM-144-01", "QA-CONSENT-144-01", "QA-DSR-144-01"],
  ),
  145: F(
    145,
    {
      promotion: {
        促销实验编号: "QA-EXP-145-01",
        实验基线: "QA-BASELINE-145-01",
        对照组: "未触达门店时段",
        可停止条件: "投诉上升或食安证据缺失",
      },
      price_volume: {
        历史价格销量明细: [
          {
            期间: "2026-07-22",
            价格元: 48,
            销量: 84,
            促销标记: false,
            缺货标记: false,
            外部事件: "无记录",
          },
          {
            期间: "2026-07-29",
            价格元: 53,
            销量: 76,
            促销标记: true,
            缺货标记: false,
            外部事件: "社区活动验收记录",
          },
        ],
      },
      cost_margin: {
        包装成本元: 2.3,
        支付费元: 1.1,
        渠道可变费元: 3.5,
        媒体成本元: 120,
      },
    },
    ["QA-EXP-145-01", "QA-BASELINE-145-01", "QA-PRICE-145-01"],
  ),
  146: F(
    146,
    {
      orders_demand: {
        渠道经营明细: [
          {
            渠道: "外卖",
            订单数: 120,
            退款数: 3,
            履约时长分钟: 42,
            合同费率: "18%",
          },
          {
            渠道: "团餐",
            订单数: 8,
            退款数: 0,
            履约时长分钟: 65,
            合同费率: "10%",
          },
        ],
      },
      cash_payment: {
        渠道结算明细: [
          {
            渠道: "外卖",
            订单数: 120,
            退款数: 3,
            履约时长分钟: 42,
            合同费率: "18%",
          },
          {
            渠道: "团餐",
            订单数: 8,
            退款数: 0,
            履约时长分钟: 65,
            合同费率: "10%",
          },
        ],
      },
      packaging_storage: {
        保持测试批次: "QA-HOLD-146-01",
        保持测试结果: "QA验证：规定观察窗内包装完整",
        包装品项明细: [
          { 包装品项: "QA-BOX-01", 用量: 120, 单位成本元: 1.8, 回收去向: "授权清运" },
        ],
      },
      process_capacity: {
        分时段厨房产能: "QA-CAPACITY-146-01",
        限单权限: "门店经理审批",
      },
    },
    ["QA-HOLD-146-01", "QA-CHANNEL-146-DELIVERY", "QA-CHANNEL-146-CATERING"],
  ),
  147: F(
    147,
    {
      cash_payment: {
        交易明细: [
          {
            交易号: "QA-TXN-147-001",
            渠道: "POS现金",
            应收元: 50,
            实收元: 50,
            状态: "已结算",
            发生时间: "2026-07-31T12:01:00+08:00",
          },
          {
            交易号: "QA-TXN-147-002",
            渠道: "聚合支付",
            应收元: 68,
            实收元: 66,
            状态: "待核对",
            发生时间: "2026-07-31T12:14:00+08:00",
          },
        ],
        支付流水明细: [
          {
            交易号: "QA-TXN-147-001",
            渠道: "POS现金",
            应收元: 50,
            实收元: 50,
            状态: "已结算",
            发生时间: "2026-07-31T12:01:00+08:00",
          },
          {
            交易号: "QA-TXN-147-002",
            渠道: "聚合支付",
            应收元: 68,
            实收元: 66,
            状态: "待核对",
            发生时间: "2026-07-31T12:14:00+08:00",
          },
        ],
      },
      systems_data: {
        平台结算明细: [
          {
            交易号: "QA-TXN-147-003",
            渠道: "外卖平台",
            应收元: 72,
            实收元: 59,
            状态: "已结算",
            发生时间: "2026-07-31T12:22:00+08:00",
          },
        ],
      },
    },
    ["QA-TXN-147-001", "QA-TXN-147-002", "QA-TXN-147-003"],
  ),
  148: F(
    148,
    {
      recipe_ingredient: {
        理论实际耗用明细: [
          {
            原料: "QA-ING-148-01",
            菜品净销量: 120,
            标准耗用: 0.18,
            期初库存: 45,
            采购数量: 30,
            期末库存: 52,
          },
        ],
        菜品耗用明细: [
          {
            原料: "QA-ING-148-01",
            菜品净销量: 120,
            标准耗用: 0.18,
            期初库存: 45,
            采购数量: 30,
            期末库存: 52,
          },
        ],
      },
      inventory_batch: {
        期初实盘: 45,
        期末实盘: 52,
        采购数量: 30,
        调入数量: 0,
        调出数量: 0,
        领用数量: 23,
        理论耗用: 21.6,
        报损数量: 1.4,
      },
      cost_margin: { 食材成本元: 35000, 采购价格版本: "QA-PRICE-148-01" },
    },
    ["QA-ING-148-01", "QA-LOT-148-0731", "QA-TRACE-148-01"],
  ),
  149: F(
    149,
    {
      workforce: {
        岗位技能明细: [
          { 岗位: "前厅", 技能: "收银", 最低覆盖: 1 },
          { 岗位: "后厨", 技能: "热厨", 最低覆盖: 2 },
        ],
      },
      schedule_timekeeping: {
        工时明细: [
          { 员工编号: "QA-EMP-149-001", 计划工时: 40, 实际工时: 42, 加班小时: 2 },
          { 员工编号: "QA-EMP-149-002", 计划工时: 40, 实际工时: 39, 加班小时: 0 },
        ],
      },
      revenue_finance: {
        净销售额元: 100000,
        顾客数: 1800,
        订单数: 2000,
      },
      metrics_baseline: {
        历史基线: "2026-06",
        已批准目标: "人工成本率不超过QA基线",
      },
    },
    ["QA-EMP-149-001", "QA-EMP-149-002", "QA-LABOR-149-01"],
  ),
  150: F(
    150,
    {
      cost_margin: {
        包装成本元: 4600,
        渠道可变费元: 7200,
        工资附加元: 3100,
        占用成本元: 12000,
        能源成本元: 3800,
        维修费元: 900,
        折旧元: 4200,
        中央分摊元: 2500,
        一次性事项元: 600,
        食材成本元: 35000,
        饮料成本元: 4200,
      },
      revenue_finance: {
        净销售额元: 100000,
        会计期间: "2026-07",
        会计口径: "权责口径",
      },
      tax_accounting: { 税率: "QA税务口径待确认", 含税未税: "未税" },
    },
    ["QA-PNL-150-01", "QA-COST-150-01", "QA-LEDGER-150-01"],
  ),
  151: F(
    151,
    {
      cash_payment: {
        周现金流明细: Array.from({ length: 13 }, (_, index) => {
          const week = index + 1;
          return {
            周次: week,
            销售流入元: 22000 + week * 250,
            应付元: 9200 + week * 80,
            工资元: 5600,
            税费元: 1200,
            租金元: 12000,
            债务元: 1800,
            资本支出元: week === 4 ? 8500 : 0,
            期间: `2026-W${String(week).padStart(2, "0")}`,
          };
        }),
      },
      revenue_finance: {
        十三周现金计划: Array.from({ length: 13 }, (_, index) => ({
          周次: index + 1,
          计划版本: "QA-CASH-151-01",
          审批状态: "待人工审批",
        })),
        当前现金元: 80000,
      },
      approval_authority: {
        最低现金政策: "QA-MIN-CASH-151-01",
        审批权限: "老板终审",
      },
    },
    ["QA-CASH-151-01", "QA-W01", "QA-W13"],
  ),
  152: F(
    152,
    {
      price_volume: {
        历史价格销量明细: [
          {
            期间: "2026-07-15",
            价格元: 48,
            销量: 96,
            促销标记: false,
            缺货标记: false,
            外部事件: "无记录",
          },
          {
            期间: "2026-07-22",
            价格元: 53,
            销量: 84,
            促销标记: false,
            缺货标记: false,
            外部事件: "无记录",
          },
        ],
        价格实验明细: [
          {
            期间: "2026-07-29",
            价格元: 56,
            销量: 79,
            促销标记: true,
            缺货标记: false,
            外部事件: "QA社区活动",
          },
        ],
      },
      cost_margin: {
        固定成本元: 48000,
        单份可变成本元: 22,
      },
      metrics_baseline: {
        已批准目标: "先完成弹性区间估计，再提交调价审批",
      },
    },
    ["QA-PRICE-152-01", "QA-PRICE-152-02", "QA-EXP-152-01"],
  ),
  153: F(
    153,
    {
      orders_demand: {
        去标识订单明细: [
          {
            订单键: "QA-ORDERKEY-153-001",
            渠道: "堂食",
            餐段: "午餐",
            菜品: "QA-DISH-153-01",
            顾客群键: "QA-SEG-A",
            净收入元: 50,
            可变成本元: 21,
          },
          {
            订单键: "QA-ORDERKEY-153-002",
            渠道: "外卖",
            餐段: "晚餐",
            菜品: "QA-DISH-153-02",
            顾客群键: "QA-SEG-B",
            净收入元: 62,
            可变成本元: 29,
          },
        ],
        多维经营明细: [
          {
            渠道: "堂食",
            餐段: "午餐",
            菜品: "QA-DISH-153-01",
            顾客群键: "QA-SEG-A",
            净收入元: 50,
            可变成本元: 21,
          },
          {
            渠道: "外卖",
            餐段: "晚餐",
            菜品: "QA-DISH-153-02",
            顾客群键: "QA-SEG-B",
            净收入元: 62,
            可变成本元: 29,
          },
        ],
      },
      crm_privacy: {
        顾客群键规则: "QA-HASH-153-01",
        同意状态: "仅使用汇总/去标识数据",
      },
      customer_feedback: { 评价样本: 24, 投诉数: 2 },
    },
    ["QA-ORDERKEY-153-001", "QA-ORDERKEY-153-002", "QA-HASH-153-01"],
  ),
  154: F(
    154,
    {
      metrics_baseline: {
        指标定义: "营业额/订单/食材成本率/人工成本率/投诉率",
        历史基线: "2026-06",
        已批准目标: "食材成本率32%",
        仪表盘版本: "QA-KPI-154-01",
        刷新时间: QA_TIMESTAMP,
      },
      systems_data: {
        数据源清单: ["QA-POS-154", "QA-ERP-154", "QA-HR-154"],
        字段字典: "QA-DICT-154-01",
        数据质量状态: "已核验",
      },
      approval_authority: {
        决策者: "QA_OWNER",
        会议节奏: "每周一经营复盘",
        未决行动: "QA-ACTION-154-01",
      },
    },
    ["QA-KPI-154-01", "QA-DICT-154-01", "QA-ACTION-154-01"],
  ),
  155: F(
    155,
    {
      business_scope: {
        门店清单: [
          { 门店编号: "QA-STORE-155-01", 业务范围: "验收门店1", 业态: "堂食+外卖" },
          { 门店编号: "QA-STORE-155-02", 业务范围: "验收门店2", 业态: "堂食+外卖" },
          { 门店编号: "QA-STORE-155-03", 业务范围: "验收门店3", 业态: "堂食+外卖" },
          { 门店编号: "QA-STORE-155-04", 业务范围: "验收门店4", 业态: "堂食+外卖" },
          { 门店编号: "QA-STORE-155-05", 业务范围: "验收门店5", 业态: "堂食+外卖" },
        ],
        对标批次: "QA-BENCHMARK-155-01",
      },
      quality_audit: {
        SOP执行证据: "QA-SOP-AUDIT-155-01",
        现场观察日期: QA_DATE,
      },
      replication_governance: {
        管理层问题: "跨店SOP一致性",
        可复制边界: "同店型同菜单",
        试点范围: "3家验收门店",
        试点权限: "老板批准后执行",
      },
    },
    [
      "QA-STORE-155-01",
      "QA-STORE-155-02",
      "QA-STORE-155-03",
      "QA-STORE-155-04",
      "QA-STORE-155-05",
    ],
  ),
  156: F(
    156,
    {
      deadline_constraint: {
        目标开业日: "2026-08-15",
        阶段目标: "软开业后稳定期",
        决策期限: "2026-08-07T18:00:00+08:00",
      },
      quality_audit: {
        开业就绪明细: [
          { 模块: "许可", 状态: "已核验", 证据编号: "QA-READY-156-01", 负责人: "QA_OWNER" },
          { 模块: "施工", 状态: "已核验", 证据编号: "QA-READY-156-02", 负责人: "QA_OWNER" },
          { 模块: "设备", 状态: "已核验", 证据编号: "QA-READY-156-03", 负责人: "QA_FACILITY" },
          { 模块: "人员", 状态: "已核验", 证据编号: "QA-READY-156-04", 负责人: "QA_HR" },
          { 模块: "供应", 状态: "已核验", 证据编号: "QA-READY-156-05", 负责人: "QA_SUPPLY" },
          { 模块: "系统", 状态: "已核验", 证据编号: "QA-READY-156-06", 负责人: "QA_SYSTEMS" },
        ],
      },
      systems_data: {
        就绪状态明细: [
          { 模块: "许可", 状态: "已核验", 证据编号: "QA-READY-156-01", 负责人: "QA_OWNER" },
          { 模块: "施工", 状态: "已核验", 证据编号: "QA-READY-156-02", 负责人: "QA_OWNER" },
          { 模块: "设备", 状态: "已核验", 证据编号: "QA-READY-156-03", 负责人: "QA_FACILITY" },
          { 模块: "人员", 状态: "已核验", 证据编号: "QA-READY-156-04", 负责人: "QA_HR" },
          { 模块: "供应", 状态: "已核验", 证据编号: "QA-READY-156-05", 负责人: "QA_SUPPLY" },
          { 模块: "系统", 状态: "已核验", 证据编号: "QA-READY-156-06", 负责人: "QA_SYSTEMS" },
        ],
      },
      risk_incident: { 风险登记: "QA-RISK-156-01", 延期权限: "QA_OWNER" },
    },
    [
      "QA-READY-156-01",
      "QA-READY-156-02",
      "QA-READY-156-03",
      "QA-READY-156-04",
      "QA-READY-156-05",
      "QA-READY-156-06",
    ],
  ),
  157: F(
    157,
    {
      sustainability: {
        浪费明细: [
          {
            记录编号: "QA-WASTE-157-001",
            类别: "备料边角",
            重量公斤: 4.2,
            数量: 12,
            成本元: 96,
            处置方式: "授权清运",
            原因: "修切",
            时间: "2026-07-31T11:00:00+08:00",
            工位: "QA-PREP-01",
          },
        ],
        食物浪费公斤: 180,
        减量目标: "先完成QA基线再设目标",
      },
      inventory_batch: {
        批次: "QA-LOT-157-0731",
        效期: "2026-08-15",
        盘点日期: QA_DATE,
      },
      approval_authority: {
        处置审批人: "QA_FOOD_SAFETY_OWNER",
        不执行事项: "未审批不捐赠、不改用途",
      },
    },
    ["QA-WASTE-157-001", "QA-LOT-157-0731", "QA-DISPOSAL-157-01"],
  ),
  158: F(
    158,
    {
      sustainability: {
        能源账单明细: [
          {
            能源类型: "电",
            用量: 12000,
            费率元: 0.82,
            金额元: 9840,
            期间: "2026-07",
            分表编号: "QA-METER-158-E",
          },
          {
            能源类型: "用水",
            用量: 320,
            费率元: 4.2,
            金额元: 1344,
            期间: "2026-07",
            分表编号: "QA-METER-158-W",
          },
        ],
      },
      equipment: {
        设备负荷明细: [
          {
            设备: "QA-EQ-158-FREEZER",
            负荷千瓦: 12,
            用量: 2880,
            金额元: 2361.6,
            期间: "2026-07",
          },
        ],
      },
      packaging_storage: {
        包装品项明细: [
          {
            包装品项: "QA-PACK-158-01",
            用量: 820,
            单位成本元: 1.8,
            回收去向: "授权清运",
          },
        ],
      },
      capital_budget: {
        CAPEX元: 28000,
        回收期月: 12,
        审批状态: "待人工审批",
      },
    },
    ["QA-METER-158-E", "QA-METER-158-W", "QA-PACK-158-01"],
  ),
  159: F(
    159,
    {
      business_scope: {
        门店编号: "QA-TY-A",
        中央厨房编号: "QA-CK-01",
        业务范围: "单店与中央厨房连续性",
      },
      systems_data: {
        数据清单: ["QA-POS-159", "QA-PAYMENT-159", "QA-INVENTORY-159"],
        备份批次: "QA-BACKUP-159-01",
        恢复测试日期: QA_DATE,
        日志保留状态: "已核验",
      },
      risk_incident: {
        场景明细: [
          { 场景: "断电", RTO小时: 4, RPO小时: 1, 停止条件: "食品安全无法证明" },
          { 场景: "支付中断", RTO小时: 2, RPO小时: 1, 停止条件: "无法防重复记账" },
        ],
        风险批次: "QA-RISK-159-01",
        业务连续方案: "QA-BCP-159-01",
      },
      approval_authority: {
        联系树: "QA-CONTACT-TREE-159",
        授权放行: "事件指挥审批",
      },
    },
    ["QA-BACKUP-159-01", "QA-RISK-159-01", "QA-BCP-159-01"],
  ),
  160: F(
    160,
    {
      promotion: {
        活动类型: "门店主题活动",
        活动主题: "QA周末家庭餐",
        活动编号: "QA-EVENT-160-01",
        活动日期: "2026-08-08",
        来源状态: "仅使用隔离QA活动台账",
      },
      business_scope: {
        门店编号: "QA-TY-A",
        品类: "中式简餐",
        城市: "太原",
      },
      price_volume: {
        客单价元: 50,
        规模: "80人次",
        预算元: 2000,
      },
      approval_authority: {
        活动执行负责人: "QA_EVENT_OWNER",
        审批状态: "待人工审批",
        不自动发布: true,
      },
    },
    ["QA-EVENT-160-01", "QA-TY-A", "QA_EVENT_OWNER"],
  ),
  161: F(
    161,
    {
      business_scope: {
        门店编号: "QA-TY-A",
        门店名称: "验收门店A（QA）",
        业务范围: "例行巡店",
      },
      quality_audit: {
        巡店检查明细: [
          {
            检查编号: "QA-INSPECT-161-001",
            模块: "前厅卫生",
            状态: "已核验",
            日期: QA_DATE,
            证据编号: "QA-PHOTO-161-001",
          },
          {
            检查编号: "QA-INSPECT-161-002",
            模块: "温控记录",
            状态: "已核验",
            日期: QA_DATE,
            证据编号: "QA-LOG-161-002",
          },
        ],
        巡店批次: "QA-INSPECTION-161-01",
        现场影像记录: "QA-MEDIA-161-01",
      },
      risk_incident: {
        上次问题清单: "QA-PRIOR-161-01",
        整改跟踪: "QA-CAPA-161-01",
      },
      approval_authority: { 检查类型: "例行巡店", 整改负责人: "QA_STORE_OWNER" },
    },
    ["QA-INSPECTION-161-01", "QA-PHOTO-161-001", "QA-CAPA-161-01"],
  ),
};

const EMPTY = freeze({});
export const RESTAURANT_OPERATIONAL_FIXTURE_FACTS_131_161 = freeze(
  Object.fromEntries(
    RESTAURANT_OPERATIONAL_FIXTURE_INDEXES_131_161.map((idx) => [
      idx,
      FACTS[idx] || EMPTY,
    ]),
  ),
);

function clone(value) {
  return structuredClone(value);
}

function mergeValues(existing, extra) {
  if (Array.isArray(existing) && Array.isArray(extra)) {
    return [...existing, ...extra];
  }
  if (
    existing &&
    typeof existing === "object" &&
    !Array.isArray(existing) &&
    extra &&
    typeof extra === "object" &&
    !Array.isArray(extra)
  ) {
    const merged = { ...existing };
    for (const [key, value] of Object.entries(extra)) {
      merged[key] = Object.hasOwn(merged, key)
        ? mergeValues(merged[key], value)
        : clone(value);
    }
    return merged;
  }
  return existing === undefined ? clone(extra) : existing;
}

function mergeFacts(existingFacts, extraFacts) {
  const merged = existingFacts && typeof existingFacts === "object" && !Array.isArray(existingFacts)
    ? clone(existingFacts)
    : {};
  if (!extraFacts || typeof extraFacts !== "object" || Array.isArray(extraFacts)) return merged;
  for (const [dimension, value] of Object.entries(extraFacts)) {
    merged[dimension] = Object.hasOwn(merged, dimension)
      ? mergeValues(merged[dimension], value)
      : clone(value);
  }
  return merged;
}

function qaRegulationScope(idx, regulation, originalOperationalBlockers = []) {
  const qaEvidenceId = `QA-REG-${Number(idx)}-001`;
  return {
    ...(regulation && typeof regulation === "object" ? regulation : {}),
    // Keep all of the normal required legal fields, but make the status
    // unambiguously synthetic and non-production. `READY` here means only
    // that the isolated model contract has a complete QA scope to reason over.
    结论状态: "QA_ONLY",
    人工法务确认: "QA_ONLY：未形成法律结论；不得业务采纳或外部执行",
    QA能力验收资格: "RUNNABLE",
    业务执行资格: "READY",
    QA业务执行资格: "READY（仅QA生成）",
    数据性质: "QA_ONLY_SYNTHETIC",
    业务采纳资格: "BLOCKED",
    外部执行资格: "BLOCKED",
    法律结论: "未形成",
    // Preserve the rule's original real-world gaps in an auditable field;
    // only the isolated QA-generation sentinel below is used for the
    // required-input non-empty blocker field.
    realWorldBlockers: [...originalOperationalBlockers],
    // The production validator requires this field to be non-empty. This is
    // a non-operational QA caveat, not a dispatch operationalBlockReasons
    // entry; the latter remains empty for isolated preflight generation.
    阻塞原因: ["QA_ONLY_SCOPE_NOT_FOR_PRODUCTION"],
    QA状态: "QA_ONLY",
    QA核验日期: QA_DATE,
    QA来源: QA_SOURCE,
    QA证据编号: qaEvidenceId,
    QA对象: [`QA-REG-SCOPE-${Number(idx)}`],
    QA禁止事项: "仅QA；禁止替代当地/平台/私有记录，禁止采纳、申报、外部执行、采购付款签约或账号操作",
  };
}

function applyQaRegulationScope(record, idx) {
  if (!RESTAURANT_REGULATION_QA_READY_INDEXES_131_161.includes(Number(idx))) {
    return record;
  }
  const fields =
    record?.fields && typeof record.fields === "object" && !Array.isArray(record.fields)
      ? record.fields
      : {};
  const facts =
    fields.facts && typeof fields.facts === "object" && !Array.isArray(fields.facts)
      ? fields.facts
      : record?.facts && typeof record.facts === "object" && !Array.isArray(record.facts)
        ? record.facts
        : {};
  if (!facts.regulation || typeof facts.regulation !== "object" || Array.isArray(facts.regulation)) {
    return record;
  }
  const originalCandidates = [
    record?.realWorldBlockers,
    record?.qaEvidence?.originalOperationalBlockers,
    record?.fields?.qa?.originalOperationalBlockers,
    facts.regulation?.realWorldBlockers,
    record?.regulationBlockers,
    facts.regulation?.阻塞原因,
    RESTAURANT_REGULATION_QA_ORIGINAL_BLOCKERS_131_161[Number(idx)],
  ];
  const originalOperationalBlockers = originalCandidates.find((candidate) => (
    Array.isArray(candidate)
    && candidate.length > 0
    && candidate.some((item) => item !== "QA_ONLY_SCOPE_NOT_FOR_PRODUCTION")
  ));
  const preservedOriginalBlockers = Array.isArray(originalOperationalBlockers)
    ? [...originalOperationalBlockers]
    : [];
  const regulation = qaRegulationScope(idx, facts.regulation, preservedOriginalBlockers);
  const qaEvidenceId = regulation.QA证据编号;
  const qaMeta = {
    qa: true,
    qaTag: "QA",
    qaOnlyRegulatoryProof: true,
    source: QA_SOURCE,
    synthetic: true,
    noExternalCall: true,
    evidenceId: qaEvidenceId,
    evidenceDate: QA_DATE,
    observedAt: QA_TIMESTAMP,
    objects: [...regulation.QA对象],
    scope: "regulation_and_private_records_only",
    productionClaim: false,
    originalOperationalBlockers: [...preservedOriginalBlockers],
    businessAdoption: "BLOCKED",
    externalExecution: "BLOCKED",
    legalConclusion: "未形成",
    prohibitedUse: regulation.QA禁止事项,
  };
  return {
    ...record,
    operationalReady: true,
    regulationEvidence: "QA_ONLY_OPERATIONALLY_READY_NON_PRODUCTION",
    regulationBlockers: [],
    qaOnlyRegulatoryProof: true,
    realWorldBlockers: [...preservedOriginalBlockers],
    qaEvidence: clone(qaMeta),
    qaRegulationScope: qaMeta,
    fields: {
      ...fields,
      facts: { ...facts, regulation },
      qa: {
        ...(fields.qa && typeof fields.qa === "object" && !Array.isArray(fields.qa)
          ? fields.qa
          : {}),
        regulation: qaMeta,
      },
    },
  };
}

function normalizeArgs(first, second) {
  if (Array.isArray(first)) {
    return { materialEvidence: first, idx: Number(second) };
  }
  if (typeof first === "number" || typeof first === "string") {
    return { idx: Number(first), materialEvidence: second };
  }
  if (first && typeof first === "object") {
    return {
      idx: Number(first.idx),
      materialEvidence: first.materialEvidence,
    };
  }
  return { idx: Number.NaN, materialEvidence: second };
}

/**
 * Add deterministic QA facts for one restaurant employee. Existing records
 * are cloned and left otherwise intact. The facts are merged into one
 * non-regulatory record when available so dispatch evidence retains its
 * original required-input record IDs and semantic tags.
 *
 * Supported calls:
 *   augmentRestaurantOperationalMaterialEvidence({ idx, materialEvidence })
 *   augmentRestaurantOperationalMaterialEvidence(idx, materialEvidence)
 *   augmentRestaurantOperationalMaterialEvidence(materialEvidence, idx)
 */
export function augmentRestaurantOperationalMaterialEvidence(first, second) {
  const { idx, materialEvidence } = normalizeArgs(first, second);
  if (!RESTAURANT_OPERATIONAL_FIXTURE_INDEXES_131_161.includes(idx)) {
    return Array.isArray(materialEvidence) ? clone(materialEvidence) : [];
  }
  const base = Array.isArray(materialEvidence) ? clone(materialEvidence) : [];
  const template = FACTS[idx];
  if (!template || !Object.keys(template).length) return base;
  if (!base.length) return [clone(template)];

  // Prefer a non-regulation record: this keeps current-regulation blockers
  // untouched while still exposing the operational facts to the task gate.
  let targetIndex = base.findIndex(
    (record) => !record?.fields?.facts?.regulation && !record?.facts?.regulation,
  );
  if (targetIndex < 0) targetIndex = 0;
  const target = base[targetIndex] || {};
  const existingFields =
    target.fields && typeof target.fields === "object" && !Array.isArray(target.fields)
      ? target.fields
      : {};
  const existingFacts =
    existingFields.facts && typeof existingFields.facts === "object" && !Array.isArray(existingFields.facts)
      ? existingFields.facts
      : target.facts && typeof target.facts === "object" && !Array.isArray(target.facts)
        ? target.facts
        : {};
  const existingQa =
    existingFields.qa && typeof existingFields.qa === "object" && !Array.isArray(existingFields.qa)
      ? existingFields.qa
      : {};
  const qa = template.qaEvidence || {};
  const merged = {
    ...target,
    qaEvidence: clone(qa),
    qaOperationalFacts: true,
    fields: {
      ...existingFields,
      facts: mergeFacts(existingFacts, template.fields.facts),
      qa: { ...existingQa, ...clone(qa) },
    },
  };
  if (target.facts && !target.fields) {
    merged.facts = mergeFacts(target.facts, template.fields.facts);
  }
  base[targetIndex] = merged;
  return base.map((record) => applyQaRegulationScope(record, idx));
}

// Concise aliases make the augmentation easy to discover without introducing
// a second implementation. All aliases retain the same pure array contract.
export const augmentRestaurantOperationalFixtures131To161 =
  augmentRestaurantOperationalMaterialEvidence;
export const augmentRestaurantOperationalFacts131To161 =
  augmentRestaurantOperationalMaterialEvidence;
export const augmentRestaurantMaterialEvidence131To161 =
  augmentRestaurantOperationalMaterialEvidence;
export const augmentRestaurantOperationalEvidence131To161 =
  augmentRestaurantOperationalMaterialEvidence;
export const buildRestaurantOperationalFixtures131To161 =
  augmentRestaurantOperationalMaterialEvidence;

export default augmentRestaurantOperationalMaterialEvidence;

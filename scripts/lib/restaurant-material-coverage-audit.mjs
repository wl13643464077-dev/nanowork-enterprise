import { loadRestaurantCatalog } from '../../server/src/catalog/restaurant.js';
import { buildRestaurantDispatch } from './real-employee-matrix.mjs';

const GENERIC_CATEGORIES = new Set(['业务台账明细', '通用业务台账', '综合业务记录']);

const CATEGORY_FAMILIES = Object.freeze([
  ['compliance', /(?:法规|合规|证照|许可|标准|审核)/u],
  ['location', /(?:地理|地址|商圈|选址|物业|租约)/u],
  ['marketing', /(?:渠道|营销|品牌|内容|活动|促销|社媒)/u],
  ['customer_service', /(?:客户|顾客|客诉|评价|口碑|会员|预订|桌台)/u],
  ['workforce', /(?:人员|员工|人工|排班|工时|培训|资格|考勤|绩效)/u],
  ['safety', /(?:现场|食安|食品安全|卫生|温度|留样|清洁|危害|巡检)/u],
  ['supply', /(?:供应|采购|库存|批次|物流|冷链|收货|追溯)/u],
  ['product', /(?:菜单|菜品|配方|原料|份量|出成|营养|过敏|工艺|包装)/u],
  ['facility', /(?:设备|资产|维修|设施|水电|燃气|消防|能源)/u],
  ['finance', /(?:经营|财务|收入|营收|营业额|成本|毛利|利润|现金|资金|预算|投资|结算)/u],
  ['sales', /(?:交易|销售|订单|客流|POS|支付)/iu],
  ['operations', /(?:运营|作业|服务|生产|需求|产能|工位|流程|SOP)/iu],
  ['data', /(?:数据|系统|平台|日志|指标|仪表盘|数据治理)/u],
]);

const TAG_FAMILIES = Object.freeze({
  scope: ['operations', 'governance', 'strategy'],
  location: ['location'],
  demand: ['sales', 'market', 'operations'],
  competition: ['market', 'strategy'],
  finance: ['finance'],
  capex: ['finance'],
  facility: ['facility', 'operations'],
  menu_recipe: ['product'],
  food_compliance: ['compliance', 'safety'],
  supply_chain: ['supply'],
  operations_data: ['operations', 'data', 'sales'],
  growth_customer: ['marketing', 'customer_service'],
  workforce: ['workforce'],
  expansion_risk: ['governance', 'safety', 'operations'],
});

function regulatorySnapshot(materials) {
  const realWorldBlockers = new Set();
  let qaOnly = false;
  for (const material of materials) {
    let fields;
    try {
      fields = JSON.parse(String(material?.payload || ''));
    } catch {
      continue;
    }
    const regulation = fields?.facts?.regulation;
    if (!regulation || typeof regulation !== 'object') continue;
    qaOnly = qaOnly
      || regulation.QA_ONLY === true
      || regulation.结论状态 === 'QA_ONLY'
      || regulation.数据性质 === 'QA_ONLY_SYNTHETIC';
    for (const blocker of Array.isArray(regulation.realWorldBlockers)
      ? regulation.realWorldBlockers
      : []) {
      realWorldBlockers.add(String(blocker));
    }
  }
  return { qaOnly, realWorldBlockers: [...realWorldBlockers] };
}

const dimension = (id, label, families, trigger, evidence = trigger) => (
  Object.freeze({ id, label, families: Object.freeze(families), trigger, evidence })
);

/**
 * 与 materialFacts 生成分支独立的“输入语义 -> 必须存在的事实维度”字典。
 * 审计不可以生成器的关键词规则自证正确。
 */
export const RESTAURANT_INPUT_FACT_DIMENSIONS = Object.freeze([
  dimension('jurisdiction', '国家/城市/司法辖区', ['compliance', 'location'], /(?:国家|省市|城市|地区|司法辖区|当地|区域|市场)/u, /(?:国家|省|市|区|县|司法辖区|地区|区域|适用地)/u),
  dimension('business_scope', '门店/组织/业务范围', ['operations', 'strategy'], /(?:门店|中央厨房|法人|组织|部门|店型|业态|经营主体|多店)/u, /(?:门店编号|门店清单|中央厨房|法人|组织|部门|店型|业态|经营主体|业务范围)/u),
  dimension('address', '地址/坐标/商圈', ['location'], /(?:地址|坐标|商圈|场地|地点|候选点|交付地点)/u, /(?:地址|坐标|经度|纬度|商圈|场地|地点)/u),
  dimension('catchment', '覆盖半径/交通/通行时间', ['location', 'operations'], /(?:半径|通行时间|交通|里程|路线|服务区域|配送网络)/u),
  dimension('time_scope', '期间/时区/营业与餐段时间', ['operations', 'sales', 'finance'], /(?:期间|日期|时区|营业日|营业时段|营业时间|餐段|时段|班次|开业日|截止时间|时间窗|会计日历)/u),
  dimension('product_menu', '品类/菜单/菜品/食品形态', ['product', 'market'], /(?:品类|菜系|菜单|菜品|食品形态|食品类别|产品|新品|饮料|品项)/u),
  dimension('customer_segment', '目标客群/用餐场景/消费者类型', ['market', 'customer_service'], /(?:目标客群|目标顾客|目标消费者|目标人群|目标供餐人群|高易感人群|用餐场景|顾客数|受众)/u, /(?:客群|顾客类型|消费者|人群|用餐场景|顾客数|受众)/u),
  dimension('channel', '销售/服务渠道及占比', ['marketing', 'sales', 'operations'], /(?:渠道|堂食|外卖|自提|宴会|团餐|销售平台)/u, /(?:渠道|堂食|外卖|自提|宴会|团餐|平台|占比)/u),
  dimension('price_volume', '价格/客单/数量/规模', ['finance', 'sales', 'market'], /(?:价格带|客单|售价|净售价|菜单价格|销量|客数|数量|份数|规模|销售组合|菜品组合)/u),
  dimension('market_competition', '竞品/市场/调研证据', ['market', 'strategy'], /(?:竞品|竞争价格|市场机会|调研|顾客访谈|试卖反馈|地图|实地观察|搜索数据)/u),
  dimension('orders_demand', '订单/客流/需求预测', ['sales', 'operations'], /(?:订单|客流|交易|需求|预测|预订|售罄|缺货|上架天数)/u),
  dimension('promotion', '活动/促销/投放与实验', ['marketing'], /(?:活动|促销|投放|营销|广告|抽奖|优惠券|媒体成本|实验|对照|自然波动)/u),
  dimension('brand_content', '品牌/内容/素材/授权', ['marketing'], /(?:品牌定位|品牌资产|品牌语调|价值主张|内容|图片|视频|音乐|商标|肖像|UGC|创作者|使用授权|人物故事)/iu),
  dimension('property_lease', '物业/面积/租约条款', ['location', 'finance'], /(?:面积|楼层|门面|交付条件|平面|租金|管理费|抽成|押金|免租|递增|租约|退出条款|座位|桌台图)/u),
  dimension('utilities', '水电气/排烟/消防/工程条件', ['facility', 'safety'], /(?:水电气|用水|制冰|通风|排水|排烟|隔油|消防|承重|垃圾|装卸|公用工程|电源|环境温度)/u),
  dimension('equipment', '设备/资产/维修与产能', ['facility', 'operations'], /(?:设备|资产|冷藏|冷冻|洗碗机|温度计|探针|记录仪|秤|检具|容器|维修|故障|停机|额定参数|保修|型号|序列号|备件)/u),
  dimension('capital_budget', '预算/投资/资金/回报期', ['finance', 'strategy'], /(?:预算|投资|营运资金|资金约束|资本预算|目标回报|回收期|融资条件|折现|投资上限)/u),
  dimension('cost_margin', '成本/毛利/费用明细', ['finance'], /(?:成本|毛利|利润|费用|食材|平台费|支付费|履约|浪费|报损|贡献)/u),
  dimension('revenue_finance', '营收/收入/损益口径', ['finance', 'sales'], /(?:营收|营业额|销售收入|净销售额|销售额|单店损益|损益|贡献)/u),
  dimension('cash_payment', '现金/支付/结算/银行凭证', ['finance', 'sales'], /(?:现金|支付|付款|结算|银行|应收|应付|存款|信贷|债务|拒付|币种|账期)/u),
  dimension('tax_accounting', '税费/会计/计价口径', ['finance', 'compliance'], /(?:税务|税费|含税|未税|会计口径|权责|现金口径|成本计价|折旧|会计日历|总账)/u),
  dimension('recipe_ingredient', '配方/原料/规格/用量', ['product', 'supply'], /(?:配方|原料|复合配料|加工助剂|调味料|替代料|供应商规格|原始重量|实际耗用|原料品牌)/u),
  dimension('yield_portion', '出成率/份量/产出/偏差', ['product', 'operations'], /(?:出成|份量|AP\s*重量|EP\s*重量|毛料|净料|修切|去皮|去骨|烹饪后重量|产出|总产量|量具)/iu),
  dimension('process_capacity', '工艺/步骤/工位/时长/产能', ['product', 'operations'], /(?:制作步骤|工艺|流程图|工位|制作时间|时长|节拍|产能|批量|生产顺序|出餐时长)/u),
  dimension('packaging_storage', '包装/储运/保质期/库容', ['product', 'supply'], /(?:包装|容器|储运|保存|货架期|保质|使用期限|效期|储存|库容|解冻|开封)/u),
  dimension('nutrition_claim', '营养数据/标识/声称依据', ['product', 'compliance'], /(?:营养|营养数据库|营养声明|营养声称|NRV|DV|法定单位|舍入规则|实验室报告)/iu),
  dimension('allergen', '过敏原/交叉接触/顾客告知', ['product', 'safety', 'compliance'], /(?:过敏原|交叉接触|交叉污染|高易感|顾客告知|员工应答)/u),
  dimension('temperature_control', '温控/时间温度/冷链测量', ['safety', 'supply', 'operations'], /(?:温控|温度|冷却|复热|热藏|冷藏|冷冻|冷链|探针|红外|校准|布点|报警)/u),
  dimension('cleaning_hygiene', '清洁消毒/卫生/虫害/废弃物', ['safety'], /(?:清洁|消毒|洗消|卫生|虫害|废弃物|清洁剂|消毒剂|生物膜|病原体|污染类型|ATP|微生物|洗手|工服)/iu),
  dimension('food_safety', '食品安全/危害/关键限值', ['safety', 'compliance'], /(?:食品安全|食安|危害|关键控制点|关键限值|HACCP|GHP|PRP|高风险原料|安全资质|健康影响)/iu),
  dimension('regulation', '法规/官方条文/平台规则', ['compliance'], /(?:法规|法定|官方|监管|适用标准|当地要求|劳动规则|隐私要求|消费者规则|平台规则|平台条款|报告义务|无障碍要求|反歧视)/u, /(?:法规名称|文号|条款|条文|生效日|失效日|官方链接|监管机构|适用标准|平台规则|报告义务|要求原文)/u),
  dimension('credential', '证照/许可/认证及有效期', ['compliance', 'supply'], /(?:证照|许可证|许可范围|许可状态|生产许可|经营许可|认证|资质|健康证明|法定资格|验收文件)/u, /(?:证照|许可证|许可范围|许可状态|生产许可|经营许可|认证|资质|健康证明|发证机关|证书编号|有效期|验收文件)/u),
  dimension('supplier', '供应商主体/能力/质量档案', ['supply'], /(?:供应商|承运商|分包商|关键上游|生产地点|客户结构|供应风险)/u),
  dimension('procurement', '采购/报价/合同/交易条件', ['supply', 'finance'], /(?:采购|报价|发票|采购价|采购单|采购合同|最小起订|起订量|交期|退换货|调价条款|报价有效期|配送日|交付可靠性|合同)/u),
  dimension('inventory_batch', '库存/批次/效期/盘点/调拨', ['supply', 'finance', 'operations'], /(?:库存|在库|在途|批次|追溯码|效期|盘点|调拨|调入|调出|领用|库位|库区|安全库存|临期|腐损|隔离)/u),
  dimension('logistics', '收货/储运/配送/交接', ['supply', 'operations'], /(?:收货|储运|配送|车辆|装卸|交付地点|交付周期|交付时限|交付可靠性|交接|拒收|退货|路线|停靠|运输|骑手|承运商)/u),
  dimension('traceability_recall', '追溯/撤回/召回/去向', ['supply', 'safety', 'compliance'], /(?:追溯|撤回|召回|生产批|使用记录|去向|已售数量|事件产品|召回演练)/u),
  dimension('quality_audit', '检验/检查/审核/偏差与纠正', ['safety', 'compliance', 'operations'], /(?:检验|检测|检查|抽检|验收|审核|内审|巡店|现场观察|不合格|不符合|偏差|纠正|校准|验证)/u),
  dimension('workforce', '岗位/人员/技能/编制', ['workforce', 'operations'], /(?:人员|员工|岗位|技能|编制|人工|组织|责任班次|负责人|支援团队|外包人工)/u),
  dimension('schedule_timekeeping', '排班/工时/打卡/休假', ['workforce'], /(?:排班|班表|工时|打卡|考勤|加班|休息|休假|缺勤|借调|换班|连续工作|班次|补位)/u),
  dimension('training_qualification', '培训/资格/考核/复训', ['workforce', 'compliance'], /(?:培训|带教|考核|资格|资质|复训|培训机构|有效期|能力缺口|授权边界|语言|无障碍需求)/u),
  dimension('service_sop', '服务标准/SOP/岗位流程', ['operations', 'customer_service'], /(?:服务模式|服务标准|服务水平|服务区域|服务费|SOP|开店|闭店|交接|订座|等位|传菜|出餐|售罄机制|支付流程|退款政策|等待)/iu),
  dimension('booking_table', '订座/候位/桌台/到店转化', ['customer_service', 'operations'], /(?:订座|预订|等位|候位|桌台|座位|到店|用餐时长|迟到|取消|爽约|离队|步入客|翻台)/u),
  dimension('customer_feedback', '客诉/评价/顾客反馈/服务补救', ['customer_service'], /(?:客诉|投诉|评价|口碑|顾客反馈|感官反馈|顾客原始陈述|服务补救|重做|赠送|赔付|退菜|错漏|工单|联系偏好)/u),
  dimension('crm_privacy', 'CRM/会员/同意/隐私与触达权限', ['customer_service', 'data', 'compliance'], /(?:CRM|CDP|会员|积分|权益|生命周期|同意记录|合法用途|退订|拒绝列表|保存期限|触达|隐私|顾客权利|去标识化|静默期)/iu),
  dimension('systems_data', '数据源/系统/字段/版本/日志', ['data', 'sales', 'operations'], /(?:数据|POS|KDS|ERP|CRM|CDP|系统|平台|日志|字段|版本|导出|数据获取|记录能力|纸质记录|主数据|单位换算|时钟同步|数据下载)/iu),
  dimension('metrics_baseline', '指标定义/历史基线/预算/目标', ['data', 'finance', 'operations'], /(?:指标定义|KPI|历史基线|历史可比|真实基线|预算|已批准目标|管理层目标|业务目标|经营目标|阶段目标|改进目标|减量目标|服务目标|数据缺口|仪表盘|预测偏差|历史表现)/iu),
  dimension('approval_authority', '负责人/审批权限/升级与停止条件', ['governance', 'operations'], /(?:负责人|审批人|审批权限|授权|授权层级|升级|联系人|停止条件|回滚权限|决策门|决策者|联系树|隔离权限|停业权限|不可妥协)/u),
  dimension('risk_incident', '风险/事故/异常/应急与恢复', ['governance', 'safety', 'operations'], /(?:风险|事故|异常|紧急|应急|故障|攻击|演练|恢复时间|业务连续|备用|不可比事件|未关闭问题|业务影响|RTO|RPO|延期)/iu),
  dimension('sustainability', '能源/用水/废弃物/包装回收', ['sustainability', 'facility'], /(?:能源|用水|电费|燃气|蒸汽|燃料|水费|节能|排放|废弃物|回收|堆肥|捐赠|动物饲料|食物浪费|包装品项)/u),
  dimension('deadline_constraint', '决策期限/资源约束/不可妥协项', ['strategy', 'governance', 'operations'], /(?:决策期限|上线期限|启用时间|目标开业日|素材交付周期|发布频率|资源|约束|限制|不可妥协|审批权限|截止时间)/u),
  dimension('incident_action_confidentiality', '事件原始记录/已采取动作/公开限制', ['governance', 'customer_service', 'operations'], /(?:真实事件记录|已采取措施|不得公开的信息)/u, /(?:事件编号|事件原文|已采取措施|处置动作|公开限制|保密级别|不得公开)/u),
  dimension('replication_governance', '管理层问题/可复制边界/试点权限', ['strategy', 'governance', 'operations'], /(?:管理层要解决的问题|可复制边界|试点权限)/u, /(?:管理层问题|决策问题|可复制边界|试点范围|试点权限)/u),
]);

const unique = values => [...new Set(values.filter(Boolean))];

function categoryFamily(category) {
  return CATEGORY_FAMILIES.find(([, pattern]) => pattern.test(String(category || '')))?.[0] || 'unknown';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrubPayload(payload, input) {
  return String(payload || '')
    .replace(new RegExp(`输入项:${escapeRegExp(input)}(?=[,}])`, 'gu'), '')
    .replace(new RegExp(escapeRegExp(input), 'gu'), '')
    .replace(/recordId:[^,}]+/giu, '')
    .replace(/(?:业务对象|来源系统|期间|批次|台账批次|凭证批次|工单批次|检查批次|原始行号|状态|台账状态|责任角色|脱敏):[^,}]+/gu, '')
    .replace(/(?:纳米Work验收门店A|门店A业务台账|已核验)/giu, '')
    .trim();
}

function rawCoreHints(input) {
  return unique(String(input || '')
    .replace(/[（(](?:若有|选填)[）)]/gu, '')
    .replace(/^收集并标注来源日期：?/u, '')
    .split(/[、，；/|]/u)
    .map(value => value.trim().replace(/[。：:]$/u, ''))
    .filter(value => value.length >= 2))
    .slice(0, 12);
}

export function expectedFactDimensions(input) {
  return RESTAURANT_INPUT_FACT_DIMENSIONS.filter(item => item.trigger.test(String(input || '')));
}

export function parseRestaurantDispatchMaterials(dispatch, profile) {
  const requirement = String(dispatch?.requirement || '');
  const inputs = Array.isArray(profile?.dispatch?.requiredInputs) ? profile.dispatch.requiredInputs : [];
  const idx = Number(profile?.identity?.idx);
  return inputs.map((input, offset) => {
    const inputIndex = offset + 1;
    const marker = `【材料 E-${idx}-${inputIndex}】`;
    const next = inputIndex < inputs.length ? `【材料 E-${idx}-${inputIndex + 1}】` : null;
    const start = requirement.indexOf(marker);
    const nextStart = next ? requirement.indexOf(next, start + marker.length) : -1;
    const ruleStart = requirement.indexOf('\n证据规则：', start + marker.length);
    const end = nextStart >= 0 ? nextStart : ruleStart >= 0 ? ruleStart : requirement.length;
    const segment = start >= 0 ? requirement.slice(start, end) : '';
    const bodyAt = segment.indexOf('正文=');
    const bodyText = bodyAt >= 0
      ? segment.slice(bodyAt + '正文='.length).split('\n', 1)[0].trim()
      : '';
    let structured = null;
    try {
      structured = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      structured = null;
    }
    const legacy = structured ? null : segment.match(/正文=([^={；。\n]+)=\{([\s\S]*?)\}(?:[；。]|$)/u);
    const tags = Array.isArray(structured?.tags) ? structured.tags.map(String) : [];
    return {
      employeeIdx: idx,
      inputIndex,
      input: String(input || '').trim(),
      marker,
      category: structured ? (tags.join('+') || String(structured.mapping || '无标签')) : legacy?.[1]?.trim() || null,
      payload: structured ? JSON.stringify(structured.fields || {}) : legacy?.[2]?.trim() || '',
      parseValid: Boolean(structured || legacy),
      mapping: structured?.mapping || null,
      tags,
    };
  });
}

export function auditRestaurantMaterial({ employee, material }) {
  const expected = expectedFactDimensions(material.input);
  const actualFamily = categoryFamily(material.category);
  const actualFamilies = unique([
    ...(material.tags || []).flatMap(tag => TAG_FAMILIES[tag] || []),
    actualFamily === 'unknown' ? null : actualFamily,
  ]);
  const semanticPayload = scrubPayload(material.payload, material.input);
  const covered = expected.filter(item => item.evidence.test(semanticPayload));
  const missing = expected.filter(item => !item.evidence.test(semanticPayload));
  const expectedFamilies = unique(expected.flatMap(item => item.families));
  const issues = [];
  if (!material.parseValid) issues.push('material_body_unparseable');
  if (GENERIC_CATEGORIES.has(material.category)
    || material.mapping === 'UNMAPPED_REQUIRED_INPUT'
    || (material.parseValid && material.mapping && !(material.tags || []).length)) {
    issues.push('over_generic_body');
  }
  if (!expected.length) issues.push('unmapped_input_semantics');
  if (material.parseValid && actualFamily === 'unknown' && !actualFamilies.length) issues.push('unknown_actual_category');
  if (material.parseValid && actualFamilies.length && expectedFamilies.length
    && !actualFamilies.some(family => expectedFamilies.includes(family))) {
    issues.push('semantic_category_mismatch');
  }
  if (missing.length) issues.push('missing_core_fields');
  const qaOnlyRegulation = /(?:"QA_ONLY"\s*:\s*true|"QA_ONLY_MARKER"\s*:\s*"QA_ONLY_SYNTHETIC"|"数据性质"\s*:\s*"QA_ONLY_SYNTHETIC"|"结论状态"\s*:\s*"QA_ONLY")/u.test(material.payload);
  if (expected.some(item => item.id === 'regulation')
    && !qaOnlyRegulation
    && /(?:具体条文绑定|地区适用|法律结论)["']?\s*:\s*["']?(?:待|未形成)/u.test(material.payload)) {
    issues.push('required_external_fact_unresolved');
  }
  if (/^收集并标注来源日期：?$/u.test(material.input)) {
    issues.push('catalog_leadin_misparsed_as_input');
  }
  const fallbackHints = rawCoreHints(material.input);
  return {
    employeeIdx: Number(employee.idx),
    employeeName: employee.name,
    group: employee.group,
    inputIndex: material.inputIndex,
    input: material.input,
    actualCategory: material.category || '无法解析',
    actualFamily,
    actualFamilies,
    expectedCoreFields: expected.length ? expected.map(item => item.label) : fallbackHints,
    coveredCoreFields: covered.map(item => item.label),
    missingCoreFields: missing.length ? missing.map(item => item.label) : expected.length ? [] : fallbackHints,
    expectedFamilies,
    issues: unique(issues),
    pass: issues.length === 0,
  };
}

export function auditRestaurantMaterialCoverage({ catalog = loadRestaurantCatalog() } = {}) {
  const rows = [];
  const employeeReadiness = [];
  for (const employee of catalog.employees) {
    const profile = {
      identity: { idx: employee.idx, key: employee.key, name: employee.name, duty: employee.duty },
      dispatch: {
        defaultTaskType: '执行方案',
        requiredInputs: [...employee.inputs],
        guidance: { taskExamples: [], deliverableChecklist: [...employee.deliverables] },
      },
    };
    const dispatch = buildRestaurantDispatch(profile, `material-coverage-audit-${employee.idx}`);
    const operationalBlockReasons = Array.isArray(dispatch.operationalBlockReasons)
      ? [...dispatch.operationalBlockReasons]
      : [];
    const fixtureOperationalReady = !operationalBlockReasons.some((reason) =>
      /^TASK_COMPLETENESS_/u.test(String(reason))
    );
    const materials = parseRestaurantDispatchMaterials(dispatch, profile);
    const regulatory = regulatorySnapshot(materials);
    const businessOperationalReady = regulatory.realWorldBlockers.length === 0;
    employeeReadiness.push({
      employeeIdx: Number(employee.idx),
      employeeName: employee.name,
      qaCapabilityRunnable: dispatch.qaCapabilityRunnable === true,
      // Deterministic fixture/task readiness is intentionally separate from
      // business execution readiness, which can remain blocked by current
      // regulation or private-scope evidence.
      fixtureOperationalReady,
      operationalReady: dispatch.operationalReady === true,
      operationalBlocked: dispatch.operationalReady === false,
      operationalBlockReasons,
      qaOnlyRegulatory: regulatory.qaOnly,
      realWorldBlockers: regulatory.realWorldBlockers,
      businessOperationalReady,
      businessOperationalBlocked: !businessOperationalReady,
    });
    rows.push(...materials.map(material => auditRestaurantMaterial({ employee, material })));
  }
  const failures = rows.filter(row => !row.pass);
  const issueCounts = {};
  const categoryCounts = {};
  for (const row of rows) {
    categoryCounts[row.actualCategory] = (categoryCounts[row.actualCategory] || 0) + 1;
    for (const issue of row.issues) issueCounts[issue] = (issueCounts[issue] || 0) + 1;
  }
  const qaCapabilityRunnableEmployees = employeeReadiness
    .filter(row => row.qaCapabilityRunnable);
  const operationalReadyEmployees = employeeReadiness
    .filter(row => row.operationalReady);
  const operationalBlockedEmployees = employeeReadiness
    .filter(row => row.operationalBlocked);
  const fixtureOperationalReadyEmployees = employeeReadiness
    .filter(row => row.fixtureOperationalReady);
  const businessOperationalReadyEmployees = employeeReadiness
    .filter(row => row.businessOperationalReady);
  const businessOperationalBlockedEmployees = employeeReadiness
    .filter(row => row.businessOperationalBlocked);
  return {
    schema: 'nanowork.restaurant-material-coverage-audit.v2',
    generatedAt: new Date().toISOString(),
    valid: failures.length === 0
      && qaCapabilityRunnableEmployees.length === employeeReadiness.length,
    summary: {
      employeeCount: catalog.employees.length,
      requiredInputCount: rows.length,
      passingInputCount: rows.length - failures.length,
      failingInputCount: failures.length,
      issueCounts,
      categoryCounts,
      qaCapabilityRunnable: {
        passed: qaCapabilityRunnableEmployees.length,
        total: employeeReadiness.length,
      },
      fixtureOperationalReady: {
        passed: fixtureOperationalReadyEmployees.length,
        total: employeeReadiness.length,
      },
      operationalReady: {
        passed: operationalReadyEmployees.length,
        total: employeeReadiness.length,
      },
      operationalBlocked: {
        count: operationalBlockedEmployees.length,
        total: employeeReadiness.length,
      },
      operationalBlockedEmployeeIndexes: operationalBlockedEmployees.map(row => row.employeeIdx),
      // `operationalReady` is the isolated generation/dispatch gate.  Keep
      // real-world regulation/private-scope blocks orthogonal so QA_ONLY does
      // not get reported as business authorization.
      businessOperationalReady: {
        passed: businessOperationalReadyEmployees.length,
        total: employeeReadiness.length,
      },
      businessOperationalBlocked: {
        count: businessOperationalBlockedEmployees.length,
        total: employeeReadiness.length,
      },
      businessOperationalBlockedEmployeeIndexes: businessOperationalBlockedEmployees.map(row => row.employeeIdx),
    },
    employeeReadiness,
    rows,
  };
}

function markdownCell(value) {
  return String(value ?? '').replace(/\|/gu, '／').replace(/\r?\n/gu, '<br>');
}

export function restaurantMaterialAuditMarkdown(report) {
  const lines = [
    `# ${report.summary.qaCapabilityRunnable.total} 名餐饮数字员工 requiredInputs 材料语义覆盖审计`, '',
    `- 审计时间：${report.generatedAt}`,
    `- 岗位：${report.summary.employeeCount} 个`,
    `- 必需输入：${report.summary.requiredInputCount} 条`,
    `- 通过：${report.summary.passingInputCount} 条`,
    `- 失败：${report.summary.failingInputCount} 条`,
    `- 隔离 QA 能力可跑：${report.summary.qaCapabilityRunnable.passed}/${report.summary.qaCapabilityRunnable.total} 岗`,
    `- 材料 fixture 任务就绪（operationalReady）：${report.summary.fixtureOperationalReady.passed}/${report.summary.fixtureOperationalReady.total} 岗`,
    `- 隔离生成派活就绪（operationalReady）：${report.summary.operationalReady.passed}/${report.summary.operationalReady.total} 岗`,
    `- 真实业务采纳/外部执行就绪：${report.summary.businessOperationalReady.passed}/${report.summary.businessOperationalReady.total} 岗`,
    `- QA_ONLY真实业务/外部执行阻断：${report.summary.businessOperationalBlocked.count}/${report.summary.businessOperationalBlocked.total} 岗（${report.summary.businessOperationalBlockedEmployeeIndexes.join('、')}）`,
    `- 结论：${report.valid ? 'PASS' : 'FAIL（不得作为真实 API 全岗验收材料）'}`, '',
    '## 能力验收与业务就绪边界', '',
    '| 员工 | 岗位 | 隔离QA可跑 | 隔离生成就绪 | 真实业务采纳/外部执行 | 真实阻塞码 |',
    '|---:|---|---|---|---|---|',
    ...report.employeeReadiness.map(item => `| ${item.employeeIdx} | ${markdownCell(item.employeeName)} | ${item.qaCapabilityRunnable ? 'YES' : 'NO'} | ${item.operationalReady ? 'YES' : 'NO'} | ${item.businessOperationalReady ? 'YES' : 'BLOCKED'} | ${markdownCell(item.realWorldBlockers.join('<br>') || item.operationalBlockReasons.join('<br>') || '—')} |`), '',
    '## 问题统计', '', '| 问题码 | 条数 |', '|---|---:|',
    ...Object.entries(report.summary.issueCounts).sort((a, b) => b[1] - a[1]).map(([issue, count]) => `| ${issue} | ${count} |`), '',
    '## 实际正文类别', '', '| 正文类别 | 条数 |', '|---|---:|',
    ...Object.entries(report.summary.categoryCounts).sort((a, b) => b[1] - a[1]).map(([category, count]) => `| ${markdownCell(category)} | ${count} |`), '',
    '## 逐条错配、过泛与缺字段清单', '',
    '| 员工 | 岗位 | # | requiredInput | 实际正文类别 | 问题 | 应有核心字段 | 已覆盖 | 缺失核心字段 |',
    '|---:|---|---:|---|---|---|---|---|---|',
  ];
  for (const row of report.rows.filter(item => !item.pass)) {
    lines.push(`| ${row.employeeIdx} | ${markdownCell(row.employeeName)} | ${row.inputIndex} | ${markdownCell(row.input)} | ${markdownCell(row.actualCategory)} | ${row.issues.join('<br>')} | ${row.expectedCoreFields.map(markdownCell).join('<br>')} | ${row.coveredCoreFields.map(markdownCell).join('<br>') || '—'} | ${row.missingCoreFields.map(markdownCell).join('<br>') || '—'} |`);
  }
  lines.push('', '## 硬门规则', '',
    '- `over_generic_body`：“业务台账明细”等通用正文一律失败，不允许仅复述输入名称。',
    '- `semantic_category_mismatch`：正文类别与输入主题无任何语义交集。',
    '- `missing_core_fields`：必需输入声明的事实维度未在正文结构化字段或值中出现。',
    '- `unmapped_input_semantics`：独立审计字典尚未覆盖的输入也是失败，不允许静默落到通用台账。',
    '- `required_external_fact_unresolved`：要求现行法规/平台规则时，只给入口且写“待核验”不算材料齐备。', '');
  return lines.join('\n');
}

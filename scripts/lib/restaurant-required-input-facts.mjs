const FOOD_SAFETY_LAW = 'https://flk.npc.gov.cn/detail?fileId=&id=ff8081817ab22e0c017abd8d85a205f1';
const CATERING_CODE = 'https://www.samr.gov.cn/spjys/tzgg/art/2023/art_b34916e29ae945bf884d0fae61892402.html';
const NETWORK_CATERING = 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/fgs/art/2026/art_d04d512f5ad8470eb61a652c0061dc3a.html';
const FOOD_LABEL_2011 = 'https://www.nhc.gov.cn/zwgk/cybz/201106/53c53d99b71940c7a74830f86b46f8db.shtml';
const NUTRITION_2011 = 'https://www.nhc.gov.cn/sps/c100088/201111/714fdca49f15450580fc03a2ee3163f9.shtml';
const FOOD_LABEL_2025 = 'https://www.nhc.gov.cn/wjw/zcwjgg/202503/97802a2683b840dd8be0e1449982c6a5.shtml';
const PIPL = 'https://flk.npc.gov.cn/detail?fileId=&id=ff8081817b6472a3017b656cc2040044';
const AD_LAW = 'https://flk.npc.gov.cn/detail?id=ff8081817ab231eb017abd6bd860052d';
const LABOR_LAW = 'https://flk.npc.gov.cn/detail?id=ff8080816f135f46016f20f16ee11737';
const CONSUMER_RULE = 'https://flk.npc.gov.cn/detail?fileId=&id=ff808181927f09310192c2f4cd777281';
const ACCESSIBILITY_LAW = 'https://wb.flk.npc.gov.cn/flfg/PDF/c845735d7d86448e9849051acbcb4aba.pdf';
const FOOD_WASTE_STANDARD = 'https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=C25D74A82DDD2556F144686FBD245FCB';
const FOOD_WASTE_LAW = 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/bgt/art/2023/art_5f92392ecaa14e048bd9a673715c20ca.html';
const DOUYIN_LIFE_RULES = 'https://life.douyin.com/support/?pageId=222&spaceId=123';
const DOUYIN_LIFE_PLATFORM = 'https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/operation/industry-norm/lifeservice/industry-mgmt-rules';
const PROMOTION_RULE = 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/fgs/art/2023/art_cae53a080be2401e8f91c6d6291539f8.html';
const PRICE_RULE = 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/fgs/art/2023/art_9a1f82a007964950a1a0f6c056f2fedf.html';
const SMS_RULE = 'https://www.miit.gov.cn/gyhxxhb/jgsj/cyzcyfgs/bmgz/xxtxl/art/2026/art_f729621047ec4c30bcdd5cd4101f9568.html';
const EQUIPMENT_RULE = 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/tzsbs/art/2026/art_ccfd987974c9490ab5d8c0792593f1d3.html';
const LANGUAGE_LAW = 'https://www.moe.gov.cn/jyb_sjzl/sjzl_zcfg/zcfg_jyfl/202606/t20260605_1438880.html';
const HACCP_CATERING = 'https://std.samr.gov.cn/gb/search/gbDetailed?id=71F772D77BADD3A7E05397BE0A0AB82A';
const FOOD_SAFETY_TRAINING = 'https://www.samr.gov.cn/spxts/gzdt/art/2025/art_26ec1e8830ad4829a38ec3ccfc5b1a61.html';
const WORK_TIME_RULE = 'https://xzfg.moj.gov.cn/front/law/detail?LawID=629&Query=';

const fixed = fields => () => ({ ...fields });
const fact = (id, trigger, fields, required = Object.keys(fields)) => Object.freeze({
  id,
  trigger,
  build: typeof fields === 'function' ? fields : fixed(fields),
  required: Object.freeze(required),
});

function regulationRecord(idx) {
  const records = {
    109: ['《餐饮服务食品安全操作规范》', '市场监管总局公告2018年第12号·7.7.3/7.8/8.1.3', '高风险易腐食品冷却、复热和暂存必须执行条款规定的时间温度控制', CATERING_CODE, '太原市验收门店的高风险易腐食品；产品验证和属地更严规则另核'],
    114: ['GB 28050-2011《预包装食品营养标签通则》', '4.1、附录A/表1', '预包装食品营养标签按法定单位标示核心营养素含量及NRV百分比', NUTRITION_2011, '当前验收日期适用2011版；2025版于2027-03-16实施'],
    115: ['GB 7718-2011《预包装食品标签通则》问答', '第六十二问/标准4.4.3', '八类致敏物质属于鼓励自愿标示，并非全国餐饮强制清单结论', 'https://www.nhc.gov.cn/zwgk/zcjd/201402/544c0539b95d4d35b99ffbc105579071.shtml', '预包装食品；现制餐饮告知义务和属地清单另行确认'],
    116: ['《中华人民共和国食品安全法》', '第三十三条、第四十四条', '食品经营应具备卫生条件并建立食品安全管理制度与人员培训记录', FOOD_SAFETY_LAW, '太原市验收门店GHP与PRP基础方案'],
    117: ['GB/T 27306-2008《食品安全管理体系 餐饮业要求》', '推荐性国家标准GB/T 27306-2008', '餐饮HACCP体系可按该推荐标准建立，但不证明认证、合同或许可范围', HACCP_CATERING, '太原市验收门店HACCP草案；认证、合同与许可必须人工验真'],
    118: ['《餐饮服务食品安全操作规范》', '市场监管总局公告2018年第12号·7.7.3/7.8/8.1.3', '高风险易腐食品冷却、复热和暂存执行明确时间温度条件', CATERING_CODE, '验收食品分类为热加工即食食品；易感人群和属地限值另核'],
    120: ['《中华人民共和国食品安全法》', '第四十五条', '接触直接入口食品人员应每年健康检查，患规定疾病者不得从事相关工作', FOOD_SAFETY_LAW, '太原市验收门店直接入口食品岗位'],
    122: ['《中华人民共和国食品安全法》', '第五十三条、第五十五条', '食品经营者应查验供货者许可和合格证明，餐饮服务者不得采购不合格原料', FOOD_SAFETY_LAW, '太原市验收门店食品原料采购'],
    123: ['《中华人民共和国食品安全法》', '第四十二条、第六十三条', '建立全程追溯制度；发现不安全食品应召回、停止经营并报告', FOOD_SAFETY_LAW, '太原市验收门店原料、成品及网络订单追溯'],
    124: ['《食品经营许可和备案管理办法》', '市场监管总局令第78号·第二条/第四条', '境内食品销售和餐饮服务许可、备案及监督检查适用该办法', 'https://www.samr.gov.cn/cms_files/filemanager/1647978232/attach/20236/11c003f92242446e9be9f1ca600f7444.pdf', '太原市验收门店许可和内审准则'],
    133: ['《中华人民共和国无障碍环境建设法》', '第四十五条', '国家鼓励餐饮等生活服务场所提供无障碍服务', ACCESSIBILITY_LAW, '太原市验收门店前厅服务；建筑硬性要求、退款和平台条款另核'],
    135: ['《消费者权益保护法实施条例》', '第九条、第十七条', '经营者应尊重消费者人格尊严并真实全面提供商品服务信息', CONSUMER_RULE, '太原市验收门店订座等位服务与消费者权益'],
    137: ['食品安全总监和食品安全员培训规则官方说明', '特定食品安全管理岗位每年培训不少于40小时', '40小时要求只适用于规则覆盖的食品安全总监和食品安全员', FOOD_SAFETY_TRAINING, '验收岗位锁定为食品安全员；不得推导所有员工均须法定证书'],
    138: ['《网络餐饮服务食品安全监督管理规定》', '市场监管总局令第123号·2026-06-01施行', '网络餐饮经营者和平台应落实资质、信息公示、投诉与食品安全责任', NETWORK_CATERING, '验收平台锁定抖音生活服务餐饮团购；顾客数据另适用个人信息保护法'],
    139: ['TSG 08-2026《特种设备使用管理规则》', 'TSG 08-2026', '目录内特种设备应办理使用登记并按规定实施定期检验', EQUIPMENT_RULE, '验收资产锁定为曳引式杂物电梯；型号目录归类、厂家文件和验收记录须人工验真'],
    140: ['《中华人民共和国国家通用语言文字法》', '第十四条（2026-01-01施行）', '公共服务行业以规范汉字为基本服务用字', LANGUAGE_LAW, '太原市验收门店中文菜单；无全国统一餐饮菜单字号结论'],
    141: ['《规范促销行为暂行规定》', '市场监管总局令第32号·第五条/第十三条/第二十条', '促销信息须真实醒目；有奖销售规则和限时条件应事先明确公示', PROMOTION_RULE, '太原市验收门店营销活动；平台锁定抖音生活服务'],
    142: ['抖音生活服务平台规则', '规则中心现行版本·核验日2026-07-31', '餐饮商家内容、UGC、促销与账号运营须遵守现行行业及平台规则', DOUYIN_LIFE_RULES, '验收平台锁定抖音生活服务'],
    145: ['《规范促销行为暂行规定》', '市场监管总局令第32号·第十三条/第二十条/第二十一条', '抽奖信息、促销期限、附加条件及折价基准应清晰公示', PROMOTION_RULE, '太原市验收门店优惠券与促销实验；平台锁定抖音生活服务'],
    149: ['《中华人民共和国劳动法》', '第四十一条', '延长工时一般每日不超过3小时且每月不超过36小时', LABOR_LAW, '太原市验收门店劳动排班；集体协议、特殊工时批复和地方口径另核'],
    155: ['《餐饮服务食品安全操作规范》', '市场监管总局公告2018年第12号', '餐饮SOP应覆盖人员、场所、过程控制、清洁消毒和记录要求', CATERING_CODE, '太原市三店试点；本地法规差异仍需人工法务确认'],
    157: ['《中华人民共和国反食品浪费法》', '第七条', '餐饮服务经营者应主动提示并引导消费者按需适量点餐', FOOD_WASTE_LAW, '太原市验收门店；捐赠、饲料、堆肥、运输及承运商要求另行核验'],
    159: ['《中华人民共和国食品安全法》', '第四十三条、第六十三条、第一百零三条', '责任保险属鼓励；不安全食品须停营召回，事故须立即处置并报告', FOOD_SAFETY_LAW, '太原市验收门店；实际保单、预案、监管联系人和属地报告口径另核'],
  };
  const selected = records[Number(idx)];
  if (!selected) return null;
  const [法规名称, 文号条款, 要求原文, 官方链接, 适用范围] = selected;
  const blockers = {
    109: ['BLOCKED_LOCAL_RULE_CONFIRMATION', 'BLOCKED_PRODUCT_VALIDATION'],
    114: ['BLOCKED_FOOD_FORM_AND_LABEL_FORMAT', 'BLOCKED_PRIVATE_NUTRITION_BASIS'],
    115: ['BLOCKED_LOCAL_ALLERGEN_DUTY', 'BLOCKED_PRIVATE_ALLERGEN_MATRIX'],
    116: ['BLOCKED_PRIVATE_SOP_AND_INSPECTION_RECORDS'],
    117: ['BLOCKED_LICENSE_CONTRACT_CERTIFICATION_SCOPE'],
    118: ['BLOCKED_FOOD_CATEGORY_AND_CONSUMER_SCOPE', 'BLOCKED_LOCAL_LIMITS'],
    120: ['BLOCKED_LOCAL_EMPLOYEE_RULES', 'BLOCKED_PRIVATE_HEALTH_PRIVACY_POLICY'],
    122: ['BLOCKED_LOCAL_PROCUREMENT_RULES', 'BLOCKED_LICENSE_AND_PRODUCT_SCOPE'],
    123: ['BLOCKED_LOCAL_REPORTING_CONTACT', 'BLOCKED_PRIVATE_TRACEABILITY_RECORDS'],
    124: ['BLOCKED_LOCAL_AUDIT_CRITERIA', 'BLOCKED_PRIVATE_LICENSE_SOP_CERTIFICATION'],
    133: ['BLOCKED_LOCAL_ACCESSIBILITY_REFUND_RULES', 'BLOCKED_PLATFORM_TERMS_VERSION', 'BLOCKED_PRIVATE_SERVICE_POLICY'],
    135: ['BLOCKED_LOCAL_CONSUMER_ACCESSIBILITY_RULES', 'BLOCKED_PLATFORM_TERMS_VERSION', 'BLOCKED_PRIVATE_BOOKING_POLICY'],
    137: ['BLOCKED_ROLE_QUALIFICATION_SCOPE', 'BLOCKED_LOCAL_TRAINING_RULES', 'BLOCKED_PRIVATE_CERTIFICATES'],
    138: ['BLOCKED_LOCAL_REPORTING_DUTY', 'BLOCKED_PLATFORM_TERMS_VERSION', 'BLOCKED_PRIVATE_INCIDENT_AUTHORITY'],
    139: ['BLOCKED_ASSET_CATALOG_CLASSIFICATION', 'BLOCKED_LOCAL_INSPECTION_RULES', 'BLOCKED_PRIVATE_MANUFACTURER_ACCEPTANCE_RECORDS'],
    140: ['BLOCKED_LOCAL_LANGUAGE_ACCESSIBILITY_RULES', 'BLOCKED_MENU_MEDIUM_SCOPE'],
    141: ['BLOCKED_LOCAL_AD_PROMOTION_RULES', 'BLOCKED_PLATFORM_TERMS_VERSION', 'BLOCKED_PRIVATE_CONSENT_APPROVAL_RECORDS'],
    142: ['BLOCKED_PLATFORM_TERMS_VERSION', 'BLOCKED_PRIVATE_CONTENT_AUTHORIZATIONS'],
    145: ['BLOCKED_LOCAL_PRICE_PROMOTION_RULES', 'BLOCKED_PLATFORM_TERMS_VERSION', 'BLOCKED_PRIVATE_EXPERIMENT_BASELINE'],
    149: ['BLOCKED_LOCAL_LABOR_RULES', 'BLOCKED_COLLECTIVE_AGREEMENT', 'BLOCKED_PRIVATE_TIME_APPROVAL_RECORDS'],
    155: ['BLOCKED_LOCAL_REGULATION_DIFFERENCES', 'BLOCKED_PRIVATE_SOP_EXCEPTION_APPROVALS'],
    157: ['BLOCKED_LOCAL_DONATION_WASTE_TRANSPORT_RULES', 'BLOCKED_PRIVATE_DISPOSAL_DESTINATION'],
    159: ['BLOCKED_LOCAL_REPORTING_INSURANCE_RULES', 'BLOCKED_PRIVATE_POLICY_PLAN_CONTACTS'],
  };
  const common = {
    验收司法辖区: '中国/山西省/太原市',
    核验日期: '2026-07-31',
    法规名称,
    文号条款,
    要求原文,
    官方链接,
    适用范围,
    结论状态: '未形成法律结论',
    人工法务确认: '必须由负责人和法务确认太原市属地适用性，不得据此声称门店已合规',
    QA能力验收资格: 'RUNNABLE',
    业务执行资格: 'BLOCKED',
    阻塞原因: blockers[idx] || ['BLOCKED_CURRENT_REGULATION_SCOPE'],
  };
  const supplemental = {
    114: [{ 法规名称: 'GB 28050-2025', 版本状态: '2027-03-16实施', 官方链接: FOOD_LABEL_2025 }],
    115: [{ 法规名称: 'GB 7718-2025', 版本状态: '2027-03-16实施', 官方链接: FOOD_LABEL_2025 }],
    120: [
      { 法规名称: '中华人民共和国劳动法', 文号条款: '第三十六条至第三十九条', 官方链接: LABOR_LAW },
      { 法规名称: '中华人民共和国个人信息保护法', 文号条款: '第十三条、第二十八条至第三十条', 官方链接: PIPL },
    ],
    133: [
      { 法规名称: '消费者权益保护法实施条例', 文号条款: '第九条、第十条、第十二条、第二十四条', 官方链接: CONSUMER_RULE },
      { 法规名称: '抖音生活服务管理规则', 文号条款: '现行行业规则', 官方链接: DOUYIN_LIFE_PLATFORM },
    ],
    135: [
      { 法规名称: '中华人民共和国个人信息保护法', 文号条款: '第十三条、第二十八条', 官方链接: PIPL },
      { 法规名称: '中华人民共和国无障碍环境建设法', 文号条款: '第二条', 官方链接: ACCESSIBILITY_LAW },
      { 法规名称: '抖音生活服务管理规则', 文号条款: '现行行业规则', 官方链接: DOUYIN_LIFE_PLATFORM },
    ],
    138: [
      { 法规名称: '消费者权益保护法实施条例', 文号条款: '第十二条、第二十四条', 官方链接: CONSUMER_RULE },
      { 法规名称: '中华人民共和国个人信息保护法', 文号条款: '第十三条、第二十八条、第二十九条', 官方链接: PIPL },
      { 法规名称: '抖音生活服务管理规则', 文号条款: '现行行业规则', 官方链接: DOUYIN_LIFE_PLATFORM },
    ],
    141: [
      { 法规名称: '中华人民共和国广告法', 文号条款: '第四条、第八条', 官方链接: AD_LAW },
      { 法规名称: '中华人民共和国个人信息保护法', 文号条款: '第十三条、第十五条', 官方链接: PIPL },
      { 法规名称: '通信短信息服务管理规定', 文号条款: '第二十一条至第二十三条', 官方链接: SMS_RULE },
      { 法规名称: '抖音生活服务管理规则', 文号条款: '现行行业规则', 官方链接: DOUYIN_LIFE_PLATFORM },
    ],
    142: [
      { 法规名称: '中华人民共和国广告法', 文号条款: '第八条、第九条', 官方链接: AD_LAW },
      { 法规名称: '中华人民共和国个人信息保护法', 文号条款: '第十三条', 官方链接: PIPL },
      { 法规名称: '规范促销行为暂行规定', 文号条款: '第五条、第十三条', 官方链接: PROMOTION_RULE },
      { 法规名称: '抖音开放平台生活服务管理规则', 文号条款: '现行版本', 官方链接: DOUYIN_LIFE_PLATFORM },
    ],
    145: [
      { 法规名称: '中华人民共和国广告法', 文号条款: '第四条、第八条', 官方链接: AD_LAW },
      { 法规名称: '消费者权益保护法实施条例', 文号条款: '第九条、第十条', 官方链接: CONSUMER_RULE },
      { 法规名称: '明码标价和禁止价格欺诈规定', 文号条款: '第十九条、第二十条', 官方链接: PRICE_RULE },
      { 法规名称: '抖音生活服务管理规则', 文号条款: '现行行业规则', 官方链接: DOUYIN_LIFE_PLATFORM },
    ],
    149: [{ 法规名称: '国务院关于职工工作时间的规定', 文号条款: '第三条', 官方链接: WORK_TIME_RULE }],
    157: [{ 法规名称: 'GB/T 42966-2023餐饮业反食品浪费管理通则', 文号条款: '推荐性国家标准', 官方链接: FOOD_WASTE_STANDARD }],
  };
  return { ...common, ...(supplemental[idx] ? { 补充依据: supplemental[idx] } : {}) };
}

export const RESTAURANT_INPUT_FACT_SPECS = Object.freeze([
  fact('jurisdiction', /(?:国家|省市|城市|地区|司法辖区|当地|区域|市场)/u, { 国家: '中国', 省: '山西省', 市: '太原市', 司法辖区: '山西省太原市' }),
  fact('business_scope', /(?:门店|中央厨房|法人|组织|部门|店型|业态|经营主体|多店)/u, { 门店编号: 'QA-TY-A', 业态: '堂食+外卖', 业务范围: '太原市验收门店A' }),
  fact('address', /(?:地址|坐标|商圈|场地|地点|候选点|交付地点)/u, { 地址: '太原市小店区验收路100号', 坐标: '37.81,112.55', 商圈: '小店验收商圈' }),
  fact('catchment', /(?:半径|通行时间|交通|里程|路线|服务区域|配送网络)/u, { 覆盖半径公里: 3, 交通方式: '步行+骑行', 通行时间分钟: 15 }),
  fact('time_scope', /(?:期间|日期|时区|营业日|营业时段|营业时间|餐段|时段|班次|开业日|截止时间|时间窗|会计日历)/u, { 期间: '2026-07-01/2026-07-31', 时区: 'Asia/Shanghai', 营业时段: '10:00-22:00', 餐段: '午餐+晚餐' }),
  fact('product_menu', /(?:品类|菜系|菜单|菜品|食品形态|食品类别|产品|新品|饮料|品项)/u, { 品类: '中式简餐', 菜单版本: 'M-202607', 菜品数: 12, 食品形态: '现制热食' }),
  fact('customer_segment', /(?:目标客群|目标顾客|目标消费者|目标人群|目标供餐人群|高易感人群|用餐场景|顾客数|受众)/u, { 客群: '周边办公人群', 顾客类型: '成年消费者', 用餐场景: '工作日午晚餐', 顾客数: 2000 }),
  fact('channel', /(?:渠道|堂食|外卖|自提|宴会|团餐|销售平台)/u, { 渠道: '堂食/外卖/自提', 堂食占比: '60%', 外卖占比: '35%', 自提占比: '5%' }),
  fact('price_volume', /(?:价格带|客单|售价|净售价|菜单价格|销量|客数|数量|份数|规模|销售组合|菜品组合)/u, { 价格带: '40-60元', 客单价元: 50, 销量份: 2000, 销售组合: '堂食1200/外卖700/自提100' }),
  fact('market_competition', /(?:竞品|竞争价格|市场机会|调研|顾客访谈|试卖反馈|地图|实地观察|搜索数据)/u, { 竞品数: 8, 调研样本: 'QA-C1/C2/C3', 实地观察日期: '2026-07-15', 搜索数据批次: 'SEARCH-202607' }),
  fact('orders_demand', /(?:订单|客流|交易|需求|预测|预订|售罄|缺货|上架天数)/u, { 订单数: 2000, 客流人次: 1800, 需求预测份: 2100, 预测版本: 'DMD-202607' }),
  fact('promotion', /(?:活动|促销|投放|营销|广告|抽奖|优惠券|媒体成本|实验|对照|自然波动)/u, { 活动编号: 'MKT-202607', 促销机制: '满50减5验收草案', 投放预算元: 5000, 对照组: '未触达门店时段' }),
  fact('brand_content', /(?:品牌定位|品牌资产|品牌语调|价值主张|内容|图片|视频|音乐|商标|肖像|UGC|创作者|使用授权|人物故事)/iu, { 品牌定位: '可信赖的门店经营助手', 内容资产批次: 'BRAND-202607', 使用授权: 'QA-AUTH-001', 授权期限: '2026-12-31' }),
  fact('property_lease', /(?:面积|楼层|门面|交付条件|平面|租金|管理费|抽成|押金|免租|递增|租约|退出条款|座位|桌台图)/u, { 面积平方米: 180, 楼层: '1F', 租金月元: 12000, 押金元: 36000, 座位数: 64, 租约版本: 'LEASE-QA-01' }),
  fact('utilities', /(?:水电气|用水|制冰|通风|排水|排烟|隔油|消防|承重|垃圾|装卸|公用工程|电源|环境温度)/u, { 用水: '市政供水', 电源: '380V/120kW', 燃气: '管道天然气', 排烟: '独立烟道', 消防验收文件: 'FIRE-QA-01' }),
  fact('equipment', /(?:设备|资产|冷藏|冷冻|洗碗机|温度计|探针|记录仪|秤|检具|容器|维修|故障|停机|额定参数|保修|型号|序列号|备件)/u, { 资产名称: '曳引式杂物电梯', 型号: 'QA-DTW-01', 序列号: 'SN-QA-139-02', 位置: '后厨传菜区', 用途: '餐品周转', 关键性: '高', 维修责任人: '设施经理' }),
  fact('capital_budget', /(?:预算|投资|营运资金|资金约束|资本预算|目标回报|回收期|融资条件|折现|投资上限)/u, { 预算元: 300000, 投资上限元: 350000, 营运资金元: 100000, 目标回报期月: 24 }),
  fact('cost_margin', /(?:成本|毛利|利润|费用|食材|平台费|支付费|履约|浪费|报损|贡献)/u, { 食材成本元: 35000, 人工成本元: 22000, 平台费元: 6000, 毛利元: 65000, 贡献口径: '营业额-可变成本' }),
  fact('revenue_finance', /(?:营收|营业额|销售收入|净销售额|销售额|单店损益|损益|贡献)/u, { 营业额元: 100000, 净销售额元: 94000, 损益期间: '2026-07', 收入口径: '含税营业额' }),
  fact('cash_payment', /(?:现金|支付|付款|结算|银行|应收|应付|存款|信贷|债务|拒付|币种|账期)/u, { 币种: 'CNY', 现金余额元: 80000, 支付结算批次: 'PAY-202607', 银行凭证: 'BANK-QA-0731', 应付账期天: 30 }),
  fact('tax_accounting', /(?:税务|税费|含税|未税|会计口径|权责|现金口径|成本计价|折旧|会计日历|总账)/u, { 税费口径: '含税', 会计口径: '权责发生制', 成本计价: '移动加权', 折旧年限年: 5, 总账期间: '2026-07' }),
  fact('recipe_ingredient', /(?:配方|原料|复合配料|加工助剂|调味料|替代料|供应商规格|原始重量|实际耗用|原料品牌)/u, { 配方版本: 'R-202607', 原料规格: 'QA-SPEC-01', 原始重量克: 500, 实际耗用克: 450, 替代料: '无' }),
  fact('yield_portion', /(?:出成|份量|AP\s*重量|EP\s*重量|毛料|净料|修切|去皮|去骨|烹饪后重量|产出|总产量|量具)/iu, { AP重量克: 500, EP重量克: 430, 烹饪后重量克: 400, 出成率: '80%', 标准份量克: 200 }),
  fact('process_capacity', /(?:制作步骤|工艺|流程图|工位|制作时间|时长|节拍|产能|批量|生产顺序|出餐时长)/u, { 工艺版本: 'PROC-202607', 制作步骤数: 8, 工位: '热厨1号', 制作时间分钟: 12, 峰值产能份每小时: 80 }),
  fact('packaging_storage', /(?:包装|容器|储运|保存|货架期|保质|使用期限|效期|储存|库容|解冻|开封)/u, { 包装规格: '500g/食品级盒', 储运条件: '0-4℃', 保质期小时: 24, 库容箱: 40, 开封期限小时: 4 }),
  fact('nutrition_claim', /(?:营养|营养数据库|营养声明|营养声称|NRV|DV|法定单位|舍入规则|实验室报告)/iu, { 营养数据库版本: 'NUTRI-QA-202607', 法定单位: 'kJ/g/mg', NRV版本: 'GB28050-2011', 舍入规则: 'GB/T8170', 营养声称: '未经法务复核不得使用' }),
  fact('allergen', /(?:过敏原|交叉接触|交叉污染|高易感|顾客告知|员工应答)/u, { 过敏原清单: '含小麦/大豆/蛋', 交叉接触: '共用炸锅', 顾客告知渠道: '菜单+点单确认', 员工应答SOP: 'ALG-SOP-01' }),
  fact('temperature_control', /(?:温控|温度|冷却|复热|热藏|冷藏|冷冻|冷链|探针|红外|校准|布点|报警)/u, { 冷藏温度摄氏: 4, 热藏温度摄氏: 60, 复热中心温度摄氏: 70, 探针校准日期: '2026-07-20', 温控记录批次: 'TEMP-202607' }),
  fact('cleaning_hygiene', /(?:清洁|消毒|洗消|卫生|虫害|废弃物|清洁剂|消毒剂|生物膜|病原体|污染类型|ATP|微生物|洗手|工服)/iu, { 清洁消毒SOP: 'SAN-202607', 清洁剂: '食品接触面适用剂', 消毒浓度: '按产品标签', 虫害巡检日期: '2026-07-25', 废弃物去向: '授权清运' }),
  fact('food_safety', /(?:食品安全|食安|危害|关键控制点|关键限值|HACCP|GHP|PRP|高风险原料|安全资质|健康影响)/iu, { 食品安全计划: 'FSMS-QA-01', 危害: '生物/化学/物理', 关键控制点: '加热', 关键限值: '中心温度≥70℃', 食安责任人: '食品安全员' }),
  fact('regulation', /(?:法规|法定|官方|监管|适用标准|当地要求|劳动规则|隐私要求|消费者规则|平台规则|平台条款|报告义务|无障碍要求|反歧视)/u, ({ idx }) => regulationRecord(idx) || {}, [
    '验收司法辖区', '核验日期', '法规名称', '文号条款', '要求原文', '官方链接', '适用范围',
    '结论状态', '人工法务确认', 'QA能力验收资格', '业务执行资格', '阻塞原因',
  ]),
  fact('credential', /(?:证照|许可证|许可范围|许可状态|生产许可|经营许可|认证|资质|健康证明|法定资格|验收文件)/u,
    ({ idx, inputIndex }) => ({
      许可证编号: `QA-LIC-${idx}-${inputIndex + 1}`,
      许可范围: '热食类食品制售',
      发证机关: '太原市市场监督管理局验收数据',
      有效期: '2027-07-31',
      验收文件: 'ACCEPT-QA-01',
    }),
    ['许可证编号', '许可范围', '发证机关', '有效期', '验收文件']),
  fact('supplier', /(?:供应商|承运商|分包商|关键上游|生产地点|客户结构|供应风险)/u, { 供应商主体: 'QA供应商S01', 生产地点: '山西省太原市', 产能吨月: 20, 分包商: '无', 供应风险: '中' }),
  fact('procurement', /(?:采购|报价|发票|采购价|采购单|采购合同|最小起订|起订量|交期|退换货|调价条款|报价有效期|配送日|交付可靠性|合同)/u, { 采购单: 'PO-202607', 报价元公斤: 12, 发票批次: 'INV-202607', 起订量公斤: 50, 交期天: 2, 合同版本: 'CON-QA-01' }),
  fact('inventory_batch', /(?:库存|在库|在途|批次|追溯码|效期|盘点|调拨|调入|调出|领用|库位|库区|安全库存|临期|腐损|隔离)/u, { 库存数量: 320, 批次: 'LOT-202607', 追溯码: 'TRACE-QA-001', 效期: '2026-08-15', 库位: 'COLD-A01', 盘点日期: '2026-07-31' }),
  fact('logistics', /(?:收货|储运|配送|车辆|装卸|交付地点|交付周期|交付时限|交付可靠性|交接|拒收|退货|路线|停靠|运输|骑手|承运商)/u, { 收货区域: '后场收货区', 储运条件: '0-4℃', 配送车辆: 'QA-COLD-01', 交付地点: 'QA-TY-A', 交付时限小时: 4, 交接记录: 'LOG-202607' }),
  fact('traceability_recall', /(?:追溯|撤回|召回|生产批|使用记录|去向|已售数量|事件产品|召回演练)/u, { 追溯码: 'TRACE-QA-001', 生产批: 'LOT-202607', 使用记录: 'USE-202607', 去向: 'QA-TY-A', 已售数量: 120, 召回演练日期: '2026-07-18' }),
  fact('quality_audit', /(?:检验|检测|检查|抽检|验收|审核|内审|巡店|现场观察|不合格|不符合|偏差|纠正|校准|验证)/u, { 检验报告: 'LAB-QA-01', 审核日期: '2026-07-22', 不合格编号: 'NC-QA-01', 偏差: '温控记录缺1次', 纠正措施: '补训并复核', 验证日期: '2026-07-29' }),
  fact('workforce', /(?:人员|员工|岗位|技能|编制|人工|组织|责任班次|负责人|支援团队|外包人工)/u, { 岗位: '门店运营岗', 员工数: 18, 编制: 20, 技能矩阵版本: 'SKILL-202607', 负责人: '门店经理' }),
  fact('schedule_timekeeping', /(?:排班|班表|工时|打卡|考勤|加班|休息|休假|缺勤|借调|换班|连续工作|班次|补位)/u, { 排班版本: 'ROSTER-202607', 工时小时: 168, 打卡批次: 'ATT-202607', 加班小时: 8, 缺勤小时: 0, 班次: '早/中/晚' }),
  fact('training_qualification', /(?:培训|带教|考核|资格|资质|复训|培训机构|有效期|能力缺口|授权边界|语言|无障碍需求)/u, { 培训课程: '食品安全基础', 培训机构: '企业内训验收数据', 考核分: 90, 资格有效期: '2027-07-31', 复训触发: '事故/审计不合格' }),
  fact('service_sop', /(?:服务模式|服务标准|服务水平|服务区域|服务费|SOP|开店|闭店|交接|订座|等位|传菜|出餐|售罄机制|支付流程|退款政策|等待)/iu, { 服务SOP版本: 'SERVICE-202607', 服务模式: '桌边+自取', 开闭店检查: 'OPEN-CLOSE-QA', 支付流程: 'POS收银', 退款政策: '负责人审批后原路退回' }),
  fact('booking_table', /(?:订座|预订|等位|候位|桌台|座位|到店|用餐时长|迟到|取消|爽约|离队|步入客|翻台)/u, { 订座数: 180, 候位数: 60, 桌台数: 16, 座位数: 64, 到店率: '85%', 用餐时长分钟: 65, 取消率: '8%' }),
  fact('customer_feedback', /(?:客诉|投诉|评价|口碑|顾客反馈|感官反馈|顾客原始陈述|服务补救|重做|赠送|赔付|退菜|错漏|工单|联系偏好)/u, { 投诉数: 12, 评价样本: 120, 顾客原始陈述批次: 'VOC-202607', 服务补救: '重做/退款需审批', 工单批次: 'CS-202607' }),
  fact('crm_privacy', /(?:CRM|CDP|会员|积分|权益|生命周期|同意记录|合法用途|退订|拒绝列表|保存期限|触达|隐私|顾客权利|去标识化|静默期)/iu, { CRM版本: 'CRM-202607', 会员样本: 500, 同意记录批次: 'CONSENT-202607', 合法用途: '订单履约与经同意营销', 退订渠道: '短信回复TD', 保存期限月: 12 }),
  fact('systems_data', /(?:数据|POS|KDS|ERP|CRM|CDP|系统|平台|日志|字段|版本|导出|数据获取|记录能力|纸质记录|主数据|单位换算|时钟同步|数据下载)/iu, { 数据源: 'POS/KDS/ERP', 系统版本: 'QA-202607', 字段字典: 'DICT-QA-01', 导出批次: 'DATA-202607', 日志时间: '2026-07-31T18:00:00+08:00' }),
  fact('metrics_baseline', /(?:指标定义|KPI|历史基线|历史可比|真实基线|预算|已批准目标|管理层目标|业务目标|经营目标|阶段目标|改进目标|减量目标|服务目标|数据缺口|仪表盘|预测偏差|历史表现)/iu, { 指标定义: '营业额/订单/成本率', 历史基线: '2026-06', 预算元: 100000, 已批准目标: '食材成本率32%', 仪表盘版本: 'KPI-202607' }),
  fact('approval_authority', /(?:负责人|审批人|审批权限|授权|授权层级|升级|联系人|停止条件|回滚权限|决策门|决策者|联系树|隔离权限|停业权限|不可妥协)/u, { 负责人: '门店经理', 审批人: '老板', 审批权限: '方案草案/无外部执行', 升级条件: '食安/财务/法律高风险', 停止条件: '关键证据缺失' }),
  fact('risk_incident', /(?:风险|事故|异常|紧急|应急|故障|攻击|演练|恢复时间|业务连续|备用|不可比事件|未关闭问题|业务影响|RTO|RPO|延期)/iu, { 风险批次: 'RISK-202607', 事故数: 1, 应急预案: 'BCP-QA-01', 恢复时间小时: 4, RTO小时: 4, RPO小时: 1, 未关闭问题: 0 }),
  fact('sustainability', /(?:能源|用水|电费|燃气|蒸汽|燃料|水费|节能|排放|废弃物|回收|堆肥|捐赠|动物饲料|食物浪费|包装品项)/u, { 能源千瓦时: 12000, 用水吨: 320, 食物浪费公斤: 180, 废弃物去向: '授权清运', 回收公斤: 40, 捐赠状态: '未审批不执行' }),
  fact('deadline_constraint', /(?:决策期限|上线期限|启用时间|目标开业日|素材交付周期|发布频率|资源|约束|限制|不可妥协|审批权限|截止时间)/u, { 决策期限: '2026-08-07T18:00:00', 资源约束: '预算/人员/产能', 不可妥协项: '食安/法律/真实证据', 审批权限: '老板终审' }),
  fact('incident_action_confidentiality', /(?:真实事件记录|已采取措施|不得公开的信息)/u, { 事件编号: 'INC-QA-01', 事件原文: '验收事件记录', 已采取措施: '隔离并上报负责人', 公开限制: '仅授权审阅人可见', 保密级别: '内部' }),
  fact('replication_governance', /(?:管理层要解决的问题|可复制边界|试点权限)/u, { 管理层问题: '跨店SOP一致性', 可复制边界: '同店型同菜单', 试点范围: '3家验收门店', 试点权限: '老板批准后执行' }),
]);

export function restaurantInputFactSpecs(input) {
  const text = String(input || '').trim();
  return RESTAURANT_INPUT_FACT_SPECS.filter(spec => spec.trigger.test(text));
}

export function buildRestaurantInputFacts({ input, idx, inputIndex, recordId }) {
  const specs = restaurantInputFactSpecs(input);
  const facts = Object.fromEntries(specs.map(spec => [spec.id,
    spec.build({ input: String(input || ''), idx: Number(idx), inputIndex: Number(inputIndex), recordId }),
  ]));
  const regulationRequired = specs.some(spec => spec.id === 'regulation');
  const regulationComplete = !regulationRequired
    || RESTAURANT_INPUT_FACT_SPECS.find(spec => spec.id === 'regulation').required
      .every(field => facts.regulation?.[field] != null && String(facts.regulation[field]).trim());
  const qaCapabilityRunnable = !regulationRequired
    || (regulationComplete && facts.regulation?.QA能力验收资格 === 'RUNNABLE');
  const operationalReady = !regulationRequired || facts.regulation?.业务执行资格 === 'READY';
  return {
    dimensionIds: specs.map(spec => spec.id),
    facts,
    regulationRequired,
    regulationComplete,
    qaCapabilityRunnable,
    operationalReady,
    regulationBlockers: regulationRequired && Array.isArray(facts.regulation?.阻塞原因)
      ? [...facts.regulation.阻塞原因]
      : [],
  };
}

export function validateRestaurantInputFacts({ input, facts, recordId }) {
  const errors = [];
  const operationalErrors = [];
  const specs = restaurantInputFactSpecs(input);
  for (const spec of specs) {
    const actual = facts?.[spec.id];
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      errors.push(`缺少事实维度${spec.id}`);
      continue;
    }
    for (const field of spec.required) {
      const value = actual[field];
      if (value == null || (typeof value === 'string' && !value.trim())) errors.push(`缺少${spec.id}.${field}`);
    }
  }
  const regulation = specs.find(spec => spec.id === 'regulation');
  if (regulation && !regulation.required.every(field => facts?.regulation?.[field] != null
    && String(facts.regulation[field]).trim())) {
    errors.push('CURRENT_REGULATION_EVIDENCE_BLOCKED');
  }
  if (regulation && facts?.regulation?.QA能力验收资格 !== 'RUNNABLE') {
    errors.push('CURRENT_REGULATION_QA_CAPABILITY_BLOCKED');
  }
  if (regulation && facts?.regulation?.业务执行资格 !== 'READY') {
    const blockers = Array.isArray(facts?.regulation?.阻塞原因) ? facts.regulation.阻塞原因 : [];
    operationalErrors.push(`CURRENT_REGULATION_SCOPE_BLOCKED${blockers.length ? `：${blockers.join('|')}` : ''}`);
  }
  return {
    valid: errors.length === 0,
    errors,
    qaCapabilityRunnable: errors.length === 0,
    operationalReady: errors.length === 0 && operationalErrors.length === 0,
    operationalErrors,
    expectedDimensionIds: specs.map(spec => spec.id),
  };
}

function provided(value) {
  return value !== null
    && value !== undefined
    && !(typeof value === 'string' && !value.trim());
}

function factRecords(materialEvidence, dimensionId) {
  return (Array.isArray(materialEvidence) ? materialEvidence : [])
    .map(evidence => evidence?.fields?.facts?.[dimensionId] ?? evidence?.facts?.[dimensionId])
    .filter(value => value && typeof value === 'object' && !Array.isArray(value));
}

function recordHas(record, requiredFields) {
  return requiredFields.every(field => {
    const alternatives = Array.isArray(field) ? field : [field];
    return alternatives.some(name => provided(record?.[name]));
  });
}

function hasFactFields(materialEvidence, dimensionId, requiredFields) {
  return factRecords(materialEvidence, dimensionId)
    .some(record => recordHas(record, requiredFields));
}

function detailRows(materialEvidence, dimensionIds, arrayFields) {
  const rows = [];
  for (const dimensionId of dimensionIds) {
    for (const record of factRecords(materialEvidence, dimensionId)) {
      for (const field of arrayFields) {
        if (Array.isArray(record[field])) rows.push(...record[field]);
      }
    }
  }
  return rows.filter(value => value && typeof value === 'object' && !Array.isArray(value));
}

function hasDetailRows(materialEvidence, {
  dimensionIds,
  arrayFields,
  minimum = 1,
  requiredFields = [],
}) {
  return detailRows(materialEvidence, dimensionIds, arrayFields)
    .filter(row => recordHas(row, requiredFields)).length >= minimum;
}

function distinctFactCount(materialEvidence, {
  dimensionId,
  identityFields,
  arrayFields = [],
}) {
  const identities = [];
  for (const record of factRecords(materialEvidence, dimensionId)) {
    const identity = identityFields.map(field => record[field]);
    if (identity.some(provided)) identities.push(identity);
  }
  for (const row of detailRows(materialEvidence, [dimensionId], arrayFields)) {
    const identity = identityFields.map(field => row[field]);
    if (identity.some(provided)) identities.push(identity);
  }
  return new Set(identities.map(identity => JSON.stringify(identity))).size;
}

const taskRule = (code, reason, ready) => Object.freeze({ code, reason, ready });

/**
 * 真实 API 矩阵的固定 QA 数据不仅要“命中一个事实维度”，还必须足以完成
 * 当前岗位的首要任务。这里仅检查确定性的任务基数和关键业务字段，不判断
 * 模型文风，也不影响隔离 QA 调用资格。
 */
const RESTAURANT_TASK_COMPLETENESS_RULES = new Map([
  [101, taskRule(
    'TASK_COMPLETENESS_101_TWO_CATCHMENTS_REQUIRED',
    '任务要求比较两个候选商圈，但材料只有1个可区分的地址/商圈，无法形成二选一结论。',
    evidence => distinctFactCount(evidence, {
      dimensionId: 'address',
      identityFields: ['地址', '坐标', '商圈'],
      arrayFields: ['候选商圈明细', '商圈明细'],
    }) >= 2,
  )],
  [102, taskRule(
    'TASK_COMPLETENESS_102_COMPETITOR_AND_CUSTOMER_DETAIL_REQUIRED',
    '任务要求绘制竞品空白并形成可核验客群画像，但材料只有竞品总数/样本编号，缺少竞品坐标属性明细和目标客群事实。',
    evidence => hasFactFields(evidence, 'customer_segment', ['客群', '用餐场景'])
      && hasDetailRows(evidence, {
        dimensionIds: ['market_competition'],
        arrayFields: ['竞品明细', '替代品明细', '门店明细'],
        minimum: 2,
        requiredFields: [['名称', '竞品名称'], ['地址', '坐标', '商圈'], ['价格带', '客单价元']],
      }),
  )],
  [103, taskRule(
    'TASK_COMPLETENESS_103_CUSTOMER_VALIDATION_EVIDENCE_REQUIRED',
    '任务要求验证品牌概念与目标顾客是否匹配，但材料缺少目标客群记录以及顾客访谈/试卖反馈原始证据。',
    evidence => hasFactFields(evidence, 'customer_segment', ['客群', '用餐场景'])
      && (hasFactFields(evidence, 'customer_feedback', ['顾客原始陈述批次', ['访谈样本', '试卖反馈批次']])
        || hasDetailRows(evidence, {
          dimensionIds: ['customer_feedback', 'market_competition'],
          arrayFields: ['顾客访谈明细', '试卖反馈明细'],
          minimum: 1,
          requiredFields: [['顾客原话', '反馈'], ['日期', '发生时间']],
        })),
  )],
  [104, taskRule(
    'TASK_COMPLETENESS_104_THREE_SITES_AND_FULL_LEASE_TERMS_REQUIRED',
    '任务要求给三个候选铺位评分，但材料只有1个可区分铺位，且缺管理费、抽成、免租、递增、租期和退出条款。',
    evidence => distinctFactCount(evidence, {
      dimensionId: 'property_lease',
      identityFields: ['地址', '租约版本', '面积平方米', '租金月元'],
      arrayFields: ['候选铺位明细', '租约明细'],
    }) >= 3 && hasFactFields(evidence, 'property_lease', [
      '管理费月元', '抽成比例', '免租天数', '递增规则', '租期月', '退出条款',
    ]),
  )],
  [105, taskRule(
    'TASK_COMPLETENESS_105_PEAK_LAYOUT_AND_SKILL_DETAIL_REQUIRED',
    '任务要求设计新店服务流程与前后厅协同，但材料缺少峰值订单率、厨房/动线平面资料和岗位技能明细。',
    evidence => hasFactFields(evidence, 'orders_demand', [['峰值订单每小时', '峰值订单数']])
      && hasFactFields(evidence, 'property_lease', [['平面资料', '厨房平面', '动线图']])
      && hasFactFields(evidence, 'workforce', [['技能明细', '岗位技能明细']]),
  )],
  [106, taskRule(
    'TASK_COMPLETENESS_106_FULL_COST_AND_FINANCING_INPUT_REQUIRED',
    '任务要求重算单店盈亏平衡与现金需求，但材料缺少包装、支付、能源、其他费用金额、税率和融资条件。',
    evidence => hasFactFields(evidence, 'cost_margin', [
      '包装成本元', '支付费元', '能源成本元', '其他费用元',
    ]) && hasFactFields(evidence, 'tax_accounting', ['税率'])
      && hasFactFields(evidence, 'capital_budget', ['融资条件']),
  )],
  [107, taskRule(
    'TASK_COMPLETENESS_107_LEASE_AND_OPENING_DATES_REQUIRED',
    '任务要求从签约倒排到试营业，但材料缺少租约签署日、交付日和目标开业日，无法形成真实关键路径。',
    evidence => hasFactFields(evidence, 'property_lease', ['租约签署日', '交付日'])
      && hasFactFields(evidence, 'deadline_constraint', ['目标开业日']),
  )],
  [108, taskRule(
    'TASK_COMPLETENESS_108_MENU_ITEM_ROWS_REQUIRED',
    '任务要求精简当前菜单并重做价格/套餐/渠道组合，但材料缺少逐菜销量、净售价、配方成本、制作时间和工位明细。',
    evidence => hasDetailRows(evidence, {
      dimensionIds: ['product_menu'],
      arrayFields: ['菜品明细', '菜单明细'],
      minimum: 4,
      requiredFields: ['菜品', '净销量', '净售价元', '配方成本元', '制作时间分钟', '工位'],
    }),
  )],
  [112, taskRule(
    'TASK_COMPLETENESS_112_MENU_ENGINEERING_ROWS_REQUIRED',
    '任务要求用真实销量和单份贡献生成菜单四象限，但材料没有逐菜净销量、净售价和有效可变成本明细。',
    evidence => hasDetailRows(evidence, {
      dimensionIds: ['product_menu', 'cost_margin'],
      arrayFields: ['菜品明细', '菜单工程明细'],
      minimum: 4,
      requiredFields: ['菜品', '净销量', '净售价元', ['单份贡献元', '可变成本元']],
    }),
  )],
  [113, taskRule(
    'TASK_COMPLETENESS_113_THREE_PROTOTYPES_REQUIRED',
    '任务要求评审三款新品试制结果，但材料没有3款可区分原型及其试制/感官反馈记录。',
    evidence => hasDetailRows(evidence, {
      dimensionIds: ['product_menu', 'customer_feedback'],
      arrayFields: ['新品试制明细', '原型明细', '感官评审明细'],
      minimum: 3,
      requiredFields: [['原型', '菜品'], ['试制批次', '版本'], ['感官结果', '反馈']],
    }),
  )],
  [125, taskRule(
    'TASK_COMPLETENESS_125_ALTERNATE_SUPPLIERS_REQUIRED',
    '任务要求寻找并评审备选供应商，但材料只有1个可区分供应商主体，无法形成长短名单和风险比较。',
    evidence => distinctFactCount(evidence, {
      dimensionId: 'supplier',
      identityFields: ['供应商主体', '生产地点'],
      arrayFields: ['候选供应商明细', '供应商明细'],
    }) >= 2,
  )],
  [126, taskRule(
    'TASK_COMPLETENESS_126_THREE_QUOTES_REQUIRED',
    '任务要求对三家供应商同口径评标，但材料只有1份可区分采购报价，无法完成三方排名。',
    evidence => distinctFactCount(evidence, {
      dimensionId: 'procurement',
      identityFields: ['供应商主体', '采购单', '报价元公斤'],
      arrayFields: ['供应商报价明细', '报价明细'],
    }) >= 3,
  )],
  [127, taskRule(
    'TASK_COMPLETENESS_127_SKU_REPLENISHMENT_ROWS_REQUIRED',
    '任务要求生成下周期补货建议，但材料缺少逐SKU净销量、可用库存、在途、配方耗用、交期和包装倍数的同口径明细。',
    evidence => hasDetailRows(evidence, {
      dimensionIds: ['inventory_batch', 'orders_demand'],
      arrayFields: ['SKU补货明细', '库存需求明细'],
      minimum: 1,
      requiredFields: ['SKU', '净销量', '可用库存', '在途数量', '单位耗用', '交期天', '包装倍数'],
    }),
  )],
  [129, taskRule(
    'TASK_COMPLETENESS_129_INVENTORY_BRIDGE_INPUT_REQUIRED',
    '任务要求桥接实物、账面与理论库存，但材料缺少期初/期末实盘及采购、调拨、领用、销售、报损流水。',
    evidence => hasFactFields(evidence, 'inventory_batch', [
      '期初实盘', '期末实盘', '采购数量', '调入数量', '调出数量', '领用数量', '理论耗用', '报损数量',
    ]),
  )],
  [130, taskRule(
    'TASK_COMPLETENESS_130_HOURLY_DEMAND_ROWS_REQUIRED',
    '任务要求按小时需求和工位产能生成明日计划，但材料只有月度总量，缺少分小时/分菜品需求与在制批次明细。',
    evidence => hasDetailRows(evidence, {
      dimensionIds: ['orders_demand', 'process_capacity'],
      arrayFields: ['小时需求明细', '分时需求明细'],
      minimum: 2,
      requiredFields: ['时段', ['菜品', 'SKU'], ['需求份数', '订单数'], ['工位', '产能份每小时']],
    }),
  )],
  [131, taskRule(
    'TASK_COMPLETENESS_131_CENTRAL_KITCHEN_ROUTE_REQUIRED',
    '任务要求设计中央厨房到门店的冷链配送，但材料缺少中央厨房主体、接收门店清单、路线里程/停靠与备用路线。',
    evidence => hasFactFields(evidence, 'business_scope', ['中央厨房编号'])
      && hasDetailRows(evidence, {
        dimensionIds: ['logistics'],
        arrayFields: ['配送路线明细', '门店停靠明细'],
        minimum: 1,
        requiredFields: ['接收门店', '路线里程公里', '停靠顺序', '备用路线'],
      }),
  )],
  [134, taskRule(
    'TASK_COMPLETENESS_134_ORDER_EVENT_ROWS_REQUIRED',
    '任务要求解决催菜、错单和同桌不齐，但材料缺少带订单号、菜品、来源、状态时间戳、返工/错漏的逐单事件明细。',
    evidence => hasDetailRows(evidence, {
      dimensionIds: ['orders_demand', 'systems_data'],
      arrayFields: ['订单事件明细', 'KDS事件明细'],
      minimum: 2,
      requiredFields: ['订单号', '菜品', '订单来源', '状态', '状态时间', ['返工', '错漏']],
    }),
  )],
  [136, taskRule(
    'TASK_COMPLETENESS_136_EMPLOYEE_AVAILABILITY_ROWS_REQUIRED',
    '任务要求生成未来两周可审核班表，但材料缺少员工级可用时间、合同工时、休假、资格/技能及分时需求明细。',
    evidence => hasDetailRows(evidence, {
      dimensionIds: ['workforce', 'schedule_timekeeping'],
      arrayFields: ['员工可用性明细', '员工排班明细'],
      minimum: 2,
      requiredFields: ['员工编号', '可用时间', '合同工时', '休假状态', ['资格', '技能']],
    }) && hasDetailRows(evidence, {
      dimensionIds: ['orders_demand'],
      arrayFields: ['小时需求明细', '分时需求明细'],
      minimum: 2,
      requiredFields: ['时段', ['需求人数', '订单数']],
    }),
  )],
  [143, taskRule(
    'TASK_COMPLETENESS_143_REVIEW_TEXT_ROWS_REQUIRED',
    '任务要求分析近30天差评并逐条起草回复，但材料只有评价样本总量，缺少评价原文、星级、时间、平台和订单事实明细。',
    evidence => hasDetailRows(evidence, {
      dimensionIds: ['customer_feedback'],
      arrayFields: ['评价明细', '差评明细'],
      minimum: 1,
      requiredFields: ['评价原文', '星级', '时间', '平台', ['订单号', '订单事实']],
    }),
  )],
  [146, taskRule(
    'TASK_COMPLETENESS_146_CHANNEL_LEDGER_REQUIRED',
    '任务要求比较外卖与团餐渠道经济性，但材料缺少分渠道订单/退款/履约、合同费率、保持测试和团餐需求明细。',
    evidence => hasDetailRows(evidence, {
      dimensionIds: ['orders_demand', 'cash_payment'],
      arrayFields: ['渠道经营明细', '渠道结算明细'],
      minimum: 2,
      requiredFields: ['渠道', '订单数', '退款数', '履约时长分钟', '合同费率'],
    }) && hasFactFields(evidence, 'packaging_storage', [['保持测试批次', '保持测试结果']]),
  )],
  [147, taskRule(
    'TASK_COMPLETENESS_147_TRANSACTION_RECONCILIATION_ROWS_REQUIRED',
    '任务要求找出昨日全部关账差异，但材料缺少POS、现金、各支付渠道和平台结算的逐笔交易/撤销/退款流水。',
    evidence => hasDetailRows(evidence, {
      dimensionIds: ['cash_payment', 'systems_data'],
      arrayFields: ['交易明细', '支付流水明细', '平台结算明细'],
      minimum: 2,
      requiredFields: ['交易号', '渠道', '应收元', '实收元', '状态', '发生时间'],
    }),
  )],
  [148, taskRule(
    'TASK_COMPLETENESS_148_THEORETICAL_ACTUAL_ROWS_REQUIRED',
    '任务要求桥接理论与实际食材成本，但材料缺少逐菜销量×配方理论耗用和期初+采购-期末的实际耗用明细。',
    evidence => hasDetailRows(evidence, {
      dimensionIds: ['recipe_ingredient', 'inventory_batch'],
      arrayFields: ['理论实际耗用明细', '菜品耗用明细'],
      minimum: 1,
      requiredFields: ['原料', '菜品净销量', '标准耗用', '期初库存', '采购数量', '期末库存'],
    }),
  )],
  [150, taskRule(
    'TASK_COMPLETENESS_150_COMPLETE_PNL_LEDGER_REQUIRED',
    '任务要求桥接Prime Cost与单店损益，但材料缺少包装、渠道费、工资附加、占用、能源、维修、折旧、中央分摊和一次性事项金额。',
    evidence => hasFactFields(evidence, 'cost_margin', [
      '包装成本元', '渠道可变费元', '工资附加元', '占用成本元', '能源成本元',
      '维修费元', '折旧元', '中央分摊元', '一次性事项元',
    ]),
  )],
  [151, taskRule(
    'TASK_COMPLETENESS_151_THIRTEEN_WEEK_CASH_ROWS_REQUIRED',
    '任务要求建立13周滚动现金流，但材料缺少至少13周的分周销售流入、应付、工资、税费、租金、债务和资本支出计划。',
    evidence => hasDetailRows(evidence, {
      dimensionIds: ['cash_payment', 'revenue_finance'],
      arrayFields: ['周现金流明细', '十三周现金计划'],
      minimum: 13,
      requiredFields: ['周次', '销售流入元', '应付元', '工资元', '税费元', '租金元', '债务元', '资本支出元'],
    }),
  )],
  [152, taskRule(
    'TASK_COMPLETENESS_152_PRICE_VOLUME_HISTORY_REQUIRED',
    '任务要求评估调价弹性并比较情景，但材料缺少至少两个历史价格点对应的销量、促销/缺货和外部事件记录。',
    evidence => hasDetailRows(evidence, {
      dimensionIds: ['price_volume', 'orders_demand'],
      arrayFields: ['历史价格销量明细', '价格实验明细'],
      minimum: 2,
      requiredFields: ['价格元', '销量', '期间', ['促销标记', '缺货标记'], '外部事件'],
    }),
  )],
  [153, taskRule(
    'TASK_COMPLETENESS_153_MULTIDIMENSIONAL_ORDER_ROWS_REQUIRED',
    '任务要求按渠道、餐段、菜品和顾客群拆解盈利与复购，但材料缺少同时带四个维度、收入和可变成本的去标识订单明细。',
    evidence => hasDetailRows(evidence, {
      dimensionIds: ['orders_demand', 'systems_data'],
      arrayFields: ['去标识订单明细', '多维经营明细'],
      minimum: 2,
      requiredFields: ['渠道', '餐段', '菜品', '顾客群键', '净收入元', '可变成本元'],
    }),
  )],
  [155, taskRule(
    'TASK_COMPLETENESS_155_FIVE_STORES_REQUIRED',
    '任务要求对标五家门店，但材料只有1个可区分门店，无法进行标准化多店比较。',
    evidence => distinctFactCount(evidence, {
      dimensionId: 'business_scope',
      identityFields: ['门店编号', '业务范围', '业态'],
      arrayFields: ['门店清单', '门店明细'],
    }) >= 5,
  )],
  [156, taskRule(
    'TASK_COMPLETENESS_156_OPENING_DATE_AND_READINESS_REQUIRED',
    '任务要求制定开业前到稳定期的爬坡手册，但材料缺少计划开业日及许可、施工、设备、人员、供应、系统的逐项真实状态。',
    evidence => hasFactFields(evidence, 'deadline_constraint', ['目标开业日'])
      && hasDetailRows(evidence, {
        dimensionIds: ['quality_audit', 'systems_data'],
        arrayFields: ['开业就绪明细', '就绪状态明细'],
        minimum: 6,
        requiredFields: ['模块', '状态', '证据编号', '负责人'],
      }),
  )],
  [158, taskRule(
    'TASK_COMPLETENESS_158_UTILITY_RATE_AND_METER_ROWS_REQUIRED',
    '任务要求评估能源、用水和包装效率投资，但材料缺少账单费率/金额、分表或设备负荷测量及包装品项用量成本明细。',
    evidence => hasDetailRows(evidence, {
      dimensionIds: ['sustainability', 'equipment'],
      arrayFields: ['能源账单明细', '设备负荷明细'],
      minimum: 1,
      requiredFields: [['能源类型', '设备'], ['用量', '负荷千瓦'], ['费率元', '金额元'], '期间'],
    }) && hasDetailRows(evidence, {
      dimensionIds: ['packaging_storage', 'sustainability'],
      arrayFields: ['包装品项明细'],
      minimum: 1,
      requiredFields: ['包装品项', '用量', '单位成本元', '回收去向'],
    }),
  )],
]);

export function assessRestaurantTaskCompleteness({ idx, materialEvidence } = {}) {
  const rule = RESTAURANT_TASK_COMPLETENESS_RULES.get(Number(idx));
  if (!rule || rule.ready(materialEvidence)) {
    return {
      operationalReady: true,
      operationalErrors: [],
      operationalBlockReasons: [],
    };
  }
  const reason = `${rule.code}：${rule.reason}`;
  return {
    operationalReady: false,
    operationalErrors: [reason],
    operationalBlockReasons: [reason],
  };
}

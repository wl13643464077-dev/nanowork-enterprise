import crypto from 'node:crypto';
import fs from 'node:fs';
import { curTenant, q } from './db.js';
import { loadRestaurantCatalog, RESTAURANT_CATALOG_PATH } from './catalog/restaurant.js';
import {
  EMPLOYEE_SKILL_EFFECT_VALIDATION,
  EMPLOYEE_SKILL_EVIDENCE_CATALOG,
  EMPLOYEE_SKILL_EVIDENCE_CATALOG_PATH,
  EMPLOYEE_SKILL_VERIFICATION_LEVEL,
  verifiedEmployeeSkillsFor,
} from './catalog/employee-skills-verification.js';
import { getRestaurantOutputContract } from './engines/restaurant-output-contract.js';

export const EMPLOYEE_SKILLS_PATH = EMPLOYEE_SKILL_EVIDENCE_CATALOG_PATH;
export const EMPLOYEE_TASK_TYPES = Object.freeze([
  '经营诊断', '执行方案', '检查清单', '数据分析', '活动策划', 'SOP',
  '话术', '方案', '清单', '排期', '分析', '常规',
]);
export const REQUIRED_WORKBENCH_KEYS = Object.freeze([
  'identity', 'capabilities', 'workMethod', 'skillLibrary', 'prompts',
  'workConfig', 'jobProfile', 'runtime', 'dispatch', 'permissions', 'provenance',
]);

const RESTAURANT_CATALOG = loadRestaurantCatalog();
const MANAGER_ROLES = new Set(['boss', 'admin', 'platform_super']);
const ALLOWED_CONFIG_KEYS = new Set([
  'textModel', 'visionModel', 'webMode', 'knowledgeScopes', 'outputLength',
  'timeoutSeconds', 'approvalMode', 'maxCost', 'language',
]);
const WEB_MODES = new Set(['required', 'allowed', 'off']);
const OUTPUT_LENGTHS = new Set(['standard', 'full']);
const APPROVAL_MODES = new Set(['owner_review', 'manager_review', 'auto_draft']);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function strictJson(value, fallback, label) {
  if (value == null || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    if (parsed == null) throw new Error('值为空');
    return parsed;
  } catch (error) {
    throw new Error(`${label}损坏，拒绝静默降级：${error.message}`);
  }
}

function cleanText(value, max, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${label}必须是文本`);
  const text = value.trim();
  if (!allowEmpty && !text) throw new Error(`${label}不能为空`);
  if (text.length > max) throw new Error(`${label}不能超过${max}字`);
  return text;
}

function capabilityName(step, index) {
  const clean = String(step || '')
    .replace(/^\*\*(.+?)\*\*[:：]?\s*/u, '$1')
    .replace(/^(.{2,18}?)[：:]\s*.+$/u, '$1')
    .trim();
  return clean.length <= 22 ? clean : `第${index + 1}项岗位能力`;
}

function groupRecord(employee) {
  const groupIndex = RESTAURANT_CATALOG.groups.findIndex(group => group.name === employee.group);
  if (groupIndex < 0) throw new Error(`员工${employee.idx}分部不存在，拒绝静默降级`);
  return {
    index: groupIndex,
    code: `M-${String(groupIndex + 1).padStart(2, '0')}`,
    ...RESTAURANT_CATALOG.groups[groupIndex],
  };
}

function catalogEmployee(idx) {
  const employeeIdx = Number(idx);
  if (!Number.isInteger(employeeIdx) || employeeIdx < 101 || employeeIdx > 160) {
    throw Object.assign(new Error('餐饮数字员工编号必须在101-160'), { status: 404 });
  }
  const employee = RESTAURANT_CATALOG.employees.find(item => item.idx === employeeIdx);
  if (!employee) throw Object.assign(new Error('餐饮数字员工不存在'), { status: 404 });
  return employee;
}

function dbIdentity(employee) {
  const row = q.get(`SELECT s.id specialist_id,s.marshal_id,m.id department_id,m.code department_code,
    m.name department_name,m.emoji department_emoji,m.online department_online
    FROM specialists s JOIN marshals m ON m.id=s.marshal_id
    WHERE s.employee_idx=? AND m.code IN ('M-01','M-02','M-03','M-04','M-05','M-06','M-07','M-08')`, employee.idx);
  if (!row) throw new Error(`员工${employee.idx}未同步到运行目录，拒绝静默降级`);
  const expected = groupRecord(employee);
  if (row.department_code !== expected.code) {
    throw new Error(`员工${employee.idx}运行分部与权威目录不一致，拒绝静默降级`);
  }
  return row;
}

function configRow(idx, tenantId = curTenant()) {
  return q.get(`SELECT * FROM employee_workbench_configs WHERE tenant_id=? AND employee_idx=?`, tenantId, idx) || null;
}

function normalizeCatalogSkill(raw, employeeIdx, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`员工${employeeIdx}的可选技能目录第${index + 1}项不是对象`);
  }
  const title = cleanText(raw.title || raw.name || '', 80, `员工${employeeIdx}可选技能名称`);
  const detail = cleanText(raw.detail || raw.description || raw.instructions || '', 4000, `员工${employeeIdx}可选技能说明`);
  const source = cleanText(raw.source || raw.sourceName || 'employee-skills.json', 300, `员工${employeeIdx}可选技能来源`);
  const legacy = raw.verificationStatus === 'legacy_unverified' || raw.sourceSnapshot?.kind === 'legacy_database_allowlist_export';
  const generatedKey = sha256(`${raw.title || raw.name}|${raw.source || raw.sourceName || ''}`).slice(0, 16);
  const key = String(raw.id || raw.key || generatedKey).replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 120);
  const learnedAt = Number.isFinite(Number(raw.learnedAt))
    ? new Date(Number(raw.learnedAt) * 1000).toISOString()
    : typeof raw.learnedAt === 'string' ? raw.learnedAt : null;
  return {
    id: key.includes(':') ? key : `${legacy ? 'legacy' : 'catalog'}:${employeeIdx}:${key}`,
    title,
    detail,
    source,
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : null,
    version: String(raw.version || '1'),
    origin: legacy ? 'legacy_learned' : 'catalog_optional',
    required: false,
    enabled: raw.enabled !== false,
    learnedAt,
    verificationStatus: raw.verificationLevel || raw.verificationStatus || (legacy ? 'legacy_unverified' : 'catalog'),
    legacyVerificationStatus: legacy ? raw.verificationStatus : null,
    verificationLevel: raw.verificationLevel || null,
    effectValidation: raw.effectValidation || null,
    contentFingerprint: raw.contentFingerprint || null,
    offlineAcceptanceFixture: raw.offlineAcceptanceFixture || null,
    sourceSnapshot: raw.sourceSnapshot || null,
    locked: false,
    defaultInjected: true,
    currentPlatformFact: !legacy,
  };
}

function optionalCatalogSkills(employeeIdx) {
  if (!fs.existsSync(EMPLOYEE_SKILLS_PATH)) {
    return { status: 'missing', hash: null, skills: [] };
  }
  let source;
  try {
    source = fs.readFileSync(EMPLOYEE_SKILLS_PATH, 'utf8');
  } catch (error) {
    throw new Error(`员工技能目录读取失败，拒绝静默降级：${error.message}`);
  }
  const root = EMPLOYEE_SKILL_EVIDENCE_CATALOG;
  const skills = verifiedEmployeeSkillsFor(root, employeeIdx)
    .map((skill, index) => normalizeCatalogSkill(skill, employeeIdx, index));
  if (new Set(skills.map(skill => skill.id)).size !== skills.length) {
    throw new Error(`员工${employeeIdx}的可选技能ID重复，拒绝静默降级`);
  }
  const profile = Array.isArray(root?.profiles)
    ? root.profiles.find(item => Number(item?.employeeIdx ?? item?.employee_idx ?? item?.idx) === employeeIdx)
    : null;
  if (profile) {
    const employee = catalogEmployee(employeeIdx);
    if (profile.key && profile.key !== employee.key) {
      throw new Error(`员工${employeeIdx}技能目录key与岗位目录不一致，拒绝静默降级`);
    }
    if (profile.expectedSkillCount != null && Number(profile.expectedSkillCount) !== skills.length) {
      throw new Error(`员工${employeeIdx}技能目录期望${profile.expectedSkillCount}项、实际${skills.length}项，拒绝静默降级`);
    }
  }
  return {
    status: 'loaded',
    hash: sha256(source),
    skills,
    safeLegacyConfig: profile?.safeLegacyConfig && typeof profile.safeLegacyConfig === 'object'
      ? profile.safeLegacyConfig
      : null,
  };
}

function requiredSkill(employee) {
  return {
    id: `required:${employee.key}`,
    title: `${employee.name}完整岗位 Skill`,
    detail: employee.desc,
    instructions: employee.md,
    source: 'restaurant.json · 完整岗位手册',
    sourceUrl: null,
    version: '1',
    origin: 'catalog_required',
    required: true,
    enabled: true,
    locked: true,
    defaultInjected: true,
    currentPlatformFact: true,
    verificationStatus: 'factory_required',
  };
}

function learnedSkill(raw, employeeIdx, existing = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('进修技能必须是对象');
  const id = String(raw.id || '').trim();
  if (!/^learned:[a-zA-Z0-9._:-]{1,100}$/u.test(id)) {
    throw new Error(`员工${employeeIdx}的进修技能ID必须以 learned: 开头`);
  }
  return {
    id,
    title: cleanText(raw.title || '', 80, '进修技能名称'),
    detail: cleanText(raw.detail || raw.description || '', 4000, '进修技能说明'),
    source: cleanText(raw.source || '', 300, '进修技能来源'),
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl.slice(0, 1000) : null,
    version: String(raw.version || existing?.version || '1').slice(0, 40),
    origin: 'learned',
    required: false,
    enabled: raw.enabled !== false,
    locked: false,
    defaultInjected: true,
    currentPlatformFact: false,
    verificationStatus: 'tenant_supplied',
    learnedAt: existing?.learnedAt || new Date().toISOString(),
  };
}

function skillLibrary(employee, row) {
  const required = requiredSkill(employee);
  const catalog = optionalCatalogSkills(employee.idx);
  const saved = strictJson(row?.skills_json, [], `员工${employee.idx}技能配置`);
  if (!Array.isArray(saved)) throw new Error(`员工${employee.idx}技能配置必须是数组`);
  const savedById = new Map(saved.map(item => [item?.id, item]));
  const imported = catalog.skills.map(skill => ({
    ...skill,
    enabled: savedById.has(skill.id) ? savedById.get(skill.id)?.enabled !== false : skill.enabled,
  }));
  const optional = imported.filter(skill => skill.origin === 'catalog_optional');
  const legacyLearned = imported.filter(skill => skill.origin === 'legacy_learned');
  const catalogIds = new Set(imported.map(skill => skill.id));
  const learned = [...legacyLearned, ...saved
    .filter(item => item?.origin === 'learned' || String(item?.id || '').startsWith('learned:'))
    .map(item => learnedSkill(item, employee.idx, item))
    .filter(item => !catalogIds.has(item.id))];
  return {
    required: [required],
    optional,
    learned,
    enabled: [required, ...optional, ...learned].filter(skill => skill.enabled),
    catalogStatus: catalog.status,
    catalogHash: catalog.hash,
    safeLegacyConfig: catalog.safeLegacyConfig || null,
  };
}

function defaultWorkConfig(employee, safeLegacyConfig = null) {
  const manualNeedsWeb = employee.web === true || /联网|浏览|当前官方|WebSearch|WebFetch/u.test(employee.md);
  return {
    textModel: safeLegacyConfig?.modelText || null,
    visionModel: safeLegacyConfig?.modelImage || null,
    webMode: manualNeedsWeb ? 'required' : 'allowed',
    knowledgeScopes: ['餐饮产业知识库', '员工产出'],
    outputLength: 'full',
    timeoutSeconds: manualNeedsWeb ? 900 : 300,
    approvalMode: 'owner_review',
    maxCost: null,
    language: 'zh-CN',
    tenantScoped: true,
  };
}

function validateWorkConfig(value, employee, safeLegacyConfig = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工作配置必须是对象');
  for (const key of Object.keys(value)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) throw new Error(`不支持的工作配置项：${key}`);
  }
  const config = { ...defaultWorkConfig(employee, safeLegacyConfig), ...value, tenantScoped: true };
  if (!WEB_MODES.has(config.webMode)) throw new Error('webMode必须是required、allowed或off');
  if (!OUTPUT_LENGTHS.has(config.outputLength)) throw new Error('outputLength必须是standard或full');
  if (!APPROVAL_MODES.has(config.approvalMode)) throw new Error('approvalMode不正确');
  for (const field of ['textModel', 'visionModel']) {
    if (config[field] != null && (typeof config[field] !== 'string' || !config[field].trim() || config[field].length > 160)) {
      throw new Error(`${field}必须是160字以内的模型标识或空`);
    }
  }
  if (typeof config.language !== 'string' || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(config.language)) {
    throw new Error('language必须是zh-CN等合法语言标识');
  }
  if (!Array.isArray(config.knowledgeScopes) || !config.knowledgeScopes.length
    || config.knowledgeScopes.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error('knowledgeScopes必须是非空文本数组');
  }
  config.knowledgeScopes = [...new Set(config.knowledgeScopes.map(item => item.trim()))];
  if (config.knowledgeScopes.length > 20 || config.knowledgeScopes.some(item => item.length > 80)) {
    throw new Error('knowledgeScopes最多20项且每项不超过80字');
  }
  const timeout = Number(config.timeoutSeconds);
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 1800) throw new Error('timeoutSeconds必须在30-1800秒');
  config.timeoutSeconds = timeout;
  if (config.maxCost != null && (!Number.isFinite(Number(config.maxCost)) || Number(config.maxCost) <= 0)) {
    throw new Error('maxCost必须是正数或空');
  }
  if (config.webMode === 'off' && defaultWorkConfig(employee, safeLegacyConfig).webMode === 'required') {
    throw new Error('该岗位手册要求联网核验，不能关闭联网能力');
  }
  return config;
}

function workConfig(employee, row, safeLegacyConfig = null) {
  const saved = strictJson(row?.work_config_json, {}, `员工${employee.idx}工作配置`);
  const values = validateWorkConfig(saved, employee, safeLegacyConfig);
  const { tenantScoped: _tenantScopedValue, ...editableValues } = values;
  const version = `tenant-revision-${Number(row?.revision || 0)}`;
  const fields = [
    { key: 'textModel', label: '文本模型', type: 'text', description: '单独派活的文本生成与预授权计费均使用该模型；留空跟随账号路由。' },
    { key: 'visionModel', label: '视觉理解模型', type: 'text', description: '单独派活附带图片证据时使用；不上传图片时不会调用。' },
    { key: 'webMode', label: '联网方式', type: 'select', options: ['required', 'allowed', 'off'], description: 'required 每次检索；allowed 在任务要求当前/最新/官方信息时检索；失败必须列待核验项。' },
    { key: 'knowledgeScopes', label: '知识范围', type: 'multiselect', description: '决定本次本地知识库检索范围。' },
    { key: 'outputLength', label: '交付篇幅', type: 'select', options: ['standard', 'full'], description: '实际控制生成上限与派活预授权估算。' },
    { key: 'timeoutSeconds', label: '执行超时（秒）', type: 'number', description: '实际控制本次模型调用超时。' },
    { key: 'approvalMode', label: '审批方式', type: 'select', options: ['owner_review', 'manager_review', 'auto_draft'], description: '写入执行约束；所有模式都先形成待审阅稿，不会自动发布。' },
    { key: 'maxCost', label: '单次积分上限', type: 'number', description: '派活前按实际提示词和篇幅估算，超过上限即拒绝，不调用模型。' },
    { key: 'language', label: '输出语言', type: 'text', description: '作为本次岗位交付的强制输出语言。' },
  ];
  return {
    ...values,
    fields,
    values: editableValues,
    version,
    boundary: '配置按企业隔离并进入真实派活：模型、联网、知识范围、篇幅、超时、积分上限和语言均实际生效；视觉模型只在上传图片时调用。岗位要求联网时不可关闭联网；所有产出先待审阅，价格、收益、食安、法律、隐私和外部发布仍须人工终审。',
  };
}

function capabilities(employee) {
  return employee.steps.map((description, index) => ({
    id: `${employee.key}:capability:${String(index + 1).padStart(2, '0')}`,
    name: capabilityName(description, index),
    description,
    order: index + 1,
    required: true,
    enabled: true,
    locked: true,
    source: 'restaurant.json · 岗位工作流',
  }));
}

const RESTAURANT_PRIMARY_TASKS = Object.freeze({
  101: '比较两个候选商圈，判断哪个品类机会更值得用90天验证',
  102: '画清目标门店3公里商圈与竞品空白，给出可核验的客群画像',
  103: '验证新品牌概念是否真正匹配目标顾客与消费场景',
  104: '对三个候选铺位评分，并测算租约压力与保本客流',
  105: '为堂食加外卖的新店设计店型、服务流程与前后厅协同',
  106: '用真实投资和经营假设重算单店盈亏平衡与现金需求',
  107: '从签约到试营业倒排开业计划，并标出证照与验收卡点',
  108: '精简当前菜单并重做品类、价格梯度、套餐和渠道组合',
  109: '把招牌菜整理成可培训、可复算、可追溯的标准菜品卡',
  110: '实测一批原料的净料率、烹饪损失和标准份量偏差',
  111: '按最新配方与采购价重算菜品成本，并给出各渠道售价建议',
  112: '用真实销量和单份贡献做菜单四象限并提出保留、优化、下架动作',
  113: '评审三款新品试制结果，决定继续迭代、上线测试还是停止',
  114: '按有效配方生成每份营养计算台账与目标地区标识草案',
  115: '建立全菜单过敏原矩阵，并补齐点单告知与换料复核流程',
  116: '审计门店基础卫生方案，形成开业前必须关闭的差距清单',
  117: '为一项新工艺完成HACCP危害分析与关键控制计划草案',
  118: '复核冷却、冷藏、复热和配送全链路温控限值与偏差处置',
  119: '为重点设备建立可执行的清洁消毒SSOP和验证记录',
  120: '把员工疾病报告、限制上岗、返岗与污染事件处置做成门店制度',
  121: '排查过敏原订单从备料到出餐的交叉污染路径并制定控制',
  122: '复核高风险食材供应商、票证、冷链收货与拒收隔离要求',
  123: '用一个真实批次演练从原料到门店和顾客的撤回召回',
  124: '把本次食安检查问题做成根因、整改、复核和关闭的完整闭环',
  125: '为关键原料寻找备选供应商并完成准入、试供与风险评审',
  126: '把三家供应商报价换成同规格、同出成、同物流口径后评标',
  127: '结合销量、配方耗用、库存和在途生成下周期补货建议',
  128: '重做收货、隔离、库位和FEFO流程，解决临期与批次断点',
  129: '桥接本月实物、账面和理论库存，定位损耗与异常领用',
  130: '按小时需求和工位产能生成明日备料与分批生产计划',
  131: '设计中央厨房到门店的冷链配送、交接与温度偏差闭环',
  132: '重做早班开店、晚班闭店和跨班交接清单，确保异常可追责',
  133: '把迎宾到送客的前厅服务做成可培训、可检查的SOP',
  134: '解决高峰催菜、错单和同桌不齐，重做后厨叫单与出餐口控制',
  135: '优化周末订座、等位和桌台分配，兼顾体验与座位收益',
  136: '按未来两周分时需求、员工技能和劳动规则生成可审核班表',
  137: '建立岗位技能矩阵、培训计划、实操考核和证书到期提醒',
  138: '复盘一宗重大客诉，完成事实核验、服务补救和根因整改',
  139: '为关键设备建立预防性维护、故障升级和复役验证计划',
  140: '统一品牌语调并改写菜单菜名、卖点和外卖渠道文案',
  141: '制定未来90天本地营销日历，并与预算、产能和经营目标对齐',
  142: '规划下月社媒内容与UGC授权流程，明确每条内容的目标和素材',
  143: '分析近30天差评主题，起草回复并转成门店整改任务',
  144: '重做会员分层、权益、复购和沉睡顾客唤回方案',
  145: '测算一项满减活动的增量贡献、蚕食风险和停止条件',
  146: '评估外卖与团餐渠道的菜单、产能、履约和单笔经济性',
  147: '勾稽昨日POS、现金、支付和平台结算，找出所有关账差异',
  148: '桥接本月理论与实际食材成本，量化价格、份量和损耗影响',
  149: '分析分时人工成本与生产率，找出缺岗、加班和低效时段',
  150: '桥接本月Prime Cost与单店损益，锁定利润下滑的责任项',
  151: '建立未来13周滚动现金流，识别资金缺口和营运资金动作',
  152: '测算成本上涨后的盈亏平衡与调价弹性，比较三种经营情景',
  153: '按渠道、餐段、菜品和顾客群拆解盈利结构与复购机会',
  154: '设计本周经营复盘，把异常指标变成有责任人和截止日的行动',
  155: '对标五家门店的SOP执行证据，提炼可复制实践与整改试点',
  156: '制定新店开业前、软开业和稳定期的分阶段爬坡手册',
  157: '审计采购到顾客剩余的食物浪费，设计三项可测减量试点',
  158: '分析门店能源、用水和包装消耗，评估不影响食安的效率投资',
  159: '为断电、断网、支付中断和冷链故障建立业务连续性方案',
  160: '扫描全国同类活动案例，判断本店是否适合并形成可落地活动方案',
});

function dispatchGuidance(employee) {
  const primary = RESTAURANT_PRIMARY_TASKS[employee.idx];
  if (!primary) throw new Error(`员工${employee.idx}缺少岗位派活引导，拒绝使用通用占位文案`);
  const materials = [...employee.inputs];
  const deliverables = [...employee.deliverables];
  const materialA = materials[0];
  const materialB = materials[1] || materials[0];
  const deliverableA = deliverables[0];
  const deliverableB = deliverables[1] || deliverables[0];
  const deliverableC = deliverables[2] || deliverableB;
  return {
    intro: `${employee.name}只处理与“${employee.duty || employee.name}”直接相关的专项问题。先给真实材料和决策边界，再由该岗位按完整手册交付。`,
    titleLabel: `请${employee.name}解决哪一个具体问题？`,
    titlePlaceholder: `例如：${primary}`,
    requirementLabel: `请提供${employee.name}开工所需的真实材料`,
    requirementPlaceholder: `至少说明：${materials.slice(0, 3).join('；')}。缺失项请明确写“暂无”，并补充时间范围、不能做的事和交付将用于哪项决策。`,
    materialChecklist: materials,
    deliverableChecklist: deliverables,
    taskExamples: [
      primary,
      `复核${materialA}与${materialB}，交付${deliverableA}`,
      `基于真实数据形成${deliverableB}，同时补齐${deliverableC}和待确认项`,
    ],
    imageLabel: `${employee.name}相关的现场或数据截图（可选）`,
    imageHelp: `只有图片能帮助判断时再上传，例如与“${materialA}”有关的照片、表格截图、单据或现场证据；原图不进入任务快照。`,
    evidenceTip: '金额、比例、法规、平台规则、市场变化和外部案例必须注明期间与来源；没有数据时应标假设，不能让数字员工猜成事实。',
  };
}

function profileVersion(employee, outputContract) {
  return `restaurant-v2-${sha256(JSON.stringify({
    idx: employee.idx,
    key: employee.key,
    duty: employee.duty,
    md: employee.md,
    inputs: employee.inputs,
    steps: employee.steps,
    deliverables: employee.deliverables,
    qualityGates: employee.qualityGates,
    safetyBoundaries: employee.safetyBoundaries,
    outputContractId: outputContract.contractId,
    outputSchemaVersion: outputContract.schemaVersion,
  })).slice(0, 16)}`;
}

function runtime(employee, specialistId, tenantId) {
  const lastTask = q.get(`SELECT id,title,type,status,created_at,employee_profile_version,employee_prompt_hash
    FROM agent_tasks WHERE tenant_id=? AND specialist_id=? ORDER BY id DESC LIMIT 1`, tenantId, specialistId) || null;
  const stats = q.get(`SELECT COUNT(*) runs,
    SUM(CASE WHEN status='已完成' THEN 1 ELSE 0 END) completed,
    SUM(CASE WHEN status IN ('生成中','执行中') THEN 1 ELSE 0 END) running
    FROM agent_tasks WHERE tenant_id=? AND specialist_id=?`, tenantId, specialistId) || {};
  return {
    status: Number(stats.running || 0) > 0 ? '执行中' : '空闲',
    runs: Number(stats.runs || 0),
    completedRuns: Number(stats.completed || 0),
    runningTasks: Number(stats.running || 0),
    lastTask,
  };
}

function permissionsFor(user) {
  const authenticated = !!user?.id;
  const manager = MANAGER_ROLES.has(user?.role);
  return {
    canDispatch: authenticated,
    canViewPrompt: manager,
    canEditPrompt: manager,
    canEditConfig: manager,
    canEditSkills: manager,
  };
}

export function buildEmployeeWorkbench(idx, { tenantId = curTenant(), user = null, redactRestricted = false } = {}) {
  const employee = catalogEmployee(idx);
  const group = groupRecord(employee);
  const dbRow = dbIdentity(employee);
  const row = configRow(employee.idx, tenantId);
  const caps = capabilities(employee);
  const skills = skillLibrary(employee, row);
  const config = {
    ...workConfig(employee, row, skills.safeLegacyConfig),
    version: `restaurant-config-r${Number(row?.revision || 0)}`,
    boundary: '工作配置只改变执行参数，不得停用岗位必备能力、岗位手册、质量门或安全边界。',
  };
  const outputContract = getRestaurantOutputContract(employee.idx);
  const version = profileVersion(employee, outputContract);
  const override = row?.prompt_override || '';
  // 覆盖提示词只能追加，不能替换出厂岗位手册和必备能力。
  const effectiveTemplate = [
    employee.md,
    override ? `\n\n【本企业补充提示词】\n${override}` : '',
  ].join('');
  const promptHash = sha256(effectiveTemplate);
  const live = runtime(employee, dbRow.specialist_id, tenantId);
  const manualHash = sha256(employee.md);

  const permissions = permissionsFor(user);
  const promptRestricted = redactRestricted && !permissions.canViewPrompt;
  const promptView = promptRestricted
    ? {
        defaultTemplate: null,
        override: null,
        overrideTemplate: null,
        effectiveTemplate: null,
        hash: promptHash,
        effectiveHash: promptHash,
        revision: Number(row?.revision || 0),
        overrideMode: 'append_only',
        redacted: true,
        boundary: '完整岗位提示词仅老板、管理员和平台超管可查看；当前响应已由服务端掩码。',
      }
    : {
        defaultTemplate: employee.md,
        override: override || null,
        overrideTemplate: override || null,
        effectiveTemplate,
        hash: promptHash,
        effectiveHash: promptHash,
        revision: Number(row?.revision || 0),
        overrideMode: 'append_only',
        redacted: false,
        boundary: '企业提示词只可追加，不能替换或弱化出厂岗位手册、必备能力、质量门与安全边界。',
      };

  return {
    identity: {
      idx: employee.idx,
      key: employee.key,
      person: employee.person,
      name: employee.name,
      position: employee.role || employee.name,
      duty: employee.duty,
      description: employee.desc,
      intro: employee.intro,
      emoji: employee.emoji,
      extension: employee.idx === 160,
      specialistId: dbRow.specialist_id,
      department: {
        id: dbRow.department_id,
        code: group.code,
        name: group.name,
        emoji: group.emoji,
        color: group.color,
      },
    },
    capabilities: caps,
    workMethod: {
      requiredInputs: [...employee.inputs],
      steps: [...employee.steps],
      deliverables: [...employee.deliverables],
      qualityGates: [...employee.qualityGates],
      safetyBoundaries: [...employee.safetyBoundaries],
      safetyBoundarySource: employee.safetyBoundarySource,
      manualMarkdown: promptRestricted ? null : employee.md,
    },
    skillLibrary: {
      required: promptRestricted
        ? skills.required.map(({ instructions: _instructions, ...skill }) => skill)
        : skills.required,
      optional: skills.optional,
      learned: skills.learned,
      enabled: skills.enabled,
      catalogStatus: skills.catalogStatus,
      catalogHash: skills.catalogHash,
    },
    prompts: promptView,
    workConfig: config,
    jobProfile: {
      employeeNumber: employee.idx,
      roleKey: employee.key,
      roleTitle: employee.role || employee.name,
      department: group.name,
      moduleGroup: group.name,
      positionSkill: `${employee.name}完整岗位 Skill`,
      duty: employee.duty,
      intro: employee.intro,
      group: group.name,
      scope: 'restaurant_single_employee',
      responsibilities: [employee.duty],
      useCases: [employee.desc],
      nonGoals: [...employee.safetyBoundaries],
      requiredInputs: [...employee.inputs],
      expectedDeliverables: [...employee.deliverables],
      qualityStandards: [...employee.qualityGates],
      safetyBoundaries: [...employee.safetyBoundaries],
      kpis: employee.qualityGates.map(item => `按岗位质量门验收：${item}`),
      authority: {
        mayDraft: true,
        mayReadTenantKnowledge: true,
        mayPublishExternally: false,
        mayCommitFinancialOrRegulatoryDecision: false,
        finalApproval: config.approvalMode,
      },
      serviceLevel: {
        timeoutSeconds: config.timeoutSeconds,
        outputLength: config.outputLength,
      },
      outputContract,
      outputSchema: outputContract.schema,
      primaryArtifact: outputContract.primaryArtifact,
      validOutputFixture: outputContract.validFixture,
      collaborators: RESTAURANT_CATALOG.groups
        .filter(item => item.name !== group.name)
        .map(item => item.name),
      completedRuns: live.completedRuns,
      profileVersion: version,
      source: 'server/catalog/restaurant.json',
      sourceVersion: version,
      boundaries: [...employee.safetyBoundaries],
    },
    runtime: live,
    dispatch: {
      endpoint: `/api/employee-workbench/restaurant/${employee.idx}/dispatch`,
      taskTypes: [...EMPLOYEE_TASK_TYPES],
      types: [...EMPLOYEE_TASK_TYPES],
      defaultTaskType: '执行方案',
      defaultType: '执行方案',
      requirementMaxChars: 8000,
      selectedSpecialistId: dbRow.specialist_id,
      requiredInputs: [...employee.inputs],
      guidance: dispatchGuidance(employee),
      available: true,
      enabled: true,
      lockedCapabilityCount: caps.length,
      snapshotNotice: '派活时会锁定档案修订、完整提示词哈希、全部必备能力、工作配置和本次启用技能。',
    },
    permissions,
    provenance: {
      employeeIdx: employee.idx,
      catalog: 'server/catalog/restaurant.json',
      catalogHash: sha256(fs.readFileSync(RESTAURANT_CATALOG_PATH, 'utf8')),
      manualHash,
      profileVersion: version,
      skillsCatalog: skills.catalogStatus,
      skillsCatalogHash: skills.catalogHash,
      skillsVerificationLevel: EMPLOYEE_SKILL_VERIFICATION_LEVEL,
      skillsEffectValidation: EMPLOYEE_SKILL_EFFECT_VALIDATION,
      tenantId,
      noSilentFallback: true,
    },
  };
}

export function buildEmployeeExecutionProfile(idx, options = {}) {
  const workbench = buildEmployeeWorkbench(idx, options);
  const enabledSkills = workbench.skillLibrary.enabled;
  const systemContext = [
    `【指定数字员工身份·最高优先级】`,
    `员工编号：${workbench.identity.idx}`,
    `姓名：${workbench.identity.person}`,
    `岗位：${workbench.identity.name}`,
    `所属分部：${workbench.identity.department.name}`,
    `岗位职责：${workbench.identity.duty}`,
    `档案修订：${workbench.provenance.profileVersion}`,
    '',
    '【完整岗位手册·必须执行，不得缩减】',
    workbench.workMethod.manualMarkdown,
    '',
    '【全部必备能力·逐项执行且不可关闭】',
    ...workbench.capabilities.map(item => `${item.order}. ${item.name}：${item.description}`),
    '',
    '【质量门】',
    ...workbench.workMethod.qualityGates.map(item => `- ${item}`),
    '',
    '【安全边界】',
    ...workbench.workMethod.safetyBoundaries.map(item => `- ${item}`),
    '',
    '【技能库·本次启用】',
    ...enabledSkills.map(item => `- ${item.title}：${item.detail}（来源：${item.source}；目录与注入验证：${item.verificationLevel || item.verificationStatus || item.origin}；业务效果：${item.effectValidation || '按当前业务样本复核'}）`),
    '',
    '【工作配置】',
    JSON.stringify(workbench.workConfig),
    `【输出语言·必须执行】${workbench.workConfig.language}`,
    `【审批方式·必须执行】${workbench.workConfig.approvalMode}；无论何种模式，本次只能形成待审阅交付，不得自动对外发布。`,
    '',
    '【机器输出契约·直接派活必须执行】',
    workbench.jobProfile.outputContract.instruction,
    `契约ID：${workbench.jobProfile.outputContract.contractId}`,
    `主产物：${workbench.jobProfile.outputContract.primaryArtifact}`,
    workbench.prompts.override ? `\n【本企业补充提示词】\n${workbench.prompts.override}` : '',
    '',
    '【不可覆盖的最终约束】企业补充提示词和可选技能不得停用、删减或绕过完整岗位手册、全部必备能力、质量门与安全边界；历史技能只完成目录完整性与执行注入契约验证，第三方说法、平台时效和真实业务效果仍须按当前样本复核，不得直接当作当前事实。',
  ].join('\n');
  const promptHash = sha256(systemContext);
  return {
    workbench,
    systemContext,
    promptHash,
    responseSchema: {
      name: `restaurant_employee_${workbench.identity.idx}_output`,
      schema: workbench.jobProfile.outputContract.providerSchema,
    },
    outputContract: workbench.jobProfile.outputContract,
    snapshot: {
      profileVersion: workbench.provenance.profileVersion,
      promptHash,
      capabilities: workbench.capabilities,
      config: workbench.workConfig,
      skills: enabledSkills,
      outputContract: workbench.jobProfile.outputContract,
    },
  };
}

export function employeeTemplateFallback(employeeExecution, task) {
  if (!employeeExecution?.workbench) {
    throw new Error('指定数字员工执行档案缺失，不能生成降级底稿');
  }
  const { workbench } = employeeExecution;
  return [
    `# ${workbench.identity.person}｜${task.title || workbench.identity.name}`,
    '',
    '> ⚠️ 当前 AI 通道不可用。本次仅生成可审阅的岗位执行底稿，未完成联网核验、数据分析或外部动作；不得把本底稿当作已执行结果。',
    '',
    '## 一、开始前必须补齐',
    ...workbench.workMethod.requiredInputs.map(item => `- [ ] ${item}`),
    '',
    '## 二、全部必备能力执行清单',
    ...workbench.capabilities.map(item => `${item.order}. **${item.name}**：${item.description}`),
    '',
    '## 三、预期交付物',
    ...workbench.workMethod.deliverables.map(item => `- ${item}`),
    '',
    '## 四、质量门',
    ...workbench.workMethod.qualityGates.map(item => `- [ ] ${item}`),
    '',
    '## 五、安全边界',
    ...workbench.workMethod.safetyBoundaries.map(item => `- ${item}`),
    '',
    '## 六、负责人确认',
    '- 补齐真实门店数据、统计周期与来源。',
    '- 恢复 AI 通道后按本岗位完整手册重新执行。',
    '- 对价格、收益、食安、法律、隐私及外部发布作人工终审。',
  ].join('\n');
}

function upsertConfig(idx, values, userId) {
  const employee = catalogEmployee(idx);
  dbIdentity(employee);
  const tenantId = curTenant();
  const current = configRow(employee.idx, tenantId);
  const prompt = values.promptOverride !== undefined ? values.promptOverride : current?.prompt_override || null;
  const config = values.workConfig !== undefined
    ? JSON.stringify(values.workConfig)
    : current?.work_config_json || '{}';
  const skills = values.skills !== undefined
    ? JSON.stringify(values.skills)
    : current?.skills_json || '[]';
  q.run(`INSERT INTO employee_workbench_configs(
    tenant_id,employee_idx,prompt_override,work_config_json,skills_json,revision,updated_by,updated_at
  ) VALUES(?,?,?,?,?,1,?,datetime('now','localtime'))
  ON CONFLICT(tenant_id,employee_idx) DO UPDATE SET
    prompt_override=excluded.prompt_override,
    work_config_json=excluded.work_config_json,
    skills_json=excluded.skills_json,
    revision=employee_workbench_configs.revision+1,
    updated_by=excluded.updated_by,
    updated_at=excluded.updated_at`,
  tenantId, employee.idx, prompt, config, skills, userId);
}

export function assertWorkbenchManager(user) {
  if (!MANAGER_ROLES.has(user?.role)) {
    throw Object.assign(new Error('仅老板或管理员可修改数字员工工作台'), { status: 403 });
  }
}

export function updateEmployeePrompt(idx, template, user) {
  assertWorkbenchManager(user);
  const prompt = template == null || template === ''
    ? null
    : cleanText(template, 20000, '补充提示词');
  upsertConfig(idx, { promptOverride: prompt }, user.id);
  return buildEmployeeWorkbench(idx, { user });
}

export function updateEmployeeWorkConfig(idx, patch, user) {
  assertWorkbenchManager(user);
  const employee = catalogEmployee(idx);
  const currentWorkbench = buildEmployeeWorkbench(idx);
  const {
    tenantScoped: _tenantScoped,
    fields: _fields,
    values: _values,
    version: _version,
    boundary: _boundary,
    ...current
  } = currentWorkbench.workConfig;
  const skillSource = optionalCatalogSkills(employee.idx);
  const merged = validateWorkConfig({ ...current, ...patch }, employee, skillSource.safeLegacyConfig);
  // tenantScoped 是计算字段，不写入客户配置。
  const saved = Object.fromEntries(Object.entries(merged).filter(([key]) => key !== 'tenantScoped'));
  upsertConfig(idx, { workConfig: saved }, user.id);
  return buildEmployeeWorkbench(idx, { user });
}

export function updateEmployeeSkills(idx, submitted, user) {
  assertWorkbenchManager(user);
  const current = buildEmployeeWorkbench(idx);
  const required = current.skillLibrary.required[0];
  const currentAll = [
    required,
    ...current.skillLibrary.optional,
    ...current.skillLibrary.learned,
  ];
  let normalized = submitted;
  if (!Array.isArray(submitted) && submitted && typeof submitted === 'object') {
    if (Array.isArray(submitted.customSkills)) {
      const custom = submitted.customSkills.map((raw, index) => {
        const title = cleanText(raw?.title || raw?.name || '', 80, '进修技能名称');
        return {
          ...raw,
          id: `learned:${Number(idx)}:${sha256(`${title}|${raw?.source || ''}`).slice(0, 16)}`,
          title,
          detail: raw?.detail || raw?.description || '',
          origin: 'learned',
        };
      });
      normalized = [
        required,
        ...current.skillLibrary.optional,
        ...current.skillLibrary.learned.filter(skill => skill.origin === 'legacy_learned'),
        ...custom,
      ];
    } else if (Array.isArray(submitted.skills)) {
      if (!submitted.skills.length) throw new Error('必备岗位技能不可停用或删除');
      if (submitted.skills.some(item => item?.id === required.id)) {
        normalized = submitted.skills;
      } else {
        const patchById = new Map(submitted.skills.map(item => [String(item?.id || ''), item]));
        for (const id of patchById.keys()) {
          if (!currentAll.some(item => item.id === id)) throw new Error(`技能${id || '（空）'}不存在`);
        }
        normalized = currentAll.map(item => patchById.has(item.id) ? { ...item, ...patchById.get(item.id), id: item.id } : item);
      }
    }
  }
  if (!Array.isArray(normalized)) throw new Error('skills必须是数组');
  const submittedRequired = normalized.find(item => item?.id === required.id);
  if (!submittedRequired || submittedRequired.enabled === false || submittedRequired.deleted === true) {
    throw new Error('必备岗位技能不可停用或删除');
  }
  const optionalById = new Map(
    [...current.skillLibrary.optional, ...current.skillLibrary.learned.filter(skill => skill.origin === 'legacy_learned')]
      .map(skill => [skill.id, skill]),
  );
  const existingLearned = new Map(current.skillLibrary.learned.map(skill => [skill.id, skill]));
  const saved = [];
  const ids = new Set([required.id]);
  for (const raw of normalized) {
    if (raw?.id === required.id) continue;
    const id = String(raw?.id || '');
    if (!id || ids.has(id)) throw new Error('技能ID不能为空或重复');
    ids.add(id);
    if (optionalById.has(id)) {
      saved.push({ id, origin: optionalById.get(id).origin, enabled: raw.enabled !== false });
      continue;
    }
    saved.push(learnedSkill(raw, Number(idx), existingLearned.get(id)));
  }
  upsertConfig(idx, { skills: saved }, user.id);
  return buildEmployeeWorkbench(idx, { user });
}

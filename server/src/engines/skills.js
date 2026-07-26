// 公开来源技能库：优先采用官方或高热度 Agent Skills 仓库中真实存在的 SKILL.md。
// 本系统以对话注入方式加载技能，字段保持前端/接口兼容。
export const OFFICE_SKILLS = [
  {
    key: 'docx',
    name: 'Word文档撰写',
    cat: 'doc',
    icon: '📄',
    desc: '创建、编辑、分析结构化 Word 文档',
    source: 'anthropics/skills · docx',
    sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/docx',
    instructions: '你正在执行「docx」技能。先确认文档类型、读者和交付目的；输出应包含标题、摘要、分级目录、正文、表格/清单和结论。正式文档使用清晰层级与书面语，关键数据只引用用户提供内容。需要生成文件时说明可转为 .docx，并给出适合 Word 排版的结构。',
  },
  {
    key: 'pptx',
    name: 'PPT演示',
    cat: 'doc',
    icon: '📊',
    desc: '生成、编辑、提取 PowerPoint 演示内容',
    source: 'anthropics/skills · pptx',
    sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/pptx',
    instructions: '你正在执行「pptx」技能。按可落地的演示文稿输出：封面、目录、每页标题、核心观点、页面要点、图表/配图建议、讲述逻辑和结尾行动。每页只放一个主观点，要点短而有力；数据页给出图表类型和字段映射；需要生成文件时按可编辑 PPT 的页面结构交付。',
  },
  {
    key: 'pdf',
    name: 'PDF处理',
    cat: 'doc',
    icon: '📕',
    desc: '处理 PDF 阅读、拆分、合并、提取和摘要',
    source: 'anthropics/skills · pdf',
    sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
    instructions: '你正在执行「pdf」技能。围绕 PDF 或长文资料，先识别用户要提取、摘要、审阅还是重排；输出核心结论、关键数据、章节结构、风险/问题和后续动作。忠于原文，不补写不存在的信息；如需文件处理，列出读取、拆分、合并、OCR、表格提取等步骤。',
  },
  {
    key: 'doc-coauthoring',
    name: '文档共创',
    cat: 'doc',
    icon: '🧩',
    desc: '用共创流程完成复杂文档起草与打磨',
    source: 'anthropics/skills · doc-coauthoring',
    sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/doc-coauthoring',
    instructions: '你正在执行「doc-coauthoring」技能。先补齐背景、受众、目标、限制和参考资料；再给文档骨架，随后按章节起草。对重要结论做读者视角检查：是否清楚、可信、可执行。输出时保留可继续迭代的章节编号和待确认项。',
  },
  {
    key: 'xlsx',
    name: 'Excel表格',
    cat: 'data',
    icon: '📗',
    desc: '读写、整理、分析 Excel/CSV/TSV 表格',
    source: 'anthropics/skills · xlsx',
    sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/xlsx',
    instructions: '你正在执行「xlsx」技能。先明确数据表目标、字段、口径和计算规则；输出字段设计、示例表格、公式、校验规则和图表建议。涉及计算时给出可直接粘贴到 Excel/WPS 的公式，并说明适用单元格、绝对引用和异常值处理。',
  },
  {
    key: 'duckdb-query',
    name: '数据查询',
    cat: 'data',
    icon: '🦆',
    desc: '用 DuckDB 思路查询 CSV/Parquet/数据库数据',
    source: 'duckdb/duckdb-skills · query',
    sourceUrl: 'https://github.com/duckdb/duckdb-skills/tree/main/skills/query',
    instructions: '你正在执行「query」技能。先识别数据来源、字段、过滤条件和用户问题；如果能写 SQL，就给 DuckDB Friendly SQL 或伪 SQL，并说明字段口径。分析结果必须包含行数/分组/排序/异常检查思路，避免脱离数据直接下结论。',
  },
  {
    key: 'analytics',
    name: '数据分析',
    cat: 'data',
    icon: '📈',
    desc: '用营销/业务分析框架发现趋势与异常',
    source: 'coreyhaines31/marketingskills · analytics',
    sourceUrl: 'https://github.com/coreyhaines31/marketingskills/tree/main/skills/analytics',
    instructions: '你正在执行「analytics」技能。先明确业务目标和关键指标；按趋势、转化、渠道、 cohort/分层、异常点和机会点分析。结论必须有数据依据，无法验证的原因用假设标注；输出优先级建议和下一步需要补采的数据。',
  },
  {
    key: 'competitor-profiling',
    name: '竞品画像',
    cat: 'data',
    icon: '🔍',
    desc: '系统化拆解竞品定位、渠道、优势与缺口',
    source: 'coreyhaines31/marketingskills · competitor-profiling',
    sourceUrl: 'https://github.com/coreyhaines31/marketingskills/tree/main/skills/competitor-profiling',
    instructions: '你正在执行「competitor-profiling」技能。按目标客户、定位、卖点、定价、渠道、内容、转化路径、优势、弱点和我方机会做竞品画像。事实和推断分开写；缺少外部证据时明确标注需要用户补充或联网核验。',
  },
  {
    key: 'internal-comms',
    name: '内部沟通',
    cat: 'comm',
    icon: '📣',
    desc: '撰写状态报告、FAQ、项目更新和内部通知',
    source: 'anthropics/skills · internal-comms',
    sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/internal-comms',
    instructions: '你正在执行「internal-comms」技能。根据场景选择 3P 更新、状态报告、FAQ、领导汇报、项目更新或事故复盘格式。输出要结论先行、受众明确、行动清楚；涉及风险、阻塞、负责人和截止时间时单独列出。',
  },
  {
    key: 'email-best-practices',
    name: '商务邮件',
    cat: 'comm',
    icon: '✉️',
    desc: '按邮件最佳实践写通知、跟进和客户沟通',
    source: 'resend/resend-skills · email-best-practices',
    sourceUrl: 'https://github.com/resend/resend-skills/tree/main/skills/email-best-practices',
    instructions: '你正在执行「email-best-practices」技能。输出邮件主题、称呼、背景、核心诉求、下一步、截止时间和落款。一封邮件只解决一个主问题；语气专业、明确、可执行。涉及营销或群发邮件时注意合规、退订、可读性和避免垃圾邮件特征。',
  },
  {
    key: 'copywriting',
    name: '营销文案',
    cat: 'comm',
    icon: '📱',
    desc: '写清晰、有转化目标的营销文案',
    source: 'coreyhaines31/marketingskills · copywriting',
    sourceUrl: 'https://github.com/coreyhaines31/marketingskills/tree/main/skills/copywriting',
    instructions: '你正在执行「copywriting」技能。先明确产品、目标用户、渠道、痛点、承诺、证据和 CTA；文案优先清楚而非花哨，使用客户语言，突出利益而不是堆功能。输出 2-3 套差异化文案，并说明各自适合的渠道或人群。',
  },
  {
    key: 'copy-editing',
    name: '校对润色',
    cat: 'comm',
    icon: '✨',
    desc: '用多轮编辑提升清晰度、可信度和转化力',
    source: 'coreyhaines31/marketingskills · copy-editing',
    sourceUrl: 'https://github.com/coreyhaines31/marketingskills/tree/main/skills/copy-editing',
    instructions: '你正在执行「copy-editing」技能。保持原意不变，依次检查清晰度、结构、语气、冗余、证据、行动号召和错别字。输出润色后全文，并列出关键修改点；不要把原文改成与业务事实不符的夸张表达。',
  },
  {
    key: 'content-strategy',
    name: '内容策略',
    cat: 'plan',
    icon: '🧭',
    desc: '规划可搜索、可传播、可转化的内容体系',
    source: 'coreyhaines31/marketingskills · content-strategy',
    sourceUrl: 'https://github.com/coreyhaines31/marketingskills/tree/main/skills/content-strategy',
    instructions: '你正在执行「content-strategy」技能。先明确受众、目标、渠道、主题权威和转化路径；把内容拆成搜索型、传播型、信任型和转化型。输出主题矩阵、内容日历、每篇目的、标题方向、分发渠道和衡量指标。',
  },
  {
    key: 'marketing-plan',
    name: '营销计划',
    cat: 'plan',
    icon: '📌',
    desc: '制定从目标到渠道、实验和指标的营销计划',
    source: 'coreyhaines31/marketingskills · marketing-plan',
    sourceUrl: 'https://github.com/coreyhaines31/marketingskills/tree/main/skills/marketing-plan',
    instructions: '你正在执行「marketing-plan」技能。从目标、目标用户、定位、核心信息、渠道、预算、节奏、实验、指标和风险开始规划。输出按周或按阶段的动作表，明确负责人、产出物、衡量方式和复盘节点。',
  },
  {
    key: 'launch',
    name: '项目发布',
    cat: 'plan',
    icon: '🚀',
    desc: '设计产品/活动发布节奏、清单和传播路径',
    source: 'coreyhaines31/marketingskills · launch',
    sourceUrl: 'https://github.com/coreyhaines31/marketingskills/tree/main/skills/launch',
    instructions: '你正在执行「launch」技能。按发布前、发布日、发布后拆解目标、受众、信息、渠道、素材、节奏、责任人和指标。输出可执行清单，包含关键日期、风险预案、反馈收集和复盘动作。',
  },
  {
    key: 'spec-to-implementation',
    name: '执行拆解',
    cat: 'plan',
    icon: '🎯',
    desc: '把需求/方案拆成任务、验收标准和依赖',
    source: 'makenotion/notion-cookbook · spec-to-implementation',
    sourceUrl: 'https://github.com/makenotion/notion-cookbook/tree/main/skills/claude/spec-to-implementation',
    instructions: '你正在执行「spec-to-implementation」技能。读取用户的需求或方案后，提炼目标、范围、约束、任务、依赖、验收标准和变更影响。输出任务表，包含优先级、负责人角色、预计产出、完成定义和风险。',
  },
  {
    key: 'meeting-intelligence',
    name: '会议智能',
    cat: 'eff',
    icon: '📝',
    desc: '准备会议资料、议程、纪要和行动项',
    source: 'makenotion/notion-cookbook · meeting-intelligence',
    sourceUrl: 'https://github.com/makenotion/notion-cookbook/tree/main/skills/claude/meeting-intelligence',
    instructions: '你正在执行「meeting-intelligence」技能。根据会议目标和背景，输出会前预读、议程、关键问题、决策点、会议纪要和行动项。纪要必须区分讨论、结论、待办；待办包含负责人、截止时间和交付物。',
  },
  {
    key: 'knowledge-capture',
    name: '知识沉淀',
    cat: 'eff',
    icon: '🗃️',
    desc: '把对话和讨论沉淀为可检索知识页',
    source: 'makenotion/notion-cookbook · knowledge-capture',
    sourceUrl: 'https://github.com/makenotion/notion-cookbook/tree/main/skills/claude/knowledge-capture',
    instructions: '你正在执行「knowledge-capture」技能。把零散对话整理为知识页：标题、摘要、适用场景、关键结论、操作步骤、常见问题、关联资料和下一步。适合沉淀决策记录、FAQ、复盘、教程和标准流程。',
  },
  {
    key: 'brand-guidelines',
    name: '品牌规范',
    cat: 'eff',
    icon: '🎨',
    desc: '把品牌颜色、字体和视觉规范应用到文档/演示',
    source: 'anthropics/skills · brand-guidelines',
    sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/brand-guidelines',
    instructions: '你正在执行「brand-guidelines」技能。先确认品牌调性、颜色、字体、禁用项和应用场景；输出文档或演示的视觉规范建议。涉及页面时给背景、标题、正文、强调色、图形和版式规则，保持一致、克制、专业。',
  },
  {
    key: 'skill-creator',
    name: '技能创建',
    cat: 'eff',
    icon: '🛠️',
    desc: '创建、测试、优化可复用 Agent Skill',
    source: 'anthropics/skills · skill-creator',
    sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/skill-creator',
    instructions: '你正在执行「skill-creator」技能。把可重复任务抽象为技能：先定义触发场景、输入、输出、工作流、限制、示例和测试用例。输出应便于写成 SKILL.md，并包含如何验证技能是否真的提升交付质量。',
  },
];

export const SKILL_CATS = [
  { key: 'doc', name: '文档写作' },
  { key: 'data', name: '数据分析' },
  { key: 'comm', name: '沟通表达' },
  { key: 'plan', name: '策划方案' },
  { key: 'eff', name: '效率工具' },
];

const BY_KEY = Object.fromEntries(OFFICE_SKILLS.map(s => [s.key, s]));
const BY_NAME = Object.fromEntries(OFFICE_SKILLS.map(s => [s.name, s]));
export function skillByKey(k) { return BY_KEY[k] || BY_NAME[k] || null; }

export function directivesFor(keys = []) {
  const ds = (keys || []).map(k => skillByKey(k)).filter(Boolean);
  if (!ds.length) return '';
  return '\n\n【已加载技能，请严格按其指令产出】\n' + ds.map(s => `● ${s.name}：${s.instructions}`).join('\n');
}

function cleanTopic(message = '') {
  return String(message || '')
    .replace(/\n【已加载技能[\s\S]*$/m, '')
    .replace(/^测试[:：]\s*/u, '')
    .trim() || '餐饮门店经营增长方案';
}

export function skillFallbackFor(keys = [], message = '', marshal = null) {
  const skill = (keys || []).map(k => skillByKey(k)).find(Boolean);
  if (!skill) return '';
  const topic = cleanTopic(message);
  const role = marshal?.name ? `\n主答数字员工分部：${marshal.name}` : '';
  const common = `【${skill.name}产出】${role}\n需求：${topic}\n`;
  switch (skill.key) {
    case 'docx':
      return `${common}\n# ${topic}\n\n## 一、背景与目标\n围绕餐饮门店的真实经营问题，形成一份可直接放入 Word 的正式方案。\n\n## 二、分析框架\n1. 客群与用餐场景：以CRM、订单或用户提供信息为准。\n2. 菜单与服务：核对菜品、成本、价格、库存、出品与顾客反馈。\n3. 执行动作：由对应数字员工分部给出草案，外发与经营决策由负责人确认。\n\n## 三、执行清单\n| 模块 | 动作 | 负责人 | 验收标准 |\n|---|---|---|---|\n| 数据 | 补齐统计周期与口径 | 财务与数据部 | 来源可追溯 |\n| 内容 | 生成并审核门店素材 | 品牌与增长部 | 事实均已核验 |\n| 运营 | 落地门店动作 | 门店运营部 | 留存执行记录 |\n\n## 四、确认边界\n不得补写不存在的经营结果；价格、优惠、食安、收益与外部承诺须由有权限的负责人确认。`;
    case 'pptx':
      return `${common}\n【第1页】封面：${topic}\n【第2页】经营问题：写明统计周期、现状数据与信息缺口。\n【第3页】顾客与场景：新客、老客、堂食、外卖或团餐的真实分层。\n【第4页】菜单与运营：建议图表为菜品销量/毛利矩阵、客流趋势、复购漏斗。\n【第5页】行动计划：动作、负责人、截止时间、检查标准。\n【第6页】老板拍板：主攻客群、产品策略、预算、食安与合规边界。\n\n备注：没有来源的数据保留“待补”，不以示例数字冒充经营结果。`;
    case 'pdf':
      return `${common}\n一、处理目标\n先确认要提取、摘要、审阅还是重排。\n\n二、优先字段\n门店/客户是谁、菜单与价格是什么、经营数据口径、问题与下一步动作。\n\n三、可提取表格\n| 信息 | 用途 |\n|---|---|\n| 菜品与成本 | 菜单分析 |\n| 订单与客流 | 经营复盘 |\n| 顾客反馈 | 服务改进 |\n\n四、边界\n忠于PDF原文；缺失页、OCR错误与无法验证的结论单独标记。`;
    case 'doc-coauthoring':
      return `${common}\n第一轮共创提纲：\n1. 目标读者：老板、店长、门店执行团队。\n2. 文档目标：明确本周做什么、谁负责、做到什么算完成。\n3. 建议结构：经营事实 → 问题判断 → 目标 → 行动表 → 风险和待确认项。\n\n草稿开头：\n本方案把「${topic}」拆成可执行、可检查、可复盘的门店动作。结论只引用已提供数据；未知的菜品、成本、客群和经营结果保留待确认。\n\n待确认：本轮主攻堂食、外卖、会员复购还是团餐客户？`;
    case 'xlsx':
      return `${common}\n建议工作表：门店客户与任务跟进表\n\n| 客户编号 | 客户类型 | 用餐场景 | 当前阶段 | 下一步动作 | 负责人 | 截止时间 | 数据来源 |\n|---|---|---|---|---|---|---|---|\n| 待录入 | 新客/老客 | 堂食/外卖/团餐 | 待确认 | 待确认 | 待分配 | 待确认 | CRM/订单 |\n\n公式建议：\n- 逾期提醒：=IF(AND(G2<>\"\",G2<TODAY()),\"逾期\",\"正常\")\n- 已完成任务数：=COUNTIF(E:E,\"已完成\")\n- 复购率：=IFERROR(复购客户数/成交客户数,0)\n\n不要在示例行填入虚构客户姓名、金额或成交概率。`;
    case 'duckdb-query':
      return `${common}\n数据查询思路：\nSQL:\nFROM 'leads.csv'\nSELECT owner_id, stage, COUNT(*) AS lead_count, SUM(deal_amount) AS total_amount\nWHERE created_at >= DATE '2026-07-01'\nGROUP BY ALL\nORDER BY total_amount DESC;\n\n检查点：\n1. 先用 SUMMARIZE leads 查看字段类型。\n2. stage 需要统一枚举，避免“已成交/成交”重复。\n3. 结果按负责人和阶段分组，找出转化卡点。`;
    case 'analytics':
      return `${common}\n结论先行：没有完整数据前只给分析框架，不下经营结论。\n\n| 指标 | 判断问题 | 所需数据 |\n|---|---|---|\n| 客流与进店 | 获客是否健康 | 日期、渠道、人数 |\n| 客单与毛利 | 产品结构是否合理 | 菜品、销量、售价、成本 |\n| 出餐与翻台 | 运营是否堵塞 | 下单/出餐/离店时间 |\n| 复购 | 客户资产是否增长 | 客户授权ID、订单周期 |\n\n下一步：补齐同口径数据，再做同比、环比、分层和异常点定位；每条结论注明来源。`;
    case 'competitor-profiling':
      return `${common}\n竞品画像表：\n| 维度 | 我方门店 | 竞品 | 证据来源 | 机会假设 |\n|---|---|---|---|---|\n| 客群与定位 | 待补 | 待调研 | 菜单/平台/实地 | 待验证 |\n| 菜单与价格 | 待补 | 待调研 | 已公开菜单 | 待验证 |\n| 渠道与评价 | 待补 | 待调研 | 平台可见信息 | 待验证 |\n| 服务体验 | 待补 | 待调研 | 实地记录 | 待验证 |\n\n事实和推断分开写；没有联网或用户证据时，不声称竞品价格、销量或优劣。`;
    case 'internal-comms':
      return `${common}\n主题：本周门店经营任务推进通知\n\n目标：围绕「${topic}」把数据核对、内容审核、门店执行和复盘责任明确到人。\n\n当前进展：待各负责人按真实状态补充。\n风险：菜品、价格、库存、食安与活动权益未经确认不得外发。\n下一步：各负责人提交完成状态、证据链接、阻塞项和预计完成时间。`;
    case 'email-best-practices':
      return `${common}\n邮件主题：关于${topic}需求与沟通时间的确认\n\n您好，\n\n为避免信息不完整，想先确认用餐人数、时间、预算、口味与忌口。收到后，门店会核对菜单、价格、可预约时段与服务边界，再提供正式方案。\n\n您方便回复可沟通的时间吗？\n\n说明：价格、优惠、库存与预约结果以门店书面确认为准。\n\n祝好\n门店团队`;
    case 'copywriting':
      return `${common}\n方案A（产品清晰型）：\n围绕「${topic}」，请补充【真实菜品】【适合人数】【口味特点】【已确认价格】。顾客可先查看菜单，再按需求咨询。\n\n方案B（场景沟通型）：\n计划一次聚餐，先把人数、口味、忌口和预算说清楚。门店会根据「${topic}」给出可执行建议，菜品与预约以当日确认为准。\n\nCTA：私信“菜单”或“预约”；发布前核验所有事实，不使用虚假稀缺和未经证实的顾客评价。`;
    case 'copy-editing':
      return `${common}\n润色原则：保留原意，按“适合谁、提供什么、怎样行动”重排；删除绝对化承诺、虚假稀缺和无证据结果。\n\n核对表：\n| 项目 | 要求 |\n|---|---|\n| 菜品/价格/库存 | 门店已确认 |\n| 顾客评价/销量 | 有可追溯来源 |\n| 食安与过敏原 | 由负责人审核 |\n| CTA | 清楚但不强迫 |`;
    case 'content-strategy':
      return `${common}\n内容策略矩阵：\n| 类型 | 目的 | 选题例子 | 指标 |\n|---|---|---|---|\n| 搜索型 | 解决疑问 | 某用餐场景怎么点菜 | 搜索/收藏 |\n| 信任型 | 展示专业 | 真实后厨/服务流程 | 完播/咨询 |\n| 转化型 | 促成行动 | 已确认菜单或活动说明 | 到店/预约 |\n| 复购型 | 激活老客 | 新品与会员关怀 | 复购 |\n\n节奏与数量依据账号历史表现设定；不把示例数量当作真实目标。`;
    case 'marketing-plan':
      return `${common}\n营销计划：\n目标：先由老板确认30天内要改善的单一指标。\n\n阶段动作：\n1. 第1周：核对客群、订单、渠道与基线数据。\n2. 第2周：发布已审核内容，记录咨询来源。\n3. 第3周：开展经门店核定的到店实验。\n4. 第4周：复盘咨询、到店、成交、复购与成本。\n\n指标必须来自真实系统数据；预算、优惠和活动容量由负责人确认。`;
    case 'launch':
      return `${common}\n发布前：完成方案、内容、话术和门店SOP；核对菜品、价格、库存、食安、权益与个人信息授权。\n\n发布日：按已审核渠道发布；门店只开放实际可承接的预约时段。\n\n发布后：按负责人确认的服务时限跟进咨询，记录问题与异常，并基于真实数据复盘。`;
    case 'spec-to-implementation':
      return `${common}\n执行拆解：\n| 任务 | 优先级 | 负责人角色 | 验收标准 |\n|---|---|---|---|\n| 确认目标与数据口径 | P0 | 老板/财务与数据部 | 来源可追溯 |\n| 核对菜单与食安信息 | P0 | 产品部/食安与合规部 | 负责人签核 |\n| 内容与话术生成 | P1 | 品牌与增长部 | 进入审核状态 |\n| 门店执行排期 | P1 | 门店运营部 | 容量、人员、物料确认 |\n| 复盘看板 | P2 | 财务与数据部 | 指标可下钻到记录 |\n\n依赖：事实与权限口径确认后，内容才能外发。`;
    case 'meeting-intelligence':
      return `${common}\n会前预读：目标是确定「${topic}」的事实、决策、负责人和复盘时间。\n\n议程：\n1. 老板明确单一目标与边界。\n2. 财务与数据部汇报数据口径和缺口。\n3. 对应分部提交方案与风险。\n4. 门店运营部确认资源与承接能力。\n5. 形成行动项：事项/负责人/截止时间/验收标准。\n\n待决策：优先级、预算、菜单/服务调整与合规边界。`;
    case 'knowledge-capture':
      return `${common}\n# 知识沉淀：${topic}\n\n## 摘要\n记录问题、证据、决策与结果，不把建议写成已发生事实。\n\n## 标准结构\n1. 适用门店与场景。\n2. 输入数据及来源。\n3. 标准步骤与负责人。\n4. 食安、合规和人工确认点。\n5. 真实结果与复盘日期。\n\n## 常见问题\n若价格、成本、库存或经营结果缺少来源，标记“待确认”并关联原始记录。`;
    case 'brand-guidelines':
      return `${common}\n品牌规范建议：\n| 元素 | 规则 |\n|---|---|\n| 主色 | 使用纳米Work行业版已批准的品牌色 |\n| 字体 | 标题、正文层级清晰，适合实体店老板快速阅读 |\n| 图片 | 使用当日真实菜品、门店、员工与服务场景 |\n| 数据 | 图表注明周期、口径与来源 |\n| 禁用 | 虚假稀缺、夸张收益、未授权顾客肖像和杂乱促销贴纸 |\n\n外部物料发布前由品牌与增长部及食安与合规部审核。`;
    case 'skill-creator':
      return `${common}\nSKILL.md 草案：\n---\nname: restaurant-operation-plan\ndescription: 基于真实门店数据生成可执行经营方案与复盘指标。\n---\n\n# 餐饮门店经营方案技能\n\n## 使用场景\n当用户要分析菜单、客流、库存、服务、复购或门店活动时使用。\n\n## 工作流\n1. 询问门店类型、目标、统计周期、数据来源和禁用表达。\n2. 输出问题判断、所需数据、行动表与检查标准。\n3. 标注食安、价格、优惠、收益和外部动作的人工确认边界。\n4. 用可追溯记录验证结果，不编造案例或数据。`;
    default:
      return `${common}\n已按「${skill.name}」技能输出：\n1. 先明确目标和受众。\n2. 再拆成结构化步骤。\n3. 最后给可执行动作和检查标准。`;
  }
}

export function skillsForClient() {
  return OFFICE_SKILLS.map(({ key, name, cat, icon, desc }) => ({ key, name, cat, icon, desc }));
}

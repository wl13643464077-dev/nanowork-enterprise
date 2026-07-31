import { generate, aiAvailable } from './ai.js';

const PROMPT_VERSION = 'toolbox-template-v1';
const AI_PROMPT_VERSION = 'toolbox-ai-v1';
const SOURCE_SYSTEM = 'nanowork';

export const TOOL_DEFINITIONS = Object.freeze({
  hot: Object.freeze({ key: 'hot', title: '今日必发', employeeIdx: 141, employeeName: '云营销' }),
  remix: Object.freeze({ key: 'remix', title: '视频混剪', employeeIdx: 140, employeeName: '章文案' }),
  pcal: Object.freeze({ key: 'pcal', title: '私域日历', employeeIdx: 141, employeeName: '云营销' }),
  bench: Object.freeze({ key: 'bench', title: '竞品盯梢', employeeIdx: 102, employeeName: '钱商圈' }),
  warm: Object.freeze({ key: 'warm', title: '起号军师', employeeIdx: 142, employeeName: '苏种草' }),
  leads: Object.freeze({ key: 'leads', title: '线索雷达', employeeIdx: 143, employeeName: '潘口碑' }),
  shot: Object.freeze({ key: 'shot', title: '产品图文', employeeIdx: 140, employeeName: '章文案' }),
  vars: Object.freeze({ key: 'vars', title: '口播矩阵', employeeIdx: 140, employeeName: '章文案' }),
});

export const TOOL_KEYS = Object.freeze(Object.keys(TOOL_DEFINITIONS));

const stringField = (label, { required = false, min = 1, max = 2_000, pattern = null } = {}) =>
  Object.freeze({ type: 'string', label, required, min, max, pattern });
const stringArrayField = (label, { required = false, minItems = 1, maxItems = 8, itemMax = 80 } = {}) =>
  Object.freeze({ type: 'string[]', label, required, minItems, maxItems, itemMax });
const integerField = (label, { required = false, min, max } = {}) =>
  Object.freeze({ type: 'integer', label, required, min, max });

const INPUT_SCHEMAS = Object.freeze({
  hot: Object.freeze({
    store: stringField('门店 / 品类', { required: true, max: 240 }),
    channels: stringArrayField('发布渠道', { required: true, maxItems: 5, itemMax: 30 }),
    focus: stringField('今日经营重点', { required: true, max: 2_000 }),
  }),
  remix: Object.freeze({
    materials: stringField('手机素材说明', { required: true, max: 4_000 }),
    platform: stringField('目标平台', { max: 40 }),
    goal: stringField('成片目的', { required: true, max: 500 }),
  }),
  pcal: Object.freeze({
    month: stringField('计划月份', { required: true, max: 7, pattern: /^\d{4}-(0[1-9]|1[0-2])$/ }),
    channels: stringArrayField('经营渠道', { maxItems: 5, itemMax: 30 }),
    focus: stringField('本月经营重点', { required: true, max: 2_000 }),
  }),
  bench: Object.freeze({
    targets: stringField('对标门店', { required: true, max: 2_500 }),
    period: stringField('观察周期', { max: 40 }),
    focus: stringField('关注主题', { max: 500 }),
  }),
  warm: Object.freeze({
    platform: stringField('主阵地平台', { max: 40 }),
    positioning: stringField('门店定位', { required: true, max: 1_000 }),
    persona: stringField('老板人设', { max: 1_000 }),
    goal: stringField('30天目标', { max: 1_000 }),
  }),
  leads: Object.freeze({
    city: stringField('城市 / 商圈', { required: true, max: 240 }),
    product: stringField('门店产品', { required: true, max: 1_000 }),
    audience: stringField('目标客群', { max: 1_000 }),
    constraints: stringField('核验与合规约束', { max: 2_000 }),
  }),
  shot: Object.freeze({
    product: stringField('产品 / 套餐', { required: true, max: 500 }),
    facts: stringField('可核验的真实卖点', { required: true, max: 3_000 }),
    channels: stringArrayField('使用渠道', { maxItems: 6, itemMax: 30 }),
  }),
  vars: Object.freeze({
    script: stringField('原始口播', { required: true, min: 20, max: 4_000 }),
    variants: integerField('裂变数量', { min: 2, max: 6 }),
    platform: stringField('目标平台', { max: 40 }),
  }),
});

export class ToolboxValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolboxValidationError';
    this.status = 400;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeString(value, field) {
  if (typeof value !== 'string') throw new ToolboxValidationError(`${field.label}必须是文本`);
  const normalized = value.trim();
  if (normalized.length < field.min || normalized.length > field.max) {
    throw new ToolboxValidationError(`${field.label}长度必须在${field.min}-${field.max}字之间`);
  }
  if (field.pattern && !field.pattern.test(normalized)) {
    throw new ToolboxValidationError(`${field.label}格式不正确`);
  }
  return normalized;
}

function normalizeStringArray(value, field) {
  if (!Array.isArray(value)) throw new ToolboxValidationError(`${field.label}必须是数组`);
  if (value.length < field.minItems || value.length > field.maxItems) {
    throw new ToolboxValidationError(`${field.label}必须包含${field.minItems}-${field.maxItems}项`);
  }
  const normalized = value.map((item) => {
    if (typeof item !== 'string') throw new ToolboxValidationError(`${field.label}的每一项都必须是文本`);
    const text = item.trim();
    if (!text || text.length > field.itemMax) {
      throw new ToolboxValidationError(`${field.label}的每一项必须为1-${field.itemMax}字`);
    }
    return text;
  });
  if (new Set(normalized).size !== normalized.length) throw new ToolboxValidationError(`${field.label}不能包含重复项`);
  return normalized;
}

function normalizeInteger(value, field) {
  if (!Number.isInteger(value)) throw new ToolboxValidationError(`${field.label}必须是整数`);
  if (value < field.min || value > field.max) {
    throw new ToolboxValidationError(`${field.label}必须在${field.min}-${field.max}之间`);
  }
  return value;
}

function validateInputs(toolKey, inputs) {
  if (!isPlainObject(inputs)) throw new ToolboxValidationError('inputs必须是对象');
  const schema = INPUT_SCHEMAS[toolKey];
  const keys = Object.keys(inputs);
  if (keys.length > Object.keys(schema).length) throw new ToolboxValidationError('inputs包含多余字段');
  const unknown = keys.find(key => !Object.hasOwn(schema, key));
  if (unknown) throw new ToolboxValidationError(`inputs包含不支持的字段：${unknown}`);

  const output = {};
  let arrayItemCount = 0;
  for (const [key, field] of Object.entries(schema)) {
    const present = Object.hasOwn(inputs, key) && inputs[key] !== undefined && inputs[key] !== null;
    if (!present) {
      if (field.required) throw new ToolboxValidationError(`缺少必填项：${field.label}`);
      continue;
    }
    if (field.type === 'string') output[key] = normalizeString(inputs[key], field);
    else if (field.type === 'string[]') {
      output[key] = normalizeStringArray(inputs[key], field);
      arrayItemCount += output[key].length;
    } else if (field.type === 'integer') output[key] = normalizeInteger(inputs[key], field);
  }
  if (arrayItemCount > 8) throw new ToolboxValidationError('inputs中的数组合计不能超过8项');

  if (toolKey === 'bench') {
    const targetLines = output.targets.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    if (targetLines.length > 8) throw new ToolboxValidationError('对标门店最多填写8个');
    if (targetLines.some(item => item.length > 300)) throw new ToolboxValidationError('单个对标门店说明不能超过300字');
  }

  const json = JSON.stringify(output);
  if (Buffer.byteLength(json, 'utf8') > 12 * 1024) throw new ToolboxValidationError('inputs总长度不能超过12KB');
  return output;
}

export function validateToolRunPayload(body) {
  if (!isPlainObject(body)) throw new ToolboxValidationError('请求内容必须是对象');
  const allowedBodyKeys = new Set(['toolKey', 'employeeIdx', 'title', 'inputs']);
  const unknown = Object.keys(body).find(key => !allowedBodyKeys.has(key));
  if (unknown) throw new ToolboxValidationError(`请求包含不支持的字段：${unknown}`);

  if (typeof body.toolKey !== 'string' || !Object.hasOwn(TOOL_DEFINITIONS, body.toolKey)) {
    throw new ToolboxValidationError(`toolKey仅支持：${TOOL_KEYS.join('、')}`);
  }
  const definition = TOOL_DEFINITIONS[body.toolKey];
  if (!Number.isInteger(body.employeeIdx) || body.employeeIdx !== definition.employeeIdx) {
    throw new ToolboxValidationError(`${definition.title}必须由数字员工 #${definition.employeeIdx} 执行`);
  }
  if (typeof body.title !== 'string') throw new ToolboxValidationError('title必须是文本');
  const title = body.title.trim();
  if (!title || title.length > 120) throw new ToolboxValidationError('title长度必须为1-120字');

  return {
    definition,
    title,
    inputs: validateInputs(body.toolKey, body.inputs),
  };
}

function display(value, fallback = '待补充') {
  if (Array.isArray(value)) return value.length ? value.join('、') : fallback;
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function compact(value, max = 180) {
  const text = display(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function md(value, fallback = '待补充') {
  return display(value, fallback)
    .replaceAll('\\', '\\\\')
    .replace(/([`*_[\]{}()#+.!|<>-])/g, '\\$1')
    .replace(/\r?\n/g, '；');
}

function summaryFor(toolKey, inputs) {
  const schema = INPUT_SCHEMAS[toolKey];
  return Object.entries(inputs)
    .map(([key, value]) => `${schema[key].label}：${compact(value)}`)
    .join('；')
    .slice(0, 1_200);
}

const safetySection = `## 人工确认与执行边界

- 本工具仅生成待人工核验的经营草案，不会自动发布内容、下单采购、修改价格、安排排班或处罚员工。
- 对外使用前，请负责人复核事实、素材授权、价格库存、平台规则和门店实际承接能力。
- 涉及食品安全、过敏原、促销条款、个人信息或投诉事件时，必须交由有权限的人员确认。`;

function hotTemplate(inputs) {
  const channels = md(inputs.channels);
  return `# 今日必发 · 执行草案

> 门店锚点：${md(inputs.store)}  
> 今日重点：${md(inputs.focus)}  
> 建议渠道：${channels}

## 三个可立即准备的选题

| 优先级 | 选题 | 内容角度 | 现场素材 | 人工承接动作 |
| --- | --- | --- | --- | --- |
| 1 | 今天为什么值得来 | 围绕“${md(inputs.focus)}”讲一个可验证的到店理由 | 当日门头、出品过程、真实环境各1段 | 发布前确认当日可售与接待能力，评论只引导咨询 |
| 2 | 一道产品的真实细节 | 只讲食材、工艺、份量或口感中已核实的两点 | 原料近景、关键工序、成品全景 | 把高频问题交给店员人工回复，不承诺未确认权益 |
| 3 | 老板/员工现场答疑 | 回答顾客最可能犹豫的一个问题，保留条件与边界 | 真人口播、现场演示、价格牌或菜单实拍 | 将有效咨询登记为待跟进线索，不批量私信 |

## 建议发布节奏

1. 先在${channels}中选择一个主渠道试发，不同渠道不要机械复制。
2. 发布前由当班负责人核对产品、库存、价格、营业时间和画面授权。
3. 发布后只记录真实曝光、咨询、预订或到店结果，24小时后决定是否复用。

${safetySection}`;
}

function remixTemplate(inputs) {
  return `# 视频混剪 · 剪辑单草案

> 素材说明：${md(inputs.materials)}  
> 目标平台：${md(inputs.platform)}  
> 成片目的：${md(inputs.goal)}

## 竖屏成片结构（建议15—25秒）

| 时段 | 画面任务 | 字幕/口播任务 | 剪辑指令 |
| --- | --- | --- | --- |
| 0—3秒 | 使用最清楚的结果镜头或现场动作 | 直接点明顾客场景，不写虚假“全城第一” | 1秒内出现主体，保留环境声作真实感 |
| 3—8秒 | 原料、工序或服务过程 | 解释一个已核验卖点 | 2—3个短镜头，避免无意义转场 |
| 8—15秒 | 成品、人物或用餐场景 | 回扣“${md(inputs.goal)}” | 字幕逐句出现，重要事实留足阅读时间 |
| 15—结尾 | 门头、菜单或人工咨询入口 | 给出低压力行动指令 | 不展示未确认价格、库存或限量承诺 |

## 素材与声音检查

- 先确认顾客肖像、员工出镜、音乐和第三方画面均有使用授权。
- 本次只输出剪辑方案，没有读取、剪辑或上传任何视频文件，也没有生成实际成片。
- 导出前检查字幕事实、平台比例、安全区域、封面和联系方式披露范围。

${safetySection}`;
}

const calendarThemes = [
  ['产品事实', '讲清一道产品的食材、工艺或份量', '11:00'],
  ['门店现场', '记录当天真实准备或服务细节', '16:30'],
  ['顾客问题', '回答一个高频问题并保留人工咨询入口', '12:30'],
  ['老板观点', '围绕经营重点讲判断与坚持', '20:00'],
  ['口碑证据', '使用已授权、可核验的真实反馈', '18:30'],
  ['场景提醒', '结合周末/工作日需求给出用餐建议', '10:30'],
  ['周复盘', '公布真实过程结果与下周改进', '21:00'],
];

function pcalTemplate(inputs) {
  const [year, month] = inputs.month.split('-').map(Number);
  const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows = [];
  for (let day = 1; day <= dayCount; day++) {
    const [theme, task, time] = calendarThemes[(day - 1) % calendarThemes.length];
    rows.push(`| ${inputs.month}-${String(day).padStart(2, '0')} | ${theme} | ${task}；连接“${md(inputs.focus)}” | ${time} | 待审核 |`);
  }
  return `# ${md(inputs.month)} 私域内容日历草案

> 经营重点：${md(inputs.focus)}  
> 使用渠道：${md(inputs.channels)}

## 每日主题与建议时间

| 日期 | 内容支柱 | 当日任务 | 建议时间 | 状态 |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

## 每周验收

- 周一核对本周产品、活动、价格和素材授权；缺一项就保留“待补充”，不猜测。
- 周三查看真实咨询与到店反馈，只调整主题和表达，不把自然波动写成确定因果。
- 周日记录已发布、有效咨询、预订/到店和复用素材，形成下一周输入。

${safetySection}`;
}

function benchTemplate(inputs) {
  const targets = inputs.targets.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  const rows = targets.map((target, index) =>
    `| ${index + 1} | ${md(target)} | 待人工核验 | 待人工核验 | 待人工核验 | 未形成结论 |`).join('\n');
  return `# 竞品盯梢 · 人工核验工作表

> 观察周期：${md(inputs.period)}  
> 关注主题：${md(inputs.focus)}

## 数据状态

**本次模板模式未联网、未抓取平台页面，也没有获得实时价格、评价或活动变化。下表只是核验框架，不代表已经监测到竞品动作。**

## 对标门店核验表

| 序号 | 对标对象 | 营业/渠道状态 | 产品与价格证据 | 口碑/活动证据 | 当前判断 |
| --- | --- | --- | --- | --- | --- |
${rows}

## 人工观察方法

1. 对每条事实记录公开来源、链接/截图、观察日期和观察人；无法核实的字段写“未知”。
2. 至少区分菜单标价、实际成交、团购券与短期活动，不将不同口径直接比较。
3. 把直接竞品、同场景替代和便利性替代分开，避免只看同菜系门店。

## 可行动空白（待证据后填写）

- 顾客场景未被满足：待对照真实评价主题和到店观察后判断。
- 产品/服务差异：待核对自身交付能力和单位经济后判断。
- 不建议跟随项：刷评、虚假限量、未经核实的低价承诺，以及超出门店产能的活动。

${safetySection}`;
}

const warmDailyActions = [
  '讲清门店定位与适合的消费场景', '拍一条真实出品或服务过程', '回答一个高频顾客问题',
  '用老板口吻解释一项经营坚持', '展示一道产品的已核验细节', '复用本周有效主题并更换证据', '复盘数据并整理下周假设',
];

function warmTemplate(inputs) {
  const rows = [];
  for (let day = 1; day <= 30; day++) {
    const phase = day <= 7 ? '定位校准' : day <= 14 ? '支柱测试' : day <= 21 ? '表达优化' : '稳定复用';
    rows.push(`| 第${day}天 | ${phase} | ${warmDailyActions[(day - 1) % warmDailyActions.length]} | 完播/有效互动/咨询按真实值登记 |`);
  }
  return `# 起号军师 · 30天冷启动草案

> 主阵地：${md(inputs.platform)}  
> 门店定位：${md(inputs.positioning)}  
> 老板人设：${md(inputs.persona)}  
> 目标：${md(inputs.goal)}

## 三个内容支柱

1. **产品与现场证据**：用真实食材、工序、份量、服务和环境证明定位。
2. **老板判断**：围绕顾客选择难题表达有边界的专业观点，不编造创业故事。
3. **顾客场景答疑**：回答谁适合、何时来、如何选；价格、库存和权益均以当天确认为准。

## 30天动作表

| 日期 | 阶段 | 当日动作 | 记录指标 |
| --- | --- | --- | --- |
${rows.join('\n')}

## 每周验收门

- 第1周：完成基础发布并确认定位能被非员工复述，不以粉丝数单独判定成败。
- 第2周：至少找出2个有真实互动或咨询证据的内容支柱。
- 第3周：优化开头、节奏和行动指令，事实主体保持一致。
- 第4周：只复用有证据的主题，形成下月继续/停止清单。

${safetySection}`;
}

function leadsTemplate(inputs) {
  return `# 线索雷达 · 公开信号核验清单

> 范围：${md(inputs.city)}  
> 产品：${md(inputs.product)}  
> 目标客群：${md(inputs.audience)}  
> 约束：${md(inputs.constraints)}

## 数据状态

**本次模板模式未联网、未搜索社交平台，也没有发现任何真实个人线索。以下内容是人工公开检索与核验计划，不是实时线索名单。**

## 待人工核验的需求信号

| 信号类型 | 建议公开检索组合 | 命中后要核验 | 合规承接草案 |
| --- | --- | --- | --- |
| 求推荐 | “${md(inputs.city)} + ${md(inputs.product)} + 推荐/哪里有” | 发布时间、公开可见性、场景是否匹配 | 公开回复可验证信息，邀请对方自行查看门店公开页面 |
| 吐槽/未满足 | “${md(inputs.city)} + 排队/难找/不适合” | 是否为具体需求，避免利用投诉施压 | 先提供中性帮助，不贬低其他门店 |
| 攻略/计划 | “${md(inputs.city)} + 聚餐/约会/宴请 + 攻略” | 人数、日期、预算是否由对方公开表达 | 提供选择清单，价格与可订状态由人工确认 |
| 比价/决策 | “${md(inputs.city)} + 套餐/人均 + 怎么选” | 比较口径、活动期限与信息日期 | 只说明自身已核验事实，不作最低价承诺 |

## 线索登记最小字段

- 只记录公开页面链接、信号类型、观察时间、匹配理由和人工核验状态。
- 不抓取或推断手机号、私密账号、精确住址、未成年人信息及其他不必要个人数据。
- 未经对方主动联系或平台许可，不批量私信、不绕过平台规则触达。

${safetySection}`;
}

function shotTemplate(inputs) {
  return `# 产品图文 · 多渠道草案

> 产品/套餐：${md(inputs.product)}  
> 用户提供的待核验卖点：${md(inputs.facts)}  
> 使用渠道：${md(inputs.channels)}

## 卖点证据结构

| 层级 | 草案表达 | 发布前所需证据 |
| --- | --- | --- |
| 识别 | 这是“${md(inputs.product)}” | 当前菜单、可售状态与名称一致 |
| 选择理由 | 从已提供事实中选2项：${md(inputs.facts)} | 配方/称重/供应或现场记录能支持 |
| 适用场景 | 结合人数、餐段和门店承接能力说明 | 份量、桌型、营业时间与预订规则 |
| 行动入口 | 建议先咨询当天可售、价格和等位情况 | 当班负责人确认公开联系方式 |

## 渠道文案骨架

### 外卖平台

**标题：** ${md(inputs.product)}｜核心食材/工艺待核验  
**短描述：** 根据“${md(inputs.facts)}”提炼两项真实细节；份量、配料、过敏原、价格和可售状态以上架前确认为准。

### 朋友圈 / 社群

今天想认真讲讲${md(inputs.product)}。不堆“最好”“必吃”，只把已经能证明的食材、工艺和适用场景说清楚。想了解当天可售与具体价格，请通过门店公开渠道人工确认。

### 小红书 / 短内容

建议使用“问题—过程—成品—适合谁”的四段结构；标题不使用虚假探店、排名、未验证健康声称或顾客证言。

### 门店桌卡

保留产品名、2项已核验特点、必要过敏原提示和人工咨询入口，避免堆砌无法现场证明的形容词。

## 拍摄清单

- 主图：真实成品全貌，颜色不过度修饰；细节图：关键食材或工序；场景图：不拍未授权顾客。
- 海报上的价格、份量、活动期限、门店地址和二维码由负责人逐项校对。

${safetySection}`;
}

function varsTemplate(inputs) {
  const count = inputs.variants || 3;
  const platform = md(inputs.platform);
  const original = md(inputs.script);
  const hooks = [
    '先从顾客最常问的问题切入', '先展示结果画面，再解释过程', '先说一个门店坚持，但不给绝对承诺',
    '先描述具体用餐场景', '先指出一种常见选择误区', '先用当天真实现场作为开场',
  ];
  const calls = [
    '想了解当天情况，请通过门店公开渠道人工确认。', '把你最关心的问题留言，门店人员核实后回复。',
    '到店前请先确认价格、可售与等位情况。', '先收藏这份选择思路，需要时再向门店咨询。',
    '具体配料、过敏原和活动规则请向当班负责人确认。', '欢迎查看门店公开信息，不做批量私信触达。',
  ];
  const sections = [];
  for (let i = 0; i < count; i++) {
    sections.push(`### 方案${i + 1}｜${hooks[i]}

**开头指令：** ${hooks[i]}，用1句话落到“${platform}”用户能理解的具体场景。  
**事实主体（保持原意，不擅自改写数字与承诺）：** ${original}  
**行动指令：** ${calls[i]}  
**镜头建议：** 真人口播为主，穿插与原稿事实直接相关的现场证据；不使用无授权顾客画面。`);
  }
  return `# 口播矩阵 · ${count}版裂变草案

> 目标平台：${platform}  
> 处理原则：模板只改变开头、节奏和行动指令，原稿中的事实、数字与承诺仍需人工逐项核验。

${sections.join('\n\n')}

## 风险检查

- 删除或补证“第一、最好、最低、保证、一定有效”等绝对或无法证明的表达。
- 核对价格、库存、活动期限、配料、过敏原、人物与音乐授权。
- 若原稿包含未经证实的事实，本草案保留原文不代表系统认可，发布前必须修正。

${safetySection}`;
}

const TEMPLATE_BY_KEY = Object.freeze({
  hot: hotTemplate,
  remix: remixTemplate,
  pcal: pcalTemplate,
  bench: benchTemplate,
  warm: warmTemplate,
  leads: leadsTemplate,
  shot: shotTemplate,
  vars: varsTemplate,
});

function toolboxEmployeeSnapshot(employeeExecution) {
  if (!employeeExecution?.workbench) return null;
  const { workbench } = employeeExecution;
  return {
    identity: workbench.identity,
    capabilities: workbench.capabilities,
    workMethod: workbench.workMethod,
    skills: workbench.skillLibrary.enabled,
    prompts: workbench.prompts,
    workConfig: workbench.workConfig,
    jobProfile: workbench.jobProfile,
    profileVersion: workbench.provenance.profileVersion,
    promptHash: employeeExecution.promptHash,
    systemContext: employeeExecution.systemContext,
  };
}

function assumptionsFor(toolKey, inputs) {
  const assumptions = [
    '本次使用纳米Work内置安全模板，未调用外部模型，也未联网检索。',
    '所有用户输入均按“待人工核验”处理，系统未验证价格、库存、平台规则、素材权利或经营效果。',
  ];
  const schema = INPUT_SCHEMAS[toolKey];
  for (const [key, field] of Object.entries(schema)) {
    if (!field.required && !Object.hasOwn(inputs, key)) assumptions.push(`未提供“${field.label}”，草案以“待补充”占位。`);
  }
  if (toolKey === 'bench') assumptions.push('竞品价格、口碑、活动和营业状态均未获取，不能把核验表当成实时竞品结论。');
  if (toolKey === 'leads') assumptions.push('系统没有发现或保存任何真实个人线索，需求信号必须由员工在公开范围内人工核验。');
  return assumptions;
}

function evidenceFor(toolKey) {
  const evidence = [{ label: '本次工具表单输入', source: 'nanowork:user-input' }];
  if (toolKey === 'bench' || toolKey === 'leads') {
    evidence.push({ label: '外部平台实时数据', source: '未联网，待人工补充' });
  }
  return evidence;
}

// AI 生成通道：由路由注入完整员工执行档案；积分占扣与结算在路由层完成。
// 失败或未配置时回退安全模板，provenance.completionState='draft'，不能被计作真实完成。
export async function generateToolboxRun(definition, inputs, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const employeeExecution = options.employeeExecution || null;
  const employeeSnapshot = toolboxEmployeeSnapshot(employeeExecution);
  const template = generateToolboxDraft(definition, inputs, now);
  const draft = {
    ...template,
    provenance: {
      ...template.provenance,
      completionState: 'draft',
      employeeSnapshot,
    },
  };
  if (!aiAvailable()) return draft;
  const config = employeeExecution?.workbench?.workConfig || {};
  const system = [
    employeeExecution?.systemContext || '',
    '',
    '【本次经营工具任务】',
    `你是纳米Work行业版的餐饮数字员工「${definition.employeeName}」，正在执行经营工具「${definition.title}」。`,
    '请输出结构清晰、动作可执行的中文 Markdown 交付草案。',
    '硬性边界：',
    '- 不得编造数据、案例、竞品实时信息或个人线索；缺失信息一律标注「待补充」或「待人工核验」。',
    '- 不承诺经营效果；金额、优惠与对外承诺必须标注需门店负责人确认。',
    '- 你没有联网检索能力，所有外部事实只能来自用户输入，不得暗示你查询过外部平台。',
  ].join('\n');
  const userMsg = [
    `工具输入摘要：\n${template.inputSummary}`,
    `原始输入 JSON：\n${JSON.stringify(inputs)}`,
    `请产出「${definition.title}」的完整交付草案；可参考以下交付结构（可优化重组，不要逐句照抄）：\n${template.resultMd.slice(0, 1200)}`,
  ].join('\n\n');
  const r = await generate({
    kind: `toolbox:${definition.key}`, system, userMsg,
    fallback: () => template.resultMd,
    maxTokens: config.outputLength === 'full' ? 5000 : 2500,
    role: options.role || 'sales',
    model: config.textModel || undefined,
    timeoutMs: Number(config.timeoutSeconds) > 0 ? Number(config.timeoutSeconds) * 1000 : undefined,
  });
  if (r.mode !== 'api') return draft;
  return {
    ...template,
    resultMd: r.text,
    assumptions: [
      '本次草案由 AI 模型基于表单输入生成，未联网检索；所有结论需人工核验后使用。',
      ...template.assumptions.filter(item => !item.startsWith('本次使用纳米Work内置安全模板')),
    ],
    provenance: {
      ...template.provenance,
      mode: 'api',
      model: r.model,
      usage: r.usage,
      promptVersion: AI_PROMPT_VERSION,
      completionState: 'completed',
      employeeSnapshot,
    },
  };
}

export function generateToolboxDraft(definition, inputs, now = new Date()) {
  if (!definition || !Object.hasOwn(TEMPLATE_BY_KEY, definition.key)) {
    throw new ToolboxValidationError('不支持的工具');
  }
  const generatedAt = now.toISOString();
  return {
    inputSummary: summaryFor(definition.key, inputs),
    resultMd: TEMPLATE_BY_KEY[definition.key](inputs),
    assumptions: assumptionsFor(definition.key, inputs),
    evidence: evidenceFor(definition.key),
    provenance: {
      mode: 'template',
      sourceSystem: SOURCE_SYSTEM,
      promptVersion: PROMPT_VERSION,
      generatedAt,
      confidence: '待人工核验',
    },
  };
}

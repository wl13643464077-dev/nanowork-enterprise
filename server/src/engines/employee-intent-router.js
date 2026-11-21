// 餐饮数字员工·题型路由（PRD v2.2 FR-1）。
//
// 目的：老板一句话进来，先判断这是“快查 / 诊断 / 方案 / 产物 / 完整报告 / 协同”
// 哪一类，再决定答题形态（FR-3）和联网策略（FR-4）。以前所有问题都按岗位手册
// 的全部交付物出一份长报告，这是“公式化输出”的根因。
//
// 规则优先：纯函数、无 I/O、无模型调用，可在派活前同步执行并写入任务快照。
// 置信度低时可由调用方注入 modelClassifyFn 兜底（本文件不直接调用模型）。

export const INTENT_ROUTER_VERSION = "employee-intent-router/1";

export const INTENT_TYPES = Object.freeze([
  "lookup",
  "diagnose",
  "plan",
  "produce",
  "full_report",
  "team",
]);

export const INTENT_LABELS = Object.freeze({
  lookup: "快查",
  diagnose: "诊断",
  plan: "方案",
  produce: "产物",
  full_report: "完整报告",
  team: "协同",
});

// 预计耗时只用于前端提示，不参与计费。
export const INTENT_ETA_SECONDS = Object.freeze({
  lookup: 90,
  diagnose: 120,
  plan: 150,
  produce: 150,
  full_report: 300,
  team: 300,
});

const DEPARTMENT_DEFAULT_INTENTS = Object.freeze({
  战略与开店筹备部: ["lookup", "plan", "full_report"],
  菜单与产品研发部: ["diagnose", "plan", "produce"],
  食安与合规部: ["produce", "diagnose", "plan"],
  供应链与库存部: ["plan", "diagnose", "produce", "lookup"],
  门店运营部: ["produce", "plan", "diagnose"],
  品牌与增长部: ["plan", "produce", "diagnose"],
  财务与数据部: ["diagnose", "plan", "produce"],
  连锁与可持续部: ["diagnose", "plan", "produce"],
});

// 员工 idx → 分部（与 catalog/restaurant.json 一致；冗余一份避免路由依赖 I/O）。
const EMPLOYEE_DEPARTMENT = (() => {
  const ranges = [
    [101, 107, "战略与开店筹备部"],
    [108, 115, "菜单与产品研发部"],
    [116, 124, "食安与合规部"],
    [125, 131, "供应链与库存部"],
    [132, 139, "门店运营部"],
    [140, 146, "品牌与增长部"],
    [147, 154, "财务与数据部"],
    [155, 159, "连锁与可持续部"],
  ];
  const map = {};
  for (const [from, to, name] of ranges) {
    for (let idx = from; idx <= to; idx += 1) map[idx] = name;
  }
  map[160] = "门店运营部";
  map[161] = "门店运营部";
  return Object.freeze(map);
})();

// 在分部默认题型之外，按附录 C 与题库补充的员工专属题型。
const EMPLOYEE_EXTRA_INTENTS = Object.freeze({
  101: ["lookup", "plan", "full_report", "diagnose"],
  102: ["lookup", "diagnose", "full_report", "plan", "produce"],
  104: ["lookup", "plan", "full_report", "diagnose"],
  106: ["plan", "diagnose", "produce", "full_report"],
  107: ["produce", "plan"],
  108: ["diagnose", "plan", "produce"],
  124: ["diagnose", "produce", "plan"],
  137: ["produce", "plan"],
  144: ["diagnose", "plan", "produce"],
  151: ["diagnose", "plan", "produce"],
  160: ["plan", "lookup", "produce", "diagnose"],
  161: ["produce", "diagnose", "plan"],
});

export function departmentForEmployee(idx) {
  return EMPLOYEE_DEPARTMENT[Number(idx)] || null;
}

export function allowedIntentsForEmployee(idx) {
  const department = departmentForEmployee(idx);
  // 非餐饮岗位（内容生产仓等）以“产物”为首选。
  const base = department
    ? DEPARTMENT_DEFAULT_INTENTS[department]
    : ["produce", "plan", "diagnose", "lookup"];
  const extra = EMPLOYEE_EXTRA_INTENTS[Number(idx)] || [];
  const ordered = [...extra, ...base];
  // 完整报告永远允许“明确要求”时使用；这里只决定自动判题的候选范围。
  return [...new Set(ordered)];
}

// —— 判题信号 ——
// 每条：[正则, 权重]。同一题型命中多条累加。
const SIGNALS = Object.freeze({
  full_report: [
    [/完整(?:的)?(?:商圈|选址|可行性|分析|研究)?报告|正式报告|可行性(?:研究|报告|分析)|尽调|投资(?:人|方)看|给(?:合伙人|股东|投资人|董事会|银行)看|商业计划书|BP\b/u, 8],
    [/出一份.{0,12}(?:完整|全面|详细)(?:的)?(?:报告|分析)/u, 4],
    [/签(?:租约|合同)前|值不值得(?:投|签)/u, 2],
  ],
  lookup: [
    [/(?:是什么|是多少|什么范围|什么水平|有哪些|有几家|多少家|排名|榜单|行情)/u, 3],
    [/(?:都做了什么|都在做什么|别人怎么做|同行怎么做)/u, 4],
    [/查(?:一)?下|查查|了解(?:一)?下|摸(?:一下|清)|扫(?:一)?下/u, 2],
    [/(?:客单价|人均|价格带|价位)(?:是|在|大概|分布|范围)/u, 3],
    [/(?:规定|新规|政策|标准|要求|门槛)(?:是什么|有哪些|怎么规定)/u, 3],
    [/最近.{0,8}(?:趋势|新开|网红|火的|流行|热点)/u, 2],
    [/(?:帮我)?找(?:一下|找)?.{0,10}(?:供应商|热点|话题|案例|竞品|店)/u, 3],
    [/(?:市场热度|主要玩家|还有没有机会|有没有机会|竞争格局)/u, 4],
    // 实测原题：“我要看看周围有没有竞争对手 对手啥情况”
    [/(?:有没有|有哪些|有什么|有几个).{0,6}(?:竞争对手|对手|竞品)|对手(?:啥|什么)情况|周(?:围|边).{0,8}(?:竞争对手|对手|竞品)/u, 5],
  ],
  diagnose: [
    [/为什么|为啥|怎么回事|什么原因|原因是|哪里出(?:了)?问题|出在哪|根因/u, 4],
    [/(?:掉了|掉到|下滑|下降|变差|变少|下跌|走低|不行了|起不来|上不去|亏(?:了|损)|不赚钱|不对劲|异常|偏高|偏低|超标|太高|太低|被扣分|反复出现|老堵|卡住|上不齐|吃到)/u, 3],
    [/(?:诊断|体检|自查|排查|复查|是否通过|打分|评分并|指出问题|检查一下|有没有违规|哪里能优化|花哪儿)/u, 3],
    [/帮我(?:看看|看一下|分析|拆(?:一下)?|判断|评估|诊断|对比|检查|查)/u, 3],
    [/(?:哪些|哪个|哪家).{0,10}(?:该砍|该留|该提价|该主推|有问题|不赚钱|拖后腿|最多|卡住)/u, 3],
    [/(?:是不是|有没有).{0,12}(?:问题|违规|风险|踩线|偏高|偏低)/u, 2],
    [/(?:要不要|需不需要|算不算|适不适合).{0,12}(?:备案|存管|负债|违规|开)/u, 2],
    [/(?:能学什么|学到什么|夸什么|骂什么)/u, 3],
    [/(?:我们|我家|自家)(?:店|的).{0,40}(?:有没有空位|竞争有多|有多激烈|能不能打|有没有优势|定位对不对|贵不贵|便宜了)/u, 5],
    [/(?:复盘(?:原因|并)?|赚不赚钱|找出问题|(?:做|出)(?:一下|个)?.{0,10}(?:四象限)?分析)/u, 3],
  ],
  plan: [
    [/怎么(?:做|办|搞|弄|提升|提高|降低|安排|定价|设计|规划|调整|应对|处理|做好|谈)|如何/u, 3],
    [/帮我(?:设计|策划|规划|制定|精简|优化|重新设计|比较|判断值不值|估算|算(?:一下)?)/u, 4],
    [/(?:设计|策划|规划|制定)(?:一个|一套|一份)?.{0,12}(?:方案|计划|策略|打法|规划|体系|节奏|机制|规则|结构|菜单|活动|试点)/u, 3],
    [/(?:营销日历|内容计划|带教计划|现金流预测|排期|排(?:下周的)?班|整改方案|改进方案|准入要看|处理办法|爽约)/u, 3],
    // 实测原题：“帮我重做会员分层和沉睡顾客唤回方案”
    [/(?:重做|重新做|重新设计)(?:一[个套份])?.{0,16}方案/u, 3],
    [/想(?:做|搞|开|上|推|放开|用|把|接)/u, 1],
    [/(?:想|准备|打算)(?:做|搞|办)(?:个|一个|一场|一次)?.{0,10}活动/u, 5],
    [/(?:出|给)(?:一个|一套|\d档|个)?.{0,10}(?:方案|计划|调整方案|提升方案)/u, 3],
  ],
  produce: [
    [/(?:写|撰写|起草|生成|出|做|整理|列|编|倒排|设计)(?:一|几|\d+)?(?:份|个|套|篇|张|条|版|组|节)?.{0,24}(?:SOP|sop|清单|表格?|台账|文案|话术|考题|试题|海报|手册|模板|制度|流程|检查表|记录表|执行表|交接表|笔记|脚本|公告|通知|配方卡|成本卡|报价单|大纲|演示稿|选题|配图|封面|三张表|短视频|视频|预案|培训|套餐|标识|追溯办法|检查办法|抽检办法|分区)/u, 5],
    [/(?:出|做|写|倒排)一份.{0,16}(?:计划|复盘|草案|汇报)/u, 5],
    [/帮我(?:回复|改写|重写|换算|写|改得|整理成|把)/u, 4],
    [/把.{0,14}(?:改得|改成|整理成|写成|做成)/u, 4],
    [/(?:批量配方|菜名描述|给\d+个|做\d+个|设计\d+个|设计一组|设计一套每日|每天必须看的)/u, 3],
  ],
  team: [
    [/(?:组队|拉(?:上|个)?.{0,6}(?:团队|小组)|多个岗位|跨部门|让(?:大家|几个员工))/u, 6],
  ],
});

const HIGH_RISK_DECISION = /签(?:租约|合同)|(?:开|投)新店.{0,6}(?:投资|决策)|(?:投资|融资)(?:决策|评估)/u;

// —— 实体抽取 ——
const CITIES = Object.freeze([
  "北京", "上海", "广州", "深圳", "成都", "重庆", "杭州", "武汉", "西安", "南京",
  "天津", "苏州", "长沙", "郑州", "青岛", "沈阳", "宁波", "东莞", "无锡", "佛山",
  "合肥", "昆明", "大连", "福州", "厦门", "哈尔滨", "济南", "温州", "南宁", "长春",
  "泉州", "石家庄", "贵阳", "南昌", "金华", "常州", "南通", "嘉兴", "太原", "徐州",
  "惠州", "珠海", "中山", "台州", "烟台", "兰州", "绍兴", "海口", "扬州", "乌鲁木齐",
  "呼和浩特", "银川", "西宁", "拉萨", "三亚", "洛阳", "潍坊", "保定", "唐山", "临沂",
]);

const CATEGORY_RELATED = Object.freeze({
  火锅: ["烤肉", "串串", "冒菜", "韩餐"],
  烤肉: ["火锅", "烧烤", "韩餐", "日式烧肉"],
  烧烤: ["烤肉", "串串", "小龙虾", "夜宵"],
  串串: ["火锅", "冒菜", "麻辣烫", "烧烤"],
  冒菜: ["串串", "麻辣烫", "火锅", "川菜"],
  麻辣烫: ["冒菜", "米线", "串串", "快餐"],
  韩餐: ["烤肉", "日料", "火锅", "部队锅"],
  日料: ["韩餐", "寿司", "西餐", "烤肉"],
  西餐: ["日料", "意面", "牛排", "咖啡"],
  茶饮: ["咖啡", "甜品", "烘焙", "果汁"],
  咖啡: ["茶饮", "烘焙", "轻食", "甜品"],
  烘焙: ["咖啡", "甜品", "茶饮", "面包"],
  快餐: ["面馆", "米粉", "盖饭", "麻辣烫"],
  面馆: ["米粉", "快餐", "饺子", "麻辣烫"],
  米粉: ["面馆", "米线", "快餐", "螺蛳粉"],
  川菜: ["湘菜", "江湖菜", "火锅", "冒菜"],
  湘菜: ["川菜", "江西菜", "家常菜", "小炒"],
  粤菜: ["茶餐厅", "潮汕菜", "早茶", "海鲜"],
  东北菜: ["家常菜", "烧烤", "铁锅炖", "饺子"],
  小龙虾: ["烧烤", "夜宵", "海鲜", "湘菜"],
  自助: ["烤肉", "火锅", "海鲜", "西餐"],
  轻食: ["沙拉", "咖啡", "西餐", "健康餐"],
});
const CATEGORY_WORDS = Object.freeze(Object.keys(CATEGORY_RELATED));
// 老板常用的叫法 → 标准品类（实测：“广东菜 太原吾悦广场”原题识别不到品类）。
const CATEGORY_ALIASES = Object.freeze({
  广东菜: "粤菜", 粤式: "粤菜", 广式: "粤菜", 早茶: "粤菜", 茶餐厅: "粤菜",
  湖南菜: "湘菜", 四川菜: "川菜", 涮肉: "火锅", 串串香: "火锅",
});

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

export function extractIntentEntities(text = "") {
  const value = String(text || "");
  const city = CITIES.find((name) => value.includes(name)) || null;
  // 商圈/片区：只取 2–4 个汉字的地名，去掉城市前缀和动词，避免把“一份望京开店完整”当成商圈。
  const AREA_STOP = /[店份报告完整开做帮我们的在看查周边附近]|公里|千米|方圆|目标/u;
  const stripCity = (word) => (city && word.startsWith(city) ? word.slice(city.length) : word);
  const candidates = [];
  // 商场/广场/SOHO 这类地标保留完整名（“吾悦广场”而不是“吾悦”），检索更准。
  for (const match of value.matchAll(/([\u4e00-\u9fa5]{2,6})(广场|商场|购物中心|SOHO)/gu)) {
    const word = stripCity(match[1]).replace(/^(?:在|去|到)/u, "");
    if (word.length >= 2 && !AREA_STOP.test(word)) candidates.push(`${word.slice(-4)}${match[2]}`);
  }
  for (const match of value.matchAll(/([\u4e00-\u9fa5]{2,6})(?=商圈|片区|一带|附近|周边|SOHO|地区|区域|商场|广场)/gu)) {
    const word = stripCity(match[1]);
    for (let len = Math.min(4, word.length); len >= 2; len -= 1) candidates.push(word.slice(word.length - len));
  }
  for (const match of value.matchAll(/(?:在)?([\u4e00-\u9fa5]{2,5})(?=开店|开一家|开个|开家|开新店|做一家)/gu)) {
    const word = stripCity(match[1]).replace(/^在/u, "");
    for (let len = Math.min(3, word.length); len >= 2; len -= 1) candidates.push(word.slice(word.length - len));
  }
  if (city) {
    const afterCity = value.slice(value.indexOf(city) + city.length).match(/^([\u4e00-\u9fa5]{2,3})/u);
    if (afterCity) candidates.push(afterCity[1]);
  }
  const area = candidates.find((word) => word.length >= 2 && !AREA_STOP.test(word) && !CITIES.includes(word)) || null;
  const categories = uniq([
    ...Object.entries(CATEGORY_ALIASES).filter(([alias]) => value.includes(alias)).map(([, canonical]) => canonical),
    ...CATEGORY_WORDS.filter((word) => value.includes(word)),
  ]);
  const category = categories[0] || null;
  const related = category
    ? CATEGORY_RELATED[category].filter((item) => !categories.includes(item))
    : [];
  const priceMatch = value.match(/人均\s*(\d{1,4})(?:\s*[-~到至]\s*(\d{1,4}))?\s*元?/u);
  const storeCountMatch = value.match(/(\d{1,3})\s*(?:家|个)(?:门)?店/u);
  const periodMatch = value.match(/(?:近|最近|上|过去)\s*(\d{1,3})?\s*(天|周|个月|月|季度|年)/u);
  return {
    city,
    area: area || null,
    category,
    categories,
    related_categories: related,
    price_band: priceMatch
      ? priceMatch[2]
        ? `${priceMatch[1]}-${priceMatch[2]}`
        : priceMatch[1]
      : null,
    store_count: storeCountMatch ? Number(storeCountMatch[1]) : null,
    period: periodMatch ? periodMatch[0] : null,
  };
}

function scoreIntents(text) {
  const scores = Object.fromEntries(INTENT_TYPES.map((type) => [type, 0]));
  const hits = Object.fromEntries(INTENT_TYPES.map((type) => [type, []]));
  for (const [type, rules] of Object.entries(SIGNALS)) {
    for (const [pattern, weight] of rules) {
      const match = text.match(pattern);
      if (match) {
        scores[type] += weight;
        hits[type].push(match[0]);
      }
    }
  }
  return { scores, hits };
}

export function normalizeIntentType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "report" || raw === "full" || raw === "完整报告") return "full_report";
  if (INTENT_TYPES.includes(raw)) return raw;
  const byLabel = Object.entries(INTENT_LABELS).find(([, label]) => label === String(value || "").trim());
  return byLabel ? byLabel[0] : null;
}

function answerShapeFor(type, entities, employeeIdx) {
  if (type === "lookup") {
    const marketScan = Boolean(entities.area || entities.city) &&
      (Boolean(entities.category) || [101, 102, 104].includes(Number(employeeIdx)));
    return marketScan ? "lookup.market_scan" : "lookup.quick_fact";
  }
  if (type === "diagnose") return "diagnose.store_issue";
  if (type === "plan") return "plan.action_plan";
  if (type === "produce") return "produce.artifact";
  if (type === "team") return "team.squad";
  return "full_report.standard";
}

const PLAN_PARAMS = Object.freeze([
  { key: "budget", label: "预算", pattern: /预算|\d+\s*(?:元|万|块)/u, default: "按近一个月营业额的 3% 估算" },
  { key: "goal", label: "目标", pattern: /目标|提升|拉新|复购|翻台|客流|营业额|GMV|转化/u, default: "以提升到店客流为主目标" },
  { key: "time", label: "时间", pattern: /(?:\d{1,2}\s*月|周末|节|下周|本周|这周|下个月|假期|开业|日期|时段|晚市|午市)/u, default: "按最近一个可执行的周末/节点" },
]);

function missingBusinessParams(type, text) {
  if (!["plan", "produce", "full_report"].includes(type)) return [];
  if (type !== "plan") return [];
  return PLAN_PARAMS.filter((param) => !param.pattern.test(text)).map(({ key, label, default: fallback }) => ({
    key,
    label,
    default: fallback,
  }));
}

/**
 * 判题。
 * @param {object} input
 * @param {number} [input.employeeIdx]
 * @param {string} [input.title]
 * @param {string} [input.requirement]
 * @param {number} [input.attachmentCount]
 * @param {string} [input.requestedType] 前端/老板手动指定（如“升级为完整报告”）
 */
export function classifyEmployeeIntent({
  employeeIdx = null,
  title = "",
  requirement = "",
  attachmentCount = 0,
  requestedType = null,
} = {}) {
  const text = `${String(title || "")}\n${String(requirement || "")}`.trim();
  const entities = extractIntentEntities(text);
  const allowed = allowedIntentsForEmployee(employeeIdx);
  const requested = normalizeIntentType(requestedType);
  if (requested) {
    return finalize({
      type: requested,
      confidence: 1,
      source: "user_selected",
      reason: `老板手动选择【${INTENT_LABELS[requested]}】`,
      entities,
      allowed,
      employeeIdx,
      text,
      outOfScope: requested !== "full_report" && !allowed.includes(requested),
    });
  }

  const { scores, hits } = scoreIntents(text);
  if (HIGH_RISK_DECISION.test(text)) scores.full_report += 2;
  // 带附件的“为什么/怎么样”多半是看自家数据。
  if (attachmentCount > 0 && scores.lookup > 0 && scores.diagnose > 0) scores.diagnose += 1;
  // 产物信号与方案信号同时命中：“帮我出一份活动SOP”应是产物。
  if (scores.produce >= 5 && scores.plan > 0 && scores.plan < 4) scores.plan -= 1;
  // 有具体问题现象时，“出整改方案”是诊断；“帮我看看”配上“怎么改”同样以诊断为主。
  if (scores.diagnose >= 6 && scores.plan > 0) scores.diagnose += 1;

  const ranked = INTENT_TYPES.map((type) => ({ type, score: scores[type] }))
    .sort((a, b) => b.score - a.score || allowed.indexOf(a.type) - allowed.indexOf(b.type));
  let top = ranked[0];
  const second = ranked[1];
  let source = "rules";
  if (top.score <= 0) {
    // 没有任何信号：用岗位的首选题型。
    top = { type: allowed[0] || "plan", score: 0 };
    source = "employee_default";
  }
  let confidence = top.score <= 0
    ? 0.5
    : Math.min(0.98, 0.55 + (top.score - Math.max(0, second?.score || 0)) * 0.08 + Math.min(top.score, 8) * 0.03);

  let type = top.type;
  let outOfScope = false;
  if (type !== "full_report" && type !== "team" && !allowed.includes(type)) {
    outOfScope = true;
    // 本岗位不擅长该题型：在岗位允许题型里取得分最高的，保留“建议换人”标记。
    const fallback = ranked.find((item) => allowed.includes(item.type) && item.score > 0);
    type = fallback ? fallback.type : allowed[0];
    confidence = Math.min(confidence, 0.6);
  }
  const signalWords = uniq([...(hits[type] || []), ...(hits[top.type] || [])]).slice(0, 4);
  return finalize({
    type,
    confidence: Number(confidence.toFixed(2)),
    source,
    reason: signalWords.length
      ? `命中“${signalWords.join("”“")}”，按【${INTENT_LABELS[type]}】回答`
      : `没有明显句式信号，按岗位首选题型【${INTENT_LABELS[type]}】回答`,
    entities,
    allowed,
    employeeIdx,
    text,
    outOfScope,
  });
}

function finalize({ type, confidence, source, reason, entities, allowed, employeeIdx, text, outOfScope }) {
  return {
    version: INTENT_ROUTER_VERSION,
    type,
    label: INTENT_LABELS[type],
    confidence,
    source,
    entities,
    missing_business_params: missingBusinessParams(type, text),
    answer_shape: answerShapeFor(type, entities, employeeIdx),
    allowed_types: allowed,
    out_of_scope: Boolean(outOfScope),
    eta_seconds: INTENT_ETA_SECONDS[type],
    reason,
  };
}

/**
 * 按题型决定是否把公开信息调研作为“硬性前置”（FR-4：按题型放宽）。
 * - 快查、完整报告：仍要求形成可核验公开来源。
 * - 诊断：老板给了自家数据（附件）时以自有数据为准，联网只作补充。
 * - 方案、产物、协同：联网尽力而为，失败不再让整单失败。
 */
export function intentRequiresPublicResearch(intent, { attachmentCount = 0 } = {}) {
  const type = normalizeIntentType(intent?.type || intent) || "full_report";
  if (type === "lookup" || type === "full_report") return true;
  if (type === "diagnose") return attachmentCount === 0;
  return false;
}

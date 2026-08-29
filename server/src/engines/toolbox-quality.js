// 经营工具箱交付质检：判定 Markdown 交付是否达到「老板可直接使用」标准。
// 该模块被两处共用：
// 1. engines/toolbox.js 生成循环 —— 首轮产出缺项时把缺项定向反馈给模型返工；
// 2. routes/toolbox.js 最终验收 —— 交付契约的质量门（与账务判定配合）。
// 抽出独立模块保证两处口径完全一致，不会出现“生成时过检、验收时翻车”。

function resultText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .trim();
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

const EMPTY_SHELL_OUTPUT =
  /(?:仅供占位|占位(?:内容|文本|方案)?|具体(?:内容|方案|动作)?(?:以后|后续)再说|(?:暂无|没有|无)(?:明确)?(?:负责人|责任人|时间|时点|明细|口径|动作|产出)|认真思考|持续优化|加强管理|做好工作|提升水平)/u;
const ACTION_VERB =
  /(?:拍摄|发布|核验|记录|审核|整理|联系|收集|对比|制作|确认|复盘|跟进|安排|输出|填写|更新|观察|监测|剪辑|撰写|筛选|导出|搜索|检索|汇总|编码|设计|核对|核查|统计)/u;
const OUTPUT_EVIDENCE =
  /(?:素材|选题|文案|画面|数据|咨询|反馈|链接|截图|清单|表格|指标|记录|标题|口播|日历|版本|名单|证据|报告|台账|文件)/u;
const CONCRETE_ACTION_OBJECT =
  /(?:当天可售|价格|接待|门头|出品|环境|顾客|咨询|到店|画面|字幕|镜头|脚本|原稿|文案|竞品|套餐|会员|日历|日期|账号|渠道|来源|链接|菜品|产品|汤底|素材|库存|营业|投放|评论|私信|数据|统计|评分|评价|表|主题|方法|证据)/u;
const GENERIC_ACTION =
  /^(?:整理|记录|审核|确认|更新|输出|推进|完成)(?:选题|内容|资料|记录|工作|方案)?(?:并记录)?[。.]?$/u;
const GENERIC_OUTPUT = /^(?:选题|内容|工作|资料|执行|审核|完成)?记录[。.]?$/u;
const HOT_TOPIC_OBJECT =
  /(?:门头|出品|环境|顾客|咨询|到店|菜品|产品|套餐|汤底|会员|评论|私信|后厨|厨师|食材|价格|库存|营业|高频问题|制作过程)/u;
const OWNER_ROLE =
  /(?:负责人|店长|运营|运营专员|运营主管|门店运营部|门店负责人|调研|调查|员工|主管|经理|拍摄|剪辑|文案|审核|客服|销售|厨师|采购|财务|老板)/u;
const TIME_MARKER =
  /(?:今日|当天|明日|本周|下周|本月|第\s*\d+\s*天|发布前|发布后|小时|分钟|日|周|月|上午|下午|晚市|午市|开店前|闭店后|截止|完成前|完成后|\d{1,2}[：:]\d{2}|\d{4}-\d{2}-\d{2})/u;

function normalizedText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[，。；：、（）()【】\[\]“”‘’'"\-—_\s]/gu, "");
}

function expectedTextMatches(text, expected) {
  const wanted = normalizedText(expected);
  if (!wanted) return true;
  const actual = normalizedText(text);
  if (actual.includes(wanted)) return true;
  const anchors = String(expected)
    .split(/[^\p{L}\p{N}]+/u)
    .map((item) => normalizedText(item))
    .filter((item) => item.length >= 2);
  if (anchors.length < 2) return false;
  const matched = anchors.filter((item) => actual.includes(item)).length;
  return matched >= Math.min(3, anchors.length);
}

function markdownCells(line) {
  return String(line || "")
    .trim()
    .replace(/^\||\|$/gu, "")
    .split("|")
    .map((cell) => cell.trim());
}

function responsibilityTableValid(text) {
  const scheduleLines = String(text || "").split("\n");
  for (let index = 0; index < scheduleLines.length; index += 1) {
    if (!scheduleLines[index].trim().startsWith("|")) continue;
    const headers = markdownCells(scheduleLines[index]);
    const ownerIndex = headers.findIndex((cell) =>
      /负责人|责任人|角色/u.test(cell),
    );
    const timeIndex = headers.findIndex((cell) =>
      /时点|时间|日期|周期|截止/u.test(cell),
    );
    const actionIndex = headers.findIndex((cell) =>
      /动作|任务|执行/u.test(cell),
    );
    const outputIndex = headers.findIndex((cell) =>
      /验收|产出|证据|交付/u.test(cell),
    );
    if (
      [ownerIndex, timeIndex, actionIndex, outputIndex].some(
        (value) => value < 0,
      )
    )
      continue;
    const rows = [];
    for (
      let cursor = index + 1;
      cursor < scheduleLines.length && scheduleLines[cursor].trim().startsWith("|");
      cursor += 1
    ) {
      const cells = markdownCells(scheduleLines[cursor]);
      if (cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) continue;
      rows.push(cells);
    }
    const complete = rows.filter((cells) => {
      const owner = cells[ownerIndex] || "";
      const timing = cells[timeIndex] || "";
      const action = cells[actionIndex] || "";
      const output = cells[outputIndex] || "";
      return (
        OWNER_ROLE.test(owner) &&
        TIME_MARKER.test(timing) &&
        action.length >= 6 &&
        ACTION_VERB.test(action) &&
        CONCRETE_ACTION_OBJECT.test(action) &&
        !GENERIC_ACTION.test(action) &&
        output.length >= 4 &&
        OUTPUT_EVIDENCE.test(output) &&
        !GENERIC_OUTPUT.test(output) &&
        !EMPTY_SHELL_OUTPUT.test([owner, timing, action, output].join(" "))
      );
    });
    if (complete.length >= 3) return true;
  }
  // 冷启动/内容日历类工具通常交付“日期-动作-指标”执行日历，而不是
  // 单独的负责人表。只在表头明确且至少三行具备具体动作与记录指标时接受，
  // 不会把普通说明表误当成执行责任表。
  const calendarLines = String(text || "").split("\n");
  for (let index = 0; index < calendarLines.length; index += 1) {
    if (!calendarLines[index].trim().startsWith("|")) continue;
    const headers = markdownCells(calendarLines[index]);
    const dateIndex = headers.findIndex((cell) => /日期|时间|阶段|周期/u.test(cell));
    const actionIndex = headers.findIndex((cell) => /动作|任务|执行|安排/u.test(cell));
    const metricIndex = headers.findIndex((cell) => /指标|记录|产出|验收|证据/u.test(cell));
    if ([dateIndex, actionIndex, metricIndex].some((value) => value < 0)) continue;
    const rows = [];
    for (let cursor = index + 1; cursor < calendarLines.length && calendarLines[cursor].trim().startsWith("|"); cursor += 1) {
      const cells = markdownCells(calendarLines[cursor]);
      if (!cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) rows.push(cells);
    }
    const complete = rows.filter((cells) => {
      const date = cells[dateIndex] || "";
      const action = cells[actionIndex] || "";
      const metric = cells[metricIndex] || "";
      return TIME_MARKER.test(date) && action.length >= 10 && ACTION_VERB.test(action) && CONCRETE_ACTION_OBJECT.test(action) && metric.length >= 3 && OUTPUT_EVIDENCE.test(metric);
    });
    if (complete.length >= 3) return true;
  }
  return false;
}

export function toolboxResultQuality(
  toolKey,
  inputs,
  resultMd,
  { strictActions = false } = {},
) {
  const text = resultText(resultMd);
  const errors = [];
  const headingCount = countMatches(text, /^#{1,4}\s+\S+/gmu);
  const actionCount = countMatches(
    text,
    /^(?:\s*[-*+]\s+|\s*\d+[.)、]\s+|\s*\|[^\n]+\|)/gmu,
  );
  if (text.length < 180) errors.push("产物正文不足180字，未形成完整工作成果");
  if (headingCount < 2) errors.push("产物至少需要2个清晰章节");
  if (actionCount < 3) errors.push("产物至少需要3条可执行动作或结构化表格行");
  if (strictActions && EMPTY_SHELL_OUTPUT.test(text)) {
    errors.push("产物包含占位或“持续优化”等不可验收空话");
  }
  if (strictActions && !responsibilityTableValid(text)) {
    errors.push(
      "产物必须包含至少3行完整执行责任表，每行具备负责人、时点、具体动作和可核验产出",
    );
  }

  const rules = {
    hot: [
      [String(inputs.store || ""), "产物未落到指定门店/品类"],
      [["选题", "内容", "发布"], "缺少可发布的内容安排"],
      [["素材", "镜头", "画面"], "缺少现场素材安排"],
      [["核验", "审核", "确认"], "缺少发布前事实核验"],
    ],
    remix: [
      [String(inputs.goal || ""), "产物未回应成片目的"],
      [["镜头", "画面", "素材"], "缺少镜头或素材编排"],
      [["秒", "时段", "时间轴"], "缺少成片时间结构"],
      [["字幕", "口播", "剪辑"], "缺少字幕/口播/剪辑指令"],
    ],
    pcal: [
      [String(inputs.month || ""), "产物未对应计划月份"],
      [["日期", "日历", "第1周", "第一周"], "缺少按日期或周次安排的日历结构"],
      [["主题", "选题", "内容"], "缺少内容主题"],
      [["复盘", "指标", "数据"], "缺少周期复盘口径"],
    ],
    bench: [
      [
        String(inputs.targets || "")
          .split(/\r?\n/u)[0]
          ?.trim(),
        "产物未覆盖首个对标对象",
      ],
      [["证据", "来源", "链接", "截图"], "缺少竞品事实来源要求"],
      [["价格", "产品", "口碑", "活动"], "缺少竞品观察维度"],
      [["判断", "结论", "行动"], "缺少对比后的经营动作"],
    ],
    warm: [
      [String(inputs.positioning || ""), "产物未回应门店定位"],
      [["30天", "30 天", "第1天", "第一周"], "缺少30天冷启动节奏"],
      [["内容支柱", "选题", "主题"], "缺少稳定内容方向"],
      [["复盘", "指标", "完播", "咨询"], "缺少验证与复盘口径"],
    ],
    leads: [
      [String(inputs.city || ""), "产物未落到指定城市/商圈"],
      [String(inputs.product || ""), "产物未落到指定产品"],
      [["信号", "线索", "需求"], "缺少线索识别规则"],
      [["来源", "证据", "核验"], "缺少公开来源与人工核验"],
      [["跟进", "动作", "联系"], "缺少后续跟进动作"],
    ],
    shot: [
      [String(inputs.product || ""), "产物未落到指定产品/套餐"],
      [["卖点", "事实", "证据"], "缺少可核验卖点"],
      [["标题", "文案", "描述"], "缺少渠道文案"],
      [["主图", "配图", "镜头", "拍摄"], "缺少视觉制作清单"],
    ],
    "menu-copy": [
      [["识别结果", "菜品", "产品"], "缺少图片中产品的识别结果"],
      [["一句话卖点", "卖点"], "缺少一句话卖点"],
      [["详情页描述", "菜品描述", "描述"], "缺少外卖/详情页描述"],
      [["小红书", "种草文案"], "缺少小红书文案"],
      [["价格话术", "建议售价话术"], "缺少价格话术"],
    ],
    "link-script": [
      [String(inputs.url || ""), "产物未保留原始公开链接"],
      [["开头3秒", "开头 3 秒", "钩子"], "缺少开头3秒钩子"],
      [["完整口播稿", "口播正文"], "缺少完整口播正文"],
      [["核心信息点", "核心点"], "缺少来源核心信息点"],
      [["互动结尾", "行动指令"], "缺少互动结尾"],
      [["来源", "正文快照"], "缺少原链接来源证据"],
    ],
    vars: [
      [["方案", "版本"], "缺少多套口播结构"],
      [["开头", "钩子"], "缺少差异化开头"],
      [["口播", "原稿", "事实"], "缺少原稿事实保持说明"],
      [["镜头", "画面", "拍摄"], "缺少配套镜头指令"],
    ],
  };
  for (const [expected, message] of rules[toolKey] || []) {
    const ok = Array.isArray(expected)
      ? includesAny(text, expected.filter(Boolean))
      : !expected || expectedTextMatches(text, expected);
    if (!ok) errors.push(message);
  }
  if (toolKey === "pcal") {
    const scheduleMarkers = countMatches(
      text,
      /(?:\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日|第\s*\d+\s*(?:天|周))/gu,
    );
    if (scheduleMarkers < 7)
      errors.push("内容日历至少需要7个明确日期/日次安排");
  }
  if (toolKey === "vars") {
    const expected = Number(inputs.variants || 3);
    const variants = new Set(
      [...text.matchAll(/(?:方案|版本)\s*([一二三四五六1-6])/gu)].map(
        (match) => match[1],
      ),
    );
    if (variants.size < expected)
      errors.push(`口播方案不足，要求${expected}套`);
  }
  if (strictActions && toolKey === "hot") {
    const candidates = [
      ...text.matchAll(
        /^\s*(?:\d+[.)、]\s*)?选题\s*([一二三四五六七八九十\d]+)\s*[：:]\s*(.+)$/gmu,
      ),
    ].map((match) => ({ id: match[1], body: match[2].trim() }));
    // 模型常用 Markdown 表格表达选题；表格行也属于可验收选题，不应被
    // 仅匹配“选题一：”的旧规则误判为空。
    for (const line of text.split("\n")) {
      if (!line.trim().startsWith("|")) continue;
      const cells = markdownCells(line);
      if (
        cells.length < 3 ||
        cells.every((cell) => /^:?-{3,}:?$/u.test(cell))
      )
        continue;
      const joined = cells.join(" ");
      if (/(?:选题|内容动作|题材|素材对象)/u.test(joined)) {
        const body = cells.slice(1, 4).filter(Boolean).join(" ");
        if (body.length >= 18)
          candidates.push({ id: String(candidates.length + 1), body });
      }
    }
    const distinct = new Set(
      candidates.map((item) => item.body.replace(/[\s，。；、]/gu, "")),
    );
    const substantive = candidates.filter(
      (item) =>
        item.body.length >= 18 &&
        ACTION_VERB.test(item.body) &&
        CONCRETE_ACTION_OBJECT.test(item.body) &&
        HOT_TOPIC_OBJECT.test(item.body),
    );
    if (candidates.length < 3 || distinct.size < 3 || substantive.length < 3) {
      errors.push(
        "今日必发至少需要3个互异的具体选题，每条写明内容动作和实际题材/素材对象",
      );
    }
    for (const channel of Array.isArray(inputs.channels)
      ? inputs.channels
      : []) {
      if (channel && !text.includes(String(channel)))
        errors.push(`产物未覆盖指定渠道：${channel}`);
    }
    const focusAnchors = String(inputs.focus || "")
      .split(/[，,；;。\s]+/u)
      .map((item) =>
        item
          .trim()
          .replace(/^(?:提升|验证|围绕|聚焦|促进|增加|减少|不做|避免)/u, ""),
      )
      .filter((item) => item.length >= 4);
    if (
      focusAnchors.length &&
      !focusAnchors.some((anchor) => text.includes(anchor))
    ) {
      errors.push("候选内容未回应本次运营重点");
    }
  }
  return { valid: errors.length === 0, errors };
}

// 把质检缺项转成模型可执行的定向返工指令；只指出缺什么，不放宽事实边界。
export function toolboxQualityReworkInstruction(errors) {
  const issues = (Array.isArray(errors) ? errors : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 12);
  return [
    "",
    "【定向返工·质检缺项】",
    "上一轮草案整体方向可用，但以下缺项会导致验收失败：",
    ...issues.map((item) => `- ${item}`),
    "请从头输出一份补齐上述全部缺项的完整交付草案；保持原有真实内容与全部硬性边界不变。",
    "缺失的事实仍必须标注「待补充」或「待人工核验」，禁止为通过质检编造数据、案例或效果。",
  ].join("\n");
}

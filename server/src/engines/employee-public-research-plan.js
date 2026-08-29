const LANE_DEFINITIONS = Object.freeze([
  {
    key: "amap",
    label: "高德地图/扫街榜",
    match: /(高德|扫街榜|amap)/iu,
    query: (task) => `${task} 高德地图 扫街榜 门店`,
  },
  {
    key: "dianping",
    label: "大众点评商户页",
    match: /(大众点评|点评平台|dianping)/iu,
    query: (task) => `${task} site:dianping.com 门店 菜单 人均 评价`,
  },
  {
    key: "meituan",
    label: "美团餐饮商户页",
    match: /(美团|外卖平台|meituan)/iu,
    query: (task) => `${task} site:meituan.com 餐厅 菜单 营业时间`,
  },
  {
    key: "canyandata",
    label: "窄门餐眼",
    match: /(窄门|餐眼|canyandata)/iu,
    query: (task) => `${task} site:canyandata.com 品牌 门店分布 竞品`,
  },
  {
    key: "isochrone",
    label: "真实路网等时圈",
    match: /(等时圈|驾车时圈|路网|Huff)/iu,
    query: (task) => `${task} 地图 步行 驾车 公共交通 可达性`,
  },
  {
    key: "douyin",
    label: "抖音/本地生活公开信息",
    match: /(抖音|本地生活|douyin|tiktok)/iu,
    query: (task) => `${task} 抖音 本地生活 餐饮 官方 规则 案例`,
  },
  {
    key: "xiaohongshu",
    label: "小红书公开笔记/规则",
    match: /(小红书|xiaohongshu)/iu,
    query: (task) => `${task} 小红书 餐饮 笔记 官方 规则`,
  },
  {
    key: "delivery_platform",
    label: "外卖/到店平台公开规则",
    match: /(饿了么|京东外卖|DoorDash|Uber Eats|外卖平台)/iu,
    query: (task) => `${task} 外卖 到店 平台官方 规则 佣金 运营`,
  },
  {
    key: "official_authority",
    label: "政府/标准/权威机构原文",
    match:
      /(国家标准|市场监管|食品安全|法规|许可证|消防|HACCP|FDA|GB\/?T|ISO\s?\d+)/iu,
    query: (task) =>
      `${task} site:gov.cn OR site:samr.gov.cn 官方 标准 法规 原文`,
  },
  {
    key: "company_registry",
    label: "企业资质/供应商背调",
    match: /(企查查|天眼查|qcc|tianyancha|供应商背调)/iu,
    query: (task) => `${task} 企业资质 行政许可 经营异常 公开信息`,
  },
]);

function clean(value, max = 180) {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function publicSkillText(skill) {
  // detail/instructions 仅用于服务端判定该技能要走哪条公开取证车道；
  // 返回计划不携带这些私有执行细节，联网 query 也只用固定模板。
  return [
    skill?.title,
    skill?.source,
    skill?.sourceUrl,
    skill?.detail,
    skill?.instructions,
  ]
    .map((value) => clean(value, 300))
    .filter(Boolean)
    .join(" ");
}

function publicTaskText(task) {
  // task title 常由 requirement 截断生成（例如数据库 title 只保留前100字）。
  // requirement 已完整包含该标题时直接使用 requirement，避免每条公开查询
  // 都出现两遍相同长前缀；仅使用这两个公开任务字段，不展开其余私有元数据。
  const title = clean(task?.title, 240);
  const requirement = clean(task?.requirement, 240);
  if (!requirement) return title;
  if (!title || requirement.includes(title)) return requirement;
  return clean(`${title} ${requirement}`, 240);
}

export function compileEmployeePublicResearchPlan(
  employeeExecution,
  task = {},
) {
  const identity = employeeExecution?.workbench?.identity || {};
  const skills = Array.isArray(employeeExecution?.snapshot?.skills)
    ? employeeExecution.snapshot.skills
    : Array.isArray(employeeExecution?.workbench?.skillLibrary?.enabled)
      ? employeeExecution.workbench.skillLibrary.enabled
      : [];
  const taskText = publicTaskText(task);
  const matched = [];
  for (const lane of LANE_DEFINITIONS) {
    const sourceSkills = skills.filter((skill) =>
      lane.match.test(publicSkillText(skill)),
    );
    if (!sourceSkills.length) continue;
    matched.push({
      key: lane.key,
      label: lane.label,
      query: lane.query(taskText || "餐饮商圈竞品"),
      sourceSkillIds: sourceSkills.map((skill) => clean(skill?.id, 120)),
      sourceSkillTitles: sourceSkills.map((skill) => clean(skill?.title, 80)),
    });
  }

  const topicSkills = skills
    .filter((skill) => skill?.required !== true)
    .slice(0, 3);
  if (topicSkills.length) {
    const titles = topicSkills.map((skill) => clean(skill?.title, 50));
    matched.push({
      key: "employee_skill_topics",
      label: "当前岗位技能主题复核",
      query: `${taskText || "餐饮经营任务"} ${titles.join(" ")} 当前 官方 可核验来源`,
      sourceSkillIds: topicSkills.map((skill) => clean(skill?.id, 120)),
      sourceSkillTitles: titles,
    });
  }

  // 官方/商场/具体商户正文是商圈岗位的必备证据，不依赖历史
  // 技能是否恰好写出这个字样；但它仍然只是公开取证顺序，不伪装成API。
  matched.push({
    key: "official_business",
    label: "品牌/商场官方与具体商户正文",
    query: `${taskText || "餐饮商圈竞品"} 品牌官网 商场官方 餐厅门店 菜单`,
    sourceSkillIds: [],
    sourceSkillTitles: [],
  });

  const allLanes = [
    ...new Map(matched.map((lane) => [lane.key, lane])).values(),
  ];
  const officialLane = allLanes.find(
    (lane) => lane.key === "official_business",
  );
  const deduped = [
    ...allLanes.filter((lane) => lane.key !== "official_business").slice(0, 9),
    ...(officialLane ? [officialLane] : []),
  ];
  return {
    schemaVersion: "nanowork.employee-public-research-plan/1",
    employeeIdx: Number(identity.idx || 0) || null,
    employeeName: clean(identity.name || identity.title, 80) || null,
    mode: "skill_guided_web_research",
    // 对外仅记录技能ID/名称与公开取证车道，不持久化私有提示词或搜索原始响应。
    skillCount: skills.length,
    lanes: deduped,
    queries: deduped.map((lane) => lane.query),
    apiClaims: [],
  };
}

import crypto from "node:crypto";
import zlib from "node:zlib";

const FORBIDDEN_PROVIDER =
  /(?:mock|template|fallback|fixture|offline|no[-_ ]?network)/iu;
const SECRET_KEY =
  /^(?:authorization|password|passwd|api[_-]?key|secret|access[_-]?token|refresh[_-]?token|id[_-]?token|session(?:[_-]?token)?|cookie|credential|private[_-]?key|client[_-]?secret|b64|response[_-]?body|request[_-]?body|raw[_-]?(?:body|response|request))$/iu;
const SECRET_VALUE =
  /(?:\bsk-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}\b|\b(?:eyJ[A-Za-z0-9_-]{8,})\.(?:[A-Za-z0-9_-]{8,})\.(?:[A-Za-z0-9_-]{8,})\b|\b(?:access_token|refresh_token|id_token|api[_-]?key|client[_-]?secret|password|passwd|cookie|credential)\s*[:=]\s*[^\s,;]+\b)/giu;

export const REAL_FEATURE_MATRIX_SCHEMA = "nanowork.real-feature-matrix.v8";
export const LEGACY_REAL_FEATURE_MATRIX_SCHEMAS = Object.freeze([
  "nanowork.real-feature-matrix.v7",
  "nanowork.real-feature-matrix.v6",
  "nanowork.real-feature-matrix.v5",
  "nanowork.real-feature-matrix.v4",
]);
export const ADVISOR_MODULE_PERMISSION_ERROR =
  "当前账号没有该模块权限，请联系企业老板或管理员在角色与权限中开通";
export const AUTHORIZATION_BOUNDARY_KEYS = Object.freeze([
  "advisor:manager:standard",
  "advisor:employee:standard",
  "marshal-chat:employee:forbidden",
  "marshal-skill-file:employee:forbidden",
  "marshal-task:employee:forbidden",
]);
const AUTHORIZATION_BOUNDARY_KEY_SET = new Set(AUTHORIZATION_BOUNDARY_KEYS);
const MATRIX_ROLE_LANES = Object.freeze({
  boss: Object.freeze(["boss"]),
  manager: Object.freeze(["ops_director", "manager"]),
  employee: Object.freeze(["sales", "partner"]),
});

export function roleMatchesMatrixLane(lane, actualRole) {
  return MATRIX_ROLE_LANES[lane]?.includes(String(actualRole || "")) === true;
}

export function advisorFlowReadbackValid(payload, expectedTaskIds = []) {
  const expected = [
    ...new Set(
      expectedTaskIds
        .map(Number)
        .filter((id) => Number.isSafeInteger(id) && id > 0),
    ),
  ];
  if (payload?.hasDownstream !== true || expected.length === 0) return false;
  const persisted = new Set(
    (Array.isArray(payload?.nodes) ? payload.nodes : [])
      .filter((item) => item?.kind === "manual_task")
      .map((item) =>
        Number(String(item?.id || "").replace(/^manual-task:/u, "")),
      )
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
  return expected.every((id) => persisted.has(id));
}

function artifactSize(metadata) {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return Number(metadata.size) || 0;
  }
  try {
    return Number(JSON.parse(String(metadata || "{}"))?.size) || 0;
  } catch {
    return 0;
  }
}

export function artifactReadbackEvidence(
  rows,
  {
    ids = [],
    formats = [],
    sourceType = null,
    sourceId = null,
    fileUrlPrefix = "/uploads/artifacts/",
  } = {},
) {
  const wantedIds = ids
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  const wantedFormats = formats.map(String).filter(Boolean);
  const list = Array.isArray(rows) ? rows : [];
  const matched = wantedIds
    .map((id) => list.find((item) => Number(item?.id) === id))
    .filter(Boolean);
  const observedFormats = new Set(
    matched.map((item) => String(item?.format || "")).filter(Boolean),
  );
  const persisted =
    wantedIds.length === wantedFormats.length &&
    new Set(wantedIds).size === wantedIds.length &&
    matched.length === wantedIds.length;
  const lineageValid =
    persisted &&
    matched.every(
      (item) =>
        (sourceType == null ||
          String(item?.source_type || "") === String(sourceType)) &&
        (sourceId == null || Number(item?.source_id) === Number(sourceId)),
    );
  const terminalValid =
    persisted &&
    matched.every(
      (item) =>
        String(item?.file_url || "").startsWith(String(fileUrlPrefix || "")) &&
        artifactSize(item?.metadata) > 0 &&
        item?.status === "可用",
    );
  const contractValid =
    persisted &&
    observedFormats.size === wantedFormats.length &&
    wantedFormats.every((format) => observedFormats.has(format));
  return { persisted, lineageValid, terminalValid, contractValid, matched };
}

export function parseSseEvents(value) {
  const source = String(value || "");
  const events = [];
  const errors = [];
  for (const block of source.split(/\r?\n\r?\n/gu)) {
    const data = block
      .split(/\r?\n/gu)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        events.push(parsed);
      else errors.push("SSE data不是JSON对象");
    } catch {
      errors.push(`SSE data不是合法JSON：${data.slice(0, 80)}`);
    }
  }
  const doneEvent =
    [...events].reverse().find((event) => event.done === true) || null;
  const deltaText = events
    .map((event) => (typeof event.delta === "string" ? event.delta : ""))
    .join("");
  return {
    events,
    reset: events.some((event) => event.reset === true),
    done: Boolean(doneEvent),
    doneEvent,
    deltaText,
    errors,
    valid:
      events.length > 0 &&
      Boolean(doneEvent) &&
      deltaText.length > 0 &&
      errors.length === 0,
  };
}

export function restaurantTaskFlowReadback(payload, taskId) {
  const id = Number(taskId);
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  const links = Array.isArray(payload?.links) ? payload.links : [];
  const taskNode =
    nodes.find(
      (item) =>
        item?.kind === "restaurant_task" &&
        String(item?.id || "") === `restaurant-task:${id}`,
    ) || null;
  const billingNode =
    nodes.find(
      (item) =>
        item?.kind === "billing" &&
        /^billing:\d+$/u.test(String(item?.id || "")),
    ) || null;
  const outputNode = nodes.find((item) => item?.kind === "content") || null;
  const holdId = Number(
    String(billingNode?.id || "").replace(/^billing:/u, ""),
  );
  const billingSettled = /积分已结算/u.test(
    String(billingNode?.status || billingNode?.label || ""),
  );
  const billingLinked = links.some(
    (item) =>
      item?.from === taskNode?.id &&
      item?.to === billingNode?.id &&
      item?.relation === "billing",
  );
  const outputLinked = links.some(
    (item) =>
      item?.from === taskNode?.id &&
      item?.to === outputNode?.id &&
      item?.relation === "produced",
  );
  return {
    taskPersisted: Boolean(taskNode),
    outputPersisted: Boolean(outputNode),
    billingPersisted: Boolean(billingNode),
    billingSettled,
    billingLinked,
    outputLinked,
    holdId: Number.isSafeInteger(holdId) && holdId > 0 ? holdId : null,
    valid:
      Boolean(taskNode) &&
      Boolean(outputNode) &&
      billingSettled &&
      billingLinked &&
      outputLinked &&
      Number.isSafeInteger(holdId) &&
      holdId > 0,
  };
}

export const TOOLBOX_CASES = Object.freeze({
  hot: Object.freeze({
    employeeIdx: 141,
    title: "今日必发真实验收",
    inputs: Object.freeze({
      store: "纳米Work验收门店A（仅验收数据集）",
      channels: Object.freeze(["微信公众号", "小红书"]),
      focus: "围绕已核实的招牌菜制作今日内容，价格、库存和优惠均保留待确认。",
    }),
  }),
  remix: Object.freeze({
    employeeIdx: 140,
    title: "视频混剪方案真实验收",
    inputs: Object.freeze({
      materials:
        "已有门头、后厨备餐、招牌菜成品和老板口播四类自有素材；顾客肖像与音乐授权尚待负责人确认。",
      platform: "视频号",
      goal: "生成可交给剪辑人员执行的分镜、字幕和素材核验清单，不生成或发布实际视频。",
    }),
  }),
  pcal: Object.freeze({
    employeeIdx: 141,
    title: "私域日历真实验收",
    inputs: Object.freeze({
      month: "2026-08",
      channels: Object.freeze(["企业微信", "朋友圈"]),
      focus: "用真实门店素材持续回答顾客对菜品、食安和用餐场景的问题。",
    }),
  }),
  bench: Object.freeze({
    employeeIdx: 102,
    title: "竞品盯梢真实验收",
    inputs: Object.freeze({
      targets:
        "对标门店甲：同商圈中餐门店，公开链接待补\n对标门店乙：同客单价聚餐门店，公开链接待补",
      period: "2026-07-01至2026-07-31",
      focus: "只建立公开证据核验框架，不虚构竞品价格、销量或评价。",
    }),
  }),
  warm: Object.freeze({
    employeeIdx: 142,
    title: "起号军师真实验收",
    inputs: Object.freeze({
      platform: "小红书",
      positioning: "经营1至3家餐饮门店的老板周复盘账号，强调真实经营方法。",
      persona: "一线餐饮老板，表达直接、克制，不承诺收益。",
      goal: "30天形成可复用的选题、制作、审核和复盘节奏。",
    }),
  }),
  leads: Object.freeze({
    employeeIdx: 143,
    title: "线索雷达真实验收",
    inputs: Object.freeze({
      city: "上海市静安区验收商圈",
      product: "适合6至10人聚餐的中餐门店服务；真实菜单与价格尚待门店确认。",
      audience: "附近企业行政、团队聚餐组织者和家庭聚餐决策者。",
      constraints:
        "只输出公开渠道、核验步骤和人工跟进方案，不抓取个人隐私、不自动触达。",
    }),
  }),
  shot: Object.freeze({
    employeeIdx: 140,
    title: "产品图文真实验收",
    inputs: Object.freeze({
      product: "验收招牌菜A",
      facts:
        "已核实：堂食现做；主图素材由门店自有拍摄。未提供价格、份量、原产地和顾客评价。",
      channels: Object.freeze(["菜单页", "小红书"]),
    }),
  }),
  vars: Object.freeze({
    employeeIdx: 140,
    title: "口播矩阵真实验收",
    inputs: Object.freeze({
      script:
        "每周复盘食材成本时，先核对营业额、采购入库、库存变化和报损，再定位异常品类；没有原始凭证就不下结论。",
      variants: 3,
      platform: "视频号",
    }),
  }),
});

const baseDefinitions = [
  ["advisor:boss:standard", "老板参谋·老板标准会诊", "advisor", "boss"],
  ["advisor:boss:web-deep", "老板参谋·老板联网深度会诊", "advisor", "boss"],
  ["advisor:manager:standard", "老板参谋·管理层会诊", "advisor", "manager"],
  ["advisor:employee:standard", "老板参谋·员工会诊", "advisor", "employee"],
  ["custom-agent:boss", "自定义智能体·老板", "custom_agent", "boss"],
  ["custom-agent:manager", "自定义智能体·管理层", "custom_agent", "manager"],
  ["custom-agent:employee", "自定义智能体·员工", "custom_agent", "employee"],
  ...Object.keys(TOOLBOX_CASES).map((key) => [
    `toolbox:${key}`,
    `经营工具·${key}`,
    "toolbox",
    "boss",
  ]),
  [
    "activity:existing-plan",
    "活动中心·已有活动AI策划",
    "activity_plan",
    "boss",
  ],
  [
    "activity:plan-draft",
    "活动策划室·独立AI草稿",
    "activity_plan_draft",
    "boss",
  ],
  ["activity:review", "活动中心·AI数据复盘", "activity_review", "boss"],
  ["growth:suggest-reply", "增长中心·私域话术", "growth_reply", "employee"],
  ["growth:objection", "增长中心·异议处理", "growth_objection", "employee"],
  ["content:generate", "内容生产仓·同步通用创作", "content_generate", "boss"],
  [
    "content:generate-background",
    "内容生产仓·后台通用创作",
    "content_generate_background",
    "boss",
  ],
  ["content:ppt", "内容生产仓·AIPPT", "content_ppt", "boss"],
  ["content:daily-pack", "内容生产仓·一键日更包", "content_daily_pack", "boss"],
  [
    "content:automation",
    "内容生产仓·定时规则立即真实运行",
    "content_automation",
    "boss",
  ],
  ["files:vision", "文件中心·真实图片识别", "file_vision", "boss"],
  [
    "files:artifacts",
    "文件中心·真实AI来源四格式制品",
    "file_artifacts",
    "boss",
  ],
  [
    "marshal-chat:boss:sync",
    "餐饮数字员工·老板同步对话",
    "marshal_chat",
    "boss",
  ],
  [
    "marshal-chat:manager:sse",
    "餐饮数字员工·管理层SSE对话",
    "marshal_chat",
    "manager",
  ],
  [
    "marshal-chat:employee:forbidden",
    "餐饮数字员工·员工对话权限边界",
    "marshal_chat",
    "employee",
  ],
  [
    "marshal-skill-file:boss:four-formats",
    "餐饮数字员工·老板四格式技能文件",
    "marshal_skill_file",
    "boss",
  ],
  [
    "marshal-skill-file:employee:forbidden",
    "餐饮数字员工·员工技能文件权限边界",
    "marshal_skill_file",
    "employee",
  ],
  [
    "system-kb:manager:image-vision",
    "知识库·管理层图片识图入库",
    "system_kb_vision",
    "manager",
  ],
  [
    "marshal-task:boss:specialist",
    "餐饮数字员工·老板指定员工派活",
    "marshal_task",
    "boss",
  ],
  [
    "marshal-task:manager:department",
    "餐饮数字员工·管理层直达分部派活",
    "marshal_task",
    "manager",
  ],
  [
    "marshal-task:employee:forbidden",
    "餐饮数字员工·员工派活权限边界",
    "marshal_task",
    "employee",
  ],
];

function endpointsFor(key, kind) {
  if (kind === "advisor") {
    if (AUTHORIZATION_BOUNDARY_KEY_SET.has(key)) {
      return ["/api/advisor/chat", "/api/advisor/conversations"];
    }
    return [
      "/api/advisor/chat",
      "/api/advisor/conversations/:id/messages",
      ...(key === "advisor:boss:standard"
        ? [
            "/api/advisor/messages/:id/to-tasks",
            "/api/business-flow/advisor_message/:id",
          ]
        : []),
      ...(key === "advisor:boss:web-deep"
        ? ["/api/advisor/dispatch", "/api/business-flow/advisor_message/:id"]
        : []),
    ];
  }
  if (kind === "custom_agent")
    return [
      "/api/agents",
      "/api/agents/:id/chat",
      "/api/agents/chats/:sid/messages",
    ];
  if (kind === "toolbox") return ["/api/toolbox/runs", "/api/toolbox/runs/:id"];
  if (kind === "activity_plan")
    return ["/api/activities", "/api/activities/:id/plan"];
  if (kind === "activity_plan_draft")
    return [
      "/api/activities/plan-drafts/generate",
      "/api/activities/plan-drafts/:draftId",
    ];
  if (kind === "activity_review")
    return [
      "/api/sys/feishu",
      "/api/activities",
      "/api/activities/batch-results",
      "/api/activities/:id/review",
    ];
  if (kind === "growth_reply")
    return [
      "/api/growth/leads",
      "/api/growth/leads/:id/follow",
      "/api/growth/suggest-reply",
      "/api/growth/follow-report",
    ];
  if (kind === "growth_objection")
    return [
      "/api/growth/leads",
      "/api/growth/leads/:id/objection",
      "/api/growth/leads/:id/objections",
    ];
  if (kind === "content_generate")
    return ["/api/content/generate", "/api/content/detail/:id"];
  if (kind === "content_generate_background")
    return [
      "/api/content/generate",
      "/api/content/media-jobs/:id",
      "/api/content/detail/:id",
    ];
  if (kind === "content_ppt")
    return ["/api/content/generate-ppt", "/api/content/detail/:id"];
  if (kind === "content_daily_pack")
    return ["/api/content/daily-pack", "/api/content/detail/:id"];
  if (kind === "content_automation")
    return [
      "/api/content/automations",
      "/api/content/automations/:id/run",
      "/api/content/automations/:id/runs",
      "/api/content/automations/:id/toggle",
      "/api/content/detail/:id",
    ];
  if (kind === "file_vision") return ["/api/files/upload", "/api/files/:id"];
  if (kind === "file_artifacts")
    return [
      "/api/advisor/chat",
      "/api/files/artifacts/generate",
      "/api/files/artifacts",
    ];
  if (kind === "marshal_chat")
    return ["/api/marshals/:id/chat", "/api/marshals/chats/:sid/messages"];
  if (kind === "marshal_skill_file")
    return ["/api/marshals/:id/skill-file", "/api/files/artifacts"];
  if (kind === "system_kb_vision")
    return ["/api/sys/kb/upload", "/api/sys/kb", "/api/assets"];
  if (kind === "marshal_task") {
    return [
      "/api/marshals/:id/tasks",
      "/api/marshals/tasks/:taskId/status",
      "/api/business-flow/restaurant_task/:taskId",
    ];
  }
  return [];
}

export const FEATURE_DEFINITIONS = Object.freeze(
  baseDefinitions.map(([key, title, kind, role]) => {
    const permissionBoundary = AUTHORIZATION_BOUNDARY_KEY_SET.has(key);
    return Object.freeze({
      key,
      title,
      kind,
      role,
      expectation: permissionBoundary
        ? "authorization_boundary"
        : "real_ai_delivery",
      endpoints: Object.freeze(endpointsFor(key, kind)),
      providerPolicy: permissionBoundary
        ? "authorization_boundary"
        : kind === "file_artifacts"
          ? "inherited"
          : "direct",
      externalSideEffects: false,
      assertions: Object.freeze(
        permissionBoundary
          ? {
              mode: "no_ai_call_due_to_module_guard",
              model: "no_model",
              tokens: "zero_new_tokens",
              billing: "no_new_credit_log_or_hold",
              persistence: "no_business_artifact_before_route_handler",
              terminal: "http_403_exact_module_permission_denial",
              output: "no_ai_output_or_business_id",
              semantic: "role_lane_and_zero_effects_oracle_required",
            }
          : {
              mode:
                kind === "file_artifacts" ? "api_from_same_run_source" : "api",
              model: "real_non_template_model",
              tokens: "positive_input_and_output_for_every_billing_row",
              billing: "settled_with_hold_id_and_credit_log",
              persistence: "authenticated_readback_required",
              terminal: "feature_terminal_contract_required",
              output: "non_empty_contract_valid_hash_required",
              semantic:
                "known_facts_forbidden_facts_structure_references_and_calculation_oracle_required",
            },
      ),
    });
  }),
);

export const EXCLUDED_FEATURES = Object.freeze([
  Object.freeze({
    endpoints: ["/api/recharge/*", "/api/recharge/notify/*"],
    reason: "涉及真实支付、充值或支付回调，不在自动验收中发起。",
  }),
  Object.freeze({
    endpoints: ["/api/sys/feishu/*", "/api/activities/:id/plan/submit"],
    reason: "可能绑定、测试或同步飞书及外部日历，需要单独授权。",
  }),
  Object.freeze({
    endpoints: ["/api/content/:id/publish-log"],
    reason: "会登记真实发布事实；矩阵只生成和审阅内部产物，不冒充外部发布。",
  }),
  Object.freeze({
    endpoints: ["/api/content/generate-video"],
    reason:
      "创建外部异步视频任务并按固定媒体价格计费，不满足本矩阵“正文本token”证据口径。",
  }),
  Object.freeze({
    endpoints: ["/api/content/generate-image"],
    reason: "按图片固定计费且无文本token口径，需在独立媒体矩阵中验收。",
  }),
  Object.freeze({
    endpoints: ["/api/content/media-jobs/:id/import-material"],
    reason: "依赖已完成的外部媒体任务；本矩阵不创建对应媒体任务。",
  }),
]);

export const NON_AI_COMPANION_ENDPOINTS = Object.freeze([
  "/api/advisor/messages/:id/to-tasks",
  "/api/advisor/dispatch",
  "/api/activities/:id/invite-candidates",
  "/api/activities/:id/invites",
  "/api/growth/leads/:id/follow",
  "/api/analysis/weekly-review/generate",
]);

// L2场景是验收数据集的公开契约，不是事后根据模型回答改答案。
// knownFacts 必须在产物中被正确使用；forbiddenFacts 不得被当成已知事实对外承诺。
const CONTENT_KNOWN_FACTS = Object.freeze([
  "营业额100000元",
  "采购入库35000元",
  "订单2000单",
  "采购入库占营业额35%",
  "客单收入50元/单",
]);
const CONTENT_UNKNOWN_FACTS = Object.freeze([
  "期初库存",
  "期末库存",
  "报损",
  "调拨",
]);
const CONTENT_FORBIDDEN_FACTS = Object.freeze([
  "食材成本率已确定为35%",
  "优惠价199元",
  "仅剩3份",
  "顾客都说很值",
  "内容已发布",
]);

export const FEATURE_SEMANTIC_SCENARIOS = Object.freeze({
  "advisor:boss:standard": Object.freeze({
    id: "advisor-current-data-v1",
    knownFacts: Object.freeze(["只使用当前账号可见的经营数据"]),
    forbiddenFacts: Object.freeze(["未取得的价格、库存、顾客证言、已完成动作"]),
    required: Object.freeze([
      "事实依据",
      "未知项",
      "3个执行动作",
      "负责人/截止/检查标准",
      "风险边界",
    ]),
  }),
  "advisor:boss:web-deep": Object.freeze({
    id: "advisor-web-citations-v1",
    knownFacts: Object.freeze(["当前可见经营数据", "本轮返回的可验证URL"]),
    forbiddenFacts: Object.freeze(["无引用的网络结论", "未完成的外部动作"]),
    required: Object.freeze([
      "事实与引用分层",
      "未知项",
      "3个执行动作",
      "风险边界",
    ]),
  }),
  "custom-agent:boss": Object.freeze({
    id: "custom-agent-cost-check-v1",
    knownFacts: Object.freeze(["营业额100000元", "采购35000元"]),
    forbiddenFacts: Object.freeze(["食材成本率已确定为35%"]),
    required: Object.freeze(["库存未知", "核验清单", "检查标准"]),
  }),
  "custom-agent:manager": Object.freeze({
    id: "custom-agent-cost-check-v1",
    knownFacts: Object.freeze(["营业额100000元", "采购35000元"]),
    forbiddenFacts: Object.freeze(["食材成本率已确定为35%"]),
    required: Object.freeze(["库存未知", "核验清单", "检查标准"]),
  }),
  "custom-agent:employee": Object.freeze({
    id: "custom-agent-cost-check-v1",
    knownFacts: Object.freeze(["营业额100000元", "采购35000元"]),
    forbiddenFacts: Object.freeze(["食材成本率已确定为35%"]),
    required: Object.freeze(["库存未知", "核验清单", "检查标准"]),
  }),
  "toolbox:hot": Object.freeze({
    id: "toolbox-hot-v1",
    knownFacts: Object.freeze(["验收门店A", "招牌菜", "微信公众号", "小红书"]),
    forbiddenFacts: Object.freeze(["未提供的价格、库存、优惠"]),
    required: Object.freeze(["3个差异化候选", "审核检查"]),
  }),
  "toolbox:remix": Object.freeze({
    id: "toolbox-remix-v1",
    knownFacts: Object.freeze([
      "门头",
      "后厨备餐",
      "招牌菜成品",
      "老板口播",
      "视频号",
    ]),
    forbiddenFacts: Object.freeze([
      "顾客肖像已授权",
      "音乐已授权",
      "视频已发布",
    ]),
    required: Object.freeze(["分镜", "字幕", "素材核验"]),
  }),
  "toolbox:pcal": Object.freeze({
    id: "toolbox-private-calendar-v1",
    knownFacts: Object.freeze([
      "2026-08",
      "企业微信",
      "朋友圈",
      "菜品",
      "食安",
    ]),
    forbiddenFacts: Object.freeze(["已自动发送", "未提供的优惠"]),
    required: Object.freeze(["可执行日历", "负责人", "复盘"]),
  }),
  "toolbox:bench": Object.freeze({
    id: "toolbox-benchmark-v1",
    knownFacts: Object.freeze([
      "对标门店甲",
      "对标门店乙",
      "2026-07-01",
      "2026-07-31",
    ]),
    forbiddenFacts: Object.freeze(["未核验的竞品价格、销量、评价"]),
    required: Object.freeze(["公开证据", "核验步骤", "差异化"]),
  }),
  "toolbox:warm": Object.freeze({
    id: "toolbox-account-warmup-v1",
    knownFacts: Object.freeze(["小红书", "1至3家餐饮门店", "30天"]),
    forbiddenFacts: Object.freeze(["涨粉或收益保证"]),
    required: Object.freeze(["选题", "制作", "审核", "复盘"]),
  }),
  "toolbox:leads": Object.freeze({
    id: "toolbox-leads-v1",
    knownFacts: Object.freeze(["上海市静安区验收商圈", "6至10人", "企业行政"]),
    forbiddenFacts: Object.freeze([
      "个人隐私抓取",
      "自动触达",
      "未提供的菜单价格",
    ]),
    required: Object.freeze(["公开渠道", "核验步骤", "人工跟进"]),
  }),
  "toolbox:shot": Object.freeze({
    id: "toolbox-product-copy-v1",
    knownFacts: Object.freeze([
      "验收招牌菜A",
      "堂食现做",
      "门店自有拍摄",
      "菜单页",
      "小红书",
    ]),
    forbiddenFacts: Object.freeze(["未提供的价格、份量、原产地、顾客评价"]),
    required: Object.freeze(["双渠道文案", "配图", "发布前检查"]),
  }),
  "toolbox:vars": Object.freeze({
    id: "toolbox-script-variants-v1",
    knownFacts: Object.freeze([
      "营业额",
      "采购入库",
      "库存变化",
      "报损",
      "视频号",
    ]),
    forbiddenFacts: Object.freeze(["没有原始凭证仍下结论"]),
    required: Object.freeze(["3个差异化口播", "镜头或表达差异"]),
  }),
  "activity:existing-plan": Object.freeze({
    id: "activity-plan-12-3-2000-v1",
    knownFacts: Object.freeze([
      "目标参与12人",
      "目标成交3单",
      "预算上限2000元",
    ]),
    forbiddenFacts: Object.freeze(["未审批优惠", "虚构名额或转化结果"]),
    required: Object.freeze(["流程", "物料", "SOP", "KPI", "负责人审批"]),
  }),
  "activity:plan-draft": Object.freeze({
    id: "activity-plan-18-3000-v1",
    knownFacts: Object.freeze(["目标参与18人", "预算上限3000元"]),
    forbiddenFacts: Object.freeze(["未审批优惠", "虚构名额或转化结果"]),
    required: Object.freeze(["流程", "物料", "SOP", "KPI", "人工审批"]),
  }),
  "activity:review": Object.freeze({
    id: "activity-review-math-v1",
    knownFacts: Object.freeze([
      "邀约30",
      "报名18",
      "到场14",
      "成交4",
      "收入6800元",
      "成本2100元",
      "满意度4.5",
      "报名率60%",
      "到场率77.8%",
      "成交率28.6%",
      "ROI 3.2",
    ]),
    forbiddenFacts: Object.freeze(["虚构行业均值", "虚构优惠或顾客证言"]),
    required: Object.freeze(["数据证据", "3条改进", "负责人+时限", "风险"]),
  }),
  "growth:suggest-reply": Object.freeze({
    id: "growth-reply-unknowns-v1",
    knownFacts: Object.freeze(["6至10人团队聚餐需求"]),
    forbiddenFacts: Object.freeze([
      "8月18日可订",
      "199元",
      "赠送果盘",
      "仅剩3桌",
    ]),
    required: Object.freeze([
      "3条差异化话术",
      "确认日期/人数/菜单/预算",
      "人工审核",
    ]),
  }),
  "growth:objection": Object.freeze({
    id: "growth-objection-unknowns-v1",
    knownFacts: Object.freeze(["顾客担心菜单和价格临时变化"]),
    forbiddenFacts: Object.freeze([
      "菜单价格保证不变",
      "199元",
      "赠送果盘",
      "仅剩3桌",
    ]),
    required: Object.freeze(["先回应顾虑", "书面确认步骤", "人工复核"]),
  }),
  "content:generate": Object.freeze({
    id: "content-cost-math-v1",
    knownFacts: CONTENT_KNOWN_FACTS,
    forbiddenFacts: CONTENT_FORBIDDEN_FACTS,
    required: CONTENT_UNKNOWN_FACTS,
  }),
  "content:generate-background": Object.freeze({
    id: "content-cost-math-background-v1",
    knownFacts: CONTENT_KNOWN_FACTS,
    forbiddenFacts: CONTENT_FORBIDDEN_FACTS,
    required: CONTENT_UNKNOWN_FACTS,
  }),
  "content:ppt": Object.freeze({
    id: "content-ppt-cost-math-v1",
    knownFacts: CONTENT_KNOWN_FACTS,
    forbiddenFacts: CONTENT_FORBIDDEN_FACTS,
    required: Object.freeze([
      "5个经营结构章节",
      "每页结论与动作",
      ...CONTENT_UNKNOWN_FACTS,
    ]),
  }),
  "content:daily-pack": Object.freeze({
    id: "content-daily-pack-cost-math-v1",
    knownFacts: CONTENT_KNOWN_FACTS,
    forbiddenFacts: CONTENT_FORBIDDEN_FACTS,
    required: Object.freeze([
      "短视频脚本",
      "朋友圈文案",
      "社群话题",
      ...CONTENT_UNKNOWN_FACTS,
    ]),
  }),
  "content:automation": Object.freeze({
    id: "content-automation-cost-math-v1",
    knownFacts: Object.freeze([
      "营业额100000元",
      "采购入库35000元",
      "采购入库占营业额35%",
    ]),
    forbiddenFacts: CONTENT_FORBIDDEN_FACTS,
    required: Object.freeze(["库存变化未知", "待审核", "未发布"]),
  }),
  "files:vision": Object.freeze({
    id: "vision-readable-card-v1",
    knownFacts: Object.freeze(["NANOWORK", "2026", "47", "蓝色"]),
    forbiddenFacts: Object.freeze(["将蓝色识别为红色", "将47识别为74"]),
    required: Object.freeze(["文字", "颜色", "数字"]),
  }),
  "files:artifacts": Object.freeze({
    id: "artifacts-source-semantics-v1",
    knownFacts: Object.freeze(["同轮真实云API经营建议", "来源哈希"]),
    forbiddenFacts: Object.freeze(["格式转换冒充新AI结论", "对外发布"]),
    required: Object.freeze(["事实依据", "未知项", "执行动作"]),
  }),
  "marshal-chat:boss:sync": Object.freeze({
    id: "marshal-chat-sync-cost-boundary-v1",
    knownFacts: CONTENT_KNOWN_FACTS,
    forbiddenFacts: CONTENT_FORBIDDEN_FACTS,
    required: Object.freeze([...CONTENT_UNKNOWN_FACTS, "负责人", "检查标准"]),
  }),
  "marshal-chat:manager:sse": Object.freeze({
    id: "marshal-chat-sse-cost-boundary-v1",
    knownFacts: CONTENT_KNOWN_FACTS,
    forbiddenFacts: CONTENT_FORBIDDEN_FACTS,
    required: Object.freeze([
      ...CONTENT_UNKNOWN_FACTS,
      "SSE完成事件",
      "落库正文一致",
    ]),
  }),
  "marshal-chat:employee:forbidden": Object.freeze({
    id: "marshal-chat-employee-permission-v1",
    knownFacts: Object.freeze(["员工账号无餐饮数字员工模块"]),
    forbiddenFacts: Object.freeze(["使用老板账号冒充员工"]),
    required: Object.freeze(["精确403", "零计费", "零会话消息"]),
  }),
  "marshal-skill-file:boss:four-formats": Object.freeze({
    id: "marshal-skill-four-formats-v1",
    knownFacts: CONTENT_KNOWN_FACTS,
    forbiddenFacts: CONTENT_FORBIDDEN_FACTS,
    required: Object.freeze(["Word", "Excel", "PPT", "PDF", "四份可下载文件"]),
  }),
  "marshal-skill-file:employee:forbidden": Object.freeze({
    id: "marshal-skill-employee-permission-v1",
    knownFacts: Object.freeze(["员工账号无餐饮数字员工模块"]),
    forbiddenFacts: Object.freeze(["使用老板账号冒充员工"]),
    required: Object.freeze(["精确403", "零计费", "零制品"]),
  }),
  "system-kb:manager:image-vision": Object.freeze({
    id: "system-kb-vision-readable-card-v1",
    knownFacts: Object.freeze(["NANOWORK", "2026", "47", "蓝色"]),
    forbiddenFacts: Object.freeze(["将蓝色识别为红色", "将47识别为74"]),
    required: Object.freeze(["知识文档", "知识资产", "可读识图正文"]),
  }),
  "marshal-task:boss:specialist": Object.freeze({
    id: "marshal-task-specialist-economics-v1",
    knownFacts: CONTENT_KNOWN_FACTS,
    forbiddenFacts: CONTENT_FORBIDDEN_FACTS,
    required: Object.freeze([
      ...CONTENT_UNKNOWN_FACTS,
      "指定数字员工",
      "待人工审阅",
    ]),
  }),
  "marshal-task:manager:department": Object.freeze({
    id: "marshal-task-department-cost-boundary-v1",
    knownFacts: CONTENT_KNOWN_FACTS,
    forbiddenFacts: CONTENT_FORBIDDEN_FACTS,
    required: Object.freeze([
      ...CONTENT_UNKNOWN_FACTS,
      "无指定数字员工",
      "待人工审阅",
    ]),
  }),
  "marshal-task:employee:forbidden": Object.freeze({
    id: "marshal-task-employee-permission-v1",
    knownFacts: Object.freeze(["员工账号无餐饮数字员工模块"]),
    forbiddenFacts: Object.freeze(["使用老板账号冒充员工"]),
    required: Object.freeze(["精确403", "零计费", "零任务与产物"]),
  }),
  "advisor:manager:standard": Object.freeze({
    id: "manager-advisor-permission-v1",
    knownFacts: Object.freeze(["管理层账号无老板参谋模块"]),
    forbiddenFacts: Object.freeze(["使用老板账号冒充管理层"]),
    required: Object.freeze(["精确403", "零计费", "零产物"]),
  }),
  "advisor:employee:standard": Object.freeze({
    id: "employee-advisor-permission-v1",
    knownFacts: Object.freeze(["员工账号无老板参谋模块"]),
    forbiddenFacts: Object.freeze(["使用老板账号冒充员工"]),
    required: Object.freeze(["精确403", "零计费", "零产物"]),
  }),
});

function semanticText(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function semanticJson(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
}

function regexFound(value, regex) {
  return regex.test(semanticText(value));
}

function addSemanticCheck(checks, id, pass, expectation, observed = undefined) {
  checks.push({
    id,
    pass: pass === true,
    expectation,
    ...(observed === undefined ? {} : { observed }),
  });
}

function distinctStrings(values, minimumLength = 2) {
  const normalized = (Array.isArray(values) ? values : [])
    .map((item) =>
      semanticText(typeof item === "string" ? item : JSON.stringify(item)),
    )
    .filter((item) => item.length >= minimumLength);
  return (
    new Set(normalized).size === normalized.length && normalized.length > 0
  );
}

const CLAIM_NEGATION =
  /(?:不得|禁止|不能|不应|不要|未提供|未确认|未核验|未知|待确认|待核验|无依据|尚未|避免|不编造|不虚构|不承诺|不代表)/u;

function assertedClaim(value, regex) {
  const source = semanticText(value);
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const matcher = new RegExp(regex.source, flags);
  for (const match of source.matchAll(matcher)) {
    const index = Number(match.index) || 0;
    const context = source.slice(
      Math.max(0, index - 28),
      Math.min(source.length, index + match[0].length + 18),
    );
    if (!CLAIM_NEGATION.test(context)) return true;
  }
  return false;
}

function contentMathChecks(checks, source, { requireOrders = true } = {}) {
  addSemanticCheck(
    checks,
    "known-turnover",
    /(?:100000|100,000|10万)元?/u.test(source),
    "正确使用营业额100000元",
  );
  addSemanticCheck(
    checks,
    "known-purchases",
    /(?:35000|35,000|3\.5万)元?/u.test(source),
    "正确使用采购入库35000元",
  );
  if (requireOrders) {
    addSemanticCheck(
      checks,
      "known-orders",
      /2000单/u.test(source),
      "正确使用订单2000单",
    );
  }
  const purchaseRatioCorrect =
    /(?:采购|入库)[^%]{0,28}(?:营业额|营收)[^%]{0,20}35(?:\.0)?%|35(?:\.0)?%[^\n。；]{0,24}(?:采购|入库)(?:额)?(?:占比|与营业额)/u.test(
      source,
    );
  addSemanticCheck(
    checks,
    "calculation-purchase-ratio",
    purchaseRatioCorrect,
    "35000/100000=35%，且只标注为采购入库占营业额",
  );
  if (requireOrders) {
    const perOrderCorrect =
      /(?:50(?:\.0{1,2})?元\/?单|客单(?:收入|均收入)?[^\d]{0,12}50(?:\.0{1,2})?元)/u.test(
        source,
      );
    addSemanticCheck(
      checks,
      "calculation-revenue-per-order",
      perOrderCorrect,
      "100000/2000=50元/单，只标注为客单收入",
    );
  }
  addSemanticCheck(
    checks,
    "unknown-inventory-boundary",
    /(?:期初|期末|库存)[^\n。；]{0,24}(?:未知|未提供|待确认|待核验|缺失)/u.test(
      source,
    ) &&
      /(?:报损|调拨)[^\n。；]{0,32}(?:未知|未提供|待确认|待核验|缺失)|(?:未知|未提供|待确认|待核验|缺失)[^\n。；]{0,32}(?:报损|调拨)/u.test(
        source,
      ),
    "明确期初/期末库存、报损、调拨尚未提供",
  );
  addSemanticCheck(
    checks,
    "no-false-cost-rate",
    !assertedClaim(
      source,
      /(?:食材|原料|菜品)?成本率(?:为|是|达到|已经|约)?\s*35(?:\.0)?%/u,
    ),
    "不得将采购占比35%冒充食材成本率",
  );
}

function genericOutputChecks(checks, source) {
  addSemanticCheck(
    checks,
    "non-empty-semantic-output",
    source.length >= 60,
    "产物不得为空或短句占位",
    source.length,
  );
  const placeholderCount = (
    source.match(/(?:待填写|待指定|暂无|请自行补充|要点\d|示例内容)/gu) || []
  ).length;
  addSemanticCheck(
    checks,
    "not-placeholder-shell",
    placeholderCount < 3,
    "不得是成批占位符或空模板",
    placeholderCount,
  );
}

function evaluateActivityPlan(checks, featureKey, source, structured) {
  const plan = semanticJson(structured) || semanticJson(source) || {};
  const flow = Array.isArray(plan.flow) ? plan.flow : [];
  const materials = Array.isArray(plan.materials) ? plan.materials : [];
  const sop = Array.isArray(plan.sop) ? plan.sop : [];
  addSemanticCheck(
    checks,
    "plan-theme",
    semanticText(plan.theme).length >= 6,
    "活动主题必须具体",
  );
  addSemanticCheck(
    checks,
    "plan-flow",
    flow.length >= 4 && distinctStrings(flow),
    "至少4个不重复流程节点",
    flow.length,
  );
  addSemanticCheck(
    checks,
    "plan-materials",
    materials.length >= 3 && distinctStrings(materials),
    "至少3项不重复物料",
    materials.length,
  );
  addSemanticCheck(
    checks,
    "plan-sop",
    sop.length >= 3 && distinctStrings(sop),
    "至少3条不重复SOP",
    sop.length,
  );
  addSemanticCheck(
    checks,
    "plan-kpi",
    plan.kpi &&
      typeof plan.kpi === "object" &&
      Object.keys(plan.kpi).length >= 2,
    "KPI必须是可检查对象",
  );
  const expected =
    featureKey === "activity:existing-plan"
      ? {
          people: /(?:12人|目标人数[^\d]{0,8}12)/u,
          budget: /2000元/u,
          deal: /(?:3单|成交[^\d]{0,8}3)/u,
        }
      : {
          people: /(?:18人|目标人数[^\d]{0,8}18)/u,
          budget: /3000元/u,
          deal: null,
        };
  addSemanticCheck(
    checks,
    "plan-known-people",
    expected.people.test(source),
    "使用输入的目标参与人数",
  );
  addSemanticCheck(
    checks,
    "plan-known-budget",
    expected.budget.test(source),
    "使用输入的预算上限",
  );
  if (expected.deal)
    addSemanticCheck(
      checks,
      "plan-known-deal",
      expected.deal.test(source),
      "使用输入的目标成交数",
    );
  addSemanticCheck(
    checks,
    "plan-approval-boundary",
    /(?:审批|负责人确认|书面确认|待确认)/u.test(source),
    "优惠、价格、承诺须经人工审批",
  );
}

function evaluateToolbox(checks, featureKey, source) {
  const key = featureKey.split(":")[1];
  const specs = {
    hot: [
      /(?:验收门店A|招牌菜)/u,
      /微信公众号/u,
      /小红书/u,
      /(?:候选|选题|标题)/u,
    ],
    remix: [
      /门头/u,
      /后厨备餐/u,
      /招牌菜/u,
      /老板口播/u,
      /分镜/u,
      /字幕/u,
      /(?:肖像|音乐)[^\n。；]{0,20}(?:待确认|未授权|核验)/u,
    ],
    pcal: [
      /2026[-年/]?0?8/u,
      /企业微信/u,
      /朋友圈/u,
      /(?:日历|日期|周)/u,
      /复盘/u,
    ],
    bench: [
      /对标门店甲/u,
      /对标门店乙/u,
      /2026-07/u,
      /(?:公开证据|公开链接|核验)/u,
    ],
    warm: [/小红书/u, /30天/u, /(?:选题|内容)/u, /审核/u, /复盘/u],
    leads: [
      /上海市?静安区/u,
      /6\s*(?:至|-|~)​?\s*10人/u,
      /(?:企业行政|团队聚餐)/u,
      /(?:人工跟进|人工确认)/u,
      /(?:不自动触达|隐私)/u,
    ],
    shot: [
      /验收招牌菜A/u,
      /堂食现做/u,
      /(?:自有拍摄|门店拍摄)/u,
      /菜单页/u,
      /小红书/u,
    ],
    vars: [/营业额/u, /采购入库/u, /库存/u, /报损/u, /视频号/u],
  };
  for (const [index, regex] of (specs[key] || []).entries()) {
    addSemanticCheck(
      checks,
      `toolbox-anchor-${index + 1}`,
      regex.test(source),
      `工具${key}输出命中第${index + 1}个已知输入或交付约束`,
    );
  }
  if (key === "hot") {
    const candidates =
      source.match(
        /(?:(?:候选|标题|选题)\s*[1-5]|\|\s*[1-5]\s*\||(?:^|\s)[1-5][.、)])/gu,
      ) || [];
    addSemanticCheck(
      checks,
      "toolbox-hot-three-candidates",
      candidates.length >= 3,
      "至少3个差异化候选",
      candidates.length,
    );
  }
  if (key === "vars") {
    const variants =
      source.match(/(?:(?:方案|版本|口播)\s*[1-3]|(?:^|\s)[1-3][.、)])/gu) ||
      [];
    addSemanticCheck(
      checks,
      "toolbox-vars-three-variants",
      variants.length >= 3,
      "至少3个差异化口播版本",
      variants.length,
    );
  }
  const unsupported = {
    hot: /(?:199元|仅剩3份|全场五折|限时优惠)/u,
    remix: /(?:肖像|音乐)(?:已授权|可商用)|已发布/u,
    bench: /(?:竞品|对标门店)[^\n。；]{0,20}(?:销量第一|好评率\d|人均\d+元)/u,
    warm: /(?:保证|必然|一定)(?:涨粉|收益|变现)/u,
    leads: /(?:已抓取个人|已自动触达|菜单价格为)/u,
    shot: /(?:199元|足够四人|原产地为|顾客都说)/u,
  }[key];
  if (unsupported)
    addSemanticCheck(
      checks,
      "toolbox-no-unsupported-claim",
      !assertedClaim(source, unsupported),
      "不得把未提供信息写成事实",
    );
}

export function evaluateFeatureSemantics(
  featureKey,
  { resultText = "", structured = null, metadata = {} } = {},
) {
  const scenario = FEATURE_SEMANTIC_SCENARIOS[featureKey];
  const checks = [];
  const source = semanticText(
    resultText || (structured ? JSON.stringify(structured) : ""),
  );
  const permissionBoundary = AUTHORIZATION_BOUNDARY_KEY_SET.has(featureKey);
  if (!scenario) {
    addSemanticCheck(
      checks,
      "scenario-defined",
      false,
      "该功能必须有固定L2业务oracle",
    );
  } else if (!permissionBoundary) {
    genericOutputChecks(checks, source);
  }

  if (featureKey.startsWith("advisor:boss")) {
    addSemanticCheck(
      checks,
      "advisor-facts",
      /(?:事实|数据|依据)/u.test(source),
      "区分事实依据",
    );
    addSemanticCheck(
      checks,
      "advisor-unknowns",
      /(?:未知|待确认|未提供|数据缺失)/u.test(source),
      "显式列出未知项",
    );
    addSemanticCheck(
      checks,
      "advisor-actions",
      /(?:负责人|执行人)/u.test(source) &&
        /(?:截止|时限|完成时间)/u.test(source) &&
        /(?:检查标准|验收标准|可验证)/u.test(source),
      "动作含负责人、时限、检查标准",
    );
    addSemanticCheck(
      checks,
      "advisor-risk",
      /(?:风险|边界|不得编造|需人工复核)/u.test(source),
      "明确风险边界",
    );
    if (featureKey.endsWith("web-deep"))
      addSemanticCheck(
        checks,
        "advisor-web-sources",
        Number(metadata?.sourceCount) > 0,
        "联网结论有至少1个可验证URL",
        Number(metadata?.sourceCount) || 0,
      );
  } else if (featureKey.startsWith("custom-agent:")) {
    addSemanticCheck(
      checks,
      "custom-known-turnover",
      /(?:100000|100,000|10万)元?/u.test(source),
      "复述营业额100000元",
    );
    addSemanticCheck(
      checks,
      "custom-known-purchases",
      /(?:35000|35,000|3\.5万)元?/u.test(source),
      "复述采购35000元",
    );
    addSemanticCheck(
      checks,
      "custom-no-false-cost-rate",
      !assertedClaim(source, /(?:食材|原料)?成本率(?:为|是|约|达到)?\s*35%/u),
      "不把35%采购占比说成食材成本率",
    );
    addSemanticCheck(
      checks,
      "custom-missing-inventory",
      /(?:期初|期末|库存)[^\n。；]{0,24}(?:未知|未提供|缺失|待确认)/u.test(
        source,
      ),
      "指出库存变化未知",
    );
    addSemanticCheck(
      checks,
      "custom-checklist",
      /(?:期初库存|期末库存)/u.test(source) &&
        /(?:报损|调拨)/u.test(source) &&
        /(?:凭证|台账|盘点|核对)/u.test(source),
      "核验清单包含库存、报损/调拨与凭证",
    );
  } else if (featureKey.startsWith("toolbox:")) {
    evaluateToolbox(checks, featureKey, source);
  } else if (
    ["activity:existing-plan", "activity:plan-draft"].includes(featureKey)
  ) {
    evaluateActivityPlan(checks, featureKey, source, structured);
  } else if (featureKey === "activity:review") {
    for (const [id, regex, label] of [
      ["review-invite-sign", /(?:60(?:\.0)?%)/u, "邀约→报名=60%"],
      ["review-sign-arrive", /77\.8%/u, "报名→到场=77.8%"],
      ["review-arrive-deal", /28\.6%/u, "到场→成交=28.6%"],
      ["review-roi", /ROI[^\d]{0,8}3\.2/u, "ROI=6800/2100=3.2"],
    ])
      addSemanticCheck(checks, id, regex.test(source), label);
    addSemanticCheck(
      checks,
      "review-no-wrong-math",
      !/(?:报名率[^\d]{0,8}(?:50|70)%|到场率[^\d]{0,8}(?:60|80)%|成交率[^\d]{0,8}(?:20|40)%|ROI[^\d]{0,8}(?:2\.2|4\.2))/u.test(
        source,
      ),
      "不得出现与验收数据冲突的计算",
    );
    addSemanticCheck(
      checks,
      "review-actions",
      /(?:3条|三条|改进)/u.test(source) &&
        /(?:检查标准|验收标准)/u.test(source),
      "至少3条带检查标准的改进",
    );
    addSemanticCheck(
      checks,
      "review-followup",
      /(?:负责人|负责)[^\n。]{0,30}(?:小时|天|截止|时限)|(?:小时|天|截止|时限)[^\n。]{0,30}(?:负责人|负责)/u.test(
        source,
      ),
      "跟进动作含负责人和时限",
    );
  } else if (featureKey === "growth:suggest-reply") {
    addSemanticCheck(
      checks,
      "growth-known-demand",
      /(?:6\s*(?:至|-|~)\s*10人|团队聚餐)/u.test(source),
      "回应已知团队聚餐需求",
    );
    const replyParts = source
      .split(/[1-3][.、)]/u)
      .map(semanticText)
      .filter((item) => item.length >= 12);
    addSemanticCheck(
      checks,
      "growth-three-replies",
      new Set(replyParts).size >= 3,
      "至少3条不重复话术",
      replyParts.length,
    );
    addSemanticCheck(
      checks,
      "growth-confirm-unknowns",
      /日期/u.test(source) &&
        /人数/u.test(source) &&
        /菜单/u.test(source) &&
        /预算/u.test(source) &&
        /(?:确认|请问|方便告知|待定)/u.test(source),
      "不编造日期、人数、菜单和预算，而是发起确认",
    );
    addSemanticCheck(
      checks,
      "growth-no-invented-offer",
      !assertedClaim(source, /(?:8月18日|199元|赠送果盘|仅剩3桌)/u),
      "不得声称禁止事实已成立",
    );
  } else if (featureKey === "growth:objection") {
    addSemanticCheck(
      checks,
      "objection-empathy",
      /(?:理解|收到|您担心|确实需要确认)/u.test(source),
      "先回应顾客对菜单和价格变化的顾虑",
    );
    addSemanticCheck(
      checks,
      "objection-written-confirmation",
      /(?:菜单|价格)/u.test(source) &&
        /(?:书面|二次|复核|确认单|截止时间)/u.test(source),
      "提供菜单与价格的书面复核步骤",
    );
    addSemanticCheck(
      checks,
      "objection-no-guarantee",
      !assertedClaim(
        source,
        /(?:菜单|价格)[^\n。；]{0,20}(?:保证|肯定|一定|绝对)不变|(?:199元|赠送果盘|仅剩3桌)/u,
      ),
      "不得承诺未确认的价格、菜单或优惠",
    );
  } else if (
    [
      "content:generate",
      "content:generate-background",
      "content:automation",
    ].includes(featureKey)
  ) {
    contentMathChecks(checks, source, {
      requireOrders: featureKey !== "content:automation",
    });
    addSemanticCheck(
      checks,
      "content-internal-review-only",
      /(?:待审核|人工审核|未发布|不发布|发布前)/u.test(source),
      "只生成内部待审阅内容，不冒充已发布",
    );
  } else if (featureKey === "content:ppt") {
    const deck = semanticJson(structured) || semanticJson(resultText) || {};
    const pages = Array.isArray(deck.pages) ? deck.pages : [];
    addSemanticCheck(
      checks,
      "ppt-page-count",
      pages.length >= 5 && pages.length <= 7,
      "约5至7页内页",
      pages.length,
    );
    addSemanticCheck(
      checks,
      "ppt-unique-pages",
      distinctStrings(pages.map((page) => page?.title)),
      "页标题不重复",
    );
    addSemanticCheck(
      checks,
      "ppt-bullets",
      pages.every(
        (page) =>
          Array.isArray(page?.bullets) &&
          page.bullets.length >= 2 &&
          distinctStrings(page.bullets),
      ),
      "每页至少2个不重复要点",
    );
    addSemanticCheck(
      checks,
      "ppt-structure",
      /(?:数据|口径)/u.test(source) &&
        /异常/u.test(source) &&
        /(?:行动|方案)/u.test(source) &&
        /风险/u.test(source) &&
        /(?:下周|检查)/u.test(source),
      "覆盖数据口径、异常、行动、风险、下周检查",
    );
    contentMathChecks(checks, source, { requireOrders: true });
  } else if (featureKey === "content:daily-pack") {
    const parts = Array.isArray(structured) ? structured : [];
    const requiredTypes = ["短视频脚本", "朋友圈文案", "社群话题"];
    addSemanticCheck(
      checks,
      "daily-three-types",
      requiredTypes.every((type) => parts.some((item) => item?.type === type)),
      "三类子内容均存在",
      parts.map((item) => item?.type),
    );
    addSemanticCheck(
      checks,
      "daily-distinct",
      parts.length === 3 &&
        distinctStrings(
          parts.map((item) => item?.body),
          40,
        ),
      "三类内容不重复",
    );
    contentMathChecks(checks, source, { requireOrders: true });
    addSemanticCheck(
      checks,
      "daily-no-publish-claim",
      !assertedClaim(source, /(?:已发布|已上线|已推送)/u),
      "不冒充已对外发布",
    );
  } else if (featureKey === "files:vision") {
    addSemanticCheck(
      checks,
      "vision-word",
      /NANOWORK/iu.test(source),
      "识别文字NANOWORK",
    );
    addSemanticCheck(
      checks,
      "vision-year",
      /2026/u.test(source),
      "识别数字2026",
    );
    addSemanticCheck(
      checks,
      "vision-number",
      /(?:^|\D)47(?:\D|$)/u.test(source),
      "识别数字47",
    );
    addSemanticCheck(
      checks,
      "vision-color",
      /(?:蓝色|蓝底|蓝色区域|\bblue\b)/iu.test(source),
      "识别蓝色图形",
    );
    addSemanticCheck(
      checks,
      "vision-no-conflict",
      !/(?:文字[^\n。]{0,12}NAN0WORK|年份[^\n。]{0,10}2028|数字[^\n。]{0,10}74|主要颜色[^\n。]{0,10}红色)/iu.test(
        source,
      ),
      "不得同时给出冲突识别值",
    );
  } else if (featureKey === "files:artifacts") {
    addSemanticCheck(
      checks,
      "artifact-source-hash",
      /来源哈希：[a-f0-9]{64}/u.test(source),
      "制品带同轮源文哈希",
    );
    addSemanticCheck(
      checks,
      "artifact-source-semantics",
      /(?:事实|数据|依据)/u.test(source) &&
        /(?:未知|待确认|未提供|数据缺失)/u.test(source) &&
        /(?:负责人|执行人|检查标准)/u.test(source),
      "源文仍保留事实、未知与动作",
    );
  } else if (featureKey.startsWith("marshal-chat:") && !permissionBoundary) {
    contentMathChecks(checks, source, { requireOrders: true });
    addSemanticCheck(
      checks,
      "marshal-chat-actions",
      /(?:负责人|执行人)/u.test(source) &&
        /(?:检查标准|验收标准|核验)/u.test(source),
      "员工对话给出负责人和可核验检查标准",
    );
    addSemanticCheck(
      checks,
      "marshal-chat-persisted-match",
      metadata?.replyPersisted === true,
      "响应正文与会话读取正文一致",
    );
    if (featureKey.endsWith(":sse")) {
      addSemanticCheck(
        checks,
        "marshal-chat-sse-terminal",
        metadata?.transport === "sse" &&
          metadata?.sseDone === true &&
          Number(metadata?.sseEventCount) >= 3,
        "SSE包含reset、正文delta和done终态",
      );
    } else {
      addSemanticCheck(
        checks,
        "marshal-chat-sync-terminal",
        metadata?.transport === "json",
        "同步调用返回JSON终态",
      );
    }
  } else if (featureKey === "marshal-skill-file:boss:four-formats") {
    contentMathChecks(checks, source, { requireOrders: true });
    const formats = Array.isArray(metadata?.formats)
      ? metadata.formats.map(String)
      : [];
    addSemanticCheck(
      checks,
      "marshal-skill-four-formats",
      ["docx", "xlsx", "pptx", "pdf"].every((format) =>
        formats.includes(format),
      ) && new Set(formats).size === 4,
      "Word/Excel/PPT/PDF四种格式均独立生成",
      formats,
    );
    addSemanticCheck(
      checks,
      "marshal-skill-four-artifacts",
      Number(metadata?.artifactCount) === 4,
      "四份制品均由读取接口回读",
      Number(metadata?.artifactCount) || 0,
    );
    addSemanticCheck(
      checks,
      "marshal-skill-four-downloads",
      Number(metadata?.downloadedCount) === 4,
      "四份文件均可鉴权下载且非空",
      Number(metadata?.downloadedCount) || 0,
    );
    addSemanticCheck(
      checks,
      "marshal-skill-format-structure",
      /(?:Word|docx)/iu.test(source) &&
        /(?:Excel|xlsx|\|)/iu.test(source) &&
        /(?:PPT|pptx|---)/iu.test(source) &&
        /(?:PDF|pdf|风险边界)/iu.test(source),
      "四种源稿保留各自可渲染结构",
    );
  } else if (featureKey === "system-kb:manager:image-vision") {
    addSemanticCheck(
      checks,
      "kb-vision-word",
      /NANOWORK/iu.test(source),
      "知识库识别文字NANOWORK",
    );
    addSemanticCheck(
      checks,
      "kb-vision-year",
      /2026/u.test(source),
      "知识库识别数字2026",
    );
    addSemanticCheck(
      checks,
      "kb-vision-number",
      /(?:^|\D)47(?:\D|$)/u.test(source),
      "知识库识别数字47",
    );
    addSemanticCheck(
      checks,
      "kb-vision-color",
      /(?:蓝色|蓝底|蓝色区域|\bblue\b)/iu.test(source),
      "知识库识别蓝色图形",
    );
    addSemanticCheck(
      checks,
      "kb-vision-doc-asset",
      metadata?.kbDocumentPersisted === true &&
        metadata?.knowledgeAssetPersisted === true,
      "知识文档与知识资产均通过读取接口证明落库",
    );
  } else if (featureKey.startsWith("marshal-task:") && !permissionBoundary) {
    contentMathChecks(checks, source, { requireOrders: true });
    addSemanticCheck(
      checks,
      "marshal-task-review-ready",
      metadata?.reviewReady === true,
      "任务终态进入待人工审阅而非冒充已完成",
    );
    const shouldAssign = featureKey.endsWith(":specialist");
    addSemanticCheck(
      checks,
      "marshal-task-specialist-branch",
      metadata?.specialistAssigned === shouldAssign,
      shouldAssign
        ? "指定数字员工分支实际绑定specialist"
        : "直达分部分支保持specialist为空",
    );
    addSemanticCheck(
      checks,
      "marshal-task-flow-readback",
      metadata?.flowReadbackValid === true,
      "任务、产物与结算由业务流接口回读",
    );
  } else if (permissionBoundary) {
    addSemanticCheck(
      checks,
      "permission-role-lane",
      metadata?.roleLaneMatched === true,
      "使用真实分层账号，不用老板账号冒充",
    );
    addSemanticCheck(
      checks,
      "permission-exact-denial",
      metadata?.exactModuleDenial === true,
      "精确403模块无权限",
    );
    addSemanticCheck(
      checks,
      "permission-zero-effects",
      metadata?.zeroBillingAndArtifacts === true,
      "零AI、零计费/hold、零业务产物",
    );
  }

  const errors = checks
    .filter((item) => !item.pass)
    .map((item) => `${item.id}：${item.expectation}`);
  return {
    oracleVersion: "feature-semantic-oracles.v1",
    featureKey,
    scenarioId: scenario?.id || null,
    knownFacts: [...(scenario?.knownFacts || [])],
    forbiddenFacts: [...(scenario?.forbiddenFacts || [])],
    required: [...(scenario?.required || [])],
    checks,
    pass: errors.length === 0,
    errors,
  };
}

// 生成640x360的真实可读PNG验收卡：白底黑字NANOWORK/2026/47，以及蓝色色块上的BLUE。
// 不依赖浏览器、字体或第三方图形库，保证CI和真实矩阵使用同一像素内容。
const VISION_GLYPHS = Object.freeze({
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  N: ["10001", "11001", "10101", "10101", "10011", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
});

function pngCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuffer, data]);
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(pngCrc32(body));
  return Buffer.concat([length, body, crc]);
}

export function buildDeterministicVisionFixturePng() {
  const width = 640;
  const height = 360;
  const pixels = Buffer.alloc(width * height * 3, 255);
  const fill = (x, y, w, h, [red, green, blue]) => {
    for (let py = Math.max(0, y); py < Math.min(height, y + h); py += 1) {
      for (let px = Math.max(0, x); px < Math.min(width, x + w); px += 1) {
        const index = (py * width + px) * 3;
        pixels[index] = red;
        pixels[index + 1] = green;
        pixels[index + 2] = blue;
      }
    }
  };
  const drawText = (value, x, y, scale, color) => {
    let cursor = x;
    for (const character of String(value).toUpperCase()) {
      const glyph = VISION_GLYPHS[character];
      if (!glyph) {
        cursor += scale * 3;
        continue;
      }
      glyph.forEach((row, rowIndex) =>
        [...row].forEach((cell, columnIndex) => {
          if (cell === "1")
            fill(
              cursor + columnIndex * scale,
              y + rowIndex * scale,
              scale,
              scale,
              color,
            );
        }),
      );
      cursor += scale * 6;
    }
  };
  fill(18, 18, 604, 324, [245, 247, 250]);
  fill(30, 30, 580, 8, [15, 23, 42]);
  drawText("NANOWORK", 58, 66, 10, [15, 23, 42]);
  drawText("2026", 70, 170, 11, [15, 23, 42]);
  drawText("47", 370, 170, 16, [15, 23, 42]);
  fill(55, 275, 530, 50, [25, 95, 210]);
  drawText("BLUE", 210, 282, 5, [255, 255, 255]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    const target = row * (1 + width * 3);
    scanlines[target] = 0;
    pixels.copy(scanlines, target + 1, row * width * 3, (row + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function parsePositiveInteger(
  value,
  fallback,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {},
) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export function parseOnlyFilter(value) {
  const source = String(value || "").trim();
  if (!source) return null;
  const known = new Set(FEATURE_DEFINITIONS.map((item) => item.key));
  const selected = new Set();
  for (const key of source
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    if (!known.has(key)) throw new Error(`--only包含未知功能：${key}`);
    selected.add(key);
  }
  return selected;
}

export function buildFeatureJobs(only = null) {
  return FEATURE_DEFINITIONS.filter((job) => !only || only.has(job.key)).map(
    (job) => ({ ...job }),
  );
}

const NETWORK_RETRY_METHODS = new Set(["GET", "HEAD"]);

export async function requestWithRetryPolicy(
  url,
  {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 60_000,
    retry429 = true,
    mutationReplayProof = "",
    requestLabel = "",
    maxNetworkAttempts = 4,
    maxRateLimitResponses = 30,
    fetchFn = globalThis.fetch,
    sleepFn = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    signalFactory = (milliseconds) => AbortSignal.timeout(milliseconds),
  } = {},
) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const label = requestLabel
    ? `${normalizedMethod} ${requestLabel}`
    : `${normalizedMethod} 请求`;
  const replayProof = String(mutationReplayProof || "").trim();
  const networkReplaySafe =
    NETWORK_RETRY_METHODS.has(normalizedMethod) || replayProof.length > 0;
  const networkAttemptLimit = Math.max(1, Number(maxNetworkAttempts) || 1);
  const rateLimitResponseLimit = Math.max(
    1,
    Number(maxRateLimitResponses) || 1,
  );
  let networkFailures = 0;
  let rateLimitResponses = 0;

  while (true) {
    let response;
    let raw;
    try {
      response = await fetchFn(url, {
        method: normalizedMethod,
        headers,
        body,
        signal: signalFactory(timeoutMs),
      });
      // 收到响应头不等于已收到可确认结果；读取响应体中断同样不能重放变更请求。
      raw = await response.text();
    } catch (cause) {
      if (response?.status === 429) {
        // 即使429响应体中断，状态码仍已确认服务端拒绝执行，可继续走限流分支。
        raw = "";
      } else {
        networkFailures += 1;
        if (networkReplaySafe && networkFailures < networkAttemptLimit) {
          await sleepFn(Math.min(5_000, 500 * 2 ** networkFailures));
          continue;
        }
        const ambiguousMutation = !networkReplaySafe;
        const failureMessage = ambiguousMutation
          ? `${label}未收到可确认响应，服务端可能已执行；为避免重复扣费或落库，已禁止自动重放`
          : `${label}网络失败：${cause?.message || String(cause)}`;
        const error = new Error(failureMessage, { cause });
        error.code = ambiguousMutation
          ? "AMBIGUOUS_MUTATION_RESULT"
          : "NETWORK_REQUEST_FAILED";
        error.method = normalizedMethod;
        error.retryable = networkReplaySafe;
        error.networkAttempts = networkFailures;
        throw error;
      }
    }
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = raw;
    }
    if (response.status === 429 && retry429) {
      rateLimitResponses += 1;
      if (rateLimitResponses < rateLimitResponseLimit) {
        // 429是服务端已明确拒绝且未进入业务执行，可安全遵循Retry-After重试。
        const retrySeconds = Math.max(
          1,
          Number(response.headers.get("retry-after")) || 2,
        );
        await sleepFn(Math.min(60_000, retrySeconds * 1000));
        continue;
      }
    }
    if (!response.ok) {
      const message =
        payload?.error || payload?.message || raw || `${response.status}`;
      const error = new Error(`${label}返回${response.status}：${message}`);
      error.status = response.status;
      error.payload = payload;
      error.requestId = response.headers.get("x-request-id");
      throw error;
    }
    return { payload, response };
  }
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function isRealModel(model) {
  const normalized = text(model);
  return normalized.length > 0 && !FORBIDDEN_PROVIDER.test(normalized);
}

export function isYunwuCloudBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    return (
      url.protocol === "https:" &&
      (hostname === "yunwu.ai" || hostname.endsWith(".yunwu.ai"))
    );
  } catch {
    return false;
  }
}

export function isLocalServiceBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    return (
      ["127.0.0.1", "localhost", "::1"].includes(hostname) &&
      ["http:", "https:"].includes(url.protocol)
    );
  } catch {
    return false;
  }
}

export function featureExecutionFingerprint({
  baseUrl,
  tenantId,
  databaseIdentity,
  coreCodeHash,
  scenarioHash,
  providerHash,
}) {
  const payload = {
    baseUrl: String(baseUrl || "").replace(/\/+$/u, ""),
    tenantId: Number(tenantId),
    databaseIdentity: String(databaseIdentity || ""),
    coreCodeHash: String(coreCodeHash || ""),
    scenarioHash: String(scenarioHash || ""),
    providerHash: String(providerHash || ""),
  };
  if (
    !isLocalServiceBaseUrl(payload.baseUrl) ||
    !Number.isSafeInteger(payload.tenantId) ||
    payload.tenantId <= 0 ||
    [
      payload.databaseIdentity,
      payload.coreCodeHash,
      payload.scenarioHash,
      payload.providerHash,
    ].some((item) => !item)
  ) {
    throw new Error("真实功能矩阵执行指纹证据不完整");
  }
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

export function checkpointPassReusable(attempt, executionFingerprint) {
  return (
    attempt?.pass === true &&
    /^[a-f0-9]{64}$/u.test(String(executionFingerprint || "")) &&
    attempt.executionFingerprint === executionFingerprint
  );
}

export function compareTenantSnapshots(before, after) {
  const beforeTables =
    before?.tables && typeof before.tables === "object" ? before.tables : {};
  const afterTables =
    after?.tables && typeof after.tables === "object" ? after.tables : {};
  const names = [
    ...new Set([...Object.keys(beforeTables), ...Object.keys(afterTables)]),
  ].sort();
  const changedTables = names.filter(
    (name) =>
      JSON.stringify(beforeTables[name] ?? null) !==
      JSON.stringify(afterTables[name] ?? null),
  );
  const tenantChanged =
    JSON.stringify(before?.tenant ?? null) !==
    JSON.stringify(after?.tenant ?? null);
  return {
    equal: !tenantChanged && changedTables.length === 0,
    tenantChanged,
    changedTables,
    beforeDigest: String(before?.digest || ""),
    afterDigest: String(after?.digest || ""),
  };
}

export function exactBillingLedgerEvidence({
  evidence,
  expectedCount,
  expectedHoldIds = [],
  balanceBefore,
  balanceAfter,
  allNewLedgerCredits,
}) {
  const rows = Array.isArray(evidence?.rows) ? evidence.rows : [];
  const count = Number(expectedCount);
  const rowIds = rows.map((item) => Number(item?.id));
  const holdIds = rows.map((item) => Number(item?.holdId));
  const expected = [...new Set(expectedHoldIds.map(Number))].sort(
    (a, b) => a - b,
  );
  const observed = [...new Set(holdIds)].sort((a, b) => a - b);
  const errors = [];
  if (!Number.isSafeInteger(count) || count < 1)
    errors.push("期望计费笔数无效");
  if (rows.length !== count)
    errors.push(`计费明细${rows.length}笔，必须精确等于${count}笔`);
  if (
    new Set(rowIds).size !== count ||
    rowIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    errors.push("计费流水ID不唯一或无效");
  }
  if (
    new Set(holdIds).size !== count ||
    holdIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    errors.push("预授权hold ID不唯一或无效");
  }
  if (
    expected.length !== count ||
    JSON.stringify(expected) !== JSON.stringify(observed)
  ) {
    errors.push("响应hold ID与持久化账本不精确一致");
  }
  for (const row of rows) {
    if (row?.holdStatus !== "settled")
      errors.push(`hold#${row?.holdId || "?"}未结算`);
    if (Number(row?.holdLogId) !== Number(row?.id))
      errors.push(`hold#${row?.holdId || "?"}未唯一关联本流水`);
    if (Number(row?.settledCredits) !== Number(row?.credits))
      errors.push(`hold#${row?.holdId || "?"}结算积分与流水不一致`);
  }
  const before = Number(balanceBefore);
  const after = Number(balanceAfter);
  const ledgerCredits = Number(allNewLedgerCredits);
  if (![before, after, ledgerCredits].every(Number.isFinite)) {
    errors.push("缺少可复算的企业余额证据");
  } else if (after !== before - ledgerCredits) {
    errors.push(`余额变动${after - before}与新流水${ledgerCredits}无法对账`);
  }
  return {
    pass: errors.length === 0,
    errors,
    expectedHoldIds: expected,
    observedHoldIds: observed,
  };
}

export function isModulePermissionDenial(status, value) {
  const message =
    typeof value === "string"
      ? value.trim()
      : String(value?.error || value?.message || "").trim();
  return Number(status) === 403 && message === ADVISOR_MODULE_PERMISSION_ERROR;
}

export function isAdvisorModulePermissionDenial(status, value) {
  return isModulePermissionDenial(status, value);
}

function jsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function isFinalBillingState(state) {
  return ["settled", "released", "pending_reconciliation"].includes(
    String(state || ""),
  );
}

export function backgroundContentReady(payload) {
  if (!payload || !["成功", "失败"].includes(payload.status)) return false;
  if (payload.status === "失败") return true;
  const snapshot = jsonObject(payload.snapshot_json);
  return isFinalBillingState(snapshot?.billing?.state);
}

export function automationRunReady(payload) {
  const run = payload?.runs?.[0];
  if (!run || run.status === "运行中") return false;
  if (run.status !== "成功") return true;
  return isFinalBillingState(run?.billing?.state);
}

export function billingEvidenceFromRows(
  rows,
  { afterId = 0, userId = null, features = [] } = {},
) {
  const acceptedFeatures = new Set(features.map(String));
  const matched = (Array.isArray(rows) ? rows : [])
    .filter(
      (row) =>
        Number(row?.id) > Number(afterId || 0) &&
        (userId == null || Number(row?.user_id) === Number(userId)) &&
        (!acceptedFeatures.size ||
          acceptedFeatures.has(String(row?.feature || ""))),
    )
    .sort((a, b) => Number(a.id) - Number(b.id));
  const observedFeatures = [
    ...new Set(matched.map((row) => String(row.feature || "")).filter(Boolean)),
  ];
  const missingFeatures = [...acceptedFeatures].filter(
    (feature) => !observedFeatures.includes(feature),
  );
  return {
    count: matched.length,
    aiMode:
      matched.length && matched.every((row) => row.ai_mode === "api")
        ? "api"
        : matched.at(-1)?.ai_mode || null,
    models: [...new Set(matched.map((row) => text(row.model)).filter(Boolean))],
    inputTokens: matched.reduce(
      (sum, row) => sum + (Number(row.input_tokens) || 0),
      0,
    ),
    outputTokens: matched.reduce(
      (sum, row) => sum + (Number(row.output_tokens) || 0),
      0,
    ),
    costYuan:
      Math.round(
        matched.reduce((sum, row) => sum + (Number(row.cost_yuan) || 0), 0) *
          10000,
      ) / 10000,
    chargedCredits: matched.reduce(
      (sum, row) => sum + (Number(row.credits) || 0),
      0,
    ),
    observedFeatures,
    missingFeatures,
    rows: matched.map((row) => ({
      id: Number(row.id),
      userId: Number(row.user_id),
      feature: row.feature,
      kind: row.kind,
      model: row.model,
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      costYuan: Number(row.cost_yuan) || 0,
      credits: Number(row.credits) || 0,
      aiMode: row.ai_mode,
      createdAt: row.created_at,
    })),
  };
}

function permissionFeatureMatches(definition, feature) {
  const value = String(feature || "");
  if (definition?.kind === "advisor") return value === "老板参谋诊断";
  if (definition?.kind === "marshal_chat")
    return value.startsWith("员工对话·") && value.length > 5;
  if (definition?.kind === "marshal_skill_file")
    return value.startsWith("生成Word·") && value.length > 7;
  if (definition?.kind === "marshal_task")
    return value.startsWith("员工任务·") && value.length > 5;
  return false;
}

function endpointMatchesTemplate(endpoint, template) {
  if (!template) return false;
  const pattern = String(template)
    .split("/")
    .map((part) =>
      part.startsWith(":")
        ? "[^/]+"
        : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${pattern}$`, "u").test(String(endpoint || ""));
}

export function classifyFeatureAttempt(row) {
  if (row.expectation === "authorization_boundary") {
    const definition = FEATURE_DEFINITIONS.find(
      (item) => item.key === row.featureKey,
    );
    const expectedEndpoint = definition?.endpoints?.[0] || null;
    const l1Reasons = [];
    if (row.httpError) l1Reasons.push(`HTTP：${row.httpError}`);
    if (row.executionError) l1Reasons.push(`执行：${row.executionError}`);
    if (row.providerPolicy !== "authorization_boundary")
      l1Reasons.push("用例未声明为权限边界策略");
    if (row.externalSideEffects !== false)
      l1Reasons.push("外部副作用边界未被明确证明为false");
    if (row.requestReachedLocalService !== true)
      l1Reasons.push("未证明请求到达真实本地服务");
    if (
      !expectedEndpoint ||
      row.endpointTemplate !== expectedEndpoint ||
      !endpointMatchesTemplate(row.endpoint, expectedEndpoint) ||
      row.method !== "POST"
    ) {
      l1Reasons.push(
        `未通过${expectedEndpoint ? `POST ${expectedEndpoint}` : "已登记"}验证真实入口`,
      );
    }
    if (row.modulePermissionAbsent !== true)
      l1Reasons.push("验收账号仍拥有被测模块，权限边界前提不成立");
    if (!isModulePermissionDenial(row.httpStatus, row.boundaryError)) {
      l1Reasons.push(
        `权限拦截必须为精确的403模块无权限，实际${row.httpStatus || "missing"}：${text(row.boundaryError) || "missing"}`,
      );
    }
    if (row.artifactProbeComplete !== true)
      l1Reasons.push("权限后读取探针未完成");
    if (!isModulePermissionDenial(row.readbackHttpStatus, row.readbackError)) {
      l1Reasons.push(
        `权限后读取亦必须为精确的403模块无权限，实际${row.readbackHttpStatus || "missing"}：${text(row.readbackError) || "missing"}`,
      );
    }
    if (
      row.terminalStatus !== "authorization_denied" ||
      row.terminalValid !== true
    ) {
      l1Reasons.push(`权限边界终态不合格：${row.terminalStatus || "missing"}`);
    }
    if (
      row.contractValid !== true ||
      (Array.isArray(row.contractErrors) && row.contractErrors.length)
    ) {
      l1Reasons.push("权限边界证据契约未通过");
    }
    if (row.businessArtifactCreated !== false)
      l1Reasons.push("请求产生了会话、消息或其他业务产物");
    if (row.businessArtifactAbsenceProven !== true)
      l1Reasons.push("未用路由前模块守卫+租户数据库全表快照证明零业务产物");
    const newBillingRows = Number(
      row.businessArtifactProof?.newBillingOrHoldRows ??
        row.businessArtifactProof?.newAdvisorBillingOrHoldRows,
    );
    if (
      row.businessArtifactProof?.strategy !==
        "pre_handler_guard_plus_full_tenant_database_snapshot" ||
      row.businessArtifactProof?.guardBeforeHandler !== true ||
      row.businessArtifactProof?.databaseSnapshotEqual !== true ||
      !Array.isArray(row.businessArtifactProof?.changedTables) ||
      row.businessArtifactProof.changedTables.length !== 0 ||
      Number(row.businessArtifactProof?.responseBusinessIdCount) !== 0 ||
      newBillingRows !== 0
    ) {
      l1Reasons.push("零业务产物的可审计证据链不完整");
    }
    if (row.persistent !== false)
      l1Reasons.push("无权请求的业务持久化证据不是false");
    if (!Array.isArray(row.businessIds)) l1Reasons.push("缺少空业务ID列表证据");
    else if (row.businessIds.length) l1Reasons.push("无权请求返回了业务ID");
    if (row.artifactReadbackFound !== false)
      l1Reasons.push("权限后读取未明确证明本轮会话产物为零");
    if (row.billingAuditComplete !== true)
      l1Reasons.push("计费/预授权水位审计未完成");
    if (
      row.billingProbeBeforeId == null ||
      row.billingProbeAfterId == null ||
      !Number.isSafeInteger(Number(row.billingProbeBeforeId)) ||
      Number(row.billingProbeBeforeId) < 0 ||
      !Number.isSafeInteger(Number(row.billingProbeAfterId)) ||
      Number(row.billingProbeAfterId) < 0 ||
      Number(row.billingProbeAfterId) < Number(row.billingProbeBeforeId)
    ) {
      l1Reasons.push("计费/预授权审计缺少前后有效流水水位");
    }
    const expectedFeatures = Array.isArray(row.expectedFeatures)
      ? row.expectedFeatures
      : [];
    if (
      expectedFeatures.length !== 1 ||
      !permissionFeatureMatches(definition, expectedFeatures[0])
    ) {
      l1Reasons.push("计费审计未精确限定到本入口的功能名称");
    }
    const expectedAbsentFeatures = Array.isArray(
      row.billingEvidenceExpectedAbsentFeatures,
    )
      ? row.billingEvidenceExpectedAbsentFeatures
      : [];
    if (
      expectedAbsentFeatures.length !== 1 ||
      expectedAbsentFeatures[0] !== expectedFeatures[0]
    ) {
      l1Reasons.push("计费读取未证明本入口精确功能流水为零");
    }
    if (Number(row.expectedBillingCount) !== 0)
      l1Reasons.push("权限边界的期望计费笔数必须为0");
    const billingRows = Array.isArray(row.billingEvidence)
      ? row.billingEvidence
      : [];
    if (!Array.isArray(row.billingEvidence))
      l1Reasons.push("缺少空计费流水列表证据");
    if (
      !Number.isSafeInteger(Number(row.billingEvidenceCount)) ||
      Number(row.billingEvidenceCount) !== 0 ||
      billingRows.length !== 0
    ) {
      l1Reasons.push(
        `无权请求新增了${Math.max(Number(row.billingEvidenceCount) || 0, billingRows.length)}笔计费/预授权流水`,
      );
    }
    if (!Array.isArray(row.billingHoldIds))
      l1Reasons.push("缺少空holdId列表证据");
    else if (row.billingHoldIds.length) l1Reasons.push("无权请求产生了holdId");
    if (row.billingState != null && row.billingState !== "not_held")
      l1Reasons.push(`无权请求出现计费状态${row.billingState}`);
    if (row.aiMode != null) l1Reasons.push(`无权请求出现ai_mode=${row.aiMode}`);
    const models = Array.isArray(row.models)
      ? row.models.filter(Boolean)
      : [row.model].filter(Boolean);
    if (models.length)
      l1Reasons.push(`无权请求出现模型证据：${models.join("、")}`);
    if (
      (Number(row.inputTokens) || 0) !== 0 ||
      (Number(row.outputTokens) || 0) !== 0
    )
      l1Reasons.push("无权请求产生了token用量");
    if (
      (Number(row.costYuan) || 0) !== 0 ||
      (Number(row.chargedCredits) || 0) !== 0
    )
      l1Reasons.push("无权请求产生了成本或积分扣费");
    if ((Number(row.resultChars) || 0) !== 0 || row.resultHash)
      l1Reasons.push("无权请求意外产生了AI正文");
    const l2Reasons = [];
    if (row.l2Pass !== true) l2Reasons.push("权限边界L2业务语义验收未通过");
    if (
      row.semanticEvidence?.oracleVersion !== "feature-semantic-oracles.v1" ||
      row.semanticEvidence?.featureKey !== row.featureKey ||
      !Array.isArray(row.semanticEvidence?.checks) ||
      row.semanticEvidence.checks.length === 0
    ) {
      l2Reasons.push("缺少本功能可审计的L2 oracle检查证据");
    }
    if (Array.isArray(row.semanticErrors) && row.semanticErrors.length)
      l2Reasons.push(...row.semanticErrors);
    const l1Pass = l1Reasons.length === 0;
    const l2Pass = l2Reasons.length === 0;
    const pass = l1Pass && l2Pass;
    return {
      l1Pass,
      l2Pass,
      pass,
      verdict: pass ? "PASS_PERMISSION_BOUNDARY" : "FAIL_PERMISSION_BOUNDARY",
      l1FailureReasons: l1Reasons,
      l2FailureReasons: l2Reasons,
      failureReasons: [...l1Reasons, ...l2Reasons],
    };
  }

  const l1Reasons = [];
  if (row.httpError) l1Reasons.push(`HTTP：${row.httpError}`);
  if (row.executionError) l1Reasons.push(`执行：${row.executionError}`);
  if (row.externalSideEffects !== false)
    l1Reasons.push("外部副作用边界未被明确证明为false");
  if (row.reviewPolicy === "boss_test_zero_approvals") {
    const before = row.approvalCountsBefore;
    const after = row.approvalCountsAfter;
    if (!before || !after || row.approvalDelta == null || row.reviewPendingDelta == null) {
      l1Reasons.push("FAIL_NO_REVIEW_POLICY：缺少执行前后审批/待审阅计数");
    } else {
      if (Number(row.approvalDelta) !== 0) {
        l1Reasons.push(`FAIL_NO_REVIEW_POLICY：审批记录增量=${row.approvalDelta}，Boss测试期必须为0`);
      }
      if (Number(row.reviewPendingDelta) !== 0) {
        l1Reasons.push(`FAIL_NO_REVIEW_POLICY：待审阅任务增量=${row.reviewPendingDelta}，不得停在待审阅`);
      }
      if (["待审核", "待审阅"].includes(String(row.terminalStatus || ""))) {
        l1Reasons.push(`FAIL_NO_REVIEW_POLICY：功能终态=${row.terminalStatus}，不得仅停在待审核/待审阅`);
      }
    }
  }
  if (row.persistent !== true)
    l1Reasons.push("业务产物未通过读取接口证明已持久化");
  if (row.terminalValid !== true)
    l1Reasons.push(`业务终态不合格：${row.terminalStatus || "missing"}`);
  if (row.contractValid !== true)
    l1Reasons.push(
      `业务输出契约未通过${row.contractErrors?.length ? `：${row.contractErrors.join("；")}` : ""}`,
    );
  if (Array.isArray(row.contractErrors) && row.contractErrors.length) {
    l1Reasons.push(
      `业务输出仍有未解决的契约错误：${row.contractErrors.join("；")}`,
    );
  }
  if (
    !(Number(row.resultChars) > 0) ||
    !/^[a-f0-9]{64}$/u.test(text(row.resultHash))
  ) {
    l1Reasons.push("业务结果为空或缺少内容哈希，HTTP成功不能替代有效产出");
  }

  if (row.providerPolicy === "inherited") {
    if (row.providerLineagePass !== true)
      l1Reasons.push("文件制品缺少同轮真实云API来源链路");
  }
  const expectedFeatures = Array.isArray(row.expectedFeatures)
    ? row.expectedFeatures.map(String).filter(Boolean)
    : [];
  if (!expectedFeatures.length)
    l1Reasons.push("缺少本功能的精确计费特征，无法排除并发流水串单");
  if (row.aiMode !== "api")
    l1Reasons.push(`ai_mode=${row.aiMode || "missing"}，不是真实API`);
  const models = Array.isArray(row.models)
    ? row.models
    : [row.model].filter(Boolean);
  if (!models.length || models.some((model) => !isRealModel(model)))
    l1Reasons.push("缺少真实模型证据或命中mock/template/fallback");
  if (!(Number(row.inputTokens) > 0)) l1Reasons.push("真实输入token缺失或为0");
  if (!(Number(row.outputTokens) > 0)) l1Reasons.push("真实输出token缺失或为0");
  if (row.billingState !== "settled")
    l1Reasons.push(`计费状态=${row.billingState || "missing"}，未结算`);
  const expectedCount = Math.max(1, Number(row.expectedBillingCount) || 1);
  const billingHoldIds = Array.isArray(row.billingHoldIds)
    ? [
        ...new Set(
          row.billingHoldIds
            .map(Number)
            .filter((id) => Number.isSafeInteger(id) && id > 0),
        ),
      ]
    : [];
  if (billingHoldIds.length !== expectedCount) {
    l1Reasons.push(
      `响应/持久化快照中的holdId证据${billingHoldIds.length}笔，必须精确等于${expectedCount}笔`,
    );
  }
  if ((Number(row.billingEvidenceCount) || 0) !== expectedCount) {
    l1Reasons.push(
      `计费证据${Number(row.billingEvidenceCount) || 0}笔，必须精确等于${expectedCount}笔`,
    );
  }
  if (row.exactBillingLedgerPass !== true) {
    l1Reasons.push(
      ...(Array.isArray(row.exactBillingLedgerErrors) &&
      row.exactBillingLedgerErrors.length
        ? row.exactBillingLedgerErrors.map((item) => `账本：${item}`)
        : ["未通过唯一hold/流水/余额精确对账"]),
    );
  }
  if (
    Array.isArray(row.billingEvidenceMissingFeatures) &&
    row.billingEvidenceMissingFeatures.length
  ) {
    l1Reasons.push(
      `缺少功能计费流水：${row.billingEvidenceMissingFeatures.join("、")}`,
    );
  }
  const billingRows = Array.isArray(row.billingEvidence)
    ? row.billingEvidence
    : [];
  if (billingRows.length !== expectedCount) {
    l1Reasons.push(
      `可审计计费明细${billingRows.length}笔，必须精确等于${expectedCount}笔`,
    );
  }
  const uniqueBillingLogIds = new Set(
    billingRows
      .map((item) => Number(item?.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
  if (uniqueBillingLogIds.size !== expectedCount) {
    l1Reasons.push(
      `唯一有效计费流水ID${uniqueBillingLogIds.size}笔，必须精确等于${expectedCount}笔`,
    );
  }
  for (const billingRow of billingRows) {
    if (billingRow.aiMode !== "api")
      l1Reasons.push(`计费流水#${billingRow.id || "?"} ai_mode不是api`);
    if (!isRealModel(billingRow.model))
      l1Reasons.push(`计费流水#${billingRow.id || "?"}缺少真实模型`);
    if (!(Number(billingRow.inputTokens) > 0))
      l1Reasons.push(`计费流水#${billingRow.id || "?"}输入token为0`);
    if (!(Number(billingRow.outputTokens) > 0))
      l1Reasons.push(`计费流水#${billingRow.id || "?"}输出token为0`);
  }
  const observedFeatures = new Set(
    billingRows.map((item) => String(item?.feature || "")).filter(Boolean),
  );
  const missingFromRows = expectedFeatures.filter(
    (feature) => !observedFeatures.has(feature),
  );
  if (missingFromRows.length)
    l1Reasons.push(`计费明细未覆盖：${missingFromRows.join("、")}`);

  if (row.templateFingerprintDetected === true)
    l1Reasons.push("输出命中本地模板指纹，不能作为真实云交付通过");
  if (
    !Array.isArray(row.businessIds) ||
    !row.businessIds.length ||
    row.businessIds.some(
      (id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0,
    )
  ) {
    l1Reasons.push("缺少有效业务持久化ID");
  }
  const l2Reasons = [];
  if (row.l2Pass !== true) l2Reasons.push("本功能L2业务语义验收未通过");
  if (
    row.semanticEvidence?.oracleVersion !== "feature-semantic-oracles.v1" ||
    row.semanticEvidence?.featureKey !== row.featureKey ||
    !Array.isArray(row.semanticEvidence?.checks) ||
    row.semanticEvidence.checks.length === 0
  ) {
    l2Reasons.push("缺少本功能可审计的L2 oracle检查证据");
  }
  if (Array.isArray(row.semanticErrors) && row.semanticErrors.length)
    l2Reasons.push(...row.semanticErrors);
  const l1Pass = l1Reasons.length === 0;
  const l2Pass = l2Reasons.length === 0;
  const pass = l1Pass && l2Pass;
  return {
    l1Pass,
    l2Pass,
    pass,
    verdict: pass ? "PASS_REAL_API" : "FAIL_REAL_API",
    l1FailureReasons: l1Reasons,
    l2FailureReasons: l2Reasons,
    failureReasons: [...l1Reasons, ...l2Reasons],
  };
}

export function sanitizeEvidence(value, seen = new WeakSet()) {
  if (typeof value === "string")
    return value.replace(SECRET_VALUE, "[REDACTED]");
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const sanitized = Array.isArray(value)
    ? value.map((item) => sanitizeEvidence(item, seen))
    : Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !SECRET_KEY.test(key))
          .map(([key, item]) => [key, sanitizeEvidence(item, seen)]),
      );
  // WeakSet只表示当前递归链，不把同一对象的合法重复引用误判为循环。
  seen.delete(value);
  return sanitized;
}

export function summarizeFeatureState(state) {
  const attempts = Object.values(state.jobs || {})
    .map((job) => job.latest)
    .filter(Boolean);
  const completedVerdicts = new Set([
    "PASS_REAL_API",
    "FAIL_REAL_API",
    "PASS_PERMISSION_BOUNDARY",
    "FAIL_PERMISSION_BOUNDARY",
  ]);
  const realApiAttempts = attempts.filter(
    (item) => item.expectation !== "authorization_boundary",
  );
  const permissionAttempts = attempts.filter(
    (item) => item.expectation === "authorization_boundary",
  );
  return {
    total: attempts.length,
    passed: attempts.filter((item) => item.pass === true).length,
    failed: attempts.filter((item) =>
      ["FAIL_REAL_API", "FAIL_PERMISSION_BOUNDARY"].includes(item.verdict),
    ).length,
    running: attempts.filter((item) => !completedVerdicts.has(item.verdict))
      .length,
    realApi: {
      total: realApiAttempts.length,
      passed: realApiAttempts.filter((item) => item.verdict === "PASS_REAL_API")
        .length,
      failed: realApiAttempts.filter((item) => item.verdict === "FAIL_REAL_API")
        .length,
    },
    permissionBoundaries: {
      total: permissionAttempts.length,
      passed: permissionAttempts.filter(
        (item) => item.verdict === "PASS_PERMISSION_BOUNDARY",
      ).length,
      failed: permissionAttempts.filter(
        (item) => item.verdict === "FAIL_PERMISSION_BOUNDARY",
      ).length,
    },
    levels: {
      l1Passed: attempts.filter((item) => item.l1Pass === true).length,
      l1Failed: attempts.filter((item) => item.l1Pass === false).length,
      l2Passed: attempts.filter((item) => item.l2Pass === true).length,
      l2Failed: attempts.filter((item) => item.l2Pass === false).length,
    },
    byVerdict: Object.fromEntries(
      [...completedVerdicts].map((verdict) => [
        verdict,
        attempts.filter((item) => item.verdict === verdict).length,
      ]),
    ),
    byCategory: Object.fromEntries(
      [...new Set(attempts.map((item) => item.category).filter(Boolean))].map(
        (category) => [
          category,
          {
            total: attempts.filter((item) => item.category === category).length,
            passed: attempts.filter(
              (item) => item.category === category && item.pass === true,
            ).length,
          },
        ],
      ),
    ),
    tokens: {
      input: attempts.reduce(
        (sum, item) => sum + (Number(item.inputTokens) || 0),
        0,
      ),
      output: attempts.reduce(
        (sum, item) => sum + (Number(item.outputTokens) || 0),
        0,
      ),
    },
    costYuan:
      Math.round(
        attempts.reduce((sum, item) => sum + (Number(item.costYuan) || 0), 0) *
          10000,
      ) / 10000,
    credits: attempts.reduce(
      (sum, item) => sum + (Number(item.chargedCredits) || 0),
      0,
    ),
  };
}

export function createFeatureState({ baseUrl, selectedJobs, concurrency }) {
  return {
    schemaVersion: REAL_FEATURE_MATRIX_SCHEMA,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    evidencePolicy: {
      provider: "yunwu_real_cloud_api_only",
      acceptanceLayers: {
        l1: "local_route_persistence_terminal_billing_and_real_provider_evidence",
        l2: "deterministic_business_semantic_oracle_over_known_and_forbidden_facts",
        finalPass: "l1_and_l2_must_both_pass",
      },
      requiresPositiveTextTokens: true,
      requiresPositiveTokensForEveryBillingRow: true,
      requiresSettledBilling: true,
      requiresEndpointHoldIds: true,
      requiresPersistenceReadback: true,
      asyncSuccessRequiresFinalizedBilling: true,
      http200AloneNeverPasses: true,
      rejectsTemplateFingerprint: true,
      permissionBoundaries: {
        keys: [...AUTHORIZATION_BOUNDARY_KEYS],
        requiresLocalHttp403: true,
        requiresExactModulePermissionError: true,
        requiresZeroNewBillingOrHoldRows: true,
        requiresNoBusinessArtifact: true,
      },
      requestReplaySafety: {
        networkRetryMethods: ["GET", "HEAD"],
        mutationsDefault: "never_replay_ambiguous_result",
        mutationOptInRequires: "explicit_idempotency_proof_at_call_site",
        http429: "retry_after_allowed_when_server_explicitly_rejected",
      },
      externalPublish: false,
      scopeClaim:
        "仅声称36条安全功能矩阵（31条真实AI交付+5条权限边界），不声称已测所有系统功能或外部副作用",
    },
    inventory: {
      runnable: FEATURE_DEFINITIONS.map((item) => ({ ...item })),
      excluded: EXCLUDED_FEATURES.map((item) => ({
        ...item,
        endpoints: [...item.endpoints],
      })),
      externalSideEffectsNotTested: EXCLUDED_FEATURES.map((item) => ({
        ...item,
        endpoints: [...item.endpoints],
      })),
      nonAiCompanions: [...NON_AI_COMPANION_ENDPOINTS],
    },
    run: { baseUrl, selectedJobs, concurrency },
    jobs: {},
    summary: { total: 0, passed: 0, failed: 0, running: 0 },
  };
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeFeatureState(input) {
  if (!plainObject(input)) throw new Error("断点文件必须是JSON对象");
  const sourceSchema = String(input.schemaVersion || "");
  if (
    sourceSchema !== REAL_FEATURE_MATRIX_SCHEMA &&
    !LEGACY_REAL_FEATURE_MATRIX_SCHEMAS.includes(sourceSchema)
  ) {
    throw new Error(`断点文件版本不兼容：${sourceSchema || "missing"}`);
  }
  const state = sanitizeEvidence(input);
  const repairedLatestKeys = [];
  state.jobs = plainObject(state.jobs) ? state.jobs : {};
  for (const [key, rawJob] of Object.entries(state.jobs)) {
    const job = plainObject(rawJob) ? rawJob : {};
    const definition = FEATURE_DEFINITIONS.find((item) => item.key === key);
    const normalizeAttempt = (item) => {
      const safe = sanitizeEvidence(item);
      if (!definition) return safe;
      const enriched = {
        ...safe,
        expectation: definition.expectation,
        ...(sourceSchema !== REAL_FEATURE_MATRIX_SCHEMA ||
        safe.l1Pass == null ||
        safe.l2Pass == null
          ? { legacyVerdict: safe.verdict || null }
          : {}),
      };
      if (
        sourceSchema !== REAL_FEATURE_MATRIX_SCHEMA ||
        safe.expectation !== definition.expectation ||
        safe.l1Pass == null ||
        safe.l2Pass == null
      ) {
        return { ...enriched, ...classifyFeatureAttempt(enriched) };
      }
      return safe;
    };
    const attempts = (Array.isArray(job.attempts) ? job.attempts : [])
      .filter(plainObject)
      .map(normalizeAttempt);
    let latest = plainObject(job.latest)
      ? normalizeAttempt(job.latest)
      : attempts.at(-1) || null;
    if (!plainObject(job.latest) && latest) repairedLatestKeys.push(key);
    latest = latest ? sanitizeEvidence(latest) : null;
    state.jobs[key] = {
      ...job,
      attempts,
      ...(latest ? { latest } : {}),
    };
  }
  state.schemaVersion = REAL_FEATURE_MATRIX_SCHEMA;
  state.evidencePolicy = {
    ...(plainObject(state.evidencePolicy) ? state.evidencePolicy : {}),
    permissionBoundaries: {
      keys: [...AUTHORIZATION_BOUNDARY_KEYS],
      requiresLocalHttp403: true,
      requiresExactModulePermissionError: true,
      requiresZeroNewBillingOrHoldRows: true,
      requiresNoBusinessArtifact: true,
    },
    requestReplaySafety: {
      networkRetryMethods: ["GET", "HEAD"],
      mutationsDefault: "never_replay_ambiguous_result",
      mutationOptInRequires: "explicit_idempotency_proof_at_call_site",
      http429: "retry_after_allowed_when_server_explicitly_rejected",
    },
    acceptanceLayers: {
      l1: "local_route_persistence_terminal_billing_and_real_provider_evidence",
      l2: "deterministic_business_semantic_oracle_over_known_and_forbidden_facts",
      finalPass: "l1_and_l2_must_both_pass",
    },
    scopeClaim:
      "仅声称36条安全功能矩阵（31条真实AI交付+5条权限边界），不声称已测所有系统功能或外部副作用",
  };
  state.inventory = {
    ...(plainObject(state.inventory) ? state.inventory : {}),
    runnable: FEATURE_DEFINITIONS.map((item) => ({ ...item })),
    excluded: EXCLUDED_FEATURES.map((item) => ({
      ...item,
      endpoints: [...item.endpoints],
    })),
    externalSideEffectsNotTested: EXCLUDED_FEATURES.map((item) => ({
      ...item,
      endpoints: [...item.endpoints],
    })),
  };
  if (
    sourceSchema !== REAL_FEATURE_MATRIX_SCHEMA ||
    repairedLatestKeys.length
  ) {
    state.checkpointMigration = {
      fromSchema: sourceSchema,
      toSchema: REAL_FEATURE_MATRIX_SCHEMA,
      repairedLatestKeys,
      migratedAt: new Date().toISOString(),
    };
  }
  state.summary = summarizeFeatureState(state);
  return {
    state,
    changed:
      sourceSchema !== REAL_FEATURE_MATRIX_SCHEMA ||
      repairedLatestKeys.length > 0,
    repairedLatestKeys,
  };
}

export function mergeFeatureAttempt(state, key, attempt) {
  const safeAttempt = sanitizeEvidence(attempt);
  const previous = state.jobs?.[key] || { attempts: [] };
  state.jobs ||= {};
  state.jobs[key] = {
    attempts: [
      ...(Array.isArray(previous.attempts) ? previous.attempts : []),
      safeAttempt,
    ],
    latest: sanitizeEvidence(safeAttempt),
  };
  state.updatedAt = new Date().toISOString();
  state.summary = summarizeFeatureState(state);
  return state;
}

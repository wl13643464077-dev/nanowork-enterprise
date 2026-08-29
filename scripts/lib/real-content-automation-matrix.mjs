import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { contentProfileIntegrityEvidence } from "./real-employee-matrix.mjs";

export const REAL_CONTENT_AUTOMATION_MATRIX_SCHEMA =
  "nanowork.real-content-automation-matrix.v2";

export const CONTENT_AUTOMATION_MODES = Object.freeze([
  "immediate",
  "scheduled",
]);

// 这些是真实验收输入，不是模型输出的事后答案。每个岗位都使用自己允许的任务类型，
// 并把已知事实、未知项和“不发布”边界写进原始需求，防止用空泛题目测试岗位。
export const CONTENT_AUTOMATION_EMPLOYEE_CASES = Object.freeze([
  Object.freeze({
    idx: 0,
    key: "trend",
    name: "趋势官",
    taskType: "趋势简报",
    topic: "餐饮门店内容趋势核验",
    requirement:
      "只能使用本轮可核验公开来源判断趋势。请给出候选趋势、证据链接、与餐饮门店的适配判断、风险和人工复核清单；没有可引用证据就标记待核验，不得虚构。只生成待审阅内容，不发布。",
  }),
  Object.freeze({
    idx: 1,
    key: "research",
    name: "情报员",
    taskType: "核验报告",
    topic: "团队聚餐需求事实核验",
    requirement:
      "已知：目标人群是6至10人团队聚餐组织者；真实菜单、价格、库存、门店容量均未提供。请输出事实/未知分层、可核验来源、核验步骤与负责人。不得自行补写价格或顾客证言，不发布。",
  }),
  Object.freeze({
    idx: 2,
    key: "benchmark",
    name: "拆解师",
    taskType: "爆款拆解",
    topic: "餐饮老板周复盘内容拆解",
    requirement:
      "待拆解样本A：用经营原始凭证讲成本异常；样本B：用问题-数据-动作结构讲周复盘。两个样本都没有提供阅读量、转化率或评论原文。请拆结构、钩子、用户语言与可复用方法，效果数据一律列为待核验，不发布。",
  }),
  Object.freeze({
    idx: 3,
    key: "draft",
    name: "撰稿人",
    taskType: "文案初稿",
    topic: "老板一周经营复盘",
    requirement:
      "已知营业额100000元、采购入库35000元、订单2000单，可计算采购入库占营业额35%、客单收入50元/单。期初/期末库存、报损、调拨未知，不得把35%写成食材成本率。输出待审阅初稿和发布前核验清单，不发布。",
  }),
  Object.freeze({
    idx: 4,
    key: "style",
    name: "文风师",
    taskType: "文风改写",
    topic: "餐饮老板直白克制文风改写",
    requirement:
      "原文：“本周营业额100000元，采购入库35000元，订单2000单。期初期末库存、报损和调拨还没有核对，先不下食材成本率结论。”保留全部事实边界，改成一线餐饮老板直白、克制、可执行的口吻，附人设一致性检查，不发布。",
  }),
  Object.freeze({
    idx: 5,
    key: "media",
    name: "多媒体师",
    taskType: "多媒体素材方案",
    topic: "门店周复盘多媒体素材方案",
    requirement:
      "自有素材只确认四类：门头、后厨备餐、菜品成品、老板口播。顾客肖像授权、背景音乐授权、价格与促销都未确认。请给出分镜、画面/字幕、素材缺口、授权检查和交付规格；同时调用已配置的真实AI图片provider生成1张可追溯的内部待审阅配图，不生视频、不对外发布、不发布。",
  }),
  Object.freeze({
    idx: 6,
    key: "cover",
    name: "封面师",
    taskType: "封面方案",
    topic: "老板周复盘封面方案",
    requirement:
      "主题是“营业额看起来正常，但成本结论还差库存证据”。已知营业额100000元、采购入库35000元；食材成本率未确定。给出封面文案、版式、视觉钩子、备选和人工校验清单；同时调用已配置的真实AI图片provider生成1张可追溯的内部待审阅封面，不冒充外部发布成功、不操作账号、不发布。",
  }),
  Object.freeze({
    idx: 7,
    key: "deck",
    name: "演绎师",
    taskType: "HTML演绎稿",
    topic: "门店一周经营复盘演示",
    requirement:
      "用6个屏幕以内呈现：口径、已知数据、未知数据、纠偏计算、下周动作、审阅门槛。已知营业额100000元、采购入库35000元、订单2000单；库存/报损/调拨未知。输出完整可审阅HTML与演讲逻辑，不载入外部脚本，不发布。",
  }),
  Object.freeze({
    idx: 8,
    key: "publish",
    name: "分发官",
    taskType: "平台发布包",
    topic: "经营复盘多平台待审发布包",
    requirement:
      "基础稿已确认事实：营业额100000元、采购入库35000元、订单2000单；库存/报损/调拨未知。为视频号、小红书、朋友圈生成差异化发布包、发布终审清单和可回滚计划。只生成包，禁止操作账号、外发或登记已发布。",
  }),
  Object.freeze({
    idx: 9,
    key: "retro",
    name: "复盘官",
    taskType: "复盘报告",
    topic: "内容运营T+7复盘",
    requirement:
      "已知发布3条，曝光分别为1200、900、1500，点赞分别为48、36、75，收藏分别为12、9、21；线索、到店、成交与平台完整评论原文未提供。请分离真实指标、未知项、可验证判断、下一轮选题建议与回流字段；不冒充成交归因，不发布。",
  }),
]);

const CASE_BY_IDX = new Map(
  CONTENT_AUTOMATION_EMPLOYEE_CASES.map((item) => [item.idx, item]),
);
const REAL_MODEL_DENY =
  /(?:mock|template|fallback|fixture|offline|no[-_ ]?network)/iu;
const WEB_REQUIRED_EMPLOYEES = new Set([0, 1, 2]);
const TRUSTED_WEB_PROVIDERS = new Set([
  "博查",
  "Tavily",
  "Serper",
  "Google News RSS",
  "DuckDuckGo",
]);
const SECRET_FIELD =
  /(?:authorization|password|passphrase|api[_-]?key|secret|jwt|cookie|credential|session)/iu;
const SECRET_VALUE_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{8,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
  /\b(?:authorization|api[_-]?key|token|jwt|cookie|credential)\s*[:=]\s*[^\s,;]+/giu,
]);

function parseIntegerToken(token) {
  if (!/^\d+$/u.test(token)) throw new Error(`内容员工编号无效：${token}`);
  const value = Number(token);
  if (!Number.isInteger(value) || value < 0 || value > 9) {
    throw new Error(`内容员工编号必须在0-9之间：${token}`);
  }
  return value;
}

export function parseContentEmployeeSelection(value = "0-9") {
  const input = String(value || "")
    .trim()
    .toLowerCase();
  if (!input || input === "all")
    return CONTENT_AUTOMATION_EMPLOYEE_CASES.map((item) => item.idx);
  const selected = new Set();
  for (const token of input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const range = token.match(/^(\d+)-(\d+)$/u);
    if (!range) {
      selected.add(parseIntegerToken(token));
      continue;
    }
    const start = parseIntegerToken(range[1]);
    const end = parseIntegerToken(range[2]);
    if (end < start) throw new Error(`内容员工范围不能倒序：${token}`);
    for (let idx = start; idx <= end; idx += 1) selected.add(idx);
  }
  if (!selected.size) throw new Error("至少选择一名内容员工");
  return [...selected].sort((left, right) => left - right);
}

export function parseAutomationModes(value = "immediate,scheduled") {
  const input = String(value || "")
    .trim()
    .toLowerCase();
  const modes = input
    ? input
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  if (!modes.length) throw new Error("至少选择一种内容自动化模式");
  const selected = new Set();
  for (const mode of modes) {
    if (!CONTENT_AUTOMATION_MODES.includes(mode)) {
      throw new Error(`内容自动化模式无效：${mode}`);
    }
    selected.add(mode);
  }
  return CONTENT_AUTOMATION_MODES.filter((mode) => selected.has(mode));
}

export function contentAutomationCase(idx) {
  const found = CASE_BY_IDX.get(Number(idx));
  if (!found) throw new Error(`内容员工不存在：${idx}`);
  return found;
}

export function buildContentAutomationJobs({
  employees = CONTENT_AUTOMATION_EMPLOYEE_CASES.map((item) => item.idx),
  modes = CONTENT_AUTOMATION_MODES,
} = {}) {
  return employees.flatMap((idx) =>
    modes.map((mode) => {
      const employee = contentAutomationCase(idx);
      return Object.freeze({
        key: `content:${employee.idx}:${mode}`,
        mode,
        trigger: mode,
        employee,
      });
    }),
  );
}

export function assertIsolatedDatabasePaths(sourceDb, workDb) {
  const source = path.resolve(String(sourceDb || ""));
  const work = path.resolve(String(workDb || ""));
  if (!sourceDb || !workDb)
    throw new Error("必须同时提供源数据库和隔离工作数据库");
  if (source === work)
    throw new Error("隔离工作数据库不得与源数据库是同一路径");
  if (work.startsWith(`${source}${path.sep}`)) {
    throw new Error("隔离工作数据库不得建在源数据库文件内");
  }
  return { source, work };
}

function canonicalPathAllowMissing(value) {
  const resolved = path.resolve(String(value || ""));
  if (fs.existsSync(resolved)) return fs.realpathSync.native(resolved);

  const missingParts = [path.basename(resolved)];
  let existingParent = path.dirname(resolved);
  while (!fs.existsSync(existingParent)) {
    const parent = path.dirname(existingParent);
    if (parent === existingParent) break;
    missingParts.unshift(path.basename(existingParent));
    existingParent = parent;
  }
  const canonicalParent = fs.realpathSync.native(existingParent);
  return path.join(canonicalParent, ...missingParts);
}

export function assertSafeAutomationOutputPath({
  sourceDb,
  outputPath,
  isolatedDb = null,
} = {}) {
  if (!sourceDb || !outputPath)
    throw new Error("必须同时提供源数据库和JSON证据输出路径");

  const source = canonicalPathAllowMissing(sourceDb);
  const output = canonicalPathAllowMissing(outputPath);
  if (
    path.extname(path.resolve(String(outputPath))).toLowerCase() !== ".json"
  ) {
    throw new Error("内容自动化验收证据的--out必须是.json文件");
  }
  if (
    fs.existsSync(path.resolve(outputPath)) &&
    !fs.statSync(path.resolve(outputPath)).isFile()
  ) {
    throw new Error("内容自动化验收证据的--out不得指向目录");
  }
  if (output === source) {
    throw new Error("内容自动化验收证据不得覆盖源数据库");
  }

  const isolated = isolatedDb ? canonicalPathAllowMissing(isolatedDb) : null;
  if (isolated && output === isolated) {
    throw new Error("内容自动化验收证据不得覆盖隔离数据库");
  }
  return { source, output, isolated };
}

export function isOfficialYunwuBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!url.port || url.port === "443") &&
      (hostname === "yunwu.ai" || hostname.endsWith(".yunwu.ai")) &&
      (url.pathname === "/v1" || url.pathname.startsWith("/v1/"))
    );
  } catch {
    return false;
  }
}

export function sha256Text(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex");
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0;
}

function isRealModel(value) {
  const model = String(value || "").trim();
  return Boolean(model) && !REAL_MODEL_DENY.test(model);
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasRecordFields(value) {
  return isPlainRecord(value) && Object.keys(value).length > 0;
}

function projectProfileSnapshot(runSnapshot = {}, canonicalProfile = null) {
  const identity = isPlainRecord(runSnapshot.identity)
    ? runSnapshot.identity
    : {};
  const skillLibrary = isPlainRecord(runSnapshot.skillLibrary)
    ? runSnapshot.skillLibrary
    : {};
  const enterpriseOverlay = isPlainRecord(runSnapshot.enterpriseOverlay)
    ? runSnapshot.enterpriseOverlay
    : {};
  const integrity = contentProfileIntegrityEvidence(
    runSnapshot,
    identity.idx,
    canonicalProfile,
  );
  const evidence = {
    schemaVersion: String(runSnapshot.schemaVersion || "") || null,
    profileVersion: String(runSnapshot.profileVersion || "") || null,
    promptHash: String(runSnapshot.promptHash || "") || null,
    identityIdx: Number.isSafeInteger(Number(identity.idx))
      ? Number(identity.idx)
      : null,
    identityKey: String(identity.key || "") || null,
    capabilityCount: Array.isArray(runSnapshot.capabilities)
      ? runSnapshot.capabilities.length
      : 0,
    requiredSkillCount: Array.isArray(skillLibrary.required)
      ? skillLibrary.required.length
      : 0,
    historicalSkillCount: Array.isArray(skillLibrary.historical)
      ? skillLibrary.historical.length
      : 0,
    hasWorkMethod: hasRecordFields(runSnapshot.workMethod),
    hasPrompts: hasRecordFields(runSnapshot.prompts),
    hasWorkConfig: hasRecordFields(runSnapshot.workConfig),
    hasJobProfile: hasRecordFields(runSnapshot.jobProfile),
    hasDispatch: hasRecordFields(runSnapshot.dispatch),
    hasProvenance: hasRecordFields(runSnapshot.provenance),
    enterpriseWorkConfigApplied: hasRecordFields(enterpriseOverlay.workConfig),
    promptTextStored: enterpriseOverlay.promptTextStored === true,
    ...integrity,
    complete: false,
  };
  evidence.complete =
    evidence.schemaVersion === "content-automation-snapshot.v1" &&
    /^content-\d+-r\d+$/u.test(String(evidence.profileVersion || "")) &&
    /^[a-f0-9]{64}$/u.test(String(evidence.promptHash || "")) &&
    evidence.identityIdx != null &&
    Boolean(evidence.identityKey) &&
    evidence.capabilityCount > 0 &&
    evidence.requiredSkillCount > 0 &&
    evidence.historicalSkillCount > 0 &&
    evidence.hasWorkMethod &&
    evidence.hasPrompts &&
    evidence.hasWorkConfig &&
    evidence.hasJobProfile &&
    evidence.hasDispatch &&
    evidence.hasProvenance &&
    evidence.enterpriseWorkConfigApplied &&
    evidence.promptTextStored === false &&
    evidence.canonicalMatch === true;
  return evidence;
}

function trustedPublicWebUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !host) return false;
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "example.com" ||
      host === "example.net" ||
      host === "example.org" ||
      host.endsWith(".example") ||
      host.endsWith(".test") ||
      host.endsWith(".invalid") ||
      /^127\./u.test(host) ||
      /^10\./u.test(host) ||
      /^192\.168\./u.test(host) ||
      /^169\.254\./u.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host) ||
      host === "::1"
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function projectWebEvidence(runSnapshot = {}) {
  const web = isPlainRecord(runSnapshot.web) ? runSnapshot.web : {};
  const rows = Array.isArray(web.results) ? web.results : [];
  const sources = rows
    .map((row) => String(row?.url || "").trim())
    .filter(Boolean)
    .map((url) => {
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) return null;
        return {
          host: parsed.hostname.toLowerCase(),
          hash: sha256Text(url),
          trusted: trustedPublicWebUrl(url),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return {
    required: web.required === true,
    attempted: web.attempted === true,
    verified: web.verified === true,
    provider: String(web.provider || "") || null,
    resultCount: rows.length,
    sourceHosts: [...new Set(sources.map((item) => item.host))].sort(),
    sourceUrlHashes: sources.map((item) => item.hash),
    trustedSourceCount: sources.filter((item) => item.trusted).length,
    untrustedSourceHosts: [
      ...new Set(
        sources.filter((item) => !item.trusted).map((item) => item.host),
      ),
    ].sort(),
    providerTrusted: TRUSTED_WEB_PROVIDERS.has(String(web.provider || "")),
  };
}

function check(errors, condition, message) {
  if (!condition) errors.push(message);
}

// 真实运行器只把这个投影写入证据文件：不保存正文、完整岗位提示词、密码或 API Key。
export function projectAutomationEvidence({
  job,
  rule,
  publicRun,
  runRecord = null,
  content,
  contentReadback = null,
  runSnapshot,
  hold,
  creditLog,
  approvalCount = 0,
  pendingApprovalCount = 0,
  publishLogCount = 0,
  derivedAssetCount = 0,
  derivedKnowledgeCount = 0,
  holdCount = 0,
  creditLogCount = 0,
  fullBillingLogCount = 0,
  tenantBalance = null,
  ownHeldCount = 0,
  idempotency = null,
  scheduler = null,
  recovery = null,
  cleanup = null,
  canonicalProfile = null,
  tenantBoundary = null,
  ledgerBaseline = null,
  specialProvider = null,
} = {}) {
  const body = String(content?.body || "");
  const provider = runSnapshot?.providerAttempt || {};
  const usage = provider?.usage || {};
  const contract = runSnapshot?.contract || {};
  const evidence = {
    jobKey: job?.key || null,
    employee: job?.employee
      ? {
          idx: Number(job.employee.idx),
          key: job.employee.key,
          name: job.employee.name,
          taskType: job.employee.taskType,
        }
      : null,
    mode: job?.mode || null,
    rule: rule
      ? {
          id: Number(rule.id),
          employeeIdx: Number(rule.employeeIdx ?? rule.employee_idx),
          enabled: Boolean(rule.enabled),
          nextRunAt: rule.nextRunAt ?? rule.next_run_at ?? null,
        }
      : null,
    run: publicRun
      ? {
          id: Number(publicRun.id),
          trigger: publicRun.trigger,
          scheduledFor: publicRun.scheduledFor || null,
          status: publicRun.status,
          contentId:
            publicRun.contentId == null ? null : Number(publicRun.contentId),
          finishedAt: publicRun.finishedAt || null,
          profileVersion: publicRun.profileVersion || null,
          promptHash: publicRun.promptHash || null,
          contract: publicRun.contract
            ? {
                status: publicRun.contract.status,
                valid: publicRun.contract.valid === true,
                artifactCount: Array.isArray(publicRun.contract.artifacts)
                  ? publicRun.contract.artifacts.length
                  : 0,
              }
            : null,
          billing: publicRun.billing
            ? {
                state: publicRun.billing.state || null,
                holdId: Number(publicRun.billing.holdId || 0) || null,
                estimatedCredits: Number(
                  publicRun.billing.estimatedCredits || 0,
                ),
                chargedCredits:
                  publicRun.billing.chargedCredits == null
                    ? null
                    : Number(publicRun.billing.chargedCredits),
                heldCredits: Number(publicRun.billing.heldCredits || 0),
                balance:
                  publicRun.billing.balance == null
                    ? null
                    : Number(publicRun.billing.balance),
              }
            : null,
        }
      : null,
    provider: {
      mode: provider.mode || null,
      model: provider.model || null,
      attemptCount: Number(provider.attemptCount || 0),
      inputTokens: Number(usage.inputTokens || 0),
      outputTokens: Number(usage.outputTokens || 0),
    },
    profileSnapshot: projectProfileSnapshot(runSnapshot, canonicalProfile),
    web: projectWebEvidence(runSnapshot),
    contract: {
      valid: contract.valid === true,
      status: contract.status || null,
      artifactCount: Array.isArray(contract.artifacts)
        ? contract.artifacts.length
        : 0,
      errorCount: Array.isArray(contract.errors) ? contract.errors.length : 0,
    },
    specialProvider: specialProvider || {
      expected: false,
      attemptCount: 0,
      expectedAttemptCount: 0,
      attempts: [],
      totalEstimatedCredits: 0,
      totalChargedCredits: 0,
      totalHeldCredits: 0,
      materialCount: 0,
    },
    persistence: content
      ? {
          id: Number(content.id),
          status: content.status,
          aiMode: content.ai_mode,
          employeeIdx: Number(content.content_employee_idx),
          employeeKey: content.content_employee_key,
          runMode: content.content_run_mode,
          profileVersion: content.profile_version || null,
          promptHash: content.prompt_hash || null,
          runProfileVersion: runRecord?.profile_version || null,
          runPromptHash: runRecord?.prompt_hash || null,
          bodyChars: body.trim().length,
          bodySha256: body ? sha256Text(body) : null,
          approvalCount: Number(approvalCount || 0),
          pendingApprovalCount: Number(pendingApprovalCount || 0),
          authenticatedReadbackMatches:
            Boolean(contentReadback) &&
            Number(contentReadback.id) === Number(content.id) &&
            String(contentReadback.body || "") === body,
        }
      : null,
    billingAuthority: {
      hold: hold
        ? {
            id: Number(hold.id),
            logId: Number(hold.log_id || 0) || null,
            tenantId: Number(hold.tenant_id || 0) || null,
            userId: Number(hold.user_id || 0) || null,
            status: hold.status,
            feature: hold.feature || null,
            kind: hold.kind || null,
            model: hold.model || null,
            heldCredits: Number(hold.held_credits || 0),
            settledCredits:
              hold.settled_credits == null
                ? null
                : Number(hold.settled_credits),
            refType: hold.ref_type || null,
            refId: Number(hold.ref_id || 0) || null,
          }
        : null,
      creditLog: creditLog
        ? {
            id: Number(creditLog.id),
            tenantId: Number(creditLog.tenant_id || 0) || null,
            userId: Number(creditLog.user_id || 0) || null,
            feature: creditLog.feature || null,
            kind: creditLog.kind || null,
            aiMode: creditLog.ai_mode,
            model: creditLog.model || null,
            inputTokens: Number(creditLog.input_tokens || 0),
            outputTokens: Number(creditLog.output_tokens || 0),
            credits: Number(creditLog.credits || 0),
            costYuan: Number(creditLog.cost_yuan || 0),
            balanceAfter: Number(creditLog.balance_after || 0),
          }
        : null,
      holdCount: Number(holdCount || 0),
      creditLogCount: Number(creditLogCount || 0),
      fullBillingLogCount: Number(fullBillingLogCount || 0),
      tenantId: Number(tenantBoundary?.tenantId || 0) || null,
      userId: Number(tenantBoundary?.userId || 0) || null,
      balanceBefore:
        ledgerBaseline?.balance == null
          ? null
          : Number(ledgerBaseline.balance),
      holdIdBefore:
        ledgerBaseline?.maxHoldId == null
          ? null
          : Number(ledgerBaseline.maxHoldId),
      creditLogIdBefore:
        ledgerBaseline?.maxCreditLogId == null
          ? null
          : Number(ledgerBaseline.maxCreditLogId),
      tenantBalance: tenantBalance == null ? null : Number(tenantBalance),
      ownHeldCount: Number(ownHeldCount || 0),
      aggregate: {
        estimatedCredits:
          Number(hold?.held_credits || 0) +
          Number(specialProvider?.totalEstimatedCredits || 0),
        chargedCredits:
          Number(creditLog?.credits || 0) +
          Number(specialProvider?.totalChargedCredits || 0),
        heldCredits:
          (hold?.status === "held" ? Number(hold?.held_credits || 0) : 0) +
          Number(specialProvider?.totalHeldCredits || 0),
        ledgerCount: Number(fullBillingLogCount || 0),
      },
    },
    idempotency,
    scheduler,
    recovery,
    externalEffects: {
      publishLogCount: Number(publishLogCount || 0),
      derivedAssetCount: Number(derivedAssetCount || 0),
      derivedKnowledgeCount: Number(derivedKnowledgeCount || 0),
      externalPublishAllowed:
        runSnapshot?.automation?.externalPublishAllowed === true,
      published: false,
      tenantDelta: tenantBoundary?.delta || null,
    },
    cleanup,
  };
  return sanitizeAutomationArtifact(evidence);
}

export function evaluateAutomationEvidence(evidence) {
  const errors = [];
  const expectedRunMode =
    evidence?.mode === "scheduled"
      ? "automation_scheduled"
      : "automation_immediate";
  check(errors, Boolean(evidence?.employee), "缺少内容员工岗位证据");
  check(
    errors,
    evidence?.rule?.employeeIdx === evidence?.employee?.idx,
    "规则没有绑定目标内容员工",
  );
  check(
    errors,
    evidence?.run?.trigger === evidence?.mode,
    "运行触发模式与验收模式不一致",
  );
  check(
    errors,
    evidence?.run?.status === "成功" && Boolean(evidence?.run?.finishedAt),
    "自动化运行没有进入成功终态",
  );
  check(
    errors,
    positiveInteger(evidence?.run?.contentId),
    "运行没有产生内容ID",
  );
  check(errors, evidence?.provider?.mode === "api", "生成来源不是真实API");
  check(
    errors,
    isRealModel(evidence?.provider?.model),
    "生成模型缺失或是模板/降级模型",
  );
  check(
    errors,
    evidence?.provider?.attemptCount >= 1,
    "缺少供应商调用尝试证据",
  );
  check(
    errors,
    evidence?.provider?.inputTokens > 0 && evidence?.provider?.outputTokens > 0,
    "供应商token用量不完整",
  );
  check(
    errors,
    evidence?.profileSnapshot?.complete === true &&
      evidence.profileSnapshot.identityIdx === evidence?.employee?.idx &&
      evidence.profileSnapshot.identityKey === evidence?.employee?.key &&
      evidence.profileSnapshot.profileVersion ===
        evidence?.persistence?.profileVersion &&
      evidence.profileSnapshot.profileVersion ===
        evidence?.persistence?.runProfileVersion &&
      evidence.profileSnapshot.profileVersion === evidence?.run?.profileVersion &&
      evidence.profileSnapshot.promptHash === evidence?.persistence?.promptHash &&
      evidence.profileSnapshot.promptHash ===
        evidence?.persistence?.runPromptHash &&
      evidence.profileSnapshot.promptHash === evidence?.run?.promptHash &&
      evidence.profileSnapshot.canonicalMatch === true &&
      evidence.profileSnapshot.profileFingerprint ===
        evidence.profileSnapshot.canonicalProfileFingerprint &&
      /^[a-f0-9]{64}$/u.test(
        String(evidence.profileSnapshot.capabilityFingerprint || ""),
      ) &&
      /^[a-f0-9]{64}$/u.test(
        String(evidence.profileSnapshot.skillFingerprint || ""),
      ) &&
      evidence.profileSnapshot.capabilityIds?.length ===
        evidence.profileSnapshot.capabilityCount &&
      evidence.profileSnapshot.skillIds?.length ===
        evidence.profileSnapshot.requiredSkillCount +
          evidence.profileSnapshot.historicalSkillCount,
    "完整岗位快照未进入本次执行（能力、工作方式、技能库、提示词哈希、工作配置或岗位档案不完整）",
  );
  const webExpected = WEB_REQUIRED_EMPLOYEES.has(
    Number(evidence?.employee?.idx),
  );
  check(
    errors,
    evidence?.web?.required === webExpected,
    "联网执行配置与岗位定义不一致",
  );
  if (webExpected) {
    check(
      errors,
      evidence?.web?.attempted === true &&
        evidence?.web?.verified === true &&
        evidence?.web?.providerTrusted === true &&
        evidence?.web?.resultCount > 0 &&
        evidence?.web?.sourceHosts?.length > 0 &&
        evidence?.web?.sourceUrlHashes?.length === evidence?.web?.resultCount &&
        evidence?.web?.trustedSourceCount === evidence?.web?.resultCount &&
        evidence?.web?.untrustedSourceHosts?.length === 0,
      "强制联网岗未取得来自可信检索器与公网HTTPS来源的真实联网证据",
    );
  } else {
    check(
      errors,
      evidence?.web?.attempted === false &&
        evidence?.web?.verified === false &&
        evidence?.web?.resultCount === 0 &&
        evidence?.web?.trustedSourceCount === 0,
      "不强制联网岗错误冒充已联网执行",
    );
  }
  check(
    errors,
    evidence?.contract?.valid === true && evidence?.contract?.errorCount === 0,
    "岗位输出契约未通过",
  );
  const specialExpected = [5, 6].includes(Number(evidence?.employee?.idx));
  const special = evidence?.specialProvider || {};
  check(
    errors,
    special.expected === specialExpected,
    "专项图片provider适用岗位标记不正确",
  );
  if (specialExpected) {
    check(
      errors,
      special.attemptCount === 1 &&
        special.expectedAttemptCount === 1 &&
        Array.isArray(special.attempts) &&
        special.attempts.length === 1,
      "多媒体/封面岗位必须且只能有1个稳定图片provider尝试",
    );
    const attempt = special.attempts?.[0];
    check(
      errors,
      attempt?.kind === "image" &&
        attempt?.status === "settled" &&
        attempt?.namespaceStable === true &&
        /^sha256:[a-f0-9]{64}$/u.test(
          String(attempt?.requestFingerprint || ""),
        ),
      "专项图片provider缺少稳定幂等身份或未结算",
    );
    check(
      errors,
      attempt?.billingRefType === "content_special_provider" &&
        attempt?.holdCount === 1 &&
        attempt?.creditLogCount === 1 &&
        attempt?.hold?.id > 0 &&
        attempt?.hold?.logId === attempt?.creditLog?.id &&
        attempt?.hold?.status === "settled" &&
        attempt?.hold?.settledCredits > 0 &&
        attempt?.creditLog?.aiMode === "api" &&
        attempt?.creditLog?.kind === "image" &&
        attempt?.creditLog?.credits === attempt?.hold?.settledCredits,
      "专项图片provider的预授权与积分流水没有唯一闭环",
    );
    check(
      errors,
      attempt?.delivery?.persisted === true &&
        attempt?.delivery?.artifactCount === 1 &&
        attempt?.delivery?.materialCount === 1 &&
        special.materialCount === 1 &&
        Array.isArray(attempt?.materials) &&
        attempt.materials.length === 1,
      "专项图片provider没有形成唯一可追溯内部素材",
    );
    const material = attempt?.materials?.[0];
    check(
      errors,
      material?.sourceType === "content_special_provider" &&
        material?.sourceId === evidence?.run?.id &&
        material?.creatorId === evidence?.billingAuthority?.userId &&
        /^[a-f0-9]{64}$/u.test(String(material?.snapshotHash || "")) &&
        material?.schemaVersion ===
          "nanowork.content-special-provider-artifact/2" &&
        material?.attemptIdMatches === true &&
        material?.billingRefMatches === true &&
        material?.credentialsIncluded === false &&
        material?.binaryInMetadata === false,
      "专项图片素材的run/attempt/账务/哈希证据不完整",
    );
  } else {
    check(
      errors,
      special.attemptCount === 0 &&
        special.materialCount === 0 &&
        special.totalChargedCredits === 0,
      "非图片岗位错误产生了专项provider调用或素材",
    );
  }
  check(
    errors,
    evidence?.run?.contract?.valid === true,
    "公开运行投影没有证明契约通过",
  );
  check(
    errors,
    evidence?.persistence?.id === evidence?.run?.contentId,
    "运行内容ID与持久化内容不一致",
  );
  check(
    errors,
    evidence?.persistence?.status === "待审核",
    "自动内容没有停在待人工审阅边界",
  );
  check(
    errors,
    evidence?.persistence?.aiMode === "api",
    "持久化内容ai_mode不是api",
  );
  check(
    errors,
    evidence?.persistence?.employeeIdx === evidence?.employee?.idx,
    "持久化内容员工编号不一致",
  );
  check(
    errors,
    evidence?.persistence?.employeeKey === evidence?.employee?.key,
    "持久化内容员工key不一致",
  );
  check(
    errors,
    evidence?.persistence?.runMode === expectedRunMode,
    "持久化运行模式不正确",
  );
  check(
    errors,
    /^content-\d+-r\d+$/u.test(
      String(evidence?.persistence?.profileVersion || ""),
    ),
    "缺少岗位版本快照",
  );
  check(
    errors,
    /^[a-f0-9]{64}$/u.test(String(evidence?.persistence?.promptHash || "")),
    "缺少完整提示词哈希",
  );
  check(
    errors,
    evidence?.persistence?.bodyChars >= 80 &&
      /^[a-f0-9]{64}$/u.test(String(evidence?.persistence?.bodySha256 || "")),
    "落库正文不完整",
  );
  check(
    errors,
    evidence?.persistence?.authenticatedReadbackMatches === true,
    "未通过登录后详情接口证明内容正文与落库一致",
  );
  check(
    errors,
    evidence?.persistence?.approvalCount === 1 &&
      evidence?.persistence?.pendingApprovalCount === 1,
    "待审内容必须且只能有1张待审人工审批单",
  );
  check(
    errors,
    evidence?.externalEffects?.tenantDelta?.approvals === 1 &&
      evidence?.externalEffects?.tenantDelta?.pendingApprovals === 1,
    "本岗位待审内容未在租户级变更中恰好新增1张待审单",
  );
  check(
    errors,
    evidence?.run?.billing?.state === "settled",
    "运行账务投影未结算",
  );
  check(
    errors,
    evidence?.billingAuthority?.hold?.status === "settled",
    "权威预授权没有结算",
  );
  check(
    errors,
    evidence?.billingAuthority?.hold?.settledCredits > 0,
    "成功交付的权威预授权实扣不正确",
  );
  check(
    errors,
    evidence?.billingAuthority?.creditLog?.aiMode === "api",
    "积分流水不是真实API口径",
  );
  check(
    errors,
    evidence?.billingAuthority?.creditLog?.inputTokens > 0 &&
      evidence?.billingAuthority?.creditLog?.outputTokens > 0,
    "积分流水缺少正token用量",
  );
  check(
    errors,
      evidence?.billingAuthority?.holdCount === 1 &&
      evidence?.billingAuthority?.creditLogCount === 1 &&
      evidence?.billingAuthority?.fullBillingLogCount ===
        (specialExpected ? 2 : 1) &&
      evidence?.run?.billing?.holdId === evidence?.billingAuthority?.hold?.id &&
      evidence?.billingAuthority?.hold?.logId ===
        evidence?.billingAuthority?.creditLog?.id &&
      evidence?.billingAuthority?.hold?.refType === "content_automation_run" &&
      evidence?.billingAuthority?.hold?.refId === evidence?.run?.id,
    "运行、预授权和积分流水的唯一关联不完整",
  );
  check(
    errors,
    positiveInteger(evidence?.billingAuthority?.tenantId) &&
      positiveInteger(evidence?.billingAuthority?.userId) &&
      evidence?.billingAuthority?.hold?.tenantId ===
        evidence.billingAuthority.tenantId &&
      evidence?.billingAuthority?.creditLog?.tenantId ===
        evidence.billingAuthority.tenantId &&
      evidence?.billingAuthority?.hold?.userId ===
        evidence.billingAuthority.userId &&
      evidence?.billingAuthority?.creditLog?.userId ===
        evidence.billingAuthority.userId,
    "权威账务的租户/用户作用域不一致",
  );
  check(
    errors,
    Number.isSafeInteger(evidence?.billingAuthority?.holdIdBefore) &&
      evidence.billingAuthority.holdIdBefore >= 0 &&
      Number.isSafeInteger(evidence?.billingAuthority?.creditLogIdBefore) &&
      evidence.billingAuthority.creditLogIdBefore >= 0 &&
      evidence?.billingAuthority?.hold?.id >
        evidence.billingAuthority.holdIdBefore &&
      evidence?.billingAuthority?.creditLog?.id >
        evidence.billingAuthority.creditLogIdBefore,
    "权威账务行不是本次派活后新增，无法排除历史记录误配",
  );
  check(
    errors,
    evidence?.billingAuthority?.hold?.feature ===
      evidence?.billingAuthority?.creditLog?.feature &&
      evidence?.billingAuthority?.hold?.kind ===
        evidence?.billingAuthority?.creditLog?.kind &&
      evidence?.billingAuthority?.hold?.model ===
        evidence?.billingAuthority?.creditLog?.model,
    "权威预授权与积分流水的feature/kind/model不一致",
  );
  check(
    errors,
    evidence?.provider?.inputTokens ===
      evidence?.billingAuthority?.creditLog?.inputTokens &&
      evidence?.provider?.outputTokens ===
        evidence?.billingAuthority?.creditLog?.outputTokens,
    "供应商token与权威积分流水token不一致",
  );
  check(
    errors,
    evidence?.provider?.model === evidence?.billingAuthority?.creditLog?.model,
    "供应商模型与权威积分流水模型不一致",
  );
  check(
    errors,
    evidence?.run?.billing?.estimatedCredits ===
      evidence?.billingAuthority?.aggregate?.estimatedCredits &&
      evidence?.run?.billing?.chargedCredits ===
        evidence?.billingAuthority?.aggregate?.chargedCredits &&
      evidence?.run?.billing?.heldCredits === 0,
    "运行总账单没有完整汇总正文与专项provider的占扣/实扣",
  );
  check(
    errors,
      evidence?.billingAuthority?.tenantBalance ===
        evidence?.billingAuthority?.creditLog?.balanceAfter &&
      evidence?.run?.billing?.balance ===
        evidence?.billingAuthority?.tenantBalance &&
      evidence?.billingAuthority?.tenantBalance ===
        evidence?.billingAuthority?.balanceBefore -
          evidence?.billingAuthority?.aggregate?.chargedCredits,
    "租户当前余额与本轮权威积分流水余额不一致",
  );
  check(
    errors,
    evidence?.billingAuthority?.ownHeldCount === 0,
    "本验收还遗留held预授权",
  );
  check(
    errors,
    evidence?.externalEffects?.publishLogCount === 0,
    "本验收产生了发布登记",
  );
  check(
    errors,
    evidence?.externalEffects?.derivedAssetCount === 0,
    "人工审阅前错误生成了业务资产",
  );
  check(
    errors,
    evidence?.externalEffects?.derivedKnowledgeCount === 0,
    "人工审阅前错误写入了知识库",
  );
  check(
    errors,
    evidence?.externalEffects?.tenantDelta?.publishLogs === 0 &&
      evidence?.externalEffects?.tenantDelta?.assets === 0 &&
      evidence?.externalEffects?.tenantDelta?.knowledge === 0 &&
      evidence?.externalEffects?.tenantDelta?.materials ===
        (specialExpected ? 1 : 0),
    "人工审阅前租户级发布/资产/知识变更必须全为0",
  );
  check(
    errors,
    evidence?.externalEffects?.externalPublishAllowed === false,
    "快照错误允许了外部发布",
  );
  check(
    errors,
    evidence?.cleanup?.ruleDisabled === true &&
      evidence?.cleanup?.nextRunAt === null,
    "验收完成后自动化规则未完全停用",
  );

  if (evidence?.mode === "immediate") {
    check(
      errors,
      evidence?.idempotency?.sameRunId === true,
      "立即运行重放没有复用同一runId",
    );
    check(
      errors,
      evidence?.idempotency?.reused === true,
      "立即运行没有返回幂等复用证据",
    );
    check(
      errors,
      evidence?.idempotency?.runCount === 1,
      "立即运行幂等键产生了重复运行",
    );
    check(
      errors,
      evidence?.idempotency?.billingLogCountStable === true,
      "立即运行重放产生了重复计费",
    );
    // 计费“齐全”只对成功交付要求；上游阶段失败导致的少计费
    // 由 run 终态与专项provider证据单独判定，不与重复计费混为一谈。
    check(
      errors,
      evidence?.run?.status !== "成功" ||
        evidence?.idempotency?.billingLogCountComplete === true,
      "成功交付的正文与专项provider计费条数不完整",
    );
  } else if (evidence?.mode === "scheduled") {
    check(
      errors,
      evidence?.scheduler?.firstClaimCount === 1,
      "定时规则没有被精确认领一次",
    );
    check(
      errors,
      evidence?.scheduler?.secondClaimCount === 0,
      "同一到期周期被重复认领",
    );
    check(
      errors,
      evidence?.scheduler?.runCountForScheduledFor === 1,
      "同一scheduledFor产生了重复运行",
    );
    check(
      errors,
      evidence?.scheduler?.idempotentReplay === true,
      "重复执行同一定时run没有返回幂等结果",
    );
    check(
      errors,
      evidence?.scheduler?.billingLogCountStable === true,
      "重复执行同一定时run产生了重复计费",
    );
    check(
      errors,
      evidence?.run?.status !== "成功" ||
        evidence?.scheduler?.billingLogCountComplete === true,
      "成功交付的正文与专项provider计费条数不完整",
    );
    check(
      errors,
      Boolean(evidence?.scheduler?.nextRunAtAfterClaim) &&
        evidence.scheduler.nextRunAtAfterClaim >
          evidence.scheduler.scheduledFor,
      "定时认领后没有推进nextRunAt",
    );
    check(
      errors,
      evidence?.recovery?.recoveredOnce === true,
      "没有验证超时运行恢复一次",
    );
    check(
      errors,
      evidence?.recovery?.runStatus === "失败",
      "恢复探针没有关闭运行中终态",
    );
    check(
      errors,
      evidence?.recovery?.billingState === "released",
      "无产物恢复探针没有全额退回",
    );
    check(
      errors,
      evidence?.recovery?.holdStatus === "settled" &&
        evidence?.recovery?.settledCredits === 0,
      "恢复探针权威hold未按0分收口",
    );
    check(
      errors,
      evidence?.recovery?.balanceRestored === true,
      "恢复退款没有恢复租户余额",
    );
    check(
      errors,
      evidence?.recovery?.nextRunAtAdvanced === true,
      "恢复后没有保留已推进的nextRunAt",
    );
    check(
      errors,
      evidence?.recovery?.ownHeldCount === 0,
      "恢复探针遗留held预授权",
    );
    check(
      errors,
      evidence?.recovery?.ruleDisabled === true,
      "恢复探针规则未停用",
    );
  }

  return {
    pass: errors.length === 0,
    verdict:
      errors.length === 0
        ? "PASS_REAL_CONTENT_AUTOMATION"
        : "FAIL_REAL_CONTENT_AUTOMATION",
    errors,
  };
}

export function sanitizeAutomationArtifact(value) {
  const normalizedField = (key) =>
    String(key || "")
      .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
      .toLowerCase();
  const isSecretField = (key) => {
    const normalized = normalizedField(key);
    if (
      ["input_tokens", "output_tokens", "total_tokens", "max_tokens"].includes(
        normalized,
      )
    ) {
      return false;
    }
    return (
      SECRET_FIELD.test(normalized) ||
      /(?:^|_)(?:token|tokens)(?:$|_)/u.test(normalized) ||
      ["body", "raw_body", "request_body", "response_body"].includes(normalized)
    );
  };
  const sanitizeString = (input) => {
    let output = String(input);
    for (const pattern of SECRET_VALUE_PATTERNS) {
      output = output.replace(pattern, "[REDACTED]");
    }
    return output;
  };
  const walk = (input) => {
    if (Array.isArray(input)) return input.map(walk);
    if (!input || typeof input !== "object") {
      return typeof input === "string" ? sanitizeString(input) : input;
    }
    const output = {};
    for (const [key, child] of Object.entries(input)) {
      const normalized = normalizedField(key);
      if (
        child === false &&
        (normalized.endsWith("_persisted") ||
          normalized.endsWith("_persisted_in_artifact"))
      ) {
        output[key] = false;
        continue;
      }
      if (isSecretField(key)) continue;
      output[key] = walk(child);
    }
    return output;
  };
  return walk(value);
}

export function summarizeAutomationResults(results = []) {
  const rows = Array.isArray(results) ? results : [];
  const passed = rows.filter((item) => item?.pass === true).length;
  const tokens = rows.reduce(
    (totals, item) => ({
      input: totals.input + Number(item?.evidence?.provider?.inputTokens || 0),
      output:
        totals.output + Number(item?.evidence?.provider?.outputTokens || 0),
    }),
    { input: 0, output: 0 },
  );
  return {
    total: rows.length,
    passed,
    failed: rows.length - passed,
    tokens,
    byMode: Object.fromEntries(
      CONTENT_AUTOMATION_MODES.map((mode) => {
        const selected = rows.filter((item) => item?.evidence?.mode === mode);
        return [
          mode,
          {
            total: selected.length,
            passed: selected.filter((item) => item?.pass === true).length,
          },
        ];
      }),
    ),
  };
}

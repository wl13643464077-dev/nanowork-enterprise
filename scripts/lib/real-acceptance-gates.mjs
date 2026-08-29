/**
 * Shared acceptance gate used by the real employee runner, the desktop
 * three-file exporter and the static full-feature inventory.
 *
 * This module is test/reporting policy only.  It never performs HTTP, reads
 * credentials, creates approvals or decides that a provider was called.  It
 * consumes already-redacted evidence and keeps every gate orthogonal so a
 * real API call cannot be mistaken for a delivered business result.
 */

export const UNIFIED_ACCEPTANCE_GATE_SCHEMA =
  "nanowork.unified-acceptance-gate.v1";

export const UNIFIED_ACCEPTANCE_CHECKS = Object.freeze([
  Object.freeze({
    id: "single_sentence_demand",
    label: "一句真实需求",
    rule: "需求必须是一句明确的老板业务问题，不得只给岗位能力名。",
  }),
  Object.freeze({
    id: "public_info_no_user_question",
    label: "公开信息不反问用户",
    rule: "可由公开来源取得的信息必须由岗位自行联网/API核验；缺证据时标未知和补查动作，不把问题反问老板。",
  }),
  Object.freeze({
    id: "real_network_api",
    label: "真实联网/API",
    rule: "必须保留真实网络/API调用、模型和正数token证据；template/mock/fallback/零token不通过。",
  }),
  Object.freeze({
    id: "data_analysis",
    label: "数据分析",
    rule: "必须把输入事实转为可核验分析或判断，不得只复述原始材料。",
  }),
  Object.freeze({
    id: "skill_invocation",
    label: "岗位技能真实调用",
    rule: "必须证明完整岗位档案、能力/技能快照和岗位输出契约绑定到本次执行。",
  }),
  Object.freeze({
    id: "business_result",
    label: "业务结果",
    rule: "必须产出一个可审阅业务主结果；能力清单、底稿、空模板和未闭环占位正文不算结果。",
  }),
  Object.freeze({
    id: "boss_zero_approvals",
    label: "Boss测试期0审批",
    rule: "测试运行前后审批记录增量必须为0；内部自动采用不创建人工审批记录。",
  }),
  Object.freeze({
    id: "input_output_execution_cost",
    label: "输入/输出/执行力/费用证据",
    rule: "三文件与权威账本必须能回读输入、输出、终态、provider、token、供应商估算和客户实扣。",
  }),
]);

const ABILITY_ONLY = /(?:能力清单|能力列表|技能清单|岗位底稿|空模板|仅供参考的底稿)/u;
const UNRESOLVED_OUTPUT = /(?:未提供|缺少|缺失|待补证|待核验|无法支撑)/u;
const PUBLIC_INFO_USER_QUESTION = /(?:请(?:老板|用户|您)?\s*(?:提供|补充|确认|上传|告知)(?:[^。！？\n]{0,40})(?:地址|坐标|门店|竞品|公开信息|数据|材料|证据|账号|权限|图片|文件|日期)|需要(?:老板|用户|您)?\s*(?:提供|补充|确认|上传|告知)(?:[^。！？\n]{0,40})(?:地址|坐标|门店|竞品|公开信息|数据|材料|证据|账号|权限|图片|文件|日期)|请提供(?:地址|坐标|竞品|公开信息))/u;

function text(value) {
  return String(value ?? "").trim();
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isSingleSentenceDemand(value) {
  const demand = text(value);
  if (!demand || demand.length < 6 || demand.length > 240) return false;
  if (/[\r\n]/u.test(demand)) return false;
  if (/^(?:未执行|无真实需求|登录态、角色与模块上下文|页面入口|岗位能力|岗位职责)/u.test(demand)) return false;
  const sentenceMarks = (demand.match(/[。！？!?]/gu) || []).length;
  return sentenceMarks <= 1 && !/^岗位(?:能力|职责|清单)/u.test(demand);
}

/**
 * Detect a direct request for publicly discoverable facts/materials.  The
 * runner uses this on model output to ensure a missing source is disclosed as
 * an unknown/follow-up action, not bounced back to the Boss as a question.
 */
export function isPublicInfoUserQuestion(value) {
  return PUBLIC_INFO_USER_QUESTION.test(text(value));
}

export function buildUnifiedAcceptancePlan({
  demand,
  publicInfoRequired = true,
  approvalPolicy = "boss_test_zero_approvals",
} = {}) {
  return {
    schema: UNIFIED_ACCEPTANCE_GATE_SCHEMA,
    policy: {
      approvalPolicy,
      requiredApprovalDelta: 0,
      noExternalSideEffect: true,
      publicInfoRequired: publicInfoRequired === true,
    },
    demand: {
      text: text(demand),
      sentence: isSingleSentenceDemand(demand),
      source: "acceptance_fixture_or_user_request",
    },
    checks: UNIFIED_ACCEPTANCE_CHECKS.map((check) => ({
      id: check.id,
      label: check.label,
      rule: check.rule,
      status: "PENDING",
    })),
  };
}

function check(id, pass, reason, evidence = null) {
  return {
    id,
    status: pass ? "PASS" : "FAIL",
    pass: Boolean(pass),
    reason: text(reason) || (pass ? "evidence_ok" : "evidence_missing"),
    evidence,
  };
}

/**
 * Evaluate only redacted evidence already collected by a runner.  Missing
 * evidence is a failed gate, never an invitation to infer success.
 */
export function evaluateUnifiedAcceptanceGate(input = {}) {
  const demand = text(input.demand);
  const publicInfo = input.publicInfoEvidence || {};
  const provider = input.providerEvidence || {};
  const analysis = input.dataAnalysisEvidence || {};
  const skills = input.skillInvocationEvidence || {};
  const result = input.businessResultEvidence || {};
  const approvalsBefore = finite(input.approvalsBefore);
  const approvalsAfter = finite(input.approvalsAfter);
  const approvalDelta =
    approvalsBefore != null && approvalsAfter != null
      ? approvalsAfter - approvalsBefore
      : null;
  const providerTokens =
    finite(provider.inputTokens) != null && finite(provider.outputTokens) != null
      ? finite(provider.inputTokens) + finite(provider.outputTokens)
      : 0;
  const checks = [
    check(
      "single_sentence_demand",
      isSingleSentenceDemand(demand),
      isSingleSentenceDemand(demand)
        ? "one_sentence_business_demand"
        : "需求为空、过长、多句或退化为岗位能力描述",
      { text: demand },
    ),
    check(
      "public_info_no_user_question",
      publicInfo.userQuestioned !== true &&
        (publicInfo.required !== true ||
          (publicInfo.attempted === true &&
            publicInfo.ok === true &&
            Number(publicInfo.citedUrlCount) > 0)),
      publicInfo.userQuestioned === true
        ? "公开信息被反问用户"
        : publicInfo.required === true &&
            !(publicInfo.attempted === true &&
              publicInfo.ok === true &&
              Number(publicInfo.citedUrlCount) > 0)
          ? "公开信息要求已标记，但缺少成功联网与可引用URL"
          : "公开信息由岗位自行核验或明确标记为无需联网",
      {
        required: publicInfo.required === true,
        attempted: publicInfo.attempted === true,
        ok: publicInfo.ok === true,
        citedUrlCount: Number(publicInfo.citedUrlCount) || 0,
        userQuestioned: publicInfo.userQuestioned === true,
      },
    ),
    check(
      "real_network_api",
      provider.invocationValid === true &&
        provider.mode === "api" &&
        text(provider.model).length > 0 &&
        Number(provider.inputTokens) > 0 &&
        Number(provider.outputTokens) > 0,
      provider.invocationValid === true
        ? "verified_real_provider_invocation"
        : "缺少真实API模式、模型或正数输入/输出token",
      {
        mode: provider.mode || null,
        model: text(provider.model) || null,
        inputTokens: Number(provider.inputTokens) || 0,
        outputTokens: Number(provider.outputTokens) || 0,
        attempts: Number(provider.attempts) || 0,
      },
    ),
    check(
      "data_analysis",
      analysis.inputFactsMapped === true &&
        analysis.semanticValid === true &&
        analysis.analysisProduced === true,
      analysis.inputFactsMapped !== true
        ? "输入事实未完成映射"
        : analysis.semanticValid !== true
          ? "岗位输出语义契约未通过"
          : analysis.analysisProduced !== true
            ? "未证明输出包含数据分析/判断"
            : "input_facts_mapped_and_analysis_produced",
      {
        inputFactsMapped: analysis.inputFactsMapped === true,
        semanticValid: analysis.semanticValid === true,
        analysisProduced: analysis.analysisProduced === true,
      },
    ),
    check(
      "skill_invocation",
      skills.profileLoaded === true &&
        skills.canonicalVerified === true &&
        skills.outputContractBound === true,
      skills.profileLoaded !== true
        ? "完整岗位档案未加载"
        : skills.canonicalVerified !== true
          ? "岗位canonical快照未验证"
          : skills.outputContractBound !== true
            ? "岗位输出契约未绑定本次执行"
            : "profile_skills_and_contract_bound",
      {
        profileLoaded: skills.profileLoaded === true,
        canonicalVerified: skills.canonicalVerified === true,
        outputContractBound: skills.outputContractBound === true,
        capabilityCount: Number(skills.capabilityCount) || 0,
        skillCount: Number(skills.skillCount) || 0,
      },
    ),
    check(
      "business_result",
      result.primaryArtifactCount === 1 &&
        result.outputChars > 0 &&
        result.notAbilityList === true &&
        result.resultHashValid === true &&
        result.artifactHashValid === true,
      result.primaryArtifactCount !== 1
        ? "主产物数量不是1"
        : result.outputChars <= 0
          ? "没有可读业务输出"
          : result.notAbilityList !== true
            ? "输出退化为能力清单/底稿/占位正文"
            : result.resultHashValid !== true || result.artifactHashValid !== true
              ? "主产物哈希无法回读复验"
              : "business_result_and_artifact_verified",
      {
        primaryArtifactCount: Number(result.primaryArtifactCount) || 0,
        outputChars: Number(result.outputChars) || 0,
        notAbilityList: result.notAbilityList === true,
        resultHashValid: result.resultHashValid === true,
        artifactHashValid: result.artifactHashValid === true,
      },
    ),
    check(
      "boss_zero_approvals",
      approvalDelta === 0,
      approvalDelta == null
        ? "缺少运行前后审批计数"
        : approvalDelta === 0
          ? "approval_delta=0"
          : `approval_delta=${approvalDelta}，Boss测试期不得新增审批`,
      {
        before: approvalsBefore,
        after: approvalsAfter,
        delta: approvalDelta,
        requiredDelta: 0,
      },
    ),
    check(
      "input_output_execution_cost",
      input.inputRecorded === true &&
        input.outputRecorded === true &&
        input.executionRecorded === true &&
        input.feeEvidenceRecorded === true &&
        providerTokens > 0,
      input.inputRecorded !== true
        ? "输入记录缺失"
        : input.outputRecorded !== true
          ? "输出记录缺失"
          : input.executionRecorded !== true
            ? "执行终态/执行力证据缺失"
            : input.feeEvidenceRecorded !== true
              ? "provider成本或客户账本费用证据缺失"
              : providerTokens <= 0
                ? "token使用量不是正数"
                : "input_output_execution_and_fee_evidence_present",
      {
        inputRecorded: input.inputRecorded === true,
        outputRecorded: input.outputRecorded === true,
        executionRecorded: input.executionRecorded === true,
        feeEvidenceRecorded: input.feeEvidenceRecorded === true,
        providerTokens,
      },
    ),
  ];
  return {
    schema: UNIFIED_ACCEPTANCE_GATE_SCHEMA,
    policy: {
      approvalPolicy: "boss_test_zero_approvals",
      requiredApprovalDelta: 0,
      noExternalSideEffect: true,
      publicInfoRequired: publicInfo.required === true,
    },
    demand: { text: demand, sentence: isSingleSentenceDemand(demand) },
    checks,
    pass: checks.every((item) => item.pass === true),
    failedChecks: checks.filter((item) => item.pass !== true).map((item) => item.id),
  };
}

export function redactUnifiedGateForReport(gate) {
  if (!gate || typeof gate !== "object") return null;
  return {
    schema: UNIFIED_ACCEPTANCE_GATE_SCHEMA,
    policy: gate.policy || null,
    demand: gate.demand ? { text: text(gate.demand.text), sentence: gate.demand.sentence === true } : null,
    checks: Array.isArray(gate.checks)
      ? gate.checks.map((item) => ({
          id: item.id,
          status: item.status,
          pass: item.pass === true,
          reason: text(item.reason),
          evidence: item.evidence || null,
        }))
      : [],
    pass: gate.pass === true,
    failedChecks: Array.isArray(gate.failedChecks) ? gate.failedChecks.map(String) : [],
  };
}

export function businessResultLooksLikeAbilityList(value) {
  const body = text(value);
  // A valid business result may disclose data gaps (for example “待核验”)
  // while still delivering a decision and next action.  Only reject a short
  // unresolved placeholder on its own; never reject a substantive result just
  // because it transparently records a missing fact.
  const unresolvedOnly = body.length < 120 && UNRESOLVED_OUTPUT.test(body);
  return body.length > 0 && !ABILITY_ONLY.test(body) && !unresolvedOnly;
}

export { ABILITY_ONLY, UNRESOLVED_OUTPUT, PUBLIC_INFO_USER_QUESTION };

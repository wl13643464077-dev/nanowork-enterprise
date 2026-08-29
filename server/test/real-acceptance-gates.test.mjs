import test from "node:test";
import assert from "node:assert/strict";
import {
  UNIFIED_ACCEPTANCE_CHECKS,
  buildUnifiedAcceptancePlan,
  evaluateUnifiedAcceptanceGate,
  isPublicInfoUserQuestion,
  isSingleSentenceDemand,
} from "../../scripts/lib/real-acceptance-gates.mjs";

test("统一验收门禁要求一句真实需求且禁止把能力清单当需求", () => {
  assert.equal(isSingleSentenceDemand("请围绕毛血旺太原吾悦广场核验竞品并给出下一步业务结论。"), true);
  assert.equal(isSingleSentenceDemand("岗位能力清单"), false);
  assert.equal(isSingleSentenceDemand("未执行（无真实需求）"), false);
  assert.equal(isSingleSentenceDemand("请先调研。再给结论。"), false);
  const plan = buildUnifiedAcceptancePlan({ demand: "请围绕门店A形成业务结论。" });
  assert.equal(plan.schema, "nanowork.unified-acceptance-gate.v1");
  assert.deepEqual(plan.checks.map((item) => item.id), UNIFIED_ACCEPTANCE_CHECKS.map((item) => item.id));
  assert.equal(plan.policy.requiredApprovalDelta, 0);
});

test("统一验收门禁缺证据时失败，完整脱敏证据时通过", () => {
  const base = {
    demand: "请围绕毛血旺太原吾悦广场核验竞品并给出下一步业务结论。",
    publicInfoEvidence: { required: true, attempted: true, ok: true, citedUrlCount: 2, userQuestioned: false },
    providerEvidence: { invocationValid: true, mode: "api", model: "gpt-5.5", inputTokens: 1200, outputTokens: 400, attempts: 1 },
    dataAnalysisEvidence: { inputFactsMapped: true, semanticValid: true, analysisProduced: true },
    skillInvocationEvidence: { profileLoaded: true, canonicalVerified: true, outputContractBound: true, capabilityCount: 6, skillCount: 13 },
    businessResultEvidence: { primaryArtifactCount: 1, outputChars: 900, notAbilityList: true, resultHashValid: true, artifactHashValid: true },
    approvalsBefore: 10,
    approvalsAfter: 10,
    inputRecorded: true,
    outputRecorded: true,
    executionRecorded: true,
    feeEvidenceRecorded: true,
  };
  const pass = evaluateUnifiedAcceptanceGate(base);
  assert.equal(pass.pass, true, JSON.stringify(pass));
  assert.deepEqual(pass.failedChecks, []);

  const failed = evaluateUnifiedAcceptanceGate({
    ...base,
    publicInfoEvidence: { required: true, attempted: false, ok: false, citedUrlCount: 0 },
    businessResultEvidence: { ...base.businessResultEvidence, notAbilityList: false },
    approvalsAfter: 11,
  });
  assert.equal(failed.pass, false);
  assert.ok(failed.failedChecks.includes("public_info_no_user_question"));
  assert.ok(failed.failedChecks.includes("business_result"));
  assert.ok(failed.failedChecks.includes("boss_zero_approvals"));
});

test("公开信息反问检测覆盖补充/上传变体且不误伤行动建议", () => {
  assert.equal(isPublicInfoUserQuestion("请补充门店坐标后再分析。"), true);
  assert.equal(isPublicInfoUserQuestion("需要您提供竞品菜单和价格证据。"), true);
  assert.equal(isPublicInfoUserQuestion("请上传公开信息截图或文件。"), true);
  assert.equal(isPublicInfoUserQuestion("公开资料暂缺，下一步请确认内部审批截止时间。"), false);
});

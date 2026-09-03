// 通用“先占扣、后交付、再结算”执行器。
//
// 适用场景：
// 1. 路由在调用供应商前已经通过 holdCredits 原子占扣；
// 2. generate 只负责调用供应商；
// 3. persist 负责把完整业务产物原子落库；
// 4. 只有 persist 成功后才允许 settle；
// 5. generate / persist 失败时，只有能证明外部调用尚未开始才 release；
// 6. 外调已开始或状态不确定时保留 hold 待对账，禁止猜测退款后重复调用；
// 7. settle 失败不回滚已经交付的业务产物，也不虚构实扣金额，而是保留 hold 待对账。

const text = (value) => String(value ?? "").slice(0, 500);

export function twoPhaseBillingSummary({
  state,
  hold,
  settled = null,
  error = null,
  note = "",
}) {
  const chargedCredits =
    state === "settled"
      ? Number(settled?.credits ?? 0)
      : state === "released"
        ? 0
        : null;
  return {
    state,
    holdId: Number(hold?.holdId || 0) || null,
    estimatedCredits: Number(hold?.credits || 0),
    heldCredits:
      state === "held" || state === "pending_reconciliation"
        ? Number(hold?.credits || 0)
        : 0,
    chargedCredits,
    // 兼容既有前端的 billing.credits；待对账时必须为 null，不能把 hold 冒充实扣。
    credits: chargedCredits,
    balance: settled?.balance ?? hold?.balance ?? null,
    costYuan: state === "settled" ? (settled?.costYuan ?? null) : null,
    pendingReconciliation: state === "pending_reconciliation",
    note: text(note),
    error: error ? text(error?.message || error) : null,
  };
}

export function withImmediateTransaction(db, work) {
  if (!db?.exec || typeof work !== "function") {
    throw new TypeError(
      "withImmediateTransaction 需要数据库连接与同步工作函数",
    );
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    if (result && typeof result.then === "function") {
      throw new TypeError(
        "业务落库事务必须是同步函数，不能在事务中等待外部异步操作",
      );
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务可能已由底层失败关闭 */
    }
    throw error;
  }
}

function attachBilling(error, billing, phase) {
  const target =
    error instanceof Error ? error : new Error(text(error) || "两阶段交付失败");
  target.billing = billing;
  target.deliveryPhase = phase;
  return target;
}

function billingUsageMissing() {
  return Object.assign(
    new Error(
      "真实 API 文本交付缺少可结算的有效 token 用量，已在业务落库前停止交付",
    ),
    { status: 409, code: "BILLING_USAGE_MISSING", retryable: false },
  );
}

function assertPositiveApiUsage(settleArgs) {
  const args = settleArgs && typeof settleArgs === "object" ? settleArgs : {};
  const aiMode = args.aiMode ?? "api";
  // 固定单价的图片/视频/向量任务以 credits 作为权威结算证据，
  // 模板或失败退款也不应被 token 门禁误伤。
  if (aiMode !== "api" || args.credits != null) return;
  const usage =
    args.usage && typeof args.usage === "object" ? args.usage : null;
  const hasInput =
    usage &&
    Object.prototype.hasOwnProperty.call(usage, "inputTokens") &&
    usage.inputTokens !== null &&
    usage.inputTokens !== "";
  const hasOutput =
    usage &&
    Object.prototype.hasOwnProperty.call(usage, "outputTokens") &&
    usage.outputTokens !== null &&
    usage.outputTokens !== "";
  const inputTokens = Number(usage?.inputTokens);
  const outputTokens = Number(usage?.outputTokens);
  if (
    !hasInput ||
    !hasOutput ||
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0 ||
    inputTokens + outputTokens <= 0
  ) {
    throw billingUsageMissing();
  }
}

export async function executeHeldDelivery({
  hold,
  generate,
  persist,
  settle,
  release,
  settlement,
  externalInvocationStarted = null,
  releaseNote = "生成或业务落库失败，预授权全额退回",
  settlementNote = "业务产物已交付，按真实用量结算",
  requirePositiveApiUsage = false,
  onPendingReconciliation = null,
  onBillingFinalized = null,
}) {
  if (!hold?.holdId)
    throw new TypeError("executeHeldDelivery 需要有效的预授权占扣");
  if (
    typeof generate !== "function" ||
    typeof persist !== "function" ||
    typeof settle !== "function" ||
    typeof release !== "function"
  ) {
    throw new TypeError("executeHeldDelivery 缺少生成、落库、结算或释放函数");
  }
  if (
    externalInvocationStarted !== null &&
    typeof externalInvocationStarted !== "boolean" &&
    typeof externalInvocationStarted !== "function"
  ) {
    throw new TypeError("externalInvocationStarted 必须是布尔值或同步函数");
  }

  let output;
  let delivery;
  let prevalidatedSettlementArgs;
  let phase = "generate";
  try {
    output = await generate();
    if (requirePositiveApiUsage) {
      phase = "validate_billing";
      prevalidatedSettlementArgs =
        typeof settlement === "function"
          ? settlement(output, null)
          : settlement || {};
      assertPositiveApiUsage(prevalidatedSettlementArgs);
    }
    phase = "persist";
    delivery = await persist(output);
  } catch (error) {
    let billing;
    let invocationStarted = false;
    let invocationStateUncertain = false;
    if (externalInvocationStarted !== null) {
      try {
        const observed =
          typeof externalInvocationStarted === "function"
            ? externalInvocationStarted()
            : externalInvocationStarted;
        if (typeof observed !== "boolean")
          throw new TypeError("external invocation state is not boolean");
        invocationStarted = observed;
      } catch {
        // 不能证明外调尚未发生时必须保守留扣，不能猜测退款。
        invocationStateUncertain = true;
      }
    }
    if (invocationStarted || invocationStateUncertain) {
      billing = twoPhaseBillingSummary({
        state: "pending_reconciliation",
        hold,
        note: invocationStateUncertain
          ? "无法证明外部供应商尚未调用，预授权保留待对账，禁止自动退款与重试。"
          : "外部供应商调用已开始，预授权保留待对账，禁止自动退款与重试。",
      });
      billing.externalInvocationStarted = invocationStarted || null;
      billing.externalInvocationStateKnown = !invocationStateUncertain;
      billing.releaseSuppressed = true;
      billing.deliveryPhase = phase;
      billing.reconciliationReason = invocationStateUncertain
        ? "external_invocation_state_unknown"
        : "external_invocation_started";
    } else {
      try {
        const released = release(
          hold,
          typeof releaseNote === "function"
            ? releaseNote(error, phase)
            : releaseNote,
        );
        billing = twoPhaseBillingSummary({
          state: "released",
          hold,
          settled: released,
          note: "本次未形成可交付产物，预授权已全额退回。",
        });
      } catch (releaseError) {
        billing = twoPhaseBillingSummary({
          state: "pending_reconciliation",
          hold,
          error: releaseError,
          note: "本次未形成可交付产物，但预授权释放异常，已保留待人工对账。",
        });
      }
    }
    throw attachBilling(error, billing, phase);
  }

  let billing;
  try {
    const settleArgs = requirePositiveApiUsage
      ? prevalidatedSettlementArgs
      : typeof settlement === "function"
        ? settlement(output, delivery)
        : settlement || {};
    const settled = settle(hold, {
      ...settleArgs,
      note: settleArgs?.note || settlementNote,
    });
    // settleHold 对重复结算返回 null。当前执行器持有的是新占扣；null 不能冒充本次已结算。
    if (!settled) throw new Error("预授权未完成本次结算，需人工核对占扣状态");
    billing = twoPhaseBillingSummary({
      state: "settled",
      hold,
      settled,
      note: "业务产物已交付，并按真实用量完成结算。",
    });
  } catch (settleError) {
    billing = twoPhaseBillingSummary({
      state: "pending_reconciliation",
      hold,
      error: settleError,
      note: "业务产物已交付；预授权仍保留，尚未确认实扣，需人工对账。",
    });
    if (typeof onPendingReconciliation === "function") {
      try {
        await onPendingReconciliation({
          hold,
          output,
          delivery,
          billing,
          error: settleError,
        });
      } catch (markError) {
        billing.reconciliationRecordError = text(
          markError?.message || markError,
        );
      }
    }
  }

  if (typeof onBillingFinalized === "function") {
    try {
      await onBillingFinalized({
        hold,
        output,
        delivery,
        billing,
      });
    } catch (recordError) {
      billing.billingRecordError = text(recordError?.message || recordError);
    }
  }

  return { output, delivery, billing };
}

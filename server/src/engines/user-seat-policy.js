import { q } from "../db.js";
import { assertSeatAvailable, primaryUserIdFor } from "./plan.js";

const managers = new Set(["boss", "admin"]);
const failure = (message, status, code) =>
  Object.assign(new Error(message), { status, code });

// Call only inside the same write transaction as the user mutation. A role is
// a business permission; it cannot create, transfer or release the main seat.
export function assertUserSeatMutation({
  tenantId,
  actorId,
  target,
  changes = {},
}) {
  if (!target) throw failure("账号不存在或不属于本企业", 404, "USER_NOT_FOUND");
  if (target.role === "platform_super")
    throw failure(
      "企业账号管理不可修改平台账号",
      403,
      "PLATFORM_ACCOUNT_PROTECTED",
    );
  const primaryId = primaryUserIdFor(tenantId);
  if (Number(target.id) === Number(primaryId)) {
    if (Number(actorId) !== Number(primaryId))
      throw failure(
        "主账号只能由本人维护，副账号不能修改主账号",
        403,
        "PRIMARY_ACCOUNT_PROTECTED",
      );
    if (
      changes.status === "停用" ||
      (changes.role !== undefined && changes.role !== target.role)
    )
      throw failure(
        "主账号须保留，不能停用或变更主账号角色",
        409,
        "PRIMARY_ACCOUNT_PROTECTED",
      );
  }
  if (
    Number(actorId) === Number(target.id) &&
    (changes.status === "停用" ||
      (changes.role !== undefined && changes.role !== target.role))
  )
    throw failure(
      "不能修改当前登录账号的角色或停用状态",
      400,
      "CURRENT_ACCOUNT_PROTECTED",
    );
  if (changes.status === "启用" && target.status !== "启用")
    assertSeatAvailable(tenantId, { userId: Number(target.id) });
  if (
    target.status === "启用" &&
    managers.has(target.role) &&
    (changes.status === "停用" ||
      (changes.role !== undefined && !managers.has(changes.role)))
  ) {
    const others =
      q.get(
        `SELECT COUNT(*) n FROM users
      WHERE tenant_id=? AND id!=? AND status='启用' AND role IN ('boss','admin')`,
        tenantId,
        target.id,
      )?.n || 0;
    if (!others)
      throw failure(
        "不能停用或降权企业最后一个启用的老板/管理员账号",
        409,
        "LAST_ADMIN_PROTECTED",
      );
  }
}

export function disableUserAutomations(tenantId, userId) {
  return Number(
    q.run(
      `UPDATE content_automation_rules
    SET enabled=0,next_run_at=NULL,updated_at=datetime('now','localtime')
    WHERE tenant_id=? AND created_by=? AND enabled=1`,
      tenantId,
      userId,
    ).changes || 0,
  );
}

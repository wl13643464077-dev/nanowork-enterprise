// PRD v2.2 FR-4.3：高德凭证/配额出问题时给管理员告警（站内信 + 飞书管理层推送）。
// amap.js 本身保持无依赖，只负责识别与节流；这里负责“通知谁、怎么通知”。
// 高德 Key 是平台级配置，所以通知平台超管和总部（租户 1）的老板/管理员。
import { q, runWithTenant } from "../db.js";
import { notify } from "../util.js";
import { pushFeishuToManagers } from "./feishu.js";
import { setAmapAlertHandler } from "./amap.js";

const HQ_TENANT_ID = 1;

export function amapAlertMessage(event = {}) {
  if (event.kind === "near_quota") {
    return {
      title: "高德地图今日调用已接近配额",
      body: `今日已调用 ${event.count} 次，配额 ${event.quota} 次（≥80%）。系统已自动收紧每单请求预算，快查优先走缓存和公开检索；如需提高配额请到高德开放平台处理。`,
    };
  }
  const reason = event.explanation || event.message || "未知原因";
  return {
    title: event.kind === "quota" ? "高德地图配额已用尽" : "高德地图凭证异常",
    body: `高德返回 ${event.infocode || "?"}：${reason}。商圈类任务会自动改用公开网页补位，但店铺、人均和距离数据会变少。请到“系统管理 → 高德面板”点“立即自检”确认，并检查 Key、白名单和配额。`,
  };
}

export function amapAlertRecipients() {
  return q
    .all(
      `SELECT id FROM users
       WHERE (role = 'platform_super' OR (tenant_id = ? AND role IN ('boss','admin')))
         AND (status IS NULL OR status = '启用')`,
      HQ_TENANT_ID,
    )
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

export async function deliverAmapAlert(event, { pushFeishu = pushFeishuToManagers } = {}) {
  const message = amapAlertMessage(event);
  const recipients = amapAlertRecipients();
  for (const userId of recipients) {
    try {
      notify(userId, "system", message.title, message.body, "/admin");
    } catch {
      // 单个用户通知失败不影响其他人。
    }
  }
  let feishu = null;
  try {
    feishu = await runWithTenant(HQ_TENANT_ID, () =>
      pushFeishu({ title: message.title, lines: [message.body] }, HQ_TENANT_ID),
    );
  } catch (error) {
    feishu = { ok: false, error: String(error?.message || error).slice(0, 200) };
  }
  return { notified: recipients.length, feishu, message };
}

export function registerAmapAlerts(options = {}) {
  setAmapAlertHandler((event) => deliverAmapAlert(event, options));
}

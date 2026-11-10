#!/usr/bin/env bash
# 纳米Work行业版 · 备份告警（推送到飞书群自定义机器人）
#
# 用法：
#   backup-alert.sh fail            备份失败。由 nanowork-backup-alert.service 经 OnFailure= 自动调用，
#                                   附上 nanowork-backup.service 最近的日志
#   backup-alert.sh warn "<说明>"    备份成功但有隐患（如旧备份删不掉）。由 backup.sh 结束时调用
#   backup-alert.sh test            发一条测试消息，确认机器人配置正确
#
# 配置（写在 /etc/nanowork/server.env，应用本身不读取这两项）：
#   OPS_ALERT_FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
#   OPS_ALERT_FEISHU_SECRET=     # 机器人开了"签名校验"才填
# 未配置 webhook 时只在日志里记一行并正常退出，不影响备份本身。
#
# 2026-11 停站事故背景：备份连续失败一个月只留在 journal 里，没人发现，直到磁盘写满。
set -uo pipefail

MODE="${1:-}"
DETAIL="${2:-}"
ENV_FILE="${ENV_FILE:-/etc/nanowork/server.env}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/nanowork}"
UNIT="${BACKUP_UNIT:-nanowork-backup.service}"

case "${MODE}" in
  fail|warn|test) ;;
  *) echo "用法：backup-alert.sh fail | warn \"<说明>\" | test" >&2; exit 2 ;;
esac

env_value() {
  [[ -r "${ENV_FILE}" ]] || return 0
  { grep -E "^[[:space:]]*$1=" "${ENV_FILE}" || true; } | tail -n1 | cut -d= -f2- | tr -d '\r' \
    | sed -E "s/^[[:space:]]*[\"']?//; s/[\"']?[[:space:]]*$//"
}
WEBHOOK="${OPS_ALERT_FEISHU_WEBHOOK:-$(env_value OPS_ALERT_FEISHU_WEBHOOK)}"
SECRET="${OPS_ALERT_FEISHU_SECRET:-$(env_value OPS_ALERT_FEISHU_SECRET)}"

if [[ -z "${WEBHOOK}" ]]; then
  echo "[backup-alert] 未配置 OPS_ALERT_FEISHU_WEBHOOK，告警只记录在本日志：mode=${MODE} ${DETAIL}" >&2
  exit 0
fi
if [[ ! "${WEBHOOK}" =~ ^https://open\.(feishu\.cn|larksuite\.com)/open-apis/bot/v2/hook/[A-Za-z0-9_-]+$ ]]; then
  echo "[backup-alert][fail] OPS_ALERT_FEISHU_WEBHOOK 格式不对，应为 https://open.feishu.cn/open-apis/bot/v2/hook/<token>" >&2
  exit 1
fi

host="$(hostname)"
now="$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S')"
disk="$(df -h "${BACKUP_ROOT}" 2>/dev/null | awk 'NR==2 {printf "已用 %s（%s / %s），剩余 %s", $5, $3, $2, $4}')"

case "${MODE}" in
  fail)
    title="【纳米Work】备份失败"
    logs="$(journalctl -u "${UNIT}" -n 25 --no-pager -o cat 2>/dev/null | tail -n 25)"
    [[ -n "${logs}" ]] || logs="（读不到日志，请在服务器执行：journalctl -u ${UNIT} -n 50）"
    body="服务器：${host}
时间：${now}
磁盘：${disk:-未知}

最近日志：
${logs}

处理：root 登录后执行 journalctl -u ${UNIT} -n 100 查看；修复后可手动重跑 systemctl start ${UNIT}"
    ;;
  warn)
    title="【纳米Work】备份完成，但有隐患"
    body="服务器：${host}
时间：${now}
磁盘：${disk:-未知}

${DETAIL}

这类问题不处理会让旧备份越积越多，最终写满磁盘导致停站。"
    ;;
  test)
    title="【纳米Work】备份告警测试"
    body="服务器：${host}
时间：${now}
磁盘：${disk:-未知}

收到这条说明备份告警已配置成功。"
    ;;
esac

# 用 node（服务器上已装 Node 24）负责签名、JSON 转义与重试，不依赖 curl/openssl
WEBHOOK="${WEBHOOK}" SECRET="${SECRET}" TEXT="${title}
${body}" node --input-type=module - <<'NODE'
import { createHmac } from "node:crypto";
const { WEBHOOK, SECRET, TEXT } = process.env;
const payload = { msg_type: "text", content: { text: TEXT.slice(0, 3800) } };
let lastError = "";
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const body = { ...payload };
  if (SECRET) {
    // 飞书自定义机器人签名：key = `${timestamp}\n${secret}`，对空串做 HmacSHA256 后 base64
    const timestamp = String(Math.floor(Date.now() / 1000));
    body.timestamp = timestamp;
    body.sign = createHmac("sha256", `${timestamp}\n${SECRET}`).update("").digest("base64");
  }
  try {
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    const code = data.code ?? data.StatusCode;
    if (res.ok && (code === 0 || code === undefined)) {
      console.error("[backup-alert] 已推送到飞书");
      process.exit(0);
    }
    lastError = `HTTP ${res.status} code=${code} msg=${data.msg ?? data.StatusMessage ?? ""}`;
    // 签名错、关键词不匹配等配置问题重试也没用
    if (res.ok && code !== undefined) break;
  } catch (error) {
    lastError = String(error?.message || error);
  }
  await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
}
console.error(`[backup-alert][fail] 飞书推送失败：${lastError}`);
process.exit(1);
NODE

#!/usr/bin/env bash
# 纳米Work行业版 · 回滚到上一版代码（可选同时恢复对应备份）
#
# 用法（root）：
#   rollback.sh                       回滚到 current/PREVIOUS_RELEASE 记录的上一版
#   rollback.sh <release-ts>          回滚到指定 /opt/nanowork/releases/<release-ts>
#   rollback.sh --list                列出可用版本
#   选项：
#     --with-backup                   同时恢复"当前版本部署时"自动做的 pre-deploy 备份（current/BACKUP_REF）
#     --restore-backup <备份目录>      同时恢复指定备份目录（优先于 --with-backup）
#     --yes                           跳过确认
#
# 说明：
#   - 只切代码不恢复数据时，若新版本执行过 scripts/migrations 中不可逆迁移，旧代码可能不兼容 → 脚本会提示。
#   - 恢复数据会丢失自备份以来的全部业务写入（演示环境通常可接受；正式环境请先评估）。
set -euo pipefail

APP_USER="${APP_USER:-nanowork}"
APP_ROOT="${APP_ROOT:-/opt/nanowork}"
SERVICE="${SERVICE:-nanowork}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3107/api/health}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASES="${APP_ROOT}/releases"
CURRENT_LINK="${APP_ROOT}/current"

TARGET_TS=""
WITH_BACKUP=0
RESTORE_BACKUP=""
ASSUME_YES=0
LIST_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --list) LIST_ONLY=1; shift ;;
    --with-backup) WITH_BACKUP=1; shift ;;
    --restore-backup) RESTORE_BACKUP="${2:-}"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "未知参数：$1" >&2; exit 1 ;;
    *) TARGET_TS="$1"; shift ;;
  esac
done

log() { echo "[rollback] $*"; }
die() { echo "[rollback][fail] $*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "请用 root 或 sudo 运行"
[[ -d "${RELEASES}" ]] || die "没有 ${RELEASES}，尚未用 deploy.sh 部署过"

current_target=""
if [[ -L "${CURRENT_LINK}" ]]; then current_target="$(readlink -f "${CURRENT_LINK}")"; fi

if [[ "${LIST_ONLY}" == "1" ]]; then
  echo "可用版本（* = 当前）："
  for rel in $(ls -1d "${RELEASES}"/[0-9]* 2>/dev/null | sort -r); do
    mark=" "
    [[ "${rel}" == "${current_target}" ]] && mark="*"
    printf ' %s %s  commit=%s  backup=%s\n' "${mark}" "$(basename "${rel}")" \
      "$(cut -c1-10 "${rel}/GIT_COMMIT" 2>/dev/null || echo -)" \
      "$(cat "${rel}/BACKUP_REF" 2>/dev/null || echo -)"
  done
  exit 0
fi

# 目标版本
if [[ -z "${TARGET_TS}" ]]; then
  [[ -n "${current_target}" ]] || die "current 不存在，无法推断上一版；请显式指定 <release-ts>"
  prev="$(cat "${current_target}/PREVIOUS_RELEASE" 2>/dev/null || true)"
  [[ -n "${prev}" && -d "${prev}" ]] || die "current/PREVIOUS_RELEASE 为空或目录已被清理；用 --list 查看后显式指定"
  TARGET_DIR="${prev}"
else
  TARGET_DIR="${RELEASES}/${TARGET_TS}"
  [[ -d "${TARGET_DIR}" ]] || die "版本不存在：${TARGET_DIR}"
fi
[[ "${TARGET_DIR}" != "${current_target}" ]] || die "目标版本就是当前版本，无需回滚"
[[ -f "${TARGET_DIR}/server/package.json" && -d "${TARGET_DIR}/server/node_modules" ]] || die "${TARGET_DIR} 不完整（缺 node_modules），无法回滚到它"

# 备份选择
BACKUP_DIR=""
if [[ -n "${RESTORE_BACKUP}" ]]; then
  BACKUP_DIR="${RESTORE_BACKUP}"
elif [[ "${WITH_BACKUP}" == "1" ]]; then
  BACKUP_DIR="$(cat "${current_target}/BACKUP_REF" 2>/dev/null || true)"
  [[ -n "${BACKUP_DIR}" ]] || die "当前版本没有记录 pre-deploy 备份（首次部署或备份被跳过）；请用 --restore-backup 指定"
fi
if [[ -n "${BACKUP_DIR}" ]]; then
  [[ -d "${BACKUP_DIR}" && -f "${BACKUP_DIR}/manifest.txt" ]] || die "备份目录无效：${BACKUP_DIR}"
fi

# 迁移不兼容提示
if [[ -z "${BACKUP_DIR}" && -d "${current_target}/scripts/migrations" ]]; then
  cur_count="$(ls -1 "${current_target}/scripts/migrations"/*.mjs 2>/dev/null | wc -l | tr -d ' ')"
  tgt_count="$(ls -1 "${TARGET_DIR}/scripts/migrations"/*.mjs 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "${cur_count}" -gt "${tgt_count}" ]]; then
    echo "[rollback][warn] 当前版本比目标版本多 $((cur_count - tgt_count)) 个 scripts/migrations 迁移，旧代码可能不兼容新表结构；建议加 --with-backup 一并恢复数据" >&2
  fi
fi

echo
echo "================ 回滚确认 ================"
echo "当前版本：${current_target:-（无）}"
echo "目标版本：${TARGET_DIR}"
echo "恢复备份：${BACKUP_DIR:-（不恢复数据，只切代码）}"
echo "=========================================="
if [[ "${ASSUME_YES}" != "1" ]]; then
  read -r -p "输入 ROLLBACK 确认继续： " confirm
  [[ "${confirm}" == "ROLLBACK" ]] || die "已取消"
fi

# 停服务 → （恢复数据）→ 切链接 → 起服务
log "停止 ${SERVICE}"
systemctl stop "${SERVICE}" || true

if [[ -n "${BACKUP_DIR}" ]]; then
  log "恢复数据 ${BACKUP_DIR}"
  bash "${SCRIPT_DIR}/restore.sh" "${BACKUP_DIR}" --yes
  # restore.sh 在服务停止状态下不会自动启动服务，这里统一在切链接后启动
fi

log "current -> ${TARGET_DIR}"
ln -sfn "${TARGET_DIR}" "${CURRENT_LINK}.tmp"
mv -Tf "${CURRENT_LINK}.tmp" "${CURRENT_LINK}"
chown -h "${APP_USER}:${APP_USER}" "${CURRENT_LINK}"

if [[ -f "${TARGET_DIR}/ops/deploy/nanowork.service" ]] && ! cmp -s "${TARGET_DIR}/ops/deploy/nanowork.service" "/etc/systemd/system/${SERVICE}.service" 2>/dev/null; then
  install -m 0644 "${TARGET_DIR}/ops/deploy/nanowork.service" "/etc/systemd/system/${SERVICE}.service"
  log "systemd 单元已同步为目标版本"
fi
systemctl daemon-reload
systemctl start "${SERVICE}"

deadline=$((SECONDS + 90))
while [[ ${SECONDS} -lt ${deadline} ]]; do
  if body="$(curl -fsS --max-time 3 "${HEALTH_URL}" 2>/dev/null)" && [[ "${body}" == *'"ok":true'* ]]; then
    log "/api/health → ${body}"
    log "回滚完成：current -> ${TARGET_DIR}"
    exit 0
  fi
  if ! systemctl is-active --quiet "${SERVICE}"; then break; fi
  sleep 2
done
journalctl -u "${SERVICE}" -n 60 --no-pager || true
die "回滚后服务未就绪，请检查日志（journalctl -u ${SERVICE}）"

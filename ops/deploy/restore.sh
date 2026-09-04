#!/usr/bin/env bash
# 纳米Work行业版 · 从 backup.sh 产物恢复（数据库 + uploads）
#
# 用法（root）：
#   restore.sh <备份目录> [--db-only] [--uploads-only] [--yes]
#     <备份目录>     /var/backups/nanowork/<ts>[-label]（含 db.sqlite / uploads.tar.gz / manifest.txt）
#     --yes          跳过交互确认（仅供 rollback.sh 等自动化调用；人工操作请不要加）
#
# 流程：
#   1. 校验 manifest sha256
#   2. 二次确认（需输入大写 RESTORE）
#   3. systemctl stop nanowork
#   4. 把当前库与 uploads 先做一份 pre-restore-<ts> 备份（可回退"恢复"本身）
#   5. 覆盖数据库（删除旧 -wal/-shm）、覆盖 uploads（旧目录改名保留 uploads.pre-restore-<ts>）
#   6. 修正属主/权限（nanowork、0700/0600），systemctl start，等待 /api/health
set -euo pipefail
umask 077

APP_USER="${APP_USER:-nanowork}"
DATA_DIR="${DATA_DIR:-/var/lib/nanowork/data}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/nanowork}"
ENV_FILE="${ENV_FILE:-/etc/nanowork/server.env}"
SERVICE="${SERVICE:-nanowork}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3107/api/health}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SRC=""
DB_ONLY=0
UPLOADS_ONLY=0
ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-only) DB_ONLY=1; shift ;;
    --uploads-only) UPLOADS_ONLY=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "未知参数：$1" >&2; exit 1 ;;
    *) SRC="$1"; shift ;;
  esac
done

log()  { echo "[restore] $*"; }
die()  { echo "[restore][fail] $*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "请用 root 或 sudo 运行"
[[ -n "${SRC}" ]] || die "请指定备份目录，例如 ${BACKUP_ROOT}/20260908030000-daily"
[[ -d "${SRC}" ]] || die "备份目录不存在：${SRC}"
[[ -f "${SRC}/manifest.txt" ]] || die "缺少 ${SRC}/manifest.txt"
[[ "${DB_ONLY}" == "1" && "${UPLOADS_ONLY}" == "1" ]] && die "--db-only 与 --uploads-only 不能同时使用"

db_from_env=""
if [[ -r "${ENV_FILE}" ]]; then
  db_from_env="$(grep -E '^[[:space:]]*NANOWORK_DB=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- | tr -d '\r' | sed -E "s/^[[:space:]]*[\"']?//; s/[\"']?[[:space:]]*$//")"
fi
DB_PATH="${NANOWORK_DB:-${db_from_env:-${DATA_DIR}/nanowork-industry.db}}"

RESTORE_DB=1; RESTORE_UPLOADS=1
[[ "${DB_ONLY}" == "1" ]] && RESTORE_UPLOADS=0
[[ "${UPLOADS_ONLY}" == "1" ]] && RESTORE_DB=0
[[ "${RESTORE_DB}" == "1" && ! -f "${SRC}/db.sqlite" ]] && die "备份中没有 db.sqlite"
if [[ "${RESTORE_UPLOADS}" == "1" && ! -f "${SRC}/uploads.tar.gz" ]]; then
  log "备份中没有 uploads.tar.gz，只恢复数据库"
  RESTORE_UPLOADS=0
fi

# 1. 校验
log "校验 sha256 ..."
( cd "${SRC}" && grep -E '^[0-9a-f]{64}  ' manifest.txt | sha256sum -c --quiet - ) || die "sha256 校验失败，备份可能损坏"
if command -v sqlite3 >/dev/null 2>&1 && [[ "${RESTORE_DB}" == "1" ]]; then
  integrity="$(sqlite3 "${SRC}/db.sqlite" 'PRAGMA integrity_check;' | head -n1)"
  [[ "${integrity}" == "ok" ]] || die "备份库 integrity_check=${integrity}"
fi
log "校验通过"

echo
echo "================ 恢复确认 ================"
sed -n '1,8p' "${SRC}/manifest.txt"
echo "------------------------------------------"
echo "目标数据库：${DB_PATH}      $( [[ "${RESTORE_DB}" == "1" ]] && echo '[将被覆盖]' || echo '[不动]' )"
echo "目标 uploads：${DATA_DIR}/uploads  $( [[ "${RESTORE_UPLOADS}" == "1" ]] && echo '[将被替换]' || echo '[不动]' )"
echo "服务 ${SERVICE} 将停止并在恢复后重启。"
echo "=========================================="
if [[ "${ASSUME_YES}" != "1" ]]; then
  read -r -p "输入 RESTORE 确认继续： " confirm
  [[ "${confirm}" == "RESTORE" ]] || die "已取消"
fi

TS="$(date +%Y%m%d%H%M%S)"

# 3. 停服务
was_active=0
if systemctl is-active --quiet "${SERVICE}"; then
  was_active=1
  log "停止 ${SERVICE} ..."
  systemctl stop "${SERVICE}"
fi

# 4. 恢复前再备一份当前状态（若当前库存在）
if [[ -f "${DB_PATH}" && -f "${SCRIPT_DIR}/backup.sh" ]]; then
  log "保存恢复前快照 ..."
  ENV_FILE="${ENV_FILE}" BACKUP_ROOT="${BACKUP_ROOT}" DATA_DIR="${DATA_DIR}" bash "${SCRIPT_DIR}/backup.sh" "pre-restore-${TS}" >/dev/null || log "恢复前快照失败（继续恢复）"
fi

# 5. 覆盖
if [[ "${RESTORE_DB}" == "1" ]]; then
  log "恢复数据库 → ${DB_PATH}"
  install -d -m 0700 -o "${APP_USER}" -g "${APP_USER}" "$(dirname "${DB_PATH}")"
  rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"
  install -m 0600 -o "${APP_USER}" -g "${APP_USER}" "${SRC}/db.sqlite" "${DB_PATH}.restoring"
  mv -f "${DB_PATH}.restoring" "${DB_PATH}"
fi
if [[ "${RESTORE_UPLOADS}" == "1" ]]; then
  log "恢复 uploads → ${DATA_DIR}/uploads"
  if [[ -d "${DATA_DIR}/uploads" ]]; then
    mv "${DATA_DIR}/uploads" "${DATA_DIR}/uploads.pre-restore-${TS}"
  fi
  tar -xzf "${SRC}/uploads.tar.gz" -C "${DATA_DIR}"
  chown -R "${APP_USER}:${APP_USER}" "${DATA_DIR}/uploads"
  chmod -R u+rwX,go-rwx "${DATA_DIR}/uploads"
  log "旧 uploads 保留在 ${DATA_DIR}/uploads.pre-restore-${TS}（确认无误后可删除）"
fi
chown "${APP_USER}:${APP_USER}" "${DATA_DIR}"
chmod 0700 "${DATA_DIR}"

# 6. 启动
if [[ "${was_active}" == "1" ]]; then
  log "启动 ${SERVICE} ..."
  systemctl start "${SERVICE}"
  deadline=$((SECONDS + 60))
  while [[ ${SECONDS} -lt ${deadline} ]]; do
    if body="$(curl -fsS --max-time 3 "${HEALTH_URL}" 2>/dev/null)" && [[ "${body}" == *'"ok":true'* ]]; then
      log "/api/health → ${body}"
      log "恢复完成"
      exit 0
    fi
    sleep 2
  done
  journalctl -u "${SERVICE}" -n 40 --no-pager || true
  die "服务未在 60s 内就绪，请检查日志"
else
  log "服务此前未运行，未自动启动。恢复完成。"
fi

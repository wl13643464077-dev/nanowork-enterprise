#!/usr/bin/env bash
# 纳米Work行业版 · 备份（SQLite 一致快照 + uploads 归档；保留 14 天）
#
# 用法（root 或 nanowork 用户）：
#   backup.sh [label] [--print-path] [--retention-days 14] [--no-uploads]
#     label          可选标签，目录名会变成 <ts>-<label>（deploy.sh 用 pre-deploy-<ts>）
#     --print-path   只把备份目录路径打到 stdout，其余日志走 stderr（供脚本调用）
#
# 产物：/var/backups/nanowork/<ts>[-label]/
#   db.sqlite        sqlite3 .backup 在线一致快照（WAL 模式下安全；服务无需停机）
#   uploads.tar.gz   /var/lib/nanowork/data/uploads 整目录（含 artifacts）
#   manifest.txt     大小、sha256、来源路径、integrity_check 结果
#
# cron 示例（每日 03:00，写入 /etc/cron.d/nanowork-backup）：
#   0 3 * * * root /opt/nanowork/current/ops/deploy/backup.sh daily >> /var/log/nanowork-backup.log 2>&1
#
# 所有产物 0600/0700 且属主 nanowork（umask 077）。
set -euo pipefail
umask 077

APP_USER="${APP_USER:-nanowork}"
DATA_DIR="${DATA_DIR:-/var/lib/nanowork/data}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/nanowork}"
ENV_FILE="${ENV_FILE:-/etc/nanowork/server.env}"
RETENTION_DAYS=14
PRINT_PATH=0
WITH_UPLOADS=1
LABEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print-path) PRINT_PATH=1; shift ;;
    --retention-days) RETENTION_DAYS="${2:-14}"; shift 2 ;;
    --no-uploads) WITH_UPLOADS=0; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "未知参数：$1" >&2; exit 1 ;;
    *) LABEL="$1"; shift ;;
  esac
done
[[ "${RETENTION_DAYS}" =~ ^[0-9]+$ ]] || { echo "--retention-days 需要整数" >&2; exit 1; }
if [[ -n "${LABEL}" && ! "${LABEL}" =~ ^[A-Za-z0-9._-]{1,60}$ ]]; then
  echo "label 只能包含字母数字 . _ -（≤60）" >&2; exit 1
fi

log() { if [[ "${PRINT_PATH}" == "1" ]]; then echo "[backup] $*" >&2; else echo "[backup] $*"; fi; }
die() { echo "[backup][fail] $*" >&2; exit 1; }

# 数据库路径：env 文件 NANOWORK_DB 优先，否则默认
db_from_env=""
if [[ -r "${ENV_FILE}" ]]; then
  db_from_env="$(grep -E '^[[:space:]]*NANOWORK_DB=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- | tr -d '\r' | sed -E "s/^[[:space:]]*[\"']?//; s/[\"']?[[:space:]]*$//")"
fi
DB_PATH="${NANOWORK_DB:-${db_from_env:-${DATA_DIR}/nanowork-industry.db}}"
[[ -f "${DB_PATH}" ]] || die "数据库不存在：${DB_PATH}"

TS="$(date +%Y%m%d%H%M%S)"
DEST="${BACKUP_ROOT}/${TS}${LABEL:+-${LABEL}}"
mkdir -p "${DEST}"
chmod 0700 "${DEST}"
log "目标目录 ${DEST}"

# 以数据库属主身份读库：root 直接打开 WAL 库可能新建 root 属主的 -wal/-shm 文件，导致服务之后无法写入
as_owner() {
  if [[ "$(id -u)" == "0" ]] && id -u "${APP_USER}" >/dev/null 2>&1; then
    sudo -u "${APP_USER}" -H env -i PATH="${PATH}" HOME="${DATA_DIR%/data}" "$@"
  else
    "$@"
  fi
}
if [[ "$(id -u)" == "0" ]] && id -u "${APP_USER}" >/dev/null 2>&1; then
  chown "${APP_USER}:${APP_USER}" "${DEST}"
fi

# --- SQLite 一致快照 ---
DB_OUT="${DEST}/db.sqlite"
if command -v sqlite3 >/dev/null 2>&1; then
  # .backup 走 SQLite Online Backup API，对 WAL 模式的在线库安全
  as_owner sqlite3 "${DB_PATH}" ".timeout 15000" ".backup '${DB_OUT}'"
  log "sqlite3 .backup 完成"
else
  log "未安装 sqlite3 CLI，改用 node:sqlite VACUUM INTO"
  as_owner env DB_PATH="${DB_PATH}" DB_OUT="${DB_OUT}" node --input-type=module - <<'NODE'
import { DatabaseSync } from "node:sqlite";
const src = new DatabaseSync(process.env.DB_PATH, { readOnly: true });
try {
  src.exec("PRAGMA busy_timeout = 15000;");
  src.exec(`VACUUM INTO '${process.env.DB_OUT.replaceAll("'", "''")}'`);
} finally {
  src.close();
}
NODE
fi
chmod 0600 "${DB_OUT}"

# 完整性校验（对快照做，不锁在线库）
if command -v sqlite3 >/dev/null 2>&1; then
  integrity="$(sqlite3 "${DB_OUT}" 'PRAGMA integrity_check;' | head -n1)"
else
  integrity="$(DB_OUT="${DB_OUT}" node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const d = new DatabaseSync(process.env.DB_OUT, { readOnly: true }); console.log(Object.values(d.prepare("PRAGMA integrity_check").get())[0]); d.close();')"
fi
[[ "${integrity}" == "ok" ]] || { rm -rf "${DEST}"; die "快照 integrity_check=${integrity}，已删除本次备份"; }
log "integrity_check ok（$(du -h "${DB_OUT}" | cut -f1)）"

# --- uploads ---
UPLOADS_OUT=""
if [[ "${WITH_UPLOADS}" == "1" ]]; then
  if [[ -d "${DATA_DIR}/uploads" ]]; then
    UPLOADS_OUT="${DEST}/uploads.tar.gz"
    # --warning=no-file-changed：备份期间服务可能正在写新文件，允许继续
    as_owner tar --warning=no-file-changed -czf "${UPLOADS_OUT}" -C "${DATA_DIR}" uploads || [[ $? -eq 1 ]]
    chmod 0600 "${UPLOADS_OUT}"
    log "uploads 归档完成（$(du -h "${UPLOADS_OUT}" | cut -f1)）"
  else
    log "无 ${DATA_DIR}/uploads，跳过"
  fi
fi

# --- manifest ---
{
  echo "created_at=$(date -Is)"
  echo "host=$(hostname)"
  echo "label=${LABEL}"
  echo "source_db=${DB_PATH}"
  echo "source_uploads=${DATA_DIR}/uploads"
  echo "integrity_check=${integrity}"
  echo "release=$(readlink -f /opt/nanowork/current 2>/dev/null || echo unknown)"
  ( cd "${DEST}" && sha256sum db.sqlite $( [[ -n "${UPLOADS_OUT}" ]] && echo uploads.tar.gz ) )
} > "${DEST}/manifest.txt"
chmod 0600 "${DEST}/manifest.txt"

if [[ "$(id -u)" == "0" ]] && id -u "${APP_USER}" >/dev/null 2>&1; then
  chown -R "${APP_USER}:${APP_USER}" "${DEST}"
fi

# --- 保留策略 ---
if [[ "${RETENTION_DAYS}" -gt 0 ]]; then
  removed=0
  while IFS= read -r -d '' old; do
    rm -rf "${old}"
    removed=$((removed + 1))
  done < <(find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9]{14}(-[A-Za-z0-9._-]+)?$' -mtime "+${RETENTION_DAYS}" -print0)
  log "清理 ${RETENTION_DAYS} 天前的备份 ${removed} 个"
fi

log "完成：${DEST}"
if [[ "${PRINT_PATH}" == "1" ]]; then
  echo "${DEST}"
fi

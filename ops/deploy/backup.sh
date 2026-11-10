#!/usr/bin/env bash
# 纳米Work行业版 · 备份（SQLite 一致快照 + uploads 归档；保留 14 天）
#
# 用法（root 或 nanowork 用户）：
#   backup.sh [label] [--print-path] [--retention-days 14] [--keep-min 2] [--min-free-gb 2] [--no-uploads] [--prune-only]
#     label          可选标签，目录名会变成 <ts>-<label>（deploy.sh 用 pre-deploy-<ts>）
#     --print-path   只把备份目录路径打到 stdout，其余日志走 stderr（供脚本调用）
#     --keep-min     无论多旧，至少保留这么多份完整的自动备份（默认 2）
#     --min-free-gb  写完本次备份后磁盘至少还要剩这么多 GB（默认 2，与启动自检阈值一致）
#     --prune-only   只按保留策略清理，不做新备份
#
# 产物：/var/backups/nanowork/<ts>[-label]/
#   db.sqlite        sqlite3 .backup 在线一致快照（WAL 模式下安全；服务无需停机）
#   uploads.tar.gz   /var/lib/nanowork/data/uploads 整目录（含 artifacts）
#   manifest.txt     大小、sha256、来源路径、integrity_check 结果（有它才算完整备份）
#
# 保留策略（2026-11 停站事故后重写）：
#   - 先清理再备份：磁盘紧张时也能先腾出空间，不会因为备份失败而永远轮不到清理。
#   - 只自动清理系统产生的备份：无标签、daily、pre-deploy-<ts>、pre-restore-<ts>。
#     其他标签（如 pre-provision-50）是人工里程碑快照，永不自动删除。
#   - 超过保留天数才删，且至少保留 --keep-min 份完整备份；没有 manifest 的残缺备份一并清理。
#   - 某个目录删不掉（例如属主是 root、本脚本以 nanowork 运行）只告警并跳过，不中断清理和备份。
#   - 写入前估算空间：清理后仍不够 "数据库 + uploads + --min-free-gb" 就放弃本次备份并报错，
#     不把磁盘写满拖垮在线服务；中途失败的半成品目录会被删掉。
#
# 定时：ops/deploy/nanowork-backup.timer（每 4 天 03:00）；所有产物 0600/0700 且属主 nanowork（umask 077）。
set -euo pipefail
umask 077

APP_USER="${APP_USER:-nanowork}"
DATA_DIR="${DATA_DIR:-/var/lib/nanowork/data}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/nanowork}"
ENV_FILE="${ENV_FILE:-/etc/nanowork/server.env}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
KEEP_MIN="${BACKUP_KEEP_MIN:-2}"
MIN_FREE_GB="${BACKUP_MIN_FREE_GB:-2}"
PRINT_PATH=0
WITH_UPLOADS=1
PRUNE_ONLY=0
LABEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print-path) PRINT_PATH=1; shift ;;
    --retention-days) RETENTION_DAYS="${2:-14}"; shift 2 ;;
    --keep-min) KEEP_MIN="${2:-2}"; shift 2 ;;
    --min-free-gb) MIN_FREE_GB="${2:-2}"; shift 2 ;;
    --no-uploads) WITH_UPLOADS=0; shift ;;
    --prune-only) PRUNE_ONLY=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "未知参数：$1" >&2; exit 1 ;;
    *) LABEL="$1"; shift ;;
  esac
done
[[ "${RETENTION_DAYS}" =~ ^[0-9]+$ ]] || { echo "--retention-days 需要整数" >&2; exit 1; }
[[ "${KEEP_MIN}" =~ ^[0-9]+$ ]] || { echo "--keep-min 需要整数" >&2; exit 1; }
[[ "${MIN_FREE_GB}" =~ ^[0-9]+$ ]] || { echo "--min-free-gb 需要整数" >&2; exit 1; }
if [[ -n "${LABEL}" && ! "${LABEL}" =~ ^[A-Za-z0-9._-]{1,60}$ ]]; then
  echo "label 只能包含字母数字 . _ -（≤60）" >&2; exit 1
fi

log() { if [[ "${PRINT_PATH}" == "1" ]]; then echo "[backup] $*" >&2; else echo "[backup] $*"; fi; }
warn() { echo "[backup][warn] $*" >&2; }
die() { echo "[backup][fail] $*" >&2; exit 1; }

# 删不掉的目录名（两轮清理会重复遇到同一个，结束时去重后发一次告警）
UNDELETABLE=()
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 备份本身成功但有隐患时推送飞书；告警失败不影响备份结果
alert_warn() {
  [[ -f "${SCRIPT_DIR}/backup-alert.sh" ]] || return 0
  ENV_FILE="${ENV_FILE}" BACKUP_ROOT="${BACKUP_ROOT}" bash "${SCRIPT_DIR}/backup-alert.sh" warn "$1" >&2 || true
}

# 自动备份目录名：<14位时间>、<14位时间>-daily、-pre-deploy-<14位>、-pre-restore-<14位>
AUTO_NAME_RE='^[0-9]{14}(-daily|-pre-deploy-[0-9]{14}|-pre-restore-[0-9]{14})?$'

# 按保留策略清理；任何单个目录删除失败都只告警，不让 set -e 中断整个脚本。
# 参数：要跳过的目录（本次正在写的 DEST，可为空）
prune_backups() {
  local skip="${1:-}" now cutoff name dir complete=() incomplete=() removed=0 failed=0
  [[ -d "${BACKUP_ROOT}" ]] || return 0
  now="$(date +%s)"
  cutoff=$(( now - RETENTION_DAYS * 86400 ))
  # 名字自带时间戳，按名字排序即按时间排序；不依赖 mtime（压缩、chown 都会改 mtime）
  while IFS= read -r name; do
    [[ "${name}" =~ ${AUTO_NAME_RE} ]] || continue
    dir="${BACKUP_ROOT}/${name}"
    [[ -d "${dir}" && "${dir}" != "${skip}" ]] || continue
    if [[ -f "${dir}/manifest.txt" ]]; then complete+=("${name}"); else incomplete+=("${name}"); fi
  done < <(ls -1 "${BACKUP_ROOT}" 2>/dev/null | sort)

  # 残缺备份（没有 manifest）：超过 1 小时就是失败的半成品，直接清理
  for name in "${incomplete[@]+"${incomplete[@]}"}"; do
    if (( $(backup_epoch "${name}") < now - 3600 )); then
      if rm -rf -- "${BACKUP_ROOT:?}/${name}" 2>/dev/null; then removed=$((removed + 1)); log "清理残缺备份 ${name}"
      else failed=$((failed + 1)); UNDELETABLE+=("${name}"); warn "无法删除残缺备份 ${name}（属主或权限不对，请用 root 处理）"; fi
    fi
  done

  # 完整备份：最旧的先删，但必须超过保留天数，且删完至少还剩 KEEP_MIN 份
  [[ "${RETENTION_DAYS}" -gt 0 ]] || { log "保留天数为 0，不清理完整备份"; return 0; }
  local left=${#complete[@]}
  for name in "${complete[@]+"${complete[@]}"}"; do
    (( left > KEEP_MIN )) || break
    (( $(backup_epoch "${name}") < cutoff )) || break
    if rm -rf -- "${BACKUP_ROOT:?}/${name}" 2>/dev/null; then
      removed=$((removed + 1)); left=$((left - 1))
    else
      failed=$((failed + 1)); UNDELETABLE+=("${name}"); warn "无法删除过期备份 ${name}（属主或权限不对，请用 root 处理）"
    fi
  done
  log "清理完成：删除 ${removed} 个，跳过 ${failed} 个，保留完整自动备份 ${left} 份（≥${KEEP_MIN}，${RETENTION_DAYS} 天）"
}

# 目录名前 14 位时间戳 → epoch（按服务器本地时区）
backup_epoch() {
  local ts="${1:0:14}"
  date -d "${ts:0:4}-${ts:4:2}-${ts:6:2} ${ts:8:2}:${ts:10:2}:${ts:12:2}" +%s 2>/dev/null || echo 0
}

free_bytes() { df -PB1 "${BACKUP_ROOT}" | awk 'NR==2 {print $4}'; }

mkdir -p "${BACKUP_ROOT}"
report_undeletable() {
  (( ${#UNDELETABLE[@]} > 0 )) || return 0
  local names
  names="$(printf '%s\n' "${UNDELETABLE[@]}" | sort -u)"
  alert_warn "以下 $(echo "${names}" | wc -l | tr -d ' ') 个过期备份删不掉（属主或权限不对），请 root 登录后手动删除：
$(echo "${names}" | sed "s|^|  ${BACKUP_ROOT}/|")"
}

prune_backups ""
if [[ "${PRUNE_ONLY}" == "1" ]]; then
  report_undeletable
  log "仅清理模式，结束（剩余 $(( $(free_bytes) / 1024 / 1024 / 1024 )) GB）"
  exit 0
fi

# 数据库路径：env 文件 NANOWORK_DB 优先，否则默认
db_from_env=""
if [[ -r "${ENV_FILE}" ]]; then
  db_from_env="$( { grep -E '^[[:space:]]*NANOWORK_DB=' "${ENV_FILE}" || true; } | tail -n1 | cut -d= -f2- | tr -d '\r' | sed -E "s/^[[:space:]]*[\"']?//; s/[\"']?[[:space:]]*$//")"
fi
DB_PATH="${NANOWORK_DB:-${db_from_env:-${DATA_DIR}/nanowork-industry.db}}"
[[ -f "${DB_PATH}" ]] || die "数据库不存在：${DB_PATH}"

# --- 写入前估算空间：数据库 + uploads（图片视频基本不可再压缩，按原大小估）+ 余量 ---
need_bytes="$(stat -c %s "${DB_PATH}" 2>/dev/null || echo 0)"
if [[ "${WITH_UPLOADS}" == "1" && -d "${DATA_DIR}/uploads" ]]; then
  uploads_bytes="$( { du -sb "${DATA_DIR}/uploads" 2>/dev/null || true; } | cut -f1)"
  [[ "${uploads_bytes}" =~ ^[0-9]+$ ]] || uploads_bytes=0
  need_bytes=$(( need_bytes + uploads_bytes ))
fi
reserve_bytes=$(( MIN_FREE_GB * 1024 * 1024 * 1024 ))
avail_bytes="$(free_bytes)"
gb() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1024 / 1024 / 1024 }'; }
if (( avail_bytes < need_bytes + reserve_bytes )); then
  die "磁盘空间不足：剩余 $(gb "${avail_bytes}") GB，本次备份约需 $(gb "${need_bytes}") GB，另需保留 ${MIN_FREE_GB} GB 给在线服务。已放弃本次备份，请清理 ${BACKUP_ROOT} 或扩容"
fi
log "空间检查通过：剩余 $(gb "${avail_bytes}") GB，本次约需 $(gb "${need_bytes}") GB"

TS="$(date +%Y%m%d%H%M%S)"
DEST="${BACKUP_ROOT}/${TS}${LABEL:+-${LABEL}}"
# 任何一步失败（含磁盘写满、tar 出错）都删掉半成品，避免残缺目录继续占空间
BACKUP_DONE=0
cleanup_partial() { if [[ "${BACKUP_DONE}" != "1" && -n "${DEST:-}" && -d "${DEST}" ]]; then rm -rf -- "${DEST}"; echo "[backup][fail] 备份未完成，已删除半成品 ${DEST}" >&2; fi; }
trap cleanup_partial EXIT
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
[[ "${integrity}" == "ok" ]] || die "快照 integrity_check=${integrity}，已删除本次备份"
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

BACKUP_DONE=1

# --- 保留策略（备份成功后再清一次，把刚过期的那份也清掉）---
prune_backups ""
report_undeletable

log "完成：${DEST}（磁盘剩余 $(gb "$(free_bytes)") GB）"
if [[ "${PRINT_PATH}" == "1" ]]; then
  echo "${DEST}"
fi

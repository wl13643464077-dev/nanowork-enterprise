#!/usr/bin/env bash
# 纳米Work行业版 · 发布脚本（releases/<ts> + current 符号链接；幂等、可重复执行）
#
# 用法（root / sudo）：
#   deploy.sh --source <git-url|/path/to/tarball.tar.gz|/path/to/checkout> [--ref <branch|tag|commit>]
#             [--dist /path/to/web-dist.tar.gz] [--skip-web-build] [--no-restart] [--keep 5]
#   deploy.sh --help
#
# 步骤：
#   1. 前置检查（root、node、systemd、/etc/nanowork/server.env、nanowork 用户）
#   2. 准备 release 目录 /opt/nanowork/releases/<ts>，从 git / tarball / 目录拉取代码（排除 node_modules、server/data、.env、desktop）
#   3. server/data -> /var/lib/nanowork/data 符号链接（代码写死 server/data/uploads，见 server/src/app.js）
#   4. npm ci --omit=dev（server，以 nanowork 用户执行）
#   5. 前端：--dist 解包 / 源码自带 dist / 服务器上 npm ci && npm run build（--skip-web-build 跳过）
#   6. 发布前备份（backup.sh pre-deploy-<ts>）
#   7. 迁移：scripts/migrate.mjs status && up（数据库尚不存在时跳过，由首次启动 initSchema 建库）
#   8. 启动前自检：scripts/preflight-production.mjs（以 nanowork 用户、使用 /etc/nanowork/server.env）
#   9. 切换 current 符号链接（原子），记录 PREVIOUS_RELEASE / BACKUP_REF 供 rollback.sh 使用
#  10. systemctl daemon-reload / enable / restart，等待 /api/health 200
#  11. 用 platform_super 登录一次取令牌，打印 /api/sys/runtime-readiness 就绪矩阵摘要（不打印密码）
#  12. 清理旧 release（默认保留 5 个）
#
# 失败时不会切换 current；若在第 10 步失败会提示 rollback.sh。
set -euo pipefail

APP_USER="${APP_USER:-nanowork}"
APP_ROOT="${APP_ROOT:-/opt/nanowork}"
DATA_DIR="${DATA_DIR:-/var/lib/nanowork/data}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/nanowork}"
CACHE_ROOT="${CACHE_ROOT:-/var/cache/nanowork}"
ENV_FILE="${ENV_FILE:-/etc/nanowork/server.env}"
SERVICE="${SERVICE:-nanowork}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3107/api/health}"
API_BASE="${API_BASE:-http://127.0.0.1:3107}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"

SOURCE=""
REF=""
DIST_TARBALL=""
SKIP_WEB_BUILD=0
NO_RESTART=0
KEEP=5

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[0;32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '    \033[0;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --dist) DIST_TARBALL="${2:-}"; shift 2 ;;
    --skip-web-build) SKIP_WEB_BUILD=1; shift ;;
    --no-restart) NO_RESTART=1; shift ;;
    --keep) KEEP="${2:-5}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
done

[[ -n "${SOURCE}" ]] || die "必须指定 --source <git-url|tarball|目录>"
[[ "$(id -u)" == "0" ]] || die "请用 root 或 sudo 运行"
[[ "${KEEP}" =~ ^[0-9]+$ ]] || die "--keep 需要非负整数"

# ---------------------------------------------------------------------------
# 1. 前置检查
# ---------------------------------------------------------------------------
log "1/12 前置检查"
command -v node >/dev/null || die "未安装 node，请先运行 install-ubuntu.sh"
command -v npm >/dev/null || die "未安装 npm"
command -v systemctl >/dev/null || die "缺少 systemctl"
command -v curl >/dev/null || die "缺少 curl"
id -u "${APP_USER}" >/dev/null 2>&1 || die "系统用户 ${APP_USER} 不存在，请先运行 install-ubuntu.sh"
[[ -f "${ENV_FILE}" ]] || die "缺少 ${ENV_FILE}（从 ops/deploy/server.env.production.example 复制并填写）"
[[ -d "${DATA_DIR}" ]] || die "缺少数据目录 ${DATA_DIR}，请先运行 install-ubuntu.sh"
node -e 'const [maj, min] = process.versions.node.split(".").map(Number); process.exit(maj > 22 || (maj === 22 && min >= 12) ? 0 : 1)' \
  || die "node $(node -v) 过低，需要 ≥ 22.12"
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
ok "node $(node -v)、npm $(npm -v)、env 文件与数据目录就绪"

# 读取 env 文件中的非敏感键（只取需要的几项，不 source 整个文件，避免把密钥暴露到子进程环境）
env_value() {
  local key="$1"
  local line
  line="$(grep -E "^[[:space:]]*${key}=" "${ENV_FILE}" | tail -n1 || true)"
  [[ -n "${line}" ]] || { echo ""; return; }
  local raw="${line#*=}"
  raw="${raw%%$'\r'}"
  raw="$(printf '%s' "${raw}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  if [[ "${raw}" =~ ^\"(.*)\"$ ]] || [[ "${raw}" =~ ^\'(.*)\'$ ]]; then raw="${BASH_REMATCH[1]}"; fi
  printf '%s' "${raw}"
}
NANOWORK_DB_PATH="$(env_value NANOWORK_DB)"
[[ -n "${NANOWORK_DB_PATH}" ]] || NANOWORK_DB_PATH="${DATA_DIR}/nanowork-industry.db"
MIGRATE_SNAPSHOT_DIR_VALUE="$(env_value MIGRATE_SNAPSHOT_DIR)"
[[ -n "${MIGRATE_SNAPSHOT_DIR_VALUE}" ]] || MIGRATE_SNAPSHOT_DIR_VALUE="${BACKUP_ROOT}/migrate"
SUPER_USERNAME="$(env_value PLATFORM_SUPER_USERNAME)"
[[ -n "${SUPER_USERNAME}" ]] || SUPER_USERNAME="super"

# ---------------------------------------------------------------------------
# 2. 准备 release 目录并拉取代码
# ---------------------------------------------------------------------------
TS="$(date +%Y%m%d%H%M%S)"
RELEASES="${APP_ROOT}/releases"
RELEASE_DIR="${RELEASES}/${TS}"
CURRENT_LINK="${APP_ROOT}/current"
install -d -m 0755 -o "${APP_USER}" -g "${APP_USER}" "${APP_ROOT}" "${RELEASES}"
install -d -m 0700 -o "${APP_USER}" -g "${APP_USER}" "${CACHE_ROOT}" "${CACHE_ROOT}/npm"

log "2/12 拉取代码到 ${RELEASE_DIR}"
mkdir -p "${RELEASE_DIR}"
cleanup_on_error() {
  local code=$?
  [[ ${code} -ne 0 ]] || return 0
  local current_now
  current_now="$(readlink -f "${CURRENT_LINK}" 2>/dev/null || true)"
  if [[ "${current_now}" != "${RELEASE_DIR}" ]]; then
    warn "部署失败（exit ${code}），保留 ${RELEASE_DIR} 供排查；current 未切换，线上仍是旧版本"
  else
    warn "部署失败（exit ${code}），current 已指向 ${RELEASE_DIR}；如服务异常请执行 rollback.sh"
  fi
}
trap cleanup_on_error EXIT

# 以 / 开头的模式只匹配仓库根下的同名目录（docs/artifacts 等文档目录不受影响）
RSYNC_EXCLUDES=(--exclude node_modules --exclude '/server/data' --exclude '/server/.env' --exclude '.env' \
  --exclude '/desktop' --exclude '.git' --exclude '/backups' --exclude '/artifacts' --exclude '/provision-output' \
  --exclude '/web/node_modules' --exclude '/desktop/release')

if [[ -d "${SOURCE}" ]]; then
  ok "来源：本地目录 ${SOURCE}"
  rsync -a "${RSYNC_EXCLUDES[@]}" "${SOURCE%/}/" "${RELEASE_DIR}/"
elif [[ -f "${SOURCE}" ]]; then
  ok "来源：tarball ${SOURCE}"
  tmp_extract="$(mktemp -d)"
  tar -xzf "${SOURCE}" -C "${tmp_extract}"
  # tarball 可能带一层顶级目录（git archive --prefix），自动识别
  top_entries=("${tmp_extract}"/*)
  if [[ ${#top_entries[@]} -eq 1 && -d "${top_entries[0]}" && -f "${top_entries[0]}/package.json" ]]; then
    src_root="${top_entries[0]}"
  else
    src_root="${tmp_extract}"
  fi
  rsync -a "${RSYNC_EXCLUDES[@]}" "${src_root}/" "${RELEASE_DIR}/"
  rm -rf "${tmp_extract}"
else
  ok "来源：git ${SOURCE}${REF:+ @ ${REF}}"
  command -v git >/dev/null || die "缺少 git"
  git clone --quiet --depth 1 ${REF:+--branch "${REF}"} "${SOURCE}" "${RELEASE_DIR}.git-tmp"
  rsync -a "${RSYNC_EXCLUDES[@]}" "${RELEASE_DIR}.git-tmp/" "${RELEASE_DIR}/"
  git -C "${RELEASE_DIR}.git-tmp" rev-parse HEAD > "${RELEASE_DIR}/GIT_COMMIT" 2>/dev/null || true
  rm -rf "${RELEASE_DIR}.git-tmp"
fi
[[ -f "${RELEASE_DIR}/server/package.json" ]] || die "来源中缺少 server/package.json，不是纳米Work仓库"
[[ -f "${RELEASE_DIR}/scripts/preflight-production.mjs" ]] || die "来源中缺少 scripts/preflight-production.mjs（分支过旧）"
rm -f "${RELEASE_DIR}/server/.env"
chown -R "${APP_USER}:${APP_USER}" "${RELEASE_DIR}"
ok "代码就位"

# ---------------------------------------------------------------------------
# 3. server/data -> /var/lib/nanowork/data
# ---------------------------------------------------------------------------
log "3/12 链接运行数据目录"
if [[ -L "${RELEASE_DIR}/server/data" ]]; then
  rm -f "${RELEASE_DIR}/server/data"
elif [[ -d "${RELEASE_DIR}/server/data" ]]; then
  if [[ -n "$(ls -A "${RELEASE_DIR}/server/data")" ]]; then
    die "${RELEASE_DIR}/server/data 非空（来源里带了数据文件），拒绝覆盖；请清理来源后重试"
  fi
  rmdir "${RELEASE_DIR}/server/data"
fi
ln -s "${DATA_DIR}" "${RELEASE_DIR}/server/data"
chown -h "${APP_USER}:${APP_USER}" "${RELEASE_DIR}/server/data"
chown "${APP_USER}:${APP_USER}" "${DATA_DIR}"
chmod 0700 "${DATA_DIR}"
install -d -m 0700 -o "${APP_USER}" -g "${APP_USER}" "${DATA_DIR}/uploads" "${MIGRATE_SNAPSHOT_DIR_VALUE}"
ok "server/data -> ${DATA_DIR}（0700）"

run_as_app() {
  # 以 nanowork 身份执行，npm 缓存落到 /var/cache/nanowork/npm；不把 env 文件里的密钥带入 npm 子进程
  sudo -u "${APP_USER}" -H env -i \
    HOME="${DATA_DIR%/data}" PATH="${PATH}" \
    npm_config_cache="${CACHE_ROOT}/npm" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
    NODE_OPTIONS="${NODE_OPTIONS:-}" TZ=Asia/Shanghai \
    "$@"
}

# ---------------------------------------------------------------------------
# 4. server 依赖
# ---------------------------------------------------------------------------
log "4/12 安装 server 依赖（npm ci --omit=dev）"
if [[ -f "${RELEASE_DIR}/server/package-lock.json" ]]; then
  run_as_app "${NPM_BIN}" ci --omit=dev --prefix "${RELEASE_DIR}/server"
else
  warn "server 缺少 package-lock.json，退回 npm install --omit=dev"
  run_as_app "${NPM_BIN}" install --omit=dev --prefix "${RELEASE_DIR}/server"
fi
ok "server/node_modules 就绪"

# ---------------------------------------------------------------------------
# 5. 前端产物
# ---------------------------------------------------------------------------
log "5/12 前端产物"
WEB_DIR="${RELEASE_DIR}/web"
if [[ -n "${DIST_TARBALL}" ]]; then
  [[ -f "${DIST_TARBALL}" ]] || die "--dist 指定的文件不存在：${DIST_TARBALL}"
  rm -rf "${WEB_DIR}/dist"
  mkdir -p "${WEB_DIR}/dist"
  tar -xzf "${DIST_TARBALL}" -C "${WEB_DIR}/dist"
  # 允许 tar 内带 dist/ 一层
  if [[ ! -f "${WEB_DIR}/dist/index.html" && -f "${WEB_DIR}/dist/dist/index.html" ]]; then
    mv "${WEB_DIR}/dist/dist"/* "${WEB_DIR}/dist/" && rmdir "${WEB_DIR}/dist/dist"
  fi
  [[ -f "${WEB_DIR}/dist/index.html" ]] || die "--dist 包内找不到 index.html"
  chown -R "${APP_USER}:${APP_USER}" "${WEB_DIR}/dist"
  ok "已使用预构建产物 ${DIST_TARBALL}"
elif [[ -f "${WEB_DIR}/dist/index.html" ]]; then
  ok "来源自带 web/dist，直接使用"
elif [[ "${SKIP_WEB_BUILD}" == "1" ]]; then
  warn "--skip-web-build 且无 dist：本次只发布 API，浏览器访问根路径会 404"
else
  [[ -f "${WEB_DIR}/package.json" ]] || die "缺少 web/package.json"
  mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  if [[ "${mem_kb}" -gt 0 && "${mem_kb}" -lt 3500000 ]]; then
    warn "内存 $((mem_kb / 1024)) MB 偏小，前端构建可能 OOM；建议本机构建后用 --dist 上传"
  fi
  echo "    在服务器上构建前端（Vite ~3900 模块，2 vCPU 约 2~5 分钟）..."
  NODE_OPTIONS="--max-old-space-size=3072" run_as_app "${NPM_BIN}" ci --prefix "${WEB_DIR}"
  NODE_OPTIONS="--max-old-space-size=3072" run_as_app "${NPM_BIN}" run build --prefix "${WEB_DIR}"
  [[ -f "${WEB_DIR}/dist/index.html" ]] || die "前端构建未产出 dist/index.html"
  rm -rf "${WEB_DIR}/node_modules"
  ok "前端构建完成（已删除 web/node_modules 释放空间）"
fi

# ---------------------------------------------------------------------------
# 6. 发布前备份
# ---------------------------------------------------------------------------
log "6/12 发布前备份"
BACKUP_REF=""
if [[ -f "${NANOWORK_DB_PATH}" ]]; then
  if [[ -x "${SCRIPT_DIR}/backup.sh" || -f "${SCRIPT_DIR}/backup.sh" ]]; then
    BACKUP_REF="$(ENV_FILE="${ENV_FILE}" BACKUP_ROOT="${BACKUP_ROOT}" DATA_DIR="${DATA_DIR}" bash "${SCRIPT_DIR}/backup.sh" "pre-deploy-${TS}" --print-path)"
    ok "备份：${BACKUP_REF}"
  else
    warn "找不到 backup.sh，跳过发布前备份（不建议）"
  fi
else
  ok "数据库尚不存在（首次部署），无需备份"
fi

# ---------------------------------------------------------------------------
# 7. 迁移
# ---------------------------------------------------------------------------
log "7/12 数据库迁移"
if [[ -f "${NANOWORK_DB_PATH}" ]]; then
  if [[ -d "${RELEASE_DIR}/scripts/migrations" ]]; then
    run_as_app env NANOWORK_DB="${NANOWORK_DB_PATH}" MIGRATE_SNAPSHOT_DIR="${MIGRATE_SNAPSHOT_DIR_VALUE}" \
      "${NODE_BIN}" "${RELEASE_DIR}/scripts/migrate.mjs" status
    run_as_app env NANOWORK_DB="${NANOWORK_DB_PATH}" MIGRATE_SNAPSHOT_DIR="${MIGRATE_SNAPSHOT_DIR_VALUE}" \
      "${NODE_BIN}" "${RELEASE_DIR}/scripts/migrate.mjs" up
    ok "版本化迁移完成（initSchema/migrateV2 的内建迁移会在服务启动时自动执行）"
  else
    ok "无 scripts/migrations 目录；内建迁移在服务启动时执行"
  fi
else
  ok "首次部署：跳过 migrate.mjs，由服务首次启动 initSchema 建库"
fi

# ---------------------------------------------------------------------------
# 8. 启动前自检（以运行用户身份、用真实 env 文件）
# ---------------------------------------------------------------------------
log "8/12 启动前自检 preflight-production.mjs"
if ! sudo -u "${APP_USER}" -H env -i PATH="${PATH}" HOME="${DATA_DIR%/data}" TZ=Asia/Shanghai NODE_ENV=production \
  "${NODE_BIN}" "${RELEASE_DIR}/scripts/preflight-production.mjs" --env-file "${ENV_FILE}"; then
  die "自检存在 FAIL 项，未切换版本。修复 ${ENV_FILE} 或系统依赖后重试"
fi
ok "自检通过"

# ---------------------------------------------------------------------------
# 9. 切换 current
# ---------------------------------------------------------------------------
log "9/12 切换 current -> releases/${TS}"
PREVIOUS_RELEASE=""
if [[ -L "${CURRENT_LINK}" ]]; then
  PREVIOUS_RELEASE="$(readlink -f "${CURRENT_LINK}")"
fi
printf '%s\n' "${PREVIOUS_RELEASE}" > "${RELEASE_DIR}/PREVIOUS_RELEASE"
printf '%s\n' "${BACKUP_REF}" > "${RELEASE_DIR}/BACKUP_REF"
printf '%s\n' "${TS}" > "${RELEASE_DIR}/RELEASE_TS"
chown "${APP_USER}:${APP_USER}" "${RELEASE_DIR}/PREVIOUS_RELEASE" "${RELEASE_DIR}/BACKUP_REF" "${RELEASE_DIR}/RELEASE_TS"
ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}.tmp"
mv -Tf "${CURRENT_LINK}.tmp" "${CURRENT_LINK}"
chown -h "${APP_USER}:${APP_USER}" "${CURRENT_LINK}"
ok "current -> ${RELEASE_DIR}${PREVIOUS_RELEASE:+（上一版：${PREVIOUS_RELEASE}）}"

# ---------------------------------------------------------------------------
# 10. systemd
# ---------------------------------------------------------------------------
log "10/12 重启服务 ${SERVICE}"
if [[ -f "${RELEASE_DIR}/ops/deploy/nanowork.service" ]] && ! cmp -s "${RELEASE_DIR}/ops/deploy/nanowork.service" "/etc/systemd/system/${SERVICE}.service" 2>/dev/null; then
  install -m 0644 "${RELEASE_DIR}/ops/deploy/nanowork.service" "/etc/systemd/system/${SERVICE}.service"
  ok "systemd 单元已更新"
fi
systemctl daemon-reload
if [[ "${NO_RESTART}" == "1" ]]; then
  warn "--no-restart：未重启服务，新版本将在下次重启生效"
else
  systemctl enable "${SERVICE}" >/dev/null 2>&1 || true
  systemctl restart "${SERVICE}"
  echo "    等待 ${HEALTH_URL} 返回 200（最多 ${HEALTH_TIMEOUT}s）..."
  deadline=$((SECONDS + HEALTH_TIMEOUT))
  healthy=0
  while [[ ${SECONDS} -lt ${deadline} ]]; do
    if body="$(curl -fsS --max-time 3 "${HEALTH_URL}" 2>/dev/null)" && [[ "${body}" == *'"ok":true'* ]]; then
      healthy=1
      break
    fi
    if ! systemctl is-active --quiet "${SERVICE}"; then
      break
    fi
    sleep 2
  done
  if [[ "${healthy}" != "1" ]]; then
    echo
    journalctl -u "${SERVICE}" -n 60 --no-pager || true
    die "服务未在 ${HEALTH_TIMEOUT}s 内就绪。回滚：bash ${SCRIPT_DIR}/rollback.sh${PREVIOUS_RELEASE:+ $(basename "${PREVIOUS_RELEASE}")}"
  fi
  ok "/api/health → ${body}"
fi

# ---------------------------------------------------------------------------
# 11. 就绪矩阵摘要（platform_super 登录一次；密码只通过子进程环境变量传给 node，不进日志/argv/stdout）
# ---------------------------------------------------------------------------
log "11/12 就绪矩阵摘要（/api/sys/runtime-readiness）"
if [[ "${NO_RESTART}" == "1" ]]; then
  warn "--no-restart：跳过"
else
  SUPER_PASSWORD_VALUE="$(env_value PLATFORM_SUPER_PASSWORD)"
  if [[ -z "${SUPER_PASSWORD_VALUE}" ]]; then
    warn "env 文件中无 PLATFORM_SUPER_PASSWORD，跳过登录；可手工在管理后台查看"
  else
    set +e
    API_BASE="${API_BASE}" SUPER_USERNAME="${SUPER_USERNAME}" SUPER_PASSWORD="${SUPER_PASSWORD_VALUE}" \
      "${NODE_BIN}" --input-type=module - <<'NODE'
const base = process.env.API_BASE.replace(/\/+$/, "");
const username = process.env.SUPER_USERNAME;
const password = process.env.SUPER_PASSWORD || "";
delete process.env.SUPER_PASSWORD;
const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ username, password }),
});
const loginBody = await login.json().catch(() => ({}));
if (!login.ok) {
  console.error(`    [warn] 超管登录失败 HTTP ${login.status}：${loginBody?.error || "未知错误"}（不影响部署结果）`);
  process.exit(0);
}
const token = loginBody.token;
const res = await fetch(`${base}/api/sys/runtime-readiness`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
const data = await res.json().catch(() => ({}));
await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
if (!res.ok) {
  console.error(`    [warn] 读取就绪矩阵失败 HTTP ${res.status}：${data?.error || ""}`);
  process.exit(0);
}
const s = data.summary || {};
console.log(`    通道 ${s.total ?? "?"}：connected ${s.connected ?? 0} · configured_unverified ${s.configuredUnverified ?? 0} · local_ready ${s.localReady ?? 0} · blocked ${s.blocked ?? 0} · degraded ${s.degraded ?? 0} · manual_only ${s.manualOnly ?? 0} · disabled ${s.disabled ?? 0}`);
for (const ch of data.channels || []) {
  const flag = ch.effective === "connected" ? "●" : ch.effective === "configured_unverified" || ch.effective === "local_ready" ? "◐" : "○";
  console.log(`    ${flag} ${String(ch.label).padEnd(10, "　")} ${String(ch.effective).padEnd(22)} ${ch.nextAction || ""}`);
}
NODE
    set -e
  fi
fi

# ---------------------------------------------------------------------------
# 12. 清理旧 release
# ---------------------------------------------------------------------------
log "12/12 清理旧 release（保留最近 ${KEEP} 个）"
mapfile -t all_releases < <(ls -1d "${RELEASES}"/[0-9]* 2>/dev/null | sort)
current_target="$(readlink -f "${CURRENT_LINK}")"
removable=$(( ${#all_releases[@]} - KEEP ))
removed=0
for rel in "${all_releases[@]}"; do
  [[ ${removable} -gt 0 ]] || break
  if [[ "${rel}" == "${current_target}" || "${rel}" == "${PREVIOUS_RELEASE}" ]]; then
    continue
  fi
  rm -rf "${rel}"
  removed=$((removed + 1))
  removable=$((removable - 1))
done
ok "已清理 ${removed} 个旧版本"

trap - EXIT
cat <<EOF

部署完成：${RELEASE_DIR}
  健康检查：curl -s ${HEALTH_URL}
  日志：    journalctl -u ${SERVICE} -f
  回滚：    sudo bash ${CURRENT_LINK}/ops/deploy/rollback.sh${PREVIOUS_RELEASE:+ $(basename "${PREVIOUS_RELEASE}")}
  备份：    ${BACKUP_REF:-（首次部署无）}
EOF

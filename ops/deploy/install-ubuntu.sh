#!/usr/bin/env bash
# 纳米Work行业版 · Ubuntu 22.04 / 24.04 单机安装脚本（幂等，可重复执行）
#
# 用法（以 root 或 sudo 执行）：
#   sudo bash ops/deploy/install-ubuntu.sh
#   sudo NODE_MAJOR=24 bash ops/deploy/install-ubuntu.sh   # 默认即 24
#
# 做什么：
#   1. 安装 Node ${NODE_MAJOR} LTS（NodeSource）、ffmpeg、poppler-utils、fonts-noto-cjk、sqlite3、Caddy
#   2. 安装可被 PDF/DOCX 渲染器嵌入的单文件 OTF 中文字体
#      （Ubuntu 的 fonts-noto-cjk 只提供 .ttc，server/src/engines/skillrun.js 与
#        docx-report-renderer.js 明确不支持 TTC，所以要额外下一份 OTF，来源与 .github/workflows/verify.yml 一致）
#   3. 创建系统用户 nanowork 与目录：
#        /opt/nanowork            代码（releases/<ts> + current 符号链接）
#        /var/lib/nanowork/data   运行数据：SQLite、uploads（0700）
#        /var/backups/nanowork    备份（0700）
#        /var/cache/nanowork      npm 缓存
#        /etc/nanowork            server.env（0750，root:nanowork）
#   4. 安装 systemd 单元与 Caddyfile 骨架（不覆盖已存在的配置）
#
# 不做什么：不生成任何密钥、不写域名、不启动业务服务。后续步骤见 docs/演示环境上线清单-2026-09.md。
set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-24}"
APP_USER="${APP_USER:-nanowork}"
APP_ROOT="${APP_ROOT:-/opt/nanowork}"
DATA_ROOT="${DATA_ROOT:-/var/lib/nanowork}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/nanowork}"
CACHE_ROOT="${CACHE_ROOT:-/var/cache/nanowork}"
ETC_ROOT="${ETC_ROOT:-/etc/nanowork}"
FONT_TARGET="${FONT_TARGET:-/usr/local/share/fonts/NotoSansCJK-Regular.otf}"
# 与 .github/workflows/verify.yml 完全一致的固定版本与哈希；换字体版本时两处一起改。
FONT_URL="https://raw.githubusercontent.com/notofonts/noto-cjk/165c01b46ea533872e002e0785ff17e44f6d97d8/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf"
FONT_SHA256="2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[0;32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '    \033[0;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "请用 root 或 sudo 运行"
[[ -r /etc/os-release ]] || die "无法读取 /etc/os-release"
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || warn "本脚本只在 Ubuntu 22.04/24.04 验证过，当前系统：${PRETTY_NAME:-unknown}"
case "${VERSION_ID:-}" in
  22.04|24.04) ok "Ubuntu ${VERSION_ID}" ;;
  *) warn "未验证的 Ubuntu 版本：${VERSION_ID:-unknown}，继续执行但请自行确认" ;;
esac

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# 1. 系统软件包（apt 阶段使用常规 umask 022，避免把 /usr 下的文件建成 0600）
# ---------------------------------------------------------------------------
log "1/6 安装基础工具"
(
  umask 022
  apt-get update -y
  apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https \
    tar gzip rsync git jq
)
ok "基础工具就绪"

log "2/6 安装 Node ${NODE_MAJOR}（NodeSource）"
need_node=1
if command -v node >/dev/null 2>&1; then
  current_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "${current_major}" == "${NODE_MAJOR}" ]]; then
    need_node=0
    ok "已安装 node $(node -v)，跳过"
  else
    warn "当前 node $(node -v) 与目标 ${NODE_MAJOR}.x 不一致，将切换 NodeSource 源"
  fi
fi
if [[ "${need_node}" == "1" ]]; then
  (
    umask 022
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list
    apt-get update -y
    apt-get install -y nodejs
  )
  ok "已安装 node $(node -v) / npm $(npm -v)"
fi
node -e 'const [maj, min] = process.versions.node.split(".").map(Number); if (maj < 22 || (maj === 22 && min < 12)) { console.error("需要 Node >= 22.12（node:sqlite）"); process.exit(1); }'

log "3/6 安装媒体、文档与数据库工具（ffmpeg / poppler / 中文字体 / sqlite3）"
(
  umask 022
  apt-get install -y --no-install-recommends ffmpeg poppler-utils fonts-noto-cjk sqlite3 fontconfig
)
ok "ffmpeg $(ffmpeg -version | head -n1 | awk '{print $3}')；ffprobe/pdftoppm/sqlite3 已就绪"

# fonts-noto-cjk 让 ffmpeg drawtext 能通过 fontconfig 找到 "Noto Sans CJK SC"（text-video.js 用到）；
# 单文件 OTF 供 PDF/DOCX 渲染器嵌入（它们拒绝 .ttc）。
if [[ -f "${FONT_TARGET}" ]] && echo "${FONT_SHA256}  ${FONT_TARGET}" | sha256sum -c --quiet - 2>/dev/null; then
  ok "OTF 中文字体已存在且哈希一致：${FONT_TARGET}"
else
  (
    umask 022
    install -d -m 0755 "$(dirname "${FONT_TARGET}")"
    tmp="$(mktemp)"
    trap 'rm -f "${tmp}"' EXIT
    curl -fsSL --retry 3 "${FONT_URL}" -o "${tmp}"
    echo "${FONT_SHA256}  ${tmp}" | sha256sum -c --quiet - || { echo "字体哈希校验失败，拒绝安装" >&2; exit 1; }
    install -m 0644 "${tmp}" "${FONT_TARGET}"
  )
  fc-cache -f >/dev/null 2>&1 || true
  ok "已安装 OTF 中文字体：${FONT_TARGET}"
fi
if fc-list 2>/dev/null | grep -qi "Noto Sans CJK SC"; then
  ok "fontconfig 可见 Noto Sans CJK SC（ffmpeg drawtext 可用）"
else
  warn "fontconfig 未列出 Noto Sans CJK SC，AI 带货视频字幕可能回退到其他字体"
fi

log "4/6 安装 Caddy（自动 HTTPS 反向代理）"
if command -v caddy >/dev/null 2>&1; then
  ok "已安装 $(caddy version | head -n1)"
else
  (
    umask 022
    install -d -m 0755 /etc/apt/keyrings
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor --yes -o /etc/apt/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      | sed 's#signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg#signed-by=/etc/apt/keyrings/caddy-stable-archive-keyring.gpg#g' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y caddy
  )
  ok "已安装 $(caddy version | head -n1)"
fi
systemctl enable caddy >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 5. 用户与目录（运行数据用 umask 077：项目测试要求 data 0700、db 0600）
# ---------------------------------------------------------------------------
log "5/6 创建系统用户与目录"
if id -u "${APP_USER}" >/dev/null 2>&1; then
  ok "用户 ${APP_USER} 已存在"
else
  useradd --system --home-dir "${DATA_ROOT}" --create-home --shell /usr/sbin/nologin "${APP_USER}"
  ok "已创建系统用户 ${APP_USER}（nologin）"
fi

install -d -m 0755 -o "${APP_USER}" -g "${APP_USER}" "${APP_ROOT}" "${APP_ROOT}/releases"
(
  umask 077
  install -d -m 0700 -o "${APP_USER}" -g "${APP_USER}" "${DATA_ROOT}" "${DATA_ROOT}/data" "${DATA_ROOT}/data/uploads"
  install -d -m 0700 -o "${APP_USER}" -g "${APP_USER}" "${BACKUP_ROOT}" "${BACKUP_ROOT}/migrate"
  install -d -m 0700 -o "${APP_USER}" -g "${APP_USER}" "${CACHE_ROOT}" "${CACHE_ROOT}/npm"
)
chmod 0700 "${DATA_ROOT}" "${DATA_ROOT}/data" "${BACKUP_ROOT}"
chown -R "${APP_USER}:${APP_USER}" "${DATA_ROOT}" "${BACKUP_ROOT}" "${CACHE_ROOT}"
install -d -m 0750 -o root -g "${APP_USER}" "${ETC_ROOT}"
ok "目录：${APP_ROOT}（0755）、${DATA_ROOT}/data（0700）、${BACKUP_ROOT}（0700）、${ETC_ROOT}（0750）"

if [[ -f "${ETC_ROOT}/server.env" ]]; then
  chown root:"${APP_USER}" "${ETC_ROOT}/server.env"
  chmod 0640 "${ETC_ROOT}/server.env"
  ok "已存在 ${ETC_ROOT}/server.env（保持不动，已校正权限 0640 root:${APP_USER}）"
else
  if [[ -f "${SCRIPT_DIR}/server.env.production.example" ]]; then
    install -m 0640 -o root -g "${APP_USER}" "${SCRIPT_DIR}/server.env.production.example" "${ETC_ROOT}/server.env"
    warn "已用模板生成 ${ETC_ROOT}/server.env —— 必须手工填写 JWT_SECRET / PLATFORM_SUPER_PASSWORD / CORS_ORIGINS / PUBLIC_BASE_URL 等再部署"
  else
    warn "未找到 server.env.production.example，请手工创建 ${ETC_ROOT}/server.env（0640 root:${APP_USER}）"
  fi
fi

# ---------------------------------------------------------------------------
# 6. systemd 与 Caddyfile 骨架
# ---------------------------------------------------------------------------
log "6/6 安装 systemd 单元与 Caddyfile 骨架"
if [[ -f "${SCRIPT_DIR}/nanowork.service" ]]; then
  if [[ -f /etc/systemd/system/nanowork.service ]] && cmp -s "${SCRIPT_DIR}/nanowork.service" /etc/systemd/system/nanowork.service; then
    ok "systemd 单元无变化"
  else
    install -m 0644 "${SCRIPT_DIR}/nanowork.service" /etc/systemd/system/nanowork.service
    systemctl daemon-reload
    ok "已安装 /etc/systemd/system/nanowork.service（未启动；deploy.sh 会 enable + restart）"
  fi
else
  warn "未找到 ${SCRIPT_DIR}/nanowork.service，跳过"
fi

if [[ -f /etc/caddy/Caddyfile ]] && grep -q "127.0.0.1:3107" /etc/caddy/Caddyfile; then
  ok "/etc/caddy/Caddyfile 已包含 nanowork 反代配置，保持不动"
elif [[ -f "${SCRIPT_DIR}/Caddyfile.example" ]]; then
  if [[ -f /etc/caddy/Caddyfile ]]; then
    cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)"
  fi
  install -m 0644 -o root -g root "${SCRIPT_DIR}/Caddyfile.example" /etc/caddy/Caddyfile
  warn "已写入 /etc/caddy/Caddyfile（示例域名 demo.example.com）—— 请改成真实域名后执行：caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy"
else
  warn "未找到 Caddyfile.example，跳过"
fi

# 时区：应用层由 systemd Environment=TZ=Asia/Shanghai 保证；系统层顺手对齐，便于看日志与 cron。
if [[ "$(timedatectl show -p Timezone --value 2>/dev/null || true)" != "Asia/Shanghai" ]]; then
  timedatectl set-timezone Asia/Shanghai 2>/dev/null && ok "系统时区已设为 Asia/Shanghai" || warn "无法设置系统时区（容器环境可忽略，服务单元已固定 TZ）"
else
  ok "系统时区 Asia/Shanghai"
fi

cat <<EOF

安装完成。下一步：
  1. 编辑 ${ETC_ROOT}/server.env：
       JWT_SECRET=\$(openssl rand -base64 48)
       PLATFORM_SUPER_PASSWORD=<≥12位且含大小写/数字/符号三类>
       CORS_ORIGINS / PUBLIC_BASE_URL / APP_PUBLIC_URL=https://<你的域名>
  2. 编辑 /etc/caddy/Caddyfile 把 demo.example.com 换成真实域名（DNS 已解析到本机公网 IP），
     然后 systemctl reload caddy
  3. 执行部署：sudo bash ${APP_ROOT}/current/ops/deploy/deploy.sh --help
     （首次可直接 sudo bash <代码目录>/ops/deploy/deploy.sh --source <git 地址或 tar 包>）
EOF

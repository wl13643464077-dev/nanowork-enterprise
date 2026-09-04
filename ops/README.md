# 运维目录

纳米Work行业版此前只交付本地可运行的新项目（D-078：公网生产 HOLD）。自 2026-09 起，为成都招商会演示环境提供一套**可执行但仍需负责人逐项确认**的单机部署脚本，位于 `ops/deploy/`。这些脚本不继承来源项目的 Nginx、systemd、备份和发布脚本，全部针对本项目重写。

## 目录

| 文件 | 用途 |
| --- | --- |
| `deploy/install-ubuntu.sh` | Ubuntu 22.04/24.04 幂等安装：Node 24、ffmpeg、poppler-utils、fonts-noto-cjk + 单文件 OTF 中文字体、sqlite3、Caddy；创建 `nanowork` 用户与 `/opt/nanowork`、`/var/lib/nanowork`（0700）、`/var/backups/nanowork`、`/etc/nanowork` |
| `deploy/Caddyfile.example` | 自动 HTTPS 反代 `127.0.0.1:3107`；SSE `flush_interval -1`；上传 64MB；排除 event-stream 压缩 |
| `deploy/nanowork.service` | systemd：`User=nanowork`、`TZ=Asia/Shanghai`、`EnvironmentFile=/etc/nanowork/server.env`、`ProtectSystem=strict`、启动前跑 `preflight-production.mjs` |
| `deploy/server.env.production.example` | 生产 env 模板，每项标注 必填 / 建议 / 可选 / 禁止 |
| `deploy/deploy.sh` | `releases/<ts>` + `current` 符号链接发布；含备份、迁移、自检、健康等待、就绪矩阵摘要 |
| `deploy/backup.sh` / `deploy/restore.sh` | SQLite `.backup` 一致快照 + uploads tar，14 天保留；恢复需输入 `RESTORE` |
| `deploy/rollback.sh` | 切回上一版，可 `--with-backup` 一并恢复 pre-deploy 备份 |
| `deploy/demo-tenants.example.json` | `scripts/provision-demo-tenants.mjs` 的清单示例（6 家演示企业） |

相关脚本：`scripts/preflight-production.mjs`（自检）、`scripts/provision-demo-tenants.mjs`（生产模式建演示租户）、`scripts/migrate.mjs`（版本化迁移）。

完整时间线与检查项见 `docs/演示环境上线清单-2026-09.md`。

## 30 分钟路径（摘要）

```bash
# 1. 系统依赖（root）
bash ops/deploy/install-ubuntu.sh
# 2. 填 /etc/nanowork/server.env（JWT_SECRET、PLATFORM_SUPER_PASSWORD、YUNWU_*、PUBLIC_BASE_URL/CORS_ORIGINS、TRUST_PROXY=1）
# 3. /etc/caddy/Caddyfile 改成真实域名，systemctl reload caddy
# 4. 部署
bash ops/deploy/deploy.sh --source <git 地址> --ref iteration/2026-09-batch-a
# 5. 演示租户
NANOWORK_SUPER_PASSWORD='***' node scripts/provision-demo-tenants.mjs --manifest demo-tenants.json --base-url http://127.0.0.1:3107
```

## 仍然成立的风险提示

- **这是演示环境部署方案，不等于生产放量。** `docs/team/11-release.md` 前置清单中支付沙箱、飞书、外部发布等不可逆链路本轮不验收，相关 env 必须留空、保持 fail-closed。
- 独立服务账号与最小权限目录：脚本按 `nanowork` 用户 + `0700/0600` 落实，但目标机上任何手工 `chmod`/`chown` 都可能破坏 `release-safety`/`commercial-security` 测试所依赖的权限假设。
- HTTPS、反向代理与可信代理范围：`TRUST_PROXY=1` 只对"Caddy 与后端同机"成立；插入 CDN/WAF 后必须重新评估，否则限流与 `Secure` Cookie 判定会失真。
- `NANOWORK_DB` 的备份、校验与恢复：`backup.sh` 做 `integrity_check`，但**恢复演练必须真的做一次**（清单 T-2），未演练的备份不算备份。
- 密钥注入和轮换：密钥只存在 `/etc/nanowork/server.env`（0640 root:nanowork），不进仓库、不进日志、不进聊天工具；已暴露的云雾密钥必须先轮换。`JWT_SECRET` 一旦上线不再变更。
- 健康检查、日志脱敏、告警和回滚：`/api/health` 只证明进程与库可用；9 通道就绪矩阵（含高德 `amap`）才反映外部链路。日志走 journald，Caddy 访问日志默认脱敏 Cookie/Authorization。告警本轮未接入，靠人工巡检。
- 发布前门禁：任何要上演示机的提交仍须通过 `npm run verify`（CI `verify.yml`）。
- uploads 目录代码写死在 `server/data/uploads`，部署依赖 `server/data -> /var/lib/nanowork/data` 符号链接；不要在 release 目录里手工创建真实 `server/data`。

在上述参数经负责人确认前，脚本可以跑，但**不得对外宣称"云端正式上线"**（与 `desktop-clients/10-release.md` 的 HOLD 口径一致）。

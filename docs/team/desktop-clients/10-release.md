# NanoWork Windows / macOS 客户端发布与回滚手册

更新日期：2026-08-23

## 当前发布决定

**未签名内测交付：READY；正式对外发布：HOLD。**

冻结源码已形成 macOS arm64/x64 的 DMG+ZIP 四包，以及 Windows x64 的 NSIS+ZIP。macOS 四包均完成包内真实启动，Windows 包已完成结构、架构与安装器载荷验真。正式发布只剩四类门禁：

1. Apple Developer ID 签名/公证与 Windows Authenticode 签名；
2. Windows x64 原生安装、启动、卸载与快捷方式验收；
3. 真实生产 HTTPS 域名的登录、Cookie、SSE 与下载验收；
4. 签名产物接入生产 HTTPS 更新 feed 后的升级与回滚演练。

本轮普通 CI 明确为 unsigned：最小 `contents: read` 权限、无 signing secret 引用、两平台均设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`，构建使用 `--publish never`。

## 冻结交付目录

只把以下两个目录视为本轮冻结交付：

- `desktop/release/macos/`
- `desktop/release/windows/`

`desktop/release/` 根目录中的早期 arm64 候选为历史内测文件，不属于本轮冻结交付。核验时必须先读取对应目录中的 `BUILD-EVIDENCE.md` 与 `SHA256SUMS-*`。

## 发布物范围

| 平台 | 当前内测交付 | 已验证 | 正式发布仍缺 |
| --- | --- | --- | --- |
| macOS arm64 | DMG + ZIP | 完整性、架构、包内主页面/设置页、不可达服务器、无残留进程 | 签名、公证、生产域名、生产更新 feed |
| macOS x64 | DMG + ZIP | 完整性、纯 x86_64、Rosetta 包内主页面/设置页、不可达服务器、无残留进程 | Intel 真机可补充；正式门禁仍为签名、公证、生产域名与 feed |
| Windows x64 | NSIS `.exe` + ZIP | PE/COFF、ZIP、NSIS `app-64.7z` 载荷、asar/主程序一致性 | Windows 原生安装运行、签名、生产域名与 feed |
| iOS / Android | 不交付 | 不在本轮范围 | 另立项目规划 |

## 冻结输入与通用验证

- NanoWork Desktop：`0.1.0`
- Electron：`43.4.1`
- electron-builder：`26.15.7`
- electron-updater：`6.8.9`
- 桌面回归：35 tests / 35 pass / 0 fail / 0 skipped
- 三平台 `app.asar`：318 entries，SHA-256 `3f622c81a23a4b743c7ef7bedfd0595d21da0f8ae60e152790d10449b26b86a8`
- 包内 `src/**`、`renderer/**`、`assets/icon.png`：12/12 与冻结源码逐字节一致
- 打包内容不含 `server/`、`.env`、SQLite、uploads、密钥或业务数据

Electron 官方 runtime 校验值：

| 平台 | SHA-256 |
| --- | --- |
| darwin arm64 | `fe3cac8cbfd9ba1739fac6c69166cf30848741f93cbe251d800ae6ef7cebb64b` |
| darwin x64 | `4fd0f1826660a94216a0633600a3c3e2cd87ee9e4bc6f0e1edf717ad8e30c10b` |
| win32 x64 | `c2ef9a5f65472c34d14bd3e67b7d14e66b0c01f124aba45263d6a4232160e13a` |

## 构建命令

### 通用校验

```bash
npm --prefix desktop ci
npm --prefix desktop run verify
```

### macOS unsigned 包

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm --prefix desktop run dist:mac
npm --prefix desktop run verify:artifacts:mac
shasum -a 256 desktop/dist/*.dmg desktop/dist/*.zip
```

### Windows 原生 runner unsigned 包

```powershell
npm ci
npm run verify
npm run dist:win
npm run verify:artifacts:win
Get-ChildItem dist -File | Where-Object { $_.Extension -in '.exe', '.zip' } | Get-FileHash -Algorithm SHA256
```

> PowerShell 命令在 `desktop/` 工作目录执行。当前冻结 Windows 包是 macOS arm64 交叉构建产物；上述原生 runner 流程仍须执行，不能用交叉构建验真替代。

## 普通 CI 与未来签名流水线边界

当前 `.github/workflows/desktop-build.yml` 是普通 unsigned 验证流水线：

- `permissions: contents: read`；
- 不引用 `${{ secrets.* }}`；
- macOS 与 Windows job 都显式设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`；
- builder 脚本使用 `--publish never`；
- 仅上传短期 CI artifact，不发布到客户渠道或更新 feed。

正式发布需另建受保护的签名流水线，至少配置：

| 平台 | 受保护配置 | 用途 |
| --- | --- | --- |
| macOS | Developer ID Application 证书及密码 | 应用与安装包签名 |
| macOS | Apple 公证账号、专用密码、Team ID | notarization 与 stapling |
| Windows | Authenticode 代码签名证书及密码 | 安装器与应用签名 |
| 双平台 | 生产 HTTPS 更新 feed 与发布凭据 | 签名 metadata、升级与回滚 |

这些凭据只能由受保护 secret store 在签名 job 中注入，禁止进入仓库、`.env`、日志、缓存或交付包。普通 PR/push CI 不应读取生产签名凭据。

## 服务器和域名接入

默认 origin 为 `http://127.0.0.1:3107`，仅用于本机联调。生产接入必须满足：

1. NanoWork Web 与 API 使用同一有效 HTTPS origin；
2. `/api/health`、登录 Cookie、SSE、SPA fallback 与受保护下载均实测通过；
3. 不允许客户端忽略 TLS 证书错误；
4. 设置页保存生产 origin 后，重启、`activate` 与 second-instance 重连仍生效；
5. macOS 与 Windows 分别走完登录、员工 101、下载和故障恢复路径；
6. 更新 feed 使用独立受控 HTTPS 地址，并以已签名包完成升级和回滚。

服务器或域名尚未就绪时，可以继续使用 unsigned 包和本机 3107 冒烟，但不得宣称“云端正式上线”或“自动更新可用”。

## 最终产物索引

| 平台 | 文件 | 大小 | SHA-256 | 当前验证 | 签名 |
| --- | --- | ---: | --- | --- | --- |
| macOS arm64 DMG | `desktop/release/macos/NanoWork-0.1.0-mac-arm64.dmg` | 120,260,244 bytes | `97d4c0c7178a67118caafa170ea7f9b3d430c48c783c13b78f2a3cae6a939077` | `hdiutil verify`；只读挂载后主页面+设置页 exit 0；负向 exit 1 | 未签名/未公证 |
| macOS arm64 ZIP | `desktop/release/macos/NanoWork-0.1.0-mac-arm64.zip` | 116,367,566 bytes | `f605eadfbe854fee11edf00e318f4338ba6fa96456139cc56a0130c498536ec8` | ZIP 完整性；独立解包后主页面+设置页 exit 0；负向 exit 1 | 未签名/未公证 |
| macOS x64 DMG | `desktop/release/macos/NanoWork-0.1.0-mac-x64.dmg` | 122,254,397 bytes | `e8366fb8e033bd801d242ac301ac9e06995730e8a47d978da3c8671f69ea5221` | `hdiutil verify`；Rosetta 只读挂载后主页面+设置页 exit 0；负向 exit 1 | 未签名/未公证 |
| macOS x64 ZIP | `desktop/release/macos/NanoWork-0.1.0-mac-x64.zip` | 118,373,695 bytes | `cd80781077a495ae19480bdbdb696ee31b407984017707254468440d4e45ecf1` | ZIP 完整性；Rosetta 独立解包后主页面+设置页 exit 0；负向 exit 1 | 未签名/未公证 |
| Windows x64 NSIS | `desktop/release/windows/NanoWork-0.1.0-win-x64.exe` | 112,806,429 bytes | `58eb412c2e416e0c27d3061d08f9b098cfa2cbeb10f7c69fe17963eb256f0345` | PE/NSIS 结构、内嵌 x64 载荷与 ZIP/win-unpacked 一致；未做 Windows 原生运行 | 未签名 |
| Windows x64 ZIP | `desktop/release/windows/NanoWork-0.1.0-win-x64.zip` | 145,685,277 bytes | `cf4c854c831e6169a854957f792966e99095b8fefffedc9818b9f7e631c6d321` | ZIP 完整性、PE32+ x86-64、asar 与冻结源码一致；未做 Windows 原生运行 | 未签名 |

Windows blockmap：`desktop/release/windows/NanoWork-0.1.0-win-x64.exe.blockmap`，119,655 bytes，SHA-256 `fe161908d211666f75f749f21167bf1a19d1f46852533cff2bc98579385ae203`。

权威证据：

- `desktop/release/macos/BUILD-EVIDENCE.md`
- `desktop/release/macos/SHA256SUMS-macos.txt`
- `desktop/release/windows/BUILD-EVIDENCE.md`
- `desktop/release/windows/SHA256SUMS-windows-x64.txt`

## 发布门禁

- [x] 冻结源码桌面验证 35/35，构建配置、Prettier 与差异格式检查通过。
- [x] macOS arm64/x64 四包齐全，哈希、架构、完整性和包内启动通过。
- [x] Windows x64 NSIS/ZIP 齐全，哈希、结构、PE 架构与载荷一致性通过。
- [x] 三平台解包扫描确认无后端、密钥、数据库、uploads 或业务数据，冻结输入 12/12 一致。
- [x] 普通 CI unsigned、最小权限、无 signing secret 引用且不会 publish。
- [ ] Windows x64 原生安装、启动、卸载与快捷方式通过。
- [ ] 真实生产 HTTPS origin 在 macOS/Windows 完成登录、Cookie、员工页、SSE 与下载验收。
- [ ] macOS Developer ID 签名/公证与 Windows Authenticode 签名通过。
- [ ] 签名包接入生产 HTTPS feed，完成升级与回滚演练。
- [ ] 工程、测试、安全和产品完成正式发布签字。

前五项足以支持受控的 unsigned 内测交付；后五项未完成前，正式对外发布必须保持 HOLD。

## 内测安装说明

- macOS：未签名包可能被 Gatekeeper 拦截。只向内部测试者说明限制，不关闭系统全局安全设置，也不提供 TLS 绕过。
- Windows：未签名包可能触发 SmartScreen。测试者必须先核对 SHA-256；正式客户分发前完成 Authenticode。
- 首次启动默认连接本机 3107；若服务不在本机，从“服务器设置”填写管理员提供的 HTTPS origin。
- 客户端不内含本地后端。服务不可达时显示明确故障提示是预期架构，不是离线模式。

## 回滚

### 业务 Web / 服务端回滚

1. 按服务端既有发布机制恢复上一业务版本并保持 origin 不变。
2. Windows/macOS 客户端刷新或重启后加载回滚版本。
3. 重新验证登录、员工页、SSE 与下载；不要通过客户端降级掩盖服务端故障。

### 桌面壳回滚

1. 停止向生产 feed 推送问题版本，保留发布与审计记录。
2. 恢复上一份已签名、已验证的安装包和 metadata；版本号按 updater 规则前进，不用同版本覆盖。
3. 向受影响用户提供上一安全版本或修复版本，并核对 SHA-256 与平台签名。
4. 设置文件只含 schemaVersion/origin；若 schema 变化，必须向后兼容或显式迁移，不直接删除用户配置。
5. 回滚后重跑 `08-qa.md` 的安全、登录/SSE/下载、故障恢复和双平台原生冒烟。

## 发布记录

| 日期 | 版本 | 渠道 | 决定 | 依据 |
| --- | --- | --- | --- | --- |
| 2026-08-23 | 0.1.0 | 受控 unsigned 内测 | READY | Mac 双架构四包包内启动通过；Windows NSIS/ZIP 结构与载荷验真；35/35、12/12、哈希清单齐全 |
| 2026-08-23 | 0.1.0 | 正式对外 | HOLD | 签名/公证、Windows 原生、生产域名业务链路、生产更新 feed 四类门禁未闭环 |

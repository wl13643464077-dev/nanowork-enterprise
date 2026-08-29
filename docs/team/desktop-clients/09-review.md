# NanoWork 桌面客户端评审记录

更新日期：2026-08-23

## 当前评审结论

**状态：冻结源码、macOS arm64/x64 四个交付包、Windows x64 交叉构建产物及其载荷一致性评审已通过；未签名内测交付可用，正式对外发布仍为 HOLD。**

本文件记录桌面壳的工程、安全与交付评审。没有源码定位、验证命令和结果的项目不得标记“已解决”。

## 评审严重级别

- P0：密钥/用户数据进入客户端、远程页面获得任意本机代码执行、可绕过 TLS、安装包破坏用户数据；必须立即阻断。
- P1：鉴权/导航/下载/更新边界错误、应用无法启动或无法恢复、产物不可复现；发布前必须修复。
- P2：体验、诊断或文档缺口，不直接破坏安全与核心使用，但要有明确去向。

## 架构边界评审

| ID | 评审问题 | 预期设计 | 当前状态 | 证据 / 源码定位 |
| --- | --- | --- | --- | --- |
| RV-A01 | 是否内嵌后端或数据库 | Electron 只做薄壳；服务端与 SQLite 不进包 | PASS（源码 + 三平台 asar） | `desktop/electron-builder.yml` allowlist；macOS 双架构与 Windows asar 均为 318 entries，禁止内容命中 0，共同 SHA-256 `3f622c81a23a4b743c7ef7bedfd0595d21da0f8ae60e152790d10449b26b86a8` |
| RV-A02 | 是否保持同源业务契约 | 直接加载单一 NanoWork origin；`/api`、SSE、HttpOnly Cookie 不改 | PASS（设计 + 本机主页面 smoke）；生产链路待验 | macOS 双架构包内员工 101 路径 React `#root` 渲染 exit 0；未改 Web/API 契约；真实生产登录/SSE/下载仍属发布门禁 |
| RV-A03 | 业务更新是否跨端同步 | UI/业务来自服务端；刷新即可看到服务端新版本 | PASS（架构）；生产部署待验 | 薄壳不内嵌业务构建；服务器/域名上线后补跨端版本标记证据 |
| RV-A04 | 本地配置是否最小化 | 只保存 schemaVersion、origin、更新时间 | PASS（源码/单测） | `desktop/src/config.cjs:74`、`:97`；配置单测通过 |
| RV-A05 | 手机端是否越界 | 本轮没有 iOS/Android/PWA 交付 | PASS（范围） | 新增范围仅 `desktop/` 与双平台 workflow |

## 安全评审

| ID | 评审问题 | 阻断条件 | 当前状态 | 证据 / 源码定位 |
| --- | --- | --- | --- | --- |
| RV-S01 | 远程页面隔离 | 任一远程页面可访问 Node、Electron、通用 IPC 或 preload | PASS（源码/单测/packaged settings smoke） | `desktop/src/security.cjs:7`；远程窗口无 preload，设置 preload 仅暴露 4 个字段化动作；通用 IPC 命中 0 |
| RV-S02 | BrowserWindow 硬化 | 关闭 sandbox/context isolation/webSecurity，或启用 webview | PASS（源码/单测） | `desktop/src/security.cjs:7`；安全窗口参数单测通过 |
| RV-S03 | 导航与外链 | 跨 origin 污染主窗口、危险协议可打开、带凭据 URL 被接受 | PASS（源码/单测） | `desktop/src/security.cjs:31`、`desktop/src/window-policy.cjs:14` |
| RV-S04 | 权限策略 | 远程页面可宽泛取得摄像头、麦克风、定位等权限 | PASS（源码/单测） | 媒体、定位、通知、`clipboard-read`、未知或跨源请求默认拒绝；仅同源受管页面允许 `clipboard-sanitized-write` |
| RV-S05 | 设置 IPC 来源 | 远程 frame 可读写服务器地址或触发本地动作 | PASS（源码/单测） | `desktop/src/security.cjs:44`、`desktop/src/main.cjs:369` 校验设置页 main frame |
| RV-S06 | TLS 与地址校验 | 远程 HTTP 被允许，或存在忽略证书开关 | PASS（源码/单测），TLS 实测待补 | `desktop/src/config.cjs:24`；仅 HTTPS 或 loopback HTTP；未见证书绕过 |
| RV-S07 | 下载路径 | 文件名可路径穿越、自动打开/执行下载文件 | PASS（源码/单测），真实下载待补 | `desktop/src/security.cjs:50`、`desktop/src/main.cjs:142` |
| RV-S08 | 日志隐私 | 输出 Cookie、Bearer、密码、响应正文或业务数据 | PASS（源码/单测/负向 smoke） | 健康检查错误只返回状态摘要；65534 负向运行未输出响应正文或凭据 |
| RV-S09 | 更新供应链 | 非 HTTPS feed、未验证签名更新或开发态发更新请求 | PASS（关闭态单测）；签名更新 BLOCKED | `desktop/src/updater.cjs:3`、`:14`；无有效 HTTPS feed 时零更新调用 |
| RV-S10 | 包内容 | `.env`、SQLite、uploads、服务端源码、密钥或用户数据进入包 | PASS（三平台产物） | macOS 双架构与 Windows asar 均为 318 entries，禁止路径/文件名命中 0；`src/**`、`renderer/**`、`assets/icon.png` 共 12/12 与冻结源码逐字节一致 |

## 可靠性与体验评审

| ID | 评审问题 | 可接受标准 | 当前状态 | 证据 / 备注 |
| --- | --- | --- | --- | --- |
| RV-R01 | 首屏失败 | 15 秒内出现业务页或可操作故障态，不白屏 | PASS（自动化 + 打包 smoke） | 首次无服务时改用 app-modal 明确提示，不再依附隐藏窗口；Mac 双架构不可达服务器均受控 exit 1，无挂死/假成功 |
| RV-R02 | 地址迁移 | 服务器/域名变化时可从设置修改并持久化，不用重装 | PASS（源码/单测/packaged settings IPC） | Mac 双架构四包的本地设置页 smoke exit 0；字段化 IPC 与配置写入/读回单测通过 |
| RV-R03 | 配置损坏 | 损坏/半写配置可回退，不导致启动死循环 | PASS（源码/单测） | 损坏/缺失配置回退默认地址单测通过 |
| RV-R04 | 单实例 / macOS 激活 | 重复启动或重新激活时复用、重连并聚焦，不产生空壳 | PASS（源码/回归） | `desktop/src/window-lifecycle.cjs`；关闭后重建重连、隐藏故障窗重试、可见窗聚焦和 `activate` 回归均纳入 35/35 |
| RV-R05 | 下载反馈 | 成功、取消、失败均有清晰状态，文件名安全 | PASS（源码/单测）；生产登录态待验 | 下载状态与文件名净化回归通过；真实生产 Cookie 下载归入生产域名发布门禁 |
| RV-R06 | 更新关闭态与弹窗父窗口 | 无 feed/无签名时安静停用；隐藏窗口不得成为 modal parent | PASS（源码/单测） | 未启用、缺 feed、非法 feed 均不调用 updater；更新提示只使用可见窗口，否则使用 app-modal |

## 打包与 CI 评审

| ID | 评审问题 | 通过标准 | 当前状态 | 证据 |
| --- | --- | --- | --- | --- |
| RV-B01 | 独立依赖 | `desktop/` 有独立 package 与 lockfile，不污染根运行依赖 | PASS（静态） | `desktop/package.json`、`desktop/package-lock.json` |
| RV-B02 | 文件 allowlist | builder 只包含主进程、设置页、图标和必要 package metadata | PASS（静态 + 三平台 asar） | 配置验证退出 0；asar 318 entries、敏感命中 0、冻结输入 12/12 一致 |
| RV-B03 | macOS 目标 | arm64/x64 的 DMG 与 ZIP，当前版本号一致 | PASS | `desktop/release/macos/` 四包齐全；arm64 原生、x64 Rosetta 的 ZIP/DMG 包内应用主页面 + 设置页均真实 exit 0，负向 exit 1 |
| RV-B04 | Windows 目标 | Windows x64 NSIS 与 ZIP；原生 Windows 完成安装运行验收 | PASS（交叉构建与载荷）；Windows 原生 BLOCKED | `desktop/release/windows/` NSIS/ZIP 齐全；PE/COFF、NSIS 内嵌 `app-64.7z`、三份主 EXE/asar 逐字节一致；尚未在 Windows 实机运行 |
| RV-B05 | 可复现性 | 锁定依赖可完成 verify 和对应平台构建 | PASS（冻结本机构建证据） | Electron 三套 runtime 均与官方 SHA 一致；verify 35/35；Mac 双架构与 Windows x64 产物均来自同一冻结输入 |
| RV-B06 | CI 最小权限 | workflow 只读源码；普通 CI 不读取签名 secret、不发布 | PASS（静态） | `permissions: contents: read`；无 `${{ secrets.* }}`；两平台均显式 `CSC_IDENTITY_AUTO_DISCOVERY=false`，命令使用 `--publish never` |
| RV-B07 | 产物真实性 | 安装器/ZIP 内含 Electron runtime 与 `app.asar`，不是占位文件 | PASS | Mac 四包已启动；Windows ZIP、NSIS 结构与载荷已验真；三平台 asar 同为 `3f622c81…86a8` |
| RV-B08 | 哈希清单 | 每个平台冻结交付件都有 SHA-256 清单 | PASS（内测产物） | `desktop/release/macos/SHA256SUMS-macos.txt` 与 `desktop/release/windows/SHA256SUMS-windows-x64.txt` 均与实算一致；正式更新 metadata 尚属生产 feed 门禁 |

## 已知边界，不得包装成缺陷已解决

1. **服务器和域名未就绪**：默认包只能连接 `http://127.0.0.1:3107`，不是“装完即可访问云服务”的正式客户端。配置能力只能证明未来可迁移，不能代替生产 HTTPS 实测。
2. **macOS 未签名/未公证**：内测包可能被 Gatekeeper 拦截；不能宣称可无提示安装，也不能证明正式自动更新。
3. **Windows 未签名**：SmartScreen 可能警告；不能宣称企业级可信发布。
4. **无 Windows 原生证据**：当前 Windows NSIS/ZIP 已完成结构、架构和载荷验真，但 macOS 交叉构建不能代替 Windows runner 的安装、启动、卸载和快捷方式验收。
5. **业务同步不等于壳同步**：服务端业务页面更新可即时跨端生效；Electron 主进程、安全策略或原生能力变化仍必须重新打包并走签名更新。

## 发现项台账

| 编号 | 级别 | 状态 | 发现 | 影响 | 修复 / 决策 | 复验证据 |
| --- | --- | --- | --- | --- | --- | --- |
| RV-001 | P2 | FIXED | macOS 关闭主窗口后再次触发 `second-instance` 时，旧分支只创建并显示未加载窗口 | 边缘路径会出现空壳 | 新建/隐藏窗口分支均调用重连，可见窗口恢复并聚焦；`activate` 复用相同安全路径 | `desktop/src/window-lifecycle.cjs` 与生命周期回归；最终 35/35 |
| RV-002 | P1 发布阻断 | BLOCKED | 正式自动更新尚无签名包和生产 HTTPS feed | 普通安装用户目前不会收到桌面壳更新 | 建立受保护签名流水线与生产 feed，再做升级/回滚演练 | QA-F503/F504；不影响服务端业务页面即时同步 |
| RV-003 | P1 | FIXED | 首次无服务和更新提示曾可能以隐藏业务窗作为 modal parent | 故障提示不可见或用户误以为白屏 | 只有可见窗口可作为 parent，否则使用 app-modal；首次无服务、更新弹窗均加入回归 | `desktop/src/window-lifecycle.cjs`、`desktop/src/updater.cjs`；35/35 |
| RV-004 | P1 | FIXED | 全拒绝权限会破坏业务页正常复制 | 已生成内容无法复制，影响核心交付 | 仅向同源受管页面开放 sanitized clipboard write；读剪贴板、媒体、未知/跨源仍拒绝 | `desktop/src/window-policy.cjs` 权限矩阵回归；35/35 |

## 发布前评审签字槽位

| 角色 | 结论 | 日期 | 依据 |
| --- | --- | --- | --- |
| 工程负责人 | 待签 | 待填 | 源码、构建日志、产物哈希 |
| 测试负责人 | 待签 | 待填 | `08-qa.md` 全部发布门禁结果 |
| 安全评审 | 待签 | 待填 | RV-S01–RV-S10 |
| 产品验收 | 待签 | 待填 | macOS / Windows 真实老板路径 |

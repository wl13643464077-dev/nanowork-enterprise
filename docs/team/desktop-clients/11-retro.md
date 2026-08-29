# NanoWork 桌面客户端复盘

更新日期：2026-08-23

## 状态

**冻结交付复盘：unsigned 内测包已齐；正式发布仍为 HOLD。**

macOS arm64/x64 四包已完成包内真实启动，Windows x64 NSIS/ZIP 已完成结构与载荷验真。未把 Windows 交叉构建写成 Windows 原生运行，也未把未签名内测写成正式发布。

## 已确认的决策价值

- Electron 采用安全薄壳：业务、数据、AI/地图/支付能力仍在中央服务端，避免把 `.env`、SQLite、密钥和业务数据复制到终端。
- 服务器地址可配置：域名未确定时可完成本机开发与壳验证，未来迁移无需重装。
- 业务页与桌面壳分层更新：业务/UI 可通过服务端一次部署跨端生效；Electron 主进程、安全策略或原生能力变化仍要重新打包、签名和发布。
- 严格 allowlist 与产物一致性检查有效：三平台 asar 318 entries，敏感命中 0；12/12 冻结输入逐字节一致。
- 普通 CI 明确 unsigned、无 signing secret、`--publish never`，把日常验证与未来受保护签名流水线分开。

## 假设验证结果

| 假设 | 验证方式 | 状态 | 结论 |
| --- | --- | --- | --- |
| BrowserRouter 与相对 `/api` 可由 Electron 薄壳直接承载 | Mac 双架构包内打开员工 101 主页面 | PASS（本机） | React `#root` 正常渲染；真实生产 Cookie/SSE/下载仍待域名上线后验收 |
| 默认 loopback + 设置页覆盖域名未定阶段 | 正向、不可达端口、设置页 IPC、配置回归 | PASS（本机） | 主页面/设置页成功；不可达端口 fail-closed；首次无服务提示不再依附隐藏窗口 |
| 远程页面拿不到任意本机原生能力 | 自动测试 + 静态扫描 | PASS | 35/35；远程页无 preload/通用 IPC；只给同源受管页 sanitized clipboard write |
| `files` allowlist 排除后端与敏感数据 | 解包 Mac 双架构与 Windows asar/安装器 | PASS | 三平台 asar 318 entries、敏感命中 0、共同 SHA `3f622c81…86a8` |
| 同一冻结输入可形成双平台包 | 核对 runtime、产物、asar 和 12 文件 | PARTIAL | Mac 双架构与 Windows 交叉构建均形成真实包；Windows 原生 runner 尚未运行 |
| 无 feed/签名时更新器安静停用 | 单测与打包启动 | PASS（关闭态） | 无效/未配置 feed 不请求；隐藏窗口不作为更新弹窗 parent；生产 feed 升级/回滚未验 |

## 本轮发现并修复

- `second-instance` 在窗口已关闭或隐藏时可能出现空壳：统一为创建/复用后重连，可见窗口再聚焦。
- macOS `activate` 路径接入相同生命周期逻辑，重新激活时可恢复连接。
- 首次无服务提示不再挂到隐藏窗口；无可见窗口时使用 app-modal，避免“白屏但提示在后面”。
- updater 只使用可见窗口作为 modal parent，隐藏窗口不会吞掉更新提示。
- 权限策略从机械全拒绝调整为最小可用边界：只允许同源受管页面写入净化后的剪贴板，读取、媒体、未知或跨源权限仍拒绝。
- 普通 CI 删除 signing secret 依赖，显式 unsigned，避免 PR/push 验证流水线接触发布凭据。

## 数据记录

| 指标 | 结果 | 证据 |
| --- | --- | --- |
| 桌面单测 | 35/35，0 fail/skip | `npm --prefix desktop run verify` |
| macOS 交付 | 4 包，共 477,255,902 bytes | `desktop/release/macos/`；arm64/x64 DMG+ZIP 哈希清单与包内启动 |
| Windows 交付 | 2 包，共 258,491,706 bytes；另有 blockmap 119,655 bytes | `desktop/release/windows/`；NSIS/ZIP/载荷哈希与结构证据 |
| macOS 首屏 | 主页面 + 设置页均 exit 0；未单独记录首屏秒数 | Mac 四包 smoke 记录 |
| Windows 首屏 | BLOCKED | 尚无 Windows 原生运行环境 |
| 故障恢复 | Mac 双架构不可达服务器均预期 exit 1；首次无服务、activate、second-instance 回归通过 | `08-qa.md` 与 Mac `BUILD-EVIDENCE.md` |
| 包内敏感文件 | 0 命中 | 三平台 asar 318 entries；12/12 与冻结源码一致 |
| asar SHA-256 | `3f622c81a23a4b743c7ef7bedfd0595d21da0f8ae60e152790d10449b26b86a8` | Mac arm64/x64 与 Windows 安装器/ZIP 一致 |
| 正式发布阻断 | 4 类 | 签名/公证、Windows 原生、生产域名业务链路、生产更新 feed |

## 后续行动

| 编号 | 行动 | Owner | 截止条件 | 状态 |
| --- | --- | --- | --- | --- |
| RT-01 | Windows x64 原生安装、启动、卸载与快捷方式验收 | Windows 发布负责人 | 正式发布前 | BLOCKED |
| RT-02 | 生产 HTTPS 域名完成双平台登录、Cookie、SSE 与下载 | 平台负责人 + 测试负责人 | 正式发布前 | BLOCKED |
| RT-03 | 配置 Apple 签名/公证与 Windows Authenticode | 发布负责人 | 正式发布前 | BLOCKED |
| RT-04 | 用签名包在生产 HTTPS feed 演练升级与回滚 | 发布负责人 + 测试负责人 | 自动更新启用前 | BLOCKED |

## 最终复盘结论

当前已证明：冻结源码 35/35，Mac arm64/x64 的 DMG/ZIP 四包都能从包内运行主页面与设置页，Windows NSIS/ZIP 是结构和载荷真实的 x64 产物，三平台 asar 内容一致且没有后端或敏感数据。当前交付足以进行受控 unsigned 内测。

尚未证明的只有正式发布所需四类外部链路：签名/公证、Windows 原生运行、真实生产域名登录/SSE/下载、生产更新 feed 的升级/回滚。因此正式对外发布继续 HOLD，且不得把服务端业务同步表述成桌面壳无需重新打包。

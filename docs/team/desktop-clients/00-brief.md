# NanoWork Windows / macOS 客户端简报

更新日期：2026-08-23

## 产品一句话

把现有 NanoWork 企业版封装成可安装的 Windows 和 macOS 桌面客户端，两端共用中央服务端数据、业务能力和界面更新。

## 目标用户与痛点

- 使用 NanoWork 的老板、管理员和企业员工。
- 当前只有 Web 产品，没有 Windows / macOS 安装包。
- 服务器和域名尚未确定，不能把地址写死在客户端。
- 希望日后业务功能一次更新，Web、Windows、macOS 同时看到。

## 本轮目标

1. 生成可启动的 macOS 安装包和压缩包。
2. 生成可启动的 Windows x64 客户端包，并建立 Windows 原生 runner 的 NSIS 安装包流水线。
3. 客户端可修改服务器地址，默认使用 `http://127.0.0.1:3107`。
4. 服务不可达时显示可操作的重试/配置提示，不是空白窗口。
5. 建立桌面壳自动更新程序与发布配置；未配发布地址时安全停用。

## 交付等级

可安装、可运行的未签名内测发布包，加上可在 macOS / Windows 原生 runner 自动生成发布包的 CI。

## 硬约束

- 本轮只做 Windows 和 macOS，不做手机端。
- 不把 Node 后端、SQLite 数据库、AI/支付/飞书密钥打进客户端。
- 不更改现有 Web 路由、同源 Cookie 鉴权和服务端业务契约。
- 没有 Apple Developer ID、Windows 代码签名证书和更新域名时，不冒充“已签名/已公证/已自动更新”。
- 不提交、不推送、不对外发布。

## 成功指标

- macOS 包在当前 Mac 实机启动，能连接本机 NanoWork，登录并打开业务页。
- Windows 产物包含真实 `.exe` 与完整 Electron runtime；Windows CI 可生成 NSIS 安装器。
- 服务器地址可持久化修改；远程地址强制 HTTPS，仅 loopback 允许 HTTP。
- 远程页面无 Node 能力，sandbox/context isolation 开启，导航、外链、权限和下载有明确门禁。
- 桌面客户端测试、Web 建构、打包配置校验与产物结构检查全部通过。

## 已跳过阶段及原因

- 市场压力测和首批用户研究：已有运行中的 NanoWork 产品与明确用户，本轮是交付形态扩展。
- 视觉方向锁定：主业务界面沿用现有 NanoWork 设计系统；新增设置页采用克制的桌面工具风格。

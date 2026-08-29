# NanoWork 桌面客户端实现计划

更新日期：2026-08-23

## 行走骨架

从本场启动 Electron，安全加载 `http://127.0.0.1:3107`，用现有登录会话打开数字员工页。

## 切片清单

### [ ] D1｜桌面行走骨架
- 任务：启动纳米Work 后看到本机 3107 的真实 NanoWork。
- 范围：`desktop/` 独立包、主窗口、单实例、安全 webPreferences；不改 Web/后端契约。
- 验收标准：只加载当前 origin，远程页无 Node/IPC，真实登录与 `/employees?employee=101` 可用。
- 验证方式：Node 单测 + Electron 实启动 + 当前 3107 手动路径。

### [ ] D2｜可配置服务器与故障恢复
- 任务：服务不可达时能设置地址、检测、保存和重连。
- 范围：配置库、本地设置窗口、有限 IPC、原生菜单/错误反馈。
- 验收标准：HTTPS 和 loopback HTTP 通过，其他 URL 拒绝；原子持久化；断网不白屏。
- 验证方式：URL 矩阵单测、IPC sender 校验单测、断网/错地址实启动。

### [ ] D3｜外链、弹窗、权限与下载安全
- 任务：安全打开外部资料并下载受保护产物。
- 范围：导航白名单、window-open handler、permission handler、will-download。
- 验收标准：未知协议和跨 origin 导航被拦；外部 HTTPS 交系统浏览器；同源下载保留会话。
- 验证方式：安全策略单测 + 真实受保护文件下载抽样。

### [ ] D4｜Windows / macOS 打包与图标
- 任务：拿到可运行的 macOS 包与 Windows x64 包。
- 范围：electron-builder、品牌图标、DMG/ZIP、Windows ZIP/NSIS、产物校验；不伪造签名。
- 验收标准：Mac 产物真实安装/启动；Windows 产物包含 `.exe` 和 `app.asar`；包内无后端/密钥/数据。
- 验证方式：`file`、解包清单、SHA-256、Mac 实启动、Windows runner 冒烟。

### [ ] D5｜自动更新与双平台 CI
- 任务：业务网页更新即时生效，桌面壳可通过签名发布源更新。
- 范围：electron-updater、环境化 feed URL、GitHub Actions macOS/Windows matrix、签名 secrets 契约。
- 验收标准：无 feed 时零更新请求；有 feed/签名时生成 metadata 并可检查；两 runner 上传独立产物。
- 验证方式：更新状态单测、workflow 静态校验、CI dry build / 实际 run 证据。

### [ ] D6｜发布与回滚包
- 任务：交付可被其他工程师直接构建、签名、安装和回滚的文档。
- 范围：README、环境清单、签名/公证、更新 feed、回滚、已知限制。
- 验收标准：新机只按文档即可重建；未签名限制和域名待接入边界明示。
- 验证方式：从干净 `npm ci` 到产物的完整命令重放，产物索引与 SHA 校验。

## 排序、测试与回滚

- D1 先证明现有 Web/API 可不改契约进桌面壳；D2/D3 紧接收口地址和远程内容安全；D4 产生交付物；D5/D6 保证可重复发布。
- 纯函数单测 URL/导航/配置/更新；Electron 集成验证启动/IPC/故障；打包后在 Mac 本机和 Windows runner 冒烟。
- 桌面端集中在独立 `desktop/`，可停用桌面构建而不影响 Web/API；回滚为恢复前一签名版本 metadata 与安装包。

## Git 检查点建议

- D1–D3：`feat: add secure configurable desktop shell`
- D4–D5：`build: package nanowork for macos and windows`
- D6：`docs: add desktop release and rollback guide`

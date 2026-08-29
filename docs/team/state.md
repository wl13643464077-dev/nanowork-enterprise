# 纳米 Work 验收状态（2026-08-28）

## 2026-08-28｜提交与本机部署

- 通道：完整通道，自动模式；当前阶段：11 发布执行。
- 本轮范围：提交当前已验收的产品升级，并部署到本机 `http://127.0.0.1:3107/`。仓库未配置生产服务器、域名、HTTPS、备份服务或自动部署目标，因此公网生产发布保持 **HOLD**。
- 最新完整门禁：服务端 1,791 项，1,789 通过、0 失败、2 项因外部渲染环境/真实验收样本缺失跳过；Web typecheck、隔离、token、UI 契约、strict lint、format check 和 Vite 生产构建全部通过。
- 安全边界：提交排除 `.env*`（仅保留示例）、SQLite、日志、构建缓存、临时目录与运行证据；本机环境文件权限收紧为 `600`。未获明确指令前不推送远端，不宣称公网已上线。
- 回滚准备：重启 3107 前先对当前 SQLite 做一致性快照；代码以提交前后 Git 版本作为回滚锚点。

## 当前运行

- 服务地址：`http://127.0.0.1:3107/`
- 健康检查：`GET /api/health` 返回 `{"ok":true,"db":"up"}`。
- 当前数据库：`server/data/nanowork-preview.db`。
- 调度器沿用部署前配置，以 `ENABLE_SCHEDULER=true` 运行；正式迁移前需结合目标时区和外部连接器再次确认自动任务窗口。

## 真实样本

- 任务 #62（餐饮市场机会研究）已完成并自动采用，使用真实 API 模型 `deepseek-v4-flash`，正文 6,995 字。
- 已验证输入审计、7 步方法、5 项交付、技能研究计划、地图/路网工具、来源门、安全门与账务结算。
- 当前可下载产物：PDF/DOCX/XLSX，均为 `draft=false`，并已做实体文件、哈希、ZIP/PDF 结构和 QuickLook 视觉验收。
- 旧任务 #49/#50 已通过 append-only supersession 边表取代；旧正文、旧文件、知识库和业务入口均隐藏或返回 `DELIVERY_SUPERSEDED`。

## 证据边界

- 72 个数字员工已完成确定性前置矩阵（档案、能力、技能、提示词、配置、输出契约）；这不等同于 72 个都实际消耗云模型执行。
- 395 项功能清单中，372 项仍标记“未执行（无证据）”，23 项因外部副作用策略保持安全阻断；不能把静态覆盖计为真实成功。
- 当前公开地图链使用 OSM/Nominatim/Overpass/Valhalla；`apiClaims=[]`，不能宣称已直连高德、大众点评或美团官方 API。

## 本轮最新复验（2026-08-20）

- 浏览器只读巡检：餐饮 101–161 共 61/61、内容 0–9 共 10/10，均可打开并显示技能/能力/执行入口，当前页面 HTTP 4xx/加载错误为 0；证据见 `artifacts/browser-evidence-final/employee-ui-smoke-2026-08-20.json`。
- 工具箱 UI 12/12 卡片可打开并显示输入/运行入口；这只是页面可用性，不等于真实 API 交付成功。
- 真实功能矩阵 `artifacts/real-feature-matrix-2026-08-20.json`：16/36 总通过，真实 API 11/31，权限边界 5/5，输入/输出 token 94,110/64,545，成本 ¥5.9943；最终 active hold=0、held=0、无飞书外发残留。
- 真实功能失败不能隐藏：8 个工具箱场景未达到 `canUse=true`；另有供应商超时、业务语义锚点、审批增量/模板污染等失败。
- 内容 0–9 immediate+scheduled 隔离矩阵已收口：20/20 未通过最终业务闭环门禁（立即 0/10、定时 0/10）；11/20 取得真实 API 正 token、8/20 形成真实内容/契约。隔离副本最终 active=0、held=0、无发布/飞书外发/重复周期认领。证据见 `artifacts/real-content-automation-matrix-2026-08-20.json`；不得把页面可打开计为自动化通过。
- 全岗位真实云执行矩阵已完成（独立数据库/3111 服务）：证据文件 `artifacts/real-employee-matrix-2026-08-20.json`。72 个单岗均已发起真实执行或记录明确阻断，业务通过 0/72（71 FAIL_REAL_API、1 BLOCKED_VIDEO）；累计输入/输出 631,150/368,659 token，客户账本实扣 ¥5.4473/846 积分，结束时 held=0。
- 0→9 内容总流水线新建 #25，工位 0–4 真实完成 5/10，工位 5 因媒体授权安全停住（`awaiting_media_authorization`），后续工位未伪造；#24 为旧中断记录，不计通过。
- 2026-08-21 接口级补测：190 个 GET 全部走过（145 个 2xx、45 个预期边界、0 个 5xx/超时）；168 个写接口在隔离副本走过（143 个预期边界、23 个不可逆动作安全阻断、2 个隔离会话正常响应、0 个 5xx/超时）。输入/输出/质量明细分别见桌面 `nanowork-all-get-api-functional-report-2026-08-21.md` 与 `nanowork-all-write-boundary-report-2026-08-21.md`。
- 合并清单 `artifacts/full-feature-inventory-2026-08-21.json` 共 538 个入口：407 个已有真实执行证据、108 个页面/菜单只读通过、23 个外部副作用安全阻断；无入口仍留在“无证据”分类。页面壳通过不替代业务交互矩阵。
- 2026-08-21 真实用户复跑任务 #51：完整 requirement 已进入执行，4/7/5、7 能力、7 技能和运行绑定均锁定；DeepSeek 超时后安全切换 gpt-5.5 仍连续 504，0 候选/0 token，任务 fail-closed、2,127 积分全额释放、未生成模板正文。桌面详报：`/Users/wanglei/Desktop/nanowork-employee-real-user-rerun-51-2026-08-21.md`。
- 2026-08-21 最终服务端回归：`server/npm test --silent` 在显式空云密钥环境下 1,713 passed / 0 failed / 1 skipped；唯一 skip 是当前环境缺少 bundled `documents/render_docx.py` 的视觉渲染测试，OOXML 契约测试仍通过。

## 2026-08-21｜修正版全功能报告（覆盖旧 538/407、190/168 与 0/72 口径）

- 项目地址：`http://127.0.0.1:3107/`；最新代码已重启，调度器关闭，健康检查 `ok=true, db=up`。
- 当前真实清单为 471 个入口 / 434 个唯一 API：GET 228、WRITE 206。
- 修正版 GET：173 正向通过、52 负向边界、3 安全未执行、0 测试器无效、0 当前产品失败。
- 修正版 WRITE（isolated DB）：17 正向通过、146 负向边界、43 安全未执行、0 测试器无效、0 当前产品失败。
- 旧报告中的批量“会话被吊销”来自 logout 后复用同一 token；旧“未知钻取类型/内容格式错误”来自无效动态参数；均已修复测试器并重新执行。
- 升级前员工 `0/72` 报告整源无效：其中 57 条已完成、57 条可使用、58 条契约有效，59 条被 report-first/JSON 不兼容测试器系统性误判。修复 runner 后仍需按当前版本另行真实云重跑，不能把旧行直接翻成通过。
- 当前用户版报告：首页只显示可行动结论；历史失败与当前故障分开；不输出 raw body、内部提示词、密钥、Token 或 Cookie。报告 ID `ff1f9ea61cd5c1ff66116c54f28caa033c36434fb021d41237995a393ab5f4f3`。
- 最终门禁：服务端全量 1744 通过、0 失败、1 项按设计跳过；Web typecheck、strict lint、format check、生产构建全部通过。桌面 5 份旧报告已留 `.legacy-invalidated` 备份，并由 SHA-256 一致的纠正版替换。

## 2026-08-21｜全功能报告第二次语义收口（当前权威）

- 项目地址：`http://127.0.0.1:3107/`。
- 当前清单：471 个入口 / 434 个唯一 HTTP API（GET 228、WRITE 206）。
- GET 当前探针：173 正向功能通过、52 负向边界通过、3 安全未执行、0 尚未验证、0 当前接口探针失败。
- WRITE 隔离探针：2 正向功能通过、150 负向边界通过、50 安全未执行、4 尚未验证、0 当前接口探针失败。旧的 17 项写接口“正向通过”中，15 项实际为边界/安全/无证据 2xx，已纠正。
- 总报告：176 当前正向、202 负向边界、53 安全未执行、40 尚未验证、0 当前接口探针失败；另有 17 条历史通过、77 条历史失败、9 条测试器/证据源无效，全部与当前接口结论分开。
- 业务矩阵已纳入：2026-08-20 历史证据 16/36，其中真实 API 11/31、权限边界 5/5、20 条历史失败；当前代码仍需专用隔离库重跑。
- 员工输出质量已纳入：v5 的 4 份产物因来源矩阵 SHA 不匹配整源作废；最新可复现 v3 覆盖 1 份产物，质量 1/1、业务生产 0/1、运营阻断 1；两份 v1 各 70 条也整源作废。
- 最新报告 ID：`bcfb6bafede91fe7591af12dfecd77ee5ccc8e2589d4b39e77255d16b47b3951`；权威文件为 `artifacts/nanowork-all-functions-corrected-2026-08-21.{md,json}`。
- 工程门禁：服务端 1,757 通过、0 失败、1 项按设计跳过；报告/探针定向 103/103；Web typecheck、strict lint、format、生产构建、隔离、token、UI 契约和 `git diff --check` 全部通过。

## 2026-08-21｜老板视角真实员工与工具箱验收（当前交付）

- 真实岗位问题已覆盖餐饮 61 个、内容生产 11 个，共 72/72 个员工入口；63 个形成可用交付，9 个明确记录无产出或质量门失败，未把失败改写成通过。
- 工具箱 12/12 个入口已按岗位职责输入并真实执行：5 个完成，4 个生成正文后被质量门拦截，3 个无产出；联网搜图返回 20 个候选但全部授权未核验，未导入素材库。
- 报告位置：`artifacts/manual-acceptance-2026-08-21/real-business-runs/`；桌面同步位置：`/Users/wanglei/Desktop/nanowork-manual-acceptance-2026-08-21/real-business-runs/`。
- 报告内容包含每项老板输入、任务状态、输出摘要/哈希、契约与运行阶段、计费/退款、质量评分和失败原因；不可逆发布、付款、删除、自动改价、自动联系顾客等只验证安全边界，不执行真实副作用。

## 2026-08-21｜老板验收问题修复后定向复验

- 已重启 3107 服务并关闭调度器；健康检查 `ok=true, db=up`。
- 修复员工135不可逆预约/锁位/改价声明的安全改写、员工157零Token 500/502 的受控 gpt-5.5 切换、内容员工后台请求断开误取消、撰稿事实返工提示、工具箱 Markdown 表格误拦截、政府首页链接误派发、中文字幕 PNG 栅格回退。
- 修复后定向回归 123/123、员工/内容/工具箱组合 77/77、内容返工/异步后台组合 63/63、Web typecheck/lint/build/diff-check 全部通过。
- 联网搜图 20 个候选仍保持“授权未核验”阻断：没有用户自有或商用授权证据，不自动导入；这属于版权安全边界，不计为联网服务故障。
- AI带货员改按专用 `/api/content/ai-sales-video` 入口验收，不能从通用内容 JSON 入口判为失败。详细复验见 `artifacts/manual-acceptance-2026-08-21/real-business-runs/修复后定向复验报告.md`。

## 2026-08-23｜Windows / macOS 桌面客户端

- 通道：完整通道，自动模式。
- 当前阶段：10 发布准备与跨平台证据收口。
- 在岗角色：总指挥、工程师、测试负责人。
- 产物：`desktop/` 安全薄壳、双平台构建配置与 unsigned CI；冻结交付仅使用 `desktop/release/macos/` 的 arm64/x64 DMG+ZIP 四包和 `desktop/release/windows/` 的 x64 NSIS+ZIP，并附双平台 `BUILD-EVIDENCE.md` 与 `SHA256SUMS-*`；验收文档为 `docs/team/desktop-clients/00-brief.md`、`03-prd.md`、`06-architecture.md`、`07-plan.md`、`08-qa.md`、`09-review.md`、`10-release.md`、`11-retro.md`。
- 已定决策：D-077，Electron 安全薄壳，不内嵌后端；本轮仅 Windows/macOS。
- 切片进度：D1–D3 自动化、开发态与安全回归已完成；D4 的 macOS arm64/x64 四包均已真实启动，Windows NSIS/ZIP 已完成交叉构建、结构、架构和载荷验真但未做 Windows 原生运行；D5 更新关闭态与普通 unsigned CI 契约已完成；D6 最终产物索引、哈希和交付文档已回填。
- 最新验证：桌面 35/35；Mac arm64 原生与 x64 Rosetta 的解包 app、ZIP app、DMG 只读挂载 app 均完成主页面+设置 IPC smoke，正向 exit 0、不可达服务器 exit 1、无残留；Windows NSIS/ZIP 的 PE/COFF、压缩完整性、`app-64.7z` 载荷及主 EXE/asar 三方一致性通过。三平台 asar 均为 318 entries、SHA-256 `3f622c81a23a4b743c7ef7bedfd0595d21da0f8ae60e152790d10449b26b86a8`，敏感命中 0，冻结输入 12/12 一致；三套 Electron runtime 官方 SHA 与实算一致。
- 回归修复：同源受管页面获得最小 `clipboard-sanitized-write` 权限；首次无服务提示不再依附隐藏窗口；macOS `activate` 与 second-instance 可重连；updater 不使用隐藏窗口作 modal parent；普通 CI 无 signing secret 引用、显式 unsigned 且 `--publish never`。
- 下一步仅保留四类正式门禁：Windows 原生安装/启动/卸载；Apple 签名公证与 Windows Authenticode；生产 HTTPS 域名的登录/Cookie/SSE/下载；生产签名更新 feed 的升级/回滚。
- 禁止改动：不打包 `server/.env`、SQLite、uploads 或任何密钥；不做手机端；不提交/推送/对外发布。
- 验收骨架已建立：`docs/team/desktop-clients/08-qa.md`、`09-review.md`、`10-release.md`、`11-retro.md`；当前均保留真实证据槽位，没有把未运行、无签名或无 Windows runner 的项目写成通过。
- 当前发布判定：受控 unsigned 内测 READY，正式对外发布 HOLD。HOLD 只因签名/公证、Windows 原生运行、真实生产域名登录/SSE/下载、生产更新 feed 四类门禁未闭环；不再因 macOS 产物缺失或未启动。

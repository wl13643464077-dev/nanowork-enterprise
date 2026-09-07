# 2026-09-07 交接后续处理：Image2 取证、自助改密、事实核对、双供应商后端、统一定价结算与全量测试修复

本记录承接两份桌面交接（《纳米Work-技术交接-2026-09-07》《纳米Work-双供应商切换交接-2026-09-07》），只写本轮实际完成与仍未完成的事实。所有改动仍在本地工作区，未推送、未部署、未发起任何付费生成。

## 1. Image2 根因取证（P0）

- 用生产同一把 360 Key 只读调用 `GET https://api.360.cn/v1/models`（不产生生成费用）。目录返回 **90 个模型**，含实测可用的 `alibaba/wan3.0-video`、`qwen/qwen3.8-flash`、`deepseek/deepseek-v4-flash-vision-exp` 等，但 **0 个图片生成模型**：`openai/gpt-image-2`、`google/gemini-3-pro-image-preview`、`alibaba/wan2.7-image`、`volcengine/doubao-seedream-5.0-lite` 全部不在目录中。
- 官方 OpenAPI 文档中 `/v1/images/generations`、`/v1/images/edits` 的状态仍为 `x-apifox-status: developing`；公开模型广场 84 个模型中亦未见图片输出模型。
- 结论：此前所有 HTTP400/1001 与“目录不含图片模型”一致；同一目录里在列的视频模型可用、不在列的图片模型全部 1001，说明目录能反映本组织的可调用范围。**这是 360 未向本组织开放图片模型，不是参数、地址或代码问题**，代码侧无法修复；需由用户携组织 ID、请求时间与模型名联系 360 开通。开通后现有适配器无需改动。
- 产品改动：
  - `server/src/engines/provider-360.js` 新增 `describe360ImageAvailability()` / `is360ImageModelId()`；后台“测试连接”返回 `imageAvailability`（`no_image_models` / `other_image_models_only` / `configured_listed`）。
  - `server/src/engines/provider-errors.js`：1001 模型错误的用户提示改为“所用模型尚未向本账号开放……已生成的文字保留，未出图部分不收费”。
  - `web/src/components/PlatformApiConfig.tsx` 在连接结果下方显示该诊断，并保持“目录仅供参考、以真实生成为准”的中性说明。
- 回归：`provider-360.test.mjs`、`provider-errors.test.mjs` 17/17。

## 2. 企业账号自助改密（P1，已完成）

- `POST /api/auth/password`（`server/src/routes/auth.js`）：任何已登录账号，校验当前密码，`auth_version+1`，吊销本人全部会话，清 Cookie，按账号限流（默认 5 次/10 分钟，`PASSWORD_CHANGE_MAX_FAILURES`）；不记录明文。
- 前端：顶栏账号菜单新增“修改密码”弹窗（`web/src/components/ChangePasswordModal.tsx`，`MainLayout.tsx`），成功后清本地登录态回登录页。
- 回归：`auth-self-password-change.test.mjs` 3/3（旧令牌 401、旧密码 401、新密码 200、限流 429、日志无明文）。

## 3. 文字真实性（P1，可离线验证的部分）

- 新增 `server/src/engines/fact-grounding-advice.js`：对正文做确定性检测，列出用户未确认过的口味/口感、适合人群、配料/工艺、顾客评价/销量、价格/折扣、年限等具体说法；只给建议，不改正文、不重试、不影响计次。
- 体验对话（`tester-trials.js` `conversationView`）返回 `factAdvice`，H5 与测试员历史在正文下方显示“发布前请核对这些说法”。提示词补充逐句自查条。
- 回归：`fact-grounding-advice.test.mjs`、`tester-trials.test.mjs`、`tester-analytics.test.mjs` 27/27。
- 未做：真实 Flash/Pro 复测（需付费，未授权）。

## 4. 双供应商切换：管理后端补齐（承接双供应商交接 §3.3）

- 平台（`server/src/routes/admin.js`）：
  - `GET /api/admin/api-config?provider=openlux|360` 返回 `providers`、`defaultProvider`、`selectedProvider`、按该家计算的 `channel`（固定 Base URL、掩码 Key、keySource、available）、`routing`、`billing` 等；读取不改配置。
  - `PUT /api/admin/api-config {provider, defaultProvider?, routing?, billing?, h3?, supplierCost?}`：`defaultProvider` 单独校验（仅两家 ID，且必须已配置 Key，否则 409 `AI_PROVIDER_UNAVAILABLE`）；`routing` 写入 `model_routing_<provider>`，360 按目录白名单校验，OpenLux 地址固定不可改，Key 仍只走环境变量。
  - `POST /api/admin/api-config/test {provider}`：只把该家的 Key 发往该家的 `/models`。
- 企业（`server/src/routes/admin-model-budget.js`）：
  - `GET /api/admin/model-routing?provider=` 预览该家目录/默认/本企业已保存偏好，附 `providerId`、`effectiveProvider`、`providerOverride`、`defaultProvider`、`providers`（不含 Key/地址），不落库。
  - `PUT {provider, routing}`：按目标供应商白名单校验，事务内写入 `tenant_model_routing.routing_json.providerProfiles[provider]`（保留另一家）与 `sys_config.ai_provider_tenant_<tid>`；未配置 Key 的供应商 409。
  - `PUT {reset:true}` / `DELETE`：同事务清空模型覆盖与供应商选择。
- 回归：新增 `dual-provider-admin-routes.test.mjs` 4/4；`dual-provider-selection`、`tenant-model-routing`、`platform-provider-boundary`、`provider-360-boundaries`、`enterprise-settings-ui`、`provider-selection-ui-contract`、`tester-provider-selection-ui-contract` 全部通过（测试员 UI 契约的旧 provider 回退表达式已同步）。

## 5. 统一定价结算（承接双供应商交接 §4）

- `credits.js settleHold()` 新增 `salePolicy.basis==='reference_360'` 分支：用户积分 = 预授权快照冻结的参考价目 × 2（文本按真实 token，组合视频按调用方传入的参考价总额）；供应商回执只填平台成本（`known`），缺回执记 `pending`，不阻断交付、不改售价；回执迟到只补成本、不再动用户余额；文本仍必须有正 token；调用方自报文本积分与参考价不一致拒绝；旧快照（无 `salePolicy`）继续按原规则。共用尾部抽为 `finalizeSettlement()`。
- 回归：新增 `credits-unified-pricing.test.mjs` 3/3（OpenLux 实扣 0.7 元与 360 实扣 0.03 元同一任务均收 24 积分；缺回执 pending；旧快照缺回执仍阻断；图片按核实基准价；无成果全退且供应商成本独立保留；余额与账本恒等）。
- **仍未启用**：`unified_360_pricing` 配置未写入任何库；图片基准价仍未核实，`unifiedSalesPricing()` 在缺金额或依据时拒绝启用。启用前须先核实图片单次实扣。

## 6. 全量测试修复（交接前未跑全量）

第一轮全量：2679 项中 **49 项失败**（18 个文件）。根因与处理：

| 根因 | 处理 |
|---|---|
| 9/6 新增“文本结算必须按真实用量、拒绝调用方固定积分”硬校验，旧测试仍传 `credits:N` | 8 个测试文件改为按真实 usage 结算、快照与账本对齐（业务代码不变） |
| 流水线 `hasDeliverable` 在表不存在时抛错被当作“已交付”→ 误转待对账 | `content-production-pipeline.js` 新增 `stationDeliverableExists()`：表不存在=无交付；其他错误仍保守 |
| `supplierCostSettings()` 在无 `sys_config` 表时抛错 | `provider-cost-receipts.js` 容错为未配置 |
| 新“无成果全退”规则下账本为 `failed/0` 而非 `api/0`；provider 已开始也退款 | 更新 `employee-workbench`、`special-provider-idempotency` 断言为新规则 |
| OpenLux 回执改为 `/api/status` 汇率 + `upstream_debit`，旧 rag 测试还用 `rmbPaid` 配置 | 更新 mock 与配置 |
| 双供应商团队将 OpenLux 默认视频改为 `wan2.6-i2v`；无 Key 时不再发请求；篡改回执改报 `UNVERIFIED` | 同步 `toolbox`、`ai-sales-video-wan-contract`、`credits-upstream-debit` 断言 |
| 30 秒可单段生成后，单段 15 秒素材应按实测时长拒绝 | 同步 `ai-sales-native-audio-composer` 断言 |
| 测试跑器未清空 `AI360_API_KEY`/`NANOWORK_AI_PROVIDER`，开发机 Key 会进入测试 | `server/scripts/run-tests.mjs` 显式清空 |
| `format:check` 3 个文件不合规导致 `npm run verify` 必红 | prettier 修正 |

最终全量（含本轮所有改动）见本文末尾“验证”。`provider-360-boundaries`、`skillrun-xlsx-layout` 依赖 DNS/LibreOffice，在无网络沙箱内失败、正常环境通过。

## 7. 仍未完成 / 需要用户决定

- **Image2 真实出图**：供应商侧开通，代码无法解决。
- **统一定价启用**：图片基准价未核实；需一次指定模型、medium、1024x1024 的真实生成并对照账单后再填写 `imageBenchmarkCny` 与依据。
- **恢复 OpenLux 默认**：需在生产 `/etc/nanowork/server.env` 单独加入 `OPENLUX_API_KEY`（保留 `AI360_API_KEY`），并由 Super 在后台“设为平台默认”；本轮未改任何环境文件。
- **真实付费验收**（OpenLux 文本/Image2/Wan2.6 15 秒、360 文本、30 秒视频、录音参考）、**微信/支付宝商户**、**Windows 真机与发行签名**、**异地备份演练**：涉及花钱或外部资源，未执行。
- 测试员分槽 Key 迁移与生产发布：代码已就绪，未在业务库/线上执行。

## 验证

- 服务端全量：见 state.md 顶部最新数字。
- Web：`typecheck`、`lint:strict`、`format:check`、`check:isolation`、`check:tokens`、`check:ui-contract`、`build` 全部通过。

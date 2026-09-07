# 纳米 Work：双供应商切换与统一定价交接

交接时间：2026年09月07日，北京时间15:38。本机为洛杉矶时区。本文是本轮增量交接，替代“本轮已经完成”的任何口头理解；历史功能和部署资料见桌面原《纳米Work-技术交接-2026-09-07》。

**当前结论：改动保留在本地工作区，尚未完成、尚未上线。双供应商核心与测试员分槽已写入并有定向回归；平台/企业切换接口和统一账务结算仍需接完。用户要求转交后，已停止继续开发和新增付费测试。**

## 1. 用户最后确认的目标

1. 默认恢复原 API 中转商 OpenLux；保留 360 智脑，允许选择，不删除其适配和 Key。
2. 面向普通企业只维护一套售价，以 **360 费用基准 × 2** 计价，不能因为切换供应商而换一套用户价格。实际供应商扣费另记为平台成本。
3. 图片不能用旧代码里的 **2元/张预占估算** 当真实成本。提出过的 **4元/张临时售价未获确认，已取消**。用户认为实际应是几毛，要求核对。
4. 测试员使用自己的对应供应商 Key；其客户 H5 两次成功文字体验也走该测试员的 Key，不扣平台企业算力余额。测试员不能创建子账号，Super可随时停用。
5. 失败且没有可交付成果，用户积分全退；上游已产生的费用由平台承担。历史任务按原供应商继续查询，不能切换后重复提交或用另一家的 Key 查询。
6. 本轮最新请求是交接给其他人继续，**不是继续开发或发布**。

## 2. 当前源码和运行环境

| 项目 | 本次核实结果 |
| --- | --- |
| 实际源码目录 | `/Users/wanglei/Documents/纳米work企业版本`，不要把较早桌面内测包当当前源码 |
| Git | `main`，HEAD `b494b43ad38ea801f35cc280c317f098a11fecdf`；交接盘点时有382条工作区状态，含大量此前改动，不是本轮独占 |
| 本轮提交/发布 | 没有新 Git 提交、没有生产发布、没有替换本地运行环境变量、没有生产数据迁移 |
| 本地服务 | 3107；原 LaunchAgent 管理，勿重复起同端口服务 |
| 本地数据库 | `server/data/nanowork-preview.db`；只读检查未设置 `ai_provider_default`、`unified_360_pricing`；尚无测试员分供应商 Key 表和 active_provider 列 |
| 本地有效环境 | `NANOWORK_AI_PROVIDER=360`，`YUNWU_BASE_URL=https://api.360.cn/v1`；AI360 Key存在，OPENLUX/YUNWU Key为空；调度关闭，H3关闭 |
| 线上网址 | https://xn--work-9r3ko5i.cn （纳米work.cn） |
| 线上版本 | 本轮只读复查 `/opt/nanowork/current` 仍指向 `/opt/nanowork/releases/20260907123347`；nanowork、caddy 均 active |
| 线上配置/数据 | `/etc/nanowork/server.env`；`/var/lib/nanowork/data/nanowork-industry.db`；部署前重新核对，不用本地DB覆盖生产 |

**不要 `git reset --hard`、`git clean` 或拿HEAD覆盖工作区。** 大量已上线功能尚未提交，还包含其他人的事实核验提示、修改密码等改动。附件工作区清单仅用于定位，不代表全部文件都是本轮新改。

凭据位置只交接路径，不交接明文：本地当前配置 `server/.env`；旧 OpenLux Key保存在 `server/.env.before-360-20260906`；SSH身份文件 `/Users/wanglei/.ssh/namiwork-hk-20260906`。不要整份恢复旧env，它会连同旧调度/H3设置一起恢复。保留 `AI360_API_KEY`、`TESTER_KEY_ENCRYPTION_SECRET`、JWT和其他现有配置。

## 3. 本轮已经落盘的改动

### 3.1 双供应商底层：代码已写，局部回归通过

新增 `server/src/engines/ai-provider-selection.js`，接入 `yunwu.js`、`app.js`、AI/XHS/原生视频相关执行与恢复路径。

- `openlux`固定 `https://api.openlux.ai/v1`；`360`固定 `https://api.360.cn/v1`。
- 平台两份Key独立取用；旧YUNWU环境/数据库Key仅在对应base同源时兼容读取，不相互借用。
- 选择优先级：测试员个人上下文 → 请求冻结的平台供应商 → 企业显式选择 → 平台默认 → 老环境兼容。
- 单个请求/历史任务绑定供应商。切换默认后，历史图片、视频查询与恢复仍用原家；未知或矛盾归属不猜测、不重新生成。
- 文本和图片模型随所选通道动态读取；OpenLux原生有声视频默认Wan2.6。360适配保留。
- 模型目录未展示Image2，不作为禁止调用或“账号无权限”的证据。

关键调用契约：

```js
selectedProviderId(tenantId)
platformDefaultProviderId()
withPlatformProvider(providerId, action)
selectedProviderCredentials() // 内部敏感对象，严禁原样返回浏览器
platformProviderAvailability() // 可公开状态，不含Key
providerForModel(model)
withTaskProvider({ providerId, provider, model, taskId }, action)
```

配置约定：

| 配置位置 | 内容 |
| --- | --- |
| `sys_config.ai_provider_default` | `openlux` 或 `360` |
| `sys_config.ai_provider_tenant_<tenantId>` | 该企业显式选择 |
| `sys_config.model_routing_openlux` / `model_routing_360` | 两家独立的平台模型偏好 |
| `tenant_model_routing.routing_json.providerProfiles` | `{openlux: {...}, "360": {...}}`，保存一家时保留另一家 |
| 平台环境变量 | `OPENLUX_API_KEY` 与 `AI360_API_KEY`；实际值只能在私有环境配置中维护 |

`tenantRoutingOverride()`现同时返回当前家的 `.routing` 和原完整 `.rawRouting`，写入企业模型配置应合并完整结构。

### 3.2 测试员和体验二维码：代码已写，33项隔离回归通过

修改范围包括 `tester-access.js`、`tester-trials.js`、`tester-provider-context.js`、`tester-cost-evidence.js`、`tester-analytics.js`、`routes/testers.js`，并补了测试及使用指南。

- 新账号默认OpenLux，旧账号保持360。
- `tester_provider_keys`按 `owner_user_id + provider`保存独立加密Key；旧单Key迁移至360槽后清空兼容列，防止删除Key后重启又恢复。
- 旧二维码保留360；新二维码/对话在创建时冻结供应商。切换只影响之后新建的内容。
- 缺少对应个人Key时阻断，不借平台Key、不借另一家Key。
- OpenLux回执以quota、计量单位和供应商展示汇率核验人民币实耗；按账号、供应商、请求编号去重。
- 历史、尝试详情和看板增加供应商归属；失败费用保留，不扣成功体验次数，不扣平台积分。

API契约：

```text
GET /api/tester/me
  activeProvider
  providers: [{id,label,configured,maskedKey,keyUpdatedAt}]
PUT /api/tester/provider  {provider}
PUT /api/tester/key       {apiKey,provider?}
DELETE /api/tester/key    provider可用body或query传入，省略则当前家
```

**迁移尚未在本地业务库/线上执行。以后若回滚旧单Key版本，不能只切旧代码：需受控回填360兼容密文列；不能恢复旧整库丢失期间客户数据。**

### 3.3 平台/企业前端：入口已写，后端未接通

`PlatformApiConfig.tsx`增加两家选择、分别查看状态、分别测试连接、独立设置默认供应商；平台Key维持只读。

`AdminModelRoutingPanel.tsx`增加企业供应商选择：切换下拉先预览模型，保存才生效；企业只选供应商/模型，不展示或修改平台Key。测试员页面也增加个人通道选择。

测试员前端文件为 `TesterPortal.tsx`、`TesterApply.tsx`、`TrialShared.tsx`、`TrialExperience.tsx`、`TrialAnalyticsPanel.tsx`、`PlatformTesters.tsx`；旧记录缺provider时回退为360，并保留修改密码和事实提示。**最后一次契约测试8/9通过**：测试还匹配 `trialProviderLabel(attempt.provider)`，源码已变成 `trialProviderLabel(attempt.provider || item.provider || '360')`。接手者应核对旧记录展示行为后同步测试；最后修改后typecheck尚未重跑，不能称当前前端全绿。

**平台/企业管理后端 `server/src/routes/admin.js`、`admin-model-budget.js` 尚未实现下面的新契约。当前前端不能据此宣称可实际切换。**

约定待补：

```text
GET /api/admin/api-config?provider=openlux|360
  providers, defaultProvider, selectedProvider,
  channel:{providerId,provider,baseUrl,key(仅遮罩),keySource,available},routing,billing,...
PUT /api/admin/api-config {provider,defaultProvider?,routing?,billing?,...}
  provider指定编辑哪家；defaultProvider单独改变默认
POST /api/admin/api-config/test {provider}
  只验证选中的家，目录连接通过不等于图片/视频真实生成通过

GET /api/admin/model-routing?provider=...
  原payload加providerId(预览)、effectiveProvider(实际)、providerOverride、defaultProvider、providers
PUT /api/admin/model-routing {provider,routing}
  事务保存企业选择和对应profile，保留另一家
PUT /api/admin/model-routing {reset:true}
  清企业选择及覆盖，恢复平台默认
```

管理API必须严校验两家ID、模型白名单和权限；GET预览不得修改配置；请求上下文需按查看的供应商包装，避免被当前企业/环境的360残留覆盖。

## 4. 统一定价：只写了一部分，必须继续完成

新增 `server/src/engines/unified-sales-pricing.js`，配置名 `unified_360_pricing`。**未启用，不能现在直接开启或上线。**

已写入：

- `billing()`读取统一价草案，倍率固定2；新预授权快照记录 `salePolicy.basis='reference_360'`。
- `charge()`直接扣费路径开始把用户售价与实际供应商费用分开；实际费用未知时标pending，不把估价写成真实成本。
- 原生带货视频 `voicedSalesSettlement()`增加参考价分支，用户费用按原报价计算，只有已验证成本才返回 `costYuanOverride`；恢复核验容许成本待对账。

**尚未做完的最关键部分：**

1. `credits.js`的 **`settleHold()`仍是旧逻辑**：有真实成本时仍按实耗×2收费；缺回执仍会阻断。与新的 `salePolicy`以及视频返回值不匹配。应先改这里，让平台成本证据与用户售价独立结算。
2. 新统一价格部分还没有账务专项测试；最后一段 `credits.js`修改是在用户要求交接前刚落盘。已有其他测试通过不能代替它的验收。
3. 无价格快照的历史hold目前会回落当前 `billing()`；切换新规则前需处理旧任务，防止给历史任务套新价。已有快照要保持原价和原规则。
4. `supplierCostForUsage()`新增allowPending，但 `settleHold()`未接上。要验证待对账→已知成本只补平台费用，绝不二次扣客户余额；继续保留回执幂等。
5. 文本必须仍用真实有效token结算，不能因为拿到成本回执就接受缺失token。组合视频固定报价需要与持久化任务快照一致。
6. `credits.js`尚有原来的 `DEBUGSETTLE`日志，发布前清理，勿输出整段账务/请求证据。
7. 新模块里把OpenLux文本映射到360相应产品档位是**实现草案**，不是“360出售相同模型”的事实；视频default也不能盲目覆盖所有旧视频/数字人模型。逐项明确适用模型、时长和分辨率，不能用统一价格掩盖未定价模型。

草案配置字段如下，**不可照抄填入估计价格启用**：

```js
{
  enabled: true,
  imageBenchmarkCny: /* 核实并确定后的每张基准 */,
  imagePriceBasis: "可追溯报价或账单依据",
  imageReferenceProvider: "360" // 草案亦允许openlux，尚未获准当360替代依据
}
```

### 图片费用核实到什么程度

| 项目 | 已知事实与边界 |
| --- | --- |
| 旧360图片2元/张 | `provider-360-cost.js`中的**预占估算**，不是已核实单价；尚未从旧常量中移除 |
| 临时售价4元/张 | 未获用户确认；用户提出太贵，不得启用 |
| 360官方图片文档 | 明确Image2模型和medium示例，但本轮未找到可核实的图片报价；模型广场也没有提供Image2可用报价结果 |
| OpenLux只读核查 | status、个人最近日志、pricing均HTTP200；仅返回最近10条日志，其中没有图片扣费条目，因此没有核实出“这张图片实扣几毛” |
| OpenLux公开Image2行 | `gpt-image-2`按token，model_ratio=2.5、completion_ratio=6、image_ratio=1.6；单次费用还受token、图片参数、账号分组影响，不能直接称固定单张价 |
| 相近但不同模型 | `gpt-image-2-c`公开0.12美元/次，**它不是指定的gpt-image-2**，不能偷换模型或拿它当360报价 |
| medium参数 | OpenLux当前 `generateImage()`未显式传quality，可能使用供应商默认档。已发现并提出改为medium，但**尚未落盘**；应先统一参数再做实扣对照 |

只读证据见附件 `证据/image-price-evidence.json`。它是OpenLux证据，不能包装成360价格。**目前图片最终售价仍未确定。**

## 5. 已跑测试与没有跑的测试

| 测试 | 本轮结果 | 限制 |
| --- | --- | --- |
| 新双供应商隔离测试 | 7/7通过 | 模拟HTTP，验证两企业并发、请求冻结、分家Key、历史查询与不串Key |
| 双供应商相关组合回归 | 71项中70过、1失败 | 失败为XHS旧测试自定义base与固定OpenLux origin冲突；后调整相关测试，不能称原71项全绿 |
| XHS后续回归 | 16/16通过 | 仅该组复跑通过；不是最新全部代码统一复验 |
| 测试员三组回归 | 33/33通过 | 隔离SQLite、模拟HTTP，含真实chat函数配模拟回执；不是真实供应商生成 |
| 平台/企业UI契约 | 3项通过；定向ESLint、TypeScript通过 | 管理后端尚未实现 |
| 测试员UI最新契约 | **8/9通过、1失败** | 旧provider回退表达式改后测试正则未同步；最后修改后typecheck未重跑 |
| 新统一计费草案 | **未测试完成** | `settleHold`仍未接完，严禁声称计费验收通过 |
| 恢复OpenLux后真实文本/图片/视频 | **尚未开始** | 本轮零付费生成，零已提交视频任务，无正在跑的实测任务 |
| 发布/线上验收 | **未做** | 线上仍旧版本 |

日志有重叠，不能把各组数量相加当独立总覆盖。附件同时保留失败和随后相关复跑的日志，不隐藏失败。

建议接手后用隔离环境执行（先检查各测试自建DB，不加载生产env）：

```bash
env NODE_ENV=test NANOWORK_TEST_TEMPLATE_AI=1 NANOWORK_DB=:memory: \
  ENABLE_SCHEDULER=false ENABLE_BACKGROUND_EMBEDDINGS=false \
  AI360_API_KEY= OPENLUX_API_KEY= YUNWU_API_KEY= ANTHROPIC_API_KEY= \
  OPENAI_API_KEY= MINIMAX_API_KEY= NANOWORK_AI_PROVIDER= \
  node --test --no-warnings --test-concurrency=1 \
  server/test/dual-provider-selection.test.mjs \
  server/test/tester-dual-provider.test.mjs \
  server/test/tester-trials.test.mjs \
  server/test/tester-analytics.test.mjs
```

统一账务至少补：同业务两供应商售价相同、实际成本高低不改变用户价、旧快照不变、预占差额退回、无成果全退、回执晚到只记成本、重复结算/退款不重复动账、余额及账本恒等、15/30秒组合任务、文本缺token不乱扣、测试员不扣平台余额。完成后再跑相关现有账务回归和前后端整体验证。

## 6. 接手执行顺序

1. **保全工作区和数据。** 阅读本文、原完整交接，检查最新Git状态和本地改动；不要重写其他人的功能。
2. **接完管理后台API。** 实现第3节契约，验证平台/企业/测试员权限和两家Key隔离；前端与后端一起验收。
3. **核实图片参数与实扣。** 同一个指定模型、medium、明确尺寸、一次生成、记录网关request ID和该条账单；无有效价格前不要启用统一图片价。
4. **接完统一结算。** 修正 `settleHold`与恢复/对账，审查所有调用路径和旧hold；将售价、采购成本、预占分开。
5. **迁移配置与测试员schema。** 单独恢复OpenLux Key并保留360；显式设置平台默认openlux；不要恢复整份旧env或旧DB。迁移前备份DB/WAL及配置，保留加密secret。
6. **真实验收。** OpenLux文本、Image2、Wan2.6原生有声15秒各一次；360文本一次证明可选；图像编辑/历史查询与切换过程中任务恢复也验证。只重查已提交视频，不重复付费提交。
7. **最后发布。** 新版Web构建、部署脚本预检、原子切换及健康检查；验证线上默认、选择保存、个人Key、历史任务、价格/退款及图片产物。没有这些证据不能写“完成”。

当前原生视频要求仍是15秒默认、30秒可选、使用模型自己的中文音轨，不额外叠加TTS。360 Image2历史仍HTTP400/1001，不能把它描述为已跑通或已证明账号没有权限。

## 7. 部署和回滚提醒

现有工具在 `ops/deploy/`：`deploy.sh`、`rollback.sh`、环境示例和备份脚本。源包与Web dist分别打包；环境变量、数据库、私钥、node_modules和测试媒体不进入源码包。

SSH使用原已授权配置：

```bash
ssh -i /Users/wanglei/.ssh/namiwork-hk-20260906 \
  -o IdentitiesOnly=yes -o BatchMode=yes root@8.210.177.200
```

本轮没有创建新生产备份。上次完整交接记录的备份是 `/var/backups/nanowork/20260907123350-pre-deploy-20260907123347`，仅作历史参考，接手部署前须重新备份并验证。

不要启用调度和H3作为顺带修改。不要倒回旧整库以解决Key兼容问题。测试员密文迁移和旧版本回滚的兼容方案必须一起准备。

## 8. 文件和证据位置

- 当前源代码：`/Users/wanglei/Documents/纳米work企业版本`。
- 本文仓库副本：`docs/team/2026-09-07-dual-provider-handoff.md`。
- 原完整交接：`/Users/wanglei/Desktop/纳米Work-技术交接-2026-09-07/打开交接文档.html`。
- 本轮附件：工作区状态清单、关键文件清单及SHA256、各组测试原日志、OpenLux只读价格证据。
- 本轮真实付费实测目录尚未创建，**没有可交付的新图片/视频**；不要引用原9月5日/6日媒体冒充本轮测试结果。

本交接包不含API Key、SSH私钥、环境文件、数据库或完整源码。接手者使用现有工作区继续；如果换到另一台机器，另行通过受控方式交付当前完整源码和私有部署配置，不能只拉Git HEAD。

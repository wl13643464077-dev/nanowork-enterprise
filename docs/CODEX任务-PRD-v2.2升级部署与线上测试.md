# Codex 任务：PRD v2.2 升级——本地验证、部署演示环境、线上测试

> 交给 Codex 执行。代码已由 Claude 写入本仓库工作区（未 git 提交）。Codex 负责：复核、跑测试、提交、按 `ops/deploy/deploy.sh` 发布到演示环境，并按第 5 节做线上测试，最后按第 7 节格式回报。
> 需求依据：`docs/PRD-2026-11-20-餐饮专版数字员工升级v2.2.md`；Claude 侧测试报告见对话里的「实操测试报告」。

## 0. 硬约束（违反任何一条立即停止并回报）

1. **不得修改** `server/catalog/employee-skills.json` 及任何原有员工技能卡/手册（只允许追加的补充卡在 `server/catalog/employee-skills-supplement.json`）。`npm test` 里的 `employee-skills-verification` 会校验它。
2. 不读取、不打印、不提交任何 `.env` / `/etc/nanowork/server.env` 的密钥内容；新增环境变量只写进 `ops/deploy/server.env.production.example` 说明。
3. 不做任何美团/点评 App 端接口调用或抓取（合规红线）。
4. 部署前必须有 `deploy.sh` 自带的 pre-deploy 备份；线上测试失败按第 6 节回滚。
5. 按 `ops/README.md`：这是**演示环境**发布，不得对外宣称“云端正式上线”。

## 1. 本次改动文件清单

**新增（server）**
- `src/engines/employee-intent-router.js` 判题（快查/诊断/方案/产物/完整报告）
- `src/engines/employee-answer-shapes.js` 答题形态 + 反公式化审计
- `src/engines/employee-skill-supplement.js`、`src/engines/employee-question-templates.js`
- `src/engines/employee-store-data-pack.js` 自有数据包
- `src/engines/employee-dispatch-followups.js` 我的版本 / 追问 / 派单闭环 / 固定要求
- `src/engines/market-scan-research.js` 行情快查多角度检索、覆盖度、A/B/C 来源档位、人均回填
- `src/engines/amap-alerts.js` 高德凭证/配额告警
- `src/engines/report-assumptions.js` 假设面板
- `src/engines/feedback-preference-suggest.js` 反馈学习
- `src/engines/employee-demo-scripts.js` 演示话术与样例
- `catalog/employee-skills-supplement.json`、`catalog/employee-question-templates.json`
- `scripts/amap-selfcheck.mjs`
- 测试：`test/employee-intent-router`、`employee-answer-shapes`、`employee-skill-supplement`、`employee-store-data-pack`、`amap-selfcheck-and-market-scan`、`employee-dispatch-followups`、`market-scan-research`、`round5-amap-assumptions-feedback`、`employee-demo-scripts`（均 `.test.mjs`）

**修改（server）**
`src/db.js`（新表 `employee_skill_supplement_reviews`、`employee_demo_samples`，`agent_tasks.intent_json` 列）、`src/employee-workbench.js`、`src/routes/employee-workbench.js`、`src/routes/marshals.js`、`src/routes/admin.js`、`src/engines/ai.js`、`src/engines/amap.js`、`src/engines/location-intelligence.js`、`src/engines/public-source-quality.js`、`src/engines/report-refine.js`、`src/engines/task-center.js`、`src/index.js`、`test/trade-area-facts.test.mjs`

**新增/修改（web）**
新增 `src/components/RestaurantDispatchAssist.tsx(.css)`、`EmployeeSkillSupplement.tsx`、`RestaurantDemoPanel.tsx`；修改 `EmployeeWorkbench.tsx/.css`、`ReportRefinePanel.tsx/.css`、`ConversationTaskFeedback.tsx`、`AdminAmapPanel.tsx`、`mobile/MobileDispatch.tsx`、`pages/Employees.tsx/.css`、`api/employeeWorkbenchTypes.ts`

**新增环境变量（均可选，有默认值）**：`AMAP_QPS`（默认 3）、`AMAP_DAILY_QUOTA`（默认 5000）、`AMAP_TASK_REQUEST_BUDGET`（默认 25）。

## 2. 本地复核

```bash
git status && git diff --stat
git diff -- server/catalog/employee-skills.json   # 必须为空
```
重点读一遍：`server/src/routes/marshals.js` 的 `followupAnswers` / `handoffs` / `intent` 改动，`server/src/engines/ai.js` 的 `locationBusinessWebSearch` 与 `marketScanCoverage`。

## 3. 本地测试（必须全绿才能继续）

```bash
cd server && npm test
cd ../web && npm ci && npm run build      # 含 tsc 类型检查
cd .. && npm run verify                    # 发布门禁（若根目录有该脚本）
```
- Claude 侧未能运行、需重点关注的 9 个文件：`employee-workbench`、`paihuo-dispatch-markdown`、`employee-team-match`、`employee-skill-learning-runtime-contract`、`location-intelligence`、`location-isochrone-gate`、`store-data`、`content-store-facts`、`admin-amap-test`。
- 任一失败：先判断是否本次改动引起；是则修复（不得改动第 0 节受保护文件），修复内容写进回报。
- 前端类型错误：Claude 只做了语法转译检查，类型问题由你修。

## 4. 提交与部署

```bash
git checkout -b iteration/2026-11-prd-v2.2
git add -A && git commit -m "feat(restaurant): PRD v2.2 判题/追问/行情快查/假设重算/演示模式"
git push origin iteration/2026-11-prd-v2.2
# 演示机（root）：
bash ops/deploy/deploy.sh --source <git 地址> --ref iteration/2026-11-prd-v2.2
```
确认：迁移成功（新表自动建）、`/api/health` 200、就绪矩阵里 `amap` 通道正常。随后在演示机执行：
```bash
cd /opt/nanowork/current/server && node scripts/amap-selfcheck.mjs   # 3 步全过
```

## 5. 线上测试（用老板账号在演示租户里真实派单）

先在员工页「演示模式 → 我的版本」填：店名 罗二火锅 / 城市 北京 / 商圈 望京 / 品类 火锅 / 人均 95元。

| # | 员工 | 派活原话 | 通过标准 |
| --- | --- | --- | --- |
| T1 | 钱商圈(102) | 北京望京商圈餐饮的客单价是什么范围，有哪些代表的店，再具体看下火锅及火锅相似竞品 | 状态行显示“判题：快查”；正文有价格分档表（≥3 档）+ 店铺清单；店铺 ≥15 家，或第一段如实写“本次只找到 N 家，原因…”；数字/店名后有(参考)/(推测)标注；不出现大面积“待核验” |
| T2 | 钱商圈(102) | 广东菜 太原吾悦广场 我要看看周围有没有竞争对手 对手啥情况 | 判题快查；至少列出真实竞品店名（对比 2026-08-01 旧交付 0 家） |
| T3 | 店小满(160) | 帮我策划一下下周末的家庭套餐活动怎么做 | 派活前出现 ≤3 个追问（含默认值、可跳过）；交付有预算拆分、执行清单、“## 可改的假设”表格；结果下方出现“派给XX”按钮且点击能打开对方并预填任务书 |
| T4 | 同 T3 结果 | 报告优化面板把“活动预算”改小后点“按新假设重算” | 60 秒内生成新版本；只改受影响数字；原稿保留 |
| T5 | 王菜单(108) | 帮我精简一下菜单，重做价格梯度和套餐 | 判题“产物”；直接给可复制的菜单/套餐表，说明 ≤3 行 |
| T6 | 葛会员(144) | 帮我重做会员分层和沉睡顾客唤回方案 | 判题“方案”（旧版会判诊断） |
| T7 | 任一 | 连续两单在“不采纳”原因里写“太长了” | 第二次弹出“要不要存为默认设置？”，确认后下一单提示词带上固定要求 |
| T8 | 演示模式 | 任选一条“现在实跑”→结果页“存为演示样例”→回演示模式“看样例” | 样例标“样例 · 日期 实跑结果（非本次实时生成）” |
| T9 | 手机端 | 手机派活页 | 常用问法、题型预判、追问正常显示并能派单 |
| T10 | 后台 | 高德面板“立即自检” | 3 步通过；用量、最近错误显示正常 |

每单记录：任务号、判题标签、耗时、正文字数、店铺数、是否达标；T1/T2/T3/T5/T6 导出正文 Markdown。

**升级前后对照**：旧交付在 `server/data/nanowork-real-final-2026-07-31-v1.db`（任务 #50）与 `server/data/nanowork-l5-realtest-2026-07-31.db`（任务 #85 #84 #32 #68 #61），把同题新旧正文放进 `docs/升级前后对照-2026-11.md`，列：字数、标题数、“待核验”次数、店名数、有无可改假设/派单建议。

## 6. 回滚条件

出现以下任一情况立即 `bash ops/deploy/rollback.sh --with-backup` 并回报：服务起不来或 `/api/health` 非 200；T1/T3 派单报错；任何租户串数据；核心技能文件被改动。

## 7. 回报格式（写入 `docs/部署与线上测试回报-2026-11.md`）

1. 提交号、分支、部署 release 时间戳
2. `npm test` / `npm run build` / `verify` 结果（失败项与修复）
3. T1–T10 逐条：通过/不通过 + 证据（任务号、截图或正文片段）
4. 升级前后对照表
5. 发现的问题与建议（按严重度排序）

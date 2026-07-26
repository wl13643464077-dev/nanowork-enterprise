# 当前状态

状态日期：2026-07-26（v3）

## 已完成

- Skill 已安装并可通过 `$commercial-self-intro` 触发。
- 书中技术库完整覆盖 64/64：
  - `F01-F17`
  - `D01-D24`
  - `E01-E11`
  - `L01-L12`
- 已建立内容 LOOP、增长 LOOP、Truth Ledger、场景剧本和输出评分合同。
- 已有字数/时长检查、原书检索和技术覆盖验证脚本。
- 已完成斯文商业介绍长图的 HTML 源码、素材、渲染脚本和 PNG 成品。
- 已有 Windows、macOS/Linux 便携安装包。

## 当前主源码

`01-skill/commercial-self-intro`

后续升级应先修改这一份，再同步到本机安装目录和新的发布包，避免多份源码同时漂移。

## 已知边界

- 飞书业务介绍保留的是来源链接，离线包没有承诺包含页面最新快照。
- 原书 PDF 和商业认知资料属于私有开发依据，不应进入公开发行包。
- 长图设计元数据中的状态来自原设计工具；最终验收仍应以实际 PNG、二维码和视觉检查为准。
- 平台规则、广告合规和 Skill 官方规范会变化，涉及“最新”时必须重新核对官方来源。

## v2 已完成（2026-07-26）

- 人格层重构：`04-private-sources/business-cognition/wanglei-persona-spec-v2.md` 取代 `user-style-and-business-os.md` 作为 AI我 主入口。五层结构：L0稳定身份 / L1判断操作系统 / L2语言包 / L3本人证据账本 / L4易变上下文（带失效日期），附使用协议与人格漂移检查。
- 新增可公开模板：`references/persona-spec-template.md`，任何人可按此被提炼为AI分身；长图等视觉资产的数据源指向人格规格字段，为斯文案例模板化铺路。
- 完成原路线图第1项：`references/intake-questionnaire.md`（最小两问 + 增强十二问 + 缺证优先级算法，含具体取证动作）。
- 完成原路线图第3、4项：`references/structured-output-spec.md`（intro-package.json、iteration-log.jsonl、persona-spec.json），单变量纪律在数据层强制。
- SKILL.md 已按任务接入以上三个新参考文件；`validate_book_coverage.py` 通过，64/64 覆盖不变，cross_reference_files=14。

## v3 已完成（2026-07-26）

- 项目落地到公开 Git 仓库（`projects/commercial-self-intro/`），私有边界成文：`04-private-sources` 私有文件不入公开库，`PRIVATE-FILES.md` 记录清单与 SHA256；`verify_project.py` 支持 `private_sources=absent` 的公开检出模式。
- 完成上轮优先级第3项：五场景黄金样例（抖音/视频号/私域/商务饭局/嘉宾介绍，虚构演示人物张敏）+ `scripts/validate_golden_samples.py` 回归验证（结构、账本数字背书、技术卡配额与页码同步、时长带、禁用词、单变量A/B），负样例注入实测可拦截。
- 完成上轮优先级第4项：斯文长图改为数据模板。`persona-data.json`（字段映射 persona-spec 五层）+ `Swen-Commercial-Profile-Long-Image.template.html` + `build_long_image.py`，构建产物与原 HTML 逐字节一致（`--check` 可复验）。管线文档见 `02-design/.../README-数据模板.md`。
- 在 Linux（Chromium + Noto Sans CJK）重渲染 `Swen-Commercial-Profile-Long-Image-20260726-v2.png`（1080×7733，与 Windows 原版差 3px 为字体度量差异），二维码解码通过且指向预期链接；`03-deliverables` 原成品未覆盖。
- 完成上轮优先级第5项：`user-style-and-business-os.md` 已归档（本地包内移至 `business-cognition/archive/`，加归档头）。
- 上轮优先级第1项的工具准备：制作 `persona-drift-check-v1.md`（10题标准卷+处置规则）与 `persona-spec.json`（v2 机器可读导出），均为私有文件，随会话交付本人，不入公开库。
- 修正 `example.md` 漂移：原推荐版 VX-15-V1 实测估算 20.6 秒（超出 15 秒目标带），已改为在带内的 17.9 秒稿，并与黄金样例保持同步。

## 下一轮优先级建议

1. 本人执行 `persona-drift-check-v1.md`：先亲自作答10题存档，再跑新旧版本对比，差异回填 L1/L2（工具已备好，缺的是本人真实作答）。
2. 补齐 L3 证据账本补证优先级前三项（可公开案例授权、活动证明物、产品交付截图）——只能由本人收集，不可代产。
3. 用真实发布数据开始填写 iteration-log.jsonl（黄金样例只保证结构，真实指标需要投放）。
4. 把王磊本人的长图用模板管线生成：从 persona-spec.json 公开投影出一份新的 persona-data.json，替换照片与二维码。
5. 便携包在新设备实测安装一次（`install.ps1` / `install.sh`），记录反馈。


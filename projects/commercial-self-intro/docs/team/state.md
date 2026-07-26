# 项目状态（dev-team 标准通道 · 自动模式）

更新：2026-07-26 ｜ 版本：2026.07.26-full-v3 ｜ 分支：claude/project-completion-okd19m

## 当前阶段

v3 落地轮已完成并验证。项目从私有开发包落地为公开仓库工程（`projects/commercial-self-intro/`），
上一轮 CURRENT-STATE 的可执行优先级（第3、4、5项）全部完成，第1、2项完成工具准备但需要本人真实输入。

## 本轮产物索引

| 产物 | 位置 |
|---|---|
| 五场景黄金样例 + 回归验证 | `01-skill/commercial-self-intro/references/golden-samples/`、`scripts/validate_golden_samples.py` |
| 长图数据模板管线 | `02-design/swen-commercial-profile-long-image/`：`persona-data.json`、`*.template.html`、`build_long_image.py`、`README-数据模板.md` |
| Linux 重渲染成品 | `02-design/swen-commercial-profile-long-image/Swen-Commercial-Profile-Long-Image-20260726-v2.png`（1080×7733，QR 解码 PASS） |
| 便携发布包 v4 | `05-portable-release/commercial-self-intro-portable-20260726-v4{,.zip,.zip.sha256.txt}` |
| 私有边界 | `.gitignore`、`04-private-sources/PRIVATE-FILES.md`、`tools/verify_project.py` 的 `private_sources=absent` 模式 |
| 私有产物（不入库，随会话交付） | `persona-spec.json`、`persona-drift-check-v1.md`、归档版 `user-style-and-business-os.md` |
| 决策日志 | `docs/team/04-decisions.md` |
| 验证记录 | `06-validation/VALIDATION-RESULTS.txt`（追加 v3 段） |

## 跳过与不可代产项（如实披露）

- 人格漂移检查的**真实执行**与 L3 补证前三项：需要本人作答/收集证据，AI 代产即造假，只交付了工具与流程。
- `quick_validate.py`（Codex skill-creator）与 `install.ps1` 的 PowerShell 解析检查：本环境无 Codex skill-creator 与 pwsh，未运行。
- `03-deliverables` 原成品未替换：Linux 渲染字体与原 Windows 不同（高度差 3px），替换正式成品需本人视觉验收。

## 下一步

见 `00-project-docs/CURRENT-STATE.md` 的"下一轮优先级建议"。新会话接手：先读本文件与 CURRENT-STATE，再跑
`python -X utf8 tools/verify_project.py` 确认基线。

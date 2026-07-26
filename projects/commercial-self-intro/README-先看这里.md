# 商业级自我介绍项目完整开发包

这不是单纯的 Skill 安装包，而是用于继续升级、测试、出图和发布的私有项目包。

## 先做三件事

1. 在项目根目录运行完整性校验：

   ```powershell
   python -X utf8 .\tools\verify_project.py
   ```

2. 阅读以下文件：

   - `00-project-docs/PROJECT-BRIEF.md`
   - `00-project-docs/CURRENT-STATE.md`
   - `00-project-docs/UPGRADE-HANDOFF-PROMPT.md`
   - `01-skill/commercial-self-intro/SKILL.md`
   - `01-skill/commercial-self-intro/references/book-technique-index.md`

3. 在另一台设备安装当前 Skill：

   ```powershell
   cd .\05-portable-release\commercial-self-intro-portable-20260710-v3
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

   安装后新建一个 Codex 任务，输入：

   ```text
   $commercial-self-intro
   ```

## 项目结构

- `00-project-docs`：项目目标、当前状态、升级提示词与验收清单。
- `01-skill`：当前可编辑的 Skill 主源码，是后续能力升级的核心。
- `02-design`：斯文商业介绍长图的 HTML、渲染脚本、图片素材和设计成品。
- `03-deliverables`：可直接发送或发布的最终长图。
- `04-private-sources`：原书 PDF 和用户商业认知资料，仅限本人私用。
- `05-portable-release`：已经验证过的跨设备安装包及历史版本。
- `06-validation`：本次打包与验证记录。
- `tools`：整包完整性校验工具。

## 升级时不能丢的能力

- 保持《自我介绍的技术》四阶段、64 项技术完整覆盖：`F17 + D24 + E11 + L12`。
- 保持双 LOOP：
  - 内容 LOOP：Listener / Outcome / Ownable Proof / Prompt Next Step。
  - 增长 LOOP：Launch / Observe / Optimize / Preserve。
- 保持 Truth Ledger：已验证、用户陈述、愿景、缺失信息分开处理。
- 不把所有场景缩成同一段文案；抖音、视频号、私域、商务饭局、嘉宾介绍要分别生成。
- 不虚构客户、结果、头衔、数据、媒体、奖项或合作关系。
- 保持版本号、真实使用反馈和单变量迭代记录。

## 开发与验证

编辑 `01-skill/commercial-self-intro` 后，至少运行：

```powershell
python -X utf8 .\01-skill\commercial-self-intro\scripts\validate_book_coverage.py
python -X utf8 .\01-skill\commercial-self-intro\scripts\validate_golden_samples.py
python -X utf8 .\tools\verify_project.py --skip-manifest
```

五场景黄金样例与回归规则见 `01-skill/commercial-self-intro/references/golden-samples/README.md`。

> 公开仓库检出说明：本项目落地在公开 Git 仓库时不含 `04-private-sources` 私有文件
> （原书 PDF、人格规格等），校验工具会输出 `private_sources=absent` 并跳过原书相关检查。
> 私有文件清单与恢复校验值见 `04-private-sources/PRIVATE-FILES.md`。

如本机有 Codex 的 `skill-creator`，再运行：

```powershell
python -X utf8 "$HOME\.codex\skills\.system\skill-creator\scripts\quick_validate.py" `
  .\01-skill\commercial-self-intro
```

## 长图重渲染

自 2026-07-26 起，长图 HTML 由数据模板生成：文案在 `persona-data.json`，改完运行
`python -X utf8 build_long_image.py` 重建，再渲染。完整管线见
`02-design/swen-commercial-profile-long-image/README-数据模板.md`。

`02-design/swen-commercial-profile-long-image` 中保留了完整 HTML、素材和渲染脚本。脚本依赖 Node.js、Playwright 和本机 Chrome：

```powershell
cd .\02-design\swen-commercial-profile-long-image
python -m http.server 4311
```

另开一个终端：

```powershell
cd .\02-design\swen-commercial-profile-long-image
npm install playwright
node .\render-long-image.cjs `
  "http://127.0.0.1:4311/Swen-Commercial-Profile-Long-Image.html" `
  ".\Swen-Commercial-Profile-Long-Image-new.png"
```

每次升级请输出新文件名，不覆盖旧成品。

二维码复验（需要 Playwright 和 Chrome）：

```powershell
node .\tools\verify_qr.cjs
```

## 私有资料边界

本项目包包含用户本人提供的原书 PDF 和个人商业认知资料，目的是跨设备继续开发。它们不属于可公开分发的 Skill 运行包。对外分享时，只发送 `05-portable-release` 中的便携包，并再次检查其中不含私有资料。

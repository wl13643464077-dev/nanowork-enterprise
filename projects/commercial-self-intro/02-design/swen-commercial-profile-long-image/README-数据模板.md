# 长图数据模板管线（2026-07-26 起）

自本版本起，`Swen-Commercial-Profile-Long-Image.html` 是**生成产物**，不要手改。
文案与结构数据在 `persona-data.json`（字段与 persona-spec 五层结构的映射见其
`source_mapping`；数字类主张的账本等级见 `truth_notes`）。

## 修改与重建

```bash
# 1. 改 persona-data.json
# 2. 重建 HTML
python -X utf8 build_long_image.py
# 3. 确认 HTML 与数据同步（CI/回归可用）
python -X utf8 build_long_image.py --check
```

版式（CSS、栅格、留白）在 `Swen-Commercial-Profile-Long-Image.template.html` 中修改。

## 渲染 PNG

Windows（本机 Chrome）：

```powershell
python -m http.server 4311
node .\render-long-image.cjs "http://127.0.0.1:4311/Swen-Commercial-Profile-Long-Image.html" ".\Swen-Commercial-Profile-Long-Image-<日期>-<版本>.png"
```

Linux/macOS 用 `CHROME_PATH` 指定浏览器二进制。每次升级输出新文件名，不覆盖旧成品。

## 渲染环境差异记录

- 2026-07-26 在 Linux（Chromium 1194 + Noto Sans CJK）渲染 `Swen-Commercial-Profile-Long-Image-20260726-v2.png`：1080×7733，比原 Windows 渲染（PingFang/微软雅黑，1080×7736）矮 3px，为字体度量差异，视觉检查无溢出、无断字、二维码解码通过。
- `03-deliverables` 中的正式成品仍是 1080×7736 原版；跨字体环境重渲后若要替代成品，需重新走视觉验收。

## 为任何人生成长图（模板化路径）

1. 按 `01-skill/commercial-self-intro/references/persona-spec-template.md` 建立人格规格。
2. 按 `structured-output-spec.md` 导出 persona-spec.json，把对外可公开字段填入一份新的 `persona-data.json`（账本等级 B 级以上、完成公开前动作的主张才能进入 metrics/credentials）。
3. 替换 `assets/` 中的真实照片与二维码，重建并渲染。

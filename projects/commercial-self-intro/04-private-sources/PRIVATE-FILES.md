# 私有文件占位说明（公开仓库检出）

本仓库是公开仓库。按照 `README-私有资料与版权.md` 的边界，以下私有文件**不入库**，
仅存在于本人设备上的完整开发包中。跨设备恢复时，把它们放回本目录并用下方 SHA256 校验。

## 应存在于本目录的私有文件（本地）

| 路径 | SHA256 | 说明 |
|---|---|---|
| `book/自我介绍的技术（【日】横川裕之，台海出版社，2023年02月）.pdf` | `91A7055C1D86B5C0642C5D2A4AFED2EBD7F816F5188F748A22BE031225331968` | 原书，版权物，仅限本人检索定位 |
| `business-cognition/wanglei-persona-spec-v2.md` | `9E1531675B465DD7340055AC5EECC8E7F5491DF14B689F7D433AC094E261BF03` | AI我 人格规格 v2 主入口 |
| `business-cognition/GAIC_演讲稿.md` | `9401FB7AC29380B3DAB65F85AD43B3E5D7334605421C0BB516B9BD1FE6505CD1` | 金句库来源 |
| `business-cognition/user-business-memory-extract.md` | `F1B2F7DC25C6D670DF9580F7DC76A51C3474390B887D39AC6FBC170DD1EBE10B` | 商业记忆抽取 |
| `business-cognition/archive/user-style-and-business-os.md` | `499C6CED4448C2E549EC54119A6B4913B6528DE8EF8BCD358B66AEA1CF52B7D0` | v1 旧入口，2026-07-26 起归档（原路径为 `business-cognition/` 根目录） |
| `business-cognition/persona-spec.json` | 见本地包 | v2 机器可读导出（2026-07-26 新增） |
| `business-cognition/persona-drift-check-v1.md` | 见本地包 | 10题人格漂移检查工具包（2026-07-26 新增） |

## 清单覆盖范围

`MANIFEST.sha256` 只覆盖公开树，`04-private-sources/` 整目录在清单之外——
本地补回私有文件不会导致 `verify_project.py` 清单校验失败；私有文件的完整性用本文件的 SHA256 单独核对。

## 缺失私有文件时的行为

- `tools/verify_project.py` 检测到本目录无私有文件时输出 `private_sources=absent` 并跳过原书相关检查，其余检查照常执行。
- `scripts/search_self_intro_book.py` 无 PDF 时按 SKILL.md 约定回退到 64 项技术索引，不阻塞任务。

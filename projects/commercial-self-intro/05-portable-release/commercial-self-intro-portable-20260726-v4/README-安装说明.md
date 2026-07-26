# 商业自我介绍 Skill 便携包

版本：`2026.07.26-v4`

这个包用于把 `commercial-self-intro` 安装到另一台 Windows、macOS 或 Linux 设备。它包含完整的四阶段、64项方法库、双LOOP工作流、多场景路由、时长检查和PDF检索工具。

## 包内结构

```text
commercial-self-intro-portable-20260726-v4/
├─ commercial-self-intro/   # 可直接安装的Skill
├─ install.ps1              # Windows安装器
├─ install.sh               # macOS/Linux安装器
├─ verify_package.py        # 跨平台完整性校验
├─ MANIFEST.sha256          # 文件校验清单
├─ NOTICE.md                # 来源、版权与使用边界
├─ PACKAGE_INFO.json        # 包信息
└─ VERSION.txt
```

## Windows一键安装

在解压后的包目录打开PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

默认安装到：

```text
C:\Users\你的用户名\.agents\skills\commercial-self-intro
```

目标位置已经存在旧版本时，安装器默认停止。确认升级时使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Replace
```

旧版本会被改名备份，不会直接删除。需要指定其他技能目录时：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DestinationRoot "D:\CodexSkills"
```

## macOS/Linux一键安装

```bash
bash ./install.sh
```

默认安装到：

```text
~/.agents/skills/commercial-self-intro
```

升级已有版本：

```bash
bash ./install.sh --replace
```

指定其他目录：

```bash
bash ./install.sh --destination "$HOME/.codex/skills"
```

## 手动安装

把整个 `commercial-self-intro` 文件夹复制到：

```text
~/.agents/skills/commercial-self-intro
```

不要只复制 `SKILL.md`，`references/`、`scripts/`、`agents/` 和 `requirements-optional.txt` 都需要保留。

安装后建议重启Codex或新建一个任务，确保新版Skill被发现。

## 使用方法

新任务中直接输入：

```text
$commercial-self-intro

简介：我的经历、业务、能力、案例或零散想法
用途：抖音置顶 / 视频号 / 商务饭局 / 私域 / 嘉宾介绍 / 个人长图
```

也可以自然语言调用：

```text
请用商业自我介绍Skill，把这段经历改成30秒商务介绍，并给出真实使用后的迭代方案。
```

## 原书PDF说明

便携包不包含《自我介绍的技术》原书PDF。完整64项方法已经写入Skill，日常生成不依赖PDF。

只有在需要检索原文或补充页码证据时，才需要本人合法持有的PDF和可选依赖：

```bash
python -m pip install -r commercial-self-intro/requirements-optional.txt
```

任选一种方式配置PDF：

1. 运行脚本时传入 `--pdf "/path/to/book.pdf"`。
2. 设置环境变量 `SELF_INTRO_BOOK_PDF`。
3. 将自有PDF复制为 `commercial-self-intro/references/source-book.pdf`。

Windows当前用户环境变量示例：

```powershell
[Environment]::SetEnvironmentVariable("SELF_INTRO_BOOK_PDF", "D:\Books\自我介绍的技术.pdf", "User")
```

macOS/Linux当前终端示例：

```bash
export SELF_INTRO_BOOK_PDF="$HOME/Documents/自我介绍的技术.pdf"
```

## 手动校验

校验整个便携包：

```bash
python verify_package.py
```

校验64项技术覆盖：

```bash
python commercial-self-intro/scripts/validate_book_coverage.py
```

成功时应看到：

```text
book_technique_coverage=64/64
result=PASS
```

## 重要边界

- 所有客户、结果、数字、平台身份和机构关系都应在公开使用前核验。
- 不把愿景、试点或相关经历写成已经取得的商业结果。
- 平台规则、字符限制和广告合规会变化，涉及“最新”时应重新查验官方来源。
- 商用、转发和二次分发前请阅读 `NOTICE.md`。

# 黄金样例与回归测试

五个核心场景各一份 `intro-package.json`（格式见 `../structured-output-spec.md`），
人物为**虚构演示人物张敏**（与 `../example.md` 同一演示设定），只用于结构与纪律回归，
不用于展示真实用户。

| 文件 | 场景 | 版本前缀 |
|---|---|---|
| `DY-douyin-pinned.json` | 抖音置顶 | `DY-` |
| `VX-shipinhao-pinned.json` | 视频号置顶 | `VX-` |
| `SQ-siyu-welcome.json` | 私域加好友欢迎语 | `SQ-` |
| `BIZ-fanju-18s.json` | 商务饭局18秒 | `BIZ-` |
| `JB-jiabin-host.json` | 嘉宾主持口播 | `JB-` |

## 运行回归

```bash
python -X utf8 ../../scripts/validate_golden_samples.py
```

校验内容：结构完整、账本等级纪律（文案数字必须有A/B级主张背书）、技术卡最小配额与
页码同步、单推荐版 + 单变量A/B、时长在目标带内且估算未过期、禁用绝对化用语、
内容LOOP齐全、评分≥85、补证清单恰好3项。

## 修改约定

- 升级 Skill 输出结构时，先改 `structured-output-spec.md`，再同步黄金样例，最后跑回归。
- 文案改动后必须用 `check_intro_length.py` 重算 `estimated_seconds`，回归会检查估算是否过期。
- 每个场景保持一份样例；新增场景先在 `validate_golden_samples.py` 的场景表登记。

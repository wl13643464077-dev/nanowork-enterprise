# 餐饮数字员工完整工作成品验收测试设计

更新时间：2026-07-31
范围：餐饮数字员工 101–160，共 60 岗、342 个目录交付物
当前阶段：测试先行；只新增独立测试和本说明，尚未改动运行中的 contract、AI、runner

## 1. 要解决的问题

当前 v1 契约能检查摘要、证据、动作和验收状态，却不能证明员工真的交付了表、图、卡、模型或记录的正文。典型反例是 103 号员工只写“已形成品牌承诺表”“已形成能力差距图”“已形成 8 项风险与 4 项实验卡，详见附件”，没有任何实际条目，现有核心校验仍返回 `valid: true`。

验收目标不是再加一段更长的说明，而是要求目录中的**每一个 deliverable 都携带可逐项审阅的实际工作成品**。

## 2. 已锁定的 v2 结构

与语义红队统一使用以下唯一结构，不引入 `source_refs`、`complete` 等第二套字段：

```json
{
  "work_product": {
    "artifact_type": "structured_table",
    "sections": [
      {
        "section_name": "品牌母题与承诺正文",
        "items": [
          {
            "label": "目标场景",
            "result": "工作日午晚餐面向周边办公人群，当前材料未支持家庭聚餐场景。",
            "evidence_ref": "E-103-1-R1",
            "status": "verified"
          },
          {
            "label": "顾客访谈缺口",
            "result": "当前缺少第二类目标客群的访谈原始记录，不能确认承诺覆盖范围。",
            "evidence_ref": "E-103-2-R1",
            "status": "gap"
          }
        ]
      }
    ]
  }
}
```

状态只允许：

- `verified`：来源能够支持的已核验正文；
- `assumption`：明确标识、尚待验证的假设正文；
- `gap`：具体说明缺什么、影响什么的缺口正文。

`artifact_type` 的具体枚举可在核心实现时按现有制品体系收口，但字段必须存在且非空。

## 3. 通用验收规则

| 编号  | 规则                                                                                         | 失败文案核心                          |
| ----- | -------------------------------------------------------------------------------------------- | ------------------------------------- |
| WP-01 | 101–160 每个目录 deliverable 必须有 `work_product` 对象                                      | `work_product正文少于2项`             |
| WP-02 | 所有 section 合计至少 2 个互异正文项，复制条目不计数                                         | `work_product正文少于2项`             |
| WP-03 | 每项必须有非空 `label/result/evidence_ref/status`，`result` 至少 12 字                       | `必须给出具体label和result正文`       |
| WP-04 | `evidence_ref` 必须回指本次 `decision_context.sources` 或该 deliverable 的 `evidence.source` | `evidence_ref未回指本次来源`          |
| WP-05 | 状态只能是 `verified/assumption/gap`                                                         | `status只能是verified/assumption/gap` |
| WP-06 | 每个 deliverable 至少有 1 项非元数据、非未来动作的 `verified` 实际结果                       | `所有正文项均为补材料或未来动作`      |
| WP-07 | “已形成/将形成/共 N 项/见附件/后续补充”不能代替正文                                          | `正文只声明制品存在而未交付内容`      |
| WP-08 | 正文的 label/result 必须覆盖目录交付物名称中的核心维度                                       | `未覆盖交付物核心维度`                |
| WP-09 | 60 岗 342 个交付物必须全量通过，不能只抽样首个 deliverable                                   | 聚合列出员工、字段路径和缺口          |

规则 WP-06 不要求所有未知事实伪装成已完成；它要求在诚实保留 `assumption/gap` 的同时，至少交付一项可核验的实际工作内容。全篇只有“补材料、后续收集、未来制作”的输出不能进入待审。

## 4. 103 专项红例

以下五类声明即使字数、动作、责任人和截止日期都满足旧契约，也不能算工作成品：

1. 已形成定位陈述、目标场景和非目标客群清单，共 3 项，详见附件；
2. 已形成品牌母题与产品/服务承诺表，共 3 项，详见附件；
3. 已形成概念一致性与能力差距图，共 3 项，详见附件；
4. 已形成风险假设清单及验证实验卡，共 8 项风险与 4 项实验，详见附件；
5. 已形成概念版本决策记录与下一步清单，共 3 项，详见附件。

通用门负责拒绝“只声明存在、没有正文”。103 的“8 项风险 + 4 项实验”逐项内容、字段和关联关系由并行语义红队的岗位专项规则继续收紧，本文件不复制第二套专项契约。

## 5. 测试文件与当前红绿证据

测试文件：`server/test/restaurant-output-work-product.test.mjs`

测试分两层：

- 测试预检器（已绿）：为 101–160 的 342 个交付物补入符合提案的实际正文后全部通过；全 gap/未来动作、错误来源回指、通用经营指标冒充岗位成品均被拒绝。
- 核心接入门（预期红）：当前核心仍接受 103 声明式空壳，且当前 342 个合法 fixture 全部缺少 `work_product`。

新鲜执行证据：

```text
node --test --no-warnings --test-name-pattern='提案验收器' server/test/restaurant-output-work-product.test.mjs
2 tests, 2 pass, 0 fail

node --test --no-warnings server/test/restaurant-output-work-product.test.mjs
4 tests, 2 pass, 2 fail
- 103 当前核心结果：true !== false（核心仍错误接受）
- 101–160 当前目录结果：342 !== 0（342 个 deliverable 均缺工作成品正文）
```

这两个红项是刻意保留的 TDD 核心接入门，不是测试代码自身失灵。

## 6. 批次结束后的核心接入顺序

1. 将餐饮输出 schema version 与 contract id 升到 v2，并在每个 deliverable 的严格 schema 中加入上述 `work_product`；
2. 同步 schema example、合法 fixture 和供应商 schema，确保真实模型被要求返回正文而不是声称附件存在；
3. 在运行时语义校验中落实 WP-01 至 WP-09，并把精确错误用于定向返工；
4. renderer 必须逐 section/item 展示正文、来源与状态，不能只渲染 summary；
5. 先运行本独立测试直到 4/4，再运行原餐饮契约专项和服务端全量回归；
6. 只有 60 岗、342 个交付物全绿后，才允许重跑真实 API，并重新进行人工审阅，旧的“可使用”结果不能沿用。

## 7. 本轮边界

- 未修改 `server/src/engines/restaurant-output-contract.js`、AI、runner、真实跑批脚本或正在使用的验证数据；
- 未触发任何真实 API、计费、发布或外部动作；
- 未修改旧项目 `/Users/wanglei/Documents/派活AI`；
- 当前红项必须等正在执行的真实批次结束、总指挥通知后再落核心。

# 结构化输出规范（JSON）

用途：当用户要求JSON、要接表单/网页/自动出图，或要求"可查询的迭代记录"时，按本规范输出。默认交付仍是`output-contract.md`的可读格式；JSON是附加或替代格式，由用户指定。

## intro-package.json（介绍资产包）

```json
{
  "meta": {
    "subject": "张敏",
    "package_version": "2026.07.26-v1",
    "generated_at": "2026-07-26",
    "skill_version": "commercial-self-intro"
  },
  "positioning": {
    "core_label": "把儿童营养变成每天能执行的一日三餐",
    "discarded_identities": ["资历很多的泛营养专家"],
    "listener": {"who": "没时间研究、担心孩子挑食的宝妈", "state": "刷视频号", "language": ["挑食", "一日三餐"]},
    "ideal_reaction": "私信孩子年龄和最困扰的一餐"
  },
  "truth_ledger": [
    {"claim": "8年母婴营养经验", "grade": "B", "action_before_public": "确认起算口径"},
    {"claim": "服务3000个家庭", "grade": "B", "action_before_public": "确认统计口径与授权"},
    {"claim": "具体前后案例", "grade": "D", "priority_score": 6, "evidence_action": "翻客户反馈截图并请求匿名授权"}
  ],
  "technique_card": [
    {"id": "D18", "page": "80-82", "why": "18秒三句结构", "effect": "决定主版本骨架"}
  ],
  "content_loop": {
    "listener": "…", "outcome": "…", "ownable_proof": "…", "prompt_next_step": "…"
  },
  "versions": [
    {
      "version_id": "VX-15-V1",
      "scenario": "视频号置顶",
      "role": "recommended",
      "copy": "…",
      "target_seconds": 15,
      "estimated_seconds": 14.2,
      "delivery_cues": ["第一句后停半拍", "重音在'今天三餐怎么做'"],
      "cta": "私信孩子年龄和最困扰的一餐",
      "ab_variable": null
    },
    {
      "version_id": "VX-15-V1B",
      "role": "alternative",
      "ab_variable": "opening",
      "copy": "…"
    }
  ],
  "compliance": {
    "risk_words_removed": ["改善体质"],
    "pending_verification": ["3000家庭统计口径"],
    "privacy_notes": ["联系方式未经同意不展示"]
  },
  "score": {"total": 87, "weakest_dimension": "证据可信度", "top_evidence_to_collect": ["…", "…", "…"]}
}
```

字段纪律：
- `truth_ledger.grade`只能是A/B/C/D；D级主张的文案字段禁止出现具体数字。
- 标注秒数的版本必须有`estimated_seconds`（来自`check_intro_length.py`）。
- `role`只能是`recommended`或`alternative`；alternative必须有`ab_variable`标明与主版本的唯一策略差异。

## iteration-log.jsonl（迭代记录，逐行追加）

对应`output-contract.md`的真实使用记录，每次真实使用追加一行：

```json
{"version_id": "VX-15-V1", "date": "2026-08-02", "scenario": "视频号置顶", "audience": "宝妈", "exposure": 1200, "primary_metric": {"name": "主页访问到私信率", "value": 0.031}, "audience_restatement": "教做饭的营养师", "trigger_questions": ["挑食严重也管用吗"], "challenged_evidence": [], "single_change": "opening", "next_version_id": "VX-15-V2", "keep": true}
```

查询约定：
- 按`version_id`前缀分场景（DY-抖音、VX-视频号、BIZ-商务、SQ-私域、JB-嘉宾）。
- 单变量纪律在数据层强制：`single_change`只允许一个值（opening/outcome/proof/label/cta/delivery）。
- `audience_restatement`记原话；没有人复述记空字符串，不记推测。

## persona-spec.json（人格规格的机器可读版，可选）

当用户按`persona-spec-template.md`建立人格规格且需要接入程序时，导出五层结构：

```json
{
  "subject": "…",
  "spec_version": "v2",
  "layers": {
    "L0_identity": [{"item": "定位一句话", "value": "…", "grade": "B"}],
    "L1_judgment": [{"trigger": "评估企业AI落地机会", "criteria": ["…"], "conclusion_pattern": "…"}],
    "L2_voice": {"patterns": ["…"], "quotes": [{"text": "…", "source": "…"}], "banned": ["…"]},
    "L3_evidence": [{"claim": "…", "grade": "B", "action_before_public": "…"}],
    "L4_context": [{"logged": "2026-07", "content": "…", "expires": "2026-10"}]
  }
}
```

私有边界：persona-spec.json与其markdown源文件同级保密，不进入公开分发包。

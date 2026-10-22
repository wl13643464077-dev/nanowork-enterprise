import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
process.env.NANOWORK_DB = ":memory:";

const {
  scanCommercialCompliance,
  commercialComplianceWarnings,
  commercialCompliancePromptLines,
} = await import("../src/engines/content-commercial-compliance.js");
const { parseXhsNoteOutput, XHS_NOTE_SYSTEM, XHS_COMMERCIAL_PLAYBOOK } = await import("../src/engines/ai-xhs-note.js");

test("合规扫描：极限词/医疗功效/站外导流为硬红线，诱导互动与虚假紧迫为软风险", () => {
  const blocked = scanCommercialCompliance("全网最低价的毛血旺，yyds，吃了还能增强免疫力，加微信领券");
  assert.equal(blocked.level, "block");
  assert.equal(blocked.blocked, true);
  const groups = blocked.hits.map(hit => hit.group);
  assert.ok(groups.includes("extreme_base"), "基础极限词命中");
  assert.ok(groups.includes("extreme"), "网络衍生极限词 yyds 命中");
  assert.ok(groups.includes("medical"));
  assert.ok(groups.includes("diversion"));
  assert.ok(blocked.hits.find(hit => hit.group === "diversion").words.includes("微信"));

  const soft = scanCommercialCompliance("下班这一锅先涮肉还是先下菜？记得点赞收藏哦，今天最后一天买一送一");
  assert.equal(soft.blocked, true, "“最后一天”属于基础亏本清仓词表，仍是硬红线");
  assert.ok(soft.hits.some(hit => hit.group === "urgency" && hit.severity === "warn" && hit.words.includes("买一送一")));
  const inducementOnly = scanCommercialCompliance("先赞后看，关注不迷路");
  assert.equal(inducementOnly.level, "warn");
  assert.equal(inducementOnly.blocked, false);

  const clean = scanCommercialCompliance("红汤还是清汤？我们店的牛肉锅今晚等你和朋友来坐坐，地址在主页。加我们店的会员群这句不该命中");
  assert.equal(clean.hits.find(hit => hit.group === "diversion")?.words.includes("加我") ?? false, false, "“加我们”不能误报为“加我”");
});

test("合规提醒文案：硬红线标“发布前必改”，软风险标“建议调整”，都带替换建议", () => {
  const warnings = commercialComplianceWarnings("史上最好吃，求点赞");
  assert.ok(warnings.some(line => line.startsWith("【发布前必改】")));
  assert.ok(warnings.some(line => line.startsWith("【建议调整】") && /诱导互动/u.test(line)));
  assert.ok(warnings.every(line => /改|删|用|放/u.test(line)), "每条都给替换方向");
  const xhsLines = commercialCompliancePromptLines({ platform: "xhs" });
  assert.ok(xhsLines.some(line => /小红书第一红线/u.test(line)));
  const douyinLines = commercialCompliancePromptLines({ platform: "douyin" });
  assert.ok(douyinLines.some(line => /左下角团购/u.test(line)));
});

test("AI带货员：提示词含本地生活带货结构与抖音合规段；口播命中红线进入错误、软风险进入提醒", async () => {
  const { buildAiSalesVideoScriptPrompt, validateAiSalesVideoScript, aiSalesVideoCommercialStructureLines } =
    await import("../src/engines/ai-sales-video-script.js");
  const one = buildAiSalesVideoScriptPrompt({ durationSeconds: 15, brief: "推招牌牛肉锅" });
  assert.match(one.system, /【带货结构·本地生活实战节奏/u);
  assert.match(one.system, /15 秒一段的节拍/u);
  assert.match(one.system, /左下角团购/u);
  assert.match(one.system, /【平台合规硬门·2026】/u);
  const two = buildAiSalesVideoScriptPrompt({ durationSeconds: 30, brief: "推招牌牛肉锅" });
  assert.match(two.system, /30 秒两段分工/u);
  assert.ok(aiSalesVideoCommercialStructureLines({ shotCount: 2 }).some(line => /不在第 1 段提前说行动邀请/u.test(line)));

  const base = {
    hook_3s: "下班不知道吃什么？",
    shots: [{
      index: 1, start: 0, end: 15, visual: "牛肉锅冒热气特写，固定镜头小幅推进。",
      voiceover: "下班不知道吃什么？这一锅牛肉等你。约上朋友来店坐坐吧。",
      subtitle: "下班不知道吃什么？｜这一锅牛肉等你｜约上朋友来店坐坐吧", sfx: "无", reference_hint: "dish",
    }],
    cta: "约上朋友来店坐坐吧。", facts_used: [], total_chars: 28, estimated_seconds: 7, risk_flags: [],
  };
  const clean = validateAiSalesVideoScript(base, { pack: { facts: [] }, scanText: () => ({ hits: [] }) });
  assert.equal(clean.ok, true, JSON.stringify(clean.errors));

  const redline = validateAiSalesVideoScript({
    ...base,
    shots: [{ ...base.shots[0], voiceover: "全城第一的牛肉锅，yyds，加微信领券。约上朋友来店坐坐吧。", subtitle: "全城第一的牛肉锅｜yyds｜加微信领券｜约上朋友来店坐坐吧" }],
  }, { pack: { facts: [] }, scanText: () => ({ hits: [] }) });
  assert.equal(redline.ok, false);
  assert.ok(redline.errors.some(line => /平台红线表述/u.test(line) && /全城第一/u.test(line)));
  assert.ok(redline.errors.some(line => /站外\/私域导流/u.test(line)));

  const soft = validateAiSalesVideoScript({
    ...base,
    shots: [{ ...base.shots[0], voiceover: "下班不知道吃什么？这一锅牛肉等你，关注不迷路。约上朋友来店坐坐吧。", subtitle: "下班不知道吃什么？｜这一锅牛肉等你，关注不迷路｜约上朋友来店坐坐吧" }],
  }, { pack: { facts: [] }, scanText: () => ({ hits: [] }) });
  assert.equal(soft.ok, true, JSON.stringify(soft.errors));
  assert.ok(soft.warnings.some(line => /诱导互动/u.test(line)));
});

test("小红书种草员：系统提示词含商业化发布包规范与合规硬门", () => {
  assert.match(XHS_COMMERCIAL_PLAYBOOK, /titleOptions 三个备选/u);
  assert.match(XHS_COMMERCIAL_PLAYBOOK, /正文五段/u);
  assert.match(XHS_COMMERCIAL_PLAYBOOK, /标签 6–8 个/u);
  assert.match(XHS_COMMERCIAL_PLAYBOOK, /首评 = 转化钩子/u);
  assert.match(XHS_COMMERCIAL_PLAYBOOK, /站外与私域导流/u);
  assert.ok(XHS_NOTE_SYSTEM.includes(XHS_COMMERCIAL_PLAYBOOK));
  assert.match(XHS_NOTE_SYSTEM, /"titleOptions"/u);
  assert.match(XHS_NOTE_SYSTEM, /"sellingPoints"/u);
});

test("小红书种草员解析：接收备选标题与卖点，合规命中进入 warnings 与 compliance，原文完整保留", () => {
  const files = [{ id: 1, name: "a.jpg" }];
  const output = parseXhsNoteOutput(
    {
      mode: "api",
      text: JSON.stringify({
        title: "下班这一锅，先涮肉还是先下菜？",
        titleOptions: ["打工人晚餐｜这一锅两个人刚好", "别急着点主食，先看这一锅", "下班这一锅，先涮肉还是先下菜？"],
        sellingPoints: ["照片里可见的双拼锅底与三层肉盘", "门头品牌已确认为老码头"],
        body: "下班聚餐来老码头。\n\n锅里是红汤和清汤双拼。\n\n两个人建议一荤一素起步。\n\n地址和营业时间在主页。\n\n约上朋友来坐坐，全网最低价等你！",
        tags: ["火锅", "重庆火锅", "老码头", "下班聚餐", "打工人晚餐", "双拼锅"],
        firstComment: "你们会先涮肉还是先下菜？想看完整菜单可以评论区留言。",
        coverText: "下班这一锅先涮啥",
        visualSummary: "双拼锅、三层肉盘、门头老码头",
        imagePlan: [{ fileId: 1, caption: "封面" }],
        warnings: [],
      }),
    },
    { brandName: "老码头", files, confirmedDetails: "门头老码头" },
  );
  assert.deepEqual(output.titleOptions, ["打工人晚餐｜这一锅两个人刚好", "别急着点主食，先看这一锅"], "与主标题重复的备选被去掉");
  assert.equal(output.sellingPoints.length, 2);
  assert.equal(output.compliance.blocked, true);
  assert.ok(output.compliance.hits.some(hit => hit.words.includes("全网最低")));
  assert.ok(output.warnings.some(line => line.startsWith("【发布前必改】")));
  assert.match(output.body, /全网最低价/u, "不静默改写老板要发布的正文");
  assert.ok(!output.warnings.some(line => /标签，建议补到/u.test(line)), "6 个标签不提醒补标签");
  assert.ok(!output.warnings.some(line => /选择题式提问/u.test(line)), "首评已含问号");
});

test("小红书种草员解析：标签不足、首评无问号、段落过少时给出商业化结构提醒", () => {
  const output = parseXhsNoteOutput(
    {
      mode: "api",
      text: JSON.stringify({
        title: "老码头的一锅",
        body: "一锅红汤等你来。",
        tags: ["火锅"],
        firstComment: "欢迎来店。",
        imagePlan: [],
      }),
    },
    { brandName: "老码头", files: [{ id: 1, name: "a.jpg" }] },
  );
  assert.ok(output.warnings.some(line => /建议补到 6–8 个/u.test(line)));
  assert.ok(output.warnings.some(line => /选择题式提问/u.test(line)));
  assert.ok(output.warnings.some(line => /拆成 5 个短段/u.test(line)));
  assert.equal(output.compliance.level, "none");
  assert.deepEqual(output.titleOptions, []);
});

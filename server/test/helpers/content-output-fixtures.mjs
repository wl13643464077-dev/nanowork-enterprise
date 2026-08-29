import assert from 'node:assert/strict';

export const VALID_CONTENT_EMPLOYEE_OUTPUTS = Object.freeze([
  {
    briefing: `本轮趋势研判聚焦餐饮门店如何把经营异常转成老板看得懂、团队做得到的内容。公开行业报告持续讨论成本波动、菜单工程与精细化排班，平台搜索结果中“看懂数据再行动”的实操型内容互动更稳定。当前没有门店私有经营数据，因此只确认趋势方向，不宣称具体涨幅或经营结果；正式选题应先补齐门店品类、目标客群和可公开案例，再由负责人复核事实边界。`,
    channel_scan: [
      {
        channel: '行业协会公开资料',
        finding: '近期内容重点从宏观判断转向菜单、排班和损耗等可执行经营动作。',
      },
      {
        channel: '平台公开搜索结果',
        finding: '带有问题清单、判断步骤和复盘模板的内容更容易形成收藏与讨论。',
      },
      {
        channel: '品牌官方案例栏目',
        finding: '可信案例通常明确数据口径和适用条件，不用单一结果替代完整因果分析。',
      },
    ],
    topics: [
      {
        title: '成本异动先查哪三层',
        angle: '用老板决策顺序拆解排查动作',
        hook: '成本变高时，先别急着让采购背锅。',
        reason: '贴合门店经营者最常见的异常诊断场景，也便于落成检查清单。',
        heat: '高',
        evidence: '行业公开资料与平台问题词共同指向成本诊断需求。',
      },
      {
        title: '菜单不是越多越赚钱',
        angle: '从菜单工程解释取舍逻辑',
        hook: '菜品越丰富，为什么后厨反而越忙越乱？',
        reason: '能连接毛利、出品效率和顾客选择成本，适合老板视角表达。',
        heat: '中高',
        evidence: '公开菜单工程方法与品牌案例均强调结构优化。',
      },
      {
        title: '排班表里的隐形浪费',
        angle: '从客流节奏反推人力安排',
        hook: '人没少上，服务却总在高峰时掉链子。',
        reason: '问题具体且具备行动入口，可引导读者核对客流与岗位负荷。',
        heat: '中高',
        evidence: '行业经营资料持续关注分时客流与岗位效率匹配。',
      },
      {
        title: '老板周报只看这几类信号',
        angle: '把复杂报表压缩成决策提示',
        hook: '报表有几十页，真正要追问的却只有几类信号。',
        reason: '符合管理者减少信息噪声的诉求，可沉淀为固定复盘框架。',
        heat: '中',
        evidence: '公开经营复盘模板普遍强调异常、原因和动作闭环。',
      },
      {
        title: '没有完整数据也能先排查',
        angle: '提供事实缺失时的安全工作法',
        hook: '数据还没齐，不代表团队只能停在原地。',
        reason: '能展示待确认清单和取数路径，避免为了交稿编造经营结论。',
        heat: '中',
        evidence: '数据治理规范要求先定义口径、责任人与核验步骤。',
      },
    ],
  },
  {
    summary: '本次研究围绕餐饮经营异常的识别与沟通展开。现有公开资料能够支持菜单工程、损耗管理和分时排班等通用方法，但不能替代目标门店的进销存、客流和人效数据。交付内容将已核验事实、可参考观点与待补信息分开呈现，并为后续取数和负责人复核保留明确入口。',
    facts: [
      '公开经营方法将销售结构、原料消耗和库存变化视为需要交叉核对的指标。',
      '菜单工程分析通常同时观察菜品受欢迎程度、贡献空间和出品复杂度。',
      '分时客流与岗位配置需要使用同一统计周期和一致门店范围进行比较。',
    ],
    data_points: [
      '目标门店的实际采购单价、销量与损耗记录尚未提供，应列入取数清单。',
      '账号历史内容的曝光、完读、收藏和咨询数据尚待导出后统一核验。',
    ],
    viewpoints: [
      '经营异常不应只归因于单一环节，先检查口径再沿采购、库存、销售逐层定位。',
      '老板向内容要把分析结论翻译成责任人、核验材料和下一步动作。',
    ],
    source_coverage: [
      { channel: '行业协会资料', got: '获得经营指标定义与通用分析框架。' },
      { channel: '品牌官方案例', got: '获得菜单优化和门店复盘的公开案例。' },
      { channel: '平台公开内容', got: '获得经营者常用问题表达和内容反馈线索。' },
    ],
    sources: [
      { title: '餐饮经营公开研究资料', url: 'https://example.test/industry-research' },
      { title: '门店管理公开案例资料', url: 'https://example.test/store-casebook' },
    ],
  },
  {
    benchmarks: [
      {
        title: '成本异常排查清单案例',
        platform: '微信公众号',
        account: '经营研究样本号',
        dimensions: {
          选题角度: '从老板发现报表异常后的真实追问切入，问题边界明确。',
          '标题/钩子': '标题先给冲突，开头用常见误判提醒读者暂停拍脑袋决策。',
          内容结构: '按照现象、口径、排查层级和负责人动作逐步展开。',
          情绪曲线: '先制造紧迫感，再用清晰步骤降低焦虑并建立掌控感。',
          封面与视觉: '用简洁对照表突出异常信号与核验动作，信息层级清楚。',
          评论区洞察: '读者更关注取数困难、部门协同和如何确定责任边界。',
        },
        why_hot: '主题直击经营焦虑，同时给出可保存、可转交团队执行的排查框架。',
      },
      {
        title: '菜单优化复盘案例拆解',
        platform: '小红书',
        account: '餐饮增长观察号',
        dimensions: {
          选题角度: '以菜品很多却不赚钱的反常识问题引出菜单结构诊断。',
          '标题/钩子': '标题采用结果冲突，首屏迅速点明复杂菜单造成的管理负担。',
          内容结构: '先列识别信号，再解释分类方法，最后给出复盘问题。',
          情绪曲线: '从困惑和共鸣过渡到方法解释，结尾推动读者自查。',
          封面与视觉: '采用菜品矩阵与行动标记，方便移动端快速扫读和收藏。',
          评论区洞察: '评论集中询问分类口径、样本周期以及新品如何进入复盘。',
        },
        why_hot: '反常识钩子有传播力，矩阵化方法又能满足经营者的实操需求。',
      },
      {
        title: '门店周报减负方法案例',
        platform: '抖音',
        account: '门店管理公开课',
        dimensions: {
          选题角度: '围绕报表很多但无法决策的管理痛点提出减负方案。',
          '标题/钩子': '用连续追问暴露无效汇报，再承诺交付一套判断顺序。',
          内容结构: '口播按异常、原因、影响、动作和复核顺序组织信息。',
          情绪曲线: '开场制造代入感，中段建立秩序，结尾强调团队协同。',
          封面与视觉: '大字突出周报与决策的反差，字幕只保留关键判断词。',
          评论区洞察: '管理者希望获得可以直接套用的周报字段和会议提问方式。',
        },
        why_hot: '表达节奏适配短视频，同时把复杂管理问题压缩成清楚的行动链。',
      },
    ],
    comment_insights: [
      '读者不只想知道原因，更想拿到可以交给团队执行的核验清单。',
      '当案例缺少统计口径时，评论会集中质疑结果是否能够迁移到自己的门店。',
      '老板群体更愿意讨论责任边界、协作顺序和复盘后的具体动作。',
    ],
    user_language: [
      '我应该先让哪个岗位去查',
      '数据还没收齐能不能先判断',
      '怎么确认问题不是统计口径造成的',
    ],
    takeaways: [
      '标题先呈现经营冲突，正文再给判断顺序和适用条件。',
      '案例必须同时说明数据来源、统计范围以及仍待确认的信息。',
      '结尾用责任人和复核节点收束，避免内容停留在观点层面。',
    ],
  },
  {
    title_candidates: ['成本异常别急着追责：老板先查这三层', '报表显示成本上升，真正的问题可能不在采购', '一张门店异常排查表，把争论变成行动'],
    body: `# 成本异常别急着追责：老板先查这三层

经营报表出现异常时，最危险的动作不是反应慢，而是在口径尚未确认之前先指定责任人。一个看似简单的成本变化，可能来自采购条件变化，也可能来自入库记录、领用流程、销量结构或统计范围不一致。老板要做的第一步，是把“感觉不对”改写成可核验的问题。

## 先确认口径

让财务、采购和门店共同写清楚统计周期、门店范围、品类范围以及数据来源。若关键材料尚未提供，就把它标记为待确认，并明确由谁补齐、用什么凭证核验。没有统一口径的比较，只会制造更多争论。

## 再沿业务链排查

按采购、入库、领用、销售和损耗的顺序逐层检查。每一层只回答三个问题：记录是否完整，前后数据能否勾稽，异常是否能被原始单据解释。暂时没有证据的判断应保留为假设，不能写成结论。

## 最后形成动作闭环

复盘结果要落到问题、证据、责任人、处理动作和复核节点。能立即修正的流程先修正，需要继续取数的事项进入清单。老板最终看到的不是一堆数字，而是一条能够追踪、能够复核、能够持续改进的行动链。`,
    tags: ['经营', '门店', '增长', '复盘', '实操'],
    image_plan: [
      { slot: '文章首屏', desc: '用三层排查路径信息图呈现文章核心判断。' },
      { slot: '排查章节', desc: '用采购到损耗的业务链流程图标注核验节点。' },
      { slot: '结尾总结', desc: '用问题到复核的闭环卡片承接保存与转发。' },
    ],
  },
  {
    body: `# 数据一异常，先别开批斗会

老板看到成本异常，最容易做的一件事，是马上问采购：“最近到底怎么回事？”这句话看着有效率，实际上可能让团队从找证据，迅速滑向找理由。

真正靠谱的顺序，是先把口径摆到桌面上。大家看的是否是同一统计周期、同一门店范围、同一品类范围？入库、领用、销售和损耗的记录能不能接得上？如果这些问题还没有答案，就明确写“待确认”，然后指定材料、负责人和复核节点。别拿猜测补空白，也别用一个结果替代整条业务链。

接下来再顺着流程往下查：采购条件有没有变化，入库记录是否完整，领用是否留下凭证，销量结构是否发生迁移，损耗记录能否对应现场。每发现一个异常，都要问一句：原始材料在哪里？谁来解释？什么时候回看？

最后，老板需要的不是一页漂亮结论，而是一张能继续推进的行动表。问题是什么，证据是什么，下一步做什么，谁负责补齐，如何判断已经解决。把这些写清楚，复盘才不会变成一次情绪释放，而会变成团队共同使用的经营工具。`,
    title_candidates: ['数据一异常，先别开批斗会', '成本变高不等于采购做错了', '老板看经营异常，要先问这几个问题'],
    consistency_note: '延续老板视角、短句推进和先给判断再讲方法的表达习惯；所有未获门店材料支持的内容均保留待确认边界。',
  },
  {
    images: [
      {
        slot: '文章首屏',
        desc: '经营异常三层排查信息图，突出先口径、再链路、后行动的顺序。',
        platform: '微信公众号',
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 720" role="img" aria-labelledby="title desc"><title id="title">经营异常三层排查</title><desc id="desc">先确认数据口径，再检查业务链路，最后形成行动闭环</desc><rect width="1080" height="720" fill="#F4F1EA"/><rect x="90" y="110" width="900" height="500" rx="36" fill="#FFFFFF" stroke="#20201E" stroke-width="4"/><text x="140" y="205" font-size="54" font-weight="700" fill="#20201E">经营异常，先查三层</text><text x="150" y="320" font-size="38" fill="#305C4A">口径确认</text><line x1="350" y1="305" x2="470" y2="305" stroke="#D69A3A" stroke-width="8"/><text x="500" y="320" font-size="38" fill="#305C4A">业务链路</text><line x1="700" y1="305" x2="820" y2="305" stroke="#D69A3A" stroke-width="8"/><text x="150" y="450" font-size="38" fill="#305C4A">行动闭环</text><text x="150" y="535" font-size="28" fill="#5F5D57">证据 · 责任人 · 复核节点</text></svg>`,
      },
      {
        slot: '排查章节',
        desc: '采购到损耗的业务链流程图，帮助读者逐层记录证据与待确认事项。',
        platform: '微信公众号',
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 720" role="img" aria-labelledby="title desc"><title id="title">业务链排查路径</title><desc id="desc">采购、入库、领用、销售和损耗五个核验节点</desc><rect width="1080" height="720" fill="#17231E"/><text x="80" y="120" font-size="52" font-weight="700" fill="#F6F0E4">沿业务链逐层核验</text><line x1="120" y1="355" x2="960" y2="355" stroke="#DDB46E" stroke-width="10"/><circle cx="150" cy="355" r="46" fill="#F6F0E4"/><circle cx="340" cy="355" r="46" fill="#F6F0E4"/><circle cx="530" cy="355" r="46" fill="#F6F0E4"/><circle cx="720" cy="355" r="46" fill="#F6F0E4"/><circle cx="910" cy="355" r="46" fill="#F6F0E4"/><text x="104" y="465" font-size="30" fill="#F6F0E4">采购</text><text x="294" y="465" font-size="30" fill="#F6F0E4">入库</text><text x="484" y="465" font-size="30" fill="#F6F0E4">领用</text><text x="674" y="465" font-size="30" fill="#F6F0E4">销售</text><text x="864" y="465" font-size="30" fill="#F6F0E4">损耗</text><text x="80" y="610" font-size="28" fill="#C6D1CB">每层都记录：原始材料、异常解释、负责人、复核节点</text></svg>`,
      },
    ],
  },
  {
    covers: [
      {
        style: '克制商务',
        platform: '微信公众号',
        size: '横版封面比例',
        html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>经营异常三层排查</title><style>*{box-sizing:border-box}body{margin:0;background:#f2eee5;color:#20201e;font-family:system-ui,"PingFang SC",sans-serif}.cover{min-height:720px;padding:88px;display:flex;flex-direction:column;justify-content:space-between;border:24px solid #20201e}.eyebrow{font-size:26px;letter-spacing:.18em;color:#476657}.title{max-width:820px;font-size:82px;line-height:1.08;font-weight:800}.rule{width:180px;height:12px;background:#d39a43}.foot{font-size:30px;color:#5f5a52}</style></head><body><main class="cover"><div><p class="eyebrow">老板经营判断</p><div class="rule"></div></div><h1 class="title">成本异常<br>先查三层</h1><p class="foot">口径确认 · 业务链路 · 行动闭环</p></main></body></html>`,
      },
      {
        style: '数据看板',
        platform: '小红书',
        size: '竖版封面比例',
        html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>成本异常排查</title><style>*{box-sizing:border-box}body{margin:0;background:#14231d;color:#fff;font-family:system-ui,"PingFang SC",sans-serif}.cover{min-height:1080px;padding:84px;position:relative;overflow:hidden}.badge{display:inline-block;padding:14px 24px;border:2px solid #dfb66f;border-radius:999px;color:#dfb66f;font-size:24px}.title{margin:110px 0 48px;font-size:96px;line-height:1.04}.cards{display:grid;gap:18px}.card{padding:28px 34px;background:#f4efe4;color:#1c2823;border-radius:20px;font-size:32px}.hint{margin-top:52px;font-size:27px;color:#c5d2cc}</style></head><body><main class="cover"><span class="badge">门店经营自查</span><h1 class="title">别急着追责<br>先把证据找齐</h1><section class="cards"><div class="card">第一层：统一统计口径</div><div class="card">第二层：检查业务链路</div><div class="card">第三层：明确行动与复核</div></section><p class="hint">没有证据的判断，先保留为待确认</p></main></body></html>`,
      },
      {
        style: '编辑部海报',
        platform: '抖音',
        size: '竖屏封面比例',
        html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>老板先问什么</title><style>*{box-sizing:border-box}body{margin:0;background:#e7dfcf;color:#151515;font-family:system-ui,"PingFang SC",sans-serif}.cover{min-height:1080px;padding:72px;display:flex;flex-direction:column;justify-content:space-between}.top{display:flex;justify-content:space-between;font-size:24px;border-bottom:4px solid #151515;padding-bottom:18px}.title{font-size:104px;line-height:1.02;margin:0}.question{padding:30px;background:#e5593f;color:#fff;font-size:36px;font-weight:700}.steps{display:flex;gap:12px}.steps span{flex:1;border:3px solid #151515;padding:18px;text-align:center;font-size:24px}</style></head><body><main class="cover"><header class="top"><span>老板决策课</span><span>经营异常</span></header><h1 class="title">数据不对<br>先问什么？</h1><div class="question">先统一口径，再沿链路找证据</div><footer class="steps"><span>口径</span><span>链路</span><span>行动</span><span>复核</span></footer></main></body></html>`,
      },
    ],
  },
  {
    summary: '这是一份面向经营管理会议的可独立播放演绎稿，以统一口径、业务链核验和行动闭环为主线，所有门店事实均保留人工确认节点。',
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>经营异常排查演绎稿</title><style>*{box-sizing:border-box}body{margin:0;background:#101a16;color:#f4efe6;font-family:system-ui,"PingFang SC",sans-serif}.deck{min-height:100vh;padding:72px;display:grid;gap:28px}.hero{padding:64px;border:1px solid #486458;background:#16251f;border-radius:28px}.kicker{color:#deb56e;letter-spacing:.16em}.hero h1{font-size:68px;line-height:1.08;margin:20px 0}.hero p{max-width:850px;font-size:25px;line-height:1.7;color:#c9d3ce}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.card{padding:34px;background:#f1ede4;color:#18221e;border-radius:22px}.card b{display:block;font-size:34px;margin-bottom:14px}.card p{font-size:20px;line-height:1.65}.closing{padding:34px;border-left:8px solid #deb56e;font-size:24px;line-height:1.65}</style></head><body><main class="deck"><section class="hero"><div class="kicker">老板经营判断</div><h1>成本异常，先别急着追责</h1><p>真正有效的复盘从统一统计口径开始，再沿采购、入库、领用、销售与损耗逐层找证据，最终把结论写成团队可以执行和复核的动作。</p></section><section class="grid"><article class="card"><b>先统一口径</b><p>确认统计周期、门店范围、品类范围和数据来源。缺少的材料明确标记为待确认。</p></article><article class="card"><b>再核验链路</b><p>逐层检查记录是否完整、前后是否勾稽、异常能否被原始材料解释。</p></article><article class="card"><b>形成行动闭环</b><p>每个问题对应证据、责任人、处理动作和复核节点，避免会议只留下观点。</p></article></section><section class="closing">会议结束前只确认三件事：哪些事实已经核验，哪些材料仍需补齐，下一轮复核由谁推进。没有证据支持的判断继续保留为假设。</section></main></body></html>`,
  },
  {
    versions: [
      {
        platform: '微信公众号',
        title: '成本异常别急着追责：老板先查这三层',
        body: '经营报表出现异常时，最怕团队在口径尚未统一之前先争论责任。先确认统计范围、数据来源和业务定义，再沿采购、入库、领用、销售与损耗逐层核验。每一步都要留下原始材料、负责人和复核节点。当前缺少的门店数据、地址、价格与预约入口继续标记为待确认，负责人补齐并审核前不写成事实。最终交付的不是漂亮结论，而是一张团队能够继续执行的行动表。',
        tags: ['门店经营', '成本管理', '老板决策', '数据复盘'],
        best_time: '待账号历史数据确认',
        checklist: ['逐项核对事实来源', '确认缺失信息标记', '负责人终审后发布'],
        note: '长文保留完整判断链，文末明确材料补齐与人工复核责任。',
      },
      {
        platform: '小红书',
        title: '成本一异常就追采购？先做完这张自查表',
        body: '老板看到成本异常，先别让团队互相解释。第一步，把统计范围和数据来源写清楚；第二步，按采购、入库、领用、销售、损耗的顺序找原始材料；第三步，把每个问题落到责任人和复核节点。没有材料支持的判断先写待确认，门店数据、价格、地址与预约入口也要等负责人补齐后再公开。把争论换成证据，把感觉换成可以追踪的动作，复盘才真正有用。',
        tags: ['餐饮老板', '门店复盘', '经营方法', '管理清单'],
        best_time: '待账号历史数据确认',
        checklist: ['检查首屏信息层级', '核对正文事实边界', '确认标签不带符号'],
        note: '采用卡片化短段落，保留待确认提示并避免未经核验的经营承诺。',
      },
      {
        platform: '抖音',
        title: '成本不对，老板第一句话别问错',
        body: '成本异常，先别问是谁的问题。先问：大家看的统计范围是否一致？再问：采购、入库、领用、销售和损耗的记录能不能接上？最后问：缺少的材料由谁补齐，下一轮怎么复核？这套顺序能把情绪争论变成证据核验。涉及门店数据、价格、地址和预约入口的内容，在负责人确认前只保留待确认提示，不替门店编造答案。评论区可以留下你最难推进的核验环节。',
        tags: ['老板思维', '门店管理', '经营复盘', '餐饮实操'],
        best_time: '待账号历史数据确认',
        checklist: ['检查口播停顿位置', '核对字幕关键判断', '人工确认互动问题'],
        note: '口播用连续提问推动节奏，所有经营事实仍以负责人终审为准。',
      },
    ],
    publish_plan: '先由业务负责人统一核验三版事实与待确认项，再按平台内容形态分别进入排期；发布顺序根据账号历史数据和审核结果决定，反馈统一回收到复盘表。',
  },
  {
    report: `# 内容发布复盘报告

## 当前结论

本轮尚未提供各平台的曝光、停留、互动、咨询与转化明细，因此不能判断哪一版内容已经形成真实经营成效，也不对选题优劣做肯定归因。现阶段可确认的是，三平台版本均围绕“先统一口径、再沿业务链核验、最后形成行动闭环”展开，事实缺失项保留了待确认提示，发布前仍需业务负责人完成终审。

## 数据补齐与分析框架

负责人应按平台导出同一观察窗口内的曝光、阅读或播放、互动、收藏、主页访问与咨询记录，并补充发布时间、封面版本和审核记录。数据到齐后先检查统计口径，再比较各环节变化；若样本不足，只记录现象，不把相关性写成因果。

## 下一轮动作

继续沿经营者真实问题生产内容，同时建立“选题假设—发布版本—反馈信号—修订动作”的台账。每轮复盘明确保留项、修改项和待验证项；涉及门店经营事实的表述继续由责任人凭原始材料核验。`,
    next_topics: [
      { title: '菜单结构怎么做自查', reason: '承接成本诊断主题，并提供可由门店逐项核验的菜单复盘框架。' },
      { title: '门店周报如何真正减负', reason: '回应管理者筛选关键信号的需求，适合沉淀固定汇报模板。' },
      { title: '跨部门复盘怎么定责任', reason: '延伸评论中的协同难题，重点讲证据、动作和复核节点。' },
    ],
    profile_updates: [
      '后续内容优先使用问题清单和行动表，帮助经营者直接转交团队执行。',
      '所有案例增加统计口径、材料来源和待确认项，避免把经验判断包装成事实。',
    ],
  },
]);

export const CONTENT_EMPLOYEE_ARTIFACT_KINDS = Object.freeze([
  'json',
  'json',
  'json',
  'markdown',
  'markdown',
  'images',
  'covers',
  'html',
  'publish_packages',
  'markdown',
]);

export function validContentEmployeeOutput(idx) {
  assert.ok(Number.isInteger(idx) && idx >= 0 && idx < VALID_CONTENT_EMPLOYEE_OUTPUTS.length,
    `content employee fixture idx out of range: ${idx}`);
  return structuredClone(VALID_CONTENT_EMPLOYEE_OUTPUTS[idx]);
}

export const contentOutputFixture = validContentEmployeeOutput;

export function contentEmployeeIdxFromPrompt(prompt) {
  const match = String(prompt || '').match(/岗位编号：([0-9]+)/u);
  const idx = Number(match?.[1]);
  return Number.isInteger(idx) && idx >= 0 && idx <= 9 ? idx : null;
}

export function validContentEmployeeOutputForPrompt(prompt) {
  const idx = contentEmployeeIdxFromPrompt(prompt);
  return idx === null ? null : validContentEmployeeOutput(idx);
}

function numbered(values) {
  return values.map((value, index) => `${index + 1}. ${value.trim()}`).join('\n');
}

function expectedWriterMarkdown(output) {
  return [
    '# 撰稿人岗位交付报告',
    '',
    '## 标题候选',
    '',
    numbered(output.title_candidates),
    '',
    '## 正文',
    '',
    output.body.trim(),
    '',
    '## 标签',
    '',
    output.tags.map(tag => `#${tag.trim()}`).join(' '),
    '',
    '## 配图计划',
    '',
    output.image_plan.map((item, index) => (
      `${index + 1}. **${item.slot.trim()}**\n   ${item.desc.trim()}`
    )).join('\n'),
  ].join('\n');
}

function expectedStylistMarkdown(output) {
  return [
    '# 文风师岗位交付报告',
    '',
    '## 标题候选',
    '',
    numbered(output.title_candidates),
    '',
    '## 正文',
    '',
    output.body.trim(),
    '',
    '## 人设与文风一致性说明',
    '',
    output.consistency_note.trim(),
  ].join('\n');
}

function expectedRetrospectiveMarkdown(output) {
  return [
    '# 复盘官岗位交付报告',
    '',
    '## 复盘报告',
    '',
    output.report.trim(),
    '',
    '## 下一轮候选选题',
    '',
    output.next_topics.map((topic, index) => (
      `${index + 1}. **${topic.title.trim()}**\n   ${topic.reason.trim()}`
    )).join('\n'),
    '',
    '## 可回写岗位经验',
    '',
    output.profile_updates.length
      ? output.profile_updates.map(update => `- ${update.trim()}`).join('\n')
      : '（本次没有可回写的岗位经验）',
  ].join('\n');
}

export function expectedContentEmployeeArtifactContent(idx) {
  const output = validContentEmployeeOutput(idx);
  if (idx === 3) return expectedWriterMarkdown(output);
  if (idx === 4) return expectedStylistMarkdown(output);
  if (idx === 7) return output.html;
  if (idx === 9) return expectedRetrospectiveMarkdown(output);
  if (idx === 5) return JSON.stringify(output.images, null, 2);
  if (idx === 6) return JSON.stringify(output.covers, null, 2);
  return JSON.stringify(output, null, 2);
}

import { UNTRUSTED_GUARD } from './risk.js';
import { createHash } from 'node:crypto';
import { detectImageFormat, renderSvgToPng } from './poster-text-overlay.js';
import { provider360Active } from './yunwu.js';
import { selectedProviderId } from './ai-provider-selection.js';
import { commercialCompliancePromptLines, commercialComplianceWarnings, scanCommercialCompliance } from './content-commercial-compliance.js';

export const XHS_NOTE_SOURCE = 'ai_xhs_note';

// 商业化发布包规范：让种草稿既守住“照片只证明外观、不编事实”的底线，
// 又按 2026 小红书本地生活的实战打法产出——搜索承接标题、五段正文、
// 分层标签、转化型首评与平台合规硬门。所有具体事实仍只能来自用户确认。
export const XHS_COMMERCIAL_PLAYBOOK = [
  '【商业化发布包规范·在不编造事实的前提下按此组织】',
  '1. 标题（≤20字）：用“人群或场景 + 具体菜品/可见卖点 + 选择或悬念”，优先回答食客在搜的问题（今天吃什么/和谁吃/怎么点）。另给 titleOptions 三个备选，分别用数字型（数字只能来自确认事实或照片可数的东西）、反常识型（“别急着点主食”“先看这一锅”）、身份代入型（打工人/带娃/闺蜜局）；确认了城市或商圈时，主标题或备选之一带上地点词。',
  '2. 搜索承接：正文前 100 字自然带出品类核心词与一个场景长尾词（如“下班聚餐”“周末带娃”），像说话一样融入，不堆词。',
  '3. 正文五段（每段 1–3 句、共 150–300 字、emoji 1–8 个）：①开场钩子或场景 ②照片里确定的主菜与可见细节 ③适合谁、建议怎么点（按可见选择给点单建议） ④到店信息，只写用户确认的地址/营业时间/价格，没有就省略这一段 ⑤行动邀请（约朋友来坐坐 / 评论区说说你会先点哪个）。',
  '4. sellingPoints：2–3 条，只从用户确认事实和照片可见外观里提炼，每条一句话，供老板核对与复用到其他平台。',
  '5. 标签 6–8 个（不带#）：品类大词 2 个 + 具体菜品/门店词 2 个 + 场景或人群词 2 个 + 城市/商圈词（仅在用户确认城市时加）。',
  '6. 首评 = 转化钩子：一个具体的选择题式提问（“红汤还是清汤？”）+ 一句合规承接（“想看完整菜单可以评论区留言，地址和营业时间在主页”）；不写微信/二维码/私信领取/进群，不承诺回复福利。',
  ...commercialCompliancePromptLines({ platform: 'xhs' }),
  '7. 写完自查：标题≤20字、正文≥5段、标签 6–8 个、首评含问号、没有上面任何违禁表述；把仍需老板确认的事实写进 warnings。',
].join('\n');

export const XHS_NOTE_SYSTEM = `${UNTRUSTED_GUARD}
你是餐饮门店的AI小红书种草员。读取本次上传照片和品牌资料，一次交付一份可编辑的门店官方发布包。照片可能是实拍或明确标注的AI创意图，不能把后者说成实拍。
照片只证明可见外观，不能证明口味、原料、价格、地址、优惠、销量或顾客体验。没有提供的事实不编造，也不要伪装成顾客探店。
明确区分说话身份：聊天reply是数字员工对老板说话；title/body/firstComment是门店官方账号对食客说话。“像朋友一样自然”不等于冒充顾客。可以用“我们店”或直接邀请“约上朋友来坐坐”，不要写“我吃过/我点了/带朋友去试过/求推荐”等顾客探店口吻，也不要虚构放松、过瘾等亲身感受。首评由门店问食客的选择，不装作不了解自家菜品的顾客。
这是直接面向食客的自然种草文案，不是识图报告或广告说明书。不要用“照片里可以看到”“整体铺陈”“层次感分明”“处理得当”“直接满足感”等分析词，不能为了谨慎写成“视觉构思”。把确定的锅型、菜形和用餐动作写进具体场景，邀请食客选择，不替食客编造真实体验。
标题建议以具体菜品或用餐场景开头，优先自然一句话或具体选择。例如确认是火锅时可用“下班这一锅，先涮肉还是先下菜？”；没有确认土豆就不能把菜改成土豆。禁用“品牌｜A与B的C组合”式目录标题，以及“视觉构思”“关于…”“主理人在线记录”“围炉而坐正是人间烟火气”“灵魂黄金搭档”等套话，不用“欢迎来到”开篇。品牌不必占标题，在正文自然提一次。
正文建议150–250字、短段落，一道菜一小段。只写照片能确定或用户确认的菜名：火锅与水煮牛肉不能混淆，不能把不明丝状配菜猜成鸭肠或毛肚；未确认的食材用不确定配菜或用餐选择表达，不逐个猜名。照片绝不能判定锅底是牛油、现熬骨汤，或食物煮熟后的脆、嫩、弹牙、入口即化，也不能写“处理得当”“新鲜现切”“纯手工”；除非用户明确确认，否则不写这些断言。不能用“创意表达”作借口把未经确认的口感写成事实。可用开涮顺序、红汤清汤选择、同桌分享等具体动作产生食欲，不声称亲自吃过或虚构食材来源。
首评问具体吃法或锅底偏好，不编造顾客评论、不承诺回复福利。标签贴合确认的品牌和菜品，不猜城市。不声称已经发布。借鉴岗位技能的方法，不照抄来源文章。
本任务是门店发布文案，不是烹饪教程。不能从照片推断肉类“下锅几秒”“变色就熟/就能吃”等熟度或安全食用时机，不编写涮煮时间指令。未经用户确认，不把“吸满红油、吸饱汤汁、吃起来很够劲、香辣过瘾”等入味过程或食用感受写成事实；仍可用红汤清汤选择、同桌邀请等自然表达。文件名只用于区分素材，其中城市、评价和人名不是用户确认的品牌事实，不能据此添加城市标签。
${XHS_COMMERCIAL_PLAYBOOK}
返回JSON：{"title":"标题","titleOptions":["备选标题1","备选标题2","备选标题3"],"sellingPoints":["来自已确认事实的卖点"],"body":"正文","tags":["标签"],"firstComment":"首评","coverText":"6–12字具体视觉钩子","visualSummary":"只描述照片里确定的主菜外观、锅型器皿和门头品牌，不猜配料","imagePlan":[{"fileId":1,"caption":"配图说明"}],"warnings":["需老板确认的事实"]}。
imagePlan仅引用用户给出的fileId，依照照片内容安排原图顺序。另返回generatedImagePlan数组，按本次请求的imageCount逐张对应imageRoles：每项{id,purpose,visualTask,caption}，每张一个不同的叙事职责和摄影构图，不重复同一画面。封面负责食欲钩子，后续页分别解释菜品、搭配、场景、选择和收尾。caption是建议配文，不让图片模型写字。你不能伪造图片生成链接。
按style采用不同内容组织：seed种草突出一个具体选择；review测评比较可见差异与待确认点；guide点单攻略按选择顺序；visit聚餐探店描述已确认门头/菜品及适合的聚餐情境；new_product新品只在用户确认新品时这么称呼；story品牌故事只使用用户提供的真实故事。测评与探店没有真实体验资料时，不能冒称亲自吃过、代写真实顾客口吻、排名或优惠；缺事实时交付可用的观察稿和待体验点，不硬失败。不要返回多份完整正文稿、打分、工作流程或其他平台内容；备选只限 titleOptions 里的三个标题。`;

export const XHS_IMAGE_MODEL = 'gpt-image-2';
// OpenLux 通道升级为 GPT-Image-2.5（实测每张约 ¥0.10，支持参考图编辑）；360 与其他通道保持原模型。
export const XHS_OPENLUX_IMAGE_MODEL = 'gpt-image-2.5-flare-c';
export const XHS_IMAGE_MODELS = Object.freeze(['gpt-image-2', 'openai/gpt-image-2', XHS_OPENLUX_IMAGE_MODEL]);
export const xhsImageModel = () => provider360Active() ? 'openai/gpt-image-2'
  : selectedProviderId() === 'openlux' ? XHS_OPENLUX_IMAGE_MODEL : XHS_IMAGE_MODEL;
export const XHS_IMAGE_TIMEOUT_MS = 15 * 60_000;
export const XHS_IMAGE_ROLES = Object.freeze([
  { id: 'cover', label: '食欲封面', purpose: '用一道明确主菜吸引读者', visualTask: '主菜占据画面大部分，温暖自然光、干净背景，突出可见色泽与完整锅型' },
  { id: 'detail', label: '菜品特写', purpose: '看清招牌菜本身', visualTask: '主菜近景，保持原有形态、锅底分区与器皿，不加人物' },
  { id: 'scene', label: '用餐场景', purpose: '说明同桌用餐情境', visualTask: '餐桌平视中景，主菜清晰，场景必须根据参考或使用中性背景' },
  { id: 'angle', label: '主菜另一面', purpose: '补充侧面形态与份量观察', visualTask: '同一主菜较低的侧面45度构图，保留器皿边缘，不能改变真实份量' },
  { id: 'pairing', label: '搭配观察', purpose: '帮助理解已出现的搭配', visualTask: '主菜与参考图已有的配碟同框；无配碟参考时只取主菜与餐具细节，不添新菜' },
  { id: 'overview', label: '整桌一览', purpose: '给读者完整的餐桌关系', visualTask: '从正上方俯拍参考中的主菜和已有配菜，完整一张照片，不分格、不增加新菜' },
  { id: 'texture', label: '细节观察', purpose: '看清表面纹理与色泽', visualTask: '从主菜可见部位做微距构图，自然侧光，不能凭空增加食材或表现未经确认的口感' },
  { id: 'utensil', label: '器皿细节', purpose: '补充锅型或盛器记忆点', visualTask: '主菜与原器皿交界的近景，突出参考中真实的锅型和盛器，不新增标识' },
  { id: 'space', label: '门店氛围', purpose: '把菜品与已知门店联系起来', visualTask: '有门头参考时保留建筑外形与灯光但不画字；没有门头时用主菜和中性桌面，不虚构真实店内' },
  { id: 'choice', label: '选择观察', purpose: '呈现一个可见的选择点', visualTask: '同一锅中已存在的不同区域或同一道菜另一侧作为焦点，仍为单一完整摄影画面，不做对比拼板' },
  { id: 'tabletop', label: '同桌视角', purpose: '建立围桌分享的画面', visualTask: '从餐桌边缘稍远视角拍摄主菜，已有餐具作前景，不增加其他菜或虚构顾客' },
  { id: 'closing', label: '收尾回味', purpose: '以主菜收尾并引导具体选择', visualTask: '回到主菜的明亮三分构图，留少量自然留白，内容完整，不画文字或促销标记' },
]);
export const XHS_STYLES = Object.freeze([
  { id: 'seed', label: '种草推荐' }, { id: 'review', label: '对比测评' }, { id: 'guide', label: '点单攻略' },
  { id: 'visit', label: '聚餐探店' }, { id: 'new_product', label: '新品推荐' }, { id: 'story', label: '品牌故事' },
]);
export const XHS_COVER_LAYOUTS = Object.freeze([{ id: 'photo', label: '食欲大图' }, { id: 'collage4', label: '四宫格拼图' }, { id: 'headline', label: '大字报' }]);
export function xhsImageCount(value, { legacy = false } = {}) {
  const count = value === undefined ? (legacy ? 3 : 6) : value;
  if (![3, 6, 9, 12].includes(count)) throw Object.assign(new Error('请选择6、9或12张配图'), { status: 400 });
  return count;
}
export function xhsImageRoles(input = {}, { legacy = false } = {}) { return XHS_IMAGE_ROLES.slice(0, xhsImageCount(input.imageCount, { legacy })); }
export function buildXhsImagePlan(input, output = {}, { legacy = false } = {}) {
  const candidates = Array.isArray(output.generatedImagePlan) ? output.generatedImagePlan : [];
  return xhsImageRoles(input, { legacy }).map((role, index) => {
    const candidate = candidates.find(item => item?.id === role.id) || {};
    return { ...role, index: index + 1, purpose: typeof candidate.purpose === 'string' && candidate.purpose.trim() ? candidate.purpose : role.purpose,
      visualTask: typeof candidate.visualTask === 'string' && candidate.visualTask.trim() ? candidate.visualTask : role.visualTask,
      caption: typeof candidate.caption === 'string' ? candidate.caption : '',
      visualSummary: String(output.visualSummary || '') };
  });
}

export function normalizeXhsNoteInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('请提供品牌名和照片'), { status: 400 });
  }
  const brandName = typeof input.brandName === 'string' ? input.brandName.trim() : '';
  const brief = typeof input.brief === 'string' ? input.brief.trim() : '';
  const requestKey = typeof input.requestKey === 'string' ? input.requestKey.trim() : '';
  if (!brandName || brandName.length > 120) throw Object.assign(new Error('请填写品牌名（120字以内）'), { status: 400 });
  if (brief.length > 32000) throw Object.assign(new Error('补充说明请控制在32000字以内'), { status: 400 });
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestKey)) throw Object.assign(new Error('任务标识无效，请刷新后重试'), { status: 400 });
  if (!Array.isArray(input.fileIds) || !input.fileIds.length || input.fileIds.length > 6
    || input.fileIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw Object.assign(new Error('请上传1–6张菜品或门头照片'), { status: 400 });
  }
  for (const key of ['generateImages', 'includeDiner']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw Object.assign(new Error('配图选项格式不正确'), { status: 400 });
  }
  const imageCount = xhsImageCount(input.imageCount);
  const style = input.style ?? 'seed', coverLayout = input.coverLayout ?? 'photo';
  if (!XHS_STYLES.some(item => item.id === style) || !XHS_COVER_LAYOUTS.some(item => item.id === coverLayout)) throw Object.assign(new Error('内容风格或封面版式无效'), { status: 400 });
  return { brandName, brief, requestKey, fileIds: [...new Set(input.fileIds)],
    generateImages: input.generateImages !== false, includeDiner: input.includeDiner === true, imageCount, style, coverLayout };
}

export function xhsNotePrompt(input, files, { brandPack = '' } = {}) {
  return JSON.stringify({
    brandName: input.brandName,
    confirmedDetails: input.brief,
    brandKnowledgePack: brandPack || undefined,
    style: input.style || 'seed',
    coverLayout: input.coverLayout || 'photo',
    imageCount: xhsImageCount(input.imageCount),
    imageRoles: xhsImageRoles(input),
    photos: files.map(file => ({ fileId: file.id, name: file.name })),
  });
}

// Formatting is advice. Preserve the complete provider response even when JSON
// is malformed or the provider's token budget ends mid-response.
export function parseXhsNoteOutput(result, { brandName, files, confirmedDetails = '', input = {} }) {
  const raw = typeof result?.text === 'string' ? result.text : '';
  if (!raw.trim() || result?.mode !== 'api') throw Object.assign(new Error('模型没有返回有效内容，请检查生成通道后重试'), { code: 'XHS_NO_OUTPUT' });
  let parsed;
  let parsedJson = false;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    parsedJson = true;
  } catch { /* preserve original below */ }
  const warnings = [];
  const valid = parsed && !Array.isArray(parsed) && typeof parsed === 'object' && typeof parsed.body === 'string' && parsed.body.trim();
  const hasText = value => typeof value === 'string' ? !!value.trim()
    : value && typeof value === 'object' ? Object.values(value).some(hasText) : false;
  if (parsedJson && !valid && !hasText(parsed)) throw Object.assign(new Error('模型没有返回有效正文，请检查生成通道后重试'), { code: 'XHS_NO_OUTPUT' });
  const body = valid ? parsed.body : raw;
  if (!valid) warnings.push('已保留完整原文，分栏未能自动识别；可直接编辑或复制原文。');
  const title = valid && typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : `${brandName}的门店分享`;
  const tags = valid && Array.isArray(parsed.tags) ? parsed.tags.filter(tag => typeof tag === 'string').map(tag => tag.replace(/^#+/, '').trim()).filter(Boolean) : [];
  const firstComment = valid && typeof parsed.firstComment === 'string' ? parsed.firstComment : '';
  const copy = `${title}\n${body}\n${firstComment}`;
  const confirmed = fact => String(confirmedDetails).split(/[，。！？\n;；]/u).some(part => part.includes(fact)
    && !/不要|不得|不能|不确定|未确认|未提供|没确认|不是|别写|未经|尚未/u.test(part));
  for (const fact of ['牛油', '现熬骨汤', '新鲜现切', '纯手工', '入口即化', '弹牙', '脆嫩', '爽脆']) {
    if (copy.includes(fact) && !confirmed(fact)) warnings.push(`发布前请确认“${fact}”：照片不能证明该原料、工艺或口感，建议删改为已确认的信息。`);
  }
  const tasteClaims = ['够劲', '吸满红油', '吸饱汤汁', '吸饱了汤汁', '香辣过瘾'].filter(fact => copy.includes(fact) && !String(brandName).includes(fact) && !confirmed(fact));
  if (tasteClaims.length) warnings.push(`发布前请确认“${tasteClaims.join('、')}”：静态照片不能证明入味过程或食用感受，可改为邀请食客选择。`);
  if (/(?:肉片|牛肉|羊肉|猪肉|鸡肉|生肉|肉类)[^。！？\n]{0,40}(?:(?:几|数|[0-9一二三四五六七八九十两]+)\s*秒|变色)|变色[^。！？\n]{0,12}(?:就熟|即熟|能吃|可以吃)/u.test(copy))
    warnings.push('正文含肉类涮煮时间或变色熟度描述；照片不能证明安全食用时机，发布前请删改这类烹饪指令。完整原稿保留。');
  if (/求推荐|我(?:们)?(?:去过|来过|吃过|点了|亲测|探店|带朋友去)|本人实测/u.test(copy))
    warnings.push('这是门店官方发布稿，当前有顾客或探店口吻；建议改为门店对食客的邀请，避免虚构第一人称体验。');
  if (/(?:土豆|配菜|肉片)[^。！？\n]{0,8}(?:脆|嫩)|(?:脆|嫩)[^。！？\n]{0,4}(?:土豆|配菜|肉片)/u.test(copy)
    && !/(?:脆|嫩)/u.test(String(confirmedDetails))) warnings.push('照片不能证明烹调后的脆嫩口感，请确认或改成开涮顺序等自然表达。');
  if (/处理得当|整体铺陈|层次感分明|直接满足感/u.test(copy) || /[|｜].*(?:与|和).*(?:组合|搭配)/u.test(title))
    warnings.push('这份文案仍有说明书式表达，可改成食客的用餐场景或具体吃法选择；完整原稿保留供编辑。');
  if (title.length > 20) warnings.push('标题较长，发布前可自行精简；原文已完整保留。');
  if (body.length > 1000) warnings.push('正文较长，发布前可自行精简；原文已完整保留。');
  if (!tags.length) warnings.push('可补充品牌、菜品和所在城市的标签。');
  else if (tags.length < 5) warnings.push(`当前 ${tags.length} 个标签，建议补到 6–8 个：品类大词 + 菜品/门店词 + 场景/人群词（城市词仅在确认城市时加）。`);
  else if (tags.length > 10) warnings.push(`当前 ${tags.length} 个标签偏多，建议精简到 6–8 个，避免被判堆砌。`);
  if (!firstComment) warnings.push('可补充一条邀请顾客交流的首评。');
  else if (!/[？?]/u.test(firstComment)) warnings.push('首评建议改成一个具体的选择题式提问（如“红汤还是清汤？”），更容易带动评论。');
  if (valid && body.split(/\n\s*\n|\n/u).map(part => part.trim()).filter(Boolean).length < 4) {
    warnings.push('正文段落较少，建议按“开场→菜品细节→怎么点→到店信息→行动邀请”拆成 5 个短段，手机上更好读。');
  }
  // 商业化标题备选与卖点：只接受字符串，长度受限；不足三条不算失败。
  const titleOptions = valid && Array.isArray(parsed.titleOptions)
    ? [...new Set(parsed.titleOptions.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))]
        .filter(item => item !== title).slice(0, 5)
    : [];
  const sellingPoints = valid && Array.isArray(parsed.sellingPoints)
    ? parsed.sellingPoints.filter(item => typeof item === 'string').map(item => item.trim().slice(0, 120)).filter(Boolean).slice(0, 5)
    : [];
  // 平台合规扫描：命中硬红线的逐条列给老板必改；软风险作提醒。全文保留不改写。
  const compliance = scanCommercialCompliance(`${title}\n${titleOptions.join('\n')}\n${body}\n${firstComment}\n${tags.join(' ')}`, { platform: 'xhs' });
  warnings.push(...commercialComplianceWarnings(`${title}\n${titleOptions.join('\n')}\n${body}\n${firstComment}\n${tags.join(' ')}`, { platform: 'xhs' }));
  if (['length', 'max_tokens'].includes(result.finishReason)) warnings.push('模型达到本次输出上限，已保留收到的内容；请检查末尾是否完整。');
  if (valid && Array.isArray(parsed.warnings)) warnings.push(...parsed.warnings.filter(item => typeof item === 'string'));
  const fileIds = new Set(files.map(file => file.id));
  const used = new Set();
  const imagePlan = (valid && Array.isArray(parsed.imagePlan) ? parsed.imagePlan : [])
    .filter(item => item && fileIds.has(item.fileId) && !used.has(item.fileId) && used.add(item.fileId))
    .map(item => ({ fileId: item.fileId, caption: typeof item.caption === 'string' ? item.caption : '' }));
  for (const file of files) if (!used.has(file.id)) imagePlan.push({ fileId: file.id, caption: file.name });
  const output = { title, titleOptions, sellingPoints, body, tags, firstComment, imagePlan, warnings: [...new Set(warnings)], rawText: raw,
    compliance: { level: compliance.level, blocked: compliance.blocked, hits: compliance.hits },
    coverText: valid && typeof parsed.coverText === 'string' ? parsed.coverText : '',
    visualSummary: valid && typeof parsed.visualSummary === 'string' ? parsed.visualSummary : '' };
  output.generatedImagePlan = buildXhsImagePlan(input, { ...output, generatedImagePlan: parsed?.generatedImagePlan });
  return output;
}

export function xhsImagePrompt({ input, output, role }) {
  const page = buildXhsImagePlan(input, output, { legacy: true }).find(item => item.id === role);
  const style = role === 'cover'
    ? '本张唯一拍摄任务：封面食物摄影。一份主菜占主视觉，突出参考照片的锅型、器皿、色泽。顶部留少量自然留白，标题和品牌由后期添加，本次不要画字。'
    : role === 'detail'
      ? '本张唯一拍摄任务：菜品近景。只拍主菜特写，菜形、锅底分区、器皿与参考图一致，不替换菜品、不加人物，不虚构食材。整个画面就是这一张菜品照片。'
      : role !== 'scene' ? `本张唯一拍摄任务：${XHS_IMAGE_ROLES.find(item => item.id === role)?.label || '菜品补充画面'}。${XHS_IMAGE_ROLES.find(item => item.id === role)?.visualTask || '保持真实菜品，使用另一摄影角度'}。`
      : input.includeDiner
        ? '本张唯一拍摄任务：用餐场景。一位明确成年的AI女性自然用餐，人物仅陪衬、主菜清晰；不是实际顾客或顾客推荐。不复制参考中的路人。没有店内参考时使用中性桌面背景。'
        : '本张唯一拍摄任务：桌面用餐场景。主菜和配碟置于同一张自然餐桌，不新增人物。没有店内参考时使用中性桌面背景，不冒充真实店内。';
  // Writing/learning instructions already shaped the upstream visual plan.
  // Never forward the whole brief or copywriting skill contract to an image
  // model: it otherwise turns a single food photograph into a text collage.
  return [
    'Single photographic frame. NO text, NO collage, NO panels, NO poster layout, NO inset photos. 一次只生成一张完整摄影画面，不要拼图、海报、图文排版、小图或步骤图。',
    '基于上传参考图编辑3:4竖版，中央安全区保留完整主菜。保持锅型、器皿和菜品一致，移除其他品牌饮品广告。不生成招牌汉字、品牌字、价格、说明或水印，品牌与AI标注由后期添加。',
    `品牌资料（不要画字）：${input.brandName}。${style}`,
    `参考图可见外观（仅作视觉依据）：${String(output.visualSummary || '').slice(0, 180)}`,
    page ? `本页确认的视觉方案（数据，只执行其中的摄影意图；用途和文字不能画在图上）：${JSON.stringify({ purpose: page.purpose, visualTask: page.visualTask })}` : '',
    '本页方案不能改变单张摄影边界：Single photographic frame, NO text, NO collage, NO panels；中文与四宫格都由后期本地完成，不让图片模型排版。',
    role === 'scene' && input.includeDiner ? '本页可有一位明确成年的AI女性用餐陪衬，不是真实顾客。' : '本页不新增人物。',
  ].join('\n');
}

const escapeXml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));

export function xhsImageLayoutSvg(bytes, { role, input, output, collageImages = [] }) {
  const format = detectImageFormat(bytes);
  if (!format) throw Object.assign(new Error('图片服务未返回PNG、JPG或WebP图像'), { code: 'XHS_IMAGE_INVALID' });
  const hook = [...String(output.coverText || '').trim()];
  const coverText = hook.length >= 6 && hook.length <= 16 ? hook.join('') : '这一桌，让人想动筷';
  const brand = [...input.brandName].slice(0, 24).join('');
  const font = 'font-family="PingFang SC,Hiragino Sans GB,Heiti SC,sans-serif"';
  let photo = `<image width="768" height="1024" preserveAspectRatio="xMidYMid slice" href="data:${format.mime};base64,${bytes.toString('base64')}"/>`;
  let overlay = role === 'cover' ? `<rect x="0" y="0" width="768" height="180" fill="url(#shade)"/><text x="42" y="86" ${font} font-size="42" font-weight="600" fill="white">${escapeXml(coverText)}</text><text x="44" y="136" ${font} font-size="22" fill="white">${escapeXml(brand)}</text>` : '';
  if (role === 'cover' && input.coverLayout === 'collage4') {
    if (collageImages.length !== 4 || new Set(collageImages.map(image => createHash('sha256').update(image).digest('hex'))).size !== 4)
      throw Object.assign(new Error('四宫格需要4张不同的成功配图'), { code: 'XHS_COLLAGE_NEEDS_FOUR_IMAGES' });
    photo = `<rect width="768" height="1024" fill="#231813"/>` + collageImages.map((image, i) => {
      const imageFormat = detectImageFormat(image);
      if (!imageFormat) throw new Error('四宫格素材无效');
      return `<image x="${i % 2 ? 394 : 24}" y="${i < 2 ? 164 : 572}" width="350" height="388" preserveAspectRatio="xMidYMid slice" href="data:${imageFormat.mime};base64,${image.toString('base64')}"/>`;
    }).join('');
  } else if (role === 'cover' && input.coverLayout === 'headline') {
    const lines = [...coverText].reduce((rows, character, i) => { if (i % 8 === 0) rows.push(''); rows[rows.length - 1] += character; return rows; }, []);
    photo = `<rect width="768" height="1024" fill="#fff3de"/><image y="330" width="768" height="694" preserveAspectRatio="xMidYMid slice" href="data:${format.mime};base64,${bytes.toString('base64')}"/>`;
    overlay = `<text x="42" y="60" ${font} font-size="24" fill="#6d3321">${escapeXml(brand)}</text>` + lines.map((line, i) => `<text x="40" y="${155 + i * 90}" ${font} font-size="76" font-weight="800" fill="#ad301f">${escapeXml(line)}</text>`).join('');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024"><defs><linearGradient id="shade" x2="0" y2="1"><stop stop-color="#000" stop-opacity=".62"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient></defs>${photo}${overlay}<rect x="556" y="977" width="194" height="30" rx="5" fill="#000" fill-opacity=".55"/><text x="653" y="998" text-anchor="middle" ${font} font-size="17" fill="white">AI创意配图 · 非实拍</text></svg>`;
}
export async function renderXhsImage(bytes, options) {
  return renderSvgToPng(xhsImageLayoutSvg(bytes, options), { width: 768, height: 1024 });
}

export function xhsNoteMarkdown(output) {
  return [output.title, output.body, output.tags.map(tag => `#${tag}`).join(' '),
    output.firstComment ? `评论区首评：${output.firstComment}` : ''].filter(Boolean).join('\n\n');
}

export function xhsNoteFailure(error) {
  const phase = ['generate', 'persist', 'validate_billing', 'settle', 'record'].includes(error?.deliveryPhase)
    ? error.deliveryPhase : 'generate';
  const timedOut = error?.name === 'AbortError'
    || ['ETIMEDOUT', 'ECONNABORTED', 'AI_TIMEOUT', 'REQUEST_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.code)
    || /timed?\s*out|timeout|超时/i.test(String(error?.message || ''));
  if (error?.code === 'XHS_NO_OUTPUT') return { code: 'XHS_EMPTY_RESULT', phase, message: '模型没有返回可用图文' };
  if (timedOut) return { code: 'XHS_UPSTREAM_TIMEOUT', phase, message: '图文生成服务响应超时，未收到完整结果' };
  if (phase === 'persist') return { code: 'XHS_OUTPUT_SAVE_FAILED', phase, message: '图文保存暂时出现异常' };
  return { code: 'XHS_GENERATION_FAILED', phase, message: '图文生成服务出现异常，未能完成本次任务' };
}

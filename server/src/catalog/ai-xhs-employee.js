import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const hash = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const engineHash = hash(readFileSync(new URL('../engines/ai-xhs-note.js', import.meta.url))).slice(7);
const template = '读取老板上传的菜品与门头照片及品牌名，生成具体、有画面感的小红书标题、短段正文、标签、首评，并调用GPT Image 2参考图编辑按确认方案生成6、9或12张各有叙事职责的3:4配图（旧3张任务继续可读）。支持种草推荐、对比测评、点单攻略、聚餐探店、新品推荐、品牌故事六类内容；测评探店不假装已体验，新品与品牌故事只用用户确认事实。封面可选食欲大图、以4张不同成功素材本地合成的四宫格或本地中文排字大字报，后续页用不同观察视角推进，不反复使用大字报。保留锅型、菜形和品牌，不把不明配菜猜成确定菜名。人物仅在用户选择时加入AI成年女性氛围，明确标为AI创意非真实顾客。文案先交付，图片逐张结算，失败仅重试安全可重试项；已成功内容保留。老板编辑选择后自行发布，不编造价格、地址、优惠或顾客体验。';
const definitions = [
  { name: '真实照片理解', emoji: '📷', desc: '通过视觉模型读取用户自有照片，仅描述可见事实' },
  { name: '一键图文发布包', emoji: '✍️', desc: '交付标题、正文、标签、首评，Image2以真实参考图生成6/9/12张可下载配图，原图保留' },
  { name: '编辑与选择', emoji: '📝', desc: '完整保留产出，质量建议不重复收费生成，由用户决定采纳与手动发布' },
];
const outputKeys = ['title', 'body', 'tags', 'firstComment', 'imagePlan', 'generatedImagePlan', 'warnings'];
const approval = { code: 'review', mode: 'review', description: '先交付结果，再由用户编辑并选择采纳或不采纳；不自动发布' };
const connector = { kind: 'xhs_note_generation', primary: true, addon: false, legacyHandler: null,
  newProjectStatus: 'single_station', status: 'single_station', mode: 'employee_generation',
  requirements: { inputs: ['brandName', 'fileIds'], liveData: 'not_required', credentials: ['server_runtime_vision_model'], humanApproval: 'review' },
  executeBoundary: '视觉文案先交付，Image2参考图编辑逐图保存和计费；仅重试失败且费用已明确的图，用户自行发布' };

export const AI_XHS_EMPLOYEE = {
  idx: 11, key: 'xhs_note', person: null, name: 'AI小红书种草员', group: '图文种草部', moduleGroup: 'content_commerce',
  skill: 'AI-XHS-Note', emoji: '📷', color: '#d84a59', duty: template,
  intro: '上传菜品、门头照片和品牌名，一键生成标题、正文、标签、首评与6/9/12张AI创意配图；文案先可用，图片可下载，失败图单独重试。',
  approval: 'review', optional: false,
  capabilities: definitions.map(sourceDefinition => ({ ...sourceDefinition, required: true, enabled: true, locked: true, sourceDefinition, sourceFingerprint: hash(JSON.stringify(sourceDefinition)) })),
  outputKeys, skillProfile: { catalog: 'native-content-employee', employeeIdx: 11, expectedSkillCount: 0, verificationStatus: 'native_verified' },
  pipelinePrompt: { messageMode: 'single_user', legacyBuilder: 'xhsNotePrompt', assemblyOrder: ['brand', 'photos', 'confirmed_details', 'publish_pack'], template, sourceTemplate: template, sourceFingerprint: hash(template) },
  soloPrompt: { messageMode: 'single_user', legacyBuilder: 'xhsNotePrompt', template,
    placeholders: { direction: '品牌名', material: '菜品与门头照片', feedback: '可选卖点' } },
  placeholders: { direction: '品牌名', material: '菜品与门头照片', feedback: '可选卖点' },
  systemPrompt: { messageMode: 'none', template: null, reason: '运行提示词由ai-xhs-note引擎提供' },
  visualReferences: [{ title: '美图设计室餐饮探店封面模板', url: 'https://www.designkit.cn/topic/cover-of-xiaohongshu-food-exploration-store', use: '大主体、短封面字、整套版式一致；借鉴方法不复制模板' }, { title: '美图设计室美食封面设计', url: 'https://www.designkit.cn/article/xhsmstdfmsjrhtsssdjl20250715', use: '按菜品和门店选择构图，不堆地址评分或虚构点击数据' }],
  workMethod: {
    input: { upstream: '品牌名', context: ['用户上传的菜品与门头照片', '老板确认的卖点（选填）'] },
    execution: { handler: 'xhsNotePrompt', capabilities: template, skills: '照片事实、具体菜品标题、短段正文、标签首评、Image2参考图封面与细节', webRequired: false, realtimeSteps: true },
    output: { duty: '可编辑的小红书图文发布包', keys: outputKeys, primaryArtifact: 'xhs_note' },
    approval, handoff: { target: '老板复制发布', optional: false, qualityGateBefore: false },
  },
  defaultWorkConfig: { common: { capabilitiesRequired: true, capabilitiesEnabled: true, capabilitiesLocked: true, skillVerificationStatus: 'native_verified', textModel: null, imageModel: 'gpt-image-2', approval: 'review', optional: false, messageMode: 'single_user' }, roleSpecific: { maxReferences: 6, workflow: 'ai_xhs_note', imageCount: 6, imageCounts: [6, 9, 12], style: 'seed', styles: ['seed', 'review', 'guide', 'visit', 'new_product', 'story'], coverLayout: 'photo', coverLayouts: ['photo', 'collage4', 'headline'], imageAspectRatio: '3:4', includeDiner: false } },
  dispatchForm: { mode: 'single_station', fields: [
    { key: 'direction', label: '品牌名', type: 'text', required: true },
    { key: 'material', label: '菜品或门头照片', type: 'image_upload', required: true, minItems: 1, maxItems: 6 },
    { key: 'feedback', label: '卖点补充', type: 'textarea', required: false },
  ], result: { format: 'json', persistedAsAsset: true, supportsRedoFeedback: true } },
  outputSchema: { format: 'json_object', keys: outputKeys, contract: JSON.stringify({ title: '标题', body: '正文', tags: ['标签'], firstComment: '首评', imagePlan: [{ fileId: 1, caption: '说明' }], generatedImagePlan: [{ id: 'cover', purpose: '食欲封面', visualTask: '一份主菜占据主视觉' }], warnings: [] }), primaryArtifact: 'xhs_note' },
  connectorPolicy: { executionBoundary: connector.executeBoundary, connectors: [connector] },
  sourceProvenance: { project: 'NanoWork当前项目', referencePath: 'server/src/engines/ai-xhs-note.js', referenceSha256: engineHash, legacyIdx: 11, snapshotDate: '2026-09-05', sourceCapabilitySetFingerprint: hash(JSON.stringify(definitions)), sourcePromptFingerprint: hash(template), native: true, sourceBoundary: 'NanoWork原生岗位，不改变旧10岗来源快照' },
  runtime: { mode: 'single_station', workflow: 'ai_xhs_note', businessEndpoint: '/api/content/ai-xhs-note', evidenceRequired: true },
  permissions: { profileAudience: ['boss', 'admin', 'platform_super'], dispatchAudience: 'authenticated_tenant_user', mayEditFactoryProfile: false, mayDisableRequiredCapabilities: false, mayPublishExternallyWithoutHumanApproval: false },
};

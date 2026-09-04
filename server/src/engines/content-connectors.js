import {
  CONTENT_EMPLOYEE_ROSTER,
  contentEmployeeByIdx,
} from '../catalog/content-crew.js';
import { buildContentEmployeeConnectorExecution } from './content-employee-workbench.js';
import { contentFreshnessWindowDays } from './content-source-freshness.js';

// 真联网引擎依赖 db.js（云雾配置/密钥）；本模块保持可被纯目录测试静态导入，
// 只在真正执行联网时按需加载。
async function loadLiveResearchEngine() {
  return import('./content-live-research.js');
}

/**
 * 可真联网的连接器 → 统一检索入口的 kind。分发官 publish_package 与复盘官
 * performance_retro 不在其中：不做自动发布、不自动抓平台数据（宣讲纪要：
 * 自动分发已暂停，避免被平台判定违规）。
 */
export const CONTENT_LIVE_RESEARCH_CONNECTORS = Object.freeze({
  trend_research: 'trend',
  evidence_research: 'intel',
  benchmark_analysis: 'decompose',
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value, max = 10_000) {
  if (typeof value !== 'string') return '';
  return value.replaceAll('\u0000', '').trim().slice(0, max);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeHttpUrl(value) {
  const text = safeText(value, 2_000);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

const EMPLOYEE_GENERATION_ENDPOINTS = Object.freeze({
  copy: '/api/content/generate',
  dailyPack: '/api/content/daily-pack',
  image: '/api/content/generate-image',
  video: '/api/content/generate-video',
  ppt: '/api/content/generate-ppt',
  sales_video_plan: '/api/content/ai-sales-video',
  sales_video_generation: '/api/content/ai-sales-video',
});

function connectorBusinessEndpoint(employeeIdx, connector) {
  if (connector.mode === 'employee_generation') {
    const endpoint = EMPLOYEE_GENERATION_ENDPOINTS[connector.kind];
    if (!endpoint) throw new Error(`内容连接器运行登记无效：${connector.kind}缺少真实生成入口`);
    return endpoint;
  }
  return `/api/employee-workbench/content/${employeeIdx}/connectors/${connector.kind}/execute`;
}

function currentConnectorRequirements(requirements = {}) {
  const { humanApproval: _legacyHumanApproval, ...current } = clone(requirements);
  return {
    ...current,
    adoptionPolicy: 'central_auto_internal',
    executionAuthorization: 'external_paid_irreversible_only',
  };
}

function currentConnectorBoundary(value) {
  return String(value || '')
    .replaceAll('人工复核', '岗位质量门')
    .replaceAll('人工审核', '中央采用策略')
    .replaceAll('老板审批', '中央采用策略')
    .replaceAll('人类审批', '老板执行授权');
}

const descriptors = CONTENT_EMPLOYEE_ROSTER.flatMap(employee => (
  employee.connectorPolicy.connectors.map(connector => ({
    kind: connector.kind,
    employeeIdx: employee.idx,
    employeeKey: employee.key,
    employeeName: employee.name,
    employeeGroup: employee.group,
    primary: connector.primary,
    addon: connector.addon,
    mode: connector.mode,
    status: connector.status,
    executionType: connector.mode === 'employee_generation'
      ? 'employee_generation'
      : 'local_connector',
    businessEndpoint: connectorBusinessEndpoint(employee.idx, connector),
    requirements: currentConnectorRequirements(connector.requirements),
    executeBoundary: currentConnectorBoundary(connector.executeBoundary),
    // 运行期能力（不改 catalog JSON，指纹不变）：三类研究连接器可通过
    // executeContentConnectorLive 真联网；其余连接器保持零联网。
    networkAccess: Object.hasOwn(CONTENT_LIVE_RESEARCH_CONNECTORS, connector.kind),
    liveResearch: Object.hasOwn(CONTENT_LIVE_RESEARCH_CONNECTORS, connector.kind)
      ? {
        supported: true,
        kind: CONTENT_LIVE_RESEARCH_CONNECTORS[connector.kind],
        freshnessWindowDays: contentFreshnessWindowDays(CONTENT_LIVE_RESEARCH_CONNECTORS[connector.kind]),
        entry: 'executeContentConnectorLive',
        callerSuppliedFallback: connector.mode === 'verified_input_assist' ? 'liveData' : 'samples',
      }
      : { supported: false, kind: null, freshnessWindowDays: null, entry: null, callerSuppliedFallback: null },
  }))
));

const descriptorByKind = new Map(descriptors.map(descriptor => [descriptor.kind, descriptor]));

/**
 * 15 种内容连接器的唯一运行登记：保留 Paihuo 10 岗位原 13 项，
 * 并追加 NanoWork 原生 AI 带货员 2 项。目录、工作台与执行器共用同一份登记，
 * 避免“目录显示可用、运行器仍是占位”的双轨状态。
 */
export const CONTENT_CONNECTOR_REGISTRY = deepFreeze(descriptors);

export function connectorDescriptor(kind) {
  const descriptor = typeof kind === 'string' ? descriptorByKind.get(kind) : null;
  return descriptor ? deepFreeze(clone(descriptor)) : null;
}

function executionFacts() {
  return {
    networkAccess: false,
    externalActionsPerformed: [],
    costIncurred: false,
    credentialsAccepted: false,
  };
}

function blocked(descriptor, status, code, action, missing = []) {
  const requirements = descriptor
    ? clone(descriptor.requirements)
    : {
      inputs: ['supported_connector_kind'],
      liveData: 'not_required',
      credentials: [],
      adoptionPolicy: 'central_auto_internal',
      executionAuthorization: 'external_paid_irreversible_only',
    };
  return deepFreeze({
    ok: false,
    completed: false,
    kind: descriptor?.kind || null,
    mode: descriptor?.mode || null,
    catalogStatus: descriptor?.status || null,
    status,
    code,
    requirements,
    missing: [...missing],
    action,
    ...executionFacts(),
  });
}

function completed(descriptor, completedScope, output) {
  return deepFreeze({
    ok: true,
    completed: true,
    kind: descriptor.kind,
    mode: descriptor.mode,
    catalogStatus: descriptor.status,
    status: 'local_assist_completed',
    completedScope,
    requirements: clone(descriptor.requirements),
    output,
    disclaimer: '仅完成标明的本地辅助范围；没有发生联网检索、平台采集、账号操作或对外发布。',
    ...executionFacts(),
  });
}

function normalizedSources(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) return [];
  const output = [];
  for (const item of raw) {
    if (!plainObject(item)) return [];
    const title = safeText(item.title, 300);
    const source = safeText(item.source, 300);
    const observedAt = safeText(item.observedAt, 100);
    const excerpt = safeText(item.excerpt, 2_000);
    const url = safeHttpUrl(item.url);
    if (!title || !source || !observedAt || !excerpt) return [];
    output.push({
      title,
      source,
      observedAt,
      excerpt,
      url,
      verification: 'caller_supplied_not_network_verified',
    });
  }
  return output;
}

function executeTrend(descriptor, input, context) {
  const sources = normalizedSources(context.liveData ?? input.liveData);
  if (!sources.length) {
    return blocked(
      descriptor,
      'requires_live_data',
      'CONTENT_CONNECTOR_LIVE_DATA_REQUIRED',
      '请提供 liveData 数组；每条必须包含 title、source、observedAt、excerpt，可选 url。本连接器不会自行联网抓榜。',
      ['liveData[].title', 'liveData[].source', 'liveData[].observedAt', 'liveData[].excerpt'],
    );
  }
  const channels = Array.isArray(input.channels)
    ? input.channels.map(channel => safeText(channel, 100)).filter(Boolean).slice(0, 20)
    : [];
  return completed(descriptor, 'caller_supplied_signal_organization', {
    briefing: `已按调用方提供的 ${sources.length} 条观测记录形成待审信号清单；未执行实时抓榜，热度与生命周期需人工复核。`,
    requestedChannels: channels,
    channelScan: sources.map(item => ({
      channel: item.source,
      observedAt: item.observedAt,
      signal: item.excerpt,
      sourceUrl: item.url,
      verification: item.verification,
    })),
    candidateTopics: sources.slice(0, 5).map(item => ({
      title: item.title,
      source: item.source,
      observedAt: item.observedAt,
      evidenceExcerpt: item.excerpt,
      heat: 'not_assessed',
    })),
  });
}

function executeEvidence(descriptor, input, context) {
  const sources = normalizedSources(context.liveData ?? input.liveData);
  if (!sources.length) {
    return blocked(
      descriptor,
      'requires_live_data',
      'CONTENT_CONNECTOR_LIVE_DATA_REQUIRED',
      '请提供 liveData 来源台账；每条必须包含 title、source、observedAt、excerpt，可选 url。没有来源时不会生成“已核验”结论。',
      ['liveData[].title', 'liveData[].source', 'liveData[].observedAt', 'liveData[].excerpt'],
    );
  }
  return completed(descriptor, 'caller_supplied_evidence_ledger', {
    researchQuestion: safeText(input.task, 1_000) || '未提供研究问题',
    sourceCoverage: [...new Set(sources.map(item => item.source))],
    evidenceLedger: sources.map((item, index) => ({
      id: index + 1,
      claimCandidate: item.excerpt,
      title: item.title,
      source: item.source,
      observedAt: item.observedAt,
      url: item.url,
      verification: item.verification,
    })),
    unresolved: ['来源真实性、原文上下文与交叉印证仍需人工或已授权检索链核验。'],
  });
}

function normalizedSamples(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) return [];
  const output = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const body = safeText(item, 20_000);
      if (!body) return [];
      output.push({ title: '未命名样本', platform: null, body, suppliedMetrics: null });
      continue;
    }
    if (!plainObject(item)) return [];
    const title = safeText(item.title, 300);
    const body = safeText(item.body ?? item.content, 20_000);
    if (!title || !body) return [];
    output.push({
      title,
      platform: safeText(item.platform, 100) || null,
      body,
      suppliedMetrics: plainObject(item.metrics) ? clone(item.metrics) : null,
    });
  }
  return output;
}

function executeBenchmark(descriptor, input) {
  const samples = normalizedSamples(input.samples);
  if (!samples.length) {
    return blocked(
      descriptor,
      'requires_input',
      'CONTENT_CONNECTOR_INPUT_REQUIRED',
      '请提供 1-20 个 samples；字符串样本可直接传正文，对象样本必须包含 title 与 body/content。',
      ['samples'],
    );
  }
  return completed(descriptor, 'offline_sample_analysis_packet', {
    samples: samples.map((sample, index) => ({
      id: index + 1,
      title: sample.title,
      platform: sample.platform,
      length: [...sample.body].length,
      openingExcerpt: sample.body.slice(0, 120),
      suppliedMetrics: sample.suppliedMetrics,
      metricsStatus: sample.suppliedMetrics ? 'caller_supplied' : 'not_supplied',
    })),
    analysisDimensions: ['标题承诺', '开头钩子', '信息结构', '证据位置', '行动引导', '评论区待验证问题'],
    boundary: '这里只拆解调用方提供的样本；没有采集平台内容，也没有推断样本热度或伪造评论洞察。',
  });
}

function executeStyle(descriptor, input) {
  const sourceText = safeText(input.sourceText, 50_000);
  const styleGuide = safeText(input.styleGuide, 10_000);
  if (!sourceText || !styleGuide) {
    return blocked(
      descriptor,
      'requires_input',
      'CONTENT_CONNECTOR_INPUT_REQUIRED',
      '请同时提供 sourceText 原文和 styleGuide 文风规则；本地连接器只形成可交给文风师的改写契约。',
      [
        ...(!sourceText ? ['sourceText'] : []),
        ...(!styleGuide ? ['styleGuide'] : []),
      ],
    );
  }
  return completed(descriptor, 'style_rewrite_contract', {
    sourceText,
    styleGuide,
    preserve: ['事实、数字、专有名词与来源', '原始业务承诺边界', '未获授权不得新增的结论'],
    reviewChecklist: ['逐项核对事实未改变', '检查是否符合指定语气', '删除虚假稀缺与强迫表达', '人工确认后方可作为终稿'],
    body: null,
    bodyStatus: 'requires_existing_employee_generation_or_human_rewrite',
  });
}

function coverHtml(title, subtitle, platform) {
  const safeTitle = escapeHtml(title);
  const safeSubtitle = escapeHtml(subtitle);
  const safePlatform = escapeHtml(platform);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#f4efe6;color:#2d2923;font-family:system-ui,-apple-system,"Noto Sans SC",sans-serif}
    main{width:1080px;height:1440px;padding:96px;display:flex;flex-direction:column;justify-content:space-between;border:24px solid #2d2923}
    h1{font-size:112px;line-height:1.06;letter-spacing:-.04em;margin:0;max-width:880px}
    p{font-size:42px;line-height:1.4;margin:32px 0 0;max-width:820px}.platform{font-size:30px;letter-spacing:.12em}
  </style>
</head>
<body><main><section><h1>${safeTitle}</h1><p>${safeSubtitle}</p></section><div class="platform">${safePlatform}</div></main></body>
</html>`;
}

function executeCover(descriptor, input) {
  const title = safeText(input.title, 120);
  const platform = safeText(input.platform, 100);
  const subtitle = safeText(input.subtitle, 240);
  if (!title || !platform) {
    return blocked(
      descriptor,
      'requires_input',
      'CONTENT_CONNECTOR_INPUT_REQUIRED',
      '请提供 title 与 platform；可选 subtitle。本地只生成安全HTML封面草稿，不调用外部生图。',
      [...(!title ? ['title'] : []), ...(!platform ? ['platform'] : [])],
    );
  }
  return completed(descriptor, 'offline_cover_html_draft', {
    platform,
    size: '1080×1440',
    title,
    subtitle,
    html: coverHtml(title, subtitle, platform),
    imageStatus: 'not_generated',
    reviewChecklist: ['确认标题事实与授权', '检查平台安全区', '人工确认品牌色、字体和Logo授权'],
  });
}

function normalizedSections(raw, fallback) {
  if (Array.isArray(raw) && raw.length > 0 && raw.length <= 30) {
    const output = [];
    for (const section of raw) {
      if (typeof section === 'string') {
        const body = safeText(section, 20_000);
        if (!body) return [];
        output.push({ heading: `章节 ${output.length + 1}`, body });
        continue;
      }
      if (!plainObject(section)) return [];
      const heading = safeText(section.heading ?? section.title, 300);
      const body = safeText(section.body ?? section.content, 20_000);
      if (!heading || !body) return [];
      output.push({ heading, body });
    }
    return output;
  }
  const body = safeText(fallback, 50_000);
  return body ? [{ heading: '正文', body }] : [];
}

function completeHtml(title, sections) {
  const cards = sections.map(section => (
    `<section><h2>${escapeHtml(section.heading)}</h2><p>${escapeHtml(section.body).replaceAll('\n', '<br>')}</p></section>`
  )).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body{margin:0;background:#f7f4ee;color:#27231f;font-family:system-ui,-apple-system,"Noto Sans SC",sans-serif}
    main{max-width:1080px;margin:auto;padding:72px 32px 120px}h1{font-size:64px;line-height:1.1}
    section{margin-top:24px;padding:32px;border:2px solid #27231f;border-radius:20px;background:#fff}h2{font-size:32px}p{font-size:20px;line-height:1.8}
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${cards}</main></body>
</html>`;
}

function executeHtml(descriptor, input) {
  const title = safeText(input.title, 300);
  const sections = normalizedSections(input.sections, input.content);
  if (!title || !sections.length) {
    return blocked(
      descriptor,
      'requires_input',
      'CONTENT_CONNECTOR_INPUT_REQUIRED',
      '请提供 title，并提供 sections 数组或 content 正文。本地HTML不会加载外部脚本、字体或图片。',
      [...(!title ? ['title'] : []), ...(!sections.length ? ['sections|content'] : [])],
    );
  }
  return completed(descriptor, 'offline_complete_html', {
    summary: `根据调用方提供的 ${sections.length} 个章节生成离线HTML。`,
    html: completeHtml(title, sections),
    externalResources: [],
    scriptCount: 0,
  });
}

function executePublishPackage(descriptor, input, context) {
  const operation = safeText(context.operation ?? input.operation, 50) || 'package';
  if (operation !== 'package') {
    return blocked(
      descriptor,
      'requires_credentials',
      'CONTENT_CONNECTOR_EXTERNAL_PUBLISH_DENIED',
      '本连接器只生成发布包，不执行真实发布。真实发布请通过具备服务器端平台授权、幂等与审计能力的独立发布适配器；Boss亲自发起时不再产生二次审批。',
      ['server_side_platform_authorization', 'audited_publish_adapter'],
    );
  }
  const content = safeText(input.content, 50_000);
  const title = safeText(input.title, 300);
  const platforms = Array.isArray(input.platforms)
    ? [...new Set(input.platforms.map(item => safeText(item, 100)).filter(Boolean))].slice(0, 20)
    : [];
  if (!content || !platforms.length) {
    return blocked(
      descriptor,
      'requires_input',
      'CONTENT_CONNECTOR_INPUT_REQUIRED',
      '请提供 content 与非空 platforms 数组；只会生成可直接进入后续业务流程的本地发布包。',
      [...(!content ? ['content'] : []), ...(!platforms.length ? ['platforms'] : [])],
    );
  }
  return completed(descriptor, 'offline_publish_package', {
    versions: platforms.map(platform => ({
      platform,
      title: title || '待人工填写标题',
      body: content,
      status: 'draft_for_human_review',
      checklist: ['核对事实、版权与敏感信息', '在平台预览中检查格式', '由有权限的人类终审并发布'],
    })),
    publishPlan: '未生成自动发布时间或真实发布任务；请按业务节奏人工排期。',
    actualPublish: false,
  });
}

function executeRetro(descriptor, input, context) {
  const contentId = safeText(String(input.contentId ?? ''), 200);
  if (!contentId) {
    return blocked(
      descriptor,
      'requires_input',
      'CONTENT_CONNECTOR_INPUT_REQUIRED',
      '请提供 contentId；metrics 可选。没有真实指标时只输出数据采集计划。',
      ['contentId'],
    );
  }
  const metrics = plainObject(context.liveData)
    ? clone(context.liveData)
    : plainObject(input.metrics)
      ? clone(input.metrics)
      : null;
  if (!metrics || Object.keys(metrics).length === 0) {
    return completed(descriptor, 'metrics_collection_plan_only', {
      contentId,
      reportStatus: 'awaiting_real_metrics',
      collectionPlan: ['记录平台与发布时间', '采集曝光、点击、互动、转化的原始口径', '在 T+1、T+3、T+7 留存带时间戳快照'],
      missingMetrics: ['platform', 'publishedAt', 'impressions', 'clicks_or_reads', 'interactions', 'business_conversion'],
      conclusions: [],
    });
  }
  return completed(descriptor, 'caller_supplied_metrics_review_packet', {
    contentId,
    metrics,
    metricsStatus: 'caller_supplied_not_platform_verified',
    reviewQuestions: ['各指标的平台口径是否一致？', '是否存在投放、活动或库存等外部变量？', '哪些结论能被原始快照复核？'],
    conclusions: [],
    boundary: '仅整理调用方提供的指标，不自动推断因果关系或经营成效。',
  });
}

const localExecutors = new Map([
  ['trend_research', executeTrend],
  ['evidence_research', executeEvidence],
  ['benchmark_analysis', executeBenchmark],
  ['style_rewrite', executeStyle],
  ['cover', executeCover],
  ['html', executeHtml],
  ['publish_package', executePublishPackage],
  ['performance_retro', executeRetro],
]);

for (const descriptor of descriptors) {
  const hasLocalExecutor = localExecutors.has(descriptor.kind);
  if (descriptor.mode === 'employee_generation' && hasLocalExecutor) {
    throw new Error(`内容连接器运行登记无效：${descriptor.kind}不得绕过单员工生成链`);
  }
  if (descriptor.mode !== 'employee_generation' && !hasLocalExecutor) {
    throw new Error(`内容连接器运行登记无效：${descriptor.kind}缺少本地执行器`);
  }
}

/**
 * 执行内容连接器的无副作用边界。
 *
 * - 本地辅助连接器只生成契约化本地产物；
 * - 实时数据缺失、发布请求或单员工生成请求均封闭失败并返回 requirements；
 * - 本函数不读取凭证、不联网、不调用模型、不计费、不发布。
 */
export function executeContentConnector(kind, input = {}, context = {}) {
  const descriptor = connectorDescriptor(kind);
  if (!descriptor) {
    return blocked(
      null,
      'unsupported_connector',
      'CONTENT_CONNECTOR_NOT_FOUND',
      '请先从 CONTENT_CONNECTOR_REGISTRY 读取受支持的 kind。',
      ['supported_connector_kind'],
    );
  }
  if (!plainObject(input) || !plainObject(context)) {
    return blocked(
      descriptor,
      'invalid_request',
      'CONTENT_CONNECTOR_INVALID_REQUEST',
      'input 与 context 必须是普通对象。',
      ['input_object', 'context_object'],
    );
  }
  if (descriptor.mode === 'employee_generation') {
    return blocked(
      descriptor,
      'requires_employee_generation',
      'CONTENT_CONNECTOR_EMPLOYEE_GENERATION_REQUIRED',
      `请通过现有“${descriptor.employeeName}”单员工生成链执行；该链负责授权、计费、模型调用、输出校验与审计。`,
      ['existing_employee_generation_chain'],
    );
  }
  const executor = localExecutors.get(kind);
  if (!executor) {
    return blocked(
      descriptor,
      'runtime_unavailable',
      'CONTENT_CONNECTOR_RUNTIME_UNAVAILABLE',
      '该连接器没有已登记的本地执行器，必须保持阻断。',
      ['registered_local_executor'],
    );
  }
  return executor(descriptor, input, context);
}

/**
 * 只编译现有单员工生成链的完整岗位执行包，不调用模型或产生费用。
 * 路由层仍需在自己的鉴权、计费和输出校验事务内执行实际生成。
 */
export function prepareContentConnectorEmployeeExecution(kind, task, options = {}) {
  const descriptor = connectorDescriptor(kind);
  if (!descriptor) throw new Error(`未知内容连接器：${String(kind)}`);
  if (descriptor.mode !== 'employee_generation') {
    throw new Error(
      `内容连接器“${descriptor.kind}”只能通过 executeContentConnector 执行，`
      + '不得编译或转入单员工模型生成链',
    );
  }
  const employee = contentEmployeeByIdx(descriptor.employeeIdx);
  const connectorContract = plainObject(options.connectorContract)
    ? options.connectorContract
    : {
      name: `${descriptor.employeeName}·${descriptor.kind}`,
      outputFormat: employee.outputSchema.primaryArtifact,
      instruction: descriptor.executeBoundary,
    };
  const execution = buildContentEmployeeConnectorExecution(descriptor.employeeIdx, task, {
    connectorKind: descriptor.kind,
    connectorContract,
    tenantOverlay: plainObject(options.tenantOverlay) ? options.tenantOverlay : {},
  });
  return deepFreeze({
    descriptor,
    execution,
    modelCalled: false,
    billingPerformed: false,
    externalActionPerformed: false,
  });
}

// ===== 真联网执行（趋势官 / 情报员 / 拆解师）=====

const LIVE_RESEARCH_FEATURE = '内容连接器·联网检索';
const LIVE_RESEARCH_REF_TYPE = 'content_connector_live_research';
const LIVE_RESEARCH_DEFAULT_MODEL = () => process.env.NANOWORK_RESEARCH_MODEL || 'claude-opus-4-8';

function callerSuppliedLiveInput(descriptor, input, context) {
  if (descriptor.kind === 'benchmark_analysis') return normalizedSamples(input.samples).length > 0;
  return normalizedSources(context.liveData ?? input.liveData).length > 0;
}

function publicLiveSource(item, index) {
  return {
    id: index + 1,
    sourceId: `来源${index + 1}`,
    title: item.title,
    url: item.url,
    source: item.source,
    snippet: item.snippet,
    fetchedAt: item.fetchedAt,
    publishedAt: item.publishedAt ?? null,
    stale: item.stale ?? null,
    qualityScore: item.qualityScore,
    lane: item.lane,
    verification: item.controlledBody ? 'controlled_web_fetch_verified' : 'search_snippet_only',
    bodySha256: item.bodySha256 || null,
  };
}

function liveOutputFor(descriptor, input, research) {
  const sources = research.items.map(publicLiveSource);
  const verified = sources.filter(item => item.verification === 'controlled_web_fetch_verified');
  const staleNote = research.freshness.staleCount
    ? `；${research.freshness.staleCount} 条超出 ${research.freshness.windowDays} 天时效窗口已标注 stale`
    : '';
  const base = {
    sources,
    freshness: research.freshness,
    freshnessSection: research.freshnessSection,
    lane: research.lane,
    provider: research.provider,
    fetchedAt: research.fetchedAt,
  };
  if (descriptor.kind === 'trend_research') {
    const channels = Array.isArray(input.channels)
      ? input.channels.map(channel => safeText(channel, 100)).filter(Boolean).slice(0, 20)
      : [];
    return {
      ...base,
      briefing: `已通过真实联网检索取得 ${sources.length} 条来源（${verified.length} 条受控正文已核验）${staleNote}；热度与生命周期仍需岗位模型或人工结合来源判断，本连接器不推断热度。`,
      requestedChannels: channels,
      channelScan: sources.map(item => ({
        channel: item.source,
        observedAt: item.fetchedAt,
        publishedAt: item.publishedAt,
        stale: item.stale,
        signal: item.snippet,
        sourceUrl: item.url,
        verification: item.verification,
      })),
      candidateTopics: verified.slice(0, 5).map(item => ({
        title: item.title,
        source: item.source,
        observedAt: item.fetchedAt,
        publishedAt: item.publishedAt,
        stale: item.stale,
        evidenceExcerpt: item.snippet,
        heat: 'not_assessed',
      })),
    };
  }
  if (descriptor.kind === 'evidence_research') {
    return {
      ...base,
      researchQuestion: safeText(input.task, 1_000) || '未提供研究问题',
      sourceCoverage: [...new Set(sources.map(item => item.source))],
      evidenceLedger: sources.map(item => ({
        id: item.id,
        claimCandidate: item.snippet,
        title: item.title,
        source: item.source,
        observedAt: item.fetchedAt,
        publishedAt: item.publishedAt,
        stale: item.stale,
        url: item.url,
        verification: item.verification,
      })),
      unresolved: [
        '原文上下文与交叉印证仍需岗位模型或人工完成；发布时间未知的来源不能当作最新信息引用。',
      ],
    };
  }
  return {
    ...base,
    samples: verified.map(item => ({
      id: item.id,
      title: item.title,
      platform: item.source,
      url: item.url,
      fetchedAt: item.fetchedAt,
      publishedAt: item.publishedAt,
      stale: item.stale,
      length: [...String(item.snippet || '')].length,
      openingExcerpt: String(item.snippet || '').slice(0, 120),
      suppliedMetrics: null,
      metricsStatus: 'not_available_from_public_page',
    })),
    analysisDimensions: ['标题承诺', '开头钩子', '信息结构', '证据位置', '行动引导', '评论区待验证问题'],
    boundary: '样本来自公开网页正文；没有采集平台互动数据，也不推断热度或评论洞察。',
  };
}

function liveResearchEstimateCredits(credits, query) {
  return credits.estimateCallCredits({
    kind: 'text',
    model: LIVE_RESEARCH_DEFAULT_MODEL(),
    texts: [query],
    outputTokens: 2_000,
    overheadTokens: 4_000,
  });
}

function fixedLaneCredits(credits, lane) {
  const configured = credits.billing()?.liveResearch;
  const value = plainObject(configured) ? Number(configured[lane]) : 0;
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

async function defaultBillingAdapter() {
  const credits = await import('./credits.js');
  return {
    hold: ({ userId, tenantId, query, note }) => credits.holdCredits({
      userId,
      tenantId,
      feature: LIVE_RESEARCH_FEATURE,
      kind: 'text',
      model: LIVE_RESEARCH_DEFAULT_MODEL(),
      credits: liveResearchEstimateCredits(credits, query),
      refType: LIVE_RESEARCH_REF_TYPE,
      refId: null,
      note,
    }),
    settle: (hold, research) => {
      const usage = research?.cost?.usage || {};
      const tokenLane = research?.lane === 'claude_websearch'
        && (Number(usage.inputTokens) > 0 || Number(usage.outputTokens) > 0);
      if (tokenLane) {
        return credits.settleHold(hold, {
          usage: { inputTokens: Number(usage.inputTokens) || 0, outputTokens: Number(usage.outputTokens) || 0 },
          model: LIVE_RESEARCH_DEFAULT_MODEL(),
          aiMode: 'api',
          note: `联网检索 lane=${research.lane} 按真实 token 结算`,
        });
      }
      return credits.settleHold(hold, {
        credits: fixedLaneCredits(credits, research?.lane),
        aiMode: 'api',
        note: `联网检索 lane=${research?.lane || 'none'} 无模型 token，按通道固定费用结算`,
      });
    },
    release: (hold, note) => credits.releaseHold(hold, note),
  };
}

function liveFacts(research, settlement) {
  return {
    networkAccess: true,
    externalActionsPerformed: ['web_search', 'controlled_web_fetch'],
    costIncurred: Number(settlement?.credits || 0) > 0,
    credentialsAccepted: false,
  };
}

/**
 * 趋势官 / 情报员 / 拆解师连接器的真联网执行。
 *
 * - 调用方已提供 liveData / samples 时沿用同步的本地整理路径（零联网、零计费）；
 * - 否则先 hold 再检索（D-014），按 lane 结算：Claude WebSearch 按真实 token，
 *   TinyFish / 商业 API 按通道固定费用（默认 0）；未取得来源全额释放；
 * - 未配置任何检索通道时返回 status='unavailable'，绝不回退到模板冒充（D-019 / D-055）。
 *
 * @param {object} actor `{ userId, tenantId, hold? }`：hold 存在时复用调用方（如流水线）的预授权，不再二次占扣。
 */
export async function executeContentConnectorLive(kind, input = {}, context = {}, actor = {}, deps = {}) {
  const descriptor = connectorDescriptor(kind);
  if (!descriptor || !descriptor.liveResearch?.supported || !plainObject(input) || !plainObject(context)) {
    return executeContentConnector(kind, input, context);
  }
  if (callerSuppliedLiveInput(descriptor, input, context)) {
    return executeContentConnector(kind, input, context);
  }
  const engine = typeof deps.readinessFn === 'function' && typeof deps.runLiveResearch === 'function'
    ? null
    : await loadLiveResearchEngine();
  const readinessFn = typeof deps.readinessFn === 'function'
    ? deps.readinessFn
    : engine.contentLiveResearchReadiness;
  const readiness = readinessFn();
  if (!readiness.configured) {
    return deepFreeze({
      ...blocked(
        descriptor,
        'unavailable',
        'CONTENT_CONNECTOR_LIVE_RESEARCH_UNAVAILABLE',
        '联网检索未配置：请在接口管理中配置 TinyFish、Claude CLI（云雾）或博查 / Tavily / Serper 任一通道；也可改为提供 liveData 让本连接器只整理调用方来源。未配置前不会用模板冒充实时结果。',
        ['configured_live_research_lane|liveData'],
      ),
      liveResearch: { configured: false, readiness },
    });
  }
  const brief = safeText(
    input.task || input.topic || input.brief || input.direction || context.task || context.brief,
    4_000,
  );
  if (!brief) {
    return blocked(
      descriptor,
      'requires_input',
      'CONTENT_CONNECTOR_INPUT_REQUIRED',
      '请提供 task（研究主题）；也可提供 liveData / samples 走调用方来源整理。',
      ['task'],
    );
  }
  const runResearch = typeof deps.runLiveResearch === 'function'
    ? deps.runLiveResearch
    : engine.runContentLiveResearch;
  const billingAdapter = deps.billing === null
    ? null
    : plainObject(deps.billing)
      ? deps.billing
      : await defaultBillingAdapter();
  const query = `${descriptor.employeeName}·${descriptor.kind}：${brief}`;
  let hold = plainObject(actor.hold) ? actor.hold : null;
  const reusedHold = Boolean(hold);
  if (!hold && billingAdapter) {
    hold = billingAdapter.hold({
      userId: actor.userId ?? null,
      tenantId: actor.tenantId ?? null,
      query,
      note: `${descriptor.employeeName}/${descriptor.kind} 联网检索前预授权；未取得来源全额释放`,
    });
  }
  let research;
  try {
    research = await runResearch({
      kind: descriptor.liveResearch.kind,
      brief,
      platform: safeText(input.platform, 60) || null,
      channels: Array.isArray(input.channels) ? input.channels : [],
      tenantId: actor.tenantId ?? null,
      budget: plainObject(input.budget) ? input.budget : {},
      signal: deps.signal || null,
    });
  } catch (error) {
    if (hold && !reusedHold && billingAdapter) {
      billingAdapter.release(hold, `联网检索执行失败（${safeText(error?.code || error?.name || 'failed', 80)}），预授权全额释放`);
    }
    throw error;
  }
  let settlement = null;
  if (hold && !reusedHold && billingAdapter) {
    settlement = research.ok || research.status === 'insufficient_evidence'
      ? billingAdapter.settle(hold, research)
      : billingAdapter.release(hold, `联网检索未取得可核验来源（${research.status}），预授权全额释放`);
  }
  const billingEvidence = {
    holdReused: reusedHold,
    heldCredits: hold ? Number(hold.credits || 0) : 0,
    settledCredits: settlement ? Number(settlement.credits || 0) : null,
    lane: research.lane,
    usage: research.cost?.usage || { inputTokens: 0, outputTokens: 0 },
    costUsd: research.cost?.costUsd || 0,
  };
  const evidence = {
    lane: research.lane,
    provider: research.provider,
    readiness,
    fetchedAt: research.fetchedAt,
    freshness: research.freshness,
    provenance: research.provenance,
    billing: billingEvidence,
  };
  if (research.status === 'unavailable' || research.status === 'no_results') {
    return deepFreeze({
      ...blocked(
        descriptor,
        research.status,
        research.status === 'unavailable'
          ? 'CONTENT_CONNECTOR_LIVE_RESEARCH_UNAVAILABLE'
          : 'CONTENT_CONNECTOR_LIVE_RESEARCH_NO_RESULTS',
        research.note || '联网检索未取得可核验来源；不会用模板补位。',
        ['verifiable_public_sources'],
      ),
      networkAccess: research.provenance?.externalCall === true,
      liveResearch: evidence,
    });
  }
  const output = liveOutputFor(descriptor, input, research);
  return deepFreeze({
    ok: research.ok,
    completed: research.ok,
    kind: descriptor.kind,
    mode: descriptor.mode,
    catalogStatus: descriptor.status,
    status: research.ok ? 'live_research_completed' : 'live_research_insufficient',
    code: research.ok ? null : 'CONTENT_CONNECTOR_LIVE_RESEARCH_INSUFFICIENT',
    completedScope: research.ok ? 'live_web_research_with_controlled_fetch' : 'live_web_research_snippets_only',
    requirements: clone(descriptor.requirements),
    output,
    action: research.ok ? null : research.note,
    disclaimer: '来源经真实联网检索与受控 WebFetch 取得；每条均带抓取时间，发布时间未知者不冒充最新；本连接器不做自动发布、不采集账号数据。',
    liveResearch: evidence,
    ...liveFacts(research, settlement),
  });
}

import crypto from 'node:crypto';

import { getConfig, getTenantConfig } from '../db.js';
import { CONTENT_CONNECTOR_REGISTRY } from './content-connectors.js';
import {
  appBotReady,
  appReady,
  feishuConfig,
  feishuManagerSummary,
} from './feishu.js';
import { schedulerEnabled, schedulerMaxConcurrent } from './scheduler.js';
import { webSearchProviders } from './websearch.js';
import {
  yunwuApiKey,
  yunwuKeySource,
} from './yunwu.js';

const DEFAULT_CHECK_TTL_MS = 15 * 60 * 1000;
const CHECK_OUTCOMES = new Set(['passed', 'failed']);
const PROCESS_CHECKS = new Map();

function nowMs(value = Date.now()) {
  if (value instanceof Date) return value.getTime();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function present(value) {
  return Boolean(String(value || '').trim());
}

function redactText(value) {
  return String(value ?? '')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/giu, '[已脱敏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/giu, 'Bearer [已脱敏]')
    .replace(/(https?:\/\/)[^/@\s]+@/giu, '$1[已脱敏]@')
    .replace(/([?&](?:api[_-]?key|key|token|secret)=)[^&#\s]+/giu, '$1[已脱敏]')
    .replace(
      /((?:api[_ -]?key|token|secret|authorization|private[_ -]?key)\s*[:=]\s*)[^\s,;]+/giu,
      '$1[已脱敏]',
    )
    .slice(0, 500);
}

function sanitizeValue(value, depth = 0) {
  if (depth > 4) return '[已截断]';
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeValue(item, depth + 1));
  if (typeof value !== 'object') return redactText(value);
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    if (/(?:secret|token|password|privateKey|apiKey|authorization)/iu.test(key)) {
      output[key] = '[已脱敏]';
    } else {
      output[key] = sanitizeValue(item, depth + 1);
    }
  }
  return output;
}

function stableFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function processCheckKey(channelKey, tenantId) {
  return `${Number(tenantId) || 0}:${String(channelKey || '')}`;
}

function yunwuBaseUrl() {
  return getConfig('yunwu_base_url', null)
    || process.env.YUNWU_BASE_URL
    || 'https://yunwu.ai/v1';
}

function publicBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/u, '');
  } catch {
    return null;
  }
}

function aiConfigurationFacts() {
  const yunwuKey = String(yunwuApiKey() || '').trim();
  const anthropicKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (yunwuKey) {
    return {
      provider: 'yunwu',
      keySource: yunwuKeySource(),
      baseUrl: yunwuBaseUrl(),
      secret: yunwuKey,
    };
  }
  if (anthropicKey) {
    return {
      provider: 'anthropic',
      keySource: 'environment',
      baseUrl: 'https://api.anthropic.com',
      secret: anthropicKey,
    };
  }
  return {
    provider: 'template',
    keySource: 'none',
    baseUrl: null,
    secret: '',
  };
}

function searchConfigurationFacts() {
  return {
    bocha: String(process.env.BOCHA_API_KEY || '').trim(),
    tavily: String(process.env.TAVILY_API_KEY || '').trim(),
    serper: String(process.env.SERPER_API_KEY || '').trim(),
  };
}

function paymentConfigurationFacts(channelKey) {
  if (channelKey === 'payment_wechat') {
    return {
      mchid: String(process.env.WXPAY_MCHID || '').trim(),
      serialNo: String(process.env.WXPAY_SERIAL_NO || '').trim(),
      privateKey: String(process.env.WXPAY_PRIVATE_KEY || '').trim(),
      apiV3Key: String(process.env.WXPAY_APIV3_KEY || '').trim(),
      appId: String(process.env.WXPAY_APPID || '').trim(),
      notifyUrl: String(process.env.WXPAY_NOTIFY_URL || '').trim(),
      platformCertificate: String(
        process.env.WXPAY_PLATFORM_CERTS || process.env.WXPAY_PLATFORM_CERT || '',
      ).trim(),
    };
  }
  return {
    appId: String(process.env.ALIPAY_APPID || '').trim(),
    privateKey: String(process.env.ALIPAY_PRIVATE_KEY || '').trim(),
    publicKey: String(process.env.ALIPAY_PUBLIC_KEY || '').trim(),
    notifyUrl: String(process.env.ALIPAY_NOTIFY_URL || '').trim(),
    gateway: String(process.env.ALIPAY_GATEWAY || '').trim()
      || 'https://openapi.alipay.com/gateway.do',
  };
}

function feishuConfigurationFacts(tenantId) {
  const cfg = feishuConfig(tenantId);
  const managers = feishuManagerSummary(tenantId);
  const stored = getTenantConfig('feishu', {}, tenantId) || {};
  return {
    appId: cfg.appId || '',
    appSecret: cfg.appSecret || '',
    enabled: cfg.enabled,
    receiveId: cfg.receiveId || '',
    receiveIdType: cfg.receiveIdType || '',
    calendarId: cfg.calendarId || '',
    managerRecipients: managers.recipients.map(item => ({
      userId: item.userId,
      receiveId: item.receiveId,
      receiveIdType: item.receiveIdType,
      calendarReady: item.calendarReady,
    })),
    stored,
  };
}

export function runtimeReadinessConfigFingerprint(channelKey, { tenantId = 0 } = {}) {
  let facts;
  if (channelKey === 'ai') facts = aiConfigurationFacts();
  else if (channelKey === 'web_search') facts = searchConfigurationFacts();
  else if (channelKey === 'payment_wechat' || channelKey === 'payment_alipay') {
    facts = paymentConfigurationFacts(channelKey);
  } else if (channelKey === 'feishu') facts = feishuConfigurationFacts(tenantId);
  else facts = { channelKey, tenantId: Number(tenantId) || 0 };
  return stableFingerprint(facts);
}

export function recordRuntimeReadinessCheck(channelKey, {
  tenantId = 0,
  outcome,
  ok,
  configFingerprint,
  checkedAt = Date.now(),
  ttlMs = DEFAULT_CHECK_TTL_MS,
  checkedBy = null,
  evidence = {},
  error = '',
} = {}) {
  const normalizedOutcome = outcome || (ok === true ? 'passed' : 'failed');
  if (!CHECK_OUTCOMES.has(normalizedOutcome)) {
    throw new TypeError('runtime readiness check outcome must be passed or failed');
  }
  const at = nowMs(checkedAt);
  const ttl = Math.max(1_000, Math.min(24 * 60 * 60 * 1000, Number(ttlMs) || DEFAULT_CHECK_TTL_MS));
  const record = Object.freeze({
    channelKey: String(channelKey),
    tenantId: Number(tenantId) || 0,
    scope: 'process',
    outcome: normalizedOutcome,
    configFingerprint: configFingerprint
      || runtimeReadinessConfigFingerprint(channelKey, { tenantId }),
    checkedAt: at,
    expiresAt: at + ttl,
    checkedBy: Number(checkedBy) || null,
    evidence: sanitizeValue(evidence),
    error: redactText(error),
  });
  PROCESS_CHECKS.set(processCheckKey(channelKey, tenantId), record);
  return publicCheck(record);
}

export function clearRuntimeReadinessChecks() {
  PROCESS_CHECKS.clear();
}

function publicCheck(record, { stale = false } = {}) {
  if (!record) return null;
  return {
    scope: 'process',
    outcome: stale ? 'stale' : record.outcome,
    checkedAt: new Date(record.checkedAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    checkedBy: record.checkedBy,
    evidence: record.evidence,
    ...(record.error ? { error: record.error } : {}),
  };
}

function verificationFor(channelKey, {
  tenantId,
  fingerprint,
  now,
  applicable = true,
} = {}) {
  const record = PROCESS_CHECKS.get(processCheckKey(channelKey, tenantId));
  if (!record) {
    return {
      verification: applicable ? 'never' : 'not_applicable',
      verified: false,
      lastCheck: null,
    };
  }
  const stale = record.configFingerprint !== fingerprint || nowMs(now) > record.expiresAt;
  if (stale) {
    return {
      verification: 'stale',
      verified: false,
      lastCheck: publicCheck(record, { stale: true }),
    };
  }
  return {
    verification: record.outcome,
    verified: record.outcome === 'passed',
    lastCheck: publicCheck(record),
  };
}

function readinessItem({
  key,
  label,
  description,
  implementation = 'ready',
  configuration,
  activation,
  effective,
  verification = 'not_applicable',
  verified = false,
  lastCheck = null,
  canExecute = false,
  canGenerateLocalDraft = false,
  canDeliverForHumanReview = false,
  canPerformExternalAction = false,
  capabilitySummary = '',
  missing = [],
  conditions = [],
  nextAction,
  details = {},
}) {
  return {
    key,
    label,
    description,
    scope: 'process',
    implementation,
    configuration,
    configured: ['ready', 'not_required'].includes(configuration),
    activation,
    verification,
    verified,
    effective,
    connected: effective === 'connected',
    // 三维能力是前端展示和业务判断的权威口径。canExecute 仅保留给旧客户端兼容，
    // 不能再用它推断“可交付”或“可执行外部动作”。
    canExecute: Boolean(canExecute),
    canGenerateLocalDraft: Boolean(canGenerateLocalDraft),
    canDeliverForHumanReview: Boolean(canDeliverForHumanReview),
    canPerformExternalAction: Boolean(canPerformExternalAction),
    capabilitySummary: capabilitySummary || [
      canGenerateLocalDraft ? '具备本地辅助处理能力' : '不生成本地替代产物',
      canDeliverForHumanReview ? '具备可交付产物' : '尚不具备可交付产物',
      canPerformExternalAction ? '能执行外部动作' : '不执行外部动作',
    ].join('；'),
    missing: [...missing],
    conditions: [...conditions],
    nextAction,
    lastCheck,
    details,
  };
}

function aiReadiness({ tenantId, now }) {
  const facts = aiConfigurationFacts();
  const configured = facts.provider !== 'template';
  const fingerprint = runtimeReadinessConfigFingerprint('ai', { tenantId });
  const check = verificationFor('ai', {
    tenantId,
    fingerprint,
    now,
    applicable: configured,
  });
  const effective = !configured
    ? 'blocked'
    : check.verified
      ? 'connected'
      : 'configured_unverified';
  return readinessItem({
    key: 'ai',
    label: 'AI 生成通道',
    description: configured
      ? '服务端已发现通道配置；只有最近一次显式连接测试通过才视为已连接。'
      : '真实 AI 生成通道未配置；任务不会启动，也不会形成替代业务产物。',
    configuration: configured ? 'ready' : 'missing',
    activation: configured ? 'enabled' : 'blocked',
    effective,
    ...check,
    canExecute: configured,
    canGenerateLocalDraft: false,
    canDeliverForHumanReview: check.verified,
    canPerformExternalAction: false,
    capabilitySummary: !configured
      ? '真实生成通道未配置；任务不会启动，也不会形成业务产物'
      : check.verified
        ? '真实内容生成已就绪；内部产出通过质量与账务门后按企业策略采用；不执行外部业务动作'
        : '真实生成通道已配置但连接尚未验证；任务结果以真实调用证据为准，不生成替代产物',
    missing: configured ? [] : ['服务端 AI 通道凭证'],
    conditions: [
      '凭证只从服务端环境或受控兼容配置读取',
      '显式连接测试通过后 15 分钟内有效',
      'Base URL 或凭证变化会立即使旧验证过期',
    ],
    nextAction: !configured
      ? '配置 YUNWU_API_KEY 或 ANTHROPIC_API_KEY 服务端密钥后重启服务，再由管理员显式测试连接。'
      : check.verified
        ? '最近连接测试有效；到期或变更配置后重新测试。'
        : '由平台管理员点击“测试连接”，成功后才会标记为已连接。',
    details: {
      provider: facts.provider,
      keySource: facts.keySource,
      baseUrl: publicBaseUrl(facts.baseUrl),
      // 只公开不可逆配置指纹，不公开任何密钥；用于把长时间验收与同一服务端配置绑定。
      configFingerprint: fingerprint,
      executionMode: configured ? 'external_provider' : 'blocked_missing_provider',
    },
  });
}

function schedulerReadiness() {
  const enabled = schedulerEnabled(process.env);
  return readinessItem({
    key: 'scheduler',
    label: '定时任务调度器',
    description: enabled
      ? '当前进程按环境开关启动调度检查；本矩阵不把规则启用等同于外部通道已连接。'
      : '当前进程明确关闭 Scheduler；已保存规则不会按计划时间自动领取。',
    configuration: 'ready',
    activation: enabled ? 'enabled' : 'disabled',
    effective: enabled ? 'local_ready' : 'disabled',
    canExecute: enabled,
    canGenerateLocalDraft: enabled,
    canDeliverForHumanReview: false,
    canPerformExternalAction: false,
    missing: enabled ? [] : ['ENABLE_SCHEDULER=true 并重启服务'],
    conditions: [
      'Scheduler 只由服务端环境开关控制',
      `最大并发 ${schedulerMaxConcurrent(process.env)}`,
      '自动内容仍进入人工审阅与交付门禁，不自动对外发布',
    ],
    nextAction: enabled
      ? '调度器已按进程配置启动；继续观察规则最近运行结果。'
      : '确认生产前置条件后设置 ENABLE_SCHEDULER=true 并重启服务。',
    details: {
      enabled,
      maxConcurrent: schedulerMaxConcurrent(process.env),
      source: 'process_environment',
    },
  });
}

function searchReadiness({ tenantId, now }) {
  const configuredProviders = webSearchProviders();
  const configured = configuredProviders.length > 0;
  const check = verificationFor('web_search', {
    tenantId,
    fingerprint: runtimeReadinessConfigFingerprint('web_search', { tenantId }),
    now,
    applicable: configured,
  });
  return readinessItem({
    key: 'web_search',
    label: '联网检索',
    description: configured
      ? '已发现商业检索源配置，但尚需显式验收；运行时仍要求取得可引用结果。'
      : '未配置商业检索源；代码可能尝试无密钥兜底源，但不视为生产就绪。',
    configuration: configured ? 'ready' : 'missing',
    activation: 'enabled',
    effective: !configured
      ? 'degraded'
      : check.verified
        ? 'connected'
        : 'configured_unverified',
    ...check,
    canExecute: true,
    canGenerateLocalDraft: false,
    canDeliverForHumanReview: false,
    canPerformExternalAction: false,
    missing: configured ? [] : ['博查、Tavily 或 Serper 至少一个服务端凭证'],
    conditions: [
      '检索成功且至少返回一条可引用来源，才算本次任务完成联网核验',
      '无凭证兜底源不构成生产通道验收证据',
    ],
    nextAction: configured
      ? check.verified
        ? '最近检索连接测试有效；任务仍须逐次保留来源证据。'
        : '使用授权测试查询显式验收检索源，未验收前保持“已配置·待验证”。'
      : '配置一个商业检索源，并用授权测试查询完成验收。',
    details: {
      configuredProviders,
      keylessFallback: 'DuckDuckGo',
      evidenceRequiredPerRun: true,
    },
  });
}

function configurationState(facts, requiredLabels) {
  const entries = Object.entries(requiredLabels);
  const missing = entries.filter(([key]) => !present(facts[key])).map(([, label]) => label);
  const presentCount = entries.length - missing.length;
  return {
    configured: missing.length === 0,
    configuration: missing.length === 0
      ? 'ready'
      : presentCount === 0
        ? 'missing'
        : 'partial',
    missing,
  };
}

function paymentReadiness(channelKey, { tenantId, now }) {
  const wechat = channelKey === 'payment_wechat';
  const facts = paymentConfigurationFacts(channelKey);
  const required = wechat
    ? {
      mchid: '微信支付商户号',
      serialNo: '微信支付商户证书序列号',
      privateKey: '微信支付商户私钥',
      apiV3Key: '微信支付 APIv3 Key',
      appId: '微信支付 App ID',
      notifyUrl: '微信支付回调地址',
      platformCertificate: '微信支付平台证书或平台公钥',
    }
    : {
      appId: '支付宝 App ID',
      privateKey: '支付宝应用私钥',
      publicKey: '支付宝公钥',
      notifyUrl: '支付宝回调地址',
    };
  const config = configurationState(facts, required);
  const check = verificationFor(channelKey, {
    tenantId,
    fingerprint: runtimeReadinessConfigFingerprint(channelKey, { tenantId }),
    now,
    applicable: config.configured,
  });
  return readinessItem({
    key: channelKey,
    label: wechat ? '微信支付' : '支付宝',
    description: config.configured
      ? '支付字段已齐全，但只有授权沙箱或生产显式验收通过后才视为已连接。'
      : '支付配置不完整；系统应保持人工对公转账流程。',
    configuration: config.configuration,
    activation: config.configured ? 'enabled' : 'disabled',
    effective: !config.configured
      ? 'blocked'
      : check.verified
        ? 'connected'
        : 'configured_unverified',
    ...check,
    canExecute: config.configured,
    canGenerateLocalDraft: false,
    canDeliverForHumanReview: false,
    canPerformExternalAction: check.verified,
    missing: config.missing,
    conditions: wechat
      ? [
        '商户私钥、APIv3 Key、回调地址和平台证书必须同时存在',
        '下单、查单、关单与回调应答必须验签且通过防重放检查',
        '完成授权沙箱或生产测试前不能标记为已连接',
      ]
      : [
        '应用私钥、支付宝公钥和回调地址必须同时存在',
        '完成授权沙箱或生产测试前不能标记为已连接',
      ],
    nextAction: !config.configured
      ? `补齐：${config.missing.join('、')}。`
      : check.verified
        ? '最近支付通道验收有效；继续按订单审计与幂等规则运行。'
        : '使用授权沙箱完成下单、查单、关单和回调验收。',
    details: {
      channel: wechat ? 'wechat' : 'alipay',
      fallback: 'manual_corporate_transfer',
      environment: present(process.env.PAYMENT_ENV)
        ? redactText(process.env.PAYMENT_ENV)
        : 'unspecified',
    },
  });
}

function feishuReadiness({ tenantId, now }) {
  const cfg = feishuConfig(tenantId);
  const managers = feishuManagerSummary(tenantId);
  const credentialsReady = appReady(tenantId);
  const recipientReady = Boolean(cfg.receiveId || managers.count);
  const configured = credentialsReady && recipientReady;
  const partiallyConfigured = credentialsReady || recipientReady;
  const enabled = appBotReady(tenantId);
  const check = verificationFor('feishu', {
    tenantId,
    fingerprint: runtimeReadinessConfigFingerprint('feishu', { tenantId }),
    now,
    applicable: configured,
  });
  const missing = [
    ...(!credentialsReady ? ['飞书企业应用 App ID / App Secret'] : []),
    ...(!recipientReady ? ['至少一个在职接收人绑定'] : []),
  ];
  return readinessItem({
    key: 'feishu',
    label: '飞书消息与日历',
    description: !configured
      ? '飞书配置尚未形成可执行组合。'
      : !enabled
        ? '应用凭证与接收人已配置，但企业同步开关未启用。'
        : '凭证、接收人与开关已配置；只有显式测试消息成功后才视为已连接。',
    configuration: configured ? 'ready' : partiallyConfigured ? 'partial' : 'missing',
    activation: enabled ? 'enabled' : 'disabled',
    effective: !configured
      ? 'blocked'
      : !enabled
        ? 'disabled'
        : check.verified
          ? 'connected'
          : 'configured_unverified',
    ...check,
    canExecute: configured && enabled,
    canGenerateLocalDraft: false,
    canDeliverForHumanReview: false,
    canPerformExternalAction: configured && enabled && check.verified,
    missing,
    conditions: [
      '企业应用凭证、在职接收人和启用开关必须同时满足',
      '最近显式测试消息必须成功',
      '日历直写仍以每次真实同步结果为准',
    ],
    nextAction: !configured
      ? `补齐：${missing.join('、')}。`
      : !enabled
        ? '启用飞书企业同步后发送显式测试消息。'
        : check.verified
          ? '最近飞书测试有效；继续观察逐次消息和日历同步结果。'
          : '发送管理层测试消息；成功前保持“已配置·待验证”。',
    details: {
      appConfigured: credentialsReady,
      botConfigured: enabled,
      managerReceiverCount: managers.count,
      managerCalendarCount: managers.calendarCount,
      calendarCreated: Boolean(cfg.calendarId),
    },
  });
}

function externalPublishReadiness() {
  return readinessItem({
    key: 'external_publish',
    label: '内容外部发布',
    description: '当前只支持本地发布包与人工发布登记，没有自动操作外部平台账号的适配器。',
    implementation: 'partial',
    configuration: 'not_required',
    activation: 'manual',
    effective: 'manual_only',
    canExecute: true,
    canGenerateLocalDraft: true,
    canDeliverForHumanReview: true,
    canPerformExternalAction: false,
    capabilitySummary: '仅登记发布包，不能代发',
    missing: ['服务器端平台授权', '幂等且可审计的发布适配器', '人工终审后的执行入口'],
    conditions: [
      '现有“发布登记”只记录人已在外部完成的发布及效果数据',
      '本地发布包连接器永远不执行真实发布',
    ],
    nextAction: '继续使用人工发布与登记；接入独立发布适配器前不得宣称自动发布已连接。',
    details: {
      localPublishPackage: true,
      manualPublishLog: true,
      auditedExternalAdapter: false,
      actualExternalPublish: false,
    },
  });
}

function contentConnectorsReadiness(ai, search) {
  const counts = {
    total: CONTENT_CONNECTOR_REGISTRY.length,
    localAssist: CONTENT_CONNECTOR_REGISTRY.filter(item => item.mode === 'local_contract_assist').length,
    verifiedInputAssist: CONTENT_CONNECTOR_REGISTRY.filter(item => item.mode === 'verified_input_assist').length,
    employeeGeneration: CONTENT_CONNECTOR_REGISTRY.filter(item => item.mode === 'employee_generation').length,
    externalPublish: 0,
  };
  const items = CONTENT_CONNECTOR_REGISTRY.map(connector => {
    let effective = 'blocked';
    if (connector.mode === 'local_contract_assist') effective = 'local_ready';
    else if (connector.mode === 'verified_input_assist') effective = 'requires_input';
    else if (connector.mode === 'employee_generation') {
      effective = ai.connected ? 'ready_with_verified_ai' : ai.configured ? 'configured_unverified' : 'blocked';
    }
    return {
      kind: connector.kind,
      employeeIdx: connector.employeeIdx,
      employeeName: connector.employeeName,
      mode: connector.mode,
      catalogStatus: connector.status,
      effective,
      liveData: connector.requirements?.liveData || 'not_required',
      credentialsRequired: Array.isArray(connector.requirements?.credentials)
        && connector.requirements.credentials.length > 0,
      canPerformExternalAction: false,
    };
  });
  const registryReady = counts.total === 15
    && items.every(item => item.catalogStatus && item.catalogStatus !== 'catalog_only');
  return readinessItem({
    key: 'content_connectors',
    label: '内容连接器',
    description: '15 项连接器登记完整；原 Paihuo 13 项保持不变，AI 带货员追加 2 项。本地辅助、调用方实时数据与员工生成链均不等同于外部平台已连接。',
    implementation: registryReady ? 'ready' : 'partial',
    configuration: registryReady ? 'ready' : 'partial',
    activation: 'enabled',
    effective: registryReady ? 'local_ready' : 'blocked',
    canExecute: registryReady && counts.localAssist > 0,
    canGenerateLocalDraft: false,
    canDeliverForHumanReview: registryReady && ai.canDeliverForHumanReview,
    canPerformExternalAction: false,
    capabilitySummary: registryReady && ai.canDeliverForHumanReview
      ? '内容生成已就绪；内部产出通过质量与账务门后按企业策略采用；不执行外部发布'
      : '本地辅助连接器可运行，但依赖真实模型的生成任务被阻断；不形成替代业务产物，也不执行外部发布',
    missing: registryReady ? [] : ['完整且非 catalog_only 的连接器运行登记'],
    conditions: [
      `${counts.localAssist} 项可离线辅助`,
      `${counts.verifiedInputAssist} 项要求调用方提供实时来源数据`,
      `${counts.employeeGeneration} 项必须进入单员工生成链并服从其 AI、计费与输出契约`,
      '所有连接器的外部发布能力均为 0',
    ],
    nextAction: search.connected || ai.connected
      ? '按每项连接器的输入、来源、模型和审批条件执行；不得用总体状态替代逐次结果。'
      : '本地辅助可继续使用；需要联网或模型的连接器先完成对应通道显式验收。',
    details: { counts, items },
  });
}

export function buildRuntimeReadiness({
  tenantId = 0,
  now = Date.now(),
} = {}) {
  const generatedAt = nowMs(now);
  const ai = aiReadiness({ tenantId, now: generatedAt });
  const search = searchReadiness({ tenantId, now: generatedAt });
  const channels = [
    ai,
    schedulerReadiness(),
    search,
    paymentReadiness('payment_wechat', { tenantId, now: generatedAt }),
    paymentReadiness('payment_alipay', { tenantId, now: generatedAt }),
    feishuReadiness({ tenantId, now: generatedAt }),
    externalPublishReadiness(),
  ];
  channels.push(contentConnectorsReadiness(ai, search));
  const summary = {
    total: channels.length,
    connected: channels.filter(item => item.effective === 'connected').length,
    configuredUnverified: channels.filter(item => item.effective === 'configured_unverified').length,
    localReady: channels.filter(item => item.effective === 'local_ready').length,
    blocked: channels.filter(item => item.effective === 'blocked').length,
    degraded: channels.filter(item => item.effective === 'degraded').length,
    manualOnly: channels.filter(item => item.effective === 'manual_only').length,
    disabled: channels.filter(item => item.effective === 'disabled').length,
  };
  return {
    schemaVersion: 'runtime-readiness.v1',
    generatedAt: new Date(generatedAt).toISOString(),
    scope: 'process',
    externalChecksPerformed: false,
    notice: '本接口只读取本地配置、进程状态与最近显式检查记录，不调用任何外部服务。',
    summary,
    channels,
  };
}

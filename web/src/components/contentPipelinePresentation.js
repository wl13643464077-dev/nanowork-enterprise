const STATUS_PRESENTATION = Object.freeze({
  pending: Object.freeze({ label: '待执行', tone: 'default', terminal: false }),
  running: Object.freeze({ label: '运行中', tone: 'processing', terminal: false }),
  paused: Object.freeze({ label: '已暂停', tone: 'gold', terminal: false }),
  awaiting_approval: Object.freeze({ label: '待审阅', tone: 'gold', terminal: false }),
  awaiting_media_authorization: Object.freeze({ label: '等待老板授权付费配图', tone: 'gold', terminal: false }),
  awaiting_metrics: Object.freeze({ label: '等待发布指标', tone: 'cyan', terminal: false }),
  billing_pending: Object.freeze({ label: '待账务确认', tone: 'orange', terminal: true }),
  completed: Object.freeze({ label: '已完成', tone: 'green', terminal: true }),
  failed: Object.freeze({ label: '失败', tone: 'red', terminal: true }),
  rejected: Object.freeze({ label: '已驳回', tone: 'red', terminal: true }),
  cancelled: Object.freeze({ label: '已取消', tone: 'default', terminal: true }),
  skipped: Object.freeze({ label: '已跳过', tone: 'default', terminal: true }),
});

export const CONTENT_PIPELINE_APPROVAL_PRESETS = Object.freeze([
  Object.freeze({
    value: 'internal_auto',
    label: '全自动（0→9 不停审）',
    description: '内部连续执行到复盘；不会因此自动对外发布。',
    reviewStations: Object.freeze([]),
  }),
  Object.freeze({
    value: 'efficient',
    label: '半自动（只审发布包）',
    description: '前面工位自动接力，分发官形成发布包后再由老板确认。',
    reviewStations: Object.freeze([8]),
  }),
  Object.freeze({
    value: 'key',
    label: '半自动（审选题、初稿、配图、封面、发布包）',
    description: '关键节点停下，其余工位自动接力。',
    reviewStations: Object.freeze([0, 3, 5, 6, 8]),
  }),
  Object.freeze({
    value: 'custom',
    label: '自定义停审',
    description: '由老板选择本任务需要停下审阅的工位。',
    reviewStations: null,
  }),
]);

const SECRET_TEXT_RULES = Object.freeze([
  Object.freeze({ pattern: /\bsk-\s*[a-z0-9_-]{8,}\b/giu, replacement: '[REDACTED]' }),
  Object.freeze({ pattern: /\bBearer\s+[a-z0-9._~+/=-]{8,}\b/giu, replacement: '[REDACTED]' }),
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function publicText(value, fallback = '') {
  let result = text(value);
  for (const rule of SECRET_TEXT_RULES) result = result.replace(rule.pattern, rule.replacement);
  return result || fallback;
}

export function contentPipelineLocalDateTimeValue(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function contentPipelinePublicationMetricsProgress(pipeline) {
  const task = record(pipeline?.task);
  const workflow = record(pipeline?.workflow);
  const publicationMetrics = record(workflow.publicationMetrics);
  const requiredPlatforms = [
    ...new Set((Array.isArray(task.platforms) ? task.platforms : []).map(text).filter(Boolean)),
  ];
  const entries = Array.isArray(publicationMetrics.entries) ? publicationMetrics.entries : [];
  const entryPlatforms = entries.map(entry => text(record(entry).publication?.platform)).filter(Boolean);
  const declaredSubmitted = Array.isArray(publicationMetrics.submittedPlatforms)
    ? publicationMetrics.submittedPlatforms.map(text).filter(Boolean)
    : [];
  const legacyPlatform = text(record(publicationMetrics.publication).platform);
  const submittedSet = new Set([...declaredSubmitted, ...entryPlatforms, legacyPlatform].filter(Boolean));
  const submittedPlatforms = requiredPlatforms.filter(platform => submittedSet.has(platform));
  const missingPlatforms = requiredPlatforms.filter(platform => !submittedSet.has(platform));

  return {
    requiredPlatforms,
    submittedPlatforms,
    missingPlatforms,
    complete: requiredPlatforms.length > 0 && missingPlatforms.length === 0,
    verificationStatus: submittedPlatforms.length > 0 ? 'manual_unverified' : null,
  };
}

export function contentPipelineStatusMeta(value) {
  const status = text(value);
  if (!status) return { label: '状态未返回', tone: 'default', terminal: false, known: false };
  const known = STATUS_PRESENTATION[status];
  return known ? { ...known, known: true } : { label: status, tone: 'default', terminal: false, known: false };
}

function pipelineVersion(value) {
  const source = record(value);
  for (const candidate of [source.version, source.revision, source.updatedAt, source.updated_at]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function pipelineAttemptSignature(value) {
  const stations = Array.isArray(value?.stations) ? value.stations : [];
  return stations
    .filter(station => Number.isInteger(Number(station?.stationIdx)))
    .map(station => `${Number(station.stationIdx)}:${Number(station.attempt || 0)}`)
    .sort()
    .join('|');
}

export function contentPipelineQueuedReceipt(payload) {
  return payload?.queued === true || payload?.data?.queued === true;
}

export function contentPipelineProgressSnapshot(pipeline) {
  return {
    pipelineId: Number.isInteger(Number(pipeline?.id)) && Number(pipeline.id) > 0 ? Number(pipeline.id) : null,
    status: text(pipeline?.status),
    version: pipelineVersion(pipeline),
    attempts: pipelineAttemptSignature(pipeline),
  };
}

export function contentPipelineHasAdvanced(baseline, pipeline) {
  const current = contentPipelineProgressSnapshot(pipeline);
  if (!baseline || baseline.pipelineId === null || current.pipelineId !== baseline.pipelineId) return false;
  return (
    current.status !== baseline.status || current.version !== baseline.version || current.attempts !== baseline.attempts
  );
}

export function contentPipelineCanReview(role, boundaryCode) {
  const normalizedRole = text(role);
  const normalizedBoundary = text(boundaryCode);
  return normalizedBoundary === 'force'
    ? ['boss', 'admin', 'platform_super'].includes(normalizedRole)
    : ['boss', 'ops_director', 'manager', 'admin', 'platform_super'].includes(normalizedRole);
}

export function contentPipelineCanConfigureApproval(role) {
  return ['boss', 'admin', 'platform_super'].includes(text(role));
}

export function contentPipelineCanViewRuntimePackageEvidence(role) {
  return ['boss', 'admin', 'platform_super'].includes(text(role));
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstEvidenceText(sources, key) {
  for (const source of sources) {
    const value = publicText(record(source)[key]);
    if (value) return value.slice(0, 320);
  }
  return null;
}

function firstEvidenceBoolean(sources, key) {
  for (const source of sources) {
    const value = record(source)[key];
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function firstEvidenceCount(sources, key) {
  for (const source of sources) {
    const raw = record(source)[key];
    if (typeof raw !== 'number') continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

/**
 * 只从流水线已经持久化的执行证据中提取白名单元数据。
 * 不读取canonicalProfile、提示词正文、配置正文或任何凭据字段，也不从目录数量推断缺失证据。
 */
export function contentPipelineRuntimePackageEvidence(station) {
  const handlerEvidence = record(station?.handlerEvidence);
  const contextSnapshot = record(station?.contextSnapshot);
  const productionRuntime = record(handlerEvidence.productionRuntime);
  const contextLoad = record(contextSnapshot.runtimePackageLoad);
  const handlerLoad = record(handlerEvidence.runtimePackageLoad);
  const productionLoad = record(productionRuntime.runtimePackageLoad);
  const canonicalPackage = record(productionRuntime.canonicalPackage);
  const loadSources = [contextLoad, handlerLoad, productionLoad, canonicalPackage];
  const promptSources = [...loadSources, contextSnapshot, handlerEvidence, productionRuntime];
  const providerSources = [record(handlerEvidence.providerDelivery), record(productionRuntime.providerDelivery)];

  return {
    profileVersion: firstEvidenceText(loadSources, 'profileVersion'),
    aggregateFingerprint: firstEvidenceText(loadSources, 'aggregateFingerprint'),
    allRequiredFieldsLoaded: firstEvidenceBoolean(loadSources, 'allRequiredFieldsLoaded'),
    capabilityCount: firstEvidenceCount(loadSources, 'capabilityCount'),
    requiredSkillCount: firstEvidenceCount(loadSources, 'requiredSkillCount'),
    historicalSkillCount: firstEvidenceCount(loadSources, 'historicalSkillCount'),
    apiBindingCount: firstEvidenceCount(loadSources, 'apiBindingCount'),
    toolBindingCount: firstEvidenceCount(loadSources, 'toolBindingCount'),
    connectorBindingCount: firstEvidenceCount(loadSources, 'connectorBindingCount'),
    handlerId: firstEvidenceText([handlerEvidence], 'handlerId'),
    model: firstEvidenceText(providerSources, 'model'),
    sourcePromptFingerprint: firstEvidenceText(promptSources, 'sourcePromptFingerprint'),
  };
}

function normalizeReviewStations(value) {
  if (!Array.isArray(value)) return null;
  return [
    ...new Set(
      value.map(Number).filter(stationIdx => Number.isInteger(stationIdx) && stationIdx >= 0 && stationIdx <= 9),
    ),
  ].sort((a, b) => a - b);
}

export function contentPipelinePresetStations(preset, customStations = []) {
  const selected = CONTENT_PIPELINE_APPROVAL_PRESETS.find(item => item.value === text(preset));
  const source = selected?.value === 'custom' ? customStations : selected?.reviewStations;
  return normalizeReviewStations(source) || [];
}

export function contentPipelineWorkflowModeForPreset(preset) {
  const selected = text(preset);
  if (selected === 'internal_auto') return 'fullauto';
  if (selected === 'efficient') return 'autopilot';
  return 'copilot';
}

export function contentPipelineActualReviewStations(pipeline) {
  return normalizeReviewStations(pipeline?.workflow?.approvalPolicy?.reviewStations);
}

export function pipelineFailureText(value, fallback = '') {
  const failure = value && typeof value === 'object' ? value : {};
  const code = text(failure.code);
  const message = publicText(failure.message);
  if (code === 'CONTENT_PRODUCTION_WEB_EVIDENCE_MISSING') {
    return '真实检索/来源门禁已拦截：本次没有取得可验证的联网证据，因此没有继续生成。可重试当前工位；系统不会把伪造来源当作业务结果。';
  }
  if (
    code === 'CONTENT_PRODUCTION_OUTPUT_CONTRACT_FAILED' &&
    /(来源|联网证据|sources?\[\d+\]|检索快照)/iu.test(message)
  ) {
    return '真实检索/来源门禁已拦截：模型返回的来源不在服务器本次已验证的检索结果中，因此没有保存为产物。可重试当前工位；系统不会把补造或无法核验的来源当作业务结果。';
  }
  return message || fallback;
}

function candidateId(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const value = candidate.candidateId ?? candidate.id ?? candidate.key ?? null;
  return value === null || value === undefined || value === '' ? null : String(value);
}

function candidateLabel(candidate, index) {
  if (typeof candidate === 'string' || typeof candidate === 'number')
    return publicText(String(candidate), `候选 ${index + 1}`);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return `候选 ${index + 1}`;
  for (const key of ['title', 'topic', 'name', 'headline', 'label', 'description', 'copy', 'url']) {
    const value = publicText(candidate[key]);
    if (value) return value.slice(0, 120);
  }
  return `候选 ${index + 1}`;
}

export function pipelineCandidates(station) {
  const output = station?.output && typeof station.output === 'object' ? station.output : {};
  const stationIdx = Number(station?.stationIdx);
  const candidates =
    stationIdx === 0 ? output.topics : stationIdx === 5 ? output.images : stationIdx === 6 ? output.covers : [];
  if (!Array.isArray(candidates)) return [];
  return candidates.map((candidate, index) => ({
    candidateIndex: index,
    candidateId: candidateId(candidate),
    label: candidateLabel(candidate, index),
    value: candidate,
  }));
}

export function pipelineStationRows(pipeline, crew = []) {
  const stations = Array.isArray(pipeline?.stations) ? pipeline.stations : [];
  const byIndex = new Map(
    stations
      .filter(station => Number.isInteger(Number(station?.stationIdx)))
      .map(station => [Number(station.stationIdx), station]),
  );
  const crewRows = Array.isArray(crew) ? crew : [];
  return Array.from({ length: 10 }, (_, stationIdx) => {
    const source = byIndex.get(stationIdx) || null;
    const employee = crewRows.find(
      item =>
        Number(item?.employeeIdx ?? item?.order) === stationIdx ||
        (source?.employeeKey && item?.key === source.employeeKey),
    );
    const status = source ? text(source.status) : 'missing';
    return {
      ...(source || {}),
      stationIdx,
      employeeKey: text(source?.employeeKey) || text(employee?.key),
      employeeName:
        text(source?.employeeName) || text(employee?.name) || text(source?.employeeKey) || `工位 ${stationIdx}`,
      employeeGroup: text(employee?.group),
      employeeEmoji: text(employee?.emoji),
      status,
      statusMeta: source
        ? contentPipelineStatusMeta(status)
        : { label: '状态未返回', tone: 'default', terminal: false, known: false },
      output: source?.output ?? null,
      failureText: pipelineFailureText(source?.failure, status === 'failed' ? '服务未返回失败原因' : ''),
    };
  });
}

export function unwrapContentPipeline(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  for (const candidate of [payload.pipeline, payload.data?.pipeline, payload.data, payload]) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      Number.isInteger(Number(candidate.id)) &&
      Number(candidate.id) > 0
    ) {
      return { ...candidate, id: Number(candidate.id) };
    }
  }
  return null;
}

export function unwrapContentPipelineList(payload) {
  const candidates = [payload, payload?.pipelines, payload?.items, payload?.data?.pipelines, payload?.data];
  const rows = candidates.find(Array.isArray) || [];
  return rows
    .filter(item => item && typeof item === 'object' && Number.isInteger(Number(item.id)) && Number(item.id) > 0)
    .map(item => ({ ...item, id: Number(item.id) }));
}

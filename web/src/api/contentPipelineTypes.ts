import type { ContentEmployeeDispatchFormValues, PaihuoContentBrief } from './contentProfileTypes';

export type ContentPipelineWorkflowMode = 'copilot' | 'fullauto' | 'autopilot' | 'manual';
export type ContentPipelineApprovalPreset = 'efficient' | 'key' | 'internal_auto' | 'custom';

export type ContentPipelineApprovalPolicy = {
  mode?: 'custom' | string;
  reviewStations?: number[];
  configuredByRole?: string;
  [key: string]: unknown;
};

export type ContentPipelineCreateFormValues = ContentEmployeeDispatchFormValues & {
  workflowMode: ContentPipelineWorkflowMode;
  approvalPreset: ContentPipelineApprovalPreset;
  approvalReviewStations?: number[];
  paidMediaAuthorized: boolean;
};

export type ContentPipelinePaidMediaAuthorization = {
  authorized?: boolean;
  authorizationId?: string;
  imageModel?: string;
  pricingVersion?: string;
  pricingFingerprint?: string;
  maximumContentImageCount?: number;
  maximumCoverImageCount?: number;
  maximumImageCount?: number;
  estimatedUnitCredits?: number;
  estimatedMaximumCredits?: number;
  authorizedAt?: string;
  expiresAt?: string;
  externalPublishAllowed?: false;
  [key: string]: unknown;
};

export type ContentPipelineApprovalBoundary = {
  code?: 'pick' | 'review' | 'auto' | 'force' | string;
  label?: string;
  message?: string;
  [key: string]: unknown;
};

export type ContentPipelineFailure = {
  code?: string;
  message?: string;
  stationIdx?: number;
  [key: string]: unknown;
};

export type ContentPipelineRuntimePackageLoadEvidence = {
  schemaVersion?: string | null;
  profileVersion?: string | null;
  aggregateFingerprint?: string | null;
  requiredFields?: string[];
  loadedFields?: string[];
  fieldFingerprints?: Record<string, string>;
  allRequiredFieldsLoaded?: boolean;
  fullCanonicalObjectInSystemMessage?: boolean;
  capabilityCount?: number;
  requiredSkillCount?: number;
  historicalSkillCount?: number;
  apiBindingCount?: number;
  toolBindingCount?: number;
  connectorBindingCount?: number;
  sourcePromptFingerprint?: string | null;
  [key: string]: unknown;
};

export type ContentPipelineProviderDeliveryEvidence = {
  mode?: string | null;
  model?: string | null;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null;
  costYuan?: number | null;
  costUsd?: number | null;
  [key: string]: unknown;
};

export type ContentPipelineStationBillingEvidence = {
  state?: string;
  heldCredits?: number | null;
  settledCredits?: number | null;
  chargedCredits?: number | null;
  costYuan?: number | null;
  note?: string | null;
  [key: string]: unknown;
};

export type ContentPipelinePhaseEvent = {
  schemaVersion?: string;
  id: number;
  stationIdx: number;
  attempt: number;
  phase:
    | 'claim'
    | 'context'
    | 'agentic_search'
    | 'controlled_fetch'
    | 'provider'
    | 'validate'
    | 'persist'
    | 'settle'
    | 'failure'
    | 'retry'
    | 'recover'
    | string;
  state: 'started' | 'completed' | 'failed' | 'skipped' | 'waiting' | 'recovered' | 'retrying' | string;
  detail?: Record<string, unknown>;
  usageRef?: ContentPipelineProviderDeliveryEvidence &
    ContentPipelineStationBillingEvidence & { source?: string; evidenceFingerprint?: string };
  occurredAt?: string | null;
};

export type ContentPipelineHandlerEvidence = {
  handlerId?: string | null;
  runtimePackageLoad?: ContentPipelineRuntimePackageLoadEvidence | null;
  providerDelivery?: ContentPipelineProviderDeliveryEvidence | null;
  sourcePromptFingerprint?: string | null;
  productionRuntime?: {
    canonicalPackage?: ContentPipelineRuntimePackageLoadEvidence | null;
    runtimePackageLoad?: ContentPipelineRuntimePackageLoadEvidence | null;
    providerDelivery?: ContentPipelineProviderDeliveryEvidence | null;
    sourcePromptFingerprint?: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
};

export type ContentPipelineContextSnapshot = {
  runtimePackageLoad?: ContentPipelineRuntimePackageLoadEvidence | null;
  sourcePromptFingerprint?: string | null;
  [key: string]: unknown;
};

export type ContentPipelineArtifact = {
  id: number;
  kind: string;
  primary: boolean;
  filename: string;
  mediaType: string;
  byteSize: number;
  sha256: string | null;
  availability: 'final' | 'awaiting_approval' | 'awaiting_metrics' | 'billing_pending' | string;
  finalUsable: boolean;
  previewUrl: string;
  downloadUrl: string;
};

export type ContentPipelineProviderAsset = {
  id: number;
  sourceStationIdx: number;
  kind: string;
  filename: string;
  mediaType: string;
  byteSize: number | null;
  sha256: string;
  immutableSnapshot: boolean;
  projectedIntoPublishPackage: boolean;
  providerModel?: string | null;
  platform?: string | null;
  requestedSize?: string | null;
  displaySize?: string | null;
  style?: string | null;
  paihuoRealImage?: boolean;
  sourceMaterialId?: number | null;
  sourceUrl?: string | null;
  rights?: {
    confirmed?: boolean;
    commercialUse?: boolean;
    license?: string | null;
    attribution?: string | null;
  } | null;
  availability: 'final' | 'awaiting_approval' | 'awaiting_metrics' | 'billing_pending' | string;
  finalUsable: boolean;
  previewUrl: string;
  downloadUrl: string;
};

export type ContentPipelinePublicationMetricsEntry = {
  schemaVersion?: string;
  publication?: { platform?: string; url?: string; publishedAt?: string; externalId?: string | null };
  metrics?: Record<string, number>;
  evidenceNote?: string | null;
  submittedBy?: { id?: number; name?: string; role?: string } | null;
  submittedAt?: string;
  verification?: {
    status?: 'manual_unverified' | string;
    source?: 'human_submission' | string;
    platformVerified?: false;
  };
  [key: string]: unknown;
};

export type ContentPipelinePublicationMetrics = {
  schemaVersion?: string;
  requiredPlatforms?: string[];
  entries?: ContentPipelinePublicationMetricsEntry[];
  submittedPlatforms?: string[];
  missingPlatforms?: string[];
  complete?: boolean;
  verificationStatus?: 'manual_unverified' | string;
  lastSubmittedPlatform?: string;
  updatedAt?: string;
  // 兼容旧版单平台指标结构。
  publication?: ContentPipelinePublicationMetricsEntry['publication'];
  metrics?: Record<string, number>;
  evidenceNote?: string | null;
  [key: string]: unknown;
};

export type ContentPipelineStation = {
  pipelineId?: number;
  stationIdx: number;
  employeeKey?: string;
  employeeName?: string;
  handlerId?: string;
  status?: string;
  attempt?: number;
  output?: unknown;
  artifacts?: ContentPipelineArtifact[];
  providerAssets?: ContentPipelineProviderAsset[];
  handlerEvidence?: ContentPipelineHandlerEvidence | null;
  billingEvidence?: ContentPipelineStationBillingEvidence | null;
  phaseEvents?: ContentPipelinePhaseEvent[];
  retry?: {
    used?: number;
    /** @deprecated Manual retries are manager-gated and unlimited; use manualUnlimited. */
    remaining?: number | null;
    /** Backward-compatible alias for manualAllowed. */
    allowed?: boolean;
    manualAllowed?: boolean;
    manualUnlimited?: boolean;
    automaticRemaining?: number;
  } | null;
  contextSnapshot?: ContentPipelineContextSnapshot | null;
  approvalBoundary?: ContentPipelineApprovalBoundary | null;
  approvalAudit?: unknown[];
  selection?: { candidateIndex?: number; candidateId?: string | null } | null;
  failure?: ContentPipelineFailure | null;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
};

export type ContentPipeline = {
  id: number;
  schemaVersion?: string;
  mode?: string;
  title?: string;
  status?: string;
  currentStation?: number;
  pendingStation?: number | null;
  task?: PaihuoContentBrief & Record<string, unknown>;
  brief?: PaihuoContentBrief & Record<string, unknown>;
  workflow?: {
    mode?: ContentPipelineWorkflowMode;
    approvalPolicy?: ContentPipelineApprovalPolicy;
    paidMediaAuthorization?: ContentPipelinePaidMediaAuthorization;
    publicationMetrics?: ContentPipelinePublicationMetrics;
    [key: string]: unknown;
  };
  delivery?: {
    schemaVersion?: string;
    title?: string;
    title_candidates?: unknown[];
    body?: string;
    tags?: string[];
    images?: unknown[];
    covers?: unknown[];
    versions?: unknown[];
    packs?: Array<Record<string, unknown>>;
    publish_plan?: string;
    retro?: Record<string, unknown>;
    [key: string]: unknown;
  };
  failure?: ContentPipelineFailure | null;
  stations?: ContentPipelineStation[];
  createdAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
};

export type ContentPipelineCrewMember = {
  order: number;
  key: string;
  name: string;
  group?: string;
  emoji?: string;
  employeeIdx?: number | null;
  capabilities?: ContentPipelineCrewCapability[];
};

export type ContentPipelineCrewCapability = {
  key?: string;
  kind?: string;
  name?: string;
  description?: string;
  desc?: string;
  enabled?: boolean;
  available?: boolean;
  verified?: boolean;
  status?: string;
  [key: string]: unknown;
};

export type ContentPipelineScheduleKind = 'daily' | 'weekly' | 'interval';

export type ContentPipelineSchedule = {
  id: number;
  schemaVersion?: string;
  name: string;
  enabled: boolean;
  kind: ContentPipelineScheduleKind;
  atTime?: string | null;
  weekday?: number | null;
  everyHours?: number | null;
  human?: string;
  task: PaihuoContentBrief & Record<string, unknown>;
  persona?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  workflow?: {
    mode?: ContentPipelineWorkflowMode;
    approvalPolicy?: ContentPipelineApprovalPolicy;
    paidMediaAuthorized?: boolean;
    [key: string]: unknown;
  };
  createdBy?: number;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastStatus?: string | null;
  lastNote?: string | null;
  lastPipelineId?: number | null;
  deepLink?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type ContentPipelineCandidate = {
  candidateIndex: number;
  candidateId: string | null;
  label: string;
  value: unknown;
};

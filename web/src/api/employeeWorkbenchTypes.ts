export type EmployeeWorkbenchDomain = 'restaurant' | 'content';

export type EmployeeWorkbenchIdentity = {
  idx: number;
  key?: string;
  person?: string | null;
  name: string;
  title?: string;
  duty?: string;
  intro?: string;
  description?: string;
  group?: string;
  department?: string | { id?: number; code?: string; name?: string; emoji?: string; color?: string };
  emoji?: string;
  color?: string;
  status?: string;
  extension?: boolean;
};

export type EmployeeCapability = {
  id?: string;
  key?: string;
  name: string;
  emoji?: string;
  description?: string;
  desc?: string;
  source?: string;
  required?: boolean;
  enabled?: boolean;
  locked?: boolean;
};

export type EmployeeWorkMethod = {
  inputs?: string[];
  requiredInputs?: string[];
  steps?: string[];
  deliverables?: string[];
  approval?: string;
  qualityGate?: string;
  qualityGates?: string[];
  safetyBoundaries?: string[];
  safetyBoundarySource?: string;
  handoff?: string;
  executionBoundary?: string;
  manualMarkdown?: string | null;
  raw?: unknown;
};

export type EmployeeSkill = {
  id?: string | number;
  key?: string;
  name?: string;
  title?: string;
  description?: string;
  detail?: string;
  source?: string;
  sourceUrl?: string;
  learnedAt?: string;
  version?: string;
  enabled?: boolean;
  verified?: boolean;
  status?: string;
  kind?: 'factory' | 'historical' | 'custom' | string;
  origin?: string;
  required?: boolean;
  locked?: boolean;
  defaultInjected?: boolean;
  currentPlatformFact?: boolean;
  verificationStatus?: string;
  verificationLevel?: 'catalog_contract_verified' | string;
  effectValidation?: 'requires_live_business_sample' | string;
  contentFingerprint?: string;
  offlineAcceptanceFixture?: {
    sampleTask?: string;
    expectedInjection?: Record<string, unknown>;
  };
  sourceSnapshot?: {
    date?: string;
    sha256?: string;
    kind?: string;
  };
};

export type EmployeeSkillLearningRun = {
  id: number;
  domain: EmployeeWorkbenchDomain;
  employeeIdx: number;
  employeeName: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'pending_reconciliation' | string;
  skillsBefore: number;
  skillsAdded: number;
  skillsTotal: number | null;
  progress: Array<{ phase?: string; message?: string; at?: string; batch?: number; requested?: number }>;
  result?: { skills?: EmployeeSkill[] } | null;
  error?: { code?: string; message?: string; billingState?: string; retryable?: boolean } | null;
  billing?: {
    holdId?: number | null;
    creditLogId?: number | null;
    heldCredits?: number | null;
    chargedCredits?: number | null;
    costYuan?: number | null;
    webCostUsd?: number | null;
  };
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type EmployeeSkillLibrary = {
  factory?: EmployeeSkill[];
  builtIn?: EmployeeSkill[];
  factorySkills?: EmployeeSkill[];
  required?: EmployeeSkill[];
  optional?: EmployeeSkill[];
  learned?: EmployeeSkill[];
  historical?: EmployeeSkill[];
  pending?: EmployeeSkill[];
  pendingVerification?: EmployeeSkill[];
  historicalSkills?: EmployeeSkill[];
  custom?: EmployeeSkill[];
  customSkills?: EmployeeSkill[];
  skills?: EmployeeSkill[];
  boundary?: string;
};

export type EmployeePrompts = {
  defaultTemplate?: string;
  default?: string;
  overrideTemplate?: string;
  override?: string;
  effectiveSummary?: string;
  effectiveTemplate?: string;
  summary?: string;
  effectiveHash?: string;
  hash?: string;
  version?: string;
  revision?: number;
  overrideMode?: string;
  placeholders?: Record<string, string>;
  boundary?: string;
  finalOutputContract?: {
    format?: string;
    outputKeys?: string[];
    contract?: string;
    primaryArtifact?: string;
    block?: string;
  };
  systemPrompt?: {
    messageMode?: string;
    template?: string | null;
    reason?: string;
  };
  pipelinePrompt?: {
    messageMode?: string;
    template?: string;
    assemblyOrder?: string[];
  };
  soloPrompt?: {
    messageMode?: string;
    template?: string;
    placeholders?: Record<string, string>;
  };
};

export type WorkConfigField = {
  key: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'multiselect';
  description?: string;
  required?: boolean;
  options?: Array<string | { label: string; value: string | number }>;
};

export type EmployeeWorkConfig = {
  fields?: WorkConfigField[];
  schema?: { fields?: WorkConfigField[] };
  values?: Record<string, unknown>;
  version?: string;
  mode?: string;
  summary?: string;
  boundary?: string;
  [key: string]: unknown;
};

export type EmployeeJobProfile = {
  employeeNumber?: number;
  duty?: string;
  intro?: string;
  role?: string;
  roleKey?: string;
  roleTitle?: string;
  moduleGroup?: string;
  scope?: string;
  group?: string;
  department?: string;
  employeeCode?: string;
  positionSkill?: string;
  source?: string;
  sourceVersion?: string;
  boundaries?: string[];
  nonGoals?: string[];
  responsibilities?: string[];
  useCases?: string[];
  kpis?: string[];
  outputKeys?: string[];
  outputSchema?: unknown;
  connectorPolicy?: unknown;
  authority?: unknown;
  serviceLevel?: unknown;
  requiredInputs?: string[];
  expectedDeliverables?: string[];
  qualityStandards?: string[];
  safetyBoundaries?: string[];
  collaborators?: string[];
  completedRuns?: number;
  profileVersion?: string;
  fields?: Array<{ label: string; value: string }>;
};

export type EmployeeRuntimeTask = {
  id: string | number;
  title: string;
  type?: string;
  status?: string;
  displayStatus?: string;
  remediated?: boolean;
  remediatedByRunId?: number | null;
  reviewReady?: boolean;
  billingState?: string;
  billing?: {
    state?: string;
    label?: string;
    credits?: number | null;
    heldCredits?: number | null;
    settledCredits?: number | null;
    costYuan?: number | null;
    authoritative?: boolean;
  };
  createdAt?: string;
  created_at?: string;
  flow?: string[];
  stepIndex?: number;
  failed?: boolean;
  nextAction?: string;
  requirement?: string;
  presentationKey?: string;
  // P0-1 未达标草稿（草稿待处理 / 草稿已接受）的老板可读信息；结构见 components/EmployeeDraftCard
  draft?: {
    state: 'pending' | 'accepted';
    failReason?: string;
    failReasonLabel?: string;
    attempts?: number;
    failedChecks?: { category?: string; label: string; count?: number; details?: string[] }[];
    failedCheckCount?: number;
    acceptable?: boolean;
    canAccept?: boolean;
    acceptBlockedReason?: string | null;
    acceptedAt?: string | null;
    acceptedByName?: string | null;
    requiresReview?: boolean;
  } | null;
  output_id?: number | null;
  output_body?: string | null;
  output_status?: string | null;
  risk_level?: string | null;
  risk_flags?: string | string[] | null;
  employee_profile_version?: string | null;
  internalProfileApplied?: boolean;
  generationProgress?: EmployeeExecutionProgress;
  failure?: {
    code?: string;
    retryable?: boolean;
    message?: string;
  };
  aiMode?: string;
  ai_mode?: string;
  executionSnapshot?: {
    webEvidence?: {
      skillResearchPlan?: Record<string, unknown> | null;
      sourceQuality?: Record<string, unknown> | null;
      [key: string]: unknown;
    } | null;
    outputContract?: {
      valid?: boolean;
      errors?: string[];
      warnings?: string[];
      qualityMode?: 'strict' | 'advisory';
      contractId?: string | null;
      repair?: Record<string, unknown> | null;
    } | null;
    providerAttempt?: {
      mode?: string | null;
      model?: string | null;
      usage?: { inputTokens?: number; outputTokens?: number };
    } | null;
  } | null;
};

export type EmployeeExecutionProgressStep = {
  stage: string;
  kind: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'error';
  at: string;
  count?: number;
  attemptNumber?: number;
};

export type EmployeeExecutionProgress = {
  receivedChars: number;
  lastActivityAt: string;
  attemptNumber: number;
  phase: 'acquire' | 'repair';
  currentStage?: string;
  currentLabel?: string;
  percent?: number;
  steps?: EmployeeExecutionProgressStep[];
};

export type EmployeeRuntime = {
  status?: string;
  runs?: number;
  outputs?: number;
  tasks?: number;
  mediaJobs?: number;
  lastCreatedAt?: string | null;
  lastRunAt?: string | null;
  avgDurationSeconds?: number;
  cost?: number;
  completedRuns?: number;
  reviewPendingRuns?: number;
  reconciliationPendingRuns?: number;
  runningTasks?: number;
  failedRuns?: number;
  remediatedRuns?: number;
  lastTask?: EmployeeRuntimeTask | null;
  recentTasks?: EmployeeRuntimeTask[];
  taskPage?: {
    offset: number;
    limit: number;
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
};

export type EmployeeRuntimeBindingItem = {
  id?: string;
  kind?: string;
  binding?: string;
  handler?: string;
  legacyHandler?: string;
  route?: string;
  endpoint?: string;
  businessEndpoint?: string;
  status?: string;
  mode?: string;
  invocation?: string;
  credentialPolicy?: string;
  required?: boolean;
  primary?: boolean;
  addon?: boolean;
  [key: string]: unknown;
};

export type EmployeeRuntimeBindings = {
  work?: {
    mode?: string;
    handler?: string;
    legacyHandler?: string;
    legacyPipelineBuilder?: string;
    soloMessageMode?: string;
    async?: boolean;
    outputValidation?: string;
    [key: string]: unknown;
  };
  models?: Record<
    string,
    {
      route?: string;
      factoryModel?: string | null;
      invocation?: string;
      credentials?: string;
      [key: string]: unknown;
    }
  >;
  webPolicy?: {
    defaultMode?: string;
    cadence?: string;
    minimumAttempts?: number;
    evidenceRequired?: boolean;
    failurePolicy?: string;
    realtimeSteps?: string[];
    [key: string]: unknown;
  };
  apis?: EmployeeRuntimeBindingItem[];
  tools?: EmployeeRuntimeBindingItem[];
  connectors?: EmployeeRuntimeBindingItem[];
  references?: EmployeeRuntimeBindingItem[];
  sourceBindings?: {
    work?: Record<string, unknown>;
    connectors?: EmployeeRuntimeBindingItem[];
    safeLegacyConfig?: Record<string, unknown>;
    [key: string]: unknown;
  };
  currentRuntimeBindings?: EmployeeRuntimeBindings;
  parityBoundary?: string;
  [key: string]: unknown;
};

export type ContentEmployeeRunStatus = '生成中' | '待审阅' | '已完成' | '已驳回' | '失败';
export type ContentEmployeePublicRunStatus = ContentEmployeeRunStatus | '待账务对账';

export type EmployeeRunReview = {
  decision?: 'adopt' | 'reject' | null;
  reviewerId?: number | null;
  reviewerName?: string | null;
  reviewerRole?: string | null;
  reviewedAt?: string | null;
  opinion?: string;
  materialId?: number | null;
  contentId?: number | null;
  selection?: {
    candidateId?: string | null;
    candidateIndex: number;
  } | null;
};

export type EmployeeRunHandlerApproval = {
  code: 'pick' | 'review' | 'auto' | 'force' | string;
  candidateSelectionRequired: boolean;
  forcedFinalReview: boolean;
  externalPublishAllowed: false;
  executed: boolean;
  candidates: Array<{
    candidateIndex: number;
    label: string;
  }>;
};

export type EmployeeRunBilling = {
  state?: 'held' | 'settled' | 'released' | 'pending_reconciliation' | string;
  estimatedCredits?: number;
  chargedCredits?: number | null;
  balance?: number | null;
  model?: string;
  note?: string;
};

export type InternalProfileLeakage = {
  schemaVersion?: string;
  detected: true;
  status?: 'blocked_pending_privileged_review' | string;
  reasons?: string[];
  categories?: string[];
  matchCount?: number;
  outputHash?: string | null;
  markerHash?: string | null;
};

export type EmployeeRunPresentationKey =
  | 'generating'
  | 'review_pending'
  | 'adopted'
  | 'business_blocked'
  | 'rework_required'
  | 'execution_failed'
  | 'historical';

export type EmployeeWorkbenchRun = {
  retrospective?: {
    contentId: number;
    verification: 'manual_unverified';
    canAdopt: boolean;
    changes: Array<{
      index: number;
      target: string;
      change: string;
      evidence: string;
      noteId: number | null;
      noteStatus: string | null;
    }>;
  };
  xhsDraft?: {
    versions: Array<{
      versionId: string;
      strategy: string;
      framework_ref: string;
      title: string;
      cover_text: string;
      body: string;
      tags: string[];
      comment_prompt: string;
      facts_used: Array<{ factId: string; claim: string }>;
      self_score: { hook: number; credibility: number; conversion: number; note: string };
      recommended: boolean;
    }>;
    imagePlan: Array<{ slot: string; desc: string }>;
    selectedVersionId: string | null;
    canSelect: boolean;
    contentId: number | null;
  };
  id: number;
  runId: number;
  employeeIdx: number;
  employeeKey?: string;
  employeeName?: string;
  employeeGroup?: string;
  title: string;
  type?: string;
  requirement?: string;
  industry?: string;
  feedback?: string;
  attachments?: Array<{
    id?: number;
    name?: string;
    ext?: string;
    url?: string;
    readable?: boolean;
  }>;
  dueAt?: string | null;
  status: ContentEmployeeRunStatus;
  displayStatus?: string;
  presentationKey?: EmployeeRunPresentationKey | string;
  remediated?: boolean;
  remediatedByRunId?: number | null;
  resultMd?: string | null;
  resultPreview?: string | null;
  error?: string | null;
  aiMode?: string | null;
  model?: string | null;
  profileVersion?: string;
  promptHash?: string;
  createdBy?: number;
  createdAt?: string;
  updatedAt?: string;
  billing?: EmployeeRunBilling | null;
  executionProgress?: EmployeeExecutionProgress | null;
  contract?: {
    valid: boolean;
    errors: string[];
    artifacts: Array<{
      kind?: string;
      primary?: boolean;
      filename?: string;
      mediaType?: string;
      employeeIdx?: number;
      employeeKey?: string;
      sourceKeys?: string[];
      downloadUrl?: string | null;
    }>;
  } | null;
  review?: EmployeeRunReview | null;
  handlerApproval?: EmployeeRunHandlerApproval | null;
  materialId?: number | null;
  contentId?: number | null;
  canReview?: boolean;
  canAdopt?: boolean;
  canReject?: boolean;
  reviewBlockedReason?: string | null;
  nextAction?: string;
  terminal?: boolean;
  internalProfileLeakage?: InternalProfileLeakage;
  internalProfileApplied?: boolean;
  internalProfileRedacted?: boolean;
  snapshot?: Record<string, unknown>;
};

export type EmployeeRunListResponse = {
  runs: EmployeeWorkbenchRun[];
  total: number;
  limit: number;
};

export type ContentEmployeeQueueResponse = {
  runs: EmployeeWorkbenchRun[];
  total: number;
  visibleTotal: number;
  limit: number;
  offset: number;
  statusFilter: ContentEmployeePublicRunStatus[];
  statusCounts: Record<ContentEmployeePublicRunStatus, number>;
  presentationCounts: Partial<Record<EmployeeRunPresentationKey, number>>;
  remediatedCount: number;
  employeeCounts: Array<{
    employeeIdx: number;
    employeeKey?: string;
    employeeName: string;
    employeeGroup?: string;
    total: number;
    running: number;
    reviewPending: number;
    completed: number;
    rejected: number;
    failed: number;
    remediated: number;
  }>;
  scope: {
    key: 'tenant' | 'team' | 'self';
    label: string;
    canViewTenantRuns: boolean;
    canReviewRuns: boolean;
    canViewInternalProfile: boolean;
  };
};

export type EmployeeDispatch = {
  available?: boolean;
  enabled?: boolean;
  types?: Array<string | { label: string; value: string }>;
  defaultType?: string;
  taskTypes?: Array<string | { label: string; value: string }>;
  defaultTaskType?: string;
  boundary?: string;
  snapshotNotice?: string;
  lockedCapabilityCount?: number;
  guidance?: {
    intro?: string;
    titleLabel?: string;
    titlePlaceholder?: string;
    requirementLabel?: string;
    requirementPlaceholder?: string;
    materialChecklist?: string[];
    deliverableChecklist?: string[];
    taskExamples?: string[];
    imageLabel?: string;
    imageHelp?: string;
    evidenceTip?: string;
  };
};

export type EmployeePermissions = {
  canDispatch?: boolean;
  canReviewRuns?: boolean;
  canViewInternalProfile?: boolean;
  canViewCapabilities?: boolean;
  canViewWorkMethod?: boolean;
  canViewSkills?: boolean;
  canViewPrompt?: boolean;
  canViewWorkConfig?: boolean;
  canViewJobProfile?: boolean;
  canViewRuntimeBindings?: boolean;
  canEditPrompt?: boolean;
  canEditConfig?: boolean;
  canEditSkills?: boolean;
};

export type EmployeeProvenance = {
  authority?: string;
  source?: string;
  sourcePath?: string;
  sourceVersion?: string;
  referenceSha256?: string;
  catalogVersion?: string;
  catalog?: string;
  catalogHash?: string;
  manualHash?: string;
  profileVersion?: string;
  updatedAt?: string;
  executionMode?: string;
  boundary?: string;
};

export type EmployeeWorkbenchProfile = {
  identity: EmployeeWorkbenchIdentity;
  capabilities: EmployeeCapability[];
  workMethod: EmployeeWorkMethod;
  skillLibrary: EmployeeSkillLibrary;
  prompts: EmployeePrompts;
  workConfig: EmployeeWorkConfig;
  jobProfile: EmployeeJobProfile;
  runtimeBindings: EmployeeRuntimeBindings;
  runtime: EmployeeRuntime;
  dispatch: EmployeeDispatch;
  permissions: EmployeePermissions;
  provenance: EmployeeProvenance;
};

export type EmployeeWorkbenchBusiness = {
  intro: string;
  value: [number, number];
  typicalValue: number;
  unit: string;
  basis: string;
  reference: string;
  cost: {
    minCredits: number;
    maxCredits: number;
    minYuan: number;
    maxYuan: number;
    typicalCredits: number;
    typicalYuan: number;
    typicalBasis: string;
    note: string;
  };
};

export type EmployeeWorkbenchIdentityHint = Pick<
  EmployeeWorkbenchIdentity,
  'idx' | 'name' | 'person' | 'group' | 'emoji' | 'color' | 'status' | 'duty' | 'intro' | 'extension'
> & {
  avatar?: string;
  business?: EmployeeWorkbenchBusiness | null;
};

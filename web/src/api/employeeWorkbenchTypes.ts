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
  runningTasks?: number;
  lastTask?: {
    id?: string | number;
    title?: string;
    type?: string;
    status?: string;
    created_at?: string;
  } | null;
  recentTasks?: Array<{
    id: string | number;
    title: string;
    type?: string;
    status?: string;
    createdAt?: string;
    created_at?: string;
  }>;
};

export type ContentEmployeeRunStatus = '生成中' | '待审阅' | '已完成' | '已驳回' | '失败';

export type EmployeeRunReview = {
  decision?: 'adopt' | 'reject' | null;
  reviewerId?: number | null;
  reviewerName?: string | null;
  reviewerRole?: string | null;
  reviewedAt?: string | null;
  opinion?: string;
  materialId?: number | null;
  contentId?: number | null;
};

export type EmployeeRunBilling = {
  state?: 'held' | 'settled' | 'released' | 'pending_reconciliation' | string;
  estimatedCredits?: number;
  chargedCredits?: number | null;
  balance?: number | null;
  model?: string;
  note?: string;
};

export type EmployeeWorkbenchRun = {
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
  materialId?: number | null;
  contentId?: number | null;
  canReview?: boolean;
  terminal?: boolean;
  snapshot?: Record<string, unknown>;
};

export type EmployeeRunListResponse = {
  runs: EmployeeWorkbenchRun[];
  total: number;
  limit: number;
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
  canViewPrompt?: boolean;
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
  runtime: EmployeeRuntime;
  dispatch: EmployeeDispatch;
  permissions: EmployeePermissions;
  provenance: EmployeeProvenance;
};

export type EmployeeWorkbenchIdentityHint = Pick<
  EmployeeWorkbenchIdentity,
  'idx' | 'name' | 'person' | 'group' | 'emoji' | 'color' | 'status' | 'duty' | 'intro' | 'extension'
>;

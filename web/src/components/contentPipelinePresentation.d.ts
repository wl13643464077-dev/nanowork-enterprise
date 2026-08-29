import type {
  ContentPipeline,
  ContentPipelineCandidate,
  ContentPipelineCrewMember,
  ContentPipelineStation,
} from '../api/contentPipelineTypes';

export type ContentPipelineStatusMeta = {
  label: string;
  tone: string;
  terminal: boolean;
  known: boolean;
};

export type ContentPipelineApprovalPreset = {
  value: 'efficient' | 'key' | 'internal_auto' | 'custom';
  label: string;
  description: string;
  reviewStations: readonly number[] | null;
};

export type ContentPipelineRuntimePackageEvidence = {
  profileVersion: string | null;
  aggregateFingerprint: string | null;
  allRequiredFieldsLoaded: boolean | null;
  capabilityCount: number | null;
  requiredSkillCount: number | null;
  historicalSkillCount: number | null;
  apiBindingCount: number | null;
  toolBindingCount: number | null;
  connectorBindingCount: number | null;
  handlerId: string | null;
  model: string | null;
  sourcePromptFingerprint: string | null;
};

export type ContentPipelineProgressSnapshot = {
  pipelineId: number | null;
  status: string;
  version: string | null;
  attempts: string;
};

export type ContentPipelinePublicationMetricsProgress = {
  requiredPlatforms: string[];
  submittedPlatforms: string[];
  missingPlatforms: string[];
  complete: boolean;
  verificationStatus: 'manual_unverified' | null;
};

export const CONTENT_PIPELINE_APPROVAL_PRESETS: readonly ContentPipelineApprovalPreset[];

export type ContentPipelineStationRow = ContentPipelineStation & {
  stationIdx: number;
  employeeKey: string;
  employeeName: string;
  employeeGroup: string;
  employeeEmoji: string;
  status: string;
  statusMeta: ContentPipelineStatusMeta;
  failureText: string;
};

export function contentPipelineStatusMeta(value: unknown): ContentPipelineStatusMeta;
export function contentPipelineQueuedReceipt(payload: unknown): boolean;
export function contentPipelineLocalDateTimeValue(value?: Date | string | number): string;
export function contentPipelinePublicationMetricsProgress(
  pipeline: Partial<ContentPipeline> | null | undefined,
): ContentPipelinePublicationMetricsProgress;
export function contentPipelineProgressSnapshot(
  pipeline: Partial<ContentPipeline> | null | undefined,
): ContentPipelineProgressSnapshot;
export function contentPipelineHasAdvanced(
  baseline: ContentPipelineProgressSnapshot | null | undefined,
  pipeline: Partial<ContentPipeline> | null | undefined,
): boolean;
export function contentPipelineCanReview(role: unknown, boundaryCode: unknown): boolean;
export function contentPipelineCanConfigureApproval(role: unknown): boolean;
export function contentPipelineCanViewRuntimePackageEvidence(role: unknown): boolean;
export function contentPipelineRuntimePackageEvidence(
  station: Partial<ContentPipelineStation> | null | undefined,
): ContentPipelineRuntimePackageEvidence;
export function contentPipelinePresetStations(preset: unknown, customStations?: unknown): number[];
export function contentPipelineWorkflowModeForPreset(preset: unknown): 'fullauto' | 'autopilot' | 'copilot';
export function contentPipelineActualReviewStations(
  pipeline: Partial<ContentPipeline> | null | undefined,
): number[] | null;
export function pipelineFailureText(value: unknown, fallback?: string): string;
export function pipelineCandidates(station: Partial<ContentPipelineStation>): ContentPipelineCandidate[];
export function pipelineStationRows(
  pipeline: Partial<ContentPipeline> | null | undefined,
  crew?: ContentPipelineCrewMember[],
): ContentPipelineStationRow[];
export function unwrapContentPipeline(payload: unknown): ContentPipeline | null;
export function unwrapContentPipelineList(payload: unknown): ContentPipeline[];

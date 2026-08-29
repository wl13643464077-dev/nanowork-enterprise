import type { ContentEmployeeDispatchFormValues, PaihuoContentBrief } from '../api/contentProfileTypes';

export type MinimalContentDispatchInput = Partial<ContentEmployeeDispatchFormValues> & {
  question?: string;
  goal?: string;
  direction?: string;
  materials?: string;
};

export function buildPaihuoContentBrief(values: MinimalContentDispatchInput): PaihuoContentBrief;

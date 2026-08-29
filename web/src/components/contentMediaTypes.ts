export type VideoModelOption = {
  id: string;
  name?: string;
  provider?: string;
  credits?: number;
  costYuan?: number;
  default?: boolean;
  tier?: 'fast' | 'standard' | 'quality' | string;
  tierLabel?: string;
  tierRank?: number;
  tierDesc?: string;
  displayName?: string;
  shortName?: string;
  supported?: boolean;
  statusLabel?: string;
  note?: string;
  requiresImage?: boolean;
};

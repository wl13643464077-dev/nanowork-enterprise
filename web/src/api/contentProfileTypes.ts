export type ContentImageMode = 'ai' | 'real' | 'mix';

export type ContentPlatformStyle = {
  name: string;
  desc: string;
};

/** Paihuo 原始内容 Brief。字段名保持 snake_case，不在网页层重命名。 */
export type PaihuoContentBrief = {
  direction: string;
  template: string;
  industry: string;
  material: string;
  ref_link: string;
  platforms: string[];
  image_mode: ContentImageMode;
  image_count: number | null;
  enable_deck: boolean;
  xhs_style: ContentPlatformStyle | null;
  dy_style: ContentPlatformStyle | null;
};

export type ContentEmployeeDispatchFormValues = {
  title: string;
  type: string;
  requirement: string;
  industry?: string;
  feedback?: string;
  dueAt?: string;
  platforms?: string[];
  imageMode?: ContentImageMode;
  imageCount?: number | null;
  enableDeck?: boolean;
  refLink?: string;
  xhsStyle?: Partial<ContentPlatformStyle> | null;
  dyStyle?: Partial<ContentPlatformStyle> | null;
};

export type ContentTenantProfileBrief = {
  direction: string;
  industry: string;
  material: string;
  platforms: string[];
  imageMode: ContentImageMode | null;
  imageCount: number | null;
  xhsStyle: ContentPlatformStyle | null;
  dyStyle: ContentPlatformStyle | null;
  refLink: string;
  template: string;
  enableDeck: boolean;
};

export type ContentTenantPersona = {
  positioning: string;
  audience: string;
  tone: string;
  catchphrases: string[];
  taboo: string[];
  style_notes: string;
  visual: string;
};

export type ContentTenantEnterprise = {
  brand: string;
  business: string;
  sellingPoints: string[];
  keywords: string[];
};

export type ContentTenantProfile = {
  schemaVersion?: string;
  brief: ContentTenantProfileBrief;
  persona: ContentTenantPersona;
  enterprise: ContentTenantEnterprise;
  fingerprint?: string;
};

export type ContentTenantProfileResponse = {
  schemaVersion: string;
  tenantId: number;
  revision: number;
  updatedAt: string | null;
  profile: ContentTenantProfile;
};

export type ContentBrandPersonaFormValues = {
  brand?: string;
  business?: string;
  sellingPoints?: string;
  keywords?: string;
  positioning?: string;
  audience?: string;
  tone?: string;
  catchphrases?: string;
  taboo?: string;
  styleNotes?: string;
  visual?: string;
};

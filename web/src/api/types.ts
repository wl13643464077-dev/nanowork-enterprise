// 关键读路径的 API 响应类型（FE-C1：逐文件收敛 any，从 useQuery 迁移点开始）

export interface DashboardSummary {
  todaySales: number;
  monthLeads?: number;
  pendingFollow?: number;
  runningActivities?: number;
}

export interface BriefingItem {
  text: string;
}
export interface DashboardBriefing {
  briefing: (string | BriefingItem)[];
}

export interface FollowRecord {
  created_at?: string;
  content: string;
  user_name?: string;
}

export interface Lead {
  id: number;
  name: string;
  grade: 'A' | 'B' | 'C' | string;
  stage: string;
  score?: number;
  identity_tag?: string;
  interest?: string;
  phone?: string;
  source?: string;
  budget_level?: string;
  next_action?: string;
  follows?: FollowRecord[];
}

export interface ContentItem {
  id: number;
  type: string;
  body: string;
  status?: string;
  delivery?: {
    canUse?: boolean;
    canImport?: boolean;
    canPublish?: boolean;
    canSubmitApproval?: boolean;
    presentationKey?: string;
    displayStatus?: string;
    reason?: string;
    nextAction?: string | null;
  };
}

export interface AdvisorConversation {
  id: number;
  title: string;
  diag_type?: string;
  msg_count?: number;
  pinned?: number | boolean;
  updated_at?: string;
  created_at?: string;
}

export interface MarshalNode {
  id?: number;
  code: string;
  name: string;
  title?: string;
  emoji?: string;
  avatar?: string;
  online?: boolean;
  running?: boolean;
}

export interface AdvisorCapability {
  radar: { name: string; score: number }[];
  networkStatus: MarshalNode[];
}

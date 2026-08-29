export type ContentCrewKey =
  | 'trend'
  | 'research'
  | 'benchmark'
  | 'draft'
  | 'style'
  | 'media'
  | 'cover'
  | 'deck'
  | 'publish'
  | 'retro'
  | 'commerce_video';

export type ContentCrewCapability = { name?: string; emoji?: string; desc?: string };

export type ContentCrewRuntime = {
  outputs?: number;
  mediaJobs?: number;
  lastCreatedAt?: string | null;
};

export type ContentCrewStation = {
  order: number;
  key: ContentCrewKey;
  name: string;
  group: string;
  emoji: string;
  person: string | null;
  optional: boolean;
  employeeIdx: number | null;
  moduleGroup?: string;
  skill?: string;
  color?: string;
  duty?: string;
  intro?: string;
  approval?: string;
  capabilities?: ContentCrewCapability[];
  // 目录卡片摘要（/content/crew 对全部角色返回）：能力数、前几项能力名、出厂技能数
  capabilityCount?: number;
  capabilityNames?: string[];
  skillCount?: number;
  outputKeys?: string[];
  taskTypes?: string[];
  runtime?: ContentCrewRuntime;
};

export const CONTENT_EXECUTION_STATIONS = {
  draft: { employeeIdx: 3, label: '文案 / 日更包' },
  media: { employeeIdx: 5, label: '图片 / 视频' },
  deck: { employeeIdx: 7, label: 'HTML 演绎 / 按需 PPT' },
} as const;

export const APPROVAL_LABELS: Record<string, string> = {
  auto: '岗位自检后交棒（不等于业务采纳）',
  pick: '人工选择后交棒',
  review: '进入人工审阅',
  force: '必须由指定负责人终审',
};

export const crewRuntimeText = (runtime?: ContentCrewRuntime) => {
  if (!runtime) return '暂无运行统计';
  const parts = [`内容产出 ${runtime.outputs ?? 0}`, `媒体任务 ${runtime.mediaJobs ?? 0}`];
  if (runtime.lastCreatedAt) parts.push(`最近运行 ${String(runtime.lastCreatedAt).replace('T', ' ').slice(0, 16)}`);
  return parts.join(' · ');
};

export const CONTENT_CREW_STATIONS: ContentCrewStation[] = [
  {
    order: 0,
    key: 'trend',
    name: '趋势官',
    group: '热点雷达部',
    emoji: '📡',
    person: null,
    optional: false,
    employeeIdx: null,
    taskTypes: ['趋势简报', '候选选题', '热点扫描'],
  },
  {
    order: 1,
    key: 'research',
    name: '情报员',
    group: '情报检索部',
    emoji: '🔎',
    person: null,
    optional: false,
    employeeIdx: null,
    taskTypes: ['事实资料包', '核验报告', '来源清单'],
  },
  {
    order: 2,
    key: 'benchmark',
    name: '拆解师',
    group: '爆款研究部',
    emoji: '🧩',
    person: null,
    optional: false,
    employeeIdx: null,
    taskTypes: ['爆款拆解', '评论洞察', '用户语言报告'],
  },
  {
    order: 3,
    key: 'draft',
    name: '撰稿人',
    group: '文案创作部',
    emoji: '✍️',
    person: null,
    optional: false,
    employeeIdx: null,
    taskTypes: ['文案初稿', '标题方案', '配图建议'],
  },
  {
    order: 4,
    key: 'style',
    name: '文风师',
    group: '风格工坊',
    emoji: '🎭',
    person: null,
    optional: false,
    employeeIdx: null,
    taskTypes: ['文风改写', '人设一致性校对', '表达优化稿'],
  },
  {
    order: 5,
    key: 'media',
    name: '多媒体师',
    group: '视觉工厂',
    emoji: '🎬',
    person: null,
    optional: false,
    employeeIdx: null,
    taskTypes: ['多媒体素材方案', '正文配图方案', 'SVG信息图方案'],
  },
  {
    order: 6,
    key: 'cover',
    name: '封面师',
    group: '封面设计部',
    emoji: '🖼️',
    person: null,
    optional: false,
    employeeIdx: null,
    taskTypes: ['封面方案', '封面备选组', '视觉钩子方案'],
  },
  {
    order: 7,
    key: 'deck',
    name: '演绎师',
    group: '互动演绎部',
    emoji: '📽️',
    person: null,
    optional: true,
    employeeIdx: null,
    taskTypes: ['HTML演绎稿', '网页演示方案', '交互演绎稿'],
  },
  {
    order: 8,
    key: 'publish',
    name: '分发官',
    group: '发行调度部',
    emoji: '🚀',
    person: null,
    optional: false,
    employeeIdx: null,
    taskTypes: ['平台发布包', '多平台适配稿', '发布终审清单'],
  },
  {
    order: 9,
    key: 'retro',
    name: '复盘官',
    group: '数据复盘部',
    emoji: '📊',
    person: null,
    optional: false,
    employeeIdx: null,
    taskTypes: ['复盘报告', '下一轮选题建议', '人设回流建议'],
  },
  {
    order: 10,
    key: 'commerce_video',
    name: 'AI带货员',
    group: '增长转化部',
    emoji: '🛍️',
    person: null,
    optional: false,
    employeeIdx: 10,
    duty: '根据人物、菜品或商品、门店图片，完成30秒带货脚本、分镜与成片任务',
    intro:
      '上传人物、菜品或商品、门头等真实素材，再说一句这次要卖什么，AI带货员会自动补齐脚本、三段镜头、字幕和视频生成流程。',
    approval: 'auto',
    taskTypes: ['30秒带货视频', '菜品口播视频', '门店探店转化视频'],
  },
];

// 内容生产仓的常量、标签映射与纯工具函数。
// 从 pages/ContentFactory.tsx 抽出（该文件近 5000 行，是全项目最大的单文件）。
// 拆解第一刀：无状态定义先出去，后续按 Tab 继续拆组件。
// 同步把分类色从硬编码 hex 改为 theme.css 的图表调色板 token，深浅主题自动适配。
import {
  AppstoreOutlined,
  CommentOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  FundProjectionScreenOutlined,
  GiftOutlined,
  MessageOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  ShopOutlined,
  TeamOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';

// 内容生成阶段轴：对应后端 content/generate 的真实执行顺序
export const GENERATE_STAGES = ['需求已提交', '检索素材与知识库', 'AI 生成中', '校验与交付'];

export const COPY_TYPES = [
  '短视频脚本',
  '朋友圈文案',
  '社群话题',
  '私聊邀约话术',
  '优惠话术',
  '招商文案',
  '复购礼赠文案',
  '合伙人每日素材包',
];
export const COPY_TYPE_LABELS: Record<string, string> = {
  招商文案: '合作推广文案',
  复购礼赠文案: '会员复购文案',
  合伙人每日素材包: '员工每日素材包',
};
export const contentTypeLabel = (type?: string) => COPY_TYPE_LABELS[type || ''] || type || '-';
// 「AI音频」后端无实现（无 generate-audio 接口），2026-07 升级中移除纯装饰入口；待真实 TTS 能力落地后再恢复
export const MEDIA_TABS = ['AI图片', 'AI视频', 'AIPPT'];
export const LIB_TABS = ['素材库', '模板库'];
export const BRANDS = ['门店品牌', '招牌菜系列', '企业团餐'];
export const STATUSES = ['草稿', '待审核', '可使用', '已发布', '已驳回'];
export const STATUS_COLOR: Record<string, string> = {
  草稿: 'default',
  待审核: 'gold',
  可使用: 'green',
  已发布: 'blue',
  已驳回: 'red',
};
export const CONTENT_FLOW_STATUSES = new Set(['可使用', '已发布']);
export const PUBLISH_VIEWS_MAX = 100_000_000;
export const PUBLISH_LEADS_MAX = 1_000_000;
const PUBLIC_CONTENT_STATUS: Record<string, string> = {
  草稿: '草稿（尚未达到业务可用）',
  待审核: '旧策略/显式策略待处理',
  // “可使用”是数据库兼容状态，既可能是旧版已采纳记录，也可能只是机器质检通过。
  // 缺少 delivery 权威投影时不猜结论，避免把未采纳内容误报成可用于业务。
  可使用: '可使用状态待权威核验',
  已发布: '已发布',
  已驳回: '失败需返工（历史策略未通过）',
};
export const contentStatusLabel = (rec: any) =>
  String(rec?.delivery?.displayStatus || PUBLIC_CONTENT_STATUS[String(rec?.status || '')] || '状态未知');
export const contentStatusColor = (rec: any) => {
  const presentationKey = String(rec?.delivery?.presentationKey || '');
  if (['published', 'adopted'].includes(presentationKey)) return presentationKey === 'published' ? 'blue' : 'green';
  if (['review_pending', 'review_ready'].includes(presentationKey)) return 'gold';
  if (presentationKey === 'business_blocked') return 'orange';
  if (presentationKey === 'rework_required') return 'red';
  if (String(rec?.status || '') === '可使用' && !rec?.delivery) return 'gold';
  return STATUS_COLOR[String(rec?.status || '')] || 'default';
};
const USABLE_CONTENT_MODES = new Set(['api', 'human_adopted', 'manual', 'human', 'human_authored', 'imported']);
const MANUAL_CONTENT_SOURCES = new Set(['manual', 'manual_import', 'human', 'human_import']);
const contentDeliveryMode = (rec: any) =>
  String(rec?.ai_mode ?? rec?.mode ?? '')
    .trim()
    .toLowerCase();
const hasUsableContentMode = (rec: any) => {
  const mode = contentDeliveryMode(rec);
  return (
    USABLE_CONTENT_MODES.has(mode) ||
    (mode === 'template' && MANUAL_CONTENT_SOURCES.has(String(rec?.source_type || '').toLowerCase()))
  );
};
export const contentFlowReady = (rec: any) =>
  rec?.delivery?.canUse === true && CONTENT_FLOW_STATUSES.has(String(rec?.status || '')) && hasUsableContentMode(rec);
export const canSubmitApproval = (rec: any) => rec?.delivery?.canSubmitApproval === true;
export const approvalBlockedReason = (rec: any) => {
  if (rec?.status === '已驳回') return '当前稿件人工审阅未通过，不能原样重提；请按意见返工并生成新修订稿';
  if (rec?.status === '已发布' && rec?.delivery?.canUse !== false) {
    return '已发布记录不能退回审阅；如需调整请新建修订稿';
  }
  if (rec?.status === '可使用' && rec?.delivery?.canUse === true) {
    return '该稿件已经人工采纳，可直接用于业务；如需修改请新建修订稿';
  }
  if (rec?.delivery?.reason) {
    return [rec.delivery.reason, rec.delivery.nextAction && `下一步：${rec.delivery.nextAction}`]
      .filter(Boolean)
      .join('；');
  }
  if (rec?.status === '待审核') return '该内容已经在人工审阅队列，无需重复提交';
  if (rec?.status === '已发布') return '已发布记录不能退回审阅；如需调整请新建修订稿';
  if (rec?.status === '可使用') return '当前接口没有返回人工采纳证据，请刷新后再判断是否需要提交审阅';
  return `内容当前为“${rec?.status || '未知'}”，还不能提交人工审阅`;
};
export const contentFlowBlockedReason = (rec: any) => {
  if (rec?.delivery?.canUse !== true && rec?.delivery) {
    return (
      [rec.delivery.reason, rec.delivery.nextAction && `下一步：${rec.delivery.nextAction}`]
        .filter(Boolean)
        .join('；') || '该内容尚未达到可验收或可采用状态'
    );
  }
  if (rec?.status === '待审核') return '内容正在等待人工审阅；采纳后才能导入素材或登记发布';
  if (rec?.status === '已驳回') return '人工审阅未通过；请按意见返工并提交新修订稿';
  const mode = contentDeliveryMode(rec);
  if (!hasUsableContentMode(rec))
    return mode
      ? `内容来源为“${mode}”，不是已验证的可交付产物`
      : '内容缺少可验证的产出来源，暂不能用于复制、导出、导入或发布';
  if (CONTENT_FLOW_STATUSES.has(String(rec?.status || ''))) return '人工采纳状态尚未同步，请刷新内容列表后再操作';
  return `内容当前为“${rec?.status || '未知'}”，尚未达到可采用状态`;
};
export const TYPE_META: Record<string, { icon: any; color: string }> = {
  短视频脚本: { icon: <VideoCameraOutlined />, color: 'var(--ui-accent)' },
  朋友圈文案: { icon: <MessageOutlined />, color: 'var(--chart-2)' },
  社群话题: { icon: <TeamOutlined />, color: 'var(--chart-3)' },
  私聊邀约话术: { icon: <CommentOutlined />, color: 'var(--chart-6)' },
  优惠话术: { icon: <GiftOutlined />, color: 'var(--danger)' },
  招商文案: { icon: <ShopOutlined />, color: 'var(--warn)' },
  复购礼赠文案: { icon: <GiftOutlined />, color: 'var(--danger)' },
  合伙人每日素材包: { icon: <FolderOutlined />, color: 'var(--ui-accent)' },
  AI图片: { icon: <PictureOutlined />, color: 'var(--chart-2)' },
  AI视频: { icon: <PlayCircleOutlined />, color: 'var(--chart-6)' },
  AIPPT: { icon: <FundProjectionScreenOutlined />, color: 'var(--warn)' },
};
export const TABS = [
  { key: 'AI文案', icon: <FileTextOutlined /> },
  { key: '素材库', icon: <FolderOpenOutlined /> },
  { key: '模板库', icon: <AppstoreOutlined /> },
];
// 固定创作模板只用于帮助用户起步，不代表系统读取了实时经营、热点或活动数据。
export const REFERENCE_SUGGESTIONS = [
  {
    title: '追加招牌菜制作短视频',
    summary: '围绕招牌菜的食材、制作和上桌场景补充 2 条可拍摄脚本，方便门店持续更新内容',
    verification: '使用前请人工确认招牌菜、真实食材、制作工序、可拍摄场景和当期内容排期。',
    reason: '从食材准备、关键工序到成品上桌，顾客能更直观地了解菜品特点，也方便员工按镜头清单执行。',
    action: {
      tab: 'AI文案',
      type: '短视频脚本',
      topic: '招牌菜制作过程与到店体验',
      requirement:
        '生成2条可直接拍摄的短视频脚本，开头展示成品，中段说明真实食材和关键工序，结尾邀请顾客了解菜单或预约到店；不承诺未经验证的效果。',
    },
  },
  {
    title: '主题试吃活动朋友圈预热',
    summary: '根据活动中心的主题试吃或会员活动排期，提前准备多角度的到店说明',
    verification: '使用前请人工确认活动确实存在，并核对日期、菜品、会员权益、适合人群和预约方式。',
    reason: '把活动主题、菜品亮点、适合人群和预约方式讲清楚，能帮助顾客判断是否适合参加。',
    action: {
      tab: 'AI文案',
      type: '朋友圈文案',
      topic: '主题试吃或会员活动预热',
      requirement:
        '生成5条朋友圈文案，分别从招牌菜亮点、活动流程、会员权益、适合人群和预约方式切入；只使用已确认信息，不制造名额紧张或效果承诺。',
    },
  },
  {
    title: '今晚社群互动话题',
    summary: '结合门店当日安排准备一组轻量互动话题，具体发送时间由运营人员根据真实社群情况确认',
    verification: '使用前请人工确认当日门店安排、社群状态和活动信息；系统没有据此模板推断实时顾客偏好。',
    reason: '先用与用餐场景相关的轻话题了解顾客偏好，再由员工根据真实回复决定是否继续沟通，可减少无依据的群发。',
    action: {
      tab: 'AI文案',
      type: '社群话题',
      topic: '今晚用餐偏好互动话题',
      requirement:
        '生成3条轻量、有参与感的社群互动话题，围绕口味、招牌菜或用餐场景，最后自然说明本周主题试吃或会员活动。',
    },
  },
];
export const DOT_COLORS = ['var(--ui-accent)', 'var(--chart-2)', 'var(--warn)'];
export const ell = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const;
export const interactiveSurfaceStyle = {
  appearance: 'none',
  border: 0,
  padding: 0,
  margin: 0,
  width: '100%',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  textAlign: 'inherit',
} as const;
export const fmtTime = (s?: string) => (s || '').replace('T', ' ').slice(5, 16);
export const fmtNum = (n: any) => {
  const v = Number(n || 0);
  return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : `${v}`;
};
export const splitTags = (v: any) =>
  (Array.isArray(v) ? v : String(v || '').split(/[,，、\s]+/)).map((x: string) => x.trim()).filter(Boolean);
export const sourceLabel = (v?: string) =>
  (({ content: 'AI生成内容', media_job: 'AI媒体任务', manual: '人工导入' }) as Record<string, string>)[v || ''] ||
  v ||
  '未知来源';

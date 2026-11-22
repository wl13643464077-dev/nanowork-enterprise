// ===== 销售演示脱敏样例数据预置引擎（R-01）=====
// 严格护栏：
// 1. 必须显式传入合法且已存在的 tenantId，绝不默认写入总部或未知生产租户。
// 2. 100% 幂等：所有表均按固定脱敏编号/唯一键去重，重复执行不翻倍、不覆盖已有真实业务数据。
// 3. 支持 dryRun: true 零写入预览。
// 4. 全部采用中性脱敏示范品牌「味尚小馆」（望京店/国贸店/三里屯店），不含任何真实客户隐私。
import { db, q, runWithTenant } from '../db.js';
import { INSPECTION_EMPLOYEE_IDX, inspectionStandardsVersion } from './store-inspections.js';

export const DEMO_BRAND_NAME = '味尚小馆';

const DEMO_STORES = Object.freeze([
  {
    code: 'DEMO-S01',
    name: '味尚小馆·望京店',
    city: '北京',
    area: '朝阳区',
    region: '华北',
    address: '北京市朝阳区望京示范商业街8号',
    biz_type: '正餐',
    opened_at: '2024-06-15',
    status: '营业中',
    revenueFactor: 1.15,
  },
  {
    code: 'DEMO-S02',
    name: '味尚小馆·国贸店',
    city: '北京',
    area: '朝阳区',
    region: '华北',
    address: '北京市朝阳区国贸示范广场B1层',
    biz_type: '正餐',
    opened_at: '2024-09-20',
    status: '营业中',
    revenueFactor: 1.0,
  },
  {
    code: 'DEMO-S03',
    name: '味尚小馆·三里屯店',
    city: '北京',
    area: '朝阳区',
    region: '华北',
    address: '北京市朝阳区三里屯示范里2层',
    biz_type: '正餐',
    opened_at: '2025-03-10',
    status: '营业中',
    revenueFactor: 0.92,
  },
]);

// 12 道示范菜品档案（跨多品类通用风格，每店 4 道，合并后完整点亮菜品 TOP10）
const DEMO_DISHES = Object.freeze([
  { code: 'DEMO-D01', storeIdx: 0, name: '招牌鲜椒牛蛙', category: '招牌主菜', price: 78, cost: 27.5, unit: '份', baseQty: 4 },
  { code: 'DEMO-D02', storeIdx: 0, name: '炭烤黑椒猪颈肉', category: '招牌主菜', price: 62, cost: 21.0, unit: '份', baseQty: 3 },
  { code: 'DEMO-D03', storeIdx: 0, name: '砂锅蒜蓉粉丝虾', category: '汤煲炖品', price: 68, cost: 25.0, unit: '份', baseQty: 3 },
  { code: 'DEMO-D04', storeIdx: 0, name: '手打暴打柠檬茶', category: '饮品甜品', price: 18, cost: 4.2, unit: '杯', baseQty: 5 },
  { code: 'DEMO-D05', storeIdx: 1, name: '金汤酸菜鲈鱼', category: '招牌主菜', price: 88, cost: 31.0, unit: '份', baseQty: 3 },
  { code: 'DEMO-D06', storeIdx: 1, name: '干锅有机花菜', category: '热炒小炒', price: 36, cost: 10.5, unit: '份', baseQty: 3 },
  { code: 'DEMO-D07', storeIdx: 1, name: '现熬老母鸡菌菇汤', category: '汤煲炖品', price: 72, cost: 24.0, unit: '煲', baseQty: 2 },
  { code: 'DEMO-D08', storeIdx: 1, name: '黑糖手工冰粉', category: '饮品甜品', price: 15, cost: 3.5, unit: '碗', baseQty: 4 },
  { code: 'DEMO-D09', storeIdx: 2, name: '秘制果木烤鸡', category: '招牌主菜', price: 82, cost: 28.0, unit: '只', baseQty: 2 },
  { code: 'DEMO-D10', storeIdx: 2, name: '椒麻口水鸡', category: '凉菜开胃', price: 42, cost: 14.0, unit: '份', baseQty: 3 },
  { code: 'DEMO-D11', storeIdx: 2, name: '葱油拌面配煎蛋', category: '主食面点', price: 26, cost: 6.8, unit: '碗', baseQty: 4 },
  { code: 'DEMO-D12', storeIdx: 2, name: '桂花乌龙冷泡茶', category: '饮品甜品', price: 19, cost: 4.5, unit: '瓶', baseQty: 3 },
]);

// 12 条多平台脱敏评价（覆盖美团/大众点评/饿了么/抖音；含好评、差评、六类归因与超时待回复）
const DEMO_REVIEWS = Object.freeze([
  {
    storeIdx: 0,
    platform: '大众点评',
    rating: 5,
    author: '望京食客阿杰',
    daysAgo: 1,
    status: '已回复',
    category: null,
    content: '下班和同事聚餐点的招牌鲜椒牛蛙和蒜蓉粉丝虾，上菜速度很快，服务员主动帮忙加茶水，环境干净亮堂，还会再来！',
    reply: '感谢阿杰对望京店的认可！鲜椒牛蛙坚持现点现做，期待下次和同事再来尝尝我们的季节新菜。',
  },
  {
    storeIdx: 0,
    platform: '美团',
    rating: 2,
    author: '上班族林女士',
    daysAgo: 2,
    status: '待回复',
    category: '出餐慢',
    content: '周五晚市七点半到店，等位二十多分钟还能理解，但点完菜又等了快四十分钟才上第一道热菜，催了两次才端上来，体验一般。',
    reply: null,
  },
  {
    storeIdx: 0,
    platform: '饿了么',
    rating: 1,
    author: '匿名食客W18',
    daysAgo: 3,
    status: '待回复',
    category: '漏发错发',
    content: '双人工作餐下单备注多双筷子，结果打开一看手打暴打柠檬茶根本没装进来，少发了一杯饮料，联系门店半天才补退。',
    reply: null,
  },
  {
    storeIdx: 0,
    platform: '抖音',
    rating: 5,
    author: '探店达人小陈',
    daysAgo: 5,
    status: '已回复',
    category: null,
    content: '刷到团购来的，炭烤黑椒猪颈肉外焦里嫩非常下饭，两个人团的双人餐分量很足，性价比在望京商圈算很能打的。',
    reply: '谢谢小陈打卡推荐！黑椒猪颈肉每天限量腌制现烤，欢迎随时再来体验新品套餐。',
  },
  {
    storeIdx: 1,
    platform: '大众点评',
    rating: 5,
    author: 'CBD白领周先生',
    daysAgo: 1,
    status: '待回复',
    category: null,
    content: '国贸中午招待客户很省心，金汤酸菜鲈鱼鱼片鲜嫩没刺，现熬老母鸡菌菇汤很清甜，包间安静私密，客户很满意。',
    reply: null,
  },
  {
    storeIdx: 1,
    platform: '美团',
    rating: 2,
    author: '聚餐常客孙女士',
    daysAgo: 2,
    status: '待回复',
    category: '口味出品',
    content: '之前来吃酸菜鲈鱼很好吃，今天这锅明显偏咸而且汤底有点油腻，跟服务员反馈后只是口头道了个歉，希望后厨稳定一下出品标准。',
    reply: null,
  },
  {
    storeIdx: 1,
    platform: '饿了么',
    rating: 3,
    author: '国贸食客小陆',
    daysAgo: 4,
    status: '已回复',
    category: '配送问题',
    content: '味道本身不错，但是鸡汤的打包盒盖子没扣严实，骑手送到的时候袋子里洒了差不多三分之一，建议换防漏密封碗。',
    reply: '非常抱歉给您带来不便！国贸店已全面升级防漏双扣汤盒并加贴封口条，已为您登记无门槛补偿券，期待下次让您满意。',
  },
  {
    storeIdx: 1,
    platform: '美团',
    rating: 4,
    author: '爱吃甜品的萌萌',
    daysAgo: 6,
    status: '已回复',
    category: null,
    content: '干锅有机花菜锅气十足，黑糖手工冰粉解腻神器，唯一小建议是午市扫码点单高峰期页面加载稍慢。',
    reply: '感谢萌萌的细致反馈！我们已优化午市点单网络配置，期待您再来品尝冰粉和热菜。',
  },
  {
    storeIdx: 2,
    platform: '大众点评',
    rating: 2,
    author: '三里屯夜宵党阿凯',
    daysAgo: 1,
    status: '待回复',
    category: '服务态度',
    content: '晚上九点带朋友来吃秘制果木烤鸡，问服务员还有没有靠窗位置，对方爱答不理直接说没位自己等，语气挺冲的，影响吃饭心情。',
    reply: null,
  },
  {
    storeIdx: 2,
    platform: '抖音',
    rating: 5,
    author: '周末爱逛街的米粒',
    daysAgo: 3,
    status: '已回复',
    category: null,
    content: '果木烤鸡端上来香气扑鼻，配椒麻口水鸡和桂花乌龙冷泡茶太绝了，拍照出片率超高，朋友聚会首选！',
    reply: '谢谢米粒的好评与晒图！三里屯店晚市还有微醺冷泡饮品组合，欢迎常约朋友来坐坐。',
  },
  {
    storeIdx: 2,
    platform: '美团',
    rating: 3,
    author: '附近住户赵阿姨',
    daysAgo: 5,
    status: '已回复',
    category: '口味出品',
    content: '葱油拌面挺香的，但椒麻口水鸡今天偏麻了一点，家里老人不太能吃辣，如果菜单上能标清楚辣度等级就更贴心了。',
    reply: '谢谢赵阿姨的暖心建议！门店点单页已补充微辣/免辣标注，下次来可以直接选免辣版，祝家人身体健康。',
  },
  {
    storeIdx: 2,
    platform: '饿了么',
    rating: 5,
    author: '加班程序员小吴',
    daysAgo: 7,
    status: '已回复',
    category: null,
    content: '深夜点了一份葱油拌面配煎蛋加口水鸡，打包很严实而且面条和葱油分装不坨，非常用心的细节！',
    reply: '感谢小吴认可！面酱分装是我们坚持的小细节，加班辛苦了，随时为您提供热乎好饭。',
  },
]);

// 2 条 #161 查巡巡 示范巡店记录（含高危食安/运营问题与整改台账闭环）
const DEMO_INSPECTIONS = Object.freeze([
  {
    storeIdx: 0,
    title: '【示范巡店】味尚小馆·望京店 例行巡店报告（#161 查巡巡）',
    inspectionType: '例行巡店',
    supervisorName: '查巡巡（区域督导）',
    daysAgo: 2,
    score: 78.5,
    subScores: { foodSafety: 14, product: 17, service: 16.5, hygiene: 15, display: 16 },
    issues: [
      {
        board: '食品安全',
        severity: '高',
        problem: '冷菜间冰箱内部温度显示 8.6℃ 超过 0–4℃ 标准，且部分半成品未贴效期标签。',
        evidence: '后厨冷菜间温控表与备料盒抽检记录（示范样例）',
        action: '当日联系维保校准冷柜温控，立即补齐全部半成品效期签并纳入闭店复核。',
        deadline: '24小时内',
      },
      {
        board: '消防安全',
        severity: '高',
        problem: '后厨安全疏散通道堆放两箱未拆封饮料纸箱，占用有效通行宽度。',
        evidence: '后厨西侧安全出口巡查留痕（示范样例）',
        action: '现场立即清空疏散通道杂物，划定库房暂存黄线并由值班经理每日巡查。',
        deadline: '立即整改',
      },
      {
        board: '出餐效率',
        severity: '中',
        problem: '晚市高峰 19:00–20:00 传菜口积压 5 单，招牌鲜椒牛蛙平均出餐达 26 分钟。',
        evidence: '晚市 POS 划菜记录与出餐台抽测（示范样例）',
        action: '高峰期增配 1 名机动传菜员，牛蛙底料提前按单份标准预分装。',
        deadline: '3日内',
      },
    ],
    rectifications: [
      { issueIndex: 0, status: 'in_progress', assigneeName: '望京店厨师长', dueDaysOffset: 1 },
      {
        issueIndex: 1,
        status: 'completed',
        assigneeName: '望京店店长',
        dueDaysOffset: 0,
        recheckNote: '通道纸箱已全部移入库房货架，疏散门畅通，现场复检合格。',
        recheckBy: '查巡巡（区域督导）',
      },
    ],
  },
  {
    storeIdx: 1,
    title: '【示范巡店】味尚小馆·国贸店 飞行检查报告（#161 查巡巡）',
    inspectionType: '飞行检查',
    supervisorName: '查巡巡（区域督导）',
    daysAgo: 5,
    score: 88.0,
    subScores: { foodSafety: 18, product: 17, service: 18, hygiene: 17.5, display: 17.5 },
    issues: [
      {
        board: '出品标准',
        severity: '高',
        problem: '金汤酸菜鲈鱼抽测盐度偏高，热菜炉头未按克重勺标准定量投料。',
        evidence: '午市抽检留样与炒锅调味台检查（示范样例）',
        action: '恢复标准定量勺投料并对 2 名炒锅师傅开展味型复训，连续 3 天留样复测。',
        deadline: '48小时内',
      },
      {
        board: '外卖打包',
        severity: '中',
        problem: '汤品类外卖仍混用旧款单扣餐盒，存在配送泼洒风险。',
        evidence: '外卖打包台物料核查（示范样例）',
        action: '统一切换防漏双扣汤盒并张贴食安封签，旧款包材退回库房封存。',
        deadline: '3日内',
      },
    ],
    rectifications: [
      { issueIndex: 0, status: 'in_progress', assigneeName: '国贸店厨师长', dueDaysOffset: 2 },
    ],
  },
]);

function formatLocalDate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dateOffset(daysBack) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return formatLocalDate(d);
}

function futureDateOffset(daysForward) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + daysForward);
  return formatLocalDate(d);
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function ensureInspectionSpecialist() {
  let specialist = q.get(
    'SELECT id, marshal_id FROM specialists WHERE employee_idx = ? LIMIT 1',
    INSPECTION_EMPLOYEE_IDX,
  );
  if (specialist) return specialist;
  q.run(
    `INSERT INTO marshals(code, name, title, emoji, duty, online, sort)
     VALUES('M-05', '门店运营部', '门店运营与督导部', '🏪', '门店巡检、SOP落地与营运提效', 1, 5)
     ON CONFLICT(code) DO NOTHING`,
  );
  const marshal = q.get("SELECT id FROM marshals WHERE code = 'M-05' LIMIT 1");
  q.run(
    `INSERT OR IGNORE INTO specialists(marshal_id, name, duty, status, employee_idx, key, person, emoji, group_name, sort)
     VALUES(?, ?, ?, '空闲', ?, '61-store-inspection-supervisor', '查巡巡', '🔍', '门店运营部', 60)`,
    marshal.id,
    '巡店督导',
    '按食安与营运标准执行门店巡检并输出整改闭环',
    INSPECTION_EMPLOYEE_IDX,
  );
  specialist = q.get(
    'SELECT id, marshal_id FROM specialists WHERE employee_idx = ? LIMIT 1',
    INSPECTION_EMPLOYEE_IDX,
  );
  return specialist;
}

function emptyCounter() {
  return { created: 0, skipped: 0, total: 0 };
}

function recordCount(counter, isCreated) {
  counter.total += 1;
  if (isCreated) counter.created += 1;
  else counter.skipped += 1;
}

/**
 * 为指定租户幂等预置脱敏销售演示数据集（14 天经营曲线 + 3 店 + 12 菜品 + 订单明细 + 12 评价 + 2 巡店及整改）。
 *
 * @param {object} options
 * @param {number} options.tenantId - 必填，必须为已存在的合法正整数租户 ID
 * @param {number|null} [options.actorUserId=null] - 可选操作人用户 ID
 * @param {boolean} [options.dryRun=false] - 为 true 时仅预览写入条目数，对数据库零修改
 */
export function seedSalesDemoDataset({ tenantId, actorUserId = null, dryRun = false } = {}) {
  const tid = Number(tenantId);
  if (!Number.isSafeInteger(tid) || tid <= 0) {
    throw new Error('安全护栏：必须显式提供合法的正整数 tenantId，禁止对未知租户写入演示数据。');
  }
  const tenant = q.get('SELECT id, name, status, data_mode FROM tenants WHERE id = ?', tid);
  if (!tenant) {
    throw new Error(`安全护栏：租户 #${tid} 不存在，已中止预置演示数据。`);
  }

  const actorId =
    actorUserId != null && Number.isSafeInteger(Number(actorUserId)) && Number(actorUserId) > 0
      ? Number(actorUserId)
      : null;

  const summary = {
    tenantId: tid,
    tenantName: tenant.name,
    dryRun: Boolean(dryRun),
    stores: emptyCounter(),
    dishes: emptyCounter(),
    dailyOps: emptyCounter(),
    storeDailyOps: emptyCounter(),
    orders: emptyCounter(),
    orderItems: emptyCounter(),
    costs: emptyCounter(),
    reviews: emptyCounter(),
    inspections: emptyCounter(),
    rectifications: emptyCounter(),
  };

  return runWithTenant(tid, () => {
    const execute = () => {
      // 1. 预置 3 家示范门店
      const hasDefaultStore = Boolean(
        q.get('SELECT id FROM stores WHERE tenant_id = ? AND is_default = 1 LIMIT 1', tid),
      );
      const storeIds = [];
      let virtualId = -1;
      for (let i = 0; i < DEMO_STORES.length; i += 1) {
        const s = DEMO_STORES[i];
        const existed = q.get(
          'SELECT id FROM stores WHERE tenant_id = ? AND (code = ? OR name = ?) LIMIT 1',
          tid,
          s.code,
          s.name,
        );
        if (existed) {
          recordCount(summary.stores, false);
          storeIds.push(existed.id);
        } else {
          recordCount(summary.stores, true);
          if (dryRun) {
            storeIds.push(virtualId--);
          } else {
            const isDefault = i === 0 && !hasDefaultStore ? 1 : 0;
            const res = q.run(
              `INSERT INTO stores(tenant_id, name, code, address, city, area, region, biz_type, opened_at, status, is_default)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              tid,
              s.name,
              s.code,
              s.address,
              s.city,
              s.area,
              s.region,
              s.biz_type,
              s.opened_at,
              s.status,
              isDefault,
            );
            storeIds.push(Number(res.lastInsertRowid));
          }
        }
      }

      // 2. 预置 12 道示范菜品档案
      const dishRecords = [];
      for (const d of DEMO_DISHES) {
        const storeId = storeIds[d.storeIdx];
        const existed = q.get(
          'SELECT id, store_id FROM dishes WHERE tenant_id = ? AND code = ? LIMIT 1',
          tid,
          d.code,
        );
        if (existed) {
          recordCount(summary.dishes, false);
          dishRecords.push({ ...d, id: existed.id, storeId: existed.store_id });
        } else {
          recordCount(summary.dishes, true);
          if (dryRun) {
            dishRecords.push({ ...d, id: virtualId--, storeId });
          } else {
            const res = q.run(
              `INSERT INTO dishes(tenant_id, store_id, name, code, category, price, cost, unit, status)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, '在售')`,
              tid,
              storeId,
              d.name,
              d.code,
              d.category,
              d.price,
              d.cost,
              d.unit,
            );
            dishRecords.push({ ...d, id: Number(res.lastInsertRowid), storeId });
          }
        }
      }

      // 3. 预置近 14 天经营日报（daily_ops）、分店日结（store_daily_ops）、订单（orders）与明细（order_items）
      const DAYS = 14;
      const CHANNELS = ['美团', '大众点评', '到店自然流', '抖音团购'];
      const ORDER_TYPES = ['到店', '外卖', '到店'];

      for (let offset = DAYS - 1; offset >= 0; offset -= 1) {
        const dayIndex = DAYS - 1 - offset; // 0 .. 13（递增趋势）
        const dateStr = dateOffset(offset);
        const dayObj = new Date(`${dateStr}T12:00:00`);
        const isWeekend = dayObj.getDay() === 0 || dayObj.getDay() === 6;
        const trendBoost = 1 + dayIndex * 0.015;
        const weekendBoost = isWeekend ? 1.24 : 1.0;

        let tenantDayRevenue = 0;
        let tenantDayOrders = 0;

        for (let sIdx = 0; sIdx < DEMO_STORES.length; sIdx += 1) {
          const store = DEMO_STORES[sIdx];
          const storeId = storeIds[sIdx];
          const storeDishes = dishRecords.filter((item) => item.storeIdx === sIdx);

          // 每天每店生成 2 笔订单（午市 + 晚市），共 14 * 3 * 2 = 84 笔订单与完整菜品明细
          let storeOrderRevenue = 0;
          let storeDeliveryRevenue = 0;

          for (let slot = 0; slot < 2; slot += 1) {
            const mealTime = slot === 0 ? `12:1${sIdx}:0${slot + 1}` : `18:4${sIdx}:0${slot + 1}`;
            const createdAt = `${dateStr} ${mealTime}`;
            const orderType = slot === 0 && (dayIndex + sIdx) % 3 === 1 ? '外卖' : ORDER_TYPES[(dayIndex + sIdx + slot) % ORDER_TYPES.length];
            const channel = orderType === '外卖' ? (sIdx % 2 === 0 ? '美团' : '饿了么') : CHANNELS[(dayIndex + sIdx + slot) % CHANNELS.length];

            // 挑选 3 道本门店菜品形成订单明细（覆盖全部 12 道菜品）
            const picks = [
              storeDishes[0],
              storeDishes[(dayIndex + slot) % 2 === 0 ? 1 : 2],
              storeDishes[3],
            ];
            const items = picks.map((dish, idx) => {
              const qty = Math.max(
                1,
                Math.round((dish.baseQty - (idx === 1 ? 1 : 0)) * (isWeekend ? 1.3 : 1) * (slot === 1 ? 1.2 : 1)),
              );
              const lineAmount = round2(dish.price * qty);
              return { dish, qty, unitPrice: dish.price, amount: lineAmount };
            });
            const orderAmount = round2(items.reduce((sum, item) => sum + item.amount, 0));
            const productLabel = `${picks[0].name}、${picks[1].name} 等${items.length}道`;

            storeOrderRevenue += orderAmount;
            if (orderType === '外卖') storeDeliveryRevenue += orderAmount;

            const existedOrder =
              storeId > 0
                ? q.get(
                    `SELECT id FROM orders
                     WHERE tenant_id = ? AND store_id = ? AND created_at = ? AND product = ? LIMIT 1`,
                    tid,
                    storeId,
                    createdAt,
                    productLabel,
                  )
                : null;

            if (existedOrder) {
              recordCount(summary.orders, false);
              for (let k = 0; k < items.length; k += 1) recordCount(summary.orderItems, false);
            } else {
              recordCount(summary.orders, true);
              let orderId = virtualId--;
              if (!dryRun) {
                const res = q.run(
                  `INSERT INTO orders(tenant_id, lead_id, product, amount, type, region, channel, store_id, created_at)
                   VALUES(?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
                  tid,
                  productLabel,
                  orderAmount,
                  orderType,
                  store.region,
                  channel,
                  storeId,
                  createdAt,
                );
                orderId = Number(res.lastInsertRowid);
              }
              for (const item of items) {
                recordCount(summary.orderItems, true);
                if (!dryRun) {
                  q.run(
                    `INSERT INTO order_items(tenant_id, order_id, dish_id, dish_name_snapshot, qty, unit_price, amount, discount, created_at)
                     VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?)`,
                    tid,
                    orderId,
                    item.dish.id,
                    item.dish.name,
                    item.qty,
                    item.unitPrice,
                    item.amount,
                    createdAt,
                  );
                }
              }
            }
          }

          // 分店每日营业汇总 store_daily_ops
          const storeDayOrdersCount = Math.round(46 * store.revenueFactor * trendBoost * weekendBoost);
          const storeDayRevTotal = round2(storeOrderRevenue * 4.5);
          const avgTicket = round2(storeDayRevTotal / Math.max(1, storeDayOrdersCount));
          const deliveryRatio = round2((storeDeliveryRevenue / Math.max(1, storeOrderRevenue)) * 100);
          tenantDayRevenue += storeDayRevTotal;
          tenantDayOrders += storeDayOrdersCount;

          const existedStoreDaily =
            storeId > 0
              ? q.get(
                  'SELECT id FROM store_daily_ops WHERE tenant_id = ? AND store_id = ? AND date = ? LIMIT 1',
                  tid,
                  storeId,
                  dateStr,
                )
              : null;
          if (existedStoreDaily) {
            recordCount(summary.storeDailyOps, false);
          } else {
            recordCount(summary.storeDailyOps, true);
            if (!dryRun) {
              q.run(
                `INSERT INTO store_daily_ops(tenant_id, store_id, date, revenue, orders, avg_ticket, delivery_revenue, delivery_ratio, refunds, note, source)
                 VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, '演示样例日结汇总', 'manual')`,
                tid,
                storeId,
                dateStr,
                storeDayRevTotal,
                storeDayOrdersCount,
                avgTicket,
                round2(storeDeliveryRevenue * 4.5),
                deliveryRatio,
              );
            }
          }
        }

        // 租户级经营日报 daily_ops（UNIQUE(tenant_id, date)）
        const existedDaily = q.get(
          'SELECT id FROM daily_ops WHERE tenant_id = ? AND date = ? LIMIT 1',
          tid,
          dateStr,
        );
        if (existedDaily) {
          recordCount(summary.dailyOps, false);
        } else {
          recordCount(summary.dailyOps, true);
          if (!dryRun) {
            const newLeads = Math.round((18 + dayIndex * 0.8) * weekendBoost);
            const invited = Math.round(newLeads * 0.65);
            const arrived = Math.round(invited * 0.72);
            const deals = Math.round(arrived * 0.62);
            const marketingCost = round2(tenantDayRevenue * 0.068);
            const repurchaseAmount = round2(tenantDayRevenue * 0.28);
            q.run(
              `INSERT INTO daily_ops(
                 tenant_id, date, content_count, new_leads, invited, arrived, deals,
                 deal_amount, repurchase_amount, active_partners, orders, marketing_cost,
                 week_problem, next_action, store_id
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
              tid,
              dateStr,
              isWeekend ? 4 : 3,
              newLeads,
              invited,
              arrived,
              deals,
              round2(tenantDayRevenue),
              repurchaseAmount,
              3,
              tenantDayOrders,
              marketingCost,
              offset <= 2 ? '晚市高峰局部出餐偏慢，外卖差评需 24 小时内回访' : '',
              offset <= 2 ? '推进招牌双人餐引流与冷菜间温控复检' : '',
            );
          }
        }
      }

      // 4. 预置当期门店成本（用于点亮毛利率/经营利润率/成本率卡片）
      const costDate = dateOffset(1);
      const COST_SPECS = [
        { category: '食材', ratio: 0.34 },
        { category: '人力', ratio: 0.21 },
        { category: '营销', ratio: 0.06 },
      ];
      for (let sIdx = 0; sIdx < DEMO_STORES.length; sIdx += 1) {
        const storeId = storeIds[sIdx];
        const baseOrderSum = round2(4800 * DEMO_STORES[sIdx].revenueFactor);
        for (const spec of COST_SPECS) {
          const note = '演示样例成本';
          const existedCost =
            storeId > 0
              ? q.get(
                  `SELECT id FROM costs
                   WHERE tenant_id = ? AND store_id = ? AND date = ? AND category = ? AND note = ? LIMIT 1`,
                  tid,
                  storeId,
                  costDate,
                  spec.category,
                  note,
                )
              : null;
          if (existedCost) {
            recordCount(summary.costs, false);
          } else {
            recordCount(summary.costs, true);
            if (!dryRun) {
              q.run(
                `INSERT INTO costs(tenant_id, store_id, date, category, amount, note)
                 VALUES(?, ?, ?, ?, ?, ?)`,
                tid,
                storeId,
                costDate,
                spec.category,
                round2(baseOrderSum * spec.ratio),
                note,
              );
            }
          }
        }
      }

      // 5. 预置 12 条多平台示范评价
      for (const rev of DEMO_REVIEWS) {
        const store = DEMO_STORES[rev.storeIdx];
        const storeId = storeIds[rev.storeIdx];
        const reviewDate = dateOffset(rev.daysAgo);
        const existed = q.get(
          `SELECT id FROM store_reviews
           WHERE tenant_id = ? AND platform = ? AND author = ? AND content = ? LIMIT 1`,
          tid,
          rev.platform,
          rev.author,
          rev.content,
        );
        if (existed) {
          recordCount(summary.reviews, false);
        } else {
          recordCount(summary.reviews, true);
          if (!dryRun) {
            const createdAt = `${reviewDate} 14:20:00`;
            const repliedAt = rev.reply ? `${reviewDate} 16:05:00` : null;
            q.run(
              `INSERT INTO store_reviews(
                 tenant_id, platform, rating, content, author, store_name, review_date,
                 status, category, reply, replied_at, created_by, created_at, store_id
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              tid,
              rev.platform,
              rev.rating,
              rev.content,
              rev.author,
              store.name,
              reviewDate,
              rev.status,
              rev.category,
              rev.reply,
              repliedAt,
              actorId,
              createdAt,
              storeId,
            );
          }
        }
      }

      // 6. 预置 2 条 #161 查巡巡 示范巡店记录及整改台账
      const specialist = dryRun
        ? q.get('SELECT id, marshal_id FROM specialists WHERE employee_idx = ? LIMIT 1', INSPECTION_EMPLOYEE_IDX)
        : ensureInspectionSpecialist();
      const stdVersion = inspectionStandardsVersion();

      for (const insp of DEMO_INSPECTIONS) {
        const store = DEMO_STORES[insp.storeIdx];
        const storeId = storeIds[insp.storeIdx];
        const createdDate = dateOffset(insp.daysAgo);
        const createdAt = `${createdDate} 15:30:00`;
        const highIssues = insp.issues.filter((item) => item.severity === '高').length;

        const existedTask = q.get(
          'SELECT id FROM agent_tasks WHERE tenant_id = ? AND title = ? LIMIT 1',
          tid,
          insp.title,
        );
        let taskId = existedTask?.id ?? null;

        if (!taskId && !dryRun) {
          const taskRes = q.run(
            `INSERT INTO agent_tasks(
               tenant_id, marshal_id, specialist_id, title, type, requirement, status, is_collab, created_by, created_at
             ) VALUES(?, ?, ?, ?, '检查清单', ?, '已完成', 0, ?, ?)`,
            tid,
            specialist.marshal_id,
            specialist.id,
            insp.title,
            `对「${store.name}」执行${insp.inspectionType}并按国家法规与营运标准打分归档。`,
            actorId,
            createdAt,
          );
          taskId = Number(taskRes.lastInsertRowid);
        }

        const existedInsp =
          taskId != null
            ? q.get(
                'SELECT id FROM store_inspections WHERE tenant_id = ? AND task_id = ? LIMIT 1',
                tid,
                taskId,
              )
            : null;

        let inspectionId = existedInsp?.id ?? null;
        if (existedInsp) {
          recordCount(summary.inspections, false);
        } else {
          recordCount(summary.inspections, true);
          if (!dryRun) {
            const rectifiedObj = {
              done: insp.rectifications.filter((r) => r.status === 'completed').length,
              partial: 0,
              pending: insp.rectifications.filter((r) => r.status !== 'completed').length,
            };
            const inspRes = q.run(
              `INSERT INTO store_inspections(
                 tenant_id, task_id, content_id, supervisor_user_id, supervisor_name, store_name,
                 inspection_type, score, sub_scores_json, issue_count, high_issues,
                 issues_json, rectified_json, standards_version, store_id, created_at
               ) VALUES(?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              tid,
              taskId,
              actorId,
              insp.supervisorName,
              store.name,
              insp.inspectionType,
              insp.score,
              JSON.stringify(insp.subScores),
              insp.issues.length,
              highIssues,
              JSON.stringify(insp.issues),
              JSON.stringify(rectifiedObj),
              stdVersion,
              storeId,
              createdAt,
            );
            inspectionId = Number(inspRes.lastInsertRowid);
          }
        }

        for (const rect of insp.rectifications) {
          const issue = insp.issues[rect.issueIndex];
          if (!issue) continue;
          const existedRect =
            inspectionId != null
              ? q.get(
                  `SELECT id FROM store_inspection_rectifications
                   WHERE tenant_id = ? AND inspection_id = ? AND issue_index = ? LIMIT 1`,
                  tid,
                  inspectionId,
                  rect.issueIndex,
                )
              : null;
          if (existedRect) {
            recordCount(summary.rectifications, false);
          } else {
            recordCount(summary.rectifications, true);
            if (!dryRun) {
              const dueDate = futureDateOffset(rect.dueDaysOffset);
              const recheckAt = rect.status === 'completed' ? `${createdDate} 18:10:00` : null;
              q.run(
                `INSERT INTO store_inspection_rectifications(
                   tenant_id, inspection_id, issue_index, store_name, store_id, board, severity,
                   problem, action_plan, assignee_id, assignee_name, task_id, status, due_date,
                   recheck_note, recheck_by, recheck_at
                 ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
                tid,
                inspectionId,
                rect.issueIndex,
                store.name,
                storeId,
                issue.board,
                issue.severity,
                issue.problem,
                issue.action,
                rect.assigneeName,
                taskId,
                rect.status,
                dueDate,
                rect.recheckNote || null,
                rect.recheckBy || null,
                recheckAt,
              );
            }
          }
        }
      }
    };

    if (dryRun) {
      execute();
    } else {
      db.exec('SAVEPOINT demo_sample_seed;');
      try {
        execute();
        db.exec('RELEASE SAVEPOINT demo_sample_seed;');
      } catch (err) {
        db.exec('ROLLBACK TO SAVEPOINT demo_sample_seed;');
        db.exec('RELEASE SAVEPOINT demo_sample_seed;');
        throw err;
      }
    }

    return summary;
  });
}

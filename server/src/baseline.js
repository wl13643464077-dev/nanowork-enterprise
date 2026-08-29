import { db } from './db.js';
import { loadRestaurantCatalog } from './catalog/restaurant.js';

const RESTAURANT_CATALOG_VERSION = 3;
export const RESTAURANT_CATALOG = loadRestaurantCatalog();

function groupCode(index) {
  return `M-${String(index + 1).padStart(2, '0')}`;
}

function groupPrompt(group, employees) {
  const roster = employees.map(employee => `${employee.person}（${employee.name}）`).join('、');
  return `你是餐饮数字员工组织的「${group.name}」任务分部。你是内部任务容器，不是对外业务角色。负责在本分部数字员工之间分派、协同和汇总任务。分部成员：${roster}。输出必须基于用户提供的信息；缺少必要输入时明确列出；涉及食品安全、法律、财务、个人数据或外部执行时标明人工复核与授权边界。`;
}

// 继续复用 marshals 表和 M-xx 编号作为内部派活容器，避免破坏 agent_tasks 的既有主外键。
// 对外业务名称来自 restaurant.json 的分部与员工，不再依赖“元帅”命名。
export const MARSHAL_CATALOG = RESTAURANT_CATALOG.groups.map((group, sort) => {
  const employees = group.members.map(idx => RESTAURANT_CATALOG.employees.find(employee => employee.idx === idx));
  const allies = [sort - 1, sort + 1]
    .filter(index => index >= 0 && index < RESTAURANT_CATALOG.groups.length)
    .map(groupCode)
    .join(',');
  return {
    code: groupCode(sort),
    name: group.name,
    title: `${employees.length}位餐饮数字员工`,
    emoji: group.emoji,
    duty: `统筹${group.name}的专业任务分派、员工协同与结果汇总`,
    skills: employees.map(employee => employee.name).join(','),
    kb: '餐饮产业知识库',
    allies,
    sort,
    prompt: groupPrompt(group, employees),
    group,
    specialists: employees,
  };
});

const CORE_PROMPTS = [
  ['PROMPT-01', '餐饮数字员工通用提示词模板', '你是餐饮数字员工组织的【{分部名}】。岗位职责：{职责}。优先由指定数字员工执行；缺少必要输入时先列出缺口。涉及食安、合规、财务、隐私或外部动作时必须提示人工复核与授权。', null, null],
  ['PROMPT-02', '每日输出格式约束', null, '每次任务型输出必须包含：【今日目标】【具体动作】【执行人】【截止时间】【检查标准】；分析型输出必须包含：①问题判断 ②数据依据 ③建议动作 ④需负责人确认事项。', null],
  ['PROMPT-03', '餐饮经营表达风格', null, null, '结论明确、证据可核验、动作可执行。禁止编造案例或数据；金额、收益、监管结论和外部承诺必须标注依据与确认边界。'],
];

const DEFAULT_CONFIG = {
  month_revenue_target: 500000,
  year_revenue_target: 6000000,
  personal_month_target: 200000,
  // 餐饮客单价初始建议值（按业态自行调整：快餐 20-40 / 茶饮 15-30 / 正餐 80-150 / 火锅 100-200）
  avg_deal_amount: 120,
  month_targets: { leads: 900, conversionRate: 8, repurchaseRate: 25, partnerActive: 60, contentPerDay: 10 },
  funnel_baseline: { 已沟通: 70, 已邀约: 45, 已到店: 60, 已成交: 35 },
  activity_baseline: { inviteSign: 35, signArrive: 70, arriveDeal: 25, referral: 30, roi: 2.0 },
  health_weights: { leads: 0.25, conversion: 0.25, repurchase: 0.15, partner: 0.20, content: 0.15 },
};

function catalogVersion() {
  const row = db.prepare(`SELECT value FROM sys_config WHERE key='restaurant_employee_catalog_version'`).get();
  if (!row) return 0;
  try { return Number(JSON.parse(row.value)) || 0; } catch { return Number(row.value) || 0; }
}

function employeeProfile(employee) {
  return JSON.stringify({
    inputs: employee.inputs,
    steps: employee.steps,
    deliverables: employee.deliverables,
    qualityGates: employee.qualityGates,
    safetyBoundaries: employee.safetyBoundaries,
    safetyBoundarySource: employee.safetyBoundarySource,
    manualMarkdown: employee.md,
    intro: employee.intro || '',
    role: employee.role || '',
    web: employee.web === true,
    color: employee.color || '',
    extension: employee.idx === 160,
  });
}

export function ensureBaselineCatalogs() {
  db.exec('SAVEPOINT ensure_baseline_catalogs');
  try {
    const shouldSyncCatalog = catalogVersion() < RESTAURANT_CATALOG_VERSION;
    const addMarshal = db.prepare(`INSERT INTO marshals(code,name,title,emoji,duty,skills,kb_deps,allies,online,sort,prompt)
      VALUES(?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(code) DO NOTHING`);
    const updateMarshal = db.prepare(`UPDATE marshals SET name=?,title=?,emoji=?,duty=?,skills=?,kb_deps=?,allies=?,online=1,sort=?,prompt=?
      WHERE code=?`);
    const findMarshal = db.prepare('SELECT id FROM marshals WHERE code=?');
    const findSpecialist = db.prepare('SELECT id FROM specialists WHERE employee_idx=? LIMIT 1');
    const addSpecialist = db.prepare(`INSERT INTO specialists(
      marshal_id,name,duty,status,employee_idx,key,person,emoji,description,profile_json,group_name,sort
    ) VALUES(?,?,?,'空闲',?,?,?,?,?,?,?,?)`);
    const updateSpecialist = db.prepare(`UPDATE specialists SET
      marshal_id=?,name=?,duty=?,key=?,person=?,emoji=?,description=?,profile_json=?,group_name=?,sort=?
      WHERE id=?`);

    for (const marshal of MARSHAL_CATALOG) {
      addMarshal.run(marshal.code, marshal.name, marshal.title, marshal.emoji, marshal.duty, marshal.skills,
        marshal.kb, marshal.allies, marshal.sort, marshal.prompt);
      if (shouldSyncCatalog) {
        updateMarshal.run(marshal.name, marshal.title, marshal.emoji, marshal.duty, marshal.skills,
          marshal.kb, marshal.allies, marshal.sort, marshal.prompt, marshal.code);
      }
      const marshalId = findMarshal.get(marshal.code)?.id;
      if (!marshalId) throw new Error(`餐饮分部目录初始化失败：${marshal.code}`);

      for (const employee of marshal.specialists) {
        const values = [marshalId, employee.name, employee.duty, employee.key, employee.person, employee.emoji,
          employee.desc, employeeProfile(employee), employee.group, employee.num - 1];
        const existing = findSpecialist.get(employee.idx);
        if (!existing) addSpecialist.run(values[0], values[1], values[2], employee.idx, ...values.slice(3));
        else if (shouldSyncCatalog) updateSpecialist.run(...values, existing.id);
      }
    }

    // 历史库保留 M-09/M-10 及其任务引用，只从当前目录下线；新库只会创建8个分部。
    if (shouldSyncCatalog) db.prepare(`UPDATE marshals SET online=0 WHERE code IN ('M-09','M-10')`).run();

    const addPrompt = db.prepare(`INSERT OR IGNORE INTO prompts(code,name,role_card,output_rule,style) VALUES(?,?,?,?,?)`);
    for (const prompt of CORE_PROMPTS) addPrompt.run(...prompt);

    const addConfig = db.prepare('INSERT OR IGNORE INTO sys_config(key,value) VALUES(?,?)');
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) addConfig.run(key, JSON.stringify(value));
    db.prepare(`INSERT INTO sys_config(key,value) VALUES('restaurant_employee_catalog_version',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(RESTAURANT_CATALOG_VERSION));

    db.exec('RELEASE ensure_baseline_catalogs');
  } catch (error) {
    db.exec('ROLLBACK TO ensure_baseline_catalogs');
    db.exec('RELEASE ensure_baseline_catalogs');
    throw error;
  }
}

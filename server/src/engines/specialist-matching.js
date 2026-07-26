const RESTAURANT_DIVISION_CODES = new Set(['M-01', 'M-02', 'M-03', 'M-04', 'M-05', 'M-06', 'M-07', 'M-08']);

const DOMAIN_BLUEPRINTS = [
  {
    match: /市场|商圈|增长|获客|渠道|活动/i,
    roles: ['商圈研究专员', '获客渠道专员', '门店活动专员', '增长实验专员'],
  },
  {
    match: /品牌|内容|文案|短视频|社群|传播/i,
    roles: ['品牌内容专员', '短视频脚本专员', '社群内容专员', '内容排期专员', '品牌审核专员'],
  },
  {
    match: /前厅|服务|接待|顾客体验|排队|预订/i,
    roles: ['前厅服务专员', '预订排队专员', '顾客体验专员', '服务恢复专员'],
  },
  {
    match: /后厨|菜品|菜单|食材|出品|食安/i,
    roles: ['菜单结构专员', '出品标准专员', '食材成本专员', '食品安全专员'],
  },
  {
    match: /门店运营|值班|排班|设备|巡检|现场/i,
    roles: ['门店值班专员', '排班协同专员', '设备巡检专员', '现场改善专员'],
  },
  {
    match: /会员|私域|复购|顾客经营|转介绍/i,
    roles: ['会员运营专员', '复购分析专员', '顾客关怀专员', '授权触达专员'],
  },
  {
    match: /数据|分析|复盘|指标|洞察|报表|财务/i,
    roles: ['经营数据专员', '活动复盘专员', '异常诊断专员', '门店损益专员'],
  },
  {
    match: /供应链|采购|库存|供应商|仓储|损耗/i,
    roles: ['供应商管理专员', '采购计划专员', '库存周转专员', '损耗控制专员'],
  },
];

function splitCapabilities(value) {
  return String(value || '')
    .split(/[,，、;；/\n]/)
    .map(item => item.trim().replace(/^(负责|统筹|协助)/, ''))
    .filter(item => item.length >= 2 && item.length <= 16);
}

function specialistName(capability) {
  const compact = String(capability || '')
    .replace(/相关/g, '')
    .replace(/(管理|负责|能力|工作)$/, '')
    .trim();
  if (!compact) return '';
  return compact.endsWith('专员') ? compact : `${compact}专员`;
}

export function deriveSpecialistAssignments(marshal, baseSpecialists = []) {
  if (RESTAURANT_DIVISION_CODES.has(String(marshal?.code || '').trim())) {
    const error = Object.assign(new Error('餐饮数字员工由 restaurant 目录统一维护，不能通过旧版自动重匹配覆盖；请使用显式员工配置并保留目录身份。'), {
      status: 409,
      code: 'RESTAURANT_CATALOG_REMATCH_DISABLED',
    });
    throw error;
  }
  const count = Math.max(1, baseSpecialists.length || 3);
  const identity = [marshal?.name, marshal?.title, marshal?.duty].filter(Boolean).join(' ');
  const domain = DOMAIN_BLUEPRINTS.find(item => item.match.test(identity));
  const candidates = [
    ...(domain?.roles || []),
    ...splitCapabilities(marshal?.skills).map(specialistName),
    ...splitCapabilities(marshal?.duty).map(specialistName),
  ].filter(Boolean);

  const names = [...new Set(candidates)];
  while (names.length < count) names.push(`综合执行专员${names.length + 1}`);

  return baseSpecialists.map((specialist, index) => {
    const name = names[index] || specialist.name || `综合执行专员${index + 1}`;
    const scope = name.replace(/专员\d*$/, '');
    return {
      id: specialist.id,
      name,
      duty: `负责${scope}相关的分析、执行与交付，协同${marshal?.name || '所属部门'}完成${marshal?.title || '经营目标'}`,
      active: 1,
    };
  });
}

export function validateSpecialistAssignments(value, baseSpecialists = []) {
  if (!Array.isArray(value)) throw Object.assign(new Error('专员配置格式不正确'), { status: 400 });
  const allowed = new Set(baseSpecialists.map(item => Number(item.id)));
  const seen = new Set();
  return value.map((item, index) => {
    const id = Number(item?.id);
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const duty = typeof item?.duty === 'string' ? item.duty.trim() : '';
    if (!Number.isInteger(id) || !allowed.has(id) || seen.has(id)) {
      throw Object.assign(new Error(`第${index + 1}条专员配置编号不正确`), { status: 400 });
    }
    if (!name || name.length > 40) throw Object.assign(new Error(`第${index + 1}条专员名称需为1到40字`), { status: 400 });
    if (duty.length > 300) throw Object.assign(new Error(`第${index + 1}条专员职责不能超过300字`), { status: 400 });
    seen.add(id);
    return { id, name, duty: duty || `${name.replace(/专员$/, '')}相关产出`, active: item?.active === false ? 0 : 1 };
  });
}

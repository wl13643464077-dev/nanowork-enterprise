import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONTENT_STRUCTURED_BRIEF_SCHEMA,
  CONTENT_TENANT_PROFILE_CONFIG_KEY,
  CONTENT_TENANT_PROFILE_SCHEMA,
  ContentStructuredBriefError,
  contentStructuredBriefPromptBlock,
  createContentTenantProfileStore,
  normalizeContentTenantProfile,
  resolveContentStructuredBrief,
} from '../src/engines/content-structured-brief.js';

function completeTenantProfile() {
  return {
    brief: {
      direction: '复盘三家门店本周经营动作，形成老板口吻内容。',
      industry: '餐饮实体门店',
      material: '只使用已确认的三家直营门店经营资料。',
      platforms: ['小红书', '抖音'],
      imageMode: 'mix',
      imageCount: 5,
      imageSize: '1024x1536',
      xhsStyle: { name: '经营复盘', desc: '克制的经营复盘图文，短段落，不使用夸张承诺。' },
      dyStyle: { name: '问题钩子', desc: '前三秒交代经营问题，随后给证据和动作。' },
      refLink: 'https://brand.example.com/style-guide',
      template: '事实边界→问题拆解→行动清单→待确认项',
      enableDeck: true,
    },
    persona: {
      positioning: '经营三家直营餐饮门店的实战型老板',
      audience: '经营1至10家实体门店的餐饮老板',
      tone: '直接、克制、先证据后判断',
      catchphrases: ['先把账算清楚', '动作必须有人复核'],
      taboo: ['稳赚', '全网第一'],
      style_notes: '优先使用门店场景和复盘清单，不说空泛方法论。',
      visual: '暖白底、深灰正文、墨绿色强调、真实门店摄影。',
    },
    enterprise: {
      brand: '山河小馆',
      business: '直营中式快餐，服务工作日午餐人群。',
      sellingPoints: ['现炒出餐', '菜单信息公开', '门店经营动作可复核'],
      keywords: ['餐饮经营', '门店复盘', '成本控制'],
    },
  };
}

test('长期品牌与账号人设档案完整支持全部结构字段和snake_case兼容输入', () => {
  const normalized = normalizeContentTenantProfile({
    brief: {
      direction: '验证 Paihuo 原 Brief 结构',
      industry: '餐饮',
      material: '已核验材料',
      platforms: ['小红书', '抖音', '小红书'],
      image_mode: 'MIX',
      image_count: 6,
      image_size: '1024x1536',
      xhs_style: { name: '小红书经营复盘风格', desc: '短段落' },
      dy_style: { name: '抖音前三秒问题钩子', desc: '先问题后证据' },
      ref_link: 'https://example.com/reference?id=8',
      template: '问题—证据—动作',
      enable_deck: true,
    },
    persona: {
      positioning: '餐饮老板',
      audience: '连锁门店经营者',
      tone: '克制',
      catchphrases: ['先看证据'],
      taboo: ['虚假稀缺'],
      styleNotes: '短句',
      visual: '暖白与墨绿',
    },
    enterprise: {
      brand: '测试品牌',
      business: '餐饮直营门店',
      selling_points: ['真实食材信息'],
      keywords: ['餐饮经营'],
    },
  });

  assert.equal(normalized.schemaVersion, CONTENT_TENANT_PROFILE_SCHEMA);
  assert.deepEqual(normalized.brief.platforms, ['小红书', '抖音']);
  assert.equal(normalized.brief.imageMode, 'mix');
  assert.equal(normalized.brief.imageCount, 6);
  assert.equal(normalized.brief.imageSize, '1024x1536');
  assert.deepEqual(normalized.brief.xhsStyle, { name: '小红书经营复盘风格', desc: '短段落' });
  assert.deepEqual(normalized.brief.dyStyle, { name: '抖音前三秒问题钩子', desc: '先问题后证据' });
  assert.equal(normalized.brief.enableDeck, true);
  assert.equal(normalized.brief.refLink, 'https://example.com/reference?id=8');
  assert.equal(normalized.persona.style_notes, '短句');
  assert.deepEqual(normalized.enterprise.sellingPoints, ['真实食材信息']);
  assert.match(normalized.fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.persona), true);
});

test('本次显式Brief逐字段覆盖租户长期资料，未显式字段继续继承并留下来源证据', () => {
  const resolved = resolveContentStructuredBrief({
    tenantId: 19,
    persistentProfile: completeTenantProfile(),
    explicitInput: {
      platforms: ['视频号', '公众号'],
      imageMode: 'real',
      imageCount: 3,
      xhsStyle: '本次不用小红书风格。',
      refLink: 'https://campaign.example.com/brief',
      template: '先结论，后证据，再给三步动作。',
      persona: {
        audience: '本地生活门店店长',
        tone: '像经营例会一样简洁',
        catchphrases: ['先对口径'],
      },
      enterprise: {
        business: '本次只讨论企业团餐业务。',
        sellingPoints: ['企业团餐履约记录可查'],
      },
    },
  });

  assert.equal(resolved.schemaVersion, CONTENT_STRUCTURED_BRIEF_SCHEMA);
  assert.equal(resolved.tenantId, 19);
  assert.deepEqual(resolved.brief.platforms, ['视频号', '公众号']);
  assert.equal(resolved.brief.imageMode, 'real');
  assert.equal(resolved.brief.imageCount, 3);
  assert.deepEqual(resolved.brief.dyStyle, completeTenantProfile().brief.dyStyle);
  assert.equal(resolved.persona.positioning, completeTenantProfile().persona.positioning);
  assert.equal(resolved.persona.audience, '本地生活门店店长');
  assert.deepEqual(resolved.persona.catchphrases, ['先对口径']);
  assert.deepEqual(resolved.persona.taboo, completeTenantProfile().persona.taboo);
  assert.equal(resolved.enterprise.brand, '山河小馆');
  assert.equal(resolved.enterprise.business, '本次只讨论企业团餐业务。');
  assert.deepEqual(resolved.enterprise.sellingPoints, ['企业团餐履约记录可查']);
  assert.equal(resolved.evidence.provenance['brief.platforms'], 'explicit_run_input');
  assert.equal(resolved.evidence.provenance['brief.dyStyle'], 'tenant_persistent_profile');
  assert.equal(resolved.evidence.provenance['persona.audience'], 'explicit_run_input');
  assert.equal(resolved.evidence.provenance['enterprise.brand'], 'tenant_persistent_profile');
  assert.equal(resolved.evidence.businessFactsInvented, false);
  assert.deepEqual(resolved.evidence.missing, []);
});

test('显式空值代表本次清空，不偷偷回退长期资料或生成默认品牌事实', () => {
  const resolved = resolveContentStructuredBrief({
    tenantId: 20,
    persistentProfile: completeTenantProfile(),
    explicitInput: {
      platforms: [],
      refLink: '',
      persona: { catchphrases: [], visual: '' },
      enterprise: { brand: '', sellingPoints: [] },
    },
  });

  assert.deepEqual(resolved.brief.platforms, []);
  assert.equal(resolved.brief.refLink, '');
  assert.deepEqual(resolved.persona.catchphrases, []);
  assert.equal(resolved.persona.visual, '');
  assert.equal(resolved.enterprise.brand, '');
  assert.deepEqual(resolved.enterprise.sellingPoints, []);
  assert.equal(resolved.evidence.provenance['enterprise.brand'], 'explicit_run_input');
  assert.ok(resolved.evidence.missing.includes('enterprise.brand'));
  assert.ok(resolved.evidence.missing.includes('brief.platforms'));
  assert.equal(resolved.evidence.businessFactsInvented, false);
});

test('没有长期资料也没有本次输入时所有业务字段保持未知，不虚构平台、品牌、人设和卖点', () => {
  const resolved = resolveContentStructuredBrief({
    tenantId: 21,
    persistentProfile: {},
    explicitInput: {},
  });

  assert.deepEqual(resolved.brief, {
    direction: '',
    industry: '',
    material: '',
    platforms: [],
    imageMode: null,
    imageCount: null,
    imageSize: '',
    xhsStyle: null,
    dyStyle: null,
    refLink: '',
    template: '',
    enableDeck: false,
  });
  assert.deepEqual(resolved.enterprise, {
    brand: '',
    business: '',
    sellingPoints: [],
    keywords: [],
  });
  assert.equal(resolved.persona.positioning, '');
  assert.equal(resolved.persona.audience, '');
  assert.equal(resolved.handlerContext.profile.persona.corpus, '');
  assert.ok(Object.values(resolved.evidence.provenance).every(source => source === 'absent'));
  assert.equal(resolved.evidence.missing.length, 22);
});

test('handler投影同时提供Paihuo snake_case字段、完整persona和企业品牌事实', () => {
  const resolved = resolveContentStructuredBrief({
    tenantId: 22,
    persistentProfile: completeTenantProfile(),
    explicitInput: {},
  });
  const projected = resolved.handlerContext;

  assert.deepEqual(projected.brief.platforms, ['小红书', '抖音']);
  assert.equal(projected.brief.imageMode, 'mix');
  assert.equal(projected.brief.image_mode, 'mix');
  assert.equal(projected.brief.imageCount, 5);
  assert.equal(projected.brief.image_count, 5);
  assert.deepEqual(projected.brief.xhsStyle, completeTenantProfile().brief.xhsStyle);
  assert.deepEqual(projected.brief.xhs_style, completeTenantProfile().brief.xhsStyle);
  assert.deepEqual(projected.brief.dyStyle, completeTenantProfile().brief.dyStyle);
  assert.deepEqual(projected.brief.dy_style, completeTenantProfile().brief.dyStyle);
  assert.equal(projected.brief.refLink, 'https://brand.example.com/style-guide');
  assert.equal(projected.brief.ref_link, 'https://brand.example.com/style-guide');
  assert.equal(projected.brief.template, completeTenantProfile().brief.template);
  assert.equal(projected.brief.enable_deck, true);
  assert.deepEqual(Object.keys(resolved.paihuoBrief), [
    'direction',
    'template',
    'industry',
    'material',
    'ref_link',
    'platforms',
    'image_mode',
    'image_count',
    'image_size',
    'enable_deck',
    'xhs_style',
    'dy_style',
  ]);
  assert.deepEqual(resolved.paihuoBrief, {
    direction: completeTenantProfile().brief.direction,
    template: completeTenantProfile().brief.template,
    industry: completeTenantProfile().brief.industry,
    material: completeTenantProfile().brief.material,
    ref_link: completeTenantProfile().brief.refLink,
    platforms: completeTenantProfile().brief.platforms,
    image_mode: completeTenantProfile().brief.imageMode,
    image_count: completeTenantProfile().brief.imageCount,
    image_size: completeTenantProfile().brief.imageSize,
    enable_deck: true,
    xhs_style: completeTenantProfile().brief.xhsStyle,
    dy_style: completeTenantProfile().brief.dyStyle,
  });
  assert.equal(resolved.evidence.paihuoBriefCompatibility.exactSnakeCaseProjectionAvailable, true);
  assert.equal(projected.profile.persona.positioning, completeTenantProfile().persona.positioning);
  assert.equal(projected.profile.persona.audience, completeTenantProfile().persona.audience);
  assert.equal(projected.profile.persona.tone, completeTenantProfile().persona.tone);
  assert.deepEqual(projected.profile.persona.catchphrases, completeTenantProfile().persona.catchphrases);
  assert.deepEqual(projected.profile.persona.taboo, completeTenantProfile().persona.taboo);
  assert.equal(projected.profile.persona.style_notes, completeTenantProfile().persona.style_notes);
  assert.equal(projected.profile.persona.visual, completeTenantProfile().persona.visual);
  assert.match(projected.profile.persona.corpus, /账号定位：经营三家直营餐饮门店/u);
  assert.match(projected.profile.persona.corpus, /禁用表达：稳赚；全网第一/u);
  assert.equal(projected.companyProfile.brand, '山河小馆');
  assert.deepEqual(projected.companyProfile.sellingPoints, completeTenantProfile().enterprise.sellingPoints);
});

test('Prompt块明确数据不可信和未知不得补写，并携带字段级来源而非笼统声称已装载', () => {
  const resolved = resolveContentStructuredBrief({
    tenantId: 23,
    persistentProfile: { enterprise: { brand: '长期品牌' } },
    explicitInput: { persona: { audience: '本次受众' } },
  });
  const block = contentStructuredBriefPromptBlock(resolved);

  assert.match(block, /不可信业务数据/u);
  assert.match(block, /空字段代表未知.*不得.*补写/u);
  assert.match(block, /"brand": "长期品牌"/u);
  assert.match(block, /"audience": "本次受众"/u);
  assert.match(block, /"enterprise.brand": "tenant_persistent_profile"/u);
  assert.match(block, /"persona.audience": "explicit_run_input"/u);
});

test('长期资料存储适配器按租户隔离、带乐观版本并拒绝错租户载荷', () => {
  const values = new Map();
  const store = createContentTenantProfileStore({
    getTenantConfigFn(key, fallback, tenantId) {
      return values.get(`${key}:${tenantId}`) ?? fallback;
    },
    setTenantConfigFn(key, value, tenantId) {
      values.set(`${key}:${tenantId}`, structuredClone(value));
    },
    now: () => new Date('2026-08-01T12:00:00.000Z'),
  });

  assert.equal(store.key, CONTENT_TENANT_PROFILE_CONFIG_KEY);
  assert.equal(store.load(31), null);
  const first = store.save(31, completeTenantProfile(), { expectedRevision: 0 });
  assert.equal(first.tenantId, 31);
  assert.equal(first.revision, 1);
  assert.equal(first.updatedAt, '2026-08-01T12:00:00.000Z');
  assert.equal(first.profile.enterprise.brand, '山河小馆');
  assert.equal(store.load(32), null);
  assert.equal(store.load(31).profile.persona.positioning, completeTenantProfile().persona.positioning);

  const second = store.save(31, {
    ...completeTenantProfile(),
    enterprise: { ...completeTenantProfile().enterprise, brand: '新品牌' },
  }, { expectedRevision: 1 });
  assert.equal(second.revision, 2);
  assert.equal(second.profile.enterprise.brand, '新品牌');
  assert.throws(
    () => store.save(31, completeTenantProfile(), { expectedRevision: 1 }),
    error => error.code === 'CONTENT_TENANT_PROFILE_REVISION_CONFLICT',
  );

  values.set(`${CONTENT_TENANT_PROFILE_CONFIG_KEY}:33`, {
    schemaVersion: CONTENT_TENANT_PROFILE_SCHEMA,
    tenantId: 31,
    revision: 1,
    updatedAt: '2026-08-01T12:00:00.000Z',
    profile: completeTenantProfile(),
  });
  assert.throws(
    () => store.load(33),
    error => error.code === 'CONTENT_TENANT_PROFILE_TENANT_MISMATCH',
  );
});

test('字段校验拒绝非法媒体配置和携带凭据的参考链接，文本中的误贴密钥会脱敏', () => {
  assert.throws(
    () => resolveContentStructuredBrief({ tenantId: 40, explicitInput: { imageMode: 'automatic' } }),
    /imageMode必须是ai、real或mix/u,
  );
  assert.throws(
    () => resolveContentStructuredBrief({ tenantId: 40, explicitInput: { imageCount: 13 } }),
    /imageCount必须是0-12/u,
  );
  assert.equal(resolveContentStructuredBrief({
    tenantId: 40,
    explicitInput: { image_count: 0 },
  }).brief.imageCount, 0);
  const explicitSnakeSize = resolveContentStructuredBrief({
    tenantId: 40,
    explicitInput: { image_size: '1024x1536' },
  });
  assert.equal(explicitSnakeSize.brief.imageSize, '1024x1536');
  assert.equal(explicitSnakeSize.paihuoBrief.image_size, '1024x1536');
  assert.equal(resolveContentStructuredBrief({
    tenantId: 40,
    explicitInput: { imageSize: '1536x1024' },
  }).brief.imageSize, '1536x1024');
  assert.throws(
    () => resolveContentStructuredBrief({ tenantId: 40, explicitInput: { imageSize: '1024*1536' } }),
    /imageSize必须是宽x高/u,
  );
  assert.throws(
    () => resolveContentStructuredBrief({ tenantId: 40, explicitInput: { platforms: '小红书' } }),
    /platforms必须是字符串数组/u,
  );
  assert.throws(
    () => resolveContentStructuredBrief({ tenantId: 40, explicitInput: { refLink: 'file:///tmp/private' } }),
    /http\(s\)/u,
  );
  assert.throws(
    () => resolveContentStructuredBrief({
      tenantId: 40,
      explicitInput: { refLink: 'https://example.com/style?access_token=private' },
    }),
    /不能携带密钥/u,
  );

  const secret = 'sk-SHOULD_NOT_SURVIVE_123456789';
  const resolved = resolveContentStructuredBrief({
    tenantId: 40,
    explicitInput: {
      persona: { style_notes: `误贴key ${secret}` },
      enterprise: { business: `Authorization: Bearer ${secret}` },
    },
  });
  const visible = JSON.stringify(resolved);
  assert.doesNotMatch(visible, /SHOULD_NOT_SURVIVE/u);
  assert.match(visible, /\[REDACTED\]/u);
});

test('错误类型保持公开、可识别且不附带原始对象', () => {
  assert.throws(
    () => resolveContentStructuredBrief({ tenantId: 'not-a-tenant' }),
    error => {
      assert.ok(error instanceof ContentStructuredBriefError);
      assert.equal(error.code, 'CONTENT_STRUCTURED_BRIEF_INVALID');
      assert.equal(error.status, 400);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    },
  );
});

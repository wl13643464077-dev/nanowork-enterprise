import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { removeTempDbSafely, removeTempDirSafely } from './helpers/temp-db.mjs';

const DBP = path.join(os.tmpdir(), `nanowork-campaign-materials-${process.pid}.db`);
const UPLOAD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-campaign-materials-uploads-'));
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* fresh test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.NANOWORK_POSTER_TEXT_UPLOAD_ROOT = UPLOAD_ROOT;
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NANOWORK_AI_PROVIDER = '';
process.env.YUNWU_API_KEY = '';
process.env.YUNWU_BASE_URL = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';
process.env.ENABLE_SCHEDULER = 'false';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';

const { renderSvgToPng } = await import('../src/engines/poster-text-overlay.js');
const {
  CAMPAIGN_MATERIAL_SLOTS,
  SUPER_MANAGER_EMPLOYEE_IDX,
  appendCampaignMaterialsSection,
  attachSuperManagerCampaignMaterials,
  campaignImagePrompt,
  campaignMaterialFilePath,
  campaignVisualLock,
  understandCampaignBrandVisuals,
  generateSuperManagerCampaignMaterials,
  overlayLayersForSlot,
  parseCampaignMaterialBrief,
  resolveCampaignIdentity,
  shouldGenerateCampaignMaterials,
  parseCampaignMaterialsPack,
  collectCampaignReferenceImages,
  isUnusableCampaignStamp,
  resolveCampaignMaterialSlots,
  stripCampaignMaterialsFence,
} = await import('../src/engines/super-manager-campaign-materials.js');
const { POSTER_TEXT_RESTAURANT_EMPLOYEE_IDX } = await import('../src/engines/poster-text-capability.js');
const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { restaurantOutputPresentation } = await import('../../web/src/components/restaurantOutputPresentation.js');
const { cleanReportBody } = await import('../../shared/report-body.mjs');

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'物料图测试店','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);
const bossId = Number(q.run(
  `INSERT INTO users(username,password_hash,name,role,dept,status,tenant_id)
   VALUES('campaign-boss','x','物料老板','boss','老板办','启用',1)`,
).lastInsertRowid);

const solidSvg = (w, h, color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${color}"/></svg>`;
const basePng = await renderSvgToPng(solidSvg(512, 640, '#7a2e12'), { width: 512, height: 640 });
const basePngB64 = basePng.toString('base64');

const PLAN = `# 周末家庭套餐活动方案

活动主题：周末家庭套餐
门店名称：老王牛肉面
招牌菜：红烧牛肉面
本周六到店核验。

## 下一步建议
1. 先把物料图贴到店门口
2. 朋友圈同步同一套画面
3. 桌贴只写已确认文案
`;

after(async () => {
  await removeTempDbSafely(DBP);
  await removeTempDirSafely(UPLOAD_ROOT);
});

test('没有 Logo 时用知识包调性兜底，不拦物料', async () => {
  const understood = await understandCampaignBrandVisuals({
    brief: { storeName: '北京大鸭梨烤鸭', style: '朱红金漆家庭宴', theme: '家庭宴' },
  });
  assert.equal(understood.source, 'pack');
  assert.match(understood.mood, /朱红金漆/u);
});

test('160 号超级店长出艺术成图，不再用系统字硬贴折扣价格', () => {
  assert.equal(SUPER_MANAGER_EMPLOYEE_IDX, 160);
  assert.equal(POSTER_TEXT_RESTAURANT_EMPLOYEE_IDX.includes(160), false);
  assert.deepEqual(CAMPAIGN_MATERIAL_SLOTS.map(item => item.id), [
    'flyer_a', 'flyer_b', 'banner_a', 'banner_b', 'kv_poster', 'social_square', 'table_card',
  ]);
  assert.deepEqual(overlayLayersForSlot({
    theme: '周末家庭套餐活动',
    offer: '折扣',
    date: '本周六',
    storeName: '纳米',
  }, { id: 'banner_a', kind: 'banner' }).map(item => item.text), ['周末家庭套餐活动']);
  assert.equal(isUnusableCampaignStamp('纳米'), true);
  assert.equal(isUnusableCampaignStamp('企业'), true);
  assert.equal(isUnusableCampaignStamp('Nano Work 企业'), true);
  assert.equal(isUnusableCampaignStamp('折扣'), true);
  assert.equal(isUnusableCampaignStamp('老王牛肉面'), false);
  assert.equal(isUnusableCampaignStamp('北京大鸭梨烤鸭'), false);
});

test('老板点名宣传单和Banner时出两套备选，未点名则补齐常用物料', () => {
  assert.deepEqual(
    resolveCampaignMaterialSlots({ requirement: '给我宣传单样。Banner图。多重的，让用户选。' }).map(item => item.id),
    ['flyer_a', 'flyer_b', 'banner_a', 'banner_b'],
  );
  assert.deepEqual(
    resolveCampaignMaterialSlots({ requirement: '只要外卖封面' }).map(item => item.id),
    ['takeout_cover'],
  );
  assert.ok(resolveCampaignMaterialSlots({ requirement: '周末家庭套餐活动' }).some(item => item.kind === 'flyer'));
  assert.deepEqual(overlayLayersForSlot({
    theme: '周末家庭套餐活动',
    date: '本周六',
    storeName: '老王牛肉面',
  }, { id: 'banner_a', kind: 'banner' }).map(item => `${item.role}:${item.text}`), [
    'title:周末家庭套餐活动',
    'store:老王牛肉面',
  ]);
});

test('物料文案只采用老板确认和门店事实，方案里编造的价格不上画面', () => {
  const brief = parseCampaignMaterialBrief(
    `${PLAN}\n限时特价¥99，满200减80。招牌菜：发明出来的龙肉煲`,
    {
      requirement: '我们店想做周末家庭套餐活动，招牌菜红烧牛肉面，本周六开始。门店名称：老王牛肉面',
      storeName: '老王牛肉面',
      storeFacts: {
        storeName: '老王牛肉面',
        facts: [
          { kind: 'store_name', value: '老王牛肉面', claim: '门店名称「老王牛肉面」' },
          { kind: 'category', value: '牛肉面', claim: '业态：牛肉面' },
          { kind: 'signature_dish', value: '红烧牛肉面', claim: '招牌菜：红烧牛肉面' },
        ],
      },
    },
  );
  assert.equal(brief.storeName, '老王牛肉面');
  assert.equal(brief.theme, '周末家庭套餐活动');
  assert.deepEqual(brief.dishes, ['红烧牛肉面']);
  assert.equal(brief.offer, '');
  assert.equal(brief.date, '本周六');
  assert.equal(brief.cuisine, '牛肉面');
  const layers = overlayLayersForSlot(brief, 'kv_poster');
  assert.deepEqual(layers.map(item => item.text), ['周末家庭套餐活动', '红烧牛肉面', '老王牛肉面']);
  assert.equal(layers.some(item => /¥99|满200减80|龙肉煲/u.test(item.text)), false);
});

test('自然语言「本店+活动」能抽出店名和主题，失败备注不把供应商 URL 写进老板正文', () => {
  const brief = parseCampaignMaterialBrief('', {
    requirement: '本店成都春熙路川菜馆，客单价88，50座。做国庆黄金周家庭聚餐活动。',
  });
  assert.equal(brief.storeName, '成都春熙路川菜馆');
  assert.match(brief.theme, /国庆黄金周家庭聚餐/u);
  const markdown = appendCampaignMaterialsSection('# 方案', {
    record_type: 'nanowork-campaign-materials',
    items: [{
      id: 'kv_poster',
      title: '主KV海报',
      status: 'failed',
      note: 'POST https://api.360.cn/v1/images 超时',
    }],
  });
  assert.doesNotMatch(stripCampaignMaterialsFence(markdown), /https?:\/\//u);
  assert.match(stripCampaignMaterialsFence(markdown), /未生成/u);
});

test('同一品牌与活动主题锁定同一套视觉，生图做成艺术字而不是系统黑体', () => {
  const brief = parseCampaignMaterialBrief(PLAN, {
    requirement: '周末家庭套餐活动，招牌菜红烧牛肉面',
    storeName: '老王牛肉面',
    storeFacts: { storeName: '老王牛肉面', facts: [{ kind: 'category', value: '牛肉面' }] },
  });
  const lock = campaignVisualLock(brief);
  const other = campaignVisualLock({ ...brief, storeName: '隔壁火锅' });
  assert.equal(campaignVisualLock(brief).seed, lock.seed);
  assert.notEqual(other.seed, lock.seed);
  const prompts = CAMPAIGN_MATERIAL_SLOTS.map(slot => campaignImagePrompt(brief, lock, slot));
  assert.equal(new Set(prompts.map(text => text.match(/Visual lock seed (\w+)/u)?.[1])).size, 1);
  for (const prompt of prompts) {
    assert.match(prompt, /artistic custom lettering|wordless cinematic/u);
    assert.match(prompt, /Never render discounts/u);
    assert.match(prompt, /红烧牛肉面/u);
    assert.doesNotMatch(prompt, /满200减80/u);
    assert.doesNotMatch(prompt, /later typography|NO text, NO letters/u);
    assert.doesNotMatch(prompt, /画面不要出现任何文字/u);
  }
  const platform = parseCampaignMaterialBrief('', { storeName: '纳米Work企业版本', storeFacts: { storeName: '纳米' } });
  assert.equal(platform.storeName, '');
  const tenantLock = parseCampaignMaterialBrief('家庭宴方案', {
    requirement: '北京大鸭梨烤鸭朝阳门店要做中秋后到国庆的家庭宴活动',
    storeName: 'Nano Work 企业',
    storeFacts: { storeName: 'Nano Work 企业' },
    brandIdentity: {
      brandName: '北京大鸭梨烤鸭',
      logoUrl: 'http://dayalihome.com/skin/images/logo.png',
      dishes: ['香酥烤鸭'],
    },
  });
  assert.equal(tenantLock.storeName, '北京大鸭梨烤鸭');
  assert.match(tenantLock.theme, /家庭宴/u);
  assert.ok(tenantLock.dishes.includes('香酥烤鸭'));
  assert.equal(tenantLock.logoUrl, 'http://dayalihome.com/skin/images/logo.png');
  assert.deepEqual(
    overlayLayersForSlot(tenantLock).map((item) => `${item.role}:${item.text}`),
    ['title:中秋后到国庆的家庭宴活动', 'subtitle:香酥烤鸭', 'store:北京大鸭梨烤鸭'],
  );
  const withLogo = campaignImagePrompt(brief, lock, CAMPAIGN_MATERIAL_SLOTS[0], { hasBrandAssets: true });
  assert.match(withLogo, /first reference image is the official brand logo/u);
  assert.match(withLogo, /Image-to-image/u);
  assert.doesNotMatch(withLogo, /typeset later|caption slabs reserved/u);
  assert.deepEqual(
    collectCampaignReferenceImages(['data:image/png;base64,abc', { name: 'note.txt' }, 'https://cdn.example/logo.png']),
    ['data:image/png;base64,abc', 'https://cdn.example/logo.png'],
  );
});

test('方案通过后调用生图模型产出三张物料，失败不假装已出图', async () => {
  const calls = [];
  const pack = await runWithTenant(1, () => generateSuperManagerCampaignMaterials({
    markdown: PLAN,
    requirement: '周末家庭套餐活动，招牌菜红烧牛肉面，本周六。门店名称：老王牛肉面',
    storeName: '老王牛肉面',
    tenantId: 1,
    userId: bossId,
    sourceType: 'agent_task',
    sourceId: 88,
    jobKey: 'task-88',
    selectedKinds: ['kv_poster', 'social_square', 'table_card'],
    generateImageFn: async args => {
      calls.push(args);
      return {
        b64: basePngB64,
        mimeType: 'image/png',
        model: args.model,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  }));
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(item => item.size)).size, 2);
  assert.equal(pack.items.length, 3);
  assert.ok(pack.items.every(item => item.status === 'succeeded' && item.url.startsWith('/uploads/poster-text/1/')));
  assert.equal(new Set(pack.items.map(item => item.url)).size, 3);
  for (const item of pack.items) {
    const filePath = campaignMaterialFilePath(item.url, 1);
    assert.ok(filePath && fs.existsSync(filePath));
    assert.ok(fs.readFileSync(filePath).length > 100);
  }
  const artifactCount = Number(q.get(
    'SELECT COUNT(*) n FROM generated_artifacts WHERE user_id=? AND source_id=?',
    bossId,
    88,
  )?.n);
  assert.equal(artifactCount, 3);
  const imageHold = q.get(
    `SELECT status,kind,ref_type FROM credit_holds WHERE tenant_id=1 AND ref_type='campaign_materials' AND ref_id=88 ORDER BY id DESC LIMIT 1`,
  );
  assert.equal(imageHold?.kind, 'image');
  assert.equal(imageHold?.status, 'settled');

  const failed = await generateSuperManagerCampaignMaterials({
    markdown: PLAN,
    requirement: '周末家庭套餐活动',
    generateImageFn: async () => { throw new Error('生图供应商暂时不可用'); },
  });
  assert.ok(failed.items.every(item => item.status === 'failed' && item.url == null));
  const body = appendCampaignMaterialsSection(PLAN, failed);
  assert.match(body, /周末家庭套餐活动方案/u);
  assert.match(body, /未生成：生图供应商暂时不可用/u);
  assert.doesNotMatch(body, /\/uploads\/poster-text\//u);
});

test('先理解 Logo 和品牌调性，再图生图，不再后期叠系统字', async () => {
  const visionCalls = [];
  const editCalls = [];
  const pack = await runWithTenant(1, () => generateSuperManagerCampaignMaterials({
    markdown: '家庭宴方案',
    requirement: '北京大鸭梨烤鸭朝阳门店要做中秋后到国庆的家庭宴活动',
    storeName: 'Nano Work 企业',
    storeFacts: { storeName: 'Nano Work 企业' },
    brandIdentity: {
      brandName: '北京大鸭梨烤鸭',
      logoUrl: 'http://dayalihome.com/skin/images/logo.png',
      dishes: ['香酥烤鸭'],
      style: '朱红金漆、梨形标志、家庭宴暖光、木桌瓷器',
      slogan: '鸭梨味，味天下',
      mission: '诚实信用，求变创新,广纳人才，服务大众',
    },
    tenantId: 1,
    selectedKinds: ['kv_poster'],
    fetchFn: async () => ({
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => basePng,
    }),
    chatFn: async (args) => {
      visionCalls.push(args);
      return {
        text: JSON.stringify({
          palette: { bg: 'lacquer red and warm wood', accent: 'antique gold', light: 'family banquet tungsten' },
          mark: 'pear-shaped roast-duck emblem in red and gold',
          mood: 'Beijing family roast-duck banquet, festive but homely',
          placement: 'faithful logo lockup on signage and plate rim',
          lettering: 'gold brush campaign title with brand name',
        }),
        usage: { inputTokens: 12, outputTokens: 40 },
      };
    },
    editImageFn: async (args) => {
      editCalls.push(args);
      return { b64: basePngB64, model: args.model };
    },
    generateImageFn: async () => {
      throw new Error('有 Logo 时必须走图生图');
    },
  }));
  assert.equal(pack.brief.storeName, '北京大鸭梨烤鸭');
  assert.equal(visionCalls.length, 1);
  assert.ok(visionCalls[0].messages[0].content.some((item) => item.type === 'image_url'));
  assert.match(JSON.stringify(visionCalls[0].messages), /朱红金漆|鸭梨味|北京大鸭梨烤鸭/u);
  assert.equal(editCalls.length, 1);
  assert.ok(editCalls[0].images.some((item) => String(item).startsWith('data:image/')));
  assert.match(editCalls[0].prompt, /lacquer red|pear-shaped roast-duck|family roast-duck banquet/u);
  assert.match(editCalls[0].prompt, /official brand logo/u);
  assert.doesNotMatch(editCalls[0].prompt, /typeset later|Leave the top-left/u);
  assert.equal(pack.items[0].status, 'succeeded');
  assert.match(pack.items[0].note, /图生图/u);
  assert.match(pack.items[0].note, /北京大鸭梨烤鸭/u);
  assert.doesNotMatch(pack.items[0].note, /已叠/u);
  const filePath = campaignMaterialFilePath(pack.items[0].url, 1);
  assert.ok(filePath && fs.existsSync(filePath));
  assert.ok(fs.readFileSync(filePath).length > 100);
});

test('物料预授权与派活文本账务隔离，失败全额退回', async () => {
  const before = Number(q.get('SELECT credits FROM tenants WHERE id=1')?.credits);
  const pack = await runWithTenant(1, () => generateSuperManagerCampaignMaterials({
    markdown: PLAN,
    requirement: '周末家庭套餐活动',
    tenantId: 1,
    userId: bossId,
    sourceId: 91,
    generateImageFn: async () => { throw new Error('供应商超时'); },
  }));
  assert.ok(pack.items.every(item => item.status === 'failed'));
  const hold = q.get(
    `SELECT status,kind,held_credits,settled_credits,log_id FROM credit_holds WHERE tenant_id=1 AND ref_type='campaign_materials' AND ref_id=91 ORDER BY id DESC LIMIT 1`,
  );
  assert.equal(hold.status, 'settled');
  assert.equal(Number(hold.settled_credits || 0), 0);
  assert.equal(q.get('SELECT ai_mode FROM credit_logs WHERE id=?', hold.log_id)?.ai_mode, 'failed');
  assert.equal(Number(q.get('SELECT credits FROM tenants WHERE id=1')?.credits), before);
});

test('机读块可解析、老板视图能抽出图片且正文不再露出 JSON', () => {
  const markdown = appendCampaignMaterialsSection(PLAN, {
    record_type: 'nanowork-campaign-materials',
    visualLock: 'abc123',
    items: [
      { id: 'kv_poster', title: '主KV海报', status: 'succeeded', url: '/uploads/poster-text/1/1-final.png', note: '艺术成图，未叠系统字' },
    ],
  });
  const pack = parseCampaignMaterialsPack(markdown);
  assert.equal(pack.items[0].id, 'kv_poster');
  assert.match(stripCampaignMaterialsFence(markdown), /活动物料成图/u);
  assert.doesNotMatch(stripCampaignMaterialsFence(markdown), /nanowork-campaign-materials/u);
  assert.equal(cleanReportBody(markdown).includes('nanowork-campaign-materials'), false);
  const view = restaurantOutputPresentation(markdown);
  assert.equal(view.campaignMaterials[0].title, '主KV海报');
  assert.doesNotMatch(view.overviewMarkdown, /nanowork-campaign-materials/u);
  assert.equal(campaignMaterialFilePath('/uploads/poster-text/1/../2/x.png', 1), null);
  assert.equal(campaignMaterialFilePath('/uploads/poster-text/9/1-final.png', 1), null);
});

test('附加物料图后仍保留原方案，工作台与体验页都能展示成图', async () => {
  const attached = await attachSuperManagerCampaignMaterials(
    { text: PLAN, usage: { inputTokens: 12, outputTokens: 8 } },
    {
      requirement: '给我宣传单样和Banner图，招牌菜红烧牛肉面。门店名称：老王牛肉面',
      storeName: '老王牛肉面',
      tenantId: 1,
      generateImageFn: async args => ({ b64: basePngB64, model: args.model }),
    },
  );
  assert.match(attached.text, /# 周末家庭套餐活动方案/u);
  assert.deepEqual(attached.campaignMaterials.items.map(item => item.id), [
    'flyer_a', 'flyer_b', 'banner_a', 'banner_b',
  ]);
  assert.equal(attached.campaignMaterials.items.filter(item => item.status === 'succeeded').length, 4);

  const workbench = readFileSync(new URL('../../web/src/components/EmployeeWorkbench.tsx', import.meta.url), 'utf8');
  const mobile = readFileSync(new URL('../../web/src/components/mobile/MobileTasks.tsx', import.meta.url), 'utf8');
  const trial = readFileSync(new URL('../../web/src/pages/TrialShared.tsx', import.meta.url), 'utf8');
  const taskCenter = readFileSync(new URL('../../web/src/pages/TaskCenter.tsx', import.meta.url), 'utf8');
  const gallery = readFileSync(new URL('../../web/src/components/CampaignMaterialsGallery.tsx', import.meta.url), 'utf8');
  const vite = readFileSync(new URL('../../web/vite.config.ts', import.meta.url), 'utf8');
  const testers = readFileSync(new URL('../src/routes/testers.js', import.meta.url), 'utf8');
  const trials = readFileSync(new URL('../src/engines/tester-trials.js', import.meta.url), 'utf8');
  const workbenchJs = readFileSync(new URL('../src/employee-workbench.js', import.meta.url), 'utf8');
  const ai = readFileSync(new URL('../src/engines/ai.js', import.meta.url), 'utf8');
  assert.match(workbench, /CampaignMaterialsGallery items=\{restaurantReportView\.campaignMaterials\}/);
  assert.match(mobile, /CampaignMaterialsGallery items=\{report\.campaignMaterials\}/);
  assert.match(trial, /CampaignMaterialsGallery/);
  assert.match(taskCenter, /CampaignMaterialsGallery items=\{resultView\.campaignMaterials\}/);
  assert.match(vite, /['\"]\/uploads['\"]/);
  assert.match(gallery, /点选这套/);
  assert.match(gallery, /两套备选，点选一套使用/);
  assert.match(gallery, /先读品牌 Logo\s+和调性再图生图/);
  assert.match(workbenchJs, /艺术设计成品/);
  assert.match(workbenchJs, /先读取品牌知识包里的 Logo/);
  assert.match(workbenchJs, /禁止把折扣、价格、平台产品名/);
  assert.match(testers, /conversations\/:id\/materials\/:slot/);
  assert.match(trials, /generateImageFn: chatFn === chat \? generateImage/);
  assert.match(trials, /chatFn: chatFn === chat \? chat/);
  assert.match(workbenchJs, /活动SOP|活动执行表/);
  assert.match(workbenchJs, /宣传单两套备选/);
  assert.match(ai, /attachSuperManagerCampaignMaterials/);
});

test('物料图的供应商回执不并入文字任务用量（否则文字预授权结算被拦、任务永久待账务对账）', async () => {
  const receipt = {
    status: 'known',
    requestId: 'img-receipt-1',
    model: 'openai/gpt-image-2',
    costYuanOverride: 0.154,
    costSource: {
      type: 'provider_receipt', provider: '360', requestId: 'img-receipt-1',
      currency: 'CNY', amount: 0.154, exchangeRate: 1,
    },
  };
  const attached = await attachSuperManagerCampaignMaterials(
    { text: PLAN, usage: { inputTokens: 12, outputTokens: 8 } },
    {
      requirement: '给我宣传单样，招牌菜红烧牛肉面。门店名称：老王牛肉面',
      storeName: '老王牛肉面',
      tenantId: 1,
      generateImageFn: async args => ({ b64: basePngB64, model: args.model, usage: { supplierCosts: [receipt] } }),
    },
  );
  assert.deepEqual(attached.usage, { inputTokens: 12, outputTokens: 8 });
  assert.equal(attached.usage.supplierCosts, undefined);
  // 回执没有丢：仍留在物料包自己的用量里，供图片那笔预授权对账
  assert.ok(attached.campaignMaterials.usage.supplierCosts.length >= 1);
});

test('只有要活动方案或明说要物料时才出图；问行不行、答案是不能做时不出', () => {
  const yes = (requirement, text = '# 活动方案\n一句话：周末双人套餐引流。') =>
    shouldGenerateCampaignMaterials({ requirement, text }).generate;
  assert.equal(yes('这个周末想做一场引流活动，预算3000元，帮我策划。'), true);
  assert.equal(yes('给我一套国庆活动的海报和桌贴'), true);
  assert.equal(yes('帮我出开业活动方案'), true);
  // 线上任务 #578：合规问题，且答案开头就是“不能做”
  assert.equal(yes('我想做抽奖活动，一等奖送价值6万元的全年免单卡，可以吗？', '# 抽奖活动可行性答复：不能做\n结论：不可行，属于违法行为。'), false);
  // 线上任务 #579：问的是怎么设计才不亏，不是要物料
  assert.equal(yes('想做“充500送锅底，第二份半价”，怎么设计才不亏？'), false);
  assert.equal(yes('帮我策划一场周年庆活动', '# 结论\n这个活动不能做，必须先改方案。'), false);
  assert.equal(yes('本月人工成本为什么高'), false);
  // 明说要物料时，即使句式是问句也出
  assert.equal(yes('周末活动的海报可以帮我出吗'), true);
});

test('物料图品牌：老板填的店名优先；与品牌知识包不是同一品牌时不带知识包的 Logo 与调性', () => {
  const pack = { brandName: '北京大鸭梨', logoUrl: 'http://example.test/logo.png', dishes: ['挂炉烤鸭'], style: '红色' };
  const mismatch = resolveCampaignIdentity({ ownerStoreName: '罗二火锅', brandIdentity: pack });
  assert.equal(mismatch.storeName, '罗二火锅');
  assert.deepEqual(mismatch.brandIdentity, { brandName: '罗二火锅' });
  assert.equal(mismatch.source, 'owner_overrides_brand_pack');

  const match = resolveCampaignIdentity({ ownerStoreName: '大鸭梨', brandIdentity: pack });
  assert.equal(match.storeName, '大鸭梨');
  assert.equal(match.brandIdentity.logoUrl, pack.logoUrl);

  const noOwner = resolveCampaignIdentity({ brandIdentity: pack, fallbackStoreName: '默认门店' });
  assert.equal(noOwner.storeName, '北京大鸭梨');
  assert.equal(noOwner.brandIdentity, pack);

  assert.equal(resolveCampaignIdentity({ fallbackStoreName: '老王牛肉面' }).storeName, '老王牛肉面');
});

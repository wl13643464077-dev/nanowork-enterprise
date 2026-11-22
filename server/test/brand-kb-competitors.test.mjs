import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { removeTempDbSafely } from './helpers/temp-db.mjs';

const DBP = path.join(os.tmpdir(), `nanowork-brand-kb-comp-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* fresh test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NANOWORK_AI_PROVIDER = '';
process.env.YUNWU_API_KEY = '';
process.env.YUNWU_BASE_URL = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';
process.env.ENABLE_SCHEDULER = 'false';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';

const {
  BRAND_KB_CATEGORY,
  BRAND_KNOWLEDGE_DIMENSIONS,
  COMPETITOR_KB_CATEGORY,
  COMPETITOR_PACK_LIMIT,
  archiveBrandPack,
  brandKnowledgeOverview,
  brandMatchExcerpts,
  campaignBrandIdentity,
  collectBrandKnowledgePack,
  confirmBrandPack,
  loadActiveBrandPack,
  loadCompetitorBrandPacks,
  recollectBrandDimensions,
  setDimensionIncluded,
  updateBrandDimension,
  withBrandKnowledgeCategories,
} = await import('../src/engines/brand-knowledge-pack.js');
const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'主测试餐厅','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(2,'隔离测试餐厅B','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);

after(async () => {
  await removeTempDbSafely(DBP);
});

function makeFakeSearch(brandName, priceText, dishText) {
  return () => ({
    results: [
      {
        title: `${brandName}官网`,
        url: `https://example.com/${encodeURIComponent(brandName)}`,
        snippet: `${brandName}主打${dishText}，人均${priceText}，全国多店经营。`,
      },
    ],
  });
}

function makeFakeChat(brandName, overrides = {}) {
  return () => ({
    text: JSON.stringify({
      summary: `${brandName}近 90 天公开画像`,
      dimensions: BRAND_KNOWLEDGE_DIMENSIONS.map(item => ({
        key: item.key,
        body: overrides[item.key] || `${brandName}·${item.title}：公开核验内容。`,
        sources: [{ title: `${brandName}官网`, url: `https://example.com/${encodeURIComponent(brandName)}` }],
      })),
    }),
  });
}

describe('R-03 品牌知识包多包与竞品档案对照', { concurrency: false }, () => {
  let ownPackId = null;
  let comp1Id = null;
  let comp2Id = null;
  let comp3Id = null;

  test('本品牌包与竞品包并存互不覆盖，竞品入库写入 category=竞品档案 与专用标题前缀', async () => {
    await runWithTenant(1, async () => {
      const ownDraft = await collectBrandKnowledgePack({
        brandName: '老王牛肉面',
        webSearchFn: makeFakeSearch('老王牛肉面', '38元', '红烧牛肉面'),
        chatFn: makeFakeChat('老王牛肉面', {
          price: '人均 35-42 元，核心面品 28 元起',
          products: '招牌红烧牛肉面、番茄牛腩面、手打牛肉丸',
          audience: '周边写字楼白领与家庭晚餐客群',
        }),
      });
      assert.equal(ownDraft.packRole, 'own');
      ownPackId = ownDraft.id;
      const ownReady = confirmBrandPack();
      assert.equal(ownReady.status, 'ready');
      assert.equal(ownReady.packRole, 'own');

      const ownDoc = q.get(`SELECT * FROM kb_docs WHERE tenant_id=1 AND id=?`, ownReady.kbDocId);
      assert.equal(ownDoc.category, BRAND_KB_CATEGORY);
      assert.equal(ownDoc.title, '老王牛肉面·品牌知识包');

      // 采集第一个竞品档案
      const comp1Draft = await collectBrandKnowledgePack({
        brandName: '陈记拉面馆',
        packRole: 'competitor',
        webSearchFn: makeFakeSearch('陈记拉面馆', '48元', '骨汤拉面'),
        chatFn: makeFakeChat('陈记拉面馆', {
          price: '人均 45-55 元，招牌碗 36 元',
          products: '豚骨拉面、炙烤叉烧饭、糖心蛋',
          audience: '年轻白领与商场逛街客群',
        }),
      });
      comp1Id = comp1Draft.id;
      assert.equal(comp1Draft.packRole, 'competitor');
      assert.equal(comp1Draft.status, 'review');
      assert.notEqual(comp1Draft.id, ownPackId);

      // 本品牌包完好无损
      const activeOwn = loadActiveBrandPack(1);
      assert.equal(activeOwn.id, ownPackId);
      assert.equal(activeOwn.brand_name, '老王牛肉面');
      assert.equal(activeOwn.status, 'ready');

      // 确认竞品入库
      const comp1Ready = confirmBrandPack(comp1Id);
      assert.equal(comp1Ready.status, 'ready');
      assert.equal(comp1Ready.packRole, 'competitor');
      const comp1Doc = q.get(`SELECT * FROM kb_docs WHERE tenant_id=1 AND id=?`, comp1Ready.kbDocId);
      assert.equal(comp1Doc.category, COMPETITOR_KB_CATEGORY);
      assert.equal(comp1Doc.title, '【竞品档案】陈记拉面馆 品牌知识包');
      assert.match(comp1Doc.body, /# 【竞品档案】陈记拉面馆 品牌知识包/);
      assert.match(comp1Doc.body, /豚骨拉面/);

      // 分类召回同时包含品牌知识包和竞品档案
      const cats = withBrandKnowledgeCategories(['商圈调研']);
      assert.equal(cats[0], BRAND_KB_CATEGORY);
      assert.ok(cats.includes(COMPETITOR_KB_CATEGORY));

      // 本品牌识别与匹配不会被竞品劫持
      const identity = campaignBrandIdentity(1);
      assert.equal(identity.brandName, '老王牛肉面');
      const excerpts = brandMatchExcerpts('招牌面品与价格带');
      assert.match(excerpts, /老王牛肉面/);
      assert.doesNotMatch(excerpts, /陈记拉面馆/);

      const overview = brandKnowledgeOverview();
      assert.equal(overview.pack.id, ownPackId);
      assert.equal(overview.competitorLimit, COMPETITOR_PACK_LIMIT);
      assert.equal(overview.competitors.length, 1);
      assert.equal(overview.competitors[0].id, comp1Id);
      assert.equal(overview.competitors[0].brandName, '陈记拉面馆');
    });
  });

  test('竞品档案支持独立改写、勾选、纠错重抓与升级，不影响本品牌包', async () => {
    await runWithTenant(1, async () => {
      const overviewBefore = brandKnowledgeOverview();
      const comp1 = overviewBefore.competitors.find(item => item.id === comp1Id);
      const priceDim = comp1.dimensions.find(item => item.key === 'price');

      const edited = updateBrandDimension(priceDim.id, { body: '实探核验：人均 52 元，午市套餐 42 元。' });
      assert.equal(edited.id, comp1Id);
      assert.equal(edited.status, 'review');
      assert.match(edited.dimensions.find(item => item.key === 'price').body, /人均 52 元/);

      const logoDim = edited.dimensions.find(item => item.key === 'logo');
      const toggled = setDimensionIncluded(logoDim.id, false);
      assert.equal(toggled.dimensions.find(item => item.key === 'logo').included, false);

      const recollected = await recollectBrandDimensions({
        packId: comp1Id,
        keys: ['campaigns'],
        feedback: '补充抖音 39.9 单人团购活动',
        webSearchFn: makeFakeSearch('陈记拉面馆', '52元', '骨汤拉面'),
        chatFn: makeFakeChat('陈记拉面馆', {
          campaigns: '抖音团购 39.9 元单人招牌拉面套餐，点评收藏打卡送小菜。',
        }),
      });
      assert.equal(recollected.id, comp1Id);
      assert.match(recollected.dimensions.find(item => item.key === 'campaigns').body, /39\.9/);
      assert.match(recollected.dimensions.find(item => item.key === 'price').body, /人均 52 元/);

      // 升级指定竞品包，保留手动修改的 price 维度
      const upgraded = await collectBrandKnowledgePack({
        brandName: '陈记拉面馆',
        packRole: 'competitor',
        packId: comp1Id,
        upgrade: true,
        webSearchFn: makeFakeSearch('陈记拉面馆', '52元', '骨汤拉面'),
        chatFn: makeFakeChat('陈记拉面馆', { price: '新抓取均价' }),
      });
      assert.equal(upgraded.id, comp1Id);
      assert.equal(upgraded.packRole, 'competitor');
      assert.match(upgraded.dimensions.find(item => item.key === 'price').body, /人均 52 元/);

      // 本品牌包依然是 ready 状态且内容未被改动
      const activeOwn = loadActiveBrandPack(1);
      assert.equal(activeOwn.id, ownPackId);
      assert.equal(activeOwn.status, 'ready');
    });
  });

  test('最多维护 3 个竞品档案，第 4 个返回 409；删除指定竞品不影响本品牌并释放名额', async () => {
    await runWithTenant(1, async () => {
      const comp2 = await collectBrandKnowledgePack({
        brandName: '张记刀削面',
        packRole: 'competitor',
        webSearchFn: makeFakeSearch('张记刀削面', '28元', '油泼刀削面'),
        chatFn: makeFakeChat('张记刀削面'),
      });
      comp2Id = comp2.id;

      const comp3 = await collectBrandKnowledgePack({
        brandName: '李家川味面',
        packRole: 'competitor',
        webSearchFn: makeFakeSearch('李家川味面', '32元', '豌杂小面'),
        chatFn: makeFakeChat('李家川味面'),
      });
      comp3Id = comp3.id;

      assert.equal(loadCompetitorBrandPacks(1).length, 3);

      // 第 4 个竞品必须抛 409
      await assert.rejects(
        () => collectBrandKnowledgePack({
          brandName: '赵氏拌面王',
          packRole: 'competitor',
          webSearchFn: makeFakeSearch('赵氏拌面王', '30元', '葱油拌面'),
          chatFn: makeFakeChat('赵氏拌面王'),
        }),
        (err) => {
          assert.equal(err.status, 409);
          assert.equal(err.code, 'COMPETITOR_PACK_LIMIT_REACHED');
          assert.match(err.message, /最多同时维护 3 个竞品品牌档案/);
          return true;
        },
      );

      // 确认 comp2 入库后删除 comp2，验证不影响 ownPack 和 comp1/comp3
      const comp2Ready = confirmBrandPack(comp2Id);
      const removed = archiveBrandPack(comp2Id);
      assert.equal(removed.ok, true);
      assert.equal(removed.id, comp2Id);
      assert.equal(removed.packRole, 'competitor');

      const disabledDoc = q.get(`SELECT enabled FROM kb_docs WHERE tenant_id=1 AND id=?`, comp2Ready.kbDocId);
      assert.equal(disabledDoc.enabled, 0);

      // 本品牌依然存活且已发布
      const overviewAfterDel = brandKnowledgeOverview();
      assert.equal(overviewAfterDel.pack.id, ownPackId);
      assert.equal(overviewAfterDel.pack.status, 'ready');
      assert.equal(overviewAfterDel.competitors.length, 2);
      assert.ok(!overviewAfterDel.competitors.some(item => item.id === comp2Id));
      assert.ok(overviewAfterDel.competitors.some(item => item.id === comp1Id));
      assert.ok(overviewAfterDel.competitors.some(item => item.id === comp3Id));

      // 释放名额后可以再次采集第 3 个竞品
      const comp4 = await collectBrandKnowledgePack({
        brandName: '赵氏拌面王',
        packRole: 'competitor',
        webSearchFn: makeFakeSearch('赵氏拌面王', '30元', '葱油拌面'),
        chatFn: makeFakeChat('赵氏拌面王'),
      });
      assert.equal(comp4.packRole, 'competitor');
      assert.equal(loadCompetitorBrandPacks(1).length, 3);
    });
  });

  test('多租户隔离严格生效：租户 B 看不到也无法操作租户 A 的本品牌或竞品包', async () => {
    await runWithTenant(2, async () => {
      const overviewB = brandKnowledgeOverview();
      assert.equal(overviewB.pack, null);
      assert.deepEqual(overviewB.competitors, []);

      assert.throws(() => confirmBrandPack(comp1Id), (err) => err.status === 404);
      assert.throws(() => archiveBrandPack(comp1Id), (err) => err.status === 404);
      assert.throws(() => archiveBrandPack(ownPackId), (err) => err.status === 404);

      await assert.rejects(
        () => recollectBrandDimensions({
          packId: comp1Id,
          keys: ['price'],
          feedback: '越权测试',
          webSearchFn: makeFakeSearch('越权', '1元', '测试'),
          chatFn: makeFakeChat('越权'),
        }),
        (err) => err.status === 404,
      );

      await assert.rejects(
        () => collectBrandKnowledgePack({
          brandName: '越权修改',
          packRole: 'competitor',
          packId: comp1Id,
          webSearchFn: makeFakeSearch('越权修改', '1元', '测试'),
          chatFn: makeFakeChat('越权修改'),
        }),
        (err) => err.status === 404,
      );

      // 租户 B 自己创建竞品不受租户 A 的 3 个名额影响
      const compB = await collectBrandKnowledgePack({
        brandName: '租户B竞品一号',
        packRole: 'competitor',
        webSearchFn: makeFakeSearch('租户B竞品一号', '60元', '火锅'),
        chatFn: makeFakeChat('租户B竞品一号'),
      });
      assert.equal(compB.packRole, 'competitor');
      assert.equal(loadCompetitorBrandPacks(2).length, 1);
    });

    // 确认租户 A 的数据丝毫未变
    runWithTenant(1, () => {
      assert.equal(loadActiveBrandPack(1).id, ownPackId);
      assert.equal(loadCompetitorBrandPacks(1).length, 3);
    });
  });

  test('路由与前端 UI 契约：支持多包路由、6 维对照表及钱商圈(#102)/王菜单(#108)闭环派活', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const routeSrc = fs.readFileSync(path.join(root, 'server/src/routes/brand-kb.js'), 'utf8');
    const pageSrc = fs.readFileSync(path.join(root, 'web/src/pages/BrandKb.tsx'), 'utf8');

    assert.match(routeSrc, /packRole:\s*req\.body\?\.packRole/);
    assert.match(routeSrc, /packId:\s*req\.body\?\.packId/);
    assert.match(routeSrc, /r\.delete\(['"]\/:id['"]/);
    assert.match(routeSrc, /confirmBrandPack\(req\.body\?\.packId\)/);

    assert.match(pageSrc, /dispatchToEmployee\(nav,\s*102/);
    assert.match(pageSrc, /dispatchToEmployee\(nav,\s*108/);
    assert.match(pageSrc, /派给钱商圈\(#102\)做竞争突围分析/);
    assert.match(pageSrc, /派给王菜单\(#108\)做菜单差异化定价/);
    assert.match(pageSrc, /本品牌 vs 竞品一键对照/);
    for (const key of ['price', 'products', 'audience', 'channels', 'reviews', 'campaigns']) {
      assert.match(pageSrc, new RegExp(`key:\\s*'${key}'`));
    }
  });
});

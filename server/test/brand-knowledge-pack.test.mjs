import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { removeTempDbSafely } from './helpers/temp-db.mjs';

const DBP = path.join(os.tmpdir(), `nanowork-brand-kb-${process.pid}.db`);
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const {
  BRAND_KB_CATEGORY,
  BRAND_KNOWLEDGE_DIMENSIONS,
  archiveBrandPack,
  brandKnowledgeOverview,
  brandMatchExcerpts,
  campaignBrandIdentity,
  extractBrandAssetUrl,
  extractBrandAssetUrls,
  isPlatformBrandStamp,
  collectBrandKnowledgePack,
  confirmBrandPack,
  deleteBrandDimension,
  recollectBrandDimensions,
  setDimensionIncluded,
  updateBrandDimension,
  withBrandKnowledgeCategories,
} = await import('../src/engines/brand-knowledge-pack.js');
const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { kbSearch } = await import('../src/engines/ai.js');

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'品牌知识包测试店','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);

after(async () => {
  await removeTempDbSafely(DBP);
});

function fakeSearch() {
  return {
    results: [
      {
        title: '老王牛肉面官网',
        url: 'https://example.com/laowang',
        snippet: '老王牛肉面坚持现煮现卖，招牌红烧牛肉面与周末家庭套餐。',
      },
      {
        title: '近三个月门店活动',
        url: 'https://example.com/laowang/news',
        snippet: '近三个月推出家庭套餐与夜市加场。',
      },
    ],
  };
}

function fakeChat() {
  return {
    text: JSON.stringify({
      summary: '老王牛肉面近三个月公开资料集合',
      dimensions: BRAND_KNOWLEDGE_DIMENSIONS.map(item => ({
        key: item.key,
        body: item.key === 'products'
          ? '招牌产品：红烧牛肉面、周末家庭套餐。来源为官网菜单。'
          : `${item.title}：公开资料显示该品牌坚持现煮现卖，近三个月仍在传播。`,
        sources: [{ title: '官网', url: 'https://example.com/laowang' }],
      })),
    }),
  };
}

describe('品牌知识包', { concurrency: false }, () => {
test('品牌知识包抓回后先审阅，确认入库后才给数字员工按产品匹配', async () => {
  assert.ok(BRAND_KNOWLEDGE_DIMENSIONS.length >= 20);
  await runWithTenant(1, async () => {
    const chatCalls = [];
    const draft = await collectBrandKnowledgePack({
      brandName: '老王牛肉面',
      webSearchFn: fakeSearch,
      chatFn: async (opts) => {
        chatCalls.push(opts);
        return fakeChat();
      },
    });
    assert.ok(chatCalls.length >= 2, '24 个维度应分批写，避免一次把输出额度吃光');
    assert.equal(chatCalls[0].thinking, false);
    assert.equal(draft.status, 'review');
    assert.equal(draft.brandName, '老王牛肉面');
    assert.equal(draft.dimensionCount, BRAND_KNOWLEDGE_DIMENSIONS.length);
    assert.equal(draft.kbDocId, null);
    assert.equal(brandMatchExcerpts('周末家庭套餐海报'), '');

    const logo = draft.dimensions.find(item => item.key === 'logo');
    const dropped = setDimensionIncluded(logo.id, false);
    assert.equal(dropped.dimensions.find(item => item.key === 'logo').included, false);

    const pack = confirmBrandPack();
    assert.equal(pack.status, 'ready');
    assert.equal(pack.published, true);
    const doc = q.get(`SELECT * FROM kb_docs WHERE tenant_id=1 AND id=?`, pack.kbDocId);
    assert.equal(doc.category, BRAND_KB_CATEGORY);
    assert.equal(doc.enabled, 1);
    assert.match(doc.body, /招牌产品：红烧牛肉面/);
    assert.doesNotMatch(doc.body, /品牌Logo与视觉识别/);

    const cats = withBrandKnowledgeCategories(['餐饮产业知识库']);
    assert.equal(cats[0], BRAND_KB_CATEGORY);
    assert.ok(cats.includes('餐饮产业知识库'));
    assert.ok(cats.includes('员工产出'));

    const matched = brandMatchExcerpts('周末家庭套餐海报');
    assert.match(matched, /品牌知识包·优先匹配·老王牛肉面/);
    assert.match(matched, /招牌产品/);
    assert.match(brandMatchExcerpts('写一篇小红书种草'), /老王牛肉面/);
    assert.match(brandMatchExcerpts('带货短视频'), /招牌产品/);

    const kb = await kbSearch(['产品资料'], 'boss', '周末家庭套餐海报');
    assert.match(kb.text, /品牌知识包·优先匹配/);
    assert.match(kb.text, /红烧牛肉面/);

    q.run(
      `INSERT INTO kb_docs(category,title,body,enabled) VALUES('品牌资料','店内确认菜单','本店只卖手擀红烧牛肉面',1)`,
    );
    const uploaded = await kbSearch(['餐饮产业知识库'], 'boss', null);
    assert.match(uploaded.text, /本店只卖手擀红烧牛肉面/, '已上传知识库即使工作台勾选了空分类名也要能调用');
  });
});

test('模型只回用量没有正文时，审阅区仍留下 24 条待核验卡', async () => {
  await runWithTenant(1, async () => {
    const draft = await collectBrandKnowledgePack({
      brandName: '老王牛肉面',
      webSearchFn: fakeSearch,
      chatFn: async () => {
        throw Object.assign(new Error('AI供应商返回了用量但没有业务正文'), {
          code: 'provider_empty_output',
          status: 502,
        });
      },
    });
    assert.equal(draft.status, 'review');
    assert.equal(draft.dimensionCount, BRAND_KNOWLEDGE_DIMENSIONS.length);
    assert.match(draft.lastError, /没有业务正文/);
    assert.ok(draft.dimensions.some(item => item.status === 'pending'));
    assert.match(draft.dimensions.find(item => item.key === 'products').body, /招牌红烧牛肉面/);
    assert.equal(brandMatchExcerpts('周末家庭套餐海报'), '');
  });
});

test('可改、可挑、可指出错误重抓，升级保留已改内容，删除后不再调用', async () => {
  await runWithTenant(1, async () => {
    const before = brandKnowledgeOverview().pack;
    const products = before.dimensions.find(item => item.key === 'products');
    const saved = updateBrandDimension(products.id, {
      body: '本店确认：只卖手擀红烧牛肉面，不写未核验套餐价。',
    });
    assert.equal(saved.status, 'review');
    const edited = saved.dimensions.find(item => item.key === 'products');
    assert.equal(edited.status, 'edited');
    assert.match(edited.body, /手擀红烧牛肉面/);

    const recaptured = await recollectBrandDimensions({
      keys: ['slogan'],
      feedback: '口号写错了，不是现煮现卖那句。',
      webSearchFn: fakeSearch,
      chatFn: fakeChat,
    });
    assert.equal(recaptured.status, 'review');
    assert.match(recaptured.dimensions.find(item => item.key === 'products').body, /手擀红烧牛肉面/);

    const upgraded = await collectBrandKnowledgePack({
      brandName: '老王牛肉面',
      upgrade: true,
      webSearchFn: fakeSearch,
      chatFn: fakeChat,
    });
    const stillEdited = upgraded.dimensions.find(item => item.key === 'products');
    assert.equal(stillEdited.status, 'edited');
    assert.match(stillEdited.body, /手擀红烧牛肉面/);

    const cleared = deleteBrandDimension(stillEdited.id);
    assert.equal(cleared.dimensions.find(item => item.key === 'products').included, false);

    const published = confirmBrandPack();
    assert.equal(published.status, 'ready');
    const archived = archiveBrandPack();
    assert.equal(archived.ok, true);
    const doc = q.get(`SELECT enabled FROM kb_docs WHERE tenant_id=1 AND id=?`, published.kbDocId);
    assert.equal(doc.enabled, 0);
    assert.equal(brandKnowledgeOverview().pack, null);
  });
});

test('公开检索必须带回可核对的品牌事实，不能用行业新闻和待核验空话交差', async () => {
  await runWithTenant(1, async () => {
    const searches = [];
    const chats = [];
    const draft = await collectBrandKnowledgePack({
      brandName: '北京大鸭梨烤鸭',
      webSearchFn: (query, options) => {
        searches.push({ query, options });
        return {
          results: [
            {
              title: '大鸭梨烤鸭官网',
              url: 'https://example.com/dayali',
              snippet: '北京大鸭梨烤鸭以果木烤鸭和门店堂食闻名。',
            },
            {
              title: '餐饮出海，店开出去之后怎么把用户留下来',
              url: 'https://www.canyin88.com/haiwai',
              snippet: '餐饮行业宏观分析，与具体烤鸭品牌无关。',
            },
          ],
        };
      },
      poiSearchFn: async () => ({
        data: {
          pois: [{
            id: 'B000',
            name: '大鸭梨烤鸭(亚运村店)',
            type: '中餐;烤鸭',
            address: '北辰东路8号',
            cityname: '北京',
            adname: '朝阳区',
            tel: '010-84981888',
            coords: { lng: 116.4, lat: 39.99 },
            biz_ext: { cost: 98 },
          }],
        },
      }),
      fetchPagesFn: async () => ({ results: [] }),
      chatFn: async (opts) => {
        chats.push(opts);
        return {
          text: JSON.stringify({
            summary: '公开检索未发现近三个月新闻',
            dimensions: BRAND_KNOWLEDGE_DIMENSIONS.map(item => ({
              key: item.key,
              body: '待核验：公开检索未形成可引用事实。',
              sources: [],
            })),
          }),
        };
      },
    });
    assert.ok(searches.length >= 1);
    assert.equal(searches[0].options.allowBroadFallback, false);
    assert.equal(searches[0].options.fallbackOrder, 'web_first');
    assert.ok(searches.every(item => !/2026年6月/.test(item.query)));
    const prompt = String(chats[0]?.system || '');
    assert.match(prompt, /常青维度/);
    assert.doesNotMatch(String(chats[0]?.messages?.[0]?.content || ''), /canyin88/);
    assert.match(String(chats[0]?.messages?.[0]?.content || ''), /dayali|果木烤鸭|亚运村店/);
    const channels = draft.dimensions.find(item => item.key === 'channels');
    const identity = draft.dimensions.find(item => item.key === 'identity');
    assert.equal(channels.status, 'filled');
    assert.match(channels.body, /亚运村店/);
    assert.match(identity.body, /大鸭梨/);
    assert.doesNotMatch(JSON.stringify(draft.dimensions), /canyin88/);
    assert.ok(searches.some(item => /理念|口号/.test(item.query)));
    assert.ok(searches.some(item => /大众点评/.test(item.query)));
    assert.ok(searches.some(item => /食品安全|资质/.test(item.query)));
    assert.ok(searches.some(item => /端午|中秋|年夜饭/.test(item.query)));
  });
});

test('官网正文、Logo图片、点评和节庆页必须写成可对错的事实，不能待核验空话', async () => {
  await runWithTenant(1, async () => {
    q.run(`DELETE FROM brand_knowledge_dimensions`);
    q.run(`DELETE FROM brand_knowledge_packs`);
    const home = [
      '北京大鸭梨餐饮有限公司成立于1997年4月26日，公司成立以来秉承“诚实信用，求变创新,广纳人才，服务大众”之理念。',
      '大鸭梨烤鸭拥有直营门店70余家，2012年大鸭梨走出国门，开拓加拿大市场。',
      '大鸭梨中秋佳节慰问信。2017 荣获新春年夜饭评选的“人气品牌奖”。',
      '版权所有 北京大鸭梨餐饮集团 京ICP备08103606号',
    ].join('');
    const culture = [
      '我们的愿景：鸭梨味，味天下',
      '我们的使命：让顾客感受温暖，让员工收获成长。',
      '我们的客户观：客户的满意高于一切',
      '大鸭梨专注烤鸭二十年。吃烤鸭哪里去，当然要到大鸭梨。百年基业，百店常兴。',
    ].join('');
    const holiday = '【鸭梨端午节送粽子】端午节当天到大鸭梨用餐，进店即可获得粽子一枚。';
    const draft = await collectBrandKnowledgePack({
      brandName: '北京大鸭梨烤鸭',
      webSearchFn: () => ({
        results: [
          {
            title: '北京大鸭梨餐饮有限公司官网',
            url: 'http://www.dayalihome.com/',
            snippet: home.slice(0, 80),
          },
          {
            title: '大鸭梨烤鸭(望京店)大众点评',
            url: 'http://m.dianping.com/shop/513106',
            snippet: '4.7分 招牌香酥烤鸭 望京烤鸭',
          },
        ],
      }),
      poiSearchFn: async () => ({ data: { pois: [] } }),
      fetchPagesFn: async (sources) => ({
        results: (Array.isArray(sources) ? sources : []).map(source => {
          const url = String(source?.url || source || '');
          if (/dianping|meituan/iu.test(url)) {
            return {
              url,
              title: source.title || '大众点评',
              snippet: source.snippet || '4.7分 招牌香酥烤鸭',
              body: source.snippet || '4.7分 招牌香酥烤鸭',
              images: [],
              pageLinks: [],
            };
          }
          if (url.includes('CateId=64')) {
            return { url, title: '集团企业文化', snippet: culture, body: culture, images: [], pageLinks: [] };
          }
          if (url.includes('nid=107')) {
            return { url, title: '端午节送粽子', snippet: holiday, body: holiday, images: [], pageLinks: [] };
          }
          return {
            url,
            title: '北京大鸭梨餐饮有限公司',
            snippet: home,
            body: home,
            images: [{ url: 'http://www.dayalihome.com/skin/images/logo.png', isLogo: true }],
            pageLinks: [
              'http://www.dayalihome.com/About.aspx?CateId=64',
              'http://www.dayalihome.com/News.aspx?nid=107',
            ],
          };
        }),
      }),
      chatFn: async () => ({
        text: JSON.stringify({
          summary: '模型故意留空',
          dimensions: BRAND_KNOWLEDGE_DIMENSIONS.map(item => ({
            key: item.key,
            body: '待核验：公开检索未形成可引用事实。',
            sources: [],
          })),
        }),
      }),
    });
    const pick = key => draft.dimensions.find(item => item.key === key);
    assert.equal(pick('logo').status, 'filled');
    assert.match(pick('logo').body, /skin\/images\/logo\.png/);
    assert.equal(pick('mission').status, 'filled');
    assert.match(pick('mission').body, /诚实信用/);
    assert.match(pick('mission').body, /鸭梨味，味天下|让顾客感受温暖/);
    assert.equal(pick('story').status, 'filled');
    assert.match(pick('story').body, /1997年4月26日/);
    assert.equal(pick('slogan').status, 'filled');
    assert.match(pick('slogan').body, /客户的满意高于一切|专注烤鸭二十年/);
    assert.equal(pick('compliance').status, 'filled');
    assert.match(pick('compliance').body, /京ICP备08103606号/);
    assert.equal(pick('seasonal').status, 'filled');
    assert.match(pick('seasonal').body, /端午|粽子|中秋|年夜饭/);
    assert.match(pick('reviews').body, /4\.7/);
  });
});

test('已有官网时，检索被新闻RSS占满也必须抓回Logo和理念', async () => {
  await runWithTenant(1, async () => {
    await collectBrandKnowledgePack({
      brandName: '北京大鸭梨烤鸭',
      webSearchFn: () => ({
        results: [{ title: '北京大鸭梨餐饮有限公司官网', url: 'http://www.dayalihome.com/', snippet: '北京大鸭梨官网' }],
      }),
      poiSearchFn: async () => ({ data: { pois: [] } }),
      fetchPagesFn: async () => ({ results: [] }),
      chatFn: async () => ({
        text: JSON.stringify({
          dimensions: BRAND_KNOWLEDGE_DIMENSIONS.map(item => ({
            key: item.key,
            body: item.key === 'official' ? '官网：http://www.dayalihome.com/' : '占位',
            sources: item.key === 'official' ? [{ title: '官网', url: 'http://www.dayalihome.com/' }] : [],
          })),
        }),
      }),
    });
    const draft = await recollectBrandDimensions({
      keys: ['logo', 'mission', 'story', 'slogan', 'compliance', 'seasonal'],
      feedback: '官网首页和理念页都有公开事实，禁止待核验。',
      webSearchFn: () => ({
        results: [{
          title: '餐饮行业宏观新闻',
          url: 'https://news.google.com/rss/articles/abc',
          snippet: '大鸭梨所在的餐饮行业宏观分析',
        }],
      }),
      poiSearchFn: async () => ({ data: { pois: [] } }),
      fetchPagesFn: async (sources) => ({
        results: (Array.isArray(sources) ? sources : []).map(source => {
          const url = String(source?.url || '');
          const body = '北京大鸭梨餐饮有限公司成立于1997年4月26日，秉承“诚实信用，求变创新,广纳人才，服务大众”之理念。我们的愿景：鸭梨味，味天下。端午节送粽子。京ICP备08103606号。';
          return {
            url,
            title: '北京大鸭梨餐饮有限公司官网',
            snippet: body,
            body,
            images: [{ url: 'http://www.dayalihome.com/skin/images/logo.png', isLogo: true }],
            pageLinks: ['http://www.dayalihome.com/About.aspx?CateId=64'],
          };
        }),
      }),
      chatFn: async () => ({
        text: JSON.stringify({
          dimensions: BRAND_KNOWLEDGE_DIMENSIONS.map(item => ({
            key: item.key,
            body: '待核验：公开检索未形成可引用事实。',
          })),
        }),
      }),
    });
    assert.match(draft.dimensions.find(item => item.key === 'logo').body, /logo\.png/);
    assert.match(draft.dimensions.find(item => item.key === 'mission').body, /诚实信用/);
    assert.match(draft.dimensions.find(item => item.key === 'story').body, /1997年4月26日/);
  });
});

test('物料身份从已确认知识包取品牌名和 Logo 地址', () => {
  assert.equal(isPlatformBrandStamp('Nano Work 企业'), true);
  assert.equal(isPlatformBrandStamp('北京大鸭梨烤鸭'), false);
  assert.equal(
    extractBrandAssetUrl('官网公开的品牌标志图片：http://dayalihome.com/skin/images/logo.png。请核对照片。'),
    'http://dayalihome.com/skin/images/logo.png',
  );
  assert.deepEqual(
    extractBrandAssetUrls('标志 http://dayalihome.com/skin/images/logo.png 包装 https://cdn.example/pack.jpg 说明'),
    ['http://dayalihome.com/skin/images/logo.png', 'https://cdn.example/pack.jpg'],
  );
  const identity = runWithTenant(1, () => campaignBrandIdentity());
  assert.equal(identity, null);
});

test('独立入口、导航和数字员工都会接到品牌知识包', () => {
  const app = read('web/src/App.tsx');
  const layout = read('web/src/layouts/MainLayout.tsx');
  const page = read('web/src/pages/BrandKb.tsx');
  const system = read('web/src/pages/System.tsx');
  const routes = read('server/src/app.js');
  const engine = read('server/src/engines/brand-knowledge-pack.js');
  const rag = read('server/src/engines/ai.js');

  assert.match(app, /path="\/brand-kb"/);
  assert.match(layout, /key: '\/brand-kb'[\s\S]*label: '品牌知识包'/);
  assert.match(page, /\/brand-kb\/collect/);
  assert.match(page, /\/brand-kb\/confirm/);
  assert.match(page, /\/brand-kb\/recollect/);
  assert.match(page, /确认这版入库/);
  assert.match(page, /brand-kb-logo/);
  assert.match(system, /to="\/brand-kb"/);
  assert.match(routes, /\/api\/brand-kb/);
  assert.ok(engine.includes('BRAND_KNOWLEDGE_DIMENSIONS'));
  assert.match(rag, /withBrandKnowledgeCategories/);
  assert.match(rag, /brandMatchExcerpts/);
  assert.match(read('server/src/engines/native-content-skill-context.js'), /brandMatchExcerpts/);
  assert.match(read('server/src/routes/ai-xhs-note.js'), /brandMatchExcerpts/);
  assert.match(read('server/src/routes/content.js'), /brandMatchExcerpts/);
  assert.match(read('web/src/components/mobile/MobileDispatch.tsx'), /半自动 · 逐个确认/);
  assert.match(read('web/src/components/mobile/MobileDispatch.tsx'), /\/employees\/team-summary/);
  assert.match(read('web/src/pages/BrandKb.tsx'), /不要把空卡片当成已采集/);
});

test('公开检索完全落空时标记失败，不把空卡片当成已采集', async () => {
  await runWithTenant(1, async () => {
    const draft = await collectBrandKnowledgePack({
      brandName: '不存在的虚构品牌xyz',
      webSearchFn: async () => ({ results: [] }),
      poiSearchFn: async () => ({ data: { pois: [] } }),
      fetchPagesFn: async () => ({ results: [] }),
      chatFn: async () => {
        throw new Error('无证据时不应再让模型编空卡片');
      },
    });
    assert.equal(draft.status, 'failed');
    assert.match(draft.lastError, /没有抓到|未命中/);
    assert.equal(draft.filledCount, 0);
  });
});
});

test('品牌Logo不采用企查查等第三方平台自己的标志，优先官网同域logo', async () => {
  const { rankBrandLogoCandidates, isThirdPartyBrandAsset } = await import('../src/engines/brand-knowledge-pack.js');
  const pages = [
    { title: '北京大鸭梨餐饮有限公司 - 企查查', url: 'https://www.qcc.com/firm/abc.html',
      images: [{ url: 'https://qcc-static.qcc.com/qcc/pc-web/images/logo-03617c0b.png', isLogo: true }] },
    { title: '北京大鸭梨餐饮有限公司｜首页', url: 'http://www.dayalihome.com/',
      images: [{ url: 'http://www.dayalihome.com/skin/images/logo.png' }, { url: 'http://cdn.example-brand.cn/banner-logo-strip.jpg' }] },
  ];
  const ranked = rankBrandLogoCandidates(pages, '北京大鸭梨');
  assert.equal(ranked[0].url, 'http://www.dayalihome.com/skin/images/logo.png');
  assert.ok(!ranked.some(item => /qcc/.test(item.url)));
  assert.equal(isThirdPartyBrandAsset('https://qcc-static.qcc.com/x/logo.png'), true);
  assert.equal(isThirdPartyBrandAsset('http://www.dayalihome.com/skin/images/logo.png'), false);
  assert.deepEqual(rankBrandLogoCandidates([pages[0]], '北京大鸭梨'), []);
});

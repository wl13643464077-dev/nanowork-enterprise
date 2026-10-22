import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = rel => import(pathToFileURL(path.join(root, rel)).href);

test('带货视频发布包只复用口播事实，并给出三平台文案', async () => {
  const { buildSalesVideoPublishKit, publishKitText } = await load('web/src/components/salesVideoPublishKitData.js');
  const kit = buildSalesVideoPublishKit({
    hook_3s: '下班这一锅先涮什么？',
    shots: [{ voiceover: '红汤清汤一锅两吃，约上朋友来聚餐。' }, { voiceover: '鲜切牛肉现场摆盘。' }],
    cta: '欢迎到店看看',
    facts_used: [{ claim: '招牌是鲜切牛肉', factId: 'f1' }],
  }, { brandName: '纳米火锅' });
  assert.ok(kit);
  assert.deepEqual(Object.keys(kit.platforms), ['douyin', 'channels', 'xhs']);
  assert.ok([...kit.platforms.xhs.title].length <= 20);
  assert.ok(kit.platforms.douyin.hashtags.includes('火锅'));
  assert.ok(kit.platforms.douyin.hashtags.includes('朋友聚餐'));
  assert.ok(kit.platforms.douyin.caption.includes('招牌是鲜切牛肉'));
  assert.equal(kit.warnings.length, 0);
  assert.match(publishKitText(kit.platforms.douyin), /置顶评论/);
});

test('发布包缺口播返回空，命中绝对化用语给出提醒', async () => {
  const { buildSalesVideoPublishKit } = await load('web/src/components/salesVideoPublishKitData.js');
  assert.equal(buildSalesVideoPublishKit({ shots: [] }), null);
  assert.equal(buildSalesVideoPublishKit(null), null);
  const kit = buildSalesVideoPublishKit({ shots: [{ voiceover: '全网最好吃的面。' }] });
  assert.ok(kit.warnings.some(line => /绝对化/.test(line)));
  assert.ok(kit.warnings.some(line => /没有登记已确认事实/.test(line)));
});

test('小红书发布自查按硬指标逐项判定，红线词为必改', async () => {
  const { xhsPublishChecklist, xhsFoldedBody } = await load('web/src/components/xhsPublishChecklist.js');
  const good = xhsPublishChecklist({
    title: '下班这一锅，先涮肉还是先下菜？',
    body: ['🔥 下班了，约上朋友来一锅。', '红汤清汤一锅两吃，鲜切牛肉摆满一盘。', '两三个人点一份招牌加两份素菜就够。', '想吃辣选红汤，带娃选清汤。', '评论区说说你先下哪一样？'].join('\n') + '这一锅适合周末朋友聚餐，也适合下班后的家人小聚，坐下来慢慢涮，边吃边聊，一锅热气把一周的疲惫都蒸发掉，记得提前看看营业时间再出发，周末人多可以早点来。',
    tags: ['火锅', '涮肉', '鲜切牛肉', '纳米火锅', '朋友聚餐', '下班吃什么'],
    firstComment: '红汤还是清汤？',
    compliance: { hits: [] },
  }, { imageCount: 6, aiImageCount: 6 });
  assert.equal(good.ready, true);
  assert.equal(good.passed, good.total);
  const bad = xhsPublishChecklist({ title: '', body: '短', tags: [], firstComment: '', compliance: { hits: [{ severity: 'block' }] } });
  assert.equal(bad.ready, false);
  assert.equal(bad.items.find(item => item.key === 'compliance').level, 'block');
  assert.deepEqual(xhsFoldedBody('一二三', 2), { text: '一二', folded: true });
});

test('界面已接入小红书真机预览与带货视频发布包', () => {
  const xhs = fs.readFileSync(path.join(root, 'web/src/components/AiXhsNotePanel.tsx'), 'utf8');
  const video = fs.readFileSync(path.join(root, 'web/src/components/AiSalesVideoPanel.tsx'), 'utf8');
  assert.match(xhs, /<XhsPhonePreview/);
  assert.match(video, /<SalesVideoPublishKit script=\{voicedResult\.script\}/);
});

test('钩子只是半句时，标题用口播首句，文案包含完整口播且不重复行动邀请', async () => {
  const { buildSalesVideoPublishKit } = await load('web/src/components/salesVideoPublishKitData.js');
  const kit = buildSalesVideoPublishKit({
    hook_3s: '下班饿了，',
    shots: [{ voiceover: '下班饿了，看这碗水煮牛肉，红油亮、肉片厚。欢迎约上朋友到店看看。' }],
    cta: '欢迎约上朋友到店看看。',
  });
  assert.equal(kit.platforms.douyin.title, '下班饿了，看这碗水煮牛肉，红油亮、肉片厚');
  assert.equal(kit.coverText, '下班饿了');
  assert.match(kit.platforms.douyin.caption, /红油亮、肉片厚。\n欢迎约上朋友到店看看。$/);
  assert.equal(kit.platforms.douyin.caption.match(/欢迎约上朋友/g).length, 1);
  assert.ok([...kit.platforms.xhs.title].length <= 20);
});

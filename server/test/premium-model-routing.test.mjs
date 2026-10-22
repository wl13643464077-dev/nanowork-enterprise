// OpenLux 通道的高阶模型路由：小红书配图用 GPT-Image-2.5，带货视频用 Seedance 2.5（可灵兜底）；
// 360 与其他通道保持原模型；新模型都有不低于实测成本的参考价，统一定价同样 × 2。
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-premium-routing-'));
Object.assign(process.env, { NANOWORK_DB: path.join(dir, 'test.db'), NODE_ENV: 'test', NANOWORK_TEST_TEMPLATE_AI: '1',
  SEED_DEMO: 'false', ENABLE_SCHEDULER: 'false', NANOWORK_AI_PROVIDER: '', YUNWU_BASE_URL: 'https://api.openlux.ai/v1',
  OPENLUX_API_KEY: 'premium-openlux-test', AI360_API_KEY: 'premium-360-test' });
const { db, initSchema, migrateV2, setConfig } = await import('../src/db.js');
initSchema(); migrateV2();
const { withPlatformProvider, providerForModel } = await import('../src/engines/ai-provider-selection.js');
const xhs = await import('../src/engines/ai-xhs-note.js');
const { aiSalesVoicedModel } = await import('../src/engines/ai-sales-video-native.js');
const c = await import('../src/engines/credits.js');
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('按通道选模型：OpenLux 用 GPT-Image-2.5 与 Seedance 2.5，360 保持原模型', () => {
  setConfig('ai_provider_default', 'openlux');
  withPlatformProvider('openlux', () => {
    assert.equal(xhs.xhsImageModel(), 'gpt-image-2.5-flare-c');
    assert.equal(aiSalesVoicedModel(), 'doubao-seedance-2-5-260628');
  });
  withPlatformProvider('360', () => {
    assert.equal(xhs.xhsImageModel(), 'openai/gpt-image-2');
    assert.equal(aiSalesVoicedModel(), 'alibaba/wan3.0-video');
  });
  for (const model of ['gpt-image-2.5-flare-c', 'doubao-seedance-2-5-260628', 'kling-video'])
    assert.equal(providerForModel(model), 'openlux', model);
  // 升级前创建的 GPT-Image-2 配图任务在重试/取回时仍被认可。
  assert.ok(xhs.XHS_IMAGE_MODELS.includes('gpt-image-2'));
});

test('新模型参考价不低于实测上游成本，统一定价同样覆盖', () => {
  const measured = { 'doubao-seedance-2-5-260628': 21.12, 'kling-video': 15.12 };
  setConfig('unified_360_pricing', { enabled: false });
  const local = c.billing();
  setConfig('unified_360_pricing', { enabled: true, imageBenchmarkCny: 2, imagePriceBasis: '测试' });
  const unified = c.billing();
  for (const [model, cost] of Object.entries(measured)) {
    assert.ok(local.video[model] >= cost, `${model} 本地参考价`);
    assert.ok(unified.video[model] >= cost, `${model} 统一参考价`);
    assert.ok(Math.ceil(unified.video[model] * unified.marginMultiplier / unified.creditYuan) >= c.costFloorCredits(cost, unified));
  }
  // GPT-Image-2.5 实测每张约 ¥0.10，统一图片基准价（此处 ¥2）远高于成本。
  assert.ok((unified.image['gpt-image-2.5-flare-c'] ?? unified.image.default) >= 0.1);
  setConfig('unified_360_pricing', { enabled: false });
});

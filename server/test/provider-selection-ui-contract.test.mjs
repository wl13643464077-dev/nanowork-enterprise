import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const platform = read('web/src/components/PlatformApiConfig.tsx');
const enterprise = read('web/src/components/AdminModelRoutingPanel.tsx');

test('平台分别查看、测试和保存OpenLux与360，修改默认供应商是独立动作', () => {
  assert.match(platform, /\/admin\/api-config\$\{provider \? `\?provider=/u);
  assert.match(platform, /post\('\/admin\/api-config\/test', \{ provider: selectedProvider \}\)/u);
  assert.match(platform, /provider: selectedProvider,[\s\S]*routing: rt/u);
  assert.match(platform, /defaultProvider: selectedProvider/u);
  assert.match(platform, /OPENLUX_API_KEY/u);
  assert.match(platform, /AI360_API_KEY/u);
  assert.match(platform, /readOnly/u);
  assert.doesNotMatch(platform, /Input\.Password/u);
  assert.match(platform, /两家的 Key、模型和连接验证独立管理/u);
});

test('平台统一按360基准价×2定价，上游实扣只作采购成本且Image2提示保持中性', () => {
  assert.match(platform, /统一按360基准价 × 2/u);
  assert.match(platform, /实际扣费回执只用于记录平台采购成本、利润和对账/u);
  assert.doesNotMatch(platform, /按上游实际扣费结算/u);
  assert.doesNotMatch(platform, /供应商尚未开通|配置模型未开放/u);
  assert.match(platform, /不代表生成能力或账号权限结论/u);
  assert.match(platform, /Image2 当前仍需以真实生成验收结果为准/u);
});

test('企业切换供应商先预览，仅保存时才与岗位模型一起生效', () => {
  assert.match(enterprise, /\/admin\/model-routing\$\{provider \? `\?provider=/u);
  assert.match(enterprise, /put\('\/admin\/model-routing', \{ provider: previewProvider, routing: draft \}\)/u);
  assert.match(enterprise, /previewProvider !== data\.effectiveProvider/u);
  assert.match(enterprise, /切换仅用于预览/u);
  assert.match(enterprise, /不会向企业下发 Key/u);
  assert.match(enterprise, /disabled: item\.available === false/u);
  assert.doesNotMatch(enterprise, /Input\.Password|apiKey|baseUrl/u);
});

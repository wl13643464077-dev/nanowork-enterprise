import { getConfig } from '../db.js';
import { PROVIDER_360_RESERVATION_RATES } from './provider-360-cost.js';

export const UNIFIED_PRICING_CONFIG = 'unified_360_pricing';

// One retail schedule, independent of routing and the supplier's actual debit.
// The aliases are product pricing tiers, not claims that different models are identical.
export function unifiedSalesPricing(creditYuan) {
  const config = getConfig(UNIFIED_PRICING_CONFIG, {}) || {};
  if (config.enabled !== true) return null;
  const image = config.imageBenchmarkCny;
  if (typeof image !== 'number' || !Number.isFinite(image) || image <= 0 || !String(config.imagePriceBasis || '').trim()) {
    throw Object.assign(new Error('统一图片基准价缺少金额或价格依据，不能用预占估价代替售价'),
      { status: 409, code: 'BILLING_IMAGE_PRICE_UNCONFIRMED' });
  }
  const text = structuredClone(PROVIDER_360_RESERVATION_RATES.text);
  const tiers = {
    'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
    'gpt-5.5': 'deepseek/deepseek-v4-pro',
    'claude-opus-4-8': 'deepseek/deepseek-v4-pro',
    'gemini-3.1-flash-lite': 'qwen/qwen3.8-flash',
  };
  for (const [model, reference] of Object.entries(tiers)) text[model] = { ...text[reference] };
  const video = structuredClone(PROVIDER_360_RESERVATION_RATES.video);
  video['wan2.6-i2v'] = video['alibaba/wan3.0-video'];
  // OpenLux 高阶带货视频：参考价不低于实测上游成本（见 credits.js 注释），统一售价同样 × 2，
  // 保证“上游每秒扣多少、客户至少付两倍”，不会出现按 360 万相参考价卖 Seedance 的亏本情况。
  video['doubao-seedance-2-5-260628'] = 23;
  video['kling-video'] = 16.5;
  // Every offered clip uses the same 15-second reference tier. Composite jobs
  // multiply by their frozen segment count/duration before authorizing the task.
  return {
    creditYuan, marginMultiplier: 2, text,
    image: { 'gpt-image-2': image, 'openai/gpt-image-2': image, default: image },
    video, tts: { default: 0 },
    minBalance: { text: 1, image: Math.ceil(image * 2 / creditYuan), video: Math.ceil(video.default * 2 / creditYuan) },
    rateBasis: 'reference_360', settlementBasis: 'reference_360',
    salePolicy: {
      version: 1, basis: 'reference_360', multiplier: 2,
      textReferenceModels: tiers, videoReferenceModel: 'alibaba/wan3.0-video', videoUnitSeconds: 15,
      imageBenchmarkCny: image, imagePriceBasis: String(config.imagePriceBasis).slice(0, 1000),
      imageReferenceProvider: config.imageReferenceProvider === '360' ? '360' : 'openlux',
      imageQuality: 'medium', imageSize: '1024x1024',
    },
  };
}

export const usesUnifiedSalesPricing = value => value?.salePolicy?.basis === 'reference_360';

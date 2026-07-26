import './env.js';

// ===== BE-H3：昂贵 AI 接口限流 =====
// 两层防线，只以中间件形式挂在 index.js 的路由挂载点上，不侵入各路由内部逻辑：
// 1) 租户级令牌桶：每租户每分钟 AI 生成类调用上限（默认 20 次，容量=上限，可 env 覆盖），
//    防单一企业刷爆积分/上游额度，也防无限流被恶意打点拖垮全服。
// 2) 全局并发信号量：同时在途的 AI 生成请求上限（默认 8，可 env 覆盖），
//    防长耗时上游调用把连接与内存拖爆（每个 AI 请求可挂几十秒）。
// 超限一律 429 + Retry-After，前端可提示稍后再试。

const positiveNum = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// 各挂载前缀下的"生成类"接口（POST 且真正调用 AI 上游的端点）；
// 查询/列表/模板等便宜接口不受限。路径为挂载点剥离前缀后的 req.path。
export const AI_GENERATION_ROUTES = {
  advisor: [{ method: 'POST', pattern: /^\/(chat|dispatch)$/ }],
  content: [{ method: 'POST', pattern: /^\/(generate(-ppt|-image|-video)?|daily-pack)$/ }],
  contentWorkbench: [{ method: 'POST', pattern: /^\/[0-9]\/dispatch$/ }],
  marshals: [{ method: 'POST', pattern: /^\/[^/]+\/(chat|tasks|skill-file)$/ }],
  agents: [{ method: 'POST', pattern: /^\/[^/]+\/chat$/ }],
};

export function createAiGuard({
  ratePerMinute = positiveNum(process.env.AI_TENANT_RATE_PER_MINUTE, 20),
  burst = positiveNum(process.env.AI_TENANT_BURST, 0),
  maxConcurrent = positiveNum(process.env.AI_MAX_CONCURRENT, 8),
  now = Date.now,
} = {}) {
  const capacity = Math.max(1, burst || ratePerMinute);
  const refillPerMs = ratePerMinute / 60000;
  const buckets = new Map(); // tenantId -> { tokens, updatedAt }
  let inFlight = 0;

  // 取一个令牌；桶空则返回需等待的秒数（>0 即拒绝）
  function takeToken(tenantId) {
    const t = now();
    if (buckets.size > 5000) { // 防内存膨胀：清掉已回满的闲置桶
      for (const [key, bucket] of buckets) {
        if (bucket.tokens + (t - bucket.updatedAt) * refillPerMs >= capacity) buckets.delete(key);
      }
    }
    const bucket = buckets.get(tenantId) || { tokens: capacity, updatedAt: t };
    bucket.tokens = Math.min(capacity, bucket.tokens + (t - bucket.updatedAt) * refillPerMs);
    bucket.updatedAt = t;
    buckets.set(tenantId, bucket);
    if (bucket.tokens < 1) return Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000));
    bucket.tokens -= 1;
    return 0;
  }

  // guardFor('advisor') 返回该前缀的中间件；必须挂在 authMiddleware 之后（依赖 req.user.tenant_id）
  return function guardFor(prefix) {
    const matchers = AI_GENERATION_ROUTES[prefix] || [];
    return function aiRateLimit(req, res, next) {
      const expensive = matchers.some(m => req.method === m.method && m.pattern.test(req.path));
      if (!expensive) return next();

      const tenantId = Number(req.user?.tenant_id) || 0;
      const waitSec = takeToken(tenantId);
      if (waitSec > 0) {
        res.setHeader('Retry-After', String(waitSec));
        return res.status(429).json({ error: `AI 请求过于频繁（企业每分钟上限 ${ratePerMinute} 次），请稍后再试` });
      }
      if (inFlight >= maxConcurrent) {
        res.setHeader('Retry-After', '2');
        return res.status(429).json({ error: 'AI 服务并发已满，请稍候片刻重试' });
      }
      inFlight += 1;
      let released = false;
      const release = () => { if (!released) { released = true; inFlight -= 1; } };
      res.once('finish', release);
      res.once('close', release);
      next();
    };
  };
}

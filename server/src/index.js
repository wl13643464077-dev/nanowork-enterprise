import './env.js';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSchema, migrateV2, modulesFor, q, getTenant, runWithTenant } from './db.js';
import { seed } from './seed.js';
import { ensureBaselineCatalogs } from './baseline.js';
import { authMiddleware, csrfOriginGuard, hashPassword } from './util.js';
import { platformSuperPasswordStrengthError } from './security-config.js';
import adminRoutes from './routes/admin.js';
import rechargeRoutes from './routes/recharge.js';
import platformRoutes from './routes/platform.js';
import { runScheduledJobs } from './engines/scheduler.js';
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import growthRoutes from './routes/growth.js';
import contentRoutes from './routes/content.js';
import mediaReviewRoutes from './routes/media-review.js';
import toolboxRoutes from './routes/toolbox.js';
import activityRoutes from './routes/activities.js';
import marshalRoutes from './routes/marshals.js';
import employeeRoutes from './routes/employees.js';
import employeeWorkbenchRoutes from './routes/employee-workbench.js';
import contentEmployeeWorkbenchRoutes from './routes/content-employee-workbench.js';
import advisorRoutes from './routes/advisor.js';
import executionRoutes from './routes/execution.js';
import analysisRoutes from './routes/analysis.js';
import assetRoutes from './routes/assets.js';
import systemRoutes from './routes/system.js';
import agentRoutes from './routes/agents.js';
import fileRoutes from './routes/files.js';
import dataIntakeRoutes from './routes/dataintake.js';
import metaRoutes from './routes/meta.js';
import { uploadAccessGuard } from './engines/upload-access.js';
import { createAiGuard } from './ai-limits.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3107;
const HOST = process.env.HOST || '127.0.0.1';

initSchema();
migrateV2();
ensureBaselineCatalogs();
if (process.env.SEED_DEMO === 'true') {
  if (process.env.NODE_ENV === 'production') throw new Error('生产环境禁止启用 SEED_DEMO，演示账号包含固定初始密码');
  seed();
}

// 平台超级管理员账号（跨租户运维；幂等）
if (!q.get(`SELECT id FROM users WHERE role = 'platform_super'`)) {
  const generatedPassword = crypto.randomBytes(18).toString('base64url');
  const superPassword = process.env.PLATFORM_SUPER_PASSWORD || (process.env.NODE_ENV === 'production' ? '' : generatedPassword);
  if (process.env.NODE_ENV === 'production') {
    const problem = platformSuperPasswordStrengthError(superPassword);
    if (problem) throw new Error(`生产环境首次启动时 PLATFORM_SUPER_PASSWORD ${problem}`);
  }
  q.run(`INSERT INTO users(username,password_hash,name,role,dept,status,tenant_id) VALUES(?,?,?,?,?, '启用', 1)`,
    process.env.PLATFORM_SUPER_USERNAME || 'super', hashPassword(superPassword), '平台超级管理员', 'platform_super', '平台运营');
  if (!process.env.PLATFORM_SUPER_PASSWORD) console.warn(`[security] 已创建开发超管账号 super，临时密码：${generatedPassword}（仅显示一次）`);
}

const app = express();
const trustProxy = String(process.env.TRUST_PROXY || 'loopback').trim();
app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
const allowedOrigins = new Set(String(process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    const localDev = process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
    callback(null, !origin || localDev || allowedOrigins.has(origin));
  },
}));
app.use(csrfOriginGuard({ allowedOrigins, production: process.env.NODE_ENV === 'production' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  next();
});
app.use(express.json({ limit: '32mb' }));

// 为长耗时 AI 请求提供统一追踪和取消：浏览器断开后立即终止上游调用，避免继续计费和占用连接。
app.use((req, res, next) => {
  const suppliedRequestId = String(req.get('X-Request-Id') || '');
  const requestId = /^[A-Za-z0-9._-]{1,100}$/.test(suppliedRequestId) ? suppliedRequestId : crypto.randomUUID();
  const startedAt = Date.now();
  const controller = new AbortController();
  let reported = false;
  req.requestId = requestId;
  req.requestSignal = controller.signal;
  res.setHeader('X-Request-Id', requestId);

  const cancelIfOpen = () => {
    if (!res.writableEnded && !controller.signal.aborted) controller.abort();
  };
  const report = () => {
    if (reported) return;
    reported = true;
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 2000 || res.statusCode >= 500 || controller.signal.aborted) {
      console.info('[request]', JSON.stringify({
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs,
        aborted: controller.signal.aborted,
      }));
    }
  };

  req.once('aborted', cancelIfOpen);
  res.once('finish', report);
  res.once('close', () => { cancelIfOpen(); report(); });
  next();
});

// 模块级访问守卫（PRD V2 §13：角色/用户→模块矩阵，前端隐藏+后端强校验双保险）
const MODULE_OF_PREFIX = {
  dashboard: 'dashboard', growth: 'growth', content: 'content', activities: 'activities',
  marshals: 'marshals', advisor: 'advisor', execution: 'execution', analysis: 'analysis', assets: 'assets', sys: 'system',
};
function moduleGuard(prefix) {
  return (req, res, next) => {
    const mod = MODULE_OF_PREFIX[prefix];
    if (!mod) return next();
    const allowed = modulesFor(req.user);
    if (!allowed.includes(mod)) return res.status(403).json({ error: '当前账号没有该模块权限，请联系企业老板或管理员在角色与权限中开通' });
    next();
  };
}

// 租户数据作用域：把当前请求的 tenant_id 注入 AsyncLocalStorage，使所有写入自动带租户、读取可按租户过滤
function tenantScope(req, res, next) { runWithTenant(req.user?.tenant_id || 1, () => next()); }

// BE-H3：昂贵 AI 生成接口的租户级令牌桶限流 + 全局并发信号量（默认每租户 20 次/分、全局并发 8；
// 可用 AI_TENANT_RATE_PER_MINUTE / AI_TENANT_BURST / AI_MAX_CONCURRENT 调整），超限 429 + Retry-After。
const aiGuard = createAiGuard();

// 租户态守卫（SaaS）：企业账号须「已开通」才能用业务模块；平台超管豁免
function tenantGate(req, res, next) {
  if (req.user.role === 'platform_super') return next();
  const t = getTenant(req.user.tenant_id || 1);
  if (!t || t.status !== '已开通') {
    return res.status(403).json({
      error: t?.status === '待审核' ? '企业账号正在审核中，开通后即可使用' : '企业账号已停用，请联系平台客服',
      tenantStatus: t?.status || '未知',
    });
  }
  next();
}

// 健康检查（运维监控/负载均衡探活用，不鉴权）
app.get('/api/health', (req, res) => {
  try {
    q.get('SELECT 1 AS ok');
    res.json({ ok: true, db: 'up', ts: new Date().toISOString() });
  } catch { res.status(503).json({ ok: false, db: 'down' }); }
});

// 公开日历订阅（飞书日历「订阅日历/导入」用，令牌鉴权，不走登录态）
app.get('/api/public/calendar.ics', (req, res) => {
  import('./engines/feishu.js').then(({ tenantByIcsToken, buildIcs }) => {
    // 公开路由无登录态：凭 key 反查所属租户，仅返回该企业的活动（杜绝跨租户泄露）
    const tid = tenantByIcsToken(req.query.key);
    if (!tid) return res.status(403).send('invalid token');
    const acts = q.all(`SELECT a.*, u.name owner FROM activities a LEFT JOIN users u ON u.id = a.owner_id
      WHERE a.tenant_id = ? AND a.date >= date('now','-30 day') AND a.plan_status = '已通过' ORDER BY a.date`, tid);
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="nanowork-activities.ics"');
    res.send(buildIcs(acts));
  }).catch(e => res.status(500).send(e.message));
});

app.get('/api/public/feishu/oauth/callback', (req, res) => {
  const esc = (s = '') => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  import('./engines/feishu.js').then(({ handleFeishuOAuthCallback }) =>
    handleFeishuOAuthCallback({ code: req.query.code, state: req.query.state }))
    .then((out) => {
      res.type('html').send(`<!doctype html><meta charset="utf-8"><title>飞书绑定成功</title>
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f8fb;margin:0;display:grid;place-items:center;min-height:100vh">
          <main style="background:#fff;border:1px solid #e8edf5;border-radius:14px;padding:28px 32px;text-align:center;box-shadow:0 18px 50px rgba(20,40,80,.12)">
            <div style="font-size:42px;color:#18a058">✓</div>
            <h2 style="margin:10px 0 8px;color:#17233d">飞书绑定成功</h2>
            <p style="margin:0;color:#5d6b82">已绑定：${esc(out.receiverName || '飞书用户')}</p>
            <p style="margin:12px 0 0;color:#8a94a6;font-size:13px">可以关闭这个页面，回到经营中台。</p>
          </main>
        </body>`);
    })
    .catch((e) => {
      res.status(400).type('html').send(`<!doctype html><meta charset="utf-8"><title>飞书绑定失败</title>
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f8fb;margin:0;display:grid;place-items:center;min-height:100vh">
          <main style="background:#fff;border:1px solid #ffe1e1;border-radius:14px;padding:28px 32px;text-align:center;box-shadow:0 18px 50px rgba(20,40,80,.12)">
            <div style="font-size:42px;color:#e5484d">×</div>
            <h2 style="margin:10px 0 8px;color:#17233d">飞书绑定失败</h2>
            <p style="margin:0;color:#5d6b82">${esc(e.message)}</p>
            <p style="margin:12px 0 0;color:#8a94a6;font-size:13px">请回到经营中台重新生成二维码。</p>
          </main>
        </body>`);
    });
});

app.use('/api/auth', authRoutes);
app.use('/api/platform', authMiddleware, platformRoutes);          // 平台超管（跨租户运维，内部 requireRole）
app.use('/api/recharge', authMiddleware, tenantScope, rechargeRoutes);          // 充值中心（登录即可，含余额/套餐/下单）
app.use('/api/meta', authMiddleware, tenantScope, metaRoutes);
app.use('/api/dashboard', authMiddleware, tenantScope, tenantGate, moduleGuard('dashboard'), dashboardRoutes);
app.use('/api/growth', authMiddleware, tenantScope, tenantGate, moduleGuard('growth'), growthRoutes);
app.use('/api/content', authMiddleware, tenantScope, tenantGate, moduleGuard('content'), mediaReviewRoutes, aiGuard('content'), contentRoutes);
app.use('/api/toolbox', authMiddleware, tenantScope, tenantGate, moduleGuard('content'), toolboxRoutes); // 安全模板，不占用昂贵AI限流
app.use('/api/activities', authMiddleware, tenantScope, tenantGate, moduleGuard('activities'), activityRoutes);
app.use('/api/marshals', authMiddleware, tenantScope, tenantGate, moduleGuard('marshals'), aiGuard('marshals'), marshalRoutes);
app.use('/api/employees', authMiddleware, tenantScope, tenantGate, moduleGuard('marshals'), employeeRoutes);
app.use('/api/employee-workbench/content', authMiddleware, tenantScope, tenantGate, moduleGuard('content'), aiGuard('contentWorkbench'), contentEmployeeWorkbenchRoutes);
app.use('/api/employee-workbench', authMiddleware, tenantScope, tenantGate, moduleGuard('marshals'), employeeWorkbenchRoutes);
app.use('/api/agents', authMiddleware, tenantScope, tenantGate, aiGuard('agents'), agentRoutes); // 自定义智能体（用户自建，3档）
app.use('/api/files', authMiddleware, tenantScope, tenantGate, fileRoutes); // 全局文件读取、产出档案与知识入档
app.use('/api/data-intake', authMiddleware, tenantScope, tenantGate, moduleGuard('system'), dataIntakeRoutes);
app.use('/api/advisor', authMiddleware, tenantScope, tenantGate, moduleGuard('advisor'), aiGuard('advisor'), advisorRoutes);
app.use('/api/execution', authMiddleware, tenantScope, tenantGate, moduleGuard('execution'), executionRoutes);
app.use('/api/analysis', authMiddleware, tenantScope, tenantGate, moduleGuard('analysis'), analysisRoutes);
app.use('/api/assets', authMiddleware, tenantScope, tenantGate, moduleGuard('assets'), assetRoutes);
app.use('/api/sys', authMiddleware, tenantScope, tenantGate, systemRoutes); // 含通知等通用能力，内部已按角色细分权限
app.use('/api/admin', authMiddleware, tenantScope, tenantGate, adminRoutes); // 企业管理后台（boss/admin）

// 附件必须先通过会话、租户和记录级权限校验；静态目录本身不再公开。
app.use('/uploads', authMiddleware, tenantScope, tenantGate, uploadAccessGuard,
  express.static(path.join(__dirname, '..', 'data', 'uploads'), {
    fallthrough: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }));

// 生产模式托管前端静态资源
const dist = path.join(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  // 登录页主视觉/配乐为固定文件名，禁用浏览器缓存避免换图后看到旧图（哈希资源仍长缓存）
  app.use(express.static(dist, { index: false, setHeaders: (res, p) => { if (/(?:login-portal|login-ambient|earth-night)\.\w+$/.test(p)) res.set('Cache-Control', 'no-cache'); } }));
  // index.html 彻底不缓存：用 res.send 直发内容（sendFile 会强加 max-age=0，导致浏览器一直拿旧页面/旧bundle）
  app.get(/^(?!\/api).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('html').send(fs.readFileSync(path.join(dist, 'index.html')));
  });
}

app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent || req.requestSignal?.aborted) return next(err);
  const requestedStatus = Number(err?.status);
  const status = requestedStatus >= 400 && requestedStatus < 600 ? requestedStatus : 500;
  res.status(status).json({
    error: status === 400 ? '请求内容格式错误' : status === 504 ? 'AI服务响应超时，请稍后重试' : '服务器内部错误',
    requestId: req.requestId,
  });
});

// 定时任务：逐租户运行并用数据库锁保证多实例下同一周期只执行一次。
const runSchedulerTick = () => {
  const summary = runScheduledJobs();
  for (const item of summary.results) {
    if (item.error) console.error(`[scheduler][tenant:${item.tenantId}]`, item.error);
  }
  summary.pending.then(outcomes => {
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        console.error('[scheduler][content-automation]', outcome.reason?.message || outcome.reason);
      }
    }
  }).catch(error => {
    console.error('[scheduler][content-automation]', error?.message || error);
  });
};
runSchedulerTick();
setInterval(runSchedulerTick, 30 * 1000).unref();

app.listen(PORT, HOST, () => {
  console.log(`[server] 纳米Work行业版 后端已启动: http://${HOST}:${PORT}`);
  console.log(`[server] AI模式: ${process.env.ANTHROPIC_API_KEY ? `Claude API (${process.env.AI_MODEL || 'claude-opus-4-8'})` : '本地模板引擎（设置 ANTHROPIC_API_KEY 可启用 Claude）'}`);
});

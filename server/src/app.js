import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { modulesFor, q, getTenant, runWithTenant } from './db.js';
import { authMiddleware, csrfOriginGuard } from './util.js';
import adminRoutes from './routes/admin.js';
import rechargeRoutes from './routes/recharge.js';
import rechargeNotifyRoutes from './routes/recharge-notify.js';
import platformRoutes from './routes/platform.js';
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
import storeDataRoutes from './routes/store-data.js';
import assetRoutes from './routes/assets.js';
import systemRoutes from './routes/system.js';
import agentRoutes from './routes/agents.js';
import fileRoutes from './routes/files.js';
import dataIntakeRoutes from './routes/dataintake.js';
import metaRoutes from './routes/meta.js';
import { uploadAccessGuard } from './engines/upload-access.js';
import { createAiGuard } from './ai-limits.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARDED_MODULES = new Set([
  'dashboard',
  'growth',
  'content',
  'activities',
  'marshals',
  'advisor',
  'execution',
  'analysis',
  'assets',
  'system',
]);

// 模块守卫直接接收真实模块 ID。未知 ID 在应用装配时即失败，不能静默放行。
export function moduleGuard(moduleId) {
  if (!GUARDED_MODULES.has(moduleId)) {
    throw new Error(`未知模块守卫：${moduleId}`);
  }
  return (req, res, next) => {
    const allowed = modulesFor(req.user);
    if (!allowed.includes(moduleId)) {
      return res.status(403).json({
        error: '当前账号没有该模块权限，请联系企业老板或管理员在角色与权限中开通',
      });
    }
    next();
  };
}

// 租户数据作用域：把当前请求的 tenant_id 注入 AsyncLocalStorage，使所有写入自动带租户、读取可按租户过滤。
export function tenantScope(req, _res, next) {
  runWithTenant(req.user?.tenant_id || 1, () => next());
}

// 租户态守卫（SaaS）：企业账号须「已开通」才能用业务模块；平台超管豁免。
export function tenantGate(req, res, next) {
  if (req.user.role === 'platform_super') return next();
  const tenant = getTenant(req.user.tenant_id || 1);
  if (!tenant || tenant.status !== '已开通') {
    return res.status(403).json({
      error: tenant?.status === '待审核'
        ? '企业账号正在审核中，开通后即可使用'
        : '企业账号已停用，请联系平台客服',
      tenantStatus: tenant?.status || '未知',
    });
  }
  next();
}

function requestLifecycle(req, res, next) {
  const suppliedRequestId = String(req.get('X-Request-Id') || '');
  const requestId = /^[A-Za-z0-9._-]{1,100}$/.test(suppliedRequestId)
    ? suppliedRequestId
    : crypto.randomUUID();
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
  res.once('close', () => {
    cancelIfOpen();
    report();
  });
  next();
}

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  );
  next();
}

function mountPublicRoutes(app) {
  app.get('/api/health', (_req, res) => {
    try {
      q.get('SELECT 1 AS ok');
      res.json({ ok: true, db: 'up', ts: new Date().toISOString() });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  // 公开日历订阅：凭独立令牌反查所属租户，不依赖登录态。
  app.get('/api/public/calendar.ics', (req, res) => {
    import('./engines/feishu.js').then(({ tenantByIcsToken, buildIcs }) => {
      const tenantId = tenantByIcsToken(req.query.key);
      if (!tenantId) return res.status(403).send('invalid token');
      const activities = q.all(`SELECT a.*, u.name owner FROM activities a LEFT JOIN users u ON u.id = a.owner_id
        WHERE a.tenant_id = ? AND a.date >= date('now','-30 day') AND a.plan_status = '已通过' ORDER BY a.date`, tenantId);
      res.set('Content-Type', 'text/calendar; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="nanowork-activities.ics"');
      res.send(buildIcs(activities));
    }).catch(error => res.status(500).send(error.message));
  });

  app.get('/api/public/feishu/oauth/callback', (req, res) => {
    const escapeHtml = (value = '') => String(value).replace(
      /[&<>"']/g,
      char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
    );
    import('./engines/feishu.js').then(({ handleFeishuOAuthCallback }) => (
      handleFeishuOAuthCallback({ code: req.query.code, state: req.query.state })
    )).then((output) => {
      res.type('html').send(`<!doctype html><meta charset="utf-8"><title>飞书绑定成功</title>
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f8fb;margin:0;display:grid;place-items:center;min-height:100vh">
          <main style="background:#fff;border:1px solid #e8edf5;border-radius:14px;padding:28px 32px;text-align:center;box-shadow:0 18px 50px rgba(20,40,80,.12)">
            <div style="font-size:42px;color:#18a058">✓</div>
            <h2 style="margin:10px 0 8px;color:#17233d">飞书绑定成功</h2>
            <p style="margin:0;color:#5d6b82">已绑定：${escapeHtml(output.receiverName || '飞书用户')}</p>
            <p style="margin:12px 0 0;color:#8a94a6;font-size:13px">可以关闭这个页面，回到经营中台。</p>
          </main>
        </body>`);
    }).catch((error) => {
      res.status(400).type('html').send(`<!doctype html><meta charset="utf-8"><title>飞书绑定失败</title>
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f8fb;margin:0;display:grid;place-items:center;min-height:100vh">
          <main style="background:#fff;border:1px solid #ffe1e1;border-radius:14px;padding:28px 32px;text-align:center;box-shadow:0 18px 50px rgba(20,40,80,.12)">
            <div style="font-size:42px;color:#e5484d">×</div>
            <h2 style="margin:10px 0 8px;color:#17233d">飞书绑定失败</h2>
            <p style="margin:0;color:#5d6b82">${escapeHtml(error.message)}</p>
            <p style="margin:12px 0 0;color:#8a94a6;font-size:13px">请回到经营中台重新生成二维码。</p>
          </main>
        </body>`);
    });
  });
}

export function createApp({
  aiGuardOptions,
  aiGuardFor,
  serveStatic = true,
} = {}) {
  const app = express();
  const guardFor = aiGuardFor || createAiGuard(aiGuardOptions);
  const trustProxy = String(process.env.TRUST_PROXY || 'loopback').trim();
  app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

  const allowedOrigins = new Set(
    String(process.env.CORS_ORIGINS || '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean),
  );
  app.use(cors({
    credentials: true,
    origin(origin, callback) {
      const localDevelopment = process.env.NODE_ENV !== 'production'
        && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
      callback(null, !origin || localDevelopment || allowedOrigins.has(origin));
    },
  }));
  app.use(csrfOriginGuard({
    allowedOrigins,
    production: process.env.NODE_ENV === 'production',
  }));
  app.use(securityHeaders);

  // 支付回调必须在全局 JSON 解析器之前挂载；微信验签依赖原始请求体。
  app.use('/api/recharge/notify', rechargeNotifyRoutes);
  app.use(express.json({ limit: '32mb' }));
  app.use(requestLifecycle);

  mountPublicRoutes(app);

  app.use('/api/auth', authRoutes);
  app.use('/api/platform', authMiddleware, platformRoutes);
  app.use('/api/recharge', authMiddleware, tenantScope, rechargeRoutes);
  app.use('/api/meta', authMiddleware, tenantScope, metaRoutes);
  app.use('/api/dashboard', authMiddleware, tenantScope, tenantGate, moduleGuard('dashboard'), dashboardRoutes);
  app.use('/api/growth', authMiddleware, tenantScope, tenantGate, moduleGuard('growth'), guardFor('growth'), growthRoutes);
  app.use('/api/content', authMiddleware, tenantScope, tenantGate, moduleGuard('content'), mediaReviewRoutes, guardFor('content'), contentRoutes);
  app.use('/api/toolbox', authMiddleware, tenantScope, tenantGate, moduleGuard('content'), guardFor('toolbox'), toolboxRoutes);
  app.use('/api/activities', authMiddleware, tenantScope, tenantGate, moduleGuard('activities'), guardFor('activities'), activityRoutes);
  app.use('/api/marshals', authMiddleware, tenantScope, tenantGate, moduleGuard('marshals'), guardFor('marshals'), marshalRoutes);
  app.use('/api/employees', authMiddleware, tenantScope, tenantGate, moduleGuard('marshals'), employeeRoutes);
  app.use('/api/employee-workbench/content', authMiddleware, tenantScope, tenantGate, moduleGuard('content'), guardFor('contentWorkbench'), contentEmployeeWorkbenchRoutes);
  app.use('/api/employee-workbench', authMiddleware, tenantScope, tenantGate, moduleGuard('marshals'), guardFor('employeeWorkbench'), employeeWorkbenchRoutes);
  app.use('/api/agents', authMiddleware, tenantScope, tenantGate, guardFor('agents'), agentRoutes);
  app.use('/api/files', authMiddleware, tenantScope, tenantGate, guardFor('files'), fileRoutes);
  app.use('/api/data-intake', authMiddleware, tenantScope, tenantGate, moduleGuard('system'), dataIntakeRoutes);
  app.use('/api/advisor', authMiddleware, tenantScope, tenantGate, moduleGuard('advisor'), guardFor('advisor'), advisorRoutes);
  app.use('/api/execution', authMiddleware, tenantScope, tenantGate, moduleGuard('execution'), executionRoutes);
  app.use('/api/analysis', authMiddleware, tenantScope, tenantGate, moduleGuard('analysis'), analysisRoutes);
  app.use('/api/store-data', authMiddleware, tenantScope, tenantGate, moduleGuard('analysis'), storeDataRoutes);
  app.use('/api/assets', authMiddleware, tenantScope, tenantGate, moduleGuard('assets'), assetRoutes);
  app.use('/api/sys', authMiddleware, tenantScope, tenantGate, guardFor('system'), systemRoutes);
  app.use('/api/admin', authMiddleware, tenantScope, tenantGate, adminRoutes);

  app.use(
    '/uploads',
    authMiddleware,
    tenantScope,
    tenantGate,
    uploadAccessGuard,
    express.static(path.join(__dirname, '..', 'data', 'uploads'), {
      fallthrough: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    }),
  );

  const dist = path.join(__dirname, '..', '..', 'web', 'dist');
  if (serveStatic && fs.existsSync(dist)) {
    app.use(express.static(dist, {
      index: false,
      setHeaders: (res, filePath) => {
        if (/(?:login-portal|login-ambient|earth-night)\.\w+$/.test(filePath)) {
          res.set('Cache-Control', 'no-cache');
        }
      },
    }));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.type('html').send(fs.readFileSync(path.join(dist, 'index.html')));
    });
  }

  app.use((error, req, res, next) => {
    console.error('[error]', error);
    if (res.headersSent || req.requestSignal?.aborted) return next(error);
    const requestedStatus = Number(error?.status);
    const status = requestedStatus >= 400 && requestedStatus < 600
      ? requestedStatus
      : 500;
    res.status(status).json({
      error: status === 400
        ? '请求内容格式错误'
        : status === 504
          ? 'AI服务响应超时，请稍后重试'
          : '服务器内部错误',
      requestId: req.requestId,
    });
  });

  return app;
}

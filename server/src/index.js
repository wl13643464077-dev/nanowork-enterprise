import './env.js';
import crypto from 'node:crypto';
import { initSchema, migrateV2, q } from './db.js';
import { seed } from './seed.js';
import { ensureBaselineCatalogs } from './baseline.js';
import { hashPassword } from './util.js';
import { platformSuperPasswordStrengthError } from './security-config.js';
import {
  recoverStaleAiWorkAcrossTenants,
  runScheduledJobs,
  startSchedulerIfEnabled,
} from './engines/scheduler.js';
import { aiChannel } from './engines/ai.js';
import { recoverStaleEmbeddingHolds } from './engines/rag.js';
import { createApp } from './app.js';

const PORT = process.env.PORT || 3107;
const HOST = process.env.HOST || '127.0.0.1';

initSchema();
migrateV2();
ensureBaselineCatalogs();
if (process.env.SEED_DEMO === 'true') {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('生产环境禁止启用 SEED_DEMO，演示账号包含固定初始密码');
  }
  seed();
}

// 平台超级管理员账号（跨租户运维；幂等）。
if (!q.get(`SELECT id FROM users WHERE role = 'platform_super'`)) {
  const generatedPassword = crypto.randomBytes(18).toString('base64url');
  const superPassword = process.env.PLATFORM_SUPER_PASSWORD
    || (process.env.NODE_ENV === 'production' ? '' : generatedPassword);
  if (process.env.NODE_ENV === 'production') {
    const problem = platformSuperPasswordStrengthError(superPassword);
    if (problem) {
      throw new Error(`生产环境首次启动时 PLATFORM_SUPER_PASSWORD ${problem}`);
    }
  }
  q.run(
    `INSERT INTO users(username,password_hash,name,role,dept,status,tenant_id)
     VALUES(?,?,?,?,?, '启用', 1)`,
    process.env.PLATFORM_SUPER_USERNAME || 'super',
    hashPassword(superPassword),
    '平台超级管理员',
    'platform_super',
    '平台运营',
  );
  if (!process.env.PLATFORM_SUPER_PASSWORD) {
    console.warn(`[security] 已创建开发超管账号 super，临时密码：${generatedPassword}（仅显示一次）`);
  }
}

// HTTP 装配可被集成测试复用；数据库初始化、恢复、调度和监听仍只属于运行入口。
const app = createApp();

// 崩溃恢复只处理本地超时状态与冻结占扣，不调用任何外部供应商；
// 即使自动任务总开关关闭也要执行。
for (const recovered of recoverStaleAiWorkAcrossTenants()) {
  if (recovered.error) {
    console.error(`[recovery][tenant:${recovered.tenantId}]`, recovered.error);
  } else if (
    recovered.contentAutomation.length
    || recovered.contentEmployeeRuns.length
    || recovered.agentTasks.length
    || recovered.mediaJobs.length
  ) {
    const mediaRecovered = recovered.mediaJobs.filter(
      item => item.action !== 'continue_provider_polling',
    ).length;
    console.info(
      `[recovery][tenant:${recovered.tenantId}] 内容自动化恢复${recovered.contentAutomation.length}条，内容员工运行恢复${recovered.contentEmployeeRuns.length}条，数字员工任务恢复${recovered.agentTasks.length}条，媒体任务恢复${mediaRecovered}条`,
    );
  }
}

const recoveredEmbeddings = recoverStaleEmbeddingHolds();
if (recoveredEmbeddings.length) {
  const released = recoveredEmbeddings.filter(item => item.action === 'released').length;
  const settled = recoveredEmbeddings.filter(item => item.action === 'settled').length;
  const pending = recoveredEmbeddings.length - released - settled;
  console.info(
    `[recovery][kb-embedding] 释放${released}条，按已交付结算${settled}条，待对账${pending}条`,
  );
}

// 定时任务：逐租户运行并用数据库锁保证多实例下同一周期只执行一次。
const runSchedulerTick = () => {
  const summary = runScheduledJobs();
  for (const item of summary.results) {
    if (item.error) console.error(`[scheduler][tenant:${item.tenantId}]`, item.error);
  }
  return summary.pending.then((outcomes) => {
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        console.error(
          '[scheduler][content-automation]',
          outcome.reason?.message || outcome.reason,
        );
      }
    }
  }).catch((error) => {
    console.error('[scheduler][content-automation]', error?.message || error);
  });
};
startSchedulerIfEnabled({ runTick: runSchedulerTick });

app.listen(PORT, HOST, () => {
  console.log(`[server] 纳米Work行业版 后端已启动: http://${HOST}:${PORT}`);
  const channel = aiChannel();
  const label = channel === 'yunwu'
    ? '云雾 API（按岗位与角色模型路由）'
    : channel === 'claude'
      ? `Claude API (${process.env.AI_MODEL || 'claude-opus-4-8'})`
      : '本地模板底稿模式（未配置真实 AI 通道）';
  console.log(`[server] AI模式: ${label}`);
});

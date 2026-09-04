import { db, q, curTenant, getConfig, runWithTenant, setTenantConfig } from '../db.js';
import { acquireBackgroundAiLease } from '../ai-limits.js';
import { holdCredits, releaseHold, settleHold } from './credits.js';
import { embed } from './yunwu.js';

const positiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function backgroundEmbeddingsEnabled(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(
    String(env?.ENABLE_BACKGROUND_EMBEDDINGS || '').trim(),
  );
}

export function backgroundEmbeddingMaxCalls(env = process.env) {
  return Math.min(16, positiveInt(env?.BACKGROUND_EMBED_MAX_CALLS_PER_DOC, 8));
}

const backgroundEmbeddingCreditsPerCall = (env = process.env) => (
  Math.min(100, positiveInt(env?.BACKGROUND_EMBED_CREDITS_PER_CALL, 1))
);

const backgroundEmbeddingJobTimeoutMs = (env = process.env) => {
  const parsed = positiveInt(env?.BACKGROUND_EMBED_JOB_TIMEOUT_MS, 60_000);
  return Math.min(5 * 60_000, Math.max(5_000, parsed));
};

// 文档保存后的向量化属于真实外部费用，不能无限制 fire-and-forget。
// 队列同时限制全局等待数、单租户等待数和单租户活跃数；是否启用由显式
// 环境开关决定，默认关闭。未传 tenantId 的旧调用仍可工作，但只受全局护栏。
export function createEmbeddingQueue({
  maxConcurrent = positiveInt(process.env.BACKGROUND_EMBED_MAX_CONCURRENT, 2),
  maxQueued = positiveInt(process.env.BACKGROUND_EMBED_MAX_QUEUED, 100),
  maxTenantPending = positiveInt(process.env.BACKGROUND_EMBED_MAX_TENANT_PENDING, 20),
  maxTenantActive = positiveInt(process.env.BACKGROUND_EMBED_MAX_TENANT_ACTIVE, 1),
  schedule = queueMicrotask,
  acquireLease = () => ({ release() {} }),
  retrySchedule = (callback, delay) => setTimeout(callback, delay),
  leaseRetryMs = 25,
  maxWaitMs = positiveInt(process.env.BACKGROUND_EMBED_QUEUE_WAIT_TIMEOUT_MS, 120_000),
} = {}) {
  const concurrencyLimit = positiveInt(maxConcurrent, 2);
  const queueLimit = positiveInt(maxQueued, 100);
  const tenantPendingLimit = Math.min(
    positiveInt(maxTenantPending, 20),
    queueLimit,
  );
  const tenantActiveLimit = Math.min(
    positiveInt(maxTenantActive, 1),
    concurrencyLimit,
  );
  const queueWaitLimit = positiveInt(maxWaitMs, 120_000);
  const legacyTenant = Symbol('legacy-embedding-queue-tenant');
  const pending = [];
  const pendingByTenant = new Map();
  const activeByTenant = new Map();
  let active = 0;
  let leaseRetryHandle = null;

  const increment = (counts, tenantKey) => {
    counts.set(tenantKey, (counts.get(tenantKey) || 0) + 1);
  };

  const decrement = (counts, tenantKey) => {
    const next = (counts.get(tenantKey) || 0) - 1;
    if (next > 0) counts.set(tenantKey, next);
    else counts.delete(tenantKey);
  };

  const activeLimitFor = tenantKey => (
    tenantKey === legacyTenant ? concurrencyLimit : tenantActiveLimit
  );

  // 不是简单 shift：若队首租户已达到 active 上限，继续扫描，让其他租户
  // 使用空闲槽位，避免批量导入的单一租户阻塞后续租户。
  const nextEligibleIndex = () => pending.findIndex(entry => (
    (activeByTenant.get(entry.tenantKey) || 0) < activeLimitFor(entry.tenantKey)
  ));

  const retryWhenLeaseAvailable = () => {
    if (leaseRetryHandle || !pending.length) return;
    leaseRetryHandle = retrySchedule(() => {
      leaseRetryHandle = null;
      pump();
    }, Math.max(5, Number(leaseRetryMs) || 25));
  };

  const pump = () => {
    const now = Date.now();
    for (let index = pending.length - 1; index >= 0; index--) {
      const entry = pending[index];
      if (now - entry.enqueuedAt < queueWaitLimit) continue;
      pending.splice(index, 1);
      decrement(pendingByTenant, entry.tenantKey);
      entry.complete({
        ok: false,
        reason: 'lease_wait_timeout',
        error: Object.assign(new Error('后台 AI 并发租约等待超时'), { status: 503 }),
      });
    }
    while (active < concurrencyLimit && pending.length) {
      const index = nextEligibleIndex();
      if (index < 0) {
        retryWhenLeaseAvailable();
        return;
      }
      const entry = pending[index];
      let lease;
      try {
        lease = acquireLease({
          kind: 'background_embedding',
          tenantId: entry.tenantId,
        });
      } catch {
        retryWhenLeaseAvailable();
        return;
      }
      if (!lease) {
        retryWhenLeaseAvailable();
        return;
      }
      pending.splice(index, 1);
      decrement(pendingByTenant, entry.tenantKey);
      active += 1;
      increment(activeByTenant, entry.tenantKey);
      const releaseLease = typeof lease === 'function' ? lease : lease.release?.bind(lease);
      const finish = () => {
        try { releaseLease?.(); } finally {
          active -= 1;
          decrement(activeByTenant, entry.tenantKey);
          pump();
        }
      };
      try {
        schedule(() => {
          Promise.resolve()
            .then(entry.job)
            .then(
              value => entry.complete({ ok: true, value }),
              error => entry.complete({ ok: false, error }),
            )
            .finally(finish);
        });
      } catch (error) {
        entry.complete({ ok: false, error });
        finish();
      }
    }
    if (pending.length) retryWhenLeaseAvailable();
  };

  const tenantKeyFor = tenantId => (
    tenantId === undefined || tenantId === null || tenantId === ''
      ? legacyTenant
      : String(tenantId)
  );

  const snapshot = () => {
    const tenantKeys = new Set([...pendingByTenant.keys(), ...activeByTenant.keys()]);
    const tenants = {};
    for (const tenantKey of tenantKeys) {
      const label = tenantKey === legacyTenant ? '__legacy__' : tenantKey;
      tenants[label] = {
        queued: pendingByTenant.get(tenantKey) || 0,
        active: activeByTenant.get(tenantKey) || 0,
      };
    }
    return {
      queued: pending.length,
      active,
      maxConcurrent: concurrencyLimit,
      maxQueued: queueLimit,
      maxTenantPending: tenantPendingLimit,
      maxTenantActive: tenantActiveLimit,
      tenants,
    };
  };

  return {
    enqueue(job, options = {}) {
      if (typeof job !== 'function') throw new TypeError('embedding job must be a function');
      // 兼容 enqueue(job, tenantId) 和 enqueue(job, { tenantId })，旧的
      // enqueue(job) 归为 __legacy__，不意外破坏已有调用。
      const tenantId = options && typeof options === 'object'
        ? options.tenantId
        : options;
      const tenantKey = tenantKeyFor(tenantId);
      const tenantQueued = pendingByTenant.get(tenantKey) || 0;
      if (tenantKey !== legacyTenant && tenantQueued >= tenantPendingLimit) {
        return {
          accepted: false,
          reason: 'tenant_queue_full',
          queued: pending.length,
          active,
          tenantQueued,
          tenantActive: activeByTenant.get(tenantKey) || 0,
        };
      }
      if (pending.length >= queueLimit) {
        return {
          accepted: false,
          reason: 'global_queue_full',
          queued: pending.length,
          active,
          tenantQueued,
          tenantActive: activeByTenant.get(tenantKey) || 0,
        };
      }
      let complete;
      const completion = new Promise(resolve => { complete = resolve; });
      pending.push({
        job,
        tenantId,
        tenantKey,
        complete,
        enqueuedAt: Date.now(),
      });
      increment(pendingByTenant, tenantKey);
      pump();
      return {
        accepted: true,
        queued: pending.length,
        active,
        tenantQueued: pendingByTenant.get(tenantKey) || 0,
        tenantActive: activeByTenant.get(tenantKey) || 0,
        completion,
      };
    },
    stats() {
      return snapshot();
    },
  };
}

const backgroundEmbeddingQueue = createEmbeddingQueue({
  acquireLease: acquireBackgroundAiLease,
});

// ===== AI-C2 引用溯源：AI 答案落库时记录引用了哪些知识文档 =====
// 会诊消息 / 员工对话 / 内容生产仓产出保存后，把本次检索实际注入 prompt 的 doc id/标题/相似度写入
// kb_citations，随时能回答"这条答案依据哪份资料"，降级检索（热度排序）也如实标记。
let citationTableReady = false;
function ensureCitationTable() {
  // 表的首次创建可能发生在调用方业务事务中；若该事务随后回滚，SQLite 会连同
  // CREATE TABLE 一起回滚，但进程内布尔值不会自动复原。每次命中缓存时仍核验
  // sqlite_master，避免后续请求因“缓存说已建、数据库实际不存在”而连续失败。
  if (citationTableReady
    && db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='kb_citations'`).get()) return;
  db.exec(`
  CREATE TABLE IF NOT EXISTS kb_citations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    target_type TEXT NOT NULL,      -- ai_message / marshal_chat_msg / custom_agent_msg / content
    target_id INTEGER NOT NULL,
    doc_id INTEGER NOT NULL,
    doc_title TEXT, doc_category TEXT,
    similarity REAL,                -- 语义召回时的余弦相似度；热度降级时为 NULL
    rag_mode TEXT,                  -- semantic=向量召回 / hot=热度排序降级
    degraded INTEGER DEFAULT 0,     -- 1=本次检索发生过降级（embedding 失败/库未向量化）
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_kb_citations_target ON kb_citations(tenant_id, target_type, target_id);
  `);
  citationTableReady = true;
}

// kb = kbSearch() 返回的 { refs, degraded, mode }；refs 为空时不落行（答案未依据知识库）
export function recordKbCitations({ targetType, targetId, kb }) {
  const refs = kb?.refs || [];
  if (!targetType || !targetId || !refs.length) return 0;
  ensureCitationTable();
  const insert = db.prepare(`INSERT INTO kb_citations(tenant_id,target_type,target_id,doc_id,doc_title,doc_category,similarity,rag_mode,degraded)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const ref of refs) {
    insert.run(curTenant(), targetType, targetId, ref.id, ref.title || null, ref.category || null,
      ref.sim ?? null, kb.mode || null, kb.degraded ? 1 : 0);
  }
  return refs.length;
}

export function citationsFor(targetType, targetId) {
  ensureCitationTable();
  return q.all(`SELECT doc_id, doc_title, doc_category, similarity, rag_mode, degraded FROM kb_citations
    WHERE tenant_id = ? AND target_type = ? AND target_id = ? ORDER BY id`, curTenant(), targetType, targetId);
}

// 文档切块：段落优先聚合到 ~size 字，超长段落硬切；块间带 overlap 字重叠保持上下文连续
export function chunkText(body, { size = 600, overlap = 80, maxChunks = 40 } = {}) {
  const text = String(body || '').trim();
  if (!text) return [];
  if (text.length <= size + 100) return [text]; // 短文不切
  const paras = text.split(/\n{2,}|\r\n{2,}/).flatMap(p => {
    // 超长段落按句子再切
    if (p.length <= size) return [p];
    const sentences = p.split(/(?<=[。！？!?；;])/);
    const parts = [];
    let cur = '';
    for (const s of sentences) {
      if (cur.length + s.length > size && cur) { parts.push(cur); cur = s; }
      else cur += s;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  }).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (cur.length + p.length + 1 > size && cur) {
      chunks.push(cur);
      cur = `${cur.slice(-overlap)}\n${p}`; // 携带上一块尾部做重叠
    } else {
      cur = cur ? `${cur}\n${p}` : p;
    }
    if (chunks.length >= maxChunks) break;
  }
  if (cur.trim() && chunks.length < maxChunks) chunks.push(cur);
  return chunks;
}

function liveDoc(id, tenantId, title, body) {
  return q.get(`SELECT id FROM kb_docs
    WHERE tenant_id=? AND id=? AND title IS ? AND body IS ?`,
  tenantId, id, title ?? null, body ?? null);
}

let embeddingJobTableReady = false;
function ensureEmbeddingJobTable() {
  if (embeddingJobTableReady
    && db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='kb_embedding_jobs'`).get()) return;
  const exists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='kb_embedding_jobs'`,
  ).get();
  if (!exists) throw new Error('kb_embedding_jobs 尚未由中央数据库 schema 初始化');
  embeddingJobTableReady = true;
}

const BLOCKING_EMBEDDING_JOB_STATUSES = Object.freeze([
  'preparing',
  'queued',
  'running',
  'pending_reconciliation',
]);

const hasStoredVectorSql = alias => `(
  (${alias}.embedding IS NOT NULL AND trim(${alias}.embedding)<>'')
  OR EXISTS(
    SELECT 1 FROM kb_chunks c
    WHERE c.doc_id=${alias}.id AND c.embedding IS NOT NULL AND trim(c.embedding)<>''
  )
)`;

// 文档“已启用”和“可做语义召回”是两件事。这个快照只读取计数与任务状态，
// 不读取或返回知识正文，供管理页准确解释为什么 RAG 没有注入资料。
export function kbVectorReadiness({
  tenantId = curTenant(),
  env = process.env,
} = {}) {
  ensureEmbeddingJobTable();
  const tid = Number(tenantId);
  const storedVector = hasStoredVectorSql('d');
  const coverage = db.prepare(`SELECT
      COUNT(*) enabled_docs,
      SUM(CASE WHEN ${storedVector} THEN 1 ELSE 0 END) vectorized_docs,
      SUM(CASE WHEN NOT ${storedVector} THEN 1 ELSE 0 END) missing_docs
    FROM kb_docs d
    WHERE d.tenant_id=? AND d.enabled=1`).get(tid) || {};
  const jobs = db.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN j.status IN ('preparing','queued','running') THEN j.doc_id END) active_docs,
      SUM(CASE WHEN j.status IN ('preparing','queued','running') THEN 1 ELSE 0 END) active_jobs,
      COUNT(DISTINCT CASE WHEN j.status='pending_reconciliation' THEN j.doc_id END) reconciliation_docs,
      SUM(CASE WHEN j.status='pending_reconciliation' THEN 1 ELSE 0 END) reconciliation_jobs,
      COUNT(DISTINCT CASE WHEN j.status IN ('preparing','queued','running','pending_reconciliation') THEN j.doc_id END) blocked_docs
    FROM kb_embedding_jobs j
    JOIN kb_docs d ON d.id=j.doc_id AND d.tenant_id=j.tenant_id
    WHERE j.tenant_id=? AND d.enabled=1 AND NOT ${storedVector}`).get(tid) || {};
  const enabledDocs = Number(coverage.enabled_docs || 0);
  const vectorizedDocs = Number(coverage.vectorized_docs || 0);
  const missingDocs = Number(coverage.missing_docs || 0);
  const activeDocs = Number(jobs.active_docs || 0);
  const activeJobs = Number(jobs.active_jobs || 0);
  const reconciliationDocs = Number(jobs.reconciliation_docs || 0);
  const reconciliationJobs = Number(jobs.reconciliation_jobs || 0);
  const blockedDocs = Math.min(missingDocs, Number(jobs.blocked_docs || 0));
  const availableForBackfill = Math.max(0, missingDocs - blockedDocs);
  const backgroundEnabled = backgroundEmbeddingsEnabled(env);

  let state = 'needs_backfill';
  let message = `有 ${missingDocs} 条已启用知识尚未生成语义向量`;
  if (enabledDocs === 0) {
    state = 'empty';
    message = '暂无已启用知识，先上传、录入或初始化知识库';
  } else if (missingDocs === 0) {
    state = 'ready';
    message = `已启用知识的语义向量已全部就绪（${vectorizedDocs}/${enabledDocs}）`;
  } else if (!backgroundEnabled) {
    state = 'disabled';
    message = `后台向量化开关未启用，${missingDocs} 条知识只完成入库、尚不能参与语义召回`;
  } else if (reconciliationJobs > 0) {
    state = 'billing_attention';
    message = `${reconciliationJobs} 个向量任务待账务对账，相关知识暂不重复回填`;
  } else if (activeJobs > 0) {
    state = 'processing';
    message = `${activeJobs} 个向量任务处理中，仍有 ${missingDocs} 条知识尚未就绪`;
  }

  return {
    state,
    message,
    backgroundEnabled,
    enabledDocs,
    vectorizedDocs,
    missingDocs,
    percent: enabledDocs > 0 ? Math.round(vectorizedDocs / enabledDocs * 100) : 0,
    activeDocs,
    activeJobs,
    reconciliationDocs,
    reconciliationJobs,
    availableForBackfill,
    canBackfill: backgroundEnabled && availableForBackfill > 0,
  };
}

function updateEmbeddingJob(tenantId, jobId, fields = {}) {
  if (!tenantId || !jobId) return;
  const allowed = new Set([
    'hold_id',
    'status',
    'attempted_calls',
    'persisted_calls',
    'last_error',
    'started_at',
    'finished_at',
  ]);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (!entries.length) return;
  db.prepare(`UPDATE kb_embedding_jobs SET ${entries.map(([key]) => `${key}=?`).join(',')}
    WHERE tenant_id=? AND id=?`).run(
    ...entries.map(([, value]) => value),
    tenantId,
    jobId,
  );
}

export function buildEmbeddingPlan(title, body, {
  maxCalls = backgroundEmbeddingMaxCalls(),
} = {}) {
  const callLimit = Math.min(16, positiveInt(maxCalls, 8));
  const mainText = `${title || ''}\n${String(body || '').slice(0, 4000)}`.trim();
  if (!mainText) return { mainText: '', chunks: [], callCount: 0 };
  const possibleChunks = callLimit > 1
    ? chunkText(body, { maxChunks: callLimit - 1 })
    : [];
  // 短文返回一个等同整文的块，不重复调用；长文才增加块向量。
  const chunks = possibleChunks.length > 1 ? possibleChunks : [];
  return {
    mainText,
    chunks,
    callCount: 1 + chunks.length,
  };
}

// 每次落库都再次确认文档正文没有变化。progress 是后台结算依据：只有真正
// 持久化成功的向量才计入实扣；上游失败后立即停止，不继续扇出剩余分块。
async function persistEmbeddingPlan({
  id,
  title,
  body,
  tenantId,
  plan,
  progress,
  embedFn = embed,
  signal,
  jobId = null,
}) {
  if (!liveDoc(id, tenantId, title, body)) return;
  progress.attemptedCalls += 1;
  updateEmbeddingJob(tenantId, jobId, { attempted_calls: progress.attemptedCalls });
  const mainVector = await embedFn(plan.mainText, undefined, signal);
  if (!mainVector) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const updated = q.run(`UPDATE kb_docs SET embedding=?
      WHERE tenant_id=? AND id=? AND title IS ? AND body IS ?`,
    JSON.stringify(mainVector), tenantId, id, title ?? null, body ?? null);
    if (!updated.changes) {
      db.exec('COMMIT');
      return;
    }
    progress.persistedCalls += 1;
    q.run(`DELETE FROM kb_chunks
      WHERE doc_id=? AND EXISTS(
        SELECT 1 FROM kb_docs WHERE tenant_id=? AND id=? AND title IS ? AND body IS ?
      )`, id, tenantId, id, title ?? null, body ?? null);
    updateEmbeddingJob(tenantId, jobId, {
      persisted_calls: progress.persistedCalls,
      attempted_calls: progress.attemptedCalls,
    });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  for (let i = 0; i < plan.chunks.length; i++) {
    if (signal?.aborted) throw Object.assign(new Error('后台向量任务已超时'), { status: 504 });
    progress.attemptedCalls += 1;
    updateEmbeddingJob(tenantId, jobId, { attempted_calls: progress.attemptedCalls });
    const vector = await embedFn(`${title || ''}\n${plan.chunks[i]}`, undefined, signal);
    if (!vector) break;
    db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = q.run(`INSERT INTO kb_chunks(doc_id,seq,text,embedding)
        SELECT ?,?,?,?
        WHERE EXISTS(
          SELECT 1 FROM kb_docs WHERE tenant_id=? AND id=? AND title IS ? AND body IS ?
        )`,
      id, i, plan.chunks[i], JSON.stringify(vector),
      tenantId, id, title ?? null, body ?? null);
      if (!inserted.changes) {
        db.exec('COMMIT');
        break;
      }
      progress.persistedCalls += 1;
      updateEmbeddingJob(tenantId, jobId, {
        persisted_calls: progress.persistedCalls,
        attempted_calls: progress.attemptedCalls,
      });
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
}

function settleEmbeddingLifecycle({
  hold,
  progress,
  creditsPerCall,
  model,
  error = null,
}) {
  const actualCredits = progress.persistedCalls * creditsPerCall;
  try {
    const settled = actualCredits > 0
      ? settleHold(hold, {
        credits: actualCredits,
        model,
        note: `知识库后台向量化完成：计划${hold.plannedCalls}次，实际持久化${progress.persistedCalls}次`,
      })
      : releaseHold(
        hold,
        `知识库后台向量化未形成可用向量${error ? `（${String(error.message || error).slice(0, 80)}）` : ''}，预授权全额退回`,
      );
    return {
      state: actualCredits > 0 ? 'settled' : 'released',
      heldCredits: hold.credits,
      chargedCredits: settled?.credits ?? actualCredits,
      balance: settled?.balance ?? hold.balance,
    };
  } catch (billingError) {
    return {
      state: 'pending_reconciliation',
      heldCredits: hold.credits,
      chargedCredits: null,
      balance: hold.balance,
      note: `向量任务终态已确定，但结算失败：${String(billingError.message || billingError).slice(0, 100)}`,
    };
  }
}

async function executeEmbeddingLifecycle({
  id,
  title,
  body,
  tenantId,
  plan,
  hold,
  creditsPerCall,
  model,
  jobId,
  embedFn = embed,
  timeoutMs = backgroundEmbeddingJobTimeoutMs(),
}) {
  const progress = { attemptedCalls: 0, persistedCalls: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let error = null;
  updateEmbeddingJob(tenantId, jobId, {
    status: 'running',
    started_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  });
  try {
    await persistEmbeddingPlan({
      id, title, body, tenantId, plan, progress, embedFn, signal: controller.signal, jobId,
    });
  } catch (caught) {
    error = caught;
  } finally {
    clearTimeout(timer);
  }
  const billing = settleEmbeddingLifecycle({
    hold, progress, creditsPerCall, model, error,
  });
  updateEmbeddingJob(tenantId, jobId, {
    status: billing.state,
    attempted_calls: progress.attemptedCalls,
    persisted_calls: progress.persistedCalls,
    last_error: error ? String(error.message || error).slice(0, 500) : null,
    finished_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  });
  return {
    ...progress,
    error: error ? String(error.message || error).slice(0, 160) : null,
    billing,
  };
}

// 给某知识库文档异步生成并写入向量。兼容旧的三个位置参数；第四参数可传
// userId 做流水归因。未传用户时按显式 tenantId 在租户层占额，避免系统任务漏计费。
export function embedDoc(id, title, body, options = {}) {
  const plan = buildEmbeddingPlan(title, body);
  if (!plan.mainText || !backgroundEmbeddingsEnabled()) {
    return { accepted: false, reason: !plan.mainText ? 'empty' : 'disabled' };
  }
  const tenantId = curTenant();
  // 内容生成等调用点可能仍在业务事务内。占额会自行开启原子事务，必须等外层
  // 提交后再开始；若外层回滚，延迟任务会因 stale_document 安全退出且不占额。
  if (db.isTransaction) {
    const completion = new Promise(resolve => {
      setImmediate(() => {
        try {
          const deferred = runWithTenant(
            tenantId,
            () => embedDoc(id, title, body, options),
          );
          if (deferred?.completion) deferred.completion.then(resolve);
          else resolve(deferred);
        } catch (error) {
          resolve({
            accepted: false,
            reason: 'deferred_start_failed',
            error: String(error.message || error).slice(0, 160),
          });
        }
      });
    });
    return {
      accepted: true,
      deferred: true,
      reason: 'after_business_transaction',
      callsPlanned: plan.callCount,
      completion,
    };
  }
  if (!liveDoc(id, tenantId, title, body)) {
    return { accepted: false, reason: 'stale_document' };
  }
  const creditsPerCall = backgroundEmbeddingCreditsPerCall();
  const model = getConfig('embed_model', null) || 'text-embedding-3-small';
  ensureEmbeddingJobTable();
  const jobId = Number(db.prepare(`INSERT INTO kb_embedding_jobs(
    tenant_id,doc_id,status,planned_calls,credits_per_call
  ) VALUES(?,?,'preparing',?,?)`).run(
    tenantId,
    Number(id),
    plan.callCount,
    creditsPerCall,
  ).lastInsertRowid);
  let hold;
  try {
    hold = holdCredits({
      tenantId,
      userId: options?.userId ?? null,
      feature: '知识库后台向量化',
      kind: 'text',
      model,
      credits: plan.callCount * creditsPerCall,
      refType: 'kb_embedding',
      refId: jobId,
      note: `单文档最多${backgroundEmbeddingMaxCalls()}次；本次计划${plan.callCount}次`,
    });
    hold.plannedCalls = plan.callCount;
    updateEmbeddingJob(tenantId, jobId, {
      hold_id: hold.holdId,
      status: 'queued',
    });
  } catch (error) {
    updateEmbeddingJob(tenantId, jobId, {
      status: 'rejected',
      last_error: String(error.message || error).slice(0, 500),
      finished_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    });
    return {
      accepted: false,
      reason: 'billing_hold_failed',
      status: error.status || 500,
      error: String(error.message || error).slice(0, 160),
    };
  }

  const queued = backgroundEmbeddingQueue.enqueue(() => executeEmbeddingLifecycle({
    id,
    title,
    body,
    tenantId,
    plan,
    hold,
    creditsPerCall,
    model,
    jobId,
  }), { tenantId });
  if (!queued.accepted) {
    const billing = settleEmbeddingLifecycle({
      hold,
      progress: { attemptedCalls: 0, persistedCalls: 0 },
      creditsPerCall,
      model,
      error: new Error(queued.reason),
    });
    updateEmbeddingJob(tenantId, jobId, {
      status: billing.state,
      last_error: queued.reason,
      finished_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    });
    return {
      ...queued,
      callsPlanned: plan.callCount,
      billing,
    };
  }
  // 若调度器自身在任务函数执行前异常，completion 仍会负责释放预授权。
  const completion = queued.completion.then(outcome => (
    outcome.ok
      ? outcome.value
      : {
        attemptedCalls: 0,
        persistedCalls: 0,
        error: String(outcome.error?.message || outcome.error || 'background_schedule_failed').slice(0, 160),
        billing: settleEmbeddingLifecycle({
          hold,
          progress: { attemptedCalls: 0, persistedCalls: 0 },
          creditsPerCall,
          model,
          error: outcome.error,
        }),
      }
  )).then(result => {
    updateEmbeddingJob(tenantId, jobId, {
      status: result.billing?.state || 'pending_reconciliation',
      last_error: result.error || null,
      finished_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    });
    return result;
  });
  return {
    ...queued,
    completion,
    callsPlanned: plan.callCount,
    billing: {
      state: 'held',
      heldCredits: hold.credits,
      chargedCredits: null,
      balance: hold.balance,
    },
  };
}

// 管理员显式触发的缺失向量回填。每次最多 20 篇；已有运行中或待对账任务的
// 文档不会重复排队。返回值只有任务元数据，不把知识正文带回 API 或日志。
export function backfillMissingEmbeddings({
  userId = null,
  limit = 10,
} = {}) {
  const requestedLimit = Math.min(20, positiveInt(limit, 10));
  if (!backgroundEmbeddingsEnabled()) {
    return {
      accepted: 0,
      rejected: 0,
      candidates: 0,
      requestedLimit,
      reason: 'disabled',
      results: [],
    };
  }
  ensureEmbeddingJobTable();
  const tenantId = curTenant();
  const blockingPlaceholders = BLOCKING_EMBEDDING_JOB_STATUSES.map(() => '?').join(',');
  const docs = db.prepare(`SELECT d.id,d.title,d.body
    FROM kb_docs d
    WHERE d.tenant_id=? AND d.enabled=1
      AND trim(COALESCE(d.body,''))<>''
      AND NOT ${hasStoredVectorSql('d')}
      AND NOT EXISTS(
        SELECT 1 FROM kb_embedding_jobs j
        WHERE j.tenant_id=d.tenant_id AND j.doc_id=d.id
          AND j.status IN (${blockingPlaceholders})
      )
    ORDER BY d.updated_at DESC,d.id DESC
    LIMIT ?`).all(
    tenantId,
    ...BLOCKING_EMBEDDING_JOB_STATUSES,
    requestedLimit,
  );
  const results = [];
  for (const doc of docs) {
    try {
      const queued = embedDoc(doc.id, doc.title, doc.body, { userId });
      results.push({
        docId: Number(doc.id),
        accepted: queued?.accepted === true,
        reason: queued?.reason || null,
        callsPlanned: Number(queued?.callsPlanned || 0),
      });
    } catch (error) {
      results.push({
        docId: Number(doc.id),
        accepted: false,
        reason: Number(error?.status) === 402 ? 'billing_hold_failed' : 'schedule_failed',
        callsPlanned: 0,
      });
    }
  }
  return {
    accepted: results.filter(item => item.accepted).length,
    rejected: results.filter(item => !item.accepted).length,
    candidates: docs.length,
    requestedLimit,
    reason: docs.length ? null : 'no_eligible_documents',
    results,
  };
}

// 启动恢复：只处理超过任务/排队最长生命周期后仍为 held 的向量任务。
// 无持久化向量时全退；有本次任务的持久化计数且产物仍存在时按实际数结算。
export function recoverStaleEmbeddingHolds({
  staleMinutes = positiveInt(process.env.BACKGROUND_EMBED_STALE_MINUTES, 15),
} = {}) {
  const holdTable = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_holds'`,
  ).get();
  if (!holdTable) return [];
  ensureEmbeddingJobTable();
  const age = Math.min(24 * 60, Math.max(5, positiveInt(staleMinutes, 15)));
  const rows = db.prepare(`SELECT
      h.id hold_id,h.log_id,h.tenant_id,h.user_id,h.feature,h.kind,h.model,h.held_credits,
      h.ref_id,j.id job_id,j.doc_id,j.planned_calls,j.credits_per_call,
      j.attempted_calls,j.persisted_calls
    FROM credit_holds h
    LEFT JOIN kb_embedding_jobs j
      ON j.id=h.ref_id AND j.tenant_id=h.tenant_id
    WHERE h.ref_type='kb_embedding' AND h.status='held'
      AND h.created_at <= datetime('now','localtime', ?)
    ORDER BY h.id`).all(`-${age} minutes`);
  const recovered = [];
  for (const row of rows) {
    const docId = Number(row.doc_id || row.ref_id);
    const output = db.prepare(`SELECT
        CASE WHEN d.embedding IS NOT NULL OR EXISTS(
          SELECT 1 FROM kb_chunks c WHERE c.doc_id=d.id AND c.embedding IS NOT NULL
        ) THEN 1 ELSE 0 END has_output
      FROM kb_docs d WHERE d.tenant_id=? AND d.id=?`).get(row.tenant_id, docId);
    if (!row.job_id && Number(output?.has_output || 0) === 1) {
      recovered.push({
        holdId: row.hold_id,
        jobId: null,
        tenantId: row.tenant_id,
        action: 'preserve_untracked_delivery',
      });
      continue;
    }
    const hasTrackedDelivery = Number(row.persisted_calls || 0) > 0
      && Number(output?.has_output || 0) === 1;
    const hold = {
      holdId: row.hold_id,
      logId: row.log_id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      feature: row.feature,
      kind: row.kind,
      model: row.model,
      credits: row.held_credits,
      plannedCalls: row.planned_calls || null,
      balance: null,
    };
    try {
      const settled = runWithTenant(row.tenant_id, () => (
        hasTrackedDelivery
          ? settleHold(hold, {
            credits: Math.min(
              row.held_credits,
              Number(row.persisted_calls) * positiveInt(row.credits_per_call, 1),
            ),
            model: row.model,
            note: `重启恢复：检测到${row.persisted_calls}个已持久化向量，按实际数量结算`,
          })
          : releaseHold(hold, '重启恢复：陈旧后台向量任务无可交付产物，预授权全额退回')
      ));
      const billingState = hasTrackedDelivery ? 'settled' : 'released';
      if (row.job_id) {
        updateEmbeddingJob(row.tenant_id, row.job_id, {
          status: billingState,
          last_error: hasTrackedDelivery ? 'restart_reconciled_delivery' : 'restart_released_without_delivery',
          finished_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        });
      }
      recovered.push({
        holdId: row.hold_id,
        jobId: row.job_id || null,
        tenantId: row.tenant_id,
        action: billingState,
        chargedCredits: settled?.credits ?? (hasTrackedDelivery
          ? Number(row.persisted_calls) * positiveInt(row.credits_per_call, 1)
          : 0),
      });
    } catch (error) {
      if (row.job_id) {
        updateEmbeddingJob(row.tenant_id, row.job_id, {
          status: 'pending_reconciliation',
          last_error: String(error.message || error).slice(0, 500),
        });
      }
      recovered.push({
        holdId: row.hold_id,
        jobId: row.job_id || null,
        tenantId: row.tenant_id,
        action: 'pending_reconciliation',
        error: String(error.message || error).slice(0, 160),
      });
    }
  }
  return recovered;
}

// ===== 知识库健康（P0-2）：事件记录、检索期主动入队、每日回填扫描、健康口径 =====
const KB_HEALTH_EVENT_KINDS = Object.freeze([
  'query_embed_failed',
  'zero_vector_doc',
  'backfill_needed',
  'backfill_run',
]);
const KB_HEALTH_LAST_BACKFILL_KEY = 'kb_vector_backfill_last';
// 单次检索最多把多少篇零向量文档交给后台队列；其余留给每日 04:00 扫描。
const KB_SEARCH_ENQUEUE_LIMIT = 5;

function kbHealthTableReady() {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='kb_health_events'`).get(),
  );
}

/**
 * 记录一次知识库健康事件。detail 只存计数与机器码，不存知识正文或查询原文。
 * 任何失败都吞掉：健康观测不能反过来打断检索或派活。
 */
export function recordKbHealthEvent(kind, detail = null, { tenantId = curTenant() } = {}) {
  if (!KB_HEALTH_EVENT_KINDS.includes(kind)) return false;
  const tid = Number(tenantId);
  if (!Number.isSafeInteger(tid) || tid <= 0) return false;
  try {
    if (!kbHealthTableReady()) return false;
    q.run(
      `INSERT INTO kb_health_events(tenant_id,kind,detail) VALUES(?,?,?)`,
      tid,
      kind,
      detail == null ? null : JSON.stringify(detail).slice(0, 2000),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 把检索时发现的零向量/未向量化文档交给既有后台向量化任务（同一 hold 计费、
 * 租户配额与队列护栏），并记录 zero_vector_doc 事件。
 * - 已有 preparing/queued/running/pending_reconciliation 任务的文档不重复排队；
 * - 已经有向量的文档（并发写入后）会被 SQL 过滤掉；
 * - 后台向量化开关未启用时只记事件（backfill_needed），不排队、不占额。
 */
export function enqueueMissingVectorDocs(docIds, {
  tenantId = curTenant(),
  userId = null,
  source = 'kb_search',
  limit = KB_SEARCH_ENQUEUE_LIMIT,
} = {}) {
  const ids = [...new Set((Array.isArray(docIds) ? docIds : [])
    .map(Number)
    .filter(id => Number.isSafeInteger(id) && id > 0))];
  const tid = Number(tenantId);
  if (!ids.length || !Number.isSafeInteger(tid) || tid <= 0) {
    return { accepted: 0, skipped: 0, candidates: 0, results: [] };
  }
  let candidates = [];
  try {
    ensureEmbeddingJobTable();
    const blockingPlaceholders = BLOCKING_EMBEDDING_JOB_STATUSES.map(() => '?').join(',');
    candidates = db.prepare(`SELECT d.id,d.title,d.body
      FROM kb_docs d
      WHERE d.tenant_id=? AND d.enabled=1
        AND d.id IN (${ids.map(() => '?').join(',')})
        AND trim(COALESCE(d.body,''))<>''
        AND NOT ${hasStoredVectorSql('d')}
        AND NOT EXISTS(
          SELECT 1 FROM kb_embedding_jobs j
          WHERE j.tenant_id=d.tenant_id AND j.doc_id=d.id
            AND j.status IN (${blockingPlaceholders})
        )
        AND NOT EXISTS(
          -- 冷却：一小时内刚失败/释放过的文档不在检索路径上反复重试，留给每日扫描。
          SELECT 1 FROM kb_embedding_jobs j2
          WHERE j2.tenant_id=d.tenant_id AND j2.doc_id=d.id
            AND j2.finished_at IS NOT NULL
            -- finished_at 由 updateEmbeddingJob 以 UTC ISO 写入，这里同样按 UTC 比较
            AND j2.finished_at >= datetime('now','-60 minutes')
        )
      ORDER BY d.updated_at DESC,d.id DESC
      LIMIT ?`).all(tid, ...ids, ...BLOCKING_EMBEDDING_JOB_STATUSES, Math.max(1, positiveInt(limit, KB_SEARCH_ENQUEUE_LIMIT)));
  } catch {
    return { accepted: 0, skipped: ids.length, candidates: 0, results: [] };
  }
  if (!candidates.length) {
    return { accepted: 0, skipped: ids.length, candidates: 0, results: [] };
  }
  const enabled = backgroundEmbeddingsEnabled();
  const results = [];
  for (const doc of candidates) {
    if (!enabled) {
      results.push({ docId: Number(doc.id), accepted: false, reason: 'disabled' });
      continue;
    }
    try {
      const queued = runWithTenant(tid, () => embedDoc(doc.id, doc.title, doc.body, { userId }));
      results.push({
        docId: Number(doc.id),
        accepted: queued?.accepted === true,
        reason: queued?.reason || null,
      });
    } catch (error) {
      results.push({
        docId: Number(doc.id),
        accepted: false,
        reason: Number(error?.status) === 402 ? 'billing_hold_failed' : 'schedule_failed',
      });
    }
  }
  const accepted = results.filter(item => item.accepted).length;
  recordKbHealthEvent(enabled ? 'zero_vector_doc' : 'backfill_needed', {
    source,
    candidates: candidates.length,
    accepted,
    docIds: candidates.map(doc => Number(doc.id)).slice(0, 20),
  }, { tenantId: tid });
  return { accepted, skipped: ids.length - candidates.length, candidates: candidates.length, results };
}

/**
 * 每日 04:00（上海时钟）由调度器 runOnce 调用：扫描当前租户零向量/未向量化文档并按
 * 既有配额入队；把结果写入 sys_config 与事件表。也可由 POST /kb/backfill 立即触发。
 */
export function runKbVectorBackfillSweep({
  tenantId = curTenant(),
  userId = null,
  limit = 20,
  source = 'scheduler',
  now = new Date(),
} = {}) {
  const tid = Number(tenantId);
  const readiness = kbVectorReadiness({ tenantId: tid });
  const result = readiness.missingDocs > 0
    ? runWithTenant(tid, () => backfillMissingEmbeddings({ userId, limit }))
    : { accepted: 0, rejected: 0, candidates: 0, requestedLimit: limit, reason: 'nothing_missing', results: [] };
  const summary = {
    source,
    ranAt: now.toISOString(),
    missingBefore: readiness.missingDocs,
    enabledDocs: readiness.enabledDocs,
    backgroundEnabled: readiness.backgroundEnabled,
    accepted: result.accepted,
    rejected: result.rejected,
    candidates: result.candidates,
    reason: result.reason || null,
  };
  try {
    setTenantConfig(KB_HEALTH_LAST_BACKFILL_KEY, summary, tid);
  } catch {
    // sys_config 不可写时不影响事件表记录。
  }
  recordKbHealthEvent(
    readiness.missingDocs > 0 && !readiness.backgroundEnabled ? 'backfill_needed' : 'backfill_run',
    summary,
    { tenantId: tid },
  );
  return summary;
}

function lastBackfillSummary(tenantId) {
  try {
    const row = q.get(
      'SELECT value FROM sys_config WHERE key = ?',
      `${KB_HEALTH_LAST_BACKFILL_KEY}:${tenantId}`,
    );
    return row?.value ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

/**
 * GET /api/sys/kb/health 的口径：文档总数、已向量化、待回填、24h 查询向量化失败次数、
 * 最近回填时间、红点（needsAttention）与下一步建议文案。不返回知识正文。
 */
export function kbHealthSummary({
  tenantId = curTenant(),
  env = process.env,
  providerConfigured = true,
} = {}) {
  const tid = Number(tenantId);
  const vector = kbVectorReadiness({ tenantId: tid, env });
  let queryEmbedFailures24h = 0;
  let zeroVectorHits24h = 0;
  let lastQueryEmbedFailureAt = null;
  if (kbHealthTableReady()) {
    const rows = q.all(
      `SELECT kind,COUNT(*) n,MAX(created_at) last_at FROM kb_health_events
       WHERE tenant_id=? AND created_at >= datetime('now','localtime','-24 hours')
       GROUP BY kind`,
      tid,
    );
    for (const row of rows) {
      if (row.kind === 'query_embed_failed') {
        queryEmbedFailures24h = Number(row.n || 0);
        lastQueryEmbedFailureAt = row.last_at || null;
      }
      if (row.kind === 'zero_vector_doc') zeroVectorHits24h = Number(row.n || 0);
    }
  }
  const lastBackfill = lastBackfillSummary(tid);
  const pendingBackfill = vector.missingDocs;
  const needsAttention = pendingBackfill > 0 || queryEmbedFailures24h > 0;
  let nextStep = '知识库语义检索状态正常，无需处理。';
  if (vector.enabledDocs === 0) {
    nextStep = '暂无已启用知识；先上传、录入或一键初始化知识库。';
  } else if (pendingBackfill > 0 && !providerConfigured) {
    nextStep = `有 ${pendingBackfill} 条知识未生成语义向量，且 AI 向量服务未配置；请先在部署侧配置向量服务。`;
  } else if (pendingBackfill > 0 && !vector.backgroundEnabled) {
    nextStep = `有 ${pendingBackfill} 条知识未生成语义向量；需由部署人员启用 ENABLE_BACKGROUND_EMBEDDINGS=true 并重启后点击“立即回填”。`;
  } else if (pendingBackfill > 0 && vector.reconciliationJobs > 0) {
    nextStep = `${vector.reconciliationJobs} 个向量任务待账务对账；先处理对账，再回填剩余 ${pendingBackfill} 条。`;
  } else if (pendingBackfill > 0 && vector.activeJobs > 0) {
    nextStep = `${vector.activeJobs} 个向量任务正在处理，剩余 ${pendingBackfill} 条将在完成后自动继续；也可点击“立即回填”加速。`;
  } else if (pendingBackfill > 0) {
    nextStep = `有 ${pendingBackfill} 条知识未生成语义向量，数字员工暂时检索不到它们；点击“立即回填”。`;
  } else if (queryEmbedFailures24h > 0) {
    nextStep = `最近 24 小时有 ${queryEmbedFailures24h} 次问题向量化失败（本轮未注入知识）；请检查 AI 向量服务连通性与超时配置。`;
  }
  return {
    tenantId: tid,
    enabledDocs: vector.enabledDocs,
    vectorizedDocs: vector.vectorizedDocs,
    pendingBackfill,
    percent: vector.percent,
    activeJobs: vector.activeJobs,
    reconciliationJobs: vector.reconciliationJobs,
    backgroundEnabled: vector.backgroundEnabled,
    providerConfigured,
    canBackfill: vector.canBackfill && providerConfigured,
    queryEmbedFailures24h,
    zeroVectorHits24h,
    lastQueryEmbedFailureAt,
    lastBackfillAt: lastBackfill?.ranAt || null,
    lastBackfill,
    needsAttention,
    state: vector.state,
    message: vector.message,
    nextStep,
  };
}

// 供 backfill 脚本同步调用（脚本环境无请求上下文）
export async function embedDocSync(id, title, body) {
  const plan = buildEmbeddingPlan(title, body);
  if (!plan.mainText) return false;
  const tenantId = q.get('SELECT tenant_id FROM kb_docs WHERE id=?', id)?.tenant_id;
  if (!tenantId || !liveDoc(id, tenantId, title, body)) return false;
  const progress = { attemptedCalls: 0, persistedCalls: 0 };
  await persistEmbeddingPlan({
    id, title, body, tenantId, plan, progress,
  });
  return progress.persistedCalls > 0;
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const DBP = path.join(
  os.tmpdir(),
  `nanowork-content-automation-special-provider-${process.pid}.db`,
);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* fresh database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const {
  createContentAutomationSpecialProviderAttemptStore,
  mergeContentAutomationBillingEvidence,
} = await import('../src/routes/content.js');
const { createContentSpecialProviderBridge } = await import(
  '../src/engines/content-special-provider-bridge.js'
);
const { canonicalContentEmployeeProfileFor } = await import(
  '../src/engines/canonical-employee-profile.js'
);
const { holdCredits, releaseHold, settleHold } = await import('../src/engines/credits.js');

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits)
  VALUES(1,'自动内容特殊provider验收企业','已开通',10000)
  ON CONFLICT(id) DO UPDATE SET credits=excluded.credits,status=excluded.status`);
const userId = Number(q.run(`INSERT INTO users(
  username,password_hash,name,role,dept,status,tenant_id
) VALUES('automation-special-owner','x','验收老板','boss','老板办','启用',1)`).lastInsertRowid);

function createRun() {
  return runWithTenant(1, () => {
    const ruleId = Number(q.run(`INSERT INTO content_automation_rules(
      name,enabled,employee_idx,topic,requirement,brief_json,content_type,content_count,
      frequency,run_time,weekday,approval_mode,next_run_at,created_by
    ) VALUES('多媒体真实provider幂等验收',0,5,'门店周复盘','只使用已知事实',
      '{"image_mode":"ai","image_count":1,"platforms":["小红书"]}',
      '多媒体素材方案',1,'daily','10:00',NULL,'always',NULL,?)`, userId).lastInsertRowid);
    const runId = Number(q.run(`INSERT INTO content_automation_runs(
      rule_id,trigger,claim_key,status,initiated_by
    ) VALUES(?,'immediate','automation-special-provider-idempotency','运行中',?)`,
    ruleId, userId).lastInsertRowid);
    return { ruleId, runId };
  });
}

after(() => {
  try { db.close(); } catch { /* test process already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
});

test('自动内容多媒体岗用稳定attempt回放，不重复生图、占分、结算或入素材库', async () => {
  const { runId } = createRun();
  await runWithTenant(1, async () => {
    const store = createContentAutomationSpecialProviderAttemptStore();
    let providerCalls = 0;
    const dependencies = {
      resolveProviderAttemptFn: store.resolve,
      claimProviderAttemptFn: store.claim,
      persistProviderOutputFn: store.persist,
      finalizeProviderAttemptFn: store.finalize,
      estimateMaxCreditsFn: () => 25,
      holdCreditsFn: holdCredits,
      settleHoldFn: settleHold,
      releaseHoldFn: releaseHold,
      async generateImageFn(input) {
        providerCalls += 1;
        assert.equal(input.idempotencyKey.endsWith(':image:1'), true);
        return {
          model: input.model,
          url: 'https://images.example/automation-special-idempotent.png',
        };
      },
    };
    const input = {
      tenantId: 1,
      userId,
      runId,
      employeeIdx: 5,
      employeePackage: canonicalContentEmployeeProfileFor(5),
      imageModel: 'gpt-image-2',
      attemptNamespace: 'content-automation',
      request: {
        prompt: '为门店周复盘生成一张待人工审阅配图',
        image_mode: 'ai',
        image_count: 1,
        platforms: ['小红书'],
        size: '1024x1024',
      },
    };

    const first = await createContentSpecialProviderBridge(input, dependencies)
      .providers.image({ count: 1, purpose: 'content_images' });
    const replayed = await createContentSpecialProviderBridge(input, dependencies)
      .providers.image({ count: 1, purpose: 'content_images' });

    assert.equal(first.bridge.replayed, false);
    assert.equal(replayed.bridge.replayed, true);
    assert.equal(replayed.bridge.attemptId, first.bridge.attemptId);
    assert.equal(providerCalls, 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM content_automation_special_provider_attempts
      WHERE tenant_id=1 AND run_id=?`, runId).n, 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM materials
      WHERE tenant_id=1 AND source_type='content_special_provider' AND source_id=?`, runId).n, 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM credit_holds
      WHERE tenant_id=1 AND ref_type='content_special_provider'`).n, 1);
    assert.equal(q.get(`SELECT status FROM content_automation_special_provider_attempts
      WHERE tenant_id=1 AND run_id=?`, runId).status, 'settled');

    const merged = mergeContentAutomationBillingEvidence(
      { specialProvider: { attempts: [first.bridge] } },
      {
        state: 'settled',
        holdId: 900,
        estimatedCredits: 20,
        heldCredits: 0,
        chargedCredits: 12,
        costYuan: 0.12,
        balance: 9963,
        pendingReconciliation: false,
      },
    );
    assert.equal(merged.state, 'settled');
    assert.equal(merged.chargedCredits, 37);
    assert.equal(merged.components.specialProviders.length, 1);
  });
});

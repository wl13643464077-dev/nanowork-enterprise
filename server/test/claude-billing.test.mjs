import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ===== AI-H4 测试：Claude 备用通道计费错配修复（claude-opus-4-8 独立价目）=====
const DBP = path.join(os.tmpdir(), `shanmei-claude-billing-${process.pid}.db`);
for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { billing, estimateCallCredits, charge } = await import('../src/engines/credits.js');

initSchema();
migrateV2();
q.run(`UPDATE tenants SET credits=100000 WHERE id=1`);
const userId = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('claude-bill-user','x','计费用户','boss','启用',1)`).lastInsertRowid;

test('AI-H4：billing 表包含 claude-opus-4-8 独立价目（36/180 元每百万 token）', () => {
  const b = billing();
  assert.deepEqual(b.text['claude-opus-4-8'], { in: 36, out: 180 });
  // 修复前落 default 30/30：输出侧价差 6 倍，这里显式钉死不许回退
  assert.ok(b.text['claude-opus-4-8'].out === 6 * b.text.default.out);
});

test('AI-H4：estimateCallCredits 按 claude-opus-4-8 真实价估算（不再按 default 低估）', () => {
  const claude = estimateCallCredits({ model: 'claude-opus-4-8', texts: ['x'.repeat(1000)], outputTokens: 1000, overheadTokens: 0 });
  // (1000*36 + 1000*180)/1e6 元 = 0.216 元 → ×1.5 毛利 ÷0.01 元/分 = 32.4 → 上取整 33 分
  assert.equal(claude, 33);
  const byDefault = estimateCallCredits({ model: '未知模型', texts: ['x'.repeat(1000)], outputTokens: 1000, overheadTokens: 0 });
  assert.ok(claude > byDefault, 'Claude 估算必须高于 default 口径（修复少收）');
});

test('AI-H4：charge 实扣按新价目结算（百万 token 输入+输出 = 32400 分）', () => {
  runWithTenant(1, () => {
    const bill = charge({
      userId, feature: '计费测试', kind: 'text', model: 'claude-opus-4-8',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, aiMode: 'api',
    });
    // (36+180) 元 ×1.5 ÷0.01 = 32400 分（修复前按 default 只收 (30+30)×1.5÷0.01 = 9000 分）
    assert.equal(bill.credits, 32400);
    assert.equal(bill.balance, 100000 - 32400);
    const log = q.get(`SELECT * FROM credit_logs WHERE tenant_id=1 AND feature='计费测试' ORDER BY id DESC LIMIT 1`);
    assert.equal(log.model, 'claude-opus-4-8');
    assert.equal(log.credits, 32400);
  });
});

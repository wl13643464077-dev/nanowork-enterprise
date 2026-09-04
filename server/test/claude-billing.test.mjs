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
const { billing, estimateCallCredits, charge, CREDIT_MARGIN_FACTOR } = await import('../src/engines/credits.js');

// 积分期望值一律按价目表公式算（毛利系数引用 CREDIT_MARGIN_FACTOR），系数/价目调整时不改测试
const creditsOf = (yuan, b = billing()) => Math.ceil((yuan * b.marginMultiplier) / b.creditYuan);

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
  const b = billing();
  assert.equal(b.marginMultiplier, CREDIT_MARGIN_FACTOR, '默认毛利系数必须来自 CREDIT_MARGIN_FACTOR 常量');
  const claude = estimateCallCredits({ model: 'claude-opus-4-8', texts: ['x'.repeat(1000)], outputTokens: 1000, overheadTokens: 0 });
  // (1000*36 + 1000*180)/1e6 元 = 0.216 元 → ×毛利系数 ÷0.01 元/分 → 上取整（系数 1.5 时 33 分，2.0 时 44 分）
  const p = b.text['claude-opus-4-8'];
  assert.equal(claude, creditsOf((1000 * p.in + 1000 * p.out) / 1e6, b));
  const byDefault = estimateCallCredits({ model: '未知模型', texts: ['x'.repeat(1000)], outputTokens: 1000, overheadTokens: 0 });
  assert.ok(claude > byDefault, 'Claude 估算必须高于 default 口径（修复少收）');
});

test('AI-H4：charge 实扣按新价目结算（百万 token 输入+输出 = (36+180) 元 × 毛利系数 ÷ 0.01）', () => {
  runWithTenant(1, () => {
    const b = billing();
    const p = b.text['claude-opus-4-8'];
    // (36+180) 元 × 毛利系数 ÷0.01（系数 1.5 时 32400 分，2.0 时 43200 分；修复前按 default 只收 (30+30) 元口径）
    const expected = creditsOf(p.in + p.out, b);
    assert.ok(expected > creditsOf(b.text.default.in + b.text.default.out, b));
    const bill = charge({
      userId, feature: '计费测试', kind: 'text', model: 'claude-opus-4-8',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, aiMode: 'api',
    });
    assert.equal(bill.credits, expected);
    assert.equal(bill.balance, 100000 - expected);
    const log = q.get(`SELECT * FROM credit_logs WHERE tenant_id=1 AND feature='计费测试' ORDER BY id DESC LIMIT 1`);
    assert.equal(log.model, 'claude-opus-4-8');
    assert.equal(log.credits, expected);
  });
});

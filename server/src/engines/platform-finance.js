import { q } from '../db.js';
import { billing } from './credits.js';

const round = number => Math.round((number + Number.EPSILON) * 10000) / 10000;
const hasTable = name => !!q.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);

// Read-only projection: original invoices remain unchanged. Each supplier expense
// is counted on its original log, never again on the compensating refund entry.
export function platformFinancialLedger({ where = 'WHERE l.tenant_id > 0', params = [], limit, offset = 0 } = {}) {
  const holds = hasTable('credit_holds');
  const expenses = hasTable('credit_supplier_expenses');
  const snapshot = holds && q.all('PRAGMA table_info(credit_holds)').some(column => column.name === 'pricing_snapshot_json');
  const joins = `${expenses ? `LEFT JOIN credit_supplier_expenses e ON e.log_id=l.id AND e.tenant_id=l.tenant_id AND e.user_id=l.user_id
    LEFT JOIN credit_supplier_expenses er ON er.refund_log_id=l.id AND er.tenant_id=l.tenant_id AND er.user_id=l.user_id` : ''}
    ${holds ? `LEFT JOIN credit_holds h ON h.id=(SELECT MAX(h2.id) FROM credit_holds h2
      WHERE h2.tenant_id=l.tenant_id AND h2.user_id=l.user_id
      AND h2.log_id=${expenses ? 'COALESCE(er.log_id,l.id)' : 'l.id'})` : ''}`;
  const fields = `${snapshot ? 'h.pricing_snapshot_json' : 'NULL'} AS financial_pricing_snapshot,
    ${expenses ? 'e.status' : 'NULL'} AS financial_expense_status,
    ${expenses ? 'e.cost_yuan' : 'NULL'} AS financial_expense_yuan,
    ${expenses ? 'e.refunded_at' : 'NULL'} AS customer_refunded_at`;
  const rows = q.all(`SELECT l.*,u.name user_name,t.name tenant_name,${fields} FROM credit_logs l
    LEFT JOIN users u ON u.id=l.user_id AND u.tenant_id=l.tenant_id
    LEFT JOIN tenants t ON t.id=l.tenant_id ${joins} ${where}
    ORDER BY l.id DESC ${limit == null ? '' : 'LIMIT ? OFFSET ?'}`, ...params, ...(limit == null ? [] : [limit,offset]));
  // A legacy invoice has no reliable historical unit. Expose the fallback as an
  // estimate; never silently claim the current configuration was its old price.
  const fallbackUnit = billing().creditYuan;
  return rows.map(row => {
    const {financial_pricing_snapshot: raw, financial_expense_status: expenseStatus,
      financial_expense_yuan: expenseYuan, ...original} = row;
    let price;
    try { price=JSON.parse(raw || '{}'); } catch { price={}; }
    const frozen = price.version === 1 && typeof price.creditYuan === 'number' && Number.isFinite(price.creditYuan) && price.creditYuan > 0;
    const personal = price.billingMode === 'personal';
    const unit = frozen ? price.creditYuan : fallbackUnit;
    const credit = Number(row.credits) || 0;
    const refund = row.kind === 'refund' && row.ai_mode === 'refund' && credit < 0;
    const held = row.ai_mode === 'hold';
    const consumption = !held && credit > 0 && !['recharge','bonus','refund'].includes(row.kind)
      && !['recharge','bonus','refund'].includes(row.ai_mode);
    const net = refund || consumption ? credit : 0;
    let status = expenseStatus;
    let cost = expenseYuan;
    if (refund || ['recharge','bonus'].includes(row.kind) || ['recharge','bonus'].includes(row.ai_mode)) {
      status='not_applicable';cost=null;
    } else if (!status) {
      if (held) { status='pending';cost=null; }
      else if (Number(row.cost_yuan) > 0) { status='estimated';cost=Number(row.cost_yuan); }
      else if (row.ai_mode === 'template') { status='not_incurred';cost=0; }
      else if (['api','failed'].includes(row.ai_mode) || consumption) { status='pending';cost=null; }
      else { status='not_applicable';cost=null; }
    }
    return {...original,ledger_effect:held ? 'held' : refund ? 'refund' : consumption ? 'consumption' : credit < 0 ? 'credit' : 'audit',
      net_consumed_credits:net,held_credits:held ? Math.max(0,credit) : 0,refunded_credits:refund ? -credit : 0,
      spend_yuan:refund || consumption ? round(net*unit) : null,
      credit_yuan:refund || consumption ? unit : null,price_source:refund || consumption ? frozen ? 'snapshot' : 'legacy_estimate' : null,
      supplier_cost_status:status,supplier_cost_yuan:['known','estimated','not_incurred'].includes(status) ? cost : null,
      billing_mode: personal ? 'personal' : 'platform', cost_payer: personal ? 'tester' : 'platform'};
  });
}

export function summarizePlatformFinance(rows) {
  const totals={spent:0,heldCredits:0,refundedCredits:0,consumedYuan:0,estimatedConsumedYuan:0,
    knownCostYuan:0,estimatedCostYuan:0,pendingCostCount:0,estimatedPriceCount:0,calls:0};
  for (const row of rows) {
    // BYOK supplier costs belong to the tester's own account, never platform COGS.
    if (row.billing_mode === 'personal') continue;
    totals.spent+=row.net_consumed_credits;
    totals.heldCredits+=row.held_credits;
    totals.refundedCredits+=row.refunded_credits;
    totals.consumedYuan+=row.spend_yuan || 0;
    if(row.price_source==='legacy_estimate') {totals.estimatedConsumedYuan+=row.spend_yuan || 0;totals.estimatedPriceCount++;}
    if(row.supplier_cost_status==='known') totals.knownCostYuan+=Number(row.supplier_cost_yuan)||0;
    if(row.supplier_cost_status==='estimated') totals.estimatedCostYuan+=Number(row.supplier_cost_yuan)||0;
    if(row.supplier_cost_status==='pending') totals.pendingCostCount++;
    if(['api','failed'].includes(row.ai_mode) && !['recharge','bonus','refund'].includes(row.kind)) totals.calls++;
  }
  for (const key of ['consumedYuan','estimatedConsumedYuan','knownCostYuan','estimatedCostYuan']) totals[key]=round(totals[key]);
  const cost=round(totals.knownCostYuan+totals.estimatedCostYuan);
  const margin=totals.pendingCostCount ? null : round(totals.consumedYuan-cost);
  return {...totals,cost,totalCost:cost,margin,
    marginRate:margin == null || totals.consumedYuan <= 0 ? null : Math.round(margin/totals.consumedYuan*1000)/10,
    marginStatus:totals.pendingCostCount ? 'pending' : totals.estimatedCostYuan > 0 || totals.estimatedPriceCount > 0 ? 'estimated' : 'known'};
}

// 亏损预警：按模型汇总“客户实付积分面值”与“上游已核实成本”，列出售价低于成本的模型。
// 只看平台付费（非测试员个人 Key）、且上游成本已核实的消费记录；估算/待核成本不当作亏损证据。
export function modelLossAlerts(rows) {
  const byModel = new Map();
  for (const row of rows) {
    if (row.billing_mode === 'personal' || row.ledger_effect !== 'consumption' || row.supplier_cost_status !== 'known') continue;
    const model = String(row.model || '未标注模型');
    const item = byModel.get(model) || { model, calls: 0, lossCalls: 0, revenueYuan: 0, costYuan: 0 };
    const revenue = Number(row.spend_yuan) || 0, cost = Number(row.supplier_cost_yuan) || 0;
    item.calls++; item.revenueYuan += revenue; item.costYuan += cost;
    if (cost > revenue + 1e-9) item.lossCalls++;
    byModel.set(model, item);
  }
  return [...byModel.values()].map(item => ({ ...item, revenueYuan: round(item.revenueYuan), costYuan: round(item.costYuan),
    marginYuan: round(item.revenueYuan - item.costYuan),
    marginRate: item.revenueYuan > 0 ? Math.round((item.revenueYuan - item.costYuan) / item.revenueYuan * 1000) / 10 : null }))
    .filter(item => item.lossCalls > 0 || item.marginYuan < 0)
    .sort((a, b) => a.marginYuan - b.marginYuan);
}

export function platformFinancialSummary() {
  const rows=platformFinancialLedger();
  const groups=new Map();
  for(const row of rows) { if(!groups.has(row.tenant_id))groups.set(row.tenant_id,[]);groups.get(row.tenant_id).push(row); }
  return {summary:summarizePlatformFinance(rows),lossAlerts:modelLossAlerts(rows),byTenant:new Map([...groups].map(([id,items])=>[id,summarizePlatformFinance(items)]))};
}

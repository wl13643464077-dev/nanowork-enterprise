import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nw-upstream-debit-'));
Object.assign(process.env,{NANOWORK_DB:path.join(dir,'test.db'),NODE_ENV:'test',NANOWORK_TEST_TEMPLATE_AI:'1',
  SEED_DEMO:'false',ENABLE_SCHEDULER:'false',YUNWU_BASE_URL:'https://api.openlux.ai',YUNWU_API_KEY:'',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:''});
const {db,q,initSchema,migrateV2,setConfig}=await import('../src/db.js');
const c=await import('../src/engines/credits.js');
initSchema();migrateV2();
setConfig('supplier_cost_openlux',{enabled:true,basis:'upstream_debit'});
setConfig('billing',{creditYuan:0.01,marginMultiplier:2});
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
let seq=0;
function actor(balance=1000) {
  const tid=Number(q.run("INSERT INTO tenants(name,status,credits) VALUES('钱包扣费专项','已开通',0)").lastInsertRowid);
  const uid=Number(q.run("INSERT INTO users(tenant_id,username,password_hash,name,role,status) VALUES(?,?,'x','测试','boss','启用')",tid,`wallet-${++seq}`).lastInsertRowid);
  c.creditTenant({tenantId:tid,userId:uid,delta:balance,feature:'测试充值'});
  return {tid,uid};
}
const hold=(a,credits=100)=>c.holdCredits({userId:a.uid,kind:'video',model:'wan2.6-i2v',feature:'钱包测试',credits});
const receipt=(requestId=`wallet-request-${++seq}`,amount=2,rate=1)=>({status:'known',costYuanOverride:amount*rate,
  costSource:{type:'provider_receipt',provider:'openlux',basis:'upstream_debit',requestId,currency:'USD',amount,exchangeRate:rate,
    quota:amount*500000,quotaPerUnit:500000,exchangeRateSource:'https://api.openlux.ai/api/status',
    statusRetrievedAt:'2026-09-06T00:00:00.000Z',statusDisplayCurrency:'USD'}});
const settle=(h,r)=>c.settleHold(h,{usage:{supplierCosts:[r]}});
const balance=a=>q.get('SELECT credits FROM tenants WHERE id=?',a.tid).credits;
function state(a) {return {balance:balance(a),holds:q.all('SELECT * FROM credit_holds WHERE tenant_id=?',a.tid),
  logs:q.all('SELECT * FROM credit_logs WHERE tenant_id=?',a.tid),expenses:q.all('SELECT * FROM credit_supplier_expenses WHERE tenant_id=?',a.tid),
  receipts:q.all('SELECT * FROM credit_supplier_receipts WHERE tenant_id=?',a.tid)};}
const invariant=a=>assert.equal(balance(a),-q.get('SELECT SUM(credits) amount FROM credit_logs WHERE tenant_id=?',a.tid).amount);
async function child(code) {
  const script=`const c=await import('./server/src/engines/credits.js');try{const value=${code};process.stdout.write(JSON.stringify({value}));}catch(error){process.stdout.write(JSON.stringify({code:error.code}));}`;
  const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{cwd:path.resolve(import.meta.dirname,'../..'),env:process.env});
  return JSON.parse(result.stdout);
}

test('中央幂等 schema 注册回执归属；新钱包策略冻结2倍和每积分0.01元，不依赖采购充值信息',()=>{
  assert.ok(q.get("SELECT name FROM sqlite_master WHERE name='credit_supplier_receipts'"));
  const a=actor();
  setConfig('billing',{creditYuan:0.01,marginMultiplier:9});
  assert.equal(c.billing().marginMultiplier,2);
  const h=hold(a),r=receipt();
  const pricing=JSON.parse(q.get('SELECT pricing_snapshot_json FROM credit_holds WHERE id=?',h.holdId).pricing_snapshot_json);
  assert.deepEqual(pricing.supplierCostPolicy,{enabled:true,basis:'upstream_debit'});
  assert.equal(pricing.creditYuan,0.01);assert.equal(pricing.marginMultiplier,2);
  setConfig('billing',{creditYuan:0.01,marginMultiplier:2});
  assert.equal(settle(h,r).credits,400);assert.equal(balance(a),600);
  assert.equal(q.get('SELECT settled_credits FROM credit_holds WHERE id=?',h.holdId).settled_credits,400);
  const source=c.getSupplierExpense(h.holdId,a.tid).costSource;
  assert.equal(source.basis,'upstream_debit');assert.equal(source.receipts[0].quota,1_000_000);
  assert.equal(source.receipts[0].exchangeRateSource,'https://api.openlux.ai/api/status');
  const settled=state(a);assert.equal(settle(h,r),null);assert.deepEqual(state(a),settled);
  assert.equal(c.refundHold(h).refundedCredits,400);assert.equal(balance(a),1000);
  assert.equal(c.refundHold(h).duplicate,true);assert.equal(settle(h,r),null);
  assert.equal(q.get('SELECT COUNT(*) n FROM credit_supplier_receipts WHERE hold_id=?',h.holdId).n,1);invariant(a);
});

test('有效积分面值沿用统一billing并冻结，报价和钱包结算不会各用一个面值',()=>{
  const a=actor();
  setConfig('billing',{creditYuan:0.02,marginMultiplier:9});
  const effective=c.billing(),h=hold(a);
  assert.equal(effective.creditYuan,0.02);assert.equal(effective.marginMultiplier,2);
  setConfig('billing',{creditYuan:0.01,marginMultiplier:2});
  assert.equal(settle(h,receipt()).credits,200);assert.equal(balance(a),800);invariant(a);
});

test('超过预占且余额不足不改任何账目；补余额后原hold可结算，退款包含追加差额',()=>{
  const a=actor(300),h=hold(a),r=receipt(),before=state(a);
  assert.throws(()=>settle(h,r),error=>{
    assert.equal(error.code,'BILLING_SETTLEMENT_BALANCE_INSUFFICIENT');assert.equal(error.status,402);
    assert.equal(error.billingPending,true);assert.equal(error.requiredCredits,400);assert.equal(error.heldCredits,100);
    assert.equal(error.additionalCredits,300);assert.equal(error.balance,200);assert.equal(error.shortfallCredits,100);return true;
  });
  assert.deepEqual(state(a),before);
  c.creditTenant({tenantId:a.tid,userId:a.uid,delta:100,feature:'补余额'});
  assert.equal(settle(h,r).credits,400);assert.equal(balance(a),0);
  assert.equal(c.refundHold(h).refundedCredits,400);assert.equal(balance(a),400);invariant(a);
});

test('开关启用后无回执仍待核，估算价或旧采购成本证据不能代扣',()=>{
  const a=actor(),h=hold(a),before=state(a);
  for(const params of [{credits:1},{credits:1,usage:{supplierCosts:[{status:'pending'}]}},
    {costYuanOverride:2,costSource:{type:'provider_receipt',provider:'openlux',requestId:'procurement-cost',currency:'CNY',amount:2,exchangeRate:1}}])
    assert.throws(()=>c.settleHold(h,params),{code:'BILLING_SUPPLIER_COST_PENDING'});
  assert.deepEqual(state(a),before);c.refundHold(h);invariant(a);
});

test('旧固定报价与缺快照历史hold仍保留上限，新进程按原钱包快照恢复',async()=>{
  const a=actor(3000);
  for(const missing of [false,true]) {
    const h=hold(a),pricing=JSON.parse(q.get('SELECT pricing_snapshot_json FROM credit_holds WHERE id=?',h.holdId).pricing_snapshot_json);
    delete pricing.supplierCostPolicy.basis;
    q.run('UPDATE credit_holds SET pricing_snapshot_json=? WHERE id=?',missing?null:JSON.stringify(pricing),h.holdId);
    const before=state(a);assert.throws(()=>settle(h,receipt()),{code:'BILLING_HOLD_EXCEEDED'});assert.deepEqual(state(a),before);c.releaseHold(h);
  }
  const h=hold(a),r=receipt();
  setConfig('supplier_cost_openlux',{enabled:false});
  try {
    const result=await child(`c.settleHold(${JSON.stringify(h)},{usage:{supplierCosts:[${JSON.stringify(r)}]}})`);
    assert.equal(result.value.credits,400);assert.equal(balance(a),2600);
  } finally {setConfig('supplier_cost_openlux',{enabled:true,basis:'upstream_debit'});}
  invariant(a);
});

test('两个进程同回执竞争不同hold仅一笔结算，退款后回执仍不能复用',async()=>{
  const a=actor(2000),holds=[hold(a),hold(a)],r=receipt();
  const results=await Promise.all(holds.map(h=>child(`c.settleHold(${JSON.stringify(h)},{usage:{supplierCosts:[${JSON.stringify(r)}]}})`)));
  assert.equal(results.filter(result=>result.value?.credits===400).length,1);
  assert.equal(results.filter(result=>result.code==='BILLING_SUPPLIER_RECEIPT_REUSED').length,1);
  const winner=holds[results.findIndex(result=>result.value)],loser=holds[results.findIndex(result=>result.code)];
  assert.equal(balance(a),1500);c.refundHold(winner);
  const before=state(a);assert.throws(()=>settle(loser,r),{code:'BILLING_SUPPLIER_RECEIPT_REUSED'});assert.deepEqual(state(a),before);
  c.releaseHold(loser);assert.equal(balance(a),2000);invariant(a);
});

test('直接charge同请求并发重试返回原账，改归属或退款后重复扣费被拒绝',async()=>{
  const a=actor(),r=receipt(),args={userId:a.uid,feature:'直接钱包扣费',kind:'image',model:'gpt-image-2',usage:{supplierCosts:[r]}};
  const results=await Promise.all([child(`c.charge(${JSON.stringify(args)})`),child(`c.charge(${JSON.stringify(args)})`)]);
  assert.equal(results.filter(result=>result.value?.duplicate).length,1);assert.ok(results.every(result=>result.value?.credits===400));
  assert.equal(balance(a),600);assert.equal(q.get("SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=? AND ref_type='direct_charge'",a.tid).n,1);
  const row=q.get('SELECT * FROM credit_holds WHERE tenant_id=?',a.tid),h={holdId:row.id,tenantId:a.tid,userId:a.uid};
  assert.throws(()=>c.charge({...args,feature:'另一个业务'}),{code:'BILLING_SUPPLIER_RECEIPT_REUSED'});
  c.refundHold(h);const before=state(a);assert.throws(()=>c.charge(args),{code:'BILLING_SUPPLIER_RECEIPT_REUSED'});
  assert.deepEqual(state(a),before);assert.equal(balance(a),1000);invariant(a);
});

test('补扣结算与最终失败退款并发保持净扣零，退款后迟到回执不得再次收费',async()=>{
  const a=actor(),h=hold(a),r=receipt();
  const results=await Promise.all([child(`c.settleHold(${JSON.stringify(h)},{usage:{supplierCosts:[${JSON.stringify(r)}]}})`),child(`c.refundHold(${JSON.stringify(h)})`)]);
  assert.ok(results.every(result=>!result.code));assert.equal(balance(a),1000);
  c.reconcileSupplierExpense(h,{supplierCostYuan:r.costYuanOverride,costSource:r.costSource});
  const second=hold(a),before=state(a);assert.throws(()=>settle(second,r),{code:'BILLING_SUPPLIER_RECEIPT_REUSED'});assert.deepEqual(state(a),before);
  c.releaseHold(second);invariant(a);
});

test('逐请求不同公开汇率各自核算后汇总，完整原始证据持久化且金额篡改回滚',()=>{
  const a=actor(2000),h=hold(a),costs=[receipt(undefined,0.2,7),receipt(undefined,0.2,7.1)];
  const result=c.settleHold(h,{usage:{supplierCosts:costs}});
  assert.equal(result.credits,564);assert.equal(result.costYuan,2.82);
  const source=c.getSupplierExpense(h.holdId,a.tid).costSource;
  assert.equal(source.currency,'CNY');assert.equal(source.exchangeRate,1);assert.equal(source.receipts.length,2);
  assert.deepEqual(source.receipts.map(row=>row.exchangeRate),[7,7.1]);
  const bad=hold(a),before=state(a),tampered=receipt();tampered.costSource.quota+=1;
  // 被篡改的“已知”回执是无效证据而不是迟到回执：明确报未核验，账务原样回滚。
  assert.throws(()=>settle(bad,tampered),{code:'BILLING_SUPPLIER_COST_UNVERIFIED'});
  assert.deepEqual(state(a),before);c.releaseHold(bad);invariant(a);
});

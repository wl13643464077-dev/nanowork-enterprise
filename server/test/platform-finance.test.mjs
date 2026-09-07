import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nw-platform-finance-'));
Object.assign(process.env,{NANOWORK_DB:path.join(dir,'test.db'),NODE_ENV:'test',NANOWORK_TEST_TEMPLATE_AI:'1',SEED_DEMO:'false',YUNWU_API_KEY:'',YUNWU_BASE_URL:''});
const {db,q,initSchema,migrateV2,setConfig}=await import('../src/db.js');
initSchema();migrateV2();
const {holdCredits,settleHold,refundHold,charge,creditTenant}=await import('../src/engines/credits.js');
const {platformFinancialLedger,platformFinancialSummary}=await import('../src/engines/platform-finance.js');
const platform=(await import('../src/routes/platform.js')).default;
setConfig('billing',{creditYuan:0.01,marginMultiplier:2,image:{'test-image':2},text:{'test-text':{in:1,out:1}}});
const user=Number(q.run("INSERT INTO users(tenant_id,username,password_hash,name,role,status) VALUES(1,'finance-super','x','财务测试','platform_super','启用')").lastInsertRowid);
creditTenant({tenantId:1,userId:user,delta:10000,feature:'隔离测试充值'});
const create=()=>holdCredits({userId:user,feature:'财务口径测试',kind:'image',model:'test-image',credits:500});
const source=(cost,id)=>({costYuanOverride:cost,costSource:{type:'provider_receipt',provider:'openlux',requestId:id,currency:'CNY',amount:cost,exchangeRate:1}});
const refunded=create();settleHold(refunded,source(2,'refund-settled'));refundHold(refunded);
const kept=create();settleHold(kept,source(1,'kept'));
const failure=create();refundHold(failure,{supplierCostYuan:3,costSource:source(3,'failure').costSource});
const pending=create();
const failedUnknown=create();refundHold(failedUnknown);
charge({userId:user,feature:'配置估算',kind:'image',model:'test-image'});
const legacyId=Number(q.run(`INSERT INTO credit_logs(tenant_id,user_id,feature,kind,model,cost_yuan,credits,balance_after,ai_mode)
  VALUES(1,?,'历史账单','text','legacy',0.25,50,1000,'api')`,user).lastInsertRowid);
setConfig('billing',{creditYuan:0.02,marginMultiplier:2});
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});

test('净消费扣退款不计hold，失败供应商支出不遗漏且不与原账单重复计成本',()=>{
  const before=q.get('SELECT total_changes() n').n;
  const result=platformFinancialSummary();
  assert.equal(result.summary.spent,650);
  assert.equal(result.summary.heldCredits,500);
  assert.equal(result.summary.refundedCredits,400);
  assert.equal(result.summary.consumedYuan,7,'冻结面值6元加历史估算1元');
  assert.equal(result.summary.knownCostYuan,6,'2元已退款任务+1元成功+3元失败平台承担');
  assert.equal(result.summary.estimatedCostYuan,2.25,'2元配置估算及0.25元旧账');
  assert.equal(result.summary.totalCost,8.25);
  assert.equal(result.summary.pendingCostCount,2,'未知供应商失败和仍在途hold均待核验');
  assert.equal(result.summary.margin,null);
  assert.equal(result.summary.marginRate,null);
  assert.equal(result.summary.estimatedPriceCount,1);
  assert.equal(result.summary.estimatedConsumedYuan,1);
  assert.deepEqual(result.byTenant.get(1),result.summary,'实际tenant1也计入平台财务');
  assert.equal(q.get('SELECT total_changes() n').n,before,'汇总不得更新历史账务');
});

test('流水保留原金额，价格依据/退款/冻结/成本状态各自表达',()=>{
  const rows=platformFinancialLedger();
  const original=rows.find(row=>row.id===refunded.logId);
  assert.equal(original.cost_yuan,2);assert.equal(original.credits,400);
  assert.equal(original.supplier_cost_yuan,2);assert.equal(original.supplier_cost_status,'known');
  const refund=rows.find(row=>row.kind==='refund');
  assert.equal(refund.spend_yuan,-4);assert.equal(refund.credit_yuan,0.01);
  assert.equal(refund.price_source,'snapshot');assert.equal(refund.supplier_cost_yuan,null);
  assert.equal(refund.supplier_cost_status,'not_applicable');
  const hold=rows.find(row=>row.id===pending.logId);
  assert.equal(hold.spend_yuan,null);assert.equal(hold.ledger_effect,'held');assert.equal(hold.net_consumed_credits,0);
  const old=rows.find(row=>row.id===legacyId);
  assert.equal(old.price_source,'legacy_estimate');assert.equal(old.supplier_cost_status,'estimated');
  assert.equal(rows.some(row=>Object.hasOwn(row,'financial_pricing_snapshot')),false);
  const filtered=platformFinancialLedger({where:'WHERE l.id=?',params:[kept.logId]});
  assert.equal(filtered.length,1);assert.equal(filtered[0].spend_yuan,2);
});

test('平台三个只读接口提供同口径摘要/分页流水，企业管理员无权读取',async()=>{
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.user={id:user,tenant_id:1,role:req.headers['x-test-role']||'platform_super'};next();});
  app.use('/platform',platform);
  const server=app.listen(0,'127.0.0.1');
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  const base=`http://127.0.0.1:${server.address().port}/platform`;
  try {
    const before=q.get('SELECT total_changes() n').n;
    const overview=await (await fetch(`${base}/overview`)).json();
    const analyticsResponse=await fetch(`${base}/analytics`);
    assert.equal(analyticsResponse.status,200,await analyticsResponse.clone().text());
    const analytics=await analyticsResponse.json();
    const logs=await (await fetch(`${base}/credit-logs?tenantId=1&kind=refund`)).json();
    assert.equal(overview.spentTotal,650);assert.equal(overview.financial.heldCredits,500);
    assert.equal(analytics.summary.knownCostYuan,6);assert.equal(analytics.summary.marginRate,null);
    assert.equal(analytics.tenants.find(t=>t.id===1).spent,650);
    assert.equal(logs.total,1);assert.equal(logs.rows[0].spend_yuan,-4);
    for(const endpoint of ['overview','analytics','credit-logs'])
      assert.equal((await fetch(`${base}/${endpoint}`,{headers:{'x-test-role':'boss'}})).status,403);
    assert.equal(q.get('SELECT total_changes() n').n,before);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

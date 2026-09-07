import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nw-cost-refund-'));
Object.assign(process.env,{NANOWORK_DB:path.join(dir,'test.db'),NODE_ENV:'test',NANOWORK_TEST_TEMPLATE_AI:'1',SEED_DEMO:'false',ENABLE_SCHEDULER:'false',YUNWU_API_KEY:'',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:''});
const {db,q,initSchema,migrateV2,getConfig,setConfig}=await import('../src/db.js');
const {billing,charge,creditTenant,holdCredits,settleHold,releaseHold,refundHold,reconcileSupplierExpense,getSupplierExpense,tenantMonthlyUsage,getUserMonthlyUsage}=await import('../src/engines/credits.js');
initSchema();migrateV2();
const original=getConfig('billing',{});
const rates={creditYuan:0.01,marginMultiplier:2,text:{'cost-test':{in:1,out:1}},image:{'cost-image':2},video:{'cost-video':2}};
setConfig('billing',rates);
const tenant=Number(q.run("INSERT INTO tenants(name,status,credits) VALUES('费用专项','已开通',0)").lastInsertRowid);
const user=Number(q.run("INSERT INTO users(tenant_id,username,password_hash,name,role,status) VALUES(?,'cost-user','x','测试','boss','启用')",tenant).lastInsertRowid);
creditTenant({tenantId:tenant,userId:user,delta:100000,feature:'隔离测试充值'});
const balance=()=>q.get('SELECT credits FROM tenants WHERE id=?',tenant).credits;
const invariant=()=>assert.equal(balance(),-q.get('SELECT SUM(credits) n FROM credit_logs WHERE tenant_id=?',tenant).n);
const create=(kind='text',model='cost-test',credits=500)=>holdCredits({userId:user,feature:'费用专项',kind,model,credits});
const usage={inputTokens:1_000_000,outputTokens:1_000_000};
let receiptNumber=0;
const receipt=(amount=2)=>({type:'provider_receipt',provider:'openlux',requestId:`receipt-test-${++receiptNumber}`,currency:'USD',amount,exchangeRate:1,
  basis:'upstream_debit',quota:amount*500000,quotaPerUnit:500000,exchangeRateSource:'https://api.openlux.ai/api/status',statusRetrievedAt:'2026-09-06T00:00:00.000Z'});
const snapshot=()=>({balance:balance(),holds:q.all('SELECT * FROM credit_holds WHERE tenant_id=?',tenant),logs:q.all('SELECT * FROM credit_logs WHERE tenant_id=?',tenant)});
after(()=>{setConfig('billing',original);db.close();fs.rmSync(dir,{recursive:true,force:true});});

test('供应商成本2元按2倍收费400积分，提交时价格持久化并经新进程恢复',()=>{
  const before=balance(),hold=create();
  const raw=q.get('SELECT pricing_snapshot_json FROM credit_holds WHERE id=?',hold.holdId).pricing_snapshot_json;
  assert.equal(JSON.parse(raw).marginMultiplier,2);
  setConfig('billing',{...rates,creditYuan:0.1,marginMultiplier:9,text:{'cost-test':{in:20,out:20}}});
  const code=`const {settleHold}=await import('./server/src/engines/credits.js');process.stdout.write(JSON.stringify(settleHold(${JSON.stringify(hold)},{usage:${JSON.stringify(usage)}})));`;
  const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{cwd:path.resolve(import.meta.dirname,'../..'),env:process.env,encoding:'utf8'}));
  assert.equal(result.credits,400);assert.equal(result.costYuan,2);assert.equal(balance(),before-400);
  assert.equal(getSupplierExpense(hold.holdId,tenant).status,'estimated','价目表只能证明估算成本');
  assert.equal(q.get('SELECT pricing_snapshot_json FROM credit_holds WHERE id=?',hold.holdId).pricing_snapshot_json,raw);
  invariant();setConfig('billing',rates);
});

test('可信供应商回执成本独立计价，未核实来源/负数小数金额和token不能改余额',()=>{
  const hold=create('image','cost-image');
  const billed=settleHold(hold,{credits:500,costYuanOverride:2,costSource:receipt()});
  assert.equal(billed.credits,400);assert.equal(getSupplierExpense(hold.holdId,tenant).status,'known');
  const invalid=create('image','cost-image'), before=snapshot();
  assert.throws(()=>settleHold(invalid,{costYuanOverride:2,costSource:{...receipt(),amount:1}}),{code:'BILLING_SUPPLIER_COST_UNVERIFIED'});
  assert.deepEqual(snapshot(),before);
  releaseHold(invalid);
  for(const amount of [-1,1.5,NaN,Infinity,'100']) assert.throws(()=>create('image','cost-image',amount),{code:'BILLING_AMOUNT_INVALID'});
  assert.throws(()=>holdCredits({userId:user,kind:'image',model:'cost-image'}),{code:'BILLING_AMOUNT_INVALID'});
  for(const tokens of [-100,1.5,NaN,'12']) {
    const held=create(), before=snapshot();
    assert.throws(()=>settleHold(held,{credits:10,usage:{inputTokens:tokens,outputTokens:1}}),{code:'BILLING_USAGE_MISSING'});
    assert.throws(()=>charge({userId:user,feature:'非法用量',kind:'text',model:'cost-test',usage:{inputTokens:tokens,outputTokens:1}}),{code:'BILLING_USAGE_MISSING'});
    assert.deepEqual(snapshot(),before);releaseHold(held);
  }
  invariant();
});

test('无成果未知上游结果：用户立即全退，供应商仍pending，重复/迟到结算都不重新扣费',()=>{
  const before=balance(),hold=create('video','cost-video');
  const refund=refundHold(hold);
  assert.equal(refund.credits,0);assert.equal(refund.refundedCredits,500);assert.equal(refund.supplierCostStatus,'pending');assert.equal(refund.costYuan,null);
  assert.equal(balance(),before);assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?',hold.holdId).status,'settled');
  assert.equal(q.get('SELECT cost_yuan FROM credit_logs WHERE id=?',hold.logId).cost_yuan,null);
  assert.equal(refundHold(hold).duplicate,true);assert.equal(settleHold(hold,{credits:400}),null);assert.equal(balance(),before);
  const ledger=snapshot();
  const source=receipt();
  const expense=reconcileSupplierExpense(hold,{supplierCostYuan:2,costSource:source});
  assert.equal(expense.status,'known');assert.equal(expense.costYuan,2);assert.deepEqual(snapshot(),ledger,'补录供应商成本不改用户原流水');
  reconcileSupplierExpense(hold,{supplierCostYuan:2,costSource:source});
  assert.throws(()=>reconcileSupplierExpense(hold,{supplierCostYuan:3,costSource:receipt(3)}),{code:'BILLING_SUPPLIER_COST_CONFLICT'});
  invariant();
});

test('已结算后发现最终无成果：保留原400积分账单，追加负数退款并保留2元供应商支出',()=>{
  const used=tenantMonthlyUsage(tenant).used, userUsed=getUserMonthlyUsage(user).used;
  const before=balance(),hold=create('video','cost-video');
  settleHold(hold,{costYuanOverride:2,costSource:receipt()});
  const originalLog=q.get('SELECT * FROM credit_logs WHERE id=?',hold.logId);
  const refund=refundHold(hold);
  assert.equal(refund.refundedCredits,400);assert.equal(refund.costYuan,2);assert.equal(refund.supplierCostStatus,'known');assert.equal(balance(),before);
  assert.deepEqual(q.get('SELECT * FROM credit_logs WHERE id=?',hold.logId),originalLog);
  const expense=getSupplierExpense(hold.holdId,tenant), refundLog=q.get('SELECT * FROM credit_logs WHERE id=?',expense.refundLogId);
  assert.equal(refundLog.credits,-400);assert.equal(refundLog.kind,'refund');assert.equal(refundLog.cost_yuan,0);
  assert.equal(tenantMonthlyUsage(tenant).used,used);assert.equal(getUserMonthlyUsage(user).used,userUsed);
  const final=snapshot();refundHold(hold);assert.deepEqual(snapshot(),final);invariant();
});

test('退款成本证据保留，明确未调用释放成本为0；伪造tenant/owner/handle均拒绝',()=>{
  const hold=create('video','cost-video'), before=snapshot();
  for(const bad of [{holdId:hold.holdId},{...hold,tenantId:1},{...hold,userId:user+1}]) {
    assert.throws(()=>refundHold(bad),{code:'CREDIT_HOLD_INTEGRITY_MISMATCH'});assert.deepEqual(snapshot(),before);
  }
  const result=refundHold(hold,{supplierCostYuan:2,costSource:receipt()});
  assert.equal(result.costYuan,2);assert.equal(q.get('SELECT cost_yuan FROM credit_logs WHERE id=?',hold.logId).cost_yuan,2);
  const uncalled=create('video','cost-video');releaseHold(uncalled,'尚未提交');
  assert.equal(q.get('SELECT cost_yuan FROM credit_logs WHERE id=?',uncalled.logId).cost_yuan,0);
  assert.equal(getSupplierExpense(uncalled.holdId,tenant).status,'not_incurred');invariant();
});

test('提前核实的供应商回执优先估算价，释放客户占扣也不能擦掉已知上游支出',()=>{
  const hold=create('image','cost-image');
  reconcileSupplierExpense(hold,{supplierCostYuan:1,costSource:receipt(1)});
  assert.equal(settleHold(hold,{credits:500}).credits,200);
  assert.equal(getSupplierExpense(hold.holdId,tenant).status,'known');
  const release=create('video','cost-video'), before=balance();
  reconcileSupplierExpense(release,{supplierCostYuan:2,costSource:receipt()});
  releaseHold(release,'本次没有可交付成果');
  assert.equal(balance(),before+500);
  assert.equal(getSupplierExpense(release.holdId,tenant).costYuan,2);invariant();
});

test('两个独立进程并发退款与结算只产生一次客户净退款',async()=>{
  const before=balance(),hold=create('video','cost-video');
  const run=promisify(execFile),prefix=`const c=await import('./server/src/engines/credits.js');const h=${JSON.stringify(hold)};`;
  await Promise.all([
    run(process.execPath,['--input-type=module','-e',prefix+'c.refundHold(h);'],{cwd:path.resolve(import.meta.dirname,'../..'),env:process.env}),
    run(process.execPath,['--input-type=module','-e',prefix+'c.settleHold(h,{credits:400});'],{cwd:path.resolve(import.meta.dirname,'../..'),env:process.env}),
  ]);
  assert.equal(balance(),before);assert.ok(getSupplierExpense(hold.holdId,tenant).refundedAt);assert.equal(settleHold(hold,{credits:400}),null);invariant();
});

test('并行任务在同一个预算窗口占扣不能超过100积分上限',async()=>{
  const id=Number(q.run("INSERT INTO tenants(name,status,credits,monthly_credit_budget) VALUES('预算竞争','已开通',1000,100)").lastInsertRowid);
  const uid=Number(q.run("INSERT INTO users(tenant_id,username,password_hash,name,role,status) VALUES(?,'budget-race','x','测试','boss','启用')",id).lastInsertRowid);
  const run=promisify(execFile);
  const results=await Promise.all(['a','b'].map(name=>{
    const script=`import fs from 'node:fs';const {db}=await import('./server/src/db.js');const c=await import('./server/src/engines/credits.js');
      const exec=db.exec.bind(db);db.exec=(sql)=>{if(sql==='BEGIN IMMEDIATE'){fs.writeFileSync(${JSON.stringify(path.join(dir,`ready-${name}`))},'ok');const start=Date.now();while(!fs.existsSync(${JSON.stringify(path.join(dir,`ready-${name==='a'?'b':'a'}`))})&&Date.now()-start<5000)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}return exec(sql);};
      try{c.holdCredits({userId:${uid},feature:'预算竞争',kind:'image',model:'cost-image',credits:80});process.stdout.write('held');}catch(e){process.stdout.write(e.code||'error');}`;
    return run(process.execPath,['--input-type=module','-e',script],{cwd:path.resolve(import.meta.dirname,'../..'),env:process.env});
  }));
  assert.deepEqual(results.map(r=>r.stdout).sort(),['BUDGET_EXCEEDED','held']);
  assert.equal(tenantMonthlyUsage(id).used,80);
});

test('错误积分比例拒绝，合法自定义比例的预检下限同步更新',()=>{
  for(const config of [{creditYuan:0},{marginMultiplier:-2},{creditYuan:'0.01'},{marginMultiplier:NaN}]) {
    setConfig('billing',{...rates,...config});assert.throws(()=>billing(),{code:'BILLING_PRICE_INVALID'});
  }
  setConfig('billing',{...rates,creditYuan:0.02});assert.equal(billing().minBalance.video,800);setConfig('billing',rates);
});

test('逐次真实回执优先所有固定估价，缺token可核价但非法token不能绕过',()=>{
  const supplierCosts=[1,2].map((n)=>({status:'known',costYuanOverride:0.5,costSource:{...receipt(0.5),requestId:`aggregate-${n}`}}));
  const hold=create();
  assert.equal(settleHold(hold,{usage:{supplierCosts},credits:500,costYuanOverride:999}).credits,200);
  assert.equal(getSupplierExpense(hold.holdId,tenant).costYuan,1);
  const invalid=create(),state=snapshot();
  assert.throws(()=>settleHold(invalid,{usage:{supplierCosts,inputTokens:-1}}),{code:'BILLING_USAGE_MISSING'});
  assert.deepEqual(snapshot(),state);releaseHold(invalid);
  assert.throws(()=>charge({userId:user,kind:'text',model:'cost-test',feature:'回执重复计费',usage:{supplierCosts}}),{code:'BILLING_SUPPLIER_RECEIPT_REUSED'});
  const directCosts=supplierCosts.map(entry=>({...entry,costSource:{...entry.costSource,requestId:`direct-${entry.costSource.requestId}`}}));
  assert.equal(charge({userId:user,kind:'text',model:'cost-test',feature:'回执直接计费',usage:{supplierCosts:directCosts}}).credits,200);
  invariant();
});

test('新预授权冻结真实成本政策，关闭开关或传估价不能绕过待核验；旧预授权不倒追',()=>{
  const key='supplier_cost_openlux',old=getConfig(key,null),legacy=create(),oldBase=process.env.YUNWU_BASE_URL;
  try {
    process.env.YUNWU_BASE_URL='https://api.openlux.ai';
    setConfig(key,{enabled:true,rmbPaid:1,usdCredited:1,paymentReference:'isolated-test'});
    const hold=create('video','cost-video');
    setConfig(key,{enabled:false});
    const state=snapshot();
    assert.throws(()=>settleHold(hold,{credits:400}),{code:'BILLING_SUPPLIER_COST_PENDING'});
    assert.throws(()=>settleHold(hold,{credits:400,costYuanOverride:2,costSource:receipt(),usage:{supplierCosts:[{status:'pending'}]}}),{code:'BILLING_SUPPLIER_COST_PENDING'});
    assert.deepEqual(snapshot(),state);
    assert.equal(settleHold(hold,{usage:{supplierCosts:[{status:'known',costYuanOverride:2,costSource:receipt()}]}}).credits,400);
    assert.equal(settleHold(legacy,{usage}).credits,400);
    setConfig(key,{enabled:true,rmbPaid:1,usdCredited:1,paymentReference:'isolated-test'});
    const before=balance();
    assert.throws(()=>charge({userId:user,feature:'未核验直接计费',kind:'text',model:'cost-test',usage}),{code:'BILLING_SUPPLIER_COST_PENDING'});
    assert.equal(balance(),before);
  } finally {setConfig(key,old);if(oldBase===undefined)delete process.env.YUNWU_BASE_URL;else process.env.YUNWU_BASE_URL=oldBase;}
  invariant();
});

test('无成果退款在写事务内验证任务快照，失去owner与异步guard均不可动账',()=>{
  const hold=create(),state=snapshot();
  const conflict=Object.assign(new Error('new owner'),{code:'AI_SALES_VIDEO_STATE_CONFLICT'});
  assert.throws(()=>refundHold(hold,{assertRefundable:()=>{assert.equal(db.isTransaction,true);throw conflict;}}),{code:'AI_SALES_VIDEO_STATE_CONFLICT'});
  assert.throws(()=>refundHold(hold,{assertRefundable:()=>Promise.resolve(true)}),{code:'CREDIT_HOLD_INTEGRITY_MISMATCH'});
  assert.deepEqual(snapshot(),state);
  refundHold(hold,{assertRefundable:row=>assert.equal(row.id,hold.holdId)});
  assert.equal(q.get('SELECT ai_mode FROM credit_logs WHERE id=?',hold.logId).ai_mode,'failed');invariant();
});

test('外层业务事务退款可整体回滚，不在提交前发布或留下部分账目',()=>{
  const hold=create(),before=snapshot();
  assert.throws(()=>refundHold(hold,{manageTransaction:false}),{code:'CREDIT_HOLD_INTEGRITY_MISMATCH'});
  db.exec('BEGIN IMMEDIATE');refundHold(hold,{manageTransaction:false});db.exec('ROLLBACK');
  assert.deepEqual(snapshot(),before);
  db.exec('BEGIN IMMEDIATE');refundHold(hold,{manageTransaction:false});db.exec('COMMIT');
  assert.ok(getSupplierExpense(hold.holdId,tenant).refundedAt);invariant();
});

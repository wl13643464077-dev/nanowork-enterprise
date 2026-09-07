import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nw-360-cost-'));
Object.assign(process.env,{NANOWORK_DB:path.join(dir,'test.db'),NODE_ENV:'test',NANOWORK_TEST_TEMPLATE_AI:'1',
  SEED_DEMO:'false',ENABLE_SCHEDULER:'false',NANOWORK_AI_PROVIDER:'360',YUNWU_BASE_URL:'https://api.360.cn/v1',YUNWU_API_KEY:''});
const {read360Cost,normalize360ReceiptId,valid360Receipt}=await import('../src/engines/provider-360-cost.js');
const {aggregateSupplierCosts}=await import('../src/engines/provider-cost-receipts.js');
const {db,q,initSchema,migrateV2,setConfig}=await import('../src/db.js');
const c=await import('../src/engines/credits.js');
initSchema();migrateV2();
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
const model='deepseek/deepseek-v4-flash';
let seq=0;
function response(amount='0.001662') {return {id:`request-${++seq}|upstream-id`,model:`tencent/${model}`,usage:{prompt_tokens:107,completion_tokens:149,amount}};}
const receipt=(amount='0.001662')=>read360Cost({response:response(amount),model});
function actor() {
  const tid=Number(q.run("INSERT INTO tenants(name,status,credits) VALUES('360计费测试','已开通',2000)").lastInsertRowid);
  const uid=Number(q.run("INSERT INTO users(tenant_id,username,password_hash,name,role,status) VALUES(?,?,'x','老板','boss','启用')",tid,`a-${++seq}`).lastInsertRowid);
  return {tid,uid};
}
const hold=a=>c.holdCredits({userId:a.uid,kind:'text',model,feature:'360真实费用',credits:100});
const balance=a=>q.get('SELECT credits FROM tenants WHERE id=?',a.tid).credits;

test('真实360 amount保留人民币与原始请求ID，供应商前缀模型不改变请求模型',()=>{
  const res=response(),cost=read360Cost({response:res,model});
  assert.equal(cost.status,'known');assert.equal(cost.costYuanOverride,0.001662);
  assert.equal(cost.costSource.requestId,normalize360ReceiptId(res.id));
  assert.equal(cost.costSource.actualModel,`tencent/${model}`);assert.ok(valid360Receipt(cost.costSource));
  assert.equal(cost.costSource.rawRequestId,res.id);
  assert.equal(read360Cost({response:response('0'),model}).costYuanOverride,0);
  const video=read360Cost({response:{id:'task^^alibaba/qwen/wan3.0-video^^1',model:'alibaba/qwen/wan3.0-video',usage:{amount:'6'}},model:'alibaba/wan3.0-video'});
  assert.equal(video.costYuanOverride,6);assert.ok(valid360Receipt(video.costSource));
});

test('缺失、非法金额、错误模型/币种/请求ID/来源不伪造回执',()=>{
  for(const amount of [null,undefined,'',true,-1,Infinity,'NaN','1e3','-0.1',' 0.1','01','100000000']) {
    const res=response();res.usage.amount=amount;
    assert.equal(read360Cost({response:res,model}).status,'pending',String(amount));
  }
  for(const patch of [{error:{}},{id:'\n'},{model:'foreign/model'},{model:42},{usage:{amount:'1',currency:'USD'}}])
    assert.equal(read360Cost({response:{...response(),...patch},model}).status,'pending');
  for(const baseUrl of ['https://api.openlux.ai/v1','http://api.360.cn/v1','https://key@api.360.cn/v1'])
    assert.equal(read360Cost({response:response(),model,baseUrl}).status,'pending');
});

test('逐调用金额聚合，不把同一回执重复计入或把待核金额按0处理',()=>{
  const a=receipt('1.25'),b=receipt('0.75');
  const total=aggregateSupplierCosts([a,b]);
  assert.equal(total.costYuanOverride,2);assert.equal(total.costSource.provider,'360');
  assert.equal(total.costSource.receipts.length,2);
  assert.equal(aggregateSupplierCosts([a,a]).status,'pending');
  assert.equal(aggregateSupplierCosts([a,{status:'pending'}]).status,'pending');
  const bad={...b,costSource:{...b.costSource,reportedAmount:'9'}};
  assert.equal(aggregateSupplierCosts([a,bad]).status,'pending');
});

test('新360价目只作预占，售价固定2倍；不沿用旧供应商单价',()=>{
  setConfig('billing',{marginMultiplier:7,creditYuan:0.01,text:{[model]:{in:999,out:999}}});
  const b=c.billing();assert.equal(b.marginMultiplier,2);assert.equal(b.text[model].in,3);
  assert.equal(b.text[model].out,9);assert.equal(b.supplier,'360');
  const a=actor(),h=hold(a);
  const pricing=JSON.parse(q.get('SELECT pricing_snapshot_json FROM credit_holds WHERE id=?',h.holdId).pricing_snapshot_json);
  assert.equal(pricing.supplierCostPolicy.basis,'upstream_debit');
  c.refundHold(h);
});

test('360实扣2元则余额扣4元，退款全退用户且保留供应商成本',()=>{
  const a=actor(),h=hold(a),cost=receipt('2');
  const result=c.settleHold(h,{usage:{supplierCosts:[cost]}});
  assert.equal(result.credits,400);assert.equal(balance(a),1600);
  const expense=c.getSupplierExpense(h.holdId,a.tid);
  assert.equal(expense.costYuan,2);assert.equal(expense.costSource.provider,'360');
  assert.equal(c.refundHold(h).refundedCredits,400);assert.equal(balance(a),2000);
  assert.equal(c.refundHold(h).duplicate,true);assert.equal(balance(a),2000);
  assert.equal(c.getSupplierExpense(h.holdId,a.tid).costYuan,2);
});

test('微小金额按最小积分单位一次舍入；重复回执不能扣第二笔',()=>{
  const a=actor(),h=hold(a),cost=receipt();
  assert.equal(c.settleHold(h,{usage:{supplierCosts:[cost]}}).credits,1);
  assert.equal(balance(a),1999);
  const another=hold(a);
  assert.throws(()=>c.settleHold(another,{usage:{supplierCosts:[cost]}}),{code:'BILLING_SUPPLIER_RECEIPT_REUSED'});
  c.refundHold(another);assert.equal(balance(a),1999);
});

test('无费用证据不得用旧估价结算；退款释放全部预占',()=>{
  const a=actor(),h=hold(a),before=balance(a);
  assert.throws(()=>c.settleHold(h,{usage:{inputTokens:100,outputTokens:100}}),{code:'BILLING_SUPPLIER_COST_PENDING'});
  assert.equal(balance(a),before);c.refundHold(h);assert.equal(balance(a),2000);
});

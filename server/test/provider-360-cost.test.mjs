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
const imageModel='openai/gpt-image-2';
let seq=0;
function response(amount='0.001662') {return {id:`request-${++seq}|upstream-id`,model:`tencent/${model}`,usage:{prompt_tokens:107,completion_tokens:149,amount}};}
function imageResponse({amount='0.2403765',created=1788800989,url='https://p0.qhimg.com/example-image-a.png',actualModel=`mm/${imageModel}`}={}) {
  return {created,data:[{url,revised_prompt:''}],usage:{total_tokens:1786,input_tokens:30,output_tokens:1756,amount},model:actualModel};
}
const receipt=(amount='0.001662')=>read360Cost({response:response(amount),model});
const changeLast=value=>`${value.slice(0,-1)}${value.endsWith('0')?'1':'0'}`;
function actor() {
  const tid=Number(q.run("INSERT INTO tenants(name,status,credits) VALUES('360计费测试','已开通',2000)").lastInsertRowid);
  const uid=Number(q.run("INSERT INTO users(tenant_id,username,password_hash,name,role,status) VALUES(?,?,'x','老板','boss','启用')",tid,`a-${++seq}`).lastInsertRowid);
  return {tid,uid};
}
const hold=a=>c.holdCredits({userId:a.uid,kind:'text',model,feature:'360真实费用',credits:100});
const imageHold=a=>c.holdCredits({userId:a.uid,kind:'image',model:imageModel,feature:'360 Image2真实费用',credits:400});
const balance=a=>q.get('SELECT credits FROM tenants WHERE id=?',a.tid).credits;

test('真实360 amount保留人民币与原始请求ID，供应商前缀模型不改变请求模型',()=>{
  const res=response(),cost=read360Cost({response:res,model});
  assert.equal(cost.status,'known');assert.equal(cost.costYuanOverride,0.001662);
  assert.equal(cost.costSource.requestId,normalize360ReceiptId(res.id));
  assert.equal(cost.costSource.actualModel,`tencent/${model}`);assert.ok(valid360Receipt(cost.costSource));
  assert.equal(cost.costSource.rawRequestId,res.id);
  const legacy={...cost.costSource};delete legacy.identityType;
  assert.ok(valid360Receipt(legacy),'升级前已落库的360请求ID回执继续有效');
  assert.equal(read360Cost({response:response('0'),model}).costYuanOverride,0);
  const video=read360Cost({response:{id:'task^^alibaba/qwen/wan3.0-video^^1',model:'alibaba/qwen/wan3.0-video',usage:{amount:'6'}},model:'alibaba/wan3.0-video'});
  assert.equal(video.costYuanOverride,6);assert.ok(valid360Receipt(video.costSource));
});

test('Image2成功响应没有上游ID时，以明确标注的响应指纹核验真实人民币金额',()=>{
  const res=imageResponse(),cost=read360Cost({response:res,model:imageModel});
  assert.equal(cost.status,'known');assert.equal(cost.costYuanOverride,0.2403765);
  assert.match(cost.requestId,/^360-response-[a-f0-9]{64}$/);
  assert.equal(cost.costSource.identityType,'response_fingerprint');
  assert.equal(cost.costSource.rawRequestId,null);
  assert.equal(cost.costSource.responseCreated,res.created);
  assert.equal(cost.costSource.responseOutputCount,1);
  assert.deepEqual(cost.costSource.responseOutputDigests.map(value=>value.replace(/[a-f0-9]{64}$/,'<sha256>')),
    ['0:url-sha256:<sha256>']);
  assert.ok(valid360Receipt(cost.costSource));

  const repeated=read360Cost({response:structuredClone(res),model:imageModel});
  assert.equal(repeated.requestId,cost.requestId);
  assert.equal(repeated.costSource.responseFingerprint,cost.costSource.responseFingerprint);
  const changed=read360Cost({response:imageResponse({created:res.created,url:'https://p0.qhimg.com/example-image-b.png'}),model:imageModel});
  assert.notEqual(changed.requestId,cost.requestId);
});

test('Image2响应指纹不能被篡改，也不能替代错误模型、缺失金额或不完整响应',()=>{
  const source=read360Cost({response:imageResponse(),model:imageModel}).costSource;
  for(const patch of [
    {requestId:changeLast(source.requestId)},
    {responseFingerprint:changeLast(source.responseFingerprint)},
    {responseCreated:source.responseCreated+1},
    {responseOutputCount:2},
    {responseOutputDigests:['0:url-sha256:'+''.padStart(64,'0')]},
    {identityType:'upstream_request_id'},
    {rawRequestId:'fabricated-upstream-id'},
  ]) assert.equal(valid360Receipt({...source,...patch}),false,JSON.stringify(patch));

  assert.equal(read360Cost({response:imageResponse({actualModel:'foreign/image-model'}),model:imageModel}).status,'pending');
  const noAmount=imageResponse();delete noAmount.usage.amount;
  assert.equal(read360Cost({response:noAmount,model:imageModel}).status,'pending');
  const noCreated=imageResponse();delete noCreated.created;
  assert.equal(read360Cost({response:noCreated,model:imageModel}).status,'pending');
  const noReportedModel=imageResponse();delete noReportedModel.model;
  assert.equal(read360Cost({response:noReportedModel,model:imageModel}).status,'pending');
  const nonImage={created:1788800989,data:[{url:'https://p0.qhimg.com/not-a-chat-receipt.png'}],usage:{amount:'1'},model};
  assert.equal(read360Cost({response:nonImage,model}).status,'pending');
});

test('Image2响应身份跨账单去重，新响应可独立按usage.amount结算且审计字段入库',()=>{
  const a=actor(),first=imageResponse(),cost=read360Cost({response:first,model:imageModel});
  const firstHold=imageHold(a);
  const settled=c.settleHold(firstHold,{model:imageModel,usage:{images:1,supplierCosts:[cost]}});
  assert.equal(settled.credits,49);
  const expense=c.getSupplierExpense(firstHold.holdId,a.tid);
  assert.equal(expense.costYuan,0.2403765);
  assert.equal(expense.costSource.receipts[0].identityType,'response_fingerprint');
  assert.equal(expense.costSource.receipts[0].rawRequestId,null);
  assert.equal(expense.costSource.receipts[0].responseCreated,first.created);

  const duplicate=imageHold(a);
  assert.throws(()=>c.settleHold(duplicate,{model:imageModel,usage:{images:1,supplierCosts:[
    read360Cost({response:structuredClone(first),model:imageModel}),
  ]}}),{code:'BILLING_SUPPLIER_RECEIPT_REUSED'});
  c.refundHold(duplicate);

  const next=imageHold(a),nextCost=read360Cost({response:imageResponse({created:first.created+1}),model:imageModel});
  assert.notEqual(nextCost.requestId,cost.requestId);
  assert.equal(c.settleHold(next,{model:imageModel,usage:{images:1,supplierCosts:[nextCost]}}).credits,49);
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

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dbPath=path.join(os.tmpdir(),`nanowork-toolbox-stale-refund-${process.pid}.db`);
process.env.NANOWORK_DB=dbPath;
const {db,q,initSchema,migrateV2,runWithTenant}=await import('../src/db.js');
const {holdCredits,getSupplierExpense}=await import('../src/engines/credits.js');
const {recoverStaleToolboxRuns}=await import('../src/engines/scheduler.js');
initSchema();migrateV2();
q.run("UPDATE tenants SET credits=100000,status='已开通' WHERE id=1");
const userId=Number(q.run("INSERT INTO users(tenant_id,username,password_hash,name,role,status) VALUES(1,?,'x','隔离恢复','boss','启用')",`stale-${process.pid}`).lastInsertRowid);
const now=new Date('2030-01-01T12:00:00Z');
function fixture({called=true,output=false,recent=false}={}){
  const runId=Number(q.run(`INSERT INTO tool_runs(tenant_id,tool_key,tool_title,title,status,employee_idx,employee_name,created_by,input_json,input_summary,result_md,provenance_json,progress_json,execution_state,timeout_at,updated_at)
    VALUES(1,'shot','主图','恢复测试','running',140,'测试员工',?,'{}','输入',?,?,?,? ,?,?)`,userId,
    output?'# 可用真实成果':'# 工具运行中',JSON.stringify({workerToken:'old',persisted:output}),JSON.stringify(called?[{phase:'media_provider'}]:[{phase:'queued'}]),
    called?'running':'queued',recent?'2031-01-01 00:00:00':'2029-01-01 00:00:00','2029-01-01 00:00:00').lastInsertRowid);
  const hold=runWithTenant(1,()=>holdCredits({userId,tenantId:1,kind:'image',model:'gpt-image-2',feature:'隔离工具恢复',credits:20,refType:'tool_run',refId:runId}));
  return {runId,hold};
}
test('过期无成果外调任务原子全退，平台成本pending，重复恢复不加余额',()=>{
  const {runId,hold}=fixture();const before=q.get('SELECT credits FROM tenants WHERE id=1').credits;
  const report=runWithTenant(1,()=>recoverStaleToolboxRuns(now));
  assert.equal(report.find(x=>x.runId===runId)?.action,'timeout_recovery_released');
  assert.equal(q.get('SELECT status FROM tool_runs WHERE id=?',runId).status,'failed');
  assert.ok(getSupplierExpense(hold.holdId,1)?.refundedAt);
  assert.equal(getSupplierExpense(hold.holdId,1)?.status,'pending');
  assert.equal(getSupplierExpense(hold.holdId,1)?.costYuan,null);
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits,before+20);
  runWithTenant(1,()=>recoverStaleToolboxRuns(now));
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits,before+20);
});
test('未调用排队仅释放；有正文及未过期任务保留，不冒充失败',()=>{
  const queued=fixture({called:false}),saved=fixture({output:true}),live=fixture({recent:true});
  const report=runWithTenant(1,()=>recoverStaleToolboxRuns(now));
  assert.equal(report.find(x=>x.runId===saved.runId)?.action,'preserve_existing_output');
  assert.equal(report.some(x=>x.runId===live.runId),false);
  assert.equal(getSupplierExpense(queued.hold.holdId,1),null,'本地释放保留旧零调用流水，不制造供应商失败');
  for(const item of [saved,live]) assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?',item.hold.holdId).status,'held');
  assert.equal(q.get('SELECT result_md FROM tool_runs WHERE id=?',saved.runId).result_md,'# 可用真实成果');
});
test('任务失败状态落库异常时退款同事务回滚，余额不误加',()=>{
  const {runId,hold}=fixture();const before=q.get('SELECT credits FROM tenants WHERE id=1').credits;
  db.exec(`CREATE TEMP TRIGGER toolbox_refund_block BEFORE UPDATE OF status ON tool_runs WHEN NEW.id=${runId} AND NEW.status='failed' BEGIN SELECT RAISE(ABORT,'fixture state failure'); END`);
  try{
    const report=runWithTenant(1,()=>recoverStaleToolboxRuns(now));
    assert.equal(report.find(x=>x.runId===runId)?.action,'toolbox_timeout_recovery_failed');
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits,before);
    assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?',hold.holdId).status,'held');
    assert.equal(getSupplierExpense(hold.holdId,1),null);
  }finally{db.exec('DROP TRIGGER toolbox_refund_block');}
});
after(()=>{db.close();for(const suffix of['','-wal','-shm'])fs.rmSync(dbPath+suffix,{force:true});});

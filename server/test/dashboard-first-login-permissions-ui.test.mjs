import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const requireWeb=createRequire(new URL('../../web/package.json',import.meta.url));
const ts=requireWeb('typescript');
const read=file=>fs.readFileSync(new URL(`../../${file}`,import.meta.url),'utf8');
const source=read('web/src/hooks/useDashboardFeishu.ts');
function mount(role,modules) {
  const requests=[], effects=[], updates=[];
  let resolveRequest;
  const exports={};
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','exports',compiled)(name=>{
    if(name==='react')return {useState:()=>[null,value=>updates.push(value)],useEffect:effect=>effects.push(effect)};
    if(name==='../api/client')return {api:{get:url=>{requests.push(url);return new Promise(resolve=>{resolveRequest=resolve;});}}};
    throw new Error(`Unexpected dependency ${name}`);
  },exports);
  const result=exports.useDashboardFeishu(role,modules);
  const cleanup=effects[0]();
  return {result,requests,updates,cleanup,resolve:value=>resolveRequest(value)};
}
const modules=['dashboard','activities','system','analysis','growth','marshals'];
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('邀请码新店长首次挂载首页，即使有系统菜单也不读取越权的飞书配置',()=>{
  for(const role of ['manager','sales','partner','platform_super',undefined]) {
    const ui=mount(role,modules);
    assert.deepEqual(ui.requests,[],`${role} 不应触发 /sys/feishu`);
    assert.equal(ui.result.enabled,false);
    assert.equal(ui.result.data,null);
  }
});

test('老板/运营负责人/管理员只有同时具有活动和系统模块才自动读取飞书配置',async()=>{
  for(const role of ['boss','ops_director','admin']) {
    const ui=mount(role,modules);
    assert.deepEqual(ui.requests,['/sys/feishu']);assert.equal(ui.result.enabled,true);
    ui.resolve({appReady:true});await flush();assert.deepEqual(ui.updates,[{appReady:true}]);
    for(const deniedModules of [['dashboard','system'],['dashboard','activities'],['dashboard']]) {
      assert.deepEqual(mount(role,deniedModules).requests,[]);
    }
  }
});

test('首页卸载后旧配置响应不再写入，配置入口跟随同一请求权限而活动入口保留',async()=>{
  const ui=mount('boss',modules);ui.cleanup();ui.resolve({appReady:true});await flush();assert.deepEqual(ui.updates,[]);
  const dashboard=read('web/src/pages/Dashboard.tsx');
  assert.match(dashboard,/useDashboardFeishu\(role, userModules\)/);
  assert.match(dashboard,/canViewFeishuConfig && \([\s\S]*?<Link to="\/system"/);
  assert.match(dashboard,/<Link style=\{\{ fontSize: 12 \}\} to="\/activities">/);
  assert.doesNotMatch(dashboard,/\.get\('\/sys\/feishu'\)/);
  const route=read('server/src/routes/system.js');
  assert.match(route,/"\/feishu",\s*requireRole\("boss", "ops_director", "admin"\)/);
});

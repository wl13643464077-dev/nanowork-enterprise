import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = requireWeb('typescript');
const read = file => fs.readFileSync(new URL(`../../web/src/${file}`, import.meta.url), 'utf8');
const jsx = (type, props) => ({type, props});
const component = name => Object.assign(function MockComponent() {}, {displayName:name});
const Form = component('Form');
Form.Item = component('Form.Item');
Form.useForm = () => [{}];
const Input = component('Input');
Input.Password = component('Input.Password');
const ant = new Proxy({Form,Input}, {get(target,key) { return target[key] ||= component(String(key)); }});
function load(file, hooks = {}, api = {}) {
  const module = {exports:{}};
  const source = read(file).replace(/^import ['"].*\.css['"];?$/gm,'');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const dependencies = name => {
    if(name==='react')return hooks;
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};
    if(name==='antd')return ant;
    if(name==='@ant-design/icons')return new Proxy({}, {get:(_,key)=>component(String(key))});
    if(name==='react-router-dom')return {useNavigate:()=>()=>{}};
    if(name.includes('/api/client'))return {api};
    if(name.includes('AuthShell'))return {default:component('AuthShell'),AuthBrand:component('AuthBrand'),TrustMarks:component('TrustMarks')};
    throw new Error(`Unexpected dependency ${name}`);
  };
  new Function('require','module','exports',compiled)(dependencies,module,module.exports);
  return module.exports;
}
const pureRegister=load('pages/Register.tsx');
const manager=load('components/InvitationManager.tsx');
function all(node, predicate, found=[]) {
  if(Array.isArray(node)){node.forEach(item=>all(item,predicate,found));return found;}
  if(!node || typeof node!=='object')return found;
  if(predicate(node))found.push(node);
  all(node.props?.children,predicate,found);
  return found;
}
const find = (tree,name) => all(tree,node=>node.type?.displayName===name)[0];
function harness() {
  const values=[]; let cursor=0;
  const calls=[]; const pending=[];
  const hooks={
    useState(initial){const index=cursor++;if(!(index in values))values[index]=typeof initial==='function'?initial():initial;return [values[index],value=>{values[index]=typeof value==='function'?value(values[index]):value;}];},
    useRef(initial){const index=cursor++;return values[index] ||= {current:initial};},
    useCallback(fn){return fn;},useEffect(){},
  };
  const api={post(url,body){calls.push({url,body});return new Promise((resolve,reject)=>pending.push({resolve,reject}));}};
  const Register=load('pages/Register.tsx',hooks,api).default;
  globalThis.window={location:{hash:'',search:''}};
  return {calls,pending,render(){cursor=0;return Register();}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const invitation = {valid:true,type:'existing_tenant',tenantName:'山禾餐厅',roleLabel:'员工',expiresAt:'2026-09-12T00:00:00Z'};
const registration={contactName:'测试成员',phone:'13800000000',username:'member_0905',password:'sample-pass-0905',company:'不应覆盖企业',role:'platform_super',tenantId:999};
function codeInput(tree){return all(tree,node=>node.props?.id==='register-invite-code')[0];}
function checkButton(tree){return all(tree,node=>node.type?.displayName==='Button' && node.props.children==='核验邀请码')[0];}

test('邀请链接只携带 fragment，编码和解析保持完整原码',()=>{
  const code='NW-AB+CD/EF=';
  const url=new URL(manager.invitationLink(code,'https://work.example.com/'));
  assert.equal(url.pathname,'/register');assert.equal(url.search,'');
  assert.equal(pureRegister.invitationCodeFromHash(url.hash),code);
  assert.equal(pureRegister.invitationCodeFromHash('#auth-card'),'');
});

test('企业创建请求固定 existing，不提交其他企业/积分/平台开通参数；默认一次七天',()=>{
  const now=Date.parse('2026-09-05T00:00:00Z');
  const payload=manager.invitationCreatePayload('tenant',{type:'new_tenant',tenantId:999,role:'sales',credits:99999},now);
  assert.deepEqual(payload,{type:'existing_tenant',role:'sales',maxUses:1,expiresAt:'2026-09-12T00:00:00.000Z'});
  const fresh=manager.invitationCreatePayload('platform',{type:'new_tenant',role:'admin',tenantId:3},now);
  assert.deepEqual(fresh,{type:'new_tenant',maxUses:1,expiresAt:'2026-09-12T00:00:00.000Z'});
  const member=manager.invitationCreatePayload('platform',{type:'existing_tenant',role:'manager',tenantId:3,maxUses:4,daysValid:30},now);
  assert.equal(member.tenantId,3);assert.equal(member.role,'manager');assert.equal(member.maxUses,4);
});

test('注册请求按邀请码绑定企业，失效预检不能回退普通申请',()=>{
  const body=pureRegister.registrationPayload('invite',registration,' CODE-1 ',invitation);
  assert.equal(body.inviteCode,'CODE-1');
  for(const key of ['company','role','tenantId','credits'])assert.equal(Object.hasOwn(body,key),false);
  assert.throws(()=>pureRegister.registrationPayload('invite',registration,'CODE-1',null),/核验/);
  assert.equal(pureRegister.registrationPayload('invite',registration,'CODE-2',{...invitation,type:'new_tenant'}).company,registration.company);
  assert.equal(Object.hasOwn(pureRegister.registrationPayload('apply',registration,'CODE-1',invitation),'inviteCode'),false);
});

test('实际注册组件改码即失效，旧异步预检不会覆盖当前码，也不按每字发请求',async()=>{
  const ui=harness();let tree=ui.render();
  codeInput(tree).props.onChange({target:{value:'OLD'}});tree=ui.render();
  assert.equal(ui.calls.length,0);checkButton(tree).props.onClick();
  tree=ui.render();codeInput(tree).props.onChange({target:{value:'NEW'}});tree=ui.render();
  ui.pending[0].resolve(invitation);await tick();tree=ui.render();
  assert.equal(all(tree,node=>node.type?.displayName==='Form' && node.props.onFinish).length,0);
  assert.equal(codeInput(tree).props.value,'NEW');
  checkButton(tree).props.onClick();ui.pending[1].resolve(invitation);await tick();tree=ui.render();
  assert.ok(find(tree,'Form'));
  assert.equal(all(tree,node=>node.props?.name==='company').length,0);
  assert.equal(ui.calls.length,2);
});

test('实际注册组件既有企业提交带码且成功可登录，邀请码失败不触发无邀请码重试',async()=>{
  const ui=harness();let tree=ui.render();codeInput(tree).props.onChange({target:{value:'MEMBER'}});tree=ui.render();checkButton(tree).props.onClick();ui.pending[0].resolve(invitation);await tick();
  tree=ui.render();const submit=find(tree,'Form').props.onFinish;const request=submit(registration);
  assert.equal(ui.calls[1].url,'/auth/register');assert.equal(ui.calls[1].body.inviteCode,'MEMBER');assert.equal(Object.hasOwn(ui.calls[1].body,'company'),false);
  ui.pending[1].reject(new Error('邀请码已用完'));await request;tree=ui.render();assert.equal(ui.calls.length,2);
  const second=find(tree,'Form').props.onFinish(registration);ui.pending[2].resolve({ok:true,canLogin:true,message:'账号已开通'});await second;tree=ui.render();
  assert.equal(find(tree,'Result').props.title,'注册完成');assert.equal(find(tree,'Result').props.subTitle,'账号已开通');
});

test('普通企业申请仍可显式选择，成功提示待审核而非已开通',async()=>{
  const ui=harness();let tree=ui.render();find(tree,'Segmented').props.onChange('apply');tree=ui.render();
  assert.ok(all(tree,node=>node.props?.name==='company').length);
  const request=find(tree,'Form').props.onFinish(registration);
  assert.equal(Object.hasOwn(ui.calls[0].body,'inviteCode'),false);
  ui.pending[0].resolve({ok:true,canLogin:false,registrationType:'application'});await request;
  assert.equal(find(ui.render(),'Result').props.title,'开通申请已提交');
});

test('入口权限与一次回显契约：企业只挂 tenant 管理器，列表用掩码，更多选项默认关闭',()=>{
  assert.match(read('pages/Admin.tsx'),/tab === 'invitations' && <InvitationManager scope="tenant"/);
  assert.match(read('pages/Platform.tsx'),/tab === '邀请码' && <InvitationManager scope="platform"/);
  const source=read('components/InvitationManager.tsx');
  assert.match(source,/if \(scope !== 'platform'\) return/);
  assert.match(source,/item\.codeMasked/);assert.doesNotMatch(source,/item\.code\b|localStorage|sessionStorage/);
  assert.match(source,/<details className="invitation-options">/);
  assert.match(source,/MEMBER_ROLES\.has\(item\.role\)/);
});


test('登录面板同时提供邀请码注册与独立企业申请，落地页企业申请直达旧申请模式',()=>{
  const login=read('pages/Login.tsx');
  assert.match(login,/className="au-link" onClick=\{\(\) => nav\('\/register'\)\}>\s*邀请码注册/u);
  assert.match(login,/className="au-link" onClick=\{\(\) => nav\('\/register\?mode=apply'\)\}>\s*申请开通/u);
  assert.match(login,/className="lp-cta-ghost" onClick=\{\(\) => nav\('\/register\?mode=apply'\)\}>\s*申请企业开通/u);
});

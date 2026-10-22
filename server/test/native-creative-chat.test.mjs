import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';

Object.assign(process.env, { NANOWORK_DB: ':memory:', NANOWORK_TEST_TEMPLATE_AI: '1', NODE_ENV: 'test', ENABLE_SCHEDULER: 'false', ENABLE_BACKGROUND_EMBEDDINGS: 'false', YUNWU_API_KEY: '', OPENAI_API_KEY: '' });
globalThis.fetch = async () => { throw new Error('专项禁止真实付费/网络调用'); };
const { db, q, initSchema, migrateV2, runWithTenant, setTenantConfig } = await import('../src/db.js');
const { saveUploadedFile } = await import('../src/engines/filehub.js');
const { createNativeChatSession, publicNativeChatSession, listNativeChatSessions, sendNativeChatMessage, confirmNativeChatPlan, nativeChatOptionsFromMessage, revalidateNativeChatPlan } = await import('../src/engines/native-creative-chat.js');
const { approvedNativeChatPlan, nativeChatHash } = await import('../src/engines/native-creative-chat-store.js');
const { buildContentStoreFactPack } = await import('../src/engines/content-store-facts.js');
const { voicedSalesSettlement, salesVideoPriceQuote } = await import('../src/engines/ai-sales-video-native.js');
initSchema(); migrateV2();
q.run("UPDATE tenants SET credits=1000000,status='已开通' WHERE id=1");
q.run("INSERT INTO tenants(id,name,status,credits) VALUES(2,'隔离企业','已开通',1000000)");
const actors = [];
for (const [name, role, tenant] of [['chat-boss','boss',1],['chat-staff','sales',1],['foreign','boss',2]]) {
  q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES(?,'x',?,?,?,'启用')",name,name,role,tenant);
  actors.push(q.get('SELECT id,role,tenant_id,name FROM users WHERE username=?',name));
}
const [actor, staff, foreign] = actors;
const pic = runWithTenant(1, () => saveUploadedFile({ name:'chat-food.png', b64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', userId:actor.id }).row);
after(async () => { for (const row of q.all('SELECT file_path FROM uploaded_files')) if(row.file_path) await fs.rm(row.file_path,{force:true}); db.close(); });
const within = work => runWithTenant(1,work);
function script(tail='下次聚餐，欢迎到店看看。', durationSeconds=30) {
  const words=durationSeconds===15?['今天吃什么？热气正在往上冒。'+tail]:['今天吃什么？热气正在往上冒。',tail];
  return { hook_3s:'今天吃什么？', shots:words.map((voiceover,i)=>({index:i+1,start:i*15,end:(i+1)*15,visual:i?'门头画面缓慢推近':'原图菜品缓慢推近',voiceover,subtitle:voiceover,sfx:'轻柔环境音',reference_hint:i?'storefront':'dish'})),cta:tail,facts_used:[],total_chars:30,estimated_seconds:12,risk_flags:[] };
}
function reply({ready=true,tail,durationSeconds=30}={}) { return {reply:ready?'先给您自然口播，请看脚本后确认；可以继续告诉我修改意见。':'这次推广哪个品牌？也可以先发门头照片。',ready,brandName:ready?'小锅馆':'',brief:'仅按本次小锅馆照片介绍，邀请到店',summary:`${durationSeconds}秒原生中文独白`,script:ready?script(tail,durationSeconds):null,output:null}; }
function runtimeFor(output, capture=[]) { return { generate:async params=>{ capture.push(params); return {mode:'api',model:params.model,text:JSON.stringify(output),usage:{inputTokens:1000,outputTokens:500}}; } }; }
const send = (session, key, output, other={}) => within(()=>sendNativeChatMessage({actor,sessionId:session.id,message:'品牌叫小锅馆，按照片给我一个自然的脚本。',fileIds:[pic.id],options:{durationSeconds:output?.script?.shots?.length===1?15:30},requestKey:key,runtime:runtimeFor(output),...other}));

test('新15秒照片会话省略冲突技能，视频与小红书只接收各自的输出指导',async()=>{
  const previous=q.get('SELECT skills_json,revision FROM content_employee_workbench_configs WHERE tenant_id=1 AND employee_idx=10');
  const skills=[
    {id:'content-custom:10:legacy-funnel',title:'旧营销方法',detail:'用AIDA、PAS和社会证明搭配高留存钩子。',enabled:true},
    {id:'content-custom:10:legacy-duration',title:'旧制作方法',detail:'30秒分两段15秒，使用预设音色。',enabled:true},
    {id:'content-custom:10:motion-kept',title:'菜品细节',detail:'KEEP_FOOD_MOTION 仅让画面内主体产生细微运动。',enabled:true},
  ];
  q.run(`INSERT INTO content_employee_workbench_configs(tenant_id,employee_idx,skills_json,revision) VALUES(1,10,?,8)
    ON CONFLICT(tenant_id,employee_idx) DO UPDATE SET skills_json=excluded.skills_json,revision=excluded.revision`,JSON.stringify(skills));
  try {
    const video=within(()=>createNativeChatSession(actor,10)),calls=[];
    const result=await send(video,'short_video_scoped_skills',reply({durationSeconds:15}),{runtime:runtimeFor(reply({durationSeconds:15}),calls)});
    assert.equal(result.currentPlan.ready,true);
    assert.match(calls[0].system,/KEEP_FOOD_MOTION/u);
    assert.doesNotMatch(calls[0].system,/AIDA|PAS|社会证明|预设音色|generatedImagePlan|imageRoles|小红书/u);
    const stored=JSON.parse(q.get('SELECT plan_json FROM native_chat_plans WHERE session_id=? AND version=1',video.id).plan_json);
    assert.equal(stored.skills.omittedSkills.length,2);
    assert.equal(stored.skills.methodScope,'native_sales_video_15s_single_reference');
    assert.equal(q.get('SELECT skills_json FROM content_employee_workbench_configs WHERE tenant_id=1 AND employee_idx=10').skills_json,JSON.stringify(skills));
    const xhs=within(()=>createNativeChatSession(actor,11)),xhsCalls=[];
    await send(xhs,'xhs_only_output_guidance',reply({ready:false}),{options:{},runtime:runtimeFor(reply({ready:false}),xhsCalls)});
    assert.match(xhsCalls[0].system,/output\.generatedImagePlan/u);
    assert.doesNotMatch(xhsCalls[0].system,/hook_3s|15秒仅一段|普通话女声/u);
    assert.deepEqual(JSON.parse(q.get('SELECT plan_json FROM native_chat_plans WHERE session_id=? AND version=1',video.id).plan_json),stored,'创建别的方案不能改写已保存的脚本');
  } finally {
    if(previous)q.run('UPDATE content_employee_workbench_configs SET skills_json=?,revision=? WHERE tenant_id=1 AND employee_idx=10',previous.skills_json,previous.revision);
    else q.run('DELETE FROM content_employee_workbench_configs WHERE tenant_id=1 AND employee_idx=10');
  }
});

test('照片创作只注入门店主数据，误存品牌资料的新闻不进入首轮及确认后的事实包', async()=>{
  const pollution='不相关的今日新闻，仅为上下文隔离测试';
  const doc=Number(q.run("INSERT INTO kb_docs(tenant_id,category,title,body,enabled) VALUES(1,'品牌资料','趋势简报',?,1)",pollution).lastInsertRowid);
  try {
    assert.ok(within(()=>buildContentStoreFactPack(1)).facts.some(fact=>fact.sourceId===doc&&fact.source==='kb_docs'),'共用事实包默认行为保持兼容');
    for (const employeeIdx of [10,11]) {
      const session=within(()=>createNativeChatSession(actor,employeeIdx)),calls=[];
      const output=employeeIdx===10?reply({durationSeconds:15}):{...reply({ready:false}),brandName:'小锅馆'};
      const ready=await send(session,`photo_context_scoped_${employeeIdx}`,output,{runtime:runtimeFor(output,calls)});
      assert.equal(ready.currentPlan.ready,employeeIdx===10);
      assert.doesNotMatch(JSON.stringify(calls),new RegExp(pollution));
      const row=q.get('SELECT plan_json FROM native_chat_plans WHERE session_id=? AND version=?',session.id,ready.currentPlan.version);
      const plan=JSON.parse(row.plan_json);
      assert.equal(plan.grounding.storeFacts.facts.some(fact=>fact.source==='kb_docs'),false);
      assert.doesNotMatch(plan.grounding.storeFactsPrompt,new RegExp(pollution));
      assert.ok(plan.grounding.storeFacts.facts.some(fact=>fact.kind==='store_name'&&fact.value==='小锅馆'),'本轮明确品牌仍然保留');
    }
  } finally { q.run('DELETE FROM kb_docs WHERE id=?',doc); }
});

test('真实视觉对话先交付脚本、普通消息不创建媒体，重复请求只结算一次', async()=>{
  const session=within(()=>createNativeChatSession(actor,10)),calls=[];
  const params={actor,sessionId:session.id,message:'品牌叫小锅馆，请生成30秒视频',fileIds:[pic.id],requestKey:'chat_message_001',runtime:runtimeFor(reply(),calls)};
  const a=await within(()=>sendNativeChatMessage(params));
  assert.equal(a.status,'ready'); assert.equal(a.messages.length,2); assert.equal(a.currentPlan.ready,true);
  assert.equal(a.files[0].id,pic.id); assert.equal(a.currentPlan.script.shots[1].voiceover,script().shots[1].voiceover);
  assert.equal(a.currentPlan.skills,undefined);assert.equal(a.currentPlan.grounding,undefined);
  assert.equal(calls[0].messages[0].content[1].type,'image_url'); assert.match(calls[0].messages[0].content[1].image_url.url,/^data:image\/png;base64,/);
  assert.equal(calls[0].responseSchema.name,'ai_sales_video_chat');
  assert.equal(calls[0].responseSchema.schema.additionalProperties,false);
  assert.deepEqual(calls[0].responseSchema.schema.required,['reply','ready','brandName','brief','summary','script','output']);
  assert.equal(calls[0].responseSchema.schema.properties.script.anyOf[0].properties.shots.maxItems,2);
  assert.equal(q.get('SELECT count(*) AS n FROM media_jobs').n,0);
  const b=await within(()=>sendNativeChatMessage(params)); assert.equal(b.messages.length,2); assert.equal(calls.length,1);
  assert.equal(q.get("SELECT count(*) AS n FROM credit_holds WHERE ref_type='native_chat_message' AND ref_id=?",a.messages[1].id).n,1);
  await assert.rejects(within(()=>sendNativeChatMessage({...params,message:'不同请求'})),/同一请求/);
});

test('会话严格用户和租户隔离；缺品牌时真实自然追问，无表单门',async()=>{
  const session=within(()=>createNativeChatSession(actor,10));
  assert.throws(()=>within(()=>publicNativeChatSession(staff,session.id)),/不存在或无权/);
  assert.throws(()=>runWithTenant(2,()=>publicNativeChatSession(foreign,session.id)),/不存在或无权/);
  assert.deepEqual(within(()=>listNativeChatSessions(staff,10)),[]);
  const result=await within(()=>sendNativeChatMessage({actor,sessionId:session.id,message:'我想宣传店里菜品',requestKey:'ask_brand_001',runtime:runtimeFor(reply({ready:false}))}));
  assert.equal(result.status,'draft'); assert.equal(result.currentPlan.ready,false); assert.match(result.messages[1].content,/哪个品牌/);
});

test('新会话缺省15秒，模型不能擅自扩为30秒；旧无时长快照仍按30秒读取且原哈希不变',async()=>{
  const session=within(()=>createNativeChatSession(actor,10)),calls=[];
  assert.deepEqual(session.options,{durationSeconds:15});
  const params={actor,sessionId:session.id,message:'小锅馆的菜品宣传，脚本你来写',fileIds:[pic.id],requestKey:'default_fifteen',runtime:runtimeFor(reply({durationSeconds:15}),calls)};
  const ready=await within(()=>sendNativeChatMessage(params));
  assert.equal(ready.currentPlan.ready,true);assert.equal(ready.currentPlan.script.shots.length,1);
  assert.equal(ready.currentPlan.options.durationSeconds,15);assert.match(calls[0].system,/15秒仅一段/);
  assert.equal(calls[0].responseSchema.schema.properties.script.anyOf[0].properties.shots.maxItems,1);
  assert.deepEqual(calls[0].responseSchema.schema.properties.script.anyOf[1],{type:'null'},'缺信息仍能自然追问');
  const invalid=await within(()=>sendNativeChatMessage({...params,requestKey:'model_cannot_extend',runtime:runtimeFor(reply())}));
  assert.equal(invalid.currentPlan.options.durationSeconds,15);assert.equal(invalid.currentPlan.ready,false);
  assert.match(invalid.messages.at(-1).rawContent,/30/);
  const old=await send(session,'old_thirty_fixture',reply());
  const row=q.get('SELECT * FROM native_chat_plans WHERE session_id=? AND version=?',session.id,old.currentPlan.version);
  const plan=JSON.parse(row.plan_json);delete plan.options.durationSeconds;
  q.run('UPDATE native_chat_plans SET plan_json=?,plan_hash=? WHERE id=?',JSON.stringify(plan),nativeChatHash(plan),row.id);
  q.run("UPDATE native_chat_sessions SET options_json='{}' WHERE id=?",session.id);
  const before=q.get('SELECT plan_json,plan_hash FROM native_chat_plans WHERE id=?',row.id);
  const restored=within(()=>publicNativeChatSession(actor,session.id));
  assert.equal(restored.options.durationSeconds,30);assert.equal(restored.currentPlan.options.durationSeconds,30);
  assert.deepEqual(q.get('SELECT plan_json,plan_hash FROM native_chat_plans WHERE id=?',row.id),before);
  await assert.rejects(within(()=>sendNativeChatMessage({...params,requestKey:'invalid_duration',options:{durationSeconds:45}})),/不在已支持/);
});

test('供应商未转义引号的付费回复保留全文并解释未ready原因，明确修稿后同会话可确认',async()=>{
  const session=within(()=>createNativeChatSession(actor,10)); let calls=0;
  const original=reply({durationSeconds:15});
  const malformed=JSON.stringify(original).replace(/"reply":"[^"]*"/, '"reply":"口播："周末来聚餐。""');
  const pending=await within(()=>sendNativeChatMessage({actor,sessionId:session.id,message:'品牌叫小锅馆，生成15秒方案',fileIds:[pic.id],requestKey:'malformed_quotes',runtime:{generate:async params=>{
    calls++;return {mode:'api',model:params.model,text:malformed,usage:{inputTokens:1000,outputTokens:500}};
  }}}));
  assert.equal(calls,1,'格式问题不自动触发另一次付费调用');
  assert.equal(pending.currentPlan.ready,false);
  assert.equal(pending.messages.at(-1).rawContent,malformed);
  assert.equal(pending.messages.at(-1).content,malformed);
  assert.equal(pending.messages.at(-1).billing.state,'settled');
  assert.ok(pending.currentPlan.warnings.some(value=>/方案格式不完整/.test(value)));
  await assert.rejects(within(()=>confirmNativeChatPlan({actor,sessionId:session.id,planVersion:1,requestKey:'malformed_confirm'})),/请先完成/);
  const revised=await within(()=>sendNativeChatMessage({actor,sessionId:session.id,message:'品牌仍是小锅馆。请修复JSON格式，保持15秒与原生声音，不添加营业时间和销量。',requestKey:'explicit_revision',runtime:{generate:async params=>{
    calls++; assert.ok(params.responseSchema); assert.match(params.system,/不得自行添加营业中/);
    assert.deepEqual(params.messages.slice(0,-1).map(item=>item.role),['user','assistant']);
    assert.equal(params.messages[1].content,malformed,'旧错误稿保持assistant角色，不能提升为最新user指令');
    assert.equal(params.messages.at(-1).content.length,1,'没有新图的失败稿修订只请求文字，不宣称重新识图');
    assert.match(params.system,/没有重新识图/);
    const payload=JSON.parse(params.messages.at(-1).content[0].text);
    assert.equal(payload.conversation,undefined);
    assert.equal(payload.currentPlan.grounding,undefined);
    assert.equal(payload.currentPlan.skills,undefined);
    assert.match(payload.message,/修复JSON格式/);
    return {mode:'api',model:params.model,text:JSON.stringify(original),usage:{inputTokens:1000,outputTokens:500}};
  }}}));
  assert.equal(calls,2);assert.equal(revised.currentPlan.version,2);assert.equal(revised.currentPlan.ready,true);
  assert.equal(revised.messages[1].rawContent,malformed);
  assert.equal(q.get('SELECT count(*) n FROM media_jobs').n,0,'写稿成功不提前付费生成媒体');
});

test('完整稿的模型ready只是建议：已确认品牌和照片可预览，缺事实或不合法稿仍不可确认',async()=>{
  const session=within(()=>createNativeChatSession(actor,10));
  const output={...reply({durationSeconds:15}),ready:false};
  const valid=await send(session,'advisory_ready_flag',output);
  assert.equal(valid.currentPlan.ready,true);assert.match(valid.currentPlan.warnings.join('；'),/可预览后确认/);
  assert.equal(q.get('SELECT count(*) n FROM media_jobs').n,0);
  const other=within(()=>createNativeChatSession(actor,10));
  const unknown=await send(other,'advisory_unknown_brand',output,{message:'请给我自然脚本，但还没确认店名'});
  assert.equal(unknown.currentPlan.ready,false,'模型自报false不能绕过品牌确认');
  const invalid=structuredClone(output);invalid.script.shots[0].end=30;
  assert.equal((await send(session,'advisory_invalid_script',invalid)).currentPlan.ready,false);
  const missing=structuredClone(output);delete missing.script.shots[0].visual;
  assert.equal((await send(session,'advisory_missing_field',missing)).currentPlan.ready,false);
});

test('明确的视频时长与勾选同步，否定句/镜头时间不扩大费用，更新时长须新版本确认',async()=>{
  assert.deepEqual(nativeChatOptionsFromMessage('做三十秒视频',{durationSeconds:15},10),{durationSeconds:30});
  assert.deepEqual(nativeChatOptionsFromMessage('不要30秒，做十五秒',{durationSeconds:30},10),{durationSeconds:15});
  assert.deepEqual(nativeChatOptionsFromMessage('在15秒切到门头，第15秒出现标题',{durationSeconds:30},10),{durationSeconds:30});
  assert.deepEqual(nativeChatOptionsFromMessage('不要30秒',{durationSeconds:15},10),{durationSeconds:15});
  const session=within(()=>createNativeChatSession(actor,10));
  const first=await send(session,'duration_old',reply({durationSeconds:15}));
  const next=await send(session,'duration_new',reply(),{message:'改成30秒视频',options:{durationSeconds:15}});
  assert.equal(next.options.durationSeconds,30);assert.equal(next.currentPlan.version,first.currentPlan.version+1);
  await assert.rejects(within(()=>confirmNativeChatPlan({actor,sessionId:session.id,planVersion:first.currentPlan.version,requestKey:'confirm_old_duration'})),/方案已更新/);
});

test('新意见立即让旧稿失效；确认只允许最新已结算版本',async()=>{
  const session=within(()=>createNativeChatSession(actor,10));
  const first=await send(session,'revision_first',reply());
  let release;
  const waiting=new Promise(resolve=>{release=resolve;});
  const pending=send(session,'revision_second',reply(),{message:'结尾改温和一点',runtime:{generate:async params=>{await waiting;return {mode:'api',model:params.model,text:JSON.stringify(reply({tail:'欢迎到店坐坐。'})),usage:{inputTokens:500,outputTokens:200}};}}});
  assert.equal(within(()=>publicNativeChatSession(actor,session.id)).currentPlan.ready,false);
  await assert.rejects(within(()=>confirmNativeChatPlan({actor,sessionId:session.id,planVersion:1,requestKey:'confirm_early'})),/新的修改意见/);
  release(); const second=await pending; assert.equal(second.currentPlan.version,2);
  assert.notEqual(second.currentPlan.script.shots[1].voiceover,first.currentPlan.script.shots[1].voiceover);
  await assert.rejects(within(()=>confirmNativeChatPlan({actor,sessionId:session.id,planVersion:1,requestKey:'confirm_old_plan'})),/方案已更新/);
});

test('真实供应商结果缺用量仍保存全文，保留待对账且同key不重调',async()=>{
  const session=within(()=>createNativeChatSession(actor,10)); let calls=0;
  const params={actor,sessionId:session.id,message:'请写脚本',fileIds:[pic.id],requestKey:'usage_missing_001',runtime:{generate:async params=>{calls++;return {mode:'api',model:params.model,text:JSON.stringify(reply())};}}};
  const result=await within(()=>sendNativeChatMessage(params));
  assert.equal(result.status,'billing_pending'); assert.match(result.messages[1].content,/自然口播/); assert.equal(result.currentPlan.ready,false);
  await within(()=>sendNativeChatMessage(params)); assert.equal(calls,1);
  await assert.rejects(within(()=>confirmNativeChatPlan({actor,sessionId:session.id,planVersion:1,requestKey:'confirm_unpaid'})),/费用核验/);
});

for (const durationSeconds of [15,30]) test(`确认${durationSeconds}秒视频逐字复用方案，只调用${durationSeconds/15}次Wan且重复确认不重复生成`,async()=>{
  const session=within(()=>createNativeChatSession(actor,10)); const draft=await send(session,'video_chat_approved',reply({durationSeconds}));
  let calls=0; const prompts=[];
  const videoRuntime={
    generateFn:()=>{throw new Error('不得重新生成已确认脚本');}, scanText:()=>({hits:[]}), mediaReady:async()=>({}),prepareImages:async images=>images,
    submitSegment:async params=>{calls++;prompts.push(params.prompt);return {taskId:`confirmed-segment-${calls}`,url:'https://example.test/video.mp4'};},
    downloadSegment:async({outputDir,index})=>{const file=path.join(outputDir,`${index}.mp4`);await fs.writeFile(file,'fixture');return {path:file};},
    compose:async params=>{assert.equal(params.targetDurationSeconds,durationSeconds);return {url:'/uploads/ai-sales-video/1/confirmed.mp4',durationSeconds,sha256:'a'.repeat(64),audioVerified:true,subtitlesBurnedIn:true,audioSource:'provider_native',subtitleTiming:'script_estimated',audioVerification:Array.from({length:durationSeconds/15},(_,i)=>({startSeconds:i*15,durationSeconds:15,peakDb:-20,method:'ffmpeg-volumedetect'}))};},
  };
  const params={actor,sessionId:session.id,planVersion:1,requestKey:'confirm_video_001',videoRuntime};
  const confirmed=await within(()=>confirmNativeChatPlan(params));
  assert.equal(confirmed.generation.kind,'video'); assert.equal(confirmed.generation.planVersion,1);
  const repeated=await within(()=>confirmNativeChatPlan({...params,requestKey:'confirm_video_again'})); assert.equal(repeated.generation.jobId,confirmed.generation.jobId);
  for(let i=0;i<100;i++){const row=q.get('SELECT status FROM media_jobs WHERE id=?',confirmed.generation.jobId);if(row.status==='成功'||row.status==='失败')break;await new Promise(resolve=>setTimeout(resolve,10));}
  const job=q.get('SELECT * FROM media_jobs WHERE id=?',confirmed.generation.jobId), snapshot=JSON.parse(job.snapshot_json);
  assert.equal(job.status,'成功',snapshot.reason); assert.equal(calls,durationSeconds/15);
  assert.equal(snapshot.durationSeconds,durationSeconds);assert.equal(snapshot.segmentCount,durationSeconds/15);
  assert.deepEqual(snapshot.script,draft.currentPlan.script);
  for(const [index,prompt] of prompts.entries())assert.ok(prompt.includes(draft.currentPlan.script.shots[index].voiceover));
  assert.deepEqual(snapshot.paidExecution.map(e=>e.kind),Array(durationSeconds/15).fill('video'));
  assert.equal(snapshot.billing.state,'settled'); assert.equal(snapshot.priceQuote.confirmedChat,true);
  assert.ok(snapshot.priceQuote.maxCredits<salesVideoPriceQuote(snapshot.priceQuote.textModel,{durationSeconds}).maxCredits);
  assert.equal(within(()=>voicedSalesSettlement(snapshot)).credits,snapshot.billing.chargedCredits);
  assert.throws(()=>within(()=>voicedSalesSettlement({...snapshot,script:script('请到店咨询。')})),/版本不一致/);
});

test('dispatch禁用和其他用户文件不能绕过；用户模型字符串无执行权',async()=>{
  within(()=>setTenantConfig('employee_dispatch_policy',{defaultAllow:true,employees:{'crew:10':{roles:[]}}}));
  assert.throws(()=>within(()=>createNativeChatSession(staff,10)),/未被授权/);
  within(()=>setTenantConfig('employee_dispatch_policy',{defaultAllow:true}));
  const session=within(()=>createNativeChatSession(staff,10));
  await assert.rejects(within(()=>sendNativeChatMessage({actor:staff,sessionId:session.id,message:'用图',fileIds:[pic.id],requestKey:'foreign_image_001'})),/无权/);
});

test('图文对话确认交接原文与9张配图方案，不重新调用文字，双击不重复出图',async()=>{
  const session=within(()=>createNativeChatSession(actor,11)); let texts=0,images=0;
  const note={reply:'给您一套九图点单攻略，请先确认正文。',ready:true,brandName:'小锅馆',brief:'小锅馆真实菜品照片，准备聚餐点单指南',summary:'九图点单攻略',script:null,output:{title:'聚餐这一桌怎么点',body:'来小锅馆聚餐，可以先看看这锅和桌上的配菜。把想吃的搭配好，再慢慢开涮。',tags:['小锅馆','聚餐'],firstComment:'你会先下哪一盘？',coverText:'聚餐这桌怎么点',visualSummary:'锅和配菜',imagePlan:[{fileId:pic.id,caption:'用户实拍菜品'}]}};
  const draft=await within(()=>sendNativeChatMessage({actor,sessionId:session.id,message:'小锅馆，请做9张攻略',fileIds:[pic.id],options:{imageCount:9,style:'guide'},requestKey:'xhs_chat_nine',runtime:{generate:async params=>{texts++;return {mode:'api',model:params.model,text:JSON.stringify(note),usage:{inputTokens:1000,outputTokens:500}};}}}));
  assert.equal(draft.currentPlan.output.generatedImagePlan.length,9);
  const xhsRuntime={imageAvailable:()=>true,editImage:async params=>{images++;return {model:params.model,b64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII='};},renderImage:async()=>{throw new Error('fixture retains provider original');}};
  const params={actor,sessionId:session.id,planVersion:1,requestKey:'confirm_xhs_nine',xhsRuntime};
  const confirmed=await within(()=>confirmNativeChatPlan(params));
  assert.equal(confirmed.generation.kind,'xhs');
  const repeat=await within(()=>confirmNativeChatPlan({...params,requestKey:'confirm_xhs_twice'}));
  assert.equal(repeat.generation.jobId,confirmed.generation.jobId);
  for(let i=0;i<150;i++){const rows=q.all("SELECT status FROM media_jobs WHERE json_extract(snapshot_json,'$.contentId')=?",confirmed.generation.jobId);if(rows.length===9&&rows.every(row=>row.status==='成功'||row.status==='失败'))break;await new Promise(resolve=>setTimeout(resolve,10));}
  const row=q.get('SELECT snapshot_json FROM contents WHERE id=?',confirmed.generation.jobId),saved=JSON.parse(row.snapshot_json);
  assert.deepEqual(saved.output,draft.currentPlan.output);assert.equal(texts,1);assert.equal(images,9);
  assert.equal(saved.billingReference.refType,'native_chat_message');
  assert.equal(saved.imageGeneration.input.imageCount,9);assert.equal(saved.imageGeneration.input.style,'guide');
  assert.equal(q.get("SELECT count(*) AS n FROM credit_holds WHERE ref_type='content' AND ref_id=?",confirmed.generation.jobId).n,0);
  const authority=within(()=>approvedNativeChatPlan({actor,sessionId:session.id,planVersion:1,employeeIdx:11}));
  const {listUnifiedTasks,getUnifiedTaskDetail}=await import('../src/engines/task-center.js');
  const detail=()=>within(()=>getUnifiedTaskDetail(actor,'generated_content',confirmed.generation.jobId));
  const listed=within(()=>listUnifiedTasks(actor,{kind:'generated_content'})).items.find(item=>item.id===confirmed.generation.jobId);
  assert.equal(listed.billing.state,'settled');assert.equal(detail().billing.state,'settled');
  assert.ok(detail().output.includes(note.output.body));
  const savedBinding=q.get('SELECT generation_json FROM native_chat_plans WHERE session_id=? AND version=1',session.id).generation_json;
  q.run("UPDATE native_chat_plans SET generation_json='{}' WHERE session_id=? AND version=1",session.id);
  assert.equal(detail().billing.state,'missing');assert.ok(detail().output.includes(note.output.body));
  q.run('UPDATE native_chat_plans SET generation_json=? WHERE session_id=? AND version=1',savedBinding,session.id);
  const hold=q.get('SELECT * FROM credit_holds WHERE id=?',authority.billing.holdId);
  q.run('UPDATE credit_logs SET credits=0 WHERE id=?',hold.log_id);
  assert.throws(()=>within(()=>approvedNativeChatPlan({actor,sessionId:session.id,planVersion:1,employeeIdx:11})),/尚未核验/);
  assert.equal(detail().billing.state,'missing');assert.ok(detail().output.includes(note.output.body));
  q.run('UPDATE credit_logs SET credits=? WHERE id=?',hold.settled_credits,hold.log_id);
});

test('文字中的明确九图/四宫格/测评可改变选项，拒绝句和模型意见不能改变费用范围',async()=>{
  const previous={imageCount:6,style:'seed',coverLayout:'photo',includeDiner:false};
  assert.deepEqual(nativeChatOptionsFromMessage('改成九图，封面四宫格，写测评文案',previous),{...previous,imageCount:9,coverLayout:'collage4',style:'review'});
  assert.deepEqual(nativeChatOptionsFromMessage('不要九张，不要四宫格，不做测评',previous),previous);
  assert.equal(nativeChatOptionsFromMessage('做十二张图，还是改六张图',previous).imageCount,6);
  const session=within(()=>createNativeChatSession(actor,11));
  const result=await within(()=>sendNativeChatMessage({actor,sessionId:session.id,message:'先改成九图，封面用四宫格，写攻略文案',requestKey:'natural_options_001',options:{imageCount:6,style:'seed',coverLayout:'photo'},runtime:runtimeFor({...reply({ready:false}),output:null})}));
  assert.equal(result.options.imageCount,9);assert.equal(result.options.coverLayout,'collage4');assert.equal(result.options.style,'guide');
  assert.deepEqual(result.currentPlan.options,result.options);
});

test('分栏或脚本解析无效不丢真实完整回复，不自动重写且仅结算原文字调用',async()=>{
  for (const employeeIdx of [10,11]) {
    const session=within(()=>createNativeChatSession(actor,employeeIdx)); let calls=0;
    const malformed={reply:'这份创作建议已经收到，我会保留原文。',ready:true,brandName:'小锅馆',brief:'本次菜品照片',script:employeeIdx===10?'口播建议是今天吃什么？':null,output:employeeIdx===11?{}:null};
    const result=await within(()=>sendNativeChatMessage({actor,sessionId:session.id,message:'给个方案',fileIds:[pic.id],requestKey:`malformed_plan_${employeeIdx}`,runtime:{generate:async params=>{calls++;return {mode:'api',model:params.model,text:JSON.stringify(malformed),usage:{inputTokens:100,outputTokens:100}};}}}));
    assert.equal(result.status,'draft');assert.equal(result.currentPlan.ready,false);assert.equal(calls,1);
    assert.match(result.messages[1].content,/保留原文/);assert.equal(result.messages[1].billing.state,'settled');
    const stored=JSON.parse(q.get('SELECT result_json FROM native_chat_messages WHERE id=?',result.messages[1].id).result_json);
    assert.equal(stored.text,JSON.stringify(malformed));
  }
});

test('AI限流覆盖聊天和媒体确认，读取和建会话不占生成通道',async()=>{
  const {AI_GENERATION_ROUTES}=await import('../src/ai-limits.js');
  const matches=value=>AI_GENERATION_ROUTES.content.some(rule=>rule.method==='POST'&&rule.pattern.test(value));
  assert.equal(matches('/native-chat/sessions/1/messages'),true);assert.equal(matches('/native-chat/sessions/1/confirm'),true);
  assert.equal(matches('/native-chat/sessions'),false);assert.equal(matches('/native-chat/sessions/1'),false);
});

test('确认配图启动前失败保留稿件可恢复，新意见一提交则不能重启旧版图片',async()=>{
  const session=within(()=>createNativeChatSession(actor,11));
  const note={reply:'正文已写好，请确认。',ready:true,brandName:'小锅馆',brief:'小锅馆菜品照片',summary:'六图种草',script:null,output:{title:'这一桌一起吃',body:'来小锅馆看看这一桌，按照自己的喜好搭配。',tags:['小锅馆'],firstComment:'你喜欢哪一盘？',visualSummary:'桌面菜品'}};
  const draft=await send(session,'recover_xhs_draft',note);
  const params={actor,sessionId:session.id,planVersion:1,requestKey:'recover_xhs_confirm',xhsRuntime:{imageAvailable:()=>false}};
  await assert.rejects(within(()=>confirmNativeChatPlan(params)),/暂未配置/);
  const saved=within(()=>publicNativeChatSession(actor,session.id));
  assert.ok(saved.generation.jobId); assert.equal(saved.status,'failed');
  // Same approval reaches only the image-start gate again; text is not regenerated.
  await assert.rejects(within(()=>confirmNativeChatPlan(params)),/暂未配置/);
  assert.equal(within(()=>publicNativeChatSession(actor,session.id)).generation.jobId,saved.generation.jobId);
  let release;const wait=new Promise(resolve=>{release=resolve;});
  const pending=send(session,'recover_xhs_revision',note,{message:'改成九图',runtime:{generate:async params=>{await wait;return {mode:'api',model:params.model,text:JSON.stringify(note),usage:{inputTokens:100,outputTokens:100}};}}});
  await assert.rejects(within(()=>confirmNativeChatPlan({...params,xhsRuntime:{imageAvailable:()=>true}})),/新的修改意见/);
  assert.equal(within(()=>publicNativeChatSession(actor,session.id)).currentPlan.ready,false);
  release();const updated=await pending;assert.equal(updated.currentPlan.version,draft.currentPlan.version+1);assert.equal(updated.options.imageCount,9);
  assert.equal(q.get("SELECT count(*) AS n FROM media_jobs WHERE json_extract(snapshot_json,'$.contentId')=?",saved.generation.jobId).n,0);
  // A failed later edit also cannot reactivate the old approved draft; its
  // approval remains immutable solely for historical billing verification.
  const former=q.get('SELECT id FROM native_chat_plans WHERE session_id=? AND version=1',session.id);
  q.run("UPDATE native_chat_sessions SET latest_plan_version=1,status='failed' WHERE id=?",session.id);
  assert.equal(within(()=>publicNativeChatSession(actor,session.id)).currentPlan.ready,false);
  assert.equal(q.get('SELECT state FROM native_chat_plans WHERE id=?',former.id).state,'confirmed');
});

test('本轮品牌与到品牌店邀请合法；旧已付费原稿可免费重解析，新版本需确认且原账不变',async()=>{
  const session=within(()=>createNativeChatSession(actor,10));
  const original=reply({tail:'欢迎到小锅馆坐坐。'});original.script.facts_used=[{claim:'小锅馆',factId:'品牌名称'}];
  const produced=await send(session,'paid_brand_reference',original);
  assert.equal(produced.currentPlan.ready,true,JSON.stringify(produced.currentPlan.warnings));
  assert.equal(produced.currentPlan.script.shots[1].voiceover,original.script.shots[1].voiceover);
  const row=q.get('SELECT * FROM native_chat_plans WHERE session_id=? AND version=1',session.id);
  // Reconstruct only the old parser's plan snapshot in this isolated fixture;
  // retain the real mocked API response and its settled ledger unchanged.
  const prior=JSON.parse(row.plan_json);delete prior.parserVersion;prior.ready=false;prior.script.facts_used=[];
  prior.grounding.storeFacts.facts=[];prior.warnings=['旧正则不认到品牌店邀请','旧品牌引用编号不在事实包'];
  q.run('UPDATE native_chat_plans SET plan_json=?,plan_hash=? WHERE id=?',JSON.stringify(prior),nativeChatHash(prior),row.id);
  q.run("UPDATE native_chat_sessions SET status='draft' WHERE id=?",session.id);
  const receiptBefore=q.get('SELECT result_json,billing_json FROM native_chat_messages WHERE id=?',row.message_id);
  const ledgerBefore=q.all('SELECT * FROM credit_logs');const holdsBefore=q.all('SELECT * FROM credit_holds');
  assert.throws(()=>within(()=>revalidateNativeChatPlan({actor:staff,sessionId:session.id,planVersion:1})),/不存在或无权/);
  const fixed=within(()=>revalidateNativeChatPlan({actor,sessionId:session.id,planVersion:1}));
  assert.equal(fixed.currentPlan.version,2);assert.equal(fixed.currentPlan.ready,true,JSON.stringify(fixed.currentPlan.warnings));
  assert.equal(fixed.currentPlan.script.shots[1].voiceover,original.script.shots[1].voiceover);
  assert.match(fixed.currentPlan.script.facts_used[0].factId,/^native-chat:.*:user:.*:brand$/);
  assert.equal(within(()=>revalidateNativeChatPlan({actor,sessionId:session.id,planVersion:1})).currentPlan.version,2);
  assert.deepEqual(q.get('SELECT result_json,billing_json FROM native_chat_messages WHERE id=?',row.message_id),receiptBefore);
  assert.deepEqual(q.all('SELECT * FROM credit_logs'),ledgerBefore);assert.deepEqual(q.all('SELECT * FROM credit_holds'),holdsBefore);
  assert.equal(q.get('SELECT state FROM native_chat_plans WHERE id=?',row.id).state,'superseded');
  q.run("UPDATE native_chat_plans SET state='confirmed' WHERE session_id=? AND version=2",session.id);
  assert.throws(()=>within(()=>revalidateNativeChatPlan({actor,sessionId:session.id,planVersion:2})),/已确认/);
});

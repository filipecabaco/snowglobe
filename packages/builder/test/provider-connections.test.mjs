import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from '../gateway.mjs';
import {CredentialVaults} from '../credential-vault.mjs';
import {CodexRuntime} from '../codex-runtime.mjs';
import {createProvider,envApiKeyAuth} from '@earendil-works/pi-ai';
import {builtinProviders} from '@earendil-works/pi-ai/providers/all';

import {fixtureProviders,fixture,login,fixtureUsage as usage} from './provider-fixture.mjs';
test('all pinned Pi providers expose their own login methods and thinking capabilities',()=>{
 const providers=builtinProviders();assert.equal(providers.length,42);assert.equal(providers.filter(p=>p.auth.oauth).length,9);assert(providers.every(p=>p.auth.apiKey?.login||p.auth.oauth?.login));
});
test('multiple provider keys and OAuth coexist; account filtering, reasoning, secret-free catalog, and restart persistence',async t=>{
 let refreshes=0;const requests=[];
 const f=await fixture(t,{providerFactory:()=>fixtureProviders({refresh:()=>refreshes++}),stream:async function*(model,context,options){requests.push({model,options});yield {type:'done',reason:'stop',message:{usage}};}}),a=f.client(),b=f.client();
 assert.equal((await a.post('/providers/status')).status,401);
 await login(a);await login(a,'second');const info=await login(a,'first','oauth','approved');assert.equal(info.connections.length,3);assert(!JSON.stringify(info).includes('oauth-secret'));assert(!JSON.stringify(info).includes('fixture-key'));
 const status=await a.json('/providers/status');const oauth=status.connections.find(c=>c.id==='first:oauth');assert.deepEqual(oauth.models[0].thinkingLevels,['minimal','low','medium','high']);assert.deepEqual(oauth.models[1].thinkingLevels,['off']);
 assert.equal((await a.post('/providers/select',{connectionId:'first:oauth',model:'simple',thinking:'high'})).status,400);
 assert.equal((await b.post('/providers/first%3Aapi_key/api/stream',{model:{id:'simple'},context:{messages:[]}})).status,401);
 const response=await a.post('/providers/first%3Aoauth/api/stream',{model:{id:'test-model',provider:'evil',baseUrl:'https://evil.invalid'},context:{messages:[]},options:{reasoning:'high',headers:{Authorization:'evil'},maxTokens:1e9}});assert.equal(response.status,200);await response.text();assert.equal(requests[0].model.provider,'first');assert.equal(requests[0].model.baseUrl,'https://provider.invalid');assert.equal(requests[0].options.apiKey,'oauth-secret-refreshed');assert.equal(requests[0].options.reasoning,'high');assert.equal(requests[0].options.maxTokens,1000);assert.equal(requests[0].options.headers,undefined);assert.equal(refreshes,1);
 const reused=await a.post('/providers/first%3Aoauth/api/stream',{model:{id:'test-model'},context:{messages:[]},options:{reasoning:'high'}});assert.equal(reused.status,200);await reused.text();assert.equal(refreshes,1);
 const files=await fs.readdir(f.directory);for(const name of files){const data=await fs.readFile(path.join(f.directory,name));assert(!data.includes(Buffer.from('fixture-key')));assert(!data.includes(Buffer.from('refresh-secret')));assert.equal((await fs.stat(path.join(f.directory,name))).mode&0o777,0o600);}
 const restored=await fixture(t,{credentialDirectory:f.directory}),again=restored.client(a.cookie);assert.equal((await again.json('/providers/status')).connections.length,3);
 await again.json('/providers/forget',{connectionId:'first:api_key'});assert.equal((await again.json('/providers/status')).connections.length,2);assert((await again.json('/providers/status')).connections.some(c=>c.id==='first:oauth'));
 assert.equal((await a.post('/providers/status',{}, {Origin:'https://evil.invalid'})).status,403);
});
test('Pi credential mutations serialize refreshes and survive failed/cancelled writes',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'builder-vault-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const vaults=new CredentialVaults(directory),token='a'.repeat(64);
 await vaults.modify(token,()=>({ownerId:'alice',credentials:{}}));const store=vaults.store(token,'oauth');
 await store.modify('first',async()=>({type:'oauth',refresh:'one',access:'one',expires:0,count:0}));
 await Promise.all(Array.from({length:10},()=>store.modify('first',async c=>({...c,count:c.count+1}))));assert.equal((await store.read('first')).count,10);
 await assert.rejects(store.modify('first',async()=>{throw Error('refresh failed');}));assert.equal((await store.read('first')).refresh,'one');
 const bytes=await fs.readFile(path.join(directory,vaults.id(token)+'.vault'));bytes[30]^=1;await fs.writeFile(path.join(directory,vaults.id(token)+'.vault'),bytes);await assert.rejects(vaults.read(token));
});
test('failed login retains working credentials; cancelled and stale prompts cannot write credentials',async t=>{
 const f=await fixture(t),c=f.client();await login(c);const job=await c.json('/providers/login/start',{provider:'first',type:'oauth'});const pending=(await c.json('/providers/login/status')).login;
 await c.json('/providers/login/cancel',{id:job.id});assert.equal((await c.post('/providers/login/respond',{id:job.id,promptId:pending.prompt?.id,value:'approved'})).status,400);assert.equal((await c.json('/providers/status')).connections.length,1);
 await c.json('/providers/login/start',{provider:'first',type:'oauth'});const next=(await c.json('/providers/login/status')).login;await c.json('/providers/login/respond',{id:next.id,promptId:next.prompt.id,value:'bad'});
 const state=await c.json('/providers/status');assert.equal(state.connections.length,1);assert(!JSON.stringify(state).includes('secret-value'));
});
test('persistent profiles are isolated by user, and host environment credentials are never offered',async t=>{
 const tokens={alice:'alice-gateway-access-token-32-characters',bob:'bob-gateway-access-token-32-characters'},f=await fixture(t,{userTokens:tokens}),a=f.client();
 assert.equal((await a.post('/providers/open')).status,401);await a.json('/providers/open',{}, {Authorization:'Bearer '+tokens.alice});
 const job=await a.json('/providers/login/start',{provider:'first',type:'api_key'}),prompt=(await a.json('/providers/login/status')).login.prompt;await a.json('/providers/login/respond',{id:job.id,promptId:prompt.id,value:'alice-key'});await a.json('/providers/status');
 const b=f.client();await b.json('/providers/open',{}, {Authorization:'Bearer '+tokens.bob});assert.equal((await b.json('/providers/status')).connections.length,0);
 await a.json('/providers/open',{}, {Authorization:'Bearer '+tokens.bob});assert.equal((await a.json('/providers/status')).connections.length,0);
 const before=process.env.HOST_SECRET_MUST_NOT_BE_USED;process.env.HOST_SECRET_MUST_NOT_BE_USED='host-private-secret';t.after(()=>{if(before===undefined)delete process.env.HOST_SECRET_MUST_NOT_BE_USED;else process.env.HOST_SECRET_MUST_NOT_BE_USED=before;});assert.equal((await b.json('/providers/status')).connections.length,0);
});
test('official Codex saved identity survives gateway restart and Forget prevents restoration',async t=>{
 const starts=[],closes=[];const codexFactory=options=>({directory:options.directory,async start(){starts.push(options);},async account(){return {connected:true,account:{email:'fixture@example.invalid'},models:[{id:'fixture',thinkingLevels:['default','low','high']}]};},async close(options){closes.push(options);}});
 const f=await fixture(t,{codexFactory}),c=f.client();await c.json('/codex/connect',{remember:true});assert(c.cookie.includes('sg_builder_profile='));assert.equal(starts[0].persistent,true);
 const next=await fixture(t,{credentialDirectory:f.directory,codexFactory}),restored=next.client(c.cookie.replace(/sg_builder=[a-f0-9]+;? ?/,''));assert.equal((await restored.json('/status')).codexSession,true);assert.equal(starts[0].directory,starts[1].directory);
 // The same profile cookie without its hourly cookie must reuse a live native runtime.
 const tab=next.client(c.cookie.replace(/sg_builder=[a-f0-9]+;? ?/,''));assert.equal((await tab.json('/status')).codexSession,true);assert.equal(starts.length,2);
 await restored.json('/disconnect');assert.deepEqual(closes.at(-1),{forget:true});const third=await fixture(t,{credentialDirectory:f.directory,codexFactory}),forgotten=third.client(c.cookie);assert.equal((await forgotten.json('/status')).codexSession,false);
});
test('persistent Codex shutdown keeps its credential files; explicit Forget removes them',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'builder-native-persist-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));await fs.writeFile(path.join(directory,'auth.json'),'fixture-secret');
 const calls=[],runtime=new CodexRuntime({directory,persistent:true});runtime.rpc=async method=>{calls.push(method);};await runtime.close();assert.equal(await fs.readFile(path.join(directory,'auth.json'),'utf8'),'fixture-secret');assert(!calls.includes('account/logout'));
 const forget=new CodexRuntime({directory,persistent:true});forget.rpc=async method=>{calls.push(method);};await forget.close({forget:true});await assert.rejects(fs.access(directory));assert(calls.includes('account/logout'));
});
test('official Codex uses account-reported thinking levels and forwards the selected effort',async()=>{
 const runtime=new CodexRuntime({directory:'/unused'}),calls=[];
 runtime.rpc=async(method,params)=>{calls.push({method,params});if(method==='account/read')return {account:{type:'chatgpt'}};if(method==='model/list')return {data:[{model:'fixture',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'low'}]};if(method==='thread/start')return {thread:{id:'thread'}};if(method==='turn/start'){queueMicrotask(()=>runtime.receive({method:'turn/completed',params:{threadId:'thread',turn:{status:'completed',items:[{type:'agentMessage',id:'done',text:'hello'}]}}}));return {turn:{id:'turn'}};}};
 assert.deepEqual((await runtime.account()).models[0].thinkingLevels,['default','low','high']);await runtime.turn('hello','fixture',()=>{},undefined,'high');assert.equal(calls.find(c=>c.method==='turn/start').params.effort,'high');await assert.rejects(runtime.turn('hello','fixture',()=>{},undefined,'max'),/thinking level/);
});
test('real Pi cloud key flows collect account settings without host profile/file access',async t=>{
 const requests=[],f=await fixture(t,{providerFactory:undefined,stream:async function*(model,context,options){requests.push({model,options});yield {type:'done',reason:'stop',message:{usage}};}}),c=f.client();await c.json('/providers/open');
 for(const [provider,answers,expected] of [
  ['azure',['cloud-fixture-key','my-resource','gpt-4o=deployment'],{AZURE_OPENAI_BASE_URL:'https://my-resource.openai.azure.com/openai/v1',AZURE_OPENAI_RESOURCE_NAME:'my-resource',AZURE_OPENAI_DEPLOYMENT_NAME_MAP:'gpt-4o=deployment'}],
  ['amazon-bedrock',['cloud-fixture-key','us-east-1'],{AWS_REGION:'us-east-1',AWS_BEDROCK_SKIP_AUTH:'0'}],
  ['google-vertex',['cloud-fixture-key'],undefined],
  ['cloudflare-ai-gateway',['cloud-fixture-key','account-id','gateway-id'],{CLOUDFLARE_ACCOUNT_ID:'account-id',CLOUDFLARE_GATEWAY_ID:'gateway-id'}],
 ]){
  const job=await c.json('/providers/login/start',{provider,type:'api_key'});
  for(const value of answers){let state;for(let n=0;n<50;n++){state=(await c.json('/providers/login/status')).login;if(state.prompt)break;await new Promise(r=>setTimeout(r,5));}assert(state.prompt,provider);assert.notEqual(state.prompt.type,'select','host credential chain/file choices must not be exposed');await c.json('/providers/login/respond',{id:job.id,promptId:state.prompt.id,value});}
  let state;for(let n=0;n<50;n++){state=(await c.json('/providers/login/status')).login;if(state.state!=='pending')break;await new Promise(r=>setTimeout(r,5));}assert.equal(state.state,'completed',state.error);
  const info=await c.json('/providers/status'),connection=info.connections.find(c=>c.provider===provider),m=connection.models[0],response=await c.post('/providers/'+encodeURIComponent(connection.id)+'/api/stream',{model:{id:m.id},context:{messages:[]},options:{reasoning:m.thinkingLevels[0]}});assert.equal(response.status,200,await response.text());assert.deepEqual(requests.at(-1).options.env,expected);if(provider==='cloudflare-ai-gateway')assert.equal(requests.at(-1).options.headers['cf-aig-authorization'],'Bearer cloud-fixture-key');else assert.equal(requests.at(-1).options.apiKey,'cloud-fixture-key');
 }
});
test('OpenRouter personal catalog persists and Copilot credential availability filters model selection',async t=>{
 const original=globalThis.fetch;let personalRequests=0;const routers=builtinProviders().find(p=>p.id==='openrouter'),allowed=routers.getModels()[0];
 globalThis.fetch=async(url,options)=>{if(String(url)==='https://openrouter.ai/api/v1/models/user'){personalRequests++;assert.equal(options.headers.authorization,'Bearer fixture-key');return new Response(JSON.stringify({data:[{id:allowed.id,context_length:12345,top_provider:{max_completion_tokens:2345},pricing:{prompt:'0.000001',completion:'0.000002'}}]}),{headers:{'Content-Type':'application/json'}});}return original(url,options);};t.after(()=>globalThis.fetch=original);
 const f=await fixture(t,{providerFactory:undefined}),c=f.client();const info=await login(c,'openrouter');const router=info.connections[0];assert.equal(router.models.length,1);assert.equal(router.models[0].contextWindow,12345);assert.equal(router.models[0].maxTokens,2345);assert.equal(personalRequests,1);
 const restored=await fixture(t,{providerFactory:undefined,credentialDirectory:f.directory}),other=restored.client(c.cookie);assert.equal((await other.json('/providers/status')).connections[0].models.length,1);assert.equal(personalRequests,1);
 const token=/sg_builder_profile=([a-f0-9]+)/.exec(c.cookie)[1],vaults=new CredentialVaults(f.directory),copilot=builtinProviders().find(p=>p.id==='github-copilot'),copilotId=copilot.getModels()[0].id;
 await vaults.store(token,'oauth').modify('github-copilot',async()=>({type:'oauth',access:'fixture-token',refresh:'fixture-refresh',expires:Date.now()+3600000,availableModelIds:[copilotId]}));const filtered=(await c.json('/providers/status')).connections.find(c=>c.id==='github-copilot:oauth');assert.deepEqual(filtered.models.map(m=>m.id),[copilotId]);
 const unavailable=copilot.getModels().find(m=>m.id!==copilotId);assert.equal((await c.post('/providers/select',{connectionId:filtered.id,model:unavailable.id,thinking:'off'})).status,400);
});
test('parallel tabs cannot start simultaneous streams; abort releases the connection',async t=>{
 let entered,release;const active=new Promise(r=>entered=r),ended=new Promise(r=>release=r);let calls=0;
 const f=await fixture(t,{stream:async function*(model,context,{signal}){calls++;yield {type:'start',partial:{}};entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));release();throw Error('cancelled');}}),c=f.client();await login(c);
 const data={model:{id:'simple'},context:{messages:[]}},headers={Origin:'http://test.local',Cookie:c.cookie,'Content-Type':'application/json'},controller=new AbortController();
 const first=fetch(f.base+'/providers/first%3Aapi_key/api/stream',{method:'POST',headers,body:JSON.stringify(data),signal:controller.signal});await active;const response=await first;
 const second=await c.post('/providers/first%3Aapi_key/api/stream',data);assert.equal(second.status,409);assert.equal(calls,1);assert.equal((await c.post('/providers/forget',{connectionId:'first:api_key'})).status,409);
 controller.abort();await response.body.cancel().catch(()=>{});await ended;
 // A subsequent management request waits for the old stream's finally block.
 for(let n=0;n<30;n++){const result=await c.post('/providers/forget',{connectionId:'first:api_key'});if(result.status===200)return;await new Promise(r=>setTimeout(r,5));}assert.fail('Abort did not release the provider connection');
});

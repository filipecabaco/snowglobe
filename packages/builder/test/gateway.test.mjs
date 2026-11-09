import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGateway,proxyEvent} from '../gateway.mjs';
import {Agent,streamProxy} from '@earendil-works/pi-agent-core';
import {obj,str} from '@earendil-works/pi-schema';
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
test('gateway auth, CSRF, model enforcement, Pi stream wire, revocation',async t=>{
 let selected;
 const server=createGateway({origin:'http://test.local',stream:async function*(model,context,options){selected=model;assert.equal(options.apiKey,'development-test-key-123456');yield {type:'start',partial:{}};yield {type:'text_start',contentIndex:0,partial:{}};yield {type:'text_delta',contentIndex:0,delta:'hello',partial:{}};yield {type:'text_end',contentIndex:0,content:'hello',partial:{content:[{type:'text',text:'hello'}]}};yield {type:'done',reason:'stop',message:{usage}};}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const base='http://127.0.0.1:'+server.address().port;
 const post=(route,data={},cookie='',origin='http://test.local')=>fetch(base+route,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(data)});
 assert.equal((await post('/connect',{key:'development-test-key-123456'},'','null')).status,403);
 assert.equal((await post('/api/stream')).status,401);
 const r=await post('/connect',{key:'development-test-key-123456',model:'gpt-4o-mini'});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];const {model}=await r.json();
 // Exercise the pinned browser proxy parser against the gateway's real HTTP SSE wire.
 const originalFetch=globalThis.fetch;globalThis.fetch=(url,opts)=>originalFetch(url,{...opts,headers:{...opts.headers,Origin:'http://test.local',Cookie:cookie}});t.after(()=>globalThis.fetch=originalFetch);
 const stream=streamProxy({...model,baseUrl:'https://evil.invalid'},{messages:[]},{proxyUrl:base,authToken:'session'});const message=await stream.result();assert.equal(message.content[0].text,'hello');assert.equal(message.stopReason,'stop');assert.equal(selected.baseUrl,'https://api.openai.com/v1');
 await post('/disconnect',{},cookie);assert.equal((await post('/api/stream',{},cookie)).status,401);
});
test('Pi Agent invokes a tool with a mocked stream and receives the result',async()=>{
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');let n=0,called=false;const events=[];
 const model={id:'mock',api:'openai-responses',provider:'openai',name:'mock',baseUrl:'https://invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const agent=new Agent({initialState:{model,tools:[{name:'read_file',label:'Read',description:'Read',parameters:obj({path:str()}),execute:async(_id,p)=>{called=p.path==='src/App.jsx';return {content:[{type:'text',text:'source'}],details:{}};}}]},streamFn:()=>{const s=createAssistantMessageEventStream();const m={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage,stopReason:n++===0?'toolUse':'stop',content:n===1?[{type:'toolCall',id:'call1',name:'read_file',arguments:{path:'src/App.jsx'}}]:[{type:'text',text:'done'}]};queueMicrotask(()=>{s.push({type:'start',partial:m});s.push({type:'done',reason:m.stopReason,message:m});s.end();});return s;}});
 agent.subscribe(e=>events.push(e.type));await agent.prompt('Read');assert(called);assert(events.includes('tool_execution_end'));assert.equal(agent.state.messages.at(-1).content[0].text,'done');
});
test('provider transport failure emits an explicit sanitized terminal error and incomplete usage',async t=>{
 const server=createGateway({origin:'http://test.local',stream:async function*(){throw Error('offline secret-provider-key private-source');}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 const post=(route,body,cookie='')=>fetch(base+route,{method:'POST',headers:{Origin:'http://test.local',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const connected=await post('/connect',{key:'development-test-key-123456'}),cookie=connected.headers.get('set-cookie').split(';')[0];
 const response=await post('/api/stream',{context:{messages:[]}},cookie),wire=await response.text();assert.equal(response.status,200);const event=JSON.parse(wire.trim().slice(6));assert.equal(event.type,'error');assert.equal(event.reason,'error');assert.match(event.errorMessage,/Provider unavailable/);assert(!wire.includes('secret-provider-key'));assert(!wire.includes('private-source'));
 const usage=await (await post('/usage',{},cookie)).json();assert.equal(usage.accountingComplete,false);assert.equal((await post('/api/stream',{context:{messages:[]}},cookie)).status,429);
});
test('disconnect aborts an active provider request and revokes the browser session',async t=>{
 let started,aborted;const ready=new Promise(resolve=>started=resolve),cancelled=new Promise(resolve=>aborted=resolve);
 const server=createGateway({origin:'http://test.local',stream:async function*(_model,_context,{signal}){yield {type:'start',partial:{}};started();await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted();resolve();},{once:true}));throw Error('cancelled');}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 const post=(route,body={},cookie='')=>fetch(base+route,{method:'POST',headers:{Origin:'http://test.local',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const connected=await post('/connect',{key:'development-test-key-123456'}),cookie=connected.headers.get('set-cookie').split(';')[0],stream=post('/api/stream',{context:{messages:[]}},cookie);await ready;const response=await stream;
 assert.equal((await post('/disconnect',{},cookie)).status,200);await cancelled;assert.match(await response.text(),/stopped or timed out/);assert.equal((await post('/usage',{},cookie)).status,401);
});
test('API key rotation and switching to Codex revoke previous session credentials',async t=>{
 const keys=[],runtime={async start(){},async close(){},async account(){return {connected:true,models:[]};}};const server=createGateway({origin:'http://test.local',codexFactory:()=>runtime,stream:async function*(_model,_context,options){keys.push(options.apiKey);yield {type:'done',reason:'stop',message:{usage}};}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 const post=(route,body={},cookie='')=>fetch(base+route,{method:'POST',headers:{Origin:'http://test.local',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)}),cookie=response=>response.headers.get('set-cookie').split(';')[0];
 const first=cookie(await post('/connect',{key:'development-first-key-123456'})),second=cookie(await post('/connect',{key:'development-second-key-123456'},first));assert.notEqual(first,second);assert.equal((await post('/usage',{},first)).status,401);await (await post('/api/stream',{context:{messages:[]}},second)).text();assert.deepEqual(keys,['development-second-key-123456']);
 const codex=cookie(await post('/codex/connect',{},second));assert.notEqual(codex,second);assert.equal((await post('/usage',{},second)).status,401);assert.equal((await post('/api/stream',{context:{messages:[]}},codex)).status,400);assert.equal((await (await post('/usage',{},codex)).json()).metering,'request-count-only');
});

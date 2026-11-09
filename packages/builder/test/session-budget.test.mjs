import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sessionBudget} from '../session-budget.mjs';
import {createGateway} from '../gateway.mjs';
test('session limits count requests, estimate the next call, and fail closed on missing usage',()=>{
 const budget=sessionBudget({maxRequests:2,maxTokens:10000,maxCostUsd:0.01});
 const model={cost:{input:1,output:2}};
 budget.begin({model,context:{messages:[]}});
 budget.record({totalTokens:20,cost:{total:0.009}});
 assert.throws(()=>budget.begin({model,context:{messages:[]}}),/spending limit/);
 assert.equal(budget.view().requests,1);
 budget.begin();budget.record();assert.throws(()=>budget.begin(),/usage limit/);
 assert.equal(budget.view().accountingComplete,false);
 assert.equal(budget.view().tokens,10000);
 assert.throws(()=>sessionBudget({maxCostUsd:NaN}),/positive finite/);
 assert.throws(()=>sessionBudget({maxRequests:1.5}),/safe integers/);
});
test('gateway meters provider usage, excludes invalid calls, and blocks a second billable request',async t=>{
 let calls=0;
 const server=createGateway({origin:'http://test.local',limits:{maxRequests:1},stream:async function*(){calls++;yield {type:'done',reason:'stop',message:{usage:{totalTokens:23,cost:{total:0.001}}}};}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const base='http://127.0.0.1:'+server.address().port;
 const post=(route,data={},cookie='')=>fetch(base+route,{method:'POST',headers:{Origin:'http://test.local',Cookie:cookie},body:JSON.stringify(data)});
 const r=await post('/connect',{key:'fixture-key-not-a-secret-12345'}),cookie=r.headers.get('set-cookie').split(';')[0];
 assert.equal((await post('/api/stream',{},cookie)).status,400);
 await (await post('/api/stream',{context:{messages:[]}},cookie)).text();
 const usage=await (await post('/usage',{},cookie)).json();assert.equal(usage.requests,1);assert.equal(usage.tokens,23);assert.equal(usage.estimatedCostUsd,0.001);assert.equal(usage.metering,'catalog-estimate');
 assert.equal((await post('/api/stream',{context:{messages:[]}},cookie)).status,429);assert.equal(calls,1);
 await post('/disconnect',{},cookie);assert.equal((await post('/usage',{},cookie)).status,401);
});
test('configured individual token gates both connection modes and is never returned',async t=>{
 const accessToken='fixture-invitation-token-32-characters',origin='https://test.local';let started=false;
 assert.throws(()=>createGateway({origin:'https://user:secret@test.local'}),/exact HTTP/);
 assert.throws(()=>createGateway({development:false,origin}),/requires HTTPS origin/);
 const server=createGateway({origin,userTokens:{tester:accessToken},development:false,codexFactory:()=>{started=true;throw Error('must not start');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 const post=(route,authorization)=>fetch(base+route,{method:'POST',headers:{Origin:origin,...(authorization?{Authorization:authorization}:{})},body:JSON.stringify({key:'fixture-provider-key-123456'})});
 for(const route of ['/connect','/codex/connect']){assert.equal((await post(route)).status,401);assert.equal((await post(route,'Bearer wrong')).status,401);}
 assert.equal(started,false);
 const status=await (await post('/status')).json();assert.equal(status.requiresAccessToken,true);assert.equal(status.development,false);
 const response=await post('/connect','Bearer '+accessToken);assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/Secure/);assert(!(await response.text()).includes(accessToken));
});

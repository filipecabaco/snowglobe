import {test} from 'node:test';import assert from 'node:assert/strict';
import {CodexRuntime,codexConfig,vmTools} from '../codex-runtime.mjs';
import {createGateway} from '../gateway.mjs';
test('Codex only forwards active browser VM tools, rejects native approvals and stale results',()=>{
 const c=new CodexRuntime({directory:'/unused'}),sent=[],events=[];c.child={stdin:{writable:true,write:line=>sent.push(JSON.parse(line))}};c.thread='owned';c.active={token:'turn',emit:e=>events.push(e),calls:0,builds:0,resolve(){}};
 c.receive({id:1,method:'item/tool/call',params:{threadId:'other',tool:'vm_read_file',arguments:{path:'a'}}});assert.equal(sent.at(-1).result.success,false);
 c.receive({id:2,method:'item/commandExecution/requestApproval',params:{command:'cat /private/file'}});assert.equal(sent.at(-1).error.code,-32601);
 c.receive({id:3,method:'item/tool/call',params:{threadId:'owned',tool:'vm_read_file',arguments:{path:'src/App.jsx'}}});assert.equal(events[0].name,'vm_read_file');
 c.toolResult(events[0].callId,{text:'source'});assert.equal(sent.at(-1).id,3);assert.equal(sent.at(-1).result.success,true);assert.throws(()=>c.toolResult(events[0].callId,{}),/expired/);
 assert.match(codexConfig,/shell_tool = false/);assert.match(codexConfig,/"\/" = "deny"/);assert.match(codexConfig,/enabled = false/);assert.equal(new Set(vmTools.map(t=>t.name)).size,vmTools.length);assert(vmTools.some(t=>t.name==='vm_inspect_schema'));
});
test('Codex device login and VM tool results are browser-session scoped, with no token exposure or API fallback',async t=>{
 let runtimes=0,closed=0,called=[];const fake=()=>({async start(){runtimes++;},async account(){return {connected:true,engine:'codex',account:{email:'test@example.invalid'},models:[{id:'test-model'}]};},async loginStart(){return{verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-CODE'};},toolResult(id,result){called.push([id,result]);},async turn(prompt,model,emit){assert.equal(model,'test-model');emit({type:'text',delta:'hello'});emit({type:'done',status:'completed'});},async cancel(){},async close(){closed++;}});
 const server=createGateway({origin:'http://test.local',codexFactory:fake});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await server.dispose();await new Promise(r=>server.close(r));});const base='http://127.0.0.1:'+server.address().port;
 const post=(route,data={},cookie='',origin='http://test.local')=>fetch(base+route,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(data)});
 assert.equal((await post('/codex/connect',{},'','null')).status,403);
 const connection=await post('/codex/connect');assert.equal(connection.status,200);const cookie=connection.headers.get('set-cookie').split(';')[0];assert.equal(runtimes,1);assert(!(await connection.text()).includes('access_token'));
 assert.equal((await post('/codex/status')).status,401);assert.equal((await post('/api/stream',{},cookie)).status,400);
 const response=await post('/codex/turn',{prompt:'hello',model:'test-model'},cookie);assert((await response.text()).includes('hello'));
 await post('/codex/tool-result',{callId:'call',result:{ok:true}},cookie);assert.equal(called[0][0],'call');
 await post('/disconnect',{},cookie);assert.equal(closed,1);assert.equal((await post('/codex/status',{},cookie)).status,401);
});
test('final assistant items are delivered without requiring deltas, and empty completions fail',()=>{
 const r=new CodexRuntime({directory:'/unused'});r.thread='owned';const events=[];
 r.active={token:'one',emit:e=>events.push(e),calls:0,builds:0,resolve(){}};
 r.receive({method:'item/completed',params:{threadId:'owned',item:{type:'agentMessage',id:'m',text:'The app cannot use a backend yet.'}}});
 r.receive({method:'turn/completed',params:{threadId:'owned',turn:{status:'completed',error:null,items:[{type:'agentMessage',id:'m',text:'The app cannot use a backend yet.'}]}}});
 assert.equal(events.filter(e=>e.type==='text').map(e=>e.delta).join(''),'The app cannot use a backend yet.');assert.equal(events.at(-1).status,'completed');
 events.length=0;r.active={token:'two',emit:e=>events.push(e),calls:0,builds:0,resolve(){}};
 r.receive({method:'turn/completed',params:{threadId:'owned',turn:{status:'completed',error:null,items:[]}}});assert.equal(events.at(-1).status,'failed');assert.match(events.at(-1).error,/no response/);
});

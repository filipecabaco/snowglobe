import {test} from 'node:test';import assert from 'node:assert/strict';import {projectScope,validProjectId,projectName} from '../src/projects.js';import {createGateway} from '../gateway.mjs';
test('project identifiers cannot alias another scope and names are bounded plain text',()=>{
 const a='12345678-1234-4234-9234-123456789abc',b='12345678-1234-4234-9234-123456789abd';
 assert.notEqual(projectScope(a,'web'),projectScope(b,'web'));assert.notEqual(projectScope(a,'web'),projectScope(a,'supabase'));assert.equal(projectScope('local-builder','web'),'/builder/web');
 for(const value of ['../web','','local-builder/web','?project=foo'])assert.throws(()=>validProjectId(value));
 assert.throws(()=>projectScope(a,'../web'));assert.equal(projectName(' My app '),'My app');for(const name of ['', 'x'.repeat(81),'bad\nname'])assert.throws(()=>projectName(name));
});
test('Codex conversations stay scoped to their project while reusing an authenticated session',async t=>{
 const seen=[];let n=0;const runtime={async start(){},async close(){},async account(){return {connected:true};},async turn(prompt,model,emit){seen.push(this.thread);this.thread??='thread-'+(++n);emit({type:'done',status:'completed'});}};
 const server=createGateway({origin:'http://project.test',codexFactory:()=>runtime});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await server.dispose();await new Promise(r=>server.close(r));});
 const url='http://127.0.0.1:'+server.address().port;let cookie='';const post=(path,body={})=>fetch(url+path,{method:'POST',headers:{Origin:'http://project.test',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const connected=await post('/codex/connect');cookie=connected.headers.get('set-cookie').split(';')[0];
 const second='12345678-1234-4234-9234-123456789abc';for(const projectId of ['local-builder',second,'local-builder'])await (await post('/codex/turn',{prompt:'Build',model:'fixture',projectId})).text();assert.deepEqual(seen,[null,null,'thread-1']);
 assert.equal((await post('/codex/turn',{prompt:'Build',model:'fixture',projectId:'../other'})).status,400);assert.equal(seen.length,3);
});

test('recovery and history reject invalid IDs before opening browser storage',async()=>{
 const {checkpointStore}=await import('../src/checkpoint.js'),{historyStore}=await import('../src/history.js');
 for(const id of ['latest','../local-builder','',123]){
  await assert.rejects(checkpointStore('readwrite',{files:{}},id),/Invalid project identifier/);
  await assert.rejects(historyStore(id,{files:{}}),/Invalid project identifier/);
 }
});
test('model preferences contain bounded model, connection and thinking metadata only',async()=>{
 const {modelPreference}=await import('../src/projects.js');assert.deepEqual(modelPreference('codex','gpt-5.3-codex'),{engine:'codex',id:'gpt-5.3-codex'});for(const [engine,id] of [['other','model'],['pi',''],['pi','a\nb'],['pi','x'.repeat(513)]])assert.throws(()=>modelPreference(engine,id));
 assert.deepEqual(modelPreference('pi','claude-opus-4-7',{connectionId:'anthropic:oauth',thinking:'high',key:'never saved'}),{engine:'pi',id:'claude-opus-4-7',connectionId:'anthropic:oauth',thinking:'high'});
 assert.throws(()=>modelPreference('pi','model',{connectionId:'../private',thinking:'high'}));assert.throws(()=>modelPreference('pi','model',{thinking:'invented'}));
 assert.equal(modelPreference('codex','model',{thinking:'none'}).thinking,'none');assert.throws(()=>modelPreference('codex','model',{thinking:'bad value'}));
});

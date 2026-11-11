// Opt-in native protocol acceptance; no account, API key, or external inference.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {CodexRuntime,vmTools} from '../codex-runtime.mjs';

test('actual Codex app-server routes VM files, Supabase tools, builds and non-streamed final text',{
 skip:!process.env.BUILDER_CODEX_TEST_BIN,timeout:20000,
},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sg-native-'));
 const operations=[['vm_list_files',{}],['vm_read_file',{path:'src/App.jsx'}],['vm_write_file',{path:'src/App.jsx',version:'fixture-version',text:'export default function App(){return <h1>Voting prototype</h1>}'}],['vm_enable_supabase',{}],['vm_apply_migration',{name:'20261108000000_votes.sql',sql:'CREATE TABLE public.votes(id uuid PRIMARY KEY);'}],['vm_build_preview',{}]];
 const requests=[],events=[],outputs=[];
 const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"data":[]}');}
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);requests.push(body);const n=requests.length,op=operations[n-1];
  const item=op?{type:'function_call',call_id:'call_'+n,name:op[0],arguments:JSON.stringify(op[1])}:{type:'message',role:'assistant',id:'final',content:[{type:'output_text',text:'Built the voting prototype.'}]};
  const fixture=[{type:'response.created',response:{id:'r'+n}},{type:'response.output_item.done',item},{type:'response.completed',response:{id:'r'+n,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(fixture.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port+'/v1';
 const runtime=new CodexRuntime({directory,executable:process.env.BUILDER_CODEX_TEST_BIN,spawnProcess:(bin,args,options)=>spawn(bin,[...args,
  '-c','model_provider="fixture"','-c','model_providers.fixture.name="Local fixture"',
  '-c',`model_providers.fixture.base_url="${base}"`,'-c','model_providers.fixture.wire_api="responses"',
  '-c','model_providers.fixture.requires_openai_auth=false','-c','features.enable_request_compression=false',
 ],options)});
 t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const rpc=runtime.rpc.bind(runtime);
 runtime.rpc=(method,params,...rest)=>rpc(method,method==='thread/start'?{...params,modelProvider:'fixture'}:params,...rest);
 await runtime.start();runtime.models=[{id:'fixture-model'}];
 await runtime.turn('Build a local voting prototype.','fixture-model',event=>{
  events.push(event);
  if(event.type==='tool'){
   const result=event.name==='vm_list_files'?{files:['src/App.jsx']}:event.name==='vm_read_file'?{path:'src/App.jsx',text:'starter',version:'fixture-version'}:event.name==='vm_write_file'?{path:'src/App.jsx',version:'edited-version'}:{ok:true};
   outputs.push(result);runtime.toolResult(event.callId,result);
  }
 });
 assert.deepEqual(events.filter(e=>e.type==='tool').map(e=>[e.name,e.args]),operations);
 assert.equal(events.filter(e=>e.type==='text').map(e=>e.delta).join(''),'Built the voting prototype.');
 assert.equal(events.at(-1).status,'completed');assert.equal(requests.length,operations.length+1);
 assert.deepEqual(requests[0].tools.filter(tool=>tool.name?.startsWith('vm_')).map(tool=>tool.name),vmTools.map(tool=>tool.name));
 for(let i=0;i<outputs.length;i++){
  const output=requests[i+1].input.find(item=>item.type==='function_call_output'&&item.call_id==='call_'+(i+1));
  assert(output,'actual Codex must send the VM result back to its model');
  assert(JSON.stringify(output.output).includes(i===0?'src/App.jsx':i===1?'fixture-version':i===2?'edited-version':'true'));
 }
});

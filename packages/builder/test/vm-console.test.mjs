import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {build} from 'esbuild';
const bundled=await build({entryPoints:[new URL('../src/vm-console.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'raw',setup(builder){builder.onResolve({filter:/\?raw$/},args=>({path:new URL(args.path.replace('?raw',''),'file://'+args.resolveDir+'/').pathname,namespace:'raw'}));builder.onLoad({filter:/.*/,namespace:'raw'},async args=>({contents:await fs.readFile(args.path,'utf8'),loader:'text'}));}}]});
const {VmConsole}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
function fixture(t,{respond=true,uploadStatus=200}={}){
 const previous=globalThis.fetch;globalThis.fetch=async()=>new Response(new Uint8Array([1,2,3]));t.after(()=>{globalThis.fetch=previous;});
 const calls=[],sent=[],outputs=[];let holds=0,token,stream;
 const machine={host:{tcpOpen(port){
  if(port===54324){let size=0;const upload={write:async bytes=>{if(!size){const header=new TextDecoder().decode(bytes);assert(header.includes('Authorization: Bearer '+token));size=Number(/Content-Length: (\d+)/.exec(header)[1]);}else{assert.equal(bytes.length,size);queueMicrotask(()=>{upload.ondata(new TextEncoder().encode('HTTP/1.1 '+uploadStatus+' Response\r\nContent-Length: 14\r\n\r\n{"ready":true}'));upload.onend();});}return true;},abort(){}};queueMicrotask(()=>upload.onconnect());return upload;}
  assert.equal(port,54323);stream={write:async bytes=>{const event=JSON.parse(new TextDecoder().decode(bytes));sent.push(event);if(event.type==='open'){assert.equal(event.token,token);if(respond){const data=new TextEncoder().encode('{"type":"ready"}\n');queueMicrotask(()=>{stream.ondata(data.subarray(0,7));stream.ondata(data.subarray(7));});}}if(event.type==='close')queueMicrotask(()=>stream.onclose());return true;},abort(){queueMicrotask(()=>stream.onclose?.());}};queueMicrotask(()=>stream.onconnect());return stream;
 }},lifecycle:{touch(){}}};
 const api={async wake(){},_get:()=>machine,_hold:()=>{holds++;let released=false;return()=>{if(!released){released=true;holds--;}};},async runCommand(input,options){calls.push(input);assert(!('bridge.gz' in options.files),'the binary uses TCP rather than the serial job channel');const request=JSON.parse(new TextDecoder().decode(options.files['request.json']));token=request.token;assert.equal(request.bridgeSize,3);assert.match(request.bridgeSha256,/^[a-f0-9]{64}$/);return {jobId:'fixture-job'};},async readJob(){return {state:'exited',exitStatus:0,output:'BUILDER_CONSOLE_UPLOAD_READY'};}};
 const terminal=new VmConsole(api,{assetUrl:'https://fixture.invalid/bridge.gz',onOutput:bytes=>outputs.push(new TextDecoder().decode(bytes))});
 return {terminal,machine,calls,sent,outputs,get holds(){return holds;},get stream(){return stream;}};
}
test('owner console uses its own authenticated TCP session, preserves UTF-8 input, and releases the VM on close',async t=>{
 const f=fixture(t);await f.terminal.connect('web');assert.equal(f.holds,1);assert.match(f.calls[0].command,/^node /);f.terminal.input('echo café\r');const input=f.sent.find(event=>event.type==='input');assert.equal(Buffer.from(input.data,'base64').toString(),'echo café\r');assert.equal(f.machine.dirty,true);
 f.stream.ondata(new TextEncoder().encode(JSON.stringify({type:'output',data:Buffer.from('row 42').toString('base64')})+'\n'));assert.deepEqual(f.outputs,['row 42']);f.terminal.resize(100,35);assert(f.sent.some(event=>event.type==='resize'&&event.cols===100&&event.rows===35));
 await f.terminal.disconnect();await f.terminal.disconnect();assert.equal(f.holds,0);assert.equal(f.terminal.session,null);
 await f.terminal.connect('web');assert.equal(f.calls.length,1,'the existing guest bridge is reused within this VM generation');await f.terminal.disconnect();
});
test('console cancellation releases its VM and database setup runs inside the existing Supabase environment',async t=>{
 const f=fixture(t,{respond:false}),controller=new AbortController(),connecting=f.terminal.connect('supabase',{signal:controller.signal});
 while(!f.stream)await new Promise(resolve=>setTimeout(resolve,10));controller.abort();await assert.rejects(connecting,/stopped/);assert.equal(f.holds,0);assert.match(f.calls[0].command,/^BUN_BE_BUN=1 supabase run /);assert.equal(f.terminal.session,null);
});

test('a failed console upload releases its VM hold',async t=>{
 const rejected=fixture(t,{uploadStatus:500});await assert.rejects(rejected.terminal.connect('web'),/upload failed/);assert.equal(rejected.holds,0);
});
test('a malformed terminal frame releases its VM and permits a clean setup retry',async t=>{
 const f=fixture(t);await f.terminal.connect('web');f.stream.ondata(new TextEncoder().encode('not-json\n'));assert.equal(f.holds,0);assert.equal(f.terminal.session,null);
 await f.terminal.connect('web');assert.equal(f.calls.length,2,'a bad guest response invalidates the cached bridge setup');await f.terminal.disconnect();
});

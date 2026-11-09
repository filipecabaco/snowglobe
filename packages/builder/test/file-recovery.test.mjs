import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {Core}=require('../../../internal/site/machine-core.js');
const A=require('../../../internal/site/agent.js');
const response=bytes=>({ok:true,arrayBuffer:async()=>Uint8Array.from(bytes).buffer});

test('transient image fetch failures retry before poisoning a guest executable',async()=>{
 const events=[],core=new Core({config:{filesystem:{baseurl:'https://files.invalid/'}},agent:null,blobRetryDelays:[0,0],emit:(...e)=>events.push(e)});let calls=0;
 core.fetch=async()=>{if(++calls===1)throw new TypeError('Failed to fetch');return response([1,2]);};
 assert.deepEqual(await core.fetchBlob('busybox.zst'),Uint8Array.of(1,2));assert.equal(calls,2);assert.equal(core.failedBlobs.size,0);assert.deepEqual(events,[]);
 core.fetch=async()=>{calls++;return {ok:false,status:404,statusText:'Not found'};};const before=calls;
 await assert.rejects(core.fetchBlob('missing.zst'),/404/);assert.equal(calls,before+1,'permanent HTTP errors do not retry');
});

test('exhausted image downloads can be supplied again without replacing guest or project state',async()=>{
 const core=new Core({config:{filesystem:{baseurl:'https://files.invalid/'}},agent:null,blobRetryDelays:[0,0]});let calls=0;core.fetch=async()=>{calls++;throw new TypeError('Failed to fetch');};
 await assert.rejects(core.fetchBlob('busybox.zst'),/Failed to fetch/);assert.equal(calls,3);assert(core.failedBlobs.has('busybox.zst'));
 const supplied=[],vm={project:'keep edited source',provide_blob:(...args)=>supplied.push(args)};core.vm=vm;core.state='ready';core.fetch=async()=>response([7]);
 assert.deepEqual(await core.recoverFiles(),{repaired:1});assert.equal(core.vm,vm);assert.equal(vm.project,'keep edited source');assert.equal(supplied[0][0],'busybox.zst');assert.equal(core.failedBlobs.size,0);
});

test('missing image files can be filled from the warm pack without JS failure records',async()=>{
 const index=Buffer.from(JSON.stringify([['busybox.zst',3,3]])),pack=Buffer.alloc(4+index.length+3);pack.writeUInt32LE(index.length);index.copy(pack,4);pack.set([1,2,3],4+index.length);
 const supplied=[],core=new Core({config:{warm:'https://files.invalid/warm.pack'},agent:null,blobRetryDelays:[]});core.vm={has_blob:()=>false,provide_blob:(...args)=>supplied.push(args)};core.state='ready';core.fetch=async()=>response(pack);
 assert.deepEqual(await core.recoverFiles(),{repaired:1});assert.equal(supplied[0][0],'busybox.zst');assert.deepEqual(supplied[0][1],Uint8Array.of(1,2,3));
});

test('upload errors include bounded shell diagnostics and structured step/status without echoed source',()=>{
 const job=new A.Job({id:'aaaaaaaaaaaaaaaa',nonce:'bbbbbbbbbbbbbbbb',ack:'cccccccccccccccc',command:'true',timeoutS:300,now:0});
 job.feed('SGSYNC_'+job.syncTok+'_42\n',0);
 job.feed('printf %s PRIVATE_SOURCE >>file; echo SGACK_cccccccccccccccc_0_$?_$((6*7))\n/bin/sh: mkdir: I/O error\nSGACK_cccccccccccccccc_0_126_42\n',1);
 assert.match(job.error,/mkdir: I\/O error/);assert(!job.error.includes('PRIVATE_SOURCE'));assert.deepEqual(job.view().uploadFailure,{step:0,status:126,message:'/bin/sh: mkdir: I/O error'});
});

// Bundle the real browser client with the same raw guest-module handling as the app build.
const bundled=await build({entryPoints:[new URL('../src/client.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'raw',setup(b){b.onResolve({filter:/\?raw$/},a=>({path:path.resolve(a.resolveDir,a.path.slice(0,-4)),namespace:'raw'}));b.onLoad({filter:/.*/,namespace:'raw'},async a=>({contents:await fs.readFile(a.path,'utf8'),loader:'text'}));}}]});
const {VmClient}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text+'\n//# sourceURL=snowglobe-builder-client-test.mjs').toString('base64'));
function clientFixture(failures){
 const jobs=[],progress=[];let repairs=0;
 const api={async runCommand(input,options){const req=JSON.parse(new TextDecoder().decode(options.files['request.json']));const failure=failures[jobs.length];jobs.push(failure?{state:'failed',output:'',error:'upload failed',uploadFailure:failure}:{state:'exited',exitStatus:0,output:JSON.stringify({...req,ok:true,result:{prepared:true}})});return {jobId:jobs.length-1};},async readJob(id){return jobs[id];},async recoverFiles(){repairs++;},async cancelJob(){}};
 return {client:new VmClient(api,{onProgress:e=>progress.push(e)}),api,jobs,progress,repairs:()=>repairs};
}
test('Builder repairs and retries only a pre-execution bootstrap failure, at most once',async()=>{
 const f=clientFixture([{step:0,status:126}]);assert.deepEqual(await f.client.call('project.initialize'),{prepared:true});assert.equal(f.repairs(),1);assert.equal(f.jobs.length,2);assert(f.progress.some(e=>e.stage==='file-recovery'));
 const repeated=clientFixture([{step:0,status:126},{step:0,status:126}]);await assert.rejects(repeated.client.call('project.initialize'),/upload failed/);assert.equal(repeated.repairs(),1);assert.equal(repeated.jobs.length,2);
 const later=clientFixture([{step:1,status:126}]);await assert.rejects(later.client.call('fs.write'),/upload failed/);assert.equal(later.repairs(),0);assert.equal(later.jobs.length,1);
 const denied=clientFixture([{step:0,status:1}]);await assert.rejects(denied.client.call('project.initialize'),/upload failed/);assert.equal(denied.repairs(),0);
});
test('Stop during bootstrap recovery prevents a new job from being uploaded',async()=>{
 const f=clientFixture([{step:0,status:126}]),abort=new AbortController();f.api.recoverFiles=async()=>abort.abort();
 await assert.rejects(f.client.call('project.initialize',{},abort.signal),/abort/i);assert.equal(f.jobs.length,1);
});

test('VM host replacement reinstalls tools and increments generation; replaced-host results are rejected',async()=>{
 const f=clientFixture([]);let host={id:'first'},requests=[];f.api.wake=async()=>{};f.api._get=()=>({host});const run=f.api.runCommand;
 f.api.runCommand=async(input,options)=>{requests.push(JSON.parse(new TextDecoder().decode(options.files['request.json'])));return run(input,options);};
 await f.client.call('project.initialize');await f.client.call('fs.list');assert.equal(requests[1].vmGeneration,1);
 host={id:'second'};await f.client.call('fs.list');assert.equal(requests[2].vmGeneration,2);
 const read=f.api.readJob;f.api.readJob=async id=>{const result=await read(id);host={id:'replaced while running'};return result;};await assert.rejects(f.client.call('fs.list'),/Stale guest result/);
});

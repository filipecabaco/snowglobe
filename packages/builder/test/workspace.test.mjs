import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {dispatcher,hash} from '../src/guest.mjs';import {SkillRegistry,parseSkill,skillFiles} from '../src/skills.js';import {sourceDiff,restoreVersion} from '../src/history.js';import {zipSync,strToU8} from 'fflate';
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'builder-workspace-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const previous=process.env.SNOWGLOBE_COMPILER_DIR;process.env.SNOWGLOBE_COMPILER_DIR=path.join(dir,'control');t.after(()=>{if(previous)process.env.SNOWGLOBE_COMPILER_DIR=previous;else delete process.env.SNOWGLOBE_COMPILER_DIR;});const root=path.join(dir,'workspace');await fs.mkdir(root);const dispatch=dispatcher(root);return {root,client:{async call(op,params={}){return (await dispatch({protocol:'snowglobe-builder-rpc-v1',id:'test',projectId:'fixture',vmGeneration:1,op,params})).result;}}};}
test('exact edits reject stale and ambiguous content; concurrent writes serialize and deletion checks versions',async t=>{
 const {client,root}=await fixture(t);await client.call('fs.mkdir',{path:'src/components'});
 const original=await client.call('fs.write',{path:'src/a.js',text:'one two one',version:null});
 await assert.rejects(client.call('fs.patch',{path:original.path,version:original.version,search:'one',replacement:'three'}),/exactly once/);
 const changed=await client.call('fs.patch',{path:original.path,version:original.version,search:'two',replacement:'three'});assert.equal((await client.call('fs.read',{path:original.path})).text,'one three one');
 const competing=await Promise.allSettled(['a','b'].map(text=>client.call('fs.write',{path:original.path,version:changed.version,text})));assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);
 await assert.rejects(client.call('fs.remove',{path:original.path,version:original.version}),/Conflict/);const current=await client.call('fs.read',{path:original.path});await client.call('fs.remove',{path:original.path,version:current.version});await assert.rejects(fs.stat(path.join(root,original.path)),{code:'ENOENT'});
 await assert.rejects(client.call('process.run',{command:'sh -c env'}),/Only check and test/);
});
test('project checks persist truthful failures and timeouts kill a running guest test',async t=>{
 const {client,root}=await fixture(t);await fs.writeFile(path.join(root,'hang.test.mjs'),'setInterval(()=>{},1000)');
 const result=await client.call('process.run',{command:'test',timeoutMs:200});assert.equal(result.timedOut,true);assert.equal(result.status,'failed');assert.deepEqual(await client.call('project.diagnostics'),result);
 await fs.writeFile(path.join(root,'hang.test.mjs'),'import {test} from "node:test";test("ok",()=>{});');const passed=await client.call('process.run',{command:'test'});assert.equal(passed.status,'passed');assert.equal(passed.exitCode,0);
});
test('skill imports require review, reject unsafe archives, expose metadata and load only on request',async t=>{
 const {client}=await fixture(t),text='---\nname: accessibility\ndescription: >\n  Improve keyboard\n  navigation\n---\nUse clear labels. Never request host secrets.';
 assert.equal(parseSkill(text).description,'Improve keyboard navigation');assert.throws(()=>parseSkill('no frontmatter'),/frontmatter/);assert.throws(()=>parseSkill(text.replace('accessibility','../escape')),/slug/);
 const archive=zipSync({'SKILL.md':strToU8(text),'scripts/a.js':strToU8('throw Error("must not run");')});const files=skillFiles(archive,'skill.zip');const registry=new SkillRegistry(client);
 await assert.rejects(registry.import(files),/denied/);assert.deepEqual((await client.call('fs.list')).files,[]);
 registry.approve=async request=>{assert.match(request.content,/must not run/);return true;};await registry.import(files);
 const metadata=await registry.discover();assert.equal(metadata.skills.length,1);assert.equal(metadata.skills[0].text,undefined);assert.match((await registry.read('accessibility')).notice,/untrusted/);
 await assert.rejects(registry.import(files),/already exists/);
 assert.throws(()=>skillFiles(zipSync({'../SKILL.md':strToU8(text)}),'bad.zip'),/Invalid/);assert.throws(()=>skillFiles(zipSync({'SKILL.md':strToU8('x'.repeat(65537))}),'bomb.zip'),/limits/);
});
test('source restore reviews diffs, deletes added files, rejects denial, stale review and migration changes',async t=>{
 const {client}=await fixture(t);await client.call('fs.write',{path:'src/a.js',text:'new source',version:null});await client.call('fs.write',{path:'extra.js',text:'extra',version:null});
 const before=(await client.call('project.export')).files,target={'src/a.js':'original'};
 assert.match(sourceDiff(before,target),/--- extra.js/);await assert.rejects(restoreVersion(client,before,target,{approve:async()=>false}),/denied/);assert.equal((await client.call('fs.read',{path:'src/a.js'})).text,'new source');
 await restoreVersion(client,before,target,{approve:async request=>{assert.match(request.description,/Database/);return true;}});assert.deepEqual((await client.call('project.export')).files,target);
 await assert.rejects(restoreVersion(client,target,{}, {approve:async()=>{await client.call('fs.write',{path:'src/a.js',text:'concurrent',version:hash('original')});return true;}}),/changed during review/);
 await assert.rejects(restoreVersion(client,{'supabase/migrations/applied.sql':'CREATE'}, {},{approve:async()=>true}),/migration history/);
});

test('an interrupted multi-file source restore is rolled back before the next guest operation',async t=>{
 const {client,root}=await fixture(t);await client.call('fs.write',{path:'src/a.js',text:'old a',version:null});await client.call('fs.write',{path:'src/b.js',text:'old b',version:null});
 const {compilerPaths}=await import('../src/compiler.mjs');const journal=compilerPaths(root).revision+'.restore';
 await fs.writeFile(journal,JSON.stringify({root,before:{'src/a.js':'old a','src/b.js':'old b','new.js':null}}));
 await fs.writeFile(path.join(root,'src/a.js'),'partly restored');await fs.writeFile(path.join(root,'new.js'),'partial new file');
 const recovered=await client.call('project.export');assert.deepEqual(recovered.files,{'src/a.js':'old a','src/b.js':'old b'});await assert.rejects(fs.stat(journal),{code:'ENOENT'});
 const expected={'src/a.js':hash('old a'),'src/b.js':hash('old b')};await assert.rejects(client.call('project.restore',{expected:{...expected,'src/a.js':'stale'},files:{'src/a.js':'new'}}),/Conflict/);assert.deepEqual((await client.call('project.export')).files,recovered.files);
});

test('interrupting a guest command kills the detached test process group',async t=>{
 const {root}=await fixture(t);const pidFile=path.join(root,'child.pid');
 await fs.writeFile(path.join(root,'interrupt.test.mjs'),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
 const {spawn}=await import('node:child_process');const module=new URL('../src/guest.mjs',import.meta.url).href;
 const code=`import {dispatcher} from ${JSON.stringify(module)};const result=await dispatcher(${JSON.stringify(root)})({protocol:'snowglobe-builder-rpc-v1',id:'interrupt',projectId:'fixture',vmGeneration:1,op:'process.run',params:{command:'test'}});console.log(result.result.status);`;
 const env={...process.env};delete env.NODE_TEST_CONTEXT;const child=spawn(process.execPath,['--input-type=module','-e',code],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();const exited=new Promise(resolve=>child.once('exit',resolve));t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 let pid;for(let n=0;n<200;n++){try{pid=Number(await fs.readFile(pidFile,'utf8'));break;}catch{}await new Promise(r=>setTimeout(r,10));}assert(pid,'guest test child must start before cancellation');
 child.kill('SIGINT');await Promise.race([exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Guest command did not stop')),3000);exited.then(()=>clearTimeout(timer));})]);assert.match(output,/failed/);
 let alive=false;try{const stat=await fs.readFile('/proc/'+pid+'/stat','utf8');alive=!stat.includes(') Z ');}catch{}assert.equal(alive,false,'detached test child must not survive Stop');
});
test('reviewed skill bundle pins persist across registries and changed references require a fresh review',async t=>{
 const {client}=await fixture(t),text='---\nname: search\ndescription: Search guidance\n---\nRead references.',files={'SKILL.md':text,'references/guide.md':'Reviewed guidance'};let pins={},reviews=0;const pinStore=async value=>value===undefined?pins:(pins=structuredClone(value));
 const imported=new SkillRegistry(client,{approve:async()=>true,pinStore});await imported.import(files);assert.equal(Object.keys(pins['.agents/skills/search/SKILL.md']).length,2);
 const reopened=new SkillRegistry(client,{pinStore,approve:async()=>{reviews++;return false;}});assert.equal((await reopened.read('search')).text,text);assert.equal(reviews,0);
 const path='.agents/skills/search/references/guide.md',old=await client.call('fs.read',{path});await client.call('fs.write',{path,text:'Changed guidance',version:old.version});await assert.rejects(reopened.read('search'),/denied/);assert.equal(reviews,1);
 reopened.approve=async()=>{const current=await client.call('fs.read',{path});await client.call('fs.write',{path,text:'Concurrent guidance',version:current.version});return true;};await assert.rejects(reopened.read('search'),/changed during review/);
 reopened.approve=async request=>{assert.match(request.content,/Concurrent guidance/);return true;};assert.equal((await reopened.read('search')).text,text);reopened.approve=undefined;assert.equal((await reopened.read('search')).text,text);
});

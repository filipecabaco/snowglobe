import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {dispatcher,validatePath,hash,inlineAssets,matchesStarter} from '../src/guest.mjs';
const control=await fs.mkdtemp(path.join(os.tmpdir(),'sg-guest-control-'));process.env.SNOWGLOBE_COMPILER_DIR=control;after(()=>fs.rm(control,{recursive:true,force:true}));
const req=(op,params={})=>({protocol:'snowglobe-builder-rpc-v1',id:'test-1',projectId:'test',vmGeneration:1,op,params});
test('guest rejects traversal, secrets, backslashes and absolute paths',()=>{for(const p of ['../foo','/etc/passwd','a/../b','a\\b','a//b','a\nfoo','.env','a/.env.local','node_modules/x','config/.npmrc','.aws/credentials','.ssh/id_rsa','nested/.netrc','.git-credentials'])assert.throws(()=>validatePath(p));});
test('atomic read/write, optimistic conflicts, symlink refusal and clean export',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sg-builder-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const call=dispatcher(dir);
 await call(req('fs.write',{path:'src/App.jsx',text:'hello',version:null}));
 assert.equal((await call(req('fs.read',{path:'src/App.jsx'}))).result.version,hash('hello'));
 assert.equal((await call(req('fs.write',{path:'src/App.jsx',text:'hello',version:hash('hello')}))).result.unchanged,true);
 await assert.rejects(call(req('fs.write',{path:'src/App.jsx',text:'bad',version:null})),/Conflict/);
 await fs.symlink('/tmp',path.join(dir,'escape'));
 await assert.rejects(call(req('fs.write',{path:'escape/file',text:'bad',version:null})),/Symlink/);
 await fs.writeFile(path.join(dir,'.env'),'SECRET');await fs.mkdir(path.join(dir,'node_modules'));await fs.writeFile(path.join(dir,'node_modules/key'),'SECRET');
 for(const name of ['.npmrc','.netrc','.git-credentials'])await fs.writeFile(path.join(dir,name),'SECRET');await fs.mkdir(path.join(dir,'.aws'));await fs.writeFile(path.join(dir,'.aws/credentials'),'SECRET');
 const archive=(await call(req('project.export'))).result;assert.deepEqual(Object.keys(archive.files),['src/App.jsx']);assert(!JSON.stringify(archive).includes('SECRET'));
 const external=await fs.mkdtemp(path.join(os.tmpdir(),'sg-private-'));t.after(()=>fs.rm(external,{recursive:true,force:true}));await fs.writeFile(path.join(external,'secret'),'PRIVATE');await fs.link(path.join(external,'secret'),path.join(dir,'linked'));await assert.rejects(call(req('fs.read',{path:'linked'})),/bounded/);await assert.rejects(call(req('project.export')),/bounded/);await fs.rm(path.join(dir,'linked'));
 await fs.writeFile(path.join(dir,'binary'),Buffer.from([0,2]));await assert.rejects(call(req('fs.read',{path:'binary'})),/Binary/);
 await fs.writeFile(path.join(dir,'big'),'a'.repeat(262145));await assert.rejects(call(req('fs.read',{path:'big'})),/bounded/);
 await assert.rejects(call(req('process.run',{command:'echo nope'})),/Only check and test/);
});

test('preview inlining preserves JavaScript replacement patterns as literal source',async()=>{
 const js = "const text = " + JSON.stringify("$& $` $'") + "; document.body.textContent=text;";
 const css='body::after {content: "$&"}';
 const html=await inlineAssets('<script type="module" src="./app.js"></script><link rel="stylesheet" href="./app.css">',async p=>p.endsWith('.js')?js:css);
 assert(html.includes(js));assert(html.includes(css));assert(!html.includes('src="./app.js"'));
 new Function(js);
});

test('starter status compares source to the installed template, including added components',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sg-starter-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const root=path.join(dir,'project'),template=path.join(dir,'template');
 await fs.mkdir(path.join(template,'src'),{recursive:true});await fs.writeFile(path.join(template,'src/App.jsx'),'starter');await fs.writeFile(path.join(template,'index.html'),'<div id="root"></div>');await fs.cp(template,root,{recursive:true});
 assert.equal(await matchesStarter(root,template),true);
 await fs.writeFile(path.join(root,'src/App.jsx'),'app');assert.equal(await matchesStarter(root,template),false);
 await fs.writeFile(path.join(root,'src/App.jsx'),'starter');await fs.writeFile(path.join(root,'src/Poll.jsx'),'poll');assert.equal(await matchesStarter(root,template),false);
});

test('a file replaced by a symlink after path validation is never read',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sg-open-race-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'source.txt'),secret=path.join(dir,'private.txt');await fs.writeFile(file,'source');await fs.writeFile(secret,'PRIVATE');const original=fs.open;let swapped=false;
 fs.open=async function(name,...args){if(String(name).endsWith('/source.txt')&&!swapped){swapped=true;await fs.rm(file);await fs.symlink(secret,file);}return original.call(this,name,...args);};
 try{await assert.rejects(dispatcher(dir)(req('fs.read',{path:'source.txt'})),error=>error.code==='ELOOP');assert.equal(swapped,true);}finally{fs.open=original;}
});
test('read follows pinned directory descriptors when a parent is renamed and replaced by an external symlink',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sg-parent-race-')),external=await fs.mkdtemp(path.join(os.tmpdir(),'sg-parent-private-'));t.after(async()=>{await fs.rm(dir,{recursive:true,force:true});await fs.rm(external,{recursive:true,force:true});});await fs.mkdir(path.join(dir,'src'));await fs.writeFile(path.join(dir,'src/app.txt'),'original source');await fs.writeFile(path.join(external,'app.txt'),'PRIVATE');
 const original=fs.open;let swapped=false;fs.open=async function(name,...args){if(String(name).endsWith('/app.txt')&&!swapped){swapped=true;await fs.rename(path.join(dir,'src'),path.join(dir,'old-src'));await fs.symlink(external,path.join(dir,'src'));}return original.call(this,name,...args);};
 try{const result=await dispatcher(dir)(req('fs.read',{path:'src/app.txt'}));assert.equal(result.result.text,'original source');assert.equal(swapped,true);}finally{fs.open=original;}
});
test('a file growing after stat cannot exceed the bounded source read allocation',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sg-grow-race-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'source.txt');await fs.writeFile(file,'small');const original=fs.open;let grown=false;
 fs.open=async function(name,...args){const handle=await original.call(this,name,...args);if(String(name).endsWith('/source.txt')){const stat=handle.stat.bind(handle);handle.stat=async()=>{const result=await stat();if(!grown){grown=true;await fs.writeFile(file,Buffer.alloc(1024*1024,65));}return result;};}return handle;};
 try{await assert.rejects(dispatcher(dir)(req('fs.read',{path:'source.txt'})),/bounded source/);assert(grown);}finally{fs.open=original;}
});
test('atomic source writes remain in the pinned directory during a parent symlink swap',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sg-write-parent-')),external=await fs.mkdtemp(path.join(os.tmpdir(),'sg-write-private-'));t.after(async()=>{await fs.rm(dir,{recursive:true,force:true});await fs.rm(external,{recursive:true,force:true});});await fs.mkdir(path.join(dir,'src'));await fs.writeFile(path.join(dir,'src/app.txt'),'original');await fs.writeFile(path.join(external,'app.txt'),'PRIVATE');const original=fs.writeFile;let swapped=false;
 fs.writeFile=async function(name,...args){if(String(name).startsWith('/proc/self/fd/')&&String(name).includes('/app.txt.')&&String(name).endsWith('.tmp')&&!swapped){swapped=true;await fs.rename(path.join(dir,'src'),path.join(dir,'old-src'));await fs.symlink(external,path.join(dir,'src'));}return original.call(this,name,...args);};
 try{await dispatcher(dir)(req('fs.write',{path:'src/app.txt',text:'updated',version:hash('original')}));assert(swapped);assert.equal(await fs.readFile(path.join(external,'app.txt'),'utf8'),'PRIVATE');assert.equal(await fs.readFile(path.join(dir,'old-src/app.txt'),'utf8'),'updated');}finally{fs.writeFile=original;}
});

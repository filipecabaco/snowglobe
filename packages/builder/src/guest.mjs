import {constants as fsConstants} from 'node:fs';
import {privatePathSegment} from './path-policy.js';
import {embedPreviewAssets} from './preview-assets.mjs';
import {fileBytes,sourceFile,sameFile} from './source-files.js';
// Runs only inside the guest, through the existing job-file transport.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {compilerRequest,sourceChanged,compilerPaths} from './compiler.mjs';
import {spawn} from 'node:child_process';
import {createProvisioner,validateProjectPackage,validateLock} from './provision.mjs';
import {catalog} from './template-catalog.mjs';
import {templateFor} from './frameworks.js';
import {buildKit,kitPreview} from './static-preview.mjs';
const LIMIT = 256 * 1024;
const excluded = new Set(['snowglobe-project.json','.snowglobe','node_modules','dist','build','.svelte-kit','.git','.env','.env.local','__proto__','prototype','constructor']);
export const hash = text => createHash('sha256').update(text).digest('hex');
export async function matchesStarter(root,template='/root/app') {
  async function sources(base,dir='src') {
    const entries=await fs.readdir(path.join(base,dir),{withFileTypes:true});const files=[];
    for(const entry of entries){if(entry.isSymbolicLink())throw new Error('Symlink in starter source');const p=dir+'/'+entry.name;if(entry.isDirectory())files.push(...await sources(base,p));else if(entry.isFile())files.push(p);}
    return files;
  }
  try {
    const current=['index.html',...await sources(root)].sort(),original=['index.html',...await sources(template)].sort();
    if(JSON.stringify(current)!==JSON.stringify(original))return false;
    for(const file of current)if(hash(await fs.readFile(path.join(root,file)))!==hash(await fs.readFile(path.join(template,file))))return false;
    return true;
  }catch{return false;}
}
export function validatePath(p) {
  if (typeof p !== 'string' || !p || p.length > 512 || /[\\\x00-\x1f]/.test(p) || path.posix.isAbsolute(p) || p.split('/').some(s=>!s || s==='.' || s==='..' || excluded.has(s) || privatePathSegment(s))) throw new Error('Invalid workspace path');
  return p;
}
export async function inlineAssets(html,asset) {
          for(const m of [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g)]){const js=await asset(m[1]);html=html.replace(m[0],()=>'<script type="module">'+js.replaceAll('</script','<\\/script')+'</script>');}
          for(const m of [...html.matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g)]){const css=await asset(m[1]);html=html.replace(m[0],()=>'<style>'+css.replaceAll('</style','<\\/style')+'</style>');}
          html=html.replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g,'');
  return html;
}
export function dispatcher(root = '/workspace', onProgress = ()=>{}) {
  let diagnostics = ''; let tail=Promise.resolve();
  const diagnosticFile=()=>compilerPaths(root).revision+'.diagnostics';
  async function remember(value){await fs.mkdir(compilerPaths(root).dir,{recursive:true});await fs.writeFile(diagnosticFile(),JSON.stringify(value));return value;}
  async function safe(p, allowMissing=false) {
    validatePath(p);
    const parts=p.split('/');
    for(let i=1;i<=parts.length;i++) {
      try {const s=await fs.lstat(path.join(root,...parts.slice(0,i))); if(s.isSymbolicLink()) throw new Error('Symlinks are not allowed');}
      catch(e) {if(e.code==='ENOENT' && allowMissing) break; throw e;}
    }
    return path.join(root,p);
  }
  async function list(dir='', result=[]) {
    for(const e of await fs.readdir(path.join(root,dir),{withFileTypes:true})) {
      if(excluded.has(e.name)||privatePathSegment(e.name)||e.isSymbolicLink()) continue;
      const p=dir?dir+'/'+e.name:e.name;
      if(result.length>=500) throw new Error('Project exceeds 500 source files');
      if(e.isDirectory()) await list(p,result); else if(e.isFile()) result.push(p);
    }
    return result;
  }
  async function withParent(p,create,action){
    validatePath(p);const handles=[];
    try{
      let directory=await fs.open(root,fsConstants.O_RDONLY|fsConstants.O_DIRECTORY|fsConstants.O_NOFOLLOW);handles.push(directory);const parts=p.split('/');
      for(const segment of parts.slice(0,-1)){
        const name='/proc/self/fd/'+directory.fd+'/'+segment;if(create)try{await fs.mkdir(name);}catch(error){if(error.code!=='EEXIST')throw error;}
        directory=await fs.open(name,fsConstants.O_RDONLY|fsConstants.O_DIRECTORY|fsConstants.O_NOFOLLOW);handles.push(directory);
      }
      return await action('/proc/self/fd/'+directory.fd+'/'+parts.at(-1));
    }finally{for(const handle of handles.reverse())await handle.close();}
  }
  async function openSource(p){
    validatePath(p);const handles=[];
    try{
      let directory=await fs.open(root,fsConstants.O_RDONLY|fsConstants.O_DIRECTORY|fsConstants.O_NOFOLLOW);handles.push(directory);
      const parts=p.split('/');for(const segment of parts.slice(0,-1)){directory=await fs.open('/proc/self/fd/'+directory.fd+'/'+segment,fsConstants.O_RDONLY|fsConstants.O_DIRECTORY|fsConstants.O_NOFOLLOW);handles.push(directory);}
      return await fs.open('/proc/self/fd/'+directory.fd+'/'+parts.at(-1),fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);
    }finally{for(const handle of handles.reverse())await handle.close();}
  }
  async function boundedRead(handle){
    const buffer=Buffer.alloc(LIMIT+1);let offset=0;
    while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
    if(offset>LIMIT)throw Error('Not a bounded source file');return buffer.subarray(0,offset);
  }
  async function read(p) {
    const h=await openSource(p);
    try {const s=await h.stat(); if(!s.isFile()||s.nlink!==1||s.size>LIMIT) throw new Error('Not a bounded text file'); const b=await boundedRead(h);if(b.includes(0))throw new Error('Binary file'); const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b);return {path:p,text,version:hash(text)};}finally{await h.close();}
  }
  async function snapshot(p){const h=await openSource(p);try{const st=await h.stat();if(!st.isFile()||st.nlink!==1||st.size>LIMIT)throw new Error('Not a bounded source file');const bytes=await boundedRead(h);return {value:sourceFile(bytes),version:hash(bytes)};}finally{await h.close();}}
  const journalFile=()=>compilerPaths(root).revision+'.restore';
  async function replace(p,text){
    await safe(p,true);
    return withParent(p,text!==null,async f=>{
      if(text===null){await fs.rm(f,{force:true});return;}
      const bytes=fileBytes(text);if(bytes.length>LIMIT)throw new Error('Invalid source restore size');
      const tmp=f+'.'+randomUUID()+'.tmp';try{await fs.writeFile(tmp,bytes,{flag:'wx'});await fs.rename(tmp,f);}finally{await fs.rm(tmp,{force:true});}
    });
  }
  async function recoverRestore(){
    let journal;try{journal=JSON.parse(await fs.readFile(journalFile(),'utf8'));}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(journal.root!==root||!journal.before||Object.keys(journal.before).length>500)throw new Error('Invalid source restore journal');
    for(const [p,text] of Object.entries(journal.before)){await replace(p,text);await sourceChanged(root,p);}
    if(journal.modules){if(typeof journal.modules!=='string'||!(journal.modules==='/root/app/node_modules'||journal.modules.startsWith('/var/cache/snowglobe-builder/toolchains/')))throw new Error('Invalid dependency target in source restore');const tmp=path.join(root,'.node_modules.'+randomUUID());try{await fs.symlink(journal.modules,tmp);await fs.rename(tmp,path.join(root,'node_modules'));}finally{await fs.rm(tmp,{force:true});}}
    await fs.rm(journalFile());
  }
  async function dispatch(req) {
    if(req.protocol!=='snowglobe-builder-rpc-v1'|| typeof req.id!=='string'||!req.projectId||!Number.isInteger(req.vmGeneration))throw new Error('Invalid request envelope');
    const p=req.params??{}; let result;
    const progress=(stage,message,extra={})=>onProgress({id:req.id,projectId:req.projectId,vmGeneration:req.vmGeneration,stage,message,...extra});
    const provision=createProvisioner({onProgress:progress});
    const messages={'project.initialize':'Preparing your project files','fs.read':'Reading your source file','fs.write':'Saving your source change','fs.list':'Inspecting your project files','project.export':'Collecting your source for export','preview.build':'Starting the build inside your environment'};
    progress('guest-'+req.op,messages[req.op]||'Your environment is responding');
    if(!['project.initialize','project.info','project.templates'].includes(req.op)){let st;try{st=await fs.lstat(root);}catch(error){if(error.code==='ENOENT')throw new Error('Initialize a framework before using project tools');throw error;}if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Initialize a framework before using project tools');await provision.recover(root);await recoverRestore();}
    switch(req.op) {
      case 'project.initialize': {
        result=await provision.initialize(root,p.template||'react-vite',{experimental:p.experimental===true});break;
      }
      case 'project.info': {try{const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Invalid workspace root');await provision.recover(root);await recoverRestore();result={initialized:true,...await provision.info(root)};}catch(error){if(error.code!=='ENOENT')throw error;result={initialized:false};}break;}
      case 'project.templates':result={templates:provision.templates()};break;
      case 'project.dependencies': {result=await provision.dependencies(root,p.packages,{beforeCommit:()=>compilerRequest(root,'stop',progress)});if(!result.unchanged)await sourceChanged(root,'package.json');break;}
      case 'fs.list':result={files:await list()};break;
      case 'fs.read': result=await read(p.path);break;
      case 'fs.mkdir': {await safe(p.path,true);await withParent(p.path,true,async f=>{try{await fs.mkdir(f);}catch(error){if(error.code!=='EEXIST')throw error;}const handle=await fs.open(f,fsConstants.O_RDONLY|fsConstants.O_DIRECTORY|fsConstants.O_NOFOLLOW);await handle.close();});result={path:p.path};break;}
      case 'fs.remove': {
        const f=await safe(p.path);const old=await read(p.path);
        if(['snowglobe-project.json','package.json','package-lock.json'].includes(p.path))throw new Error('Framework and dependency manifests are managed by the project tools');
        if(p.path.startsWith('supabase/migrations/'))throw new Error('Migration history cannot be deleted; create a repair migration');
        if(p.version!==old.version)throw new Error('Conflict: read the latest file before deleting');
        await withParent(p.path,false,f=>fs.unlink(f));await sourceChanged(root,p.path);result={path:p.path,removed:true};break;
      }
      case 'fs.patch':
      case 'fs.write': {
        const f=await safe(p.path,true);
        let old=null;try{old=await read(p.path);}catch(e){if(e.code!=='ENOENT')throw e;}
        if(p.version!==(old?.version??null))throw new Error('Conflict: read the latest file before writing');
        if(req.op==='fs.patch'){
          if(!old||typeof p.search!=='string'||!p.search||typeof p.replacement!=='string')throw new Error('An edit needs an existing file and nonempty exact search text');
          const first=old.text.indexOf(p.search);if(first<0||old.text.indexOf(p.search,first+1)>=0)throw new Error('Edit search must match exactly once');
          p.text=old.text.slice(0,first)+p.replacement+old.text.slice(first+p.search.length);
        }
        if(typeof p.text!=='string'||Buffer.byteLength(p.text)>LIMIT)throw new Error('Text exceeds limit');
        if(p.path==='snowglobe-project.json'&&old?.text!==p.text)throw new Error('The framework manifest is managed by the project initializer');
        if(p.path==='package-lock.json'&&old?.text!==p.text)throw new Error('Use install_dependencies to change the dependency lockfile');
        if(p.path==='package.json'&&old){const previous=JSON.parse(old.text),next=JSON.parse(p.text);for(const key of ['dependencies','devDependencies','optionalDependencies','workspaces','overrides','resolutions'])if(JSON.stringify(Object.entries(previous[key]||{}).sort())!==JSON.stringify(Object.entries(next[key]||{}).sort()))throw new Error('Use install_dependencies to change project dependencies');}
        if(p.path.startsWith('supabase/migrations/')&&old&&old.text!==p.text)throw new Error('Migration history is immutable; create a new repair migration');
        if(old?.text===p.text){result={path:p.path,version:old.version,unchanged:true};break;}
        await withParent(p.path,true,async f=>{const tmp=f+'.'+randomUUID()+'.tmp';try{await fs.writeFile(tmp,p.text,{flag:'wx'});await fs.rename(tmp,f);}finally{await fs.rm(tmp,{force:true});}});
        await sourceChanged(root,p.path);result={path:p.path,version:hash(p.text)};break;
      }
      case 'project.export': {
        const files=Object.create(null);let total=0;for(const f of await list()){const r=await snapshot(f);total+=fileBytes(r.value).length;if(total>600*1024)throw new Error('Export exceeds development limit');files[f]=r.value;}result={format:'snowglobe-source-v2',template:(await provision.info(root)).id,files:{...files}};break;
      }
      case 'project.restore': {
        const supplied=p.changes??p.files;
        if(!supplied||typeof supplied!=='object'||!p.expected||typeof p.expected!=='object'||Object.keys(supplied).length>500)throw new Error('Invalid source restore');
        const existing=await list(),before=Object.create(null);const known=Object.keys(p.expected).sort();
        if(JSON.stringify([...existing].sort())!==JSON.stringify(known))throw new Error('Conflict: project changed during review');
        let total=0;for(const [file,text] of Object.entries(supplied)){await safe(file,true);if(p.changes&&text===null)continue;if(fileBytes(text).length>LIMIT||(total+=fileBytes(text).length)>600*1024)throw new Error('Source restore exceeds text limits');}
        for(const file of existing){const value=await snapshot(file);if(p.expected[file]!==value.version)throw new Error('Conflict: project changed during review');before[file]=value.value;}
        const target=p.changes?{...before,...p.changes}:p.files;
        for(const file of Object.keys(target))if(target[file]===null)delete target[file];
        if(Object.keys(target).length>500||Object.values(target).reduce((sum,value)=>sum+fileBytes(value).length,0)>600*1024)throw new Error('Source restore exceeds file limits');
        for(const [name,value] of Object.entries(target))if((name.startsWith('supabase/migrations/')||['package.json','package-lock.json','snowglobe-project.json'].includes(name))&&typeof value!=='string')throw new Error('Project manifests and migrations must be UTF-8 text');
        if([...new Set([...existing,...Object.keys(target)])].some(file=>file.startsWith('supabase/migrations/')&&Object.hasOwn(before,file)&&before[file]!==target[file]))throw new Error('Source restore cannot change migration history');
        if(target['snowglobe-project.json']){const metadata=JSON.parse(target['snowglobe-project.json']),info=await provision.info(root);if(metadata.template!==info.id||metadata.version!==info.version)throw new Error('Source restore cannot change frameworks');}
        if(before['snowglobe-project.json'])target['snowglobe-project.json']=before['snowglobe-project.json'];
        let moduleTarget,oldModules;
        if(before['package.json']!==target['package.json']||before['package-lock.json']!==target['package-lock.json']){
          if(!target['package.json']||!target['package-lock.json'])throw new Error('Source restore must preserve both dependency manifests');
          const pkg=validateProjectPackage(JSON.parse(target['package.json'])),lock=validateLock(JSON.parse(target['package-lock.json']));
          const graph=await provision.graph(pkg,{lock});moduleTarget=path.join(graph.directory,'node_modules');oldModules=await fs.readlink(path.join(root,'node_modules'));
          if(target['snowglobe-project.json']){const metadata=JSON.parse(target['snowglobe-project.json']),info=await provision.info(root);if(metadata.template!==info.id||metadata.version!==info.version)throw new Error('Source restore cannot change frameworks');target['snowglobe-project.json']=JSON.stringify({...metadata,dependencyKey:graph.key,toolchain:info.toolchain},null,2)+'\n';}
        }
        const changes=[...new Set([...existing,...Object.keys(target)])].filter(file=>!sameFile(before[file],target[file]));
        if(changes.some(file=>file.startsWith('supabase/migrations/')&&Object.hasOwn(before,file)))throw new Error('Source restore cannot change migration history');
        if(!changes.length){result={unchanged:true};break;}
        await compilerRequest(root,'stop',progress);
        for(const file of existing)if(!sameFile((await snapshot(file)).value,before[file]))throw new Error('Conflict: project changed while preparing the restore');
        await fs.mkdir(compilerPaths(root).dir,{recursive:true});
        await fs.writeFile(journalFile(),JSON.stringify({root,before:Object.fromEntries(changes.map(file=>[file,before[file]??null])),modules:oldModules}),{flag:'wx',mode:0o600});
        try{for(const file of changes){await replace(file,target[file]??null);await sourceChanged(root,file);}if(moduleTarget){const tmp=path.join(root,'.node_modules.'+randomUUID());try{await fs.symlink(moduleTarget,tmp);await fs.rename(tmp,path.join(root,'node_modules'));}finally{await fs.rm(tmp,{force:true});}}await fs.rm(journalFile());}
        catch(error){try{await recoverRestore();}catch(rollback){throw new Error('Source restore interrupted; recovery will retry before the next operation: '+rollback.message);}throw error;}
        result={restored:true,files:changes};break;
      }
      case 'project.diagnostics': {try{result=JSON.parse(await fs.readFile(diagnosticFile(),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;result={status:'not-run',output:'No checks have run yet.'};}break;}
      case 'process.run': {
        if(!['check','test'].includes(p.command))throw new Error('Only check and test commands are allowed; use build_preview to compile');
        const timeout=p.timeoutMs??60000;if(!Number.isInteger(timeout)||timeout<1||timeout>60000)throw new Error('Command timeout must be between 1 and 60000 ms');
        const tests=p.command==='test'?(await list()).filter(file=>!/^\.(agents|pi)\//.test(file)&&/\.(test|spec)\.[cm]?[jt]s$/.test(file)):[];
        if(p.command==='test'&&!tests.length)throw new Error('No project test files found');
        const template=templateFor(catalog,(await provision.info(root)).id);
        const args=p.command==='check'?(template.scripts.check==='svelte-check'?[path.join(root,'node_modules/svelte-check/bin/svelte-check'),'--tsconfig','./tsconfig.json']:[path.join(root,'node_modules/typescript/bin/tsc'),'--noEmit']):['--test',...tests];
        const env={...process.env};delete env.NODE_TEST_CONTEXT;
        result=await new Promise((resolve,reject)=>{
          const child=spawn(process.execPath,args,{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});let output='',timedOut=false,truncated=false;
          const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
          const stop=()=>kill();process.once('SIGTERM',stop);process.once('SIGINT',stop);
          const cleanup=()=>{clearTimeout(timer);process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);};
          const timer=setTimeout(()=>{timedOut=true;kill();},timeout);
          const capture=b=>{output+=b.toString();if(Buffer.byteLength(output)>32000){output=output.slice(-8000);truncated=true;kill();}progress('command-output','Running project '+p.command,{log:b.toString().slice(-1000)});};
          child.stdout.on('data',capture);child.stderr.on('data',capture);
          child.once('error',error=>{cleanup();reject(error);});
          child.once('close',(code,signal)=>{cleanup();resolve({command:p.command,exitCode:code,signal,timedOut,truncated,status:code===0&&!timedOut&&!truncated?'passed':'failed',output});});
        });await remember(result);break;
      }
      case 'preview.build': {
        try {
          const framework=await provision.info(root),definition=templateFor(catalog,framework.id);
          if(definition.preview.kind==='sveltekit-static'){
            const compiled=await buildKit(root,progress);progress('packaging','Bundling the isolated SvelteKit preview');
            const html=await kitPreview(root);let starter=true;for(const [name,text] of Object.entries(definition.files))if(await fs.readFile(path.join(root,name),'utf8').catch(()=>null)!==text){starter=false;break;}
            result={html,diagnostics:compiled.diagnostics,compiler:compiled,starter,template:framework.id};await remember({status:'passed',command:'build',output:compiled.diagnostics});break;
          }
          const compiled=await compilerRequest(root,'build',progress);diagnostics=compiled.diagnostics;
          progress('packaging','Preparing the isolated preview');
          const info=await provision.info(root),template=templateFor(catalog,info.id);if(template.preview.kind!=='vite-static')throw new Error('This preview adapter has not passed its compatibility gate');
          const output=path.join(root,template.preview.outputDirectory);let html=await fs.readFile(path.join(output,'index.html'),'utf8');
          const asset=async src=>{const relative=src.replace(/^\.\//,'');if(relative.startsWith('/')||relative.includes('..'))throw new Error('Unsupported asset path');const f=path.join(output,relative);const s=await fs.lstat(f);if(!s.isFile()||s.isSymbolicLink()||s.size>800*1024)throw new Error('Unsupported preview asset');const text=await fs.readFile(f,'utf8');return relative.endsWith('.css')?embedPreviewAssets(text,output,{referenceFile:relative}):text;};
          html=await embedPreviewAssets(await inlineAssets(html,asset),output);
          if(Buffer.byteLength(html)>800*1024)throw new Error('Preview exceeds development limit');
          let starter=template.usesImageStarter?await matchesStarter(root):true;if(!template.usesImageStarter)for(const [name,text] of Object.entries(template.files))if(await fs.readFile(path.join(root,name),'utf8').catch(()=>null)!==text){starter=false;break;}
          progress('preview-ready','Preview files are ready');result={html,diagnostics,compiler:compiled,starter,template:info.id};await remember({status:'passed',command:'build',output:diagnostics});
        } catch(e) {await remember({status:'failed',command:'build',output:String(e.stdout??e.message).slice(-12000)});throw new Error('Build failed: '+String(e.stdout??e.message).slice(-12000));}break;
      }
      case 'compiler.quiesce':result=await compilerRequest(root,'quiesce',progress);break;
      case 'compiler.stop':result=await compilerRequest(root,'stop',progress);break;
      default:throw new Error('Unsupported operation');
    }
    return {id:req.id,projectId:req.projectId,vmGeneration:req.vmGeneration,ok:true,result};
  }
  // Also serialize callers that share a dispatcher in native integration tests.
  return req=>{const work=tail.then(()=>dispatch(req));tail=work.catch(()=>{});return work;};
}
if(process.argv[2]) {
  try {const req=JSON.parse(await fs.readFile(process.argv[2],'utf8'));console.log(JSON.stringify(await dispatcher('/workspace',event=>console.log('SG_BUILDER_PROGRESS '+JSON.stringify(event)))(req)));}
  catch(e){console.log(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}
}

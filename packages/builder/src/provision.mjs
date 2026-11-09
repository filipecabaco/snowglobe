// Runs in the owning source VM, never in the gateway or generated preview.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {catalog,locks} from './template-catalog.mjs';
import {templateFor,templateSummary,packageManifest,validatePackages,validateInstallPackages} from './frameworks.js';
const digest=value=>createHash('sha256').update(value).digest('hex');
const marker='snowglobe-project.json';
export function validateLock(lock){
 if(!lock||lock.lockfileVersion!==3||!lock.packages||typeof lock.packages!=='object')throw new Error('A version 3 npm lockfile is required');
 for(const [name,value] of Object.entries(lock.packages)){
  if(!name)continue;
  if(!name.startsWith('node_modules/')||name.split('/').some(part=>part==='.'||part==='..'||!part)||typeof value!=='object'||!value)throw new Error('Invalid dependency lock path');
  if(value.link)throw new Error('Linked/workspace dependencies are unavailable');
  if(value.resolved){const url=new URL(value.resolved);if(url.origin!=='https://registry.npmjs.org'||url.username||url.password||url.search||url.hash||!url.pathname.endsWith('.tgz'))throw new Error('Lockfile contains a non-registry dependency');if(!/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(value.integrity||''))throw new Error('Registry dependencies require a supported integrity hash');}
  else if(!value.inBundle)throw new Error('Unresolved dependency in lockfile');
 }
 return lock;
}
export function validateProjectPackage(pkg){
 if(!pkg||pkg.type!=='module'||pkg.workspaces||pkg.overrides||pkg.resolutions||pkg.optionalDependencies||pkg.bundleDependencies||pkg.bundledDependencies)throw new Error('Unsupported project dependency configuration');
 validatePackages(pkg.dependencies||{});validatePackages(pkg.devDependencies||{});
 if(Object.keys({...pkg.dependencies,...pkg.devDependencies}).length>60)throw new Error('Project exceeds 60 direct dependencies');
 return pkg;
}
export async function runNpm(directory,{cache,registry='http://127.0.0.1:4874/',signal,onProgress=()=>{},timeoutMs=600000,ci=false}={}){
 if(!['http://127.0.0.1:4874/','https://registry.npmjs.org/'].includes(registry))throw new Error('Unsupported package registry');
 signal?.throwIfAborted();
 const env={...process.env,npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false',npm_config_registry:registry,npm_config_cache:cache,npm_config_maxsockets:'4'};
 delete env.NODE_TEST_CONTEXT;
 const args=[ci?'ci':'install','--ignore-scripts','--include=dev','--no-audit','--no-fund','--no-progress','--package-lock=true','--prefer-offline'];
 return new Promise((resolve,reject)=>{
  const child=spawn('npm',args,{cwd:directory,env,detached:true,stdio:['ignore','pipe','pipe']});let output='',timedOut=false,stopped=false;
  const kill=()=>{stopped=true;try{process.kill(-child.pid,'SIGKILL');}catch{}};
  const interrupt=()=>kill();process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);signal?.addEventListener('abort',kill,{once:true});if(signal?.aborted)kill();
  const timer=setTimeout(()=>{timedOut=true;kill();},timeoutMs);
  const heartbeat=setInterval(()=>onProgress('heartbeat','The package installer is running'),2500);
  const cleanup=()=>{clearTimeout(timer);clearInterval(heartbeat);signal?.removeEventListener('abort',kill);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);};
  const capture=chunk=>{const text=chunk.toString();output=(output+text).slice(-12000);onProgress('install-output','Installing your project packages',{log:text.slice(-1000)});};
  child.stdout.on('data',capture);child.stderr.on('data',capture);
  child.once('error',()=>{cleanup();reject(new Error('The guest npm executable could not start'));});
  child.once('close',code=>{cleanup();if(code===0&&!stopped)resolve({output});else reject(new Error(timedOut?'Package installation timed out':stopped?'Package installation stopped':'Package installation failed: '+output));});
 });
}
export function createProvisioner({base='/root/app',cache='/var/cache/snowglobe-builder',registry='http://127.0.0.1:4874/',install=runNpm,onProgress=()=>{},templateLocks=locks,seedImage=true}={}){
 const toolchain={node:process.versions.node,platform:process.platform,arch:process.arch,libc:process.platform==='linux'?'pending':'native'};
 const identify=()=>{if(toolchain.libc==='pending')toolchain.libc=process.report?.getReport().header.glibcVersionRuntime||'musl';};
 const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
 const rootKey=root=>digest(root).slice(0,16);
 const journalPath=root=>path.join(cache,'journals',rootKey(root)+'.json');
 async function atomic(file,text){const tmp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(tmp,text,{flag:'wx',mode:0o600});await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true});}}
 async function symlink(target,file){const tmp=file+'.'+randomUUID()+'.next';try{await fs.symlink(target,tmp);await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true});}}
 async function probe(modules,pkg){
  for(const [name,version] of Object.entries({...pkg.dependencies,...pkg.devDependencies})){
   try{if((await json(path.join(modules,name,'package.json'))).version!==version)return false;}catch{return false;}
  }
  return true;
 }
 async function graph(pkg,{lock,signal,update=false}={}){
  validateProjectPackage(pkg);signal?.throwIfAborted();
  identify();
  if(lock){validateLock(lock);if(!update)for(const key of ['dependencies','devDependencies'])if(JSON.stringify(Object.entries(lock.packages['']?.[key]||{}).sort())!==JSON.stringify(Object.entries(pkg[key]||{}).sort()))throw new Error('The dependency lockfile does not match the project manifest');}
  const canonical=JSON.stringify({...pkg,dependencies:Object.fromEntries(Object.entries(pkg.dependencies||{}).sort()),devDependencies:Object.fromEntries(Object.entries(pkg.devDependencies||{}).sort())});
  const key=digest(JSON.stringify({toolchain,manifest:canonical,lock:lock?digest(JSON.stringify(lock)):null})),directory=path.join(cache,'toolchains',key);
  try{const ready=await json(path.join(directory,'ready.json'));const locked=validateLock(await json(path.join(directory,'package-lock.json')));if(ready.key===key&&ready.lockHash===digest(JSON.stringify(locked))&&await probe(path.join(directory,'node_modules'),pkg)){onProgress('dependencies-cached','Restoring cached project packages');return {directory,key,lock:locked,cached:true};}}catch{}
  await fs.mkdir(path.dirname(directory),{recursive:true});const staging=directory+'.'+randomUUID()+'.installing';await fs.mkdir(staging);
  try{
   await fs.writeFile(path.join(staging,'package.json'),canonical);
   let seeded=false;
   if(seedImage&&!update&&await probe(path.join(base,'node_modules'),pkg)){
    try{const seed=validateLock(await json(path.join(base,'package-lock.json')));if(lock&&!Object.entries(lock.packages).every(([name,entry])=>!name||(seed.packages[name]?.version===entry.version&&seed.packages[name]?.integrity===entry.integrity)))throw new Error('The image dependency graph differs from this lockfile');seed.name=pkg.name;seed.packages['']={name:pkg.name,dependencies:pkg.dependencies||{},devDependencies:pkg.devDependencies||{}};await fs.writeFile(path.join(staging,'package-lock.json'),JSON.stringify(lock||seed,null,2)+'\n');await fs.symlink(path.join(base,'node_modules'),path.join(staging,'node_modules'));seeded=true;}catch{}
   }
   if(!seeded){if(lock){validateLock(lock);await fs.writeFile(path.join(staging,'package-lock.json'),JSON.stringify(lock,null,2)+'\n');}onProgress('dependencies-install','Installing the selected framework packages');await install(staging,{cache:path.join(cache,'npm'),registry,signal,onProgress,ci:!!lock&&!update});}
   signal?.throwIfAborted();const locked=validateLock(await json(path.join(staging,'package-lock.json')));
   if(lock&&!update&&digest(JSON.stringify(locked))!==digest(JSON.stringify(lock)))throw new Error('Installation changed the pinned dependency lockfile');
   if(!await probe(path.join(staging,'node_modules'),pkg))throw new Error('Installed dependency versions do not match the project manifest');
   await fs.writeFile(path.join(staging,'ready.json'),JSON.stringify({key,toolchain,lockHash:digest(JSON.stringify(locked))}));
   // Complete immutable cache entries are reused only after all probes pass.
   await fs.rename(staging,directory);return {directory,key,lock:locked,cached:seeded};
  }finally{await fs.rm(staging,{recursive:true,force:true});}
 }
 async function info(root){
  identify();
  let metadata;try{metadata=await json(path.join(root,marker));}catch(error){if(error.code!=='ENOENT')throw error;metadata={template:'react-vite',version:templateFor(catalog,'react-vite').version,legacy:true};}
  const template=templateFor(catalog,metadata.template);if(metadata.version!==template.version)throw new Error('This template version requires a supported project migration');
  return {...templateSummary(template),toolchain,dependencyKey:metadata.dependencyKey,legacy:metadata.legacy};
 }
 async function recover(root){
  let journal;try{journal=await json(journalPath(root));}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(journal.root!==root||typeof journal.modules!=='string'||!(journal.modules===path.join(base,'node_modules')||journal.modules.startsWith(path.join(cache,'toolchains')+path.sep)))throw new Error('Invalid dependency recovery journal');
  for(const [name,text] of Object.entries(journal.files)){if(!['package.json','package-lock.json',marker].includes(name))throw new Error('Invalid dependency recovery file');if(text===null)await fs.rm(path.join(root,name),{force:true});else await atomic(path.join(root,name),text);}
  await symlink(journal.modules,path.join(root,'node_modules'));await fs.rm(journalPath(root));onProgress('dependencies-recovered','Recovered the previous usable dependency graph');
 }
 async function initialize(root,id='react-vite',{signal,experimental=false}={}){
  const template=templateFor(catalog,id);if(template.status==='compatibility-gate'&&!experimental)throw new Error('This framework has not passed its compatibility gate');
  if(Number(process.versions.node.split('.')[0])<template.toolchain.minimumNodeMajor)throw new Error('The guest Node version is incompatible with this template');
  try{const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Invalid project workspace');await recover(root);const existing=await info(root);if(existing.id!==id)throw new Error('Choose a different framework when creating a new project; existing source will not be overwritten');return {...existing,root,existing:true};}catch(error){if(error.code!=='ENOENT')throw error;}
  const staging=root+'.'+randomUUID()+'.initializing';await fs.mkdir(staging,{recursive:true});
  try{
   const pkg=template.usesImageStarter?validateProjectPackage(await json(path.join(base,'package.json'))):packageManifest(template);
   if(template.usesImageStarter)await fs.cp(base,staging,{recursive:true,dereference:false,filter:file=>!['node_modules','dist','.env','.git'].includes(path.basename(file))&&!path.basename(file).startsWith('.env.')});
   else for(const [name,text] of Object.entries(template.files)){await fs.mkdir(path.dirname(path.join(staging,name)),{recursive:true});await fs.writeFile(path.join(staging,name),text);}
   await fs.writeFile(path.join(staging,'package.json'),JSON.stringify(pkg,null,2)+'\n');
   const installed=await graph(pkg,{signal,lock:templateLocks[id]});await fs.writeFile(path.join(staging,'package-lock.json'),JSON.stringify(installed.lock,null,2)+'\n');
   await fs.symlink(path.join(installed.directory,'node_modules'),path.join(staging,'node_modules'));
   await fs.writeFile(path.join(staging,marker),JSON.stringify({format:1,template:id,version:template.version,dependencyKey:installed.key,toolchain},null,2)+'\n');
   signal?.throwIfAborted();await fs.rename(staging,root);onProgress('framework-ready',template.displayName+' source and packages are ready');return {...await info(root),root,cached:installed.cached};
  }finally{await fs.rm(staging,{recursive:true,force:true});}
 }
 async function dependencies(root,packages,{signal,beforeCommit=async()=>{}}={}){
  validateInstallPackages(packages);
  await recover(root);const metadata=await info(root),pkg=validateProjectPackage(await json(path.join(root,'package.json'))),snapshot={};
  for(const name of ['package.json','package-lock.json',marker])try{snapshot[name]=await fs.readFile(path.join(root,name),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;snapshot[name]=null;}
  if(Object.entries(packages).every(([name,version])=>(pkg.dependencies?.[name]||pkg.devDependencies?.[name])===version))return {packages,unchanged:true,dependencyKey:metadata.dependencyKey};
  const previousLock=validateLock(await json(path.join(root,'package-lock.json')));
  pkg.dependencies={...pkg.dependencies,...packages};for(const name of Object.keys(packages))if(pkg.devDependencies)delete pkg.devDependencies[name];
  const installed=await graph(pkg,{signal,lock:previousLock,update:true});signal?.throwIfAborted();
  await beforeCommit();signal?.throwIfAborted();
  const modules=await fs.readlink(path.join(root,'node_modules'));const before={};for(const name of ['package.json','package-lock.json',marker])try{before[name]=await fs.readFile(path.join(root,name),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;before[name]=null;}
  for(const name of Object.keys(snapshot))if(before[name]!==snapshot[name])throw new Error('Conflict: dependency manifests changed during installation');
  await fs.mkdir(path.dirname(journalPath(root)),{recursive:true});await fs.writeFile(journalPath(root),JSON.stringify({root,modules,files:before}),{flag:'wx',mode:0o600});
  try{await atomic(path.join(root,'package.json'),JSON.stringify(pkg,null,2)+'\n');await atomic(path.join(root,'package-lock.json'),JSON.stringify(installed.lock,null,2)+'\n');await symlink(path.join(installed.directory,'node_modules'),path.join(root,'node_modules'));await atomic(path.join(root,marker),JSON.stringify({format:1,template:metadata.id,version:metadata.version,dependencyKey:installed.key,toolchain},null,2)+'\n');await fs.rm(journalPath(root));}
  catch(error){await recover(root);throw error;}
  return {packages,cached:installed.cached,dependencyKey:installed.key};
 }
 return {initialize,dependencies,info,recover,graph,templates:()=>catalog.templates.map(t=>templateSummary(templateFor(catalog,t.id)))};
}

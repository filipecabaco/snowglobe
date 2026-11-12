// Runs inside the browser's Linux guest, never on the development server.
import fs from 'node:fs/promises';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {buildSettings, relativePath} from './environments.mjs';
import {sourcePath, limits} from './project.mjs';
import {createHash,randomUUID} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export async function createInstallRegistry({lock,log=console.log,upstream='https://registry.npmjs.org',attempts=3,port=0}={}) {
  const integrities=new Map();
  for (const entry of Object.values(lock?.packages || {})) if (entry?.resolved && entry.integrity) {
    const integrity=entry.integrity.split(/\s+/).find(value=>/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(value));
    if (integrity) integrities.set(decodeURIComponent(new URL(entry.resolved).pathname),integrity);
  }
  const transport=upstream.startsWith('https:') ? https : http;
  const pending=new Set();
  const download=(pathname,accept,onRequest)=>new Promise((resolve,reject)=>{
    // Do not reuse upstream sockets across long CPU-bound package extractions in the guest.
    const request=transport.get(new URL(pathname,upstream),{agent:false,headers:{accept}},response=>{
      const chunks=[];let bytes=0,failed=false;
      response.on('data',chunk=>{
        if (failed) return;
        bytes+=chunk.length;
        if (bytes>(64<<20)) {failed=true;request.destroy(Error('Registry response exceeds 64 MiB'));return;}
        chunks.push(chunk);
      });
      response.once('error',reject);
      response.once('aborted',()=>reject(Error('The package download ended early')));
      response.once('end',()=>{
        if (failed) return;
        try {
          if (!response.complete) throw Error('The package download ended early');
          const body=Buffer.concat(chunks,bytes),integrity=integrities.get(pathname);
          if (response.statusCode===200 && integrity) {
            const split=integrity.indexOf('-'),algorithm=integrity.slice(0,split);
            if (createHash(algorithm).update(body).digest('base64')!==integrity.slice(split+1)) throw Error('The package download failed its lockfile integrity check');
          } else if (response.statusCode===200 && pathname.endsWith('.tgz')) {
            // Unlocked projects still reject truncated gzip files before npm extracts them.
            gunzipSync(body,{maxOutputLength:256<<20});
          }
          resolve({status:response.statusCode || 502,body,type:response.headers['content-type'] || 'application/octet-stream'});
        } catch(error) {reject(error);}
      });
    });
    onRequest(request);
    pending.add(request);request.once('close',()=>pending.delete(request));
    request.setTimeout(15*60*1000,()=>request.destroy(Error('The registry download stalled')));
    request.once('error',reject);
  });
  const server=http.createServer(async(req,res)=>{
    if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405).end();return;}
    let pathname;
    try {pathname=decodeURIComponent(req.url);} catch {res.writeHead(400).end();return;}
    if (pathname.startsWith('/-/') || !/^\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/(?:[a-z0-9.+_-]+|-\/[a-z0-9._-]+\.tgz))?$/i.test(pathname) || pathname.split('/').some(part=>part==='.' || part==='..')) {res.writeHead(400).end();return;}
    const value=req.headers.accept;
    const accept=typeof value==='string' && value.length<=128 && !/[\x00-\x08\x0a-\x1f"():<>?@[\\\]{}\x7f]/.test(value) ? value : 'application/json';
    let current;
    res.once('close',()=>{if (!res.writableFinished) current?.destroy();});
    for (let attempt=1;attempt<=attempts;attempt++) {
      try {
        const result=await download(pathname,accept,request=>{current=request;});
        if (result.status>=500) throw Error('The npm registry returned '+result.status);
        if (res.destroyed) return;
        res.writeHead(result.status,{'Content-Type':result.type,'Content-Length':result.body.length});
        res.end(req.method==='HEAD' ? undefined : result.body);return;
      } catch(error) {
        if (res.destroyed) return;
        if (attempt===attempts) {res.writeHead(502,{'Content-Type':'text/plain'}).end('Package download failed: '+error.message);return;}
        log('Retrying incomplete package download ('+(attempt+1)+'/'+attempts+'): '+pathname);
      }
    }
  });
  // npm can be busy unpacking thousands of files. An idle local socket must not expire
  // after Node's normal five-second keep-alive period while that work blocks the guest.
  server.keepAliveTimeout=0;server.requestTimeout=0;server.headersTimeout=0;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {url:'http://127.0.0.1:'+server.address().port+'/',server,async close(){
    for (const request of pending) request.destroy();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }};
}

const optionalText = file => fs.readFile(file,'utf8').catch(error => {if (error.code==='ENOENT') return null; throw error;});
const lockNames = ['npm-shrinkwrap.json','package-lock.json'];

async function inputs(root) {
  const manifest=await fs.readFile(path.join(root,'package.json'),'utf8');
  const locks=await Promise.all(lockNames.map(name=>optionalText(path.join(root,name))));
  return {manifest,locks,pkg:JSON.parse(manifest)};
}

function registryOnly({pkg,locks}) {
  // Local links depend on source contents as well as manifests. Keep installing those in their
  // source snapshot until we support hashing their complete local dependency graph.
  const external = value => typeof value==='string' && /^(?:file:|link:|workspace:|git(?:\+|:)|github:|gitlab:|bitbucket:|https?:|\.\.?\/|\/)/i.test(value);
  const scan = value => value && typeof value==='object' ? Object.values(value).some(scan) : external(value);
  if (['dependencies','devDependencies','optionalDependencies','overrides'].some(key=>scan(pkg[key]))) return false;
  for (const text of locks) if (text) {
    const lock=JSON.parse(text);
    if (Object.values(lock.packages || {}).some(entry=>entry?.link || (entry?.resolved && !/^(?:https:\/\/registry\.npmjs\.org|http:\/\/127\.0\.0\.1:4874)\//.test(entry.resolved)))) return false;
  }
  // GitHub's owner/repo shorthand has no protocol.
  return Object.values({...pkg.dependencies,...pkg.devDependencies,...pkg.optionalDependencies}).every(spec=>typeof spec==='string' && (!spec.includes('/') || spec.startsWith('npm:')));
}

async function completeModules(directory,pkg) {
  const stat=await fs.lstat(directory).catch(()=>null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  for (const name of Object.keys({...pkg.dependencies,...pkg.devDependencies})) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) return false;
    if (!await fs.access(path.join(directory,name,'package.json')).then(()=>true,()=>false)) return false;
  }
  return true;
}

async function completedInstallRoots(base) {
  // Older helpers had no cache marker. npm's successful-install log is evidence that an
  // interrupted *build* already finished installing; never adopt a partial npm installation.
  const directory=path.join(base,'npm-cache','_logs');
  const names=await fs.readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  const roots=[];
  for (const name of names.filter(name=>name.endsWith('-debug-0.log')).sort().reverse().slice(0,20)) {
    const file=path.join(directory,name);
    if ((await fs.stat(file)).size>1<<20) continue;
    const text=await fs.readFile(file,'utf8');
    if (!/^\d+ verbose title npm (?:install|ci)(?:\s|$)/m.test(text) || !/^\d+ verbose exit 0\r?$/m.test(text) || !/^\d+ info ok\r?$/m.test(text)) continue;
    const cwd=text.match(/^\d+ verbose cwd (.+?)\r?$/m)?.[1];
    if (!cwd) continue;
    const relative=path.relative(path.join(base,'builds'),cwd);
    if (/^[a-f0-9-]{36}\/source$/.test(relative) && !roots.includes(cwd)) roots.push(cwd);
  }
  return roots;
}

export async function prepareDependencies(root,{base,env,run,log,previousRoot,completedRoots=[]}={}) {
  const input=await inputs(root);
  const locked=input.locks.some(text=>text!==null);
  const install=async()=>{
    log('$ npm '+(locked?'ci':'install')+' --ignore-scripts --include=dev --no-audit --no-fund --prefer-offline');
    const supported=registryOnly(input);
    const registry=supported ? await createInstallRegistry({lock:locked ? JSON.parse(input.locks.find(text=>text!==null)) : null,log,port:4181}) : null;
    try {
      if (registry) log('Using verified package downloads. Completed npm downloads are kept for retries in this tab.');
      await run('npm',[locked?'ci':'install','--ignore-scripts','--include=dev','--no-audit','--no-fund','--no-progress','--loglevel=info','--prefer-offline'],root,{...env,...(registry ? {
        npm_config_registry:registry.url,npm_config_replace_registry_host:'always',npm_config_maxsockets:'1',
        npm_config_fetch_timeout:'900000',npm_config_fetch_retries:'3',npm_config_fetch_retry_mintimeout:'1000',npm_config_fetch_retry_maxtimeout:'10000',
      } : {})});
      // A generated lock must not retain the short-lived relay's port.
      if (registry) for (let i=0;i<lockNames.length;i++) if (input.locks[i]===null) {
        const file=path.join(root,lockNames[i]),text=await optionalText(file);
        if (text!==null) await fs.writeFile(file,text.split(registry.url).join('https://registry.npmjs.org/'));
      }
    } finally {await registry?.close();}
  };
  if (!registryOnly(input)) {
    log('Local or linked dependencies need an install for this source snapshot.');
    await install(); return {cached:false,key:null};
  }
  const key=createHash('sha256').update(JSON.stringify({policy:'npm-installed-v1',node:process.version,arch:process.arch,platform:process.platform,manifest:input.manifest,locks:input.locks})).digest('hex');
  const store=path.join(base,'dependencies'),entry=path.join(store,key),modules=path.join(entry,'node_modules');
  const attach=async()=>{
    await fs.symlink(modules,path.join(root,'node_modules'));
    // Preserve the generated resolution for projects which did not share a lockfile.
    for (let i=0;i<lockNames.length;i++) if (input.locks[i]===null) {
      const text=await optionalText(path.join(entry,lockNames[i]));
      if (text!==null) await fs.writeFile(path.join(root,lockNames[i]),text);
    }
  };
  try {
    const ready=JSON.parse(await fs.readFile(path.join(entry,'ready.json'),'utf8'));
    if (ready.key===key && await completeModules(modules,input.pkg)) {
      await attach(); log('Reusing installed dependencies — skipping npm install.');
      return {cached:true,key};
    }
  } catch (error) {if (!['ENOENT','ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error;}

  await fs.mkdir(store,{recursive:true});
  const staging=entry+'.installing-'+randomUUID();
  await fs.mkdir(staging);
  // Adopt a completed deployment made by the original App Host. Updating the helper should
  // not force users to reinstall packages they already waited for.
  let source=root;
  for (const candidate of [previousRoot,...completedRoots].filter(Boolean)) {
    try {
      const previous=await inputs(candidate);
      if (input.manifest===previous.manifest && input.locks.every((text,i)=>text===null || text===previous.locks[i]) && registryOnly(previous) && await completeModules(path.join(candidate,'node_modules'),input.pkg)) {source=candidate;break;}
    } catch (error) {if (!['ENOENT','ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error;}
  }
  try {
    if (source===root) await install();
    else log('Keeping an earlier completed installation — skipping npm install.');
    await fs.mkdir(path.join(source,'node_modules'),{recursive:true});
    if (!await completeModules(path.join(source,'node_modules'),input.pkg)) throw Error('The installer did not produce a complete dependency directory.');
    await fs.rename(path.join(source,'node_modules'),path.join(staging,'node_modules'));
    for (const name of lockNames) {
      const text=await optionalText(path.join(source,name));
      if (text!==null) await fs.writeFile(path.join(staging,name),text);
    }
    await fs.writeFile(path.join(staging,'ready.json'),JSON.stringify({key}));
    await fs.rm(entry,{recursive:true,force:true});
    await fs.rename(staging,entry);
    if (source!==root) await fs.symlink(modules,path.join(source,'node_modules'));
    await attach();
    return {cached:source!==root,key};
  } finally {await fs.rm(staging,{recursive:true,force:true});}
}

export async function optimizeSvelteIcons(root,{log=console.log}={}) {
  // Rewrite only the disposable source snapshot. Parse real imports and use the installed
  // package's exports, so comments, strings, aliases, and the user's local files stay intact.
  const require=createRequire(path.join(root,'package.json'));
  let parse,parseJS,entry;
  try {
    entry=require.resolve('@lucide/svelte');
    ({parse}=require('svelte/compiler'));
    ({parse:parseJS}=createRequire(require.resolve('svelte/package.json'))('acorn'));
  } catch {return {files:0,imports:0};}
  const icons=new Map(),visited=new Set(),packageDir=path.dirname(entry);
  async function exportsFrom(file) {
    if (visited.has(file) || visited.size>=32 || !file.startsWith(packageDir+path.sep)) return;
    visited.add(file);
    const code=await fs.readFile(file,'utf8');
    for (const node of parseJS(code,{ecmaVersion:'latest',sourceType:'module'}).body) {
      const target=node.source?.value;
      if (typeof target!=='string' || !target.startsWith('./') && !target.startsWith('../')) continue;
      const resolved=path.resolve(path.dirname(file),target);
      if (node.type==='ExportAllDeclaration' && !node.exported) await exportsFrom(resolved);
      if (node.type!=='ExportNamedDeclaration' || path.dirname(resolved)!==path.join(packageDir,'icons')) continue;
      const name=path.basename(resolved).replace(/\.(?:svelte|js)$/,'');
      if (!/^[a-z0-9-]+$/.test(name)) continue;
      for (const spec of node.specifiers) if (spec.local?.name==='default') icons.set(spec.exported.name,'@lucide/svelte/icons/'+name);
    }
  }
  try {await exportsFrom(entry);} catch {
    log('Icon optimization is unavailable for this package layout; using the original imports.');
    return {files:0,imports:0};
  }
  let files=0,imports=0;
  const supported=new Map();
  const publicIcon=name=>{
    const target=icons.get(name);
    if (!target) return null;
    if (!supported.has(target)) {try {require.resolve(target);supported.set(target,true);} catch {supported.set(target,false);}}
    return supported.get(target) ? target : null;
  };
  async function visit(directory) {
    for (const item of await fs.readdir(directory,{withFileTypes:true})) {
      const file=path.join(directory,item.name);
      if (item.isDirectory() && !['node_modules','.git','dist','build'].includes(item.name)) {await visit(file);continue;}
      if (!item.isFile() || !item.name.endsWith('.svelte')) continue;
      const source=await fs.readFile(file,'utf8');
      if (!source.includes('@lucide/svelte')) continue;
      let ast;
      try {ast=parse(source,{modern:true});} catch {continue;} // Custom preprocessors still get the original source.
      const edits=[];
      for (const script of [ast.instance,ast.module]) for (const node of script?.content?.body || []) {
        if (node.type!=='ImportDeclaration' || node.source.value!=='@lucide/svelte' || node.importKind==='type' || !node.specifiers.length || node.specifiers.some(spec=>spec.type!=='ImportSpecifier') || node.attributes?.length) continue;
        const direct=[],remaining=[];
        for (const spec of node.specifiers) {
          const target=spec.importKind!=='type' && publicIcon(spec.imported.name);
          if (target) {direct.push('import '+spec.local.name+' from '+JSON.stringify(target)+';');imports++;}
          else remaining.push(source.slice(spec.start,spec.end));
        }
        if (!direct.length) continue;
        if (remaining.length) direct.push('import { '+remaining.join(', ')+' } from "@lucide/svelte";');
        // Keep subsequent line numbers stable for errors in the user's original source.
        edits.push({start:node.start,end:node.end,text:direct.join(' ')+'\n'.repeat((source.slice(node.start,node.end).match(/\n/g)||[]).length)});
      }
      if (!edits.length) continue;
      let updated=source;
      for (const edit of edits.sort((a,b)=>b.start-a.start)) updated=updated.slice(0,edit.start)+edit.text+updated.slice(edit.end);
      await fs.writeFile(file,updated);files++;
    }
  }
  await visit(root);
  if (imports) log('Optimized '+imports+' Svelte icon imports in '+files+' temporary source '+(files===1?'file':'files')+' — compiling only the requested icons.');
  return {files,imports};
}


export async function extractProject(archive, root) {
  const data = JSON.parse(gunzipSync(archive, {maxOutputLength:48 << 20}).toString('utf8'));
  if (data?.version !== 1 || !Array.isArray(data.files) || !data.files.length || data.files.length > limits.files) throw Error('Invalid source archive.');
  const seen = new Set(); let total = 0;
  await fs.mkdir(root, {recursive:false});
  for (const file of data.files) {
    sourcePath(file.path);
    if (seen.has(file.path) || typeof file.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) throw Error('Invalid source file.');
    seen.add(file.path);
    const bytes = Buffer.from(file.data,'base64'); total += bytes.length;
    if (bytes.length > limits.fileBytes || total > limits.bytes) throw Error('Source archive exceeds size limits.');
    const target = path.join(root, file.path);
    await fs.mkdir(path.dirname(target), {recursive:true});
    await fs.writeFile(target, bytes, {flag:'wx'});
  }
  return {files:seen.size, bytes:total};
}

function command(executable, args, cwd, env) {
  return new Promise((resolve,reject) => {
    const child = spawn(executable,args,{cwd,env,stdio:'inherit'});
    child.once('error',reject);
    child.once('close',(code,signal) => code === 0 ? resolve() : reject(Error(executable+' failed ('+(signal || 'exit '+code)+'). See the build log above.')));
  });
}

export async function buildProject(config, {base='/var/lib/snowglobe-apphost', run=command, log=console.log} = {}) {
  if (!/^[a-f0-9-]{36}$/.test(config.id)) throw Error('Invalid build id.');
  if (typeof config.prefix !== 'string' || !/^\/[a-zA-Z0-9/._-]+$/.test(config.prefix) || config.prefix.includes('..')) throw Error('Invalid preview base.');
  const settings = buildSettings(config.environment, config.script, config.output);
  const root = path.join(base,'builds',config.id,'source');
  await fs.mkdir(path.dirname(root), {recursive:true});
  let previous=null;
  try {previous=JSON.parse(await fs.readFile(path.join(base,'deployment.json'),'utf8'));}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  const completedRoots=settings.install ? await completedInstallRoots(base) : [];
  // Reclaim interrupted/failed snapshots after checking for a completed legacy install.
  // Keep the live app until the new one is published.
  const reclaim=async(keepCompleted=false)=>{
    for (const entry of await fs.readdir(path.join(base,'builds'))) {
      if (/^[a-f0-9-]{36}$/.test(entry) && entry !== previous?.id && entry !== config.id && !(keepCompleted && completedRoots.includes(path.join(base,'builds',entry,'source')))) await fs.rm(path.join(base,'builds',entry),{recursive:true,force:true});
    }
  };
  await reclaim(true);
  log('APPHOST_STAGE copy');
  await extractProject(await fs.readFile(config.archive), root);
  const env = {...process.env, CI:'true', NODE_ENV:'development', PUBLIC_URL:config.prefix, npm_config_cache:path.join(base,'npm-cache'), npm_config_registry:'http://127.0.0.1:4874/', npm_config_audit:'false', npm_config_fund:'false', npm_config_update_notifier:'false', npm_config_maxsockets:'4'};
  let dependencies=null;
  if (settings.install) {
    const pkg = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
    if (pkg.workspaces) throw Error('Workspace installs are not supported. Select a standalone app.');
    if (!Object.hasOwn(pkg.scripts || {},settings.script)) throw Error('package.json has no '+settings.script+' script.');
    if (pkg.packageManager && !pkg.packageManager.startsWith('npm@')) throw Error('This environment supports npm projects.');
    log('APPHOST_STAGE install');
    const previousRoot=!previous?.dependenciesManaged && /^[a-f0-9-]{36}$/.test(previous?.id || '') ? path.join(base,'builds',previous.id,'source') : null;
    dependencies=await prepareDependencies(root,{base,env,run,log,previousRoot,completedRoots});
    await reclaim();
    log('APPHOST_STAGE build');
    if (settings.base) await optimizeSvelteIcons(root,{log});
    const args = ['run',settings.script,...(settings.base ? ['--','--base='+config.prefix+'/'] : [])];
    log('$ npm '+args.join(' '));
    await run('npm',args,root,{...env,NODE_ENV:'production'});
  }
  else await reclaim();
  log('APPHOST_STAGE deploy');
  const output = path.resolve(root,relativePath(settings.output));
  const real = await fs.realpath(output);
  if (real !== root && !real.startsWith(root+path.sep)) throw Error('Build output must stay inside the shared app.');
  const index = await fs.lstat(path.join(real,'index.html'));
  if (!index.isFile() || index.isSymbolicLink() || !index.size) throw Error('The output folder needs a nonempty index.html.');
  // Publish only after a complete build. Failed installs/builds leave the previous app live.
  const deployment = {root:real, prefix:config.prefix, id:config.id, spa:settings.install, dependenciesManaged:settings.install, dependencyKey:dependencies?.key || null};
  await fs.writeFile(path.join(base,'deployment.next.json'), JSON.stringify(deployment));
  await fs.rename(path.join(base,'deployment.next.json'), path.join(base,'deployment.json'));
  if (/^[a-f0-9-]{36}$/.test(previous?.id || '') && previous.id !== config.id) await fs.rm(path.join(base,'builds',previous.id),{recursive:true,force:true}).catch(()=>{});
  log('APPHOST_DEPLOYED '+config.id);
  return deployment;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {await buildProject(JSON.parse(await fs.readFile(process.argv[2],'utf8')));}
  catch (error) {console.error(error.message); process.exitCode=1;}
}

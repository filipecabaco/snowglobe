import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {once} from 'node:events';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {environment,buildSettings,relativePath} from '../../site/apphost/environments.mjs';
import {detect,readFolder,archiveProject,sourcePath} from '../../site/apphost/project.mjs';
import {extractProject,buildProject,createInstallRegistry} from '../../site/apphost/guest.mjs';
import {createAppServer,rewritePaths} from '../../site/apphost/server.mjs';
import {AppHostVm} from '../../site/apphost/vm.mjs';

const archive = files => gzipSync(JSON.stringify({version:1,files:Object.entries(files).map(([path,text])=>({path,data:Buffer.from(text).toString('base64')}))}));
const temporary = async t => {const dir=await fs.mkdtemp(path.join(os.tmpdir(),'apphost-test-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;};
const folder = (name,files) => ({name,kind:'directory',async *entries(){for(const [key,value] of Object.entries(files)) yield [key,typeof value==='string'||value instanceof Uint8Array ? {kind:'file',getFile:async()=>new Blob([value])} : folder(key,value)];}});

test('detects static, React, Svelte, Vue, Vite, and CRA setups from source manifests',()=>{
  assert.equal(detect(['index.html'],null).id,'static');
  for(const [dep,id] of [['react','react'],['svelte','svelte'],['vue','vue']]) assert.equal(detect(['package.json'],{devDependencies:{vite:'1'},dependencies:{[dep]:'1'}}).id,id);
  assert.equal(detect([],{devDependencies:{vite:'1'}}).id,'vite');
  assert.equal(detect([],{dependencies:{'react-scripts':'1',react:'1'}}).id,'cra');
  for(const dep of ['next','@sveltejs/kit','nuxt']) assert.equal(detect(['index.html'],{dependencies:{vite:'1',[dep]:'1'}}).id,null);
  assert.equal(detect([],{packageManager:'pnpm@10'}).id,null);
  assert.equal(detect([],{workspaces:['apps/*']}).id,null);
  assert.equal(detect(['README.md'],null).id,null);
});

test('manual settings validate script names and keep output inside the source tree',()=>{
  assert.equal(buildSettings('react','build:app','public/site').output,'public/site');
  assert.equal(buildSettings('static','','.').install,false);
  for(const value of ['../x','/tmp','foo/../bar','foo\\bar','a//b','a/./b','a\n']) assert.throws(()=>relativePath(value));
  for(const value of ['build; echo bad','--help','$(id)','build\n']) assert.throws(()=>buildSettings('npm',value,'dist'));
  assert.throws(()=>environment('next'));
});

test('folder snapshots preserve binary assets and exclude generated and credential files',async t=>{
  const dir=await temporary(t), bytes=Uint8Array.of(0,255,1,0);
  const handle=folder('my-app',{'index.html':'<h1>Hello</h1>','image.png':bytes,'.env':'secret','.npmrc':'token',node_modules:{private:'no'},dist:{'index.html':'old'},src:{'app.js':'console.log(42)'}});
  const snapshot=await readFolder(handle);
  assert.deepEqual(snapshot.files.map(f=>f.path),['image.png','index.html','src/app.js']);
  assert.equal(snapshot.skipped,4);
  const packed=await archiveProject(snapshot);
  await extractProject(Buffer.from(await packed.arrayBuffer()),path.join(dir,'source'));
  assert.deepEqual(await fs.readFile(path.join(dir,'source/image.png')),Buffer.from(bytes));
  assert.equal(await fs.readFile(path.join(dir,'source/index.html'),'utf8'),'<h1>Hello</h1>');
  for(const path of ['.env','src/.env.local','.git/config','x/.aws/token','node_modules/x']) assert.throws(()=>sourcePath(path));
  await assert.rejects(readFolder(folder('bad',{'package.json':'{'})),/valid JSON/);
  await assert.rejects(readFolder(folder('empty',{'.git':{config:'private'}})),/no shareable files/);
});

test('archive extraction rejects traversal, duplicate paths, and collisions',async t=>{
  const dir=await temporary(t);
  await assert.rejects(extractProject(archive({'../outside':'bad'}),path.join(dir,'one')),/relative/);
  await assert.rejects(extractProject(archive({'src':'file','src/app.js':'nested'}),path.join(dir,'two')));
  const duplicate=gzipSync(JSON.stringify({version:1,files:[{path:'x',data:'eA=='},{path:'x',data:'eA=='}]}));
  await assert.rejects(extractProject(duplicate,path.join(dir,'three')),/Invalid source/);
  assert.equal(await fs.stat(path.join(dir,'outside')).then(()=>true,()=>false),false);
});

test('static builds publish atomically, and a failed build keeps the previous deployment',async t=>{
  const base=await temporary(t),input=path.join(base,'input.gz'),prefix='/apphost/preview/web/4180';
  await fs.writeFile(input,archive({'index.html':'<h1>Hello</h1>','app.js':'console.log(1)'}));
  const first={id:'00000000-0000-0000-0000-000000000001',prefix,archive:input,environment:'static',script:'',output:'.'};
  const result=await buildProject(first,{base,run:()=>{throw Error('Static should not install');},log:()=>{}});
  assert.equal(result.id,first.id);
  const published=await fs.readFile(path.join(base,'deployment.json'),'utf8');
  await fs.writeFile(input,archive({'README.md':'no output'}));
  await assert.rejects(buildProject({...first,id:'00000000-0000-0000-0000-000000000002'},{base,log:()=>{}}),/ENOENT/);
  assert.equal(await fs.readFile(path.join(base,'deployment.json'),'utf8'),published);
});

test('npm environments use lockfiles, install dev dependencies, and build for the preview base',async t=>{
  const base=await temporary(t),input=path.join(base,'input.gz'),prefix='/apphost/preview/web/4180';
  await fs.writeFile(input,archive({'package.json':JSON.stringify({scripts:{'build:web':'vite build'},devDependencies:{vite:'1'}}),'package-lock.json':'{}'}));
  const calls=[];
  const run=async(executable,args,root,env)=>{
    calls.push({executable,args,env});
    if(args[0]==='ci'){await fs.mkdir(path.join(root,'node_modules/vite'),{recursive:true});await fs.writeFile(path.join(root,'node_modules/vite/package.json'),'{}');}
    if(args[0]==='run'){await fs.mkdir(path.join(root,'dist'));await fs.writeFile(path.join(root,'dist/index.html'),'<h1>Built</h1>');}
  };
  await buildProject({id:'00000000-0000-0000-0000-000000000003',prefix,archive:input,environment:'svelte',script:'build:web',output:'dist'},{base,run,log:()=>{}});
  assert.deepEqual(calls[0].args,['ci','--ignore-scripts','--include=dev','--no-audit','--no-fund','--no-progress','--loglevel=info','--prefer-offline']);
  assert.deepEqual(calls[1].args,['run','build:web','--','--base='+prefix+'/']);
  assert.match(calls[0].env.npm_config_registry,/^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(calls[0].env.npm_config_replace_registry_host,'always');
  assert.equal(calls[0].env.npm_config_maxsockets,'1');
  assert.equal(calls[1].env.NODE_ENV,'production');
});

test('package relay retries reset connections and incomplete archives before exposing a successful response',async t=>{
  for (const locked of [true,false]) {
    const body=gzipSync('a complete package archive'),pathname='/ms/-/ms-2.1.3.tgz';
    const integrity='sha512-'+createHash('sha512').update(body).digest('base64');
    let requests=0;const logs=[],headers=[];
    const upstream=http.createServer((req,res)=>{
      requests++;headers.push(req.headers);
      if(requests===1){res.writeHead(200,{'Content-Length':body.length});res.write(body.subarray(0,4));setImmediate(()=>res.destroy());return;}
      const bytes=requests===2?body.subarray(0,-2):body;
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length});res.end(bytes);
    });
    upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
    t.after(()=>new Promise(resolve=>{upstream.closeAllConnections();upstream.close(resolve);}));
    const lock=locked?{packages:{'node_modules/ms':{resolved:'https://registry.npmjs.org'+pathname,integrity}}}:null;
    const registry=await createInstallRegistry({lock,log:line=>logs.push(line),upstream:'http://127.0.0.1:'+upstream.address().port});
    t.after(()=>registry.close());
    const accept='application/vnd.npm.install-v1+json';
    const response=await fetch(registry.url+pathname.slice(1),{headers:{Accept:accept,Authorization:'do-not-forward'}});
    assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),String(body.length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),body);
    assert.equal(requests,3);assert.equal(logs.length,2);
    assert.ok(headers.every(header=>header.accept===accept && header.authorization===undefined));
    assert.equal(registry.server.keepAliveTimeout,0);
    assert.equal((await fetch(registry.url+'ms',{method:'POST'})).status,405);
    assert.equal((await fetch(registry.url+'-/whoami')).status,400);
  }
});

test('package relay reports failed integrity checks without returning corrupt successful bodies',async t=>{
  const expected=gzipSync('expected package'),wrong=gzipSync('different package');
  let requests=0;
  const upstream=http.createServer((_req,res)=>{requests++;res.end(wrong);});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  t.after(()=>new Promise(resolve=>{upstream.closeAllConnections();upstream.close(resolve);}));
  const lock={packages:{'node_modules/ms':{resolved:'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',integrity:'sha512-'+createHash('sha512').update(expected).digest('base64')}}};
  const registry=await createInstallRegistry({lock,upstream:'http://127.0.0.1:'+upstream.address().port,attempts:2,log:()=>{}});
  t.after(()=>registry.close());
  const response=await fetch(registry.url+'ms/-/ms-2.1.3.tgz');
  assert.equal(response.status,502);assert.match(await response.text(),/integrity check/);assert.equal(requests,2);
});

test('job timeouts identify the failed phase and keep a bounded cold-install allowance',async()=>{
  for(const stage of ['install','build']) {
    const vm=new AppHostVm({});let request;
    vm.host={runCommand:async input=>{request=input;return {jobId:'test-job'};},readJob:async()=>({state:'timed_out',output:'APPHOST_STAGE '+stage+'\n'})};
    await assert.rejects(vm.run('build',{signal:new AbortController().signal}),stage==='install'?/installation timed out before compilation/:/build timed out/);
    assert.equal(request.timeoutSeconds,3600);assert.equal(vm.currentJob,null);
  }
});

test('the app server serves real assets, routes, HEAD, and private-path boundaries',async t=>{
  const base=await temporary(t),root=path.join(base,'site'),prefix='/apphost/preview/web/4180';
  await fs.mkdir(path.join(root,'nested'),{recursive:true});
  await fs.writeFile(path.join(root,'index.html'),'<link href="/style.css"><img src="'+prefix+'/image.png">');
  await fs.writeFile(path.join(root,'style.css'),'body{background:url(/image.png)}');
  await fs.writeFile(path.join(root,'image.png'),Buffer.from([0,255,1]));
  await fs.writeFile(path.join(root,'nested/index.html'),'<p>Nested</p>');
  await fs.writeFile(path.join(root,'.env'),'private');
  await fs.writeFile(path.join(root,'package.json'),'private');
  await fs.writeFile(path.join(base,'outside'),'private');
  await fs.symlink(path.join(base,'outside'),path.join(root,'escape'));
  await fs.writeFile(path.join(base,'deployment.json'),JSON.stringify({root,prefix,spa:true}));
  const server=createAppServer({base});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const url='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(url+'/__apphost_health')).status,200);
  const html=await (await fetch(url+'/')).text();
  assert.ok(html.includes('href="'+prefix+'/style.css"'));
  assert.ok(!html.includes(prefix+prefix));
  assert.equal(await (await fetch(url+'/style.css')).text(),'body{background:url('+prefix+'/image.png)}');
  assert.deepEqual(Buffer.from(await (await fetch(url+'/image.png')).arrayBuffer()),Buffer.from([0,255,1]));
  assert.equal((await fetch(url+'/image.png',{method:'HEAD'})).headers.get('content-length'),'3');
  assert.equal((await fetch(url+'/client/route')).status,200);
  assert.equal((await fetch(url+'/missing.js')).status,404);
  assert.equal((await fetch(url+'/nested',{redirect:'manual'})).headers.get('location'),'/nested/');
  for(const name of ['.env','package.json','node_modules/foo']) assert.equal((await fetch(url+'/'+name)).status,404);
  assert.equal((await fetch(url+'/escape')).status,403);
  assert.equal((await fetch(url+'/%E0%A4%A')).status,400);
  assert.equal((await fetch(url+'/',{method:'POST'})).status,405);
  assert.equal(rewritePaths('<a href="//example.com">',prefix),'<a href="//example.com">');
});

test('source-only rebuilds reuse installed modules, including after failed compilation',async t=>{
  const base=await temporary(t),input=path.join(base,'input.gz'),prefix='/apphost/preview/web/4180';
  const pkg=JSON.stringify({scripts:{build:'node build.cjs'},dependencies:{ms:'2.1.3'}});
  const lock=JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{ms:'2.1.3'}},'node_modules/ms':{version:'2.1.3'}}});
  let installs=0,builds=0; const logs=[];
  const run=async(_exe,args,root,env)=>{
    if(args[0]==='ci'||args[0]==='install') {
      installs++;
      await fs.mkdir(path.join(root,'node_modules/ms'),{recursive:true});
      await fs.writeFile(path.join(root,'node_modules/ms/package.json'),'{}');
      await fs.writeFile(path.join(root,'node_modules/ms/index.js'),'module.exports=2000;');
      if(args[0]==='install') {
        const generated=JSON.parse(lock);generated.packages['node_modules/ms'].resolved=env.npm_config_registry+'ms/-/ms-2.1.3.tgz';
        await fs.writeFile(path.join(root,'package-lock.json'),JSON.stringify(generated));
      }
    } else {
      builds++;
      const source=await fs.readFile(path.join(root,'build.cjs'),'utf8');
      assert.equal(await fs.readFile(path.join(root,'node_modules/ms/index.js'),'utf8'),'module.exports=2000;');
      if(source==='fail')throw Error('compilation failed');
      await fs.mkdir(path.join(root,'dist'));
      await fs.writeFile(path.join(root,'dist/index.html'),source);
    }
  };
  let number=20;
  async function build(source,{manifest=pkg,locked=lock}={}) {
    const files={'package.json':manifest,'build.cjs':source};if(locked!==null)files['package-lock.json']=locked;
    await fs.writeFile(input,archive(files));
    return buildProject({id:'00000000-0000-0000-0000-'+String(number++).padStart(12,'0'),prefix,archive:input,environment:'npm',script:'build',output:'dist'},{base,run,log:text=>logs.push(text)});
  }
  const first=await build('first');
  const second=await build('second');
  assert.equal(installs,1);assert.equal(builds,2);
  assert.equal(await fs.readFile(path.join(second.root,'index.html'),'utf8'),'second');
  assert.equal(await fs.stat(first.root).then(()=>true,()=>false),false,'old source snapshots can be deleted without deleting installed modules');
  await assert.rejects(build('fail'),/compilation failed/);
  await build('recovered');
  assert.equal(installs,1,'failed compilation does not invalidate a completed install');
  assert.ok(logs.some(line=>line.includes('Reusing installed dependencies')));
  await build('lock changed',{locked:lock+'\n'});assert.equal(installs,2);
  await build('manifest changed',{manifest:pkg+'\n'});assert.equal(installs,3);
  const unlocked=await build('lock removed',{locked:null});assert.equal(installs,4);
  const generated=JSON.parse(await fs.readFile(path.join(path.dirname(unlocked.root),'package-lock.json'),'utf8'));
  assert.equal(generated.packages['node_modules/ms'].resolved,'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz','generated locks must not retain the temporary relay address');
  await build('no-lock source edit',{locked:null});assert.equal(installs,4,'generated lockfiles do not make source-only rebuilds reinstall');
  await build('lock added');assert.equal(installs,4,'an earlier matching installation can be reused');
});

test('failed dependency installs are not cached, but successful installs survive failed builds',async t=>{
  const base=await temporary(t),input=path.join(base,'input.gz'),prefix='/apphost/preview/web/4180';
  await fs.writeFile(input,archive({'package.json':JSON.stringify({scripts:{build:'node build.cjs'},dependencies:{ms:'2.1.3'}}),'build.cjs':'unused'}));
  let installs=0,failInstall=true,failBuild=true;
  const run=async(_exe,args,root,env)=>{
    if(args[0]==='install'){
      installs++;
      const cachedDownload=path.join(env.npm_config_cache,'verified-download');
      if(installs===1){await fs.mkdir(env.npm_config_cache,{recursive:true});await fs.writeFile(cachedDownload,'complete tarball');}
      else assert.equal(await fs.readFile(cachedDownload,'utf8'),'complete tarball','an interrupted install must keep downloaded packages outside its source snapshot');
      await fs.mkdir(path.join(root,'node_modules/ms'),{recursive:true});
      await fs.writeFile(path.join(root,'node_modules/ms/package.json'),'{}');
      if(failInstall)throw Error('install interrupted');
    }else{
      if(failBuild)throw Error('compile failed');
      await fs.mkdir(path.join(root,'dist'));await fs.writeFile(path.join(root,'dist/index.html'),'ok');
    }
  };
  let number=40;
  const build=()=>buildProject({id:'00000000-0000-0000-0000-'+String(number++).padStart(12,'0'),prefix,archive:input,environment:'npm',script:'build',output:'dist'},{base,run,log:()=>{}});
  await assert.rejects(build(),/install interrupted/);
  failInstall=false;await assert.rejects(build(),/compile failed/);assert.equal(installs,2);
  failBuild=false;await build();assert.equal(installs,2);
});

test('already-deployed legacy projects keep their installed packages when upgrading App Host',async t=>{
  const base=await temporary(t),input=path.join(base,'input.gz'),prefix='/apphost/preview/web/4180';
  const id='00000000-0000-0000-0000-000000000050',oldRoot=path.join(base,'builds',id,'source');
  const pkg=JSON.stringify({scripts:{build:'node build.cjs'},dependencies:{ms:'2.1.3'}});
  await fs.mkdir(path.join(oldRoot,'node_modules/ms'),{recursive:true});
  await fs.writeFile(path.join(oldRoot,'node_modules/ms/package.json'),'{}');
  await fs.writeFile(path.join(oldRoot,'package.json'),pkg);
  await fs.writeFile(path.join(oldRoot,'package-lock.json'),'{}');
  await fs.writeFile(path.join(base,'deployment.json'),JSON.stringify({id,root:oldRoot,prefix,spa:true}));
  await fs.writeFile(input,archive({'package.json':pkg,'build.cjs':'updated'}));
  const run=async(_exe,args,root)=>{
    assert.equal(args[0],'run','migration must not invoke the package installer');
    await fs.access(path.join(root,'node_modules/ms/package.json'));
    await fs.mkdir(path.join(root,'dist'));await fs.writeFile(path.join(root,'dist/index.html'),'updated');
  };
  await buildProject({id:'00000000-0000-0000-0000-000000000051',prefix,archive:input,environment:'npm',script:'build',output:'dist'},{base,run,log:()=>{}});
});

test('legacy cancelled builds reuse only installations with npm success evidence',async t=>{
  for (const scenario of ['completed','interrupted','build-log','manifest-changed']) {
    const base=await temporary(t),input=path.join(base,'input.gz'),prefix='/apphost/preview/web/4180';
    const id='00000000-0000-0000-0000-000000000060',oldRoot=path.join(base,'builds',id,'source');
    const pkg=JSON.stringify({scripts:{build:'node build.cjs'},dependencies:{ms:'2.1.3'}});
    await fs.mkdir(path.join(oldRoot,'node_modules/ms'),{recursive:true});
    await fs.writeFile(path.join(oldRoot,'node_modules/ms/package.json'),'{}');
    await fs.writeFile(path.join(oldRoot,'package.json'),pkg+(scenario==='manifest-changed'?'\n':''));
    await fs.writeFile(path.join(oldRoot,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'node_modules/ms':{version:'2.1.3',resolved:'http://127.0.0.1:4874/ms/-/ms-2.1.3.tgz'}}}));
    await fs.mkdir(path.join(base,'npm-cache/_logs'),{recursive:true});
    await fs.writeFile(path.join(base,'npm-cache/_logs/2026-11-11-debug-0.log'),
      '6 verbose title npm '+(scenario==='build-log'?'run build':'install')+'\n'+
      '20 verbose cwd '+oldRoot+'\n'+(scenario==='interrupted'?'':'21 verbose exit 0\n22 info ok\n'));
    await fs.writeFile(input,archive({'package.json':pkg,'build.cjs':'updated'}));
    let installs=0;
    const run=async(_exe,args,root)=>{
      if(args[0]==='install'){
        installs++;await fs.mkdir(path.join(root,'node_modules/ms'),{recursive:true});
        await fs.writeFile(path.join(root,'node_modules/ms/package.json'),'{}');return;
      }
      await fs.access(path.join(root,'node_modules/ms/package.json'));
      await fs.mkdir(path.join(root,'dist'));await fs.writeFile(path.join(root,'dist/index.html'),'updated');
    };
    await buildProject({id:'00000000-0000-0000-0000-000000000061',prefix,archive:input,environment:'npm',script:'build',output:'dist'},{base,run,log:()=>{}});
    assert.equal(installs,scenario==='completed'?0:1,scenario);
    assert.equal(await fs.stat(oldRoot).then(()=>true,()=>false),false,'stale sources are reclaimed after adopting their packages');
  }
});

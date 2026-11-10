// Real FileSystemDirectoryHandles (OPFS), writable streams, IndexedDB handles,
// checksummed VM blobs and Builder UI. The native chooser is injected; no
// provider requests or guest VM boot are used by this storage regression.
import {chromium} from '../../../bench/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {build} from 'esbuild';import {openFixture} from './browser-fixture.mjs';
const bundle=await build({stdin:{contents:"export * from './src/folder-workspace.js';export * from './src/storage-context.js';export * from './src/projects.js';export * from './src/checkpoint.js';export * from './src/history.js';export * from './src/vm-backup.js';",resolveDir:new URL('../',import.meta.url).pathname},bundle:true,write:false,format:'esm',platform:'browser'});
const sessions=await fs.readFile(new URL('../../../internal/site/sessions.js',import.meta.url),'utf8');
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext(),page=await context.newPage();page.on('console',m=>console.log(m.text()));await openFixture(page);await page.addScriptTag({content:sessions});
 const result=await page.evaluate(async source=>{
  const m=await import(URL.createObjectURL(new Blob([source],{type:'text/javascript'}))),root=await(await navigator.storage.getDirectory()).getDirectoryHandle('projects',{create:true});
  const w=await new m.FolderWorkspace(root,SnowglobeSessions).open();await w.lock();m.useFolderWorkspace(w);await m.workspaceHandle(root);
  const a=crypto.randomUUID(),b=crypto.randomUUID(),project=id=>({id,name:id===a?'First':'Second',template:'react-vite',backend:'supabase'}),config={build:'image-1',memory:128,cpus:1,network:'none'};
  const cp=(runtime,savedAt)=>({version:1,id:'machine',name:runtime,config,savedAt,encoding:'raw',state:new Blob([runtime+'-'+savedAt]),console:new Blob([])});
  await m.projectStore('put',project(a));await m.projectStore('put',project(b));
  const record={savedAt:100,files:{'src/App.jsx':'first','public/icon.bin':{encoding:'base64',data:'AP8='}},messages:[{role:'user',content:'a conversation'}],previewData:{count:4},metadata:{snapshotSavedAt:100,buildId:'image-1',backendSavedAt:101,backendBuild:'image-1',backendConfig:{}}};
  for(const [runtime,time]of [['web',100],['supabase',101]])await w.runtimeStore(a,runtime).put(cp(runtime,time));
  await m.checkpointStore('readwrite',record,a);await m.historyStore(a,{label:'initial',files:record.files});record.messages.push({role:'assistant',content:'later turn'});const historyCopy=await m.historyStore(a);historyCopy.reverse();historyCopy.push({label:'must not persist'});await m.checkpointStore('readwrite',{savedAt:200,files:{'index.html':'second'}},b);
  await m.projectStore('put',{...project(a),name:'Renamed'});
  const dir=await root.getDirectoryHandle('project-'+a),src=await dir.getDirectoryHandle('src');const disk=await(await(await src.getFileHandle('App.jsx')).getFile()).text();const visibleName=JSON.parse(await(await(await dir.getFileHandle('snowglobe-project.json')).getFile()).text()).name;const bytes=Array.from(new Uint8Array(await(await(await(await dir.getDirectoryHandle('public')).getFileHandle('icon.bin')).getFile()).arrayBuffer()));
  // Half a paired save must never replace the complete published pair.
  await m.checkpointStore('readwrite',{...record,metadata:undefined,savedAt:300,files:{...record.files,'src/App.jsx':'new source'}},a);await w.runtimeStore(a,'web').put(cp('web',300));
  const bad=structuredClone(record);bad.metadata.snapshotSavedAt=300;bad.metadata.backendSavedAt=301;
  let pairError=false;try{await m.checkpointStore('readwrite',bad,a);}catch(e){pairError=/pair/.test(e.message);}
  const reopened=await new m.FolderWorkspace(await m.workspaceHandle(),SnowglobeSessions).open();
  const web=await reopened.runtimeStore(a,'web').get(),db=await reopened.runtimeStore(a,'supabase').get();
  // Read user edits on reopening, then refuse to overwrite subsequent edits.
  let stream=await(await src.getFileHandle('App.jsx')).createWritable();await stream.write('external edit');await stream.close();
  const external=await new m.FolderWorkspace(root,SnowglobeSessions).open();const recovered=await external.checkpoint('readonly',undefined,a);
  stream=await(await src.getFileHandle('App.jsx')).createWritable();await stream.write('later external edit');await stream.close();let conflict=false;try{await external.checkpoint('readwrite',record,a);}catch(e){conflict=/changed outside/.test(e.message);}
  const preserved=await(await(await src.getFileHandle('App.jsx')).getFile()).text();
  // Inject a failed metadata publication; a new instance still sees the prior pair.
  const p=await reopened.project(a),original=p.meta.getFileHandle.bind(p.meta);p.meta.getFileHandle=async(name,opts)=>{if(opts?.create&&name.startsWith('state.'))throw new DOMException('Injected full disk','QuotaExceededError');return original(name,opts);};
  let failure=false;try{await reopened.projects('put',{...project(a),name:'Must not commit'});}catch(e){failure=e.name==='QuotaExceededError';}p.meta.getFileHandle=original;
  const after=await new m.FolderWorkspace(root,SnowglobeSessions).open();
  let incompatible=false;try{await after.runtimeStore(a,'web',{...config,build:'other'}).list();}catch(e){incompatible=/different build/.test(e.message);}
  const lockPeer=await new m.FolderWorkspace(root,SnowglobeSessions).open();let locked=false;try{await lockPeer.lock();}catch{locked=true;}
  const names=(await after.projects('list')).map(p=>p.name).sort(),history=await after.history(a);
  const webText=await web.state.text(),dbText=await db.state.text();const bEntry=await after.project(b),backupText=await(await(await bEntry.meta.getFileHandle('state.'+bEntry.slot+'.json')).getFile()).text();
  let broken=await(await bEntry.meta.getFileHandle('state.'+bEntry.slot+'.json')).createWritable();await broken.write('truncated');await broken.close();
  const fallback=await new m.FolderWorkspace(root,SnowglobeSessions).open();const corruptionFallback=(await fallback.checkpoint('readonly',undefined,b)).files['index.html']==='second';
  const otherSlot=bEntry.slot==='a'?'b':'a',otherText=await(await(await bEntry.meta.getFileHandle('state.'+otherSlot+'.json')).getFile()).text();broken=await(await bEntry.meta.getFileHandle('state.'+otherSlot+'.json')).createWritable();await broken.write('truncated');await broken.close();let corruptionError=false;try{await new m.FolderWorkspace(root,SnowglobeSessions).project(b);}catch{corruptionError=true;}
  for(const [slot,text]of [[bEntry.slot,backupText],[otherSlot,otherText]]){const stream=await(await bEntry.meta.getFileHandle('state.'+slot+'.json')).createWritable();await stream.write(text);await stream.close();}
  const imported=await m.importVmBackupSet(m.vmBackupManifest({name:'Backup',template:'react-vite'},{snapshotSavedAt:300,buildId:'image-1'}),{web:await SnowglobeSessions.encodeBackup(cp('web',300))},{web:config},SnowglobeSessions,{approve:async()=>true});
  const importedBytes=await(await w.runtimeStore(imported,'web').get()).state.text();await w.projects('delete',{id:imported});
  const retained=await after.checkpoint('readonly',undefined,b);await after.projects('delete',{id:a});
  m.useFolderWorkspace(null);await w.close();
  return {names,corruptionFallback,corruptionError,importedBytes,history:history.length,visibleName,bytes,source:disk,pairError,web:webText,db:dbText,external:recovered.files['src/App.jsx'],metadataCleared:!recovered.metadata,conflict,preserved,failure,incompatible,locked,other:retained.files['index.html'],remaining:(await after.projects('list')).length};
 },bundle.outputFiles[0].text);
 assert.deepEqual(result,{names:['Renamed','Second'],corruptionFallback:true,corruptionError:true,importedBytes:'web-300',history:1,visibleName:'Renamed',bytes:[0,255],source:'first',pairError:true,web:'web-100',db:'supabase-101',external:'external edit',metadataCleared:true,conflict:true,preserved:'later external edit',failure:true,incompatible:true,locked:true,other:'second',remaining:1});
 console.log('PASS real directory handles: per-project source/history, binary files, stored root handle, interrupted pair, write failure, external edits, build mismatch, locking and deletion isolation');
 await context.close();
 // Exercise the actual built UI with browser storage and native file APIs.
 const uiContext=await browser.newContext();await uiContext.addInitScript(()=>{window.showDirectoryPicker=async()=>{const root=await navigator.storage.getDirectory();return root.getDirectoryHandle('SnowGlobe Builder',{create:true});};});
 const ui=await uiContext.newPage(),errors=[];ui.on('pageerror',e=>errors.push(e.message));
 const app=await fs.readFile(new URL('../../../site/builder/app.js',import.meta.url),'utf8');
 await uiContext.route('https://builder.test/**',async route=>{
  const pathname=new URL(route.request().url()).pathname;
  if(pathname.startsWith('/builder-api/'))return route.fulfill({status:503,contentType:'application/json',body:'{"error":"No provider in storage test"}'});
  let file=pathname==='/builder/'?'site/builder/index.html':pathname.startsWith('/builder/')?'site'+pathname:pathname==='/agent/runtimes.json'?'dist/agent/runtimes.json':null;
  if(!file)return route.fulfill({status:404,body:'Not found'});
  const body=file==='site/builder/app.js'?app+'\nwindow.folderTest=()=>({currentProject,folderWorkspace,projectStore,checkpointStore,historyStore,api,busy});':await fs.readFile(path.resolve(new URL('../../../',import.meta.url).pathname,file));
  await route.fulfill({headers:{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.json')?'application/json':file.endsWith('.css')?'text/css':'text/html','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'},body});
 });
 const ready=()=>ui.waitForFunction(()=>window.folderTest?.().currentProject&&!folderTest().busy&&!document.getElementById('builder-folder-status').textContent.startsWith('Connecting'));
 await ui.goto('https://builder.test/builder/');await ready();await ui.locator('.project details').evaluate(e=>e.open=true);await ui.locator('#builder-folder').click();await ui.waitForFunction(()=>window.folderTest?.().folderWorkspace());await ready();
 assert.match(await ui.locator('#builder-folder-status').textContent(),/Builder folder: SnowGlobe Builder/);
 await ui.locator('.project details').evaluate(e=>e.open=true);await ui.locator('#project-new-name').fill('Second folder project');await ui.locator('#project-new').click();await ui.waitForURL(/project=/);await ready();
 const second=await ui.evaluate(()=>folderTest().currentProject.id);assert.equal(await ui.locator('#project-name').textContent(),'Second folder project');
 await ui.locator('.project details').evaluate(e=>e.open=true);await ui.locator('#project-open').selectOption('local-builder');await ui.waitForURL(url=>!url.search);await ready();assert.equal(await ui.locator('#project-name').textContent(),'My first app');
 await ui.locator('.project details').evaluate(e=>e.open=true);await ui.locator('#project-open').selectOption(second);await ui.waitForURL(/project=/);await ready();assert.equal(await ui.locator('#project-name').textContent(),'Second folder project');
 // Rebuild browser bookkeeping from the selected folder after clearing IDB.
 await ui.evaluate(async()=>{for(const name of ['snowglobe-builder-projects','snowglobe-builder-recovery','snowglobe-builder-history'])await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=resolve;r.onerror=()=>reject(r.error);});localStorage.clear();});
 await ui.reload();await ready();assert.equal(await ui.locator('#project-name').textContent(),'Second folder project');assert.equal(await ui.locator('#project-open option').count(),2);
 // Losing permission blocks work; reconnect is a deliberate click, no fallback.
 await uiContext.addInitScript(()=>{const original=FileSystemDirectoryHandle.prototype.queryPermission;FileSystemDirectoryHandle.prototype.queryPermission=function(options){if(this.name==='SnowGlobe Builder'&&!sessionStorage.getItem('folder-granted'))return Promise.resolve('prompt');return original.call(this,options);};FileSystemDirectoryHandle.prototype.requestPermission=async()=>{sessionStorage.setItem('folder-granted','yes');return 'granted';};});
 await ui.reload();await ui.waitForFunction(()=>document.getElementById('builder-folder-status').textContent.startsWith('Folder unavailable:'));assert(await ui.locator('#project-new').isDisabled());
 await ui.locator('.project details').evaluate(e=>e.open=true);await ui.locator('#builder-folder').click();await ready();assert.equal(await ui.locator('#project-name').textContent(),'Second folder project');
 assert.deepEqual(errors,[]);console.log('PASS actual Builder UI: choose one folder, create project, switch both ways, reload without browser project records, permission failure and reconnect');await uiContext.close();
}finally{await browser.close();}

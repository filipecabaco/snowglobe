// Real Builder UI, orchestrator slots and IndexedDB; no VM boot is necessary.
import {chromium,webkit} from '../../../bench/node_modules/playwright/index.mjs';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const engine=process.env.BUILDER_BROWSER==='webkit'?webkit:chromium;
const browser=await engine.launch({headless:true,...(engine===chromium?{args:['--no-sandbox']}:{...(process.env.BUILDER_WEBKIT_BIN?{executablePath:process.env.BUILDER_WEBKIT_BIN}:{})})});try{
 const page=await browser.newPage(),script=await fs.readFile(new URL('../../../site/builder/app.js',import.meta.url),'utf8');await page.route('**/builder/app.js',route=>route.fulfill({contentType:'text/javascript',body:script+'\nwindow.deletionTest=()=>({api,backend,preview,projectStore,checkpointStore,historyStore,projectScope,currentProject,busy});'}));const base=process.env.BUILDER_URL||'https://aspire.tailb03e.ts.net:18445/builder/';await page.goto(base);await page.waitForFunction(()=>window.deletionTest?.().currentProject&&!deletionTest().busy);
 const ids=await page.evaluate(async()=>{const p=deletionTest(),ids=[crypto.randomUUID(),crypto.randomUUID()];for(const id of ids){await p.projectStore('put',{id,name:id===ids[0]?'Delete me':'Keep me',template:'react-vite',backend:'off'});for(const runtime of ['web','supabase']){const store=await SnowglobeSessions.BrowserStore.open(p.projectScope(id,runtime));await store.put({version:1,id:'machine',name:runtime,config:p.api._get(runtime).slot.config,savedAt:100,encoding:'raw',state:new Blob(['fixture snapshot']),console:new Blob([])});store.db.close();}await p.checkpointStore('readwrite',{savedAt:100,files:{'app.js':'source'}},id);await p.historyStore(id,{label:'original',files:{'app.js':'source'}});}return ids;});
 await page.goto(base+'?project='+ids[0]);await page.waitForFunction(()=>window.deletionTest?.().currentProject&&!deletionTest().busy);
 await page.evaluate(async()=>{
  const p=deletionTest();await p.preview('<h1>Recipe app</h1>');
  // This is the same persistent busy pin openPreview sets for Supabase, without booting a VM.
  p.api._get('supabase').previews.set(54322,'open');
  let finish;const request=new Promise(resolve=>finish=resolve);p.backend.active.add(request);
  const frame=document.querySelector('#preview iframe'),dispose=frame._disposePreview;
  frame._disposePreview=()=>{window.deletionPreviewDisposed=true;dispose();p.backend.active.delete(request);finish();};
 });
 await page.evaluate(()=>document.querySelector('.project details').open=true);await page.locator('#project-delete').click();await page.locator('#approval [data-deny]').click();await page.waitForFunction(()=>!deletionTest().busy);assert(await page.evaluate(id=>deletionTest().projectStore('list').then(list=>list.some(p=>p.id===id)),ids[0]));
 assert.equal(await page.evaluate(()=>!!window.deletionPreviewDisposed),false);assert.equal(await page.evaluate(()=>deletionTest().api._get('supabase').previews.size),1);
 // An unrelated operation must block deletion before either checkpoint is removed.
 await page.evaluate(()=>deletionTest().api._get('supabase').starting++);
 await page.locator('#project-delete').click();await page.locator('#approval [data-approve]').click();await page.waitForFunction(()=>!deletionTest().busy&&document.getElementById('status').textContent.includes('saved project data is unchanged'));
 assert.equal(await page.evaluate(()=>window.deletionPreviewDisposed),true);assert.equal(await page.evaluate(()=>deletionTest().backend.active.size),0);assert.equal(await page.evaluate(()=>deletionTest().api._get('supabase').previews.size),0);
 assert.deepEqual(await page.evaluate(()=>['web','supabase'].map(runtime=>!!deletionTest().api._get(runtime).slot.saved)),[true,true]);
 // Reproduce a partially completed deletion (source cleared, database fails), then retry it.
 await page.evaluate(()=>{const p=deletionTest();p.api._get('supabase').starting--;window.originalDeletionFresh=p.api.startFresh;p.api.startFresh=runtime=>{if(runtime==='supabase')throw Error('Fixture database storage failure');return originalDeletionFresh(runtime);};});
 await page.locator('#project-delete').click();await page.locator('#approval [data-approve]').click();await page.waitForFunction(()=>!deletionTest().busy&&document.getElementById('status').textContent.includes('some project data may already have been removed'));
 assert.deepEqual(await page.evaluate(()=>['web','supabase'].map(runtime=>!!deletionTest().api._get(runtime).slot.saved)),[false,true]);
 assert(await page.evaluate(id=>deletionTest().checkpointStore('readonly',undefined,id).then(Boolean),ids[0]));assert(await page.evaluate(id=>deletionTest().projectStore('list').then(list=>list.some(p=>p.id===id)),ids[0]));
 await page.evaluate(()=>{deletionTest().api.startFresh=originalDeletionFresh;deletionTest().api._get('supabase').previews.set(54322,'open');});
 await page.locator('#project-delete').click();await page.locator('#approval [data-approve]').click();await page.waitForURL(url=>!url.search);await page.waitForFunction(()=>window.deletionTest?.().currentProject&&!deletionTest().busy);
 const results=await page.evaluate(async ids=>{const p=deletionTest(),out=[];for(const id of ids){const saved=[];for(const runtime of ['web','supabase']){const store=await SnowglobeSessions.BrowserStore.open(p.projectScope(id,runtime));saved.push(!!await store.get('machine'));store.db.close();}out.push({project:(await p.projectStore('list')).some(project=>project.id===id),saved,recovery:!!await p.checkpointStore('readonly',undefined,id),history:(await p.historyStore(id)).length});}return out;},ids);
 assert.deepEqual(results,[{project:false,saved:[false,false],recovery:false,history:0},{project:true,saved:[true,true],recovery:true,history:1}]);console.log('PASS '+(engine===webkit?'WebKit':'Chromium')+' project deletion denial, preview/request cleanup, busy preflight preserves both checkpoints, partial deletion retry, and isolation from another project');
}finally{await browser.close();}

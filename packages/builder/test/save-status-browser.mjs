// Actual task/build/persistence UI and real IndexedDB; VM operations are a
// protocol fixture so this check needs neither an image boot nor AI credentials.
import {chromium} from '../../../bench/node_modules/playwright/index.mjs';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import {runtimeCatalog} from './runtime-catalog-fixture.mjs';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});try{
 const page=await browser.newPage();await page.route('https://builder.test/**',async route=>{
  const pathname=new URL(route.request().url()).pathname;if(pathname.startsWith('/builder-api/'))return route.fulfill({status:503,contentType:'application/json',body:'{"error":"No provider in fixture"}'});
  if(pathname==='/agent/runtimes.json')return route.fulfill({json:runtimeCatalog});
  const file=pathname==='/builder/'?'site/builder/index.html':pathname.startsWith('/builder/')?'site'+pathname:null;if(!file)return route.fulfill({status:404,body:'Not found'});let body=await fs.readFile(new URL('../../../'+file,import.meta.url));
  if(file.endsWith('/app.js'))body=body.toString()+`\nwindow.saveStatusFixture=()=>{
   projectPrepared=true;activeFramework=templateFor(catalog,'react-vite');api.wake=async()=>true;
   backend.enabled=true;backend.config={url:'https://supabase.builder.invalid',anonKey:'header.'+btoa(JSON.stringify({role:'anon'}))+'.signature'};backend.freeze=async()=>{};backend.resume=()=>{};
   backend.http=async request=>({status:request.method==='POST'?201:200,headers:[['content-type','application/json']],body:'[]'});
   client.call=async op=>{if(op==='project.export')return {files:{'src/App.jsx':'fixture source'}};if(op==='preview.build')return {html:'<!doctype html><html><body><h1>Save status fixture</h1></body></html>',starter:false};return {};};
   let saves=0;api.suspend=async runtime=>{const m=api._get(runtime);m.inMemory=null;m.dirty=false;m.slot.saved={savedAt:Date.now()};saves++;return true;};
   return {edit:()=>task(async()=>{revision++;builds=0;await build();}),saves:()=>saves};
  };`;
  return route.fulfill({headers:{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.json')?'application/json':file.endsWith('.css')?'text/css':'text/html','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'},body});
 });
 await page.goto('https://builder.test/builder/');await page.waitForFunction(()=>window.saveStatusFixture&&document.getElementById('stop').disabled);
 await page.evaluate(async()=>{window.saving=saveStatusFixture();await saving.edit();});
 assert.equal(await page.locator('#status').textContent(),'Preview ready · source saved automatically');assert.match(await page.locator('#recovery-status').textContent(),/Source saved automatically/);assert(await page.locator('#save-reminder').isVisible());assert.match(await page.locator('#save-reminder-message').textContent(),/database records, accounts and app state/);assert(!await page.locator('aside').textContent().then(s=>s.includes('changes are not saved')));
 await page.locator('#save-reminder-action').click();await page.waitForFunction(()=>document.getElementById('stop').disabled&&document.getElementById('save-reminder').hidden);assert.equal(await page.evaluate(()=>saving.saves()),2);assert.equal(await page.locator('#status').textContent(),'Source and Supabase checkpoints saved in this browser');
 const frame=page.frames().find(f=>f.parentFrame());await frame.evaluate(()=>fetch(SNOWGLOBE_SUPABASE.url+'/rest/v1/todos'));assert(await page.locator('#save-reminder').isHidden());
 await frame.evaluate(()=>fetch(SNOWGLOBE_SUPABASE.url+'/rest/v1/todos',{method:'POST',body:'{}'}));await page.locator('#save-reminder').waitFor({state:'visible'});
 await page.locator('#save-reminder-action').click();await page.waitForFunction(()=>document.getElementById('stop').disabled&&document.getElementById('save-reminder').hidden);
 await frame.evaluate(()=>localStorage.setItem('counter','1'));await page.locator('#save-reminder').waitFor({state:'visible'});
 console.log('PASS source autosave is explicit, contextual Save project action saves both VMs and clears the reminder; later database/storage changes bring it back, reads do not');
}finally{await browser.close();}

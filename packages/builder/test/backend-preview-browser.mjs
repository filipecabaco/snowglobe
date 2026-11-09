import {openFixture} from './browser-fixture.mjs';
// Browser bridge/isolation coverage with deterministic API responses; real backend coverage
// lives in supabase-browser.mjs. These tests never issue real login or database operations.
import {chromium,webkit,devices} from '../../../bench/node_modules/playwright/index.mjs';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
for(const [name,type,options] of [['Chromium',chromium,{args:['--no-sandbox']}],['WebKit',webkit,{...(process.env.BUILDER_WEBKIT_BIN?{executablePath:process.env.BUILDER_WEBKIT_BIN}:{})}]]){
 const browser=await type.launch({headless:true,...options});try{
  const page=await browser.newPage({...devices['iPhone 13']});const source=await fs.readFile(new URL('../src/preview.js',import.meta.url),'utf8');let gatewayRequests=0;
  await page.route('**/builder-api/status',r=>{gatewayRequests++;return r.fulfill({contentType:'application/json',body:'{"development":true,"codexSession":false}'});});
  await openFixture(page);await page.evaluate(()=>{const preview=document.createElement('div');preview.id='preview';document.body.append(preview);});
  await page.evaluate(async source=>{const {mountPreview}=await import(URL.createObjectURL(new Blob([source],{type:'text/javascript'})));window.apiRequests=[];window.backendAborted=false;localStorage.setItem('gateway-private-canary','private');await mountPreview({container:document.getElementById('preview'),backend:{url:'https://supabase.builder.invalid',anonKey:'fixture-anon'},html:`<div id="root"><button id="load">Load records</button><p id="result"></p></div><script>document.getElementById('load').onclick=async()=>{const r=await fetch(SNOWGLOBE_SUPABASE.url+'/rest/v1/dice_rolls',{headers:{apikey:SNOWGLOBE_SUPABASE.anonKey}});document.getElementById('result').textContent=(await r.json())[0].value;};<\/script>`,onBackendRequest:async(request,signal)=>{apiRequests.push(request);if(request.url.endsWith('/auth/v1/token'))return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{window.backendAborted=true;reject(new Error('Cancelled'));},{once:true}));return {status:200,headers:[['content-type','application/json']],body:new TextEncoder().encode('[{"value":4}]')};}});},source);
  const frame=page.frameLocator('#preview iframe');await frame.getByRole('button',{name:'Load records'}).click();await frame.getByText('4',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>apiRequests.length),1);assert.equal(await page.evaluate(()=>apiRequests[0].url),'https://supabase.builder.invalid/rest/v1/dice_rolls');
  const child=page.frames().find(f=>f!==page.mainFrame());const before=gatewayRequests;
  const isolation=await child.evaluate(async()=>{let parentDenied=false,networkDenied=false;try{void parent.document;}catch{parentDenied=true;}try{await fetch('/builder-api/status',{method:'POST'});}catch{networkDenied=true;}return {parentDenied,networkDenied,privateStorage:localStorage.getItem('gateway-private-canary')};});
  assert.deepEqual(isolation,{parentDenied:true,networkDenied:true,privateStorage:null});assert.equal(gatewayRequests,before);
  await child.evaluate(async()=>{const controller=new AbortController();const promise=fetch(SNOWGLOBE_SUPABASE.url+'/auth/v1/token',{method:'POST',body:'{}',signal:controller.signal}).catch(e=>e.name);setTimeout(()=>controller.abort(),100);window.cancelResult=await promise;});
  await page.waitForFunction(()=>window.backendAborted);assert.equal(await child.evaluate(()=>window.cancelResult),'AbortError');
  console.log('PASS',name,'iPhone opaque Supabase bridge: JSON response, cancellation, parent/storage/gateway/network isolation');
 }finally{await browser.close();}
}

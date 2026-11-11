// Actual download faults and actual guest/checkpoint recovery. No AI/session mocks.
import {chromium} from '../../../bench/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const url=process.env.BUILDER_URL||'https://aspire.tailb03e.ts.net:18445/builder/';
const busybox='**/blobs/97d52efa14.bin.zst';
const warm='**/web/system/warm.pack';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
async function pageForTest(){
 const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(180000);
 await page.addInitScript(()=>{let value;Object.defineProperty(window,'SnowglobeOrchestrator',{configurable:true,get:()=>value,set:next=>{value=next;const create=next.createAgents;next.createAgents=(...args)=>(window.testVmApi=create(...args));}});});
 page.on('pageerror',e=>console.log('PAGEERROR',e.message));
 return {context,page};
}
async function finishTask(page){
 const timer=setInterval(async()=>{try{console.log('STATUS',await page.locator('#status').textContent());}catch{}},15000);
 try{await page.waitForFunction(()=>document.getElementById('stop').disabled,null,{timeout:360000});}finally{clearInterval(timer);}
 console.log('RESULT',await page.locator('#status').textContent());
 assert(!await page.locator('#work-progress').evaluate(el=>el.classList.contains('failed')),await page.locator('#status').textContent());
}
try{
 {
  const {context,page}=await pageForTest();let attempts=0;
  await page.route(warm,r=>r.abort('failed'));
  await page.route(busybox,r=>++attempts<=3?r.abort('failed'):r.continue());
  await page.goto(url);await page.waitForFunction(()=>window.testVmApi);
  await page.getByRole('button',{name:'Try a counter'}).click();await page.waitForFunction(()=>!document.getElementById('stop').disabled);
  await finishTask(page);assert.equal(attempts,4,'three failed fetches followed by in-place bootstrap recovery');
  assert.match(await page.locator('#progress-steps').textContent(),/Restoring environment files/);
  await page.frameLocator('#preview iframe').getByRole('button',{name:'Count: 0'}).click();await page.frameLocator('#preview iframe').getByRole('button',{name:'Count: 1'}).waitFor();
  console.log('PASS real step-0 status-126 failure repairs automatically and produces an interactive counter');
  await context.close();
 }
 {
  const {context,page}=await pageForTest();let phase='poison',warmAttempts=0,restoredBusyboxAttempts=0,resolveWarmFailures;
  const warmFailures=new Promise(resolve=>resolveWarmFailures=resolve);
  const source='export default function App(){return <h1>Checkpoint source preserved</h1>}';
  const agent=await fs.readFile(new URL('../../../site/builder/agent.js',import.meta.url),'utf8');
  // An ordinary shell builtin writes source before the failed download. This leaves actual
  // edited guest source in the damaged checkpoint, without needing a working external mkdir.
  await page.route('**/builder/agent.js',r=>r.fulfill({contentType:'text/javascript',body:agent+`;const start=SnowglobeAgent.Job.prototype.start;SnowglobeAgent.Job.prototype.start=function(){return ${JSON.stringify("printf %s '"+source+"' >/root/app/src/App.jsx\n")}+start.call(this);};`}));
  await page.route(busybox,r=>phase==='poison'||++restoredBusyboxAttempts<=3?r.abort('failed'):r.continue());
  await page.route(warm,async r=>{if(phase==='poison')return r.abort('failed');if(++warmAttempts<=3){await r.abort('failed');if(warmAttempts===3)resolveWarmFailures();}else await r.abort('failed');});
  await page.goto(url);await page.waitForFunction(()=>window.testVmApi);await page.evaluate(()=>testVmApi.wake('web'));
  const failed=await page.evaluate(async()=>{const {jobId}=await testVmApi.runCommand({runtime:'web',command:'true'},{wrap:false});let job;do{await new Promise(r=>setTimeout(r,100));job=await testVmApi.readJob(jobId);}while(job.state==='running');return job;});
  assert.deepEqual(failed.uploadFailure,{step:0,status:126,message:'/bin/sh: mkdir: I/O error'});
  await page.evaluate(()=>testVmApi.suspend('web'));assert(await page.evaluate(()=>!!testVmApi._get('web').slot.saved));
  phase='restored';await page.unroute('**/builder/agent.js');await page.reload();await page.waitForFunction(()=>window.testVmApi);await page.evaluate(()=>testVmApi.wake('web'));await warmFailures;
  await page.getByRole('button',{name:'Rebuild preview'}).click();await page.waitForFunction(()=>!document.getElementById('stop').disabled);await finishTask(page);
  assert.equal(restoredBusyboxAttempts,4);assert.match(await page.locator('#progress-steps').textContent(),/Restoring environment files/);
  await page.frameLocator('#preview iframe').getByRole('heading',{name:'Checkpoint source preserved'}).waitFor();
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Export source'}).click();const download=await downloadPromise;
  const {unzipSync,strFromU8}=await import('fflate');const archive=unzipSync(await fs.readFile(await download.path()));assert.equal(strFromU8(archive['src/App.jsx']),source);
  console.log('PASS damaged saved VM repairs after page reload; edited source renders and exports unchanged');
  await context.close();
 }
}finally{await browser.close();}

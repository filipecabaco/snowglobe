// Exercise the built worker and its actual loader dependencies without VM images or accounts.
import {chromium} from '../../../bench/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import vm from 'node:vm';
const assets=new URL('../../../site/builder/',import.meta.url),origin='https://builder-worker.test',scripts=new Set();
class AssetURL extends URL{constructor(value,base){super(value,base);if(this.pathname.startsWith('/builder/')&&this.pathname.endsWith('.js')&&!this.pathname.endsWith('/machine-worker.js'))scripts.add(this.href);}}
const loader={URL:AssetURL};vm.createContext(loader);vm.runInContext(await fs.readFile(new URL('orchestrator.js',assets),'utf8'),loader);
loader.SnowglobeOrchestrator.createAgents({runtimes:[],armless:{js:'/external-armless.js'}},{pageUrl:origin+'/builder/',scheduler:{}});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext(),missing=[];
 await context.route(origin+'/**',async route=>{
  const path=new URL(route.request().url()).pathname,headers={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'};
  if(path==='/builder/')return route.fulfill({headers,contentType:'text/html',body:'<!doctype html><main>Built worker fixture</main>'});
  const name=path.slice('/builder/'.length);if(!path.startsWith('/builder/')||!/^[-a-z]+\.js$/.test(name)){missing.push(path);return route.fulfill({status:404,body:'Not found'});}
  try{return route.fulfill({headers,contentType:'text/javascript',body:await fs.readFile(new URL(name,assets),'utf8')});}catch{missing.push(path);return route.fulfill({status:404,body:'Not found'});}
 });
 const page=await context.newPage();await page.goto(origin+'/builder/');
 const result=await page.evaluate(scripts=>new Promise((resolve,reject)=>{
  const worker=new Worker('/builder/machine-worker.js'),timer=setTimeout(()=>{worker.terminate();reject(Error('Worker initialization timed out'));},15000);
  const done=(error,value)=>{clearTimeout(timer);worker.terminate();error?reject(error):resolve(value);};
  worker.onerror=event=>done(Error(event.message));worker.onmessage=event=>{if(event.data.id===1)event.data.error?done(Error(event.data.error.message)):done(null,event.data.result);};
  worker.postMessage({id:1,op:'init',args:[{scripts,config:{cpus:1},uploadWindow:1}]});
 }),[...scripts]);
 assert.equal(result,true);assert.deepEqual(missing,[]);console.log('PASS built Builder worker imports and initializes with the actual upstream loader dependencies');
}finally{await browser.close();}

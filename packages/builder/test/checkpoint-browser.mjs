// Real IndexedDB + a compressed Blob crossing a worker boundary, as VM captures do.
import {chromium,webkit} from '../../../bench/node_modules/playwright/index.mjs';import assert from 'node:assert/strict';
for(const [name,type,options] of [['Chromium',chromium,{args:['--no-sandbox']}],['WebKit',webkit,{executablePath:process.env.BUILDER_WEBKIT_BIN}]]){
 const browser=await type.launch({headless:true,...options});try{
  const page=await browser.newPage();await page.route('**/builder/app.js',r=>r.fulfill({contentType:'text/javascript',body:''}));await page.goto('https://aspire.tailb03e.ts.net:18445/builder/');
  const result=await page.evaluate(async()=>{
   const source=`onmessage=async()=>{const bytes=new Uint8Array(80*1024*1024);for(let i=0;i<bytes.length;i+=65536)crypto.getRandomValues(bytes.subarray(i,i+65536));const digest=await crypto.subtle.digest('SHA-256',bytes);const state=await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).blob();postMessage({state,digest});};`;
   const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'})),worker=new Worker(url);
   const {state,digest}=await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=reject;worker.postMessage(null);});worker.terminate();URL.revokeObjectURL(url);
   const S=SnowglobeSessions,store=await S.BrowserStore.open('builder-storage-regression-'+crypto.randomUUID());
   const checkpoint={version:1,id:'machine',name:'Blob regression',config:{build:'test',memory:640,cpus:1,network:'none'},savedAt:Date.now(),encoding:'gzip',state,console:new Blob([])};
   const nativePut=IDBObjectStore.prototype.put;let injected=false;IDBObjectStore.prototype.put=function(value){if(!injected&&value?.checkpoint?.state instanceof Blob){injected=true;throw new DOMException('Error preparing Blob/File data to be stored in object store','UnknownError');}return nativePut.apply(this,arguments);};try{await store.put(checkpoint);}finally{IDBObjectStore.prototype.put=nativePut;}const loaded=await store.get('machine');const bytes=await S.unpackState(loaded);const actual=await crypto.subtle.digest('SHA-256',bytes);
   const same=[...new Uint8Array(digest)].every((byte,i)=>byte===new Uint8Array(actual)[i]);
   const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(){throw new DOMException('Injected quota failure','QuotaExceededError');};let denied=false;
   try{await store.put({...checkpoint,name:'must not replace old save'});}catch(error){denied=error.name==='QuotaExceededError';}finally{IDBObjectStore.prototype.put=original;}
   const retained=await store.get('machine');store.db.close();return {injected,same,bytes:bytes.length,blob:loaded.state instanceof Blob,denied,retained:retained.name};
  });
  assert.deepEqual(result,{injected:true,same:true,bytes:80*1024*1024,blob:true,denied:true,retained:'Blob regression'});console.log('PASS',name,'80 MiB worker-compressed checkpoint roundtrip and atomic preservation after quota failure');
 }finally{await browser.close();}
}

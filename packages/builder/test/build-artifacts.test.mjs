import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import vm from 'node:vm';
const assets=new URL('../../../site/builder/',import.meta.url);
test('built Builder includes every local script requested by the actual worker loader',async()=>{
 const scripts=new Set();class AssetURL extends URL{constructor(value,base){super(value,base);if(this.pathname.startsWith('/builder/')&&this.pathname.endsWith('.js'))scripts.add(this.pathname.slice('/builder/'.length));}}
 const context={URL:AssetURL};vm.createContext(context);vm.runInContext(await fs.readFile(new URL('orchestrator.js',assets),'utf8'),context);
 context.SnowglobeOrchestrator.createAgents({runtimes:[],armless:{js:'/external-armless.js'}},{pageUrl:'https://builder.test/builder/',scheduler:{}});
 assert(scripts.size>0);for(const script of scripts)await fs.access(new URL(script,assets));
});
test('the built worker core denies external requests while allowing bounded npm metadata reads',async()=>{
 const requests=[];const context={URL,Headers,Response,AbortController,setTimeout,clearTimeout,fetch:async(url,options)=>{requests.push({url,options});return new Response('{}',{headers:{'content-type':'application/json'}});}};
 vm.createContext(context);vm.runInContext(await fs.readFile(new URL('machine-core.js',assets),'utf8'),context);const fetchGuest=context.SnowglobeMachineCore.guestFetch;
 await assert.rejects(async()=>fetchGuest('https://outside.example/private'),/only npm registry/);assert.equal(requests.length,0);
 assert.equal((await fetchGuest('https://registry.npmjs.org/react')).status,200);assert.equal(requests.length,1);assert.equal(requests[0].options.credentials,'omit');assert.equal(requests[0].options.redirect,'error');
});

// Actual Builder + Pi proxy + gateway + encrypted vault, with fixture provider inference.
// No external credentials or VM boot. Browser and gateway are both restarted below.
import {chromium,webkit} from '../../../bench/node_modules/playwright/index.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createGateway} from '../gateway.mjs';
import {fixtureProviders,fixtureUsage} from './provider-fixture.mjs';
import {runtimeCatalog} from './runtime-catalog-fixture.mjs';
const root=path.resolve(new URL('../../../',import.meta.url).pathname),temporary=await fs.mkdtemp(path.join(os.tmpdir(),'builder-providers-browser-')),requests=[];
let gateway,context;
const server=http.createServer(async(req,res)=>{
 if(req.url.startsWith('/builder-api/')){req.url=req.url.slice('/builder-api'.length);gateway.emit('request',req,res);return;}
 const pathname=new URL(req.url,'http://test.local').pathname;
 if(pathname==='/agent/runtimes.json'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(runtimeCatalog));}
 if(pathname.includes('..')||!/^\/(?:builder|agent|conduit|duckdb|web|supabase|blobs)\//.test(pathname)){res.writeHead(404);return res.end();}
 const name=pathname.endsWith('/')?pathname+'index.html':pathname;
 try{
  let bytes=await fs.readFile(path.join(root,'site',name));
  if(name==='/builder/app.js')bytes=Buffer.from(bytes.toString()+"\nwindow.testProviderPrompt=async()=>{await agent.prompt('Say hello');return agent.state.messages;};");
  const type={'.js':'text/javascript','.json':'application/json','.html':'text/html','.css':'text/css','.wasm':'application/wasm','.txt':'text/plain'}[path.extname(name)]||'application/octet-stream';
  res.writeHead(200,{'Content-Type':type,'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cache-Control':'no-store'});return res.end(bytes);
 }catch(error){if(!['ENOENT','EISDIR'].includes(error.code))throw error;}
 res.writeHead(404);res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const makeGateway=()=>createGateway({origin,credentialDirectory:path.join(temporary,'vault'),providerFactory:fixtureProviders,stream:async function*(model,context,options){requests.push({model,context,options});yield {type:'start',partial:{}};yield {type:'text_start',contentIndex:0,partial:{}};yield {type:'text_delta',contentIndex:0,delta:'Hello from '+model.provider,partial:{}};yield {type:'text_end',contentIndex:0,partial:{content:[{type:'text',text:'Hello'}]}};yield {type:'done',reason:'stop',message:{usage:fixtureUsage}};}});
gateway=makeGateway();
const engine=process.env.BUILDER_BROWSER==='webkit'?webkit:chromium;
const launch=()=>engine.launchPersistentContext(path.join(temporary,'browser'),{headless:true,...(engine===chromium?{args:['--no-sandbox']}:{...(process.env.BUILDER_WEBKIT_BIN?{executablePath:process.env.BUILDER_WEBKIT_BIN}:{})})});
try{
 context=await launch();let page=context.pages()[0]||await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const ready=async()=>{await page.goto(origin+'/builder/');await page.waitForFunction(()=>document.getElementById('status').textContent!=='Loading Builder…'&&document.getElementById('provider').options.length===2);await page.locator('#settings').evaluate(el=>el.open=true);};
 await ready();
 const add=async(provider,type,value)=>{await page.locator('#provider').selectOption(provider);await page.locator('#provider-method').selectOption(type);await page.locator('#connect').click();await page.locator('#provider-response').waitFor({state:'visible'});await page.locator('#key').fill(value);await page.locator('#provider-answer').click();await page.waitForFunction(()=>document.getElementById('provider-login-status').textContent==='Connection saved.'&&document.getElementById('stop').disabled);};
 await add('first','api_key','first-browser-secret-key');
 await add('second','oauth','approved');assert.equal(await page.locator('#provider-connections > div').count(),2);
 assert.equal(await page.locator('#provider-login-events a').getAttribute('href'),'https://provider.invalid/authorize');
 // A second authentication method for an already connected provider must coexist.
 await add('first','oauth','approved');assert.equal(await page.locator('#provider-connections > div').count(),3);
 const select=(connection,id)=>JSON.stringify([connection,id]);
 await page.locator('#model').selectOption(select('first:api_key','simple'));await page.waitForFunction(()=>document.getElementById('stop').disabled);assert.equal(await page.locator('#thinking').isDisabled(),true);assert.equal(await page.locator('#thinking option').count(),1);
 await page.locator('#model').selectOption(select('second:oauth','test-model'));await page.waitForFunction(()=>document.getElementById('stop').disabled);await page.locator('#thinking').selectOption('high');await page.waitForFunction(()=>document.getElementById('stop').disabled);
 await page.evaluate(()=>testProviderPrompt());assert.equal(requests.at(-1).model.provider,'second');assert.equal(requests.at(-1).options.reasoning,'high');assert.equal(requests.at(-1).options.apiKey,'oauth-secret-refreshed');
 await page.locator('#model').selectOption(select('first:api_key','test-model'));await page.waitForFunction(()=>document.getElementById('stop').disabled);await page.evaluate(()=>testProviderPrompt());assert.equal(requests.at(-1).model.provider,'first');assert.equal(requests.at(-1).options.apiKey,'first-browser-secret-key');assert(JSON.stringify(requests.at(-1).context).includes('Hello from second'));
 await page.locator('#thinking').selectOption('medium');await page.waitForFunction(()=>document.getElementById('stop').disabled);
 const storage=await context.storageState({indexedDB:true});assert(!JSON.stringify(storage.origins).includes('first-browser-secret-key'));assert(!JSON.stringify(storage.origins).includes('oauth-secret'));assert.equal(await page.evaluate(()=>document.cookie),'');
 assert.deepEqual(errors,[]);await context.close();context=null;await gateway.dispose();gateway=makeGateway();context=await launch();page=context.pages()[0]||await context.newPage();page.on('pageerror',e=>errors.push(e.message));await ready();
 assert.equal(await page.locator('#provider-connections > div').count(),3);assert.equal(await page.locator('#model').inputValue(),select('first:api_key','test-model'));assert.equal(await page.locator('#thinking').inputValue(),'medium');await page.evaluate(()=>testProviderPrompt());assert.equal(requests.at(-1).options.apiKey,'first-browser-secret-key');
 const row=page.locator('#provider-connections > div').filter({hasText:'first · API key'});await row.getByRole('button',{name:'Forget connection'}).click();await page.waitForFunction(()=>document.getElementById('provider-connections').children.length===2);assert.equal(await page.locator('#ai-indicator').textContent(),'AI not connected');
 assert.deepEqual(errors,[]);console.log('PASS '+(engine===webkit?'WebKit':'Chromium')+' multiple API/OAuth connections, thinking capability validation, live Pi proxy routing, portable conversation handoff, encrypted persistence across browser/gateway restart, and scoped forgetting');
}finally{await context?.close();await gateway.dispose();await new Promise(r=>server.close(r));await fs.rm(temporary,{recursive:true,force:true});}

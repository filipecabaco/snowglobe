// Development-only acceptance service. Serves public device codes, never session cookies,
// browser-control endpoints, account details, source, or Codex credentials.
import http from 'node:http';
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {safeError} from '../errors.mjs';
export class BrowserTest {
 constructor({builderUrl='https://aspire.tailb03e.ts.net:18445/builder/'}={}){this.builderUrl=builderUrl;this.generation=0;this.state={phase:'idle',message:'Ready. Request a code when you are ready to sign in.',checks:[]};}
 set(phase,message,extra={}){this.state={phase,message,checks:this.state.checks,...extra};console.log('BUILDER_LIVE_TEST',phase,message);}
 async dispose(){
  const owned=this.owned;if(!owned)return;
  if(owned.page){
   const disconnected=await owned.page.evaluate(async()=>{const r=await fetch('/builder-api/disconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return r.ok||r.status===401;}).catch(()=>false);
   if(!disconnected)throw new Error('The dev server did not confirm sign-out. Reconnect it and select Cancel again.');
  }
  if(this.owned===owned)this.owned=null;
  await owned.browser?.close().catch(()=>{});await owned.server?.close().catch(()=>{});
  if(!this.owned)await fs.rm('.local-dev/builder-live-control.json',{force:true});
 }
 async start(){
  if(['starting','building','checking','disconnecting'].includes(this.state.phase))throw new Error('The test is already running. Cancel it before starting another.');
  const generation=++this.generation;this.set('starting','Requesting a fresh sign-in code…',{checks:[]});
  try{
   await this.dispose();
   const {chromium}=await import('../../../bench/node_modules/playwright/index.mjs');
   const server=await chromium.launchServer({headless:true,args:['--no-sandbox']});
   if(generation!==this.generation){await server.close();return;}
   const owned=this.owned={server};owned.browser=await chromium.connect(server.wsEndpoint());
   owned.page=await owned.browser.newPage();const page=owned.page;page.setDefaultTimeout(30000);
   await fs.writeFile('.local-dev/builder-live-control.json',JSON.stringify({endpoint:server.wsEndpoint()}),{mode:0o600});
   await page.goto(this.builderUrl);await page.waitForFunction(()=>document.getElementById('status').textContent!=='Loading Builder…');
   await page.locator('#settings').evaluate(el=>el.open=true);await page.getByRole('button',{name:'Continue with ChatGPT'}).click();
   await page.locator('#codex-code').filter({hasText:/\S/}).waitFor();
   if(generation!==this.generation)return;
   const code=await page.locator('#codex-code').textContent(),verificationUrl=await page.locator('#codex-link').getAttribute('href');
   if(new URL(verificationUrl).origin!=='https://auth.openai.com')throw new Error('Unexpected OpenAI sign-in address');
   this.set('awaiting','Waiting for OpenAI sign-in. Complete it using the code above.',{code,verificationUrl,issuedAt:Date.now()});
   this.watch(generation,page).catch(error=>{if(generation===this.generation)this.set('failed',safeError(error));});
  }catch(error){if(generation===this.generation){this.set('failed',safeError(error));await this.dispose().catch(()=>{});}throw error;}
 }
 async watch(generation,page){
  // No harness deadline silently invalidates the displayed code. OpenAI/gateway failures
  // clear it, and a new code is requested only by the person at the page.
  while(generation===this.generation){
   let info;
   try{info=await page.evaluate(async()=>{const r=await fetch('/builder-api/codex/status',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!r.ok)throw new Error('The sign-in session ended. Request a fresh code.');const j=await r.json();return {connected:j.connected,failed:j.login?.status==='failed'};});}
   catch(error){if(generation===this.generation){this.set('expired',safeError(error));await this.dispose();}return;}
   if(generation!==this.generation)return;
   if(info.connected){await this.run(generation,page);return;}
   if(info.failed){this.set('expired','Sign-in ended or expired. Request a fresh code when you are ready.');await this.dispose();return;}
   await new Promise(r=>setTimeout(r,3000));
  }
 }
 async run(generation,page){
  const checks=[];let timer;
  try{
   this.set('building','Connected. Starting the voting-app build…',{checks});
   await page.getByRole('button',{name:'Check connection'}).click();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Codex connected'));
   await page.locator('#settings').evaluate(el=>el.open=false);
   await page.locator('#prompt').fill('Implement a small local voting prototype now. Use a visible heading exactly "Builder acceptance poll" and two buttons with visible text exactly "Yes" and "No". Display vote totals starting at 0 and persist them in localStorage. After clicking Yes once show the exact visible text "Yes votes: 1". Keep everything local with no backend, external services or packages. Read the project, write the component and call the preview build tool.');
   await page.getByRole('button',{name:'Build my app'}).click({timeout:5000});await page.waitForFunction(()=>!document.getElementById('stop').disabled);
   timer=setInterval(async()=>{if(generation!==this.generation)return;try{this.set('building',await page.locator('#status').textContent(),{checks});}catch{}},5000);
   await page.waitForFunction(()=>document.getElementById('stop').disabled,null,{timeout:720000});clearInterval(timer);
   if(generation!==this.generation)return;
   if(await page.locator('#work-progress').evaluate(el=>el.classList.contains('failed')))throw new Error(await page.locator('#status').textContent());
   checks.push('Live Codex generated source and compiled a working preview.');this.set('checking','Checking the voting app…',{checks});
   const frame=page.frameLocator('#preview iframe');await frame.getByRole('heading',{name:'Builder acceptance poll',exact:true}).waitFor();await frame.getByRole('button',{name:'Yes',exact:true}).click();await frame.getByText('Yes votes: 1',{exact:true}).waitFor();checks.push('A real click updates the vote total.');
   await page.getByRole('button',{name:'Rebuild preview'}).click();await page.waitForFunction(()=>!document.getElementById('stop').disabled);await page.waitForFunction(()=>document.getElementById('stop').disabled,null,{timeout:360000});
   await page.frameLocator('#preview iframe').getByText('Yes votes: 1',{exact:true}).waitFor();checks.push('The vote survives a preview rebuild.');
   if(generation!==this.generation)return;
   this.set('disconnecting','Checks passed. Disconnecting the test session…',{checks});await this.dispose();this.set('passed','Live build and interaction tests passed. Test session disconnected.',{checks});
  }catch(error){if(generation===this.generation)this.set('failed',safeError(error)+'. Test browser retained for debugging; Cancel disconnects it.',{checks});}
  finally{clearInterval(timer);}
 }
 async cancel(){++this.generation;this.set('disconnecting','Disconnecting the test session…');try{await this.dispose();this.set('cancelled','Test cancelled and disconnected. Request a fresh code to try again.');}catch(error){this.set('failed',safeError(error));throw error;}}
}
export function createLiveTestServer({test=new BrowserTest(),origin='https://aspire.tailb03e.ts.net:18445'}={}){
 const publicState=()=>{const {phase,message,code,verificationUrl,issuedAt,checks}=test.state;return {phase,message,code:phase==='awaiting'?code:undefined,verificationUrl:phase==='awaiting'?verificationUrl:undefined,issuedAt,checks};};
 const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname.replace(/^\/builder-test(?=\/|$)/,'')||'/';
  const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  if(req.method==='GET'&&pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(await fs.readFile(new URL('./live-test.html',import.meta.url)));}
  if(req.method==='GET'&&pathname==='/api/status')return json(200,publicState());
  if(req.method==='POST'&&['/api/start','/api/cancel'].includes(pathname)){
   req.resume();
   if(req.headers.origin!==origin)return json(403,{error:'Origin refused'});
   try{if(pathname==='/api/start')await test.start();else await test.cancel();return json(200,publicState());}catch(error){return json(409,{error:safeError(error)});}
  }
  json(404,{error:'Not found'});
 });server.dispose=()=>test.cancel();return server;
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 const server=createLiveTestServer();server.listen(18448,'127.0.0.1',()=>console.log('Builder live test ready on loopback 18448; no code issued until requested.'));
 const close=async()=>{await server.dispose().catch(error=>console.error(safeError(error)));server.close(()=>process.exit(0));};process.once('SIGTERM',close);process.once('SIGINT',close);
}

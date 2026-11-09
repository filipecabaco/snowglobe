// Form events must reach app handlers, while CSP still blocks native exfiltration.
import {chromium,webkit} from '../../../bench/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import {openFixture} from './browser-fixture.mjs';
for(const [name,type,options] of [['Chromium',chromium,{args:['--no-sandbox']}],['WebKit',webkit,process.env.BUILDER_WEBKIT_BIN?{executablePath:process.env.BUILDER_WEBKIT_BIN}:{}]]){
 const browser=await type.launch({headless:true,...options});try{
  const page=await browser.newPage();page.setDefaultTimeout(5000);await openFixture(page);let leaked=0;
  await page.route('**/_profile-leak',route=>{leaked++;return route.fulfill({body:'should never be requested'});});
  const source=await fs.readFile(new URL('../src/preview.js',import.meta.url),'utf8');
  await page.evaluate(async source=>{
   const {mountPreview}=await import(URL.createObjectURL(new Blob([source],{type:'text/javascript'}))),container=document.createElement('div');container.id='preview';document.body.append(container);window.formRequests=[];window.formErrors=[];localStorage.setItem('form-host-secret','private');
   await mountPreview({container,backend:{url:'https://supabase.builder.invalid',anonKey:'fixture-public'},onBackendRequest:async request=>{formRequests.push(request);return {status:200,headers:[['content-type','application/json']],body:new TextEncoder().encode('{"saved":true}')};},onRuntimeError:error=>formErrors.push(error.message),html:`<main><form id="profile"><label>Display name<input name="display_name"></label><button type="submit">Save profile</button></form><p id="result"></p><form id="native" method="post" action="https://builder.test/_profile-leak"><input name="secret" value="private-canary"></form></main><script>document.getElementById('profile').onsubmit=async event=>{event.preventDefault();const display_name=new FormData(event.target).get('display_name');await fetch(SNOWGLOBE_SUPABASE.url+'/rest/v1/profiles',{method:'POST',headers:{apikey:SNOWGLOBE_SUPABASE.anonKey,'Content-Type':'application/json'},body:JSON.stringify({display_name})});document.getElementById('result').textContent='Profile saved';};<\/script>`});
  },source);
  const frame=page.frameLocator('#preview iframe');await frame.getByLabel('Display name').fill('Updated profile');await frame.getByRole('button',{name:'Save profile'}).click();await frame.getByText('Profile saved',{exact:true}).waitFor();
  const requests=await page.evaluate(()=>formRequests);assert.equal(requests.length,1);assert.deepEqual(JSON.parse(requests[0].body),{display_name:'Updated profile'});
  const child=page.frames().find(f=>f!==page.mainFrame());const isolation=await child.evaluate(()=>{let parentDenied=false;try{void parent.document;}catch{parentDenied=true;}return {parentDenied,hostSecret:localStorage.getItem('form-host-secret'),popupDenied:window.open('https://builder.test/_profile-leak')===null};});assert.deepEqual(isolation,{parentDenied:true,hostSecret:null,popupDenied:true});
  const url=child.url();await child.evaluate(()=>document.getElementById('native').requestSubmit());await page.waitForFunction(()=>formErrors.some(message=>message.includes('form-action')));assert.equal(child.url(),url);assert.equal(leaked,0);
  console.log('PASS',name,'form submit handler and async backend bridge, with native form network/navigation and popup/host access denied');
 }finally{await browser.close();}
}

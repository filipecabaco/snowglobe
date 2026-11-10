// Clipboard checks use fixture codes and never create or cancel a real login.
import {chromium,webkit,devices} from '../../../bench/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
const code='COPY-12345';
for(const [name,type,options] of [['Chromium',chromium,{args:['--no-sandbox']}],['WebKit',webkit,{...(process.env.BUILDER_WEBKIT_BIN?{executablePath:process.env.BUILDER_WEBKIT_BIN}:{})}]]){
 const browser=await type.launch({headless:true,...options});
 try{
  for(const surface of ['test','builder']){
   const context=await browser.newContext({...devices['iPhone 13']});const page=await context.newPage();if(name==='Chromium')await context.grantPermissions(['clipboard-read','clipboard-write']);
   await page.route('**/builder-test/api/status',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({phase:'awaiting',message:'Waiting for fixture approval',code,verificationUrl:'https://auth.openai.com/codex/device',checks:[]})}));
   await page.route('**/builder-api/status',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({development:true,codexSession:false})}));
   await page.route('**/builder-api/codex/connect',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({connected:false,userCode:code,verificationUrl:'https://auth.openai.com/codex/device'})}));
   await page.goto('https://aspire.tailb03e.ts.net:18445/'+(surface==='test'?'builder-test/':'builder/'));
   if(surface==='builder'){await page.waitForFunction(()=>document.getElementById('status').textContent!=='Loading Builder…');await page.getByText('AI settings',{exact:true}).click();await page.locator('#provider').selectOption('openai');await page.locator('#provider-method').selectOption('codex');await page.locator('#connect').click();await page.getByText(code,{exact:true}).waitFor();}
   const button=page.getByRole('button',{name:'Copy code',exact:true}),feedback=page.locator(surface==='test'?'#copy-status':'#codex-copy-status'),field=page.locator(surface==='test'?'#code':'#codex-copy-field');
   await button.waitFor();await page.bringToFront();
   await page.evaluate(()=>{const original=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=text=>{window.copyText=text;window.copyGesture=navigator.userActivation?.isActive;return original(text).then(()=>{window.nativeCopySucceeded=true;},error=>{window.nativeCopyError=error.name+': '+error.message;throw error;});};});
   await button.tap();await feedback.filter({hasText:'Code copied.'}).waitFor();assert.equal(await page.evaluate(()=>window.copyText),code);console.log('NATIVE',name,surface,await page.evaluate(()=>({copied:window.nativeCopySucceeded,error:window.nativeCopyError,gesture:window.copyGesture,focus:document.hasFocus()})));assert.equal(await page.evaluate(()=>window.nativeCopySucceeded),true,'trusted tap must perform the actual native clipboard write');
   await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new DOMException('Denied','NotAllowedError');}}});document.execCommand=command=>{window.legacyCopy=command;return true;};});
   await button.tap();await page.waitForFunction(()=>window.legacyCopy==='copy');await feedback.filter({hasText:'Code copied.'}).waitFor();
   await page.evaluate(()=>{document.execCommand=()=>false;});await button.tap();await feedback.filter({hasText:'Copy was blocked.'}).waitFor();assert.equal(await field.inputValue(),code);assert(await field.isVisible());assert.equal(await field.evaluate(el=>el.readOnly),true);
   if(surface==='test'){
    const n=await page.evaluate(()=>{window.copyRenders=0;const original=render;window.render=(...args)=>{window.copyRenders++;return original(...args);};const input=document.getElementById('code');input.setSelectionRange(2,6);return window.copyRenders;});
    await page.waitForFunction(n=>window.copyRenders>n,n);assert.deepEqual(await field.evaluate(el=>[el.selectionStart,el.selectionEnd]),[2,6],'status polling must preserve iPhone text selection');
   }
   console.log('PASS',name,surface,'iPhone touch: real native copy, legacy fallback, manual selection'+(surface==='test'?' and selection surviving polling':''));
   await context.close();
  }
 }finally{await browser.close();}
}

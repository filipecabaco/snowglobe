// Login UI regression only: no model requests, real credentials, or VM startup.
import {chromium} from '../../../bench/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 let authorized=false;const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/builder-api/status',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({development:true,codexSession:authorized})}));
 await page.route('**/builder-api/disconnect',r=>{authorized=false;return r.fulfill({contentType:'application/json',body:'{"ok":true}'});});
 await page.route('**/builder-api/codex/connect',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({connected:false,verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-CODE'})}));
 await page.route('**/builder-api/codex/status',r=>{authorized=true;return r.fulfill({contentType:'application/json',body:JSON.stringify({connected:true,engine:'codex',account:{email:'test@example.invalid',planType:'plus'},models:[{id:'test-model',name:'Test model',isDefault:true}]})});});
 await page.goto(process.env.BUILDER_URL||'https://aspire.tailb03e.ts.net:18445/builder/');
 await page.waitForFunction(()=>document.getElementById('status').textContent!=='Loading Builder…');
 await page.getByText('AI settings',{exact:true}).click();await page.locator('#provider').selectOption('openai');await page.locator('#provider-method').selectOption('codex');await page.locator('#connect').click();
 await page.getByText('TEST-CODE',{exact:true}).waitFor();assert.equal(await page.locator('#codex-link').getAttribute('href'),'https://auth.openai.com/codex/device');
 await page.getByRole('button',{name:'Check connection'}).click();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Codex connected'));
 assert.equal(await page.locator('#settings').evaluate(el=>el.open),false);
 assert.equal(await page.locator('#model').inputValue(),JSON.stringify(['codex','test-model']));
 assert.equal(await page.locator('#codex-settings').count(),0);
 assert.equal(await page.getByText('Use your ChatGPT plan with Codex',{exact:true}).count(),0);
 assert.equal(await page.locator('[data-connection-id=codex]').count(),1);
 await page.locator('#prompt').fill('Build a local poll');
 await page.getByRole('button',{name:'Build my app'}).click({trial:true,timeout:3000});
 await page.reload();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Codex connected'));
 await page.locator('#settings').evaluate(el=>el.open=true);await page.locator('[data-connection-id=codex]').getByRole('button',{name:'Forget connection'}).click();
 await page.waitForFunction(()=>document.getElementById('ai-indicator').textContent==='AI not connected');assert.equal(await page.locator('[data-connection-id=codex]').count(),0);
 assert.deepEqual(errors,[]);console.log('PASS unified provider sign-in, saved Codex restore/model selection, no standalone section, and scoped Forget');
}finally{await browser.close();}
